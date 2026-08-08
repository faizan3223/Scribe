/**
 * Scribe Worker upgrades — paste into your Cloudflare Worker
 * Bindings needed in wrangler.toml / dashboard:
 *   - GROQ_API_KEY (secret)
 *   - STRIPE_SECRET_KEY (secret)
 *   - AI (Workers AI binding) for images + optional vision
 *   - CHATS_KV (KV namespace) for cloud chats + share links
 *   - Optional: BRAVE_API_KEY or SERPER_API_KEY for web search
 */

import Groq from 'groq-sdk';
import Stripe from 'stripe';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    const groq = new Groq({ apiKey: env.GROQ_API_KEY });
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    try {
      // ---------- AUTH (keep your existing signup/signin) ----------
      if (request.method === 'POST' && url.pathname === '/api/signup') {
        await request.json();
        return json({ success: true, message: 'Account created successfully!' });
      }
      if (request.method === 'POST' && url.pathname === '/api/signin') {
        await request.json();
        return json({ success: true, token: 'mock-session-token' });
      }

      // ---------- STEP 1: ASK + VISION + WEB SEARCH ----------
      if (request.method === 'POST' && url.pathname === '/api/ask-question') {
        const body = await request.json();
        let { question, images, image, hasImage, webSearch, mode } = body;
        if (!question) return json({ success: false, error: 'Question text is required' }, 400);

        // Web search (optional) — Serper or Brave
        if (webSearch && (env.SERPER_API_KEY || env.BRAVE_API_KEY)) {
          try {
            let snippets = '';
            if (env.SERPER_API_KEY) {
              const sr = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: {
                  'X-API-KEY': env.SERPER_API_KEY,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ q: question.slice(0, 200), num: 5 }),
              });
              const sd = await sr.json();
              const organic = sd.organic || [];
              snippets = organic
                .slice(0, 5)
                .map((o, i) => `[${i + 1}] ${o.title}\n${o.snippet}\n${o.link}`)
                .join('\n\n');
            } else if (env.BRAVE_API_KEY) {
              const sr = await fetch(
                'https://api.search.brave.com/res/v1/web/search?q=' +
                  encodeURIComponent(question.slice(0, 200)),
                { headers: { 'X-Subscription-Token': env.BRAVE_API_KEY } }
              );
              const sd = await sr.json();
              const results = (sd.web && sd.web.results) || [];
              snippets = results
                .slice(0, 5)
                .map((o, i) => `[${i + 1}] ${o.title}\n${o.description}\n${o.url}`)
                .join('\n\n');
            }
            if (snippets) {
              question =
                question +
                '\n\n---\nLive web search results (use if relevant, cite links):\n' +
                snippets;
            }
          } catch (e) {
            console.error('web search failed', e);
          }
        }

        // Vision: build multimodal content if image present
        // Groq llama-3.2-90b-vision or similar vision model
        const imgData = image || (images && images[0] && images[0].data);
        let messages;

        if ((hasImage || imgData) && imgData && typeof imgData === 'string') {
          // Use vision-capable model
          messages = [
            {
              role: 'user',
              content: [
                { type: 'text', text: question },
                {
                  type: 'image_url',
                  image_url: {
                    url: imgData.startsWith('data:')
                      ? imgData
                      : 'data:image/jpeg;base64,' + imgData,
                  },
                },
              ],
            },
          ];

          const stream = await groq.chat.completions.create({
            messages,
            model: env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
            stream: true,
            // fallback: if vision model fails, client will retry
          });

          return streamResponse(stream, ctx, corsHeaders);
        }

        // Text-only
        messages = [{ role: 'user', content: question }];
        const stream = await groq.chat.completions.create({
          messages,
          model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
          stream: true,
        });
        return streamResponse(stream, ctx, corsHeaders);
      }

      // ---------- IMAGE GEN (existing) ----------
      if (request.method === 'POST' && url.pathname === '/api/generate-image') {
        const body = await request.json();
        const { prompt } = body;
        if (!prompt) return json({ success: false, error: 'Prompt text is required' }, 400);
        const aiResponse = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt });
        return json({ success: true, image: aiResponse.image });
      }

      // ---------- STRIPE (tier-aware $20 / $100) ----------
      if (request.method === 'POST' && url.pathname === '/api/create-checkout-session') {
        const body = await request.json().catch(() => ({}));
        const tier = (body.tier || body.plan || 'pro').toLowerCase();
        let unitAmount = Number(body.unit_amount || body.unitAmount);
        if (!unitAmount || unitAmount < 100) {
          unitAmount = tier === 'ultra' ? 10000 : 2000;
        }
        if (tier === 'ultra') unitAmount = 10000;
        if (tier === 'pro') unitAmount = 2000;

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: tier === 'ultra' ? 'Scribe Ultra' : 'ScribeAI Pro Plan',
                  description:
                    tier === 'ultra'
                      ? 'Unlimited chats, unlimited images, fastest responses'
                      : 'Unlimited AI generations & Priority Processing',
                },
                unit_amount: unitAmount,
                recurring: { interval: 'month' },
              },
              quantity: 1,
            },
          ],
          mode: 'subscription',
          success_url:
            'https://scribe-5mr.pages.dev?checkout=success&plan=' +
            encodeURIComponent(tier) +
            '&session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'https://scribe-5mr.pages.dev?checkout=cancel',
          metadata: { tier, unit_amount: String(unitAmount) },
        });

        return json({
          success: true,
          url: session.url,
          tier,
          amount: unitAmount / 100,
          unit_amount: unitAmount,
        });
      }

      // ---------- STEP 2: CLOUD CHAT SYNC (KV) ----------
      // wrangler: [[kv_namespaces]] binding = "CHATS_KV"
      if (request.method === 'POST' && url.pathname === '/api/sync-chats') {
        const body = await request.json();
        const email = (body.email || '').toLowerCase().trim();
        if (!email || !env.CHATS_KV) {
          return json({ success: false, error: 'email or KV missing' }, 400);
        }
        const key = 'chats:' + email;
        if (body.action === 'pull') {
          const raw = await env.CHATS_KV.get(key);
          const chats = raw ? JSON.parse(raw) : [];
          return json({ success: true, chats });
        }
        // push
        const chats = Array.isArray(body.chats) ? body.chats.slice(0, 100) : [];
        await env.CHATS_KV.put(key, JSON.stringify(chats));
        return json({ success: true, count: chats.length });
      }

      // ---------- STEP 3: SHARE CHAT ----------
      if (url.pathname === '/api/share-chat') {
        if (request.method === 'POST') {
          const body = await request.json();
          if (!env.CHATS_KV) return json({ success: false, error: 'KV missing' }, 500);
          const id = crypto.randomUUID().slice(0, 10);
          await env.CHATS_KV.put(
            'share:' + id,
            JSON.stringify({
              title: body.title || 'Shared chat',
              messages: body.messages || [],
              at: Date.now(),
            }),
            { expirationTtl: 60 * 60 * 24 * 30 } // 30 days
          );
          return json({ success: true, id });
        }
        if (request.method === 'GET') {
          const id = url.searchParams.get('id');
          if (!id || !env.CHATS_KV) return json({ success: false }, 400);
          const raw = await env.CHATS_KV.get('share:' + id);
          if (!raw) return json({ success: false, error: 'not found' }, 404);
          return json({ success: true, chat: JSON.parse(raw) });
        }
      }

      return json({ success: false, message: 'Route Not Found' }, 404);
    } catch (error) {
      return json({ success: false, error: error.message }, 500);
    }
  },
};

function streamResponse(stream, ctx, corsHeaders) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  ctx.waitUntil(
    (async () => {
      try {
        for await (const chunk of stream) {
          const content = chunk.choices?.[0]?.delta?.content || '';
          if (content) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ text: content })}\n\n`));
          }
        }
      } catch (e) {
        console.error('Stream error:', e);
      } finally {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      }
    })()
  );
  return new Response(readable, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
'''

/**
 * Scribe Worker — Gemini (primary) + Groq (fallback) + vision
 * Deploy: scribe-backend.mworkspace123.workers.dev
 *
 * Secrets (add in Cloudflare Worker → Settings → Variables):
 *   GEMINI_API_KEY     ← recommended (Google AI Studio)
 *   GROQ_API_KEY       ← optional fallback
 *   STRIPE_SECRET_KEY  ← optional payments
 *
 * Optional: GEMINI_MODEL, GROQ_MODEL, SERPER_API_KEY
 *
 * Gemini key: https://aistudio.google.com/apikey
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

    const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

    try {
      if (request.method === 'POST' && url.pathname === '/api/signup') {
        await request.json();
        return json({ success: true, message: 'Account created successfully!' });
      }
      if (request.method === 'POST' && url.pathname === '/api/signin') {
        await request.json();
        return json({ success: true, token: 'mock-session-token' });
      }

      // ---------- AI CHAT (Gemini first, Groq fallback) ----------
      if (request.method === 'POST' && url.pathname === '/api/ask-question') {
        const body = await request.json();
        let { question, images, image, hasImage, webSearch, vision } = body;
        if (!question) return json({ success: false, error: 'Question text is required' }, 400);

        let imgData =
          (typeof image === 'string' && image) ||
          (images && images[0] && (images[0].data || images[0].url || images[0].dataUrl)) ||
          null;
        if (imgData && typeof imgData === 'object') imgData = imgData.data || imgData.url || null;
        const wantVision = !!(hasImage || vision || imgData);

        // Optional web search
        if (webSearch && env.SERPER_API_KEY) {
          try {
            const sr = await fetch('https://google.serper.dev/search', {
              method: 'POST',
              headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({ q: String(question).slice(0, 200), num: 5 }),
            });
            const sd = await sr.json();
            const snippets = (sd.organic || [])
              .slice(0, 5)
              .map((o, i) => `[${i + 1}] ${o.title}\n${o.snippet}\n${o.link}`)
              .join('\n\n');
            if (snippets) question += '\n\n---\nLive web search results:\n' + snippets;
          } catch (e) {
            console.error('web search failed', e);
          }
        }

        const hasGemini = !!(env.GEMINI_API_KEY && String(env.GEMINI_API_KEY).trim());
        const hasGroq = !!(env.GROQ_API_KEY && String(env.GROQ_API_KEY).trim());

        if (!hasGemini && !hasGroq) {
          return json({
            success: false,
            error:
              'No AI key on Worker. Add Secret GEMINI_API_KEY (https://aistudio.google.com/apikey) or GROQ_API_KEY in Cloudflare → Workers → Settings → Variables.',
          }, 500);
        }

                // ===== GEMINI PATH =====
        if (hasGemini) {
          let geminiLastErr = '';
          try {
            const parts = [{ text: String(question).slice(0, 30000) }];

            if (wantVision && imgData && typeof imgData === 'string' && imgData.length > 100) {
              let mime = 'image/jpeg';
              let b64 = imgData;
              const m = String(imgData).match(/^data:([^;]+);base64,(.+)$/);
              if (m) {
                mime = m[1] || mime;
                b64 = m[2];
              } else if (!imgData.startsWith('data:')) {
                b64 = imgData;
              }
              if (b64.length > 4_000_000) {
                return json({ success: false, error: 'Image too large for vision. Use a smaller screenshot.' }, 400);
              }
              parts.push({ inline_data: { mime_type: mime, data: b64 } });
            }

            const systemText = wantVision
              ? 'You can see the attached image. Describe only what is visible. Answer the user. Do not claim you cannot see images. Do not invent UI. No code unless asked.'
              : 'You are Scribe AI, a helpful assistant. Answer clearly. Match the user language.';

            const gemBody = {
              system_instruction: { parts: [{ text: systemText }] },
              contents: [{ role: 'user', parts }],
              generationConfig: { temperature: 0.4 },
            };

            const gemModels = [
              env.GEMINI_MODEL,
              'gemini-2.0-flash',
              'gemini-2.0-flash-lite',
              'gemini-1.5-flash',
              'gemini-1.5-flash-latest',
              'gemini-1.5-pro',
            ].filter(Boolean);

            for (const model of gemModels) {
              try {
                const endpoint =
                  'https://generativelanguage.googleapis.com/v1beta/models/' +
                  encodeURIComponent(model) +
                  ':generateContent?key=' +
                  encodeURIComponent(String(env.GEMINI_API_KEY).trim());

                const gr = await fetch(endpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(gemBody),
                });
                const raw = await gr.text();
                if (!gr.ok) {
                  geminiLastErr = model + ' → ' + gr.status + ' ' + raw.slice(0, 250);
                  console.error('Gemini error', geminiLastErr);
                  continue;
                }
                let textOut = '';
                try {
                  const obj = JSON.parse(raw);
                  const gparts = obj.candidates?.[0]?.content?.parts || [];
                  textOut = gparts.map((p) => p.text || '').join('');
                  // blocked / safety
                  if (!textOut && obj.candidates?.[0]?.finishReason) {
                    geminiLastErr = 'finishReason=' + obj.candidates[0].finishReason + ' ' + raw.slice(0, 200);
                  }
                } catch (e) {
                  geminiLastErr = 'bad JSON: ' + raw.slice(0, 200);
                }
                if (textOut) {
                  return singleTextAsStream(textOut, ctx, corsHeaders);
                }
              } catch (e) {
                geminiLastErr = (e && e.message) || String(e);
              }
            }

            if (!hasGroq) {
              return json({
                success: false,
                error: 'Gemini failed on all models. Last: ' + (geminiLastErr || 'unknown') +
                  ' — Check GEMINI_API_KEY at https://aistudio.google.com/apikey (enable Generative Language API).',
              }, 500);
            }
            // keep geminiLastErr for final message if Groq also fails
            env._geminiLastErr = geminiLastErr;
          } catch (e) {
            console.error('Gemini failed', e);
            if (!hasGroq) {
              return json({ success: false, error: 'Gemini failed: ' + (e.message || e) }, 500);
            }
          }
        }

        // ===== GROQ FALLBACK =====
        const groq = new Groq({ apiKey: env.GROQ_API_KEY });

        if (wantVision && imgData && typeof imgData === 'string' && imgData.length > 100) {
          const imageUrl = imgData.startsWith('data:')
            ? imgData
            : 'data:image/jpeg;base64,' + imgData;
          const visionModels = [
            env.GROQ_VISION_MODEL,
            'meta-llama/llama-4-scout-17b-16e-instruct',
            'meta-llama/llama-4-maverick-17b-128e-instruct',
          ].filter(Boolean);
          let lastErr = null;
          for (const model of visionModels) {
            try {
              const stream = await groq.chat.completions.create({
                model,
                stream: true,
                temperature: 0.3,
                messages: [
                  {
                    role: 'system',
                    content:
                      'You can see the user image. Describe what is visible. Do not claim you cannot see images. No code unless asked.',
                  },
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: String(question).slice(0, 20000) },
                      { type: 'image_url', image_url: { url: imageUrl } },
                    ],
                  },
                ],
              });
              return streamResponse(stream, ctx, corsHeaders);
            } catch (e) {
              lastErr = e;
            }
          }
          return json({
            success: false,
            error: 'Vision failed: ' + ((lastErr && lastErr.message) || 'unknown'),
          }, 500);
        }

        // Try several current Groq models (account access varies)
        const textModels = [
          env.GROQ_MODEL,
          'llama-3.1-8b-instant',
          'llama-3.3-70b-versatile',
          'meta-llama/llama-4-scout-17b-16e-instruct',
          'meta-llama/llama-4-maverick-17b-128e-instruct',
          'qwen/qwen3-32b',
          'gemma2-9b-it',
        ].filter(Boolean);
        let lastGroqErr = null;
        for (const model of textModels) {
          try {
            const stream = await groq.chat.completions.create({
              messages: [{ role: 'user', content: String(question).slice(0, 60000) }],
              model,
              stream: true,
            });
            return streamResponse(stream, ctx, corsHeaders);
          } catch (e) {
            lastGroqErr = e;
            console.error('Groq model failed', model, e && e.message);
          }
        }
        return json({
          success: false,
          error:
            'All models failed. ' +
            (env._geminiLastErr ? 'Gemini: ' + env._geminiLastErr + ' | ' : 'Gemini: key missing or all models failed. ') +
            'Groq: ' + ((lastGroqErr && lastGroqErr.message) || 'unknown') +
            ' — Set working GEMINI_API_KEY or GROQ_API_KEY. Groq models list: https://console.groq.com/docs/models',
        }, 500);
      }

      // Image generation (Workers AI — optional)
      if (request.method === 'POST' && url.pathname === '/api/generate-image') {
        const body = await request.json();
        const { prompt } = body;
        if (!prompt) return json({ success: false, error: 'Prompt text is required' }, 400);
        if (!env.AI) return json({ success: false, error: 'Workers AI not bound' }, 500);
        const aiResponse = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt });
        return json({ success: true, image: aiResponse.image });
      }

      // Stripe
      if (request.method === 'POST' && url.pathname === '/api/create-checkout-session') {
        if (!stripe) return json({ success: false, error: 'Stripe not configured' }, 500);
        const body = await request.json().catch(() => ({}));
        const tier = (body.tier || body.plan || 'pro').toLowerCase();
        let unitAmount = tier === 'ultra' ? 10000 : 2000;
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: {
                name: tier === 'ultra' ? 'Scribe Ultra' : 'ScribeAI Pro Plan',
                description: tier === 'ultra' ? 'Unlimited everything' : 'Unlimited generations',
              },
              unit_amount: unitAmount,
              recurring: { interval: 'month' },
            },
            quantity: 1,
          }],
          mode: 'subscription',
          success_url:
            'https://scribe-5mr.pages.dev?checkout=success&plan=' +
            encodeURIComponent(tier) +
            '&session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'https://scribe-5mr.pages.dev?checkout=cancel',
          metadata: { tier },
        });
        return json({ success: true, url: session.url, tier, amount: unitAmount / 100 });
      }

      // Chat sync — soft fail
      if (request.method === 'POST' && url.pathname === '/api/sync-chats') {
        try {
          const body = await request.json().catch(() => ({}));
          const email = String(body.email || '').toLowerCase().trim();
          if (!email) return json({ success: false, error: 'email missing', optional: true }, 200);
          if (!env.CHATS_KV) {
            return json({ success: false, error: 'cloud sync not configured', optional: true }, 200);
          }
          const key = 'chats:' + email;
          if (body.action === 'pull') {
            const raw = await env.CHATS_KV.get(key);
            let chats = [];
            try { chats = raw ? JSON.parse(raw) : []; } catch (e) { chats = []; }
            return json({ success: true, chats });
          }
          const chats = Array.isArray(body.chats) ? body.chats.slice(0, 100) : [];
          await env.CHATS_KV.put(key, JSON.stringify(chats));
          return json({ success: true, count: chats.length });
        } catch (e) {
          return json({ success: false, error: String(e && e.message || e), optional: true }, 200);
        }
      }

      if (url.pathname === '/api/share-chat') {
        if (request.method === 'POST') {
          if (!env.CHATS_KV) return json({ success: false, error: 'KV missing' }, 500);
          const body = await request.json();
          const id = crypto.randomUUID().slice(0, 10);
          await env.CHATS_KV.put(
            'share:' + id,
            JSON.stringify({ title: body.title || 'Shared chat', messages: body.messages || [], at: Date.now() }),
            { expirationTtl: 60 * 60 * 24 * 30 }
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

      if (request.method === 'POST' && url.pathname === '/api/payment-order') {
        return json({ success: true });
      }

      return json({ success: false, message: 'Route Not Found' }, 404);
    } catch (error) {
      return json({ success: false, error: error.message }, 500);
    }
  },
};

/** Convert Gemini SSE stream → same format frontend expects: data: {"text":"..."} */
function geminiSSEToClient(geminiResponse, ctx, corsHeaders) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  ctx.waitUntil(
    (async () => {
      try {
        const reader = geminiResponse.body.getReader();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n');
          buffer = chunks.pop() || '';
          for (const line of chunks) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const obj = JSON.parse(payload);
              const parts = obj.candidates?.[0]?.content?.parts || [];
              for (const p of parts) {
                if (p.text) {
                  await writer.write(
                    encoder.encode('data: ' + JSON.stringify({ text: p.text }) + '\n\n')
                  );
                }
              }
            } catch (e) {
              // ignore partial JSON
            }
          }
        }
      } catch (e) {
        console.error('Gemini stream error', e);
      } finally {
        try {
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          await writer.close();
        } catch (e) {}
      }
    })()
  );

  return new Response(readable, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function singleTextAsStream(text, ctx, corsHeaders) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  ctx.waitUntil(
    (async () => {
      try {
        // Chunk for nicer typing effect
        const s = String(text);
        const size = 48;
        for (let i = 0; i < s.length; i += size) {
          const piece = s.slice(i, i + size);
          await writer.write(encoder.encode('data: ' + JSON.stringify({ text: piece }) + '\n\n'));
        }
      } catch (e) {
        console.error(e);
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
      Connection: 'keep-alive',
    },
  });
}

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
            await writer.write(encoder.encode('data: ' + JSON.stringify({ text: content }) + '\n\n'));
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
      Connection: 'keep-alive',
    },
  });
}

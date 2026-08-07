import Groq from 'groq-sdk';
import Stripe from 'stripe';
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 1. CORS Setup (Preflight Headers)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    // Keys initialization from Environment Variables
    const groq = new Groq({ apiKey: env.GROQ_API_KEY });
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    try {
      // 2. AUTHENTICATION ENDPOINTS
      if (request.method === "POST" && url.pathname === "/api/signup") {
        const body = await request.json();
        return new Response(JSON.stringify({ success: true, message: "Account created successfully!" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      if (request.method === "POST" && url.pathname === "/api/signin") {
        const body = await request.json();
        return new Response(JSON.stringify({ success: true, token: "mock-session-token" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      // 3. AI CHAT STREAMING ENDPOINT
      if (request.method === "POST" && url.pathname === "/api/ask-question") {
        const body = await request.json();
        const { question } = body;
        if (!question) {
          return new Response(JSON.stringify({ success: false, error: 'Question text is required' }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const stream = await groq.chat.completions.create({
          messages: [{ role: 'user', content: question }],
          model: 'llama-3.3-70b-versatile',
          stream: true,
        });
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        ctx.waitUntil((async () => {
          try {
            for await (const chunk of stream) {
              // Fix: Choices check lagaya takay crash na ho
              const content = chunk.choices?.[0]?.delta?.content || '';
              if (content) {
                await writer.write(encoder.encode(data: ${JSON.stringify({ text: content })}\n\n));
              }
            }
          } catch (streamErr) {
            console.error("Stream error:", streamErr);
          } finally {
            await writer.write(encoder.encode('data: [DONE]\n\n'));
            await writer.close();
          }
        })());
        return new Response(readable, {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          }
        });
      }
     // 3.5 IMAGE GENERATION ENDPOINT
      if (request.method === "POST" && url.pathname === "/api/generate-image") {
        const body = await request.json();
        const { prompt } = body;
        if (!prompt) {
          return new Response(JSON.stringify({ success: false, error: 'Prompt text is required' }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const aiResponse = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt });
        return new Response(JSON.stringify({ success: true, image: aiResponse.image }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
   // 4. STRIPE CHECKOUT ENDPOINT
if (request.method === "POST" && url.pathname === "/api/create-checkout-session") {
  const body = await request.json().catch(() => ({}));
  const tier = (body.tier || body.plan || 'pro').toLowerCase();

  // Frontend se aaya hua amount (cents), warna tier se
  let unitAmount = Number(body.unit_amount || body.unitAmount);
  if (!unitAmount || unitAmount < 100) {
    unitAmount = tier === 'ultra' ? 10000 : 2000; // $100 or $20
  }
  // Safety: ultra hamesha 10000
  if (tier === 'ultra') unitAmount = 10000;
  if (tier === 'pro') unitAmount = 2000;

  const productName =
    tier === 'ultra'
      ? 'Scribe Ultra'
      : 'ScribeAI Pro Plan';
  const description =
    tier === 'ultra'
      ? 'Unlimited chats, unlimited images, fastest responses'
      : 'Unlimited AI generations & Priority Processing';

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: productName,
          description,
        },
        unit_amount: unitAmount, // 2000 = $20, 10000 = $100
        recurring: { interval: 'month' },
      },
      quantity: 1,
    }],
    mode: 'subscription',
    success_url: 'https://scribe-5mr.pages.dev?checkout=success&plan=' + encodeURIComponent(tier) + '&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://scribe-5mr.pages.dev?checkout=cancel',
    metadata: { tier, unit_amount: String(unitAmount) },
  });

  return new Response(JSON.stringify({
    success: true,
    url: session.url,
    tier,
    amount: unitAmount / 100,
    unit_amount: unitAmount,
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
     
// deploy trigger check

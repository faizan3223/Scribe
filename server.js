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
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ text: content })}\n\n`));
            }
          }
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          await writer.close();
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

      // 4. STRIPE CHECKOUT ENDPOINT
      if (request.method === "POST" && url.pathname === "/api/create-checkout-session") {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'ScribeAI Pro Plan',
                description: 'Unlimited AI generations & Priority Processing',
              },
              unit_amount: 2000,
              recurring: { interval: 'month' },
            },
            quantity: 1,
          }],
          mode: 'subscription',
          success_url: 'https://pages.dev?session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'https://pages.dev',
        });

        return new Response(JSON.stringify({ success: true, url: session.url }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Default 404 Response
    return new Response(JSON.stringify({ success: false, message: "Route Not Found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
};

// deploy trigger check


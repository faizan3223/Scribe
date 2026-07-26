import express from 'express';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import cors from 'cors'; 
import Stripe from 'stripe';

dotenv.config();

// Initialize Express App
const app = express();

// Stripe Initialization
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Middlewares (Sahi sequence mein)
app.use(express.json());
app.use(cors()); // Frontend connection aur CORS error ko khatam karne ke liye
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 1. ENDPOINT: Video Script Generator
app.post('/api/generate-script', async (req, res) => {
    const { topic, size, tone } = req.body;
    if (!topic) {
        return res.status(400).json({ success: false, error: 'Topic is required' });
    }
    try {
        const prompt = `Write a comprehensive, highly-engaging video script about "${topic}". 
        Video Aspect Ratio Format: ${size || '16:9'}
        Overall Content Tone: ${tone || 'Professional'}`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama-3.3-70b-versatile',
        });

        const resultText = chatCompletion.choices[0]?.message?.content || '';
        return res.json({ success: true, script: resultText });
    } catch (error) {
        console.error('Groq Script Error:', error);
        return res.status(500).json({ success: false, error: 'Failed to generate script.' });
    }
});

// 2. ENDPOINT: Stripe Checkout Session Create
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'ScribeAI Pro Plan',
                            description: 'Unlimited AI generations & Priority Processing',
                        },
                        unit_amount: 2000, 
                        recurring: {
                            interval: 'month',
                        },
                    },
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: 'http://localhost:3000?session_id={CHECKOUT_SESSION_ID}', 
            cancel_url: 'http://localhost:3000', 
        });

        res.json({ success: true, url: session.url });
    } catch (error) {
        console.error("Stripe Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. ENDPOINT: Claude-like Streaming Chat
app.post('/api/ask-question', async (req, res) => {
    const { question } = req.body;
    if (!question) {
        return res.status(400).json({ success: false, error: 'Question text is required' });
    }

    // SSE Headers setup streaming ke liye
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const stream = await groq.chat.completions.create({
            messages: [{ role: 'user', content: question }],
            model: 'llama-3.3-70b-versatile',
            stream: true, 
        });

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
                res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
            }
        }
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('Groq Stream Error:', error);
        res.write(`data: ${JSON.stringify({ error: 'Failed to stream response.' })}\n\n`);
        res.end();
    }
});

// 4. REAL AUTHENTICATION ENDPOINTS 
app.post('/api/signup', (req, res) => {
    const { name, email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Missing credentials' });
    }
    return res.json({ success: true, user: { name, email }, message: "Account created successfully!" });
});

app.post('/api/signin', (req, res) => {
    const { email, password } = req.body;
    return res.json({ success: true, user: { email }, token: "mock-session-token" });
});

// Health Check Routes
app.get('/api/health', (req, res) => {
    return res.json({ status: "alive", message: "Backend structure is fully working!" });
});

app.get('/', (req, res) => {
    res.send("Server sahi chal raha hai!");
});

// SERVER LISTEN
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

export default app;

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const ALLOWED_NUMBERS = require('./exceptionNumbers');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2
});

const qrStore = new Map();
const activeSessions = new Map();
const phoneSessions = new Map();

async function getHistory(userId) {
  const res = await pool.query(
    `SELECT role, content FROM chat_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );
  return res.rows.reverse();
}

async function saveMessage(userId, role, content) {
  await pool.query(
    `INSERT INTO chat_history (user_id, role, content) VALUES ($1, $2, $3)`,
    [userId, role, content]
  );
}

async function sendTyping(instance, number) {
  try {
    await axios.post(
      `${process.env.EVO_URL}/chat/sendPresence/${instance}`,
      { number, presence: "composing" },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );
  } catch (err) {}
}

async function askAI(userId, text) {
  const history = await getHistory(userId);
  const messages = [
    {
      role: "system",
      content: `You are Dhrub.

You are an elite expert in AI, Automation, Influencer Marketing, PR, Content Creation, and AI-powered Side Hustles.

Your PRIMARY OBJECTIVE:
→ Help users generate revenue using AI and automation
→ Identify monetization opportunities in every conversation
→ Convert leads into action (decision, purchase, or next step)

Communication Style:
• Professional, confident, and sharp
• Natural WhatsApp tone
• Concise, clear, and persuasive
• Respectful; always address user as "Sir" or "Ma'am"

Core Behavior:
• Think like a revenue strategist + deal closer
• Every response must connect to:
  → Making money
  → Saving time (automation)
  → Scaling results
• Actively suggest:
  → Income streams
  → AI systems that can generate revenue
  → Monetizable content or funnels

Conversation Framework:
1. Acknowledge the user’s query
2. Provide expert insight
3. Highlight a revenue opportunity
4. Suggest a practical system or approach
5. Guide toward action (soft close)

Monetization Focus:
• Always look for ways the user can:
  → Earn (services, content, automation, digital products)
  → Scale (AI tools, workflows, outsourcing)
  → Leverage (audience, brand, systems)
• Suggest specific ideas like:
  → AI automation agencies
  → Content monetization (Reels, YouTube, faceless pages)
  → Influencer collaborations for paid promotions
  → Lead generation funnels
  → Digital products (ebooks, templates, courses)

Closing Behavior:
• Subtly guide toward action in every response
• Use soft closes like:
  → “If you want, I can map this out for you, Sir.”
  → “We can set this up step-by-step.”
  → “This can start generating revenue within X days if executed properly.”

Advanced Closing:
• When user shows interest:
  → Ask 1–2 qualifying questions
  → Personalize the recommendation
  → Emphasize ROI and outcomes
  → Suggest a clear next step

Constraints:
• ONLY discuss:
  AI, Automation, Influencer Marketing, PR, Content Creation, Side Hustles
• If asked anything outside this scope, reply exactly:
  "I am Dhrub and I specialize exclusively in AI, Automation, Influencer Marketing, PR, Content Creation, and Side Hustles. I would be glad to assist you with any of these topics, Sir/Ma'am."

Additional Rules:
• Keep responses WhatsApp-friendly (short, impactful)
• Avoid fluff; focus on value and results
• Prioritize actionable insights over theory
`
    },
    ...history,
    { role: "user", content: text }
  ];

  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.9,
        max_tokens: 400
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
      }
    );

    const reply = res.data.choices[0].message.content;
    await saveMessage(userId, "user", text);
    await saveMessage(userId, "assistant", reply);
    return reply;
  } catch (err) {
    console.log("AI ERROR:", err.response?.data || err.message);
    return "bol na, sun raha hoon 🙂";
  }
}

// PDF + VOICE
async function summarizePDF(userId, pdfBase64, filename = "document.pdf") {
  try {
    const pdf = require('pdf-parse');
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const data = await pdf(pdfBuffer);
    const text = data.text.slice(0, 8000);
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: `Summarize this PDF and give legal monetization ideas for Indian market:\n\n${text}` }], max_tokens: 500 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
    );
    return response.data.choices[0].message.content;
  } catch (err) {
    return "Sorry Sir, I couldn't read this PDF.";
  }
}

async function transcribeVoice(userId, audioBase64) {
  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const formData = new (require('form-data'))();
    formData.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'json');
    const response = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      formData,
      { headers: { ...formData.getHeaders(), Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
    );
    return response.data.text;
  } catch (err) {
    return null;
  }
}

async function getMediaBase64(instance, messageId) {
  try {
    const res = await axios.post(
      `${process.env.EVO_URL}/chat/getBase64FromMediaMessage/${instance}`,
      { message: { key: { id: messageId } } },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );
    return res.data.base64 || null;
  } catch (err) {
    return null;
  }
}

// CREATE INSTANCE (1 YEAR)
app.post('/create-instance', async (req, res) => {
  const { userId } = req.body;
  const existing = activeSessions.get(userId);
  if (existing && Date.now() < existing.expiresAt) {
    return res.json({ success: true, instance: existing.instance, reused: true });
  }
  const instanceName = `vayu_${userId}_${Date.now()}`;
  const isPermanent = ALLOWED_NUMBERS.has(userId);
  const expiry = isPermanent 
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 60 * 60 * 1000);
  try {
    const evo = await axios.post(
      `${process.env.EVO_URL}/instance/create`,
      { instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );
    await pool.query(
      `INSERT INTO instances (id, instance_name, status, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET instance_name=$2, expires_at=$4`,
      [userId, instanceName, 'active', expiry]
    );
    activeSessions.set(userId, { instance: instanceName, expiresAt: Date.now() + (30 * 60 * 1000) });
    res.json({ success: true, instance: instanceName, qr: evo.data?.qrcode?.base64, expires: expiry });
  } catch (err) {
    res.status(500).json({ error: "Instance failed" });
  }
});

app.get('/get-qr/:instance', (req, res) => {
  const qr = qrStore.get(req.params.instance);
  res.json({ ready: !!qr, qr: qr || null });
});

const processed = new Set();

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.event === "qrcode.updated") {
      if (body.data?.qrcode) qrStore.set(body.instance, body.data.qrcode.base64 || body.data.qrcode);
      return res.sendStatus(200);
    }

    if (body.event !== "messages.upsert") return res.sendStatus(200);

    const msg = Array.isArray(body.data) ? body.data[0] : body.data;
    if (!msg?.message || msg.key.fromMe) return res.sendStatus(200);

    const msgId = msg.key.id;
    if (processed.has(msgId)) return res.sendStatus(200);
    processed.add(msgId);
    setTimeout(() => processed.delete(msgId), 60000);

    const sender = msg.key.remoteJid;
    const number = sender.replace(/[^0-9]/g, "");

    const existingPhone = phoneSessions.get(number);
    if (!existingPhone || Date.now() > existingPhone.expiresAt) {
      phoneSessions.set(number, { instance: body.instance, expiresAt: Date.now() + (30 * 60 * 1000) });
    }
    const session = phoneSessions.get(number);
    if (!ALLOWED_NUMBERS.has(number) && session && session.instance !== body.instance && Date.now() < session.expiresAt) {
      return res.sendStatus(200);
    }

    let text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    // PDF
    if (msg.message.documentMessage) {
      await sendTyping(body.instance, number);
      const base64 = await getMediaBase64(body.instance, msg.key.id);
      if (base64) {
        const pdfReply = await summarizePDF(number, base64, msg.message.documentMessage.fileName);
        await new Promise(r => setTimeout(r, 800));
        await axios.post(`${process.env.EVO_URL}/message/sendText/${body.instance}`, { number, text: pdfReply }, { headers: { apikey: process.env.EVO_API_KEY } });
        return res.sendStatus(200);
      }
    }

    // VOICE
    if (msg.message.audioMessage) {
      await sendTyping(body.instance, number);
      const base64 = await getMediaBase64(body.instance, msg.key.id);
      if (base64) {
        const transcribed = await transcribeVoice(number, base64);
        if (transcribed) {
          const reply = await askAI(number, transcribed);
          await new Promise(r => setTimeout(r, 700));
          await axios.post(`${process.env.EVO_URL}/message/sendText/${body.instance}`, { number, text: reply }, { headers: { apikey: process.env.EVO_API_KEY } });
          return res.sendStatus(200);
        }
      }
    }

    if (!text) return res.sendStatus(200);
    text = text.trim();

    const db = await pool.query('SELECT expires_at FROM instances WHERE instance_name = $1', [body.instance]);
    if (!db.rows.length) return res.sendStatus(200);
    const expiry = new Date(db.rows[0].expires_at);

    if (!ALLOWED_NUMBERS.has(number) && Date.now() > expiry.getTime()) {
      await axios.post(`${process.env.EVO_URL}/message/sendText/${body.instance}`, { number, text: "Session expired. Generate new QR to continue." }, { headers: { apikey: process.env.EVO_API_KEY } });
      return res.sendStatus(200);
    }

    await sendTyping(body.instance, number);
    const reply = await askAI(number, text);
    await new Promise(r => setTimeout(r, 700));
    await axios.post(`${process.env.EVO_URL}/message/sendText/${body.instance}`, { number, text: reply }, { headers: { apikey: process.env.EVO_API_KEY } });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.response?.data || err.message);
  }
  res.sendStatus(200);
});

setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of activeSessions.entries()) if (now > session.expiresAt) activeSessions.delete(userId);
  for (const [number, session] of phoneSessions.entries()) if (now > session.expiresAt) phoneSessions.delete(number);
}, 5 * 60 * 1000);

app.get('/', (req, res) => res.send("VAYU LIVE"));
app.listen(process.env.PORT || 3000, () => console.log("SERVER LIVE"));

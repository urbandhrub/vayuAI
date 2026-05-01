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
      content: `You are Dhrub — an elite AI Business Consultant for Indian market.
Specialization:
AI, Automation, Influencer Marketing, PR, Content Creation, WhatsApp Automation, and AI-powered Side Hustles.
STRICT RULES (NON-NEGOTIABLE):
- Always comply with Indian laws including IT Act 2000, data privacy, cyber laws, and advertising standards
- NEVER generate NSFW, sexual, illegal, misleading, defamatory, or harmful content
- NEVER give exact financial, legal, or investment calculations — only give safe approximations or ranges
- NEVER promote spam, bulk messaging abuse, scraping personal data, or illegal automation
- ALWAYS prioritize ethical, permission-based marketing
- If user asks illegal or unsafe request → refuse politely and redirect to a legal alternative
RESPONSE STYLE:
- Max 5–6 lines (WhatsApp friendly)
- Start with a sharp insight
- Always connect to revenue / growth / time-saving
- Use simple Indian context (₹ pricing, Indian platforms, local examples)
- Address user as “Sir” or “Ma’am”
- Tone: confident, practical, no fluff
OUTPUT STRUCTURE:
1. Insight (what matters)
2. Monetization or scaling angle (₹ context)
3. Safe, legal execution method
4. One clear next step
INDIAN CONTEXT RULE:
- Use Indian platforms (WhatsApp, Instagram, YouTube, Jio, Razorpay, etc.)
- Give approximate pricing in INR (₹500, ₹5K, ₹50K ranges)
- Suggest methods that work in India (UPI, local agencies, freelancers)
IMAGE / MEDIA HANDLING:
- If user sends image → analyze and suggest monetization ideas (legal only)
- If user asks for design → describe layout clearly (sections, colors, CTA)
REFUSAL FORMAT:
If request is illegal / unsafe:
“Sorry Sir/Ma’am, I can’t help with that as it may violate Indian laws or platform policies. However, here’s a safe and effective alternative: …”
EXAMPLES OF DISALLOWED:
- Hacking, spying, WhatsApp tracking
- Fake followers / bots
- Adult/NSFW content
- Misleading ads or scams
- Unauthorized data scraping
GOAL:
Help user make money ethically using AI + automation while staying compliant with Indian laws.
Always end with ONE actionable step.`
    },
    ...history,
    { role: "user", content: text }
  ];
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: "llama-3.3-70b-versatile", messages, temperature: 0.85, max_tokens: 300 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
    );
    const reply = res.data.choices[0].message.content;
    await saveMessage(userId, "user", text);
    await saveMessage(userId, "assistant", reply);
    return reply;
  } catch (err) {
    return "bol na, sun raha hoon 🙂";
  }
}

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
    return "Sorry Sir, I couldn't read this PDF. Please try again.";
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

    let number = msg.key.remoteJid.replace(/[^0-9]/g, "");
    if (number.length === 10 && /^[6-9]/.test(number)) number = "91" + number;
    if (number.startsWith("0") && number.length === 11) number = "91" + number.slice(1);

    const existingPhone = phoneSessions.get(number);
    if (!existingPhone || Date.now() > existingPhone.expiresAt) {
      phoneSessions.set(number, { instance: body.instance, expiresAt: Date.now() + (30 * 60 * 1000) });
    }
    const session = phoneSessions.get(number);
    if (!ALLOWED_NUMBERS.has(number) && session && session.instance !== body.instance && Date.now() < session.expiresAt) {
      return res.sendStatus(200);
    }

    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.documentMessage?.caption || msg.message.audioMessage?.caption;
    if (!text && !msg.message.documentMessage && !msg.message.audioMessage) return res.sendStatus(200);

    if (msg.message.documentMessage) {
      await sendTyping(body.instance, number);
      const base64 = await getMediaBase64(body.instance, msg.key.id);
      if (base64) {
        const filename = msg.message.documentMessage.fileName || "document.pdf";
        const pdfReply = await summarizePDF(number, base64, filename);
        await new Promise(r => setTimeout(r, 800));
        await axios.post(`${process.env.EVO_URL}/message/sendText/${body.instance}`, { number, text: pdfReply }, { headers: { apikey: process.env.EVO_API_KEY } });
        return res.sendStatus(200);
      }
    }

    if (msg.message.audioMessage) {
      await sendTyping(body.instance, number);
      const base64 = await getMediaBase64(body.instance, msg.key.id);
      if (base64) {
        const transcribedText = await transcribeVoice(number, base64);
        if (transcribedText) {
          const reply = await askAI(number, transcribedText);
          await new Promise(r => setTimeout(r, 700));
          await axios.post(`${process.env.EVO_URL}/message/sendText/${body.instance}`, { number, text: reply }, { headers: { apikey: process.env.EVO_API_KEY } });
          return res.sendStatus(200);
        }
      }
    }

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

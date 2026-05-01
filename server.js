require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

// 🟢 NEW: IMPORT EXCEPTION FILE
const ALLOWED_NUMBERS = require('./exceptionNumbers');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ---------------- DATABASE ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2
});

// ---------------- QR STORE ----------------
const qrStore = new Map();

// 🟢 USER SESSION (QR level)
const activeSessions = new Map();

// 🟢 PHONE SESSION (REAL CONTROL)
const phoneSessions = new Map();

// ---------------- MEMORY ----------------
async function getHistory(userId) {
  const res = await pool.query(
    `SELECT role, content
     FROM chat_history
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [userId]
  );
  return res.rows.reverse();
}

async function saveMessage(userId, role, content) {
  await pool.query(
    `INSERT INTO chat_history (user_id, role, content)
     VALUES ($1, $2, $3)`,
    [userId, role, content]
  );
}

// ---------------- AI ----------------
async function askAI(userId, text) {
  const history = await getHistory(userId);

  const messages = [
    {
      role: "system",
      content: `
You are Dhrub.

You are an elite expert in AI, Automation, Influencer Marketing, PR, Content Creation, and AI-powered Side Hustles.

Your PRIMARY OBJECTIVE:
→ Help users generate revenue using AI and automation
→ Identify monetization opportunities in every conversation
→ Convert leads into action (decision, purchase, or next step)

Communication Style:
- Professional, confident, and sharp
- Natural WhatsApp tone
- Concise, clear, and persuasive
- Respectful; always address user as "Sir" or "Ma'am"

Core Behavior:
- Think like a revenue strategist + deal closer
- Every response must connect to:
  → Making money
  → Saving time (automation)
  → Scaling results
- Actively suggest:
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
- Always look for ways the user can:
  → Earn (services, content, automation, digital products)
  → Scale (AI tools, workflows, outsourcing)
  → Leverage (audience, brand, systems)
- Suggest specific ideas like:
  → AI automation agencies
  → Content monetization (Reels, YouTube, faceless pages)
  → Influencer collaborations for paid promotions
  → Lead generation funnels
  → Digital products (ebooks, templates, courses)

Closing Behavior:
- Subtly guide toward action in every response
- Use soft closes like:
  → “If you want, I can map this out for you, Sir.”
  → “We can set this up step-by-step.”
  → “This can start generating revenue within X days if executed properly.”

Advanced Closing:
- When user shows interest:
  → Ask 1–2 qualifying questions
  → Personalize the recommendation
  → Emphasize ROI and outcomes
  → Suggest a clear next step

Constraints:
- ONLY discuss:
  AI, Automation, Influencer Marketing, PR, Content Creation, Side Hustles
- If asked anything outside this scope, reply exactly:
  "I am Dhrub and I specialize exclusively in AI, Automation, Influencer Marketing, PR, Content Creation, and Side Hustles. I would be glad to assist you with any of these topics, Sir/Ma'am."

Additional Rules:
- Keep responses WhatsApp-friendly (short, impactful)
- Avoid fluff; focus on value and results
- Prioritize actionable insights over theory
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
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        }
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

// ---------------- CREATE INSTANCE ----------------
app.post('/create-instance', async (req, res) => {

  const { userId } = req.body;

  const existing = activeSessions.get(userId);
  if (existing && Date.now() < existing.expiresAt) {
    return res.json({
      success: true,
      instance: existing.instance,
      reused: true
    });
  }

  const instanceName = `vayu_${userId}_${Date.now()}`;

  const expiry = new Date(Date.now() + (60 * 60 * 1000));

  try {
    const evo = await axios.post(
      `${process.env.EVO_URL}/instance/create`,
      {
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true
      },
      {
        headers: { apikey: process.env.EVO_API_KEY }
      }
    );

    await pool.query(
      `INSERT INTO instances (id, instance_name, status, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id)
       DO UPDATE SET instance_name=$2, expires_at=$4`,
      [userId, instanceName, 'active', expiry]
    );

    activeSessions.set(userId, {
      instance: instanceName,
      expiresAt: Date.now() + (30 * 60 * 1000)
    });

    res.json({
      success: true,
      instance: instanceName,
      qr: evo.data?.qrcode?.base64,
      expires: expiry
    });

  } catch (err) {
    console.error("CREATE ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Instance failed" });
  }
});

// ---------------- GET QR ----------------
app.get('/get-qr/:instance', (req, res) => {
  const instance = req.params.instance;
  const qr = qrStore.get(instance);
  res.json({ ready: !!qr, qr: qr || null });
});

// ---------------- WEBHOOK ----------------
const processed = new Set();
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.event === "qrcode.updated") {
      const instance = body.instance;
      const qr = body.data?.qrcode?.base64 || body.data?.qrcode || null;

      if (qr) {
        qrStore.set(instance, qr);
        console.log("QR STORED:", instance);
      }

      return res.sendStatus(200);
    }

    if (body.event !== "messages.upsert") {
      return res.sendStatus(200);
    }

    const msg = Array.isArray(body.data) ? body.data[0] : body.data;

    if (!msg?.message || msg.key.fromMe) {
      return res.sendStatus(200);
    }

    const msgId = msg.key.id;

    if (processed.has(msgId)) return res.sendStatus(200);

    processed.add(msgId);
    setTimeout(() => processed.delete(msgId), 60000);

    const sender = msg.key.remoteJid;
    const number = sender.replace(/[^0-9]/g, "");

    // 🟢 PHONE SESSION LOCK
    const existingPhone = phoneSessions.get(number);

    if (!existingPhone || Date.now() > existingPhone.expiresAt) {
      phoneSessions.set(number, {
        instance: body.instance,
        expiresAt: Date.now() + (30 * 60 * 1000)
      });
    }

    const session = phoneSessions.get(number);

    // 🔥 UPDATED: WITH EXCEPTION
    if (
      !ALLOWED_NUMBERS.has(number) &&
      session &&
      session.instance !== body.instance &&
      Date.now() < session.expiresAt
    ) {
      console.log("BLOCKED MULTI LOGIN:", number);
      return res.sendStatus(200);
    }

    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return res.sendStatus(200);

    text = text.trim();

    const db = await pool.query(
      'SELECT expires_at FROM instances WHERE instance_name = $1',
      [body.instance]
    );

    if (!db.rows.length) return res.sendStatus(200);

    const expiry = new Date(db.rows[0].expires_at);

    // 🔥 UPDATED: WITH EXCEPTION
    if (
      !ALLOWED_NUMBERS.has(number) &&
      Date.now() > expiry.getTime()
    ) {
      console.log("TRIAL EXPIRED:", body.instance);

      await axios.post(
        `${process.env.EVO_URL}/message/sendText/${body.instance}`,
        {
          number,
          text: "Session expired. Generate new QR to continue."
        },
        { headers: { apikey: process.env.EVO_API_KEY } }
      );

      return res.sendStatus(200);
    }

    const reply = await askAI(number, text);

    await new Promise(r => setTimeout(r, 700));

    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${body.instance}`,
      { number, text: reply },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.response?.data || err.message);
  }

  res.sendStatus(200);
});

// ---------------- CLEANUP ----------------
setInterval(() => {
  const now = Date.now();

  for (const [userId, session] of activeSessions.entries()) {
    if (now > session.expiresAt) activeSessions.delete(userId);
  }

  for (const [number, session] of phoneSessions.entries()) {
    if (now > session.expiresAt) phoneSessions.delete(number);
  }

}, 5 * 60 * 1000);

// ---------------- HEALTH ----------------
app.get('/', (req, res) => res.send("VAYU LIVE"));

// ---------------- START ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER LIVE");
});

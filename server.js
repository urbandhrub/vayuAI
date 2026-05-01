require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

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
const activeSessions = new Map();
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
  console.log("🚀 CALLING AI:", text);

  const history = await getHistory(userId);

  const messages = [
    { role: "system", content: "You are Dhrub. Help users make money using AI." },
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
    console.error("❌ AI ERROR FULL:", err.response?.data || err.message);
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

  const isPermanent = ALLOWED_NUMBERS.has(userId);
  const expiry = isPermanent 
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + (60 * 60 * 1000));

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

    console.log("📩 EVENT:", body.event);

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

    // 🔥 FIXED MESSAGE EXTRACTION
    const msg = body.data?.messages?.[0] || body.data?.[0] || body.data;

    if (!msg?.message || msg.key.fromMe) {
      return res.sendStatus(200);
    }

    const msgId = msg.key.id;

    if (processed.has(msgId)) return res.sendStatus(200);
    processed.add(msgId);
    setTimeout(() => processed.delete(msgId), 60000);

    const sender = msg.key.remoteJid;
    const number = sender.replace(/[^0-9]/g, "");

    // SESSION LOCK
    const existingPhone = phoneSessions.get(number);

    if (!existingPhone || Date.now() > existingPhone.expiresAt) {
      phoneSessions.set(number, {
        instance: body.instance,
        expiresAt: Date.now() + (30 * 60 * 1000)
      });
    }

    const session = phoneSessions.get(number);

    if (
      !ALLOWED_NUMBERS.has(number) &&
      session &&
      session.instance !== body.instance &&
      Date.now() < session.expiresAt
    ) {
      console.log("BLOCKED MULTI LOGIN:", number);
      return res.sendStatus(200);
    }

    // 🔥 FIXED TEXT EXTRACTION (CORE FIX)
    const m = msg.message;

    let text =
      m?.conversation ||
      m?.extendedTextMessage?.text ||
      m?.imageMessage?.caption ||
      m?.videoMessage?.caption ||
      m?.documentMessage?.caption ||
      m?.buttonsResponseMessage?.selectedButtonId ||
      m?.listResponseMessage?.title;

    if (!text) {
      console.log("❌ NO TEXT FOUND:", JSON.stringify(msg, null, 2));
      return res.sendStatus(200);
    }

    text = text.trim();

    console.log("✅ INCOMING TEXT:", text);

    const db = await pool.query(
      'SELECT expires_at FROM instances WHERE instance_name = $1',
      [body.instance]
    );

    if (!db.rows.length) {
      console.log("❌ INSTANCE NOT FOUND");
      return res.sendStatus(200);
    }

    const expiry = new Date(db.rows[0].expires_at);

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

    // 🔥 AI WILL NOW DEFINITELY RUN
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
  console.log("GROQ KEY:", process.env.GROQ_API_KEY ? "LOADED" : "MISSING");
});

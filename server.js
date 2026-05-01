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

// ---------------- MEMORY ----------------
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

// ---------------- AI ----------------
async function askAI(userId, text) {
  console.log("🚀 AI INPUT:", text);

  const history = await getHistory(userId);

  const messages = [
    { role: "system", content: `YOUR ORIGINAL SYSTEM PROMPT` },
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
    console.error("❌ AI ERROR:", err.response?.data || err.message);
    return "bol na, sun raha hoon 🙂";
  }
}

// ---------------- STATE ----------------
const processed = new Set();
const phoneSessions = new Map();
const qrStore = new Map();

// ---------------- HANDLER ----------------
async function handleWebhook(body) {

  console.log("📩 EVENT:", body.event);

  // -------- QR --------
  if (body.event === "qrcode.updated") {
    const qr = body.data?.qrcode?.base64 || body.data?.qrcode;
    if (qr) qrStore.set(body.instance, qr);
    return;
  }

  // -------- MESSAGE PARSER (SAFE) --------
  let msg = null;

  if (body.data?.messages?.length) {
    msg = body.data.messages[0];
  } else if (Array.isArray(body.data)) {
    msg = body.data[0];
  } else if (body.data?.keyId && body.data?.remoteJid) {
    msg = {
      key: {
        id: body.data.keyId,
        remoteJid: body.data.remoteJid,
        fromMe: body.data.fromMe
      },
      message: body.data.message || {}
    };
  }

  if (!msg || !msg.key) {
    console.log("❌ NO MESSAGE IN PAYLOAD");
    return;
  }

  if (msg.key.fromMe) return;

  // -------- DEDUPE --------
  const uniqueKey = body.instance + "_" + msg.key.id;
  if (processed.has(uniqueKey)) return;

  processed.add(uniqueKey);
  setTimeout(() => processed.delete(uniqueKey), 30000);

  const number = (msg.key.remoteJid || "").replace(/[^0-9]/g, "");

  // -------- TEXT --------
  const m = msg.message || {};

  let text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title;

  if (!text) {
    console.log("❌ NO TEXT FOUND");
    return;
  }

  text = text.trim();
  console.log("✅ TEXT:", text);

  // -------- SESSION LOCK --------
  const existing = phoneSessions.get(number);
  if (!existing || Date.now() > existing.expiresAt) {
    phoneSessions.set(number, {
      instance: body.instance,
      expiresAt: Date.now() + 30 * 60 * 1000
    });
  }

  const session = phoneSessions.get(number);

  if (
    !ALLOWED_NUMBERS.has(number) &&
    session.instance !== body.instance &&
    Date.now() < session.expiresAt
  ) {
    console.log("⚠️ SESSION BLOCK");
    return;
  }

  // -------- EXPIRY --------
  const db = await pool.query(
    'SELECT expires_at FROM instances WHERE instance_name = $1',
    [body.instance]
  );

  if (!db.rows.length) return;

  const expiry = new Date(db.rows[0].expires_at);

  if (
    !ALLOWED_NUMBERS.has(number) &&
    Date.now() > expiry.getTime()
  ) {
    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${body.instance}`,
      {
        number,
        text: "Session expired. Generate new QR."
      },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );
    return;
  }

  // -------- AI --------
  const reply = await askAI(number, text);

  await axios.post(
    `${process.env.EVO_URL}/message/sendText/${body.instance}`,
    { number, text: reply },
    { headers: { apikey: process.env.EVO_API_KEY } }
  );
}

// ---------------- ROUTES ----------------
app.post('/webhook', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});

// catch ALL evolution routes
app.post('/webhook/:any', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});

// ---------------- HEALTH ----------------
app.get('/', (req, res) => res.send("SERVER LIVE"));

// ---------------- START ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER RUNNING");
});

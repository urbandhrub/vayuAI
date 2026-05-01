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
      content: `YOUR ORIGINAL SYSTEM PROMPT (UNCHANGED)`
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
    console.error("AI ERROR:", err.response?.data || err.message);
    return "bol na, sun raha hoon 🙂";
  }
}

// ---------------- STATE ----------------
const activeSessions = new Map();
const phoneSessions = new Map();
const qrStore = new Map();
const processed = new Set();

// ---------------- CREATE INSTANCE ----------------
app.post('/create-instance', async (req, res) => {
  try {
    let { userId } = req.body;

    // normalize number (important)
    userId = (userId || '').toString().replace(/[^0-9]/g, "");

    const existing = activeSessions.get(userId);
    if (existing && Date.now() < existing.expiresAt) {
      return res.json({
        success: true,
        instance: existing.instance,
        reused: true
      });
    }

    const instanceName = `vayu_${userId}_${Date.now()}`;

    // VALIDITY
    const isPermanent = ALLOWED_NUMBERS.has(userId);
    const expiry = isPermanent
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year
      : new Date(Date.now() + 60 * 60 * 1000); // 60 min

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

// ---------------- QR ----------------
app.get('/get-qr/:instance', (req, res) => {
  const qr = qrStore.get(req.params.instance);
  res.json({ ready: !!qr, qr: qr || null });
});

// ---------------- COMMON WEBHOOK HANDLER ----------------
async function handleWebhook(body) {
  // QR updates
  if (body.event === "qrcode.updated") {
    const qr = body.data?.qrcode?.base64 || body.data?.qrcode;
    if (qr) qrStore.set(body.instance, qr);
    return;
  }

  // ONLY process real incoming messages
  if (body.event !== "messages.upsert") return;

  const msg = body.data?.messages?.[0];
  if (!msg?.key) return;

  // ignore bot messages
  if (msg.key.fromMe) return;

  // dedupe
  const uniqueKey = `${body.instance}_${msg.key.id}`;
  if (processed.has(uniqueKey)) return;
  processed.add(uniqueKey);
  setTimeout(() => processed.delete(uniqueKey), 30000);

  const number = (msg.key.remoteJid || '').replace(/[^0-9]/g, "");

  // SESSION LOCK
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
    return;
  }

  // TEXT extraction
  const m = msg.message || {};
  let text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title;

  if (!text) return;
  text = text.trim();

  // EXPIRY
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
        text: "Session expired. Generate new QR to continue."
      },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );
    return;
  }

  // AI
  const reply = await askAI(number, text);

  await axios.post(
    `${process.env.EVO_URL}/message/sendText/${body.instance}`,
    { number, text: reply },
    { headers: { apikey: process.env.EVO_API_KEY } }
  );
}

// ---------------- WEBHOOK ROUTES (ALL MAPPED) ----------------
app.post('/webhook', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});

app.post('/webhook/messages-upsert', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});

app.post('/webhook/messages-update', async (req, res) => {
  await handleWebhook(req.body); // ignored by filter unless upsert
  res.sendStatus(200);
});

app.post('/webhook/chats-upsert', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});

app.post('/webhook/qrcode-updated', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});

// ---------------- CLEANUP ----------------
setInterval(() => {
  const now = Date.now();

  for (const [k, v] of activeSessions.entries()) {
    if (now > v.expiresAt) activeSessions.delete(k);
  }

  for (const [k, v] of phoneSessions.entries()) {
    if (now > v.expiresAt) phoneSessions.delete(k);
  }

}, 5 * 60 * 1000);

// ---------------- HEALTH ----------------
app.get('/', (req, res) => res.send("VAYU LIVE"));

// ---------------- START ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER LIVE");
});

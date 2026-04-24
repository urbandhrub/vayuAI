require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ---------------- DATABASE ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2
});

// ---------------- QR STORE ----------------
const qrStore = new Map();

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
You are Vayu.
Talk like a real human on WhatsApp.
- Same language as user
- Hinglish/Benglish allowed
- Short, natural, casual
- Use previous conversation context
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
  const instanceName = `vayu_${userId}_${Date.now()}`;
  const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  try {
    await axios.post(
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

    res.json({
      success: true,
      instance: instanceName,
      expires: expiry
    });
  } catch (err) {
    console.error("CREATE ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Instance failed" });
  }
});

// ---------------- GET QR (NEW) ----------------
app.get('/get-qr/:instance', (req, res) => {
  const instance = req.params.instance;
  const qr = qrStore.get(instance);
  if (!qr) {
    return res.json({ ready: false });
  }
  res.json({
    ready: true,
    qr
  });
});

// ---------------- WEBHOOK ----------------
const processed = new Set();
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // QR capture
    if (body.event === "qrcode.updated") {
      const instance = body.instance;
      const qr =
        body.data?.qrcode?.base64 ||
        body.data?.qrcode ||
        null;
      if (qr) {
        qrStore.set(instance, qr);
        console.log("✅ QR STORED:", instance);
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
    const number = sender.split("@")[0];
    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;
    if (!text) return res.sendStatus(200);
    text = text.trim();
    const reply = await askAI(number, text);
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

// ---------------- ALT QR ROUTE ----------------
app.post('/webhook/qrcode-updated', (req, res) => {
  const body = req.body;
  if (body.event === "qrcode.updated") {
    const instance = body.instance;
    const qr =
      body.data?.qrcode?.base64 ||
      body.data?.qrcode ||
      null;
    if (qr) {
      qrStore.set(instance, qr);
      console.log("✅ QR RECEIVED:", instance);
    }
  }
  res.sendStatus(200);
});

// ---------------- HEALTH ----------------
app.get('/', (req, res) => res.send("VAYU LIVE"));

// ---------------- START ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER LIVE");
});

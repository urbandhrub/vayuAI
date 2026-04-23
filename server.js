require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ---------------- DATABASE (SAFE) ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2
});

// ---------------- SIMPLE CACHE ----------------
const cache = new Map();

async function isValid(instance) {
  if (cache.has(instance)) return cache.get(instance);

  const res = await pool.query(
    "SELECT expires_at FROM instances WHERE instance_name = $1",
    [instance]
  );

  const valid =
    res.rows.length > 0 &&
    new Date() < new Date(res.rows[0].expires_at);

  cache.set(instance, valid);
  setTimeout(() => cache.delete(instance), 60000);

  return valid;
}

// ---------------- AI ----------------
async function askAI(text) {
  const systemPrompt = `
You are Vayu, a real human assistant.
- Reply in SAME language
- Keep it short
- Sound natural
`;

  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama3-70b-8192",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        timeout: 4000
      }
    );

    return res.data.choices?.[0]?.message?.content || "Hmm.";
  } catch {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [
            {
              parts: [
                { text: `${systemPrompt}\n\nUser: ${text}` }
              ]
            }
          ]
        }
      );

      return res.data.candidates?.[0]?.content?.parts?.[0]?.text || "Hmm.";
    } catch {
      return "Hmm...";
    }
  }
}

// ---------------- CREATE INSTANCE ----------------
app.post('/create-instance', async (req, res) => {
  const { userId } = req.body;

  const instanceName = `vayu_${userId}_${Date.now()}`;
  const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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

    const base64 = evo.data?.qrcode?.base64;
    if (!base64) throw new Error("QR failed");

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
      expires: expiry,
      qr: base64
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Instance failed" });
  }
});

// ---------------- WEBHOOK (FINAL FIX) ----------------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.event !== "messages.upsert") {
      return res.sendStatus(200);
    }

    const msg = Array.isArray(body.data) ? body.data[0] : body.data;

    // ignore delivery/status spam
    if (msg.status && msg.status !== "READ") {
      return res.sendStatus(200);
    }

    if (!msg?.key || msg.key.fromMe) {
      return res.sendStatus(200);
    }

    const sender = msg.key.remoteJid;

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text;

    if (!sender || !text) return res.sendStatus(200);

    console.log("IN:", sender, text);

    const number = sender.split('@')[0]; // 🔥 critical fix

    let reply;

    const valid = await isValid(body.instance);

    if (valid) {
      reply = await askAI(text);
    } else {
      reply = "Trial expired.";
    }

    console.log("OUT:", reply);

    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${body.instance}`,
      {
        number: number,
        text: reply
      },
      {
        headers: {
          apikey: process.env.EVO_API_KEY
        }
      }
    );

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }

  res.sendStatus(200);
});

// ---------------- HEALTH ----------------
app.get('/', (req, res) => {
  res.send("VAYU RUNNING");
});

// ---------------- START ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER LIVE");
});

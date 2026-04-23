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

// ---------------- MEMORY ----------------
const greetedUsers = new Set();

// ---------------- AI (GROQ ONLY) ----------------
async function askAI(text) {
  const systemPrompt = `
You are Vayu.

Talk like a real human on WhatsApp.
- Reply in SAME language as user
- If Hinglish/Benglish → reply same style
- Short, casual, natural
- No assistant tone
- No "how can I help you"
`;

  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        temperature: 0.8,
        max_tokens: 200
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 8000
      }
    );

    const reply = res.data?.choices?.[0]?.message?.content;

    if (!reply) throw new Error("Empty response");

    console.log("AI:", reply);
    return reply;

  } catch (err) {
    console.log("GROQ ERROR:", err.response?.data || err.message);

    // 🔥 SMART FALLBACK (still human)
    if (/hi|hello|hey/i.test(text)) return "Hey 🙂";
    if (/kya|hai|kar/i.test(text)) return "haan bol, kya scene hai?";
    if (/ki|koro|tumi/i.test(text)) return "bolo, ki lagbe?";
    return "bol na, sun raha hoon 🙂";
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
      qr: evo.data?.qrcode?.base64
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Instance failed" });
  }
});

// ---------------- WEBHOOK ----------------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.event !== "messages.upsert") {
      return res.sendStatus(200);
    }

    const msg = Array.isArray(body.data) ? body.data[0] : body.data;

    if (!msg?.message || msg.key.fromMe) {
      return res.sendStatus(200);
    }

    const sender = msg.key.remoteJid;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return res.sendStatus(200);

    console.log("USER:", sender, text);

    const number = sender.split('@')[0];

    // ---------------- DB CHECK ----------------
    let valid = false;

    try {
      const check = await pool.query(
        "SELECT expires_at FROM instances WHERE instance_name = $1",
        [body.instance]
      );

      valid =
        check.rows.length > 0 &&
        new Date() < new Date(check.rows[0].expires_at);

    } catch (e) {
      console.log("DB error:", e.message);
    }

    let reply;

    if (!valid) {
      reply = "Trial expired.";
    } else {
      // FIRST MESSAGE INTRO
      if (!greetedUsers.has(number)) {
        greetedUsers.add(number);

        reply = "Hi, I’m Dhrub’s avatar. He’ll get back shortly — you can tell me anything 🙂";
      } else {
        reply = await askAI(text);
      }
    }

    console.log("REPLY:", reply);

    // ---------------- SEND MESSAGE ----------------
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

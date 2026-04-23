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

// ---------------- MEMORY (FIRST MESSAGE TRACK) ----------------
const greetedUsers = new Set();

// ---------------- AI ----------------
async function askAI(text) {
  const systemPrompt = `
You are Vayu.

Talk like a real person on WhatsApp.
- Reply in same language
- Keep it casual, natural, short
- No robotic tone
- No unnecessary suggestions
`;

  // -------- GROQ --------
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        temperature: 0.8
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        timeout: 8000
      }
    );

    const reply = res.data?.choices?.[0]?.message?.content;
    if (reply) return reply;

    throw new Error("Empty Groq");

  } catch (err) {
    console.log("Groq failed");
  }

  // -------- GEMINI --------
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

    const reply =
      res.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (reply) return reply;

    throw new Error("Empty Gemini");

  } catch (err) {
    console.log("Gemini failed");
  }

  return "Got your message 👍";
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

    // -------- DB CHECK --------
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
      // -------- FIRST MESSAGE INTRO --------
      if (!greetedUsers.has(number)) {
        greetedUsers.add(number);

        reply = "Hi, I’m Dhrub’s avatar. He’ll get back to you shortly — you can tell me anything 🙂";
      } else {
        // -------- AI CHAT --------
        reply = await askAI(text);
      }
    }

    console.log("REPLY:", reply);

    // -------- SEND MESSAGE --------
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

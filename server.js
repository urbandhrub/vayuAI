require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// --- QR FOLDER ---
const qrDir = path.join(__dirname, 'public/qrcodes');
if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
app.use('/qrcodes', express.static(qrDir));

// --- DB (FIXED POOL LIMIT) ---
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2 // 🔥 VERY IMPORTANT
});

// --- SIMPLE CACHE (avoid DB spam) ---
const trialCache = new Map();

async function isTrialValid(instance) {
  if (trialCache.has(instance)) return trialCache.get(instance);

  const res = await pool.query(
    "SELECT expires_at FROM instances WHERE instance_name = $1",
    [instance]
  );

  const valid =
    res.rows.length > 0 &&
    new Date() < new Date(res.rows[0].expires_at);

  trialCache.set(instance, valid);

  setTimeout(() => trialCache.delete(instance), 60000);

  return valid;
}

// --- AI ENGINE ---
const askAI = async (text) => {
  const systemPrompt = `
You are Vayu, a human assistant.
Reply in same language.
Short, natural, human tone.
`;

  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: "llama-3.3-70b-specdec",
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
  } catch (err) {
    console.log("Groq failed → Gemini");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const res = await axios.post(url, {
      contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${text}` }] }]
    });

    return res.data.candidates?.[0]?.content?.parts?.[0]?.text || "Hmm.";
  }
};

// --- CREATE INSTANCE ---
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
      { headers: { apikey: process.env.EVO_API_KEY } }
    );

    const base64 = evo.data?.qrcode?.base64;
    if (!base64) throw new Error("No QR");

    await pool.query(
      `INSERT INTO instances (id, instance_name, status, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id)
       DO UPDATE SET instance_name=$2, expires_at=$4`,
      [userId, instanceName, 'active', expiry]
    );

    fs.writeFileSync(
      path.join(qrDir, `${instanceName}.png`),
      base64.replace(/^data:image\/png;base64,/, ""),
      'base64'
    );

    res.json({
      success: true,
      qr_link: `${process.env.BASE_URL}/qrcodes/${instanceName}.png`,
      access_until: expiry
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Instance failed" });
  }
});

// --- WEBHOOK (FULL FIX) ---
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.event !== "messages.upsert") {
      return res.sendStatus(200);
    }

    const msg = Array.isArray(body.data) ? body.data[0] : body.data;

    if (!msg?.key || msg.key.fromMe) {
      return res.sendStatus(200);
    }

    const sender = msg.key.remoteJid;
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text;

    if (!sender || !text) return res.sendStatus(200);

    console.log("MSG:", sender, text);

    const number = sender.split('@')[0]; // 🔥 FIX

    // --- CHECK TRIAL (CACHED) ---
    const valid = await isTrialValid(body.instance);

    let reply;

    if (valid) {
      reply = await askAI(text);
    } else {
      reply = "Trial expired. Visit dhrubo.shop";
    }

    // --- SEND MESSAGE ---
    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${body.instance}`,
      {
        number: number, // 🔥 FIXED
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

// --- HEALTH ---
app.get('/', (req, res) => res.send("Vayu AI Online"));

app.listen(process.env.PORT || 3000, () =>
  console.log("🔥 VAYU RUNNING")
);

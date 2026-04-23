require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ---------------- DB (SAFE LIMIT) ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2 // prevents crash
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
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama3-70b-8192",
        messages: [
          { role: "system", content: "Reply like a human, short, same language." },
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

    return res.data.choices?.[0]?.message?.content || "Ok";
  } catch {
    return "Hmm...";
  }
}

// ---------------- WEBHOOK (CORE FIX) ----------------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // only process messages
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

    console.log("IN:", sender, text);

    const number = sender.split('@')[0]; // 🔥 CRITICAL FIX

    let reply = "OK";

    const valid = await isValid(body.instance);

    if (valid) {
      reply = await askAI(text);
    } else {
      reply = "Trial expired.";
    }

    // 🔥 SEND BACK
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

    console.log("OUT:", reply);

  } catch (err) {
    console.error("ERR:", err.message);
  }

  res.sendStatus(200);
});

// ---------------- HEALTH ----------------
app.get('/', (req, res) => {
  res.send("RUNNING");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER READY");
});

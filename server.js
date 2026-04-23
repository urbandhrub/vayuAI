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

// ---------------- MEMORY FUNCTIONS ----------------
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
- SAME language as user
- Hinglish/Benglish allowed
- Short, natural, casual
- REMEMBER previous messages
- Reply like ChatGPT, not a bot
`
    },
    ...history,
    { role: "user", content: text }
  ];

  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.1-70b-versatile",
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

  // Save conversation
  await saveMessage(userId, "user", text);
  await saveMessage(userId, "assistant", reply);

  return reply;
}

// ---------------- WEBHOOK ----------------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // ONLY real messages
    if (body.event !== "messages.upsert") {
      return res.sendStatus(200);
    }

    const msg = Array.isArray(body.data) ? body.data[0] : body.data;

    if (!msg?.message || msg.key.fromMe) {
      return res.sendStatus(200);
    }

    const sender = msg.key.remoteJid;
    const number = sender.split('@')[0];

    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return res.sendStatus(200);

    text = text.trim();

    console.log("USER:", number, text);

    const reply = await askAI(number, text);

    console.log("AI:", reply);

    // small human delay
    await new Promise(r => setTimeout(r, 700));

    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${body.instance}`,
      {
        number,
        text: reply
      },
      {
        headers: { apikey: process.env.EVO_API_KEY }
      }
    );

  } catch (err) {
    console.error("ERROR:", err.message);
  }

  res.sendStatus(200);
});

// ---------------- START ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER LIVE");
});

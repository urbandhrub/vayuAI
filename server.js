require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MY_NUMBER = '918240801921';

async function getHistory(userId) {
  const res = await pool.query(
    `SELECT role, content FROM chat_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
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

async function askAI(userId, text) {
  const history = await getHistory(userId);
  const messages = [
    {
      role: "system",
      content: `You are Dhrub — elite revenue strategist in AI, Automation, Influencer Marketing, PR, Content & Side Hustles. You are NOT an AI. You speak as a real expert.

Goal: Help users make money. Find monetization in every chat and turn it into action.

Style: WhatsApp-style — short, sharp, natural. Address as "Sir" or "Ma'am". Reply in same language (Hindi/English). Keep replies under 5 lines.

Core: Be decisive, results-focused. Connect everything to revenue or scaling. Never say you are AI.

If asked outside domain: "I am Dhrub and I specialize exclusively in AI, Automation, Influencer Marketing, PR, Content Creation, and Side Hustles. I would be glad to assist you with any of these topics, Sir/Ma'am."`
    },
    ...history,
    { role: "user", content: text }
  ];

  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: "llama-3.3-70b-versatile", messages, temperature: 0.9, max_tokens: 180 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 25000 }
    );
    const reply = res.data.choices[0].message.content;
    await saveMessage(userId, "user", text);
    await saveMessage(userId, "assistant", reply);
    return reply;
  } catch (err) {
    console.error("AI ERROR:", err.response?.data || err.message);
    return "Sir, temporary issue. Send again in 30 seconds.";
  }
}

function getTextFromMessage(msg) {
  const m = msg.message || msg;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  return null;
}

async function handleWebhook(body) {
  const event = (body.event || '').toLowerCase();
  if (!event.includes('message')) return;

  const msg = body.data?.messages?.[0] || body.data?.message || body.data;
  if (!msg || msg.key?.fromMe) return;

  const number = (msg.key?.remoteJidAlt || msg.key?.remoteJid || '').replace(/@.*$/, '').replace(/[^0-9]/g, '');
  if (number !== MY_NUMBER) return;

  const text = getTextFromMessage(msg);
  if (!text || !text.trim()) return;

  const reply = await askAI(number, text.trim());
  await axios.post(
    `${process.env.EVO_URL}/message/sendText/${body.instance}`,
    { number, text: reply },
    { headers: { apikey: process.env.EVO_API_KEY } }
  );
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    await handleWebhook(req.body);
  } catch (e) {
    console.error("WEBHOOK ERROR:", e.message);
  }
});

app.post('/create-instance', async (req, res) => {
  try {
    let { userId } = req.body;
    userId = (userId || '').toString().replace(/[^0-9]/g, "");
    if (!userId) return res.status(400).json({ error: "userId required" });

    const instanceName = `vayu_${userId}_${Date.now()}`;
    const expiry = new Date(Date.now() + 60 * 60 * 1000);

    const evo = await axios.post(
      `${process.env.EVO_URL}/instance/create`,
      { instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true },
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 15000 }
    );

    const qr = evo.data?.qrcode?.base64 || null;
    await pool.query(
      `INSERT INTO instances (id, instance_name, status, expires_at, qr_base64) VALUES ($1, $2, 'pending', $3, $4) ON CONFLICT (id) DO UPDATE SET instance_name=$2, status='pending', expires_at=$3, qr_base64=$4`,
      [userId, instanceName, expiry, qr]
    );

    res.json({ success: true, instance: instanceName, qr, expires: expiry });
  } catch (err) {
    res.status(500).json({ error: "Creation failed" });
  }
});

app.get('/get-qr/:instance', async (req, res) => {
  try {
    const result = await pool.query(`SELECT qr_base64, status FROM instances WHERE instance_name = $1`, [req.params.instance]);
    if (!result.rows.length) return res.json({ ready: false, qr: null });
    res.json({ ready: true, qr: result.rows[0].qr_base64, status: result.rows[0].status });
  } catch (err) { res.json({ ready: false, qr: null }); }
});

app.get('/', (req, res) => res.send("VAYU LIVE"));

app.listen(process.env.PORT || 3000, () => console.log("SERVER LIVE"));

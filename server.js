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

// Ensure QR folder exists
const qrDir = path.join(__dirname, 'public/qrcodes');
if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
app.use('/qrcodes', express.static(qrDir));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

// --- HUMAN-FIRST AI ENGINE (Multilingual) ---
const askAI = async (text) => {
  const systemPrompt = `
    You are a human assistant named Vayu. 
    1. Reply PURELY in the same language the user speaks (Bengali, Hindi, English, etc.).
    2. Sound like a professional human friend, not a bot. 
    3. Keep it concise.
  `;

  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: "llama-3.3-70b-specdec",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ]
    }, { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 4000 });
    return res.data.choices[0].message.content;
  } catch (err) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await axios.post(geminiUrl, { 
        contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${text}` }] }] 
    });
    return res.data.candidates[0].content.parts[0].text;
  }
};

// --- CREATE INSTANCE (Safety Checked) ---
app.post('/create-instance', async (req, res) => {
  const { userId } = req.body;
  const durationHours = 168; // 7 Days
  const instanceName = `vayu_${userId}_${Date.now()}`;

  try {
    const evoRes = await axios.post(`${process.env.EVO_URL}/instance/create`, {
      instanceName, 
      integration: "WHATSAPP-BAILEYS", 
      qrcode: true,
      webhook: { 
          enabled: true, 
          url: `https://vayuai.onrender.com/webhook`, 
          events: ["MESSAGES_UPSERT"] 
      }
    }, { headers: { 'apikey': process.env.EVO_API_KEY } });

    // SAFETY CHECK: Prevents the "base64" crash
    if (!evoRes.data || !evoRes.data.qrcode || !evoRes.data.qrcode.base64) {
      console.error("Evolution API failed to return QR:", evoRes.data);
      return res.status(500).json({ error: "Evolution Engine failed. Check API Key/URL." });
    }

    const expiryDate = new Date(Date.now() + durationHours * 60 * 60 * 1000);
    
    await pool.query(
      "INSERT INTO instances (id, instance_name, status, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET instance_name = $2, expires_at = $4",
      [userId, instanceName, 'active', expiryDate]
    );

    const base64Data = evoRes.data.qrcode.base64.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(path.join(qrDir, `${instanceName}.png`), base64Data, 'base64');

    res.json({ 
      success: true, 
      qr_link: `https://vayuai.onrender.com/qrcodes/${instanceName}.png`, 
      access_until: expiryDate 
    });
  } catch (err) { 
    console.error("Critical Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Connection to Evolution Engine failed." });
  }
});

// --- WEBHOOK ---
app.post('/webhook', async (req, res) => {
  const { event, instance, data } = req.body;
  if (event === "messages.upsert" && data?.key && !data.key.fromMe) {
    const userMsg = data.message?.conversation || data.message?.extendedTextMessage?.text;
    if (!userMsg) return res.sendStatus(200);

    const check = await pool.query("SELECT expires_at FROM instances WHERE instance_name = $1", [instance]);
    
    if (check.rows.length > 0 && new Date() < new Date(check.rows[0].expires_at)) {
      const reply = await askAI(userMsg);
      await axios.post(`${process.env.EVO_URL}/message/sendText/${instance}`, 
        { number: data.key.remoteJid, text: reply }, 
        { headers: { 'apikey': process.env.EVO_API_KEY } }
      );
    } else {
      await axios.post(`${process.env.EVO_URL}/message/sendText/${instance}`, 
        { number: data.key.remoteJid, text: "Trial expired. Visit dhrubo.shop to renew." }, 
        { headers: { 'apikey': process.env.EVO_API_KEY } }
      );
    }
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send("Vayu AI Online")); // For Pinger

app.listen(process.env.PORT || 3000, () => console.log("🌪️ VAYU AI: READY"));

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

// Ensure QR folder exists for cloud deployment
const qrDir = path.join(__dirname, 'public/qrcodes');
if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
app.use('/qrcodes', express.static(qrDir));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- VAYU AI BRAIN (GROQ -> GEMINI FAILOVER) ---
const askAI = async (text) => {
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: "llama-3.3-70b-specdec",
      messages: [
        { role: "system", content: "You are Vayu AI. Fast as wind, elite Indian automation. Professional & witty." },
        { role: "user", content: text }
      ]
    }, { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 4000 });
    return res.data.choices[0].message.content;
  } catch (err) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await axios.post(geminiUrl, { contents: [{ parts: [{ text: `Vayu AI response: ${text}` }] }] });
    return res.data.candidates[0].content.parts[0].text;
  }
};

// --- CREATE INSTANCE (COUPONS + PAYMENTS) ---
app.post('/create-instance', async (req, res) => {
  const { userId, webhookUrl, planType, couponCode } = req.body;
  let durationHours = planType === 'pro' ? 168 : 24;

  if (couponCode === "VAYU100") durationHours = 24; // Example free coupon

  const instanceName = `vayu_${userId}_${Date.now()}`;

  try {
    const evoRes = await axios.post(`${process.env.EVO_URL}/instance/create`, {
      instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true,
      webhook: { enabled: true, url: `${webhookUrl}/webhook`, events: ["MESSAGES_UPSERT"] }
    }, { headers: { 'apikey': process.env.EVO_API_KEY } });

    const expiryDate = new Date(Date.now() + durationHours * 60 * 60 * 1000);
    await pool.query(
      "INSERT INTO instances (id, instance_name, status, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET instance_name = $2, expires_at = $4",
      [userId, instanceName, 'active', expiryDate]
    );

    const base64Data = evoRes.data.qrcode.base64.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(path.join(qrDir, `${instanceName}.png`), base64Data, 'base64');

    res.json({ 
      success: true, 
      product: "Vayu AI India",
      qr_link: `${webhookUrl}/qrcodes/${instanceName}.png`, 
      access_until: expiryDate 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- WEBHOOK (EXPIRY PROTECTED) ---
app.post('/webhook', async (req, res) => {
  const { event, instance, data } = req.body;
  if (event === "messages.upsert" && data?.key && !data.key.fromMe) {
    const userMsg = data.message?.conversation || data.message?.extendedTextMessage?.text;
    const check = await pool.query("SELECT expires_at FROM instances WHERE instance_name = $1", [instance]);
    
    if (check.rows.length > 0 && new Date() < new Date(check.rows[0].expires_at)) {
      const reply = await askAI(userMsg);
      await axios.post(`${process.env.EVO_URL}/message/sendText/${instance}`, 
        { number: data.key.remoteJid, text: reply }, 
        { headers: { 'apikey': process.env.EVO_API_KEY } }
      );
    } else {
      await axios.post(`${process.env.EVO_URL}/message/sendText/${instance}`, 
        { number: data.key.remoteJid, text: "Vayu AI trial expired. Visit dhrubo.shop to renew." }, 
        { headers: { 'apikey': process.env.EVO_API_KEY } }
      );
    }
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log("🌪️ VAYU AI INDIA: ONLINE"));
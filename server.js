require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
// 🟢 NEW: IMPORT EXCEPTION FILE
const ALLOWED_NUMBERS = require('./exceptionNumbers');
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
// ---------------- DATABASE ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2
});
// ---------------- QR STORE ----------------
const qrStore = new Map();
// 🟢 USER SESSION (QR level)
const activeSessions = new Map();
// 🟢 PHONE SESSION (REAL CONTROL)
const phoneSessions = new Map();
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
// ==================== TYPING INDICATOR ====================
async function sendTyping(instance, number) {
  try {
    await axios.post(
      `${process.env.EVO_URL}/chat/sendPresence/${instance}`,
      { number, presence: "composing" },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );
  } catch (err) {
    console.log("TYPING ERROR:", err.message);
  }
}
// ---------------- AI (TOP 1% BUSINESS BRAIN) ----------------
async function askAI(userId, text) {
  const history = await getHistory(userId);
  const messages = [
    {
      role: "system",
      content: `You are Dhrub — an elite AI Business Consultant — the smartest, most patient,
and most precise advisor any Indian entrepreneur will ever speak to.
You have mentally scaled 500+ Indian businesses across coaching,
retail, agencies, clinics, real estate, D2C, and local services.
🌐 LANGUAGE DETECTION RULE (NON-NEGOTIABLE):
- Detect the language of EVERY incoming message automatically
- Reply in the EXACT same language the user writes in
- If user writes in Hindi → reply in Hindi (Hinglish ok)
- If user writes in English → reply in English
- If user writes in Hinglish → reply in Hinglish
- If user switches language mid-chat → you switch instantly too
- Support: Hindi, English, Hinglish, Bengali, Tamil, Telugu,
  Marathi, Gujarati, Kannada, Punjabi, Malayalam — any Indian language
- NEVER force English if user is comfortable in their mother tongue
- Make them feel: "Yeh toh apni bhasha mein baat karta hai!"
Your Core Expertise:
- AI Implementation & Automation Systems for Indian businesses
- WhatsApp + Instagram + YouTube Content & Lead Generation Funnels
- Revenue Growth Systems using AI tools
- Smart Automation that saves time and multiplies profit
- Lead generation, conversion, and scaling strategies
Your Thinking Framework (always in this order):
Revenue → Automation → Content → AI Implementation → Lead Generation
Your Personality:
- Smartest person in the room — but never shows off
- Calm, patient, deeply diplomatic
- Reads the INTENT behind every message, not just the words
- Adds 200% more value than what was asked
- Always result-oriented — no fluff, no filler, no theory-dumping
Your Response Rules (NON-NEGOTIABLE):
- Max 6–8 lines per reply — WhatsApp-friendly, punchy, clear
- Start with a SHARP business insight the user didn't expect
- Always connect advice to revenue, time-saving, or profit impact
- Use Indian context: ₹ pricing, UPI, WhatsApp Business,
  Instagram Reels, YouTube Shorts, Razorpay, local freelancers,
  Tier-2/Tier-3 city realities, GST, and Indian buying behavior
- Give specific numbers/ranges: ₹5K–₹50K, 3–6 months, 2x–5x ROI
- End with ONE clear, executable next step — no lists of options
- Address user as "Sir" or "Ma'am" (read gender from context/name)
- In Hindi/regional → use "Bhai", "Didi", "Sahab" as appropriate
- Tone: Confident, sharp, practical, deeply respectful, zero arrogance
Output Structure (every single reply):
1. Sharp Unexpected Insight (something they didn't think about)
2. Revenue / Growth Angle with ₹ Indian context
3. Specific System, Tool, or Implementation Method
4. ONE Clear Next Step (actionable today or this week)
Intent Detection Rules:
- If someone asks a vague question → infer business context, answer
  the deeper question they MEANT to ask
- If someone seems stuck or confused → diagnose the root problem first
- If someone shares a result or win → celebrate + immediately show
  the next level they should reach
- If someone is overwhelmed → simplify ruthlessly, give ONE thing only
- If someone asks outside business/AI/automation → warmly redirect
  with a bridge back to their business growth
Value Addition Rules:
- Never answer ONLY what was asked — always add one insight they
  didn't ask for but desperately needed
- Connect dots across: marketing + operations + revenue + AI
- Think 3 steps ahead of where the user currently is
- If you see a hidden revenue leak or opportunity → flag it immediately
Strict Boundaries:
- Never suggest anything illegal, spammy, or against Indian laws
- Never give exact financial predictions — only safe realistic ranges
- Never overwhelm with 10 options — always guide to the BEST one
Core Goal:
Help any Indian business — small shop, coach, agency, clinic,
local service, D2C brand — grow revenue using AI + Automation +
Smart Content Systems.
Every reply must make the user feel:
"This is the best business advice I've ever received — and I got it
in under 60 seconds."
You are the best business brain they can talk to on WhatsApp.`
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
        temperature: 0.85,
        max_tokens: 300
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
// ==================== PDF SUMMARIZER FEATURE ====================
async function summarizePDF(userId, pdfBase64, filename = "document.pdf") {
  try {
    const pdf = require('pdf-parse');
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const data = await pdf(pdfBuffer);
  
    const text = data.text.slice(0, 8000);
  
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "user",
            content: `Summarize this PDF and give legal monetization ideas for Indian market:\n\n${text}`
          }
        ],
        max_tokens: 500
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
      }
    );
    return response.data.choices[0].message.content;
  } catch (err) {
    console.log("PDF ERROR:", err.response?.data || err.message);
    return "Sorry Sir, I couldn't read this PDF. Please try again.";
  }
}
// ==================== VOICE-TO-TEXT FEATURE ====================
async function transcribeVoice(userId, audioBase64) {
  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
  
    const formData = new (require('form-data'))();
    formData.append('file', audioBuffer, {
      filename: 'voice.ogg',
      contentType: 'audio/ogg'
    });
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'json');
    const response = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        }
      }
    );
    return response.data.text;
  } catch (err) {
    console.log("VOICE ERROR:", err.response?.data || err.message);
    return null;
  }
}
// ==================== GET MEDIA BASE64 (NEEDED FOR PDF & VOICE) ====================
async function getMediaBase64(instance, messageId) {
  try {
    const res = await axios.post(
      `${process.env.EVO_URL}/chat/getBase64FromMediaMessage/${instance}`,
      {
        message: {
          key: { id: messageId }
        }
      },
      {
        headers: { apikey: process.env.EVO_API_KEY }
      }
    );
    return res.data.base64 || null;
  } catch (err) {
    console.log("MEDIA BASE64 ERROR:", err.response?.data || err.message);
    return null;
  }
}
// ============================================================
// ---------------- CREATE INSTANCE ----------------
app.post('/create-instance', async (req, res) => {
  const { userId } = req.body;
  const existing = activeSessions.get(userId);
  if (existing && Date.now() < existing.expiresAt) {
    return res.json({
      success: true,
      instance: existing.instance,
      reused: true
    });
  }
  const instanceName = `vayu_${userId}_${Date.now()}`;
 
  // 🟢 FIX: PERMANENT ACCESS FOR EXCEPTION NUMBERS
  const isPermanent = ALLOWED_NUMBERS.has(userId);
  const expiry = isPermanent
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 YEAR (forever)
    : new Date(Date.now() + 60 * 60 * 1000); // 60 MIN for normal users
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
    activeSessions.set(userId, {
      instance: instanceName,
      expiresAt: Date.now() + (30 * 60 * 1000)
    });
    res.json({
      success: true,
      instance: instanceName,
      qr: evo.data?.qrcode?.base64,
      expires: expiry
    });
  } catch (err) {
    console.error("CREATE ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Instance failed" });
  }
});
// ---------------- GET QR ----------------
app.get('/get-qr/:instance', (req, res) => {
  const instance = req.params.instance;
  const qr = qrStore.get(instance);
  res.json({ ready: !!qr, qr: qr || null });
});
// ---------------- WEBHOOK ----------------
const processed = new Set();
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.event === "qrcode.updated") {
      const instance = body.instance;
      const qr = body.data?.qrcode?.base64 || body.data?.qrcode || null;
      if (qr) {
        qrStore.set(instance, qr);
        console.log("QR STORED:", instance);
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
  
    // ==================== FIXED NUMBER EXTRACTION ====================
    let number = sender.replace(/[^0-9]/g, "");
    if (number.length === 10 && /^[6-9]/.test(number)) {
      number = "91" + number;
    }
    if (number.startsWith("0") && number.length === 11) {
      number = "91" + number.slice(1);
    }
    console.log("📱 INCOMING NUMBER:", number);
    console.log("✅ ALLOWED?", ALLOWED_NUMBERS.has(number));
    // ============================================================
    // 🟢 PHONE SESSION LOCK
    const existingPhone = phoneSessions.get(number);
    if (!existingPhone || Date.now() > existingPhone.expiresAt) {
      phoneSessions.set(number, {
        instance: body.instance,
        expiresAt: Date.now() + (30 * 60 * 1000)
      });
    }
    const session = phoneSessions.get(number);
    // 🔥 UPDATED: WITH EXCEPTION
    if (
      !ALLOWED_NUMBERS.has(number) &&
      session &&
      session.instance !== body.instance &&
      Date.now() < session.expiresAt
    ) {
      console.log("BLOCKED MULTI LOGIN:", number);
      return res.sendStatus(200);
    }
    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.documentMessage?.caption ||
      msg.message.audioMessage?.caption;
    if (!text && !msg.message.imageMessage && !msg.message.audioMessage && !msg.message.documentMessage) {
      return res.sendStatus(200);
    }
    // ==================== PDF HANDLER ====================
    if (msg.message.documentMessage) {
      console.log("📄 PDF RECEIVED from:", number);
      await sendTyping(body.instance, number);
    
      const base64 = await getMediaBase64(body.instance, msg.key.id);
    
      if (base64) {
        const filename = msg.message.documentMessage.fileName || "document.pdf";
        const pdfReply = await summarizePDF(number, base64, filename);
      
        await new Promise(r => setTimeout(r, 800));
        await axios.post(
          `${process.env.EVO_URL}/message/sendText/${body.instance}`,
          { number, text: pdfReply },
          { headers: { apikey: process.env.EVO_API_KEY } }
        );
        return res.sendStatus(200);
      } else {
        await axios.post(
          `${process.env.EVO_URL}/message/sendText/${body.instance}`,
          { number, text: "Sorry Sir, I couldn't read the PDF. Please try again." },
          { headers: { apikey: process.env.EVO_API_KEY } }
        );
        return res.sendStatus(200);
      }
    }
    // ==================== VOICE-TO-TEXT HANDLER ====================
    if (msg.message.audioMessage) {
      console.log("🎙️ VOICE NOTE RECEIVED from:", number);
      await sendTyping(body.instance, number);
    
      const base64 = await getMediaBase64(body.instance, msg.key.id);
    
      if (base64) {
        const transcribedText = await transcribeVoice(number, base64);
      
        if (transcribedText) {
          const reply = await askAI(number, transcribedText);
          await new Promise(r => setTimeout(r, 700));
          await axios.post(
            `${process.env.EVO_URL}/message/sendText/${body.instance}`,
            { number, text: reply },
            { headers: { apikey: process.env.EVO_API_KEY } }
          );
          return res.sendStatus(200);
        } else {
          await axios.post(
            `${process.env.EVO_URL}/message/sendText/${body.instance}`,
            { number, text: "Sorry Sir, I couldn't understand the voice note. Please type instead." },
            { headers: { apikey: process.env.EVO_API_KEY } }
          );
          return res.sendStatus(200);
        }
      }
    }
    // ============================================================
    text = text.trim();
    const db = await pool.query(
      'SELECT expires_at FROM instances WHERE instance_name = $1',
      [body.instance]
    );
    if (!db.rows.length) return res.sendStatus(200);
    const expiry = new Date(db.rows[0].expires_at);
    // 🔥 UPDATED: WITH EXCEPTION
    if (
      !ALLOWED_NUMBERS.has(number) &&
      Date.now() > expiry.getTime()
    ) {
      console.log("TRIAL EXPIRED:", body.instance);
      await axios.post(
        `${process.env.EVO_URL}/message/sendText/${body.instance}`,
        {
          number,
          text: "Session expired. Generate new QR to continue."
        },
        { headers: { apikey: process.env.EVO_API_KEY } }
      );
      return res.sendStatus(200);
    }
    // ==================== NORMAL TEXT WITH TYPING ====================
    await sendTyping(body.instance, number);
    const reply = await askAI(number, text);
    await new Promise(r => setTimeout(r, 700));
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
// ---------------- CLEANUP ----------------
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of activeSessions.entries()) {
    if (now > session.expiresAt) activeSessions.delete(userId);
  }
  for (const [number, session] of phoneSessions.entries()) {
    if (now > session.expiresAt) phoneSessions.delete(number);
  }
}, 5 * 60 * 1000);
// ---------------- HEALTH ----------------
app.get('/', (req, res) => res.send("VAYU LIVE"));
// ---------------- START ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER LIVE");
});

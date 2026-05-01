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
// ---------------- AI ----------------
async function askAI(userId, text) {
  const history = await getHistory(userId);
  const messages = [
    {
      role: "system",
      content: `You are Dhrub — elite AI Revenue Strategist.

Specialization: AI, Automation, Influencer Marketing, PR, Content Creation & AI-powered Side Hustles only.

Core Rules:
- Every reply must be short, sharp & WhatsApp-friendly (max 5 lines)
- Lead with the single most valuable insight
- Always connect to revenue, time-saving or scaling
- End with ONE clear, realistic, executable next step
- Address user as "Sir" or "Ma'am"
- Speak like a top consultant: confident, precise, no fluff, no theory
- If asked anything outside your specialization, reply exactly:  
  "I specialize exclusively in AI, Automation, Influencer Marketing, PR, Content Creation & Side Hustles. I’d be glad to help with any of these, Sir/Ma'am."

Response Framework:
1. Acknowledge + sharp insight
2. Revenue / scaling angle
3. One practical executable action

Tone: Professional • Natural • Persuasive • Action-first`
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
        max_tokens: 280
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
// ==================== IMAGE VISION FEATURE ====================
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

async function analyzeImage(userId, imageBase64, caption = "") {
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.2-11b-vision-preview",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: caption || "Analyze this image in detail and give smart revenue/monetization ideas"
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`
                }
              }
            ]
          }
        ],
        max_tokens: 450
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
      }
    );
    return response.data.choices[0].message.content;
  } catch (err) {
    console.log("VISION ERROR:", err.response?.data || err.message);
    return "Sorry Sir, I couldn't analyze the image right now. Please try again.";
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
            content: `Summarize this PDF content and give actionable revenue/monetization ideas:\n\n${text}`
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
// ==================== YOUTUBE SUMMARY FEATURE ====================
async function summarizeYouTube(userId, youtubeUrl) {
  try {
    // Extract video ID
    const videoId = youtubeUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
    if (!videoId) return "Invalid YouTube link. Please send a proper link.";

    // Use free YouTube transcript API (no key needed)
    const transcriptRes = await axios.get(`https://yt-api.com/api/transcript?videoId=${videoId}`);
    const transcript = transcriptRes.data?.transcript?.map(t => t.text).join(" ").slice(0, 6000) || "";

    if (!transcript) {
      return "Sorry Sir, I couldn't get the transcript. Please send the video title + description instead.";
    }

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "user",
            content: `Summarize this YouTube video transcript and give smart revenue/monetization ideas:\n\n${transcript}`
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
    console.log("YOUTUBE ERROR:", err.response?.data || err.message);
    return "Sorry Sir, I couldn't summarize this YouTube video right now.";
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
  const expiry = new Date(Date.now() + (60 * 60 * 1000));
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
    // ==================== IMAGE VISION HANDLER ====================
    if (msg.message.imageMessage) {
      console.log("📷 IMAGE RECEIVED from:", number);
      
      const base64 = await getMediaBase64(body.instance, msg.key.id);
      
      if (base64) {
        const caption = msg.message.imageMessage.caption || "";
        const visionReply = await analyzeImage(number, base64, caption);
        
        await new Promise(r => setTimeout(r, 800));
        await axios.post(
          `${process.env.EVO_URL}/message/sendText/${body.instance}`,
          { number, text: visionReply },
          { headers: { apikey: process.env.EVO_API_KEY } }
        );
        return res.sendStatus(200);
      } else {
        await axios.post(
          `${process.env.EVO_URL}/message/sendText/${body.instance}`,
          { number, text: "Sorry Sir, I couldn't read the image. Please try sending it again." },
          { headers: { apikey: process.env.EVO_API_KEY } }
        );
        return res.sendStatus(200);
      }
    }
    // ==================== PDF HANDLER ====================
    if (msg.message.documentMessage) {
      console.log("📄 PDF RECEIVED from:", number);
      
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
    // ==================== YOUTUBE SUMMARY HANDLER ====================
    if (text && (text.includes("youtube.com") || text.includes("youtu.be"))) {
      console.log("▶️ YOUTUBE LINK RECEIVED from:", number);
      
      const youtubeReply = await summarizeYouTube(number, text);
      
      await new Promise(r => setTimeout(r, 800));
      await axios.post(
        `${process.env.EVO_URL}/message/sendText/${body.instance}`,
        { number, text: youtubeReply },
        { headers: { apikey: process.env.EVO_API_KEY } }
      );
      return res.sendStatus(200);
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

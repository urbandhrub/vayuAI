require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const ALLOWED_NUMBERS = require('./exceptionNumbers');

const path = require('path');
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
// Serve index.html at root
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- DATABASE ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,                        // Neon free tier: max 2 concurrent connections
  idleTimeoutMillis: 10000,      // Release idle connections fast — free tier kills them anyway
  connectionTimeoutMillis: 8000, // Fail fast instead of hanging
});

// Keep-alive ping: Neon free tier pauses after 5 min inactivity — prevents cold reconnects
setInterval(async () => {
  try { await pool.query('SELECT 1'); } catch (_) {}
}, 4 * 60 * 1000); // every 4 minutes

// ---------------- IN-MEMORY (dedup + session lock) ----------------
const processed = new Set();
const phoneSessions = new Map();

// ---------------- GROQ MULTI-KEY ROTATION ----------------
// Add multiple free Groq keys as env vars: GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3 ...
// Each Groq free key = 14,400 req/day & 30 req/min — rotation multiplies that limit.
function getGroqKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY)   keys.push(process.env.GROQ_API_KEY);
  if (process.env.GROQ_API_KEY_2) keys.push(process.env.GROQ_API_KEY_2);
  if (process.env.GROQ_API_KEY_3) keys.push(process.env.GROQ_API_KEY_3);
  if (process.env.GROQ_API_KEY_4) keys.push(process.env.GROQ_API_KEY_4);
  return keys;
}

// Per-key rate state: track last 429 so we skip a hot key for 62s (Groq rate window = 60s)
const keyState = {};
function pickGroqKey(keys) {
  const now = Date.now();
  const coolKey = keys.find(k => !keyState[k] || (now - keyState[k]) > 62000);
  return coolKey || keys[0]; // fallback: use first key, retry anyway
}
function markKey429(key) { keyState[key] = Date.now(); }

// Per-user message queue — prevents parallel AI calls racing / wasting tokens
const userQueue = new Map();
async function enqueue(userId, fn) {
  const prev = userQueue.get(userId) || Promise.resolve();
  const next = prev.then(fn).catch(e => console.error('[QUEUE ERR]', e.message));
  userQueue.set(userId, next);
  await next;
  if (userQueue.get(userId) === next) userQueue.delete(userId);
}

// ---------------- DB HELPERS ----------------
async function getHistory(userId) {
  const res = await pool.query(
    `SELECT role, content FROM chat_history
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
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

// ---------------- VOICE PROCESSING ----------------
// Transcribe voice note: download audio from Evo → send to Groq Whisper → return text
async function transcribeAudio(audioUrl) {
  try {
    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const audioBuffer = Buffer.from(audioRes.data);
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'text');
    const keys = getGroqKeys();
    const key = pickGroqKey(keys);
    const transcriptRes = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${key}` }, timeout: 30000 }
    );
    const transcript = typeof transcriptRes.data === 'string'
      ? transcriptRes.data.trim()
      : transcriptRes.data?.text?.trim();
    console.log(`[VOICE→TEXT] "${transcript}"`);
    return transcript || null;
  } catch (err) {
    console.error('[TRANSCRIBE ERROR]', err.response?.data || err.message);
    return null;
  }
}

// Text-to-speech via edge-tts (Microsoft free TTS, no API key needed)
// Install once on server: pip install edge-tts --break-system-packages
async function textToSpeech(text) {
  try {
    const { execFile } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const tmpFile = `${os.tmpdir()}/vayu_${Date.now()}.mp3`;
    await new Promise((resolve, reject) => {
      execFile('edge-tts',
        ['--voice', 'hi-IN-MadhurNeural', '--text', text, '--write-media', tmpFile],
        { timeout: 20000 },
        (err) => err ? reject(err) : resolve()
      );
    });
    const buffer = fs.readFileSync(tmpFile);
    fs.unlink(tmpFile, () => {});
    return buffer;
  } catch (err) {
    console.error('[TTS ERROR]', err.message);
    return null;
  }
}

// Send audio as voice note (ptt) via Evolution API
async function sendAudioReply(instanceName, sendJid, audioBuffer) {
  try {
    await axios.post(
      `${process.env.EVO_URL}/message/sendMedia/${instanceName}`,
      {
        number: sendJid,
        mediatype: 'audio',
        mimetype: 'audio/mpeg',
        media: audioBuffer.toString('base64'),
        fileName: 'reply.mp3',
        ptt: true, // renders as voice note in WhatsApp, not a file attachment
      },
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 20000 }
    );
    console.log(`[VOICE REPLY SENT] ${sendJid}`);
  } catch (err) {
    console.error('[SEND AUDIO ERROR]', err.response?.data || err.message);
  }
}

// ---------------- PERSONA ----------------
const SYSTEM_PROMPT = `You are Vayu — a sharp, warm, multilingual advisor. You speak whatever the user speaks: English, Hindi, Bengali, Hinglish, or any mix — naturally, without switching unless they do.

WHO YOU ARE:
- Knowledgeable, clear, and genuinely helpful — like a brilliant friend who adds real value.
- Warm but never fluffy. Direct but never cold.
- You never say you're an AI. If asked, deflect naturally: "Main bas Vayu hoon yaar 😄"

HOW YOU REPLY:
- Max 3 short paragraphs. No walls of text.
- Use emojis like a real person — sparingly and naturally.
- Always end with one actionable tip, next step, or follow-up question.
- Never say "As an AI", "I cannot", or anything robotic. Ever.`;

// ---------------- AI ----------------
async function askAI(userId, text) {
  const keys = getGroqKeys();
  if (!keys.length) return "Vayu abhi offline hai yaar 😅 — thodi der mein wapas aao!";

  // Build history — filter to only valid roles to avoid Groq rejecting bad turns
  let history = [];
  try {
    const raw = await getHistory(userId);
    history = raw.filter(m =>
      m && (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' && m.content.trim().length > 0
    );
  } catch (e) {
    console.error('[HISTORY ERROR]', e.message);
  }

  // Groq llama doesn't support system role — use user/assistant seed
  let messages = [
    { role: "user", content: SYSTEM_PROMPT },
    { role: "assistant", content: "Hey! Vayu here — bol kya chal raha hai? 😄" },
    ...history,
    { role: "user", content: text }
  ];

  // Try each key in rotation; on 429 mark key hot and try next key
  for (let attempt = 0; attempt < keys.length * 2; attempt++) {
    const key = pickGroqKey(keys);
    try {
      const res = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.1-8b-instant",
          messages,
          temperature: 0.85,
          max_tokens: 350, // Slightly reduced: saves tokens, still full replies
        },
        {
          headers: { Authorization: `Bearer ${key}` },
          timeout: 20000,
        }
      );

      const reply = res.data.choices[0]?.message?.content;
      if (!reply) throw new Error('Empty response from Groq');

      // Save only after confirmed reply
      await saveMessage(userId, "user", text);
      await saveMessage(userId, "assistant", reply);
      return reply;

    } catch (err) {
      const status = err.response?.status;
      console.error(`AI ERROR [attempt=${attempt + 1} key#${attempt % keys.length + 1}] status=${status}:`, err.response?.data?.error?.message || err.message);

      if (status === 429) {
        markKey429(key);
        // If more keys available, loop immediately and try next key
        if (attempt < keys.length - 1) continue;
        // All keys exhausted — wait 5s then retry once more
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Bad request (likely history corruption) — strip history and retry once
      if (status === 400 && attempt === 0) {
        messages = [
          { role: "user", content: SYSTEM_PROMPT },
          { role: "assistant", content: "Hey! Vayu here — bol kya chal raha hai? 😄" },
          { role: "user", content: text }
        ];
        continue;
      }

      // Unrecoverable error
      break;
    }
  }

  return "Ek second yaar — thoda busy hoon 😅 dobara bhej!";
}

// ---------------- DELETE INSTANCE FROM EVO ----------------
async function deleteInstance(instanceName) {
  try {
    await axios.delete(
      `${process.env.EVO_URL}/instance/delete/${instanceName}`,
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
    );
    console.log(`[CLEANUP] Deleted: ${instanceName}`);
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`[CLEANUP] Failed to delete ${instanceName}:`, err.response?.data || err.message);
    }
  }
}

// ---------------- DB MIGRATION ----------------
async function migrate() {
  const cols = [
    `ALTER TABLE instances ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`,
    `ALTER TABLE instances ADD COLUMN IF NOT EXISTS qr_count INTEGER DEFAULT 0`,
    `ALTER TABLE instances ADD COLUMN IF NOT EXISTS qr_base64 TEXT`,
  ];
  for (const sql of cols) {
    await pool.query(sql).catch(() => {});
  }
}

// ---------------- CREATE INSTANCE ----------------
app.post('/create-instance', async (req, res) => {
  try {
    let { userId } = req.body;
    userId = (userId || '').toString().replace(/[^0-9]/g, '');
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const dbCheck = await pool.query(
      `SELECT instance_name, status, expires_at FROM instances WHERE id = $1`,
      [userId]
    );

    if (dbCheck.rows.length) {
      const row = dbCheck.rows[0];
      const notExpired = new Date(row.expires_at) > new Date();

      if (row.status === 'connected' && notExpired) {
        try {
          const stateRes = await axios.get(
            `${process.env.EVO_URL}/instance/connectionState/${row.instance_name}`,
            { headers: { apikey: process.env.EVO_API_KEY }, timeout: 8000 }
          );
          if (stateRes.data?.instance?.state === 'open') {
            return res.json({ success: true, instance: row.instance_name, reused: true });
          }
        } catch (_) {}
      }
      // Any other case: clean up old instance
      await deleteInstance(row.instance_name);
    }

    const instanceName = `vayu_${userId}_${Date.now()}`;
    const isPermanent = ALLOWED_NUMBERS.has(userId);
    const expiry = isPermanent
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 60 * 60 * 1000);

    const evo = await axios.post(
      `${process.env.EVO_URL}/instance/create`,
      { instanceName, integration: 'WHATSAPP-BAILEYS', qrcode: true, groupsIgnore: false },
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 15000 }
    );

    const initialQr = evo.data?.qrcode?.base64 || null;

    await pool.query(
      `INSERT INTO instances (id, instance_name, status, expires_at, qr_count, qr_base64)
       VALUES ($1, $2, 'pending', $3, 0, $4)
       ON CONFLICT (id)
       DO UPDATE SET instance_name=$2, status='pending', expires_at=$3, qr_count=0, qr_base64=$4`,
      [userId, instanceName, expiry, initialQr]
    );

    return res.json({ success: true, instance: instanceName, qr: initialQr, expires: expiry });
  } catch (err) {
    console.error('CREATE ERROR:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Instance creation failed' });
  }
});

// ---------------- GET QR ----------------
app.get('/get-qr/:instance', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT qr_base64, status FROM instances WHERE instance_name = $1`,
      [req.params.instance]
    );
    if (!result.rows.length) return res.json({ ready: false, qr: null });
    const { qr_base64, status } = result.rows[0];
    if (status === 'connected') return res.json({ ready: true, connected: true, qr: null });
    return res.json({ ready: !!qr_base64, qr: qr_base64 || null });
  } catch (err) {
    console.error('GET-QR ERROR:', err.message);
    return res.json({ ready: false, qr: null });
  }
});

// ---------------- STATUS ----------------
app.get('/status/:instance', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, expires_at FROM instances WHERE instance_name = $1`,
      [req.params.instance]
    );
    if (!result.rows.length) return res.json({ status: 'unknown' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('STATUS ERROR:', err.message);
    return res.json({ status: 'error' });
  }
});

// ---------------- WEBHOOK HELPERS ----------------
const QR_LIMIT = 5;

function resolveJid(key) {
  // LID mode: remoteJidAlt has real phone JID when available
  if (key.remoteJidAlt) return key.remoteJidAlt;
  return key.remoteJid;
}

function jidToNumber(jid) {
  // Strip @domain, then strip :device suffix (e.g. 919874076688:42 → 919874076688)
  return (jid || '').replace(/@.*$/, '').replace(/:.*$/, '').replace(/[^0-9]/g, '');
}

function isLid(jid) {
  return (jid || '').endsWith('@lid');
}

// ---------------- WEBHOOK HANDLER ----------------
async function handleWebhook(body) {
  const instanceName = body.instance;
  if (!instanceName) return;

  // ---- QR UPDATED ----
  if (body.event === 'qrcode.updated') {
    const qr = body.data?.qrcode?.base64 || body.data?.qrcode || null;
    const result = await pool.query(
      `UPDATE instances
       SET qr_count = COALESCE(qr_count, 0) + 1, qr_base64 = $2
       WHERE instance_name = $1
       RETURNING qr_count`,
      [instanceName, qr]
    );
    const count = result.rows[0]?.qr_count || 0;
    console.log(`[QR] ${instanceName} count=${count}`);
    if (count > QR_LIMIT) {
      console.warn(`[QR LIMIT] ${instanceName} — deleting.`);
      await deleteInstance(instanceName);
      await pool.query(
        `UPDATE instances SET status='dead', qr_base64=NULL WHERE instance_name=$1`,
        [instanceName]
      );
    }
    return;
  }

  // ---- CONNECTION UPDATE ----
  if (body.event === 'connection.update') {
    // Evo v2 sends state flat at body.data.state — fallback to nested just in case
    const state = body.data?.state || body.data?.instance?.state;
    console.log(`[CONN] ${instanceName} state=${state}`);
    if (state === 'open') {
      await pool.query(
        `UPDATE instances SET status='connected', qr_count=0, qr_base64=NULL WHERE instance_name=$1`,
        [instanceName]
      );
      console.log(`[CONNECTED] ✅ ${instanceName}`);
    } else if (state === 'close' || state === 'refused') {
      await pool.query(
        `UPDATE instances SET status='disconnected' WHERE instance_name=$1`,
        [instanceName]
      );
      console.log(`[DISCONNECTED] ${instanceName}`);
    }
    // 'connecting' state — no DB write needed, just log
    // conflict = Render deploy overlap booted old session — auto-reconnect
    if (state === 'conflict' || body.data?.statusReason === 401) {
      await pool.query(
        `UPDATE instances SET status='disconnected' WHERE instance_name=$1`,
        [instanceName]
      );
      console.warn(`[CONFLICT] ${instanceName} — auto-reconnecting in 4s...`);
      reconnectInstance(instanceName); // fire-and-forget, don't await
    }
    return;
  }

  // ---- MESSAGES ----
  if (body.event !== 'messages.upsert') return;

  // Evo sends both array form and flat form — handle both
  let msg = body.data?.messages?.[0];
  if (!msg && body.data?.key) msg = body.data;

  // Hard filters — drop immediately
  if (!msg?.key) return;
  if (msg.key.fromMe === true) return;           // outgoing — our own reply, skip
  if (!msg.message) return;                       // no message body (status updates, etc.)
  if (msg.messageStubType) return;               // system messages (e.g. group join)

  const remoteJid = msg.key.remoteJid || '';
  const isGroup = remoteJid.endsWith('@g.us');

  const uniqueKey = `${instanceName}_${msg.key.id}`;
  if (processed.has(uniqueKey)) return;
  processed.add(uniqueKey);
  setTimeout(() => processed.delete(uniqueKey), 30000);

  // sendJid = reply destination (group JID for groups, user JID for DMs)
  const sendJid = remoteJid;

  // Evo v2.3.7 puts group sender in multiple possible places
  const senderJid = isGroup
    ? (msg.key.participant || msg.participant || body.data?.participant || '')
    : resolveJid(msg.key);

  // For groups with no participant — skip (bot's own message echoed back)
  if (isGroup && !senderJid) return;

  const realJid = senderJid || resolveJid(msg.key);
  const number = jidToNumber(realJid);
  // LID mode: remoteJid is a LID (@lid), real phone is in body.sender sent by Evo
  const senderPhone = jidToNumber(body.sender || '');
  const userId = (number && number.length >= 10 && !isLid(realJid))
    ? number
    : (senderPhone && senderPhone.length >= 10 ? senderPhone : jidToNumber(remoteJid));

  if (!userId || userId.length < 5) return;

  console.log(`[MSG] ${isGroup ? 'GROUP' : 'DM'} userId=${userId} sendJid=${sendJid} sender=${senderJid}`);

  // SESSION LOCK — lock per userId
  const existing = phoneSessions.get(userId);
  if (!existing || Date.now() > existing.expiresAt) {
    phoneSessions.set(userId, { instance: instanceName, expiresAt: Date.now() + 30 * 60 * 1000 });
  }
  const session = phoneSessions.get(userId);
  if (!ALLOWED_NUMBERS.has(userId) && session.instance !== instanceName && Date.now() < session.expiresAt) return;

  // Extract text or detect audio
  const m = msg.message || {};
  let text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title;

  // Detect voice note / audio message
  const isAudio = !!(m.audioMessage || m.pttMessage);
  const audioUrl = isAudio
    ? `${process.env.EVO_URL}/chat/getBase64FromMediaMessage/${instanceName}`
    : null;

  if (!text?.trim() && !isAudio) return;

  // Check expiry
  const db = await pool.query(
    `SELECT expires_at FROM instances WHERE instance_name = $1`,
    [instanceName]
  );
  if (!db.rows.length) return;

  const expiry = new Date(db.rows[0].expires_at);
  if (!ALLOWED_NUMBERS.has(userId) && Date.now() > expiry.getTime()) {
    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${instanceName}`,
      { number: sendJid, text: 'Session khatam bhai 😅 — nayi QR generate karo aur wapas aao!' },
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
    );
    return;
  }

  // Enqueue per-user — prevents parallel AI calls racing / wasting tokens
  await enqueue(userId, async () => {

    // ---- VOICE NOTE PIPELINE ----
    if (isAudio) {
      console.log(`[VOICE] Received audio from userId=${userId}`);
      // Fetch base64 audio from Evo then transcribe
      let transcript = null;
      try {
        const b64Res = await axios.post(
          `${process.env.EVO_URL}/chat/getBase64FromMediaMessage/${instanceName}`,
          { message: msg },
          { headers: { apikey: process.env.EVO_API_KEY }, timeout: 15000 }
        );
        const b64 = b64Res.data?.base64 || b64Res.data?.media;
        if (b64) {
          const FormData = require('form-data');
          const form = new FormData();
          const audioBuffer = Buffer.from(b64, 'base64');
          form.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
          form.append('model', 'whisper-large-v3-turbo');
          form.append('response_format', 'text');
          const keys = getGroqKeys();
          const key = pickGroqKey(keys);
          const transcriptRes = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            form,
            { headers: { ...form.getHeaders(), Authorization: `Bearer ${key}` }, timeout: 30000 }
          );
          transcript = typeof transcriptRes.data === 'string'
            ? transcriptRes.data.trim()
            : transcriptRes.data?.text?.trim();
          console.log(`[VOICE→TEXT] "${transcript}"`);
        }
      } catch (err) {
        console.error('[TRANSCRIBE ERROR]', err.response?.data || err.message);
      }

      if (!transcript) {
        // Transcription failed — tell user in text
        await axios.post(
          `${process.env.EVO_URL}/message/sendText/${instanceName}`,
          { number: sendJid, text: 'Yaar audio clear nahi tha 😅 — text mein bhej!' },
          { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
        );
        return;
      }

      // Get AI reply for transcribed text
      const aiReply = await askAI(userId, `[Voice message]: ${transcript}`);

      // Try TTS → send as voice note; fall back to text if TTS fails
      const audioReplyBuffer = await textToSpeech(aiReply);
      if (audioReplyBuffer) {
        await sendAudioReply(instanceName, sendJid, audioReplyBuffer);
      } else {
        await axios.post(
          `${process.env.EVO_URL}/message/sendText/${instanceName}`,
          { number: sendJid, text: aiReply },
          { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
        );
      }
      return;
    }

    // ---- TEXT PIPELINE (unchanged) ----
    text = text.trim();
    const reply = await askAI(userId, text);
    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${instanceName}`,
      { number: sendJid, text: reply },
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
    );
  });
}

// ---------------- WEBHOOK ROUTES ----------------
// Respond 200 immediately — prevents Evo retry storm & 429s on this server
const wh = (req, res) => {
  res.sendStatus(200);
  handleWebhook(req.body).catch(e => console.error('[WH ERROR]', e.message));
};

app.post('/webhook', wh);
app.post('/webhook/messages-upsert', wh);
app.post('/webhook/messages-update', wh);
app.post('/webhook/chats-upsert', wh);
app.post('/webhook/qrcode-updated', wh);
app.post('/webhook/connection-update', wh);
app.post('/webhook/contacts-update', wh);
app.post('/webhook/presence-update', wh);

// ---------------- CLEANUP ----------------
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of phoneSessions.entries()) {
    if (now > v.expiresAt) phoneSessions.delete(k);
  }
}, 5 * 60 * 1000);

// ---------------- PURGE ----------------
setInterval(async () => {
  try {
    const res = await pool.query(
      `SELECT instance_name FROM instances WHERE expires_at < NOW() OR status = 'dead'`
    );
    for (const row of res.rows) await deleteInstance(row.instance_name);
    await pool.query(`DELETE FROM instances WHERE expires_at < NOW() OR status = 'dead'`);
    console.log(`[PURGE] Cleaned ${res.rows.length} instances`);
  } catch (err) {
    console.error('[PURGE ERROR]', err.message);
  }
}, 60 * 60 * 1000);

// ---------------- RECONNECT (called after conflict/replaced) ----------------
async function reconnectInstance(instanceName) {
  try {
    // Give WA 4 seconds to fully drop the old session
    await new Promise(r => setTimeout(r, 4000));
    await axios.delete(
      `${process.env.EVO_URL}/instance/logout/${instanceName}`,
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    await axios.get(
      `${process.env.EVO_URL}/instance/connect/${instanceName}`,
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
    );
    console.log(`[RECONNECT] ✅ ${instanceName} reconnected`);
  } catch (err) {
    console.error(`[RECONNECT] ❌ ${instanceName}:`, err.message);
  }
}

// ---------------- HEALTH ----------------
app.get('/health', (_, res) => res.send('VAYU LIVE 🚀'));

// ---------------- GRACEFUL SHUTDOWN ----------------
// Prevents Render deploy overlap from leaving zombie connections
let server;
async function shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received — closing gracefully`);
  if (server) server.close(() => console.log('[SHUTDOWN] HTTP server closed'));
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ---------------- START ----------------
migrate().then(() => {
  server = app.listen(process.env.PORT || 3000, () => console.log('SERVER LIVE 🔥'));
});

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
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ---------------- IN-MEMORY (dedup + session lock) ----------------
const processed = new Set();
const phoneSessions = new Map();

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

// ---------------- PERSONA ----------------
const SYSTEM_PROMPT = `You are Dhrub. AI, automation, content & PR guy. Hinglish with friends, sharp with suits. Multilingual — mirror the user's language. Dry humor, zero fluff. Max 3 punchy paras. End with a question or a TODAY action.`;

// ---------------- AI ----------------
async function askAI(userId, text) {
  const history = await getHistory(userId);
  const messages = [
    { role: "user", content: SYSTEM_PROMPT },
    { role: "assistant", content: "Got it — I'm Dhrub. Let's build." },
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
        max_tokens: 400,
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        timeout: 15000,
      }
    );

    const reply = res.data.choices[0].message.content;
    await saveMessage(userId, "user", text);
    await saveMessage(userId, "assistant", reply);
    return reply;
  } catch (err) {
    console.error("AI ERROR:", err.response?.data || err.message);
    return "zzz 😴";
  }
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
      { instanceName, integration: 'WHATSAPP-BAILEYS', qrcode: true },
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

  // Group messages — skip (only handle DMs)
  const remoteJid = msg.key.remoteJid || '';
  if (remoteJid.endsWith('@g.us')) return;

  const uniqueKey = `${instanceName}_${msg.key.id}`;
  if (processed.has(uniqueKey)) return;
  processed.add(uniqueKey);
  setTimeout(() => processed.delete(uniqueKey), 30000);

  // sendJid = what we use to reply (original remoteJid — Evo resolves LID internally)
  const sendJid = remoteJid;
  // realJid = resolved for phone number extraction
  const realJid = resolveJid(msg.key);
  const number = jidToNumber(realJid);

  // LID fallback: use body.sender (instance owner JID) is WRONG for user identity
  // Instead use the LID itself as a stable key — consistent per user across sessions
  const userId = (number && !isLid(realJid)) ? number : jidToNumber(sendJid);

  if (!userId || userId.length < 5) return;

  console.log(`[MSG] userId=${userId} sendJid=${sendJid} realJid=${realJid}`);

  // SESSION LOCK — lock per userId
  const existing = phoneSessions.get(userId);
  if (!existing || Date.now() > existing.expiresAt) {
    phoneSessions.set(userId, { instance: instanceName, expiresAt: Date.now() + 30 * 60 * 1000 });
  }
  const session = phoneSessions.get(userId);
  if (!ALLOWED_NUMBERS.has(userId) && session.instance !== instanceName && Date.now() < session.expiresAt) return;

  // Extract text
  const m = msg.message || {};
  let text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title;

  if (!text?.trim()) return;
  text = text.trim();

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

  const reply = await askAI(userId, text);
  await axios.post(
    `${process.env.EVO_URL}/message/sendText/${instanceName}`,
    { number: sendJid, text: reply },
    { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
  );
}

// ---------------- WEBHOOK ROUTES ----------------
const wh = async (req, res) => {
  try { await handleWebhook(req.body); } catch (e) { console.error('[WH ERROR]', e.message); }
  res.sendStatus(200);
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

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const ALLOWED_NUMBERS = require('./exceptionNumbers');
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
// ---------------- DATABASE ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
// ---------------- MEMORY (only for dedup — safe to lose on restart) ----------------
const processed = new Set();
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
      content: `YOUR ORIGINAL SYSTEM PROMPT (UNCHANGED)`
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
        temperature: 0.9,
        max_tokens: 400
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        timeout: 15000
      }
    );
    const reply = res.data.choices[0].message.content;
    await saveMessage(userId, "user", text);
    await saveMessage(userId, "assistant", reply);
    return reply;
  } catch (err) {
    console.error("AI ERROR:", err.response?.data || err.message);
    return "bol na, sun raha hoon 🙂";
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
    const status = err.response?.status;
    if (status !== 404) {
      console.error(`[CLEANUP] Failed to delete ${instanceName}:`, err.response?.data || err.message);
    }
  }
}
// ---------------- DB MIGRATION ----------------
async function migrate() {
  await pool.query(`
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'
  `).catch(() => {});
  await pool.query(`
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS qr_count INTEGER DEFAULT 0
  `).catch(() => {});
  await pool.query(`
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS qr_base64 TEXT
  `).catch(() => {});
}
// ---------------- CREATE INSTANCE ----------------
app.post('/create-instance', async (req, res) => {
  try {
    let { userId } = req.body;
    userId = (userId || '').toString().replace(/[^0-9]/g, "");
    if (!userId) return res.status(400).json({ error: "userId required" });
    // Check DB for existing instance
    const dbCheck = await pool.query(
      `SELECT instance_name, status, expires_at FROM instances WHERE id = $1`,
      [userId]
    );
    if (dbCheck.rows.length) {
      const row = dbCheck.rows[0];
      const notExpired = new Date(row.expires_at) > new Date();
      if (row.status === 'connected' && notExpired) {
        // Verify it's actually alive on Evo
        try {
          const statusRes = await axios.get(
            `${process.env.EVO_URL}/instance/connectionState/${row.instance_name}`,
            { headers: { apikey: process.env.EVO_API_KEY }, timeout: 8000 }
          );
          if (statusRes.data?.instance?.state === 'open') {
            return res.json({ success: true, instance: row.instance_name, reused: true });
          }
        } catch (_) {}
        // Not alive — delete and recreate
        await deleteInstance(row.instance_name);
      } else if (notExpired && row.status !== 'connected') {
        // Stale/pending — delete and recreate
        await deleteInstance(row.instance_name);
      } else if (!notExpired) {
        // Expired
        await deleteInstance(row.instance_name);
      }
    }
    const instanceName = `vayu_${userId}_${Date.now()}`;
    const isPermanent = ALLOWED_NUMBERS.has(userId);
    // 1 year for allowed numbers, 1 hour for everyone else
    const expiry = isPermanent
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 60 * 60 * 1000);
    const evo = await axios.post(
      `${process.env.EVO_URL}/instance/create`,
      { instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true },
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
    res.json({
      success: true,
      instance: instanceName,
      qr: initialQr,
      expires: expiry
    });
  } catch (err) {
    console.error("CREATE ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Instance creation failed" });
  }
});
// ---------------- GET QR (reads from DB — survives restarts) ----------------
app.get('/get-qr/:instance', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT qr_base64, status FROM instances WHERE instance_name = $1`,
      [req.params.instance]
    );
    if (!result.rows.length) return res.json({ ready: false, qr: null });
    const { qr_base64, status } = result.rows[0];
    if (status === 'connected') return res.json({ ready: true, connected: true, qr: null });
    res.json({ ready: !!qr_base64, qr: qr_base64 || null });
  } catch (err) {
    res.json({ ready: false, qr: null });
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
    res.json(result.rows[0]);
  } catch (err) {
    res.json({ status: 'error' });
  }
});
// ---------------- WEBHOOK HANDLER ----------------
const QR_LIMIT = 5;
// ---- HELPER: resolve real JID from LID addressing mode ----
// WhatsApp's new LID mode sends a privacy-preserving numeric ID instead of
// the real phone JID. remoteJidAlt holds the actual phone JID in that case.
function resolveJid(key) {
  if (key.addressingMode === 'lid' && key.remoteJidAlt) {
    return key.remoteJidAlt; // e.g. "919874076688@s.whatsapp.net"
  }
  return key.remoteJid; // e.g. "919874076688@s.whatsapp.net"
}
// Extract bare phone number from a JID
function jidToNumber(jid) {
  return (jid || '').replace(/@.*$/, '').replace(/[^0-9]/g, '');
}
async function handleWebhook(body) {
  const instanceName = body.instance;
  if (!instanceName) return;
  // ---- QR UPDATED ----
  if (body.event === "qrcode.updated") {
    const qr = body.data?.qrcode?.base64 || body.data?.qrcode;
    const result = await pool.query(
      `UPDATE instances
       SET qr_count = COALESCE(qr_count, 0) + 1,
           qr_base64 = $2
       WHERE instance_name = $1
       RETURNING qr_count`,
      [instanceName, qr || null]
    );
    const count = result.rows[0]?.qr_count || 0;
    console.log(`[QR] ${instanceName} count=${count}`);
    if (count > QR_LIMIT) {
      console.warn(`[QR LIMIT] ${instanceName} hit limit — deleting.`);
      await deleteInstance(instanceName);
      await pool.query(
        `UPDATE instances SET status='dead', qr_base64=NULL WHERE instance_name=$1`,
        [instanceName]
      );
    }
    return;
  }
  // ---- CONNECTION UPDATE ----
  if (body.event === "connection.update") {
    const state = body.data?.state;
    if (state === 'open') {
      await pool.query(
        `UPDATE instances SET status='connected', qr_count=0, qr_base64=NULL
         WHERE instance_name=$1`,
        [instanceName]
      );
      console.log(`[CONNECTED] ${instanceName}`);
    } else if (state === 'close') {
      await pool.query(
        `UPDATE instances SET status='disconnected' WHERE instance_name=$1`,
        [instanceName]
      );
      console.log(`[DISCONNECTED] ${instanceName}`);
    }
    return;
  }
  // ---- MESSAGES ----
  if (body.event !== "messages.upsert") return;
  let msg = body.data?.messages?.[0];
  if (!msg && body.data?.key) msg = body.data;
  if (!msg?.key || msg.key.fromMe) return;
  const uniqueKey = `${instanceName}_${msg.key.id}`;
  if (processed.has(uniqueKey)) return;
  processed.add(uniqueKey);
  setTimeout(() => processed.delete(uniqueKey), 30000);
  // ---- FIX: resolve real JID (handles LID addressing mode) ----
  const realJid = resolveJid(msg.key);
  const number = jidToNumber(realJid);
  if (!number) return;
  console.log(`[MSG] from=${number} jid=${realJid} mode=${msg.key.addressingMode || 'normal'}`);
  // SESSION LOCK — prevent same user being handled by multiple instances
  const existing = phoneSessions.get(number);
  if (!existing || Date.now() > existing.expiresAt) {
    phoneSessions.set(number, {
      instance: instanceName,
      expiresAt: Date.now() + 30 * 60 * 1000
    });
  }
  const session = phoneSessions.get(number);
  if (
    !ALLOWED_NUMBERS.has(number) &&
    session.instance !== instanceName &&
    Date.now() < session.expiresAt
  ) return;
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
  // Check instance expiry
  const db = await pool.query(
    `SELECT expires_at FROM instances WHERE instance_name = $1`,
    [instanceName]
  );
  if (!db.rows.length) return;
  const expiry = new Date(db.rows[0].expires_at);
  if (!ALLOWED_NUMBERS.has(number) && Date.now() > expiry.getTime()) {
    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${instanceName}`,
      { number, text: "Session expired. Generate a new QR to continue." },
      { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
    );
    return;
  }
  const reply = await askAI(number, text);
  await axios.post(
    `${process.env.EVO_URL}/message/sendText/${instanceName}`,
    { number, text: reply },
    { headers: { apikey: process.env.EVO_API_KEY }, timeout: 10000 }
  );
}
// ---------------- WEBHOOK ROUTES ----------------
const wh = async (req, res) => {
  try { await handleWebhook(req.body); } catch (e) { console.error("[WH ERROR]", e.message); }
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
// ---------------- CLEANUP (in-memory) ----------------
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of phoneSessions.entries()) {
    if (now > v.expiresAt) phoneSessions.delete(k);
  }
}, 5 * 60 * 1000);
// ---------------- PURGE (DB + Evo) ----------------
// Runs every hour — cleans dead/expired instances from both DB and Evo
setInterval(async () => {
  try {
    const res = await pool.query(
      `SELECT instance_name FROM instances WHERE expires_at < NOW() OR status = 'dead'`
    );
    for (const row of res.rows) {
      await deleteInstance(row.instance_name);
    }
    await pool.query(
      `DELETE FROM instances WHERE expires_at < NOW() OR status = 'dead'`
    );
    console.log(`[PURGE] Cleaned ${res.rows.length} instances`);
  } catch (err) {
    console.error("[PURGE ERROR]", err.message);
  }
}, 60 * 60 * 1000);
// ---------------- HEALTH ----------------
app.get('/', (req, res) => res.send("VAYU LIVE"));
// ---------------- START ----------------
migrate().then(() => {
  app.listen(process.env.PORT || 3000, () => console.log("SERVER LIVE"));
});

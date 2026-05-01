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
  max: 2
});

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
    console.error("AI ERROR:", err.response?.data || err.message);
    return "bol na, sun raha hoon 🙂";
  }
}

// ---------------- STATE ----------------
const activeSessions = new Map();
const phoneSessions = new Map();
const qrStore = new Map();
const processed = new Set();

// Track QR count per instance to detect stuck sessions
const qrCounts = new Map();
const QR_LIMIT = 5; // if QR regenerates more than this, kill & recreate

// ---------------- DELETE STALE INSTANCE FROM EVO ----------------
async function deleteInstance(instanceName) {
  try {
    await axios.delete(
      `${process.env.EVO_URL}/instance/delete/${instanceName}`,
      { headers: { apikey: process.env.EVO_API_KEY } }
    );
    console.log(`[CLEANUP] Deleted stale instance: ${instanceName}`);
  } catch (err) {
    console.error(`[CLEANUP] Failed to delete ${instanceName}:`, err.response?.data || err.message);
  }
}

// ---------------- CREATE INSTANCE ----------------
app.post('/create-instance', async (req, res) => {
  try {
    let { userId } = req.body;
    userId = (userId || '').toString().replace(/[^0-9]/g, "");

    // Check DB for existing connected instance
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
            { headers: { apikey: process.env.EVO_API_KEY } }
          );
          const state = statusRes.data?.instance?.state;
          if (state === 'open') {
            activeSessions.set(userId, {
              instance: row.instance_name,
              expiresAt: new Date(row.expires_at).getTime()
            });
            return res.json({ success: true, instance: row.instance_name, reused: true });
          }
        } catch (_) {}
        // If not alive, fall through and recreate
        await deleteInstance(row.instance_name);
      } else if (notExpired && row.status !== 'connected') {
        // Stale connecting instance — clean it up
        await deleteInstance(row.instance_name);
      }
    }

    // Also clean up in-memory session if stale
    const existing = activeSessions.get(userId);
    if (existing) {
      activeSessions.delete(userId);
      qrCounts.delete(existing.instance);
      qrStore.delete(existing.instance);
    }

    const instanceName = `vayu_${userId}_${Date.now()}`;
    const isPermanent = ALLOWED_NUMBERS.has(userId);
    const expiry = isPermanent
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 60 * 60 * 1000);

    const evo = await axios.post(
      `${process.env.EVO_URL}/instance/create`,
      {
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true
      },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );

    await pool.query(
      `INSERT INTO instances (id, instance_name, status, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id)
       DO UPDATE SET instance_name=$2, status=$3, expires_at=$4`,
      [userId, instanceName, 'pending', expiry]
    );

    activeSessions.set(userId, {
      instance: instanceName,
      expiresAt: Date.now() + 60 * 60 * 1000
    });

    qrCounts.set(instanceName, 0);

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

// ---------------- QR ----------------
app.get('/get-qr/:instance', (req, res) => {
  const qr = qrStore.get(req.params.instance);
  res.json({ ready: !!qr, qr: qr || null });
});

// ---------------- COMMON WEBHOOK HANDLER ----------------
async function handleWebhook(body) {
  // QR updates — track count, kill if stuck
  if (body.event === "qrcode.updated") {
    const qr = body.data?.qrcode?.base64 || body.data?.qrcode;
    if (qr) qrStore.set(body.instance, qr);

    const count = (qrCounts.get(body.instance) || 0) + 1;
    qrCounts.set(body.instance, count);

    if (count > QR_LIMIT) {
      console.warn(`[QR LIMIT] Instance ${body.instance} exceeded ${QR_LIMIT} QR codes — deleting.`);
      await deleteInstance(body.instance);
      qrCounts.delete(body.instance);
      qrStore.delete(body.instance);

      // Mark as dead in DB so next /create-instance rebuilds fresh
      await pool.query(
        `UPDATE instances SET status='dead' WHERE instance_name=$1`,
        [body.instance]
      );
    }
    return;
  }

  // Mark instance as connected once stable
  if (body.event === "connection.update") {
    const state = body.data?.state;
    if (state === 'open') {
      await pool.query(
        `UPDATE instances SET status='connected' WHERE instance_name=$1`,
        [body.instance]
      );
      qrCounts.delete(body.instance); // reset — successfully connected
      console.log(`[CONNECTED] ${body.instance}`);
    } else if (state === 'close') {
      await pool.query(
        `UPDATE instances SET status='disconnected' WHERE instance_name=$1`,
        [body.instance]
      );
      console.log(`[DISCONNECTED] ${body.instance}`);
    }
    return;
  }

  // ONLY process real incoming messages
  if (body.event !== "messages.upsert") return;

  const msg = body.data?.messages?.[0];
  if (!msg?.key) return;
  if (msg.key.fromMe) return;

  const uniqueKey = `${body.instance}_${msg.key.id}`;
  if (processed.has(uniqueKey)) return;
  processed.add(uniqueKey);
  setTimeout(() => processed.delete(uniqueKey), 30000);

  const number = (msg.key.remoteJid || '').replace(/[^0-9]/g, "");

  // SESSION LOCK
  const existing = phoneSessions.get(number);
  if (!existing || Date.now() > existing.expiresAt) {
    phoneSessions.set(number, {
      instance: body.instance,
      expiresAt: Date.now() + 30 * 60 * 1000
    });
  }

  const session = phoneSessions.get(number);
  if (
    !ALLOWED_NUMBERS.has(number) &&
    session.instance !== body.instance &&
    Date.now() < session.expiresAt
  ) return;

  const m = msg.message || {};
  let text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title;

  if (!text) return;
  text = text.trim();

  const db = await pool.query(
    'SELECT expires_at FROM instances WHERE instance_name = $1',
    [body.instance]
  );
  if (!db.rows.length) return;

  const expiry = new Date(db.rows[0].expires_at);
  if (!ALLOWED_NUMBERS.has(number) && Date.now() > expiry.getTime()) {
    await axios.post(
      `${process.env.EVO_URL}/message/sendText/${body.instance}`,
      { number, text: "Session expired. Generate new QR to continue." },
      { headers: { apikey: process.env.EVO_API_KEY } }
    );
    return;
  }

  const reply = await askAI(number, text);
  await axios.post(
    `${process.env.EVO_URL}/message/sendText/${body.instance}`,
    { number, text: reply },
    { headers: { apikey: process.env.EVO_API_KEY } }
  );
}

// ---------------- WEBHOOK ROUTES ----------------
app.post('/webhook', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});
app.post('/webhook/messages-upsert', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});
app.post('/webhook/messages-update', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});
app.post('/webhook/chats-upsert', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});
app.post('/webhook/qrcode-updated', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});
app.post('/webhook/connection-update', async (req, res) => {
  await handleWebhook(req.body);
  res.sendStatus(200);
});

// ---------------- DB MIGRATION (run once on start) ----------------
async function migrate() {
  await pool.query(`
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'
  `).catch(() => {});
}

// ---------------- CLEANUP ----------------
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of activeSessions.entries()) {
    if (now > v.expiresAt) activeSessions.delete(k);
  }
  for (const [k, v] of phoneSessions.entries()) {
    if (now > v.expiresAt) phoneSessions.delete(k);
  }
}, 5 * 60 * 1000);

// Nightly purge of dead/expired instances from Evo
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
    console.log(`[PURGE] Cleaned ${res.rows.length} expired instances`);
  } catch (err) {
    console.error("[PURGE ERROR]", err.message);
  }
}, 60 * 60 * 1000); // every hour

// ---------------- HEALTH ----------------
app.get('/', (req, res) => res.send("VAYU LIVE"));

// ---------------- START ----------------
migrate().then(() => {
  app.listen(process.env.PORT || 3000, () => console.log("SERVER LIVE"));
});

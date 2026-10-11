'use strict';

const express = require('express');
const pino = require('pino');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  delay,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '.data'));
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars; 50 bits for 10-char tokens
const lookupAttempts = new Map();

function lookupRateLimited(ip) {
  const now = Date.now();
  const key = String(ip || 'unknown');
  const recent = (lookupAttempts.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 20) { lookupAttempts.set(key, recent); return true; }
  recent.push(now); lookupAttempts.set(key, recent);
  if (lookupAttempts.size > 5000) {
    for (const [k, times] of lookupAttempts) if (!times.some((t) => now - t < 60_000)) lookupAttempts.delete(k);
  }
  return false;
}

function origins() {
  return String(process.env.CORS_ORIGIN || 'https://dilshan-pairsite.pages.dev')
    .split(',').map((v) => v.trim().replace(/\/$/, '')).filter(Boolean);
}
function applyCors(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const allowed = origins();
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return !origin || allowed.includes('*') || allowed.includes(origin);
}
app.use((req, res, next) => {
  if (req.path.startsWith('/api/pair') || req.path === '/api/health') {
    if (!applyCors(req, res)) return res.status(403).json({ error: 'Origin not allowed. Check CORS_ORIGIN.' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function validToken(token) { return /^[A-HJ-NP-Z2-9]{10}$/.test(String(token || '')); }
function sendEvent(res, payload) {
  if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
async function makeToken() {
  for (let i = 0; i < 20; i++) {
    const bytes = crypto.randomBytes(10);
    let token = '';
    for (const b of bytes) token += ALPHABET[b % ALPHABET.length];
    try { await fs.access(path.join(SESSION_DIR, token)); }
    catch { return token; }
  }
  throw new Error('Could not generate a unique session token.');
}
async function copyAuthToPersistentStorage(tempFolder, token) {
  const credsText = await fs.readFile(path.join(tempFolder, 'creds.json'), 'utf8');
  const creds = JSON.parse(credsText);
  if (!creds || creds.registered !== true) throw new Error('WhatsApp credentials are not marked registered.');
  const destination = path.join(SESSION_DIR, token);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(tempFolder, destination, { recursive: true, force: true });
  // Verify full multi-file auth, not only creds.json.
  const files = await listJsonFiles(destination);
  if (!files.some((f) => f.relativePath === 'creds.json') || files.length < 1) {
    await fs.rm(destination, { recursive: true, force: true });
    throw new Error('Auth files could not be persisted.');
  }
  return destination;
}
async function listJsonFiles(directory, relative = '') {
  const out = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const rel = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...await listJsonFiles(absolute, rel));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push({ absolutePath: absolute, relativePath: rel });
  }
  return out;
}

app.get('/api/health', async (_req, res) => {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.access(SESSION_DIR, fsSync.constants.R_OK | fsSync.constants.W_OK);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'dilshan-md-pair-api-file-storage', storage: 'persistent-files', database: false });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Persistent session storage is not writable.' });
  }
});

app.post('/api/pair/start', async (req, res) => {
  const number = String(req.body?.number ?? '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) return res.status(400).json({ error: 'Enter a valid WhatsApp number with country code (8–15 digits).' });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let socket;
  let folder = '';
  let finished = false;
  let codeRequested = false;
  let openedHandled = false;
  let generation = 0;
  let heartbeat;
  let timeout;
  let token = '';

  const cleanupTemp = async () => {
    if (heartbeat) clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
    try { socket?.end(undefined); } catch {}
    try { socket?.ws?.close(); } catch {}
    if (folder) await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  };
  const finish = async (payload) => {
    if (finished) return;
    finished = true;
    if (payload) sendEvent(res, payload);
    await cleanupTemp();
    if (!res.writableEnded) res.end();
  };
  const fail = (message) => { void finish({ status: 'failed', error: message }); };
  const onClientClose = () => {
    if (!finished) {
      finished = true;
      void cleanupTemp();
    }
  };
  res.on('close', onClientClose);

  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    sendEvent(res, { status: 'pending', message: 'Starting WhatsApp connection…' });
    heartbeat = setInterval(() => sendEvent(res, { status: 'pending', message: 'Waiting for WhatsApp…' }), 12000);
    timeout = setTimeout(() => fail('Pairing timed out. Please try again and link the device promptly.'), 270000);
    folder = await fs.mkdtemp(path.join(DATA_DIR, '.pending-pair-'));
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const logger = pino({ level: 'silent' });
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (err) {
      console.warn('[pair] latest version lookup failed; using library default:', err?.message || err);
    }

    const createSocket = (requestCode) => {
      const current = ++generation;
      const sock = makeWASocket({ ...(version ? { version } : {}), auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false, connectTimeoutMs: 60000, keepAliveIntervalMs: 10000 });
      socket = sock;
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', async (update) => {
        if (finished || current !== generation) return;
        if (update.qr && requestCode && !codeRequested && !state.creds.registered) {
          codeRequested = true;
          try {
            await delay(1000);
            let rawCode = '';
            let lastError;
            for (let i = 0; i < 3; i++) {
              try { rawCode = await sock.requestPairingCode(number); break; }
              catch (err) { lastError = err; if (i < 2) await delay(1500); }
            }
            if (!rawCode) throw lastError || new Error('No pairing code was returned.');
            sendEvent(res, { status: 'code', code: rawCode.match(/.{1,4}/g)?.join('-') || rawCode });
          } catch (err) {
            console.error('[pair] pairing code failed:', err?.message || err);
            fail('Could not generate a pairing code. Check the number and try again.');
          }
        }
        if (update.connection === 'open' && !openedHandled) {
          openedHandled = true;
          try {
            await delay(1800);
            token = await makeToken();
            await copyAuthToPersistentStorage(folder, token);

            const ownId = sock.user?.id || state.creds?.me?.id;
            const selfJid = ownId ? jidNormalizedUser(ownId) : '';
            let sessionMessageSent = false;
            if (selfJid) {
              const intro = ['✅ *DILSHAN MD — DEVICE LINKED*', '', 'Your WhatsApp device has been linked successfully.', 'Your session is saved securely and ready for activation.', '', 'Keep the next message private.'].join('\n');
              const activation = ['🚀 *ACTIVATE YOUR BOT*', '', 'To activate DILSHAN MD, contact the activation team:', 'https://wa.me/94741933159', '', 'Never share your Session ID publicly.'].join('\n');
              try {
                const m1 = await sock.sendMessage(selfJid, { text: intro });
                await delay(500);
                const m2 = await sock.sendMessage(selfJid, { text: token }); // Message 2 is only the 10-character ID.
                await delay(500);
                const m3 = await sock.sendMessage(selfJid, { text: activation });
                await delay(900);
                sessionMessageSent = Boolean(m1?.key?.id && m2?.key?.id && m3?.key?.id);
              } catch (err) {
                console.error('[pair] self-message delivery failed:', err?.message || err);
              }
            } else {
              console.error('[pair] self-chat JID missing; token still stored server-side');
            }
            // Sync any key updates caused by sending messages, then close the pairing socket.
            await delay(500);
            await copyAuthToPersistentStorage(folder, token);
            await finish({ status: 'connected', sessionId: token, sessionIdLength: 10, sessionMessageSent });
          } catch (err) {
            console.error('[pair] linked but failed to store full auth files:', err?.stack || err?.message || err);
            fail('WhatsApp linked, but session files could not be saved. Check persistent disk settings.');
          }
        }
        if (update.connection === 'close') {
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          if (statusCode === DisconnectReason.restartRequired && !openedHandled) {
            await delay(500);
            if (!finished) createSocket(false);
          } else if (!openedHandled) {
            console.error('[pair] connection closed before open:', statusCode);
            fail('WhatsApp connection closed before linking finished. Please try again.');
          }
        }
      });
      return sock;
    };
    createSocket(true);
  } catch (err) {
    console.error('[pair] startup failed:', err?.stack || err?.message || err);
    fail('Could not start WhatsApp pairing. Check the API service logs and persistent disk.');
  }
});

// Bot-to-API bridge: retrieve the COMPLETE Baileys multi-file auth directory by 10-character token.
app.get('/api/session/:token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = String(req.params.token || '');
  if (!validToken(token)) return res.status(400).json({ error: 'Invalid session token format.' });
  // The 10-character random token is a bearer credential. Rate-limit lookup attempts.
  if (lookupRateLimited(req.ip || req.socket?.remoteAddress)) return res.status(429).json({ error: 'Too many session lookups. Wait one minute and retry.' });
  try {
    const directory = path.join(SESSION_DIR, token);
    const files = await listJsonFiles(directory);
    if (!files.length) return res.status(404).json({ error: 'Session token was not found or has no saved auth files.' });
    const result = [];
    for (const file of files) {
      const data = await fs.readFile(file.absolutePath);
      result.push({ path: file.relativePath, data: data.toString('base64') });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, token, files: result });
  } catch (err) {
    if (err?.code === 'ENOENT') return res.status(404).json({ error: 'Session token not found.' });
    console.error('[session] read failed:', err?.stack || err?.message || err);
    res.status(500).json({ error: 'Could not read session files.' });
  }
});

app.get('/', (_req, res) => res.json({ service: 'DILSHAN-MD Pair API', storage: 'persistent files; no database', health: '/api/health' }));

(async () => {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.access(SESSION_DIR, fsSync.constants.R_OK | fsSync.constants.W_OK);
    app.listen(PORT, '0.0.0.0', () => console.log(`[server] DILSHAN-MD Pair API listening on ${PORT}; session storage=${SESSION_DIR}`));
  } catch (err) {
    console.error('Could not initialize persistent session storage:', err?.stack || err?.message || err);
    process.exit(1);
  }
})();

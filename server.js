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
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const lookupAttempts = new Map();

// WA_VERSION=2,3000,1030000000  (optional: fixes the WhatsApp Web version if latest fails)
function configuredVersion() {
  const raw = String(process.env.WA_VERSION || '').trim();
  if (!raw) return undefined;
  const parts = raw.split(',').map((n) => Number(n.trim()));
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : undefined;
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
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
function lookupRateLimited(ip) {
  const now = Date.now(), key = String(ip || 'unknown');
  const recent = (lookupAttempts.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 20) { lookupAttempts.set(key, recent); return true; }
  recent.push(now); lookupAttempts.set(key, recent);
  if (lookupAttempts.size > 5000) {
    for (const [k, times] of lookupAttempts) if (!times.some((t) => now - t < 60_000)) lookupAttempts.delete(k);
  }
  return false;
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
async function makeToken() {
  for (let i = 0; i < 20; i++) {
    const bytes = crypto.randomBytes(10);
    let token = '';
    for (const b of bytes) token += ALPHABET[b & 31];
    try { await fs.access(path.join(SESSION_DIR, token)); }
    catch (err) { if (err.code === 'ENOENT') return token; throw err; }
  }
  throw new Error('Could not generate a unique session token.');
}
async function persistAuth(tempFolder, token) {
  const creds = JSON.parse(await fs.readFile(path.join(tempFolder, 'creds.json'), 'utf8'));
  if (!creds || creds.registered !== true) throw new Error('WhatsApp credentials are not registered.');
  const destination = path.join(SESSION_DIR, token);
  const staging = `${destination}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await fs.cp(tempFolder, staging, { recursive: true, force: true });
  const files = await listJsonFiles(staging);
  if (!files.some((f) => f.relativePath === 'creds.json')) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new Error('Auth files were not persisted.');
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(staging, destination);
}

app.get('/api/health', async (_req, res) => {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.access(SESSION_DIR, fsSync.constants.R_OK | fsSync.constants.W_OK);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'dilshan-md-pair-api-file-storage', storage: process.env.DATA_DIR ? 'configured-filesystem' : 'local-filesystem', database: false });
  } catch {
    res.status(500).json({ ok: false, error: 'Session storage is not writable. Configure DATA_DIR and persistent disk.' });
  }
});

app.post('/api/pair/start', async (req, res) => {
  const number = String(req.body?.number ?? '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ error: 'Enter a valid WhatsApp number with country code (8–15 digits).' });
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let socket, folder = '', finished = false, codeRequested = false, openedHandled = false;
  let generation = 0, heartbeat, timeout;
  const cleanup = async () => {
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
    await cleanup();
    if (!res.writableEnded) res.end();
  };
  const fail = (message) => { console.error('[pair] FAILED:', message); void finish({ status: 'failed', error: message }); };
  res.on('close', () => {
    if (!finished) { finished = true; void cleanup(); }
  });

  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.mkdir(DATA_DIR, { recursive: true });
    sendEvent(res, { status: 'pending', message: 'Starting WhatsApp connection…' });
    heartbeat = setInterval(() => sendEvent(res, { status: 'pending', message: 'Waiting for WhatsApp…' }), 10000);
    timeout = setTimeout(() => fail('Pairing timed out. Please try again and link the device promptly.'), 270000);
    folder = await fs.mkdtemp(path.join(DATA_DIR, '.pending-pair-'));
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const logger = pino({ level: 'silent' });

    let version = configuredVersion();
    if (version) {
      console.log('[pair] using WA_VERSION from env:', version.join('.'));
    } else {
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
        console.log('[pair] using latest Baileys version:', version.join('.'), 'isLatest:', latest.isLatest);
      } catch (err) {
        console.warn('[pair] Baileys version lookup failed:', err?.message || err);
      }
    }

    const createSocket = (requestCode) => {
      const current = ++generation;
      console.log('[pair] creating socket, requestCode =', requestCode, 'gen =', current);
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        logger, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false, syncFullHistory: false,
        connectTimeoutMs: 60000, keepAliveIntervalMs: 10000,
      });
      socket = sock;
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', async (update) => {
        if (finished || current !== generation) return;
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        console.log('[pair] update:', JSON.stringify({
          connection: update.connection, qr: Boolean(update.qr), statusCode, registered: state.creds.registered,
        }));

        if (update.qr && requestCode && !codeRequested && !state.creds.registered) {
          codeRequested = true;
          try {
            await delay(500);
            let rawCode = '', lastError;
            for (let i = 0; i < 3; i++) {
              try { rawCode = await sock.requestPairingCode(number); break; }
              catch (err) { lastError = err; console.error('[pair] requestPairingCode attempt', i + 1, err?.message || err); if (i < 2) await delay(1000); }
            }
            if (!rawCode) throw lastError || new Error('No pairing code returned.');
            console.log('[pair] pairing code issued');
            sendEvent(res, { status: 'code', code: rawCode.match(/.{1,4}/g)?.join('-') || rawCode });
          } catch (err) {
            fail(`Could not generate a pairing code (${err?.message || 'unknown'}). Check the number and try again.`);
          }
        }

        if (update.connection === 'open' && !openedHandled) {
          openedHandled = true;
          console.log('[pair] connection open, saving session');
          try {
            await delay(1500);
            const token = await makeToken();
            await persistAuth(folder, token);
            const ownId = sock.user?.id || state.creds?.me?.id;
            const selfJid = ownId ? jidNormalizedUser(ownId) : '';
            let sessionMessageSent = false;
            if (selfJid) {
              try {
                const first = await sock.sendMessage(selfJid, { text: [
                  '✅ *DILSHAN MD — DEVICE LINKED*', '',
                  'Your WhatsApp device has been linked successfully.',
                  'Your session is saved and ready for activation.', '',
                  'Keep the next message private.',
                ].join('\n') });
                await delay(500);
                const second = await sock.sendMessage(selfJid, { text: token });
                await delay(500);
                const third = await sock.sendMessage(selfJid, { text: [
                  '🚀 *ACTIVATE YOUR BOT*', '',
                  'To activate DILSHAN MD, contact the activation team:',
                  'https://wa.me/94741933159', '',
                  'Never share your Session ID publicly.',
                ].join('\n') });
                await delay(800);
                sessionMessageSent = Boolean(first?.key?.id && second?.key?.id && third?.key?.id);
              } catch (err) { console.error('[pair] self-message failed:', err?.message || err); }
            }
            await persistAuth(folder, token);
            console.log('[pair] SUCCESS, token saved, sessionMessageSent =', sessionMessageSent);
            await finish({ status: 'connected', sessionId: token, sessionIdLength: 10, sessionMessageSent });
          } catch (err) {
            console.error('[pair] storing linked session failed:', err?.stack || err?.message || err);
            fail('WhatsApp linked, but session files could not be saved. Check persistent disk settings.');
          }
        }

        if (update.connection === 'close') {
          if (statusCode === DisconnectReason.restartRequired && !openedHandled) {
            // WhatsApp asks for a reconnect right after the code is accepted. Reuse the same creds.
            await delay(500);
            if (!finished) createSocket(false);
          } else if (!openedHandled) {
            fail(`WhatsApp connection closed before linking finished (code ${statusCode ?? 'unknown'}). Please try again.`);
          }
        }
      });
    };
    createSocket(true);
  } catch (err) {
    console.error('[pair] startup failed:', err?.stack || err?.message || err);
    fail('Could not start WhatsApp pairing. Check the API service logs and persistent disk.');
  }
});

app.get('/api/session/:token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, private');
  const token = String(req.params.token || '');
  if (!validToken(token)) return res.status(400).json({ error: 'Invalid session token format.' });
  if (lookupRateLimited(req.ip || req.socket?.remoteAddress)) {
    return res.status(429).json({ error: 'Too many session lookups. Wait one minute and retry.' });
  }
  try {
    const directory = path.join(SESSION_DIR, token);
    const files = await listJsonFiles(directory);
    if (!files.some((file) => file.relativePath === 'creds.json')) {
      return res.status(404).json({ error: 'Session token was not found or has no saved auth files.' });
    }
    const result = [];
    for (const file of files) {
      result.push({ path: file.relativePath, data: (await fs.readFile(file.absolutePath)).toString('base64') });
    }
    return res.json({ ok: true, token, files: result });
  } catch (err) {
    if (err?.code === 'ENOENT') return res.status(404).json({ error: 'Session token not found.' });
    console.error('[session] read failed:', err?.stack || err?.message || err);
    return res.status(500).json({ error: 'Could not read session files.' });
  }
});

app.get('/', (_req, res) => res.json({
  service: 'DILSHAN-MD Pair API',
  storage: 'persistent files; no database',
  health: '/api/health',
}));

module.exports = app;

if (require.main === module) {
  (async () => {
    try {
      await fs.mkdir(SESSION_DIR, { recursive: true });
      await fs.access(SESSION_DIR, fsSync.constants.R_OK | fsSync.constants.W_OK);
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`[server] DILSHAN-MD Pair API listening on ${PORT}; session storage=${SESSION_DIR}`);
      });
    } catch (err) {
      console.error('Could not initialize session storage:', err?.stack || err?.message || err);
      process.exit(1);
    }
  })();
                          }

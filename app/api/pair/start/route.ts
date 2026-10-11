import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveAuthFiles } from '../../../../lib/session-store';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  delay,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;


function configuredOrigins() {
  return (process.env.CORS_ORIGIN || 'https://dilshan-pairsite.pages.dev')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get('origin');
  const allowed = configuredOrigins();
  if (origin && (allowed.includes('*') || allowed.includes(origin.replace(/\/$/, '')))) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    headers.set('Access-Control-Max-Age', '600');
  }
  return headers;
}

function jsonError(request: Request, message: string, status: number) {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

export function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  const allow = configuredOrigins();
  if (origin && !allow.includes('*') && !allow.includes(origin.replace(/\/$/, ''))) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  if (!process.env.MONGODB_URI || (process.env.SESSION_LOOKUP_SECRET || '').length < 32) {
    return jsonError(request, 'Session storage is not configured. Set MONGODB_URI and a SESSION_LOOKUP_SECRET of at least 32 characters in Vercel, then redeploy.', 503);
  }
  const origin = request.headers.get('origin');
  const allow = configuredOrigins();
  if (origin && !allow.includes('*') && !allow.includes(origin.replace(/\/$/, ''))) {
    return jsonError(request, 'Origin is not allowed. Check CORS_ORIGIN in Vercel.', 403);
  }

  let body: { number?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError(request, 'Request body must be valid JSON.', 400);
  }
  const number = String(body.number ?? '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return jsonError(request, 'Enter a valid WhatsApp number with country code (8–15 digits).', 400);
  }

  const headers = corsHeaders(request);
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Connection', 'keep-alive');
  headers.set('X-Accel-Buffering', 'no');
  headers.set('Vary', 'Origin');

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let socket: ReturnType<typeof makeWASocket> | undefined;
      let folder = '';
      let finished = false;
      let codeRequested = false;
      let sessionMessageSent = false;
      let generation = 0;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const send = (payload: Record<string, unknown>) => {
        if (finished) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); }
        catch { /* client disconnected */ }
      };

      const finish = async (payload?: Record<string, unknown>) => {
        if (finished) return;
        finished = true;
        if (heartbeat) clearInterval(heartbeat);
        if (timeout) clearTimeout(timeout);
        if (payload) {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); } catch {}
        }
        try { socket?.end(undefined); } catch {}
        try { socket?.ws?.close(); } catch {}
        if (folder) {
          try { await rm(folder, { recursive: true, force: true }); } catch {}
        }
        try { controller.close(); } catch {}
      };

      const fail = (message: string) => { void finish({ status: 'failed', error: message }); };

      void (async () => {
        try {
          send({ status: 'pending', message: 'Starting WhatsApp connection…' });
          heartbeat = setInterval(() => send({ status: 'pending', message: 'Waiting for WhatsApp…' }), 15000);
          timeout = setTimeout(() => fail('Pairing timed out. Please try again and link the device promptly.'), 270000);
          folder = await mkdtemp(path.join(tmpdir(), `dilshan-pair-${randomBytes(5).toString('hex')}-`));
          const { state, saveCreds } = await useMultiFileAuthState(folder);
          const logger = pino({ level: 'silent' });
          let version: [number, number, number] | undefined;
          try {
            const latest = await fetchLatestBaileysVersion();
            version = latest.version as [number, number, number];
          } catch (error) {
            console.error('[pair] unable to fetch latest Baileys version:', error instanceof Error ? error.message : error);
          }

          const createSocket = (requestCode: boolean) => {
            const currentGeneration = ++generation;
            const sock = makeWASocket({
              ...(version ? { version } : {}),
              auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
              logger,
              printQRInTerminal: false,
              browser: Browsers.ubuntu('Chrome'),
              markOnlineOnConnect: false,
              syncFullHistory: false,
              connectTimeoutMs: 60000,
              keepAliveIntervalMs: 10000,
            });
            socket = sock;
            sock.ev.on('creds.update', saveCreds);
            sock.ev.on('connection.update', async (update) => {
              if (finished || currentGeneration !== generation) return;
              if (update.qr && requestCode && !codeRequested && !state.creds.registered) {
                codeRequested = true;
                try {
                  await delay(1000);
                  let rawCode = '';
                  let lastError: unknown;
                  for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                      rawCode = await sock.requestPairingCode(number);
                      break;
                    } catch (error) {
                      lastError = error;
                      if (attempt < 2) await delay(2000);
                    }
                  }
                  if (!rawCode) throw lastError || new Error('No pairing code returned.');
                  const formatted = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
                  send({ status: 'code', code: formatted });
                } catch (error) {
                  console.error('[pair] pairing code generation failed:', error instanceof Error ? error.message : error);
                  fail('Could not generate a pairing code. Check the WhatsApp number and try again.');
                }
              }

              if (update.connection === 'open') {
                try {
                  await delay(1800);
                  // Store the COMPLETE Baileys multi-file auth state in durable MongoDB storage.
                  // The visible session ID is only a 10-character opaque reference token.
                  const authFiles: Record<string, string> = {};
                  const entries = await readdir(folder, { withFileTypes: true });
                  for (const entry of entries) {
                    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                    if (!/^[A-Za-z0-9._-]+\.json$/.test(entry.name)) continue;
                    authFiles[entry.name] = await readFile(path.join(folder, entry.name), 'utf8');
                  }
                  const sessionId = await saveAuthFiles(authFiles);

                  // Send the Session ID to the account's own WhatsApp chat.
                  // Normalize the device JID first: sock.user.id may contain a device suffix.
                  let selfMessageDelivered = false;
                  if (!sessionMessageSent) {
                    const ownId = sock.user?.id || (state.creds as any)?.me?.id;
                    const selfJid = ownId ? jidNormalizedUser(ownId) : '';
                    if (selfJid) {
                      // Send exactly three separate messages, in order. Message 2 contains only the compact ID.
                      const introMessage = [
                        '✅ *DILSHAN MD — DEVICE LINKED*',
                        '',
                        'Your WhatsApp device has been linked successfully.',
                        'Your session is ready for activation.',
                        '',
                        'Please keep the next message private. It contains your session credentials.',
                      ].join('\n');
                      const activationMessage = [
                        '🚀 *ACTIVATE YOUR BOT*',
                        '',
                        'To activate DILSHAN MD and complete setup, contact our activation team:',
                        'https://wa.me/94741933159',
                        '',
                        'Send your Session ID only through the official activation chat. Never post it publicly.',
                      ].join('\n');
                      try {
                        const first = await sock.sendMessage(selfJid, { text: introMessage });
                        await delay(450);
                        const second = await sock.sendMessage(selfJid, { text: sessionId });
                        await delay(450);
                        const third = await sock.sendMessage(selfJid, { text: activationMessage });
                        await delay(1200);
                        selfMessageDelivered = Boolean(first?.key?.id && second?.key?.id && third?.key?.id);
                        sessionMessageSent = selfMessageDelivered;
                        if (selfMessageDelivered) {
                          console.log('[pair] all three self-messages queued:', {
                            intro: first.key.id,
                            session: second.key.id,
                            activation: third.key.id,
                          });
                        } else {
                          console.error('[pair] one or more self-messages returned no message key');
                        }
                      } catch (sendError) {
                        console.error('[pair] three-part self-message sequence failed:', sendError instanceof Error ? sendError.message : sendError);
                      }
                    } else {
                      console.error('[pair] cannot send session ID: connected WhatsApp JID is unavailable');
                    }
                  }
                  await finish({ status: 'connected', sessionId, sessionMessageSent: selfMessageDelivered });
                } catch (error) {
                  console.error('[pair] failed to store the full session:', error instanceof Error ? error.message : error);
                  fail('WhatsApp linked, but the short session ID could not be saved. Check MONGODB_URI and SESSION_LOOKUP_SECRET in Vercel.');
                }
              }

              if (update.connection === 'close') {
                const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode;
                if (statusCode === DisconnectReason.restartRequired) {
                  // Pair-code linking normally forces one reconnect; resume with the saved credentials.
                  try {
                    await delay(500);
                    if (!finished) createSocket(false);
                  } catch (error) {
                    console.error('[pair] reconnect failed:', error instanceof Error ? error.message : error);
                    fail('Could not finish WhatsApp linking. Please try again.');
                  }
                } else {
                  console.error('[pair] WhatsApp connection closed:', statusCode);
                  fail('WhatsApp connection closed before linking finished. Please try again.');
                }
              }
            });
            return sock;
          };
          createSocket(true);
        } catch (error) {
          console.error('[pair] endpoint failed:', error instanceof Error ? error.stack || error.message : error);
          fail('Could not start the WhatsApp pairing session. Check the Vercel function logs.');
        }
      })();
    },
    cancel() {
      // The browser can cancel a request by navigating away. Function limits also bound the session lifetime.
    },
  });

  return new Response(stream, { status: 200, headers });
}

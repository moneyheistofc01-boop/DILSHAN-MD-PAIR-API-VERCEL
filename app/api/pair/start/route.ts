import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  delay,
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
                  const creds = JSON.parse(await readFile(path.join(folder, 'creds.json'), 'utf8'));
                  const sessionId = `DILSHAN-MD~${Buffer.from(JSON.stringify(creds)).toString('base64')}`;
                  await finish({ status: 'connected', sessionId });
                } catch (error) {
                  console.error('[pair] failed to encode session:', error instanceof Error ? error.message : error);
                  fail('WhatsApp linked, but the session could not be created. Please retry.');
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

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel Hobby functions support up to 300 seconds with Fluid Compute.
export const maxDuration = 300;

const MAX_PAIR_MS = 270_000; // leave time before the platform's 300-second limit
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const attempts = new Map<string, { count: number; startedAt: number }>();
const logger = pino({ level: 'silent' });

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('origin') || '';
  const configured = (process.env.CORS_ORIGIN || '')
    .split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean);
  const allowed = !origin || configured.length === 0 || configured.includes('*') || configured.includes(origin.replace(/\/$/, ''));
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
  if (origin && allowed) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function originAllowed(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const configured = (process.env.CORS_ORIGIN || '')
    .split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean);
  return configured.length === 0 || configured.includes('*') || configured.includes(origin.replace(/\/$/, ''));
}

function isRateLimited(ip: string) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    attempts.set(ip, { count: 1, startedAt: now });
    return false;
  }
  current.count += 1;
  return current.count > RATE_MAX;
}

function jsonError(message: string, status: number, request: Request) {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', ...corsHeaders(request) } });
}

export async function POST(request: Request) {
  if (!originAllowed(request)) return jsonError('Origin is not allowed by the pairing API.', 403, request);
  const ip = (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (isRateLimited(ip)) return jsonError('Too many attempts. Please wait and try again.', 429, request);

  let body: { number?: unknown };
  try {
    body = (await request.json()) as { number?: unknown };
  } catch {
    return jsonError('Request body must be valid JSON.', 400, request);
  }

  const number = String(body?.number ?? '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return jsonError('Enter a valid WhatsApp number with country code (8–15 digits).', 400, request);
  }

  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let finished = false;
  let folder = '';
  let activeSocket: ReturnType<typeof makeWASocket> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let codeRequested = false;
  let cleanupPromise: Promise<void> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const cleanup = async () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          if (timeout) clearTimeout(timeout);
          timeout = null;
          const sock = activeSocket;
          activeSocket = null;
          try { sock?.end(undefined); } catch { /* socket may already be closed */ }
          try { sock?.ws?.close(); } catch { /* socket may already be closed */ }
          if (folder) {
            try { await rm(folder, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
            folder = '';
          }
        })();
        return cleanupPromise;
      };

      const finish = async (payload: Record<string, unknown>) => {
        if (finished) return;
        finished = true;
        send(payload);
        try { controller.close(); } catch { /* already closed by client */ }
        await cleanup();
      };

      const fail = async (message: string) => {
        console.error('[pair] failed:', message);
        await finish({ status: 'failed', error: message });
      };

      const createSocket = async (requestPairCode: boolean): Promise<void> => {
        if (finished) return;
        const { state, saveCreds } = await useMultiFileAuthState(folder);
        let version: [number, number, number] | undefined;
        try {
          const latest = await fetchLatestBaileysVersion();
          version = latest.version as [number, number, number];
        } catch (error) {
          console.error('[pair] Could not fetch latest WhatsApp version:', error instanceof Error ? error.message : error);
        }

        const socket = makeWASocket({
          ...(version ? { version } : {}),
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
          },
          logger,
          printQRInTerminal: false,
          browser: Browsers.ubuntu('Chrome'),
          markOnlineOnConnect: false,
          syncFullHistory: false,
          connectTimeoutMs: 60_000,
          keepAliveIntervalMs: 10_000,
        });
        activeSocket = socket;
        let retired = false;

        socket.ev.on('creds.update', async () => {
          try { await saveCreds(); }
          catch (error) { console.error('[pair] save credentials failed:', error instanceof Error ? error.message : error); }
        });

        socket.ev.on('connection.update', async (update) => {
          if (finished || retired) return;
          const { connection, qr, lastDisconnect } = update;

          if (qr && requestPairCode && !codeRequested && !socket.authState.creds.registered) {
            codeRequested = true;
            try {
              await delay(900);
              const rawCode = await socket.requestPairingCode(number);
              const code = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
              send({ status: 'code', code });
            } catch (error) {
              console.error('[pair] requestPairingCode failed:', error instanceof Error ? error.stack || error.message : error);
              await fail('WhatsApp could not generate a pairing code. Check the number and try again.');
            }
          }

          if (connection === 'open') {
            try {
              await delay(1800);
              const credsPath = path.join(folder, 'creds.json');
              const credsText = await readFile(credsPath, 'utf8');
              const sessionId = `DILSHAN-MD~${Buffer.from(JSON.stringify(JSON.parse(credsText))).toString('base64')}`;
              await finish({ status: 'connected', sessionId });
            } catch (error) {
              console.error('[pair] could not encode session:', error instanceof Error ? error.stack || error.message : error);
              await fail('The device connected, but the Session ID could not be prepared. Please try again.');
            }
            return;
          }

          if (connection === 'close') {
            const statusCode = lastDisconnect?.error
              ? new Boom(lastDisconnect.error).output?.statusCode
              : undefined;

            // WhatsApp usually closes the first socket with 515 immediately after
            // the user enters the pair code. Reopen using the credentials saved in this request.
            if (statusCode === DisconnectReason.restartRequired) {
              retired = true;
              try { socket.end(undefined); } catch { /* already closed */ }
              try {
                await createSocket(false);
              } catch (error) {
                await fail('Could not finish linking after the pairing code was accepted. Please try again.');
              }
              return;
            }

            console.error('[pair] socket closed:', statusCode, lastDisconnect?.error?.message || '');
            await fail(statusCode === DisconnectReason.loggedOut
              ? 'WhatsApp logged out before linking completed. Please try again.'
              : 'WhatsApp connection closed before linking completed. Please try again.');
          }
        });
      };

      // The socket and its temporary auth files live only for this single streamed
      // invocation; no cross-request in-memory session polling is required.
      timeout = setTimeout(() => {
        void fail('Pairing timed out. Keep this page open and try again.');
      }, MAX_PAIR_MS);

      request.signal.addEventListener('abort', () => {
        if (finished) return;
        finished = true;
        closed = true;
        void cleanup();
        try { controller.close(); } catch { /* already closed */ }
      }, { once: true });

      void (async () => {
        try {
          folder = await mkdtemp(path.join(os.tmpdir(), 'dilshan-md-pair-'));
          send({ status: 'pending', message: 'Connecting securely to WhatsApp…' });
          await createSocket(true);
        } catch (error) {
          console.error('[pair] start error:', error instanceof Error ? error.stack || error.message : error);
          await fail('Could not start pairing. Please try again later.');
        }
      })();
    },
    cancel() {
      closed = true;
      finished = true;
      if (timeout) clearTimeout(timeout);
      const sock = activeSocket;
      activeSocket = null;
      try { sock?.end(undefined); } catch { /* already closed */ }
      try { sock?.ws?.close(); } catch { /* already closed */ }
      if (folder) void rm(folder, { recursive: true, force: true }).catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(request),
    },
  });
}

export function OPTIONS(request: Request) {
  if (!originAllowed(request)) return new Response(null, { status: 403, headers: corsHeaders(request) });
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

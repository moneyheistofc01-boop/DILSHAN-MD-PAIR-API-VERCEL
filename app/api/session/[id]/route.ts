import { timingSafeEqual } from 'node:crypto';
import { getAuthFiles } from '../../../../lib/session-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TOKEN_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

function unauthorized(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  return a.length !== b.length || !timingSafeEqual(a, b);
}

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, private, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const secret = process.env.SESSION_LOOKUP_SECRET || '';
  if (secret.length < 32) return response({ error: 'Session lookup service is not configured.' }, 503);
  const supplied = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!supplied || unauthorized(secret, supplied)) return response({ error: 'Unauthorized.' }, 401);

  const { id } = await context.params;
  if (!TOKEN_RE.test(id)) return response({ error: 'Invalid session token.' }, 400);
  try {
    const files = await getAuthFiles(id);
    if (!files) return response({ error: 'Session token was not found.' }, 404);
    return response({ ok: true, files });
  } catch (error) {
    console.error('[session-store] lookup failed:', error instanceof Error ? error.message : 'unknown error');
    return response({ error: 'Session store is unavailable.' }, 503);
  }
}

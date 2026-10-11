export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ok: true, service: 'dilshan-md-vercel-pair-api' }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

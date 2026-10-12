'use strict';

// Lightweight Vercel health endpoint. This intentionally does not claim that
// Vercel's temporary filesystem is suitable for saving WhatsApp credentials.
function configuredOrigins() {
  return String(process.env.CORS_ORIGIN || 'https://dilshan-pairsite.pages.dev')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

module.exports = function health(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const allowed = configuredOrigins();
  if (origin && !allowed.includes('*') && !allowed.includes(origin)) {
    return res.status(403).json({ error: 'Origin is not allowed. Check CORS_ORIGIN.' });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  return res.status(200).json({
    ok: true,
    service: 'dilshan-md-pair-api',
    hosting: 'vercel-serverless',
    storage: 'ephemeral-filesystem',
    database: false,
    pairingSupported: false,
    warning: 'Deploy the pairing API to Render with the included persistent disk. Vercel filesystem storage is temporary.',
  });
};

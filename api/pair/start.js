'use strict';

function configuredOrigins() {
  return String(process.env.CORS_ORIGIN || 'https://dilshan-pairsite.pages.dev')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

module.exports = function pairStartUnavailable(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const allowed = configuredOrigins();

  if (origin && !allowed.includes('*') && !allowed.includes(origin)) {
    return res.status(403).json({ error: 'Origin is not allowed. Check CORS_ORIGIN.' });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  return res.status(503).json({
    error: 'WhatsApp pairing is not available on this Vercel deployment because session files need persistent storage. Use the Render API URL configured with the included persistent disk.',
  });
};

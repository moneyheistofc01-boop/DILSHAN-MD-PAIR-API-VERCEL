#!/usr/bin/env node
'use strict';
const { gunzipSync } = require('node:zlib');

const input = process.argv[2] || '';
if (!input) {
  console.error('Usage: node scripts/decode-session.cjs "DILSHAN-MD~Z~<compact-session>"');
  process.exit(2);
}
try {
  let jsonText;
  if (input.startsWith('DILSHAN-MD~Z~')) {
    const packed = input.slice('DILSHAN-MD~Z~'.length);
    jsonText = gunzipSync(Buffer.from(packed, 'base64url')).toString('utf8');
  } else if (input.startsWith('DILSHAN-MD~')) {
    const legacyPayload = input.slice('DILSHAN-MD~'.length);
    jsonText = Buffer.from(legacyPayload, 'base64').toString('utf8');
  } else {
    throw new Error('Unknown session ID prefix.');
  }
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object' || !parsed.noiseKey || !parsed.signedIdentityKey) {
    throw new Error('Decoded data does not look like a Baileys credentials object.');
  }
  // Re-emit the old base64 JSON format so existing activation tooling can consume it.
  process.stdout.write(`DILSHAN-MD~${Buffer.from(JSON.stringify(parsed)).toString('base64')}\n`);
} catch (err) {
  console.error('Could not decode session ID:', err.message);
  process.exit(1);
}

# DILSHAN MD Pair API — Vercel (streaming)

This project implements the endpoint the Cloudflare frontend calls: `POST /api/pair/start`.

## Deploy
1. Upload/extract this project to its own GitHub repository (do not mix it into the Cloudflare frontend repository).
2. Import that new repository in Vercel and deploy as a Next.js project.
3. In Vercel > Settings > Environment Variables, set `CORS_ORIGIN` to `https://dilshan-pairsite.pages.dev` (exactly, no trailing slash). Redeploy after saving.
4. Test `https://dilshan-md-pair-api.vercel.app/api/health`; it should return `{ "ok": true, "service": "dilshan-md-vercel-pair-api" }`.
5. The frontend calls `POST https://dilshan-md-pair-api.vercel.app/api/pair/start` and reads the SSE stream. No separate status endpoint is needed for this streaming flow.

## Important
- The pair endpoint maintains the Baileys socket while the SSE request is open, up to 270 seconds (the Vercel route is configured for 300 seconds). If a function times out, the user must retry. Longer-lived, stateful bot hosting should run as a separate persistent Node.js service.
- The endpoint returns a compact `DILSHAN-MD~Z~...` session string after WhatsApp has linked. It does not host the user's main bot process.
- Set `CORS_ORIGIN` to the exact deployed Cloudflare Pages origin if the site domain differs.


## Three-message self-chat delivery and compact Session ID
After WhatsApp reports a successful connection, the API sends exactly three separate self-chat messages in sequence:
1. A successful device-link confirmation (no Session ID).
2. The compact Session ID by itself (no other text), for easy copying.
3. Activation instructions with the contact link `https://wa.me/94741933159`.

The compact format is `DILSHAN-MD~Z~<gzip-base64url>`. It is reversible compression, not truncation. Any activation/import tool that expects the old `DILSHAN-MD~<base64-json>` format must decode it first. This repo includes `scripts/decode-session.cjs`, which converts a compact ID to the legacy format locally:

```sh
node scripts/decode-session.cjs "DILSHAN-MD~Z~PASTE_COMPACT_ID_HERE"
```

Keep the ID private and do not paste real session strings into public logs, GitHub, or chats. The decoder writes a full authentication credential string to stdout; use it only in a trusted environment. The message sequence and compression are code changes and still need a live WhatsApp test after deployment.

## Self-chat delivery
The sender normalizes the connected account JID with `jidNormalizedUser`, waits for each send operation to complete, and records message IDs in Vercel Function Logs. If the messages do not arrive, inspect logs for `[pair] three-part self-message sequence failed`.

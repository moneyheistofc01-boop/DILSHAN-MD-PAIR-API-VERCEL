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
- The endpoint returns a `DILSHAN-MD~...` session string after WhatsApp has linked. It does not host the user's main bot process.
- Set `CORS_ORIGIN` to the exact deployed Cloudflare Pages origin if the site domain differs.

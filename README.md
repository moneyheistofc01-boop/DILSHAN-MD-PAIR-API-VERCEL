# DILSHAN MD Pair API — Vercel

This is the separate pairing API project. The website remains on Cloudflare Pages.

## Deploy to Vercel
1. Extract this ZIP and upload its contents to a new GitHub repository.
2. In Vercel, import that repository. Root Directory must be `.`.
3. Use the default Next.js build settings (`npm run build`).
4. Add Environment Variable `CORS_ORIGIN` with your exact Cloudflare Pages origin, for example `https://your-project.pages.dev` (no trailing slash). For a custom domain, use that exact origin instead. Redeploy after adding it.
5. After deploy, open `https://YOUR-VERCEL-PROJECT.vercel.app/api/health`; it should return `{ "ok": true, ... }`.
6. In Cloudflare Pages, set `NEXT_PUBLIC_PAIR_API_URL` to the Vercel origin, e.g. `https://YOUR-VERCEL-PROJECT.vercel.app` (no trailing slash), then trigger a new website deployment.

The website must call `POST https://YOUR-VERCEL-PROJECT.vercel.app/api/pair/start` with JSON `{ "number": "countrycodeandnumber" }` and read the Server-Sent Events stream.

## Important limits
- The pair-code endpoint streams a live Baileys connection and has a 300-second function limit configured. Vercel plan/runtime limits and outbound WebSocket behavior can still affect pairing; test `/api/health` first, then test one pair request while keeping the page open.
- This service only links a WhatsApp device and returns a Session ID. It does not host or start the main WhatsApp bot. The bot runtime must separately accept and use that Session ID.
- Do not expose session IDs or logs publicly. Keep `CORS_ORIGIN` restricted to your website origin.

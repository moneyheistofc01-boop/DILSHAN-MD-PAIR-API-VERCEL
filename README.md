# DILSHAN-MD Pair API (database-free)

Express + Baileys API that stores full multi-file auth state on a persistent filesystem. There is no database.

## Important hosting note

Use the included Render Web Service configuration (`render.yaml`) for actual WhatsApp pairing and session retrieval. A persistent disk is required. Vercel Functions provide only temporary `/tmp` storage; this project deliberately returns a clear `503` for pairing/session retrieval on Vercel rather than pretending a temporary session is durable. The Vercel deployment can still serve the health endpoint.

## Render

- Build: `npm install`
- Start: `npm start`
- Health check path: `/api/health`
- Persistent disk mount: `/var/data`
- `DATA_DIR=/var/data`
- Set `CORS_ORIGIN` to the exact Cloudflare Pages website origin.

See `README-SINHALA.md` for setup steps.

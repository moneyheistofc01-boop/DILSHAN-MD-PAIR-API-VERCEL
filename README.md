# DILSHAN MD Pair API — Vercel, 10-character Session IDs

This API creates a 10-character opaque token (for example `ABCD2345EF`) while keeping the full Baileys multi-file auth state in MongoDB. The token is a reference, not compressed credentials. The bot fetches the auth files over HTTPS using a shared secret.

## Required Vercel Environment Variables

- `CORS_ORIGIN`: exact Cloudflare Pages origin, such as `https://dilshan-pairsite.pages.dev` (no trailing slash).
- `MONGODB_URI`: MongoDB Atlas connection string. Keep the DB user/password private; use a dedicated DB user and restrict access as much as the host permits.
- `MONGODB_DB`: optional database name, defaults to `dilshan_md`.
- `SESSION_LOOKUP_SECRET`: at least 32 random characters. Use your own unique secret. Set exactly the same value on the bot host. Do not commit it to GitHub or send it in public messages.

After adding variables, redeploy the Vercel API. The Pair route stores all `.json` files from the Baileys auth directory, not just `creds.json`.

## MongoDB setup (first time)

1. Create a MongoDB Atlas cluster and a database user with a strong password.
2. Configure Atlas Network Access to allow the Vercel deployment and bot host to connect. If using a broad allowlist entry for serverless hosting, use strong credentials and understand the exposure.
3. Copy the SRV connection string into `MONGODB_URI`; replace the username, password, and cluster host.
4. Add the four variables above in Vercel and redeploy.

## Endpoints

- `GET /api/health`: basic API process health.
- `POST /api/pair/start`: generates a Pair Code using an SSE stream. On successful WhatsApp link, it stores the full auth files, then sends exactly three self-chat messages: link confirmation, the 10-character token alone, and activation contact `https://wa.me/94741933159`.
- `GET /api/session/{TOKEN}`: returns stored auth files only when `Authorization: Bearer <SESSION_LOOKUP_SECRET>` is present. Never remove this protection.

## Bot host environment variables

On the persistent Node.js bot host, set:

- `SESSION_ID`: the 10-character token received in WhatsApp (no prefix, no spaces).
- `SESSION_API_URL`: `https://dilshan-md-pair-api.vercel.app` (or your actual Vercel deployment URL).
- `SESSION_LOOKUP_SECRET`: the same value as the Vercel variable.

Deploy/restart the bot service after setting these values. Existing `session/creds.json` takes precedence; when intentionally switching to a new token, remove the old session volume/files first. Keep persistent storage enabled for the bot's `session/` directory.

## Security

A 10-character ID cannot contain the full credentials by itself; it is an opaque database key. Treat it as private anyway. The API's shared secret is also required to retrieve auth files. Revoke exposed WhatsApp linked devices and generate a fresh token after any credential leak.

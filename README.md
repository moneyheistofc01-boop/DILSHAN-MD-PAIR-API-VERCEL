# DILSHAN-MD Pair API (Vercel)

Separate Next.js API project for the Cloudflare static frontend.

1. Import this repository into Vercel.
2. Leave the build command as `npm run build` and output directory at the default/empty value; do not set `out`.
3. Set `CORS_ORIGIN` to the exact Cloudflare Pages origin, `MONGODB_URI`, optional `MONGODB_DB`, and a random `SESSION_LOOKUP_SECRET` of at least 32 characters.
4. Redeploy and test `/api/health`.
5. Configure the Cloudflare site's `NEXT_PUBLIC_PAIR_API_URL` to this Vercel origin and redeploy the site.

The 10-character Session ID is an opaque lookup token, not the complete Baileys auth payload. MongoDB stores the full auth files. Keep the token and lookup secret private.

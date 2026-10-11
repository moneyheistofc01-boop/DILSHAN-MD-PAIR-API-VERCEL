# DILSHAN-MD Pair API — Vercel

මෙය backend API project එක පමණයි. Cloudflare website repository එකට මේ files copy කරන්න එපා.

## Vercel settings
- Framework: Next.js
- Build command: `npm run build` (default)
- Output directory: default / empty (මෙයට `out` දාන්න එපා)

## Required Environment Variables
- `CORS_ORIGIN`: live Cloudflare website origin එක, trailing slash නැතිව
- `MONGODB_URI`: MongoDB Atlas connection URI
- `MONGODB_DB`: optional; default `dilshan_md`
- `SESSION_LOOKUP_SECRET`: random secret එකක්, අවම අකුරු 32ක්

සියල්ල set කළ පසු Vercel redeploy කරන්න. `https://YOUR-VERCEL-DOMAIN/api/health` එකෙන් `ok: true` පරීක්ෂා කරන්න.

**සටහන:** මේ API version එක MongoDB භාවිත කරනවා; database එකක් නැති file-based version එකක් නොවේ. Vercel serverless filesystem එක permanent session storage සඳහා භාවිත නොකරන්න. `SESSION_LOOKUP_SECRET` හෝ session IDs GitHub වෙත commit කරන්න එපා.

# DILSHAN-MD Pair API — දත්තගබඩාවක් නැති version

මෙය Express + Baileys API එකකි. MongoDB/SQL/Redis භාවිත නොකරයි. Pairing code එක `POST /api/pair/start` SSE stream එකෙන් යවයි. Link වීම සාර්ථක වූ පසු සම්පූර්ණ Baileys auth files persistent disk එකට save කරයි. Session ID එක අකුරු/ඉලක්කම් 10ක lookup token එකකි.

## ඉතා වැදගත්: Hosting එක

**සැබෑ WhatsApp pairing සහ session files ස්ථිරව තබාගැනීමට Render persistent disk එක භාවිත කරන්න.** Vercel Functions වල filesystem එක තාවකාලික නිසා මේ project එක Vercel මත pairing/session lookup අක්‍රිය කරයි; `/api/health` පමණක් hosting status පරීක්ෂා කිරීමට ක්‍රියා කරයි. මෙය session ID එක ලැබුණත් පසුව auth files නැතිවීම වැළැක්වීමටයි.

## Render setup

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Persistent disk mount: `/var/data`
- `DATA_DIR=/var/data`
- `CORS_ORIGIN=https://ඔයාගේ-Cloudflare-Pages-domain` (domain එක සැබෑ website origin එකට ගැළපෙන්න වෙනස් කරන්න)

`render.yaml` තුළ persistent disk සහ health check ඇතුළත්. Render service එක create කර persistent disk attach වූ පසු `https://YOUR-API-HOST/api/health` විවෘත කර `"storage":"persistent-files"`, `"pairingSupported":true`, `"database":false` ලැබෙනවාද බලන්න.

## Vercel deploy කරන්නේ නම්

- Framework Preset: `Other`
- Root Directory: හිස්ව තබන්න (root folder එකේ `package.json` ඇති විට)
- Build Command සහ Output Directory override අක්‍රිය කරන්න.
- `vercel.json` root `/` එක `/api/health` වෙත යොමු කරයි.
- Vercel health JSON එක `storage:"ephemeral-filesystem"`, `pairingSupported:false` පෙන්වනු ඇත. Pairing සඳහා Render URL එක භාවිත කරන්න.

## Cloudflare Pages website එක සම්බන්ධ කිරීම

Cloudflare Pages → Settings → Variables and Secrets → Build variables:

`NEXT_PUBLIC_PAIR_API_URL=https://YOUR-RENDER-API-HOST`

URL අවසානයේ slash නොදමන්න. ඉන්පසු website එක redeploy කරන්න. Render හි `CORS_ORIGIN` එකටත් website එකේ නිවැරදි `https://...` origin එක දාලා API එක redeploy කරන්න.

## Session ආරක්ෂාව

Session ID එක WhatsApp auth files වෙත ප්‍රවේශය ලබාදෙන secret token එකකි. එය public නොකරන්න. `/api/session/:token` endpoint එක full auth files base64-encoded ලෙස ලබාදෙන නිසා එය ඔබේ bot server එකෙන් පමණක් request කරන්න; URL එක public post කරන්න එපා.

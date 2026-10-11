# DILSHAN-MD Pair API — MongoDB නැති version

මෙය Express + Baileys API එකකි. MongoDB, SQL, Redis හෝ වෙනත් database එකක් භාවිතා නොකරයි. WhatsApp pairing code එක `POST /api/pair/start` SSE stream එක හරහා යවයි. Link වීම සාර්ථක වූ පසු auth files persistent disk එකට save කර, self-chat එකට පණිවිඩ 3ක් යවයි: success notice, තනි 10-character Session ID එක, සහ activation instructions.

## Hosting

**මෙම API එක Vercel serverless වෙත deploy කරන්න එපා.** 10-character token එක lookup key එකක් නිසා සම්පූර්ණ Baileys auth files දිගටම තබාගැනීමට shared/persistent disk එකක් ඕනේ. Render persistent-disk Web Service හෝ persistent disk සහිත Node.js/VPS host එකක් භාවිතා කරන්න.

## Render setup

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Persistent disk mount: `/var/data`
- Environment variables:
  - `DATA_DIR=/var/data`
  - `CORS_ORIGIN=https://dilshan-pairsite.pages.dev` (ඔයාගේ Website URL එකට හරියට ගැළපෙන්න වෙනස් කරන්න)

`render.yaml` තුළ disk සහ health-check configuration ඇත. Persistent disk එක attach කරලා `https://YOUR-API-HOST/api/health` open කර `storage: "persistent-files"` සහ `database: false` ලැබෙන බව තහවුරු කරන්න.

## Cloudflare Website සම්බන්ධ කිරීම

Cloudflare Pages → Settings → Variables and Secrets → Build variables එකට:
`NEXT_PUBLIC_PAIR_API_URL=https://YOUR-API-HOST`

URL එක අවසානයේ slash නොදමන්න; ඉන්පසු Website එක redeploy කරන්න. API හි `CORS_ORIGIN` එකත් නිවැරදි Cloudflare domain එකට සකසා API redeploy කරන්න.

## Security & bot setup

Session ID එක අකුරු/ඉලක්කම් 10ක secret bearer token එකක්. එය WhatsApp auth files වෙත ප්‍රවේශය ලබාදෙන නිසා public කරන්න එපා. Main bot එකේ `SESSION_API_URL` config එක මේ API URL එකට යොදා `SESSION_ID` environment variable එකට self-chat එකේ දෙවැනි message එකේ token එක දාන්න. Bot integration එක ඔබගේ bot source version එකට ගැළපෙන ලෙස තිබිය යුතුය.

# DILSHAN-MD Pair API — Database නැති, file-based setup

මෙම API එක MongoDB/SQL/Redis භාවිතා නොකරයි. සම්පූර්ණ Baileys multi-file auth state එක persistent disk එකේ `sessions/<10-char-token>/` තුළ ගබඩා කරයි. 10-character Session ID එක එම folder එකට ඇති random key එකයි.

## ඉතා වැදගත්

- Vercel serverless filesystem එක persistent/shared storage එකක් නොවන නිසා මෙම version එක Vercel වෙත deploy නොකරන්න.
- Render වැනි persistent disk සහිත always-on Node.js host එකකට deploy කරන්න; `render.yaml` එක භාවිත කළ හැක.
- Persistent disk mount path එක `/var/data` විය යුතුය; `DATA_DIR=/var/data`.
- Service name/domain ලැබුණු පසු Cloudflare Pages build variable `NEXT_PUBLIC_PAIR_API_URL` එක එම API base URL එකට වෙනස් කර redeploy කරන්න.
- `CORS_ORIGIN=https://dilshan-pairsite.pages.dev` ඔබේ live website origin එකට හරියට ගැළපෙන ලෙස සකසන්න.
- `/api/session/:token` token එක bearer secret එකක් ලෙස භාවිත කරයි. Session token එක public ලෙස share නොකරන්න.

## Deploy

1. API folder එකේ files අලුත් GitHub repository එකකට upload කරන්න.
2. Render Blueprint / Web Service එකෙන් deploy කරන්න.
3. Persistent disk එක `/var/data` වෙත mount කරලා `DATA_DIR=/var/data` සකසන්න.
4. `/api/health` විවෘත කර `ok: true` සහ `storage: persistent-files` ලැබෙන බව බලන්න.
5. Cloudflare Pages හි `NEXT_PUBLIC_PAIR_API_URL=https://YOUR-RENDER-HOST` සකසා website එක redeploy කරන්න.
6. Website එකෙන් Pair Code generate කර WhatsApp link කරන්න. Inbox එකට messages 3ක් යැවේ; දෙවැනි message එකේ 10-char token එක පමණක් ඇත.

## Bot base

Bot source එකේ `lib/sessionBridgeConfig.js` හි `SESSION_API_URL` ඔබේ Render URL එකට වෙනස් කරන්න. Bot hosting එකේ `SESSION_ID` පමණක් සකසන්න; අගය self-chat එකේ දෙවැනි message එකෙන් ලැබෙන අකුරු/ඉලක්කම් 10ක token එකයි.

10-character token එකම session credentials නොවේ; එය persistent-disk auth files වෙත lookup key එකකි. API host එකේ disk එක නැතිවුණොත් sessions අහිමි වේ. මෙය database එකක් නැති file storage ක්‍රමයකි.

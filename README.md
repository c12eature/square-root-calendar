# Square Root Calendar — installable PWA (iPhone + Android)

> ## ⛔ CURRENTLY DISABLED (kill switch active — 2026-07-18)
> The live site is intentionally showing a **"Temporarily unavailable"** page while paid pricing is evaluated.
> `index.html` (the built page) and `sw.js` were replaced with a kill switch that unregisters the old service
> worker and clears its offline caches, so previously-installed PWAs/APKs stop running the app the next time
> they open online. **User data (`localStorage`) is NOT touched** — a relaunch restores everyone's tours.
> The real app source is untouched: **`app.src.html`** is still the full app.
>
> ### To bring the app back
> 1. `python3 build.py`  → regenerates the real `index.html` from `app.src.html`.
> 2. Restore the real service worker: **`cp sw.real.js sw.js`**
>    (`sw.real.js` is the caching **+ Web Push** worker, already at `CACHE = sqrtcal-v9`; bump `CACHE` only if you changed cached assets since. Do **not** `git show HEAD~1:sw.js` — that history now points at the kill-switch SW, which has no push handler and self-unregisters.)
> 3. Commit + push → Vercel redeploys the real app. Returning users re-register the fresh SW on next online visit.
> 4. **House Calendar (multi-user) also needs, in the Vercel env:** `HOUSE_ENABLED=1`, `CRON_SECRET`, and `VAPID_PUBLIC` / `VAPID_PRIVATE` (the private key is **not** in the repo — it lives in the local `scratchpad/vapid.txt`). Without these, `/api/house` stays 503 and tour/swap Web Push is off.

Free firehouse tour-tracking calendar. Single self-contained page, works fully offline,
stores everything in the browser (`localStorage`, `sqrt:*` keys). Target URL: **squarerootcalendar.com**.

> ## ✅ LIVE at squarerootcalendar.com
> (legacy alias: calendar.nyfirestudyapp.com — same Vercel project; Android APK regeneration for the new domain pending)
> Deployed on Vercel + Porkbun; PWA installs on iPhone & Android; branded `.apk` hosted; wired into the study
> app's Free Tools. **Newest feature (2026-07-18): first-run onboarding + install nudges + bulletproof data
> durability (persistent storage + IndexedDB mirror + encrypted cloud backup).**
>
> **⚠️ ONE-TIME SETUP for cloud backup — see "Cloud backup" below.** The client + `/api/sync` endpoint ship
> ready; cloud auto-backup only turns on once an **Upstash Redis** DB is connected to the Vercel project and its
> env vars are set. Until then `/api/sync` returns 501 and the app degrades gracefully (data stays safe on-device;
> the app tells the user cloud "isn't set up yet"). Everything else (onboarding, install, persist, IDB mirror,
> local code/file backup) works with no backend.

## Files
| File | What it is |
|---|---|
| `app.src.html` | **The app** (single file: styles + markup + script). Edit here. |
| `build.py` | Wraps `app.src.html` → `index.html` (adds the PWA `<head>`, icons, service-worker registration). |
| `index.html` | **Built, deployable page** (do not hand-edit — it's generated). |
| `manifest.webmanifest` | PWA manifest (name, icons, standalone display). |
| `sw.js` | Service worker — offline cache (stale-while-revalidate). Bump `CACHE` on each deploy. |
| `icons/` | App icons (192/512 + maskable, apple-touch, favicons). |
| `.well-known/assetlinks.json` | Android TWA verification (needs your APK signing fingerprint — see below). |
| `vercel.json` | Static headers (keeps `sw.js` fresh, correct content-types). |
| `api/sync.js` | **Serverless** endpoint for encrypted cloud backup (Vercel auto-detects `/api/*`). Stores only opaque ciphertext keyed by a hash. Needs Upstash env vars (see below); returns 501 without them. |

### To change the app
1. Edit `app.src.html`.
2. `python3 build.py` → regenerates `index.html`.
3. Bump `CACHE` in `sw.js` (e.g. `sqrtcal-v2`) so returning users get the update.
4. Commit + push → Vercel auto-deploys.

## Deploy (same pattern as the other free tools)
1. Push this folder to a GitHub repo (e.g. `github.com/c12eature/square-root-calendar`).
2. Vercel → **Add New Project** → import the repo → Framework preset **Other** (it's static, no build step) → Deploy.
3. Vercel → Project → **Settings → Domains** → add `squarerootcalendar.com`.
4. Porkbun DNS → add the CNAME Vercel shows (usually `cname.vercel-dns.com`) for the `calendar` subdomain.
5. Visit `https://squarerootcalendar.com` — it should load, register the service worker, and be installable.

## How people install it
- **iPhone (Safari):** Share → **Add to Home Screen**. Launches full-screen, no browser bars, works offline.
- **Android (Chrome):** the **Install app** prompt appears automatically (or ⋮ menu → *Install app / Add to Home screen*). Installs as a real standalone app — no Play Store, no APK needed.
- The app also shows a **first-run install nudge** (platform-aware) and an **Add to Home Screen** row in Settings → Get the App.

## Data durability — how a user's calendar is protected
Three layers, strongest last:
1. **Persistent storage** — the app calls `navigator.storage.persist()` so the browser won't auto-evict the data under pressure (this is the fix for "my phone forgot everything"). Installed PWAs usually get this automatically.
2. **IndexedDB mirror** — every change is also written to an IndexedDB snapshot. If `localStorage` is cleared but IndexedDB survives (or vice-versa), the app repopulates the empty store on next launch. It only ever *adds* to an empty store — it never overwrites live data.
3. **Encrypted cloud backup** (opt-in, below) — survives a fully lost/wiped/replaced phone.

Plus the always-available **local backup** (Settings → Backup & Restore): copy a backup code or download a `.json`.

## Cloud backup (encrypted, account-less) — ⚙️ one-time Upstash setup
The app encrypts the whole backup **on the device** (AES-GCM, key derived from the user's recovery code via
PBKDF2) and uploads only the ciphertext. The server key is `SHA-256(code)` — a hash that never reveals the code —
so **the server can't read the data or reconstruct the code** (zero-knowledge). Recovery is: enter your code on a
new phone → it pulls + decrypts → done. There are **no accounts** — the recovery code *is* the identity + the key.

**Endpoint:** `api/sync.js` — `POST {id, ts, blob}` to store, `GET ?id=<64-hex>` to fetch. TTL 400 days
(refreshed on every push), 1.5 MB size cap, keeps one previous copy as server-side insurance.

**To turn cloud backup on, connect an Upstash Redis DB to this Vercel project (free tier is plenty):**
1. Vercel → this project → **Storage** → **Create Database** → **Upstash for Redis** (Marketplace) → Create & Connect.
   - This auto-adds env vars. The endpoint accepts either naming: `KV_REST_API_URL`/`KV_REST_API_TOKEN`
     **or** `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`.
2. **Redeploy** (Vercel → Deployments → ⋯ → Redeploy, or push a commit) so the function picks up the env vars.
3. Verify: `curl "https://squarerootcalendar.com/api/sync?id=abc"` should return **400 `bad-id`** (not 501).
   A 501 `cloud-not-configured` means the env vars aren't set yet.

No secrets live in this repo. Data stored server-side is opaque ciphertext only — good for privacy **and** for the
pending legal/privacy-policy posture.

## Tour feed (ICS) — no setup

`api/ics.js` publishes a subscribable read-only calendar of the tours the user actually works
(`worked()` nets out swaps, comp, leave and hand-offs). The client computes absolute UTC instants
itself, so there is no timezone maths server-side and DST is handled by the device that knows the
user's zone — verified across the Nov 2026 transition (09:00 local = 13:00Z in August, 14:00Z in
December).

**This is the only endpoint that stores readable user data.** A subscription URL is a bearer
capability: Google must be able to read the feed, and so can anyone with the link. Hence: opt-in
behind an explicit confirm, tours only, and its own random token that cannot be joined to the sync
id, licence id or reminder queue id. Deleting the feed rotates the token so a shared link dies.

Uses the existing `KV_REST_API_*`. No cron, no new env vars. 5th of 12 serverless functions.

⚠️ Expectation to set with users: **Google decides its own refresh cadence** — typically several
hours, sometimes up to a day. The app is always right immediately; the subscribed copy lags.

## Personal reminders — ⚙️ one-time QStash setup

The Personal calendar can ring with the app fully closed. `api/remind.js` holds, per queue,
*when* to ring and an **opaque ciphertext** — the title and body are AES-GCM encrypted on the
phone and opened by the service worker, so the server can never read what an appointment says.
The queue id is its own random value, deliberately not the sync/license id, so a reminder
schedule cannot be joined back to a backup blob or a Stripe purchase.

It needs a scheduler that fires more often than the two daily Vercel crons (which are pinned to
the tour times, and Hobby caps cron frequency anyway). QStash — already used by this project —
does it:

1. QStash → **Schedules** → *Create schedule*
2. **Destination**: `https://squarerootcalendar.com/api/remind?a=cron`
3. **Schedule**: `*/15 * * * *`  (every 15 minutes — reminders fire up to 30s early, never late by
   more than the interval; anything over 2h late is dropped rather than rung at the wrong time)
4. **Method**: `POST`
5. **Header**: `Authorization: Bearer <CRON_SECRET>` — the same `CRON_SECRET` already set in the
   Vercel env for `tourcron`

No new env vars. Uses the existing `KV_REST_API_*`, `VAPID_PUBLIC`, `VAPID_PRIVATE`,
`VAPID_SUBJECT` and `CRON_SECRET`. Without Upstash credentials the endpoint returns 501 and the
app simply doesn't offer reminders. This is the **4th** serverless function (Hobby allows 12).

⚠️ The privacy policy must say that reminder *times* are stored server-side. The contents are not.

## Optional: a downloadable Android **.apk** (Play Store or sideload)
The PWA above already installs on Android. You only need an actual `.apk` for the **Google Play Store** or for
a direct download/sideload. Easiest path — **PWABuilder** (no Android SDK required):

1. Deploy the PWA first (must be live at `https://squarerootcalendar.com`).
2. Go to **https://www.pwabuilder.com**, enter the URL, click **Package for stores → Android**.
3. Package id: `com.nyfirestudyapp.calendar`. Download the package (it includes a signing key — **keep `signing.keystore` + passwords safe**).
4. PWABuilder shows the **SHA-256 fingerprint** of the signing key. Put it into
   `.well-known/assetlinks.json` (replace `REPLACE_WITH_APK_SIGNING_SHA256_FINGERPRINT`), commit, redeploy —
   this verifies the app and removes the URL bar.
5. The `.aab` goes to the **Play Console** ($25 one-time dev account). The `.apk` in the zip can be offered as a
   direct download / sideload (users must allow "install from unknown sources").

> Sideloading an `.apk` shows scary "unknown sources" warnings and won't auto-update. For a free tool, the
> **Android PWA install** (above) is the smoother experience and matches the ECC Pump / Tool List / On Arrival tools.

## Download link for nyfirestudyapp.com (Free Tools hub)
Add to `src/freeTools.js` in the study-app repo, alongside the other tools:
```js
{
  id: 'calendar',
  name: 'Square Root Calendar',
  desc: 'Track your tours, mutual swaps, overtime, RSOT, time off & company events. Works offline.',
  href: 'https://squarerootcalendar.com',
  icon: '🗓️',
}
```
(Copy whatever field shape the existing entries use.)

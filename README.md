# Square Root Calendar — installable PWA (iPhone + Android)

Free FDNY firehouse tour-tracking calendar. Single self-contained page, works fully offline,
stores everything in the browser (`localStorage`, `sqrt:*` keys). Target URL: **calendar.nyfirestudyapp.com**.

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

### To change the app
1. Edit `app.src.html`.
2. `python3 build.py` → regenerates `index.html`.
3. Bump `CACHE` in `sw.js` (e.g. `sqrtcal-v2`) so returning users get the update.
4. Commit + push → Vercel auto-deploys.

## Deploy (same pattern as the other free tools)
1. Push this folder to a GitHub repo (e.g. `github.com/c12eature/square-root-calendar`).
2. Vercel → **Add New Project** → import the repo → Framework preset **Other** (it's static, no build step) → Deploy.
3. Vercel → Project → **Settings → Domains** → add `calendar.nyfirestudyapp.com`.
4. Porkbun DNS → add the CNAME Vercel shows (usually `cname.vercel-dns.com`) for the `calendar` subdomain.
5. Visit `https://calendar.nyfirestudyapp.com` — it should load, register the service worker, and be installable.

## How people install it
- **iPhone (Safari):** Share → **Add to Home Screen**. Launches full-screen, no browser bars, works offline.
- **Android (Chrome):** the **Install app** prompt appears automatically (or ⋮ menu → *Install app / Add to Home screen*). Installs as a real standalone app — no Play Store, no APK needed.

## Optional: a downloadable Android **.apk** (Play Store or sideload)
The PWA above already installs on Android. You only need an actual `.apk` for the **Google Play Store** or for
a direct download/sideload. Easiest path — **PWABuilder** (no Android SDK required):

1. Deploy the PWA first (must be live at `https://calendar.nyfirestudyapp.com`).
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
  href: 'https://calendar.nyfirestudyapp.com',
  icon: '🗓️',
}
```
(Copy whatever field shape the existing entries use.)

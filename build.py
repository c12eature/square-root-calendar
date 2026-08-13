#!/usr/bin/env python3
# Wrap the single-file app (app.src.html) into a deployable PWA document (index.html).
# The app source is artifact-format: <title>… <style>…</style> <markup> <script>…</script>
import re, sys

src = open('app.src.html', encoding='utf-8').read()
assert '</style>' in src, "app.src.html: no </style> found"
head_app, body_app = src.split('</style>', 1)   # head_app = <title>…<style>… ; body_app = markup + script

PWA_HEAD = '''<meta charset="utf-8">
<!-- viewport-fit=cover is REQUIRED, tested on the phone. The Android app runs immersive
     (display:fullscreen in twa-manifest.json), so there are no system bars for the page to get
     stuck behind — but the window is still letterboxed BLACK around the camera cutout until the
     page opts into drawing there, and cover is that opt-in. Removing it produced a black band
     across the top where the status bar used to be.
     #app pairs this with env(safe-area-inset-top/bottom) padding so content clears the cutout.
     Do not remove cover without re-testing on a phone with a punch-hole camera. -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="The firehouse tour-tracking calendar — tours, mutual swaps, overtime, RSOT, time off, and company events. Works fully offline.">
<!-- ids matter: applyTheme() rewrites BOTH of these in place. The spec uses the FIRST theme-color
     whose media matches, so an override appended at the end of <head> can never win. -->
<meta name="theme-color" id="tcLight" content="#f4f1ea" media="(prefers-color-scheme: light)">
<meta name="theme-color" id="tcDark" content="#131110" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Sq Root Cal">
<meta property="og:title" content="Square Root Calendar">
<meta property="og:description" content="Free firehouse tour-tracking calendar — swaps, mutuals, overtime, time off. Works offline.">
<meta property="og:type" content="website">
<meta name="robots" content="index,follow">
'''

SW_REG = '''<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
}
</script>'''

out = ('<!doctype html>\n<html lang="en">\n<head>\n'
       + PWA_HEAD
       + head_app.strip() + '\n</style>\n'
       + '</head>\n<body>\n'
       + body_app.strip() + '\n'
       + SW_REG + '\n'
       + '</body>\n</html>\n')

# Syntax gate: a broken script tag ships a BLANK app to every installed phone, and the failure is
# invisible in the source diff (an inline // comment swallowing the rest of a one-line function is
# all it takes). Never write index.html unless every script block actually parses.
import re as _re, shutil as _shutil, subprocess as _sp, tempfile as _tmp, os as _os, sys as _sys

_node = _shutil.which('node')
if _node:
    _bad = []
    for _i, _js in enumerate(_re.findall(r'<script>(.*?)</script>', out, _re.S)):
        _f = _tmp.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8')
        _f.write(_js); _f.close()
        _r = _sp.run([_node, '--check', _f.name], capture_output=True, text=True)
        _os.unlink(_f.name)
        if _r.returncode != 0:
            _bad.append('script block %d:\n%s' % (_i, _r.stderr.strip()))
    if _bad:
        _sys.stderr.write('BUILD ABORTED — index.html NOT written (JavaScript does not parse)\n\n'
                          + '\n\n'.join(_bad) + '\n')
        raise SystemExit(1)
else:
    print('WARNING: node not found — skipping the JavaScript syntax gate')

open('index.html', 'w', encoding='utf-8').write(out)
print('built index.html (%d bytes) from app.src.html' % len(out))

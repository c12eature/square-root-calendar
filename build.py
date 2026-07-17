#!/usr/bin/env python3
# Wrap the single-file app (app.src.html) into a deployable PWA document (index.html).
# The app source is artifact-format: <title>… <style>…</style> <markup> <script>…</script>
import re, sys

src = open('app.src.html', encoding='utf-8').read()
assert '</style>' in src, "app.src.html: no </style> found"
head_app, body_app = src.split('</style>', 1)   # head_app = <title>…<style>… ; body_app = markup + script

PWA_HEAD = '''<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Free FDNY firehouse tour-tracking calendar — tours, mutual swaps, overtime, RSOT, time off, and company events. Works fully offline. From NYFireStudyApp.com.">
<meta name="theme-color" content="#f4f1ea">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sq Root Cal">
<meta property="og:title" content="Square Root Calendar">
<meta property="og:description" content="Free FDNY tour-tracking calendar — swaps, mutuals, overtime, time off. Works offline.">
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

open('index.html', 'w', encoding='utf-8').write(out)
print('built index.html (%d bytes) from app.src.html' % len(out))

// Square Root Calendar — subscribable tour feed (iCalendar / RFC 5545).
//
//   GET  /api/ics?t=<32-hex>   -> text/calendar  (this is what Google/Apple subscribe to)
//   POST /api/ics {a:"set",   t, cal:[{uid,s,e,sum}]}   -> replace the feed
//   POST /api/ics {a:"clear", t}                        -> delete it
//
// ⚠️ THIS ENDPOINT IS THE ONE PLACE IN THE APP THAT STORES READABLE USER DATA.
// A subscription URL is a bearer capability: Google's servers have to fetch and read it, and so
// can anyone who gets the link. That is flatly incompatible with the zero-knowledge property the
// sync blob has, which is why the feed is opt-in, carries TOURS ONLY, and uses its own random
// token — not the sync id, not the license id, not the reminder queue id — so a leaked feed URL
// cannot be joined back to a backup, a purchase, or a reminder schedule.
//
// The client sends absolute UTC instants it computed itself, so there is no timezone maths here
// (and no DST bugs): the phone knows the user's zone, the server just formats what it is given.

var REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

var PREFIX = "sqrtcal:ics:";
var TTL = 60 * 60 * 24 * 400;
var MAX_EVENTS = 500;
var MAX_SUM = 120;

function redis(cmd) {
  return fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  }).then(function (r) {
    if (!r.ok) throw new Error("redis " + r.status);
    return r.json();
  }).then(function (j) { return j.result; });
}

function validTok(t) { return typeof t === "string" && /^[0-9a-f]{32}$/.test(t); }
function parseJ(raw, fb) { if (!raw) return fb; try { var v = JSON.parse(raw); return v == null ? fb : v; } catch (e) { return fb; } }

// RFC 5545 §3.3.11. The dangerous character here is a newline: an unescaped one would end the
// property and let a crafted summary inject its own iCalendar lines into everyone's calendar.
function icsText(v) {
  return String(v == null ? "" : v)
    .replace(/\\/g, "\\\\")                  // backslash FIRST — otherwise it doubles the escapes added below
    .replace(/\r\n|\r|\n/g, "\\n")            // then newlines, before they can be stripped as control chars
    .replace(/[\u0000-\u001f\u007f]/g, "")   // anything else non-printable goes
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .slice(0, MAX_SUM);
}
// Content lines are folded at 75 octets (§3.1). Fold on the UTF-8 byte length, not the JS string
// length, or a multi-byte character (an emoji in an event name) can straddle the fold and corrupt.
function fold(line) {
  var out = "", cur = "", bytes = 0;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    var cp = line.codePointAt(i);
    if (cp > 0xffff) { ch = line.slice(i, i + 2); i++; }
    var n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > 73) { out += cur + "\r\n "; cur = ""; bytes = 0; }
    cur += ch; bytes += n;
  }
  return out + cur;
}
function stamp(ms) {
  var d = new Date(ms);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "T" +
         p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
}
function validEv(e) {
  if (!e || typeof e !== "object") return null;
  var s = Date.parse(e.s), en = Date.parse(e.e);
  if (!isFinite(s) || !isFinite(en) || en <= s) return null;
  if (en - s > 48 * 3600 * 1000) return null;                       // a tour is 9h or 15h; anything longer is junk
  if (typeof e.uid !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(e.uid)) return null;
  return { uid: e.uid, s: s, e: en, sum: String(e.sum == null ? "" : e.sum).slice(0, MAX_SUM) };
}

function buildIcs(evs, now) {
  var L = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Square Root Calendar//Tours//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Square Root — My Tours",
    "X-WR-CALDESC:Tours from your Square Root Calendar. Read-only; edit them in the app.",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  for (var i = 0; i < evs.length; i++) {
    var e = evs[i];
    L.push("BEGIN:VEVENT");
    L.push("UID:" + e.uid + "@squarerootcalendar.com");
    L.push("DTSTAMP:" + stamp(now));
    L.push("DTSTART:" + stamp(e.s));
    L.push("DTEND:" + stamp(e.e));
    L.push("SUMMARY:" + icsText(e.sum || "Tour"));
    L.push("TRANSP:OPAQUE");
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") return Promise.resolve(parseJ(req.body, {}));
  return new Promise(function (res) {
    var raw = "";
    req.on("data", function (c) { raw += c; if (raw.length > 800000) raw = raw.slice(0, 800000); });
    req.on("end", function () { res(parseJ(raw, {})); });
    req.on("error", function () { res({}); });
  });
}

module.exports = async function handler(req, res) {
  if (!REST_URL || !REST_TOKEN) { res.status(501).json({ error: "ics-not-enabled" }); return; }
  var q = req.query || {};

  try {
    if (req.method === "GET") {
      var t = q.t;
      if (!validTok(t)) { res.status(400).send("bad token"); return; }
      var evs = parseJ(await redis(["GET", PREFIX + t]), null);
      if (!Array.isArray(evs)) { res.status(404).send("not found"); return; }
      var body = buildIcs(evs, Date.now());
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", 'inline; filename="square-root-tours.ics"');
      res.setHeader("Cache-Control", "public, max-age=1800");   // Google refreshes on its own schedule anyway
      res.status(200).send(body);
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method" }); return; }
    var b = await readBody(req);
    if (!validTok(b.t)) { res.status(400).json({ error: "bad-token" }); return; }

    if (b.a === "clear") { await redis(["DEL", PREFIX + b.t]); res.status(200).json({ ok: true }); return; }

    if (b.a === "set") {
      var raw = Array.isArray(b.cal) ? b.cal : [];
      var out = [], seen = {};
      for (var i = 0; i < raw.length && out.length < MAX_EVENTS; i++) {
        var v = validEv(raw[i]);
        if (!v || seen[v.uid]) continue;
        seen[v.uid] = 1; out.push(v);
      }
      out.sort(function (x, y) { return x.s - y.s; });
      if (!out.length) { await redis(["DEL", PREFIX + b.t]); res.status(200).json({ ok: true, events: 0 }); return; }
      await redis(["SET", PREFIX + b.t, JSON.stringify(out), "EX", String(TTL)]);
      res.status(200).json({ ok: true, events: out.length });
      return;
    }

    res.status(400).json({ error: "bad-action" });
  } catch (e) {
    res.status(500).json({ error: "server" });
  }
};

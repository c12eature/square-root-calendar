// Square Root Calendar — encrypted cloud backup (account-less).
//
// The client derives a per-user id = SHA-256(recovery code) and encrypts the
// whole backup on-device (AES-GCM) with a key ALSO derived from the code.
// The server only ever sees {id, ts, blob} where blob is ciphertext — it can
// neither read the data nor recover the code. No accounts, no PII.
//
//   GET  /api/sync?id=<64-hex>            -> { ts, blob } | 404
//   GET  /api/sync?id=<64-hex>&prev=1     -> the one previous copy (recovery)
//   POST /api/sync  { id, ts, blob, base, force }
//        - optimistic concurrency: rejects with 409 { ts } if the stored copy's
//          ts != base (another device advanced it) unless force is true.
//        - returns { ok:true, ts } where ts is the new (monotonic) server version.
//
// Storage: Upstash Redis via its REST API. Works with either the Vercel-KV /
// Upstash-integration env names or the raw Upstash ones. If neither is set the
// endpoint returns 501 and the app silently falls back to on-device backup.

var crypto = require("crypto");

var REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

var TTL = 60 * 60 * 24 * 400;        // 400 days; refreshed on every push, so active users never expire
var MAX_BLOB = 1500000;              // ~1.5 MB ciphertext cap (a full calendar is a few KB)
var FUTURE_SKEW = 60 * 60 * 24 * 1000; // reject/clamp timestamps more than 1 day in the future
var PREFIX = "sqrtcal:blob:";
var PREV_PREFIX = "sqrtcal:prev:";
var RL_PREFIX = "sqrtcal:rl:";
var RL_WINDOW = 60;                  // seconds
var RL_MAX_WRITE = 40;               // writes / IP / minute
var RL_MAX_READ = 200;              // reads / IP / minute

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

function validId(id) { return typeof id === "string" && /^[0-9a-f]{64}$/.test(id); }

function clientIp(req) {
  var xf = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "";
  var ip = String(xf).split(",")[0].trim() || "unknown";
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16); // hashed — no raw IP stored
}

// returns true if the caller is over the limit
function rateLimited(req, scope, max) {
  var key = RL_PREFIX + scope + ":" + clientIp(req);
  return redis(["INCR", key]).then(function (n) {
    if (n === 1) { redis(["EXPIRE", key, String(RL_WINDOW)]).catch(function () {}); }
    return n > max;
  }).catch(function () { return false; }); // fail-open: never block a legit user on a limiter hiccup
}

function readBody(req) {
  if (req.body != null && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve(null); } }
  return new Promise(function (resolve) {
    var d = "";
    req.on("data", function (c) { d += c; if (d.length > 2100000) { try { req.destroy(); } catch (e) {} resolve(null); } });
    req.on("end", function () { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve(null); } });
    req.on("error", function () { resolve(null); });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REST_URL || !REST_TOKEN) { res.status(501).json({ error: "cloud-not-configured" }); return; }

  try {
    if (req.method === "GET") {
      var id = (req.query && req.query.id) || "";
      if (!validId(id)) { res.status(400).json({ error: "bad-id" }); return; }
      if (await rateLimited(req, "r", RL_MAX_READ)) { res.status(429).json({ error: "rate-limited" }); return; }
      var wantPrev = req.query && (req.query.prev === "1" || req.query.prev === 1);
      var v = await redis(["GET", (wantPrev ? PREV_PREFIX : PREFIX) + id]);
      if (v == null) { res.status(404).json({ error: "not-found" }); return; }
      var rec; try { rec = JSON.parse(v); } catch (e) { rec = null; }
      if (!rec || typeof rec.blob !== "string") { res.status(404).json({ error: "not-found" }); return; }
      res.status(200).json({ ts: rec.ts || 0, blob: rec.blob });
      return;
    }

    if (req.method === "POST") {
      if (await rateLimited(req, "w", RL_MAX_WRITE)) { res.status(429).json({ error: "rate-limited" }); return; }
      var body = await readBody(req);
      if (!body) { res.status(400).json({ error: "bad-body" }); return; }
      var pid = body.id, blob = body.blob;
      if (!validId(pid)) { res.status(400).json({ error: "bad-id" }); return; }
      if (typeof blob !== "string" || !blob || blob.length > MAX_BLOB) { res.status(400).json({ error: "bad-blob" }); return; }
      var now = Date.now();
      var ts = (typeof body.ts === "number" && isFinite(body.ts) && body.ts > 0 && body.ts <= now + FUTURE_SKEW) ? body.ts : now;
      var base = (typeof body.base === "number" && isFinite(body.base)) ? body.base : 0;
      var force = body.force === true;

      var existRaw = await redis(["GET", PREFIX + pid]);
      var exist = null;
      if (existRaw) { try { exist = JSON.parse(existRaw); } catch (e) { exist = null; } }

      // optimistic concurrency: another device advanced the copy since this one last synced
      if (exist && !force && (exist.ts || 0) !== base) {
        res.status(409).json({ error: "conflict", ts: exist.ts || 0 });
        return;
      }

      var newTs = Math.max(ts, (exist && exist.ts ? exist.ts : 0) + 1); // strictly monotonic
      if (existRaw) { try { await redis(["SET", PREV_PREFIX + pid, existRaw, "EX", String(TTL)]); } catch (e) {} } // recoverable previous copy
      await redis(["SET", PREFIX + pid, JSON.stringify({ ts: newTs, blob: blob }), "EX", String(TTL)]);
      res.status(200).json({ ok: true, ts: newTs });
      return;
    }

    res.status(405).json({ error: "method-not-allowed" });
  } catch (e) {
    res.status(500).json({ error: "server-error" });
  }
};

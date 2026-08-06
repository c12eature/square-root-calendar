// Square Root Calendar — personal reminders, end-to-end encrypted.
//
// This endpoint is a dumb alarm clock. Per queue it holds only:
//   · when to ring (epoch ms)
//   · an opaque ciphertext to hand straight back
// It cannot read what a single reminder says. The title and body are AES-GCM
// encrypted on the phone with a key that never reaches this server (it rides
// only the user's own end-to-end-encrypted backup), and the service worker
// decrypts the payload when the push lands. What IS visible here is that a
// given queue id wants to be pinged at a given minute — the privacy policy
// says so, because pretending otherwise would be a lie.
//
// The queue id is NOT the sync/license id: it is its own random value, so a
// reminder schedule can't be tied back to a backup blob or a Stripe purchase.
//
//   POST /api/remind  {a:"sub",   qid, sub}                  register this device
//   POST /api/remind  {a:"unsub", qid, endpoint}             drop one device
//   POST /api/remind  {a:"set",   qid, items:[{rid,at,ct}]}  REPLACE the whole queue
//   POST /api/remind?a=cron   (Authorization: Bearer CRON_SECRET)
//
// The client always sends the FULL upcoming queue rather than a diff: it is
// idempotent, a dropped request self-heals on the next edit, and there is no
// partial state to reconcile. Storage: Upstash Redis over its REST API; with
// no credentials configured every route answers 501 and the app just doesn't
// offer reminders.

var REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
var VAPID_PUBLIC = process.env.VAPID_PUBLIC || "";
var VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
var VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@squarerootcalendar.com";
var CRON_SECRET = process.env.CRON_SECRET || "";

var Q_PREFIX = "sqrtcal:rq:";        // sqrtcal:rq:<qid>  -> JSON [{rid,at,ct}]
var S_PREFIX = "sqrtcal:rs:";        // sqrtcal:rs:<qid>  -> JSON [subscription, ...]
var DUE_ZSET = "sqrtcal:rdue";       // member = qid, score = that queue's NEXT due time
var TTL = 60 * 60 * 24 * 400;
var MAX_ITEMS = 200;                 // upcoming reminders per user
var MAX_CT = 4096;                   // ciphertext bytes per reminder
var MAX_SUBS = 6;                    // devices per queue
var MAX_CRON = 300;                  // queues fired per run — bounds the function against the timeout
var GRACE = 2 * 60 * 60 * 1000;      // a reminder more than 2h late is dropped, not rung at the wrong time
var EARLY = 30 * 1000;               // fire up to 30s early so a 15-min cron doesn't systematically run late
var FUTURE = 400 * 24 * 60 * 60 * 1000;

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

var _wp = null, _wpTried = false;
function webpush() {
  if (_wpTried) return _wp;
  _wpTried = true;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return (_wp = null);
  try { _wp = require("web-push"); _wp.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); } catch (e) { _wp = null; }
  return _wp;
}

function validQid(q) { return typeof q === "string" && /^[0-9a-f]{32}$/.test(q); }
function parseJ(raw, fb) { if (!raw) return fb; try { var v = JSON.parse(raw); return v == null ? fb : v; } catch (e) { return fb; } }
function validSub(s) {
  return s && typeof s === "object" && typeof s.endpoint === "string" &&
    /^https:\/\//.test(s.endpoint) && s.endpoint.length < 800 && s.keys && typeof s.keys === "object" &&
    typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
}
// Keep only what we can actually act on. Anything malformed is dropped silently — a bad row must
// never be able to stall the whole queue.
function cleanItems(items, now) {
  if (!Array.isArray(items)) return [];
  var out = [], seen = {};
  for (var i = 0; i < items.length && out.length < MAX_ITEMS; i++) {
    var it = items[i];
    if (!it || typeof it !== "object") continue;
    var at = +it.at, rid = it.rid, ct = it.ct;
    if (!isFinite(at) || at < now - GRACE || at > now + FUTURE) continue;
    if (typeof rid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rid)) continue;
    if (typeof ct !== "string" || !ct || ct.length > MAX_CT) continue;
    if (seen[rid]) continue;
    seen[rid] = 1;
    out.push({ rid: rid, at: at, ct: ct });
  }
  out.sort(function (a, b) { return a.at - b.at; });
  return out;
}
// One ZSET entry per queue, scored by its EARLIEST pending reminder — so the cron reads a handful
// of due queues instead of scanning every user.
function reindex(qid, items) {
  if (!items.length) return redis(["ZREM", DUE_ZSET, qid]);
  return redis(["ZADD", DUE_ZSET, String(items[0].at), qid]);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") return Promise.resolve(parseJ(req.body, {}));
  return new Promise(function (res) {
    var raw = ""; req.on("data", function (c) { raw += c; if (raw.length > 1500000) raw = raw.slice(0, 1500000); });
    req.on("end", function () { res(parseJ(raw, {})); });
    req.on("error", function () { res({}); });
  });
}

module.exports = async function handler(req, res) {
  if (!REST_URL || !REST_TOKEN) { res.status(501).json({ error: "reminders-not-enabled" }); return; }
  var q = req.query || {};
  var H = req.headers || {};

  try {
    // ---- the alarm bell: fire everything that has come due ----
    if (q.a === "cron") {
      if (!CRON_SECRET || (H["authorization"] || "") !== "Bearer " + CRON_SECRET) { res.status(401).json({ error: "bad-cron" }); return; }
      var wp = webpush();
      if (!wp) { res.status(200).json({ ok: true, sent: 0, note: "push-not-configured" }); return; }
      var now = Date.now();
      var dueQids = (await redis(["ZRANGE", DUE_ZSET, "0", String(now + EARLY), "BYSCORE", "LIMIT", "0", String(MAX_CRON)])) || [];
      var sent = 0, dropped = 0, queues = 0;

      for (var i = 0; i < dueQids.length; i++) {
        var qid = dueQids[i];
        if (!validQid(qid)) { await redis(["ZREM", DUE_ZSET, qid]).catch(function () {}); continue; }
        queues++;
        var items = parseJ(await redis(["GET", Q_PREFIX + qid]), []);
        if (!Array.isArray(items) || !items.length) { await redis(["ZREM", DUE_ZSET, qid]).catch(function () {}); continue; }

        var fire = [], keep = [];
        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          if (!it || !isFinite(+it.at)) continue;
          if (+it.at > now + EARLY) { keep.push(it); continue; }
          if (now - +it.at > GRACE) { dropped++; continue; }   // too stale to be useful — ringing now would be worse than not ringing
          fire.push(it);
        }

        if (fire.length) {
          var subs = parseJ(await redis(["GET", S_PREFIX + qid]), []);
          if (Array.isArray(subs) && subs.length) {
            var alive = subs.slice();
            for (var k = 0; k < fire.length; k++) {
              for (var s = 0; s < subs.length; s++) {
                var sub = subs[s];
                if (!validSub(sub)) continue;
                try {
                  // `enc` is the whole point: the server relays a blob it cannot read.
                  await wp.sendNotification({ endpoint: sub.endpoint, keys: sub.keys },
                    JSON.stringify({ enc: fire[k].ct, tag: "rem-" + fire[k].rid, url: "/" }), { timeout: 3000 });
                  sent++;
                } catch (err) {
                  if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                    alive = alive.filter(function (x) { return x.endpoint !== sub.endpoint; });   // subscription is gone for good
                  }
                }
              }
            }
            if (alive.length !== subs.length) {
              if (alive.length) await redis(["SET", S_PREFIX + qid, JSON.stringify(alive), "EX", String(TTL)]).catch(function () {});
              else await redis(["DEL", S_PREFIX + qid]).catch(function () {});
            }
          }
        }

        if (keep.length) await redis(["SET", Q_PREFIX + qid, JSON.stringify(keep), "EX", String(TTL)]).catch(function () {});
        else await redis(["DEL", Q_PREFIX + qid]).catch(function () {});
        await reindex(qid, keep).catch(function () {});
      }
      res.status(200).json({ ok: true, queues: queues, sent: sent, dropped: dropped });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method" }); return; }
    var body = await readBody(req);
    var a = body.a || q.a;
    var qid2 = body.qid;
    if (!validQid(qid2)) { res.status(400).json({ error: "bad-qid" }); return; }

    if (a === "sub") {
      if (!validSub(body.sub)) { res.status(400).json({ error: "bad-sub" }); return; }
      var cur = parseJ(await redis(["GET", S_PREFIX + qid2]), []);
      if (!Array.isArray(cur)) cur = [];
      cur = cur.filter(function (x) { return validSub(x) && x.endpoint !== body.sub.endpoint; });
      cur.unshift({ endpoint: body.sub.endpoint, keys: { p256dh: body.sub.keys.p256dh, auth: body.sub.keys.auth } });
      if (cur.length > MAX_SUBS) cur = cur.slice(0, MAX_SUBS);
      await redis(["SET", S_PREFIX + qid2, JSON.stringify(cur), "EX", String(TTL)]);
      res.status(200).json({ ok: true, devices: cur.length });
      return;
    }

    if (a === "unsub") {
      var cur2 = parseJ(await redis(["GET", S_PREFIX + qid2]), []);
      if (!Array.isArray(cur2)) cur2 = [];
      var ep = typeof body.endpoint === "string" ? body.endpoint : "";
      cur2 = cur2.filter(function (x) { return validSub(x) && x.endpoint !== ep; });
      if (cur2.length) await redis(["SET", S_PREFIX + qid2, JSON.stringify(cur2), "EX", String(TTL)]);
      else { await redis(["DEL", S_PREFIX + qid2]); await redis(["DEL", Q_PREFIX + qid2]); await redis(["ZREM", DUE_ZSET, qid2]); }   // last device off → nothing left to ring, drop the schedule too
      res.status(200).json({ ok: true, devices: cur2.length });
      return;
    }

    if (a === "set") {
      var items2 = cleanItems(body.items, Date.now());
      if (!items2.length) {
        await redis(["DEL", Q_PREFIX + qid2]);
        await redis(["ZREM", DUE_ZSET, qid2]);
        res.status(200).json({ ok: true, queued: 0 });
        return;
      }
      await redis(["SET", Q_PREFIX + qid2, JSON.stringify(items2), "EX", String(TTL)]);
      await reindex(qid2, items2);
      res.status(200).json({ ok: true, queued: items2.length, next: items2[0].at });
      return;
    }

    res.status(400).json({ error: "bad-action" });
  } catch (e) {
    res.status(500).json({ error: "server" });
  }
};

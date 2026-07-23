// Square Root Calendar — Stripe billing (one serverless function).
//
//   POST /api/billing                 Stripe webhook (signature-verified). Grants/updates entitlements.
//   GET  /api/billing?check=<id>      App-unlock check for a license id → {app:true|false}
//
// LICENSE MODEL (no accounts): the client derives a license id from the user's recovery code
// (id = SHA-256("sqrtcal-id-v1:" + code)) and passes it to Stripe as client_reference_id:
//   "app_<licenseId>"  — the $9.99 one-time unlock  → permanent key  sqrtcal:ent:app:<licenseId>
//   "house_<houseId>"  — the House subscription     → status key     sqrtcal:ent:house:<houseId>
// (underscore separator — Stripe silently DROPS client_reference_id values containing a colon)
// The raw recovery code NEVER reaches this server — only its hash.
//
// Env: STRIPE_WEBHOOK_SECRET (whsec_…), KV_REST_API_URL/TOKEN (same Upstash as the rest of the app).

var crypto = require("crypto");
var REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
var WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
var ENT_APP = "sqrtcal:ent:app:";     // "1" = paid forever (no TTL)
var ENT_HOUSE = "sqrtcal:ent:house:"; // JSON {st:"active"|"past_due"|"canceled", end:<epoch ms of paid-through>}
var SUBMAP = "sqrtcal:submap:";       // stripe subscription id → houseId (later lifecycle events don't carry client_reference_id)
var PIMAP = "sqrtcal:pimap:";         // payment_intent → licenseId, so a refund/dispute can revoke the app unlock
var EVSEEN = "sqrtcal:evt:";          // processed Stripe event ids — replay/duplicate guard
var DAY = 864e5;

function redis(cmd) {
  return fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  }).then(function (r) { if (!r.ok) throw new Error("redis " + r.status); return r.json(); })
    .then(function (j) { return j.result; });
}
function validId(s) { return typeof s === "string" && /^[a-f0-9]{24,64}$/.test(s); }   // sha-256 hex (or the house id) — nothing else ever hits a key
// Invoice.subscription moved to invoice.parent.subscription_details.subscription in Stripe API 2025-03-31 (Basil); accept both shapes.
function invSub(inv) { return String((inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || inv.subscription || ""); }
async function getHouseEnt(hid) { try { var r = await redis(["GET", ENT_HOUSE + hid]); return r ? JSON.parse(r) : null; } catch (e) { return null; } }

// Verify Stripe's webhook signature (t=…,v1=… header; HMAC-SHA256 of "<t>.<rawBody>").
function sigOK(raw, header) {
  if (!WH_SECRET || !header) return false;
  var t = null, v1s = [];
  header.split(",").forEach(function (p) { var kv = p.split("="); if (kv[0] === "t") t = kv[1]; if (kv[0] === "v1") v1s.push(kv[1]); });
  if (!t || !v1s.length) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(t, 10)) > 300) return false;   // 5-minute tolerance window
  var expect = crypto.createHmac("sha256", WH_SECRET).update(t + "." + raw).digest("hex");
  return v1s.some(function (v) {
    try { return v.length === expect.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expect)); } catch (e) { return false; }
  });
}
function readRaw(req) {
  return new Promise(function (res, rej) {
    var chunks = []; var n = 0;
    req.on("data", function (c) { n += c.length; if (n > 262144) { rej(new Error("too-big")); req.destroy(); return; } chunks.push(c); });
    req.on("end", function () { res(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", rej);
  });
}

module.exports = async function (req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!REST_URL || !REST_TOKEN) { res.status(503).json({ error: "billing-not-configured" }); return; }
    var q = {}; (req.url.split("?")[1] || "").split("&").forEach(function (p) { var kv = p.split("="); if (kv[0]) q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ""); });

    if (req.method === "GET" && q.grant) {   // owner-only: re-link a verified purchase to a customer's NEW license id (lost recovery code — verify the payment in Stripe first)
      var admin = process.env.CRON_SECRET || "";
      var key = String(q.key || "");
      var okKey = false;
      try { okKey = !!admin && key.length === admin.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(admin)); } catch (e) {}
      if (!okKey) { res.status(403).json({ error: "forbidden" }); return; }
      var gid = String(q.grant);
      if (!validId(gid)) { res.status(400).json({ error: "bad-id" }); return; }
      await redis(["SET", ENT_APP + gid, "1"]);
      res.status(200).json({ granted: true, id: gid });
      return;
    }
    if (req.method === "GET") {   // entitlement check — safe to expose: knowing a hash is entitled reveals nothing about who
      var id = String(q.check || "");
      if (!validId(id)) { res.status(400).json({ error: "bad-id" }); return; }
      var ent = await redis(["GET", ENT_APP + id]);
      res.status(200).json({ app: ent === "1" });
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ error: "method-not-allowed" }); return; }

    var raw = await readRaw(req);
    if (!sigOK(raw, req.headers["stripe-signature"])) { res.status(400).json({ error: "bad-signature" }); return; }
    var ev; try { ev = JSON.parse(raw); } catch (e) { res.status(400).json({ error: "bad-json" }); return; }
    var obj = (ev.data && ev.data.object) || {};

    if (ev.id) {   // process each Stripe event exactly once — blocks replays of captured payloads and duplicate deliveries
      var first = await redis(["SET", EVSEEN + String(ev.id), "1", "NX", "EX", "259200"]);
      if (first === null) { res.status(200).json({ received: true, dup: true }); return; }
    }

    if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {   // async = delayed-notification methods (ACH etc.) paying after the session closed
      var ref = String(obj.client_reference_id || "");
      if (ref.indexOf("app_") === 0 && obj.mode === "payment" && (obj.payment_status === "paid" || obj.payment_status === "no_payment_required")) {   // no_payment_required = a 100%-off promo code — comped copies go through the same pipeline
        var lid = ref.slice(4);
        if (validId(lid)) {
          await redis(["SET", ENT_APP + lid, "1"]);   // permanent — a one-time purchase never expires
          if (obj.payment_intent) await redis(["SET", PIMAP + String(obj.payment_intent), lid, "EX", "15552000"]);   // 180d — covers the refund + dispute windows
        }
      } else if (ref.indexOf("house_") === 0 && obj.mode === "subscription" && obj.subscription) {
        var hid = ref.slice(6);
        if (validId(hid)) {
          await redis(["SET", SUBMAP + String(obj.subscription), hid]);   // remember which house this subscription pays for
          await redis(["SET", ENT_HOUSE + hid, JSON.stringify({ st: "active", end: Date.now() + 35 * DAY, sub: String(obj.subscription) })]);   // provisional month window; invoice.paid refines it to the real period end
        }
      }
    } else if (ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded") {
      var sub1 = invSub(obj); if (sub1) {
        var h1 = await redis(["GET", SUBMAP + sub1]);
        if (h1) {
          var cur1 = await getHouseEnt(h1);
          if (!(cur1 && cur1.st === "canceled" && (!cur1.sub || cur1.sub === sub1))) {   // a late invoice for the sub that was just canceled must not resurrect it (a NEW sub's invoice may)
            var pe = 0; try { pe = (obj.lines.data[0].period.end || 0) * 1000; } catch (e) {}
            await redis(["SET", ENT_HOUSE + h1, JSON.stringify({ st: "active", end: (pe || Date.now() + 35 * DAY), sub: sub1 })]);
          }
        }
      }
    } else if (ev.type === "invoice.payment_failed") {
      var sub2 = invSub(obj); if (sub2) {
        var h2 = await redis(["GET", SUBMAP + sub2]);
        if (h2) {
          var cur = await getHouseEnt(h2);
          if (!(cur && ((cur.sub && cur.sub !== sub2) || cur.st === "canceled")))   // a stale sub can't downgrade the current one, and an explicit cancel never earns grace
            await redis(["SET", ENT_HOUSE + h2, JSON.stringify({ st: "past_due", end: (cur && cur.end) || Date.now(), sub: sub2 })]);
        }
      }
    } else if (ev.type === "customer.subscription.deleted") {
      var sub3 = String(obj.id || ""); if (sub3) {
        var h3 = await redis(["GET", SUBMAP + sub3]);
        if (h3) {
          var cur3 = await getHouseEnt(h3);
          if (!cur3 || !cur3.sub || cur3.sub === sub3)   // only the house's CURRENT paying sub can cancel it — a stale one can't clobber a fresh subscription
            await redis(["SET", ENT_HOUSE + h3, JSON.stringify({ st: "canceled", end: Date.now(), sub: sub3 })]);
        }
        await redis(["DEL", SUBMAP + sub3]);   // a dead sub can never resolve to the house again
      }
    } else if (ev.type === "charge.refunded" || ev.type === "charge.dispute.created") {
      var pi = String(obj.payment_intent || "");
      var full = ev.type === "charge.dispute.created" || obj.refunded === true || (obj.amount_refunded > 0 && obj.amount_captured > 0 && obj.amount_refunded >= obj.amount_captured);
      if (pi && full) {   // money went back (or is contested) → the app unlock goes with it
        var lid3 = await redis(["GET", PIMAP + pi]);
        if (lid3 && validId(lid3)) await redis(["DEL", ENT_APP + lid3]);
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).json({ error: "server-error" });
  }
};

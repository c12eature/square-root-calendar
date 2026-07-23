// Square Root Calendar — House Calendar (shared, multi-user firehouse sync).
//
// Unlike api/sync.js (a zero-knowledge encrypted backup of ONE person's data),
// this stores a SHARED house document the server can read + merge, so a whole
// firehouse can coordinate. Identity is device-bound with NO login:
//   memberId = SHA-256(secret); the caller proves ownership by sending the
//   secret, and the server checks SHA-256(secret) === memberId. The secret never
//   leaves the device except as this proof; it is not stored server-side.
//
//   POST /api/house?a=create  { m, s, house, <profile> }       -> { doc }         (creator = founder+admin+active; house = house name)
//   POST /api/house?a=join     { code, m, s, <profile> }         -> { pending } | { doc } (already-active only)
//   GET  /api/house?id  (m + s in X-House-M / X-House-S headers) -> { doc } (active) | { pending } | 404
//   POST /api/house           { id, m, s, base, op:{type,...} }  -> { doc } (409 { ver, doc } on stale base) | { left:true }
// <profile> = { name, company, group(1-25), letter(A-D), phone, spouse, spousePhone, duty:[{t,s,e}] }
//
// Ops (server-enforced authz): member = updateProfile, leave, createRequest,
// cancelRequest, takeRequest, resolveRequest; admin = approve, reject, remove,
// promote, demote, setCompanies, abcdPush, postEvent, delEvent, rotateCode.
// Company + group are ADMIN-owned after join/approve (updateProfile can't change them).
//
// Concurrency: every write is an atomic compare-and-set (Lua EVAL) on the exact
// prior JSON, so no read-modify-write can silently clobber a concurrent write.
// Only ACTIVE members ever receive the full doc; pending/removed callers never do.
//
// Storage: Upstash Redis REST (same env as sync.js). 501 if unconfigured.

var crypto = require("crypto");

var REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

var TTL = 60 * 60 * 24 * 400;            // 400 days, refreshed on write
var HOUSE_PREFIX = "sqrtcal:house:";
var CODE_PREFIX = "sqrtcal:hcode:";
var HOUSES_SET = "sqrtcal:houses";       // registry of house ids (for the tour-reminder cron to enumerate)
var CRON_SECRET = process.env.CRON_SECRET || "";
var PREF_DEFAULT = { personal: true, general: false, tours: true };   // general (open-board) push is opt-in; personal + tour reminders default on

// ---- square-root schedule engine (ported from the client; pure math) ----
function emod(n, m) { return ((n % m) + m) % m; }
var G = 25, BLK = 6, STEP = 3, ANCHOR = Date.UTC(2026, 7, 1), ANCHOR_DS = 20;   // Aug 1 2026 → day-tour start group 20
function dnum(y, m, d) { return Math.round((Date.UTC(y, m, d) - ANCHOR) / 864e5); }
function dayStart(y, m, d) { return emod(ANCHOR_DS - 1 + STEP * dnum(y, m, d), G) + 1; }
function nightStart(y, m, d) { return emod(dayStart(y, m, d) - 1 - 10, G) + 1; }
function hasGrp(s, grp) { for (var i = 0; i < BLK; i++) if (emod(s - 1 + i, G) + 1 === grp) return true; return false; }
var ABCD_ANCHOR = Date.UTC(2026, 6, 1), ABCD_IDX = 2, LTRS = "ABCD";   // Jul 1 2026 = C
function abcdLetter(y, m, d) { return LTRS.charAt(emod(Math.round((Date.UTC(y, m, d) - ABCD_ANCHOR) / 864e5) + ABCD_IDX, 4)); }
function dms(iso) { var p = String(iso || "").split("-"); return Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
function houseAbcdOn(doc, t) { if (!doc.abcd || !/^\d{4}-\d\d?-\d\d?$/.test(doc.abcd.s)) return false; var s = dms(doc.abcd.s), e = doc.abcd.e ? dms(doc.abcd.e) : Infinity; return t >= s && t <= e; }
function memberOffOn(mem, t) { var ds = mem.duty || []; for (var i = 0; i < ds.length; i++) { var s = dms(ds[i].s), e = ds[i].e ? dms(ds[i].e) : Infinity; if (t >= s && t <= e) return true; } return false; }
function memberWorksTour(doc, mem, y, m, d, tour) {   // mirrors the client memberWorks + memberRSOT − memberOff
  var t = Date.UTC(y, m, d);
  if (memberOffOn(mem, t)) return false;
  var iso = y + "-" + (m + 1 < 10 ? "0" : "") + (m + 1) + "-" + (d < 10 ? "0" : "") + d, ot = mem.ot || [];
  for (var i = 0; i < ot.length; i++) if (ot[i].t === tour && ot[i].d === iso) return true;   // RSOT pickup counts on ANY chart (mirrors the client's independent memberRSOT, incl. during an ABCD window)
  if (houseAbcdOn(doc, t)) return !!(mem.letter && abcdLetter(y, m, d) === mem.letter);
  if (mem.group && hasGrp(tour === 9 ? dayStart(y, m, d) : nightStart(y, m, d), mem.group)) return true;
  return false;
}
function isoOf(t) { return t.y + "-" + (t.m + 1 < 10 ? "0" : "") + (t.m + 1) + "-" + (t.d < 10 ? "0" : "") + t.d; }
function hasRSOT(mem, tour) {   // does this member hold an RSOT (scheduled OT) on this exact tour? tour = {y,m,d,t}
  if (!mem || !tour) return false;
  var iso = isoOf(tour), ot = mem.ot || [];
  for (var i = 0; i < ot.length; i++) if (ot[i].t === tour.t && ot[i].d === iso) return true;
  return false;
}
// FDNY rule: an RSOT (overtime) tour may only be swapped for another RSOT — never a regular tour.
// A swap is valid only when BOTH sides are RSOT, or BOTH sides are non-RSOT.
function rsotSwapOK(giver, giveTour, taker, wantTour) { return hasRSOT(giver, giveTour) === hasRSOT(taker, wantTour); }
// give side of a swap = the RSOT status the poster stamped at create time (unbounded, not the ±130d .ot window); falls back to the live .ot for legacy requests
function giveSideRsot(doc, req) { return (typeof req.giveRsot === "boolean") ? req.giveRsot : hasRSOT(doc.members[req.by], req.tour); }
// when a member leaves/is removed: retire their live requests + drop any partner link pointing at them (no dangling refs)
function cancelMemberReqs(doc, who) {
  var told = [];   // counterparts of cancelled TAKEN deals — they were planning around the agreement and deserve a push
  (doc.requests || []).forEach(function (r) { if ((r.by === who || r.takenBy === who) && (r.status === "open" || r.status === "taken")) {
    if (r.status === "taken") { var other = (r.by === who) ? r.takenBy : r.by; if (other && other !== who && told.indexOf(other) < 0) told.push(other); }
    r.status = "cancelled"; r.takenBy = ""; } });
  Object.keys(doc.members || {}).forEach(function (id) { if (doc.members[id].partner === who) delete doc.members[id].partner; });
  return told;
}
function sameTour(a, b) { return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d && a.t === b.t; }
function gaveAway(r, mid, tour) { return (r.by === mid && sameTour(r.tour, tour)) || (r.takenBy === mid && sameTour(r.want, tour)); }   // mid handed this tour OFF in r (poster's give, or taker's hand-back)
function reGained(r, mid, tour) { return (r.by === mid && sameTour(r.want, tour)) || (r.takenBy === mid && sameTour(r.tour, tour)); }   // mid RECEIVED this tour in r
// Does `mid` currently NOT hold `tour` because it's spoken for? NET ownership: any in-flight (taken) hand-off blocks; otherwise the LATEST completed (done) action on this exact tour decides — a hand-off keeps it committed, but a later re-gain frees it so the tour can be swapped onward again.
function tourCommitted(doc, mid, tour, exceptId) {
  if (!tour) return false;
  var reqs = doc.requests || [], latest = null;
  for (var i = 0; i < reqs.length; i++) { var r = reqs[i];
    if (r.id === exceptId) continue;
    if (r.status === "taken" && gaveAway(r, mid, tour)) return true;   // a pending deal already committed this tour
    if (r.status === "done" && (gaveAway(r, mid, tour) || reGained(r, mid, tour)) && (!latest || (r.doneAt || r.at) > (latest.doneAt || latest.at))) latest = r;   // order by COMPLETION time — an old open request taken late must not outrank an earlier re-gain
  }
  return !!latest && gaveAway(latest, mid, tour);
}
function tourFuture(t) { if (!t) return false; var et = etParts(); return Date.UTC(t.y, t.m, t.d) >= Date.UTC(et.y, et.m, et.d); }
function tourFarFuture(t) { if (!t) return false; var et = etParts(); return Date.UTC(t.y, t.m, t.d) - Date.UTC(et.y, et.m, et.d) > 130 * 864e5; }   // beyond the ~130-day myRsotList sync horizon — a member's synced .ot list is BLIND here, not authoritative
function reqTouchesFuture(r) { return tourFuture(r.tour) || tourFuture(r.want); }
function etParts() {   // current wall-clock date + hour in America/New_York (DST handled by Intl)
  var f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false });
  var p = {}; f.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
  return { y: +p.year, m: (+p.month) - 1, d: +p.day, hour: (+p.hour) % 24 };
}
var RL_PREFIX = "sqrtcal:hrl:";
var RL_WINDOW = 60, RL_MAX = 150;        // requests / IP / minute (clients poll + mutate)
var MAX_MEMBERS = 400, MAX_PENDING = 30, MAX_CO = 24, MAX_EVENTS = 300, MAX_REQ = 500, TERMINAL_KEEP = 100, MAX_BANNED = 500;
var MAX_CRON_HOUSES = 5000, MAX_CREATE_PER_DAY = 20;   // bound cron per-run cost; cap house creation per IP/day (anti-abuse)
var NAME_MAX = 60, CO_MAX = 24, PHONE_MAX = 40, DUTY_MAX = 24, NOTE_MAX = 240, EV_DATES_MAX = 60;

function redis(cmd) {
  return fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  }).then(function (r) { if (!r.ok) throw new Error("redis " + r.status); return r.json(); })
    .then(function (j) { return j.result; });
}
// ---- House subscription (set by api/billing.js from Stripe webhooks) ----
// Every house gets a free trial from creation; after that a live subscription (sqrtcal:ent:house:<id>)
// keeps it read-write. Lapsed = reads still work (with a flag the client banners), writes 402 except "leave".
// Known accepted risk: a crew could dodge paying by re-creating the house every 30 days — but that wipes
// all history/requests and forces every member to rejoin, which is deterrent enough for a $20/mo product.
var SUB_TRIAL_DAYS = (function () { var n = parseInt(process.env.SUB_TRIAL_DAYS || "30", 10); return isFinite(n) && n > 0 ? n : 30; })();
var SUB_GRACE_DAYS = 7;
async function houseSubStatus(doc) {
  var now = Date.now(), ent = null, raw = null;
  try { raw = await redis(["GET", "sqrtcal:ent:house:" + doc.id]); }
  catch (e) { return { mode: "active", daysLeft: 1, degraded: true }; }   // billing store unreachable ≠ unpaid — fail open, never 402 a paid house on an infra blip
  try { if (raw) ent = JSON.parse(raw); } catch (e) {}
  if (ent) {
    if (ent.st === "active" && ent.end > now) return { mode: "active", daysLeft: Math.ceil((ent.end - now) / 864e5) };
    if (ent.end + SUB_GRACE_DAYS * 864e5 > now && ent.st !== "canceled") return { mode: "grace", daysLeft: Math.ceil((ent.end + SUB_GRACE_DAYS * 864e5 - now) / 864e5) };   // payment hiccup ≠ instant lockout
    return { mode: "lapsed", daysLeft: 0 };
  }
  var trialEnd = (doc.createdAt || 0) + SUB_TRIAL_DAYS * 864e5;
  if (trialEnd > now) return { mode: "trial", daysLeft: Math.ceil((trialEnd - now) / 864e5) };
  return { mode: "lapsed", daysLeft: 0 };
}
// ---- Web Push (VAPID) ----
// Public key is embedded in the client (safe); the PRIVATE key is env-only, never committed.
// Subscriptions are stored in a PRIVATE per-member key (never in the house doc), so no member
// can see another's push endpoint. web-push is lazy-required + no-ops without keys/dep, so the
// backend still runs locally without the package or env set.
var VAPID_PUBLIC = process.env.VAPID_PUBLIC || "";
var VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
var VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@squarerootcalendar.com";
var PUSH_PREFIX = "sqrtcal:push:";
// Only these real push-service origins are accepted as subscription endpoints — blocks SSRF via a hostile endpoint.
var PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com"];
var PUSH_SUFFIX = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];
function validPushEndpoint(u) {
  if (typeof u !== "string" || u.length > 1000) return false;
  var url; try { url = new URL(u); } catch (e) { return false; }
  if (url.protocol !== "https:") return false;
  var h = url.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(":") >= 0) return false;   // no IP-literal hosts
  if (PUSH_HOSTS.indexOf(h) >= 0) return true;
  for (var i = 0; i < PUSH_SUFFIX.length; i++) { var suf = PUSH_SUFFIX[i]; if (h.length > suf.length && h.slice(-suf.length) === suf) return true; }
  return false;
}
var _wp = null, _wpTried = false;
function webpush() {
  if (_wpTried) return _wp; _wpTried = true;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return null;
  try { _wp = require("web-push"); _wp.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); } catch (e) { _wp = null; }
  return _wp;
}
function sendPush(mid, payload, category) {
  var wp = webpush(); if (!wp || !mid) return Promise.resolve();
  return redis(["GET", PUSH_PREFIX + mid]).then(function (raw) {
    if (!raw) return; var rec; try { rec = JSON.parse(raw); } catch (e) { return; }
    var prefs = rec.prefs || PREF_DEFAULT;
    if (category && prefs[category] === false) return;   // this device opted out of this notification category
    return wp.sendNotification({ endpoint: rec.endpoint, keys: rec.keys }, JSON.stringify(payload), { timeout: 3000 }).catch(function (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) redis(["DEL", PUSH_PREFIX + mid]).catch(function () {});   // dead subscription → drop it
    });
  }).catch(function () {});
}
function nameOf(doc, id) { return (doc.members[id] && doc.members[id].name) || "A crewmember"; }
function reqVerbTo(r) { return r.type === "swap" ? "wants to swap a tour with you" : r.type === "cover" ? "needs a tour covered" : "is looking to pick up a tour"; }
function reqVerbGen(r) { return r.type === "swap" ? "posted a swap" : r.type === "cover" ? "needs a tour covered" : "is looking to pick up a tour"; }
// Members to notify after a request op, each tagged with a category the recipient can toggle off.
function notifyForOp(doc, op, actor) {
  var t = op && op.type, out = [];
  if (t === "createRequest") {
    var r = doc.requests[doc.requests.length - 1]; if (!r) return out;
    if (r.to) out.push({ to: r.to, category: "personal", title: "🔁 " + nameOf(doc, actor), body: nameOf(doc, actor) + " " + reqVerbTo(r) });
    else Object.keys(doc.members).forEach(function (k) { if (k !== actor && doc.members[k].status === "active") out.push({ to: k, category: "general", title: "🔁 New tour request", body: nameOf(doc, actor) + " " + reqVerbGen(r) }); });   // open board → fan out to opted-in members
  }
  else if (t === "takeRequest") { var rt = findReq(doc, op.rid); if (rt && rt.by && rt.by !== actor) out.push({ to: rt.by, category: "personal", title: rt.even ? "🤝 Partner swap confirmed" : "✅ Someone took your request", body: rt.even ? (nameOf(doc, actor) + " approved it — it's on both your calendars.") : (nameOf(doc, actor) + " picked it up — open to confirm.") }); }
  else if (t === "resolveRequest" && !op.cancel) { var rr = findReq(doc, op.rid); if (rr) [rr.by, rr.takenBy].forEach(function (p) { if (p && p !== actor) out.push({ to: p, category: "personal", title: rr.type === "pickup" ? "✔️ Pickup settled" : "✔️ Swap confirmed", body: rr.type === "pickup" ? "Marked done — remember to add the agreed tour to your calendars." : "It's done and on both calendars." }); }); }   // a pickup carries no tour, so nothing is auto-written — never claim it was
  else if (t === "declineRequest") { var rd = findReq(doc, op.rid); if (rd && rd.by && rd.by !== actor) { if (op._evenDeclined) out.push({ to: rd.by, category: "personal", title: "↩︎ Partner passed", body: nameOf(doc, actor) + " declined the even swap — nothing changed on either calendar." }); else if (op._toWas) out.push({ to: rd.by, category: "personal", title: "↩︎ " + nameOf(doc, op._toWas) + " passed", body: "Your request is now open to the whole house." }); } }
  if (op && op._wasTaken && op._counterpart && op._counterpart !== actor && doc.members[op._counterpart])   // an AGREED (taken) deal was cancelled — the other party was planning around it
    out.push({ to: op._counterpart, category: "personal", title: "↩︎ Swap cancelled", body: nameOf(doc, actor) + " cancelled your agreed swap" + (op._cxTour ? " for " + (op._cxTour.m + 1) + "/" + op._cxTour.d : "") + " — nothing was put on either calendar." });
  if (op && op._cancelledTaken && op._cancelledTaken.length)   // a member left / was removed with deals pending — tell each counterpart
    op._cancelledTaken.forEach(function (p) { if (p !== actor && doc.members[p]) out.push({ to: p, category: "personal", title: "↩︎ Swap cancelled", body: (op._deptName || "A crewmember") + " left the house — your agreed swap with them is off; nothing was put on either calendar." }); });
  return out;
}
function sanPrefs(p) { p = p || {}; return { personal: p.personal !== false, general: p.general === true, tours: p.tours !== false }; }   // personal/tours default on, general opt-in
// atomic compare-and-set: SET key=newVal (EX TTL) only if it currently equals oldRaw. Returns 1 on success, 0 on conflict.
var CAS_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then redis.call('set',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1 else return 0 end";
function casSet(key, oldRaw, newVal) {
  return redis(["EVAL", CAS_LUA, "1", key, oldRaw, newVal, String(TTL)]).then(function (r) { return Number(r) === 1; });
}
function sha(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function validId(x) { return typeof x === "string" && /^[0-9a-f]{64}$/.test(x); }   // memberId = 64-hex sha256
function clip(s, n) { return String(s == null ? "" : s).replace(/[\x00-\x1f]/g, " ").slice(0, n).trim(); }  // strip control chars only
function co(s) { return clip(s, CO_MAX).toUpperCase(); }   // canonical company code (matches setCompanies casing)
function grpOK(g) { g = parseInt(g, 10); return (g >= 1 && g <= 25) ? g : 0; }
function rid(n) { return crypto.randomBytes(n).toString("hex"); }
function code6() {
  var A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", b = crypto.randomBytes(6), out = "";   // no I/L/O/0/1 ambiguity
  for (var i = 0; i < 6; i++) out += A[b[i] % A.length];
  return out;
}
function clientIp(req) {
  var xf = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "";
  return sha(String(xf).split(",")[0].trim() || "unknown").slice(0, 16);            // hashed — no raw IP stored
}
function rateLimited(req) {
  var key = RL_PREFIX + clientIp(req);
  return redis(["INCR", key]).then(function (n) {
    if (n === 1) redis(["EXPIRE", key, String(RL_WINDOW)]).catch(function () {});
    return n > RL_MAX;
  }).catch(function () { return false; });
}
function readBody(req) {
  if (req.body != null && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve(null); } }
  return new Promise(function (resolve) {
    var d = "";
    req.on("data", function (c) { d += c; if (d.length > 600000) { try { req.destroy(); } catch (e) {} resolve(null); } });
    req.on("end", function () { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve(null); } });
    req.on("error", function () { resolve(null); });
  });
}

// ---- pure logic (exported for Node tests) ----
function sanDuty(arr) {
  if (!Array.isArray(arr)) return [];
  var out = [];
  for (var i = 0; i < arr.length && out.length < DUTY_MAX; i++) {
    var d = arr[i]; if (!d) continue;
    var t = clip(d.t, 8), s = clip(d.s, 10), e = clip(d.e, 10);
    if (/^(vac|ml|ld|tr|det)$/.test(t) && /^\d{4}-\d\d?-\d\d?$/.test(s)) out.push({ t: t, s: s, e: /^\d{4}-\d\d?-\d\d?$/.test(e) ? e : "" });   // "det" = 6-month detail (away from this house)
  }
  return out;
}
function sanOt(arr) {   // member's upcoming scheduled-OT (RSOT) tours, so the crew can see + swap them
  if (!Array.isArray(arr)) return [];
  var out = [];
  for (var i = 0; i < arr.length && out.length < 120; i++) {
    var o = arr[i]; if (!o) continue; var d = clip(o.d, 10), t = parseInt(o.t, 10);
    if (/^\d{4}-\d\d?-\d\d?$/.test(d) && (t === 9 || t === 6)) out.push({ d: d, t: t });
  }
  return out;
}
function sanProfile(op) {
  return { name: clip(op.name, NAME_MAX), company: co(op.company), group: grpOK(op.group),
           letter: /^[ABCD]$/.test(op.letter) ? op.letter : "",
           phone: clip(op.phone, PHONE_MAX), spouse: clip(op.spouse, NAME_MAX),
           spousePhone: clip(op.spousePhone, PHONE_MAX), duty: sanDuty(op.duty), ot: sanOt(op.ot),
           mxoff: sanOt(op.mxoff), mxon: sanOt(op.mxon) };   // mxoff/mxon = tours the member is OFF / WORKING due to an out-of-house mutual (so the day-view is accurate); same {d,t} shape as ot
}
function newMember(op, role, status) {
  var p = sanProfile(op);
  return { name: p.name, company: p.company, group: p.group, letter: p.letter, phone: p.phone, spouse: p.spouse,
           spousePhone: p.spousePhone, duty: p.duty, ot: p.ot, mxoff: p.mxoff, mxon: p.mxon, role: role, status: status, at: Date.now() };
}
// A departed member (status "left" / "removed") collapses to a name-only tombstone — enough for their past
// swaps to still show who it was, but with NO group/duty/PII, so they drop out of the roster + day-view and
// never count toward member caps. Filtered everywhere by status !== "active"/"pending".
function tombstone(mem, status) { return { name: (mem && mem.name) || "", status: status, role: "member", at: Date.now() }; }
// Keep tombstones bounded: drop any that no retained request still references (their history is gone anyway),
// then hard-cap the rest oldest-first. Removed members stay banned regardless (the ban list is separate).
function pruneTombstones(doc) {
  var MAX_TOMB = 200, refd = {};
  (doc.requests || []).forEach(function (r) { if (r.by) refd[r.by] = 1; if (r.takenBy) refd[r.takenBy] = 1; });
  var isTomb = function (k) { var s = doc.members[k].status; return s === "left" || s === "removed"; };
  Object.keys(doc.members).filter(isTomb).forEach(function (k) { if (!refd[k]) delete doc.members[k]; });
  var tombs = Object.keys(doc.members).filter(isTomb);
  if (tombs.length > MAX_TOMB) {
    tombs.sort(function (a, b) { return (doc.members[a].at || 0) - (doc.members[b].at || 0); });
    tombs.slice(0, tombs.length - MAX_TOMB).forEach(function (k) { delete doc.members[k]; });
  }
}
function sanCompanies(arr) {   // sanitize + dedup (case-insensitive via co()) + cap a company list
  var seen = {}, cs = [];
  (Array.isArray(arr) ? arr : []).forEach(function (c) { c = co(c); if (c && !seen[c] && cs.length < MAX_CO) { seen[c] = 1; cs.push(c); } });
  return cs;
}
function newHouseDoc(id, code, m, op) {
  return { id: id, name: clip(op.house, NAME_MAX) || "Firehouse", code: code, founder: m, createdAt: Date.now(), ver: 1,
           admins: [m], companies: sanCompanies(op.companies), banned: [], members: (function () { var o = {}; o[m] = newMember(op, "admin", "active"); return o; })(),
           abcd: null, events: [], requests: [] };
}
function isAdmin(doc, m) { return doc.admins.indexOf(m) >= 0; }
function isFounder(doc, m) { return doc.founder === m; }
function validTour(x) {
  if (!x) return null;
  var y = parseInt(x.y, 10), mo = parseInt(x.m, 10), d = parseInt(x.d, 10), t = parseInt(x.t, 10);
  if (!(y >= 2000 && y < 2100) || !(mo >= 0 && mo <= 11) || !(d >= 1 && d <= 31) || !(t === 9 || t === 6)) return null;
  return { y: y, m: mo, d: d, t: t };
}
function findReq(doc, id) { for (var i = 0; i < doc.requests.length; i++) if (doc.requests[i].id === id) return doc.requests[i]; return null; }
function ban(doc, who) { doc.banned = doc.banned || []; if (who && doc.banned.indexOf(who) < 0) { doc.banned.push(who); if (doc.banned.length > MAX_BANNED) doc.banned = doc.banned.slice(doc.banned.length - MAX_BANNED); } }

// Apply one op by authenticated actor `m`; mutates `doc` in place; throws {code,error}.
// Precondition (enforced by the handler): `m` is an ACTIVE member. rotateCode is handled
// in the handler (needs Redis), not here.
function applyOp(doc, op, m) {
  var t = op && op.type, me = doc.members[m];
  if (op && op.who != null && !validId(op.who)) throw { code: 400, error: "bad-who" };   // never index doc.members with a non-memberId (blocks "__proto__"/"constructor" prototype pollution)
  function admin() { if (!isAdmin(doc, m)) throw { code: 403, error: "admins-only" }; }
  function foundGuard(who) { if (isFounder(doc, who) && isAdmin(doc, who) && who !== m) throw { code: 403, error: "founder-protected" }; }  // protect the founder only while they still hold admin (a rejoined/self-demoted founder is a plain, removable member)
  if (t === "updateProfile") {
    var p = sanProfile(op);   // NOTE: company + group are admin-owned (set at join/approve) — not overwritten here
    me.name = p.name; me.letter = p.letter; me.phone = p.phone; me.spouse = p.spouse; me.spousePhone = p.spousePhone; me.duty = p.duty; me.ot = p.ot; me.mxoff = p.mxoff; me.mxon = p.mxon;
  } else if (t === "setPartner") {   // declare your mutual partner (a specific active member); "confirmed" once they name you back. Omit `who` to clear.
    var oldP = me.partner;
    if (op.who != null) { if (op.who === m || !doc.members[op.who] || doc.members[op.who].status !== "active") throw { code: 400, error: "bad-partner" }; me.partner = op.who; }
    else delete me.partner;
    if (oldP && oldP !== me.partner) (doc.requests || []).forEach(function (r) {   // un/re-linking strands any open even request between the ex-partners as an un-acceptable zombie — cancel them both ways
      if (r.even && r.status === "open" && ((r.by === m && r.to === oldP) || (r.by === oldP && r.to === m))) { r.status = "cancelled"; r.takenBy = ""; }
    });
  } else if (t === "leave") {
    if (isAdmin(doc, m) && doc.admins.length <= 1) throw { code: 409, error: "last-admin" };  // promote someone first
    op._deptName = (me && me.name) || "";   // capture BEFORE tombstoning (notify runs after applyOp)
    doc.members[m] = tombstone(me, "left");   // keep a name-only tombstone so this person's past swaps still read right in the crew's history
    doc.admins = doc.admins.filter(function (a) { return a !== m; }); op._cancelledTaken = cancelMemberReqs(doc, m); pruneTombstones(doc);
  } else if (t === "approve") {
    admin(); var w = doc.members[op.who]; if (!w) throw { code: 404, error: "no-such-member" };
    if (w.status !== "pending" && w.status !== "active") throw { code: 403, error: "gone" };   // approve = confirm a pending join OR reassign an active member — NEVER resurrect a left/removed tombstone (which would also bypass the ban)
    w.status = "active"; if (op.company != null) w.company = co(op.company); var g = grpOK(op.group); if (g) w.group = g;
  } else if (t === "reject" || t === "remove") {
    admin(); if (op.who === m) throw { code: 400, error: "use-leave" };
    foundGuard(op.who);
    var wm = doc.members[op.who]; if (!wm) throw { code: 404, error: "no-such-member" };
    ban(doc, op.who);   // removed/rejected members can't silently re-join with the same identity
    op._deptName = wm.name || "";
    if (wm.status === "pending") delete doc.members[op.who];   // a historyless pending join → drop it
    else doc.members[op.who] = tombstone(wm, "removed");        // active OR an already-departed member → keep/refresh a name tombstone (never lose the name from history)
    doc.admins = doc.admins.filter(function (a) { return a !== op.who; }); op._cancelledTaken = cancelMemberReqs(doc, op.who); pruneTombstones(doc);
  } else if (t === "promote") {
    admin(); var pm = doc.members[op.who]; if (!pm || pm.status !== "active") throw { code: 400, error: "not-active" };
    if (doc.admins.indexOf(op.who) < 0) doc.admins.push(op.who); pm.role = "admin";
  } else if (t === "demote") {
    admin(); if (op.who === m && doc.admins.length <= 1) throw { code: 409, error: "last-admin" };
    foundGuard(op.who);
    doc.admins = doc.admins.filter(function (a) { return a !== op.who; }); if (doc.members[op.who]) doc.members[op.who].role = "member";
  } else if (t === "setCompanies") {
    admin(); doc.companies = sanCompanies(op.companies);
  } else if (t === "createRequest") {
    var rq = op.req || {};
    if (!/^(swap|cover|pickup)$/.test(rq.type)) throw { code: 400, error: "bad-req" };
    if (doc.requests.filter(function (r) { return r.status === "open" || r.status === "taken"; }).length >= MAX_REQ) throw { code: 403, error: "too-many" };
    var tr = validTour(rq.tour), wt = rq.want ? validTour(rq.want) : null;
    if (rq.type !== "pickup" && !tr) throw { code: 400, error: "bad-tour" };
    if (rq.type === "swap" && !wt) throw { code: 400, error: "bad-want" };
    // bound growth: keep all open/taken, plus done requests still needed (future tour OR completed <60d ago — every
    // party's client needs a window to fetch + apply it to their calendar), plus the most recent TERMINAL_KEEP others
    var DONE_KEEP_MS = 60 * 864e5;
    var mustKeep = function (r) { return r.status === "done" && (reqTouchesFuture(r) || (r.doneAt && Date.now() - r.doneAt < DONE_KEEP_MS)); };
    var live = doc.requests.filter(function (r) { return r.status === "open" || r.status === "taken"; });
    var keepDone = doc.requests.filter(mustKeep);
    var term = doc.requests.filter(function (r) { return r.status !== "open" && r.status !== "taken" && !mustKeep(r); }).sort(function (a, b) { return (a.doneAt || a.at) - (b.doneAt || b.at); });
    if (term.length > TERMINAL_KEEP) term = term.slice(term.length - TERMINAL_KEEP);
    doc.requests = live.concat(keepDone, term);
    var toId = (rq.to && doc.members[rq.to] && doc.members[rq.to].status === "active" && rq.to !== m) ? rq.to : "";   // optional: directed at a specific ACTIVE member
    var gRsot = (typeof rq.giveRsot === "boolean") ? rq.giveRsot : hasRSOT(doc.members[m], tr);   // stamp: the poster's own RSOT status, computed from their full calendar (not the ±130d sync window)
    if ((rq.type === "swap" || rq.type === "cover") && tourCommitted(doc, m, tr)) throw { code: 409, error: "tour-taken" };   // you've already swapped/covered this exact tour — can't give it away twice
    if (rq.type === "swap" && toId && tourCommitted(doc, toId, wt)) throw { code: 409, error: "tour-taken" };   // directed: they've already committed the tour you want
    if (rq.type === "swap" && toId && wt && !tourFarFuture(wt) && gRsot !== hasRSOT(doc.members[toId], wt)) throw { code: 400, error: "rsot-mismatch" };   // RSOT swaps only trade against another RSOT (a want beyond the ~130d sync window is UNKNOWN, not not-RSOT — the take-time check still enforces)
    var even = rq.even === true && (rq.type === "swap" || rq.type === "cover");   // "even" = ledger-neutral PARTNER swap; only between two CONFIRMED mutual partners
    if (even && !(toId && doc.members[m].partner === toId && doc.members[toId] && doc.members[toId].partner === m)) throw { code: 400, error: "not-partners" };
    doc.requests.push({ id: rid(6), type: rq.type, by: m, to: toId, tour: tr, want: wt, giveRsot: (rq.type === "pickup" ? false : gRsot), even: even, note: clip(rq.note, NOTE_MAX), status: "open", takenBy: "", at: Date.now() });   // covers stamp giveRsot too: covering an RSOT transfers paid OT to the taker, NOT a debt mutual
  } else if (t === "cancelRequest") {
    var rc = findReq(doc, op.rid); if (!rc) throw { code: 404, error: "no-req" };
    if (rc.by !== m && !isAdmin(doc, m)) throw { code: 403, error: "not-yours" };
    if (rc.status !== "open" && rc.status !== "taken") throw { code: 409, error: "not-cancelable" };
    if (rc.status === "taken") { op._wasTaken = true; op._counterpart = (m === rc.by) ? rc.takenBy : rc.by; op._cxTour = rc.tour; }   // a TAKEN deal is an agreement — tell the other party it's off
    rc.status = "cancelled"; rc.takenBy = "";
  } else if (t === "takeRequest") {
    var rt = findReq(doc, op.rid); if (!rt) throw { code: 404, error: "no-req" };
    if (rt.by === m) throw { code: 400, error: "own-req" };
    if (rt.status !== "open") throw { code: 409, error: "not-open" };
    if (rt.to && rt.to !== m) throw { code: 403, error: "directed" };   // while aimed at someone, only they can accept (until they decline → released to the house)
    if (rt.tour && tourCommitted(doc, rt.by, rt.tour, rt.id)) throw { code: 409, error: "tour-taken" };   // the poster already committed this tour to another swap since posting
    if (rt.type === "swap" && rt.want && tourCommitted(doc, m, rt.want, rt.id)) throw { code: 409, error: "tour-taken" };   // you've already given away the tour you'd hand back
    if (rt.type === "swap") {   // taker can only fulfill an RSOT swap with their own RSOT (and vice versa). Trust the taker's self-stamp (their FULL calendar) like the poster's giveRsot; fall back to the synced ~130d .ot window.
      var tRsot = (typeof op.takeRsot === "boolean") ? op.takeRsot : hasRSOT(doc.members[m], rt.want);
      if (giveSideRsot(doc, rt) !== tRsot) throw { code: 400, error: "rsot-mismatch" };
    }
    if (rt.even && !(rt.to === m && doc.members[m].partner === rt.by && doc.members[rt.by] && doc.members[rt.by].partner === m)) throw { code: 400, error: "not-partners" };   // an even swap can only be accepted by the confirmed partner it was sent to
    rt.takenBy = m; rt.status = rt.even ? "done" : "taken";   // a partner even-swap is settled the instant your partner approves it — no separate "Done" step, both calendars sync at once
    if (rt.even) rt.doneAt = Date.now();   // completion timestamp — tourCommitted orders by it, and the done-retention window runs from it
    if (rt.tour) doc.requests.forEach(function (r) {   // poster side: a give-tour commits once — retire the poster's OTHER open requests giving away this same tour (the multi-"want" alternatives)
      if (r !== rt && r.by === rt.by && r.status === "open" && sameTour(r.tour, rt.tour)) { r.status = "cancelled"; r.takenBy = ""; }
    });
    if (rt.type === "swap" && rt.want) doc.requests.forEach(function (r) {   // taker side: the taker just handed back rt.want — retire THEIR open requests giving that tour away (no zombie, un-takeable request left behind)
      if (r !== rt && r.by === m && r.status === "open" && sameTour(r.tour, rt.want)) { r.status = "cancelled"; r.takenBy = ""; }
    });
  } else if (t === "declineRequest") {
    var rdc = findReq(doc, op.rid); if (!rdc) throw { code: 404, error: "no-req" };
    if (rdc.to !== m && !isAdmin(doc, m)) throw { code: 403, error: "not-for-you" };
    if (rdc.status !== "open") throw { code: 409, error: "not-open" };
    if (rdc.even) { op._evenDeclined = rdc.by; rdc.status = "cancelled"; rdc.takenBy = ""; }   // an even (partner-only) request is meaningless to the house — declining cancels it (never leave a board zombie only the ex-partner could take)
    else { op._toWas = rdc.to; rdc.to = ""; }   // release to the open house board — anyone can take it now (_toWas lets notify name who was asked)
  } else if (t === "resolveRequest") {
    var rr = findReq(doc, op.rid); if (!rr) throw { code: 404, error: "no-req" };
    if (rr.by !== m && rr.takenBy !== m && !isAdmin(doc, m)) throw { code: 403, error: "not-involved" };
    if (op.cancel) { if (rr.status !== "open" && rr.status !== "taken") throw { code: 409, error: "not-cancelable" };
      if (rr.status === "taken") { op._wasTaken = true; op._counterpart = (m === rr.by) ? rr.takenBy : rr.by; op._cxTour = rr.tour; }
      rr.status = "cancelled"; rr.takenBy = ""; }
    else { if (rr.status !== "taken") throw { code: 409, error: "not-taken" }; rr.status = "done"; rr.doneAt = Date.now(); }   // only a genuinely-taken request can complete; doneAt drives the guard's ordering + retention
  } else if (t === "abcdPush") {
    admin();
    if (op.abcd && !/^\d{4}-\d\d?-\d\d?$/.test(op.abcd.s)) throw { code: 400, error: "bad-date" };   // a typo'd date must ERROR, never silently turn ABCD off for the whole house (null = the explicit End-ABCD op only)
    doc.abcd = op.abcd ? { s: clip(op.abcd.s, 10), e: /^\d{4}-\d\d?-\d\d?$/.test(op.abcd.e) ? clip(op.abcd.e, 10) : "" } : null;
  } else if (t === "postEvent") {
    admin(); var ev = op.ev || {}; if (doc.events.length >= MAX_EVENTS) throw { code: 403, error: "too-many" };
    var dts = (Array.isArray(ev.dates) ? ev.dates : []).filter(function (d) { return /^\d{4}-\d\d?-\d\d?$/.test(d); }).slice(0, EV_DATES_MAX);
    if (!clip(ev.title, NAME_MAX) || !dts.length) throw { code: 400, error: "bad-event" };
    doc.events.push({ id: rid(6), title: clip(ev.title, NAME_MAX), note: clip(ev.note, NOTE_MAX), dates: dts, by: m, at: Date.now() });
  } else if (t === "delEvent") {
    admin(); doc.events = doc.events.filter(function (e) { return e.id !== op.eid; });
  } else {
    throw { code: 400, error: "bad-op" };
  }
  doc.ver++;
  return doc;
}

// ---- handler ----
function authOK(m, s) { return validId(m) && sha(s) === m; }
function sendErr(res, e) { res.status(e && e.code ? e.code : 400).json({ error: (e && e.error) || "bad-op" }); }

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // Inert until launch: pushing this file auto-deploys the function, but it does nothing
  // until HOUSE_ENABLED is set in the Vercel env (flip it on when the House feature goes live).
  if (!process.env.HOUSE_ENABLED) { res.status(503).json({ error: "house-not-enabled" }); return; }
  if (!REST_URL || !REST_TOKEN) { res.status(501).json({ error: "cloud-not-configured" }); return; }
  try {
    if (await rateLimited(req)) { res.status(429).json({ error: "rate-limited" }); return; }
    var q = req.query || {}, a = q.a || "", H = req.headers || {};

    if (a === "tourcron") {   // scheduled (QStash / Vercel Cron) — push "you're working today" reminders for the imminent tour
      if (!CRON_SECRET || (H["authorization"] || "") !== "Bearer " + CRON_SECRET) { res.status(401).json({ error: "bad-cron" }); return; }
      var et = etParts();
      var tour = (q.tour === "9" || q.tour === "6") ? parseInt(q.tour, 10) : (et.hour >= 16 ? 6 : 9);   // explicit, else infer (evening→night tour)
      // The NEXT tour on the timeline — its workers get the ADVANCE heads-up at the start of the tour BEFORE theirs:
      // the evening run (6× starting 1800) alerts tomorrow's 9× workers; the morning run (9× starting 0900) alerts tonight's 6× workers.
      var nx; if (tour === 9) nx = { y: et.y, m: et.m, d: et.d, t: 6 };
      else { var nd2 = new Date(Date.UTC(et.y, et.m, et.d + 1)); nx = { y: nd2.getUTCFullYear(), m: nd2.getUTCMonth(), d: nd2.getUTCDate(), t: 9 }; }
      var ids = (await redis(["SMEMBERS", HOUSES_SET])) || [], sends = [], reminded = 0, ahead = 0, checked = 0;
      for (var ci = 0; ci < ids.length && ci < MAX_CRON_HOUSES; ci++) {   // bound per-run cost so the cron can't exceed the function timeout as the registry grows
        var hraw = await redis(["GET", HOUSE_PREFIX + ids[ci]]);
        if (!hraw) { redis(["SREM", HOUSES_SET, ids[ci]]).catch(function () {}); continue; }   // expired house → deregister
        var hdoc; try { hdoc = JSON.parse(hraw); } catch (e) { continue; }
        var mids = Object.keys(hdoc.members);
        for (var cj = 0; cj < mids.length && checked < 20000; cj++) {
          checked++; var mem = hdoc.members[mids[cj]]; if (mem.status !== "active") continue;
          if (memberWorksTour(hdoc, mem, et.y, et.m, et.d, tour)) {
            reminded++;
            sends.push(sendPush(mids[cj], { title: "🚒 Tour reminder", body: "You're working the " + (tour === 9 ? "☀️ 9× day tour" : "🌙 6× night tour") + " today.", url: "/?house=1", tag: "tour" }, "tours"));
          }
          if (memberWorksTour(hdoc, mem, nx.y, nx.m, nx.d, nx.t)) {   // one tour ahead — "this Saturday 9×? you hear about it Friday at 1800"
            ahead++;
            sends.push(sendPush(mids[cj], { title: "⏰ Next tour is yours", body: nx.t === 9 ? "You're working tomorrow's ☀️ 9× day tour — starts 0900." : "You're working tonight's 🌙 6× night tour — starts 1800.", url: "/?house=1", tag: "tour-ahead" }, "tours"));
          }
        }
      }
      try { await Promise.race([Promise.all(sends), new Promise(function (rz) { setTimeout(rz, 25000); })]); } catch (e3) {}
      res.status(200).json({ ok: true, tour: tour, houses: ids.length, reminded: reminded, ahead: ahead });
      return;
    }

    if (req.method === "GET") {
      // credentials ride in headers (X-House-M / X-House-S) ONLY, NEVER the URL, so the secret never lands in access logs / history / Referer.
      var gid = clip(q.id, 64), gm = clip(H["x-house-m"], 64), gs = String(H["x-house-s"] || "");
      if (!authOK(gm, gs)) { res.status(401).json({ error: "bad-auth" }); return; }
      var raw = await redis(["GET", HOUSE_PREFIX + gid]);
      if (!raw) { res.status(404).json({ error: "not-found" }); return; }
      var doc = JSON.parse(raw), me = doc.members[gm];
      if (!me || me.status === "left" || me.status === "removed") { res.status(403).json({ error: "not-member" }); return; }   // a tombstone reads as GONE → the caller's client drops this house
      if (me.status !== "active") { res.status(200).json({ pending: true, id: doc.id, name: doc.name, status: me.status }); return; }
      res.status(200).json({ doc: doc, sub: await houseSubStatus(doc) });   // trial/active/grace/lapsed — the client banners it (reads keep working when lapsed; writes don't)
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ error: "method-not-allowed" }); return; }

    var body = await readBody(req);
    if (!body) { res.status(400).json({ error: "bad-body" }); return; }
    var m = clip(body.m, 64), s = String(body.s || "");
    if (!authOK(m, s)) { res.status(401).json({ error: "bad-auth" }); return; }   // prove you own this memberId

    if (a === "savepush") {   // store this device's push subscription in a PRIVATE per-member key (never in the house doc)
      var sub = body.sub, k = sub && sub.keys;
      if (!validPushEndpoint(sub && sub.endpoint) || !k || typeof k.p256dh !== "string" || typeof k.auth !== "string" || k.p256dh.length > 200 || k.auth.length > 100) { res.status(400).json({ error: "bad-sub" }); return; }
      var pRaw = await redis(["GET", HOUSE_PREFIX + clip(body.id, 64)]);   // only an ACTIVE member of the named house may store a subscription (no anonymous storage abuse)
      var pDoc = pRaw ? (function () { try { return JSON.parse(pRaw); } catch (e) { return null; } })() : null;
      if (!pDoc || !pDoc.members[m] || pDoc.members[m].status !== "active") { res.status(403).json({ error: "not-active" }); return; }
      var clean = { endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth }, prefs: sanPrefs(body.prefs) };   // rebuild a whitelisted, size-bounded object
      await redis(["SET", PUSH_PREFIX + m, JSON.stringify(clean), "EX", String(TTL)]);
      res.status(200).json({ ok: true });
      return;
    }
    if (a === "setprefs") {   // update just the notification category prefs on an existing subscription
      var prRaw = await redis(["GET", PUSH_PREFIX + m]);
      if (prRaw) { var rec; try { rec = JSON.parse(prRaw); } catch (e) { rec = null; } if (rec) { rec.prefs = sanPrefs(body.prefs); await redis(["SET", PUSH_PREFIX + m, JSON.stringify(rec), "EX", String(TTL)]); } }
      res.status(200).json({ ok: true });
      return;
    }
    if (a === "clearpush") { await redis(["DEL", PUSH_PREFIX + m]); res.status(200).json({ ok: true }); return; }

    if (a === "create") {
      var ipk = "sqrtcal:hcreate:" + clientIp(req);   // cap house creation per IP/day so one source can't flood the registry
      var nCreated = await redis(["INCR", ipk]);
      if (nCreated === 1) redis(["EXPIRE", ipk, "86400"]).catch(function () {});
      if (nCreated > MAX_CREATE_PER_DAY) { res.status(429).json({ error: "create-limit" }); return; }
      var code = code6(), tries = 0;
      while ((await redis(["SET", CODE_PREFIX + code, "0", "NX", "EX", "60"]) === null) && tries++ < 6) code = code6();   // reserve the code atomically
      var id = rid(12), ndoc = newHouseDoc(id, code, m, body);
      await redis(["SET", HOUSE_PREFIX + id, JSON.stringify(ndoc), "EX", String(TTL)]);
      await redis(["SET", CODE_PREFIX + code, id, "EX", String(TTL)]);   // finalize the reservation -> houseId
      redis(["SADD", HOUSES_SET, id]).catch(function () {});   // register for the tour-reminder cron enumeration
      res.status(200).json({ doc: ndoc });
      return;
    }
    if (a === "join") {
      var code2 = clip(body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!code2) { res.status(400).json({ error: "bad-code" }); return; }
      for (var att = 0; att < 5; att++) {
        var hid = await redis(["GET", CODE_PREFIX + code2]);
        if (!hid || hid === "0") { res.status(404).json({ error: "no-house" }); return; }
        var raw2 = await redis(["GET", HOUSE_PREFIX + hid]);
        if (!raw2) { res.status(404).json({ error: "no-house" }); return; }
        var d2 = JSON.parse(raw2), existing = d2.members[m];
        if (existing && (existing.status === "active" || existing.status === "pending")) {   // already a live member — never leak the doc unless active
          if (existing.status === "active") res.status(200).json({ doc: d2 });
          else res.status(200).json({ pending: true, id: hid, name: d2.name, status: existing.status });
          return;
        }   // else: no record, OR a "left"/"removed" tombstone → banned check blocks "removed"; a "left" member re-joins fresh below
        if ((d2.banned || []).indexOf(m) >= 0) { res.status(403).json({ error: "banned" }); return; }
        var live = Object.keys(d2.members).filter(function (k) { var s = d2.members[k].status; return s === "active" || s === "pending"; });   // tombstones (left/removed) don't count toward caps
        if (live.length >= MAX_MEMBERS) { res.status(403).json({ error: "house-full" }); return; }
        var pend = d2.members ? Object.keys(d2.members).filter(function (k) { return d2.members[k].status === "pending"; }).length : 0;
        if (pend >= MAX_PENDING) { res.status(403).json({ error: "too-many-pending" }); return; }
        if ((await houseSubStatus(d2)).mode === "lapsed") { res.status(402).json({ error: "sub-lapsed" }); return; }   // join mutates the doc — same gate as every other write
        d2.members[m] = newMember(body, "member", "pending"); d2.ver++;
        if (await casSet(HOUSE_PREFIX + hid, raw2, JSON.stringify(d2))) {
          redis(["EXPIRE", CODE_PREFIX + code2, String(TTL)]).catch(function () {});   // keep the code alive while the house is active
          res.status(200).json({ pending: true, id: hid, name: d2.name, status: "pending" });
          return;
        }
        // CAS lost a race — re-read and retry
      }
      res.status(409).json({ error: "busy-retry" });
      return;
    }

    // authenticated mutation with atomic compare-and-set
    var pid = clip(body.id, 64), op = body.op || {}, base = parseInt(body.base, 10);
    var raw3 = await redis(["GET", HOUSE_PREFIX + pid]);
    if (!raw3) { res.status(404).json({ error: "not-found" }); return; }
    var doc3 = JSON.parse(raw3), me3 = doc3.members[m];
    if (!me3) { res.status(403).json({ error: "not-member" }); return; }
    // Only ACTIVE members act. A pending/removed caller may ONLY cancel their own join ("leave"),
    // and NEVER receives the doc (this is the confidentiality gate the GET path also enforces).
    if (me3.status !== "active") {
      if (op.type === "leave" && me3.status === "pending") {   // only a genuine pending join can self-cancel (delete). A left/removed tombstone must survive so history keeps the name.
        delete doc3.members[m]; doc3.admins = doc3.admins.filter(function (x) { return x !== m; }); doc3.ver++;
        if (await casSet(HOUSE_PREFIX + pid, raw3, JSON.stringify(doc3))) { res.status(200).json({ left: true }); return; }
        res.status(200).json({ left: true }); return;   // concurrent write? their membership is gone either way
      }
      res.status(403).json({ error: "not-active" }); return;
    }
    if (!isNaN(base) && doc3.ver !== base) { res.status(409).json({ error: "conflict", ver: doc3.ver, doc: doc3 }); return; }
    if (op.type !== "leave") {   // leaving is ALWAYS allowed — nobody gets held hostage by a lapsed bill
      var subSt = await houseSubStatus(doc3);
      if (subSt.mode === "lapsed") { res.status(402).json({ error: "sub-lapsed" }); return; }   // trial over + no live subscription → writes stop until the commissar activates
    }

    if (op.type === "rotateCode") {   // admin-only; needs Redis side effects, so handled here (not in applyOp)
      if (!isAdmin(doc3, m)) { res.status(403).json({ error: "admins-only" }); return; }
      var oldCode = doc3.code, nc = code6(), ct = 0;
      while ((await redis(["SET", CODE_PREFIX + nc, pid, "NX", "EX", String(TTL)]) === null) && ct++ < 6) nc = code6();
      doc3.code = nc; doc3.ver++;
      if (!(await casSet(HOUSE_PREFIX + pid, raw3, JSON.stringify(doc3)))) {
        await redis(["DEL", CODE_PREFIX + nc]).catch(function () {});   // roll back the reservation
        var cur = await redis(["GET", HOUSE_PREFIX + pid]); res.status(409).json({ error: "conflict", ver: cur ? JSON.parse(cur).ver : 0, doc: cur ? JSON.parse(cur) : doc3 }); return;
      }
      if (oldCode && oldCode !== nc) await redis(["DEL", CODE_PREFIX + oldCode]).catch(function () {});
      res.status(200).json({ doc: doc3 });
      return;
    }

    try { applyOp(doc3, op, m); }
    catch (e) { sendErr(res, e); return; }
    if (await casSet(HOUSE_PREFIX + pid, raw3, JSON.stringify(doc3))) {
      redis(["EXPIRE", CODE_PREFIX + doc3.code, String(TTL)]).catch(function () {});
      var notes = notifyForOp(doc3, op, m);   // request notifications, each with a category the recipient can toggle
      if (notes.length) {
        var sends = notes.map(function (n) {
          return redis(["SET", PUSH_PREFIX + "rl:" + m + ":" + n.to, "1", "NX", "EX", "30"]).then(function (r) {   // one push per actor→target per 30s (anti notification-bomb; survives identity rotation)
            if (r === null) return; return sendPush(n.to, { title: n.title, body: n.body, url: "/?house=1", tag: n.tag || "house" }, n.category);
          }).catch(function () {});
        });
        try { await Promise.race([Promise.all(sends), new Promise(function (rz) { setTimeout(rz, 4000); })]); } catch (e2) {}   // never let a slow endpoint stall the response
      }
      res.status(200).json({ doc: doc3 });
      return;
    }
    // CAS conflict: someone wrote between our read and write → tell the client to re-sync
    var cur2 = await redis(["GET", HOUSE_PREFIX + pid]); var cd = cur2 ? JSON.parse(cur2) : doc3;
    res.status(409).json({ error: "conflict", ver: cd.ver, doc: cd });
  } catch (e) {
    res.status(500).json({ error: "server-error" });
  }
}

module.exports = handler;
module.exports.newHouseDoc = newHouseDoc;
module.exports.applyOp = applyOp;
module.exports.isAdmin = isAdmin;
module.exports.sanProfile = sanProfile;
module.exports.newMember = newMember;
module.exports.notifyForOp = notifyForOp;
module.exports.memberWorksTour = memberWorksTour;
module.exports.sanPrefs = sanPrefs;

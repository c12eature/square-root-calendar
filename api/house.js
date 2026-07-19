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
  if (houseAbcdOn(doc, t)) return !!(mem.letter && abcdLetter(y, m, d) === mem.letter);
  if (mem.group && hasGrp(tour === 9 ? dayStart(y, m, d) : nightStart(y, m, d), mem.group)) return true;
  var iso = y + "-" + (m + 1 < 10 ? "0" : "") + (m + 1) + "-" + (d < 10 ? "0" : "") + d, ot = mem.ot || [];
  for (var i = 0; i < ot.length; i++) if (ot[i].t === tour && ot[i].d === iso) return true;   // RSOT pickup
  return false;
}
function etParts() {   // current wall-clock date + hour in America/New_York (DST handled by Intl)
  var f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false });
  var p = {}; f.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
  return { y: +p.year, m: (+p.month) - 1, d: +p.day, hour: (+p.hour) % 24 };
}
var RL_PREFIX = "sqrtcal:hrl:";
var RL_WINDOW = 60, RL_MAX = 150;        // requests / IP / minute (clients poll + mutate)
var MAX_MEMBERS = 400, MAX_PENDING = 30, MAX_CO = 24, MAX_EVENTS = 300, MAX_REQ = 500, TERMINAL_KEEP = 100, MAX_BANNED = 500;
var NAME_MAX = 60, CO_MAX = 24, PHONE_MAX = 40, DUTY_MAX = 24, NOTE_MAX = 240, EV_DATES_MAX = 60;

function redis(cmd) {
  return fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  }).then(function (r) { if (!r.ok) throw new Error("redis " + r.status); return r.json(); })
    .then(function (j) { return j.result; });
}
// ---- Web Push (VAPID) ----
// Public key is embedded in the client (safe); the PRIVATE key is env-only, never committed.
// Subscriptions are stored in a PRIVATE per-member key (never in the house doc), so no member
// can see another's push endpoint. web-push is lazy-required + no-ops without keys/dep, so the
// backend still runs locally without the package or env set.
var VAPID_PUBLIC = process.env.VAPID_PUBLIC || "";
var VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
var VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@nyfirestudyapp.com";
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
  else if (t === "takeRequest") { var rt = findReq(doc, op.rid); if (rt && rt.by && rt.by !== actor) out.push({ to: rt.by, category: "personal", title: "✅ Someone took your request", body: nameOf(doc, actor) + " picked it up — open to confirm." }); }
  else if (t === "resolveRequest" && !op.cancel) { var rr = findReq(doc, op.rid); if (rr) [rr.by, rr.takenBy].forEach(function (p) { if (p && p !== actor) out.push({ to: p, category: "personal", title: "✔️ Swap confirmed", body: "It's done and on both calendars." }); }); }
  else if (t === "declineRequest") { var rd = findReq(doc, op.rid); if (rd && rd.by && rd.by !== actor && op._toWas) out.push({ to: rd.by, category: "personal", title: "↩︎ " + nameOf(doc, op._toWas) + " passed", body: "Your request is now open to the whole house." }); }
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
    if (/^(vac|ml|ld|tr)$/.test(t) && /^\d{4}-\d\d?-\d\d?$/.test(s)) out.push({ t: t, s: s, e: /^\d{4}-\d\d?-\d\d?$/.test(e) ? e : "" });
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
           spousePhone: clip(op.spousePhone, PHONE_MAX), duty: sanDuty(op.duty), ot: sanOt(op.ot) };
}
function newMember(op, role, status) {
  var p = sanProfile(op);
  return { name: p.name, company: p.company, group: p.group, letter: p.letter, phone: p.phone, spouse: p.spouse,
           spousePhone: p.spousePhone, duty: p.duty, ot: p.ot, role: role, status: status, at: Date.now() };
}
function newHouseDoc(id, code, m, op) {
  return { id: id, name: clip(op.house, NAME_MAX) || "Firehouse", code: code, founder: m, createdAt: Date.now(), ver: 1,
           admins: [m], companies: [], banned: [], members: (function () { var o = {}; o[m] = newMember(op, "admin", "active"); return o; })(),
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
  function admin() { if (!isAdmin(doc, m)) throw { code: 403, error: "admins-only" }; }
  function foundGuard(who) { if (isFounder(doc, who) && who !== m) throw { code: 403, error: "founder-protected" }; }  // only the founder can demote/remove themselves
  if (t === "updateProfile") {
    var p = sanProfile(op);   // NOTE: company + group are admin-owned (set at join/approve) — not overwritten here
    me.name = p.name; me.letter = p.letter; me.phone = p.phone; me.spouse = p.spouse; me.spousePhone = p.spousePhone; me.duty = p.duty; me.ot = p.ot;
  } else if (t === "leave") {
    if (isAdmin(doc, m) && doc.admins.length <= 1) throw { code: 409, error: "last-admin" };  // promote someone first
    delete doc.members[m]; doc.admins = doc.admins.filter(function (a) { return a !== m; });
  } else if (t === "approve") {
    admin(); var w = doc.members[op.who]; if (!w) throw { code: 404, error: "no-such-member" };
    w.status = "active"; if (op.company != null) w.company = co(op.company); var g = grpOK(op.group); if (g) w.group = g;
  } else if (t === "reject" || t === "remove") {
    admin(); if (op.who === m) throw { code: 400, error: "use-leave" };
    foundGuard(op.who);
    if (!doc.members[op.who]) throw { code: 404, error: "no-such-member" };
    ban(doc, op.who);   // removed/rejected members can't silently re-join with the same identity
    delete doc.members[op.who]; doc.admins = doc.admins.filter(function (a) { return a !== op.who; });
  } else if (t === "promote") {
    admin(); var pm = doc.members[op.who]; if (!pm || pm.status !== "active") throw { code: 400, error: "not-active" };
    if (doc.admins.indexOf(op.who) < 0) doc.admins.push(op.who); pm.role = "admin";
  } else if (t === "demote") {
    admin(); if (op.who === m && doc.admins.length <= 1) throw { code: 409, error: "last-admin" };
    foundGuard(op.who);
    doc.admins = doc.admins.filter(function (a) { return a !== op.who; }); if (doc.members[op.who]) doc.members[op.who].role = "member";
  } else if (t === "setCompanies") {
    admin(); var seen = {}, cs = [];
    (Array.isArray(op.companies) ? op.companies : []).forEach(function (c) { c = co(c); if (c && !seen[c] && cs.length < MAX_CO) { seen[c] = 1; cs.push(c); } });
    doc.companies = cs;
  } else if (t === "createRequest") {
    var rq = op.req || {};
    if (!/^(swap|cover|pickup)$/.test(rq.type)) throw { code: 400, error: "bad-req" };
    if (doc.requests.filter(function (r) { return r.status === "open" || r.status === "taken"; }).length >= MAX_REQ) throw { code: 403, error: "too-many" };
    var tr = validTour(rq.tour), wt = rq.want ? validTour(rq.want) : null;
    if (rq.type !== "pickup" && !tr) throw { code: 400, error: "bad-tour" };
    if (rq.type === "swap" && !wt) throw { code: 400, error: "bad-want" };
    // bound growth: keep all open/taken, plus only the most recent TERMINAL_KEEP done/cancelled
    var live = doc.requests.filter(function (r) { return r.status === "open" || r.status === "taken"; });
    var term = doc.requests.filter(function (r) { return r.status !== "open" && r.status !== "taken"; }).sort(function (a, b) { return a.at - b.at; });
    if (term.length > TERMINAL_KEEP) term = term.slice(term.length - TERMINAL_KEEP);
    doc.requests = live.concat(term);
    var toId = (rq.to && doc.members[rq.to] && doc.members[rq.to].status === "active" && rq.to !== m) ? rq.to : "";   // optional: directed at a specific ACTIVE member
    doc.requests.push({ id: rid(6), type: rq.type, by: m, to: toId, tour: tr, want: wt, note: clip(rq.note, NOTE_MAX), status: "open", takenBy: "", at: Date.now() });
  } else if (t === "cancelRequest") {
    var rc = findReq(doc, op.rid); if (!rc) throw { code: 404, error: "no-req" };
    if (rc.by !== m && !isAdmin(doc, m)) throw { code: 403, error: "not-yours" };
    if (rc.status !== "open" && rc.status !== "taken") throw { code: 409, error: "not-cancelable" };
    rc.status = "cancelled"; rc.takenBy = "";
  } else if (t === "takeRequest") {
    var rt = findReq(doc, op.rid); if (!rt) throw { code: 404, error: "no-req" };
    if (rt.by === m) throw { code: 400, error: "own-req" };
    if (rt.status !== "open") throw { code: 409, error: "not-open" };
    if (rt.to && rt.to !== m) throw { code: 403, error: "directed" };   // while aimed at someone, only they can accept (until they decline → released to the house)
    rt.takenBy = m; rt.status = "taken";
  } else if (t === "declineRequest") {
    var rdc = findReq(doc, op.rid); if (!rdc) throw { code: 404, error: "no-req" };
    if (rdc.to !== m && !isAdmin(doc, m)) throw { code: 403, error: "not-for-you" };
    if (rdc.status !== "open") throw { code: 409, error: "not-open" };
    op._toWas = rdc.to; rdc.to = "";   // release to the open house board — anyone can take it now (_toWas lets notify name who was asked)
  } else if (t === "resolveRequest") {
    var rr = findReq(doc, op.rid); if (!rr) throw { code: 404, error: "no-req" };
    if (rr.by !== m && rr.takenBy !== m && !isAdmin(doc, m)) throw { code: 403, error: "not-involved" };
    if (op.cancel) { if (rr.status !== "open" && rr.status !== "taken") throw { code: 409, error: "not-cancelable" }; rr.status = "cancelled"; rr.takenBy = ""; }
    else { if (rr.status !== "taken") throw { code: 409, error: "not-taken" }; rr.status = "done"; }   // only a genuinely-taken request can complete
  } else if (t === "abcdPush") {
    admin(); doc.abcd = (op.abcd && /^\d{4}-\d\d?-\d\d?$/.test(op.abcd.s)) ? { s: clip(op.abcd.s, 10), e: /^\d{4}-\d\d?-\d\d?$/.test(op.abcd.e) ? clip(op.abcd.e, 10) : "" } : null;
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
      var ids = (await redis(["SMEMBERS", HOUSES_SET])) || [], sends = [], reminded = 0, checked = 0;
      for (var ci = 0; ci < ids.length; ci++) {
        var hraw = await redis(["GET", HOUSE_PREFIX + ids[ci]]);
        if (!hraw) { redis(["SREM", HOUSES_SET, ids[ci]]).catch(function () {}); continue; }   // expired house → deregister
        var hdoc; try { hdoc = JSON.parse(hraw); } catch (e) { continue; }
        var mids = Object.keys(hdoc.members);
        for (var cj = 0; cj < mids.length && checked < 20000; cj++) {
          checked++; var mem = hdoc.members[mids[cj]]; if (mem.status !== "active") continue;
          if (!memberWorksTour(hdoc, mem, et.y, et.m, et.d, tour)) continue;
          reminded++;
          sends.push(sendPush(mids[cj], { title: "🚒 Tour reminder", body: "You're working the " + (tour === 9 ? "☀️ 9× day tour" : "🌙 6× night tour") + " today.", url: "/?house=1", tag: "tour" }, "tours"));
        }
      }
      try { await Promise.race([Promise.all(sends), new Promise(function (rz) { setTimeout(rz, 25000); })]); } catch (e3) {}
      res.status(200).json({ ok: true, tour: tour, houses: ids.length, reminded: reminded });
      return;
    }

    if (req.method === "GET") {
      // credentials ride in headers (X-House-M / X-House-S), NOT the URL, so they don't land in access logs.
      var gid = clip(q.id, 64), gm = clip(H["x-house-m"] || q.m, 64), gs = String(H["x-house-s"] || q.s || "");
      if (!authOK(gm, gs)) { res.status(401).json({ error: "bad-auth" }); return; }
      var raw = await redis(["GET", HOUSE_PREFIX + gid]);
      if (!raw) { res.status(404).json({ error: "not-found" }); return; }
      var doc = JSON.parse(raw), me = doc.members[gm];
      if (!me) { res.status(403).json({ error: "not-member" }); return; }
      if (me.status !== "active") { res.status(200).json({ pending: true, id: doc.id, name: doc.name, status: me.status }); return; }
      res.status(200).json({ doc: doc });
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
        if (existing) {   // already known — never leak the doc unless already active
          if (existing.status === "active") res.status(200).json({ doc: d2 });
          else res.status(200).json({ pending: true, id: hid, name: d2.name, status: existing.status });
          return;
        }
        if ((d2.banned || []).indexOf(m) >= 0) { res.status(403).json({ error: "banned" }); return; }
        if (Object.keys(d2.members).length >= MAX_MEMBERS) { res.status(403).json({ error: "house-full" }); return; }
        var pend = Object.keys(d2.members).filter(function (k) { return d2.members[k].status !== "active"; }).length;
        if (pend >= MAX_PENDING) { res.status(403).json({ error: "too-many-pending" }); return; }
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
      if (op.type === "leave") {
        delete doc3.members[m]; doc3.admins = doc3.admins.filter(function (x) { return x !== m; }); doc3.ver++;
        if (await casSet(HOUSE_PREFIX + pid, raw3, JSON.stringify(doc3))) { res.status(200).json({ left: true }); return; }
        res.status(200).json({ left: true }); return;   // concurrent write? their membership is gone either way
      }
      res.status(403).json({ error: "not-active" }); return;
    }
    if (!isNaN(base) && doc3.ver !== base) { res.status(409).json({ error: "conflict", ver: doc3.ver, doc: doc3 }); return; }

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

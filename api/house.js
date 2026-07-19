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
    var toId = (rq.to && doc.members[rq.to] && rq.to !== m) ? rq.to : "";   // optional: directed at a specific member
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
    rt.takenBy = m; rt.status = "taken";
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

    if (a === "create") {
      var code = code6(), tries = 0;
      while ((await redis(["SET", CODE_PREFIX + code, "0", "NX", "EX", "60"]) === null) && tries++ < 6) code = code6();   // reserve the code atomically
      var id = rid(12), ndoc = newHouseDoc(id, code, m, body);
      await redis(["SET", HOUSE_PREFIX + id, JSON.stringify(ndoc), "EX", String(TTL)]);
      await redis(["SET", CODE_PREFIX + code, id, "EX", String(TTL)]);   // finalize the reservation -> houseId
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

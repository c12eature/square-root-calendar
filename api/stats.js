// Square Root Calendar — owner-only counts.
//
//   GET /api/stats   (Authorization: Bearer CRON_SECRET)
//
// Built to answer one question: how many people are using this without paying?
// It can only ever be a LOWER BOUND, and it is important to say why rather than
// hand over a confident wrong number:
//
//   · The app carries no analytics by design — no trackers, nothing in the
//     privacy policy that would let us count installs. Someone who never turned
//     on cloud backup, never enabled notifications and never bought leaves
//     ZERO trace here. They are uncountable, not merely uncounted.
//   · Backups are end-to-end encrypted, so we cannot look inside a blob to see
//     whether that user is grandfathered. The server genuinely does not know.
//
// So: paid unlocks are exact, "footprint" is everyone who touched a server
// feature, and the gap between them is the floor on non-payers.
//
// Returns COUNTS ONLY. It reads house documents to bucket subscription state
// and tally members, but never returns a name, phone, id or any content — the
// point is a dashboard number, not a list of people.

var REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
var CRON_SECRET = process.env.CRON_SECRET || "";

var SUB_TRIAL_DAYS = 30, SUB_GRACE_DAYS = 7;
var MAX_LOOPS = 200;        // SCAN cursor safety valve — a runaway must not burn the function
var MAX_DOCS = 400;         // house docs actually parsed

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

// Upstash returns [nextCursor, [keys...]]. Collect keys rather than trusting a single pass —
// SCAN gives no count guarantee per iteration, only that a full loop sees everything once.
async function scanKeys(pattern, cap) {
  var cursor = "0", keys = [], loops = 0;
  do {
    var res = await redis(["SCAN", cursor, "MATCH", pattern, "COUNT", "1000"]);
    if (!Array.isArray(res)) break;
    cursor = String(res[0] === undefined ? "0" : res[0]);
    var batch = res[1] || [];
    for (var i = 0; i < batch.length; i++) { keys.push(batch[i]); if (cap && keys.length >= cap) return keys; }
    loops++;
  } while (cursor !== "0" && loops < MAX_LOOPS);
  return keys;
}

module.exports = async function handler(req, res) {
  if (!REST_URL || !REST_TOKEN) { res.status(501).json({ error: "kv-not-configured" }); return; }
  var H = req.headers || {};
  if (!CRON_SECRET || (H["authorization"] || "") !== "Bearer " + CRON_SECRET) { res.status(401).json({ error: "bad-auth" }); return; }

  try {
    var now = Date.now();

    var paidApp   = await scanKeys("sqrtcal:ent:app:*");      // exact: the $9.99 unlocks actually bought
    var entHouse  = await scanKeys("sqrtcal:ent:house:*");    // house subscriptions ever created
    var blobs     = await scanKeys("sqrtcal:blob:*");         // distinct recovery codes with a cloud backup
    var remQueues = await scanKeys("sqrtcal:rq:*");           // users with reminders queued
    var remSubs   = await scanKeys("sqrtcal:rs:*");           // users with a device registered for push
    var feeds     = await scanKeys("sqrtcal:ics:*");          // published tour feeds
    var houseKeys = await scanKeys("sqrtcal:house:*");        // houses that exist
    var pushSubs  = await scanKeys("sqrtcal:push:*");         // House-side push registrations (per member)

    // House subscription state, and how many people each house is covering for free.
    var houseState = { trial: 0, active: 0, grace: 0, lapsed: 0, unreadable: 0 };
    var membersCovered = { trial: 0, active: 0, grace: 0, lapsed: 0 };
    for (var i = 0; i < houseKeys.length && i < MAX_DOCS; i++) {
      var raw = await redis(["GET", houseKeys[i]]);
      var doc; try { doc = JSON.parse(raw); } catch (e) { doc = null; }
      if (!doc) { houseState.unreadable++; continue; }
      var mode = "lapsed";
      var entRaw = await redis(["GET", "sqrtcal:ent:house:" + (doc.id || houseKeys[i].split(":").pop())]);
      var ent; try { ent = JSON.parse(entRaw); } catch (e) { ent = null; }
      if (ent && ent.st === "active" && ent.end > now) mode = "active";
      else if (ent && ent.end + SUB_GRACE_DAYS * 864e5 > now && ent.st !== "canceled") mode = "grace";
      else if (!ent && doc.createdAt && doc.createdAt + SUB_TRIAL_DAYS * 864e5 > now) mode = "trial";
      houseState[mode]++;
      var mem = doc.members || {}, live = 0;
      for (var id in mem) if (mem[id] && mem[id].status === "active") live++;
      membersCovered[mode] += live;
    }

    // Everyone who left ANY server trace. Rough — one person can appear in several — but the union
    // of recovery-code-keyed namespaces is the best proxy we have for "distinct users".
    var footprint = {};
    blobs.forEach(function (k) { footprint["b" + k.split(":").pop()] = 1; });
    var codeUsers = Object.keys(footprint).length;

    var freeRidingViaHouse = membersCovered.trial + membersCovered.grace;

    res.status(200).json({
      ok: true,
      generated: new Date(now).toISOString(),
      paid: {
        appUnlocks: paidApp.length,                 // EXACT — one per $9.99 purchase
        houseSubscriptions: entHouse.length,
      },
      footprint: {
        cloudBackupUsers: blobs.length,             // distinct recovery codes with a backup
        reminderQueues: remQueues.length,
        devicesRegisteredForPush: remSubs.length,
        publishedTourFeeds: feeds.length,
        housePushRegistrations: pushSubs.length,
      },
      houses: { total: houseKeys.length, byState: houseState, activeMembers: membersCovered },
      estimate: {
        // The headline. cloudBackupUsers is the cleanest per-user signal we have (one per recovery
        // code), so the floor on non-payers is simply how many of those never bought.
        nonPayersFloor: Math.max(0, codeUsers - paidApp.length),
        alsoFreeViaHouseTrialOrGrace: freeRidingViaHouse,
        caveat: "LOWER BOUND ONLY. No analytics exist, so anyone who never enabled cloud backup, notifications or the tour feed is invisible here. Backups are end-to-end encrypted, so the server cannot tell whether a given user is grandfathered.",
      },
    });
  } catch (e) {
    res.status(500).json({ error: "server", detail: (e && e.message) || "unknown" });
  }
};

#!/usr/bin/env python3
# Regenerate fhstats.js (window.FH_STATS) from the FDNY runs-and-workers pull.
#
#   python3 build-firehouse-stats.py [path-to-fdny_firehouse_stats.json]
#
# Source of truth: the full (pretty) JSON produced by the stats pull — see
# ~/Desktop/fdny-firehouse-stats/README.md for how it is built and verified.
# This trims it to exactly what the Firehouses directory renders, keyed for a
# join on UNIT NAME ("Engine 290"), which is stable where address strings are
# not. Year rows are compact tuples to keep the file phone-sized:
#   house year row:   [year, runs, fires, all_hands]
#   company year row: [year, runs, fires, all_hands, rank_overall, of]
# When FDNY publishes a new year, re-run the pull, then re-run this.

import json, sys, os

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/Desktop/fdny-firehouse-stats/fdny_firehouse_stats.json")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fhstats.js")

d = json.load(open(SRC))
meta = d["meta"]
latest = meta["latest_year"]

houses = []
for h in d["firehouses"]:
    cos = []
    for c in h.get("companies", []):
        l = c.get("latest") or {}
        cos.append({
            "u": c["unit"],
            "t": c.get("type", ""),
            "l": {
                "r": l.get("runs"), "em": l.get("ems"), "eg": l.get("emergencies"),
                "f": l.get("fires"), "ah": l.get("all_hands"),
                "rk": l.get("rank_overall"), "of": l.get("of"),
                "rt": l.get("rank_in_type"), "tc": l.get("type_count"),
            },
            "yrs": [[y["year"], y.get("runs"), y.get("fires"), y.get("all_hands"),
                     y.get("rank_overall"), y.get("of")] for y in c.get("history", [])],
        })
    ht = h.get("house_totals", {})
    yrs = [[int(y), (ht[y] or {}).get("runs"), (ht[y] or {}).get("fires"),
            (ht[y] or {}).get("all_hands")] for y in sorted(ht.keys())]
    rank = h.get("house_rank_latest") or {}
    tot = (ht.get(str(latest)) or {})
    houses.append({
        "n": h["name"],
        "hood": h.get("neighborhood", ""),
        "rank": rank.get("rank"), "of": rank.get("of"),
        "tot": {"r": tot.get("runs"), "f": tot.get("fires"), "ah": tot.get("all_hands")},
        "yrs": yrs,
        "cos": cos,
    })

out = {
    "meta": {"years": meta["years"], "latest": latest,
             "credit": "FDNY Runs & Workers via fdnewyork.com · cross-checked against NYC Fire Wire"},
    "houses": houses,
}
js = "window.FH_STATS=" + json.dumps(out, separators=(",", ":"), ensure_ascii=False) + ";\n"
open(OUT, "w").write(js)
print("wrote %s (%d KB, %d houses, %d companies)" % (
    OUT, len(js) // 1024, len(houses), sum(len(h["cos"]) for h in houses)))

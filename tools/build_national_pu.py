"""Build the national polling unit list from the INEC dataset.

Produces, from one source of truth:

  presidential-polling-units.csv    every polling unit in Nigeria, flat
  presidential-polling-units.xlsx   the same, as a workbook
  site/polling-units.json           what the site actually downloads

The INEC PU code is the spine of the whole portal -- uploads, counters and
totals are all keyed on it -- so the code is BUILT from the dataset's numeric
parts ([state]-[lga]-[ward]-[pu]) rather than trusted as a string, and the
result is checked against the 3,763 Osun rows we already hold. If Osun does not
reproduce exactly, the build fails: a polling unit list with invented or
shifted codes would send citizens' photos to the wrong unit.

Usage:
    python tools/build_national_pu.py path/to/inecdata.json
"""

import csv
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OSUN_REF = os.path.join(ROOT, "osun-polling-units.csv")
OUT_CSV = os.path.join(ROOT, "presidential-polling-units.csv")
OUT_XLSX = os.path.join(ROOT, "presidential-polling-units.xlsx")
OUT_JSON = os.path.join(ROOT, "site", "polling-units.json")
PU_DIR = os.path.join(ROOT, "site", "pu")

COLUMNS = ["S/N", "INEC PU Code", "State", "LGA", "Ward", "PU Serial (in Ward)", "Polling Unit Name"]

# A handful of polling units the front page shows before anyone searches, so it
# opens on something real rather than an empty table. They ride along in the
# index, which every visit already fetches, so showing them costs no request
# and a few hundred bytes -- as against pulling a whole state file to display
# five rows.
FEATURED = [
    "01-01-01-005",
    "01-01-01-006",
    "01-01-01-007",
    "01-01-01-008",
    "01-01-01-009",
]


def clean(s):
    """Collapse the runs of whitespace the source is full of."""
    return re.sub(r"\s+", " ", str(s or "")).strip()


def load(path):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def flatten(states):
    """Every polling unit as a flat row, with the code built from the parts."""
    rows = []
    for st in states:
        s_code = f"{int(st['id']):02d}"
        s_name = clean(st["name"])
        for lga in st["lgas"]:
            l_code = clean(lga["abbreviation"])
            l_name = clean(lga["name"])
            for ward in lga["wards"]:
                w_code = clean(ward["abbreviation"])
                w_name = clean(ward["name"])
                for unit in ward["units"]:
                    u_code = clean(unit["abbreviation"])
                    rows.append({
                        "code": f"{s_code}-{l_code}-{w_code}-{u_code}",
                        "state": s_name,
                        "state_code": s_code,
                        # The site has always shown "01 - ATAKUMOSA EAST", and the
                        # number is what a searcher reads off a result sheet.
                        "lga": f"{l_code} - {l_name}",
                        "ward": f"{w_code} - {w_name}",
                        "serial": u_code,
                        "name": clean(unit["name"]),
                    })
    return rows


def check_against_osun(rows):
    """Osun is the part we already have verified, so it is the control."""
    if not os.path.exists(OSUN_REF):
        print("  ! osun-polling-units.csv not present, skipping the control check")
        return
    ref = set()
    with io.open(OSUN_REF, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            ref.add(r["INEC PU Code"])
    built = {r["code"] for r in rows if r["code"].startswith("29-")}

    missing = ref - built
    extra = built - ref
    if missing or extra:
        raise SystemExit(
            f"REFUSING TO BUILD: Osun does not reproduce.\n"
            f"  {len(missing)} known codes absent (e.g. {sorted(missing)[:3]})\n"
            f"  {len(extra)} unknown codes present (e.g. {sorted(extra)[:3]})\n"
            f"The PU code keys every upload and total on the portal; a list whose "
            f"codes do not match the ones already in use would misfile results."
        )
    print(f"  control check: all {len(ref)} known Osun codes reproduce exactly")


def write_csv(rows):
    with io.open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        for i, r in enumerate(rows, 1):
            w.writerow([i, r["code"], r["state"], r["lga"], r["ward"], r["serial"], r["name"]])
    print(f"  {OUT_CSV}  {os.path.getsize(OUT_CSV):,} bytes")


def write_xlsx(rows):
    from openpyxl import Workbook
    wb = Workbook(write_only=True)
    ws = wb.create_sheet("Polling Units")
    ws.append(COLUMNS)
    for i, r in enumerate(rows, 1):
        ws.append([i, r["code"], r["state"], r["lga"], r["ward"], r["serial"], r["name"]])
    wb.save(OUT_XLSX)
    print(f"  {OUT_XLSX}  {os.path.getsize(OUT_XLSX):,} bytes")


def write_site_json(rows):
    """What the browser downloads.

    176,595 units in one file is 1.8 MB over the wire even gzipped, which is a
    quarter-minute of waiting on the mobile connections this portal is actually
    used on. So it ships as:

      polling-units.json    states + LGAs + wards only -- the index, always loaded
      pu/<state>.json       one state's units, fetched when something needs them

    That works because a PU code begins with its state ("29-..." is Osun), so
    the first thing a searcher types already says which file to fetch. The
    index stays the size the whole cost model was built around.

    The PU code is NOT stored per unit: it is rebuilt in the browser from the
    ward's own prefix plus the unit's serial, which removes ~13 bytes from
    every one of 176k rows without losing anything.
    """
    states, lgas, wards = [], [], []
    s_idx, l_idx, w_idx = {}, {}, {}
    pus = []

    for r in rows:
        sk = r["state_code"]
        if sk not in s_idx:
            s_idx[sk] = len(states)
            states.append([r["state"], sk])
        lk = (sk, r["lga"])
        if lk not in l_idx:
            l_idx[lk] = len(lgas)
            lgas.append([r["lga"], s_idx[sk]])
        wk = (sk, r["lga"], r["ward"])
        if wk not in w_idx:
            w_idx[wk] = len(wards)
            # The ward carries the code prefix, so a unit only needs its serial.
            prefix = r["code"].rsplit("-", 1)[0]
            wards.append([r["ward"], l_idx[lk], prefix])
        pus.append([r["serial"], r["name"], w_idx[wk]])

    # Per-state unit files. `pus` is grouped by the state its ward belongs to.
    ward_state = []
    for w in wards:
        ward_state.append(lgas[w[1]][1])

    by_state = {}
    for serial, name, wi in pus:
        by_state.setdefault(ward_state[wi], []).append([serial, name, wi])

    os.makedirs(PU_DIR, exist_ok=True)
    for old in os.listdir(PU_DIR):
        if old.endswith(".json"):
            os.remove(os.path.join(PU_DIR, old))

    total = 0
    biggest = ("", 0)
    for si, units in by_state.items():
        code = states[si][1]
        path = os.path.join(PU_DIR, f"{code}.json")
        with io.open(path, "w", encoding="utf-8") as f:
            json.dump({"state": code, "pus": units}, f, ensure_ascii=False, separators=(",", ":"))
        n = os.path.getsize(path)
        total += n
        if n > biggest[1]:
            biggest = (f"{states[si][0]} ({code})", n)

    # The featured units are stored in exactly the shape a state file uses, so
    # the browser describes them with the same code path and no special case.
    want = set(FEATURED)
    featured = []
    for si, units in by_state.items():
        for u in units:
            if f"{wards[u[2]][2]}-{u[0]}" in want:
                featured.append(u)
    found = {f"{wards[u[2]][2]}-{u[0]}" for u in featured}
    missing = want - found
    if missing:
        raise SystemExit(
            f"REFUSING TO BUILD: featured polling units not in the dataset: "
            f"{sorted(missing)}. The front page would advertise units that do not exist."
        )
    featured.sort(key=lambda u: f"{wards[u[2]][2]}-{u[0]}")

    index = {"v": 2, "states": states, "lgas": lgas, "wards": wards, "featured": featured,
             "counts": {states[si][1]: len(u) for si, u in by_state.items()}}
    with io.open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(OUT_JSON)
    print(f"  {OUT_JSON}  {size:,} bytes  "
          f"({len(states)} states, {len(lgas)} LGAs, {len(wards)} wards, "
          f"{len(featured)} featured) -- always loaded")
    print(f"  {PU_DIR}{os.sep}<state>.json  {len(by_state)} files, {total:,} bytes total, "
          f"largest {biggest[0]} at {biggest[1]:,}")
    return size


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if not src or not os.path.exists(src):
        raise SystemExit("usage: python tools/build_national_pu.py <inecdata.json>")

    print(f"reading {src}")
    rows = flatten(load(src))
    print(f"  {len(rows):,} polling units")

    dupes = len(rows) - len({r['code'] for r in rows})
    if dupes:
        raise SystemExit(f"REFUSING TO BUILD: {dupes} duplicate PU codes; the code must be unique.")
    print("  every PU code is unique")

    check_against_osun(rows)
    write_csv(rows)
    write_xlsx(rows)
    write_site_json(rows)
    print("done")


if __name__ == "__main__":
    main()

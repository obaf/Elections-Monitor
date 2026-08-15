"""Checks that revoking demands a reason and that the audit trail records it."""
import json
import re
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://www.irev2.com").rstrip("/")
FAIL = []


def call(path, payload=None, auth=None):
    hdrs, data = {}, None
    if payload is not None:
        data = json.dumps(payload).encode()
        hdrs["content-type"] = "application/json"
    if auth:
        hdrs["authorization"] = "Bearer " + auth
    req = urllib.request.Request(BASE + path, data=data, headers=hdrs,
                                method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read() or b"{}")


def upload(code, path, device):
    s = call("/api/upload-url", {"puCode": code})
    urllib.request.urlopen(urllib.request.Request(
        s["url"], data=open(path, "rb").read(), method="PUT",
        headers={"content-type": "image/jpeg"}), timeout=120)
    return call("/api/upload-done", {"puCode": code, "key": s["key"], "deviceId": device})


def check(label, got, want):
    ok = got == want
    print("   {}  {}".format("PASS" if ok else "FAIL", label))
    if not ok:
        print("         got  {!r}".format(got))
        print("         want {!r}".format(want))
        FAIL.append(label)


A = "29-01-01-001"
RES_A = {"APC": 212, "PDP": 178, "LP": 64, "NNPP": 21, "ADC": 9}
REASON = "figures do not match the physical result sheet"

txt = open("admin user and pwd.txt", encoding="utf-8").read()
tok = call("/api/admin/login", {
    "username": re.search(r"Username\s*:\s*(\S+)", txt).group(1),
    "password": re.search(r"Password\s*:\s*(\S+)", txt).group(1),
})["token"]

print("1. get a unit added")
upload(A, "tools/seed/{}-1.jpg".format(A), "ph-a")
upload(A, "tools/seed/{}-2.jpg".format(A), "ph-b")
check("totals", call("/api/summary")["totals"], RES_A)

print("\n2. revoke without a usable reason must be refused")
for bad in ({"puCode": A}, {"puCode": A, "reason": "   "}, {"puCode": A, "reason": "no"}):
    label = "refused reason={!r}".format(bad.get("reason", "<absent>"))
    try:
        call("/api/admin/revoke", bad, auth=tok)
        check(label, "allowed", 400)
    except urllib.error.HTTPError as e:
        check(label, e.code, 400)
check("totals untouched by refused revokes", call("/api/summary")["totals"], RES_A)

print("\n3. revoke with a reason")
r = call("/api/admin/revoke", {"puCode": A, "reason": REASON}, auth=tok)
check("removed exactly what was added", r["removed"], RES_A)
check("totals back to zero", call("/api/summary")["totals"], {k: 0 for k in RES_A})
row = [x for x in call("/api/breakdown")["rows"] if x["puCode"] == A][0]
check("status", row["status"], "revoked")
check("reason visible publicly", row["reason"], REASON)
check("revoked figures retained for display", row["revokedFigures"], RES_A)

print("\n4. audit trail")
entries = call("/api/admin/audit", auth=tok)["entries"]
rev = [e for e in entries if e["action"] == "revoke" and e["puCode"] == A]
check("revoke recorded", len(rev) >= 1, True)
check("reason recorded", rev[0]["reason"], REASON)
check("figures recorded", rev[0]["figures"], RES_A)
check("actor recorded", bool(rev[0]["actor"]), True)

print("\n5. audit log requires admin")
try:
    call("/api/admin/audit")
    check("unauthenticated audit refused", "allowed", 401)
except urllib.error.HTTPError as e:
    check("unauthenticated audit refused", e.code, 401)

print("\n" + ("ALL PASSED" if not FAIL else "{} FAILED: {}".format(len(FAIL), FAIL)))
sys.exit(1 if FAIL else 0)

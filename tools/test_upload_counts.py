"""Checks the admin-only upload count view.

The point of the feature is that a photo is counted here whether or not the
result was added to the totals, so the test creates both cases: one unit with a
single uncounted photo, and one with two matching photos that verify.
"""
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
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"{}")


def upload(code, path, device):
    s = call("/api/upload-url", {"puCode": code})
    urllib.request.urlopen(urllib.request.Request(
        s["url"], data=open(path, "rb").read(), method="PUT",
        headers={"content-type": "image/jpeg"}), timeout=180)
    return call("/api/upload-done", {"puCode": code, "key": s["key"], "deviceId": device})


def check(label, got, want):
    ok = got == want
    print("   {}  {}".format("PASS" if ok else "FAIL", label))
    if not ok:
        print("         got  {!r}".format(got))
        print("         want {!r}".format(want))
        FAIL.append(label)


A = "29-01-01-001"   # will be verified (two matching photos, two phones)
B = "29-01-01-002"   # one photo only, never counted

txt = open("admin user and pwd.txt", encoding="utf-8").read()
tok = call("/api/admin/login", {
    "username": re.search(r"Username\s*:\s*(\S+)", txt).group(1),
    "password": re.search(r"Password\s*:\s*(\S+)", txt).group(1),
})["token"]

print("1. the endpoint is admin-only")
try:
    call("/api/admin/upload-counts")
    check("unauthenticated request refused", "allowed", 401)
except urllib.error.HTTPError as e:
    check("unauthenticated request refused", e.code, 401)

print("\n2. empty to begin with")
check("no units listed", call("/api/admin/upload-counts", auth=tok)["rows"], [])

print("\n3. one unit verified, one with a single uncounted photo")
upload(A, "tools/seed/{}-1.jpg".format(A), "ph-a")
r = upload(A, "tools/seed/{}-2.jpg".format(A), "ph-b")
check("unit A verified", r["verified"], True)
r = upload(B, "tools/seed/{}-1.jpg".format(B), "ph-c")
check("unit B not verified", r["verified"], False)

rows = {x["puCode"]: x for x in call("/api/admin/upload-counts", auth=tok)["rows"]}
check("both units listed", sorted(rows), sorted([A, B]))
check("unit A upload count", rows[A]["uploads"], 2)
check("unit A status", rows[A]["status"], "added")
check("uncounted unit still counted here", rows[B]["uploads"], 1)
check("unit B status", rows[B]["status"], "pending")

print("\n4. a third photo bumps the count")
upload(B, "tools/seed/{}-2.jpg".format(B), "ph-c")   # same phone, so still not verified
rows = {x["puCode"]: x for x in call("/api/admin/upload-counts", auth=tok)["rows"]}
check("unit B count now 2", rows[B]["uploads"], 2)
check("unit B still not added (same phone)", rows[B]["status"], "pending")

print("\n5. counts are NOT exposed on the public breakdown")
pub = call("/api/breakdown")["rows"]
check("public rows carry no upload count",
      any("uploads" in row for row in pub), False)

print("\n" + ("ALL PASSED" if not FAIL else "{} FAILED: {}".format(len(FAIL), FAIL)))
sys.exit(1 if FAIL else 0)

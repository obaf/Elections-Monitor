"""End-to-end check of the breakdown, revoke and status behaviour.

Drives the live API only -- no direct table writes -- so a pass means the
deployed Lambda really behaves this way. Leaves the data in place; run
tools/purge helpers afterwards if a clean slate is wanted.
"""
import json
import re
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://www.irev2.com").rstrip("/")
FAIL = []


def call(path, payload=None, auth=None, method=None):
    hdrs = {}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        hdrs["content-type"] = "application/json"
    if auth:
        hdrs["authorization"] = "Bearer " + auth
    req = urllib.request.Request(BASE + path, data=data, headers=hdrs,
                                method=method or ("POST" if data else "GET"))
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read() or b"{}")


def upload(code, path, device):
    signed = call("/api/upload-url", {"puCode": code})
    body = open(path, "rb").read()
    put = urllib.request.Request(signed["url"], data=body, method="PUT",
                                headers={"content-type": "image/jpeg"})
    urllib.request.urlopen(put, timeout=120)
    return call("/api/upload-done", {"puCode": code, "key": signed["key"], "deviceId": device})


def check(label, got, want):
    ok = got == want
    print(f"   {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        print(f"         got  {got}\n         want {want}")
        FAIL.append(label)


def status_of(code):
    for r in call("/api/breakdown")["rows"]:
        if r["puCode"] == code:
            return r["status"]
    return "absent"


A, B = "29-01-01-001", "29-01-01-002"
RES_A = {"APC": 212, "PDP": 178, "LP": 64, "NNPP": 21, "ADC": 9}
RES_B = {"APC": 143, "PDP": 205, "LP": 88, "NNPP": 17, "ADC": 6}
BOTH = {k: RES_A[k] + RES_B[k] for k in RES_A}

txt = open("admin user and pwd.txt", encoding="utf-8").read()
tok = call("/api/admin/login", {
    "username": re.search(r"Username\s*:\s*(\S+)", txt).group(1),
    "password": re.search(r"Password\s*:\s*(\S+)", txt).group(1),
})["token"]

print("1. two matching photos per unit, from two different phones")
for code, n in ((A, "001"), (B, "002")):
    upload(code, f"tools/seed/{code}-1.jpg", f"phone-{n}-x")
    upload(code, f"tools/seed/{code}-2.jpg", f"phone-{n}-y")
check("totals are the sum of both units", call("/api/summary")["totals"], BOTH)
check("unit A status", status_of(A), "added")
check("unit B status", status_of(B), "added")

print("\n2. breakdown reports each unit's own figures")
rows = {r["puCode"]: r["results"] for r in call("/api/breakdown")["rows"]}
check("unit A figures", rows.get(A), RES_A)
check("unit B figures", rows.get(B), RES_B)

print("\n3. admin revokes unit A")
call("/api/admin/revoke", {"puCode": A}, auth=tok)
check("totals drop by exactly unit A", call("/api/summary")["totals"], RES_B)
check("unit A status", status_of(A), "revoked")
check("unit B untouched", status_of(B), "added")

print("\n4. a further matching photo must NOT resurrect a revoked unit")
r = upload(A, f"tools/seed/{A}-1.jpg", "phone-001-z")
check("upload not auto-verified", r["verified"], False)
check("totals unchanged", call("/api/summary")["totals"], RES_B)
check("still revoked", status_of(A), "revoked")

print("\n5. admin re-approval is an explicit reversal and is allowed")
uid = call(f"/api/pu?code={A}")["uploads"][-1]["uploadId"]
call("/api/admin/approve", {"puCode": A, "uploadId": uid}, auth=tok)
check("totals restored", call("/api/summary")["totals"], BOTH)
check("unit A status", status_of(A), "added")

print("\n6. revoke requires admin")
try:
    call("/api/admin/revoke", {"puCode": B})
    check("unauthenticated revoke refused", "allowed", "401")
except urllib.error.HTTPError as e:
    check("unauthenticated revoke refused", e.code, 401)

print("\n" + ("ALL PASSED" if not FAIL else f"{len(FAIL)} FAILED: {FAIL}"))
sys.exit(1 if FAIL else 0)

"""Live check of approve-with-edits, including the failure paths.

The reported symptom was "I amended the figures, clicked approve, and it did
not add to the totals" with no explanation. So this asserts both that a valid
edit lands, and that every refusal comes back with a message worth reading.
"""
import json
import re
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://www.irev2.com").rstrip("/")
PU = "29-01-01-005"
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
    def parse(status, raw, ctype):
        # A non-JSON error body means something rewrote the API's response --
        # exactly the CloudFront error-page problem this test guards against.
        try:
            return status, json.loads(raw or b"{}")
        except Exception:
            return status, {"error": "", "_nonjson": True, "_ctype": ctype,
                            "_body": raw[:80].decode("utf-8", "replace")}
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return parse(r.status, r.read(), r.headers.get("content-type"))
    except urllib.error.HTTPError as e:
        return parse(e.code, e.read(), e.headers.get("content-type"))


def upload(code, path, device):
    _, s = call("/api/upload-url", {"puCode": code})
    urllib.request.urlopen(urllib.request.Request(
        s["url"], data=open(path, "rb").read(), method="PUT",
        headers={"content-type": "image/jpeg"}), timeout=180)
    return call("/api/upload-done", {"puCode": code, "key": s["key"], "deviceId": device})[1]


def check(label, got, want):
    ok = got == want
    print("   {}  {}".format("PASS" if ok else "FAIL", label))
    if not ok:
        print("         got  {!r}".format(got))
        print("         want {!r}".format(want))
        FAIL.append(label)


txt = open("admin user and pwd.txt", encoding="utf-8").read()
tok = call("/api/admin/login", {
    "username": re.search(r"Username\s*:\s*(\S+)", txt).group(1),
    "password": re.search(r"Password\s*:\s*(\S+)", txt).group(1),
})[1]["token"]

print("1. upload a photo that will not auto-verify")
r = upload(PU, "tools/seed/repro.jpg", "approve-test")
check("read by OCR", r["extracted"], {"APC": 50, "PDP": 60})
check("not auto-verified (single phone)", r["verified"], False)
uid = call("/api/pu?code=" + PU)[1]["uploads"][-1]["uploadId"]

print("\n2. every refusal explains itself")
for label, payload, want_code in (
    ("unknown uploadId", {"puCode": PU, "uploadId": "00000000-0000-0000-0000-000000000000",
                          "figures": {"APC": 1}}, 422),
    ("empty figures", {"puCode": PU, "uploadId": uid, "figures": {}}, 400),
    ("all rows junk", {"puCode": PU, "uploadId": uid, "figures": {"": "x", "!!": -3}}, 400),
):
    code, resp = call("/api/admin/approve", payload, auth=tok)
    check(label + " -> status", code, want_code)
    check(label + " -> body is JSON, not an error page", resp.get("_nonjson", False), False)
    check(label + " -> has a readable message", bool(resp.get("error", "").strip()), True)
    print("         message: {}".format(resp.get("error") or resp.get("_body")))

print("\n3. the refusals changed nothing")
check("totals still empty", call("/api/summary")[1]["totals"], {})

print("\n4. an amended approve lands")
before = call("/api/summary")[1]["totals"]
edited = {"APC": 55, "PDP": 60, "ACCORD": 12}   # APC corrected, ACCORD added
code, resp = call("/api/admin/approve", {"puCode": PU, "uploadId": uid, "figures": edited}, auth=tok)
check("status", code, 200)
check("reports what it added", resp.get("added"), edited)
check("returns the new totals in the response", resp.get("totals"), edited)

print("\n5. and it is actually persisted")
check("summary matches", call("/api/summary")[1]["totals"], edited)
row = [x for x in call("/api/breakdown")[1]["rows"] if x["puCode"] == PU][0]
check("breakdown figures", row["results"], edited)
check("status added", row["status"], "added")

print("\n6. the edit is recorded as an edit, with what OCR had said")
entry = [e for e in call("/api/admin/audit", auth=tok)[1]["entries"]
         if e["puCode"] == PU and e["action"] in ("approve", "re-approve")][0]
check("flagged as edited", entry["edited"], True)
check("keeps the OCR original", entry["ocr"], {"APC": 50, "PDP": 60})
check("records the approved figures", entry["figures"], edited)

print("\n" + ("ALL PASSED" if not FAIL else "{} FAILED: {}".format(len(FAIL), FAIL)))
sys.exit(1 if FAIL else 0)

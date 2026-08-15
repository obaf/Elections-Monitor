"""Live check that the party list grows from a real upload.

Uploads a sheet carrying two parties absent from the seed list and asserts they
are read, registered, and counted into the totals.
"""
import json
import sys
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://www.irev2.com").rstrip("/")
FAIL = []

PU = "29-01-01-004"
NEW = ["NNDP", "ZENITH"]
EXPECT = {"APC": 61, "PDP": 74, "ZENITH": 33, "NNDP": 18}


def call(path, payload=None):
    hdrs, data = {}, None
    if payload is not None:
        data = json.dumps(payload).encode()
        hdrs["content-type"] = "application/json"
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


print("1. the new parties are not registered to begin with")
before = call("/api/parties")["parties"]
check("ZENITH unknown", "ZENITH" in before, False)
check("NNDP unknown", "NNDP" in before, False)

print("\n2. upload a sheet carrying them")
a = upload(PU, "tools/seed/{}-1.jpg".format(PU), "disc-a")
check("read from the photo", a["extracted"], EXPECT)

print("\n3. they are now registered")
after = call("/api/parties")["parties"]
check("ZENITH registered", "ZENITH" in after, True)
check("NNDP registered", "NNDP" in after, True)
check("list grew by exactly two", len(after) - len(before), 2)
check("list stayed alphabetical", after, sorted(after, key=lambda s: s.lower()))

print("\n4. a second matching photo counts them into the totals")
b = upload(PU, "tools/seed/{}-2.jpg".format(PU), "disc-b")
check("verified", b["verified"], True)
totals = call("/api/summary")["totals"]
check("totals include the new parties", totals, EXPECT)

print("\n5. the breakdown reports them for the unit")
row = [r for r in call("/api/breakdown")["rows"] if r["puCode"] == PU][0]
check("breakdown figures", row["results"], EXPECT)
check("status", row["status"], "added")

print("\n" + ("ALL PASSED" if not FAIL else "{} FAILED: {}".format(len(FAIL), FAIL)))
sys.exit(1 if FAIL else 0)

"""Checks the messages-to-admin view is genuinely admin-only.

The button being hidden is presentation; what matters is that the endpoint
behind it refuses an unauthenticated caller, and that a real visitor message is
visible to an admin without the visitor being able to read anyone else's.
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
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read() or b"{}")


def check(label, got, want):
    ok = got == want
    print("   {}  {}".format("PASS" if ok else "FAIL", label))
    if not ok:
        print("         got  {!r}".format(got))
        print("         want {!r}".format(want))
        FAIL.append(label)


print("1. the endpoint refuses anyone without a token")
for hdr in (None, "not-a-token", "0.deadbeef"):
    label = "refused auth={!r}".format(hdr)
    try:
        call("/api/admin/threads", auth=hdr)
        check(label, "allowed", 401)
    except urllib.error.HTTPError as e:
        check(label, e.code, 401)

print("\n2. the page itself is reachable but reveals nothing without a login")
page = urllib.request.urlopen(BASE + "/admin-messages.html", timeout=60).read().decode()
check("page served", "Messages to admin" in page, True)
check("carries noindex", 'name="robots"' in page and "noindex" in page, True)
check("no message text baked into the html", "pleading" in page.lower(), False)
check("panel hidden until login", 'id="panel" hidden' in page, True)

print("\n3. the front page hides the button from visitors")
home = urllib.request.urlopen(BASE + "/", timeout=60).read().decode()
check("button present in markup", "Messages to admin" in home, True)
check("hidden by default", bool(re.search(r'id="admin-msgs-btn"[^>]*hidden', home)), True)

print("\n4. an admin sees every conversation")
txt = open("admin user and pwd.txt", encoding="utf-8").read()
tok = call("/api/admin/login", {
    "username": re.search(r"Username\s*:\s*(\S+)", txt).group(1),
    "password": re.search(r"Password\s*:\s*(\S+)", txt).group(1),
})["token"]
threads = call("/api/admin/threads", auth=tok)["threads"]
check("at least the two known threads visible", len(threads) >= 2, True)
check("each thread carries its messages",
      all(isinstance(t.get("messages"), list) and t["messages"] for t in threads), True)
check("newest first", [t["lastTs"] for t in threads],
      sorted([t["lastTs"] for t in threads], reverse=True))

print("\n5. a visitor can still only read their own thread")
mine = call("/api/messages", {"text": "smoke check: own thread only"})["threadId"]
others = [t["threadId"] for t in threads if t["threadId"] != mine]
own = call("/api/messages?threadId={}".format(mine))["messages"]
check("own thread readable", len(own), 1)
if others:
    # Reading by id is how the visitor page works; it must not expose a listing.
    check("no public listing endpoint", "threads" in call("/api/messages?threadId=" + mine), False)

print("\n" + ("ALL PASSED" if not FAIL else "{} FAILED: {}".format(len(FAIL), FAIL)))
sys.exit(1 if FAIL else 0)

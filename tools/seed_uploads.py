"""Push the sample result photos through the live API.

Deliberately uses the same three calls the browser makes -- presign, PUT to
S3, then notify -- so a successful run exercises EXIF reading, Textract, the
party parser and the two-phones verification rule rather than just writing
rows into DynamoDB.
"""
import json
import sys
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://www.irev2.com").rstrip("/")


def post(path, payload):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def put(url, body):
    # The browser sets this automatically from the File object; urllib would
    # otherwise send application/x-www-form-urlencoded and S3 would store the
    # photo under that content type.
    req = urllib.request.Request(
        url, data=body, method="PUT", headers={"content-type": "image/jpeg"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status


def main():
    manifest = json.load(open("tools/seed/manifest.json"))
    for entry in manifest:
        code, path, device = entry["puCode"], entry["file"], entry["device"]
        body = open(path, "rb").read()

        signed = post("/api/upload-url", {"puCode": code})
        put(signed["url"], body)
        done = post("/api/upload-done", {"puCode": code, "key": signed["key"], "deviceId": device})

        ok = done.get("extracted") == entry["expect"]
        print(f"{code} {device}")
        print(f"   extracted : {done.get('extracted')}")
        print(f"   expected  : {entry['expect']}   match={ok}")
        print(f"   gps in osun: {done.get('inOsun')}   verified: {done.get('verified')}")

    summary = json.loads(urllib.request.urlopen(f"{BASE}/api/summary", timeout=60).read())
    print("\nTOTALS SO FAR:", summary["totals"])
    counted = {k: v for k, v in summary["counts"].items() if v[1]}
    print("VERIFIED POLLING UNITS:", counted)


if __name__ == "__main__":
    main()

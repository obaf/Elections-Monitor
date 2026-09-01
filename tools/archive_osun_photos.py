"""Copy the finished Osun election's result photos into the archive bucket.

The Osun election is over. Its photos stay publicly viewable, but they belong
to a closed contest, so they are moved out of the live photo bucket's way and
into an archive bucket of their own, served from /osun-archive/*.

Two deliberate choices:

* Objects are copied under an "osun-archive/" prefix that MATCHES THE URL
  exactly ("osun-archive/photos/<pu>/<uuid>.jpg" is served at
  "/osun-archive/photos/<pu>/<uuid>.jpg"). CloudFront cannot strip a path
  prefix without a function at the edge, so the key is chosen to make one
  unnecessary.

* Nothing is deleted. This is a copy, verified byte-count against byte-count,
  and the originals stay where they are. An election archive is evidence; the
  point of the exercise is that the Osun record survives, so the destructive
  half is left as a separate, explicit decision for a human to make later
  (--delete-source), long after the copy has been confirmed good.

Usage:
    python tools/archive_osun_photos.py            # copy and verify
    python tools/archive_osun_photos.py --dry-run  # show what would be copied
"""

import argparse
import subprocess
import sys
import json

ACCOUNT = "768332541841"
SRC_BUCKET = f"irev2-com-photos-{ACCOUNT}"
DST_BUCKET = f"irev2-com-osun-archive-{ACCOUNT}"
SRC_PREFIX = "photos/"
DST_PREFIX = "osun-archive/"


def aws(*args):
    """Run an AWS CLI command and return parsed JSON stdout."""
    out = subprocess.run(
        ["aws", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if out.returncode != 0:
        raise SystemExit(f"aws {' '.join(args)}\n{out.stderr.strip()}")
    return json.loads(out.stdout) if out.stdout.strip() else {}


def listing(bucket, prefix):
    """Every object under a prefix as {key: size}, following pagination."""
    found, token = {}, None
    while True:
        args = [
            "s3api", "list-objects-v2",
            "--bucket", bucket, "--prefix", prefix,
            "--max-keys", "1000", "--output", "json",
        ]
        if token:
            args += ["--starting-token", token]
        page = aws(*args)
        for obj in page.get("Contents", []):
            found[obj["Key"]] = obj["Size"]
        token = page.get("NextContinuationToken")
        if not token:
            return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--delete-source",
        action="store_true",
        help="after a verified copy, delete the originals. Separate on purpose.",
    )
    args = ap.parse_args()

    src = listing(SRC_BUCKET, SRC_PREFIX)
    if not src:
        print(f"nothing under s3://{SRC_BUCKET}/{SRC_PREFIX}")
        return 0

    total = sum(src.values())
    print(f"source: {len(src)} objects, {total:,} bytes in s3://{SRC_BUCKET}/{SRC_PREFIX}")

    dst_before = listing(DST_BUCKET, DST_PREFIX)
    todo = {k: v for k, v in src.items() if DST_PREFIX + k not in dst_before}
    print(f"already archived: {len(src) - len(todo)}   to copy: {len(todo)}")

    if args.dry_run:
        for k in sorted(todo):
            print(f"  would copy {k} -> {DST_PREFIX + k}")
        return 0

    for i, key in enumerate(sorted(todo), 1):
        dst_key = DST_PREFIX + key
        aws(
            "s3api", "copy-object",
            "--bucket", DST_BUCKET,
            "--key", dst_key,
            "--copy-source", f"{SRC_BUCKET}/{key}",
            "--output", "json",
        )
        print(f"  [{i}/{len(todo)}] {key} -> {dst_key}")

    # Verify every source object landed with the same byte count. A copy that
    # silently dropped or truncated an object is exactly the failure this whole
    # exercise exists to avoid, so it is checked rather than assumed.
    dst_after = listing(DST_BUCKET, DST_PREFIX)
    missing, mismatched = [], []
    for key, size in src.items():
        dst_key = DST_PREFIX + key
        if dst_key not in dst_after:
            missing.append(key)
        elif dst_after[dst_key] != size:
            mismatched.append((key, size, dst_after[dst_key]))

    if missing or mismatched:
        for k in missing:
            print(f"MISSING   {k}")
        for k, a, b in mismatched:
            print(f"SIZE DIFF {k}: source {a} != archive {b}")
        print("\nARCHIVE INCOMPLETE - originals left untouched.")
        return 1

    archived_bytes = sum(dst_after[DST_PREFIX + k] for k in src)
    print(f"\nverified: {len(src)} objects, {archived_bytes:,} bytes "
          f"in s3://{DST_BUCKET}/{DST_PREFIX}")

    if args.delete_source:
        print("\ndeleting originals...")
        for key in sorted(src):
            aws("s3api", "delete-object", "--bucket", SRC_BUCKET, "--key", key, "--output", "json")
            print(f"  deleted {key}")
        print("originals removed; the archive copy is now the only one.")
    else:
        print("originals left in place. Re-run with --delete-source to remove them\n"
              "once you are satisfied the archive is good.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

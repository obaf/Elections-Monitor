# Osun / Presidential Election Monitoring Portal — irev2.com

Citizens photograph polling unit result sheets; the portal reads the figures off
the photo and adds them to a public running total once two independent phones
agree. Deployed to AWS on every push to `main`.

```
Route 53 (A/AAAA alias, apex + www)
      │
CloudFront ──── ACM certificate (us-east-1), TLS 1.2+, HTTP→HTTPS
   │  │  │  │
   │  │  │  └── /osun-archive/* ──► private S3 archive bucket  (finished election)
   │  │  └───── /photos/*       ──► private S3 photo bucket    (cached hard)
   │  └──────── /api/*          ──► HTTP API ──► Lambda ──► DynamoDB
   └─────────── /*              ──► private S3 site bucket     (Origin Access Control)
                                      ├── polling-units.json   (index: 37 states, 774 LGAs, 8,809 wards)
                                      └── pu/<state>.json      (that state's units, on demand)

   NOT behind CloudFront, deliberately:
        private S3 video bucket ──► presigned GET, admin only, 15 minutes
```

GitHub Actions authenticates to AWS with **OIDC short-lived tokens**. No AWS
access keys are stored in GitHub.

---

## Where things stand

| | |
|---|---|
| Live election | **Presidential** — no results yet, uploads **closed** |
| Archived | **Osun** — ACCORD 3,491 · APC 2,046 · ADC 179, across 20 counted units |
| Test mode | off |
| Polling units | 176,595 nationally (37 states, 774 LGAs, 8,809 wards) |
| Photos | 26 live · 26 in the Osun archive |
| Videos | 0 |

Uploads open on **16 Jan 2027**, which is what the front page tells visitors.
Until then the admin switch stays off and the portal is read-only.

---

## Three elections, one table

Osun is finished and archived; presidential is live; **test** is a scratch
election an admin can switch on. All three share one DynamoDB table, separated
by key namespace:

| | Osun (archived) | Presidential (live) | Test (ephemeral) |
|---|---|---|---|
| Totals | `AGG / TOTALS` | `AGG / TOTALS#PRESIDENTIAL` | `AGG / TOTALS#TEST` |
| Counters | `CNT / <pu>` | `CNT#PRESIDENTIAL / <pu>` | `CNT#TEST / <pu>` |
| Photo uploads | `PU#<pu>` | `PU#PRESIDENTIAL#<pu>` | `PU#TEST#<pu>` |
| Recent feed | `UPL` | `UPL#PRESIDENTIAL` | `UPL#TEST` |
| Video feed | `VUPL` | `VUPL#PRESIDENTIAL` | `VUPL#TEST` |
| Audit | `AUDIT` | `AUDIT#PRESIDENTIAL` | `AUDIT#TEST` |
| Photos | `osun-archive/photos/…` at `/osun-archive/*` | `photos/presidential/…` at `/photos/*` | `photos/test/…` |
| Videos | `videos/osun/…` | `videos/presidential/…` | `videos/test/…` |

**Osun deliberately keeps the original, unprefixed keys.** That is the point of
the layout: splitting the elections rewrote no existing item, so there was no
migration step that could drop a result. Only the newer elections are prefixed.
[tools/test_elections.mjs](tools/test_elections.mjs) pins this to the literal key
strings — if a refactor ever gives Osun a prefix, every Osun result disappears
from the site while still sitting in the table, and that test is what catches it.

Approve and revoke are refused on an archived election: a published historical
total is not editable. The Osun archive stays fully viewable at
`/?election=osun` and `/breakdown.html?election=osun`.

---

## How a result becomes a total

1. The phone requests a presigned URL and uploads the photo straight to S3 —
   the bytes never pass through the API.
2. The Lambda reads **EXIF GPS from the photo itself** and checks the
   coordinates fall inside Osun State. A client-supplied coordinate is not
   trusted, since the whole eligibility rule rests on this.
3. Textract reads the sheet; the party figures are parsed out of the lines.
4. When two photos for the same polling unit **agree exactly** and come from
   **two different devices**, both carrying Osun coordinates, the figures are
   added to the totals — once. Anything short of that is accepted and stored,
   but not counted.
5. An admin can override and approve a photo by hand.

### What shows under a photo after approval

OCR is often wrong, so an admin corrects the figures before approving. Once a
unit is counted, the figures under its photo are the ones that were **approved**,
not the ones that were read — captioned as such, with what OCR originally read
kept underneath when the two differ.

They come from the counter item (`CNT.res`), the same row the totals were built
from, rather than being copied onto each upload. One source of truth means the
display cannot drift away from the tally.

---

## Uploads are switched on and off

Between elections the portal stays up and readable but accepts nothing new. The
admin toggles this with **Disable uploads: ON / OFF** (front page top bar, and
the admin console). The label reports the *switch*, not whether uploading
happens to be possible — test mode permits uploads without touching it.

State lives in `AGG / CONFIG`. `/upload-url`, `/upload-done`, `/video-url` and
`/video-done` all refuse while it is off, so closing uploads is enforced at the
API and not only in the page. **Absent config means closed** — a portal that
accepts photos because a settings row has not been written yet is the wrong
failure direction.

The refusal is HTTP **409**, not 403. CloudFront's `custom_error_response` is
distribution-wide and rewrites 403 into the site's HTML error page, so a 403
here reached the browser as "Not Found" markup instead of JSON. Any status the
distribution rewrites is unusable for an API error.

---

## Test mode

Test mode is a **fourth namespace, not a boolean**. While it is on, every
upload, count, total, party, video and audit entry lands under keys carrying
`#TEST` and media under `photos/test/` and `videos/test/`, and `/summary`
reports `test` as the current election so the front page follows it.

Isolation is therefore structural: there is no code path on which a test figure
can reach a real total, because the keys a real total lives under are never
written while test mode is on.

Switching test mode off deletes exactly those partitions and prefixes. Three
independent things stand in front of that delete:

1. `assertTestNamespace()` refuses to run unless the namespace is the test one,
   checked by shape rather than by name.
2. Every key is re-checked for a `TEST` marker immediately before the batch
   delete.
3. IAM grants the Lambda `s3:DeleteObject` on `photos/test/*` and
   `videos/test/*` only, so a bug in the code still cannot reach real media.

Test mode also opens uploads on its own — exercising the upload path while no
election is running is the entire point of it. The `test-mode-on` / `-off` audit
entries are written to the **real** election's audit trail, so the record that
test mode was used survives the wipe.

[tools/test_test_mode.mjs](tools/test_test_mode.mjs) covers the boundary: that
the namespaces cannot collide, and that the guard rejects a real namespace and
an impostor.

---

## Video

Every polling unit takes an **Upload video** as well as a photo. Video is
evidence rather than content: **anyone may add one, only an admin may watch
one.** An ordinary visitor is told how many exist and nothing else.

That rule is enforced structurally. Videos live in
`irev2-com-videos-<account>`, which is **not a CloudFront origin at all** — no
cache behaviour routes to it and no bucket policy grants CloudFront read, so
there is no public path to an object in it. The only way to play one is a
presigned GET the API issues after checking an admin token, valid 15 minutes.
There is no serving path to misconfigure.

| Route | Who | Returns |
|---|---|---|
| `POST /video-url` | anyone | presigned PUT; bytes go straight to S3 |
| `POST /video-done` | anyone | records it; size read back from S3, oversized deleted |
| `POST /video-email` | the uploader | links an email to that clip |
| `GET /pu` | anyone | **a count only** — no key, no id, no email, no link |
| `GET /admin/videos` | admin | the recordings, the emails, playable links |

The email is asked for **after** the upload completes, so nobody is pressed for
an address in order to finish sending evidence. It is stored on the clip and
returned by no public route.

Uploads are capped at 200 MB. A presigned PUT cannot carry a size limit, so
`/video-done` reads the size back with a HEAD and deletes anything over the cap
rather than leaving it to be paid for.

### Video storage and what it costs

Real footage goes to **Glacier Instant Retrieval immediately** and sinks to
**Deep Archive at 90 days**. Glacier IR plays instantly, so the video is
readable for exactly as long as anyone is likely to ask for it — election
disputes happen in the weeks after a vote — and then costs 4x less again, at the
price of a 12-hour restore. 90 days is also exactly Glacier IR's minimum billing
duration, so nothing is billed for storage it did not use.

For 500,000 clips averaging 50 MB (≈24 TB):

| | |
|---|---|
| Data in | **$0** — AWS does not charge for inbound transfer |
| Ingest requests (one-off) | ~$11 |
| Transitions + first day in Standard (one-off) | ~$54 |
| Months 1–3 | **$98/month** (Glacier IR, instantly playable) |
| Month 4 onward | **$24/month** (Deep Archive, 12-hour restore) |
| Year one / year two+ | **≈$510** / **$290** |

Getting the footage back out is the expensive part, and it is separate: ~$488 in
restore fees plus ~$2,197 in egress for the full 24 TB — the egress is **$0** if
restored to an EC2 instance in `us-east-1` rather than pulled to a laptop. And
24 TB in 24 hours needs 2.3 Gbps sustained, so bulk export means Snowball or an
in-region instance, whatever the storage class.

**Test footage is deliberately excluded from those rules.** A test clip exists
for minutes before the wipe deletes it, while Glacier IR bills a 90-day minimum
per object and Deep Archive a 180-day one — so archiving a five-minute clip
would bill months for it. Test video stays in Standard, where deleting it costs
nothing, with a one-day expiry as a backstop for anything the wipe misses.

> **Footgun.** S3 lifecycle filters cannot express "everything except", so the
> rules **name** the real elections rather than excluding the test one. A **new
> election must be added to `archived_video_prefixes` in `infra/app.tf`** or its
> footage will sit in Standard at six times the cost, silently and indefinitely.
> [tools/test_video.mjs](tools/test_video.mjs) asserts that list against the
> elections in `api/util.mjs` in both directions.

---

## The polling unit list

The portal covers **all 176,595 polling units in Nigeria** — 37 states, 774
LGAs, 8,809 wards — built by [tools/build_national_pu.py](tools/build_national_pu.py)
from the INEC dataset at
[sadiqsalau/inec-ng-data](https://github.com/sadiqsalau/inec-ng-data). That was
the only source found carrying the **numeric INEC codes**; alternatives had only
slugified names, which is useless when the whole portal is keyed on codes.

It produces `presidential-polling-units.csv` and `.xlsx` (both gitignored, like
the Osun originals) and the two things the site serves:

| File | What | Size |
|---|---|---|
| `site/polling-units.json` | states + LGAs + wards — the index | 320 KB, **80 KB gzipped** |
| `site/pu/<state>.json` | one state's units, fetched on demand | 84–610 KB, 21–148 KB gzipped |

**Why it is split.** All 176,595 units in one file is 1.8 MB over the wire even
gzipped — a quarter-minute of waiting on the mobile connections this portal is
actually used on. The split works because a PU code *begins with its state*
(`29-30-04-003` is Osun), so the first thing a searcher types already says which
file to fetch. A typical visit downloads the index plus one state, about
**119 KB**, which keeps the front page inside the cost shape the whole design
rests on. [site/pu-data.js](site/pu-data.js) is the shared loader.

The PU code is not stored per unit: it is rebuilt in the browser from the ward's
prefix plus the unit's serial, which would otherwise add ~2 MB of information
already implied by the ward.

**The front page opens on five real polling units** (`01-01-01-005` to `-009`,
listed as `FEATURED` in the build script). They are carried inside the index, in
the same shape a state file uses, so showing them costs **no extra request and
197 bytes** — as against pulling a 100–600 KB state file to display five rows.

**The build refuses to run if Osun does not reproduce.** The PU code keys every
upload, counter and total, so the script rebuilds Osun's codes from the national
source and checks them against the 3,763 rows already in use. All 3,763 match
exactly, which is what makes the national list safe to swap in: existing Osun
uploads still resolve to the same units.

Two known gaps: the source has 176,595 units where INEC's commonly cited figure
is 176,846, and PU *names* differ from the Osun file on ~3% of units
(transcription variants like "UNITY" vs "UNITED PRY. SCHOOL"). Codes are
identical, which is what matters for filing.

Regenerate with:

```bash
python tools/build_national_pu.py inec-source-data.json
```

`inec-source-data.json` is the raw INEC dataset (35 MB), kept in the repo root
and gitignored so the build can be re-run without re-downloading. If it is ever
lost:

```bash
curl -sL -o inec-source-data.json   https://raw.githubusercontent.com/sadiqsalau/inec-ng-data/main/inecdata.json
```

---

## Approving results

**From the front page.** An admin sees *"Click to approve uploaded results:
N uploads"* under the totals. `N` counts **polling units that have photos, not
photos** — twenty photos of one unit is one decision, and the number an admin
needs is how many decisions are waiting. It is read off the summary the page
already holds, so it costs no extra request.

It links to [site/approve.html](site/approve.html), which lists only the polling
units with uploads, units awaiting a decision first, each opening to its photos
with the OCR figures editable before approving. The page reads the live election
from `/summary`, so it works in test mode with no switch of its own.

**From the admin console.** [site/admin.html](site/admin.html) has an **Approve
upload** tab listing every upload newest-first, plus the uploads and test-mode
switches.

---

## Cost shape

Uploads and viewing are the volume, so both avoid per-request compute: the
polling unit index is one edge-cached static JSON, photos are immutable and
cache hard at CloudFront, and the photo bucket moves objects to STANDARD_IA
after 30 days. DynamoDB is on-demand and Lambda scales to zero, so an idle
portal costs essentially nothing. Textract runs exactly once per photo.

`/summary` deliberately returns **all** elections in one response: splitting it
per election would double the Lambda invocations on the request every visitor
makes.

Measure any change against *"what happens when 100,000 people load the front
page at once"*.

---

## Layout

| Path | Purpose |
|---|---|
| [site/](site/) | Front page, admin console, approve page, breakdown, archive — static, no build step |
| [api/](api/) | The API Lambda. Dependency-free: SigV4 is signed by hand so CI needs no `npm install` |
| [infra/](infra/) | S3 + CloudFront + ACM + Route 53 + DynamoDB + Lambda — applied by CI |
| [bootstrap/](bootstrap/) | One-time setup: state bucket, OIDC provider, deploy role |
| [tools/](tools/) | Polling unit build, Osun photo archiver, sample sheets, the test suite |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | The pipeline |

### API routes

```
public   /summary  /breakdown  /parties  /pu  /messages
         /upload-url  /upload-done  /video-url  /video-done  /video-email
admin    /admin/login  /admin/uploads-enabled  /admin/test-mode
         /admin/pending  /admin/approve  /admin/revoke  /admin/audit
         /admin/recent  /admin/upload-counts  /admin/videos
         /admin/recent-videos  /admin/threads  /admin/reply
```

Everything under `/admin/` sits behind one token check. Adding a route above
that gate makes it public — the video tests assert the ordering.

---

## Admin

`https://irev2.com/admin.html`. Credentials are generated once and written to
`admin user and pwd.txt` (gitignored); only a salted SHA-256 hash is stored, in
SSM Parameter Store at `/irev2/admin`, which the Lambda reads at runtime. The
password is not in the repo or in Terraform state.

---

## AWS resources

Everything below lives in account `768332541841`, region `us-east-1`. Names embed
the account ID because S3 bucket names are globally unique.

### Provisioned by `infra/` (applied by CI)

| Service | Resource | Name / identifier | Purpose |
|---|---|---|---|
| S3 | Bucket | `irev2-com-site-<account>` | Static site origin. Private; reachable only via CloudFront |
| S3 | Bucket | `irev2-com-photos-<account>` | Result photos. Private, CORS for presigned `PUT`, STANDARD_IA at 30 days |
| S3 | Bucket | `irev2-com-osun-archive-<account>` | Finished Osun election's photos. Versioned, served at `/osun-archive/*` |
| S3 | Bucket | `irev2-com-videos-<account>` | Evidence video. **No CloudFront origin.** Glacier IR → Deep Archive at 90 days |
| S3 | Objects | 50 files under `site/` | 13 pages/assets plus `pu/<state>.json` × 37 |
| CloudFront | Distribution | `E2XHM5IYC6KS4P` | `/*` site, `/photos/*`, `/osun-archive/*`, `/api/*` |
| CloudFront | Origin Access Control | `irev2-com-oac` | SigV4 signing so the buckets stay private |
| CloudFront | Managed policies (read-only) | `CachingOptimized`, `CachingDisabled`, `SecurityHeadersPolicy`, `AllViewerExceptHostHeader` | Referenced, not created |
| ACM | Certificate | `irev2.com` + `www.irev2.com` | TLS for CloudFront; must be in us-east-1 |
| Route 53 | A + AAAA alias records | apex and `www` | Point at the distribution |
| API Gateway v2 | HTTP API + integration, route, stage | `irev2-com-api` | `$default` route proxying to the Lambda |
| Lambda | Function | `irev2-com-api` | Node.js 22, 512 MB, 30 s |
| DynamoDB | Table | `irev2-com-app` | Single table, on-demand, PITR on |
| IAM | Role + inline policy | `irev2-com-api` | Lambda execution role |
| CloudWatch Logs | Log group | `/aws/lambda/irev2-com-api` | 14-day retention |

Lambda environment: `TABLE`, `PHOTO_BUCKET`, `ARCHIVE_BUCKET`, `VIDEO_BUCKET`,
`ADMIN_PARAM`.

### Provisioned by `bootstrap/` (run once, locally)

| Service | Resource | Purpose |
|---|---|---|
| S3 | `irev2-com-tfstate-<account>` | Terraform state for `infra/`. Versioned, encrypted, TLS-only, `prevent_destroy` |
| IAM | OIDC provider `token.actions.githubusercontent.com` | Lets GitHub Actions federate in |
| IAM | Role `irev2-com-github-actions-deploy` | Assumed by CI via short-lived OIDC tokens; scoped to this repo |

**`bootstrap/` must be applied locally before CI can create a new bucket.** Its
IAM policy lists bucket ARNs explicitly, so adding a bucket to `infra/` without
adding it to `bootstrap/` fails the deploy with AccessDenied.

### Used at runtime, not provisioned

| Service | Notes |
|---|---|
| Textract | `DetectDocumentText`, once per uploaded photo. Pay-per-page |
| STS | `AssumeRoleWithWebIdentity` for the CI OIDC exchange |
| S3 native locking | The state bucket's `.tflock` object, via `use_lockfile` — no DynamoDB lock table |

### Outside Terraform

| Service | Resource | Why |
|---|---|---|
| SSM Parameter Store | `/irev2/admin` (SecureString) | Admin username + salted hash. Created out of band so the secret never enters Terraform state or the repo |
| Route 53 | Hosted zone `Z095210523VY9LMIVMLF1`, domain `irev2.com` | Pre-existing; read via a data source |

---

## One-time setup

Run once, locally, with administrator AWS credentials.

```bash
aws configure                 # admin access key, region us-east-1
cd bootstrap
terraform init
terraform apply
```

Then publish the two outputs as repository variables:

```bash
gh variable set AWS_ROLE_ARN    --body "$(terraform -chdir=bootstrap output -raw github_actions_role_arn)"
gh variable set TF_STATE_BUCKET --body "$(terraform -chdir=bootstrap output -raw state_bucket)"
```

You can delete the admin access key afterwards — CI does not use it.

## Day-to-day

Edit, commit, push to `main`. The workflow plans, applies, and invalidates the
CloudFront cache. Pull requests get a plan posted as a comment and apply nothing.

The workflow only runs on changes under `infra/`, `site/`, `api/`, or the
workflow file — a README-only commit deploys nothing.

---

## Tests

```bash
for f in tools/test_*.mjs; do node "$f"; done
```

| Test | Covers |
|---|---|
| `test_elections.mjs` | The key namespaces, and that Osun keeps its original keys |
| `test_test_mode.mjs` | Test isolation and the wipe guard |
| `test_video.mjs` | The video access boundary, presigning, and the lifecycle rules |
| `test_totals_render.mjs` | The front page against a stub DOM: totals rows, approve line, featured units |
| `test_table_render.mjs` | The breakdown table |
| `test_collect_figures.mjs` | Figure validation |
| `test_discovery.mjs` | Party discovery from OCR |

> `tools/test_browser_e2e.mjs` is **destructive and runs against the deployed
> site** — it uploads a photo, approves it, and permanently changes the public
> totals. It refuses to start without `IREV2_E2E_WRITE_TO_LIVE=1`, because being
> named `test_*` should not imply permission to rewrite a published election
> tally. It once did exactly that, and the totals had to be restored from a
> DynamoDB scan.

**Back up before touching live data:**

```bash
aws dynamodb scan --table-name irev2-com-app --output json > backup.json
```

---

## Archiving the Osun photos

`python tools/archive_osun_photos.py` copies every Osun result sheet into
`irev2-com-osun-archive-<account>` under an `osun-archive/` prefix that matches
its public URL exactly, so CloudFront needs no path-rewriting function at the
edge. The copy is verified object-by-object on byte count.

Nothing is deleted. An election archive is evidence, so the destructive half is
a separate, explicit decision (`--delete-source`) to be taken by a human once
the copy has been confirmed good. **The originals are still in the photo
bucket** — 26 objects in each.

---

## Gotchas worth knowing

- **GitHub's OIDC subject claim is the immutable form** (`repo:obaf@26940333/...`),
  not the documented one. The trust policy matches both.
- **CloudFront rewrites 403 site-wide** into `/error.html`. Never return 403
  from the API; use 409 or 422.
- **Textract returns each table cell as its own LINE block**, so the parser
  matches columns by geometry, not by reading a label and value off one line.
- `bootstrap/` keeps **local** state and is gitignored — back it up privately.
- `create_oidc_provider = false` in `bootstrap/` if the provider already exists
  (AWS permits only one per URL).
- The first apply takes ~5 minutes: ACM validation and CloudFront rollout
  dominate.

---

## If you are picking this up next

Likely next steps, in rough order of value:

1. **Open uploads** when the election starts — admin console, *Disable uploads:
   OFF*. Everything else is already in place.
2. **Public video playback**, if wanted. Costed but not built: transcode to 480p
   (~$7,500 one-off for 500k clips) and serve renditions from a zero-egress
   provider such as Cloudflare R2. Serving 50 MB originals from CloudFront would
   be ~$5,371 per million views; 4 MB renditions on R2 is ~$0. Two non-technical
   questions first: whether public playback conflicts with the evidential
   position the site takes, and consent for people visible in the footage.
3. **A 720p recording hint** on the upload dialog. Average clip size moves the
   video bill more than any storage-class choice.
4. **Bump the deprecated actions** — `actions/checkout@v4`,
   `configure-aws-credentials@v4`, `setup-terraform@v3` are being force-run on
   Node 24.
5. **Reconcile the 176,595 vs 176,846 polling unit gap** against an official
   INEC list before the election.

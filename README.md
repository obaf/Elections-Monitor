# Osun Election Monitoring Portal — irev2.com

Citizens photograph polling unit result sheets; the portal reads the figures off
the photo and adds them to a public running total once two independent phones
agree. Deployed to AWS on every push to `main`.

```
Route 53 (A/AAAA alias, apex + www)
      │
CloudFront ──── ACM certificate (us-east-1), TLS 1.2+, HTTP→HTTPS
   │    │    │
   │    │    └── /photos/*  ──► private S3 photo bucket   (cached hard)
   │    └─────── /api/*     ──► HTTP API ──► Lambda ──► DynamoDB
   └──────────── /*         ──► private S3 site bucket   (Origin Access Control)
                                  └── polling-units.json (all 3,763 units)
```

GitHub Actions authenticates to AWS with **OIDC short-lived tokens**. No AWS
access keys are stored in GitHub.

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
5. The admin can override and approve a photo by hand.

## Cost shape

Uploads and viewing are the volume, so both avoid per-request compute:
the polling unit list is one edge-cached static JSON, photos are immutable and
cache hard at CloudFront, and the photo bucket moves objects to STANDARD_IA
after 30 days. DynamoDB is on-demand and Lambda scales to zero, so an idle
portal costs essentially nothing. Textract runs exactly once per photo.

## Layout

| Path | Purpose |
|---|---|
| [site/](site/) | Front page, admin console, message thread — static, no build step |
| [api/](api/) | The API Lambda. Dependency-free: SigV4 is signed by hand so CI needs no `npm install` |
| [infra/](infra/) | S3 + CloudFront + ACM + Route 53 + DynamoDB + Lambda — applied by CI |
| [bootstrap/](bootstrap/) | One-time setup: state bucket, OIDC provider, deploy role |
| [tools/](tools/) | Generates and uploads geotagged sample result sheets |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | The pipeline |

## Admin

`https://irev2.com/admin.html`. Credentials are generated once and written to
`admin user and pwd.txt` (gitignored); only a salted SHA-256 hash is stored, in
SSM Parameter Store at `/irev2/admin`, which the Lambda reads at runtime. The
password is not in the repo or in Terraform state.

## Regenerating the polling unit list

`site/polling-units.json` is derived from `osun-polling-units.csv` (gitignored).
Ward and LGA names are de-duplicated into index arrays to keep the payload at
194 KB, roughly 35 KB over the wire.

## One-time setup

Run once, locally, with administrator AWS credentials.

```bash
aws configure                 # admin access key, region us-east-1
cd bootstrap
terraform init
terraform apply
```

This creates the Terraform state bucket, the GitHub OIDC provider, and an IAM
role that **only this repository** can assume. Then publish the two outputs as
repository variables:

```bash
gh variable set AWS_ROLE_ARN    --body "$(terraform -chdir=bootstrap output -raw github_actions_role_arn)"
gh variable set TF_STATE_BUCKET --body "$(terraform -chdir=bootstrap output -raw state_bucket)"
```

You can delete the admin access key afterwards — CI does not use it.

## Day-to-day

Edit [site/index.html](site/index.html), commit, push to `main`. The workflow
plans, applies, and invalidates the CloudFront cache. Pull requests get a plan
posted as a comment and apply nothing.

## Notes

- `bootstrap/` keeps **local** state (it creates the remote backend, so it
  cannot use it). `bootstrap/terraform.tfstate` is gitignored — back it up
  somewhere private if you intend to change the bootstrap later.
- `infra/` uses an S3 backend with native S3 locking (`use_lockfile`), so no
  DynamoDB table is required.
- The state bucket name embeds the AWS account ID and is therefore passed at
  init time rather than committed to this public repo.
- The first apply takes ~5 minutes: ACM DNS validation and the initial
  CloudFront distribution rollout dominate.
- `create_oidc_provider = false` in `bootstrap/` if
  `token.actions.githubusercontent.com` already exists in the account (AWS
  permits only one provider per URL).

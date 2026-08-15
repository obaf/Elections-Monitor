# Elections Monitor — irev2.com

Terraform-managed "Under construction" static site for **irev2.com**, deployed
automatically to AWS on every push to `main`.

```
Route 53 (A/AAAA alias, apex + www)
      │
CloudFront ──── ACM certificate (us-east-1), TLS 1.2+, HTTP→HTTPS
      │  Origin Access Control (SigV4)
      ▼
Private S3 bucket (no public access)
```

GitHub Actions authenticates to AWS with **OIDC short-lived tokens**. No AWS
access keys are stored in GitHub.

## Layout

| Path | Purpose |
|---|---|
| [site/](site/) | The static content that gets published |
| [infra/](infra/) | S3 + CloudFront + ACM + Route 53 — applied by CI |
| [bootstrap/](bootstrap/) | One-time setup: state bucket, OIDC provider, deploy role |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | The pipeline |

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

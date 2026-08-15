###############################################################################
# BOOTSTRAP -- run ONCE, locally, with administrator credentials.
#
# Creates the three things that must exist before GitHub Actions can deploy
# anything on its own:
#
#   1. An S3 bucket to hold the Terraform state for infra/ (with native
#      S3 state locking -- no DynamoDB table required).
#   2. The GitHub Actions OIDC identity provider in this AWS account.
#   3. An IAM role that ONLY this repository can assume, via short-lived
#      OIDC tokens. No long-lived AWS access keys are ever stored in GitHub.
#
# This directory uses LOCAL state on purpose (it creates the remote backend,
# so it cannot use it). bootstrap/terraform.tfstate is gitignored.
###############################################################################

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.tags
  }
}

data "aws_caller_identity" "current" {}

# Fails fast with a clear error if the hosted zone does not exist.
data "aws_route53_zone" "primary" {
  name         = "${var.domain_name}."
  private_zone = false
}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Bucket names are globally unique and cannot contain dots (dots break
  # virtual-hosted-style TLS), so the domain is slugified.
  domain_slug = replace(var.domain_name, ".", "-")

  state_bucket = "${local.domain_slug}-tfstate-${local.account_id}"
  site_bucket  = "${local.domain_slug}-site-${local.account_id}"

  github_sub_prefix = "repo:${var.github_owner}/${var.github_repo}"
}

###############################################################################
# 1. Terraform state bucket
###############################################################################

resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket

  # State is not disposable -- refuse to destroy it by accident.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# State files can contain sensitive values -- require TLS in transit.
resource "aws_s3_bucket_policy" "tfstate_tls_only" {
  bucket = aws_s3_bucket.tfstate.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.tfstate.arn,
        "${aws_s3_bucket.tfstate.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.tfstate]
}

###############################################################################
# 2. GitHub Actions OIDC provider
###############################################################################

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

###############################################################################
# 3. Deploy role assumable only by this repository
###############################################################################

data "aws_iam_policy_document" "github_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only the main branch and pull requests of THIS repo. A fork, another
    # repo, or an arbitrary branch cannot assume this role.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "${local.github_sub_prefix}:ref:refs/heads/main",
        "${local.github_sub_prefix}:pull_request",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "${local.domain_slug}-github-actions-deploy"
  description        = "Assumed by GitHub Actions (${var.github_owner}/${var.github_repo}) to deploy the ${var.domain_name} static site."
  assume_role_policy = data.aws_iam_policy_document.github_assume_role.json

  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  # --- Terraform remote state -------------------------------------------
  statement {
    sid       = "TerraformStateBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketVersioning"]
    resources = [aws_s3_bucket.tfstate.arn]
  }

  statement {
    sid    = "TerraformStateObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.tfstate.arn}/*"]
  }

  # --- The website bucket ------------------------------------------------
  statement {
    sid    = "SiteBucket"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:ListBucket",
      "s3:GetBucket*",
      "s3:PutBucket*",
      "s3:DeleteBucketPolicy",
      "s3:GetEncryptionConfiguration",
      "s3:PutEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:GetAccelerateConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:GetObject*",
      "s3:PutObject*",
      "s3:DeleteObject*",
      "s3:ListBucketVersions",
    ]
    resources = [
      "arn:aws:s3:::${local.site_bucket}",
      "arn:aws:s3:::${local.site_bucket}/*",
    ]
  }

  # --- CloudFront ---------------------------------------------------------
  # CloudFront is a global service; most of its actions do not support
  # resource-level permissions, so they must be granted on "*".
  statement {
    sid    = "CloudFront"
    effect = "Allow"
    actions = [
      "cloudfront:CreateDistribution",
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:UpdateDistribution",
      "cloudfront:DeleteDistribution",
      "cloudfront:ListDistributions",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
      "cloudfront:ListTagsForResource",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:GetOriginAccessControl",
      "cloudfront:GetOriginAccessControlConfig",
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:DeleteOriginAccessControl",
      "cloudfront:ListOriginAccessControls",
      "cloudfront:GetCachePolicy",
      "cloudfront:ListCachePolicies",
      "cloudfront:GetResponseHeadersPolicy",
      "cloudfront:ListResponseHeadersPolicies",
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
      "cloudfront:ListInvalidations",
    ]
    resources = ["*"]
  }

  # --- ACM (certificate lives in us-east-1 for CloudFront) ---------------
  statement {
    sid    = "AcmCertificates"
    effect = "Allow"
    actions = [
      "acm:RequestCertificate",
      "acm:DescribeCertificate",
      "acm:DeleteCertificate",
      "acm:ListCertificates",
      "acm:AddTagsToCertificate",
      "acm:RemoveTagsFromCertificate",
      "acm:ListTagsForCertificate",
    ]
    resources = ["*"]
  }

  # --- Route 53 -----------------------------------------------------------
  statement {
    sid    = "Route53Read"
    effect = "Allow"
    actions = [
      "route53:ListHostedZones",
      "route53:ListHostedZonesByName",
      "route53:GetHostedZone",
      "route53:ListResourceRecordSets",
      "route53:GetChange",
    ]
    resources = ["*"]
  }

  # Record changes are scoped to this domain's zone only.
  statement {
    sid       = "Route53WriteThisZoneOnly"
    effect    = "Allow"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${data.aws_route53_zone.primary.zone_id}"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${local.domain_slug}-deploy"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.deploy.json
}

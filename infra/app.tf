###############################################################################
# Application backend: photo storage, OCR, results and admin messaging.
#
# Everything here is serverless and scales to zero. The polling unit list is a
# static JSON on CloudFront rather than an API, because that is the one request
# every visitor makes -- keeping it at the edge is what keeps the bill flat when
# a lot of people are looking at the portal at once.
###############################################################################

locals {
  photo_bucket   = "${local.domain_slug}-photos-${data.aws_caller_identity.current.account_id}"
  archive_bucket = "${local.domain_slug}-osun-archive-${data.aws_caller_identity.current.account_id}"
  api_name       = "${local.domain_slug}-api"
}

###############################################################################
# Photo storage -- private, served only through CloudFront
###############################################################################

resource "aws_s3_bucket" "photos" {
  bucket = local.photo_bucket
}

resource "aws_s3_bucket_public_access_block" "photos" {
  bucket                  = aws_s3_bucket.photos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = true
  }
}

# Uploads are written straight from the phone with a presigned PUT, so the
# browser origin needs to be allowed to talk to S3 directly.
resource "aws_s3_bucket_cors_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = [for d in local.all_domains : "https://${d}"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# Result photos are evidence, not hot data: after a month the traffic on any
# given photo is effectively zero, so move it to a cheaper class.
resource "aws_s3_bucket_lifecycle_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  rule {
    id     = "cheapen-old-photos"
    status = "Enabled"
    filter {}

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }
}

resource "aws_s3_bucket_policy" "photos" {
  bucket = aws_s3_bucket.photos.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.photos.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.photos]
}

###############################################################################
# Osun archive -- the finished election's photos, kept separate from the live one
#
# The Osun election is over. Its result sheets are evidence and stay publicly
# viewable, but they are no longer part of the election being monitored, so
# they live in their own bucket behind their own CloudFront path. Objects are
# copied in under an "osun-archive/" prefix that matches the URL exactly, so
# the archive needs no path rewriting at the edge.
#
# Versioning is on here and not on the live photo bucket: this is the copy that
# has to survive a mistake, and there is a fixed, small number of objects in it.
###############################################################################

resource "aws_s3_bucket" "osun_archive" {
  bucket = local.archive_bucket
}

resource "aws_s3_bucket_public_access_block" "osun_archive" {
  bucket                  = aws_s3_bucket.osun_archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "osun_archive" {
  bucket = aws_s3_bucket.osun_archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "osun_archive" {
  bucket = aws_s3_bucket.osun_archive.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = true
  }
}

# An archive is cold by definition, so move it down a class quickly. The photos
# stay immediately readable -- STANDARD_IA is a price change, not a retrieval
# delay like Glacier would be.
resource "aws_s3_bucket_lifecycle_configuration" "osun_archive" {
  bucket = aws_s3_bucket.osun_archive.id

  rule {
    id     = "archive-is-cold"
    status = "Enabled"
    filter {}

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }
}

resource "aws_s3_bucket_policy" "osun_archive" {
  bucket = aws_s3_bucket.osun_archive.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.osun_archive.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.osun_archive]
}

###############################################################################
# Data
###############################################################################

resource "aws_dynamodb_table" "app" {
  name         = "${local.domain_slug}-app"
  billing_mode = "PAY_PER_REQUEST" # uploads are bursty and mostly idle
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

###############################################################################
# API Lambda
###############################################################################

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../api"
  output_path = "${path.module}/.build/api.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.domain_slug}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }

  statement {
    sid    = "Table"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [aws_dynamodb_table.app.arn]
  }

  statement {
    sid       = "Photos"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.photos.arn}/*"]
  }

  # Textract reads the object itself, so it needs the bucket listed too.
  statement {
    sid       = "PhotosList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.photos.arn]
  }

  statement {
    sid       = "Ocr"
    effect    = "Allow"
    actions   = ["textract:DetectDocumentText"]
    resources = ["*"]
  }

  # Admin credentials live in SSM so the password hash is never in the repo
  # or in Terraform state.
  statement {
    sid       = "AdminSecret"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/irev2/admin"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "${local.domain_slug}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.domain_slug}-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.domain_slug}-api"
  role             = aws_iam_role.api.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 30 # Textract on a large photo is the slow part
  memory_size      = 512

  environment {
    variables = {
      TABLE          = aws_dynamodb_table.app.name
      PHOTO_BUCKET   = aws_s3_bucket.photos.id
      ARCHIVE_BUCKET = aws_s3_bucket.osun_archive.id
      ADMIN_PARAM    = "/irev2/admin"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

resource "aws_apigatewayv2_api" "api" {
  name          = local.api_name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

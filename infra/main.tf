###############################################################################
# irev2.com -- "Under construction" static site.
#
#   Route 53 (A/AAAA alias)
#        |
#   CloudFront  <-- ACM cert (us-east-1), TLS 1.2+, HTTP -> HTTPS redirect
#        |  Origin Access Control (SigV4)
#        v
#   Private S3 bucket -- no public access, reachable only via CloudFront.
###############################################################################

data "aws_caller_identity" "current" {}

data "aws_route53_zone" "primary" {
  name         = "${var.domain_name}."
  private_zone = false
}

locals {
  domain_slug = replace(var.domain_name, ".", "-")
  bucket_name = "${local.domain_slug}-site-${data.aws_caller_identity.current.account_id}"

  all_domains = concat([var.domain_name], var.subject_alternative_names)

  # Content served from the repository's site/ directory.
  site_root = "${path.module}/../site"

  mime_types = {
    ".html"  = "text/html; charset=utf-8"
    ".css"   = "text/css; charset=utf-8"
    ".js"    = "application/javascript; charset=utf-8"
    ".json"  = "application/json"
    ".svg"   = "image/svg+xml"
    ".png"   = "image/png"
    ".jpg"   = "image/jpeg"
    ".ico"   = "image/x-icon"
    ".txt"   = "text/plain; charset=utf-8"
    ".webp"  = "image/webp"
    ".woff2" = "font/woff2"
  }

  site_files = fileset(local.site_root, "**/*")
}

###############################################################################
# Origin bucket -- private
###############################################################################

resource "aws_s3_bucket" "site" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Upload every file under site/. etag tracks content so an edited page is
# re-uploaded on the next apply.
resource "aws_s3_object" "site" {
  for_each = local.site_files

  bucket = aws_s3_bucket.site.id
  key    = each.value
  source = "${local.site_root}/${each.value}"
  etag   = filemd5("${local.site_root}/${each.value}")
  # try() keeps extensionless files from failing the regex outright.
  content_type = lookup(local.mime_types, try(regex("\\.[^.]+$", each.value), ""), "application/octet-stream")

  # Short TTL at the browser; CloudFront is invalidated on every deploy.
  cache_control = "public, max-age=300, must-revalidate"
}

###############################################################################
# TLS certificate -- must be in us-east-1 for CloudFront
###############################################################################

resource "aws_acm_certificate" "site" {
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = var.subject_alternative_names
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.site.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = data.aws_route53_zone.primary.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]

  timeouts {
    create = "15m"
  }
}

###############################################################################
# CloudFront
###############################################################################

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.domain_slug}-oac"
  description                       = "SigV4 access from CloudFront to the ${var.domain_name} origin bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.domain_name} static site"
  default_root_object = "index.html"
  aliases             = local.all_domains
  price_class         = var.price_class

  origin {
    origin_id                = "s3-${aws_s3_bucket.site.id}"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id                = "s3-photos"
    domain_name              = aws_s3_bucket.photos.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id                = "s3-osun-archive"
    domain_name              = aws_s3_bucket.osun_archive.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # Serving the API through the same distribution keeps everything same-origin,
  # so the browser never needs a CORS preflight on an API call.
  origin {
    origin_id   = "api"
    domain_name = replace(aws_apigatewayv2_api.api.api_endpoint, "https://", "")

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-${aws_s3_bucket.site.id}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "api"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  # Photos are immutable once written, so they can cache hard at the edge --
  # this is what keeps repeated viewing off S3 and cheap.
  ordered_cache_behavior {
    path_pattern           = "/photos/*"
    target_origin_id       = "s3-photos"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false

    cache_policy_id = data.aws_cloudfront_cache_policy.optimized.id
  }

  # The Osun archive. Finished results never change, so this is the most
  # cacheable content on the site -- serve it from the edge and leave the
  # archive bucket effectively untouched.
  ordered_cache_behavior {
    path_pattern           = "/osun-archive/*"
    target_origin_id       = "s3-osun-archive"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false

    cache_policy_id = data.aws_cloudfront_cache_policy.optimized.id
  }

  # S3 with Origin Access Control answers a missing object with 403, not 404,
  # so this one mapping covers every missing page.
  #
  # There is deliberately NO mapping for 404: custom_error_response is
  # distribution-wide, so it would also rewrite the API's own 404 responses
  # into this HTML page. That silently replaced JSON errors like
  # {"error":"upload not found"} with a Not Found page, leaving the admin UI
  # unable to say why an approve had failed.
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/error.html"
    error_caching_min_ttl = 60
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# Let CloudFront -- and only this distribution -- read the bucket.
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipalReadOnly"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
        }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.site]
}

###############################################################################
# DNS -- apex and every SAN point at the distribution
###############################################################################

resource "aws_route53_record" "ipv4" {
  for_each = toset(local.all_domains)

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "ipv6" {
  for_each = toset(local.all_domains)

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

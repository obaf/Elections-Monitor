output "site_url" {
  description = "Primary HTTPS URL of the site."
  value       = "https://${var.domain_name}"
}

output "all_urls" {
  description = "Every hostname the distribution answers on."
  value       = [for d in local.all_domains : "https://${d}"]
}

output "bucket_name" {
  description = "Private S3 origin bucket."
  value       = aws_s3_bucket.site.id
}

output "cloudfront_distribution_id" {
  description = "Distribution ID -- used by the workflow to invalidate the cache after deploy."
  value       = aws_cloudfront_distribution.site.id
}

output "cloudfront_domain_name" {
  description = "CloudFront-assigned hostname (useful for testing before DNS propagates)."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "certificate_arn" {
  description = "Validated ACM certificate serving the site."
  value       = aws_acm_certificate_validation.site.certificate_arn
}

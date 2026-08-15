output "state_bucket" {
  description = "S3 bucket holding the Terraform state for infra/. Set as the TF_STATE_BUCKET repo variable."
  value       = aws_s3_bucket.tfstate.id
}

output "site_bucket" {
  description = "Name the infra/ configuration will use for the website bucket."
  value       = local.site_bucket
}

output "github_actions_role_arn" {
  description = "IAM role GitHub Actions assumes. Set as the AWS_ROLE_ARN repo variable."
  value       = aws_iam_role.github_actions.arn
}

output "hosted_zone_id" {
  description = "Route 53 hosted zone the site records are written into."
  value       = data.aws_route53_zone.primary.zone_id
}

output "account_id" {
  description = "AWS account these resources were created in."
  value       = data.aws_caller_identity.current.account_id
}

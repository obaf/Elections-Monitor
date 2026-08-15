variable "aws_region" {
  description = "Region for the Terraform state bucket."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Apex domain with an existing Route 53 public hosted zone."
  type        = string
  default     = "irev2.com"
}

variable "github_owner" {
  description = "GitHub user or organisation that owns the repository."
  type        = string
  default     = "obaf"
}

variable "github_repo" {
  description = "Repository name that is allowed to assume the deploy role."
  type        = string
  default     = "Elections-Monitor"
}

variable "github_owner_id" {
  description = <<-EOT
    Numeric GitHub account ID of github_owner, used in the immutable OIDC
    subject claim. Find it with: gh api users/<owner> --jq .id
  EOT
  type        = string
  default     = "26940333"
}

variable "github_repo_id" {
  description = <<-EOT
    Numeric GitHub repository ID, used in the immutable OIDC subject claim.
    Find it with: gh api repos/<owner>/<repo> --jq .id
  EOT
  type        = string
  default     = "1334822172"
}

variable "create_oidc_provider" {
  description = <<-EOT
    Create the GitHub Actions OIDC provider. Set to false if
    token.actions.githubusercontent.com already exists in this account
    (only one provider per URL is allowed per account).
  EOT
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to all bootstrap resources."
  type        = map(string)
  default = {
    Project   = "Elections Monitor"
    ManagedBy = "Terraform"
    Component = "bootstrap"
  }
}

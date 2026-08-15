variable "aws_region" {
  description = "Region for the S3 origin bucket."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Apex domain served by the distribution. Must already have a public Route 53 hosted zone."
  type        = string
  default     = "irev2.com"
}

variable "subject_alternative_names" {
  description = "Extra names on the certificate and CloudFront distribution."
  type        = list(string)
  default     = ["www.irev2.com"]
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 = North America + Europe (cheapest)."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default = {
    Project   = "Elections Monitor"
    ManagedBy = "Terraform"
    Component = "website"
  }
}

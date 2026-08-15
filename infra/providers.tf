terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # Zips the api/ directory into the Lambda bundle at plan time, which keeps
    # CI to a single terraform apply with no build step.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Partial backend configuration. The bucket name embeds the AWS account ID,
  # so it is supplied at init time instead of being committed to this public
  # repository:
  #
  #   terraform init -backend-config="bucket=<state bucket>"
  #
  # use_lockfile enables native S3 state locking (no DynamoDB table needed).
  backend "s3" {
    key          = "elections-monitor/site.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.tags
  }
}

# CloudFront only accepts ACM certificates issued in us-east-1, regardless of
# where the rest of the stack lives.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = var.tags
  }
}

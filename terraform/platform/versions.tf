terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~>6.0"
    }
  }

  backend "s3" {
    bucket       = "yayyy-vpc-tfstate-bucket-3sep2004"
    key          = "platform/terraform.tfstate"
    region       = "ap-south-1"
    profile      = "personal"
    use_lockfile = true
  }
}

provider "aws" {
  region  = "ap-south-1"
  profile = "personal"

}
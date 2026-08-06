terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~>6.0"

    }  
    helm = {
      source = "hashicorp/helm"
      version = "~>2.0"
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

provider "helm" {
  kubernetes {
    host = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec {
    api_version = "client.authentication.k8s.io/v1beta1" 
    command = "aws"
    args = ["eks","get-token","--cluster-name",module.eks.cluster_name,"--region","ap-south-1","--profile","personal"]
    }
  }
}
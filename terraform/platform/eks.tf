module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~>21.0"

  name               = "yayyy-cluster"
  kubernetes_version = "1.36"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  endpoint_public_access  = false
  endpoint_private_access = true

  security_group_additional_rules = {
    cloudshell_ingress = {
      description              = "Allow CloudShell VPC environment to reach EKS API"
      protocol                 = "tcp"
      from_port                = 443
      to_port                  = 443
      type                     = "ingress"
      source_security_group_id = aws_security_group.cloudshell.id
    }
  }

  node_security_group_tags = {
    "karpenter.sh/discovery" = "yayyy-cluster"
  }



  eks_managed_node_groups = {
    system = {
      instance_types = ["t3.small"]
      min_size       = 1
      max_size       = 2
      desired_size   = 1
    }
  }

  enable_cluster_creator_admin_permissions = true

  tags = {
    Terraform   = "true"
    Environment = "prac"
  }

  addons = {
    eks-pod-identity-agent = {}
  }

}

resource "aws_security_group" "cloudshell" {
  name   = "yayyy-cloudshell-sg"
  vpc_id = module.vpc.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Terraform = "true"
  }
}

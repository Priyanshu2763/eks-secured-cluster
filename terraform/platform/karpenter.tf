module "karpenter" {
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "~>21.0"

  cluster_name = module.eks.cluster_name

  enable_spot_termination = true

  tags = {
    Terraform   = "true"
    Environment = "prac"
  }
}

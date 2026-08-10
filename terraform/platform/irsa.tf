module "ebs_csi_irsa" {
  source               = "../modules/irsa-role"
  role_name            = "yayyy-ebs-csi-irsa"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider
  namespace            = "kube-system"
  service_account_name = "ebs-csi-controller-sa"
  policy_arns          = ["arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"]
}

resource "aws_iam_policy" "lb_controller" {
  name   = "yayyy-aws-load-balancer-controller-policy"
  policy = file("${path.module}/policies/aws-load-balancer-controller-iam-policy.json")
}

module "lb_controller" {
  source = "../modules/irsa-role"

  role_name            = "yayyy-lb-controller-irsa"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider
  namespace            = "kube-system"
  service_account_name = "aws-load-balancer-controller"
  policy_arns          = [aws_iam_policy.lb_controller.arn]

}

resource "aws_iam_policy" "external_dns" {
  name = "yayyy-external-dns-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = ["arn:aws:route53:::hostedzone/Z1029731ZDLZRX91428N"]
      },
      {
        Effect   = "Allow"
        Action   = ["route53:ListHostedZones", "route53:ListResourceRecordSets"]
        Resource = ["*"]
      }
    ]
  })
}

module "external_dns" {
  source = "../modules/irsa-role"

  role_name            = "yayyy-external-dns-irsa"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider
  namespace            = "external-dns"
  service_account_name = "external-dns"
  policy_arns          = [aws_iam_policy.external_dns.arn]
}

resource "aws_iam_policy" "cert_manager" {
  name = "yayyy-cert-manager-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["route53:GetChange"]
        Resource = ["arn:aws:route53:::change/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
        Resource = ["arn:aws:route53:::hostedzone/Z1029731ZDLZRX91428N"]
      },
      {
        Effect   = "Allow"
        Action   = ["route53:ListHostedZonesByName"]
        Resource = ["*"]
      }
    ]
  })
}

module "cert_manager" {
  source               = "../modules/irsa-role"
  role_name            = "yayyy-cert-manager-irsa"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider
  namespace            = "cert-manager"
  service_account_name = "cert-manager"
  policy_arns          = [aws_iam_policy.cert_manager.arn]
}
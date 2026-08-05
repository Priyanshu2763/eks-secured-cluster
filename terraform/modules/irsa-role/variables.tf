variable "role_name" {
  description = "Name for the IAM role"
  type        = string
}

variable "oidc_provider_arn" {
  description = "ARN of the cluster's OIDC provider (module.eks.oidc_provider_arn)"
  type        = string
}

variable "oidc_provider_url" {
  description = "OIDC issuer URL without the https:// prefix (module.eks.oidc_provider)"
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace the service account lives in"
  type        = string
}

variable "service_account_name" {
  description = "Kubernetes service account name this role is bound to"
  type        = string
}

variable "policy_arns" {
  description = "IAM policy ARNs to attach to this role"
  type        = list(string)
  default     = []
}

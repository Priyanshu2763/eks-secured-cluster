output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnet_ids" {
  value = module.vpc.private_subnets
}

output "public_subnet_ids" {
  value = module.vpc.public_subnets
}

output "private_route_table_ids" {
  value = module.vpc.private_route_table_ids
}

output "nat_gateway_ids" {
  value = module.vpc.natgw_ids
}

output "lb_controller_role_arn" {
  value = module.lb_controller.role_arn
}

output "external_dns_role_arn" {
  value = module.external_dns.role_arn
}

output "cert_manager_role_arn" {
  value = module.cert_manager.role_arn
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "karpenter_interruption_queue" {
  value = module.karpenter.queue_name
}

output "karpenter_node_iam_role_name" {
  value = module.karpenter.node_iam_role_name
}


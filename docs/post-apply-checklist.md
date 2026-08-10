# Post-`terraform apply` Checklist

Every placeholder left in the GitOps YAML, and exactly what to run to get its real value. Do this after `terraform apply` finishes in `terraform/platform/`, before the ArgoCD bootstrap (`kubectl apply -f gitops/bootstrap/root-app.yaml`).

Run `terraform output` (no name) once to see everything at a glance, or pull individual values with `terraform output <name>` as listed below.

| File | Line | Placeholder | Run this |
|---|---|---|---|
| `gitops/platform/aws-load-balancer-controller.yaml` | 16 | `vpcId` | `terraform output vpc_id` |
| `gitops/platform/aws-load-balancer-controller.yaml` | 21 | `eks.amazonaws.com/role-arn` | `terraform output lb_controller_role_arn` |
| `gitops/platform/external-dns.yaml` | 25 | `eks.amazonaws.com/role-arn` | `terraform output external_dns_role_arn` |
| `gitops/platform/cert-manager.yaml` | 20 | `eks.amazonaws.com/role-arn` | `terraform output cert_manager_role_arn` |
| `gitops/platform/karpenter.yaml` | 15 | `clusterEndpoint` | `terraform output cluster_endpoint` |
| `gitops/platform/karpenter.yaml` | 16 | `interruptionQueue` | `terraform output karpenter_interruption_queue` |
| `gitops/platform/karpenter-resources/ec2nodeclass.yaml` | 7 | `role` | `terraform output karpenter_node_iam_role_name` |

7 placeholders total, across 5 files. `terraform output` values print with quotes around them (e.g. `"vpc-0abc123"`) — strip the quotes when pasting into YAML.

## After filling all 7 in

1. Commit and push — ArgoCD only sees what's in Git, not your local working copy.
2. `kubectl apply -f gitops/bootstrap/root-app.yaml` (one-time manual step — everything after this syncs automatically).
3. Watch it converge: `kubectl get applications -n argocd`.

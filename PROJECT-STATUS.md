# MediaVault EKS — Project Status

What this project is, what's been built, and how it all fits together. Written to be understood with zero prior context.

## What this project is

A media upload/streaming app (**mediavault**) — users upload video/audio, it's stored and served back. Deployed on AWS using Kubernetes (EKS), built with Terraform (infrastructure) + ArgoCD (GitOps deployment).

## The big picture flow

```
User's browser
      │
      ▼
  Kong (API Gateway) ── public entry point, only public thing in the cluster
      │
      ▼
  mediavault backend (inside the cluster, private)
      │
      ├──► S3 bucket           (stores the actual media files)
      └──► DynamoDB tables     (stores metadata: catalog, uploads, audit log)
```

Everything except Kong sits in **private subnets** — not reachable from the internet directly. Kong is the one deliberate front door.

## How the infrastructure is organized

**Two tools, two jobs, clean split:**

- **Terraform** — provisions raw AWS infrastructure: the network (VPC), the Kubernetes cluster (EKS), storage (S3/DynamoDB/ECR), and IAM permissions. Run manually (`terraform apply`), not automatic.
- **ArgoCD** — once the cluster exists, ArgoCD takes over. Everything that runs *inside* Kubernetes (Kong, cost monitoring, DNS automation, TLS certs) is defined as YAML files in Git. Push to Git, ArgoCD deploys it automatically. No manual `kubectl apply` after the first bootstrap step.

## What's been built (as code — not yet deployed to AWS)

### Terraform — `terraform/bootstrap/` (one-time setup)
- Remote state storage bucket (where Terraform tracks what it's built)
- S3 bucket for media uploads (private, encrypted, auto-cleanup of old files)
- Two ECR repos for Docker images (api, web)
- Three DynamoDB tables (media catalog, uploads-in-progress, audit log)

### Terraform — `terraform/platform/` (the actual cluster)
- VPC — private network, 3 availability zones, private + public subnets
- EKS cluster — fully private (no public internet route to the Kubernetes control plane at all)
- IAM roles for 4 different pieces of software that'll run in the cluster, each scoped to exactly what it needs and nothing more (EBS storage driver, load balancer controller, DNS automation, TLS cert automation)
- One VPC endpoint so traffic to S3 stays on AWS's private network instead of going out to the public internet

### ArgoCD-managed apps — `gitops/platform/` (deploy automatically once cluster + ArgoCD exist)
- **AWS Load Balancer Controller** — lets Kubernetes actually create a real internet-facing load balancer
- **Kong** — the API gateway; public entry point, routes traffic to backend services, handles rate-limiting/auth as plugins instead of app code
- **Kubecost** — cost dashboard, admin-only, shows AWS spend broken down per service
- **ExternalDNS** — automatically points `mediavault.priyanshugupta.online` at whatever address Kong ends up with, no manual DNS edits
- **cert-manager** — automatically gets and renews a free HTTPS certificate from Let's Encrypt for that domain

## Key decisions made, and why

- **Cluster is fully private.** No direct internet access to the Kubernetes control plane — reduces attack surface significantly.
- **Access for now is via AWS CloudShell** (a free, temporary way to reach the private cluster). A proper VPN (AWS Client VPN) is planned but deliberately saved for last, since it costs ~$70+/month just to exist — no point paying for it while still building.
- **Only Kong is public-facing.** Every other internal piece (databases, cost dashboard, etc.) defaults to private-only.
- **GitOps for anything that runs in the cluster.** Once ArgoCD is up, deploying/changing an app is a `git push`, not a manual command — safer and auditable.
- **Everything reuses one IAM pattern (IRSA)** — instead of giving broad permissions to whole servers, each specific piece of software gets its own narrow, scoped-down AWS permissions.

## What's NOT done yet

- **Nothing has actually been deployed to AWS yet.** Everything above is written and validated as code (`terraform validate` passes, YAML syntax checked), but no `terraform apply` has been run for the platform layer. This has all been built file-by-file precisely to review it before any AWS cost is incurred.
- Two spots in the ArgoCD files have placeholder values (a VPC ID and an IAM role ARN) that can only be filled in *after* the first `terraform apply`, since those values don't exist until then.
- AWS Client VPN — deferred to the very end, as noted above.
- Karpenter (smarter, cheaper auto-scaling for cluster nodes) — planned, not yet written.

## Next step

Run `terraform apply` for `bootstrap/`, then `platform/`, fill in the two placeholder values with real outputs, then apply the one manual `kubectl apply` that starts ArgoCD's automatic sync of everything else.

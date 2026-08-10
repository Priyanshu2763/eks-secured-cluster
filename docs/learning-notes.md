# MediaVault EKS — Learning Notes

Running log of what's been built, why, and what each tool actually does. Updated as we go.

## Repo hygiene

- **`.gitignore`** — root-level, added because `terraform/` was 1.5GB from `.terraform/` provider plugin caches (per dir) — never meant to be committed. Also ignores `.tfstate`, `.tfstate.backup`, `.tfvars` (can contain secrets/sensitive values).
- **Git remote** — token embedded directly in the URL (`https://ghp_...@github.com/...`). Works, but plaintext in `.git/config`. Rotate on GitHub if that token was ever pasted somewhere untrusted.

## Terraform structure

- **`terraform/bootstrap/`** — one-time setup, applied first, **local state** (no backend). Creates the S3 bucket (`yayyy-vpc-tfstate-bucket-3sep2004`) that `platform/` uses as its remote backend.
- **`terraform/platform/`** — the actual infra (VPC, EKS, IRSA, ArgoCD). Uses **S3 backend** for state.
- **Lesson learned**: S3 *backend* blocks need their own `profile` set — they don't inherit the `provider "aws"` block's profile. Missing it caused a 403 (was silently using a different AWS account's default credentials).

## VPC (`vpc.tf`)

- `terraform-aws-modules/vpc/aws` module. 3 AZs, private + public subnets, single NAT gateway.
- Private subnets tagged `karpenter.sh/discovery` — signals intent to use **Karpenter** for node autoscaling later (not written yet).
- Public subnets tagged `kubernetes.io/role/elb` — required so AWS auto-discovers them for internet-facing load balancers (used later by Kong).

## EKS (`eks.tf`)

- `terraform-aws-modules/eks/aws`, cluster name `yayyy-cluster`.
- **Fully private**: `endpoint_public_access = false`. No route from the internet to the K8s API at all.
- **Lesson learned**: module `v20.x` needs AWS provider `<6.0`, but our VPC module needs `>=6.28`. Conflict — had to bump EKS module to `v21.x`, which also renamed most `cluster_*` variables (`cluster_name` → `name`, `cluster_version` → `kubernetes_version`, etc.) — always check a module's upgrade guide on a major version bump.
- One small managed node group (`t3.small`, min 1/max 2) just to bootstrap system pods (CoreDNS, Karpenter controller). Karpenter will own real workload nodes later, via its own `NodePool`/`EC2NodeClass` manifests (not Terraform).
- `t3.small` chosen over `t3.micro` because pod count on a node is capped by ENI/IP slots, not just RAM — `t3.micro` only fits ~4 pods, too few for baseline system pods.

## Cluster access (no bastion — used CloudShell instead)

- Cluster is private-only, so *something* inside the VPC is needed to reach it from a laptop.
- Considered: SSM bastion (cheap, always-on) vs AWS Client VPN (~$70+/mo, feels like a normal VPN).
- **Decision**: skip both for now. Use a **CloudShell VPC environment** (AWS console feature — attaches CloudShell's own ENI into your subnets) as a free interim option.
- **AWS Client VPN is deferred to the very end** — applied last, once everything else is built, to avoid paying its endpoint fee the whole time.
- Needed: a security group for CloudShell's ENI + an ingress rule on the EKS cluster security group allowing 443 from it (`security_group_additional_rules` on the EKS module).

## IRSA — IAM Roles for Service Accounts (`irsa.tf` + `modules/irsa-role`)

- **What it is**: lets a specific Kubernetes `ServiceAccount` (not the whole node) assume a specific IAM role, via OIDC federation.
- **Why**: without it, IAM permissions live on the node role and *every* pod on that node shares them — too broad. IRSA scopes it to one service account.
- Cluster already creates the OIDC provider automatically (`enable_irsa` defaults to `true` in the module).
- Built a reusable module (`modules/irsa-role`) — takes a role name, namespace, service account name, and policy ARNs; wires the OIDC trust policy automatically.
- **Gotcha**: `namespace` + `service_account_name` must match *exactly* what the real Helm chart creates later, or the trust policy silently won't match → `AccessDenied` at runtime.
- Used for: EBS CSI driver (AWS-managed policy), AWS Load Balancer Controller (custom policy, vendored JSON from AWS's GitHub).

## VPC Endpoint — S3 only (`endpoints.tf`)

- Kept simple on purpose: just the **S3 Gateway Endpoint** (free — modifies route tables, no ENI, no security group needed).
- Does double duty: (1) infra — ECR stores image layers in S3, so pulling container images benefits; (2) app — if mediavault's backend uploads media directly to S3 from pods, that traffic also goes through this endpoint privately instead of via NAT.
- Skipped for now: ECR/STS/EC2 interface endpoints (small hourly cost each) — can add later if we want *zero* NAT dependency for cluster infra traffic.

## ArgoCD (`argocd.tf` + `versions.tf`)

- Installed via Terraform's **Helm provider** (`helm_release` resource) — the *only* thing installed this way.
- **Everything after ArgoCD is GitOps** (YAML in `gitops/`, synced automatically) — Terraform's job stops at "get ArgoCD running."
- **"App of apps" pattern**: one root `Application` (`gitops/bootstrap/root-app.yaml`), applied manually once via `kubectl apply`, watches `gitops/platform/`. Any `Application` YAML dropped in that folder afterward gets deployed automatically — no more manual steps.
- `root-app.yaml` — written and valid, real repo URL filled in (`https://github.com/Priyanshu2763/eks-secured-cluster.git`). This is the file that makes everything else in `gitops/platform/` actually take effect — without it, every Application we write just sits inert in Git.

## Kong — API Gateway

- **One-liner**: sits between the internet and your backend services; all external traffic hits Kong first, which routes it to the right internal service.
- **Why here**: centralizes routing (`/upload` → upload-service, etc.), auth/rate-limiting as plugins instead of app code, one place for TLS termination.
- **Decision**: internet-facing (public NLB) — this is a media app, needs real public ingress for uploads/playback.
- **Decision**: installed via ArgoCD (GitOps), referencing Kong's **official Helm chart repo** directly (`https://charts.konghq.com`) — not vendored into our repo, so we always get upstream updates.
- Written and valid: `gitops/platform/kong.yaml`. `proxy.annotations` are what actually connect Kong's Service to the Load Balancer Controller: `aws-load-balancer-type: external` hands off from the deprecated in-tree AWS integration to the controller; `nlb-target-type: ip` registers pods directly as targets (not nodes); `scheme: internet-facing` makes it public.
- Depends on the AWS Load Balancer Controller existing first (see above).

## AWS Load Balancer Controller

- **One-liner**: the controller that actually turns a Kubernetes `Service type: LoadBalancer` into a real AWS NLB/ALB. Kubernetes has no native AWS API integration for this on modern EKS.
- **Why needed**: without it, Kong's `LoadBalancer` Service would never get a real external address.
- IAM policy is AWS-authored, 251 lines — vendored verbatim from AWS's GitHub rather than hand-written (`terraform/platform/policies/aws-load-balancer-controller-iam-policy.json`).
- IRSA role added to `irsa.tf` as `module.lb_controller` — **written and validated**.
- ArgoCD `Application` written at `gitops/platform/aws-load-balancer-controller.yaml` — **written and YAML-valid**. Still has two placeholders (`vpcId`, `role-arn`) to fill in with real values after `terraform apply` — can't know them before applying.

## Kubecost — cost observability

- **One-liner**: reads cluster resource usage, cross-references real AWS billing, shows per-namespace/per-workload cost breakdown instead of one opaque bill.
- **Decision**: internal-only. Unlike Kong, needed **zero** extra config for this — `ClusterIP` (private) is Kubernetes' default Service type; Kong needed annotations specifically *because* it had to override that default to go public.
- Written and valid: `gitops/platform/kubecost.yaml`. Viewed later via `kubectl port-forward`, not a public URL.

## ExternalDNS

- **One-liner**: watches Ingress/Service objects, auto-creates/updates matching Route53 records — no manual DNS edits.
- Domain: `priyanshugupta.online`, hosted zone ID `Z1029731ZDLZRX91428N`. Subdomain planned: `mediavault.priyanshugupta.online`.
- IRSA role (`module.external_dns` in `irsa.tf`) — custom policy written **inline** with `jsonencode()` (small enough not to vendor as a file, unlike the LB controller's). `route53:ChangeResourceRecordSets` scoped to exactly this one hosted zone ARN; `ListHostedZones`/`ListResourceRecordSets` have to stay `Resource: "*"` — Route53 doesn't support scoping list actions to one zone.
- **Lesson learned**: `jsonencode()` (HCL object → JSON string) vs `jsondecode()` (JSON string → HCL object) — easy one-word mixup, opposite directions. Policy resources need `jsonencode`.
- `domainFilters` in the Helm values is a second, independent safety boundary beyond IAM — restricts ExternalDNS to this one domain even if the IAM policy were ever loosened.
- `policy: upsert-only` chosen over `sync` — never auto-deletes DNS records, only creates/updates. Safer default for a learning environment where a misconfigured Ingress deleting a real record would be an annoying surprise.
- Written and valid: `gitops/platform/external-dns.yaml`.

## cert-manager + Let's Encrypt `ClusterIssuer`

- **One-liner**: automates requesting/renewing TLS certs — watches for a `Certificate`/`ClusterIssuer` resource and handles the Let's Encrypt ACME flow itself.
- **CRDs (Custom Resource Definitions), briefly**: Kubernetes only natively understands built-in types (`Pod`, `Service`, etc). A CRD lets software register a brand-new type with the API server — `ClusterIssuer` is cert-manager's own invention, not a Kubernetes-native concept. Until its CRD is installed, Kubernetes rejects `kind: ClusterIssuer` outright.
- **Sync waves**: an ArgoCD annotation (`argocd.argoproj.io/sync-wave: "N"`) that orders *separate* Applications — lower numbers sync first, and ArgoCD waits for a wave to be healthy before starting the next. Used here because `ClusterIssuer` (wave `"1"`) depends on a CRD that only exists after cert-manager's own Helm release (default wave `0`) has installed it — solves the "config needs the software's CRD to exist first" ordering problem. Only works between separate `Application` objects, not within one.
- Controller: `irsa.tf` (`module.cert_manager`) + `gitops/platform/cert-manager.yaml`. IRSA policy adds `route53:GetChange` (scoped to `arn:aws:route53:::change/*`) so it can poll whether a DNS-01 challenge record has propagated before telling Let's Encrypt to verify it. `crds.enabled: true` in the Helm values installs the CRDs as part of the same release.
- Config: `gitops/platform/cert-manager-cofig.yaml` (Application, `sync-wave: "1"`, points at a path in our own repo rather than a Helm chart — source type #2) → `gitops/platform/cert-manager-resources/cluster-issuer.yaml` (the actual `ClusterIssuer`, `dns01.route53` solver, scoped to our one hosted zone). No AWS credentials anywhere in it — picks up Route53 access automatically via its pod's IRSA role, same mechanism as everything else.
- All four pieces written and valid: `root-app.yaml`, `cert-manager.yaml`, `cert-manager-cofig.yaml`, `cluster-issuer.yaml`.

## Still queued / not started

- **`bootstrap/` stubs still empty**: `ecr.tf`, `dynamodb.tf`, `budget.tf`, `s3-media.tf` — media upload bucket goes in `s3-media.tf`, deferred since it has zero dependency on the rest of the stack.
- **AWS Client VPN** — deferred to the very end, applied last.

## App-side (separate from the infra track)

- Local dev stack: `app/docker-compose.yml` — LocalStack (emulates S3 + DynamoDB), API (Express), web (React/Vite behind nginx). `docker compose up --build` from `app/`.
- **Basic Auth** added on the web app's nginx layer (dev-only gate, phpMyAdmin-style browser prompt). `admin` / `pass123`, hardcoded in `.htpasswd`, baked into the image. `/healthz` explicitly exempted so k8s probes still work.
- **Flag**: hardcoded creds are fine for now but must move to a real Kubernetes Secret before Kong ever fronts this publicly.

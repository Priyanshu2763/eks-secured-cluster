# MediaVault — A Secured EKS Platform, Built Step by Step

A hands-on, teach-as-you-go plan for building a production-shaped platform on AWS:

- A private-subnet **EKS** cluster
- **MediaVault**, a demo app where users upload audio/video to **S3** and manage records through a CRUD API
- **AWS API Gateway** (HTTP API + VPC Link) fronting the API, so the API is never directly reachable from the internet
- **DynamoDB** in a *separate AWS account*, created by hand, reached over a free **Gateway VPC endpoint** with cross-account IAM
- A full GitOps platform layer — **Karpenter**, **ExternalDNS**, **cert-manager + Let's Encrypt**, **Kubecost** — delivered by **Helm** and **Argo CD**
- All app-account AWS infrastructure owned by **Terraform**

> **Certificates are Let's Encrypt throughout, issued by a cert-manager ClusterIssuer.** ACM is
> never used as a certificate *authority* here. It appears in exactly one place — as a container for
> the Let's Encrypt cert that API Gateway requires — and [§3.9](#39-the-api-gateway--lets-encrypt-constraint)
> explains why that's unavoidable and how to automate it.

**You type every command yourself.** This document is the map, the theory, and the gotcha list. It
deliberately does not hand you a finished repo. Each phase tells you what to build, why it exists,
how the parts actually work, and how to prove it works before moving on.

---

## Table of Contents

- [0. Conventions & Placeholders](#0-conventions--placeholders)
- [1. Architecture at a Glance](#1-architecture-at-a-glance)
- [2. The Cost Model](#2-the-cost-model)
- [3. Key Design Decisions & Why](#3-key-design-decisions--why)
- [4. Repository Layout](#4-repository-layout)
- [5. The Application: MediaVault](#5-the-application-mediavault)
- [6. DynamoDB Data Model — Build These First](#6-dynamodb-data-model--build-these-first)
- [Phase 0 — Prerequisites & Guardrails](#phase-0--prerequisites--guardrails)
- [Phase 1 — Terraform Bootstrap](#phase-1--terraform-bootstrap)
- [Phase 2 — Data Account (manual): DynamoDB & Cross-Account Role](#phase-2--data-account-manual)
- [Phase 3 — Network: VPC, Subnets, NAT, Gateway Endpoints](#phase-3--network)
- [Phase 4 — The EKS Cluster](#phase-4--the-eks-cluster)
- [Phase 5 — Identity: IRSA & the Cross-Account Hop](#phase-5--identity)
- [Phase 6 — Argo CD Bootstrap & App-of-Apps](#phase-6--argo-cd-bootstrap)
- [Phase 7 — Karpenter](#phase-7--karpenter)
- [Phase 8 — Ingress: ingress-nginx + two NLBs](#phase-8--ingress)
- [Phase 8B — AWS API Gateway (HTTP API + VPC Link)](#phase-8b--aws-api-gateway)
- [Phase 9 — cert-manager + Let's Encrypt](#phase-9--cert-manager--lets-encrypt)
- [Phase 10 — ExternalDNS](#phase-10--externaldns)
- [Phase 11 — External Secrets Operator](#phase-11--external-secrets-operator)
- [Phase 12 — Build & Deploy MediaVault](#phase-12--build--deploy-mediavault)
- [Phase 13 — Kubecost](#phase-13--kubecost)
- [Phase 14 — Security Hardening Pass](#phase-14--security-hardening-pass)
- [Phase 15 — Teardown & Rebuild Drill](#phase-15--teardown--rebuild-drill)
- [16. The Flow — Diagram & Narrative](#16-the-flow--diagram--narrative)
- [17. Gotcha Index](#17-gotcha-index)
- [18. Glossary](#18-glossary)
- [Appendix A — VPC Peering: why it isn't here](#appendix-a--vpc-peering-why-it-isnt-here)

---

## 0. Conventions & Placeholders

This repo is public. **Nothing in it contains a real account ID, domain, email, or ARN.** Every
environment-specific value is a placeholder. Keep it that way — put real values in
`terraform.tfvars` and `.env`, both of which are gitignored.

| Placeholder | Meaning | Example used in samples |
|---|---|---|
| `<APP_ACCOUNT_ID>` | AWS account running EKS, VPC, S3 | `111111111111` |
| `<DATA_ACCOUNT_ID>` | AWS account owning the DynamoDB tables | `222222222222` |
| `<REGION>` | AWS region for everything | `ap-south-1` |
| `<DOMAIN>` | Your Route 53 public hosted zone | `example.com` |
| `<HOSTED_ZONE_ID>` | That zone's ID | `Z0000000000000000000` |
| `<CLUSTER_NAME>` | EKS cluster name | `mediavault-dev` |
| `<ENV>` | Environment slug | `dev` |
| `<MEDIA_BUCKET>` | S3 bucket for uploads | `mediavault-dev-media-<suffix>` |
| `<APP_PROFILE>` | AWS CLI profile for the app account | `mv-app` |
| `<DATA_PROFILE>` | AWS CLI profile for the data account | `mv-data` |

**Two AWS accounts.** Everything lives in the **app account** except the DynamoDB tables and one
IAM role, which live in the **data account**. Use two named CLI profiles and never rely on a
default:

```bash
aws configure --profile mv-app
aws configure --profile mv-data
export AWS_PROFILE=mv-app          # the default for most of this guide
```

**Guard against a wrong-account apply.** Put this in every Terraform root. Five lines that make it
impossible to `apply` into the wrong account because you forgot an `export`:

```hcl
data "aws_caller_identity" "current" {}

resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "Wrong AWS account: got ${data.aws_caller_identity.current.account_id}, expected ${var.expected_account_id}. Check AWS_PROFILE."
    }
  }
}
```

### How to use this guide

Each phase has the same four blocks:

| Block | Purpose |
|---|---|
| **Concept** | What the thing is and how it actually works. Read this even in a hurry. |
| **Build** | What to create, as objectives rather than copy-paste. |
| **Verify** | A command whose output proves the phase worked. Don't advance until it passes. |
| **Gotchas** | The specific ways this phase bites people. |

Work in order. Phases 7–13 are Argo CD applications and *could* be parallel, but sync-wave ordering
matters — do them one at a time and watch each go Healthy.

### Version pinning

Pin everything explicitly. Never track `latest` — a chart bump at 2am is not a learning experience
you want. Check what's current before you pin:

```bash
aws eks describe-cluster-versions --query 'clusterVersions[].{v:clusterVersion,status:status}' --output table
helm repo add argo https://argoproj.github.io/argo-helm && helm repo update
helm search repo argo/argo-cd --versions | head -5
```

Ballpark targets — verify each:

| Component | Version family |
|---|---|
| Kubernetes / EKS | 1.33+ (use the current EKS **default**, not the newest) |
| terraform-aws-modules/vpc | `~> 6.0` |
| terraform-aws-modules/eks | `~> 21.0` (v20+ uses Access Entries, not `aws-auth`) |
| Karpenter | `1.x` (CRDs at `karpenter.sh/v1`) |
| cert-manager | `v1.16+` |
| ingress-nginx chart | `4.12+` |
| external-dns chart | `1.15+` (from **kubernetes-sigs**, not Bitnami) |
| argo-cd chart | `7.x` / `8.x` |
| external-secrets chart | `0.10+` |
| kubecost cost-analyzer | `2.x` |

---

## 1. Architecture at a Glance

```
                                        ☁  INTERNET
                                             │
        ┌──────────────┬─────────────────────┴──────────────┬─────────────────────┐
        │              │                                    │                     │
   (1) DNS        (2) app.<DOMAIN>                  (3) api.<DOMAIN>       (4) Direct S3 PUT
        │           HTTPS, web UI                    HTTPS, CRUD API      (presigned, TLS)
        ▼              │                                    │                     │
 ┌──────────────┐      │                                    ▼                     │
 │  Route 53    │      │                     ┌──────────────────────────────┐     │
 │ public zone  │      │                     │  AWS API GATEWAY (HTTP API)  │     │
 └──────────────┘      │                     │  · custom domain api.<DOMAIN>│     │
        ▲              │                     │  · cert: LE cert imported to │     │
        │              │                     │    ACM  (see §3.9)           │     │
        │ ExternalDNS  │                     │  · throttling · access logs  │     │
        │ writes A/TXT │                     │  · CORS handled HERE only    │     │
        │ (app only —  │                     │  ⚠ 10 MB payload · 30s max   │     │
        │  api record  │                     └──────────────┬───────────────┘     │
        │  is Terraform)│                                   │ VPC LINK            │
        │              │                                    │ (ENIs in your       │
        │ DNS-01 TXT   │                                    │  private subnets)   │
        │ (cert-mgr)   ▼                                    ▼                     │
════════╪══════════════════════════════════════════════════════════════════════════╪═════
        │        APP ACCOUNT <APP_ACCOUNT_ID>  ·  VPC 10.0.0.0/16                  │
        │       ┌────────────────┐              ┌────────────────────┐             │
        │       │ PUBLIC NLB     │              │  INTERNAL NLB      │             │
        │       │ (web only)     │              │  (API only —       │             │
        │       │                │              │   NOT internet-    │             │
        │       │                │              │   reachable)       │             │
        │       └───────┬────────┘              └─────────┬──────────┘             │
        │   ┌── PUBLIC SUBNETS (2 AZ) ───────────────┐    │                        │
        │   │   NLB nodes  ·  NAT Gateway ──► egress │    │                        │
        │   └────────────────┼───────────────────────┘    │                        │
        │                    ▼                            ▼                        │
        │   ┌── PRIVATE SUBNETS (2 AZ) ───────────────────────────────────────┐   │
        │   │  ┌───────────────────────────────────────────────────────────┐  │   │
        │   │  │   EKS control plane (AWS-managed)                         │  │   │
        │   │  │   endpoint: private + public restricted to your /32        │  │   │
        │   │  └──────────────────────────┬────────────────────────────────┘  │   │
        │   │                             │                                   │   │
        │   │  ┌──────────────────────────▼────────────────────────────────┐  │   │
        │   │  │ WORKER NODES                                              │  │   │
        │   │  │  managed nodegroup 2×t3.medium  │  Karpenter SPOT nodes    │  │   │
        │   │  │  (system-critical only)         │  (scaled + consolidated) │  │   │
        │   │  │                                                            │  │   │
        │   │  │  PLATFORM ns        APP ns (media)      OBSERVABILITY       │  │   │
        │   │  │  ├ argocd           ├ mediavault-web    └ kubecost          │  │   │
        │   │  │  ├ ingress-nginx    └ mediavault-api       + prometheus     │  │   │
        │   │  │  │  (2 classes:           │      │                          │  │   │
        │   │  │  │   nginx-public         │      │                          │  │   │
        │   │  │  │   nginx-internal)      │      │                          │  │   │
        │   │  │  ├ cert-manager ─── issues LE wildcard cert                 │  │   │
        │   │  │  │      └─► CronJob imports it into ACM for API GW (§3.9)   │  │   │
        │   │  │  ├ external-dns           │      │                          │  │   │
        │   │  │  ├ karpenter              │      │                          │  │   │
        │   │  │  └ external-secrets       │      │                          │  │   │
        │   │  └───────────────────────────┼──────┼──────────────────────────┘  │   │
        │   │        (5) S3 API calls      │      │  (6) DynamoDB API calls     │   │
        │   └──────────────────────────────┼──────┼─────────────────────────────┘   │
        │                                  │      │                                 │
        │            ┌─────────────────────▼──┐ ┌─▼──────────────────────┐          │
        │            │ S3 GATEWAY ENDPOINT    │ │ DYNAMODB GATEWAY       │          │
        │            │ FREE · route-table     │ │ ENDPOINT               │          │
        │            │ prefix-list entry      │ │ FREE · same mechanism  │          │
        │            └─────────┬──────────────┘ └─────────┬──────────────┘          │
        │                      │                          │                         │
        │   ┌──────────────────▼──────────┐               │  credentials from       │
        │   │  S3 BUCKET <MEDIA_BUCKET>   │               │  sts:AssumeRole ────────┼──┐
        │   │  BPA on · SSE-S3 · versioned│               │                         │  │
        │   │  TLS-only · CORS · lifecycle│               │                         │  │
        │   └─────────────────────────────┘               │                         │  │
        │   ┌─────────────────────────────┐               │                         │  │
        │   │ SSM Parameter Store (ESO)   │               │                         │  │
        │   └─────────────────────────────┘               │                         │  │
        └─────────────────────────────────────────────────┼─────────────────────────┘  │
                                                          │                            │
   ═══════════════════════════════════════════════════════╪════════════════════════════╪══
        DATA ACCOUNT <DATA_ACCOUNT_ID>                     │                            │
                                                          ▼                            │
        ┌──────────────────────────────────────────────────────────────────┐           │
        │  IAM ROLE  mediavault-<ENV>-dynamodb-access                      │◄──────────┘
        │  trust: ONLY arn:aws:iam::<APP_ACCOUNT_ID>:role/mediavault-api   │  AssumeRole
        │  perms: GetItem/PutItem/UpdateItem/DeleteItem/Query on 3 tables  │
        └───────────────────────────────┬──────────────────────────────────┘
                                        │
        ┌───────────────────────────────▼──────────────────────────────────┐
        │  DYNAMODB  (regional service — NOT in a VPC)                     │
        │  ★ CREATED MANUALLY — not Terraform. See Phase 2.                │
        │   · mediavault-<ENV>-items    (PK mediaId, GSI1 feed, GSI2 type) │
        │   · mediavault-<ENV>-uploads  (PK uploadId, TTL expiresAt)       │
        │   · mediavault-<ENV>-audit    (PK entityId, SK eventAt, TTL)     │
        │   PAY_PER_REQUEST · encryption at rest · no idle cost            │
        └──────────────────────────────────────────────────────────────────┘
```

> **Read the bottom half carefully.** The DynamoDB tables sit in a different account, but there is
> **no network link between the accounts** — none is needed. The gateway endpoint in *your* VPC
> routes traffic to the DynamoDB *service* in your region; which account's tables you touch is
> decided purely by IAM. See [§3.6](#36-cross-account-dynamodb-iam-not-peering).

### The GitOps control loop

```
   You                 Git                       Argo CD                  Kubernetes
    │                    │                          │                          │
    │ git push ─────────►│                          │                          │
    │                    │◄──── poll / webhook ─────│  (every 3 min)           │
    │                    │                          │ render Helm ──► diff     │
    │                    │                          │ desired vs live          │
    │                    │                          │──── apply ──────────────►│
    │                    │                          │◄─── watch health ────────│
    │◄─── Synced + Healthy ─────────────────────────│                          │
```

Terraform owns **AWS**. Argo CD owns **everything inside the cluster**. The only overlap is the one
`helm_release` that installs Argo CD — the bootstrap seed.

---

## 2. The Cost Model

Approximate `ap-south-1` on-demand pricing, 730 hours/month. **Verify against the AWS pricing pages
— these move.**

| Resource | Rate | 24×7 monthly |
|---|---|---|
| EKS control plane | $0.10/hr | **~$73** |
| NAT Gateway (×1) | ~$0.056/hr + $0.056/GB | **~$41** + data |
| Network Load Balancer ×2 (public + internal) | ~$0.0225/hr + NLCU ea | **~$34** |
| Managed nodegroup 2× t3.medium | ~$0.0448/hr ea | **~$65** |
| Karpenter spot nodes | ~70% off on-demand | variable |
| **API Gateway HTTP API** | ~$1.00 per million requests | **~$0** at dev volume |
| **API Gateway VPC Link** | hourly, per AZ — **verify current pricing** | **$0–15** |
| **DynamoDB (on-demand)** | $0 idle; ~$1.25/M writes, ~$0.25/M reads | **~$0** |
| S3 storage + requests | $0.025/GB-mo | ~$1 |
| Route 53 hosted zone | $0.50/mo | $0.50 |
| ACM imported certificate | free | $0 |
| ECR + CloudWatch Logs | — | ~$3–6 |
| **Total** | | **≈ $220–235/mo** |

> **Two costs to verify yourself rather than trust this table.** API Gateway **VPC Link** pricing
> for HTTP APIs has changed more than once and I'd rather you check the current pricing page than
> budget from a number I can't confirm. And the **second NLB** is a direct consequence of putting
> API Gateway in front: the API's NLB must be *internal* so the API isn't independently reachable,
> which means you can't share the public one. Budget ~$17/mo for that, and see
> [§3.8](#38-api-gateway-in-front-of-the-cluster) for what you're buying with it.

Dropping MongoDB Atlas for DynamoDB removed ~$57/mo *and* the peering complexity. DynamoDB
on-demand is the single best fit for a burst-usage learning project: **it costs literally nothing
when you aren't calling it.** There is no cluster to keep warm, no instance hours, no idle charge.

### The strategy: burst, don't idle

You are not running a business. Run the cluster in **sessions** and destroy it at night.

```
8 hours/day × 20 days = 160 hours ≈ 22% of a month ≈ $45–55 total for the whole project
```

This is why Terraform is split into two root modules (see [§4](#4-repository-layout)): `bootstrap`
and your ECR images survive; `platform` gets destroyed and recreated. The DynamoDB tables aren't in
Terraform at all — you create them by hand once (Phase 2) and they outlive every rebuild. A full
rebuild is ~18–22 minutes, almost all of it EKS control plane provisioning.

### Cost levers, ranked by impact

1. **Destroy nightly.** Biggest single lever by far. See [Phase 15](#phase-15--teardown--rebuild-drill).
2. **One NAT Gateway, not three.** `terraform-aws-modules/vpc` defaults to one per AZ. Set
   `single_nat_gateway = true`. Saves ~$82/mo. You lose AZ-failure resilience for egress —
   irrelevant here.
3. **DynamoDB `PAY_PER_REQUEST`, never provisioned.** Provisioned capacity bills 24/7 whether you
   use it or not. On-demand bills per request. For bursty dev traffic this is not close.
4. **Karpenter with spot + consolidation.** `consolidationPolicy: WhenEmptyOrUnderutilized`
   bin-packs and terminates half-empty nodes. That's Karpenter's whole point.
5. **Use only Gateway endpoints (S3, DynamoDB). Both are free.** Do *not* add interface endpoints
   "for security" — each is ~$0.01/hr **per AZ**. Seven endpoints × 2 AZs ≈ **$102/mo**, more than
   twice a single NAT Gateway. (And you can't drop NAT anyway: Let's Encrypt's ACME API is on the
   public internet and has no VPC endpoint.)
6. **CloudWatch log retention = 7 days.** EKS audit logs are chatty and accrue silently.
7. **Kubecost resource limits.** It bundles Prometheus and will happily eat 4Gi. Cap it.
8. **DynamoDB GSI projections.** `ALL` duplicates every attribute into every index — you pay
   storage and write units twice. Project only what the UI renders. See [§6](#6-dynamodb-data-model--build-these-first).

### The kill switch

Before Phase 3, create an AWS Budget with an SNS email alert at $30 and a hard alert at $75. AWS
Budgets are informational — they won't stop spending — but they turn a surprise into a warning.
Terraform it in `bootstrap` so it can never be destroyed by accident.

---

## 3. Key Design Decisions & Why

These are the choices where a reasonable person could go the other way. Understanding *why* is
worth more than the config.

### 3.1 ingress-nginx + NLB, not AWS Load Balancer Controller + ALB

You want a Let's Encrypt ClusterIssuer. That constraint decides this.

An **ALB terminates TLS using an ACM certificate**. It cannot read a Kubernetes `Secret`. So with
an ALB, cert-manager and Let's Encrypt have nothing to do — you'd use a free ACM cert instead
(which is also excellent and auto-renewing).

To learn the ACME path you need a controller that terminates TLS **inside the cluster**, reading
`tls.crt`/`tls.key` from a Secret. That's ingress-nginx. It sits behind a **Network Load Balancer**
at L4 — the NLB forwards TCP :443 to nginx pods, which do the handshake with the Let's Encrypt cert.

> **The honest trade-off:** in real AWS production, ALB + ACM + WAF is the more common and
> lower-maintenance choice. You're choosing nginx to learn ACME. Valid reason — just know what you
> traded.

Note that with API Gateway added ([§3.8](#38-api-gateway-in-front-of-the-cluster)) you now run
**two** NLBs and **two** ingress classes: `nginx-public` for the web UI, `nginx-internal` for the
API behind the VPC Link. Same controller, two Services, two `IngressClass` resources.

### 3.2 Presigned URLs vs. the VPC endpoint

The most interesting problem in this design.

You want uploads to reach S3 **through the VPC endpoint**. A VPC endpoint only affects traffic that
**originates inside your VPC**. A browser on a user's laptop is not inside your VPC.

**Path A — Presigned URLs (industry standard, the default here).**
The API generates a presigned `PUT` URL; the browser uploads *directly* to S3 over the public
internet (TLS + SigV4). Bytes never touch your pods.
- ✅ Pods stay tiny; no memory pressure, no proxy timeouts; scales to multi-GB files
- ✅ No NAT data-transfer charges for upload bytes
- ❌ Upload bytes do **not** traverse your VPC endpoint
- ✅ Everything else the API does with S3 (`HeadObject`, `DeleteObject`, `ListObjectsV2`, presigned
  GET generation) **does** go through the gateway endpoint

**Path B — Proxy through the pod (strict interpretation).**
Browser → API Gateway → VPC Link → NLB → nginx → API pod → S3.
- ✅ Would satisfy "all S3 traffic via VPC endpoint" literally
- ❌ **Impossible now that API Gateway is in front.** See below.

**⚠️ API Gateway settles this argument for you.** API Gateway has a hard **10 MB payload limit** and
a **30-second integration timeout**, neither of which is adjustable on any tier. A 200 MB video
cannot pass through it, and a slow 9 MB upload on hotel wifi would hit the timeout. Putting API
Gateway in front of the API therefore **eliminates Path B entirely** — presigned URLs are no longer
the recommended option, they're the only one that works.

This is worth sitting with, because it's a good example of how one architectural choice quietly
forecloses another. It also means the upload path is now *structurally* correct: bytes go
browser → S3 directly, and the API only ever handles small JSON control messages, which is exactly
what a 10 MB / 30 s gateway is designed for.

**⚠️ The `sourceVpce` trap, which still applies:** a bucket policy with
`Condition: {"StringNotEquals": {"aws:sourceVpce": "vpce-xxx"}}` + `Deny` will **403 your presigned
browser uploads.** The presigned URL carries your backend role's signature, but the *request*
arrives from the user's ISP, not your VPC endpoint. The condition evaluates the request's network
path, not the signer. Presigned uploads and a `sourceVpce` lockdown are mutually exclusive — and
since Path B is now off the table, you cannot have that lockdown on the upload prefix at all.

**Recommendation:** Path A, and drop `UPLOAD_MODE` from the config — there is no second mode to
switch to. Keep the *experiment* though: apply the `sourceVpce` policy in Phase 14, watch uploads
403, read the CloudTrail entry, and revert. Five minutes, and it teaches more about VPC endpoints
and SigV4 than any amount of reading.

### 3.3 IRSA over EKS Pod Identity (for now)

Two ways to give a pod an IAM role:

- **IRSA** (2019): the cluster has an OIDC provider registered in IAM. A ServiceAccount is annotated
  with a role ARN; the pod gets a projected SA token; the SDK exchanges it via
  `sts:AssumeRoleWithWebIdentity`. The role's trust policy pins the OIDC provider and the `sub` claim.
- **EKS Pod Identity** (2023): an agent DaemonSet plus an *association* (cluster + namespace + SA →
  role). No OIDC trust policy, no annotation. Simpler, reusable across clusters.

Pod Identity is the better long-term answer and you should learn it. But **every Helm chart supports
the IRSA annotation**, while Pod Identity support varies by controller and SDK version. For a first
build, spend your debugging budget on architecture, not credential-chain archaeology. Use IRSA via
`terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks`, then migrate *one*
controller to Pod Identity as a Phase 14 exercise.

### 3.4 Terraform owns AWS; Argo CD owns Kubernetes

A recurring failure mode is installing Helm charts with Terraform's `helm_release`. It works right
up until it doesn't: Terraform can't see drift inside the chart, `destroy` deadlocks on finalizers,
and plan/apply is slow.

Rule: **Terraform installs exactly one Helm release — Argo CD.** Argo CD installs everything else
from Git. Everything after Phase 6 is a `git push`, not a `terraform apply`.

### 3.5 Private subnets + a restricted-public API endpoint

Fully-private EKS API (`endpoint_public_access = false`) means `kubectl` only works from inside the
VPC — you need a bastion or SSM session. Correct for production, annoying for learning.

Middle ground: enable **both**, with `public_access_cidrs = ["<your-ip>/32"]`. The API is reachable
from your laptop only; nodes use the private endpoint. Production posture, no bastion. Workers are
**always** private — only the NLB and NAT Gateway live in public subnets.

### 3.6 Cross-account DynamoDB: IAM, not peering

**DynamoDB is not in a VPC.** It's a regional service behind a public API endpoint
(`dynamodb.<REGION>.amazonaws.com`). VPC peering connects two VPCs. There is no VPC on the DynamoDB
side to peer with, so peering is not merely unnecessary here — it is not a thing that can be done.

That's good news: it removes a whole class of cost and complexity. But the cross-account problem is
still real, and it splits into two independent questions people routinely conflate:

**Question 1 — "How does my traffic stay off the public internet?"**
Answer: a **DynamoDB Gateway VPC endpoint**. Mechanically identical to the S3 one — a route table
entry pointing at a managed prefix list. Free. It routes traffic from your private subnets to the
DynamoDB service over the AWS backbone.

Crucially: **the endpoint routes to the DynamoDB service in your region, not to an account.** Which
account's tables you touch is decided entirely by the credentials on the request. So your app
account's endpoint works perfectly for calling the data account's tables. Nothing special needed.

**Question 2 — "How do I get permission to another account's tables?"**
Answer: **IAM cross-account role assumption.**

```
  APP ACCOUNT                                    DATA ACCOUNT
  ───────────                                    ────────────
  pod  →  IRSA role                              role: mediavault-<ENV>-dynamodb-access
          mediavault-api                           trust policy:
             │                                       Principal: arn:...:role/mediavault-api
             │  sts:AssumeRole  ───────────────►      (that EXACT role ARN, nothing broader)
             │                                     permission policy:
             ◄──── temporary credentials ─────       dynamodb:GetItem/PutItem/Query/...
             │      (1 hour, auto-refreshed)         on the 3 table ARNs + index ARNs
             │
             └─→ DynamoDB API call, signed with those creds,
                 routed via the gateway endpoint
```

Two hops, two different mechanisms: OIDC gets the pod an identity in the app account; AssumeRole
projects that identity into the data account. Neither involves a network.

**The alternative worth knowing:** since 2024 DynamoDB supports **resource-based policies** — the
data account can attach a policy to each table granting the app account's role direct access, with
no AssumeRole hop. Fewer moving parts, lower latency. I recommend the AssumeRole path anyway,
because it's the pattern that transfers to *every* AWS service, and learning it once pays off
forever. Try the resource-policy variant as a Phase 14 exercise and compare.

**⚠️ STS is not covered by the gateway endpoint.** `sts:AssumeRole` calls go to
`sts.<REGION>.amazonaws.com`, which reaches the internet via your NAT Gateway. That's fine and
cheap (the calls are tiny and hourly), but it's why you still need NAT. If you ever want that
private too, it needs an STS *interface* endpoint at ~$7/mo per AZ.

### 3.7 DynamoDB over a relational database

Beyond cost, DynamoDB genuinely fits this workload: the access patterns are few, known in advance,
and all key-based. There are no joins, no ad-hoc reporting queries, no transactions spanning
entities. That is exactly the shape DynamoDB is good at.

The cost of that fit is real and worth internalizing: **you must know your access patterns before
you create the table**, because the keys and indexes *are* the query plan. There is no
`ADD INDEX` rescue later that doesn't involve a backfill. That's why [§6](#6-dynamodb-data-model--build-these-first)
comes before any infrastructure — the data model is a design input, not an implementation detail.

### 3.8 API Gateway in front of the cluster

**The honest caveat first, once:** API Gateway overlaps with ingress-nginx. Both are reverse proxies
that route, terminate TLS, and can rate-limit. In a pure-EKS design you'd pick one. You've chosen to
run both, and that's a legitimate thing to learn — the pattern is common in real organizations where
API Gateway is the mandated public API surface and Kubernetes is an implementation detail behind it.
Just don't come away thinking every EKS API needs a gateway in front. Now, the full build.

**What API Gateway genuinely adds here:**

| Capability | Why it matters |
|---|---|
| **The API leaves the public internet** | With a VPC Link to an *internal* NLB, `mediavault-api` has no internet-facing path at all. This is the biggest security win, and it's real |
| **Managed throttling** | Per-route rate limits at the edge, before traffic reaches your cluster. Replaces the app-level rate limiter from §5 |
| **Request validation** | Reject malformed bodies before they consume a pod |
| **JWT authorizer** | Native OIDC/Cognito auth with no code, when you add real auth later |
| **Access logging** | Structured request logs to CloudWatch, independent of your app |
| **WAF** | Attachable for managed rule sets (REST APIs; check current HTTP API support) |
| **A stable public contract** | The gateway URL survives cluster rebuilds — which, given your nightly-destroy strategy, is genuinely useful |

**HTTP API, not REST API.** Two different products under one name:

| | HTTP API | REST API |
|---|---|---|
| Price | ~$1.00/million | ~$3.50/million |
| Latency | lower | higher |
| VPC Link targets | ALB, NLB, Cloud Map | NLB only |
| JWT authorizer | built in | Lambda authorizer |
| Usage plans + API keys | ✗ | ✓ |
| Request/response transformation | limited | full |
| WAF | limited | ✓ |

Use **HTTP API**. It's ~70% cheaper and has everything this project needs. Reach for REST only if
you later want API keys and usage plans.

**The topology:**

```
  browser ──► api.<DOMAIN> ──► API Gateway (HTTP API)
                                    │
                                    │  VPC Link  (ENIs that AWS places
                                    │             in YOUR private subnets)
                                    ▼
                            INTERNAL NLB  (scheme: internal)
                                    │
                                    ▼
                       ingress-nginx  (class: nginx-internal)
                                    │
                                    ▼
                            mediavault-api pod
```

**Two consequences to plan for now:**

1. **A second NLB, ~$17/mo.** The API's NLB must be `internal`, or the API stays independently
   reachable and the gateway becomes decorative. You cannot share the public one.
2. **CORS moves to exactly one place.** API Gateway can emit CORS headers, and so can your app. If
   **both** do, the browser sees duplicate `Access-Control-Allow-Origin` headers and rejects the
   response — a genuinely confusing failure because the headers look correct individually. **Pick
   API Gateway** and disable CORS in the app entirely. And note that `app.<DOMAIN>` calling
   `api.<DOMAIN>` is now a real cross-origin request with a real preflight, which it wasn't when
   both lived on one host.

### 3.9 The API Gateway ↔ Let's Encrypt constraint

You've required Let's Encrypt via a cert-manager ClusterIssuer, and no ACM-issued certs. There's a
structural conflict to resolve, and it's better to understand it than to be surprised by it.

**API Gateway custom domain names can only use a certificate that lives in ACM.** That is a hard
platform constraint — there is no field for a PEM, no way to reference a Kubernetes Secret. So
`api.<DOMAIN>` requires *something* in ACM.

But **ACM can hold a certificate it didn't issue.** `aws acm import-certificate` accepts a
third-party cert, its private key, and its chain. So:

```
  cert-manager (ClusterIssuer: letsencrypt-prod)
        │  DNS-01 via Route 53
        ▼
  Let's Encrypt issues *.<DOMAIN>          ← Let's Encrypt IS the CA. Requirement met.
        │
        ▼
  Kubernetes Secret  wildcard-tls
        │
        ├──────► ingress-nginx  terminates app.<DOMAIN>      (direct, no ACM)
        │
        └──────► CronJob: read Secret ──► acm:ImportCertificate
                        │
                        ▼
                 ACM (as a container, not an issuer)
                        │
                        ▼
                 API Gateway custom domain api.<DOMAIN>
```

Let's Encrypt remains the certificate authority for both hostnames. ACM never issues anything.

**The catch, stated plainly: imported certificates do not auto-renew.** ACM can only renew certs it
issued. cert-manager will happily renew the Let's Encrypt cert at day 60, but ACM keeps serving the
old bytes until you re-import. So you need a small recurring job:

- A `CronJob` (weekly) that reads the `wildcard-tls` Secret and calls `acm:ImportCertificate` with
  the **same** `--certificate-arn`, which updates in place and leaves the API Gateway mapping intact.
- An IRSA role with `acm:ImportCertificate` and `acm:DescribeCertificate` on that one ARN.
- Re-importing an unchanged cert is a harmless no-op, so weekly is fine and simpler than trying to
  trigger on renewal.

**Two paths, pick one:**

| | Path 1 — custom domain (recommended) | Path 2 — default endpoint |
|---|---|---|
| API URL | `https://api.<DOMAIN>` | `https://<id>.execute-api.<REGION>.amazonaws.com` |
| Cert | LE cert imported to ACM | AWS-managed, invisible |
| Renewal work | a weekly CronJob | none |
| Route 53 record | Terraform alias to the API GW domain | none |
| Let's Encrypt used | yes, for both hosts | yes, for `app.<DOMAIN>` only |

**Start with Path 2** to get the whole flow working end to end — it's zero cert work and lets you
prove the VPC Link, routing, and CORS in isolation. **Then do Path 1** in Phase 9 once certs are
already issuing. Debugging a broken ACM import and a broken VPC Link at the same time is not a good
afternoon.

---

## 4. Repository Layout

Create this tree now. Empty files are fine — the structure is the plan.

```
mediavault-eks/
│
├── README.md                        ← this file
├── Makefile                         ← up / down / kubeconfig / cost / audit targets
├── .gitignore                       ← *.tfvars, *.tfstate, .env, kubeconfig, *.pem
├── .env.example                     ← every env var the app needs, with dummy values
├── .editorconfig
│
├── docs/
│   ├── architecture.md              ← your own notes as you learn — write these
│   ├── runbook.md                   ← "how do I restart X", "where do I look when Y"
│   ├── cost-log.md                  ← daily spend + what you changed. Surprisingly useful.
│   └── decisions/                   ← ADRs: one file per decision, why + alternatives
│       ├── 001-nginx-over-alb.md
│       ├── 002-presigned-only-uploads.md      ·  why API GW's 10 MB limit decided it
│       ├── 003-dynamodb-cross-account.md
│       ├── 004-irsa-over-pod-identity.md
│       ├── 005-single-table-vs-multi-table.md
│       ├── 006-api-gateway-in-front.md        ·  what it adds, what it duplicates
│       └── 007-letsencrypt-into-acm.md        ·  the import workaround + renewal
│
├── scripts/
│   ├── preflight.sh                 ← verify tools, profiles, account IDs before you start
│   ├── create-dynamodb.sh           ← ★ MANUAL, run once with <DATA_PROFILE>. See Phase 2.
│   ├── create-crossaccount-role.sh  ← ★ MANUAL, run once with <DATA_PROFILE>. See Phase 2.
│   ├── teardown.sh                  ← the ORDERED teardown from Phase 15
│   ├── audit.sh                     ← runs the Phase 14 checklist against live infra
│   ├── port-forward.sh              ← argocd / kubecost shortcuts
│   ├── seed-data.sh                 ← put ~20 fake items in DynamoDB for pagination testing
│   └── verify-vpce.sh               ← proves S3+DDB traffic really uses the gateway endpoints
│
├── terraform/
│   │
│   ├── modules/                     ← your own reusable modules
│   │   ├── irsa-role/               ·  wraps trust-policy boilerplate, forces a pinned `sub`
│   │   │   ├── main.tf
│   │   │   ├── variables.tf
│   │   │   └── outputs.tf
│   │   └── gateway-endpoints/       ·  S3 + DynamoDB endpoints + route associations
│   │       ├── main.tf
│   │       ├── variables.tf
│   │       └── outputs.tf
│   │                                ·  (no dynamodb-table module — tables are manual)
│   │
│   ├── bootstrap/                   ← APP ACCOUNT · apply ONCE · never destroy
│   │   ├── versions.tf              ·  local backend (chicken-and-egg: it creates the bucket)
│   │   ├── state.tf                 ·  TF state S3 bucket, versioned, use_lockfile = true
│   │   ├── s3-media.tf              ·  media bucket: BPA, SSE-S3, versioning, CORS, lifecycle
│   │   ├── ecr.tf                   ·  repos mediavault-api / mediavault-web, scan+immutable
│   │   ├── budget.tf                ·  AWS Budget + SNS topic + email subscription
│   │   ├── ssm.tf                   ·  SecureString params the app needs (see Phase 11)
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── terraform.tfvars.example
│   │
│   └── platform/                    ← APP ACCOUNT · apply/destroy DAILY · the expensive one
│       ├── versions.tf              ·  S3 backend, providers, account guard
│       ├── vpc.tf                   ·  VPC, 2×public, 2×private, 1×NAT, subnet tags
│       ├── endpoints.tf             ·  gateway-endpoints module (S3 + DynamoDB)
│       ├── eks.tf                   ·  cluster, access entries, addons, managed nodegroup
│       ├── karpenter.tf             ·  karpenter submodule: IAM, SQS interruption queue
│       ├── irsa.tf                  ·  roles: external-dns, cert-manager, ESO, EBS CSI
│       ├── irsa-app.tf              ·  app role + sts:AssumeRole to the MANUAL data-acct role
│       ├── irsa-acm-importer.tf     ·  role for the LE→ACM import CronJob (§3.9)
│       ├── apigateway.tf            ·  ★ HTTP API, VPC Link, routes, stage, throttling,
│       │                            ·    custom domain + Route 53 alias, access logs
│       ├── argocd.tf                ·  THE single helm_release + the root Application
│       ├── data.tf                  ·  remote state ref to bootstrap/ ONLY
│       ├── variables.tf             ·  incl. ddb_role_arn + table names (MANUAL inputs)
│       ├── outputs.tf               ·  cluster name, OIDC ARN, endpoint IDs, kubeconfig cmd
│       └── terraform.tfvars.example
│
├── gitops/                          ← Argo CD reads this from Git. Never `kubectl apply` it.
│   ├── bootstrap/
│   │   ├── root-app.yaml            ·  the app-of-apps — the ONLY thing Terraform creates
│   │   └── project.yaml             ·  AppProject: restrict source repos + dest namespaces
│   │
│   ├── namespaces/                  ← wave -1 · namespaces carry their PSA labels
│   │   └── namespaces.yaml          ·  media, ingress-nginx, cert-manager, external-dns,
│   │                                ·  external-secrets, kubecost — each PSA-labelled
│   │
│   ├── platform/                    ← one Argo Application per component
│   │   ├── karpenter.yaml           ·  wave 0  (controller + CRDs)
│   │   ├── karpenter-nodepool.yaml  ·  wave 1  (NodePool + EC2NodeClass — needs wave-0 CRDs)
│   │   ├── ingress-nginx.yaml       ·  wave 0 · TWO controllers: public + internal
│   │   ├── cert-manager.yaml        ·  wave 0
│   │   ├── cluster-issuer.yaml      ·  wave 1  (staging AND prod issuers)
│   │   ├── wildcard-cert.yaml       ·  wave 1  · the *.<DOMAIN> Certificate
│   │   ├── acm-import-cronjob.yaml  ·  wave 2  · LE Secret ──► acm:ImportCertificate (§3.9)
│   │   ├── external-dns.yaml        ·  wave 1
│   │   ├── external-secrets.yaml    ·  wave 0
│   │   ├── cluster-secret-store.yaml·  wave 1
│   │   └── kubecost.yaml            ·  wave 3
│   │
│   └── apps/
│       └── mediavault.yaml          ·  wave 5 · points at charts/mediavault
│
├── charts/
│   └── mediavault/                  ← your own Helm chart
│       ├── Chart.yaml
│       ├── values.yaml              ·  defaults
│       ├── values-dev.yaml          ·  env overrides (image tags, replica counts, host)
│       ├── .helmignore
│       └── templates/
│           ├── _helpers.tpl
│           ├── serviceaccount.yaml  ·  IRSA-annotated, ONE per workload
│           ├── api-deployment.yaml  ·  full securityContext, probes, resources
│           ├── api-service.yaml
│           ├── api-hpa.yaml
│           ├── api-pdb.yaml
│           ├── web-deployment.yaml
│           ├── web-service.yaml
│           ├── ingress-web.yaml     ·  class nginx-public  · app.<DOMAIN> · LE TLS
│           ├── ingress-api.yaml     ·  class nginx-internal · reached ONLY via VPC Link
│           ├── configmap.yaml       ·  table names, bucket, region, API base URL — NON-secret
│           ├── externalsecret.yaml  ·  pulls real secrets from SSM via ESO
│           └── networkpolicy.yaml   ·  default-deny + explicit allows
│
└── app/
    ├── api/                         ← the CRUD + presign service
    │   ├── Dockerfile               ·  multi-stage → distroless, non-root
    │   ├── .dockerignore
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── server.ts            ·  bootstrap, graceful shutdown on SIGTERM
    │       ├── config.ts            ·  env parsing + validation, fail fast on missing vars
    │       ├── routes/
    │       │   ├── health.ts        ·  /healthz (liveness) and /readyz (readiness)
    │       │   ├── uploads.ts       ·  POST /api/uploads/presign
    │       │   └── media.ts         ·  the CRUD endpoints
    │       ├── lib/
    │       │   ├── ddb.ts           ·  DocumentClient + fromTemporaryCredentials (cross-acct)
    │       │   ├── s3.ts            ·  presign helpers, HeadObject verification
    │       │   ├── ids.ts           ·  uuid/ulid generation, key construction
    │       │   ├── audit.ts         ·  append-only event writer
    │       │   └── errors.ts        ·  typed errors → correct HTTP codes, no stack leaks
    │       ├── schemas/
    │       │   └── media.ts         ·  zod schemas — validate EVERY request body
    │       └── __tests__/
    │           ├── presign.test.ts
    │           └── media.test.ts
    │
    └── web/                         ← the single-page frontend
        ├── Dockerfile               ·  build stage → nginx-unprivileged
        ├── nginx.conf               ·  listen 8080, no root, security headers
        ├── package.json
        ├── index.html
        └── src/
            ├── main.tsx
            ├── api.ts               ·  typed fetch wrapper
            └── components/
                ├── UploadDropzone.tsx
                ├── MediaTable.tsx   ·  the CRUD table
                ├── EditRowModal.tsx
                └── PlayerModal.tsx
```

### Why this shape

**Two Terraform roots, not one.** `terraform destroy` in `platform/` tears down ~$220/mo of
resources in one command while your uploaded files (S3, in `bootstrap`) and your images (ECR)
survive untouched. Learning to place resources on the correct side of a state boundary is a
genuinely valuable Terraform skill, and this project gives you a concrete reason to care.

**The data account has no Terraform at all.** You create the three DynamoDB tables and the one
cross-account IAM role by hand (Phase 2). That's a deliberate simplification — it avoids a second
provider profile, a second state file, and a cross-state dependency, for five resources you create
once and never change.

The trade-off is worth naming rather than pretending it doesn't exist: those five resources are now
**undocumented in code**, so if you rebuild the data account in six months you'll be
reverse-engineering it from the console. Mitigate it cheaply — put the exact `aws` CLI commands in
`scripts/create-dynamodb.sh` and `scripts/create-crossaccount-role.sh` and commit them. Not
Terraform, but reproducible and reviewable, which is 90% of the value.

**`platform/` consumes the manual resources as plain variables.** The role ARN and table names go
into `terraform.tfvars` as strings rather than coming from remote state. Simpler, and it makes the
boundary explicit: anything in tfvars is something a human created.

**`gitops/` is never applied by hand.** If you `kubectl apply` something in there, Argo CD will
either fight you or silently diverge. The whole point is that Git is the only input.

**`docs/decisions/`** — write these. Seven ADRs explaining why you chose nginx over ALB, why API
Gateway's payload limit killed proxy uploads, why Let's Encrypt gets imported into ACM. In six
months they'll be the most valuable files in the repo, and writing them is how you find out whether
you actually understood the decision.

---

## 5. The Application: MediaVault

### The idea

A single-page app for uploading and managing audio/video files. One screen, four regions:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  MediaVault                                        <DOMAIN>              │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │   ⬆   Drop an audio or video file here, or click to browse      │    │
│   │       mp4 · webm · mp3 · wav · ogg     ·     max 200 MB         │    │
│   │       ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  64%  uploading sample.mp4       │    │
│   └────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│   [ All ▾ ] [ Video ] [ Audio ]      🔍 search title…      24 items      │
│                                                                          │
│   ┌──────┬────────────────────┬───────┬─────────┬──────────┬─────────┐  │
│   │ TYPE │ TITLE              │  SIZE │ LENGTH  │ UPLOADED │ ACTIONS │  │
│   ├──────┼────────────────────┼───────┼─────────┼──────────┼─────────┤  │
│   │  🎬  │ Team standup       │ 42 MB │  4:12   │ 2h ago   │ ▶ ✎ 🗑  │  │
│   │  🎵  │ Podcast ep. 12     │  8 MB │ 31:07   │ 1d ago   │ ▶ ✎ 🗑  │  │
│   │  🎬  │ Demo recording     │120 MB │ 12:44   │ 3d ago   │ ▶ ✎ 🗑  │  │
│   └──────┴────────────────────┴───────┴─────────┴──────────┴─────────┘  │
│                                          ‹ prev   page 1 of 3   next ›   │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Dropzone** — pick a file, watch a real progress bar, see it land in the table
- **Filter bar** — filter by type, search by title, item count
- **Table** — the CRUD surface. Every row exercises a different API call
- **Modals** — ▶ plays inline from a presigned GET; ✎ edits title/description; 🗑 deletes

That's it. Small enough to finish, real enough that every piece of the platform gets exercised: the
upload path proves S3 + presigning, the table proves DynamoDB queries and pagination, the player
proves presigned reads, and delete proves you can keep two datastores consistent.

### The lifecycle of one upload

A media item moves through a small state machine. Getting this right is what separates a demo that
works from one that leaks orphaned objects.

```
   (no record)
        │
        │  POST /api/uploads/presign
        │  → API writes an UPLOAD TICKET to mediavault-<ENV>-uploads
        │    (uploadId, s3Key it chose, contentType, maxBytes, expiresAt+TTL)
        │  → API returns { uploadId, uploadUrl, key }
        ▼
   ┌─────────┐
   │ PENDING │  no item row exists yet — nothing shows in the table
   └────┬────┘
        │  browser PUTs bytes directly to S3
        │
        │  POST /api/media { uploadId, title, description }
        │  → API loads the ticket by uploadId  (has it expired? already consumed?)
        │  → API calls S3 HeadObject on the key FROM THE TICKET, not from the client
        │  → verifies size ≤ maxBytes and contentType matches
        │  → writes the item, marks the ticket consumed
        ▼
   ┌─────────┐          ┌────────┐
   │  READY  │          │ FAILED │ ← ticket expired, object missing, or size/type mismatch
   └────┬────┘          └────────┘
        │
        │  GET /api/media/:id  → presigned GET URL, 15 min
        │  PUT /api/media/:id  → update title/description
        │  DELETE /api/media/:id → delete S3 object, THEN delete the item
        ▼
   (gone)
```

**The upload ticket is a security control, not bookkeeping.** Without it, a client calls
`POST /api/media` with any `s3Key` it likes — including one belonging to another user. Because the
server issued the key and stored it under `uploadId`, the client never gets to choose. The
`HeadObject` check then confirms the object really exists and matches what was promised. Both
checks, not either.

The TTL on the tickets table is DynamoDB doing your garbage collection for free: abandoned uploads
evaporate after an hour with no cron job and no cost.

### API contract

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/uploads/presign` | `{filename, contentType, sizeBytes}` → `{uploadId, uploadUrl, key, expiresIn}` |
| `POST` | `/api/media` | `{uploadId, title, description}` → creates the item after verification |
| `GET` | `/api/media?type=&q=&cursor=&limit=` | List for the table. Returns `{items, nextCursor}` |
| `GET` | `/api/media/:id` | One item + a presigned GET URL for playback |
| `PUT` | `/api/media/:id` | Update `title` / `description` |
| `DELETE` | `/api/media/:id` | Delete the S3 object **then** the DynamoDB item |
| `GET` | `/healthz` | Liveness — process alive. **No dependency checks.** |
| `GET` | `/readyz` | Readiness — can reach DynamoDB and holds valid credentials |

**Liveness vs. readiness causes real outages.** If `/healthz` checks DynamoDB and there's a
30-second blip, the kubelet **kills every pod simultaneously**, turning a brief dependency hiccup
into a full outage plus a thundering-herd reconnect. Liveness answers "is this process wedged?"
(restart fixes it). Readiness answers "should I get traffic right now?" (remove from endpoints,
don't restart). Dependency checks belong in readiness only.

**Pagination is cursor-based, not page-numbered.** DynamoDB has no `OFFSET`. A `Query` returns a
`LastEvaluatedKey`; you base64-encode it and hand it back as `nextCursor`. This is not a limitation
to work around — offset pagination is O(n) and gets slower the deeper you go, while cursor
pagination is O(1) at any depth. The UI shows prev/next, not page numbers.

### Environment variables (`.env.example`)

Config comes from a ConfigMap; only genuine secrets come from ESO. Table names are **never**
hardcoded — that's how you get a dev app writing to prod tables.

```bash
NODE_ENV=production
PORT=8080
LOG_LEVEL=info

AWS_REGION=<REGION>

# S3 (app account)
MEDIA_BUCKET=<MEDIA_BUCKET>
UPLOAD_PREFIX=uploads/
# NOTE: no UPLOAD_MODE. API Gateway's 10 MB payload limit means presigned is
# the only workable path — there is no second mode to switch to. See §3.2.
PRESIGN_PUT_TTL_SECONDS=300
PRESIGN_GET_TTL_SECONDS=900
MAX_UPLOAD_BYTES=209715200            # 200 MB
ALLOWED_CONTENT_TYPES=video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg

# DynamoDB (DATA account, reached by assuming a role)
DDB_ROLE_ARN=arn:aws:iam::<DATA_ACCOUNT_ID>:role/mediavault-<ENV>-dynamodb-access
DDB_ROLE_SESSION_NAME=mediavault-api
TABLE_ITEMS=mediavault-<ENV>-items
TABLE_UPLOADS=mediavault-<ENV>-uploads
TABLE_AUDIT=mediavault-<ENV>-audit
GSI_FEED=gsi1-feed
GSI_TYPE=gsi2-type

# CORS is handled by API Gateway ONLY. If the app also emits these headers the
# browser sees duplicates and rejects the response. Leave app-level CORS OFF.
CORS_ENABLED=false

# Rate limiting also moves to API Gateway (per-route throttling). Keep this as a
# cheap second layer only if you want defence in depth.
RATE_LIMIT_PRESIGN_PER_MIN=10
```

And in the **frontend** build, the API now lives on a different origin:

```bash
# app/web  — baked in at build time
VITE_API_BASE_URL=https://api.<DOMAIN>        # Path 1 (custom domain)
# VITE_API_BASE_URL=https://<id>.execute-api.<REGION>.amazonaws.com   # Path 2
```

### Non-negotiable application security rules

Each of these is a real vulnerability if skipped:

1. **Allowlist content types** server-side. Never reflect a client-supplied `Content-Type` into a
   presigned URL unchecked.
2. **Enforce max size at signing time.** For presigned `PUT`, sign `Content-Length` as a required
   header; for presigned `POST`, use a `content-length-range` policy. Otherwise "presigned upload
   URL" means "free unlimited storage for anyone who gets this link."
3. **Never use the client filename as the S3 key.** Generate `uploads/<yyyy>/<mm>/<uuid>.<ext>`.
   Client filenames enable path traversal, key collisions, and unicode attacks. Store the original
   name as metadata only.
4. **Short presign expiry.** 300s upload, 900s playback. A presigned URL is a bearer token.
5. **Validate every request body** with a schema (zod/pydantic). A malformed `:id` is a 400, not a
   500 with a stack trace.
6. **Never build a DynamoDB expression by string concatenation.** Use
   `ExpressionAttributeNames`/`Values`. Injection is less famous in DynamoDB than SQL but a
   `FilterExpression` built from user input is still a bug.
7. **Escape output in the table.** `title` renders in HTML — use React's default escaping, never
   `innerHTML`.
8. **Rate-limit `/uploads/presign`.** It's the endpoint that creates capacity to consume.
9. **CORS: your origin only**, never `*`.
10. **Structured JSON logs; never log presigned URLs or credentials.** A presigned URL in a log
    aggregator is a credential in a log aggregator.

---

## 6. DynamoDB Data Model — Build These First

Read [§3.7](#37-dynamodb-over-a-relational-database) if you skipped it. **In DynamoDB the keys and
indexes are the query plan.** You cannot add an access pattern later without a migration, so the
model comes before the infrastructure. This section gives you everything you need to create the
tables in the data account today.

### Step 1 — Enumerate access patterns

This table is the actual design artifact. Everything below is derived from it.

| # | Access pattern | Table / Index | Key condition |
|---|---|---|---|
| 1 | Get one item by id | `items` (base) | `mediaId = :id` |
| 2 | List all ready items, newest first, paginated | `items` / **GSI1** | `gsi1pk = "FEED#ready"`, scan-forward false |
| 3 | List by type (video/audio), newest first | `items` / **GSI2** | `gsi2pk = "TYPE#video"`, scan-forward false |
| 4 | Create / update / delete an item | `items` (base) | `mediaId = :id` |
| 5 | Look up an issued upload ticket | `uploads` (base) | `uploadId = :uid` |
| 6 | Auto-expire abandoned tickets | `uploads` TTL | `expiresAt` (epoch seconds) |
| 7 | Read the audit trail for one item, chronological | `audit` (base) | `entityId = :eid`, `eventAt` between |
| 8 | Auto-expire old audit events | `audit` TTL | `ttl` |

Note what is **absent**: full-text search on `title`. DynamoDB cannot do that efficiently. The
search box filters the current page client-side; that's honest for a demo. Real search means
OpenSearch or a `FilterExpression` (which reads everything and *then* filters — you pay for the
full scan). Knowing which problems DynamoDB refuses to solve is part of learning it.

### Step 2 — The three tables

All tables: `BillingMode = PAY_PER_REQUEST`, encryption at rest with the AWS-owned key (free,
default), PITR **off** (it bills by size — turn it on in production), and tags
`app=mediavault env=<ENV> managed-by=manual`.

> **These are created by hand**, not Terraform — your call, and a reasonable one for five resources
> you make once. Tag them `managed-by=manual` so future-you doesn't go looking for the Terraform
> that manages them and conclude it's been deleted.

---

#### Table 1 — `mediavault-<ENV>-items`

The main entity. Partition key only; two GSIs provide the listing views.

| Attribute | Type | Notes |
|---|---|---|
| `mediaId` | S | **Partition key.** UUIDv4 |
| `title` | S | User-supplied. Validated, length-capped, escaped on render |
| `description` | S | Optional |
| `s3Key` | S | `uploads/2026/07/<uuid>.mp4` — server-generated, never client-supplied |
| `contentType` | S | From the allowlist |
| `mediaType` | S | `video` \| `audio` — derived from contentType |
| `sizeBytes` | N | Verified against S3 `HeadObject` |
| `durationSec` | N | Optional; probed client-side or left 0 |
| `status` | S | `pending` \| `ready` \| `failed` |
| `ownerId` | S | `anonymous` for now; the seam for real auth later |
| `createdAt` | S | ISO-8601 UTC — **sorts lexicographically = chronologically** |
| `updatedAt` | S | ISO-8601 UTC |
| `gsi1pk` | S | `FEED#<status>` — e.g. `FEED#ready` |
| `gsi1sk` | S | copy of `createdAt` |
| `gsi2pk` | S | `TYPE#<mediaType>` — e.g. `TYPE#video` |
| `gsi2sk` | S | copy of `createdAt` |

**GSI1 `gsi1-feed`** — PK `gsi1pk`, SK `gsi1sk`. Serves access pattern 2 (the default table view).
**GSI2 `gsi2-type`** — PK `gsi2pk`, SK `gsi2sk`. Serves access pattern 3 (the type filter).

**Projection: `INCLUDE`, not `ALL`.** Project exactly the columns the table renders —
`title, mediaType, sizeBytes, durationSec, status, createdAt`. `ALL` copies every attribute into
every index, so you pay for the same data three times in storage *and* in write units on every
update. `KEYS_ONLY` would be cheapest but forces a second `GetItem` per row to render the table.
`INCLUDE` is the right middle. This choice is one of the highest-leverage cost decisions in
DynamoDB and it's invisible until the bill arrives.

> **The hot-partition caveat, stated honestly.** `gsi1pk = "FEED#ready"` means every ready item
> shares one partition key. At demo scale that's completely fine. At real scale it's a hot
> partition, and the standard fix is **write sharding**: use `FEED#ready#<0-9>` with a random
> suffix on write, then query all 10 shards in parallel and merge. Don't build that now — but know
> that "list everything, newest first" is genuinely awkward in DynamoDB, and that awkwardness is
> the price of its scaling guarantees.

---

#### Table 2 — `mediavault-<ENV>-uploads`

Short-lived upload tickets. This is the table that makes the upload flow safe.

| Attribute | Type | Notes |
|---|---|---|
| `uploadId` | S | **Partition key.** UUIDv4, returned to the client |
| `s3Key` | S | The key **the server chose**. The client never sends a key |
| `contentType` | S | What was signed |
| `maxBytes` | N | What was signed |
| `ownerId` | S | |
| `issuedAt` | S | ISO-8601 |
| `expiresAt` | N | **TTL attribute.** Epoch *seconds* |
| `consumed` | BOOL | Set true on confirm — makes a ticket single-use |

**TTL on `expiresAt`.** DynamoDB deletes expired items automatically, at no cost, with no cron job.
Two things to know: deletion is **not instant** (typically within 48 hours), so your code must still
check `expiresAt` itself rather than trusting absence; and the TTL attribute must be a **Number
holding epoch seconds** — an ISO string or milliseconds silently never expires. That silent failure
is one of the most common DynamoDB mistakes.

---

#### Table 3 — `mediavault-<ENV>-audit`

Append-only event log. Teaches composite sort keys, and gives your Phase 14 security story real
substance.

| Attribute | Type | Notes |
|---|---|---|
| `entityId` | S | **Partition key.** `MEDIA#<mediaId>` |
| `eventAt` | S | **Sort key.** `<ISO-8601>#<ulid>` — timestamp sorts, ulid breaks ties |
| `action` | S | `UPLOAD_ISSUED` \| `UPLOAD_CONFIRMED` \| `UPDATE` \| `DELETE` |
| `actor` | S | `ownerId` |
| `sourceIp` | S | From `X-Forwarded-For` (works because nginx has `externalTrafficPolicy: Local`) |
| `detail` | M | Free-form map: what changed |
| `ttl` | N | Epoch seconds, +30 days |

The composite key means `Query(entityId = "MEDIA#abc", eventAt BETWEEN x AND y)` gives you one
item's history in chronological order in a single request. That's the pattern worth internalizing:
in DynamoDB, **the sort key is how you model one-to-many**.

### Step 3 — Create them manually

Save this as `scripts/create-dynamodb.sh` and commit it. It isn't Terraform, but it *is*
reproducible and reviewable, which is most of what Terraform was giving you for five static
resources.

**Only key and index attributes get declared.** DynamoDB is schemaless for everything else — you do
not declare `title` or `sizeBytes` anywhere. Declaring a non-key attribute is an error.

```bash
#!/usr/bin/env bash
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-mv-data}"
ENV="${ENV:-dev}"
REGION="${REGION:-ap-south-1}"
TAGS="Key=app,Value=mediavault Key=env,Value=$ENV Key=managed-by,Value=manual"
PROJ="title,mediaType,sizeBytes,durationSec,status,createdAt"

echo "Creating tables in account $(aws sts get-caller-identity --query Account --output text)"

# ── Table 1: items ──────────────────────────────────────────────────────────
aws dynamodb create-table \
  --region "$REGION" \
  --table-name "mediavault-$ENV-items" \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=mediaId,AttributeType=S \
      AttributeName=gsi1pk,AttributeType=S \
      AttributeName=gsi1sk,AttributeType=S \
      AttributeName=gsi2pk,AttributeType=S \
      AttributeName=gsi2sk,AttributeType=S \
  --key-schema AttributeName=mediaId,KeyType=HASH \
  --global-secondary-indexes "[
    {\"IndexName\":\"gsi1-feed\",
     \"KeySchema\":[{\"AttributeName\":\"gsi1pk\",\"KeyType\":\"HASH\"},
                    {\"AttributeName\":\"gsi1sk\",\"KeyType\":\"RANGE\"}],
     \"Projection\":{\"ProjectionType\":\"INCLUDE\",
                     \"NonKeyAttributes\":[\"${PROJ//,/\",\"}\"]}},
    {\"IndexName\":\"gsi2-type\",
     \"KeySchema\":[{\"AttributeName\":\"gsi2pk\",\"KeyType\":\"HASH\"},
                    {\"AttributeName\":\"gsi2sk\",\"KeyType\":\"RANGE\"}],
     \"Projection\":{\"ProjectionType\":\"INCLUDE\",
                     \"NonKeyAttributes\":[\"${PROJ//,/\",\"}\"]}}
  ]" \
  --sse-specification Enabled=true \
  --tags $TAGS

# ── Table 2: uploads (TTL) ──────────────────────────────────────────────────
aws dynamodb create-table \
  --region "$REGION" \
  --table-name "mediavault-$ENV-uploads" \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=uploadId,AttributeType=S \
  --key-schema AttributeName=uploadId,KeyType=HASH \
  --sse-specification Enabled=true \
  --tags $TAGS

# ── Table 3: audit (composite key + TTL) ────────────────────────────────────
aws dynamodb create-table \
  --region "$REGION" \
  --table-name "mediavault-$ENV-audit" \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=entityId,AttributeType=S \
      AttributeName=eventAt,AttributeType=S \
  --key-schema \
      AttributeName=entityId,KeyType=HASH \
      AttributeName=eventAt,KeyType=RANGE \
  --sse-specification Enabled=true \
  --tags $TAGS

# TTL can only be set AFTER the table is ACTIVE — wait, don't guess.
for t in uploads audit; do
  aws dynamodb wait table-exists --region "$REGION" --table-name "mediavault-$ENV-$t"
done

aws dynamodb update-time-to-live --region "$REGION" \
  --table-name "mediavault-$ENV-uploads" \
  --time-to-live-specification "Enabled=true,AttributeName=expiresAt"

aws dynamodb update-time-to-live --region "$REGION" \
  --table-name "mediavault-$ENV-audit" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl"

echo "Done. Record these names for terraform/platform/terraform.tfvars:"
echo "  mediavault-$ENV-items / -uploads / -audit"
```

### Verify

```bash
export AWS_PROFILE=mv-data
aws dynamodb list-tables

aws dynamodb describe-table --table-name mediavault-dev-items \
  --query 'Table.{billing:BillingModeSummary.BillingMode,
                  keys:KeySchema[].AttributeName,
                  gsis:GlobalSecondaryIndexes[].{n:IndexName,s:IndexStatus,p:Projection.ProjectionType}}'

aws dynamodb describe-time-to-live --table-name mediavault-dev-uploads
aws dynamodb describe-time-to-live --table-name mediavault-dev-audit
```

Required: `BillingMode = PAY_PER_REQUEST`; both GSIs `ACTIVE` with `ProjectionType = INCLUDE`; TTL
`ENABLED` on both `uploads` and `audit`.

**GSIs must be `ACTIVE`, not `CREATING`, before the app can query them.** On an empty table that's
seconds, but it isn't instant — and a query against a `CREATING` index fails in a way that looks
like a permissions problem.

### Gotchas for the manual path

- **`update-time-to-live` fails if the table isn't `ACTIVE` yet.** Hence the `wait table-exists`.
  Running the commands one at a time by hand, you'll usually be fine; in a script you will not be.
- **TTL attribute must be a Number holding epoch *seconds*.** Nothing validates this. An ISO string
  or milliseconds means items silently never expire, and you find out months later from the bill.
- **Getting a GSI wrong means recreating it.** You can add and delete GSIs on a live table, but you
  cannot change an existing one's keys. Check the projection and key schema before you move on.
- **Write down the exact table names now** — they go into `terraform/platform/terraform.tfvars` and
  into the app's ConfigMap. A typo surfaces as `ResourceNotFoundException` at runtime.

---

# Phase 0 — Prerequisites & Guardrails

### Concept

Everything here makes the next 15 phases *reversible and observable*. Skipping this phase is how
learning projects become billing incidents.

### Build

1. **Two AWS accounts, two profiles.** The app account needs a Route 53 public hosted zone for
   `<DOMAIN>`. The data account needs nothing but the ability to create DynamoDB tables and an IAM
   role.
   ```bash
   aws configure --profile mv-app
   aws configure --profile mv-data
   export AWS_PROFILE=mv-app
   aws sts get-caller-identity
   aws route53 list-hosted-zones --query 'HostedZones[?Name==`<DOMAIN>.`].[Id,Name]' --output text
   ```
   Record both account IDs and the hosted zone ID. They go in `terraform.tfvars`, never in Git.

2. **Tooling.** You need `terraform` (≥1.10 for S3 native locking), `kubectl`, `helm`, `aws` v2,
   `jq`, `docker`, and:
   ```bash
   curl -sSL -o argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
   sudo install -m 555 argocd /usr/local/bin/argocd && rm argocd
   ```
   `k9s` is optional and will save you hours. You do **not** need `eksctl` — Terraform covers it.

3. **Create the repo skeleton** from [§4](#4-repository-layout). Write `.gitignore` **first**:
   ```
   *.tfstate
   *.tfstate.*
   .terraform/
   *.tfvars
   !*.tfvars.example
   .env
   kubeconfig*
   *.pem
   deploy_key*
   ```

4. **Git remote.** Argo CD pulls from here. A private repo is fine — you'll add a read-only deploy
   key in Phase 6.

5. **Note your public IP** for the EKS API allowlist: `curl -s https://checkip.amazonaws.com`

### Verify

```bash
for p in mv-app mv-data; do echo -n "$p: "; aws sts get-caller-identity --profile $p --query Account --output text; done
terraform version && kubectl version --client && helm version --short && argocd version --client
```

Two different account IDs. If they're the same, you haven't actually set up two accounts.

### Gotchas

- **Your ISP gives you a dynamic IP.** When `kubectl` times out tomorrow morning, this is why.
  Re-run `checkip`, update the variable, apply.
- Never put credentials in `.tf` files. Profiles and env vars only.
- Write `.gitignore` before your first `apply`, not after. Recovering a leaked state file from Git
  history is miserable.

---

# Phase 1 — Terraform Bootstrap

### Concept

**Remote state.** Terraform records what it created in a state file. Locally that's a single point
of failure. The standard fix is an S3 backend. You used to need a DynamoDB table for locking;
modern Terraform supports **S3-native locking** via `use_lockfile = true`, so no lock table.

The chicken-and-egg: the bucket holding state can't itself be in remote state initially. So
`bootstrap/` uses **local** state, creates the bucket, and is applied once and never destroyed.

**S3 security baseline** — four independent controls, all of them:
- *Block Public Access* — an override making public ACLs and policies ineffective regardless of
  what anyone writes later. Your seatbelt.
- *Default encryption* — SSE-S3 (AES256) is free and sufficient. SSE-KMS with a customer key costs
  ~$1/mo plus per-request charges; in production use it with a **bucket key** to cut KMS request
  costs ~99%.
- *Versioning* — protects against overwrite/delete. Pair with a lifecycle rule expiring noncurrent
  versions, or you pay to store every mistake forever.
- *Bucket policy* — deny anything that isn't TLS.

**ECR.** `scan_on_push` (free basic CVE scanning) and `image_tag_mutability = IMMUTABLE` so nobody
can silently re-point `:v1.2.3` at different bytes — a real supply-chain control.

### Build

In `terraform/bootstrap/` (profile `mv-app`):

- State bucket: versioning, SSE-S3, BPA, TLS-only policy.
- Media bucket: same baseline **plus**
  - CORS allowing `PUT`, `GET`, `HEAD` from `https://app.<DOMAIN>` with `ExposeHeaders: ["ETag"]`
    (multipart needs ETag readable from JS),
  - lifecycle: expire `uploads/` objects after 30 days, **abort incomplete multipart uploads after
    7 days**, expire noncurrent versions after 7 days.
- Two ECR repos (`mediavault-api`, `mediavault-web`) + lifecycle policies keeping the last 10 images.
- `aws_budgets_budget` at $75/mo with email notification, plus a forecasted alert at 80%.
- Outputs: bucket names, ECR URLs.

### Verify

```bash
cd terraform/bootstrap && terraform init && terraform apply
aws s3api get-public-access-block --bucket <MEDIA_BUCKET>
aws s3api get-bucket-encryption   --bucket <MEDIA_BUCKET>
aws s3api get-bucket-lifecycle-configuration --bucket <MEDIA_BUCKET>
```

All four BPA flags `true`, and an `AbortIncompleteMultipartUpload` rule present.

### Gotchas

- S3 bucket names are **globally unique**. Use a random suffix.
- **`abort_incomplete_multipart_upload` is the most commonly forgotten S3 cost leak.** Failed
  uploads leave orphaned parts you're billed for and that don't appear in a normal object listing.
- Don't commit `bootstrap/terraform.tfstate`.

---

# Phase 2 — Data Account (manual)

### Concept

This is the phase that replaces MongoDB Atlas and VPC peering. Re-read
[§3.6](#36-cross-account-dynamodb-iam-not-peering) — the whole cross-account story is IAM, and it
has exactly two pieces.

**Piece 1: a role in the data account.** Its *trust policy* says who may assume it. Its *permission
policy* says what they can do once they have.

**Piece 2: permission in the app account** for the app's IRSA role to call `sts:AssumeRole` on it.

Both sides are required. This is the part people get wrong: granting only one side produces
`AccessDenied` with no indication which half is missing. IAM cross-account access is a **handshake** —
the resource account must offer, and the principal account must be allowed to accept.

**Pin the exact role ARN in the trust policy.** Writing `"AWS": "arn:aws:iam::<APP_ACCOUNT_ID>:root"`
trusts *every principal in the entire app account* — every user, every role, every Lambda. It is
technically "cross-account access working" and it is far too broad. Name the one role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<APP_ACCOUNT_ID>:role/mediavault-<ENV>-api" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "sts:ExternalId": "<random-string-you-generate>" }
    }
  }]
}
```

**On `ExternalId`:** its canonical purpose is preventing the *confused deputy* problem when a
third party assumes a role on your behalf. Between two accounts you control it adds little — the
pinned role ARN is the stronger control. Include it anyway: it's free, it's the habit you want when
you *do* integrate a third party, and it makes the trust relationship explicit rather than ambient.

**The ordering problem, and why it's fine.** This trust policy names the app-account role
`mediavault-<ENV>-api`, which doesn't exist yet — you create it in Phase 5. That's not a problem,
because **IAM lets you write a trust policy naming a principal that doesn't exist yet.** Role ARNs
are deterministic: `arn:aws:iam::<APP_ACCOUNT_ID>:role/<name>`. Just make sure Phase 5 creates the
role with that **exact fixed name**.

> ⚠️ In Terraform, use `name = "mediavault-dev-api"`, **not** `name_prefix`. `name_prefix` appends a
> random suffix, producing an ARN that won't match what you typed here, and the failure appears much
> later as an unexplained `AccessDenied`.

### Build — all by hand, with `<DATA_PROFILE>`

**1. Create the three DynamoDB tables** using `scripts/create-dynamodb.sh` from
[§6 Step 3](#step-3--create-them-manually).

**2. Generate and save an ExternalId:**
```bash
openssl rand -hex 16        # save this — you need it twice
```

**3. Create the cross-account role.** Save as `scripts/create-crossaccount-role.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-mv-data}"
ENV="${ENV:-dev}"
REGION="${REGION:-ap-south-1}"
APP_ACCOUNT_ID="${APP_ACCOUNT_ID:?set APP_ACCOUNT_ID}"
EXTERNAL_ID="${EXTERNAL_ID:?set EXTERNAL_ID}"
DATA_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE="mediavault-$ENV-dynamodb-access"

cat > /tmp/trust.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::${APP_ACCOUNT_ID}:role/mediavault-${ENV}-api" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "${EXTERNAL_ID}" } }
  }]
}
JSON

T="arn:aws:dynamodb:${REGION}:${DATA_ACCOUNT_ID}:table/mediavault-${ENV}"
cat > /tmp/perms.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem"
    ],
    "Resource": [
      "${T}-items",
      "${T}-items/index/*",
      "${T}-uploads",
      "${T}-audit"
    ]
  }]
}
JSON

aws iam create-role --role-name "$ROLE" \
  --assume-role-policy-document file:///tmp/trust.json \
  --max-session-duration 3600 \
  --tags Key=app,Value=mediavault Key=env,Value=$ENV Key=managed-by,Value=manual

aws iam put-role-policy --role-name "$ROLE" \
  --policy-name dynamodb-access \
  --policy-document file:///tmp/perms.json

rm -f /tmp/trust.json /tmp/perms.json
echo "Role ARN (put in terraform/platform/terraform.tfvars):"
echo "  arn:aws:iam::${DATA_ACCOUNT_ID}:role/${ROLE}"
```

**Note what the permission policy omits:** no `dynamodb:Scan` (forcing you to use the indexes you
designed), no `DeleteTable`, no `UpdateTable`, no `*`. And the `/index/*` ARN is listed
**separately** — querying a GSI is *not* covered by the table ARN alone. Forgetting it is the single
most common failure in this phase.

**4. Record these four values.** They become `terraform.tfvars` inputs in `platform/` and ConfigMap
entries for the app. Store the ExternalId in SSM (Phase 11), not in tfvars:

```hcl
ddb_role_arn      = "arn:aws:iam::<DATA_ACCOUNT_ID>:role/mediavault-dev-dynamodb-access"
ddb_table_items   = "mediavault-dev-items"
ddb_table_uploads = "mediavault-dev-uploads"
ddb_table_audit   = "mediavault-dev-audit"
```

### Verify

```bash
export AWS_PROFILE=mv-data
aws dynamodb list-tables
aws iam get-role --role-name mediavault-dev-dynamodb-access --query 'Role.AssumeRolePolicyDocument'
aws iam get-role-policy --role-name mediavault-dev-dynamodb-access --policy-name dynamodb-access
```

Confirm the trust policy names a **specific role ARN**, not `:root`, and that the permission policy
includes the `/index/*` resource. You can't fully test assumption until Phase 5 creates the app-side
role — that's expected and fine.

### Gotchas

- **Forgetting `/index/*`** → `GetItem` works, the list view returns `AccessDenied`. Symptom reads
  as "get by id works, listing is broken."
- **Fixed role name in Phase 5.** `name_prefix` breaks the ARN you just hardcoded.
- **Trusting `:root`** "just to get it working" is the most common cross-account shortcut and the one
  that shows up in audits. Don't start there — you rarely go back.
- **Nothing else belongs in this account.** No VPC, no subnets, no endpoints. If you find yourself
  creating a VPC here, stop and re-read [§3.6](#36-cross-account-dynamodb-iam-not-peering).
- **Since this is manual, it's invisible to `terraform plan`.** Nothing will warn you if someone
  edits the role in the console. Commit the scripts, and re-run the `Verify` block if cross-account
  access ever breaks mysteriously.

---

# Phase 3 — Network

### Concept

**Subnet tiers.** Public subnets route `0.0.0.0/0 → Internet Gateway`. Private subnets route
`0.0.0.0/0 → NAT Gateway` (which sits in a public subnet). Instances in private subnets reach out;
nothing reaches in. Worker nodes go here.

**Why NAT at all?** Nodes pull images from ECR and Docker Hub, reach the EKS API, call
`sts.<REGION>.amazonaws.com` (for both IRSA and your cross-account hop), and cert-manager talks to
Let's Encrypt — which is on the public internet with **no VPC endpoint in existence**. One NAT
Gateway is the pragmatic answer; replacing it with interface endpoints costs ~2.5× more and still
wouldn't cover ACME.

**Gateway endpoints — the two you want, both free.** Unlike interface endpoints (ENIs with private
IPs, billed hourly per AZ), a gateway endpoint is a **route table entry**. AWS injects a route whose
destination is a **managed prefix list** for the service and whose target is the endpoint. Only two
services support this type: **S3** and **DynamoDB**. You need exactly both.

Three things this buys you:
1. **Free.** No hourly charge, no data processing charge.
2. **Bypasses NAT data charges** — every byte to S3/DynamoDB would otherwise cost $0.056/GB.
3. **Enables `aws:sourceVpce` conditions** in IAM and resource policies.

**Endpoint policies.** Each gateway endpoint has its own resource policy, evaluated *in addition to*
IAM. Default is `*`.

> ⚠️ **If you restrict the S3 endpoint policy to only your media bucket, image pulls break.** ECR
> stores layers in AWS-owned S3 buckets reached through your gateway endpoint. You must allowlist
> `arn:aws:s3:::prod-<REGION>-starport-layer-bucket/*` or leave the policy permissive and enforce at
> the bucket policy instead. Classic "cluster mysteriously can't pull images" incident.

For the **DynamoDB** endpoint policy, scope it to the data account's tables:
`arn:aws:dynamodb:<REGION>:<DATA_ACCOUNT_ID>:table/mediavault-<ENV>-*`. This is a genuinely useful
control — it means even a fully compromised pod with stolen credentials cannot reach *other*
DynamoDB tables through your VPC.

**Subnet tagging for EKS.** Kubernetes discovers subnets by tag:
- All: `kubernetes.io/cluster/<CLUSTER_NAME> = shared`
- Public: `kubernetes.io/role/elb = 1`
- Private: `kubernetes.io/role/internal-elb = 1`
- Private (Karpenter): `karpenter.sh/discovery = <CLUSTER_NAME>`

Without these, `Service type=LoadBalancer` lands in the wrong tier or fails, and Karpenter can't
find anywhere to launch nodes.

**CIDR sizing — decide now, you cannot resize later.**

| Network | CIDR |
|---|---|
| VPC | `10.0.0.0/16` |
| Private subnets | `10.0.0.0/19`, `10.0.32.0/19` (~8k IPs each) |
| Public subnets | `10.0.96.0/24`, `10.0.97.0/24` |

Give private subnets a **/19 each**. The AWS VPC CNI assigns a real VPC IP to *every pod*. A /24
gives ~250 IPs total and you **will** hit `InsufficientFreeAddressesInSubnet` the first time
Karpenter scales. This is the single most common EKS networking mistake.

### Build

`terraform/platform/vpc.tf` with `terraform-aws-modules/vpc/aws ~> 6.0`:
- `cidr = "10.0.0.0/16"`, 2 AZs, subnets as above
- `enable_nat_gateway = true`, **`single_nat_gateway = true`**
- `enable_dns_hostnames = true`, `enable_dns_support = true`
- Subnet tags exactly as listed

`terraform/platform/endpoints.tf` — your `gateway-endpoints` module creating:
- `aws_vpc_endpoint` for `com.amazonaws.<REGION>.s3`, type `Gateway`
- `aws_vpc_endpoint` for `com.amazonaws.<REGION>.dynamodb`, type `Gateway`
- both associated with the **private** route table IDs

Also configure the `platform` S3 backend pointing at the Phase 1 state bucket.

### Verify

```bash
terraform apply

aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=<vpc-id> \
  --query 'VpcEndpoints[].{svc:ServiceName,type:VpcEndpointType,rts:length(RouteTableIds)}' --output table

# the routes must actually be in the PRIVATE route tables
aws ec2 describe-route-tables --route-table-ids <private-rt-id> \
  --query 'RouteTables[].Routes[?DestinationPrefixListId!=null].[DestinationPrefixListId,GatewayId]' --output text
```

Two endpoints, each associated with 2 route tables, and two prefix-list routes targeting `vpce-*`.

### Gotchas

- Gateway endpoints attach to **route tables**, not subnets. Associate them with the public RT by
  mistake and your private nodes still go through NAT — you'll never notice except on the bill.
- Don't create a second NAT "for HA" while learning.
- The DynamoDB endpoint is **regional**. It cannot reach tables in another *region*. Another
  *account* in the same region is fine — that's the whole point of §3.6.

---

# Phase 4 — The EKS Cluster

### Concept

**What EKS gives you.** AWS runs `kube-apiserver`, `etcd`, `kube-scheduler`, and
`kube-controller-manager` in an AWS-owned account across 3 AZs, patched and backed up. You pay
$0.10/hr and never see those machines. You own the data plane.

**Access Entries — the modern authorization model.** For years EKS mapped IAM principals to
Kubernetes identities through a ConfigMap called `aws-auth`. It was infamous: no API, no validation,
one bad edit locked everyone out permanently. Module v20+ defaults to **Access Entries** — a real
AWS API where you map an IAM ARN to a principal and attach a scoped access policy.

Set `authentication_mode = "API"` and `enable_cluster_creator_admin_permissions = true`, or you'll
build a cluster you cannot log into.

**Managed node group vs. Karpenter.** Karpenter's controller pods must run *somewhere*, and they
can't schedule onto nodes Karpenter hasn't created. Classic bootstrap problem. Answer: a 2-node
managed group of `t3.medium` for system-critical workloads (Karpenter, CoreDNS, Argo CD), with
everything else on Karpenter spot nodes.

**AMI.** Amazon Linux 2 is end-of-life. Use **AL2023** (`AL2023_x86_64_STANDARD`) — `nodeadm` and
declarative `NodeConfig` instead of `bootstrap.sh`, faster boot, smaller attack surface.

**Addons:**

| Addon | Purpose | Note |
|---|---|---|
| `vpc-cni` | Pod IPs; **also implements NetworkPolicy** | Set `enableNetworkPolicy: "true"` — you need it in Phase 14 |
| `coredns` | Cluster DNS | |
| `kube-proxy` | Service routing | |
| `aws-ebs-csi-driver` | EBS PersistentVolumes | Kubecost's Prometheus needs it. Own IRSA role |
| `eks-pod-identity-agent` | Pod Identity broker | Install now even using IRSA — makes the Phase 14 migration trivial |

**Encryption & logging.** Enable **KMS envelope encryption of Kubernetes Secrets** — without it,
Secrets are base64 in etcd (encrypted at rest by AWS, but not with a key you control or can audit).
Enable `api`, `audit`, `authenticator` logs and **set CloudWatch retention to 7 days** in the same
Terraform.

### Build

`terraform/platform/eks.tf` with `terraform-aws-modules/eks/aws ~> 21.0`:

```
cluster_version                          = "1.33"    # verify with describe-cluster-versions
subnet_ids                               = private subnets
control_plane_subnet_ids                 = private subnets
cluster_endpoint_private_access          = true
cluster_endpoint_public_access           = true
cluster_endpoint_public_access_cidrs     = [var.my_ip_cidr]
authentication_mode                      = "API"
enable_cluster_creator_admin_permissions = true
cluster_encryption_config                = { resources = ["secrets"] }
cluster_enabled_log_types                = ["api", "audit", "authenticator"]
```

Managed node group `system`: `min=2 max=3 desired=2`, `t3.medium`, AL2023, private subnets, IMDSv2
required with `http_put_response_hop_limit = 1`. Tag private subnets and the node SG with
`karpenter.sh/discovery = <CLUSTER_NAME>` now.

### Verify

```bash
aws eks update-kubeconfig --name <CLUSTER_NAME> --region <REGION>
kubectl get nodes -o wide
kubectl get pods -A
aws eks list-access-entries --cluster-name <CLUSTER_NAME>
aws eks describe-addon --cluster-name <CLUSTER_NAME> --addon-name vpc-cni --query 'addon.configurationValues'
```

Nodes must show `EXTERNAL-IP: <none>` — that's your proof they're genuinely private.

### Gotchas

- **`hop_limit = 1` is a real security control.** IMDSv2 requires a PUT to get a token; the hop
  limit caps how far that response travels. At 1, a *pod* (one hop from the host netns) cannot reach
  IMDS and steal the **node's** IAM role. At 2, any compromised pod inherits full node permissions.
  Caveat: `hostNetwork: true` pods that legitimately need IMDS will break — rare, and usually a
  misconfigured chart.
- `Unauthorized` from kubectl → check `aws sts get-caller-identity` matches a principal in
  `list-access-entries`. Assuming a different role than the one that created the cluster is the
  usual cause.
- Cluster creation takes 10–14 minutes. Normal, not a hang.
- Don't set `endpoint_public_access = false` yet — that's a Phase 14 exercise once SSM works.

---

# Phase 5 — Identity

### Concept

Two hops. Understanding the boundary between them is the whole phase.

```
   ┌─ HOP 1: OIDC ─ inside the app account ────────────────────────────┐
   │  pod has a projected SA token (JWT, 1h, signed by the cluster)    │
   │  SDK calls sts:AssumeRoleWithWebIdentity                          │
   │  → temporary creds for  arn:...:<APP_ACCOUNT_ID>:role/...-api     │
   └───────────────────────────────────────────────────────────────────┘
                                  │
   ┌─ HOP 2: AssumeRole ─ crosses into the data account ───────────────┐
   │  SDK calls sts:AssumeRole with the hop-1 creds                    │
   │  → temporary creds for  arn:...:<DATA_ACCOUNT_ID>:role/...-ddb    │
   │  DynamoDB calls are signed with THESE                             │
   └───────────────────────────────────────────────────────────────────┘
```

**Hop 1 — IRSA.** EKS exposes an **OIDC discovery document** at a public HTTPS URL. You register it
as an IAM identity provider, so IAM will trust JWTs signed by your cluster. A pod whose SA is
annotated `eks.amazonaws.com/role-arn: ...` gets a projected token plus `AWS_ROLE_ARN` and
`AWS_WEB_IDENTITY_TOKEN_FILE` env vars injected by a mutating webhook. The SDK's default chain does
the rest. The role's trust policy checks two claims:

```json
"Condition": { "StringEquals": {
  "<oidc-url>:aud": "sts.amazonaws.com",
  "<oidc-url>:sub": "system:serviceaccount:media:mediavault-api"
}}
```

**That `sub` condition is the entire security boundary.** `system:serviceaccount:*:*` means every
pod in the cluster can assume the role. Pin namespace *and* SA name. Always.

**Hop 2 — cross-account AssumeRole.** The app-account role needs an *explicit* permission:

```json
{ "Effect": "Allow", "Action": "sts:AssumeRole",
  "Resource": "arn:aws:iam::<DATA_ACCOUNT_ID>:role/mediavault-<ENV>-dynamodb-access" }
```

**Cache the hop-2 credentials.** They last an hour. Calling `AssumeRole` per request is a latency
disaster and will hit STS rate limits. AWS SDK v3's `fromTemporaryCredentials` handles caching and
refresh automatically — use it, don't hand-roll:

```ts
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

// The base credential (hop 1) is resolved from the default chain = IRSA.
export const ddb = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: fromTemporaryCredentials({
    params: {
      RoleArn: process.env.DDB_ROLE_ARN,
      RoleSessionName: process.env.DDB_ROLE_SESSION_NAME,
      ExternalId: process.env.DDB_EXTERNAL_ID,
      DurationSeconds: 3600,
    },
  }),
});
```

Note what this client does **not** need: no access key, no secret, no connection string, no password
anywhere. Which is the point of the next observation.

> **DynamoDB + IAM eliminated your database secret entirely.** With MongoDB you'd have a connection
> string containing a password to store, rotate, inject, and keep out of logs. With IAM auth there
> is no credential to leak — authentication is the identity of the workload itself. This is the
> strongest argument for AWS-native datastores, and it's worth noticing that the most secure secret
> is the one that doesn't exist.

### Build

One narrowly-scoped role per workload in `terraform/platform/irsa.tf`, using
`terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks`:

| Role | ServiceAccount | Permissions |
|---|---|---|
| external-dns | `external-dns/external-dns` | `route53:ChangeResourceRecordSets` on **your zone ARN only**; `ListHostedZones`/`ListResourceRecordSets` on `*` |
| cert-manager | `cert-manager/cert-manager` | Same, plus `route53:GetChange` on `arn:aws:route53:::change/*` |
| ebs-csi | `kube-system/ebs-csi-controller-sa` | Module's `attach_ebs_csi_policy` |
| external-secrets | `external-secrets/external-secrets` | `ssm:GetParameter*` on `/mediavault/<ENV>/*`; `kms:Decrypt` |
| **mediavault-api** | `media/mediavault-api` | S3 + `sts:AssumeRole` — below |
| karpenter | `kube-system/karpenter` | Handled by the karpenter submodule in Phase 7 |

**The app role** (fixed `name = "mediavault-<ENV>-api"` — Phase 2's trust policy computed this ARN):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3ObjectRW",
      "Effect": "Allow",
      "Action": ["s3:PutObject","s3:GetObject","s3:DeleteObject","s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::<MEDIA_BUCKET>/uploads/*"
    },
    {
      "Sid": "S3ListOwnPrefixOnly",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<MEDIA_BUCKET>",
      "Condition": { "StringLike": { "s3:prefix": "uploads/*" } }
    },
    {
      "Sid": "AssumeDataAccountRole",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::<DATA_ACCOUNT_ID>:role/mediavault-<ENV>-dynamodb-access"
    }
  ]
}
```

Note the absences: no `s3:*`, no bucket-level `Delete*`, no `PutBucketPolicy`, objects scoped to a
**prefix**, and **no `dynamodb:*` at all** — the app account role has zero DynamoDB permissions of
its own. All database access flows through the assumed role. If the pod is compromised, the attacker
gets the media prefix and one narrowly-scoped role in another account.

### Verify

Hop 1 — prove the pod has the right identity:

```bash
kubectl -n media run awscli --rm -it --restart=Never \
  --overrides='{"spec":{"serviceAccountName":"mediavault-api"}}' \
  --image=amazon/aws-cli -- sts get-caller-identity
```

Must return `assumed-role/mediavault-dev-api/...`, **not** the node instance role.

Hop 2 — prove the cross-account handshake works:

```bash
kubectl -n media run awscli --rm -it --restart=Never \
  --overrides='{"spec":{"serviceAccountName":"mediavault-api"}}' \
  --image=amazon/aws-cli -- sts assume-role \
  --role-arn arn:aws:iam::<DATA_ACCOUNT_ID>:role/mediavault-dev-dynamodb-access \
  --role-session-name test --external-id <EXTERNAL_ID>
```

Then prove least privilege actually bites — **these failing is the point**:

```bash
... aws s3 ls s3://<MEDIA_BUCKET>/uploads/     # succeeds
... aws s3 ls s3://<MEDIA_BUCKET>/             # AccessDenied  ✅
... aws dynamodb list-tables                   # AccessDenied  ✅ (app role has no DDB perms)
```

### Gotchas

- `sub` is `system:serviceaccount:<namespace>:<sa-name>`. A typo produces an opaque `AccessDenied`
  with no hint which condition failed.
- The Helm chart must be told to *use* your ServiceAccount and not create an unannotated one. Every
  chart has `serviceAccount.create` / `.name` / `.annotations`.
- **Missing hop 2 permission** looks identical to a broken trust policy. Check both sides.
- `sts:AssumeRole` traffic goes through NAT (no gateway endpoint for STS). If NAT is broken,
  DynamoDB fails in a way that looks like a DynamoDB problem.
- Don't call `AssumeRole` per request. Use the SDK's caching provider.

---

# Phase 6 — Argo CD Bootstrap

### Concept

**GitOps:** Git is the source of truth for cluster state, and a controller inside the cluster
continuously reconciles reality toward it.

Argo CD's core object is an **Application**: a pointer to (repo, path, revision) plus a destination,
plus a sync policy. Its reconciler renders the source, diffs against live objects, applies the
difference.

Why this beats `helm install` by hand:
- **Auditability** — every change is a commit with an author and a diff
- **Drift detection** — someone `kubectl edit`s a Deployment; Argo shows OutOfSync and (with
  `selfHeal`) reverts it
- **Disaster recovery** — the cluster is disposable. Rebuild, point Argo at the repo, walk away.
  **This is what makes your nightly-destroy cost strategy viable.**

**App-of-apps.** Bootstrap exactly *one* Application — the root — whose source is `gitops/platform/`,
a directory of other Application manifests. One `helm_release` and one YAML file; everything else
cascades from Git.

**Sync waves.** Argo processes resources in ascending `argocd.argoproj.io/sync-wave` order, waiting
for each wave to go Healthy. You need this because a `ClusterIssuer` can't exist before cert-manager
installs its CRDs, and a Karpenter `NodePool` can't exist before the Karpenter chart installs
`karpenter.sh/v1`.

| Wave | Components |
|---|---|
| `-1` | Namespaces (carrying PSA labels) |
| `0` | karpenter, ingress-nginx, cert-manager, external-secrets — controllers + CRDs |
| `1` | NodePool/EC2NodeClass, ClusterIssuers, external-dns, ClusterSecretStore |
| `3` | kubecost |
| `5` | mediavault |

**AppProject.** Don't use `default` — it permits any source repo and any destination. Create a
project scoped to your one repo and your specific namespaces. It's five lines and it means a
compromised Git repo can't deploy into `kube-system`.

### Build

1. **Terraform installs Argo CD only** (`terraform/platform/argocd.tf`): `helm_release` for
   `argo-cd` from `https://argoproj.github.io/argo-helm`, namespace `argocd`. Leave
   `server.service.type` as ClusterIP — port-forward is safer than exposing it.
2. **Repo access** — an SSH keypair, public half as a GitHub **read-only deploy key**:
   ```bash
   ssh-keygen -t ed25519 -f deploy_key -N ""
   kubectl -n argocd create secret generic repo-mediavault \
     --from-literal=type=git \
     --from-literal=url=git@github.com:<you>/<repo>.git \
     --from-file=sshPrivateKey=./deploy_key
   kubectl -n argocd label secret repo-mediavault argocd.argoproj.io/secret-type=repository
   ```
   Read-only, single-repo. Never give Argo CD a write-scoped token.
3. **Root Application** (`gitops/bootstrap/root-app.yaml`):
   ```yaml
   apiVersion: argoproj.io/v1alpha1
   kind: Application
   metadata:
     name: root
     namespace: argocd
   spec:
     project: mediavault
     source:
       repoURL: git@github.com:<you>/<repo>.git
       targetRevision: main
       path: gitops/platform
     destination: { server: https://kubernetes.default.svc }
     syncPolicy:
       automated: { prune: true, selfHeal: true }
       syncOptions: [CreateNamespace=true]
   ```
4. **Get in and lock down:**
   ```bash
   kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
   kubectl -n argocd port-forward svc/argocd-server 8080:443
   ```
   **Change the admin password, then delete `argocd-initial-admin-secret`.**

### Verify

```bash
argocd app list && argocd app get root
kubectl -n argocd get applications
```

Root `Synced / Healthy`. Children appear as you add manifests.

### Gotchas

- **Don't expose the Argo CD UI publicly** while learning. Port-forward is free and safe.
- `selfHeal: true` will fight your `kubectl edit`. That's the feature working — disable auto-sync on
  that one app while debugging, not globally.
- `prune: true` deletes what you removed from Git. Correct, but understand it before deleting a
  directory.
- Argo polls every 3 minutes. `argocd app sync <name>` to force it, or add a webhook.

---

# Phase 7 — Karpenter

### Concept

**The problem with Cluster Autoscaler.** CA resizes pre-defined ASGs. You choose instance types up
front, every shape needs its own ASG, and scale-up takes 3–5 minutes.

**Karpenter** watches for **unschedulable pods**, reads their actual requirements (CPU, memory,
arch, zone, affinities, topology spread), and calls the EC2 **Fleet API** directly to launch the
cheapest instance that satisfies them — from *hundreds* of types simultaneously. No ASGs. Typical
time-to-ready: 40–60 seconds.

Then it does the thing that saves money: **consolidation**. It continuously re-evaluates whether the
current pods could fit on fewer or cheaper nodes, and if so cordons, drains, and replaces. A cluster
that burst to 5 nodes quietly shrinks back to 2.

**Two CRDs:**
- **`EC2NodeClass`** (`karpenter.k8s.aws/v1`) — the AWS-specific template: AMI family, subnet/SG
  selectors, instance profile, block devices, IMDS settings.
- **`NodePool`** (`karpenter.sh/v1`) — the Kubernetes-facing policy: which NodeClass, requirement
  constraints, taints, resource limits, disruption rules.

**Supporting AWS infrastructure** (the `terraform-aws-modules/eks/aws//modules/karpenter` submodule
creates all of it): a controller IAM role, a node IAM role + instance profile, and an **SQS queue**
subscribed to EventBridge rules for spot interruption, instance state-change, and rebalance
recommendations. When a 2-minute spot warning arrives, Karpenter cordons and drains *and launches a
replacement first*. **That queue is what makes spot safe to use.** Without it, instances just vanish.

### Build

Terraform (`karpenter.tf`): the karpenter submodule. Output the queue name, controller role ARN, and
node role name.

`gitops/platform/karpenter.yaml`, wave `0`, chart `oci://public.ecr.aws/karpenter/karpenter`:
```yaml
settings:
  clusterName: <CLUSTER_NAME>
  interruptionQueue: <queue-name>
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: <controller-role-arn>
controller:
  resources:
    requests: { cpu: 200m, memory: 512Mi }
    limits:   { memory: 512Mi }
tolerations:
  - key: CriticalAddonsOnly
    operator: Exists
```

`gitops/platform/karpenter-nodepool.yaml`, wave `1`:
```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata: { name: default }
spec:
  role: <node-iam-role-NAME>            # name, not ARN
  amiSelectorTerms: [{ alias: al2023@latest }]
  subnetSelectorTerms:        [{ tags: { "karpenter.sh/discovery": "<CLUSTER_NAME>" } }]
  securityGroupSelectorTerms: [{ tags: { "karpenter.sh/discovery": "<CLUSTER_NAME>" } }]
  metadataOptions:
    httpTokens: required                # IMDSv2 only
    httpPutResponseHopLimit: 1          # pods cannot reach IMDS
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs: { volumeSize: 30Gi, volumeType: gp3, encrypted: true, deleteOnTermination: true }
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata: { name: default }
spec:
  template:
    spec:
      nodeClassRef: { group: karpenter.k8s.aws, kind: EC2NodeClass, name: default }
      requirements:
        - { key: karpenter.sh/capacity-type, operator: In, values: ["spot"] }
        - { key: kubernetes.io/arch, operator: In, values: ["amd64"] }
        - { key: karpenter.k8s.aws/instance-category, operator: In, values: ["c","m","r"] }
        - { key: karpenter.k8s.aws/instance-generation, operator: Gt, values: ["2"] }
        - { key: karpenter.k8s.aws/instance-cpu, operator: Lt, values: ["9"] }
      expireAfter: 168h                 # weekly rotation = free patching
  limits:
    cpu: "16"                           # ← your real cost guardrail
    memory: 64Gi
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
    budgets: [{ nodes: "20%" }]
```

### Verify

```bash
kubectl -n kube-system logs -l app.kubernetes.io/name=karpenter -f
```
In another terminal:
```bash
kubectl create deployment inflate --image=public.ecr.aws/eks-distro/kubernetes/pause:3.7
kubectl set resources deployment inflate --requests=cpu=1
kubectl scale deployment inflate --replicas=8
kubectl get nodeclaims -w
```
Logs should show `found provisionable pod(s)` → `computed new nodeclaim(s)` → `launched nodeclaim`.
Then `kubectl delete deployment inflate` and watch consolidation reclaim them. Nodes appearing in
~50s and vanishing on their own is the moment Karpenter clicks.

### Gotchas

- **`limits.cpu` is not optional.** Without it, one runaway Deployment with a big CPU request makes
  Karpenter provision an enormous amount of EC2.
- `role` is the **name** of the node IAM role, not the ARN. Karpenter builds the instance profile.
- Missing `karpenter.sh/discovery` tags → `no subnets found` in logs and silent non-scaling.
- If that tag lands on **public** subnets you get nodes with public IPs — a security hole.
- Karpenter and Cluster Autoscaler must not both run.

---

# Phase 8 — Ingress

### Concept

An **Ingress** is just data. An **ingress controller** watches Ingress objects and configures a real
proxy. `ingress-nginx` runs NGINX pods templating `nginx.conf` from your Ingress objects; its
`type: LoadBalancer` Service makes the AWS cloud controller provision an **NLB**.

**Why NLB here:** it's **L4**, forwarding raw TCP, so TLS terminates at NGINX inside your cluster
using a Kubernetes Secret — which is what makes cert-manager useful (see [§3.1](#31-ingress-nginx--nlb-not-aws-load-balancer-controller--alb)).
With `target-type: ip` it sends traffic **directly to pod IPs**, skipping the kube-proxy hop.

**Client IP preservation.** `externalTrafficPolicy: Local` stops the node SNAT-ing inbound traffic,
so NGINX sees the real client IP. Needed for rate limiting, `X-Forwarded-For`, and your audit table's
`sourceIp` field.

### Two controllers, two NLBs

Because API Gateway fronts the API ([§3.8](#38-api-gateway-in-front-of-the-cluster)), you run **two
ingress-nginx controller instances** with distinct `IngressClass` names:

| Controller | IngressClass | NLB scheme | Serves | Reachable from |
|---|---|---|---|---|
| `ingress-nginx-public` | `nginx-public` | `internet-facing` | `app.<DOMAIN>` (web UI) | the internet |
| `ingress-nginx-internal` | `nginx-internal` | `internal` | the API | **only** the VPC Link |

The internal one is the security payoff: `mediavault-api` has no internet-facing path at all. Someone
who discovers your NLB hostname cannot reach it — it only has private IPs. All API traffic must pass
through API Gateway, so the throttling and logging you configure there can't be bypassed.

### Build

Two Argo Applications (or one chart installed twice with different release names), both wave `0`.

`gitops/platform/ingress-nginx.yaml` — **public**:
```yaml
controller:
  replicaCount: 2
  ingressClassResource:
    name: nginx-public
    controllerValue: "k8s.io/ingress-nginx-public"
  ingressClass: nginx-public
  service:
    type: LoadBalancer
    externalTrafficPolicy: Local
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "external"
      service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
      service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
  config:
    use-forwarded-headers: "true"
    proxy-body-size: "1m"          # web UI only — no large bodies ever transit here
    ssl-protocols: "TLSv1.2 TLSv1.3"
    hsts: "true"
    hsts-max-age: "31536000"
    server-tokens: "false"
  resources:
    requests: { cpu: 100m, memory: 128Mi }
```

`gitops/platform/ingress-nginx-internal.yaml` — **internal**, same chart, these overrides:
```yaml
controller:
  replicaCount: 2
  ingressClassResource:
    name: nginx-internal
    controllerValue: "k8s.io/ingress-nginx-internal"
  ingressClass: nginx-internal
  service:
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "external"
      service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
      service.beta.kubernetes.io/aws-load-balancer-scheme: "internal"   # ← the whole point
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
  config:
    use-forwarded-headers: "true"    # API GW sets X-Forwarded-For; you need it for audit sourceIp
    proxy-body-size: "1m"            # API GW caps at 10 MB anyway
    server-tokens: "false"
```

> `aws-load-balancer-type: "external"` requires the **AWS Load Balancer Controller** (wave 0, own
> IRSA role — add it to the Phase 5 table). Without it, drop the annotation and the in-tree provider
> handles it.

**Export the internal NLB ARN** — Phase 8B's VPC Link needs it.

### Verify

```bash
kubectl get ingressclass                       # nginx-public AND nginx-internal
kubectl get svc -A | grep LoadBalancer         # two NLB hostnames

PUB=$(kubectl -n ingress-nginx get svc ingress-nginx-public-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl -sI http://$PUB                           # 404 from nginx = alive

INT=$(kubectl -n ingress-nginx get svc ingress-nginx-internal-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl -sI --max-time 5 http://$INT              # MUST time out from your laptop ✅
```

**That timeout is the test passing.** The internal NLB resolves to private IPs and is unreachable
from outside the VPC. Confirm it works from *inside*:
```bash
kubectl run t --rm -it --restart=Never --image=curlimages/curl -- -sI --max-time 5 http://$INT
```

### Gotchas

- NLBs take 2–4 minutes to become healthy. Don't debug during that window.
- With `externalTrafficPolicy: Local`, only nodes running an nginx pod pass health checks.
- **Two controllers need two distinct `controllerValue`s.** Reuse the same string and both
  controllers claim every Ingress, and you get duplicate/flapping config with no clear error.
- **An Ingress with no `ingressClassName` may be picked up by whichever controller is default.**
  Set the class explicitly on every Ingress, and don't mark either controller as default.
- **Critical for teardown:** both NLBs are created by Kubernetes, not Terraform, so `terraform
  destroy` hangs on dependent ENIs if you don't delete the Services first. And the VPC Link holds a
  reference to the internal NLB — see [Phase 15](#phase-15--teardown--rebuild-drill) for the order.

---

# Phase 8B — AWS API Gateway

### Concept

Read [§3.8](#38-api-gateway-in-front-of-the-cluster) for why this is here and what it buys you, and
[§3.9](#39-the-api-gateway--lets-encrypt-constraint) for the certificate constraint.

**VPC Link** is the piece worth understanding. API Gateway is a managed service running outside your
VPC. A VPC Link is how it reaches inside: AWS creates **ENIs in your private subnets**, attached to a
security group you control, and the gateway routes through them to your internal NLB. Nothing is
exposed publicly; the path is gateway → ENI (in your VPC) → NLB → nginx → pod.

**Routes and integration.** For a proxy-everything API you need one catch-all route
(`ANY /{proxy+}`) with an `HTTP_PROXY` integration targeting the NLB listener through the VPC Link.
Add explicit routes later if you want per-route throttling or authorizers.

**Stages.** A stage is a named deployment (`$default` is simplest). Throttling, access logging, and
the custom domain mapping all attach at stage level.

**Hard limits you cannot change** — plan around them rather than discovering them:

| Limit | Value | Consequence here |
|---|---|---|
| Payload size | **10 MB** | Presigned uploads are mandatory ([§3.2](#32-presigned-urls-vs-the-vpc-endpoint)) |
| Integration timeout | **30 s** | Every endpoint must respond well under this |
| Default throttle | 10,000 rps / 5,000 burst (account) | Set a much lower per-stage limit for a dev app |

### Build

In `terraform/platform/apigateway.tf`:

1. **Security group** for the VPC Link — egress to the internal NLB on 80/443; no ingress rules
   needed.
2. **`aws_apigatewayv2_vpc_link`** — `subnet_ids` = your **private** subnets,
   `security_group_ids` = the SG above.
3. **`aws_apigatewayv2_api`** — `protocol_type = "HTTP"`, with CORS configured **here and only here**:
   ```hcl
   cors_configuration {
     allow_origins = ["https://app.<DOMAIN>"]     # never "*"
     allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
     allow_headers = ["content-type", "authorization"]
     max_age       = 300
   }
   ```
4. **`aws_apigatewayv2_integration`** — `integration_type = "HTTP_PROXY"`,
   `connection_type = "VPC_LINK"`, `connection_id` = the VPC Link,
   `integration_uri` = the internal NLB **listener ARN**, `integration_method = "ANY"`.
5. **`aws_apigatewayv2_route`** — `route_key = "ANY /{proxy+}"`.
6. **`aws_apigatewayv2_stage`** — `name = "$default"`, `auto_deploy = true`, plus:
   ```hcl
   default_route_settings {
     throttling_rate_limit  = 50     # requests/sec — a dev app needs nothing close to the default
     throttling_burst_limit = 100
   }
   access_log_settings {
     destination_arn = aws_cloudwatch_log_group.apigw.arn
     format          = jsonencode({ requestId = "$context.requestId", ip = "$context.identity.sourceIp", route = "$context.routeKey", status = "$context.status", latency = "$context.responseLatency", integrationError = "$context.integration.error" })
   }
   ```
   Set the log group's `retention_in_days = 7`.
7. **Custom domain** — *only after* Phase 9's ACM import works:
   ```hcl
   resource "aws_apigatewayv2_domain_name" "api" {
     domain_name = "api.<DOMAIN>"
     domain_name_configuration {
       certificate_arn = var.acm_imported_cert_arn   # the LE cert — see §3.9
       endpoint_type   = "REGIONAL"
       security_policy = "TLS_1_2"
     }
   }
   # + aws_apigatewayv2_api_mapping
   # + aws_route53_record  (A/ALIAS → the domain's regional target)
   ```

**Route 53 for `api.<DOMAIN>` is Terraform's job, not ExternalDNS's.** ExternalDNS only watches
Kubernetes Ingress and Service objects — API Gateway is invisible to it. Create that alias record in
Terraform, and keep ExternalDNS's `domainFilters` from fighting it (it won't: it never touches
records lacking its TXT ownership marker).

### Verify

Start with the default endpoint (Path 2 from §3.9):
```bash
API=$(terraform output -raw api_endpoint)
curl -sf $API/healthz
curl -s  $API/api/media | jq
```

Then confirm the API is **not** reachable any other way:
```bash
INT=$(kubectl -n ingress-nginx get svc ingress-nginx-internal-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl -sI --max-time 5 https://$INT/api/media     # must TIME OUT ✅
```

Check CORS preflight actually works from the web origin:
```bash
curl -si -X OPTIONS $API/api/media \
  -H "Origin: https://app.<DOMAIN>" \
  -H "Access-Control-Request-Method: POST" | grep -i access-control
```
You must see **exactly one** `Access-Control-Allow-Origin`. Two means your app is also emitting CORS
headers — turn them off in the app.

Verify throttling is live:
```bash
for i in $(seq 1 200); do curl -so /dev/null -w "%{http_code}\n" $API/healthz & done | sort | uniq -c
```
Some `429`s at 200 concurrent requests against a 50 rps limit confirms it.

### Gotchas

- **10 MB payload limit is absolute.** No tier raises it. This is why presigned uploads are the only
  option.
- **30 s integration timeout.** A slow `Query` on a cold GSI can brush this. Keep endpoints fast.
- **Duplicate CORS headers** — API Gateway *and* app both emitting them makes the browser reject a
  response whose headers look individually correct. Pick one; it should be API Gateway.
- **`integration_uri` for a VPC Link is the NLB *listener* ARN**, not the load balancer ARN. Using
  the wrong one produces a deploy-time error that doesn't say which ARN it wanted.
- **The VPC Link takes 2–4 minutes to become `AVAILABLE`.** Terraform waits, but don't assume a hang.
- **VPC Link security group needs egress to the NLB.** Default-deny egress SGs silently break it.
- **ExternalDNS does not manage `api.<DOMAIN>`.** If that record is missing, look in Terraform, not
  in ExternalDNS logs.
- **`$default` stage means no stage prefix in the path.** A named stage would put `/dev` in front of
  every route and break your frontend's base URL.

---

# Phase 9 — cert-manager + Let's Encrypt

### Concept

**ACME** (RFC 8555): register an account key, request a cert, receive a challenge proving domain
control, satisfy it, send a CSR, get a signed certificate.

**Two challenge types:**
- **HTTP-01** — serve a token at `http://<domain>/.well-known/acme-challenge/<token>`. Needs port 80
  publicly reachable. **Cannot issue wildcards.**
- **DNS-01** — create a TXT record at `_acme-challenge.<domain>`. Needs DNS API access. **Can issue
  wildcards**, and works even if the service isn't publicly reachable.

**Choose DNS-01.** You get `*.<DOMAIN>` from one certificate, so `app.`, `argocd.`, and
`kubecost.` share one cert and one renewal; it doesn't depend on your ingress being up, so a broken
ingress can't block renewal; and you already need Route 53 IAM permissions for ExternalDNS.

**Renewal:** cert-manager renews at **2/3 of lifetime** — ~day 60 of Let's Encrypt's 90. It rewrites
the Secret in place and nginx hot-reloads. Hands-off after setup.

### Build

**Two ClusterIssuers.** Let's Encrypt production has hard rate limits (50 certs per registered
domain per week, 5 duplicates per week). You *will* misconfigure something. **Use staging until it
works.**

`gitops/platform/cert-manager.yaml` (wave 0, chart from `https://charts.jetstack.io`):
```yaml
crds: { enabled: true }
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: <cert-manager-irsa-role-arn>
extraArgs:
  - --dns01-recursive-nameservers-only
  - --dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53
```

`gitops/platform/cluster-issuer.yaml` (wave 1) — both issuers:
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-staging }
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: <your-email>
    privateKeySecretRef: { name: letsencrypt-staging-account-key }
    solvers:
      - dns01:
          route53: { region: <REGION>, hostedZoneID: <HOSTED_ZONE_ID> }
        selector:
          dnsZones: ["<DOMAIN>"]
# …plus an identical letsencrypt-prod with server: https://acme-v02.api.letsencrypt.org/directory
```

### Verify

```bash
kubectl get clusterissuer                    # READY=True
kubectl -n media get certificate             # READY=True after 1-3 min

# when stuck, walk the chain DOWNWARD — the real error is at the bottom:
kubectl -n media describe certificate wildcard-tls
kubectl -n media get certificaterequest,order,challenge
kubectl -n media describe challenge <name>   # ← the actual error lives here
```

Once staging works, switch `issuerRef` to prod, **delete the Secret** so a fresh cert is requested:
```bash
echo | openssl s_client -connect app.<DOMAIN>:443 -servername app.<DOMAIN> 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```
Issuer must be `Let's Encrypt`, not `(STAGING) Pretend Pear`.

### 9B — Importing the Let's Encrypt cert into ACM (for API Gateway)

Do this **only after the prod wildcard cert is issuing cleanly.** Read
[§3.9](#39-the-api-gateway--lets-encrypt-constraint) first — this exists because API Gateway custom
domains can only reference certificates stored in ACM, and it keeps Let's Encrypt as the actual CA.

**One-time: create the ACM entry.** Import manually the first time so you get a stable ARN to
reference from Terraform:
```bash
kubectl -n media get secret wildcard-tls -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/fullchain.pem
kubectl -n media get secret wildcard-tls -o jsonpath='{.data.tls\.key}' | base64 -d > /tmp/key.pem

# Let's Encrypt's tls.crt is leaf + intermediates. ACM wants them separately:
awk 'BEGIN{n=0} /BEGIN CERT/{n++} n==1{print > "/tmp/cert.pem"} n>1{print > "/tmp/chain.pem"}' /tmp/fullchain.pem

aws acm import-certificate \
  --certificate     fileb:///tmp/cert.pem \
  --private-key     fileb:///tmp/key.pem \
  --certificate-chain fileb:///tmp/chain.pem \
  --tags Key=app,Value=mediavault Key=source,Value=letsencrypt

shred -u /tmp/cert.pem /tmp/chain.pem /tmp/key.pem /tmp/fullchain.pem
```
Record the returned `CertificateArn` → `terraform.tfvars` as `acm_imported_cert_arn`.

**Recurring: a CronJob that re-imports.** ACM **cannot renew a certificate it did not issue**. When
cert-manager renews at day 60, ACM keeps serving the old bytes until you re-import. Run
`gitops/platform/acm-import-cronjob.yaml` (wave 2) weekly, passing the **same**
`--certificate-arn` so it updates in place — that keeps the API Gateway mapping intact rather than
minting a new ARN you'd have to re-point.

The CronJob needs:
- an IRSA role with `acm:ImportCertificate` + `acm:DescribeCertificate` **on that one ARN**
- read access to the `wildcard-tls` Secret (a Role + RoleBinding in `media`)
- the same leaf/chain splitting as above

Re-importing an unchanged certificate is a harmless no-op, so a weekly schedule is simpler and safer
than trying to trigger on renewal events.

### Verify the import

```bash
aws acm describe-certificate --certificate-arn <arn> \
  --query 'Certificate.{issuer:Issuer,notAfter:NotAfter,type:Type,inUse:InUseBy}'
```
`Issuer` must be `Let's Encrypt` and `Type` must be `IMPORTED`. After the custom domain is wired up:
```bash
echo | openssl s_client -connect api.<DOMAIN>:443 -servername api.<DOMAIN> 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```
Same Let's Encrypt issuer as `app.<DOMAIN>` — one CA, two hostnames, zero ACM-issued certs.

### Gotchas

- **A staging cert shows a browser warning.** Correct — staging isn't in any trust store. Don't
  chase it.
- **Never import a staging cert into ACM.** ACM accepts it, API Gateway serves it, and every client
  gets a trust error. Import only after switching to `letsencrypt-prod`.
- **Rate limits are per registered domain and not appealable.** Burn 5 duplicates in a week on prod
  and you wait 7 days. Staging exists for exactly this.
- **`tls.crt` from cert-manager is leaf + chain concatenated.** ACM wants `--certificate` (leaf
  only) and `--certificate-chain` (the rest) as separate arguments. Passing the full bundle as
  `--certificate` fails validation with an unhelpful message.
- **Imported certs never auto-renew.** If you skip the CronJob, `api.<DOMAIN>` breaks ~30 days after
  the first cert-manager renewal, long after you've stopped thinking about it. Put a calendar
  reminder in as a backstop.
- **Reuse the same `--certificate-arn`** on re-import. Omit it and you create a *new* certificate
  each week, leaving the API Gateway pointed at a stale one.
- **Never write the private key to a path that persists.** The `shred -u` above matters.
- DNS-01 self-check failures are almost always cert-manager resolving through CoreDNS and getting a
  stale answer. The `--dns01-recursive-nameservers-only` flags fix it — include them from the start.
- cert-manager needs `route53:GetChange` on `arn:aws:route53:::change/*` in addition to the
  zone-scoped permission. Easy to miss.

---

# Phase 10 — ExternalDNS

### Concept

Without ExternalDNS: apply the Ingress, wait for the NLB, copy the hostname, open the Route 53
console, create an ALIAS record, remember to delete it later. Every time. Nobody ever deletes it.

ExternalDNS watches `Ingress` and `Service type=LoadBalancer`, extracts hostnames, and creates
matching Route 53 records. Delete the Ingress, the record goes too.

**The ownership problem and the TXT registry.** How does it distinguish "a record I created" from "a
record a human created and must not touch"? It writes a **TXT record** alongside every record it
manages:

```
edns-app.<DOMAIN>. TXT "heritage=external-dns,external-dns/owner=<CLUSTER_NAME>,external-dns/resource=ingress/media/mediavault"
```

Before modifying anything it reads the TXT. No matching owner ID → hands off. This is what makes it
safe to point at a zone that also contains hand-managed records.

**`--txt-owner-id` must be unique per cluster.** Two clusters sharing a zone with the same owner ID
will fight, each deleting the other's records in a loop.

**Policy modes:** `upsert-only` never deletes (safe, leaves orphans); `sync` does full lifecycle
(correct, and safe *because of* the TXT registry). Start with `upsert-only`, switch to `sync` once
you trust it.

### Build

`gitops/platform/external-dns.yaml`, wave `1`. Use the **kubernetes-sigs** chart
(`https://kubernetes-sigs.github.io/external-dns/`) — Bitnami changed its public image distribution
in 2025 and older charts can break unexpectedly.

```yaml
provider: { name: aws }
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: <external-dns-irsa-role-arn>
extraArgs:
  - --aws-zone-type=public
  - --txt-owner-id=<CLUSTER_NAME>
  - --txt-prefix=edns-
domainFilters: ["<DOMAIN>"]        # ← hard scope. Non-negotiable.
policy: upsert-only                 # flip to `sync` once you trust it
sources: [ingress, service]
registry: txt
interval: 1m
```

### Verify

```bash
kubectl -n external-dns logs -l app.kubernetes.io/name=external-dns -f
# look for: "Desired change: CREATE app.<DOMAIN> A"
aws route53 list-resource-record-sets --hosted-zone-id <HOSTED_ZONE_ID> \
  --query "ResourceRecordSets[?contains(Name,'app')]"
dig +short @8.8.8.8 app.<DOMAIN>
```
You should see both the ALIAS record and its `edns-` TXT companion.

### Gotchas

- **`domainFilters` is your blast-radius control.** Without it ExternalDNS enumerates every zone the
  IAM role can reach. Combined with a zone-scoped IAM policy that's defense in depth — set both.
- `dig @8.8.8.8` to bypass local resolver caching when a record "isn't appearing."
- Nothing created at all → 90% IRSA (`AccessDenied` in pod logs), 10% `domainFilters` mismatch.

---

# Phase 11 — External Secrets Operator

### Concept

First, notice what changed: **DynamoDB + IAM removed your database credential entirely.** There is
no connection string, no password, no rotation problem. That's a genuine architectural win, and it's
worth naming rather than glossing over — the most secure secret is the one that doesn't exist.

So why install ESO at all? Because you still have *some* real secrets — the cross-account
`ExternalId`, a session-signing key, and any third-party API key you add later — and because the
pattern is worth learning before you need it urgently.

**Where secrets must not live:** not in Git (no revocation, no rotation, no audit, history is
forever — and your Argo apps come *from* Git); not in a hand-applied Kubernetes Secret (base64, not
encrypted, and you'd recreate it by hand on every cluster rebuild, breaking your disposable-cluster
strategy).

**ESO** is the bridge. Two CRDs:
- **`ClusterSecretStore`** — how to reach the backend (SSM, Secrets Manager, Vault) and with which
  identity.
- **`ExternalSecret`** — "read `/mediavault/<ENV>/external-id` and materialize it as Kubernetes
  Secret `mediavault-secrets` in namespace `media`, refreshing hourly."

Git holds only a *reference*. Values live in SSM, encrypted with KMS, IAM-controlled,
CloudTrail-logged, rotatable without a deploy. On cluster rebuild ESO recreates everything.

**SSM Parameter Store vs. Secrets Manager:** Secrets Manager has automatic rotation and costs
$0.40/secret/month. SSM `SecureString` (standard tier) is **free** and KMS-encrypted. Use SSM here;
know Secrets Manager is right when you need rotation.

### Build

`gitops/platform/external-secrets.yaml` (wave 0, chart from `https://charts.external-secrets.io`):
```yaml
installCRDs: true
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: <eso-irsa-role-arn>
```

`gitops/platform/cluster-secret-store.yaml` (wave 1):
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata: { name: aws-ssm }
spec:
  provider:
    aws:
      service: ParameterStore
      region: <REGION>
      auth:
        jwt:
          serviceAccountRef: { name: external-secrets, namespace: external-secrets }
```

`charts/mediavault/templates/externalsecret.yaml`:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: { name: mediavault-secrets, namespace: media }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-ssm, kind: ClusterSecretStore }
  target: { name: mediavault-secrets, creationPolicy: Owner }
  data:
    - secretKey: DDB_EXTERNAL_ID
      remoteRef: { key: /mediavault/dev/ddb-external-id }
    - secretKey: SESSION_SIGNING_KEY
      remoteRef: { key: /mediavault/dev/session-key }
```

**Table names and bucket names go in a ConfigMap, not here.** They aren't secret, and mixing
non-secret config into secrets makes both harder to review.

### Verify

```bash
kubectl -n media get externalsecret        # SYNCED=True READY=True
kubectl -n media get secret mediavault-secrets
kubectl -n media describe externalsecret mediavault-secrets
```
Do **not** `kubectl get secret -o yaml` and paste the output anywhere.

### Gotchas

- ESO's IAM policy needs `ssm:GetParameter*` on the parameter ARN **and** `kms:Decrypt` on the
  encrypting key (`alias/aws/ssm` by default).
- Leading slashes in the SSM path must match exactly in `remoteRef.key`.
- **Pods don't auto-restart when a Secret changes.** Mount as a volume (updates in place) or use
  Reloader. Env vars are snapshotted at container start.

---

# Phase 12 — Build & Deploy MediaVault

### Concept

Read [§5](#5-the-application-mediavault) for the spec and [§6](#6-dynamodb-data-model--build-these-first)
for the data model. This phase is about the parts that are easy to get subtly wrong.

**Writing an item touches three places atomically-ish.** There are no cross-table transactions here
(DynamoDB has `TransactWriteItems`, but not across accounts-plus-S3), so **order your operations so
that a crash leaves no dangling reference:**

- **Create:** S3 object exists first (client uploaded it) → verify → *then* write the item. A crash
  before the write leaves an orphaned S3 object, which your 30-day lifecycle rule sweeps up.
- **Delete:** delete the **S3 object first**, then the DynamoDB item. A crash between them leaves an
  item pointing at a missing object — recoverable, visible, and fixable. Reverse the order and you
  get an invisible orphaned object you pay for forever.

The principle: **when you can't be atomic, fail toward the state you can detect and clean up.**

**Cursor pagination.** DynamoDB `Query` returns `LastEvaluatedKey`. Base64-encode the JSON and
return it as `nextCursor`; decode it into `ExclusiveStartKey` on the next call. Never expose the raw
key — it contains your internal key structure.

**Two GSI queries, one endpoint.** `GET /api/media` picks its index from the filter:
- no `type` filter → GSI1, `gsi1pk = "FEED#ready"`
- `type=video` → GSI2, `gsi2pk = "TYPE#video"`

Both with `ScanIndexForward: false` for newest-first. **Never `Scan`** — the app role doesn't even
have permission (Phase 2), which is deliberate: the IAM policy enforces the data model.

### Container hardening

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
USER nonroot
EXPOSE 8080
CMD ["dist/server.js"]
```

Pod security context — every one of these:
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  fsGroup: 10001
  seccompProfile: { type: RuntimeDefault }
containers:
  - name: api
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: { drop: ["ALL"] }
    resources:
      requests: { cpu: 100m, memory: 128Mi }
      limits:   { memory: 512Mi }      # memory yes, CPU no — see below
    volumeMounts:
      - { name: tmp, mountPath: /tmp }  # required by readOnlyRootFilesystem
```

> **On CPU limits:** set memory limits (OOM is the failure mode you want — fast and obvious) but
> generally **omit CPU limits**. The CFS quota mechanism throttles containers even when the node has
> idle CPU, causing latency spikes that are miserable to diagnose. Set CPU *requests* for scheduling
> and let bursting happen. This is widely held but not universal — know the reasoning either way.

### Build

1. Write the API and web app per [§5](#5-the-application-mediavault).
2. Build and push:
   ```bash
   aws ecr get-login-password | docker login --username AWS --password-stdin <APP_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
   docker build -t <APP_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mediavault-api:v0.1.0 app/api
   docker push <APP_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mediavault-api:v0.1.0
   ```
   **Always a real version tag, never `:latest`.** With `:latest` Argo sees no manifest diff and
   won't redeploy — and you can never tell which build is running.
3. Write `charts/mediavault/` per the tree in [§4](#4-repository-layout).
4. **Two** Ingresses now — one per class.

   `ingress-web.yaml` — public, TLS terminated by nginx with the Let's Encrypt cert:
   ```yaml
   metadata:
     annotations:
       cert-manager.io/cluster-issuer: letsencrypt-prod
   spec:
     ingressClassName: nginx-public
     tls: [{ hosts: [app.<DOMAIN>], secretName: mediavault-tls }]
     rules:
       - host: app.<DOMAIN>
         http:
           paths:
             - { path: /, pathType: Prefix, backend: { service: { name: mediavault-web, port: { number: 8080 } } } }
   ```

   `ingress-api.yaml` — internal, reached **only** through the VPC Link. No TLS block and no
   cert-manager annotation: API Gateway terminates TLS at the edge, and the hop from the VPC Link to
   nginx is plain HTTP inside your private subnets.
   ```yaml
   spec:
     ingressClassName: nginx-internal
     rules:
       - http:                      # no host match — API GW forwards whatever Host it likes
           paths:
             - { path: /, pathType: Prefix, backend: { service: { name: mediavault-api, port: { number: 8080 } } } }
   ```
   > If you'd rather encrypt that last hop too, set the API Gateway integration to HTTPS with
   > `tlsConfig.serverNameToVerify` and give the internal Ingress the wildcard cert. Reasonable, and
   > more moving parts — get plain HTTP working first.

5. `gitops/apps/mediavault.yaml` — Argo Application, wave `5`.

### Verify

```bash
curl -sf https://app.<DOMAIN>/healthz
curl -s https://app.<DOMAIN>/api/media | jq
curl -s -X POST https://app.<DOMAIN>/api/uploads/presign \
  -H 'content-type: application/json' \
  -d '{"filename":"t.mp4","contentType":"video/mp4","sizeBytes":1048576}' | jq
```

Then in a browser: upload a real file, watch it appear in the table, edit the title, play it back,
delete it. Confirm both sides are clean:
```bash
aws s3 ls s3://<MEDIA_BUCKET>/uploads/ --recursive --profile mv-app
aws dynamodb scan --table-name mediavault-dev-items --select COUNT --profile mv-data
```
(You can `Scan` from your admin profile — the *app* can't. That distinction is the point.)

**Prove the gateway endpoints are actually used.** This is the concrete evidence Phase 3 did
something:
```bash
# CloudTrail data events for S3/DynamoDB include a vpcEndpointId field on calls from your VPC
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=PutItem \
  --max-results 5 | jq '.Events[].CloudTrailEvent | fromjson | {event:.eventName, vpce:.vpcEndpointId}'
```

### Gotchas

- **CORS.** The presigned PUT hits S3's origin, not yours — the **bucket's** CORS config must allow
  it. A CORS failure looks like a generic network error; check the Network tab for a failed OPTIONS
  preflight.
- **`ExposeHeaders: ["ETag"]`** in bucket CORS, or multipart can't read part ETags.
- The SDK signs `Content-Type` into the presigned URL. The browser's PUT must send **exactly** the
  same value or S3 returns `SignatureDoesNotMatch`. `video/mp4` vs `video/mp4;` will cost you an hour.
- Files >5 GB need **multipart** presigned uploads. Single PUT caps there and has no resume. Start
  with single PUT; multipart is a stretch goal.
- `readOnlyRootFilesystem: true` + any temp write → `EROFS`. Mount `emptyDir` at `/tmp`.
- **TTL attribute must be Number/epoch-seconds.** ISO strings or milliseconds silently never expire.

---

# Phase 13 — Kubecost

### Concept

Kubernetes bills you nothing; **EC2, EBS, and load balancers do.** The gap is attribution: your AWS
bill says "$61 of t3.medium," and you want to know that $22 of it was `mediavault-api`.

Kubecost joins **Prometheus metrics** (per-pod CPU/memory requests and usage from cAdvisor and
kube-state-metrics) with **AWS pricing**, then allocates node cost to pods proportionally and rolls
it up by namespace, label, or controller.

The output you care about is **efficiency**: `usage ÷ request`. A pod requesting 1000m CPU and using
40m is 4% efficient — it holds a full core of scheduling capacity while doing nothing, forcing
Karpenter to provision nodes you don't need. Right-sizing requests from this data is typically the
single largest cost win in any real cluster, and it's the specific skill this phase teaches.

Free Community edition gives real-time allocation and ~15 days retention — plenty here. It's built
on **OpenCost** (the CNCF project Kubecost donated).

### Build

`gitops/platform/kubecost.yaml`, wave `3`, chart `cost-analyzer` from
`https://kubecost.github.io/cost-analyzer/`:
```yaml
global: { prometheus: { enabled: true } }
kubecostProductConfigs:
  clusterName: <CLUSTER_NAME>
  currencyCode: USD
  awsSpotDataRegion: <REGION>        # so spot nodes price correctly, not at on-demand
prometheus:
  server:
    persistentVolume: { size: 8Gi }  # needs the EBS CSI driver from Phase 4
    resources:
      requests: { cpu: 100m, memory: 512Mi }
      limits:   { memory: 1Gi }      # ← cap it or it eats 4Gi
kubecostFrontend:
  resources:
    requests: { cpu: 50m, memory: 128Mi }
```

**Do not expose Kubecost publicly.** It reveals your entire cost structure and workload inventory,
and Community edition has no authentication.
```bash
kubectl -n kubecost port-forward svc/kubecost-cost-analyzer 9090:9090
```
If you insist on an Ingress: nginx basic auth **and** `whitelist-source-range`. Both, not either.

### Verify

Port-forward, then check **Allocations** (per-namespace cost), **Savings** (over-provisioned
requests), and **Assets** (EC2 at spot prices).

Then do the actual exercise: find your app's efficiency, cut requests to real usage +30% headroom,
push, and watch Karpenter consolidate onto fewer nodes. Record the before/after in `docs/cost-log.md`.

### Gotchas

- Needs **15–30 minutes** of data before numbers mean anything. Empty dashboards right after install
  are expected.
- No working `StorageClass` → the Prometheus PVC stays Pending and Kubecost never goes Healthy.
  Check the EBS CSI addon and its IRSA role.
- On a nightly-destroyed cluster, history resets each rebuild. Fine for learning the interface.
- Bundled Prometheus is your largest memory consumer. The limits above are deliberate.

---

# Phase 14 — Security Hardening Pass

### Concept

Everything so far had security built in. This phase is the **audit**: verify each control actually
holds, then add the ones that only make sense once the system exists.

### 14.1 Network Policies (default-deny)

By default **every pod can reach every other pod.** Flat network, no segmentation. A compromised
frontend can talk to Argo CD's API and Kubecost's Prometheus.

NetworkPolicy fixes this — **but only if a controller enforces it.** The EKS VPC CNI supports it
natively (`enableNetworkPolicy: "true"`, Phase 4). Without an enforcing CNI, NetworkPolicy objects
apply cleanly and do **nothing** — a dangerous false sense of security. Verify enforcement, don't
assume it.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-all, namespace: media }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: mediavault-api-allow, namespace: media }
spec:
  podSelector: { matchLabels: { app: mediavault-api } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ingress-nginx } }
      ports: [{ protocol: TCP, port: 8080 }]
  egress:
    # DNS — forget this and every other rule appears broken
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
    # AWS APIs: S3 + DynamoDB (gateway endpoints) and STS (via NAT).
    # NetworkPolicy cannot reference AWS prefix lists, so this is broad HTTPS
    # egress minus the VPC itself. Cilium's FQDN rules would tighten it.
    - to: [{ ipBlock: { cidr: 0.0.0.0/0, except: [10.0.0.0/16] } }]
      ports: [{ protocol: TCP, port: 443 }]
```

**Test it** — a policy you haven't tried to violate is one you don't know works:
```bash
kubectl -n media run t --rm -it --restart=Never --image=busybox -- \
  wget -qO- --timeout=3 http://kubecost-cost-analyzer.kubecost:9090   # must TIME OUT
```

### 14.2 Pod Security Admission

Label every namespace in Git (wave `-1`), not by hand:
```bash
kubectl label ns media \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted
```
Some platform namespaces (`kube-system`, karpenter) legitimately need `privileged` — label those
explicitly rather than leaving them unlabeled, so the intent is documented.

### 14.3 Audit checklist

Check each against **live infrastructure**, not your memory of having configured it.

**Network**
- [ ] Zero worker nodes have public IPs (`kubectl get nodes -o wide` → `EXTERNAL-IP: <none>`)
- [ ] EKS public endpoint restricted to your `/32`
- [ ] S3 **and** DynamoDB gateway endpoints in **every** private route table
- [ ] DynamoDB endpoint policy scoped to the data account's `mediavault-<ENV>-*` tables
- [ ] Default-deny NetworkPolicy in `media`, verified enforced by the timeout test
- [ ] Node security group has no `0.0.0.0/0` ingress

**Identity**
- [ ] Every IRSA trust policy pins both `:aud` and a **specific** `:sub` — no wildcards
- [ ] Data-account role trusts a **specific role ARN**, not `:root`
- [ ] App role has **no** `dynamodb:*` permissions of its own — only `sts:AssumeRole`
- [ ] Data-account role has no `Scan`, no `DeleteTable`, and includes `/index/*` ARNs
- [ ] `route53:ChangeResourceRecordSets` scoped to one hosted zone ARN
- [ ] App S3 policy scoped to `uploads/*` — no `s3:*`
- [ ] IMDS hop limit is 1 on both the managed nodegroup and the EC2NodeClass
- [ ] `authentication_mode = "API"`; no leftover `aws-auth` ConfigMap
- [ ] No long-lived IAM access keys anywhere in the cluster

**Data**
- [ ] S3 Block Public Access: all four flags `true`
- [ ] Bucket policy denies `aws:SecureTransport: false`
- [ ] Versioning on; noncurrent expiration set; **incomplete-multipart abort set**
- [ ] DynamoDB encryption at rest enabled on all three tables
- [ ] TTL enabled and the attribute is Number/epoch-seconds on `uploads` and `audit`
- [ ] Kubernetes Secrets envelope-encrypted with your KMS key
- [ ] No secret in Git: `git log -p | grep -iE 'BEGIN.*PRIVATE KEY|AKIA|aws_secret'`

**Workload**
- [ ] All containers non-root, `readOnlyRootFilesystem`, `drop: [ALL]`, `RuntimeDefault` seccomp
- [ ] PSA `restricted` enforced on app namespaces
- [ ] Memory limits everywhere
- [ ] Images tagged immutably, never `:latest`
- [ ] ECR scan-on-push enabled **and you have read the findings** — enabling scanning and never
      looking is the most common security theater in this list
- [ ] Argo CD admin password changed, `argocd-initial-admin-secret` deleted
- [ ] Argo CD and Kubecost not publicly exposed
- [ ] Argo CD repo credential is a read-only deploy key
- [ ] AppProject restricts source repos and destination namespaces

**API Gateway & edge**
- [ ] Internal NLB is `scheme: internal` — `curl` from your laptop **times out**
- [ ] The API is reachable *only* via API Gateway (verified in Phase 8B)
- [ ] CORS emitted by API Gateway **only** — exactly one `Access-Control-Allow-Origin` header
- [ ] `allow_origins` is your exact origin, never `*`
- [ ] Per-stage throttling set well below account defaults; verified with a burst test
- [ ] Access logging on, retention 7 days
- [ ] VPC Link SG has egress to the NLB and no unnecessary ingress
- [ ] `api.<DOMAIN>` serves a **Let's Encrypt** issuer, and the ACM cert `Type` is `IMPORTED`
- [ ] The ACM re-import CronJob exists, has run at least once, and its IRSA role is scoped to that
      one certificate ARN

**Operational**
- [ ] Control plane audit logging on, retention 7 days
- [ ] AWS Budget configured and the email subscription **confirmed**
- [ ] `terraform plan` clean in both roots — no drift
- [ ] The manual data-account resources match `scripts/create-*.sh` (nothing edited in the console)

### 14.4 Stretch exercises

1. **Break it on purpose.** Apply the `aws:sourceVpce` bucket policy from [§3.2](#32-presigned-urls-vs-the-vpc-endpoint)
   and watch presigned uploads 403. Read the CloudTrail entry, then revert. Note that you *cannot*
   fix it by switching to proxy uploads any more — API Gateway's 10 MB limit closed that door, which
   is itself the lesson about how architectural choices constrain each other.
2. **Replace AssumeRole with a DynamoDB resource-based policy** (§3.6). Compare latency and the
   number of moving parts.
3. **Migrate ExternalDNS from IRSA to Pod Identity.** Create the association, remove the annotation,
   restart. Compare the two mental models.
4. **Go fully private.** `endpoint_public_access = false` + SSM interface endpoints, reach the API
   through a session — then **destroy the endpoints**, they're expensive. Timebox it.
5. **Kill a spot node** (`aws ec2 terminate-instances`) and watch Karpenter's interruption handling
   drain and replace it.

---

# Phase 15 — Teardown & Rebuild Drill

### Concept

A real phase, not an appendix. Two reasons: it's your **cost strategy**, and it's the real test of
your GitOps setup. If the cluster rebuilds from Terraform + Git with zero manual steps, your
architecture is genuinely reproducible. If it doesn't, you've found hidden manual state — exactly
what you want to discover while learning rather than during an incident.

### Order matters

**Kubernetes creates AWS resources Terraform doesn't know about.** Both NLBs and Karpenter's
instances exist in AWS but not in Terraform state. Destroy first and VPC deletion blocks on
dependent ENIs for ~20 minutes before erroring.

**API Gateway adds one new ordering constraint.** The VPC Link holds a reference to the internal
NLB, and its ENIs live in your private subnets. Terraform owns the VPC Link, but Kubernetes owns
the NLB — so if you delete the NLB first, `terraform destroy` may fail deleting a VPC Link whose
target vanished. Destroy the **API Gateway layer first**, then the Kubernetes-owned load balancers.

```bash
# 1. Tear down the API Gateway layer FIRST (it references the internal NLB)
cd terraform/platform
terraform destroy \
  -target=aws_apigatewayv2_api_mapping.api \
  -target=aws_apigatewayv2_domain_name.api \
  -target=aws_apigatewayv2_stage.default \
  -target=aws_apigatewayv2_route.proxy \
  -target=aws_apigatewayv2_integration.nlb \
  -target=aws_apigatewayv2_vpc_link.main
aws apigatewayv2 get-vpc-links --query 'Items[].{id:VpcLinkId,status:VpcLinkStatus}'
#    ↑ must be empty (VPC Link deletion takes a few minutes)

# 2. Delete BOTH Services that own load balancers
kubectl -n ingress-nginx delete svc ingress-nginx-public-controller
kubectl -n ingress-nginx delete svc ingress-nginx-internal-controller
kubectl get svc -A -o json | jq -r '.items[]|select(.spec.type=="LoadBalancer")|"\(.metadata.namespace)/\(.metadata.name)"'
#    ↑ must be empty before continuing

# 3. Let Karpenter drain its own nodes — NodePool first, or nodes get recreated
kubectl delete nodepool --all
kubectl delete nodeclaim --all
kubectl get nodeclaims                      # wait until empty

# 4. Clear finalizer-heavy CRs
kubectl -n argocd patch app root --type merge -p '{"metadata":{"finalizers":null}}'
kubectl delete applications -n argocd --all

# 5. Terraform, the rest
terraform destroy

# 6. Confirm nothing expensive survived
aws ec2 describe-instances --filters Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId'
aws ec2 describe-nat-gateways --filter Name=state,Values=available --query 'NatGateways[].NatGatewayId'
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName'   # expect NONE
aws apigatewayv2 get-vpc-links --query 'Items[].VpcLinkId'                     # expect NONE
aws ec2 describe-addresses --query 'Addresses[?AssociationId==null].PublicIp'  # unattached EIPs bill forever
aws ec2 describe-volumes --filters Name=status,Values=available --query 'Volumes[].VolumeId'
```

**Nothing to do for the database.** DynamoDB on-demand costs nothing at rest — leave the tables and
your data alone. This is a concrete daily benefit of the DynamoDB choice, and a second one of
creating it outside Terraform: `terraform destroy` cannot possibly take your data with it.

**Two things survive that you should know about.** The **imported ACM certificate** persists (it's
free, and keeping the ARN stable saves you re-pointing the custom domain on every rebuild). And the
**Route 53 record for `api.<DOMAIN>`** is Terraform-owned, so it *does* get destroyed and recreated —
expect a brief NXDOMAIN window on rebuild while it propagates.

### Rebuild

```bash
cd terraform/platform && terraform apply
aws eks update-kubeconfig --name <CLUSTER_NAME> --region <REGION>
watch kubectl get applications -n argocd
```

**Everything should return with no manual steps.** Anything you fix by hand is a bug in your
setup — go make it declarative. That's the drill.

### Makefile

```make
up:         ; cd terraform/platform && terraform apply
down:       ; ./scripts/teardown.sh
kubeconfig: ; aws eks update-kubeconfig --name $(CLUSTER) --region $(REGION)
argo:       ; kubectl -n argocd port-forward svc/argocd-server 8080:443
cost:       ; kubectl -n kubecost port-forward svc/kubecost-cost-analyzer 9090:9090
sync:       ; argocd app sync root --prune
audit:      ; ./scripts/audit.sh
seed:       ; ./scripts/seed-data.sh
```

### Gotchas

- Deleting a namespace with stuck finalizers hangs forever. `kubectl get ns <n> -o json | jq .spec.finalizers`.
- Karpenter nodes deleted *without* deleting the NodePool get immediately recreated. Order matters.
- ECR images, S3 objects, and DynamoDB tables survive by design — you don't rebuild images daily.
- **Run the drill twice.** The first time surfaces something manual. The second proves you fixed it.

---

## 16. The Flow — Diagram & Narrative

### 16.1 Memory model: what lives where

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  YOUR LAPTOP                                                                 │
│  terraform ─ writes AWS ─┐   git push ─ writes desired state ─┐  kubectl ─┐  │
└──────────────────────────┼───────────────────────────────────┼───────────┼──┘
                           ▼                                   ▼           ▼
      ┌────────────────────────────┐   ┌──────────────────┐  ┌────────────────────┐
      │  AWS CONTROL PLANE         │   │  GIT             │  │  EKS API SERVER    │
      │  APP ACCOUNT (terraform):  │   │  desired state   │  │  (AWS-managed)     │
      │   · VPC, subnets, NAT      │   │  · gitops/       │  │  · etcd, KMS-      │
      │   · 2 gateway endpoints    │   │  · charts/       │  │    encrypted       │
      │   · EKS, IAM/OIDC          │   │  · terraform/    │  │  · PSA admission   │
      │   · API GW + VPC Link      │   └────────┬─────────┘  └─────────┬──────────┘
      │   · S3, ECR, SSM, Route53  │            │ pull 3m              │ watch/apply
      │  DATA ACCOUNT (BY HAND):   │            ▼                      │
      │   · DynamoDB × 3           │  ┌───────────────────────────────▼────────┐
      │   · 1 cross-account role   │  │  ARGO CD  (in-cluster reconciler)      │
      └──────────┬─────────────────┘  │  desired (Git) vs live (API) → converge│
                 │                    └───────────────────┬────────────────────┘
                 │                                        │ creates/updates
                 │         ┌──────────────────────────────▼─────────────────────┐
                 │         │  CLUSTER WORKLOADS                                 │
                 │  OIDC   │  each controller assumes a scoped IRSA role and    │
                 └────────►│  reaches back into AWS with temporary credentials: │
                           │                                                     │
                           │   karpenter    ──► EC2 RunInstances / Fleet         │
                           │   external-dns ──► Route 53 ChangeRRSets (app only) │
                           │   cert-manager ──► Route 53 TXT (ACME DNS-01)       │
                           │   acm-importer ──► acm:ImportCertificate (weekly)   │
                           │   ext-secrets  ──► SSM GetParameter + KMS Decrypt   │
                           │   mediavault   ──► S3 uploads/*   (gateway endpoint)│
                           │        └── + sts:AssumeRole ──► DATA ACCOUNT ──►    │
                           │                DynamoDB       (gateway endpoint)    │
                           └────────────────────────────────────────────────────┘
```

**Three sources of truth, not two.** Terraform owns app-account AWS. Git owns the cluster. And a
small set of **hand-made data-account resources** owns your database — reproducible via committed
scripts, but not reconciled by anything. That third category is the one to keep an eye on: nothing
will tell you if it drifts.

The single most important idea: **there are two independent control loops.** Terraform's is
imperative and human-triggered — you run `apply`, it converges AWS, it stops. Argo CD's is
continuous and autonomous — it never stops converging the cluster toward Git. They meet at exactly
one point: the `helm_release` that installs Argo CD. Keeping that boundary clean is what makes the
whole system reproducible.

The second idea: **no long-lived credential exists anywhere in that picture.** Not in Git, not in a
Secret, not in an env var. Every arrow into AWS is a short-lived token derived from the workload's
own identity.

### 16.2 The request flow, narrated

Here is what happens, end to end, when someone uploads a video.

A user types `app.<DOMAIN>` into a browser. **Route 53** answers with an ALIAS record pointing at
your **public Network Load Balancer** — and that record exists because **ExternalDNS**, a pod inside
the cluster, saw your Ingress object, extracted the hostname, assumed its IRSA role through the
cluster's **OIDC provider**, and called `route53:ChangeResourceRecordSets` scoped to that one zone.
It also wrote a companion TXT record claiming ownership, so it will never touch a record it didn't
create.

The browser opens TLS to that NLB on port 443. The NLB is **layer 4**: it does not terminate TLS. It
forwards the raw TCP stream directly to an **ingress-nginx** pod IP — directly, because the VPC CNI
gives every pod a real VPC address, so the target group holds pod IPs rather than node ports. The
handshake completes *inside your cluster*, using a certificate in a Kubernetes Secret. That
certificate exists because **cert-manager** watched the Ingress annotation, opened an ACME Order
against Let's Encrypt, received a **DNS-01** challenge, assumed *its* IRSA role, wrote a TXT record
at `_acme-challenge.<DOMAIN>`, waited for validation, and stored the signed wildcard cert. It will
renew at day 60 of 90 and nginx will hot-reload without a restart. The page loads.

Now the page calls the API, and this is where the path diverges from a plain Kubernetes app. The
frontend was built with `VITE_API_BASE_URL=https://api.<DOMAIN>`, a **different origin**, so the
browser first sends a CORS preflight `OPTIONS`. That request resolves to **API Gateway**, not to your
cluster — and its Route 53 record was created by *Terraform*, not ExternalDNS, because ExternalDNS
only watches Kubernetes objects and API Gateway is invisible to it. API Gateway answers the preflight
itself from its `cors_configuration`, which is why the app must not emit CORS headers of its own: two
sources would produce duplicate `Access-Control-Allow-Origin` headers and the browser would reject
the response.

API Gateway terminates TLS using a certificate that **Let's Encrypt issued and cert-manager
obtained** — the same wildcard as `app.<DOMAIN>`. It reads that cert from ACM, because API Gateway
custom domains can only reference ACM, and a weekly CronJob in your cluster copies the Kubernetes
Secret into ACM with `acm:ImportCertificate` so renewals actually take effect
([§3.9](#39-the-api-gateway--lets-encrypt-constraint)). ACM is a container here, never an issuer.

The real `POST /api/uploads/presign` then hits the `ANY /{proxy+}` route, is throttled against your
per-stage rate limit, is written to an access log, and is handed to the **VPC Link** — ENIs AWS
placed in *your* private subnets. From there it reaches the **internal NLB**, which has no public
address at all, then a second ingress-nginx instance on the `nginx-internal` class, then a
**mediavault-api** pod: non-root, read-only root filesystem, all capabilities dropped,
`RuntimeDefault` seccomp, on a node **Karpenter** provisioned as a spot instance roughly forty
seconds after the scheduler reported the pod unschedulable.

That path is the security payoff. There is no route from the internet to `mediavault-api` that
bypasses API Gateway, so the throttling, logging, and CORS policy configured there cannot be
circumvented by anyone who discovers an NLB hostname.

The API validates the request against its schema: is the content type in the allowlist, is the size
under the cap? It generates a UUID-based S3 key — never the client's filename — and writes an
**upload ticket** to DynamoDB recording the key *it* chose, the content type, the size limit, and a
TTL an hour out. To do that it needs credentials in another AWS account, so it uses the cached result
of a two-hop identity chain: OIDC gave the pod an identity in the app account, and `sts:AssumeRole`
projected that identity into the **data account**, where a role trusts precisely one role ARN and
grants precisely six DynamoDB actions on three tables. That write leaves the VPC through the
**DynamoDB gateway endpoint** — a route table entry, free, over the AWS backbone. Then the API
SigV4-signs a **presigned PUT URL** locally, with no network call, and returns it.

The browser PUTs the video bytes **directly to S3**, over the public internet, authenticated by the
signature in the URL. Those bytes never enter your VPC, never touch a pod, never pass through API
Gateway, and cost nothing in NAT charges. This is no longer merely the preferred design — API
Gateway's hard **10 MB payload limit** and **30-second integration timeout** make it the only one
that can work ([§3.2](#32-presigned-urls-vs-the-vpc-endpoint)). A 200 MB video could not traverse the
gateway if you wanted it to. The architecture forced the correct answer, which is a satisfying
outcome and a good illustration of how one platform choice constrains another.

When the upload finishes, the browser calls `POST /api/media`, and now the **S3 gateway endpoint**
does its work. The API loads the ticket by `uploadId`, checks it hasn't expired or been consumed,
and calls `HeadObject` on the key **from the ticket** — never from the client. It confirms the object
exists and its size and content type match what was promised. Only then does it write the item,
mark the ticket consumed, and append an audit event. Both DynamoDB writes and the S3 call travel
over gateway endpoints; the only traffic reaching the NAT Gateway is the hourly `sts:AssumeRole`
refresh, because STS has no gateway endpoint.

Meanwhile none of that traffic could have gone anywhere unexpected. The **NetworkPolicy** in the
`media` namespace denies all ingress and egress by default, then allows exactly three things:
inbound from ingress-nginx on 8080, outbound DNS to CoreDNS, and outbound 443 to everything outside
the VPC. A compromised pod cannot reach Argo CD, cannot reach Kubecost, cannot scan the VPC, and
cannot reach the node's instance metadata service — because the IMDS hop limit is 1. And even with
stolen credentials it cannot touch a DynamoDB table outside `mediavault-<ENV>-*`, because the
gateway endpoint policy says so, or `Scan` any table at all, because the hand-written data-account
role never granted it.

The browser reloads the table. `GET /api/media` runs a `Query` against **GSI1** with
`gsi1pk = "FEED#ready"` and `ScanIndexForward: false`, returning the newest items plus a
`LastEvaluatedKey` that becomes the next cursor. Filter by type and it hits **GSI2** instead. Each
row carries a short-lived presigned GET URL so the `<video>` element streams straight from S3. Delete
removes the S3 object *first*, then the item — so a crash between them leaves a visible, fixable
dangling reference rather than an invisible object you pay for forever.

Running quietly underneath: **Karpenter** watches for pods it could pack more tightly, terminating
half-empty spot nodes and replacing them with cheaper shapes; **Kubecost** scrapes Prometheus and
tells you which Deployment requests four times the CPU it uses; and **Argo CD** compares every object
in the cluster against Git every three minutes, ready to revert anything that drifted — including
changes you made by hand.

That's the whole system: **Terraform builds the app account, a handful of committed scripts build the
data account, Git describes the cluster, Argo CD makes the cluster match Git, API Gateway is the only
door to the API, IRSA plus one cross-account AssumeRole let the cluster reach both accounts with
scoped short-lived credentials, one Let's Encrypt wildcard secures both hostnames, and two free
gateway endpoints keep the data path off the public internet.** Everything else is detail.

---

## 17. Gotcha Index

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | `InsufficientFreeAddressesInSubnet` | Subnets too small; VPC CNI gives every pod a real IP | Use /19 subnets. Plan in Phase 3 — you cannot resize later |
| 2 | Nodes can't pull images after tightening the S3 endpoint policy | ECR layers live in AWS-owned S3 buckets reached via your gateway endpoint | Allowlist `prod-<REGION>-starport-layer-bucket/*` or keep the policy permissive |
| 3 | Presigned upload 403s after adding a bucket policy | `aws:sourceVpce` — the request comes from the user's ISP, not your VPC | Don't combine `sourceVpce` with presigned browser uploads ([§3.2](#32-presigned-urls-vs-the-vpc-endpoint)) |
| 4 | `GetItem` works, list view returns `AccessDenied` | GSI ARNs missing from the IAM policy | Add `table/<name>/index/*` — the table ARN alone doesn't cover indexes |
| 5 | Cross-account `AccessDenied`, no detail | Only one side of the handshake granted | Both: trust policy in data account **and** `sts:AssumeRole` in app account |
| 6 | DynamoDB calls fail when NAT is broken | `sts:AssumeRole` has no gateway endpoint; it goes via NAT | Expected. Looks like a DynamoDB problem but it's STS |
| 7 | Upload tickets never expire | TTL attribute isn't a Number holding **epoch seconds** | ISO strings and milliseconds silently never expire |
| 8 | Slow API, STS throttling | Calling `AssumeRole` per request | Use the SDK's caching credential provider |
| 9 | Karpenter never scales, no error | Missing `karpenter.sh/discovery` tags | Check logs for `no subnets found`; add tags |
| 10 | Karpenter provisions huge instances | No `limits` or size constraints on the NodePool | Set `limits.cpu` and constrain `instance-cpu` with `Lt` |
| 11 | Certificate stuck `Ready=False` | DNS-01 self-check resolving via CoreDNS | Add `--dns01-recursive-nameservers-only` + public resolvers |
| 12 | "Too many certificates" | Let's Encrypt prod rate limit | Wait 7 days. Always develop against staging |
| 13 | ExternalDNS creates nothing | IRSA misconfigured or `domainFilters` mismatch | Check pod logs for `AccessDenied`; verify the `sub` claim |
| 14 | `kubectl` suddenly `Unable to connect` | ISP rotated your IP out of `public_access_cidrs` | `curl checkip.amazonaws.com`, update, apply |
| 15 | `terraform destroy` hangs then fails on the VPC | A Kubernetes-created NLB still holds ENIs | Delete LoadBalancer Services **first** ([Phase 15](#phase-15--teardown--rebuild-drill)) |
| 16 | Argo reverts your `kubectl edit` instantly | `selfHeal: true` working correctly | Disable auto-sync on that one app while debugging |
| 17 | New image pushed, Argo Synced, old code running | `:latest` — no manifest diff, no rollout | Immutable version tags. Always |
| 18 | Pod crashes with `EROFS` | `readOnlyRootFilesystem` + a write to `/tmp` | Mount an `emptyDir` at `/tmp` |
| 19 | Browser upload fails with an opaque network error | Bucket CORS missing, or `ETag` not exposed | Fix bucket CORS; check the OPTIONS preflight |
| 20 | `SignatureDoesNotMatch` on presigned PUT | Browser `Content-Type` differs from what was signed | Send byte-identical headers |
| 21 | NetworkPolicies have no effect | CNI isn't enforcing them | `enableNetworkPolicy: "true"` on vpc-cni, then **test** with a blocked request |
| 22 | Kubecost stuck Pending | Prometheus PVC unbound — no StorageClass | Verify the EBS CSI addon and its IRSA role |
| 23 | Charges after teardown | Unattached EIPs, orphaned EBS volumes, incomplete multipart uploads | Run the Phase 15 verification commands |
| 24 | `AccessDenied` from a pod, no detail | IRSA `sub` mismatch (wrong namespace or SA name) | Run the Phase 5 `get-caller-identity` test pod |
| 25 | Terraform error: attribute not used in a key schema | Declared a non-key attribute in `attribute {}` | DynamoDB is schemaless — only declare key and index attributes |
| 26 | `terraform apply` wipes an Argo-managed resource | Overlapping ownership | Enforce the boundary in [§3.4](#34-terraform-owns-aws-argo-cd-owns-kubernetes) |
| 27 | Upload of a large file fails at the gateway | API Gateway's **10 MB** payload limit — not adjustable on any tier | Presigned URLs only. There is no proxy fallback |
| 28 | Browser rejects a response whose CORS headers look correct | **Duplicate** `Access-Control-Allow-Origin` — API GW *and* the app both emit them | Disable CORS in the app; let API Gateway own it |
| 29 | Requests fail at ~30 s | API Gateway integration timeout, also not adjustable | Make endpoints fast; never do long work in a request |
| 30 | VPC Link deploy fails on the integration URI | `integration_uri` must be the NLB **listener** ARN, not the load balancer ARN | Use the listener ARN |
| 31 | VPC Link stuck / integration 503s | VPC Link SG has no egress to the NLB, or the NLB isn't `internal` | Fix the SG; check the NLB scheme |
| 32 | `api.<DOMAIN>` returns NXDOMAIN | ExternalDNS does **not** manage API Gateway records | That record is Terraform's — look there, not in ExternalDNS logs |
| 33 | Every API path needs a `/dev` prefix | Named stage instead of `$default` | Use the `$default` stage |
| 34 | `api.<DOMAIN>` trust errors ~30 days after a renewal | Imported ACM certs **never** auto-renew | Run the weekly re-import CronJob with the **same** `--certificate-arn` |
| 35 | `acm import-certificate` rejects the cert | cert-manager's `tls.crt` is leaf + chain concatenated | Split it: leaf → `--certificate`, rest → `--certificate-chain` |
| 36 | Browsers distrust `api.<DOMAIN>` immediately | A **staging** Let's Encrypt cert was imported into ACM | Import only after switching to `letsencrypt-prod` |
| 37 | Both nginx controllers claim every Ingress | Same `controllerValue` on both installs | Give each a distinct `controllerValue` and set `ingressClassName` on every Ingress |
| 38 | `terraform destroy` fails deleting the VPC Link | The internal NLB it targets was deleted first | Destroy the API Gateway layer **before** deleting the Services ([Phase 15](#phase-15--teardown--rebuild-drill)) |
| 39 | Cross-account access breaks with no Terraform change | The data account is **manual** — someone edited it in the console | Re-run the Phase 2 `Verify` block; nothing reconciles it |

---

## 18. Glossary

**ACME** — Automated Certificate Management Environment (RFC 8555), the protocol Let's Encrypt uses
to validate domain control and issue certificates.

**Access Entry** — The modern EKS API mapping IAM principals to Kubernetes permissions, replacing
the fragile `aws-auth` ConfigMap.

**App-of-apps** — An Argo CD Application whose source is a directory of other Applications. Lets you
bootstrap a whole platform from one object.

**Consolidation** — Karpenter's continuous re-evaluation of whether current pods could run on fewer
or cheaper nodes, replacing them if so. Its main source of savings.

**Cursor pagination** — Passing an opaque `LastEvaluatedKey` forward instead of an offset. O(1) at
any depth, unlike `OFFSET`, and the only option DynamoDB offers.

**ExternalId** — A shared string in a cross-account trust policy, designed to prevent the *confused
deputy* problem when a third party assumes a role on your behalf.

**Gateway endpoint** — A VPC endpoint implemented as a route table entry. **S3 and DynamoDB only.**
Free. Contrast with an *interface endpoint* (an ENI, billed hourly per AZ).

**GSI** — Global Secondary Index: an alternate key schema over a DynamoDB table, with its own
partition and sort key. Eventually consistent, separately billed, and the only way to query by
something other than the base key.

**HTTP API** (API Gateway) — The cheaper, faster of API Gateway's two products (~$1.00/million vs
REST's ~$3.50). Supports VPC Links to ALB/NLB/Cloud Map and native JWT authorizers; lacks usage
plans and API keys.

**Imported certificate** (ACM) — A certificate ACM stores but did not issue. Usable anywhere ACM
certs are, with one critical difference: **ACM cannot renew it**, so you must re-import on every
renewal.

**Integration** (API Gateway) — The backend a route forwards to. `HTTP_PROXY` + `VPC_LINK` is the
combination that reaches a private NLB.

**Hot partition** — A single partition key receiving a disproportionate share of traffic. The cost
of "list everything, newest first" in DynamoDB; fixed by write sharding.

**IRSA** — IAM Roles for Service Accounts. Maps a Kubernetes ServiceAccount to an IAM role via OIDC,
giving pods temporary scoped credentials with no static keys.

**Managed prefix list** — An AWS-maintained, auto-updating set of CIDR ranges for a service, usable
as a route or security-group destination. What gateway endpoints route to.

**NodePool / EC2NodeClass** — Karpenter's two CRDs: the Kubernetes-facing scheduling policy, and the
AWS-specific instance template.

**PAY_PER_REQUEST** — DynamoDB on-demand billing. Zero cost at rest, per-request cost in use. The
right default for bursty and unpredictable workloads.

**Pod Identity** — EKS's newer alternative to IRSA: an agent DaemonSet plus an association object,
with no OIDC trust policy required.

**Presigned URL** — A time-limited URL carrying a SigV4 signature granting one S3 operation on one
object. A bearer token: whoever holds it has that access until it expires.

**Projection** (GSI) — Which attributes are copied into an index: `KEYS_ONLY`, `INCLUDE`, or `ALL`.
One of the highest-leverage DynamoDB cost decisions, and invisible until the bill arrives.

**PSA** — Pod Security Admission. Built-in namespace-level enforcement of the `privileged`,
`baseline`, and `restricted` profiles.

**SigV4** — AWS Signature Version 4, the request-signing algorithm behind all AWS API auth,
including presigned URLs.

**Sync wave** — An Argo CD annotation ordering resource application, so CRDs land before the custom
resources that depend on them.

**TTL** (DynamoDB) — Automatic deletion of items past an epoch-seconds timestamp. Free garbage
collection, but **not instant** — typically within 48 hours, so your code must still check.

**TXT registry** — ExternalDNS's ownership tracking: a TXT record beside each managed record, so it
never modifies records it didn't create.

**VPC Link** — How API Gateway reaches private resources: AWS creates ENIs in *your* private
subnets, attached to a security group you control, and routes gateway traffic through them to an
internal load balancer. Nothing is exposed publicly.

---

## Appendix A — VPC Peering: why it isn't here

You originally planned VPC peering for the database. It isn't in this design, and the reason is
worth understanding because the mistake is extremely common.

**VPC peering connects two VPCs.** It's a routing relationship, not a tunnel: each side adds routes
pointing the other's CIDR at the peering connection, and security groups and NACLs still apply on
both ends.

**DynamoDB has no VPC.** It's a regional service behind a public API endpoint. There is nothing on
the other side to peer *with*. This holds for most AWS-managed services — S3, DynamoDB, SQS, SNS,
Kinesis, and the rest are accessed via API endpoints, not VPC attachments.

Two distinct problems get conflated here, and separating them is the actual lesson:

| Problem | Wrong tool | Right tool |
|---|---|---|
| "Keep traffic off the public internet" | VPC peering | **VPC endpoint** (gateway for S3/DynamoDB, interface for most others) |
| "Access another account's resources" | VPC peering | **IAM cross-account role assumption** (or a resource-based policy) |

Peering solves neither. It solves a third problem entirely: *"I have EC2 instances or an RDS
database or a self-managed service running inside another VPC, and I need IP-level connectivity to
it."*

**When you would genuinely reach for peering:**
- A self-managed database on EC2 in another VPC
- RDS, ElastiCache, MSK, or OpenSearch — these *are* VPC-attached, so a private path to them from
  another VPC does require peering, Transit Gateway, or PrivateLink
- A shared-services VPC (CI runners, monitoring, internal APIs)
- **MongoDB Atlas M10+** — which is exactly why it appeared in your original plan. Atlas runs your
  cluster in an Atlas-owned VPC, so peering is the correct mechanism there. It also requires a
  dedicated M10 tier at ~$57/mo, which is why you moved to DynamoDB.

**And when you'd prefer something else:** peering is non-transitive (A↔B and B↔C does not give
A↔C), requires non-overlapping CIDRs, and exposes whole VPCs to each other. For many cases
**PrivateLink** is better — one-directional, no CIDR coordination, no route table edits, and it
exposes a single service rather than an entire network. **Transit Gateway** is the answer once you
have more than a handful of VPCs and the peering mesh becomes unmanageable.

If you want the hands-on peering experience anyway, the cheapest honest version is: create a second
small VPC in the same account, peer it, run a `t4g.nano` in it, and prove you can reach it privately
from a pod. About $0.005/hr and an hour of your time, with none of the M10 cost.

---

## Progress Tracker

- [ ] **§6** — DynamoDB access patterns written down before anything else
- [ ] **Phase 0** — Two accounts, two profiles, tooling, repo skeleton, `.gitignore` **first**
- [ ] **Phase 1** — State bucket, media bucket + CORS + lifecycle, ECR, budget alarm
- [ ] **Phase 2** — ★ **MANUAL**: 3 tables + TTL verified, cross-account role trusting one exact ARN,
      both scripts committed, ARN + table names recorded for tfvars
- [ ] **Phase 3** — VPC, single NAT, **both** gateway endpoints, subnet tags
- [ ] **Phase 4** — EKS, Access Entries, addons, managed nodegroup, private nodes verified
- [ ] **Phase 5** — IRSA roles (app role named **exactly** `mediavault-<ENV>-api`); both identity
      hops proven; least privilege proven by the calls that *fail*
- [ ] **Phase 6** — Argo CD + app-of-apps, AppProject scoped, admin password rotated
- [ ] **Phase 7** — Karpenter: spot, consolidation, interruption queue, scale test passed
- [ ] **Phase 8** — **Two** ingress classes, two NLBs; internal NLB times out from your laptop
- [ ] **Phase 8B** — API Gateway: VPC Link, `$default` stage, throttling, CORS emitted once,
      API unreachable except through the gateway
- [ ] **Phase 9** — cert-manager, staging → prod, wildcard verified with openssl
- [ ] **Phase 9B** — LE cert imported to ACM, custom domain live, **re-import CronJob running**
- [ ] **Phase 10** — ExternalDNS with TXT registry and domain filter (`app` only — `api` is Terraform)
- [ ] **Phase 11** — ESO + SSM Parameter Store
- [ ] **Phase 12** — App built and deployed; full upload → table → play → edit → delete round trip
- [ ] **Phase 13** — Kubecost, plus one real right-sizing change driven by its data
- [ ] **Phase 14** — NetworkPolicies enforced **and tested**, PSA restricted, full audit passed
- [ ] **Phase 15** — Teardown/rebuild drill run **twice**, fully hands-off the second time

---

*Build it in order. Verify each phase before moving on. When something breaks — and it will — read
the controller's logs before changing anything. The debugging is the curriculum.*







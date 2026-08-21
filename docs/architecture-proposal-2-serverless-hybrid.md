# Proposal B — Serverless-Hybrid Architecture

> Created: 2026-11-17 | Companion to `ARCHITECTURE_RECOMMENDATION.md` ("Proposal A")
> Status: Strategic reference — not an actionable work item
> Audience: human collaborators and autonomous agents

**Read this even if you've read Proposal A.** This document is self-contained, and it revises two significant claims made in Proposal A after a stress test. Section 5 lists them explicitly.

---

## 1. Context

Pizza to the Polls (PTP) pays for pizza at polling places during elections. Two user populations:

1. **Public** — polls.pizza visitors submitting reports of long lines; donors. Traffic is extremely seasonal: near-zero most of the year, massive spikes on Election Day and during early-voting periods.
2. **Volunteers/internal** — currently served by a shared-login Retool dashboard, Zapier workflows, and HelpScout tickets.

### Current architecture

| Layer | Tech | Hosting |
|---|---|---|
| Public site | StencilJS 2.x static site | S3 + CloudFront |
| API (`pizzabase`) | Express wrapped in a single Lambda via `serverless-http`, 30s timeout | API Gateway → Lambda |
| Data | TypeORM + Aurora PostgreSQL **Data API** driver | Aurora Serverless |
| Volunteer tools | Retool (shared login), Zapier, HelpScout | SaaS |
| Auth | JWT magic links (Crust Club only) | Stateless |

### Requirements for the new volunteer platform

- Auth-protected (per-user, roles)
- Real-time collaboration (WebSockets)
- Robust job processing (replace Zapier; retries, scheduling, visibility)
- Future: agentic ordering — volunteer verifies a report, sets a budget, an LLM agent finds a restaurant and places the order with human-in-the-loop checkpoints
- Stay on AWS
- Bias toward efficiency, maintainability, low ops burden, ease of agentic development

---

## 2. Core Thesis

**Split workloads by traffic profile instead of picking one compute model.**

| Workload | Profile | Right tool |
|---|---|---|
| Public API | Anonymous, spiky, seasonal, stateless, scale-to-zero valuable | **Lambda (keep)** |
| Volunteer platform | Auth'd, low-volume, roughly constant, stateful (WS + long jobs) | **Small always-on Fargate service (new)** |

Proposal A reached the right stack for the volunteer platform (Fastify + Socket.io + BullMQ) but overreached by planning to migrate *all* public routes off Lambda and decommission it. The stress test showed the public path is exactly the workload Lambda is priced and designed for, and that moving it introduces real risk (Section 5.1).

---

## 3. Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  AWS us-west-2                                                │
│                                                               │
│  STAYS ON SERVERLESS (spiky public path)                      │
│  ┌───────────────────┐   ┌─────────────────────────────┐     │
│  │ polls.pizza       │   │ pizzabase Lambda            │     │
│  │ StencilJS static  │──▶│ Express (unchanged)         │     │
│  │ S3 + CloudFront   │   │ reports/orders/totals/      │     │
│  └───────────────────┘   │ donations/Stripe webhook    │     │
│                          └──────────┬──────────────────┘     │
│                                     │                        │
│  NEW ALWAYS-ON SERVICE (stateful volunteer path)              │
│  ┌───────────────────┐   ┌─────────────────────────────┐     │
│  │ admin.polls.pizza │   │ ECS Fargate × 1 task        │     │
│  │ React + Vite SPA  │──▶│ (ARM graviton, 0.25 vCPU /  │     │
│  │ S3 + CloudFront   │   │  0.5 GB, ~$9–12/mo)         │     │
│  └───────────────────┘   │                             │     │
│                          │ Fastify                     │     │
│                          │ ├─ HTTP API (volunteer)     │     │
│                          │ ├─ Socket.io (real-time)    │     │
│                          │ └─ BullMQ workers +         │     │
│                          │    Bull Board dashboard     │     │
│                          └──────────┬──────────────────┘     │
│                                     │                        │
│  SHARED                             ▼                        │
│  ┌──────────────────────────────────────────────────┐        │
│  │ Aurora Serverless v2 (elastic, keeps Data API    │        │
│  │ or standard pg via RDS Proxy)                    │        │
│  │ ElastiCache Redis (BullMQ + Socket.io adapter)   │        │
│  │ Clerk auth (free tier) · SQS+Lambda for          │        │
│  │ fire-and-forget jobs (email, moderation)         │        │
│  └──────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────┘
```

### Key properties

- **pizzabase Lambda is NOT decommissioned.** It keeps serving the public site indefinitely. Cold-start pain (already filed as BUG-001) is fixed with provisioned concurrency if needed (~$10–35/mo), not migration.
- **One small always-on task** hosts everything stateful. At ARM graviton pricing (0.25 vCPU / 0.5 GB) this is ~$9–12/mo — cheaper than Proposal A's $35 estimate, which assumed x86 sizing.
- **Aurora stays Aurora.** Serverless v2 scales ACUs elastically for Election Night. No migration to fixed-size RDS, which has a hard connection ceiling (see 5.1).
- **SQS + Lambda handles fire-and-forget jobs** (emails, SightEngine checks, notifications) — scale-to-zero, DLQs built in, no Redis needed for these.
- **BullMQ handles long/stateful pipelines** (agentic ordering) where 15-minute Lambda caps and Step Functions chunking get awkward.

---

## 4. Stack Choices (new service only)

Same as Proposal A, restated for completeness:

| Concern | Choice | Notes |
|---|---|---|
| Backend | Fastify | TS-first, plugin system, schema validation, `@fastify/websocket` |
| Real-time | Socket.io | Rooms, reconnection, acks; Redis adapter only if >1 task |
| Jobs | BullMQ + Bull Board | Sidekiq-equivalent; Bull Board gives the job dashboard Zapier never had |
| ORM | Drizzle | Standard pg driver, no decorators, LLM-friendly |
| Auth | Clerk | Free <10K MAU; magic links, roles, React components. Cognito rejected on DX grounds |
| Frontend | React + Vite + TanStack Query + shadcn/ui | SPA behind auth; no SSR need |
| Repo | Monorepo (`packages/api` + `packages/web`) | Shared types, atomic commits, one CI pipeline, dd-agent works one repo |
| IaC | CDK (TypeScript) for the new service | Serverless Framework stays for pizzabase |

---

## 5. Revisions to Proposal A (found via stress test)

These are the honest corrections. A reviewer should check whether the revisions themselves hold up.

### 5.1 Proposal A's RDS recommendation was unsafe for Election Night

Proposal A recommended migrating from Aurora to fixed-size RDS PostgreSQL t4g.small (~160 max connections) with pooled Fastify holding persistent connections. Under Election Night concurrency (hundreds of simultaneous report submissions), that instance becomes the bottleneck; you'd need RDS Proxy, bigger instances, or read replicas — complexity the proposal waved off. **Revision: stay on Aurora Serverless v2**, which scales elastically. The "drop the Data API" advice still applies eventually (Data API is tied to deprecated Serverless v1 patterns), but via RDS Proxy against Aurora v2, not a downsized RDS instance.

### 5.2 Proposal A's BullMQ human-in-the-loop pattern blocks workers

Proposal A showed the agent pausing to ask a volunteer a question by holding a Promise open inside a BullMQ worker until an HTTP callback resolves it. Flaw: **each pending human decision holds a worker slot.** Five unanswered "Domino's or the local place?" prompts = queue stalled at concurrency 5. You'd have to build pause/resume yourself. **Revision:** for human-wait steps, either (a) persist job state and enqueue a continuation job when the volunteer responds, or (b) acknowledge that AWS Step Functions `.waitForTaskToken` does this natively — pausing execution with zero compute cost — and use Step Functions for flows dominated by human waits. Trade-off acknowledged: Step Functions adds a second orchestration system; use it only if/when human-wait-heavy flows materialize.

### 5.3 Cost estimates were overstated for the always-on side

ARM graviton Fargate at 0.25 vCPU / 0.5 GB is ~$9–12/mo, not $35. Revised new-stack total: **~$25–40/mo** (task + Redis + RDS Proxy), versus ~$65–75/mo claimed in Proposal A.

### 5.4 What serverless still does better — kept, not migrated away

- **Scale-to-zero:** idle months cost ~$0 on Lambda vs ~$10+/mo per always-on environment. Staging environments are nearly free serverless; each always-on env doubles its footprint.
- **Zero-deploy-downtime:** single-task Fargate deploys drop WebSocket connections (Socket.io auto-reconnects, but it's a real event); zero-downtime requires 2 tasks = double cost.
- **Patching:** AWS patches Lambda runtimes; container images are your CVE problem forever.
- **Election spike absorption:** Lambda absorbs 100x spikes invisibly; always-on needs scaling policy and headroom.

---

## 6. Scorecard (workload-level)

| Concern | Winner | Why |
|---|---|---|
| Public API (spiky, seasonal) | Lambda | Scale-to-zero, no connection ceiling, invisible spikes |
| WebSocket collaboration | Tie (at this scale) | API Gateway WS works for tens of users; Socket.io is nicer DX but needs always-on compute |
| Fire-and-forget jobs | Lambda + SQS | Free at idle, DLQs built in |
| Long agent loops (>15 min) | Always-on/BullMQ | No chunking gymnastics |
| Human-in-the-loop waits | Step Functions, then BullMQ-with-persistence | `.waitForTaskToken` pauses free; BullMQ blocks a slot unless reworked (5.2) |
| Job dashboard | Bull Board | No AWS-native equivalent |
| Cold-start-sensitive UX | Always-on | Provisioned concurrency narrows but doesn't close the gap |
| Ops/patching burden | Lambda | No images, no ALB, no task definitions |
| Local dev & dd-agent ergonomics | Always-on monolith | `npm run dev` vs serverless-offline jank |
| Staging environments | Lambda | Near-free per extra env |

---

## 7. Migration Path (revised)

| Phase | Work | Risk |
|---|---|---|
| 1 | Scaffold monorepo; Fastify + Drizzle + Clerk; deploy single Fargate task behind dev domain; wire Socket.io + Redis | Low |
| 2 | Build volunteer dashboard MVP reading existing tables (Retool replacement); real-time feed | Medium |
| 3 | Replace Zapier: BullMQ pipelines for order/report/truck lifecycle; Bull Board at `/admin/queues`; move email/SightEngine to SQS+Lambda | Medium |
| 4 | Agentic ordering pilot: BullMQ pipeline calling LLM with tool access; human-in-the-loop per 5.2 pattern | Medium |
| 5 | Optional, later: provisioned concurrency on pizzabase to kill cold starts; Aurora v2 + RDS Proxy driver swap | Low |
| — | **Removed from Proposal A:** migrating public routes off Lambda; decommissioning pizzabase | — |

---

## 8. Cost Comparison

| Item | Proposal A | Proposal B (this) |
|---|---|---|
| Compute | Fargate ~$35/mo (x86 sizing) | Fargate ARM ~$9–12/mo |
| Database | Migrate to RDS t4g.small ~$20/mo (+proxy risk) | Aurora Serverless v2 (pay-per-ACU; often less than fixed RDS at this volume) |
| Redis | ~$15/mo | ~$15/mo |
| Public path | Migrated onto always-on (hidden capacity cost) | Unchanged (~$0–5/mo Lambda) |
| Auth | Clerk free tier | Clerk free tier |
| **New-stack total** | ~$65–75/mo | **~$25–40/mo** |
| Idle-season behavior | Paying 24/7 regardless | Public path ~$0; only the small task runs |

---

## 9. Open Questions for Review

1. Is keeping two backend systems (Lambda + Fastify) worse long-term than consolidating, given the team is one developer + agents? Proposal A's consolidation had real appeal.
2. Does the 5.2 revision (persist-and-continue vs Step Functions) hold up under real agentic-ordering latency, or should Step Functions be adopted from day one?
3. Aurora Serverless v2 minimum ACU cost vs plain RDS at off-season volume — is the elasticity worth it when traffic is near-zero 10 months a year?
4. Is there a cheaper Redis alternative (e.g., DynamoDB-based queue like Plane, or SQS with delay features) that removes ElastiCache entirely?
5. Single-task Fargate is a SPOF for the volunteer platform. Acceptable for a dashboard, or run 2 tasks with ALB from day one?

## 10. When to Prefer Proposal A Instead

- If Election-Night public traffic turns out to be modest (check CloudWatch metrics first — this should be measured, not assumed).
- If the team values one backend over cost/elasticity optimization.
- If agentic ordering becomes the dominant workload and everything else is noise, one always-on monolith serving all routes is simpler than two systems.

---

## References

- Proposal A: `docs/architecture-recommendation.md` (same repo)
- Reference issue: pizza-to-the-polls/democracy-delicious-agent#5
- Current repos: `polls.pizza` (StencilJS), `pizzabase` (Express/Lambda)

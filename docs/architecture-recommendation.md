# Architecture Recommendation — Volunteer Platform & Agentic Ordering

> Created: 2026-11-17 | Strategic design for the next iteration of Pizza to the Polls
> Audience: human collaborators and autonomous agents (dd-agent)

---

## 1. Current Architecture (2026)

| Layer | Tech | Hosting | Lines |
|---|---|---|---|
| Public site (`polls.pizza`) | StencilJS 2.1.1, ~30 components, static prerender | S3 + CloudFront | ~4K tsx |
| API (`pizzabase`) | Express.js in a single Lambda via `serverless-http` | API Gateway → Lambda (30s timeout) | ~6.3K source |
| ORM | TypeORM + `typeorm-aurora-data-api-driver` | Aurora PostgreSQL (Data API) | — |
| External tools | Retool (volunteer dashboard), Zapier (workflows), HelpScout (tickets) | SaaS | — |
| Auth | JWT magic links (Crust Club / Stripe portal only) | Stateless | — |

### Limitations of current stack

- **No WebSocket / real-time.** Frontend is static. Volunteers must refresh.
- **No job processing.** Lambda has a 30s hard timeout. Zapier fills the gap at a per-zap cost, with limited control.
- **No agentic capability.** Long-running LLM tool-calling loops are impossible in Lambda.
- **StencilJS is an agent-unfriendly frontend.** LLMs produce worse code for Stencil than React.
- **Retool is a shared login.** Security and cost concern. Hard to extend with custom agent workflows.
- **Cold starts.** Lambda + TypeORM init adds 2-5s latency on idle periods.
- **Aurora Data API.** Tied to Aurora Serverless v1, which AWS is deprecating.

---

## 2. Recommended Target Architecture

```
┌────────────────────────────────────────────────────────────┐
│  AWS us-west-2                                              │
│                                                             │
│  polls.pizza           admin.polls.pizza                    │
│  S3 + CloudFront       S3 + CloudFront                      │
│  StencilJS (existing)  React + Vite (new)                   │
│  ─ maintain only ─     ─ all new features ─                │
│         │                        │                          │
│         └────────┬───────────────┘                          │
│                  │                                          │
│                  ▼                                          │
│  ┌──────────────────────────────────────┐                  │
│  │  ALB → ECS Fargate (single task)     │                  │
│  │                                       │                  │
│  │  Fastify server                       │                  │
│  │  ├─ HTTP API (REST)                   │                  │
│  │  ├─ Socket.io (real-time collab)      │                  │
│  │  └─ BullMQ workers (job processing)   │                  │
│  │                                       │                  │
│  │  Drizzle ORM (standard pg driver)     │                  │
│  └──────────────┬───────────────────────┘                  │
│                 │                                           │
│        ┌────────┴────────┐                                 │
│        ▼                 ▼                                  │
│  RDS PostgreSQL    ElastiCache Redis                        │
│  (t4g.small,       (cache.t4g.micro,                        │
│   ~$20/mo)          ~$15/mo)                                │
│                                                             │
│  ──────── Eventually decommissioned ────────                │
│  Lambda pizzabase  → routes migrated to Fastify             │
│  Zapier webhooks   → BullMQ jobs                            │
│  Retool dashboard  → React volunteer UI                     │
│  Aurora Data API   → standard pg driver                     │
└────────────────────────────────────────────────────────────┘
```

### Monthly cost estimate

| Resource | Cost |
|---|---|
| ECS Fargate (0.25 vCPU / 0.5 GB) | ~$25-35 |
| RDS PostgreSQL (t4g.small, reserved) | ~$20 |
| ElastiCache Redis (cache.t4g.micro) | ~$15 |
| S3 + CloudFront (existing) | ~$5 |
| **New stack total** | **~$65-75/mo** |
| Clerk auth (free tier, < 10K MAU) | $0 |
| Lambda pizzabase (shrinks over time) | ~$0-5 |

---

## 3. Technology Choices

### 3.1 Frontend: React + Vite + React Router

**Why not keep StencilJS for the dashboard?**
- LLMs are deeply familiar with React; the dd-agent produces far better code.
- Huge ecosystem: TanStack Query, shadcn/ui, Socket.io client, React Router.
- Real-time is trivial with hooks and `useSyncExternalStore`.
- StencilJS v2 is stale (2020). The public site can stay on it indefinitely — it's static and stable.

**Why Vite over Next.js?**
- The volunteer dashboard is a SPA behind auth — no SEO, no SSR needed.
- Vite is simpler, faster builds, fewer concepts. Next.js is overkill for this.

**Component library:** shadcn/ui — accessible, copy-paste (not a dependency), customizable, well-known by LLMs.

### 3.2 Backend: Fastify (not Express)

Not an MVC framework — a web server framework, same category as Express but better:
- Built-in TypeScript generics (no `@types/express`).
- ~2x faster than Express.
- Encapsulated plugin system with dependency injection.
- Built-in JSON Schema validation on routes.
- Auto-generates OpenAPI/Swagger from route schemas.
- `@fastify/websocket` plugin — WebSocket in the same process, no separate server.

**Migration impact:** Express → Fastify is a mechanical translation. Same mental model: routes, middleware, request/response. Not a paradigm shift.

### 3.3 ORM: Drizzle (replacing TypeORM)

- Standard Postgres driver (`postgres.js`), no Data API needed.
- Better TypeScript types, no decorators, no `reflect-metadata`.
- Simpler migration tooling (`drizzle-kit`).
- LLM-friendly: queries read like SQL, not a magic query builder.
- Migration: ~200 lines of Drizzle schema to replace 8 TypeORM entities.

### 3.4 Real-time: Socket.io + Redis adapter

- Socket.io is a library (MIT, free) that runs inside the Fastify process.
- Handles WebSocket + fallback to HTTP long-polling.
- Built-in reconnection, heartbeats, rooms, message acknowledgement.
- Redis adapter only needed if scaling to multiple server instances (not needed initially).
- **AWS API Gateway WebSocket API was rejected:** requires managing connection IDs in DynamoDB, Lambda cold starts on every message, 2-hour max connection, far more complex.

### 3.5 Job Processing: BullMQ + Bull Board

- Closest Node.js equivalent to Sidekiq (Ruby).
- Redis-backed. MIT licensed. Free.
- Features: retries with exponential backoff, scheduling, priorities, concurrency, rate limiting, parent-child job flows, job progress.
- **Bull Board** is a React dashboard (mounted in the volunteer UI or as a protected route) showing all queues, job statuses, logs, retry/fail controls.
- Replaces Zapier: no per-zap cost, full control over retry logic, agent-triggerable, runs in the VPC.
- **AWS Step Functions + SQS was rejected:** more services, more glue code, no built-in dashboard, harder to debug.

### 3.6 Auth: Clerk (or Auth0)

- Clerk free tier: 10,000 MAU (well above PTP volunteer needs).
- Magic links, social login, role-based access out of the box.
- React components: `<SignIn />`, `<UserButton />` — drop in and done.
- WebSocket auth: one-liner token verification.
- **Amazon Cognito was rejected:** notoriously poor developer experience, ugly hosted UI, cryptic errors, Lambda triggers for basic flows, token size limits with groups.
- If AWS-only is a hard requirement, Cognito works but will cost significant dev time.

### 3.7 Repo Structure: Monorepo

```
new-volunteer-platform/
├── packages/
│   ├── api/           # Fastify backend
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── jobs/        # BullMQ workers
│   │   │   ├── db/          # Drizzle schema + migrations
│   │   │   └── index.ts
│   │   └── package.json
│   └── web/           # React frontend
│       ├── src/
│       │   ├── components/
│       │   ├── hooks/
│       │   └── App.tsx
│       └── package.json
├── package.json       # npm workspaces
└── tsconfig.base.json
```

Benefits: shared types across frontend/backend, atomic commits, single CI pipeline, agent works on one repo.

### 3.8 Key Library Interactions

- **TanStack Query** (frontend data cache) and **Drizzle** (backend ORM) don't interact — they live on opposite sides of the network. TanStack Query caches API responses in the browser; Drizzle generates SQL on the server.
- **Socket.io** pushes events into TanStack Query's cache via `queryClient.setQueryData()` for optimistic real-time updates.

---

## 4. Database: Keep PostgreSQL, Drop the Data API

- **Keep Aurora PostgreSQL or migrate to RDS PostgreSQL.** The data and schema are fine.
- **Drop `typeorm-aurora-data-api-driver`.** Use standard `pg` / `postgres.js` driver.
- The Data API was a workaround for Lambda's inability to maintain connection pools. ECS holds a persistent pool natively.
- Drizzle uses standard Postgres connections — no special Aurora driver needed.
- If on Aurora Serverless v1: migrate to RDS PostgreSQL (t4g.small) or Aurora Serverless v2 with standard driver.

---

## 5. Migration Path

### Phase 1: Scaffold (low risk)
- Create monorepo with Fastify skeleton + Drizzle + shared DB connection.
- Deploy to ECS behind a dev domain.
- Set up Clerk auth.
- Wire up Socket.io with Redis adapter.

### Phase 2: Volunteer Dashboard MVP
- Build React volunteer views (replacing Retool).
- Add BullMQ infrastructure.
- Auth-protect all routes.
- Real-time order/report feed via Socket.io.

### Phase 3: Replace Zapier
- Build BullMQ job pipelines for order → report → truck → order lifecycle.
- Webhook endpoints for Stripe, SightEngine (move from Lambda).
- Bull Board mounted at `/admin/queues`.

### Phase 4: Migrate Public API Routes (route by route)
- Read-only GETs first: `/totals`, `/orders`, `/locations`, `/trucks`.
- Write routes: `/order`, `/report`, `/truck`, `/upload`.
- Auth: `/session` (when Clerk or new JWT is stable).
- Webhooks last: `/webhook` (Stripe — critical revenue path).

### Phase 5: Decommission
- Delete Lambda pizzabase.
- Cancel Retool subscription.
- Cancel Zapier paid zaps.
- Remove `typeorm-aurora-data-api-driver` dependency.

---

## 6. Far-Future: Agentic Ordering

The architecture is designed to enable agent-driven food ordering — a volunteer confirms a report is legitimate, sets a budget, and an LLM agent does the rest.

### Flow

```
Volunteer clicks "Verify" → sets budget
  ↓
POST /api/reports/:id/approve
  ↓
BullMQ job enqueued: "agentic-order"
  ↓
Worker runs LLM agent loop (2-15 min):
  1. Google Maps → nearby restaurants
  2. Menu/price check
  3. Place order (API or phone)
  4. Emit progress via Socket.io:
     "Found Joe's Pizza..."
     "Placing order ($72.50)..."
     "Confirmed! ETA 3:15 PM ✓"
  ↓
Volunteer sees live updates in dashboard
```

### Human-in-the-loop

When the agent hits ambiguity (multiple restaurants, budget trade-off), it sends a WebSocket prompt to the volunteer, waits for a response via a POST endpoint, then continues. This is a `Promise` that resolves when the volunteer clicks — trivial with BullMQ's long-running jobs.

### Why this works here (and not on Lambda)

| Requirement | Lambda | ECS + BullMQ |
|---|---|---|
| Long-running agent loop | Impossible (30s timeout) | Trivial |
| Streaming progress to UI | Separate WebSocket infra + DynamoDB | Socket.io in-process |
| Human-in-the-loop | Step Functions activity tasks | Promise resolved by HTTP callback |
| Retry + backoff | Step Functions config | One line: `attempts: 5, backoff: ...` |
| Dashboard visibility | Custom CloudWatch dashboard | Bull Board + WebSocket push |

### Future additions the architecture accommodates
- Agent negotiates with restaurants directly.
- Multiple concurrent agent workers (scale ECS tasks or BullMQ concurrency).
- Agent learns from past orders (store decisions in Postgres, few-shot prompt).
- Cost tracking + budget enforcement (Drizzle query before placing).
- Post-order follow-up (scheduled BullMQ job — did the food arrive?).

---

## 7. What Stays As-Is (Indefinitely)

| Component | Action |
|---|---|
| `polls.pizza` (StencilJS public site) | Maintain only. Bug fixes, no new features. |
| Stripe (donations + Crust Club) | Keep. Move webhook handling to Fastify in Phase 4. |
| Mailgun (email) | Keep. Move integration to Fastify in Phase 3-4. |
| BugSnag (error tracking) | Keep. Add to Fastify. |
| SightEngine (content moderation) | Keep. Move webhook to Fastify. |
| S3 (report uploads) | Keep. Share between old and new backends. |
| PostgreSQL data | Keep. Add new tables for dashboard. Don't break existing schema. |

---

## 8. Comparison Summary

| Concern | Current | Recommended | Rationale |
|---|---|---|---|
| Frontend (dashboard) | Retool (shared login, per-seat cost) | React + Vite + shadcn/ui | Control, cost, agent-friendly |
| Frontend (public) | StencilJS static site | Unchanged | Works, stable, no ROI in rewrite |
| Backend framework | Express on Lambda | Fastify on ECS | WebSocket, jobs, no cold starts |
| ORM | TypeORM + Data API | Drizzle + standard pg | Simpler, typed, no deprecated API |
| Real-time | None | Socket.io + Redis | Collaborative dashboard, agent progress |
| Job processing | Zapier | BullMQ + Bull Board | No per-zap cost, full control, agent-triggerable |
| Auth | JWT (Crust Club only) | Clerk (or Auth0) | Free tier, roles, less maintenance |
| Database | Aurora PostgreSQL | RDS PostgreSQL (or keep Aurora, drop Data API) | Standard driver, predictable cost |
| IaC | Serverless Framework | CDK (TypeScript) for ECS; SF for Lambda during migration | Type-safe, same language |

---

## 9. References

- `~/Projects/DEVELOPMENT_PLAN.md` — local dev setup for existing repos
- `~/Projects/BACKLOG.md` — current backlog of bugs and features
- `~/Projects/democracy-delicious-agent/` — the dd-agent orchestrator
- `~/Projects/polls.pizza/` — current StencilJS frontend
- `~/Projects/pizzabase/` — current Express/Lambda backend
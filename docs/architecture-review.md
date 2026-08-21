# Architecture Review — Proposals A & B

> Reviewer: fresh-context review per `docs/architecture-review-brief.md`
> Date: 2026-11-17
> Verdict: **Synthesis, leaning B** — with material corrections to B's §5 revisions and to both cost models.

---

## Verdict

**Adopt Proposal B's workload split; reject parts of its §5 revisions; borrow A's database instinct back; add the ops layer both documents omit.**

Concretely:

1. **Keep the pizzabase Lambda serving the public path** (B is right, A is wrong here). Election-Day spikes are exactly what Lambda is priced for, and the public site is stable StencilJS that shouldn't be touched. Gate even this decision on *measured* CloudWatch data from the last cycle, as both docs suggest.
2. **Build the always-on Fastify + Socket.io + BullMQ service for the volunteer platform** (both agree; this part of A survives intact).
3. **Use plain RDS PostgreSQL, not Aurora Serverless v2** — reversing B's §5.1 conclusion on *cost* grounds while accepting its *connection-ceiling* critique of A. Details in Q2/Q4. RDS Proxy (or keeping the Data API short-term) solves connections for whichever DB wins.
4. **Persist agentic-workflow state in Postgres from day one**, execute steps with BullMQ continuation jobs, and defer Step Functions until a flow genuinely needs multi-day waits or parallel branches (Q6).
5. **Before Phase 2 ships, close the gaps neither doc covers**: alarms + dead-man monitoring on the single task, backup/restore discipline, secrets management, a deploy pipeline with migration strategy, and an Election freeze-window policy.

---

## Top 3 Risks of the Recommended Path

1. **The silent-death risk of a 1-task, 1-person service.** The Fargate task will die at some point (OOM, bad deploy, AZ issue) during a month when nobody is looking. Without an alarm wired to something a human actually reads, the volunteer platform is down for weeks and nobody notices until October. Mitigation is cheap (TaskCount < 1 alarm → email/Slack + auto-restart via ECS) but must exist from week one.
2. **Two systems sharing one database, deployed independently.** The old Lambda (Serverless Framework) and the new service (CDK) will both touch the same Postgres schema for years under this plan. One drizzle-kit migration that renames a column takes down the public report path on Election Day. Requires explicit backward-compatible-migration discipline (expand/contract) and a pre-Election deploy freeze — none of which is written down anywhere yet.
3. **Cost estimates that are optimistic enough to change decisions.** B's headline "$25–40/mo beats A's $65–75/mo" drove the architecture choice, but B omits the ALB (~$16–18/mo, present in A's own diagram!), understates RDS Proxy, and its Aurora-v2 claim is backwards at idle volumes (see Q4). Once corrected, B's cost advantage mostly evaporates — which means the split should be justified on *risk and workload-fit* grounds (it still is), not savings.

---

## Answers to the Six Questions

### Q1. Which proposal, and why?

**Synthesis as above.** The decisive argument is workload shape, not framework preference:

- The public API is anonymous, bursty, ten-months-idle traffic. Any always-on compute sized to absorb a 100x spike wastes money the other 300 days. Lambda is correct and B's refusal to migrate it removes A's riskiest phase (Phase 4 route-by-route cutover, ending with moving the Stripe revenue path last).
- The volunteer platform is authenticated, low-volume, constant, and increasingly stateful (WebSockets, long agent loops, Bull Board). A single small container is simpler than stitching API Gateway WebSocket + DynamoDB connection tables + Step Functions, especially for agent-authored code.
- A's genuine insight — consolidation reduces cognitive load for one developer plus agents — is real but is fully satisfied by consolidating *new* work onto one stack, without also absorbing the legacy public path.

A's plan to eventually decommission the Lambda buys almost nothing (its idle cost is ~$0) and risks a lot (the Stripe webhook is the revenue path).

### Q2. Are B's §5 revisions technically sound?

**§5.1 (Aurora over RDS): half right, wrongly concluded.**
B is correct that A's proposal — pooled persistent connections from Fastify against a t4g.small — needs connection management A waved off. But B misdiagnoses the mechanism: the constraint isn't the DB instance's horsepower (hundreds of simple INSERTs/hour is nothing for a t4g.small); it's *connection count*, which is a property of how many clients connect, not which database product they connect to. Aurora Serverless v2 does not raise any meaningful connection ceiling relative to RDS for the same client topology — both sit behind the same pool/proxy problem, and the Lambda side needs RDS Proxy (or the Data API) *either way*.

The real comparison is cost, and there B's revision fails: Aurora Serverless v2 has a **0.5 ACU minimum ≈ $44/mo, always on**, whereas db.t4g.small runs ~$25–35/mo on-demand and ~$13–18/mo reserved, with near-zero load most of the year. At PTP's profile, elasticity is worthless because the floor is above the fixed price. **Revision to the revision: plain RDS PostgreSQL (t4g.small, reserved after proving stability), RDS Proxy shared by both compute paths.** Drop the Data API when convenient — see factual corrections below; the deprecation framing is stale anyway.

**§5.2 (human-in-the-loop blocking workers): correct and important.** A's held-open Promise inside a BullMQ worker is exactly the bug described; five pending prompts stall the queue at concurrency 5, and worse, a deploy or crash silently kills all pending decisions with no durable record. B's option (a) — persist state, enqueue a continuation — is the right primitive. See Q6 for why Step Functions should stay deferred despite being natively suited.

**§5.3 (cost corrections): directionally right, arithmetically incomplete.** ARM graviton 0.25 vCPU / 0.5 GB really is ~$7–12/mo, so A's $35 line item is wrong. But B's revised total omits the ALB its own architecture diagram depends on, prices RDS Proxy optimistically, and pairs itself with an Aurora-v2 database whose minimum cost exceeds the entire claimed budget. Corrected numbers in Q4.

### Q3. What did BOTH proposals miss?

- **Observability/uptime monitoring.** BugSnag catches app exceptions, not "task is gone." No alarms, dashboards, or dead-man switch for the Fargate service. For a seasonal nonprofit this is the single highest-value missing item: the platform must be *proven alive* the week before each election, automatically.
- **Backups/DR.** Zero mention of RDS automated backups, snapshot retention, PITR, or — critically — a restore ever having been tested. Also: Redis is treated as durable infrastructure, but BullMQ jobs vanish if the cache node is replaced. Rule needed: *Postgres is the source of truth for every workflow; Redis holds only execution state that can be rebuilt.*
- **Secrets management.** Stripe, Mailgun, SightEngine, LLM API keys: no statement on Secrets Manager vs SSM Parameter Store, IAM task roles, or rotation. Given the current stack presumably has these in env vars/serverless.yml, this is debt being carried forward silently.
- **CI/CD.** "One CI pipeline" is a bullet, not a pipeline. Missing: GitHub Actions → ECR build, ECS deploy, *migration-before-deploy* semantics, and rollback. With two backends sharing a schema, the expand/contract migration discipline is mandatory, not optional.
- **Security posture.** Removing the shared Retool login is good, but unanswered: rate limiting/spam defense on public report submission (SightEngine helps but isn't auth), Stripe webhook signature verification + idempotency across two consumers sharing a DB, CORS between three origins, and role definitions beyond "Clerk metadata." Most importantly: **volunteer approval actions move money. There is no audit log requirement anywhere in either document.** Every approve/budget-set/order action needs who/when/what recorded, immutable.
- **Integration paths during migration.** Both docs casually say "move the Stripe webhook to Fastify." During the transition there are two consumers for one webhook URL — the doc must specify the cutover (single consumer; idempotent handlers keyed on Stripe event IDs; replay safety). Same for Mailgun inbound routes and the SightEngine flow — note SightEngine is currently invoked *synchronously* from pizzabase (`SightEngineController`), not via webhook, so both docs slightly mischaracterize it.
- **Retool-era data.** Neither doc asks the foundational question: *where does Retool store its data?* If Retool queries the shared Aurora directly (likely), there is no data migration — only view/workflow rebuilds, and the scope of Phase 2 shrinks dramatically. If any state lives in Retool/Zapier internals, it needs export before cancellation. Unverified assumption either way.
- **On-call/support reality.** One developer plus agents: agents cannot answer a pager, and the org's entire year compresses into a few days. Missing: an Election freeze window (no deploys N days prior), a written runbook ("task won't start: do X"), a load test/game-day before the first election on the new stack, and a decision about who receives alerts.

### Q4. Are the cost estimates realistic?

No — in both directions. Line-by-line:

| Item | Claimed | Reality |
|---|---|---|
| Fargate 0.25 vCPU/0.5 GB | A: $25–35 · B: $9–12 | **~$7–9/mo ARM** (B closest; A badly overstated) |
| ALB | **omitted by both** (A's diagram has one!) | **~$16–18/mo** + LCUs. Avoidable by using CloudFront → Fargate origin (CloudFront supports WebSockets), saving ~$16/mo |
| Database | A: RDS ~$20 · B: Aurora v2 "often less than RDS" | RDS t4g.small: ~$25–35 on-demand / ~$13–18 reserved. **Aurora v2 floor: ~$44/mo (0.5 ACU min)** — B's claim is inverted at this volume |
| RDS Proxy | B waves at it | ~$0.015–0.02/vCPU-hr against instance size ⇒ **~$10–20/mo** for a 2-vCPU class instance — not free |
| ElastiCache t4g.micro | ~$15 | ~$12–15/mo ✓ (or eliminate: see below) |
| Provisioned concurrency | B: $10–35 | Plausible, but only if cold starts matter post-fix |

**Corrected totals:** B-style stack with ALB + RDS Proxy + Aurora v2 ≈ **$90–110/mo**, i.e., *worse* than A's estimate. The same stack with RDS-reserved + CloudFront-origin (no ALB) + no proxy-on-public-path (Lambda keeps Data API short-term) ≈ **$35–50/mo**. Missing everywhere: CloudWatch logs/alarm costs (small), snapshot storage (small), data transfer, and the engineering cost of building the ops layer from Q3 — which dwarfs all of it.

Also worth pricing: **eliminating Redis entirely.** At one task, Socket.io needs no adapter, and BullMQ alternatives backed by Postgres (e.g., pg-boss) would remove the last always-on piece besides the task itself. Fewer moving parts may beat marginal throughput gains at this scale. B's own Open Question 4 deserves a "yes, seriously consider it."

### Q5. Is the single-task SPOF acceptable? Is Clerk acceptable?

**Single task: yes, conditionally.** The volunteer platform is internal, low-volume, and non-revenue (donations stay on the existing Stripe path). Downtime costs volunteer patience, not donations. Conditions: (1) auto-restart via ECS + TaskCount alarm (this makes it a minutes-outage, not a weeks-outage); (2) everything needed to rebuild the task lives in code/CDK; (3) Postgres is authoritative so no job state is lost. Correction to B §5.4: **zero-downtime does not require permanently paying for 2 tasks** — an ECS rolling deploy (`minHealthyPercent: 100, maxPercent: 200`) briefly runs a second task during deployments only. Socket.io reconnects; that's fine for an internal dashboard.

**Clerk: acceptable, with containment.** At <<10K MAU it's free; DX genuinely beats Cognito; magic links fit a volunteer audience. Risk of a startup dependency is real but bounded by one practice neither doc mentions: **isolate Clerk behind your own session layer** — verify Clerk tokens at exactly one middleware boundary, store roles in your own DB, and treat Clerk as replaceable. If Clerk stumbles, the swap is a middleware rewrite, not a product rewrite. Cognito remains the AWS-purist fallback and self-hosted auth (e.g., a maintained OSS provider in the same container) is a viable third option — but building/maintaining auth is precisely the work a one-person team should buy, not make.

### Q6. Which orchestration approach for agentic ordering?

**Bet: an explicit workflow state machine persisted in Postgres, executed by BullMQ continuation jobs (B's §5.2 option a), with Step Functions deferred.**

Reasoning against each alternative:

- **Held Promise in a worker (A):** disqualified — B's §5.2 critique is correct, and it additionally loses all pending human decisions on every deploy/crash.
- **Step Functions from day one:** `.waitForTaskToken` pauses free and survives days-long waits — genuinely the best native fit for human-in-the-loop. But: Standard Workflows add a second authoring/debugging surface that LLM agents handle worse than typed TypeScript in-repo; state lives outside the codebase; local iteration is worse; and PTP has *one* agentic flow at pilot stage. Adopting it now is optimizing for a scale that doesn't exist.
- **Raw SQS + Lambda:** workable (re-enqueue on human response; visibility timeout handles stalls) but forces manual state management and hits the 15-minute cap mid-agent-loop — exactly the gymnastics both docs want to escape.
- **Postgres state machine + BullMQ continuations:** each step is a normal short job; on completion it writes status + enqueues the next step; a human-wait step simply ends, leaving a row in `awaiting_human` that a volunteer response flips and re-enqueues from. Crashes lose nothing (state is in Postgres); Bull Board shows execution; the whole thing is one repo of typed TS that dd-agent can extend. It is also a stepping stone: if the flows later need multi-day waits or fan-out/fan-in, the state machine maps 1:1 onto Step Functions, so deferral costs little.

Design rules that make this safe regardless: every transition idempotent; every job carries the workflow ID; budget enforcement checked in Postgres *before* any spend; and the LLM loop's tool calls logged for audit.

---

## Factual Corrections

1. **"Lambda 30s hard timeout" (both docs):** `pizzabase/serverless.yml` defines functions with 60s and 120s timeouts; the 30s figure applies to some functions only. Lambda's true ceiling is 15 minutes. The architectural argument survives, but the constraint as stated is wrong.
2. **"Data API tied to deprecated Serverless v1" (both docs, esp. B §5.1):** outdated. AWS ships a Data API for Aurora Serverless v2 and provisioned Aurora. The driver-drop advice is still reasonable (simplicity, latency), but it's a preference, not a forced migration.
3. **B §5.4 "zero-downtime requires 2 tasks = double cost":** false as stated — rolling deploys run the second task transiently during deployment, not at steady state.
4. **B §5.3 / §8 cost table:** omits the ALB shown in both architecture diagrams; understates RDS Proxy; pairs with Aurora v2 whose ~$44/mo floor contradicts the "$25–40/mo total."
5. **B §5.1:** attributes Election Night risk to RDS's connection ceiling; the ceiling binds identically on Aurora for the same client topology and is solved by proxy/pooling either way.
6. **A §6 table:** cites "Step Functions activity tasks" for human-in-the-loop — Activities are the legacy mechanism; `.waitForTaskToken` on a callback pattern is current.
7. **Both docs on SightEngine:** it is invoked synchronously from pizzabase (`SightEngineController`), not purely as an inbound webhook; migration planning should reflect the actual call path.
8. **A §3.3 "~200 lines of Drizzle replacing 8 TypeORM entities":** entity count verified (Action, APIKey, Donation, Location, Order, Report, Truck, Upload) — estimate plausible.

---

## Recommended Next Steps (in order)

1. Pull last cycle's CloudWatch metrics for pizzabase (invocations, concurrency peak, duration) — settle A-vs-B on the public path with data, per B §10.
2. Confirm where Retool stores its data; this determines whether Phase 2 includes any data migration at all.
3. Write the ops baseline as an explicit Phase 1 deliverable: alarms + TaskCount alerting, RDS backup/PITR config + one tested restore, Secrets Manager for all third-party keys, CI deploy pipeline with migration gates, audit-log table for approval actions.
4. Decide database: RDS PostgreSQL reserved + RDS Proxy (recommended) vs. keeping Data API short-term; document the expand/contract migration rules for the shared schema.
5. Set the Election freeze-window policy and schedule the first game day/load test before any election on the new stack.

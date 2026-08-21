# Architecture Review Brief

> For: reviewing agent with fresh context
> Date: 2026-11-17

## Your Task

Two competing (but overlapping) architecture proposals for Pizza to the Polls' next platform iteration are in this repo:

| Doc | Thesis |
|---|---|
| `docs/architecture-recommendation.md` (**Proposal A**) | Consolidate everything onto one always-on stack: Fastify on ECS Fargate + React + Drizzle + Socket.io + BullMQ. Eventually decommission the Lambda. |
| `docs/architecture-proposal-2-serverless-hybrid.md` (**Proposal B**) | Hybrid: keep Lambda for the spiky public API; add one small always-on Fargate service only for the stateful volunteer platform. Revises two claims in A. |

Read both fully. Proposal B §5 explicitly lists where it revises Proposal A — scrutinize those revisions hardest, since they were made by the same author under self-criticism and may overcorrect.

## Background You Need

- PTP is a small nonprofit; one developer plus autonomous coding agents (this repo's dd-agent).
- Traffic is extremely seasonal: near-zero most of the year, large spikes on Election Day.
- Current pain points: shared Retool login, Zapier rigidity/cost, Lambda cold starts (BUG-001), no real-time or job infrastructure, StencilJS is agent-unfriendly.
- Hard constraints: stay on AWS; low cost matters; maintainability and agent-friendliness matter.

## Questions to Answer

1. Which proposal would you adopt, and why? You may also propose a synthesis.
2. Are Proposal B's revisions (§5.1 Aurora/RDS, §5.2 human-in-the-loop, §5.3 costs) technically sound?
3. What did BOTH proposals miss? (Consider: observability, backups/DR, secrets management, CI/CD, security posture, the SightEngine/Stripe/Mailgun integration paths, data migration for Retool-era data, on-call/support reality of a nonprofit.)
4. Are the cost estimates realistic? What's missing from them?
5. Is the single-task SPOF acceptable? Is Clerk (a startup) an acceptable dependency for a nonprofit vs Cognito vs self-hosted auth?
6. For the agentic-ordering future: which orchestration approach (BullMQ pipelines vs Step Functions vs SQS+Lambda) would you actually bet on, given 15-min Lambda caps, long human-wait periods, and LLM latency variability?

## Output Format

A written review with: verdict (A / B / synthesis), top 3 risks of your recommended path, answers to the six questions, and any corrections to factual claims in either doc. Be specific and adversarial — the goal is to find flaws before committing engineering time, not to validate either document.

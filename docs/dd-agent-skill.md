---
name: dd-agent
description: Orchestrate the Democracy Delicious autonomous coding agent for Pizza to the Polls. Use when the user wants to start work on PTP features, issues, or bug fixes across pizzabase, polls.pizza, or democracy-delicious-agent repos. Handles launching the dd-agent daemon, dispatching work for specific GitHub issues to feature branches, reviewing open PRs, and diagnosing agent state.
---

# DD Agent — Democracy Delicious Autonomous Orchestrator

Orchestrates the `democracy-delicious-agent` — a Pi-powered autonomous coding agent for Pizza to the Polls repositories.

## Repos & Locations

| Repo | Path | Role |
|------|------|------|
| `democracy-delicious-agent` | `~/Projects/democracy-delicious-agent` | The orchestrator itself |
| `pizzabase` | `~/Projects/pizzabase` | Backend API (Express, TypeORM, Lambda) |
| `polls.pizza` | `~/Projects/polls.pizza` | Frontend (StencilJS) |

Agent runtime state lives in `~/PizzaAgent/`:
- `worktrees/` — isolated git worktrees per issue
- `sessions/` — pi session transcripts
- `state/` — serialized work state (plan, phase, costs)
- `locks/` — file-based concurrency locks
- `logs/` — daemon timeline JSONL

## How It Works

The agent runs a pipeline per issue:
```
plan (read-only) → implement → checks (format/lint/typecheck/test) → independent review → push + create PR
```

If checks or review fail, the worktree is retained for `--resume` repair (up to `maxRepairCycles: 3`).

PRs target an integration branch. Child PRs merge into the integration branch; only a human merges the umbrella branch to `master`.

## Commands

All run from `~/Projects/democracy-delicious-agent/`.

### Daemon (continuous autonomous loop)

```bash
cd ~/Projects/democracy-delicious-agent && npm run agent
```
Runs indefinitely: respond → review → discover+work → repeat. Discovers issues labeled `agent:ready`, picks the oldest, works it.

Variants:
```bash
npm run agent -- daemon --once      # Single iteration then exit
npm run agent -- daemon --dry-run   # Plan only, no mutations
npm run agent -- daemon --poll 30   # Faster polling when idle
```

### Work a specific issue directly

```bash
cd ~/Projects/democracy-delicious-agent && npm run agent -- work \
  --repo pizza-to-the-polls/pizzabase \
  --issue 169 \
  --integration-branch feature/my-feature
```

Options:
- `--dry-run` — plan only, no file changes
- `--resume` — resume/repair after failure
- `--review-only` — re-run checks + review on existing worktree (requires `--resume`)
- `--integration-branch <name>` — target feature branch (child PRs merge here)

### Review open agent PRs

```bash
cd ~/Projects/democracy-delicious-agent && npm run agent -- review
cd ~/Projects/democracy-delicious-agent && npm run agent -- review --dry-run  # review only, no merge
```

### Doctor (verify setup)

```bash
cd ~/Projects/democracy-delicious-agent && npm run agent -- doctor
```

## Common Workflows

### Start work on a feature spanning multiple issues

When multiple issues should land on the same feature branch:

1. Ensure issues have the `agent:ready` label on GitHub
2. Determine the integration branch name (e.g., `feature/my-feature`)
3. Launch one `work` command per issue, all targeting the same integration branch:

```bash
# Launch in separate terminals (or backgrounded):
cd ~/Projects/democracy-delicious-agent
npm run agent -- work --repo pizza-to-the-polls/pizzabase --issue 169 --integration-branch feature/my-feature
npm run agent -- work --repo pizza-to-the-polls/pizzabase --issue 170 --integration-branch feature/my-feature
```

Concurrency limit is 2 (`globalConcurrency: 2` in `config/agent.yml`).

4. When both PRs are created and CI is green, run review:

```bash
cd ~/Projects/democracy-delicious-agent && npm run agent -- review
```

The reviewer model evaluates each PR diff and merges accepted ones into the integration branch.

### Resume a failed/stopped issue

```bash
cd ~/Projects/democracy-delicious-agent && npm run agent -- work \
  --repo pizza-to-the-polls/pizzabase \
  --issue 169 \
  --resume
```

### Clean up stale locks (after a crash or forced stop)

```bash
rm -f ~/PizzaAgent/locks/*.lock
```

### Check agent state

```bash
ls ~/PizzaAgent/state/           # See all saved plans and phases
ls ~/PizzaAgent/worktrees/       # See active worktrees
ls ~/PizzaAgent/sessions/        # See pi session transcripts
cat ~/PizzaAgent/logs/*.jsonl    # See daemon timeline
```

## Configuration

Non-secret config: `~/Projects/democracy-delicious-agent/config/agent.yml`

Key settings:
- `budget.dailyUsd: 30` — daily OpenRouter spend limit
- `limits.globalConcurrency: 2` — max parallel agents
- `limits.issueWallClockMinutes: 45` — per-issue timeout
- `limits.maxModelTurns: 30` — max LLM turns per phase
- `limits.maxRepairCycles: 3` — max repair attempts

Models (OpenRouter IDs):
- Planner: `deepseek/deepseek-v4-flash`
- Executor: `deepseek/deepseek-v4-pro`
- Reviewer: `google/gemini-2.5-flash-lite`

## How issue → integration branch resolution works

The `run` (auto-discover) command determines the integration branch from:
1. Labels on the issue: `branch:<name>` (e.g., `branch:feature/foo`)
2. Issue body text matching: `Integration branch: <name>`
3. Defaults to `master` if neither found

When running `work` directly, use `--integration-branch` to set it explicitly.

## Prerequisites

- Node.js 22+
- `~/.config/democracy-delicious/github-app.pem` (mode 600)
- `~/.config/democracy-delicious/env` (mode 600) with `OPENROUTER_API_KEY=...`
- Run `npm run build` before launching (or the first `npm run agent` will do it)

## Reference

Full docs: `~/Projects/democracy-delicious-agent/README.md`
Development plan: `~/Projects/DEVELOPMENT_PLAN.md`
Backlog: `~/Projects/BACKLOG.md`
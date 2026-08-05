# Democracy Delicious Agent 🍕 🗳️

A cost-conscious, auditable autonomous development orchestrator for Pizza to the Polls.

The project is under active bootstrap. The first implemented capability is `doctor`, which verifies the local credentials and permission boundaries before any autonomous development is enabled.

## Architecture principles

- GitHub Issues and Projects are durable workflow state.
- Every coding task runs in an isolated worktree.
- Pi is the coding harness; OpenRouter models are selected explicitly by role.
- Coding workers never receive GitHub, AWS, or production credentials.
- The orchestrator performs deterministic Git and GitHub operations.
- Child PRs may integrate into an approved feature branch after automated review.
- Only a human reviews, approves, and merges the umbrella feature PR to `master`.
- Hard cost, turn, retry, concurrency, and wall-clock limits fail closed.

## Prerequisites

- Node.js 22
- A dedicated agent workspace containing clean clones and worktrees
- GitHub App installed on the three approved repositories
- Dedicated OpenRouter API key with a provider-side spending limit
- Protected local credential files described below

## Protected local files

These files are intentionally outside the repository:

```text
~/.config/democracy-delicious/github-app.pem
~/.config/democracy-delicious/env
```

Both must be owned by the macOS account running the orchestrator and mode `600`. The directory must be mode `700`.

The environment file format is:

```dotenv
OPENROUTER_API_KEY=...
```

Never commit or print either file.

## Install

```bash
git clone https://github.com/pizza-to-the-polls/democracy-delicious-agent.git
cd democracy-delicious-agent
nvm use
npm ci
```

## Verify the setup

```bash
npm test
npm run build
npm run agent -- doctor
```

`doctor` performs live GitHub and OpenRouter authentication checks but never prints credentials.

## Commands

```bash
npm run agent -- doctor
npm run agent -- --help

# Read-only planning trial for an approved issue
npm run agent -- work \
  --repo pizza-to-the-polls/pizzabase \
  --issue 152 \
  --dry-run

# Implement, run configured checks, and perform independent review locally
npm run agent -- work \
  --repo pizza-to-the-polls/pizzabase \
  --issue 152 \
  --resume
```

`work` requires an open issue carrying `agent:ready`. It creates a clean clone and worktree under `~/PizzaAgent`; it never uses the human's active application clones. Push, PR creation, merging, and deployment are intentionally disabled in this milestone because the application repositories still deploy every non-master branch to shared staging.

Maintainer-only bootstrap helper:

```bash
npm run agent -- post-instructions
```

That helper creates the setup issue from `docs/bootstrap-issue.md` using the GitHub App. It requires the local App credential.

## Configuration

Non-secret configuration is in [`config/agent.yml`](config/agent.yml). Runtime data is stored under `~/PizzaAgent` and is excluded from Git.

## Current status

Implemented:

- GitHub App JWT authentication
- automatic installation-token refresh with five-minute safety margin
- GitHub REST and GraphQL client foundation
- protected environment loading
- configuration validation
- system `doctor`
- isolated clean clones and issue worktrees
- explicit OpenRouter planner/executor/reviewer models through the Pi SDK
- dry-run planning
- local implementation, configured checks, independent review, limits, and a recovery journal
- bootstrap issue template

Not enabled yet:

- Project queue scheduling and continuous daemon mode
- automatic repair after reviewer rejection
- child PR creation or merging
- staging deployment

See the organization Project for planned work:

https://github.com/orgs/pizza-to-the-polls/projects/1

# Agent instructions

This repository implements the autonomous development orchestrator for Pizza to the Polls.

## Safety invariants

- Never print, read into model context, commit, or log secrets.
- Never expose the GitHub App PEM, installation tokens, OpenRouter key, AWS credentials, or environment-file contents to coding workers.
- Never add production credentials or deployment authority.
- Strip personal, AWS, GitHub, and production credentials from every coding-worker subprocess.
- Coding workers may access only agent-owned clean worktrees, never the human's active development clones.
- Never permit a coding model to merge an umbrella feature PR into `master`.
- Fail closed on missing configuration, authentication, budget, policy, or repository-boundary checks.
- Keep GitHub and Git mutation in deterministic orchestrator code, not model tools.
- Default to read-only and dry-run behavior until a capability is deliberately implemented and tested.
- Keep push, PR merge, and deployment disabled until application CI no longer deploys arbitrary agent branches to shared staging.
- Explicit task inputs may be copied read-only into `.agent-inputs/`; never commit that directory.

## Development

```bash
nvm use
npm ci
npm test
npm run build
```

Use strict TypeScript. Add tests for authentication boundaries, configuration validation, budgets, recovery, and policy decisions. Do not make live destructive GitHub calls from the test suite.

## Documentation

Keep `README.md` and `docs/bootstrap-issue.md` aligned with operational changes. Public configuration may be committed; secret values and runtime state may not.

## Purpose

Set up and verify the dedicated `pizzaagent` macOS account for the Democracy Delicious Agent. This issue is the shared handoff document for the human operator and future agent sessions.

> Never paste API keys, GitHub App private keys, installation tokens, or environment-file contents into this issue or an agent conversation.

## Current GitHub resources

- Agent repository: https://github.com/pizza-to-the-polls/democracy-delicious-agent
- Organization Project: https://github.com/orgs/pizza-to-the-polls/projects/1
- GitHub App ID: `4486291`
- Installation ID: `151233951`
- Approved repositories:
  - `pizza-to-the-polls/pizzabase`
  - `pizza-to-the-polls/polls.pizza`
  - `pizza-to-the-polls/democracy-delicious-agent`

## One-time setup as the human operator

The macOS account is `pizzaagent`. It must remain a standard, non-admin account for ordinary operation.

The following files should already exist and be owned by `pizzaagent`:

```text
/Users/pizzaagent/.config/democracy-delicious/github-app.pem
/Users/pizzaagent/.config/democracy-delicious/env
```

The environment file contains the dedicated, spending-limited OpenRouter key:

```dotenv
OPENROUTER_API_KEY=...
```

Do not put `APP_ID`, `INSTALLATION_ID`, or the private key contents in the environment file. The IDs are non-secret and version controlled; the PEM stays in its separate protected file.

Expected permissions:

```bash
chmod 700 ~/.config/democracy-delicious
chmod 600 ~/.config/democracy-delicious/github-app.pem
chmod 600 ~/.config/democracy-delicious/env
```

## Setup while logged in as `pizzaagent`

Open Terminal in the `pizzaagent` account:

```bash
mkdir -p ~/Projects
cd ~/Projects

git clone https://github.com/pizza-to-the-polls/democracy-delicious-agent.git
cd democracy-delicious-agent
```

Install Node 22 using an existing preferred version manager. If no version manager is installed, install `nvm` from its official repository and then run:

```bash
nvm install 22
nvm use 22
node --version
```

Install dependencies and run local checks:

```bash
npm ci
npm test
npm run build
npm run agent -- doctor
```

A healthy doctor run should confirm:

- the PEM is readable and mode `600`
- GitHub App token exchange succeeds
- exactly the three approved repositories are visible
- GitHub Project #1 is visible
- workflows, administration, environment, and secrets permissions are absent
- additional intentionally installed GitHub capabilities are reported as warnings only
- the OpenRouter key authenticates and reports its provider-side limit
- the local environment file is mode `600`

## Updating the agent clone

```bash
cd ~/Projects/democracy-delicious-agent
git pull --ff-only
npm ci
npm test
npm run build
npm run agent -- doctor
```

## Secret handling rules

1. Never commit `.env`, `env`, PEM, key, token, or credential files.
2. Never use `cat`, debugging output, or shell tracing on secret files.
3. Never pass the GitHub App private key or installation token to a Pi coding worker.
4. The orchestrator alone mints and refreshes short-lived GitHub installation tokens.
5. Pi workers receive no `gh` login, AWS credential, or GitHub token.
6. Rotate a credential immediately if its value appears in logs, GitHub, chat, or a model context.
7. Keep production credentials entirely absent from the `pizzaagent` account.

## Troubleshooting

### `GitHub private key ... missing or unreadable`

From an administrator account:

```bash
sudo chown pizzaagent:staff /Users/pizzaagent/.config/democracy-delicious/github-app.pem
sudo chmod 600 /Users/pizzaagent/.config/democracy-delicious/github-app.pem
```

### `OPENROUTER_API_KEY is not set`

Create or repair the protected environment file from an administrator account without echoing the value into shell history. A safe interactive method is:

```bash
sudo -u pizzaagent nano /Users/pizzaagent/.config/democracy-delicious/env
sudo chmod 600 /Users/pizzaagent/.config/democracy-delicious/env
```

The file needs one line:

```dotenv
OPENROUTER_API_KEY=the-dedicated-limited-key
```

### Repository-boundary failure

Review the App installation repository selection at:

https://github.com/organizations/pizza-to-the-polls/settings/installations/151233951

It must include exactly the three approved repositories listed above.

## Completion checklist

- [ ] Operational clone exists under `/Users/pizzaagent/Projects/`
- [ ] Node 22 is active
- [ ] `npm ci` succeeds
- [ ] `npm test` succeeds
- [ ] `npm run build` succeeds
- [ ] `npm run agent -- doctor` has zero failures
- [ ] Doctor output is posted here with all token-like values omitted
- [ ] Human confirms `pizzaagent` has no AWS or production credentials

## Next engineering milestone

After bootstrap passes, implement the read-only Project scheduler and dry-run issue planner. Do not enable autonomous writes, child-PR merging, staging deployment, or parallel workers as part of this setup issue.

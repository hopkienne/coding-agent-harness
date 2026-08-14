<p align="center">
  <img src="./assets/coding-agent-harness-logo.png" width="160" alt="Coding Agent Harness logo" />
</p>

<h1 align="center">Coding Agent Harness</h1>

<p align="center">
  <strong>Install a guarded, repeatable software-delivery workflow into your coding agent.</strong>
</p>

<p align="center">
  <a href="https://github.com/hopkienne/coding-agent-harness/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-0f172a?style=flat-square" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 20 or newer" />
  <img src="https://img.shields.io/badge/workflow-human--gated-06b6d4?style=flat-square" alt="Human-gated workflow" />
</p>

`@hopkienne/coding-agent-harness` turns a coding harness into a delivery partner with explicit engineering gates:

```text
Jira requirement
      ↓
Architecture grill with a human
      ↓
ADR + implementation spec
      ↓
Confirmed GitLab technical tickets
      ↓
TDD + Chrome DevTools verification
      ↓
Spec-aware review + confirmed merge request
```

The agent moves the process forward, but it cannot silently write GitLab issues, dependencies, labels, or merge requests. Those boundaries always require a human confirmation.

## Why this exists

Coding agents are fast at producing code. Delivery quality still depends on a precise requirement, deliberate interface decisions, test evidence, and reviewable changes. This package makes that discipline portable across harnesses instead of embedding it in a single personal prompt file.

It installs:

- a `/delivery` entry point where the harness supports commands;
- a one-question-at-a-time architecture grill;
- durable documentation conventions for `CONTEXT.md`, `docs/adr/`, and `docs/specs/`;
- MCP wiring for Jira, GitLab, and Chrome DevTools;
- explicit approval gates before external GitLab writes and merge-request creation.

## Quick start

After the package is published to npm, run this from the project you want to configure:

```bash
npx @hopkienne/coding-agent-harness init
```

The interactive installer asks for the target harness, installation scope, and optional Jira/GitLab environment variables.

```text
Harness (pi, claude-code, codex, opencode) [pi]: opencode
Install scope (project, global) [project]: project
Configure Jira/GitLab environment variables now? (yes, no) [yes]: yes
```

Then start a delivery:

```text
/delivery PROJ-123 group/project
```

The agent reads the Jira issue, begins the grill, and asks exactly one material question at a time. It advances automatically after the decision is clear.

> **Before npm publish:** run the local CLI directly:
>
> ```powershell
> node .\bin\coding-agent-harness.js init
> ```

## Harness support

| Harness | Workflow entry point | MCP output | Install scope |
| --- | --- | --- | --- |
| **Pi** | `.pi/prompts/delivery.md` → `/delivery` | Pi MCP adapter configuration | Project or global |
| **Claude Code** | `.claude/commands/delivery.md` → `/delivery` | `.mcp.json` | Project or global |
| **OpenCode** | `opencode.json` → `/delivery` | Native local MCP entries in `opencode.json` | Project or global |
| **Codex** | `AGENTS.md` + `docs/agent-workflow/delivery.md` | Existing user-level MCP config is preserved | Project or global |

Codex MCP registration is intentionally deferred in `v0.1`: its shared user-level TOML can serve many unrelated projects, so the installer does not rewrite it automatically.

## What `/delivery` does

| Phase | Agent responsibility | Human control point |
| --- | --- | --- |
| 1. Discover | Reads Jira, linked requirements, code, contracts, ADRs, and current specs. | Supply missing access or context. |
| 2. Grill | Resolves material ambiguity with one focused question at a time. | Answer product and architecture decisions. |
| 3. Specify | Updates durable context, ADRs, and `docs/specs/<JIRA-KEY>.md`. | Review decisions when needed. |
| 4. Plan | Breaks the spec into small GitLab tickets and dependencies. | Confirm before any GitLab write. |
| 5. Build | Works ticket-by-ticket using RED → GREEN → refactor; verifies UI via Chrome DevTools where relevant. | Review implementation evidence. |
| 6. Review | Checks the complete diff against the spec and prepares an MR. | Confirm before MR creation. |

## MCP integrations

The installer registers the following local MCP servers where the target harness supports them:

| System | Package | Purpose |
| --- | --- | --- |
| Jira | `mcp-atlassian` via `uvx` | Read stories, acceptance criteria, and business rules. |
| GitLab | `@zereight/mcp-gitlab` via `npx` | Create technical issues, dependency links, and merge requests after confirmation. |
| Browser | `chrome-devtools-mcp` via `npx` | Exercise UI acceptance flows, check console/network errors, and capture evidence. |

Existing MCP entries are preserved when configuration files are merged.

## Secrets and environment variables

Repository configuration contains references only — never API tokens. Configure these values in your user environment or secret manager:

```text
JIRA_URL
JIRA_USERNAME
JIRA_API_TOKEN
GITLAB_API_URL
GITLAB_PERSONAL_ACCESS_TOKEN
```

On Windows, the interactive installer can save supplied values as user-level environment variables. Restart the terminal or harness after installation so it receives them. For CI and macOS/Linux, inject the values through your platform's normal secret-management mechanism.

## Commands

```bash
# Interactive setup
npx @hopkienne/coding-agent-harness init

# Preview every file change without writing
npx @hopkienne/coding-agent-harness init --harness opencode --scope project --yes --dry-run

# Show runtime prerequisites
npx @hopkienne/coding-agent-harness doctor
```

`--yes` is for non-interactive usage; provide the required environment variables before running it.

## Development

```bash
git clone https://github.com/hopkienne/coding-agent-harness.git
cd coding-agent-harness
npm test
node ./bin/coding-agent-harness.js init --harness opencode --scope project --dry-run
```

The test suite covers adapter plans, non-destructive MCP merges, idempotent instruction blocks, and an OpenCode project-install integration flow.

```text
.
├── assets/       # README identity assets
├── bin/          # npm executable entry point
├── src/          # CLI, workflow definition, and harness adapters
└── test/         # Node.js test suite
```

## Publishing from GitHub Actions

Publishing is tag-driven through [`.github/workflows/publish.yml`](./.github/workflows/publish.yml). The workflow tests, checks the package contents, verifies that the tag matches `package.json`, and publishes with npm provenance.

### First release bootstrap

1. Create the public GitHub repository `hopkienne/coding-agent-harness`, add it as `origin`, and push `main`.
2. In npm, create a **granular** token with package publish permission and **bypass 2FA** enabled. Add it to the GitHub repository as the `NPM_TOKEN` Actions secret. This is only a bootstrap credential.
3. Create and push the release tag:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

4. Confirm that the GitHub Actions `Publish npm package` run succeeds and that `https://www.npmjs.com/package/@hopkienne/coding-agent-harness` is public.

### Switch to trusted publishing

After the first publish, configure npm **Trusted Publishing** for GitHub Actions in the package settings:

```text
Organization/user: hopkienne
Repository: coding-agent-harness
Workflow filename: publish.yml
Allowed action: npm publish
```

The workflow already grants `id-token: write`, so npm can use OIDC and generate provenance without a long-lived token. Run one release through Trusted Publishing, then delete the `NPM_TOKEN` GitHub secret. You can additionally set the npm package to require 2FA and disallow traditional tokens.

## License

[MIT](./LICENSE) © HopKienne

export const MATT_POCOCK_SKILL_COMMANDS = new Set([
  "grill-with-docs",
  "wayfinder",
  "to-spec",
  "to-tickets",
  "implement",
  "tdd",
  "code-review",
  "diagnosing-bugs",
  "improve-codebase-architecture"
]);

export const MATT_POCOCK_WORKFLOW_SKILLS = [
  ...MATT_POCOCK_SKILL_COMMANDS,
  "domain-modeling",
  "codebase-design",
  "grilling",
  "research",
  "prototype"
];

export const MATT_POCOCK_AGENT_SKILLS_BLOCK = `
## Agent skills

### Issue tracker

Jira is the business-requirement source; GitLab holds technical delivery tickets and merge requests. See \`docs/agents/issue-tracker.md\`.

### Triage labels

Use the configured canonical label vocabulary. See \`docs/agents/triage-labels.md\`.

### Domain docs

Use the repository's single-context domain documentation. See \`docs/agents/domain.md\`.
`;

export const MATT_POCOCK_SETUP_FILES = {
  "issue-tracker.md": `# Issue tracker: Jira requirements and GitLab delivery

Jira is the source of business requirements, acceptance criteria, and product decisions. GitLab issues hold the technical delivery plan; GitLab merge requests hold the implementation review.

## Operations

- Read Jira requirements and links through the configured Jira MCP server.
- Read GitLab issues and merge requests through the configured GitLab MCP server.
- When a skill says to publish a delivery ticket, propose the complete GitLab issue plan first. Create, label, link, assign, or change GitLab issues only after the human explicitly confirms the shown plan.
- When a skill says to fetch a relevant ticket, read the linked GitLab issue and its Jira/spec/ADR context.
- When a skill says to publish a spec, create or update \`docs/specs/<JIRA-KEY>.md\`; do not publish external tracker state without confirmation.
- Infer the GitLab project from the git remote when available; otherwise ask for its \`group/project\` path.

## Merge requests

Prepare a review preview containing the ticket, Jira/spec links, verification evidence, rollout notes, and risks. Create a GitLab merge request only after the human explicitly confirms that preview.
`,
  "triage-labels.md": `# Triage labels

The engineering skills use these canonical roles. Map them to the exact GitLab labels used by this repository before applying labels; never create missing labels without explicit human approval.

| Canonical role | GitLab label | Meaning |
| --- | --- | --- |
| \`needs-triage\` | \`needs-triage\` | A maintainer must evaluate the issue. |
| \`needs-info\` | \`needs-info\` | Waiting for clarification from the reporter. |
| \`ready-for-agent\` | \`ready-for-agent\` | Fully specified and ready for an agent. |
| \`ready-for-human\` | \`ready-for-human\` | Requires human implementation. |
| \`wontfix\` | \`wontfix\` | Will not be actioned. |
`,
  "domain.md": `# Domain documentation

Before exploring a change, read the repository-root \`CONTEXT.md\` when it exists and the relevant decisions in \`docs/adr/\`. If a root \`CONTEXT-MAP.md\` exists, use it to locate the relevant context instead.

Use established glossary terms in issue titles, specifications, tests, and proposals. Surface an ADR conflict explicitly rather than silently overriding it. Missing domain files are not a blocker: create or update them only when a real term or architectural decision has been resolved.

This repository starts as a single-context layout: one root \`CONTEXT.md\` and \`docs/adr/\`. A future \`CONTEXT-MAP.md\` can opt the repository into multi-context documentation.
`
};

function defineCommand(description, argumentHint, template, { preferMattPocockSkill = false, originalSkillName } = {}) {
  const originalSkillPreamble = preferMattPocockSkill
    ? `\n\nIf the original Matt Pocock \`${originalSkillName}\` skill is installed and discoverable, load and follow its SKILL.md as the primary procedure. Do not recursively invoke this command by name. This harness's explicit human-confirmation rules for GitLab writes and merge requests always still apply.`
    : "";
  return {
    description,
    argumentHint,
    template: `${template.trim()}${originalSkillPreamble}`,
    markdown: `---\ndescription: ${description}\nargument-hint: "${argumentHint}"\n---\n${template.trim()}${originalSkillPreamble}\n`
  };
}

export function commandTemplateForHarness(command, harness) {
  if (harness === "pi") return command.template.replaceAll("$ARGUMENTS", "$@");
  if (harness === "codex") {
    return command.template.replaceAll(
      "$ARGUMENTS",
      "the complete natural-language request provided by the human alongside this workflow instruction"
    );
  }
  return command.template;
}

export function commandMarkdownForHarness(command, harness) {
  return `---\ndescription: ${command.description}\nargument-hint: "${command.argumentHint}"\n---\n${commandTemplateForHarness(command, harness)}\n`;
}

export const WORKFLOW_COMMANDS = {
  delivery: defineCommand(
    "Orchestrate the complete guarded Jira-to-GitLab delivery workflow",
    "<request containing a JIRA-KEY and optional instructions>",
    `You are the delivery orchestrator.

Full user request:
$ARGUMENTS

Interpret the complete request before taking action:

- Extract exactly one Jira issue key matching the usual PROJECT-123 form, wherever it appears in the request. Never assume the first word is the Jira key.
- Treat a value as an explicit GitLab project only when the human identifies it as such or it clearly has a namespace/project form. Otherwise inspect the current repository's git remote and infer the full namespace/project path, preserving nested subgroups and removing the host and trailing .git. Ask only when no unambiguous GitLab remote exists.
- Detect and follow explicit communication preferences, including the requested response language, for the entire workflow.
- Preserve the remaining text as delivery constraints or additional instructions unless it conflicts with the guarded workflow and human-approval rules.
- If no Jira key is present, ask for it. If multiple Jira keys are present and the intended primary issue is ambiguous, ask which one to use. Do not begin delivery with a guessed key.

Use the extracted Jira key as JIRA_KEY throughout. Execute this workflow in the current conversation; do not ask the human to invoke other slash commands.

Maintain a compact phase ledger in every response: phase, evidence, next action, and human decision needed.

1. Read Jira, linked requirements, repository context, contracts, ADRs, and existing specs.
2. Run the architecture grill and resolve one material ambiguity at a time.
3. Update CONTEXT.md, focused ADRs, and docs/specs/<JIRA_KEY>.md (replacing the placeholder with the extracted key) with traced acceptance criteria, contracts, tests, rollout, and risks.
4. Propose small GitLab tickets and obtain explicit confirmation immediately before any GitLab write.
5. Implement approved tickets with RED → GREEN → refactor. Verify UI acceptance criteria through Chrome DevTools when relevant.
6. Review against Jira/spec/ADRs, present an MR preview, and obtain explicit confirmation before creating the GitLab merge request.

Never create GitLab resources or a merge request without the named confirmation. If blocked, state the current phase, evidence gathered, and one smallest decision or input needed.`
  ),
  "grill-with-docs": defineCommand(
    "Resolve Jira and architecture ambiguity, then record durable decisions",
    "<JIRA-KEY>",
    `For Jira $1, read the Jira issue, linked material, repository context, contracts, ADRs, and relevant specs before proposing a solution.

Run an architecture grill: ask exactly one highest-risk material question at a time, wait for the human answer, acknowledge the decision, and never repeat settled questions. Resolve interface, authorization, failure behavior, migration/rollout, ownership, observability, and data-consistency ambiguity.

When a decision is clear, update CONTEXT.md when terminology changes and create focused docs/adr/ records. Do not create GitLab resources in this command. Finish with decisions made, unresolved risks, and the recommended next command.`,
    { preferMattPocockSkill: true, originalSkillName: "grill-with-docs" }
  ),
  wayfinder: defineCommand(
    "Map an unfamiliar or oversized initiative into evidence-backed investigations",
    "<JIRA-KEY, product area, or architectural question>",
    `Use $1 to map an unfamiliar or oversized initiative before proposing implementation. Read Jira where available, repository architecture, module boundaries, contracts, data ownership, deployment/operational evidence, existing ADRs, specs, and related GitLab work.

Create a concise project map: user/business outcome, affected modules, unknowns, interfaces, data and authorization boundaries, risks, and evidence gaps. Break uncertainty into the smallest independent investigation slices with a clear question, evidence to collect, expected decision, and owner. Do not create GitLab tickets until the human explicitly confirms the proposed investigation or delivery plan.

Finish by recommending whether to continue with /grill-with-docs, /to-spec, or a specific investigation.`,
    { preferMattPocockSkill: true, originalSkillName: "wayfinder" }
  ),
  "to-spec": defineCommand(
    "Create a durable implementation spec from a Jira requirement and decisions",
    "<JIRA-KEY>",
    `Create or update docs/specs/$1.md from the Jira requirement, repository evidence, and architecture decisions. If material ambiguity remains, stop and ask one focused question instead of inventing a decision.

The spec must trace acceptance criteria and include scope, non-goals, contracts, data and authorization rules, failure behavior, rollout/migration, observability, test plan, UI verification plan where relevant, risks, and Jira links. Summarize the spec and ask the human to review it before creating GitLab tickets.`,
    { preferMattPocockSkill: true, originalSkillName: "to-spec" }
  ),
  "to-tickets": defineCommand(
    "Turn an approved spec into small, dependency-aware GitLab technical tickets",
    "<JIRA-KEY> [group/project]",
    `Read docs/specs/$1.md and the linked Jira acceptance criteria. Use $2 as the GitLab project path when supplied; otherwise infer the full namespace/project path from the current repository's GitLab remote. Ask only if it is missing or ambiguous. Propose a complete list of tracer-bullet GitLab tickets for that project. Each ticket must have a narrow outcome, acceptance criteria, test evidence, labels, dependencies, and links to Jira/spec.

Show the full ticket and dependency plan first. Ask for explicit confirmation immediately before creating, labeling, linking, or changing any GitLab issue. After confirmation, create only the approved plan and report every resulting URL.`,
    { preferMattPocockSkill: true, originalSkillName: "to-tickets" }
  ),
  implement: defineCommand(
    "Implement one approved GitLab ticket with evidence and no hidden scope expansion",
    "<GitLab issue or ticket reference>",
    `Read the selected GitLab ticket, linked spec, Jira acceptance criteria, architecture rules, and existing code before changing anything. State the intended narrow scope and any assumptions.

Implement only the ticket. First write or identify the focused failing test, run it, make the smallest correct change, run relevant checks, and refactor only when behavior stays covered. For UI work, perform the verify-ui protocol before completion. Report changed files, tests run, evidence, remaining risks, and any follow-up ticket needed. Do not create a merge request in this command.`,
    { preferMattPocockSkill: true, originalSkillName: "implement" }
  ),
  tdd: defineCommand(
    "Apply a strict RED → GREEN → REFACTOR loop to the current change",
    "[feature, bug, or test scope]",
    `Apply TDD to $1. Identify the behavior and its acceptance criterion, then write the smallest focused failing unit or integration test and run it to demonstrate RED. Implement the smallest production change that makes it pass, run GREEN, then refactor only while all relevant tests remain green.

Report the exact commands, RED evidence, GREEN evidence, changed behavior, and any test gap. Do not claim verification that was not run.`,
    { preferMattPocockSkill: true, originalSkillName: "tdd" }
  ),
  "verify-ui": defineCommand(
    "Verify UI acceptance criteria through Chrome DevTools MCP",
    "<URL or user flow>",
    `Use Chrome DevTools MCP to verify $1 against the linked Jira/spec acceptance criteria. Start or confirm the required local application, exercise the real user flow, inspect console errors, failed network requests, responsive/visual behavior, and capture useful screenshots or evidence.

Report the exact steps performed, pass/fail result per criterion, browser console/network findings, evidence locations, and the smallest next fix if verification fails. Do not create a merge request in this command.`
  ),
  "code-review": defineCommand(
    "Review the current diff against the spec, architecture, tests, and maintainability",
    "[diff, branch, or scope]",
    `Review $1 against Jira acceptance criteria, docs/specs, ADRs, module boundaries, authorization rules, failure behavior, tests, and UI evidence. Inspect the complete diff and identify concrete correctness, security, regression, performance, maintainability, and Fowler-smell findings.

Return findings ordered by severity with file and line references where possible. Separate blocking findings, non-blocking improvements, and verified strengths. Do not create a merge request or modify code unless the human asks.`,
    { preferMattPocockSkill: true, originalSkillName: "code-review" }
  ),
  "create-mr": defineCommand(
    "Prepare and create a GitLab merge request only after human confirmation",
    "<source branch> [target branch]",
    `Before creating an MR from $1 to $2, read the GitLab ticket, Jira/spec/ADR context, complete diff, test results, and UI verification evidence. Perform the code-review protocol if a current review is absent.

Prepare an MR preview containing title, description, linked issues, implementation summary, test commands/results, UI evidence, rollout or migration notes, risks, and reviewer checklist. Ask for explicit confirmation immediately before the GitLab write. Create the MR only after confirmation and report its URL.`
  ),
  "diagnosing-bugs": defineCommand(
    "Diagnose a bug systematically before proposing a fix",
    "<symptom, issue, or reproduction>",
    `Diagnose $1 with a disciplined loop: capture expected and actual behavior, establish a minimal reproducible case, gather logs/traces/tests, narrow the failure boundary, inspect recent changes and contracts, then state the most likely cause with evidence.

Do not guess or patch blindly. When the cause is sufficiently supported, propose the smallest fix and a regression test. Ask for confirmation before a broad, risky, or external-state-changing fix. Report reproduction commands, evidence, root cause confidence, and verification plan.`,
    { preferMattPocockSkill: true, originalSkillName: "diagnosing-bugs" }
  ),
  "improve-codebase-architecture": defineCommand(
    "Assess and incrementally improve module boundaries and architecture",
    "[module or architectural concern]",
    `Assess $1 using repository evidence: module boundaries, dependency direction, contracts, data ownership, authorization, side effects, test seams, and operational concerns. Compare the current state with documented architecture and identify concrete debt rather than generic cleanup.

Propose an incremental, reversible improvement plan with expected benefit, risks, migration path, tests, and ownership. Ask for human confirmation before modifying architecture or creating GitLab tickets. Do not combine unrelated refactors.`,
    { preferMattPocockSkill: true, originalSkillName: "improve-codebase-architecture" }
  )
};

export const DELIVERY_COMMAND = WORKFLOW_COMMANDS.delivery.markdown;

export const WORKFLOW_INSTRUCTIONS = `
## Guarded delivery workflow

Use the installed Jira → architecture → spec → GitLab → TDD/UI verification → review/MR workflow. Jira is the source of business requirements; do not create or change GitLab issues, dependencies, labels, or merge requests until the human explicitly approves the shown preview.

### Installed commands

- \`/delivery <request containing a JIRA-KEY and optional instructions>\` — run the end-to-end guarded workflow from either concise arguments or a natural-language request; infer the GitLab project from the remote when omitted.
- \`/grill-with-docs <JIRA-KEY>\` — resolve ambiguity and write durable decisions.
- \`/wayfinder <area>\` — map a large or unfamiliar initiative into investigations.
- \`/to-spec <JIRA-KEY>\` — create the traced implementation spec.
- \`/to-tickets <JIRA-KEY> [group/project]\` — propose and, after confirmation, create GitLab tickets.
- \`/implement <issue>\` and \`/tdd [scope]\` — build with RED → GREEN → refactor.
- \`/verify-ui <URL-or-flow>\` — test UI with Chrome DevTools MCP.
- \`/code-review [scope]\` and \`/create-mr <branch> [target]\` — review, then create an approved MR.
- \`/diagnosing-bugs <symptom>\` — reproduce, narrow, and verify bug fixes.
- \`/improve-codebase-architecture [area]\` — plan architecture improvements incrementally.

Keep durable decisions in CONTEXT.md, docs/adr/, and docs/specs/. Report exact verification results; never claim a test or UI check that was not run.
`;

export function standardMcpServers() {
  return {
    jira: {
      command: "uvx",
      args: ["mcp-atlassian"],
      env: {
        JIRA_URL: "${JIRA_URL}",
        JIRA_USERNAME: "${JIRA_USERNAME}",
        JIRA_API_TOKEN: "${JIRA_API_TOKEN}"
      },
      lifecycle: "lazy"
    },
    gitlab: {
      command: "npx",
      args: ["-y", "@zereight/mcp-gitlab@2.1.29"],
      env: {
        GITLAB_API_URL: "${GITLAB_API_URL}",
        GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_PERSONAL_ACCESS_TOKEN}"
      },
      lifecycle: "lazy"
    },
    "chrome-devtools": {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@1.7.0"],
      lifecycle: "lazy"
    }
  };
}

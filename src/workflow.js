export const DELIVERY_COMMAND = `---
description: Orchestrate a guarded Jira-to-GitLab delivery workflow
argument-hint: "<JIRA-KEY> [GitLab project path]"
---
You are the delivery orchestrator for Jira $1 and GitLab project \`\${2:-the configured GitLab project}\`. Execute this workflow in the current conversation; do not ask the human to invoke other slash commands.

Maintain a compact phase ledger in every response: phase, evidence, next action, and human decision needed.

1. Read Jira, linked requirements, repository context, contracts, ADRs, and existing specs.
2. Before specification or code, run an architecture grill. Ask exactly one highest-risk material question at a time, wait for the answer, acknowledge the decision, and do not repeat settled questions. Complete only after interface, authorization, failure, migration/rollout, ownership, and observability ambiguities are resolved.
3. Update CONTEXT.md when terminology changes; write focused ADRs and docs/specs/$1.md with traced acceptance criteria, contracts, test plan, rollout, and risks.
4. Propose small GitLab tickets with scope, criteria, tests, labels, dependencies, and Jira/spec links. Show the entire plan and obtain explicit confirmation immediately before any GitLab write.
5. Implement approved tickets serially. For each: write a focused failing test, run RED, make the smallest correct change, run GREEN and relevant checks, then refactor safely. For UI work, exercise acceptance criteria with Chrome DevTools MCP and inspect console/network failures.
6. Review the complete change against Jira/spec/ADRs. Present an MR preview with links, evidence, and risks. Obtain explicit confirmation immediately before creating the GitLab merge request.

Never create GitLab resources or a merge request without the named confirmation. If blocked, state the current phase, the evidence gathered, and the one smallest decision or input needed.`;

export const WORKFLOW_INSTRUCTIONS = `
## Guarded delivery workflow

Use the installed delivery workflow for Jira -> architecture grill -> durable specification -> GitLab tickets -> TDD/UI verification -> review/MR.

- Jira is the source of business requirements. Read its acceptance criteria before proposing implementation.
- In the grill, ask one material question at a time and wait for the human answer.
- Do not create or change GitLab issues, dependencies, labels, or merge requests until the human explicitly approves the shown preview.
- Keep durable engineering decisions in CONTEXT.md, docs/adr/, and docs/specs/.
- Write a failing test before production code and report exact verification results.
- For UI changes, use Chrome DevTools MCP to exercise acceptance criteria and report console/network failures.
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

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  MATT_POCOCK_AGENT_SKILLS_BLOCK,
  MATT_POCOCK_SETUP_FILES,
  WORKFLOW_COMMANDS,
  WORKFLOW_INSTRUCTIONS,
  commandMarkdownForHarness,
  commandTemplateForHarness,
  standardMcpServers
} from "./workflow.js";

function joinInstructions(existing = "") {
  if (existing.includes("## Guarded delivery workflow")) return existing;
  return `${existing.trimEnd()}\n${WORKFLOW_INSTRUCTIONS}`.trimStart();
}

function joinAgentSkills(existing = "") {
  if (existing.includes("## Agent skills")) return existing;
  return `${existing.trimEnd()}\n${MATT_POCOCK_AGENT_SKILLS_BLOCK}`.trimStart();
}

const JIRA_AUTH_ENV_KEYS = ["JIRA_USERNAME", "JIRA_API_TOKEN", "JIRA_PERSONAL_TOKEN"];

function mergeManagedServer(existing = {}, generated = {}, name) {
  const existingEnvironment = { ...(existing.env ?? existing.environment) };
  if (name === "jira") for (const key of JIRA_AUTH_ENV_KEYS) delete existingEnvironment[key];
  const generatedEnvironment = generated.env ?? generated.environment;
  const environmentKey = "environment" in generated ? "environment" : "env";
  return {
    ...existing,
    ...generated,
    [environmentKey]: { ...existingEnvironment, ...generatedEnvironment }
  };
}

function mergeServers(existing = {}, generated = standardMcpServers()) {
  const merged = { ...existing };
  for (const [name, server] of Object.entries(generated)) {
    merged[name] = mergeManagedServer(existing[name], server, name);
  }
  return merged;
}

const GITIGNORE_START = "# >>> coding-agent-harness >>>";
const GITIGNORE_END = "# <<< coding-agent-harness <<<";

function mergeGitignore(existing = "", entries = []) {
  const existingEntries = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = [...new Set(entries)].filter((entry) => !existingEntries.has(entry));
  if (missing.length === 0) return existing;

  if (existing.includes(GITIGNORE_START) && existing.includes(GITIGNORE_END)) {
    return existing.replace(GITIGNORE_END, `${missing.join("\n")}\n${GITIGNORE_END}`);
  }

  const prefix = existing.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${GITIGNORE_START}\n${missing.join("\n")}\n${GITIGNORE_END}\n`;
}

export function buildInstallPlan({ harness, scope, cwd = process.cwd(), home = os.homedir(), includeMattPocockSetup = false, jiraAuthMode = "cloud", jiraUrl = "", gitLabApiUrl = "" }) {
  if (!["pi", "claude-code", "opencode", "codex"].includes(harness)) {
    throw new Error(`Unsupported harness: ${harness}`);
  }
  if (!["project", "global"].includes(scope)) {
    throw new Error(`Unsupported scope: ${scope}`);
  }

  const root = scope === "project" ? cwd : home;
  const mcpServers = standardMcpServers({ jiraAuthMode, jiraUrl, gitLabApiUrl });
  const plan = { harness, scope, root, writes: [], notes: [] };
  const projectIgnoreEntries = new Set();
  const writeText = (file, content, kind = "text") => plan.writes.push({ file, content, kind });
  const writeJson = (file, value) => plan.writes.push({ file, value, kind: "json" });
  const installPiPackage = (file, packageSource) => plan.writes.push({ file, packages: [packageSource], kind: "pi-settings" });
  const ignoreProjectPaths = (...entries) => {
    if (scope === "project") for (const entry of entries) projectIgnoreEntries.add(entry);
  };
  const writeCommandFiles = (commandDir) => {
    for (const [name, command] of Object.entries(WORKFLOW_COMMANDS)) {
      writeText(path.join(commandDir, `${name}.md`), commandMarkdownForHarness(command, harness));
    }
  };

  if (harness === "pi") {
    const agentDir = scope === "global" ? path.join(home, ".pi", "agent") : path.join(cwd, ".pi");
    const instructionFile = scope === "global" ? path.join(agentDir, "AGENTS.md") : path.join(cwd, "AGENTS.md");
    writeCommandFiles(path.join(agentDir, "prompts"));
    installPiPackage(path.join(agentDir, "settings.json"), "npm:pi-mcp-adapter@2.23.0");
    writeJson(path.join(agentDir, "mcp.json"), { mcpServers });
    writeText(instructionFile, WORKFLOW_INSTRUCTIONS, "instructions");
    ignoreProjectPaths("/.pi/", "/AGENTS.md");
    plan.notes.push("Restart Pi so it installs/loads npm:pi-mcp-adapter@2.23.0, then use /delivery. Pi exposes Jira, GitLab, and browser capabilities through its single lazy mcp proxy tool. Commands installed: /delivery, /grill-with-docs, /wayfinder, /to-spec, /to-tickets, /implement, /tdd, /verify-ui, /code-review, /create-mr, /diagnosing-bugs, /improve-codebase-architecture.");
  }

  if (harness === "claude-code") {
    const claudeDir = scope === "global" ? path.join(home, ".claude") : path.join(cwd, ".claude");
    const instructionFile = scope === "global" ? path.join(claudeDir, "CLAUDE.md") : path.join(cwd, "CLAUDE.md");
    writeCommandFiles(path.join(claudeDir, "commands"));
    writeJson(path.join(scope === "global" ? claudeDir : cwd, ".mcp.json"), { mcpServers });
    writeText(instructionFile, WORKFLOW_INSTRUCTIONS, "instructions");
    ignoreProjectPaths("/.claude/", "/.mcp.json", "/CLAUDE.md");
    plan.notes.push("Restart Claude Code. Commands installed: /delivery, /grill-with-docs, /wayfinder, /to-spec, /to-tickets, /implement, /tdd, /verify-ui, /code-review, /create-mr, /diagnosing-bugs, /improve-codebase-architecture.");
  }

  if (harness === "opencode") {
    const configDir = scope === "global" ? path.join(home, ".config", "opencode") : cwd;
    const configFile = path.join(configDir, "opencode.json");
    writeJson(configFile, {
      $schema: "https://opencode.ai/config.json",
      command: Object.fromEntries(Object.entries(WORKFLOW_COMMANDS).map(([name, command]) => [name, {
        description: command.description,
        template: commandTemplateForHarness(command, harness)
      }])),
      mcp: Object.fromEntries(Object.entries(mcpServers).map(([name, server]) => [name, {
        type: "local",
        command: [server.command, ...server.args],
        environment: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [
          key,
          value === `\${${key}}` ? `{env:${key}}` : value
        ])),
        disabled: false
      }]))
    });
    writeText(path.join(configDir, "AGENTS.md"), WORKFLOW_INSTRUCTIONS, "instructions");
    ignoreProjectPaths("/opencode.json", "/AGENTS.md");
    plan.notes.push("Restart OpenCode. Commands installed: /delivery, /grill-with-docs, /wayfinder, /to-spec, /to-tickets, /implement, /tdd, /verify-ui, /code-review, /create-mr, /diagnosing-bugs, /improve-codebase-architecture.");
  }

  if (harness === "codex") {
    const instructionFile = scope === "global" ? path.join(home, ".codex", "AGENTS.md") : path.join(cwd, "AGENTS.md");
    writeText(instructionFile, WORKFLOW_INSTRUCTIONS, "instructions");
    writeCommandFiles(path.join(root, "docs", "agent-workflow"));
    ignoreProjectPaths("/AGENTS.md", "/docs/agent-workflow/");
    plan.notes.push("Codex uses the installed AGENTS.md workflow. Execute the matching docs/agent-workflow/<command>.md instruction for the desired workflow step.");
    plan.notes.push("Codex MCP registration is intentionally not auto-written in v0.1 because its user-level TOML is shared across projects; use your existing MCP configuration or add servers through Codex.");
  }

  if (includeMattPocockSetup) {
    const skillInstructionFile = fs.existsSync(path.join(cwd, "CLAUDE.md"))
      ? path.join(cwd, "CLAUDE.md")
      : path.join(cwd, "AGENTS.md");
    writeText(skillInstructionFile, MATT_POCOCK_AGENT_SKILLS_BLOCK, "agent-skills");
    for (const [name, content] of Object.entries(MATT_POCOCK_SETUP_FILES)) {
      writeText(path.join(cwd, "docs", "agents", name), content, "create-if-missing");
    }
    if (scope === "project") {
      ignoreProjectPaths(
        `/${path.relative(cwd, skillInstructionFile).replaceAll("\\", "/")}`,
        "/.agents/",
        "/skills-lock.json",
        "/docs/agents/"
      );
    }
    plan.notes.push("Matt Pocock engineering-skill configuration was bootstrapped for this repository: Jira requirements, GitLab delivery, triage labels, and domain-document conventions.");
  }

  if (scope === "project") {
    plan.writes.push({
      file: path.join(cwd, ".gitignore"),
      kind: "gitignore",
      entries: [...projectIgnoreEntries]
    });
    plan.notes.push("Project-local workflow artifacts were added to .gitignore so new generated files stay untracked.");
  }

  return plan;
}

export function buildUninstallPlan({ harness, scope, cwd = process.cwd(), home = os.homedir() }) {
  if (!["pi", "claude-code", "opencode", "codex"].includes(harness)) {
    throw new Error(`Unsupported harness: ${harness}`);
  }
  if (!["project", "global"].includes(scope)) {
    throw new Error(`Unsupported scope: ${scope}`);
  }

  const plan = { harness, scope, removals: [], notes: [] };
  const removeFile = (file) => plan.removals.push({ file, kind: "file" });
  const removeInstructions = (file) => plan.removals.push({ file, kind: "instructions" });
  const removeCommandFiles = (commandDir) => {
    for (const name of Object.keys(WORKFLOW_COMMANDS)) removeFile(path.join(commandDir, `${name}.md`));
  };

  if (harness === "pi") {
    const agentDir = scope === "global" ? path.join(home, ".pi", "agent") : path.join(cwd, ".pi");
    removeCommandFiles(path.join(agentDir, "prompts"));
    removeInstructions(scope === "global" ? path.join(agentDir, "AGENTS.md") : path.join(cwd, "AGENTS.md"));
  }
  if (harness === "claude-code") {
    const claudeDir = scope === "global" ? path.join(home, ".claude") : path.join(cwd, ".claude");
    removeCommandFiles(path.join(claudeDir, "commands"));
    removeInstructions(scope === "global" ? path.join(claudeDir, "CLAUDE.md") : path.join(cwd, "CLAUDE.md"));
  }
  if (harness === "opencode") {
    const configDir = scope === "global" ? path.join(home, ".config", "opencode") : cwd;
    plan.removals.push({ file: path.join(configDir, "opencode.json"), kind: "opencode-commands" });
    removeInstructions(path.join(configDir, "AGENTS.md"));
  }
  if (harness === "codex") {
    const root = scope === "project" ? cwd : home;
    removeCommandFiles(path.join(root, "docs", "agent-workflow"));
    removeInstructions(scope === "global" ? path.join(home, ".codex", "AGENTS.md") : path.join(cwd, "AGENTS.md"));
  }

  plan.notes.push("MCP configuration, environment variables, docs/agents, and installed third-party skills are preserved.");
  return plan;
}

export function mergeWrite(existing, write) {
  if (write.kind === "gitignore") return mergeGitignore(existing, write.entries);
  if (write.kind === "pi-settings") {
    const current = existing?.trim() ? JSON.parse(existing) : {};
    const packages = Array.isArray(current.packages) ? current.packages : [];
    return JSON.stringify({ ...current, packages: [...new Set([...packages, ...write.packages])] }, null, 2) + "\n";
  }
  if (write.kind === "json") {
    const current = existing?.trim() ? JSON.parse(existing) : {};
    if (write.file.endsWith("opencode.json")) {
      const mcp = { ...current.mcp };
      for (const [name, server] of Object.entries(write.value.mcp ?? {})) {
        const existingServer = current.mcp?.[name] ?? {};
        const { enabled, ...withoutLegacyEnabled } = existingServer;
        mcp[name] = {
          ...mergeManagedServer(withoutLegacyEnabled, server, name),
          disabled: withoutLegacyEnabled.disabled ?? (enabled === false)
        };
      }
      return JSON.stringify({ ...current, ...write.value, command: { ...current.command, ...write.value.command }, mcp }, null, 2) + "\n";
    }
    return JSON.stringify({ ...current, ...write.value, mcpServers: mergeServers(current.mcpServers, write.value.mcpServers) }, null, 2) + "\n";
  }
  if (write.kind === "instructions") return joinInstructions(existing);
  if (write.kind === "agent-skills") return joinAgentSkills(existing);
  if (write.kind === "create-if-missing" && existing) return existing;
  return write.content.endsWith("\n") ? write.content : `${write.content}\n`;
}

export function removeManagedContent(existing, kind) {
  if (kind === "instructions") {
    const workflow = WORKFLOW_INSTRUCTIONS.trim();
    if (!existing.includes(workflow)) return existing;
    return existing.replace(workflow, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }
  if (kind === "opencode-commands") {
    if (!existing.trim()) return existing;
    const current = JSON.parse(existing);
    for (const name of Object.keys(WORKFLOW_COMMANDS)) {
      if (current.command?.[name]?.template === WORKFLOW_COMMANDS[name].template) delete current.command[name];
    }
    if (current.command && Object.keys(current.command).length === 0) delete current.command;
    return JSON.stringify(current, null, 2) + "\n";
  }
  return existing;
}

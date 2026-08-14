import path from "node:path";
import os from "node:os";
import { DELIVERY_COMMAND, WORKFLOW_INSTRUCTIONS, standardMcpServers } from "./workflow.js";

function joinInstructions(existing = "") {
  if (existing.includes("## Guarded delivery workflow")) return existing;
  return `${existing.trimEnd()}\n${WORKFLOW_INSTRUCTIONS}`.trimStart();
}

function mergeServers(existing = {}) {
  return { ...standardMcpServers(), ...existing };
}

export function buildInstallPlan({ harness, scope, cwd = process.cwd(), home = os.homedir() }) {
  if (!["pi", "claude-code", "opencode", "codex"].includes(harness)) {
    throw new Error(`Unsupported harness: ${harness}`);
  }
  if (!["project", "global"].includes(scope)) {
    throw new Error(`Unsupported scope: ${scope}`);
  }

  const root = scope === "project" ? cwd : home;
  const plan = { harness, scope, root, writes: [], notes: [] };
  const writeText = (file, content, kind = "text") => plan.writes.push({ file, content, kind });
  const writeJson = (file, value) => plan.writes.push({ file, value, kind: "json" });

  if (harness === "pi") {
    const agentDir = scope === "global" ? path.join(home, ".pi", "agent") : path.join(cwd, ".pi");
    const instructionFile = scope === "global" ? path.join(agentDir, "AGENTS.md") : path.join(cwd, "AGENTS.md");
    writeText(path.join(agentDir, "prompts", "delivery.md"), DELIVERY_COMMAND);
    writeJson(path.join(agentDir, "mcp.json"), { mcpServers: standardMcpServers() });
    writeText(instructionFile, WORKFLOW_INSTRUCTIONS, "instructions");
    plan.notes.push("Restart Pi or run /reload, then use /delivery PROJ-123 group/project.");
  }

  if (harness === "claude-code") {
    const claudeDir = scope === "global" ? path.join(home, ".claude") : path.join(cwd, ".claude");
    const instructionFile = scope === "global" ? path.join(claudeDir, "CLAUDE.md") : path.join(cwd, "CLAUDE.md");
    writeText(path.join(claudeDir, "commands", "delivery.md"), DELIVERY_COMMAND);
    writeJson(path.join(scope === "global" ? claudeDir : cwd, ".mcp.json"), { mcpServers: standardMcpServers() });
    writeText(instructionFile, WORKFLOW_INSTRUCTIONS, "instructions");
    plan.notes.push("Restart Claude Code, then use /delivery PROJ-123 group/project.");
  }

  if (harness === "opencode") {
    const configDir = scope === "global" ? path.join(home, ".config", "opencode") : cwd;
    const configFile = path.join(configDir, "opencode.json");
    writeJson(configFile, {
      $schema: "https://opencode.ai/config.json",
      command: {
        delivery: {
          description: "Orchestrate a guarded Jira-to-GitLab delivery workflow",
          template: DELIVERY_COMMAND.split("---").slice(2).join("---").trim()
        }
      },
      mcp: Object.fromEntries(Object.entries(standardMcpServers()).map(([name, server]) => [name, {
        type: "local",
        command: [server.command, ...server.args],
        environment: Object.fromEntries(Object.keys(server.env ?? {}).map((key) => [key, `{env:${key}}`])),
        enabled: true
      }]))
    });
    writeText(path.join(configDir, "AGENTS.md"), WORKFLOW_INSTRUCTIONS, "instructions");
    plan.notes.push("Restart OpenCode, then use /delivery PROJ-123 group/project.");
  }

  if (harness === "codex") {
    const instructionFile = scope === "global" ? path.join(home, ".codex", "AGENTS.md") : path.join(cwd, "AGENTS.md");
    writeText(instructionFile, WORKFLOW_INSTRUCTIONS, "instructions");
    writeText(path.join(root, "docs", "agent-workflow", "delivery.md"), DELIVERY_COMMAND);
    plan.notes.push("Codex uses the installed AGENTS.md workflow. Start a task with: Execute docs/agent-workflow/delivery.md for PROJ-123.");
    plan.notes.push("Codex MCP registration is intentionally not auto-written in v0.1 because its user-level TOML is shared across projects; use your existing MCP configuration or add servers through Codex.");
  }

  return plan;
}

export function mergeWrite(existing, write) {
  if (write.kind === "json") {
    const current = existing?.trim() ? JSON.parse(existing) : {};
    if (write.file.endsWith("opencode.json")) {
      return JSON.stringify({ ...current, ...write.value, command: { ...write.value.command, ...current.command }, mcp: { ...write.value.mcp, ...current.mcp } }, null, 2) + "\n";
    }
    return JSON.stringify({ ...current, mcpServers: mergeServers(current.mcpServers) }, null, 2) + "\n";
  }
  if (write.kind === "instructions") return joinInstructions(existing);
  return write.content.endsWith("\n") ? write.content : `${write.content}\n`;
}

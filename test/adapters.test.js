import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildInstallPlan, mergeWrite } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Pi project plan installs a delivery prompt, MCP config, and instructions", () => {
  const plan = buildInstallPlan({ harness: "pi", scope: "project", cwd: "C:/repo", home: "C:/user" });
  assert.equal(plan.writes.length, 3);
  assert.ok(plan.writes.some((write) => write.file.endsWith("delivery.md") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("mcp.json") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("AGENTS.md")));
});

test("OpenCode adapter emits native command and local MCP configuration", () => {
  const plan = buildInstallPlan({ harness: "opencode", scope: "project", cwd: "C:/repo", home: "C:/user" });
  const config = plan.writes.find((write) => write.file.endsWith("opencode.json")).value;
  assert.ok(config.command.delivery.template.includes("delivery orchestrator"));
  assert.equal(config.mcp.gitlab.type, "local");
  assert.equal(config.mcp.gitlab.environment.GITLAB_API_URL, "{env:GITLAB_API_URL}");
});

test("OpenCode global plan uses its global config directory for rules and configuration", () => {
  const plan = buildInstallPlan({ harness: "opencode", scope: "global", cwd: "C:/repo", home: "C:/user" });
  assert.ok(plan.writes.some((write) => write.file.replaceAll("\\", "/").endsWith(".config/opencode/opencode.json")));
  assert.ok(plan.writes.some((write) => write.file.replaceAll("\\", "/").endsWith(".config/opencode/AGENTS.md")));
});

test("MCP merge preserves unrelated server configuration", () => {
  const content = mergeWrite(JSON.stringify({ mcpServers: { existing: { command: "echo" } } }), {
    file: "mcp.json",
    kind: "json",
    value: {}
  });
  const merged = JSON.parse(content);
  assert.equal(merged.mcpServers.existing.command, "echo");
  assert.equal(merged.mcpServers.gitlab.command, "npx");
});

test("MCP merge preserves an existing managed server", () => {
  const content = mergeWrite(JSON.stringify({ mcpServers: { gitlab: { command: "custom-gitlab" } } }), {
    file: "mcp.json",
    kind: "json",
    value: {}
  });
  assert.equal(JSON.parse(content).mcpServers.gitlab.command, "custom-gitlab");
});

test("instruction merge is idempotent", () => {
  const write = { kind: "instructions", file: "AGENTS.md" };
  const once = mergeWrite("# Existing", write);
  const twice = mergeWrite(once, write);
  assert.equal(twice, once);
});

test("OpenCode installation creates a working project configuration without secrets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coding-agent-harness-opencode-"));
  const cli = path.resolve("bin/coding-agent-harness.js");
  try {
    await execFileAsync(process.execPath, [cli, "init", "--harness", "opencode", "--scope", "project", "--yes"], {
      cwd: workspace
    });
    const config = JSON.parse(await readFile(path.join(workspace, "opencode.json"), "utf8"));
    const rules = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    assert.ok(config.command.delivery.template.includes("Ask exactly one highest-risk material question"));
    assert.equal(config.mcp.gitlab.environment.GITLAB_PERSONAL_ACCESS_TOKEN, "{env:GITLAB_PERSONAL_ACCESS_TOKEN}");
    assert.ok(rules.includes("explicitly approves"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

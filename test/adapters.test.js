import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildInstallPlan,
  buildUninstallPlan,
  mattPocockSkillsInstallArgs,
  mattPocockSkillsInstaller,
  mergeWrite,
  normalizeGitLabApiUrl,
  removeManagedContent
} from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Pi project plan installs a delivery prompt, MCP config, and instructions", () => {
  const plan = buildInstallPlan({ harness: "pi", scope: "project", cwd: "C:/repo", home: "C:/user" });
  assert.equal(plan.writes.length, 14);
  assert.ok(plan.writes.some((write) => write.file.endsWith("delivery.md") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("grill-with-docs.md") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("wayfinder.md") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("mcp.json") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("AGENTS.md")));
});

test("OpenCode adapter emits native command and local MCP configuration", () => {
  const plan = buildInstallPlan({ harness: "opencode", scope: "project", cwd: "C:/repo", home: "C:/user" });
  const config = plan.writes.find((write) => write.file.endsWith("opencode.json")).value;
  assert.ok(config.command.delivery.template.includes("delivery orchestrator"));
  assert.ok(config.command["grill-with-docs"].template.includes("one highest-risk material question"));
  assert.ok(config.command.wayfinder.template.includes("smallest independent investigation slices"));
  assert.ok(config.command["improve-codebase-architecture"].template.includes("incremental, reversible improvement plan"));
  assert.equal(config.mcp.gitlab.type, "local");
  assert.equal(config.mcp.gitlab.disabled, false);
  assert.equal(config.mcp.gitlab.environment.GITLAB_API_URL, "{env:GITLAB_API_URL}");
});

test("GitLab instance URLs are normalized to the GitLab v4 API endpoint", () => {
  assert.equal(normalizeGitLabApiUrl("https://gitlab.gapit.com.vn"), "https://gitlab.gapit.com.vn/api/v4");
  assert.equal(normalizeGitLabApiUrl("https://gitlab.gapit.com.vn/api/v4/"), "https://gitlab.gapit.com.vn/api/v4");
});

test("all Matt Pocock skills are copied only for the selected harness and scope", () => {
  assert.deepEqual(mattPocockSkillsInstallArgs({ harness: "opencode", scope: "project" }), [
    "--yes", "skills@latest", "add", "mattpocock/skills", "--skill", "*", "--agent", "opencode", "--yes", "--copy"
  ]);
  assert.deepEqual(mattPocockSkillsInstallArgs({ harness: "pi", scope: "global" }).slice(-2), ["--copy", "--global"]);
  assert.deepEqual(mattPocockSkillsInstaller({ harness: "opencode", scope: "project", platform: "win32" }), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npx \"--yes\" \"skills@latest\" \"add\" \"mattpocock/skills\" \"--skill\" \"*\" \"--agent\" \"opencode\" \"--yes\" \"--copy\""]
  });
});

test("Matt Pocock installation also bootstraps repository configuration without overwriting it", () => {
  const plan = buildInstallPlan({
    harness: "opencode",
    scope: "project",
    cwd: "C:/repo",
    home: "C:/user",
    includeMattPocockSetup: true
  });
  assert.ok(plan.writes.some((write) => write.file.replaceAll("\\", "/").endsWith("docs/agents/issue-tracker.md") && write.kind === "create-if-missing"));
  assert.ok(plan.writes.some((write) => write.file.replaceAll("\\", "/").endsWith("docs/agents/domain.md") && write.content.includes("CONTEXT.md")));
  const skillsBlock = plan.writes.find((write) => write.kind === "agent-skills");
  assert.ok(mergeWrite("# Existing", skillsBlock).includes("## Agent skills"));
  assert.equal(mergeWrite("# Existing configuration", plan.writes.find((write) => write.file.replaceAll("\\", "/").endsWith("issue-tracker.md"))), "# Existing configuration");
});

test("uninstall plans only harness-owned commands and preserves MCP configuration", () => {
  const plan = buildUninstallPlan({ harness: "opencode", scope: "project", cwd: "C:/repo", home: "C:/user" });
  assert.equal(plan.removals.length, 2);
  const original = buildInstallPlan({ harness: "opencode", scope: "project", cwd: "C:/repo", home: "C:/user" })
    .writes.find((write) => write.file.endsWith("opencode.json")).value;
  const existing = JSON.stringify({
    command: { delivery: original.command.delivery, custom: { template: "Keep this" } },
    mcp: { gitlab: original.mcp.gitlab }
  });
  const removed = JSON.parse(removeManagedContent(existing, "opencode-commands"));
  assert.equal("delivery" in removed.command, false);
  assert.equal(removed.command.custom.template, "Keep this");
  assert.ok(removed.mcp.gitlab);
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

test("OpenCode MCP merge upgrades legacy enabled flags to disabled flags", () => {
  const plan = buildInstallPlan({ harness: "opencode", scope: "project", cwd: "C:/repo", home: "C:/user" });
  const write = plan.writes.find((item) => item.file.endsWith("opencode.json"));
  const content = mergeWrite(JSON.stringify({ mcp: { gitlab: { enabled: true, type: "local", command: ["npx", "gitlab"] } } }), write);
  const merged = JSON.parse(content);
  assert.equal(merged.mcp.gitlab.disabled, false);
  assert.equal("enabled" in merged.mcp.gitlab, false);
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
    assert.ok(config.command.delivery.template.includes("Run the architecture grill"));
    assert.ok(config.command["grill-with-docs"].template.includes("Matt Pocock `grill-with-docs` skill"));
    assert.ok(config.command["create-mr"].template.includes("explicit confirmation"));
    assert.equal(config.mcp.gitlab.environment.GITLAB_PERSONAL_ACCESS_TOKEN, "{env:GITLAB_PERSONAL_ACCESS_TOKEN}");
    assert.ok(rules.includes("explicitly approves"));
    await execFileAsync(process.execPath, [cli, "uninstall", "--harness", "opencode", "--scope", "project", "--yes"], { cwd: workspace });
    const afterUninstall = JSON.parse(await readFile(path.join(workspace, "opencode.json"), "utf8"));
    assert.equal("command" in afterUninstall, false);
    assert.ok(afterUninstall.mcp.gitlab);
    assert.equal((await readFile(path.join(workspace, "AGENTS.md"), "utf8")).includes("## Guarded delivery workflow"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

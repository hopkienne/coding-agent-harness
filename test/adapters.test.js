import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildInstallPlan,
  buildUninstallPlan,
  MATT_POCOCK_WORKFLOW_SKILLS,
  mattPocockSkillsInstallArgs,
  mattPocockSkillsInstaller,
  inferJiraAuthMode,
  mergeWrite,
  normalizeGitLabApiUrl,
  removeManagedContent
} from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Pi project plan installs a delivery prompt, MCP config, and instructions", () => {
  const plan = buildInstallPlan({ harness: "pi", scope: "project", cwd: "C:/repo", home: "C:/user" });
  assert.equal(plan.writes.length, 16);
  assert.ok(plan.writes.some((write) => write.file.endsWith("delivery.md") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("grill-with-docs.md") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("wayfinder.md") && write.file.includes(".pi")));
  assert.ok(plan.writes.some((write) => write.file.endsWith("mcp.json") && write.file.includes(".pi")));
  const settings = plan.writes.find((write) => write.file.endsWith("settings.json"));
  assert.deepEqual(settings.packages, ["npm:pi-mcp-adapter@2.23.0"]);
  assert.ok(plan.writes.some((write) => write.file.endsWith("AGENTS.md")));
  const delivery = plan.writes.find((write) => write.file.endsWith("delivery.md"));
  assert.ok(delivery.content.includes("Full user request:\n$@"));
  assert.equal(delivery.content.includes("$ARGUMENTS"), false);
  assert.ok(delivery.content.includes("requested response language"));
  assert.ok(delivery.content.includes("lazy `mcp` proxy tool"));
  assert.ok(delivery.content.includes('mcp({ server: "jira" })'));
  const gitignore = plan.writes.find((write) => write.file.endsWith(".gitignore"));
  assert.deepEqual(gitignore.entries, ["/.pi/", "/AGENTS.md"]);
});

test("Pi settings merge registers the MCP adapter without losing user packages", () => {
  const write = buildInstallPlan({ harness: "pi", scope: "project", cwd: "C:/repo", home: "C:/user" })
    .writes.find((item) => item.kind === "pi-settings");
  const once = mergeWrite(JSON.stringify({ theme: "dark", packages: ["npm:existing-pi-package"] }), write);
  const twice = mergeWrite(once, write);
  assert.equal(twice, once);
  assert.deepEqual(JSON.parse(once), {
    theme: "dark",
    packages: ["npm:existing-pi-package", "npm:pi-mcp-adapter@2.23.0"]
  });
});

test("OpenCode adapter emits native command and local MCP configuration", () => {
  const plan = buildInstallPlan({ harness: "opencode", scope: "project", cwd: "C:/repo", home: "C:/user" });
  const config = plan.writes.find((write) => write.file.endsWith("opencode.json")).value;
  assert.ok(config.command.delivery.template.includes("delivery orchestrator"));
  assert.ok(config.command.delivery.template.includes("Full user request:\n$ARGUMENTS"));
  assert.ok(config.command.delivery.template.includes("Never assume the first word is the Jira key"));
  assert.ok(config.command.delivery.template.includes("requested response language"));
  assert.ok(config.command.delivery.template.includes("infer the full namespace/project path"));
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

test("only curated Matt Pocock workflow skills are copied by default", () => {
  const workflowArgs = mattPocockSkillsInstallArgs({ harness: "opencode", scope: "project" });
  assert.equal(MATT_POCOCK_WORKFLOW_SKILLS.length, 14);
  assert.equal(workflowArgs.includes("*"), false);
  for (const skill of MATT_POCOCK_WORKFLOW_SKILLS) assert.ok(workflowArgs.includes(skill));
  assert.deepEqual(mattPocockSkillsInstallArgs({ harness: "opencode", scope: "project", mode: "all" }).slice(4, 6), ["--skill", "*"]);
  assert.deepEqual(mattPocockSkillsInstallArgs({ harness: "pi", scope: "global" }).slice(-2), ["--copy", "--global"]);
  const windowsInstaller = mattPocockSkillsInstaller({ harness: "opencode", scope: "project", platform: "win32" });
  assert.equal(windowsInstaller.command, "cmd.exe");
  assert.ok(windowsInstaller.args[3].includes("--skill grill-with-docs"));
  assert.equal(windowsInstaller.args[3].includes("--skill writing-beats"), false);
  assert.throws(() => mattPocockSkillsInstaller({ harness: "opencode & whoami", scope: "project", platform: "win32" }), /Unsupported harness/);
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
  const gitignore = plan.writes.find((write) => write.kind === "gitignore");
  assert.ok(gitignore.entries.includes("/.agents/"));
  assert.ok(gitignore.entries.includes("/skills-lock.json"));
  assert.ok(gitignore.entries.includes("/docs/agents/"));
});

test("Jira authentication mode is inferred and rendered for Cloud or Server/Data Center", () => {
  assert.equal(inferJiraAuthMode("https://example.atlassian.net"), "cloud");
  assert.equal(inferJiraAuthMode("https://jira.gapit.com.vn"), "pat");
  const plan = buildInstallPlan({ harness: "pi", scope: "project", cwd: "C:/repo", home: "C:/user", jiraAuthMode: "pat", jiraUrl: "https://jira.gapit.com.vn" });
  const config = plan.writes.find((write) => write.file.endsWith("mcp.json")).value;
  assert.equal(config.mcpServers.jira.env.JIRA_URL, "https://jira.gapit.com.vn");
  assert.equal(config.mcpServers.jira.env.JIRA_PERSONAL_TOKEN, "${JIRA_PERSONAL_TOKEN}");
  assert.equal("JIRA_API_TOKEN" in config.mcpServers.jira.env, false);
  assert.equal("JIRA_USERNAME" in config.mcpServers.jira.env, false);
});

test("OpenCode embeds non-secret service URLs but keeps tokens in environment variables", () => {
  const plan = buildInstallPlan({
    harness: "opencode",
    scope: "project",
    cwd: "C:/repo",
    home: "C:/user",
    jiraAuthMode: "pat",
    jiraUrl: "https://jira.gapit.com.vn",
    gitLabApiUrl: "https://gitlab.gapit.com.vn/api/v4"
  });
  const config = plan.writes.find((write) => write.file.endsWith("opencode.json")).value;
  assert.equal(config.mcp.jira.environment.JIRA_URL, "https://jira.gapit.com.vn");
  assert.equal(config.mcp.jira.environment.JIRA_PERSONAL_TOKEN, "{env:JIRA_PERSONAL_TOKEN}");
  assert.equal(config.mcp.gitlab.environment.GITLAB_API_URL, "https://gitlab.gapit.com.vn/api/v4");
  assert.equal(config.mcp.gitlab.environment.GITLAB_PERSONAL_ACCESS_TOKEN, "{env:GITLAB_PERSONAL_ACCESS_TOKEN}");
});

test("Claude Code delivery command receives the entire natural-language request", () => {
  const plan = buildInstallPlan({ harness: "claude-code", scope: "project", cwd: "C:/repo", home: "C:/user" });
  const delivery = plan.writes.find((write) => write.file.replaceAll("\\", "/").endsWith(".claude/commands/delivery.md"));
  assert.ok(delivery.content.includes("Full user request:\n$ARGUMENTS"));
  assert.ok(delivery.content.includes("PROJECT-123 form"));
});

test("Codex delivery instruction consumes the request from the current conversation", () => {
  const plan = buildInstallPlan({ harness: "codex", scope: "project", cwd: "C:/repo", home: "C:/user" });
  const delivery = plan.writes.find((write) => write.file.replaceAll("\\", "/").endsWith("docs/agent-workflow/delivery.md"));
  assert.ok(delivery.content.includes("complete natural-language request provided by the human"));
  assert.equal(delivery.content.includes("$ARGUMENTS"), false);
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
  assert.equal(plan.writes.some((write) => write.kind === "gitignore"), false);
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

test("MCP merge upgrades an existing managed server", () => {
  const content = mergeWrite(JSON.stringify({ mcpServers: { gitlab: { command: "custom-gitlab" } } }), {
    file: "mcp.json",
    kind: "json",
    value: { mcpServers: buildInstallPlan({ harness: "pi", scope: "project", cwd: "C:/repo", home: "C:/user" }).writes.find((write) => write.file.endsWith("mcp.json")).value.mcpServers }
  });
  assert.equal(JSON.parse(content).mcpServers.gitlab.command, "npx");
});

test("MCP merge removes stale Jira Cloud credentials when switching to PAT", () => {
  const write = buildInstallPlan({ harness: "pi", scope: "project", cwd: "C:/repo", home: "C:/user", jiraAuthMode: "pat" })
    .writes.find((item) => item.file.endsWith("mcp.json"));
  const content = mergeWrite(JSON.stringify({ mcpServers: { jira: { command: "uvx", env: {
    JIRA_URL: "${JIRA_URL}", JIRA_USERNAME: "${JIRA_USERNAME}", JIRA_API_TOKEN: "${JIRA_API_TOKEN}"
  } } } }), write);
  const env = JSON.parse(content).mcpServers.jira.env;
  assert.equal(env.JIRA_PERSONAL_TOKEN, "${JIRA_PERSONAL_TOKEN}");
  assert.equal("JIRA_API_TOKEN" in env, false);
  assert.equal("JIRA_USERNAME" in env, false);
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

test("OpenCode merge upgrades managed commands while preserving unrelated commands", () => {
  const write = buildInstallPlan({ harness: "opencode", scope: "project", cwd: "C:/repo", home: "C:/user" })
    .writes.find((item) => item.file.endsWith("opencode.json"));
  const content = mergeWrite(JSON.stringify({
    command: {
      delivery: { description: "Old delivery", template: "Use Jira $1" },
      custom: { description: "Keep me", template: "Unrelated command" }
    }
  }), write);
  const merged = JSON.parse(content);
  assert.ok(merged.command.delivery.template.includes("$ARGUMENTS"));
  assert.equal(merged.command.custom.template, "Unrelated command");
});

test("project .gitignore merge is additive and idempotent", () => {
  const write = buildInstallPlan({ harness: "opencode", scope: "project", cwd: "C:/repo", home: "C:/user" })
    .writes.find((item) => item.kind === "gitignore");
  const once = mergeWrite("node_modules/\n", write);
  const twice = mergeWrite(once, write);
  assert.equal(twice, once);
  assert.ok(once.includes("node_modules/"));
  assert.ok(once.includes("# >>> coding-agent-harness >>>"));
  assert.ok(once.includes("/opencode.json"));
  assert.ok(once.includes("/AGENTS.md"));
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
    const gitignore = await readFile(path.join(workspace, ".gitignore"), "utf8");
    assert.ok(config.command.delivery.template.includes("Run the architecture grill"));
    assert.ok(config.command["grill-with-docs"].template.includes("Matt Pocock `grill-with-docs` skill"));
    assert.ok(config.command["create-mr"].template.includes("explicit confirmation"));
    assert.equal(config.mcp.gitlab.environment.GITLAB_PERSONAL_ACCESS_TOKEN, "{env:GITLAB_PERSONAL_ACCESS_TOKEN}");
    assert.ok(rules.includes("explicitly approves"));
    assert.ok(gitignore.includes("/opencode.json"));
    assert.ok(gitignore.includes("/AGENTS.md"));
    await execFileAsync(process.execPath, [cli, "uninstall", "--harness", "opencode", "--scope", "project", "--yes"], { cwd: workspace });
    const afterUninstall = JSON.parse(await readFile(path.join(workspace, "opencode.json"), "utf8"));
    assert.equal("command" in afterUninstall, false);
    assert.ok(afterUninstall.mcp.gitlab);
    assert.equal((await readFile(path.join(workspace, "AGENTS.md"), "utf8")).includes("## Guarded delivery workflow"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("update upgrades an existing Pi workflow and preserves unrelated settings", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coding-agent-harness-pi-update-"));
  const cli = path.resolve("bin/coding-agent-harness.js");
  try {
    await execFileAsync(process.execPath, [cli, "init", "--harness", "pi", "--scope", "project", "--jira-auth", "cloud", "--yes"], {
      cwd: workspace,
      env: { ...process.env, JIRA_URL: "https://jira.gapit.com.vn", GITLAB_API_URL: "https://gitlab.gapit.com.vn/api/v4" }
    });
    await writeFile(path.join(workspace, ".pi", "settings.json"), JSON.stringify({ theme: "custom", packages: ["npm:existing"] }), "utf8");
    await execFileAsync(process.execPath, [cli, "update", "--harness", "pi", "--scope", "project", "--jira-auth", "pat", "--yes"], {
      cwd: workspace,
      env: { ...process.env, JIRA_URL: "https://jira.gapit.com.vn", GITLAB_API_URL: "https://gitlab.gapit.com.vn/api/v4" }
    });
    const mcp = JSON.parse(await readFile(path.join(workspace, ".pi", "mcp.json"), "utf8"));
    const settings = JSON.parse(await readFile(path.join(workspace, ".pi", "settings.json"), "utf8"));
    assert.equal(mcp.mcpServers.jira.env.JIRA_URL, "https://jira.gapit.com.vn");
    assert.equal(mcp.mcpServers.jira.env.JIRA_PERSONAL_TOKEN, "${JIRA_PERSONAL_TOKEN}");
    assert.equal("JIRA_API_TOKEN" in mcp.mcpServers.jira.env, false);
    assert.equal(settings.theme, "custom");
    assert.deepEqual(settings.packages, ["npm:existing", "npm:pi-mcp-adapter@2.23.0"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("doctor --fix repairs a legacy Pi Jira Cloud/PAT mismatch", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coding-agent-harness-pi-doctor-"));
  const cli = path.resolve("bin/coding-agent-harness.js");
  try {
    await mkdir(path.join(workspace, ".pi", "prompts"), { recursive: true });
    await writeFile(path.join(workspace, ".pi", "prompts", "delivery.md"), "legacy delivery\n", "utf8");
    await writeFile(path.join(workspace, ".pi", "mcp.json"), JSON.stringify({
      mcpServers: {
        jira: {
          command: "uvx",
          args: ["mcp-atlassian"],
          env: {
            JIRA_URL: "https://jira.gapit.com.vn",
            JIRA_USERNAME: "${JIRA_USERNAME}",
            JIRA_API_TOKEN: "${JIRA_API_TOKEN}"
          }
        }
      }
    }), "utf8");
    await execFileAsync(process.execPath, [cli, "doctor", "--fix", "--harness", "pi", "--scope", "project", "--yes"], {
      cwd: workspace,
      env: {
        ...process.env,
        JIRA_PERSONAL_TOKEN: "test-secret-not-written-to-config",
        GITLAB_PERSONAL_ACCESS_TOKEN: "test-secret-not-written-to-config"
      }
    });
    const mcp = JSON.parse(await readFile(path.join(workspace, ".pi", "mcp.json"), "utf8"));
    const settings = JSON.parse(await readFile(path.join(workspace, ".pi", "settings.json"), "utf8"));
    assert.equal(mcp.mcpServers.jira.args[0], "mcp-atlassian@0.23.0");
    assert.deepEqual(Object.keys(mcp.mcpServers.jira.env).sort(), ["JIRA_PERSONAL_TOKEN", "JIRA_URL"]);
    assert.equal(mcp.mcpServers.jira.env.JIRA_PERSONAL_TOKEN, "${JIRA_PERSONAL_TOKEN}");
    assert.ok(settings.packages.includes("npm:pi-mcp-adapter@2.23.0"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

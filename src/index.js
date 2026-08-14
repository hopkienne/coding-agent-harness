import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as prompts from "@clack/prompts";
import { buildInstallPlan, buildUninstallPlan, mergeWrite, removeManagedContent } from "./adapters.js";

const execFileAsync = promisify(execFile);
const HARNESS_CHOICES = [
  { value: "pi", label: "Pi", hint: "Prompts and MCP configuration" },
  { value: "claude-code", label: "Claude Code", hint: "Commands and MCP configuration" },
  { value: "codex", label: "Codex", hint: "AGENTS.md workflow" },
  { value: "opencode", label: "OpenCode", hint: "Native commands and local MCP" }
];
const SCOPE_CHOICES = [
  { value: "project", label: "Project", hint: "Only this repository" },
  { value: "global", label: "Global", hint: "Every local project" }
];

class InstallationCancelled extends Error {}

function help() {
  return `Usage: coding-agent-harness <command> [options]

Commands:
  init       Interactively install the guarded delivery workflow.
  uninstall  Interactively remove workflow files created by this package.
  doctor     Show the prerequisites the installer checks.

Options for init:
  --harness <pi|claude-code|codex|opencode>
  --scope <project|global>                 Default: project
  --with-matt-pocock-skills                Install all original Matt Pocock skills for the selected harness
  --dry-run                                Print planned files without writing
  --yes                                    Non-interactive; reads secret values from environment
  --help`;
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  if (command === "--help" || command === "-h") return { command: "help", help: true };
  const options = { command, dryRun: false, yes: false, withMattPocockSkills: false };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--dry-run") options.dryRun = true;
    else if (item === "--yes") options.yes = true;
    else if (item === "--with-matt-pocock-skills") options.withMattPocockSkills = true;
    else if (item === "--help" || item === "-h") options.help = true;
    else if (item === "--harness" || item === "--scope") {
      options[item.slice(2)] = rest[++index];
    } else throw new Error(`Unknown option: ${item}`);
  }
  return options;
}

function unwrapPrompt(value) {
  if (!prompts.isCancel(value)) return value;
  prompts.cancel("Installation cancelled. No workflow files were changed.");
  throw new InstallationCancelled();
}

export function normalizeGitLabApiUrl(value = "") {
  const url = value.trim().replace(/\/+$/, "");
  if (!url || /\/api\/v4$/i.test(url)) return url;
  return `${url}/api/v4`;
}

async function collectOptions(options) {
  if (options.yes) {
    if (!options.harness) throw new Error("--yes requires --harness.");
    return {
      ...options,
      scope: options.scope ?? "project",
      installMattPocockSkills: options.withMattPocockSkills
    };
  }
  const harness = options.harness ?? unwrapPrompt(await prompts.select({
    message: "Step 1 of 4 — Choose your coding-agent harness",
    options: HARNESS_CHOICES,
    initialValue: "pi"
  }));
  if (!HARNESS_CHOICES.some((choice) => choice.value === harness)) throw new Error("Choose pi, claude-code, codex, or opencode.");
  const scope = options.scope ?? unwrapPrompt(await prompts.select({
    message: "Step 2 of 4 — Choose the installation scope",
    options: SCOPE_CHOICES,
    initialValue: "project"
  }));
  const installMattPocockSkills = unwrapPrompt(await prompts.select({
    message: "Step 3 of 4 — Install all original Matt Pocock skills?",
    options: [
      { value: true, label: "Yes", hint: "Copy every available skill from mattpocock/skills for this harness" },
      { value: false, label: "No", hint: "Use the built-in workflow commands only" }
    ],
    initialValue: false
  }));
  const configureSecrets = unwrapPrompt(await prompts.select({
    message: "Step 4 of 4 — Configure Jira and GitLab credentials now?",
    options: [
      { value: true, label: "Yes", hint: "Configure Jira and GitLab now" },
      { value: false, label: "No", hint: "Configure environment variables later" }
    ],
    initialValue: true
  }));
  const gitLabApiUrl = configureSecrets ? unwrapPrompt(await prompts.text({
    message: "GitLab API URL",
    placeholder: "https://gitlab.example.com/api/v4",
    initialValue: normalizeGitLabApiUrl(process.env.GITLAB_API_URL)
  })) : undefined;
  const secrets = configureSecrets ? {
    JIRA_URL: unwrapPrompt(await prompts.text({
      message: "Jira URL",
      placeholder: "https://jira.example.com",
      initialValue: process.env.JIRA_URL
    })),
    JIRA_USERNAME: unwrapPrompt(await prompts.text({
      message: "Jira username or email",
      placeholder: "you@example.com",
      initialValue: process.env.JIRA_USERNAME
    })),
    JIRA_API_TOKEN: unwrapPrompt(await prompts.password({ message: "Jira API token", mask: "*" })),
    GITLAB_API_URL: normalizeGitLabApiUrl(gitLabApiUrl),
    GITLAB_PERSONAL_ACCESS_TOKEN: unwrapPrompt(await prompts.password({ message: "GitLab personal access token", mask: "*" }))
  } : undefined;
  return { ...options, harness, scope, installMattPocockSkills, secrets };
}

export function mattPocockSkillsInstallArgs({ harness, scope }) {
  const args = [
    "--yes",
    "skills@latest",
    "add",
    "mattpocock/skills",
    "--skill",
    "*",
    "--agent",
    harness,
    "--yes",
    "--copy"
  ];
  if (scope === "global") args.push("--global");
  return args;
}

export function mattPocockSkillsInstaller({ harness, scope, platform = process.platform }) {
  if (!HARNESS_CHOICES.some((choice) => choice.value === harness)) throw new Error(`Unsupported harness: ${harness}`);
  if (!SCOPE_CHOICES.some((choice) => choice.value === scope)) throw new Error(`Unsupported scope: ${scope}`);
  const args = mattPocockSkillsInstallArgs({ harness, scope });
  if (platform !== "win32") return { command: "npx", args };
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `npx ${args.join(" ")}`]
  };
}

async function installMattPocockSkills({ harness, scope }) {
  const installer = mattPocockSkillsInstaller({ harness, scope });
  await execFileAsync(installer.command, installer.args, {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
    timeout: 5 * 60 * 1000
  });
}

async function persistWindowsSecrets(secrets) {
  if (!secrets || process.platform !== "win32") return false;
  for (const [key, value] of Object.entries(secrets)) {
    if (!value) continue;
    await execFileAsync("setx", [key, value], { windowsHide: true });
  }
  return true;
}

async function applyPlan(plan, dryRun) {
  const files = new Set();
  for (const write of plan.writes) {
    let existing = "";
    try { existing = await fs.readFile(write.file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const output = mergeWrite(existing, write);
    if (dryRun) {
      files.add(write.file);
      continue;
    }
    await fs.mkdir(path.dirname(write.file), { recursive: true });
    await fs.writeFile(write.file, output, "utf8");
    files.add(write.file);
  }
  return [...files];
}

async function applyUninstallPlan(plan, dryRun) {
  const changed = new Set();
  for (const removal of plan.removals) {
    let existing = "";
    try { existing = await fs.readFile(removal.file, "utf8"); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (removal.kind === "file") {
      if (!dryRun) await fs.rm(removal.file, { force: true });
      changed.add(removal.file);
      continue;
    }
    const output = removeManagedContent(existing, removal.kind);
    if (output === existing) continue;
    if (!dryRun) await fs.writeFile(removal.file, output, "utf8");
    changed.add(removal.file);
  }
  return [...changed];
}

async function collectUninstallOptions(options) {
  if (options.yes) {
    if (!options.harness) throw new Error("--yes requires --harness.");
    return { ...options, scope: options.scope ?? "project" };
  }
  const harness = options.harness ?? unwrapPrompt(await prompts.select({
    message: "Choose the harness whose workflow you want to remove",
    options: HARNESS_CHOICES,
    initialValue: "pi"
  }));
  const scope = options.scope ?? unwrapPrompt(await prompts.select({
    message: "Choose the installation scope to remove",
    options: SCOPE_CHOICES,
    initialValue: "project"
  }));
  const confirmed = unwrapPrompt(await prompts.confirm({
    message: "Remove generated workflow commands and instructions? MCP, skills, and credentials will be preserved.",
    initialValue: false,
    active: "Yes, remove workflow",
    inactive: "No, keep workflow"
  }));
  if (!confirmed) throw new InstallationCancelled();
  return { ...options, harness, scope };
}

async function init(options) {
  const interactive = !options.yes && process.stdout.isTTY;
  let progress;
  if (interactive) {
    prompts.intro("Coding Agent Harness");
    prompts.note("A human-gated delivery workflow for Jira → architecture grill → GitLab → verified delivery.", "Install a delivery system, not just a prompt");
  }

  try {
    const selected = await collectOptions(options);
    const plan = buildInstallPlan({
      harness: selected.harness,
      scope: selected.scope,
      cwd: process.cwd(),
      includeMattPocockSetup: selected.installMattPocockSkills
    });
    if (interactive) {
      prompts.note(`Harness: ${selected.harness}\nScope: ${selected.scope}\nFiles: ${new Set(plan.writes.map((write) => write.file)).size}\nMatt Pocock skills: ${selected.installMattPocockSkills ? "all skills will be copied" : "not selected"}\nGitLab writes: none until you explicitly approve them.`, "Ready to install");
    }

    progress = interactive ? prompts.spinner() : undefined;
    progress?.start(selected.dryRun ? "Preparing installation preview" : "Installing delivery workflow");
    const files = await applyPlan(plan, selected.dryRun);
    progress?.stop(selected.dryRun ? "Preview ready" : "Workflow files installed");
    if (!interactive) for (const file of files) console.log(`${selected.dryRun ? "[dry-run]" : "created/updated"} ${file}`);

    let installedMattPocockSkills = false;
    if (selected.installMattPocockSkills && !selected.dryRun) {
      progress?.start("Copying original Matt Pocock skills (may take a few minutes)");
      await installMattPocockSkills(selected);
      installedMattPocockSkills = true;
      progress?.stop("Original Matt Pocock skills copied");
    }

    const persisted = selected.dryRun ? false : await persistWindowsSecrets(selected.secrets);
    if (interactive) {
      prompts.note(files.map((file) => path.relative(process.cwd(), file) || path.basename(file)).join("\n"), selected.dryRun ? "Planned files" : "Installed files");
      if (installedMattPocockSkills) {
        prompts.log.success(`Copied all original Matt Pocock skills for ${selected.harness}. Matching workflow commands now prefer those skills.`);
        prompts.log.success("Bootstrapped the original skills' repository configuration for Jira requirements, GitLab delivery, triage labels, and domain docs.");
      }
      if (persisted) prompts.log.success("Jira and GitLab credentials were saved to Windows user environment variables.");
      if (selected.secrets && !persisted && !selected.dryRun) prompts.log.warn("Export the requested environment variables before starting the harness.");
      prompts.note(plan.notes.join("\n"), "Next step");
      prompts.outro(selected.dryRun ? "No files were changed." : "Installation complete. Restart the harness terminal, then begin a delivery.");
    } else {
      if (installedMattPocockSkills) {
        console.log(`Copied all original Matt Pocock skills for ${selected.harness}. Matching workflow commands now prefer those skills.`);
        console.log("Bootstrapped the original skills' repository configuration for Jira requirements, GitLab delivery, triage labels, and domain docs.");
      }
      if (selected.secrets && !persisted && !selected.dryRun) console.log("Secrets were not persisted on this platform. Export the requested environment variables before starting the harness.");
      if (persisted) console.log("Jira/GitLab secrets were saved as Windows user environment variables. Restart the harness terminal to load them.");
      for (const note of plan.notes) console.log(note);
    }
  } catch (error) {
    if (error instanceof InstallationCancelled) return;
    progress?.stop("Installation stopped");
    if (error.killed) error.message = "Copying original Matt Pocock skills timed out after five minutes. Check your network, upgrade to Node.js 22.20 or newer, then run init again.";
    if (interactive) prompts.cancel(`Installation failed: ${error.message}`);
    throw error;
  }
}

async function uninstall(options) {
  const interactive = !options.yes && process.stdout.isTTY;
  if (interactive) prompts.intro("Coding Agent Harness — uninstall");
  try {
    const selected = await collectUninstallOptions(options);
    const plan = buildUninstallPlan({ harness: selected.harness, scope: selected.scope, cwd: process.cwd() });
    const progress = interactive ? prompts.spinner() : undefined;
    progress?.start(selected.dryRun ? "Preparing removal preview" : "Removing generated workflow");
    const files = await applyUninstallPlan(plan, selected.dryRun);
    progress?.stop(selected.dryRun ? "Removal preview ready" : "Generated workflow removed");
    if (!interactive) for (const file of files) console.log(`${selected.dryRun ? "[dry-run] would update/remove" : "removed/updated"} ${file}`);
    if (interactive) {
      prompts.note(files.map((file) => path.relative(process.cwd(), file) || path.basename(file)).join("\n") || "No managed workflow content was found.", selected.dryRun ? "Planned changes" : "Changed files");
      prompts.note(plan.notes.join("\n"), "Preserved by design");
      prompts.outro(selected.dryRun ? "No files were changed." : "Workflow removal complete.");
    } else {
      for (const note of plan.notes) console.log(note);
    }
  } catch (error) {
    if (error instanceof InstallationCancelled) return;
    if (interactive) prompts.cancel(`Removal failed: ${error.message}`);
    throw error;
  }
}

function doctor() {
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
  console.log("Required runtimes: Node.js, npx; uvx is required when installing Jira MCP.");
  console.log("Optional Matt Pocock skills install: the current skills CLI requires Node.js >=22.20.");
  console.log("Required environment variables: JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN, GITLAB_API_URL, GITLAB_PERSONAL_ACCESS_TOKEN.");
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.command === "help") { console.log(help()); return; }
  if (options.command === "doctor") { doctor(); return; }
  if (options.command === "init") { await init(options); return; }
  if (options.command === "uninstall") { await uninstall(options); return; }
  throw new Error(`Unknown command: ${options.command}`);
}

export { buildInstallPlan, buildUninstallPlan, mergeWrite, removeManagedContent };

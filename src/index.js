import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { buildInstallPlan, mergeWrite } from "./adapters.js";

const execFileAsync = promisify(execFile);
const HARNESS_CHOICES = ["pi", "claude-code", "codex", "opencode"];

function help() {
  return `Usage: coding-agent-harness <command> [options]

Commands:
  init       Interactively install the guarded delivery workflow.
  doctor     Show the prerequisites the installer checks.

Options for init:
  --harness <pi|claude-code|codex|opencode>
  --scope <project|global>                 Default: project
  --dry-run                                Print planned files without writing
  --yes                                    Non-interactive; reads secret values from environment
  --help`;
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  if (command === "--help" || command === "-h") return { command: "help", help: true };
  const options = { command, scope: "project", dryRun: false, yes: false };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--dry-run") options.dryRun = true;
    else if (item === "--yes") options.yes = true;
    else if (item === "--help" || item === "-h") options.help = true;
    else if (item === "--harness" || item === "--scope") {
      options[item.slice(2)] = rest[++index];
    } else throw new Error(`Unknown option: ${item}`);
  }
  return options;
}

async function ask(question, fallback) {
  const suffix = fallback ? ` [${fallback}]` : "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function askSecret(question) {
  if (!process.stdin.isTTY) return ask(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  let masking = false;
  rl._writeToOutput = (text) => {
    if (masking && text.trim()) rl.output.write("*");
    else write(text);
  };
  try {
    process.stdout.write(`${question}: `);
    masking = true;
    return (await rl.question("")).trim();
  } finally {
    masking = false;
    rl.close();
  }
}

async function collectOptions(options) {
  if (options.yes) {
    if (!options.harness) throw new Error("--yes requires --harness.");
    return options;
  }
  const harness = options.harness ?? await ask(`Harness (${HARNESS_CHOICES.join(", ")})`, "pi");
  if (!HARNESS_CHOICES.includes(harness)) throw new Error(`Choose one of: ${HARNESS_CHOICES.join(", ")}`);
  const scope = await ask("Install scope (project, global)", options.scope);
  if (!["project", "global"].includes(scope)) throw new Error("Scope must be project or global.");
  const configureSecrets = await ask("Configure Jira/GitLab environment variables now? (yes, no)", "yes");
  const secrets = configureSecrets === "yes" ? {
    JIRA_URL: await ask("Jira URL"),
    JIRA_USERNAME: await ask("Jira username/email"),
    JIRA_API_TOKEN: await askSecret("Jira API token"),
    GITLAB_API_URL: await ask("GitLab API URL (for example https://gitlab.example.com/api/v4)"),
    GITLAB_PERSONAL_ACCESS_TOKEN: await askSecret("GitLab personal access token")
  } : undefined;
  return { ...options, harness, scope, secrets };
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
  for (const write of plan.writes) {
    let existing = "";
    try { existing = await fs.readFile(write.file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const output = mergeWrite(existing, write);
    if (dryRun) {
      console.log(`[dry-run] ${write.file}`);
      continue;
    }
    await fs.mkdir(path.dirname(write.file), { recursive: true });
    await fs.writeFile(write.file, output, "utf8");
    console.log(`created/updated ${write.file}`);
  }
}

async function init(options) {
  const selected = await collectOptions(options);
  const plan = buildInstallPlan({ harness: selected.harness, scope: selected.scope, cwd: process.cwd() });
  await applyPlan(plan, selected.dryRun);
  const persisted = selected.dryRun ? false : await persistWindowsSecrets(selected.secrets);
  if (selected.secrets && !persisted && !selected.dryRun) {
    console.log("Secrets were not persisted on this platform. Export the requested environment variables before starting the harness.");
  }
  if (persisted) console.log("Jira/GitLab secrets were saved as Windows user environment variables. Restart the harness terminal to load them.");
  for (const note of plan.notes) console.log(note);
}

function doctor() {
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
  console.log("Required runtimes: Node.js, npx; uvx is required when installing Jira MCP.");
  console.log("Required environment variables: JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN, GITLAB_API_URL, GITLAB_PERSONAL_ACCESS_TOKEN.");
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.command === "help") { console.log(help()); return; }
  if (options.command === "doctor") { doctor(); return; }
  if (options.command === "init") { await init(options); return; }
  throw new Error(`Unknown command: ${options.command}`);
}

export { buildInstallPlan, mergeWrite };

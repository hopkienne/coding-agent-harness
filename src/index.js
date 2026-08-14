import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { buildInstallPlan, mergeWrite } from "./adapters.js";

const execFileAsync = promisify(execFile);
const HARNESS_CHOICES = [
  { value: "pi", label: "Pi" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" }
];
const SCOPE_CHOICES = [
  { value: "project", label: "Project (current repository)" },
  { value: "global", label: "Global (all projects)" }
];
const SECRET_CHOICES = [
  { value: "yes", label: "Yes — configure Jira and GitLab now" },
  { value: "no", label: "No — configure environment variables later" }
];

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
  const options = { command, dryRun: false, yes: false };
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

function isInteractiveTerminal(input = process.stdin, output = process.stdout) {
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === "function");
}

function renderSelect(question, choices, selected) {
  return [
    question,
    "Use ↑/↓ to choose, then Enter.",
    ...choices.map((choice, index) => `${index === selected ? "❯" : " "} ${choice.label}`)
  ].join("\n");
}

async function select(question, choices, fallback, { input = process.stdin, output = process.stdout } = {}) {
  const initial = Math.max(0, choices.findIndex((choice) => choice.value === fallback));
  if (!isInteractiveTerminal(input, output)) return choices[initial].value;
  const wasRaw = input.isRaw;
  let selected = initial;
  let renderedLines = 0;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const render = () => {
      if (renderedLines) output.write(`\x1B[${renderedLines}A\r\x1B[0J`);
      const screen = renderSelect(question, choices, selected);
      output.write(`${screen}\n`);
      renderedLines = screen.split("\n").length;
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Installation cancelled."));
      } else if (key.name === "up") {
        selected = (selected - 1 + choices.length) % choices.length;
        render();
      } else if (key.name === "down") {
        selected = (selected + 1) % choices.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(choices[selected].value);
      }
    };

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    render();
  });
}

async function askSecret(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!isInteractiveTerminal(input, output)) return ask(question);
  const wasRaw = input.isRaw;
  let value = "";

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Installation cancelled."));
      } else if (key.name === "return" || key.name === "enter") {
        output.write("\n");
        cleanup();
        resolve(value.trim());
      } else if (key.name === "backspace") {
        if (value) {
          value = value.slice(0, -1);
          output.write("\b \b");
        }
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
        output.write("*");
      }
    };

    output.write(`${question}: `);
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
  });
}

async function collectOptions(options) {
  if (options.yes) {
    if (!options.harness) throw new Error("--yes requires --harness.");
    return { ...options, scope: options.scope ?? "project" };
  }
  const harness = options.harness ?? await select("Choose a coding-agent harness", HARNESS_CHOICES, "pi");
  if (!HARNESS_CHOICES.some((choice) => choice.value === harness)) throw new Error("Choose pi, claude-code, codex, or opencode.");
  const scope = options.scope ?? await select("Choose where to install the workflow", SCOPE_CHOICES, "project");
  const configureSecrets = await select("Configure Jira/GitLab environment variables now?", SECRET_CHOICES, "yes");
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

export { askSecret, buildInstallPlan, mergeWrite, select };

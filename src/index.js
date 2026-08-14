import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as prompts from "@clack/prompts";
import { buildInstallPlan, buildUninstallPlan, mergeWrite, removeManagedContent } from "./adapters.js";
import {
  GOOGLE_DRIVE_MCP_PACKAGE,
  GOOGLE_DRIVE_READONLY_SCOPES,
  MATT_POCOCK_WORKFLOW_SKILLS
} from "./workflow.js";

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
const MATT_POCOCK_SKILL_MODES = ["workflow", "all", "none"];
const JIRA_AUTH_MODES = ["cloud", "pat"];
const GOOGLE_DOCS_MODES = ["on", "off"];
const GOOGLE_OAUTH_MODES = ["desktop-json", "web-client"];

class InstallationCancelled extends Error {}

function help() {
  return `Usage: coding-agent-harness <command> [options]

Commands:
  init       Interactively install the guarded delivery workflow.
  update     Upgrade an existing workflow without replacing secrets or custom configuration.
  uninstall  Interactively remove workflow files created by this package.
  doctor     Diagnose an existing installation; use --fix to repair it.

Options:
  --harness <pi|claude-code|codex|opencode>
  --scope <project|global>                 Default: project
  --matt-pocock-skills <workflow|all|none> Default with --yes: none
  --jira-auth <cloud|pat>                  Default: inferred from JIRA_URL
  --google-docs <on|off>                   Default with --yes: off
  --google-oauth-mode <desktop-json|web-client>
  --google-oauth-credentials <path>        OAuth Desktop credentials JSON
  --google-client-id <id>                  Web application OAuth client ID
  --google-client-secret <secret>          Web application OAuth client secret
  --google-auth-port <port>                OAuth callback port range start; default: 3000
  --with-matt-pocock-skills                Alias for --matt-pocock-skills workflow
  --with-google-docs                       Alias for --google-docs on
  --skip-google-auth                       Configure MCP without opening OAuth now
  --fix                                    Repair detected issues (doctor only)
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
    else if (item === "--fix") options.fix = true;
    else if (item === "--yes") options.yes = true;
    else if (item === "--skip-google-auth") options.skipGoogleAuth = true;
    else if (item === "--with-matt-pocock-skills") options.mattPocockSkills = "workflow";
    else if (item === "--with-google-docs") options.googleDocs = "on";
    else if (item === "--help" || item === "-h") options.help = true;
    else if (item === "--matt-pocock-skills") options.mattPocockSkills = rest[++index];
    else if (item === "--jira-auth") options.jiraAuth = rest[++index];
    else if (item === "--google-docs") options.googleDocs = rest[++index];
    else if (item === "--google-oauth-mode") options.googleOauthMode = rest[++index];
    else if (item === "--google-oauth-credentials") options.googleOauthCredentials = rest[++index];
    else if (item === "--google-client-id") options.googleClientId = rest[++index];
    else if (item === "--google-client-secret") options.googleClientSecret = rest[++index];
    else if (item === "--google-auth-port") options.googleAuthPort = rest[++index];
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

export function inferJiraAuthMode(value = "") {
  try {
    return new URL(value).hostname.toLowerCase().endsWith(".atlassian.net") ? "cloud" : "pat";
  } catch {
    return "cloud";
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

export function resolveUserPath(value = "", home = os.homedir()) {
  const input = value.trim();
  if (!input) return "";
  if (input === "~") return home;
  const homePath = path.win32.isAbsolute(home) && !path.posix.isAbsolute(home) ? path.win32 : path;
  if (input.startsWith("~/") || input.startsWith("~\\")) return homePath.resolve(home, input.slice(2));
  if (path.win32.isAbsolute(input) && !path.posix.isAbsolute(input)) return path.win32.resolve(input);
  return path.resolve(input);
}

export function defaultGoogleCredentialsPath(home = os.homedir()) {
  return path.join(home, ".config", "google-drive-mcp", "gcp-oauth.keys.json");
}

function defaultGoogleTokenPath(home = os.homedir()) {
  return path.join(home, ".config", "google-drive-mcp", "tokens.json");
}

function googleOAuthClientFromJson(value) {
  return value?.installed ?? value?.web ?? value;
}

export function normalizeGoogleAuthPort(value = 3000) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65531) {
    throw new Error("Google OAuth callback port must be an integer between 1 and 65531.");
  }
  return port;
}

export function googleOAuthRedirectUris(port = 3000) {
  const start = normalizeGoogleAuthPort(port);
  return Array.from({ length: 5 }, (_, index) => `http://127.0.0.1:${start + index}/oauth2callback`);
}

async function writeGoogleDocsCredentials(raw, { home = os.homedir(), dryRun = false } = {}) {
  const target = defaultGoogleCredentialsPath(home);
  if (dryRun) return target;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, raw, { encoding: "utf8", mode: 0o600 });
  try { await fs.chmod(target, 0o600); } catch {}
  return target;
}

export async function installGoogleDocsCredentials(sourcePath, { home = os.homedir(), dryRun = false } = {}) {
  const source = resolveUserPath(sourcePath, home);
  if (!source || !(await fileExists(source))) {
    throw new Error(`Google OAuth credentials file was not found: ${source || sourcePath}`);
  }
  let raw;
  let parsed;
  try {
    raw = await fs.readFile(source, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Google OAuth credentials JSON is invalid: ${error.message}`);
  }
  const client = googleOAuthClientFromJson(parsed);
  if (!client?.client_id || !client?.client_secret) {
    throw new Error("Google OAuth credentials JSON must contain client_id and client_secret.");
  }
  const target = defaultGoogleCredentialsPath(home);
  if (dryRun) return target;
  if (path.resolve(source) === path.resolve(target)) {
    try { await fs.chmod(target, 0o600); } catch {}
    return target;
  }
  return writeGoogleDocsCredentials(raw, { home });
}

export async function installGoogleDocsWebClient({ clientId, clientSecret, authPort = 3000, home = os.homedir(), dryRun = false }) {
  const normalizedClientId = String(clientId ?? "").trim();
  const normalizedClientSecret = String(clientSecret ?? "").trim();
  if (!normalizedClientId || !normalizedClientSecret) {
    throw new Error("Web OAuth requires both Google client_id and client_secret.");
  }
  const credentials = {
    web: {
      client_id: normalizedClientId,
      client_secret: normalizedClientSecret,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: googleOAuthRedirectUris(authPort)
    }
  };
  return writeGoogleDocsCredentials(`${JSON.stringify(credentials, null, 2)}\n`, { home, dryRun });
}

async function googleTokenSnapshot(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    const accounts = parsed.accounts
      ? Object.values(parsed.accounts)
      : [parsed];
    const usable = accounts.some((account) => account?.accessToken || account?.access_token || account?.refreshToken || account?.refresh_token);
    return usable ? raw : "";
  } catch {
    return "";
  }
}

async function collectGoogleOAuthInput(options, { interactive }) {
  let mode = options.googleOauthMode
    ?? ((options.googleClientId || options.googleClientSecret) ? "web-client" : "desktop-json");
  if (interactive && !options.googleOauthMode) {
    mode = unwrapPrompt(await prompts.select({
      message: "Choose the Google OAuth client type",
      options: [
        { value: "desktop-json", label: "Desktop app JSON", hint: "Recommended — no redirect URI setup" },
        { value: "web-client", label: "Web application", hint: "Enter client ID and secret; register loopback redirects" }
      ],
      initialValue: "desktop-json"
    }));
  }
  if (!GOOGLE_OAUTH_MODES.includes(mode)) {
    throw new Error("Choose desktop-json or web-client for --google-oauth-mode.");
  }
  const authPort = normalizeGoogleAuthPort(options.googleAuthPort ?? process.env.GOOGLE_DRIVE_MCP_AUTH_PORT ?? 3000);
  if (mode === "web-client") {
    if (interactive) {
      prompts.note(googleOAuthRedirectUris(authPort).join("\n"), "Register these authorized redirect URIs in Google Cloud");
    }
    const clientId = String(options.googleClientId
      ?? process.env.GOOGLE_DRIVE_MCP_CLIENT_ID
      ?? (interactive ? unwrapPrompt(await prompts.text({ message: "Google OAuth web client ID" })) : "")).trim();
    const clientSecret = String(options.googleClientSecret
      ?? process.env.GOOGLE_DRIVE_MCP_CLIENT_SECRET
      ?? (interactive ? unwrapPrompt(await prompts.password({ message: "Google OAuth web client secret", mask: "*" })) : "")).trim();
    if ((!clientId || !clientSecret) && !options.dryRun) {
      throw new Error("Web OAuth requires --google-client-id and --google-client-secret, or the matching environment variables.");
    }
    return { mode, clientId, clientSecret, authPort, credentialsPath: "" };
  }

  const configuredPath = resolveUserPath(
    options.googleOauthCredentials ?? await readEnvironmentValue("GOOGLE_DRIVE_OAUTH_CREDENTIALS")
  );
  const conventionalPath = defaultGoogleCredentialsPath();
  if (!interactive) {
    const credentialsPath = configuredPath || ((await fileExists(conventionalPath)) ? conventionalPath : "");
    if (options.dryRun) return { mode, credentialsPath: credentialsPath || conventionalPath, clientId: "", clientSecret: "", authPort };
    if (!credentialsPath) throw new Error("Google Docs requires --google-oauth-credentials or GOOGLE_DRIVE_OAUTH_CREDENTIALS.");
    if (!(await fileExists(credentialsPath))) throw new Error(`Google OAuth credentials file was not found: ${credentialsPath}`);
    return { mode, credentialsPath, clientId: "", clientSecret: "", authPort };
  }

  let initialValue = configuredPath || ((await fileExists(conventionalPath)) ? conventionalPath : "");
  while (true) {
    const credentialsPath = resolveUserPath(unwrapPrompt(await prompts.text({
      message: "Google OAuth Desktop credentials JSON",
      placeholder: conventionalPath,
      initialValue
    })));
    if (credentialsPath && await fileExists(credentialsPath)) {
      return { mode, credentialsPath, clientId: "", clientSecret: "", authPort };
    }
    prompts.log.warn(`Credentials file was not found: ${credentialsPath || "(empty path)"}`);
    initialValue = credentialsPath;
  }
}

async function readEnvironmentValue(key) {
  if (process.env[key]) return process.env[key];
  if (process.platform !== "win32") return "";
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", "HKCU\\Environment", "/v", key], { windowsHide: true });
    const line = stdout.split(/\r?\n/).find((item) => item.trimStart().startsWith(key));
    return line?.match(/\sREG_(?:SZ|EXPAND_SZ)\s+(.+)$/i)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function installedMarker({ harness, scope, cwd = process.cwd(), home = os.homedir() }) {
  if (harness === "pi") {
    const root = scope === "global" ? path.join(home, ".pi", "agent") : path.join(cwd, ".pi");
    return path.join(root, "prompts", "delivery.md");
  }
  if (harness === "claude-code") {
    const root = scope === "global" ? path.join(home, ".claude") : path.join(cwd, ".claude");
    return path.join(root, "commands", "delivery.md");
  }
  if (harness === "codex") {
    const root = scope === "global" ? home : cwd;
    return path.join(root, "docs", "agent-workflow", "delivery.md");
  }
  return path.join(scope === "global" ? path.join(home, ".config", "opencode") : cwd, "opencode.json");
}

function mcpConfigPath({ harness, scope, cwd = process.cwd(), home = os.homedir() }) {
  if (harness === "pi") {
    return path.join(scope === "global" ? path.join(home, ".pi", "agent") : path.join(cwd, ".pi"), "mcp.json");
  }
  if (harness === "claude-code") {
    return scope === "global" ? path.join(home, ".claude", ".mcp.json") : path.join(cwd, ".mcp.json");
  }
  if (harness === "opencode") {
    return path.join(scope === "global" ? path.join(home, ".config", "opencode") : cwd, "opencode.json");
  }
  if (harness === "codex") {
    return path.join(scope === "global" ? path.join(home, ".codex") : path.join(cwd, ".codex"), "config.toml");
  }
  return "";
}

export async function detectInstalledHarnesses({ scope = "project", cwd = process.cwd(), home = os.homedir() } = {}) {
  if (!SCOPE_CHOICES.some((choice) => choice.value === scope)) throw new Error(`Unsupported scope: ${scope}`);
  const detected = [];
  for (const { value: harness } of HARNESS_CHOICES) {
    const marker = installedMarker({ harness, scope, cwd, home });
    if (!(await fileExists(marker))) continue;
    if (harness === "opencode") {
      const config = await readJson(marker);
      if (!config.command?.delivery?.description?.includes("guarded Jira-to-GitLab")) continue;
    }
    detected.push(harness);
  }
  return detected;
}

function literalConfigValue(value = "") {
  if (typeof value !== "string" || !value) return "";
  if (/^\$\{[A-Z0-9_]+\}$/.test(value) || /^\{env:[A-Z0-9_]+\}$/.test(value)) return "";
  return value;
}

async function resolveInstalledConfiguration({ harness, scope, cwd = process.cwd(), home = os.homedir(), jiraAuth }) {
  const configFile = mcpConfigPath({ harness, scope, cwd, home });
  if (harness === "codex") {
    const configText = await readText(configFile);
    const jiraUrl = await readEnvironmentValue("JIRA_URL");
    const configuredGoogleCredentials = resolveUserPath(await readEnvironmentValue("GOOGLE_DRIVE_OAUTH_CREDENTIALS"), home);
    const configuredGoogleAuthPort = configText.match(/^GOOGLE_DRIVE_MCP_AUTH_PORT\s*=\s*["'](\d+)["']/m)?.[1] ?? 3000;
    return {
      jiraAuthMode: jiraAuth ?? inferJiraAuthMode(jiraUrl),
      jiraUrl,
      gitLabApiUrl: normalizeGitLabApiUrl(await readEnvironmentValue("GITLAB_API_URL")),
      googleDocsEnabled: /^\[mcp_servers\.(?:google-docs|["']google-docs["'])\]/m.test(configText),
      googleDocsCredentialsPath: configuredGoogleCredentials && await fileExists(configuredGoogleCredentials)
        ? configuredGoogleCredentials
        : defaultGoogleCredentialsPath(home),
      googleDocsAuthPort: normalizeGoogleAuthPort(configuredGoogleAuthPort)
    };
  }
  const config = configFile ? await readJson(configFile) : {};
  const jira = config.mcp?.jira ?? config.mcpServers?.jira ?? {};
  const gitlab = config.mcp?.gitlab ?? config.mcpServers?.gitlab ?? {};
  const googleDocs = config.mcp?.["google-docs"] ?? config.mcpServers?.["google-docs"];
  const jiraEnvironment = jira.environment ?? jira.env ?? {};
  const gitLabEnvironment = gitlab.environment ?? gitlab.env ?? {};
  const jiraUrl = literalConfigValue(jiraEnvironment.JIRA_URL) || await readEnvironmentValue("JIRA_URL");
  const gitLabApiUrl = normalizeGitLabApiUrl(literalConfigValue(gitLabEnvironment.GITLAB_API_URL) || await readEnvironmentValue("GITLAB_API_URL"));
  const jiraAuthMode = jiraAuth
    ?? ("JIRA_PERSONAL_TOKEN" in jiraEnvironment ? "pat" : inferJiraAuthMode(jiraUrl));
  const googleDocsEnvironment = googleDocs?.environment ?? googleDocs?.env ?? {};
  const configuredGoogleCredentials = resolveUserPath(
    literalConfigValue(googleDocsEnvironment.GOOGLE_DRIVE_OAUTH_CREDENTIALS)
      || await readEnvironmentValue("GOOGLE_DRIVE_OAUTH_CREDENTIALS"),
    home
  );
  const googleDocsCredentialsPath = configuredGoogleCredentials && await fileExists(configuredGoogleCredentials)
    ? configuredGoogleCredentials
    : defaultGoogleCredentialsPath(home);
  const googleDocsAuthPort = normalizeGoogleAuthPort(literalConfigValue(googleDocsEnvironment.GOOGLE_DRIVE_MCP_AUTH_PORT) || 3000);
  return { jiraAuthMode, jiraUrl, gitLabApiUrl, googleDocsEnabled: Boolean(googleDocs), googleDocsCredentialsPath, googleDocsAuthPort };
}

async function collectOptions(options) {
  if (options.yes) {
    if (!options.harness) throw new Error("--yes requires --harness.");
    const mattPocockSkills = options.mattPocockSkills ?? "none";
    if (!MATT_POCOCK_SKILL_MODES.includes(mattPocockSkills)) throw new Error("Choose workflow, all, or none for --matt-pocock-skills.");
    const jiraAuthMode = options.jiraAuth ?? inferJiraAuthMode(process.env.JIRA_URL);
    if (!JIRA_AUTH_MODES.includes(jiraAuthMode)) throw new Error("Choose cloud or pat for --jira-auth.");
    const googleDocs = options.googleDocs ?? "off";
    if (!GOOGLE_DOCS_MODES.includes(googleDocs)) throw new Error("Choose on or off for --google-docs.");
    const googleOAuth = googleDocs === "on"
      ? await collectGoogleOAuthInput(options, { interactive: false })
      : { mode: "desktop-json", credentialsPath: "", clientId: "", clientSecret: "", authPort: 3000 };
    return {
      ...options,
      scope: options.scope ?? "project",
      mattPocockSkills,
      jiraAuthMode,
      googleDocsEnabled: googleDocs === "on",
      googleOauthMode: googleOAuth.mode,
      googleDocsCredentialsPath: googleOAuth.credentialsPath,
      googleClientId: googleOAuth.clientId,
      googleClientSecret: googleOAuth.clientSecret,
      googleAuthPort: googleOAuth.authPort
    };
  }
  const harness = options.harness ?? unwrapPrompt(await prompts.select({
    message: "Step 1 of 5 — Choose your coding-agent harness",
    options: HARNESS_CHOICES,
    initialValue: "pi"
  }));
  if (!HARNESS_CHOICES.some((choice) => choice.value === harness)) throw new Error("Choose pi, claude-code, codex, or opencode.");
  const scope = options.scope ?? unwrapPrompt(await prompts.select({
    message: "Step 2 of 5 — Choose the installation scope",
    options: SCOPE_CHOICES,
    initialValue: "project"
  }));
  const mattPocockSkills = unwrapPrompt(await prompts.select({
    message: "Step 3 of 5 — Choose Matt Pocock skills",
    options: [
      { value: "workflow", label: "Workflow skills", hint: "Recommended — only 14 skills used by this delivery workflow" },
      { value: "all", label: "All skills", hint: "Copy every skill from mattpocock/skills" },
      { value: "none", label: "None", hint: "Use the built-in workflow commands only" }
    ],
    initialValue: "workflow"
  }));
  const googleDocsEnabled = (options.googleDocs ?? unwrapPrompt(await prompts.select({
    message: "Step 4 of 5 — Read Google Docs linked from Jira?",
    options: [
      { value: "on", label: "Yes", hint: "Configure read-only Google Docs access" },
      { value: "off", label: "No", hint: "Skip Google Docs integration" }
    ],
    initialValue: "off"
  }))) === "on";
  if (options.googleDocs && !GOOGLE_DOCS_MODES.includes(options.googleDocs)) throw new Error("Choose on or off for --google-docs.");
  const googleOAuth = googleDocsEnabled
    ? await collectGoogleOAuthInput(options, { interactive: true })
    : { mode: "desktop-json", credentialsPath: "", clientId: "", clientSecret: "", authPort: 3000 };
  const configureSecrets = unwrapPrompt(await prompts.select({
    message: "Step 5 of 5 — Configure Jira and GitLab credentials now?",
    options: [
      { value: true, label: "Yes", hint: "Configure Jira and GitLab now" },
      { value: false, label: "No", hint: "Configure environment variables later" }
    ],
    initialValue: true
  }));
  let jiraAuthMode = options.jiraAuth ?? inferJiraAuthMode(process.env.JIRA_URL);
  let secrets;
  if (configureSecrets) {
    const jiraUrl = unwrapPrompt(await prompts.text({
      message: "Jira URL",
      placeholder: "https://jira.example.com",
      initialValue: process.env.JIRA_URL
    }));
    jiraAuthMode = options.jiraAuth ?? unwrapPrompt(await prompts.select({
      message: "Jira deployment and authentication",
      options: [
        { value: "cloud", label: "Atlassian Cloud", hint: "Email + Jira API token" },
        { value: "pat", label: "Server / Data Center", hint: "Jira personal access token (PAT)" }
      ],
      initialValue: inferJiraAuthMode(jiraUrl)
    }));
    const jiraCredentials = jiraAuthMode === "pat"
      ? { JIRA_PERSONAL_TOKEN: unwrapPrompt(await prompts.password({ message: "Jira personal access token", mask: "*" })) }
      : {
          JIRA_USERNAME: unwrapPrompt(await prompts.text({
            message: "Jira username or email",
            placeholder: "you@example.com",
            initialValue: process.env.JIRA_USERNAME
          })),
          JIRA_API_TOKEN: unwrapPrompt(await prompts.password({ message: "Jira API token", mask: "*" }))
        };
    const gitLabApiUrl = unwrapPrompt(await prompts.text({
      message: "GitLab API URL",
      placeholder: "https://gitlab.example.com/api/v4",
      initialValue: normalizeGitLabApiUrl(process.env.GITLAB_API_URL)
    }));
    secrets = {
      JIRA_URL: jiraUrl,
      ...jiraCredentials,
      GITLAB_API_URL: normalizeGitLabApiUrl(gitLabApiUrl),
      GITLAB_PERSONAL_ACCESS_TOKEN: unwrapPrompt(await prompts.password({ message: "GitLab personal access token", mask: "*" }))
    };
  } else if (!options.jiraAuth) {
    jiraAuthMode = unwrapPrompt(await prompts.select({
      message: "Jira deployment and authentication to configure later",
      options: [
        { value: "cloud", label: "Atlassian Cloud", hint: "JIRA_USERNAME + JIRA_API_TOKEN" },
        { value: "pat", label: "Server / Data Center", hint: "JIRA_PERSONAL_TOKEN" }
      ],
      initialValue: inferJiraAuthMode(process.env.JIRA_URL)
    }));
  }
  if (!JIRA_AUTH_MODES.includes(jiraAuthMode)) throw new Error("Choose cloud or pat for --jira-auth.");
  return {
    ...options,
    harness,
    scope,
    mattPocockSkills,
    jiraAuthMode,
    secrets,
    googleDocsEnabled,
    googleOauthMode: googleOAuth.mode,
    googleDocsCredentialsPath: googleOAuth.credentialsPath,
    googleClientId: googleOAuth.clientId,
    googleClientSecret: googleOAuth.clientSecret,
    googleAuthPort: googleOAuth.authPort
  };
}

export function mattPocockSkillsInstallArgs({ harness, scope, mode = "workflow" }) {
  if (!MATT_POCOCK_SKILL_MODES.includes(mode) || mode === "none") throw new Error("Matt Pocock skill mode must be workflow or all when installing.");
  const skillArgs = mode === "all"
    ? ["--skill", "*"]
    : MATT_POCOCK_WORKFLOW_SKILLS.flatMap((skill) => ["--skill", skill]);
  const args = [
    "--yes",
    "skills@latest",
    "add",
    "mattpocock/skills",
    ...skillArgs,
    "--agent",
    harness,
    "--yes",
    "--copy"
  ];
  if (scope === "global") args.push("--global");
  return args;
}

export function mattPocockSkillsInstaller({ harness, scope, mode = "workflow", platform = process.platform }) {
  if (!HARNESS_CHOICES.some((choice) => choice.value === harness)) throw new Error(`Unsupported harness: ${harness}`);
  if (!SCOPE_CHOICES.some((choice) => choice.value === scope)) throw new Error(`Unsupported scope: ${scope}`);
  const args = mattPocockSkillsInstallArgs({ harness, scope, mode });
  if (platform !== "win32") return { command: "npx", args };
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `npx ${args.join(" ")}`]
  };
}

async function installMattPocockSkills({ harness, scope, mattPocockSkills }) {
  const installer = mattPocockSkillsInstaller({ harness, scope, mode: mattPocockSkills });
  await execFileAsync(installer.command, installer.args, {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
    timeout: 5 * 60 * 1000
  });
}

export function googleDocsAuthInstaller({ platform = process.platform } = {}) {
  const args = ["-y", GOOGLE_DRIVE_MCP_PACKAGE, "auth"];
  if (platform !== "win32") return { command: "npx", args };
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `npx ${args.join(" ")}`]
  };
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {}
  }
  try { child.kill("SIGTERM"); } catch {}
}

export async function authenticateGoogleDocs(credentialsPath, {
  home = os.homedir(),
  authPort = 3000,
  installer = googleDocsAuthInstaller(),
  spawnProcess = spawn,
  stopChild = stopProcessTree,
  pollIntervalMs = 500,
  graceMs = 1500,
  timeoutMs = 5 * 60 * 1000
} = {}) {
  const tokenPath = defaultGoogleTokenPath(home);
  const before = await googleTokenSnapshot(tokenPath);
  const child = spawnProcess(installer.command, installer.args, {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "inherit",
    env: {
      ...process.env,
      GOOGLE_DRIVE_OAUTH_CREDENTIALS: credentialsPath,
      GOOGLE_DRIVE_MCP_SCOPES: GOOGLE_DRIVE_READONLY_SCOPES,
      GOOGLE_DRIVE_MCP_AUTH_PORT: String(normalizeGoogleAuthPort(authPort))
    }
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    let graceTimer;
    const cleanup = () => {
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };
    const succeed = async ({ terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) await stopChild(child);
      resolve();
    };
    const fail = async (error, { terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) await stopChild(child);
      reject(error);
    };
    const pollTimer = setInterval(async () => {
      const current = await googleTokenSnapshot(tokenPath);
      if (!settled && current && current !== before && !graceTimer) {
        graceTimer = setTimeout(() => void succeed({ terminate: true }), graceMs);
      }
    }, pollIntervalMs);
    const timeoutTimer = setTimeout(
      () => void fail(new Error(`Google OAuth timed out after ${Math.round(timeoutMs / 1000)} seconds.`), { terminate: true }),
      timeoutMs
    );
    child.once("error", (error) => void fail(error));
    child.once("exit", async (code) => {
      if (settled) return;
      const current = await googleTokenSnapshot(tokenPath);
      if (code === 0 || (current && current !== before)) await succeed();
      else await fail(new Error(`Google OAuth process exited with code ${code}.`));
    });
  });
}

async function persistWindowsSecrets(secrets) {
  if (!secrets || Object.keys(secrets).length === 0 || process.platform !== "win32") return false;
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
    if (output === existing) continue;
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
      includeMattPocockSetup: selected.mattPocockSkills !== "none",
      includeGoogleDocs: selected.googleDocsEnabled,
      googleDocsAuthPort: selected.googleAuthPort,
      jiraAuthMode: selected.jiraAuthMode,
      jiraUrl: selected.secrets?.JIRA_URL ?? process.env.JIRA_URL,
      gitLabApiUrl: selected.secrets?.GITLAB_API_URL ?? normalizeGitLabApiUrl(process.env.GITLAB_API_URL)
    });
    if (interactive) {
      const skillSummary = selected.mattPocockSkills === "workflow"
        ? `${MATT_POCOCK_WORKFLOW_SKILLS.length} workflow skills`
        : selected.mattPocockSkills === "all" ? "all skills" : "not selected";
      const googleDocsSummary = selected.googleDocsEnabled
        ? `read-only OAuth (${selected.googleOauthMode === "web-client" ? "Web client ID + secret" : "Desktop JSON"})`
        : "not configured";
      prompts.note(`Harness: ${selected.harness}\nScope: ${selected.scope}\nJira auth: ${selected.jiraAuthMode === "pat" ? "Server/Data Center PAT" : "Atlassian Cloud API token"}\nGoogle Docs: ${googleDocsSummary}\nFiles: ${new Set(plan.writes.map((write) => write.file)).size}\nMatt Pocock skills: ${skillSummary}\nGitLab writes: none until you explicitly approve them.`, "Ready to install");
    }

    progress = interactive ? prompts.spinner() : undefined;
    progress?.start(selected.dryRun ? "Preparing installation preview" : "Installing delivery workflow");
    const files = await applyPlan(plan, selected.dryRun);
    progress?.stop(selected.dryRun ? "Preview ready" : "Workflow files installed");
    if (!interactive) for (const file of files) console.log(`${selected.dryRun ? "[dry-run]" : "created/updated"} ${file}`);

    let installedMattPocockSkills = false;
    if (selected.mattPocockSkills !== "none" && !selected.dryRun) {
      progress?.start(`Copying ${selected.mattPocockSkills === "workflow" ? "workflow" : "all"} Matt Pocock skills (may take a few minutes)`);
      await installMattPocockSkills(selected);
      installedMattPocockSkills = true;
      progress?.stop("Original Matt Pocock skills copied");
    }

    let installedGoogleDocsCredentialsPath = selected.googleDocsCredentialsPath;
    if (selected.googleDocsEnabled && !selected.dryRun) {
      installedGoogleDocsCredentialsPath = selected.googleOauthMode === "web-client"
        ? await installGoogleDocsWebClient({
            clientId: selected.googleClientId,
            clientSecret: selected.googleClientSecret,
            authPort: selected.googleAuthPort
          })
        : await installGoogleDocsCredentials(selected.googleDocsCredentialsPath);
      if (interactive) prompts.log.success(`Google OAuth client installed in ${installedGoogleDocsCredentialsPath}`);
    }

    let authenticatedGoogleDocs = false;
    if (selected.googleDocsEnabled && !selected.dryRun && !selected.skipGoogleAuth) {
      if (interactive) prompts.log.info("Complete the read-only Google OAuth flow in your browser. OAuth logs will appear below.");
      await authenticateGoogleDocs(installedGoogleDocsCredentialsPath, { authPort: selected.googleAuthPort });
      authenticatedGoogleDocs = true;
    }

    const environmentValues = { ...selected.secrets };
    const persisted = selected.dryRun ? false : await persistWindowsSecrets(environmentValues);
    if (interactive) {
      prompts.note(files.map((file) => path.relative(process.cwd(), file) || path.basename(file)).join("\n"), selected.dryRun ? "Planned files" : "Installed files");
      if (installedMattPocockSkills) {
        prompts.log.success(`Copied ${selected.mattPocockSkills === "workflow" ? `${MATT_POCOCK_WORKFLOW_SKILLS.length} workflow` : "all"} Matt Pocock skills for ${selected.harness}. Matching workflow commands now prefer those skills.`);
        prompts.log.success("Bootstrapped the original skills' repository configuration for Jira requirements, GitLab delivery, triage labels, and domain docs.");
      }
      if (authenticatedGoogleDocs) prompts.log.success("Google Docs OAuth tokens were stored in the MCP server's user configuration directory.");
      if (selected.googleDocsEnabled && selected.skipGoogleAuth && !selected.dryRun) prompts.log.warn(`Google Docs is configured but not authenticated. Run: npx -y ${GOOGLE_DRIVE_MCP_PACKAGE} auth`);
      if (persisted) prompts.log.success("Configured Jira and GitLab environment values were saved as Windows user environment variables.");
      if (Object.keys(environmentValues).length && !persisted && !selected.dryRun) prompts.log.warn("Export the requested environment variables before starting the harness.");
      prompts.note(plan.notes.join("\n"), "Next step");
      prompts.outro(selected.dryRun ? "No files were changed." : "Installation complete. Restart the harness terminal, then begin a delivery.");
    } else {
      if (installedMattPocockSkills) {
        console.log(`Copied ${selected.mattPocockSkills === "workflow" ? `${MATT_POCOCK_WORKFLOW_SKILLS.length} workflow` : "all"} Matt Pocock skills for ${selected.harness}. Matching workflow commands now prefer those skills.`);
        console.log("Bootstrapped the original skills' repository configuration for Jira requirements, GitLab delivery, triage labels, and domain docs.");
      }
      if (authenticatedGoogleDocs) console.log("Google Docs read-only OAuth completed.");
      if (selected.googleDocsEnabled && selected.skipGoogleAuth && !selected.dryRun) console.log(`Google Docs is configured but not authenticated. Run: npx -y ${GOOGLE_DRIVE_MCP_PACKAGE} auth`);
      if (Object.keys(environmentValues).length && !persisted && !selected.dryRun) console.log("Environment values were not persisted on this platform. Export them before starting the harness.");
      if (persisted) console.log("Configured environment values were saved as Windows user environment variables. Restart the harness terminal to load them.");
      for (const note of plan.notes) console.log(note);
    }
  } catch (error) {
    if (error instanceof InstallationCancelled) return;
    progress?.stop("Installation stopped");
    if (error.killed) error.message = "An external installer or OAuth flow timed out after five minutes. Check the browser prompt and network, then run init again.";
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

async function selectInstalledHarnesses(options) {
  const scope = options.scope ?? "project";
  if (!SCOPE_CHOICES.some((choice) => choice.value === scope)) throw new Error(`Unsupported scope: ${scope}`);
  const detected = await detectInstalledHarnesses({ scope });
  if (options.harness) {
    if (!HARNESS_CHOICES.some((choice) => choice.value === options.harness)) throw new Error(`Unsupported harness: ${options.harness}`);
    if (!detected.includes(options.harness)) {
      throw new Error(`No ${options.harness} workflow installation was detected at ${scope} scope. Run init first.`);
    }
    return { scope, harnesses: [options.harness] };
  }
  if (detected.length === 0) throw new Error(`No coding-agent-harness installation was detected at ${scope} scope. Run init first or provide the correct --scope.`);
  return { scope, harnesses: detected };
}

async function update(options, { doctorFix = false } = {}) {
  const interactive = !options.yes && process.stdout.isTTY && !doctorFix;
  const selected = await selectInstalledHarnesses(options);
  if (interactive) {
    prompts.intro("Coding Agent Harness — update");
    prompts.note(`Harnesses: ${selected.harnesses.join(", ")}\nScope: ${selected.scope}\nSecrets: preserved`, "Detected installation");
  }
  if (options.googleDocs && !GOOGLE_DOCS_MODES.includes(options.googleDocs)) throw new Error("Choose on or off for --google-docs.");
  const requestedGoogleOAuth = options.googleDocs === "on"
    ? await collectGoogleOAuthInput(options, { interactive })
    : null;
  const changed = [];
  let detectedGoogleDocsCredentialsPath = "";
  let googleDocsInstalled = false;
  let detectedGoogleDocsAuthPort = 3000;
  for (const harness of selected.harnesses) {
    const runtime = await resolveInstalledConfiguration({
      harness,
      scope: selected.scope,
      jiraAuth: options.jiraAuth
    });
    const includeGoogleDocs = options.googleDocs ? options.googleDocs === "on" : runtime.googleDocsEnabled;
    if (includeGoogleDocs) {
      googleDocsInstalled = true;
      detectedGoogleDocsAuthPort = runtime.googleDocsAuthPort ?? detectedGoogleDocsAuthPort;
      if (!detectedGoogleDocsCredentialsPath && runtime.googleDocsCredentialsPath && await fileExists(runtime.googleDocsCredentialsPath)) {
        detectedGoogleDocsCredentialsPath = runtime.googleDocsCredentialsPath;
      }
    }
    if (!JIRA_AUTH_MODES.includes(runtime.jiraAuthMode)) throw new Error(`Unsupported Jira authentication mode: ${runtime.jiraAuthMode}`);
    const includeMattPocockSetup = selected.scope === "project"
      && (await fileExists(path.join(process.cwd(), "docs", "agents")) || await fileExists(path.join(process.cwd(), ".agents")) || await fileExists(path.join(process.cwd(), "skills-lock.json")));
    const plan = buildInstallPlan({
      harness,
      scope: selected.scope,
      cwd: process.cwd(),
      includeMattPocockSetup,
      includeGoogleDocs,
      googleDocsAuthPort: requestedGoogleOAuth?.authPort ?? runtime.googleDocsAuthPort ?? 3000,
      jiraAuthMode: runtime.jiraAuthMode,
      jiraUrl: runtime.jiraUrl,
      gitLabApiUrl: runtime.gitLabApiUrl
    });
    const files = await applyPlan(plan, options.dryRun);
    changed.push(...files);
    if (!interactive && !doctorFix) {
      for (const file of files) console.log(`${options.dryRun ? "[dry-run] would update" : "updated"} ${file}`);
    }
  }

  const googleDocsInstallSource = requestedGoogleOAuth?.credentialsPath || detectedGoogleDocsCredentialsPath;
  if (googleDocsInstalled && (googleDocsInstallSource || requestedGoogleOAuth?.mode === "web-client") && !options.dryRun) {
    const target = defaultGoogleCredentialsPath();
    const beforeCredentials = await readText(target);
    const installedGoogleDocsCredentialsPath = requestedGoogleOAuth?.mode === "web-client"
      ? await installGoogleDocsWebClient({
          clientId: requestedGoogleOAuth.clientId,
          clientSecret: requestedGoogleOAuth.clientSecret,
          authPort: requestedGoogleOAuth.authPort
        })
      : await installGoogleDocsCredentials(googleDocsInstallSource);
    const changedCredentials = beforeCredentials !== await readText(installedGoogleDocsCredentialsPath);
    if (changedCredentials) changed.push(installedGoogleDocsCredentialsPath);
    if (interactive) prompts.log.success(`Google OAuth client installed in ${installedGoogleDocsCredentialsPath}`);
    else if (changedCredentials && !doctorFix) console.log(`Google OAuth client installed in ${installedGoogleDocsCredentialsPath}`);
    if (options.googleDocs === "on" && !doctorFix && !options.skipGoogleAuth) {
      if (interactive) prompts.log.info("Complete the read-only Google OAuth flow in your browser. OAuth logs will appear below.");
      await authenticateGoogleDocs(installedGoogleDocsCredentialsPath, {
        authPort: requestedGoogleOAuth?.authPort ?? detectedGoogleDocsAuthPort
      });
    } else if (options.googleDocs === "on" && !doctorFix && !interactive) {
      console.log(`Google Docs is configured but not authenticated. Run: npx -y ${GOOGLE_DRIVE_MCP_PACKAGE} auth`);
    }
  }

  if (interactive) {
    prompts.note([...new Set(changed)].map((file) => path.relative(process.cwd(), file) || path.basename(file)).join("\n") || "Already up to date.", options.dryRun ? "Planned updates" : "Updated files");
    prompts.outro(options.dryRun ? "No files were changed." : "Workflow update complete. Restart or reload the harness.");
  }
  const files = [...new Set(changed)];
  if (!interactive && !doctorFix && files.length === 0) console.log("Workflow is already up to date.");
  return { ...selected, files };
}

async function commandAvailable(command) {
  try {
    if (process.platform === "win32") {
      await execFileAsync("where.exe", [command.replace(/\.cmd$/i, "")], { windowsHide: true, timeout: 10000 });
      return true;
    }
    await execFileAsync(command, ["--version"], { windowsHide: true, timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function doctor(options) {
  const scope = options.scope ?? "project";
  const npxAvailable = await commandAvailable(process.platform === "win32" ? "npx.cmd" : "npx");
  const uvxAvailable = await commandAvailable("uvx");
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`npx: ${npxAvailable ? "available" : "missing"}`);
  console.log(`uvx: ${uvxAvailable ? "available" : "missing"}`);

  let selected;
  try {
    selected = await selectInstalledHarnesses({ ...options, scope });
  } catch (error) {
    console.log(`Installation: not detected (${error.message})`);
    if (options.fix) throw error;
    return;
  }

  console.log(`Installation: ${selected.harnesses.join(", ")} (${scope})`);
  const findings = [];
  let needsGoogleAuth = false;
  if (!npxAvailable) findings.push("runtime: npx is missing");
  if (!uvxAvailable) findings.push("runtime: uvx is missing");
  for (const harness of selected.harnesses) {
    const runtime = await resolveInstalledConfiguration({ harness, scope, jiraAuth: options.jiraAuth });
    const configFile = mcpConfigPath({ harness, scope });
    const config = configFile && harness !== "codex" ? await readJson(configFile) : {};
    const jira = config.mcp?.jira ?? config.mcpServers?.jira;
    if (harness !== "codex" && !jira) findings.push(`${harness}: Jira MCP server is missing`);
    if (!runtime.jiraUrl) findings.push(`${harness}: Jira URL is unavailable to the current process/config`);
    const requiredJiraToken = runtime.jiraAuthMode === "pat" ? "JIRA_PERSONAL_TOKEN" : "JIRA_API_TOKEN";
    if (!(await readEnvironmentValue(requiredJiraToken))) findings.push(`${harness}: ${requiredJiraToken} is missing`);
    if (runtime.jiraAuthMode === "cloud" && !(await readEnvironmentValue("JIRA_USERNAME"))) findings.push(`${harness}: JIRA_USERNAME is missing`);
    if (harness === "pi") {
      const root = scope === "global" ? path.join(os.homedir(), ".pi", "agent") : path.join(process.cwd(), ".pi");
      const settings = await readJson(path.join(root, "settings.json"));
      if (!settings.packages?.includes("npm:pi-mcp-adapter@2.23.0")) findings.push("pi: pi-mcp-adapter@2.23.0 is not registered in settings.json");
    }
    if (runtime.googleDocsEnabled) {
      if (!runtime.googleDocsCredentialsPath) {
        findings.push(`${harness}: GOOGLE_DRIVE_OAUTH_CREDENTIALS is missing`);
        needsGoogleAuth = true;
      } else if (!(await fileExists(runtime.googleDocsCredentialsPath))) {
        findings.push(`${harness}: Google OAuth credentials file was not found at the configured path`);
        needsGoogleAuth = true;
      }
      const configuredTokenPath = resolveUserPath(await readEnvironmentValue("GOOGLE_DRIVE_MCP_TOKEN_PATH"));
      const tokenPath = configuredTokenPath || defaultGoogleTokenPath();
      if (!(await fileExists(tokenPath))) {
        findings.push(`${harness}: Google Docs OAuth token is missing`);
        needsGoogleAuth = true;
      }
    }
  }
  if (!(await readEnvironmentValue("GITLAB_PERSONAL_ACCESS_TOKEN"))) findings.push("GITLAB_PERSONAL_ACCESS_TOKEN is missing");

  if (findings.length === 0) console.log("Status: healthy");
  else {
    console.log(`Status: ${findings.length} issue(s) detected`);
    for (const finding of findings) console.log(`- ${finding}`);
  }

  if (!options.fix) {
    if (needsGoogleAuth) console.log(`Authenticate Google Docs after fixing the credential path: npx -y ${GOOGLE_DRIVE_MCP_PACKAGE} auth`);
    console.log("Run doctor --fix to repair managed workflow and MCP configuration without changing secret values.");
    return;
  }
  const result = await update({ ...options, yes: true, scope }, { doctorFix: true });
  for (const file of result.files) console.log(`${options.dryRun ? "[dry-run] would repair" : "repaired"} ${file}`);
  if (result.files.length === 0) console.log("No managed file changes were needed.");
  if (needsGoogleAuth) console.log(`Google Docs still requires interactive OAuth: npx -y ${GOOGLE_DRIVE_MCP_PACKAGE} auth`);
  console.log(options.dryRun ? "Doctor fix preview complete; no files were changed." : "Repair complete. Restart or reload the harness; in Pi reconnect the jira and google-docs MCP servers.");
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.command === "help") { console.log(help()); return; }
  if (options.command === "doctor") { await doctor(options); return; }
  if (options.command === "init") { await init(options); return; }
  if (options.command === "update") { await update(options); return; }
  if (options.command === "uninstall") { await uninstall(options); return; }
  throw new Error(`Unknown command: ${options.command}`);
}

export { buildInstallPlan, buildUninstallPlan, MATT_POCOCK_WORKFLOW_SKILLS, mergeWrite, removeManagedContent };

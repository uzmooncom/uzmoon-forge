/**
 * capability-registry.ts — Canonical capability registry for Permission Center V1.
 *
 * Only register capabilities that actually exist in the runtime.
 * Do not invent future runtime behavior just for UI completeness.
 *
 * Each capability has: id, category, name, description, risk, defaultPolicy,
 * requiresProject, isDestructive, isNetworked, isCredentialSensitive.
 */
import type { CapabilityDef } from "../../shared/types.js";

// ── Browser capabilities ─────────────────────────────────────────────────

const BROWSER_CAPABILITIES: CapabilityDef[] = [
  // App lifecycle
  {
    id: "browser.app.open",
    category: "browser",
    name: "Open Browser",
    description: "Open the Forge browser window.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: false,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "browser.app.focus",
    category: "browser",
    name: "Focus Browser",
    description: "Bring the Forge browser window to the foreground.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: false,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "browser.app.close",
    category: "browser",
    name: "Close Browser",
    description: "Close the Forge browser window.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: false,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  // Web interaction
  {
    id: "browser.web.read",
    category: "browser",
    name: "Read Page",
    description: "Read the content of a web page (URL, title, text, semantic elements).",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: false,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: false,
  },
  {
    id: "browser.web.navigate",
    category: "browser",
    name: "Navigate",
    description: "Navigate to a URL, go back, forward, or reload a page.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: false,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: false,
  },
  {
    id: "browser.web.interact",
    category: "browser",
    name: "Interact with Page",
    description: "Click, type, fill forms, select, scroll, press keys — modify page state.",
    risk: "MEDIUM",
    defaultPolicy: "ASK",
    requiresProject: false,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: true,
  },
  {
    id: "browser.web.download",
    category: "browser",
    name: "Download File",
    description: "Download a file from the web to the local filesystem.",
    risk: "MEDIUM",
    defaultPolicy: "ASK",
    requiresProject: false,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: false,
  },
  {
    id: "browser.web.upload",
    category: "browser",
    name: "Upload File",
    description: "Upload a local file to a website.",
    risk: "HIGH",
    defaultPolicy: "ASK",
    requiresProject: false,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: false,
  },
  {
    id: "browser.web.media_control",
    category: "browser",
    name: "Control Media",
    description: "Play, pause, mute, or seek media elements on a page.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: false,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: false,
  },
];

// ── Terminal capabilities ─────────────────────────────────────────────────

const TERMINAL_CAPABILITIES: CapabilityDef[] = [
  {
    id: "terminal.read_only",
    category: "terminal",
    name: "Read-only Command",
    description: "Run a command that only reads state (e.g., ls, cat, find, grep).",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.build",
    category: "terminal",
    name: "Build Project",
    description: "Run a build command (e.g., pnpm build, tsc).",
    risk: "LOW",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.test",
    category: "terminal",
    name: "Run Tests",
    description: "Run a test command (e.g., pnpm test, vitest, jest).",
    risk: "LOW",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.lint",
    category: "terminal",
    name: "Lint / Typecheck",
    description: "Run a lint or typecheck command (e.g., eslint, tsc --noEmit).",
    risk: "LOW",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.process_start",
    category: "terminal",
    name: "Start Process",
    description: "Start a long-running process (e.g., dev server).",
    risk: "MEDIUM",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.process_stop",
    category: "terminal",
    name: "Stop Process",
    description: "Stop a running process.",
    risk: "MEDIUM",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.network",
    category: "terminal",
    name: "Network Command",
    description: "Run a command that makes network requests (curl, wget).",
    risk: "HIGH",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: true,
  },
  {
    id: "terminal.download",
    category: "terminal",
    name: "Download via Terminal",
    description: "Download a file via a terminal command.",
    risk: "HIGH",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.package_install",
    category: "terminal",
    name: "Install Package",
    description: "Install a package (pnpm add, npm install, pip install, etc.).",
    risk: "HIGH",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: true,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.modify_files",
    category: "terminal",
    name: "Modify Files via Terminal",
    description: "Run a command that writes or deletes files outside the safe editing pipeline.",
    risk: "HIGH",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: true,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.shell",
    category: "terminal",
    name: "Shell Interpreter",
    description: "Run a shell interpreter (bash, sh, node -e, python -c). BLOCKED by Safe Terminal policy.",
    risk: "CRITICAL",
    defaultPolicy: "DENY",
    requiresProject: true,
    isDestructive: true,
    isNetworked: true,
    isCredentialSensitive: true,
  },
  {
    id: "terminal.outside_project",
    category: "terminal",
    name: "Command Outside Project",
    description: "Run a command with a working directory outside the current project root.",
    risk: "CRITICAL",
    defaultPolicy: "DENY",
    requiresProject: true,
    isDestructive: true,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "terminal.environment_access",
    category: "terminal",
    name: "Environment Variable Access",
    description: "Access environment variables beyond the sanitized set.",
    risk: "HIGH",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: true,
  },
];

// ── Git capabilities ────────────────────────────────────────────────────────

const GIT_CAPABILITIES: CapabilityDef[] = [
  {
    id: "git.status",
    category: "git",
    name: "Git Status",
    description: "Read current git status (staged, unstaged, untracked files).",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "git.diff",
    category: "git",
    name: "Git Diff",
    description: "Read diff output for staged or unstaged changes.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "git.log",
    category: "git",
    name: "Git Log",
    description: "Read commit history.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "git.show",
    category: "git",
    name: "Git Show",
    description: "Show a specific commit's content.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "git.branch_info",
    category: "git",
    name: "Git Branch Info",
    description: "Read current branch and upstream information.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "git.stage",
    category: "git",
    name: "Git Stage",
    description: "Stage files for commit (git add).",
    risk: "MEDIUM",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "git.unstage",
    category: "git",
    name: "Git Unstage",
    description: "Unstage files (git restore --staged).",
    risk: "MEDIUM",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "git.commit",
    category: "git",
    name: "Git Commit",
    description: "Create a commit from staged changes.",
    risk: "HIGH",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
];

// ── Filesystem / project editing capabilities ────────────────────────────

const FILESYSTEM_CAPABILITIES: CapabilityDef[] = [
  {
    id: "project.read",
    category: "filesystem",
    name: "Read Project Files",
    description: "Read files within the current project directory.",
    risk: "LOW",
    defaultPolicy: "ALWAYS_ALLOW",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "project.modify",
    category: "filesystem",
    name: "Modify Project Files",
    description: "Propose and apply edits to existing project files via the safe editing pipeline.",
    risk: "HIGH",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "project.create",
    category: "filesystem",
    name: "Create Project Files",
    description: "Create new files within the project directory via the safe editing pipeline.",
    risk: "MEDIUM",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "project.delete",
    category: "filesystem",
    name: "Delete Project Files",
    description: "Delete files within the project directory.",
    risk: "CRITICAL",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: true,
    isNetworked: false,
    isCredentialSensitive: false,
  },
  {
    id: "project.rename",
    category: "filesystem",
    name: "Rename Project Files",
    description: "Rename files within the project directory.",
    risk: "MEDIUM",
    defaultPolicy: "ASK",
    requiresProject: true,
    isDestructive: false,
    isNetworked: false,
    isCredentialSensitive: false,
  },
];

// ── Full registry ──────────────────────────────────────────────────────────

const ALL_CAPABILITIES: CapabilityDef[] = [
  ...BROWSER_CAPABILITIES,
  ...TERMINAL_CAPABILITIES,
  ...GIT_CAPABILITIES,
  ...FILESYSTEM_CAPABILITIES,
];

/** Map for O(1) lookup by capability id */
const CAPABILITY_MAP = new Map<string, CapabilityDef>(
  ALL_CAPABILITIES.map((c) => [c.id, c])
);

/**
 * Get all registered capability definitions.
 */
export function getAllCapabilities(): CapabilityDef[] {
  return [...ALL_CAPABILITIES];
}

/**
 * Get a specific capability by id. Returns null if not registered.
 */
export function getCapability(id: string): CapabilityDef | null {
  return CAPABILITY_MAP.get(id) ?? null;
}

/**
 * Check if a capability id is registered.
 */
export function isKnownCapability(id: string): boolean {
  return CAPABILITY_MAP.has(id);
}

/**
 * Get all capabilities in a category.
 */
export function getCapabilitiesByCategory(
  category: CapabilityDef["category"]
): CapabilityDef[] {
  return ALL_CAPABILITIES.filter((c) => c.category === category);
}
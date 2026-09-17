# Safe Terminal V1 — Design & Operational Guide

## Overview

Safe Terminal V1 adds deterministic, policy-governed command execution to Uzmoon Forge.
Commands run inside the project directory with no shell composition, no provider secret inheritance,
and a mandatory human-approval step for anything classified as high-risk.

This document covers the security model, command lifecycle, agent tool surface, policy engine,
and operational guidance for administrators and developers.

---

## Security Model

### Core Invariants

| Invariant | Description |
|-----------|-------------|
| `COMMAND_CWD_WITHIN_PROJECT` | `cwd` resolves (symlink-safe) to within the project root. Escape → immediate rejection. |
| `COMMAND_REQUIRES_AUTHORIZATION` | Only `allowed` or `approved` commands may spawn a process. |
| `COMMAND_START_ONCE` | A given `commandId` may only spawn a process once. Duplicate spawn is a no-op + invariant violation. |
| `COMMAND_IDENTITY_IMMUTABLE` | `CommandSpec` is frozen at creation time and never mutated. |
| `COMMAND_NO_PROVIDER_SECRET_ENV` | Child environment is built by `command-env.ts`. All provider API keys and Forge internals are stripped before `spawn()`. |
| `COMMAND_PROCESS_RELEASED` | Live process handles are cleared from the in-memory registry on every terminal state transition. |
| `COMMAND_OUTPUT_ISOLATED` | Output is captured in-process via `OutputBuffer`. It never writes to project files. |

### What Is NOT Sandboxed

Safe Terminal V1 does **not** provide:
- OS-level sandboxing (no seccomp, no namespaces, no chroot)
- Network isolation (child processes may make network calls)
- Filesystem write prevention beyond cwd containment

This is intentional: the goal is deterministic human oversight of **which commands run**,
not OS-level confinement of what they can do once running.

---

## Shell Composition: Always Disabled

`shell: false` is set unconditionally in `NodeProcessAdapter.spawn()`. This means:

- Shell operators (`|`, `&&`, `;`, `>`, `<`, `` ` ``, `$()`, `{}`, `[]`) are **never evaluated**.
- Each argument is passed directly to `execve()` — no shell interpolation, no glob expansion.
- The executable must be a single token (e.g. `pnpm`, `python3`). Paths with shell operators are rejected at validation time.

---

## Command Lifecycle (State Machine)

```
proposed
  ├─→ blocked          (policy: block — terminal)
  ├─→ awaiting_approval (policy: ask — waits for user decision)
  │     ├─→ queued     (user approves)
  │     └─→ cancelled  (user rejects)
  └─→ queued           (policy: allow — trusted rule matched)
        └─→ running
              ├─→ succeeded  (exit 0)
              ├─→ failed     (exit ≠ 0 or spawn error)
              ├─→ timed_out  (deadline exceeded)
              └─→ cancelled  (user stop or agent cancel)
```

Any state can transition to `cancelled` if the user or agent requests cancellation before the process terminates.

---

## Policy Engine

### Risk Classification (`CommandRiskClass`)

| Class | Examples | Default Decision |
|-------|----------|-----------------|
| `verification` | `git status`, `git log` | `allow` |
| `read_only` | None at V1 (cat/ls → `unknown`) | `allow` |
| `project_script` | `pnpm test`, `pnpm build`, `npm run *` | `allow` |
| `mutation` | `mkdir`, `mv`, `cp`, `rm` (non-recursive) | `ask` |
| `network` | `curl`, `wget`, `ssh`, `rsync` | `ask` |
| `package_install` | `pnpm install`, `pip install`, `npm install` | `ask` |
| `remote_execution` | `npx`, `bunx`, `pnpx`, `degit` | `block` |
| `shell_interpreter` | `node`, `python3`, `ruby`, `perl`, `php`, `lua`, `deno`, `bun` | `block` |
| `source_write_bypass` | `tee`, `dd`, `truncate` | `block` |
| `git` | `git commit`, `git push`, `git checkout` | `ask` |
| `destructive` | `rm -rf`, `git reset --hard`, `git clean -fd` | `ask` |
| `unknown` | Anything not matched above | `ask` |

**BLOCK always wins**: If a command matches `block`, no trust rule can override it.

### Trust Rules

A trust rule matches when:
1. `normalizeSpec(command)` equals the stored `normalizedSpec`, AND
2. If the spec references a local script file: the file's content hash matches `scriptContentHash`

Content hashing prevents a trusted `pnpm run build` from running if `package.json` changes the `build` script to something dangerous.

Trust rules are project-scoped. They have a `useCount` (incremented on each trusted run) but **no expiry** in V1.

---

## Agent Tool Surface

### `run_command`

Propose a command for execution. Returns immediately with one of:

- `{ status: "awaiting_approval", commandId }` — command needs user approval
- `{ commandId, exitCode, modelOutput, outputSummary }` — command completed (auto-approved/trusted)
- Error with `errorCode: "COMMAND_POLICY_BLOCK"` — blocked by policy
- Error with `errorCode: "COMMAND_BUDGET_EXCEEDED"` — per-run limit (10 commands/agent-run) reached

**Per-run budget**: `MAX_COMMANDS_PER_AGENT_RUN = 10`. The counter resets with each new agent request.

### `list_project_commands`

List recent commands for the active project. Useful for checking approval status or reviewing history.
Results are sorted newest-first. Optional filters: `conversation_id`, `state`, `limit` (max 100).

### `read_command_output`

Read ANSI-stripped, secret-redacted output from a command. Supports pagination via `offset_bytes` + `limit_bytes`.
Cross-project access is rejected (`ACCESS_DENIED`). Output is bounded to `MAX_MODEL_OUTPUT_BYTES = 8 KB` by default.

---

## Output Buffer

- **Ring buffer**: head 2 KB + tail 8 KB. Total captured: up to `MAX_OUTPUT_BYTES = 512 KB`.
- **ANSI stripping**: `stripAnsiAndControlChars()` removes color/cursor codes for clean display.
- **Secret redaction**: `sanitizeCommandOutputForModel()` redacts patterns like `sk-{20+alphanum}`.
- **Model output limit**: `MAX_MODEL_OUTPUT_BYTES = 8 KB` — prevents context flooding.

---

## Environment Stripping

`buildSafeChildEnvironment()` removes:

- All keys in `STRIPPED_ENV_VARS` (explicit allowlist: Anthropic, OpenAI, GitHub, AWS, Azure, GCP, Forge internals, DB credentials, common CI secrets).
- Any key matching heuristic patterns: ends with `_API_KEY`, `_SECRET_KEY`, `_SECRET`, `_AUTH_TOKEN`, `_ACCESS_TOKEN`, `_REFRESH_TOKEN`, `_PASSWORD`, `_CREDENTIAL(S)`, `_PRIVATE_KEY`; or starts with `SECRET_` / `PRIVATE_`.

PATH, HOME, LANG, and all non-secret OS variables are **preserved** so `pnpm`, `node`, and other tools continue to work normally.

---

## Process Termination

### Unix

`NodeProcessAdapter` spawns with `detached: true`, placing the child in its own process group (pgid = child.pid).

On cancel/timeout:
1. `SIGTERM` sent to the entire process group (`process.kill(-pgid, "SIGTERM")`)
2. After 3 s grace period: `SIGKILL` sent to the group

This ensures child processes (e.g. test runners spawning workers) are all terminated.

### Windows

`taskkill /F /T /PID <pid>` is spawned as a fire-and-forget process. The `/T` flag walks the Windows job ownership tree and kills all descendants. `/PID` is explicit — no kill-by-name that could affect unrelated processes.

---

## Startup Reconciliation

On main-process start, `reconcileOnStartup()` scans for commands in state `"running"` or `"queued"` (left over from a crash) and transitions them to `"cancelled"`. This ensures the DB never shows phantom running commands after a restart.

---

## Shutdown

`cancelAllOnQuit()` is called on `app.before-quit`. It cancels all non-terminal commands (best-effort, 2 s timeout) so processes are not orphaned when the app quits.

---

## Concurrency Limits

- `MAX_CONCURRENT_PER_PROJECT = 3`: At most 3 commands may run simultaneously within a project.
- Excess commands fail immediately (not queued). The agent must wait for a slot.
- `MAX_COMMANDS_PER_AGENT_RUN = 10`: Budget per agent request. Resets each turn.

---

## DB Persistence

Commands, outputs, and trust rules are stored in the JSON file store at `$FORGE_DATA_DIR/forge.json` under keys:

| Key | Description |
|-----|-------------|
| `commands` | `Record<id, CommandExecution>` |
| `commandOutputs` | `Record<commandId, string>` (raw text, may be truncated) |
| `trustRules` | `Record<id, CommandTrustRule>` |

Output text is written to DB only on command completion (not during streaming). Live output is served from the in-memory `OutputBuffer`.

---

## Reliability Integration

Safe Terminal V1 registers 13 invariants in the reliability subsystem (`invariants.ts`):

- `COMMAND_CWD_WITHIN_PROJECT` — cwd containment
- `COMMAND_REQUIRES_AUTHORIZATION` — approval gate
- `COMMAND_START_ONCE` — duplicate spawn prevention
- `COMMAND_IDENTITY_IMMUTABLE` — spec immutability
- `COMMAND_NO_PROVIDER_SECRET_ENV` — secret stripping
- `COMMAND_PROCESS_RELEASED` — handle cleanup
- `COMMAND_OUTPUT_ISOLATED` — output capture integrity
- `COMMAND_BUDGET_NOT_EXCEEDED` — per-run budget
- `COMMAND_TRUST_RULE_INTEGRITY` — script hash match
- `COMMAND_POLICY_IS_DETERMINISTIC` — no AI classifier
- `COMMAND_LIFECYCLE_VALID` — state machine correctness
- `COMMAND_PROJECT_ISOLATION` — cross-project access prevention
- `COMMAND_TERMINAL_STATE_IMMUTABLE` — terminal state never mutated

All invariant violations are recorded by the `IncidentRecorder` and appear in the Reliability section of Settings.

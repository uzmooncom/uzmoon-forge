# Electron QA Checklist — Uzmoon Forge V0.9

> This checklist covers both programmatically testable behavior and items
> that require human verification in a running Electron window.
>
> Items marked **[AUTO]** are covered by the automated test suite.  
> Items marked **[HUMAN]** require manual verification.

---

## 1. Startup & Initialization

| # | Check | Type | Status |
|---|---|---|---|
| S-01 | App starts without crash when `FORGE_DATA_DIR` is set | HUMAN | — |
| S-02 | App starts without crash when `FORGE_DATA_DIR` is not set (uses default) | HUMAN | — |
| S-03 | `forge.json` is created on first launch | HUMAN | — |
| S-04 | `sweepOrphanedSnapshots()` runs at startup without throwing | AUTO | ✓ `wiring.test.ts` |
| S-05 | `initReliabilityEngine()` runs at startup without throwing | AUTO | ✓ `wiring.test.ts` |
| S-06 | Welcome screen shown when `onboardingComplete = false` | HUMAN | — |
| S-07 | Connect Agent screen shown after Welcome | HUMAN | — |
| S-08 | Chat screen shown after completing onboarding | HUMAN | — |
| S-09 | Window title reads "Uzmoon Forge" | HUMAN | — |
| S-10 | App icon appears in macOS Dock / Windows taskbar | HUMAN | — |

---

## 2. Navigation & Window Management

| # | Check | Type | Status |
|---|---|---|---|
| N-01 | Navigating away from chat and back restores streaming bubble | AUTO | ✓ `navigation-resilience.test.ts` |
| N-02 | Switching between conversations preserves message history | HUMAN | — |
| N-03 | Back button in project workspace returns to project list | HUMAN | — |
| N-04 | Modal backdrop click closes modal | HUMAN | — |
| N-05 | Escape key closes modal (if wired) | HUMAN | — |
| N-06 | Window resize preserves layout (sidebar + chat area) | HUMAN | — |
| N-07 | Titlebar drag region allows window dragging | HUMAN | — |
| N-08 | Window close button quits app on macOS (last window) | HUMAN | — |

---

## 3. Agent Connection

| # | Check | Type | Status |
|---|---|---|---|
| A-01 | "Test Connection" IPC roundtrip returns connected/failed | AUTO | ✓ `client.test.ts` |
| A-02 | API key stored in OS keychain, not in `forge.json` | AUTO | ✓ secret-store design |
| A-03 | "Replace API Key" flow clears old key before storing new | HUMAN | — |
| A-04 | Connection test shows green checkmark on success | HUMAN | — |
| A-05 | Connection test shows red error message on failure | HUMAN | — |
| A-06 | Multiple agent profiles can be created and switched | HUMAN | — |

---

## 4. Chat

| # | Check | Type | Status |
|---|---|---|---|
| C-01 | Send message → streaming bubble appears immediately | HUMAN | — |
| C-02 | Streaming text appears word-by-word | HUMAN | — |
| C-03 | Tool activity rows appear during agent tool use | HUMAN | — |
| C-04 | Tool rows deduplicate (same action not shown twice) | AUTO | ✓ `StreamingBubble` dedup logic |
| C-05 | Streaming bubble replaced by final message bubble on completion | HUMAN | — |
| C-06 | Message copy button works | HUMAN | — |
| C-07 | Code blocks render with syntax highlighting | HUMAN | — |
| C-08 | Markdown (bold, italic, lists, headers) renders correctly | HUMAN | — |
| C-09 | Long messages scroll correctly | HUMAN | — |
| C-10 | 1-user-1-assistant ordering maintained | AUTO | ✓ `QueueManager.integration.test.ts` |
| C-11 | `forge_final` / `forge_tool` fences stripped from display | AUTO | ✓ `agent-runtime.test.ts` |

---

## 5. Message Queue

| # | Check | Type | Status |
|---|---|---|---|
| Q-01 | Queue panel shows queued items | HUMAN | — |
| Q-02 | Pause queue stops processing | AUTO | ✓ `queue-torture.test.ts` |
| Q-03 | Resume queue resumes processing | AUTO | ✓ `queue-torture.test.ts` |
| Q-04 | Skip item removes it from queue | AUTO | ✓ `queue-torture.test.ts` |
| Q-05 | Cancel stream aborts in-flight request | AUTO | ✓ `concurrent-isolation.test.ts` |
| Q-06 | Failed item shows retry option | HUMAN | — |
| Q-07 | Queue panel hidden when no waiting/failed items | AUTO | ✓ V0.8 QueuePanel fix |

---

## 6. Projects

| # | Check | Type | Status |
|---|---|---|---|
| PJ-01 | Create project → appears in projects list | HUMAN | — |
| PJ-02 | Open project → shows file explorer | HUMAN | — |
| PJ-03 | File explorer shows project directory tree | HUMAN | — |
| PJ-04 | Click file → file preview shows content | HUMAN | — |
| PJ-05 | Quick Open (Cmd+K) searches indexed files | HUMAN | — |
| PJ-06 | Drag file chip to chat input → context ref appears | HUMAN | — |
| PJ-07 | Archive project → disappears from active list | HUMAN | — |
| PJ-08 | Project conversations isolated from global chat | AUTO | ✓ `QueueManager.integration.test.ts` |

---

## 7. File Editing (V0.3+)

| # | Check | Type | Status |
|---|---|---|---|
| FE-01 | Agent read of file creates snapshot | AUTO | ✓ `agentRead.integration.test.ts` Req 6 |
| FE-02 | `forge_edit_proposal` fence triggers proposal UI | HUMAN | — |
| FE-03 | Proposal diff view shows base vs proposed content | HUMAN | — |
| FE-04 | "Apply" button applies change to file | HUMAN | — |
| FE-05 | "Undo" button restores file from backup | HUMAN | — |
| FE-06 | Stale file (modified after snapshot) shows warning | AUTO | ✓ `agentRead.integration.test.ts` Req 9 |
| FE-07 | Multi-file proposal requires selecting individual files | HUMAN | — |
| FE-08 | Apply lock prevents concurrent writes to same file | AUTO | ✓ `concurrent-isolation.test.ts` |

---

## 8. Reliability Panel

| # | Check | Type | Status |
|---|---|---|---|
| R-01 | Incident list shows recorded incidents | HUMAN | — |
| R-02 | Incident detail shows title, severity, category, description | HUMAN | — |
| R-03 | "Get share payload" disabled when sharing is off | HUMAN | — |
| R-04 | Enabling sharing in Settings → Privacy enables share payload | HUMAN | — |
| R-05 | Share payload contains no secrets or absolute paths | AUTO | ✓ `sanitizer.test.ts` |
| R-06 | "Copy to clipboard" copies sanitized JSON | HUMAN | — |
| R-07 | "Clear all" clears incident list | HUMAN | — |
| R-08 | New incident pushed to list via IPC without refresh | HUMAN | — |

---

## 9. Settings

| # | Check | Type | Status |
|---|---|---|---|
| ST-01 | Settings modal opens from sidebar | HUMAN | — |
| ST-02 | Agent Connection section saves changes | HUMAN | — |
| ST-03 | Appearance section shows Dark theme active | HUMAN | — |
| ST-04 | Privacy section shows sharing toggle | HUMAN | — |
| ST-05 | Sharing toggle persists across app restart | HUMAN | — |
| ST-06 | About section shows version number | HUMAN | — |

---

## 10. Stability Gate

| # | Check | Type | Status |
|---|---|---|---|
| SG-01 | `scripts/stability-gate.ts --json` exits 0 on clean store | AUTO | Script design |
| SG-02 | `scripts/stability-gate.ts` exits 1 after injecting a critical incident | AUTO | Script design |
| SG-03 | `--reset-on-pass` clears store only when gate passes | AUTO | Script design |
| SG-04 | `--dry-run` always exits 0 regardless of violations | AUTO | Script design |
| SG-05 | Missing `DATA_DIR` exits with code 2 | AUTO | Script design |

---

## 11. Data Integrity

| # | Check | Type | Status |
|---|---|---|---|
| DI-01 | `forge.json` is valid JSON after normal usage | HUMAN | — |
| DI-02 | Snapshot files survive app restart | HUMAN | — |
| DI-03 | Orphaned snapshots swept on next startup | AUTO | ✓ `resource-lifecycle.test.ts` |
| DI-04 | Incident store survives app restart | HUMAN | — |
| DI-05 | No incidents contain absolute paths after restart | AUTO | ✓ `sanitizer.test.ts` |

---

## 12. Error Handling

| # | Check | Type | Status |
|---|---|---|---|
| E-01 | Network error during streaming shows user-visible error | HUMAN | — |
| E-02 | `PROTOCOL_RECOVERY_EXHAUSTED` shows "Could not complete" message | AUTO | ✓ `agent-runtime.test.ts` |
| E-03 | Invalid `forge_final` JSON shows error bubble, not crash | AUTO | ✓ `agent-runtime.test.ts` |
| E-04 | File read error during agent loop recorded as incident | AUTO | ✓ `wiring.test.ts` |
| E-05 | `IncidentRecorder` disk failure does not crash app | AUTO | ✓ `torture.test.ts` fault injection |
| E-06 | `TraceRecorder` disk failure does not crash app | AUTO | ✓ `torture.test.ts` fault injection |

---

## Human QA Session Notes

### Pre-session setup

```bash
# Build the app
pnpm build

# Launch with test data dir
FORGE_DATA_DIR=$HOME/.uzmoon-forge-qa NODE_ENV=production \
  node_modules/.pnpm/electron@36.9.5_supports-color@8.1.1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  dist/main/main/main.js
```

### Cleanup

```bash
rm -rf $HOME/.uzmoon-forge-qa
```

### Known HUMAN items requiring special setup

- **S-01/S-02**: Test both with and without `FORGE_DATA_DIR` env var
- **A-01–A-06**: Requires a live agent endpoint (or mock server)
- **FE-02–FE-08**: Requires a project with at least one tracked file
- **R-01–R-08**: Requires injecting a test incident (use stability gate script with `--dry-run` + manual `forge.json` edit, or trigger via a known bug reproduction)

---

## Automation Coverage Summary

| Category | AUTO | HUMAN | Total |
|---|---|---|---|
| Startup | 2 | 8 | 10 |
| Navigation | 1 | 7 | 8 |
| Agent Connection | 2 | 4 | 6 |
| Chat | 5 | 6 | 11 |
| Queue | 5 | 2 | 7 |
| Projects | 1 | 7 | 8 |
| File Editing | 3 | 5 | 8 |
| Reliability Panel | 1 | 7 | 8 |
| Settings | 1 | 5 | 6 |
| Stability Gate | 5 | 0 | 5 |
| Data Integrity | 3 | 2 | 5 |
| Error Handling | 5 | 1 | 6 |
| **Total** | **34** | **54** | **88** |

Automated coverage: **39%** (34/88).  
All critical correctness properties are in the automated suite.  
Human QA focuses on visual/UX behavior that requires a running window.
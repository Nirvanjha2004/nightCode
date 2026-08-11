# Error Recovery & Actionable Errors — Design Note

This document describes how tool failures flow through NightCode: how the agent receives a **recoverable** failure, and how the UI shows a **concise** error instead of a green checkmark or a raw stack blob.

---

## 1. The problem it fixes

For a coding agent, a failing command is normal — `npm test` fails, the agent inspects, fixes, re-runs. Before this change:

1. **A failed `bash` command looked like a success.** `bash` deliberately returns non-zero exits as a *result* (so the agent gets stdout/stderr/exit code), never an exception. The loop therefore set `ok: true`, and the activity feed showed a **green `✓ npm test · 3.2s`** even when the command failed.
2. **The exit code was invisible.** The shell result is formatted with `exit code: N` on the **last** line, but the feed preview shows only the first 5 lines — so a failing test's exit code was cut off.
3. **Thrown errors were raw.** `read` of a missing file surfaced `Error: ENOENT: no such file or directory, open '...'` — accurate but noisy for the feed.

---

## 2. Design constraints (from the task)

- Failures are **recoverable**: the agent must receive the actual failure (tool name, exit code, stderr, stdout) and decide whether to retry — there is **no automatic retry**.
- The UI must show a **concise, bounded** error — never a huge stack trace or a multi-MB log.
- The agent must be able to continue after an intermediate failure (loop must not terminate).
- Cancellation stays separate: `Esc`/`Ctrl+C` still produces `AbortError`, never a "recoverable tool failure".
- No new frameworks, no retry counters, no iteration-limit changes, no new dependencies.

---

## 3. The mechanism

### 3.1 Shell tools already returned failures as results (unchanged)

`bash` and `grep` never throw on a non-zero exit — they return a formatted string so the model can read the output and react:

```
$ npm test
--- stdout ---
...
--- stderr ---
2 tests failed
Expected 200 but received 401
exit code: 1 — took 3200ms
```

So the **agent always had** the full failure. The loop already continues after it. What was missing was the **signaling** and the **UI summary**.

### 3.2 `bash` now signals failure: `{ ok: false, text }` (`tools.ts:750`)

On a non-zero exit (or timeout/kill), `bash` returns a tiny structured result instead of a bare string:

```ts
return { ok: false, text: result };
```

- `text` is the **exact same formatted result** as before — the agent's view is unchanged.
- `ok: false` is the failure signal. `grep` still returns a plain string, so its `exit code: 1` "no matches" convention stays a **success** (`✓`).

### 3.3 The loop interprets the signal (`loop.ts:395-410`)

```ts
const execResult: unknown = await tool.exec(...);
if (typeof execResult === "string") {
    result = execResult;
} else if (execResult && typeof execResult === "object") {
    // Structured shell-tool result: a failing command is a RESULT, not an
    // exception ... but `ok: false` flips the feed row to ✗.
    const structured = execResult as { ok?: boolean; text?: string };
    if (structured.ok === false) toolOk = false;
    result = typeof structured.text === "string" ? structured.text : JSON.stringify(execResult);
} else {
    result = JSON.stringify(execResult);
}
```

- `toolOk` flips to `false` → the `tool_end` event carries `ok: false` → the feed renders `✗`.
- `result` (the full formatted text) is still stored in history → the agent sees everything.
- String results from every other tool are untouched.

### 3.4 Concise failure summary — `summarizeToolFailure` (`loop.ts:101`)

New helper, exported alongside `previewToolArgs`/`previewToolResult`:

```ts
export function summarizeToolFailure(result: string): string {
    const lines = result.replace(/\r\n/g, "\n").split("\n");
    // formatShellResult always ends with `exit code: N … — took Xms` — match
    // only the LAST line so an "exit code: N" printed in stdout/stderr can't
    // be mistaken for the real exit code.
    const exitMatch = lines[lines.length - 1]?.match(/exit code: (\d+)/);
    if (exitMatch) {
        const summary = [`exit code ${exitMatch[1]}`];
        const stderrIdx = lines.findIndex((l) => l === "--- stderr ---");
        if (stderrIdx >= 0) {
            for (const raw of lines.slice(stderrIdx + 1)) {
                const line = raw.trim();
                if (line && !line.startsWith("exit code:")) {
                    summary.push(line.slice(0, FAILURE_SUMMARY_LINE_MAX));
                    break;
                }
            }
        }
        return summary.slice(0, FAILURE_SUMMARY_LINES).join("\n");
    }
    const first = lines.find((l) => l.trim()) ?? "Tool failed";
    return first.replace(/^Error:\s*/, "").slice(0, FAILURE_SUMMARY_LINE_MAX);
}
```

Rules:

| Case | Summary |
|---|---|
| Shell result (`bash`) | `exit code N` + first non-empty stderr line — test failures usually surface there |
| Thrown error | the message with `Error:` stripped |
| Empty result | `Tool failed` |
| Bound | **2 lines max, 120 chars per line** — a 10k-line failed build never reaches the feed |

Two deliberate details:
- The exit code is matched on the **last line only**, because `formatShellResult` always appends it last — a command whose *output* prints `exit code: 3` can't spoof the summary.
- The exit code line and the first stderr line are both capped, so the summary is always short.

### 3.5 `tool_end` preview switch (`loop.ts:448`)

```ts
resultPreview: toolOk ? previewToolResult(result) : summarizeToolFailure(result),
```

- **Success** → the existing bounded head preview (5 lines / 400 chars) — unchanged.
- **Failure** → the concise summary. The full result is still stored in history for the agent and is NOT reduced to "Tool failed".

### 3.6 `read` gives a clean missing-file error (`tools.ts:225`)

```ts
if (err?.code === "ENOENT") throw new Error(`File not found: ${file}`);
```

The common failure now reads `File not found: src/nonexistent.ts` for both the agent and the UI summary. (The `assertNotMemoryPath` guard throws an `Error` without a `.code`, so it is not intercepted.)

---

## 4. What the UI now shows

```
⠋ Running tests                              (tool_start live row)
✗ npm test · 3.2s                             (tool_end, ok:false)
  exit code 1
  2 tests failed                              ← resultPreview = summarizeToolFailure
⠋ Inspecting failure
✓ read · 0.2s
✓ write · 0.3s
⠋ Running tests again
✓ npm test · 3.0s
```

and for a missing file:

```
✗ read · 0.1s
  File not found: src/nonexistent.ts
```

No changes were needed in `index.tsx` — `ToolEndRow` already renders `resultPreview` dimmed under the red `✗` row; it just receives the concise summary now.

---

## 5. Recovery flow (unchanged behavior, now visible)

```
User: "Run the tests."
  ↓
Tool: npm test → exit 1            ← ✗ npm test · 3.2s / exit code 1 (visible now)
  ↓
Agent (sees full output in history): "auth test is failing, I'll inspect auth.ts."
  ↓
Tool: read auth.ts → SUCCESS
  ↓
Agent: fixes the problem
  ↓
Tool: npm test → exit 0            ← ✓ npm test · 2.8s
  ↓
"Tests are passing now."
```

The LLM decides whether to recover — there is no automatic retry and no hard-coded per-tool logic.

---

## 6. What explicitly did NOT change

| Concern | Status |
|---|---|
| Loop termination on tool failure | Already non-terminating — unchanged |
| `maxIterations` | Unchanged (10) |
| Cancellation | `bash` still throws `CancelledError` on abort; `Esc`/`Ctrl+C` unchanged |
| `grep` no-match (`exit code: 1`) | Still a `✓` — grep returns a plain string, never `{ok:false}` |
| Successful tool previews | Identical head preview as before |
| Status bar | Intermediate failures never set `error` status — only an unrecoverable `execute()` rejection does |
| Agent-facing result | Identical — full formatted text / `Error: msg` in history |
| Output bounds | Existing `truncate` (12k, head+tail) + new ≤2-line summary |

---

## 7. Validation

- `bunx tsc --noEmit -p packages/cli/tsconfig.json` — clean
- All self-checks PASS: `activity.check.ts` (new failure-summary + `{ok:false}` assertions), `tools.check.ts`, `cancel.check.ts`, `subagent.check.ts`, `commands.check.ts`, `groq-client.check.ts`
- Real-run verification:
  - `bash {command: "exit 1"}` → `{ ok: false, text }`, summary `exit code 1`
  - `bash` failing with stderr → summary `exit code 1` + first stderr line
  - `read {file: missing}` → `File not found: <path>`, summary matches

---

## 8. Files touched

| File | Change |
|---|---|
| `packages/cli/src/agent/loop.ts` | `summarizeToolFailure()` helper (`:101`); structured `{ok:false,text}` result handling (`:395-410`); `tool_end.resultPreview` switch to concise summary on failure (`:448`) |
| `packages/cli/src/agent/tools.ts` | `bash` returns `{ ok: false, text }` on non-zero exit (`:750`); `read` maps `ENOENT` → `File not found: <path>` (`:225`) |
| `packages/cli/src/agent/activity.check.ts` | Asserts `summarizeToolFailure` output + `{ok:false}` loop handling |
| `packages/cli/src/agent/cancel.check.ts` | 1-line fix to a pre-existing stale assertion (`/aborted/i` → `isAbort`) — see below |

## 9. Out-of-scope note

`cancel.check.ts` section 5 was **already failing before this task**: the abort watchdog (from the cancel-latency fix) rejects with `CancelledError` (message `"Agent run cancelled."`, `name === "AbortError"`), which the stale `/aborted/i` message regex could never match. Aligned to the file's own `isAbort` name-check — one line, needed so the verification suite is green. This is unrelated to error recovery.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hatice polls an issue tracker, claims eligible issues, spins up an isolated workspace for each, and runs a Claude Code agent until the issue reaches a terminal state. TypeScript, Node 20+ / Bun, Hono, Claude Agent SDK, Zod v4, LiquidJS, Pino, Vitest.

This file lives at `.claude/CLAUDE.md` and is checked into git (shared project memory). Use `.claude.local.md` for personal overrides that should stay out of the repo.

## Commands

```bash
npm test                                    # vitest run
npm run test:watch                          # vitest
npm run typecheck                           # tsc --noEmit
npm run build                               # tsup
npm run dev -- start -w ./WORKFLOW.md       # tsx bin/hatice.ts ...
npx tsx bin/hatice.ts start -w ./WORKFLOW.md --port 4000  # with dashboard at http://127.0.0.1:4000

npx vitest run test/orchestrator.test.ts    # one file
npx vitest run -t "chooseIssues prioritizes" # one test by name
```

`tsconfig.json` enables `noUnusedLocals` and `noUnusedParameters`. Typecheck rejects unused vars and unused params (prefix with `_` to suppress).

## Architecture: the tick loop

The system is a single state machine in `src/orchestrator.ts`. Every `polling.intervalMs` (default 30s), `onTick()` runs:

1. **Hot-reload config.** `WorkflowStore.load()` checks `WORKFLOW.md`'s mtime+hash and reparses if changed. On parse error, the last-good config is kept. Don't cache `this.config` across tick boundaries — always read it fresh after `load()`.
2. **Reconcile running.** For each agent currently running, `reconcileRunning()` re-fetches the issue's state from the tracker. If terminal → abort the agent, remove workspace, mark completed. If no longer active → abort and unclaim. Reconciliation failures fail open (keep agents running).
3. **Fetch & dispatch.** `tracker.fetchCandidateIssues()` returns candidates. `chooseIssues()` filters (active state, assigned, no active blockers, not already claimed/running/completed, slot available) and sorts (priority asc, createdAt asc, identifier asc). `dispatchIssue()` claims, creates a workspace, builds an `AgentRunner`, attaches a stall timer, and starts the run.

Agent exit goes through `handleWorkerExit()`:
- `normal` → post completion comment to tracker, move issue to `Done`, mark completed, **preserve workspace** (cleaned up by `StartupCleanup` on next boot).
- `error` → exponential backoff `min(10_000 * 2^(attempt-1), maxRetryBackoffMs)`, schedule retry. On retry, the issue is re-fetched and revalidated before re-dispatch.
- `cancelled` → unclaim, emit `issue:released`. Workspace stays.

State lives in `OrchestratorState` as four collections: `running` (Map), `claimed` (Set), `completed` (Set), `retryAttempts` (Map). Slot accounting is global (`maxConcurrentAgents`) plus optional per-state limits (`maxConcurrentAgentsByState`).

Two event channels are emitted in parallel: a typed `EventBus` (subscribed by `SSEBroadcaster` for the dashboard) and a plain `EventEmitter` (for programmatic consumers). When emitting, hit both.

## Module map

```
src/
  orchestrator.ts           tick loop, dispatch, reconciliation
  orchestrator-state.ts     running/claimed/completed/retry collections + slot math
  agent-runner.ts           Claude Agent SDK turn loop, session resume, token accounting
  workflow-store.ts         hot-reload WORKFLOW.md (mtime + sha256, fail-safe)
  workspace.ts              isolated dir per issue, hooks (afterCreate/beforeRun/afterRun/beforeRemove)
  config.ts                 Zod schema, env var resolution ($VAR), gray-matter parsing
  prompt-builder.ts         LiquidJS rendering of the WORKFLOW.md body
  http-server.ts            Hono: dashboard HTML, JSON API, SSE stream
  status-dashboard.ts       terminal ANSI display
  dashboard-template.ts     dashboard HTML + inline JS
  event-bus.ts              typed PubSub with onAny() wildcards
  supervisor.ts             crash recovery wrapper (OTP-style restart)
  cleanup.ts                age-based stale workspace cleanup at startup
  session-logger.ts         per-session NDJSON Pino logs
  sse-broadcaster.ts        bridges EventBus -> SSE clients
  rate-limiter.ts           tracks 429s per tracker
  input-handler.ts          auto-respond when agent asks a clarifying question
  turn-timeout.ts           per-turn AbortController deadline
  snapshot-timeout.ts       Promise.race wrapper for HTTP snapshots
  agent-spawn.ts            configurable agent binary (claudeCodePath)
  path-utils.ts             ~/ expansion in config paths
  linear/   github/   gitlab/   tracker.ts  (MemoryTracker)
  types.ts  errors.ts  logger.ts  index.ts
```

All trackers conform to the `Tracker` interface in `types.ts`. `MemoryTracker` is the demo path used when `tracker.kind = "memory"`.

## Non-obvious gotchas

- **`Issue.id` must equal `Issue.identifier` for GitHub.** The GitHub adapter sets `id = identifier` (e.g. `owner/repo#123`) so REST endpoints that take the issue number can round-trip. Don't change this without checking commit `03e402a` and `src/github/adapter.ts`.
- **ESM imports use `.js`.** Source is `.ts` but imports must end in `.js` (e.g. `import { X } from './x.js'`). TypeScript's `moduleResolution: bundler` allows this; tsup needs it.
- **`bypassPermissions` is the default.** `claude.permissionMode` defaults to `bypassPermissions`, not the SDK default. Agents run unattended, so permission prompts would deadlock.
- **Workspace is preserved after success.** `handleWorkerExit` does NOT remove the workspace on `normal` exit. Cleanup happens at next boot via `StartupCleanup` (age-based). This is intentional — uncommitted code changes survive a crash.
- **Reconciliation is fail-open.** If the tracker fetch fails during reconcile, all running agents are kept. Don't change this to fail-closed without thinking through partial outage scenarios.
- **State name comparison is normalized.** Always compare via `.trim().toLowerCase()` against `activeStates` / `terminalStates` sets. See `chooseIssues` and `reconcileRunning`.

## Conventions

- **Tests:** `test/<module>.test.ts`. Integration tests in `test/integration/` (`lifecycle`, `dispatch-cycle`, `wired-lifecycle`) — run these before refactoring `orchestrator.ts`.
- **Config:** WORKFLOW.md is YAML frontmatter (parsed via gray-matter, validated by Zod) plus a LiquidJS body used as the agent prompt template. `$ENV_VAR` and `~/` are resolved at load time.
- **Logging:** Pino structured JSON. Use `createLogger({ component: 'name' })` and pass context as the first arg: `log.info({ issueId }, 'message')`.
- **Errors:** Custom classes in `errors.ts` (`ConfigError`, `TrackerError`, `WorkspaceError`, `AgentError`, `HookError`). Don't throw plain `Error`.
- **Types:** All in `types.ts`. Interfaces preferred over type aliases.

## TDD methodology (mandatory)

All feature work and bug fixes follow TDD. Tests verify **behavior through public interfaces**, not implementation details. A good test reads like a specification.

### Vertical slices, not horizontal

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
```

Writing all tests first produces tests that verify *imagined* behavior. One test, one minimal implementation, repeat.

### Workflow

1. **Plan.** List behaviors to test (not implementation steps). Identify deep-module opportunities (small interface, deep implementation). Design for testability via dependency injection.
2. **Tracer bullet.** Write one test for one behavior. Watch it fail. Write the minimum code to pass.
3. **Loop.** For each remaining behavior: RED → minimal GREEN. Don't anticipate future tests.
4. **Refactor.** Only when GREEN. Extract duplication, deepen modules, apply SOLID where it fits naturally. Run tests after each step. **Never refactor while RED.**

### Per-cycle checklist

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive an internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```

### Good vs bad tests

```typescript
// GOOD: observable behavior through the public API
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});

// BAD: couples to implementation
test("checkout calls paymentService.process", async () => {
  const mockPayment = vi.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});

// BAD: bypasses interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

### Mocking

Mock at **system boundaries** only: external APIs (Linear/GitHub/GitLab/Claude SDK), the file system (sometimes — prefer real temp dirs), time, and randomness.

Never mock your own classes, internal collaborators, or anything you control. If a class is hard to test without mocking it, the design is wrong — inject the dependency instead.

```typescript
// Testable
function processOrder(order, paymentGateway) { /* ... */ }

// Hard to test
function processOrder(order) {
  const gateway = new StripeGateway();
}
```

### Deep modules

Prefer small interfaces over deep implementations. Few methods, simple params, complex logic hidden behind them. After a TDD cycle, look for: duplication (extract), long methods (private helpers, keep tests on the public interface), shallow modules (combine or deepen), feature envy (move logic where the data lives), primitive obsession (introduce value objects).

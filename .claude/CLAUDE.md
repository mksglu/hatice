# Hatice — Project Rules

## Overview

Hatice is an autonomous coding agent orchestration system. It polls issue trackers (Linear, GitHub Issues), creates isolated workspaces, and dispatches Claude Code agents to solve issues. Full lifecycle: dispatch, multi-turn execution, retry, backoff, reconciliation, observability.

**Stack:** TypeScript, Node.js 20+ / Bun, Hono, Claude Agent SDK, Zod v4, LiquidJS, Pino, Vitest

## Development Methodology: TDD (Default)

All feature development and bug fixes MUST follow Test-Driven Development.

### Core Principle

Tests verify **behavior through public interfaces**, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists.

### Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This produces tests that verify _imagined_ behavior rather than _actual_ behavior.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
```

### Workflow

#### 1. Planning
- Confirm what interface changes are needed
- Confirm which behaviors to test (prioritize)
- Identify opportunities for deep modules (small interface, deep implementation)
- Design interfaces for testability
- List behaviors to test (not implementation steps)

#### 2. Tracer Bullet
Write ONE test that confirms ONE thing:
```
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
```

#### 3. Incremental Loop
For each remaining behavior:
```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```
Rules: One test at a time. Only enough code to pass current test. Don't anticipate future tests.

#### 4. Refactor
After all tests pass:
- Extract duplication
- Deepen modules (move complexity behind simple interfaces)
- Apply SOLID principles where natural
- Run tests after each refactor step
- **Never refactor while RED.** Get to GREEN first.

### Checklist Per Cycle
```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```

### Good Tests vs Bad Tests

**Good:** Integration-style, through public APIs, describe WHAT not HOW
```typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

**Bad:** Coupled to implementation, mock internal collaborators
```typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});

// BAD: Bypasses interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

### Mocking Guidelines

Mock at **system boundaries** only:
- External APIs (Linear, GitHub, Claude SDK)
- File system (sometimes — prefer real temp dirs)
- Time/randomness

**Never mock:**
- Your own classes/modules
- Internal collaborators
- Anything you control

Design for mockability via dependency injection:
```typescript
// Testable
function processOrder(order, paymentGateway) {}

// Hard to test
function processOrder(order) {
  const gateway = new StripeGateway();
}
```

### Deep Modules

Prefer deep modules: small interface + lots of implementation.
```
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params
├─────────────────────┤
│  Deep Implementation│  ← Complex logic hidden
└─────────────────────┘
```

### Interface Design for Testability

1. **Accept dependencies, don't create them** (dependency injection)
2. **Return results, don't produce side effects**
3. **Small surface area** — fewer methods = fewer tests needed

### Refactor Candidates

After TDD cycle, look for:
- **Duplication** → Extract function/class
- **Long methods** → Break into private helpers (keep tests on public interface)
- **Shallow modules** → Combine or deepen
- **Feature envy** → Move logic to where data lives
- **Primitive obsession** → Introduce value objects

## Project Commands

```bash
# Run all tests
npx vitest run

# Run specific test
npx vitest run test/<name>.test.ts

# Type check
npx tsc --noEmit

# Build
npx tsup

# Start (demo mode)
npx tsx bin/hatice.ts start -w ./WORKFLOW.md
```

## Architecture

```
src/
  orchestrator.ts      — Main state machine (tick loop, dispatch, reconciliation)
  orchestrator-state.ts — State container (running, claimed, completed, retry maps)
  agent-runner.ts      — Claude Agent SDK integration (turn loop, session resume)
  http-server.ts       — Hono HTTP server (API + SSE + HTML dashboard)
  event-bus.ts         — Typed PubSub with wildcard support
  supervisor.ts        — Process crash recovery (OTP-like)
  config.ts            — Zod v4 validation + WORKFLOW.md parsing
  prompt-builder.ts    — LiquidJS template rendering
  workspace.ts         — Isolated workspace lifecycle + hooks
  workflow-store.ts    — Hot-reload config watcher
  tracker.ts           — MemoryTracker for test/demo
  linear/              — Linear GraphQL client + adapter
  github/              — GitHub REST client + adapter
  rate-limiter.ts      — API 429 tracking
  session-logger.ts    — Per-agent Pino log files
  sse-broadcaster.ts   — SSE event streaming
  input-handler.ts     — Auto-respond to agent input
  turn-timeout.ts      — Per-turn AbortController timeout
  snapshot-timeout.ts  — Promise.race timeout wrapper
  cleanup.ts           — Stale workspace cleanup
  agent-spawn.ts       — Configurable agent binary
  path-utils.ts        — Home dir expansion
  dashboard-template.ts — Rich SSE-powered HTML dashboard
  types.ts             — All type definitions
  errors.ts            — Error classes
  logger.ts            — Pino structured logging
  index.ts             — Public API exports
```

## Conventions

- **Test files:** `test/<module>.test.ts`, integration tests in `test/integration/`
- **Imports:** Use `.js` extension for ESM imports
- **Config:** WORKFLOW.md with YAML frontmatter + LiquidJS body
- **Logging:** Pino structured JSON, child loggers with context
- **Errors:** Custom error classes from `errors.ts`
- **Types:** All in `types.ts`, interfaces preferred over type aliases

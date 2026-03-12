# hatice

**Autonomous issue orchestration for the agent-first era.**

Hatice polls your issue tracker, spins up isolated workspaces, and dispatches Claude Code agents to solve each issue end-to-end. Full lifecycle management: dispatch, multi-turn execution, retry with exponential backoff, reconciliation, and real-time observability.

> *"Humans steer. Agents execute."*
>
> This project embraces the [Harness Engineering](https://openai.com/index/harness-engineering/) manifesto — the idea that the engineer's role is no longer to write code, but to **design environments, specify intent, and build feedback loops** that allow coding agents to do reliable work.
>
> OpenAI demonstrated this with Codex. Hatice is the working, open-source implementation of the same philosophy — powered by **Claude Code Agent SDK**.

https://github.com/user-attachments/assets/3232c476-c573-4311-b6d4-3941578b0ce3

---

## The Manifesto

In February 2026, OpenAI published "Harness Engineering" — a radical rethinking of software development where **every line of code is written by agents**, and engineers focus on scaffolding, specification, and leverage.

We share this vision. Hatice was built to prove it works with Claude Code:

- **Specification-driven development** — A single `WORKFLOW.md` file defines tracker config, workspace hooks, agent behavior, and the task prompt. The agent reads it; the human writes it.
- **Repository knowledge as system of record** — `.claude/CLAUDE.md` encodes TDD methodology, architectural constraints, and coding standards. Agents follow them automatically.
- **Feedback loops over manual fixes** — When an agent fails, Hatice retries with exponential backoff, re-checks tracker state, and reconciles. The system self-corrects.
- **Parallel agent orchestration** — Multiple agents work concurrently on different issues, each in isolated workspaces with independent sessions.
- **Observability-first** — Real-time SSE dashboard, terminal ANSI display, per-session logs, rate limit tracking, and token accounting. You see everything the agents do.

This is not a wrapper or a toy. This is a production-grade orchestration system — **4,148 lines of application code, 6,669 lines of tests, 328 test cases across 30 files, zero type errors** — built to run autonomous coding agents at scale.

---

## Symphony vs Hatice

Hatice was inspired by the architectural patterns demonstrated in [Symphony](https://github.com/openai/symphony), OpenAI's Elixir/OTP orchestration system for Codex agents. We reimagined every component from scratch in TypeScript, replacing Codex with Claude Code Agent SDK and adding capabilities that go beyond the original.

**No code was copied. No license was violated.** We adopted the manifesto, studied the architecture, and built something new.

| Capability | Symphony (Elixir/Codex) | Hatice (TypeScript/Claude) |
|---|---|---|
| **Runtime** | Elixir/OTP (BEAM VM) | Node.js 20+ / Bun |
| **Agent SDK** | Codex JSON-RPC over stdio | Claude Code Agent SDK `query()` |
| **Web Framework** | Phoenix + LiveView (WebSocket) | Hono + SSE (EventSource) |
| **Config Validation** | NimbleOptions | Zod v4 |
| **Template Engine** | EEx | LiquidJS |
| **Logging** | Elixir Logger | Pino (structured JSON) |
| **CLI** | OptionParser | Commander.js |
| **Process Supervision** | OTP Supervisor (native) | Custom Supervisor class |
| **PubSub** | Phoenix.PubSub | Typed EventBus with wildcard |
| **Real-time Dashboard** | Phoenix LiveView | SSE + vanilla JS |
| **Issue Tracker** | Linear only | Linear + GitHub Issues + GitLab |
| **Test Framework** | ExUnit (~17 files) | Vitest (30 files, 328 tests) |
| **Model Selection** | Fixed (Codex) | Configurable (`claude.model`) |
| **Cost Tracking** | Not available | Per-session USD tracking |
| **Cache Token Metrics** | Not available | `cacheRead/CreationInputTokens` |
| **Tool Control** | Approval policy | `allowedTools` / `disallowedTools` + `canUseTool` |
| **MCP Tools** | Not available | `linear_graphql` + `github_graphql` |
| **Workspace Artifacts** | `.elixir_ls` cleanup | 8-pattern temp dir cleanup |
| **Home Dir Expansion** | Not available | `~/` in config paths |
| **Per-session Logs** | LogFile module | Pino per-session NDJSON files |
| **Rate Limit Tracking** | Event-based display | Full 429 tracking + dashboard |
| **Input Handling** | Not available | Auto-respond to agent input |
| **Turn Timeout** | Not available | Per-turn AbortController deadline |
| **Snapshot Timeout** | GenServer timeout | Promise.race wrapper |
| **Startup Cleanup** | Terminal state cleanup | Stale workspace cleanup (age-based) |
| **TDD Methodology** | Not embedded | Built-in via `.claude/CLAUDE.md` |

### What Hatice adds beyond Symphony

- **GitHub Issues support** — Not just Linear. Full REST + GraphQL adapter with `owner/repo` format.
- **GitLab support** — Full REST adapter for GitLab CE/EE. Supports incident severity-to-priority mapping and self-hosted instances.
- **Claude Code Agent SDK** — High-level `query()` API instead of raw JSON-RPC protocol management.
- **SSE real-time dashboard** — No WebSocket framework dependency. Pure EventSource + vanilla JS.
- **Typed EventBus** — Full type safety with wildcard `onAny()` support, not just string-based PubSub.
- **Per-session cost tracking** — Know exactly how much each agent session costs in USD.
- **Fine-grained tool control** — Allow/disallow specific tools, custom `canUseTool` callbacks.
- **MCP server tools** — Agents can query Linear and GitHub APIs directly via MCP.
- **Built-in TDD** — `.claude/CLAUDE.md` enforces test-driven development for all contributions.

---

## Quick Start

```bash
# Clone
git clone https://github.com/mertcanaltin/hatice.git
cd hatice

# Install
npm install

# Demo mode (no API keys needed)
npx tsx bin/hatice.ts start -w ./WORKFLOW.md
```

### With Linear

Create a `WORKFLOW.md`:

```markdown
---
tracker:
  kind: linear
  apiKey: $LINEAR_API_KEY
  projectSlug: "MY-PROJECT"
  activeStates: ["Todo", "In Progress"]
  terminalStates: ["Done", "Cancelled"]
  assignee: "me"
workspace:
  rootDir: ~/workspaces
agent:
  maxConcurrentAgents: 5
  maxTurns: 20
claude:
  permissionMode: bypassPermissions
server:
  port: 4000
---
You are an expert software engineer. Solve the following issue:

**{{ issue.identifier }}: {{ issue.title }}**

{{ issue.description }}

Work in the provided workspace. Write tests first, then implement. Commit when done.
```

```bash
npx tsx bin/hatice.ts start -w ./WORKFLOW.md --port 4000
```

### With GitHub Issues

```yaml
tracker:
  kind: github
  apiKey: $GITHUB_TOKEN
  projectSlug: "owner/repo"
  activeStates: ["open"]
  terminalStates: ["closed"]
```

### With GitLab (CE/EE)

Works with both GitLab.com and self-hosted GitLab CE/EE instances.

```yaml
tracker:
  kind: gitlab
  endpoint: "https://gitlab.example.com"   # Your GitLab instance URL
  apiKey: $GITLAB_TOKEN                     # Personal or project access token
  projectSlug: "your-group/your-project"    # Full project path
  activeStates: ["Open"]
  terminalStates: ["Closed"]
  assignee: "your-username"
```

GitLab incidents with a `severity` field (critical/high/medium/low) are automatically mapped to priority levels. Priority labels (`Priority::Urgent`, `Priority::High`, etc.) take precedence when both are present.

See [examples/workflow-gitlab.md](examples/workflow-gitlab.md) for a full workflow example.

---

## Architecture

```
bin/hatice.ts              CLI entry (Commander.js)
  |
  |-- StartupCleanup       Remove stale workspaces
  |-- Supervisor            Crash recovery wrapper
  |
  v
Orchestrator               Main state machine
  |-- OrchestratorState     running/claimed/completed/retry maps
  |-- WorkflowStore         Hot-reload WORKFLOW.md (mtime + hash)
  |-- Workspace             Isolated dirs + hooks + artifact cleanup
  |-- AgentRunner           Claude SDK turn loop
  |     |-- SessionLogger   Per-session Pino logs
  |     |-- RateLimiter     429 tracking
  |     |-- InputHandler    Auto-respond to input
  |     |-- TurnTimeout     Per-turn deadline
  |     '-- PromptBuilder   LiquidJS templates
  |-- EventBus              Typed PubSub (11 event types)
  |
  v
HttpServer (Hono)
  |-- GET /                 SSE-powered HTML dashboard
  |-- GET /api/v1/state     JSON snapshot
  |-- GET /api/v1/:id       Single issue lookup
  |-- GET /api/v1/events    SSE stream (real-time)
  |-- POST /api/v1/refresh  Force poll
  '-- Secure headers middleware

Trackers
  |-- LinearAdapter         GraphQL client + pagination
  |-- GitHubAdapter         REST + GraphQL client
  |-- GitLabAdapter         REST client (CE/EE compatible)
  '-- MemoryTracker         In-memory (test/demo)
```

---

## Development

Hatice follows **Test-Driven Development** by default. The TDD methodology is embedded in `.claude/CLAUDE.md` and enforced for all contributions.

```bash
# Run tests
npx vitest run

# Watch mode
npx vitest

# Type check
npx tsc --noEmit

# Build
npx tsup
```

### Stats

| Metric | Value |
|---|---|
| Source files | 30 |
| Test files | 30 |
| Test cases | 328 |
| Source lines | 4,148 |
| Test lines | 6,669 |
| Type errors | 0 |
| Dependencies | 8 runtime + 4 dev |

---

## Configuration Reference

All configuration lives in `WORKFLOW.md` YAML frontmatter:

| Section | Key | Default | Description |
|---|---|---|---|
| `tracker` | `kind` | — | `linear`, `github`, `gitlab`, or `memory` |
| | `apiKey` | — | API key (supports `$ENV_VAR` syntax) |
| | `endpoint` | `null` | Tracker API base URL (required for GitLab) |
| | `projectSlug` | — | Project identifier |
| | `activeStates` | — | States that trigger dispatch |
| | `terminalStates` | — | States that trigger cleanup |
| | `assignee` | `null` | Filter by assignee (`"me"` for current user) |
| `polling` | `intervalMs` | `30000` | Poll interval in milliseconds |
| `workspace` | `rootDir` | — | Root directory for workspaces (supports `~/`) |
| `hooks` | `afterCreate` | `null` | Shell command after workspace creation |
| | `beforeRun` | `null` | Shell command before agent run |
| | `afterRun` | `null` | Shell command after agent run |
| | `beforeRemove` | `null` | Shell command before workspace removal |
| | `timeoutMs` | `60000` | Hook execution timeout |
| `agent` | `maxConcurrentAgents` | `10` | Max parallel agents |
| | `maxTurns` | `20` | Max turns per agent session |
| | `maxRetryBackoffMs` | `300000` | Max retry backoff (5 min) |
| | `retryOnNormalExit` | `false` | Retry after successful completion |
| `claude` | `model` | `null` | Claude model to use |
| | `permissionMode` | `bypassPermissions` | SDK permission mode |
| | `turnTimeoutMs` | `3600000` | Per-turn timeout (1 hour) |
| | `stallTimeoutMs` | `300000` | Stall detection timeout (5 min) |
| | `allowedTools` | `null` | Whitelist specific tools |
| | `disallowedTools` | `null` | Blacklist specific tools |
| | `canUseTool` | `null` | Per-tool boolean map |
| | `autoRespondToInput` | `true` | Auto-respond to agent input requests |
| | `claudeCodePath` | `null` | Custom Claude Code binary path |
| `server` | `port` | `null` | HTTP server port |
| | `host` | `127.0.0.1` | HTTP server host |

---

## API

### JSON Endpoints

```bash
# Get full orchestrator state
curl http://localhost:4000/api/v1/state

# Get single issue details
curl http://localhost:4000/api/v1/ISSUE-123

# Force immediate poll
curl -X POST http://localhost:4000/api/v1/refresh
```

### SSE Stream

```javascript
const es = new EventSource('http://localhost:4000/api/v1/events');

es.addEventListener('issue:dispatched', (e) => {
  console.log('Dispatched:', JSON.parse(e.data));
});

es.addEventListener('issue:completed', (e) => {
  console.log('Completed:', JSON.parse(e.data));
});

es.addEventListener('state:updated', () => {
  // Fetch fresh state
  fetch('/api/v1/state').then(r => r.json()).then(console.log);
});
```

### Programmatic Usage

```typescript
import {
  Orchestrator,
  WorkflowStore,
  LinearAdapter,
  HttpServer,
  EventBus,
} from 'hatice';

const workflowStore = new WorkflowStore('./WORKFLOW.md');
const config = workflowStore.getCurrentConfig();
const tracker = new LinearAdapter(config.tracker);

const orchestrator = new Orchestrator({ tracker, workflowStore, config });
const eventBus = orchestrator.getEventBus();

// Subscribe to events
eventBus.on('issue:dispatched', (id, identifier) => {
  console.log(`Dispatched: ${identifier}`);
});

// Start HTTP dashboard
const server = new HttpServer(orchestrator, 4000, '127.0.0.1', eventBus);
await server.start();

// Start orchestrating
orchestrator.start();
```

---

## Acknowledgments

This project was inspired by the **Harness Engineering** philosophy articulated by [Ryan Lopopolo at OpenAI](https://openai.com/index/harness-engineering/) and the architectural patterns demonstrated in [Symphony](https://github.com/openai/symphony) (Elixir/OTP).

We believe in the agent-first future. Hatice is our contribution to making it real with Claude Code.

**No code was copied from Symphony.** We studied the architecture, adopted the manifesto, and rebuilt every component from scratch in TypeScript with the Claude Code Agent SDK. This is an independent implementation — a gift to the community.

---

## License

MIT

---

*Built with Claude Code Agent SDK. Every line of code in this repository was written by AI agents, guided by humans.*

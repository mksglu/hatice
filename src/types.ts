// Issue (normalized from tracker - Linear or GitHub)
export interface Issue {
  id: string;
  identifier: string;           // e.g., "MT-123" or "owner/repo#45"
  title: string;
  description: string | null;
  state: string;                // e.g., "Todo", "In Progress"
  priority: number | null;      // 1-4, null = no priority
  labels: string[];             // lowercase normalized
  blockedBy: BlockerRef[];
  createdAt: string;            // ISO 8601
  updatedAt: string;            // ISO 8601
  assignedToWorker: boolean;
  url: string | null;
  branchName: string | null;
  assigneeId: string | null;
}

export interface BlockerRef {
  id: string;
  identifier: string;
  state: string;
}

// Running agent entry
export interface RunningEntry {
  issueId: string;
  identifier: string;
  issue: Issue;
  state: string;
  startedAt: Date;
  attempt: number;
  sessionId: string | null;
  lastEvent: string | null;
  lastEventAt: Date | null;
  lastActivityAt: Date;
  tokenUsage: TokenUsage;
  abortController: AbortController;
  promise: Promise<WorkerResult>;
}

export interface RetryState {
  issueId: string;
  identifier: string;
  attempt: number;
  scheduledAt: Date;
  delayMs: number;
  timerHandle: ReturnType<typeof setTimeout>;
  lastError: string | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export interface AggregateTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export type WorkerResult =
  | { kind: 'normal'; issueId: string; turnsCompleted: number; usage: TokenUsage; durationMs: number }
  | { kind: 'error'; issueId: string; error: Error; attempt: number; durationMs: number }
  | { kind: 'cancelled'; issueId: string; reason: string };

// Config types
export interface haticeConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  claude: ClaudeConfig;
  server: ServerConfig;
}

export interface TrackerConfig {
  kind: 'linear' | 'github' | 'gitlab' | 'memory';
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
  assignee: string | null;
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  rootDir: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
  retryOnNormalExit: boolean;
}

export interface ClaudeConfig {
  model: string | null;
  permissionMode: string;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  systemPrompt: string | null;
  canUseTool: Record<string, boolean> | null;
  claudeCodePath: string | null;
  autoRespondToInput: boolean;
  dryRun: boolean;
}

export interface ServerConfig {
  port: number | null;
  host: string;
}

// Tracker interface
export interface Tracker {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;
  createComment(issueId: string, body: string): Promise<void>;
  updateIssueState(issueId: string, stateName: string): Promise<void>;
}

// Workflow (parsed from WORKFLOW.md)
export interface Workflow {
  config: haticeConfig;
  promptTemplate: string;
}

// Snapshot for observability
export interface OrchestratorSnapshot {
  running: SnapshotRunningEntry[];
  retrying: SnapshotRetryEntry[];
  completed: number;
  totals: AggregateTotals;
  polling: {
    intervalMs: number;
    nextPollInMs: number;
  };
}

export interface SnapshotRunningEntry {
  issueId: string;
  identifier: string;
  state: string;
  sessionId: string | null;
  attempt: number;
  runtimeSeconds: number;
  tokenUsage: TokenUsage;
  lastEvent: string | null;
  lastEventAt: Date | null;
}

export interface SnapshotRetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  nextRetryInMs: number;
  lastError: string | null;
}

// Typed events for EventEmitter
export interface haticeEvents extends Record<string, unknown[]> {
  'state:updated': [];
  'issue:dispatched': [issueId: string, identifier: string];
  'issue:completed': [issueId: string, identifier: string, usage: TokenUsage];
  'issue:failed': [issueId: string, identifier: string, error: Error];
  'issue:retrying': [issueId: string, identifier: string, attempt: number, delayMs: number];
  'issue:released': [issueId: string, identifier: string, reason: string];
  'agent:event': [issueId: string, eventName: string, detail: string];
  'tokens:updated': [issueId: string, usage: TokenUsage];
  'config:reloaded': [config: haticeConfig];
  'tick:start': [];
  'tick:end': [dispatchedCount: number];
}

// Utility: create empty token usage
export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
}

// Utility: create empty aggregate totals
export function emptyAggregateTotals(): AggregateTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  };
}

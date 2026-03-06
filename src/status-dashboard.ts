import type { OrchestratorSnapshot } from './types.js';
import type { RateLimitTracker } from './rate-limiter.js';

// ANSI escape codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

// Sparkline block characters (9 levels: index 0-8)
const BLOCKS = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

export class StatusDashboard {
  private tokenSamples: Array<{ timestamp: number; tokens: number }> = [];
  private throughputWindowMs = 5_000;
  private graphWindowMs = 600_000; // 10 minutes
  private graphWidth = 25;
  private graphBucketMs = 24_000; // 24s per bucket
  private renderIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private getSnapshot: () => OrchestratorSnapshot;
  private renderFn: (output: string) => void;
  private rateLimitTracker: RateLimitTracker | null;

  constructor(
    getSnapshot: () => OrchestratorSnapshot,
    options: {
      renderIntervalMs?: number;
      renderFn?: (output: string) => void;
      rateLimitTracker?: RateLimitTracker;
    } = {},
  ) {
    this.getSnapshot = getSnapshot;
    this.renderIntervalMs = options.renderIntervalMs ?? 1000;
    this.renderFn = options.renderFn ?? ((output: string) => {
      process.stdout.write('\x1b[2J\x1b[H' + output); // Clear screen + move cursor
    });
    this.rateLimitTracker = options.rateLimitTracker ?? null;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.render();
    }, this.renderIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  addTokenSample(tokens: number): void {
    this.tokenSamples.push({ timestamp: Date.now(), tokens });
    // Prune old samples
    const cutoff = Date.now() - this.graphWindowMs;
    this.tokenSamples = this.tokenSamples.filter(s => s.timestamp > cutoff);
  }

  render(): void {
    const snapshot = this.getSnapshot();
    const output = this.renderSnapshot(snapshot);
    this.renderFn(output);
  }

  renderSnapshot(snapshot: OrchestratorSnapshot): string {
    const lines: string[] = [];

    // Header
    lines.push(`${BOLD}${MAGENTA}  hatice${RESET}  ${DIM}Issue Orchestration Dashboard${RESET}`);
    lines.push('');

    // Stats row
    const { totals } = snapshot;
    lines.push([
      `${GREEN}${snapshot.running.length}${RESET} running`,
      `${YELLOW}${snapshot.retrying.length}${RESET} retrying`,
      `${BLUE}${snapshot.completed}${RESET} completed`,
      `${CYAN}${StatusDashboard.formatTokens(totals.totalTokens)}${RESET} tokens`,
      `${DIM}${StatusDashboard.formatDuration(totals.secondsRunning)} total runtime${RESET}`,
    ].join('  '));
    lines.push('');

    // Running agents table
    if (snapshot.running.length > 0) {
      lines.push(`${BOLD}Running Agents${RESET}`);
      lines.push(`${DIM}${'ID'.padEnd(12)}${'State'.padEnd(14)}${'Age'.padEnd(10)}${'Tokens'.padEnd(10)}${'Event'.padEnd(30)}${RESET}`);
      for (const entry of snapshot.running) {
        lines.push([
          entry.identifier.slice(0, 11).padEnd(12),
          entry.state.slice(0, 13).padEnd(14),
          StatusDashboard.formatDuration(entry.runtimeSeconds).padEnd(10),
          StatusDashboard.formatTokens(entry.tokenUsage.totalTokens).padEnd(10),
          (entry.lastEvent ?? '-').slice(0, 29),
        ].join(''));
      }
      lines.push('');
    }

    // Retry queue
    if (snapshot.retrying.length > 0) {
      lines.push(`${BOLD}${YELLOW}Retry Queue${RESET}`);
      for (const entry of snapshot.retrying) {
        const retryIn = StatusDashboard.formatDuration(entry.nextRetryInMs / 1000);
        lines.push(`  ${entry.identifier} attempt #${entry.attempt} → retry in ${retryIn}${entry.lastError ? ` (${entry.lastError.slice(0, 50)})` : ''}`);
      }
      lines.push('');
    }

    // Throughput sparkline
    const tps = this.calcThroughput();
    const sparkline = this.renderSparkline();
    if (sparkline) {
      lines.push(`${BOLD}Throughput${RESET}  ${CYAN}${tps.toFixed(0)} tok/s${RESET}  ${DIM}[${sparkline}]${RESET}`);
      lines.push('');
    }

    // Rate Limit Status
    if (this.rateLimitTracker) {
      const allLimits = this.rateLimitTracker.getAllLimits();
      const activeLimits = allLimits.filter(l => l.isLimited);

      lines.push(`${BOLD}Rate Limit Status${RESET}`);
      if (activeLimits.length > 0) {
        for (const limit of activeLimits) {
          const retryStr = limit.retryAfterMs != null
            ? `retry in ${StatusDashboard.formatDuration(limit.retryAfterMs / 1000)}`
            : 'retry pending';
          lines.push(`  ${RED}\u26a0 RATE LIMITED${RESET}  ${YELLOW}${limit.source}${RESET}  ${DIM}${retryStr} (hit ${limit.limitCount}x)${RESET}`);
        }
      } else {
        lines.push(`  ${GREEN}\u2713 OK${RESET}`);
      }
      lines.push('');
    }

    // Polling info
    lines.push(`${DIM}Next poll in ${(snapshot.polling.nextPollInMs / 1000).toFixed(0)}s (every ${(snapshot.polling.intervalMs / 1000).toFixed(0)}s)${RESET}`);

    return lines.join('\n');
  }

  // Public static helpers for testing
  static formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  static formatTokens(tokens: number): string {
    if (tokens < 1000) return String(tokens);
    if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }

  renderSparkline(): string {
    if (this.tokenSamples.length === 0) return '';
    const now = Date.now();
    const buckets = new Array(this.graphWidth).fill(0);

    for (const sample of this.tokenSamples) {
      const age = now - sample.timestamp;
      const bucketIndex = this.graphWidth - 1 - Math.floor(age / this.graphBucketMs);
      if (bucketIndex >= 0 && bucketIndex < this.graphWidth) {
        buckets[bucketIndex] += sample.tokens;
      }
    }

    const max = Math.max(...buckets, 1);
    return buckets.map((v: number) => BLOCKS[Math.round((v / max) * 8)]).join('');
  }

  calcThroughput(): number {
    const now = Date.now();
    const cutoff = now - this.throughputWindowMs;
    const recent = this.tokenSamples.filter(s => s.timestamp > cutoff);
    if (recent.length === 0) return 0;
    const totalTokens = recent.reduce((sum, s) => sum + s.tokens, 0);
    return totalTokens / (this.throughputWindowMs / 1000);
  }
}

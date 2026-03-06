import type { OrchestratorSnapshot, SnapshotRunningEntry, SnapshotRetryEntry } from './types.js';

/**
 * Renders a rich, SSE-powered HTML dashboard for hatice.
 * Dark theme, monospace, cyberpunk-inspired. No external dependencies.
 */
export function renderLiveDashboard(snapshot: OrchestratorSnapshot): string {
  const runningRows = snapshot.running.length > 0
    ? snapshot.running.map((r: SnapshotRunningEntry) =>
        `<tr>
          <td class="cell-id">${esc(r.identifier)}</td>
          <td><span class="badge badge-${stateBadge(r.state)}">${esc(r.state)}</span></td>
          <td>${r.runtimeSeconds.toFixed(0)}s</td>
          <td>${fmt(r.tokenUsage.totalTokens)}</td>
          <td class="cell-event">${esc(r.lastEvent ?? '-')}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="5" class="empty-row">No agents running</td></tr>';

  const retryRows = snapshot.retrying.length > 0
    ? snapshot.retrying.map((r: SnapshotRetryEntry) =>
        `<tr>
          <td class="cell-id">${esc(r.identifier)}</td>
          <td>${r.attempt}</td>
          <td>${(r.nextRetryInMs / 1000).toFixed(1)}s</td>
          <td class="cell-error">${esc(r.lastError ?? '-')}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="4" class="empty-row">No retries pending</td></tr>';

  const totals = snapshot.totals;
  const costUsd = computeCostFromRunning(snapshot.running);
  const cacheRead = sumField(snapshot.running, 'cacheReadInputTokens');
  const cacheCreation = sumField(snapshot.running, 'cacheCreationInputTokens');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hatice // live dashboard</title>
<noscript><meta http-equiv="refresh" content="5"></noscript>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace;
    background: #0d1117; color: #c9d1d9; padding: 24px 32px;
    line-height: 1.5; min-height: 100vh;
  }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Hero */
  .hero { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; border-bottom: 1px solid #21262d; padding-bottom: 24px; }
  .hero-title { font-size: 28px; font-weight: 700; letter-spacing: 2px; color: #58a6ff; text-transform: lowercase; }
  .hero-sub { font-size: 13px; color: #484f58; margin-top: 2px; }
  .status-badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
    padding: 4px 12px; border-radius: 12px; border: 1px solid;
  }
  .status-live { color: #3fb950; border-color: #238636; background: rgba(63,185,80,0.1); }
  .status-live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #3fb950; animation: pulse 1.5s infinite; }
  .status-offline { color: #f85149; border-color: #da3633; background: rgba(248,81,73,0.1); }
  .status-offline::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #f85149; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  /* Stats cards */
  .stats-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px; margin-bottom: 32px;
  }
  .stat-card {
    background: #161b22; border: 1px solid #21262d; border-radius: 8px;
    padding: 16px; transition: border-color 0.2s;
  }
  .stat-card:hover { border-color: #30363d; }
  .stat-label { font-size: 11px; color: #484f58; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .stat-value { font-size: 24px; font-weight: 700; }
  .stat-running .stat-value { color: #58a6ff; }
  .stat-retrying .stat-value { color: #d29922; }
  .stat-completed .stat-value { color: #3fb950; }
  .stat-tokens .stat-value { color: #bc8cff; }

  /* Section */
  .section { margin-bottom: 32px; }
  .section-header {
    font-size: 14px; font-weight: 600; color: #58a6ff; text-transform: uppercase;
    letter-spacing: 1.5px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;
  }
  .section-header::before { content: '//'; color: #30363d; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
  thead th {
    text-align: left; padding: 10px 14px; font-size: 11px; text-transform: uppercase;
    letter-spacing: 1px; color: #484f58; border-bottom: 1px solid #21262d; background: #0d1117;
  }
  tbody td { padding: 10px 14px; border-bottom: 1px solid #21262d; font-size: 13px; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: rgba(88,166,255,0.04); }
  .cell-id { color: #58a6ff; font-weight: 600; }
  .cell-event { color: #8b949e; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell-error { color: #f85149; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty-row { color: #484f58; font-style: italic; text-align: center; }

  /* Badges */
  .badge {
    display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px;
    border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .badge-running { color: #58a6ff; background: rgba(88,166,255,0.15); }
  .badge-success { color: #3fb950; background: rgba(63,185,80,0.15); }
  .badge-warning { color: #d29922; background: rgba(210,153,34,0.15); }
  .badge-error { color: #f85149; background: rgba(248,81,73,0.15); }

  /* Token summary */
  .token-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px;
  }
  .token-item {
    background: #161b22; border: 1px solid #21262d; border-radius: 6px;
    padding: 12px; text-align: center;
  }
  .token-item .label { font-size: 10px; color: #484f58; text-transform: uppercase; letter-spacing: 1px; }
  .token-item .value { font-size: 18px; font-weight: 700; color: #c9d1d9; margin-top: 4px; }
  .token-item .value.cost { color: #3fb950; }

  /* Rate limit & polling */
  .info-bar {
    display: flex; flex-wrap: wrap; gap: 24px; padding: 12px 16px;
    background: #161b22; border: 1px solid #21262d; border-radius: 8px;
    font-size: 12px; color: #8b949e; margin-bottom: 16px;
  }
  .info-item { display: flex; align-items: center; gap: 6px; }
  .info-dot { width: 8px; height: 8px; border-radius: 50%; }
  .info-dot.ok { background: #3fb950; }
  .info-dot.warn { background: #d29922; }
  .info-dot.err { background: #f85149; }

  /* Footer */
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #21262d; font-size: 11px; color: #30363d; text-align: center; }

  /* SSE update flash */
  @keyframes flash { 0% { background: rgba(88,166,255,0.08); } 100% { background: transparent; } }
  .flash { animation: flash 0.6s ease-out; }
</style>
</head>
<body>

<!-- Hero -->
<header class="hero">
  <div>
    <div class="hero-title">hatice</div>
    <div class="hero-sub">autonomous agent orchestrator</div>
  </div>
  <span id="status-badge" class="status-badge status-live">live</span>
</header>

<!-- Stats -->
<div class="stats-grid" id="stats-grid">
  <div class="stat-card stat-running">
    <div class="stat-label">Running</div>
    <div class="stat-value" id="stat-running">${snapshot.running.length}</div>
  </div>
  <div class="stat-card stat-retrying">
    <div class="stat-label">Retrying</div>
    <div class="stat-value" id="stat-retrying">${snapshot.retrying.length}</div>
  </div>
  <div class="stat-card stat-completed">
    <div class="stat-label">Completed</div>
    <div class="stat-value" id="stat-completed">${snapshot.completed}</div>
  </div>
  <div class="stat-card stat-tokens">
    <div class="stat-label">Total Tokens</div>
    <div class="stat-value" id="stat-tokens">${fmt(totals.totalTokens)}</div>
  </div>
</div>

<!-- Rate limit & Polling info -->
<div class="info-bar" id="info-bar">
  <div class="info-item">
    <span class="info-dot ok" id="rate-limit-dot"></span>
    <span id="rate-limit-text">Rate limit: OK</span>
  </div>
  <div class="info-item">
    <span>Polling interval: <strong id="poll-interval">${(snapshot.polling.intervalMs / 1000).toFixed(0)}s</strong></span>
  </div>
  <div class="info-item">
    <span>Next poll: <strong id="poll-next">${(snapshot.polling.nextPollInMs / 1000).toFixed(1)}s</strong></span>
  </div>
  <div class="info-item">
    <span>Uptime: <strong id="uptime">${formatUptime(totals.secondsRunning)}</strong></span>
  </div>
</div>

<!-- Running Agents -->
<div class="section">
  <div class="section-header">Running Agents</div>
  <table>
    <thead><tr><th>Identifier</th><th>State</th><th>Session Age</th><th>Tokens Used</th><th>Last Event</th></tr></thead>
    <tbody id="running-tbody">${runningRows}</tbody>
  </table>
</div>

<!-- Retry Queue -->
<div class="section">
  <div class="section-header">Retry Queue</div>
  <table>
    <thead><tr><th>Identifier</th><th>Attempt #</th><th>Next Retry</th><th>Last Error</th></tr></thead>
    <tbody id="retry-tbody">${retryRows}</tbody>
  </table>
</div>

<!-- Token Usage Summary -->
<div class="section">
  <div class="section-header">Token Usage</div>
  <div class="token-grid" id="token-grid">
    <div class="token-item"><div class="label">Input</div><div class="value" id="tok-input">${fmt(totals.inputTokens)}</div></div>
    <div class="token-item"><div class="label">Output</div><div class="value" id="tok-output">${fmt(totals.outputTokens)}</div></div>
    <div class="token-item"><div class="label">Total</div><div class="value" id="tok-total">${fmt(totals.totalTokens)}</div></div>
    <div class="token-item"><div class="label">Cache Read</div><div class="value" id="tok-cache-read">${fmt(cacheRead)}</div></div>
    <div class="token-item"><div class="label">Cache Creation</div><div class="value" id="tok-cache-create">${fmt(cacheCreation)}</div></div>
    <div class="token-item"><div class="label">Cost USD</div><div class="value cost" id="tok-cost">$${costUsd.toFixed(4)}</div></div>
  </div>
</div>

<footer class="footer">hatice v0.1 &mdash; autonomous agent orchestrator</footer>

<script>
(function() {
  'use strict';

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function fmt(n) { return Number(n).toLocaleString(); }
  function formatUptime(s) {
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = Math.floor(s % 60);
    return (h > 0 ? h + 'h ' : '') + m + 'm ' + sec + 's';
  }
  function stateBadge(st) {
    var s = (st || '').toLowerCase();
    if (s === 'error' || s === 'failed') return 'error';
    if (s === 'waiting' || s === 'stalled') return 'warning';
    if (s === 'done' || s === 'completed') return 'success';
    return 'running';
  }
  function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

  function updateDashboard(snap) {
    // Stats
    var el;
    el = document.getElementById('stat-running'); if (el) { el.textContent = snap.running.length; flash(el.parentElement); }
    el = document.getElementById('stat-retrying'); if (el) { el.textContent = snap.retrying.length; flash(el.parentElement); }
    el = document.getElementById('stat-completed'); if (el) { el.textContent = snap.completed; flash(el.parentElement); }
    el = document.getElementById('stat-tokens'); if (el) { el.textContent = fmt(snap.totals.totalTokens); flash(el.parentElement); }

    // Polling
    el = document.getElementById('poll-interval'); if (el) el.textContent = (snap.polling.intervalMs / 1000).toFixed(0) + 's';
    el = document.getElementById('poll-next'); if (el) el.textContent = (snap.polling.nextPollInMs / 1000).toFixed(1) + 's';
    el = document.getElementById('uptime'); if (el) el.textContent = formatUptime(snap.totals.secondsRunning);

    // Token summary
    el = document.getElementById('tok-input'); if (el) el.textContent = fmt(snap.totals.inputTokens);
    el = document.getElementById('tok-output'); if (el) el.textContent = fmt(snap.totals.outputTokens);
    el = document.getElementById('tok-total'); if (el) el.textContent = fmt(snap.totals.totalTokens);

    var cacheRead = 0, cacheCreate = 0, costUsd = 0;
    snap.running.forEach(function(r) {
      cacheRead += (r.tokenUsage && r.tokenUsage.cacheReadInputTokens) || 0;
      cacheCreate += (r.tokenUsage && r.tokenUsage.cacheCreationInputTokens) || 0;
      costUsd += (r.tokenUsage && r.tokenUsage.costUsd) || 0;
    });
    el = document.getElementById('tok-cache-read'); if (el) el.textContent = fmt(cacheRead);
    el = document.getElementById('tok-cache-create'); if (el) el.textContent = fmt(cacheCreate);
    el = document.getElementById('tok-cost'); if (el) el.textContent = '$' + costUsd.toFixed(4);

    // Running table
    var tbody = document.getElementById('running-tbody');
    if (tbody) {
      if (snap.running.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No agents running</td></tr>';
      } else {
        tbody.innerHTML = snap.running.map(function(r) {
          return '<tr>' +
            '<td class="cell-id">' + esc(r.identifier) + '</td>' +
            '<td><span class="badge badge-' + stateBadge(r.state) + '">' + esc(r.state) + '</span></td>' +
            '<td>' + r.runtimeSeconds.toFixed(0) + 's</td>' +
            '<td>' + fmt(r.tokenUsage.totalTokens) + '</td>' +
            '<td class="cell-event">' + esc(r.lastEvent || '-') + '</td>' +
            '</tr>';
        }).join('');
      }
      flash(tbody);
    }

    // Retry table
    var rtbody = document.getElementById('retry-tbody');
    if (rtbody) {
      if (snap.retrying.length === 0) {
        rtbody.innerHTML = '<tr><td colspan="4" class="empty-row">No retries pending</td></tr>';
      } else {
        rtbody.innerHTML = snap.retrying.map(function(r) {
          return '<tr>' +
            '<td class="cell-id">' + esc(r.identifier) + '</td>' +
            '<td>' + r.attempt + '</td>' +
            '<td>' + (r.nextRetryInMs / 1000).toFixed(1) + 's</td>' +
            '<td class="cell-error">' + esc(r.lastError || '-') + '</td>' +
            '</tr>';
        }).join('');
      }
      flash(rtbody);
    }
  }

  // SSE integration
  if (typeof EventSource !== 'undefined') {
    var badge = document.getElementById('status-badge');
    var es = new EventSource('/api/v1/events');

    es.onopen = function() {
      if (badge) { badge.className = 'status-badge status-live'; badge.textContent = 'live'; }
    };

    es.onerror = function() {
      if (badge) { badge.className = 'status-badge status-offline'; badge.textContent = 'offline'; }
    };

    es.onmessage = function(e) {
      // Generic message handler — attempt JSON parse for state updates
      try {
        var data = JSON.parse(e.data);
        if (data && data.running !== undefined) { updateDashboard(data); }
      } catch(ex) { /* not a state payload, ignore */ }
    };

    es.addEventListener('state:updated', function() {
      fetch('/api/v1/state')
        .then(function(r) { return r.json(); })
        .then(updateDashboard)
        .catch(function() {
          if (badge) { badge.className = 'status-badge status-offline'; badge.textContent = 'offline'; }
        });
    });
  }
  // Fallback: noscript meta-refresh already handles no-JS case.
  // For JS-enabled browsers without EventSource, poll every 5s.
  else {
    setInterval(function() {
      fetch('/api/v1/state')
        .then(function(r) { return r.json(); })
        .then(updateDashboard)
        .catch(function() {});
    }, 5000);
  }
})();
</script>
</body>
</html>`;
}

/** Escape HTML entities to prevent XSS */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Format large numbers with locale separators */
function fmt(n: number): string {
  return n.toLocaleString();
}

/** Map agent state to CSS badge class suffix */
function stateBadge(state: string): string {
  const s = state.toLowerCase();
  if (s === 'error' || s === 'failed') return 'error';
  if (s === 'waiting' || s === 'stalled') return 'warning';
  if (s === 'done' || s === 'completed') return 'success';
  return 'running';
}

/** Format seconds into human-readable uptime */
function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (h > 0 ? `${h}h ` : '') + `${m}m ${s}s`;
}

/** Sum a specific tokenUsage field across all running entries */
function sumField(running: SnapshotRunningEntry[], field: 'cacheReadInputTokens' | 'cacheCreationInputTokens'): number {
  return running.reduce((sum, r) => sum + (r.tokenUsage[field] ?? 0), 0);
}

/** Compute total cost from running entries */
function computeCostFromRunning(running: SnapshotRunningEntry[]): number {
  return running.reduce((sum, r) => sum + (r.tokenUsage.costUsd ?? 0), 0);
}

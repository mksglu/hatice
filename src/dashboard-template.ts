import type { OrchestratorSnapshot, SnapshotRunningEntry, SnapshotRetryEntry } from './types.js';

/**
 * Renders a rich, SSE-powered HTML dashboard for hatice.
 * Inspired by Claude/Anthropic's warm, editorial design language.
 * Tailwind CSS via CDN + custom design tokens.
 */
export function renderLiveDashboard(snapshot: OrchestratorSnapshot): string {
  const runningRows = snapshot.running.length > 0
    ? snapshot.running.map((r: SnapshotRunningEntry) =>
        `<tr class="group border-b border-sand-200 last:border-0 transition-colors hover:bg-sand-50">
          <td class="py-3.5 px-4 font-semibold text-clay-900">${esc(r.identifier)}</td>
          <td class="py-3.5 px-4"><span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${stateBadgeClass(r.state)}">${esc(r.state)}</span></td>
          <td class="py-3.5 px-4 tabular-nums text-clay-600">${r.runtimeSeconds.toFixed(0)}s</td>
          <td class="py-3.5 px-4 tabular-nums text-clay-600">${fmt(r.tokenUsage.totalTokens)}</td>
          <td class="py-3.5 px-4 text-clay-400 max-w-[280px] truncate text-sm">${esc(r.lastEvent ?? '-')}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="5" class="py-8 text-center text-clay-400 italic text-sm">No agents running</td></tr>';

  const retryRows = snapshot.retrying.length > 0
    ? snapshot.retrying.map((r: SnapshotRetryEntry) =>
        `<tr class="group border-b border-sand-200 last:border-0 transition-colors hover:bg-sand-50">
          <td class="py-3.5 px-4 font-semibold text-clay-900">${esc(r.identifier)}</td>
          <td class="py-3.5 px-4 tabular-nums text-clay-600">${r.attempt}</td>
          <td class="py-3.5 px-4 tabular-nums text-clay-600">${(r.nextRetryInMs / 1000).toFixed(1)}s</td>
          <td class="py-3.5 px-4 text-rose-600 max-w-[360px] truncate text-sm">${esc(r.lastError ?? '-')}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="4" class="py-8 text-center text-clay-400 italic text-sm">No retries pending</td></tr>';

  const totals = snapshot.totals;
  const costUsd = computeCostFromRunning(snapshot.running);
  const cacheRead = sumField(snapshot.running, 'cacheReadInputTokens');
  const cacheCreation = sumField(snapshot.running, 'cacheCreationInputTokens');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hatice — dashboard</title>
<noscript><meta http-equiv="refresh" content="5"></noscript>
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        sand: {
          50: '#FAFAF7',
          100: '#F5F0E8',
          200: '#E8E0D0',
          300: '#D4C9B5',
          400: '#B8A88E',
          500: '#9C8B6E',
          600: '#7D6F56',
          700: '#5E5340',
          800: '#40392C',
          900: '#231F18',
        },
        clay: {
          50: '#F9F8F7',
          100: '#F0EDEA',
          200: '#DDD8D2',
          300: '#C4BCB2',
          400: '#A09689',
          500: '#7D7266',
          600: '#635A50',
          700: '#4A433B',
          800: '#332E28',
          900: '#1C1917',
        },
        ember: {
          50: '#FFF8F1',
          100: '#FFE8D1',
          200: '#FFCFA0',
          300: '#FFB06B',
          400: '#FF8C38',
          500: '#E07020',
          600: '#C05A10',
          700: '#9A4508',
          800: '#6F3206',
          900: '#442004',
        },
        sage: {
          50: '#F4F7F4',
          100: '#E0E8E0',
          200: '#B8CCB8',
          300: '#8BAF8B',
          400: '#5E8E5E',
          500: '#3D7A3D',
          600: '#2D5F2D',
          700: '#224822',
          800: '#183218',
          900: '#0F1F0F',
        },
      },
      fontFamily: {
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
        body: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      animation: {
        'breathe': 'breathe 3s ease-in-out infinite',
        'slide-up': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fadeIn 0.6s ease-out',
        'flash-row': 'flashRow 0.8s ease-out',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        flashRow: {
          '0%': { backgroundColor: 'rgba(224, 112, 32, 0.08)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
    },
  },
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  body { font-family: 'DM Sans', system-ui, sans-serif; }
  .tabular-nums { font-variant-numeric: tabular-nums; }
  .grain::before {
    content: '';
    position: fixed;
    inset: 0;
    opacity: 0.015;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 50;
  }
</style>
</head>
<body class="grain bg-sand-100 text-clay-800 min-h-screen antialiased">

<!-- Ambient background -->
<div class="fixed inset-0 pointer-events-none overflow-hidden -z-10">
  <div class="absolute -top-1/4 -right-1/4 w-[800px] h-[800px] rounded-full bg-gradient-to-br from-ember-100/40 via-sand-200/20 to-transparent blur-3xl"></div>
  <div class="absolute -bottom-1/4 -left-1/4 w-[600px] h-[600px] rounded-full bg-gradient-to-tr from-sage-100/30 via-sand-100/10 to-transparent blur-3xl"></div>
</div>

<div class="max-w-6xl mx-auto px-6 py-10">

  <!-- Header -->
  <header class="flex items-end justify-between mb-12 animate-fade-in">
    <div>
      <h1 class="font-display text-5xl text-clay-900 tracking-tight leading-none mb-2">hatice</h1>
      <p class="text-clay-400 text-sm tracking-wide">Autonomous agent orchestrator</p>
    </div>
    <div class="flex items-center gap-4">
      <span id="status-badge" class="inline-flex items-center gap-2 text-xs font-medium tracking-wider uppercase px-3.5 py-1.5 rounded-full bg-sage-50 text-sage-600 border border-sage-200">
        <span class="w-1.5 h-1.5 rounded-full bg-sage-500 animate-breathe"></span>
        live
      </span>
      <span class="text-xs text-clay-400 font-mono tabular-nums" id="uptime">${formatUptime(totals.secondsRunning)}</span>
    </div>
  </header>

  <!-- Stat cards -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10" id="stats-grid">
    <div class="group relative bg-white/70 backdrop-blur-sm border border-sand-200 rounded-2xl p-5 transition-all hover:border-sand-300 hover:shadow-sm animate-slide-up" style="animation-delay: 0ms">
      <div class="text-[11px] font-medium text-clay-400 uppercase tracking-widest mb-1">Running</div>
      <div class="text-3xl font-semibold text-clay-900 font-mono tabular-nums" id="stat-running">${snapshot.running.length}</div>
      <div class="absolute top-4 right-4 w-8 h-8 rounded-full bg-ember-50 flex items-center justify-center">
        <svg class="w-4 h-4 text-ember-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </div>
    </div>
    <div class="group relative bg-white/70 backdrop-blur-sm border border-sand-200 rounded-2xl p-5 transition-all hover:border-sand-300 hover:shadow-sm animate-slide-up" style="animation-delay: 60ms">
      <div class="text-[11px] font-medium text-clay-400 uppercase tracking-widest mb-1">Retrying</div>
      <div class="text-3xl font-semibold text-clay-900 font-mono tabular-nums" id="stat-retrying">${snapshot.retrying.length}</div>
      <div class="absolute top-4 right-4 w-8 h-8 rounded-full bg-amber-50 flex items-center justify-center">
        <svg class="w-4 h-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
      </div>
    </div>
    <div class="group relative bg-white/70 backdrop-blur-sm border border-sand-200 rounded-2xl p-5 transition-all hover:border-sand-300 hover:shadow-sm animate-slide-up" style="animation-delay: 120ms">
      <div class="text-[11px] font-medium text-clay-400 uppercase tracking-widest mb-1">Completed</div>
      <div class="text-3xl font-semibold text-clay-900 font-mono tabular-nums" id="stat-completed">${snapshot.completed}</div>
      <div class="absolute top-4 right-4 w-8 h-8 rounded-full bg-sage-50 flex items-center justify-center">
        <svg class="w-4 h-4 text-sage-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </div>
    </div>
    <div class="group relative bg-white/70 backdrop-blur-sm border border-sand-200 rounded-2xl p-5 transition-all hover:border-sand-300 hover:shadow-sm animate-slide-up" style="animation-delay: 180ms">
      <div class="text-[11px] font-medium text-clay-400 uppercase tracking-widest mb-1">Total Tokens</div>
      <div class="text-3xl font-semibold text-clay-900 font-mono tabular-nums" id="stat-tokens">${fmt(totals.totalTokens)}</div>
      <div class="absolute top-4 right-4 w-8 h-8 rounded-full bg-clay-50 flex items-center justify-center">
        <svg class="w-4 h-4 text-clay-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/></svg>
      </div>
    </div>
  </div>

  <!-- System info bar -->
  <div class="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 mb-8 bg-white/50 backdrop-blur-sm border border-sand-200 rounded-xl text-xs text-clay-500" id="info-bar">
    <div class="flex items-center gap-2">
      <span class="w-1.5 h-1.5 rounded-full bg-sage-500" id="rate-limit-dot"></span>
      <span id="rate-limit-text">Rate limit OK</span>
    </div>
    <div class="w-px h-3 bg-sand-300"></div>
    <div>Poll: <span class="font-mono font-medium text-clay-700" id="poll-interval">${(snapshot.polling.intervalMs / 1000).toFixed(0)}s</span></div>
    <div class="w-px h-3 bg-sand-300"></div>
    <div>Next: <span class="font-mono font-medium text-clay-700" id="poll-next">${(snapshot.polling.nextPollInMs / 1000).toFixed(1)}s</span></div>
  </div>

  <!-- Running agents -->
  <section class="mb-10 animate-slide-up" style="animation-delay: 250ms">
    <div class="flex items-center gap-3 mb-4">
      <h2 class="font-display text-2xl text-clay-900">Running Agents</h2>
      <span class="text-xs font-mono text-clay-400 bg-sand-200/60 px-2 py-0.5 rounded">${snapshot.running.length}</span>
    </div>
    <div class="bg-white/70 backdrop-blur-sm border border-sand-200 rounded-2xl overflow-hidden">
      <table class="w-full">
        <thead>
          <tr class="border-b border-sand-200 bg-sand-50/50">
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">Identifier</th>
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">State</th>
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">Age</th>
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">Tokens</th>
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">Last Event</th>
          </tr>
        </thead>
        <tbody id="running-tbody" class="font-mono text-sm">${runningRows}</tbody>
      </table>
    </div>
  </section>

  <!-- Retry queue -->
  <section class="mb-10 animate-slide-up" style="animation-delay: 350ms">
    <div class="flex items-center gap-3 mb-4">
      <h2 class="font-display text-2xl text-clay-900">Retry Queue</h2>
      <span class="text-xs font-mono text-clay-400 bg-sand-200/60 px-2 py-0.5 rounded">${snapshot.retrying.length}</span>
    </div>
    <div class="bg-white/70 backdrop-blur-sm border border-sand-200 rounded-2xl overflow-hidden">
      <table class="w-full">
        <thead>
          <tr class="border-b border-sand-200 bg-sand-50/50">
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">Identifier</th>
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">Attempt</th>
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">Next Retry</th>
            <th class="text-left py-3 px-4 text-[11px] font-semibold text-clay-400 uppercase tracking-widest">Last Error</th>
          </tr>
        </thead>
        <tbody id="retry-tbody" class="font-mono text-sm">${retryRows}</tbody>
      </table>
    </div>
  </section>

  <!-- Token usage grid -->
  <section class="mb-10 animate-slide-up" style="animation-delay: 450ms">
    <h2 class="font-display text-2xl text-clay-900 mb-4">Token Usage</h2>
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3" id="token-grid">
      <div class="bg-white/70 backdrop-blur-sm border border-sand-200 rounded-xl p-4 text-center transition-all hover:border-sand-300">
        <div class="text-[10px] font-medium text-clay-400 uppercase tracking-widest mb-1">Input</div>
        <div class="text-lg font-semibold text-clay-800 font-mono tabular-nums" id="tok-input">${fmt(totals.inputTokens)}</div>
      </div>
      <div class="bg-white/70 backdrop-blur-sm border border-sand-200 rounded-xl p-4 text-center transition-all hover:border-sand-300">
        <div class="text-[10px] font-medium text-clay-400 uppercase tracking-widest mb-1">Output</div>
        <div class="text-lg font-semibold text-clay-800 font-mono tabular-nums" id="tok-output">${fmt(totals.outputTokens)}</div>
      </div>
      <div class="bg-white/70 backdrop-blur-sm border border-sand-200 rounded-xl p-4 text-center transition-all hover:border-sand-300">
        <div class="text-[10px] font-medium text-clay-400 uppercase tracking-widest mb-1">Total</div>
        <div class="text-lg font-semibold text-clay-800 font-mono tabular-nums" id="tok-total">${fmt(totals.totalTokens)}</div>
      </div>
      <div class="bg-white/70 backdrop-blur-sm border border-sand-200 rounded-xl p-4 text-center transition-all hover:border-sand-300">
        <div class="text-[10px] font-medium text-clay-400 uppercase tracking-widest mb-1">Cache Read</div>
        <div class="text-lg font-semibold text-clay-800 font-mono tabular-nums" id="tok-cache-read">${fmt(cacheRead)}</div>
      </div>
      <div class="bg-white/70 backdrop-blur-sm border border-sand-200 rounded-xl p-4 text-center transition-all hover:border-sand-300">
        <div class="text-[10px] font-medium text-clay-400 uppercase tracking-widest mb-1">Cache Create</div>
        <div class="text-lg font-semibold text-clay-800 font-mono tabular-nums" id="tok-cache-create">${fmt(cacheCreation)}</div>
      </div>
      <div class="bg-white/70 backdrop-blur-sm border border-sand-200 rounded-xl p-4 text-center transition-all hover:border-sand-300">
        <div class="text-[10px] font-medium text-clay-400 uppercase tracking-widest mb-1">Cost</div>
        <div class="text-lg font-semibold text-sage-600 font-mono tabular-nums" id="tok-cost">$${costUsd.toFixed(4)}</div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="pt-8 border-t border-sand-200 text-center animate-fade-in" style="animation-delay: 550ms">
    <p class="text-xs text-clay-400">
      <span class="font-display italic text-clay-500">hatice</span>
      <span class="mx-2 text-sand-300">&middot;</span>
      autonomous agent orchestrator
      <span class="mx-2 text-sand-300">&middot;</span>
      powered by Claude Code Agent SDK
    </p>
  </footer>

</div>

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
  function stateBadgeClass(st) {
    var s = (st || '').toLowerCase();
    if (s === 'error' || s === 'failed') return 'bg-rose-50 text-rose-600 border border-rose-200';
    if (s === 'waiting' || s === 'stalled') return 'bg-amber-50 text-amber-600 border border-amber-200';
    if (s === 'done' || s === 'completed') return 'bg-sage-50 text-sage-600 border border-sage-200';
    return 'bg-ember-50 text-ember-600 border border-ember-200';
  }
  function flash(el) {
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'flashRow 0.8s ease-out';
  }

  function updateDashboard(snap) {
    var el;
    el = document.getElementById('stat-running'); if (el) { el.textContent = snap.running.length; flash(el.closest('.group')); }
    el = document.getElementById('stat-retrying'); if (el) { el.textContent = snap.retrying.length; flash(el.closest('.group')); }
    el = document.getElementById('stat-completed'); if (el) { el.textContent = snap.completed; flash(el.closest('.group')); }
    el = document.getElementById('stat-tokens'); if (el) { el.textContent = fmt(snap.totals.totalTokens); flash(el.closest('.group')); }

    el = document.getElementById('poll-interval'); if (el) el.textContent = (snap.polling.intervalMs / 1000).toFixed(0) + 's';
    el = document.getElementById('poll-next'); if (el) el.textContent = (snap.polling.nextPollInMs / 1000).toFixed(1) + 's';
    el = document.getElementById('uptime'); if (el) el.textContent = formatUptime(snap.totals.secondsRunning);

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

    var tbody = document.getElementById('running-tbody');
    if (tbody) {
      if (snap.running.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-clay-400 italic text-sm">No agents running</td></tr>';
      } else {
        tbody.innerHTML = snap.running.map(function(r) {
          return '<tr class="group border-b border-sand-200 last:border-0 transition-colors hover:bg-sand-50">' +
            '<td class="py-3.5 px-4 font-semibold text-clay-900">' + esc(r.identifier) + '</td>' +
            '<td class="py-3.5 px-4"><span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ' + stateBadgeClass(r.state) + '">' + esc(r.state) + '</span></td>' +
            '<td class="py-3.5 px-4 tabular-nums text-clay-600">' + r.runtimeSeconds.toFixed(0) + 's</td>' +
            '<td class="py-3.5 px-4 tabular-nums text-clay-600">' + fmt(r.tokenUsage.totalTokens) + '</td>' +
            '<td class="py-3.5 px-4 text-clay-400 max-w-[280px] truncate text-sm">' + esc(r.lastEvent || '-') + '</td>' +
            '</tr>';
        }).join('');
      }
      flash(tbody);
    }

    var rtbody = document.getElementById('retry-tbody');
    if (rtbody) {
      if (snap.retrying.length === 0) {
        rtbody.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-clay-400 italic text-sm">No retries pending</td></tr>';
      } else {
        rtbody.innerHTML = snap.retrying.map(function(r) {
          return '<tr class="group border-b border-sand-200 last:border-0 transition-colors hover:bg-sand-50">' +
            '<td class="py-3.5 px-4 font-semibold text-clay-900">' + esc(r.identifier) + '</td>' +
            '<td class="py-3.5 px-4 tabular-nums text-clay-600">' + r.attempt + '</td>' +
            '<td class="py-3.5 px-4 tabular-nums text-clay-600">' + (r.nextRetryInMs / 1000).toFixed(1) + 's</td>' +
            '<td class="py-3.5 px-4 text-rose-600 max-w-[360px] truncate text-sm">' + esc(r.lastError || '-') + '</td>' +
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
      if (badge) {
        badge.className = 'inline-flex items-center gap-2 text-xs font-medium tracking-wider uppercase px-3.5 py-1.5 rounded-full bg-sage-50 text-sage-600 border border-sage-200';
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-sage-500 animate-breathe"></span> live';
      }
    };

    es.onerror = function() {
      if (badge) {
        badge.className = 'inline-flex items-center gap-2 text-xs font-medium tracking-wider uppercase px-3.5 py-1.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200';
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> offline';
      }
    };

    es.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data && data.running !== undefined) { updateDashboard(data); }
      } catch(ex) {}
    };

    es.addEventListener('state:updated', function() {
      fetch('/api/v1/state')
        .then(function(r) { return r.json(); })
        .then(updateDashboard)
        .catch(function() {
          if (badge) {
            badge.className = 'inline-flex items-center gap-2 text-xs font-medium tracking-wider uppercase px-3.5 py-1.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200';
            badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> offline';
          }
        });
    });
  } else {
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

/** Map agent state to Tailwind badge classes */
export function stateBadgeClass(state: string): string {
  const s = state.toLowerCase();
  if (s === 'error' || s === 'failed') return 'bg-rose-50 text-rose-600 border border-rose-200';
  if (s === 'waiting' || s === 'stalled') return 'bg-amber-50 text-amber-600 border border-amber-200';
  if (s === 'done' || s === 'completed') return 'bg-emerald-50 text-emerald-600 border border-emerald-200';
  return 'bg-ember-50 text-ember-600 border border-ember-200';
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

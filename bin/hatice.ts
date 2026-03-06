#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'node:path';
import { WorkflowStore } from '../src/workflow-store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { HttpServer } from '../src/http-server.js';
import { StatusDashboard } from '../src/status-dashboard.js';
import { LinearAdapter } from '../src/linear/adapter.js';
import { GitHubAdapter } from '../src/github/adapter.js';
import { MemoryTracker } from '../src/tracker.js';
import { Supervisor } from '../src/supervisor.js';
import { StartupCleanup } from '../src/cleanup.js';
import { createLogger } from '../src/logger.js';
import type { Tracker, Issue } from '../src/types.js';

const logger = createLogger({ component: 'cli' });
const program = new Command();

program
  .name('hatice')
  .description('Autonomous issue orchestration system powered by Claude Code Agent SDK')
  .version('0.1.0');

program
  .command('start')
  .description('Start the orchestrator daemon')
  .requiredOption('-w, --workflow <path>', 'Path to WORKFLOW.md file')
  .option('-p, --port <number>', 'HTTP dashboard port', (v) => parseInt(v, 10))
  .option('--no-dashboard', 'Disable terminal dashboard')
  .action(async (options) => {
    const workflowPath = resolve(options.workflow);

    // Load and validate workflow
    const store = new WorkflowStore(workflowPath);
    const workflow = store.load();
    if (!workflow) {
      logger.fatal({ path: workflowPath }, 'Failed to load workflow file');
      process.exit(1);
    }

    const config = workflow.config;

    // Override port from CLI if provided
    const port = options.port ?? config.server.port;

    // Create tracker based on config
    let tracker: Tracker;
    switch (config.tracker.kind) {
      case 'linear':
        tracker = new LinearAdapter(config.tracker);
        break;
      case 'github':
        tracker = new GitHubAdapter(config.tracker);
        break;
      case 'memory': {
        const demoIssues: Issue[] = [
          {
            id: 'demo-1', identifier: 'DEMO-1', title: 'Fix login button not responding',
            description: 'The login button on the homepage does not trigger the authentication flow when clicked.',
            state: 'Todo', priority: 1, labels: ['bug', 'critical'], blockedBy: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            assignedToWorker: true, url: null, branchName: null, assigneeId: null,
          },
          {
            id: 'demo-2', identifier: 'DEMO-2', title: 'Add dark mode support',
            description: 'Implement a dark mode toggle in the settings page with system preference detection.',
            state: 'Todo', priority: 2, labels: ['feature'], blockedBy: [],
            createdAt: new Date(Date.now() - 3600_000).toISOString(), updatedAt: new Date().toISOString(),
            assignedToWorker: true, url: null, branchName: null, assigneeId: null,
          },
          {
            id: 'demo-3', identifier: 'DEMO-3', title: 'Refactor database queries',
            description: 'Optimize N+1 queries in the user dashboard endpoint.',
            state: 'In Progress', priority: 3, labels: ['performance'], blockedBy: [],
            createdAt: new Date(Date.now() - 7200_000).toISOString(), updatedAt: new Date().toISOString(),
            assignedToWorker: true, url: null, branchName: null, assigneeId: null,
          },
        ];
        tracker = new MemoryTracker(demoIssues);
        logger.info({ issues: demoIssues.length }, 'Demo mode: using in-memory tracker with sample issues');
        break;
      }
      default:
        logger.fatal({ kind: config.tracker.kind }, 'Unsupported tracker kind');
        process.exit(1);
    }

    // Run startup cleanup to remove stale workspace artifacts
    const workspaceRootDir = config.workspace.rootDir;
    try {
      logger.info({ workspaceRoot: workspaceRootDir }, 'Running startup cleanup...');
      const cleanup = new StartupCleanup({ workspaceRoot: workspaceRootDir, maxAgeMs: 24 * 60 * 60 * 1000 });
      const cleanupResult = await cleanup.run();
      logger.info({ ...cleanupResult }, 'Startup cleanup finished');
    } catch (err) {
      logger.warn({ err }, 'Startup cleanup failed, continuing anyway');
    }

    // Create orchestrator
    const orchestrator = new Orchestrator({
      tracker,
      workflowStore: store,
      config,
    });

    // Start HTTP server if port configured
    let httpServer: HttpServer | null = null;
    if (port) {
      httpServer = new HttpServer(orchestrator, port, config.server.host);
      await httpServer.start();
    }

    // Start terminal dashboard
    let dashboard: StatusDashboard | null = null;
    if (options.dashboard !== false) {
      dashboard = new StatusDashboard(() => orchestrator.getState().snapshot());
      dashboard.start();
    }

    // Wrap orchestrator in supervisor for crash recovery
    const supervisor = new Supervisor({
      maxRestarts: 5,
      restartWindowMs: 60_000,
      onCrash: (error, restartCount) => {
        logger.error({ error, restartCount }, 'Orchestrator crashed, restarting');
      },
    });

    supervisor.start(async () => orchestrator.start());

    logger.info({
      tracker: config.tracker.kind,
      project: config.tracker.projectSlug,
      maxAgents: config.agent.maxConcurrentAgents,
      ...(port && { dashboardUrl: `http://${config.server.host}:${port}` }),
    }, 'hatice started');

    // Monitor supervisor health — exit if max restarts exceeded
    const healthMonitor = setInterval(() => {
      if (!supervisor.isHealthy()) {
        clearInterval(healthMonitor);
        logger.fatal('Supervisor max restarts exceeded, exiting');
        process.exit(1);
      }
    }, 5_000);
    healthMonitor.unref();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down...');
      clearInterval(healthMonitor);
      supervisor.stop();
      orchestrator.stop();
      dashboard?.stop();
      if (httpServer) await httpServer.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });

program.parse();

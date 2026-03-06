import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkflowStore } from '../src/workflow-store.js';
import { ConfigError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validWorkflowContent(overrides: Record<string, string> = {}): string {
  const apiKey = overrides.apiKey ?? 'lin_api_test_key';
  return [
    '---',
    'tracker:',
    '  kind: linear',
    `  apiKey: "${apiKey}"`,
    '  projectSlug: "my-project"',
    'workspace:',
    '  rootDir: "/tmp/hatice-workspaces"',
    '---',
    '',
    'Fix this issue: {{ issue.title }}',
  ].join('\n');
}

function invalidWorkflowContent(): string {
  return ['---', 'tracker:', '  kind: linear', '---', '', 'Some prompt.'].join(
    '\n',
  );
}

function noFrontmatterContent(): string {
  return 'Just some text without frontmatter delimiters.';
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkflowStore', () => {
  let tempDir: string;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    tempDir = join(tmpdir(), `hatice-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  // 1. loads valid workflow file and returns config + template
  it('loads valid workflow file and returns config + template', () => {
    const filePath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(filePath, validWorkflowContent());

    const store = new WorkflowStore(filePath);
    const workflow = store.load();

    expect(workflow).not.toBeNull();
    expect(workflow!.config.tracker.kind).toBe('linear');
    expect(workflow!.config.tracker.apiKey).toBe('lin_api_test_key');
    expect(workflow!.config.tracker.projectSlug).toBe('my-project');
    expect(workflow!.config.workspace.rootDir).toBe(
      '/tmp/hatice-workspaces',
    );
    expect(workflow!.promptTemplate).toContain('Fix this issue');
  });

  // 2. validates config on load (rejects invalid)
  it('validates config on load and rejects invalid config', () => {
    const filePath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(filePath, invalidWorkflowContent());

    const store = new WorkflowStore(filePath);

    expect(() => store.load()).toThrow(ConfigError);
  });

  // 3. detects file changes via mtime and reloads
  it('detects file changes via mtime and reloads', () => {
    const filePath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(filePath, validWorkflowContent({ apiKey: 'key-v1' }));

    const store = new WorkflowStore(filePath);
    const first = store.load();
    expect(first!.config.tracker.apiKey).toBe('key-v1');

    // Write new content with a different mtime
    const future = new Date(Date.now() + 5000);
    writeFileSync(filePath, validWorkflowContent({ apiKey: 'key-v2' }));
    utimesSync(filePath, future, future);

    const second = store.load();
    expect(second!.config.tracker.apiKey).toBe('key-v2');
  });

  // 4. keeps last good config when reload produces invalid config
  it('keeps last good config when reload produces invalid config', () => {
    const filePath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(filePath, validWorkflowContent({ apiKey: 'good-key' }));

    const store = new WorkflowStore(filePath);
    const good = store.load();
    expect(good!.config.tracker.apiKey).toBe('good-key');

    // Overwrite with invalid content
    const future = new Date(Date.now() + 5000);
    writeFileSync(filePath, invalidWorkflowContent());
    utimesSync(filePath, future, future);

    // Should return the last good config, not throw
    const result = store.load();
    expect(result).not.toBeNull();
    expect(result!.config.tracker.apiKey).toBe('good-key');
  });

  // 5. returns null if file doesn't exist
  it('returns null if file does not exist', () => {
    const filePath = join(tempDir, 'nonexistent-WORKFLOW.md');

    const store = new WorkflowStore(filePath);
    const result = store.load();

    expect(result).toBeNull();
  });

  // 6. getCurrentWorkflow returns the latest loaded workflow
  it('getCurrentWorkflow returns the latest loaded workflow', () => {
    const filePath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(filePath, validWorkflowContent());

    const store = new WorkflowStore(filePath);

    // Before load, getCurrentWorkflow returns null
    expect(store.getCurrentWorkflow()).toBeNull();

    store.load();
    const current = store.getCurrentWorkflow();

    expect(current).not.toBeNull();
    expect(current!.config.tracker.kind).toBe('linear');
    expect(current!.promptTemplate).toContain('Fix this issue');
  });

  // 7. resolves env vars in config during load
  it('resolves env vars in config during load', () => {
    process.env.TEST_API_KEY = 'resolved-secret-key';

    const content = [
      '---',
      'tracker:',
      '  kind: linear',
      '  apiKey: "$TEST_API_KEY"',
      '  projectSlug: "my-project"',
      'workspace:',
      '  rootDir: "/tmp/hatice-workspaces"',
      '---',
      '',
      'Prompt template here.',
    ].join('\n');

    const filePath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(filePath, content);

    const store = new WorkflowStore(filePath);
    const workflow = store.load();

    expect(workflow).not.toBeNull();
    expect(workflow!.config.tracker.apiKey).toBe('resolved-secret-key');
  });

  // 8. handles file with no frontmatter gracefully (error)
  it('handles file with no frontmatter gracefully by throwing', () => {
    const filePath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(filePath, noFrontmatterContent());

    const store = new WorkflowStore(filePath);

    expect(() => store.load()).toThrow(ConfigError);
  });
});

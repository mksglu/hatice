import { describe, it, expect } from 'vitest';
import { PromptBuilder, issueToTemplateData } from '../src/prompt-builder.js';
import type { Issue } from '../src/types.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'MT-42',
    title: 'Fix the login bug',
    description: 'Users cannot log in when password contains special characters.',
    state: 'Todo',
    priority: 2,
    labels: ['bug', 'auth'],
    blockedBy: [],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-02T00:00:00Z',
    assignedToWorker: false,
    url: 'https://linear.app/team/MT-42',
    branchName: 'fix/mt-42-login-bug',
    assigneeId: 'user-1',
    ...overrides,
  };
}

describe('PromptBuilder', () => {
  const builder = new PromptBuilder();

  it('renders template with issue variables', async () => {
    const issue = makeIssue();
    const template =
      'Fix issue {{ issue.identifier }}: {{ issue.title }} [{{ issue.state }}]\n' +
      'Description: {{ issue.description }}\n' +
      'Priority: {{ issue.priority }}';

    const result = await builder.render(template, {
      issue: issueToTemplateData(issue),
      attempt: { number: 1, error: null },
    });

    expect(result).toBe(
      'Fix issue MT-42: Fix the login bug [Todo]\n' +
        'Description: Users cannot log in when password contains special characters.\n' +
        'Priority: 2',
    );
  });

  it('renders template with attempt variable', async () => {
    const issue = makeIssue();
    const template = 'Attempt #{{ attempt.number }}{% if attempt.error %} (previous error: {{ attempt.error }}){% endif %}';

    const resultFirst = await builder.render(template, {
      issue: issueToTemplateData(issue),
      attempt: { number: 1, error: null },
    });
    expect(resultFirst).toBe('Attempt #1');

    const resultRetry = await builder.render(template, {
      issue: issueToTemplateData(issue),
      attempt: { number: 2, error: 'Lint failed' },
    });
    expect(resultRetry).toBe('Attempt #2 (previous error: Lint failed)');
  });

  it('renders template with issue.labels array', async () => {
    const issue = makeIssue({ labels: ['bug', 'auth', 'critical'] });
    const template = 'Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}';

    const result = await builder.render(template, {
      issue: issueToTemplateData(issue),
      attempt: { number: 1, error: null },
    });

    expect(result).toBe('Labels: bug, auth, critical');
  });

  it('renders template with issue.blocked_by array', async () => {
    const issue = makeIssue({
      blockedBy: [
        { id: 'b-1', identifier: 'MT-10', state: 'In Progress' },
        { id: 'b-2', identifier: 'MT-11', state: 'Todo' },
      ],
    });
    const template =
      'Blocked by:{% for blocker in issue.blocked_by %}\n- {{ blocker.identifier }} ({{ blocker.state }}){% endfor %}';

    const result = await builder.render(template, {
      issue: issueToTemplateData(issue),
      attempt: { number: 1, error: null },
    });

    expect(result).toBe(
      'Blocked by:\n- MT-10 (In Progress)\n- MT-11 (Todo)',
    );
  });

  it('throws on undefined variable in strict mode', async () => {
    const issue = makeIssue();
    const template = 'Value: {{ nonexistent.field }}';

    await expect(
      builder.render(template, {
        issue: issueToTemplateData(issue),
        attempt: { number: 1, error: null },
      }),
    ).rejects.toThrow();
  });

  it('builds continuation prompt with turn number and guidance', () => {
    const prompt = builder.buildContinuationPrompt(3, 5);

    expect(prompt).toContain('continuation turn 3 of 5');
    expect(prompt).toContain('previous changes are preserved');
    expect(prompt).toContain('Continue working');
    expect(prompt).toContain('summarize what was done');
  });

  it('handles null description gracefully (renders empty string)', async () => {
    const issue = makeIssue({ description: null });
    const template = 'Description: [{{ issue.description }}]';

    const result = await builder.render(template, {
      issue: issueToTemplateData(issue),
      attempt: { number: 1, error: null },
    });

    expect(result).toBe('Description: []');
  });

  it('handles complex template with conditionals', async () => {
    const template =
      '{% if issue.priority %}Priority: P{{ issue.priority }}{% else %}No priority set{% endif %}';

    const withPriority = makeIssue({ priority: 1 });
    const resultWith = await builder.render(template, {
      issue: issueToTemplateData(withPriority),
      attempt: { number: 1, error: null },
    });
    expect(resultWith).toBe('Priority: P1');

    const noPriority = makeIssue({ priority: null });
    const resultWithout = await builder.render(template, {
      issue: issueToTemplateData(noPriority),
      attempt: { number: 1, error: null },
    });
    expect(resultWithout).toBe('No priority set');
  });

  describe('renderWithFallback', () => {
    it('returns rendered template on success', async () => {
      const issue = makeIssue();
      const template = 'Fix {{ issue.identifier }}: {{ issue.title }}';

      const result = await builder.renderWithFallback(
        template,
        { issue: issueToTemplateData(issue), attempt: { number: 1, error: null } },
        issue,
      );

      expect(result).toBe('Fix MT-42: Fix the login bug');
    });

    it('returns fallback on template error', async () => {
      const issue = makeIssue();
      const template = 'Value: {{ nonexistent.field }}'; // strict mode will throw

      const result = await builder.renderWithFallback(
        template,
        { issue: issueToTemplateData(issue), attempt: { number: 1, error: null } },
        issue,
      );

      expect(result).toContain('Fix the following issue:');
      expect(result).toContain('MT-42: Fix the login bug');
    });

    it('fallback includes issue identifier and title', async () => {
      const issue = makeIssue({ identifier: 'PROJ-99', title: 'A special bug' });
      const template = '{{ broken_var }}';

      const result = await builder.renderWithFallback(
        template,
        { issue: issueToTemplateData(issue), attempt: { number: 1, error: null } },
        issue,
      );

      expect(result).toContain('PROJ-99: A special bug');
      expect(result).toContain('Priority: 2');
    });

    it('handles null description gracefully', async () => {
      const issue = makeIssue({ description: null });
      const template = '{{ broken_var }}';

      const result = await builder.renderWithFallback(
        template,
        { issue: issueToTemplateData(issue), attempt: { number: 1, error: null } },
        issue,
      );

      expect(result).toContain('No description provided.');
      expect(result).not.toContain('null');
    });
  });
});

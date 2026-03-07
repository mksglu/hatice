import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitLabClient } from '../src/gitlab/client.js';
import { TrackerError } from '../src/errors.js';
import issuesFixture from './fixtures/gitlab-responses/issues.json';

function mockFetchResponse(body: unknown, status = 200, statusText = 'OK') {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('GitLabClient', () => {
  let client: GitLabClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new GitLabClient('https://gitlab.local', 'test-token', 'group/project', 'dev1');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('fetchIssues', () => {
    it('returns normalized issues from single page', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Open']);

      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe('101');
      expect(issues[0].title).toBe('Fix CI pipeline');
      expect(issues[1].id).toBe('102');
      expect(issues[1].title).toBe('Add feature X');
    });

    it('lowercases labels', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Open']);

      expect(issues[0].labels).toEqual(['bug', 'priority::high']);
      expect(issues[1].labels).toEqual(['enhancement']);
    });

    it('formats identifier as "project#iid"', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Open']);

      expect(issues[0].identifier).toBe('group/project#1');
      expect(issues[1].identifier).toBe('group/project#2');
    });

    it('determines assignedToWorker correctly', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Open']);

      expect(issues[0].assignedToWorker).toBe(true); // dev1 assigned
      expect(issues[1].assignedToWorker).toBe(false); // no assignees
    });

    it('normalizes state "opened" to "Open"', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Open']);

      expect(issues[0].state).toBe('Open');
    });

    it('sends correct API request with query params', async () => {
      globalThis.fetch = mockFetchResponse([]);

      await client.fetchIssues(['Open']);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/api/v4/projects/group%2Fproject/issues');
      expect(url).toContain('state=opened');
      expect(url).toContain('assignee_username=dev1');
      expect(options.headers['PRIVATE-TOKEN']).toBe('test-token');
    });

    it('maps "Closed" state to gitlab "closed"', async () => {
      globalThis.fetch = mockFetchResponse([]);

      await client.fetchIssues(['Closed']);

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('state=closed');
    });

    it('throws TrackerError on API failure', async () => {
      globalThis.fetch = mockFetchResponse({ message: 'Unauthorized' }, 401, 'Unauthorized');

      await expect(client.fetchIssues(['Open'])).rejects.toThrow(TrackerError);
    });

    it('handles pagination across multiple pages', async () => {
      const page1 = Array(100).fill(issuesFixture[0]);
      const page2 = [issuesFixture[1]];

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true, status: 200, statusText: 'OK',
          text: () => Promise.resolve(JSON.stringify(page1)),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200, statusText: 'OK',
          text: () => Promise.resolve(JSON.stringify(page2)),
        });

      const issues = await client.fetchIssues(['Open']);

      expect(issues).toHaveLength(101);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('fetchIssueStatesByIds', () => {
    it('returns empty array for empty ids', async () => {
      const issues = await client.fetchIssueStatesByIds([]);
      expect(issues).toEqual([]);
    });

    it('fetches individual issues by iid', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture[0]);

      const issues = await client.fetchIssueStatesByIds(['group/project#1']);

      expect(issues).toHaveLength(1);
      expect(issues[0].identifier).toBe('group/project#1');
    });
  });

  describe('createComment', () => {
    it('posts a note to the issue', async () => {
      globalThis.fetch = mockFetchResponse({});

      await client.createComment('group/project#1', 'Hello');

      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/projects/group%2Fproject/issues/1/notes');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ body: 'Hello' });
    });
  });

  describe('updateIssueState', () => {
    it('closes an issue', async () => {
      globalThis.fetch = mockFetchResponse({});

      await client.updateIssueState('group/project#1', 'Closed');

      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/projects/group%2Fproject/issues/1');
      expect(options.method).toBe('PUT');
      expect(JSON.parse(options.body)).toEqual({ state_event: 'close' });
    });

    it('reopens an issue', async () => {
      globalThis.fetch = mockFetchResponse({});

      await client.updateIssueState('group/project#1', 'Open');

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(options.body)).toEqual({ state_event: 'reopen' });
    });
  });
});

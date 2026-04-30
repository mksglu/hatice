import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubClient } from '../src/github/client.js';
import { TrackerError } from '../src/errors.js';
import issuesFixture from './fixtures/github-responses/issues.json';

// Helper to create a mock fetch response
function mockFetchResponse(body: unknown, status = 200, statusText = 'OK') {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('GitHubClient', () => {
  let client: GitHubClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new GitHubClient('test-token', 'org', 'repo', 'dev1');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('fetchIssues', () => {
    it('returns normalized issues from single page', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Todo', 'In Progress']);

      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe('org/repo#42');
      expect(issues[0].title).toBe('Fix CI pipeline');
      expect(issues[1].id).toBe('org/repo#43');
      expect(issues[1].title).toBe('Add feature X');
    });

    it('lowercases labels', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Todo']);

      expect(issues[0].labels).toEqual(['bug', 'priority: high']);
      expect(issues[1].labels).toEqual(['enhancement']);
    });

    it('extracts blockedBy from trackedInIssues', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Todo']);

      expect(issues[0].blockedBy).toEqual([]);
      expect(issues[1].blockedBy).toEqual([
        { id: 'I_kwDOA1', identifier: 'org/repo#42', state: 'OPEN' },
      ]);
    });

    it('formats identifier as "owner/repo#number"', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Todo']);

      expect(issues[0].identifier).toBe('org/repo#42');
      expect(issues[1].identifier).toBe('org/repo#43');
    });

    it('handles pagination', async () => {
      const page1 = {
        data: {
          repository: {
            issues: {
              nodes: [issuesFixture.data.repository.issues.nodes[0]],
              pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
            },
          },
        },
      };
      const page2 = {
        data: {
          repository: {
            issues: {
              nodes: [issuesFixture.data.repository.issues.nodes[1]],
              pageInfo: { hasNextPage: false, endCursor: 'cursor2' },
            },
          },
        },
      };

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(page1),
          text: () => Promise.resolve(JSON.stringify(page1)),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(page2),
          text: () => Promise.resolve(JSON.stringify(page2)),
        });

      const issues = await client.fetchIssues(['Todo']);

      expect(issues).toHaveLength(2);
      expect(issues[0].identifier).toBe('org/repo#42');
      expect(issues[1].identifier).toBe('org/repo#43');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('handles null body (description)', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Todo']);

      expect(issues[0].description).toBe('The CI pipeline is failing on main');
      expect(issues[1].description).toBeNull();
    });

    it('throws TrackerError on HTTP error', async () => {
      globalThis.fetch = mockFetchResponse({}, 403, 'Forbidden');

      await expect(client.fetchIssues(['Todo'])).rejects.toThrow(TrackerError);
      await expect(client.fetchIssues(['Todo'])).rejects.toThrow('GitHub API error: 403 Forbidden');
    });

    it('throws TrackerError on GraphQL errors', async () => {
      const errorResponse = {
        errors: [{ message: 'Field not found' }],
      };
      globalThis.fetch = mockFetchResponse(errorResponse);

      await expect(client.fetchIssues(['Todo'])).rejects.toThrow(TrackerError);
      await expect(client.fetchIssues(['Todo'])).rejects.toThrow(
        'GitHub GraphQL error: Field not found',
      );
    });
  });

  describe('fetchIssueStatesByIds', () => {
    it('returns issues with state info', async () => {
      const nodesResponse = {
        data: {
          nodes: issuesFixture.data.repository.issues.nodes,
        },
      };
      globalThis.fetch = mockFetchResponse(nodesResponse);

      const issues = await client.fetchIssueStatesByIds(['I_kwDOA1', 'I_kwDOA2']);

      expect(issues).toHaveLength(2);
      expect(issues[0].state).toBe('Todo');
      expect(issues[1].state).toBe('In Progress');
    });
  });

  describe('createComment', () => {
    it('sends correct REST API call', async () => {
      globalThis.fetch = mockFetchResponse({ id: 1 }, 201, 'Created');

      await client.createComment('org/repo#42', 'Test comment');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/issues/42/comments',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ body: 'Test comment' }),
        }),
      );
    });
  });

  describe('updateIssueState', () => {
    it('closes issue via REST', async () => {
      globalThis.fetch = mockFetchResponse({ id: 42 });

      await client.updateIssueState('org/repo#42', 'closed');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/issues/42',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ state: 'closed' }),
        }),
      );
    });

    it('reopens issue via REST', async () => {
      globalThis.fetch = mockFetchResponse({ id: 42 });

      await client.updateIssueState('org/repo#42', 'open');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/issues/42',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ state: 'open' }),
        }),
      );
    });
  });

  describe('end-to-end: id returned from fetchIssues works with REST helpers', () => {
    it('createComment hits the right REST URL when called with id from a fetched issue', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true, status: 200, statusText: 'OK',
          json: () => Promise.resolve(issuesFixture),
          text: () => Promise.resolve(JSON.stringify(issuesFixture)),
        })
        .mockResolvedValueOnce({
          ok: true, status: 201, statusText: 'Created',
          json: () => Promise.resolve({ id: 1 }),
          text: () => Promise.resolve(JSON.stringify({ id: 1 })),
        });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const issues = await client.fetchIssues(['Todo']);
      await client.createComment(issues[0].id, 'follow-up');

      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://api.github.com/repos/org/repo/issues/42/comments',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('priority extraction', () => {
    it('extracts priority from labels (Priority: High → 1, Priority: Medium → 2, etc.)', async () => {
      globalThis.fetch = mockFetchResponse(issuesFixture);

      const issues = await client.fetchIssues(['Todo']);

      // Issue 42 has "Priority: High" label → priority 1
      expect(issues[0].priority).toBe(1);
      // Issue 43 has no priority label → null
      expect(issues[1].priority).toBeNull();
    });
  });
});

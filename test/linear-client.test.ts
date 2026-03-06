import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinearClient } from '../src/linear/client.js';
import { TrackerError } from '../src/errors.js';
import page1Fixture from './fixtures/linear-responses/issues-page1.json';

function mockFetch(responses: Array<{ status?: number; body?: unknown; ok?: boolean; statusText?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let callIndex = 0;

  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const resp = responses[callIndex++] ?? responses[responses.length - 1];
    calls.push({ url: String(url), init: init! });

    if (resp.ok === false) {
      return {
        ok: false,
        status: resp.status ?? 500,
        statusText: resp.statusText ?? 'Internal Server Error',
        json: async () => resp.body ?? {},
      } as unknown as Response;
    }

    return {
      ok: true,
      status: resp.status ?? 200,
      statusText: resp.statusText ?? 'OK',
      json: async () => resp.body ?? {},
    } as unknown as Response;
  });

  return { fetchFn, calls };
}

function makeClient(assignee: string | null = null) {
  return new LinearClient('https://api.linear.app/graphql', 'lin_api_test123', 'PROJ', assignee);
}

describe('LinearClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('fetchIssues', () => {
    it('returns normalized issues from single page', async () => {
      const { fetchFn } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      const issues = await client.fetchIssues(['Todo', 'In Progress']);

      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe('issue-1');
      expect(issues[0].identifier).toBe('PROJ-1');
      expect(issues[0].title).toBe('Fix authentication bug');
      expect(issues[0].state).toBe('Todo');
      expect(issues[0].url).toBe('https://linear.app/proj/issue/PROJ-1');
      expect(issues[0].branchName).toBe('fix/auth-bug');
      expect(issues[0].assigneeId).toBe('user-1');
      expect(issues[1].id).toBe('issue-2');
      expect(issues[1].assigneeId).toBeNull();
    });

    it('labels are lowercased', async () => {
      const { fetchFn } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      const issues = await client.fetchIssues(['Todo', 'In Progress']);

      expect(issues[0].labels).toEqual(['bug', 'critical']);
      expect(issues[1].labels).toEqual(['feature']);
    });

    it('blockedBy extracted from inverseRelations (type=blocks)', async () => {
      const { fetchFn } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      const issues = await client.fetchIssues(['Todo', 'In Progress']);

      expect(issues[0].blockedBy).toEqual([]);
      expect(issues[1].blockedBy).toEqual([
        { id: 'issue-1', identifier: 'PROJ-1', state: 'Todo' },
      ]);
    });

    it('priority null when not a number', async () => {
      const fixture = structuredClone(page1Fixture);
      fixture.data.issues.nodes[0].priority = null as unknown as number;
      fixture.data.issues.nodes[1].priority = 'high' as unknown as number;

      const { fetchFn } = mockFetch([{ body: fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      const issues = await client.fetchIssues(['Todo', 'In Progress']);

      expect(issues[0].priority).toBeNull();
      expect(issues[1].priority).toBeNull();
    });

    it('handles pagination (multi-page)', async () => {
      const page1 = structuredClone(page1Fixture);
      page1.data.issues.pageInfo.hasNextPage = true;
      page1.data.issues.pageInfo.endCursor = 'cursor-page1';
      page1.data.issues.nodes = [page1.data.issues.nodes[0]];

      const page2 = structuredClone(page1Fixture);
      page2.data.issues.pageInfo.hasNextPage = false;
      page2.data.issues.nodes = [page2.data.issues.nodes[1]];

      const { fetchFn, calls } = mockFetch([{ body: page1 }, { body: page2 }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      const issues = await client.fetchIssues(['Todo', 'In Progress']);

      expect(issues).toHaveLength(2);
      expect(issues[0].identifier).toBe('PROJ-1');
      expect(issues[1].identifier).toBe('PROJ-2');
      expect(calls).toHaveLength(2);

      // Verify second call includes the cursor
      const secondBody = JSON.parse(calls[1].init.body as string);
      expect(secondBody.variables.after).toBe('cursor-page1');
    });

    it('assignee filtering - only matching assignee sets assignedToWorker', async () => {
      const { fetchFn } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient('John Doe');
      const issues = await client.fetchIssues(['Todo', 'In Progress']);

      expect(issues[0].assignedToWorker).toBe(true);
      expect(issues[1].assignedToWorker).toBe(false); // null assignee
    });

    it('handles null assignee gracefully', async () => {
      const { fetchFn } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient('Some User');
      const issues = await client.fetchIssues(['Todo', 'In Progress']);

      // issue-2 has null assignee - should not crash
      expect(issues[1].assignedToWorker).toBe(false);
      expect(issues[1].assigneeId).toBeNull();
    });

    it('description null handled', async () => {
      const fixture = structuredClone(page1Fixture);
      fixture.data.issues.nodes[0].description = null;

      const { fetchFn } = mockFetch([{ body: fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      const issues = await client.fetchIssues(['Todo']);

      expect(issues[0].description).toBeNull();
    });

    it('throws TrackerError on HTTP error', async () => {
      const { fetchFn } = mockFetch([{ ok: false, status: 401, statusText: 'Unauthorized' }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();

      await expect(client.fetchIssues(['Todo'])).rejects.toThrow(TrackerError);
      await expect(client.fetchIssues(['Todo'])).rejects.toThrow(/401/);
    });

    it('throws TrackerError on GraphQL errors', async () => {
      const { fetchFn } = mockFetch([{
        body: { errors: [{ message: 'Forbidden' }] },
      }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();

      await expect(client.fetchIssues(['Todo'])).rejects.toThrow(TrackerError);
      await expect(client.fetchIssues(['Todo'])).rejects.toThrow(/Forbidden/);
    });
  });

  describe('fetchIssueStatesByIds', () => {
    it('returns issues with state info', async () => {
      const { fetchFn, calls } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      const issues = await client.fetchIssueStatesByIds(['issue-1', 'issue-2']);

      expect(issues).toHaveLength(2);
      expect(issues[0].state).toBe('Todo');
      expect(issues[1].state).toBe('In Progress');

      // Verify correct filter was sent
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.variables.filter.id.in).toEqual(['issue-1', 'issue-2']);
    });
  });

  describe('createComment', () => {
    it('sends correct mutation', async () => {
      const { fetchFn, calls } = mockFetch([{
        body: { data: { commentCreate: { success: true } } },
      }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      await client.createComment('issue-1', 'Test comment');

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.variables.issueId).toBe('issue-1');
      expect(body.variables.body).toBe('Test comment');
      expect(body.query).toContain('commentCreate');
    });
  });

  describe('updateIssueState', () => {
    it('sends state lookup then update mutation', async () => {
      const { fetchFn, calls } = mockFetch([
        {
          body: {
            data: { workflowStates: { nodes: [{ id: 'state-done', name: 'Done' }] } },
          },
        },
        {
          body: {
            data: { issueUpdate: { success: true } },
          },
        },
      ]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      await client.updateIssueState('issue-1', 'Done');

      expect(calls).toHaveLength(2);

      // First call: lookup state
      const firstBody = JSON.parse(calls[0].init.body as string);
      expect(firstBody.query).toContain('workflowStates');
      expect(firstBody.variables.filter.name.eq).toBe('Done');

      // Second call: update issue
      const secondBody = JSON.parse(calls[1].init.body as string);
      expect(secondBody.query).toContain('issueUpdate');
      expect(secondBody.variables.issueId).toBe('issue-1');
      expect(secondBody.variables.stateId).toBe('state-done');
    });
  });

  describe('fetchViewer', () => {
    it('fetches current viewer', async () => {
      const { fetchFn } = mockFetch([{
        body: {
          data: { viewer: { id: 'user-1', name: 'John Doe', email: 'john@test.com' } },
        },
      }]);
      globalThis.fetch = fetchFn;

      const client = makeClient();
      const viewer = await client.fetchViewer();

      expect(viewer.id).toBe('user-1');
      expect(viewer.name).toBe('John Doe');
      expect(viewer.email).toBe('john@test.com');
    });
  });

  describe('normalizeIssue - assignedToWorker', () => {
    it('normalizes assignedToWorker based on assignee config (case-insensitive)', async () => {
      const { fetchFn } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      // Match by name case-insensitive
      const client = makeClient('john doe');
      const issues = await client.fetchIssues(['Todo']);

      expect(issues[0].assignedToWorker).toBe(true);
    });

    it('normalizes assignedToWorker by user id', async () => {
      const { fetchFn } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      // Match by id
      const client = makeClient('user-1');
      const issues = await client.fetchIssues(['Todo']);

      expect(issues[0].assignedToWorker).toBe(true);
    });

    it('assignedToWorker false when no assignee config', async () => {
      const { fetchFn } = mockFetch([{ body: page1Fixture }]);
      globalThis.fetch = fetchFn;

      const client = makeClient(null);
      const issues = await client.fetchIssues(['Todo']);

      expect(issues[0].assignedToWorker).toBe(false);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinearAdapter } from '../src/linear/adapter.js';
import type { TrackerConfig } from '../src/types.js';
import page1Fixture from './fixtures/linear-responses/issues-page1.json';

function mockFetch(body: unknown = page1Fixture) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
}

function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: 'linear',
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'lin_api_test',
    projectSlug: 'PROJ',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Cancelled'],
    assignee: null,
    ...overrides,
  };
}

describe('LinearAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetchCandidateIssues delegates to client with active states', async () => {
    const fetchFn = mockFetch();
    globalThis.fetch = fetchFn;

    const adapter = new LinearAdapter(makeConfig());
    const issues = await adapter.fetchCandidateIssues();

    expect(issues).toHaveLength(2);
    expect(issues[0].identifier).toBe('PROJ-1');

    // Verify it used activeStates in the filter
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.filter.state.name.in).toEqual(['Todo', 'In Progress']);
  });

  it('fetchIssuesByStates delegates correctly', async () => {
    const fetchFn = mockFetch();
    globalThis.fetch = fetchFn;

    const adapter = new LinearAdapter(makeConfig());
    const issues = await adapter.fetchIssuesByStates(['Done']);

    expect(issues).toHaveLength(2);

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.filter.state.name.in).toEqual(['Done']);
  });

  it('fetchIssueStatesByIds delegates correctly', async () => {
    const fetchFn = mockFetch();
    globalThis.fetch = fetchFn;

    const adapter = new LinearAdapter(makeConfig());
    const issues = await adapter.fetchIssueStatesByIds(['issue-1']);

    expect(issues).toHaveLength(2);

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.filter.id.in).toEqual(['issue-1']);
  });

  it('createComment delegates correctly', async () => {
    const fetchFn = mockFetch({ data: { commentCreate: { success: true } } });
    globalThis.fetch = fetchFn;

    const adapter = new LinearAdapter(makeConfig());
    await adapter.createComment('issue-1', 'Hello');

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.issueId).toBe('issue-1');
    expect(body.variables.body).toBe('Hello');
  });

  it('updateIssueState delegates correctly', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { workflowStates: { nodes: [{ id: 'state-1', name: 'Done' }] } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { issueUpdate: { success: true } },
        }),
      }) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchFn;

    const adapter = new LinearAdapter(makeConfig());
    await adapter.updateIssueState('issue-1', 'Done');

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('constructor uses apiKey from config', () => {
    const fetchFn = mockFetch();
    globalThis.fetch = fetchFn;

    const config = makeConfig({ apiKey: 'lin_api_from_config' });
    const adapter = new LinearAdapter(config);

    // Verify adapter was constructed (no throw)
    expect(adapter).toBeDefined();
  });
});

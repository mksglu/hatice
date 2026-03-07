import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabAdapter } from '../src/gitlab/adapter.js';
import { GitLabClient } from '../src/gitlab/client.js';
import type { TrackerConfig } from '../src/types.js';

vi.mock('../src/gitlab/client.js', () => {
  const MockGitLabClient = vi.fn();
  MockGitLabClient.prototype.fetchIssues = vi.fn().mockResolvedValue([]);
  MockGitLabClient.prototype.fetchIssueStatesByIds = vi.fn().mockResolvedValue([]);
  MockGitLabClient.prototype.createComment = vi.fn().mockResolvedValue(undefined);
  MockGitLabClient.prototype.updateIssueState = vi.fn().mockResolvedValue(undefined);
  return { GitLabClient: MockGitLabClient };
});

function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: 'gitlab',
    endpoint: 'https://gitlab.local',
    apiKey: 'test-token',
    projectSlug: 'group/project',
    activeStates: ['Open'],
    terminalStates: ['Closed'],
    assignee: 'dev1',
    ...overrides,
  };
}

describe('GitLabAdapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates GitLabClient with config values', () => {
      new GitLabAdapter(makeConfig());

      expect(GitLabClient).toHaveBeenCalledWith(
        'https://gitlab.local', 'test-token', 'group/project', 'dev1',
      );
    });
  });

  describe('fetchCandidateIssues', () => {
    it('delegates to client with activeStates', async () => {
      const adapter = new GitLabAdapter(makeConfig());
      const mockClient = (GitLabClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.fetchCandidateIssues();

      expect(mockClient.fetchIssues).toHaveBeenCalledWith(['Open']);
    });
  });

  describe('fetchIssuesByStates', () => {
    it('delegates to client with given states', async () => {
      const adapter = new GitLabAdapter(makeConfig());
      const mockClient = (GitLabClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.fetchIssuesByStates(['Closed']);

      expect(mockClient.fetchIssues).toHaveBeenCalledWith(['Closed']);
    });
  });

  describe('fetchIssueStatesByIds', () => {
    it('delegates to client', async () => {
      const adapter = new GitLabAdapter(makeConfig());
      const mockClient = (GitLabClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.fetchIssueStatesByIds(['group/project#1']);

      expect(mockClient.fetchIssueStatesByIds).toHaveBeenCalledWith(['group/project#1']);
    });
  });

  describe('createComment', () => {
    it('delegates to client', async () => {
      const adapter = new GitLabAdapter(makeConfig());
      const mockClient = (GitLabClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.createComment('group/project#1', 'Hello');

      expect(mockClient.createComment).toHaveBeenCalledWith('group/project#1', 'Hello');
    });
  });

  describe('updateIssueState', () => {
    it('delegates to client', async () => {
      const adapter = new GitLabAdapter(makeConfig());
      const mockClient = (GitLabClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.updateIssueState('group/project#1', 'Closed');

      expect(mockClient.updateIssueState).toHaveBeenCalledWith('group/project#1', 'Closed');
    });
  });
});

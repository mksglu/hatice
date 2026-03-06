import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubAdapter } from '../src/github/adapter.js';
import { GitHubClient } from '../src/github/client.js';
import { ConfigError } from '../src/errors.js';
import type { TrackerConfig, Issue } from '../src/types.js';

// Mock the GitHubClient module
vi.mock('../src/github/client.js', () => {
  const MockGitHubClient = vi.fn();
  MockGitHubClient.prototype.fetchIssues = vi.fn().mockResolvedValue([]);
  MockGitHubClient.prototype.fetchIssueStatesByIds = vi.fn().mockResolvedValue([]);
  MockGitHubClient.prototype.createComment = vi.fn().mockResolvedValue(undefined);
  MockGitHubClient.prototype.updateIssueState = vi.fn().mockResolvedValue(undefined);
  return { GitHubClient: MockGitHubClient };
});

function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: 'github',
    endpoint: 'https://api.github.com/graphql',
    apiKey: 'test-token',
    projectSlug: 'myorg/myrepo',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done'],
    assignee: 'dev1',
    ...overrides,
  };
}

describe('GitHubAdapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('parses projectSlug as "owner/repo"', () => {
      const adapter = new GitHubAdapter(makeConfig());

      expect(GitHubClient).toHaveBeenCalledWith('test-token', 'myorg', 'myrepo', 'dev1');
    });

    it('throws ConfigError for invalid projectSlug format', () => {
      expect(() => new GitHubAdapter(makeConfig({ projectSlug: 'invalid' }))).toThrow(ConfigError);
      expect(() => new GitHubAdapter(makeConfig({ projectSlug: 'invalid' }))).toThrow(
        'GitHub projectSlug must be in "owner/repo" format',
      );
    });

    it('throws ConfigError for projectSlug with too many segments', () => {
      expect(() => new GitHubAdapter(makeConfig({ projectSlug: 'a/b/c' }))).toThrow(ConfigError);
    });
  });

  describe('fetchCandidateIssues', () => {
    it('delegates to client with activeStates', async () => {
      const adapter = new GitHubAdapter(makeConfig());
      const mockClient = (GitHubClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.fetchCandidateIssues();

      expect(mockClient.fetchIssues).toHaveBeenCalledWith(['Todo', 'In Progress']);
    });
  });

  describe('fetchIssuesByStates', () => {
    it('delegates to client with provided states', async () => {
      const adapter = new GitHubAdapter(makeConfig());
      const mockClient = (GitHubClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.fetchIssuesByStates(['Done', 'Cancelled']);

      expect(mockClient.fetchIssues).toHaveBeenCalledWith(['Done', 'Cancelled']);
    });
  });

  describe('fetchIssueStatesByIds', () => {
    it('delegates to client with provided ids', async () => {
      const adapter = new GitHubAdapter(makeConfig());
      const mockClient = (GitHubClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.fetchIssueStatesByIds(['I_1', 'I_2']);

      expect(mockClient.fetchIssueStatesByIds).toHaveBeenCalledWith(['I_1', 'I_2']);
    });
  });

  describe('createComment', () => {
    it('delegates to client correctly', async () => {
      const adapter = new GitHubAdapter(makeConfig());
      const mockClient = (GitHubClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.createComment('org/repo#42', 'Hello');

      expect(mockClient.createComment).toHaveBeenCalledWith('org/repo#42', 'Hello');
    });
  });

  describe('updateIssueState', () => {
    it('delegates to client correctly', async () => {
      const adapter = new GitHubAdapter(makeConfig());
      const mockClient = (GitHubClient as unknown as ReturnType<typeof vi.fn>).mock.instances[0];

      await adapter.updateIssueState('org/repo#42', 'closed');

      expect(mockClient.updateIssueState).toHaveBeenCalledWith('org/repo#42', 'closed');
    });
  });
});

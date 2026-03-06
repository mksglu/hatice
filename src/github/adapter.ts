import type { Tracker, Issue, TrackerConfig } from '../types.js';
import { GitHubClient } from './client.js';
import { ConfigError } from '../errors.js';

export class GitHubAdapter implements Tracker {
  private client: GitHubClient;
  private activeStates: string[];

  constructor(config: TrackerConfig) {
    // projectSlug format: "owner/repo"
    const parts = config.projectSlug.split('/');
    if (parts.length !== 2) {
      throw new ConfigError('GitHub projectSlug must be in "owner/repo" format');
    }
    const [owner, repo] = parts;
    this.client = new GitHubClient(config.apiKey, owner, repo, config.assignee);
    this.activeStates = config.activeStates;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.client.fetchIssues(this.activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.client.fetchIssues(states);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    return this.client.fetchIssueStatesByIds(ids);
  }

  async createComment(issueId: string, body: string): Promise<void> {
    return this.client.createComment(issueId, body);
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    return this.client.updateIssueState(issueId, stateName);
  }
}

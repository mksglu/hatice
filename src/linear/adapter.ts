import type { Tracker, Issue, TrackerConfig } from '../types.js';
import { LinearClient } from './client.js';

export class LinearAdapter implements Tracker {
  private client: LinearClient;
  private activeStates: string[];
  private resolvedAssignee = false;

  constructor(config: TrackerConfig) {
    this.client = new LinearClient(config.endpoint, config.apiKey, config.projectSlug, config.assignee);
    this.activeStates = config.activeStates;
  }

  /** Resolve "me" assignee to actual viewer ID on first call */
  private async ensureAssigneeResolved(): Promise<void> {
    if (this.resolvedAssignee) return;
    this.resolvedAssignee = true;

    // Access the client's assignee — if it's "me", resolve via viewer query
    const currentAssignee = (this.client as any).assignee as string | null;
    if (currentAssignee?.toLowerCase() === 'me') {
      const viewer = await this.client.fetchViewer();
      (this.client as any).assignee = viewer.id;
    }
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    await this.ensureAssigneeResolved();
    return this.client.fetchIssues(this.activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    await this.ensureAssigneeResolved();
    return this.client.fetchIssues(states);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    await this.ensureAssigneeResolved();
    return this.client.fetchIssueStatesByIds(ids);
  }

  async createComment(issueId: string, body: string): Promise<void> {
    return this.client.createComment(issueId, body);
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    return this.client.updateIssueState(issueId, stateName);
  }
}

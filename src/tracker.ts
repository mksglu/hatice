import type { Issue, Tracker } from './types.js';

export type { Tracker };

export interface TrackerComment {
  issueId: string;
  body: string;
  createdAt: Date;
}

/**
 * In-memory Tracker implementation for testing.
 * Stores issues in a Map and comments in an array.
 */
export class MemoryTracker implements Tracker {
  private issues: Map<string, Issue>;
  private comments: TrackerComment[] = [];

  constructor(initialIssues: Issue[] = []) {
    this.issues = new Map(initialIssues.map((i) => [i.id, i]));
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return [...this.issues.values()];
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const stateSet = new Set(states);
    return [...this.issues.values()].filter((i) => stateSet.has(i.state));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const idSet = new Set(ids);
    return [...this.issues.values()].filter((i) => idSet.has(i.id));
  }

  async createComment(issueId: string, body: string): Promise<void> {
    this.comments.push({ issueId, body, createdAt: new Date() });
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.state = stateName;
    }
  }

  // --- Test helpers ---

  addIssue(issue: Issue): void {
    this.issues.set(issue.id, issue);
  }

  removeIssue(issueId: string): boolean {
    return this.issues.delete(issueId);
  }

  getComments(): TrackerComment[] {
    return [...this.comments];
  }
}

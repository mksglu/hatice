import type { Issue, BlockerRef } from '../types.js';
import { TrackerError } from '../errors.js';

interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string; // "opened" | "closed"
  web_url: string;
  created_at: string;
  updated_at: string;
  labels: string[];
  assignees: Array<{ id: number; username: string }>;
  references: { full: string };
  severity: string;
  issue_type: string;
}

const PAGE_SIZE = 100;

const SEVERITY_MAP: Record<string, number> = {
  'critical': 0,
  'high': 1,
  'medium': 2,
  'low': 3,
};

const PRIORITY_MAP: Record<string, number> = {
  'priority::urgent': 0,
  'priority::high': 1,
  'priority::medium': 2,
  'priority::low': 3,
};

export class GitLabClient {
  private apiToken: string;
  private baseUrl: string;
  private projectPath: string;
  private assignee: string | null;

  constructor(endpoint: string, apiToken: string, projectPath: string, assignee: string | null) {
    this.baseUrl = endpoint.replace(/\/+$/, '');
    this.apiToken = apiToken;
    this.projectPath = projectPath;
    this.assignee = assignee;
  }

  private encodedProject(): string {
    return encodeURIComponent(this.projectPath);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v4${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.apiToken,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new TrackerError(
        `GitLab API error: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    const text = await response.text();
    return text ? JSON.parse(text) as T : undefined as T;
  }

  private normalizeIssue(issue: GitLabIssue): Issue {
    const identifier = `${this.projectPath}#${issue.iid}`;

    const state = issue.state === 'opened' ? 'Open' : 'Closed';

    const labels = issue.labels.map((l) => l.toLowerCase());

    let priority: number | null = null;

    for (const label of labels) {
      if (label in PRIORITY_MAP) {
        priority = PRIORITY_MAP[label];
        break;
      }
    }

    if (priority === null) {
      const sev = issue.severity?.toLowerCase();
      if (sev && sev !== 'unknown' && sev in SEVERITY_MAP) {
        priority = SEVERITY_MAP[sev];
      }
    }

    const blockedBy: BlockerRef[] = [];

    const assignedToWorker = this.assignee !== null
      ? issue.assignees.some((a) => a.username === this.assignee)
      : false;

    const assigneeId = issue.assignees.length > 0
      ? String(issue.assignees[0].id)
      : null;

    return {
      id: identifier,
      identifier,
      title: issue.title,
      description: issue.description,
      state,
      priority,
      labels,
      blockedBy,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      assignedToWorker,
      url: issue.web_url,
      branchName: null,
      assigneeId,
    };
  }

  async fetchIssues(states: string[]): Promise<Issue[]> {
    const glState = this.mapStatesToGitLab(states);
    const allIssues: Issue[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        state: glState,
        per_page: String(PAGE_SIZE),
        page: String(page),
        order_by: 'created_at',
        sort: 'asc',
      });

      if (this.assignee) {
        params.set('assignee_username', this.assignee);
      }

      const issues = await this.request<GitLabIssue[]>(
        'GET',
        `/projects/${this.encodedProject()}/issues?${params.toString()}`,
      );

      allIssues.push(...issues.map((i) => this.normalizeIssue(i)));

      hasMore = issues.length === PAGE_SIZE;
      page++;
    }

    return allIssues;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];

    const results: Issue[] = [];
    for (const id of ids) {
      const iid = this.extractIssueIid(id);
      const issue = await this.request<GitLabIssue>(
        'GET',
        `/projects/${this.encodedProject()}/issues/${iid}`,
      );
      results.push(this.normalizeIssue(issue));
    }

    return results;
  }

  async createComment(issueId: string, body: string): Promise<void> {
    const iid = this.extractIssueIid(issueId);
    await this.request('POST', `/projects/${this.encodedProject()}/issues/${iid}/notes`, {
      body,
    });
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const iid = this.extractIssueIid(issueId);
    const lower = stateName.toLowerCase();
    const stateEvent = (lower === 'closed' || lower === 'done') ? 'close' : 'reopen';
    await this.request('PUT', `/projects/${this.encodedProject()}/issues/${iid}`, {
      state_event: stateEvent,
    });
  }

  private extractIssueIid(issueId: string): string {
    const hashIdx = issueId.indexOf('#');
    if (hashIdx !== -1) {
      return issueId.slice(hashIdx + 1);
    }
    return issueId;
  }

  private mapStatesToGitLab(states: string[]): string {
    for (const s of states) {
      const lower = s.toLowerCase();
      if (lower === 'closed' || lower === 'done' || lower === 'cancelled') {
        return 'closed';
      }
    }
    return 'opened';
  }
}

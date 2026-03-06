import type { Issue, BlockerRef } from '../types.js';
import { TrackerError } from '../errors.js';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface GitHubIssueNode {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  assignees: { nodes: Array<{ login: string; id: string }> };
  labels: { nodes: Array<{ name: string }> };
  projectItems: {
    nodes: Array<{
      fieldValueByName: { name: string } | null;
    }>;
  };
  trackedInIssues: {
    nodes: Array<{
      id: string;
      number: number;
      state: string;
    }>;
  };
}

interface FetchIssuesData {
  repository: {
    issues: {
      nodes: GitHubIssueNode[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
}

interface FetchIssuesByIdsData {
  nodes: Array<GitHubIssueNode | null>;
}

const ISSUES_QUERY = `
  query($owner: String!, $repo: String!, $states: [IssueState!]!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(states: $states, first: $first, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes {
          id
          number
          title
          body
          state
          url
          createdAt
          updatedAt
          assignees(first: 10) { nodes { login id } }
          labels(first: 20) { nodes { name } }
          projectItems(first: 5) {
            nodes {
              fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            }
          }
          trackedInIssues(first: 10) { nodes { id number state } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ISSUES_BY_IDS_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Issue {
        id
        number
        title
        body
        state
        url
        createdAt
        updatedAt
        assignees(first: 10) { nodes { login id } }
        labels(first: 20) { nodes { name } }
        projectItems(first: 5) {
          nodes {
            fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          }
        }
        trackedInIssues(first: 10) { nodes { id number state } }
      }
    }
  }
`;

const PAGE_SIZE = 50;

const PRIORITY_MAP: Record<string, number> = {
  'priority: urgent': 0,
  'priority: high': 1,
  'priority: medium': 2,
  'priority: low': 3,
};

export class GitHubClient {
  private apiToken: string;
  private owner: string;
  private repo: string;
  private assignee: string | null;

  constructor(apiToken: string, owner: string, repo: string, assignee: string | null) {
    this.apiToken = apiToken;
    this.owner = owner;
    this.repo = repo;
    this.assignee = assignee;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new TrackerError(
        `GitHub API error: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    if (json.errors && json.errors.length > 0) {
      throw new TrackerError(
        `GitHub GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`,
      );
    }

    return json.data as T;
  }

  private async rest(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new TrackerError(
        `GitHub REST API error: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  private normalizeIssue(node: GitHubIssueNode): Issue {
    const identifier = `${this.owner}/${this.repo}#${node.number}`;

    // Derive state from project items (GitHub Projects V2 status) or fallback to issue state
    let state: string = node.state === 'OPEN' ? 'Open' : 'Closed';
    const projectItem = node.projectItems?.nodes?.[0];
    if (projectItem?.fieldValueByName?.name) {
      state = projectItem.fieldValueByName.name;
    }

    // Lowercase all labels
    const labels = node.labels.nodes.map((l) => l.name.toLowerCase());

    // Extract priority from labels
    let priority: number | null = null;
    for (const label of labels) {
      if (label in PRIORITY_MAP) {
        priority = PRIORITY_MAP[label];
        break;
      }
    }

    // Extract blockers from trackedInIssues
    const blockedBy: BlockerRef[] = node.trackedInIssues.nodes.map((ref) => ({
      id: ref.id,
      identifier: `${this.owner}/${this.repo}#${ref.number}`,
      state: ref.state,
    }));

    // Determine if assigned to configured worker
    const assignedToWorker = this.assignee !== null
      ? node.assignees.nodes.some((a) => a.login === this.assignee)
      : false;

    // First assignee id, if any
    const assigneeId = node.assignees.nodes.length > 0
      ? node.assignees.nodes[0].id
      : null;

    return {
      id: node.id,
      identifier,
      title: node.title,
      description: node.body,
      state,
      priority,
      labels,
      blockedBy,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      assignedToWorker,
      url: node.url,
      branchName: null,
      assigneeId,
    };
  }

  async fetchIssues(states: string[], after?: string): Promise<Issue[]> {
    // Map human-readable states to GitHub GraphQL IssueState enum values
    const ghStates = this.mapStatesToGitHub(states);

    const allIssues: Issue[] = [];
    let cursor: string | undefined = after;
    let hasNextPage = true;

    while (hasNextPage) {
      const data = await this.graphql<FetchIssuesData>(ISSUES_QUERY, {
        owner: this.owner,
        repo: this.repo,
        states: ghStates,
        first: PAGE_SIZE,
        after: cursor ?? null,
      });

      const connection = data.repository.issues;
      const issues = connection.nodes.map((node) => this.normalizeIssue(node));
      allIssues.push(...issues);

      hasNextPage = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor ?? undefined;
    }

    return allIssues;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];

    const data = await this.graphql<FetchIssuesByIdsData>(ISSUES_BY_IDS_QUERY, {
      ids,
    });

    return data.nodes
      .filter((node): node is GitHubIssueNode => node !== null)
      .map((node) => this.normalizeIssue(node));
  }

  async createComment(issueId: string, body: string): Promise<void> {
    // issueId for REST is the issue number; extract from the identifier or use directly
    // We need the issue number. For REST API we use the number.
    // The issueId passed here should be the GraphQL node ID, but REST needs number.
    // We'll accept the issue number as a string.
    const issueNumber = this.extractIssueNumber(issueId);
    await this.rest('POST', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      body,
    });
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const issueNumber = this.extractIssueNumber(issueId);
    const state = stateName.toLowerCase() === 'closed' ? 'closed' : 'open';
    await this.rest('PATCH', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`, {
      state,
    });
  }

  private extractIssueNumber(issueId: string): string {
    // If it contains '#', extract the number part (e.g., "owner/repo#42" → "42")
    const hashIdx = issueId.indexOf('#');
    if (hashIdx !== -1) {
      return issueId.slice(hashIdx + 1);
    }
    // Otherwise assume it's already a number string
    return issueId;
  }

  private mapStatesToGitHub(states: string[]): string[] {
    const ghStates = new Set<string>();
    for (const s of states) {
      const lower = s.toLowerCase();
      if (lower === 'closed' || lower === 'done' || lower === 'cancelled') {
        ghStates.add('CLOSED');
      } else {
        ghStates.add('OPEN');
      }
    }
    return [...ghStates];
  }
}

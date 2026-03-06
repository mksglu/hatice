import type { Issue, BlockerRef } from '../types.js';
import { TrackerError } from '../errors.js';

const ISSUE_PAGE_SIZE = 50;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
  priority: unknown;
  branchName: string | null;
  url: string | null;
  assignee: { id: string; name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  inverseRelations: {
    nodes: Array<{
      type: string;
      issue: { id: string; identifier: string; state: { name: string } };
    }>;
  };
  createdAt: string;
  updatedAt: string;
}

interface IssuesQueryResult {
  issues: {
    nodes: LinearIssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface ViewerResult {
  viewer: { id: string; name: string; email: string };
}

interface WorkflowStatesResult {
  workflowStates: {
    nodes: Array<{ id: string; name: string }>;
  };
}

const ISSUES_QUERY = `
  query Issues($filter: IssueFilter, $first: Int, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        state { name }
        priority
        branchName
        url
        assignee { id name }
        labels { nodes { name } }
        inverseRelations { nodes { type issue { id identifier state { name } } } }
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_BY_IDS_QUERY = `
  query IssuesByIds($filter: IssueFilter) {
    issues(filter: $filter) {
      nodes {
        id
        identifier
        title
        description
        state { name }
        priority
        branchName
        url
        assignee { id name }
        labels { nodes { name } }
        inverseRelations { nodes { type issue { id identifier state { name } } } }
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
    }
  }
`;

const WORKFLOW_STATES_QUERY = `
  query WorkflowStates($filter: WorkflowStateFilter) {
    workflowStates(filter: $filter) {
      nodes { id name }
    }
  }
`;

const UPDATE_ISSUE_MUTATION = `
  mutation UpdateIssue($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
    }
  }
`;

const VIEWER_QUERY = `
  query Viewer {
    viewer { id name email }
  }
`;

export class LinearClient {
  private endpoint: string;
  private apiKey: string;
  private projectSlug: string;
  private assignee: string | null;

  constructor(endpoint: string, apiKey: string, projectSlug: string, assignee: string | null) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.projectSlug = projectSlug;
    this.assignee = assignee;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new TrackerError(
          `Linear API HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      }

      const json = (await response.json()) as GraphQLResponse<T>;

      if (json.errors && json.errors.length > 0) {
        const messages = json.errors.map((e) => e.message).join('; ');
        throw new TrackerError(`Linear GraphQL errors: ${messages}`);
      }

      if (!json.data) {
        throw new TrackerError('Linear API returned no data');
      }

      return json.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchIssues(states: string[], after?: string): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let cursor: string | undefined = after;

    do {
      const variables: Record<string, unknown> = {
        filter: {
          team: { key: { eq: this.projectSlug } },
          state: { name: { in: states } },
        },
        first: ISSUE_PAGE_SIZE,
      };

      if (cursor) {
        variables.after = cursor;
      }

      const data = await this.graphql<IssuesQueryResult>(ISSUES_QUERY, variables);
      const normalized = data.issues.nodes.map((node) => this.normalizeIssue(node));
      allIssues.push(...normalized);

      if (data.issues.pageInfo.hasNextPage && data.issues.pageInfo.endCursor) {
        cursor = data.issues.pageInfo.endCursor;
      } else {
        cursor = undefined;
      }
    } while (cursor);

    return allIssues;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const variables = {
      filter: { id: { in: ids } },
    };

    const data = await this.graphql<IssuesQueryResult>(ISSUES_BY_IDS_QUERY, variables);
    return data.issues.nodes.map((node) => this.normalizeIssue(node));
  }

  async createComment(issueId: string, body: string): Promise<void> {
    await this.graphql(CREATE_COMMENT_MUTATION, { issueId, body });
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const statesData = await this.graphql<WorkflowStatesResult>(WORKFLOW_STATES_QUERY, {
      filter: { name: { eq: stateName } },
    });

    const stateNode = statesData.workflowStates.nodes[0];
    if (!stateNode) {
      throw new TrackerError(`Workflow state "${stateName}" not found`);
    }

    await this.graphql(UPDATE_ISSUE_MUTATION, { issueId, stateId: stateNode.id });
  }

  async fetchViewer(): Promise<{ id: string; name: string; email: string }> {
    const data = await this.graphql<ViewerResult>(VIEWER_QUERY);
    return data.viewer;
  }

  private normalizeIssue(node: LinearIssueNode): Issue {
    const labels = node.labels.nodes.map((l) => l.name.toLowerCase());

    const blockedBy: BlockerRef[] = node.inverseRelations.nodes
      .filter((r) => r.type === 'blocks')
      .map((r) => ({
        id: r.issue.id,
        identifier: r.issue.identifier,
        state: r.issue.state.name,
      }));

    const priority = typeof node.priority === 'number' ? node.priority : null;

    let assignedToWorker = false;
    if (this.assignee && node.assignee) {
      assignedToWorker =
        node.assignee.name.toLowerCase() === this.assignee.toLowerCase() ||
        node.assignee.id === this.assignee;
    }

    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description,
      state: node.state.name,
      priority,
      labels,
      blockedBy,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      assignedToWorker,
      url: node.url,
      branchName: node.branchName,
      assigneeId: node.assignee?.id ?? null,
    };
  }
}

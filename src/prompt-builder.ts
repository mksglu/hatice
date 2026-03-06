import { Liquid } from 'liquidjs';
import { createLogger } from './logger.js';
import type { Issue } from './types.js';

export class PromptBuilder {
  private engine: Liquid;
  private log = createLogger({ component: 'prompt-builder' });

  constructor() {
    this.engine = new Liquid({
      strictVariables: true,
      strictFilters: true,
    });
  }

  async render(template: string, variables: PromptVariables): Promise<string> {
    return this.engine.parseAndRender(template, variables);
  }

  async renderWithFallback(
    template: string,
    data: PromptVariables,
    issue: Issue,
  ): Promise<string> {
    try {
      return await this.render(template, data);
    } catch (error) {
      this.log.warn(
        { err: error, issueId: issue.identifier },
        'Liquid template rendering failed, using fallback prompt',
      );
      return [
        'Fix the following issue:',
        '',
        `**${issue.identifier}: ${issue.title}**`,
        '',
        issue.description ?? 'No description provided.',
        '',
        `Priority: ${issue.priority ?? 'unset'}`,
      ].join('\n');
    }
  }

  buildContinuationPrompt(turnNumber: number, maxTurns: number): string {
    return [
      `This is continuation turn ${turnNumber} of ${maxTurns}.`,
      '',
      'Your workspace and all previous changes are preserved.',
      'Continue working on the issue from where you left off.',
      'If you have completed the task, summarize what was done.',
    ].join('\n');
  }
}

export interface PromptVariables {
  issue: IssueTemplateData;
  attempt: AttemptData;
}

export interface IssueTemplateData {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  priority: number | null;
  labels: string[];
  blocked_by: Array<{ id: string; identifier: string; state: string }>;
  created_at: string;
  updated_at: string;
  url: string;
  branch_name: string;
  assignee_id: string;
}

export interface AttemptData {
  number: number;
  error: string | null;
}

/** Convert Issue to template data (snake_case for Liquid templates). */
export function issueToTemplateData(issue: Issue): IssueTemplateData {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    state: issue.state,
    priority: issue.priority,
    labels: issue.labels,
    blocked_by: issue.blockedBy.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: issue.url ?? '',
    branch_name: issue.branchName ?? '',
    assignee_id: issue.assigneeId ?? '',
  };
}

---
tracker:
  kind: github
  apiKey: $GITHUB_TOKEN
  projectSlug: "your-org/your-repo"
  activeStates: ["open"]
  terminalStates: ["closed"]
  assignee: "me"
workspace:
  rootDir: /tmp/hatice-workspaces
hooks:
  afterCreate: "git clone https://github.com/your-org/your-repo.git . && npm install"
polling:
  intervalMs: 30000
agent:
  maxConcurrentAgents: 3
  maxTurns: 0
claude:
  permissionMode: bypassPermissions
  model: claude-sonnet-4-20250514
server:
  port: 4000
---
You are an expert software engineer working on the project.

Solve the following GitHub issue:

**{{ issue.identifier }}: {{ issue.title }}**

{{ issue.description }}

## Instructions
- Work in the provided workspace directory
- Write tests first (TDD), then implement
- Follow existing code patterns and conventions
- Run tests to verify your changes pass
- Commit your changes when done with a descriptive message

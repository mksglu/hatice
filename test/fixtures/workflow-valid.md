---
tracker:
  kind: linear
  apiKey: "$LINEAR_API_KEY"
  projectSlug: "my-project"
  activeStates:
    - Todo
    - In Progress
  terminalStates:
    - Done
    - Cancelled
polling:
  intervalMs: 30000
workspace:
  rootDir: "/tmp/hatice-workspaces"
hooks:
  afterCreate: "git clone $REPO_URL ."
  timeoutMs: 120000
agent:
  maxConcurrentAgents: 5
  maxTurns: 20
---

You are an autonomous coding agent. Fix the following issue:

Title: {{ issue.title }}
Identifier: {{ issue.identifier }}
Description: {{ issue.description }}

{% if issue.priority %}Priority: {{ issue.priority }}{% endif %}

---
tracker:
  kind: memory

workspace:
  rootDir: "/tmp/hatice-workspaces"

agent:
  maxConcurrentAgents: 2
  maxTurns: 5

server:
  port: 4000
---

You are an autonomous coding agent. Fix the following issue:

**{{ issue.identifier }}: {{ issue.title }}**

{{ issue.description }}

{% if issue.priority %}Priority: {{ issue.priority }}{% endif %}

Work in the current directory. Make the necessary code changes, run tests if available, and commit your work.

---
tracker:
  kind: memory
workspace:
  rootDir: /tmp/hatice-demo
agent:
  maxConcurrentAgents: 2
  maxTurns: 0
claude:
  permissionMode: bypassPermissions
server:
  port: 4000
---
You are an expert software engineer.

Solve the following issue:

**{{ issue.identifier }}: {{ issue.title }}**

{{ issue.description }}

## Instructions
- Work in the provided workspace directory
- Write clean, well-tested code
- Commit your changes when done with a descriptive message

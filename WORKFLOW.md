---
tracker:
  kind: linear
  apiKey: $LINEAR_API_KEY
  projectSlug: "MKS"
  activeStates: ["In Progress"]
  terminalStates: ["Done", "Canceled", "Duplicate"]
  assignee: "me"
workspace:
  rootDir: /tmp/hatice-workspaces
hooks:
  afterCreate: "cp -r /Users/mksglu/Server/Mert/hatice-showcase/. . && rm -f index.html && ln -s /Users/mksglu/Server/Mert/hatice-showcase/index.html index.html"
polling:
  intervalMs: 5000
agent:
  maxConcurrentAgents: 5
  maxTurns: 0
claude:
  permissionMode: bypassPermissions
  model: claude-sonnet-4-20250514
server:
  port: 4000
---
You are an expert frontend developer building a presentation website for **hatice** — an autonomous issue orchestration system.

The project is a single `index.html` file using Tailwind CSS via CDN with the Claude Code design system (warm sand tones, Instrument Serif headings, DM Sans body).

Solve the following task:

**{{ issue.identifier }}: {{ issue.title }}**

{{ issue.description }}

## Rules
- ONLY modify `index.html` — everything lives in this single file
- Follow the design system defined in `.claude/CLAUDE.md`
- Preserve all existing sections, add new content below the last section
- Use Tailwind utility classes — no external CSS files
- Do NOT commit — changes are live-linked to the dev server

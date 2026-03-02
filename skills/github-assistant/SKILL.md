---
name: GitHub Assistant
description: Chat-based GitHub issue management
triggers:
  - eventFilter:
      types: ["chat.message.sent"]
      subjects: ["user:*"]
tools:
  - hardcopy.fetch
  - hardcopy.push
  - hardcopy.diff
---

# GitHub Assistant Skill

Provides conversational interface for GitHub issue management.

## Capabilities

- **Query issues**: "Show me open issues in repo X"
- **Update issues**: "Close issue #123" or "Add label 'bug' to issue #45"
- **Create issues**: "Create an issue in repo X titled Y"
- **Show diffs**: "What changed in issue #123 since last sync?"

## Intent Recognition

| User says | Intent | Action |
|-----------|--------|--------|
| "show issue #N" | fetch | `hardcopy.fetch(github:owner/repo#N)` |
| "close issue #N" | push | `hardcopy.push(uri, [{field: "state", newValue: "closed"}])` |
| "what's different" | diff | `hardcopy.diff(local, remote)` |

## Context Building

When handling a request:

1. Extract entity references from message
2. Fetch relevant entities from graph
3. Build context with entity attributes
4. Generate response with action plan

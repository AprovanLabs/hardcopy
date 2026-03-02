---
name: GitHub Sync
description: Sync GitHub issues and PRs with local state
triggers:
  - eventFilter:
      types: ["sync.request"]
      subjects: ["github:*"]
tools:
  - hardcopy.fetch
  - hardcopy.push
  - hardcopy.diff
---

# GitHub Sync Skill

Handles bidirectional synchronization of GitHub issues and pull requests.

## Trigger

This skill activates when a sync request event arrives for a GitHub URI (e.g., `github:owner/repo/issues/123`).

## Process

1. Parse the URI to extract owner/repo/number
2. Fetch the current state from GitHub API
3. Convert to Entity format
4. Compare with local state using `hardcopy.diff`
5. Apply merge strategy to resolve conflicts
6. Push changes back to GitHub if needed

## URI Format

GitHub URIs follow the pattern:
- `github:{owner}/{repo}/issues/{number}` - Issues
- `github:{owner}/{repo}/pulls/{number}` - Pull Requests
- `github:{owner}/{repo}` - Repository metadata

## Example

```typescript
// Fetch a GitHub issue
const result = await hardcopy.fetch("github:octocat/hello-world/issues/42");

// Push changes back
await hardcopy.push("github:octocat/hello-world/issues/42", [
  { field: "title", oldValue: "Old Title", newValue: "New Title" }
]);
```

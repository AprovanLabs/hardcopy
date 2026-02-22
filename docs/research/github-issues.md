# GitHub Issues API Research

## Overview

This document covers the GitHub APIs for syncing issues and projects to local storage. The sync plugin needs to:
1. Pull/sync GitHub issues to local Markdown files
2. Sync local edits back to GitHub using CRDT conflict resolution
3. Load GitHub Projects views (Kanban, roadmap, priority boards)
4. Store metadata locally (YAML/JSON/Markdown)
5. Track sync state per issue and for project metadata

---

## REST API: Issues

### Base Configuration
- **API Version**: `2022-11-28` (specified via `X-GitHub-Api-Version` header)
- **Base URL**: `https://api.github.com`
- **Authentication**: Bearer token (PAT or OAuth token)
- **Rate Limits**: 
  - Authenticated: 5,000 requests/hour
  - Unauthenticated: 60 requests/hour
  - GitHub App installations: 5,000-15,000 requests/hour (scales with repos/users)

### Key Endpoints

#### List Issues for a Repository
```
GET /repos/{owner}/{repo}/issues
```

Query Parameters:
- `state`: `open`, `closed`, `all`
- `labels`: Comma-separated label names
- `sort`: `created`, `updated`, `comments`
- `direction`: `asc`, `desc`
- `since`: ISO 8601 timestamp (for incremental sync)
- `per_page`: 1-100 (default 30)
- `page`: Page number

#### Get a Single Issue
```
GET /repos/{owner}/{repo}/issues/{issue_number}
```

#### Create an Issue
```
POST /repos/{owner}/{repo}/issues
```

Request Body:
```json
{
  "title": "Issue title",
  "body": "Issue body in Markdown",
  "labels": ["bug", "priority-high"],
  "assignees": ["username"],
  "milestone": 1
}
```

#### Update an Issue
```
PATCH /repos/{owner}/{repo}/issues/{issue_number}
```

Request Body (any subset):
```json
{
  "title": "Updated title",
  "body": "Updated body",
  "state": "closed",
  "state_reason": "completed",
  "labels": ["bug"],
  "assignees": ["username"]
}
```

### Issue Object Schema

```typescript
interface GitHubIssue {
  id: number;                    // Unique ID across GitHub
  node_id: string;               // GraphQL node ID
  url: string;                   // API URL
  html_url: string;              // Web URL
  number: number;                // Issue number (per repo)
  state: 'open' | 'closed';
  state_reason: 'completed' | 'not_planned' | 'reopened' | null;
  title: string;
  body: string | null;           // Markdown content
  user: GitHubUser;
  labels: GitHubLabel[];
  assignees: GitHubUser[];
  milestone: GitHubMilestone | null;
  locked: boolean;
  comments: number;
  created_at: string;            // ISO 8601
  updated_at: string;            // ISO 8601
  closed_at: string | null;      // ISO 8601
  closed_by: GitHubUser | null;
  reactions: ReactionRollup;
}

interface GitHubLabel {
  id: number;
  node_id: string;
  name: string;
  description: string | null;
  color: string;                 // Hex without #
  default: boolean;
}

interface GitHubUser {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  html_url: string;
  type: 'User' | 'Organization' | 'Bot';
}

interface GitHubMilestone {
  id: number;
  node_id: string;
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  due_on: string | null;         // ISO 8601
}
```

### Rate Limit Headers

Every response includes:
```
x-ratelimit-limit: 5000
x-ratelimit-remaining: 4999
x-ratelimit-used: 1
x-ratelimit-reset: 1701234567
x-ratelimit-resource: core
```

### Conditional Requests (ETags)

Use ETags to avoid counting against rate limit for unchanged data:

```
GET /repos/{owner}/{repo}/issues
If-None-Match: "abc123"
```

Response: `304 Not Modified` if unchanged (no body, doesn't count against limit)

---

## GraphQL API: ProjectsV2

### Why GraphQL for Projects?

Projects (new) are only fully accessible via GraphQL. The REST API for classic projects is deprecated (April 2025).

### Key Types

```graphql
type ProjectV2 {
  id: ID!
  title: String!
  shortDescription: String
  public: Boolean!
  closed: Boolean!
  closedAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
  number: Int!
  url: URI!
  
  # Relationships
  fields(first: Int, after: String): ProjectV2FieldConfigurationConnection!
  items(first: Int, after: String): ProjectV2ItemConnection!
  views(first: Int, after: String): ProjectV2ViewConnection!
  owner: ProjectV2Owner!
}

type ProjectV2Item {
  id: ID!
  type: ProjectV2ItemType!        # ISSUE, PULL_REQUEST, DRAFT_ISSUE, REDACTED
  isArchived: Boolean!
  content: ProjectV2ItemContent   # Issue or PullRequest
  createdAt: DateTime!
  updatedAt: DateTime!
  
  # Field values
  fieldValues(first: Int): ProjectV2ItemFieldValueConnection!
}

type ProjectV2View {
  id: ID!
  name: String!
  number: Int!
  layout: ProjectV2ViewLayout!    # TABLE_LAYOUT, BOARD_LAYOUT, ROADMAP_LAYOUT
  
  # Filtering and grouping
  filter: String
  sortBy: [ProjectV2SortBy!]
  groupBy: [ProjectV2FieldConfiguration!]
  verticalGroupBy: [ProjectV2FieldConfiguration!]
  visibleFields(first: Int): ProjectV2FieldConfigurationConnection
}

union ProjectV2FieldConfiguration = 
  | ProjectV2Field 
  | ProjectV2IterationField 
  | ProjectV2SingleSelectField

type ProjectV2SingleSelectField {
  id: ID!
  name: String!
  dataType: ProjectV2FieldType!   # SINGLE_SELECT
  options: [ProjectV2SingleSelectFieldOption!]!
}

type ProjectV2SingleSelectFieldOption {
  id: String!
  name: String!
  nameHTML: String!
  color: ProjectV2SingleSelectFieldOptionColor!
  description: String
  descriptionHTML: String
}

type ProjectV2IterationField {
  id: ID!
  name: String!
  configuration: ProjectV2IterationFieldConfiguration!
}

type ProjectV2IterationFieldConfiguration {
  duration: Int!                   # Days
  startDay: Int!                   # 0=Monday
  iterations: [ProjectV2IterationFieldIteration!]!
  completedIterations: [ProjectV2IterationFieldIteration!]!
}
```

### Key Queries

#### Fetch Project with Views and Fields
```graphql
query GetProject($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      id
      title
      shortDescription
      public
      closed
      updatedAt
      
      # Get all field definitions
      fields(first: 50) {
        nodes {
          ... on ProjectV2Field {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options {
              id
              name
              color
              description
            }
          }
          ... on ProjectV2IterationField {
            id
            name
            configuration {
              duration
              startDay
              iterations {
                id
                title
                startDate
                duration
              }
            }
          }
        }
      }
      
      # Get all views (boards, roadmaps, tables)
      views(first: 20) {
        nodes {
          id
          name
          number
          layout
          filter
        }
      }
    }
  }
}
```

#### Fetch Project Items (Issues in Project)
```graphql
query GetProjectItems($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          type
          isArchived
          
          # Get the issue/PR content
          content {
            ... on Issue {
              id
              number
              title
              body
              state
              url
              labels(first: 20) {
                nodes { name color }
              }
              assignees(first: 10) {
                nodes { login }
              }
            }
            ... on PullRequest {
              id
              number
              title
              state
              url
            }
          }
          
          # Get custom field values
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2Field { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2Field { name } }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2Field { name } }
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                optionId
                field { ... on ProjectV2SingleSelectField { name } }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title
                iterationId
                field { ... on ProjectV2IterationField { name } }
              }
            }
          }
        }
      }
    }
  }
}
```

### Key Mutations

#### Update Item Field Value
```graphql
mutation UpdateItemField(
  $projectId: ID!,
  $itemId: ID!,
  $fieldId: ID!,
  $value: ProjectV2FieldValue!
) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: $value
  }) {
    projectV2Item {
      id
      updatedAt
    }
  }
}
```

#### Add Item to Project
```graphql
mutation AddItemToProject($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {
    projectId: $projectId
    contentId: $contentId
  }) {
    item {
      id
    }
  }
}
```

---

## Webhooks for Real-Time Sync

### Relevant Events

| Event | Actions | Description |
|-------|---------|-------------|
| `issues` | opened, edited, deleted, closed, reopened, assigned, unassigned, labeled, unlabeled, locked, unlocked, transferred, milestoned, demilestoned | Issue changes |
| `issue_comment` | created, edited, deleted | Comments on issues |
| `projects_v2` | created, edited, closed, reopened, deleted | Project changes |
| `projects_v2_item` | created, edited, archived, restored, deleted, reordered, converted | Project item changes |
| `label` | created, edited, deleted | Label definitions |
| `milestone` | created, closed, opened, edited, deleted | Milestone changes |

### Webhook Payload Structure

```typescript
interface IssuesWebhookPayload {
  action: string;
  issue: GitHubIssue;
  changes?: {
    title?: { from: string };
    body?: { from: string };
  };
  repository: GitHubRepository;
  sender: GitHubUser;
}

interface ProjectsV2ItemWebhookPayload {
  action: 'created' | 'edited' | 'archived' | 'restored' | 'deleted' | 'reordered' | 'converted';
  changes?: {
    field_value?: {
      field_node_id: string;
      field_type: string;
    };
  };
  projects_v2_item: {
    id: number;
    node_id: string;
    project_node_id: string;
    content_node_id: string;
    content_type: 'Issue' | 'PullRequest' | 'DraftIssue';
    creator: GitHubUser;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
  };
  sender: GitHubUser;
  organization: GitHubOrganization;
}
```

### Webhook Security

Verify webhooks using HMAC:
```typescript
import { createHmac } from 'crypto';

function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

---

## Repository Metadata

### Labels
```
GET /repos/{owner}/{repo}/labels
```

### Milestones
```
GET /repos/{owner}/{repo}/milestones
```

### Assignees (collaborators)
```
GET /repos/{owner}/{repo}/assignees
```

---

## Local File Format

### Issue File Structure
```
.github-sync/
├── issues/
│   ├── 001-first-issue.md
│   ├── 002-second-issue.md
│   └── ...
├── projects/
│   ├── project-1/
│   │   ├── metadata.yaml
│   │   ├── views/
│   │   │   ├── board.yaml
│   │   │   ├── roadmap.yaml
│   │   │   └── backlog.yaml
│   │   └── items.yaml
│   └── ...
├── metadata/
│   ├── labels.yaml
│   ├── milestones.yaml
│   └── assignees.yaml
└── sync-state.yaml
```

### Issue Markdown Format
```markdown
---
id: 12345
node_id: "I_kwDOABC123"
number: 42
url: "https://github.com/owner/repo/issues/42"
state: open
state_reason: null
labels:
  - bug
  - priority-high
assignees:
  - username
milestone: "v2.0"
created_at: "2024-01-15T10:30:00Z"
updated_at: "2024-01-20T14:45:00Z"
sync_version: "abc123def456"  # CRDT version for conflict resolution
---

# Issue Title

Issue body content in Markdown...
```

### Project View YAML Format
```yaml
# views/board.yaml
id: "PVT_kwDOABC123"
name: "Sprint Board"
layout: BOARD_LAYOUT
filter: "status:open"
group_by:
  field: "Status"
  options:
    - id: "opt_todo"
      name: "To Do"
      color: "GRAY"
    - id: "opt_in_progress"  
      name: "In Progress"
      color: "YELLOW"
    - id: "opt_done"
      name: "Done"
      color: "GREEN"
items:
  - issue_number: 42
    status: "In Progress"
    priority: "High"
    iteration: "Sprint 5"
  - issue_number: 43
    status: "To Do"
    priority: "Medium"
```

---

## Sync State Tracking

### Per-Issue Sync State
```yaml
# sync-state.yaml
issues:
  42:
    github_updated_at: "2024-01-20T14:45:00Z"
    local_updated_at: "2024-01-20T14:50:00Z"
    crdt_version: "base64-encoded-loro-version"
    sync_status: "synced" | "local_ahead" | "remote_ahead" | "conflict"
    last_sync: "2024-01-20T14:50:00Z"
    etag: "\"abc123\""
  
projects:
  "PVT_abc123":
    github_updated_at: "2024-01-20T14:45:00Z"
    local_updated_at: "2024-01-20T14:50:00Z"
    crdt_version: "base64-encoded-loro-version"
    sync_status: "synced"
    
metadata:
  labels_etag: "\"def456\""
  milestones_etag: "\"ghi789\""
  last_full_sync: "2024-01-20T14:50:00Z"
```

---

## Sync Algorithm

### Initial Sync (Pull)
1. Fetch all issues with `GET /repos/{owner}/{repo}/issues?state=all`
2. Fetch all projects via GraphQL
3. Store ETags and `updated_at` timestamps
4. Initialize CRDT documents for each issue
5. Write local files

### Incremental Sync (Pull)
1. Use `since` parameter: `GET /repos/{owner}/{repo}/issues?since={last_sync}`
2. Use ETags for conditional requests
3. Merge remote changes into CRDT documents
4. Update local files only if changed

### Push Sync
1. Detect local changes (file modification time vs CRDT version)
2. Generate CRDT diff
3. Apply changes via `PATCH /repos/{owner}/{repo}/issues/{issue_number}`
4. Or via GraphQL mutations for project fields
5. Update sync state

### Conflict Resolution
1. Both local and remote have changes since last sync
2. Merge using CRDT operations (automatic for text/lists)
3. For single-value fields: last-write-wins with user confirmation
4. Log conflicts for review

---

## Error Handling

### Rate Limiting
```typescript
async function fetchWithRateLimit(url: string): Promise<Response> {
  const response = await fetch(url);
  
  if (response.status === 403 || response.status === 429) {
    const resetTime = response.headers.get('x-ratelimit-reset');
    const waitMs = (parseInt(resetTime!) * 1000) - Date.now();
    await sleep(Math.max(waitMs, 60000));
    return fetchWithRateLimit(url);
  }
  
  return response;
}
```

### Pagination
```typescript
async function* fetchAllIssues(owner: string, repo: string) {
  let page = 1;
  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues?page=${page}&per_page=100`
    );
    const issues = await response.json();
    if (issues.length === 0) break;
    yield* issues;
    page++;
  }
}
```

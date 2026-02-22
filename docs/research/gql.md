# GQL Query Language Research

## Overview

This document covers using GQL (Graph Query Language) / openCypher syntax for querying synced data. The goal is to provide a declarative query interface for:
- Loading project views with filters
- Traversing issue relationships (linked issues, dependencies, cross-repo references)
- Building custom views and aggregations
- Expressing graph queries over local data

---

## GQL / openCypher Background

### What is GQL?

**GQL** (ISO/IEC 39075) is the upcoming international standard for property graph query languages. It's heavily influenced by:
- **openCypher**: Neo4j's declarative graph query language
- **PGQL**: Oracle's property graph query language
- **GSQL**: TigerGraph's query language

For practical purposes, we'll use openCypher syntax since it's:
1. Widely adopted and well-documented
2. The basis for GQL standard
3. Has existing TypeScript tooling

### Property Graph Model

Data is modeled as:
- **Nodes**: Entities with labels and properties
- **Edges**: Relationships between nodes with types and properties
- **Properties**: Key-value pairs on nodes and edges

```
        assignee          has_label
(User:alice) <--------- (Issue:42) ----------> (Label:bug)
                            |
                            | blocks
                            v
                       (Issue:43)
```

---

## Data Model for Synced Content

### Node Types

```typescript
// Issue node
interface IssueNode {
  _type: 'Issue';
  _id: string;            // e.g., "github:owner/repo#42"
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  created_at: string;
  updated_at: string;
  url: string;
  source: string;         // "github", "gitlab", "jira"
}

// User node
interface UserNode {
  _type: 'User';
  _id: string;            // e.g., "github:username"
  login: string;
  name: string | null;
  avatar_url: string;
  source: string;
}

// Label node  
interface LabelNode {
  _type: 'Label';
  _id: string;            // e.g., "github:owner/repo:bug"
  name: string;
  color: string;
  description: string | null;
}

// Milestone node
interface MilestoneNode {
  _type: 'Milestone';
  _id: string;
  title: string;
  description: string | null;
  due_on: string | null;
  state: 'open' | 'closed';
}

// Project node
interface ProjectNode {
  _type: 'Project';
  _id: string;            // e.g., "github:project:123"
  title: string;
  description: string | null;
  url: string;
}

// ProjectView node
interface ProjectViewNode {
  _type: 'ProjectView';
  _id: string;
  name: string;
  layout: 'TABLE' | 'BOARD' | 'ROADMAP';
  filter: string | null;
}

// FieldDefinition node
interface FieldDefinitionNode {
  _type: 'FieldDefinition';
  _id: string;
  name: string;
  data_type: 'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT' | 'ITERATION';
  options?: { id: string; name: string; color: string }[];
}
```

### Edge Types

```typescript
interface Edge {
  _type: string;
  _from: string;  // Node ID
  _to: string;    // Node ID
  properties?: Record<string, any>;
}

// Edge types:
// - CREATED_BY: Issue -> User
// - ASSIGNED_TO: Issue -> User
// - HAS_LABEL: Issue -> Label
// - HAS_MILESTONE: Issue -> Milestone
// - BELONGS_TO_PROJECT: Issue -> Project
// - BLOCKS: Issue -> Issue
// - BLOCKED_BY: Issue -> Issue
// - REFERENCES: Issue -> Issue
// - CHILD_OF: Issue -> Issue (sub-issues)
// - HAS_VIEW: Project -> ProjectView
// - HAS_FIELD: Project -> FieldDefinition
// - FIELD_VALUE: Issue -> FieldDefinition (with value property)
```

---

## Query Syntax

### Basic Pattern Matching

```cypher
// Find all open issues
MATCH (i:Issue {state: 'open'})
RETURN i.number, i.title

// Find issues assigned to a user
MATCH (i:Issue)-[:ASSIGNED_TO]->(u:User {login: 'alice'})
RETURN i.number, i.title

// Find issues with a specific label
MATCH (i:Issue)-[:HAS_LABEL]->(l:Label {name: 'bug'})
RETURN i.number, i.title, i.state
```

### Relationship Traversal

```cypher
// Find issues blocking other issues
MATCH (blocker:Issue)-[:BLOCKS]->(blocked:Issue)
RETURN blocker.number AS blocking, blocked.number AS blocked_by

// Find all issues in the dependency chain
MATCH path = (i:Issue {number: 42})-[:BLOCKS*1..5]->(blocked:Issue)
RETURN path

// Find issues with no blockers (ready to work)
MATCH (i:Issue {state: 'open'})
WHERE NOT (i)-[:BLOCKED_BY]->(:Issue {state: 'open'})
RETURN i.number, i.title
```

### Project Views

```cypher
// Get issues in a board view grouped by status
MATCH (i:Issue)-[:BELONGS_TO_PROJECT]->(p:Project {title: 'Sprint Board'})
MATCH (i)-[fv:FIELD_VALUE]->(f:FieldDefinition {name: 'Status'})
RETURN f.name AS field, fv.value AS status, collect(i) AS issues

// Get roadmap items with dates
MATCH (i:Issue)-[:BELONGS_TO_PROJECT]->(p:Project)
MATCH (i)-[iter:FIELD_VALUE]->(f:FieldDefinition {name: 'Iteration'})
RETURN i.number, i.title, iter.value AS iteration, iter.start_date, iter.end_date
ORDER BY iter.start_date
```

### Aggregations

```cypher
// Count issues by label
MATCH (i:Issue)-[:HAS_LABEL]->(l:Label)
RETURN l.name, count(i) AS issue_count
ORDER BY issue_count DESC

// Count issues by assignee
MATCH (i:Issue {state: 'open'})-[:ASSIGNED_TO]->(u:User)
RETURN u.login, count(i) AS assigned_count
ORDER BY assigned_count DESC

// Issues per milestone progress
MATCH (i:Issue)-[:HAS_MILESTONE]->(m:Milestone)
RETURN m.title, 
       count(CASE WHEN i.state = 'closed' THEN 1 END) AS closed,
       count(i) AS total,
       round(count(CASE WHEN i.state = 'closed' THEN 1 END) * 100.0 / count(i)) AS percent_complete
```

### Cross-Repository Queries

```cypher
// Find issues referencing other repos
MATCH (i:Issue)-[:REFERENCES]->(ref:Issue)
WHERE i.source_repo <> ref.source_repo
RETURN i.source_repo, i.number, ref.source_repo, ref.number

// Find shared assignees across repos
MATCH (i1:Issue)-[:ASSIGNED_TO]->(u:User)<-[:ASSIGNED_TO]-(i2:Issue)
WHERE i1.source_repo <> i2.source_repo
RETURN u.login, collect(DISTINCT i1.source_repo) AS repos
```

---

## Query Engine Implementation

### In-Memory Graph Store

```typescript
class GraphStore {
  private nodes = new Map<string, Node>();
  private edges: Edge[] = [];
  private nodesByType = new Map<string, Set<string>>();
  private edgeIndex = new Map<string, Edge[]>(); // from_id -> edges
  private reverseEdgeIndex = new Map<string, Edge[]>(); // to_id -> edges
  
  addNode(node: Node): void {
    this.nodes.set(node._id, node);
    
    if (!this.nodesByType.has(node._type)) {
      this.nodesByType.set(node._type, new Set());
    }
    this.nodesByType.get(node._type)!.add(node._id);
  }
  
  addEdge(edge: Edge): void {
    this.edges.push(edge);
    
    if (!this.edgeIndex.has(edge._from)) {
      this.edgeIndex.set(edge._from, []);
    }
    this.edgeIndex.get(edge._from)!.push(edge);
    
    if (!this.reverseEdgeIndex.has(edge._to)) {
      this.reverseEdgeIndex.set(edge._to, []);
    }
    this.reverseEdgeIndex.get(edge._to)!.push(edge);
  }
  
  getNode(id: string): Node | undefined {
    return this.nodes.get(id);
  }
  
  getNodesByType(type: string): Node[] {
    const ids = this.nodesByType.get(type) || new Set();
    return Array.from(ids).map(id => this.nodes.get(id)!);
  }
  
  getOutgoingEdges(nodeId: string, edgeType?: string): Edge[] {
    const edges = this.edgeIndex.get(nodeId) || [];
    if (edgeType) {
      return edges.filter(e => e._type === edgeType);
    }
    return edges;
  }
  
  getIncomingEdges(nodeId: string, edgeType?: string): Edge[] {
    const edges = this.reverseEdgeIndex.get(nodeId) || [];
    if (edgeType) {
      return edges.filter(e => e._type === edgeType);
    }
    return edges;
  }
}
```

### Simple Query Executor

```typescript
interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
}

class QueryExecutor {
  constructor(private store: GraphStore) {}
  
  // Simplified query execution for common patterns
  findIssues(filters: {
    state?: 'open' | 'closed' | 'all';
    labels?: string[];
    assignees?: string[];
    milestone?: string;
    project?: string;
    blocked_by?: boolean;
  }): IssueNode[] {
    let issues = this.store.getNodesByType('Issue') as IssueNode[];
    
    if (filters.state && filters.state !== 'all') {
      issues = issues.filter(i => i.state === filters.state);
    }
    
    if (filters.labels?.length) {
      issues = issues.filter(i => {
        const labelEdges = this.store.getOutgoingEdges(i._id, 'HAS_LABEL');
        const issueLabels = labelEdges.map(e => {
          const label = this.store.getNode(e._to) as LabelNode;
          return label?.name;
        });
        return filters.labels!.every(l => issueLabels.includes(l));
      });
    }
    
    if (filters.assignees?.length) {
      issues = issues.filter(i => {
        const assigneeEdges = this.store.getOutgoingEdges(i._id, 'ASSIGNED_TO');
        const assignees = assigneeEdges.map(e => {
          const user = this.store.getNode(e._to) as UserNode;
          return user?.login;
        });
        return filters.assignees!.some(a => assignees.includes(a));
      });
    }
    
    if (filters.blocked_by === false) {
      // Only issues with no open blockers
      issues = issues.filter(i => {
        const blockerEdges = this.store.getOutgoingEdges(i._id, 'BLOCKED_BY');
        const openBlockers = blockerEdges.filter(e => {
          const blocker = this.store.getNode(e._to) as IssueNode;
          return blocker?.state === 'open';
        });
        return openBlockers.length === 0;
      });
    }
    
    return issues;
  }
  
  // Get dependency graph for an issue
  getDependencyGraph(issueId: string, maxDepth = 5): {
    nodes: IssueNode[];
    edges: { from: number; to: number; type: string }[];
  } {
    const visited = new Set<string>();
    const nodes: IssueNode[] = [];
    const edges: { from: number; to: number; type: string }[] = [];
    
    const traverse = (id: string, depth: number) => {
      if (visited.has(id) || depth > maxDepth) return;
      visited.add(id);
      
      const issue = this.store.getNode(id) as IssueNode;
      if (!issue) return;
      
      const nodeIndex = nodes.length;
      nodes.push(issue);
      
      // Traverse BLOCKS relationships
      const blocksEdges = this.store.getOutgoingEdges(id, 'BLOCKS');
      for (const edge of blocksEdges) {
        const targetIndex = nodes.findIndex(n => n._id === edge._to);
        if (targetIndex === -1) {
          traverse(edge._to, depth + 1);
          const newIndex = nodes.length - 1;
          edges.push({ from: nodeIndex, to: newIndex, type: 'BLOCKS' });
        } else {
          edges.push({ from: nodeIndex, to: targetIndex, type: 'BLOCKS' });
        }
      }
    };
    
    traverse(issueId, 0);
    return { nodes, edges };
  }
}
```

---

## View Definitions

### Declarative View Configuration

```yaml
# views/kanban.yaml
name: Sprint Board
type: board
source: github:owner/repo

# What to query
query: |
  MATCH (i:Issue {state: 'open'})-[:BELONGS_TO_PROJECT]->(p:Project {title: 'Sprint'})
  MATCH (i)-[sv:FIELD_VALUE]->(sf:FieldDefinition {name: 'Status'})
  RETURN i, sv.value AS status

# How to group
group_by:
  field: status
  columns:
    - value: "To Do"
      label: "To Do"
      color: "#e0e0e0"
    - value: "In Progress"
      label: "In Progress"
      color: "#ffd700"
    - value: "Done"
      label: "Done"
      color: "#00ff00"

# How to sort within columns
sort_by:
  - field: priority
    direction: desc
  - field: updated_at
    direction: desc

# What to display on cards
card_template:
  title: "{{ i.title }}"
  subtitle: "#{{ i.number }}"
  labels: true
  assignees: true
  fields:
    - Priority
    - Estimate
```

### Roadmap View

```yaml
# views/roadmap.yaml
name: Product Roadmap
type: roadmap
source: github:owner/repo

query: |
  MATCH (i:Issue)-[:BELONGS_TO_PROJECT]->(p:Project {title: 'Roadmap'})
  MATCH (i)-[iv:FIELD_VALUE]->(f:FieldDefinition {name: 'Iteration'})
  RETURN i, iv.value AS iteration, iv.start_date, iv.end_date

# Time axis configuration
time_axis:
  field: iteration
  start: start_date
  end: end_date
  granularity: week

# Swimlanes (optional)
group_by:
  field: team
  
# Item rendering
item_template:
  title: "{{ i.title }}"
  progress: "{{ closed_subtasks / total_subtasks * 100 }}%"
```

### Filter View

```yaml
# views/my-issues.yaml
name: My Issues
type: list
source: github:owner/repo

query: |
  MATCH (i:Issue {state: 'open'})-[:ASSIGNED_TO]->(u:User {login: '{{ current_user }}'})
  OPTIONAL MATCH (i)-[:HAS_LABEL]->(l:Label)
  OPTIONAL MATCH (i)-[:BLOCKED_BY]->(blocker:Issue {state: 'open'})
  RETURN i, collect(l.name) AS labels, count(blocker) AS open_blockers
  ORDER BY i.updated_at DESC

filters:
  - field: labels
    type: multi-select
    label: "Labels"
  - field: open_blockers
    type: number
    label: "Has blockers"
    operators: [eq, gt, lt]

columns:
  - field: number
    width: 60
    align: right
  - field: title
    width: auto
    link: true
  - field: labels
    width: 200
    render: tags
  - field: open_blockers
    width: 80
    label: "Blocked"
```

---

## Query Language Parser

### Using Existing Libraries

For a full Cypher implementation, consider:

```typescript
// Option 1: cypher-query-builder (simpler, builder pattern)
import { Query } from 'cypher-query-builder';

const query = new Query()
  .match([{ identifier: 'i', labels: ['Issue'] }])
  .where({ 'i.state': 'open' })
  .return(['i.number', 'i.title']);

// Option 2: openCypher parser (full parser)
// https://github.com/opencypher/openCypher
```

### Simple Filter Parser

```typescript
// Parse simple filter syntax like: "state:open labels:bug,priority assignee:alice"
interface ParsedFilter {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  assignees?: string[];
  milestone?: string;
  project?: string;
  is?: ('blocked' | 'blocking' | 'unassigned')[];
}

function parseFilterString(filter: string): ParsedFilter {
  const result: ParsedFilter = {};
  const parts = filter.split(/\s+/);
  
  for (const part of parts) {
    const [key, value] = part.split(':');
    
    switch (key) {
      case 'state':
        result.state = value as any;
        break;
      case 'labels':
      case 'label':
        result.labels = value.split(',');
        break;
      case 'assignee':
      case 'assignees':
        result.assignees = value.split(',');
        break;
      case 'milestone':
        result.milestone = value;
        break;
      case 'project':
        result.project = value;
        break;
      case 'is':
        result.is = value.split(',') as any;
        break;
    }
  }
  
  return result;
}

// Usage
const filter = parseFilterString('state:open labels:bug,priority is:blocking');
// { state: 'open', labels: ['bug', 'priority'], is: ['blocking'] }
```

---

## Graph Serialization

### Export Graph to File

```typescript
// Export as GraphML (standard format)
function exportToGraphML(store: GraphStore): string {
  const nodes = Array.from(store.getAllNodes());
  const edges = store.getAllEdges();
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <graph id="G" edgedefault="directed">
    ${nodes.map(n => `
    <node id="${n._id}">
      <data key="type">${n._type}</data>
      ${Object.entries(n).filter(([k]) => !k.startsWith('_')).map(([k, v]) =>
        `<data key="${k}">${escapeXml(String(v))}</data>`
      ).join('\n      ')}
    </node>`).join('')}
    ${edges.map((e, i) => `
    <edge id="e${i}" source="${e._from}" target="${e._to}">
      <data key="type">${e._type}</data>
    </edge>`).join('')}
  </graph>
</graphml>`;
}

// Export as JSON (simpler)
function exportToJSON(store: GraphStore): string {
  return JSON.stringify({
    nodes: Array.from(store.getAllNodes()),
    edges: store.getAllEdges(),
  }, null, 2);
}
```

### Import Graph from Synced Data

```typescript
async function buildGraphFromSync(
  issuesDir: string,
  projectsDir: string
): Promise<GraphStore> {
  const store = new GraphStore();
  
  // Load issues
  const issueFiles = await glob(`${issuesDir}/*.md`);
  for (const file of issueFiles) {
    const { frontmatter, body } = parseMarkdownFile(file);
    
    // Add issue node
    store.addNode({
      _type: 'Issue',
      _id: `github:${frontmatter.url}`,
      number: frontmatter.number,
      title: extractTitle(body),
      body: extractBody(body),
      state: frontmatter.state,
      created_at: frontmatter.created_at,
      updated_at: frontmatter.updated_at,
      url: frontmatter.url,
      source: 'github',
    });
    
    // Add label edges
    for (const label of frontmatter.labels || []) {
      const labelId = `github:${frontmatter.owner}/${frontmatter.repo}:${label}`;
      store.addNode({
        _type: 'Label',
        _id: labelId,
        name: label,
        color: '', // Would need to load from metadata
        description: null,
      });
      store.addEdge({
        _type: 'HAS_LABEL',
        _from: `github:${frontmatter.url}`,
        _to: labelId,
      });
    }
    
    // Add assignee edges
    for (const assignee of frontmatter.assignees || []) {
      const userId = `github:${assignee}`;
      store.addNode({
        _type: 'User',
        _id: userId,
        login: assignee,
        name: null,
        avatar_url: '',
        source: 'github',
      });
      store.addEdge({
        _type: 'ASSIGNED_TO',
        _from: `github:${frontmatter.url}`,
        _to: userId,
      });
    }
    
    // Parse body for issue references
    const references = extractIssueReferences(body);
    for (const ref of references) {
      store.addEdge({
        _type: 'REFERENCES',
        _from: `github:${frontmatter.url}`,
        _to: `github:${ref}`,
      });
    }
  }
  
  return store;
}

// Extract issue references from markdown body
function extractIssueReferences(body: string): string[] {
  const patterns = [
    /#(\d+)/g,                                    // #123
    /([a-z0-9-]+\/[a-z0-9-]+)#(\d+)/gi,          // owner/repo#123
    /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/g,  // full URL
  ];
  
  const refs: string[] = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(body)) !== null) {
      if (match[3]) {
        // Full URL
        refs.push(`${match[1]}/${match[2]}/issues/${match[3]}`);
      } else if (match[2]) {
        // owner/repo#123
        refs.push(`${match[1]}/issues/${match[2]}`);
      } else {
        // #123 - same repo reference
        refs.push(`issues/${match[1]}`);
      }
    }
  }
  
  return [...new Set(refs)];
}
```

---

## CLI Query Interface

```typescript
#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('hardcopy')
  .description('Query synced project data');

program
  .command('query')
  .argument('<filter>', 'Filter expression')
  .option('-f, --format <format>', 'Output format', 'table')
  .option('-o, --output <file>', 'Output file')
  .action(async (filter, options) => {
    const store = await loadGraphStore();
    const executor = new QueryExecutor(store);
    
    const parsed = parseFilterString(filter);
    const results = executor.findIssues(parsed);
    
    switch (options.format) {
      case 'table':
        console.table(results.map(r => ({
          '#': r.number,
          title: r.title.slice(0, 50),
          state: r.state,
        })));
        break;
      case 'json':
        console.log(JSON.stringify(results, null, 2));
        break;
      case 'csv':
        // ... csv output
        break;
    }
  });

program
  .command('deps')
  .argument('<issue>', 'Issue number or URL')
  .option('-d, --depth <depth>', 'Max depth', '5')
  .action(async (issue, options) => {
    const store = await loadGraphStore();
    const executor = new QueryExecutor(store);
    
    const graph = executor.getDependencyGraph(
      resolveIssueId(issue),
      parseInt(options.depth)
    );
    
    // ASCII tree output
    printDependencyTree(graph);
  });

program.parse();
```

---

## Integration with Views

### Loading Views with Queries

```typescript
interface ViewLoader {
  loadView(viewConfig: ViewConfig): Promise<ViewData>;
}

class ViewLoaderImpl implements ViewLoader {
  constructor(
    private store: GraphStore,
    private executor: QueryExecutor
  ) {}
  
  async loadView(config: ViewConfig): Promise<ViewData> {
    // Execute the query
    const issues = this.executor.findIssues(config.filters);
    
    // Apply grouping
    const grouped = this.groupBy(issues, config.group_by);
    
    // Apply sorting
    for (const column of Object.values(grouped)) {
      this.sortBy(column, config.sort_by);
    }
    
    return {
      name: config.name,
      type: config.type,
      columns: grouped,
      total: issues.length,
    };
  }
  
  private groupBy(
    issues: IssueNode[],
    groupConfig?: GroupConfig
  ): Record<string, IssueNode[]> {
    if (!groupConfig) {
      return { default: issues };
    }
    
    const groups: Record<string, IssueNode[]> = {};
    
    for (const column of groupConfig.columns) {
      groups[column.value] = [];
    }
    
    for (const issue of issues) {
      const fieldValue = this.getFieldValue(issue, groupConfig.field);
      const group = groups[fieldValue] || groups['_other'];
      if (group) {
        group.push(issue);
      }
    }
    
    return groups;
  }
  
  private getFieldValue(issue: IssueNode, field: string): any {
    // Check if it's a custom field
    const edges = this.store.getOutgoingEdges(issue._id, 'FIELD_VALUE');
    for (const edge of edges) {
      const fieldDef = this.store.getNode(edge._to) as FieldDefinitionNode;
      if (fieldDef?.name === field) {
        return edge.properties?.value;
      }
    }
    
    // Check standard fields
    return (issue as any)[field];
  }
}
```

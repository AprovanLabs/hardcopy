# Generic Sync Plugin Architecture

## Overview

This document outlines the architecture for a generic bi-directional sync system that can adapt to multiple data sources (GitHub Issues, Figma, Google Calendar, Gmail, Google Docs, etc.) while maintaining:

1. **Consistent local file representation** (Markdown/YAML)
2. **CRDT-based conflict resolution** using Loro
3. **Graph-queryable data** using GQL/Cypher patterns
4. **Extensible adapter pattern** for new data sources

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                      User Interface                          │
│   CLI Commands | File Watcher | VS Code Extension | Web UI  │
├─────────────────────────────────────────────────────────────┤
│                      Query Engine                            │
│          GQL Parser | Graph Store | View Loader              │
├─────────────────────────────────────────────────────────────┤
│                      Sync Engine                             │
│     Conflict Resolution | Delta Detection | State Tracking   │
├─────────────────────────────────────────────────────────────┤
│                      CRDT Layer                              │
│          Loro Documents | Version Tracking | Merge           │
├─────────────────────────────────────────────────────────────┤
│                   Adapter Interface                          │
│        Source Adapters (GitHub, Figma, Google, etc.)         │
├─────────────────────────────────────────────────────────────┤
│                    Storage Layer                             │
│         Local Files | CRDT Persistence | Cache               │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Interfaces

### Source Adapter Interface

```typescript
interface SourceAdapter<TItem, TMetadata = unknown> {
  // Identity
  readonly id: string;           // e.g., "github-issues"
  readonly displayName: string;  // e.g., "GitHub Issues"
  readonly icon: string;         // e.g., "github"
  
  // Configuration
  configure(config: AdapterConfig): Promise<void>;
  validateConfig(): Promise<ValidationResult>;
  
  // Data Operations
  fetchAll(options?: FetchOptions): AsyncGenerator<TItem>;
  fetchOne(id: string): Promise<TItem>;
  fetchMetadata(): Promise<TMetadata>;
  
  create(data: CreateInput<TItem>): Promise<TItem>;
  update(id: string, data: UpdateInput<TItem>): Promise<TItem>;
  delete(id: string): Promise<void>;
  
  // CRDT Integration
  itemToCRDT(item: TItem): LoroDocument;
  crdtToItem(doc: LoroDocument): Partial<TItem>;
  
  // File Format
  itemToFile(item: TItem): FileContent;
  fileToItem(file: FileContent): ParseResult<TItem>;
  
  // Graph Model
  itemToNodes(item: TItem): GraphNode[];
  itemToEdges(item: TItem): GraphEdge[];
  
  // Change Detection
  getLastModified(item: TItem): Date;
  getETag?(item: TItem): string;
  
  // Webhooks (optional)
  webhookHandler?: WebhookHandler<TItem>;
}
```

### Sync State Interface

```typescript
interface SyncState {
  // Item tracking
  items: Map<string, ItemSyncState>;
  
  // Global metadata
  lastFullSync: Date | null;
  lastIncrementalSync: Date | null;
  
  // Adapter-specific state
  adapterState: Record<string, unknown>;
}

interface ItemSyncState {
  id: string;
  localPath: string;
  
  // Versions
  remoteVersion: string;        // ETag or updated_at
  localVersion: Uint8Array;     // CRDT frontiers
  
  // Timestamps
  remoteUpdatedAt: Date;
  localUpdatedAt: Date;
  lastSyncAt: Date;
  
  // Status
  status: 'synced' | 'local_ahead' | 'remote_ahead' | 'conflict' | 'error';
  errorMessage?: string;
}
```

### File Content Interface

```typescript
interface FileContent {
  // Front matter (YAML)
  frontmatter: Record<string, unknown>;
  
  // Body content
  body: string;
  
  // Optional structured data
  data?: Record<string, unknown>;
}

interface ParseResult<T> {
  success: boolean;
  item?: Partial<T>;
  errors?: ParseError[];
}
```

---

## Adapter Implementations

### GitHub Issues Adapter

```typescript
class GitHubIssuesAdapter implements SourceAdapter<GitHubIssue, RepoMetadata> {
  readonly id = 'github-issues';
  readonly displayName = 'GitHub Issues';
  readonly icon = 'github';
  
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  
  async *fetchAll(options?: FetchOptions): AsyncGenerator<GitHubIssue> {
    const since = options?.since?.toISOString();
    
    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.issues.listForRepo,
      {
        owner: this.owner,
        repo: this.repo,
        state: 'all',
        since,
        per_page: 100,
      }
    )) {
      for (const issue of response.data) {
        if (!issue.pull_request) {  // Skip PRs
          yield issue as GitHubIssue;
        }
      }
    }
  }
  
  itemToCRDT(issue: GitHubIssue): LoroDocument {
    const doc = new Loro();
    
    doc.getText('title').insert(0, issue.title);
    doc.getText('body').insert(0, issue.body || '');
    
    const labels = doc.getList('labels');
    for (const label of issue.labels) {
      labels.push(typeof label === 'string' ? label : label.name);
    }
    
    const assignees = doc.getList('assignees');
    for (const assignee of issue.assignees || []) {
      assignees.push(assignee.login);
    }
    
    const meta = doc.getMap('metadata');
    meta.set('state', issue.state);
    meta.set('state_reason', issue.state_reason);
    meta.set('number', issue.number);
    meta.set('id', issue.id);
    meta.set('node_id', issue.node_id);
    meta.set('url', issue.html_url);
    meta.set('milestone', issue.milestone?.title || null);
    
    doc.commit();
    return doc;
  }
  
  itemToFile(issue: GitHubIssue): FileContent {
    return {
      frontmatter: {
        id: issue.id,
        node_id: issue.node_id,
        number: issue.number,
        url: issue.html_url,
        state: issue.state,
        state_reason: issue.state_reason,
        labels: issue.labels.map(l => typeof l === 'string' ? l : l.name),
        assignees: issue.assignees?.map(a => a.login) || [],
        milestone: issue.milestone?.title || null,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
      },
      body: `# ${issue.title}\n\n${issue.body || ''}`,
    };
  }
  
  itemToNodes(issue: GitHubIssue): GraphNode[] {
    const nodes: GraphNode[] = [];
    
    // Issue node
    nodes.push({
      _type: 'Issue',
      _id: `github:${this.owner}/${this.repo}#${issue.number}`,
      number: issue.number,
      title: issue.title,
      body: issue.body || '',
      state: issue.state,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      url: issue.html_url,
      source: 'github',
    });
    
    // Label nodes
    for (const label of issue.labels) {
      const labelObj = typeof label === 'string' ? { name: label } : label;
      nodes.push({
        _type: 'Label',
        _id: `github:${this.owner}/${this.repo}:label:${labelObj.name}`,
        name: labelObj.name,
        color: (labelObj as any).color || '',
        description: (labelObj as any).description || null,
      });
    }
    
    // User nodes
    for (const assignee of issue.assignees || []) {
      nodes.push({
        _type: 'User',
        _id: `github:${assignee.login}`,
        login: assignee.login,
        avatar_url: assignee.avatar_url,
        source: 'github',
      });
    }
    
    return nodes;
  }
  
  itemToEdges(issue: GitHubIssue): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const issueId = `github:${this.owner}/${this.repo}#${issue.number}`;
    
    // Label edges
    for (const label of issue.labels) {
      const labelName = typeof label === 'string' ? label : label.name;
      edges.push({
        _type: 'HAS_LABEL',
        _from: issueId,
        _to: `github:${this.owner}/${this.repo}:label:${labelName}`,
      });
    }
    
    // Assignee edges
    for (const assignee of issue.assignees || []) {
      edges.push({
        _type: 'ASSIGNED_TO',
        _from: issueId,
        _to: `github:${assignee.login}`,
      });
    }
    
    // Reference edges (from body parsing)
    for (const ref of this.parseReferences(issue.body || '')) {
      edges.push({
        _type: 'REFERENCES',
        _from: issueId,
        _to: ref,
      });
    }
    
    return edges;
  }
}
```

### Figma Comments Adapter (Example)

```typescript
class FigmaCommentsAdapter implements SourceAdapter<FigmaComment, FileMetadata> {
  readonly id = 'figma-comments';
  readonly displayName = 'Figma Comments';
  readonly icon = 'figma';
  
  async *fetchAll(): AsyncGenerator<FigmaComment> {
    const response = await fetch(
      `https://api.figma.com/v1/files/${this.fileKey}/comments`,
      { headers: { 'X-Figma-Token': this.token } }
    );
    const data = await response.json();
    yield* data.comments;
  }
  
  itemToFile(comment: FigmaComment): FileContent {
    return {
      frontmatter: {
        id: comment.id,
        file_key: this.fileKey,
        node_id: comment.client_meta?.node_id,
        author: comment.user.handle,
        created_at: comment.created_at,
        resolved_at: comment.resolved_at,
      },
      body: comment.message,
    };
  }
  
  // ... other methods
}
```

### Google Calendar Events Adapter (Example)

```typescript
class GoogleCalendarAdapter implements SourceAdapter<CalendarEvent, CalendarMetadata> {
  readonly id = 'google-calendar';
  readonly displayName = 'Google Calendar';
  readonly icon = 'calendar';
  
  async *fetchAll(options?: FetchOptions): AsyncGenerator<CalendarEvent> {
    const calendar = google.calendar({ version: 'v3', auth: this.auth });
    
    let pageToken: string | undefined;
    do {
      const response = await calendar.events.list({
        calendarId: this.calendarId,
        timeMin: options?.since?.toISOString(),
        maxResults: 100,
        pageToken,
        singleEvents: true,
        orderBy: 'startTime',
      });
      
      for (const event of response.data.items || []) {
        yield event as CalendarEvent;
      }
      
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
  }
  
  itemToFile(event: CalendarEvent): FileContent {
    return {
      frontmatter: {
        id: event.id,
        calendar_id: this.calendarId,
        status: event.status,
        summary: event.summary,
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        location: event.location,
        attendees: event.attendees?.map(a => a.email),
        recurrence: event.recurrence,
        updated_at: event.updated,
      },
      body: event.description || '',
    };
  }
  
  itemToNodes(event: CalendarEvent): GraphNode[] {
    return [{
      _type: 'CalendarEvent',
      _id: `gcal:${this.calendarId}:${event.id}`,
      summary: event.summary || '',
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      location: event.location || null,
      source: 'google-calendar',
    }];
  }
}
```

---

## Sync Engine

```typescript
class SyncEngine {
  constructor(
    private adapters: Map<string, SourceAdapter<any>>,
    private storage: StorageProvider,
    private stateManager: SyncStateManager,
    private graphStore: GraphStore,
  ) {}
  
  // Full sync - pull everything
  async fullSync(adapterId: string): Promise<SyncResult> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
    
    const results: SyncItemResult[] = [];
    
    for await (const item of adapter.fetchAll()) {
      const result = await this.syncItem(adapter, item, 'pull');
      results.push(result);
    }
    
    // Update metadata
    const metadata = await adapter.fetchMetadata();
    await this.storage.saveMetadata(adapterId, metadata);
    
    // Rebuild graph
    await this.rebuildGraph(adapterId);
    
    // Update state
    await this.stateManager.setLastFullSync(adapterId, new Date());
    
    return { adapterId, results };
  }
  
  // Incremental sync - only changed items
  async incrementalSync(adapterId: string): Promise<SyncResult> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
    
    const lastSync = await this.stateManager.getLastSync(adapterId);
    const results: SyncItemResult[] = [];
    
    // Pull remote changes
    for await (const item of adapter.fetchAll({ since: lastSync })) {
      const result = await this.syncItem(adapter, item, 'pull');
      results.push(result);
    }
    
    // Push local changes
    const localChanges = await this.stateManager.getLocalChanges(adapterId);
    for (const itemId of localChanges) {
      const result = await this.pushLocalChange(adapter, itemId);
      results.push(result);
    }
    
    // Update graph incrementally
    await this.updateGraph(adapterId, results);
    
    await this.stateManager.setLastSync(adapterId, new Date());
    
    return { adapterId, results };
  }
  
  // Sync single item
  private async syncItem<T>(
    adapter: SourceAdapter<T>,
    remoteItem: T,
    direction: 'pull' | 'push' | 'both'
  ): Promise<SyncItemResult> {
    const itemId = this.getItemId(adapter, remoteItem);
    const state = await this.stateManager.getItemState(adapter.id, itemId);
    
    // Load or create CRDT
    let doc = await this.storage.loadCRDT(adapter.id, itemId);
    if (!doc) {
      doc = adapter.itemToCRDT(remoteItem);
    }
    
    // Check sync status
    const remoteUpdatedAt = adapter.getLastModified(remoteItem);
    const status = this.computeSyncStatus(state, remoteUpdatedAt, doc);
    
    switch (status) {
      case 'synced':
        return { itemId, status: 'unchanged' };
        
      case 'remote_ahead':
        // Merge remote into local
        const remoteDoc = adapter.itemToCRDT(remoteItem);
        doc.import(remoteDoc.export({ mode: 'update' }));
        break;
        
      case 'local_ahead':
        // Push local to remote
        const updates = adapter.crdtToItem(doc);
        await adapter.update(itemId, updates);
        break;
        
      case 'conflict':
        // CRDT merge + push
        const remoteDocConflict = adapter.itemToCRDT(remoteItem);
        doc.import(remoteDocConflict.export({ mode: 'update' }));
        const mergedUpdates = adapter.crdtToItem(doc);
        await adapter.update(itemId, mergedUpdates);
        break;
    }
    
    // Save CRDT
    await this.storage.saveCRDT(adapter.id, itemId, doc);
    
    // Save file
    const fileContent = adapter.itemToFile(remoteItem);
    await this.storage.saveFile(adapter.id, itemId, fileContent);
    
    // Update state
    await this.stateManager.updateItemState(adapter.id, itemId, {
      remoteVersion: adapter.getETag?.(remoteItem) || remoteUpdatedAt.toISOString(),
      localVersion: doc.export({ mode: 'snapshot' }),
      remoteUpdatedAt,
      localUpdatedAt: new Date(),
      lastSyncAt: new Date(),
      status: 'synced',
    });
    
    return { itemId, status: 'updated' };
  }
}
```

---

## Storage Provider

```typescript
interface StorageProvider {
  // CRDT storage
  loadCRDT(adapterId: string, itemId: string): Promise<LoroDocument | null>;
  saveCRDT(adapterId: string, itemId: string, doc: LoroDocument): Promise<void>;
  
  // File storage
  loadFile(adapterId: string, itemId: string): Promise<FileContent | null>;
  saveFile(adapterId: string, itemId: string, content: FileContent): Promise<void>;
  deleteFile(adapterId: string, itemId: string): Promise<void>;
  listFiles(adapterId: string): AsyncGenerator<string>;
  
  // Metadata storage
  loadMetadata(adapterId: string): Promise<unknown>;
  saveMetadata(adapterId: string, metadata: unknown): Promise<void>;
}

class FileSystemStorageProvider implements StorageProvider {
  constructor(private baseDir: string) {}
  
  private getPath(adapterId: string, itemId: string, ext: string): string {
    const sanitized = itemId.replace(/[^a-zA-Z0-9-]/g, '_');
    return path.join(this.baseDir, adapterId, `${sanitized}.${ext}`);
  }
  
  async saveCRDT(adapterId: string, itemId: string, doc: LoroDocument): Promise<void> {
    const filePath = this.getPath(adapterId, itemId, 'loro');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(doc.export({ mode: 'snapshot' })));
  }
  
  async saveFile(adapterId: string, itemId: string, content: FileContent): Promise<void> {
    const filePath = this.getPath(adapterId, itemId, 'md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
    const yaml = YAML.stringify(content.frontmatter);
    const fileContent = `---\n${yaml}---\n\n${content.body}`;
    
    await fs.writeFile(filePath, fileContent, 'utf-8');
  }
}
```

---

## Directory Structure

```
.hardcopy/
├── hardcopy.yaml                     # Global configuration
├── sync-state.yaml                 # Sync state tracking
├── crdt/                           # CRDT binary files
│   ├── github-issues/
│   │   ├── issue-42.loro
│   │   └── issue-43.loro
│   ├── figma-comments/
│   └── google-calendar/
├── adapters/
│   ├── github-issues/
│   │   ├── issues/
│   │   │   ├── 042-fix-login-bug.md
│   │   │   └── 043-add-dark-mode.md
│   │   ├── projects/
│   │   │   └── sprint-board/
│   │   │       ├── metadata.yaml
│   │   │       └── view.yaml
│   │   └── metadata/
│   │       ├── labels.yaml
│   │       ├── milestones.yaml
│   │       └── users.yaml
│   ├── figma-comments/
│   │   └── comments/
│   └── google-calendar/
│       └── events/
├── views/                          # Custom views
│   ├── my-issues.yaml
│   ├── sprint-board.yaml
│   └── roadmap.yaml
└── graph/                          # Graph exports
    └── graph.json
```

---

## Configuration

```yaml
# .hardcopy/hardcopy.yaml
version: 1

# Adapter configurations
adapters:
  github-issues:
    enabled: true
    owner: myorg
    repo: myrepo
    sync_interval: 5m
    include_prs: false
    
  github-projects:
    enabled: true
    project_numbers: [1, 2]
    
  figma-comments:
    enabled: true
    file_keys:
      - abc123
      - def456
    
  google-calendar:
    enabled: false
    calendar_id: primary

# Sync settings
sync:
  auto_sync: true
  interval: 5m
  on_file_change: true
  conflict_strategy: crdt_merge  # crdt_merge | local_wins | remote_wins | prompt

# File settings  
files:
  format: markdown  # markdown | yaml | json
  naming: "{number}-{title}"
  max_title_length: 50
  
# Graph settings
graph:
  auto_rebuild: true
  include_references: true
  max_depth: 5
```

---

## CLI Commands

```bash
# Initialize hardcopy in current directory
hardcopy init

# Configure an adapter
hardcopy config github-issues --owner myorg --repo myrepo

# Full sync
hardcopy sync
hardcopy sync github-issues

# Watch for changes
hardcopy watch

# Query data
hardcopy query "state:open labels:bug"
hardcopy query "MATCH (i:Issue)-[:BLOCKS]->(b:Issue) RETURN i, b"

# Show sync status
hardcopy status
hardcopy status github-issues

# Show dependency graph
hardcopy deps 42

# Export graph
hardcopy export graph.json
```

---

## Event Flow

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Remote  │────▶│  Adapter │────▶│   CRDT   │────▶│   File   │
│   API    │     │          │     │  Merge   │     │  Write   │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                                        │
                                        ▼
                                 ┌──────────┐
                                 │  Graph   │
                                 │  Update  │
                                 └──────────┘

┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   File   │────▶│  Parser  │────▶│   CRDT   │────▶│  Adapter │
│  Change  │     │          │     │  Update  │     │   Push   │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

---

## Extension Points

1. **Custom Adapters**: Implement `SourceAdapter` interface for new data sources
2. **Custom File Formats**: Override `itemToFile`/`fileToItem` methods
3. **Custom Graph Nodes**: Add domain-specific node/edge types
4. **Custom Views**: Define YAML view configurations
5. **Webhooks**: Implement real-time sync via webhooks
6. **Transformers**: Add pre/post processing hooks

---

## Next Steps

1. Implement core `SyncEngine` with GitHub Issues adapter
2. Add file watcher for local change detection
3. Build graph query interface
4. Create VS Code extension for visual board views
5. Add Figma and Google Calendar adapters
6. Implement webhook support for real-time sync

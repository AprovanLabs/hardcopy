# CRDT Sync Patterns with Loro

## Overview

This document covers CRDT (Conflict-free Replicated Data Types) patterns for bi-directional sync between local files and remote APIs (GitHub, Figma, Google services, etc.). We'll use the [Loro](https://github.com/loro-dev/loro) library for conflict resolution.

---

## Why CRDTs for Sync?

### The Sync Problem
When syncing data bidirectionally:
1. **Local edits** can happen offline or between syncs
2. **Remote edits** can happen from web UI, mobile apps, or other clients
3. **Concurrent edits** create conflicts that need resolution

### Traditional Approaches
- **Last-write-wins**: Loses data, causes frustration
- **Manual conflict resolution**: Requires user intervention
- **Locking**: Prevents concurrent editing

### CRDT Approach
- **Automatic merge**: Concurrent edits merge deterministically
- **No data loss**: All operations are preserved
- **Eventual consistency**: All replicas converge to same state
- **Offline-first**: Works without network connectivity

---

## Loro Library Fundamentals

### Installation
```bash
npm install loro-crdt
# or
pnpm add loro-crdt
```

### Core Concepts

#### LoroDoc
The main document container that holds all CRDT data structures.

```typescript
import { Loro, LoroText, LoroList, LoroMap } from 'loro-crdt';

// Create a new document
const doc = new Loro();

// Get or create containers
const title = doc.getText('title');
const body = doc.getText('body');
const labels = doc.getList('labels');
const metadata = doc.getMap('metadata');
```

#### Container Types

| Type | Use Case | Operations |
|------|----------|------------|
| `LoroText` | Rich text, Markdown bodies | insert, delete, mark (formatting) |
| `LoroList` | Arrays, ordered items | insert, delete, push, get |
| `LoroMap` | Key-value pairs, metadata | set, get, delete |
| `LoroTree` | Hierarchical structures | create, move, delete nodes |
| `LoroMovableList` | Reorderable lists | insert, move, delete |

---

## Data Modeling for Sync

### GitHub Issue Model

```typescript
import { Loro, LoroMap, LoroText, LoroList } from 'loro-crdt';

interface IssueCRDT {
  doc: Loro;
  title: LoroText;
  body: LoroText;
  labels: LoroList;
  assignees: LoroList;
  metadata: LoroMap;
}

function createIssueCRDT(): IssueCRDT {
  const doc = new Loro();
  
  return {
    doc,
    title: doc.getText('title'),
    body: doc.getText('body'),
    labels: doc.getList('labels'),       // string[]
    assignees: doc.getList('assignees'), // string[]
    metadata: doc.getMap('metadata'),    // { state, milestone, etc. }
  };
}

// Initialize from GitHub API response
function initFromGitHub(crdt: IssueCRDT, issue: GitHubIssue): void {
  crdt.title.insert(0, issue.title);
  crdt.body.insert(0, issue.body || '');
  
  for (const label of issue.labels) {
    crdt.labels.push(label.name);
  }
  
  for (const assignee of issue.assignees) {
    crdt.assignees.push(assignee.login);
  }
  
  crdt.metadata.set('state', issue.state);
  crdt.metadata.set('state_reason', issue.state_reason);
  crdt.metadata.set('number', issue.number);
  crdt.metadata.set('id', issue.id);
  crdt.metadata.set('node_id', issue.node_id);
  crdt.metadata.set('url', issue.html_url);
  crdt.metadata.set('created_at', issue.created_at);
  crdt.metadata.set('updated_at', issue.updated_at);
  crdt.metadata.set('milestone', issue.milestone?.title || null);
  
  // Commit changes
  doc.commit();
}
```

### Project Item Model

```typescript
function createProjectItemCRDT() {
  const doc = new Loro();
  
  return {
    doc,
    fieldValues: doc.getMap('fieldValues'), // { Status: "Done", Priority: "High" }
    position: doc.getMap('position'),        // { viewId: order }
    metadata: doc.getMap('metadata'),
  };
}
```

---

## Sync Operations

### Export/Import (Serialization)

```typescript
// Export modes
const snapshot = doc.export({ mode: 'snapshot' }); // Full state (larger, self-contained)
const updates = doc.export({ mode: 'update' });    // Incremental changes (smaller, requires base)
const shallowSnapshot = doc.export({ mode: 'shallow-snapshot', frontiers: frontiers });

// Import
const newDoc = new Loro();
newDoc.import(snapshot);

// Or import updates into existing doc
existingDoc.import(updates);
```

### Version Tracking

```typescript
// Get current version (frontiers)
const version = doc.frontiers();
// Returns: { peer1: 123, peer2: 456 }

// Get oplog version for comparison
const opVersion = doc.oplogVersion();

// Check if document has all changes from another version
const isAheadOf = doc.cmpWithFrontiers(otherVersion);
// Returns: -1 (behind), 0 (equal), 1 (ahead), undefined (concurrent/diverged)
```

### Merging Remote Changes

```typescript
async function pullRemoteChanges(
  localDoc: Loro,
  fetchRemote: () => Promise<{ data: any; version: string }>
): Promise<void> {
  const remote = await fetchRemote();
  
  // Create temporary doc from remote data
  const remoteDoc = new Loro();
  initFromGitHub(remoteDoc, remote.data);
  
  // Export remote as updates
  const remoteUpdates = remoteDoc.export({ mode: 'update' });
  
  // Import into local - automatic CRDT merge
  localDoc.import(remoteUpdates);
  
  // Commit merged state
  localDoc.commit();
}
```

### Detecting Local Changes

```typescript
function hasLocalChanges(doc: Loro, lastSyncVersion: Uint8Array): boolean {
  const currentVersion = doc.export({ mode: 'update', from: lastSyncVersion });
  return currentVersion.length > 0;
}

function getChangesSince(doc: Loro, sinceVersion: Uint8Array): Uint8Array {
  return doc.export({ mode: 'update', from: sinceVersion });
}
```

---

## Text Diff and Apply

### Applying String Changes to LoroText

```typescript
import { diffChars } from 'diff'; // npm install diff

function applyTextChanges(loroText: LoroText, oldText: string, newText: string): void {
  const changes = diffChars(oldText, newText);
  let position = 0;
  
  for (const change of changes) {
    if (change.removed) {
      loroText.delete(position, change.value!.length);
    } else if (change.added) {
      loroText.insert(position, change.value!);
      position += change.value!.length;
    } else {
      position += change.value!.length;
    }
  }
}

// Usage: When user edits local markdown file
function onFileChanged(crdt: IssueCRDT, oldContent: string, newContent: string): void {
  const { title: oldTitle, body: oldBody } = parseMarkdown(oldContent);
  const { title: newTitle, body: newBody } = parseMarkdown(newContent);
  
  if (oldTitle !== newTitle) {
    applyTextChanges(crdt.title, oldTitle, newTitle);
  }
  if (oldBody !== newBody) {
    applyTextChanges(crdt.body, oldBody, newBody);
  }
  
  crdt.doc.commit();
}
```

### Applying List Changes

```typescript
function applyListChanges<T>(
  loroList: LoroList,
  oldItems: T[],
  newItems: T[],
  getId: (item: T) => string
): void {
  const oldSet = new Set(oldItems.map(getId));
  const newSet = new Set(newItems.map(getId));
  
  // Find removed items
  for (let i = loroList.length - 1; i >= 0; i--) {
    const item = loroList.get(i) as T;
    if (!newSet.has(getId(item))) {
      loroList.delete(i, 1);
    }
  }
  
  // Find added items
  for (const item of newItems) {
    if (!oldSet.has(getId(item))) {
      loroList.push(item);
    }
  }
}

// Usage for labels
applyListChanges(
  crdt.labels,
  oldIssue.labels.map(l => l.name),
  newIssue.labels.map(l => l.name),
  (name) => name
);
```

---

## Conflict Detection and Resolution

### Checking for Conflicts

```typescript
interface SyncState {
  localVersion: Uint8Array;    // Version after last sync
  remoteVersion: string;       // ETag or updated_at from API
  lastSyncTime: number;
}

enum SyncStatus {
  SYNCED = 'synced',
  LOCAL_AHEAD = 'local_ahead',
  REMOTE_AHEAD = 'remote_ahead',
  CONFLICT = 'conflict',
}

function checkSyncStatus(
  doc: Loro,
  state: SyncState,
  remoteUpdatedAt: string
): SyncStatus {
  const hasLocalChanges = hasLocalChanges(doc, state.localVersion);
  const hasRemoteChanges = remoteUpdatedAt !== state.remoteVersion;
  
  if (!hasLocalChanges && !hasRemoteChanges) {
    return SyncStatus.SYNCED;
  }
  if (hasLocalChanges && !hasRemoteChanges) {
    return SyncStatus.LOCAL_AHEAD;
  }
  if (!hasLocalChanges && hasRemoteChanges) {
    return SyncStatus.REMOTE_AHEAD;
  }
  return SyncStatus.CONFLICT;
}
```

### Automatic Conflict Resolution

CRDTs resolve most conflicts automatically:

```typescript
async function syncWithConflictResolution(
  localDoc: Loro,
  state: SyncState,
  api: {
    fetch: () => Promise<GitHubIssue>;
    update: (data: Partial<GitHubIssue>) => Promise<void>;
  }
): Promise<void> {
  const remote = await api.fetch();
  const status = checkSyncStatus(localDoc, state, remote.updated_at);
  
  switch (status) {
    case SyncStatus.SYNCED:
      // Nothing to do
      break;
      
    case SyncStatus.LOCAL_AHEAD:
      // Push local changes
      await pushToRemote(localDoc, api);
      break;
      
    case SyncStatus.REMOTE_AHEAD:
      // Pull remote changes
      await pullFromRemote(localDoc, remote);
      break;
      
    case SyncStatus.CONFLICT:
      // CRDT merge handles text/list conflicts automatically
      await pullFromRemote(localDoc, remote);
      await pushToRemote(localDoc, api);
      break;
  }
  
  // Update sync state
  state.localVersion = localDoc.export({ mode: 'update' });
  state.remoteVersion = remote.updated_at;
  state.lastSyncTime = Date.now();
}
```

### Single-Value Field Conflicts

For fields that can't be merged (state, milestone), use last-write-wins with logging:

```typescript
interface ConflictLog {
  field: string;
  localValue: any;
  remoteValue: any;
  resolvedValue: any;
  resolvedAt: string;
  strategy: 'local_wins' | 'remote_wins' | 'user_choice';
}

function resolveSingleValueConflict(
  field: string,
  localValue: any,
  remoteValue: any,
  localUpdatedAt: number,
  remoteUpdatedAt: string
): { value: any; log: ConflictLog } {
  // Default: most recent wins
  const remoteTime = new Date(remoteUpdatedAt).getTime();
  const useRemote = remoteTime > localUpdatedAt;
  
  const resolvedValue = useRemote ? remoteValue : localValue;
  
  return {
    value: resolvedValue,
    log: {
      field,
      localValue,
      remoteValue,
      resolvedValue,
      resolvedAt: new Date().toISOString(),
      strategy: useRemote ? 'remote_wins' : 'local_wins',
    },
  };
}
```

---

## Time Travel and History

### Checkout Previous Versions

```typescript
// Get all historical versions
const versions = doc.getAllChanges();

// Checkout specific version (creates detached state)
const historicalState = doc.checkout(specificFrontiers);

// Get JSON at that version
const dataAtVersion = doc.toJSON();

// Return to latest
doc.checkoutToLatest();
```

### Undo/Redo

```typescript
// Loro doesn't have built-in undo, but you can implement it:
class UndoManager {
  private history: Uint8Array[] = [];
  private future: Uint8Array[] = [];
  private doc: Loro;
  
  constructor(doc: Loro) {
    this.doc = doc;
    this.captureState();
  }
  
  captureState(): void {
    this.history.push(this.doc.export({ mode: 'snapshot' }));
    this.future = []; // Clear redo stack on new change
  }
  
  undo(): void {
    if (this.history.length <= 1) return;
    
    const current = this.history.pop()!;
    this.future.push(current);
    
    const previous = this.history[this.history.length - 1];
    this.doc.import(previous);
  }
  
  redo(): void {
    if (this.future.length === 0) return;
    
    const next = this.future.pop()!;
    this.history.push(next);
    this.doc.import(next);
  }
}
```

---

## Persistence and Storage

### File-Based Storage

```typescript
import { readFile, writeFile } from 'fs/promises';

const CRDT_DIR = '.hardcopy/crdt';

async function saveCRDT(issueNumber: number, doc: Loro): Promise<void> {
  const snapshot = doc.export({ mode: 'snapshot' });
  const path = `${CRDT_DIR}/issue-${issueNumber}.loro`;
  await writeFile(path, Buffer.from(snapshot));
}

async function loadCRDT(issueNumber: number): Promise<Loro | null> {
  const path = `${CRDT_DIR}/issue-${issueNumber}.loro`;
  try {
    const data = await readFile(path);
    const doc = new Loro();
    doc.import(new Uint8Array(data));
    return doc;
  } catch {
    return null;
  }
}
```

### Sync State Storage

```typescript
import YAML from 'yaml';

interface SyncStateFile {
  version: 1;
  issues: Record<number, {
    github_updated_at: string;
    crdt_frontiers: string; // base64 encoded
    last_sync: string;
    sync_status: SyncStatus;
  }>;
  metadata: {
    labels_etag: string;
    milestones_etag: string;
  };
}

async function loadSyncState(): Promise<SyncStateFile> {
  try {
    const content = await readFile('.hardcopy/sync-state.yaml', 'utf-8');
    return YAML.parse(content);
  } catch {
    return { version: 1, issues: {}, metadata: { labels_etag: '', milestones_etag: '' } };
  }
}

async function saveSyncState(state: SyncStateFile): Promise<void> {
  await writeFile('.hardcopy/sync-state.yaml', YAML.stringify(state));
}
```

---

## Generic Sync Plugin Architecture

### Base Types

```typescript
// Generic item that can be synced
interface SyncableItem {
  id: string;
  updatedAt: string;
  data: unknown;
}

// Generic sync adapter
interface SyncAdapter<T extends SyncableItem> {
  name: string;
  
  // API operations
  fetchAll(): AsyncGenerator<T>;
  fetchOne(id: string): Promise<T>;
  create(item: Omit<T, 'id' | 'updatedAt'>): Promise<T>;
  update(id: string, updates: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  
  // CRDT conversion
  toCRDT(item: T): Loro;
  fromCRDT(doc: Loro): Partial<T>;
  
  // File format
  toFile(item: T, doc: Loro): string;
  fromFile(content: string): { item: Partial<T>; doc: Loro };
}
```

### Example Adapters

```typescript
// GitHub Issues Adapter
class GitHubIssuesAdapter implements SyncAdapter<GitHubIssue> {
  name = 'github-issues';
  
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string
  ) {}
  
  async *fetchAll() {
    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.issues.listForRepo,
      { owner: this.owner, repo: this.repo, state: 'all', per_page: 100 }
    )) {
      for (const issue of response.data) {
        yield issue as GitHubIssue;
      }
    }
  }
  
  // ... other methods
}

// Figma Comments Adapter (example of extending to other services)
class FigmaCommentsAdapter implements SyncAdapter<FigmaComment> {
  name = 'figma-comments';
  
  constructor(private fileKey: string, private token: string) {}
  
  async *fetchAll() {
    const response = await fetch(
      `https://api.figma.com/v1/files/${this.fileKey}/comments`,
      { headers: { 'X-Figma-Token': this.token } }
    );
    const data = await response.json();
    yield* data.comments;
  }
  
  // ... other methods
}
```

---

## Performance Considerations

### Batching Updates

```typescript
// Don't commit after every change
function batchedUpdate(doc: Loro, operations: () => void): void {
  // Run all operations
  operations();
  
  // Single commit at the end
  doc.commit();
}

// Usage
batchedUpdate(doc, () => {
  text.insert(0, 'Hello ');
  text.insert(6, 'World');
  list.push('item1');
  list.push('item2');
});
```

### Lazy Loading

```typescript
// Don't load all CRDTs into memory at once
class LazyDocStore {
  private cache = new Map<string, Loro>();
  
  async get(key: string): Promise<Loro> {
    if (!this.cache.has(key)) {
      const doc = await loadCRDT(key);
      this.cache.set(key, doc || new Loro());
    }
    return this.cache.get(key)!;
  }
  
  async save(key: string): Promise<void> {
    const doc = this.cache.get(key);
    if (doc) {
      await saveCRDT(key, doc);
    }
  }
  
  evict(key: string): void {
    this.cache.delete(key);
  }
}
```

### Delta Compression

```typescript
// Only store incremental updates after initial sync
class DeltaStorage {
  private baseSnapshots = new Map<string, Uint8Array>();
  private deltas = new Map<string, Uint8Array[]>();
  
  async save(key: string, doc: Loro, isInitialSync: boolean): Promise<void> {
    if (isInitialSync) {
      this.baseSnapshots.set(key, doc.export({ mode: 'snapshot' }));
      this.deltas.set(key, []);
    } else {
      const base = this.baseSnapshots.get(key)!;
      const delta = doc.export({ mode: 'update', from: base });
      this.deltas.get(key)!.push(delta);
    }
  }
  
  async load(key: string): Promise<Loro> {
    const doc = new Loro();
    doc.import(this.baseSnapshots.get(key)!);
    for (const delta of this.deltas.get(key)!) {
      doc.import(delta);
    }
    return doc;
  }
}
```

---

## Testing Sync Logic

### Simulating Concurrent Edits

```typescript
import { describe, it, expect } from 'vitest';

describe('CRDT sync', () => {
  it('merges concurrent text edits', () => {
    // Create two replicas
    const doc1 = new Loro();
    const doc2 = new Loro();
    
    // Set peer IDs
    doc1.setPeerId(1n);
    doc2.setPeerId(2n);
    
    // Initial sync
    const text1 = doc1.getText('title');
    text1.insert(0, 'Hello World');
    doc1.commit();
    doc2.import(doc1.export({ mode: 'snapshot' }));
    
    // Concurrent edits
    doc1.getText('title').insert(5, ' Beautiful');  // "Hello Beautiful World"
    doc2.getText('title').insert(11, '!');          // "Hello World!"
    doc1.commit();
    doc2.commit();
    
    // Merge
    const updates1 = doc1.export({ mode: 'update' });
    const updates2 = doc2.export({ mode: 'update' });
    doc1.import(updates2);
    doc2.import(updates1);
    
    // Both should converge to same value
    expect(doc1.toJSON().title).toBe(doc2.toJSON().title);
    // Result: "Hello Beautiful World!" (both edits preserved)
  });
});
```

---

## Error Recovery

### Handling Corrupted State

```typescript
async function recoverFromCorruption(issueNumber: number): Promise<Loro> {
  // Try to load existing CRDT
  const existing = await loadCRDT(issueNumber);
  
  if (existing) {
    try {
      // Validate by exporting
      existing.export({ mode: 'snapshot' });
      return existing;
    } catch (e) {
      console.warn(`Corrupted CRDT for issue ${issueNumber}, rebuilding...`);
    }
  }
  
  // Rebuild from remote
  const issue = await fetchIssueFromGitHub(issueNumber);
  const doc = new Loro();
  initFromGitHub(doc, issue);
  await saveCRDT(issueNumber, doc);
  
  return doc;
}
```

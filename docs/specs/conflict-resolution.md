# Conflict Resolution

## Problem Statement

Current `push` command compares local file against cached DB state, ignoring concurrent remote changes. This causes silent overwrites.

### Example Scenario

```
Last Sync:    "Pictures of: Jacob Steve Gramins"
Local Edit:   "Pictures of:\n- Jacob Steve Gramins"  (added bullet)
Remote Edit:  "**Pictures of**: Jacob Steve Gramins" (added bold)
Push Result:  Remote gets local version, remote edit lost
```

Both edits had semantic intent that should be preserved. Neither user wanted to lose the other's change.

---

## Core Issue: Three-Way State Problem

Push currently performs two-way diff:
```
Local File  →  compare  ←  DB Cache (last synced state)
```

Should perform three-way diff:
```
                    DB Cache (base)
                        ↑
                   /         \
            Local File    Remote Current
```

Changes:
1. Fetch remote state before push
2. Detect divergence from common base
3. Decide resolution strategy

---

## CRDT Limitations

CRDTs (Loro) work well when:
- Both sides use CRDT operations
- We control edit granularity

Here, we don't control remote inputs:
- GitHub UI sends full text replacements
- We receive before/after strings, not ops
- Character-level merge loses semantic intent

**Example Failure**:
```
Base:   "Task: Fix bug"
Local:  "Task: Fix critical bug"    (added "critical")
Remote: "Task: Fix the bug"         (added "the")
CRDT:   "Task: Fix criticalthe bug" (nonsense merge)
```

CRDT is appropriate for:
- List operations (labels, assignees)
- Key-value fields (state, milestone)
- Concurrent local edits (multiple files)

Not ideal for:
- Free-text body merges from external sources
- Semantic conflict detection

---

## Semantic Diff Alternative

[diffsitter](https://github.com/afnanenayet/diffsitter) uses tree-sitter for AST-level diffs.

**Pros**:
- Understands structural changes
- Better signal-to-noise ratio
- Language-aware (code, markdown)

**Cons**:
- Markdown AST is shallow (less helpful)
- Adds tree-sitter dependency
- Still doesn't resolve semantic conflicts

**Verdict**: Useful for display/debugging, not primary merge strategy.

---

## Proposed Design

### Phase 1: Conflict Detection

Modify `push` to fetch remote before comparing.

```typescript
interface SyncState {
  base: string;       // DB cache (last sync)
  local: string;      // Current file
  remote: string;     // Fetched remote
}

enum ConflictStatus {
  CLEAN,              // local changed, remote unchanged
  REMOTE_ONLY,        // remote changed, local unchanged
  DIVERGED,           // both changed (conflict)
}

function detectConflict(state: SyncState): ConflictStatus {
  const localChanged = state.local !== state.base;
  const remoteChanged = state.remote !== state.base;
  
  if (!localChanged && !remoteChanged) return ConflictStatus.CLEAN;
  if (localChanged && !remoteChanged) return ConflictStatus.CLEAN;
  if (!localChanged && remoteChanged) return ConflictStatus.REMOTE_ONLY;
  return ConflictStatus.DIVERGED;
}
```

### Phase 2: Resolution Strategies

```typescript
type ResolutionStrategy = 
  | 'auto-merge'      // compatible changes, merge
  | 'local-wins'      // user flag: --force
  | 'remote-wins'     // discard local
  | 'manual'          // write conflict markers
  | 'prompt'          // interactive resolution
```

**Auto-merge** (when possible):
- Changes don't overlap
- Different fields changed
- Additive operations (both add labels)

**Manual** (fallback):
- Write conflict file to `.hardcopy/conflicts/`
- Block push until resolved
- Show in `hardcopy status`

### Phase 3: Conflict Markers

For diverged text fields, generate diff3-style markers:

```markdown
<<<<<<< LOCAL
Pictures of:
- Jacob Steve Gramins
||||||| BASE
Pictures of: Jacob Steve Gramins
=======
**Pictures of**: Jacob Steve Gramins
>>>>>>> REMOTE
```

Store in `.hardcopy/conflicts/{nodeId}.md` with metadata.

### Phase 4: CLI Integration

```bash
hardcopy push [pattern]          # fails on conflict
hardcopy push --force [pattern]  # local-wins
hardcopy push --sync [pattern]   # fetch, then push
hardcopy conflicts               # list conflicts
hardcopy resolve <nodeId>        # interactive resolution
```

---

## Implementation Steps

### Step 1: Remote Fetch Before Push

```typescript
async push(pattern?: string): Promise<PushStats> {
  const diffs = await this.diff(pattern);
  
  for (const diff of diffs) {
    // NEW: fetch current remote state
    const remote = await provider.fetch({ nodeId: diff.nodeId });
    const base = await db.getNode(diff.nodeId);
    
    const status = detectConflict({
      base: base.attrs.body,
      local: diff.changes.find(c => c.field === 'body')?.newValue,
      remote: remote.attrs.body,
    });
    
    if (status === ConflictStatus.DIVERGED) {
      await this.writeConflict(diff.nodeId, { base, local, remote });
      stats.conflicts++;
      continue;
    }
    
    // ... existing push logic
  }
}
```

### Step 2: Provider Interface Update

```typescript
interface Provider {
  // Existing
  fetch(request: FetchRequest): Promise<FetchResult>;
  push(node: Node, changes: Change[]): Promise<PushResult>;
  
  // New: single-node fetch for conflict check
  fetchNode(nodeId: string): Promise<Node | null>;
}
```

### Step 3: Conflict Storage

```
.hardcopy/
├── db.sqlite
├── crdt/
└── conflicts/
    └── github:owner:repo#42.md
```

Conflict file format:
```yaml
---
nodeId: github:owner/repo#42
type: github.Issue
field: body
detectedAt: 2026-02-21T10:30:00Z
---
<<<<<<< LOCAL
...
```

### Step 4: Status Integration

```bash
$ hardcopy status
Conflicts:
  (use "hardcopy resolve <id>" to resolve)

        conflict:   github:owner/repo#42 (body)

Changes not pushed:
  ...
```

---

## Alternative: Operational Transform

If we controlled both ends, OT would work:
```
local ops:  INSERT(10, "critical ")
remote ops: INSERT(6, "the ")
transform:  INSERT(10 + len("the "), "critical ")
```

Not viable here—we only get resulting text from remote.

---

## Decision Matrix

| Approach | Pros | Cons | Use When |
|----------|------|------|----------|
| CRDT | Auto-merge, offline-first | Semantic blindness | Lists, metadata |
| Semantic diff | Structural awareness | Doesn't resolve | Debug, display |
| Three-way diff | Standard, familiar | Manual resolution | Text conflicts |
| LLM resolution | Understands intent | Cost, latency | Complex conflicts |

**Recommendation**: Hybrid approach
1. Three-way diff for detection
2. CRDT for compatible merges (lists, maps)
3. Conflict markers + manual for text divergence
4. Optional LLM for suggested resolution

---

## Milestones

- [ ] Add `fetchNode` to provider interface
- [ ] Implement three-way conflict detection in `push`
- [ ] Create `.hardcopy/conflicts/` storage
- [ ] Add `hardcopy conflicts` command
- [ ] Add `hardcopy resolve` command
- [ ] Update `hardcopy status` to show conflicts
- [ ] Add `--force` flag for local-wins
- [ ] Document conflict resolution workflow

---

# Technical Implementation Plan

## Overview

Implement hybrid conflict resolution:
1. **Three-way diff** for conflict detection
2. **CRDT** for list/map fields (labels, assignees, metadata)
3. **Conflict markers** for text field divergence
4. **CLI commands** for conflict management

---

## Task 1: Types and Interfaces

**File**: `src/types.ts` (create if needed, or add to existing)

```typescript
// Conflict detection
export enum ConflictStatus {
  CLEAN = 'clean',           // No conflict, safe to push
  REMOTE_ONLY = 'remote',    // Remote changed, local unchanged
  DIVERGED = 'diverged',     // Both changed, conflict
}

export interface ThreeWayState {
  base: unknown;    // DB cached value (last sync)
  local: unknown;   // Current file value
  remote: unknown;  // Fetched remote value
}

export interface FieldConflict {
  field: string;
  status: ConflictStatus;
  base: unknown;
  local: unknown;
  remote: unknown;
  canAutoMerge: boolean;  // true for lists, false for text
}

export interface ConflictInfo {
  nodeId: string;
  nodeType: string;
  filePath: string;
  detectedAt: number;
  fields: FieldConflict[];
}

// Extended push stats
export interface PushStats {
  pushed: number;
  skipped: number;
  conflicts: number;  // NEW
  errors: string[];
}
```

---

## Task 2: Provider Interface Extension

**File**: `src/provider.ts`

Add `fetchNode` method to Provider interface:

```typescript
interface Provider {
  name: string;
  nodeTypes: string[];
  edgeTypes: string[];
  
  fetch(request: FetchRequest): Promise<FetchResult>;
  push(node: Node, changes: Change[]): Promise<PushResult>;
  
  // NEW: Fetch single node for conflict detection
  // Returns null if node doesn't exist remotely
  fetchNode(nodeId: string): Promise<Node | null>;
}
```

**Implementation for GitHub provider** (`src/providers/github.ts`):

```typescript
async fetchNode(nodeId: string): Promise<Node | null> {
  // nodeId format: "github:owner/repo#123"
  const match = nodeId.match(/^github:([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) return null;
  
  const [, owner, repo, number] = match;
  
  try {
    const response = await this.octokit.issues.get({
      owner,
      repo,
      issue_number: parseInt(number, 10),
    });
    
    return this.issueToNode(response.data);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
```

---

## Task 3: Conflict Detection Module

**File**: `src/conflict.ts` (new file)

```typescript
import { FieldConflict, ConflictStatus, ThreeWayState, ConflictInfo } from './types';
import { Node, Change } from './provider';

/**
 * Detect conflict status for a single field
 */
export function detectFieldConflict(
  field: string,
  state: ThreeWayState,
): FieldConflict {
  const localChanged = !valuesEqual(state.local, state.base);
  const remoteChanged = !valuesEqual(state.remote, state.base);
  
  let status: ConflictStatus;
  if (!localChanged && !remoteChanged) {
    status = ConflictStatus.CLEAN;
  } else if (localChanged && !remoteChanged) {
    status = ConflictStatus.CLEAN;
  } else if (!localChanged && remoteChanged) {
    status = ConflictStatus.REMOTE_ONLY;
  } else {
    // Both changed - check if they changed to same value
    status = valuesEqual(state.local, state.remote)
      ? ConflictStatus.CLEAN
      : ConflictStatus.DIVERGED;
  }
  
  return {
    field,
    status,
    base: state.base,
    local: state.local,
    remote: state.remote,
    canAutoMerge: isListField(field),
  };
}

/**
 * List fields can be auto-merged via CRDT
 */
function isListField(field: string): boolean {
  return ['labels', 'assignees'].includes(field);
}

/**
 * Deep equality check
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => valuesEqual(v, sortedB[i]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Detect conflicts for all editable fields
 */
export function detectConflicts(
  baseNode: Node,
  localParsed: { attrs: Record<string, unknown>; body: string },
  remoteNode: Node,
  editableFields: string[],
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  const baseAttrs = baseNode.attrs as Record<string, unknown>;
  const remoteAttrs = remoteNode.attrs as Record<string, unknown>;
  
  for (const field of editableFields) {
    const state: ThreeWayState = {
      base: field === 'body' ? baseAttrs.body : baseAttrs[field],
      local: field === 'body' ? localParsed.body : localParsed.attrs[field],
      remote: field === 'body' ? remoteAttrs.body : remoteAttrs[field],
    };
    
    const conflict = detectFieldConflict(field, state);
    if (conflict.status !== ConflictStatus.CLEAN) {
      conflicts.push(conflict);
    }
  }
  
  return conflicts;
}

/**
 * Check if any conflicts require manual resolution
 */
export function hasUnresolvableConflicts(conflicts: FieldConflict[]): boolean {
  return conflicts.some(c => 
    c.status === ConflictStatus.DIVERGED && !c.canAutoMerge
  );
}

/**
 * Auto-merge list fields using set union
 * Returns merged value for lists, null for non-mergeable
 */
export function autoMergeField(conflict: FieldConflict): unknown | null {
  if (!conflict.canAutoMerge || conflict.status !== ConflictStatus.DIVERGED) {
    return null;
  }
  
  // Set union for lists
  const baseSet = new Set(conflict.base as unknown[] ?? []);
  const localAdded = (conflict.local as unknown[] ?? []).filter(v => !baseSet.has(v));
  const remoteAdded = (conflict.remote as unknown[] ?? []).filter(v => !baseSet.has(v));
  
  // Union: keep all from base, add new from both
  const merged = [...baseSet, ...localAdded, ...remoteAdded];
  return [...new Set(merged)]; // dedupe
}

/**
 * Generate diff3-style conflict markers for text
 */
export function generateConflictMarkers(conflict: FieldConflict): string {
  const local = String(conflict.local ?? '');
  const base = String(conflict.base ?? '');
  const remote = String(conflict.remote ?? '');
  
  return `<<<<<<< LOCAL
${local}
||||||| BASE
${base}
=======
${remote}
>>>>>>> REMOTE`;
}
```

---

## Task 4: Conflict Storage

**File**: `src/conflict-store.ts` (new file)

```typescript
import { mkdir, writeFile, readFile, readdir, unlink } from 'fs/promises';
import { join, basename } from 'path';
import { ConflictInfo, FieldConflict } from './types';
import { generateConflictMarkers } from './conflict';

export class ConflictStore {
  private conflictsDir: string;
  
  constructor(hardcopyDir: string) {
    this.conflictsDir = join(hardcopyDir, 'conflicts');
  }
  
  async initialize(): Promise<void> {
    await mkdir(this.conflictsDir, { recursive: true });
  }
  
  /**
   * Write conflict to file
   * Filename: sanitized nodeId + .conflict.md
   */
  async write(info: ConflictInfo): Promise<string> {
    const filename = this.nodeIdToFilename(info.nodeId);
    const filepath = join(this.conflictsDir, filename);
    
    const content = this.formatConflict(info);
    await writeFile(filepath, content, 'utf-8');
    
    return filepath;
  }
  
  /**
   * List all conflicts
   */
  async list(): Promise<ConflictInfo[]> {
    try {
      const files = await readdir(this.conflictsDir);
      const conflicts: ConflictInfo[] = [];
      
      for (const file of files) {
        if (!file.endsWith('.conflict.md')) continue;
        const content = await readFile(join(this.conflictsDir, file), 'utf-8');
        const info = this.parseConflict(content);
        if (info) conflicts.push(info);
      }
      
      return conflicts;
    } catch {
      return [];
    }
  }
  
  /**
   * Get specific conflict
   */
  async get(nodeId: string): Promise<ConflictInfo | null> {
    const filename = this.nodeIdToFilename(nodeId);
    const filepath = join(this.conflictsDir, filename);
    
    try {
      const content = await readFile(filepath, 'utf-8');
      return this.parseConflict(content);
    } catch {
      return null;
    }
  }
  
  /**
   * Delete conflict (after resolution)
   */
  async delete(nodeId: string): Promise<void> {
    const filename = this.nodeIdToFilename(nodeId);
    const filepath = join(this.conflictsDir, filename);
    
    try {
      await unlink(filepath);
    } catch {
      // Ignore if doesn't exist
    }
  }
  
  /**
   * Check if node has unresolved conflict
   */
  async has(nodeId: string): Promise<boolean> {
    const conflict = await this.get(nodeId);
    return conflict !== null;
  }
  
  private nodeIdToFilename(nodeId: string): string {
    // Sanitize: github:owner/repo#42 -> github_owner_repo_42.conflict.md
    return nodeId.replace(/[:/# ]/g, '_') + '.conflict.md';
  }
  
  private formatConflict(info: ConflictInfo): string {
    const frontmatter = [
      '---',
      `nodeId: "${info.nodeId}"`,
      `type: ${info.nodeType}`,
      `filePath: "${info.filePath}"`,
      `detectedAt: ${new Date(info.detectedAt).toISOString()}`,
      `fields: [${info.fields.map(f => `"${f.field}"`).join(', ')}]`,
      '---',
      '',
    ].join('\n');
    
    const sections = info.fields
      .filter(f => f.status === 'diverged')
      .map(f => `## ${f.field}\n\n${generateConflictMarkers(f)}`)
      .join('\n\n');
    
    return frontmatter + sections;
  }
  
  private parseConflict(content: string): ConflictInfo | null {
    // Parse YAML frontmatter
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    
    const frontmatter = match[1];
    const nodeIdMatch = frontmatter.match(/nodeId:\s*"([^"]+)"/);
    const typeMatch = frontmatter.match(/type:\s*(\S+)/);
    const filePathMatch = frontmatter.match(/filePath:\s*"([^"]+)"/);
    const detectedAtMatch = frontmatter.match(/detectedAt:\s*(\S+)/);
    const fieldsMatch = frontmatter.match(/fields:\s*\[(.*?)\]/);
    
    if (!nodeIdMatch) return null;
    
    return {
      nodeId: nodeIdMatch[1],
      nodeType: typeMatch?.[1] ?? 'unknown',
      filePath: filePathMatch?.[1] ?? '',
      detectedAt: detectedAtMatch ? new Date(detectedAtMatch[1]).getTime() : Date.now(),
      fields: [], // Full parsing would require parsing the body sections
    };
  }
}
```

---

## Task 5: Update Push Logic

**File**: `src/hardcopy.ts`

Modify the `push` method to integrate conflict detection:

```typescript
import { detectConflicts, hasUnresolvableConflicts, autoMergeField } from './conflict';
import { ConflictStore } from './conflict-store';
import { ConflictInfo, ConflictStatus } from './types';

// Add to Hardcopy class:
private conflictStore: ConflictStore | null = null;

private getConflictStore(): ConflictStore {
  if (!this.conflictStore) {
    this.conflictStore = new ConflictStore(join(this.root, '.hardcopy'));
  }
  return this.conflictStore;
}

// Replace push method:
async push(filePath?: string, options: { force?: boolean } = {}): Promise<PushStats> {
  const config = await this.loadConfig();
  const db = this.getDatabase();
  const crdt = this.getCRDTStore();
  const conflictStore = this.getConflictStore();
  await conflictStore.initialize();
  
  const stats: PushStats = { pushed: 0, skipped: 0, conflicts: 0, errors: [] };
  const diffs = await this.diff(filePath);

  for (const diff of diffs) {
    if (diff.changes.length === 0) {
      stats.skipped++;
      continue;
    }

    const provider = this.findProviderForNode(diff.nodeId);
    if (!provider) {
      stats.errors.push(`No provider for ${diff.nodeId}`);
      continue;
    }

    const dbNode = await db.getNode(diff.nodeId);
    if (!dbNode) {
      stats.errors.push(`Node not found: ${diff.nodeId}`);
      continue;
    }

    // Check for existing unresolved conflict
    if (await conflictStore.has(diff.nodeId)) {
      stats.errors.push(`Unresolved conflict for ${diff.nodeId}. Run 'hardcopy resolve' first.`);
      stats.conflicts++;
      continue;
    }

    try {
      // FETCH REMOTE STATE
      const remoteNode = await provider.fetchNode(diff.nodeId);
      if (!remoteNode) {
        stats.errors.push(`Remote node not found: ${diff.nodeId}`);
        continue;
      }

      // DETECT CONFLICTS
      const format = getFormat(dbNode.type);
      if (!format) {
        stats.errors.push(`Unknown format: ${dbNode.type}`);
        continue;
      }

      // Parse local file for comparison
      const localContent = await readFile(diff.filePath, 'utf-8');
      const localParsed = parseFile(localContent, 'generic');

      const fieldConflicts = detectConflicts(
        dbNode,
        localParsed,
        remoteNode,
        format.editableFields,
      );

      // Handle conflicts
      if (fieldConflicts.length > 0) {
        if (options.force) {
          // Force mode: local wins, skip conflict handling
          console.log(`Forcing push for ${diff.nodeId} (local-wins)`);
        } else if (hasUnresolvableConflicts(fieldConflicts)) {
          // Unresolvable conflict: write conflict file, skip push
          const conflictInfo: ConflictInfo = {
            nodeId: diff.nodeId,
            nodeType: dbNode.type,
            filePath: diff.filePath,
            detectedAt: Date.now(),
            fields: fieldConflicts,
          };
          await conflictStore.write(conflictInfo);
          console.log(`Conflict detected for ${diff.nodeId}. Run 'hardcopy conflicts' to view.`);
          stats.conflicts++;
          continue;
        } else {
          // All conflicts are auto-mergeable (lists)
          for (const conflict of fieldConflicts) {
            const merged = autoMergeField(conflict);
            if (merged !== null) {
              // Update the change with merged value
              const change = diff.changes.find(c => c.field === conflict.field);
              if (change) {
                change.newValue = merged;
              }
            }
          }
        }
      }

      // PUSH
      const result = await provider.push(dbNode, diff.changes);
      if (result.success) {
        // Update local node with changes
        const updatedAttrs = { ...dbNode.attrs };
        for (const change of diff.changes) {
          updatedAttrs[change.field] = change.newValue;
        }
        await db.upsertNode({
          ...dbNode,
          attrs: updatedAttrs,
          syncedAt: Date.now(),
        });

        // Update CRDT
        const doc = await crdt.loadOrCreate(diff.nodeId);
        if (format) {
          const bodyChange = diff.changes.find((c) => c.field === 'body');
          if (bodyChange) {
            setDocContent(doc, bodyChange.newValue as string);
          }
        }
        await crdt.save(diff.nodeId, doc);

        // Clear any resolved conflict
        await conflictStore.delete(diff.nodeId);

        stats.pushed++;
      } else {
        stats.errors.push(`Push failed for ${diff.nodeId}: ${result.error}`);
      }
    } catch (err) {
      stats.errors.push(`Error pushing ${diff.nodeId}: ${err}`);
    }
  }

  return stats;
}
```

---

## Task 6: CLI Commands

**File**: `src/cli.ts`

### Update push command:

```typescript
program
  .command('push [pattern]')
  .description('Push local changes to remotes (supports glob patterns)')
  .option('--dry-run', 'Show what would be pushed without actually pushing')
  .option('--force', 'Force push, overwriting remote changes (local-wins)')
  .action(async (pattern?: string, options?: { dryRun?: boolean; force?: boolean }) => {
    const hc = new Hardcopy({ root: process.cwd() });
    await hc.initialize();
    try {
      await hc.loadConfig();

      if (options?.dryRun) {
        // ... existing dry-run logic
      }

      const stats = await hc.push(pattern, { force: options?.force });
      
      console.log(`Pushed ${stats.pushed} changes, skipped ${stats.skipped}`);
      
      if (stats.conflicts > 0) {
        console.log(`\n${stats.conflicts} conflict(s) detected.`);
        console.log('  (use "hardcopy conflicts" to view)');
        console.log('  (use "hardcopy push --force" to override)');
      }
      
      if (stats.errors.length > 0) {
        console.error('Errors:');
        for (const err of stats.errors) {
          console.error(`  ${err}`);
        }
      }
    } finally {
      await hc.close();
    }
  });
```

### Add conflicts command:

```typescript
program
  .command('conflicts')
  .description('List unresolved conflicts')
  .action(async () => {
    const hc = new Hardcopy({ root: process.cwd() });
    await hc.initialize();
    try {
      const conflicts = await hc.listConflicts();
      
      if (conflicts.length === 0) {
        console.log('No conflicts.');
        return;
      }
      
      console.log('Unresolved conflicts:\n');
      console.log('  (use "hardcopy resolve <nodeId>" to resolve)');
      console.log('  (use "hardcopy push --force" to override with local)\n');
      
      for (const conflict of conflicts) {
        const fields = conflict.fields.map(f => f.field).join(', ');
        console.log(`        ${conflict.nodeId}`);
        console.log(`          fields: ${fields}`);
        console.log(`          file:   ${conflict.filePath}`);
        console.log();
      }
    } finally {
      await hc.close();
    }
  });
```

### Add resolve command:

```typescript
program
  .command('resolve <nodeId>')
  .description('Resolve a conflict')
  .option('--local', 'Accept local version')
  .option('--remote', 'Accept remote version')
  .option('--show', 'Show conflict details without resolving')
  .action(async (nodeId: string, options?: { local?: boolean; remote?: boolean; show?: boolean }) => {
    const hc = new Hardcopy({ root: process.cwd() });
    await hc.initialize();
    try {
      const conflict = await hc.getConflict(nodeId);
      
      if (!conflict) {
        console.log(`No conflict found for ${nodeId}`);
        return;
      }
      
      if (options?.show) {
        // Display conflict details
        console.log(`Conflict: ${conflict.nodeId}`);
        console.log(`Type: ${conflict.nodeType}`);
        console.log(`File: ${conflict.filePath}`);
        console.log(`Detected: ${new Date(conflict.detectedAt).toISOString()}\n`);
        
        for (const field of conflict.fields) {
          console.log(`--- ${field.field} ---`);
          console.log(`Base:\n${field.base}\n`);
          console.log(`Local:\n${field.local}\n`);
          console.log(`Remote:\n${field.remote}\n`);
        }
        return;
      }
      
      if (options?.local) {
        await hc.resolveConflict(nodeId, 'local');
        console.log(`Resolved ${nodeId} with local version.`);
        console.log('Run "hardcopy push" to push changes.');
      } else if (options?.remote) {
        await hc.resolveConflict(nodeId, 'remote');
        console.log(`Resolved ${nodeId} with remote version.`);
        console.log('Local file updated.');
      } else {
        // Interactive mode (future: could prompt user)
        console.log('Specify --local or --remote to resolve, or --show to view details.');
      }
    } finally {
      await hc.close();
    }
  });
```

---

## Task 7: Hardcopy Class Methods

**File**: `src/hardcopy.ts`

Add these methods to the Hardcopy class:

```typescript
/**
 * List all unresolved conflicts
 */
async listConflicts(): Promise<ConflictInfo[]> {
  const store = this.getConflictStore();
  await store.initialize();
  return store.list();
}

/**
 * Get a specific conflict
 */
async getConflict(nodeId: string): Promise<ConflictInfo | null> {
  const store = this.getConflictStore();
  await store.initialize();
  return store.get(nodeId);
}

/**
 * Resolve a conflict
 * @param nodeId - The node with conflict
 * @param resolution - 'local' keeps local, 'remote' pulls remote
 */
async resolveConflict(
  nodeId: string,
  resolution: 'local' | 'remote',
): Promise<void> {
  const store = this.getConflictStore();
  const db = this.getDatabase();
  const conflict = await store.get(nodeId);
  
  if (!conflict) {
    throw new Error(`No conflict found for ${nodeId}`);
  }
  
  if (resolution === 'local') {
    // Local wins: just delete the conflict, push will proceed
    await store.delete(nodeId);
  } else {
    // Remote wins: update local file with remote content
    const provider = this.findProviderForNode(nodeId);
    if (!provider) {
      throw new Error(`No provider for ${nodeId}`);
    }
    
    const remoteNode = await provider.fetchNode(nodeId);
    if (!remoteNode) {
      throw new Error(`Remote node not found: ${nodeId}`);
    }
    
    // Update DB with remote
    await db.upsertNode({
      ...remoteNode,
      syncedAt: Date.now(),
    });
    
    // Re-render the file from remote
    const config = await this.loadConfig();
    for (const view of config.views) {
      if (conflict.filePath.startsWith(view.path)) {
        await this.renderNodeToFile(remoteNode, view, join(this.root, view.path));
        break;
      }
    }
    
    // Delete conflict
    await store.delete(nodeId);
  }
}
```

---

## Task 8: Update Status Command

**File**: `src/cli.ts`

Modify status to show conflicts:

```typescript
.action(async (options: { short?: boolean }) => {
  const hc = new Hardcopy({ root: process.cwd() });
  await hc.initialize();
  try {
    await hc.loadConfig();
    const status = await hc.status();
    const conflicts = await hc.listConflicts();

    if (options.short) {
      // Git-like short status
      for (const conflict of conflicts) {
        console.log(`C  ${conflict.filePath}`);
      }
      for (const file of status.changedFiles) {
        const marker = file.status === 'new' ? 'A' : 'M';
        console.log(`${marker}  ${file.path}`);
      }
      return;
    }

    // Full status
    if (conflicts.length > 0) {
      console.log('Conflicts:');
      console.log('  (use "hardcopy resolve <id>" to resolve)\n');
      for (const conflict of conflicts) {
        const fields = conflict.fields.map(f => f.field).join(', ');
        console.log(`        conflict:   ${conflict.nodeId} (${fields})`);
      }
      console.log();
    }

    if (status.changedFiles.length > 0) {
      console.log('Changes not pushed:');
      console.log('  (use "hardcopy push <file>" to push changes)');
      console.log('  (use "hardcopy diff <file>" to see changes)\n');
      for (const file of status.changedFiles) {
        const marker = file.status === 'new' ? 'new file:' : 'modified:';
        console.log(`        ${marker}   ${file.path}`);
      }
      console.log();
    } else if (conflicts.length === 0) {
      console.log('No local changes\n');
    }
    
    // ... rest of status
  } finally {
    await hc.close();
  }
});
```

---

## Task 9: Tests

**File**: `src/__tests__/conflict.test.ts` (new file)

```typescript
import { describe, it, expect } from 'vitest';
import {
  detectFieldConflict,
  detectConflicts,
  hasUnresolvableConflicts,
  autoMergeField,
  generateConflictMarkers,
} from '../conflict';
import { ConflictStatus } from '../types';

describe('detectFieldConflict', () => {
  it('returns CLEAN when nothing changed', () => {
    const result = detectFieldConflict('body', {
      base: 'hello',
      local: 'hello',
      remote: 'hello',
    });
    expect(result.status).toBe(ConflictStatus.CLEAN);
  });

  it('returns CLEAN when only local changed', () => {
    const result = detectFieldConflict('body', {
      base: 'hello',
      local: 'hello world',
      remote: 'hello',
    });
    expect(result.status).toBe(ConflictStatus.CLEAN);
  });

  it('returns REMOTE_ONLY when only remote changed', () => {
    const result = detectFieldConflict('body', {
      base: 'hello',
      local: 'hello',
      remote: 'hello world',
    });
    expect(result.status).toBe(ConflictStatus.REMOTE_ONLY);
  });

  it('returns DIVERGED when both changed differently', () => {
    const result = detectFieldConflict('body', {
      base: 'hello',
      local: 'hello local',
      remote: 'hello remote',
    });
    expect(result.status).toBe(ConflictStatus.DIVERGED);
  });

  it('returns CLEAN when both changed to same value', () => {
    const result = detectFieldConflict('body', {
      base: 'hello',
      local: 'hello world',
      remote: 'hello world',
    });
    expect(result.status).toBe(ConflictStatus.CLEAN);
  });
});

describe('autoMergeField', () => {
  it('merges list additions from both sides', () => {
    const conflict = {
      field: 'labels',
      status: ConflictStatus.DIVERGED,
      base: ['bug'],
      local: ['bug', 'urgent'],
      remote: ['bug', 'help-wanted'],
      canAutoMerge: true,
    };
    const result = autoMergeField(conflict);
    expect(result).toEqual(expect.arrayContaining(['bug', 'urgent', 'help-wanted']));
  });

  it('returns null for non-mergeable fields', () => {
    const conflict = {
      field: 'body',
      status: ConflictStatus.DIVERGED,
      base: 'hello',
      local: 'hello local',
      remote: 'hello remote',
      canAutoMerge: false,
    };
    expect(autoMergeField(conflict)).toBeNull();
  });
});

describe('generateConflictMarkers', () => {
  it('generates diff3-style markers', () => {
    const conflict = {
      field: 'body',
      status: ConflictStatus.DIVERGED,
      base: 'base text',
      local: 'local text',
      remote: 'remote text',
      canAutoMerge: false,
    };
    const result = generateConflictMarkers(conflict);
    expect(result).toContain('<<<<<<< LOCAL');
    expect(result).toContain('local text');
    expect(result).toContain('||||||| BASE');
    expect(result).toContain('base text');
    expect(result).toContain('=======');
    expect(result).toContain('remote text');
    expect(result).toContain('>>>>>>> REMOTE');
  });
});
```

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/types.ts` | Create/Update | Add ConflictStatus, FieldConflict, ConflictInfo types |
| `src/provider.ts` | Update | Add `fetchNode` to Provider interface |
| `src/providers/github.ts` | Update | Implement `fetchNode` |
| `src/conflict.ts` | Create | Core conflict detection and merge logic |
| `src/conflict-store.ts` | Create | File-based conflict storage |
| `src/hardcopy.ts` | Update | Integrate conflict detection into push, add resolve methods |
| `src/cli.ts` | Update | Add `conflicts`, `resolve` commands; update `status`, `push` |
| `src/__tests__/conflict.test.ts` | Create | Unit tests |

---

## Execution Order

1. **Types** (zero dependencies)
2. **Conflict module** (depends on types)
3. **Conflict store** (depends on types, conflict)
4. **Provider interface** (zero dependencies)
5. **GitHub provider** (depends on provider interface)
6. **Hardcopy class** (depends on all above)
7. **CLI commands** (depends on hardcopy class)
8. **Tests** (parallel with above)
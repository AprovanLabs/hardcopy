# Hardcopy + Patchwork: Filesystem as Interface

Hardcopy and Patchwork are **independent tools** that don't reference each other. They integrate via the filesystem—the universal interface.

---

## Core Principle

```
┌──────────────────────────────────────────────────────────────────────┐
│                     The Filesystem IS the Interface                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌─────────────┐                              ┌─────────────┐       │
│   │  Patchwork  │                              │  Hardcopy   │       │
│   │  (browser)  │                              │  (CLI/bg)   │       │
│   └──────┬──────┘                              └──────┬──────┘       │
│          │                                           │               │
│          │         ┌─────────────────────┐           │               │
│          └────────►│   Local Directory   │◄──────────┘               │
│                    │   ~/project/docs/   │                           │
│                    └─────────────────────┘                           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**No shared code. No direct APIs. No bespoke protocols.**

Both tools read and write files. That's how they communicate.

---

## How They Work Together

### Scenario: Editing GitHub Issues Locally

```
1. User runs:           hardcopy sync && hardcopy refresh docs/issues
2. Hardcopy creates:    ~/project/docs/issues/42.md (from GitHub API)
3. User opens:          Patchwork, pointed at ~/project/
4. User edits:          42.md via Patchwork's Monaco editor
5. Patchwork saves:     ~/project/docs/issues/42.md (local file)
6. User runs:           hardcopy push docs/issues/42.md
7. Hardcopy pushes:     Changes to GitHub API
```

At no point do Patchwork and Hardcopy talk to each other. They both talk to files.

### File Watching

Both tools can watch for file changes using **standard OS mechanisms**:

| Tool | Watch Method | Standard |
|------|--------------|----------|
| Patchwork (Node/stitchery) | `fs.watch()` | Node.js |
| Patchwork (browser) | Polling / HTTP `If-Modified-Since` | HTTP |
| Hardcopy | `fs.watch()` or `chokidar` | Node.js |

No custom event streams. No Hardcopy-specific SSE. Standard file watching.

---

## Responsibility Split

| Concern | Patchwork | Hardcopy | Shared |
|---------|-----------|----------|--------|
| File editing UI | ✓ | - | - |
| File compilation/preview | ✓ | - | - |
| LLM-driven file edits | ✓ | - | - |
| Conflict resolution UI | ✓ (local-wins) | - | - |
| Remote API sync | - | ✓ | - |
| Three-way merge | - | ✓ | - |
| CRDT state tracking | - | ✓ | - |
| LLM conflict resolution | - | ✓ | - |
| File watching | ✓ | ✓ | via OS |
| **File read/write** | ✓ | ✓ | **Filesystem** |

---

## Conflict Handling

### Patchwork's Approach

Patchwork is **local-first**. When syncing with a backend:

```typescript
// Patchwork conflict strategy (default)
conflictStrategy: 'local-wins'
```

Patchwork does NOT:
- Know about three-way merges
- Know about remote APIs
- Know about Hardcopy

If the user wants advanced conflict resolution, they run Hardcopy separately.

### Hardcopy's Approach

Hardcopy handles conflicts when syncing with remote APIs:

1. **Auto-merge** - List fields (labels, assignees) → union
2. **LLM-assisted** - Body content with divergent changes → LLM merge
3. **Manual** - Creates conflict artifact file with markers

The conflict artifact is just a file:

```markdown
---
nodeId: github:AprovanLabs/core/issues/42
conflict: true
---

## body

<<<<<<< LOCAL
I changed this line locally
||||||| BASE
Original content
=======
Someone else changed this remotely
>>>>>>> REMOTE
```

Patchwork might display this file. It doesn't know it's a "conflict file"—it's just markdown with a specific format.

---

## MCP Server (Optional)

If Hardcopy tools need to be available to LLMs in Patchwork's chat interface, Hardcopy can expose an **MCP server**:

```yaml
# In user's MCP config for Patchwork
servers:
  hardcopy:
    command: hardcopy
    args: [mcp-serve]
```

This MCP server is **generic to Hardcopy**, not Patchwork-specific. It might expose tools like:

- `hardcopy_sync` - Sync remote sources
- `hardcopy_push` - Push local changes
- `hardcopy_status` - Show sync status
- `hardcopy_resolve_conflict` - Resolve a conflict

Patchwork's LLM can call these tools via the standard service proxy flow. Patchwork has no Hardcopy-specific code.

---

## Implementation Notes

### For Hardcopy

1. **No VFS server** - Don't build HTTP routes for Patchwork. Manage files directly.
2. **Standard file watching** - Use `fs.watch()` or `chokidar` to detect local edits.
3. **Conflict artifacts** - Write conflict files with git-style markers.
4. **MCP server (optional)** - Expose Hardcopy CLI as MCP tools for LLM integration.

### For Patchwork

1. **No Hardcopy imports** - Patchwork knows nothing about Hardcopy.
2. **Local-first** - Default to `local-wins` conflict strategy.
3. **Standard backends** - HTTP backend talks to stitchery, which reads local files.
4. **File watching** - Use standard SSE from stitchery's `/vfs?watch=path` (Node.js `fs.watch`).

### Shared Directory Setup

Both tools point at the same directory:

```bash
# Start Patchwork's stitchery server
stitchery --vfs-dir ~/project/

# Run Hardcopy in the same directory
cd ~/project/
hardcopy sync
hardcopy refresh docs/issues
```

Patchwork sees files via HTTP→stitchery→local disk.
Hardcopy manages files directly on local disk.

---

## Non-Goals

1. **Hardcopy HTTP server for Patchwork** - Not needed. Filesystem is the interface.
2. **Hardcopy SSE events for Patchwork** - Use standard file watching.
3. **Shared TypeScript interfaces** - No shared code between projects.
4. **Patchwork conflict delegation** - Patchwork doesn't know Hardcopy exists.

---

## Future Considerations

### Real-time Collaboration

If needed in the future, both tools could use **standard CRDTs** (like Yjs or Loro) with a **standard sync protocol**. But this would be:

- A separate shared library (not Hardcopy-specific)
- Based on web standards (WebRTC, WebSocket)
- Implemented independently in each tool

### Event Streaming

If cross-tool events are ever needed:

- Use filesystem events (inotify, kqueue)
- Or use a standard event bus (Redis, NATS)
- NOT a bespoke Hardcopy↔Patchwork protocol

---

## Summary

| Question | Answer |
|----------|--------|
| Does Patchwork depend on Hardcopy? | **No** |
| Does Hardcopy depend on Patchwork? | **No** |
| How do they communicate? | **Files on disk** |
| How does Patchwork detect file changes? | **Standard file watching** |
| How does Hardcopy provide LLM tools? | **MCP server (optional)** |
| What about conflicts? | **Hardcopy writes conflict files** |

**The filesystem is the interface. Keep it that way.**

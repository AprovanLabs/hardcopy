#!/usr/bin/env node

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "process";
import { minimatch } from "minimatch";
import { Hardcopy, initHardcopy } from "./hardcopy";

const program = new Command();

program
  .name("hardcopy")
  .description("Local-remote sync system")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize hardcopy in current directory")
  .action(async () => {
    const root = process.cwd();
    await initHardcopy(root);
    console.log("Initialized hardcopy at", root);
  });

program
  .command("sync")
  .description("Sync all sources")
  .action(async () => {
    const hc = new Hardcopy({ root: process.cwd() });
    await hc.initialize();
    try {
      const stats = await hc.sync();
      console.log(`Synced ${stats.nodes} nodes, ${stats.edges} edges`);
      if (stats.errors.length > 0) {
        console.error("Errors:", stats.errors.join("\n"));
      }
    } finally {
      await hc.close();
    }
  });

program
  .command("refresh <pattern>")
  .description("Refresh views matching pattern (supports glob, e.g. docs/*)")
  .option("--clean", "Remove files that no longer match the view", false)
  .option("--sync-first", "Sync data from remote before refreshing", false)
  .action(
    async (
      pattern: string,
      options: { clean: boolean; syncFirst: boolean },
    ) => {
      const hc = new Hardcopy({ root: process.cwd() });
      await hc.initialize();
      try {
        const allViews = await hc.getViews();
        const matchingViews = allViews.filter(
          (v) => v === pattern || minimatch(v, pattern),
        );

        if (matchingViews.length === 0) {
          console.error(`No views match pattern: ${pattern}`);
          console.log("Available views:", allViews.join(", "));
          process.exit(1);
        }

        if (options.syncFirst) {
          console.log("Syncing from remote...");
          const stats = await hc.sync();
          console.log(`Synced ${stats.nodes} nodes, ${stats.edges} edges`);
        }

        for (const view of matchingViews) {
          const result = await hc.refreshView(view, { clean: options.clean });
          console.log(`Refreshed view: ${view} (${result.rendered} files)`);

          if (result.orphaned.length > 0) {
            if (result.cleaned) {
              console.log(`  Cleaned ${result.orphaned.length} orphaned files`);
            } else {
              console.log(
                `  Found ${result.orphaned.length} orphaned files. ` +
                  `Use --clean to remove them:`,
              );
              for (const file of result.orphaned.slice(0, 5)) {
                console.log(`    - ${file}`);
              }
              if (result.orphaned.length > 5) {
                console.log(`    ... and ${result.orphaned.length - 5} more`);
              }
            }
          }
        }
      } finally {
        await hc.close();
      }
    },
  );

program
  .command("status")
  .description("Show sync status and changed files")
  .option("-s, --short", "Show short status (files only)")
  .action(async (options: { short?: boolean }) => {
    const hc = new Hardcopy({ root: process.cwd() });
    await hc.initialize();
    try {
      await hc.loadConfig();
      const status = await hc.status();

      if (options.short) {
        // Git-like short status
        for (const file of status.changedFiles) {
          const marker = file.status === "new" ? "A" : "M";
          console.log(`${marker}  ${file.path}`);
        }
        return;
      }

      // Full status
      if (status.changedFiles.length > 0) {
        console.log("Changes not pushed:");
        console.log('  (use "hardcopy push <file>" to push changes)');
        console.log('  (use "hardcopy diff <file>" to see changes)\n');
        for (const file of status.changedFiles) {
          const marker = file.status === "new" ? "new file:" : "modified:";
          console.log(`        ${marker}   ${file.path}`);
        }
        console.log();
      } else {
        console.log("No local changes\n");
      }

      if (status.conflicts.length > 0) {
        console.log("Conflicts:");
        console.log('  (use "hardcopy conflicts" to list details)\n');
        for (const conflict of status.conflicts) {
          const fields = conflict.fields.map((f) => f.field).join(", ");
          console.log(`        conflict:   ${conflict.nodeId} (${fields})`);
        }
        console.log();
      }

      console.log(
        `Synced: ${status.totalNodes} nodes, ${status.totalEdges} edges`,
      );
      console.log("By type:");
      for (const [type, count] of Object.entries(status.nodesByType)) {
        console.log(`  ${type}: ${count}`);
      }
    } finally {
      await hc.close();
    }
  });

program
  .command("push [pattern]")
  .description("Push local changes to remotes (supports glob patterns)")
  .option("--dry-run", "Show what would be pushed without actually pushing")
  .option("--force", "Push even if conflicts are detected", false)
  .action(
    async (
      pattern?: string,
      options?: { dryRun?: boolean; force?: boolean },
    ) => {
      const hc = new Hardcopy({ root: process.cwd() });
      await hc.initialize();
      try {
        await hc.loadConfig();

        if (options?.dryRun) {
          const diffs = await hc.diff(pattern);
          if (diffs.length === 0) {
            console.log("No changes to push");
            return;
          }
          console.log("Would push the following changes:");
          for (const diff of diffs) {
            console.log(`\n${diff.nodeId} (${diff.nodeType}):`);
            for (const change of diff.changes) {
              console.log(`  ${change.field}: ${formatChange(change)}`);
            }
          }
          return;
        }

        const stats = await hc.push(pattern, { force: options?.force });
        console.log(
          `Pushed ${stats.pushed} changes, skipped ${stats.skipped}, conflicts ${stats.conflicts}`,
        );
        if (stats.conflicts > 0) {
          const conflicts = await hc.listConflicts();
          const resolved = await resolveConflictsInteractive(
            hc,
            conflicts.map((c) => c.nodeId),
          );
          if (resolved.length > 0) {
            const retry = await hc.push(pattern, { force: options?.force });
            console.log(
              `Retry push: pushed ${retry.pushed}, skipped ${retry.skipped}, conflicts ${retry.conflicts}`,
            );
          }
        }
        if (stats.errors.length > 0) {
          console.error("Errors:");
          for (const err of stats.errors) {
            console.error(`  ${err}`);
          }
        }
      } finally {
        await hc.close();
      }
    },
  );

program
  .command("conflicts")
  .description("List unresolved conflicts")
  .action(async () => {
    const hc = new Hardcopy({ root: process.cwd() });
    await hc.initialize();
    try {
      const conflicts = await hc.listConflicts();
      if (conflicts.length === 0) {
        console.log("No conflicts");
        return;
      }
      for (const conflict of conflicts) {
        const fields = conflict.fields.map((f) => f.field).join(", ");
        console.log(`${conflict.nodeId} (${fields})`);
      }
    } finally {
      await hc.close();
    }
  });

program
  .command("resolve <nodeId>")
  .description("Resolve conflicts interactively")
  .action(async (nodeId: string) => {
    const hc = new Hardcopy({ root: process.cwd() });
    await hc.initialize();
    try {
      await resolveConflictsInteractive(hc, [nodeId]);
    } finally {
      await hc.close();
    }
  });

async function resolveConflictsInteractive(
  hc: Hardcopy,
  nodeIds: string[],
): Promise<string[]> {
  const rl = createInterface({ input, output });
  const resolved: string[] = [];
  try {
    for (const nodeId of nodeIds) {
      const detail = await hc.getConflictDetail(nodeId);
      if (!detail) continue;
      const conflict = detail.info;

      console.log(`\nConflict: ${nodeId}`);
      console.log(`Artifact: ${detail.artifactPath}`);
      if (detail.body.trim()) {
        console.log(detail.body.trim());
      }

      const resolution: Record<string, "local" | "remote"> = {};

      for (const field of conflict.fields) {
        if (field.status !== "diverged") continue;
        let answer = "";
        while (!answer) {
          const response = await rl.question(
            `Resolve ${field.field} for ${nodeId} (l=local, r=remote, s=skip): `,
          );
          const normalized = response.trim().toLowerCase();
          if (normalized === "l" || normalized === "local") {
            resolution[field.field] = "local";
            answer = "local";
          } else if (normalized === "r" || normalized === "remote") {
            resolution[field.field] = "remote";
            answer = "remote";
          } else if (normalized === "s" || normalized === "skip") {
            answer = "skip";
          }
        }
      }

      if (Object.keys(resolution).length === 0) {
        console.log(`No fields resolved for ${nodeId}`);
        continue;
      }

      await hc.resolveConflict(nodeId, resolution);
      console.log(`Resolved conflict: ${nodeId}`);
      resolved.push(nodeId);
    }
  } finally {
    rl.close();
  }
  return resolved;
}

program
  .command("diff [pattern]")
  .description("Show local changes vs synced state (supports glob patterns)")
  .option("--all", "Check all files, not just recently modified")
  .action(async (pattern?: string, options?: { all?: boolean }) => {
    const hc = new Hardcopy({ root: process.cwd() });
    await hc.initialize();
    try {
      await hc.loadConfig();
      const diffs = await hc.diff(pattern, { smart: !options?.all });
      if (diffs.length === 0) {
        console.log("No changes detected");
        return;
      }
      for (const diff of diffs) {
        console.log(`\n${diff.nodeId} (${diff.nodeType}):`);
        console.log(`  File: ${diff.filePath}`);
        for (const change of diff.changes) {
          console.log(`  ${change.field}: ${formatChange(change)}`);
        }
      }
    } finally {
      await hc.close();
    }
  });

function formatChange(change: {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}): string {
  const old =
    typeof change.oldValue === "string"
      ? change.oldValue.slice(0, 50) +
        (change.oldValue.length > 50 ? "..." : "")
      : JSON.stringify(change.oldValue);
  const newVal =
    typeof change.newValue === "string"
      ? change.newValue.slice(0, 50) +
        (change.newValue.length > 50 ? "..." : "")
      : JSON.stringify(change.newValue);
  return `${old} → ${newVal}`;
}

program
  .command("mcp-serve")
  .description("Start MCP server for LLM tool integration")
  .action(async () => {
    const { serveMcp } = await import("./mcp-server");
    await serveMcp(process.cwd());
  });

program.parse();

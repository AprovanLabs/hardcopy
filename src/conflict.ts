import type { ParsedFile } from "./format";
import type { Node } from "./types";
import {
  ConflictStatus,
  type FieldConflict,
  type ThreeWayState,
} from "./types";

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
  } else if (valuesEqual(state.local, state.remote)) {
    status = ConflictStatus.CLEAN;
  } else {
    status = ConflictStatus.DIVERGED;
  }

  return {
    field,
    status,
    base: state.base,
    local: state.local,
    remote: state.remote,
    canAutoMerge: isListField(state),
  };
}

export function detectConflicts(
  baseNode: Node,
  localParsed: ParsedFile,
  remoteNode: Node,
  editableFields: string[],
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  const baseAttrs = baseNode.attrs as Record<string, unknown>;
  const remoteAttrs = remoteNode.attrs as Record<string, unknown>;

  for (const field of editableFields) {
    const state: ThreeWayState =
      field === "body"
        ? {
            base: (baseAttrs["body"] as string) ?? "",
            local: localParsed.body ?? "",
            remote: (remoteAttrs["body"] as string) ?? "",
          }
        : {
            base: baseAttrs[field],
            local: localParsed.attrs[field],
            remote: remoteAttrs[field],
          };

    conflicts.push(detectFieldConflict(field, state));
  }

  return conflicts;
}

export function hasUnresolvableConflicts(conflicts: FieldConflict[]): boolean {
  return conflicts.some(
    (conflict) =>
      conflict.status === ConflictStatus.DIVERGED && !conflict.canAutoMerge,
  );
}

export function autoMergeField(conflict: FieldConflict): unknown | null {
  if (conflict.status !== ConflictStatus.DIVERGED || !conflict.canAutoMerge) {
    return null;
  }

  const merged = uniqueList([
    ...(Array.isArray(conflict.base) ? conflict.base : []),
    ...(Array.isArray(conflict.local) ? conflict.local : []),
    ...(Array.isArray(conflict.remote) ? conflict.remote : []),
  ]);

  return merged;
}

export function generateConflictMarkers(conflict: FieldConflict): string {
  const local = String(conflict.local ?? "");
  const base = String(conflict.base ?? "");
  const remote = String(conflict.remote ?? "");
  return `<<<<<<< LOCAL\n${local}\n||||||| BASE\n${base}\n=======\n${remote}\n>>>>>>> REMOTE`;
}

export function parseConflictMarkers(text: string): {
  local: string;
  base: string;
  remote: string;
} | null {
  const match = text.match(
    /<<<<<<< LOCAL\n([\s\S]*?)\n\|\|\|\|\|\|\| BASE\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REMOTE/,
  );
  if (!match) return null;
  return {
    local: match[1] ?? "",
    base: match[2] ?? "",
    remote: match[3] ?? "",
  };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    const normalizedA = normalizeArray(a);
    const normalizedB = normalizeArray(b);
    if (normalizedA.length !== normalizedB.length) return false;
    return normalizedA.every((value, index) => value === normalizedB[index]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeArray(values: unknown[]): string[] {
  return values.map((value) => JSON.stringify(value)).sort();
}

function isListField(state: ThreeWayState): boolean {
  return (
    Array.isArray(state.base) ||
    Array.isArray(state.local) ||
    Array.isArray(state.remote)
  );
}

function uniqueList(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

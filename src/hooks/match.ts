import type { HookTrigger, MatchCondition, TransitionCondition } from "../config";
import type { Change } from "../types";
import type { NodeChange } from "./diff";

export function matchesTrigger(change: NodeChange, trigger: HookTrigger, sourceName: string): boolean {
  if (change.node.type !== trigger.type) return false;
  if (trigger.source && trigger.source !== sourceName) return false;

  const wantsCreated = trigger.created ?? false;
  const wantsUpdated = trigger.updated ?? false;
  if (!wantsCreated && !wantsUpdated) return false;
  if (change.type === "created" && !wantsCreated) return false;
  if (change.type === "updated" && !wantsUpdated) return false;

  if (trigger.match) {
    for (const [key, condition] of Object.entries(trigger.match)) {
      if (!matchesCondition(change.node.attrs[key], condition)) return false;
    }
  }

  if (trigger.transition) {
    for (const [field, condition] of Object.entries(trigger.transition)) {
      const fieldChange = change.changes.find((c) => c.field === field);
      if (!matchesTransition(fieldChange, condition)) return false;
    }
  }

  return true;
}

function matchesCondition(value: unknown, condition: MatchCondition): boolean {
  if (typeof condition !== "object" || condition === null) {
    return value === condition;
  }
  if ("contains" in condition) {
    return Array.isArray(value) && value.includes(condition.contains);
  }
  if ("pattern" in condition) {
    return new RegExp(condition.pattern).test(String(value));
  }
  return false;
}

function matchesTransition(change: Change | undefined, condition: TransitionCondition): boolean {
  if (!change) return false;

  if ("added" in condition) {
    const oldArr = Array.isArray(change.oldValue) ? change.oldValue : [];
    const newArr = Array.isArray(change.newValue) ? change.newValue : [];
    return !oldArr.includes(condition.added) && newArr.includes(condition.added);
  }
  if ("removed" in condition) {
    const oldArr = Array.isArray(change.oldValue) ? change.oldValue : [];
    const newArr = Array.isArray(change.newValue) ? change.newValue : [];
    return oldArr.includes(condition.removed) && !newArr.includes(condition.removed);
  }
  if ("from" in condition && "to" in condition) {
    return (
      JSON.stringify(change.oldValue) === JSON.stringify(condition.from) &&
      JSON.stringify(change.newValue) === JSON.stringify(condition.to)
    );
  }
  return false;
}

import type { Envelope, EventFilter } from "../events/types";
import type { SkillDefinition, SkillTrigger } from "./types";

export interface TriggerMatch {
  skill: SkillDefinition;
  trigger: SkillTrigger;
  priority: number;
}

export function matchEvent(event: Envelope, skills: SkillDefinition[]): TriggerMatch[] {
  const matches: TriggerMatch[] = [];

  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      if (matchesFilter(event, trigger.eventFilter)) {
        if (!trigger.condition || evaluateCondition(trigger.condition, event)) {
          matches.push({
            skill,
            trigger,
            priority: trigger.priority ?? 0,
          });
        }
      }
    }
  }

  return matches.sort((a, b) => b.priority - a.priority);
}

function matchesFilter(event: Envelope, filter: EventFilter): boolean {
  if (filter.types?.length) {
    const matches = filter.types.some((pattern) => matchPattern(event.type, pattern));
    if (!matches) return false;
  }

  if (filter.sources?.length) {
    const matches = filter.sources.some((pattern) => matchPattern(event.source, pattern));
    if (!matches) return false;
  }

  if (filter.subjects?.length && event.subject) {
    const matches = filter.subjects.some((pattern) => matchPattern(event.subject!, pattern));
    if (!matches) return false;
  } else if (filter.subjects?.length && !event.subject) {
    return false;
  }

  if (filter.since && event.timestamp < filter.since) return false;
  if (filter.until && event.timestamp > filter.until) return false;

  if (filter.metadata) {
    for (const [key, value] of Object.entries(filter.metadata)) {
      if (event.metadata[key] !== value) return false;
    }
  }

  return true;
}

function matchPattern(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return value === pattern;

  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
  );
  return regex.test(value);
}

function evaluateCondition(condition: string, event: Envelope): boolean {
  try {
    if (condition.includes("MATCH") || condition.includes("WHERE")) {
      return evaluateCypherCondition(condition, event);
    }

    return evaluateJsCondition(condition, event);
  } catch {
    return false;
  }
}

function evaluateJsCondition(condition: string, event: Envelope): boolean {
  const safeCondition = condition
    .replace(/event\.data\.([a-zA-Z_][a-zA-Z0-9_]*)/g, 'data["$1"]')
    .replace(/event\.metadata\.([a-zA-Z_][a-zA-Z0-9_]*)/g, 'metadata["$1"]')
    .replace(/event\.type/g, "type")
    .replace(/event\.source/g, "source")
    .replace(/event\.subject/g, "subject");

  const { type, source, subject, data, metadata } = event;
  const evalFn = new Function(
    "type",
    "source",
    "subject",
    "data",
    "metadata",
    `return (${safeCondition})`
  );

  return Boolean(evalFn(type, source, subject, data ?? {}, metadata ?? {}));
}

function evaluateCypherCondition(condition: string, event: Envelope): boolean {
  const whereMatch = condition.match(/WHERE\s+(.+)/i);
  if (!whereMatch) return true;

  const whereClause = whereMatch[1]!;
  const normalized = whereClause
    .replace(/\bevent\.data\.(\w+)\b/g, (_, key) => {
      const val = (event.data as Record<string, unknown>)?.[key];
      return JSON.stringify(val);
    })
    .replace(/\bevent\.(\w+)\b/g, (_, key) => {
      const val = (event as unknown as Record<string, unknown>)[key];
      return JSON.stringify(val);
    })
    .replace(/\s+CONTAINS\s+/gi, ".includes(")
    .replace(/\s+=\s+/g, " === ")
    .replace(/\s+<>\s+/g, " !== ")
    .replace(/\.includes\(([^)]+)\)(?!\))/g, ".includes($1))");

  try {
    const evalFn = new Function(`return (${normalized})`);
    return Boolean(evalFn());
  } catch {
    return false;
  }
}

export function groupByPriority(matches: TriggerMatch[]): Map<number, TriggerMatch[]> {
  const groups = new Map<number, TriggerMatch[]>();

  for (const match of matches) {
    const priority = match.priority;
    const existing = groups.get(priority) ?? [];
    existing.push(match);
    groups.set(priority, existing);
  }

  return groups;
}

export function getHighestPriority(matches: TriggerMatch[]): TriggerMatch[] {
  if (matches.length === 0) return [];

  const sorted = [...matches].sort((a, b) => b.priority - a.priority);
  const highestPriority = sorted[0]!.priority;

  return sorted.filter((m) => m.priority === highestPriority);
}

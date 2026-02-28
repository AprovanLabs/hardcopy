import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import yaml from "yaml";
import type { SkillDefinition, SkillMetadata, SkillTrigger, SkillTool } from "./types";

export interface ScanResult {
  skills: SkillDefinition[];
  errors: Array<{ path: string; error: string }>;
}

export async function scanSkills(rootDir: string): Promise<ScanResult> {
  const skills: SkillDefinition[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
            await walk(fullPath);
          }
        } else if (entry.name === "SKILL.md" || entry.name.endsWith(".skill.md")) {
          try {
            const skill = await parseSkillFile(fullPath, rootDir);
            skills.push(skill);
          } catch (err) {
            errors.push({
              path: fullPath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch {}
  }

  await walk(rootDir);
  return { skills, errors };
}

export async function parseSkillFile(filePath: string, rootDir?: string): Promise<SkillDefinition> {
  const content = await readFile(filePath, "utf-8");
  const relPath = rootDir ? relative(rootDir, filePath) : filePath;

  const { frontmatter, body } = extractFrontmatter(content);
  const metadata = frontmatter ? (yaml.parse(frontmatter) as SkillMetadata) : parseInlineMetadata(body);

  const id = generateSkillId(relPath);
  const uri = `skill:${relPath}`;

  return {
    id,
    uri,
    name: metadata.name ?? extractTitle(body) ?? id,
    description: metadata.description ?? extractDescription(body) ?? "",
    instructions: body,
    triggers: parseTriggers(metadata.triggers ?? []),
    tools: parseTools(metadata.tools ?? []),
    model: metadata.model
      ? {
          provider: metadata.model.provider,
          model: metadata.model.name,
          temperature: metadata.model.temperature,
          maxTokens: metadata.model.maxTokens,
        }
      : undefined,
    dependencies: metadata.dependencies,
    path: filePath,
  };
}

export async function getSkillVersion(filePath: string): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const result = execSync(`git log -1 --format=%H -- "${filePath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    return { frontmatter: match[1]!, body: match[2]! };
  }
  return { frontmatter: null, body: content };
}

function parseInlineMetadata(body: string): SkillMetadata {
  const metadata: SkillMetadata = { name: "" };

  const triggerMatch = body.match(/## Triggers?\n([\s\S]*?)(?=\n## |\n$|$)/i);
  if (triggerMatch) {
    const triggers: SkillMetadata["triggers"] = [];
    const lines = triggerMatch[1]!.split("\n");
    for (const line of lines) {
      const eventMatch = line.match(/[-*]\s*`?([a-zA-Z0-9_.]+(?:\.\*)?)`?/);
      if (eventMatch) {
        triggers.push({ event: eventMatch[1] });
      }
    }
    if (triggers.length > 0) {
      metadata.triggers = triggers;
    }
  }

  const toolsMatch = body.match(/## Tools?\n([\s\S]*?)(?=\n## |\n$|$)/i);
  if (toolsMatch) {
    const tools: string[] = [];
    const lines = toolsMatch[1]!.split("\n");
    for (const line of lines) {
      const toolMatch = line.match(/[-*]\s*`?([a-zA-Z0-9_.]+)`?/);
      if (toolMatch) {
        tools.push(toolMatch[1]!);
      }
    }
    if (tools.length > 0) {
      metadata.tools = tools;
    }
  }

  return metadata;
}

function extractTitle(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : null;
}

function extractDescription(body: string): string | null {
  const lines = body.split("\n");
  let inDescription = false;

  for (const line of lines) {
    if (line.startsWith("# ")) {
      inDescription = true;
      continue;
    }
    if (inDescription) {
      if (line.startsWith("#") || line.startsWith("---")) {
        break;
      }
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("```")) {
        return trimmed;
      }
    }
  }
  return null;
}

function parseTriggers(
  triggers: NonNullable<SkillMetadata["triggers"]>
): SkillTrigger[] {
  return triggers.map((t) => {
    const eventFilter: SkillTrigger["eventFilter"] = {};

    if (t.event) {
      eventFilter.types = [t.event];
    }
    if (t.types) {
      eventFilter.types = t.types;
    }
    if (t.sources) {
      eventFilter.sources = t.sources;
    }
    if (t.subjects) {
      eventFilter.subjects = t.subjects;
    }

    return {
      eventFilter,
      condition: t.condition,
      priority: t.priority ?? 0,
    };
  });
}

function parseTools(
  tools: NonNullable<SkillMetadata["tools"]>
): SkillTool[] {
  return tools.map((t) => {
    if (typeof t === "string") {
      const parts = t.split(".");
      if (parts.length >= 2) {
        return {
          name: t,
          service: parts.slice(0, -1).join("."),
          procedure: parts[parts.length - 1],
        };
      }
      return { name: t };
    }
    return {
      name: t.name,
      service: t.service,
      procedure: t.procedure,
    };
  });
}

function generateSkillId(path: string): string {
  return path
    .replace(/\.skill\.md$/, "")
    .replace(/\/SKILL\.md$/, "")
    .replace(/SKILL\.md$/, "default")
    .replace(/[/\\]/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

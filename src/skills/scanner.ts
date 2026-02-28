import { readFile, readdir, stat } from "fs/promises";
import { join, relative, dirname, basename } from "path";
import yaml from "yaml";
import type { SkillDefinition, SkillTrigger, SkillResource, ModelPreference } from "./types";

const SKILL_FILENAME = "SKILL.md";
const IGNORE_DIRS = ["node_modules", ".git", ".hardcopy", "dist", "build"];

interface SkillFrontmatter {
  name?: string;
  description?: string;
  triggers?: Array<{
    eventFilter?: { types?: string[]; sources?: string[]; subjects?: string[] };
    condition?: string;
    priority?: number;
  }>;
  tools?: string[];
  model?: ModelPreference;
  dependencies?: string[];
  resources?: string[];
}

export async function scanForSkills(rootPath: string): Promise<SkillDefinition[]> {
  const skillFiles = await findSkillFiles(rootPath);
  const skills: SkillDefinition[] = [];

  for (const filePath of skillFiles) {
    try {
      const skill = await parseSkillFile(filePath, rootPath);
      if (skill) {
        skills.push(skill);
      }
    } catch (err) {
      console.error(`Failed to parse skill at ${filePath}:`, err);
    }
  }

  return skills;
}

async function findSkillFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];
  await walkDir(rootPath, results);
  return results;
}

async function walkDir(dir: string, results: string[]): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.includes(entry.name)) {
          await walkDir(fullPath, results);
        }
      } else if (entry.isFile() && entry.name === SKILL_FILENAME) {
        results.push(fullPath);
      }
    }
  } catch {}
}

export async function parseSkillFile(
  filePath: string,
  rootPath: string
): Promise<SkillDefinition | null> {
  const content = await readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  const relPath = relative(rootPath, filePath);
  const skillDir = dirname(filePath);
  const skillId = relPath.replace(/\/SKILL\.md$/, "").replace(/\//g, "-") || basename(skillDir);

  const resources = await loadResources(skillDir, frontmatter.resources ?? []);
  const version = await getGitVersion(filePath);

  const triggers: SkillTrigger[] = (frontmatter.triggers ?? []).map((t) => ({
    eventFilter: {
      types: t.eventFilter?.types,
      sources: t.eventFilter?.sources,
      subjects: t.eventFilter?.subjects,
    },
    condition: t.condition,
    priority: t.priority ?? 0,
  }));

  return {
    id: skillId,
    uri: `skill:${relPath}`,
    name: frontmatter.name ?? skillId,
    description: frontmatter.description ?? extractDescription(body),
    instructions: body,
    resources,
    triggers,
    tools: frontmatter.tools ?? [],
    model: frontmatter.model,
    version,
    dependencies: frontmatter.dependencies,
  };
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  try {
    const frontmatter = yaml.parse(match[1]!) as SkillFrontmatter;
    return { frontmatter, body: match[2]! };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function extractDescription(body: string): string {
  const firstParagraph = body.split("\n\n")[0];
  if (!firstParagraph) return "";

  const cleaned = firstParagraph
    .replace(/^#+\s+.+\n?/, "")
    .replace(/\n/g, " ")
    .trim();

  return cleaned.length > 200 ? cleaned.slice(0, 197) + "..." : cleaned;
}

async function loadResources(skillDir: string, resourcePaths: string[]): Promise<SkillResource[]> {
  const resources: SkillResource[] = [];

  for (const resPath of resourcePaths) {
    try {
      const fullPath = join(skillDir, resPath);
      const content = await readFile(fullPath, "utf-8");
      resources.push({ path: resPath, content });
    } catch {}
  }

  if (resourcePaths.length === 0) {
    try {
      const entries = await readdir(skillDir);
      for (const entry of entries) {
        if (entry.endsWith(".md") && entry !== SKILL_FILENAME) {
          const fullPath = join(skillDir, entry);
          const content = await readFile(fullPath, "utf-8");
          resources.push({ path: entry, content });
        }
      }
    } catch {}
  }

  return resources;
}

async function getGitVersion(filePath: string): Promise<string | undefined> {
  try {
    const { execSync } = await import("child_process");
    const result = execSync(`git log -1 --format="%H" -- "${filePath}"`, {
      cwd: dirname(filePath),
      encoding: "utf-8",
    });
    const sha = result.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

export async function watchSkillChanges(
  rootPath: string,
  onSkillChange: (skill: SkillDefinition) => void
): Promise<{ close: () => void }> {
  const { watch } = await import("fs");
  const watchers: ReturnType<typeof watch>[] = [];

  const skillFiles = await findSkillFiles(rootPath);
  for (const filePath of skillFiles) {
    const watcher = watch(filePath, async (eventType) => {
      if (eventType === "change") {
        const skill = await parseSkillFile(filePath, rootPath);
        if (skill) {
          onSkillChange(skill);
        }
      }
    });
    watchers.push(watcher);
  }

  return {
    close: () => {
      for (const w of watchers) {
        w.close();
      }
    },
  };
}

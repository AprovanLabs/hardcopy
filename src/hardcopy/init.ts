import { join } from "path";
import { mkdir, writeFile, access } from "fs/promises";
import { Database } from "../db";

export async function initHardcopy(root: string): Promise<void> {
  const dataDir = join(root, ".hardcopy");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(dataDir, "crdt"), { recursive: true });
  await mkdir(join(dataDir, "errors"), { recursive: true });

  const db = await Database.open(join(dataDir, "db.sqlite"));
  await db.close();

  const configPath = join(root, "hardcopy.yaml");
  try {
    await access(configPath);
  } catch {
    const defaultConfig = `# Hardcopy configuration
sources: []
views: []
`;
    await writeFile(configPath, defaultConfig);
  }
}

#!/usr/bin/env tsx
/**
 * Downloads the GraphQLite SQLite extension for the current platform.
 * Run with: pnpm setup:graphqlite
 */

import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const RELEASE_BASE =
  "https://github.com/colliery-io/graphqlite/releases/latest/download";

interface PlatformAsset {
  filename: string;
  sha256: string;
}

const ASSETS: Record<string, PlatformAsset> = {
  "darwin-arm64": {
    filename: "graphqlite-macos-arm64.dylib",
    sha256: "a3e50c0bb133005ee0a00f1b881e9c964caef2fcfb76854b8fb800b05eab554d",
  },
  "darwin-x64": {
    filename: "graphqlite-macos-x86_64.dylib",
    sha256: "cdb517283d6de3dcb97e248b0edcc064a17bb34c6ac9296ced65da260ff0c5ec",
  },
  "linux-arm64": {
    filename: "graphqlite-linux-aarch64.so",
    sha256: "d86a0ca3c3415f1de529a1be847389544f5c3ab9557313dc08c32c3c7cbc318c",
  },
  "linux-x64": {
    filename: "graphqlite-linux-x86_64.so",
    sha256: "113ff2efe432d6910fed41c58da73a9bf656e7fd822bfe61c166c80b109a1300",
  },
  "win32-x64": {
    filename: "graphqlite-windows-x86_64.dll",
    sha256: "55ee805e3e26cba644f1970342e150cf1ce528eb4a513ca50835c825a02a21ea",
  },
};

function getPlatformKey(): string {
  const platform = process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

function getExtensionDir(): string {
  return join(PROJECT_ROOT, ".hardcopy", "extensions");
}

function getExtensionPath(filename: string): string {
  return join(getExtensionDir(), filename);
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new Error(`No body in response from ${url}`);
  }

  const dir = dirname(dest);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const fileStream = createWriteStream(dest);
  // @ts-expect-error Node streams compatibility
  await pipeline(response.body, fileStream);
}

async function computeSha256(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function verifyChecksum(
  path: string,
  expected: string,
): Promise<boolean> {
  const actual = await computeSha256(path);
  return actual === expected;
}

async function main(): Promise<void> {
  const platformKey = getPlatformKey();
  const asset = ASSETS[platformKey];

  if (!asset) {
    console.error(`Unsupported platform: ${platformKey}`);
    console.error(`Supported platforms: ${Object.keys(ASSETS).join(", ")}`);
    console.error("\nYou may need to build GraphQLite from source:");
    console.error("  https://github.com/colliery-io/graphqlite");
    process.exit(1);
  }

  const destPath = getExtensionPath(asset.filename);

  // Check if already installed and valid
  if (existsSync(destPath)) {
    console.log(`Checking existing installation at ${destPath}...`);
    const valid = await verifyChecksum(destPath, asset.sha256);
    if (valid) {
      console.log("GraphQLite extension already installed and verified.");
      printEnvHint(destPath);
      return;
    }
    console.log("Checksum mismatch, re-downloading...");
    unlinkSync(destPath);
  }

  const url = `${RELEASE_BASE}/${asset.filename}`;
  console.log(`Downloading GraphQLite for ${platformKey}...`);
  console.log(`  URL: ${url}`);
  console.log(`  Destination: ${destPath}`);

  await downloadFile(url, destPath);

  // Verify checksum
  console.log("Verifying checksum...");
  const valid = await verifyChecksum(destPath, asset.sha256);
  if (!valid) {
    unlinkSync(destPath);
    console.error("Checksum verification failed!");
    console.error(`Expected: ${asset.sha256}`);
    console.error(`Got: ${await computeSha256(destPath)}`);
    process.exit(1);
  }

  console.log("GraphQLite extension installed successfully!");
  printEnvHint(destPath);
}

function printEnvHint(path: string): void {
  console.log("\n--- Setup Complete ---");
  console.log("The extension will be auto-discovered at runtime.");
  console.log(`Location: ${path}`);
  console.log("\nAlternatively, set the environment variable:");
  console.log(`  export GRAPHQLITE_EXTENSION_PATH="${path}"`);
}

main().catch((err) => {
  console.error("Installation failed:", err);
  process.exit(1);
});

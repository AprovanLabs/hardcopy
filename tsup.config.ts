import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/mcp-server.ts"],
  format: ["esm"],
  dts: true,
  splitting: false,
  clean: true,
  shims: true,
});

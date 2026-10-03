#!/usr/bin/env node
/**
 * Shared build for browser extensions in this monorepo.
 *
 * package.json field:
 *   "extensionBuild": {
 *     "entries": ["src/content.ts", ...],
 *     "copy": ["public"]
 *   }
 */
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const pkgDir = process.cwd();
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const config = pkg.extensionBuild;

if (!config?.entries?.length) {
  console.error("package.json must define extensionBuild.entries");
  process.exit(1);
}

const dist = join(pkgDir, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const copyRoots = config.copy ?? ["public"];
for (const root of copyRoots) {
  const from = join(pkgDir, root);
  if (!existsSync(from)) continue;
  cpSync(from, dist, { recursive: true });
}

await esbuild.build({
  entryPoints: config.entries.map((e) => join(pkgDir, e)),
  bundle: true,
  outdir: dist,
  format: "iife",
  target: "chrome109",
  legalComments: "none",
  logLevel: "info",
});

console.log(`Built ${pkg.name} → ${dist}`);

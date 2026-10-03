/** Пишет манифест native host и регистрирует его в Chrome и Edge. */

import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "..", "public", "manifest.json");
const hostName = "com.youtube.downloader";

function extensionId(spkiDer) {
  const hex = createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (char) => String.fromCharCode(97 + Number.parseInt(char, 16)));
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifest.key) {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  manifest.key = der.toString("base64");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const der = Buffer.from(manifest.key, "base64");
const id = extensionId(der);
const node = process.execPath;
const hostLaunch = process.platform === "win32" ? path.join(here, "host.cmd") : path.join(here, "host.sh");
if (process.platform === "win32") {
  writeFileSync(hostLaunch, `@echo off\r\n"${node}" "%~dp0host.js"\r\n`, "utf8");
} else {
  writeFileSync(hostLaunch, `#!/bin/sh\nexec "${node}" "${path.join(here, "host.js")}"\n`, "utf8");
  chmodSync(hostLaunch, 0o755);
}

const hostManifest = {
  name: hostName,
  description: "Открывает yt-dlp для ролика YouTube",
  path: hostLaunch,
  type: "stdio",
  allowed_origins: [`chrome-extension://${id}/`],
};
const hostManifestPath = path.join(here, "host-manifest.json");
writeFileSync(hostManifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`);

if (process.platform === "win32") {
  const keys = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`,
  ];
  for (const key of keys) {
    const result = spawnSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", hostManifestPath, "/f"], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
      process.exit(result.status || 1);
    }
  }
} else {
  const home = os.homedir();
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const dirs =
    process.platform === "darwin"
      ? [
          path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
          path.join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"),
          path.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
        ]
      : [
          path.join(config, "google-chrome", "NativeMessagingHosts"),
          path.join(config, "chromium", "NativeMessagingHosts"),
          path.join(config, "microsoft-edge", "NativeMessagingHosts"),
        ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(hostManifestPath, path.join(dir, `${hostName}.json`));
  }
}

console.log(`extension ${id}`);
console.log(`host ${hostManifestPath}`);

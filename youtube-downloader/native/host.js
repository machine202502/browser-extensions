/**
 * Native host для Chrome: список разрешений и скрытый запуск yt-dlp.
 * Протокол: 4 байта длины (LE) + JSON. Консоль пользователю не показывается.
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  fs.writeSync(1, header);
  fs.writeSync(1, body);
}

function walk(dir, name, depth) {
  if (depth < 0 || !dir || !fs.existsSync(dir)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === name) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = walk(path.join(dir, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

function findOnPath(filename) {
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path");
  const dirs = (process.env[key] || "").split(path.delimiter).filter(Boolean);
  const bare = filename.replace(/\.exe$/i, "");
  const names = process.platform === "win32" ? [filename, `${bare}.cmd`, bare] : [bare, filename];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {
        /* следующей папки */
      }
    }
  }
  return null;
}

function findTool(filename) {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    const roots = [
      path.join(local, "Microsoft", "WinGet", "Links"),
      path.join(local, "Microsoft", "WinGet", "Packages"),
    ];
    for (const root of roots) {
      const found = walk(root, filename, 6);
      if (found) return found;
    }
  }
  return findOnPath(filename);
}

function videoUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\//, "");
    return /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  }
  if (host !== "youtube.com" && host !== "m.youtube.com") return null;
  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  }
  const nested = url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
  return nested ? `https://www.youtube.com${url.pathname}` : null;
}

function safeFormat(value) {
  return typeof value === "string" && /^[A-Za-z0-9*+[\]=^.<>_,-]+$/.test(value) && value.length <= 160;
}

const tools = {
  ytdlp: findTool("yt-dlp.exe"),
  ffmpeg: findTool("ffmpeg.exe"),
  deno: findTool("deno.exe"),
};

function toolEnv() {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "Path";
  const extra = [tools.ffmpeg, tools.deno, tools.ytdlp].filter(Boolean).map((file) => path.dirname(file));
  env[key] = [...extra, env[key] || ""].filter(Boolean).join(";");
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return env;
}

function decodeChunk(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1251").decode(buffer);
  }
}

function splitLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a && buffer[i] !== 0x0d) continue;
    if (i > start) lines.push(buffer.subarray(start, i));
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) i += 1;
    start = i + 1;
  }
  return { lines, rest: buffer.subarray(start) };
}

function baseArgs() {
  return [
    "--no-playlist",
    "--no-warnings",
    ...(tools.ffmpeg ? ["--ffmpeg-location", path.dirname(tools.ffmpeg)] : []),
  ];
}

const children = new Set();

function runYtDlp(args, onLine, onSpawn) {
  return new Promise((resolve) => {
    if (!tools.ytdlp) {
      resolve({ code: 1, stdout: "", stderr: "yt-dlp не найден. Установите: winget install yt-dlp.yt-dlp" });
      return;
    }
    const child = spawn(tools.ytdlp, args, {
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: toolEnv(),
      cwd: path.join(os.homedir(), "Downloads"),
    });
    children.add(child);
    if (onSpawn) onSpawn(child);
    let stdout = "";
    let stderr = "";
    const pending = { out: Buffer.alloc(0), err: Buffer.alloc(0) };
    const take = (stream, into) => {
      const push = (chunk) => {
        const joined = chunk ? Buffer.concat([pending[into], chunk]) : pending[into];
        const { lines, rest } = splitLines(joined);
        pending[into] = Buffer.from(rest);
        for (const line of lines) {
          const text = decodeChunk(line);
          if (into === "out") stdout += `${text}\n`;
          else stderr += `${text}\n`;
          if (onLine && text.trim()) onLine(text);
        }
      };
      stream.on("data", (chunk) => push(chunk));
      stream.on("end", () => {
        if (!pending[into].length) return;
        const text = decodeChunk(pending[into]);
        pending[into] = Buffer.alloc(0);
        if (into === "out") stdout += text;
        else stderr += text;
        if (onLine && text.trim()) onLine(text);
      });
    };
    take(child.stdout, "out");
    take(child.stderr, "err");
    const finish = (payload) => {
      children.delete(child);
      resolve(payload);
    };
    child.on("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

function lastError(stderr, fallback) {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const error = [...lines].reverse().find((line) => /^ERROR:/i.test(line));
  return (error || fallback).replace(/^ERROR:\s*/, "");
}

function formatBytes(bytes, approx) {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  const text = mb < 10 ? `${mb.toFixed(1)} МБ` : mb < 1024 ? `${Math.round(mb)} МБ` : `${(mb / 1024).toFixed(2)} ГБ`;
  return approx ? `≈ ${text}` : text;
}

function measure(format, duration) {
  if (!format) return { bytes: 0, approx: false };
  if (format.filesize > 0) return { bytes: format.filesize, approx: false };
  if (format.filesize_approx > 0) return { bytes: format.filesize_approx, approx: true };
  const rate = format.tbr || format.vbr || format.abr || 0;
  if (rate > 0 && duration > 0) return { bytes: Math.round((rate * 1000 * duration) / 8), approx: true };
  return { bytes: 0, approx: false };
}

function codecName(codec) {
  if (!codec || codec === "none") return "";
  if (codec.startsWith("avc1")) return "H.264";
  if (codec.startsWith("av01")) return "AV1";
  if (codec.startsWith("vp9") || codec.startsWith("vp09")) return "VP9";
  if (codec.startsWith("mp4a")) return "AAC";
  if (codec.startsWith("opus")) return "Opus";
  return codec.split(".")[0];
}

function videoScore(format) {
  const codec = format.vcodec || "";
  const rank = codec.startsWith("avc1") ? 3 : codec.startsWith("vp9") || codec.startsWith("vp09") ? 2 : 1;
  return rank * 1_000_000_000 + (format.tbr || format.vbr || 0);
}

function rowsFromInfo(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const videos = formats.filter((format) => format.vcodec && format.vcodec !== "none" && format.height && format.ext !== "mhtml");
  const audios = formats.filter((format) => format.acodec && format.acodec !== "none" && (!format.vcodec || format.vcodec === "none"));
  const bestAudio = [...audios].sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const groups = new Map();

  for (const format of videos) {
    const fps = format.fps > 30 ? format.fps : 0;
    const key = `${format.height}:${fps}`;
    const group = groups.get(key) || { height: format.height, fps, video: null, muxed: null };
    const both = format.acodec && format.acodec !== "none";
    if (both) {
      if (!group.muxed || videoScore(format) > videoScore(group.muxed)) group.muxed = format;
    } else if (!group.video || videoScore(format) > videoScore(group.video)) {
      group.video = format;
    }
    groups.set(key, group);
  }

  const duration = Number(info.duration) || 0;
  const rows = [...groups.values()]
    .sort((a, b) => b.height - a.height || b.fps - a.fps)
    .map((group) => {
      const separate = group.video && bestAudio;
      const chosen = separate && (!group.muxed || videoScore(group.video) >= videoScore(group.muxed)) ? group.video : group.muxed || group.video;
      if (!chosen) return null;
      const merged = Boolean(separate && chosen === group.video);
      const format = merged ? `${chosen.format_id}+${bestAudio.format_id}` : String(chosen.format_id);
      if (!safeFormat(format)) return null;
      const videoSize = measure(chosen, duration);
      const audioSize = merged ? measure(bestAudio, duration) : { bytes: 0, approx: false };
      const label = group.fps ? `${group.height}p${group.fps}` : `${group.height}p`;
      return {
        kind: "video",
        title: label,
        codec: codecName(chosen.vcodec),
        size: videoSize.bytes > 0 ? formatBytes(videoSize.bytes + audioSize.bytes, videoSize.approx || audioSize.approx) : "",
        format,
      };
    })
    .filter(Boolean);

  if (bestAudio && safeFormat(String(bestAudio.format_id))) {
    const audioSize = measure(bestAudio, duration);
    rows.push({
      kind: "audio",
      title: "Звук",
      codec: codecName(bestAudio.acodec),
      size: formatBytes(audioSize.bytes, audioSize.approx),
      format: String(bestAudio.format_id),
    });
  }
  return rows;
}

async function listFormats(url) {
  const result = await runYtDlp([...baseArgs(), "-J", url]);
  if (result.code !== 0) {
    return { ok: false, error: lastError(result.stderr, "Не удалось получить разрешения") };
  }
  let info;
  try {
    const start = result.stdout.indexOf("{");
    const end = result.stdout.lastIndexOf("}");
    info = JSON.parse(result.stdout.slice(start, end + 1));
  } catch {
    return { ok: false, error: "yt-dlp вернул непонятный список форматов" };
  }
  const rows = rowsFromInfo(info);
  if (rows.length === 0) return { ok: false, error: "Нет доступных разрешений" };
  return { ok: true, title: info.title || "", rows };
}

function savedName(downloads, filePath, started) {
  if (filePath && !filePath.includes("\uFFFD")) {
    const full = path.isAbsolute(filePath) ? filePath : path.join(downloads, filePath);
    if (fs.existsSync(full)) return path.basename(full);
  }
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(downloads);
  } catch {
    return "";
  }
  for (const name of names) {
    if (name.includes("\uFFFD") || name.endsWith(".part") || name.endsWith(".ytdl") || name.endsWith(".tmp")) continue;
    const full = path.join(downloads, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs < started - 2000) continue;
    if (!best || stat.mtimeMs > best.mtime) best = { name, mtime: stat.mtimeMs };
  }
  return best ? best.name : "";
}

const trayItems = new Map();
let trayServer = null;
let traySocket = null;
let trayProc = null;
let trayTimer = null;
let traySent = "";
let trayGaveUp = false;

function trayPayload() {
  const items = [...trayItems.entries()].map(([id, item]) => ({
    id,
    title: item.title,
    status: item.status,
  }));
  return `${JSON.stringify({ items })}\n`;
}

function writeTray(socket, force) {
  if (!socket) return;
  const line = trayPayload();
  if (!force && line === traySent) return;
  traySent = line;
  socket.write(line);
}

function publishTray() {
  if (trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    writeTray(traySocket, false);
  }, 250);
}

function publishTrayNow() {
  if (trayTimer) {
    clearTimeout(trayTimer);
    trayTimer = null;
  }
  writeTray(traySocket, true);
}

function stopProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function cancelDownload(id) {
  const item = trayItems.get(String(id));
  if (!item || item.cancelled) return;
  item.cancelled = true;
  item.status = "отмена";
  publishTrayNow();
  stopProcess(item.child);
}

let pythonBin;

function pythonCommand() {
  if (pythonBin !== undefined) return pythonBin;
  for (const name of ["python3", "python", "py"]) {
    const probe = spawnSync(name, ["-c", "import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (probe.status === 0) {
      pythonBin = name;
      return pythonBin;
    }
  }
  pythonBin = "";
  return pythonBin;
}

function spawnTray() {
  if (trayGaveUp || !trayServer) return;
  const address = trayServer.address();
  if (!address || typeof address === "string") return;
  if (trayProc && trayProc.exitCode == null && !trayProc.killed) return;
  const python = pythonCommand();
  if (!python) {
    trayGaveUp = true;
    return;
  }
  const started = Date.now();
  trayProc = spawn(python, [path.join(__dirname, "tray.py"), String(address.port), path.join(__dirname, "..", "public", "icon.png")], {
    windowsHide: true,
    stdio: "ignore",
  });
  trayProc.on("error", () => {
    trayProc = null;
    trayGaveUp = true;
  });
  trayProc.on("exit", () => {
    trayProc = null;
    if (!traySocket && Date.now() - started < 3000) trayGaveUp = true;
  });
}

function ensureTray() {
  if (!trayServer) {
    trayServer = net.createServer((socket) => {
      if (traySocket && traySocket !== socket) traySocket.destroy();
      traySocket = socket;
      socket.setEncoding("utf8");
      let pending = "";
      socket.on("data", (text) => {
        pending += text;
        let nl = pending.indexOf("\n");
        while (nl >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.cancel != null) cancelDownload(msg.cancel);
          } catch {
            /* чужая строка не мешает загрузке */
          }
        }
      });
      socket.on("close", () => {
        if (traySocket === socket) traySocket = null;
      });
      socket.on("error", () => {});
      writeTray(socket, true);
    });
    trayServer.on("error", () => {});
    trayServer.listen(0, "127.0.0.1", spawnTray);
    return;
  }
  spawnTray();
}

function isTempName(name) {
  return name.endsWith(".part") || name.endsWith(".ytdl") || name.includes(".part-Frag");
}

function tempStems(targets) {
  const stems = [];
  for (const target of targets) {
    if (!target || target.includes("\uFFFD")) continue;
    const base = path.basename(target).replace(/\.(part|ytdl)$/i, "").normalize("NFC");
    const stem = base.replace(/\.f\d+\.[^.]+$/i, "").replace(/\.[^.]+$/i, "");
    for (const value of [base, stem]) {
      if (value && value.length >= 3 && !stems.includes(value)) stems.push(value);
    }
  }
  return stems;
}

function matchingTemps(downloads, targets, format, started) {
  let entries = [];
  try {
    entries = fs.readdirSync(downloads);
  } catch {
    return [];
  }
  const stems = tempStems(targets);
  const formatIds = String(format || "")
    .split("+")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
  return entries.filter((name) => {
    const normalized = name.normalize("NFC");
    if (!isTempName(normalized)) return false;
    if (stems.some((stem) => normalized.startsWith(stem))) return true;
    if (formatIds.length === 0 || !formatIds.some((id) => normalized.includes(`.f${id}.`))) return false;
    try {
      return fs.statSync(path.join(downloads, name)).mtimeMs >= started - 2000;
    } catch {
      return false;
    }
  });
}

async function removeTemps(downloads, targets, format, started) {
  const victims = matchingTemps(downloads, targets, format, started);
  for (let attempt = 0; attempt < 10 && victims.length > 0; attempt++) {
    for (let index = victims.length - 1; index >= 0; index--) {
      const full = path.join(downloads, victims[index]);
      try {
        fs.rmSync(full, { force: true });
        if (!fs.existsSync(full)) victims.splice(index, 1);
      } catch {
        /* файл ещё занят только что остановленным процессом */
      }
    }
    if (victims.length > 0) await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function trayTitle(filePath) {
  const name = path.basename(filePath).replace(/\s+/g, " ").trim();
  if (!name || name.includes("\uFFFD")) return "";
  return name.length > 80 ? `${name.slice(0, 77)}…` : name;
}

async function download(url, format, onProgress, trayId) {
  const downloads = path.join(os.homedir(), "Downloads");
  fs.mkdirSync(downloads, { recursive: true });
  const started = Date.now();
  let finalPath = "";
  const partials = new Set();
  const item = { title: "Подготовка…", status: "0%", child: null, cancelled: false };
  trayItems.set(String(trayId), item);
  ensureTray();
  publishTrayNow();
  const result = await runYtDlp(
    [
      ...baseArgs(),
      "--newline",
      "--progress",
      "--windows-filenames",
      "-f",
      format,
      "-P",
      downloads,
      "-o",
      "%(title)s [%(resolution)s].%(ext)s",
      "--",
      url,
    ],
    (line) => {
      const merge = line.match(/Merging formats into ["'](.+?)["']/);
      const dest = line.match(/Destination:\s+(.+)$/);
      if (merge) finalPath = merge[1];
      else if (dest) finalPath = dest[1];
      if (dest) partials.add(dest[1]);
      if (merge) partials.add(merge[1]);
      const named = trayTitle(finalPath);
      if (named) item.title = named;
      if (/Merger|ExtractAudio/.test(line)) {
        item.status = "склеивание";
        publishTray();
        onProgress({ phase: "progress", text: "Склеиваю видео и звук…" });
        return;
      }
      const percent = line.match(/(\d+(?:\.\d+)?)%/);
      if (!percent) return;
      const value = Math.min(100, Math.round(Number(percent[1])));
      item.status = `${value}%`;
      publishTray();
      onProgress({ phase: "progress", percent: value, text: `Скачиваю… ${value}%` });
    },
    (child) => {
      item.child = child;
      if (item.cancelled) stopProcess(child);
    },
  );
  trayItems.delete(String(trayId));
  publishTrayNow();
  if (item.cancelled) {
    await removeTemps(downloads, partials, format, started);
    return { ok: false, error: "Загрузка отменена" };
  }
  if (result.code !== 0) {
    return { ok: false, error: lastError(result.stderr, "Не удалось скачать") };
  }
  return { ok: true, phase: "done", filename: savedName(downloads, finalPath, started) || "Файл в папке Загрузки" };
}

function handle(message) {
  const id = message.id;
  const url = videoUrl(message.url);
  if (!url) {
    writeMessage({ id, ok: false, error: "Это не ссылка на ролик YouTube." });
    return;
  }
  if (message.action === "formats") {
    listFormats(url)
      .then((payload) => writeMessage({ id, ...payload }))
      .catch((error) => writeMessage({ id, ok: false, error: error instanceof Error ? error.message : "Не удалось получить разрешения" }));
    return;
  }
  if (message.action === "download") {
    if (!safeFormat(message.format)) {
      writeMessage({ id, ok: false, error: "Некорректное разрешение" });
      return;
    }
    writeMessage({ id, ok: true, phase: "progress", text: "Скачиваю…" });
    download(url, message.format, (progress) => writeMessage({ id, ok: true, ...progress }), id)
      .then((payload) => writeMessage({ id, ...payload }))
      .catch((error) => writeMessage({ id, ok: false, error: error instanceof Error ? error.message : "Не удалось скачать" }));
    return;
  }
  writeMessage({ id, ok: false, error: "Неизвестная команда" });
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE(0);
    if (size <= 0 || size > 1024 * 1024) {
      process.exit(1);
    }
    if (buffer.length < 4 + size) return;
    const json = buffer.subarray(4, 4 + size).toString("utf8");
    buffer = buffer.subarray(4 + size);
    try {
      handle(JSON.parse(json));
    } catch (error) {
      writeMessage({ ok: false, error: error instanceof Error ? error.message : "Не удалось прочитать команду" });
    }
  }
});
process.stdin.on("end", () => {
  for (const child of children) stopProcess(child);
  if (trayProc) trayProc.kill();
  process.exit(0);
});
process.stdin.resume();

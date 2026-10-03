/** Выгрузка / загрузка базы расширения (блокировки, просмотры, настройки). */

export const BACKUP_FORMAT = 1;
export const BLOCKS_KEY = "yti-blocks";
export const VIEWS_KEY = "yti-views";
export const AVAILABLE_KEY = "yti-available";

export interface BlockData {
  videos: string[];
  channels: string[];
}

export interface ViewEntry {
  count: number;
  noFirst?: boolean;
}

export type ViewsMap = Record<string, ViewEntry>;

export interface SettingsSnapshot {
  blur: boolean;
  hoverPlay: boolean;
  blurAvatars: boolean;
  blurLinks: boolean;
  blockEnabled: boolean;
  viewsEnabled: boolean;
  dontRecommendEnabled: boolean;
  autoHideAfter: number;
}

export interface BackupFile {
  format: number;
  exportedAt: string;
  blocks: BlockData;
  views: ViewsMap;
  available: string[];
  settings: SettingsSnapshot;
}

export type ImportMode = "merge" | "replace";

const EMPTY_BLOCKS: BlockData = { videos: [], channels: [] };

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  blur: true,
  hoverPlay: true,
  blurAvatars: true,
  blurLinks: true,
  blockEnabled: true,
  viewsEnabled: true,
  dontRecommendEnabled: true,
  autoHideAfter: 5,
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof SettingsSnapshot)[];

function normalizeBlocks(raw: unknown): BlockData {
  if (!raw || typeof raw !== "object") return { ...EMPTY_BLOCKS };
  const o = raw as Record<string, unknown>;
  const videos = Array.isArray(o.videos) ? o.videos.filter((x): x is string => typeof x === "string") : [];
  const channels = Array.isArray(o.channels) ? o.channels.filter((x): x is string => typeof x === "string") : [];
  return { videos, channels };
}

function normalizeViews(raw: unknown): ViewsMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ViewsMap = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const count = typeof e.count === "number" && Number.isFinite(e.count) ? Math.max(0, Math.floor(e.count)) : 0;
    out[id] = e.noFirst ? { count, noFirst: true } : { count };
  }
  return out;
}

function normalizeAvailable(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function normalizeSettings(raw: unknown): SettingsSnapshot {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const key of SETTINGS_KEYS) {
    if (key === "autoHideAfter") {
      if (typeof o[key] === "number" && Number.isFinite(o[key])) {
        out.autoHideAfter = Math.min(99, Math.max(1, Math.floor(o[key] as number)));
      }
      continue;
    }
    if (typeof o[key] === "boolean") out[key] = o[key];
  }
  return out;
}

function storageGet<T extends object>(defaults: T): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (raw) => {
      resolve({ ...defaults, ...raw } as T);
    });
  });
}

function storageSet(data: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export async function readBackupFromStorage(): Promise<BackupFile> {
  const raw = await storageGet({
    [BLOCKS_KEY]: EMPTY_BLOCKS,
    [VIEWS_KEY]: {} as ViewsMap,
    [AVAILABLE_KEY]: [] as string[],
    ...DEFAULT_SETTINGS,
  });
  return {
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    blocks: normalizeBlocks(raw[BLOCKS_KEY as keyof typeof raw]),
    views: normalizeViews(raw[VIEWS_KEY as keyof typeof raw]),
    available: normalizeAvailable(raw[AVAILABLE_KEY as keyof typeof raw]),
    settings: normalizeSettings(raw),
  };
}

export function parseBackupText(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Файл не является корректным JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Неверный формат файла");
  }
  const o = parsed as Record<string, unknown>;
  if (!("blocks" in o) && !("views" in o) && !("available" in o)) {
    throw new Error("В файле нет данных расширения");
  }
  return {
    format: typeof o.format === "number" ? o.format : 0,
    exportedAt: typeof o.exportedAt === "string" ? o.exportedAt : "",
    blocks: normalizeBlocks(o.blocks),
    views: normalizeViews(o.views),
    available: normalizeAvailable(o.available),
    settings: normalizeSettings(o.settings),
  };
}

function mergeBlocks(a: BlockData, b: BlockData): BlockData {
  return {
    videos: [...new Set([...a.videos, ...b.videos])],
    channels: [...new Set([...a.channels, ...b.channels])],
  };
}

function mergeViews(a: ViewsMap, b: ViewsMap): ViewsMap {
  const out: ViewsMap = { ...a };
  for (const [id, entry] of Object.entries(b)) {
    const cur = out[id];
    if (!cur) {
      out[id] = { ...entry };
      continue;
    }
    out[id] = {
      count: Math.max(cur.count, entry.count),
      noFirst: !!(cur.noFirst || entry.noFirst),
    };
  }
  return out;
}

function mergeAvailable(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

export async function importBackup(file: BackupFile, mode: ImportMode): Promise<void> {
  if (mode === "replace") {
    await storageSet({
      [BLOCKS_KEY]: file.blocks,
      [VIEWS_KEY]: file.views,
      [AVAILABLE_KEY]: file.available,
      ...file.settings,
    });
    return;
  }

  const current = await readBackupFromStorage();
  await storageSet({
    [BLOCKS_KEY]: mergeBlocks(current.blocks, file.blocks),
    [VIEWS_KEY]: mergeViews(current.views, file.views),
    [AVAILABLE_KEY]: mergeAvailable(current.available, file.available),
  });
}

export function downloadBackupFile(data: BackupFile): void {
  const stamp = data.exportedAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `youtube-improve-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

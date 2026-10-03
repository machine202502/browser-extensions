import {
  downloadBackupFile,
  importBackup,
  readBackupFromStorage,
  parseBackupText,
  type ImportMode,
} from "./backup";

interface Settings {
  blur: boolean;
  hoverPlay: boolean;
  blurAvatars: boolean;
  blurLinks: boolean;
  blockEnabled: boolean;
  viewsEnabled: boolean;
  dontRecommendEnabled: boolean;
  publicAvailable: boolean;
  hideShorts: boolean;
  autoHideEnabled: boolean;
  autoHideAfter: number;
}

const POPUP_DEFAULTS: Settings = {
  blur: true,
  hoverPlay: true,
  blurAvatars: true,
  blurLinks: true,
  blockEnabled: true,
  viewsEnabled: true,
  dontRecommendEnabled: true,
  publicAvailable: false,
  hideShorts: true,
  autoHideEnabled: true,
  autoHideAfter: 5,
};
const BOOL_KEYS: (keyof Omit<Settings, "autoHideAfter">)[] = [
  "blur",
  "hoverPlay",
  "blurAvatars",
  "blurLinks",
  "blockEnabled",
  "viewsEnabled",
  "publicAvailable",
  "hideShorts",
  "autoHideEnabled",
  "dontRecommendEnabled",
];

function clampAutoHideAfter(value: number): number {
  if (!Number.isFinite(value)) return POPUP_DEFAULTS.autoHideAfter;
  return Math.min(99, Math.max(1, Math.floor(value)));
}

function setStatus(text: string, isError = false): void {
  const el = document.getElementById("backupStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#c62828" : "#2e7d32";
}

function getImportMode(): ImportMode {
  const merge = document.getElementById("importMerge");
  if (merge instanceof HTMLInputElement && merge.checked) return "merge";
  return "replace";
}

function syncAutoHideField(enabled: boolean): void {
  const input = document.getElementById("autoHideAfter");
  const row = document.getElementById("autoHideAfterRow");
  if (input instanceof HTMLInputElement) input.disabled = !enabled;
  if (row instanceof HTMLElement) row.style.opacity = enabled ? "1" : "0.45";
}

function load(): void {
  chrome.storage.local.get(POPUP_DEFAULTS, (s: Partial<Settings>) => {
    for (const key of BOOL_KEYS) {
      const el = document.getElementById(key);
      if (el instanceof HTMLInputElement) el.checked = !!s[key];
    }
    const autoHide = document.getElementById("autoHideAfter");
    if (autoHide instanceof HTMLInputElement) {
      autoHide.value = String(clampAutoHideAfter(s.autoHideAfter ?? POPUP_DEFAULTS.autoHideAfter));
    }
    syncAutoHideField(s.autoHideEnabled !== false);
  });
}

for (const key of BOOL_KEYS) {
  const el = document.getElementById(key);
  if (!(el instanceof HTMLInputElement)) continue;
  el.addEventListener("change", () => {
    if (key === "autoHideEnabled") syncAutoHideField(el.checked);
    chrome.storage.local.get(POPUP_DEFAULTS, (s: Partial<Settings>) => {
      chrome.storage.local.set({ ...POPUP_DEFAULTS, ...s, [key]: el.checked });
    });
  });
}

const autoHideEl = document.getElementById("autoHideAfter");
autoHideEl?.addEventListener("change", () => {
  if (!(autoHideEl instanceof HTMLInputElement)) return;
  const n = clampAutoHideAfter(parseInt(autoHideEl.value, 10));
  autoHideEl.value = String(n);
  chrome.storage.local.get(POPUP_DEFAULTS, (s: Partial<Settings>) => {
    chrome.storage.local.set({ ...POPUP_DEFAULTS, ...s, autoHideAfter: n });
  });
});

document.getElementById("exportBtn")?.addEventListener("click", () => {
  void (async () => {
    try {
      setStatus("Выгрузка…");
      const data = await readBackupFromStorage();
      downloadBackupFile(data);
      setStatus("База сохранена в файл");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Ошибка выгрузки", true);
    }
  })();
});

const importFile = document.getElementById("importFile");
document.getElementById("importBtn")?.addEventListener("click", () => {
  if (importFile instanceof HTMLInputElement) {
    importFile.value = "";
    importFile.click();
  }
});

importFile?.addEventListener("change", () => {
  const input = importFile;
  if (!(input instanceof HTMLInputElement) || !input.files?.length) return;
  const file = input.files[0]!;
  void (async () => {
    try {
      setStatus("Загрузка…");
      const text = await file.text();
      const data = parseBackupText(text);
      await importBackup(data, getImportMode());
      load();
      setStatus(getImportMode() === "merge" ? "База объединена" : "База заменена");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Ошибка загрузки", true);
    }
  })();
});

load();

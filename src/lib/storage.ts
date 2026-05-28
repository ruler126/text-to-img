import type { ApiConfig, HistoryItem } from "../types";

const DB_NAME = "ecommerce-ai-image-studio";
const DB_VERSION = 1;
const HISTORY_KEY = "commerce-ai-history";
const CONFIG_KEY = "commerce-ai-api-config";
const MAX_HISTORY = 20;

const itemBlobIds = (entry: HistoryItem) =>
  [
    entry.imageBlobId,
    entry.thumbnailBlobId,
    entry.referenceImageBlobId,
    entry.referenceThumbnailBlobId,
  ].filter(Boolean) as string[];

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const dbStore = async (mode: IDBTransactionMode) => {
  const db = await openDb();
  return db.transaction("images", mode).objectStore("images");
};

export const saveBlob = async (id: string, blob: Blob) =>
  new Promise<void>(async (resolve, reject) => {
    const store = await dbStore("readwrite");
    const request = store.put(blob, id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

export const getBlob = async (id: string) =>
  new Promise<Blob | undefined>(async (resolve, reject) => {
    const store = await dbStore("readonly");
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error);
  });

export const deleteBlob = async (id: string) =>
  new Promise<void>(async (resolve, reject) => {
    const store = await dbStore("readwrite");
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

export const clearBlobs = async () =>
  new Promise<void>(async (resolve, reject) => {
    const store = await dbStore("readwrite");
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

export const loadHistory = (): HistoryItem[] => {
  try {
    const items = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryItem[];
    return items.map((item) => {
      const mode = item.job.mode ?? "text";
      return {
        ...item,
        job: {
          ...item.job,
          mode,
        },
      };
    });
  } catch {
    return [];
  }
};

export const addHistoryItem = async (item: HistoryItem) => {
  const current = loadHistory();
  const next = [item, ...current];
  const overflow = next.splice(MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  await Promise.all(overflow.flatMap((entry) => itemBlobIds(entry).map((id) => deleteBlob(id))));
  return next;
};

export const clearHistory = async () => {
  localStorage.removeItem(HISTORY_KEY);
  await clearBlobs();
};

export const saveApiConfig = (config: ApiConfig) => {
  if (!config.rememberConfig || config.usesServerDefault) {
    localStorage.removeItem(CONFIG_KEY);
    return;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    rememberConfig: config.rememberConfig,
    lastTestedAt: config.lastTestedAt,
  }));
};

export const hasSavedApiConfig = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null") as Partial<ApiConfig> | null;
    if (saved?.usesServerDefault) return false;
    return Boolean(saved?.baseURL || saved?.apiKey || saved?.model);
  } catch {
    return false;
  }
};

export const loadApiConfig = (): ApiConfig => {
  const fallback: ApiConfig = {
    baseURL: "",
    apiKey: "",
    model: "",
    rememberConfig: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") as Partial<ApiConfig>;
    return {
      ...fallback,
      baseURL: saved.baseURL ?? fallback.baseURL,
      apiKey: saved.apiKey ?? fallback.apiKey,
      model: saved.model ?? fallback.model,
      rememberConfig: saved.rememberConfig ?? fallback.rememberConfig,
      lastTestedAt: saved.lastTestedAt,
    };
  } catch {
    return fallback;
  }
};

export const clearApiConfig = () => localStorage.removeItem(CONFIG_KEY);

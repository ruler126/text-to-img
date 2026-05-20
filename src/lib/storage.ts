import type { ApiConfig, HistoryItem } from "../types";

const DB_NAME = "ecommerce-ai-image-studio";
const DB_VERSION = 1;
const HISTORY_KEY = "commerce-ai-history";
const CONFIG_KEY = "commerce-ai-api-config";
const MAX_HISTORY = 20;

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
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryItem[];
  } catch {
    return [];
  }
};

export const addHistoryItem = async (item: HistoryItem) => {
  const current = loadHistory();
  const next = [item, ...current];
  const overflow = next.splice(MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  await Promise.all(
    overflow.flatMap((entry) => [deleteBlob(entry.imageBlobId), deleteBlob(entry.thumbnailBlobId)]),
  );
  return next;
};

export const clearHistory = async () => {
  localStorage.removeItem(HISTORY_KEY);
  await clearBlobs();
};

export const saveApiConfig = (config: ApiConfig) => {
  if (!config.rememberConfig) {
    localStorage.removeItem(CONFIG_KEY);
    return;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
};

export const loadApiConfig = (): ApiConfig => {
  const fallback: ApiConfig = {
    baseURL: "",
    apiKey: "",
    model: "",
    rememberConfig: true,
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
};

export const clearApiConfig = () => localStorage.removeItem(CONFIG_KEY);

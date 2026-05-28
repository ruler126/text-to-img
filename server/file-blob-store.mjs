import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const textDecoder = new TextDecoder();

class PreconditionFailedError extends Error {
  constructor() {
    super("conditional write failed (key already exists)");
    this.name = "PreconditionFailedError";
    this.code = "PRECONDITION_FAILED";
  }
}

const toBuffer = async (value) => {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof Blob !== "undefined" && value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  if (value && typeof value.getReader === "function") {
    const chunks = [];
    const reader = value.getReader();
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(value ?? ""), "utf8");
};

export const makeFileBlobStore = ({ root = "data/blob-license" } = {}) => {
  const rootPath = resolve(root);

  const pathForKey = (key) => {
    const normalized = String(key ?? "").replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
      throw new Error(`Invalid blob key: ${key}`);
    }
    const target = resolve(rootPath, ...normalized.split("/"));
    const rel = relative(rootPath, target);
    if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`)) {
      throw new Error(`Invalid blob key: ${key}`);
    }
    return target;
  };

  const set = async (key, value, options = {}) => {
    const target = pathForKey(key);
    await mkdir(dirname(target), { recursive: true });
    const bytes = await toBuffer(value);
    if (!options.onlyIfNew) {
      await writeFile(target, bytes);
      return;
    }

    let file;
    try {
      file = await open(target, "wx");
      await file.writeFile(bytes);
    } catch (error) {
      if (error?.code === "EEXIST") throw new PreconditionFailedError();
      throw error;
    } finally {
      await file?.close();
    }
  };

  const get = async (key, options = {}) => {
    try {
      const bytes = await readFile(pathForKey(key));
      const type = options.type ?? "text";
      if (type === "json") return JSON.parse(textDecoder.decode(bytes));
      if (type === "arrayBuffer") return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      if (type === "blob") return new Blob([bytes]);
      if (type === "stream") return new Blob([bytes]).stream();
      return textDecoder.decode(bytes);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };

  const walk = async (dir, prefix = "") => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const keys = [];
    for (const entry of entries) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        keys.push(...await walk(target, key));
      } else if (entry.isFile()) {
        keys.push(key);
      }
    }
    return keys;
  };

  return {
    async set(key, value, options) {
      await set(key, value, options);
    },
    async setJSON(key, value, options) {
      await set(key, JSON.stringify(value), options);
    },
    async get(key, options) {
      return get(key, options);
    },
    async delete(key) {
      await rm(pathForKey(key), { force: true });
    },
    async list(options = {}) {
      const prefix = options.prefix ?? "";
      const keys = (await walk(rootPath))
        .filter((key) => key.startsWith(prefix))
        .sort();
      return {
        blobs: keys.map((key) => ({ key, etag: "" })),
        directories: [],
      };
    },
    async clear() {
      await rm(rootPath, { recursive: true, force: true });
    },
  };
};

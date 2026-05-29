import { randomBytes, createHash } from "node:crypto";
import { HttpError } from "./errors.mjs";

const CARD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const NUMBERS = "23456789";
const ALLOWED_TOTALS = new Set([10, 20, 30, 50, 100]);
const RESERVATION_TTL_MS = 30 * 60 * 1000;

const now = () => new Date().toISOString();
const future = (ms) => new Date(Date.now() + ms).toISOString();
const randomToken = () => randomBytes(32).toString("base64url");
const randomId = () => randomBytes(18).toString("base64url");

const cardKey = (code) => `cards/${code}.json`;
const sessionKey = (hash) => `sessions/${hash}.json`;
const imageJobKey = (id) => `image-jobs/${id}.json`;
const usagePrefix = (code) => `usage/${code}/`;
const slotKey = (code, slot) => `${usagePrefix(code)}${String(slot).padStart(4, "0")}.json`;

const isPreconditionFailed = (error) =>
  error?.code === "PRECONDITION_FAILED" || error?.name === "PreconditionFailedError";

const safeGetJson = async (blobStore, key) => {
  try {
    return await blobStore.get(key, { type: "json", consistency: "strong" });
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

const normalizeCode = (code) => String(code ?? "").trim().toUpperCase();

const normalizeCard = (record, usedUses = 0) => {
  if (!record) return null;
  const totalUses = Number(record.totalUses);
  return {
    code: record.code,
    totalUses,
    usedUses,
    remainingUses: Math.max(0, totalUses - usedUses),
    status: record.status,
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt ?? null,
    note: record.note ?? "",
  };
};

const parseReservationSlot = (id) => {
  const [slotText] = String(id ?? "").split("-");
  const slot = Number(slotText);
  return Number.isInteger(slot) && slot >= 0 ? slot : null;
};

export const makeBlobLicenseStore = ({ blobStore, sessionSecret = "change-this-secret", allowTestReset = false } = {}) => {
  if (!blobStore) throw new Error("makeBlobLicenseStore requires a blobStore.");

  const tokenHash = (token) => createHash("sha256").update(`${sessionSecret}:${token}`).digest("hex");

  const getUsageRecords = async (code) => {
    const { blobs } = await blobStore.list({ prefix: usagePrefix(code), consistency: "strong" });
    const records = await Promise.all(
      blobs
        .filter((item) => item.key.endsWith(".json"))
        .map(async (item) => {
          const record = await safeGetJson(blobStore, item.key);
          return record ? { ...record, key: item.key } : null;
        }),
    );
    return records.filter(Boolean);
  };

  const getUsageStats = async (code) => {
    const records = await getUsageRecords(code);
    const confirmed = records.filter((item) => item.status === "confirmed").length;
    const pending = records.filter((item) => item.status === "pending" && Date.parse(item.expiresAt) > Date.now()).length;
    return { confirmed, pending, records };
  };

  const getCardRecord = async (code) => safeGetJson(blobStore, cardKey(normalizeCode(code)));

  const getCard = async (code) => {
    const record = await getCardRecord(code);
    if (!record) return null;
    const { confirmed } = await getUsageStats(record.code);
    return normalizeCard(record, confirmed);
  };

  const deleteExpiredPendingReservations = async (code) => {
    const records = await getUsageRecords(code);
    await Promise.all(
      records
        .filter((item) => item.status === "pending" && Date.parse(item.expiresAt) <= Date.now())
        .map((item) => blobStore.delete(item.key)),
    );
  };

  const assertActiveCard = async (code) => {
    const card = await getCard(code);
    if (!card) throw new HttpError(404, "兑换码不存在。");
    if (card.status !== "active") throw new HttpError(403, "兑换码已被禁用。");
    return card;
  };

  const createSession = async ({ kind, code, ttlMs }) => {
    const token = randomToken();
    await blobStore.setJSON(sessionKey(tokenHash(token)), {
      kind,
      code: code ?? null,
      createdAt: now(),
      expiresAt: future(ttlMs),
    });
    return token;
  };

  const getSession = async (token, kind) => {
    if (!token) return null;
    const key = sessionKey(tokenHash(token));
    const session = await safeGetJson(blobStore, key);
    if (!session || session.kind !== kind) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await blobStore.delete(key);
      return null;
    }
    return session;
  };

  const deleteSession = async (token) => {
    if (!token) return;
    await blobStore.delete(sessionKey(tokenHash(token)));
  };

  const generateCode = () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const chars = Array.from({ length: 6 }, () => CARD_CHARS[randomBytes(1)[0] % CARD_CHARS.length]);
      if (!chars.some((char) => LETTERS.includes(char))) continue;
      if (!chars.some((char) => NUMBERS.includes(char))) continue;
      return chars.join("");
    }
    throw new HttpError(500, "生成兑换码失败，请重试。");
  };

  const createCards = async ({ totalUses, count, note = "" }) => {
    if (!ALLOWED_TOTALS.has(totalUses)) throw new HttpError(400, "不支持的次数档位。");
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new HttpError(400, "生成数量必须在 1 到 1000 之间。");

    const created = [];
    for (let index = 0; index < count; index += 1) {
      let createdCard = null;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const code = generateCode();
        const record = {
          code,
          totalUses,
          status: "active",
          createdAt: now(),
          lastLoginAt: null,
          note: String(note ?? "").slice(0, 200),
        };
        try {
          await blobStore.setJSON(cardKey(code), record, { onlyIfNew: true });
          createdCard = normalizeCard(record, 0);
          break;
        } catch (error) {
          if (isPreconditionFailed(error)) continue;
          throw error;
        }
      }
      if (!createdCard) throw new HttpError(500, "生成兑换码失败，请重试。");
      created.push(createdCard);
    }
    return created;
  };

  const loginCard = async (code) => {
    const normalized = normalizeCode(code);
    const card = await assertActiveCard(normalized);
    if (card.remainingUses <= 0) throw new HttpError(409, "当前兑换码次数已用完。");
    const record = await getCardRecord(normalized);
    await blobStore.setJSON(cardKey(normalized), { ...record, lastLoginAt: now() });
    return {
      token: await createSession({ kind: "card", code: normalized, ttlMs: 30 * 24 * 60 * 60 * 1000 }),
      card: await getCard(normalized),
    };
  };

  const requireCardSession = async (token) => {
    const session = await getSession(token, "card");
    if (!session?.code) throw new HttpError(401, "请先输入兑换码。");
    const card = await getCard(session.code);
    if (!card) throw new HttpError(401, "授权登录已失效。");
    if (card.status !== "active") throw new HttpError(403, "兑换码已被禁用。");
    return card;
  };

  const loginAdmin = async ({ password, adminPassword }) => {
    if (!adminPassword) throw new HttpError(500, "服务端未配置 ADMIN_PASSWORD。");
    if (String(password ?? "") !== adminPassword) throw new HttpError(401, "管理员密码错误。");
    return createSession({ kind: "admin", ttlMs: 12 * 60 * 60 * 1000 });
  };

  const requireAdminSession = async (token) => {
    if (!(await getSession(token, "admin"))) throw new HttpError(401, "请先登录管理员后台。");
  };

  const startUsage = async (token) => {
    const card = await requireCardSession(token);
    await deleteExpiredPendingReservations(card.code);
    const { confirmed, pending } = await getUsageStats(card.code);
    if (card.totalUses - confirmed - pending <= 0) throw new HttpError(409, "当前兑换码次数已用完。");

    for (let slot = 0; slot < card.totalUses; slot += 1) {
      const key = slotKey(card.code, slot);
      const existing = await safeGetJson(blobStore, key);
      if (existing?.status === "confirmed") continue;
      if (existing?.status === "pending" && Date.parse(existing.expiresAt) > Date.now()) continue;
      if (existing) await blobStore.delete(key);

      const reservation = {
        id: `${slot}-${randomId()}`,
        code: card.code,
        slot,
        status: "pending",
        createdAt: now(),
        expiresAt: future(RESERVATION_TTL_MS),
      };
      try {
        await blobStore.setJSON(key, reservation, { onlyIfNew: true });
        return { id: reservation.id, code: card.code, expiresAt: reservation.expiresAt };
      } catch (error) {
        if (isPreconditionFailed(error)) continue;
        throw error;
      }
    }

    throw new HttpError(409, "当前兑换码次数已用完。");
  };

  const completeUsage = async (token, id, success) => {
    const card = await requireCardSession(token);
    const slot = parseReservationSlot(id);
    if (slot === null || slot >= card.totalUses) throw new HttpError(404, "计次预占不存在。");
    const key = slotKey(card.code, slot);
    const reservation = await safeGetJson(blobStore, key);
    if (!reservation || reservation.id !== id) throw new HttpError(404, "计次预占不存在。");
    if (reservation.status !== "pending") return getCard(card.code);

    if (success) {
      await blobStore.setJSON(key, { ...reservation, status: "confirmed", confirmedAt: now() });
    } else {
      await blobStore.delete(key);
    }

    return getCard(card.code);
  };

  const createImageJob = async (token, job) => {
    const card = await requireCardSession(token);
    if (job.code !== card.code) throw new HttpError(403, "无权访问该图片任务。");
    const id = randomId();
    const record = {
      id,
      code: card.code,
      reservationId: job.reservationId,
      status: job.status ?? "pending",
      upstreamTaskId: job.upstreamTaskId ?? null,
      imageUrl: job.imageUrl ?? null,
      image: job.image ?? null,
      error: job.error ?? "",
      createdAt: now(),
      updatedAt: now(),
      expiresAt: future(RESERVATION_TTL_MS),
    };
    await blobStore.setJSON(imageJobKey(id), record, { onlyIfNew: true });
    return record;
  };

  const getImageJob = async (token, id) => {
    const card = await requireCardSession(token);
    const record = await safeGetJson(blobStore, imageJobKey(id));
    if (!record || record.code !== card.code) throw new HttpError(404, "图片任务不存在。");
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await blobStore.delete(imageJobKey(id));
      throw new HttpError(404, "图片任务已过期，请重新生成。");
    }
    return record;
  };

  const updateImageJob = async (token, id, patch) => {
    const current = await getImageJob(token, id);
    const next = {
      ...current,
      ...patch,
      id: current.id,
      code: current.code,
      reservationId: current.reservationId,
      updatedAt: now(),
    };
    await blobStore.setJSON(imageJobKey(id), next);
    return next;
  };

  const listCards = async () => {
    const { blobs } = await blobStore.list({ prefix: "cards/", consistency: "strong" });
    const cards = await Promise.all(
      blobs
        .filter((item) => item.key.endsWith(".json"))
        .map(async (item) => {
          const record = await safeGetJson(blobStore, item.key);
          if (!record) return null;
          const { confirmed } = await getUsageStats(record.code);
          return normalizeCard(record, confirmed);
        }),
    );
    return cards.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  };

  const updateCard = async (code, patch) => {
    const normalized = normalizeCode(code);
    const current = await getCardRecord(normalized);
    if (!current) throw new HttpError(404, "兑换码不存在。");
    const status = patch.status === "disabled" ? "disabled" : patch.status === "active" ? "active" : current.status;
    const note = patch.note === undefined ? current.note : String(patch.note ?? "").slice(0, 200);
    await blobStore.setJSON(cardKey(normalized), { ...current, status, note });
    return getCard(normalized);
  };

  const dangerouslyClearForTests = async () => {
    if (!allowTestReset) throw new Error("Test reset is not enabled for this store.");
    if (typeof blobStore.clear === "function") {
      await blobStore.clear();
      return;
    }
    const { blobs } = await blobStore.list({ consistency: "strong" });
    await Promise.all(blobs.map((item) => blobStore.delete(item.key)));
  };

  const close = async () => {};

  return {
    createCards,
    loginCard,
    loginAdmin,
    requireAdminSession,
    requireCardSession,
    startUsage,
    completeUsage,
    createImageJob,
    getImageJob,
    updateImageJob,
    listCards,
    updateCard,
    getCard,
    deleteSession,
    close,
    dangerouslyClearForTests,
  };
};

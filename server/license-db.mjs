import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./errors.mjs";

const CARD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const NUMBERS = "23456789";
const ALLOWED_TOTALS = new Set([10, 20, 30, 50, 100]);
const RESERVATION_TTL_MS = 30 * 60 * 1000;

export { HttpError };

export const makeLicenseStore = ({ dbPath = "data/cards.sqlite", sessionSecret = "dev-secret" } = {}) => {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      code TEXT PRIMARY KEY,
      total_uses INTEGER NOT NULL,
      used_uses INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      code TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (code) REFERENCES cards(code)
    );

    CREATE TABLE IF NOT EXISTS usage_reservations (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      FOREIGN KEY (code) REFERENCES cards(code)
    );

    CREATE TABLE IF NOT EXISTS image_jobs (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      upstream_task_id TEXT,
      image_url TEXT,
      image_b64_json TEXT,
      image_mime_type TEXT,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (code) REFERENCES cards(code)
    );
  `);

  const now = () => new Date().toISOString();
  const future = (ms) => new Date(Date.now() + ms).toISOString();
  const tokenHash = (token) => createHash("sha256").update(`${sessionSecret}:${token}`).digest("hex");
  const randomToken = () => randomBytes(32).toString("base64url");
  const randomId = () => randomBytes(18).toString("base64url");

  const normalizeCard = (row) => {
    if (!row) return null;
    return {
      code: row.code,
      totalUses: row.total_uses,
      usedUses: row.used_uses,
      remainingUses: Math.max(0, row.total_uses - row.used_uses),
      status: row.status,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      note: row.note ?? "",
    };
  };

  const releaseExpiredReservations = () => {
    db.prepare(
      "UPDATE usage_reservations SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
    ).run(now());
  };

  const getCardRow = (code) =>
    db.prepare("SELECT * FROM cards WHERE code = ?").get(String(code ?? "").trim().toUpperCase());

  const getCard = (code) => normalizeCard(getCardRow(code));

  const assertActiveUsableCard = (code) => {
    releaseExpiredReservations();
    const card = getCardRow(code);
    if (!card) throw new HttpError(404, "兑换码不存在。");
    if (card.status !== "active") throw new HttpError(403, "兑换码已被禁用。");
    const pending =
      db.prepare("SELECT COUNT(*) AS count FROM usage_reservations WHERE code = ? AND status = 'pending'").get(card.code)
        .count ?? 0;
    const available = card.total_uses - card.used_uses - pending;
    if (available <= 0) throw new HttpError(409, "当前兑换码次数已用完。");
    return card;
  };

  const createSession = ({ kind, code, ttlMs }) => {
    const token = randomToken();
    db.prepare(
      "INSERT INTO sessions (token_hash, kind, code, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(tokenHash(token), kind, code ?? null, now(), future(ttlMs));
    return token;
  };

  const getSession = (token, kind) => {
    if (!token) return null;
    const row = db
      .prepare("SELECT * FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ?")
      .get(tokenHash(token), kind, now());
    return row ?? null;
  };

  const deleteSession = (token) => {
    if (!token) return;
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  };

  const codeExists = (code) => Boolean(db.prepare("SELECT code FROM cards WHERE code = ?").get(code));
  const generateCode = () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const chars = Array.from({ length: 6 }, () => CARD_CHARS[randomBytes(1)[0] % CARD_CHARS.length]);
      if (!chars.some((char) => LETTERS.includes(char))) continue;
      if (!chars.some((char) => NUMBERS.includes(char))) continue;
      const code = chars.join("");
      if (!codeExists(code)) return code;
    }
    throw new HttpError(500, "生成兑换码失败，请重试。");
  };

  const createCards = ({ totalUses, count, note = "" }) => {
    if (!ALLOWED_TOTALS.has(totalUses)) throw new HttpError(400, "不支持的次数档位。");
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new HttpError(400, "生成数量必须在 1 到 1000 之间。");
    const created = [];
    const insert = db.prepare(
      "INSERT INTO cards (code, total_uses, used_uses, status, created_at, note) VALUES (?, ?, 0, 'active', ?, ?)",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < count; index += 1) {
        const code = generateCode();
        insert.run(code, totalUses, now(), String(note ?? "").slice(0, 200));
        created.push(getCard(code));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return created;
  };

  const loginCard = (code) => {
    const normalized = String(code ?? "").trim().toUpperCase();
    const card = getCardRow(normalized);
    if (!card) throw new HttpError(401, "兑换码无效。");
    if (card.status !== "active") throw new HttpError(403, "兑换码已被禁用。");
    if (card.total_uses - card.used_uses <= 0) throw new HttpError(409, "当前兑换码次数已用完。");
    db.prepare("UPDATE cards SET last_login_at = ? WHERE code = ?").run(now(), normalized);
    return {
      token: createSession({ kind: "card", code: normalized, ttlMs: 30 * 24 * 60 * 60 * 1000 }),
      card: getCard(normalized),
    };
  };

  const requireCardSession = (token) => {
    const session = getSession(token, "card");
    if (!session?.code) throw new HttpError(401, "请先输入兑换码。");
    const card = getCard(session.code);
    if (!card) throw new HttpError(401, "授权登录已失效。");
    if (card.status !== "active") throw new HttpError(403, "兑换码已被禁用。");
    return card;
  };

  const loginAdmin = ({ password, adminPassword }) => {
    if (!adminPassword) throw new HttpError(500, "服务端未配置 ADMIN_PASSWORD。");
    if (String(password ?? "") !== adminPassword) throw new HttpError(401, "管理员密码错误。");
    return createSession({ kind: "admin", ttlMs: 12 * 60 * 60 * 1000 });
  };

  const requireAdminSession = (token) => {
    if (!getSession(token, "admin")) throw new HttpError(401, "请先登录管理员后台。");
  };

  const startUsage = (token) => {
    const card = requireCardSession(token);
    db.exec("BEGIN IMMEDIATE");
    try {
      assertActiveUsableCard(card.code);
      const id = randomId();
      const expiresAt = future(RESERVATION_TTL_MS);
      db.prepare(
        "INSERT INTO usage_reservations (id, code, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)",
      ).run(id, card.code, now(), expiresAt);
      db.exec("COMMIT");
      return { id, code: card.code, expiresAt };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const completeUsage = (token, id, success) => {
    const card = requireCardSession(token);
    db.exec("BEGIN IMMEDIATE");
    try {
      releaseExpiredReservations();
      const row = db
        .prepare("SELECT * FROM usage_reservations WHERE id = ? AND code = ?")
        .get(String(id ?? ""), card.code);
      if (!row) throw new HttpError(404, "计次预占不存在。");
      if (row.status !== "pending") {
        db.exec("COMMIT");
        return getCard(card.code);
      }
      if (success) {
        db.prepare("UPDATE usage_reservations SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(now(), row.id);
        db.prepare("UPDATE cards SET used_uses = used_uses + 1 WHERE code = ?").run(card.code);
      } else {
        db.prepare("UPDATE usage_reservations SET status = 'failed' WHERE id = ?").run(row.id);
      }
      db.exec("COMMIT");
      return getCard(card.code);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const listCards = () =>
    db.prepare("SELECT * FROM cards ORDER BY created_at DESC").all().map((row) => normalizeCard(row));

  const updateCard = (code, patch) => {
    const normalized = String(code ?? "").trim().toUpperCase();
    const current = getCard(normalized);
    if (!current) throw new HttpError(404, "兑换码不存在。");
    const status = patch.status === "disabled" ? "disabled" : patch.status === "active" ? "active" : current.status;
    const note = patch.note === undefined ? current.note : String(patch.note ?? "").slice(0, 200);
    db.prepare("UPDATE cards SET status = ?, note = ? WHERE code = ?").run(status, note, normalized);
    return getCard(normalized);
  };

  const normalizeImageJob = (row) => {
    if (!row) return null;
    return {
      id: row.id,
      code: row.code,
      reservationId: row.reservation_id,
      status: row.status,
      upstreamTaskId: row.upstream_task_id,
      imageUrl: row.image_url,
      image: row.image_b64_json
        ? {
            b64Json: row.image_b64_json,
            mimeType: row.image_mime_type || "image/png",
          }
        : null,
      error: row.error ?? "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  };

  const getImageJobRow = (id) =>
    db.prepare("SELECT * FROM image_jobs WHERE id = ?").get(String(id ?? ""));

  const createImageJob = (token, job) => {
    const card = requireCardSession(token);
    if (job.code !== card.code) throw new HttpError(403, "无权访问该图片任务。");
    const id = randomId();
    const createdAt = now();
    db.prepare(`
      INSERT INTO image_jobs (
        id, code, reservation_id, status, upstream_task_id, image_url,
        image_b64_json, image_mime_type, error, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      card.code,
      job.reservationId,
      job.status ?? "pending",
      job.upstreamTaskId ?? null,
      job.imageUrl ?? null,
      job.image?.b64Json ?? null,
      job.image?.mimeType ?? null,
      job.error ?? "",
      createdAt,
      createdAt,
      future(RESERVATION_TTL_MS),
    );
    return normalizeImageJob(getImageJobRow(id));
  };

  const getImageJob = (token, id) => {
    const card = requireCardSession(token);
    const row = getImageJobRow(id);
    if (!row || row.code !== card.code) throw new HttpError(404, "图片任务不存在。");
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      db.prepare("DELETE FROM image_jobs WHERE id = ?").run(row.id);
      throw new HttpError(404, "图片任务已过期，请重新生成。");
    }
    return normalizeImageJob(row);
  };

  const updateImageJob = (token, id, patch) => {
    const current = getImageJob(token, id);
    const image = patch.image === undefined ? current.image : patch.image;
    db.prepare(`
      UPDATE image_jobs
      SET status = ?,
          upstream_task_id = ?,
          image_url = ?,
          image_b64_json = ?,
          image_mime_type = ?,
          error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      patch.status ?? current.status,
      patch.upstreamTaskId === undefined ? current.upstreamTaskId : patch.upstreamTaskId,
      patch.imageUrl === undefined ? current.imageUrl : patch.imageUrl,
      image?.b64Json ?? null,
      image?.mimeType ?? null,
      patch.error === undefined ? current.error : patch.error,
      now(),
      current.id,
    );
    return normalizeImageJob(getImageJobRow(current.id));
  };

  const close = () => db.close();

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
  };
};

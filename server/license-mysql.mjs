import { randomBytes, createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { HttpError } from "./errors.mjs";

const CARD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const NUMBERS = "23456789";
const ALLOWED_TOTALS = new Set([10, 20, 30, 50, 100]);
const RESERVATION_TTL_MS = 30 * 60 * 1000;

const now = () => new Date().toISOString();
const future = (ms) => new Date(Date.now() + ms).toISOString();

const normalizeRows = ([rows]) => rows;

const normalizeCard = (row) => {
  if (!row) return null;
  return {
    code: row.code,
    totalUses: Number(row.total_uses),
    usedUses: Number(row.used_uses),
    remainingUses: Math.max(0, Number(row.total_uses) - Number(row.used_uses)),
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    note: row.note ?? "",
  };
};

export const createMysqlPool = ({ databaseUrl, connectionLimit = 4 } = {}) => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for EdgeOne MySQL card storage.");
  }
  return mysql.createPool({
    uri: databaseUrl,
    waitForConnections: true,
    connectionLimit,
    charset: "utf8mb4",
  });
};

export const initMysqlSchema = async (pool) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cards (
      code VARCHAR(6) PRIMARY KEY,
      total_uses INT NOT NULL,
      used_uses INT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at VARCHAR(32) NOT NULL,
      last_login_at VARCHAR(32) NULL,
      note VARCHAR(200) NOT NULL DEFAULT '',
      INDEX idx_cards_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      kind VARCHAR(16) NOT NULL,
      code VARCHAR(6) NULL,
      created_at VARCHAR(32) NOT NULL,
      expires_at VARCHAR(32) NOT NULL,
      INDEX idx_sessions_kind_expires (kind, expires_at),
      INDEX idx_sessions_code (code),
      CONSTRAINT fk_sessions_cards
        FOREIGN KEY (code) REFERENCES cards(code)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_reservations (
      id VARCHAR(32) PRIMARY KEY,
      code VARCHAR(6) NOT NULL,
      status VARCHAR(16) NOT NULL,
      created_at VARCHAR(32) NOT NULL,
      expires_at VARCHAR(32) NOT NULL,
      confirmed_at VARCHAR(32) NULL,
      INDEX idx_usage_code_status (code, status),
      INDEX idx_usage_expires (expires_at),
      CONSTRAINT fk_usage_cards
        FOREIGN KEY (code) REFERENCES cards(code)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
};

export const makeMysqlLicenseStoreFromPool = async ({
  pool,
  sessionSecret = "change-this-secret",
  initialize = true,
  ownsPool = false,
  allowTestReset = false,
} = {}) => {
  if (!pool) throw new Error("makeMysqlLicenseStoreFromPool requires a MySQL pool.");
  if (initialize) await initMysqlSchema(pool);

  const tokenHash = (token) => createHash("sha256").update(`${sessionSecret}:${token}`).digest("hex");
  const randomToken = () => randomBytes(32).toString("base64url");
  const randomId = () => randomBytes(18).toString("base64url");

  const releaseExpiredReservations = async (executor) => {
    await executor.execute(
      "UPDATE usage_reservations SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
      [now()],
    );
  };

  const getCardRow = async (code, executor = pool, { lock = false } = {}) => {
    const rows = normalizeRows(
      await executor.execute(`SELECT * FROM cards WHERE code = ?${lock ? " FOR UPDATE" : ""}`, [
        String(code ?? "").trim().toUpperCase(),
      ]),
    );
    return rows[0] ?? null;
  };

  const getCard = async (code, executor = pool, options = {}) => normalizeCard(await getCardRow(code, executor, options));

  const getSession = async (token, kind, executor = pool) => {
    if (!token) return null;
    const rows = normalizeRows(
      await executor.execute(
        "SELECT * FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ? LIMIT 1",
        [tokenHash(token), kind, now()],
      ),
    );
    return rows[0] ?? null;
  };

  const deleteSession = async (token) => {
    if (!token) return;
    await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [tokenHash(token)]);
  };

  const codeExists = async (code, executor = pool) => {
    const rows = normalizeRows(await executor.execute("SELECT code FROM cards WHERE code = ? LIMIT 1", [code]));
    return rows.length > 0;
  };

  const generateCode = async (executor = pool) => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const chars = Array.from({ length: 6 }, () => CARD_CHARS[randomBytes(1)[0] % CARD_CHARS.length]);
      if (!chars.some((char) => LETTERS.includes(char))) continue;
      if (!chars.some((char) => NUMBERS.includes(char))) continue;
      const code = chars.join("");
      if (!(await codeExists(code, executor))) return code;
    }
    throw new HttpError(500, "生成卡密失败，请重试。");
  };

  const createSession = async ({ kind, code, ttlMs }, executor = pool) => {
    const token = randomToken();
    await executor.execute(
      "INSERT INTO sessions (token_hash, kind, code, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      [tokenHash(token), kind, code ?? null, now(), future(ttlMs)],
    );
    return token;
  };

  const assertActiveUsableCard = async (code, executor = pool, { lock = false } = {}) => {
    await releaseExpiredReservations(executor);
    const card = await getCardRow(code, executor, { lock });
    if (!card) throw new HttpError(404, "卡密不存在。");
    if (card.status !== "active") throw new HttpError(403, "卡密已被禁用。");
    const pendingRows = normalizeRows(
      await executor.execute(
        "SELECT COUNT(*) AS count FROM usage_reservations WHERE code = ? AND status = 'pending'",
        [card.code],
      ),
    );
    const pending = Number(pendingRows[0]?.count ?? 0);
    const available = Number(card.total_uses) - Number(card.used_uses) - pending;
    if (available <= 0) throw new HttpError(409, "当前卡密次数已用完。");
    return card;
  };

  const createCards = async ({ totalUses, count, note = "" }) => {
    if (!ALLOWED_TOTALS.has(totalUses)) throw new HttpError(400, "不支持的次数档位。");
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new HttpError(400, "生成数量必须在 1 到 1000 之间。");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const created = [];
      for (let index = 0; index < count; index += 1) {
        const code = await generateCode(connection);
        await connection.execute(
          "INSERT INTO cards (code, total_uses, used_uses, status, created_at, note) VALUES (?, ?, 0, 'active', ?, ?)",
          [code, totalUses, now(), String(note ?? "").slice(0, 200)],
        );
        created.push(await getCard(code, connection));
      }
      await connection.commit();
      return created;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };

  const loginCard = async (code) => {
    const normalized = String(code ?? "").trim().toUpperCase();
    const card = await getCardRow(normalized);
    if (!card) throw new HttpError(401, "卡密无效。");
    if (card.status !== "active") throw new HttpError(403, "卡密已被禁用。");
    if (Number(card.total_uses) - Number(card.used_uses) <= 0) throw new HttpError(409, "当前卡密次数已用完。");
    await pool.execute("UPDATE cards SET last_login_at = ? WHERE code = ?", [now(), normalized]);
    return {
      token: await createSession({ kind: "card", code: normalized, ttlMs: 30 * 24 * 60 * 60 * 1000 }),
      card: await getCard(normalized),
    };
  };

  const requireCardSession = async (token, executor = pool, { lock = false } = {}) => {
    const session = await getSession(token, "card", executor);
    if (!session?.code) throw new HttpError(401, "请先输入卡密登录。");
    const card = await getCard(session.code, executor, { lock });
    if (!card) throw new HttpError(401, "卡密登录已失效。");
    if (card.status !== "active") throw new HttpError(403, "卡密已被禁用。");
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
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const card = await requireCardSession(token, connection, { lock: true });
      await assertActiveUsableCard(card.code, connection, { lock: true });
      const id = randomId();
      const expiresAt = future(RESERVATION_TTL_MS);
      await connection.execute(
        "INSERT INTO usage_reservations (id, code, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)",
        [id, card.code, now(), expiresAt],
      );
      await connection.commit();
      return { id, code: card.code, expiresAt };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };

  const completeUsage = async (token, id, success) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const card = await requireCardSession(token, connection, { lock: true });
      await releaseExpiredReservations(connection);
      const rows = normalizeRows(
        await connection.execute(
          "SELECT * FROM usage_reservations WHERE id = ? AND code = ? FOR UPDATE",
          [String(id ?? ""), card.code],
        ),
      );
      const reservation = rows[0] ?? null;
      if (!reservation) throw new HttpError(404, "计次预占不存在。");
      if (reservation.status !== "pending") {
        await connection.commit();
        return getCard(card.code);
      }
      if (success) {
        await connection.execute(
          "UPDATE usage_reservations SET status = 'confirmed', confirmed_at = ? WHERE id = ?",
          [now(), reservation.id],
        );
        const [result] = await connection.execute(
          "UPDATE cards SET used_uses = used_uses + 1 WHERE code = ? AND used_uses < total_uses",
          [card.code],
        );
        if (result.affectedRows !== 1) throw new HttpError(409, "当前卡密次数已用完。");
      } else {
        await connection.execute("UPDATE usage_reservations SET status = 'failed' WHERE id = ?", [reservation.id]);
      }
      await connection.commit();
      return getCard(card.code);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };

  const listCards = async () => {
    const rows = normalizeRows(await pool.execute("SELECT * FROM cards ORDER BY created_at DESC"));
    return rows.map((row) => normalizeCard(row));
  };

  const updateCard = async (code, patch) => {
    const normalized = String(code ?? "").trim().toUpperCase();
    const current = await getCard(normalized);
    if (!current) throw new HttpError(404, "卡密不存在。");
    const status = patch.status === "disabled" ? "disabled" : patch.status === "active" ? "active" : current.status;
    const note = patch.note === undefined ? current.note : String(patch.note ?? "").slice(0, 200);
    await pool.execute("UPDATE cards SET status = ?, note = ? WHERE code = ?", [status, note, normalized]);
    return getCard(normalized);
  };

  const dangerouslyClearForTests = async () => {
    if (!allowTestReset) throw new Error("Test reset is not enabled for this store.");
    await pool.query("DELETE FROM usage_reservations");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM cards");
  };

  const close = async () => {
    if (ownsPool) await pool.end();
  };

  return {
    createCards,
    loginCard,
    loginAdmin,
    requireAdminSession,
    requireCardSession,
    startUsage,
    completeUsage,
    listCards,
    updateCard,
    getCard,
    deleteSession,
    close,
    dangerouslyClearForTests,
  };
};

export const makeMysqlLicenseStore = async ({
  databaseUrl = process.env.DATABASE_URL,
  sessionSecret = process.env.SESSION_SECRET ?? "change-this-secret",
  connectionLimit = Number(process.env.MYSQL_CONNECTION_LIMIT ?? 4) || 4,
  allowTestReset = false,
} = {}) => {
  const pool = createMysqlPool({ databaseUrl, connectionLimit });
  try {
    return await makeMysqlLicenseStoreFromPool({
      pool,
      sessionSecret,
      initialize: true,
      ownsPool: true,
      allowTestReset,
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
};

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { makeLicenseStore, HttpError } from "./license-db.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? "dist");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const store = makeLicenseStore({
  dbPath: process.env.CARD_DB_PATH ?? "data/cards.sqlite",
  sessionSecret: process.env.SESSION_SECRET ?? "change-this-secret",
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new HttpError(413, "请求体过大。"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError(400, "请求 JSON 格式错误。"));
      }
    });
    req.on("error", reject);
  });

const parseCookies = (req) =>
  Object.fromEntries(
    String(req.headers.cookie ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      }),
  );

const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

const clearCookie = (name) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const csvEscape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

const handleApi = async (req, res, url) => {
  const cookies = parseCookies(req);
  const body = req.method === "GET" ? {} : await readBody(req);

  if (req.method === "POST" && url.pathname === "/api/cards/login") {
    const { token, card } = store.loginCard(body.code);
    send(res, 200, { card }, { "Set-Cookie": cookie("card_session", token, 30 * 24 * 60 * 60) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/cards/logout") {
    store.deleteSession(cookies.card_session);
    send(res, 200, { ok: true }, { "Set-Cookie": clearCookie("card_session") });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/cards/me") {
    send(res, 200, { card: store.requireCardSession(cookies.card_session) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/cards/usage/start") {
    send(res, 200, { reservation: store.startUsage(cookies.card_session) });
    return;
  }
  const usageMatch = url.pathname.match(/^\/api\/cards\/usage\/([^/]+)\/(success|fail)$/);
  if (req.method === "POST" && usageMatch) {
    send(res, 200, { card: store.completeUsage(cookies.card_session, usageMatch[1], usageMatch[2] === "success") });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const token = store.loginAdmin({ password: body.password, adminPassword: ADMIN_PASSWORD });
    send(res, 200, { ok: true }, { "Set-Cookie": cookie("admin_session", token, 12 * 60 * 60) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/admin/cards") {
    store.requireAdminSession(cookies.admin_session);
    send(res, 200, { cards: store.listCards() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/admin/cards/batch") {
    store.requireAdminSession(cookies.admin_session);
    send(res, 200, { cards: store.createCards({ totalUses: Number(body.totalUses), count: Number(body.count), note: body.note }) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/admin/cards/export") {
    store.requireAdminSession(cookies.admin_session);
    const cards = store.listCards();
    if (body.format === "csv") {
      const header = ["code", "totalUses", "usedUses", "remainingUses", "status", "createdAt", "lastLoginAt", "note"];
      const rows = cards.map((card) => header.map((key) => csvEscape(card[key])).join(","));
      send(res, 200, [header.join(","), ...rows].join("\n"), {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=cards.csv",
      });
      return;
    }
    send(res, 200, { cards });
    return;
  }
  const adminCardMatch = url.pathname.match(/^\/api\/admin\/cards\/([^/]+)$/);
  if (req.method === "PATCH" && adminCardMatch) {
    store.requireAdminSession(cookies.admin_session);
    send(res, 200, { card: store.updateCard(adminCardMatch[1], body) });
    return;
  }

  throw new HttpError(404, "接口不存在。");
};

const serveStatic = (req, res, url) => {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const target = normalize(join(PUBLIC_DIR, requested));
  if (!target.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden");
    return;
  }
  const file = existsSync(target) && statSync(target).isFile() ? target : join(PUBLIC_DIR, "index.html");
  if (!existsSync(file)) {
    send(res, 404, "请先运行 npm run build 生成 dist。");
    return;
  }
  res.writeHead(200, { "Content-Type": mimeTypes[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    send(res, status, { error: error instanceof Error ? error.message : "服务端错误。" });
  }
}).listen(PORT, () => {
  console.log(`Card license server listening on http://127.0.0.1:${PORT}`);
});

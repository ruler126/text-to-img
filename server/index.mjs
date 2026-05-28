import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { makeLicenseStore, HttpError } from "./license-db.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? "dist");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const IMAGE_PROXY_BODY_LIMIT_MB = Math.max(1, Number(process.env.IMAGE_PROXY_BODY_LIMIT_MB ?? 25) || 25);
const IMAGE_PROXY_BODY_LIMIT_BYTES = IMAGE_PROXY_BODY_LIMIT_MB * 1024 * 1024;
const SERVER_API_CONFIG = {
  baseURL: process.env.API_BASE_URL ?? process.env.OPENAI_BASE_URL ?? process.env.IMAGE_API_BASE_URL ?? "",
  apiKey: process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.IMAGE_API_KEY ?? "",
  model: process.env.API_MODEL ?? process.env.OPENAI_MODEL ?? process.env.IMAGE_API_MODEL ?? "",
  rememberConfig: false,
};
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

const readBody = (req, { maxBytes = 1024 * 1024 } = {}) =>
  new Promise((resolveBody, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      body += chunk;
      if (bytes > maxBytes) {
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

const publicDefaultApiConfig = () => ({
  baseURL: SERVER_API_CONFIG.baseURL,
  model: SERVER_API_CONFIG.model,
  rememberConfig: false,
  hasApiKey: Boolean(SERVER_API_CONFIG.apiKey),
  usesServerDefault: true,
});

const normalizeBaseUrl = (baseURL) => String(baseURL ?? "").replace(/\/+$/, "");

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const isApimartLike = () =>
  SERVER_API_CONFIG.baseURL.includes("apimart.ai") || SERVER_API_CONFIG.model.toLowerCase().includes("gpt-image-2");

const validateServerApiConfig = () => {
  if (!SERVER_API_CONFIG.baseURL.trim()) throw new HttpError(500, "服务端未配置 API_BASE_URL。");
  if (!SERVER_API_CONFIG.apiKey.trim()) throw new HttpError(500, "服务端未配置 API_KEY。");
  if (!SERVER_API_CONFIG.model.trim()) throw new HttpError(500, "服务端未配置 API_MODEL。");
};

const fetchWithTimeout = async (url, options, timeoutMs, action) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (cause?.name === "AbortError") {
      throw new HttpError(504, `${action}超时，请稍后重试。`);
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
};

const readJsonResponse = async (response, action) => {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("text/html") || text.trimStart().startsWith("<!doctype") || text.trimStart().startsWith("<html")) {
    throw new HttpError(502, `${action}失败：接口返回了 HTML 页面，不是 JSON。`);
  }
  if (!response.ok) {
    throw new HttpError(502, `${action}失败：HTTP ${response.status}${text ? ` - ${text.slice(0, 180)}` : ""}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (cause) {
    throw new HttpError(502, `${action}失败：接口返回的不是合法 JSON。`);
  }
};

const extractImageUrl = (payload) => {
  const image = payload?.data?.[0] ?? payload?.data ?? payload;
  const url = image?.url ?? image?.image_url ?? image?.result?.images?.[0]?.url;
  if (Array.isArray(url)) return url[0] ?? "";
  if (typeof url === "string") return url;
  return "";
};

const fetchImageAsBase64 = async (url) => {
  const response = await fetchWithTimeout(url, {}, 45000, "下载生成图片");
  if (!response.ok) throw new HttpError(502, `下载生成图片失败：HTTP ${response.status}`);
  const mimeType = (response.headers.get("content-type") ?? "image/png").split(";")[0] || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { b64Json: buffer.toString("base64"), mimeType };
};

const pollTaskResult = async (taskId) => {
  const endpoint = `${normalizeBaseUrl(SERVER_API_CONFIG.baseURL)}/tasks/${encodeURIComponent(taskId)}`;
  const maxAttempts = 42;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 10000 : 4000);
    const response = await fetchWithTimeout(endpoint, {
      headers: { Authorization: `Bearer ${SERVER_API_CONFIG.apiKey}` },
    }, 20000, "查询图片任务");
    const payload = await readJsonResponse(response, "查询任务");
    const data = payload?.data ?? payload;
    const status = data?.status;

    if (status === "failed") {
      throw new HttpError(502, data?.error?.message ?? data?.fail_reason ?? "图片生成任务失败。");
    }

    if (status === "completed") {
      const imageUrl = extractImageUrl(payload);
      if (!imageUrl) throw new HttpError(502, "任务已完成，但响应中没有找到图片 URL。");
      return fetchImageAsBase64(imageUrl);
    }
  }

  throw new HttpError(504, "图片生成任务等待超时。");
};

const extractImageOrPoll = async (payload) => {
  const image = payload?.data?.[0] ?? payload?.data ?? payload;

  if (image?.b64_json) {
    return { b64Json: image.b64_json, mimeType: "image/png" };
  }

  const imageUrl = extractImageUrl(payload);
  if (imageUrl) {
    return fetchImageAsBase64(imageUrl);
  }

  const taskId = image?.task_id ?? image?.id ?? payload?.task_id;
  if (taskId && image?.status !== "completed") {
    return pollTaskResult(String(taskId));
  }

  throw new HttpError(502, "接口返回中没有找到 b64_json、url 或 task_id 图片数据。");
};

const generateImageWithServerDefault = async (body) => {
  validateServerApiConfig();
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) throw new HttpError(400, "请填写图片提示词。");

  const apimartLike = isApimartLike();
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.filter((item) => typeof item === "string" && item.trim())
    : [];
  const endpoint = `${normalizeBaseUrl(SERVER_API_CONFIG.baseURL)}/images/generations`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVER_API_CONFIG.apiKey}`,
    },
    body: JSON.stringify({
      model: SERVER_API_CONFIG.model,
      prompt,
      size: apimartLike ? body.ratio : body.size,
      n: 1,
      quality: body.quality || undefined,
      resolution: apimartLike ? "1k" : undefined,
      image_urls: imageUrls.length > 0 ? imageUrls : undefined,
      response_format: apimartLike ? undefined : "b64_json",
    }),
  }, 45000, "提交生成任务");
  const payload = await readJsonResponse(response, "生成");
  return extractImageOrPoll(payload);
};

const testServerDefaultConnection = async () => {
  validateServerApiConfig();
  const endpoint = `${normalizeBaseUrl(SERVER_API_CONFIG.baseURL)}/models`;
  const response = await fetchWithTimeout(endpoint, {
    headers: { Authorization: `Bearer ${SERVER_API_CONFIG.apiKey}` },
  }, 20000, "连接测试");
  await readJsonResponse(response, "连接测试");
};

const generateImageForCard = async (body, cookies) => {
  const reservation = store.startUsage(cookies.card_session);
  try {
    const image = await generateImageWithServerDefault(body);
    const card = store.completeUsage(cookies.card_session, reservation.id, true);
    return { image, card };
  } catch (error) {
    try {
      store.completeUsage(cookies.card_session, reservation.id, false);
    } catch {
      // Keep the original third-party/API error visible to the caller.
    }
    throw error;
  }
};

const handleApi = async (req, res, url) => {
  const cookies = parseCookies(req);
  const isImageProxyRequest = req.method === "POST" && url.pathname === "/api/images/generations";
  const body = req.method === "GET" ? {} : await readBody(req, {
    maxBytes: isImageProxyRequest ? IMAGE_PROXY_BODY_LIMIT_BYTES : 1024 * 1024,
  });

  if (req.method === "GET" && url.pathname === "/api/config/default") {
    send(res, 200, { config: publicDefaultApiConfig() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/test") {
    await testServerDefaultConnection();
    send(res, 200, { ok: true });
    return;
  }

  if (isImageProxyRequest) {
    send(res, 200, await generateImageForCard(body, cookies));
    return;
  }

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

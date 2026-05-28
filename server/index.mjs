import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createApiHandler, getImageProxyBodyLimitBytes, getServerApiConfig } from "./api-handler.mjs";
import { makeMysqlLicenseStore } from "./license-mysql.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? "dist");

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

const sendText = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(body);
};

const requestHeaders = (req) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
};

const toWebRequest = (req, url) =>
  new Request(url.href, {
    method: req.method,
    headers: requestHeaders(req),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    duplex: req.method === "GET" || req.method === "HEAD" ? undefined : "half",
  });

const sendWebResponse = async (res, webResponse) => {
  const headers = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(webResponse.status, headers);
  res.end(Buffer.from(await webResponse.arrayBuffer()));
};

const serveStatic = (req, res, url) => {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const target = normalize(join(PUBLIC_DIR, requested));
  if (!target.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const file = existsSync(target) && statSync(target).isFile() ? target : join(PUBLIC_DIR, "index.html");
  if (!existsSync(file)) {
    sendText(res, 404, "请先运行 npm run build 生成 dist。");
    return;
  }
  res.writeHead(200, { "Content-Type": mimeTypes[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
};

const store = await makeMysqlLicenseStore({
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET ?? "change-this-secret",
});

const apiHandler = createApiHandler({
  store,
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  serverApiConfig: getServerApiConfig(process.env),
  imageProxyBodyLimitBytes: getImageProxyBodyLimitBytes(process.env),
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await sendWebResponse(res, await apiHandler(toWebRequest(req, url)));
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendText(res, 500, error instanceof Error ? error.message : "服务端错误。");
  }
}).listen(PORT, () => {
  console.log(`Card license server listening on http://127.0.0.1:${PORT}`);
});

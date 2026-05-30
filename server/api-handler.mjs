import { HttpError } from "./errors.mjs";

export const getServerApiConfig = (env = process.env) => ({
  baseURL: env.API_BASE_URL ?? env.OPENAI_BASE_URL ?? env.IMAGE_API_BASE_URL ?? "",
  apiKey: env.API_KEY ?? env.OPENAI_API_KEY ?? env.IMAGE_API_KEY ?? "",
  model: env.API_MODEL ?? env.OPENAI_MODEL ?? env.IMAGE_API_MODEL ?? "",
  rememberConfig: false,
});

export const getImageProxyBodyLimitBytes = (env = process.env) => {
  const defaultMb = 25;
  const value = Math.max(1, Number(env.IMAGE_PROXY_BODY_LIMIT_MB ?? defaultMb) || defaultMb);
  return value * 1024 * 1024;
};

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

const response = (status, body, headers = {}) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : jsonHeaders["Content-Type"],
      ...headers,
    },
  });
};

const readBody = async (request, { maxBytes = 1024 * 1024 } = {}) => {
  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new HttpError(413, "请求体过大。");
  }
  if (!buffer.byteLength) return {};
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpError(400, "请求 JSON 格式错误。");
  }
};

const parseCookies = (request) =>
  Object.fromEntries(
    String(request.headers.get("cookie") ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        if (index < 0) return [decodeURIComponent(item), ""];
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      }),
  );

const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

const clearCookie = (name) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const csvEscape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

const normalizeBaseUrl = (baseURL) => String(baseURL ?? "").replace(/\/+$/, "");

const isApimartLike = (serverApiConfig) =>
  serverApiConfig.baseURL.includes("apimart.ai") || serverApiConfig.model.toLowerCase().includes("gpt-image-2");

const logImageJob = (event, details = {}) => {
  console.info(`[image-job] ${event} ${JSON.stringify(details)}`);
};

const safeUrlHost = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

const publicDefaultApiConfig = (serverApiConfig) => ({
  baseURL: serverApiConfig.baseURL,
  model: serverApiConfig.model,
  rememberConfig: false,
  hasApiKey: Boolean(serverApiConfig.apiKey),
  usesServerDefault: true,
});

const validateServerApiConfig = (serverApiConfig) => {
  if (!serverApiConfig.baseURL.trim()) throw new HttpError(500, "服务端未配置 API_BASE_URL。");
  if (!serverApiConfig.apiKey.trim()) throw new HttpError(500, "服务端未配置 API_KEY。");
  if (!serverApiConfig.model.trim()) throw new HttpError(500, "服务端未配置 API_MODEL。");
};

const fetchWithTimeout = async (url, options, timeoutMs, action) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (cause?.name === "AbortError") {
      throw new HttpError(504, `${action}时间太久，暂时没有完成。请稍后再试。`);
    }
    throw new HttpError(502, `${action}暂时失败。请稍后再试。`);
  } finally {
    clearTimeout(timeout);
  }
};

const readJsonResponse = async (upstreamResponse, action) => {
  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  const text = await upstreamResponse.text();
  if (contentType.includes("text/html") || text.trimStart().startsWith("<!doctype") || text.trimStart().startsWith("<html")) {
    throw new HttpError(502, `${action}失败：接口返回了 HTML 页面，不是 JSON。`);
  }
  if (!upstreamResponse.ok) {
    throw new HttpError(502, `${action}失败：HTTP ${upstreamResponse.status}${text ? ` - ${text.slice(0, 180)}` : ""}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(502, `${action}失败：接口返回的不是合法 JSON。`);
  }
};

const collectPayloadObjects = (payload) => {
  const objects = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    objects.push(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    visit(value.data);
    visit(value.result);
    visit(value.output);
    visit(value.image);
    visit(value.images);
    visit(value.response);
  };
  visit(payload);
  return objects;
};

const normalizeTaskStatus = (status) => {
  const value = String(status ?? "").trim().toLowerCase();
  if (["completed", "complete", "succeeded", "success", "finished", "done"].includes(value)) return "completed";
  if (["failed", "fail", "error", "errored", "cancelled", "canceled"].includes(value)) return "failed";
  if (["pending", "queued", "queueing", "running", "processing", "in_progress", "submitted"].includes(value)) return "pending";
  return "";
};

const extractTaskStatus = (payload) => {
  for (const item of collectPayloadObjects(payload)) {
    const status = normalizeTaskStatus(item.status ?? item.state ?? item.task_status ?? item.taskStatus);
    if (status) return status;
  }
  return "";
};

const extractTaskError = (payload) => {
  const item = collectPayloadObjects(payload).find((entry) => entry.error || entry.fail_reason || entry.failReason) ?? {};
  return item.error?.message ?? item.fail_reason ?? item.failReason;
};

const extractBase64Image = (payload) => {
  for (const image of collectPayloadObjects(payload)) {
    const b64Json = image.b64_json ?? image.b64Json;
    if (typeof b64Json === "string" && b64Json) {
      return { b64Json, mimeType: image.mime_type ?? image.mimeType ?? "image/png" };
    }
  }
  return null;
};

const extractTaskId = (payload) =>
  collectPayloadObjects(payload)
    .map((item) => item.task_id ?? item.taskId ?? item.id)
    .find((value) => value);

const extractImageUrl = (payload) => {
  for (const image of collectPayloadObjects(payload)) {
    const url = image?.url ?? image?.image_url ?? image?.imageUrl ?? image?.result?.images?.[0]?.url ?? image?.images?.[0]?.url;
    if (Array.isArray(url) && url[0]) return url[0];
    if (typeof url === "string" && url) return url;
  }
  return "";
};

const summarizeImagePayload = (payload) => {
  const imageUrl = extractImageUrl(payload);
  return {
    status: extractTaskStatus(payload) || undefined,
    taskId: extractTaskId(payload) ? String(extractTaskId(payload)) : undefined,
    progress: collectPayloadObjects(payload).map((item) => item.progress).find((value) => value !== undefined),
    hasImageUrl: Boolean(imageUrl),
    imageHost: imageUrl ? safeUrlHost(imageUrl) : undefined,
    hasBase64: Boolean(extractBase64Image(payload)),
  };
};

const fetchImageAsBase64 = async (url) => {
  logImageJob("download.start", { host: safeUrlHost(url) });
  const upstreamResponse = await fetchWithTimeout(url, {}, 20000, "下载生成图片");
  if (!upstreamResponse.ok) throw new HttpError(502, `下载生成图片失败：HTTP ${upstreamResponse.status}`);
  const mimeType = (upstreamResponse.headers.get("content-type") ?? "image/png").split(";")[0] || "image/png";
  const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
  logImageJob("download.completed", { mimeType, bytes: buffer.byteLength });
  return { b64Json: buffer.toString("base64"), mimeType };
};

const extractImageState = (payload) => {
  const base64Image = extractBase64Image(payload);
  if (base64Image) {
    return { status: "completed", image: base64Image };
  }

  const imageUrl = extractImageUrl(payload);
  if (imageUrl) {
    return { status: "pending", imageUrl };
  }

  const taskId = extractTaskId(payload);
  if (taskId && extractTaskStatus(payload) !== "completed") {
    return { status: "pending", upstreamTaskId: String(taskId) };
  }

  throw new HttpError(502, "接口返回中没有找到 b64_json、url 或 task_id 图片数据。");
};

const submitImageGeneration = async (body, serverApiConfig) => {
  validateServerApiConfig(serverApiConfig);
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) throw new HttpError(400, "请填写图片提示词。");

  const apimartLike = isApimartLike(serverApiConfig);
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.filter((item) => typeof item === "string" && item.trim())
    : [];
  const endpoint = `${normalizeBaseUrl(serverApiConfig.baseURL)}/images/generations`;
  const upstreamResponse = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serverApiConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: serverApiConfig.model,
      prompt,
      size: apimartLike ? body.ratio : body.size,
      n: 1,
      quality: body.quality || undefined,
      resolution: apimartLike ? "1k" : undefined,
      image_urls: imageUrls.length > 0 ? imageUrls : undefined,
      response_format: apimartLike ? undefined : "b64_json",
    }),
  }, 25000, "提交生成任务");
  const payload = await readJsonResponse(upstreamResponse, "生成");
  logImageJob("submit.upstream", summarizeImagePayload(payload));
  const state = extractImageState(payload);
  logImageJob("submit.local", {
    status: state.status,
    upstreamTaskId: state.upstreamTaskId,
    hasImageUrl: Boolean(state.imageUrl),
    hasImage: Boolean(state.image),
  });
  return state;
};

const publicImageJob = (job) => ({
  id: job.id,
  status: job.status,
  expiresAt: job.expiresAt,
});

const resolveImageJob = async ({ store, serverApiConfig, cookies, id }) => {
  let job = await store.getImageJob(cookies.card_session, id);
  logImageJob("poll.local", {
    id,
    status: job.status,
    upstreamTaskId: job.upstreamTaskId,
    hasImageUrl: Boolean(job.imageUrl),
    hasImage: Boolean(job.image),
  });
  if (job.status === "completed") return { job: publicImageJob(job), image: job.image };
  if (job.status === "failed") throw new HttpError(502, job.error || "图片生成失败，请稍后再试。");

  if (job.imageUrl) {
    const image = await fetchImageAsBase64(job.imageUrl);
    job = await store.updateImageJob(cookies.card_session, id, {
      status: "completed",
      image,
      imageUrl: null,
    });
    return { job: publicImageJob(job), image };
  }

  if (!job.upstreamTaskId) return { job: publicImageJob(job) };

  const endpoint = `${normalizeBaseUrl(serverApiConfig.baseURL)}/tasks/${encodeURIComponent(job.upstreamTaskId)}?language=zh`;
  const upstreamResponse = await fetchWithTimeout(endpoint, {
    headers: { Authorization: `Bearer ${serverApiConfig.apiKey}` },
  }, 15000, "查询图片任务");
  const payload = await readJsonResponse(upstreamResponse, "查询任务");
  const status = extractTaskStatus(payload);
  logImageJob("poll.upstream", { id, ...summarizeImagePayload(payload) });

  if (status === "failed") {
    const error = extractTaskError(payload) ?? "图片生成失败，请稍后再试。";
    await store.updateImageJob(cookies.card_session, id, { status: "failed", error });
    throw new HttpError(502, error);
  }

  let state;
  try {
    state = extractImageState(payload);
  } catch (error) {
    if (status === "completed") throw error;
    job = await store.updateImageJob(cookies.card_session, id, { status: "pending" });
    return { job: publicImageJob(job) };
  }
  if (state.imageUrl) {
    const image = await fetchImageAsBase64(state.imageUrl);
    job = await store.updateImageJob(cookies.card_session, id, {
      status: "completed",
      image,
      upstreamTaskId: null,
      imageUrl: null,
    });
    logImageJob("poll.completed", { id, source: "url" });
    return { job: publicImageJob(job), image };
  }

  if (!state.image) {
    job = await store.updateImageJob(cookies.card_session, id, { status: "pending" });
    return { job: publicImageJob(job) };
  }

  job = await store.updateImageJob(cookies.card_session, id, {
    status: "completed",
    image: state.image,
    upstreamTaskId: null,
    imageUrl: null,
  });
  logImageJob("poll.completed", { id, source: "base64" });
  return { job: publicImageJob(job), image: state.image };
};

const testServerDefaultConnection = async (serverApiConfig) => {
  validateServerApiConfig(serverApiConfig);
  const endpoint = `${normalizeBaseUrl(serverApiConfig.baseURL)}/models`;
  const upstreamResponse = await fetchWithTimeout(endpoint, {
    headers: { Authorization: `Bearer ${serverApiConfig.apiKey}` },
  }, 20000, "连接测试");
  await readJsonResponse(upstreamResponse, "连接测试");
};

const generateImageForCard = async ({ store, serverApiConfig, body, cookies }) => {
  const reservation = await store.startUsage(cookies.card_session);
  try {
    const state = await submitImageGeneration(body, serverApiConfig);
    const job = await store.createImageJob(cookies.card_session, {
      code: reservation.code,
      reservationId: reservation.id,
      status: state.status,
      upstreamTaskId: state.upstreamTaskId,
      imageUrl: state.imageUrl,
      image: state.image,
    });
    return {
      job: publicImageJob(job),
      image: state.status === "completed" ? state.image : undefined,
      reservation,
    };
  } catch (error) {
    try {
      await store.completeUsage(cookies.card_session, reservation.id, false);
    } catch {
      // Keep the original third-party/API error visible to the caller.
    }
    throw error;
  }
};

export const createApiHandler = ({
  store,
  adminPassword = "",
  serverApiConfig = getServerApiConfig(),
  imageProxyBodyLimitBytes = getImageProxyBodyLimitBytes(),
} = {}) => {
  if (!store) throw new Error("createApiHandler requires a license store.");

  const handleApi = async (request) => {
    const url = new URL(request.url);
    const cookies = parseCookies(request);
    const isImageProxyRequest = request.method === "POST" && url.pathname === "/api/images/generations";
    const body = request.method === "GET" || request.method === "HEAD" ? {} : await readBody(request, {
      maxBytes: isImageProxyRequest ? imageProxyBodyLimitBytes : 1024 * 1024,
    });

    if (request.method === "GET" && url.pathname === "/api/config/default") {
      return response(200, { config: publicDefaultApiConfig(serverApiConfig) });
    }

    if (request.method === "POST" && url.pathname === "/api/config/test") {
      await testServerDefaultConnection(serverApiConfig);
      return response(200, { ok: true });
    }

    if (isImageProxyRequest) {
      return response(200, await generateImageForCard({ store, serverApiConfig, body, cookies }));
    }

    const imageJobMatch = url.pathname.match(/^\/api\/images\/jobs\/([^/]+)$/);
    if (request.method === "GET" && imageJobMatch) {
      return response(200, await resolveImageJob({ store, serverApiConfig, cookies, id: imageJobMatch[1] }));
    }

    if (request.method === "POST" && url.pathname === "/api/cards/login") {
      const { token, card } = await store.loginCard(body.code);
      return response(200, { card }, { "Set-Cookie": cookie("card_session", token, 30 * 24 * 60 * 60) });
    }
    if (request.method === "POST" && url.pathname === "/api/cards/logout") {
      await store.deleteSession(cookies.card_session);
      return response(200, { ok: true }, { "Set-Cookie": clearCookie("card_session") });
    }
    if (request.method === "GET" && url.pathname === "/api/cards/me") {
      return response(200, { card: await store.requireCardSession(cookies.card_session) });
    }
    if (request.method === "POST" && url.pathname === "/api/cards/usage/start") {
      return response(200, { reservation: await store.startUsage(cookies.card_session) });
    }
    const usageMatch = url.pathname.match(/^\/api\/cards\/usage\/([^/]+)\/(success|fail)$/);
    if (request.method === "POST" && usageMatch) {
      return response(200, { card: await store.completeUsage(cookies.card_session, usageMatch[1], usageMatch[2] === "success") });
    }

    if (request.method === "POST" && url.pathname === "/api/admin/login") {
      const token = await store.loginAdmin({ password: body.password, adminPassword });
      return response(200, { ok: true }, { "Set-Cookie": cookie("admin_session", token, 12 * 60 * 60) });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/logout") {
      await store.deleteSession(cookies.admin_session);
      return response(200, { ok: true }, { "Set-Cookie": clearCookie("admin_session") });
    }
    if (request.method === "GET" && url.pathname === "/api/admin/cards") {
      await store.requireAdminSession(cookies.admin_session);
      return response(200, { cards: await store.listCards() });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/cards/batch") {
      await store.requireAdminSession(cookies.admin_session);
      return response(200, {
        cards: await store.createCards({
          totalUses: Number(body.totalUses),
          count: Number(body.count),
          note: body.note,
          expiresInDays: body.expiresInDays,
        }),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/cards/export") {
      await store.requireAdminSession(cookies.admin_session);
      const cards = await store.listCards();
      if (body.format === "csv") {
        const header = ["code", "totalUses", "usedUses", "remainingUses", "status", "createdAt", "expiresAt", "lastLoginAt", "note"];
        const rows = cards.map((card) => header.map((key) => csvEscape(card[key])).join(","));
        return response(200, [header.join(","), ...rows].join("\n"), {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=cards.csv",
        });
      }
      return response(200, { cards });
    }
    const adminCardMatch = url.pathname.match(/^\/api\/admin\/cards\/([^/]+)$/);
    if (request.method === "PATCH" && adminCardMatch) {
      await store.requireAdminSession(cookies.admin_session);
      return response(200, { card: await store.updateCard(adminCardMatch[1], body) });
    }
    if (request.method === "DELETE" && adminCardMatch) {
      await store.requireAdminSession(cookies.admin_session);
      await store.deleteCard(adminCardMatch[1]);
      return response(200, { ok: true });
    }

    throw new HttpError(404, "接口不存在。");
  };

  return async (request) => {
    try {
      return await handleApi(request);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/images/")) {
        logImageJob("api.error", {
          path: url.pathname,
          status,
          message: error instanceof Error ? error.message : "服务端错误。",
        });
      }
      return response(status, { error: error instanceof Error ? error.message : "服务端错误。" });
    }
  };
};

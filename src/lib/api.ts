import type { ApiConfig, UsageReservation } from "../types";
import { base64ToBlob } from "./image";

const normalizeBaseUrl = (baseURL: string) => baseURL.replace(/\/+$/, "");
const htmlHint =
  "接口返回了 HTML 页面，不是 JSON。请检查 baseURL 是否为 API 地址，例如 https://example.com/v1，而不是网站首页或当前网站地址。";
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
type ProgressHandler = (message: string) => void;
const SERVER_IMAGE_PROXY_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
type ServerImageJob = {
  id: string;
  status: "pending" | "completed" | "failed";
  expiresAt: string;
};
type ServerImageResponse = {
  job?: ServerImageJob;
  image?: { b64Json?: string; mimeType?: string };
  reservation?: UsageReservation;
};

const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs: number, action: string) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new Error(`${action}时间太久，暂时没有完成。请稍后再试。`);
    }
    throw new Error(
      `${action}暂时失败。请稍后再试。`,
      { cause },
    );
  } finally {
    window.clearTimeout(timeout);
  }
};

const isApimartLike = (config: ApiConfig) =>
  config.baseURL.includes("apimart.ai") || config.model.toLowerCase().includes("gpt-image-2");

const readJsonResponse = async (response: Response, action: string) => {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (contentType.includes("text/html") || text.trimStart().startsWith("<!doctype") || text.trimStart().startsWith("<html")) {
    throw new Error(`${action}失败：${htmlHint}`);
  }

  if (!response.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.error ?? text;
    } catch {
      // Keep the raw response text when the API does not return a JSON error body.
    }
    throw new Error(`${action}失败：HTTP ${response.status}${message ? ` - ${message.slice(0, 180)}` : ""}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch (cause) {
    throw new Error(`${action}失败：接口返回的不是合法 JSON。请确认中转站兼容 OpenAI Images API。`, {
      cause,
    });
  }
};

const hasConfiguredApiKey = (config: ApiConfig) =>
  config.usesServerDefault ? Boolean(config.hasApiKey) : Boolean(config.apiKey.trim());

export const validateConfig = (config: ApiConfig) => {
  if (!config.baseURL.trim()) return "请填写 baseURL。";
  if (!hasConfiguredApiKey(config)) return "请填写 API Key。";
  if (!config.model.trim()) return "请填写模型名称。";
  return "";
};

const validateDirectConfig = (config: ApiConfig) => {
  if (!config.baseURL.trim()) return "请填写 baseURL。";
  if (!config.apiKey.trim()) return "请填写 API Key。";
  if (!config.model.trim()) return "请填写模型名称。";
  return "";
};

export const generateImage = async ({
  config,
  prompt,
  size,
  ratio,
  quality,
  imageUrls = [],
  onProgress,
}: {
  config: ApiConfig;
  prompt: string;
  size: string;
  ratio: string;
  quality: string;
  imageUrls?: string[];
  onProgress?: ProgressHandler;
}) => {
  const error = validateDirectConfig(config);
  if (error) throw new Error(error);

  const endpoint = `${normalizeBaseUrl(config.baseURL)}/images/generations`;
  let response: Response;
  try {
    onProgress?.("正在提交图片任务...");
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        prompt,
        size: isApimartLike(config) ? ratio : size,
        n: 1,
        quality: quality || undefined,
        resolution: isApimartLike(config) ? "1k" : undefined,
        image_urls: imageUrls.length > 0 ? imageUrls : undefined,
        response_format: isApimartLike(config) ? undefined : "b64_json",
      }),
    }, 45000, "提交生成任务");
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("超时")) {
      throw cause;
    }
    throw new Error(
      "连接失败。请检查 baseURL，或确认该中转站允许浏览器跨域请求（CORS）。",
      { cause },
    );
  }

  const payload = await readJsonResponse(response, "生成");
  return extractImageBlobOrPoll(config, payload, onProgress);
};

export const generateImageWithServerDefault = async ({
  prompt,
  size,
  ratio,
  quality,
  imageUrls = [],
  onProgress,
}: {
  prompt: string;
  size: string;
  ratio: string;
  quality: string;
  imageUrls?: string[];
  onProgress?: ProgressHandler;
}): Promise<{ blob: Blob; reservation: UsageReservation }> => {
  onProgress?.("正在通过服务器提交图片任务...");
  const requestBody = JSON.stringify({ prompt, size, ratio, quality, imageUrls });
  const requestBytes = new TextEncoder().encode(requestBody).byteLength;
  if (requestBytes > SERVER_IMAGE_PROXY_BODY_LIMIT_BYTES) {
    throw new Error("参考图数据过大，请压缩或更换参考图。");
  }
  const response = await fetchWithTimeout("/api/images/generations", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  }, 35000, "提交生成任务");
  const payload = await readJsonResponse(response, "提交生成任务") as ServerImageResponse;
  if (!payload.job || !payload.reservation) {
    throw new Error("服务器代理响应中没有找到图片任务或预占记录。");
  }
  if (payload.image?.b64Json) {
    onProgress?.("正在处理返回图片...");
    return {
      blob: base64ToBlob(payload.image.b64Json, payload.image.mimeType ?? "image/png"),
      reservation: payload.reservation,
    };
  }

  const image = await pollServerImageJob(payload.job.id, onProgress);
  return {
    blob: base64ToBlob(image.b64Json, image.mimeType ?? "image/png"),
    reservation: payload.reservation,
  };
};

const pollServerImageJob = async (
  jobId: string,
  onProgress?: ProgressHandler,
): Promise<{ b64Json: string; mimeType?: string }> => {
  const maxAttempts = 90;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 2500 : 3000);
    onProgress?.(`图片生成中，正在等待结果...`);
    const response = await fetchWithTimeout(`/api/images/jobs/${encodeURIComponent(jobId)}`, {
      credentials: "same-origin",
    }, 25000, "查询生成结果");
    const payload = await readJsonResponse(response, "查询生成结果") as ServerImageResponse;

    if (payload.image?.b64Json) {
      onProgress?.("正在处理返回图片...");
      return { b64Json: payload.image.b64Json, mimeType: payload.image.mimeType };
    }
    if (payload.job?.status === "failed") {
      throw new Error("图片生成失败，请稍后再试。");
    }
  }

  throw new Error("图片生成时间太久，暂时没有完成。请稍后再试。");
};
const extractImageUrl = (payload: any): string => {
  const image = payload?.data?.[0] ?? payload?.data ?? payload;
  const url = image?.url ?? image?.image_url ?? image?.result?.images?.[0]?.url;
  if (Array.isArray(url)) return url[0] ?? "";
  if (typeof url === "string") return url;
  return "";
};

const extractImageBlobOrPoll = async (config: ApiConfig, payload: any, onProgress?: ProgressHandler): Promise<Blob> => {
  const image = payload?.data?.[0] ?? payload?.data ?? payload;

  if (image?.b64_json) {
    onProgress?.("正在处理返回图片...");
    return base64ToBlob(image.b64_json, "image/png");
  }

  const immediateUrl = extractImageUrl(payload);
  if (immediateUrl) {
    onProgress?.("正在下载生成结果...");
    return fetchImageBlob(immediateUrl);
  }

  const taskId = image?.task_id ?? image?.id ?? payload?.task_id;
  if (taskId && image?.status !== "completed") {
    return pollTaskResult(config, taskId, onProgress);
  }

  throw new Error("接口返回中没有找到 b64_json、url 或 task_id 图片数据。");
};

const fetchImageBlob = async (url: string) => {
  try {
    const imageResponse = await fetchWithTimeout(url, {}, 45000, "下载生成图片");
    if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`);
    return await imageResponse.blob();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("超时")) {
      throw cause;
    }
    throw new Error("接口返回了图片 URL，但浏览器无法跨域转存。请确认图片链接允许浏览器访问。", {
      cause,
    });
  }
};

const pollTaskResult = async (config: ApiConfig, taskId: string, onProgress?: ProgressHandler) => {
  const endpoint = `${normalizeBaseUrl(config.baseURL)}/tasks/${taskId}`;
  const maxAttempts = 42;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 10000 : 4000);
    onProgress?.(`图片任务处理中，正在第 ${attempt + 1}/${maxAttempts} 次查询...`);
    const response = await fetchWithTimeout(endpoint, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    }, 20000, "查询图片任务");
    const payload = await readJsonResponse(response, "查询任务");
    const data = payload?.data ?? payload;
    const status = data?.status;

    if (status === "failed") {
      throw new Error(data?.error?.message ?? data?.fail_reason ?? "图片生成任务失败。");
    }

    if (status === "completed") {
      const imageUrl = extractImageUrl(payload);
      if (!imageUrl) throw new Error("任务已完成，但响应中没有找到图片 URL。");
      onProgress?.("任务完成，正在下载生成结果...");
      return fetchImageBlob(imageUrl);
    }
  }

  throw new Error("图片生成任务等待超时。可能是服务商任务排队或卡住，请稍后重新点击生成/续改。");
};

export const testConnection = async (config: ApiConfig) => {
  const error = validateDirectConfig(config);
  if (error) throw new Error(error);
  const endpoint = `${normalizeBaseUrl(config.baseURL)}/models`;
  const response = await fetchWithTimeout(endpoint, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  }, 20000, "连接测试");
  await readJsonResponse(response, "连接测试");
  return true;
};

export const testServerConnection = async () => {
  const response = await fetchWithTimeout("/api/config/test", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  }, 20000, "连接测试");
  await readJsonResponse(response, "连接测试");
  return true;
};

import type { ApiConfig } from "../types";
import { base64ToBlob } from "./image";

const normalizeBaseUrl = (baseURL: string) => baseURL.replace(/\/+$/, "");
const htmlHint =
  "接口返回了 HTML 页面，不是 JSON。请检查 baseURL 是否为 API 地址，例如 https://example.com/v1，而不是网站首页或当前网站地址。";
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const isApimartLike = (config: ApiConfig) =>
  config.baseURL.includes("apimart.ai") || config.model.toLowerCase().includes("gpt-image-2");

const readJsonResponse = async (response: Response, action: string) => {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (contentType.includes("text/html") || text.trimStart().startsWith("<!doctype") || text.trimStart().startsWith("<html")) {
    throw new Error(`${action}失败：${htmlHint}`);
  }

  if (!response.ok) {
    throw new Error(`${action}失败：HTTP ${response.status}${text ? ` - ${text.slice(0, 180)}` : ""}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch (cause) {
    throw new Error(`${action}失败：接口返回的不是合法 JSON。请确认中转站兼容 OpenAI Images API。`, {
      cause,
    });
  }
};

export const validateConfig = (config: ApiConfig) => {
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
}: {
  config: ApiConfig;
  prompt: string;
  size: string;
  ratio: string;
  quality: string;
}) => {
  const error = validateConfig(config);
  if (error) throw new Error(error);

  const endpoint = `${normalizeBaseUrl(config.baseURL)}/images/generations`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
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
        response_format: isApimartLike(config) ? undefined : "b64_json",
      }),
    });
  } catch (cause) {
    throw new Error(
      "连接失败。请检查 baseURL，或确认该中转站允许浏览器跨域请求（CORS）。",
      { cause },
    );
  }

  const payload = await readJsonResponse(response, "生成");
  return extractImageBlobOrPoll(config, payload);
};

const extractImageUrl = (payload: any): string => {
  const image = payload?.data?.[0] ?? payload?.data ?? payload;
  const url = image?.url ?? image?.image_url ?? image?.result?.images?.[0]?.url;
  if (Array.isArray(url)) return url[0] ?? "";
  if (typeof url === "string") return url;
  return "";
};

const extractImageBlobOrPoll = async (config: ApiConfig, payload: any): Promise<Blob> => {
  const image = payload?.data?.[0] ?? payload?.data ?? payload;

  if (image?.b64_json) {
    return base64ToBlob(image.b64_json, "image/png");
  }

  const immediateUrl = extractImageUrl(payload);
  if (immediateUrl) {
    return fetchImageBlob(immediateUrl);
  }

  const taskId = image?.task_id ?? image?.id ?? payload?.task_id;
  if (taskId && image?.status !== "completed") {
    return pollTaskResult(config, taskId);
  }

  throw new Error("接口返回中没有找到 b64_json、url 或 task_id 图片数据。");
};

const fetchImageBlob = async (url: string) => {
  try {
    const imageResponse = await fetch(url);
    if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`);
    return await imageResponse.blob();
  } catch (cause) {
    throw new Error("接口返回了图片 URL，但浏览器无法跨域转存。请确认图片链接允许浏览器访问。", {
      cause,
    });
  }
};

const pollTaskResult = async (config: ApiConfig, taskId: string) => {
  const endpoint = `${normalizeBaseUrl(config.baseURL)}/tasks/${taskId}`;
  const maxAttempts = 36;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 10000 : 4000);
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    const payload = await readJsonResponse(response, "查询任务");
    const data = payload?.data ?? payload;
    const status = data?.status;

    if (status === "failed") {
      throw new Error(data?.error?.message ?? data?.fail_reason ?? "图片生成任务失败。");
    }

    if (status === "completed") {
      const imageUrl = extractImageUrl(payload);
      if (!imageUrl) throw new Error("任务已完成，但响应中没有找到图片 URL。");
      return fetchImageBlob(imageUrl);
    }
  }

  throw new Error("图片生成任务仍在处理中，请稍后重试。");
};

export const testConnection = async (config: ApiConfig) => {
  const error = validateConfig(config);
  if (error) throw new Error(error);
  const endpoint = `${normalizeBaseUrl(config.baseURL)}/models`;
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  await readJsonResponse(response, "连接测试");
  return true;
};

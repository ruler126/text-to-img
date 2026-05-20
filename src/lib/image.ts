import type { ExportFormat, PlatformPreset } from "../types";

export const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export const base64ToBlob = (base64: string, mimeType = "image/png") => {
  const byteString = atob(base64);
  const bytes = new Uint8Array(byteString.length);
  for (let index = 0; index < byteString.length; index += 1) {
    bytes[index] = byteString.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
};

const loadImage = async (blob: Blob) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片加载失败，无法导出。"));
    };
    image.src = url;
  });

export const getImageDimensions = async (blob: Blob) => {
  const image = await loadImage(blob);
  return { width: image.width, height: image.height };
};

export const prepareReferenceImage = async (file: File, maxEdge = 1600) => {
  if (!file.type.startsWith("image/")) {
    throw new Error("请上传 PNG、JPG、JPEG 或 WebP 图片。");
  }

  const image = await loadImage(file);
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持参考图处理。");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (!result) reject(new Error("参考图压缩失败。"));
        else resolve(result);
      },
      "image/jpeg",
      0.9,
    );
  });

  return {
    blob,
    dataUrl: await blobToDataUrl(blob),
    fileName: file.name,
    width,
    height,
    size: blob.size,
  };
};

export const fitToPreset = async (
  blob: Blob,
  preset: PlatformPreset,
  format: ExportFormat = "image/png",
  quality = 0.92,
) => {
  const image = await loadImage(blob);
  const canvas = document.createElement("canvas");
  canvas.width = preset.width;
  canvas.height = preset.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持 Canvas 导出。");

  context.fillStyle = format === "image/jpeg" ? "#ffffff" : "transparent";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const x = Math.round((canvas.width - width) / 2);
  const y = Math.round((canvas.height - height) / 2);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, x, y, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (!result) reject(new Error("图片导出失败。"));
        else resolve(result);
      },
      format,
      quality,
    );
  });
};

export const makeThumbnail = async (blob: Blob) => {
  const preset: PlatformPreset = {
    id: "thumb",
    label: "缩略图",
    platform: "本地",
    ratio: "1:1",
    width: 360,
    height: 360,
    note: "",
  };
  return fitToPreset(blob, preset, "image/jpeg", 0.82);
};

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const safeFileName = (value: string) =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "image";

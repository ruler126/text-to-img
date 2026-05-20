export type TemplateCategory = "main" | "white" | "scene" | "detail" | "promo";

export type ExportFormat = "image/png" | "image/jpeg";

export interface ApiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  rememberConfig: boolean;
  lastTestedAt?: string;
}

export interface PlatformPreset {
  id: string;
  label: string;
  platform: string;
  ratio: string;
  width: number;
  height: number;
  note: string;
}

export interface GenerateJob {
  templateId: string;
  productName: string;
  category: string;
  sellingPoints: string;
  style: string;
  scene: string;
  platformPresetId: string;
  size: string;
  quality: string;
  extraPrompt: string;
}

export interface ImageTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  defaultSize: string;
  promptBuilder: (job: GenerateJob, preset: PlatformPreset) => string;
}

export interface HistoryItem {
  id: string;
  createdAt: string;
  templateId: string;
  templateName: string;
  prompt: string;
  model: string;
  platformPreset: PlatformPreset;
  imageBlobId: string;
  thumbnailBlobId: string;
  job: GenerateJob;
}

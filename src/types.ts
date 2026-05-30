export type TemplateCategory = "main" | "white" | "scene" | "detail" | "promo";

export type ExportFormat = "image/png" | "image/jpeg";

export type GenerateMode = "text" | "reference";

export interface ApiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  rememberConfig: boolean;
  hasApiKey?: boolean;
  usesServerDefault?: boolean;
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
  mode: GenerateMode;
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

export interface ReferenceImage {
  blob: Blob;
  dataUrl: string;
  fileName: string;
  width: number;
  height: number;
  size: number;
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
  referenceImageBlobId?: string;
  referenceThumbnailBlobId?: string;
  referenceImageName?: string;
  job: GenerateJob;
}

export interface CardSession {
  code: string;
  totalUses: number;
  usedUses: number;
  remainingUses: number;
  status: "active" | "disabled";
  expiresAt?: string | null;
}

export interface UsageReservation {
  id: string;
  code: string;
  expiresAt: string;
}

export interface AdminCard extends CardSession {
  createdAt: string;
  lastLoginAt?: string | null;
  note: string;
}

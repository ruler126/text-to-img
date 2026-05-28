import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  Eraser,
  ImageIcon,
  ImageUp,
  KeyRound,
  Loader2,
  Maximize2,
  RefreshCcw,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { categoryLabels, imageTemplates, platformPresets, scenes, styles } from "./data/presets";
import { generateImage, generateImageWithServerDefault, testConnection, testServerConnection, validateConfig } from "./lib/api";
import { CardLicensePanel } from "./card-license/CardLicensePanel";
import { cardApi } from "./card-license/api";
import { useCardLicense } from "./card-license/useCardLicense";
import {
  blobToDataUrl,
  downloadBlob,
  fitToPreset,
  makeThumbnail,
  prepareReferenceImage,
  safeFileName,
} from "./lib/image";
import {
  addHistoryItem,
  clearApiConfig,
  clearHistory,
  getBlob,
  hasSavedApiConfig,
  loadApiConfig,
  loadHistory,
  saveApiConfig,
  saveBlob,
} from "./lib/storage";
import type { ApiConfig, CardSession, ExportFormat, GenerateJob, HistoryItem, PlatformPreset, ReferenceImage } from "./types";

const initialJob: GenerateJob = {
  mode: "text",
  templateId: "main-clean",
  productName: "",
  category: "",
  sellingPoints: "",
  style: "现代简洁",
  scene: "现代家居",
  platformPresetId: "universal-square",
  size: "1024x1024",
  quality: "standard",
  extraPrompt: "",
};

const emptyServerApiConfig: ApiConfig = {
  baseURL: "",
  apiKey: "",
  model: "",
  rememberConfig: false,
  hasApiKey: false,
  usesServerDefault: true,
};

const normalizeServerApiConfig = (config?: Partial<ApiConfig> | null): ApiConfig => ({
  ...emptyServerApiConfig,
  baseURL: config?.baseURL ?? "",
  model: config?.model ?? "",
  hasApiKey: Boolean(config?.hasApiKey),
});

const uid = () => crypto.randomUUID();

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const prepareRevisionReference = async (blob: Blob): Promise<ReferenceImage> => {
  const file = new File([blob], "current-result.png", { type: blob.type || "image/png" });
  return prepareReferenceImage(file);
};

export function App() {
  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => loadApiConfig());
  const [serverApiConfig, setServerApiConfig] = useState<ApiConfig | null>(null);
  const [hasLocalApiConfig, setHasLocalApiConfig] = useState(() => hasSavedApiConfig());
  const [job, setJob] = useState<GenerateJob>(initialJob);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultUrl, setResultUrl] = useState("");
  const [isResultPreviewOpen, setIsResultPreviewOpen] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isRevisingImage, setIsRevisingImage] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [operationStatus, setOperationStatus] = useState("");
  const [revisionPrompt, setRevisionPrompt] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const license = useCardLicense();

  const template = useMemo(
    () => imageTemplates.find((item) => item.id === job.templateId) ?? imageTemplates[0],
    [job.templateId],
  );
  const preset = useMemo(
    () => platformPresets.find((item) => item.id === job.platformPresetId) ?? platformPresets[0],
    [job.platformPresetId],
  );
  const prompt = useMemo(() => template.promptBuilder(job, preset), [job, preset, template]);
  const configReady = !validateConfig(apiConfig);
  const isServerDefaultConfig = !hasLocalApiConfig;
  const apiConfigSource = hasLocalApiConfig ? "前端配置" : serverApiConfig ? "服务器默认" : "未配置";
  const processingBlockedReason = license.blockedReason;
  const isProcessing = isGeneratingImage || isRevisingImage;

  useEffect(() => {
    if (hasLocalApiConfig) {
      saveApiConfig(apiConfig);
    }
  }, [apiConfig, hasLocalApiConfig]);

  useEffect(() => {
    if (hasLocalApiConfig) return;
    let alive = true;
    fetch("/api/config/default")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((payload: { config?: ApiConfig }) => {
        if (!alive || !payload.config) return;
        const nextConfig = normalizeServerApiConfig(payload.config);
        setServerApiConfig(nextConfig);
        setApiConfig(nextConfig);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [hasLocalApiConfig]);

  useEffect(() => {
    if (!resultBlob) {
      setResultUrl("");
      setIsResultPreviewOpen(false);
      return;
    }
    const url = URL.createObjectURL(resultBlob);
    setResultUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [resultBlob]);

  useEffect(() => {
    if (!isResultPreviewOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsResultPreviewOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isResultPreviewOpen]);

  const updateJob = <K extends keyof GenerateJob>(key: K, value: GenerateJob[K]) => {
    setJob((current) => ({ ...current, [key]: value }));
  };

  const updateApiConfig = <K extends keyof ApiConfig>(key: K, value: ApiConfig[K]) => {
    setHasLocalApiConfig(true);
    setApiConfig((current) => ({
      ...current,
      [key]: value,
      rememberConfig: true,
      hasApiKey: undefined,
      usesServerDefault: false,
    }));
  };

  const resetApiConfigToServerDefault = () => {
    clearApiConfig();
    setHasLocalApiConfig(false);
    setApiConfig(serverApiConfig ?? emptyServerApiConfig);
  };

  const handleGenerate = async (override?: GenerateJob, overrideReference?: ReferenceImage | null) => {
    const nextJob = override ?? job;
    const effectiveReference =
      nextJob.mode === "reference" ? (overrideReference === undefined ? referenceImage : overrideReference) : null;
    const selectedTemplate =
      imageTemplates.find((item) => item.id === nextJob.templateId) ?? imageTemplates[0];
    const selectedPreset =
      platformPresets.find((item) => item.id === nextJob.platformPresetId) ?? platformPresets[0];
    const generatedPrompt = selectedTemplate.promptBuilder(nextJob, selectedPreset);

    setError("");
    setNotice("");
    if (processingBlockedReason) {
      setError(processingBlockedReason);
      return;
    }
    if (!nextJob.productName.trim()) {
      setError("请先填写商品名称。");
      return;
    }
    const imageUrls = effectiveReference ? [effectiveReference.dataUrl] : [];
    if (nextJob.mode === "reference" && imageUrls.length === 0) {
      setError("商品参考图模式需要先上传一张真实商品图。");
      return;
    }

    setIsGeneratingImage(true);
    setOperationStatus("正在准备生成任务...");
    let reservationId = "";
    let completedCard: CardSession | null = null;
    try {
      let imageBlob: Blob;
      const generationOptions = {
        prompt: generatedPrompt,
        size: nextJob.size || selectedTemplate.defaultSize,
        ratio: selectedPreset.ratio,
        quality: nextJob.quality,
        imageUrls,
        onProgress: setOperationStatus,
      };
      if (hasLocalApiConfig) {
        const reservation = await cardApi.startUsage();
        reservationId = reservation.id;
        imageBlob = await generateImage({
          config: apiConfig,
          ...generationOptions,
        });
      } else {
        const result = await generateImageWithServerDefault(generationOptions);
        imageBlob = result.blob;
        completedCard = result.card;
      }
      const imageBlobId = uid();
      const thumbnailBlobId = uid();
      const thumbnail = await makeThumbnail(imageBlob);
      const referenceBlobId = nextJob.mode === "reference" && effectiveReference ? uid() : undefined;
      const referenceThumbnailBlobId = nextJob.mode === "reference" && effectiveReference ? uid() : undefined;
      const referenceThumbnail = effectiveReference ? await makeThumbnail(effectiveReference.blob) : undefined;
      await Promise.all([
        saveBlob(imageBlobId, imageBlob),
        saveBlob(thumbnailBlobId, thumbnail),
        referenceBlobId && effectiveReference ? saveBlob(referenceBlobId, effectiveReference.blob) : Promise.resolve(),
        referenceThumbnailBlobId && referenceThumbnail ? saveBlob(referenceThumbnailBlobId, referenceThumbnail) : Promise.resolve(),
      ]);

      const item: HistoryItem = {
        id: uid(),
        createdAt: new Date().toISOString(),
        templateId: selectedTemplate.id,
        templateName: selectedTemplate.name,
        prompt: generatedPrompt,
        model: apiConfig.model,
        platformPreset: selectedPreset,
        imageBlobId,
        thumbnailBlobId,
        referenceImageBlobId: referenceBlobId,
        referenceThumbnailBlobId,
        referenceImageName: effectiveReference?.fileName,
        job: nextJob,
      };
      setHistory(await addHistoryItem(item));
      setResultBlob(imageBlob);
      if (hasLocalApiConfig) {
        completedCard = await cardApi.finishUsage(reservationId, true);
      }
      if (completedCard) {
        license.setCardFromUsage(completedCard);
      }
      setOperationStatus("");
      setNotice("生成完成，已保存到本地历史。");
    } catch (caught) {
      if (hasLocalApiConfig && reservationId) {
        await cardApi.finishUsage(reservationId, false).catch(() => undefined);
        await license.refresh();
      } else {
        await license.refresh();
      }
      setError(caught instanceof Error ? caught.message : "生成失败，请检查 API 配置。");
    } finally {
      setOperationStatus("");
      setIsGeneratingImage(false);
    }
  };

  const handleReviseResult = async () => {
    setError("");
    setNotice("");
    if (processingBlockedReason) {
      setError(processingBlockedReason);
      return;
    }
    if (!resultBlob) {
      setError("请先生成一张图片，再继续修改。");
      return;
    }
    if (!revisionPrompt.trim()) {
      setError("请先填写想要修改的内容。");
      return;
    }

    setIsRevisingImage(true);
    setOperationStatus("正在准备续改参考图...");
    let reservationId = "";
    let completedCard: CardSession | null = null;
    try {
      const selectedTemplate = imageTemplates.find((item) => item.id === job.templateId) ?? imageTemplates[0];
      const revisionText = revisionPrompt.trim();
      const revisionImage = await prepareRevisionReference(resultBlob);
      const generatedPrompt = [
        "Use the provided current image as the visual reference.",
        "Revise only the areas described by the user while keeping the rest of the image as unchanged as possible.",
        "Preserve the product identity, shape, color, material, logo, packaging structure, composition, and commercial quality unless the user explicitly asks to change them.",
        `User revision request: ${revisionText}.`,
        `Original ecommerce context: ${selectedTemplate.promptBuilder(job, preset)}`,
      ].join(" ");
      let imageBlob: Blob;
      const generationOptions = {
        prompt: generatedPrompt,
        size: job.size || selectedTemplate.defaultSize,
        ratio: preset.ratio,
        quality: job.quality,
        imageUrls: [revisionImage.dataUrl],
        onProgress: setOperationStatus,
      };
      if (hasLocalApiConfig) {
        const reservation = await cardApi.startUsage();
        reservationId = reservation.id;
        imageBlob = await generateImage({
          config: apiConfig,
          ...generationOptions,
        });
      } else {
        const result = await generateImageWithServerDefault(generationOptions);
        imageBlob = result.blob;
        completedCard = result.card;
      }
      const imageBlobId = uid();
      const thumbnailBlobId = uid();
      const revisionBlobId = uid();
      const revisionThumbnailBlobId = uid();
      const thumbnail = await makeThumbnail(imageBlob);
      const revisionThumbnail = await makeThumbnail(revisionImage.blob);
      await Promise.all([
        saveBlob(imageBlobId, imageBlob),
        saveBlob(thumbnailBlobId, thumbnail),
        saveBlob(revisionBlobId, revisionImage.blob),
        saveBlob(revisionThumbnailBlobId, revisionThumbnail),
      ]);

      const item: HistoryItem = {
        id: uid(),
        createdAt: new Date().toISOString(),
        templateId: job.templateId,
        templateName: `${selectedTemplate.name} 续改`,
        prompt: generatedPrompt,
        model: apiConfig.model,
        platformPreset: preset,
        imageBlobId,
        thumbnailBlobId,
        referenceImageBlobId: revisionBlobId,
        referenceThumbnailBlobId: revisionThumbnailBlobId,
        referenceImageName: "current-result.jpg",
        job,
      };
      setHistory(await addHistoryItem(item));
      setResultBlob(imageBlob);
      setRevisionPrompt("");
      if (hasLocalApiConfig) {
        completedCard = await cardApi.finishUsage(reservationId, true);
      }
      if (completedCard) {
        license.setCardFromUsage(completedCard);
      }
      setOperationStatus("");
      setNotice("续改完成，已保存到本地历史。");
    } catch (caught) {
      if (hasLocalApiConfig && reservationId) {
        await cardApi.finishUsage(reservationId, false).catch(() => undefined);
        await license.refresh();
      } else {
        await license.refresh();
      }
      setError(caught instanceof Error ? caught.message : "续改失败，请检查 API 配置。");
    } finally {
      setOperationStatus("");
      setIsRevisingImage(false);
    }
  };

  const handleReferenceUpload = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setNotice("");
    try {
      const nextReference = await prepareReferenceImage(file);
      setReferenceImage(nextReference);
      updateJob("mode", "reference");
      setNotice("商品参考图已处理，生成时会发送给当前 API 服务商。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "参考图处理失败。");
    }
  };

  const openReferencePicker = () => {
    if (!referenceInputRef.current) return;
    referenceInputRef.current.value = "";
    referenceInputRef.current.click();
  };

  const handleReferenceInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    await handleReferenceUpload(file);
  };

  const handleTestConnection = async () => {
    setTestState("testing");
    setError("");
    try {
      if (hasLocalApiConfig) {
        await testConnection(apiConfig);
      } else {
        await testServerConnection();
      }
      const testedConfig = { ...apiConfig, lastTestedAt: new Date().toISOString() };
      setApiConfig(testedConfig);
      if (!hasLocalApiConfig) {
        setServerApiConfig(testedConfig);
      }
      setTestState("ok");
      setNotice("连接测试成功。");
    } catch (caught) {
      setTestState("fail");
      setError(caught instanceof Error ? caught.message : "连接测试失败。");
    }
  };

  const handleExport = async (blob: Blob | null, selectedPreset: PlatformPreset, format: ExportFormat) => {
    if (!blob) return;
    try {
      const exported = await fitToPreset(blob, selectedPreset, format);
      const ext = format === "image/png" ? "png" : "jpg";
      const filename = `${safeFileName(template.name)}-${safeFileName(selectedPreset.label)}-${Date.now()}.${ext}`;
      downloadBlob(exported, filename);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导出失败。");
    }
  };

  const openHistoryItem = async (item: HistoryItem) => {
    const blob = await getBlob(item.imageBlobId);
    if (blob) {
      setResultBlob(blob);
      setJob(item.job);
      if (item.referenceImageBlobId) {
        const referenceBlob = await getBlob(item.referenceImageBlobId);
        if (referenceBlob) {
          setReferenceImage({
            blob: referenceBlob,
            dataUrl: await blobToDataUrl(referenceBlob),
            fileName: item.referenceImageName ?? "reference-image.jpg",
            width: 0,
            height: 0,
            size: referenceBlob.size,
          });
        }
      } else {
        setReferenceImage(null);
      }
      setNotice("已载入历史图片和参数。");
    }
  };

  const regenerateHistoryItem = async (item: HistoryItem) => {
    const referenceBlob = item.referenceImageBlobId ? await getBlob(item.referenceImageBlobId) : undefined;
    const nextReference = referenceBlob
      ? {
          blob: referenceBlob,
          dataUrl: await blobToDataUrl(referenceBlob),
          fileName: item.referenceImageName ?? "reference-image.jpg",
          width: 0,
          height: 0,
          size: referenceBlob.size,
        }
      : null;
    await handleGenerate(item.job, nextReference);
  };

  const exportHistoryItem = async (item: HistoryItem) => {
    const blob = await getBlob(item.imageBlobId);
    if (!blob) return;
    const exported = await fitToPreset(blob, item.platformPreset, "image/png");
    downloadBlob(
      exported,
      `${safeFileName(item.templateName)}-${safeFileName(item.platformPreset.label)}-${Date.now()}.png`,
    );
  };

  const copyPrompt = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setNotice("提示词已复制。");
  };

  const resetJob = () => {
    setJob(initialJob);
    setReferenceImage(null);
  };

  return (
    <div className="min-h-screen bg-[#f6f8f8] text-ink">
      <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-white">
              <Sparkles size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">电商 AI 生图工作台</h1>
              <p className="hidden text-sm text-slate-500 sm:block">
                主图、白底、场景、详情、促销，一站式生成与规格导出
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`hidden rounded-full px-3 py-1 text-sm font-medium sm:inline-flex ${
                configReady ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
              }`}
            >
              {configReady ? `API 已配置 · ${apiConfigSource}` : "待配置 API"}
            </span>
            <button className="icon-button" onClick={() => setIsSettingsOpen(true)} title="API 设置">
              <Settings size={18} />
            </button>
            <CardLicensePanel
              card={license.card}
              isLoading={license.isLoading}
              message={license.message}
              onLogin={license.login}
              onLogout={license.logout}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-4 px-4 py-4 lg:grid-cols-[280px_minmax(0,1fr)_420px] lg:px-6">
        <aside className="panel order-1 lg:order-none">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">生成模板</h2>
            <Wand2 size={18} className="text-accent" />
          </div>
          <div className="space-y-3">
            {Object.entries(categoryLabels).map(([category, label]) => (
              <div key={category}>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {label}
                </div>
                <div className="space-y-2">
                  {imageTemplates
                    .filter((item) => item.category === category)
                    .map((item) => (
                      <button
                        key={item.id}
                        className={`template-card ${job.templateId === item.id ? "template-card-active" : ""}`}
                        onClick={() => {
                          updateJob("templateId", item.id);
                          updateJob("size", item.defaultSize);
                        }}
                      >
                        <span className="font-medium">{item.name}</span>
                        <span className="text-sm text-slate-500">{item.description}</span>
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-lg border border-dashed border-line bg-mist p-3 text-sm text-slate-600">
            平台规格会变化，导出预设用于生成初稿和本地裁剪，最终以上架后台要求为准。
          </div>
        </aside>

        <section className="panel order-2">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">图片参数</h2>
              <p className="text-sm text-slate-500">用结构化信息自动增强电商提示词。</p>
            </div>
            <button className="secondary-button" onClick={() => copyPrompt(prompt)}>
              <Copy size={16} />
              复制提示词
            </button>
          </div>

          <div className="mb-5 grid gap-3 rounded-lg border border-line bg-mist p-3">
            <input
              ref={referenceInputRef}
              className="hidden"
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp"
              onChange={handleReferenceInput}
            />
            <div className="flex flex-wrap gap-2">
              <button
                className={`mode-button ${job.mode === "text" ? "mode-button-active" : ""}`}
                onClick={() => updateJob("mode", "text")}
              >
                文生图
              </button>
              <button
                className={`mode-button ${job.mode === "reference" ? "mode-button-active" : ""}`}
                onClick={() => updateJob("mode", "reference")}
              >
                商品参考图
              </button>
            </div>
            {job.mode === "reference" && (
              <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
                <button className="upload-tile" type="button" onClick={openReferencePicker}>
                  {referenceImage ? (
                    <img src={referenceImage.dataUrl} alt="商品参考图" className="h-full w-full object-contain" />
                  ) : (
                    <span className="flex flex-col items-center gap-2 text-sm text-slate-500">
                      <ImageUp size={24} />
                      上传商品图
                    </span>
                  )}
                </button>
                <div className="flex min-w-0 flex-col justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-700">
                      {referenceImage ? referenceImage.fileName : "未选择商品参考图"}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {referenceImage
                        ? `${referenceImage.width || "?"}x${referenceImage.height || "?"} · ${formatBytes(referenceImage.size)}`
                        : "支持 PNG、JPG、JPEG、WebP，上传后会压缩到最长边 1600px。"}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      参考图保存在当前浏览器历史中；生成时会发送给你配置的 API 服务商。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="secondary-button" type="button" onClick={openReferencePicker}>
                      <ImageUp size={16} />
                      {referenceImage ? "替换图片" : "选择图片"}
                    </button>
                    <button className="secondary-button" disabled={!referenceImage} onClick={() => setReferenceImage(null)}>
                      <Trash2 size={16} />
                      删除参考图
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="商品名称" required>
              <input
                className="input"
                value={job.productName}
                onChange={(event) => updateJob("productName", event.target.value)}
                placeholder="例如：无线降噪耳机"
              />
            </Field>
            <Field label="商品类目">
              <input
                className="input"
                value={job.category}
                onChange={(event) => updateJob("category", event.target.value)}
                placeholder="例如：数码配件 / 家居用品"
              />
            </Field>
            <Field label="风格">
              <ComboInput
                value={job.style}
                options={styles}
                placeholder="选择或输入风格"
                onChange={(value) => updateJob("style", value)}
              />
            </Field>
            <Field label="场景 / 活动">
              <ComboInput
                value={job.scene}
                options={scenes}
                placeholder="选择或输入场景 / 活动"
                onChange={(value) => updateJob("scene", value)}
              />
            </Field>
            <Field label="平台规格">
              <select
                className="input"
                value={job.platformPresetId}
                onChange={(event) => updateJob("platformPresetId", event.target.value)}
              >
                {platformPresets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {item.width}x{item.height}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="模型尺寸">
              <select className="input" value={job.size} onChange={(event) => updateJob("size", event.target.value)}>
                <option value="1024x1024">1024x1024</option>
                <option value="1024x1536">1024x1536</option>
                <option value="1536x1024">1536x1024</option>
                <option value="auto">auto</option>
              </select>
            </Field>
            <Field label="质量">
              <select
                className="input"
                value={job.quality}
                onChange={(event) => updateJob("quality", event.target.value)}
              >
                <option value="standard">standard</option>
                <option value="hd">hd</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </Field>
            <Field label="规格说明">
              <div className="flex min-h-11 items-center rounded-lg border border-line bg-mist px-3 text-sm text-slate-600">
                {preset.platform} · {preset.ratio} · {preset.note}
              </div>
            </Field>
          </div>

          <div className="mt-4 grid gap-4">
            <Field label="核心卖点">
              <textarea
                className="input min-h-24 resize-y"
                value={job.sellingPoints}
                onChange={(event) => updateJob("sellingPoints", event.target.value)}
                placeholder="例如：40小时续航、主动降噪、佩戴舒适、送礼高级感"
              />
            </Field>
            <Field label="补充要求">
              <textarea
                className="input min-h-20 resize-y"
                value={job.extraPrompt}
                onChange={(event) => updateJob("extraPrompt", event.target.value)}
                placeholder="例如：背景不要太暗，商品占画面 70%，保留顶部文案区"
              />
            </Field>
            <Field label="当前提示词">
              <div className="max-h-36 overflow-auto rounded-lg border border-line bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                {prompt}
              </div>
            </Field>
          </div>

          {error && <Alert tone="error" message={error} />}
          {!error && processingBlockedReason && <Alert tone="error" message={processingBlockedReason} />}
          {!error && operationStatus && <Alert tone="ok" message={operationStatus} />}
          {notice && <Alert tone="ok" message={notice} />}

          <div className="sticky bottom-0 mt-5 flex flex-wrap gap-3 border-t border-line bg-white/95 py-4 backdrop-blur">
            <button className="primary-button" disabled={isProcessing || Boolean(processingBlockedReason)} onClick={() => handleGenerate()}>
              {isGeneratingImage ? <Loader2 className="animate-spin" size={18} /> : <Sparkles size={18} />}
              {isGeneratingImage ? "生成中" : "生成图片"}
            </button>
            <button className="secondary-button" onClick={resetJob}>
              <Eraser size={16} />
              重置参数
            </button>
          </div>
        </section>

        <section className="order-3 space-y-4">
          <div className="panel">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">生成结果</h2>
                <p className="text-sm text-slate-500">本地预览、下载和规格导出。</p>
              </div>
              <ImageIcon className="text-accent" size={20} />
            </div>
            <div className="result-stage">
              {resultUrl ? (
                <button
                  className="group relative grid h-full w-full place-items-center rounded-md outline-none focus-visible:ring-4 focus-visible:ring-teal-700/20"
                  type="button"
                  onClick={() => setIsResultPreviewOpen(true)}
                  title="查看大图"
                >
                  <img src={resultUrl} alt="生成结果" className="max-h-full max-w-full rounded-md object-contain" />
                  <span className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-lg bg-white/90 text-slate-700 opacity-0 shadow transition group-hover:opacity-100 group-focus-visible:opacity-100">
                    <Maximize2 size={17} />
                  </span>
                </button>
              ) : (
                <div className="text-center text-sm text-slate-500">
                  <ImageIcon className="mx-auto mb-2" size={30} />
                  生成后的图片会显示在这里
                </div>
              )}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button className="secondary-button justify-center" disabled={!resultBlob} onClick={() => resultBlob && downloadBlob(resultBlob, `${safeFileName(template.name)}-${Date.now()}.png`)}>
                <Download size={16} />
                原图
              </button>
              <button className="secondary-button justify-center" disabled={!resultBlob} onClick={() => handleExport(resultBlob, preset, "image/png")}>
                <Download size={16} />
                PNG规格
              </button>
              <button className="secondary-button justify-center" disabled={!resultBlob} onClick={() => handleExport(resultBlob, preset, "image/jpeg")}>
                <Download size={16} />
                JPG规格
              </button>
              <button className="secondary-button justify-center" disabled={!resultBlob} onClick={() => copyPrompt(prompt)}>
                <Copy size={16} />
                提示词
              </button>
            </div>
            <div className="mt-4 border-t border-line pt-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-700">继续修改</span>
                <textarea
                  className="input min-h-24 resize-y"
                  value={revisionPrompt}
                  onChange={(event) => setRevisionPrompt(event.target.value)}
                  placeholder="例如：把背景换成浅色厨房，右上角留出文案区域，其他部分尽量不变"
                />
              </label>
              <button
                className="primary-button mt-3 w-full"
                disabled={!resultBlob || isProcessing || Boolean(processingBlockedReason)}
                onClick={handleReviseResult}
              >
                {isRevisingImage ? <Loader2 className="animate-spin" size={18} /> : <RefreshCcw size={18} />}
                {isRevisingImage ? "续改中" : "继续修改图片"}
              </button>
              {!error && operationStatus && isRevisingImage && (
                <p className="mt-2 text-sm text-slate-500">{operationStatus}</p>
              )}
            </div>
          </div>

          <HistoryPanel
            history={history}
            onOpen={openHistoryItem}
            onRegenerate={regenerateHistoryItem}
            onCopyPrompt={copyPrompt}
            onExport={exportHistoryItem}
            onClear={async () => {
              await clearHistory();
              setHistory([]);
              setResultBlob(null);
              setNotice("历史记录已清空。");
            }}
          />
        </section>
      </main>

      {isResultPreviewOpen && resultUrl && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/85 p-3 sm:p-6"
          onClick={() => setIsResultPreviewOpen(false)}
        >
          <div className="relative flex h-full w-full max-w-[min(1200px,96vw)] items-center justify-center">
            <button
              className="absolute right-0 top-0 z-10 grid h-11 w-11 place-items-center rounded-lg bg-white text-slate-700 shadow-panel transition hover:text-accent"
              type="button"
              onClick={() => setIsResultPreviewOpen(false)}
              title="关闭大图"
            >
              <X size={20} />
            </button>
            <img
              src={resultUrl}
              alt="生成结果大图"
              className="max-h-[calc(100vh-2rem)] max-w-full rounded-lg bg-white object-contain shadow-panel sm:max-h-[calc(100vh-3rem)]"
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4">
          <div className="w-full max-w-xl rounded-xl bg-white p-5 shadow-panel">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">API 设置</h2>
                <p className="text-sm text-slate-500">
                  默认使用服务器环境配置；这里填写后会优先使用当前浏览器配置。
                </p>
              </div>
              <button className="icon-button" onClick={() => setIsSettingsOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4">
              <Field label="baseURL" required>
                <input
                  className="input"
                  value={apiConfig.baseURL}
                  onChange={(event) => updateApiConfig("baseURL", event.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
              <Field label="API Key" required>
                <input
                  className="input"
                  type="password"
                  value={isServerDefaultConfig ? "" : apiConfig.apiKey}
                  onChange={(event) => updateApiConfig("apiKey", event.target.value)}
                  placeholder={isServerDefaultConfig ? (apiConfig.hasApiKey ? "已由服务器配置，前端不会显示" : "服务器未配置 API Key") : "sk-..."}
                />
              </Field>
              <Field label="模型名称" required>
                <input
                  className="input"
                  value={apiConfig.model}
                  onChange={(event) => updateApiConfig("model", event.target.value)}
                  placeholder="gpt-image-1"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={apiConfig.rememberConfig}
                  onChange={(event) => {
                    setHasLocalApiConfig(true);
                    setApiConfig({
                      ...apiConfig,
                      rememberConfig: event.target.checked,
                      hasApiKey: undefined,
                      usesServerDefault: false,
                    });
                  }}
                />
                在本地浏览器记住配置
              </label>
              <div className="flex flex-wrap gap-2">
                <button className="primary-button" onClick={() => setIsSettingsOpen(false)}>
                  <KeyRound size={17} />
                  保存
                </button>
                <button className="secondary-button" onClick={handleTestConnection}>
                  {testState === "testing" ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                  测试连接
                </button>
                <button
                  className="danger-button"
                  onClick={resetApiConfigToServerDefault}
                >
                  <Trash2 size={16} />
                  恢复服务器默认
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-1 text-coral">*</span>}
      </span>
      {children}
    </label>
  );
}

function Alert({ tone, message }: { tone: "ok" | "error"; message: string }) {
  return (
    <div
      className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
        tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
      }`}
    >
      {message}
    </div>
  );
}

function ComboInput({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <input
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <div className="option-cloud">
        {options.map((item) => (
          <button
            className={`option-chip ${value === item ? "option-chip-active" : ""}`}
            key={item}
            type="button"
            onClick={() => onChange(item)}
            title={item}
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  );
}

function HistoryPanel({
  history,
  onOpen,
  onRegenerate,
  onCopyPrompt,
  onExport,
  onClear,
}: {
  history: HistoryItem[];
  onOpen: (item: HistoryItem) => void;
  onRegenerate: (item: HistoryItem) => void;
  onCopyPrompt: (prompt: string) => void;
  onExport: (item: HistoryItem) => void;
  onClear: () => void;
}) {
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [referenceThumbUrls, setReferenceThumbUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    Promise.all(
      history.map(async (item) => {
        const blob = await getBlob(item.thumbnailBlobId);
        const referenceBlob = item.referenceThumbnailBlobId ? await getBlob(item.referenceThumbnailBlobId) : undefined;
        return {
          id: item.id,
          thumb: blob ? await blobToDataUrl(blob) : "",
          referenceThumb: referenceBlob ? await blobToDataUrl(referenceBlob) : "",
        };
      }),
    ).then((entries) => {
      if (!alive) return;
      setThumbUrls(Object.fromEntries(entries.filter((entry) => entry.thumb).map((entry) => [entry.id, entry.thumb])));
      setReferenceThumbUrls(
        Object.fromEntries(entries.filter((entry) => entry.referenceThumb).map((entry) => [entry.id, entry.referenceThumb])),
      );
    });
    return () => {
      alive = false;
    };
  }, [history]);

  return (
    <div className="panel">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">本地历史</h2>
          <p className="text-sm text-slate-500">最多保留 20 条，仅存在浏览器。</p>
        </div>
        <button className="icon-button" onClick={onClear} title="清空历史">
          <Trash2 size={17} />
        </button>
      </div>
      {history.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-mist p-5 text-center text-sm text-slate-500">
          暂无历史记录
        </div>
      ) : (
        <div className="max-h-[560px] space-y-3 overflow-auto pr-1">
          {history.map((item) => (
            <article key={item.id} className="history-card">
              <button className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md bg-mist" onClick={() => onOpen(item)}>
                {thumbUrls[item.id] ? (
                  <img src={thumbUrls[item.id]} alt={item.templateName} className="h-full w-full object-cover" />
                ) : null}
                {referenceThumbUrls[item.id] ? (
                  <img
                    src={referenceThumbUrls[item.id]}
                    alt="参考图"
                    className="absolute bottom-1 right-1 h-7 w-7 rounded border border-white object-cover shadow-sm"
                  />
                ) : null}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="truncate text-sm font-semibold">{item.templateName}</h3>
                  <span className="shrink-0 text-xs text-slate-400">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="truncate text-xs text-slate-500">
                  {item.platformPreset.label} · {item.model} · {item.job.mode === "reference" ? "商品参考图" : "文生图"}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button className="tiny-button" onClick={() => onOpen(item)} title="打开">
                    <ImageIcon size={13} />
                  </button>
                  <button className="tiny-button" onClick={() => onRegenerate(item)} title="重新生成">
                    <RefreshCcw size={13} />
                  </button>
                  <button className="tiny-button" onClick={() => onCopyPrompt(item.prompt)} title="复制提示词">
                    <Copy size={13} />
                  </button>
                  <button className="tiny-button" onClick={() => onExport(item)} title="按规格导出">
                    <Download size={13} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

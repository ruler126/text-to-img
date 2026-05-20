import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  Eraser,
  ImageIcon,
  KeyRound,
  Loader2,
  RefreshCcw,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { categoryLabels, imageTemplates, platformPresets, scenes, styles } from "./data/presets";
import { generateImage, testConnection, validateConfig } from "./lib/api";
import { blobToDataUrl, downloadBlob, fitToPreset, makeThumbnail, safeFileName } from "./lib/image";
import {
  addHistoryItem,
  clearApiConfig,
  clearHistory,
  getBlob,
  loadApiConfig,
  loadHistory,
  saveApiConfig,
  saveBlob,
} from "./lib/storage";
import type { ApiConfig, ExportFormat, GenerateJob, HistoryItem, PlatformPreset } from "./types";

const initialJob: GenerateJob = {
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

const uid = () => crypto.randomUUID();

export function App() {
  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => loadApiConfig());
  const [job, setJob] = useState<GenerateJob>(initialJob);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultUrl, setResultUrl] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(!loadApiConfig().baseURL);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");

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

  useEffect(() => {
    saveApiConfig(apiConfig);
  }, [apiConfig]);

  useEffect(() => {
    if (!resultBlob) {
      setResultUrl("");
      return;
    }
    const url = URL.createObjectURL(resultBlob);
    setResultUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [resultBlob]);

  const updateJob = <K extends keyof GenerateJob>(key: K, value: GenerateJob[K]) => {
    setJob((current) => ({ ...current, [key]: value }));
  };

  const handleGenerate = async (override?: GenerateJob) => {
    const nextJob = override ?? job;
    const selectedTemplate =
      imageTemplates.find((item) => item.id === nextJob.templateId) ?? imageTemplates[0];
    const selectedPreset =
      platformPresets.find((item) => item.id === nextJob.platformPresetId) ?? platformPresets[0];
    const generatedPrompt = selectedTemplate.promptBuilder(nextJob, selectedPreset);

    setError("");
    setNotice("");
    if (!nextJob.productName.trim()) {
      setError("请先填写商品名称。");
      return;
    }

    setIsGenerating(true);
    try {
      const imageBlob = await generateImage({
        config: apiConfig,
        prompt: generatedPrompt,
        size: nextJob.size || selectedTemplate.defaultSize,
        ratio: selectedPreset.ratio,
        quality: nextJob.quality,
      });
      const imageBlobId = uid();
      const thumbnailBlobId = uid();
      const thumbnail = await makeThumbnail(imageBlob);
      await Promise.all([saveBlob(imageBlobId, imageBlob), saveBlob(thumbnailBlobId, thumbnail)]);

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
        job: nextJob,
      };
      setHistory(await addHistoryItem(item));
      setResultBlob(imageBlob);
      setNotice("生成完成，已保存到本地历史。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成失败，请检查 API 配置。");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleTestConnection = async () => {
    setTestState("testing");
    setError("");
    try {
      await testConnection(apiConfig);
      const testedConfig = { ...apiConfig, lastTestedAt: new Date().toISOString() };
      setApiConfig(testedConfig);
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
      setNotice("已载入历史图片和参数。");
    }
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
              {configReady ? "API 已配置" : "待配置 API"}
            </span>
            <button className="icon-button" onClick={() => setIsSettingsOpen(true)} title="API 设置">
              <Settings size={18} />
            </button>
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
              <select className="input" value={job.style} onChange={(event) => updateJob("style", event.target.value)}>
                {styles.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <Field label="场景 / 活动">
              <select className="input" value={job.scene} onChange={(event) => updateJob("scene", event.target.value)}>
                {scenes.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
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
          {notice && <Alert tone="ok" message={notice} />}

          <div className="sticky bottom-0 mt-5 flex flex-wrap gap-3 border-t border-line bg-white/95 py-4 backdrop-blur">
            <button className="primary-button" disabled={isGenerating} onClick={() => handleGenerate()}>
              {isGenerating ? <Loader2 className="animate-spin" size={18} /> : <Sparkles size={18} />}
              {isGenerating ? "生成中" : "生成图片"}
            </button>
            <button className="secondary-button" onClick={() => setJob(initialJob)}>
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
                <img src={resultUrl} alt="生成结果" className="max-h-full max-w-full rounded-md object-contain" />
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
          </div>

          <HistoryPanel
            history={history}
            onOpen={openHistoryItem}
            onRegenerate={(item) => handleGenerate(item.job)}
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

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4">
          <div className="w-full max-w-xl rounded-xl bg-white p-5 shadow-panel">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">API 设置</h2>
                <p className="text-sm text-slate-500">配置只保存在当前浏览器。</p>
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
                  onChange={(event) => setApiConfig({ ...apiConfig, baseURL: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
              <Field label="API Key" required>
                <input
                  className="input"
                  type="password"
                  value={apiConfig.apiKey}
                  onChange={(event) => setApiConfig({ ...apiConfig, apiKey: event.target.value })}
                  placeholder="sk-..."
                />
              </Field>
              <Field label="模型名称" required>
                <input
                  className="input"
                  value={apiConfig.model}
                  onChange={(event) => setApiConfig({ ...apiConfig, model: event.target.value })}
                  placeholder="gpt-image-1"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={apiConfig.rememberConfig}
                  onChange={(event) => setApiConfig({ ...apiConfig, rememberConfig: event.target.checked })}
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
                  onClick={() => {
                    clearApiConfig();
                    setApiConfig({ baseURL: "", apiKey: "", model: "", rememberConfig: true });
                  }}
                >
                  <Trash2 size={16} />
                  清除配置
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

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    Promise.all(
      history.map(async (item) => {
        const blob = await getBlob(item.thumbnailBlobId);
        if (!blob) return null;
        const url = await blobToDataUrl(blob);
        urls.push(url);
        return [item.id, url] as const;
      }),
    ).then((entries) => {
      if (!alive) return;
      setThumbUrls(Object.fromEntries(entries.filter(Boolean) as Array<[string, string]>));
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
              <button className="h-20 w-20 shrink-0 overflow-hidden rounded-md bg-mist" onClick={() => onOpen(item)}>
                {thumbUrls[item.id] ? (
                  <img src={thumbUrls[item.id]} alt={item.templateName} className="h-full w-full object-cover" />
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
                  {item.platformPreset.label} · {item.model}
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

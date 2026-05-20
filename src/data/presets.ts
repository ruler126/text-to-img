import type { ImageTemplate, PlatformPreset, TemplateCategory } from "../types";

export const platformPresets: PlatformPreset[] = [
  {
    id: "universal-square",
    label: "通用主图 1:1",
    platform: "通用电商",
    ratio: "1:1",
    width: 1024,
    height: 1024,
    note: "适合淘宝/天猫、京东、拼多多等商品主图初稿。",
  },
  {
    id: "detail-portrait",
    label: "详情页竖图 3:4",
    platform: "详情页",
    ratio: "3:4",
    width: 900,
    height: 1200,
    note: "适合卖点解释、使用步骤和详情页模块。",
  },
  {
    id: "commerce-four-five",
    label: "移动商品图 4:5",
    platform: "抖音电商",
    ratio: "4:5",
    width: 1080,
    height: 1350,
    note: "适合移动端商品展示和信息流素材。",
  },
  {
    id: "wide-scene",
    label: "横版场景图 16:9",
    platform: "京东/品牌页",
    ratio: "16:9",
    width: 1280,
    height: 720,
    note: "适合品牌页、活动横幅、场景氛围图。",
  },
  {
    id: "mobile-poster",
    label: "移动海报 9:16",
    platform: "小红书/抖音",
    ratio: "9:16",
    width: 1080,
    height: 1920,
    note: "适合竖版促销海报和短视频封面。",
  },
];

export const categoryLabels: Record<TemplateCategory, string> = {
  main: "商品主图",
  white: "白底图",
  scene: "场景图",
  detail: "详情页配图",
  promo: "节日促销",
};

const clean = (value: string, fallback: string) => value.trim() || fallback;

const sharedRules = [
  "high-end ecommerce product photography",
  "clear product silhouette",
  "commercially usable composition",
  "no fake watermark, no platform logo, no messy text",
  "leave safe margins for marketplace cropping",
  "sharp details, natural lighting, realistic material texture",
].join(", ");

const referenceRules = [
  "Use the uploaded product reference image as the source of truth",
  "preserve the exact product shape, color, material, logo, label, packaging structure, and key details",
  "do not redesign the product itself",
  "only improve the background, lighting, composition, scene, and commercial presentation",
].join(", ");

const modeRules = (job: { mode: string }) => (job.mode === "reference" ? `${referenceRules}, ` : "");

export const imageTemplates: ImageTemplate[] = [
  {
    id: "main-clean",
    name: "干净主图",
    category: "main",
    defaultSize: "1024x1024",
    description: "突出商品主体，适合列表和搜索结果展示。",
    promptBuilder: (job, preset) =>
      `${modeRules(job)}Create a ${preset.ratio} ecommerce main product image for ${clean(job.productName, "the product")}. Category: ${clean(job.category, "general merchandise")}. Selling points: ${clean(job.sellingPoints, "premium quality and practical design")}. Style: ${clean(job.style, "clean modern commercial")}. Use a simple bright background, centered product, strong but natural shadows, enough empty margin, ${sharedRules}. Output should match ${preset.platform} ${preset.label}. Extra request: ${clean(job.extraPrompt, "none")}.`,
  },
  {
    id: "white-background",
    name: "白底商品图",
    category: "white",
    defaultSize: "1024x1024",
    description: "生成干净白底效果，便于上架和二次编辑。",
    promptBuilder: (job, preset) =>
      `${modeRules(job)}Generate a ${preset.ratio} white-background ecommerce product image for ${clean(job.productName, "the product")}. Category: ${clean(job.category, "general merchandise")}. Remove the original background and keep the real product appearance, clean white background, soft contact shadow, accurate color, no props unless necessary, ${sharedRules}. Selling points to imply visually: ${clean(job.sellingPoints, "clean quality and reliable build")}. Platform target: ${preset.platform}, ${preset.label}. Extra request: ${clean(job.extraPrompt, "none")}.`,
  },
  {
    id: "lifestyle-scene",
    name: "生活场景图",
    category: "scene",
    defaultSize: "1024x1024",
    description: "把商品放入真实使用环境，增强购买想象。",
    promptBuilder: (job, preset) =>
      `${modeRules(job)}Create a realistic ${preset.ratio} lifestyle scene image for ${clean(job.productName, "the product")}. Scene: ${clean(job.scene, "modern home lifestyle setting")}. Category: ${clean(job.category, "consumer product")}. Highlight these selling points: ${clean(job.sellingPoints, "beautiful design and convenient use")}. Style: ${clean(job.style, "warm modern realistic")}. Product should be visually prominent and believable in the scene, ${sharedRules}. Platform target: ${preset.platform}, ${preset.label}. Extra request: ${clean(job.extraPrompt, "none")}.`,
  },
  {
    id: "detail-selling-point",
    name: "卖点详情图",
    category: "detail",
    defaultSize: "1024x1536",
    description: "适合详情页模块、功能解释和使用步骤配图。",
    promptBuilder: (job, preset) =>
      `${modeRules(job)}Design a ${preset.ratio} ecommerce detail-page visual for ${clean(job.productName, "the product")}. Category: ${clean(job.category, "general merchandise")}. Communicate these product benefits visually without relying on readable text: ${clean(job.sellingPoints, "quality, durability, ease of use")}. Layout should feel like a premium marketplace product detail module, with realistic product close-ups, material texture, use-case fragments, clean spacing, ${sharedRules}. Style: ${clean(job.style, "clean editorial ecommerce")}. Platform target: ${preset.platform}, ${preset.label}. Extra request: ${clean(job.extraPrompt, "none")}.`,
  },
  {
    id: "festival-promo",
    name: "节日促销图",
    category: "promo",
    defaultSize: "1024x1024",
    description: "用于活动氛围、促销封面和移动端海报。",
    promptBuilder: (job, preset) =>
      `${modeRules(job)}Create a ${preset.ratio} festive ecommerce campaign image for ${clean(job.productName, "the product")}. Festival or campaign scene: ${clean(job.scene, "618 shopping festival")}. Category: ${clean(job.category, "consumer product")}. Style: ${clean(job.style, "bright premium retail campaign")}. Highlight product value: ${clean(job.sellingPoints, "great value and gift-worthy presentation")}. Make it promotional but not cluttered, keep the referenced product accurate, leave space for optional marketing text, no fake price labels, ${sharedRules}. Platform target: ${preset.platform}, ${preset.label}. Extra request: ${clean(job.extraPrompt, "none")}.`,
  },
];

export const styles = [
  "现代简洁",
  "高级质感",
  "自然生活",
  "轻奢精品",
  "科技冷静",
  "温暖家居",
  "清新明亮",
  "直播间热卖",
];

export const scenes = [
  "现代家居",
  "办公室桌面",
  "户外露营",
  "厨房使用",
  "浴室护理",
  "运动健身",
  "春节年货",
  "618 大促",
  "双11 促销",
  "圣诞礼物",
];

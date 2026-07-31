import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_CLASS = "GJJ_LTX23ImageToVideoMultiRef";
const CONFIG_KEY = "gjj_ltx23_config";
const SCENE_COUNT_PROP = "__gjj_ltx_scene_count";
const SCENE_LINKS_PROP = "__gjj_ltx_scene_links";
const PANEL_WIDGET = "gjj_ltx23_clean_panel";
const SCENE_RE = /^(?:scene_0*(\d+)|场景\s*(\d+)|(?:🖼️\s*)?(\d+))$/i;
const FIRST_SCENE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const SCENE_TYPE = "IMAGE";
const FPS_SOCKET_TYPE = "INT,FLOAT";
const MAX_SCENES = 20;
const MULTI_IMAGE_LOADER_CLASS = "GJJ_MultiImageLoader";
const TEMP_UPLOAD_API_PATH = "/gjj/multi_image_loader/upload_temp_images";
const STATUS_WIDGET = "gjj_ltx23_preview_panel";
const LINKED_LOADER_PROP = "__gjj_ltx23_ref_loader_id";
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const CONVROT_STATUS_API = "/gjj/ltx23/convrot_w4a4_status";
const CONVROT_INSTALL_API = "/gjj/ltx23/install_comfy_kitchen";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const SHARED_PROMPT_SECTION = "mtv_ltx_prompt_bridge";

const DEFAULT_CONFIG = {
  ltx_model_name: "",
  positive_prompt: "多张参考图连续过渡，主体动作自然，镜头语言稳定，电影感光影，细节真实。",
  negative_prompt: "titles, subtitles, text, watermark, logo, blurry text, distorted text, overexposed, underexposed, low contrast, washed out colors, excessive noise, motion blur, camera shake, background clutter, unnatural skin tones, deformed facial features, extra limbs, disfigured hands, uncanny valley, mismatched lip sync, off-sync audio, jittery movement, awkward pauses, incorrect timing, AI artifacts",
  segment_seconds: 5.0,
  width: 1280,
  height: 720,
  fps: 24,
  seed: 483811081311996,
  denoise_strength: 1.0,
  transition_enabled: false,
  transition_curve: "前置过渡",
  transition_early_tail_ratio: 0.75,
  transition_implicit_guide_count: 2,
  transition_implicit_guide_strength: 0.55,
  transition_early_tail_strength: 0.75,
  transition_final_guide_strength: 1.0,
  segmented_execution: true,
  segment_save_preset: "video/GJJ_LTX多图分段",
  segment_video_format: "video/h264-mp4",
  ltx_video_vae_name: "",
  ltx_audio_vae_name: "",
  ltx_text_encoder_name: "",
  ltx_text_projection_name: "",
  ltx_latent_upscaler_name: "",
  transition_lora_name: "",
  transition_lora_enabled: true,
  transition_lora_strength: 1.0,
  test_lora_name: "LTX-2.3-Licon-MSR-V2.safetensors",
  test_lora_enabled: true,
  test_lora_strength: 1.0,
  auto_transition_prompt: false,
  transition_prompt_model: "Qwen3.5-4B-Uncensored-FP8_E4M3FN.safetensors",
  size_source: "面板尺寸",
  seed_mode: "固定",
  global_prompt: "",
  lora_slots: [],
  stage1_sampler: "euler_ancestral_cfg_pp",
  stage2_sampler: "euler_cfg_pp",
  stage1_steps: 0,
  stage2_steps: 0,
  stage1_sigmas: "",
  stage2_sigmas: "",
  cfg: 1.0,
  nag_scale: -1.0,
  nag_alpha: -1.0,
  nag_tau: -1.0,
  ff_chunks: 4,
  ff_dim_threshold: 4096,
  vae_tile_size: 512,
  vae_overlap: 64,
  vae_temporal_size: 512,
  vae_temporal_overlap: 4,
};

const SEED_MODES = ["固定", "随机", "递增", "递减"];
const SEED_MODE_STYLES = {
  "固定": { background: "linear-gradient(135deg,#26323a,#3b4650)", border: "#667681", color: "#edf3f5" },
  "随机": { background: "linear-gradient(135deg,#854d0e,#ca8a04)", border: "#facc15", color: "#fffbeb" },
  "递增": { background: "linear-gradient(135deg,#065f46,#059669)", border: "#34d399", color: "#ecfdf5" },
  "递减": { background: "linear-gradient(135deg,#4338ca,#6366f1)", border: "#a5b4fc", color: "#eef2ff" },
};

const MAIN_WIDGET_KEYS = [
  "ltx_model_name",
  "positive_prompt",
  "negative_prompt",
  "segment_seconds",
  "width",
  "height",
  "fps",
  "seed",
  "denoise_strength",
];
const NUMERIC_WIDGET_KEYS = new Set(["segment_seconds", "width", "height", "fps", "seed", "denoise_strength"]);
const HIDDEN_WIDGET_KEYS = new Set(MAIN_WIDGET_KEYS.filter(key => key !== "positive_prompt"));

async function readSharedPromptSettings() {
  const response = await api.fetchApi(USER_SETTINGS_ENDPOINT);
  const data = await response.json();
  return data?.settings?.[SHARED_PROMPT_SECTION] || {};
}

async function writeSharedPromptSetting(name, value) {
  await api.fetchApi(USER_SETTINGS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ section: SHARED_PROMPT_SECTION, values: { [name]: value } }),
  });
}

function sharedPromptInput(name, value, rows = 5) {
  const input = document.createElement("textarea");
  input.rows = rows;
  input.value = value ?? "";
  input.addEventListener("change", () => writeSharedPromptSetting(name, input.value));
  return input;
}

function getWidget(node, name) {
  return node?.widgets?.find(widget => widget?.name === name) || null;
}

function setWidgetValue(widget, value) {
  if (!widget) return;
  widget.value = value;
  widget.callback?.(value);
}

function setWidgetHidden(widget, hidden) {
  if (!widget) return;
  widget.hidden = Boolean(hidden);
  widget.options ||= {};
  if (hidden) {
    widget.computeSize = () => [0, -4];
    widget.getHeight = () => 0;
    widget.type = widget.type || "hidden";
    widget.options.hidden = true;
    widget.options.display = "hidden";
    widget.last_y = 0;
    widget.y = 0;
    widget.computedHeight = 0;
    widget.margin_top = 0;
  } else {
    delete widget.options.hidden;
    delete widget.options.display;
  }
  if (widget.element) widget.element.style.display = hidden ? "none" : "";
  if (widget.inputEl) widget.inputEl.style.display = hidden ? "none" : "";
}

function syncConfigToNativeMainWidgets(node, cfg) {
  for (const key of MAIN_WIDGET_KEYS) {
    const widget = getWidget(node, key);
    if (!widget || !(key in cfg)) continue;
    widget.value = coerceMainWidgetValue(key, cfg[key]);
  }
}

function coerceMainWidgetValue(key, value) {
  if (!NUMERIC_WIDGET_KEYS.has(key)) return value == null ? "" : String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (["width", "height", "seed"].includes(key)) return Math.round(n);
  return n;
}

function readNativeMainWidgetConfig(node) {
  const out = {};
  for (const key of MAIN_WIDGET_KEYS) {
    const widget = node.widgets?.find(w => w?.name === key);
    if (!widget) continue;
    out[key] = coerceMainWidgetValue(key, widget.value);
  }
  return out;
}

function writeConfigJson(node, cfg, markDirty = false) {
  if (!node.properties) node.properties = {};
  const json = JSON.stringify(cfg);
  node.properties[CONFIG_KEY] = json;
  const hidden = getWidget(node, "config_json");
  if (hidden) hidden.value = json;
  if (markDirty) {
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
  }
  return cfg;
}

function syncNativeMainWidgets(node, markDirty = false) {
  if (!node || !isTarget(node)) return getConfig(node);
  const cfg = { ...getConfig(node), ...readNativeMainWidgetConfig(node) };
  return writeConfigJson(node, cfg, markDirty);
}

function wireNativeMainWidgets(node) {
  if (node.__gjjLtxNativeWidgetsWired) return;
  node.__gjjLtxNativeWidgetsWired = true;
  for (const key of MAIN_WIDGET_KEYS) {
    const widget = node.widgets?.find(w => w?.name === key);
    if (!widget) continue;
    const oldCallback = widget.callback;
    widget.callback = function (...args) {
      const ret = oldCallback?.apply(this, args);
      try { syncNativeMainWidgets(node, true); } catch (_) {}
      return ret;
    };
  }
}

function isTarget(node) {
  const text = `${node?.comfyClass || ""} ${node?.type || ""} ${node?.title || ""}`;
  return text.includes(NODE_CLASS) || /GJJ.*LTX.*多图/i.test(text);
}

function stopCanvasEvents(root) {
  for (const ev of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "keyup"]) {
    root.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev === "wheel") e.preventDefault();
    }, { passive: ev !== "wheel" });
  }
}

function getConfig(node) {
  if (!node.properties) node.properties = {};
  const raw = node.properties[CONFIG_KEY];
  if (raw && typeof raw === "object") return { ...DEFAULT_CONFIG, ...raw };
  if (typeof raw === "string") {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }; } catch (_) {}
  }
  const cfg = { ...DEFAULT_CONFIG };
  writeConfigJson(node, cfg, false);
  return cfg;
}

function setConfig(node, next) {
  if (!node.properties) node.properties = {};
  const base = { ...getConfig(node), ...readNativeMainWidgetConfig(node) };
  const cfg = { ...base, ...next };
  syncConfigToNativeMainWidgets(node, cfg);
  writeConfigJson(node, cfg, true);
  if (Object.prototype.hasOwnProperty.call(next || {}, "ltx_model_name")) scheduleConvrotSupportCheck(node);
  resizeNodeToFit(node);
}

function sceneIndex(input) {
  const m = String(input?.name || input?.label || "").match(SCENE_RE);
  if (!m) return 0;
  return Number(m[1] || m[2] || m[3] || 0) || 0;
}

function isSceneInput(input) { return sceneIndex(input) > 0; }

function isFpsInput(input) {
  const name = String(input?.name || "");
  const widgetName = String(input?.widget?.name || "");
  return name === "fps" || widgetName === "fps";
}

function setInputType(input, type) {
  if (!input) return;
  input.type = type;
  input.localized_name = input.localized_name || input.name;
}

function ensureInput(node, name, type) {
  let input = node.inputs?.find(i => String(i.name) === name);
  if (!input) {
    node.addInput(name, type);
    input = node.inputs?.[node.inputs.length - 1];
  }
  setInputType(input, type);
  return input;
}

function refreshNode(node) {
  node?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function buildViewUrl(item, includePreviewFormat = true) {
  if (!item?.filename) return "";
  const previewFormat = includePreviewFormat && typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
  const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
  return api.apiURL(
    `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
  );
}

function unwrapExecutedDetail(detail = {}) {
  if (detail?.output && typeof detail.output === "object") return detail.output;
  if (detail?.ui && typeof detail.ui === "object") return detail.ui;
  return detail || {};
}

function firstArrayItem(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value[0];
  }
  return null;
}

function firstMediaItem(...values) {
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      const nested = firstMediaItem(...value);
      if (nested) return nested;
      continue;
    }
    if (typeof value === "object" && value.filename) return value;
  }
  return null;
}

function previewItemFromPath(detail = {}) {
  const rawPath = firstArrayItem(detail.preview_main_path) ?? (typeof detail.preview_main_path === "string" ? detail.preview_main_path : "");
  if (!rawPath) return null;
  const cleanPath = String(rawPath).replaceAll("\\", "/");
  const filename = cleanPath.split("/").pop() || "";
  if (!filename) return null;
  const outputIndex = cleanPath.toLowerCase().lastIndexOf("/output/");
  const subfolder = outputIndex >= 0
    ? cleanPath.slice(outputIndex + 8, Math.max(outputIndex + 8, cleanPath.length - filename.length - 1)).replace(/^\/+|\/+$/g, "")
    : "";
  return { filename, subfolder, type: "output" };
}

function firstPreviewItem(detail = {}) {
  const output = unwrapExecutedDetail(detail);
  return firstMediaItem(
    output.preview_media,
    output.preview_video,
    output.gifs,
    output.animated,
    output.videos,
    output.video,
  ) || previewItemFromPath(output);
}

function isVideoPreview(item, detail = {}) {
  const explicitFlag = Array.isArray(detail?.preview_is_video) ? detail.preview_is_video[0] : detail?.preview_is_video;
  if (explicitFlag != null) return Boolean(explicitFlag);
  const filename = String(item?.filename || "");
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  return VIDEO_EXTENSIONS.has(ext);
}

function clearNativePreview(node) {
  if (!node) return;
  node.imgs = [];
  node.imageIndex = null;
  node.overIndex = null;
  node.animatedImages = [];
  node.videoContainer = null;
  node.preview = null;
  node.previews = null;
  if (node.properties) {
    delete node.properties.image;
    delete node.properties.images;
    delete node.properties.preview;
    delete node.properties.previews;
    delete node.properties.gifs;
    delete node.properties.animated;
  }
  refreshNode(node);
}

function setStatus(node, detail = {}) {
  // 运行进度由节点顶部的统一状态面板展示；此区域只在产生视频后显示预览。
}

function setVideoPreview(node, detail = {}) {
  const state = node?.__gjjLtxStatusPanel;
  if (!state) return;
  const output = unwrapExecutedDetail(detail);
  const item = firstPreviewItem(output);
  const url = isVideoPreview(item, output) ? buildViewUrl(item, false) : "";
  state.video.pause?.();
  state.video.removeAttribute("src");
  state.video.load?.();
  if (!url) {
    state.hasPreview = false;
    state.wrap.style.display = "none";
    state.previewWrap.style.display = "none";
    resizeNodeToFit(node);
    refreshNode(node);
    return;
  }
  state.hasPreview = true;
  state.wrap.style.display = "block";
  state.previewWrap.style.display = "block";
  state.video.src = url;
  state.video.load?.();
  const playPromise = state.video.play?.();
  if (playPromise?.catch) playPromise.catch(() => {});
  resizeNodeToFit(node);
  refreshNode(node);
}

function configPreviewAspect(node) {
  const cfg = getConfig(node);
  const width = Number(cfg.width) || 16;
  const height = Number(cfg.height) || 9;
  return Math.max(0.1, Math.min(8, height / width));
}

function previewWidgetHeight(node, width) {
  const state = node?.__gjjLtxStatusPanel;
  if (!state?.hasPreview) return 0;
  const panelWidth = Math.max(300, Number(width || node?.size?.[0] || 360)) - 20;
  const previewWidth = Math.max(120, panelWidth - 16);
  return Math.max(120, Math.round(previewWidth * (state.previewAspect || configPreviewAspect(node)))) + 12;
}

function setPreviewAspect(node, width, height) {
  const state = node?.__gjjLtxStatusPanel;
  if (!state) return;
  const w = Number(width);
  const h = Number(height);
  const aspect = w > 0 && h > 0 ? Math.max(0.1, Math.min(8, h / w)) : configPreviewAspect(node);
  state.previewAspect = aspect;
  state.previewWrap.style.setProperty("--gjj-ltx-preview-aspect", `${Math.max(1, Math.round(w || 16))} / ${Math.max(1, Math.round(h || 9))}`);
  resizeNodeToFit(node);
  refreshNode(node);
}

function getGraphLinkById(graph, linkId) {
  if (linkId == null) return null;
  const links = graph?.links || app.graph?.links;
  if (!links) return null;
  if (Array.isArray(links)) return links.find(link => Number(link?.id) === Number(linkId)) || links[Number(linkId)] || null;
  return links[linkId] || links[String(linkId)] || null;
}

function getGraphNodeById(graph, nodeId) {
  return graph?.getNodeById?.(nodeId) || graph?._nodes_by_id?.[nodeId] || app.graph?.getNodeById?.(nodeId) || null;
}

function collectUpstreamNodeIds(node) {
  const graph = node?.graph || app.graph;
  const keep = new Set();
  const visit = (current) => {
    if (!Array.isArray(current?.inputs)) return;
    for (const input of current.inputs) {
      const link = getGraphLinkById(graph, input?.link);
      const originId = linkField(link, "origin_id", 1);
      if (originId == null || keep.has(String(originId))) continue;
      keep.add(String(originId));
      const originNode = getGraphNodeById(graph, originId);
      if (originNode) visit(originNode);
    }
  };
  visit(node);
  return keep;
}

function isExecutionOutputNode(node) {
  return Boolean(node?.constructor?.nodeData?.output_node || node?.nodeData?.output_node || node?.flags?.output);
}

async function queueOnlyCurrentNode(node) {
  if (!node || !node.graph) return false;
  const graph = node.graph || app.graph;
  const allNodes = graph?._nodes || app.graph?._nodes || [];
  const upstreamNodeIds = collectUpstreamNodeIds(node);
  const savedModes = [];
  const oldSelectedNodes = app.canvas?.selected_nodes;
  const oldSelectedNode = app.canvas?.selected_node;
  try {
    for (const item of allNodes) {
      if (!item || item === node) continue;
      if (upstreamNodeIds.has(String(item.id))) continue;
      if (isExecutionOutputNode(item)) {
        savedModes.push([item, item.mode]);
        item.mode = 2;
      }
    }
    if (app.canvas) {
      app.canvas.selected_nodes = {};
      app.canvas.selected_nodes[node.id] = node;
      app.canvas.selected_node = node;
    }
    syncNativeMainWidgets(node, false);
    refreshNode(node);
    if (typeof app.queuePrompt === "function") {
      await app.queuePrompt(0, 1);
      return true;
    }
    return false;
  } finally {
    for (const [item, mode] of savedModes) item.mode = mode;
    if (app.canvas) {
      app.canvas.selected_nodes = oldSelectedNodes;
      app.canvas.selected_node = oldSelectedNode;
    }
    refreshNode(node);
  }
}

async function runPreviewNode(node) {
  if (node.__gjjLtxRunInFlight) return;
  node.__gjjLtxRunInFlight = true;
  refreshToolbarState(node);
  clearNativePreview(node);
  setStatus(node, { text: "正在提交本节点执行...", progress: 0.02 });
  try {
    const ok = await queueOnlyCurrentNode(node);
    if (!ok) {
      setStatus(node, { text: "当前 ComfyUI 前端不支持直接执行本节点。", progress: 0 });
      node.__gjjLtxRunInFlight = false;
      refreshToolbarState(node);
    }
  } catch (error) {
    setStatus(node, { text: String(error?.message || error || "提交执行失败"), progress: 0 });
    node.__gjjLtxRunInFlight = false;
    refreshToolbarState(node);
  }
}

function uploadUrl(path) {
  return api?.apiURL ? api.apiURL(path) : path;
}

function normalizeUploadItem(data, file, subfolder = "GJJ") {
  const filename = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
  const cleanSubfolder = String(data?.subfolder ?? subfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!filename) return null;
  const base = filename.includes("/") ? filename.split("/").pop() : filename;
  const rawType = String(data?.type || "input").trim().toLowerCase();
  const itemType = ["input", "temp", "output"].includes(rawType) ? rawType : "input";
  return { filename: base, subfolder: cleanSubfolder, type: itemType };
}

async function uploadImageFile(file) {
  const form = new FormData();
  form.append("image", file, file.name);
  const response = api?.fetchApi
    ? await api.fetchApi(TEMP_UPLOAD_API_PATH, { method: "POST", body: form })
    : await fetch(uploadUrl(TEMP_UPLOAD_API_PATH), { method: "POST", body: form });
  if (!response?.ok) throw new Error(`上传失败：HTTP ${response?.status || "?"}`);
  const data = await response.json().catch(() => ({}));
  const item = Array.isArray(data?.items) ? data.items[0] : (Array.isArray(data?.images) ? data.images[0] : data);
  return normalizeUploadItem(item, file, "GJJ");
}

function findLinkedReferenceLoader(node) {
  const input = node?.inputs?.find(item => item?.name === "image_sequence") || node?.inputs?.[0];
  const link = getGraphLinkById(node?.graph || app.graph, input?.link);
  const originId = linkField(link, "origin_id", 1);
  const source = getGraphNodeById(node?.graph || app.graph, originId);
  if (source && String(source.comfyClass || source.type || "") === MULTI_IMAGE_LOADER_CLASS) return source;
  const remembered = node?.properties?.[LINKED_LOADER_PROP];
  const rememberedNode = remembered != null ? getGraphNodeById(node?.graph || app.graph, Number(remembered)) : null;
  if (rememberedNode && String(rememberedNode.comfyClass || rememberedNode.type || "") === MULTI_IMAGE_LOADER_CLASS) return rememberedNode;
  return null;
}

function ensureReferenceLoader(node) {
  const existing = findLinkedReferenceLoader(node);
  if (existing) return existing;
  const loader = globalThis.LiteGraph?.createNode?.(MULTI_IMAGE_LOADER_CLASS);
  if (!loader) throw new Error("无法创建 GJJ_MultiImageLoader。");
  loader.pos = [
    Number(node.pos?.[0] || 0) - 360,
    Number(node.pos?.[1] || 0),
  ];
  loader.title = "📁 LTX参考图片";
  app.graph?.add?.(loader);
  node.properties ||= {};
  node.properties[LINKED_LOADER_PROP] = loader.id;
  const inputIndex = node.findInputSlot?.("image_sequence", false) ?? 0;
  if (Number.isInteger(inputIndex) && inputIndex >= 0) {
    if (node.inputs?.[inputIndex]?.link != null) node.disconnectInput?.(inputIndex);
    loader.connect?.(0, node, inputIndex);
  }
  return loader;
}

function writeLoaderSelection(loader, items) {
  const text = JSON.stringify(items || []);
  loader.properties ||= {};
  loader.properties.selected_images = text;
  setWidgetValue(getWidget(loader, "selected_images") || loader.__gjjSelectedImagesWidget, text);
  loader.__gjjMultiImageState ||= {};
  loader.__gjjMultiImageState.selection = items || [];
  loader.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function chooseReferenceImages(node) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    setStatus(node, { text: `正在导入 ${files.length} 张参考图...`, progress: 0.12 });
    try {
      const items = [];
      for (const file of files) {
        const item = await uploadImageFile(file);
        if (item) items.push(item);
      }
      const loader = ensureReferenceLoader(node);
      writeLoaderSelection(loader, items);
      setStatus(node, { text: `已连接 ${items.length} 张参考图`, progress: 0 });
      refreshNode(node);
    } catch (error) {
      setStatus(node, { text: String(error?.message || error || "参考图导入失败"), progress: 0 });
    }
  };
  input.click();
}

function isImageLikeTypeText(type) {
  const text = String(type || "").toUpperCase();
  return text.includes("IMAGE") || text.includes("GJJ_BATCH_IMAGE");
}

function linkField(link, key, arrayIndex, fallback = undefined) {
  if (!link) return fallback;
  if (typeof link === "object" && !Array.isArray(link) && key in link) return link[key];
  if (Array.isArray(link) && link.length > arrayIndex) return link[arrayIndex];
  return fallback;
}

function setLinkField(link, key, arrayIndex, value) {
  if (!link) return;
  if (typeof link === "object" && !Array.isArray(link)) link[key] = value;
  if (Array.isArray(link) && link.length > arrayIndex) link[arrayIndex] = value;
}

function getGraphLink(node, linkId) {
  const links = node?.graph?.links;
  if (!links || linkId == null) return null;
  return links[linkId] || (Array.isArray(links) ? links.find(l => String(linkField(l, "id", 0)) === String(linkId)) : null);
}

function getNodeByGraphId(graph, id) {
  if (!graph || id == null) return null;
  return graph._nodes_by_id?.[id] || graph.getNodeById?.(id) || graph._nodes?.find(n => String(n.id) === String(id)) || null;
}

function getLinkSourceOutput(node, link) {
  try {
    const originId = linkField(link, "origin_id", 1);
    const originSlot = linkField(link, "origin_slot", 2);
    const sourceNode = getNodeByGraphId(node.graph, originId);
    return sourceNode?.outputs?.[originSlot] || null;
  } catch (_) {
    return null;
  }
}

function getLinkSourceOutputType(node, link) {
  const output = getLinkSourceOutput(node, link);
  return output?.type || linkField(link, "type", 5, "");
}

function getLinkSourceOutputName(node, link) {
  const output = getLinkSourceOutput(node, link);
  return `${output?.name || ""} ${output?.label || ""} ${output?.localized_name || ""} ${output?.display_name || ""}`;
}

function getLinkSourceNodeText(node, link) {
  try {
    const originId = linkField(link, "origin_id", 1);
    const sourceNode = getNodeByGraphId(node.graph, originId);
    return `${sourceNode?.comfyClass || ""} ${sourceNode?.type || ""} ${sourceNode?.title || ""}`;
  } catch (_) {
    return "";
  }
}

function isImageLikeLink(node, link) {
  if (!link) return false;
  // 保存/重开后 link.type 可能被旧 repairLinks 改成目标口类型，比如 LORA_CHAIN_CONFIG。
  // 所以必须优先看源节点输出口 type/name/source node，同时兼容 LiteGraph object link 和 array link 两种结构。
  const sourceType = getLinkSourceOutputType(node, link);
  const linkType = linkField(link, "type", 5, "");
  const sourceName = getLinkSourceOutputName(node, link);
  const sourceNodeText = getLinkSourceNodeText(node, link);
  if (isImageLikeTypeText(sourceType) || isImageLikeTypeText(linkType)) return true;
  if (/图片|图像|image|batch|GJJ_BATCH/i.test(sourceName)) return true;
  // GJJ 批量图片加载/缩放这类源节点，即使保存后 link.type 被改坏，也应当按图片线修复。
  if (/multi.*image|image.*loader|图片加载|图片缩放|批量多图|多功能图片缩放|GJJ_MultiImage|GJJ.*ImageResize/i.test(sourceNodeText)) return true;
  return false;
}

function moveMisplacedImageLinksToScenes(node) {
  if (!node?.graph?.links || !Array.isArray(node.inputs)) return;
  // Clean v40：保存/重开后，图片线有时会错挂到任意非场景口，并且 link 可能是 object 或 array。
  // 只要源输出口看起来是 IMAGE/GJJ_BATCH_IMAGE/图片输出，就自动迁回场景口。
  const nonSceneInputs = node.inputs.filter(i =>
    i && !isSceneInput(i) && String(i.name || "") !== "character_reference"
  );
  for (const input of nonSceneInputs) {
    if (!input?.link) continue;
    const link = getGraphLink(node, input.link);
    if (!link || !isImageLikeLink(node, link)) continue;

    let target = node.inputs.find(i => isSceneInput(i) && !i.link);
    if (!target) {
      const currentMax = Math.max(0, ...node.inputs.map(i => sceneIndex(i) || 0));
      const nextIndex = Math.min(MAX_SCENES, Math.max(1, currentMax + 1));
      node.addInput(`场景${nextIndex}`, nextIndex === 1 ? FIRST_SCENE_TYPE : SCENE_TYPE);
      target = node.inputs[node.inputs.length - 1];
    }
    const oldName = input.name;
    target.link = input.link;
    input.link = null;
    const targetIndex = node.inputs.indexOf(target);
    setLinkField(link, "target_id", 3, node.id);
    setLinkField(link, "target_slot", 4, targetIndex);
    setLinkField(link, "type", 5, target.type);
    target.slot_index = targetIndex;
    console.warn("[GJJ LTX2.3][Clean v40] moved misplaced image link from", oldName, "to", target.name, "sourceType=", getLinkSourceOutputType(node, link), "sourceName=", getLinkSourceOutputName(node, link));
  }
}

function getMaxSceneIndexFromInputs(inputs) {
  let maxIndex = 0;
  for (const input of inputs || []) maxIndex = Math.max(maxIndex, sceneIndex(input) || 0);
  return maxIndex;
}

function collectSceneLinkMap(node) {
  const map = {};
  for (const input of node.inputs || []) {
    const idx = sceneIndex(input);
    if (idx && input.link != null) {
      const link = getGraphLink(node, input.link);
      map[String(idx)] = {
        link: input.link,
        origin_id: linkField(link, "origin_id", 1, null),
        origin_slot: linkField(link, "origin_slot", 2, null),
        type: linkField(link, "type", 5, input.type || ""),
      };
    }
  }
  return map;
}

function saveSceneRestoreState(node) {
  if (!node) return;
  if (!node.properties) node.properties = {};
  const maxScene = Math.max(1, getMaxSceneIndexFromInputs(node.inputs));
  node.properties[SCENE_COUNT_PROP] = maxScene;
  node.properties[SCENE_LINKS_PROP] = collectSceneLinkMap(node);
}

function restoreSceneInputsFromSavedData(node, data) {
  if (!node) return;
  if (!node.properties) node.properties = {};
  const props = { ...(data?.properties || {}), ...(node.properties || {}) };
  const serializedMax = getMaxSceneIndexFromInputs(data?.inputs || []);
  const propMax = Number(props[SCENE_COUNT_PROP] || 0);
  const count = Math.max(1, serializedMax, Number.isFinite(propMax) ? propMax : 0);
  for (let i = 1; i <= Math.min(MAX_SCENES, count); i++) {
    const name = `场景${i}`;
    let inp = node.inputs?.find(x => sceneIndex(x) === i);
    if (!inp) {
      node.addInput(name, i === 1 ? FIRST_SCENE_TYPE : SCENE_TYPE);
      inp = node.inputs[node.inputs.length - 1];
    }
    inp.name = name;
    setInputType(inp, i === 1 ? FIRST_SCENE_TYPE : SCENE_TYPE);
  }
}

function restoreSceneLinksFromSavedMap(node) {
  const map = node?.properties?.[SCENE_LINKS_PROP];
  if (!map || typeof map !== "object") return;
  for (const [idxText, info] of Object.entries(map)) {
    const idx = Number(idxText);
    if (!idx || idx < 1 || idx > MAX_SCENES) continue;
    const linkId = info?.link;
    const link = getGraphLink(node, linkId);
    if (!link) continue;
    const sceneInput = node.inputs?.find(i => sceneIndex(i) === idx);
    if (!sceneInput) continue;

    // 如果该 link 当前错挂在其它输入口，先清掉。
    for (const input of node.inputs || []) {
      if (input !== sceneInput && String(input.link) === String(linkId)) input.link = null;
    }
    sceneInput.link = linkId;
    const targetIndex = node.inputs.indexOf(sceneInput);
    setLinkField(link, "target_id", 3, node.id);
    setLinkField(link, "target_slot", 4, targetIndex);
    setLinkField(link, "type", 5, sceneInput.type);
    sceneInput.slot_index = targetIndex;
  }
}

function normalizeInputs(node) {
  if (!Array.isArray(node.inputs)) node.inputs = [];
  let image = node.inputs.find(i => String(i?.name || "") === "image_sequence" || /图片\/帧序列|图片|图像|帧序列|image/i.test(`${i?.name || ""} ${i?.label || ""} ${i?.localized_name || ""}`));
  if (!image) image = ensureInput(node, "image_sequence", FIRST_SCENE_TYPE);

  const oldSceneWithLink = (node.inputs || [])
    .filter(i => i !== image && isSceneInput(i) && i.link != null)
    .sort((a, b) => sceneIndex(a) - sceneIndex(b))[0];
  if (!image.link && oldSceneWithLink?.link != null) {
    image.link = oldSceneWithLink.link;
    oldSceneWithLink.link = null;
  }
  image.name = "image_sequence";
  image.label = "🖼️ 图片/帧序列";
  image.localized_name = "🖼️ 图片/帧序列";
  image.display_name = "🖼️ 图片/帧序列";
  setInputType(image, FIRST_SCENE_TYPE);

  const lora = ensureInput(node, "lora_chain_config", "LORA_CHAIN_CONFIG");
  lora.label = "🧬 LoRA串联配置";
  lora.localized_name = "🧬 LoRA串联配置";
  lora.display_name = "🧬 LoRA串联配置";
  setInputType(lora, "LORA_CHAIN_CONFIG");

  const audio = ensureInput(node, "input_audio", "AUDIO");
  audio.label = "🔊 驱动音频";
  audio.localized_name = "🔊 驱动音频";
  audio.display_name = "🔊 驱动音频";
  audio.tooltip = "普通 AUDIO 自动进入 S2V/数字人；GJJ_MTVAudioToPrompt 的音频列表自动进入 MTV 分支，并与图片队列按索引一一配对。";
  setInputType(audio, "AUDIO");

  const characterReference = ensureInput(node, "character_reference", "GJJ_BATCH_IMAGE,IMAGE");
  characterReference.label = "👤 人物参考";
  characterReference.localized_name = "👤 人物参考";
  characterReference.display_name = "👤 人物参考";
  characterReference.tooltip = "接入 GJJ_LazyImageStudio 的人物参考批次；所有视频分段共用，当前段场景图作为 MSR background。";
  setInputType(characterReference, "GJJ_BATCH_IMAGE,IMAGE");

  const fixed = [image, lora, audio, characterReference];
  const known = new Set(fixed);
  const others = node.inputs.filter(i => !known.has(i) && !isSceneInput(i));
  node.inputs = [...fixed, ...others];
  stabilizeNumericWidgetInputs(node);
  repairLinks(node);
}

function stabilizeNumericWidgetInputs(node) {
  for (const input of node.inputs || []) {
    if (!isFpsInput(input)) continue;
    input.name = input.name || "fps";
    input.label = input.label || "🎞️ 帧率";
    input.localized_name = input.localized_name || "🎞️ 帧率";
    input.type = FPS_SOCKET_TYPE;
  }
}

function repairLinks(node) {
  if (!node?.graph?.links) return;
  node.inputs?.forEach((input, index) => {
    input.slot_index = index;
    const link = input.link ? getGraphLink(node, input.link) : null;
    if (link) {
      setLinkField(link, "target_id", 3, node.id);
      setLinkField(link, "target_slot", 4, index);
      setLinkField(link, "type", 5, input.type);
    }
  });
}

function numberInput(label, key, step = "1", min = null, max = null) {
  return { label, key, step, min, max, type: "number" };
}

function makeField(node, spec) {
  const cfg = getConfig(node);
  const row = document.createElement("label");
  row.className = "gjj-ltx-row";
  const span = document.createElement("span");
  span.textContent = spec.label;
  const input = spec.type === "textarea" ? document.createElement("textarea") : document.createElement("input");
  if (spec.type === "number") {
    input.type = "number";
    input.step = spec.step || "1";
    if (spec.min != null) input.min = spec.min;
    if (spec.max != null) input.max = spec.max;
  } else if (spec.type !== "textarea") {
    input.type = "text";
  }
  input.value = cfg[spec.key] ?? "";
  if (spec.placeholder) input.placeholder = spec.placeholder;
  if (spec.tooltip) {
    input.title = spec.tooltip;
    row.title = spec.tooltip;
  }
  const commit = () => {
    let value = input.value;
    if (spec.type === "number") value = Number(value);
    setConfig(node, { [spec.key]: value });
  };
  input.addEventListener("input", commit);
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
  row.append(span, input);
  return row;
}

function makeSelect(node, label, key, options) {
  const cfg = getConfig(node);
  const row = document.createElement("label");
  row.className = "gjj-ltx-row";
  const span = document.createElement("span"); span.textContent = label;
  const select = document.createElement("select");
  const current = cfg[key] || "";
  const list = [...new Set([current, ...options].filter(Boolean))];
  for (const item of list) {
    const opt = document.createElement("option");
    opt.value = item; opt.textContent = item;
    select.appendChild(opt);
  }
  select.value = current;
  select.addEventListener("change", () => setConfig(node, { [key]: select.value }));
  row.append(span, select);
  return { row, select };
}

async function fetchModels(node, select) {
  try {
    const res = await api.fetchApi("/gjj/ltx23/models");
    const data = await res.json();
    const cfg = getConfig(node);
    const models = Array.isArray(data.models) ? data.models : [];
    if (!cfg.ltx_model_name && (data.default || models[0])) setConfig(node, { ltx_model_name: data.default || models[0] });
    const current = getConfig(node).ltx_model_name || data.default || models[0] || "";
    select.innerHTML = "";
    for (const item of [...new Set([current, ...models].filter(Boolean))]) {
      const opt = document.createElement("option");
      opt.value = item; opt.textContent = item;
      select.appendChild(opt);
    }
    select.value = current;
  } catch (err) {
    console.warn("[GJJ LTX2.3 Clean] model list fetch failed", err);
  }
}

async function fetchModelFields() {
  const res = await api.fetchApi("/gjj/ltx23/models");
  const data = await res.json();
  return Array.isArray(data.fields) ? data.fields : [];
}

function looksLikeInt4ConvrotModel(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("int4_convrot") || text.includes("convrot_w4a4") || text.includes("w4a4");
}

async function fetchConvrotStatus() {
  const res = await api.fetchApi(CONVROT_STATUS_API);
  return await res.json();
}

function convrotNoticeData(status) {
  const installCommand = String(status?.install_command || "");
  const current = status?.version ? `当前 comfy_kitchen：${status.version}` : "当前 comfy_kitchen：未检测到可用版本";
  const coreHint = status?.comfy_has_w4a4
    ? "ComfyUI 核心已注册 convrot_w4a4。"
    : "当前 ComfyUI 核心未注册 convrot_w4a4；只安装 comfy_kitchen 不一定能解决，需要更新 ComfyUI 或切到支持 W4A4 的环境。";
  return {
    warning_message: "⚠️ 当前运行环境还不能加载 INT4 ConvRot：需要重启生效，并且 ComfyUI 核心也必须支持 W4A4。",
    panel_message: [
      "检测到当前 LTX 主模型选择了 int4_convrot / convrot_w4a4。",
      "",
      current,
      `需要：${status?.required || "comfy_kitchen==0.2.18"}`,
      coreHint,
      "",
      "如果你刚安装过 0.2.18 但这里仍显示 0.2.16，说明当前 ComfyUI 进程还没重启。",
      "重启后若仍提示核心未注册 convrot_w4a4，就不是安装包问题，而是当前 ComfyUI 核心不支持 W4A4。",
    ].join("\n"),
    install_command: installCommand,
    copy_text: installCommand,
    copy_label: "📋 复制 comfy_kitchen 0.2.18 安装命令（仍需重启/核心支持）",
    notice_level: "error",
  };
}

function applyConvrotDependencyNotice(node, status) {
  if (!node || !looksLikeInt4ConvrotModel(getConfig(node).ltx_model_name) || status?.supported) {
    clearConvrotDependencyNotice(node);
    return;
  }
  const notice = globalThis.GJJ_CommonDependencyModelNotice;
  if (notice?.applyNotice) {
    notice.applyNotice(node, convrotNoticeData(status), { detailed: true, dismissible: false });
    node.__gjjLtxConvrotNoticeActive = true;
  }
}

function clearConvrotDependencyNotice(node) {
  if (!node?.__gjjLtxConvrotNoticeActive) return;
  const notice = globalThis.GJJ_CommonDependencyModelNotice;
  if (notice?.applyNotice) {
    notice.applyNotice(node, {
      warning_message: "",
      panel_message: "",
      copy_text: "",
      copy_label: "",
      notice_level: "",
    }, { detailed: false, dismissible: false });
  } else if (node.__gjjDependencyNotice?.root) {
    node.__gjjDependencyNotice.root.style.display = "none";
  }
  node.__gjjLtxConvrotNoticeActive = false;
}

function scheduleConvrotSupportCheck(node) {
  if (!node || !looksLikeInt4ConvrotModel(getConfig(node).ltx_model_name)) {
    clearConvrotDependencyNotice(node);
    return;
  }
  clearTimeout(node.__gjjLtxConvrotCheckTimer);
  node.__gjjLtxConvrotCheckTimer = setTimeout(async () => {
    try {
      const status = await fetchConvrotStatus();
      node.__gjjLtxConvrotStatus = status;
      applyConvrotDependencyNotice(node, status);
    } catch (error) {
      console.warn("[GJJ LTX2.3] convrot_w4a4 status check failed", error);
    }
  }, 120);
}

function setConvrotPanelState(node, root, status, stateText) {
  const selected = looksLikeInt4ConvrotModel(getConfig(node).ltx_model_name);
  root.style.display = selected ? "" : "none";
  if (!selected) return;
  const supported = Boolean(status?.supported);
  const text = root.querySelector(".gjj-ltx-convrot-text");
  const button = root.querySelector("button");
  const coreHint = status && !status.comfy_has_w4a4 ? "；ComfyUI 核心也需支持 convrot_w4a4" : "";
  root.dataset.supported = supported ? "true" : "false";
  if (text) {
    text.textContent = stateText || (supported
      ? `INT4 ConvRot 可用：comfy_kitchen ${status?.version || ""}`
      : `当前运行环境还不能加载 INT4 ConvRot。若刚安装 0.2.18，需要重启；若核心未注册 W4A4，则需更新 ComfyUI 或换支持环境${coreHint}`);
  }
  if (button) {
    button.style.display = supported ? "none" : "";
    button.disabled = false;
    button.textContent = "安装/重装 comfy_kitchen 0.2.18";
  }
}

function createConvrotInstallPanel(node) {
  const root = document.createElement("div");
  root.className = "gjj-ltx-convrot-panel";
  root.style.display = "none";
  const text = document.createElement("div");
  text.className = "gjj-ltx-convrot-text";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "安装/重装 comfy_kitchen 0.2.18";
  button.title = "在当前 ComfyUI Python 中安装 comfy_kitchen==0.2.18。安装后需要重启；ComfyUI 核心仍需支持 convrot_w4a4。";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    button.textContent = "安装中...";
    text.textContent = "正在安装 comfy_kitchen 0.2.18，请稍等。";
    try {
      const res = await api.fetchApi(CONVROT_INSTALL_API, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data?.ok) {
        text.textContent = data?.status?.comfy_has_w4a4
          ? "安装完成。请重启 ComfyUI 后再加载 INT4 ConvRot 模型。"
          : "安装完成。请先重启 ComfyUI；重启后若仍提示核心未注册 convrot_w4a4，请更新 ComfyUI 或切换到支持 W4A4 的环境。";
        button.textContent = "已安装，重启 ComfyUI";
        applyConvrotDependencyNotice(node, { ...(data.status || {}), supported: false });
      } else {
        text.textContent = `安装失败：${data?.error || data?.output || "请复制安装命令手动执行"}`;
        button.textContent = "重试安装";
        button.disabled = false;
      }
    } catch (error) {
      text.textContent = `安装失败：${error?.message || error}`;
      button.textContent = "重试安装";
      button.disabled = false;
    }
    refreshNode(node);
  });
  root.append(text, button);
  fetchConvrotStatus().then((status) => {
    node.__gjjLtxConvrotStatus = status;
    setConvrotPanelState(node, root, status);
    applyConvrotDependencyNotice(node, status);
  }).catch(() => setConvrotPanelState(node, root, null, "无法检测 INT4 ConvRot 环境，必要时请手动安装 comfy_kitchen 0.2.18。"));
  return root;
}

function virtualModelWidget(node, field) {
  node.__gjjLtxVirtualModelWidgets ||= {};
  const key = String(field?.name || "");
  if (!node.__gjjLtxVirtualModelWidgets[key]) {
    node.__gjjLtxVirtualModelWidgets[key] = {
      name: key,
      type: "combo",
      options: { values: [] },
      get value() {
        return getConfig(node)[key] || "";
      },
      set value(next) {
        setConfig(node, { [key]: String(next || "") });
      },
      callback(next) {
        setConfig(node, { [key]: String(next || "") });
      },
    };
  }
  const widget = node.__gjjLtxVirtualModelWidgets[key];
  widget.options ||= {};
  widget.options.values = Array.isArray(field?.models) ? [...field.models] : [];
  return widget;
}

function modelTreeEntriesFromFields(node, fields) {
  const icons = {
    diffusion_models: "🧠",
    vae: "🟩",
    text_encoders: "📝",
    latent_upscale_models: "🔍",
    loras: "🧬",
  };
  return (fields || []).map((field) => {
    const name = String(field?.name || "");
    if (!name) return null;
    return {
      widget: name,
      label: field.label || name,
      folder: field.path || field.folder || "",
      icon: icons[String(field.folder || "").replace(/^models[\\/]/, "")] || "🟣",
      models: Array.isArray(field.models) ? field.models : [],
      keywords: Array.isArray(field.keywords) ? field.keywords : [],
      anyKeywords: Array.isArray(field.anyKeywords) ? field.anyKeywords : [],
      fallback: field.fallback || "",
      description: field.description || "",
      enableKey: field.enableKey || field.enable_key || "",
      strengthKey: field.strengthKey || field.strength_key || "",
      strengthDefault: Number(field.strengthDefault ?? field.strength_default ?? 1.0),
      required: Boolean(field.required),
      getWidget: () => virtualModelWidget(node, field),
      filename: field.filename || "",
      defaultModel: field.defaultModel || field.default_model || field.fallback || field.filename || "",
      missingDefault: GJJ_Utils._modelTreeMissingDefault(field),
    };
  }).filter(Boolean);
}

function modelGroupTitle(title, note = "") {
  const wrap = document.createElement("div");
  wrap.className = "gjj-ltx-model-title";
  const label = document.createElement("div");
  label.textContent = title;
  const hint = document.createElement("div");
  hint.textContent = note;
  wrap.append(label, hint);
  return wrap;
}

function createLoraInlineControls(node, entry) {
  const enableKey = entry?.enableKey || "";
  const strengthKey = entry?.strengthKey || "";
  if (!enableKey && !strengthKey) return null;
  const wrap = document.createElement("div");
  wrap.className = "gjj-ltx-lora-inline-controls";
  let strength = null;
  const refresh = () => {
    const enabled = enableKey ? Boolean(getConfig(node)[enableKey]) : true;
    wrap.classList.toggle("is-off", !enabled);
    const toggle = wrap.querySelector(".gjj-ltx-lora-emoji-toggle");
    if (toggle) {
      toggle.textContent = enabled ? "🟢" : "⚪";
      toggle.title = enabled ? "LoRA 已启用，点击关闭" : "LoRA 已关闭，点击启用";
      toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    }
    if (strength) strength.disabled = !enabled;
  };
  if (enableKey) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "gjj-ltx-lora-emoji-toggle";
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setConfig(node, { [enableKey]: !Boolean(getConfig(node)[enableKey]) });
      refresh();
      refreshToolbarState(node);
    });
    wrap.appendChild(toggle);
  }
  if (strengthKey) {
    strength = configInput(node, strengthKey, "number", { min: -10, max: 10, step: 0.05 });
    strength.className = `${strength.className || ""} gjj-ltx-lora-strength`.trim();
    if (strength.value === "") strength.value = String(entry.strengthDefault ?? 1.0);
    wrap.appendChild(strength);
  }
  refresh();
  return wrap;
}

function createLtxModelTreeView(node, entries, callbacks = {}) {
  const root = document.createElement("div");
  root.style.cssText = "display:flex;flex-direction:column;gap:1px;padding:8px;border:1px solid #33454c;border-radius:8px;background:#0f171b;overflow:auto;";
  const folderMap = new Map();
  for (const entry of entries || []) {
    const folder = GJJ_Utils._modelTreeFolder(entry?.folder || entry?.path || entry?.directory || "");
    if (!folderMap.has(folder)) folderMap.set(folder, []);
    folderMap.get(folder).push(entry);
  }
  const { row: rootLine } = GJJ_Utils._modelTreeLine("", "📁", "models/");
  root.appendChild(rootLine);
  Array.from(folderMap.keys()).forEach((folder, folderIndex, folders) => {
    const folderPrefix = folderIndex === folders.length - 1 ? "└─" : "├─";
    const { row: folderLine } = GJJ_Utils._modelTreeLine(folderPrefix, "📁", `${folder || "models"}/`);
    root.appendChild(folderLine);
    const items = folderMap.get(folder) || [];
    items.forEach((entry, index) => {
      const branch = index === items.length - 1 ? "└─" : "├─";
      const host = GJJ_Utils._modelTreeFileNode(node, { ...entry, prefix: `│　${branch}` }, callbacks);
      const inline = createLoraInlineControls(node, entry);
      if (inline && host.firstElementChild) {
        const row = host.firstElementChild;
        row.style.gridTemplateColumns = "minmax(0,1fr) 118px 24px";
        row.insertBefore(inline, row.lastElementChild);
      }
      root.appendChild(host);
    });
  });
  return root;
}

function normalizeLtxLoraSlots(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .filter((item) => item && typeof item === "object" && String(item.name || "").trim())
    .map((item) => ({
      enabled: item.enabled !== false,
      name: String(item.name || "").trim(),
      strength: Math.max(-10, Math.min(10, Number(item.strength ?? 1) || 0)),
    }));
}

function createLtxLoraSlots(node, fields) {
  const root = document.createElement("div");
  root.className = "gjj-ltx-general-lora-slots";
  const allModels = (fields || [])
    .filter((field) => String(field?.folder || "").replace(/^models[\\/]/, "") === "loras")
    .flatMap((field) => Array.isArray(field?.models) ? field.models : []);
  const ltxModels = [...new Set(allModels
    .map((item) => String(item || "").trim())
    .filter((item) => item && item.toLowerCase().includes("ltx")))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  const render = () => {
    const configured = normalizeLtxLoraSlots(getConfig(node).lora_slots);
    const rows = [...configured, { enabled: true, name: "", strength: 1.0 }];
    root.replaceChildren();
    rows.forEach((row, index) => {
      const line = document.createElement("div");
      line.className = "gjj-ltx-general-lora-row";

      const enabled = document.createElement("button");
      enabled.type = "button";
      enabled.className = "gjj-ltx-lora-emoji-toggle";
      enabled.textContent = row.enabled !== false ? "🟢" : "⚪";
      enabled.title = row.enabled !== false ? "LoRA 已启用，点击关闭" : "LoRA 已关闭，点击启用";
      enabled.disabled = !row.name;

      const select = document.createElement("select");
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "未选择";
      select.appendChild(empty);
      for (const name of ltxModels) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      }
      if (row.name && !ltxModels.includes(row.name)) {
        const option = document.createElement("option");
        option.value = row.name;
        option.textContent = row.name;
        select.appendChild(option);
      }
      select.value = row.name;

      const strength = document.createElement("input");
      strength.type = "number";
      strength.min = "-10";
      strength.max = "10";
      strength.step = "0.05";
      strength.value = String(row.strength ?? 1);
      strength.disabled = !row.name || row.enabled === false;
      strength.title = "LoRA 强度";

      const saveRows = (nextRow) => {
        const next = normalizeLtxLoraSlots(getConfig(node).lora_slots);
        if (index < next.length) next[index] = nextRow;
        else if (nextRow.name) next.push(nextRow);
        setConfig(node, { lora_slots: next.filter((item) => item.name) });
        render();
      };
      enabled.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!row.name) return;
        saveRows({ ...row, enabled: row.enabled === false });
      });
      select.addEventListener("change", () => {
        saveRows({
          enabled: row.enabled !== false,
          name: String(select.value || ""),
          strength: Number(strength.value || 1),
        });
      });
      strength.addEventListener("change", () => {
        if (!row.name) return;
        saveRows({
          ...row,
          strength: Math.max(-10, Math.min(10, Number(strength.value || 0))),
        });
      });

      const number = document.createElement("span");
      number.textContent = `LoRA ${index + 1}`;
      line.append(number, select, enabled, strength);
      root.appendChild(line);
    });
  };
  render();
  return root;
}

function showModelTreePanel(node, anchor) {
  showFloatingPanel(node, anchor, "模型", (body) => {
    body.style.gap = "9px";
    const loading = document.createElement("div");
    loading.textContent = "读取模型树...";
    loading.style.cssText = "color:#9fb0b8;padding:4px 0;";
    body.appendChild(loading);
    fetchModelFields().then((fields) => {
      body.replaceChildren();
      if (!fields.length) {
        const empty = document.createElement("div");
        empty.textContent = "没有读取到模型配置。";
        empty.style.cssText = "color:#fca5a5;padding:8px 0;";
        body.appendChild(empty);
        return;
      }
      const entries = modelTreeEntriesFromFields(node, fields);
      body.appendChild(modelGroupTitle("🧠 LTX 2.3 模型树", "点击模型文件可搜索并切换"));
      body.appendChild(createConvrotInstallPanel(node));
      body.appendChild(createLtxModelTreeView(node, entries, {
        node,
        entries,
        refresh: () => {
          syncConfigToNativeMainWidgets(node, getConfig(node));
          refreshNode(node);
          scheduleConvrotSupportCheck(node);
        },
        onApply: (entry, value) => {
          setConfig(node, { [entry.widget]: value });
        },
      }));
      body.appendChild(modelGroupTitle("🧬 通用 LoRA", "仅显示名称包含 ltx 的模型；始终保留一个空插槽"));
      body.appendChild(createLtxLoraSlots(node, fields));
    }).catch((error) => {
      body.replaceChildren();
      const fail = document.createElement("div");
      fail.textContent = error?.message || "读取模型树失败";
      fail.style.cssText = "color:#fca5a5;padding:8px 0;";
      body.appendChild(fail);
    });
  }, { width: 580 });
}

async function openVideoDir(node) {
  const cfg = getConfig(node);
  try {
    const res = await api.fetchApi("/gjj/ltx23/open_video_dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: cfg.segment_save_preset || "video/GJJ_LTX多图分段",
        node: String(node?.id ?? ""),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) console.warn("[GJJ LTX2.3 Clean v40] open video dir failed", data);
    else console.log("[GJJ LTX2.3 Clean v40] opened video dir:", data.path);
  } catch (err) {
    console.warn("[GJJ LTX2.3 Clean v40] open video dir error", err);
  }
}

function closeFloatingPanel(node) {
  const panel = node?.__gjjLtxFloatingPanel;
  if (!panel) return;
  if (typeof panel.__gjjLtxClose === "function") panel.__gjjLtxClose();
  else panel.remove?.();
  if (node.__gjjLtxFloatingPanel === panel) node.__gjjLtxFloatingPanel = null;
}

function showFloatingPanel(node, anchor, title, build, options = {}) {
  closeFloatingPanel(node);
  const panel = document.createElement("div");
  const panelWidth = options.width || 380;
  panel.className = "gjj-ltx-floating";
  panel.style.cssText = [
    "position:fixed",
    "z-index:100000",
    `width:${panelWidth}px`,
    "max-width:calc(100vw - 20px)",
    "padding:8px",
    "box-sizing:border-box",
    "border:1px solid #49616b",
    "border-radius:8px",
    "background:#10181d",
    "box-shadow:0 14px 34px rgba(0,0,0,.45)",
    "color:#e4eef0",
    "font:12px/1.35 system-ui,'Microsoft YaHei',sans-serif",
    "overflow:hidden",
    "pointer-events:auto",
  ].join(";");
  stopCanvasEvents(panel);

  const closePanel = () => closeFloatingPanel(node);
  const outsidePointerDown = (event) => {
    if (panel.contains(event.target) || anchor?.contains?.(event.target)) return;
    closePanel();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") closePanel();
  };
  panel.__gjjLtxClose = () => {
    document.removeEventListener("pointerdown", outsidePointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    panel.remove?.();
    if (node.__gjjLtxFloatingPanel === panel) node.__gjjLtxFloatingPanel = null;
  };

  const rect = anchor?.getBoundingClientRect?.() || { left: 20, bottom: 20 };
  panel.style.left = `${Math.max(10, Math.min(window.innerWidth - panelWidth - 10, Math.max(10, rect.left)))}px`;
  panel.style.top = `${Math.min(window.innerHeight - 80, Math.max(10, rect.bottom + 6))}px`;

  const head = document.createElement("div");
  head.className = "gjj-ltx-float-head";
  const headTitle = document.createElement("span");
  headTitle.textContent = title;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "关闭";
  closeButton.className = "gjj-ltx-close";
  closeButton.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  };
  head.append(headTitle, closeButton);

  const body = document.createElement("div");
  body.className = "gjj-ltx-float-body";
  panel.append(head, body);
  build(body);
  document.body.appendChild(panel);
  node.__gjjLtxFloatingPanel = panel;
  setTimeout(() => {
    document.addEventListener("pointerdown", outsidePointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  }, 0);
}

function makeToolButton(text, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.title = title;
  button.className = "gjj-ltx-tool-btn";
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(button);
  };
  return button;
}

function refreshToolbarState(node) {
  const cfg = getConfig(node);
  if (node.__gjjLtxSeedButton) {
    const mode = SEED_MODES.includes(cfg.seed_mode) ? cfg.seed_mode : "固定";
    const style = SEED_MODE_STYLES[mode];
    node.__gjjLtxSeedButton.style.background = style.background;
    node.__gjjLtxSeedButton.style.borderColor = style.border;
    node.__gjjLtxSeedButton.style.color = style.color;
    node.__gjjLtxSeedButton.title = `种子模式：${mode}；当前种子 ${Math.round(Number(cfg.seed) || 0)}`;
    node.__gjjLtxSeedButton.dataset.seedMode = mode;
  }
  if (node.__gjjLtxSizeButton) {
    const useOriginalSize = cfg.size_source === "原视频尺寸";
    node.__gjjLtxSizeButton.classList.toggle("active", useOriginalSize);
    node.__gjjLtxSizeButton.setAttribute("aria-pressed", useOriginalSize ? "true" : "false");
    node.__gjjLtxSizeButton.title = useOriginalSize
      ? "📐 原版尺寸：已开启；宽度和高度设置不可用"
      : "📐 面板尺寸：点击设置尺寸来源、宽度和高度";
  }
  if (node.__gjjLtxSegmentButton) {
    node.__gjjLtxSegmentButton.classList.toggle("active", Boolean(cfg.segmented_execution));
  }
  if (node.__gjjLtxTransitionButton) {
    node.__gjjLtxTransitionButton.classList.toggle("active", Boolean(cfg.transition_enabled));
  }
  if (node.__gjjLtxAutoPromptButton) {
    const enabled = Boolean(cfg.auto_transition_prompt);
    node.__gjjLtxAutoPromptButton.classList.toggle("active", enabled);
    node.__gjjLtxAutoPromptButton.title = enabled
      ? "🎬 Gemma 首尾帧过渡词：已开启"
      : "🎬 Gemma 首尾帧过渡词：已关闭";
    node.__gjjLtxAutoPromptButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  }
  if (node.__gjjLtxRunButton) {
    const running = Boolean(node.__gjjLtxRunInFlight);
    node.__gjjLtxRunButton.disabled = running;
    node.__gjjLtxRunButton.textContent = running ? "⏳" : "▶️";
    node.__gjjLtxRunButton.title = running ? "正在执行本节点" : "只执行当前 LTX 节点，并在节点面板预览最终视频";
    node.__gjjLtxRunButton.classList.toggle("active", running);
  }
}

function randomizeSeed(node) {
  const max = Number.MAX_SAFE_INTEGER;
  setConfig(node, { seed: Math.floor(Math.random() * max) });
}

function setSeedMode(node, mode) {
  const nextMode = SEED_MODES.includes(mode) ? mode : "固定";
  if (nextMode === "随机") {
    randomizeSeed(node);
  }
  setConfig(node, { seed_mode: nextMode });
  refreshToolbarState(node);
}

function advanceSeedAfterExecution(node) {
  const cfg = getConfig(node);
  const mode = SEED_MODES.includes(cfg.seed_mode) ? cfg.seed_mode : "固定";
  const current = Math.max(0, Math.round(Number(cfg.seed) || 0));
  if (mode === "随机") {
    randomizeSeed(node);
  } else if (mode === "递增") {
    setConfig(node, { seed: Math.min(Number.MAX_SAFE_INTEGER, current + 1) });
  } else if (mode === "递减") {
    setConfig(node, { seed: Math.max(0, current - 1) });
  }
  refreshToolbarState(node);
}

function panelRow(label, element) {
  const row = document.createElement("label");
  row.className = "gjj-ltx-float-row";
  const span = document.createElement("span");
  span.textContent = label;
  element.style.minWidth = "0";
  element.style.width = "100%";
  element.style.maxWidth = "100%";
  element.style.boxSizing = "border-box";
  row.append(span, element);
  return row;
}

function hasConnectedDrivingAudio(node) {
  const input = node?.inputs?.find(item => item?.name === "input_audio");
  return input?.link != null;
}

function syncSegmentSecondsAvailability(node) {
  const state = node?.__gjjLtxSegmentSecondsControl;
  if (!state?.row || !state?.input) return;
  const disabled = hasConnectedDrivingAudio(node);
  state.input.disabled = disabled;
  state.row.style.opacity = disabled ? "0.38" : "1";
  state.row.style.filter = disabled ? "grayscale(1)" : "";
  state.row.title = disabled
    ? "已接入驱动音频，场景时长由实际音频长度决定，场景间隔不参与执行。"
    : "无驱动音频时，使用该数值安排场景间隔。";
}

function configInput(node, key, type = "text", options = {}) {
  const input = document.createElement(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  const cfg = getConfig(node);
  input.value = cfg[key] ?? "";
  if (type === "textarea") input.rows = options.rows || 4;
  if (options.step != null) input.step = options.step;
  if (options.min != null) input.min = options.min;
  if (options.max != null) input.max = options.max;
  if (options.placeholder) input.placeholder = options.placeholder;
  const commit = () => {
    let value = input.value;
    if (type === "number") value = Number(value);
    setConfig(node, { [key]: value });
    refreshToolbarState(node);
  };
  input.addEventListener("input", commit);
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
  return input;
}

function configSegmented(node, key, options, onChange = null) {
  const wrap = document.createElement("div");
  wrap.className = "gjj-ltx-segmented";
  const refresh = () => {
    const current = getConfig(node)[key] || options[0];
    for (const button of wrap.querySelectorAll("button")) {
      const active = button.dataset.value === current;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  };
  for (const value of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.value = value;
    button.textContent = value;
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setConfig(node, { [key]: value });
      refresh();
      refreshToolbarState(node);
      onChange?.(value);
    };
    wrap.appendChild(button);
  }
  refresh();
  return wrap;
}

function configSliderNumber(node, key, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = "gjj-ltx-slider-number";
  const slider = document.createElement("input");
  const number = document.createElement("input");
  slider.type = "range";
  number.type = "number";
  const min = Number(options.min ?? 64);
  const max = Number(options.max ?? 2048);
  const hardMax = Number(options.hardMax ?? 8192);
  const step = Number(options.step ?? 32);
  const inputStep = Number(options.inputStep ?? step);
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  number.min = String(min);
  number.max = String(hardMax);
  number.step = String(inputStep);
  const cfg = getConfig(node);
  const initial = Number(cfg[key] ?? options.defaultValue ?? min);
  slider.value = String(Math.max(min, Math.min(max, Number.isFinite(initial) ? initial : min)));
  number.value = String(Number.isFinite(initial) ? initial : min);
  const commit = (source) => {
    const raw = Number(source.value);
    const alignStep = source === number ? inputStep : step;
    const value = Number.isFinite(raw) ? Math.max(min, Math.min(hardMax, Math.round(raw / alignStep) * alignStep)) : min;
    number.value = String(value);
    slider.value = String(Math.max(min, Math.min(max, value)));
    setConfig(node, { [key]: value });
    refreshToolbarState(node);
  };
  slider.addEventListener("input", () => commit(slider));
  slider.addEventListener("change", () => commit(slider));
  number.addEventListener("change", () => commit(number));
  number.addEventListener("blur", () => commit(number));
  number.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit(number);
    number.blur();
  });
  wrap.append(slider, number);
  return wrap;
}

function configCheckbox(node, key) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gjj-ltx-toggle";
  const refresh = () => {
    const enabled = Boolean(getConfig(node)[key]);
    button.textContent = enabled ? "开启" : "关闭";
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
  };
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setConfig(node, { [key]: !Boolean(getConfig(node)[key]) });
    refresh();
    refreshToolbarState(node);
  };
  refresh();
  return button;
}

function configSelect(node, key, options) {
  const select = document.createElement("select");
  const cfg = getConfig(node);
  const current = cfg[key] || "";
  for (const item of [...new Set([current, ...options].filter(Boolean))]) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    select.appendChild(option);
  }
  select.value = current;
  select.onchange = () => {
    setConfig(node, { [key]: select.value });
    refreshToolbarState(node);
  };
  return select;
}

function formatModelFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = index >= 3 ? 1 : 0;
  return `${size.toFixed(digits)} ${units[index]}`;
}

function normalizeModelTestEntries(models, infoItems = []) {
  const infoMap = new Map();
  for (const item of Array.isArray(infoItems) ? infoItems : []) {
    const name = String(item?.name || "");
    if (!name) continue;
    infoMap.set(name, Number(item?.size || item?.bytes || 0));
  }
  return [...new Set((models || []).filter(Boolean).map(String))].map((name) => ({
    name,
    size: Number(infoMap.get(name) || 0),
  }));
}

function sortModelTestEntries(entries, sortMode = "name") {
  const list = [...entries];
  if (sortMode === "size") {
    return list.sort((a, b) => {
      const bySize = Number(b.size || 0) - Number(a.size || 0);
      return bySize || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

function renderModelTestChoices(listRoot, models, selected, query = "", sortMode = "name") {
  const q = String(query || "").trim().toLowerCase();
  listRoot.replaceChildren();
  const filtered = sortModelTestEntries(models, sortMode).filter((item) => !q || String(item.name).toLowerCase().includes(q));
  for (const item of filtered) {
    const label = document.createElement("label");
    label.className = "gjj-ltx-model-test-choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.modelName = item.name;
    input.checked = selected.has(item.name);
    input.addEventListener("change", () => {
      if (input.checked) selected.add(item.name);
      else selected.delete(item.name);
    });
    const span = document.createElement("span");
    span.className = "gjj-ltx-model-test-name";
    span.textContent = item.name;
    const size = document.createElement("span");
    size.className = "gjj-ltx-model-test-size";
    size.textContent = formatModelFileSize(item.size);
    label.append(input, span, size);
    listRoot.appendChild(label);
  }
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "gjj-ltx-model-test-empty";
    empty.textContent = "没有匹配的模型";
    listRoot.appendChild(empty);
  }
}

async function queueModelTestBatch(node, items, statusEl, button, mode = "model") {
  if (!items.length) {
    if (statusEl) statusEl.textContent = "请先选择至少一个模型。";
    return;
  }
  const original = getConfig(node);
  const originalModel = original.ltx_model_name;
  const originalTestLora = original.test_lora_name;
  const originalTestLoraEnabled = Boolean(original.test_lora_enabled ?? DEFAULT_CONFIG.test_lora_enabled);
  const originalPreset = original.segment_save_preset;
  const fixedSeed = Number(original.seed || DEFAULT_CONFIG.seed || 0);
  const isLoraMode = mode === "lora";
  const testPreset = isLoraMode ? "video/GJJ_LTX模型测试/{lora}_{elapsed}" : "video/GJJ_LTX模型测试/{model}_{elapsed}";
  button.disabled = true;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const itemName = items[index];
      if (statusEl) statusEl.textContent = `正在加入队列 ${index + 1}/${items.length}：${itemName}`;
      const nextConfig = {
        seed: fixedSeed,
        ltx_model_name: originalModel,
        segment_save_preset: testPreset,
      };
      if (isLoraMode) {
        nextConfig.ltx_model_name = originalModel;
        nextConfig.test_lora_name = itemName;
        nextConfig.test_lora_enabled = true;
      } else {
        nextConfig.ltx_model_name = itemName;
        nextConfig.test_lora_name = originalTestLora;
        nextConfig.test_lora_enabled = false;
      }
      setConfig(node, nextConfig);
      syncNativeMainWidgets(node, false);
      await queueOnlyCurrentNode(node);
    }
    if (statusEl) statusEl.textContent = `已加入队列：${items.length} 个${isLoraMode ? " LoRA" : "模型"}。固定随机种：${fixedSeed}。`;
    setStatus(node, { text: `已加入${isLoraMode ? "LoRA" : "模型"}测试队列：${items.length} 个`, progress: 0.04 });
  } catch (error) {
    if (statusEl) statusEl.textContent = `加入队列失败：${error?.message || error}`;
    setStatus(node, { text: `模型测试队列失败：${error?.message || error}`, progress: 0 });
  } finally {
    setConfig(node, {
      ltx_model_name: originalModel,
      test_lora_name: originalTestLora,
      test_lora_enabled: originalTestLoraEnabled,
      segment_save_preset: originalPreset,
      seed: original.seed,
    });
    button.disabled = false;
    refreshToolbarState(node);
  }
}

function showModelTestPanel(node, anchor) {
  showFloatingPanel(node, anchor, "模型测试", (body) => {
    body.style.gap = "8px";
    const note = document.createElement("div");
    note.className = "gjj-ltx-model-test-note";
    note.textContent = "选择测试对象，逐个加入队列。测试会固定当前随机种，输出保存到 video/GJJ_LTX模型测试。";
    const modeBar = document.createElement("div");
    modeBar.className = "gjj-ltx-model-test-mode";
    const modelModeBtn = document.createElement("button");
    modelModeBtn.type = "button";
    modelModeBtn.textContent = "主模型";
    const loraModeBtn = document.createElement("button");
    loraModeBtn.type = "button";
    loraModeBtn.textContent = "LoRA";
    modeBar.append(modelModeBtn, loraModeBtn);
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索模型";
    search.className = "gjj-ltx-model-test-search";
    const sortBar = document.createElement("div");
    sortBar.className = "gjj-ltx-model-test-sort";
    const sortLabel = document.createElement("span");
    sortLabel.textContent = "排序";
    const sortByName = document.createElement("button");
    sortByName.type = "button";
    sortByName.textContent = "文件名";
    const sortBySize = document.createElement("button");
    sortBySize.type = "button";
    sortBySize.textContent = "大小";
    sortBar.append(sortLabel, sortByName, sortBySize);
    const actions = document.createElement("div");
    actions.className = "gjj-ltx-model-test-actions";
    const selectVisible = document.createElement("button");
    selectVisible.type = "button";
    selectVisible.textContent = "选择当前列表";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "清空";
    const list = document.createElement("div");
    list.className = "gjj-ltx-model-test-list";
    const status = document.createElement("div");
    status.className = "gjj-ltx-model-test-status";
    status.textContent = "读取模型列表...";
    const queue = document.createElement("button");
    queue.type = "button";
    queue.className = "gjj-ltx-wide-button";
    queue.textContent = "加入队列";
    queue.disabled = true;
    actions.append(selectVisible, clear);
    body.append(note, modeBar, search, sortBar, actions, list, queue, status);

    fetchModelFields().then((fields) => {
      const main = fields.find((field) => String(field?.name || "") === "ltx_model_name") || {};
      const lora = fields.find((field) => String(field?.name || "") === "test_lora_name") || {};
      const cfg = getConfig(node);
      const current = getConfig(node).ltx_model_name || main.fallback || "";
      const currentLora = cfg.test_lora_name || lora.fallback || "";
      const modelNames = [...new Set([current, ...(Array.isArray(main.models) ? main.models : [])].filter(Boolean))];
      const loraNames = [...new Set([currentLora, ...(Array.isArray(lora.models) ? lora.models : [])].filter(Boolean))];
      const entriesByMode = {
        model: normalizeModelTestEntries(modelNames, main.modelInfo || main.model_info || []),
        lora: normalizeModelTestEntries(loraNames, lora.modelInfo || lora.model_info || []),
      };
      const selectedByMode = {
        model: new Set(current ? [current] : []),
        lora: new Set(),
      };
      let testMode = "model";
      let sortMode = "name";
      const currentEntries = () => entriesByMode[testMode] || [];
      const currentSelected = () => selectedByMode[testMode] || selectedByMode.model;
      const syncSortButtons = () => {
        sortByName.classList.toggle("is-active", sortMode === "name");
        sortBySize.classList.toggle("is-active", sortMode === "size");
      };
      const syncModeButtons = () => {
        modelModeBtn.classList.toggle("is-active", testMode === "model");
        loraModeBtn.classList.toggle("is-active", testMode === "lora");
      };
      const refresh = () => {
        syncSortButtons();
        syncModeButtons();
        search.placeholder = testMode === "lora" ? "搜索 LoRA" : "搜索模型";
        renderModelTestChoices(list, currentEntries(), currentSelected(), search.value, sortMode);
        const fixedSeed = Number(getConfig(node).seed || DEFAULT_CONFIG.seed || 0);
        status.textContent = `勾选要测试的${testMode === "lora" ? " LoRA" : "模型"}。固定随机种：${fixedSeed}`;
      };
      search.addEventListener("input", refresh);
      modelModeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        testMode = "model";
        refresh();
      });
      loraModeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        testMode = "lora";
        if (!String(search.value || "").trim()) search.value = "ltx";
        refresh();
      });
      sortByName.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        sortMode = "name";
        refresh();
      });
      sortBySize.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        sortMode = "size";
        refresh();
      });
      selectVisible.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const q = String(search.value || "").trim().toLowerCase();
        for (const item of currentEntries()) {
          if (!q || String(item.name).toLowerCase().includes(q)) currentSelected().add(item.name);
        }
        refresh();
      });
      clear.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        currentSelected().clear();
        refresh();
      });
      queue.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        queueModelTestBatch(node, [...currentSelected()], status, queue, testMode);
      });
      queue.disabled = false;
      refresh();
    }).catch((error) => {
      status.textContent = `读取模型列表失败：${error?.message || error}`;
    });
  }, { width: 620 });
}

function buildPanel(node) {
  const root = document.createElement("div");
  root.className = "gjj-ltx-clean";
  stopCanvasEvents(root);

  const tools = document.createElement("div");
  tools.className = "gjj-ltx-toolbar";

  const fileBtn = makeToolButton("📁", "打开参考图片并自动连接到本节点", () => chooseReferenceImages(node));
  const modelBtn = makeToolButton("🧠", "模型树：主模型、VAE、文本编码器、Latent 放大和转场 LoRA", (button) => showModelTreePanel(node, button));
  const negativeBtn = makeToolButton("📒", "全局提示词与反向提示词", (button) => showFloatingPanel(node, button, "提示词设置", (body) => {
    body.append(
      panelRow("全局提示词", configInput(node, "global_prompt", "textarea", { rows: 5, placeholder: "自动添加到每一段提示词最前面" })),
      panelRow("反向提示词", configInput(node, "negative_prompt", "textarea", { rows: 7 })),
    );
    readSharedPromptSettings().then((values) => body.append(
      panelRow("有人声图片提示（闭嘴、特写）", sharedPromptInput("vocal_image_prompt", values.vocal_image_prompt, 5)),
      panelRow("有人声 LTX 替换（开口、运镜）", sharedPromptInput("vocal_ltx_prompt", values.vocal_ltx_prompt, 7)),
    ));
  }, { width: 460 }));
  const sizeBtn = makeToolButton("📐", "尺寸设置", (button) => showFloatingPanel(node, button, "尺寸", (body) => {
    const widthControl = configSliderNumber(node, "width", { min: 64, max: 2048, hardMax: 8192, step: 32, inputStep: 8 });
    const heightControl = configSliderNumber(node, "height", { min: 64, max: 2048, hardMax: 8192, step: 32, inputStep: 8 });
    const widthRow = panelRow("宽度", widthControl);
    const heightRow = panelRow("高度", heightControl);
    const syncDimensionAvailability = () => {
      const disabled = getConfig(node).size_source === "原视频尺寸";
      for (const [row, control] of [[widthRow, widthControl], [heightRow, heightControl]]) {
        row.style.opacity = disabled ? "0.38" : "1";
        row.style.filter = disabled ? "grayscale(1)" : "";
        row.title = disabled ? "当前使用原版尺寸，宽度和高度由输入素材决定。" : "";
        for (const input of control.querySelectorAll("input,select,button")) {
          input.disabled = disabled;
        }
      }
    };
    const sourceControl = configSegmented(
      node,
      "size_source",
      ["面板尺寸", "原视频尺寸"],
      syncDimensionAvailability,
    );
    const originalButton = sourceControl.querySelector('button[data-value="原视频尺寸"]');
    if (originalButton) originalButton.textContent = "原版尺寸";
    body.append(panelRow("视频尺寸来源", sourceControl), widthRow, heightRow);
    syncDimensionAvailability();
  }, { width: 460 }));
  const timingBtn = makeToolButton("🎞️", "时长、帧率与降噪", (button) => showFloatingPanel(node, button, "时长", (body) => {
    const segmentSecondsInput = configInput(node, "segment_seconds", "number", { min: 0.1, max: 600, step: 0.1 });
    const segmentSecondsRow = panelRow("场景间隔", segmentSecondsInput);
    node.__gjjLtxSegmentSecondsControl = {
      row: segmentSecondsRow,
      input: segmentSecondsInput,
    };
    body.append(
      segmentSecondsRow,
      panelRow("帧率", configInput(node, "fps", "number", { min: 1, max: 120, step: 1 })),
      panelRow("降噪", configInput(node, "denoise_strength", "number", { min: 0, max: 1, step: 0.01 })),
    );
    syncSegmentSecondsAvailability(node);
  }));
  const seedBtn = makeToolButton("🎲", "种子模式", (button) => showFloatingPanel(node, button, "种子", (body) => {
    body.append(
      panelRow("种子", configInput(node, "seed", "number", { min: 0, step: 1 })),
      panelRow("生成后", configSegmented(node, "seed_mode", SEED_MODES, (mode) => setSeedMode(node, mode))),
    );
  }, { width: 450 }));
  const transitionBtn = makeToolButton("🔁", "转场设置", (button) => showFloatingPanel(node, button, "转场", (body) => {
    body.append(
      panelRow("启用", configCheckbox(node, "transition_enabled")),
      panelRow("曲线", configSelect(node, "transition_curve", ["前置过渡", "平滑过渡", "线性过渡", "后置过渡"])),
      panelRow("尾段比例", configInput(node, "transition_early_tail_ratio", "number", { min: 0.1, max: 0.95, step: 0.05 })),
      panelRow("隐式帧数", configInput(node, "transition_implicit_guide_count", "number", { min: 0, max: 4, step: 1 })),
      panelRow("隐式强度", configInput(node, "transition_implicit_guide_strength", "number", { min: 0, max: 1, step: 0.01 })),
      panelRow("尾段强度", configInput(node, "transition_early_tail_strength", "number", { min: 0, max: 1, step: 0.01 })),
      panelRow("终帧强度", configInput(node, "transition_final_guide_strength", "number", { min: 0, max: 1, step: 0.01 })),
      panelRow("LoRA序列", configInput(node, "transition_lora_switches", "text", { placeholder: "例如：1,0,1" })),
    );
  }, { width: 420 }));
  const autoPromptBtn = makeToolButton("🎬", "Gemma 首尾帧过渡词开关", () => {
    const enabled = !Boolean(getConfig(node).auto_transition_prompt);
    setConfig(node, {
      auto_transition_prompt: enabled,
      transition_enabled: enabled ? true : getConfig(node).transition_enabled,
      transition_lora_enabled: enabled ? true : getConfig(node).transition_lora_enabled,
    });
    refreshToolbarState(node);
  });
  const segmentBtn = makeToolButton("🧩", "多图分段与保存", (button) => showFloatingPanel(node, button, "分段", (body) => {
    const openDirBtn = document.createElement("button");
    openDirBtn.type = "button";
    openDirBtn.className = "gjj-ltx-wide-button";
    openDirBtn.textContent = "📁 打开视频所在目录";
    openDirBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openVideoDir(node);
    };
    body.append(
      panelRow("分段执行", configCheckbox(node, "segmented_execution")),
      panelRow("保存位置", configInput(node, "segment_save_preset", "text")),
      panelRow("视频格式", configSelect(node, "segment_video_format", ["video/h264-mp4", "video/h265-mp4", "video/webm"])),
      openDirBtn,
    );
  }, { width: 430 }));
  const testBtn = makeToolButton("🧪", "选择多个主模型加入队列测试；视频文件名包含模型名和耗时", (button) => showModelTestPanel(node, button));
  const settingsBtn = makeToolButton("⚙️", "高级采样与运行参数", (button) => showFloatingPanel(node, button, "高级参数", (body) => {
    const samplers = [
      "euler", "euler_cfg_pp", "euler_ancestral", "euler_ancestral_cfg_pp",
      "heun", "heunpp2", "dpm_2", "dpm_2_ancestral", "dpmpp_2s_ancestral",
      "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "ddim", "uni_pc",
    ];
    body.append(
      panelRow("一阶段采样器", configSelect(node, "stage1_sampler", samplers)),
      panelRow("一阶段步数", configInput(node, "stage1_steps", "number", { min: 0, max: 1000, step: 1 })),
      panelRow("一阶段 Sigmas", configInput(node, "stage1_sigmas", "textarea", { rows: 3, placeholder: "留空使用当前分支默认值；步数为 0 时原样使用" })),
      panelRow("二阶段采样器", configSelect(node, "stage2_sampler", samplers)),
      panelRow("二阶段步数", configInput(node, "stage2_steps", "number", { min: 0, max: 1000, step: 1 })),
      panelRow("二阶段 Sigmas", configInput(node, "stage2_sigmas", "textarea", { rows: 3, placeholder: "留空使用当前分支默认值；步数为 0 时原样使用" })),
      panelRow("CFG", configInput(node, "cfg", "number", { min: 0, max: 100, step: 0.05 })),
      panelRow("NAG 强度", configInput(node, "nag_scale", "number", { min: -1, max: 100, step: 0.1 })),
      panelRow("NAG Alpha", configInput(node, "nag_alpha", "number", { min: -1, max: 1, step: 0.01 })),
      panelRow("NAG Tau", configInput(node, "nag_tau", "number", { min: -1, max: 100, step: 0.1 })),
      panelRow("FF 分块数", configInput(node, "ff_chunks", "number", { min: 1, max: 128, step: 1 })),
      panelRow("FF 分块阈值", configInput(node, "ff_dim_threshold", "number", { min: 256, max: 65536, step: 256 })),
      panelRow("VAE Tile", configInput(node, "vae_tile_size", "number", { min: 64, max: 4096, step: 32 })),
      panelRow("VAE 重叠", configInput(node, "vae_overlap", "number", { min: 0, max: 2048, step: 8 })),
      panelRow("VAE 时序块", configInput(node, "vae_temporal_size", "number", { min: 8, max: 4096, step: 8 })),
      panelRow("VAE 时序重叠", configInput(node, "vae_temporal_overlap", "number", { min: 0, max: 256, step: 1 })),
    );
    const note = document.createElement("div");
    note.className = "gjj-ltx-advanced-note";
    note.textContent = "步数为 0：保留内置 Sigma 数量；填写步数：按当前 Sigma 曲线重采样。留空 Sigma 使用分支默认曲线；NAG 三项为 -1 时使用普通/首尾帧分支默认值。";
    body.appendChild(note);
  }, { width: 480 }));
  const runBtn = makeToolButton("▶️", "只执行当前 LTX 节点，并在节点面板预览最终视频", () => runPreviewNode(node));

  tools.append(fileBtn, modelBtn, negativeBtn, sizeBtn, timingBtn, seedBtn, transitionBtn, autoPromptBtn, segmentBtn, testBtn, settingsBtn, runBtn);
  root.appendChild(tools);
  node.__gjjLtxTransitionButton = transitionBtn;
  node.__gjjLtxAutoPromptButton = autoPromptBtn;
  node.__gjjLtxSegmentButton = segmentBtn;
  node.__gjjLtxFileButton = fileBtn;
  node.__gjjLtxSizeButton = sizeBtn;
  node.__gjjLtxSeedButton = seedBtn;
  node.__gjjLtxRunButton = runBtn;
  refreshToolbarState(node);
  requestAnimationFrame(() => resizeNodeToFit(node));
  return root;
}

function ensurePanel(node) {
  if (!isTarget(node)) return;
  if (node.__gjjLtxCleanPanel && node.widgets?.some(w => w.name === PANEL_WIDGET)) return;
  const root = buildPanel(node);
  const widget = node.addDOMWidget?.(PANEL_WIDGET, PANEL_WIDGET, root, { serialize: false, hideOnZoom: false });
  if (widget) {
    widget.computeSize = () => [Math.max(300, node.size?.[0] || 360) - 20, Math.max(40, root.offsetHeight + 8)];
    widget.serialize = false;
  }
  node.__gjjLtxCleanPanel = root;
  resizeNodeToFit(node);
}

function ensureStatusPanel(node) {
  if (!isTarget(node)) return null;
  if (node.__gjjLtxStatusPanel && node.widgets?.some(w => w.name === STATUS_WIDGET)) return node.__gjjLtxStatusPanel;

  const wrap = document.createElement("div");
  wrap.className = "gjj-ltx-status";
  wrap.style.display = "none";
  stopCanvasEvents(wrap);
  const previewWrap = document.createElement("div");
  previewWrap.className = "gjj-ltx-preview";
  previewWrap.style.display = "none";
  previewWrap.style.setProperty("--gjj-ltx-preview-aspect", `${Math.max(1, Number(getConfig(node).width) || 16)} / ${Math.max(1, Number(getConfig(node).height) || 9)}`);
  const video = document.createElement("video");
  video.controls = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.className = "gjj-ltx-video";
  for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
    video.addEventListener(eventName, (event) => event.stopPropagation());
  }
  video.addEventListener("loadedmetadata", () => setPreviewAspect(node, video.videoWidth, video.videoHeight));
  previewWrap.appendChild(video);
  wrap.append(previewWrap);

  const state = { widget: null, wrap, previewWrap, video, hasPreview: false, previewAspect: configPreviewAspect(node) };
  const widget = node.addDOMWidget?.(STATUS_WIDGET, STATUS_WIDGET, wrap, {
    serialize: false,
    hideOnZoom: false,
    getHeight: () => previewWidgetHeight(node),
  });
  if (widget) {
    widget.serialize = false;
    widget.computeSize = (width) => [Math.max(300, width || node.size?.[0] || 360) - 20, previewWidgetHeight(node, width)];
  }
  state.widget = widget;
  node.__gjjLtxStatusPanel = state;
  return state;
}

function applyCompactWidgets(node) {
  setWidgetHidden(getWidget(node, "positive_prompt"), false);
  for (const key of HIDDEN_WIDGET_KEYS) {
    setWidgetHidden(getWidget(node, key), true);
  }
}

function installExecutionPreviewHooks(node) {
  if (node.__gjjLtxPreviewHooksInstalled) return;
  node.__gjjLtxPreviewHooksInstalled = true;
  const originalOnExecuted = node.onExecuted;
  node.onExecuted = function (message, ...args) {
    originalOnExecuted?.apply(this, [message, ...args]);
    this.__gjjLtxRunInFlight = false;
    setStatus(this, { text: "执行完成", progress: 1 });
    setVideoPreview(this, message || {});
    advanceSeedAfterExecution(this);
    refreshToolbarState(this);
  };
  const originalOnExecutionError = node.onExecutionError;
  node.onExecutionError = function (...args) {
    originalOnExecutionError?.apply(this, args);
    this.__gjjLtxRunInFlight = false;
    setStatus(this, { text: "执行失败", progress: 0 });
    refreshToolbarState(this);
  };
}

function resizeNodeToFit(node) {
  requestAnimationFrame(() => {
    try {
      const size = node.computeSize?.();
      if (size && Array.isArray(size)) {
        const width = Math.max(node.size?.[0] || 360, 360);
        const height = Math.max(size[1] + 8, 150);
        node.setSize?.([width, height]);
      }
      node.setDirtyCanvas?.(true, true);
    } catch (_) {}
  });
}

function injectStyles() {
  if (document.getElementById("gjj-ltx-clean-style")) return;
  const style = document.createElement("style");
  style.id = "gjj-ltx-clean-style";
  style.textContent = `
    .gjj-ltx-clean{box-sizing:border-box;width:100%;padding:2px 8px 4px;color:#d7dde6;font:12px/1.35 system-ui,"Microsoft YaHei",sans-serif;}
    .gjj-ltx-title{font-weight:700;color:#9fe8ff;margin:0 0 6px;opacity:.9;}
    .gjj-ltx-row{display:grid;grid-template-columns:82px minmax(0,1fr);align-items:center;gap:6px;margin:5px 0;}
    .gjj-ltx-row span{color:#aeb8c8;white-space:nowrap;}
    .gjj-ltx-row input,.gjj-ltx-row select,.gjj-ltx-row textarea{box-sizing:border-box;width:100%;border:1px solid rgba(255,255,255,.08);border-radius:7px;background:#30343a;color:#f1f5f9;padding:5px 7px;outline:none;font:12px system-ui,"Microsoft YaHei",sans-serif;}
    .gjj-ltx-row textarea{height:46px;resize:vertical;}
    .gjj-ltx-grid{display:block;}
    .gjj-ltx-tip{margin:3px 0 6px;color:#7f8fa8;font-size:11px;line-height:1.25;}
    .gjj-ltx-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0 4px;}
    .gjj-ltx-tabs button{border:1px solid rgba(125,245,255,.45);border-radius:8px;background:#12313a;color:#dffcff;padding:5px 6px;font-weight:700;cursor:pointer;}
    .gjj-ltx-tabs button.active{background:#0b756d;border-color:#5dfff1;box-shadow:0 0 8px rgba(80,255,235,.25) inset;}
    .gjj-ltx-subpanel{border:1px solid rgba(125,245,255,.18);border-radius:10px;padding:5px 7px;margin:6px 0;background:rgba(10,25,30,.35);}
    .gjj-ltx-open-dir{width:100%;margin:6px 0 2px;border:1px solid rgba(125,245,255,.45);border-radius:8px;background:#12313a;color:#dffcff;padding:6px 8px;font-weight:700;cursor:pointer;}
    .gjj-ltx-open-dir:hover{background:#0b756d;border-color:#5dfff1;}
    .gjj-ltx-toolbar{display:flex;gap:4px;align-items:center;flex-wrap:wrap;width:100%;box-sizing:border-box;pointer-events:auto;}
    .gjj-ltx-tool-btn{width:28px;height:24px;border:1px solid #3f5660;border-radius:6px;background:#172228;color:#e7f0ec;cursor:pointer;padding:0;font-size:14px;line-height:20px;}
    .gjj-ltx-tool-btn:hover{border-color:#6fb9ff;background:#1b3038;}
    .gjj-ltx-tool-btn.active{background:#124332;border-color:#55a986;color:#ecfff7;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}
    .gjj-ltx-floating input,.gjj-ltx-floating select,.gjj-ltx-floating textarea{box-sizing:border-box;background:#0b1115;color:#e7f3f3;border:1px solid #354952;border-radius:5px;padding:5px 6px;font:12px system-ui,"Microsoft YaHei",sans-serif;outline:none;}
    .gjj-ltx-floating textarea{resize:vertical;min-height:74px;}
    .gjj-ltx-float-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;margin-bottom:7px;color:#f3faf8;}
    .gjj-ltx-close{width:22px;height:22px;border:1px solid #40535b;border-radius:6px;background:#172228;color:#dce7e2;cursor:pointer;padding:0;line-height:18px;}
    .gjj-ltx-float-body{display:flex;flex-direction:column;gap:7px;min-width:0;overflow:hidden;}
    .gjj-ltx-float-row{display:grid;grid-template-columns:92px minmax(0,1fr);gap:8px;align-items:center;white-space:nowrap;width:100%;min-width:0;box-sizing:border-box;overflow:hidden;}
    .gjj-ltx-float-row span{color:#b9c9cd;white-space:nowrap;overflow:hidden;text-overflow:clip;min-width:0;}
    .gjj-ltx-segmented{display:flex;align-items:center;gap:8px;min-width:0;}
    .gjj-ltx-segmented button{height:30px;border:1px solid #40535b;border-radius:8px;background:#172228;color:#dce7e2;cursor:pointer;padding:0 12px;font-size:12px;font-weight:700;white-space:nowrap;}
    .gjj-ltx-segmented button.active{background:#1b8aca;border-color:#83d4ff;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);}
    .gjj-ltx-slider-number{display:grid;grid-template-columns:minmax(0,1fr) 88px;gap:8px;align-items:center;min-width:0;}
    .gjj-ltx-slider-number input[type="range"]{width:100%;height:22px;padding:0;border:0;background:transparent;accent-color:#42bdf1;}
    .gjj-ltx-slider-number input[type="number"]{height:32px;text-align:center;}
    .gjj-ltx-toggle{width:92px;height:28px;border:1px solid #40535c;border-radius:14px;background:#121920;color:#91a3aa;font-weight:700;cursor:pointer;padding:0 12px;}
    .gjj-ltx-toggle.active{background:#1668c7;border-color:#78c4ff;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}
    .gjj-ltx-wide-button{height:28px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:700;}
    .gjj-ltx-wide-button:hover{border-color:#6fb9ff;background:#1f3440;}
    .gjj-ltx-status{box-sizing:border-box;width:100%;padding:5px 8px 6px;color:#cbd8dd;font:12px/1.35 system-ui,"Microsoft YaHei",sans-serif;}
    .gjj-ltx-status-text{height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#aebfc6;}
    .gjj-ltx-progress{height:3px;margin-top:4px;border-radius:999px;background:#26343a;overflow:hidden;}
    .gjj-ltx-progress-inner{height:100%;width:0%;background:linear-gradient(90deg,#72c1ff,#7ed6a7);transition:width 120ms ease;}
    .gjj-ltx-preview{width:100%;aspect-ratio:var(--gjj-ltx-preview-aspect,16/9);margin-top:7px;border:1px solid #31434d;border-radius:6px;overflow:hidden;background:#05090c;}
    .gjj-ltx-video{display:block;width:100%;height:100%;object-fit:contain;background:#05090c;}
    .gjj-ltx-model-title{display:flex;align-items:baseline;gap:8px;margin:2px 0 0;}
    .gjj-ltx-model-title div:first-child{color:#eef7f2;font-weight:700;}
    .gjj-ltx-model-title div:last-child{color:#9fb0b8;font-size:12px;}
    .gjj-ltx-lora-inline-controls{display:grid;grid-template-columns:28px 82px;gap:6px;align-items:center;min-width:0;}
    .gjj-ltx-lora-inline-controls.is-off{opacity:.45;filter:grayscale(1);}
    .gjj-ltx-lora-emoji-toggle{width:26px;height:22px;border:1px solid #3d535d;border-radius:5px;background:#17242a;color:#e7f3f3;cursor:pointer;padding:0;font-size:13px;line-height:18px;}
    .gjj-ltx-lora-inline-controls.is-off .gjj-ltx-lora-emoji-toggle{background:#11181c;color:#7f8b91;border-color:#2d3a40;}
    .gjj-ltx-lora-strength{width:82px!important;height:24px;text-align:center;padding:3px 5px!important;}
    .gjj-ltx-lora-strength:disabled{cursor:not-allowed;color:#879197;background:#10171b;border-color:#2b3940;}
    .gjj-ltx-general-lora-slots{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #33454c;border-radius:8px;background:#0f171b;}
    .gjj-ltx-general-lora-row{display:grid;grid-template-columns:58px minmax(0,1fr) 28px 82px;gap:6px;align-items:center;color:#b8c8cf;font-size:11px;}
    .gjj-ltx-general-lora-row select,.gjj-ltx-general-lora-row input{box-sizing:border-box;height:26px;min-width:0;border:1px solid #3d535d;border-radius:5px;background:#111d22;color:#e7f3f3;padding:2px 6px;}
    .gjj-ltx-general-lora-row input{text-align:center;}
    .gjj-ltx-convrot-panel{display:flex;flex-direction:column;gap:7px;border:1px solid #8a5b1d;border-radius:7px;background:#21170b;color:#ffe7bd;padding:8px;white-space:normal;}
    .gjj-ltx-convrot-panel[data-supported="true"]{border-color:#2f7356;background:#10241c;color:#d8ffe9;}
    .gjj-ltx-convrot-text{font-size:12px;line-height:1.42;overflow-wrap:anywhere;}
    .gjj-ltx-convrot-panel button{height:28px;border:1px solid #d85a5a;border-radius:6px;background:#bf3434;color:#fff4f4;font-weight:700;cursor:pointer;}
    .gjj-ltx-convrot-panel button:disabled{opacity:.72;cursor:default;}
    .gjj-ltx-model-test-note{color:#b9c9cd;line-height:1.45;white-space:normal;}
    .gjj-ltx-model-test-mode{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
    .gjj-ltx-model-test-mode button{height:28px;border:1px solid #40535b;border-radius:6px;background:#152229;color:#dce7e2;cursor:pointer;font-size:12px;font-weight:700;}
    .gjj-ltx-model-test-mode button.is-active{border-color:#5f91a8;background:#213743;color:#ffffff;}
    .gjj-ltx-model-test-search{height:30px;width:100%;}
    .gjj-ltx-model-test-sort{display:flex;align-items:center;gap:7px;color:#9fb0b8;font-size:12px;}
    .gjj-ltx-model-test-sort button{height:26px;border:1px solid #40535b;border-radius:6px;background:#152229;color:#dce7e2;cursor:pointer;padding:0 9px;font-size:12px;font-weight:700;}
    .gjj-ltx-model-test-sort button.is-active{border-color:#5f91a8;background:#213743;color:#ffffff;}
    .gjj-ltx-model-test-actions{display:flex;gap:8px;}
    .gjj-ltx-model-test-actions button{height:28px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 9px;font-size:12px;font-weight:700;}
    .gjj-ltx-model-test-list{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto;border:1px solid #2c3d45;border-radius:7px;background:#0b1115;padding:6px;}
    .gjj-ltx-model-test-choice{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:start;gap:6px;min-height:24px;padding:3px 4px;border-radius:5px;color:#e6f1ef;white-space:normal;cursor:pointer;}
    .gjj-ltx-model-test-choice:hover{background:#17242b;}
    .gjj-ltx-model-test-choice input{margin-top:2px;}
    .gjj-ltx-model-test-name{overflow-wrap:anywhere;line-height:1.35;}
    .gjj-ltx-model-test-size{color:#9fb0b8;font-size:12px;line-height:1.35;white-space:nowrap;text-align:right;}
    .gjj-ltx-model-test-empty,.gjj-ltx-model-test-status{color:#9fb0b8;line-height:1.4;white-space:normal;overflow-wrap:anywhere;}
  `;
  document.head.appendChild(style);
}

function stabilize(node) {
  if (!isTarget(node)) return;
  injectStyles();
  normalizeInputs(node);
  wireNativeMainWidgets(node);
  syncNativeMainWidgets(node, false);
  applyCompactWidgets(node);
  ensurePanel(node);
  ensureStatusPanel(node);
  installExecutionPreviewHooks(node);
  refreshToolbarState(node);
  syncSegmentSecondsAvailability(node);
  scheduleConvrotSupportCheck(node);
  repairLinks(node);
}

app.registerExtension({
  name: "GJJ.LTX23.CleanV40",
  setup() {
    api.addEventListener("gjj_ltx23_multiref_segment", (event) => {
      const detail = event?.detail || {};
      for (const node of app.graph?._nodes || []) {
        if (!isTarget(node) || String(node.id) !== String(detail.node)) continue;
        setVideoPreview(node, {
          preview_media: detail.media ? [detail.media] : [],
          preview_main_path: detail.path || "",
          preview_is_video: true,
        });
      }
    });
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    const typeName = nodeData?.name || nodeData?.display_name || nodeData?.title || "";
    if (!String(typeName).includes(NODE_CLASS) && !/GJJ.*LTX.*多图/i.test(String(typeName))) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      onNodeCreated?.apply(this, args);
      console.log("[GJJ LTX2.3] clean v40: multi-frame segments force first-last workflow and auto transition LoRA");
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 250);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      onConfigure?.apply(this, args);
      try { restoreSceneInputsFromSavedData(this, args?.[0]); } catch (_) {}
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 120);
      setTimeout(() => stabilize(this), 400);
      setTimeout(() => stabilize(this), 900);
    };
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      onConnectionsChange?.apply(this, args);
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 50);
    };
    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (data, ...args) {
      onSerialize?.apply(this, [data, ...args]);
      try {
        syncNativeMainWidgets(this, false);
        saveSceneRestoreState(this);
        if (data && this.properties) data.properties = { ...(data.properties || {}), ...this.properties };
      } catch (_) {}
      // 重要：不要 return，避免 LGraphNode.ts 的 onSerialize 警告。
    };
  },
  loadedGraphNode(node) { requestAnimationFrame(() => stabilize(node)); setTimeout(() => stabilize(node), 250); setTimeout(() => stabilize(node), 800); },
});

// 兜底：某些前端版本不稳定触发生命周期时，低频扫描一次。
setInterval(() => {
  for (const node of app.graph?._nodes || []) {
    if (isTarget(node)) stabilize(node);
  }
}, 1200);

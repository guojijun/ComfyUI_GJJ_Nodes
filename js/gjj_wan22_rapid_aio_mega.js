import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_Wan22RapidAIOMega"]);
const TOOLBAR_WIDGET_NAME = "gjj_wan22_rapid_aio_mega_toolbar";
const MATERIAL_TIMELINE_WIDGET_NAME = "gjj_wan22_rapid_aio_mega_material_timeline";
const STATUS_WIDGET_NAME = "gjj_wan22_rapid_aio_mega_status";
const TEMPLATE_BINDINGS_PROPERTY = "gjj_wan22_template_bindings";
const MIN_WIDTH = 320;
const TOOLBAR_HEIGHT = 34;
const MATERIAL_IMAGE_HEIGHT = 116;
const MATERIAL_SCROLLBAR_SPACE = 22;
const MATERIAL_TIMELINE_HEIGHT = 190;
const PANEL_HEIGHT = 72;
const PREVIEW_PANEL_HEIGHT = 236;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const AUTO_SIZE_WIDGET = "auto_use_first_image_size";
const IMAGE_FIT_MODE_WIDGET = "image_fit_mode";
const CROP_POSITION_WIDGET = "crop_position";
const PACK_INPUT_SEQUENCE_WIDGET = "pack_input_images_to_sequence";
const SEED_WIDGET = "seed";
const LOCAL_IMAGES_WIDGET = "local_image_files";
const RANDOMIZE_WIDGET = "randomize_seed_on_click";
const FPS_WIDGET = "output_fps";
const VIDEO_FORMAT_WIDGET = "video_format";
const PREFIX_WIDGET = "filename_prefix";
const AUDIO_ENABLED_WIDGET = "audio_enabled";
const AUDIO_PROMPT_WIDGET = "audio_prompt";
const AUDIO_NEGATIVE_WIDGET = "audio_negative_prompt";
const AUDIO_MMAUDIO_MODEL_WIDGET = "audio_mmaudio_model";
const AUDIO_VAE_MODEL_WIDGET = "audio_vae_model";
const AUDIO_SYNCHFORMER_MODEL_WIDGET = "audio_synchformer_model";
const AUDIO_CLIP_MODEL_WIDGET = "audio_clip_model";
const WAN_CLIP_MODEL_WIDGET = "wan_clip_model";
const WAN_VAE_MODEL_WIDGET = "wan_vae_model";
const CHECKPOINT_WIDGET = "checkpoint_name";
const SEGMENT_FRAMES_WIDGET = "segment_frames";
const SEGMENT_TIMELINE_WIDGET = "segment_timeline_config";
const POSITIVE_WIDGET = "positive_prompt";
const NEGATIVE_WIDGET = "negative_prompt";
const IMAGE_INPUT_NAME = "images";
const MULTI_IMAGE_LOADER_CLASS = "GJJ_MultiImageLoader";
const IMAGE_OPTIONS_API = "/gjj/input_images";
const TEMP_UPLOAD_API_PATH = "/gjj/multi_image_loader/upload_temp_images";
const PROMPT_INFER_OPTIONS_API = "/gjj/wan22_rapid_aio_mega/prompt_infer/options";
const PROMPT_INFER_RUN_API = "/gjj/wan22_rapid_aio_mega/prompt_infer/run";
const LINK_MEMORY_PROPERTY = "gjj_wan22_rapid_aio_mega_image_link";
const TEMPLATE_PARAM_NODE_TYPE = "GJJ_TemplateParams";
const TEMPLATE_BINDABLE_FIELDS = [
	{ name: POSITIVE_WIDGET, widget: POSITIVE_WIDGET, label: "正向提示词", type: "STRING", aliases: ["positive", "prompt", "正向", "提示词"] },
	{ name: NEGATIVE_WIDGET, widget: NEGATIVE_WIDGET, label: "反向提示词", type: "STRING", aliases: ["negative", "反向", "负面"] },
	{ name: CHECKPOINT_WIDGET, widget: CHECKPOINT_WIDGET, label: "主模型", type: "STRING", aliases: ["checkpoint", "model", "模型"] },
	{ name: WAN_CLIP_MODEL_WIDGET, widget: WAN_CLIP_MODEL_WIDGET, label: "Wan CLIP", type: "STRING", aliases: ["clip", "wan clip"] },
	{ name: WAN_VAE_MODEL_WIDGET, widget: WAN_VAE_MODEL_WIDGET, label: "Wan VAE", type: "STRING", aliases: ["vae", "wan vae"] },
	{ name: WIDTH_WIDGET, widget: WIDTH_WIDGET, label: "宽度", type: "INT", aliases: ["width", "宽"] },
	{ name: HEIGHT_WIDGET, widget: HEIGHT_WIDGET, label: "高度", type: "INT", aliases: ["height", "高"] },
	{ name: SEGMENT_FRAMES_WIDGET, widget: SEGMENT_FRAMES_WIDGET, label: "默认每段帧数", type: "INT", aliases: ["frames", "length", "num_frames", "帧数", "长度"] },
	{ name: SEED_WIDGET, widget: SEED_WIDGET, label: "种子", type: "INT", aliases: ["seed", "种子"] },
	{ name: FPS_WIDGET, widget: FPS_WIDGET, label: "视频帧率", type: "FLOAT", aliases: ["fps", "frame_rate", "帧率"] },
	{ name: VIDEO_FORMAT_WIDGET, widget: VIDEO_FORMAT_WIDGET, label: "视频格式", type: "STRING", aliases: ["format", "格式"] },
	{ name: PREFIX_WIDGET, widget: PREFIX_WIDGET, label: "文件前缀", type: "STRING", aliases: ["prefix", "filename", "文件名"] },
	{ name: AUTO_SIZE_WIDGET, widget: AUTO_SIZE_WIDGET, label: "跟随首图", type: "BOOLEAN", aliases: ["auto", "first_image", "跟随"] },
	{ name: IMAGE_FIT_MODE_WIDGET, widget: IMAGE_FIT_MODE_WIDGET, label: "图片适配", type: "STRING", aliases: ["fit", "resize", "适配", "裁剪"] },
	{ name: CROP_POSITION_WIDGET, widget: CROP_POSITION_WIDGET, label: "裁剪位置", type: "STRING", aliases: ["position", "crop", "位置", "裁剪位置"] },
	{ name: PACK_INPUT_SEQUENCE_WIDGET, widget: PACK_INPUT_SEQUENCE_WIDGET, label: "输入打包", type: "BOOLEAN", aliases: ["pack", "sequence", "打包", "序列"] },
	{ name: RANDOMIZE_WIDGET, widget: RANDOMIZE_WIDGET, label: "随机种开关", type: "BOOLEAN", aliases: ["random", "随机"] },
	{ name: AUDIO_ENABLED_WIDGET, widget: AUDIO_ENABLED_WIDGET, label: "配音启用", type: "BOOLEAN", aliases: ["audio", "enable", "配音"] },
	{ name: AUDIO_PROMPT_WIDGET, widget: AUDIO_PROMPT_WIDGET, label: "配音正向", type: "STRING", aliases: ["audio_prompt", "配音正向"] },
	{ name: AUDIO_NEGATIVE_WIDGET, widget: AUDIO_NEGATIVE_WIDGET, label: "配音反向", type: "STRING", aliases: ["audio_negative", "配音反向"] },
	{ name: AUDIO_MMAUDIO_MODEL_WIDGET, widget: AUDIO_MMAUDIO_MODEL_WIDGET, label: "MMAudio", type: "STRING", aliases: ["mmaudio"] },
	{ name: AUDIO_VAE_MODEL_WIDGET, widget: AUDIO_VAE_MODEL_WIDGET, label: "配音VAE", type: "STRING", aliases: ["audio_vae"] },
	{ name: AUDIO_SYNCHFORMER_MODEL_WIDGET, widget: AUDIO_SYNCHFORMER_MODEL_WIDGET, label: "Synchformer", type: "STRING", aliases: ["synchformer"] },
	{ name: AUDIO_CLIP_MODEL_WIDGET, widget: AUDIO_CLIP_MODEL_WIDGET, label: "配音CLIP", type: "STRING", aliases: ["audio_clip"] },
];
const HIDDEN_WIDGETS = new Set([
	NEGATIVE_WIDGET,
	CHECKPOINT_WIDGET,
	WIDTH_WIDGET,
	HEIGHT_WIDGET,
	SEGMENT_FRAMES_WIDGET,
	AUTO_SIZE_WIDGET,
	IMAGE_FIT_MODE_WIDGET,
	CROP_POSITION_WIDGET,
	PACK_INPUT_SEQUENCE_WIDGET,
	SEED_WIDGET,
	LOCAL_IMAGES_WIDGET,
	RANDOMIZE_WIDGET,
	FPS_WIDGET,
	VIDEO_FORMAT_WIDGET,
	PREFIX_WIDGET,
	AUDIO_ENABLED_WIDGET,
	AUDIO_PROMPT_WIDGET,
	AUDIO_NEGATIVE_WIDGET,
	AUDIO_MMAUDIO_MODEL_WIDGET,
	AUDIO_VAE_MODEL_WIDGET,
	AUDIO_SYNCHFORMER_MODEL_WIDGET,
	AUDIO_CLIP_MODEL_WIDGET,
	WAN_CLIP_MODEL_WIDGET,
	WAN_VAE_MODEL_WIDGET,
	SEGMENT_TIMELINE_WIDGET,
]);

let loaderOptionsPromise = null;

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function getInput(node, name) {
	return node?.inputs?.find((input) => input?.name === name) || null;
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
}

function normalizedModelName(value) {
	return String(value || "").replaceAll("\\", "/").split("/").pop().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function repairMissingModelWidget(node, widgetName, preferredTokens = []) {
	const widget = getWidget(node, widgetName);
	const values = Array.isArray(widget?.options?.values) ? widget.options.values.map(String) : [];
	const current = String(widget?.value ?? "");
	if (!widget || !values.length || values.includes(current)) return;

	const normalizedCurrent = normalizedModelName(current);
	let replacement = values.find((value) => value && normalizedModelName(value) === normalizedCurrent);
	if (!replacement) {
		const tokens = preferredTokens.map((token) => String(token).toLowerCase());
		replacement = values.find((value) => {
			const lowered = value.toLowerCase();
			return value && tokens.every((token) => lowered.includes(token));
		});
	}
	replacement ||= values.find(Boolean);
	if (replacement) setWidgetValue(widget, replacement);
}

function repairMissingModelDefaults(node) {
	// 旧工作流可能保存了已删除的文件名，或仅使用了不同的横线/下划线。
	// ComfyUI 会在执行前把这种 combo 值判为“缺失模型”，因此节点加载时
	// 同时修复主模型以及被界面隐藏的 Wan CLIP / VAE。
	repairMissingModelWidget(node, CHECKPOINT_WIDGET);
	repairMissingModelWidget(node, WAN_CLIP_MODEL_WIDGET, ["umt5"]);
	repairMissingModelWidget(node, WAN_VAE_MODEL_WIDGET, ["wan", "vae"]);
}

function safeJsonParse(value, fallback) {
	if (value && typeof value === "object") return value;
	try {
		const parsed = JSON.parse(String(value ?? ""));
		return parsed ?? fallback;
	} catch (_) {
		return fallback;
	}
}

function widgetValue(node, name, fallback = "") {
	const widget = getWidget(node, name);
	if (typeof widget?.value !== "undefined") return widget.value;
	const prop = node?.properties?.[name];
	return typeof prop !== "undefined" ? prop : fallback;
}

function nodeType(node) {
	return String(node?.comfyClass || node?.type || node?.constructor?.type || "");
}

function isTemplateParamsNode(node) {
	return nodeType(node) === TEMPLATE_PARAM_NODE_TYPE;
}

function templateNodeLabel(node) {
	return `${node?.title || nodeType(node) || TEMPLATE_PARAM_NODE_TYPE} #${node?.id ?? "?"}`;
}

function templateBindings(node) {
	const parsed = safeJsonParse(node?.properties?.[TEMPLATE_BINDINGS_PROPERTY], {});
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
}

function setTemplateBindings(node, bindings) {
	node.properties = node.properties || {};
	const clean = {};
	for (const [field, binding] of Object.entries(bindings || {})) {
		if (!binding || typeof binding !== "object") continue;
		const nodeId = String(binding.nodeId ?? binding.node_id ?? "").trim();
		const key = String(binding.key ?? "").trim();
		if (nodeId && key) clean[field] = { nodeId, key };
	}
	node.properties[TEMPLATE_BINDINGS_PROPERTY] = clean;
	syncTemplateBindings(node);
	refreshToolbarState(node);
	refreshNode(node);
}

function templateFieldNames(field) {
	return [
		field?.key,
		field?.label,
		field?.broadcast_key,
		field?.broadcastKey,
		...(Array.isArray(field?.broadcast_keys) ? field.broadcast_keys : []),
		...(Array.isArray(field?.broadcastKeys) ? field.broadcastKeys : []),
	].map((item) => String(item || "").trim()).filter(Boolean);
}

function templateFieldValue(field, values) {
	for (const key of templateFieldNames(field)) {
		if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
	}
	return field?.default ?? field?.value ?? "";
}

function templateParamEntries(graph = app.graph) {
	const entries = [];
	for (const sourceNode of graph?._nodes || []) {
		if (!isTemplateParamsNode(sourceNode)) continue;
		const schema = safeJsonParse(widgetValue(sourceNode, "schema_json", sourceNode.properties?.gjj_template_params_schema || "[]"), []);
		const values = safeJsonParse(widgetValue(sourceNode, "values_json", sourceNode.properties?.gjj_template_params_values || "{}"), {});
		if (!Array.isArray(schema)) continue;
		for (const field of schema) {
			const key = String(field?.key || field?.label || "").trim();
			if (!key) continue;
			const broadcastKeys = Array.isArray(field?.broadcast_keys) ? field.broadcast_keys : (Array.isArray(field?.broadcastKeys) ? field.broadcastKeys : []);
			entries.push({
				nodeId: String(sourceNode.id),
				nodeLabel: templateNodeLabel(sourceNode),
				key,
				label: String(field?.label || key),
				type: String(field?.type || "ANY"),
				broadcastKey: String(field?.broadcast_key || field?.broadcastKey || broadcastKeys[0] || ""),
				value: templateFieldValue(field, values),
			});
		}
	}
	return entries;
}

function templateEntryId(entry) {
	return `${entry.nodeId}:${entry.key}`;
}

function entryMatchesField(entry, field) {
	const haystack = [entry.key, entry.label, entry.broadcastKey, entry.type].join(" ").toLowerCase();
	return (field.aliases || []).some((alias) => haystack.includes(String(alias || "").toLowerCase()));
}

function coerceTemplateValue(value, field) {
	if (field.type === "INT") {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? Math.round(numeric) : undefined;
	}
	if (field.type === "FLOAT") {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? numeric : undefined;
	}
	if (field.type === "BOOLEAN") {
		if (typeof value === "boolean") return value;
		const text = String(value ?? "").trim().toLowerCase();
		if (["true", "1", "yes", "on", "启用", "开启", "开"].includes(text)) return true;
		if (["false", "0", "no", "off", "禁用", "关闭", "关"].includes(text)) return false;
		return Boolean(value);
	}
	return String(value ?? "");
}

function syncTemplateBindings(node) {
	const bindings = templateBindings(node);
	if (!Object.keys(bindings).length) return;
	const entries = templateParamEntries(node?.graph || app.graph);
	for (const field of TEMPLATE_BINDABLE_FIELDS) {
		const binding = bindings[field.name];
		if (!binding) continue;
		const entry = entries.find((item) => String(item.nodeId) === String(binding.nodeId) && String(item.key) === String(binding.key));
		if (!entry) continue;
		const next = coerceTemplateValue(entry.value, field);
		if (typeof next === "undefined") continue;
		setWidgetValue(getWidget(node, field.widget || field.name), next);
	}
}

function syncAllTemplateBindings() {
	for (const graphNode of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(nodeType(graphNode))) continue;
		repairMissingModelDefaults(graphNode);
		syncTemplateBindings(graphNode);
	}
}

function installTemplateBindingSync() {
	if (window.__gjjWan22TemplateBindingSyncInstalled) return;
	window.__gjjWan22TemplateBindingSyncInstalled = true;
	window.addEventListener("gjj-template-params-updated", () => setTimeout(syncAllTemplateBindings, 30));
	window.addEventListener("gjj-variable-broadcast-updated", () => setTimeout(syncAllTemplateBindings, 30));
	const originalGraphToPrompt = app.graphToPrompt?.bind(app);
	if (originalGraphToPrompt) {
		app.graphToPrompt = async function (...args) {
			syncAllTemplateBindings();
			return await originalGraphToPrompt(...args);
		};
	}
	const originalQueuePrompt = api.queuePrompt?.bind(api);
	if (originalQueuePrompt) {
		api.queuePrompt = async function (...args) {
			syncAllTemplateBindings();
			return await originalQueuePrompt(...args);
		};
	}
}

function makeTransientWidget(widget) {
	if (!widget) return;
	widget.serialize = false;
	widget.options ||= {};
	widget.options.serialize = false;
	widget.options.hidden = false;
	widget.options.display = undefined;
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

function modelChoiceKind(value) {
	const text = String(value || "").replaceAll("\\", "/").toLowerCase();
	if (text.includes("q2_k")) return "q2";
	if (text.endsWith(".gguf")) return "gguf";
	if (text.endsWith(".safetensors")) return "safetensors";
	return "default";
}

function modelKindColors(kind) {
	if (kind === "q2") return { background: "#3a1720", border: "#a14a5c", color: "#ffe4e8" };
	if (kind === "gguf") return { background: "#112c22", border: "#4f806c", color: "#ecfff7" };
	if (kind === "safetensors") return { background: "#102238", border: "#4a6f91", color: "#edf7ff" };
	return { background: "#0b1115", border: "#354952", color: "#e7f3f3" };
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function roundUpTo32(value) {
	const numeric = Math.max(1, Number(value || 0) || 0);
	return Math.max(320, Math.min(1536, Math.ceil(numeric / 32) * 32));
}

function applyAlignedSize(node, width, height) {
	setWidgetValue(getWidget(node, WIDTH_WIDGET), roundUpTo32(width));
	setWidgetValue(getWidget(node, HEIGHT_WIDGET), roundUpTo32(height));
}

function isAutoSizeEnabled(node) {
	return Boolean(getWidget(node, AUTO_SIZE_WIDGET)?.value);
}

function getLinkedSourceNode(node) {
	const input = getInput(node, IMAGE_INPUT_NAME);
	const linkId = input?.link;
	if (linkId == null || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	return link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
}

function getLinkedImageRecord(node) {
	const input = getInput(node, IMAGE_INPUT_NAME);
	const linkId = input?.link;
	if (linkId == null || !app.graph?.links) return null;
	const link = app.graph.links[linkId];
	if (!link) return null;
	return {
		origin_id: Number(link.origin_id),
		origin_slot: Number(link.origin_slot),
		target_slot: node.inputs?.indexOf(input) ?? Number(link.target_slot ?? 0),
	};
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		return [];
	}
}

async function fetchLoaderOptions() {
	if (!loaderOptionsPromise) {
		loaderOptionsPromise = fetch(IMAGE_OPTIONS_API)
			.then((response) => (response.ok ? response.json() : { images: [] }))
			.then((payload) => (Array.isArray(payload?.images) ? payload.images : []))
			.catch(() => []);
	}
	return loaderOptionsPromise;
}

function matchSelectionWithOptions(entry, options) {
	const filename = String(entry?.filename || "");
	const subfolder = String(entry?.subfolder || "");
	return (options || []).find((item) => (
		String(item?.filename || "") === filename &&
		String(item?.subfolder || "") === subfolder
	)) || null;
}

function buildViewUrl(item, includePreviewFormat = true) {
	if (!item?.filename) {
		return "";
	}
	const previewFormat = includePreviewFormat && typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "input")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
	);
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
	if (explicitFlag != null) {
		return Boolean(explicitFlag);
	}
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
	app.graph?.setDirtyCanvas?.(true, true);
	refreshNode(node);
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
	return {
		filename,
		subfolder,
		type: "output",
		format: firstArrayItem(detail.preview_format) ?? detail.preview_format ?? "",
		width: firstArrayItem(detail.preview_width) ?? detail.preview_width,
		height: firstArrayItem(detail.preview_height) ?? detail.preview_height,
	};
}

function loadImageSizeFromUrl(url) {
	if (!url) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

async function loadFirstImageSizeFromMultiImageLoader(sourceNode) {
	if (!sourceNode || sourceNode.comfyClass !== MULTI_IMAGE_LOADER_CLASS) {
		return null;
	}

	const state = sourceNode.__gjjMultiImageState || {};
	const firstSelected = Array.isArray(state.selection) ? state.selection[0] : null;
	if (firstSelected?.width && firstSelected?.height) {
		return { width: Number(firstSelected.width), height: Number(firstSelected.height) };
	}

	const rawSelection = getWidget(sourceNode, "selected_images")?.value
		|| sourceNode.properties?.selected_images
		|| "[]";
	const parsedSelection = parseSelection(rawSelection);
	if (parsedSelection.length > 0) {
		const matched = matchSelectionWithOptions(parsedSelection[0], await fetchLoaderOptions());
		if (matched?.width && matched?.height) {
			return { width: Number(matched.width), height: Number(matched.height) };
		}
	}

	const executedImages = Array.isArray(state.executedImages) ? state.executedImages : [];
	const firstExecuted = executedImages[0];
	if (firstExecuted?.width && firstExecuted?.height) {
		return { width: Number(firstExecuted.width), height: Number(firstExecuted.height) };
	}
	if (firstExecuted?.filename) {
		return loadImageSizeFromUrl(buildViewUrl(firstExecuted));
	}

	return null;
}

async function loadFirstImageSizeFromSource(sourceNode) {
	if (!sourceNode) {
		return null;
	}
	if (sourceNode.comfyClass === MULTI_IMAGE_LOADER_CLASS) {
		return loadFirstImageSizeFromMultiImageLoader(sourceNode);
	}
	return null;
}

function uploadUrl(path) {
	return api?.apiURL ? api.apiURL(path) : path;
}

function normalizeUploadItem(data, file, subfolder = "GJJ_Wan22RapidAIOMega") {
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

async function fetchPromptInferOptions() {
	const response = api?.fetchApi
		? await api.fetchApi(PROMPT_INFER_OPTIONS_API)
		: await fetch(uploadUrl(PROMPT_INFER_OPTIONS_API));
	if (!response?.ok) throw new Error(`读取反推模型失败：HTTP ${response?.status || "?"}`);
	const data = await response.json().catch(() => ({}));
	if (!data?.ok) throw new Error(String(data?.error || "读取反推模型失败"));
	return data.methods || {};
}

async function runPromptInferRequest(payload) {
	const response = api?.fetchApi
		? await api.fetchApi(PROMPT_INFER_RUN_API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload || {}),
		})
		: await fetch(uploadUrl(PROMPT_INFER_RUN_API), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload || {}),
		});
	const data = await response.json().catch(() => ({}));
	if (!response?.ok || !data?.ok) throw new Error(String(data?.error || `反推失败：HTTP ${response?.status || "?"}`));
	return String(data.prompt || "").trim();
}

function chooseLocalImages(node) {
	if (getInput(node, IMAGE_INPUT_NAME)?.link != null) {
		setStatus(node, { text: "批量图片已连接外部输入，📂 已按外链优先禁用。", progress: 0 });
		return;
	}
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*";
	input.multiple = true;
	input.onchange = async () => {
		const files = Array.from(input.files || []);
		if (!files.length) return;
		setStatus(node, { text: `正在导入 ${files.length} 张图片...`, progress: 0.15 });
		try {
			const items = [];
			for (const file of files) {
				const item = await uploadImageFile(file);
				if (item) items.push(item);
			}
			setMaterialTimelineItems(node, items, `已写入 ${items.length} 张临时图片`);
		} catch (error) {
			setStatus(node, { text: String(error?.message || error || "图片导入失败"), progress: 0 });
		}
	};
	input.click();
}

function sourceSelectedImages(node) {
	const source = getLinkedSourceNode(node);
	if (!source) return [];
	const state = source.__gjjMultiImageState || {};
	if (Array.isArray(state.selection) && state.selection.length) return state.selection;
	if (Array.isArray(state.executedImages) && state.executedImages.length) return state.executedImages;
	const raw = getWidget(source, "selected_images")?.value || source.properties?.selected_images || "";
	return parseSelection(raw);
}

function localSelectedImages(node) {
	const raw = getWidget(node, LOCAL_IMAGES_WIDGET)?.value || node?.properties?.local_image_files || "[]";
	return parseSelection(raw);
}

function materialTimelineItems(node) {
	const linked = getInput(node, IMAGE_INPUT_NAME)?.link != null;
	if (linked) return sourceSelectedImages(node);
	return localSelectedImages(node);
}

function normalizeMaterialItems(items) {
	return (Array.isArray(items) ? items : []).map((item) => normalizeUploadItem(item, null, item?.subfolder || "")).filter(Boolean);
}

function setMaterialTimelineItems(node, items, message = "") {
	const clean = normalizeMaterialItems(items);
	const current = getLinkedImageRecord(node);
	node.properties ||= {};
	if (current) {
		node.properties[LINK_MEMORY_PROPERTY] = current;
		try { node.disconnectInput?.(current.target_slot); } catch (_) {}
	}
	const text = JSON.stringify(clean);
	setWidgetValue(getWidget(node, LOCAL_IMAGES_WIDGET), text);
	node.properties.local_image_files = text;
	if (message) setStatus(node, { text: message, progress: 0 });
	refreshMaterialTimeline(node, true);
	trySyncImageSize(node, true);
	refreshToolbarState(node);
	refreshNode(node);
}

function normalizeSegmentTimelineConfig(value) {
	const parsed = safeJsonParse(value, []);
	if (!Array.isArray(parsed)) return [];
	return parsed.map((item) => ({
		duration: Math.max(3, Math.min(10, Number(item?.duration ?? item?.seconds ?? 3) || 3)),
		prompt: String(item?.prompt ?? ""),
		autoPrompt: Boolean(item?.autoPrompt),
		transition: ["首尾帧", "硬切"].includes(String(item?.transition || "")) ? String(item.transition) : "首尾帧",
	}));
}

function segmentTimelineConfig(node) {
	return normalizeSegmentTimelineConfig(getWidget(node, SEGMENT_TIMELINE_WIDGET)?.value || node?.properties?.[SEGMENT_TIMELINE_WIDGET] || "[]");
}

function setSegmentTimelineConfig(node, config) {
	const clean = normalizeSegmentTimelineConfig(config);
	const text = JSON.stringify(clean);
	setWidgetValue(getWidget(node, SEGMENT_TIMELINE_WIDGET), text);
	node.properties ||= {};
	node.properties[SEGMENT_TIMELINE_WIDGET] = text;
	refreshNode(node);
}

function setSegmentPrompt(node, segmentIndex, prompt) {
	const index = Number(segmentIndex);
	if (!Number.isInteger(index) || index < 0) return;
	const next = segmentTimelineConfig(node);
	next[index] = { ...(next[index] || {}), prompt: String(prompt || "").trim(), autoPrompt: false };
	setSegmentTimelineConfig(node, next);
	refreshMaterialTimeline(node, true);
}

function showSegmentPromptEditor(node, segmentIndex, anchor) {
	const items = materialTimelineItems(node);
	const maxIndex = Math.max(0, items.length - 2);
	const index = Math.max(0, Math.min(maxIndex, Number(segmentIndex) || 0));
	const state = node?.__gjjWan22MaterialTimeline;
	const panelAnchor = state?.wrap || anchor;
	showFloatingPanel(node, panelAnchor, "编辑提示词", (body) => {
		const configs = segmentTimelineConfig(node);
		const textarea = document.createElement("textarea");
		textarea.value = String(configs[index]?.prompt || "");
		textarea.placeholder = "留空则使用全局正向提示词";
		textarea.style.cssText = [
			"width:100%",
			"height:86px",
			"box-sizing:border-box",
			"border:1px solid #42606c",
			"border-radius:7px",
			"background:#071015",
			"color:#e7f3f3",
			"font-size:13px",
			"line-height:1.45",
			"padding:7px",
			"resize:vertical",
		].join(";");
		stopPanelEvent(textarea);
		const hint = document.createElement("div");
		hint.textContent = `第 ${index + 1} 段提示词（${index + 1} -> ${index + 2}）`;
		hint.style.cssText = "color:#9fb3b8;font-size:12px";
		const buttons = document.createElement("div");
		buttons.style.cssText = "display:flex;justify-content:flex-end;gap:6px";
		const clearButton = compactButton("清空");
		const saveButton = compactButton("确定");
		clearButton.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			textarea.value = "";
			setSegmentPrompt(node, index, "");
			closeFloatingPanel(node);
		};
		saveButton.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			setSegmentPrompt(node, index, textarea.value);
			closeFloatingPanel(node);
		};
		textarea.addEventListener("keydown", (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				setSegmentPrompt(node, index, textarea.value);
				closeFloatingPanel(node);
			}
		});
		buttons.append(clearButton, saveButton);
		body.append(hint, textarea, buttons);
		setTimeout(() => {
			textarea.focus();
			textarea.select();
		}, 0);
	});
}

function splitPositivePromptSegments(text) {
	const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
	if (!normalized) return [];
	const markerSplit = normalized.split(/\n\s*(?:-{3,}|#{3,}|={3,})\s*\n/g).map((part) => part.trim()).filter(Boolean);
	const parts = markerSplit.length > 1 ? markerSplit : normalized.split("\n").map((line) => line.trim()).filter(Boolean);
	if (parts.length <= 1) return [];
	return parts.map((part) => part.replace(/^(?:第?\s*\d+\s*[段.、:：-]\s*|\d+\s*[.、:：-]\s*)/, "").trim()).filter(Boolean);
}

function clampSegmentDuration(value) {
	return Math.max(3, Math.min(10, Number(value) || 3));
}

function defaultSegmentDurationFromWidgets(node) {
	const frames = Math.max(1, Number(getWidget(node, SEGMENT_FRAMES_WIDGET)?.value || 0) || 0);
	const fps = Math.max(1, Number(getWidget(node, FPS_WIDGET)?.value || 24) || 24);
	return clampSegmentDuration(frames / fps);
}

function applyDefaultSegmentFramesToTimeline(node) {
	const items = materialTimelineItems(node);
	const segmentCount = Math.max(0, items.length - 1);
	if (segmentCount <= 0) {
		refreshMaterialTimeline(node, true);
		return;
	}
	const duration = defaultSegmentDurationFromWidgets(node);
	const current = segmentTimelineConfig(node);
	const next = [];
	for (let index = 0; index < segmentCount; index += 1) {
		next.push({ ...(current[index] || {}), duration });
	}
	setSegmentTimelineConfig(node, next);
	refreshMaterialTimeline(node, true);
	setStatus(node, { text: `已用默认每段帧数覆盖 ${segmentCount} 个素材分段：${duration.toFixed(1)} 秒/段`, progress: 0 });
}

function imageFilesFromDataTransfer(dataTransfer) {
	return Array.from(dataTransfer?.files || []).filter((file) => String(file?.type || "").startsWith("image/"));
}

function isExternalFileDrag(dataTransfer) {
	return Array.from(dataTransfer?.types || []).includes("Files");
}

function reorderedItems(items, fromIndex, toIndex) {
	const copy = Array.from(items || []);
	const from = Number(fromIndex);
	const to = Number(toIndex);
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= copy.length || to >= copy.length || from === to) {
		return copy;
	}
	const [item] = copy.splice(from, 1);
	copy.splice(to, 0, item);
	return copy;
}

async function appendDroppedImageFiles(node, files, insertIndex = null) {
	const imageFiles = Array.from(files || []).filter((file) => String(file?.type || "").startsWith("image/"));
	if (!imageFiles.length) return;
	setStatus(node, { text: `正在拖入 ${imageFiles.length} 张图片到临时区...`, progress: 0.12 });
	try {
		const uploaded = [];
		for (const file of imageFiles) {
			const item = await uploadImageFile(file);
			if (item) uploaded.push(item);
		}
		const current = materialTimelineItems(node);
		const next = Array.from(current);
		const at = Number.isInteger(insertIndex) ? Math.max(0, Math.min(next.length, insertIndex)) : next.length;
		next.splice(at, 0, ...uploaded);
		setMaterialTimelineItems(node, next, `已拖入 ${uploaded.length} 张临时图片`);
	} catch (error) {
		setStatus(node, { text: String(error?.message || error || "拖入图片失败"), progress: 0 });
	}
}

function materialLabel(item, index) {
	const name = String(item?.filename || item?.name || item?.file || `图片 ${index + 1}`).replaceAll("\\", "/").split("/").pop();
	return name || `图片 ${index + 1}`;
}

function stopPanelEvent(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return element;
}

function ensureMaterialTimelineWidget(node) {
	if (node.__gjjWan22MaterialTimeline) {
		refreshMaterialTimeline(node);
		return node.__gjjWan22MaterialTimeline.widget;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"height:178px",
		"padding:6px 8px",
		"box-sizing:border-box",
		"border:1px solid #3c515a",
		"border-radius:6px",
		"background:#0d151a",
		"pointer-events:auto",
	].join(";");
	stopPanelEvent(wrap);

	const header = document.createElement("div");
	header.style.cssText = "display:flex;justify-content:space-between;align-items:center;color:#dce7e2;font-size:12px";
	const title = document.createElement("span");
	title.textContent = "素材时间线";
	const hint = document.createElement("span");
	hint.style.cssText = "color:#8fa4ac;font-size:11px";
	header.append(title, hint);

	const strip = document.createElement("div");
	strip.style.cssText = [
		"position:relative",
		`height:${MATERIAL_IMAGE_HEIGHT + MATERIAL_SCROLLBAR_SPACE + 10}px`,
		"overflow-x:auto",
		"overflow-y:hidden",
		"white-space:nowrap",
		"scrollbar-gutter:stable",
		"background:#05090c",
		"border:1px solid #253841",
		"border-radius:4px",
	].join(";");
	strip.addEventListener("dragover", (event) => {
		const types = Array.from(event.dataTransfer?.types || []);
		if (isExternalFileDrag(event.dataTransfer) || types.includes("application/x-gjj-wan22-material-index")) {
			event.preventDefault();
		}
	});
	strip.addEventListener("drop", (event) => {
		const files = imageFilesFromDataTransfer(event.dataTransfer);
		if (!files.length) return;
		event.preventDefault();
		event.stopPropagation();
		appendDroppedImageFiles(node, files);
	});

	wrap.append(header, strip);
	const widget = node.addDOMWidget?.(MATERIAL_TIMELINE_WIDGET_NAME, MATERIAL_TIMELINE_WIDGET_NAME, wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => MATERIAL_TIMELINE_HEIGHT,
	});
	if (widget) makeTransientWidget(widget);
	node.__gjjWan22MaterialTimeline = { widget, wrap, hint, strip };
	refreshMaterialTimeline(node);
	return widget;
}

function refreshMaterialTimeline(node, force = false) {
	const state = node?.__gjjWan22MaterialTimeline;
	if (!state) return;
	const items = materialTimelineItems(node);
	const positiveSegments = splitPositivePromptSegments(getWidget(node, POSITIVE_WIDGET)?.value || "");
	const signature = JSON.stringify({
		items: items.map((item) => [item?.filename || "", item?.subfolder || "", item?.type || "input"]),
		positiveSegments,
	});
	if (!force && state.signature === signature) return;
	state.signature = signature;
	const segmentCount = Math.max(0, items.length - 1);
	const defaults = segmentTimelineConfig(node);
	let changed = false;
	while (defaults.length < segmentCount) {
		defaults.push({
			duration: clampSegmentDuration(Number(getWidget(node, SEGMENT_FRAMES_WIDGET)?.value || 65) / Math.max(1, Number(getWidget(node, FPS_WIDGET)?.value || 24))),
			prompt: "",
			transition: "首尾帧",
		});
		changed = true;
	}
	if (defaults.length > segmentCount) {
		defaults.length = segmentCount;
		changed = true;
	}
	for (let index = 0; index < segmentCount; index += 1) {
		if (positiveSegments[index] && (!String(defaults[index]?.prompt || "").trim() || defaults[index]?.autoPrompt)) {
			defaults[index] = { ...(defaults[index] || {}), prompt: positiveSegments[index], autoPrompt: true };
			changed = true;
		}
	}
	if (changed) {
		const text = JSON.stringify(defaults);
		setWidgetValue(getWidget(node, SEGMENT_TIMELINE_WIDGET), text);
		node.properties ||= {};
		node.properties[SEGMENT_TIMELINE_WIDGET] = text;
	}

	state.hint.textContent = items.length ? `${items.length} 张素材 / ${segmentCount || 1} 段` : "连接或导入图片后显示";
	state.strip.replaceChildren();

	if (!items.length) {
		const empty = document.createElement("div");
		empty.textContent = "暂无素材：可连接批量图片，或点上方文件按钮导入。";
		empty.style.cssText = "color:#8fa4ac;font-size:12px;padding:32px 10px";
		state.strip.appendChild(empty);
		return;
	}

	const row = document.createElement("div");
	row.style.cssText = [
		"position:relative",
		"display:inline-flex",
		"align-items:stretch",
		`height:${MATERIAL_IMAGE_HEIGHT}px`,
		"min-width:max-content",
		`padding:3px 3px ${MATERIAL_SCROLLBAR_SPACE}px 3px`,
	].join(";");
	state.strip.appendChild(row);

	for (const [index, item] of items.entries()) {
		const frame = document.createElement("div");
		frame.draggable = true;
		frame.dataset.materialIndex = String(index);
		frame.style.cssText = [
			"position:relative",
			`height:${MATERIAL_IMAGE_HEIGHT}px`,
			"display:inline-flex",
			"align-items:center",
			"justify-content:center",
			"background:#071015",
			"overflow:visible",
			index === 0 ? "border-radius:3px 0 0 3px" : "",
			index === items.length - 1 ? "border-radius:0 3px 3px 0" : "",
		].filter(Boolean).join(";");
		frame.addEventListener("dragstart", (event) => {
			event.dataTransfer?.setData("application/x-gjj-wan22-material-index", String(index));
			event.dataTransfer?.setData("text/plain", String(index));
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			frame.style.opacity = "0.55";
		});
		frame.addEventListener("dragend", () => {
			frame.style.opacity = "";
			for (const child of row.children) child.style.outline = "";
		});
		frame.addEventListener("dragover", (event) => {
			const types = Array.from(event.dataTransfer?.types || []);
			if (types.includes("application/x-gjj-wan22-material-index") || isExternalFileDrag(event.dataTransfer)) {
				event.preventDefault();
				if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes("application/x-gjj-wan22-material-index") ? "move" : "copy";
				frame.style.outline = "2px solid rgba(126,214,167,.9)";
				frame.style.outlineOffset = "-2px";
			}
		});
		frame.addEventListener("dragleave", () => {
			frame.style.outline = "";
		});
		frame.addEventListener("drop", (event) => {
			const files = imageFilesFromDataTransfer(event.dataTransfer);
			const rect = frame.getBoundingClientRect();
			const insertAfter = event.clientX > rect.left + rect.width / 2;
			const insertIndex = index + (insertAfter ? 1 : 0);
			frame.style.outline = "";
			if (files.length) {
				event.preventDefault();
				event.stopPropagation();
				appendDroppedImageFiles(node, files, insertIndex);
				return;
			}
			const fromRaw = event.dataTransfer?.getData("application/x-gjj-wan22-material-index") || event.dataTransfer?.getData("text/plain");
			const fromIndex = Number(fromRaw);
			if (!Number.isInteger(fromIndex)) return;
			event.preventDefault();
			event.stopPropagation();
			let targetIndex = insertIndex;
			if (fromIndex < targetIndex) targetIndex -= 1;
			const next = reorderedItems(materialTimelineItems(node), fromIndex, targetIndex);
			setMaterialTimelineItems(node, next, `已调整素材顺序：${fromIndex + 1} -> ${targetIndex + 1}`);
		});
		const img = document.createElement("img");
		img.draggable = false;
		img.loading = "lazy";
		img.src = buildViewUrl(item);
		img.title = `${index + 1}. ${materialLabel(item, index)}`;
		img.style.cssText = [
			"display:block",
			`height:${MATERIAL_IMAGE_HEIGHT}px`,
			"width:auto",
			"max-width:none",
			"object-fit:contain",
			"background:#05090c",
		].join(";");
		frame.appendChild(img);
		const promptText = String(defaults[index]?.prompt || "").trim();
		if (index < segmentCount) {
			const promptBadge = document.createElement("div");
			promptBadge.draggable = false;
			promptBadge.textContent = promptText || "双击编辑提示词";
			promptBadge.title = promptText || `双击编辑第 ${index + 1} 段提示词`;
			promptBadge.style.cssText = [
				"position:absolute",
				"left:5px",
				"right:5px",
				"bottom:5px",
				"padding:2px 5px",
				"box-sizing:border-box",
				"border-radius:4px",
				`background:${promptText ? "rgba(0,0,0,.62)" : "rgba(0,0,0,.34)"}`,
				`color:${promptText ? "#f3fff9" : "#a8bec2"}`,
				"font-size:11px",
				"line-height:15px",
				"white-space:nowrap",
				"overflow:hidden",
				"text-overflow:ellipsis",
				"cursor:text",
				"pointer-events:auto",
			].join(";");
			promptBadge.addEventListener("dblclick", (event) => {
				event.preventDefault();
				event.stopPropagation();
				showSegmentPromptEditor(node, index, promptBadge);
			});
			stopPanelEvent(promptBadge);
			frame.appendChild(promptBadge);
		}
		row.appendChild(frame);
	}

	if (!segmentCount) {
		const badge = document.createElement("div");
		badge.textContent = "单图";
		badge.style.cssText = [
			"position:absolute",
			"left:8px",
			"bottom:6px",
			"padding:2px 6px",
			"border-radius:999px",
			"background:rgba(0,0,0,.62)",
			"color:#dce7e2",
			"font-size:11px",
		].join(";");
		row.appendChild(badge);
		return;
	}

	defaults.forEach((segment, index) => {
		const write = (patch) => {
			const next = segmentTimelineConfig(node);
			next[index] = { ...(next[index] || segment), ...patch };
			setSegmentTimelineConfig(node, next);
		};
		const splitter = document.createElement("div");
		splitter.style.cssText = [
			"position:absolute",
			"top:0",
			`bottom:${MATERIAL_SCROLLBAR_SPACE}px`,
			"left:100%",
			"width:62px",
			"transform:translateX(-31px)",
			"display:flex",
			"flex-direction:column",
			"align-items:center",
			"justify-content:center",
			"gap:3px",
			"z-index:1000",
			"pointer-events:auto",
		].join(";");
		stopPanelEvent(splitter);

		const line = document.createElement("div");
		line.style.cssText = [
			"position:absolute",
			"top:0",
			"bottom:0",
			"left:30px",
			"width:4px",
			"transform:translateX(-1px)",
			"background:rgba(126,214,167,.9)",
			"box-shadow:0 0 8px rgba(126,214,167,.75)",
			"cursor:ew-resize",
			"pointer-events:auto",
			"z-index:1000",
		].join(";");
		stopPanelEvent(line);

		const makeEmojiButton = (text, title, onClick) => {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = text;
			button.title = title;
			button.style.cssText = [
				"position:absolute",
				"top:4px",
				"left:50%",
				"transform:translateX(-50%)",
				"width:20px",
				"height:20px",
				"padding:0",
				"border:1px solid rgba(255,255,255,.28)",
				"border-radius:999px",
				"background:rgba(5,9,12,.58)",
				"color:#fff",
				"font-size:13px",
				"line-height:18px",
				"cursor:pointer",
				"z-index:1002",
				"box-shadow:0 1px 5px rgba(0,0,0,.45)",
			].join(";");
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				onClick(button);
			});
			return button;
		};

		const transitionButton = makeEmojiButton(segment.transition === "硬切" ? "✂️" : "🔁", segment.transition === "硬切" ? "当前：硬切。点击切换首尾帧" : "当前：首尾帧。点击切换硬切", (button) => {
			const current = segmentTimelineConfig(node)[index]?.transition || "首尾帧";
			const nextTransition = current === "硬切" ? "首尾帧" : "硬切";
			write({ transition: nextTransition });
			button.textContent = nextTransition === "硬切" ? "✂️" : "🔁";
			button.title = nextTransition === "硬切" ? "当前：硬切。点击切换首尾帧" : "当前：首尾帧。点击切换硬切";
		});

		const timeLabel = document.createElement("div");
		timeLabel.textContent = `${clampSegmentDuration(segment.duration).toFixed(1)}s`;
		timeLabel.style.cssText = [
			"position:relative",
			"padding:1px 5px",
			"border-radius:999px",
			"background:rgba(5,9,12,.78)",
			"color:#dce7e2",
			"font-size:10px",
			"line-height:14px",
			"box-shadow:0 1px 5px rgba(0,0,0,.45)",
			"user-select:none",
			"z-index:1001",
		].join(";");
		const startDurationDrag = (event) => {
			event.preventDefault();
			event.stopPropagation();
			const startX = event.clientX;
			const startValue = clampSegmentDuration(segmentTimelineConfig(node)[index]?.duration ?? segment.duration ?? 3);
			const move = (moveEvent) => {
				const nextValue = clampSegmentDuration(Math.round((startValue + ((moveEvent.clientX - startX) / 26)) * 10) / 10);
				timeLabel.textContent = `${nextValue.toFixed(1)}s`;
				write({ duration: nextValue });
			};
			const up = () => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
		};
		line.addEventListener("pointerdown", startDurationDrag);
		timeLabel.addEventListener("pointerdown", startDurationDrag);
		timeLabel.title = "拖动分割线或秒数调整时长（3-10 秒）";
		line.title = "拖动调整这一段时长（3-10 秒）";

		splitter.append(line, transitionButton, timeLabel);
		const leftFrame = row.children[index];
		if (leftFrame) leftFrame.appendChild(splitter);
	});
}

function getGraphLink(graph, linkId) {
	if (linkId == null) return null;
	const links = graph?.links || app.graph?.links;
	if (!links) return null;
	if (Array.isArray(links)) return links.find((link) => Number(link?.id) === Number(linkId)) || links[Number(linkId)] || null;
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
			const link = getGraphLink(graph, input?.link);
			const originId = link?.origin_id;
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
		syncTemplateBindings(node);
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

function detachOrRestoreImageLink(node) {
	node.properties = node.properties || {};
	const current = getLinkedImageRecord(node);
	if (current) {
		const selected = sourceSelectedImages(node);
		if (!selected.length) {
			setStatus(node, { text: "当前外链来源没有可复制的图片列表。", progress: 0 });
			return;
		}
		node.properties[LINK_MEMORY_PROPERTY] = current;
		setWidgetValue(getWidget(node, LOCAL_IMAGES_WIDGET), JSON.stringify(selected));
		node.properties.local_image_files = JSON.stringify(selected);
		try { node.disconnectInput?.(current.target_slot); } catch (_) {}
		setStatus(node, { text: `已吸收外链 ${selected.length} 张图片，并断开输入。再次点 🔗 可恢复。`, progress: 0 });
		refreshMaterialTimeline(node);
		refreshNode(node);
		return;
	}
	const memory = node.properties[LINK_MEMORY_PROPERTY];
	if (!memory) {
		setStatus(node, { text: "没有可恢复的外链记录。", progress: 0 });
		return;
	}
	const source = app.graph?.getNodeById?.(Number(memory.origin_id));
	const targetSlot = Number(memory.target_slot ?? 0);
	const sourceSlot = Number(memory.origin_slot ?? 0);
	if (!source?.connect || !Number.isFinite(targetSlot) || !Number.isFinite(sourceSlot)) {
		setStatus(node, { text: "记住的外链节点已不存在，无法恢复。", progress: 0 });
		return;
	}
	try {
		if (node.inputs?.[targetSlot]?.link != null) node.disconnectInput?.(targetSlot);
		source.connect(sourceSlot, node, targetSlot);
		delete node.properties[LINK_MEMORY_PROPERTY];
		setStatus(node, { text: "已恢复批量图片外链。", progress: 0 });
		refreshMaterialTimeline(node);
		refreshNode(node);
	} catch (error) {
		setStatus(node, { text: String(error?.message || error || "恢复外链失败"), progress: 0 });
	}
}

function randomSeed() {
	return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function toggleRandomSeed(node, button) {
	const widget = getWidget(node, RANDOMIZE_WIDGET);
	const next = !Boolean(widget?.value);
	setWidgetValue(widget, next);
	setWidgetValue(getWidget(node, SEED_WIDGET), randomSeed());
	refreshToolbarState(node);
	refreshNode(node);
}

async function runPreviewNode(node) {
	if (node.__gjjWan22RunInFlight) return;
	node.__gjjWan22RunInFlight = true;
	refreshToolbarState(node);
	setStatus(node, { text: "正在提交本节点执行...", progress: 0.02 });
	try {
		const ok = await queueOnlyCurrentNode(node);
		if (!ok) {
			setStatus(node, { text: "当前 ComfyUI 前端不支持直接执行本节点。", progress: 0 });
			node.__gjjWan22RunInFlight = false;
			refreshToolbarState(node);
		}
	} catch (error) {
		setStatus(node, { text: String(error?.message || error || "提交执行失败"), progress: 0 });
		node.__gjjWan22RunInFlight = false;
		refreshToolbarState(node);
	}
}

function resetNodeState(node) {
	if (!node) return;
	node.properties ||= {};
	node.__gjjWan22RunInFlight = false;
	delete node.properties[LINK_MEMORY_PROPERTY];
	delete node.properties.local_image_files;
	setWidgetValue(getWidget(node, LOCAL_IMAGES_WIDGET), "[]");
	setWidgetValue(getWidget(node, SEGMENT_TIMELINE_WIDGET), "[]");
	node.properties[SEGMENT_TIMELINE_WIDGET] = "[]";
	closeFloatingPanel(node);
	clearNativePreview(node);
	setVideoPreview(node, {});
	setStatus(node, { text: "已清空节点缓存，等待执行", progress: 0 });
	refreshToolbarState(node);
	refreshMaterialTimeline(node);
	ensureStatusPanelSize(node);
	refreshNode(node);
}

function showResetConfirmPanel(node, anchor) {
	showFloatingPanel(node, anchor, "确认清空", (body) => {
		const text = document.createElement("div");
		text.textContent = "将清空本节点的内部图片、素材时间线配置、预览和运行状态。";
		text.style.cssText = "color:#dce7e2;font-size:12px;line-height:1.5;white-space:normal";
		const warn = document.createElement("div");
		warn.textContent = "这个操作不能自动恢复。";
		warn.style.cssText = "color:#ffcf8a;font-size:12px";
		const buttons = document.createElement("div");
		buttons.style.cssText = "display:flex;justify-content:flex-end;gap:6px";
		const cancelButton = compactButton("取消");
		const confirmButton = compactButton("确认清空");
		confirmButton.style.background = "#4a1f23";
		confirmButton.style.borderColor = "#a85b62";
		cancelButton.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			closeFloatingPanel(node);
		};
		confirmButton.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			closeFloatingPanel(node);
			resetNodeState(node);
		};
		buttons.append(cancelButton, confirmButton);
		body.append(text, warn, buttons);
	});
}

function closeFloatingPanel(node) {
	const panel = node?.__gjjWan22FloatingPanel;
	if (!panel) return;
	if (typeof panel.__gjjWan22Close === "function") panel.__gjjWan22Close();
	else panel.remove?.();
	if (node.__gjjWan22FloatingPanel === panel) node.__gjjWan22FloatingPanel = null;
}

function showFloatingPanel(node, anchor, title, build) {
	closeFloatingPanel(node);
	const panel = document.createElement("div");
	panel.className = "gjj-wan22-floating";
	const panelWidth = title === "模型" ? 660 : (title === "模板参数" ? 760 : (title === "反推" ? 520 : (title === "编辑提示词" ? 460 : 360)));
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
	panel.addEventListener("pointerdown", (event) => event.stopPropagation());
	panel.addEventListener("mousedown", (event) => event.stopPropagation());
	panel.addEventListener("mouseup", (event) => event.stopPropagation());
	panel.addEventListener("click", (event) => event.stopPropagation());
	const closePanel = () => closeFloatingPanel(node);
	const outsidePointerDown = (event) => {
		if (panel.contains(event.target) || anchor?.contains?.(event.target)) return;
		closePanel();
	};
	const onKeyDown = (event) => {
		if (event.key === "Escape") closePanel();
	};
	panel.__gjjWan22Close = () => {
		document.removeEventListener("pointerdown", outsidePointerDown, true);
		document.removeEventListener("keydown", onKeyDown, true);
		panel.remove?.();
		if (node.__gjjWan22FloatingPanel === panel) node.__gjjWan22FloatingPanel = null;
	};
	const rect = anchor?.getBoundingClientRect?.() || { left: 20, bottom: 20 };
	panel.style.left = `${Math.max(10, Math.min(window.innerWidth - panelWidth - 10, Math.max(10, rect.left)))}px`;
	const preferAbove = title === "编辑提示词";
	const panelTop = preferAbove
		? Math.max(10, Number(rect.top || 20) - 168)
		: Math.min(window.innerHeight - 80, Math.max(10, rect.bottom + 6));
	panel.style.top = `${panelTop}px`;
	const head = document.createElement("div");
	head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;margin-bottom:7px;color:#f3faf8";
	const headTitle = document.createElement("span");
	headTitle.textContent = title;
	const closeButton = document.createElement("button");
	closeButton.type = "button";
	closeButton.textContent = "×";
	closeButton.title = "关闭";
	closeButton.style.cssText = "width:22px;height:22px;border:1px solid #40535b;border-radius:6px;background:#172228;color:#dce7e2;cursor:pointer;padding:0;line-height:18px";
	closeButton.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		closePanel();
	};
	closeButton.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closePanel();
	});
	head.append(headTitle, closeButton);
	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:7px;min-width:0;overflow:hidden";
	panel.append(head, body);
	build(body);
	document.body.appendChild(panel);
	node.__gjjWan22FloatingPanel = panel;
	setTimeout(() => {
		document.addEventListener("pointerdown", outsidePointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
	}, 0);
}

function row(label, element, options = {}) {
	const wrap = document.createElement("label");
	const labelWidth = options.labelWidth || "110px";
	const controlWidth = options.controlWidth || "minmax(0,1fr)";
	wrap.style.cssText = `display:grid;grid-template-columns:${labelWidth} ${controlWidth};gap:8px;align-items:center;white-space:nowrap;width:100%;min-width:0;box-sizing:border-box;overflow:hidden`;
	const span = document.createElement("span");
	span.textContent = label;
	span.style.cssText = "color:#b9c9cd;white-space:nowrap;overflow:hidden;text-overflow:clip;min-width:0";
	element.style.minWidth = "0";
	element.style.width = "100%";
	element.style.maxWidth = "100%";
	element.style.boxSizing = "border-box";
	wrap.append(span, element);
	return wrap;
}

function modelRow(label, element) {
	return row(label, element, { labelWidth: "126px", controlWidth: "minmax(0,1fr)" });
}

function bindInput(widgetName, type = "text") {
	const widget = getWidget(this, widgetName);
	const input = document.createElement(type === "textarea" ? "textarea" : "input");
	if (type !== "textarea") input.type = type;
	input.value = widget?.value ?? "";
	input.style.cssText = "width:100%;box-sizing:border-box;background:#0b1115;color:#e7f3f3;border:1px solid #354952;border-radius:5px;padding:4px";
	if (type === "textarea") input.rows = 3;
	input.oninput = () => setWidgetValue(widget, type === "number" ? Number(input.value) : input.value);
	return input;
}

function bindDefaultSegmentFramesInput(node) {
	const widget = getWidget(node, SEGMENT_FRAMES_WIDGET);
	const input = document.createElement("input");
	input.type = "number";
	input.value = widget?.value ?? "";
	input.min = "1";
	input.step = "1";
	input.style.cssText = "width:100%;box-sizing:border-box;background:#0b1115;color:#e7f3f3;border:1px solid #354952;border-radius:5px;padding:4px";
	const apply = () => {
		const value = Math.max(1, Math.round(Number(input.value || widget?.value || 1) || 1));
		input.value = String(value);
		setWidgetValue(widget, value);
		applyDefaultSegmentFramesToTimeline(node);
	};
	input.onchange = apply;
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			apply();
		}
	});
	return input;
}

function bindCheckbox(node, widgetName) {
	const widget = getWidget(node, widgetName);
	const button = document.createElement("button");
	button.type = "button";
	button.style.cssText = [
		"width:92px",
		"height:28px",
		"box-sizing:border-box",
		"border-radius:14px",
		"padding:0 12px",
		"font-weight:700",
		"cursor:pointer",
		"transition:background .12s,border-color .12s,color .12s,box-shadow .12s",
	].join(";");
	const refresh = () => {
		const enabled = Boolean(widget?.value);
		button.textContent = enabled ? "开启" : "关闭";
		button.setAttribute("aria-pressed", enabled ? "true" : "false");
		button.style.background = enabled ? "#1668c7" : "#121920";
		button.style.border = enabled ? "1px solid #78c4ff" : "1px solid #40535c";
		button.style.color = enabled ? "#ffffff" : "#91a3aa";
		button.style.boxShadow = enabled ? "inset 0 0 0 1px rgba(255,255,255,.08)" : "none";
	};
	button.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		setWidgetValue(widget, !Boolean(widget?.value));
		refresh();
		refreshToolbarState(node);
		if (node?.setDirtyCanvas) node.setDirtyCanvas(true, true);
		else app.graph.setDirtyCanvas(true, true);
	};
	refresh();
	return button;
}

function bindSelect(node, widgetName, filter = null) {
	const widget = getWidget(node, widgetName);
	const select = document.createElement("select");
	let background = "#0b1115";
	let border = "#354952";
	let color = "#e7f3f3";
	if (widgetName === CHECKPOINT_WIDGET) {
		const colors = modelKindColors(modelChoiceKind(widget?.value));
		background = colors.background;
		border = colors.border;
		color = colors.color;
	} else if (widgetName === WAN_CLIP_MODEL_WIDGET || widgetName === WAN_VAE_MODEL_WIDGET) {
		background = "#10261f";
		border = "#4f806c";
	} else if (widgetName.startsWith("audio_")) {
		background = "#201b2d";
		border = "#62527f";
	}
	select.style.cssText = [
		"width:100%",
		"min-width:0",
		"max-width:100%",
		"box-sizing:border-box",
		`background:${background}`,
		`color:${color}`,
		`border:1px solid ${border}`,
		"border-radius:5px",
		"padding:4px",
		"white-space:nowrap",
		"overflow:hidden",
		"text-overflow:clip",
	].join(";");
	const values = Array.isArray(widget?.options?.values) ? widget.options.values : [];
	for (const value of values) {
		if (filter && !filter(String(value))) continue;
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = String(value) || "自动";
		option.selected = String(widget?.value) === String(value);
		if (widgetName === CHECKPOINT_WIDGET) {
			const colors = modelKindColors(modelChoiceKind(value));
			option.style.background = colors.background;
			option.style.color = colors.color;
		}
		select.appendChild(option);
	}
	const applySelectStyle = () => {
		if (widgetName !== CHECKPOINT_WIDGET) return;
		const colors = modelKindColors(modelChoiceKind(select.value));
		select.style.background = colors.background;
		select.style.borderColor = colors.border;
		select.style.color = colors.color;
	};
	select.onchange = () => {
		setWidgetValue(widget, select.value);
		applySelectStyle();
		refreshToolbarState(node);
	};
	applySelectStyle();
	return select;
}

function bindSegmentedButtons(node, widgetName, values, options = {}) {
	const widget = getWidget(node, widgetName);
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"gap:4px",
		"align-items:center",
		"flex-wrap:wrap",
		"min-width:0",
		"width:100%",
	].join(";");
	const buttons = [];
	const refresh = () => {
		const current = String(widget?.value ?? options.defaultValue ?? values[0] ?? "");
		for (const button of buttons) {
			const active = String(button.dataset.value) === current;
			button.setAttribute("aria-pressed", active ? "true" : "false");
			button.style.background = active ? (options.activeBackground || "#0c7185") : "#111820";
			button.style.borderColor = active ? (options.activeBorder || "#5de7ff") : "#40535c";
			button.style.color = active ? "#ffffff" : "#dce7e2";
			button.style.boxShadow = active ? "inset 0 0 0 1px rgba(255,255,255,.12)" : "none";
		}
	};
	for (const value of values) {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.value = String(value);
		button.textContent = String(value);
		button.title = options.titleFor?.(value) || String(value);
		button.style.cssText = [
			"height:28px",
			"min-width:38px",
			"box-sizing:border-box",
			"border:1px solid #40535c",
			"border-radius:8px",
			"background:#111820",
			"color:#dce7e2",
			"font-weight:700",
			"padding:0 10px",
			"cursor:pointer",
			"white-space:nowrap",
			"transition:background .12s,border-color .12s,color .12s,box-shadow .12s",
		].join(";");
		button.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(widget, value);
			refresh();
			refreshToolbarState(node);
			if (node?.setDirtyCanvas) node.setDirtyCanvas(true, true);
			else app.graph.setDirtyCanvas(true, true);
		};
		buttons.push(button);
		wrap.appendChild(button);
	}
	refresh();
	return wrap;
}

function bindSizeSlider(node, widgetName) {
	const widget = getWidget(node, widgetName);
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 76px;gap:8px;align-items:center;width:100%;";

	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = "320";
	slider.max = "1536";
	slider.step = "32";
	slider.style.width = "100%";

	const number = document.createElement("input");
	number.type = "number";
	number.min = "320";
	number.max = "1536";
	number.step = "32";
	number.style.cssText = [
		"width:76px",
		"box-sizing:border-box",
		"padding:4px 6px",
		"border:1px solid #436377",
		"border-radius:6px",
		"background:#111820",
		"color:#e8edf2",
		"font-size:12px",
		"text-align:center",
	].join(";");

	const sync = (value) => {
		const aligned = roundUpTo32(value);
		slider.value = String(aligned);
		number.value = String(aligned);
		setWidgetValue(widget, aligned);
		refreshNode(node);
	};

	sync(widget?.value);
	slider.oninput = () => sync(slider.value);
	number.onchange = () => sync(number.value);
	number.onkeydown = (event) => {
		if (event.key === "Enter") number.blur();
	};

	wrap.append(slider, number);
	return wrap;
}

function showTemplateBindingPanel(node, anchor) {
	showFloatingPanel(node, anchor, "模板参数", (body) => {
		body.style.display = "grid";
		body.style.gridTemplateColumns = "minmax(220px,.9fr) minmax(260px,1.1fr)";
		body.style.gap = "8px";
		body.style.maxHeight = "420px";
		const entries = templateParamEntries(node?.graph || app.graph);
		const bindings = templateBindings(node);
		const draft = JSON.parse(JSON.stringify(bindings || {}));
		let activeId = entries.find((entry) => Object.values(draft).some((binding) => String(binding?.nodeId) === entry.nodeId && String(binding?.key) === entry.key))
			? templateEntryId(entries.find((entry) => Object.values(draft).some((binding) => String(binding?.nodeId) === entry.nodeId && String(binding?.key) === entry.key)))
			: (entries[0] ? templateEntryId(entries[0]) : "");

		const left = document.createElement("div");
		const right = document.createElement("div");
		for (const column of [left, right]) {
			column.style.cssText = "min-width:0;max-height:390px;overflow:auto;border:1px solid #263f49;border-radius:7px;background:#0b1418;padding:6px;display:flex;flex-direction:column;gap:5px";
		}
		const header = (text) => {
			const el = document.createElement("div");
			el.textContent = text;
			el.style.cssText = "position:sticky;top:0;z-index:1;background:#0b1418;color:#a9c7d0;font-weight:800;border-bottom:1px solid #263f49;padding:3px 2px 6px";
			return el;
		};
		const smallButton = (text, title, onClick) => {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = text;
			button.title = title;
			button.style.cssText = "height:24px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px";
			button.onclick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				onClick();
			};
			return button;
		};
		const actions = document.createElement("div");
		actions.style.cssText = "grid-column:1 / -1;display:flex;justify-content:flex-end;gap:6px";
		actions.append(
			smallButton("清空", "清空本节点全部模板绑定", () => {
				for (const field of TEMPLATE_BINDABLE_FIELDS) delete draft[field.name];
				render();
			}),
			smallButton("应用", "保存绑定并立即同步参数", () => {
				setTemplateBindings(node, draft);
				closeFloatingPanel(node);
			}),
		);
		body.append(left, right, actions);

		const renderText = (mainText, subText = "") => {
			const wrap = document.createElement("span");
			wrap.style.cssText = "min-width:0;display:flex;flex-direction:column;gap:2px";
			const main = document.createElement("span");
			main.textContent = mainText;
			main.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800;color:#f1fff5";
			const sub = document.createElement("span");
			sub.textContent = subText;
			sub.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#9fc7d0";
			wrap.append(main, sub);
			return wrap;
		};

		const render = () => {
			left.replaceChildren(header("GJJ_TemplateParams 参数"));
			right.replaceChildren(header("本节点可绑定参数"));
			for (const entry of entries) {
				const id = templateEntryId(entry);
				const selected = id === activeId;
				const boundCount = TEMPLATE_BINDABLE_FIELDS.filter((field) => {
					const binding = draft[field.name];
					return String(binding?.nodeId) === entry.nodeId && String(binding?.key) === entry.key;
				}).length;
				const button = document.createElement("button");
				button.type = "button";
				button.style.cssText = [
					"display:flex",
					"align-items:center",
					"gap:7px",
					"width:100%",
					"border:1px solid " + (selected ? "#2f9a75" : "transparent"),
					"border-radius:7px",
					"background:" + (selected ? "rgba(16,122,92,.32)" : "transparent"),
					"color:#dce7e2",
					"text-align:left",
					"padding:6px",
					"cursor:pointer",
				].join(";");
				const mark = document.createElement("span");
				mark.textContent = boundCount ? "✓" : "";
				mark.style.cssText = "width:16px;color:#7de39b;font-weight:900";
				button.append(mark, renderText(entry.label, `${entry.key} · ${entry.type} · ${entry.nodeLabel}`));
				button.onclick = (event) => {
					event.preventDefault();
					event.stopPropagation();
					activeId = id;
					render();
				};
				left.appendChild(button);
			}
			if (!entries.length) {
				const empty = document.createElement("div");
				empty.textContent = "当前工作流没有 GJJ_TemplateParams 节点。";
				empty.style.cssText = "color:#8da2ad;padding:8px";
				left.appendChild(empty);
			}
			const activeEntry = entries.find((entry) => templateEntryId(entry) === activeId) || null;
			const fields = activeEntry
				? [...TEMPLATE_BINDABLE_FIELDS].sort((a, b) => Number(!entryMatchesField(activeEntry, a)) - Number(!entryMatchesField(activeEntry, b)))
				: TEMPLATE_BINDABLE_FIELDS;
			for (const field of fields) {
				const binding = draft[field.name];
				const selected = activeEntry && String(binding?.nodeId) === activeEntry.nodeId && String(binding?.key) === activeEntry.key;
				const matched = activeEntry && entryMatchesField(activeEntry, field);
				const button = document.createElement("button");
				button.type = "button";
				button.style.cssText = [
					"display:flex",
					"align-items:center",
					"gap:7px",
					"width:100%",
					"border:1px solid " + (selected ? "#2f9a75" : "transparent"),
					"border-radius:7px",
					"background:" + (selected ? "rgba(16,122,92,.32)" : (matched ? "rgba(63,86,96,.25)" : "transparent")),
					"color:#dce7e2",
					"text-align:left",
					"padding:6px",
					"cursor:pointer",
				].join(";");
				const mark = document.createElement("span");
				mark.textContent = selected ? "✓" : (matched ? "•" : "");
				mark.style.cssText = "width:16px;color:" + (selected ? "#7de39b" : "#9fc7d0") + ";font-weight:900";
				const current = binding ? entries.find((entry) => String(entry.nodeId) === String(binding.nodeId) && String(entry.key) === String(binding.key)) : null;
				const sub = selected
					? `使用 ${activeEntry.label}`
					: (current ? `当前：${current.label} · ${current.nodeLabel}` : `${field.type} · 点击绑定左侧参数`);
				button.append(mark, renderText(field.label, sub));
				button.onclick = (event) => {
					event.preventDefault();
					event.stopPropagation();
					if (!activeEntry) return;
					if (selected) delete draft[field.name];
					else draft[field.name] = { nodeId: activeEntry.nodeId, key: activeEntry.key };
					render();
				};
				right.appendChild(button);
			}
		};
		render();
	});
}

function firstPromptInferSegment(node) {
	const items = materialTimelineItems(node);
	const configs = segmentTimelineConfig(node);
	const segmentCount = Math.max(0, items.length - 1);
	for (let index = 0; index < segmentCount; index += 1) {
		if (!String(configs[index]?.prompt || "").trim()) return index;
	}
	return segmentCount > 0 ? 0 : -1;
}

function compactButton(text) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = text;
	button.style.cssText = [
		"height:28px",
		"border:1px solid #42606c",
		"border-radius:6px",
		"background:#17313c",
		"color:#e7f4f0",
		"font-size:12px",
		"cursor:pointer",
		"padding:0 10px",
	].join(";");
	return button;
}

function showPromptInferPanel(node, anchor) {
	const items = materialTimelineItems(node);
	const segmentCount = Math.max(0, items.length - 1);
	if (segmentCount <= 0) {
		setStatus(node, { text: "至少需要两张素材才能反推转场提示词。", progress: 0 });
		return;
	}
	showFloatingPanel(node, anchor, "反推", (body) => {
		body.style.gap = "8px";
		const methodSelect = document.createElement("select");
		const modelSelect = document.createElement("select");
		const segmentSelect = document.createElement("select");
		const resultBox = document.createElement("textarea");
		const keepModelToggle = document.createElement("button");
		const runOne = compactButton("🎬 反推当前段");
		const runEmpty = compactButton("🎬 反推全部空段");
		const runAll = compactButton("🎬 反推所有分段");
		const methods = ["GJJ_LlamaAssistant", "GJJ_GemmaTextGenerate", "GJJ_OllamaAssistant"];
		let optionsByMethod = {};

		for (const method of methods) {
			const option = document.createElement("option");
			option.value = method;
			option.textContent = method;
			methodSelect.appendChild(option);
		}
		methodSelect.value = node.properties?.gjj_wan22_prompt_infer_method || "GJJ_OllamaAssistant";

		for (let index = 0; index < segmentCount; index += 1) {
			const option = document.createElement("option");
			option.value = String(index);
			option.textContent = `第 ${index + 1} 段：${index + 1} -> ${index + 2}`;
			segmentSelect.appendChild(option);
		}
		const preferredSegment = firstPromptInferSegment(node);
		segmentSelect.value = String(Math.max(0, preferredSegment));

		for (const select of [methodSelect, modelSelect, segmentSelect]) {
			select.style.cssText = [
				"width:100%",
				"height:28px",
				"box-sizing:border-box",
				"border:1px solid #334a55",
				"border-radius:6px",
				"background:#071015",
				"color:#dce7e2",
				"font-size:12px",
			].join(";");
			stopPanelEvent(select);
		}
		resultBox.placeholder = "反推结果会显示在这里，并写入对应转场段。";
		resultBox.style.cssText = [
			"width:100%",
			"height:74px",
			"box-sizing:border-box",
			"border:1px solid #334a55",
			"border-radius:6px",
			"background:#071015",
			"color:#dce7e2",
			"font-size:12px",
			"line-height:1.45",
			"padding:6px",
			"resize:vertical",
		].join(";");
		stopPanelEvent(resultBox);

		const keepModelEnabled = () => node.properties?.gjj_wan22_prompt_infer_keep_model !== false;
		const refreshKeepModelToggle = () => {
			const enabled = keepModelEnabled();
			keepModelToggle.textContent = enabled ? "开启" : "关闭";
			keepModelToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
			keepModelToggle.style.background = enabled ? "#1668c7" : "#121920";
			keepModelToggle.style.border = enabled ? "1px solid #78c4ff" : "1px solid #40535c";
			keepModelToggle.style.color = enabled ? "#ffffff" : "#91a3aa";
			keepModelToggle.style.boxShadow = enabled ? "inset 0 0 0 1px rgba(255,255,255,.08)" : "none";
		};
		keepModelToggle.type = "button";
		keepModelToggle.title = "开启后反推完成保留模型；关闭后尽量卸载模型。";
		keepModelToggle.style.cssText = [
			"width:92px",
			"height:28px",
			"box-sizing:border-box",
			"border-radius:14px",
			"padding:0 12px",
			"font-weight:700",
			"cursor:pointer",
			"transition:background .12s,border-color .12s,color .12s,box-shadow .12s",
		].join(";");
		keepModelToggle.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			node.properties ||= {};
			node.properties.gjj_wan22_prompt_infer_keep_model = !keepModelEnabled();
			refreshKeepModelToggle();
			if (node?.setDirtyCanvas) node.setDirtyCanvas(true, true);
			else app.graph.setDirtyCanvas(true, true);
		};
		stopPanelEvent(keepModelToggle);
		refreshKeepModelToggle();

		const fillModels = () => {
			const method = methodSelect.value;
			const models = Array.isArray(optionsByMethod[method]) ? optionsByMethod[method] : [];
			modelSelect.replaceChildren();
			for (const model of models) {
				const option = document.createElement("option");
				option.value = model;
				option.textContent = model || "未找到模型";
				modelSelect.appendChild(option);
			}
			const saved = node.properties?.gjj_wan22_prompt_infer_model || "";
			if (saved && models.includes(saved)) modelSelect.value = saved;
		};
		methodSelect.addEventListener("change", () => {
			node.properties ||= {};
			node.properties.gjj_wan22_prompt_infer_method = methodSelect.value;
			fillModels();
		});
		modelSelect.addEventListener("change", () => {
			node.properties ||= {};
			node.properties.gjj_wan22_prompt_infer_model = modelSelect.value;
		});

		const applyPrompt = (segmentIndex, prompt) => {
			const clean = String(prompt || "").trim();
			if (!clean) return;
			const next = segmentTimelineConfig(node);
			next[segmentIndex] = { ...(next[segmentIndex] || {}), prompt: clean, autoPrompt: false };
			setSegmentTimelineConfig(node, next);
			refreshMaterialTimeline(node, true);
			resultBox.value = clean;
		};

		const runSegment = async (segmentIndex) => {
			const method = methodSelect.value;
			const model = modelSelect.value;
			if (!model) throw new Error("当前方式没有可用模型。");
			runOne.disabled = true;
			runEmpty.disabled = true;
			runAll.disabled = true;
			resultBox.value = `正在反推第 ${segmentIndex + 1} 段...`;
			setStatus(node, { text: `正在反推第 ${segmentIndex + 1} 段转场提示词...`, progress: 0.2 });
			const prompt = await runPromptInferRequest({
				node_id: node.id,
				method,
				model,
				keep_model: keepModelEnabled(),
				segment_index: segmentIndex,
				items: materialTimelineItems(node),
			});
			applyPrompt(segmentIndex, prompt);
			setStatus(node, { text: `已写入第 ${segmentIndex + 1} 段转场提示词`, progress: 0 });
		};

		runOne.onclick = async (event) => {
			event.preventDefault();
			event.stopPropagation();
			try {
				await runSegment(Number(segmentSelect.value || 0));
			} catch (error) {
				resultBox.value = String(error?.message || error || "反推失败");
				setStatus(node, { text: resultBox.value, progress: 0 });
			} finally {
				runOne.disabled = false;
				runEmpty.disabled = false;
				runAll.disabled = false;
			}
		};
		runEmpty.onclick = async (event) => {
			event.preventDefault();
			event.stopPropagation();
			try {
				const configs = segmentTimelineConfig(node);
				const targets = [];
				for (let index = 0; index < segmentCount; index += 1) {
					if (!String(configs[index]?.prompt || "").trim()) targets.push(index);
				}
				for (const index of (targets.length ? targets : [Number(segmentSelect.value || 0)])) {
					segmentSelect.value = String(index);
					await runSegment(index);
				}
			} catch (error) {
				resultBox.value = String(error?.message || error || "反推失败");
				setStatus(node, { text: resultBox.value, progress: 0 });
			} finally {
				runOne.disabled = false;
				runEmpty.disabled = false;
				runAll.disabled = false;
			}
		};
		runAll.onclick = async (event) => {
			event.preventDefault();
			event.stopPropagation();
			try {
				for (let index = 0; index < segmentCount; index += 1) {
					segmentSelect.value = String(index);
					await runSegment(index);
				}
			} catch (error) {
				resultBox.value = String(error?.message || error || "反推失败");
				setStatus(node, { text: resultBox.value, progress: 0 });
			} finally {
				runOne.disabled = false;
				runEmpty.disabled = false;
				runAll.disabled = false;
			}
		};

		const buttons = document.createElement("div");
		buttons.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
		buttons.append(runOne, runEmpty, runAll);
		body.append(
			row("反推方式", methodSelect),
			row("模型", modelSelect),
			row("转场段", segmentSelect),
			row("反推后保留模型", keepModelToggle),
			buttons,
			resultBox,
		);

		fetchPromptInferOptions()
			.then((methodsMap) => {
				optionsByMethod = methodsMap || {};
				fillModels();
			})
			.catch((error) => {
				resultBox.value = String(error?.message || error || "读取模型失败");
				fillModels();
			});
	});
}

function makeToolButton(text, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = text;
	button.title = title;
	button.style.cssText = [
		"width:28px",
		"height:24px",
		"border:1px solid #3f5660",
		"border-radius:6px",
		"background:#172228",
		"color:#e7f0ec",
		"cursor:pointer",
		"padding:0",
	].join(";");
	button.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick(button);
	};
	return button;
}

function applyToolButtonState(button, state = {}) {
	if (!button) return;
	const active = Boolean(state.active);
	const palette = state.palette || (active ? "blue" : "default");
	const colors = {
		default: { background: "#172228", border: "#3f5660", color: "#e7f0ec" },
		blue: { background: "#145a9d", border: "#6fb9ff", color: "#ffffff" },
		green: { background: "#124332", border: "#55a986", color: "#ecfff7" },
		amber: { background: "#4a3211", border: "#d99b3d", color: "#fff2d8" },
		purple: { background: "#2a2140", border: "#69558c", color: "#f0eaff" },
		red: { background: "#3a1720", border: "#a14a5c", color: "#ffe4e8" },
		dim: { background: "#111820", border: "#314149", color: "#899aa1" },
	}[palette] || {};
	button.style.background = colors.background;
	button.style.borderColor = colors.border;
	button.style.color = colors.color;
	button.style.boxShadow = active ? "inset 0 0 0 1px rgba(255,255,255,.08)" : "none";
	button.classList.toggle("active", active);
}

function refreshToolbarState(node) {
	const linked = getInput(node, IMAGE_INPUT_NAME)?.link != null;
	if (node.__gjjWan22FileButton) {
		node.__gjjWan22FileButton.disabled = linked;
		node.__gjjWan22FileButton.style.opacity = linked ? "0.42" : "1";
	}
	if (node.__gjjWan22RunButton) {
		const running = Boolean(node.__gjjWan22RunInFlight);
		node.__gjjWan22RunButton.disabled = running;
		node.__gjjWan22RunButton.title = running ? "正在执行本节点" : "只执行当前 Wan 合成节点，并在本节点面板内显示预览";
		node.__gjjWan22RunButton.textContent = running ? "⏳" : "▶️";
		applyToolButtonState(node.__gjjWan22RunButton, { active: running, palette: running ? "amber" : "green" });
	}
	if (node.__gjjWan22SeedButton) {
		const enabled = Boolean(getWidget(node, RANDOMIZE_WIDGET)?.value);
		node.__gjjWan22SeedButton.title = enabled ? "随机种：开启。点击后换种子并切为关闭" : "随机种：关闭。点击后换种子并切为开启";
		applyToolButtonState(node.__gjjWan22SeedButton, { active: enabled, palette: enabled ? "amber" : "dim" });
	}
	if (node.__gjjWan22ModelButton) {
		const kind = modelChoiceKind(getWidget(node, CHECKPOINT_WIDGET)?.value);
		applyToolButtonState(node.__gjjWan22ModelButton, {
			active: kind !== "default",
			palette: kind === "q2" ? "red" : (kind === "gguf" ? "green" : "blue"),
		});
	}
	if (node.__gjjWan22AudioButton) {
		const enabled = Boolean(getWidget(node, AUDIO_ENABLED_WIDGET)?.value);
		applyToolButtonState(node.__gjjWan22AudioButton, { active: enabled, palette: enabled ? "purple" : "dim" });
	}
	if (node.__gjjWan22SizeButton) {
		const enabled = Boolean(getWidget(node, AUTO_SIZE_WIDGET)?.value);
		applyToolButtonState(node.__gjjWan22SizeButton, { active: enabled, palette: enabled ? "green" : "dim" });
	}
	if (node.__gjjWan22TemplateButton) {
		const active = Object.keys(templateBindings(node)).length > 0;
		applyToolButtonState(node.__gjjWan22TemplateButton, { active, palette: active ? "green" : "default" });
	}
	if (node.__gjjWan22PromptInferButton) {
		const active = Math.max(0, materialTimelineItems(node).length - 1) > 0;
		applyToolButtonState(node.__gjjWan22PromptInferButton, { active, palette: active ? "purple" : "dim" });
	}
	if (node.__gjjWan22LinkButton) {
		node.__gjjWan22LinkButton.style.display = (linked || node.properties?.[LINK_MEMORY_PROPERTY]) ? "" : "none";
	}
}

function ensureToolbarWidget(node) {
	if (node.__gjjWan22ToolbarWidget) {
		refreshToolbarState(node);
		return node.__gjjWan22ToolbarWidget;
	}

	const tools = document.createElement("div");
	tools.style.cssText = [
		"display:flex",
		"gap:0",
		"align-items:center",
		"flex-wrap:wrap",
		"width:100%",
		"padding:2px 0 4px",
		"box-sizing:border-box",
		"pointer-events:auto",
	].join(";");
	tools.addEventListener("pointerdown", (event) => event.stopPropagation());
	tools.addEventListener("mousedown", (event) => event.stopPropagation());
	tools.addEventListener("mouseup", (event) => event.stopPropagation());

	const runBtn = makeToolButton("▶️", "只执行当前 Wan 合成节点，并在本节点面板内显示预览", () => runPreviewNode(node));
	const fileBtn = makeToolButton("📂", "打开单个或多个硬盘图片", () => chooseLocalImages(node));
	const resetBtn = makeToolButton("🔄", "清空本节点缓存、内部图片、预览和运行状态", (button) => showResetConfirmPanel(node, button));
	const seedBtn = makeToolButton("🎲", "点击随机种开关", (button) => toggleRandomSeed(node, button));
	const templateBtn = makeToolButton("⚡", "绑定 GJJ_TemplateParams 参数", (button) => showTemplateBindingPanel(node, button));
	const modelBtn = makeToolButton("🧠", "模型与模型列表", (button) => showFloatingPanel(node, button, "模型", (body) => {
		body.style.gap = "8px";
		const mainSelect = bindSelect(node, CHECKPOINT_WIDGET);
		const wanClipRow = modelRow("Wan CLIP", bindSelect(node, WAN_CLIP_MODEL_WIDGET));
		const wanVaeRow = modelRow("Wan VAE", bindSelect(node, WAN_VAE_MODEL_WIDGET));
		const updateWanRows = () => {
			const value = String(getWidget(node, CHECKPOINT_WIDGET)?.value || "").replaceAll("\\", "/").toLowerCase();
			const usesExternalParts = value.startsWith("diffusion_models/") || value.endsWith(".gguf");
			wanClipRow.style.display = usesExternalParts ? "" : "none";
			wanVaeRow.style.display = usesExternalParts ? "" : "none";
		};
		mainSelect.addEventListener("change", () => {
			setTimeout(updateWanRows, 0);
		});
		body.append(
			modelRow("主模型", mainSelect),
			wanClipRow,
			wanVaeRow,
			modelRow("MMAudio", bindSelect(node, AUDIO_MMAUDIO_MODEL_WIDGET)),
			modelRow("配音VAE", bindSelect(node, AUDIO_VAE_MODEL_WIDGET)),
			modelRow("Synchformer", bindSelect(node, AUDIO_SYNCHFORMER_MODEL_WIDGET)),
			modelRow("配音CLIP", bindSelect(node, AUDIO_CLIP_MODEL_WIDGET)),
		);
		const note = document.createElement("div");
		note.textContent = `checkpoints 自带 CLIP/VAE；diffusion_models 使用 Wan CLIP/Wan VAE：${getWidget(node, CHECKPOINT_WIDGET)?.value || ""}`;
		note.style.cssText = "color:#91a8ae;white-space:nowrap;overflow:hidden;text-overflow:clip";
		body.appendChild(note);
		updateWanRows();
	}));
	const audioBtn = makeToolButton("📢", "配音设置", (button) => showFloatingPanel(node, button, "配音", (body) => {
		body.append(
			row("启用", bindCheckbox(node, AUDIO_ENABLED_WIDGET)),
			row("正向", bindInput.call(node, AUDIO_PROMPT_WIDGET, "textarea")),
			row("反向", bindInput.call(node, AUDIO_NEGATIVE_WIDGET, "textarea")),
		);
	}));
	const sizeBtn = makeToolButton("📐", "尺寸设置", (button) => showFloatingPanel(node, button, "尺寸", (body) => {
		body.append(
			row("宽度", bindSizeSlider(node, WIDTH_WIDGET)),
			row("高度", bindSizeSlider(node, HEIGHT_WIDGET)),
			row("跟随首图", bindCheckbox(node, AUTO_SIZE_WIDGET)),
			row("默认适配", bindSegmentedButtons(node, IMAGE_FIT_MODE_WIDGET, ["拉伸", "补边", "留边", "裁剪"], {
				defaultValue: "裁剪",
				titleFor: (value) => value === "裁剪" ? "短边等比缩放后按位置裁剪长边" : String(value),
			})),
			row("位置", bindSegmentedButtons(node, CROP_POSITION_WIDGET, ["上", "下", "左", "右", "中"], {
				defaultValue: "中",
				activeBackground: "#0d7189",
				activeBorder: "#63e7ff",
			})),
			row("输入打包", bindCheckbox(node, PACK_INPUT_SEQUENCE_WIDGET)),
		);
	}));
	const promptInferBtn = makeToolButton("🎬", "反推转场提示词", (button) => showPromptInferPanel(node, button));
	const linkBtn = makeToolButton("🔗", "吸收或恢复外部批量图片链接", () => detachOrRestoreImageLink(node));
	const gearBtn = makeToolButton("⚙️", "其它参数", (button) => showFloatingPanel(node, button, "参数", (body) => {
		body.append(
			row("默认每段帧数", bindDefaultSegmentFramesInput(node)),
			row("视频帧率", bindInput.call(node, FPS_WIDGET, "number")),
			row("视频格式", bindSelect(node, VIDEO_FORMAT_WIDGET)),
			row("文件前缀", bindInput.call(node, PREFIX_WIDGET)),
			row("反向提示", bindInput.call(node, NEGATIVE_WIDGET, "textarea")),
		);
	}));
	tools.append(fileBtn, resetBtn, seedBtn, templateBtn, modelBtn, audioBtn, sizeBtn, promptInferBtn, linkBtn, gearBtn, runBtn);
	node.__gjjWan22RunButton = runBtn;
	node.__gjjWan22ResetButton = resetBtn;
	node.__gjjWan22FileButton = fileBtn;
	node.__gjjWan22SeedButton = seedBtn;
	node.__gjjWan22TemplateButton = templateBtn;
	node.__gjjWan22ModelButton = modelBtn;
	node.__gjjWan22AudioButton = audioBtn;
	node.__gjjWan22SizeButton = sizeBtn;
	node.__gjjWan22PromptInferButton = promptInferBtn;
	node.__gjjWan22LinkButton = linkBtn;

	let widget = null;
	if (typeof node.addDOMWidget === "function") {
		widget = node.addDOMWidget(TOOLBAR_WIDGET_NAME, "HTML", tools, {
			getValue: () => "1",
			setValue: () => {},
			serialize: false,
			hideOnZoom: false,
			getHeight: () => TOOLBAR_HEIGHT,
		});
		if (widget) {
			widget.computeSize = (width) => [Math.max(MIN_WIDTH, width || MIN_WIDTH), TOOLBAR_HEIGHT];
		}
	}
	if (!widget && typeof node.addWidget === "function") {
		widget = node.addWidget("button", "▶️ 执行当前节点", null, () => runPreviewNode(node), { serialize: false });
		widget.options ||= {};
		widget.options.tooltip = "当前 ComfyUI 版本不支持 addDOMWidget，已退回普通按钮。";
	}

	if (widget) {
		makeTransientWidget(widget);
		widget.name = TOOLBAR_WIDGET_NAME;
		widget.label = "";
		node.__gjjWan22ToolbarWidget = widget;
	}
	refreshToolbarState(node);
	return widget;
}

async function trySyncImageSize(node, force = false) {
	if (!node || (!force && !isAutoSizeEnabled(node))) {
		return;
	}
	const sourceNode = getLinkedSourceNode(node);
	if (!sourceNode) {
		return;
	}
	const size = await loadFirstImageSizeFromSource(sourceNode);
	if (!size?.width || !size?.height) {
		return;
	}
	applyAlignedSize(node, size.width, size.height);
	refreshNode(node);
}

function ensurePanelWidget(node) {
	if (node.__gjjWan22RapidMegaStatus) {
		return node.__gjjWan22RapidMegaStatus;
	}

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"min-height:42px",
		"padding:8px 10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#121a1f",
	].join(";");

	const text = document.createElement("div");
	text.textContent = "等待执行";
	text.style.cssText = [
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.4",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");

	const progressOuter = document.createElement("div");
	progressOuter.style.cssText = [
		"height:6px",
		"border-radius:999px",
		"overflow:hidden",
		"background:#223038",
	].join(";");

	const progressInner = document.createElement("div");
	progressInner.style.cssText = [
		"height:100%",
		"width:0%",
		"background:linear-gradient(90deg,#72c1ff,#7ed6a7)",
		"transition:width 120ms ease",
	].join(";");
	progressOuter.appendChild(progressInner);

	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = [
		"display:none",
		"height:148px",
		"border:1px solid #31434d",
		"border-radius:6px",
		"overflow:hidden",
		"background:#05090c",
	].join(";");

	const video = document.createElement("video");
	video.controls = true;
	video.loop = true;
	video.muted = true;
	video.playsInline = true;
	video.style.cssText = [
		"display:block",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"background:#05090c",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		video.addEventListener(eventName, (event) => event.stopPropagation());
	}
	previewWrap.appendChild(video);
	wrap.append(text, progressOuter, previewWrap);

	const state = { widget: null, wrap, text, progressInner, previewWrap, video, hasPreview: false };
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => (state.hasPreview ? PREVIEW_PANEL_HEIGHT : PANEL_HEIGHT),
	});
	if (widget) makeTransientWidget(widget);
	state.widget = widget;
	node.__gjjWan22RapidMegaStatus = state;
	return node.__gjjWan22RapidMegaStatus;
}

function ensureStatusPanelSize(node) {
	const state = node?.__gjjWan22RapidMegaStatus;
	const panelHeight = state?.hasPreview ? PREVIEW_PANEL_HEIGHT : PANEL_HEIGHT;
	const minHeight = TOOLBAR_HEIGHT + MATERIAL_TIMELINE_HEIGHT + panelHeight + 12;
	if (!Array.isArray(node?.size) || node.size.length < 2) {
		node?.setSize?.([MIN_WIDTH, minHeight]);
		return;
	}
	if (Number(node.size[1] || 0) < minHeight || Number(node.size[0] || 0) < MIN_WIDTH) {
		node.setSize?.([
			Math.max(MIN_WIDTH, Number(node.size[0] || MIN_WIDTH)),
			Math.max(minHeight, Number(node.size[1] || 0)),
		]);
	}
}

function setStatus(node, detail = {}) {
	const state = node?.__gjjWan22RapidMegaStatus;
	if (!state) {
		return;
	}
	state.text.textContent = String(detail.text || "等待执行");
	const progress = Number.isFinite(detail.progress)
		? Math.max(0, Math.min(100, Number(detail.progress) * 100))
		: 0;
	state.progressInner.style.width = `${progress}%`;
	refreshNode(node);
}

function setVideoPreview(node, detail = {}) {
	const state = node?.__gjjWan22RapidMegaStatus;
	if (!state) {
		return;
	}
	const output = unwrapExecutedDetail(detail);
	const item = firstPreviewItem(output);
	const url = isVideoPreview(item, output) ? buildViewUrl(item, false) : "";
	state.video.pause?.();
	state.video.removeAttribute("src");
	state.video.load?.();
	if (!url) {
		state.hasPreview = false;
		state.previewWrap.style.display = "none";
		ensureStatusPanelSize(node);
		refreshNode(node);
		return;
	}
	state.hasPreview = true;
	state.previewWrap.style.display = "block";
	state.video.src = url;
	state.video.load?.();
	const playPromise = state.video.play?.();
	if (playPromise?.catch) playPromise.catch(() => {});
	ensureStatusPanelSize(node);
	refreshNode(node);
}

function patchNode(node) {
	if (!node) {
		return;
	}
	installTemplateBindingSync();
	repairMissingModelDefaults(node);
	if (node.__gjjWan22RapidMegaPatched) {
		ensureToolbarWidget(node);
		ensureMaterialTimelineWidget(node);
		ensurePanelWidget(node);
		ensureStatusPanelSize(node);
		refreshToolbarState(node);
		refreshMaterialTimeline(node);
		syncTemplateBindings(node);
		return;
	}
	node.__gjjWan22RapidMegaPatched = true;
	if (!node.__gjjWan22MaterialTimelineRefreshTimer) {
		node.__gjjWan22MaterialTimelineRefreshTimer = window.setInterval(() => {
			if (!node.graph) {
				window.clearInterval(node.__gjjWan22MaterialTimelineRefreshTimer);
				node.__gjjWan22MaterialTimelineRefreshTimer = null;
				return;
			}
			refreshMaterialTimeline(node);
		}, 1500);
	}
	for (const name of HIDDEN_WIDGETS) {
		setWidgetHidden(getWidget(node, name), true);
	}
	const imageInput = getInput(node, IMAGE_INPUT_NAME);
	if (imageInput) imageInput.type = "GJJ_BATCH_IMAGE,IMAGE";
	if (node.outputs?.[0]) node.outputs[0].type = "GJJ_BATCH_IMAGE,IMAGE";
	if (node.outputs?.[1]) node.outputs[1].type = "VIDEO";
	ensureToolbarWidget(node);
	ensureMaterialTimelineWidget(node);
	ensurePanelWidget(node);
	clearNativePreview(node);
	setStatus(node, { text: "等待执行", progress: 0 });
	syncTemplateBindings(node);
	refreshToolbarState(node);
	ensureStatusPanelSize(node);

	const originalOnConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = originalOnConnectionsChange?.apply(this, args);
		setTimeout(() => {
			refreshToolbarState(this);
			refreshMaterialTimeline(this);
			trySyncImageSize(this);
		}, 0);
		return result;
	};

	node.onExecuted = function (message) {
		this.__gjjWan22RunInFlight = false;
		const width = message?.resolved_width?.[0];
		const height = message?.resolved_height?.[0];
		if (width != null && height != null && Number(message?.source_image_count?.[0] || 0) > 0) {
			applyAlignedSize(this, width, height);
			refreshNode(this);
		}
		setVideoPreview(this, message || {});
		refreshToolbarState(this);
		refreshMaterialTimeline(this);
		return undefined;
	};

	const originalOnRemoved = node.onRemoved;
	node.onRemoved = function (...args) {
		closeFloatingPanel(this);
		if (this.__gjjWan22MaterialTimelineRefreshTimer) {
			window.clearInterval(this.__gjjWan22MaterialTimelineRefreshTimer);
			this.__gjjWan22MaterialTimelineRefreshTimer = null;
		}
		return originalOnRemoved?.apply(this, args);
	};

	setTimeout(() => {
		refreshToolbarState(node);
		refreshMaterialTimeline(node);
		trySyncImageSize(node);
	}, 0);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensurePanelWidget(targetNode);
	setStatus(targetNode, detail);
	if (detail.preview_media || detail.preview_video || detail.gifs || detail.animated || detail.preview_main_path) {
		clearNativePreview(targetNode);
		setVideoPreview(targetNode, detail);
	}
});

function resetRunningButtons() {
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) continue;
		node.__gjjWan22RunInFlight = false;
		refreshToolbarState(node);
	}
}

api.addEventListener("execution_error", resetRunningButtons);
api.addEventListener("execution_interrupted", resetRunningButtons);

app.registerExtension({
	name: "GJJ.Wan22RapidAIOMega",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			return result;
		};
	},
	setup() {
		installTemplateBindingSync();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				patchNode(node);
			}
		}
	},
});

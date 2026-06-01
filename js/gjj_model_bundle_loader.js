import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
	getModelFamilyPresets,
	matchModelFamilyPreset,
} from "./gjj_model_family_preset_table.js";

const TARGET_NODE = "GJJ_ModelBundleLoader";
const LIST_API = "/gjj/model_bundle_loader_lists";
const TEMPLATE_WIDGET = "template_id";
const UNET_WIDGET = "unet_name";
const CLIP_NAME_WIDGET = "clip_name";
const FLUX_CLIP_L_WIDGET = "flux_clip_l_name";
const CLIP_TYPE_WIDGET = "clip_type";
const CLIP_DEVICE_WIDGET = "clip_device";
const VAE_NAME_WIDGET = "vae_name";
const UNET_DTYPE_WIDGET = "unet_dtype";
const CLIP_DTYPE_WIDGET = "clip_dtype";
const VAE_DTYPE_WIDGET = "vae_dtype";
const USE_SEPARATE_VAE_WIDGET = "use_separate_vae";
const MODEL_PATCH_WIDGET = "model_patch_name";
const MODEL_PATCH_ENABLED_WIDGET = "model_patch_enabled";
const CLIP_VISION_WIDGET = "clip_vision_name";
const CONTROL_NET_WIDGET = "control_net_name";
const USE_LORA_INPUT = "use_lora";
const PRESET_LORA_1_ENABLED_WIDGET = "preset_lora_1_enabled";
const PRESET_LORA_1_NAME_WIDGET = "preset_lora_1_name";
const PRESET_LORA_1_STRENGTH_WIDGET = "preset_lora_1_strength";
const PRESET_LORA_2_ENABLED_WIDGET = "preset_lora_2_enabled";
const PRESET_LORA_2_NAME_WIDGET = "preset_lora_2_name";
const PRESET_LORA_2_STRENGTH_WIDGET = "preset_lora_2_strength";
const STEPS_WIDGET = "steps";
const CFG_WIDGET = "cfg";
const DENOISE_WIDGET = "denoise";
const PANEL_WIDGET = "gjj_model_bundle_loader_panel";
const SAVED_VALUES_PROPERTY = "gjj_model_bundle_loader_values";
const FILTER_PROPERTY = "gjj_model_bundle_loader_filters";
const SETTINGS_OPEN_PROPERTY = "gjj_model_bundle_loader_open_settings";
const PRESET_INIT_PROPERTY = "gjj_model_bundle_loader_preset_initialized";
const PRESET_UNET_PROPERTY = "gjj_model_bundle_loader_preset_unet";
const PRESET_TEMPLATE_PROPERTY = "gjj_model_bundle_loader_preset_template";
const SAMPLING_OUTPUTS_OPEN_PROPERTY = "gjj_model_bundle_loader_sampling_outputs_open";
const WIDTH_PROPERTY = "gjj_model_bundle_loader_width";
const BROADCAST_PROPERTY = "gjj_variable_broadcast_enabled";
const CHECKPOINT_COMMON_TEMPLATE_ID = "checkpoint_common";
const CONTROL_NET_NONE = "不选择";
const MAX_CONTROL_NET_SLOTS = 8;
const OUTPUT_HIT_LANE = 20;
const MIN_NODE_WIDTH = 300;
const DEFAULT_NODE_WIDTH = 470;
const CONTROL_NET_WIDGETS = Array.from({ length: MAX_CONTROL_NET_SLOTS }, (_, index) =>
	index === 0 ? CONTROL_NET_WIDGET : `control_net_${index + 1}_name`
);
const PRESET_LORA_SLOTS = [
	{ index: 1, enabled: PRESET_LORA_1_ENABLED_WIDGET, name: PRESET_LORA_1_NAME_WIDGET, strength: PRESET_LORA_1_STRENGTH_WIDGET },
	{ index: 2, enabled: PRESET_LORA_2_ENABLED_WIDGET, name: PRESET_LORA_2_NAME_WIDGET, strength: PRESET_LORA_2_STRENGTH_WIDGET },
];
const BACKEND_WIDGETS = [
	UNET_WIDGET,
	UNET_DTYPE_WIDGET,
	CLIP_NAME_WIDGET,
	CLIP_TYPE_WIDGET,
	CLIP_DTYPE_WIDGET,
	VAE_NAME_WIDGET,
	VAE_DTYPE_WIDGET,
	USE_SEPARATE_VAE_WIDGET,
	STEPS_WIDGET,
	CFG_WIDGET,
	DENOISE_WIDGET,
	TEMPLATE_WIDGET,
	MODEL_PATCH_WIDGET,
	MODEL_PATCH_ENABLED_WIDGET,
	CLIP_VISION_WIDGET,
	PRESET_LORA_1_ENABLED_WIDGET,
	PRESET_LORA_1_NAME_WIDGET,
	PRESET_LORA_1_STRENGTH_WIDGET,
	PRESET_LORA_2_ENABLED_WIDGET,
	PRESET_LORA_2_NAME_WIDGET,
	PRESET_LORA_2_STRENGTH_WIDGET,
	FLUX_CLIP_L_WIDGET,
	CLIP_DEVICE_WIDGET,
	...CONTROL_NET_WIDGETS,
];
const UNET_DTYPE_VALUES = new Set(["default", "float16", "bfloat16", "float32", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]);
const CLIP_DTYPE_VALUES = new Set(["default", "float16", "bfloat16", "float32"]);
const VAE_DTYPE_VALUES = new Set(["default", "float16", "bfloat16", "float32"]);
const CLIP_DEVICE_VALUES = new Set(["default", "cpu"]);
const CLIP_TYPE_VALUES = new Set([
	"stable_diffusion",
	"stable_cascade",
	"sd3",
	"stable_audio",
	"mochi",
	"flux",
	"ltx",
	"ltxv",
	"pixart",
	"cosmos",
	"lumina2",
	"wan",
	"hidream",
	"chroma",
	"ace",
	"omnigen2",
	"qwen_image",
	"hunyuan_image",
	"flux2",
	"ovis",
	"newbie",
	"longcat_image",
]);
const MODEL_IGNORED_TOKENS = new Set([
	"fp8", "fp16", "fp32", "bf16", "float8", "float16", "float32",
	"e4m3fn", "e5m2", "scaled", "fast", "mixed", "nvfp4", "mxfp4",
	"q2", "q3", "q4", "q5", "q6", "q8", "q8_0", "q4_0", "q4_1", "q5_0", "q5_1",
]);

const ALL_WIDGETS = [
	TEMPLATE_WIDGET,
	UNET_WIDGET,
	UNET_DTYPE_WIDGET,
	CLIP_NAME_WIDGET,
	CLIP_TYPE_WIDGET,
	CLIP_DTYPE_WIDGET,
	VAE_NAME_WIDGET,
	VAE_DTYPE_WIDGET,
	USE_SEPARATE_VAE_WIDGET,
	STEPS_WIDGET,
	CFG_WIDGET,
	DENOISE_WIDGET,
	MODEL_PATCH_WIDGET,
	MODEL_PATCH_ENABLED_WIDGET,
	CLIP_VISION_WIDGET,
	PRESET_LORA_1_ENABLED_WIDGET,
	PRESET_LORA_1_NAME_WIDGET,
	PRESET_LORA_1_STRENGTH_WIDGET,
	PRESET_LORA_2_ENABLED_WIDGET,
	PRESET_LORA_2_NAME_WIDGET,
	PRESET_LORA_2_STRENGTH_WIDGET,
	FLUX_CLIP_L_WIDGET,
	CLIP_DEVICE_WIDGET,
	...CONTROL_NET_WIDGETS,
];

const CORE_OUTPUT_META = [
	{ id: "model", kind: "model", type: "MODEL", label: "🟣 扩散模型（model）" },
	{ id: "clip", kind: "clip", type: "CLIP", label: "🟡 文本编码（clip）" },
	{ id: "vae", kind: "vae", type: "VAE", label: "🔴 图像解码（vae）" },
];

const EXTRA_OUTPUT_META = [
	{ id: "model_patch", kind: "model_patch", type: "MODEL_PATCH", label: "🟢 模型补丁（model_patch）" },
	{ id: "clip_vision", kind: "clip_vision", type: "CLIP_VISION", label: "🔵 CLIP视觉（clip_vision）" },
];

const SAMPLING_OUTPUT_META = [
	{ id: "steps", kind: "steps", type: "INT", label: "🔢 步数（steps）" },
	{ id: "cfg", kind: "cfg", type: "FLOAT", label: "🎚 CFG" },
	{ id: "denoise", kind: "denoise", type: "FLOAT", label: "🌫 降噪（denoise）" },
];

const CONTROL_OUTPUT_META = Array.from({ length: MAX_CONTROL_NET_SLOTS }, (_, index) => ({
	id: `control_net_${index + 1}`,
	kind: "control_net",
	type: "CONTROL_NET",
	label: `🟦 ControlNet ${index + 1}`,
}));

const OUTPUT_META = [...CORE_OUTPUT_META, ...CONTROL_OUTPUT_META, ...EXTRA_OUTPUT_META, ...SAMPLING_OUTPUT_META];
const OUTPUT_META_BY_ID = new Map(OUTPUT_META.map((meta) => [meta.id, meta]));
const EXTRA_CONTROL_NET_WIDGETS = CONTROL_NET_WIDGETS.slice(1);
const PRE_SEPARATE_VAE_BACKEND_WIDGETS = BACKEND_WIDGETS.filter((name) => name !== USE_SEPARATE_VAE_WIDGET);
const PRE_SEPARATE_VAE_ALL_WIDGETS = ALL_WIDGETS.filter((name) => name !== USE_SEPARATE_VAE_WIDGET);
const PRE_MULTI_CONTROL_BACKEND_WIDGETS = BACKEND_WIDGETS.filter((name) => !EXTRA_CONTROL_NET_WIDGETS.includes(name));
const PRE_MULTI_CONTROL_ALL_WIDGETS = ALL_WIDGETS.filter((name) => !EXTRA_CONTROL_NET_WIDGETS.includes(name));
const PRE_COMMON_BACKEND_WIDGETS = PRE_SEPARATE_VAE_BACKEND_WIDGETS.filter((name) => !EXTRA_CONTROL_NET_WIDGETS.includes(name));
const PRE_COMMON_ALL_WIDGETS = PRE_SEPARATE_VAE_ALL_WIDGETS.filter((name) => !EXTRA_CONTROL_NET_WIDGETS.includes(name));
const PRE_MODEL_PATCH_TOGGLE_BACKEND_WIDGETS = BACKEND_WIDGETS.filter((name) => name !== MODEL_PATCH_ENABLED_WIDGET);
const PRE_MODEL_PATCH_TOGGLE_ALL_WIDGETS = ALL_WIDGETS.filter((name) => name !== MODEL_PATCH_ENABLED_WIDGET);
const LEGACY_BACKEND_WIDGETS = PRE_MODEL_PATCH_TOGGLE_BACKEND_WIDGETS.filter((name) => !CONTROL_NET_WIDGETS.includes(name));
const LEGACY_ALL_WIDGETS = PRE_MODEL_PATCH_TOGGLE_ALL_WIDGETS.filter((name) => !CONTROL_NET_WIDGETS.includes(name));
const MIDDLE_CONTROL_BACKEND_WIDGETS = [
	...LEGACY_BACKEND_WIDGETS.slice(0, LEGACY_BACKEND_WIDGETS.indexOf(PRESET_LORA_1_ENABLED_WIDGET)),
	CONTROL_NET_WIDGET,
	...LEGACY_BACKEND_WIDGETS.slice(LEGACY_BACKEND_WIDGETS.indexOf(PRESET_LORA_1_ENABLED_WIDGET)),
];
const MIDDLE_CONTROL_ALL_WIDGETS = [
	...LEGACY_ALL_WIDGETS.slice(0, LEGACY_ALL_WIDGETS.indexOf(PRESET_LORA_1_ENABLED_WIDGET)),
	CONTROL_NET_WIDGET,
	...LEGACY_ALL_WIDGETS.slice(LEGACY_ALL_WIDGETS.indexOf(PRESET_LORA_1_ENABLED_WIDGET)),
];

function getWidget(node, name) { return node.widgets?.find((w) => w?.name === name); }
function valueOf(node, name, fallback = "") { return String(getWidget(node, name)?.value ?? fallback ?? ""); }
function boolOf(node, name, fallback = false) {
	const widget = getWidget(node, name);
	if (widget?.value === undefined || widget?.value === null || widget?.value === "") return fallback;
	if (typeof widget.value === "boolean") return widget.value;
	const text = String(widget.value).trim().toLowerCase();
	if (["1", "true", "yes", "on", "enable", "enabled", "启用", "开"].includes(text)) return true;
	if (["0", "false", "no", "off", "disable", "disabled", "关闭", "关"].includes(text)) return false;
	return fallback;
}
function numberOf(node, name, fallback = 0) {
	const parsed = Number.parseFloat(valueOf(node, name, ""));
	return Number.isFinite(parsed) ? parsed : fallback;
}
function safeAssign(obj, key, value) { try { obj[key] = value; } catch (_) {} }
function lower(value) { return String(value || "").replaceAll("\\", "/").toLowerCase(); }
function stemOf(value) {
	return lower(value).split("/").pop().replace(/\.(safetensors|ckpt|pt|pth|bin|sft|gguf)$/i, "");
}
function basename(value) { return String(value || "").replaceAll("\\", "/").split("/").pop(); }
function splitClipNames(value) { return String(value || "").split(/[\n|,]+/).map((part) => part.trim()).filter(Boolean); }
function joinClipNames(values) { return (values || []).map(String).filter(Boolean).join("|"); }
function uniqueValues(...lists) {
	const result = [];
	const seen = new Set();
	for (const list of lists) {
		for (const value of Array.isArray(list) ? list : []) {
			const text = String(value || "").trim();
			if (!text || seen.has(text)) continue;
			seen.add(text);
			result.push(text);
		}
	}
	return result;
}
function normalizeLookupText(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function presetKeywords(preset) { return [preset?.id, ...(preset?.keywords || [])].map(String).filter(Boolean); }
const TEMPLATE_CHINESE_DESCRIPTIONS = {
	checkpoint_common: "Checkpoint 通用预设",
	"FireRed-Image-Edit-1.1": "FireRed 图像编辑 1.1",
	qwen_image_edit_2511: "Qwen 图像编辑 2511",
	qwen_image_edit: "Qwen 图像编辑",
	qwen_image_2512: "Qwen 文生图 2512",
	qwen_image: "Qwen 文生图通用",
	qwen_image_layered: "Qwen 分层图像",
	lotus_depth: "Lotus 深度图",
	architecturerealmix_v11_depth: "建筑写实 SD1.5 + 深度 ControlNet",
	flux2_klein_9b: "Flux2 Klein 9B 快速",
	flux2_klein_4b: "Flux2 Klein 4B 轻量",
	flux2_dev_nvfp4: "Flux2 Dev NVFP4 量化",
	flux2_dev: "Flux2 Dev 标准",
	flux1_krea_dev: "Flux1 Krea 质感模型",
	flux1_dev_kontext: "Flux1 Kontext 图像编辑",
	flux1_fill_dev: "Flux1 Fill 局部重绘",
	flux1_canny_dev: "Flux1 Canny 边缘控制",
	flux1_dev: "Flux1 Dev 基础模型",
	flux1_schnell: "Flux1 Schnell 快速模型",
	z_image_turbo: "Z-Image Turbo 快速",
	z_image: "Z-Image 标准",
	zimage_turbo_nsfw: "Z-Image Turbo NSFW",
	zimage_nsfw: "Z-Image NSFW",
	newbie: "Newbie Image 实验模型",
	ovis: "Ovis Image 多模态",
	hidream_i1_full: "HiDream I1 Full 高质量",
	hidream_i1_dev: "HiDream I1 Dev 平衡版",
	hidream_i1_fast: "HiDream I1 Fast 快速版",
	hidream_e1: "HiDream E1 编辑模型",
	omnigen2: "OmniGen2 多图编辑",
	wan22_i2v_high_noise: "Wan2.2 图生视频高噪阶段",
	wan22_i2v_low_noise: "Wan2.2 图生视频低噪阶段",
	wan22_fun_camera: "Wan2.2 Fun Camera 相机控制",
	wan22_fun_control: "Wan2.2 Fun Control 控制视频",
	wan22_fun_inpaint: "Wan2.2 Fun Inpaint 视频补绘",
	wan22_t2v: "Wan2.2 文生视频",
	wan22_s2v: "Wan2.2 声音生视频",
	wan22_ti2v: "Wan2.2 图文生视频",
	wan22_animate: "Wan2.2 动画驱动",
	wan22_remix: "Wan2.2 Remix 重混",
	wan21_t2v: "Wan2.1 文生视频",
	wan21_i2v: "Wan2.1 图生视频",
	ltx23_dev: "LTX 2.3 Dev 视频",
	ltx23: "LTX 2.3 视频",
	"bytedance-uso": "ByteDance USO 角色/主体一致性",
};
function templateLabel(preset) {
	const id = String(preset?.id || "未命名模板");
	const desc = String(preset?.displayName || preset?.description || TEMPLATE_CHINESE_DESCRIPTIONS[id] || "").trim();
	return desc ? `${id} · ${desc}` : id;
}
function modelRelPath(folder, filename) {
	const name = String(filename || "").replaceAll("\\", "/").replace(/^\/+/, "") || basename(filename) || filename;
	const normalized = String(folder || "models").replaceAll("\\", "/");
	if (normalized === "clip_vision") return `models/clip_vision/${name} 或 models/clip_visions/${name}`;
	return `models/${normalized}/${name}`;
}
function downloadUrlForExpected(expectedName) {
	const filename = String(expectedName || "").trim();
	return filename ? `https://huggingface.co/models?search=${encodeURIComponent(filename)}` : "";
}

function currentNodeWidth(node) {
	const current = Number(node?.size?.[0] || 0);
	const saved = Number(node?.properties?.[WIDTH_PROPERTY] || 0);
	return Math.max(MIN_NODE_WIDTH, current || saved || DEFAULT_NODE_WIDTH);
}

function rememberNodeWidth(node) {
	if (!node) return MIN_NODE_WIDTH;
	node.properties = node.properties || {};
	const width = currentNodeWidth(node);
	node.properties[WIDTH_PROPERTY] = width;
	node.min_width = MIN_NODE_WIDTH;
	node.minWidth = MIN_NODE_WIDTH;
	return width;
}

function modelMatchTokens(value) {
	return stemOf(value).split(/[^a-z0-9]+/i).map((token) => token.trim().toLowerCase()).filter((token) => {
		if (!token || MODEL_IGNORED_TOKENS.has(token)) return false;
		if (/^v\d+(?:\d+|\.\d+)*$/.test(token)) return false;
		return true;
	});
}

function modelMatchKey(value) { return modelMatchTokens(value).join(""); }

function sharedPrefixLength(left, right) {
	let index = 0;
	while (index < left.length && index < right.length && left[index] === right[index]) index++;
	return index;
}

function shortMatch(query, values, fallback = "") {
	const q = stemOf(query);
	const qKey = modelMatchKey(query);
	const qTokens = modelMatchTokens(query);
	const allowFuzzy = qKey.length >= 4;
	const allowStemFuzzy = q.length >= 4;
	const list = Array.isArray(values) ? values.map(String) : [];
	if (!q) return fallback || list[0] || "";
	const queryHasSubdir = /[\\/]/.test(String(query || ""));
	const normalizedQuery = lower(query);
	const queryFilename = normalizedQuery.split("/").pop();
	const hasExactFullMatch = list.some((value) => lower(value) === normalizedQuery);
	const exactBasenameMatches = list.filter((value) => lower(value).split("/").pop() === queryFilename);
	if (exactBasenameMatches.length > 1 && (!queryHasSubdir || !hasExactFullMatch)) return fallback || String(query || "");
	const ranked = list.map((value) => {
		const text = lower(value);
		const filename = text.split("/").pop();
		const stem = stemOf(filename);
		const key = modelMatchKey(filename);
		const tokens = modelMatchTokens(filename);
		let bucket = 999;
		if (text === lower(query)) bucket = 0;
		else if (filename === lower(query).split("/").pop()) bucket = 1;
		else if (stem === q) bucket = 2;
		else if (filename.startsWith(`${q}.`)) bucket = 3;
		else if (qKey && key === qKey) bucket = 4;
		else if (allowFuzzy && key.startsWith(qKey)) bucket = 5;
		else if (allowFuzzy && key.includes(qKey)) bucket = 6;
		else if (allowFuzzy && qTokens.length && qTokens.every((token) => tokens.includes(token))) bucket = 7;
		else if (allowStemFuzzy && stem.startsWith(q)) bucket = 8;
		else if (allowStemFuzzy && stem.includes(q)) bucket = 9;
		else if (allowStemFuzzy && text.includes(q)) bucket = 10;
		return { value, bucket, prefixBonus: qKey && key ? -sharedPrefixLength(qKey, key) : 0, filenameLength: filename.length, textLength: text.length, text };
	}).filter((item) => item.bucket < 999);
	ranked.sort((a, b) =>
		a.bucket - b.bucket
		|| a.prefixBonus - b.prefixBonus
		|| a.filenameLength - b.filenameLength
		|| a.textLength - b.textLength
		|| a.text.localeCompare(b.text, "zh-Hans-CN")
	);
	return ranked[0]?.value || fallback || "";
}

function formatModelValue(value) {
	const parts = splitClipNames(value);
	if (parts.length > 1) return parts.map((part) => String(part || "").replaceAll("/", "\\")).join(" + ");
	return String(value || "").replaceAll("/", "\\") || "未选择";
}

function coerceWidgetValue(widget, value) {
	if (typeof widget?.value === "number") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	if (typeof widget?.value === "boolean") {
		return value === true || String(value).toLowerCase() === "true";
	}
	return String(value ?? "");
}

function setWidgetValue(widget, value, trigger = true) {
	if (!widget) return;
	const next = coerceWidgetValue(widget, value);
	if (widget.value === next) return;
	widget.value = next;
	if (trigger) widget.callback?.(next);
	if (typeof widget.__gjjMBSetValue === "function") widget.__gjjMBSetValue(String(next), false);
}

function setComboOptions(widget, values) {
	if (!widget) return;
	const list = Array.isArray(values) ? values.map(String) : [];
	widget.options = widget.options || {};
	widget.options.values = list;
	widget.options.values_list = list;
	widget.options.items = list;
	if (typeof widget.__gjjMBSetOptions === "function") widget.__gjjMBSetOptions(list);
}

function sanitizeChoiceValue(node, name, values, fallback) {
	const list = Array.isArray(values) ? values.map(String) : [];
	const current = valueOf(node, name);
	if (!list.length || list.includes(current)) return;
	const next = list.includes(String(fallback ?? "")) ? String(fallback) : list[0];
	setWidgetValue(getWidget(node, name), next, false);
}

function validTemplateId(node, value) {
	const id = String(value ?? "").trim();
	return id && presetById(node, id) ? id : "";
}

function inputConnected(node, name) {
	return Array.isArray(node?.inputs) && node.inputs.some((input) => input?.name === name && input.link != null);
}

function presetLoraExternallyControlled(node) {
	return inputConnected(node, USE_LORA_INPUT);
}

function setTemplateId(node, id) {
	const templateId = validTemplateId(node, id);
	if (!templateId) return "";
	node.properties = node.properties || {};
	node.properties[PRESET_TEMPLATE_PROPERTY] = templateId;
	node.properties[SAVED_VALUES_PROPERTY] = node.properties[SAVED_VALUES_PROPERTY] || {};
	node.properties[SAVED_VALUES_PROPERTY][TEMPLATE_WIDGET] = templateId;
	node.properties[`gjj_mb_value_${TEMPLATE_WIDGET}`] = templateId;
	const widget = getWidget(node, TEMPLATE_WIDGET);
	if (widget) widget.value = coerceWidgetValue(widget, templateId);
	return templateId;
}

function protect(el) {
	if (!el || el.__gjjMBProtected) return;
	el.__gjjMBProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		el.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

function collapseElement(el) {
	if (!el?.style) return;
	el.style.display = "none";
	el.style.pointerEvents = "none";
	el.style.height = "0px";
	el.style.minHeight = "0px";
	el.style.maxHeight = "0px";
	el.style.margin = "0px";
	el.style.padding = "0px";
	el.style.border = "0px";
	el.style.overflow = "hidden";
}

function hideWidget(widget) {
	if (!widget || widget.__gjjMBKeep) return;
	safeAssign(widget, "hidden", true);
	safeAssign(widget, "disabled", true);
	safeAssign(widget, "type", `converted-widget:${widget.name || "hidden"}`);
	safeAssign(widget, "label", "");
	safeAssign(widget, "computeSize", () => [0, 0]);
	safeAssign(widget, "getHeight", () => 0);
	safeAssign(widget, "draw", () => {});
	safeAssign(widget, "mouse", () => false);
	safeAssign(widget, "y", 0);
	safeAssign(widget, "last_y", 0);
	safeAssign(widget, "size", [0, 0]);
	safeAssign(widget, "height", 0);
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
	collapseElement(widget.inputEl);
	collapseElement(widget.element);
	collapseElement(widget.widget);
}

function hideNativeWidgets(node) {
	for (const name of ALL_WIDGETS) hideWidget(getWidget(node, name));
}

function ensureState(node) {
	node.__gjjMBState = node.__gjjMBState || {
		folders: null,
		unetDtypes: ["default", "float16", "bfloat16", "float32", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"],
		clipDtypes: ["default", "float16", "bfloat16", "float32"],
		clipDevices: ["default", "cpu"],
		vaeDtypes: ["default", "float16", "bfloat16", "float32"],
		clipTypes: ["stable_diffusion", "flux", "flux2", "qwen_image", "wan", "ltx", "ltxv", "hidream", "lumina2"],
		presets: [],
		loading: false,
		loadingPromise: null,
	};
	return node.__gjjMBState;
}

async function refreshBackendLists(node, rerender = true) {
	const state = ensureState(node);
	if (state.loading) return state.loadingPromise || Promise.resolve();
	state.loading = true;
	state.loadingPromise = (async () => {
		try {
			const presets = await getModelFamilyPresets();
			state.presets = Array.isArray(presets) ? presets : [];
			const response = await api.fetchApi(LIST_API);
			if (response?.ok) {
				const payload = await response.json();
				state.folders = payload?.folders || state.folders;
				state.unetDtypes = Array.isArray(payload?.unet_dtypes) ? payload.unet_dtypes.map(String) : state.unetDtypes;
				state.clipDtypes = Array.isArray(payload?.clip_dtypes) ? payload.clip_dtypes.map(String) : state.clipDtypes;
				state.clipDevices = Array.isArray(payload?.clip_devices) ? payload.clip_devices.map(String) : state.clipDevices;
				state.vaeDtypes = Array.isArray(payload?.vae_dtypes) ? payload.vae_dtypes.map(String) : state.vaeDtypes;
				state.clipTypes = Array.isArray(payload?.clip_types) ? payload.clip_types.map(String) : state.clipTypes;
			}
		} catch (error) {
			console.warn("[GJJ Model Bundle] 模型列表读取失败", error);
			state.folders = state.folders || { diffusion_models: [], checkpoints: [], clip: [], vae: [], loras: [], model_patches: [], clip_vision: [], controlnet: [] };
		} finally {
			state.loading = false;
			state.loadingPromise = null;
		}
	})();
	await state.loadingPromise;
	if (rerender) renderPanel(node);
}

function collectWidgetValues(node) {
	const values = {};
	for (const name of ALL_WIDGETS) {
		const widget = getWidget(node, name);
		if (widget) values[name] = widget.value;
	}
	sanitizeOptionalModelValues(values);
	return values;
}

function sanitizeOptionalModelValue(value) {
	const text = String(value ?? "").trim();
	if (!text) return "";
	const normalized = text.toLowerCase();
	if (["true", "false", "1", "0", "yes", "no", "on", "off", "default", "none", "null", "undefined"].includes(normalized)) return "";
	if ([CONTROL_NET_NONE, "未选择", "无", "不使用"].includes(text)) return "";
	return text;
}

function sanitizeOptionalModelValues(values) {
	if (!values || typeof values !== "object") return values;
	values[MODEL_PATCH_WIDGET] = sanitizeOptionalModelValue(values[MODEL_PATCH_WIDGET]);
	values[CLIP_VISION_WIDGET] = sanitizeOptionalModelValue(values[CLIP_VISION_WIDGET]);
	for (const name of CONTROL_NET_WIDGETS) values[name] = sanitizeOptionalModelValue(values[name]);
	return values;
}

function sanitizeControlNetValue(value) {
	return sanitizeOptionalModelValue(value);
}

function controlNetOutputCount(node, preset) {
	if (isCheckpointCommonPreset(preset)) return 0;
	return controlNetOutputNeeded(node) ? 1 : 0;
}

function clearControlNetWidgets(node) {
	for (const name of CONTROL_NET_WIDGETS) setWidgetValue(getWidget(node, name), "", false);
}

function backendWidgetValues(values) {
	return BACKEND_WIDGETS.map((name) => values[name] ?? "");
}

function writeSerializedWidgetValues(node, serializedNode, values) {
	const ordered = backendWidgetValues(values);
	if (serializedNode) serializedNode.widgets_values = ordered.slice();
	if (node) node.widgets_values = ordered.slice();
}

function scoreSerializedCandidate(values) {
	let score = 0;
	if (UNET_DTYPE_VALUES.has(String(values[UNET_DTYPE_WIDGET] ?? ""))) score += 3;
	if (CLIP_TYPE_VALUES.has(String(values[CLIP_TYPE_WIDGET] ?? ""))) score += 3;
	if (CLIP_DTYPE_VALUES.has(String(values[CLIP_DTYPE_WIDGET] ?? ""))) score += 2;
	if (VAE_DTYPE_VALUES.has(String(values[VAE_DTYPE_WIDGET] ?? ""))) score += 2;
	if (CLIP_DEVICE_VALUES.has(String(values[CLIP_DEVICE_WIDGET] ?? ""))) score += 2;
	const steps = Number(values[STEPS_WIDGET]);
	const cfg = Number(values[CFG_WIDGET]);
	const denoise = Number(values[DENOISE_WIDGET]);
	if (Number.isFinite(steps) && steps >= 1) score += 1;
	if (Number.isFinite(cfg) && cfg >= 0) score += 1;
	if (Number.isFinite(denoise) && denoise >= 0 && denoise <= 1) score += 1;
	const unet = String(values[UNET_WIDGET] ?? "").trim();
	if (unet && !UNET_DTYPE_VALUES.has(unet) && !CLIP_TYPE_VALUES.has(unet)) score += 1;
	return score;
}

function serializedValuesForOrder(rawValues, order, offset = 0) {
	if (!Array.isArray(rawValues) || rawValues.length < order.length + offset) return null;
	const values = {};
	for (let index = 0; index < order.length; index += 1) values[order[index]] = rawValues[index + offset];
	return values;
}

function valuesFromSerializedWidgets(serializedNode) {
	const rawValues = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	if (!rawValues.length) return {};
	const candidates = [];
	for (const order of [
		BACKEND_WIDGETS,
		PRE_MULTI_CONTROL_BACKEND_WIDGETS,
		PRE_SEPARATE_VAE_BACKEND_WIDGETS,
		PRE_COMMON_BACKEND_WIDGETS,
		PRE_MODEL_PATCH_TOGGLE_BACKEND_WIDGETS,
		LEGACY_BACKEND_WIDGETS,
		MIDDLE_CONTROL_BACKEND_WIDGETS,
		ALL_WIDGETS,
		PRE_MULTI_CONTROL_ALL_WIDGETS,
		PRE_SEPARATE_VAE_ALL_WIDGETS,
		PRE_COMMON_ALL_WIDGETS,
		PRE_MODEL_PATCH_TOGGLE_ALL_WIDGETS,
		LEGACY_ALL_WIDGETS,
		MIDDLE_CONTROL_ALL_WIDGETS,
	]) {
		for (const offset of [0, 1]) {
			const values = serializedValuesForOrder(rawValues, order, offset);
			if (values) candidates.push({ values, score: scoreSerializedCandidate(values) });
		}
	}
	candidates.sort((a, b) => b.score - a.score);
	return candidates[0]?.score >= 6 ? candidates[0].values : {};
}

function valuesFromProperties(props) {
	const saved = props?.[SAVED_VALUES_PROPERTY] || {};
	const values = {};
	for (const name of ALL_WIDGETS) {
		let value = saved[name];
		if (value === undefined) value = props?.[`gjj_mb_value_${name}`];
		if (value !== undefined) values[name] = value;
	}
	return sanitizeOptionalModelValues(values);
}

function rememberRestoredValues(node) {
	if (!node) return;
	node.properties = node.properties || {};
	const values = collectWidgetValues(node);
	node.properties[SAVED_VALUES_PROPERTY] = { ...values };
	for (const [key, value] of Object.entries(values)) node.properties[`gjj_mb_value_${key}`] = value;
	const templateId = String(values[TEMPLATE_WIDGET] || "").trim();
	if (templateId) node.properties[PRESET_TEMPLATE_PROPERTY] = templateId;
	writeSerializedWidgetValues(node, null, values);
}

function saveWidgetValues(node, serializedNode = null) {
	node.properties = node.properties || {};
	const values = collectWidgetValues(node);
	const templateId = currentTemplateId(node) || String(node.properties?.[PRESET_TEMPLATE_PROPERTY] || "").trim();
	if (templateId) {
		values[TEMPLATE_WIDGET] = setTemplateId(node, templateId) || templateId;
		node.properties[PRESET_TEMPLATE_PROPERTY] = values[TEMPLATE_WIDGET];
	}
	node.properties[SAVED_VALUES_PROPERTY] = { ...values };
	for (const [key, value] of Object.entries(values)) node.properties[`gjj_mb_value_${key}`] = value;
	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[SAVED_VALUES_PROPERTY] = { ...values };
		serializedNode.properties[FILTER_PROPERTY] = { ...(node.properties[FILTER_PROPERTY] || {}) };
		serializedNode.properties[SETTINGS_OPEN_PROPERTY] = { ...(node.properties[SETTINGS_OPEN_PROPERTY] || {}) };
		serializedNode.properties[PRESET_TEMPLATE_PROPERTY] = templateId || "";
		serializedNode.properties[SAMPLING_OUTPUTS_OPEN_PROPERTY] = samplingOutputsOpen(node);
		for (const [key, value] of Object.entries(values)) serializedNode.properties[`gjj_mb_value_${key}`] = value;
	}
	writeSerializedWidgetValues(node, serializedNode, values);
	return values;
}

function restoreWidgetValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node.properties || {};
	const propertyValues = valuesFromProperties(props);
	const serializedValues = valuesFromSerializedWidgets(serializedNode);
	const propertyScore = scoreSerializedCandidate(propertyValues);
	const serializedScore = scoreSerializedCandidate(serializedValues);
	const preferSerialized = serializedScore >= 6 && serializedScore > propertyScore + 3;
	for (const name of ALL_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		let value = preferSerialized ? serializedValues[name] : propertyValues[name];
		if (value === undefined) value = preferSerialized ? propertyValues[name] : serializedValues[name];
		if ([MODEL_PATCH_WIDGET, CLIP_VISION_WIDGET, ...CONTROL_NET_WIDGETS].includes(name)) value = sanitizeOptionalModelValue(value);
		if (value !== undefined && value !== null) widget.value = coerceWidgetValue(widget, value);
	}
	node.properties = node.properties || {};
	if (props?.[FILTER_PROPERTY]) node.properties[FILTER_PROPERTY] = { ...props[FILTER_PROPERTY] };
	if (props?.[SETTINGS_OPEN_PROPERTY]) node.properties[SETTINGS_OPEN_PROPERTY] = { ...props[SETTINGS_OPEN_PROPERTY] };
	if (props?.[PRESET_TEMPLATE_PROPERTY] !== undefined) node.properties[PRESET_TEMPLATE_PROPERTY] = String(props[PRESET_TEMPLATE_PROPERTY] || "");
	const templateId = validTemplateId(node, props?.[PRESET_TEMPLATE_PROPERTY])
		|| validTemplateId(node, propertyValues?.[TEMPLATE_WIDGET])
		|| validTemplateId(node, props?.[`gjj_mb_value_${TEMPLATE_WIDGET}`])
		|| validTemplateId(node, getWidget(node, TEMPLATE_WIDGET)?.value);
	if (templateId) setTemplateId(node, templateId);
	if (props?.[SAMPLING_OUTPUTS_OPEN_PROPERTY] !== undefined) node.properties[SAMPLING_OUTPUTS_OPEN_PROPERTY] = Boolean(props[SAMPLING_OUTPUTS_OPEN_PROPERTY]);
	rememberRestoredValues(node);
}

function getFilters(node) {
	node.properties = node.properties || {};
	node.properties[FILTER_PROPERTY] = node.properties[FILTER_PROPERTY] || {};
	return node.properties[FILTER_PROPERTY];
}
function getFilter(node, key) { return String(getFilters(node)?.[key] ?? ""); }
function setFilter(node, key, value) { getFilters(node)[key] = String(value || ""); }

let ACTIVE_POPUP = null;
function closePopup() {
	if (ACTIVE_POPUP?.remove) ACTIVE_POPUP.remove();
	ACTIVE_POPUP = null;
}

if (!window.__gjjModelBundlePopupCloseBound) {
	window.__gjjModelBundlePopupCloseBound = true;
	document.addEventListener("pointerdown", () => closePopup());
}

function splitWords(text) {
	return lower(text).trim().split(/[\s,，;；|]+/).filter(Boolean);
}

function createSearchableSelect(node, name, values, onChange, opts = {}) {
	const widget = getWidget(node, name);
	const list = Array.isArray(values) ? values.map(String) : [];
	setComboOptions(widget, list);

	const box = document.createElement("div");
	box.className = "gjj-mb-combo";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-mb-combo-button";
	const text = document.createElement("span");
	text.className = "gjj-mb-combo-text";
	const arrow = document.createElement("span");
	arrow.className = "gjj-mb-combo-arrow";
	arrow.textContent = "⌄";
	button.append(text, arrow);
	box.appendChild(button);

	let optionValues = list.slice();
	let searchText = getFilter(node, name);
	const currentSelectValue = () => {
		if (name === TEMPLATE_WIDGET) return currentTemplateId(node) || optionValues[0] || "";
		return String(widget?.value ?? optionValues[0] ?? "");
	};

	const setVisualValue = (value) => {
		const raw = String(value ?? "");
		const missingText = String(opts.missingText || "").trim();
		button.classList.toggle("missing", !!missingText);
		text.textContent = missingText || (opts.format ? opts.format(raw) : formatModelValue(raw));
		button.title = opts.title ? opts.title(raw) : raw || "未选择";
	};
	const optionLabel = (value) => String(opts.format ? opts.format(value) : formatModelValue(value));

	const setValue = (value, trigger = true) => {
		const next = String(value ?? "");
		if (name === TEMPLATE_WIDGET) {
			setTemplateId(node, next);
		} else if (widget) {
			widget.value = coerceWidgetValue(widget, next);
			widget.callback?.(widget.value);
		}
		setVisualValue(next);
		if (trigger) {
			saveWidgetValues(node);
			onChange?.(next);
		}
	};

	const setOptions = (nextValues) => {
		optionValues = Array.isArray(nextValues) ? nextValues.map(String) : [];
		setVisualValue(currentSelectValue());
	};

	function openPopup() {
		closePopup();
		const rect = button.getBoundingClientRect();
		const popup = document.createElement("div");
		popup.className = "gjj-mb-popup";
		popup.style.left = `${Math.round(rect.left)}px`;
		popup.style.top = `${Math.round(rect.bottom + 4)}px`;
		popup.style.width = `${Math.max(260, Math.round(rect.width))}px`;

		const input = document.createElement("input");
		input.className = "gjj-mb-popup-search";
		input.placeholder = opts.placeholder || "输入关键词实时过滤";
		input.value = searchText;
		const listWrap = document.createElement("div");
		listWrap.className = "gjj-mb-popup-list";

		const render = () => {
			searchText = input.value || "";
			setFilter(node, name, searchText);
			const words = splitWords(searchText);
			const shown = optionValues.filter((value) => {
				const hay = lower(`${value} ${optionLabel(value)}`);
				return words.every((word) => hay.includes(word));
			}).slice(0, 180);
			listWrap.replaceChildren();
			if (!shown.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-mb-popup-empty";
				empty.textContent = "没有匹配项";
				listWrap.appendChild(empty);
				return;
			}
			for (const value of shown) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-mb-popup-item";
				const active = currentSelectValue() === value;
				if (active) item.classList.add("active");
				const label = optionLabel(value);
				item.textContent = `${active ? "✓ " : ""}${label}`;
				item.title = label === value ? value : `${value}\n${label}`;
				item.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					setValue(value, true);
					closePopup();
				});
				protect(item);
				listWrap.appendChild(item);
			}
		};

		input.addEventListener("input", render);
		for (const el of [popup, input, listWrap]) protect(el);
		popup.append(input, listWrap);
		document.body.appendChild(popup);
		ACTIVE_POPUP = popup;
		render();
		setTimeout(() => input.focus(), 0);
	}

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openPopup();
	});
	protect(button);

	if (widget) {
		widget.__gjjMBSetValue = setValue;
		widget.__gjjMBSetOptions = setOptions;
	}
	setVisualValue(currentSelectValue());
	return box;
}

function openSettingsMap(node) {
	node.properties = node.properties || {};
	node.properties[SETTINGS_OPEN_PROPERTY] = node.properties[SETTINGS_OPEN_PROPERTY] || {};
	return node.properties[SETTINGS_OPEN_PROPERTY];
}
function isSettingsOpen(node, key) { return !!openSettingsMap(node)[key]; }
function toggleSettings(node, key) {
	const map = openSettingsMap(node);
	if (map[key]) delete map[key];
	else map[key] = true;
	saveWidgetValues(node);
	renderPanel(node);
}

function createGear(node, key, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `gjj-mb-gear ${isSettingsOpen(node, key) ? "on" : ""}`;
	button.textContent = "⚙️";
	button.title = title || "展开/收起参数";
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		toggleSettings(node, key);
	});
	protect(button);
	return button;
}

function createNumberSetting(node, name, labelText, step, min, max) {
	const field = document.createElement("div");
	field.className = "gjj-mb-param-field";
	const label = document.createElement("div");
	label.className = "gjj-mb-param-label";
	label.textContent = labelText;
	const input = document.createElement("input");
	input.className = "gjj-mb-param-number";
	input.type = "number";
	input.step = String(step ?? 1);
	if (min !== undefined) input.min = String(min);
	if (max !== undefined) input.max = String(max);
	input.value = valueOf(node, name);
	input.addEventListener("input", () => {
		setWidgetValue(getWidget(node, name), input.value);
		saveWidgetValues(node);
		updateSamplingSummary(node);
	});
	protect(input);
	field.append(label, input);
	return field;
}

function createSelectSetting(node, name, labelText, values) {
	const field = document.createElement("div");
	field.className = "gjj-mb-param-field";
	const label = document.createElement("div");
	label.className = "gjj-mb-param-label";
	label.textContent = labelText;
	const select = createSearchableSelect(node, name, values, () => saveWidgetValues(node), {
		format: (value) => String(value || "default"),
		placeholder: "过滤参数",
	});
	field.append(label, select);
	return field;
}

function createParamPanel(children) {
	const panel = document.createElement("div");
	panel.className = "gjj-mb-param-panel";
	for (const child of children) panel.appendChild(child);
	return panel;
}

function broadcastEnabled(node) {
	return Boolean(node?.properties?.[BROADCAST_PROPERTY]);
}

function notifyBroadcastChanged(node) {
	try { app.canvas?.setDirty?.(true, true); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try {
		window.dispatchEvent(new CustomEvent("gjj-variable-broadcast-updated", {
			detail: { nodeId: node?.id, enabled: broadcastEnabled(node) },
		}));
	} catch (_) {}
}

function updateBroadcastButton(node) {
	const button = node?.__gjjMBBroadcastButton;
	if (!button) return;
	const enabled = broadcastEnabled(node);
	button.dataset.value = enabled ? "true" : "false";
	button.classList.toggle("on", enabled);
	button.setAttribute("aria-pressed", String(enabled));
	button.title = enabled
		? "🔍 已开启：当前加载器的可见输出会广播到未连接的同名/同类型输入。"
		: "🔍 已关闭：只通过真实连线传递模型与采样参数。";
}

function setBroadcastEnabled(node, enabled) {
	node.properties = node.properties || {};
	node.properties[BROADCAST_PROPERTY] = Boolean(enabled);
	repairOutputs(node);
	updateBroadcastButton(node);
	saveWidgetValues(node);
	notifyBroadcastChanged(node);
	refreshNode(node);
}

function createBroadcastButton(node) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-mb-broadcast";
	button.textContent = "⚡";
	button.setAttribute("aria-label", "切换输出广播");
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setBroadcastEnabled(node, !broadcastEnabled(node));
	});
	protect(button);
	node.__gjjMBBroadcastButton = button;
	updateBroadcastButton(node);
	return button;
}

function allPresets(node) {
	const state = ensureState(node);
	return Array.isArray(state.presets) && state.presets.length ? state.presets : [];
}

function presetById(node, id) {
	const target = String(id || "").trim();
	return allPresets(node).find((preset) => String(preset?.id || "") === target) || null;
}

function currentTemplateId(node) {
	const props = node.properties || {};
	const saved = props?.[SAVED_VALUES_PROPERTY] || {};
	const explicit = validTemplateId(node, props[PRESET_TEMPLATE_PROPERTY])
		|| validTemplateId(node, saved[TEMPLATE_WIDGET])
		|| validTemplateId(node, props[`gjj_mb_value_${TEMPLATE_WIDGET}`])
		|| validTemplateId(node, getWidget(node, TEMPLATE_WIDGET)?.value);
	if (explicit) return explicit;
	const fromUnet = matchModelFamilyPreset(valueOf(node, UNET_WIDGET), allPresets(node));
	if (fromUnet?.id) return fromUnet.id;
	return allPresets(node)[0]?.id || "";
}

function expectedUnetName(preset) {
	return (preset?.keywords || []).find((keyword) => String(keyword || "").trim()) || preset?.id || "";
}

function expectedMainModelName(preset) {
	return String(preset?.modelName || "").trim() || expectedUnetName(preset);
}

function isFlux1Preset(preset) {
	const clipType = lower(preset?.clipType);
	const clipNames = (preset?.clipNames || []).map(lower).join("|");
	const keywords = presetKeywords(preset).map(lower).join("|");
	return clipType === "flux"
		|| (clipNames.includes("clip_l") && clipNames.includes("t5xxl"))
		|| keywords.includes("flux1")
		|| keywords.includes("uso-flux");
}

function isSplitBundlePreset(preset) {
	if (!preset) return false;
	if (lower(preset?.modelCategory) !== "checkpoints") return true;
	return false;
}

function isCheckpointPreset(preset) {
	return lower(preset?.modelCategory) === "checkpoints" && !isSplitBundlePreset(preset);
}

function isCheckpointCommonPreset(preset) {
	return String(preset?.id || "") === CHECKPOINT_COMMON_TEMPLATE_ID;
}

function activePreset(node) {
	return presetById(node, currentTemplateId(node));
}

function scoreModelForPreset(modelName, preset) {
	const normalizedModel = normalizeLookupText(modelName);
	if (!normalizedModel) return 0;
	let score = 0;
	for (const keyword of presetKeywords(preset)) {
		const normalizedKeyword = normalizeLookupText(keyword);
		if (!normalizedKeyword || normalizedKeyword.length < 3) continue;
		if (normalizedModel === normalizedKeyword) score = Math.max(score, 10000 + normalizedKeyword.length);
		else if (normalizedModel.includes(normalizedKeyword)) score = Math.max(score, 1000 + normalizedKeyword.length);
		else if (normalizedKeyword.includes(normalizedModel) && normalizedModel.length >= 6) score = Math.max(score, 100 + normalizedModel.length);
	}
	return score;
}

function matchUnetForPreset(preset, unets) {
	const list = Array.isArray(unets) ? unets.map(String) : [];
	let best = "";
	let bestScore = 0;
	for (const value of list) {
		const score = scoreModelForPreset(value, preset);
		if (score > bestScore || (score === bestScore && value.length < best.length)) {
			best = value;
			bestScore = score;
		}
	}
	return bestScore > 0 ? best : "";
}

function missingModel(expectedName, values) {
	const expected = String(expectedName || "").trim();
	if (!expected) return "";
	const found = shortMatch(expected, values, "");
	return found ? "" : expected;
}

function isT5ClipName(value) {
	return lower(value).includes("t5xxl");
}

function fluxFixedClipName(clips, preset = null) {
	const recommended = (preset?.clipNames || []).find((name) => lower(name).includes("clip_l")) || "clip_l.safetensors";
	return shortMatch(recommended, clips, recommended);
}

function fluxT5ExpectedName(preset = null) {
	return (preset?.clipNames || []).find(isT5ClipName) || "t5xxl_fp16.safetensors";
}

function fluxT5ClipNameFromValue(value) {
	const parts = splitClipNames(value);
	return parts.find(isT5ClipName) || (isT5ClipName(value) ? String(value || "") : "");
}

function fluxT5Candidates(clips, expectedName) {
	const preferred = [
		expectedName,
		"t5xxl_fp16.safetensors",
		"t5xxl_fp8_e4m3fn_scaled.safetensors",
		"t5xxl_fp8_e4m3fn.safetensors",
	];
	const matchedPreferred = preferred.map((name) => shortMatch(name, clips, "")).filter(Boolean);
	const availableT5 = (clips || []).filter(isT5ClipName);
	return uniqueValues(matchedPreferred, availableT5, [expectedName].filter(Boolean));
}

function defaultVaeValue(vaes) {
	const list = Array.isArray(vaes) ? vaes.map(String).filter(Boolean) : [];
	return list.find((name) => lower(name).includes("vae-ft-mse")) || list[0] || "";
}

function fluxClipWidgetValue(fixedClip, t5Clip) {
	return joinClipNames([fixedClip || "clip_l.safetensors", t5Clip || "t5xxl_fp16.safetensors"]);
}

function formatFluxClipValue(value, fixedClip, fallbackT5) {
	const t5 = fluxT5ClipNameFromValue(value) || fallbackT5 || value;
	return String(t5 || "").replaceAll("/", "\\") || "选择 T5";
}

function presetLoraDefaults(preset, slot, loras = []) {
	const rawName = String(slot.index === 1 ? preset?.lora1 || "" : preset?.lora2 || "");
	const rawStrength = Number(slot.index === 1 ? preset?.lora1Strength ?? 1 : preset?.lora2Strength ?? 1);
	const autoEnabled = slot.index === 1 ? preset?.lora1AutoEnabled !== false : true;
	const strength = Number.isFinite(rawStrength) ? rawStrength : 1;
	const name = rawName ? shortMatch(rawName, loras, rawName) : "";
	return {
		name,
		strength,
		enabled: autoEnabled && Boolean(name) && Math.abs(strength) > 1e-5,
		autoEnabled,
	};
}

function sameModelBasename(left, right) {
	return Boolean(left && right) && basename(left).toLowerCase() === basename(right).toLowerCase();
}

function hasModelSubdir(value) {
	return /[\\/]/.test(String(value || ""));
}

function preferCanonicalModelPath(current, canonical) {
	const value = String(current || "").trim();
	const preferred = String(canonical || "").trim();
	if (!value) return preferred;
	if (preferred && sameModelBasename(value, preferred) && !hasModelSubdir(value) && hasModelSubdir(preferred)) return preferred;
	return value;
}

function setPresetLoraWidgets(node, preset, loras = []) {
	for (const slot of PRESET_LORA_SLOTS) {
		const defaults = presetLoraDefaults(preset, slot, loras);
		setWidgetValue(getWidget(node, slot.enabled), defaults.enabled, false);
		setWidgetValue(getWidget(node, slot.name), defaults.name, false);
		setWidgetValue(getWidget(node, slot.strength), defaults.name ? String(defaults.strength) : "", false);
	}
}

function modelPatchDefaultEnabled(preset) {
	return Boolean(String(preset?.modelPatchName || "").trim());
}

function modelPatchEnabled(node, preset) {
	return boolOf(node, MODEL_PATCH_ENABLED_WIDGET, modelPatchDefaultEnabled(preset));
}

function ensureModelPatchWidgetDefault(node, preset, modelPatches = []) {
	const expected = String(preset?.modelPatchName || "").trim();
	if (!expected) return;
	const current = valueOf(node, MODEL_PATCH_WIDGET).trim();
	if (!current) {
		setWidgetValue(getWidget(node, MODEL_PATCH_WIDGET), shortMatch(expected, modelPatches, expected), false);
	}
}

function ensurePresetLoraWidgetDefaults(node, preset, loras = []) {
	for (const slot of PRESET_LORA_SLOTS) {
		const defaults = presetLoraDefaults(preset, slot, loras);
		if (!defaults.name) continue;
		const currentName = valueOf(node, slot.name).trim();
		const nextName = preferCanonicalModelPath(currentName, defaults.name);
		if (nextName !== currentName) setWidgetValue(getWidget(node, slot.name), nextName, false);
		if (!valueOf(node, slot.strength).trim()) setWidgetValue(getWidget(node, slot.strength), String(defaults.strength), false);
	}
}

function readPresetLoraSlots(node, preset, loras = []) {
	const externalControlled = presetLoraExternallyControlled(node);
	return PRESET_LORA_SLOTS.map((slot) => {
		const defaults = presetLoraDefaults(preset, slot, loras);
		const name = preferCanonicalModelPath(valueOf(node, slot.name, defaults.name).trim(), defaults.name);
		const strength = numberOf(node, slot.strength, defaults.strength);
		const enabled = boolOf(node, slot.enabled, defaults.enabled);
		const missing = enabled && name ? missingModel(name, loras) : "";
		return {
			index: slot.index,
			enabledWidget: slot.enabled,
			nameWidget: slot.name,
			strengthWidget: slot.strength,
			name,
			strength,
			enabled,
			autoEnabled: defaults.autoEnabled,
			missing,
			hasDefault: Boolean(defaults.name),
			externalControlled,
		};
	}).filter((item) => item.hasDefault);
}

function addHelpModelEntry(entries, label, folder, kind, value, icon = "") {
	const text = String(value || "").trim();
	if (!text) return;
	entries.push({ label, folder, kind, value: text, icon });
}

function modelBundleHelpEntries(node) {
	const state = ensureState(node);
	const preset = activePreset(node) || {};
	const entries = [];
	const checkpointPreset = isCheckpointPreset(preset);
	const checkpointCommon = isCheckpointCommonPreset(preset);
	const fluxPreset = !checkpointPreset && isFlux1Preset(preset);
	const mainFolder = lower(preset?.modelCategory) === "checkpoints" ? "checkpoints" : "diffusion_models";
	addHelpModelEntry(
		entries,
		checkpointPreset ? "Checkpoint" : "扩散模型",
		mainFolder,
		checkpointPreset ? "checkpoint_model" : "diffusion",
		valueOf(node, UNET_WIDGET) || expectedMainModelName(preset)
	);
	if (!checkpointPreset) {
		const clips = state.folders?.clip || [];
		const clipNames = fluxPreset
			? [
				valueOf(node, FLUX_CLIP_L_WIDGET) || fluxFixedClipName(clips, preset),
				fluxT5ClipNameFromValue(valueOf(node, CLIP_NAME_WIDGET)) || valueOf(node, CLIP_NAME_WIDGET) || fluxT5ExpectedName(preset),
			]
			: (splitClipNames(valueOf(node, CLIP_NAME_WIDGET)).length ? splitClipNames(valueOf(node, CLIP_NAME_WIDGET)) : (preset?.clipNames || []));
		clipNames.filter(Boolean).forEach((name, index) => {
			addHelpModelEntry(entries, index ? `CLIP ${index + 1}` : "CLIP", "text_encoders", "clip", name);
		});
		addHelpModelEntry(entries, "VAE", "vae", "vae", valueOf(node, VAE_NAME_WIDGET) || preset?.vaeName || "");
	}
	if (checkpointCommon && boolOf(node, USE_SEPARATE_VAE_WIDGET, false)) {
		addHelpModelEntry(entries, "独立VAE", "vae", "vae", valueOf(node, VAE_NAME_WIDGET), "🔴");
	}
	const loras = state.folders?.loras || [];
	for (const item of readPresetLoraSlots(node, preset, loras)) {
		if (!item.enabled) continue;
		addHelpModelEntry(entries, `LoRA ${item.index}`, "loras", "loras", item.name);
	}
	if (modelPatchEnabled(node, preset)) {
		addHelpModelEntry(entries, "模型补丁", "model_patches", "model_patch", valueOf(node, MODEL_PATCH_WIDGET) || preset?.modelPatchName || "", "🟢");
	}
	addHelpModelEntry(entries, "CLIP视觉", "clip_vision", "clip_vision", valueOf(node, CLIP_VISION_WIDGET) || preset?.clipVisionName || "");
	if (!checkpointCommon) {
		addHelpModelEntry(entries, "ControlNet", "controlnet", "controlnet", sanitizeControlNetValue(valueOf(node, CONTROL_NET_WIDGET) || preset?.controlNetName || ""), "🟦");
	}
	return entries;
}

function attachHelpModelProvider(node) {
	node.__gjjHelpModelEntries = () => modelBundleHelpEntries(node);
	node.__gjjHelpModelTreeEntries = node.__gjjHelpModelEntries;
}

function formatLoraStrength(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number.toFixed(2) : "1.00";
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(String(text || ""));
		return true;
	} catch (_) {
		return false;
	}
}

async function copyAndFlash(button, text, restoreLabel) {
	const oldText = button.textContent;
	const ok = await copyText(text);
	button.textContent = ok ? "✅ 已复制" : "复制失败";
	button.classList.toggle("copied", ok);
	clearTimeout(button.__gjjMBMissingTimer);
	button.__gjjMBMissingTimer = setTimeout(() => {
		button.textContent = restoreLabel || oldText;
		button.classList.remove("copied");
	}, 1100);
}

function createMissingModelHint(folder, expectedName) {
	const expected = String(expectedName || "").trim();
	const url = downloadUrlForExpected(expected);
	const row = document.createElement("div");
	row.className = "gjj-mb-missing-row";
	const message = document.createElement("div");
	message.className = "gjj-mb-missing-text";
	message.textContent = `缺失：${expected}`;
	message.title = `请放到 ${modelRelPath(folder, expected)}`;

	const copyName = document.createElement("button");
	copyName.type = "button";
	copyName.className = "gjj-mb-missing-btn";
	copyName.textContent = "📋 名称";
	copyName.title = `复制模型文件名\n${expected}`;
	copyName.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		copyAndFlash(copyName, expected, "📋 名称");
	});
	protect(copyName);

	const download = document.createElement("button");
	download.type = "button";
	download.className = "gjj-mb-missing-btn";
	download.textContent = "🌏 地址";
	download.title = url ? `打开模型下载/搜索地址\n${url}` : "当前模板没有可用搜索词";
	download.disabled = !url;
	download.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (url) window.open(url, "_blank", "noopener,noreferrer");
	});
	protect(download);

	row.append(message, copyName, download);
	return row;
}

function applyPreset(node, force = false) {
	const templateId = currentTemplateId(node);
	const preset = presetById(node, templateId) || matchModelFamilyPreset(valueOf(node, UNET_WIDGET), allPresets(node));
	if (!preset) return;
	node.properties = node.properties || {};
	const alreadyInitialized = Boolean(node.properties[PRESET_INIT_PROPERTY]);
	const lastTemplate = String(node.properties[PRESET_TEMPLATE_PROPERTY] || "");
	if (!force && alreadyInitialized && lastTemplate === preset.id) return;

	const state = ensureState(node);
	const checkpointList = state.folders?.checkpoints || [];
	const unetList = uniqueValues(state.folders?.diffusion_models || [], checkpointList);
	const clipList = state.folders?.clip || [];
	const vaeList = state.folders?.vae || [];
	const loraList = state.folders?.loras || [];
	const modelPatchList = state.folders?.model_patches || [];
	const clipVisionList = uniqueValues(state.folders?.clip_vision || [], state.folders?.clip_visions || []);
	const controlNetList = state.folders?.controlnet || [];
	const mainExpected = expectedMainModelName(preset);
	const preferredMainList = lower(preset?.modelCategory) === "checkpoints" ? checkpointList : unetList;
	const checkpointCommon = isCheckpointCommonPreset(preset);
	const unetName = checkpointCommon
		? (checkpointList[0] || "")
		: isCheckpointPreset(preset)
		? shortMatch(mainExpected, checkpointList, mainExpected)
		: (shortMatch(preset.modelName || mainExpected, preferredMainList, "") || matchUnetForPreset(preset, preferredMainList) || mainExpected);
	if (unetName) setWidgetValue(getWidget(node, UNET_WIDGET), unetName);
	if (isCheckpointPreset(preset)) {
		setWidgetValue(getWidget(node, CLIP_NAME_WIDGET), "");
		setWidgetValue(getWidget(node, FLUX_CLIP_L_WIDGET), "");
		setWidgetValue(getWidget(node, VAE_NAME_WIDGET), checkpointCommon ? defaultVaeValue(vaeList) : "");
		setWidgetValue(getWidget(node, USE_SEPARATE_VAE_WIDGET), false, false);
		setWidgetValue(getWidget(node, UNET_DTYPE_WIDGET), "default", false);
		setWidgetValue(getWidget(node, CLIP_DTYPE_WIDGET), "default", false);
		setWidgetValue(getWidget(node, CLIP_DEVICE_WIDGET), "default", false);
		setWidgetValue(getWidget(node, VAE_DTYPE_WIDGET), "default", false);
	} else {
		if (isFlux1Preset(preset)) {
			const fixedClip = fluxFixedClipName(clipList, preset);
			const t5Clip = shortMatch(fluxT5ExpectedName(preset), fluxT5Candidates(clipList, fluxT5ExpectedName(preset)), fluxT5ExpectedName(preset));
			setWidgetValue(getWidget(node, FLUX_CLIP_L_WIDGET), fixedClip);
			setWidgetValue(getWidget(node, CLIP_NAME_WIDGET), t5Clip);
		} else {
			const clipNames = (preset.clipNames || []).map((name) => shortMatch(name, clipList, name)).filter(Boolean);
			if (clipNames.length) setWidgetValue(getWidget(node, CLIP_NAME_WIDGET), joinClipNames(clipNames));
			setWidgetValue(getWidget(node, FLUX_CLIP_L_WIDGET), "");
		}
		if (preset.vaeName) setWidgetValue(getWidget(node, VAE_NAME_WIDGET), shortMatch(preset.vaeName, vaeList, preset.vaeName));
	}
	if (preset.clipType) setWidgetValue(getWidget(node, CLIP_TYPE_WIDGET), preset.clipType);
	if (preset.modelPatchName) setWidgetValue(getWidget(node, MODEL_PATCH_WIDGET), shortMatch(preset.modelPatchName, modelPatchList, preset.modelPatchName));
	else setWidgetValue(getWidget(node, MODEL_PATCH_WIDGET), "");
	setWidgetValue(getWidget(node, MODEL_PATCH_ENABLED_WIDGET), modelPatchDefaultEnabled(preset), false);
	if (preset.clipVisionName) setWidgetValue(getWidget(node, CLIP_VISION_WIDGET), shortMatch(preset.clipVisionName, clipVisionList, preset.clipVisionName));
	else setWidgetValue(getWidget(node, CLIP_VISION_WIDGET), "");
	if (checkpointCommon) {
		for (const name of CONTROL_NET_WIDGETS) setWidgetValue(getWidget(node, name), "", false);
	} else if (preset.controlNetName) {
		setWidgetValue(getWidget(node, CONTROL_NET_WIDGET), shortMatch(preset.controlNetName, controlNetList, preset.controlNetName));
		for (const name of EXTRA_CONTROL_NET_WIDGETS) setWidgetValue(getWidget(node, name), "", false);
	} else {
		for (const name of CONTROL_NET_WIDGETS) setWidgetValue(getWidget(node, name), "", false);
	}
	if (preset.steps != null) setWidgetValue(getWidget(node, STEPS_WIDGET), preset.steps);
	if (preset.cfg != null) setWidgetValue(getWidget(node, CFG_WIDGET), preset.cfg);
	if (preset.denoise != null) setWidgetValue(getWidget(node, DENOISE_WIDGET), preset.denoise);
	setPresetLoraWidgets(node, preset, loraList);
	setTemplateId(node, preset.id);
	node.properties[PRESET_INIT_PROPERTY] = true;
	node.properties[PRESET_UNET_PROPERTY] = unetName;
	node.properties[PRESET_TEMPLATE_PROPERTY] = preset.id;
	saveWidgetValues(node);
	repairOutputs(node);
}

function updateSamplingSummary(node) {
	const summary = node?.__gjjMBSamplingSummary;
	if (!summary) return;
	summary.textContent = `${valueOf(node, STEPS_WIDGET, "20")} 步 · CFG ${valueOf(node, CFG_WIDGET, "1.0")} · 降噪 ${valueOf(node, DENOISE_WIDGET, "1.0")}`;
}

function samplingOutputsOpen(node) {
	return Boolean(node?.properties?.[SAMPLING_OUTPUTS_OPEN_PROPERTY]);
}

function outputHasLinks(output) {
	return Array.isArray(output?.links) && output.links.length > 0;
}

function extraOutputsNeeded(node) {
	const preset = activePreset(node);
	const checkpointPreset = isCheckpointPreset(preset);
	const manualExtraAllowed = !checkpointPreset;
	const modelPatchValue = sanitizeOptionalModelValue(valueOf(node, MODEL_PATCH_WIDGET));
	const clipVisionValue = sanitizeOptionalModelValue(valueOf(node, CLIP_VISION_WIDGET));
	const needsModelPatch = modelPatchEnabled(node, preset)
		&& Boolean(preset?.modelPatchName || (manualExtraAllowed && modelPatchValue));
	const needsClipVision = Boolean(preset?.clipVisionName || (manualExtraAllowed && clipVisionValue));
	return needsModelPatch || needsClipVision;
}

function pruneInactiveOptionalOutputs(node, preset) {
	if (!node || !preset) return;
	const checkpointPreset = isCheckpointPreset(preset);
	if (checkpointPreset && !preset?.modelPatchName) {
		setWidgetValue(getWidget(node, MODEL_PATCH_WIDGET), "", false);
		setWidgetValue(getWidget(node, MODEL_PATCH_ENABLED_WIDGET), false, false);
	}
	if (checkpointPreset && !preset?.clipVisionName) {
		setWidgetValue(getWidget(node, CLIP_VISION_WIDGET), "", false);
	}
	if (isCheckpointCommonPreset(preset)) {
		clearControlNetWidgets(node);
		return;
	}
	if (!isCheckpointCommonPreset(preset)) {
		if (!preset?.controlNetName) setWidgetValue(getWidget(node, CONTROL_NET_WIDGET), "", false);
		for (const name of EXTRA_CONTROL_NET_WIDGETS) setWidgetValue(getWidget(node, name), "", false);
	}
}

function controlNetOutputNeeded(node) {
	const preset = activePreset(node);
	if (isCheckpointCommonPreset(preset)) return false;
	return Boolean(preset?.controlNetName || sanitizeControlNetValue(valueOf(node, CONTROL_NET_WIDGET)).trim());
}

function activeOutputMeta(node) {
	const meta = [...CORE_OUTPUT_META];
	const preset = activePreset(node);
	const controlCount = controlNetOutputCount(node, preset);
	const checkpointPreset = isCheckpointPreset(preset);
	const modelPatchVisible = extraOutputsNeeded(node)
		&& modelPatchEnabled(node, preset)
		&& Boolean(preset?.modelPatchName || (!checkpointPreset && sanitizeOptionalModelValue(valueOf(node, MODEL_PATCH_WIDGET))));
	const clipVisionVisible = extraOutputsNeeded(node)
		&& Boolean(preset?.clipVisionName || (!checkpointPreset && sanitizeOptionalModelValue(valueOf(node, CLIP_VISION_WIDGET))));
	if (controlCount > 0) meta.push(...CONTROL_OUTPUT_META.slice(0, controlCount));
	if (modelPatchVisible) meta.push(EXTRA_OUTPUT_META[0]);
	if (clipVisionVisible) meta.push(EXTRA_OUTPUT_META[1]);
	if (samplingOutputsOpen(node)) meta.push(...SAMPLING_OUTPUT_META);
	return meta;
}

function samplingOutputsHaveLinks(node) {
	const samplingIds = new Set(SAMPLING_OUTPUT_META.map((meta) => meta.id));
	return (node?.outputs || []).some((output, index) => samplingIds.has(inferOutputSlotId(node, output, index)) && outputHasLinks(output));
}

function removeGraphLink(linkId) {
	const link = app.graph?.links?.[linkId];
	const targetId = graphLinkTargetId(link);
	const targetSlot = graphLinkTargetSlot(link);
	const targetNode = link && (app.graph?.getNodeById?.(targetId) || app.graph?._nodes_by_id?.[targetId]);
	const targetInput = targetNode?.inputs?.[targetSlot];
	if (targetInput?.link === linkId) targetInput.link = null;
	if (targetInput && String(targetInput.link) === String(linkId)) targetInput.link = null;
	try { app.graph?.removeLink?.(linkId); } catch (_) {}
	try { if (app.graph?.links?.[linkId]) delete app.graph.links[linkId]; } catch (_) {}
}

function disconnectOutputLinks(node, index) {
	const output = node?.outputs?.[index];
	const links = Array.isArray(output?.links) ? [...output.links] : [];
	for (const linkId of links) {
		removeGraphLink(linkId);
	}
	if (output) output.links = null;
}

function outputSlotId(output) {
	return String(output?.gjj_slot_id || output?.gjj_slot_class || "");
}

function inferOutputSlotId(node, output, index, metaList = null) {
	const existing = outputSlotId(output);
	if (existing) return existing;
	const type = String(output?.type || "").toUpperCase();
	const text = [
		output?.name,
		output?.label,
		output?.localized_name,
		output?.display_name,
	].map((item) => String(item || "")).join(" ").toLowerCase();
	const sameIndexMeta = Array.isArray(metaList) ? metaList[index] : null;
	if (sameIndexMeta && String(sameIndexMeta.type || "").toUpperCase() === type) return sameIndexMeta.id;
	if (index === 0 && type === "MODEL") return "model";
	if (index === 1 && type === "CLIP") return "clip";
	if (index === 2 && type === "VAE") return "vae";
	if (type === "MODEL_PATCH" || text.includes("model_patch") || text.includes("模型补丁")) return "model_patch";
	if (type === "CLIP_VISION" || text.includes("clip视觉") || text.includes("clip_vision")) return "clip_vision";
	if (type === "INT" || text.includes("steps") || text.includes("步数")) return "steps";
	if (type === "FLOAT" && (text.includes("cfg") || text.includes("引导"))) return "cfg";
	if (type === "FLOAT" && (text.includes("denoise") || text.includes("降噪"))) return "denoise";
	if (type === "CONTROL_NET" || text.includes("controlnet") || text.includes("control_net")) {
		const match = text.match(/(?:controlnet|control_net)\s*(\d+)/i);
		const number = match ? Number(match[1]) : Math.max(1, index - CORE_OUTPUT_META.length + 1);
		return `control_net_${Math.max(1, Math.min(MAX_CONTROL_NET_SLOTS, number))}`;
	}
	const sameTypeMeta = Array.isArray(metaList)
		? metaList.find((meta) => String(meta?.type || "").toUpperCase() === type)
		: null;
	return sameTypeMeta?.id || "";
}

function linkedOutputIds(node, metaList = null) {
	const ids = new Set();
	for (let index = 0; index < (node?.outputs?.length || 0); index += 1) {
		const output = node.outputs[index];
		if (!outputHasLinks(output)) continue;
		const slotId = inferOutputSlotId(node, output, index, metaList);
		if (slotId) ids.add(slotId);
	}
	return ids;
}

function expandOutputMetaForLinks(node, metaList) {
	const linkedIds = linkedOutputIds(node, metaList);
	if (!linkedIds.size) return metaList;
	const wanted = new Set((metaList || []).map((meta) => meta.id));
	for (const id of linkedIds) {
		if (OUTPUT_META_BY_ID.has(id)) wanted.add(id);
	}
	const hasLinkedSampling = SAMPLING_OUTPUT_META.some((meta) => linkedIds.has(meta.id));
	if (hasLinkedSampling) {
		for (const meta of SAMPLING_OUTPUT_META) wanted.add(meta.id);
	}
	const result = [...CORE_OUTPUT_META];
	for (const meta of CONTROL_OUTPUT_META) if (wanted.has(meta.id)) result.push(meta);
	for (const meta of EXTRA_OUTPUT_META) if (wanted.has(meta.id)) result.push(meta);
	for (const meta of SAMPLING_OUTPUT_META) if (wanted.has(meta.id)) result.push(meta);
	return result;
}

function graphLinkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function graphLinkOriginSlot(link) {
	return Number(Array.isArray(link) ? link[2] : link?.origin_slot);
}

function graphLinkTargetId(link) {
	return Array.isArray(link) ? link[3] : link?.target_id;
}

function graphLinkTargetSlot(link) {
	return Number(Array.isArray(link) ? link[4] : link?.target_slot);
}

function setGraphLinkOrigin(link, nodeId, slotIndex, type) {
	if (!link) return;
	if (Array.isArray(link)) {
		link[1] = nodeId;
		link[2] = slotIndex;
		link[5] = type;
		return;
	}
	link.origin_id = nodeId;
	link.origin_slot = slotIndex;
	link.type = type;
}

function cleanupDanglingOutputLinks(node) {
	if (!node || !app.graph?.links) return;
	for (const output of node.outputs || []) {
		if (!Array.isArray(output.links)) output.links = [];
		output.links = output.links.filter((linkId) => {
			const link = app.graph?.links?.[linkId];
			if (!link || Number(graphLinkOriginId(link)) !== Number(node.id)) return false;
			const slot = graphLinkOriginSlot(link);
			return Number.isInteger(slot) && node.outputs?.[slot] === output;
		});
	}
	for (const [key, link] of Object.entries(app.graph.links || {})) {
		if (!link || Number(graphLinkOriginId(link)) !== Number(node.id)) continue;
		const linkId = link.id ?? key;
		const slot = graphLinkOriginSlot(link);
		const output = Number.isInteger(slot) ? node.outputs?.[slot] : null;
		if (!output) {
			removeGraphLink(linkId);
			continue;
		}
		if (!Array.isArray(output.links)) output.links = [];
		if (!output.links.some((id) => String(id) === String(linkId))) output.links.push(linkId);
	}
}

function sameOutputShape(node, metaList) {
	if (!Array.isArray(node?.outputs) || node.outputs.length !== metaList.length) return false;
	for (let index = 0; index < metaList.length; index += 1) {
		const output = node.outputs[index];
		const meta = metaList[index];
		if (String(output?.type || "") !== String(meta.type || "")) return false;
		const slotId = outputSlotId(output);
		if (slotId && slotId !== meta.id) return false;
	}
	return true;
}

function collectSemanticOutputLinks(node, metaList = null) {
	const saved = [];
	for (let index = 0; index < (node?.outputs?.length || 0); index += 1) {
		const output = node.outputs[index];
		const slotId = inferOutputSlotId(node, output, index, metaList);
		for (const linkId of output?.links || []) {
			const link = app.graph?.links?.[linkId];
			if (!link) {
				saved.push({ linkId, link: null, slotId, sourceIndex: index, sourceType: output?.type || "", targetId: null, targetSlot: null });
				continue;
			}
			saved.push({
				linkId,
				link,
				slotId,
				sourceIndex: index,
				sourceType: output?.type || link?.type || "",
				targetId: graphLinkTargetId(link),
				targetSlot: graphLinkTargetSlot(link),
			});
		}
	}
	return saved;
}

function detachSemanticOutputLinks(node, savedLinks) {
	const ids = new Set((savedLinks || []).map((item) => item.linkId));
	for (const output of node?.outputs || []) {
		if (Array.isArray(output?.links)) output.links = output.links.filter((linkId) => !ids.has(linkId));
	}
	for (const item of savedLinks || []) {
		const targetNode = app.graph?.getNodeById?.(item.targetId) || app.graph?._nodes_by_id?.[item.targetId];
		const targetInput = targetNode?.inputs?.[item.targetSlot];
		if (targetInput?.link === item.linkId) targetInput.link = null;
	}
}

function restoreSemanticOutputLinks(node, savedLinks) {
	const bySlotId = new Map();
	for (let index = 0; index < (node?.outputs?.length || 0); index += 1) {
		const slotId = inferOutputSlotId(node, node.outputs[index], index);
		if (slotId) bySlotId.set(slotId, index);
	}
	for (const item of savedLinks || []) {
		let index = bySlotId.get(item.slotId);
		if (!Number.isInteger(index) && Number.isInteger(item.sourceIndex)) {
			const fallback = node.outputs?.[item.sourceIndex];
			if (fallback && String(fallback.type || "").toUpperCase() === String(item.sourceType || "").toUpperCase()) {
				index = item.sourceIndex;
			}
		}
		const output = Number.isInteger(index) ? node.outputs[index] : null;
		if (!output || !item.link) {
			removeGraphLink(item.linkId);
			continue;
		}
		const type = String(output.type || item.link.type || "*");
		setGraphLinkOrigin(item.link, node.id, index, type);
		app.graph.links = app.graph.links || {};
		app.graph.links[item.linkId] = item.link;
		if (!Array.isArray(output.links)) output.links = [];
		if (!output.links.includes(item.linkId)) output.links.push(item.linkId);
		const targetNode = app.graph?.getNodeById?.(item.targetId) || app.graph?._nodes_by_id?.[item.targetId];
		const targetInput = targetNode?.inputs?.[item.targetSlot];
		if (targetInput) targetInput.link = item.linkId;
	}
}

function outputFromMeta(meta) {
	const visible = meta.visible !== false;
	const label = visible ? meta.label : "";
	return {
		name: label,
		type: meta.type,
		links: null,
		localized_name: label,
		label,
		gjj_slot_id: meta.id,
		gjj_slot_class: meta.id,
		gjj_output_kind: meta.kind,
		gjj_output_type: meta.type,
	};
}

function setGraphLinkOriginSlot(linkId, slotIndex) {
	const link = app.graph?.links?.[linkId];
	if (!link) return;
	if (Array.isArray(link)) link[2] = slotIndex;
	else link.origin_slot = slotIndex;
}

function migrateLegacySamplingOutputs(node) {
	if (!Array.isArray(node?.outputs) || node.__gjjMBExtraOutputMigrationDone) return;
	const outputs = node.outputs;
	const looksLegacy = outputs.length >= 6
		&& String(outputs[3]?.type || "").toUpperCase() === "INT"
		&& String(outputs[4]?.type || "").toUpperCase() === "FLOAT"
		&& String(outputs[5]?.type || "").toUpperCase() === "FLOAT"
		&& outputs[3]?.gjj_slot_id !== "model_patch";
	if (!looksLegacy) {
		node.__gjjMBExtraOutputMigrationDone = true;
		return;
	}
	outputs.splice(CORE_OUTPUT_META.length, 0, outputFromMeta(EXTRA_OUTPUT_META[0]), outputFromMeta(EXTRA_OUTPUT_META[1]));
	for (let index = CORE_OUTPUT_META.length + EXTRA_OUTPUT_META.length; index < outputs.length; index += 1) {
		for (const linkId of outputs[index]?.links || []) setGraphLinkOriginSlot(linkId, index);
	}
	node.__gjjMBExtraOutputMigrationDone = true;
}

function ensureOutputCount(node, metaList) {
	if (!Array.isArray(node?.outputs)) return;
	const count = metaList.length;
	while (node.outputs.length > count) {
		const index = node.outputs.length - 1;
		if (outputHasLinks(node.outputs[index])) break;
		disconnectOutputLinks(node, index);
		if (typeof node.removeOutput === "function") node.removeOutput(index);
		else node.outputs.splice(index, 1);
	}
	while (node.outputs.length < count) {
		const meta = metaList[node.outputs.length] || OUTPUT_META[node.outputs.length] || CORE_OUTPUT_META[0];
		if (typeof node.addOutput === "function") node.addOutput(meta.label, meta.type);
		else node.outputs.push(outputFromMeta(meta));
	}
}

function repairOutputs(node) {
	if (!Array.isArray(node?.outputs)) return;
	node.properties = node.properties || {};
	migrateLegacySamplingOutputs(node);
	const preset = activePreset(node);
	pruneInactiveOptionalOutputs(node, preset);
	if (
		node.properties[SAMPLING_OUTPUTS_OPEN_PROPERTY] === undefined
		&& samplingOutputsHaveLinks(node)
	) {
		node.properties[SAMPLING_OUTPUTS_OPEN_PROPERTY] = true;
	}
	const metaList = expandOutputMetaForLinks(node, activeOutputMeta(node));
	const needsRemap = !sameOutputShape(node, metaList);
	const semanticLinks = needsRemap ? collectSemanticOutputLinks(node, metaList) : [];
	if (needsRemap) detachSemanticOutputLinks(node, semanticLinks);
	ensureOutputCount(node, metaList);
	for (let index = 0; index < Math.min(metaList.length, node.outputs.length); index += 1) {
		const meta = metaList[index];
		const output = node.outputs[index];
		if (!output) continue;
		output.name = meta.label;
		output.localized_name = meta.label;
		output.label = meta.label;
		output.type = meta.type;
		output.hidden = false;
		output.visible = true;
		output.disabled = false;
		output.not_show = false;
		output.gjj_slot_id = meta.id;
		output.gjj_slot_class = meta.id;
		output.gjj_output_kind = meta.kind;
		output.gjj_output_type = meta.type;
		output.gjj_hidden_output = false;
		output.slot_index = index;
		if (output.options && typeof output.options === "object") output.options.hidden = false;
	}
	if (needsRemap) restoreSemanticOutputLinks(node, semanticLinks);
	cleanupDanglingOutputLinks(node);
}

function updateSamplingOutputButton(node) {
	const button = node?.__gjjMBSamplingOutputButton;
	if (!button) return;
	const open = samplingOutputsOpen(node);
	button.dataset.value = open ? "true" : "false";
	button.classList.toggle("on", open);
	button.setAttribute("aria-pressed", String(open));
	button.disabled = false;
	button.title = open
		? "采样参数输出口已打开：显示步数、CFG、降噪输出。"
		: "采样参数输出口已关闭：默认只显示模型、CLIP、VAE；点开后显示步数、CFG、降噪。";
}

function setSamplingOutputsOpen(node, open) {
	node.properties = node.properties || {};
	node.properties[SAMPLING_OUTPUTS_OPEN_PROPERTY] = Boolean(open);
	repairOutputs(node);
	updateSamplingOutputButton(node);
	saveWidgetValues(node);
	refreshNode(node);
}

function createSamplingOutputButton(node) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-mb-output-toggle";
	button.textContent = "🔌";
	button.setAttribute("aria-label", "切换采样参数输出口");
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setSamplingOutputsOpen(node, !samplingOutputsOpen(node));
	});
	protect(button);
	node.__gjjMBSamplingOutputButton = button;
	updateSamplingOutputButton(node);
	return button;
}

function buildDom(node) {
	const root = document.createElement("div");
	root.className = "gjj-mb-loader";
	root.style.cssText = `width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:0 ${OUTPUT_HIT_LANE}px 0 0;margin-right:0;pointer-events:none;position:relative;`;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-mb-loader * { box-sizing:border-box; }
		.gjj-mb-loader,
		.gjj-mb-top,
		.gjj-mb-row,
		.gjj-mb-sampling,
		.gjj-mb-combo,
		.gjj-mb-label,
		.gjj-mb-summary { pointer-events:none; }
		.gjj-mb-loader button,
		.gjj-mb-loader input,
		.gjj-mb-loader .gjj-mb-combo-button { pointer-events:auto; }
		.gjj-mb-top { display:grid; grid-template-columns:minmax(0,1fr) 34px 34px; gap:6px; align-items:center; min-width:0; }
		.gjj-mb-row { display:grid; grid-template-columns:88px minmax(0,1fr) 30px; gap:6px; align-items:center; min-width:0; }
		.gjj-mb-sampling { display:grid; grid-template-columns:88px minmax(0,1fr) 30px 30px; gap:6px; align-items:center; min-width:0; }
		.gjj-mb-label { color:#b9c8cc; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-mb-combo { min-width:0; width:100%; position:relative; }
		.gjj-mb-combo-button,
		.gjj-mb-refresh,
		.gjj-mb-broadcast,
		.gjj-mb-output-toggle,
		.gjj-mb-gear {
			width:100%; height:28px; min-width:0; padding:3px 7px; border:1px solid #33464e; border-radius:7px;
			background:#2b2d30; color:#f1f5f5; outline:none; font-size:12px; cursor:pointer;
		}
		.gjj-mb-combo-button { display:flex; align-items:center; justify-content:space-between; gap:6px; text-align:left; }
		.gjj-mb-combo-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
		.gjj-mb-combo-arrow { color:#9fb0b7; flex:0 0 auto; }
		.gjj-mb-refresh, .gjj-mb-broadcast, .gjj-mb-output-toggle, .gjj-mb-gear { background:#24282b; color:#cdd5d8; padding:0; text-align:center; }
		.gjj-mb-broadcast.on,
		.gjj-mb-broadcast[data-value="true"],
		.gjj-mb-output-toggle.on,
		.gjj-mb-output-toggle[data-value="true"],
		.gjj-mb-gear.on { border-color:#69b980; background:#20362f; color:#ecfff1; }
		.gjj-mb-spacer { height:28px; min-width:0; }
		.gjj-mb-info {
			height:28px; min-width:0; padding:6px 7px; border:1px solid #253940; border-radius:7px;
			background:#151f24; color:#c7d4d7; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
		}
		.gjj-mb-lora-row { grid-template-columns:88px minmax(0,1fr) 0; }
		.gjj-mb-lora-controls { display:grid; grid-template-columns:34px minmax(0,1fr) 62px; gap:6px; min-width:0; pointer-events:none; }
		.gjj-mb-patch-row { grid-template-columns:88px minmax(0,1fr) 0; }
		.gjj-mb-patch-controls { display:grid; grid-template-columns:34px minmax(0,1fr); gap:6px; min-width:0; pointer-events:none; }
		.gjj-mb-lora-toggle,
		.gjj-mb-lora-strength {
			width:100%; height:28px; min-width:0; border:1px solid #33464e; border-radius:7px;
			background:#24282b; color:#cdd5d8; outline:none; font-size:12px; pointer-events:auto;
		}
		.gjj-mb-lora-toggle { cursor:pointer; font-weight:800; padding:0; }
		.gjj-mb-lora-toggle.on { border-color:#69b980; background:#20362f; color:#ecfff1; }
		.gjj-mb-lora-toggle:disabled { cursor:not-allowed; opacity:.86; }
		.gjj-mb-lora-row.external .gjj-mb-label { color:#d6c78f; font-weight:700; }
		.gjj-mb-lora-row.external .gjj-mb-lora-toggle {
			border-color:#8a7440; background:#332a18; color:#fff2c7;
		}
		.gjj-mb-lora-strength { padding:3px 5px; background:#0b1418; color:#edf4f4; }
		.gjj-mb-lora-row.off .gjj-mb-combo-button,
		.gjj-mb-lora-row.off .gjj-mb-lora-strength,
		.gjj-mb-patch-row.off .gjj-mb-combo-button { opacity:.48; }
		.gjj-mb-info-row.missing .gjj-mb-info { border-color:#ef4444; background:#3a1518; color:#fecaca; font-weight:800; }
		.gjj-mb-refresh:hover, .gjj-mb-broadcast:hover, .gjj-mb-output-toggle:hover, .gjj-mb-gear:hover, .gjj-mb-combo-button:hover, .gjj-mb-lora-toggle:hover { border-color:#6aa6b8; background:#2c3b43; }
		.gjj-mb-combo-button.missing { border-color:#ef4444; background:#3a1518; color:#fecaca; }
		.gjj-mb-combo-button.missing .gjj-mb-combo-text { color:#fecaca; font-weight:800; }
		.gjj-mb-row.missing .gjj-mb-label { color:#fecaca; font-weight:700; }
		.gjj-mb-missing-row {
			display:grid; grid-template-columns:minmax(0,1fr) 64px 64px; gap:6px; align-items:center; min-width:0;
			margin:-1px 0 2px 0; padding:5px 6px; border:1px solid rgba(239,68,68,.52); border-radius:7px;
			background:rgba(127,29,29,.22); color:#fecaca; pointer-events:auto;
		}
		.gjj-mb-missing-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; font-weight:700; }
		.gjj-mb-missing-btn {
			height:24px; min-width:0; padding:0 5px; border:1px solid rgba(248,113,113,.5); border-radius:6px;
			background:#3a1518; color:#ffe4e6; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;
		}
		.gjj-mb-missing-btn:hover { background:#4a1d21; }
		.gjj-mb-missing-btn.copied { border-color:rgba(74,222,128,.7); background:#14532d; color:#dcfce7; }
		.gjj-mb-missing-btn:disabled { opacity:.42; cursor:not-allowed; }
		.gjj-mb-param-panel {
			display:grid; grid-template-columns:repeat(auto-fit, minmax(142px, 1fr)); gap:5px 6px;
			padding:6px; border:1px solid #2d424a; border-radius:7px; background:#111b20; min-width:0;
		}
		.gjj-mb-param-field { display:grid; grid-template-columns:58px minmax(0,1fr); gap:5px; align-items:center; min-width:0; }
		.gjj-mb-param-label { color:#9fb0b7; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-mb-param-number,
		.gjj-mb-param-panel .gjj-mb-combo-button { height:24px; border-radius:6px; font-size:11px; }
		.gjj-mb-param-number {
			width:100%; min-width:0; padding:2px 6px; border:1px solid #33464e; background:#0b1418;
			color:#edf4f4; outline:none;
		}
		.gjj-mb-summary { height:28px; padding:6px 2px; color:#9caab0; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-mb-sep { height:1px; background:rgba(105,125,134,.24); }
		.gjj-mb-empty { color:#9caab0; font-size:12px; padding:4px 2px; }
		.gjj-mb-popup { position:fixed; z-index:999999; max-height:420px; padding:7px; border:1px solid #47616b; border-radius:9px; background:#10191d; box-shadow:0 10px 32px rgba(0,0,0,.45); }
		.gjj-mb-popup-search { width:100%; height:28px; margin-bottom:6px; padding:3px 7px; border:1px solid #d7eff5; border-radius:6px; background:#0b1418; color:#f1f5f5; outline:none; font-size:12px; }
		.gjj-mb-popup-list { max-height:360px; overflow:auto; display:flex; flex-direction:column; gap:4px; }
		.gjj-mb-popup-item { width:100%; min-height:28px; padding:5px 8px; border:1px solid #31464e; border-radius:6px; background:#172328; color:#edf4f4; text-align:left; cursor:pointer; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-mb-popup-item:hover { background:#21323a; }
		.gjj-mb-popup-item.active { border-color:#4f8f7a; background:#103b31; color:#dff8ea; }
		.gjj-mb-popup-empty { color:#9caab0; font-size:12px; padding:6px 4px; }
	`;
	const content = document.createElement("div");
	content.className = "gjj-mb-content";
	content.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:0;";
	root.append(style, content);
	node.__gjjMBContent = content;
	return root;
}

function forceDomPassThrough(node) {
	const widget = node?.__gjjMBWidget;
	const container = node?.__gjjMBContainer;
	const candidates = [container, widget?.element, widget?.inputEl, widget?.widget, container?.parentElement, container?.parentElement?.parentElement].filter(Boolean);
	for (const el of candidates) if (el?.style) el.style.pointerEvents = "none";
	container?.querySelectorAll?.("button,input,.gjj-mb-combo-button").forEach((el) => {
		if (el?.style) el.style.pointerEvents = "auto";
	});
}

function estimateNodeHeight(node) {
	const content = node?.__gjjMBContent;
	const measured = Math.ceil(Number(content?.scrollHeight || 0)) + 10;
	return Math.max(128, measured);
}

function keepPanelWidgetOutOfSerializedPrefix(node) {
	if (!Array.isArray(node?.widgets)) return;
	const widget = node.__gjjMBWidget || getWidget(node, PANEL_WIDGET);
	if (!widget) return;
	widget.serialize = false;
	widget.options = widget.options || {};
	widget.options.serialize = false;
	const index = node.widgets.indexOf(widget);
	if (index >= 0 && index < node.widgets.length - 1) {
		node.widgets.splice(index, 1);
		node.widgets.push(widget);
	}
}

function ensureDom(node) {
	if (node.__gjjMBWidget) return;
	const container = buildDom(node);
	node.__gjjMBContainer = container;
	const widget = node.addDOMWidget?.(PANEL_WIDGET, "HTML", container, { serialize: false, hideOnZoom: false });
	if (!widget) return;
	widget.serialize = false;
	widget.options = widget.options || {};
	widget.options.serialize = false;
	widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || currentNodeWidth(node))), estimateNodeHeight(node)];
	widget.getHeight = () => estimateNodeHeight(node);
	node.__gjjMBWidget = widget;
	forceDomPassThrough(node);
	setTimeout(() => forceDomPassThrough(node), 80);
	keepPanelWidgetOutOfSerializedPrefix(node);
}

function makeModelRow(node, labelText, widgetName, values, settingsKey, settingsChildren, onChange = null, opts = {}) {
	const row = document.createElement("div");
	row.className = "gjj-mb-row";
	row.classList.toggle("missing", !!opts.missing);
	const label = document.createElement("div");
	label.className = "gjj-mb-label";
	label.textContent = labelText;
	label.title = opts.title || labelText;
	const select = createSearchableSelect(node, widgetName, values, (value) => {
		saveWidgetValues(node);
		onChange?.(value);
	}, opts.select || {});
	const hasSettings = Array.isArray(settingsChildren) && settingsChildren.length > 0;
	const tail = hasSettings ? createGear(node, settingsKey, "展开/收起该模型的加载参数") : Object.assign(document.createElement("div"), { className: "gjj-mb-spacer" });
	row.append(label, select, tail);
	return [row, hasSettings && isSettingsOpen(node, settingsKey) ? createParamPanel(settingsChildren) : null];
}

function makeModelPatchRow(node, enabled, values, opts = {}) {
	const row = document.createElement("div");
	row.className = "gjj-mb-row gjj-mb-patch-row";
	row.classList.toggle("missing", enabled && !!opts.missing);
	row.classList.toggle("off", !enabled);

	const label = document.createElement("div");
	label.className = "gjj-mb-label";
	label.textContent = "🟢 模型补丁";
	label.title = enabled
		? "启用后加载 MODEL_PATCH，并从模型补丁输出口输出。"
		: "关闭后不加载补丁，模型补丁输出为空。";

	const controls = document.createElement("div");
	controls.className = "gjj-mb-patch-controls";

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = `gjj-mb-lora-toggle ${enabled ? "on" : ""}`;
	toggle.textContent = enabled ? "开" : "关";
	toggle.title = enabled ? "点击关闭模型补丁" : "点击启用模型补丁";
	toggle.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setWidgetValue(getWidget(node, MODEL_PATCH_ENABLED_WIDGET), !enabled);
		saveWidgetValues(node);
		renderPanel(node);
	});
	protect(toggle);

	const select = createSearchableSelect(
		node,
		MODEL_PATCH_WIDGET,
		values,
		() => {
			saveWidgetValues(node);
			renderPanel(node);
		},
		opts.select || {}
	);

	controls.append(toggle, select);
	const spacer = Object.assign(document.createElement("div"), { className: "gjj-mb-spacer" });
	row.append(label, controls, spacer);
	return row;
}

function makeToggleModelRow(node, labelText, toggleWidget, modelWidget, enabled, values, opts = {}) {
	const row = document.createElement("div");
	row.className = "gjj-mb-row gjj-mb-patch-row";
	row.classList.toggle("missing", enabled && !!opts.missing);
	row.classList.toggle("off", !enabled);

	const label = document.createElement("div");
	label.className = "gjj-mb-label";
	label.textContent = labelText;
	label.title = opts.title || labelText;

	const controls = document.createElement("div");
	controls.className = "gjj-mb-patch-controls";

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = `gjj-mb-lora-toggle ${enabled ? "on" : ""}`;
	toggle.textContent = enabled ? "开" : "关";
	toggle.title = enabled ? "当前使用独立 VAE；点击改用 checkpoint 自带 VAE。" : "当前使用 checkpoint 自带 VAE；点击改用独立 VAE。";
	toggle.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setWidgetValue(getWidget(node, toggleWidget), !enabled);
		saveWidgetValues(node);
		renderPanel(node);
	});
	protect(toggle);

	const select = createSearchableSelect(
		node,
		modelWidget,
		values,
		() => {
			saveWidgetValues(node);
			renderPanel(node);
		},
		opts.select || {}
	);

	controls.append(toggle, select);
	const spacer = Object.assign(document.createElement("div"), { className: "gjj-mb-spacer" });
	row.append(label, controls, spacer);
	return row;
}

function makeInfoRow(labelText, text, opts = {}) {
	const row = document.createElement("div");
	row.className = "gjj-mb-row gjj-mb-info-row";
	row.classList.toggle("missing", !!opts.missing);
	const label = document.createElement("div");
	label.className = "gjj-mb-label";
	label.textContent = labelText;
	const value = document.createElement("div");
	value.className = "gjj-mb-info";
	value.textContent = text || "未配置";
	value.title = opts.title || text || "";
	const spacer = Object.assign(document.createElement("div"), { className: "gjj-mb-spacer" });
	row.append(label, value, spacer);
	return row;
}

function makePresetLoraRow(node, item, loras) {
	const row = document.createElement("div");
	row.className = "gjj-mb-row gjj-mb-lora-row";
	row.classList.toggle("missing", !!item.missing);
	row.classList.toggle("off", !item.enabled && !item.externalControlled);
	row.classList.toggle("external", !!item.externalControlled);

	const label = document.createElement("div");
	label.className = "gjj-mb-label";
	label.textContent = PRESET_LORA_SLOTS.length > 1 ? `🟠 LoRA ${item.index}` : "🟠 预设LoRA";
	label.title = item.externalControlled
		? "已接入「使用LoRA」输入，模板 LoRA 是否启用由外部布尔值控制。"
		: (!item.autoEnabled && !item.enabled
			? "该模板建议把 LoRA 外接到 MODEL 后再使用，加载器内部默认不叠加。"
			: (item.enabled ? "模板自带 LoRA，会在模型加载后自动叠加。" : "该模板 LoRA 已关闭。"));

	const controls = document.createElement("div");
	controls.className = "gjj-mb-lora-controls";

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = `gjj-mb-lora-toggle ${item.enabled || item.externalControlled ? "on" : ""}`;
	toggle.textContent = item.externalControlled ? "外控" : (item.enabled ? "开" : "关");
	toggle.disabled = !!item.externalControlled;
	toggle.title = item.externalControlled
		? "已接入「使用LoRA」输入，面板开关暂由外部控制。"
		: (item.enabled ? "点击关闭这个预设 LoRA" : "点击启用这个预设 LoRA");
	toggle.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (item.externalControlled) return;
		setWidgetValue(getWidget(node, item.enabledWidget), !item.enabled);
		saveWidgetValues(node);
		renderPanel(node);
	});
	protect(toggle);

	const select = createSearchableSelect(
		node,
		item.nameWidget,
		uniqueValues([item.name].filter(Boolean), loras),
		() => {
			saveWidgetValues(node);
			renderPanel(node);
		},
		{
			placeholder: "过滤 LoRA",
			format: formatModelValue,
			missingText: item.missing ? `缺失：${formatModelValue(item.missing)}` : "",
			title: (value) => item.missing
				? `模板期望：${value || item.name}\n请放到 ${modelRelPath("loras", item.missing)}`
				: value,
		}
	);

	const strength = document.createElement("input");
	strength.className = "gjj-mb-lora-strength";
	strength.type = "number";
	strength.step = "0.05";
	strength.min = "-10";
	strength.max = "10";
	strength.value = formatLoraStrength(item.strength);
	strength.title = "预设 LoRA 模型强度";
	strength.addEventListener("input", () => {
		setWidgetValue(getWidget(node, item.strengthWidget), strength.value);
		saveWidgetValues(node);
	});
	protect(strength);

	controls.append(toggle, select, strength);
	const spacer = Object.assign(document.createElement("div"), { className: "gjj-mb-spacer" });
	row.append(label, controls, spacer);
	return row;
}

function renderPanel(node) {
	const state = ensureState(node);
	if (!state.folders) {
		if (!state.loading) refreshBackendLists(node, true);
		return;
	}
	if (node.__gjjMBRendering) return;
	node.__gjjMBRendering = true;
	try {
	const content = node.__gjjMBContent;
	if (!content) return;

	const presets = allPresets(node);
	const templates = presets.map((preset) => String(preset?.id || "")).filter(Boolean);
	setComboOptions(getWidget(node, TEMPLATE_WIDGET), templates);
	if (templates.length) setTemplateId(node, currentTemplateId(node) || templates[0]);
	if (!node.properties?.[PRESET_INIT_PROPERTY]) applyPreset(node, true);

	const checkpoints = state.folders?.checkpoints || [];
	const unets = uniqueValues(state.folders?.diffusion_models || [], checkpoints);
	const clips = state.folders?.clip || [];
	const vaes = state.folders?.vae || [];
	const loras = state.folders?.loras || [];
	const modelPatches = state.folders?.model_patches || [];
	const clipVisions = uniqueValues(state.folders?.clip_vision || [], state.folders?.clip_visions || []);
	const controlnets = state.folders?.controlnet || [];
	for (const [name, values] of [
		[UNET_DTYPE_WIDGET, state.unetDtypes],
		[CLIP_DTYPE_WIDGET, state.clipDtypes],
		[CLIP_DEVICE_WIDGET, state.clipDevices],
		[VAE_DTYPE_WIDGET, state.vaeDtypes],
		[CLIP_TYPE_WIDGET, state.clipTypes],
	]) setComboOptions(getWidget(node, name), values);
	if (!state.clipDevices.includes(valueOf(node, CLIP_DEVICE_WIDGET))) {
		setWidgetValue(getWidget(node, CLIP_DEVICE_WIDGET), "default", false);
	}

	const templateId = currentTemplateId(node);
	const preset = presetById(node, templateId);
	sanitizeChoiceValue(node, UNET_DTYPE_WIDGET, state.unetDtypes, "default");
	sanitizeChoiceValue(node, CLIP_DTYPE_WIDGET, state.clipDtypes, "default");
	sanitizeChoiceValue(node, CLIP_DEVICE_WIDGET, state.clipDevices, "default");
	sanitizeChoiceValue(node, VAE_DTYPE_WIDGET, state.vaeDtypes, "default");
	sanitizeChoiceValue(node, CLIP_TYPE_WIDGET, state.clipTypes, preset?.clipType || "stable_diffusion");
	const checkpointPreset = isCheckpointPreset(preset);
	const checkpointCommon = isCheckpointCommonPreset(preset);
	const fluxPreset = !checkpointPreset && isFlux1Preset(preset);
	const presetMainCategory = lower(preset?.modelCategory);
	const mainValues = checkpointPreset || presetMainCategory === "checkpoints" ? checkpoints : unets;
	const mainFolder = lower(preset?.modelCategory) === "checkpoints" ? "checkpoints" : "diffusion_models";
	for (const name of [MODEL_PATCH_WIDGET, CLIP_VISION_WIDGET, ...CONTROL_NET_WIDGETS]) {
		const current = valueOf(node, name);
		const cleaned = sanitizeOptionalModelValue(current);
		if (current !== cleaned) setWidgetValue(getWidget(node, name), cleaned, false);
	}
	if (checkpointCommon) {
		const currentCheckpoint = valueOf(node, UNET_WIDGET).trim();
		if (checkpoints.length && (!currentCheckpoint || !checkpoints.includes(currentCheckpoint))) setWidgetValue(getWidget(node, UNET_WIDGET), checkpoints[0], false);
		if (!valueOf(node, VAE_NAME_WIDGET).trim() && vaes.length) setWidgetValue(getWidget(node, VAE_NAME_WIDGET), defaultVaeValue(vaes), false);
		clearControlNetWidgets(node);
	}
	pruneInactiveOptionalOutputs(node, preset);
	const unetExpected = preset && !checkpointCommon ? expectedMainModelName(preset) : "";
	const unetMissing = preset && !checkpointCommon ? missingModel(unetExpected, mainValues) : "";
	if (preset) ensurePresetLoraWidgetDefaults(node, preset, loras);
	if (preset) ensureModelPatchWidgetDefault(node, preset, modelPatches);
	if (fluxPreset) {
		const defaultFixedClip = fluxFixedClipName(clips, preset);
		if (!valueOf(node, FLUX_CLIP_L_WIDGET).trim()) setWidgetValue(getWidget(node, FLUX_CLIP_L_WIDGET), defaultFixedClip, false);
		const t5FromSaved = fluxT5ClipNameFromValue(valueOf(node, CLIP_NAME_WIDGET));
		if (t5FromSaved && valueOf(node, CLIP_NAME_WIDGET) !== t5FromSaved) setWidgetValue(getWidget(node, CLIP_NAME_WIDGET), t5FromSaved, false);
		if (!valueOf(node, CLIP_NAME_WIDGET).trim()) {
			setWidgetValue(getWidget(node, CLIP_NAME_WIDGET), shortMatch(fluxT5ExpectedName(preset), fluxT5Candidates(clips, fluxT5ExpectedName(preset)), fluxT5ExpectedName(preset)), false);
		}
		if (preset?.vaeName) setWidgetValue(getWidget(node, VAE_NAME_WIDGET), shortMatch(preset.vaeName, vaes, preset.vaeName), false);
	}
	const fluxFixedClip = fluxPreset ? (valueOf(node, FLUX_CLIP_L_WIDGET) || fluxFixedClipName(clips, preset)) : "";
	const fluxT5Expected = fluxPreset ? fluxT5ExpectedName(preset) : "";
	const fluxT5Current = fluxPreset ? (fluxT5ClipNameFromValue(valueOf(node, CLIP_NAME_WIDGET)) || valueOf(node, CLIP_NAME_WIDGET) || fluxT5Expected) : "";
	const clipExpected = fluxPreset ? [fluxFixedClip || "clip_l.safetensors", fluxT5Current || fluxT5Expected] : (preset?.clipNames || []);
	const clipValues = fluxPreset ? uniqueValues([fluxT5Current].filter(Boolean), fluxT5Candidates(clips, fluxT5Expected)) : clips;
	const clipMissing = checkpointPreset ? [] : clipExpected.map((name) => missingModel(name, clips)).filter(Boolean);
	const vaeExpected = preset?.vaeName || "";
	const separateVaeOn = checkpointCommon && boolOf(node, USE_SEPARATE_VAE_WIDGET, false);
	const separateVaeCurrent = valueOf(node, VAE_NAME_WIDGET) || defaultVaeValue(vaes);
	const vaeMissing = checkpointCommon
		? (separateVaeOn && separateVaeCurrent ? missingModel(separateVaeCurrent, vaes) : "")
		: (!checkpointPreset && vaeExpected ? missingModel(vaeExpected, vaes) : "");
	const presetLoras = readPresetLoraSlots(node, preset, loras);
	const loraMissing = presetLoras.map((item) => item.missing).filter(Boolean);
	const modelPatchExpected = preset?.modelPatchName || "";
	const modelPatchOn = modelPatchEnabled(node, preset);
	const modelPatchCurrent = sanitizeOptionalModelValue(valueOf(node, MODEL_PATCH_WIDGET)) || modelPatchExpected;
	const modelPatchMissing = modelPatchOn && modelPatchCurrent ? missingModel(modelPatchCurrent, modelPatches) : "";
	const clipVisionExpected = preset?.clipVisionName || "";
	const clipVisionCurrent = sanitizeOptionalModelValue(valueOf(node, CLIP_VISION_WIDGET));
	const clipVisionMissing = (clipVisionExpected || clipVisionCurrent) ? missingModel(clipVisionCurrent || clipVisionExpected, clipVisions) : "";
	const controlNetExpected = preset?.controlNetName || "";
	const controlNetCurrent = sanitizeOptionalModelValue(valueOf(node, CONTROL_NET_WIDGET));
	const controlNetMissing = (controlNetExpected || controlNetCurrent) ? missingModel(controlNetCurrent || controlNetExpected, controlnets) : "";
	const clipMissingText = clipMissing.length ? `缺失：${clipMissing.map(basename).join(" + ")}` : "";

	content.replaceChildren();
	const top = document.createElement("div");
	top.className = "gjj-mb-top";
	const templateSelect = createSearchableSelect(node, TEMPLATE_WIDGET, templates, () => {
		applyPreset(node, true);
		renderPanel(node);
	}, {
		placeholder: "过滤模板",
		format: (value) => templateLabel(presetById(node, value) || { id: value }),
		title: (value) => `模板：${value || "未选择"}\n会自动配齐扩散模型、CLIP、VAE、模型补丁、CLIP视觉与采样默认值。`,
	});
	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.className = "gjj-mb-refresh";
	refresh.textContent = "↻";
	refresh.title = "重新读取 models 目录与模型族预设";
	refresh.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshBackendLists(node, false).then(() => {
			applyPreset(node, true);
			renderPanel(node);
		});
	});
	protect(refresh);
	top.append(templateSelect, refresh, createBroadcastButton(node));
	content.appendChild(top);

	content.appendChild(Object.assign(document.createElement("div"), { className: "gjj-mb-sep" }));
	const unetRow = makeModelRow(
		node,
		checkpointPreset ? "🟣 Checkpoint" : "🟣 扩散模型",
		UNET_WIDGET,
		mainValues,
		"unet_model",
		[
			createSelectSetting(node, UNET_DTYPE_WIDGET, "UNET精度", state.unetDtypes),
		],
		(value) => {
			if (checkpointCommon) {
				saveWidgetValues(node);
				renderPanel(node);
				return;
			}
			const matched = matchModelFamilyPreset(value, allPresets(node));
			if (matched?.id) {
				setTemplateId(node, matched.id);
				applyPreset(node, true);
			}
			renderPanel(node);
		},
		{
			missing: !!unetMissing,
			title: "由模板自动匹配；也可以手动覆盖当前扩散模型。",
			select: {
				placeholder: checkpointPreset ? "过滤 checkpoint" : "过滤扩散模型",
				format: formatModelValue,
				missingText: unetMissing ? `缺失：${unetMissing}` : "",
				title: (value) => unetMissing
					? `模板期望：${unetExpected}\n请放到 ${modelRelPath(mainFolder, unetMissing)}`
					: value,
			},
		}
	);
	for (const item of unetRow) if (item) content.appendChild(item);
	if (unetMissing) content.appendChild(createMissingModelHint(mainFolder, unetMissing));

	if (presetLoras.length) {
		for (const item of presetLoras) content.appendChild(makePresetLoraRow(node, item, loras));
		for (const missing of loraMissing) content.appendChild(createMissingModelHint("loras", missing));
	}

	if (checkpointPreset) {
		content.appendChild(makeInfoRow("🟡 CLIP", "由 checkpoint 输出", {
			title: "Checkpoint 预设固定使用 checkpoint 自带 CLIP，不单独加载 CLIP 模型。",
		}));
		if (checkpointCommon) {
			const currentVae = separateVaeCurrent || defaultVaeValue(vaes);
			if (currentVae && valueOf(node, VAE_NAME_WIDGET) !== currentVae) setWidgetValue(getWidget(node, VAE_NAME_WIDGET), currentVae, false);
			content.appendChild(makeToggleModelRow(
				node,
				"🔴 独立VAE",
				USE_SEPARATE_VAE_WIDGET,
				VAE_NAME_WIDGET,
				separateVaeOn,
				uniqueValues([currentVae].filter(Boolean), vaes),
				{
					missing: !!vaeMissing,
					title: separateVaeOn
						? "开：加载下拉选择的独立 VAE，替换 checkpoint 自带 VAE。"
						: "关：使用 checkpoint 自带 VAE；下拉值会保留，方便随时切换。",
					select: {
						placeholder: "过滤 VAE",
						format: formatModelValue,
						missingText: vaeMissing ? `缺失：${formatModelValue(vaeMissing)}` : "",
						title: (value) => vaeMissing
							? `独立 VAE：${value || currentVae}\n请放到 ${modelRelPath("vae", vaeMissing)}`
							: (separateVaeOn ? value : `当前未启用，实际使用 checkpoint 自带 VAE。\n候选：${value}`),
					},
				}
			));
			if (vaeMissing) content.appendChild(createMissingModelHint("vae", vaeMissing));
		} else {
			content.appendChild(makeInfoRow("🔴 VAE", "由 checkpoint 输出", {
				title: "当前模板使用 CheckpointLoaderSimple 等效路径，VAE 跟随 checkpoint 输出。",
			}));
		}
	}

	if (!checkpointPreset) {
		const clipSettings = fluxPreset
			? [
				createSelectSetting(node, FLUX_CLIP_L_WIDGET, "CLIP名称1", uniqueValues([fluxFixedClip].filter(Boolean), clips)),
				createSelectSetting(node, CLIP_TYPE_WIDGET, "类型", state.clipTypes),
				createSelectSetting(node, CLIP_DEVICE_WIDGET, "设备", state.clipDevices),
				createSelectSetting(node, CLIP_DTYPE_WIDGET, "精度", state.clipDtypes),
			]
			: [
				createSelectSetting(node, CLIP_TYPE_WIDGET, "CLIP类型", state.clipTypes),
				createSelectSetting(node, CLIP_DEVICE_WIDGET, "CLIP设备", state.clipDevices),
				createSelectSetting(node, CLIP_DTYPE_WIDGET, "CLIP精度", state.clipDtypes),
			];
		const clipRow = makeModelRow(
			node,
			fluxPreset ? "🟡 Flux1 T5" : "🟡 CLIP",
			CLIP_NAME_WIDGET,
			clipValues,
			"clip",
			clipSettings,
			(value) => {
				if (!fluxPreset) return;
				const t5Clip = fluxT5ClipNameFromValue(value) || value || fluxT5Expected;
				setWidgetValue(getWidget(node, CLIP_NAME_WIDGET), t5Clip);
				saveWidgetValues(node);
				renderPanel(node);
			},
			{
				missing: clipMissing.length > 0,
				title: fluxPreset
					? "Flux1 固定使用 clip_l，主面板只暴露可替换的 T5 XXL 编码器；clip_l、类型、设备在齿轮里。"
					: "按模板从 model_family_presets.tsv 配对；多编码器会用 + 显示。",
				select: {
					placeholder: fluxPreset ? "过滤 T5" : "过滤 CLIP",
					format: fluxPreset
						? (value) => formatFluxClipValue(value, fluxFixedClip, fluxT5Expected)
						: formatModelValue,
					missingText: clipMissingText,
					title: (value) => clipMissing.length
						? `模板期望：${clipExpected.join(" + ")}\n缺失：${clipMissing.join(" + ")}`
						: fluxPreset
							? `CLIP名称1：${fluxFixedClip || "clip_l.safetensors"}\nT5：${fluxT5ClipNameFromValue(value) || value || fluxT5Expected}`
							: (splitClipNames(value).length > 1 ? splitClipNames(value).join("\n") : value),
				},
			}
		);
		for (const item of clipRow) if (item) content.appendChild(item);
		for (const missing of clipMissing) content.appendChild(createMissingModelHint("clip", missing));

		if (fluxPreset) {
			content.appendChild(makeInfoRow("🔴 VAE", formatModelValue(valueOf(node, VAE_NAME_WIDGET) || vaeExpected || "ae.safetensors"), {
				missing: !!vaeMissing,
				title: vaeMissing
					? `Flux1 VAE 固定为 ${vaeExpected || "ae.safetensors"}，请放到 ${modelRelPath("vae", vaeMissing)}`
					: "Flux1 VAE 固定使用 ae.safetensors。",
			}));
			if (vaeMissing) content.appendChild(createMissingModelHint("vae", vaeMissing));
		} else {
			const vaeRow = makeModelRow(
				node,
				"🔴 VAE",
				VAE_NAME_WIDGET,
				vaes,
				"vae",
				[
					createSelectSetting(node, VAE_DTYPE_WIDGET, "VAE精度", state.vaeDtypes),
				],
				null,
				{
					missing: !!vaeMissing,
					title: "按模板从 model_family_presets.tsv 配对。",
					select: {
					placeholder: "过滤 VAE",
					format: formatModelValue,
					missingText: vaeMissing ? `缺失：${formatModelValue(vaeMissing)}` : "",
					title: (value) => vaeMissing
						? `模板期望：${vaeExpected}\n请放到 ${modelRelPath("vae", vaeMissing)}`
						: value,
					},
				}
			);
			for (const item of vaeRow) if (item) content.appendChild(item);
			if (vaeMissing) content.appendChild(createMissingModelHint("vae", vaeMissing));
		}
	}

	if (modelPatchExpected || valueOf(node, MODEL_PATCH_WIDGET)) {
		content.appendChild(
			makeModelPatchRow(
				node,
				modelPatchOn,
				uniqueValues([modelPatchCurrent].filter(Boolean), modelPatches),
				{
					missing: !!modelPatchMissing,
					select: {
						placeholder: "过滤模型补丁",
						format: formatModelValue,
						missingText: modelPatchMissing ? `缺失：${formatModelValue(modelPatchMissing)}` : "",
						title: (value) => modelPatchMissing
							? `模板期望：${value || modelPatchCurrent || modelPatchExpected}\n请放到 ${modelRelPath("model_patches", modelPatchMissing)}`
							: value,
					},
				}
			)
		);
		if (modelPatchMissing) content.appendChild(createMissingModelHint("model_patches", modelPatchMissing));
	}

	if (clipVisionExpected || clipVisionCurrent) {
		const visionRow = makeModelRow(
			node,
			"🔵 CLIP视觉",
			CLIP_VISION_WIDGET,
			clipVisions,
			"clip_vision",
			[],
			null,
			{
				missing: !!clipVisionMissing,
				title: "模板自动匹配 CLIP_VISION，例如 USO 的 SigCLIP 视觉编码器。",
				select: {
					placeholder: "过滤 CLIP视觉",
					format: formatModelValue,
					missingText: clipVisionMissing ? `缺失：${formatModelValue(clipVisionMissing)}` : "",
					title: (value) => clipVisionMissing
						? `模板期望：${clipVisionCurrent || clipVisionExpected}\n请放到 ${modelRelPath("clip_vision", clipVisionMissing)}`
						: value,
				},
			}
		);
		for (const item of visionRow) if (item) content.appendChild(item);
		if (clipVisionMissing) content.appendChild(createMissingModelHint("clip_vision", clipVisionMissing));
	}

	if (checkpointCommon) {
		clearControlNetWidgets(node);
	} else if (controlNetExpected || controlNetCurrent) {
		const controlNetRow = makeModelRow(
			node,
			"🟦 ControlNet",
			CONTROL_NET_WIDGET,
			controlnets,
			"controlnet",
			[],
			null,
			{
				missing: !!controlNetMissing,
				title: "模板自动匹配 CONTROL_NET，可连接到 ControlNet Apply 节点。",
				select: {
					placeholder: "过滤 ControlNet",
					format: formatModelValue,
					missingText: controlNetMissing ? `缺失：${formatModelValue(controlNetMissing)}` : "",
					title: (value) => controlNetMissing
						? `模板期望：${controlNetCurrent || controlNetExpected}\n请放到 ${modelRelPath("controlnet", controlNetMissing)}`
						: value,
				},
			}
		);
		for (const item of controlNetRow) if (item) content.appendChild(item);
		if (controlNetMissing) content.appendChild(createMissingModelHint("controlnet", controlNetMissing));
	}

	const sampling = document.createElement("div");
	sampling.className = "gjj-mb-sampling";
	const samplingLabel = document.createElement("div");
	samplingLabel.className = "gjj-mb-label";
	samplingLabel.textContent = "⚙️ 采样";
	const summary = document.createElement("div");
	summary.className = "gjj-mb-summary";
	node.__gjjMBSamplingSummary = summary;
	updateSamplingSummary(node);
	sampling.append(
		samplingLabel,
		summary,
		createSamplingOutputButton(node),
		createGear(node, "sampling", "展开/收起步数、CFG、降噪")
	);
	content.appendChild(sampling);
	if (isSettingsOpen(node, "sampling")) {
		content.appendChild(createParamPanel([
			createNumberSetting(node, STEPS_WIDGET, "步数", 1, 1, 10000),
			createNumberSetting(node, CFG_WIDGET, "CFG", 0.1, 0, 100),
			createNumberSetting(node, DENOISE_WIDGET, "降噪", 0.01, 0, 1),
		]));
	}

	repairOutputs(node);
	hideNativeWidgets(node);
	updateBroadcastButton(node);
	updateSamplingOutputButton(node);
	saveWidgetValues(node);
	refreshNode(node);
	} finally {
		node.__gjjMBRendering = false;
	}
}

function refreshNode(node) {
	if (!node) return;
	const width = rememberNodeWidth(node);
	const height = estimateNodeHeight(node);
	if (!node.__gjjMBSizing && (Math.abs(Number(node.size?.[0] || 0) - width) > 1 || Math.abs(Number(node.size?.[1] || 0) - height) > 1)) {
		node.__gjjMBSizing = true;
		try { node.setSize?.([width, height]); }
		finally { requestAnimationFrame(() => { node.__gjjMBSizing = false; }); }
	}
	forceDomPassThrough(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function stabilize(node) {
	if (!node) return;
	rememberNodeWidth(node);
	attachHelpModelProvider(node);
	restoreWidgetValues(node);
	ensureDom(node);
	keepPanelWidgetOutOfSerializedPrefix(node);
	hideNativeWidgets(node);
	repairOutputs(node);
	refreshBackendLists(node, false).finally(() => {
		if (!ensureState(node).folders) return;
		applyPreset(node, false);
		renderPanel(node);
	});
}

function schedule(node, delay = 0) {
	clearTimeout(node.__gjjMBTimer);
	node.__gjjMBTimer = setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.ModelBundleLoader",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		await getModelFamilyPresets();

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (ALL_WIDGETS.includes(name)) hideWidget(widget);
			return widget;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			restoreWidgetValues(this, serializedNode);
			schedule(this, 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			schedule(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			rememberNodeWidth(this);
			repairOutputs(this);
			saveWidgetValues(this, serializedNode);
			originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[WIDTH_PROPERTY] = this.properties?.[WIDTH_PROPERTY] || currentNodeWidth(this);
				serializedNode.properties[BROADCAST_PROPERTY] = broadcastEnabled(this);
				serializedNode.properties[SAMPLING_OUTPUTS_OPEN_PROPERTY] = samplingOutputsOpen(this);
				serializedNode.properties[PRESET_INIT_PROPERTY] = Boolean(this.properties?.[PRESET_INIT_PROPERTY]);
				serializedNode.properties[PRESET_UNET_PROPERTY] = String(this.properties?.[PRESET_UNET_PROPERTY] || "");
				serializedNode.properties[PRESET_TEMPLATE_PROPERTY] = currentTemplateId(this) || String(this.properties?.[PRESET_TEMPLATE_PROPERTY] || "");
			}
			saveWidgetValues(this, serializedNode);
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjMBSizing) {
				rememberNodeWidth(this);
				refreshNode(this);
			}
			return result;
		};
	},

	nodeCreated(node) {
		if (node?.comfyClass === TARGET_NODE) schedule(node, 0);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET_NODE) stabilize(node);
		}
	},
});

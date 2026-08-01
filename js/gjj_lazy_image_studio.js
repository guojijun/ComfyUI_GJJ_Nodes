import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
	getCachedModelFamilyPresets,
	getModelFamilyPresets,
} from "./gjj_model_family_preset_table.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { closeTemplateSourcePicker, createTemplateSourceButton, updateTemplateSourcePanel } from "./gjj_generation_template_sources.js";
import { requestPromptTranslation } from "./gjj_common_prompt_translation.js";

const TARGET_NODES = new Set(["GJJ_LazyImageStudio"]);
const IMAGE_PREFIX = "image_";
const PRIMARY_IMAGE_INPUT = "image_01";
const BATCH_SOURCE_WIDGET = "batch_source_images";
const MAIN_MASK_INPUT = "mask";
const LAST_PRESET_KEY = "gjj_lazy_last_preset_unet";
const MIN_VISIBLE_IMAGES = 1;
const MAX_IMAGES = Number.POSITIVE_INFINITY;
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const IMAGE_TOOLTIP = "参考图片输入；有连接时会自动补出下一个图片插槽。";
const PRIMARY_IMAGE_TOOLTIP = "可直接接入 GJJ · 多图片加载预览器 的批量图片输出；后端会按原图顺序恢复多图参考。";
const MASK_TOOLTIP = "主图可选遮罩；存在时会走带 noise_mask 的局部编辑逻辑。";
const ANY_PREVIEW_MEDIA_DRAG_MIME = "application/x-gjj-any-preview-media";

const EXECUTE_BUTTON_NAME = "__gjj_execute_button";
const IMAGE_PREVIEW_NAME = "__gjj_image_preview";
const NATIVE_CANVAS_PREVIEW_WIDGET = "$$canvas-image-preview";
const NATIVE_PREVIEW_WIDGET_PATTERN = /(?:preview|image|images|img|预览|图像|图片)/i;
const LORA_CHAIN_CONFIG_INPUT = "lora_chain_config";
const LORA_DATA_WIDGET_NAME = "lora_data";
const TEST_CONFIG_WIDGET_NAME = "test_config";
const LORA_METADATA_API_PATH = "/gjj/lora-metadata";
const LORA_PREVIEW_API_PREFIX = "/gjj/lora-preview/";
const KEEP_MODEL_WIDGET_NAME = "keep_model_loaded";
const DEVICE_PREFERENCE_WIDGET_NAME = "device_preference";
const USE_INPUT_IMAGE_SIZE_WIDGET_NAME = "use_input_image_size";
const IMAGE_RESIZE_CONFIG_WIDGET_NAME = "image_resize_config";
const MODEL_SOURCE_WIDGET_NAME = "model_source";
const CHECKPOINT_WIDGET_NAME = "ckpt_name";
const CHECKPOINT_MODEL_SOURCE_VALUE = "底模 checkpoint";
const ENABLE_SAGE_ATTENTION_WIDGET_NAME = "enable_sage_attention";
const SAGE_ATTENTION_MODE_WIDGET_NAME = "sage_attention_mode";
const ALLOW_SAGE_COMPILE_WIDGET_NAME = "allow_sage_compile";
const ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME = "enable_fp16_accumulation_setting";
const FP16_ACCUMULATION_WIDGET_NAME = "fp16_accumulation";
const MISSING_SAGE_ATTENTION_POLICY_WIDGET_NAME = "missing_sage_attention_policy";
const GLOBAL_PROMPT_WIDGET_NAME = "global_prompt";
const DEFAULT_GLOBAL_QUALITY_PROMPT = "high quality, highly detailed, sharp focus, clean composition, professional lighting, natural colors";
const DEFAULT_NEGATIVE_PROMPT = "low quality, worst quality, lowres, blurry, out of focus, jpeg artifacts, bad anatomy, deformed anatomy, malformed limbs, extra arms, extra legs, extra hands, extra feet, extra fingers, missing fingers, fused fingers, mutated hands, poorly drawn hands, malformed hands, broken hands, malformed feet, broken legs, severed hands, severed feet, severed limbs, dismembered, duplicate limbs, distorted face";
const MODEL_OPTIMIZATION_WIDGETS = [
	ENABLE_SAGE_ATTENTION_WIDGET_NAME,
	SAGE_ATTENTION_MODE_WIDGET_NAME,
	ALLOW_SAGE_COMPILE_WIDGET_NAME,
	ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME,
	FP16_ACCUMULATION_WIDGET_NAME,
	MISSING_SAGE_ATTENTION_POLICY_WIDGET_NAME,
];
const MODEL_OPTIMIZATION_BOOLEAN_WIDGETS = new Set([
	ENABLE_SAGE_ATTENTION_WIDGET_NAME,
	ALLOW_SAGE_COMPILE_WIDGET_NAME,
	ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME,
	FP16_ACCUMULATION_WIDGET_NAME,
]);
const MODEL_OPTIMIZATION_COMBO_WIDGETS = new Set([
	SAGE_ATTENTION_MODE_WIDGET_NAME,
	MISSING_SAGE_ATTENTION_POLICY_WIDGET_NAME,
]);
const MODEL_OPTIMIZATION_BUTTON_LABELS = {
	[ENABLE_SAGE_ATTENTION_WIDGET_NAME]: "SageAttention",
	[ALLOW_SAGE_COMPILE_WIDGET_NAME]: "Sage编译",
	[FP16_ACCUMULATION_WIDGET_NAME]: "FP16累积",
};
const SETTINGS_OPEN_PROPERTY = "gjj_lazy_image_studio_settings_open";
const MODEL_SETTINGS_OPEN_PROPERTY = "gjj_lazy_image_studio_model_settings_open";
const SIZE_SETTINGS_OPEN_PROPERTY = "gjj_lazy_image_studio_size_settings_open";
const PROMPT_SETTINGS_OPEN_PROPERTY = "gjj_lazy_image_studio_prompt_settings_open";
const TRANSLATE_ENABLED_PROPERTY = "gjj_lazy_image_studio_translate_enabled";
const PARAM_VALUES_PROPERTY = "gjj_lazy_image_studio_param_values";
const IMAGE_SIZE_SIGNATURE_PROPERTY = "gjj_lazy_image_studio_image_size_signature";
const TEST_FILTER_PROPERTY = "gjj_lazy_image_studio_test_filters";
const TEST_SORT_PROPERTY = "gjj_lazy_image_studio_test_sorts";
const TEST_STRENGTH_PROPERTY = "gjj_lazy_image_studio_test_strength";
const BATCH_IMAGE_LINK_MEMORY_PROPERTY = "gjj_lazy_image_studio_batch_image_link_memory";
const PREVIEW_LAYOUT_PROPERTY = "gjj_lazy_image_studio_preview_layout";
const PREVIEW_PAGE_PROPERTY = "gjj_lazy_image_studio_preview_page";
const LORA_GLOBAL_SEARCH_PROPERTY = "gjj_lazy_image_studio_lora_global_search";
const DEFAULT_IMAGE_RESIZE_CONFIG = Object.freeze({
	mode: "宽高",
	fit_mode: "裁剪",
	crop_position: "上",
	scale_percent: 100,
	long_side_length: 1024,
	total_pixel_k: 260,
});
const IMAGE_RESIZE_MODES = ["宽高", "等比", "长边", "像素"];
const IMAGE_FIT_MODES = ["拉伸", "补边", "留边", "裁剪"];
const IMAGE_CROP_POSITIONS = ["上", "下", "左", "右", "中"];
const TRANSLATE_BUTTON_STYLES = {
	off: {
		bg: "linear-gradient(135deg, #1f2933, #374151)",
		hover: "linear-gradient(135deg, #374151, #4b5563)",
		border: "#55636f",
		color: "#cbd5e1",
		title: "翻译已关闭：点击开启并立即翻译当前提示词。",
	},
	on: {
		bg: "linear-gradient(135deg, #047857, #059669)",
		hover: "linear-gradient(135deg, #059669, #10b981)",
		border: "#34d399",
		color: "#ecfdf5",
		title: "翻译已开启：点击会立即翻译当前提示词；上游来的提示词字段会自动翻译。",
	},
	busy: {
		bg: "linear-gradient(135deg, #075985, #0e7490)",
		hover: "linear-gradient(135deg, #0e7490, #0891b2)",
		border: "#38bdf8",
		color: "#e0f2fe",
		title: "正在翻译提示词...",
	},
	error: {
		bg: "linear-gradient(135deg, #7f1d1d, #dc2626)",
		hover: "linear-gradient(135deg, #991b1b, #ef4444)",
		border: "#ef4444",
		color: "#fee2e2",
	},
};
const KEEP_MODEL_BUTTON_STYLES = {
	off: {
		bg: "linear-gradient(135deg, #1f2933, #374151)",
		hover: "linear-gradient(135deg, #374151, #4b5563)",
		border: "#55636f",
		color: "#cbd5e1",
		title: "模型保持已关闭：执行完成后按常规清理显存。",
	},
	on: {
		bg: "linear-gradient(135deg, #7c3aed, #9333ea)",
		hover: "linear-gradient(135deg, #9333ea, #a855f7)",
		border: "#c084fc",
		color: "#f5f3ff",
		title: "模型保持已开启：执行后保留当前模型、CLIP 和 VAE，适合连续生成。",
	},
};
const MODEL_SETTINGS_BUTTON_STYLES = {
	off: {
		bg: "linear-gradient(135deg, #1f2933, #374151)",
		hover: "linear-gradient(135deg, #374151, #4b5563)",
		border: "#55636f",
		color: "#e5edf2",
	},
	on: {
		bg: "linear-gradient(135deg, #7c3aed, #9333ea)",
		hover: "linear-gradient(135deg, #9333ea, #a855f7)",
		border: "#c084fc",
		color: "#f5f3ff",
	},
};
const SIZE_SOURCE_BUTTON_STYLES = {
	input: {
		bg: "linear-gradient(135deg, #065f46, #16a34a)",
		hover: "linear-gradient(135deg, #16a34a, #22c55e)",
		border: "#34d399",
		color: "#ecfdf5",
		label: "原图尺寸",
		title: "当前使用输入图尺寸；多图时以面积最大的图片为尺寸基准。",
	},
	panel: {
		bg: "linear-gradient(135deg, #075985, #2563eb)",
		hover: "linear-gradient(135deg, #2563eb, #38bdf8)",
		border: "#38bdf8",
		color: "#e0f2fe",
		label: "面板尺寸",
		title: "当前使用面板宽度和高度。",
	},
	open: {
		bg: "linear-gradient(135deg, #4b5563, #64748b)",
		hover: "linear-gradient(135deg, #4b5563, #64748b)",
		border: "#94a3b8",
		color: "#ffffff",
	},
};
const REFERENCE_BROWSER_BUTTON_STYLES = {
	empty: {
		bg: "linear-gradient(135deg, #1f2933, #374151)",
		hover: "linear-gradient(135deg, #374151, #4b5563)",
		border: "#55636f",
		color: "#cbd5e1",
		title: "暂无可浏览的参考图片。",
	},
	ready: {
		bg: "linear-gradient(135deg, #0f766e, #14b8a6)",
		hover: "linear-gradient(135deg, #0d9488, #2dd4bf)",
		border: "#5eead4",
		color: "#ecfeff",
		title: "打开参考图片预览。",
	},
	disabled: {
		bg: "linear-gradient(135deg, #374151, #4b5563)",
		hover: "linear-gradient(135deg, #374151, #4b5563)",
		border: "#6b7280",
		color: "#9ca3af",
		title: "批量图片输入已连接，浏览参考图片按钮暂不可用。",
	},
};
const ALWAYS_VISIBLE_WIDGETS = new Set(["prompt"]);
const ALWAYS_HIDDEN_WIDGETS = new Set([BATCH_SOURCE_WIDGET, LORA_DATA_WIDGET_NAME, TEST_CONFIG_WIDGET_NAME, USE_INPUT_IMAGE_SIZE_WIDGET_NAME, IMAGE_RESIZE_CONFIG_WIDGET_NAME, ...MODEL_OPTIMIZATION_WIDGETS]);
const PANEL_FORCED_VISIBLE_WIDGETS = new Set([KEEP_MODEL_WIDGET_NAME, DEVICE_PREFERENCE_WIDGET_NAME, MODEL_SOURCE_WIDGET_NAME, CHECKPOINT_WIDGET_NAME]);
const STRICT_MODEL_WIDGETS = new Set(["unet_name", "clip_name1", "vae_name", CHECKPOINT_WIDGET_NAME]);
const MODEL_PANEL_WIDGETS = new Set([
	MODEL_SOURCE_WIDGET_NAME,
	CHECKPOINT_WIDGET_NAME,
	"unet_name",
	"unet_dtype",
	"clip_name1",
	"vae_name",
	DEVICE_PREFERENCE_WIDGET_NAME,
	KEEP_MODEL_WIDGET_NAME,
	...MODEL_OPTIMIZATION_WIDGETS,
]);
const OTHER_PANEL_WIDGETS = new Set([
	"main_image_index",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"grow_mask_by",
]);
const PROMPT_PANEL_WIDGETS = new Set([
	"negative_prompt",
	GLOBAL_PROMPT_WIDGET_NAME,
]);
const SIZE_PANEL_WIDGETS = new Set([
	USE_INPUT_IMAGE_SIZE_WIDGET_NAME,
	"width",
	"height",
	"batch_size",
	IMAGE_RESIZE_CONFIG_WIDGET_NAME,
]);
const PROTECTED_WIDGET_NAMES = new Set([
	EXECUTE_BUTTON_NAME,
	IMAGE_PREVIEW_NAME,
	BATCH_SOURCE_WIDGET,
	MAIN_MASK_INPUT,
	LORA_CHAIN_CONFIG_INPUT,
	LORA_DATA_WIDGET_NAME,
	KEEP_MODEL_WIDGET_NAME,
	DEVICE_PREFERENCE_WIDGET_NAME,
	TEST_CONFIG_WIDGET_NAME,
	USE_INPUT_IMAGE_SIZE_WIDGET_NAME,
	IMAGE_RESIZE_CONFIG_WIDGET_NAME,
	"prompt",
	"negative_prompt",
	"main_image_index",
	"width",
	"height",
	"batch_size",
	"unet_name",
	"unet_dtype",
	"clip_name1",
	"vae_name",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"grow_mask_by",
	MODEL_SOURCE_WIDGET_NAME,
	CHECKPOINT_WIDGET_NAME,
	...MODEL_OPTIMIZATION_WIDGETS,
	GLOBAL_PROMPT_WIDGET_NAME,
]);
const TEMPLATE_SOURCE_FIELDS = [
	{ name: "prompt", widget: "prompt", label: "提示词", type: "STRING", aliases: ["prompt", "positive", "正向", "提示词"] },
	{ name: "width", widget: "width", label: "宽度", type: "INT", aliases: ["width", "宽", "宽度"] },
	{ name: "height", widget: "height", label: "高度", type: "INT", aliases: ["height", "高", "高度"] },
];

const DEFAULT_EMPTY_OPTION = { value: "", label: "未选择" };
const DEFAULT_ROW = { enabled: true, name: "", strength: 1.0 };
const DEFAULT_FIRST_SEARCH_TERMS = "";

function clearNativePreview(node) {
	if (!node) {
		return;
	}
	suppressNativePreviewProperties(node);
	node.imgs = [];
	node.images = [];
	node.image = null;
	node.imageIndex = null;
	node.overIndex = null;
	node._imgs = [];
	node._images = [];
	node.imageRects = [];
	node.animatedImages = [];
	node.preview = null;
	node.previews = null;
	node.hideOutputImages = true;
	hideLegacyPreviewWidgets(node);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideNativeWidget(widget) {
	if (!widget) {
		return widget;
	}
	widget.type = "hidden";
	widget.hidden = true;
	widget.serialize = false;
	widget.serializeValue = () => undefined;
	widget.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0 });
	widget.computeSize = () => [0, 0];
	widget.drawWidget = () => {};
	widget.draw = () => {};
	for (const key of ["element", "inputEl", "container", "dom", "root"]) {
		const element = widget?.[key];
		if (element?.style) {
			element.style.display = "none";
		}
		if (typeof element?.remove === "function") {
			element.remove();
		}
	}
	return widget;
}

function isNativePreviewWidget(node, widget) {
	if (!widget || widget === node?.__gjjImagePreviewWidget) {
		return false;
	}
	const name = String(widget?.name || "");
	if (PROTECTED_WIDGET_NAMES.has(name) || name.startsWith(IMAGE_PREFIX)) {
		return false;
	}
	if (name === NATIVE_CANVAS_PREVIEW_WIDGET) {
		return true;
	}
	const label = String(widget?.label || "");
	const type = String(widget?.type || "");
	const optionsType = String(widget?.options?.type || "");
	const optionsName = String(widget?.options?.name || "");
	const constructorName = String(widget?.constructor?.name || "");
	const text = `${name} ${label} ${type} ${optionsType} ${optionsName} ${constructorName}`;
	if (NATIVE_PREVIEW_WIDGET_PATTERN.test(text) && !/^(number|combo|text|string|customtext|toggle|boolean|slider)$/i.test(type)) {
		return true;
	}
	for (const key of ["element", "inputEl", "container", "dom", "root"]) {
		const element = widget?.[key];
		if (typeof element?.querySelector === "function" && element.querySelector("img, canvas, video")) {
			return true;
		}
	}
	return false;
}

function hideLegacyPreviewWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return false;
	}
	let changed = false;
	for (let index = node.widgets.length - 1; index >= 0; index--) {
		const widget = node.widgets[index];
		if (!isNativePreviewWidget(node, widget)) {
			continue;
		}
		hideNativeWidget(widget);
		node.widgets.splice(index, 1);
		changed = true;
	}
	return changed;
}

function nativePreviewEmptyArray(node, key) {
	if (!node.__gjjLazyNativeEmptyArrays) {
		Object.defineProperty(node, "__gjjLazyNativeEmptyArrays", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: {},
		});
	}
	if (!Array.isArray(node.__gjjLazyNativeEmptyArrays[key])) {
		node.__gjjLazyNativeEmptyArrays[key] = [];
	}
	node.__gjjLazyNativeEmptyArrays[key].length = 0;
	return node.__gjjLazyNativeEmptyArrays[key];
}

function defineSuppressedNativePreviewProperty(node, key, emptyValue) {
	const descriptor = Object.getOwnPropertyDescriptor(node, key);
	if (descriptor?.get?.__gjjLazySuppressNativePreview) {
		return;
	}
	const getter = function () {
		return Array.isArray(emptyValue) ? nativePreviewEmptyArray(this, key) : emptyValue;
	};
	getter.__gjjLazySuppressNativePreview = true;
	try {
		Object.defineProperty(node, key, {
			configurable: true,
			enumerable: false,
			get: getter,
			set() {
				if (Array.isArray(emptyValue)) {
					nativePreviewEmptyArray(this, key);
				}
			},
		});
	} catch (_error) {
		try {
			node[key] = Array.isArray(emptyValue) ? [] : emptyValue;
		} catch (_fallbackError) {}
	}
}

function suppressNativePreviewProperties(node) {
	if (!node) {
		return;
	}
	defineSuppressedNativePreviewProperty(node, "imgs", []);
	defineSuppressedNativePreviewProperty(node, "images", []);
	defineSuppressedNativePreviewProperty(node, "_imgs", []);
	defineSuppressedNativePreviewProperty(node, "_images", []);
	defineSuppressedNativePreviewProperty(node, "imageRects", []);
	defineSuppressedNativePreviewProperty(node, "animatedImages", []);
	defineSuppressedNativePreviewProperty(node, "preview", null);
	defineSuppressedNativePreviewProperty(node, "previews", null);
	defineSuppressedNativePreviewProperty(node, "image", null);
	defineSuppressedNativePreviewProperty(node, "imageIndex", null);
	defineSuppressedNativePreviewProperty(node, "overIndex", null);
	defineSuppressedNativePreviewProperty(node, "hideOutputImages", true);
	if (node.constructor?.nodeData) {
		node.constructor.nodeData.output_preview = false;
	}
}

function scheduleNativePreviewClear(node) {
	clearNativePreview(node);
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => clearNativePreview(node));
	}
	clearInterval(node.__gjjNativePreviewClearInterval);
	node.__gjjNativePreviewClearInterval = null;
	setTimeout(() => clearNativePreview(node), 80);
}

function clearExecutedPreviewPayload(message) {
	if (!message || typeof message !== "object") {
		return;
	}
	for (const key of ["images", "imgs", "preview", "previews", "animatedImages"]) {
		if (Object.prototype.hasOwnProperty.call(message, key)) {
			message[key] = Array.isArray(message[key]) ? [] : null;
		}
	}
	for (const parent of [message.ui, message.output, message.results]) {
		if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
			continue;
		}
		for (const key of ["images", "imgs", "preview", "previews", "animatedImages"]) {
			if (Object.prototype.hasOwnProperty.call(parent, key)) {
				parent[key] = Array.isArray(parent[key]) ? [] : null;
			}
		}
	}
	if (Array.isArray(message.ui)) {
		for (const item of message.ui) {
			clearExecutedPreviewPayload(item);
		}
	}
}

const PANEL_SYNC_WIDGETS = [
	"prompt",
	"negative_prompt",
	"main_image_index",
	"width",
	"height",
	"batch_size",
	"unet_name",
	"unet_dtype",
	"clip_name1",
	"vae_name",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"grow_mask_by",
	KEEP_MODEL_WIDGET_NAME,
	USE_INPUT_IMAGE_SIZE_WIDGET_NAME,
	MODEL_SOURCE_WIDGET_NAME,
	CHECKPOINT_WIDGET_NAME,
	DEVICE_PREFERENCE_WIDGET_NAME,
	...MODEL_OPTIMIZATION_WIDGETS,
	GLOBAL_PROMPT_WIDGET_NAME,
	IMAGE_RESIZE_CONFIG_WIDGET_NAME,
];

const RESTORE_WIDGET_TYPES = {
	prompt: "text",
	negative_prompt: "text",
	main_image_index: "number",
	width: "number",
	height: "number",
	batch_size: "number",
	unet_name: "combo",
	unet_dtype: "combo",
	clip_name1: "combo",
	vae_name: "combo",
	seed: "number",
	steps: "number",
	cfg: "number",
	sampler_name: "combo",
	scheduler: "combo",
	denoise: "number",
	grow_mask_by: "number",
	[KEEP_MODEL_WIDGET_NAME]: "toggle",
	[DEVICE_PREFERENCE_WIDGET_NAME]: "combo",
	[USE_INPUT_IMAGE_SIZE_WIDGET_NAME]: "toggle",
	[MODEL_SOURCE_WIDGET_NAME]: "combo",
	[CHECKPOINT_WIDGET_NAME]: "combo",
	[ENABLE_SAGE_ATTENTION_WIDGET_NAME]: "toggle",
	[SAGE_ATTENTION_MODE_WIDGET_NAME]: "combo",
	[ALLOW_SAGE_COMPILE_WIDGET_NAME]: "toggle",
	[ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME]: "toggle",
	[FP16_ACCUMULATION_WIDGET_NAME]: "toggle",
	[MISSING_SAGE_ATTENTION_POLICY_WIDGET_NAME]: "combo",
	[GLOBAL_PROMPT_WIDGET_NAME]: "text",
	[IMAGE_RESIZE_CONFIG_WIDGET_NAME]: "text",
};
const SEED_CONTROL_KEY = "__seed_control_after_generate";
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const MAX_SEED_VALUE = 0xFFFFFFFFFFFFFFFF;
const JS_SAFE_MAX_SEED_VALUE = Number.MAX_SAFE_INTEGER;
const SEED_RANDOM_BUTTON_STYLES = {
	off: {
		bg: "linear-gradient(135deg, #1f2933, #374151)",
		hover: "linear-gradient(135deg, #374151, #4b5563)",
		border: "#55636f",
		color: "#cbd5e1",
		title: "随机种子已关闭：生成时固定当前 seed。",
	},
	on: {
		bg: "linear-gradient(135deg, #854d0e, #ca8a04)",
		hover: "linear-gradient(135deg, #ca8a04, #facc15)",
		border: "#facc15",
		color: "#fffbeb",
		title: "随机种子已开启：每次生成前自动刷新 seed。",
	},
};
const SERIALIZED_PARAM_WIDGETS = [
	"prompt",
	"negative_prompt",
	"main_image_index",
	"width",
	"height",
	"batch_size",
	"unet_name",
	"unet_dtype",
	"clip_name1",
	"vae_name",
	"seed",
	SEED_CONTROL_KEY,
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"grow_mask_by",
	BATCH_SOURCE_WIDGET,
	KEEP_MODEL_WIDGET_NAME,
	TEST_CONFIG_WIDGET_NAME,
	USE_INPUT_IMAGE_SIZE_WIDGET_NAME,
	MODEL_SOURCE_WIDGET_NAME,
	CHECKPOINT_WIDGET_NAME,
	DEVICE_PREFERENCE_WIDGET_NAME,
	...MODEL_OPTIMIZATION_WIDGETS,
	GLOBAL_PROMPT_WIDGET_NAME,
	IMAGE_RESIZE_CONFIG_WIDGET_NAME,
];
const DEFAULT_PARAM_VALUES = {
	prompt: "",
	negative_prompt: DEFAULT_NEGATIVE_PROMPT,
	main_image_index: 1,
	width: 1024,
	height: 1024,
	batch_size: 1,
	unet_name: "",
	unet_dtype: "default",
	clip_name1: "",
	vae_name: "default",
	seed: 0,
	[SEED_CONTROL_KEY]: "fixed",
	steps: 4,
	cfg: 1.0,
	sampler_name: "euler",
	scheduler: "simple",
	denoise: 1.0,
	grow_mask_by: 6,
	[BATCH_SOURCE_WIDGET]: "[]",
	[KEEP_MODEL_WIDGET_NAME]: false,
	[TEST_CONFIG_WIDGET_NAME]: "",
	[USE_INPUT_IMAGE_SIZE_WIDGET_NAME]: true,
	[MODEL_SOURCE_WIDGET_NAME]: "UNET 主模型",
	[CHECKPOINT_WIDGET_NAME]: "",
	[DEVICE_PREFERENCE_WIDGET_NAME]: "智能调度",
	[ENABLE_SAGE_ATTENTION_WIDGET_NAME]: false,
	[SAGE_ATTENTION_MODE_WIDGET_NAME]: "自动",
	[ALLOW_SAGE_COMPILE_WIDGET_NAME]: false,
	[ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME]: false,
	[FP16_ACCUMULATION_WIDGET_NAME]: true,
	[MISSING_SAGE_ATTENTION_POLICY_WIDGET_NAME]: "自动跳过SageAttention继续运行",
	[GLOBAL_PROMPT_WIDGET_NAME]: DEFAULT_GLOBAL_QUALITY_PROMPT,
	[IMAGE_RESIZE_CONFIG_WIDGET_NAME]: JSON.stringify(DEFAULT_IMAGE_RESIZE_CONFIG),
};

let MODEL_PRESETS = getCachedModelFamilyPresets();

function normalizeText(value) {
	return String(value || "").trim().toLowerCase();
}

function canonicalizeText(value) {
	return normalizeText(value).replace(/[\\/_\-.|\s]+/g, "");
}

async function ensureModelPresetsLoaded() {
	if (MODEL_PRESETS.length) {
		return MODEL_PRESETS;
	}
	MODEL_PRESETS = await getModelFamilyPresets();
	return MODEL_PRESETS;
}

function getWidget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function ensureComboOption(widget, value) {
	if (!widget || value === undefined || value === null) {
		return false;
	}
	const text = String(value ?? "").trim();
	if (!text) {
		return false;
	}
	widget.options ||= {};
	if (!Array.isArray(widget.options.values)) {
		return false;
	}
	const exists = widget.options.values.some((item) => String(item ?? "") === text);
	if (exists) {
		return false;
	}
	widget.options.values = [...widget.options.values, text];
	return true;
}

function modelOptionRank(name, value) {
	const text = canonicalizeText(value);
	if (!text) return -1;
	if (name === "unet_name") {
		if (text.includes("flux2klein") || text.includes("flux2") || text.includes("f2k")) return 100;
		if (text.includes("flux") && text.includes("klein")) return 90;
		if (text.includes("flux")) return 70;
		if (text.includes("krea") || text.includes("zimage") || text.includes("boogu")) return 60;
		return 10;
	}
	if (name === "clip_name1") {
		if (text.includes("qwen3") && text.includes("8b")) return 100;
		if (text.includes("qwen3")) return 90;
		if (text.includes("t5") || text.includes("clip")) return 50;
		return 10;
	}
	if (name === "vae_name") {
		if (text.includes("flux2") && text.includes("vae")) return 100;
		if (text === "default") return 80;
		if (text.includes("vae")) return 50;
		return 10;
	}
	if (name === CHECKPOINT_WIDGET_NAME) {
		return 10;
	}
	return 0;
}

function pickAvailableModelValue(node, name, desired = "") {
	const options = optionValues(node, name).filter((item) => item !== "");
	const wanted = String(desired || "").trim();
	if (wanted && options.includes(wanted)) {
		return wanted;
	}
	const ranked = options
		.map((value, index) => ({ value, index, score: modelOptionRank(name, value) }))
		.sort((left, right) => right.score - left.score || left.index - right.index);
	return ranked[0]?.value || wanted || "";
}

function normalizeStrictModelParam(node, name, value) {
	const text = String(value ?? "").trim();
	if (!STRICT_MODEL_WIDGETS.has(name)) {
		return value;
	}
	if (!text && name === CHECKPOINT_WIDGET_NAME) {
		return "";
	}
	return pickAvailableModelValue(node, name, text);
}

function getWidgetIndex(node, name) {
	return Array.isArray(node?.widgets)
		? node.widgets.findIndex((widget) => widget?.name === name)
		: -1;
}

function getInput(node, name) {
	return GJJ_Utils.getInput(node, name);
}

function widgetValue(node, name) {
	return String(getWidget(node, name)?.value || "").trim();
}

function inputLinked(node, name) {
	return Boolean(getInput(node, name)?.link != null);
}

function inputSlotIndex(node, name) {
	return Array.isArray(node?.inputs)
		? node.inputs.findIndex((input) => input?.name === name)
		: -1;
}

function graphLinkById(linkId) {
	if (linkId == null) {
		return null;
	}
	const links = app.graph?.links;
	if (!links) {
		return null;
	}
	if (links[linkId]) {
		return links[linkId];
	}
	if (Array.isArray(links)) {
		return links.find((link) => String(link?.id) === String(linkId)) || null;
	}
	return null;
}

function batchImageLinkMemory(node) {
	const memory = node?.properties?.[BATCH_IMAGE_LINK_MEMORY_PROPERTY];
	return memory && typeof memory === "object" ? memory : null;
}

function linkedInputMemories(node) {
	const memories = [];
	const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
	for (let slot = 0; slot < inputs.length; slot += 1) {
		const input = inputs[slot];
		const link = graphLinkById(input?.link);
		if (!link) {
			continue;
		}
		memories.push({
			target_name: String(input?.name || ""),
			target_type: String(input?.type || ""),
			target_slot: slot,
			origin_id: Number(link.origin_id),
			origin_slot: Number(link.origin_slot),
		});
	}
	return memories;
}

function normalizedInputLinkMemory(node) {
	const memory = batchImageLinkMemory(node);
	if (!memory) {
		return [];
	}
	if (Array.isArray(memory.links)) {
		return memory.links.filter((item) => item && typeof item === "object");
	}
	if (Number.isFinite(Number(memory.origin_id)) && Number.isFinite(Number(memory.origin_slot))) {
		return [{
			target_name: PRIMARY_IMAGE_INPUT,
			target_type: BATCH_IMAGE_TYPE,
			target_slot: Number(memory.target_slot || inputSlotIndex(node, PRIMARY_IMAGE_INPUT) || 0),
			origin_id: Number(memory.origin_id),
			origin_slot: Number(memory.origin_slot),
		}];
	}
	return [];
}

function rememberBatchImageLink(node) {
	const links = linkedInputMemories(node);
	if (!node || !links.length) {
		return null;
	}
	const memory = {
		version: 2,
		links,
	};
	node.properties = node.properties || {};
	node.properties[BATCH_IMAGE_LINK_MEMORY_PROPERTY] = memory;
	return memory;
}

function hasAnyExternalInputLink(node) {
	return linkedInputMemories(node).length > 0;
}

function inputSlotForMemory(node, item) {
	const wantedName = String(item?.target_name || "");
	if (wantedName === PRIMARY_IMAGE_INPUT && !getInput(node, PRIMARY_IMAGE_INPUT)) {
		addImageInput(node);
	} else if (wantedName.startsWith(IMAGE_PREFIX) && !getInput(node, wantedName)) {
		node.addInput?.(wantedName, String(item?.target_type || BATCH_IMAGE_TYPE));
	}
	let slot = wantedName ? inputSlotIndex(node, wantedName) : -1;
	if (slot >= 0) {
		return slot;
	}
	const fallbackSlot = Number(item?.target_slot);
	if (Number.isFinite(fallbackSlot) && node?.inputs?.[fallbackSlot]) {
		return fallbackSlot;
	}
	return -1;
}

function setBatchLinkButtonState(node) {
	const button = node?.__gjjBatchImageLinkButton;
	if (!button) {
		return;
	}
	const linked = hasAnyExternalInputLink(node);
	const memory = normalizedInputLinkMemory(node);
	button.style.display = linked || memory.length ? "flex" : "none";
	button.textContent = "🔗";
	button.title = linked
		? "断开所有外部输入链接，并把来源接口记录到本节点。"
		: "恢复上次断开的所有外部输入链接。";
	button.style.borderColor = linked ? "#38bdf8" : "#f59e0b";
	const background = linked
		? "linear-gradient(135deg, #075985, #0284c7)"
		: "linear-gradient(135deg, #4a2f08, #b45309)";
	const hoverBackground = linked
		? "linear-gradient(135deg, #0284c7, #38bdf8)"
		: "linear-gradient(135deg, #b45309, #d97706)";
	button.style.background = background;
	button.__gjjLazyDefaultBg = background;
	button.__gjjLazyHoverBg = hoverBackground;
}

function parseReferenceImageSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed.filter((item) => item?.filename) : [];
	} catch (_) {
		return [];
	}
}

function referenceImageViewUrl(item) {
	if (item?.url) {
		const url = String(item.url);
		if (/^(?:https?:|blob:|data:)/i.test(url)) {
			return url;
		}
	}
	const filename = String(item?.filename || "").trim();
	if (!filename) {
		return "";
	}
	const type = String(item?.type || "input");
	const subfolder = String(item?.subfolder || "");
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const path = `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}${previewFormat}`;
	return api?.apiURL ? api.apiURL(path) : path;
}

function splitReferenceInputPath(value) {
	let text = String(value || "").trim().replace(/\\/g, "/");
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	const type = annotated ? annotated[1].toLowerCase() : "input";
	if (annotated) {
		text = text.slice(0, annotated.index).trim();
	}
	if (!text) {
		return null;
	}
	const parts = text.split("/").filter(Boolean);
	if (["input", "output", "temp"].includes(String(parts[0] || "").toLowerCase())) {
		parts.shift();
	}
	const filename = parts.pop() || "";
	if (!filename) {
		return null;
	}
	return { filename, subfolder: parts.join("/"), type };
}

function sourceNodeImageWidgetItem(sourceNode) {
	const widgets = Array.isArray(sourceNode?.widgets) ? sourceNode.widgets : [];
	const preferred = widgets.find((widget) => ["image", "filename"].includes(String(widget?.name || "").toLowerCase()));
	const fallback = widgets.find((widget) => {
		const name = String(widget?.name || "").toLowerCase();
		const value = String(widget?.value || "");
		return /(?:image|filename|file|图片|图像)/i.test(name) && /\.(?:png|jpe?g|webp|bmp|gif|avif|tiff?)(?:\s+\[(?:input|output|temp)\])?$/i.test(value);
	});
	return splitReferenceInputPath((preferred || fallback)?.value);
}

function linkedReferenceImageUrls(node) {
	const urls = [];
	for (const input of getImageInputs(node)) {
		if (String(input?.name || "") === PRIMARY_IMAGE_INPUT || input?.link == null) {
			continue;
		}
		const link = graphLinkById(input.link);
		const sourceNode = link?.origin_id != null ? app.graph?.getNodeById?.(Number(link.origin_id)) : null;
		let item = null;
		if (sourceNode?.comfyClass === "GJJ_MultiImageLoader") {
			const raw = String(getWidget(sourceNode, "selected_images")?.value || sourceNode.properties?.selected_images || "[]");
			const selection = parseReferenceImageSelection(raw);
			const sourceIndex = Math.max(0, Number(link.origin_slot || 1) - 1);
			item = selection[sourceIndex];
		} else {
			item = sourceNodeImageWidgetItem(sourceNode);
		}
		const url = referenceImageViewUrl(item);
		if (url) {
			urls.push(url);
		}
	}
	return urls;
}

function storedReferenceImageUrls(node) {
	const widgetValue = getWidget(node, BATCH_SOURCE_WIDGET)?.value;
	const raw = widgetValue || node?.properties?.[BATCH_SOURCE_WIDGET] || "";
	return parseReferenceImageSelection(raw).map(referenceImageViewUrl).filter(Boolean);
}

function referenceBrowserUrls(node) {
	return [...storedReferenceImageUrls(node), ...linkedReferenceImageUrls(node)];
}

function primaryBatchImageLinked(node) {
	return Boolean(getInput(node, PRIMARY_IMAGE_INPUT)?.link != null);
}

function applyReferenceBrowserButtonState(node) {
	const button = node?.__gjjReferenceBrowserButton;
	if (!button) {
		return;
	}
	const disabledByBatchLink = primaryBatchImageLinked(node);
	const urls = disabledByBatchLink ? [] : referenceBrowserUrls(node);
	const hasReference = urls.length > 0;
	const style = disabledByBatchLink
		? REFERENCE_BROWSER_BUTTON_STYLES.disabled
		: (hasReference ? REFERENCE_BROWSER_BUTTON_STYLES.ready : REFERENCE_BROWSER_BUTTON_STYLES.empty);
	button.textContent = "📂";
	button.disabled = disabledByBatchLink;
	button.style.opacity = button.disabled ? "0.55" : "1";
	button.style.cursor = button.disabled ? "not-allowed" : "pointer";
	button.style.borderColor = style.border;
	button.style.background = style.bg;
	button.style.color = style.color;
	button.__gjjLazyDefaultBg = style.bg;
	button.__gjjLazyHoverBg = style.hover;
	button.__gjjReferenceBrowserUrls = urls;
	button.title = disabledByBatchLink
		? style.title
		: (hasReference
			? `点击重新选择本地参考图片。\n当前共 ${urls.length} 张。`
			: "选择本地参考图片；支持一次选择多张。");
	button.setAttribute("aria-disabled", button.disabled ? "true" : "false");
}

function applyInputSizeButtonState(node) {
	const button = node?.__gjjInputSizeButton;
	if (!button) {
		return;
	}
	const open = sizeSettingsOpen(node);
	const enabled = inputSizeSyncEnabled(node);
	const resizeConfig = readImageResizeConfig(node);
	const sourceStyle = enabled ? SIZE_SOURCE_BUTTON_STYLES.input : SIZE_SOURCE_BUTTON_STYLES.panel;
	button.style.display = "flex";
	button.textContent = "📐";
	button.title = [
		open ? "关闭尺寸浮动窗口。" : "打开尺寸浮动窗口。",
		`尺寸来源：${sourceStyle.label}。`,
		`尺寸模式：${resizeConfig.mode}；适配：${resizeConfig.fit_mode}${imageResizePositionRelevant(resizeConfig) ? `；位置：${resizeConfig.crop_position}` : ""}。`,
		sourceStyle.title,
	].join("\n");
	button.classList.toggle("on", open);
	button.setAttribute("aria-pressed", enabled ? "true" : "false");
	button.style.borderColor = open ? SIZE_SOURCE_BUTTON_STYLES.open.border : sourceStyle.border;
	button.style.color = open ? SIZE_SOURCE_BUTTON_STYLES.open.color : sourceStyle.color;
	const background = open ? SIZE_SOURCE_BUTTON_STYLES.open.bg : sourceStyle.bg;
	const hoverBackground = open ? SIZE_SOURCE_BUTTON_STYLES.open.hover : sourceStyle.hover;
	button.style.background = background;
	button.__gjjLazyDefaultBg = background;
	button.__gjjLazyHoverBg = hoverBackground;
}

function toggleBatchImageExternalLink(node) {
	if (hasAnyExternalInputLink(node)) {
		syncBatchSourceWidget(node);
		const memory = rememberBatchImageLink(node);
		if (!memory) {
			return false;
		}
		const slots = linkedInputMemories(node)
			.map((item) => Number(item.target_slot))
			.filter((slot) => Number.isFinite(slot))
			.sort((a, b) => b - a);
		for (const slot of slots) {
			node.disconnectInput?.(slot);
		}
	} else {
		const memory = normalizedInputLinkMemory(node);
		if (!memory.length) {
			return false;
		}
		const remaining = [];
		for (const item of memory) {
			const origin = app.graph?.getNodeById?.(Number(item.origin_id));
			const slot = inputSlotForMemory(node, item);
			if (!origin || !Number.isFinite(Number(item.origin_slot)) || slot < 0) {
				remaining.push(item);
				continue;
			}
			origin.connect?.(Number(item.origin_slot), node, slot);
		}
		if (remaining.length) {
			node.properties[BATCH_IMAGE_LINK_MEMORY_PROPERTY] = { version: 2, links: remaining };
		} else {
			delete node.properties[BATCH_IMAGE_LINK_MEMORY_PROPERTY];
		}
		syncBatchSourceWidget(node);
	}
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
	setBatchLinkButtonState(node);
	applyReferenceBrowserButtonState(node);
	applyInputSizeButtonState(node);
	return true;
}

function installModelHelpProvider(node) {
	if (!node || node.__gjjLazyModelHelpProviderInstalled) {
		return;
	}
	node.__gjjLazyModelHelpProviderInstalled = true;
	node.__gjjHelpModelTreeEntries = function () {
		const entries = [];
		const useCheckpoint = widgetValue(this, MODEL_SOURCE_WIDGET_NAME) === CHECKPOINT_MODEL_SOURCE_VALUE;
		const pushWidgetModel = (name, label, folder, kind, tooltip) => {
			const value = widgetValue(this, name);
			if (!value) {
				return;
			}
			entries.push({ label, value, folder, kind, name, tooltip });
		};
		if (useCheckpoint) {
			pushWidgetModel(
				CHECKPOINT_WIDGET_NAME,
				"🎨 底模模型",
				"checkpoints",
				"checkpoint_model",
				"调用方法：节点内部走 ComfyUI CheckpointLoaderSimple 加载底模，并拆出 MODEL / CLIP / VAE。"
			);
		} else {
			pushWidgetModel(
				"unet_name",
				"🟣 UNET 主模型",
				"diffusion_models",
				"diffusion",
				"调用方法：节点内部按当前模型族加载 UNET，并自动匹配采样、编码器、VAE 与推荐 LoRA。"
			);
			pushWidgetModel(
				"clip_name1",
				"🟡 CLIP 编码器",
				"text_encoders",
				"clip",
				"调用方法：作为当前模型族的文本编码器；固定配套模型族会由节点内部自动匹配。"
			);
			pushWidgetModel(
				"vae_name",
				"🔴 VAE 解码器",
				"vae",
				"vae",
				"调用方法：节点内部加载 VAE，将采样 latent 解码为最终 IMAGE。"
			);
		}
		const rows = ensureLoraNodeState(this).rows || [];
		rows.forEach((row, index) => {
			const name = String(row?.name || "").trim();
			if (!name) {
				return;
			}
			entries.push({
				label: `🧩 内置 LoRA ${index + 1}`,
				value: name,
				folder: "loras",
				kind: "loras",
				name: `lora_${index + 1}`,
				tooltip: `调用方法：节点内置 LoRA 行，执行时按当前启用状态应用；强度 ${formatStrength(row.strength, 1.0)}。`,
			});
		});
		if (inputLinked(this, LORA_CHAIN_CONFIG_INPUT)) {
			entries.push({
				label: "🔗 外部 LoRA串联配置",
				value: "已连接外部输入",
				folder: "loras",
				kind: "loras",
				name: LORA_CHAIN_CONFIG_INPUT,
				tooltip: "调用方法：执行时读取外部 GJJ · LoRA串联配置，并优先/合并到当前 LoRA 应用流程。",
			});
		}
		entries.push({
			label: "🧠 Opus-MT 中英翻译模型",
			value: "opus-mt-zh-en.safetensors",
			folder: "translation",
			kind: "translation",
			name: "opus-mt-zh-en",
			tooltip: "调用方法：提示词翻译功能从 models/translation/opus-mt-zh-en.safetensors 加载本地翻译模型。",
		});
		return entries;
	};
}

function setWidgetValue(widget, value) {
	if (!widget || value === undefined || value === null) {
		return;
	}
	ensureComboOption(widget, value);
	widget.value = value;
	if (widget.inputEl) {
		widget.inputEl.value = String(value);
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = value;
	}
	widget.callback?.(value);
}

function splitLazyPromptQueueSegments(value) {
	const text = String(value ?? "");
	if (!text.includes("---")) {
		return [text];
	}
	let segments = text
		.split(/(?:^|\n)\s*---+\s*(?:\n|$)/g)
		.map((item) => item.trim())
		.filter(Boolean);
	if (segments.length <= 1) {
		segments = text.split("---").map((item) => item.trim()).filter(Boolean);
	}
	return segments.length > 1 ? segments : [text];
}

function commitPromptTranslation(node, values) {
	for (const [name, value] of Object.entries(values || {})) {
		setWidgetValue(getWidget(node, name), value);
	}
	const params = currentParamValues(node);
	saveParamSnapshot(node, params);
	node.widgets_values = serializedParamValues(params, node).slice();
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function upstreamPromptTranslationValues(values) {
	const result = {};
	if (Object.prototype.hasOwnProperty.call(values || {}, "prompt")) {
		result.prompt = String(values.prompt ?? "");
	}
	if (Object.prototype.hasOwnProperty.call(values || {}, "negative_prompt")) {
		result.negative_prompt = String(values.negative_prompt ?? "");
	}
	return result;
}

function linkedPromptTranslationValues(node) {
	const values = {};
	for (const widgetName of ["prompt", "negative_prompt"]) {
		const input = getLinkedWidgetInput(node, widgetName);
		if (!input?.link || !app.graph?.links) {
			continue;
		}
		const value = inferExternalOutputValue(app.graph.links[input.link], widgetName);
		if (value !== undefined && value !== null && String(value) !== "") {
			values[widgetName] = value;
		}
	}
	return values;
}

function hasLinkedPromptTranslationInput(node) {
	return Boolean(getLinkedWidgetInput(node, "prompt") || getLinkedWidgetInput(node, "negative_prompt"));
}

function upstreamPromptTranslationSignature(values) {
	const parts = [];
	for (const name of ["prompt", "negative_prompt"]) {
		if (Object.prototype.hasOwnProperty.call(values || {}, name)) {
			parts.push([name, String(values[name] ?? "")]);
		}
	}
	return parts.length ? JSON.stringify(parts) : "";
}

async function translateLazyPromptValues(node, options = {}) {
	if (node.__gjjLazyTranslating) {
		return { ok: false, busy: true };
	}
	const commitPrompt = options.commitPrompt !== false;
	const commitNegative = options.commitNegative !== false;
	const positive = String(options.positive ?? getWidget(node, "prompt")?.value ?? "");
	const negative = String(options.negative ?? getWidget(node, "negative_prompt")?.value ?? "");
	if (!positive.trim() && !negative.trim()) {
		flashLazyTranslateButton(node, null, options.emptyTitle || "没有需要翻译的提示词", 1200);
		return { ok: true, skipped: true };
	}

	clearTimeout(node.__gjjLazyTranslateFlashTimer);
	node.__gjjLazyTranslating = true;
	applyLazyTranslateButtonState(node);
	let flash = null;
	try {
		const data = await requestPromptTranslation({
			node,
			positive,
			negative,
			device: "auto",
			maxLength: 512,
			batchSize: 8,
			unloadAfterUse: false,
			nodeName: "GJJ · 🖼️ 懒人图文集成一键生图",
		});
		const translated = {};
		if (commitPrompt) {
			translated.prompt = String(data?.positive ?? positive);
		}
		if (commitNegative) {
			translated.negative_prompt = String(data?.negative ?? negative);
		}
		commitPromptTranslation(node, translated);
		if (options.upstreamSignature) {
			node.__gjjLazyLastUpstreamTranslation = {
				signature: options.upstreamSignature,
				values: { ...translated },
			};
			node.__gjjLazyPendingUpstreamTranslationSignature = "";
		}
		flash = { mode: null, title: options.successTitle || "提示词翻译完成" };
		return { ok: true, values: translated };
	} catch (error) {
		console.error("[GJJ LazyImageStudio] 翻译失败", error);
		flash = { mode: "error", title: `翻译失败：${error?.message || error}` };
		return { ok: false, error };
	} finally {
		node.__gjjLazyTranslating = false;
		if (flash) {
			flashLazyTranslateButton(node, flash.mode, flash.title, 1600);
		} else {
			applyLazyTranslateButtonState(node);
		}
	}
}

function scheduleUpstreamPromptTranslation(node, values, signature, ms = 180) {
	if (!translationEnabled(node) || !signature || node.__gjjLazyTranslating) {
		return;
	}
	if (
		signature === node.__gjjLazyPendingUpstreamTranslationSignature
		|| signature === node.__gjjLazyLastUpstreamTranslation?.signature
	) {
		return;
	}
	node.__gjjLazyPendingUpstreamTranslationSignature = signature;
	clearTimeout(node.__gjjLazyUpstreamTranslateTimer);
	node.__gjjLazyUpstreamTranslateTimer = setTimeout(() => {
		void translateLazyPromptValues(node, {
			positive: Object.prototype.hasOwnProperty.call(values, "prompt") ? values.prompt : "",
			negative: Object.prototype.hasOwnProperty.call(values, "negative_prompt") ? values.negative_prompt : "",
			commitPrompt: Object.prototype.hasOwnProperty.call(values, "prompt"),
			commitNegative: Object.prototype.hasOwnProperty.call(values, "negative_prompt"),
			upstreamSignature: signature,
			successTitle: "上游提示词已翻译",
			emptyTitle: "上游提示词为空",
		});
	}, ms);
}

function updateUpstreamTranslationWatcher(node, active) {
	if (!active) {
		clearInterval(node.__gjjLazyUpstreamTranslateWatchTimer);
		node.__gjjLazyUpstreamTranslateWatchTimer = null;
		node.__gjjLazyPendingUpstreamTranslationSignature = "";
		return;
	}
	if (node.__gjjLazyUpstreamTranslateWatchTimer) {
		return;
	}
	node.__gjjLazyUpstreamTranslateWatchTimer = setInterval(() => {
		const exists = app.graph?._nodes?.includes(node);
		if (!exists || !translationEnabled(node) || !hasLinkedPromptTranslationInput(node)) {
			updateUpstreamTranslationWatcher(node, false);
			return;
		}
		syncPanelFromLinkedSources(node);
	}, 900);
}

function setWidgetEnabled(widget, enabled) {
	if (!widget) {
		return;
	}
	widget.disabled = !enabled;
	if (widget.__gjjLazyVisibilityState) {
		widget.__gjjLazyVisibilityState.disabled = !enabled;
	}
	if (widget.options) {
		widget.options.disabled = !enabled;
	}
	const opacity = enabled ? "1" : "0.45";
	if (widget.inputEl) {
		widget.inputEl.disabled = !enabled;
		widget.inputEl.style.opacity = opacity;
	}
	if (widget.element && "disabled" in widget.element) {
		widget.element.disabled = !enabled;
		widget.element.style.opacity = opacity;
	}
}

function settingsOpen(node) {
	return Boolean(node?.properties?.[SETTINGS_OPEN_PROPERTY]);
}

function modelSettingsOpen(node) {
	return Boolean(node?.properties?.[MODEL_SETTINGS_OPEN_PROPERTY]);
}

function sizeSettingsOpen(node) {
	return Boolean(node?.properties?.[SIZE_SETTINGS_OPEN_PROPERTY]);
}

function promptSettingsOpen(node) {
	return Boolean(node?.properties?.[PROMPT_SETTINGS_OPEN_PROPERTY]);
}

function translationEnabled(node) {
	return Boolean(node?.properties?.[TRANSLATE_ENABLED_PROPERTY]);
}

function boolValue(value) {
	if (typeof value === "boolean") return value;
	const text = String(value ?? "").trim().toLowerCase();
	return ["true", "1", "yes", "on", "启用", "开启"].includes(text);
}

function normalizeImageResizeConfig(value) {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed || "{}");
		} catch {
			parsed = {};
		}
	}
	const config = {
		...DEFAULT_IMAGE_RESIZE_CONFIG,
		...(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
	};
	if (!IMAGE_RESIZE_MODES.includes(config.mode)) config.mode = DEFAULT_IMAGE_RESIZE_CONFIG.mode;
	if (!IMAGE_FIT_MODES.includes(config.fit_mode)) config.fit_mode = DEFAULT_IMAGE_RESIZE_CONFIG.fit_mode;
	if (!IMAGE_CROP_POSITIONS.includes(config.crop_position)) config.crop_position = DEFAULT_IMAGE_RESIZE_CONFIG.crop_position;
	config.scale_percent = Math.max(0.1, Math.min(10000, Number(config.scale_percent) || DEFAULT_IMAGE_RESIZE_CONFIG.scale_percent));
	config.long_side_length = Math.max(8, Math.min(16384, Math.round(Number(config.long_side_length) || DEFAULT_IMAGE_RESIZE_CONFIG.long_side_length)));
	config.total_pixel_k = Math.max(1, Math.min(1000000, Math.round(Number(config.total_pixel_k) || DEFAULT_IMAGE_RESIZE_CONFIG.total_pixel_k)));
	return config;
}

function imageResizePositionRelevant(config) {
	const normalized = normalizeImageResizeConfig(config);
	return normalized.fit_mode !== "拉伸" && !["等比", "长边"].includes(normalized.mode);
}

function readImageResizeConfig(node) {
	const widgetValue = getWidget(node, IMAGE_RESIZE_CONFIG_WIDGET_NAME)?.value;
	const storedValue = node?.properties?.[PARAM_VALUES_PROPERTY]?.[IMAGE_RESIZE_CONFIG_WIDGET_NAME];
	return normalizeImageResizeConfig(
		widgetValue !== undefined && widgetValue !== null && String(widgetValue).trim()
			? widgetValue
			: storedValue,
	);
}

function writeImageResizeConfig(node, patch = {}, rerender = true) {
	if (!node) return;
	const config = normalizeImageResizeConfig({ ...readImageResizeConfig(node), ...patch });
	const serialized = JSON.stringify(config);
	setWidgetValue(getWidget(node, IMAGE_RESIZE_CONFIG_WIDGET_NAME), serialized);
	node.properties ||= {};
	node.properties[PARAM_VALUES_PROPERTY] = {
		...(node.properties[PARAM_VALUES_PROPERTY] || {}),
		[IMAGE_RESIZE_CONFIG_WIDGET_NAME]: serialized,
	};
	writeLiveParamSnapshot(node);
	applyInputSizeButtonState(node);
	if (rerender) syncFloatingPanels(node);
}

function inputSizeSyncEnabled(node) {
	const widget = getWidget(node, USE_INPUT_IMAGE_SIZE_WIDGET_NAME);
	if (!widget) {
		return true;
	}
	return boolValue(widget.value);
}

function setInputSizeSyncEnabled(node, enabled) {
	if (!node) return;
	const value = Boolean(enabled);
	setWidgetValue(getWidget(node, USE_INPUT_IMAGE_SIZE_WIDGET_NAME), value);
	node.properties = node.properties || {};
	node.properties[PARAM_VALUES_PROPERTY] = {
		...(node.properties[PARAM_VALUES_PROPERTY] || {}),
		[USE_INPUT_IMAGE_SIZE_WIDGET_NAME]: value,
	};
	const widget = getWidget(node, USE_INPUT_IMAGE_SIZE_WIDGET_NAME);
	if (widget) {
		widget.value = value;
		const index = getWidgetIndex(node, USE_INPUT_IMAGE_SIZE_WIDGET_NAME);
		if (Array.isArray(node.widgets_values) && index >= 0) {
			node.widgets_values[index] = value;
		}
		try { widget.callback?.(value); } catch (_) {}
	}
	if (!value) {
		delete node.properties[IMAGE_SIZE_SIGNATURE_PROPERTY];
	}
	applySizeDimensionAvailability(node);
	applyInputSizeButtonState(node);
	if (value) {
		void syncSizeFromPrimaryInput(node);
	}
	node.graph?.change?.();
	app.graph?.setDirtyCanvas?.(true, true);
}

function applySizeDimensionAvailability(node) {
	const enabled = !inputSizeSyncEnabled(node);
	for (const name of ["width", "height"]) {
		setWidgetEnabled(getWidget(node, name), enabled);
	}
}

function seedRandomEnabled(node) {
	return fallbackParamValue(node, SEED_CONTROL_KEY) === "randomize";
}

function applySeedRandomButtonState(node) {
	const button = node?.__gjjSeedRandomButton;
	if (!button) return;
	const enabled = seedRandomEnabled(node);
	const style = enabled ? SEED_RANDOM_BUTTON_STYLES.on : SEED_RANDOM_BUTTON_STYLES.off;
	button.textContent = "🎲";
	button.dataset.value = enabled ? "true" : "false";
	button.setAttribute("aria-pressed", enabled ? "true" : "false");
	button.title = style.title;
	button.style.background = style.bg;
	button.style.borderColor = style.border;
	button.style.color = style.color;
	button.__gjjLazyDefaultBg = style.bg;
	button.__gjjLazyHoverBg = style.hover;
}

function setSeedRandomEnabled(node, enabled) {
	if (!node) return;
	const mode = enabled ? "randomize" : "fixed";
	const seedWidget = getWidget(node, "seed");
	const nextSeed = randomSeedValue();
	if (seedWidget) {
		setWidgetValue(seedWidget, nextSeed);
	}
	const seedControlWidget = findSeedControlWidget(node);
	if (seedControlWidget) {
		setWidgetValue(seedControlWidget, mode);
	}
	const params = currentParamValues(node);
	params.seed = nextSeed;
	params[SEED_CONTROL_KEY] = mode;
	saveParamSnapshot(node, params);
	node.widgets_values = serializedParamValues(params, node).slice();
	delete node.__gjjLazySeedPreparedAt;
	applySeedRandomButtonState(node);
	node.graph?.change?.();
	app.graph?.setDirtyCanvas?.(true, true);
}

function keepModelEnabled(node) {
	const widget = getWidget(node, KEEP_MODEL_WIDGET_NAME);
	if (widget) return boolValue(widget.value);
	const params = node?.properties?.[PARAM_VALUES_PROPERTY] || {};
	return boolValue(params[KEEP_MODEL_WIDGET_NAME]);
}

function setKeepModelEnabled(node, enabled) {
	if (!node) return;
	const value = Boolean(enabled);
	node.properties = node.properties || {};
	node.properties[PARAM_VALUES_PROPERTY] = {
		...(node.properties[PARAM_VALUES_PROPERTY] || {}),
		[KEEP_MODEL_WIDGET_NAME]: value,
	};
	const widget = getWidget(node, KEEP_MODEL_WIDGET_NAME);
	if (widget) {
		widget.value = value;
		const index = getWidgetIndex(node, KEEP_MODEL_WIDGET_NAME);
		if (Array.isArray(node.widgets_values) && index >= 0) {
			node.widgets_values[index] = value;
		}
		try { widget.callback?.(value); } catch (_) {}
	}
	applyKeepModelButtonState(node);
	updateModelSettingsButtonState(node);
	updateSettingsButtonState(node);
	node.graph?.change?.();
	app.graph?.setDirtyCanvas?.(true, true);
}

function applyKeepModelButtonState(node) {
	const button = node?.__gjjKeepModelButton;
	if (!button) return;
	const enabled = keepModelEnabled(node);
	const style = enabled ? KEEP_MODEL_BUTTON_STYLES.on : KEEP_MODEL_BUTTON_STYLES.off;
	button.textContent = "📌";
	button.dataset.value = enabled ? "true" : "false";
	button.setAttribute("aria-pressed", enabled ? "true" : "false");
	button.title = style.title;
	button.style.background = style.bg;
	button.style.borderColor = style.border;
	button.style.color = style.color;
	button.__gjjLazyDefaultBg = style.bg;
	button.__gjjLazyHoverBg = style.hover;
}

function setTranslationEnabled(node, enabled) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	node.properties[TRANSLATE_ENABLED_PROPERTY] = Boolean(enabled);
	if (!enabled) {
		clearTimeout(node.__gjjLazyUpstreamTranslateTimer);
		node.__gjjLazyPendingUpstreamTranslationSignature = "";
		node.__gjjLazyLastUpstreamTranslation = null;
		updateUpstreamTranslationWatcher(node, false);
	} else {
		updateUpstreamTranslationWatcher(node, hasLinkedPromptTranslationInput(node));
	}
	applyLazyTranslateButtonState(node);
	node.graph?.change?.();
}

function applyLazyTranslateButtonState(node, override = {}) {
	const button = node?.__gjjLazyTranslateButton;
	if (!button) {
		return;
	}
	const enabled = translationEnabled(node);
	const mode = override.mode || (node.__gjjLazyTranslating ? "busy" : enabled ? "on" : "off");
	const style = TRANSLATE_BUTTON_STYLES[mode] || TRANSLATE_BUTTON_STYLES.off;
	button.textContent = "🌏";
	button.dataset.value = enabled ? "true" : "false";
	button.setAttribute("aria-pressed", enabled ? "true" : "false");
	button.title = override.title || style.title || (enabled ? TRANSLATE_BUTTON_STYLES.on.title : TRANSLATE_BUTTON_STYLES.off.title);
	button.disabled = Boolean(node.__gjjLazyTranslating);
	button.style.background = style.bg;
	button.style.borderColor = style.border;
	button.style.color = style.color;
	button.style.opacity = node.__gjjLazyTranslating ? "0.7" : "1";
	button.__gjjLazyDefaultBg = style.bg;
	button.__gjjLazyHoverBg = style.hover;
}

function flashLazyTranslateButton(node, mode, title, ms = 1500) {
	applyLazyTranslateButtonState(node, { mode, title });
	clearTimeout(node.__gjjLazyTranslateFlashTimer);
	node.__gjjLazyTranslateFlashTimer = setTimeout(() => applyLazyTranslateButtonState(node), ms);
}

function rememberWidgetState(widget) {
	if (!widget || widget.__gjjLazyVisibilityState) {
		return;
	}
	widget.options = widget.options || {};
	widget.__gjjLazyVisibilityState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		label: widget.label,
		localized_name: widget.localized_name,
		optionsHidden: widget.options.hidden,
		optionsDisplay: widget.options.display,
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
		widgetDisplay: widget.widget?.style?.display || "",
	};
}

function setLazyWidgetHidden(widget, hidden) {
	if (!widget) {
		return;
	}
	rememberWidgetState(widget);
	widget.options = widget.options || {};
	const state = widget.__gjjLazyVisibilityState || {};
	if (hidden) {
		widget.hidden = true;
		widget.disabled = true;
		widget.type = "hidden";
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.computeSize = () => [0, -4];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.label = "";
		widget.localized_name = "";
		widget.last_y = 0;
		widget.computedHeight = 0;
		widget.margin_top = 0;
		if (widget.element) widget.element.style.display = "none";
		if (widget.inputEl) widget.inputEl.style.display = "none";
		if (widget.widget) widget.widget.style.display = "none";
		return;
	}

	widget.hidden = Boolean(state.hidden);
	widget.disabled = PANEL_FORCED_VISIBLE_WIDGETS.has(widget.name) ? false : Boolean(state.disabled);
	if (PANEL_FORCED_VISIBLE_WIDGETS.has(widget.name)) {
		widget.hidden = false;
	}
	widget.type = state.type && state.type !== "hidden" ? state.type : (RESTORE_WIDGET_TYPES[widget.name] || state.type || "text");
	if (state.computeSize) widget.computeSize = state.computeSize;
	else delete widget.computeSize;
	if (state.getHeight) widget.getHeight = state.getHeight;
	else delete widget.getHeight;
	if (state.draw) widget.draw = state.draw;
	else delete widget.draw;
	if (state.mouse) widget.mouse = state.mouse;
	else delete widget.mouse;
	widget.label = state.label ?? widget.label;
	widget.localized_name = state.localized_name ?? widget.localized_name;
	if (PANEL_FORCED_VISIBLE_WIDGETS.has(widget.name)) {
		delete widget.options.hidden;
		delete widget.options.display;
	} else {
		if (state.optionsHidden === undefined) delete widget.options.hidden;
		else widget.options.hidden = state.optionsHidden;
		if (state.optionsDisplay === undefined) delete widget.options.display;
		else widget.options.display = state.optionsDisplay;
	}
	if (PANEL_FORCED_VISIBLE_WIDGETS.has(widget.name)) {
		if (widget.element) widget.element.style.display = "";
		if (widget.inputEl) widget.inputEl.style.display = "";
		if (widget.widget) widget.widget.style.display = "";
	} else {
		if (widget.element) widget.element.style.display = state.elementDisplay || "";
		if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
		if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
	}
}

function rememberDomWidgetState(widget) {
	if (!widget || widget.__gjjLazyDomVisibilityState) {
		return;
	}
	widget.__gjjLazyDomVisibilityState = {
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		elementDisplay: widget.element?.style?.display || "",
	};
}

function setDomWidgetHidden(widget, element, hidden) {
	if (!widget) {
		if (element) element.style.display = hidden ? "none" : "";
		return;
	}
	rememberDomWidgetState(widget);
	const state = widget.__gjjLazyDomVisibilityState || {};
	widget.hidden = Boolean(hidden);
	if (hidden) {
		widget.computeSize = () => [0, -4];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		if (widget.element) widget.element.style.display = "none";
		if (element) element.style.display = "none";
		return;
	}
	if (state.computeSize) widget.computeSize = state.computeSize;
	else delete widget.computeSize;
	if (state.getHeight) widget.getHeight = state.getHeight;
	else delete widget.getHeight;
	if (state.draw) widget.draw = state.draw;
	else delete widget.draw;
	if (widget.element) widget.element.style.display = state.elementDisplay || "";
	if (element) element.style.display = "";
}

function checkpointModelSourceEnabled(node) {
	return widgetValue(node, MODEL_SOURCE_WIDGET_NAME) === CHECKPOINT_MODEL_SOURCE_VALUE;
}

function modelSourceHiddenInPanel(node, name) {
	const checkpointMode = checkpointModelSourceEnabled(node);
	if (checkpointMode) {
		return name === "unet_name" || name === "unet_dtype" || name === "clip_name1" || name === "vae_name";
	}
	return name === CHECKPOINT_WIDGET_NAME;
}

function updateModelSettingsButtonState(node) {
	const button = node?.__gjjModelSettingsButton;
	if (!button) {
		return;
	}
	const open = modelSettingsOpen(node);
	const keepEnabled = keepModelEnabled(node);
	const style = keepEnabled ? MODEL_SETTINGS_BUTTON_STYLES.on : MODEL_SETTINGS_BUTTON_STYLES.off;
	button.textContent = "🧠";
	button.title = `${open ? "关闭" : "打开"}模型浮动窗口；保持模型${keepEnabled ? "已启用" : "已关闭"}。`;
	button.classList.toggle("on", open);
	button.style.background = style.bg;
	button.style.borderColor = open ? "#94a3b8" : style.border;
	button.style.color = style.color;
	button.__gjjLazyDefaultBg = style.bg;
	button.__gjjLazyHoverBg = style.hover;
}

function updateSettingsButtonState(node) {
	const button = node?.__gjjSettingsButton;
	if (!button) {
		return;
	}
	const open = settingsOpen(node);
	button.textContent = "⚙️";
	button.title = open ? "关闭其它参数浮动窗口。" : "打开其它参数浮动窗口。";
	button.classList.toggle("on", open);
	button.style.background = open ? "linear-gradient(135deg, #4b5563, #64748b)" : "linear-gradient(135deg, #1f2933, #374151)";
	button.style.borderColor = open ? "#94a3b8" : "#55636f";
	button.style.color = open ? "#ffffff" : "#e5edf2";
	button.__gjjLazyDefaultBg = button.style.background;
	button.__gjjLazyHoverBg = open ? button.style.background : "linear-gradient(135deg, #374151, #4b5563)";
}

function updatePromptSettingsButtonState(node) {
	const button = node?.__gjjPromptSettingsButton;
	if (!button) {
		return;
	}
	const open = promptSettingsOpen(node);
	button.textContent = "📒";
	button.title = open ? "关闭提示词浮动窗口。" : "打开全局提示词与反向提示词浮动窗口。";
	button.classList.toggle("on", open);
	button.style.background = open ? "linear-gradient(135deg,#7c2d12,#c2410c)" : "linear-gradient(135deg,#3f2418,#7c2d12)";
	button.style.borderColor = open ? "#fb923c" : "#9a5433";
	button.style.color = "#fff7ed";
	button.__gjjLazyDefaultBg = button.style.background;
	button.__gjjLazyHoverBg = open ? button.style.background : "linear-gradient(135deg,#7c2d12,#c2410c)";
}

function updateSizeSettingsButtonState(node) {
	applyInputSizeButtonState(node);
}

function orderLazyWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const rank = (widget) => {
		const name = String(widget?.name || "");
		if (widget === node.__gjjExecuteButtonWidget || name === EXECUTE_BUTTON_NAME) return 0;
		if (name === "prompt") return 10;
		if (widget === node.__gjjImagePreviewWidget || name === IMAGE_PREVIEW_NAME) return 100;
		if (widget === node.__gjjLoraWidget) return 900;
		if (ALWAYS_HIDDEN_WIDGETS.has(name) || widget?.hidden) return 900;
		return 50;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((left, right) => rank(left.widget) - rank(right.widget) || left.index - right.index)
		.map((item) => item.widget);
}

function applySettingsVisibility(node) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	for (const name of PANEL_SYNC_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget || ALWAYS_HIDDEN_WIDGETS.has(name) || name === "prompt") {
			continue;
		}
		setLazyWidgetHidden(widget, true);
	}
	applySizeDimensionAvailability(node);
	setDomWidgetHidden(node.__gjjLoraWidget, null, true);
	syncFloatingPanels(node);
	updateModelSettingsButtonState(node);
	updateSizeSettingsButtonState(node);
	updateSettingsButtonState(node);
	updatePromptSettingsButtonState(node);
	setBatchLinkButtonState(node);
	applyReferenceBrowserButtonState(node);
	orderLazyWidgets(node);
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
	GJJ_Utils.refreshNode(node);
}

function setSettingsOpen(node, open) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	const nextOpen = Boolean(open);
	if (nextOpen) {
		closeLazyFloatingSurfaces(node, "settings");
	}
	node.properties[SETTINGS_OPEN_PROPERTY] = nextOpen;
	if (nextOpen) {
		node.properties[MODEL_SETTINGS_OPEN_PROPERTY] = false;
		node.properties[SIZE_SETTINGS_OPEN_PROPERTY] = false;
		node.properties[PROMPT_SETTINGS_OPEN_PROPERTY] = false;
	}
	applySettingsVisibility(node);
}

function setModelSettingsOpen(node, open) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	const nextOpen = Boolean(open);
	if (nextOpen) {
		closeLazyFloatingSurfaces(node, "model");
	}
	node.properties[MODEL_SETTINGS_OPEN_PROPERTY] = nextOpen;
	if (nextOpen) {
		node.properties[SETTINGS_OPEN_PROPERTY] = false;
		node.properties[SIZE_SETTINGS_OPEN_PROPERTY] = false;
		node.properties[PROMPT_SETTINGS_OPEN_PROPERTY] = false;
	}
	applySettingsVisibility(node);
}

function setSizeSettingsOpen(node, open) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	const nextOpen = Boolean(open);
	if (nextOpen) {
		closeLazyFloatingSurfaces(node, "size");
	}
	node.properties[SIZE_SETTINGS_OPEN_PROPERTY] = nextOpen;
	if (nextOpen) {
		node.properties[MODEL_SETTINGS_OPEN_PROPERTY] = false;
		node.properties[SETTINGS_OPEN_PROPERTY] = false;
		node.properties[PROMPT_SETTINGS_OPEN_PROPERTY] = false;
	}
	applySettingsVisibility(node);
}

function setPromptSettingsOpen(node, open) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	const nextOpen = Boolean(open);
	if (nextOpen) {
		closeLazyFloatingSurfaces(node, "prompt");
	}
	node.properties[PROMPT_SETTINGS_OPEN_PROPERTY] = nextOpen;
	if (nextOpen) {
		node.properties[MODEL_SETTINGS_OPEN_PROPERTY] = false;
		node.properties[SETTINGS_OPEN_PROPERTY] = false;
		node.properties[SIZE_SETTINGS_OPEN_PROPERTY] = false;
	}
	applySettingsVisibility(node);
}

function closeLazyFloatingSurfaces(node, except = "") {
	if (!node) {
		return;
	}
	closeTemplateSourcePicker();
	node.properties = node.properties || {};
	if (except !== "model") {
		node.properties[MODEL_SETTINGS_OPEN_PROPERTY] = false;
		if (node.__gjjLazyModelFloatingPanel?.panel) {
			node.__gjjLazyModelFloatingPanel.panel.style.display = "none";
		}
	}
	if (except !== "settings") {
		node.properties[SETTINGS_OPEN_PROPERTY] = false;
		if (node.__gjjLazyOtherFloatingPanel?.panel) {
			node.__gjjLazyOtherFloatingPanel.panel.style.display = "none";
		}
	}
	if (except !== "size") {
		node.properties[SIZE_SETTINGS_OPEN_PROPERTY] = false;
		if (node.__gjjLazySizeFloatingPanel?.panel) {
			node.__gjjLazySizeFloatingPanel.panel.style.display = "none";
		}
	}
	if (except !== "prompt") {
		node.properties[PROMPT_SETTINGS_OPEN_PROPERTY] = false;
		if (node.__gjjLazyPromptFloatingPanel?.panel) {
			node.__gjjLazyPromptFloatingPanel.panel.style.display = "none";
		}
	}
	if (except !== "lora" && globalThis.__gjjLoraPopup?.state?.node === node) {
		globalThis.__gjjLoraPopup.close();
	}
	if (except !== "unet") {
		closeUnetModelPicker(node);
	}
	if (except !== "test" && node.__gjjLazyTestOverlay) {
		node.__gjjLazyTestOverlay.remove();
		node.__gjjLazyTestOverlay = null;
	}
}

function floatingPanelBaseStyle() {
	return [
		"position:fixed",
		"z-index:800",
		"width:min(520px, calc(100vw - 28px))",
		"max-height:min(680px, calc(100vh - 32px))",
		"overflow:hidden",
		"display:none",
		"flex-direction:column",
		"gap:10px",
		"padding:10px",
		"box-sizing:border-box",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#10171b",
		"color:#dce7e2",
		"box-shadow:0 16px 42px rgba(0,0,0,0.45)",
		"pointer-events:auto",
	].join(";");
}

function protectFloatingPanelEvents(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	element.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
}

function clampFloatingPanelToViewport(panel, left, top) {
	const padding = 14;
	const width = panel.getBoundingClientRect?.().width || panel.offsetWidth || 360;
	const height = panel.getBoundingClientRect?.().height || panel.offsetHeight || 120;
	return {
		left: Math.max(padding, Math.min(left, window.innerWidth - width - padding)),
		top: Math.max(padding, Math.min(top, window.innerHeight - height - padding)),
	};
}

function makeFloatingPanelDraggable(panel, header) {
	header.style.cursor = "move";
	header.style.userSelect = "none";
	header.title = "拖动窗口";
	header.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || event.target?.closest?.("button, input, select, textarea, a")) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const rect = panel.getBoundingClientRect();
		const offsetX = event.clientX - rect.left;
		const offsetY = event.clientY - rect.top;
		panel.__gjjManualPosition = true;
		header.setPointerCapture?.(event.pointerId);

		const move = (moveEvent) => {
			const position = clampFloatingPanelToViewport(
				panel,
				moveEvent.clientX - offsetX,
				moveEvent.clientY - offsetY,
			);
			panel.style.left = `${Math.round(position.left)}px`;
			panel.style.top = `${Math.round(position.top)}px`;
		};
		const stop = (stopEvent) => {
			header.releasePointerCapture?.(stopEvent.pointerId);
			header.removeEventListener("pointermove", move);
			header.removeEventListener("pointerup", stop);
			header.removeEventListener("pointercancel", stop);
		};
		header.addEventListener("pointermove", move);
		header.addEventListener("pointerup", stop);
		header.addEventListener("pointercancel", stop);
	});
}

function createFloatingPanel(node, kind, titleText) {
	const panel = document.createElement("div");
	panel.className = `gjj-lazy-floating-panel gjj-lazy-${kind}-panel`;
	panel.style.cssText = floatingPanelBaseStyle();
	protectFloatingPanelEvents(panel);

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;background:#10171b;padding-bottom:4px;z-index:1;flex:0 0 auto;touch-action:none";
	const title = document.createElement("div");
	title.textContent = titleText;
	title.style.cssText = "font-size:13px;font-weight:700;color:#f2faf7";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	close.style.cssText = "width:26px;height:24px;border:1px solid #41535b;border-radius:6px;background:#1a2328;color:#dce7e2;cursor:pointer";
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (kind === "model") setModelSettingsOpen(node, false);
		else if (kind === "size") setSizeSettingsOpen(node, false);
		else if (kind === "prompt") setPromptSettingsOpen(node, false);
		else setSettingsOpen(node, false);
	});
	panel.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (kind === "model") setModelSettingsOpen(node, false);
		else if (kind === "size") setSizeSettingsOpen(node, false);
		else if (kind === "prompt") setPromptSettingsOpen(node, false);
		else setSettingsOpen(node, false);
	});
	header.append(title, close);
	makeFloatingPanelDraggable(panel, header);

	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto;overscroll-behavior:contain";
	panel.append(header, body);
	document.body.appendChild(panel);
	return { panel, body };
}

function widgetDisplayLabel(widget, fallbackName) {
	return String(widget?.options?.display_name || widget?.label || widget?.localized_name || widget?.name || fallbackName || "");
}

function closeUnetModelPicker(node) {
	if (!node?.__gjjUnetModelPicker) {
		return;
	}
	node.__gjjUnetModelPicker.__gjjCleanup?.();
	node.__gjjUnetModelPicker.remove();
	node.__gjjUnetModelPicker = null;
}

function positionUnetModelPicker(node, panel, anchor) {
	if (panel?.__gjjManualPosition) {
		const rect = panel.getBoundingClientRect();
		const position = clampFloatingPanelToViewport(panel, rect.left, rect.top);
		panel.style.left = `${Math.round(position.left)}px`;
		panel.style.top = `${Math.round(position.top)}px`;
		return;
	}
	const viewportWidth = Math.max(320, window.innerWidth || 320);
	const viewportHeight = Math.max(240, window.innerHeight || 240);
	const padding = 14;
	const width = Math.min(760, viewportWidth - padding * 2);
	const maxHeight = Math.min(680, viewportHeight - padding * 2);
	const left = Math.max(padding, Math.round((viewportWidth - width) / 2));
	const top = Math.max(padding, Math.round((viewportHeight - maxHeight) / 2));
	panel.style.width = `${width}px`;
	panel.style.maxHeight = `${maxHeight}px`;
	panel.style.left = `${left}px`;
	panel.style.top = `${top}px`;
}

function parseModelFilterGroups(query) {
	return String(query || "")
		.split("|")
		.map((group) => {
			const include = [];
			const exclude = [];
			for (const token of group.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
				if (token.startsWith("-") && token.length > 1) {
					exclude.push(token.slice(1));
				} else {
					include.push(token);
				}
			}
			return { include, exclude };
		})
		.filter((group) => group.include.length || group.exclude.length);
}

function textMatchesModelFilter(text, query) {
	const groups = parseModelFilterGroups(query);
	if (!groups.length) {
		return true;
	}
	const haystack = String(text ?? "").toLowerCase();
	return groups.some(({ include, exclude }) => (
		include.every((token) => haystack.includes(token))
		&& exclude.every((token) => !haystack.includes(token))
	));
}

function modelNameMatchesKeywordFilter(name, query) {
	return textMatchesModelFilter(name, query);
}

function openUnetModelPicker(node, anchor) {
	const widget = getWidget(node, "unet_name");
	const values = Array.isArray(widget?.options?.values) ? widget.options.values : [];
	if (!widget || !values.length) {
		return;
	}
	if (node.__gjjUnetModelPicker?.__gjjAnchor === anchor) {
		closeUnetModelPicker(node);
		return;
	}
	closeUnetModelPicker(node);
	closeLazyFloatingSurfaces(node, "model");
	const panel = document.createElement("div");
	panel.__gjjAnchor = anchor;
	panel.style.cssText = [
		"position:fixed",
		"z-index:100002",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:10px",
		"box-sizing:border-box",
		"border:1px solid #41535b",
		"border-radius:10px",
		"background:#10171b",
		"box-shadow:0 18px 54px rgba(0,0,0,0.62)",
		"overflow:hidden",
		"pointer-events:auto",
	].join(";");

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;touch-action:none";
	const title = document.createElement("div");
	title.textContent = "🟣 选择 UNET 主模型";
	title.style.cssText = "font-size:13px;font-weight:800;color:#f2faf7";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	close.style.cssText = "width:28px;height:26px;border:1px solid #41535b;border-radius:6px;background:#1a2328;color:#dce7e2;cursor:pointer";
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closeUnetModelPicker(node);
	});
	header.append(title, close);
	makeFloatingPanelDraggable(panel, header);

	const search = document.createElement("input");
	search.type = "text";
	search.placeholder = "关键词过滤；-XXX 表示排除";
	search.title = "空格表示同时包含，-XXX 表示不含 XXX，| 表示任一组匹配。例如：mage -turbo | flux schnell";
	search.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #526872;border-radius:7px;background:#11181c;color:#dce7e2;padding:8px 10px;font-size:13px";

	const list = document.createElement("div");
	list.style.cssText = "display:flex;flex-direction:column;gap:5px;overflow:auto;max-height:min(560px,calc(100vh - 150px));overscroll-behavior:contain";
	panel.append(header, search, list);
	document.body.appendChild(panel);
	node.__gjjUnetModelPicker = panel;

	const render = () => {
		const selected = String(widget.value ?? "");
		const filtered = values.filter((value) => modelNameMatchesKeywordFilter(value, search.value));
		const optionValues = [...filtered];
		if (selected && !optionValues.some((value) => String(value ?? "") === selected)) {
			optionValues.unshift(selected);
		}
		list.replaceChildren();
		if (!optionValues.length) {
			const empty = document.createElement("div");
			empty.textContent = "没有匹配的模型";
			empty.style.cssText = "color:#8da2ad;font-size:12px;padding:6px 4px";
			list.appendChild(empty);
			return;
		}
		for (const value of optionValues) {
			const text = String(value ?? "");
			const item = document.createElement("button");
			item.type = "button";
			item.textContent = `${text === selected ? "✓ " : ""}${text || "未选择"}`;
			item.title = text;
			item.style.cssText = [
				"width:100%",
				"border:1px solid " + (text === selected ? "#2f7d67" : "#33454c"),
				"border-radius:6px",
				"background:" + (text === selected ? "#18352f" : "#182127"),
				"color:#dce7e2",
				"padding:6px 8px",
				"text-align:left",
				"cursor:pointer",
				"font-size:12px",
				"line-height:1.3",
				"white-space:normal",
				"overflow-wrap:anywhere",
			].join(";");
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				setWidgetValue(widget, coerceParamValue("unet_name", text, node));
				writeLiveParamSnapshot(node);
				closeUnetModelPicker(node);
				applySettingsVisibility(node);
			});
			list.appendChild(item);
		}
	};

	const outsideHandler = (event) => {
		if (panel.contains(event.target) || anchor.contains?.(event.target)) {
			return;
		}
		closeUnetModelPicker(node);
	};
	panel.__gjjCleanup = () => document.removeEventListener("pointerdown", outsideHandler, true);
	for (const eventName of ["pointerdown", "mousedown", "click", "keydown"]) {
		panel.addEventListener(eventName, (event) => event.stopPropagation());
	}
	search.addEventListener("input", render);
	search.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closeUnetModelPicker(node);
		}
	});
	render();
	positionUnetModelPicker(node, panel, anchor);
	document.addEventListener("pointerdown", outsideHandler, true);
	setTimeout(() => search.focus(), 0);
}

function createFloatingControl(node, name) {
	const widget = getWidget(node, name);
	if (!widget) {
		return null;
	}
	const row = document.createElement("div");
	row.dataset.widgetName = name;
	row.style.cssText = "display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px;align-items:center;font-size:12px;color:#c7d5d8";
	const label = document.createElement("span");
	label.textContent = widgetDisplayLabel(widget, name);
	label.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";

	let input;
	let valueInput = null;
	const values = Array.isArray(widget.options?.values) ? widget.options.values : null;
	if (name === MODEL_SOURCE_WIDGET_NAME && values) {
		input = document.createElement("div");
		input.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;min-width:0;width:100%";
		for (const value of values) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.value = String(value ?? "");
			button.textContent = String(value ?? "");
			button.style.cssText = [
				"height:30px",
				"min-width:0",
				"border:1px solid #41535b",
				"border-radius:6px",
				"background:#11181c",
				"color:#dce7e2",
				"cursor:pointer",
				"font-size:12px",
				"font-weight:700",
				"overflow:hidden",
				"text-overflow:ellipsis",
				"white-space:nowrap",
				"padding:0 8px",
			].join(";");
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const current = getWidget(node, name);
				if (!current) return;
				setWidgetValue(current, coerceParamValue(name, button.dataset.value, node));
				applySettingsVisibility(node);
				writeLiveParamSnapshot(node);
			});
			input.appendChild(button);
		}
	} else if (name === "unet_name" && values) {
		input = document.createElement("button");
		input.type = "button";
		input.title = "点击展开 UNET 主模型列表，可在弹出列表顶部输入关键词过滤。";
		input.style.cssText = "min-width:0;width:100%;box-sizing:border-box;border:1px solid #41535b;border-radius:6px;background:#11181c;color:#dce7e2;padding:5px 28px 5px 7px;font-size:12px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;position:relative";
		input.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openUnetModelPicker(node, input);
		});
	} else if (values) {
		input = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value ?? "");
			option.textContent = String(value ?? "");
			input.appendChild(option);
		}
	} else if (name === GLOBAL_PROMPT_WIDGET_NAME || name === "negative_prompt") {
		input = document.createElement("textarea");
		input.rows = name === GLOBAL_PROMPT_WIDGET_NAME ? 4 : 7;
		input.placeholder = name === GLOBAL_PROMPT_WIDGET_NAME
			? "每一条正向提示词都会自动加上这段前缀"
			: "输入需要排除的内容";
		input.style.resize = "vertical";
	} else if (String(widget.type || "").toLowerCase().includes("toggle") || typeof widget.value === "boolean") {
		input = document.createElement("input");
		input.type = "checkbox";
	} else {
		input = document.createElement("input");
		input.type = typeof widget.value === "number" ? "number" : "text";
		if (input.type === "number") {
			if (widget.options?.min != null) input.min = String(widget.options.min);
			if (widget.options?.max != null) input.max = String(widget.options.max);
			if (widget.options?.step != null) input.step = String(widget.options.step);
		}
	}
	const valueElement = valueInput || input;
	input.dataset.widgetName = name;
	valueElement.dataset.widgetName = name;
	if (name !== MODEL_SOURCE_WIDGET_NAME) {
		valueElement.style.cssText = "min-width:0;width:100%;box-sizing:border-box;border:1px solid #41535b;border-radius:6px;background:#11181c;color:#dce7e2;padding:5px 7px;font-size:12px";
	}
	if (name === GLOBAL_PROMPT_WIDGET_NAME || name === "negative_prompt") {
		row.style.alignItems = "start";
		valueElement.style.minHeight = name === GLOBAL_PROMPT_WIDGET_NAME ? "86px" : "126px";
		valueElement.style.resize = "vertical";
		valueElement.style.lineHeight = "1.45";
	}
	if (valueElement.type === "checkbox") {
		valueElement.style.cssText = "appearance:none;-webkit-appearance:none;justify-self:end;min-width:42px;width:42px;height:22px;box-sizing:border-box;border:1px solid #52636b;border-radius:999px;background:#4b5563;cursor:pointer;transition:background-color .15s,border-color .15s;outline:none";
	}
	if (name === "unet_name") {
		valueElement.style.cssText = input.style.cssText;
	}

	const refresh = () => {
		const current = getWidget(node, name);
		if (!current) return;
		if (name === MODEL_SOURCE_WIDGET_NAME) {
			const currentValue = String(current.value ?? "");
			for (const button of input.querySelectorAll("button[data-value]")) {
				const active = String(button.dataset.value || "") === currentValue;
				button.style.background = active ? "linear-gradient(135deg,#064e3b,#047857)" : "#11181c";
				button.style.borderColor = active ? "#34d399" : "#41535b";
				button.style.color = active ? "#ecfdf5" : "#dce7e2";
			}
		} else if (name === "unet_name") {
			valueElement.textContent = String(current.value ?? "") || "未选择";
		} else if (valueElement.type === "checkbox") {
			valueElement.checked = boolValue(current.value);
			valueElement.style.background = valueElement.checked
				? "radial-gradient(circle at calc(100% - 10px) 50%,#172026 0 7px,transparent 7.5px),#60a5fa"
				: "radial-gradient(circle at 10px 50%,#d1d5db 0 7px,transparent 7.5px),#4b5563";
			valueElement.style.borderColor = valueElement.checked ? "#7db7ff" : "#52636b";
		}
		else valueElement.value = String(current.value ?? "");
	};
	const commit = () => {
		const current = getWidget(node, name);
		if (!current) return;
		const nextValue = valueElement.type === "checkbox" ? valueElement.checked : valueElement.value;
		if (name === USE_INPUT_IMAGE_SIZE_WIDGET_NAME) {
			setInputSizeSyncEnabled(node, nextValue);
			return;
		}
		setWidgetValue(current, coerceParamValue(name, nextValue, node));
		if (name === MODEL_SOURCE_WIDGET_NAME) {
			applySettingsVisibility(node);
		}
		if (name === KEEP_MODEL_WIDGET_NAME) {
			applyKeepModelButtonState(node);
			updateModelSettingsButtonState(node);
		}
		writeLiveParamSnapshot(node);
	};
	if (name !== MODEL_SOURCE_WIDGET_NAME && name !== "unet_name") {
		valueElement.addEventListener("change", commit);
		if (valueElement.tagName !== "SELECT") {
			valueElement.addEventListener("input", commit);
		}
	}
	row.__gjjRefresh = refresh;
	row.append(label, input);
	refresh();
	return row;
}

function createModelOptimizationBooleanButton(node, name, refreshSection) {
	const widget = getWidget(node, name);
	if (!widget) {
		return null;
	}
	const row = document.createElement("div");
	row.dataset.widgetName = name;
	row.style.cssText = "display:block;width:100%;min-width:0";

	const button = document.createElement("button");
	button.type = "button";
	button.dataset.widgetName = name;
	button.style.cssText = [
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"width:100%",
		"min-width:0",
		"height:34px",
		"box-sizing:border-box",
		"padding:0 6px",
		"border:1px solid #41535b",
		"border-radius:7px",
		"background:#1a2328",
		"color:#cbd5e1",
		"cursor:pointer",
		"font-size:12px",
		"font-weight:800",
		"overflow:hidden",
		"transition:background .15s,border-color .15s,color .15s",
	].join(";");

	const label = document.createElement("span");
	label.textContent = MODEL_OPTIMIZATION_BUTTON_LABELS[name] || widgetDisplayLabel(widget, name);
	label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center";
	button.appendChild(label);
	row.appendChild(button);

	row.__gjjRefresh = () => {
		const current = getWidget(node, name);
		if (!current) return;
		const active = name === FP16_ACCUMULATION_WIDGET_NAME
			? boolValue(getWidget(node, ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME)?.value) && boolValue(current.value)
			: boolValue(current.value);
		button.setAttribute("aria-pressed", active ? "true" : "false");
		button.title = `${widgetDisplayLabel(current, name)}：${active ? "已开启" : "已关闭"}。点击切换。`;
		button.style.background = active
			? "linear-gradient(135deg,#075985,#2563eb)"
			: "linear-gradient(135deg,#1a2328,#263238)";
		button.style.borderColor = active ? "#60a5fa" : "#41535b";
		button.style.color = active ? "#eff6ff" : "#cbd5e1";
	};
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const current = getWidget(node, name);
		if (!current || button.disabled) return;
		const active = name === FP16_ACCUMULATION_WIDGET_NAME
			? boolValue(getWidget(node, ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME)?.value) && boolValue(current.value)
			: boolValue(current.value);
		const nextValue = !active;
		setWidgetValue(current, nextValue);
		if (name === FP16_ACCUMULATION_WIDGET_NAME) {
			const compatibilityGate = getWidget(node, ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME);
			if (compatibilityGate) setWidgetValue(compatibilityGate, nextValue);
		}
		writeLiveParamSnapshot(node);
		row.__gjjRefresh?.();
		refreshSection?.();
	});
	row.__gjjRefresh();
	return row;
}

function modelOptimizationControlEnabled(node, name) {
	if ([SAGE_ATTENTION_MODE_WIDGET_NAME, ALLOW_SAGE_COMPILE_WIDGET_NAME, MISSING_SAGE_ATTENTION_POLICY_WIDGET_NAME].includes(name)) {
		return boolValue(getWidget(node, ENABLE_SAGE_ATTENTION_WIDGET_NAME)?.value);
	}
	return true;
}

function createModelOptimizationSection(node) {
	const rows = [];
	const section = document.createElement("div");
	section.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:2px;padding-top:8px;border-top:1px solid #263842";

	const title = document.createElement("div");
	title.textContent = "⚡ 性能优化";
	title.style.cssText = "color:#f2faf7;font-size:12px;font-weight:800";
	section.appendChild(title);

	const booleanNames = MODEL_OPTIMIZATION_WIDGETS.filter(
		(name) => MODEL_OPTIMIZATION_BOOLEAN_WIDGETS.has(name) && name !== ENABLE_FP16_ACCUMULATION_SETTING_WIDGET_NAME,
	);
	const buttonBar = document.createElement("div");
	buttonBar.style.cssText = `display:grid;grid-template-columns:repeat(${booleanNames.length},minmax(0,1fr));gap:7px;width:100%;min-width:0`;
	for (const name of booleanNames) {
		const row = createModelOptimizationBooleanButton(node, name, () => section.__gjjRefresh?.());
		if (!row) continue;
		const widget = getWidget(node, name);
		if (widget?.options?.tooltip) {
			row.title = String(widget.options.tooltip);
		}
		rows.push({ name, row });
		buttonBar.appendChild(row);
	}
	if (buttonBar.children.length) {
		section.appendChild(buttonBar);
	}

	for (const name of MODEL_OPTIMIZATION_WIDGETS.filter((item) => !MODEL_OPTIMIZATION_BOOLEAN_WIDGETS.has(item))) {
		const row = createFloatingControl(node, name);
		if (!row) continue;
		const widget = getWidget(node, name);
		if (widget?.options?.tooltip) {
			row.title = String(widget.options.tooltip);
		}
		rows.push({ name, row });
		section.appendChild(row);
	}
	if (!rows.length) {
		return null;
	}

	section.__gjjRefresh = () => {
		for (const { name, row } of rows) {
			row.__gjjRefresh?.();
			const enabled = modelOptimizationControlEnabled(node, name);
			const input = row.querySelector("[data-widget-name]");
			if (input) input.disabled = !enabled;
			row.style.opacity = enabled ? "1" : "0.5";
		}
	};
	for (const { row } of rows) {
		const input = row.querySelector("[data-widget-name]");
		input?.addEventListener("change", () => section.__gjjRefresh?.());
		input?.addEventListener("input", () => section.__gjjRefresh?.());
	}
	section.__gjjRefresh();
	return section;
}

function createPanelButtonGroup(node, name, choices, getValue, setValue) {
	const widget = getWidget(node, name);
	if (!widget) {
		return null;
	}
	const wrap = document.createElement("div");
	wrap.dataset.widgetName = name;
	wrap.style.cssText = "display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px;align-items:center;font-size:12px;color:#c7d5d8";
	const label = document.createElement("span");
	label.textContent = widgetDisplayLabel(widget, name);
	label.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
	const group = document.createElement("div");
	group.style.cssText = `display:grid;grid-template-columns:repeat(${choices.length},minmax(0,1fr));gap:6px;min-width:0;width:100%`;
	for (const choice of choices) {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.value = String(choice.value);
		button.textContent = String(choice.label);
		button.title = choice.title || "";
		button.style.cssText = [
			"height:30px",
			"min-width:0",
			"border:1px solid #41535b",
			"border-radius:6px",
			"background:#11181c",
			"color:#dce7e2",
			"cursor:pointer",
			"font-size:12px",
			"font-weight:800",
			"overflow:hidden",
			"text-overflow:ellipsis",
			"white-space:nowrap",
			"padding:0 8px",
		].join(";");
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setValue(node, choice.value);
			wrap.__gjjRefresh?.();
		});
		group.appendChild(button);
	}
	wrap.__gjjRefresh = () => {
		const currentValue = String(getValue(node));
		for (const button of group.querySelectorAll("button[data-value]")) {
			const active = String(button.dataset.value || "") === currentValue;
			const choice = choices.find((item) => String(item.value) === String(button.dataset.value || "")) || {};
			const style = choice.style || {};
			button.style.background = active ? style.bg || "linear-gradient(135deg,#064e3b,#047857)" : "#11181c";
			button.style.borderColor = active ? style.border || "#34d399" : "#41535b";
			button.style.color = active ? style.color || "#ecfdf5" : "#dce7e2";
			button.__gjjLazyDefaultBg = active ? style.bg : "#11181c";
			button.__gjjLazyHoverBg = active ? style.hover : "#1f2933";
			button.setAttribute("aria-pressed", active ? "true" : "false");
		}
	};
	wrap.append(label, group);
	wrap.__gjjRefresh();
	return wrap;
}

function createKeepModelPanelButton(node) {
	return createPanelButtonGroup(
		node,
		KEEP_MODEL_WIDGET_NAME,
		[
			{ value: true, label: "保持模型", title: KEEP_MODEL_BUTTON_STYLES.on.title, style: KEEP_MODEL_BUTTON_STYLES.on },
			{ value: false, label: "不保持", title: KEEP_MODEL_BUTTON_STYLES.off.title, style: KEEP_MODEL_BUTTON_STYLES.off },
		],
		(currentNode) => keepModelEnabled(currentNode),
		(currentNode, value) => setKeepModelEnabled(currentNode, Boolean(value)),
	);
}

function setModelSourceValue(node, value) {
	const widget = getWidget(node, MODEL_SOURCE_WIDGET_NAME);
	if (!widget) return;
	setWidgetValue(widget, coerceParamValue(MODEL_SOURCE_WIDGET_NAME, value, node));
	applySettingsVisibility(node);
	writeLiveParamSnapshot(node);
}

function createModelQuickToggleBar(node) {
	const sourceWidget = getWidget(node, MODEL_SOURCE_WIDGET_NAME);
	const keepWidget = getWidget(node, KEEP_MODEL_WIDGET_NAME);
	if (!sourceWidget && !keepWidget) {
		return null;
	}
	const bar = document.createElement("div");
	bar.style.cssText = [
		"display:grid",
		"grid-template-columns:repeat(2,minmax(0,1fr))",
		"gap:8px",
		"width:100%",
		"min-width:0",
		"align-items:center",
	].join(";");

	const makeButton = (key, labelFn, titleFn, styleFn, onClick) => {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.toggleKey = key;
		button.style.cssText = [
			"height:36px",
			"min-width:0",
			"border:1px solid #41535b",
			"border-radius:7px",
			"background:#11181c",
			"color:#dce7e2",
			"cursor:pointer",
			"font-size:13px",
			"font-weight:900",
			"overflow:hidden",
			"text-overflow:ellipsis",
			"white-space:nowrap",
			"padding:0 8px",
		].join(";");
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick();
			bar.__gjjRefresh?.();
		});
		button.__gjjRefresh = () => {
			const style = styleFn();
			button.textContent = labelFn();
			button.title = titleFn();
			button.style.background = style.bg;
			button.style.borderColor = style.border;
			button.style.color = style.color;
			button.setAttribute("aria-pressed", "true");
		};
		bar.appendChild(button);
		return button;
	};

	if (sourceWidget) {
		makeButton(
			"model_source",
			() => checkpointModelSourceEnabled(node) ? "Checkpoint" : "UNET主模型",
			() => checkpointModelSourceEnabled(node) ? "当前使用底模 checkpoint；点击切换到 UNET 主模型。" : "当前使用 UNET 主模型；点击切换到底模 checkpoint。",
			() => checkpointModelSourceEnabled(node)
				? { bg: "linear-gradient(135deg, #075985, #2563eb)", border: "#38bdf8", color: "#e0f2fe" }
				: { bg: "linear-gradient(135deg, #064e3b, #047857)", border: "#34d399", color: "#ecfdf5" },
			() => setModelSourceValue(node, checkpointModelSourceEnabled(node) ? "UNET 主模型" : CHECKPOINT_MODEL_SOURCE_VALUE),
		);
	}
	if (keepWidget) {
		makeButton(
			"keep_model",
			() => keepModelEnabled(node) ? "保持模型" : "不保持",
			() => keepModelEnabled(node) ? KEEP_MODEL_BUTTON_STYLES.on.title : KEEP_MODEL_BUTTON_STYLES.off.title,
			() => keepModelEnabled(node) ? KEEP_MODEL_BUTTON_STYLES.on : KEEP_MODEL_BUTTON_STYLES.off,
			() => setKeepModelEnabled(node, !keepModelEnabled(node)),
		);
	}

	bar.__gjjRefresh = () => {
		for (const button of bar.querySelectorAll("button[data-toggle-key]")) {
			button.__gjjRefresh?.();
		}
	};
	bar.__gjjRefresh();
	return bar;
}

function ensureFloatingPanels(node) {
	if (!node.__gjjLazyModelFloatingPanel) {
		node.__gjjLazyModelFloatingPanel = createFloatingPanel(node, "model", "🧠 模型参数");
	}
	if (!node.__gjjLazySizeFloatingPanel) {
		node.__gjjLazySizeFloatingPanel = createFloatingPanel(node, "size", "📐 尺寸");
	}
	if (!node.__gjjLazyOtherFloatingPanel) {
		node.__gjjLazyOtherFloatingPanel = createFloatingPanel(node, "settings", "⚙️ 其它参数");
	}
	if (!node.__gjjLazyPromptFloatingPanel) {
		node.__gjjLazyPromptFloatingPanel = createFloatingPanel(node, "prompt", "📒 提示词");
	}
	return {
		model: node.__gjjLazyModelFloatingPanel,
		size: node.__gjjLazySizeFloatingPanel,
		other: node.__gjjLazyOtherFloatingPanel,
		prompt: node.__gjjLazyPromptFloatingPanel,
	};
}

function nodeScreenRect(node) {
	const canvas = app.canvas?.canvas;
	const rect = canvas?.getBoundingClientRect?.();
	const scale = Number(app.canvas?.ds?.scale || 1);
	const offset = app.canvas?.ds?.offset || [0, 0];
	const pos = node?.pos || [0, 0];
	const size = node?.size || [260, 120];
	if (!rect) {
		return {
			left: Number(pos[0] || 0),
			top: Number(pos[1] || 0),
			width: Number(size[0] || 260),
			height: Number(size[1] || 120),
			right: Number(pos[0] || 0) + Number(size[0] || 260),
			bottom: Number(pos[1] || 0) + Number(size[1] || 120),
		};
	}
	const left = rect.left + (Number(pos[0] || 0) + Number(offset[0] || 0)) * scale;
	const top = rect.top + (Number(pos[1] || 0) + Number(offset[1] || 0)) * scale;
	const width = Number(size[0] || 260) * scale;
	const height = Number(size[1] || 120) * scale;
	return {
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
	};
}

function positionFloatingPanel(node, panel, anchor) {
	if (!panel) return;
	const width = Math.min(520, Math.max(360, window.innerWidth - 28));
	panel.style.width = `${width}px`;
	if (panel.__gjjManualPosition) {
		const current = panel.getBoundingClientRect();
		const position = clampFloatingPanelToViewport(panel, current.left, current.top);
		panel.style.left = `${Math.round(position.left)}px`;
		panel.style.top = `${Math.round(position.top)}px`;
		return;
	}
	const rect = anchor?.getBoundingClientRect?.();
	const left = Math.min(window.innerWidth - width - 14, Math.max(14, rect?.left || 80));
	const panelHeight = panel.getBoundingClientRect?.().height || 120;
	const top = Math.min(window.innerHeight - panelHeight - 14, Math.max(14, (rect?.bottom || 80) + 6));
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(Math.max(14, top))}px`;
}

function renderFloatingPanelControls(node, body, names) {
	const existing = new Map();
	for (const child of Array.from(body.children)) {
		if (child.dataset?.widgetName) {
			existing.set(child.dataset.widgetName, child);
		}
	}
	body.replaceChildren();
	for (const name of names) {
		if (name !== KEEP_MODEL_WIDGET_NAME && modelSourceHiddenInPanel(node, name)) {
			continue;
		}
		const control = existing.get(name) || createFloatingControl(node, name);
		if (!control) {
			continue;
		}
		control.__gjjRefresh?.();
		body.appendChild(control);
	}
}

function numericWidgetBounds(widget, fallbackMin, fallbackMax, fallbackStep) {
	const options = widget?.options || {};
	const min = Number.isFinite(Number(options.min)) ? Number(options.min) : fallbackMin;
	const max = Number.isFinite(Number(options.max)) ? Number(options.max) : fallbackMax;
	const step = Number.isFinite(Number(options.step)) ? Number(options.step) : fallbackStep;
	return { min, max, step: Math.max(1, step) };
}

function createSizeSourceControl(node) {
	const wrap = document.createElement("div");
	wrap.dataset.widgetName = USE_INPUT_IMAGE_SIZE_WIDGET_NAME;
	wrap.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0;width:100%";
	const choices = [
		{ enabled: true, label: "原图尺寸", title: "单图使用原图宽高；多图使用面积最大的输入图作为尺寸基准，再按下方规则统一所有图片。" },
		{ enabled: false, label: "面板尺寸", title: "使用下面的宽度和高度滑条。" },
	];
	for (const choice of choices) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = choice.label;
		button.title = choice.title;
		button.style.cssText = [
			"height:34px",
			"min-width:0",
			"border:1px solid #41535b",
			"border-radius:6px",
			"background:#11181c",
			"color:#dce7e2",
			"cursor:pointer",
			"font-size:14px",
			"font-weight:800",
			"padding:0 10px",
		].join(";");
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setInputSizeSyncEnabled(node, choice.enabled);
			syncFloatingPanels(node);
		});
		wrap.appendChild(button);
	}
	wrap.__gjjRefresh = () => {
		const enabled = inputSizeSyncEnabled(node);
		for (const button of wrap.querySelectorAll("button")) {
			const active = (button.textContent === "原图尺寸") === enabled;
			const style = button.textContent === "原图尺寸" ? SIZE_SOURCE_BUTTON_STYLES.input : SIZE_SOURCE_BUTTON_STYLES.panel;
			button.style.background = active ? style.bg : "#11181c";
			button.style.borderColor = active ? style.border : "#41535b";
			button.style.color = active ? style.color : "#dce7e2";
			button.setAttribute("aria-pressed", active ? "true" : "false");
		}
	};
	wrap.__gjjRefresh();
	return wrap;
}

function createImageResizeChoiceControl(node, key, icon, values, titles = {}) {
	const row = document.createElement("div");
	row.dataset.widgetName = `${IMAGE_RESIZE_CONFIG_WIDGET_NAME}:${key}`;
	row.style.cssText = "display:grid;grid-template-columns:34px minmax(0,1fr);gap:8px;align-items:center;width:100%;min-width:0";
	const label = document.createElement("span");
	label.textContent = icon;
	label.style.cssText = "font-size:19px;text-align:center;color:#f2a3c2;user-select:none";
	const group = document.createElement("div");
	group.style.cssText = `display:grid;grid-template-columns:repeat(${values.length},minmax(0,1fr));gap:7px;min-width:0`;
	for (const option of values) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = option;
		button.dataset.value = option;
		button.title = titles[option] || option;
		button.style.cssText = [
			"height:34px",
			"min-width:0",
			"border:1px solid #41535b",
			"border-radius:8px",
			"background:#11181c",
			"color:#dce7e2",
			"cursor:pointer",
			"font-size:14px",
			"font-weight:800",
			"padding:0 6px",
		].join(";");
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			writeImageResizeConfig(node, { [key]: option });
		});
		group.appendChild(button);
	}
	row.append(label, group);
	row.__gjjRefresh = () => {
		const selected = readImageResizeConfig(node)[key];
		for (const button of group.querySelectorAll("button")) {
			const active = button.dataset.value === selected;
			button.style.background = active ? "linear-gradient(135deg,#075985,#0891b2)" : "#11181c";
			button.style.borderColor = active ? "#22d3ee" : "#41535b";
			button.style.color = active ? "#ecfeff" : "#dce7e2";
			button.setAttribute("aria-pressed", active ? "true" : "false");
		}
	};
	row.__gjjRefresh();
	return row;
}

function createImageResizeConfigSlider(node, key, labelText, { min, max, step, suffix = "" }) {
	const row = document.createElement("div");
	row.dataset.widgetName = `${IMAGE_RESIZE_CONFIG_WIDGET_NAME}:${key}`;
	row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center;font-size:12px;color:#c7d5d8";
	const label = document.createElement("label");
	label.textContent = labelText;
	label.style.cssText = "grid-column:1;color:#9fd4c3;font-weight:700";
	const value = document.createElement("input");
	value.type = "number";
	value.min = String(min);
	value.max = String(max);
	value.step = String(step);
	value.title = suffix ? `单位：${suffix}` : labelText;
	value.style.cssText = "grid-column:2;width:82px;box-sizing:border-box;border:1px solid #41535b;border-radius:6px;background:#11181c;color:#dce7e2;padding:4px 6px;text-align:right;font-size:12px;font-weight:800";
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = String(min);
	slider.max = String(max);
	slider.step = String(step);
	slider.style.cssText = "grid-column:1 / span 2;width:100%;accent-color:#38bdf8;cursor:pointer";
	const commit = (raw) => {
		const numeric = Math.min(max, Math.max(min, Number(raw) || min));
		const rounded = step < 1 ? Math.round(numeric / step) * step : Math.round(numeric / step) * step;
		value.value = String(rounded);
		slider.value = String(rounded);
		writeImageResizeConfig(node, { [key]: rounded }, false);
	};
	slider.addEventListener("input", (event) => {
		commit(event.target.value);
	});
	value.addEventListener("change", (event) => commit(event.target.value));
	row.append(label, value, slider);
	row.__gjjRefresh = () => {
		const current = readImageResizeConfig(node)[key];
		value.value = String(current);
		slider.value = String(current);
	};
	row.__gjjRefresh();
	return row;
}

function createSliderControl(node, name, { disabledWhenInputSize = false } = {}) {
	const widget = getWidget(node, name);
	if (!widget) {
		return null;
	}
	const { min, max, step } = numericWidgetBounds(widget, name === "batch_size" ? 1 : 64, name === "batch_size" ? 64 : 8192, name === "batch_size" ? 1 : 8);
	const row = document.createElement("div");
	row.dataset.widgetName = name;
	row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center;font-size:12px;color:#c7d5d8";
	const label = document.createElement("label");
	label.textContent = widgetDisplayLabel(widget, name);
	label.style.cssText = "grid-column:1 / span 1;color:#9fd4c3;font-weight:700";
	const value = document.createElement("input");
	value.type = "number";
	value.min = String(min);
	value.max = String(max);
	value.step = String(step);
	value.style.cssText = "grid-column:2;width:74px;box-sizing:border-box;border:1px solid #41535b;border-radius:6px;background:#11181c;color:#dce7e2;padding:4px 6px;text-align:right;font-size:12px;font-weight:800";
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = String(min);
	slider.max = String(max);
	slider.step = String(step);
	slider.style.cssText = "grid-column:1 / span 2;width:100%;accent-color:#52c2a4;cursor:pointer";
	const commit = (raw) => {
		const current = getWidget(node, name);
		if (!current) return;
		const next = coerceParamValue(name, raw, node);
		setWidgetValue(current, next);
		if (Array.isArray(node.widgets_values)) {
			const index = getWidgetIndex(node, name);
			if (index >= 0) node.widgets_values[index] = next;
		}
		writeLiveParamSnapshot(node);
		node.graph?.change?.();
		app.graph?.setDirtyCanvas?.(true, true);
	};
	const onInput = (event) => {
		value.value = event.target.value;
		commit(event.target.value);
	};
	const onNumberInput = (event) => {
		const numeric = Math.min(max, Math.max(min, Number(event.target.value || min)));
		const rounded = Math.round(numeric / step) * step;
		const next = String(Math.min(max, Math.max(min, rounded)));
		value.value = next;
		slider.value = next;
		commit(next);
	};
	slider.addEventListener("input", onInput);
	value.addEventListener("change", onNumberInput);
	row.append(label, value, slider);
	row.__gjjRefresh = () => {
		const current = getWidget(node, name);
		if (!current) return;
		const next = String(coerceParamValue(name, current.value, node));
		value.value = next;
		slider.value = next;
		const disabled = disabledWhenInputSize && inputSizeSyncEnabled(node);
		row.style.opacity = disabled ? "0.45" : "1";
		label.style.color = disabled ? "#70838a" : "#9fd4c3";
		value.disabled = disabled;
		slider.disabled = disabled;
		value.style.cursor = disabled ? "not-allowed" : "text";
		slider.style.cursor = disabled ? "not-allowed" : "pointer";
		value.style.background = disabled ? "#182027" : "#11181c";
		value.style.color = disabled ? "#7b8d95" : "#dce7e2";
	};
	row.__gjjRefresh();
	return row;
}

function renderSizePanelControls(node, body) {
	body.replaceChildren();
	const source = createSizeSourceControl(node);
	body.appendChild(source);
	body.appendChild(createImageResizeChoiceControl(node, "mode", "📐", IMAGE_RESIZE_MODES, {
		宽高: "按宽度和高度确定统一输出画布。",
		等比: "按尺寸基准乘以缩放百分比确定统一输出画布。",
		长边: "保持尺寸基准比例，把长边缩放到指定长度。",
		像素: "保持尺寸基准比例，按总像素数计算统一输出画布。",
	}));
	body.appendChild(createImageResizeChoiceControl(node, "fit_mode", "🧲", IMAGE_FIT_MODES, {
		拉伸: "直接缩放到目标宽高，可能改变原图比例。",
		补边: "不放大小图；必要时等比缩小，再补白边到统一画布。",
		留边: "允许等比放大或缩小完整图片，再补白边到统一画布。",
		裁剪: "短边对齐填满画布，并按保留位置裁掉超出部分。",
	}));
	const resizeConfig = readImageResizeConfig(node);
	if (imageResizePositionRelevant(resizeConfig)) {
		body.appendChild(createImageResizeChoiceControl(node, "crop_position", "📍", IMAGE_CROP_POSITIONS, {
			上: "补边时靠上；裁剪时优先保留上方内容。",
			下: "补边时靠下；裁剪时优先保留下方内容。",
			左: "补边时靠左；裁剪时优先保留左侧内容。",
			右: "补边时靠右；裁剪时优先保留右侧内容。",
			中: "居中补边或裁剪。",
		}));
	}
	if (resizeConfig.mode === "等比") {
		body.appendChild(createImageResizeConfigSlider(node, "scale_percent", "缩放百分比", { min: 0.1, max: 400, step: 0.1, suffix: "%" }));
	} else if (resizeConfig.mode === "长边") {
		body.appendChild(createImageResizeConfigSlider(node, "long_side_length", "长边长度", { min: 64, max: 8192, step: 8, suffix: "px" }));
	} else if (resizeConfig.mode === "像素") {
		body.appendChild(createImageResizeConfigSlider(node, "total_pixel_k", "总像素/K", { min: 1, max: 8192, step: 1, suffix: "K" }));
	}
	const dimensionNames = resizeConfig.mode === "宽高" ? ["width", "height"] : [];
	for (const name of [...dimensionNames, "batch_size"]) {
		const control = createSliderControl(node, name, { disabledWhenInputSize: name === "width" || name === "height" });
		if (control) {
			control.__gjjRefresh?.();
			body.appendChild(control);
		}
	}
}

function modelFamilyStem(value) {
	return String(value || "")
		.replaceAll("\\", "/")
		.split("/")
		.pop()
		.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, "")
		.replace(
			/(^|[_\-. ])(?:fp8mixed|fp8_scaled|fp8_e4m3fn|fp(?:4|8|16|32)|float(?:4|8|16|32)|bf16|f16|f32|nvfp4|mxfp4|mxfp8|q[2-8](?:_[a-z0-9]+)*|int(?:4|8)|e4m3fn(?:_fast)?|e5m2|bnb(?:4|8)bit|scaled|mixed|convrot|w4a4|padded)(?=$|[_\-. ])/gi,
			"$1",
		)
		.replace(/[_\-. ]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function lazyModelTreeEntries(node) {
	const useCheckpoint = checkpointModelSourceEnabled(node);
	const selectedUnet = widgetValue(node, "unet_name") || "";
	const preset = matchPreset(selectedUnet);
	const presetKeywords = Array.isArray(preset?.keywords) ? preset.keywords : [];
	const normalizedUnet = normalizeText(selectedUnet);
	const canonicalUnet = canonicalizeText(selectedUnet);
	const familyKeyword = presetKeywords
		.map((keyword) => String(keyword || "").trim())
		.filter(Boolean)
		.sort((left, right) => right.length - left.length)
		.find((keyword) => {
			const terms = String(keyword || "").split("+").map((term) => term.trim()).filter(Boolean);
			return terms.length > 0 && terms.every((term) => {
				const normalizedKeyword = normalizeText(term);
				const canonicalKeyword = canonicalizeText(term);
				return normalizedUnet.includes(normalizedKeyword)
					|| Boolean(canonicalKeyword && canonicalUnet.includes(canonicalKeyword));
			});
		}) || String(presetKeywords[0] || "").trim();
	const familySearchValue = familyKeyword
		.split("+")
		.map((term) => term.trim())
		.filter(Boolean)
		.join("_") || modelFamilyStem(selectedUnet);
	const entries = useCheckpoint
		? [{
			widget: CHECKPOINT_WIDGET_NAME,
			label: "底模 checkpoint",
			folder: "models/checkpoints",
			icon: "🟣",
			fallback: widgetValue(node, CHECKPOINT_WIDGET_NAME) || "未找到可用 checkpoint",
			description: "作为底模直接加载，内部拆出 MODEL / CLIP / VAE。",
		}]
		: [
		{
			widget: "unet_name",
			label: "UNET 主模型",
			folder: "models/diffusion_models",
			icon: "🟣",
			anyKeywords: ["flux", "f2k", "krea", "zimage", "zit", "qwen", "firered", "boogu", "anima", "mage-flow", "mage_flow", "gguf"],
			searchValue: familySearchValue,
			fallback: widgetValue(node, "unet_name") || "未找到可用 UNET 主模型",
			description: "主扩散模型；执行时加载为采样主模型，并根据模型族联动 CLIP、VAE、采样器和 LoRA。",
		},
		{
			widget: "clip_name1",
			label: "CLIP 编码器",
			folder: "models/text_encoders",
			icon: "🟡",
			anyKeywords: ["qwen", "t5", "clip", "mistral"],
			searchValue: modelFamilyStem(
				widgetValue(node, "clip_name1") || (preset?.clipNames || [])[0],
			),
			fallback: widgetValue(node, "clip_name1") || "未找到可用 CLIP 编码器",
			description: "文本编码器；将提示词编码为当前模型族需要的条件。",
		},
		{
			widget: "vae_name",
			label: "VAE 解码器",
			folder: "models/vae",
			icon: "🔴",
			anyKeywords: ["flux2", "vae", "qwen", "ae", "default"],
			searchValue: modelFamilyStem(
				widgetValue(node, "vae_name") || preset?.vaeName,
			),
			fallback: widgetValue(node, "vae_name") || "未找到可用 VAE 解码器",
			description: "VAE 解码器；把采样 latent 解码成最终图片。",
		},
	];
	if (!useCheckpoint && normalizeText(preset?.clipType) === "flux") {
		const clipIndex = entries.findIndex((entry) => entry?.widget === "clip_name1");
		if (clipIndex >= 0) {
			const t5Entry = entries[clipIndex];
			const currentClip = widgetValue(node, "clip_name1");
			const currentT5 = canonicalizeText(currentClip) === "cliplsafetensors"
				? ""
				: currentClip;
			const preferredT5 = currentT5
				|| (preset?.clipNames || [])[1]
				|| "t5xxl_int8_convrot.safetensors";
			entries.splice(
				clipIndex,
				1,
				{
					label: "Flux CLIP-L 编码器",
					folder: "models/text_encoders",
					icon: "🟡",
					models: ["clip_l.safetensors"],
					fallback: "clip_l.safetensors",
					autoSelect: false,
					readOnly: true,
					description: "Flux 固定加载的 CLIP-L 编码器。",
				},
				{
					...t5Entry,
					label: "Flux T5XXL 编码器",
					searchValue: modelFamilyStem(preferredT5),
					fallback: currentT5 || "t5xxl_int8_convrot.safetensors",
					description: "Flux 必需的第二个文本编码器；与上方 CLIP-L 同时加载。",
				},
			);
		}
	}
	entries.push({
		label: "Opus-MT 中英翻译模型",
		folder: "models/translation",
		icon: "🧠",
		models: ["opus-mt-zh-en.safetensors"],
		fallback: "opus-mt-zh-en.safetensors",
		autoSelect: false,
		description: "提示词翻译模型；完整路径为 models/translation/opus-mt-zh-en.safetensors。",
	});
	return entries;
}

function renderModelPanelControls(node, body) {
	body.replaceChildren();
	const quickToggles = createModelQuickToggleBar(node);
	if (quickToggles) {
		body.appendChild(quickToggles);
	}
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: lazyModelTreeEntries(node).map((entry) => ({
			...entry,
			floatingChoices: true,
			stateSearchValue: entry.searchValue,
		})),
		refresh: () => {
			applySettingsVisibility(node);
			GJJ_Utils.refreshNode(node);
		},
		onApply: (entry, value, widget) => {
			if (entry?.widget === "unet_name") {
				node.properties = node.properties || {};
				node.properties[LAST_PRESET_KEY] = "";
				clearPresetLoras(node);
				applyPreset(node, true);
			}
			writeLiveParamSnapshot(node);
		},
	});
	tree.style.maxHeight = "320px";
	body.appendChild(tree);

	const optimizationSection = createModelOptimizationSection(node);
	if (optimizationSection) {
		body.appendChild(optimizationSection);
	}
}

function syncFloatingPanels(node) {
	if (!node || typeof document === "undefined") {
		return;
	}
	const { model, size, other, prompt } = ensureFloatingPanels(node);
	if (modelSettingsOpen(node) && settingsOpen(node)) {
		node.properties = node.properties || {};
		node.properties[SETTINGS_OPEN_PROPERTY] = false;
	}
	if (sizeSettingsOpen(node) && (modelSettingsOpen(node) || settingsOpen(node))) {
		node.properties = node.properties || {};
		node.properties[MODEL_SETTINGS_OPEN_PROPERTY] = false;
		node.properties[SETTINGS_OPEN_PROPERTY] = false;
	}
	if (promptSettingsOpen(node) && (modelSettingsOpen(node) || sizeSettingsOpen(node) || settingsOpen(node))) {
		node.properties = node.properties || {};
		node.properties[MODEL_SETTINGS_OPEN_PROPERTY] = false;
		node.properties[SIZE_SETTINGS_OPEN_PROPERTY] = false;
		node.properties[SETTINGS_OPEN_PROPERTY] = false;
	}
	const modelOpen = modelSettingsOpen(node);
	const sizeOpen = sizeSettingsOpen(node);
	const otherOpen = settingsOpen(node);
	const promptOpen = promptSettingsOpen(node);

	renderModelPanelControls(node, model.body);
	if (node.__gjjLoraContainer) {
		if (!node.__gjjLoraFloatingTitle) {
			const title = document.createElement("div");
			title.textContent = "🧩 LoRA";
			title.style.cssText = "margin-top:2px;padding-top:8px;border-top:1px solid #263842;color:#f2faf7;font-size:12px;font-weight:800";
			node.__gjjLoraFloatingTitle = title;
		}
		if (node.__gjjLoraFloatingTitle.parentElement !== model.body) {
			model.body.appendChild(node.__gjjLoraFloatingTitle);
		}
		if (node.__gjjLoraContainer.parentElement !== model.body) {
			model.body.appendChild(node.__gjjLoraContainer);
		}
		if (modelOpen && node.__gjjLoraRows && !node.__gjjLoraRows.children.length) {
			renderLoraUi(node);
		}
		node.__gjjLoraContainer.style.display = modelOpen ? "flex" : "none";
	}
	renderSizePanelControls(node, size.body);
	renderFloatingPanelControls(node, other.body, Array.from(OTHER_PANEL_WIDGETS));
	renderFloatingPanelControls(node, prompt.body, Array.from(PROMPT_PANEL_WIDGETS));

	model.panel.style.display = modelOpen ? "flex" : "none";
	size.panel.style.display = sizeOpen ? "flex" : "none";
	other.panel.style.display = otherOpen ? "flex" : "none";
	prompt.panel.style.display = promptOpen ? "flex" : "none";
	if (modelOpen) {
		positionFloatingPanel(node, model.panel, node.__gjjModelSettingsButton);
	}
	if (sizeOpen) {
		positionFloatingPanel(node, size.panel, node.__gjjInputSizeButton);
	}
	if (otherOpen) {
		positionFloatingPanel(node, other.panel, node.__gjjSettingsButton);
	}
	if (promptOpen) {
		positionFloatingPanel(node, prompt.panel, node.__gjjPromptSettingsButton);
	}
}

function positionOpenFloatingPanels(node) {
	if (!node) {
		return;
	}
	if (app.graph?._nodes && !app.graph._nodes.includes(node)) {
		if (node.__gjjLazyModelFloatingPanel?.panel) node.__gjjLazyModelFloatingPanel.panel.style.display = "none";
		if (node.__gjjLazySizeFloatingPanel?.panel) node.__gjjLazySizeFloatingPanel.panel.style.display = "none";
		if (node.__gjjLazyOtherFloatingPanel?.panel) node.__gjjLazyOtherFloatingPanel.panel.style.display = "none";
		if (node.__gjjLazyPromptFloatingPanel?.panel) node.__gjjLazyPromptFloatingPanel.panel.style.display = "none";
		return;
	}
	const model = node.__gjjLazyModelFloatingPanel;
	const size = node.__gjjLazySizeFloatingPanel;
	const other = node.__gjjLazyOtherFloatingPanel;
	const prompt = node.__gjjLazyPromptFloatingPanel;
	if (modelSettingsOpen(node) && model?.panel?.style.display !== "none") {
		positionFloatingPanel(node, model.panel, node.__gjjModelSettingsButton);
	}
	if (sizeSettingsOpen(node) && size?.panel?.style.display !== "none") {
		positionFloatingPanel(node, size.panel, node.__gjjInputSizeButton);
	}
	if (settingsOpen(node) && other?.panel?.style.display !== "none") {
		positionFloatingPanel(node, other.panel, node.__gjjSettingsButton);
	}
	if (promptSettingsOpen(node) && prompt?.panel?.style.display !== "none") {
		positionFloatingPanel(node, prompt.panel, node.__gjjPromptSettingsButton);
	}
	if (node.__gjjUnetModelPicker?.__gjjAnchor) {
		positionUnetModelPicker(node, node.__gjjUnetModelPicker, node.__gjjUnetModelPicker.__gjjAnchor);
	}
}

function positionAllOpenLazyFloatingPanels() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(node?.comfyClass || node?.type)) {
			positionOpenFloatingPanels(node);
		}
	}
}

function lazyFloatingContains(node, target) {
	if (!node || !target) {
		return false;
	}
	const contains = (element) => Boolean(element && (element === target || element.contains?.(target)));
	return (
		contains(node.__gjjLazyModelFloatingPanel?.panel)
		|| contains(node.__gjjLazySizeFloatingPanel?.panel)
		|| contains(node.__gjjLazyOtherFloatingPanel?.panel)
		|| contains(node.__gjjLazyPromptFloatingPanel?.panel)
		|| contains(node.__gjjModelSettingsButton)
		|| contains(node.__gjjInputSizeButton)
		|| contains(node.__gjjSettingsButton)
		|| contains(node.__gjjPromptSettingsButton)
		|| contains(node.__gjjLazyTestOverlay)
		|| contains(node.__gjjUnetModelPicker)
		|| (
			globalThis.__gjjLoraPopup?.state?.node === node
			&& (
				contains(globalThis.__gjjLoraPopup.panel)
				|| contains(globalThis.__gjjLoraPopup.state?.anchorEl)
			)
		)
	);
}

function closeLazyFloatingPanelsFromOutside(event) {
	const target = event?.target;
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass || node?.type)) {
			continue;
		}
		const hasOpenPanel = modelSettingsOpen(node) || sizeSettingsOpen(node) || settingsOpen(node) || promptSettingsOpen(node) || Boolean(node.__gjjLazyTestOverlay) || globalThis.__gjjLoraPopup?.state?.node === node;
		if (!hasOpenPanel || lazyFloatingContains(node, target)) {
			continue;
		}
		closeLazyFloatingSurfaces(node);
		applySettingsVisibility(node);
	}
}

function textValue(value) {
	return String(value ?? "").trim();
}

function isSeedControlValue(value) {
	return SEED_CONTROL_VALUES.has(textValue(value));
}

function isSeedControlWidget(widget) {
	const name = textValue(widget?.name).toLowerCase();
	if (/(control_after_generate|after_generate|seed.*control|randomize)/.test(name)) {
		return true;
	}
	return isSeedControlValue(widget?.value) && (widget?.hidden || String(widget?.type || "").toLowerCase() === "combo");
}

function findSeedControlWidget(node) {
	if (!Array.isArray(node?.widgets)) {
		return null;
	}
	const seedIndex = getWidgetIndex(node, "seed");
	const stepsIndex = getWidgetIndex(node, "steps");
	if (seedIndex >= 0 && stepsIndex > seedIndex + 1) {
		for (let index = seedIndex + 1; index < stepsIndex; index += 1) {
			const widget = node.widgets[index];
			if (isSeedControlWidget(widget) || isSeedControlValue(widget?.value)) {
				return widget;
			}
		}
	}
	return node.widgets.find((widget) => isSeedControlWidget(widget)) || null;
}

function shouldSerializeSeedControl(node) {
	return Boolean(findSeedControlWidget(node));
}

function optionValues(node, name) {
	const values = getWidget(node, name)?.options?.values;
	return Array.isArray(values) ? values.map((item) => String(item ?? "")) : [];
}

function fallbackParamValue(node, name) {
	if (name === SEED_CONTROL_KEY) {
		const widgetValue = textValue(findSeedControlWidget(node)?.value);
		if (isSeedControlValue(widgetValue)) {
			return widgetValue;
		}
		const storedValue = textValue(node?.properties?.[PARAM_VALUES_PROPERTY]?.[SEED_CONTROL_KEY]);
		if (isSeedControlValue(storedValue)) {
			return storedValue;
		}
		return DEFAULT_PARAM_VALUES[SEED_CONTROL_KEY];
	}
	const widget = getWidget(node, name);
	if (widget?.value !== undefined && widget?.value !== null && String(widget.value) !== "") {
		return widget.value;
	}
	const options = optionValues(node, name);
	if (options.length) {
		if (DEFAULT_PARAM_VALUES[name] && options.includes(String(DEFAULT_PARAM_VALUES[name]))) {
			return DEFAULT_PARAM_VALUES[name];
		}
		return options[0];
	}
	return DEFAULT_PARAM_VALUES[name];
}

function isNumericLike(value) {
	if (typeof value === "boolean") {
		return false;
	}
	const text = textValue(value);
	return text !== "" && /^-?\d+(\.\d+)?$/.test(text);
}

function isIntLike(value) {
	if (!isNumericLike(value)) {
		return false;
	}
	return Number.isInteger(Number(value));
}

function numberValue(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, numeric));
}

function intValue(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
	return Math.round(numberValue(value, fallback, min, max));
}

function comboLikeValue(name, value, node) {
	const text = textValue(value);
	if (!text) {
		return false;
	}
	const options = optionValues(node, name);
	if (options.includes(text)) {
		return true;
	}
	if (name === "unet_name" || name === "clip_name1" || name === "vae_name" || name === CHECKPOINT_WIDGET_NAME) {
		return text === "default" || /\.(safetensors|pt|pth|ckpt|bin|gguf)$/i.test(text);
	}
	if (name === MODEL_SOURCE_WIDGET_NAME) {
		return text === DEFAULT_PARAM_VALUES[MODEL_SOURCE_WIDGET_NAME] || text === CHECKPOINT_MODEL_SOURCE_VALUE;
	}
	if (name === "unet_dtype") {
		return ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2", "fp16", "bf16", "fp32"].includes(text.toLowerCase());
	}
	return false;
}

function coerceParamValue(name, value, node) {
	if (name === "prompt" || name === "negative_prompt") return String(value ?? "");
	if (name === "main_image_index") return intValue(value, fallbackParamValue(node, name), 1, 9999);
	if (name === "width" || name === "height") return intValue(value, fallbackParamValue(node, name), 64, 8192);
	if (name === "batch_size") return intValue(value, fallbackParamValue(node, name), 1, 64);
	if (name === "seed") return intValue(value, fallbackParamValue(node, name), 0, MAX_SEED_VALUE);
	if (name === "steps") return intValue(value, fallbackParamValue(node, name), 1, 10000);
	if (name === "cfg") return numberValue(value, fallbackParamValue(node, name), 0, 100);
	if (name === "denoise") return numberValue(value, fallbackParamValue(node, name), 0, 1);
	if (name === "grow_mask_by") return intValue(value, fallbackParamValue(node, name), 0, 64);
	if (name === SEED_CONTROL_KEY) return isSeedControlValue(value) ? textValue(value) : fallbackParamValue(node, name);
	if (name === BATCH_SOURCE_WIDGET) return String(value ?? "[]");
	if (name === KEEP_MODEL_WIDGET_NAME) return boolValue(value);
	if (name === DEVICE_PREFERENCE_WIDGET_NAME) return "智能调度";
	if (name === TEST_CONFIG_WIDGET_NAME) return String(value ?? "");
	if (name === USE_INPUT_IMAGE_SIZE_WIDGET_NAME) return boolValue(value);
	if (name === IMAGE_RESIZE_CONFIG_WIDGET_NAME) return JSON.stringify(normalizeImageResizeConfig(value));
	if (STRICT_MODEL_WIDGETS.has(name)) return normalizeStrictModelParam(node, name, value);
	if (name === MODEL_SOURCE_WIDGET_NAME) return comboLikeValue(name, value, node) ? textValue(value) : fallbackParamValue(node, name);
	if (MODEL_OPTIMIZATION_BOOLEAN_WIDGETS.has(name)) return boolValue(value);
	if (MODEL_OPTIMIZATION_COMBO_WIDGETS.has(name)) {
		return comboLikeValue(name, value, node) ? textValue(value) : fallbackParamValue(node, name);
	}
	return String(value ?? fallbackParamValue(node, name) ?? "");
}

function snapshotParamValues(source, node) {
	if (!source || typeof source !== "object") {
		return null;
	}
	const params = {};
	let found = false;
	for (const name of SERIALIZED_PARAM_WIDGETS) {
		if (Object.prototype.hasOwnProperty.call(source, name)) {
			params[name] = coerceParamValue(name, source[name], node);
			found = true;
		}
	}
	return found ? params : null;
}

function resolveMissingModelFamilies(params, node) {
	if (!params || typeof params !== "object") {
		return params;
	}
	const resolved = { ...params };
	for (const name of STRICT_MODEL_WIDGETS) {
		if (!Object.prototype.hasOwnProperty.call(resolved, name)) {
			continue;
		}
		const storedValue = textValue(resolved[name]);
		const choices = optionValues(node, name).map((value) => String(value ?? "")).filter(Boolean);
		if (!storedValue || !choices.length || choices.includes(storedValue)) {
			continue;
		}
		const storedFamilyKey = GJJ_Utils._modelTreeKey(GJJ_Utils._modelTreeFamilyStem(storedValue));
		if (!storedFamilyKey) {
			continue;
		}
		const familyChoice = choices.find((choice) => (
			GJJ_Utils._modelTreeKey(GJJ_Utils._modelTreeFamilyStem(choice)) === storedFamilyKey
		));
		if (familyChoice) {
			resolved[name] = familyChoice;
		}
	}
	return resolved;
}

function currentParamValues(node) {
	const params = {};
	for (const name of SERIALIZED_PARAM_WIDGETS) {
		if (name === SEED_CONTROL_KEY) {
			params[name] = fallbackParamValue(node, name);
			continue;
		}
		params[name] = coerceParamValue(name, getWidget(node, name)?.value, node);
	}
	return params;
}

function scoreSequentialParams(rawValues, offset, withSeedControl, node) {
	const raw = Array.isArray(rawValues) ? rawValues : [];
	const names = SERIALIZED_PARAM_WIDGETS.filter((name) => withSeedControl || name !== SEED_CONTROL_KEY);
	const firstAppendedIndex = names.indexOf(MODEL_SOURCE_WIDGET_NAME);
	const requiredLength = firstAppendedIndex >= 0 ? firstAppendedIndex : names.length;
	if (offset < 0 || offset + requiredLength > raw.length + 1) {
		return -1;
	}
	const valueAt = (name) => raw[offset + names.indexOf(name)];
	let score = 0;
	if (typeof valueAt("prompt") === "string") score += 1;
	if (typeof valueAt("negative_prompt") === "string") score += 1;
	if (isIntLike(valueAt("main_image_index"))) score += 5;
	if (isIntLike(valueAt("width"))) score += 6;
	if (isIntLike(valueAt("height"))) score += 6;
	if (isIntLike(valueAt("batch_size"))) score += 5;
	if (comboLikeValue("unet_name", valueAt("unet_name"), node)) score += 8;
	if (comboLikeValue("unet_dtype", valueAt("unet_dtype"), node)) score += 3;
	if (comboLikeValue("clip_name1", valueAt("clip_name1"), node)) score += 5;
	if (comboLikeValue("vae_name", valueAt("vae_name"), node)) score += 4;
	if (isIntLike(valueAt("seed"))) score += 6;
	if (!withSeedControl || isSeedControlValue(valueAt(SEED_CONTROL_KEY))) score += 5;
	if (isIntLike(valueAt("steps"))) score += 6;
	if (isNumericLike(valueAt("cfg"))) score += 5;
	if (comboLikeValue("sampler_name", valueAt("sampler_name"), node)) score += 5;
	if (comboLikeValue("scheduler", valueAt("scheduler"), node)) score += 5;
	if (isNumericLike(valueAt("denoise"))) score += 4;
	if (isIntLike(valueAt("grow_mask_by"))) score += 4;
	if (comboLikeValue(MODEL_SOURCE_WIDGET_NAME, valueAt(MODEL_SOURCE_WIDGET_NAME), node)) score += 3;
	if (comboLikeValue(CHECKPOINT_WIDGET_NAME, valueAt(CHECKPOINT_WIDGET_NAME), node)) score += 3;
	if (offset === 0) score += 1;
	return score;
}

function buildSequentialParams(rawValues, offset, withSeedControl, node) {
	const names = SERIALIZED_PARAM_WIDGETS.filter((name) => withSeedControl || name !== SEED_CONTROL_KEY);
	const params = {};
	for (const name of names) {
		params[name] = coerceParamValue(name, rawValues[offset + names.indexOf(name)], node);
	}
	if (!Object.prototype.hasOwnProperty.call(params, SEED_CONTROL_KEY)) {
		params[SEED_CONTROL_KEY] = fallbackParamValue(node, SEED_CONTROL_KEY);
	}
	return params;
}

function semanticParamValues(rawValues, node, serializedNode = null) {
	const fromProperties = snapshotParamValues(
		serializedNode?.properties?.[PARAM_VALUES_PROPERTY] || node?.properties?.[PARAM_VALUES_PROPERTY],
		node,
	);
	if (fromProperties) {
		return resolveMissingModelFamilies(fromProperties, node);
	}
	const raw = Array.isArray(rawValues) ? rawValues : [];
	let best = { score: -1, offset: 0, withSeedControl: shouldSerializeSeedControl(node) };
	for (let offset = 0; offset < raw.length; offset += 1) {
		for (const withSeedControl of [true, false]) {
			const score = scoreSequentialParams(raw, offset, withSeedControl, node);
			if (score > best.score) {
				best = { score, offset, withSeedControl };
			}
		}
	}
	if (best.score >= 45) {
		return resolveMissingModelFamilies(buildSequentialParams(raw, best.offset, best.withSeedControl, node), node);
	}
	return resolveMissingModelFamilies(snapshotParamValues(currentParamValues(node), node) || {}, node);
}

function serializedParamValues(params, node) {
	const values = [];
	for (const name of SERIALIZED_PARAM_WIDGETS) {
		if (name === SEED_CONTROL_KEY && !shouldSerializeSeedControl(node)) {
			continue;
		}
		const source = Object.prototype.hasOwnProperty.call(params || {}, name)
			? params[name]
			: fallbackParamValue(node, name);
		values.push(coerceParamValue(name, source, node));
	}
	return values;
}

function sameArrayValues(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
}

function applyParamValues(node, params) {
	if (!node || !params || typeof params !== "object") {
		return false;
	}
	let changed = false;
	for (const name of PANEL_SYNC_WIDGETS) {
		if (!Object.prototype.hasOwnProperty.call(params, name)) {
			continue;
		}
		const widget = getWidget(node, name);
		if (!widget) {
			continue;
		}
		if (!STRICT_MODEL_WIDGETS.has(name)) {
			ensureComboOption(widget, params[name]);
		}
		if (widget.value === params[name]) continue;
		setWidgetValue(widget, params[name]);
		changed = true;
	}
	const seedControlWidget = findSeedControlWidget(node);
	if (seedControlWidget && Object.prototype.hasOwnProperty.call(params, SEED_CONTROL_KEY) && seedControlWidget.value !== params[SEED_CONTROL_KEY]) {
		seedControlWidget.value = params[SEED_CONTROL_KEY];
		seedControlWidget.callback?.(seedControlWidget.value);
		changed = true;
	}
	if (Object.prototype.hasOwnProperty.call(params, KEEP_MODEL_WIDGET_NAME)) {
		applyKeepModelButtonState(node);
	}
	if (Object.prototype.hasOwnProperty.call(params, USE_INPUT_IMAGE_SIZE_WIDGET_NAME)) {
		applyInputSizeButtonState(node);
	}
	applySeedRandomButtonState(node);
	return changed;
}

function writeLiveParamSnapshot(node) {
	const params = currentParamValues(node);
	saveParamSnapshot(node, params);
	node.widgets_values = serializedParamValues(params, node).slice();
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
	return params;
}

function randomSeedValue() {
	return Math.floor(Math.random() * (JS_SAFE_MAX_SEED_VALUE + 1));
}

function applySeedControlBeforeQueue(node) {
	const seedWidget = getWidget(node, "seed");
	if (!seedWidget) {
		return null;
	}
	const now = Date.now();
	if (node.__gjjLazySeedPreparedAt && now - node.__gjjLazySeedPreparedAt < 500) {
		return intValue(seedWidget.value, 0, 0, JS_SAFE_MAX_SEED_VALUE);
	}
	const mode = fallbackParamValue(node, SEED_CONTROL_KEY);
	const currentSeed = intValue(seedWidget.value, 0, 0, JS_SAFE_MAX_SEED_VALUE);
	let nextSeed = currentSeed;
	if (mode === "randomize") {
		nextSeed = randomSeedValue();
	} else if (mode === "increment") {
		nextSeed = currentSeed >= JS_SAFE_MAX_SEED_VALUE ? 0 : currentSeed + 1;
	} else if (mode === "decrement") {
		nextSeed = currentSeed <= 0 ? JS_SAFE_MAX_SEED_VALUE : currentSeed - 1;
	} else {
		return currentSeed;
	}
	setWidgetValue(seedWidget, nextSeed);
	node.__gjjLazySeedPreparedAt = now;
	writeLiveParamSnapshot(node);
	return nextSeed;
}

function syncSeedControlWidget(node) {
	const widget = findSeedControlWidget(node);
	if (!widget || widget.__gjjLazySeedControlHooked) {
		applySeedRandomButtonState(node);
		return;
	}
	widget.__gjjLazySeedControlHooked = true;
	const storedParams = node?.properties?.[PARAM_VALUES_PROPERTY] || {};
	const storedValue = textValue(storedParams[SEED_CONTROL_KEY]);
	const nextValue = isSeedControlValue(storedValue) ? storedValue : DEFAULT_PARAM_VALUES[SEED_CONTROL_KEY];
	if (widget.value !== nextValue) {
		setWidgetValue(widget, nextValue);
		const params = currentParamValues(node);
		params[SEED_CONTROL_KEY] = nextValue;
		saveParamSnapshot(node, params);
		node.widgets_values = serializedParamValues(params, node).slice();
	}
	const originalCallback = widget.callback;
	widget.callback = function (value, ...args) {
		const result = originalCallback?.apply(this, [value, ...args]);
		const mode = textValue(value);
		if (isSeedControlValue(mode)) {
			const params = currentParamValues(node);
			params[SEED_CONTROL_KEY] = mode;
			saveParamSnapshot(node, params);
			node.widgets_values = serializedParamValues(params, node).slice();
			applySeedRandomButtonState(node);
		}
		return result;
	};
	applySeedRandomButtonState(node);
}

function patchLazySeedIntoPromptData(promptData) {
	const output = promptData?.output || promptData?.prompt;
	if (!output || typeof output !== "object") {
		return promptData;
	}
	const nodes = Array.isArray(app.graph?._nodes) ? app.graph._nodes : [];
	for (const [key, entry] of Object.entries(output)) {
		if (!TARGET_NODES.has(entry?.class_type)) {
			continue;
		}
		const node = nodes.find((item) => String(item?.id) === String(key) && TARGET_NODES.has(item?.comfyClass || item?.type));
		if (!node) {
			continue;
		}
		const seed = applySeedControlBeforeQueue(node);
		entry.inputs = entry.inputs || {};
		if (seed !== null && seed !== undefined) {
			entry.inputs.seed = seed;
		}
		entry.inputs[USE_INPUT_IMAGE_SIZE_WIDGET_NAME] = inputSizeSyncEnabled(node);
		entry.inputs[IMAGE_RESIZE_CONFIG_WIDGET_NAME] = JSON.stringify(readImageResizeConfig(node));
		for (const name of STRICT_MODEL_WIDGETS) {
			if (Object.prototype.hasOwnProperty.call(entry.inputs, name)) {
				entry.inputs[name] = normalizeStrictModelParam(node, name, entry.inputs[name]);
			}
		}
		if (promptData?.prompt && promptData.prompt !== promptData.output && promptData.prompt[key]) {
			promptData.prompt[key].inputs = promptData.prompt[key].inputs || {};
			if (seed !== null && seed !== undefined) {
				promptData.prompt[key].inputs.seed = seed;
			}
			promptData.prompt[key].inputs[USE_INPUT_IMAGE_SIZE_WIDGET_NAME] = inputSizeSyncEnabled(node);
			promptData.prompt[key].inputs[IMAGE_RESIZE_CONFIG_WIDGET_NAME] = JSON.stringify(readImageResizeConfig(node));
			for (const name of STRICT_MODEL_WIDGETS) {
				if (Object.prototype.hasOwnProperty.call(promptData.prompt[key].inputs, name)) {
					promptData.prompt[key].inputs[name] = normalizeStrictModelParam(node, name, promptData.prompt[key].inputs[name]);
				}
			}
		}
	}
	return promptData;
}

function installLazySeedPromptPatch() {
	if (app.__gjjLazyImageStudioSeedPromptPatchInstalled || typeof app.graphToPrompt !== "function") {
		return;
	}
	app.__gjjLazyImageStudioSeedPromptPatchInstalled = true;
	const originalGraphToPrompt = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		const result = await originalGraphToPrompt(...args);
		return patchLazySeedIntoPromptData(result);
	};
}

function saveParamSnapshot(node, params) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	node.properties[PARAM_VALUES_PROPERTY] = { ...params };
}

function sanitizeSerializedNodeWidgets(serializedNode, node) {
	if (!serializedNode || !Array.isArray(serializedNode.widgets_values)) {
		return false;
	}
	const params = semanticParamValues(serializedNode.widgets_values, node, serializedNode);
	const fixed = serializedParamValues(params, node);
	const changed = !sameArrayValues(serializedNode.widgets_values, fixed);
	serializedNode.widgets_values = fixed;
	serializedNode.properties = serializedNode.properties || {};
	serializedNode.properties[PARAM_VALUES_PROPERTY] = { ...params };
	return changed;
}

function repairLiveWidgetValues(node, sourceValues = null, serializedNode = null) {
	const params = semanticParamValues(sourceValues, node, serializedNode);
	const changed = applyParamValues(node, params);
	const fixed = serializedParamValues(params, node);
	node.widgets_values = fixed.slice();
	saveParamSnapshot(node, params);
	if (changed) {
		GJJ_Utils.refreshNode(node);
		app.graph?.setDirtyCanvas?.(true, true);
	}
	return changed;
}

function writeSerializedWidgetValues(node, serializedNode) {
	if (!node || !serializedNode) {
		return;
	}
	const params = currentParamValues(node);
	saveParamSnapshot(node, params);
	serializedNode.properties = serializedNode.properties || {};
	serializedNode.properties[PARAM_VALUES_PROPERTY] = { ...params };
	serializedNode.properties[TEST_FILTER_PROPERTY] = lazyTestFilters(node);
	serializedNode.properties[TEST_SORT_PROPERTY] = lazyTestSorts(node);
	serializedNode.properties[TEST_STRENGTH_PROPERTY] = lazyTestStrengthSettings(node);
	persistLoraRows(node, ensureLoraNodeState(node).rows, serializedNode);
	const fixed = serializedParamValues(params, node);
	serializedNode.widgets_values = fixed;
	node.widgets_values = fixed.slice();
}

function preferredValue(values, desired) {
	const list = Array.isArray(values) ? values.map((item) => String(item ?? "")) : [];
	const wanted = String(desired || "").trim();
	if (!wanted) {
		return list[0] || "";
	}
	if (list.includes(wanted)) {
		return wanted;
	}
	const wantedBase = wanted.split(/[\\/]/).pop() || wanted;
	const wantedCanonical = canonicalizeText(wantedBase);
	const wantedFamily = canonicalizeText(modelFamilyStem(wantedBase));
	let best = "";
	let bestScore = -1;
	for (const candidate of list) {
		const candidateBase = candidate.split(/[\\/]/).pop() || candidate;
		const candidateCanonical = canonicalizeText(candidateBase);
		const fullCanonical = canonicalizeText(candidate);
		const candidateFamily = canonicalizeText(modelFamilyStem(candidateBase));
		let score = -1;
		if (candidate === wanted || candidateBase === wantedBase) {
			score = 1000;
		} else if (candidateCanonical === wantedCanonical || fullCanonical === wantedCanonical) {
			score = 900;
		} else if (wantedFamily && candidateFamily === wantedFamily) {
			score = 850;
		} else if (wantedCanonical && (candidateCanonical.includes(wantedCanonical) || fullCanonical.includes(wantedCanonical))) {
			score = 700 - Math.max(0, candidateCanonical.length - wantedCanonical.length);
		}
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best || list[0] || wanted;
}

function resolveLoraValue(values, desired) {
	const list = Array.isArray(values) ? values.map((item) => String(item ?? "")).filter(Boolean) : [];
	const wanted = String(desired || "").trim();
	if (!wanted) {
		return "";
	}
	if (list.includes(wanted)) {
		return wanted;
	}
	const wantedBase = wanted.split(/[\\/]/).pop() || wanted;
	const wantedCanonical = canonicalizeText(wantedBase);
	let best = "";
	let bestScore = -1;
	for (const candidate of list) {
		const candidateBase = candidate.split(/[\\/]/).pop() || candidate;
		const candidateCanonical = canonicalizeText(candidateBase);
		const fullCanonical = canonicalizeText(candidate);
		let score = -1;
		if (candidateBase === wantedBase) {
			score = 1000;
		} else if (candidateCanonical === wantedCanonical || fullCanonical === wantedCanonical) {
			score = 900;
		} else if (wantedCanonical && (candidateCanonical.includes(wantedCanonical) || fullCanonical.includes(wantedCanonical))) {
			score = 700 - Math.max(0, candidateCanonical.length - wantedCanonical.length);
		}
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best || wanted;
}

function getImageInputs(node) {
	return (node.inputs || [])
		.filter((input) => String(input?.name || "").startsWith(IMAGE_PREFIX))
		.sort((a, b) => {
			const ai = Number.parseInt(String(a?.name || "").slice(IMAGE_PREFIX.length), 10) || 9999;
			const bi = Number.parseInt(String(b?.name || "").slice(IMAGE_PREFIX.length), 10) || 9999;
			return ai - bi;
		});
}

function addImageInput(node) {
	if (!getInput(node, PRIMARY_IMAGE_INPUT)) {
		node.addInput?.(PRIMARY_IMAGE_INPUT, BATCH_IMAGE_TYPE);
	}
}

function hasLinked(input) {
	return Boolean(input?.link);
}

function trimUnusedImageInputs(node) {
	const inputs = getImageInputs(node);
	for (let index = inputs.length - 1; index >= 0; index -= 1) {
		const input = inputs[index];
		if (String(input?.name || "") === PRIMARY_IMAGE_INPUT && index === 0) {
			continue;
		}
		const slot = node.inputs?.indexOf(input) ?? -1;
		if (slot >= 0) {
			if (hasLinked(input)) node.disconnectInput?.(slot);
			node.removeInput?.(slot);
		}
	}
}

function ensureTrailingImageInput(node) {
	if (!getInput(node, PRIMARY_IMAGE_INPUT)) addImageInput(node);
	trimUnusedImageInputs(node);
}

function renameImageInputs(node) {
	trimUnusedImageInputs(node);
	const input = getInput(node, PRIMARY_IMAGE_INPUT) || getImageInputs(node)[0];
	if (input) {
		input.name = PRIMARY_IMAGE_INPUT;
		input.type = BATCH_IMAGE_TYPE;
		input.label = "批量图片";
		input.localized_name = input.label;
		input.tooltip = PRIMARY_IMAGE_TOOLTIP;
	}
	const maskInput = getInput(node, MAIN_MASK_INPUT);
	if (maskInput) {
		maskInput.type = "MASK";
		maskInput.label = "主图遮罩";
		maskInput.localized_name = "主图遮罩";
		maskInput.tooltip = MASK_TOOLTIP;
	}
}

function cleanupRedundantMultiLoaderLinks(node) {
	const primary = getInput(node, PRIMARY_IMAGE_INPUT);
	const primaryLinkId = primary?.link;
	if (!primaryLinkId || !app.graph?.links) {
		return;
	}
	const primaryLink = app.graph.links[primaryLinkId];
	const sourceNode = primaryLink?.origin_id != null ? app.graph.getNodeById?.(primaryLink.origin_id) : null;
	if (sourceNode?.comfyClass !== "GJJ_MultiImageLoader" || Number(primaryLink?.origin_slot) !== 0) {
		return;
	}
	getImageInputs(node).forEach((input, idx) => {
		if (idx === 0 || !input?.link) {
			return;
		}
		const link = app.graph.links[input.link];
		if (!link || link.origin_id !== primaryLink.origin_id) {
			return;
		}
		const inputIndex = node.inputs?.indexOf(input) ?? -1;
		if (inputIndex >= 0) {
			node.disconnectInput?.(inputIndex);
		}
	});
}

function buildMultiLoaderSelectionPayload(sourceNode) {
	const widget = getWidget(sourceNode, "selected_images");
	const raw = String(widget?.value || "[]").trim();
	return raw || "[]";
}

function syncBatchSourceWidget(node) {
	const widget = getWidget(node, BATCH_SOURCE_WIDGET);
	if (!widget) {
		applyReferenceBrowserButtonState(node);
		return;
	}
	const primary = getInput(node, PRIMARY_IMAGE_INPUT);
	const linkId = primary?.link;
	if (!linkId || !app.graph?.links) {
		applyReferenceBrowserButtonState(node);
		return;
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	if (sourceNode?.comfyClass !== "GJJ_MultiImageLoader" || Number(link?.origin_slot) !== 0) {
		applyReferenceBrowserButtonState(node);
		return;
	}
	widget.value = buildMultiLoaderSelectionPayload(sourceNode);
	applyReferenceBrowserButtonState(node);
}

function loadImageDimensions(url) {
	return new Promise((resolve) => {
		if (!url) {
			resolve(null);
			return;
		}
		const image = new Image();
		image.onload = () => resolve({
			width: Number(image.naturalWidth || 0),
			height: Number(image.naturalHeight || 0),
		});
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

function roundToEight(value) {
	return Math.max(8, Math.round(Number(value || 0) / 8) * 8);
}

function getLinkedWidgetInput(node, widgetName) {
	return (node.inputs || []).find((input) => (
		input?.link != null &&
		(String(input?.widget?.name || "") === widgetName || String(input?.name || "") === widgetName)
	)) || null;
}

function readResizeNodeConfig(sourceNode) {
	const cfg = sourceNode?.properties?.gjj_mf_resize_config;
	if (cfg && typeof cfg === "object") {
		return cfg;
	}
	const widget = getWidget(sourceNode, "config_json");
	try {
		const parsed = JSON.parse(String(widget?.value || "{}"));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function inferExternalOutputValue(link, targetWidgetName = "") {
	if (!link || !app.graph) {
		return undefined;
	}
	const sourceNode = link.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const output = sourceNode?.outputs?.[Number(link.origin_slot || 0)];
	const outputName = String(output?.name || output?.label || "").trim();
	if (!sourceNode || !outputName) {
		return undefined;
	}
	const liveValue = sourceNode.__gjjLastOutputValues?.[Number(link.origin_slot || 0)];
	if (liveValue !== undefined && liveValue !== null && String(liveValue) !== "") {
		return liveValue;
	}
	if (sourceNode.comfyClass === "GJJ_ImageResizeKJv2") {
		const cfg = readResizeNodeConfig(sourceNode);
		if (cfg) {
			const slotKey = Array.isArray(cfg.extra_outputs)
				? cfg.extra_outputs[Number(link.origin_slot || 0) - 2]
				: "";
			if (targetWidgetName === "width") return Number(cfg.width || 0) || undefined;
			if (targetWidgetName === "height") return Number(cfg.height || 0) || undefined;
			if (slotKey === "output_width" || outputName.includes("宽度")) return Number(cfg.width || 0) || undefined;
			if (slotKey === "output_height" || outputName.includes("高度")) return Number(cfg.height || 0) || undefined;
		}
	}
	const candidateWidgetNames = [
		outputName,
		"value",
		"int",
		"float",
		"number",
		"text",
		"string",
		"seed",
	];
	for (const name of candidateWidgetNames) {
		const widget = getWidget(sourceNode, name);
		if (widget?.value !== undefined && widget?.value !== null && String(widget.value) !== "") {
			return widget.value;
		}
	}
	return undefined;
}

function externalPanelSignature(node) {
	const parts = [];
	for (const widgetName of PANEL_SYNC_WIDGETS) {
		const input = getLinkedWidgetInput(node, widgetName);
		if (!input?.link || !app.graph?.links) {
			continue;
		}
		const link = app.graph.links[input.link];
		const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
		const resizeCfg = sourceNode?.comfyClass === "GJJ_ImageResizeKJv2" ? readResizeNodeConfig(sourceNode) : null;
		const widgetValues = (sourceNode?.widgets || []).map((widget) => [widget?.name, widget?.value]);
		const liveValue = sourceNode?.__gjjLastOutputValues?.[Number(link?.origin_slot || 0)];
		parts.push([widgetName, link?.origin_id, link?.origin_slot, resizeCfg, widgetValues, liveValue]);
	}
	return JSON.stringify(parts);
}

function applyEffectiveParamsToPanel(node, params, onlyLinked = false) {
	if (!params || typeof params !== "object") {
		return;
	}
	const unetLinked = Boolean(getLinkedWidgetInput(node, "unet_name"));
	for (const widgetName of PANEL_SYNC_WIDGETS) {
		const allowPresetCompanion =
			unetLinked && (widgetName === "clip_name1" || widgetName === "vae_name");
		if (onlyLinked && !allowPresetCompanion && !getLinkedWidgetInput(node, widgetName)) {
			continue;
		}
		if (!Object.prototype.hasOwnProperty.call(params, widgetName)) {
			continue;
		}
		const widget = getWidget(node, widgetName);
		const oldValue = widget?.value;
		setWidgetValue(widget, params[widgetName]);
		if (widgetName === "unet_name" && String(oldValue || "") !== String(params[widgetName] || "")) {
			try {
				widget?.callback?.call(widget, params[widgetName], node, widget);
			} catch (error) {
				console.warn("[GJJ_LazyImageStudio] preset sync failed:", error);
			}
		}
	}
}

function syncPanelFromLinkedSources(node) {
	const values = {};
	for (const widgetName of PANEL_SYNC_WIDGETS) {
		const input = getLinkedWidgetInput(node, widgetName);
		if (!input?.link || !app.graph?.links) {
			continue;
		}
		const value = inferExternalOutputValue(app.graph.links[input.link], widgetName);
		if (value !== undefined && value !== null && String(value) !== "") {
			values[widgetName] = value;
		}
	}
	const promptValues = upstreamPromptTranslationValues(values);
	const promptSignature = upstreamPromptTranslationSignature(promptValues);
	if (
		translationEnabled(node)
		&& promptSignature
		&& node.__gjjLazyLastUpstreamTranslation?.signature === promptSignature
	) {
		Object.assign(values, node.__gjjLazyLastUpstreamTranslation.values || {});
	}
	applyEffectiveParamsToPanel(node, values, true);
	updateUpstreamTranslationWatcher(node, translationEnabled(node) && hasLinkedPromptTranslationInput(node));
	if (translationEnabled(node) && promptSignature) {
		scheduleUpstreamPromptTranslation(node, promptValues, promptSignature, 180);
	}
}

async function largestMultiImageLoaderSize(sourceNode) {
	const widget = getWidget(sourceNode, "selected_images");
	let items = [];
	try {
		items = JSON.parse(String(widget?.value || "[]"));
	} catch {
		items = [];
	}
	items = Array.isArray(items) ? items : [];
	if (!items.length) {
		return null;
	}
	const sizes = await Promise.all(items.map((item) => {
		const filename = String(item?.filename || "").trim();
		const type = String(item?.type || "input").trim() || "input";
		const subfolder = String(item?.subfolder || "").trim();
		const url = `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`;
		return loadImageDimensions(url);
	}));
	let best = null;
	let area = -1;
	for (const size of sizes) {
		if (!size) {
			continue;
		}
		const nextArea = Number(size.width || 0) * Number(size.height || 0);
		if (!best || nextArea > area) {
			best = size;
			area = nextArea;
		}
	}
	return best;
}

async function syncSizeFromPrimaryInput(node) {
	applyInputSizeButtonState(node);
	if (!inputSizeSyncEnabled(node)) {
		if (node?.properties) {
			delete node.properties[IMAGE_SIZE_SIGNATURE_PROPERTY];
		}
		return;
	}
	if (getLinkedWidgetInput(node, "width") || getLinkedWidgetInput(node, "height")) {
		return;
	}
	if (node.__gjjLazyImageSizeSyncRunning) {
		return;
	}
	const primary = getInput(node, PRIMARY_IMAGE_INPUT);
	const linkId = primary?.link;
	if (!linkId || !app.graph?.links) {
		return;
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	if (!sourceNode) {
		return;
	}
	node.__gjjLazyImageSizeSyncRunning = true;
	try {
		let size = null;
		let signature = "";
		if (sourceNode.comfyClass === "GJJ_MultiImageLoader") {
			const selected = String(getWidget(sourceNode, "selected_images")?.value || "");
			signature = JSON.stringify(["multi", link.origin_id, link.origin_slot, selected]);
			size = await largestMultiImageLoaderSize(sourceNode);
		} else if (["LoadImage", "LoadImageOutput"].includes(sourceNode.comfyClass)) {
			const imageWidget = getWidget(sourceNode, "image");
			const filename = String(imageWidget?.value || "").trim();
			const type = sourceNode.comfyClass === "LoadImage" ? "input" : "output";
			signature = JSON.stringify(["load", link.origin_id, link.origin_slot, type, filename]);
			if (filename) {
				size = await loadImageDimensions(
					`/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=&rand=${Date.now()}`
				);
			}
		} else if (sourceNode.comfyClass === "GJJ_ImageResizeKJv2") {
			const cfg = readResizeNodeConfig(sourceNode);
			if (cfg) {
				const width = Number(cfg.width || 0);
				const height = Number(cfg.height || 0);
				signature = JSON.stringify(["resize", link.origin_id, link.origin_slot, width, height, cfg.mode || "", cfg.ratio || ""]);
				if (width > 0 && height > 0) {
					size = { width, height };
				}
			}
		} else if (sourceNode.comfyClass === "GJJ_PenMaskEditor") {
			const imageSize = sourceNode.properties?.gjj_pen_mask_image_size || {};
			const width = Number(imageSize.width || sourceNode.__gjjPenMaskEditor?.imageWidth || 0);
			const height = Number(imageSize.height || sourceNode.__gjjPenMaskEditor?.imageHeight || 0);
			const imageFile = String(getWidget(sourceNode, "image_file")?.value || "");
			signature = JSON.stringify(["pen-mask", link.origin_id, link.origin_slot, width, height, imageFile, imageSize.source || ""]);
			if (width > 0 && height > 0) {
				size = { width, height };
			}
		}
		if (!size || !signature) {
			return;
		}
		node.properties = node.properties || {};
		if (node.properties[IMAGE_SIZE_SIGNATURE_PROPERTY] === signature) {
			return;
		}
		setWidgetValue(getWidget(node, "width"), roundToEight(size.width));
		setWidgetValue(getWidget(node, "height"), roundToEight(size.height));
		node.properties[IMAGE_SIZE_SIGNATURE_PROPERTY] = signature;
		writeLiveParamSnapshot(node);
		syncFloatingPanels(node);
	} finally {
		node.__gjjLazyImageSizeSyncRunning = false;
	}
}

function modelMatchesTestFilter(item, query) {
	return textMatchesModelFilter(`${item?.name || ""} ${item?.size || ""}`, query);
}

async function fetchLazyTestModels(kind, node) {
	try {
		const response = await api.fetchApi(`/gjj/lazy-image-studio/test-models?kind=${encodeURIComponent(kind)}`);
		if (response?.ok) {
			const data = await response.json();
			const models = Array.isArray(data?.models) ? data.models : [];
			if (models.length) {
				return models.map((item) => ({
					name: String(item?.name || ""),
					size: String(item?.size || ""),
					bytes: Number(item?.bytes || 0),
				})).filter((item) => item.name);
			}
		}
	} catch (error) {
		console.warn("[GJJ LazyImageStudio] 测试模型列表接口不可用，改用本地选项", error);
	}
	if (kind === "lora") {
		await refreshLoraOptions(node, false);
		const names = getLoraOptions().map((item) => String(item?.value || item?.name || "")).filter(Boolean);
		return names.map((name) => ({ name, size: "", bytes: 0 }));
	}
	if (kind === "checkpoint") {
		return optionValues(node, CHECKPOINT_WIDGET_NAME).filter(Boolean).map((name) => ({ name, size: "", bytes: 0 }));
	}
	return optionValues(node, "unet_name").filter(Boolean).map((name) => ({ name, size: "", bytes: 0 }));
}

function writeLazyTestConfig(node, config) {
	const widget = getWidget(node, TEST_CONFIG_WIDGET_NAME);
	if (widget) {
		setWidgetValue(widget, JSON.stringify(config || {}));
	}
	node.properties = node.properties || {};
	node.properties[`${TEST_CONFIG_WIDGET_NAME}_last`] = config || {};
	writeLiveParamSnapshot(node);
}

function clearLazyTestConfig(node) {
	const widget = getWidget(node, TEST_CONFIG_WIDGET_NAME);
	if (widget) {
		setWidgetValue(widget, "");
	}
	writeLiveParamSnapshot(node);
}

function lazyTestFilters(node) {
	const filters = node?.properties?.[TEST_FILTER_PROPERTY];
	if (filters && typeof filters === "object" && !Array.isArray(filters)) {
		return {
			unet: String(filters.unet || ""),
			lora: String(filters.lora || ""),
			lora_strength: String(filters.lora_strength || filters.lora || ""),
			checkpoint: String(filters.checkpoint || ""),
			sampler: String(filters.sampler || ""),
			scheduler: String(filters.scheduler || ""),
		};
	}
	return { unet: "", lora: "", lora_strength: "", checkpoint: "", sampler: "", scheduler: "" };
}

function saveLazyTestFilter(node, kind, value) {
	if (!node || !["unet", "lora", "lora_strength", "checkpoint", "sampler", "scheduler"].includes(kind)) {
		return;
	}
	node.properties = node.properties || {};
	const filters = lazyTestFilters(node);
	filters[kind] = String(value || "");
	node.properties[TEST_FILTER_PROPERTY] = filters;
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function lazyTestSorts(node) {
	const sorts = node?.properties?.[TEST_SORT_PROPERTY];
	if (sorts && typeof sorts === "object" && !Array.isArray(sorts)) {
		return {
			unet: String(sorts.unet || "name_asc"),
			lora: String(sorts.lora || "name_asc"),
			lora_strength: String(sorts.lora_strength || sorts.lora || "name_asc"),
			checkpoint: String(sorts.checkpoint || "name_asc"),
			sampler: String(sorts.sampler || "name_asc"),
			scheduler: String(sorts.scheduler || "name_asc"),
		};
	}
	return { unet: "name_asc", lora: "name_asc", lora_strength: "name_asc", checkpoint: "name_asc", sampler: "name_asc", scheduler: "name_asc" };
}

function saveLazyTestSort(node, kind, value) {
	if (!node || !["unet", "lora", "lora_strength", "checkpoint", "sampler", "scheduler"].includes(kind)) {
		return;
	}
	node.properties = node.properties || {};
	const sorts = lazyTestSorts(node);
	sorts[kind] = String(value || "name_asc");
	node.properties[TEST_SORT_PROPERTY] = sorts;
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function lazyTestStrengthSettings(node) {
	const settings = node?.properties?.[TEST_STRENGTH_PROPERTY];
	const start = Number.parseFloat(String(settings?.start ?? "0.2"));
	const end = Number.parseFloat(String(settings?.end ?? "1.2"));
	const step = Number.parseFloat(String(settings?.step ?? "0.2"));
	return {
		start: Number.isFinite(start) ? start : 0.2,
		end: Number.isFinite(end) ? end : 1.2,
		step: Number.isFinite(step) && Math.abs(step) > 1e-6 ? Math.abs(step) : 0.2,
	};
}

function saveLazyTestStrengthSettings(node, values = {}) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	const current = lazyTestStrengthSettings(node);
	node.properties[TEST_STRENGTH_PROPERTY] = {
		start: values.start ?? current.start,
		end: values.end ?? current.end,
		step: values.step ?? current.step,
	};
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function sortedLazyTestModels(items, sortKey) {
	const list = Array.isArray(items) ? [...items] : [];
	const name = (item) => String(item?.name || "").toLowerCase();
	const bytes = (item) => Number(item?.bytes || 0);
	if (sortKey === "name_desc") {
		list.sort((a, b) => name(b).localeCompare(name(a), "zh-Hans") || bytes(b) - bytes(a));
	} else if (sortKey === "size_desc") {
		list.sort((a, b) => bytes(b) - bytes(a) || name(a).localeCompare(name(b), "zh-Hans"));
	} else if (sortKey === "size_asc") {
		list.sort((a, b) => bytes(a) - bytes(b) || name(a).localeCompare(name(b), "zh-Hans"));
	} else {
		list.sort((a, b) => name(a).localeCompare(name(b), "zh-Hans") || bytes(b) - bytes(a));
	}
	return list;
}

function selectedLazyTestModels(panel) {
	return [...panel.querySelectorAll("input[data-model-name]:checked")]
		.map((input) => input.dataset.modelName)
		.filter(Boolean);
}

function selectedLazyTestModel(panel) {
	const input = panel.querySelector("input[data-model-name]:checked");
	return input?.dataset?.modelName || "";
}

function parseLazyStrengthValue(input, fallback) {
	const value = Number.parseFloat(String(input?.value ?? "").trim());
	return Number.isFinite(value) ? value : fallback;
}

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function openLazyTestDialog(node, testButton, generateButton) {
	closeLazyFloatingSurfaces(node, "test");
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.62);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;";
	const panel = document.createElement("div");
	panel.style.cssText = "width:min(760px,calc(100vw - 28px));height:min(640px,calc(100vh - 28px));border:1px solid #40525b;border-radius:8px;background:#0f171b;color:#e7f2f4;box-shadow:0 22px 60px rgba(0,0,0,.56);display:flex;flex-direction:column;font:12px/1.4 system-ui,'Microsoft YaHei',sans-serif;overflow:hidden;";
	panel.innerHTML = `
		<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2c3e45;">
			<div style="font-weight:800;font-size:14px;flex:1 1 auto;">🧪 模型测试</div>
			<button data-close style="width:28px;height:28px;border:1px solid #465a62;border-radius:6px;background:#17242a;color:#e7f2f4;cursor:pointer;">×</button>
		</div>
		<div data-tabs style="display:flex;gap:6px;padding:9px 12px 0;"></div>
		<div style="display:flex;gap:8px;padding:9px 12px;">
			<input data-filter placeholder="关键词过滤；-XXX 排除，| 分组" title="示例：mage -turbo 表示包含 mage 且不含 turbo；mage-flow 中间的连字符不受影响。" style="flex:1 1 auto;height:30px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 9px;outline:none;">
			<button data-select-all style="height:30px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 9px;font-weight:700;">全选</button>
			<button data-clear style="height:30px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 9px;font-weight:700;">清空</button>
		</div>
		<div data-sort-tools style="display:flex;align-items:center;gap:6px;padding:0 12px 8px;flex-wrap:wrap;">
			<span style="color:#91a7ad;font-weight:700;">排序</span>
		</div>
		<div data-strength-tools style="display:none;align-items:center;gap:8px;padding:0 12px 8px;flex-wrap:wrap;">
			<label style="display:flex;align-items:center;gap:5px;color:#cbdce0;font-weight:700;">起始
				<input data-strength-start type="number" step="0.05" value="0.2" style="width:74px;height:26px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 7px;outline:none;">
			</label>
			<label style="display:flex;align-items:center;gap:5px;color:#cbdce0;font-weight:700;">结束
				<input data-strength-end type="number" step="0.05" value="1.2" style="width:74px;height:26px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 7px;outline:none;">
			</label>
			<label style="display:flex;align-items:center;gap:5px;color:#cbdce0;font-weight:700;">步长
				<input data-strength-step type="number" step="0.05" value="0.2" style="width:74px;height:26px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 7px;outline:none;">
			</label>
		</div>
		<div data-status style="padding:0 12px 6px;color:#91a7ad;min-height:18px;"></div>
		<div data-list style="flex:1 1 auto;overflow:auto;padding:0 12px 12px;display:flex;flex-direction:column;gap:5px;"></div>
		<div style="display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid #2c3e45;">
			<button data-cancel style="height:32px;border:1px solid #4b5f67;border-radius:6px;background:#17242a;color:#dce7e2;cursor:pointer;padding:0 12px;font-weight:700;">取消</button>
			<button data-ok style="height:32px;border:1px solid #10b981;border-radius:6px;background:linear-gradient(135deg,#064e3b,#059669);color:#d1fae5;cursor:pointer;padding:0 14px;font-weight:800;">确定</button>
		</div>
	`;
	overlay.appendChild(panel);
	document.body.appendChild(overlay);
	node.__gjjLazyTestOverlay = overlay;

	const savedFilters = lazyTestFilters(node);
	const savedSorts = lazyTestSorts(node);
	const savedStrength = lazyTestStrengthSettings(node);
	const state = {
		kind: "unet",
		models: { unet: [], lora: [], checkpoint: [], sampler: [], scheduler: [] },
		filters: { unet: savedFilters.unet, lora: savedFilters.lora, lora_strength: savedFilters.lora_strength, checkpoint: savedFilters.checkpoint, sampler: savedFilters.sampler, scheduler: savedFilters.scheduler },
		sorts: { unet: savedSorts.unet, lora: savedSorts.lora, lora_strength: savedSorts.lora_strength, checkpoint: savedSorts.checkpoint, sampler: savedSorts.sampler, scheduler: savedSorts.scheduler },
	};
	const list = panel.querySelector("[data-list]");
	const status = panel.querySelector("[data-status]");
	const filterInput = panel.querySelector("[data-filter]");
	const tabs = panel.querySelector("[data-tabs]");
	const sortTools = panel.querySelector("[data-sort-tools]");
	const strengthTools = panel.querySelector("[data-strength-tools]");
	const strengthStartInput = panel.querySelector("[data-strength-start]");
	const strengthEndInput = panel.querySelector("[data-strength-end]");
	const strengthStepInput = panel.querySelector("[data-strength-step]");
	const selectAllButton = panel.querySelector("[data-select-all]");
	filterInput.value = state.filters[state.kind] || "";
	strengthStartInput.value = String(savedStrength.start);
	strengthEndInput.value = String(savedStrength.end);
	strengthStepInput.value = String(savedStrength.step);

	function renderTabs() {
		tabs.innerHTML = "";
		for (const tab of [
			{ kind: "unet", label: "UNET测试" },
			{ kind: "lora", label: "Lora模型测试" },
			{ kind: "lora_strength", label: "Lora强度测试" },
			{ kind: "checkpoint", label: "Checkpoint测试" },
			{ kind: "sampler", label: "采样器测试" },
			{ kind: "scheduler", label: "调度器测试" },
		]) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = tab.label;
			const active = state.kind === tab.kind;
			button.style.cssText = `height:28px;border:1px solid ${active ? "#38bdf8" : "#40535b"};border-radius:6px;background:${active ? "#123347" : "#17242a"};color:${active ? "#e0f2fe" : "#cbdce0"};cursor:pointer;padding:0 10px;font-weight:800;`;
			button.onclick = async (event) => {
				event.preventDefault();
				event.stopPropagation();
				state.filters[state.kind] = filterInput.value;
				saveLazyTestFilter(node, state.kind, filterInput.value);
				state.kind = tab.kind;
				filterInput.value = state.filters[state.kind] || "";
				renderTabs();
				renderSortButtons();
				renderModeControls();
				await ensureModels();
				renderList();
			};
			tabs.appendChild(button);
		}
	}

	function renderModeControls() {
		const strengthMode = state.kind === "lora_strength";
		strengthTools.style.display = strengthMode ? "flex" : "none";
		selectAllButton.style.display = strengthMode ? "none" : "";
	}

	function renderSortButtons() {
		sortTools.querySelectorAll("button[data-sort]").forEach((button) => button.remove());
		const options = [
			{ value: "name_asc", label: "名称↑" },
			{ value: "name_desc", label: "名称↓" },
			{ value: "size_desc", label: "大小↓" },
			{ value: "size_asc", label: "大小↑" },
		];
		for (const option of options) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.sort = option.value;
			button.textContent = option.label;
			const active = state.sorts[state.kind] === option.value;
			button.style.cssText = `height:26px;border:1px solid ${active ? "#65d189" : "#40535b"};border-radius:6px;background:${active ? "#1d5d39" : "#1b2730"};color:${active ? "#ffffff" : "#dce7e2"};cursor:pointer;padding:0 8px;font-weight:700;white-space:nowrap;`;
			button.onclick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				state.sorts[state.kind] = option.value;
				saveLazyTestSort(node, state.kind, option.value);
				renderSortButtons();
				renderList();
			};
			sortTools.appendChild(button);
		}
	}

	async function ensureModels() {
		const modelKind = state.kind === "lora_strength" ? "lora" : state.kind;
		if (state.models[modelKind]?.length) {
			return;
		}
		if (modelKind === "sampler" || modelKind === "scheduler") {
			const widgetName = modelKind === "sampler" ? "sampler_name" : "scheduler";
			const widget = getWidget(node, widgetName);
			const values = Array.isArray(widget?.options?.values) ? widget.options.values : [];
			state.models[modelKind] = values.map((value) => ({ name: String(value), size: "", bytes: 0 }));
			return;
		}
		status.textContent = "正在读取模型列表...";
		state.models[modelKind] = await fetchLazyTestModels(modelKind, node);
	}

	function renderList() {
		const selected = new Set(selectedLazyTestModels(panel));
		const modelKind = state.kind === "lora_strength" ? "lora" : state.kind;
		const filtered = sortedLazyTestModels(
			state.models[modelKind].filter((item) => modelMatchesTestFilter(item, state.filters[state.kind])),
			state.sorts[state.kind],
		);
		list.innerHTML = "";
		for (const item of filtered) {
			const row = document.createElement("label");
			row.style.cssText = "display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:6px;min-height:30px;padding:5px 7px;border:1px solid #263940;border-radius:6px;background:#111d22;cursor:pointer;";
			row.innerHTML = `
				<input type="${state.kind === "lora_strength" ? "radio" : "checkbox"}" name="gjj-lazy-test-${state.kind}" data-model-name="${escapeHtml(item.name)}" ${selected.has(item.name) ? "checked" : ""}>
				<span title="${escapeHtml(item.name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650;">${escapeHtml(item.name)}</span>
				<span style="color:#92a7ad;font-variant-numeric:tabular-nums;">${escapeHtml(item.size || "")}</span>
			`;
			list.appendChild(row);
		}
		const selectedCount = selectedLazyTestModels(panel).length;
		const label = state.kind === "unet" ? "UNET" : (state.kind === "lora_strength" ? "LoRA强度" : (state.kind === "checkpoint" ? "Checkpoint" : (state.kind === "sampler" ? "采样器" : (state.kind === "scheduler" ? "调度器" : "LoRA模型"))));
		status.textContent = `${label}：${filtered.length} / ${state.models[modelKind].length}，已选 ${selectedCount}`;
	}

	list.addEventListener("change", renderList);
	filterInput.addEventListener("input", () => {
		state.filters[state.kind] = filterInput.value;
		saveLazyTestFilter(node, state.kind, filterInput.value);
		renderList();
	});
	const saveStrengthInputs = () => {
		saveLazyTestStrengthSettings(node, {
			start: parseLazyStrengthValue(strengthStartInput, lazyTestStrengthSettings(node).start),
			end: parseLazyStrengthValue(strengthEndInput, lazyTestStrengthSettings(node).end),
			step: parseLazyStrengthValue(strengthStepInput, lazyTestStrengthSettings(node).step),
		});
	};
	for (const input of [strengthStartInput, strengthEndInput, strengthStepInput]) {
		input.addEventListener("input", saveStrengthInputs);
		input.addEventListener("change", saveStrengthInputs);
	}
	panel.querySelector("[data-select-all]").onclick = () => {
		for (const input of panel.querySelectorAll("input[data-model-name]")) input.checked = true;
		renderList();
	};
	panel.querySelector("[data-clear]").onclick = () => {
		for (const input of panel.querySelectorAll("input[data-model-name]")) input.checked = false;
		renderList();
	};
	const close = () => {
		state.filters[state.kind] = filterInput.value;
		saveLazyTestFilter(node, state.kind, filterInput.value);
		overlay.remove();
		if (node.__gjjLazyTestOverlay === overlay) {
			node.__gjjLazyTestOverlay = null;
		}
	};
	panel.querySelector("[data-close]").onclick = close;
	panel.querySelector("[data-cancel]").onclick = close;
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) close();
	});
	panel.querySelector("[data-ok]").onclick = async () => {
		const models = selectedLazyTestModels(panel);
		const selectedModel = selectedLazyTestModel(panel);
		if (state.kind === "lora_strength" && !selectedModel) {
			status.textContent = "请选择一个 LoRA。";
			return;
		}
		if (state.kind !== "lora_strength" && !models.length) {
			status.textContent = "请至少选择一个模型。";
			return;
		}
		state.filters[state.kind] = filterInput.value;
		saveLazyTestFilter(node, state.kind, filterInput.value);
		const config = { mode: state.kind, models, filter: state.filters[state.kind], requested_at: new Date().toISOString() };
		if (state.kind === "lora_strength") {
			config.lora_name = selectedModel;
			config.models = [selectedModel];
			config.strength_start = parseLazyStrengthValue(strengthStartInput, 0.2);
			config.strength_end = parseLazyStrengthValue(strengthEndInput, 1.2);
			config.strength_step = parseLazyStrengthValue(strengthStepInput, 0.2);
			saveLazyTestStrengthSettings(node, {
				start: config.strength_start,
				end: config.strength_end,
				step: config.strength_step,
			});
		}
		writeLazyTestConfig(node, config);
		close();
		const originalText = testButton.innerHTML;
		testButton.innerHTML = "⏳ 测试中";
		testButton.disabled = true;
		if (generateButton) generateButton.disabled = true;
		try {
			const ok = await queueOnlyCurrentNode(node);
			testButton.innerHTML = ok ? "✅ 已提交" : "❌ 提交失败";
		} catch (error) {
			console.error("[GJJ] 模型测试提交失败:", error);
			testButton.innerHTML = "❌ 错误";
		} finally {
			setTimeout(() => {
				clearLazyTestConfig(node);
				testButton.innerHTML = originalText;
				testButton.disabled = false;
				if (generateButton) generateButton.disabled = false;
			}, 1000);
		}
	};

	renderTabs();
	renderSortButtons();
	renderModeControls();
	void ensureModels().then(renderList);
}

function createButtons(node) {
	const container = document.createElement("div");
	node.__gjjLazyButtonsContainer = container;
	container.style.cssText = [
		"display:flex",
		"flex-direction:row",
		"flex-wrap:wrap",
		"align-items:center",
		"align-content:flex-start",
		"gap:0",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const sharedButtonStyle = [
		"height:36px",
		"padding:0",
		"border-radius:6px",
		"color:#e5edf2",
		"font-size:12px",
		"font-weight:700",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1001",
		"pointer-events:auto",
		"user-select:none",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"gap:4px",
		"white-space:normal",
		"line-height:1.15",
		"text-align:center",
		"min-width:0",
		"flex:0 0 auto",
	];
	const emojiButtonStyle = [
		...sharedButtonStyle,
		"padding:0",
		"gap:0",
		"font-size:20px",
		"min-width:36px",
	];
	const referenceBrowserButton = document.createElement("button");
	referenceBrowserButton.type = "button";
	referenceBrowserButton.textContent = "📂";
	referenceBrowserButton.title = REFERENCE_BROWSER_BUTTON_STYLES.empty.title;
	referenceBrowserButton.setAttribute("aria-label", "浏览参考图片");
	referenceBrowserButton.style.cssText = [
		...emojiButtonStyle,
		`border:1px solid ${REFERENCE_BROWSER_BUTTON_STYLES.empty.border}`,
		`background:${REFERENCE_BROWSER_BUTTON_STYLES.empty.bg}`,
		`color:${REFERENCE_BROWSER_BUTTON_STYLES.empty.color}`,
	].join(";");
	node.__gjjReferenceBrowserButton = referenceBrowserButton;

	function hideReferenceHoverPreview() {
		node.__gjjReferenceHoverPreview?.remove();
		node.__gjjReferenceHoverPreview = null;
	}

	function showReferenceHoverPreview() {
		hideReferenceHoverPreview();
		if (referenceBrowserButton.disabled) {
			return;
		}
		const urls = referenceBrowserUrls(node).slice(0, 8);
		if (!urls.length) {
			return;
		}
		const preview = document.createElement("div");
		const columns = Math.min(4, Math.max(1, urls.length));
		preview.style.cssText = [
			"position:fixed",
			"z-index:100001",
			"display:grid",
			`grid-template-columns:repeat(${columns},96px)`,
			"gap:5px",
			"padding:6px",
			"border:1px solid #41535b",
			"border-radius:8px",
			"background:#10171b",
			"box-shadow:0 10px 28px rgba(0,0,0,0.48)",
			"pointer-events:none",
		].join(";");
		for (const url of urls) {
			const image = document.createElement("img");
			image.src = url;
			image.alt = "参考图片预览";
			image.loading = "eager";
			image.style.cssText = "display:block;width:96px;height:96px;object-fit:cover;border:1px solid #33454c;border-radius:6px;background:#172026;";
			preview.appendChild(image);
		}
		document.body.appendChild(preview);
		node.__gjjReferenceHoverPreview = preview;
		const anchor = referenceBrowserButton.getBoundingClientRect();
		const bounds = preview.getBoundingClientRect();
		const left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8));
		const below = anchor.bottom + 7;
		const top = below + bounds.height <= window.innerHeight - 8
			? below
			: Math.max(8, anchor.top - bounds.height - 7);
		preview.style.left = `${left}px`;
		preview.style.top = `${top}px`;
	}

	referenceBrowserButton.addEventListener("mouseenter", showReferenceHoverPreview);
	referenceBrowserButton.addEventListener("mouseleave", hideReferenceHoverPreview);

	// 刷新Lora按钮
	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.innerHTML = "🔄";
	refreshButton.title = "刷新当前节点并清理节点缓存";
	refreshButton.style.cssText = [
		...emojiButtonStyle,
		"border:1px solid #3b82f6",
		"background:linear-gradient(135deg, #1e3a5f, #1e40af)",
		"color:#e0e7ff",
	].join(";");

	const batchLinkButton = document.createElement("button");
	batchLinkButton.type = "button";
	batchLinkButton.textContent = "🔗";
	batchLinkButton.title = "断开或恢复【批量图片】外部链接";
	batchLinkButton.setAttribute("aria-label", "批量图片外部链接开关");
	batchLinkButton.style.cssText = [
		...emojiButtonStyle,
		"border:1px solid #38bdf8",
		"background:linear-gradient(135deg, #075985, #0284c7)",
		"color:#e0f2fe",
		"display:none",
	].join(";");
	node.__gjjBatchImageLinkButton = batchLinkButton;

	const inputSizeButton = document.createElement("button");
	inputSizeButton.type = "button";
	inputSizeButton.textContent = "📐";
	inputSizeButton.title = "第一个图像输入尺寸同步开关";
	inputSizeButton.setAttribute("aria-label", "使用第一个输入图尺寸");
	inputSizeButton.style.cssText = [
		...emojiButtonStyle,
		"border:1px solid #22c55e",
		"background:linear-gradient(135deg, #065f46, #16a34a)",
		"color:#ecfdf5",
		"display:none",
	].join(";");
	node.__gjjInputSizeButton = inputSizeButton;

	const seedRandomButton = document.createElement("button");
	seedRandomButton.type = "button";
	seedRandomButton.textContent = "🎲";
	seedRandomButton.title = SEED_RANDOM_BUTTON_STYLES.off.title;
	seedRandomButton.setAttribute("aria-label", "随机种子开关");
	seedRandomButton.style.cssText = [
		...emojiButtonStyle,
		`border:1px solid ${SEED_RANDOM_BUTTON_STYLES.off.border}`,
		`background:${SEED_RANDOM_BUTTON_STYLES.off.bg}`,
		`color:${SEED_RANDOM_BUTTON_STYLES.off.color}`,
	].join(";");
	node.__gjjSeedRandomButton = seedRandomButton;

	const translateButton = document.createElement("button");
	translateButton.type = "button";
	translateButton.textContent = "🌏";
	translateButton.title = TRANSLATE_BUTTON_STYLES.off.title;
	translateButton.setAttribute("aria-label", "提示词翻译开关");
	translateButton.style.cssText = [
		...emojiButtonStyle,
		`border:1px solid ${TRANSLATE_BUTTON_STYLES.off.border}`,
		`background:${TRANSLATE_BUTTON_STYLES.off.bg}`,
		`color:${TRANSLATE_BUTTON_STYLES.off.color}`,
	].join(";");
	node.__gjjLazyTranslateButton = translateButton;

	const keepModelButton = document.createElement("button");
	keepModelButton.type = "button";
	keepModelButton.textContent = "📌";
	keepModelButton.title = KEEP_MODEL_BUTTON_STYLES.off.title;
	keepModelButton.setAttribute("aria-label", "保持模型开关");
	keepModelButton.style.cssText = [
		...emojiButtonStyle,
		`border:1px solid ${KEEP_MODEL_BUTTON_STYLES.off.border}`,
		`background:${KEEP_MODEL_BUTTON_STYLES.off.bg}`,
		`color:${KEEP_MODEL_BUTTON_STYLES.off.color}`,
	].join(";");
	node.__gjjKeepModelButton = keepModelButton;

	const testButton = document.createElement("button");
	testButton.type = "button";
	testButton.textContent = "🧪";
	testButton.title = "打开 UNET / LoRA / Checkpoint 批量测试窗口";
	testButton.setAttribute("aria-label", "模型测试");
	testButton.style.cssText = [
		...emojiButtonStyle,
		"border:1px solid #f59e0b",
		"background:linear-gradient(135deg, #4a2f08, #b45309)",
		"color:#fffbeb",
	].join(";");

	// 生成图片按钮
	const generateButton = document.createElement("button");
	generateButton.type = "button";
	generateButton.innerHTML = "▶️";
	generateButton.title = "只执行当前节点，无需连接其他节点";
	generateButton.style.cssText = [
		...emojiButtonStyle,
		"border:1px solid #10b981",
		"background:linear-gradient(135deg, #064e3b, #059669)",
		"color:#a7f3d0",
	].join(";");

	const modelSettingsButton = document.createElement("button");
	modelSettingsButton.type = "button";
	modelSettingsButton.textContent = "🧠";
	modelSettingsButton.title = "打开模型浮动窗口";
	modelSettingsButton.style.cssText = [
		...emojiButtonStyle,
		"border:1px solid #55636f",
		"background:linear-gradient(135deg, #1f2933, #374151)",
		"color:#e5edf2",
	].join(";");
	node.__gjjModelSettingsButton = modelSettingsButton;

	const promptSettingsButton = document.createElement("button");
	promptSettingsButton.type = "button";
	promptSettingsButton.textContent = "📒";
	promptSettingsButton.title = "打开全局提示词与反向提示词浮动窗口";
	promptSettingsButton.style.cssText = [
		...emojiButtonStyle,
		"border:1px solid #9a5433",
		"background:linear-gradient(135deg,#3f2418,#7c2d12)",
		"color:#fff7ed",
	].join(";");
	node.__gjjPromptSettingsButton = promptSettingsButton;

	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.textContent = "⚙️";
	settingsButton.title = "打开其它参数浮动窗口";
	settingsButton.style.cssText = [
		...emojiButtonStyle,
		"border:1px solid #55636f",
		"background:linear-gradient(135deg, #1f2933, #374151)",
		"color:#e5edf2",
	].join(";");
	node.__gjjSettingsButton = settingsButton;
	const templateButton = createTemplateSourceButton(node, TEMPLATE_SOURCE_FIELDS, emojiButtonStyle);
	templateButton.style.width = "36px";
	templateButton.style.flex = "0 0 auto";
	templateButton.style.padding = "0";
	templateButton.style.gap = "0";
	templateButton.style.fontSize = "20px";

	// 按钮悬停效果函数
	function setupButtonHover(btn, defaultBg, hoverBg) {
		btn.__gjjLazyDefaultBg = defaultBg;
		btn.__gjjLazyHoverBg = hoverBg;
		btn.addEventListener("mouseenter", () => {
			if (btn.disabled) {
				return;
			}
			if (btn === inputSizeButton && sizeSettingsOpen(node)) {
				return;
			}
			if (btn === modelSettingsButton && modelSettingsOpen(node)) {
				return;
			}
			if (btn === settingsButton && settingsOpen(node)) {
				return;
			}
			if (btn === promptSettingsButton && promptSettingsOpen(node)) {
				return;
			}
			btn.style.background = btn.__gjjLazyHoverBg || hoverBg;
			btn.style.transform = "translateY(-1px)";
		});

		btn.addEventListener("mouseleave", () => {
			if (btn.disabled) {
				btn.style.transform = "translateY(0)";
				return;
			}
			if (btn === inputSizeButton && sizeSettingsOpen(node)) {
				btn.style.transform = "translateY(0)";
				updateSizeSettingsButtonState(node);
				return;
			}
			if (btn === modelSettingsButton && modelSettingsOpen(node)) {
				btn.style.transform = "translateY(0)";
				updateModelSettingsButtonState(node);
				return;
			}
			if (btn === settingsButton && settingsOpen(node)) {
				btn.style.transform = "translateY(0)";
				updateSettingsButtonState(node);
				return;
			}
			if (btn === promptSettingsButton && promptSettingsOpen(node)) {
				btn.style.transform = "translateY(0)";
				updatePromptSettingsButtonState(node);
				return;
			}
			btn.style.background = btn.__gjjLazyDefaultBg || defaultBg;
			btn.style.transform = "translateY(0)";
		});

		btn.addEventListener("mousedown", () => {
			if (btn.disabled) {
				return;
			}
			btn.style.transform = "translateY(0) scale(0.98)";
		});

		btn.addEventListener("mouseup", () => {
			if (btn.disabled) {
				return;
			}
			btn.style.transform = "translateY(-1px)";
		});
	}

	function protectEvent(event) {
		event.preventDefault();
		event.stopPropagation();
	}

	function setupButtonEvents(btn, handler) {
		let lastHandledAt = 0;
		const wrappedHandler = (event) => {
			const now = Date.now();
			if (now - lastHandledAt < 250) {
				protectEvent(event);
				return;
			}
			lastHandledAt = now;
			handler(event);
		};
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			btn.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}
		btn.addEventListener("pointerup", wrappedHandler, true);
		btn.addEventListener("click", wrappedHandler, true);
	}

	// 刷新当前节点并清理节点缓存
	async function handleRefresh(event) {
		protectEvent(event);
		console.log("[GJJ] 刷新节点并清理缓存", node?.id, node?.comfyClass);
		refreshButton.disabled = true;
		refreshButton.style.opacity = "0.7";

		try {
			const response = await api.fetchApi("/gjj/lazy-image-studio/clear-cache", {
				method: "POST",
			});
			if (!response.ok) {
				throw new Error(`清理节点缓存失败：HTTP ${response.status}`);
			}
			hideReferenceHoverPreview();
			const batchSourceWidget = getWidget(node, BATCH_SOURCE_WIDGET);
			if (batchSourceWidget) {
				batchSourceWidget.value = "[]";
			}
			node.properties = node.properties || {};
			node.properties[BATCH_SOURCE_WIDGET] = "[]";
			if (node.__gjjLazyReferenceFileInput) {
				node.__gjjLazyReferenceFileInput.value = "";
			}
			writeLiveParamSnapshot(node);
			applyReferenceBrowserButtonState(node);
			await refreshLoraOptions(node, false);
			resolveLoraRowsToAvailable(node);
			node.properties[LAST_PRESET_KEY] = "";
			applyPreset(node, true);
			closeLazyFloatingSurfaces(node);
			stabilizeNode(node, true);
			applySettingsVisibility(node);
			scheduleNativePreviewClear(node);
			GJJ_Utils.refreshNode(node);
		} catch (error) {
			console.error("[GJJ] 刷新节点或清理缓存失败:", error);
		} finally {
			refreshButton.disabled = false;
			refreshButton.style.opacity = "1";
		}
	}

	// 生成图片按钮
	async function handleGenerate(event) {
		protectEvent(event);
		console.log("[GJJ] 生成图片按钮被点击", node?.id, node?.comfyClass);

		const originalText = generateButton.innerHTML;
		generateButton.innerHTML = "⏳ 执行中";
		generateButton.disabled = true;
		generateButton.style.opacity = "0.7";

		try {
			const promptWidget = getWidget(node, "prompt");
			const originalPrompt = String(promptWidget?.value ?? "");
			const promptSegments = splitLazyPromptQueueSegments(originalPrompt);
			let allQueued = true;
			if (promptSegments.length > 1) {
				try {
					for (let index = 0; index < promptSegments.length; index += 1) {
						generateButton.innerHTML = `⏳ 提交 ${index + 1}/${promptSegments.length}`;
						setWidgetValue(promptWidget, promptSegments[index]);
						writeLiveParamSnapshot(node);
						delete node.__gjjLazySeedPreparedAt;
						applySeedControlBeforeQueue(node);
						const ok = await queueOnlyCurrentNode(node);
						if (!ok) {
							allQueued = false;
							break;
						}
					}
				} finally {
					setWidgetValue(promptWidget, originalPrompt);
					writeLiveParamSnapshot(node);
				}
			} else {
				applySeedControlBeforeQueue(node);
				allQueued = await queueOnlyCurrentNode(node);
			}
			if (!allQueued) {
				console.warn("[GJJ] 当前节点执行失败：queueOnlyCurrentNode 返回 false");
				generateButton.innerHTML = "❌ 执行失败";
				generateButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
				generateButton.style.borderColor = "#ef4444";
			} else {
				generateButton.innerHTML = promptSegments.length > 1 ? `✅ 已提交 ${promptSegments.length} 队列` : "✅ 执行中";
				generateButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				generateButton.style.borderColor = "#10b981";
			}
		} catch (error) {
			console.error("[GJJ] 执行当前节点时发生错误:", error);
			generateButton.innerHTML = "❌ 错误";
			generateButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			generateButton.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				generateButton.innerHTML = originalText;
				generateButton.disabled = false;
				generateButton.style.opacity = "1";
				generateButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				generateButton.style.borderColor = "#10b981";
			}, 1500);
		}
	}

	async function handleTranslate(event) {
		protectEvent(event);
		if (node.__gjjLazyTranslating) {
			return;
		}
		const nextEnabled = !translationEnabled(node);
		setTranslationEnabled(node, nextEnabled);
		const linkedValues = nextEnabled ? linkedPromptTranslationValues(node) : {};
		const linkedSignature = upstreamPromptTranslationSignature(linkedValues);
		await translateLazyPromptValues(node, {
			positive: Object.prototype.hasOwnProperty.call(linkedValues, "prompt") ? linkedValues.prompt : undefined,
			negative: Object.prototype.hasOwnProperty.call(linkedValues, "negative_prompt") ? linkedValues.negative_prompt : undefined,
			upstreamSignature: linkedSignature,
			successTitle: nextEnabled ? "翻译已开启，当前提示词已翻译" : "翻译已关闭，当前提示词已翻译",
		});
		if (nextEnabled && !linkedSignature) {
			syncPanelFromLinkedSources(node);
		}
	}

	function handleSettings(event) {
		protectEvent(event);
		setSettingsOpen(node, !settingsOpen(node));
	}

	function handlePromptSettings(event) {
		protectEvent(event);
		setPromptSettingsOpen(node, !promptSettingsOpen(node));
	}

	async function chooseLocalReferenceImages() {
		if (!node.__gjjLazyReferenceFileInput) {
			const fileInput = document.createElement("input");
			fileInput.type = "file";
			fileInput.accept = "image/png,image/jpeg,image/webp,image/bmp,image/gif,image/avif,image/tiff";
			fileInput.multiple = true;
			fileInput.style.display = "none";
			document.body.appendChild(fileInput);
			node.__gjjLazyReferenceFileInput = fileInput;
		}
		const fileInput = node.__gjjLazyReferenceFileInput;
		fileInput.value = "";
		const files = await new Promise((resolve) => {
			fileInput.onchange = () => resolve(Array.from(fileInput.files || []));
			fileInput.click();
		});
		if (!files.length) {
			return;
		}
		const selected = [];
		for (const file of files) {
			const form = new FormData();
			form.append("image", file, file.name);
			form.append("type", "input");
			form.append("overwrite", "true");
			const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw new Error(data?.error || `图片上传失败：${file.name}`);
			}
			const filename = String(data?.name || data?.filename || data?.image || file.name || "");
			if (filename) {
				selected.push({
					filename,
					subfolder: String(data?.subfolder || ""),
					type: String(data?.type || "input"),
				});
			}
		}
		const raw = JSON.stringify(selected);
		const widget = getWidget(node, BATCH_SOURCE_WIDGET);
		if (widget) {
			widget.value = raw;
		}
		node.properties = node.properties || {};
		node.properties[BATCH_SOURCE_WIDGET] = raw;
		writeLiveParamSnapshot(node);
		applyReferenceBrowserButtonState(node);
		node.graph?.change?.();
		app.graph?.setDirtyCanvas?.(true, true);
	}

	async function handleReferenceBrowser(event) {
		protectEvent(event);
		hideReferenceHoverPreview();
		applyReferenceBrowserButtonState(node);
		if (referenceBrowserButton.disabled) {
			return;
		}
		try {
			await chooseLocalReferenceImages();
		} catch (error) {
			console.error("[GJJ] 本地参考图片选择失败:", error);
			referenceBrowserButton.title = String(error?.message || error || "本地参考图片选择失败");
		}
	}

	function handleModelSettings(event) {
		protectEvent(event);
		setModelSettingsOpen(node, !modelSettingsOpen(node));
	}

	function handleKeepModel(event) {
		protectEvent(event);
		setKeepModelEnabled(node, !keepModelEnabled(node));
	}

	function handleTest(event) {
		protectEvent(event);
		openLazyTestDialog(node, testButton, generateButton);
	}

	function handleBatchLink(event) {
		protectEvent(event);
		toggleBatchImageExternalLink(node);
		stabilizeNode(node, false);
	}

	function handleInputSize(event) {
		protectEvent(event);
		setSizeSettingsOpen(node, !sizeSettingsOpen(node));
	}

	function handleSeedRandom(event) {
		protectEvent(event);
		setSeedRandomEnabled(node, !seedRandomEnabled(node));
	}

	setupButtonHover(referenceBrowserButton, REFERENCE_BROWSER_BUTTON_STYLES.empty.bg, REFERENCE_BROWSER_BUTTON_STYLES.empty.hover);
	setupButtonHover(refreshButton, "linear-gradient(135deg, #1e3a5f, #1e40af)", "linear-gradient(135deg, #1e40af, #3b82f6)");
	setupButtonHover(batchLinkButton, "linear-gradient(135deg, #075985, #0284c7)", "linear-gradient(135deg, #0284c7, #38bdf8)");
	setupButtonHover(inputSizeButton, "linear-gradient(135deg, #065f46, #16a34a)", "linear-gradient(135deg, #16a34a, #22c55e)");
	setupButtonHover(seedRandomButton, SEED_RANDOM_BUTTON_STYLES.off.bg, SEED_RANDOM_BUTTON_STYLES.off.hover);
	setupButtonHover(translateButton, TRANSLATE_BUTTON_STYLES.off.bg, TRANSLATE_BUTTON_STYLES.off.hover);
	setupButtonHover(keepModelButton, KEEP_MODEL_BUTTON_STYLES.off.bg, KEEP_MODEL_BUTTON_STYLES.off.hover);
	setupButtonHover(testButton, "linear-gradient(135deg, #4a2f08, #b45309)", "linear-gradient(135deg, #b45309, #d97706)");
	setupButtonHover(generateButton, "linear-gradient(135deg, #064e3b, #059669)", "linear-gradient(135deg, #059669, #10b981)");
	setupButtonHover(modelSettingsButton, MODEL_SETTINGS_BUTTON_STYLES.off.bg, MODEL_SETTINGS_BUTTON_STYLES.off.hover);
	setupButtonHover(promptSettingsButton, "linear-gradient(135deg,#3f2418,#7c2d12)", "linear-gradient(135deg,#7c2d12,#c2410c)");
	setupButtonHover(settingsButton, "linear-gradient(135deg, #1f2933, #374151)", "linear-gradient(135deg, #374151, #4b5563)");
	setupButtonEvents(referenceBrowserButton, handleReferenceBrowser);
	setupButtonEvents(refreshButton, handleRefresh);
	setupButtonEvents(batchLinkButton, handleBatchLink);
	setupButtonEvents(inputSizeButton, handleInputSize);
	setupButtonEvents(seedRandomButton, handleSeedRandom);
	setupButtonEvents(translateButton, handleTranslate);
	setupButtonEvents(keepModelButton, handleKeepModel);
	setupButtonEvents(testButton, handleTest);
	setupButtonEvents(generateButton, handleGenerate);
	setupButtonEvents(modelSettingsButton, handleModelSettings);
	setupButtonEvents(promptSettingsButton, handlePromptSettings);
	setupButtonEvents(settingsButton, handleSettings);
	applyLazyTranslateButtonState(node);
	applySeedRandomButtonState(node);
	applyKeepModelButtonState(node);
	applyInputSizeButtonState(node);
	applyReferenceBrowserButtonState(node);
	updateModelSettingsButtonState(node);
	updatePromptSettingsButtonState(node);
	updateSettingsButtonState(node);
	setBatchLinkButtonState(node);

	container.appendChild(referenceBrowserButton);
	container.appendChild(refreshButton);
	container.appendChild(batchLinkButton);
	container.appendChild(inputSizeButton);
	container.appendChild(seedRandomButton);
	container.appendChild(translateButton);
	container.appendChild(templateButton);
	container.appendChild(modelSettingsButton);
	container.appendChild(promptSettingsButton);
	container.appendChild(settingsButton);
	container.appendChild(testButton);
	container.appendChild(generateButton);
	return container;
}

function lazyButtonsHeight(width, node = null) {
	const measured = Number(node?.__gjjLazyButtonsContainer?.scrollHeight || 0);
	if (measured > 0) {
		return measured;
	}
	const availableWidth = Math.max(120, Number(width || 260));
	const buttonWidths = [36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36];
	const gap = 0;
	let rows = 1;
	let rowWidth = 0;
	for (const buttonWidth of buttonWidths) {
		const nextWidth = rowWidth ? rowWidth + gap + buttonWidth : buttonWidth;
		if (nextWidth > availableWidth && rowWidth) {
			rows += 1;
			rowWidth = buttonWidth;
		} else {
			rowWidth = nextWidth;
		}
	}
	return rows * 36 + (rows - 1) * gap;
}

function createImagePreview(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const controls = document.createElement("div");
	controls.style.cssText = [
		"display:none",
		"align-items:center",
		"gap:5px",
		"min-height:24px",
	].join(";");

	function smallButton(text, title, onClick) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = text;
		button.title = title;
		button.style.cssText = [
			"height:22px",
			"min-width:24px",
			"padding:0 7px",
			"border:1px solid #41535b",
			"border-radius:6px",
			"background:#172026",
			"color:#dce7e2",
			"font:11px/20px system-ui,\"Microsoft YaHei\",sans-serif",
			"cursor:pointer",
			"pointer-events:auto",
		].join(";");
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick?.();
		});
		return button;
	}

	const modeButton = smallButton("平铺", "切换多图浏览方式：平铺 / 分页。", () => {
		setLazyPreviewLayoutMode(node, lazyPreviewLayoutMode(node) === "page" ? "tile" : "page");
	});
	const prevButton = smallButton("◀", "上一张预览。", () => {
		setLazyPreviewPageIndex(node, lazyPreviewPageIndex(node) - 1);
	});
	const pageLabel = document.createElement("span");
	pageLabel.style.cssText = "color:#9eb3b7;font:11px/1.2 system-ui,\"Microsoft YaHei\",sans-serif;min-width:48px;text-align:center;";
	const nextButton = smallButton("▶", "下一张预览。", () => {
		setLazyPreviewPageIndex(node, lazyPreviewPageIndex(node) + 1);
	});
	controls.append(modeButton, prevButton, pageLabel, nextButton);

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:none",
		"grid-template-columns:repeat(auto-fill,minmax(86px,1fr))",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	container.append(controls, wrap);
	node.__gjjLazyPreview = { container, controls, wrap, modeButton, prevButton, nextButton, pageLabel, items: [] };
	node.__gjjPreviewImage = wrap;
	return container;
}

function lazyPreviewLayoutMode(node) {
	const mode = String(node?.properties?.[PREVIEW_LAYOUT_PROPERTY] || "tile");
	return mode === "page" ? "page" : "tile";
}

function setLazyPreviewLayoutMode(node, mode) {
	node.properties ||= {};
	node.properties[PREVIEW_LAYOUT_PROPERTY] = mode === "page" ? "page" : "tile";
	updateLazyPreviewLayout(node);
	GJJ_Utils.refreshNode(node);
}

function lazyPreviewPageIndex(node) {
	node.properties ||= {};
	const total = Number(node.__gjjLazyPreview?.wrap?.children?.length || 0);
	const max = Math.max(0, total - 1);
	const value = Math.max(0, Math.floor(Number(node.properties[PREVIEW_PAGE_PROPERTY] || 0) || 0));
	const next = Math.min(value, max);
	node.properties[PREVIEW_PAGE_PROPERTY] = next;
	return next;
}

function setLazyPreviewPageIndex(node, index) {
	node.properties ||= {};
	const total = Number(node.__gjjLazyPreview?.wrap?.children?.length || 0);
	const max = Math.max(0, total - 1);
	node.properties[PREVIEW_PAGE_PROPERTY] = Math.max(0, Math.min(max, Math.floor(Number(index || 0) || 0)));
	updateLazyPreviewLayout(node);
	GJJ_Utils.refreshNode(node);
}

function lazyPreviewAspectRatio(item) {
	const width = Number(item?.width || 0);
	const height = Number(item?.height || 0);
	return width > 0 && height > 0 ? `${width} / ${height}` : "1 / 1";
}

function openLazyPreviewOverlay(src, items = [], startIndex = 0) {
	if (!src) return;
	const sources = (Array.isArray(items) ? items : [])
		.map((item) => imageDataToUrl(item, true))
		.filter(Boolean);
	if (!sources.length) sources.push(src);
	let currentIndex = Math.max(0, Math.min(sources.length - 1, Math.floor(Number(startIndex || 0) || 0)));
	if (sources[currentIndex] !== src) {
		const foundIndex = sources.indexOf(src);
		if (foundIndex >= 0) currentIndex = foundIndex;
	}
	let playTimer = null;

	const overlay = document.createElement("div");
	overlay.style.cssText = [
		"position:fixed",
		"inset:0",
		"background:rgba(0, 0, 0, 0.9)",
		"backdrop-filter:blur(10px)",
		"z-index:10000",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"cursor:zoom-out",
	].join(";");

	const previewImg = document.createElement("img");
	previewImg.style.cssText = [
		"max-width:90%",
		"max-height:90%",
		"object-fit:contain",
		"border-radius:8px",
		"box-shadow:0 0 40px rgba(0, 0, 0, 0.5)",
		"transition:transform 0.1s ease",
		"cursor:grab",
	].join(";");

	let currentScale = 1;
	const minScale = 0.1;
	const maxScale = 10;

	const closeHint = document.createElement("div");
	closeHint.style.cssText = [
		"position:absolute",
		"bottom:20px",
		"left:50%",
		"transform:translateX(-50%)",
		"color:#fff",
		"font-size:13px",
		"opacity:0.68",
		"pointer-events:none",
		"white-space:nowrap",
	].join(";");

	const setOverlayImage = (index) => {
		currentIndex = Math.max(0, Math.min(sources.length - 1, Math.floor(Number(index || 0) || 0)));
		previewImg.src = sources[currentIndex] || src;
		currentScale = 1;
		previewImg.style.transform = `scale(${currentScale})`;
		const counter = sources.length > 1 ? ` · ${currentIndex + 1}/${sources.length}` : "";
		const playText = sources.length > 1 ? (playTimer ? " · 空格暂停" : " · 空格播放") : "";
		closeHint.textContent = `滚轮缩放 · 再次点击关闭${counter}${playText}`;
	};

	const stepOverlayImage = (delta = 1) => {
		if (sources.length <= 1) return;
		setOverlayImage((currentIndex + delta + sources.length) % sources.length);
	};

	const stopPlayback = () => {
		if (playTimer) {
			clearInterval(playTimer);
			playTimer = null;
			setOverlayImage(currentIndex);
		}
	};

	const togglePlayback = () => {
		if (sources.length <= 1) return;
		if (playTimer) {
			stopPlayback();
			return;
		}
		stepOverlayImage(1);
		playTimer = setInterval(() => stepOverlayImage(1), 900);
		setOverlayImage(currentIndex);
	};

	overlay.addEventListener("wheel", (e) => {
		e.preventDefault();
		e.stopPropagation();
		const delta = e.deltaY > 0 ? -0.1 : 0.1;
		currentScale = Math.max(minScale, Math.min(maxScale, currentScale + delta));
		previewImg.style.transform = `scale(${currentScale})`;
	});

	previewImg.addEventListener("dblclick", (e) => {
		e.stopPropagation();
		currentScale = 1;
		previewImg.style.transform = `scale(${currentScale})`;
	});

	const handleKeydown = (event) => {
		if (event.code === "Space" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			togglePlayback();
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			event.stopPropagation();
			stopPlayback();
			stepOverlayImage(1);
		} else if (event.key === "ArrowLeft") {
			event.preventDefault();
			event.stopPropagation();
			stopPlayback();
			stepOverlayImage(-1);
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeOverlay();
		}
	};

	function closeOverlay() {
		stopPlayback();
		document.removeEventListener("keydown", handleKeydown, true);
		overlay.remove();
	}

	overlay.appendChild(previewImg);
	overlay.appendChild(closeHint);
	document.body.appendChild(overlay);
	setOverlayImage(currentIndex);
	document.addEventListener("keydown", handleKeydown, true);
	overlay.addEventListener("click", closeOverlay);
}

function removeLazyPreviewItem(node, index) {
	const preview = node?.__gjjLazyPreview;
	if (!preview?.wrap || !Array.isArray(preview.items) || preview.items.length <= 1) {
		return;
	}
	const safeIndex = Math.max(0, Math.min(preview.items.length - 1, Math.floor(Number(index || 0) || 0)));
	const nextItems = preview.items.slice();
	nextItems.splice(safeIndex, 1);
	const currentPage = lazyPreviewPageIndex(node);
	node.properties ||= {};
	node.properties[PREVIEW_PAGE_PROPERTY] = Math.max(0, Math.min(currentPage, nextItems.length - 1));
	updateImagePreview(node, nextItems);
}

function createLazyPreviewCard(node, item, index = 0) {
	const card = document.createElement("button");
	card.type = "button";
	card.draggable = true;
	card.__gjjLazyPreviewItem = item;
	card.title = "点击查看大图；拖到空白画布可用 GJJ · 任意预览承载；多图时按住 Ctrl 点击可移除这张预览。";
	card.style.cssText = [
		"display:block",
		"min-width:0",
		"padding:0",
		"border:0",
		"border-radius:0",
		"background:transparent",
		"box-sizing:border-box",
		"overflow:hidden",
		"cursor:pointer",
		"pointer-events:auto",
	].join(";");
	const image = document.createElement("img");
	image.draggable = false;
	image.dataset.gjjCustomPreview = "true";
	image.src = imageDataToUrl(item);
	image.style.cssText = [
		"width:100%",
		"height:100%",
		"display:block",
		"object-fit:cover",
		"border-radius:0",
		"transition:transform 0.2s ease",
	].join(";");
	image.addEventListener("mouseenter", () => {
		image.style.transform = "scale(1.02)";
	});
	image.addEventListener("mouseleave", () => {
		image.style.transform = "scale(1)";
	});
	image.addEventListener("load", () => {
		if (!item.width) item.width = Number(image.naturalWidth || 0);
		if (!item.height) item.height = Number(image.naturalHeight || 0);
		updateLazyPreviewLayout(node);
		GJJ_Utils.refreshNode(node);
	});
	let dragged = false;
	card.addEventListener("dragstart", (event) => {
		if (!event.dataTransfer || !item?.filename) {
			event.preventDefault();
			return;
		}
		dragged = true;
		const payload = {
			filename: String(item.filename),
			subfolder: String(item.subfolder || ""),
			type: String(item.type || "output"),
			media_type: "image",
			width: Number(item.width || image.naturalWidth || 0),
			height: Number(item.height || image.naturalHeight || 0),
		};
		event.dataTransfer.effectAllowed = "copy";
		event.dataTransfer.setData(ANY_PREVIEW_MEDIA_DRAG_MIME, JSON.stringify(payload));
		event.dataTransfer.setData("text/plain", String(item.filename));
	});
	card.addEventListener("dragend", () => {
		setTimeout(() => { dragged = false; }, 0);
	});
	card.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (dragged) return;
		if (event.ctrlKey && (node.__gjjLazyPreview?.items?.length || 0) > 1) {
			removeLazyPreviewItem(node, index);
			return;
		}
		openLazyPreviewOverlay(image.src, node.__gjjLazyPreview?.items || [item], index);
	});
	card.appendChild(image);
	return card;
}

function imageDataToUrl(item, original = false) {
	const filename = String((!original && item?.preview_filename) || item?.filename || "");
	if (!filename) {
		return "";
	}
	const type = String((!original && item?.preview_type) || item?.type || "output");
	const subfolder = String((!original && item?.preview_subfolder) || item?.subfolder || "");
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}${original ? "" : previewFormat}${randParam}`,
	);
}

function updateImagePreview(node, images) {
	const preview = node.__gjjLazyPreview;
	if (!preview?.wrap) return;

	if (!images || !images.length) {
		preview.wrap.replaceChildren();
		preview.wrap.style.display = "none";
		if (preview.controls) preview.controls.style.display = "none";
		node.__gjjLazyPreviewHeight = 0;
		GJJ_Utils.refreshNode(node);
		return;
	}

	preview.items = Array.isArray(images) ? images.slice() : [];
	preview.wrap.replaceChildren();
	for (const [index, item] of preview.items.entries()) {
		const card = createLazyPreviewCard(node, item, index);
		preview.wrap.appendChild(card);
	}
	updateLazyPreviewLayout(node);
	GJJ_Utils.refreshNode(node);
}

function lazyPreviewHeightForNode(node, width = null) {
	const preview = node?.__gjjLazyPreview;
	if (!preview?.wrap || preview.wrap.style.display === "none") {
		return 0;
	}
	// DOMWidget 会把已分配的槽位高度反映到容器 scrollHeight；不要再用它反推内容高度，
	// 否则每次 refreshNode 都会把旧高度回写并继续累加空白。
	updateLazyPreviewLayout(node, width);
	return Number(node.__gjjLazyPreviewHeight || 0);
}

function updateLazyPreviewLayout(node, width = null) {
	const preview = node?.__gjjLazyPreview;
	const wrap = preview?.wrap;
	if (!wrap) return;
	const cards = Array.from(wrap.children || []);
	if (!cards.length) {
		wrap.style.display = "none";
		if (preview.controls) preview.controls.style.display = "none";
		node.__gjjLazyPreviewHeight = 0;
		return;
	}
	const mode = lazyPreviewLayoutMode(node);
	const paged = mode === "page" && cards.length > 1;
	const page = lazyPreviewPageIndex(node);
	if (preview.controls) preview.controls.style.display = cards.length > 1 ? "flex" : "none";
	if (preview.modeButton) {
		preview.modeButton.textContent = paged ? "分页" : "平铺";
		preview.modeButton.title = paged ? "当前为分页浏览，点击切换为平铺。" : "当前为平铺浏览，点击切换为分页。";
		preview.modeButton.style.background = paged ? "#245c42" : "#172026";
		preview.modeButton.style.borderColor = paged ? "#5fc585" : "#41535b";
		preview.modeButton.style.color = paged ? "#ffffff" : "#dce7e2";
	}
	if (preview.pageLabel) preview.pageLabel.textContent = `${page + 1}/${cards.length}`;
	if (preview.prevButton) preview.prevButton.disabled = !paged || page <= 0;
	if (preview.nextButton) preview.nextButton.disabled = !paged || page >= cards.length - 1;
	const single = cards.length === 1 || paged;
	wrap.style.display = single ? "grid" : "flex";
	const tileGap = 4;
	wrap.style.gap = single ? "6px" : `${tileGap}px`;
	wrap.style.flexWrap = single ? "" : "wrap";
	wrap.style.alignItems = single ? "" : "flex-start";
	wrap.style.gridTemplateColumns = single ? "minmax(0, 1fr)" : "";
	const contentWidth = Math.max(0, Math.round(Number(width || node?.size?.[0] || 320) - 20));
	const tileHeight = Math.max(86, Math.min(180, Math.round(contentWidth / 3)));
	let rowWidth = 0;
	let rowCount = 1;
	for (const [index, card] of cards.entries()) {
		card.style.display = !paged || index === page ? "block" : "none";
		const item = card.__gjjLazyPreviewItem || {};
		const itemWidth = Math.max(1, Number(item.width || 1));
		const itemHeight = Math.max(1, Number(item.height || 1));
		const tileWidth = Math.max(56, Math.round(tileHeight * itemWidth / itemHeight));
		card.style.aspectRatio = single ? lazyPreviewAspectRatio(item) : "1 / 1";
		card.style.padding = "0";
		card.style.border = single ? "1px solid #33434a" : "0";
		card.style.borderRadius = single ? "8px" : "0";
		card.style.background = single ? "#0f1418" : "transparent";
		card.style.height = single ? "" : `${tileHeight}px`;
		card.style.width = single ? "" : `${tileWidth}px`;
		card.style.flex = single ? "" : "0 0 auto";
		const image = card.querySelector("img");
		if (image) {
			image.style.objectFit = "contain";
			image.style.borderRadius = single ? "7px" : "0";
		}
		if (!single) {
			const nextWidth = rowWidth ? rowWidth + tileGap + tileWidth : tileWidth;
			if (nextWidth > contentWidth && rowWidth) {
				rowCount += 1;
				rowWidth = tileWidth;
			} else {
				rowWidth = nextWidth;
			}
		}
	}
	const controlHeight = cards.length > 1 ? 24 + 6 : 0;
	if (single) {
		const item = cards[page]?.__gjjLazyPreviewItem || cards[0]?.__gjjLazyPreviewItem || {};
		const itemWidth = Number(item.width || 1);
		const itemHeight = Number(item.height || 1);
		node.__gjjLazyPreviewHeight = Math.max(96, Math.ceil(contentWidth * itemHeight / itemWidth) + controlHeight + 10);
		return;
	}
	const gap = Math.max(0, rowCount - 1) * tileGap;
	node.__gjjLazyPreviewHeight = Math.max(96, rowCount * tileHeight + gap + controlHeight + 10);
}

function configureImagePreviewWidget(node, widget, container) {
	if (!widget) {
		return;
	}
	widget.computeSize = (width) => [
		Math.max(0, Math.round(Number(width || node?.size?.[0] || 320) - 20)),
		lazyPreviewHeightForNode(node, width),
	];
	widget.getHeight = () => lazyPreviewHeightForNode(node);
	if (container) {
		container.style.width = "100%";
		container.style.maxWidth = "100%";
		container.style.minWidth = "0";
	}
}

function matchPreset(unetName) {
	const normalized = normalizeText(unetName);
	const canonical = canonicalizeText(unetName);
	const familyCanonical = canonicalizeText(modelFamilyStem(unetName));
	let best = null;
	let bestLength = -1;
	for (const preset of MODEL_PRESETS) {
		for (const keyword of preset.keywords || []) {
			const terms = String(keyword || "").split("+").map((term) => term.trim()).filter(Boolean);
			let matchLength = 0;
			const matches = terms.length > 0 && terms.every((term) => {
				const normalizedKeyword = normalizeText(term);
				const canonicalKeyword = canonicalizeText(term);
				const familyKeyword = canonicalizeText(modelFamilyStem(term));
				const matched = normalized.includes(normalizedKeyword)
					|| (canonicalKeyword && canonical.includes(canonicalKeyword))
					|| (familyKeyword && familyCanonical.includes(familyKeyword));
				if (matched) {
					matchLength += (familyKeyword || canonicalKeyword || normalizedKeyword).length;
				}
				return Boolean(matched);
			});
			if (matches && matchLength > bestLength) {
				best = preset;
				bestLength = matchLength;
			}
		}
	}
	return best;
}

function usesEqualReferenceCanvas(preset, unetName = "") {
	const text = canonicalizeText([
		preset?.id || "",
		...(preset?.keywords || []),
		unetName || "",
	].join("|"));
	return text.includes("qwenimageedit2511") || text.includes("fireredimageedit11");
}

function updateMainImageIndexState(node, preset) {
	const widget = getWidget(node, "main_image_index");
	if (!widget) {
		return;
	}
	const locked = usesEqualReferenceCanvas(preset, getWidget(node, "unet_name")?.value || "");
	setWidgetEnabled(widget, !locked);
	widget.tooltip = locked
		? "当前 Qwen Image Edit 2511 / FireRed Image Edit 1.1 分支使用平等参考；主图序号不参与。"
		: "有多张参考图时，哪一张作为主参考排在最前。";
}

function resolveLoraSuggestedSteps(loraName) {
	const text = String(loraName || "").toLowerCase();
	if (text.includes("flux_2-turbo-lora-comfyui_8steps_v2") || text.includes("flux2turbocomfyv2")) {
		return 8;
	}
	if (text.includes("8step")) {
		return 8;
	}
	if (text.includes("4step")) {
		return 4;
	}
	return null;
}

function isLoraEnabled(name, strength) {
	return Boolean(String(name || "").trim()) && Math.abs(Number(strength || 0)) > 1e-6;
}

function hasConfiguredLoraRows(node) {
	return ensureLoraNodeState(node).rows.some((row) => String(row?.name || "").trim());
}

function syncStepsFromLoras(node) {
	const stepsWidget = getWidget(node, "steps");
	if (!stepsWidget) {
		return;
	}
	const preset = matchPreset(getWidget(node, "unet_name")?.value || "");
	const loraState = ensureLoraNodeState(node);
	for (const row of loraState.rows) {
		if (row.enabled && row.name) {
			const suggested = resolveLoraSuggestedSteps(row.name);
			if (Number.isFinite(suggested)) {
				setWidgetValue(stepsWidget, suggested);
				return;
			}
		}
	}
	if (preset && Number.isFinite(preset.baseSteps)) {
		setWidgetValue(stepsWidget, preset.baseSteps);
	}
}

function replaceLoraRows(node, rows) {
	const normalizedRows = Array.isArray(rows) && rows.length
		? rows.map((row) => ({
			enabled: row?.enabled !== false,
			name: String(row?.name || ""),
			strength: normalizeStrength(row?.strength, 1.0),
		}))
		: [{ ...DEFAULT_ROW }];
	const state = ensureLoraNodeState(node);
	state.rows = normalizedRows;
	persistLoraRows(node, normalizedRows);
	renderLoraUi(node);
}

function availableLoraValues(node) {
	const state = ensureLoraNodeState(node);
	return (state.options || []).map((option) => String(option?.value || "")).filter(Boolean);
}

function resolveLoraRowsToAvailable(node) {
	const state = ensureLoraNodeState(node);
	const values = availableLoraValues(node);
	if (!values.length) {
		return false;
	}
	let changed = false;
	state.rows = state.rows.map((row) => {
		const name = String(row?.name || "");
		const resolved = resolveLoraValue(values, name);
		if (resolved !== name) {
			changed = true;
		}
		return {
			enabled: row?.enabled !== false,
			name: resolved,
			strength: normalizeStrength(row?.strength, 1.0),
		};
	});
	if (changed) {
		persistLoraRows(node, state.rows);
	}
	return changed;
}

function clearPresetLoras(node) {
	replaceLoraRows(node, [{ ...DEFAULT_ROW }]);
}

function applyPreset(node, force = false) {
	const unetWidget = getWidget(node, "unet_name");
	if (!unetWidget) {
		return;
	}
	node.properties = node.properties || {};
	const currentUnet = String(unetWidget.value || "");
	const preset = matchPreset(currentUnet);
	updateMainImageIndexState(node, preset);
	if (!preset) {
		if (force || !hasConfiguredLoraRows(node)) {
			clearPresetLoras(node);
		}
		node.properties[LAST_PRESET_KEY] = currentUnet;
		return;
	}
	if (!force && hasConfiguredLoraRows(node) && node.properties[LAST_PRESET_KEY] !== currentUnet) {
		node.properties[LAST_PRESET_KEY] = currentUnet;
		return;
	}
	const hasPresetLora = Boolean(
		String(preset.lora1 || "").trim() || String(preset.lora2 || "").trim()
	);
	if (!hasPresetLora && (force || !hasConfiguredLoraRows(node))) {
		clearPresetLoras(node);
	}
	if (!force && node.properties[LAST_PRESET_KEY] === currentUnet) {
		return;
	}
	const clipWidget = getWidget(node, "clip_name1");
	const vaeWidget = getWidget(node, "vae_name");
	const clipValues = Array.isArray(clipWidget?.options?.values) ? clipWidget.options.values : [];
	const vaeValues = Array.isArray(vaeWidget?.options?.values) ? vaeWidget.options.values : [];
	const currentClipName = String(clipWidget?.value || "");
	const isFluxDualClip = (
		normalizeText(preset.clipType) === "flux"
		&& canonicalizeText((preset.clipNames || [])[0]) === "cliplsafetensors"
	);
	if (isFluxDualClip) {
		const preferredT5Names = [
			(preset.clipNames || [])[1],
			"t5xxl_int8_convrot.safetensors",
			"t5xxl_int4_convrot.safetensors",
			"t5xxl_fp16.safetensors",
		].filter(Boolean);
		const selectedT5 = preferredT5Names.find((name) => clipValues.includes(name))
			|| clipValues.find((name) => canonicalizeText(name).includes("t5xxl"))
			|| preferredValue(clipValues, preferredT5Names[0] || "");
		setWidgetValue(clipWidget, selectedT5);
	} else {
		const prioritizedClipValues = currentClipName
			? [currentClipName, ...clipValues.filter((value) => String(value) !== currentClipName)]
			: clipValues;
		setWidgetValue(clipWidget, preferredValue(prioritizedClipValues, (preset.clipNames || [])[0] || ""));
	}
	setWidgetValue(vaeWidget, preferredValue(vaeValues, preset.vaeName || ""));
	const isMageFlowPreset = canonicalizeText(preset.id) === "mageflow";
	const isMageFlowTurbo = isMageFlowPreset && canonicalizeText(currentUnet).includes("turbo");
	if (isMageFlowPreset) {
		setWidgetValue(getWidget(node, "steps"), isMageFlowTurbo ? 4 : 30);
		setWidgetValue(getWidget(node, "cfg"), isMageFlowTurbo ? 1.0 : 5.0);
	} else {
		if (Number.isFinite(preset.steps)) {
			setWidgetValue(getWidget(node, "steps"), Number(preset.steps));
		}
		if (Number.isFinite(preset.cfg)) {
			setWidgetValue(getWidget(node, "cfg"), Number(preset.cfg));
		}
	}
	if (preset.sampler) {
		setWidgetValue(getWidget(node, "sampler_name"), preset.sampler);
	}
	if (preset.scheduler) {
		setWidgetValue(getWidget(node, "scheduler"), preset.scheduler);
	}
	if (Number.isFinite(preset.denoise)) {
		setWidgetValue(getWidget(node, "denoise"), Number(preset.denoise));
	}
	if (Number.isFinite(preset.width)) {
		setWidgetValue(getWidget(node, "width"), Number(preset.width));
	}
	if (Number.isFinite(preset.height)) {
		setWidgetValue(getWidget(node, "height"), Number(preset.height));
	}

	let newLoraRows = [];
	const loraValues = availableLoraValues(node);
	if (hasPresetLora) {
		if (preset.lora1 && String(preset.lora1).trim()) {
			newLoraRows.push({
				enabled: preset.lora1AutoEnabled !== false,
				name: resolveLoraValue(loraValues, preset.lora1),
				strength: normalizeStrength(preset.lora1Strength, 1.0),
			});
		}
		if (preset.lora2 && String(preset.lora2).trim()) {
			newLoraRows.push({
				enabled: true,
				name: resolveLoraValue(loraValues, preset.lora2),
				strength: normalizeStrength(preset.lora2Strength, 0.7),
			});
		}
		newLoraRows.push({ ...DEFAULT_ROW });
	} else {
		newLoraRows = [{ ...DEFAULT_ROW }];
	}

	replaceLoraRows(node, newLoraRows);
	syncStepsFromLoras(node);

	node.properties[LAST_PRESET_KEY] = currentUnet;
}

function hookUnetWidget(node) {
	const widget = getWidget(node, "unet_name");
	if (!widget || widget.__gjjLazyHooked) {
		return;
	}
	widget.__gjjLazyHooked = true;
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const result = original?.call(this, value, ...args);

		node.properties = node.properties || {};
		node.properties[LAST_PRESET_KEY] = "";
		clearPresetLoras(node);
		applyPreset(node, true);
		GJJ_Utils.refreshNode(node);
		return result;
	};
}

function hookModelSourceWidget(node) {
	const widget = getWidget(node, MODEL_SOURCE_WIDGET_NAME);
	if (!widget || widget.__gjjLazyModelSourceHooked) {
		return;
	}
	widget.__gjjLazyModelSourceHooked = true;
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const result = original?.call(this, value, ...args);
		applySettingsVisibility(node);
		writeLiveParamSnapshot(node);
		GJJ_Utils.refreshNode(node);
		return result;
	};
}

function hookKeepModelWidget(node) {
	const widget = getWidget(node, KEEP_MODEL_WIDGET_NAME);
	if (!widget || widget.__gjjLazyKeepModelHooked) {
		return;
	}
	widget.__gjjLazyKeepModelHooked = true;
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const result = original?.call(this, value, ...args);
		applyKeepModelButtonState(node);
		updateModelSettingsButtonState(node);
		writeLiveParamSnapshot(node);
		return result;
	};
}

function normalizeStrength(value, fallback = 1.0) {
	const parsed = Number.parseFloat(value);
	if (Number.isNaN(parsed)) {
		return fallback;
	}
	return parsed;
}

function isPartialNumericInput(value) {
	const text = String(value ?? "").trim();
	return text === "" || text === "-" || text === "+" || text === "." || text === "-." || text === "+.";
}

function formatStrength(value, fallback = 1.0) {
	return normalizeStrength(value, fallback).toFixed(2);
}

function loraPreviewUrl(loraName, previews = {}) {
	const name = String(loraName || "");
	if (!name) {
		return "";
	}
	if (previews[name]) {
		return String(previews[name]);
	}
	return `${LORA_PREVIEW_API_PREFIX}${encodeURIComponent(name)}`;
}

function normalizeLoraKeyword(value) {
	return String(value || "").trim().toLowerCase();
}

function normalizeLoraToken(value) {
	return normalizeLoraKeyword(value)
		.split(/[\\/]/)
		.pop()
		.replace(/\.(safetensors|ckpt|pt|bin)$/i, "")
		.replace(/^krea-2-lora-/i, "")
		.replace(/^krea2[_-]/i, "")
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function getLoraMetadata(state, loraName) {
	const selected = normalizeLoraToken(loraName);
	if (!selected) {
		return null;
	}
	return (state.metadata || []).find((item) => {
		const matches = Array.isArray(item?.match) ? item.match : [];
		return matches.some((keyword) => {
			const token = normalizeLoraToken(keyword);
			return token && (selected.includes(token) || token.includes(selected));
		});
	}) || null;
}

function loraSearchHaystack(option, metadata) {
	return [
		option?.value,
		option?.label,
		metadata?.title,
		metadata?.trigger,
		metadata?.summary,
		...(Array.isArray(metadata?.match) ? metadata.match : []),
	].map((item) => normalizeLoraKeyword(item)).filter(Boolean).join(" ");
}

function parseLoraSearchExpression(value) {
	const normalized = normalizeLoraKeyword(value).replace(/\s+/g, "&");
	if (!normalized) {
		return [];
	}
	return normalized
		.split(/[&+＋]+/)
		.map((group) => group
			.split(/[,\uFF0C\u3001;\uFF1B|]+/)
			.map((item) => normalizeLoraKeyword(item))
			.filter(Boolean))
		.filter((group) => group.length > 0);
}

function matchesLoraSearchExpression(text, expressionGroups) {
	if (!expressionGroups.length) {
		return true;
	}
	return expressionGroups.every((group) => group.some((keyword) => text.includes(keyword)));
}

function normalizeRows(value) {
	let parsed = [];
	try {
		const raw = JSON.parse(String(value || "[]"));
		if (Array.isArray(raw)) {
			parsed = raw;
		}
	} catch (error) {
		parsed = [];
	}

	const rows = parsed
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			enabled: item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
		}));

	const nonEmptyRows = rows.filter((item) => item.name);
	nonEmptyRows.push({ ...DEFAULT_ROW });
	return nonEmptyRows.length > 0 ? nonEmptyRows : [{ ...DEFAULT_ROW }];
}

function serializeRows(rows) {
	const cleaned = rows
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			enabled: item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
		}))
		.filter((item) => item.name);
	return JSON.stringify(cleaned);
}

function looksLikeLoraRowsData(value) {
	try {
		const parsed = JSON.parse(String(value || ""));
		return Array.isArray(parsed) && parsed.some((item) => item && typeof item === "object" && (
			Object.prototype.hasOwnProperty.call(item, "name")
			|| Object.prototype.hasOwnProperty.call(item, "strength")
			|| Object.prototype.hasOwnProperty.call(item, "enabled")
		));
	} catch (error) {
		return false;
	}
}

function readStoredLoraData(node, serializedNode = null) {
	const dataWidget = getWidget(node, LORA_DATA_WIDGET_NAME);
	for (const value of [
		serializedNode?.properties?.[LORA_DATA_WIDGET_NAME],
		node?.properties?.[LORA_DATA_WIDGET_NAME],
		dataWidget?.value,
	]) {
		const text = String(value || "").trim();
		if (text) {
			return text;
		}
	}
	for (const value of Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : []) {
		const text = String(value || "").trim();
		if (text && looksLikeLoraRowsData(text)) {
			return text;
		}
	}
	return "[]";
}

function persistLoraRows(node, rows = null, serializedNode = null) {
	const serialized = serializeRows(rows || ensureLoraNodeState(node).rows);
	node.properties = node.properties || {};
	node.properties[LORA_DATA_WIDGET_NAME] = serialized;
	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[LORA_DATA_WIDGET_NAME] = serialized;
	}
	const dataWidget = getWidget(node, LORA_DATA_WIDGET_NAME);
	if (dataWidget) {
		dataWidget.value = serialized;
		const widgetIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(dataWidget) : -1;
		if (Array.isArray(node.widgets_values) && widgetIndex >= 0) {
			node.widgets_values[widgetIndex] = serialized;
		}
	}
	return serialized;
}

async function fetchLoraOptions() {
	try {
		const response = await fetch("/gjj/loras");
		if (!response.ok) {
			return [DEFAULT_EMPTY_OPTION];
		}

		const data = await response.json();
		const values = Array.isArray(data?.loras) ? data.loras : [];
		const options = [];
		for (const item of values) {
			const value = String(item || "");
			if (!options.some((option) => option.value === value)) {
				options.push({
					value,
					label: value || DEFAULT_EMPTY_OPTION.label,
				});
			}
		}
		if (!options.some((option) => option.value === "")) {
			options.unshift({ ...DEFAULT_EMPTY_OPTION });
		}
		return options;
	} catch (error) {
		return [DEFAULT_EMPTY_OPTION];
	}
}

async function fetchLoraMetadata() {
	try {
		const response = await fetch(LORA_METADATA_API_PATH);
		if (!response.ok) {
			return { metadata: [], previews: {} };
		}
		const data = await response.json();
		return {
			metadata: Array.isArray(data?.metadata) ? data.metadata : [],
			previews: data?.previews && typeof data.previews === "object" ? data.previews : {},
		};
	} catch (error) {
		return { metadata: [], previews: {} };
	}
}

function hideLoraDataWidget(node, widget) {
	if (!widget) {
		return;
	}
	widget.__gjjNode = node;
	widget.type = "hidden";
	widget.hidden = true;
	widget.serialize = true;
	widget.serializeValue = () => {
		const targetNode = widget.__gjjNode || node;
		const state = ensureLoraNodeState(targetNode);
		const serialized = serializeRows(state.rows);
		const widgetIndex = Array.isArray(targetNode?.widgets)
			? targetNode.widgets.indexOf(widget)
			: -1;
		if (Array.isArray(targetNode?.widgets_values) && widgetIndex >= 0) {
			targetNode.widgets_values[widgetIndex] = serialized;
		}
		return serialized;
	};
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	widget.label = "";
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.widget) {
		widget.widget.style.display = "none";
	}
}

function ensureLoraNodeState(node) {
	node.properties = node.properties || {};
	if (node.__gjjLoraState) {
		// 如果内存中已有状态，直接返回（优先使用内存中的状态）
		return node.__gjjLoraState;
	}
	// 第一次初始化时，从 properties 读取
	node.__gjjLoraState = {
		rows: normalizeRows(readStoredLoraData(node)),
		options: [{ ...DEFAULT_EMPTY_OPTION }],
		metadata: [],
		previews: {},
		globalSearch: String(node.properties?.[LORA_GLOBAL_SEARCH_PROPERTY] || ""),
	};
	return node.__gjjLoraState;
}

function updateLoraNodeHeight(node, rowCount) {
	const baseHeight = 78;
	const rowHeight = 64;
	const targetHeight = baseHeight + rowCount * rowHeight;
	node.size = [Math.max(node.size?.[0] || 420, 420), targetHeight];
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function updateLoraDataWidget(node) {
	const state = ensureLoraNodeState(node);
	persistLoraRows(node, state.rows);

	// 同步步数
	syncStepsFromLoras(node);

	// 通知 ComfyUI 节点已更改
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function ensureTrailingEmptyRow(node) {
	const state = ensureLoraNodeState(node);
	const rows = state.rows.filter((item) => item && typeof item === "object");
	const normalized = rows
		.filter((item) => String(item.name || "").trim())
		.map((item) => ({
			enabled: item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
		}));
	normalized.push({ ...DEFAULT_ROW });
	state.rows = normalized;
}

function getDefaultSearchValue(index) {
	return index === 0 ? DEFAULT_FIRST_SEARCH_TERMS : "";
}

function setLoraGlobalSearch(node, value) {
	const state = ensureLoraNodeState(node);
	state.globalSearch = String(value || "");
	node.properties = node.properties || {};
	node.properties[LORA_GLOBAL_SEARCH_PROPERTY] = state.globalSearch;
	if (node.__gjjLoraGlobalSearchInput && node.__gjjLoraGlobalSearchInput.value !== state.globalSearch) {
		node.__gjjLoraGlobalSearchInput.value = state.globalSearch;
	}
	if (globalThis.__gjjLoraPopup?.state?.node === node) {
		globalThis.__gjjLoraPopup.search.value = state.globalSearch;
		globalThis.__gjjLoraPopup.render();
	}
}

function stopCanvasPointerCapture(event) {
	event.stopPropagation();
}

function stopCanvasWheelCapture(event) {
	event.stopPropagation();
}

function ensureGlobalLoraPopup() {
	if (globalThis.__gjjLoraPopup) {
		return globalThis.__gjjLoraPopup;
	}

	const panel = document.createElement("div");
	panel.className = "gjj-lora-popup";
	// 确保面板有正确的样式，不使用 CSS class 中的 position:absolute，直接使用 fixed
	panel.style.cssText = `
		display: none;
		flex-direction: column;
		gap: 6px;
		position: fixed;
		left: 12px;
		top: 12px;
		min-width: 280px;
		max-width: 560px;
		width: 420px;
		padding: 6px;
		border: 1px solid #41535b;
		border-radius: 8px;
		background: #10171b;
		box-sizing: border-box;
		z-index: 99999;
		box-shadow: 0 8px 24px rgba(0,0,0,0.35);
	`;

	const search = document.createElement("input");
	search.type = "text";
	search.className = "gjj-lora-popup-search";
	search.style.cssText = `
		width: 100%;
		min-width: 0;
		background: #11181c;
		color: #dce7e2;
		border: 1px solid #41535b;
		border-radius: 6px;
		padding: 4px 6px;
		box-sizing: border-box;
	`;

	const list = document.createElement("div");
	list.className = "gjj-lora-popup-list";
	list.style.cssText = `
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 180px;
		overflow: auto;
	`;

	panel.appendChild(search);
	panel.appendChild(list);
	document.body.appendChild(panel);

	// 阻止事件冒泡但不阻止正常的点击事件
	const stopPropagationOnly = (event) => {
		event.stopPropagation();
	};

	// 只在 mousedown 和 pointerdown 上阻止事件冒泡，不在 click 上阻止
	panel.addEventListener("mousedown", stopPropagationOnly, true);
	panel.addEventListener("pointerdown", stopPropagationOnly, true);
	panel.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	panel.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });
	list.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	list.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });

	const popup = {
		panel,
		search,
		list,
		state: null,
		close() {
			panel.style.display = "none";
			search.value = "";
			search.placeholder = "搜索";
			search.title = "";
			list.replaceChildren();
			this.state = null;
			document.removeEventListener("pointerdown", outsideHandler, true);
		},
		reposition() {
			if (!this.state?.anchorEl) {
				return;
			}
			const rect = this.state.anchorEl?.getBoundingClientRect?.();
			const viewportWidth = Math.max(320, window.innerWidth || 320);
			const viewportHeight = Math.max(240, window.innerHeight || 240);
			const horizontalPadding = 12;
			const verticalPadding = 12;
			const maxPopupWidth = 560;
			const hostPanel = this.state.node?.__gjjLazyModelFloatingPanel?.panel;
			const hostRect = hostPanel?.contains?.(this.state.anchorEl)
				? hostPanel.getBoundingClientRect()
				: null;
			const boundaryLeft = hostRect
				? Math.max(horizontalPadding, Math.floor(hostRect.left) + 8)
				: horizontalPadding;
			const boundaryRight = hostRect
				? Math.min(viewportWidth - horizontalPadding, Math.ceil(hostRect.right) - 8)
				: viewportWidth - horizontalPadding;
			const boundaryTop = hostRect
				? Math.max(verticalPadding, Math.floor(hostRect.top) + 8)
				: verticalPadding;
			const boundaryBottom = hostRect
				? Math.min(viewportHeight - verticalPadding, Math.ceil(hostRect.bottom) - 8)
				: viewportHeight - verticalPadding;
			const availableWidth = Math.max(280, boundaryRight - boundaryLeft);
			const minPopupWidth = Math.min(420, Math.max(280, availableWidth));
			const targetWidth = Math.min(
				Math.max(Math.min(Math.ceil(rect?.width || minPopupWidth), maxPopupWidth), minPopupWidth),
				availableWidth,
				maxPopupWidth,
			);
			const spaceBelow = Math.max(96, boundaryBottom - Math.ceil(rect?.bottom || boundaryTop) - 6);
			const spaceAbove = Math.max(96, Math.floor(rect?.top || boundaryBottom) - boundaryTop - 6);
			const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
			const panelMaxHeight = Math.max(140, Math.min(320, openAbove ? spaceAbove : spaceBelow));
			const listMaxHeight = Math.max(96, panelMaxHeight - 52);
			const rawLeft = Math.floor(rect?.left || boundaryLeft);
			const left = Math.max(boundaryLeft, Math.min(rawLeft, boundaryRight - targetWidth));
			const top = openAbove
				? Math.max(boundaryTop, Math.floor(rect?.top || boundaryTop) - panelMaxHeight - 6)
				: Math.min(Math.ceil(rect?.bottom || boundaryTop) + 6, boundaryBottom - panelMaxHeight);

			panel.style.width = `${targetWidth}px`;
			panel.style.maxWidth = `${Math.min(maxPopupWidth, availableWidth)}px`;
			panel.style.maxHeight = `${panelMaxHeight}px`;
			list.style.maxHeight = `${listMaxHeight}px`;
			panel.style.left = `${left}px`;
			panel.style.bottom = "auto";
			panel.style.top = `${Math.max(boundaryTop, top)}px`;
		},
		render() {
			if (!this.state) {
				return;
			}

			const selectedValue = String(this.state.getSelectedValue?.() || "");
			const options = this.state.getOptions(search.value);
			list.replaceChildren();

			if (!options.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-lora-popup-empty";
				empty.textContent = "没有匹配的 LoRA";
				list.appendChild(empty);
				this.reposition();
				return;
			}

			for (const option of options) {
				const item = document.createElement("div");
				item.setAttribute("role", "button");
				item.tabIndex = 0;
				item.className = "gjj-lora-popup-item";
				item.style.cssText = [
					"pointer-events:auto",
					"user-select:none",
				].join(";");
				const isSelected = String(option.value || "") === selectedValue;
				if (isSelected) {
					item.classList.add("selected");
				}

				const name = document.createElement("div");
				name.className = "gjj-lora-popup-name";
				name.textContent = `${isSelected ? "✔ " : ""}${option.label}`;
				item.appendChild(name);

				const metadata = this.state.getMetadata?.(String(option.value || ""));
				if (metadata) {
					const previewUrl = this.state.getPreviewUrl?.(String(option.value || "")) || "";
					const hasLocalPreview = Boolean(previewUrl && this.state.hasPreview?.(String(option.value || "")));
					if (hasLocalPreview) {
						item.classList.add("with-thumb");
						const thumb = document.createElement("img");
						thumb.className = "gjj-lora-popup-thumb";
						thumb.alt = String(metadata.title || option.label || "LoRA preview");
						thumb.loading = "lazy";
						thumb.decoding = "async";
						thumb.src = previewUrl;
						thumb.addEventListener("error", () => {
							item.classList.remove("with-thumb");
							thumb.remove();
						}, { once: true });
						item.insertBefore(thumb, name);
					}

					const meta = document.createElement("div");
					meta.className = "gjj-lora-popup-meta";

					const title = document.createElement("span");
					title.className = "gjj-lora-popup-title";
					title.textContent = String(metadata.title || "");

					const trigger = document.createElement("span");
					trigger.className = "gjj-lora-popup-trigger";
					trigger.textContent = String(metadata.trigger || "");
					trigger.title = `触发词：${metadata.trigger || ""}`;

					const recommendedStrength = document.createElement("span");
					recommendedStrength.className = "gjj-lora-popup-strength";
					recommendedStrength.textContent = formatStrength(metadata.strength, 1.0);

					const previewButton = document.createElement("button");
					previewButton.type = "button";
					previewButton.className = "gjj-lora-popup-preview";
					previewButton.textContent = "▣";
					previewButton.title = "展开缩略图和简介。";

					const previewCard = document.createElement("div");
					previewCard.className = "gjj-lora-preview-card";

					const image = document.createElement("img");
					image.alt = String(metadata.title || option.label || "LoRA preview");
					image.loading = "lazy";
					image.decoding = "async";
					image.dataset.src = previewUrl;
					image.addEventListener("error", () => {
						const fallback = document.createElement("div");
						fallback.className = "gjj-lora-preview-fallback";
						fallback.textContent = "可放同名 preview 小图";
						image.replaceWith(fallback);
					}, { once: true });

					const copy = document.createElement("div");
					copy.className = "gjj-lora-preview-copy";
					copy.innerHTML = `
						<strong></strong>
						<span></span>
						<code></code>
						<span></span>
					`;
					copy.children[0].textContent = String(metadata.title || option.label || "");
					copy.children[1].textContent = String(metadata.summary || "");
					copy.children[2].textContent = String(metadata.trigger || "");
					copy.children[3].textContent = `推荐强度 ${formatStrength(metadata.strength, 1.0)}`;

					previewCard.appendChild(image);
					previewCard.appendChild(copy);

					previewButton.addEventListener("click", (event) => {
						event.preventDefault();
						event.stopPropagation();
						const open = !previewCard.classList.contains("open");
						if (open && image.dataset.src && !image.src) {
							image.src = image.dataset.src;
						}
						previewCard.classList.toggle("open", open);
						previewButton.classList.toggle("open", open);
						this.reposition();
					});

					meta.appendChild(title);
					meta.appendChild(trigger);
					meta.appendChild(recommendedStrength);
					meta.appendChild(previewButton);
					item.appendChild(meta);
					item.appendChild(previewCard);
				} else {
					item.title = String(option.label || "");
				}

				function runItemClick(event) {
					if (event.target?.closest?.(".gjj-lora-popup-preview, .gjj-lora-preview-card")) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					console.log("[GJJ] LoRA 弹出窗口选项被点击", option.value);
					popup.state?.onSelect?.(String(option.value || ""));
				}

				// 根据指南：在 mousedown 和 pointerdown 上只阻止冒泡
				for (const eventName of ["pointerdown", "mousedown"]) {
					item.addEventListener(eventName, (event) => event.stopPropagation(), true);
				}

				// ComfyUI 画布可能拦截合成 click；只处理 pointerup，既可靠又避免双触发。
				item.addEventListener("pointerup", runItemClick, true);
				item.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						runItemClick(event);
					}
				}, true);

				list.appendChild(item);
			}

			this.reposition();
		},
		isOpenFor(anchorEl) {
			return panel.style.display === "flex" && this.state?.anchorEl === anchorEl;
		},
		open(state) {
			this.state = state;
			search.value = String(state.searchValue || "");
			search.placeholder = String(state.placeholder || "搜索");
			search.title = String(state.searchTitle || "");
			panel.style.display = "flex";
			this.reposition();
			this.render();
			document.addEventListener("pointerdown", outsideHandler, true);
			setTimeout(() => search.focus(), 0);
		},
	};

	function outsideHandler(event) {
		if (!popup.state) {
			return;
		}
		if (panel.contains(event.target) || popup.state.anchorEl?.contains?.(event.target)) {
			return;
		}
		popup.close();
	}

	search.addEventListener("input", () => {
		if (!popup.state) {
			return;
		}
		popup.state.onSearchChange?.(search.value);
		popup.render();
	});
	search.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Escape") {
			event.preventDefault();
			popup.close();
		}
	});
	window.addEventListener("resize", () => popup.reposition());

	globalThis.__gjjLoraPopup = popup;
	return popup;
}

function buildLoraRow(node, row, index, rowsContainer) {
	const state = ensureLoraNodeState(node);
	const metadata = getLoraMetadata(state, row.name);
	const rowElement = document.createElement("div");
	rowElement.className = `gjj-lora-row${row.enabled ? "" : " off"}`;

	const mainColumn = document.createElement("div");
	mainColumn.className = "gjj-lora-main";

	const picker = document.createElement("button");
	picker.type = "button";
	picker.className = "gjj-lora-picker";
	picker.title = "点击展开当前这一行 LoRA 的可搜索下拉列表。";

	const toggleWrap = document.createElement("label");
	toggleWrap.className = "gjj-lora-toggle-wrap";
	toggleWrap.title = "控制当前这一行 LoRA 是否参与串联加载。";

	const toggle = document.createElement("input");
	toggle.type = "checkbox";
	toggle.checked = row.enabled !== false;
	toggleWrap.appendChild(toggle);
	toggleWrap.appendChild(document.createTextNode("启用"));

	const strength = document.createElement("input");
	strength.type = "number";
	strength.className = "gjj-lora-strength";
	strength.step = "0.05";
	strength.value = formatStrength(row.strength, 1.0);
	strength.title = "设置当前 LoRA 的模型与 CLIP 共用强度值。";

	function updatePickerLabel() {
		picker.textContent = row.name || DEFAULT_EMPTY_OPTION.label;
	}

	// 根据指南文档：按钮点击事件处理
	async function runPickerClick(event) {
		event.preventDefault();
		event.stopPropagation();
		console.log("[GJJ] LoRA 选择器按钮被点击", node?.id, index);

		const popup = ensureGlobalLoraPopup();
		if (popup.isOpenFor(picker)) {
			popup.close();
			return;
		}
		closeLazyFloatingSurfaces(node, modelSettingsOpen(node) ? "model" : "lora");
		popup.open({
			node,
			anchorEl: picker,
			searchValue: state.globalSearch || getDefaultSearchValue(index),
			placeholder: "全局过滤 LoRA",
			searchTitle: "输入关键词筛选当前节点所有 LoRA 下拉选项；不区分大小写。语法：& 表示与，, 或 | 表示或。示例：flux & turbo,lightning,hyper",
			onSearchChange(searchValue) {
				setLoraGlobalSearch(node, searchValue);
			},
			getSelectedValue() {
				return String(state.rows[index]?.name || "");
			},
			getMetadata(value) {
				return getLoraMetadata(state, value);
			},
			getPreviewUrl(value) {
				return loraPreviewUrl(value, state.previews);
			},
			hasPreview(value) {
				return Boolean(state.previews?.[String(value || "")]);
			},
			getOptions(searchText) {
				let options = state.options;
				if (state.rows[index]?.name && !options.some((option) => option.value === state.rows[index].name)) {
					options = [...options, { value: state.rows[index].name, label: state.rows[index].name }];
				}
				const activeSearch = String(searchText || state.globalSearch || "");
				if (!activeSearch) {
					return options;
				}
				const expressionGroups = parseLoraSearchExpression(activeSearch);
				return options.filter((opt) => {
					if (!opt.value) return true;
					const haystack = loraSearchHaystack(opt, getLoraMetadata(state, opt.value));
					return matchesLoraSearchExpression(haystack, expressionGroups);
				});
			},
			onSelect(value) {
				const previousName = String(state.rows[index]?.name || "");
				const previousStrength = normalizeStrength(state.rows[index]?.strength, 1.0);
				state.rows[index].name = value;
				const selectedMetadata = getLoraMetadata(state, value);
				const shouldUseRecommendedStrength = value
					&& value !== previousName
					&& selectedMetadata
					&& !previousName
					&& Math.abs(previousStrength - 1.0) < 0.0001;
				if (shouldUseRecommendedStrength) {
					state.rows[index].strength = normalizeStrength(selectedMetadata.strength, previousStrength);
				}
				ensureTrailingEmptyRow(node);
				updateLoraDataWidget(node);
				popup.close();
				renderLoraUi(node);
			},
		});
	}

	// ComfyUI 画布可能拦截合成 click；只处理 pointerup，避免弹窗打开后再次切换。
	picker.addEventListener("pointerup", runPickerClick, true);

	// 在 mousedown 和 pointerdown 上只阻止冒泡，不阻止点击逻辑
	for (const eventName of ["pointerdown", "mousedown"]) {
		picker.addEventListener(eventName, (event) => event.stopPropagation(), true);
	}

	toggle.addEventListener("change", () => {
		state.rows[index].enabled = toggle.checked;
		updateLoraDataWidget(node);
		rowElement.classList.toggle("off", !toggle.checked);
	});

	const syncStrengthInput = () => {
		if (isPartialNumericInput(strength.value)) {
			return;
		}
		state.rows[index].strength = normalizeStrength(strength.value, state.rows[index].strength ?? 1.0);
		updateLoraDataWidget(node);
	};

	const commitStrength = () => {
		state.rows[index].strength = normalizeStrength(strength.value, state.rows[index].strength ?? 1.0);
		strength.value = formatStrength(state.rows[index].strength, 1.0);
		updateLoraDataWidget(node);
	};

	// 对于输入框，只阻止必要的事件冒泡
	strength.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Enter") {
			commitStrength();
			strength.blur();
		}
	});
	strength.addEventListener("input", syncStrengthInput);
	strength.addEventListener("change", commitStrength);
	strength.addEventListener("blur", commitStrength);

	updatePickerLabel();
	mainColumn.appendChild(picker);
	if (metadata) {
		const meta = document.createElement("div");
		meta.className = "gjj-lora-meta";

		const title = document.createElement("span");
		title.className = "gjj-lora-meta-title";
		title.textContent = String(metadata.title || "");

		const trigger = document.createElement("span");
		trigger.className = "gjj-lora-meta-trigger";
		trigger.textContent = String(metadata.trigger || "");
		trigger.title = `触发词：${metadata.trigger || ""}`;

		const recommendedStrength = document.createElement("span");
		recommendedStrength.className = "gjj-lora-meta-strength";
		recommendedStrength.textContent = formatStrength(metadata.strength, 1.0);

		const previewButton = document.createElement("button");
		previewButton.type = "button";
		previewButton.className = "gjj-lora-preview-btn";
		previewButton.textContent = "▣";
		previewButton.title = "展开缩略图和简介。";

		const previewCard = document.createElement("div");
		previewCard.className = "gjj-lora-preview-card";

		const image = document.createElement("img");
		image.alt = String(metadata.title || row.name || "LoRA preview");
		image.loading = "lazy";
		image.decoding = "async";
		image.dataset.src = loraPreviewUrl(row.name, state.previews);
		image.addEventListener("error", () => {
			const fallback = document.createElement("div");
			fallback.className = "gjj-lora-preview-fallback";
			fallback.textContent = "可放同名 preview 小图";
			image.replaceWith(fallback);
		}, { once: true });

		const copy = document.createElement("div");
		copy.className = "gjj-lora-preview-copy";
		copy.innerHTML = `
			<strong></strong>
			<span></span>
			<code></code>
			<span></span>
		`;
		copy.children[0].textContent = String(metadata.title || row.name || "");
		copy.children[1].textContent = String(metadata.summary || "");
		copy.children[2].textContent = String(metadata.trigger || "");
		copy.children[3].textContent = `推荐强度 ${formatStrength(metadata.strength, 1.0)}`;

		previewCard.appendChild(image);
		previewCard.appendChild(copy);

		previewButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const open = !previewCard.classList.contains("open");
			if (open && image.dataset.src && !image.src) {
				image.src = image.dataset.src;
			}
			previewCard.classList.toggle("open", open);
			previewButton.classList.toggle("open", open);
		});

		meta.appendChild(title);
		meta.appendChild(trigger);
		meta.appendChild(recommendedStrength);
		meta.appendChild(previewButton);
		mainColumn.appendChild(meta);
		mainColumn.appendChild(previewCard);
	}

	const sideColumn = document.createElement("div");
	sideColumn.className = "gjj-lora-side";
	sideColumn.appendChild(toggleWrap);
	sideColumn.appendChild(strength);

	rowElement.appendChild(mainColumn);
	rowElement.appendChild(sideColumn);
	rowsContainer.appendChild(rowElement);
}

function renderLoraUi(node) {
	const state = ensureLoraNodeState(node);
	const container = node.__gjjLoraContainer;
	const rowsContainer = node.__gjjLoraRows;
	if (!container || !rowsContainer) {
		return;
	}
	const dataWidget = node.widgets?.find((widget) => widget?.name === LORA_DATA_WIDGET_NAME);
	if (dataWidget) {
		hideLoraDataWidget(node, dataWidget);
	}

	if (globalThis.__gjjLoraPopup?.state?.node === node) {
		globalThis.__gjjLoraPopup.close();
	}

	if (node.__gjjLoraGlobalSearchInput) {
		node.__gjjLoraGlobalSearchInput.value = String(state.globalSearch || "");
	}
	ensureTrailingEmptyRow(node);
	rowsContainer.replaceChildren();
	state.rows.forEach((row, index) => buildLoraRow(node, row, index, rowsContainer));
	updateLoraNodeHeight(node, state.rows.length);
	updateLoraDataWidget(node);
}

async function refreshLoraOptions(node, rerender = true) {
	const state = ensureLoraNodeState(node);
	const [options, metadata] = await Promise.all([
		fetchLoraOptions(),
		fetchLoraMetadata(),
	]);
	state.options = options;
	state.metadata = metadata.metadata;
	state.previews = metadata.previews;
	resolveLoraRowsToAvailable(node);
	if (rerender) {
		renderLoraUi(node);
	}
}



function setupLoraUi(node) {
	if (node.__gjjLoraContainer) {
		return;
	}

	// 初始化 state
	const state = ensureLoraNodeState(node);
	state.rows = normalizeRows(readStoredLoraData(node));
	state.globalSearch = String(node.properties?.[LORA_GLOBAL_SEARCH_PROPERTY] || "");

	const container = document.createElement("div");
	container.className = "gjj-lora-wrap";
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"margin-top:4px",
		"pointer-events:auto",
		"position:relative",
		"z-index:100"
	].join(";");

	const style = document.createElement("style");
	style.textContent = `
		.gjj-lora-toolbar { display:flex; flex-direction:row; gap:6px; align-items:center; }
		.gjj-lora-global-search { flex:1; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:5px 8px; box-sizing:border-box; font-size:12px; }
		.gjj-lora-global-search:focus { outline:none; border-color:#6aa6b8; box-shadow:0 0 0 1px rgba(106,166,184,0.35); }
		.gjj-lora-refresh { padding:2px 8px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; }
		.gjj-lora-rows { display:flex; flex-direction:column; gap:6px; }
		.gjj-lora-row { display:flex; align-items:flex-start; gap:6px; padding:6px; border:1px solid #3c4c54; border-radius:8px; background:#172026; }
		.gjj-lora-row.off { opacity:0.65; }
		.gjj-lora-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; position:relative; }
		.gjj-lora-picker { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 8px; box-sizing:border-box; text-align:left; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:auto; }
		.gjj-lora-meta { display:flex; align-items:center; gap:6px; min-height:20px; color:#b9c9cf; font-size:11px; line-height:1.25; }
		.gjj-lora-meta-title { color:#eef8f4; font-weight:600; white-space:nowrap; }
		.gjj-lora-meta-trigger { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9fd4c3; }
		.gjj-lora-meta-strength { flex:0 0 auto; color:#d7c587; }
		.gjj-lora-preview-btn { width:24px; height:22px; flex:0 0 24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:13px; line-height:18px; padding:0; text-align:center; }
		.gjj-lora-preview-btn:hover, .gjj-lora-preview-btn.open { border-color:#6aa6b8; background:#26363d; }
		.gjj-lora-preview-card { display:none; position:absolute; left:0; top:calc(100% + 6px); width:min(360px, 100%); padding:8px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-shadow:0 8px 24px rgba(0,0,0,0.38); z-index:9998; box-sizing:border-box; }
		.gjj-lora-preview-card.open { display:grid; grid-template-columns:92px minmax(0,1fr); gap:8px; }
		.gjj-lora-preview-card img { width:92px; height:92px; object-fit:cover; border-radius:6px; background:#172026; border:1px solid #2e4149; }
		.gjj-lora-preview-fallback { width:92px; height:92px; display:flex; align-items:center; justify-content:center; text-align:center; padding:8px; box-sizing:border-box; border-radius:6px; background:#1b252b; color:#9fb0b7; border:1px solid #2e4149; font-size:11px; }
		.gjj-lora-preview-copy { min-width:0; display:flex; flex-direction:column; gap:5px; font-size:11px; color:#c7d5d8; line-height:1.35; }
		.gjj-lora-preview-copy strong { color:#eef8f4; font-size:12px; }
		.gjj-lora-preview-copy code { color:#9fd4c3; white-space:normal; word-break:break-word; }
		.gjj-lora-popup { display:none; flex-direction:column; gap:6px; position:absolute; top:calc(100% + 6px); left:0; min-width:280px; max-width:560px; width:420px; padding:6px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-sizing:border-box; z-index:9999; box-shadow:0 8px 24px rgba(0,0,0,0.35); }
		.gjj-lora-popup.open { display:flex; }
		.gjj-lora-popup-search { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; box-sizing:border-box; pointer-events:auto; }
		.gjj-lora-popup-list { display:flex; flex-direction:column; gap:4px; max-height:300px; overflow:auto; }
		.gjj-lora-popup-item { width:100%; display:flex; flex-direction:column; gap:4px; background:#182127; color:#dce7e2; border:1px solid #33454c; border-radius:6px; padding:5px 8px; text-align:left; cursor:pointer; box-sizing:border-box; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:1.3; pointer-events:auto; }
		.gjj-lora-popup-item.with-thumb { display:grid; grid-template-columns:48px minmax(0,1fr); grid-template-rows:auto auto; column-gap:8px; row-gap:3px; align-items:center; min-height:60px; }
		.gjj-lora-popup-item:hover { background:#223039; }
		.gjj-lora-popup-item.selected { background:#18352f; border-color:#2f7d67; color:#e8fff6; }
		.gjj-lora-popup-item.selected:hover { background:#1d433a; }
		.gjj-lora-popup-name { font-size:12px; color:inherit; }
		.gjj-lora-popup-item.with-thumb .gjj-lora-popup-name { grid-column:2; grid-row:1; align-self:end; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-lora-popup-meta { display:flex; align-items:center; gap:6px; min-width:0; color:#aebfc5; font-size:11px; }
		.gjj-lora-popup-item.with-thumb .gjj-lora-popup-meta { grid-column:2; grid-row:2; align-self:start; }
		.gjj-lora-popup-thumb { grid-column:1; grid-row:1 / span 2; width:48px; height:48px; border-radius:6px; border:1px solid #2e4149; background:#10171b; object-fit:cover; align-self:center; justify-self:center; }
		.gjj-lora-popup-title { flex:0 0 auto; color:#eef8f4; font-weight:600; }
		.gjj-lora-popup-trigger { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9fd4c3; }
		.gjj-lora-popup-strength { flex:0 0 auto; color:#d7c587; }
		.gjj-lora-popup-preview { width:24px; height:20px; flex:0 0 24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:12px; line-height:16px; padding:0; text-align:center; }
		.gjj-lora-popup-item .gjj-lora-preview-card { position:static; width:100%; margin-top:4px; box-shadow:none; }
		.gjj-lora-popup-item.with-thumb .gjj-lora-preview-card { grid-column:1 / -1; }
		.gjj-lora-popup-empty { color:#8da2ad; font-size:11px; padding:4px 2px; }
		.gjj-lora-side { display:flex; align-items:center; gap:6px; padding-top:2px; flex:0 0 auto; white-space:nowrap; pointer-events:auto; }
		.gjj-lora-toggle-wrap { display:flex; align-items:center; gap:4px; color:#dce7e2; font-size:11px; white-space:nowrap; flex:0 0 auto; pointer-events:auto; }
		.gjj-lora-strength { width:68px; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; text-align:center; pointer-events:auto; }
	`;
	container.appendChild(style);

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-lora-toolbar";

	const globalSearch = document.createElement("input");
	globalSearch.type = "text";
	globalSearch.className = "gjj-lora-global-search";
	globalSearch.placeholder = "全局过滤 LoRA";
	globalSearch.title = "按关键词过滤当前节点所有 LoRA 下拉选项；支持 & 与，, 或 | 表示或。";
	globalSearch.value = ensureLoraNodeState(node).globalSearch;
	globalSearch.addEventListener("input", () => {
		setLoraGlobalSearch(node, globalSearch.value);
	});
	globalSearch.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Escape") {
			globalSearch.blur();
		}
	});

	toolbar.appendChild(globalSearch);
	container.appendChild(toolbar);

	const rowsContainer = document.createElement("div");
	rowsContainer.className = "gjj-lora-rows";
	container.appendChild(rowsContainer);

	// 根据指南文档：在面板上统一阻止所有关键事件
	const eventNamesToPrevent = [
		"pointerdown",
		"mousedown",
		"click",
		"dblclick",
		"contextmenu",
		"wheel",
		"keydown",
		"keyup"
	];

	for (const eventName of eventNamesToPrevent) {
		container.addEventListener(eventName, (event) => {
			event.stopPropagation();
			// 注意：不要在所有事件上都 preventDefault，否则会影响输入框等正常功能
		}, true);
	}

	// 特别处理 wheel 事件
	container.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	container.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });

	node.__gjjLoraContainer = container;
	node.__gjjLoraRows = rowsContainer;
	node.__gjjLoraGlobalSearchInput = globalSearch;

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		if (typeof originalOnSerialize === "function") {
			originalOnSerialize.apply(this, arguments);
		}
		if (serializedNode) {
			persistLoraRows(this, ensureLoraNodeState(this).rows, serializedNode);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[LORA_GLOBAL_SEARCH_PROPERTY] = String(ensureLoraNodeState(this).globalSearch || "");
		}
	};

	node.__gjjLoraWidget = node.addDOMWidget("LoRA 串联", "HTML", container, { serialize: false });

	refreshLoraOptions(node, false).then(() => {
		renderLoraUi(node);
		applySettingsVisibility(node);
	});
}

function removeInternalInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let i = node.inputs.length - 1; i >= 0; i--) {
		const input = node.inputs[i];
		const name = String(input?.name || "");
		if (name === BATCH_SOURCE_WIDGET) {
			if (input?.link != null) {
				node.disconnectInput?.(i);
			}
			if (typeof node.removeInput === "function") {
				node.removeInput(i);
			} else {
				node.inputs.splice(i, 1);
			}
		}
	}
}

function stabilizeNode(node, forcePreset = false) {
	if (!node) {
		return;
	}
	installModelHelpProvider(node);
	trimUnusedImageInputs(node);
	ensureTrailingImageInput(node);
	renameImageInputs(node);
	hookUnetWidget(node);
	hookModelSourceWidget(node);
	hookKeepModelWidget(node);
	syncSeedControlWidget(node);

	removeInternalInputs(node);

	// 彻底隐藏 batch_source_images widget
	let batchSourceWidget = getWidget(node, BATCH_SOURCE_WIDGET);

	// 如果找不到，尝试用其他方式查找
	if (!batchSourceWidget && Array.isArray(node.widgets)) {
		for (const w of node.widgets) {
			const name = String(w?.name || "").toLowerCase();
			const label = String(w?.label || "").toLowerCase();
			if (name === BATCH_SOURCE_WIDGET.toLowerCase() ||
				name.includes("batch_source") ||
				label.includes("批量图片来源")) {
				batchSourceWidget = w;
				console.log(`[GJJ] 找到并准备隐藏 widget: ${w.name} - ${w.label}`);
				break;
			}
		}
	}

	if (batchSourceWidget) {
		GJJ_Utils.hideWidget(batchSourceWidget);
	}

	// 先创建按钮和 LoRA UI
	if (!node.__gjjExecuteButtonWidget) {
		const buttonsContainer = createButtons(node);
		node.__gjjExecuteButtonWidget = node.addDOMWidget(EXECUTE_BUTTON_NAME, "HTML", buttonsContainer, { serialize: false });
		node.__gjjExecuteButtonWidget.computeSize = (width) => [
			Math.round(Number(width || node.size?.[0] || 260)),
			lazyButtonsHeight(width || node.size?.[0], node),
		];
		node.__gjjExecuteButtonWidget.getHeight = () => lazyButtonsHeight(node.size?.[0], node);
	}

	setupLoraUi(node);

	if (!node.__gjjImagePreviewWidget) {
		const previewContainer = createImagePreview(node);
		node.__gjjImagePreviewWidget = node.addDOMWidget(IMAGE_PREVIEW_NAME, "HTML", previewContainer, { serialize: false });
		configureImagePreviewWidget(node, node.__gjjImagePreviewWidget, previewContainer);
	}

	applyPreset(node, forcePreset);
	syncPanelFromLinkedSources(node);
	applySettingsVisibility(node);
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, forcePreset = false) {
	clearTimeout(node.__gjjLazyImageStudioTimer);
	node.__gjjLazyImageStudioTimer = setTimeout(() => {
		stabilizeNode(node, forcePreset);
	}, 16);
}

globalThis.GJJLazyImageStudioSyncBatchSources = function (sourceNode) {
	if (!sourceNode) {
		return;
	}
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			continue;
		}
		const primary = getInput(node, PRIMARY_IMAGE_INPUT);
		const linkId = primary?.link;
		if (!linkId || !app.graph?.links) {
			continue;
		}
		const link = app.graph.links[linkId];
		if (link?.origin_id === sourceNode.id) {
			syncBatchSourceWidget(node);
		}
	}
};

globalThis.GJJLazyImageStudioSyncImageSources = function (sourceNode) {
	if (!sourceNode) {
		return;
	}
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			continue;
		}
		const primary = getInput(node, PRIMARY_IMAGE_INPUT);
		const linkId = primary?.link;
		if (!linkId || !app.graph?.links) {
			continue;
		}
		const link = app.graph.links[linkId];
		if (link?.origin_id === sourceNode.id) {
			void syncSizeFromPrimaryInput(node);
		}
	}
};

api.addEventListener("gjj_lazy_image_studio_test_preview", (event) => {
	const detail = event?.detail || {};
	const nodeId = String(detail.node || detail.node_id || "");
	if (!nodeId) {
		return;
	}
	const node = app.graph?.getNodeById?.(Number(nodeId)) || app.graph?._nodes?.find((item) => String(item?.id) === nodeId);
	if (!node || !TARGET_NODES.has(node?.comfyClass || node?.type)) {
		return;
	}
	const images = detail.gjj_images || detail.images || detail.ui?.gjj_images || detail.ui?.images;
	if (images) {
		const nextImages = detail.append
			? [...(node.__gjjLazyPreview?.items || []), ...images]
			: images;
		updateImagePreview(node, nextImages);
	}
});

app.registerExtension({
	name: "Comfy.GJJ.LazyImageStudio",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		nodeData.output_preview = false;
		nodeType.prototype.hideOutputImages = true;
		if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}

		const originalAddCustomWidget = nodeType.prototype.addCustomWidget;
		nodeType.prototype.addCustomWidget = function (widget, ...args) {
			if (isNativePreviewWidget(this, widget)) {
				return hideNativeWidget(widget);
			}
			return typeof originalAddCustomWidget === "function"
				? originalAddCustomWidget.call(this, widget, ...args)
				: widget;
		};

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			clearNativePreview(this);

			setTimeout(() => {
				clearNativePreview(this);
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
				stabilizeNode(this, !this.__gjjLazyConfiguredFromWorkflow);
				syncPanelFromLinkedSources(this);
				updateTemplateSourcePanel(this, TEMPLATE_SOURCE_FIELDS);

			}, 0);
			void ensureModelPresetsLoaded().then(() => scheduleStabilize(this, !this.__gjjLazyConfiguredFromWorkflow));
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			this.__gjjLazyConfiguredFromWorkflow = true;
			const storedLoraData = readStoredLoraData(this, serializedNode);
			sanitizeSerializedNodeWidgets(serializedNode, this);
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			repairLiveWidgetValues(this, serializedNode?.widgets_values, serializedNode);
			clearNativePreview(this);
			setTimeout(() => {
				clearNativePreview(this);
				const state = ensureLoraNodeState(this);
				const loraData = looksLikeLoraRowsData(storedLoraData)
					? storedLoraData
					: readStoredLoraData(this, serializedNode);
				state.rows = normalizeRows(loraData);
				state.globalSearch = String(this.properties?.[LORA_GLOBAL_SEARCH_PROPERTY] || serializedNode?.properties?.[LORA_GLOBAL_SEARCH_PROPERTY] || "");
				persistLoraRows(this, state.rows);
				if (this.__gjjLoraContainer) {
					renderLoraUi(this);
				}
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
				applyInputSizeButtonState(this);
				stabilizeNode(this, false);
				syncPanelFromLinkedSources(this);
				updateTemplateSourcePanel(this, TEMPLATE_SOURCE_FIELDS);

			}, 0);
			return result;
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			writeSerializedWidgetValues(this, serializedNode);
			if (serializedNode) {
				persistLoraRows(this, ensureLoraNodeState(this).rows, serializedNode);
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[LORA_GLOBAL_SEARCH_PROPERTY] = String(ensureLoraNodeState(this).globalSearch || "");
			}
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			setTimeout(() => {
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
				stabilizeNode(this, false);
				syncPanelFromLinkedSources(this);
				updateTemplateSourcePanel(this, TEMPLATE_SOURCE_FIELDS);
			}, 0);
			return result;
		};

		nodeType.prototype.onDrawBackground = function (...args) {
			clearNativePreview(this);
			positionOpenFloatingPanels(this);
			const signature = externalPanelSignature(this);
			if (signature !== this.__gjjLazyExternalPanelSignature) {
				this.__gjjLazyExternalPanelSignature = signature;
				syncPanelFromLinkedSources(this);
			}
			return undefined;
		};

		nodeType.prototype.onDrawForeground = function (...args) {
			clearNativePreview(this);
			positionOpenFloatingPanels(this);
			return undefined;
		};

		nodeType.prototype.onExecuted = function (message) {
			let images = null;
			if (message?.gjj_images) {
				images = message.gjj_images;
			} else if (message?.ui?.gjj_images) {
				images = message.ui.gjj_images;
			} else if (message?.images) {
				images = message.images;
			} else if (message?.ui?.images) {
				images = message.ui.images;
			} else if (message?.output?.images) {
				images = message.output.images;
			} else if (message?.results?.images) {
				images = message.results.images;
			} else if (Array.isArray(message?.ui)) {
				for (const uiItem of message.ui) {
					if (uiItem?.gjj_images) {
						images = uiItem.gjj_images;
						break;
					}
					if (uiItem?.images) {
						images = uiItem.images;
						break;
					}
				}
			}
			if (images) {
				updateImagePreview(this, images);
			}
			clearExecutedPreviewPayload(message);
			scheduleNativePreviewClear(this);

			const effectiveParams = Array.isArray(message?.effective_params)
				? message.effective_params[0]
				: (Array.isArray(message?.ui?.effective_params) ? message.ui.effective_params[0] : null);
			applyEffectiveParamsToPanel(this, effectiveParams, true);
			updateTemplateSourcePanel(this, TEMPLATE_SOURCE_FIELDS);
			return undefined;
		};
	},

	setup() {
		installLazySeedPromptPatch();
		if (!globalThis.__gjjLazyImageStudioFloatingResizeInstalled) {
			globalThis.__gjjLazyImageStudioFloatingResizeInstalled = true;
			window.addEventListener("resize", positionAllOpenLazyFloatingPanels);
			window.addEventListener("scroll", positionAllOpenLazyFloatingPanels, true);
			window.addEventListener("pointerdown", closeLazyFloatingPanelsFromOutside, true);
			window.addEventListener("gjj-template-source-picker-opening", (event) => {
				const node = event?.detail?.node;
				if (TARGET_NODES.has(node?.comfyClass || node?.type)) {
					closeLazyFloatingSurfaces(node, "template");
					applySettingsVisibility(node);
				}
			});
		}
		void ensureModelPresetsLoaded().then(() => {
			for (const node of app.graph?._nodes || []) {
				if (!TARGET_NODES.has(node?.comfyClass)) {
					continue;
				}
				stabilizeNode(node, false);
				syncPanelFromLinkedSources(node);
				updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
			}
		});
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { requestPromptTranslation } from "./gjj_common_prompt_translation.js";

const NODE_TYPE = "GJJ_BerniniStudio";
const MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const LORA_CHAIN_CONFIG_INPUT = "lora_chain_config";
const LORA_CHAIN_CONFIG_TYPE = "LORA_CHAIN_CONFIG";
const PANEL_STYLE_ID = "gjj-bernini-studio-panel-style";
const PANEL_WIDGET = "__gjj_bernini_panel";
const PREVIEW_WIDGET = "__gjj_bernini_preview";
const MATERIAL_TIMELINE_WIDGET = "__gjj_bernini_material_timeline";
const LOCAL_IMAGES_WIDGET = "local_image_files";
const TEMP_UPLOAD_API_PATH = "/upload/image";
const SETTINGS_PROPERTY = "gjj_bernini_settings_open";
const ACTIVE_POPUP_PROPERTY = "gjj_bernini_active_popup";
const TRANSLATE_PROPERTY = "gjj_bernini_translate_enabled";
const VALUES_PROPERTY = "gjj_bernini_values";
const LINK_MEMORY_PROPERTY = "gjj_bernini_link_memory";
const MATERIAL_ORDER_PROPERTY = "gjj_bernini_material_order";
const TEMPLATE_SOURCE_PROPERTY = "gjj_generation_template_sources";
const DEFAULT_FLF2V_SEGMENT_PROMPT = "从图1到图2自然过渡，保持画面主体、构图、视角和光影稳定，让画面自然、平滑、连续地过渡到最后一帧。中间运动速度缓慢，变化均匀，无明显跳帧，无闪烁，无物体漂移，无角色变形，无视角突然切换，保持真实连续的视频质感。";
const REMOVE_SUBTITLE_PROMPT = "将视频中字幕、背景、logo删除，其它地方保持原视频的所有特征";
const TOP_INPUTS = [
	["source_media", "🎞️ 源媒体"],
	["reference_media_1", "🖼️ 参考媒体 1"],
	["reference_media_2", "🖼️ 参考媒体 2"],
];
const LEGACY_INPUT_NAMES = new Set([
	"reference_video",
	"reference_image_01",
	"reference_image_02",
	"reference_image_03",
	"reference_image_04",
	"ad_image",
	"region_control",
]);
const SETTINGS_GROUPS = [
	["生成参数", ["mode", "steps", "high_steps", "cfg", "seed", "sampler_name", "scheduler", "denoise"]],
	["提示词补充", ["extra_instruction", "negative_prompt"]],
	["长视频衔接", ["prev_segment_ref_frames", "use_prev_segment_latent"]],
];
const MODEL_SETTINGS_GROUPS = [
	["模型参数", ["high_model", "low_model", "vae_name", "clip_name", "high_lora", "low_lora"]],
	["运行优化", ["use_accel_lora", "enable_sage_attention", "enable_fp16_accumulation", "keep_model"]],
];
const SIZE_SETTINGS_GROUPS = [
	["画面尺寸", ["width", "height", "length", "segment_frames", "batch_size", "ref_max_size", "resize_to_panel"]],
	["画面适配", ["image_resize_mode", "image_resize_align"]],
	["输出参数", ["frame_rate", "filename_prefix", "format_name", "vae_tiling", "tile_x", "tile_y"]],
];
const ALL_SETTINGS_GROUPS = SETTINGS_GROUPS.concat(MODEL_SETTINGS_GROUPS, SIZE_SETTINGS_GROUPS);
const TEMPLATE_SOURCE_FIELDS = [
	{ name: "prompt", label: "提示词", type: "STRING", aliases: ["prompt", "positive", "提示词", "正向"] },
	{ name: "extra_instruction", label: "附加指令", type: "STRING", aliases: ["extra", "instruction", "附加", "指令"] },
	{ name: "negative_prompt", label: "负面提示词", type: "STRING", aliases: ["negative", "负面", "反向"] },
	{ name: "mode", label: "模式", type: "STRING", aliases: ["mode", "模式"] },
	{ name: "width", label: "宽度", type: "INT", aliases: ["width", "宽度", "w"] },
	{ name: "height", label: "高度", type: "INT", aliases: ["height", "高度", "h"] },
	{ name: "length", label: "帧数", type: "INT", aliases: ["length", "frames", "frame", "帧数", "长度"] },
	{ name: "segment_frames", label: "每段帧数", type: "INT", aliases: ["segment", "segment_frames", "每段", "分段"] },
	{ name: "batch_size", label: "批次数", type: "INT", aliases: ["batch", "batch_size", "批次"] },
	{ name: "steps", label: "步数", type: "INT", aliases: ["steps", "步数"] },
	{ name: "high_steps", label: "高噪步数", type: "INT", aliases: ["high_steps", "高噪"] },
	{ name: "cfg", label: "CFG", type: "FLOAT", aliases: ["cfg"] },
	{ name: "seed", label: "种子", type: "INT", aliases: ["seed", "种子"] },
	{ name: "sampler_name", label: "采样器", type: "STRING", aliases: ["sampler", "采样器"] },
	{ name: "scheduler", label: "调度器", type: "STRING", aliases: ["scheduler", "调度器"] },
	{ name: "denoise", label: "降噪", type: "FLOAT", aliases: ["denoise", "降噪"] },
	{ name: "ref_max_size", label: "参考最长边", type: "INT", aliases: ["ref", "max_size", "参考", "最长边"] },
	{ name: "frame_rate", label: "帧率", type: "FLOAT", aliases: ["fps", "frame_rate", "帧率"] },
	{ name: "filename_prefix", label: "文件名前缀", type: "STRING", aliases: ["filename", "prefix", "文件名", "前缀"] },
	{ name: "format_name", label: "输出格式", type: "STRING", aliases: ["format", "格式"] },
	{ name: "vae_tiling", label: "VAE分块", type: "BOOLEAN", aliases: ["tiling", "vae_tiling", "分块"] },
	{ name: "tile_x", label: "分块宽", type: "INT", aliases: ["tile_x", "分块宽"] },
	{ name: "tile_y", label: "分块高", type: "INT", aliases: ["tile_y", "分块高"] },
	{ name: "use_accel_lora", label: "加速LoRA", type: "BOOLEAN", aliases: ["lora", "accel", "加速"] },
	{ name: "enable_sage_attention", label: "SageAttention", type: "BOOLEAN", aliases: ["sage", "attention"] },
	{ name: "enable_fp16_accumulation", label: "FP16累积", type: "BOOLEAN", aliases: ["fp16", "accumulation", "累积"] },
	{ name: "high_model", label: "High模型", type: "STRING", aliases: ["high_model", "high", "高模"] },
	{ name: "low_model", label: "Low模型", type: "STRING", aliases: ["low_model", "low", "低模"] },
	{ name: "vae_name", label: "VAE", type: "STRING", aliases: ["vae"] },
	{ name: "clip_name", label: "CLIP编码器", type: "STRING", aliases: ["clip", "t5"] },
	{ name: "high_lora", label: "High LoRA", type: "STRING", aliases: ["high_lora"] },
	{ name: "low_lora", label: "Low LoRA", type: "STRING", aliases: ["low_lora"] },
	{ name: "prev_segment_ref_frames", label: "上一段尾帧参考", type: "INT", aliases: ["prev_segment", "tail_frames", "上一段", "尾帧", "参考帧"] },
	{ name: "use_prev_segment_latent", label: "上一段Latent", type: "BOOLEAN", aliases: ["prev_latent", "latent", "上一段latent"] },
	{ name: "image_resize_mode", label: "画面适配", type: "STRING", aliases: ["resize_mode", "适配", "拉伸", "补边", "留边", "裁剪"] },
	{ name: "image_resize_align", label: "画面对齐", type: "STRING", aliases: ["resize_align", "对齐", "上", "下", "左", "右", "中"] },
	{ name: "segment_timeline_config", label: "素材时间线", type: "STRING", aliases: ["timeline", "素材时间线", "分段"] },
	{ name: LOCAL_IMAGES_WIDGET, label: "拖入素材", type: "STRING", aliases: ["local_images", "拖入素材"] },
];
const HIDDEN_WIDGETS = new Set(ALL_SETTINGS_GROUPS.flatMap(([, names]) => names).concat(["prompt", "translation_enabled", "randomize_seed", "segment_timeline_config", LOCAL_IMAGES_WIDGET]));
const BACKEND_WIDGETS = [
	"prompt",
	"extra_instruction",
	"negative_prompt",
	"mode",
	"width",
	"height",
	"length",
	"batch_size",
	"steps",
	"high_steps",
	"cfg",
	"seed",
	"sampler_name",
	"scheduler",
	"denoise",
	"ref_max_size",
	"use_accel_lora",
	"enable_sage_attention",
	"enable_fp16_accumulation",
	"frame_rate",
	"filename_prefix",
	"format_name",
	"vae_tiling",
	"tile_x",
	"tile_y",
	"high_model",
	"low_model",
	"vae_name",
	"clip_name",
	"high_lora",
	"low_lora",
	"translation_enabled",
	"segment_frames",
	"keep_model",
	"prev_segment_ref_frames",
	"randomize_seed",
	"resize_to_panel",
	"use_prev_segment_latent",
	"image_resize_mode",
	"image_resize_align",
	"segment_timeline_config",
	LOCAL_IMAGES_WIDGET,
];
const LEGACY_BACKEND_WIDGETS = BACKEND_WIDGETS.slice(0, -4);
const OLDER_BACKEND_WIDGETS = BACKEND_WIDGETS.slice(0, -5);
const DEFAULT_VALUES = {
	prompt: "Remove subtitles and watermarks while preserving the original scene, motion, lighting, and identity.",
	extra_instruction: "",
	negative_prompt: "bad video",
	mode: "auto",
	width: 480,
	height: 480,
	length: 81,
	batch_size: 1,
	steps: 4,
	high_steps: 2,
	cfg: 1,
	seed: 42,
	sampler_name: "euler",
	scheduler: "simple",
	denoise: 1,
	ref_max_size: 848,
	use_accel_lora: true,
	enable_sage_attention: true,
	enable_fp16_accumulation: false,
	frame_rate: 8,
	filename_prefix: "video/Bernini_Studio",
	format_name: "video/h264-mp4",
	vae_tiling: true,
	tile_x: 272,
	tile_y: 272,
	high_model: "wan2.2_bernini_r_high_noise_fp8_scaled.safetensors",
	low_model: "wan2.2_bernini_r_low_noise_fp8_scaled.safetensors",
	vae_name: "wan_2.1_vae.safetensors",
	clip_name: "umt5_xxl_int4_convrot.safetensors",
	high_lora: "Bernini-R_LightX2V_high_noise.safetensors",
	low_lora: "Bernini-R_LightX2V_low_noise.safetensors",
	translation_enabled: false,
	segment_frames: 81,
	keep_model: false,
	prev_segment_ref_frames: 1,
	randomize_seed: false,
	resize_to_panel: true,
	use_prev_segment_latent: false,
	image_resize_mode: "裁剪",
	image_resize_align: "中",
	segment_timeline_config: "[]",
	local_image_files: "[]",
};
const NUMBER_RULES = {
	width: [16, 8192, true],
	height: [16, 8192, true],
	length: [1, 8192, true],
	batch_size: [1, 4096, true],
	steps: [1, 1000, true],
	high_steps: [1, 1000, true],
	cfg: [0, 30, false],
	seed: [0, Number.MAX_SAFE_INTEGER, true],
	denoise: [0, 1, false],
	ref_max_size: [16, 8192, true],
	frame_rate: [1, 240, false],
	tile_x: [40, 2048, true],
	tile_y: [40, 2048, true],
	segment_frames: [5, 225, true],
	prev_segment_ref_frames: [0, 32, true],
};
const BOOLEAN_WIDGETS = new Set([
	"use_accel_lora",
	"enable_sage_attention",
	"enable_fp16_accumulation",
	"vae_tiling",
	"translation_enabled",
	"keep_model",
	"randomize_seed",
	"resize_to_panel",
	"use_prev_segment_latent",
]);
const FIXED_CHOICES = {
	mode: new Set(["auto", "T2I", "T2V", "I2I", "R2I", "I2V", "V2V", "R2V", "VI2V", "RV2V", "ADS2V", "VRC2V", "MV2V", "FLF2V"]),
	image_resize_mode: new Set(["拉伸", "补边", "留边", "裁剪"]),
	image_resize_align: new Set(["上", "下", "左", "右", "中"]),
};
const MODEL_WIDGETS = new Set(["high_model", "low_model", "vae_name", "clip_name", "high_lora", "low_lora"]);
const MISSING_MODEL_PREFIX = "未找到匹配模型：";
const BUTTON_CHOICE_GROUPS = {
	image_resize_mode: [
		["拉伸", "拉伸"],
		["补边", "补边"],
		["留边", "留边"],
		["裁剪", "裁剪"],
	],
	image_resize_align: [
		["上", "上"],
		["下", "下"],
		["左", "左"],
		["右", "右"],
		["中", "中"],
	],
};
const MODE_BUTTON_LABELS = {
	T2I: "T2I",
	T2V: "T2V",
	I2I: "I2I",
	I2V: "I2V",
	R2I: "R2I",
	R2V: "R2V",
	VI2V: "VI2V",
	V2V: "V2V",
	RV2V: "RV2V",
	ADS2V: "ADS2V",
	VRC2V: "VRC2V",
	MV2V: "MV2V",
	FLF2V: "FLF2V",
};
const MODE_DEFAULT_VALUES = {
	T2I: { steps: 20, high_steps: 10 },
};
let templateSourceModulePromise = null;

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function value(node, name, fallback = "") {
	return widget(node, name)?.value ?? node?.properties?.[name] ?? fallback;
}

function normalizedModelName(name) {
	return String(name || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
}

function lowModelCandidatesFromHigh(highModel) {
	const text = String(highModel || "");
	const replacements = [
		[/high_noise/gi, "low_noise"],
		[/high-noise/gi, "low-noise"],
		[/high noise/gi, "low noise"],
		[/_high_/gi, "_low_"],
		[/-high-/gi, "-low-"],
		[/ high /gi, " low "],
		[/\bhigh\b/gi, "low"],
	];
	const candidates = [];
	for (const [pattern, replacement] of replacements) {
		const next = text.replace(pattern, replacement);
		if (next !== text) candidates.push(next);
	}
	return candidates;
}

function scoreLowModelPair(highModel, lowChoice) {
	const high = normalizedModelName(highModel);
	const low = normalizedModelName(lowChoice);
	if (!high || !low) return 0;
	let score = 0;
	for (const candidate of lowModelCandidatesFromHigh(high)) {
		if (normalizedModelName(candidate) === low) score += 1000;
	}
	for (const token of ["bernini", "14b", "fp8", "q4", "q5", "q6", "q8", "gguf", "safetensors", "scaled"]) {
		if (high.includes(token) && low.includes(token)) score += 10;
	}
	const highNoise = high.replace(/high[_\-\s]?noise/g, "").replace(/\bhigh\b/g, "");
	const lowNoise = low.replace(/low[_\-\s]?noise/g, "").replace(/\blow\b/g, "");
	if (highNoise && lowNoise && highNoise === lowNoise) score += 250;
	const highParts = new Set(high.split(/[^a-z0-9]+/).filter((part) => part.length > 1 && part !== "high" && part !== "noise"));
	for (const part of low.split(/[^a-z0-9]+/)) {
		if (part.length > 1 && part !== "low" && part !== "noise" && highParts.has(part)) score += 2;
	}
	return score;
}

function pairedLowModelForHigh(node, highModel) {
	const lowWidget = widget(node, "low_model");
	const choices = widgetChoices(lowWidget);
	if (!choices.length) return "";
	const exactCandidates = lowModelCandidatesFromHigh(highModel).map(normalizedModelName);
	for (const choice of choices) {
		if (exactCandidates.includes(normalizedModelName(choice))) return choice;
	}
	let best = "";
	let bestScore = 0;
	for (const choice of choices) {
		const score = scoreLowModelPair(highModel, choice);
		if (score > bestScore) {
			best = choice;
			bestScore = score;
		}
	}
	return bestScore >= 30 ? best : "";
}

function syncLowModelFromHigh(node, highModel) {
	if (node.__gjjBerniniPairingLowModel) return;
	const paired = pairedLowModelForHigh(node, highModel);
	if (!paired || paired === value(node, "low_model", "")) return;
	node.__gjjBerniniPairingLowModel = true;
	try {
		setValue(node, "low_model", paired);
	} finally {
		node.__gjjBerniniPairingLowModel = false;
	}
}

function setValue(node, name, nextValue) {
	node.properties ||= {};
	node.properties[name] = nextValue;
	const target = widget(node, name);
	if (!target) return;
	target.value = nextValue;
	if (target.inputEl && "value" in target.inputEl) target.inputEl.value = nextValue;
	if (target.element && "value" in target.element) target.element.value = nextValue;
	target.callback?.(nextValue, app.canvas, node, undefined, target);
	const panelControl = node.__gjjBerniniPanel?.controls?.get?.(name);
	if (panelControl) {
		if (panelControl.dataset?.resizeModeControl === "true") {
			setResizeModeControlState(panelControl, Boolean(nextValue));
		} else if (panelControl.dataset?.choiceButtonControl === "true") {
			setChoiceButtonControlState(panelControl, String(nextValue ?? ""));
		} else if (panelControl.dataset?.booleanControl === "true") {
			setBooleanButtonState(panelControl, Boolean(nextValue));
		} else if (document.activeElement !== panelControl) {
			if (panelControl.type === "checkbox") panelControl.checked = Boolean(nextValue);
			else panelControl.value = String(nextValue ?? "");
		}
	}
	node.graph?.change?.();
	GJJ_Utils.dirtyCanvas(node);
	if (name === "mode" || name === "length") {
		updateGenerateButton(node);
		updateModeButtons(node);
		refreshMaterialTimeline(node, true);
	}
	if (name === "mode" || name === "use_accel_lora" || name === "steps" || name === "high_steps") {
		applyModeDefaults(node, value(node, "mode", "auto"));
	}
	if (name === "mode" && String(nextValue || "").toUpperCase() === "FLF2V") {
		if (Number(value(node, "length", DEFAULT_VALUES.length)) !== 81) setValue(node, "length", 81);
		if (Number(value(node, "segment_frames", DEFAULT_VALUES.segment_frames)) !== 81) setValue(node, "segment_frames", 81);
	}
	if (name === "high_model") syncLowModelFromHigh(node, nextValue);
	if (name === "keep_model") updateKeepModelButton(node);
	if (name === "randomize_seed") updateRandomizeSeedButton(node);
	if (name === "resize_to_panel") {
		updateResizeButton(node);
		syncPanel(node);
	}
}

function applyModeDefaults(node, mode) {
	const modeName = String(mode || "").toUpperCase();
	const useAccel = Boolean(value(node, "use_accel_lora", DEFAULT_VALUES.use_accel_lora));
	const setNumberIfNeeded = (name, nextValue) => {
		if (Number(value(node, name, DEFAULT_VALUES[name])) !== nextValue) setValue(node, name, nextValue);
	};
	if (useAccel && modeName && modeName !== "AUTO" && modeName !== "T2I") {
		setNumberIfNeeded("steps", 4);
		setNumberIfNeeded("high_steps", 2);
		return;
	}
}

function selectedTemplateSources(node) {
	const raw = node?.properties?.[TEMPLATE_SOURCE_PROPERTY];
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
	if (typeof raw === "string" && raw.trim()) {
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch (_) {}
	}
	return {};
}

function hasSelectedTemplateSources(node) {
	return Object.values(selectedTemplateSources(node)).some((item) => String(item || "").trim());
}

function loadTemplateSourceModule() {
	if (!templateSourceModulePromise) {
		templateSourceModulePromise = import("./gjj_generation_template_sources.js").catch((error) => {
			templateSourceModulePromise = null;
			console.error("[GJJ BerniniStudio] 模板变量模块按需加载失败", error);
			throw error;
		});
	}
	return templateSourceModulePromise;
}

function updateTemplateSourcePanelLazy(node, fields = TEMPLATE_SOURCE_FIELDS, force = false) {
	if (!node) return;
	node.__gjjTemplateSourceFields = fields;
	if (!force && !hasSelectedTemplateSources(node) && !node.__gjjTemplateSourceLoaded) return;
	loadTemplateSourceModule().then((module) => {
		node.__gjjTemplateSourceLoaded = true;
		module.updateTemplateSourcePanel?.(node, fields);
	}).catch(() => {});
}

async function openTemplateSourcePickerLazy(node, button) {
	const module = await loadTemplateSourceModule();
	node.__gjjTemplateSourceLoaded = true;
	setActivePopup(node, "");
	module.openTemplateSourcePicker?.(node, TEMPLATE_SOURCE_FIELDS, button);
	module.updateTemplateSourcePanel?.(node, TEMPLATE_SOURCE_FIELDS);
}

function normalizeValue(name, input) {
	const fallback = DEFAULT_VALUES[name];
	if (BOOLEAN_WIDGETS.has(name)) {
		if (typeof input === "boolean") return input;
		const text = String(input ?? "").toLowerCase();
		if (["true", "1", "yes", "on"].includes(text)) return true;
		if (["false", "0", "no", "off"].includes(text)) return false;
		return Boolean(fallback);
	}
	const rule = NUMBER_RULES[name];
	if (rule) {
		const parsed = Number(input);
		if (!Number.isFinite(parsed)) return fallback;
		const [minimum, maximum, integer] = rule;
		const clamped = Math.max(minimum, Math.min(maximum, parsed));
		return integer ? Math.round(clamped) : clamped;
	}
	const text = String(input ?? "");
	if (MODEL_WIDGETS.has(name)) {
		if (!text.trim() || text.trim().startsWith(MISSING_MODEL_PREFIX)) return String(fallback ?? "");
	}
	if (name === "format_name" && ["true", "false", "1", "0", "null", "none", ""].includes(text.trim().toLowerCase())) {
		return String(fallback ?? "");
	}
	if (FIXED_CHOICES[name] && !FIXED_CHOICES[name].has(text)) {
		return String(fallback ?? "");
	}
	if ((name === "sampler_name" || name === "scheduler") && (!text.trim() || Number.isFinite(Number(text)))) {
		return String(fallback ?? "");
	}
	return input === undefined || input === null ? String(fallback ?? "") : text;
}

function collectValues(node) {
	const values = {};
	for (const name of BACKEND_WIDGETS) {
		values[name] = legalWidgetValue(node, name, widget(node, name)?.value);
	}
	return values;
}

function applyValues(node, values) {
	if (!values || typeof values !== "object") return;
	node.__gjjBerniniRestoring = true;
	try {
		for (const name of BACKEND_WIDGETS) {
			const target = widget(node, name);
			if (!target) continue;
			const nextValue = legalWidgetValue(node, name, values[name]);
			target.value = nextValue;
			if (target.inputEl && "value" in target.inputEl) target.inputEl.value = nextValue;
			if (target.element && "value" in target.element) target.element.value = nextValue;
		}
	} finally {
		node.__gjjBerniniRestoring = false;
	}
}

function valuesFromSerialized(serializedNode) {
	const saved = serializedNode?.properties?.[VALUES_PROPERTY];
	if (saved && typeof saved === "object") return saved;
	const raw = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	if (!raw.length) return null;
	const order = raw.length >= BACKEND_WIDGETS.length
		? BACKEND_WIDGETS
		: raw.length >= LEGACY_BACKEND_WIDGETS.length
			? LEGACY_BACKEND_WIDGETS
			: OLDER_BACKEND_WIDGETS;
	const values = {};
	for (let index = 0; index < Math.min(order.length, raw.length); index += 1) {
		values[order[index]] = raw[index];
	}
	return values;
}

function writeSerializedValues(node, serializedNode = null) {
	if (!node || node.__gjjBerniniRestoring) return;
	applyModeDefaults(node, value(node, "mode", "auto"));
	const values = collectValues(node);
	node.properties ||= {};
	node.properties[VALUES_PROPERTY] = { ...values };
	if (Array.isArray(node.widgets)) {
		node.widgets_values = node.widgets
			.filter((target) => target?.serialize !== false && target?.options?.serialize !== false)
			.map((target) => typeof target.serializeValue === "function" ? target.serializeValue(node, target) : target.value);
	}
	if (serializedNode) {
		serializedNode.properties ||= {};
		serializedNode.properties[VALUES_PROPERTY] = { ...values };
		if (Array.isArray(node.widgets_values)) serializedNode.widgets_values = [...node.widgets_values];
	}
}

function protect(element) {
	if (!element || element.__gjjBerniniProtected) return;
	element.__gjjBerniniProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, (event) => {
			if (element.classList?.contains("gjj-bs-popover") && event.target !== element) return;
			if (event.target?.closest?.(".gjj-bs-material-line,.gjj-bs-material-frame-label,.gjj-bs-material-prompt-badge,.gjj-bs-material-editor")) return;
			event.stopPropagation();
		}, true);
	}
}

function bindButton(button, handler) {
	let lastAt = 0;
	const run = (event) => {
		event.preventDefault();
		event.stopPropagation();
		const now = Date.now();
		if (now - lastAt < 220) return;
		lastAt = now;
		void handler(event);
	};
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu"]) {
		button.addEventListener(eventName, (event) => {
			event.preventDefault();
			event.stopPropagation();
		}, true);
	}
	button.addEventListener("pointerup", run, true);
	button.addEventListener("click", run, true);
}

function makeButton(label, title, className, handler) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `gjj-bs-button ${className}`;
	button.innerHTML = label;
	button.title = title;
	protect(button);
	bindButton(button, handler);
	return button;
}

function activePopup(node) {
	const explicit = String(node?.properties?.[ACTIVE_POPUP_PROPERTY] || "");
	if (explicit) return explicit;
	return node?.properties?.[SETTINGS_PROPERTY] ? "settings" : "";
}

function closePanelPopups(node) {
	if (!node || String(node.comfyClass || node.type || "") !== NODE_TYPE) return;
	node.properties ||= {};
	node.properties[ACTIVE_POPUP_PROPERTY] = "";
	node.properties[SETTINGS_PROPERTY] = false;
	const state = node.__gjjBerniniPanel;
	state?.settings?.classList.remove("open");
	state?.modelSettings?.classList.remove("open");
	state?.sizeSettings?.classList.remove("open");
	state?.settingsButton?.classList.remove("active");
	state?.keepModel?.classList.remove("popup-open");
	state?.resize?.classList.remove("popup-open");
}

function closeOtherPanelPopups(node) {
	for (const item of app.graph?._nodes || []) {
		if (!item || item === node || String(item.comfyClass || item.type || "") !== NODE_TYPE) continue;
		closePanelPopups(item);
	}
}

function setActivePopup(node, name = "") {
	node.properties ||= {};
	if (name) {
		window.dispatchEvent(new CustomEvent("gjj-close-template-source-picker"));
		closeOtherPanelPopups(node);
	}
	node.properties[ACTIVE_POPUP_PROPERTY] = name;
	node.properties[SETTINGS_PROPERTY] = name === "settings";
	syncPanel(node);
}

function togglePopup(node, name) {
	setActivePopup(node, activePopup(node) === name ? "" : name);
}

function linkTypeForInput(node, name) {
	const input = node?.inputs?.find?.((item) => String(item?.name || "") === name);
	const linkId = Array.isArray(input?.link) ? input.link[0] : input?.link;
	if (linkId == null) return "";
	const link = linkId != null ? app.graph?.links?.[linkId] : null;
	const origin = link ? app.graph?.getNodeById?.(link.origin_id) : null;
	const output = origin?.outputs?.[link?.origin_slot];
	const type = String(output?.type || "").toUpperCase();
	const label = [
		output?.name,
		output?.label,
		output?.localized_name,
		origin?.title,
		origin?.comfyClass,
		origin?.type,
	].filter(Boolean).join(" ").toUpperCase();
	if (type.includes("VIDEO") && (type.includes("IMAGE") || type.includes("GJJ_BATCH_IMAGE"))) {
		if (/首帧|尾帧|图片|图像|IMAGE|PICTURE|PHOTO/.test(label) && !/视频帧|帧队列|VIDEO\s*FRAME|FRAME\s*QUEUE/.test(label)) {
			return "IMAGE";
		}
		if (/视频|帧队列|VIDEO|FRAME/.test(label)) return "VIDEO";
	}
	return type;
}

function mediaInputIndex(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.findIndex((item) => String(item?.name || "") === name) : -1;
}

function mediaInputLink(node, name) {
	const index = mediaInputIndex(node, name);
	const input = index >= 0 ? node.inputs[index] : null;
	const linkId = Array.isArray(input?.link) ? input.link[0] : input?.link;
	const link = linkId != null ? app.graph?.links?.[linkId] : null;
	return { index, input, linkId, link };
}

function linkMemory(node) {
	node.properties ||= {};
	const memory = node.properties[LINK_MEMORY_PROPERTY];
	if (memory && typeof memory === "object" && !Array.isArray(memory)) return memory;
	node.properties[LINK_MEMORY_PROPERTY] = {};
	return node.properties[LINK_MEMORY_PROPERTY];
}

function rememberedLinks(node) {
	const memory = linkMemory(node);
	return TOP_INPUTS
		.map(([name]) => ({ name, record: memory[name] }))
		.filter((item) => item.record && typeof item.record === "object");
}

function hasActiveMediaLinks(node) {
	return TOP_INPUTS.some(([name]) => mediaInputLink(node, name).link);
}

function hasRememberedMediaLinks(node) {
	return rememberedLinks(node).length > 0;
}

function disconnectRememberedMediaLinks(node) {
	const memory = linkMemory(node);
	let changed = false;
	for (const [name] of TOP_INPUTS) {
		const { index, link } = mediaInputLink(node, name);
		if (index < 0 || !link) continue;
		memory[name] = {
			origin_id: link.origin_id,
			origin_slot: link.origin_slot,
			type: link.type || node.inputs?.[index]?.type || MEDIA_TYPE,
		};
		try { node.disconnectInput?.(index); } catch (_) {}
		changed = true;
	}
	return changed;
}

function reconnectRememberedMediaLinks(node) {
	const memory = linkMemory(node);
	let changed = false;
	for (const [name] of TOP_INPUTS) {
		const record = memory[name];
		if (!record || typeof record !== "object") continue;
		const source = app.graph?.getNodeById?.(record.origin_id);
		const sourceSlot = Number(record.origin_slot);
		const targetSlot = mediaInputIndex(node, name);
		if (!source || !source.outputs?.[sourceSlot] || targetSlot < 0) {
			delete memory[name];
			changed = true;
			continue;
		}
		try {
			if (node.inputs?.[targetSlot]?.link != null) node.disconnectInput?.(targetSlot);
			source.connect(sourceSlot, node, targetSlot);
			changed = true;
		} catch (error) {
			console.warn("[GJJ BerniniStudio] reconnect media input failed", error);
		}
	}
	return changed;
}

function toggleMediaLinks(node) {
	normalizeInputs(node);
	const changed = hasActiveMediaLinks(node)
		? disconnectRememberedMediaLinks(node)
		: reconnectRememberedMediaLinks(node);
	if (!changed) return;
	node.graph?.change?.();
	GJJ_Utils.dirtyCanvas(node);
	syncPanel(node);
	fitNode(node);
}

function linkedInputKind(node, name) {
	const type = linkTypeForInput(node, name);
	if (type.includes("VIDEO")) return "video";
	if (type.includes("IMAGE") || type.includes("GJJ_BATCH_IMAGE")) return "image";
	return "";
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (_) {
		return [];
	}
}

function uploadUrl(path) {
	return api?.apiURL ? api.apiURL(path) : path;
}

function normalizeUploadItem(data, file, subfolder = "GJJ_BerniniStudio") {
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
	return normalizeUploadItem(item, file, "GJJ_BerniniStudio");
}

function imageFilesFromDataTransfer(dataTransfer) {
	return Array.from(dataTransfer?.files || []).filter((file) => String(file?.type || "").startsWith("image/"));
}

function isExternalFileDrag(dataTransfer) {
	return Array.from(dataTransfer?.types || []).includes("Files");
}

function sourceSelectedImagesFromInput(node, inputName) {
	const link = mediaInputLink(node, inputName).link;
	const source = link ? app.graph?.getNodeById?.(link.origin_id) : null;
	if (!source) return [];
	const state = source.__gjjMultiImageState || source.__gjjMultiImageLoaderState || {};
	const candidates = [
		state.selection,
		state.executedImages,
		parseSelection(widget(source, "selected_images")?.value || source.properties?.selected_images || "[]"),
	];
	for (const items of candidates) {
		if (!Array.isArray(items) || !items.length) continue;
		const originSlot = Number(link?.origin_slot);
		const output = Number.isInteger(originSlot) ? source.outputs?.[originSlot] : null;
		const outputName = String(output?.name || output?.label || "").trim();
		const individualMatch = outputName.match(/(?:图片|导出图片|image)\s*0*(\d+)/i);
		if (individualMatch) {
			const index = Math.max(0, Number.parseInt(individualMatch[1], 10) - 1);
			return items[index] ? [items[index]] : [];
		}
		if (Number.isInteger(originSlot) && originSlot > 0 && String(output?.type || "").toUpperCase() === "IMAGE") {
			const index = originSlot - 1;
			return items[index] ? [items[index]] : [];
		}
		return items;
	}
	return [];
}

function localSelectedImages(node) {
	return parseSelection(value(node, LOCAL_IMAGES_WIDGET, "[]") || node?.properties?.[LOCAL_IMAGES_WIDGET] || "[]")
		.map((item) => normalizeUploadItem(item, null, item?.subfolder || ""))
		.filter(Boolean);
}

function setLocalSelectedImages(node, items) {
	const clean = (Array.isArray(items) ? items : []).map((item) => normalizeUploadItem(item, null, item?.subfolder || "")).filter(Boolean);
	const text = JSON.stringify(clean);
	setValue(node, LOCAL_IMAGES_WIDGET, text);
	node.properties ||= {};
	node.properties[LOCAL_IMAGES_WIDGET] = text;
}

function rawMaterialTimelineItems(node) {
	const items = [];
	for (const [name] of TOP_INPUTS) {
		for (const item of sourceSelectedImagesFromInput(node, name)) {
			if (!item) continue;
			items.push({ ...item, __sourceInput: name, __sourceIndex: items.length });
		}
	}
	for (const item of localSelectedImages(node)) {
		items.push({ ...item, __sourceInput: "local", __sourceIndex: items.length });
	}
	return items;
}

function materialOrder(node, count) {
	const raw = Array.isArray(node?.properties?.[MATERIAL_ORDER_PROPERTY]) ? node.properties[MATERIAL_ORDER_PROPERTY] : [];
	const used = new Set();
	const order = [];
	for (const value of raw) {
		const index = Number(value);
		if (Number.isInteger(index) && index >= 0 && index < count && !used.has(index)) {
			order.push(index);
			used.add(index);
		}
	}
	for (let index = 0; index < count; index += 1) {
		if (!used.has(index)) order.push(index);
	}
	return order;
}

function materialTimelineItems(node) {
	const raw = rawMaterialTimelineItems(node);
	const order = materialOrder(node, raw.length);
	return order.map((index) => ({ ...raw[index], __sourceIndex: index })).filter(Boolean);
}

function normalizeSegmentTimelineConfig(value) {
	const parsed = parseSelection(value);
	if (!Array.isArray(parsed)) return [];
	return parsed.map((item) => {
		const hasPrompt = item && Object.prototype.hasOwnProperty.call(item, "prompt");
		return {
			frames: Math.max(5, Math.min(8192, Number.parseInt(item?.frames ?? item?.length ?? DEFAULT_VALUES.length, 10) || DEFAULT_VALUES.length)),
			prompt: hasPrompt ? String(item.prompt || "") : DEFAULT_FLF2V_SEGMENT_PROMPT,
			start_index: Number.isInteger(Number(item?.start_index)) ? Number(item.start_index) : undefined,
			end_index: Number.isInteger(Number(item?.end_index)) ? Number(item.end_index) : undefined,
		};
	});
}

function segmentTimelineConfig(node) {
	return normalizeSegmentTimelineConfig(value(node, "segment_timeline_config", "[]"));
}

function setSegmentTimelineConfig(node, config) {
	const clean = Array.isArray(config) ? config : [];
	setValue(node, "segment_timeline_config", JSON.stringify(clean));
}

function syncMaterialTimelineConfig(node, force = false) {
	const items = materialTimelineItems(node);
	const segmentCount = Math.max(0, items.length - 1);
	const current = segmentTimelineConfig(node);
	const defaultFrames = Math.max(5, Number.parseInt(value(node, "length", DEFAULT_VALUES.length), 10) || DEFAULT_VALUES.length);
	const next = [];
	let changed = force || current.length !== segmentCount;
	for (let index = 0; index < segmentCount; index += 1) {
		const item = current[index] || {};
		const frames = Math.max(5, Number.parseInt(item.frames ?? defaultFrames, 10) || defaultFrames);
		const startIndex = Number(items[index]?.__sourceIndex ?? index);
		const endIndex = Number(items[index + 1]?.__sourceIndex ?? (index + 1));
		const prompt = current[index] ? String(item.prompt || "") : DEFAULT_FLF2V_SEGMENT_PROMPT;
		const clean = {
			frames,
			prompt,
			start_index: startIndex,
			end_index: endIndex,
		};
		if (item.start_index !== startIndex || item.end_index !== endIndex || item.frames !== frames || item.prompt !== prompt) changed = true;
		next.push(clean);
	}
	if (changed) setSegmentTimelineConfig(node, next);
	return next;
}

function reorderMaterialTimeline(node, fromIndex, toIndex) {
	const items = materialTimelineItems(node);
	if (!items.length) return;
	const from = Number(fromIndex);
	const to = Number(toIndex);
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return;
	const next = items.map((item) => item.__sourceIndex);
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	node.properties ||= {};
	node.properties[MATERIAL_ORDER_PROPERTY] = next;
	syncMaterialTimelineConfig(node, true);
	refreshMaterialTimeline(node, true);
	node.graph?.change?.();
	GJJ_Utils.dirtyCanvas(node);
}

async function appendDroppedImageFiles(node, files, insertIndex = null) {
	const imageFiles = imageFilesFromDataTransfer({ files });
	if (!imageFiles.length) return;
	try {
		const uploaded = [];
		for (const file of imageFiles) {
			const item = await uploadImageFile(file);
			if (item) uploaded.push(item);
		}
		if (!uploaded.length) return;
		const rawBefore = rawMaterialTimelineItems(node);
		const oldOrder = materialOrder(node, rawBefore.length);
		const uploadedRawIndexes = uploaded.map((_item, index) => rawBefore.length + index);
		const at = Number.isInteger(insertIndex) ? Math.max(0, Math.min(oldOrder.length, insertIndex)) : oldOrder.length;
		const nextOrder = Array.from(oldOrder);
		nextOrder.splice(at, 0, ...uploadedRawIndexes);
		setLocalSelectedImages(node, localSelectedImages(node).concat(uploaded));
		node.properties ||= {};
		node.properties[MATERIAL_ORDER_PROPERTY] = nextOrder;
		syncMaterialTimelineConfig(node, true);
		refreshMaterialTimeline(node, true);
		node.graph?.change?.();
		GJJ_Utils.dirtyCanvas(node);
	} catch (error) {
		console.warn("[GJJ BerniniStudio] 拖入图片失败", error);
	}
}

function materialLabel(item, index) {
	const name = String(item?.filename || item?.name || item?.file || `图片 ${index + 1}`).replaceAll("\\", "/").split("/").pop();
	return name || `图片 ${index + 1}`;
}

function shouldShowMaterialTimeline(node) {
	return String(value(node, "mode", "auto") || "").toUpperCase() === "FLF2V" && mediaInputState(node).canFLF2V;
}

function sourceSizeComesFromInput(node) {
	const sourceInput = node?.inputs?.find?.((item) => String(item?.name || "") === "source_media");
	return inputLinked(sourceInput) && !Boolean(value(node, "resize_to_panel", DEFAULT_VALUES.resize_to_panel));
}

function mediaInputState(node) {
	const sourceKind = linkedInputKind(node, "source_media");
	const refKinds = [
		linkedInputKind(node, "reference_media_1"),
		linkedInputKind(node, "reference_media_2"),
	].filter(Boolean);
	const sourceImageCount = sourceKind === "image" ? Math.max(1, sourceSelectedImagesFromInput(node, "source_media").length || 1) : 0;
	const referenceImageCount = ["reference_media_1", "reference_media_2"].reduce((count, name) => {
		if (linkedInputKind(node, name) !== "image") return count;
		return count + Math.max(1, sourceSelectedImagesFromInput(node, name).length || 1);
	}, 0);
	const flfImageCount = sourceImageCount + referenceImageCount + localSelectedImages(node).length;
	return {
		sourceKind,
		refKinds,
		hasSource: Boolean(sourceKind),
		hasImageRefs: refKinds.includes("image"),
		hasVideoRefs: refKinds.includes("video"),
		hasRefs: refKinds.length > 0,
		flfImageCount,
		canFLF2V: flfImageCount >= 2,
	};
}

function modeButtonsForInputs(node) {
	const state = mediaInputState(node);
	if (!state.hasSource && !state.hasRefs) return ["T2I", "T2V"];
	if (!state.hasSource) return state.hasImageRefs ? ["R2I", "R2V", ...(state.canFLF2V ? ["FLF2V"] : [])] : ["R2V"];
	if (state.sourceKind === "image") {
		if (state.hasRefs) return ["R2I", "R2V", ...(state.canFLF2V ? ["FLF2V"] : [])];
		return ["I2I", "I2V", ...(state.canFLF2V ? ["FLF2V"] : [])];
	}
	if (state.sourceKind === "video") {
		if (!state.hasRefs) return ["V2V"];
		return ["VI2V", "RV2V", "ADS2V", "VRC2V", "MV2V"];
	}
	return ["T2I", "T2V"];
}

function updateModeButtons(node) {
	const row = node?.__gjjBerniniPanel?.modeButtons;
	if (!row) return;
	const current = String(value(node, "mode", "auto") || "auto").toUpperCase();
	const modes = modeButtonsForInputs(node);
	if (modes.length && !modes.includes(current)) {
		if (!node.__gjjBerniniModeDefaulting) {
			node.__gjjBerniniModeDefaulting = true;
			try {
				setValue(node, "mode", modes[0]);
				applyModeDefaults(node, modes[0]);
			} finally {
				node.__gjjBerniniModeDefaulting = false;
			}
		}
		return;
	}
	row.replaceChildren();
	for (const mode of modes) {
		const button = makeButton(MODE_BUTTON_LABELS[mode] || mode, `切换为 ${mode} 生成方式`, "gjj-bs-mode-button", () => {
			setValue(node, "mode", mode);
			applyModeDefaults(node, mode);
			updateModeButtons(node);
		});
		button.classList.toggle("active", current === mode);
		row.appendChild(button);
	}
}

function updateRemoveSubtitleButton(node) {
	const button = node?.__gjjBerniniPanel?.removeSubtitle;
	if (!button) return;
	const isV2V = String(value(node, "mode", "auto") || "").toUpperCase() === "V2V";
	button.style.display = isV2V ? "" : "none";
}

function resolvePanelOutputKind(node) {
	const mode = String(value(node, "mode", "auto") || "auto").toUpperCase();
	if (["T2I", "I2I", "R2I"].includes(mode)) return "image";
	if (mode !== "AUTO" && FIXED_CHOICES.mode.has(mode)) return "video";
	const sourceKind = linkedInputKind(node, "source_media");
	const ref1Kind = linkedInputKind(node, "reference_media_1");
	const ref2Kind = linkedInputKind(node, "reference_media_2");
	const hasVideo = [sourceKind, ref1Kind, ref2Kind].includes("video");
	const frameCount = Number(value(node, "length", DEFAULT_VALUES.length));
	if (!hasVideo && Number.isFinite(frameCount) && frameCount <= 1) return "image";
	return "video";
}

function updateGenerateButton(node) {
	const button = node?.__gjjBerniniPanel?.generate;
	if (!button || button.disabled) return;
	const kind = resolvePanelOutputKind(node);
	button.innerHTML = kind === "image" ? "✨ 生成图片" : "🎬 生成视频";
	button.title = kind === "image" ? "只执行当前 Bernini 节点并生成图片" : "只执行当前 Bernini 节点并生成视频";
}

function updateKeepModelButton(node) {
	const button = node?.__gjjBerniniPanel?.keepModel;
	if (!button) return;
	const enabled = Boolean(value(node, "keep_model", DEFAULT_VALUES.keep_model));
	button.textContent = "🧠";
	button.title = enabled ? "模型参数；保持模型已开启，复用已加载模型" : "模型参数；保持模型已关闭，每次重新加载模型";
	button.classList.toggle("active", enabled);
}

function updateRandomizeSeedButton(node) {
	const button = node?.__gjjBerniniPanel?.seed;
	if (!button) return;
	const enabled = Boolean(value(node, "randomize_seed", DEFAULT_VALUES.randomize_seed));
	button.textContent = "🎲";
	button.title = enabled ? "随机种子：开启，每次执行自动更新种子" : "随机种子：关闭，保持当前种子并允许复用缓存";
	button.classList.toggle("active", enabled);
}

function updateResizeButton(node) {
	const button = node?.__gjjBerniniPanel?.resize;
	if (!button) return;
	const enabled = Boolean(value(node, "resize_to_panel", DEFAULT_VALUES.resize_to_panel));
	button.textContent = "📐";
	button.title = enabled ? "尺寸参数；按面板尺寸已开启，按宽高缩放裁剪" : "尺寸参数；按面板尺寸已关闭，优先沿用源媒体尺寸";
	button.classList.toggle("active", enabled);
}

function createMaterialTimeline(node) {
	if (node.__gjjBerniniMaterialTimeline) return node.__gjjBerniniMaterialTimeline;
	const root = document.createElement("div");
	root.className = "gjj-bs-material-timeline";
	root.style.display = "none";
	protect(root);
	const header = document.createElement("div");
	header.className = "gjj-bs-material-head";
	const title = document.createElement("span");
	title.textContent = "素材时间线";
	const hint = document.createElement("span");
	hint.className = "gjj-bs-material-hint";
	header.append(title, hint);
	const strip = document.createElement("div");
	strip.className = "gjj-bs-material-strip";
	strip.addEventListener("dragover", (event) => {
		const types = Array.from(event.dataTransfer?.types || []);
		if (isExternalFileDrag(event.dataTransfer) || types.includes("application/x-gjj-bernini-material-index")) {
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
	root.append(header, strip);
	const state = { root, hint, strip, signature: "" };
	node.__gjjBerniniMaterialTimeline = state;
	return state;
}

function closeMaterialPromptEditor(node) {
	const editor = node?.__gjjBerniniMaterialPromptEditor;
	if (editor?.parentNode) editor.parentNode.removeChild(editor);
	if (node) node.__gjjBerniniMaterialPromptEditor = null;
}

function showSegmentPromptEditor(node, segmentIndex, anchor, writePrompt) {
	closeMaterialPromptEditor(node);
	const editor = document.createElement("div");
	editor.className = "gjj-bs-material-editor";
	const title = document.createElement("div");
	title.className = "gjj-bs-material-editor-title";
	title.textContent = `第 ${segmentIndex + 1} 段提示词`;
	const textarea = document.createElement("textarea");
	textarea.value = String(segmentTimelineConfig(node)[segmentIndex]?.prompt || "");
	textarea.placeholder = "留空则使用全局提示词";
	const buttons = document.createElement("div");
	buttons.className = "gjj-bs-material-editor-buttons";
	const clearButton = document.createElement("button");
	clearButton.type = "button";
	clearButton.textContent = "清空";
	const saveButton = document.createElement("button");
	saveButton.type = "button";
	saveButton.textContent = "确定";
	const close = () => closeMaterialPromptEditor(node);
	const clearPrompt = (event) => {
		event.preventDefault();
		event.stopPropagation();
		writePrompt("");
		close();
	};
	const savePrompt = (event) => {
		event.preventDefault();
		event.stopPropagation();
		writePrompt(textarea.value);
		close();
	};
	clearButton.addEventListener("pointerup", clearPrompt);
	clearButton.addEventListener("click", clearPrompt);
	saveButton.addEventListener("pointerup", savePrompt);
	saveButton.addEventListener("click", savePrompt);
	textarea.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
			event.preventDefault();
			writePrompt(textarea.value);
			close();
		}
		if (event.key === "Escape") {
			event.preventDefault();
			close();
		}
	});
	buttons.append(clearButton, saveButton);
	editor.append(title, textarea, buttons);
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "click", "wheel"]) {
		editor.addEventListener(eventName, (event) => event.stopPropagation());
	}
	document.body.appendChild(editor);
	node.__gjjBerniniMaterialPromptEditor = editor;
	const rect = anchor?.getBoundingClientRect?.() || { left: 40, top: 80, bottom: 110, width: 240 };
	const width = Math.min(420, Math.max(260, rect.width || 260));
	editor.style.width = `${width}px`;
	const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
	const top = Math.max(8, Math.min(window.innerHeight - 178, rect.bottom + 6));
	editor.style.left = `${left}px`;
	editor.style.top = `${top}px`;
	setTimeout(() => {
		textarea.focus();
		textarea.select();
	}, 0);
}

function refreshMaterialTimeline(node, force = false) {
	const state = node.__gjjBerniniMaterialTimeline;
	if (!state) return;
	const visible = shouldShowMaterialTimeline(node);
	state.root.style.display = visible ? "flex" : "none";
	if (!visible) return;
	const items = materialTimelineItems(node);
	const config = syncMaterialTimelineConfig(node, false);
	const signature = JSON.stringify({
		items: items.map((item) => [item?.filename || "", item?.subfolder || "", item?.type || "", item?.__sourceIndex]),
		config,
	});
	if (!force && state.signature === signature) return;
	state.signature = signature;
	state.hint.textContent = items.length ? `${items.length} 张素材 / ${Math.max(0, items.length - 1)} 段` : "连接批量图片后显示";
	state.strip.replaceChildren();
	if (!items.length) {
		const empty = document.createElement("div");
		empty.className = "gjj-bs-material-empty";
		empty.textContent = "暂无素材，可连接批量图片或拖入图片";
		state.strip.appendChild(empty);
		return;
	}
	const row = document.createElement("div");
	row.className = "gjj-bs-material-row";
	state.strip.appendChild(row);
	for (const [index, item] of items.entries()) {
		const frame = document.createElement("div");
		frame.className = "gjj-bs-material-frame";
		frame.draggable = true;
		frame.dataset.materialIndex = String(index);
		frame.addEventListener("dragstart", (event) => {
			event.dataTransfer?.setData("application/x-gjj-bernini-material-index", String(index));
			event.dataTransfer?.setData("text/plain", String(index));
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			frame.classList.add("dragging");
		});
		frame.addEventListener("dragend", () => {
			frame.classList.remove("dragging");
			for (const child of row.children) child.classList?.remove?.("drop-target");
		});
		frame.addEventListener("dragover", (event) => {
			const types = Array.from(event.dataTransfer?.types || []);
			if (!types.includes("application/x-gjj-bernini-material-index") && !isExternalFileDrag(event.dataTransfer)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes("application/x-gjj-bernini-material-index") ? "move" : "copy";
			frame.classList.add("drop-target");
		});
		frame.addEventListener("dragleave", () => frame.classList.remove("drop-target"));
		frame.addEventListener("drop", (event) => {
			const files = imageFilesFromDataTransfer(event.dataTransfer);
			const rect = frame.getBoundingClientRect();
			const insertAfter = event.clientX > rect.left + rect.width / 2;
			const insertIndex = index + (insertAfter ? 1 : 0);
			if (files.length) {
				event.preventDefault();
				event.stopPropagation();
				frame.classList.remove("drop-target");
				appendDroppedImageFiles(node, files, insertIndex);
				return;
			}
			const fromRaw = event.dataTransfer?.getData("application/x-gjj-bernini-material-index") || event.dataTransfer?.getData("text/plain");
			const fromIndex = Number(fromRaw);
			if (!Number.isInteger(fromIndex)) return;
			event.preventDefault();
			event.stopPropagation();
			frame.classList.remove("drop-target");
			let targetIndex = insertIndex;
			if (fromIndex < targetIndex) targetIndex -= 1;
			reorderMaterialTimeline(node, fromIndex, targetIndex);
		});
		const img = document.createElement("img");
		img.draggable = false;
		img.loading = "lazy";
		img.src = imageUrl(item);
		img.title = `${index + 1}. ${materialLabel(item, index)}`;
		const badge = document.createElement("div");
		badge.className = "gjj-bs-material-badge";
		badge.textContent = "↔";
		frame.append(img, badge);
		if (index < items.length - 1) {
			const currentConfig = config[index] || {};
			const writeSegment = (patch, refresh = true) => {
				const next = segmentTimelineConfig(node);
				next[index] = {
					...(next[index] || {}),
					...patch,
					start_index: Number(items[index]?.__sourceIndex ?? index),
					end_index: Number(items[index + 1]?.__sourceIndex ?? (index + 1)),
				};
				setSegmentTimelineConfig(node, next);
				if (refresh) refreshMaterialTimeline(node, true);
			};
			const editPrompt = () => {
				showSegmentPromptEditor(node, index, promptBadge, (nextPrompt) => {
					writeSegment({ prompt: String(nextPrompt || "").trim() });
				});
			};
			const segment = document.createElement("div");
			segment.className = "gjj-bs-material-splitter";
			const line = document.createElement("div");
			line.className = "gjj-bs-material-line";
			const frameLabel = document.createElement("div");
			frameLabel.className = "gjj-bs-material-frame-label";
			frameLabel.textContent = `${Math.max(5, Number.parseInt(currentConfig.frames || value(node, "length", DEFAULT_VALUES.length), 10) || DEFAULT_VALUES.length)}f`;
			const startFrameDrag = (event) => {
				event.preventDefault();
				event.stopPropagation();
				const startX = event.clientX;
				const startFrames = Math.max(5, Number.parseInt(segmentTimelineConfig(node)[index]?.frames || currentConfig.frames || value(node, "length", DEFAULT_VALUES.length), 10) || DEFAULT_VALUES.length);
				let latest = startFrames;
				let moved = false;
				const move = (moveEvent) => {
					const delta = Math.round((moveEvent.clientX - startX) / 7) * 4;
					moved = moved || Math.abs(moveEvent.clientX - startX) > 2;
					latest = Math.max(5, Math.min(8192, startFrames + delta));
					frameLabel.textContent = `${latest}f`;
					writeSegment({ frames: latest }, false);
				};
				const up = () => {
					window.removeEventListener("pointermove", move, true);
					window.removeEventListener("pointerup", up, true);
					if (moved) refreshMaterialTimeline(node, true);
				};
				window.addEventListener("pointermove", move, true);
				window.addEventListener("pointerup", up, true);
			};
			line.title = "拖动调整这一段帧数";
			frameLabel.title = "左右拖动调整帧数";
			protect(line);
			protect(frameLabel);
			line.addEventListener("pointerdown", startFrameDrag);
			frameLabel.addEventListener("pointerdown", startFrameDrag);
			segment.append(line, frameLabel);
			frame.appendChild(segment);
			const promptBadge = document.createElement("div");
			promptBadge.className = "gjj-bs-material-prompt-badge";
			const promptText = String(currentConfig.prompt || "").trim();
			promptBadge.textContent = promptText || "双击编辑提示词";
			promptBadge.title = promptText || `双击编辑第 ${index + 1} 段提示词`;
			promptBadge.addEventListener("dblclick", (event) => {
				event.preventDefault();
				event.stopPropagation();
				editPrompt();
			});
			protect(promptBadge);
			frame.appendChild(promptBadge);
		}
		row.appendChild(frame);
	}
}

function updateMediaLinkButton(node) {
	const button = node?.__gjjBerniniPanel?.mediaLink;
	if (!button) return;
	const active = hasActiveMediaLinks(node);
	const remembered = hasRememberedMediaLinks(node);
	button.style.display = active || remembered ? "" : "none";
	button.classList.toggle("active", active);
	button.title = active
		? "已连接上游媒体；点击记住并断开全部媒体输入"
		: "媒体输入已临时断开；点击恢复记住的上游连接";
}

function hideBackendWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		const target = widget(node, name);
		if (!target) continue;
		GJJ_Utils.hideWidget(target);
		target.hidden = true;
		target.computeSize = () => [0, 0];
		target.getHeight = () => 0;
		target.draw = () => {};
		target.last_y = 0;
		target.computedHeight = 0;
		target.margin_top = 0;
		target.size = [0, 0];
		target.options ||= {};
		target.options.hidden = true;
		target.options.display = "hidden";
		for (const element of [target.element, target.inputEl, target.widget]) {
			if (!element?.style) continue;
			element.style.display = "none";
			element.style.visibility = "hidden";
			element.style.height = "0";
			element.style.minHeight = "0";
			element.style.margin = "0";
			element.style.padding = "0";
			element.style.border = "0";
		}
	}
	removeUnlinkedHiddenInputSockets(node, HIDDEN_WIDGETS);
}

function inputLinked(input) {
	if (!input) return false;
	if (Array.isArray(input.link)) return input.link.length > 0;
	return input.link != null;
}

function removeUnlinkedHiddenInputSockets(node, hiddenNames) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const type = String(input?.type || "");
		const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
		if ((hiddenNames.has(name) || hiddenNames.has(converted)) && !inputLinked(input)) {
			if (typeof node.removeInput === "function") node.removeInput(index);
			else node.inputs.splice(index, 1);
		}
	}
}

function ensureLoraChainConfigInput(node) {
	if (!Array.isArray(node?.inputs)) return null;
	let input = node.inputs.find((item) => String(item?.name || "") === LORA_CHAIN_CONFIG_INPUT || String(item?.type || "") === LORA_CHAIN_CONFIG_TYPE);
	if (!input) {
		node.addInput?.(LORA_CHAIN_CONFIG_INPUT, LORA_CHAIN_CONFIG_TYPE);
		input = node.inputs[node.inputs.length - 1];
	}
	if (!input) return null;
	input.name = LORA_CHAIN_CONFIG_INPUT;
	input.type = LORA_CHAIN_CONFIG_TYPE;
	input.label = "🧬 LoRA串联配置";
	input.localized_name = "🧬 LoRA串联配置";
	input.display_name = "🧬 LoRA串联配置";
	input.tooltip = "连接 GJJ_LoraChainConfig 输出，按配置顺序额外叠加 LoRA。";
	return input;
}

function normalizeInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const selected = [];
	const take = (name) => {
		const input = node.inputs.find((item) => String(item?.name || "") === name && !selected.includes(item));
		if (input) selected.push(input);
	};
	take("source_media");
	take("reference_media_1");
	take("reference_media_2");
	if (selected.length < 2) take("reference_video");
	if (selected.length < 3) take("reference_image_01");

	for (const [name] of TOP_INPUTS) {
		if (selected.length >= TOP_INPUTS.length) break;
		const input = node.inputs.find((item) => !selected.includes(item) && (
			LEGACY_INPUT_NAMES.has(String(item?.name || "")) || String(item?.name || "") === name
		));
		if (input) selected.push(input);
	}
	while (selected.length < TOP_INPUTS.length) {
		node.addInput?.(TOP_INPUTS[selected.length][0], MEDIA_TYPE);
		selected.push(node.inputs[node.inputs.length - 1]);
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		if ((LEGACY_INPUT_NAMES.has(name) || TOP_INPUTS.some(([target]) => target === name)) && !selected.includes(input)) {
			try { node.disconnectInput?.(index); } catch (_) {}
			node.removeInput?.(index);
		}
	}
	selected.forEach((input, index) => {
		const [name, label] = TOP_INPUTS[index];
		input.name = name;
		input.type = MEDIA_TYPE;
		input.label = label;
		input.localized_name = label;
		input.tooltip = "支持 GJJ_BATCH_IMAGE、IMAGE、VIDEO；节点内部自动解包分析。";
	});
	const loraInput = ensureLoraChainConfigInput(node);
	const others = node.inputs.filter((input) => !selected.includes(input));
	node.inputs = [...selected, ...others.filter((input) => input !== loraInput), ...(loraInput ? [loraInput] : [])];
}

function widgetChoices(target) {
	let choices = target?.options?.values || target?.options?.items || target?.values;
	if (typeof choices === "function") {
		try { choices = choices(); } catch (_) { choices = []; }
	}
	return Array.isArray(choices) ? choices.map(String) : [];
}

function widgetDefaultModel(target, name) {
	return String(target?.options?.gjj_default_model || DEFAULT_VALUES[name] || "");
}

function legalWidgetValue(node, name, input) {
	const text = normalizeValue(name, input);
	if (!MODEL_WIDGETS.has(name)) return text;
	const target = widget(node, name);
	const choices = widgetChoices(target);
	if (!choices.length) return text || widgetDefaultModel(target, name);
	if (!text || text.startsWith(MISSING_MODEL_PREFIX) || !choices.includes(text)) return choices[0];
	return text;
}

function isMissingModelValue(node, name, currentValue = null) {
	if (!MODEL_WIDGETS.has(name)) return false;
	const target = widget(node, name);
	if (!target?.options?.gjj_missing_model) return false;
	const current = String(currentValue ?? value(node, name, widgetDefaultModel(target, name)) ?? "");
	return current === widgetDefaultModel(target, name);
}

function updateMissingModelControl(node, name, control, currentValue = null) {
	if (!control || !MODEL_WIDGETS.has(name)) return;
	const missing = isMissingModelValue(node, name, currentValue);
	control.classList.toggle("gjj-bs-missing-model", missing);
	if (missing) {
		const target = widget(node, name);
		const label = target?.options?.display_name || target?.label || name;
		control.title = `${label} 缺失：${widgetDefaultModel(target, name)}。请放入对应模型目录后刷新 ComfyUI。`;
	}
}

function setBooleanButtonState(control, enabled) {
	const label = control?.dataset?.label || "";
	if (!control) return;
	control.classList.toggle("active", Boolean(enabled));
	control.textContent = `${label}${label ? "：" : ""}${enabled ? "开启" : "关闭"}`;
	control.title = `${label || "开关"}：${enabled ? "开启" : "关闭"}`;
}

function setResizeModeControlState(control, usePanelSize) {
	if (!control) return;
	for (const button of control.querySelectorAll("button[data-resize-mode]")) {
		const active = button.dataset.resizeMode === (usePanelSize ? "panel" : "source");
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", active ? "true" : "false");
	}
	control.title = usePanelSize ? "当前使用面板宽高输出。" : "当前沿用外接源媒体尺寸输出。";
}

function setChoiceButtonControlState(control, currentValue) {
	if (!control) return;
	const current = String(currentValue ?? "");
	for (const button of control.querySelectorAll("button[data-choice-value]")) {
		const active = button.dataset.choiceValue === current;
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", active ? "true" : "false");
	}
}

function makeControl(node, name) {
	const target = widget(node, name);
	if (!target) return null;
	const choices = widgetChoices(target);
	let control;
	if (name === "resize_to_panel") {
		control = document.createElement("div");
		control.dataset.resizeModeControl = "true";
		control.classList.add("gjj-bs-segment-control");
		for (const [mode, label, nextValue] of [
			["source", "按源媒体尺寸", false],
			["panel", "按面板尺寸", true],
		]) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.resizeMode = mode;
			button.textContent = label;
			button.title = label;
			bindButton(button, () => setValue(node, name, nextValue));
			control.appendChild(button);
		}
		setResizeModeControlState(control, Boolean(target.value));
	} else if (BUTTON_CHOICE_GROUPS[name]) {
		control = document.createElement("div");
		control.dataset.choiceButtonControl = "true";
		control.classList.add("gjj-bs-segment-control", "gjj-bs-choice-control");
		for (const [choice, label] of BUTTON_CHOICE_GROUPS[name]) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.choiceValue = choice;
			button.textContent = label;
			button.title = label;
			bindButton(button, () => setValue(node, name, choice));
			control.appendChild(button);
		}
		setChoiceButtonControlState(control, String(target.value ?? DEFAULT_VALUES[name] ?? ""));
	} else if (typeof target.value === "boolean") {
		control = document.createElement("button");
		control.type = "button";
		control.dataset.booleanControl = "true";
		control.dataset.label = target.options?.display_name || target.label || name;
		setBooleanButtonState(control, Boolean(target.value));
		bindButton(control, () => setValue(node, name, !Boolean(value(node, name, DEFAULT_VALUES[name]))));
	} else if (choices.length) {
		control = document.createElement("select");
		const defaultModel = widgetDefaultModel(target, name);
		const nextValue = legalWidgetValue(node, name, target.value);
		const missingModel = isMissingModelValue(node, name, nextValue);
		for (const choice of choices) {
			const option = document.createElement("option");
			option.value = choice;
			option.textContent = choice;
			if (missingModel && choice === defaultModel) {
				option.dataset.missingModel = "true";
				option.style.color = "#ff8b8b";
			}
			control.appendChild(option);
		}
		if (nextValue !== target.value) setValue(node, name, nextValue);
		control.value = String(nextValue ?? "");
		updateMissingModelControl(node, name, control, nextValue);
		control.addEventListener("change", () => setValue(node, name, control.value));
	} else if (typeof target.value === "number") {
		control = document.createElement("input");
		control.type = "number";
		for (const attr of ["min", "max", "step"]) {
			if (Number.isFinite(Number(target.options?.[attr]))) control[attr] = String(target.options[attr]);
		}
		control.value = String(target.value);
		control.addEventListener("change", () => {
			const parsed = String(target.type || "").toUpperCase() === "INT"
				? Number.parseInt(control.value || "0", 10)
				: Number.parseFloat(control.value || "0");
			setValue(node, name, Number.isFinite(parsed) ? parsed : target.value);
		});
	} else if (target.options?.multiline) {
		control = document.createElement("textarea");
		control.value = String(target.value ?? "");
		control.addEventListener("input", () => setValue(node, name, control.value));
	} else {
		control = document.createElement("input");
		control.type = "text";
		control.value = String(target.value ?? "");
		control.addEventListener("change", () => setValue(node, name, control.value));
	}
	control.classList.add("gjj-bs-control");
	control.title = target.options?.tooltip || target.tooltip || name;
	if (control.dataset?.resizeModeControl !== "true") protect(control);
	return control;
}

function buildSettings(node, groups, title, popupName) {
	const settings = document.createElement("div");
	settings.className = `gjj-bs-popover gjj-bs-${popupName}-popover`;
	settings.dataset.popupName = popupName;
	protect(settings);
	const controls = new Map();
	const header = document.createElement("div");
	header.className = "gjj-bs-pop-head";
	const caption = document.createElement("div");
	caption.className = "gjj-bs-pop-title";
	caption.textContent = title;
	const confirm = makeButton("确定", `关闭${title}`, "gjj-bs-confirm", () => setActivePopup(node, ""));
	header.append(caption, confirm);
	settings.appendChild(header);
	for (const [sectionTitle, names] of groups) {
		const section = document.createElement("section");
		const heading = document.createElement("div");
		heading.className = "gjj-bs-heading";
		heading.textContent = sectionTitle;
		section.appendChild(heading);
		const grid = document.createElement("div");
		grid.className = "gjj-bs-grid";
		let booleanRow = null;
		for (const name of names) {
			const control = makeControl(node, name);
			if (!control) continue;
			controls.set(name, control);
			const labelText = name === "resize_to_panel" ? "尺寸模式" : (widget(node, name)?.options?.display_name || widget(node, name)?.label || name);
			if (control.dataset?.booleanControl === "true") {
				control.dataset.label = labelText;
				setBooleanButtonState(control, Boolean(value(node, name, DEFAULT_VALUES[name])));
				if (!booleanRow) {
					booleanRow = document.createElement("div");
					booleanRow.className = "gjj-bs-boolean-row";
					grid.appendChild(booleanRow);
				}
				booleanRow.appendChild(control);
				continue;
			}
			const row = document.createElement("label");
			row.className = control.tagName === "TEXTAREA" ? "gjj-bs-field wide" : "gjj-bs-field";
			const label = document.createElement("span");
			label.textContent = labelText;
			row.append(label, control);
			grid.appendChild(row);
		}
		section.appendChild(grid);
		settings.appendChild(section);
	}
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "click"]) {
		settings.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return { settings, controls };
}

function positionSettingsPopup(popup, anchor) {
	if (!popup || !anchor) return;
	const rect = anchor.getBoundingClientRect?.();
	const viewportWidth = Math.max(320, window.innerWidth || 720);
	const viewportHeight = Math.max(240, window.innerHeight || 540);
	const desiredWidth = popup.dataset.popupName === "model" ? 560 : 560;
	const popupWidth = Math.min(desiredWidth, Math.max(360, viewportWidth - 28));
	const left = Math.min(viewportWidth - popupWidth - 14, Math.max(14, rect?.left || 80));
	const top = Math.min(viewportHeight - 120, Math.max(14, (rect?.bottom || 80) + 6));
	popup.style.width = `${Math.round(popupWidth)}px`;
	popup.style.maxHeight = `${Math.round(Math.max(220, viewportHeight - top - 20))}px`;
	popup.style.left = `${Math.round(left)}px`;
	popup.style.top = `${Math.round(top)}px`;
}

function ensurePanelStyle() {
	if (document.getElementById(PANEL_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = PANEL_STYLE_ID;
	style.textContent = `
		.gjj-bs-root,.gjj-bs-root *{box-sizing:border-box}.gjj-bs-root{display:flex;flex-direction:column;gap:7px;width:100%;padding:2px 0 4px;font:12px/1.4 system-ui;color:#dce7e9;pointer-events:auto}
		.gjj-bs-toolbar{display:flex;flex-wrap:wrap;gap:6px;width:100%;align-items:center}.gjj-bs-button{min-height:32px;border-radius:6px;border:1px solid #50616a;color:#e8f0f2;font-weight:700;cursor:pointer;padding:0 10px;white-space:normal;line-height:1.15}
		.gjj-bs-generate{flex:0 0 auto;min-width:116px;padding:0 12px;background:linear-gradient(135deg,#075a45,#0b9b70);border-color:#24c68b}.gjj-bs-translate,.gjj-bs-seed,.gjj-bs-cache,.gjj-bs-vars,.gjj-bs-settings-button,.gjj-bs-link,.gjj-bs-resize{flex:0 0 38px;padding:0;background:linear-gradient(135deg,#28323a,#3e4b55)}
		.gjj-bs-vars{border-color:#d6a642;color:#ffe8a3}.gjj-bs-settings-button{border-color:#24c68b}.gjj-bs-button:hover{filter:brightness(1.18);transform:translateY(-1px)}.gjj-bs-button.active{background:linear-gradient(135deg,#164d3c,#287b59);border-color:#61c994}.gjj-bs-button.popup-open{box-shadow:0 0 0 1px #9ed6df inset}
		.gjj-bs-prompt-field{display:flex;flex-direction:column;gap:4px;color:#b9c8cc}.gjj-bs-prompt-head{display:flex;align-items:center;gap:6px;width:100%;min-width:0}.gjj-bs-prompt-title{flex:0 0 auto;white-space:nowrap}.gjj-bs-quick-tag{flex:0 0 auto;min-height:20px;padding:0 7px;border-radius:5px;border-color:#24c68b;background:#164d3c;color:#eafff7;font-size:11px;font-weight:800}.gjj-bs-quick-tag:hover{background:#1b674f;color:#fff}.gjj-bs-prompt{min-height:58px;resize:vertical}
		.gjj-bs-mode-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}.gjj-bs-mode-button{flex:0 0 auto;min-height:20px;padding:0 7px;border-radius:5px;font-size:11px;background:#18242a;border-color:#3c5058;color:#d7e4e7}
		.gjj-bs-popover{position:fixed;z-index:100000;display:none;flex-direction:column;gap:9px;padding:9px;border:1px solid #45606a;border-radius:8px;background:#10191e;color:#dce7e9;box-shadow:0 12px 32px rgba(0,0,0,.45);font:12px/1.4 system-ui,'Microsoft YaHei',sans-serif;box-sizing:border-box;overflow:auto}.gjj-bs-popover.open{display:flex}.gjj-bs-pop-head{position:sticky;top:-9px;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px;margin:-9px -9px 0;padding:8px 9px 6px;border-bottom:1px solid #263842;background:#10191e}.gjj-bs-pop-title{font-weight:800;color:#d8f5f3}.gjj-bs-confirm{flex:0 0 auto;min-height:24px;padding:0 10px;background:#1d3d34;border-color:#24c68b}
		.gjj-bs-heading{font-weight:800;color:#9ed6df;margin-bottom:5px}.gjj-bs-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:6px}.gjj-bs-field{display:flex;align-items:center;gap:8px;min-width:0}.gjj-bs-field.wide{align-items:flex-start;flex-direction:column}.gjj-bs-field>span{flex:0 0 92px;color:#aebbc0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.gjj-bs-control{flex:1;min-width:0;width:100%;border:1px solid #40515a;border-radius:5px;background:#0e1519;color:#eaf2f3;padding:5px 7px}.gjj-bs-control:is(textarea){min-height:64px;resize:vertical}
		select.gjj-bs-control{border-color:#3c7f91;background:#122932;color:#f0fbff;font-weight:650;box-shadow:0 0 0 1px rgba(77,171,193,.18) inset;cursor:pointer}select.gjj-bs-control:hover{border-color:#62b9cb;background:#15323d}select.gjj-bs-control:focus{outline:none;border-color:#8bd8e8;box-shadow:0 0 0 1px rgba(139,216,232,.6),0 0 0 3px rgba(35,130,154,.28)}select.gjj-bs-control option{background:#102229;color:#f0fbff}
		select.gjj-bs-control.gjj-bs-missing-model{border-color:#ff5f5f;background:#321819;color:#ffb4b4;box-shadow:0 0 0 1px rgba(255,95,95,.45) inset,0 0 0 3px rgba(255,95,95,.12)}select.gjj-bs-control.gjj-bs-missing-model option[data-missing-model="true"]{color:#ff8b8b}
		.gjj-bs-segment-control{display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent}.gjj-bs-segment-control>button{flex:1 1 0;min-width:0;min-height:32px;border:1px solid #40515a;border-radius:6px;background:#152026;color:#b9c8cc;font-weight:750;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gjj-bs-choice-control>button{flex:0 1 auto;min-width:44px;padding:0 10px}.gjj-bs-segment-control>button.active{border-color:#24c68b;background:#164d3c;color:#eafff7}.gjj-bs-segment-control>button:disabled{cursor:not-allowed;opacity:.52}
		.gjj-bs-boolean-row{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0}.gjj-bs-boolean-row>.gjj-bs-control{flex:1 1 0;min-width:0;width:auto;min-height:28px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#152026;color:#b9c8cc}.gjj-bs-boolean-row>.gjj-bs-control.active{border-color:#24c68b;background:#164d3c;color:#eafff7}
		.gjj-bs-material-timeline{display:flex;flex-direction:column;gap:6px;width:100%;padding:8px 10px;border:1px solid #3c515a;border-radius:6px;background:#0d151a;pointer-events:auto}.gjj-bs-material-head{display:flex;align-items:center;justify-content:space-between;color:#dce7e2;font-size:14px;line-height:18px}.gjj-bs-material-hint{color:#8fa4ac;font-size:13px}.gjj-bs-material-strip{position:relative;height:154px;overflow-x:auto;overflow-y:hidden;border:1px solid #253841;border-radius:4px;background:#05090c;scrollbar-gutter:stable}.gjj-bs-material-row{position:relative;display:inline-flex;align-items:stretch;min-width:max-content;height:132px;padding:3px 3px 19px 3px}.gjj-bs-material-frame{position:relative;width:168px;height:132px;flex:0 0 168px;border:1px solid #283d46;background:#071015;display:flex;align-items:center;justify-content:center;overflow:visible}.gjj-bs-material-frame:first-child{border-radius:3px 0 0 3px}.gjj-bs-material-frame:last-child{border-radius:0 3px 3px 0}.gjj-bs-material-frame.dragging{opacity:.55}.gjj-bs-material-frame.drop-target{outline:2px solid #7ed6a7;outline-offset:-2px}.gjj-bs-material-frame>img{display:block;width:100%;height:100%;object-fit:cover;background:#05090c}.gjj-bs-material-badge{position:absolute;right:7px;top:7px;width:20px;height:20px;border-radius:5px;border:1px solid rgba(255,255,255,.42);background:#4c8eea;color:#fff;font-size:14px;line-height:18px;text-align:center;box-shadow:0 1px 5px rgba(0,0,0,.35);z-index:4}.gjj-bs-material-splitter{position:absolute;top:0;bottom:0;right:0;width:62px;transform:translateX(31px);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:5;pointer-events:none}.gjj-bs-material-line{position:absolute;top:0;bottom:0;left:50%;width:4px;transform:translateX(-2px);background:rgba(126,214,167,.9);box-shadow:0 0 8px rgba(126,214,167,.75);cursor:ew-resize;pointer-events:auto}.gjj-bs-material-frame-label{position:relative;z-index:6;padding:2px 6px;border-radius:999px;background:rgba(5,9,12,.78);color:#dce7e2;font-size:12px;line-height:16px;box-shadow:0 1px 5px rgba(0,0,0,.45);user-select:none;cursor:ew-resize;pointer-events:auto}.gjj-bs-material-prompt-badge{position:absolute;left:0;right:0;bottom:0;padding:4px 8px;box-sizing:border-box;background:rgba(5,9,12,.45);color:#aebfc3;font-size:14px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:text;pointer-events:auto;z-index:3}.gjj-bs-material-prompt-badge:hover{color:#f3fff9;background:rgba(5,9,12,.62)}.gjj-bs-material-editor{position:fixed;z-index:100002;display:flex;flex-direction:column;gap:8px;padding:9px;border:1px solid #45606a;border-radius:8px;background:#10191e;color:#dce7e9;box-shadow:0 12px 32px rgba(0,0,0,.45);font:12px/1.4 system-ui,'Microsoft YaHei',sans-serif;box-sizing:border-box}.gjj-bs-material-editor-title{font-weight:800;color:#d8f5f3}.gjj-bs-material-editor textarea{width:100%;height:88px;box-sizing:border-box;border:1px solid #42606c;border-radius:7px;background:#071015;color:#e7f3f3;font-size:13px;line-height:1.45;padding:7px;resize:vertical}.gjj-bs-material-editor-buttons{display:flex;justify-content:flex-end;gap:6px}.gjj-bs-material-editor button{min-height:24px;padding:0 10px;border:1px solid #45606a;border-radius:6px;background:#15242b;color:#dce7e9;cursor:pointer}.gjj-bs-material-editor button:hover{border-color:#24c68b;color:#fff}.gjj-bs-material-empty{color:#8fa4ac;font-size:12px;padding:56px 10px}
		.gjj-bs-preview-wrap{display:flex;flex-direction:column;gap:5px;width:100%}.gjj-bs-preview-status{color:#92a7ad;font-size:11px}.gjj-bs-preview{display:none;width:100%;height:auto;object-fit:contain;border:1px solid #334850;border-radius:8px;background:#0b1114}
	`;
	(document.head || document.body || document.documentElement).appendChild(style);
}

function cleanupPanelPopups(node) {
	const state = node?.__gjjBerniniPanel;
	for (const popup of [state?.settings, state?.modelSettings, state?.sizeSettings]) {
		popup?.remove?.();
	}
}

function createPanel(node) {
	if (node.__gjjBerniniPanel || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div");
	root.className = "gjj-bs-root";
	protect(root);
	ensurePanelStyle();
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-bs-toolbar";
	const generate = makeButton("🎬 生成视频", "只执行当前 Bernini 节点并生成视频", "gjj-bs-generate", async () => {
		const old = generate.innerHTML;
		generate.innerHTML = "⏳ 执行中";
		generate.disabled = true;
		try {
			writeSerializedValues(node);
			await queueOnlyCurrentNode(node);
		} finally {
			setTimeout(() => {
				generate.innerHTML = old;
				generate.disabled = false;
				updateGenerateButton(node);
			}, 900);
		}
	});
	const translate = makeButton("🌏", "点击立即翻译提示词", "gjj-bs-translate", async () => {
		node.properties ||= {};
		node.properties[TRANSLATE_PROPERTY] = true;
		setValue(node, "translation_enabled", true);
		translate.classList.add("active");
		const promptWidget = widget(node, "prompt");
		const original = String(promptWidget?.value || "");
		if (!original.trim()) return;
		const old = translate.textContent;
		translate.textContent = "…";
		translate.disabled = true;
		try {
			const data = await requestPromptTranslation({
				node,
				positive: original,
				negative: String(value(node, "negative_prompt", "")),
				device: "gpu",
				maxLength: 512,
				batchSize: 8,
				unloadAfterUse: false,
				nodeName: "GJJ · Bernini Studio",
			});
			setValue(node, "prompt", String(data?.positive ?? original));
			setValue(node, "negative_prompt", String(data?.negative ?? value(node, "negative_prompt", "")));
		} catch (error) {
			console.error("[GJJ BerniniStudio] 翻译失败", error);
		} finally {
			translate.textContent = old || "🌏";
			translate.disabled = false;
		}
	});
	const seed = makeButton("🎲", "随机种子：关闭，保持当前种子并允许复用缓存", "gjj-bs-seed", () => {
		setValue(node, "randomize_seed", !Boolean(value(node, "randomize_seed", DEFAULT_VALUES.randomize_seed)));
	});
	const keepModel = makeButton("🧠", "打开模型与运行参数", "gjj-bs-cache", () => {
		togglePopup(node, "model");
	});
	const resize = makeButton("📐", "打开尺寸与输出参数", "gjj-bs-resize", () => {
		togglePopup(node, "size");
	});
	const mediaLink = makeButton("🔗", "记住并断开/恢复媒体输入连接", "gjj-bs-link", () => {
		toggleMediaLinks(node);
	});
	const templateSource = makeButton("⚡", "从 GJJ_TemplateParams / GJJ_SETNODE / 变量读取系统选择 Bernini 参数来源", "gjj-bs-vars", async () => {
		const old = templateSource.textContent;
		templateSource.textContent = "…";
		templateSource.disabled = true;
		try {
			await openTemplateSourcePickerLazy(node, templateSource);
		} finally {
			templateSource.textContent = old || "⚡";
			templateSource.disabled = false;
			syncPanel(node);
		}
	});
	templateSource.style.width = "38px";
	templateSource.style.flex = "0 0 38px";
	templateSource.style.padding = "0";
	node.__gjjTemplateSourceButton = templateSource;
	node.__gjjTemplateSourcePanel = templateSource;
	node.__gjjTemplateSourceFields = TEMPLATE_SOURCE_FIELDS;
	const settingsButton = makeButton("⚙️", "打开生成与提示词参数", "gjj-bs-settings-button", () => {
		togglePopup(node, "settings");
	});
	toolbar.append(generate, translate, seed, mediaLink, templateSource, keepModel, resize, settingsButton);
	const promptField = document.createElement("label");
	promptField.className = "gjj-bs-prompt-field";
	const promptHead = document.createElement("div");
	promptHead.className = "gjj-bs-prompt-head";
	const promptLabel = document.createElement("span");
	promptLabel.className = "gjj-bs-prompt-title";
	promptLabel.textContent = "✨ 正向提示词";
	const prompt = document.createElement("textarea");
	prompt.className = "gjj-bs-control gjj-bs-prompt";
	prompt.placeholder = "输入 Bernini 生成或编辑提示词";
	prompt.value = String(value(node, "prompt", ""));
	prompt.addEventListener("input", () => setValue(node, "prompt", prompt.value));
	protect(prompt);
	const modeButtons = document.createElement("div");
	modeButtons.className = "gjj-bs-mode-row";
	protect(modeButtons);
	const removeSubtitle = makeButton("去字幕", "写入去字幕提示词", "gjj-bs-quick-tag", () => {
		setValue(node, "prompt", REMOVE_SUBTITLE_PROMPT);
		prompt.value = REMOVE_SUBTITLE_PROMPT;
	});
	removeSubtitle.style.display = "none";
	promptHead.append(promptLabel, modeButtons, removeSubtitle);
	promptField.append(promptHead, prompt);
	const materialTimeline = createMaterialTimeline(node);
	const settingsState = buildSettings(node, SETTINGS_GROUPS, "生成参数", "settings");
	const modelSettingsState = buildSettings(node, MODEL_SETTINGS_GROUPS, "模型参数", "model");
	const sizeSettingsState = buildSettings(node, SIZE_SETTINGS_GROUPS, "尺寸参数", "size");
	const controls = new Map([...settingsState.controls, ...modelSettingsState.controls, ...sizeSettingsState.controls]);
	root.append(toolbar, promptField, materialTimeline.root);
	(document.body || document.documentElement).append(settingsState.settings, modelSettingsState.settings, sizeSettingsState.settings);
	const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	domWidget.computeSize = (width) => [Math.max(430, Number(width || 430)), Math.max(38, root.scrollHeight + 4)];
	node.__gjjBerniniPanel = {
		root,
		toolbar,
		generate,
		translate,
		seed,
		keepModel,
		resize,
		mediaLink,
		templateSource,
		settingsButton,
		prompt,
		modeButtons,
		removeSubtitle,
		materialTimeline,
		settings: settingsState.settings,
		modelSettings: modelSettingsState.settings,
		sizeSettings: sizeSettingsState.settings,
		controls,
		domWidget,
	};
	syncPanel(node);
}

function imageUrl(item) {
	if (!item?.filename) return "";
	return api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}&rand=${Date.now()}`);
}

function createPreview(node) {
	if (node.__gjjBerniniPreview || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div");
	root.className = "gjj-bs-preview-wrap";
	root.style.display = "none";
	const status = document.createElement("div");
	status.className = "gjj-bs-preview-status";
	status.textContent = "";
	const image = document.createElement("img");
	image.className = "gjj-bs-preview";
	root.append(status, image);
	protect(root);
	const domWidget = node.addDOMWidget(PREVIEW_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	domWidget.computeSize = (width) => {
		const contentWidth = Math.max(0, Number(width || node.size?.[0] || 430) - 20);
		const ratio = Number(image.naturalWidth || 0) > 0 ? Number(image.naturalHeight || 0) / Number(image.naturalWidth) : 0;
		return [contentWidth, image.style.display === "none" ? 0 : Math.max(80, contentWidth * ratio + 28)];
	};
	node.__gjjBerniniPreview = { root, status, image, domWidget };
}

function updatePreview(node, images, segment = null, total = null, label = "") {
	const state = node.__gjjBerniniPreview;
	if (!state) return;
	if (Array.isArray(images) && images[0]) {
		state.root.style.display = "flex";
		state.image.src = imageUrl(images[0]);
		state.image.style.display = "block";
	}
	if (segment != null) {
		state.status.textContent = label === "tail_frame"
			? `第 ${segment}/${total} 段尾帧预览`
			: `已完成第 ${segment}/${total} 段`;
	}
	fitNode(node);
	fitNode(node, 80);
	GJJ_Utils.refreshNode(node);
}

function syncPanel(node) {
	const state = node.__gjjBerniniPanel;
	if (!state) return;
	updateTemplateSourcePanelLazy(node, TEMPLATE_SOURCE_FIELDS);
	if (state.templateSource) {
		state.templateSource.textContent = "⚡";
		state.templateSource.style.width = "38px";
		state.templateSource.style.flex = "0 0 38px";
		state.templateSource.style.padding = "0";
		state.templateSource.classList.add("gjj-bs-vars");
	}
	updateGenerateButton(node);
	updateModeButtons(node);
	updateRemoveSubtitleButton(node);
	updateKeepModelButton(node);
	updateRandomizeSeedButton(node);
	updateResizeButton(node);
	updateMediaLinkButton(node);
	refreshMaterialTimeline(node);
	const popup = activePopup(node);
	state.settings.classList.toggle("open", popup === "settings");
	state.modelSettings?.classList.toggle("open", popup === "model");
	state.sizeSettings?.classList.toggle("open", popup === "size");
	state.settingsButton.classList.toggle("active", popup === "settings");
	state.keepModel?.classList.toggle("popup-open", popup === "model");
	state.resize?.classList.toggle("popup-open", popup === "size");
	if (popup === "settings") positionSettingsPopup(state.settings, state.settingsButton);
	else if (popup === "model") positionSettingsPopup(state.modelSettings, state.keepModel);
	else if (popup === "size") positionSettingsPopup(state.sizeSettings, state.resize);
	state.translate.classList.toggle("active", Boolean(node.properties?.[TRANSLATE_PROPERTY] || value(node, "translation_enabled", false)));
	if (document.activeElement !== state.prompt) {
		state.prompt.value = String(value(node, "prompt", ""));
	}
	const sources = selectedTemplateSources(node);
	const sourceControlsSize = sourceSizeComesFromInput(node);
	for (const [name, control] of state.controls || []) {
		if (!control) continue;
		const current = legalWidgetValue(node, name, value(node, name, DEFAULT_VALUES[name]));
		if (MODEL_WIDGETS.has(name) && current !== value(node, name, DEFAULT_VALUES[name])) setValue(node, name, current);
		const focused = document.activeElement === control;
		if (control.dataset?.resizeModeControl === "true") {
			setResizeModeControlState(control, Boolean(current));
		} else if (control.dataset?.choiceButtonControl === "true") {
			setChoiceButtonControlState(control, String(current ?? ""));
		} else if (control.dataset?.booleanControl === "true") {
			setBooleanButtonState(control, Boolean(current));
		} else if (!focused) {
			if (control.type === "checkbox") control.checked = Boolean(current);
			else control.value = String(current ?? "");
		}
		updateMissingModelControl(node, name, control, current);
		const templateControlled = Boolean(String(sources[name] || "").trim());
		const sizeControlled = sourceControlsSize && (name === "width" || name === "height");
		const controlled = templateControlled || sizeControlled;
		control.disabled = controlled;
		if (control.dataset?.resizeModeControl === "true") {
			for (const button of control.querySelectorAll("button[data-resize-mode]")) button.disabled = controlled;
		}
		if (control.dataset?.choiceButtonControl === "true") {
			for (const button of control.querySelectorAll("button[data-choice-value]")) button.disabled = controlled;
		}
		control.style.opacity = controlled ? "0.52" : "";
		control.title = templateControlled
			? `参数已由变量 ${sources[name]} 接管`
			: (sizeControlled ? "源媒体已外接且未按面板尺寸输出，宽高将自动沿用源媒体尺寸。" : (widget(node, name)?.options?.tooltip || widget(node, name)?.tooltip || name));
	}
	const promptControlled = Boolean(String(sources.prompt || "").trim());
	state.prompt.disabled = promptControlled;
	state.prompt.style.opacity = promptControlled ? "0.52" : "";
	state.prompt.title = promptControlled ? `提示词已由变量 ${sources.prompt} 接管` : "输入 Bernini 生成或编辑提示词";
	fitNode(node);
	fitNode(node, 80);
}

function fitNode(node, delay = 0) {
	const run = () => {
		hideBackendWidgets(node);
		const computed = node.computeSize?.();
		if (Array.isArray(computed)) {
			const panelHeight = Number(node.__gjjBerniniPanel?.root?.scrollHeight || 0);
			const previewVisible = node.__gjjBerniniPreview?.image?.style?.display !== "none";
			const previewHeight = previewVisible ? Number(node.__gjjBerniniPreview?.root?.scrollHeight || 0) : 0;
			const targetHeight = Math.max(120, panelHeight + previewHeight + 92);
			node.setSize?.([
				Math.max(430, Number(node.size?.[0] || computed[0] || 430)),
				Math.max(150, Math.min(Number(computed[1] || targetHeight), targetHeight)),
			]);
		}
		GJJ_Utils.dirtyCanvas(node);
	};
	if (delay > 0) setTimeout(() => requestAnimationFrame(run), delay);
	else requestAnimationFrame(run);
}

function stabilize(node) {
	if (!node || String(node.comfyClass || node.type || "") !== NODE_TYPE) return;
	applyValues(node, collectValues(node));
	node.color = "#2b727e";
	node.bgcolor = "#11191d";
	node.boxcolor = "#6eb6c0";
	normalizeInputs(node);
	hideBackendWidgets(node);
	createPanel(node);
	createPreview(node);
	updateTemplateSourcePanelLazy(node, TEMPLATE_SOURCE_FIELDS);
	syncPanel(node);
	node.size ||= [430, 260];
	node.size[0] = Math.max(430, Number(node.size[0] || 430));
	fitNode(node);
	fitNode(node, 80);
	fitNode(node, 400);
}

function schedule(node, delay = 0) {
	setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.BerniniStudio",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		nodeData.output_preview = false;
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			schedule(this);
			schedule(this, 100);
			return result;
		};
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const storedValues = valuesFromSerialized(serializedNode);
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			applyValues(this, storedValues || collectValues(this));
			writeSerializedValues(this);
			schedule(this);
			schedule(this, 100);
			return result;
		};
		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			writeSerializedValues(this, serializedNode);
			return result;
		};
		const originalConnections = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnections?.apply(this, args);
			schedule(this);
			return result;
		};
		const originalRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			cleanupPanelPopups(this);
			return originalRemoved?.apply(this, args);
		};
		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalExecuted?.apply(this, arguments);
			updatePreview(this, message?.gjj_images || message?.ui?.gjj_images);
			if (this.__gjjBerniniPreview) this.__gjjBerniniPreview.status.textContent = "全部片段生成并合成完成";
			return result;
		};
	},
	setup() {
		api.addEventListener("gjj_bernini_segment_preview", (event) => {
			const detail = event?.detail || {};
			for (const node of app.graph?._nodes || []) {
				if (String(node?.comfyClass) === NODE_TYPE && String(node.id) === String(detail.node)) {
					updatePreview(node, detail.images, detail.segment, detail.total, detail.label);
				}
			}
		});
		api.addEventListener("gjj_node_progress", (event) => {
			const detail = event?.detail || {};
			for (const node of app.graph?._nodes || []) {
				if (String(node?.comfyClass) === NODE_TYPE && String(node.id) === String(detail.node) && node.__gjjBerniniPreview) {
					node.__gjjBerniniPreview.status.textContent = String(detail.text || "处理中...");
				}
			}
		});
		api.addEventListener("gjj_bernini_seed_update", (event) => {
			const detail = event?.detail || {};
			for (const node of app.graph?._nodes || []) {
				if (String(node?.comfyClass) === NODE_TYPE && String(node.id) === String(detail.node)) {
					setValue(node, "seed", Number(detail.seed || 0));
				}
			}
		});
		window.addEventListener("gjj-generation-template-sources-updated", (event) => {
			const node = event?.detail?.node;
			if (String(node?.comfyClass) !== NODE_TYPE) return;
			syncPanel(node);
		});
		window.addEventListener("gjj-template-source-picker-opening", (event) => {
			for (const node of app.graph?._nodes || []) {
				if (String(node?.comfyClass) !== NODE_TYPE) continue;
				closePanelPopups(node);
				syncPanel(node);
			}
		});
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass) === NODE_TYPE) stabilize(node);
		}
	},
});

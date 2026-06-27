import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { requestPromptTranslation } from "./gjj_common_prompt_translation.js";
import { createTemplateSourceButton, updateTemplateSourcePanel, TEMPLATE_SOURCE_PROPERTY } from "./gjj_generation_template_sources.js";

const NODE_TYPE = "GJJ_BerniniStudio";
const MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const PANEL_WIDGET = "__gjj_bernini_panel";
const PREVIEW_WIDGET = "__gjj_bernini_preview";
const SETTINGS_PROPERTY = "gjj_bernini_settings_open";
const TRANSLATE_PROPERTY = "gjj_bernini_translate_enabled";
const VALUES_PROPERTY = "gjj_bernini_values";
const LINK_MEMORY_PROPERTY = "gjj_bernini_link_memory";
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
	["生成参数", ["mode", "width", "height", "length", "segment_frames", "batch_size", "steps", "high_steps", "cfg", "seed", "sampler_name", "scheduler", "denoise", "ref_max_size"]],
	["输出参数", ["frame_rate", "filename_prefix", "format_name", "vae_tiling", "tile_x", "tile_y"]],
	["运行优化", ["use_accel_lora", "enable_sage_attention", "enable_fp16_accumulation"]],
	["模型参数", ["high_model", "low_model", "vae_name", "clip_name", "high_lora", "low_lora"]],
	["提示词补充", ["extra_instruction", "negative_prompt"]],
	["长视频衔接", ["prev_segment_ref_frames", "use_prev_segment_latent"]],
];
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
];
const HIDDEN_WIDGETS = new Set(SETTINGS_GROUPS.flatMap(([, names]) => names).concat(["prompt", "translation_enabled", "keep_model", "randomize_seed", "resize_to_panel"]));
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
];
const LEGACY_BACKEND_WIDGETS = BACKEND_WIDGETS.slice(0, -1);
const OLDER_BACKEND_WIDGETS = BACKEND_WIDGETS.slice(0, -2);
const DEFAULT_VALUES = {
	prompt: "Remove subtitles and watermarks while preserving the original scene, motion, lighting, and identity.",
	extra_instruction: "",
	negative_prompt: "bad video",
	mode: "auto",
	width: 832,
	height: 480,
	length: 81,
	batch_size: 1,
	steps: 6,
	high_steps: 3,
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
	vae_tiling: false,
	tile_x: 272,
	tile_y: 272,
	high_model: "Wan22_Bernini_HIGH_fp8_e4m3fn_scaled.safetensors",
	low_model: "Wan22_Bernini_LOW_fp8_e4m3fn_scaled.safetensors",
	vae_name: "wan_2.1_vae.safetensors",
	clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
	high_lora: "wan\\wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors",
	low_lora: "wan\\wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors",
	translation_enabled: false,
	segment_frames: 81,
	keep_model: true,
	prev_segment_ref_frames: 1,
	randomize_seed: false,
	resize_to_panel: true,
	use_prev_segment_latent: false,
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
	mode: new Set(["auto", "T2I", "T2V", "I2I", "R2I", "I2V", "V2V", "R2V", "VI2V", "RV2V", "ADS2V", "VRC2V", "MV2V"]),
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
};
const MODE_DEFAULT_VALUES = {
	T2I: { steps: 20, high_steps: 10 },
};

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function value(node, name, fallback = "") {
	return widget(node, name)?.value ?? fallback;
}

function setValue(node, name, nextValue) {
	const target = widget(node, name);
	if (!target) return;
	target.value = nextValue;
	if (target.inputEl && "value" in target.inputEl) target.inputEl.value = nextValue;
	if (target.element && "value" in target.element) target.element.value = nextValue;
	target.callback?.(nextValue, app.canvas, node, undefined, target);
	const panelControl = node.__gjjBerniniPanel?.controls?.get?.(name);
	if (panelControl && document.activeElement !== panelControl) {
		if (panelControl.type === "checkbox") panelControl.checked = Boolean(nextValue);
		else panelControl.value = String(nextValue ?? "");
	}
	node.graph?.change?.();
	GJJ_Utils.dirtyCanvas(node);
	if (name === "mode" || name === "length") {
		updateGenerateButton(node);
		updateModeButtons(node);
	}
	if (name === "keep_model") updateKeepModelButton(node);
	if (name === "randomize_seed") updateRandomizeSeedButton(node);
	if (name === "resize_to_panel") updateResizeButton(node);
}

function applyModeDefaults(node, mode) {
	const modeName = String(mode || "").toUpperCase();
	if (modeName === "T2I") {
		if (Number(value(node, "steps", DEFAULT_VALUES.steps)) === 6 && Number(value(node, "high_steps", DEFAULT_VALUES.high_steps)) === 3) {
			setValue(node, "steps", 20);
			setValue(node, "high_steps", 10);
		}
		return;
	}
	if (modeName === "I2V" && Number(value(node, "steps", DEFAULT_VALUES.steps)) === 20 && Number(value(node, "high_steps", DEFAULT_VALUES.high_steps)) === 10) {
		setValue(node, "steps", 6);
		setValue(node, "high_steps", 3);
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
		values[name] = normalizeValue(name, widget(node, name)?.value);
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
			const nextValue = normalizeValue(name, values[name]);
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
	const values = collectValues(node);
	node.properties ||= {};
	node.properties[VALUES_PROPERTY] = { ...values };
	if (serializedNode) {
		serializedNode.properties ||= {};
		serializedNode.properties[VALUES_PROPERTY] = { ...values };
	}
}

function protect(element) {
	if (!element || element.__gjjBerniniProtected) return;
	element.__gjjBerniniProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation(), true);
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

function mediaInputState(node) {
	const sourceKind = linkedInputKind(node, "source_media");
	const refKinds = [
		linkedInputKind(node, "reference_media_1"),
		linkedInputKind(node, "reference_media_2"),
	].filter(Boolean);
	return {
		sourceKind,
		refKinds,
		hasSource: Boolean(sourceKind),
		hasImageRefs: refKinds.includes("image"),
		hasVideoRefs: refKinds.includes("video"),
		hasRefs: refKinds.length > 0,
	};
}

function modeButtonsForInputs(node) {
	const state = mediaInputState(node);
	if (!state.hasSource && !state.hasRefs) return ["T2I", "T2V"];
	if (!state.hasSource) return state.hasImageRefs ? ["R2I", "R2V"] : ["R2V"];
	if (state.sourceKind === "image") {
		if (state.hasRefs) return ["R2I", "R2V"];
		return ["I2I", "I2V"];
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
	button.title = enabled ? "保持模型：开启，复用已加载模型" : "保持模型：关闭，每次重新加载模型";
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
	button.title = enabled ? "按面板尺寸：开启，按宽高缩放裁剪" : "按面板尺寸：关闭，优先沿用源媒体尺寸";
	button.classList.toggle("active", enabled);
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
	const others = node.inputs.filter((input) => !selected.includes(input));
	node.inputs = [...selected, ...others];
}

function widgetChoices(target) {
	let choices = target?.options?.values || target?.options?.items || target?.values;
	if (typeof choices === "function") {
		try { choices = choices(); } catch (_) { choices = []; }
	}
	return Array.isArray(choices) ? choices.map(String) : [];
}

function makeControl(node, name) {
	const target = widget(node, name);
	if (!target) return null;
	const choices = widgetChoices(target);
	let control;
	if (typeof target.value === "boolean") {
		control = document.createElement("input");
		control.type = "checkbox";
		control.checked = Boolean(target.value);
		control.addEventListener("change", () => setValue(node, name, control.checked));
	} else if (choices.length) {
		control = document.createElement("select");
		for (const choice of choices) {
			const option = document.createElement("option");
			option.value = choice;
			option.textContent = choice;
			control.appendChild(option);
		}
		control.value = String(target.value ?? "");
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
	protect(control);
	return control;
}

function buildSettings(node) {
	const settings = document.createElement("div");
	settings.className = "gjj-bs-settings";
	const controls = new Map();
	for (const [title, names] of SETTINGS_GROUPS) {
		const section = document.createElement("section");
		const heading = document.createElement("div");
		heading.className = "gjj-bs-heading";
		heading.textContent = title;
		section.appendChild(heading);
		const grid = document.createElement("div");
		grid.className = "gjj-bs-grid";
		for (const name of names) {
			const control = makeControl(node, name);
			if (!control) continue;
			controls.set(name, control);
			const row = document.createElement("label");
			row.className = control.tagName === "TEXTAREA" ? "gjj-bs-field wide" : "gjj-bs-field";
			const label = document.createElement("span");
			label.textContent = widget(node, name)?.options?.display_name || widget(node, name)?.label || name;
			row.append(label, control);
			grid.appendChild(row);
		}
		section.appendChild(grid);
		settings.appendChild(section);
	}
	return { settings, controls };
}

function createPanel(node) {
	if (node.__gjjBerniniPanel || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div");
	root.className = "gjj-bs-root";
	protect(root);
	const style = document.createElement("style");
	style.textContent = `
		.gjj-bs-root,.gjj-bs-root *{box-sizing:border-box}.gjj-bs-root{display:flex;flex-direction:column;gap:7px;width:100%;padding:2px 0 4px;font:12px/1.4 system-ui;color:#dce7e9;pointer-events:auto}
		.gjj-bs-toolbar{display:flex;flex-wrap:wrap;gap:6px;width:100%;align-items:center}.gjj-bs-button{min-height:32px;border-radius:6px;border:1px solid #50616a;color:#e8f0f2;font-weight:700;cursor:pointer;padding:0 10px;white-space:normal;line-height:1.15}
		.gjj-bs-generate{flex:0 0 auto;min-width:116px;padding:0 12px;background:linear-gradient(135deg,#075a45,#0b9b70);border-color:#24c68b}.gjj-bs-translate,.gjj-bs-seed,.gjj-bs-cache,.gjj-bs-vars,.gjj-bs-settings-button,.gjj-bs-link,.gjj-bs-resize{flex:0 0 38px;padding:0;background:linear-gradient(135deg,#28323a,#3e4b55)}
		.gjj-bs-vars{border-color:#d6a642;color:#ffe8a3}.gjj-bs-settings-button{border-color:#24c68b}.gjj-bs-button:hover{filter:brightness(1.18);transform:translateY(-1px)}.gjj-bs-button.active{background:linear-gradient(135deg,#164d3c,#287b59);border-color:#61c994}
		.gjj-bs-prompt-field{display:flex;flex-direction:column;gap:4px;color:#b9c8cc}.gjj-bs-prompt-head{display:flex;align-items:center;gap:6px;width:100%;min-width:0}.gjj-bs-prompt-title{flex:0 0 auto;white-space:nowrap}.gjj-bs-prompt{min-height:58px;resize:vertical}
		.gjj-bs-mode-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}.gjj-bs-mode-button{flex:0 0 auto;min-height:20px;padding:0 7px;border-radius:5px;font-size:11px;background:#18242a;border-color:#3c5058;color:#d7e4e7}
		.gjj-bs-settings{display:none;flex-direction:column;gap:9px;padding:8px;border:1px solid #41535b;border-radius:8px;background:#11191d}.gjj-bs-settings.open{display:flex}
		.gjj-bs-heading{font-weight:800;color:#9ed6df;margin-bottom:5px}.gjj-bs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.gjj-bs-field{display:flex;align-items:center;gap:6px;min-width:0}.gjj-bs-field.wide{grid-column:1/-1;align-items:flex-start;flex-direction:column}.gjj-bs-field>span{flex:0 0 78px;color:#aebbc0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.gjj-bs-control{flex:1;min-width:0;width:100%;border:1px solid #40515a;border-radius:5px;background:#0e1519;color:#eaf2f3;padding:5px 7px}.gjj-bs-control[type=checkbox]{flex:0 0 auto;width:18px;height:18px}.gjj-bs-control:is(textarea){min-height:64px;resize:vertical}
		.gjj-bs-preview-wrap{display:flex;flex-direction:column;gap:5px;width:100%}.gjj-bs-preview-status{color:#92a7ad;font-size:11px}.gjj-bs-preview{display:none;width:100%;height:auto;object-fit:contain;border:1px solid #334850;border-radius:8px;background:#0b1114}
	`;
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-bs-toolbar";
	const generate = makeButton("🎬 生成视频", "只执行当前 Bernini 节点并生成视频", "gjj-bs-generate", async () => {
		const old = generate.innerHTML;
		generate.innerHTML = "⏳ 执行中";
		generate.disabled = true;
		try {
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
	const keepModel = makeButton("🧠", "保持模型：开启，复用已加载模型", "gjj-bs-cache", () => {
		setValue(node, "keep_model", !Boolean(value(node, "keep_model", DEFAULT_VALUES.keep_model)));
	});
	const resize = makeButton("📐", "按面板尺寸：开启，按宽高缩放裁剪", "gjj-bs-resize", () => {
		setValue(node, "resize_to_panel", !Boolean(value(node, "resize_to_panel", DEFAULT_VALUES.resize_to_panel)));
	});
	const mediaLink = makeButton("🔗", "记住并断开/恢复媒体输入连接", "gjj-bs-link", () => {
		toggleMediaLinks(node);
	});
	const templateSource = createTemplateSourceButton(node, TEMPLATE_SOURCE_FIELDS, []);
	templateSource.classList.add("gjj-bs-button", "gjj-bs-vars");
	templateSource.textContent = "⚡";
	templateSource.title = "从 GJJ_TemplateParams / GJJ_SETNODE / 变量读取系统选择 Bernini 参数来源";
	templateSource.style.width = "38px";
	templateSource.style.flex = "0 0 38px";
	templateSource.style.padding = "0";
	const settingsButton = makeButton("⚙️", "展开或收起参数", "gjj-bs-settings-button", () => {
		node.properties ||= {};
		node.properties[SETTINGS_PROPERTY] = !Boolean(node.properties[SETTINGS_PROPERTY]);
		syncPanel(node);
	});
	toolbar.append(generate, translate, seed, keepModel, resize, mediaLink, templateSource, settingsButton);
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
	promptHead.append(promptLabel, modeButtons);
	promptField.append(promptHead, prompt);
	const settingsState = buildSettings(node);
	root.append(style, toolbar, promptField, settingsState.settings);
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
		settings: settingsState.settings,
		controls: settingsState.controls,
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
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
	if (state.templateSource) {
		state.templateSource.textContent = "⚡";
		state.templateSource.style.width = "38px";
		state.templateSource.style.flex = "0 0 38px";
		state.templateSource.style.padding = "0";
		state.templateSource.classList.add("gjj-bs-vars");
	}
	updateGenerateButton(node);
	updateModeButtons(node);
	updateKeepModelButton(node);
	updateRandomizeSeedButton(node);
	updateResizeButton(node);
	updateMediaLinkButton(node);
	const open = Boolean(node.properties?.[SETTINGS_PROPERTY]);
	state.settings.classList.toggle("open", open);
	state.settingsButton.classList.toggle("active", open);
	state.translate.classList.toggle("active", Boolean(node.properties?.[TRANSLATE_PROPERTY] || value(node, "translation_enabled", false)));
	if (document.activeElement !== state.prompt) {
		state.prompt.value = String(value(node, "prompt", ""));
	}
	const sources = selectedTemplateSources(node);
	for (const [name, control] of state.controls || []) {
		if (!control || document.activeElement === control) continue;
		const current = value(node, name, DEFAULT_VALUES[name]);
		if (control.type === "checkbox") control.checked = Boolean(current);
		else control.value = String(current ?? "");
		const controlled = Boolean(String(sources[name] || "").trim());
		control.disabled = controlled;
		control.style.opacity = controlled ? "0.52" : "";
		control.title = controlled ? `参数已由变量 ${sources[name]} 接管` : (widget(node, name)?.options?.tooltip || widget(node, name)?.tooltip || name);
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
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
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
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass) === NODE_TYPE) stabilize(node);
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
	getCachedModelFamilyPresets,
	getModelFamilyPresets,
} from "./gjj_model_family_preset_table.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { createTemplateSourceButton, updateTemplateSourcePanel } from "./gjj_generation_template_sources.js";

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

const EXECUTE_BUTTON_NAME = "__gjj_execute_button";
const IMAGE_PREVIEW_NAME = "__gjj_image_preview";
const LORA_CHAIN_CONFIG_INPUT = "lora_chain_config";
const LORA_DATA_WIDGET_NAME = "lora_data";
const SETTINGS_OPEN_PROPERTY = "gjj_lazy_image_studio_settings_open";
const PARAM_VALUES_PROPERTY = "gjj_lazy_image_studio_param_values";
const IMAGE_SIZE_SIGNATURE_PROPERTY = "gjj_lazy_image_studio_image_size_signature";
const ALWAYS_VISIBLE_WIDGETS = new Set(["prompt"]);
const ALWAYS_HIDDEN_WIDGETS = new Set([BATCH_SOURCE_WIDGET, LORA_DATA_WIDGET_NAME]);
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
	node.imgs = null;
	node.images = null;
	node.imageIndex = null;
	node.overIndex = null;
}

function scheduleNativePreviewClear(node) {
	clearNativePreview(node);
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => clearNativePreview(node));
	}
	setTimeout(() => clearNativePreview(node), 80);
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
};
const SEED_CONTROL_KEY = "__seed_control_after_generate";
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const MAX_SEED_VALUE = 0xFFFFFFFFFFFFFFFF;
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
];
const DEFAULT_PARAM_VALUES = {
	prompt: "",
	negative_prompt: "",
	main_image_index: 1,
	width: 1024,
	height: 1024,
	batch_size: 1,
	unet_name: "",
	unet_dtype: "default",
	clip_name1: "",
	vae_name: "default",
	seed: 0,
	[SEED_CONTROL_KEY]: "randomize",
	steps: 4,
	cfg: 1.0,
	sampler_name: "euler",
	scheduler: "simple",
	denoise: 1.0,
	grow_mask_by: 6,
	[BATCH_SOURCE_WIDGET]: "[]",
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

function installModelHelpProvider(node) {
	if (!node || node.__gjjLazyModelHelpProviderInstalled) {
		return;
	}
	node.__gjjLazyModelHelpProviderInstalled = true;
	node.__gjjHelpModelTreeEntries = function () {
		const entries = [];
		const pushWidgetModel = (name, label, folder, kind, tooltip) => {
			const value = widgetValue(this, name);
			if (!value) {
				return;
			}
			entries.push({ label, value, folder, kind, name, tooltip });
		};
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
		return entries;
	};
}

function setWidgetValue(widget, value) {
	if (!widget || value === undefined || value === null) {
		return;
	}
	widget.value = value;
	if (widget.inputEl) {
		widget.inputEl.value = String(value);
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = value;
	}
	widget.callback?.(value);
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
	widget.disabled = Boolean(state.disabled);
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
	if (state.optionsHidden === undefined) delete widget.options.hidden;
	else widget.options.hidden = state.optionsHidden;
	if (state.optionsDisplay === undefined) delete widget.options.display;
	else widget.options.display = state.optionsDisplay;
	if (widget.element) widget.element.style.display = state.elementDisplay || "";
	if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
	if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
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

function updateSettingsButtonState(node) {
	const button = node?.__gjjSettingsButton;
	if (!button) {
		return;
	}
	const open = settingsOpen(node);
	button.textContent = open ? "⚙️收起" : "⚙️设置";
	button.title = open ? "收起更多设置，只保留正向提示词。" : "展开更多设置，显示反向提示词、模型、尺寸、采样和 LoRA。";
	button.classList.toggle("on", open);
	button.style.background = open ? "linear-gradient(135deg, #4b5563, #64748b)" : "linear-gradient(135deg, #1f2933, #374151)";
	button.style.borderColor = open ? "#94a3b8" : "#55636f";
	button.style.color = open ? "#ffffff" : "#e5edf2";
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
		if (widget === node.__gjjLoraWidget) return settingsOpen(node) ? 80 : 900;
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
	const open = settingsOpen(node);
	for (const name of PANEL_SYNC_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget || ALWAYS_HIDDEN_WIDGETS.has(name)) {
			continue;
		}
		setLazyWidgetHidden(widget, !open && !ALWAYS_VISIBLE_WIDGETS.has(name));
	}
	setDomWidgetHidden(node.__gjjLoraWidget, node.__gjjLoraContainer, !open);
	updateSettingsButtonState(node);
	orderLazyWidgets(node);
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
	GJJ_Utils.refreshNode(node);
}

function setSettingsOpen(node, open) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	node.properties[SETTINGS_OPEN_PROPERTY] = Boolean(open);
	applySettingsVisibility(node);
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
		return textValue(findSeedControlWidget(node)?.value) || DEFAULT_PARAM_VALUES[SEED_CONTROL_KEY];
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
	if (name === "unet_name" || name === "clip_name1" || name === "vae_name") {
		return text === "default" || /\.(safetensors|pt|pth|ckpt|bin|gguf)$/i.test(text);
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
	return String(value ?? fallbackParamValue(node, name) ?? "");
}

function snapshotParamValues(source, node) {
	if (!source || typeof source !== "object") {
		return null;
	}
	const params = {};
	let found = false;
	for (const name of SERIALIZED_PARAM_WIDGETS) {
		if (name === SEED_CONTROL_KEY && !shouldSerializeSeedControl(node)) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(source, name)) {
			params[name] = coerceParamValue(name, source[name], node);
			found = true;
		}
	}
	return found ? params : null;
}

function currentParamValues(node) {
	const params = {};
	for (const name of SERIALIZED_PARAM_WIDGETS) {
		if (name === SEED_CONTROL_KEY) {
			if (shouldSerializeSeedControl(node)) {
				params[name] = fallbackParamValue(node, name);
			}
			continue;
		}
		params[name] = coerceParamValue(name, getWidget(node, name)?.value, node);
	}
	return params;
}

function scoreSequentialParams(rawValues, offset, withSeedControl, node) {
	const raw = Array.isArray(rawValues) ? rawValues : [];
	const names = SERIALIZED_PARAM_WIDGETS.filter((name) => withSeedControl || name !== SEED_CONTROL_KEY);
	if (offset < 0 || offset + names.length > raw.length + 1) {
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
	if (offset === 0) score += 1;
	return score;
}

function buildSequentialParams(rawValues, offset, withSeedControl, node) {
	const names = SERIALIZED_PARAM_WIDGETS.filter((name) => withSeedControl || name !== SEED_CONTROL_KEY);
	const params = {};
	for (const name of names) {
		params[name] = coerceParamValue(name, rawValues[offset + names.indexOf(name)], node);
	}
	if (shouldSerializeSeedControl(node) && !Object.prototype.hasOwnProperty.call(params, SEED_CONTROL_KEY)) {
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
		return fromProperties;
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
		return buildSequentialParams(raw, best.offset, best.withSeedControl, node);
	}
	return snapshotParamValues(currentParamValues(node), node) || {};
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
		if (!widget || widget.value === params[name]) {
			continue;
		}
		setWidgetValue(widget, params[name]);
		changed = true;
	}
	const seedControlWidget = findSeedControlWidget(node);
	if (seedControlWidget && Object.prototype.hasOwnProperty.call(params, SEED_CONTROL_KEY) && seedControlWidget.value !== params[SEED_CONTROL_KEY]) {
		seedControlWidget.value = params[SEED_CONTROL_KEY];
		seedControlWidget.callback?.(seedControlWidget.value);
		changed = true;
	}
	return changed;
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
	let best = "";
	let bestScore = -1;
	for (const candidate of list) {
		const candidateBase = candidate.split(/[\\/]/).pop() || candidate;
		const candidateCanonical = canonicalizeText(candidateBase);
		const fullCanonical = canonicalizeText(candidate);
		let score = -1;
		if (candidate === wanted || candidateBase === wantedBase) {
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
	return best || list[0] || wanted;
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
		return;
	}
	const primary = getInput(node, PRIMARY_IMAGE_INPUT);
	const linkId = primary?.link;
	if (!linkId || !app.graph?.links) {
		widget.value = "[]";
		return;
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	if (sourceNode?.comfyClass !== "GJJ_MultiImageLoader" || Number(link?.origin_slot) !== 0) {
		widget.value = "[]";
		return;
	}
	widget.value = buildMultiLoaderSelectionPayload(sourceNode);
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
	applyEffectiveParamsToPanel(node, values, true);
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
	} finally {
		node.__gjjLazyImageSizeSyncRunning = false;
	}
}

function createButtons(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:row",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const sharedButtonStyle = [
		"height:32px",
		"padding:0 10px",
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
		"white-space:nowrap",
		"min-width:0",
	];

	// 刷新Lora按钮
	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.innerHTML = "🔄 刷新LoRA";
	refreshButton.title = "刷新LoRA选项列表";
	refreshButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #3b82f6",
		"background:linear-gradient(135deg, #1e3a5f, #1e40af)",
		"color:#e0e7ff",
		"flex:1",
	].join(";");

	// 生成图片按钮
	const generateButton = document.createElement("button");
	generateButton.type = "button";
	generateButton.innerHTML = "✨ 生成图片";
	generateButton.title = "只执行当前节点，无需连接其他节点";
	generateButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #10b981",
		"background:linear-gradient(135deg, #064e3b, #059669)",
		"color:#a7f3d0",
		"flex:1",
	].join(";");

	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.textContent = "⚙️设置";
	settingsButton.title = "展开更多设置";
	settingsButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #55636f",
		"background:linear-gradient(135deg, #1f2933, #374151)",
		"color:#e5edf2",
		"flex:0 0 74px",
	].join(";");
	node.__gjjSettingsButton = settingsButton;
	const templateButton = createTemplateSourceButton(node, TEMPLATE_SOURCE_FIELDS, sharedButtonStyle);

	// 按钮悬停效果函数
	function setupButtonHover(btn, defaultBg, hoverBg) {
		btn.addEventListener("mouseenter", () => {
			if (btn === settingsButton && settingsOpen(node)) {
				return;
			}
			btn.style.background = hoverBg;
			btn.style.transform = "translateY(-1px)";
		});

		btn.addEventListener("mouseleave", () => {
			if (btn === settingsButton && settingsOpen(node)) {
				btn.style.transform = "translateY(0)";
				updateSettingsButtonState(node);
				return;
			}
			btn.style.background = defaultBg;
			btn.style.transform = "translateY(0)";
		});

		btn.addEventListener("mousedown", () => {
			btn.style.transform = "translateY(0) scale(0.98)";
		});

		btn.addEventListener("mouseup", () => {
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

	// 刷新LoRA按钮
	async function handleRefresh(event) {
		protectEvent(event);
		console.log("[GJJ] 刷新Lora按钮被点击", node?.id, node?.comfyClass);

		const originalText = refreshButton.innerHTML;
		refreshButton.innerHTML = "⏳ 刷新中";
		refreshButton.disabled = true;
		refreshButton.style.opacity = "0.7";

		try {
			await refreshLoraOptions(node, true);
			refreshButton.innerHTML = "✅ 已刷新";
			refreshButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
			refreshButton.style.borderColor = "#10b981";
		} catch (error) {
			console.error("[GJJ] 刷新LoRA时发生错误:", error);
			refreshButton.innerHTML = "❌ 失败";
			refreshButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			refreshButton.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				refreshButton.innerHTML = originalText;
				refreshButton.disabled = false;
				refreshButton.style.opacity = "1";
				refreshButton.style.background = "linear-gradient(135deg, #1e3a5f, #1e40af)";
				refreshButton.style.borderColor = "#3b82f6";
			}, 1000);
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
			const ok = await queueOnlyCurrentNode(node);
			if (!ok) {
				console.warn("[GJJ] 当前节点执行失败：queueOnlyCurrentNode 返回 false");
				generateButton.innerHTML = "❌ 执行失败";
				generateButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
				generateButton.style.borderColor = "#ef4444";
			} else {
				generateButton.innerHTML = "✅ 执行中";
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

	function handleSettings(event) {
		protectEvent(event);
		setSettingsOpen(node, !settingsOpen(node));
	}

	setupButtonHover(refreshButton, "linear-gradient(135deg, #1e3a5f, #1e40af)", "linear-gradient(135deg, #1e40af, #3b82f6)");
	setupButtonHover(generateButton, "linear-gradient(135deg, #064e3b, #059669)", "linear-gradient(135deg, #059669, #10b981)");
	setupButtonHover(settingsButton, "linear-gradient(135deg, #1f2933, #374151)", "linear-gradient(135deg, #374151, #4b5563)");
	setupButtonEvents(refreshButton, handleRefresh);
	setupButtonEvents(generateButton, handleGenerate);
	setupButtonEvents(settingsButton, handleSettings);
	updateSettingsButtonState(node);

	container.appendChild(refreshButton);
	container.appendChild(generateButton);
	container.appendChild(templateButton);
	container.appendChild(settingsButton);
	return container;
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

	const image = document.createElement("img");
	// 给自定义预览添加标记，避免被隐藏
	image.dataset.gjjCustomPreview = "true";
	image.style.cssText = [
		"width:100%",
		"max-width:100%",
		"height:auto",
		"object-fit:contain",
		"display:none",
		"cursor:pointer",
		"border-radius:8px",
		"border:1px solid #33434a",
		"background:#0f1418",
		"pointer-events:auto",
		"position:relative",
		"z-index:100",
		"transition:transform 0.2s ease",
	].join(";");

	// 鼠标悬停效果
	image.addEventListener("mouseenter", () => {
		image.style.transform = "scale(1.02)";
	});
	image.addEventListener("mouseleave", () => {
		image.style.transform = "scale(1)";
	});
	image.addEventListener("load", () => {
		node.__gjjLazyPreviewNaturalWidth = Number(image.naturalWidth || 0);
		node.__gjjLazyPreviewNaturalHeight = Number(image.naturalHeight || 0);
		node.__gjjLazyPreviewHeight = lazyPreviewHeightForNode(node);
		GJJ_Utils.refreshNode(node);
	});

	// 图片点击放大功能 - 完全参考批量多图片加载器
	image.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();

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
		previewImg.src = image.src;
		previewImg.style.cssText = [
			"max-width:90%",
			"max-height:90%",
			"object-fit:contain",
			"border-radius:8px",
			"box-shadow:0 0 40px rgba(0, 0, 0, 0.5)",
			"transition:transform 0.1s ease",
			"cursor:grab",
		].join(";");

		// 滚轮缩放功能
		let currentScale = 1;
		const minScale = 0.1;
		const maxScale = 10;

		overlay.addEventListener("wheel", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			currentScale = Math.max(minScale, Math.min(maxScale, currentScale + delta));
			previewImg.style.transform = `scale(${currentScale})`;
		});

		// 双击重置缩放
		previewImg.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			currentScale = 1;
			previewImg.style.transform = `scale(${currentScale})`;
		});

		const closeHint = document.createElement("div");
		closeHint.textContent = "滚轮缩放 · 双击重置 · 点击关闭";
		closeHint.style.cssText = [
			"position:absolute",
			"bottom:20px",
			"left:50%",
			"transform:translateX(-50%)",
			"color:#fff",
			"font-size:13px",
			"opacity:0.6",
			"pointer-events:none",
			"white-space:nowrap",
		].join(";");

		overlay.appendChild(previewImg);
		overlay.appendChild(closeHint);
		document.body.appendChild(overlay);

		// 点击关闭
		overlay.addEventListener("click", () => {
			overlay.remove();
		});
	});

	container.appendChild(image);

	node.__gjjPreviewImage = image;
	return container;
}

function imageDataToUrl(item) {
	if (!item?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function updateImagePreview(node, images) {
	if (!node.__gjjPreviewImage) return;

	if (!images || !images.length) {
		node.__gjjPreviewImage.style.display = "none";
		node.__gjjLazyPreviewHeight = 0;
		return;
	}

	const imageUrl = imageDataToUrl(images[0]);
	node.__gjjPreviewImage.src = imageUrl;
	// 确保自定义预览图的样式完全正常！
	node.__gjjPreviewImage.style.display = "block";
	node.__gjjPreviewImage.style.visibility = "visible";
	node.__gjjPreviewImage.style.height = "auto";
	node.__gjjPreviewImage.style.width = "100%";
	node.__gjjPreviewImage.style.margin = "";
	node.__gjjPreviewImage.style.padding = "";
	node.__gjjPreviewImage.style.opacity = "";
	node.__gjjPreviewImage.style.position = "";
	node.__gjjPreviewImage.style.left = "";

	// 刷新节点尺寸
	GJJ_Utils.refreshNode(node);
}

function lazyPreviewHeightForNode(node, width = null) {
	const image = node?.__gjjPreviewImage;
	if (!image || image.style.display === "none") {
		return 0;
	}
	const naturalWidth = Number(image.naturalWidth || node.__gjjLazyPreviewNaturalWidth || 0);
	const naturalHeight = Number(image.naturalHeight || node.__gjjLazyPreviewNaturalHeight || 0);
	if (naturalWidth <= 0 || naturalHeight <= 0) {
		return Number(node.__gjjLazyPreviewHeight || 0);
	}
	const contentWidth = Math.max(0, Math.round(Number(width || node?.size?.[0] || 320) - 20));
	return Math.max(0, Math.ceil(contentWidth * naturalHeight / naturalWidth) + 8);
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
	let best = null;
	let bestLength = -1;
	for (const preset of MODEL_PRESETS) {
		for (const keyword of preset.keywords || []) {
			const normalizedKeyword = normalizeText(keyword);
			const canonicalKeyword = canonicalizeText(keyword);
			if (
				(normalized.includes(normalizedKeyword) || (canonicalKeyword && canonical.includes(canonicalKeyword))) &&
				(canonicalKeyword || normalizedKeyword).length > bestLength
			) {
				best = preset;
				bestLength = (canonicalKeyword || normalizedKeyword).length;
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
	if (!hasPresetLora) {
		clearPresetLoras(node);
	}
	if (!force && node.properties[LAST_PRESET_KEY] === currentUnet) {
		return;
	}
	const clipWidget = getWidget(node, "clip_name1");
	const vaeWidget = getWidget(node, "vae_name");
	const clipValues = Array.isArray(clipWidget?.options?.values) ? clipWidget.options.values : [];
	const vaeValues = Array.isArray(vaeWidget?.options?.values) ? vaeWidget.options.values : [];

	setWidgetValue(clipWidget, preferredValue(clipValues, (preset.clipNames || [])[0] || ""));
	setWidgetValue(vaeWidget, preferredValue(vaeValues, preset.vaeName || ""));
	if (Number.isFinite(preset.steps)) {
		setWidgetValue(getWidget(node, "steps"), Number(preset.steps));
	}
	if (Number.isFinite(preset.cfg)) {
		setWidgetValue(getWidget(node, "cfg"), Number(preset.cfg));
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
	if (hasPresetLora) {
		if (preset.lora1 && String(preset.lora1).trim()) {
			newLoraRows.push({
				enabled: preset.lora1AutoEnabled !== false,
				name: String(preset.lora1),
				strength: normalizeStrength(preset.lora1Strength, 1.0),
			});
		}
		if (preset.lora2 && String(preset.lora2).trim()) {
			newLoraRows.push({
				enabled: true,
				name: String(preset.lora2),
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
		}));
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
	};
	return node.__gjjLoraState;
}

function updateLoraNodeHeight(node, rowCount) {
	const baseHeight = 78;
	const rowHeight = 50;
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
	const normalized = rows.filter((item, index) => item.name || index < rows.length - 1);
	if (normalized.length === 0 || normalized[normalized.length - 1].name) {
		normalized.push({ ...DEFAULT_ROW });
	}
	state.rows = normalized.map((item) => ({
		enabled: item.enabled !== false,
		name: String(item.name || ""),
		strength: normalizeStrength(item.strength, 1.0),
	}));
}

function getDefaultSearchValue(index) {
	return index === 0 ? DEFAULT_FIRST_SEARCH_TERMS : "";
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
		min-width: max(100%, 420px);
		max-width: 680px;
		width: max-content;
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
			const targetWidth = Math.min(
				Math.max(Math.ceil(rect?.width || 420), 420),
				Math.max(320, viewportWidth - horizontalPadding * 2),
				680,
			);
			const spaceBelow = Math.max(120, viewportHeight - Math.ceil(rect?.bottom || 0) - verticalPadding - 6);
			const spaceAbove = Math.max(120, Math.floor(rect?.top || 0) - verticalPadding - 6);
			const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
			const panelMaxHeight = Math.max(180, Math.min(420, openAbove ? spaceAbove : spaceBelow));
			const listMaxHeight = Math.max(96, panelMaxHeight - 52);
			const rawLeft = Math.floor(rect?.left || horizontalPadding);
			const left = Math.max(horizontalPadding, Math.min(rawLeft, viewportWidth - targetWidth - horizontalPadding));

			panel.style.width = `${targetWidth}px`;
			panel.style.maxWidth = `${Math.max(320, viewportWidth - horizontalPadding * 2)}px`;
			panel.style.maxHeight = `${panelMaxHeight}px`;
			list.style.maxHeight = `${listMaxHeight}px`;
			panel.style.left = `${left}px`;

			if (openAbove) {
				panel.style.top = "auto";
				panel.style.bottom = `${Math.max(verticalPadding, viewportHeight - Math.floor(rect?.top || 0) + 6)}px`;
			} else {
				panel.style.bottom = "auto";
				panel.style.top = `${Math.max(verticalPadding, Math.ceil(rect?.bottom || verticalPadding) + 6)}px`;
			}
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
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-lora-popup-item";
				item.style.cssText = [
					"pointer-events:auto",
					"user-select:none",
				].join(";");
				const isSelected = String(option.value || "") === selectedValue;
				if (isSelected) {
					item.classList.add("selected");
					item.textContent = `✔ ${option.label}`;
				} else {
					item.textContent = option.label;
				}

				function runItemClick(event) {
					event.preventDefault();
					event.stopPropagation();
					console.log("[GJJ] LoRA 弹出窗口选项被点击", option.value);
					popup.state?.onSelect?.(String(option.value || ""));
				}

				// 根据指南：在 mousedown 和 pointerdown 上只阻止冒泡
				for (const eventName of ["pointerdown", "mousedown"]) {
					item.addEventListener(eventName, (event) => event.stopPropagation(), true);
				}

				// 在 pointerup 和 click 上处理点击逻辑
				for (const eventName of ["pointerup", "click"]) {
					item.addEventListener(eventName, runItemClick, true);
				}

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
		popup.open({
			node,
			anchorEl: picker,
			searchValue: getDefaultSearchValue(index),
			placeholder: index === 0 ? "首槽默认加速关键词" : "搜索",
			searchTitle: "输入关键词筛选当前这一行可选的 LoRA 文件名；不区分大小写。语法：& 表示与，, 或 | 表示或。示例：flux & turbo,lightning,hyper",
			onSearchChange(searchValue) {
				// 不保存每行搜索，避免与原来的实现冲突
			},
			getSelectedValue() {
				return String(state.rows[index]?.name || "");
			},
			getOptions(searchText) {
				let options = state.options;
				if (state.rows[index]?.name && !options.some((option) => option.value === state.rows[index].name)) {
					options = [...options, { value: state.rows[index].name, label: state.rows[index].name }];
				}
				if (!searchText) {
					return options;
				}
				const terms = searchText.toLowerCase().split(/[,\s]+/).filter(Boolean);
				return options.filter((opt) => {
					if (!opt.value) return true;
					const lowerValue = opt.value.toLowerCase();
					return terms.every((term) => lowerValue.includes(term));
				});
			},
			onSelect(value) {
				state.rows[index].name = value;
				ensureTrailingEmptyRow(node);
				updateLoraDataWidget(node);
				popup.close();
				renderLoraUi(node);
			},
		});
	}

	// 根据指南：在多个事件类型上绑定，使用捕获阶段确保不被 canvas 拦截
	for (const eventName of ["pointerup", "click"]) {
		picker.addEventListener(eventName, runPickerClick, true);
	}

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

	ensureTrailingEmptyRow(node);
	rowsContainer.replaceChildren();
	state.rows.forEach((row, index) => buildLoraRow(node, row, index, rowsContainer));
	updateLoraNodeHeight(node, state.rows.length);
	updateLoraDataWidget(node);
}

async function refreshLoraOptions(node, rerender = true) {
	const state = ensureLoraNodeState(node);
	state.options = await fetchLoraOptions();
	if (rerender) {
		renderLoraUi(node);
	}
}



function setupLoraUi(node) {
	if (node.__gjjLoraContainer) {
		return;
	}

	// 初始化 state
	ensureLoraNodeState(node).rows = normalizeRows(readStoredLoraData(node));

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
		.gjj-lora-refresh { padding:2px 8px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; }
		.gjj-lora-rows { display:flex; flex-direction:column; gap:6px; }
		.gjj-lora-row { display:flex; align-items:flex-start; gap:6px; padding:6px; border:1px solid #3c4c54; border-radius:8px; background:#172026; }
		.gjj-lora-row.off { opacity:0.65; }
		.gjj-lora-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; position:relative; }
		.gjj-lora-picker { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 8px; box-sizing:border-box; text-align:left; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:auto; }
		.gjj-lora-popup { display:none; flex-direction:column; gap:6px; position:absolute; top:calc(100% + 6px); left:0; min-width:max(100%, 420px); max-width:680px; width:max-content; padding:6px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-sizing:border-box; z-index:9999; box-shadow:0 8px 24px rgba(0,0,0,0.35); }
		.gjj-lora-popup.open { display:flex; }
		.gjj-lora-popup-search { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; box-sizing:border-box; pointer-events:auto; }
		.gjj-lora-popup-list { display:flex; flex-direction:column; gap:4px; max-height:180px; overflow:auto; }
		.gjj-lora-popup-item { width:100%; background:#182127; color:#dce7e2; border:1px solid #33454c; border-radius:6px; padding:5px 8px; text-align:left; cursor:pointer; box-sizing:border-box; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:1.3; pointer-events:auto; }
		.gjj-lora-popup-item:hover { background:#223039; }
		.gjj-lora-popup-item.selected { background:#18352f; border-color:#2f7d67; color:#e8fff6; }
		.gjj-lora-popup-item.selected:hover { background:#1d433a; }
		.gjj-lora-popup-empty { color:#8da2ad; font-size:11px; padding:4px 2px; }
		.gjj-lora-side { display:flex; align-items:center; gap:6px; padding-top:2px; flex:0 0 auto; white-space:nowrap; pointer-events:auto; }
		.gjj-lora-toggle-wrap { display:flex; align-items:center; gap:4px; color:#dce7e2; font-size:11px; white-space:nowrap; flex:0 0 auto; pointer-events:auto; }
		.gjj-lora-strength { width:68px; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; text-align:center; pointer-events:auto; }
	`;
	container.appendChild(style);

	// 刷新按钮已移到按钮区域，这里不需要 toolbar

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

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		if (typeof originalOnSerialize === "function") {
			originalOnSerialize.apply(this, arguments);
		}
		if (serializedNode) {
			persistLoraRows(this, ensureLoraNodeState(this).rows, serializedNode);
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

app.registerExtension({
	name: "Comfy.GJJ.LazyImageStudio",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		nodeData.output_preview = false;
		if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}

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
				persistLoraRows(this, state.rows);
				if (this.__gjjLoraContainer) {
					renderLoraUi(this);
				}
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
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

		const originalDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			clearNativePreview(this);
			const result = originalDrawBackground?.apply(this, args);
			const signature = externalPanelSignature(this);
			if (signature !== this.__gjjLazyExternalPanelSignature) {
				this.__gjjLazyExternalPanelSignature = signature;
				syncPanelFromLinkedSources(this);
			}
			return result;
		};

		const originalDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (...args) {
			clearNativePreview(this);
			return originalDrawForeground?.apply(this, args);
		};

		const originalExecuted = nodeType.prototype.onExecuted;
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
			scheduleNativePreviewClear(this);

			const effectiveParams = Array.isArray(message?.effective_params)
				? message.effective_params[0]
				: (Array.isArray(message?.ui?.effective_params) ? message.ui.effective_params[0] : null);
			applyEffectiveParamsToPanel(this, effectiveParams, true);
			updateTemplateSourcePanel(this, TEMPLATE_SOURCE_FIELDS);
			return;
		};
	},

	setup() {
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

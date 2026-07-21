import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_SeedVR2ImageUpscaler"]);
const STATUS_WIDGET_NAME = "gjj_seedvr2_status";
const CONTROL_WIDGET_NAME = "gjj_seedvr2_controls";
const SETTINGS_OPEN_PROPERTY = "gjj_seedvr2_settings_open";
const MODEL_OPEN_PROPERTY = "gjj_seedvr2_model_open";
const TILE_OPEN_PROPERTY = "gjj_seedvr2_tile_open";
const SIZE_OPEN_PROPERTY = "gjj_seedvr2_size_open";
const COLOR_OPEN_PROPERTY = "gjj_seedvr2_color_open";
const MEDIA_INPUT_NAME = "media";
const MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const LEGACY_INPUT_NAMES = new Set(["image", "video", "输入图像", "输入视频"]);
const COMMON_VIDEO_HEIGHT_WIDGET = "common_video_height";
const RESOLUTION_WIDGET = "resolution";
const SEED_CONTROL_WIDGET = "control_after_generate";
const SEED_CONTROL_DEFAULT = "randomize";
const SEED_CONTROL_VALUES = new Set(["fixed", "randomize", "increment", "decrement"]);
const MODEL_FILE_RE = /\.(safetensors|ckpt|pt2?|pth|bin|gguf|sft|pkl)$/i;
const BOOLEAN_WIDGETS = [
	{ name: "enable_debug", on: "调试 开", off: "调试", title: "打印 SeedVR2 的详细执行和显存日志。" },
];
const BOOLEAN_WIDGET_NAMES = new Set(BOOLEAN_WIDGETS.map((item) => item.name));
const HIDDEN_SETTING_WIDGETS = [
	RESOLUTION_WIDGET,
	"max_resolution",
	"seed",
	"dit_model",
	"vae_model",
	"device",
	"model_offload_device",
	"tensor_offload_device",
	"attention_mode",
	"blocks_to_swap",
	"encode_tile_size",
	"encode_tile_overlap",
	"decode_tile_size",
	"decode_tile_overlap",
	"tile_debug",
	"color_correction",
	"input_noise_scale",
	"latent_noise_scale",
	"video_chunk_mode",
	"frames_per_chunk",
	"temporal_overlap",
	"vae_temporal_size",
	"vae_temporal_overlap",
];
const MODEL_SETTING_WIDGETS = [
	"dit_model",
	"vae_model",
	"device",
	"model_offload_device",
	"tensor_offload_device",
	"attention_mode",
	"blocks_to_swap",
	"swap_io_components",
];
const TILE_SETTING_WIDGETS = [
	"encode_tiled",
	"encode_tile_size",
	"encode_tile_overlap",
	"decode_tiled",
	"decode_tile_size",
	"decode_tile_overlap",
	"tile_debug",
	"video_chunk_mode",
	"frames_per_chunk",
	"temporal_overlap",
	"vae_temporal_size",
	"vae_temporal_overlap",
];
const SIZE_SETTING_WIDGETS = [COMMON_VIDEO_HEIGHT_WIDGET, RESOLUTION_WIDGET, "max_resolution"];
const COLOR_SETTING_WIDGETS = ["color_correction"];
const COLOR_METHODS = [
	{ value: "lab", label: "LAB 色彩匹配 / LAB Color Match" },
	{ value: "wavelet", label: "小波匹配 / Wavelet" },
	{ value: "wavelet_adaptive", label: "自适应小波 / Adaptive Wavelet" },
	{ value: "hsv", label: "HSV 色彩匹配 / HSV Color Match" },
	{ value: "adain", label: "AdaIN 色彩匹配 / AdaIN Color Match" },
	{ value: "none", label: "关闭 / None" },
];
const ADVANCED_SETTING_WIDGETS = HIDDEN_SETTING_WIDGETS.filter(
	(name) => !MODEL_SETTING_WIDGETS.includes(name)
		&& !TILE_SETTING_WIDGETS.includes(name)
		&& !SIZE_SETTING_WIDGETS.includes(name)
		&& !COLOR_SETTING_WIDGETS.includes(name),
);
const LEGACY_HIDDEN_SETTING_WIDGETS = [
	COMMON_VIDEO_HEIGHT_WIDGET,
	...HIDDEN_SETTING_WIDGETS,
];
const REQUIRED_WIDGET_ORDER = [
	COMMON_VIDEO_HEIGHT_WIDGET,
	RESOLUTION_WIDGET,
	"max_resolution",
	"seed",
	SEED_CONTROL_WIDGET,
	"dit_model",
	"vae_model",
	"device",
	"model_offload_device",
	"tensor_offload_device",
	"attention_mode",
	"blocks_to_swap",
	"swap_io_components",
	"encode_tiled",
	"encode_tile_size",
	"encode_tile_overlap",
	"decode_tiled",
	"decode_tile_size",
	"decode_tile_overlap",
	"tile_debug",
	"color_correction",
	"input_noise_scale",
	"latent_noise_scale",
	"enable_debug",
	"video_chunk_mode",
	"frames_per_chunk",
	"temporal_overlap",
	"vae_temporal_size",
	"vae_temporal_overlap",
];
const SETTING_LABELS = {
	common_video_height: "目标短边预设",
	resolution: "目标短边",
	max_resolution: "最长边上限",
	seed: "随机种子",
	control_after_generate: "种子生成后控制",
	dit_model: "放大主模型",
	vae_model: "解码模型",
	device: "运行设备",
	model_offload_device: "模型卸载设备",
	tensor_offload_device: "张量卸载设备",
	attention_mode: "注意力模式",
	blocks_to_swap: "模块交换数量",
	encode_tile_size: "编码分块大小",
	encode_tile_overlap: "编码分块重叠",
	decode_tile_size: "解码分块大小",
	decode_tile_overlap: "解码分块重叠",
	tile_debug: "分块调试显示",
	color_correction: "色彩校正",
	input_noise_scale: "输入噪声强度",
	latent_noise_scale: "潜空间噪声强度",
	video_chunk_mode: "视频时间分块",
	frames_per_chunk: "每段视频帧数",
	temporal_overlap: "潜空间时间重叠",
	vae_temporal_size: "VAE 时间块大小",
	vae_temporal_overlap: "VAE 时间重叠",
};
const SETTING_SOCKET_TYPES = {
	common_video_height: "STRING",
	resolution: "INT",
	max_resolution: "INT",
	seed: "INT",
	dit_model: "STRING",
	vae_model: "STRING",
	device: "STRING",
	model_offload_device: "STRING",
	tensor_offload_device: "STRING",
	attention_mode: "STRING",
	blocks_to_swap: "INT",
	encode_tile_size: "INT",
	encode_tile_overlap: "INT",
	decode_tile_size: "INT",
	decode_tile_overlap: "INT",
	tile_debug: "STRING",
	color_correction: "STRING",
	input_noise_scale: "FLOAT",
	latent_noise_scale: "FLOAT",
	video_chunk_mode: "STRING",
	frames_per_chunk: "INT",
	temporal_overlap: "INT",
	vae_temporal_size: "INT",
	vae_temporal_overlap: "INT",
};

function refreshNode(node) {
	GJJ_Utils.scheduleRefreshNode?.(node, { useAnimationFrame: true, delay: 0 });
}

function chainCallback(object, name, callback) {
	const original = object?.[name];
	object[name] = function (...args) {
		const result = original?.apply?.(this, args);
		callback.apply(this, args);
		return result;
	};
}

function getWidget(node, name) {
	return Array.isArray(node?.widgets) ? node.widgets.find((widget) => String(widget?.name) === String(name)) : null;
}

function getInputByName(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.find((input) => String(input?.name) === String(name)) : null;
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	widget.value = value;
	widget.callback?.(value);
	if (widget.inputEl) widget.inputEl.value = String(value);
	if (widget.element && "value" in widget.element) widget.element.value = String(value);
}

function getWidgetValue(node, name) {
	return getWidget(node, name)?.value;
}

function installModelHelpProvider(node) {
	if (!node) return;
	const entries = () => [
		{
			label: "SeedVR2 主模型",
			value: String(getWidgetValue(node, "dit_model") || ""),
			tooltip: "只读取放大主模型控件；不会扫描随机种子或 control_after_generate。",
			name: "dit_model",
			type: "seedvr2",
			kind: "seedvr2",
			folder: "SEEDVR2",
		},
		{
			label: "SeedVR2 VAE",
			value: String(getWidgetValue(node, "vae_model") || ""),
			tooltip: "只读取解码模型控件；支持 models/SEEDVR2 子目录。",
			name: "vae_model",
			type: "seedvr2",
			kind: "seedvr2",
			folder: "SEEDVR2",
		},
	].filter((item) => item.value);
	node.__gjjHelpModelEntries = entries;
	node.__gjjHelpModelTreeEntries = entries;
	node.__gjjModelHelpEntries = entries;
}

function asBool(value) {
	if (typeof value === "boolean") return value;
	return ["true", "1", "yes", "on", "开"].includes(String(value || "").toLowerCase());
}

function widgetChoices(widget) {
	const values = widget?.options?.values || widget?.options?.items || widget?.values;
	return Array.isArray(values) ? values.map((value) => String(value)) : null;
}

function coerceWidgetValue(widget, value) {
	if (!widget) return value;
	const choices = widgetChoices(widget);
	if (choices?.length) {
		const text = String(value ?? "");
		if (choices.includes(text)) return text;
		const match = choices.find((item) => item.toLowerCase() === text.toLowerCase());
		return match ?? widget.value;
	}
	const type = String(widget.type || "").toUpperCase();
	if (BOOLEAN_WIDGET_NAMES.has(String(widget.name || "")) || type.includes("BOOLEAN")) return asBool(value);
	if (type.includes("INT")) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : widget.value;
	}
	if (type.includes("FLOAT") || type.includes("NUMBER")) {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : widget.value;
	}
	return value;
}

function isWidgetValueCompatible(widget, value) {
	if (!widget) return false;
	if (value === undefined) return false;
	const choices = widgetChoices(widget);
	if (choices?.length) {
		const text = String(value ?? "");
		return choices.some((item) => item.toLowerCase() === text.toLowerCase());
	}
	const type = String(widget.type || "").toUpperCase();
	if (BOOLEAN_WIDGET_NAMES.has(String(widget.name || "")) || type.includes("BOOLEAN")) {
		return typeof value === "boolean" || ["true", "false", "1", "0", "yes", "no", "on", "off", "开", "关"].includes(String(value ?? "").toLowerCase());
	}
	if (type.includes("INT") || type.includes("FLOAT") || type.includes("NUMBER")) return Number.isFinite(Number(value));
	return true;
}

function serializedWidgetValues(node) {
	return REQUIRED_WIDGET_ORDER.map((name) => getWidget(node, name)?.value);
}

function normalizeSerializedValues(values) {
	const seedControlIndex = REQUIRED_WIDGET_ORDER.indexOf(SEED_CONTROL_WIDGET);
	if (seedControlIndex < 0) return values;
	if (values.length === REQUIRED_WIDGET_ORDER.length - 1) {
		return [
			...values.slice(0, seedControlIndex),
			SEED_CONTROL_DEFAULT,
			...values.slice(seedControlIndex),
		];
	}
	if (values.length === REQUIRED_WIDGET_ORDER.length) {
		const controlValue = String(values[seedControlIndex] ?? "");
		if (MODEL_FILE_RE.test(controlValue) || (controlValue && !SEED_CONTROL_VALUES.has(controlValue))) {
			return [
				...values.slice(0, seedControlIndex),
				SEED_CONTROL_DEFAULT,
				...values.slice(seedControlIndex, REQUIRED_WIDGET_ORDER.length - 1),
			];
		}
	}
	return values;
}

function syncWidgetValuesCache(node, serializedNode = null) {
	const values = serializedWidgetValues(node);
	node.widgets_values = values;
	if (serializedNode) serializedNode.widgets_values = values;
	return values;
}

function restoreSerializedValues(node, serializedNode) {
	const rawValues = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : null;
	if (!rawValues?.length) return;
	let values = normalizeSerializedValues(rawValues.slice());
	let names = null;
	if (values.length === REQUIRED_WIDGET_ORDER.length) {
		names = REQUIRED_WIDGET_ORDER;
		const firstWidget = getWidget(node, REQUIRED_WIDGET_ORDER[0]);
		const secondWidget = getWidget(node, REQUIRED_WIDGET_ORDER[1]);
		if (!isWidgetValueCompatible(firstWidget, values[0]) && isWidgetValueCompatible(firstWidget, values[1])) {
			values = values.slice(1);
		} else if (!isWidgetValueCompatible(firstWidget, values[0]) && isWidgetValueCompatible(secondWidget, values[1])) {
			values = values.slice(1);
		}
	} else if (values.length === REQUIRED_WIDGET_ORDER.length - 5) {
		// Workflows saved before video temporal chunk controls were appended.
		names = REQUIRED_WIDGET_ORDER.slice(0, values.length);
	} else if (values.length === HIDDEN_SETTING_WIDGETS.length) {
		names = HIDDEN_SETTING_WIDGETS;
	} else if (values.length === LEGACY_HIDDEN_SETTING_WIDGETS.length) {
		names = LEGACY_HIDDEN_SETTING_WIDGETS;
	} else if (values.length === REQUIRED_WIDGET_ORDER.length + 1 && values[0] === undefined) {
		values = values.slice(1);
		names = REQUIRED_WIDGET_ORDER;
	}
	if (!names) return;
	for (let index = 0; index < names.length; index += 1) {
		const widget = getWidget(node, names[index]);
		if (!widget) continue;
		setWidgetValue(widget, coerceWidgetValue(widget, values[index]));
	}
	syncWidgetValuesCache(node);
}

function markCanvasDirty() {
	app.graph?.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
}

function rememberWidget(widget) {
	if (!widget || widget.__gjjSeedvr2Visibility) return;
	widget.options ||= {};
	widget.__gjjSeedvr2Visibility = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		y: widget.y,
		last_y: widget.last_y,
		optionsHidden: widget.options.hidden,
		optionsDisplay: widget.options.display,
		widgetDisplay: widget.widget?.style?.display || "",
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
	};
}

function setWidgetHidden(widget, hidden) {
	if (!widget) return;
	rememberWidget(widget);
	widget.options ||= {};
	if (hidden) {
		widget.hidden = true;
		// 安全地设置 disabled 属性，避免对只读属性的操作
		try {
			widget.disabled = true;
		} catch (_) {}
		widget.serialize = true;
		widget.type = `converted-widget:${widget.name || "hidden"}`;
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.y = -100000;
		widget.last_y = -100000;
		if (widget.widget) widget.widget.style.display = "none";
		if (widget.element) widget.element.style.display = "none";
		if (widget.inputEl) widget.inputEl.style.display = "none";
		return;
	}
}

function restoreNativeWidget(widget) {
	if (!widget) return;
	rememberWidget(widget);
	const state = widget.__gjjSeedvr2Visibility || {};
	widget.hidden = false;
	// 安全地恢复 disabled 属性
	try {
		widget.disabled = false;
	} catch (_) {}
	widget.serialize = true;
	const fallbackType = Array.isArray(widget?.options?.values || widget?.options?.items || widget?.values) ? "combo" : "text";
	widget.type = state.type && !String(state.type).startsWith("converted-widget:") ? state.type : fallbackType;
	if (state.computeSize) widget.computeSize = state.computeSize;
	else delete widget.computeSize;
	if (state.getHeight) widget.getHeight = state.getHeight;
	else delete widget.getHeight;
	if (state.draw) widget.draw = state.draw;
	else delete widget.draw;
	if (state.mouse) widget.mouse = state.mouse;
	else delete widget.mouse;
	widget.y = Number.isFinite(Number(state.y)) && Number(state.y) >= 0 ? state.y : 0;
	widget.last_y = Number.isFinite(Number(state.last_y)) && Number(state.last_y) >= 0 ? state.last_y : 0;
	widget.options ||= {};
	delete widget.options.hidden;
	delete widget.options.display;
	if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
	if (widget.element) widget.element.style.display = state.elementDisplay || "";
	if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
}

function removeWidgetInput(node, name) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (String(input?.name || "") !== name && String(input?.widget?.name || "") !== name) continue;
		try { node.disconnectInput?.(index); } catch (_) {}
		node.removeInput?.(index);
	}
}

function ensureWidgetInput(node, name) {
	const widget = getWidget(node, name);
	if (!node || !widget) return;
	let input = (node.inputs || []).find((item) => String(item?.name || "") === name || String(item?.widget?.name || "") === name);
	const type = SETTING_SOCKET_TYPES[name] || "STRING";
	if (!input) {
		node.addInput?.(name, type);
		input = node.inputs?.[node.inputs.length - 1];
	}
	if (!input) return;
	const label = widgetLabel(name);
	input.name = name;
	input.type = type;
	input.label = label;
	input.localized_name = label;
	input.display_name = label;
	input.tooltip = widget?.options?.tooltip || label;
	input.widget = { name };
}

function normalizeMediaInputSlot(node) {
	if (!Array.isArray(node?.inputs)) return;
	let mediaInput = getInputByName(node, MEDIA_INPUT_NAME);
	if (!mediaInput) {
		mediaInput = node.inputs.find((input) => LEGACY_INPUT_NAMES.has(String(input?.name || "")) && input?.link != null)
			|| node.inputs.find((input) => LEGACY_INPUT_NAMES.has(String(input?.name || "")));
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		if (input !== mediaInput && LEGACY_INPUT_NAMES.has(name)) {
			try {
				if (input?.link != null) node.disconnectInput?.(index);
			} catch (_) {}
			node.removeInput?.(index);
		}
	}
	mediaInput = getInputByName(node, MEDIA_INPUT_NAME) || mediaInput;
	if (!mediaInput && typeof node.addInput === "function") {
		node.addInput(MEDIA_INPUT_NAME, MEDIA_INPUT_TYPE);
		mediaInput = node.inputs[node.inputs.length - 1];
	}
	if (!mediaInput) return;
	mediaInput.name = MEDIA_INPUT_NAME;
	mediaInput.type = MEDIA_INPUT_TYPE;
	mediaInput.label = "输入媒体";
	mediaInput.localized_name = "输入媒体";
	mediaInput.tooltip = "统一输入口：支持 GJJ_BATCH_IMAGE、普通 IMAGE/IMAGE batch 和官方 VIDEO。";
}

function linkTypeForInput(node, inputName) {
	const input = getInputByName(node, inputName);
	const linkId = input?.link;
	if (linkId == null) return "";
	const link = app.graph?.links?.[linkId];
	if (link?.type) return String(link.type || "");
	const origin = app.graph?.getNodeById?.(link?.origin_id);
	const output = origin?.outputs?.[link?.origin_slot];
	return String(output?.type || "");
}

function updateOutputType(node) {
	const output = Array.isArray(node?.outputs) ? node.outputs[0] : null;
	if (!output) return;
	output.type = MEDIA_INPUT_TYPE;
	output.name = "放大结果";
	output.label = "放大结果";
	output.localized_name = "放大结果";
	output.tooltip = "兼容 GJJ_BATCH_IMAGE、IMAGE、VIDEO；输入图像/批量图时输出放大后的图像帧，输入视频时输出放大后的视频。";
}

function patchCommonVideoHeight(node) {
	const commonHeightWidget = getWidget(node, COMMON_VIDEO_HEIGHT_WIDGET);
	const resolutionWidget = getWidget(node, RESOLUTION_WIDGET);
	if (!commonHeightWidget || !resolutionWidget || commonHeightWidget.__gjjSeedvr2Patched) return;
	const originalCallback = commonHeightWidget.callback;
	commonHeightWidget.callback = function (value, ...args) {
		const result = typeof originalCallback === "function" ? originalCallback.call(this, value, ...args) : undefined;
		const selected = String(value || "").trim();
		if (selected && selected !== "手动输入") {
			const parsed = Number.parseInt(selected, 10);
			if (Number.isFinite(parsed) && parsed > 0) setWidgetValue(resolutionWidget, parsed);
		}
		refreshNode(node);
		return result;
	};
	const initial = String(commonHeightWidget.value || "").trim();
	if (initial && initial !== "手动输入") {
		const parsed = Number.parseInt(initial, 10);
		if (Number.isFinite(parsed) && parsed > 0) setWidgetValue(resolutionWidget, parsed);
	}
	commonHeightWidget.__gjjSeedvr2Patched = true;
}

function ensureStatusWidget(node) {
	if (node.__gjjSeedvr2Status) return node.__gjjSeedvr2Status;
	const box = document.createElement("div");
	box.textContent = "等待执行";
	box.className = "gjj-seedvr2-status";
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 42,
	});
	if (widget) {
		widget.serialize = false;
		widget.options ||= {};
		widget.options.serialize = false;
		widget.value = undefined;
	}
	node.__gjjSeedvr2Status = { widget, box };
	return node.__gjjSeedvr2Status;
}

function setStatus(node, text) {
	const state = ensureStatusWidget(node);
	if (!state?.box) return;
	state.box.textContent = String(text || "等待执行");
	refreshNode(node);
}

function stopProp(element) {
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

function widgetLabel(name) {
	return SETTING_LABELS[name] || name;
}

function injectStyle() {
	if (document.getElementById("gjj-seedvr2-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-seedvr2-style";
	style.textContent = `
		.gjj-seedvr2-status{min-height:24px;padding:6px 10px;border:1px solid #41535b;border-radius:8px;background:#121a1f;color:#dce7e2;font:12px sans-serif;line-height:1.35;white-space:pre-wrap;word-break:break-word;box-sizing:border-box;}
		.gjj-seedvr2-controls{display:flex;flex-wrap:wrap;gap:5px;width:100%;box-sizing:border-box;padding:2px 0;color:#d8e5e8;font:12px sans-serif;pointer-events:auto;}
		.gjj-seedvr2-controls button{flex:1 1 0;min-width:0;height:26px;border:1px solid #7b4b52;border-radius:5px;background:#39272b;color:#d8c8cb;cursor:pointer;font:700 12px sans-serif;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color .12s,border-color .12s,color .12s;}
		.gjj-seedvr2-controls button:hover{border-color:#59c38f;color:#fff;}
		.gjj-seedvr2-controls button.on{background:#175c38;border-color:#5bd28b;color:#fff;box-shadow:inset 0 0 0 1px rgba(91,210,139,.18);}
		.gjj-seedvr2-controls .model-settings{font-size:16px;background:#2b2538;border-color:#64557f;color:#d8cfee;}
		.gjj-seedvr2-controls .model-settings.on{background:#59408a;border-color:#b99aff;color:#fff;box-shadow:inset 0 0 0 1px rgba(185,154,255,.25);}
		.gjj-seedvr2-controls .tile-settings{font-size:16px;background:#243238;border-color:#4c6975;color:#c8dce4;}
		.gjj-seedvr2-controls .tile-settings.on{background:#176270;border-color:#62d6e8;color:#fff;box-shadow:inset 0 0 0 1px rgba(98,214,232,.22);}
		.gjj-seedvr2-controls .size-settings{font-size:16px;background:#353024;border-color:#766b48;color:#e5dbbd;}
		.gjj-seedvr2-controls .size-settings.on{background:#76601b;border-color:#f2cf55;color:#fff;box-shadow:inset 0 0 0 1px rgba(242,207,85,.22);}
		.gjj-seedvr2-controls .color-settings{font-size:16px;background:#382737;border-color:#7d5579;color:#ead1e7;}
		.gjj-seedvr2-controls .color-settings.on{background:#873f7e;border-color:#f09be5;color:#fff;box-shadow:inset 0 0 0 1px rgba(240,155,229,.22);}
		.gjj-seedvr2-color-methods{display:none;flex:1 0 100%;width:100%;grid-template-columns:1fr 1fr;gap:5px;padding:3px 0 1px;box-sizing:border-box;}
		.gjj-seedvr2-color-methods.open{display:grid;}
		.gjj-seedvr2-controls .gjj-seedvr2-color-methods button{height:auto;min-height:30px;padding:4px 6px;white-space:normal;line-height:1.2;background:#2d2731;border-color:#624f67;color:#ddcfe0;}
		.gjj-seedvr2-controls .gjj-seedvr2-color-methods button.selected{background:#7a356f;border-color:#f1a1e6;color:#fff;box-shadow:inset 0 0 0 1px rgba(241,161,230,.22);}
		.gjj-seedvr2-controls .settings.on{background:#334155;border-color:#94a3b8;}
	`;
	document.head.appendChild(style);
}

function panelHeight(node) {
	const root = node?.__gjjSeedvr2Controls?.root;
	return Math.max(30, Math.round((root?.scrollHeight || 28) + 2));
}

function fitNode(node) {
	const computed = node?.computeSize?.();
	if (!Array.isArray(computed)) return;
	const currentW = Math.round(node.size?.[0] || computed[0]);
	const nextH = Math.round(computed[1]);
	if (Math.abs((node.size?.[1] || 0) - nextH) > 1) node.setSize?.([currentW, nextH]);
	markCanvasDirty();
}

function renderSettingsPanel(node) {
	const open = Boolean(node?.properties?.[SETTINGS_OPEN_PROPERTY]);
	for (const name of ADVANCED_SETTING_WIDGETS) {
		const widget = getWidget(node, name);
		if (open) {
			restoreNativeWidget(widget);
			ensureWidgetInput(node, name);
		} else {
			removeWidgetInput(node, name);
			setWidgetHidden(widget, true);
		}
	}
	requestAnimationFrame(() => fitNode(node));
}

function renderModelPanel(node) {
	const open = Boolean(node?.properties?.[MODEL_OPEN_PROPERTY]);
	for (const name of MODEL_SETTING_WIDGETS) {
		const widget = getWidget(node, name);
		if (open) {
			restoreNativeWidget(widget);
			ensureWidgetInput(node, name);
		} else {
			removeWidgetInput(node, name);
			setWidgetHidden(widget, true);
		}
	}
	requestAnimationFrame(() => fitNode(node));
}

function renderTilePanel(node) {
	const open = Boolean(node?.properties?.[TILE_OPEN_PROPERTY]);
	for (const name of TILE_SETTING_WIDGETS) {
		const widget = getWidget(node, name);
		if (open) {
			restoreNativeWidget(widget);
			ensureWidgetInput(node, name);
		} else {
			removeWidgetInput(node, name);
			setWidgetHidden(widget, true);
		}
	}
	requestAnimationFrame(() => fitNode(node));
}

function renderSizePanel(node) {
	const open = Boolean(node?.properties?.[SIZE_OPEN_PROPERTY]);
	for (const name of SIZE_SETTING_WIDGETS) {
		const widget = getWidget(node, name);
		if (open) {
			restoreNativeWidget(widget);
			ensureWidgetInput(node, name);
		} else {
			removeWidgetInput(node, name);
			setWidgetHidden(widget, true);
		}
	}
	requestAnimationFrame(() => fitNode(node));
}

function renderColorPanel(node) {
	const state = node?.__gjjSeedvr2Controls;
	const open = Boolean(node?.properties?.[COLOR_OPEN_PROPERTY]);
	const widget = getWidget(node, "color_correction");
	removeWidgetInput(node, "color_correction");
	setWidgetHidden(widget, true);
	state?.colorMethods?.classList.toggle("open", open);
	const current = String(widget?.value || "lab");
	for (const [value, button] of Object.entries(state?.colorMethodButtons || {})) {
		button.classList.toggle("selected", value === current);
		button.setAttribute("aria-pressed", value === current ? "true" : "false");
	}
	requestAnimationFrame(() => fitNode(node));
}

function refreshButtons(node) {
	const state = node?.__gjjSeedvr2Controls;
	if (!state) return;
	for (const config of BOOLEAN_WIDGETS) {
		const button = state.buttons?.[config.name];
		const widget = getWidget(node, config.name);
		if (!button || !widget) continue;
		const enabled = asBool(widget.value);
		button.classList.toggle("on", enabled);
		button.setAttribute("aria-pressed", enabled ? "true" : "false");
		button.textContent = enabled ? config.on : config.off;
	}
	const open = Boolean(node?.properties?.[SETTINGS_OPEN_PROPERTY]);
	state.settingsButton.classList.toggle("on", open);
	state.settingsButton.setAttribute("aria-pressed", open ? "true" : "false");
	state.settingsButton.textContent = open ? "⚙️收起" : "⚙️设置";
	const modelOpen = Boolean(node?.properties?.[MODEL_OPEN_PROPERTY]);
	state.modelButton.classList.toggle("on", modelOpen);
	state.modelButton.setAttribute("aria-pressed", modelOpen ? "true" : "false");
	state.modelButton.textContent = "🧠";
	const tileOpen = Boolean(node?.properties?.[TILE_OPEN_PROPERTY]);
	state.tileButton.classList.toggle("on", tileOpen);
	state.tileButton.setAttribute("aria-pressed", tileOpen ? "true" : "false");
	state.tileButton.textContent = "🧩";
	const sizeOpen = Boolean(node?.properties?.[SIZE_OPEN_PROPERTY]);
	state.sizeButton.classList.toggle("on", sizeOpen);
	state.sizeButton.setAttribute("aria-pressed", sizeOpen ? "true" : "false");
	state.sizeButton.textContent = "📐";
	const colorOpen = Boolean(node?.properties?.[COLOR_OPEN_PROPERTY]);
	state.colorButton.classList.toggle("on", colorOpen);
	state.colorButton.setAttribute("aria-pressed", colorOpen ? "true" : "false");
	state.colorButton.textContent = "🎨";
}

function applyWidgetVisibility(node) {
	normalizeMediaInputSlot(node);
	removeWidgetInput(node, SEED_CONTROL_WIDGET);
	setWidgetHidden(getWidget(node, SEED_CONTROL_WIDGET), true);
	for (const config of BOOLEAN_WIDGETS) {
		removeWidgetInput(node, config.name);
		setWidgetHidden(getWidget(node, config.name), true);
	}
	renderModelPanel(node);
	renderTilePanel(node);
	renderSizePanel(node);
	renderSettingsPanel(node);
	renderColorPanel(node);
	refreshButtons(node);
	updateOutputType(node);
	syncWidgetValuesCache(node);
}

function ensureControlWidget(node) {
	if (node.__gjjSeedvr2Controls || typeof node.addDOMWidget !== "function") return node.__gjjSeedvr2Controls;
	const root = document.createElement("div");
	root.className = "gjj-seedvr2-controls";
	const buttons = {};
	for (const config of BOOLEAN_WIDGETS) {
		const button = document.createElement("button");
		button.type = "button";
		button.title = config.title;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const widget = getWidget(node, config.name);
			setWidgetValue(widget, !asBool(widget?.value));
			refreshButtons(node);
			syncWidgetValuesCache(node);
			app.graph?.setDirtyCanvas?.(true, true);
		});
		stopProp(button);
		root.appendChild(button);
		buttons[config.name] = button;
	}
	const modelButton = document.createElement("button");
	modelButton.type = "button";
	modelButton.className = "model-settings";
	modelButton.textContent = "🧠";
	modelButton.title = "展开或收起 SeedVR2 模型、运行设备与模型卸载设置。";
	modelButton.setAttribute("aria-label", "模型设置");
	modelButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.properties ||= {};
		node.properties[MODEL_OPEN_PROPERTY] = !Boolean(node.properties[MODEL_OPEN_PROPERTY]);
		if (node.properties[MODEL_OPEN_PROPERTY]) {
			node.properties[SETTINGS_OPEN_PROPERTY] = false;
			node.properties[TILE_OPEN_PROPERTY] = false;
			node.properties[SIZE_OPEN_PROPERTY] = false;
			node.properties[COLOR_OPEN_PROPERTY] = false;
		}
		applyWidgetVisibility(node);
	});
	stopProp(modelButton);
	root.appendChild(modelButton);
	const tileButton = document.createElement("button");
	tileButton.type = "button";
	tileButton.className = "tile-settings";
	tileButton.textContent = "🧩";
	tileButton.title = "展开或收起全部 VAE 分块设置。";
	tileButton.setAttribute("aria-label", "分块设置");
	tileButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.properties ||= {};
		node.properties[TILE_OPEN_PROPERTY] = !Boolean(node.properties[TILE_OPEN_PROPERTY]);
		if (node.properties[TILE_OPEN_PROPERTY]) {
			node.properties[MODEL_OPEN_PROPERTY] = false;
			node.properties[SETTINGS_OPEN_PROPERTY] = false;
			node.properties[SIZE_OPEN_PROPERTY] = false;
			node.properties[COLOR_OPEN_PROPERTY] = false;
		}
		applyWidgetVisibility(node);
	});
	stopProp(tileButton);
	root.appendChild(tileButton);
	const sizeButton = document.createElement("button");
	sizeButton.type = "button";
	sizeButton.className = "size-settings";
	sizeButton.textContent = "📐";
	sizeButton.title = "展开或收起输出尺寸设置。";
	sizeButton.setAttribute("aria-label", "尺寸设置");
	sizeButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.properties ||= {};
		node.properties[SIZE_OPEN_PROPERTY] = !Boolean(node.properties[SIZE_OPEN_PROPERTY]);
		if (node.properties[SIZE_OPEN_PROPERTY]) {
			node.properties[MODEL_OPEN_PROPERTY] = false;
			node.properties[TILE_OPEN_PROPERTY] = false;
			node.properties[SETTINGS_OPEN_PROPERTY] = false;
			node.properties[COLOR_OPEN_PROPERTY] = false;
		}
		applyWidgetVisibility(node);
	});
	stopProp(sizeButton);
	root.appendChild(sizeButton);
	const colorButton = document.createElement("button");
	colorButton.type = "button";
	colorButton.className = "color-settings";
	colorButton.textContent = "🎨";
	colorButton.title = "展开或收起色彩校正方式 / Color correction methods。";
	colorButton.setAttribute("aria-label", "色彩设置 / Color settings");
	colorButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.properties ||= {};
		node.properties[COLOR_OPEN_PROPERTY] = !Boolean(node.properties[COLOR_OPEN_PROPERTY]);
		if (node.properties[COLOR_OPEN_PROPERTY]) {
			node.properties[MODEL_OPEN_PROPERTY] = false;
			node.properties[TILE_OPEN_PROPERTY] = false;
			node.properties[SIZE_OPEN_PROPERTY] = false;
			node.properties[SETTINGS_OPEN_PROPERTY] = false;
		}
		applyWidgetVisibility(node);
	});
	stopProp(colorButton);
	root.appendChild(colorButton);
	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.className = "settings";
	settingsButton.title = "展开或收起随机种子、噪声与其它高级参数。";
	settingsButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.properties ||= {};
		node.properties[SETTINGS_OPEN_PROPERTY] = !Boolean(node.properties[SETTINGS_OPEN_PROPERTY]);
		if (node.properties[SETTINGS_OPEN_PROPERTY]) {
			node.properties[MODEL_OPEN_PROPERTY] = false;
			node.properties[TILE_OPEN_PROPERTY] = false;
			node.properties[SIZE_OPEN_PROPERTY] = false;
			node.properties[COLOR_OPEN_PROPERTY] = false;
		}
		applyWidgetVisibility(node);
	});
	stopProp(settingsButton);
	root.appendChild(settingsButton);
	const colorMethods = document.createElement("div");
	colorMethods.className = "gjj-seedvr2-color-methods";
	const colorMethodButtons = {};
	for (const method of COLOR_METHODS) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = method.label;
		button.title = method.label;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(getWidget(node, "color_correction"), method.value);
			renderColorPanel(node);
			syncWidgetValuesCache(node);
			app.graph?.setDirtyCanvas?.(true, true);
		});
		stopProp(button);
		colorMethods.appendChild(button);
		colorMethodButtons[method.value] = button;
	}
	stopProp(colorMethods);
	root.appendChild(colorMethods);
	stopProp(root);

	const widget = node.addDOMWidget(CONTROL_WIDGET_NAME, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.serialize = false;
		widget.options ||= {};
		widget.options.serialize = false;
		widget.value = undefined;
		widget.computeSize = (width) => [Math.round(width || node.size?.[0] || 360), panelHeight(node)];
		widget.getHeight = () => panelHeight(node);
	}
	const widgetIndex = node.widgets?.indexOf(widget);
	if (widgetIndex > 0) {
		node.widgets.splice(widgetIndex, 1);
		node.widgets.unshift(widget);
	}
	node.__gjjSeedvr2Controls = {
		widget, root, buttons, modelButton, tileButton, sizeButton, colorButton, settingsButton,
		colorMethods, colorMethodButtons,
	};
	if (typeof ResizeObserver !== "undefined") {
		const layoutObserver = new ResizeObserver(() => requestAnimationFrame(() => fitNode(node)));
		layoutObserver.observe(root);
		node.__gjjSeedvr2Controls.layoutObserver = layoutObserver;
		chainCallback(node, "onRemoved", function () {
			try { layoutObserver.disconnect(); } catch (_) {}
		});
	}
	return node.__gjjSeedvr2Controls;
}

function patchNode(node) {
	if (!node) return;
	node.properties ||= {};
	installModelHelpProvider(node);
	ensureControlWidget(node);
	ensureStatusWidget(node);
	patchCommonVideoHeight(node);
	setStatus(node, node.__gjjSeedvr2Status?.box?.textContent || "等待执行");
	applyWidgetVisibility(node);
	syncWidgetValuesCache(node);
	requestAnimationFrame(() => fitNode(node));
	setTimeout(() => {
		applyWidgetVisibility(node);
		syncWidgetValuesCache(node);
		fitNode(node);
	}, 80);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) return;
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.SeedVR2ImageUpscaler",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) return;
		injectStyle();

		chainCallback(nodeType.prototype, "onNodeCreated", function () {
			patchNode(this);
		});

		chainCallback(nodeType.prototype, "onConfigure", function (serializedNode) {
			restoreSerializedValues(this, serializedNode);
			setTimeout(() => {
				restoreSerializedValues(this, serializedNode);
				patchNode(this);
			}, 80);
		});

		chainCallback(nodeType.prototype, "onSerialize", function (serializedNode) {
			syncWidgetValuesCache(this, serializedNode);
		});

		chainCallback(nodeType.prototype, "onConnectionsChange", function () {
			applyWidgetVisibility(this);
			syncWidgetValuesCache(this);
			requestAnimationFrame(() => fitNode(this));
		});
	},

	async setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				setTimeout(() => patchNode(node), 80);
			}
		}
	},
});

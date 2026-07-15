import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_SeedVR2ImageUpscaler"]);
const STATUS_WIDGET_NAME = "gjj_seedvr2_status";
const CONTROL_WIDGET_NAME = "gjj_seedvr2_controls";
const SETTINGS_OPEN_PROPERTY = "gjj_seedvr2_settings_open";
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
	{ name: "swap_io_components", on: "卸载IO 开", off: "卸载IO", title: "进一步降低显存占用，但可能降低速度。" },
	{ name: "encode_tiled", on: "分块编码 开", off: "分块编码", title: "降低 VAE 编码显存占用。" },
	{ name: "decode_tiled", on: "分块解码 开", off: "分块解码", title: "降低 VAE 解码显存占用。" },
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
];
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
		},
		{
			label: "SeedVR2 VAE",
			value: String(getWidgetValue(node, "vae_model") || ""),
			tooltip: "只读取解码模型控件；支持 models/seedvr2 子目录。",
			name: "vae_model",
			type: "seedvr2",
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
		.gjj-seedvr2-controls button{flex:1 1 0;min-width:0;height:26px;border:1px solid #465960;border-radius:5px;background:#263136;color:#cfdde1;cursor:pointer;font:700 12px sans-serif;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.gjj-seedvr2-controls button:hover{border-color:#59c38f;color:#fff;}
		.gjj-seedvr2-controls button.on{background:#1f6b43;border-color:#48ad73;color:#fff;}
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
	for (const name of HIDDEN_SETTING_WIDGETS) {
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
}

function applyWidgetVisibility(node) {
	normalizeMediaInputSlot(node);
	removeWidgetInput(node, SEED_CONTROL_WIDGET);
	setWidgetHidden(getWidget(node, SEED_CONTROL_WIDGET), true);
	for (const config of BOOLEAN_WIDGETS) {
		removeWidgetInput(node, config.name);
		setWidgetHidden(getWidget(node, config.name), true);
	}
	renderSettingsPanel(node);
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
	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.className = "settings";
	settingsButton.title = "展开或收起模型、设备、分辨率与高级参数。";
	settingsButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.properties ||= {};
		node.properties[SETTINGS_OPEN_PROPERTY] = !Boolean(node.properties[SETTINGS_OPEN_PROPERTY]);
		applyWidgetVisibility(node);
	});
	stopProp(settingsButton);
	root.appendChild(settingsButton);
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
	node.__gjjSeedvr2Controls = { widget, root, buttons, settingsButton };
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

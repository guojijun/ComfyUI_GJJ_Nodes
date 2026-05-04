import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_CharacterMultiViewStudio"]);
const ACTION_PREFIX = "action_image_";
const MAIN_IMAGE_INPUT = "main_image";
const LORA_CHAIN_INPUT = "lora_chain_config";
const MIN_VISIBLE_ACTIONS = 1;
const MAX_ACTIONS = 9;
const PRESET_WIDGET_NAME = "gjj_multiview_toolbar";
const STATUS_WIDGET_NAME = "gjj_multiview_status";
const ACTION_TEXT_WIDGET = "action_prompts";
const UNET_WIDGET = "unet_name";
const LORA1_WIDGET = "lora_1_name";
const LORA1_STRENGTH_WIDGET = "lora_1_strength";
const LORA2_WIDGET = "lora_2_name";
const LORA2_STRENGTH_WIDGET = "lora_2_strength";
const OUTPUT_SPECS = [
	{
		index: 0,
		name: "多视图拼接图",
		type: "IMAGE",
		tooltip: "自动拼接后的多视图成品图。",
	},
	{
		index: 1,
		name: "单图批量图片",
		type: "GJJ_BATCH_IMAGE",
		tooltip: "按视角顺序输出的 GJJ 专用批量图片，可直接接入批量图片输入接口。",
	},
];

const DEFAULT_ACTION_LINES = [
	"白色背景。生成主体全身正视图。",
	"白色背景。生成主体全身正面右45°视图。",
	"白色背景。生成主体左侧视图。",
	"白色背景。生成主体右侧视图。",
	"白色背景。生成主体后视图。",
	"白色背景。生成主体半身正视图。",
];

const PRESET_ACTION_GROUPS = {
	productFour: [
		"白色背景。生成产品正视图。",
		"白色背景。生成产品左侧视图。",
		"白色背景。生成产品后视图。",
		"白色背景。生成产品右侧视图。",
	],
	five: [
		"白色背景。生成主体全身正视图。",
		"白色背景。生成主体全身正面右45°视图。",
		"白色背景。生成主体左侧视图。",
		"白色背景。生成主体右侧视图。",
		"白色背景。生成主体后视图。",
	],
	six: DEFAULT_ACTION_LINES,
	nine: [
		"白色背景。生成主体全身正视图。",
		"白色背景。生成主体全身正面右45°视图。",
		"白色背景。生成主体面朝左方的左侧全身视图。",
		"白色背景。生成主体面朝右方的右侧全身视图。",
		"白色背景。生成主体全身后视图。",
		"白色背景。生成主体半身正视图。",
		"白色背景。生成主体正面右45°半身图。",
		"白色背景。生成主体正面近景局部特写。",
		"白色背景。生成主体不同配色或版本的正视图。",
	],
	closeup: [
		"白色背景。生成主体半身正视图。",
		"白色背景。生成主体正面右45°半身图。",
		"白色背景。生成主体左侧近景特写。",
		"白色背景。生成主体右侧近景特写。",
	],
};

const DEFAULT_MULTI_ANGLES_LORA = "qwen-image-edit-2511-multiple-angles-lora.safetensors";

const MODEL_PRESETS = [
	{
		keywords: ["qwen_image_edit_2511", "firered-image-edit", "realfire"],
		lora1: "QWEN\\lighting\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
		lora1Strength: 1.0,
		lora2: DEFAULT_MULTI_ANGLES_LORA,
		lora2Strength: 1.0,
	},
	{
		keywords: ["qwen_image_edit"],
		lora1: "QWEN\\lighting\\Qwen-Image-Lightning-4steps-V1.0.safetensors",
		lora1Strength: 1.0,
		lora2: DEFAULT_MULTI_ANGLES_LORA,
		lora2Strength: 1.0,
	},
	{
		keywords: ["lotus-depth-"],
		lora1: "qwen_image_union_diffsynth_lora.safetensors",
		lora1Strength: 1.0,
		lora2: "",
		lora2Strength: 0.0,
	},
	{
		keywords: ["flux1-fill-dev", "flux1-dev-kontext", "flux1-canny-dev"],
		lora1: "",
		lora1Strength: 0.0,
		lora2: "",
		lora2Strength: 0.0,
	},
];

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
}

function basename(text) {
	return String(text || "").replaceAll("\\", "/").split("/").pop().toLowerCase();
}

function resolveWidgetOption(widget, desiredValue) {
	if (!widget) {
		return desiredValue;
	}
	const values =
		widget.options?.values
		|| widget.options
		|| [];
	if (Array.isArray(values)) {
		if (values.includes(desiredValue)) {
			return desiredValue;
		}
		const desiredBase = basename(desiredValue);
		const matched = values.find((item) => basename(item) === desiredBase);
		if (matched) {
			return matched;
		}
	}
	return desiredValue;
}

function formatActionName(index) {
	return `${ACTION_PREFIX}${String(index).padStart(2, "0")}`;
}

function getActionIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(ACTION_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(ACTION_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getActionInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs]
			.filter((input) => String(input?.name || "").startsWith(ACTION_PREFIX))
			.sort((a, b) => getActionIndex(a?.name) - getActionIndex(b?.name))
		: [];
}

function findInput(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.find((input) => input?.name === name) : null;
}

function setInputMeta(input, name, label, type, tooltip) {
	if (!input) {
		return;
	}
	input.name = name;
	input.label = label;
	input.localized_name = label;
	input.type = type;
	input.tooltip = tooltip;
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	const ordered = [];
	const used = new Set();
	const push = (input) => {
		if (!input || used.has(input)) {
			return;
		}
		ordered.push(input);
		used.add(input);
	};

	push(findInput(node, MAIN_IMAGE_INPUT));
	for (const input of getActionInputs(node)) {
		push(input);
	}
	push(findInput(node, LORA_CHAIN_INPUT));
	for (const input of node.inputs) {
		push(input);
	}
	node.inputs.splice(0, node.inputs.length, ...ordered);
}

function hasActionLink(input) {
	return Boolean(input?.link);
}

function addActionInput(node) {
	const inputs = getActionInputs(node);
	const nextIndex = inputs.length ? getActionIndex(inputs[inputs.length - 1].name) + 1 : 1;
	if (nextIndex > MAX_ACTIONS) {
		return;
	}
	node.addInput(formatActionName(nextIndex), "IMAGE");
}

function trimTrailingUnusedActions(node) {
	const inputs = getActionInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_ACTIONS; index -= 1) {
		if (hasActionLink(inputs[index])) {
			break;
		}
		const slotIndex = node.inputs.indexOf(inputs[index]);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
}

function ensureTrailingEmptyAction(node) {
	const inputs = getActionInputs(node);
	if (!inputs.length) {
		addActionInput(node);
		return;
	}
	if (hasActionLink(inputs[inputs.length - 1]) && inputs.length < MAX_ACTIONS) {
		addActionInput(node);
	}
}

function renameActionsSequentially(node) {
	getActionInputs(node).forEach((input, index) => {
		const number = index + 1;
		setInputMeta(
			input,
			formatActionName(number),
			`动作图 ${number}`,
			"IMAGE",
			"动作 / 姿势参考图。连上后会自动扩展下一张动作图输入。",
		);
	});
}

function stabilizeActions(node) {
	trimTrailingUnusedActions(node);
	ensureTrailingEmptyAction(node);
	renameActionsSequentially(node);
	setInputMeta(
		findInput(node, MAIN_IMAGE_INPUT),
		MAIN_IMAGE_INPUT,
		"主图",
		"IMAGE",
		"主体主参考图，必选。节点会始终以这张图作为类别、外观与风格一致性的主参考。",
	);
	setInputMeta(
		findInput(node, LORA_CHAIN_INPUT),
		LORA_CHAIN_INPUT,
		"LoRA串联配置",
		"LORA_CHAIN_CONFIG",
		"可选接入 GJJ · LoRA串联配置 的输出；会在面板 LoRA 1 / LoRA 2 之后继续按顺序串联应用多组 LoRA。",
	);
	reorderInputs(node);
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function scheduleStabilize(node, ms = 24) {
	clearTimeout(node.__gjjCharacterMultiViewTimer);
	node.__gjjCharacterMultiViewTimer = setTimeout(() => {
		stabilizeActions(node);
		GJJ_Utils.refreshNode(node);
	}, ms);
}

function normalizeModelText(text) {
	return String(text || "")
		.toLowerCase()
		.replaceAll("\\", "")
		.replaceAll("/", "")
		.replaceAll("_", "")
		.replaceAll("-", "")
		.replaceAll(".", "")
		.replaceAll(" ", "");
}

function matchPreset(unetName) {
	const normalized = normalizeModelText(unetName);
	return MODEL_PRESETS.find((preset) => preset.keywords.some((keyword) => normalized.includes(normalizeModelText(keyword)))) || null;
}

function applyModelPreset(node, force = false) {
	const unetName = String(GJJ_Utils.getWidget(node, UNET_WIDGET)?.value || "");
	const preset = matchPreset(unetName);
	if (!preset) {
		return;
	}
	if (
		!force
		&& node.__gjjCharacterMultiViewLastPresetKey === preset.keywords[0]
		&& node.__gjjCharacterMultiViewPresetInitialized
	) {
		return;
	}
	setWidgetValue(GJJ_Utils.getWidget(node, LORA1_WIDGET), resolveWidgetOption(GJJ_Utils.getWidget(node, LORA1_WIDGET), preset.lora1 || ""));
	setWidgetValue(GJJ_Utils.getWidget(node, LORA1_STRENGTH_WIDGET), preset.lora1Strength ?? 0);
	setWidgetValue(GJJ_Utils.getWidget(node, LORA2_WIDGET), resolveWidgetOption(GJJ_Utils.getWidget(node, LORA2_WIDGET), preset.lora2 || ""));
	setWidgetValue(GJJ_Utils.getWidget(node, LORA2_STRENGTH_WIDGET), preset.lora2Strength ?? 0);
	node.__gjjCharacterMultiViewLastPresetKey = preset.keywords[0];
	node.__gjjCharacterMultiViewPresetInitialized = true;
}

function ensureOutputs(node) {
	if (!node) {
		return;
	}
	for (const spec of OUTPUT_SPECS) {
		if (!node.outputs?.[spec.index]) {
			node.addOutput?.(spec.name, spec.type);
		}
		const output = node.outputs?.[spec.index];
		if (!output) {
			continue;
		}
		output.name = spec.name;
		output.label = spec.name;
		output.localized_name = spec.name;
		output.type = spec.type;
		output.tooltip = spec.tooltip;
	}
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function createButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"border:1px solid #41535b",
		"background:#172026",
		"color:#dce7e2",
		"border-radius:9px",
		"padding:3px 10px",
		"font-size:11px",
		"line-height:1.2",
		"cursor:pointer",
		"white-space:nowrap",
	].join(";");
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(event);
	});
	return button;
}

function ensureToolbar(node) {
	if (node.__gjjCharacterMultiViewToolbar) {
		return;
	}
	const textWidget = GJJ_Utils.getWidget(node, ACTION_TEXT_WIDGET);
	if (!textWidget) {
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 2px;";

	const setActionLines = (lines) => {
		setWidgetValue(textWidget, lines.join("\n"));
		GJJ_Utils.refreshNode(node);
	};

	container.appendChild(createButton("产品四视图", "填入产品正左后右四视图动作文本", () => setActionLines(PRESET_ACTION_GROUPS.productFour)));
	container.appendChild(createButton("标准五视图", "填入 1 张标准照 + 2x2 拼版的五视图动作文本", () => setActionLines(PRESET_ACTION_GROUPS.five)));
	container.appendChild(createButton("标准六视图", "填入六视图动作文本，拼版自动使用 2x3 或 3x2", () => setActionLines(PRESET_ACTION_GROUPS.six)));
	container.appendChild(createButton("标准九视图", "填入九视图常用动作文本，并追加一张主体变体图", () => setActionLines(PRESET_ACTION_GROUPS.nine)));
	container.appendChild(createButton("半身特写", "填入半身和局部补充视图", () => setActionLines(PRESET_ACTION_GROUPS.closeup)));
	container.appendChild(createButton("清空动作", "清空动作文本列表", () => setActionLines([])));

	const measureToolbarHeight = () => Math.max(34, Math.ceil(container.scrollHeight || container.offsetHeight || 34));

	const widget = node.addDOMWidget?.(PRESET_WIDGET_NAME, PRESET_WIDGET_NAME, container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => measureToolbarHeight(),
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(280, width || 280), measureToolbarHeight()];
	}

	node.__gjjCharacterMultiViewToolbar = widget || { element: container };
	requestAnimationFrame(() => GJJ_Utils.refreshNode(node));
}

function ensureStatusWidget(node) {
	if (node.__gjjCharacterMultiViewStatus) {
		return;
	}
	const box = document.createElement("div");
	box.style.cssText = [
		"padding:6px 8px",
		"border:1px solid #33434a",
		"border-radius:8px",
		"background:#10171b",
		"color:#9eb3b7",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"min-height:22px",
	].join(";");
	box.textContent = "等待执行";
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(34, Math.ceil(box.scrollHeight || box.offsetHeight || 34)),
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(280, width || 280), Math.max(34, Math.ceil(box.scrollHeight || box.offsetHeight || 34))];
	}
	node.__gjjCharacterMultiViewStatus = { widget, box };
}

function setStatus(node, text) {
	const box = node?.__gjjCharacterMultiViewStatus?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "").trim() || "等待执行";
	GJJ_Utils.refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjCharacterMultiViewPatched) {
		return;
	}

	ensureToolbar(node);
	ensureStatusWidget(node);
	ensureOutputs(node);
	stabilizeActions(node);
	applyModelPreset(node, true);

	const unetWidget = GJJ_Utils.getWidget(node, UNET_WIDGET);
	if (unetWidget && !unetWidget.__gjjCharacterMultiViewPatched) {
		const originalCallback = unetWidget.callback;
		unetWidget.callback = function (value, ...args) {
			const result = typeof originalCallback === "function"
				? originalCallback.call(this, value, ...args)
				: undefined;
			applyModelPreset(node, true);
			return result;
		};
		unetWidget.__gjjCharacterMultiViewPatched = true;
	}

	const originalConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = typeof originalConnectionsChange === "function"
			? originalConnectionsChange.apply(this, args)
			: undefined;
		scheduleStabilize(this);
		return result;
	};

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = typeof originalOnConfigure === "function"
			? originalOnConfigure.apply(this, args)
			: undefined;
		setTimeout(() => {
			ensureToolbar(this);
			ensureStatusWidget(this);
			ensureOutputs(this);
			stabilizeActions(this);

				GJJ_Utils.refreshNode(this);			applyModelPreset(this, false);
			setStatus(this, "等待执行");
		}, 0);
		return result;
	};

	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = typeof originalExecuted === "function"
			? originalExecuted.apply(this, arguments)
			: undefined;
		const width = message?.images?.[0]?.width || message?.preview_images?.[0]?.width;
		const height = message?.images?.[0]?.height || message?.preview_images?.[0]?.height;
		setStatus(this, width && height ? `完成：${width} × ${height}` : "完成");
		return result;
	};

	setStatus(node, "等待执行");
	node.__gjjCharacterMultiViewPatched = true;
	GJJ_Utils.refreshNode(node);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const nodeId = String(detail.node || "");
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			continue;
		}
		if (String(node.id) === nodeId) {
			setStatus(node, detail.text || "");
		}
	}
});

app.registerExtension({
	name: "GJJ.CharacterMultiViewStudio",
	async nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			return;
		}
		setTimeout(() => patchNode(node), 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				patchNode(node);
			}
		}
	},
});

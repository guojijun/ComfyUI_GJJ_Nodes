import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_CharacterMultiViewStudio"]);
const ACTION_PREFIX = "action_image_";
const MAIN_IMAGE_INPUT = "main_image";
const LORA_CHAIN_INPUT = "lora_chain_config";
const MIN_VISIBLE_ACTIONS = 1;
const MAX_ACTIONS = 9;
const PRESET_WIDGET_NAME = "gjj_multiview_toolbar";
const STATUS_WIDGET_NAME = "gjj_multiview_status";
const ACTION_TEXT_WIDGET = "action_prompts";
const BASE_PROMPT_WIDGET = "base_prompt";
const SETTINGS_PROPERTY = "gjj_multiview_show_settings";
const AUTO_LOAD_IMAGE_PROPERTY = "gjj_multiview_auto_load_image_node_id";
const UNET_WIDGET = "unet_name";
const LORA1_WIDGET = "lora_1_name";
const LORA1_STRENGTH_WIDGET = "lora_1_strength";
const LORA2_WIDGET = "lora_2_name";
const LORA2_STRENGTH_WIDGET = "lora_2_strength";
const PY_DECLARED_HIDDEN_WIDGETS = new Set([
	BASE_PROMPT_WIDGET,
	"negative_prompt",
	UNET_WIDGET,
	LORA1_WIDGET,
	LORA1_STRENGTH_WIDGET,
	LORA2_WIDGET,
	LORA2_STRENGTH_WIDGET,
	"seed",
	"save_each_image",
]);
const PY_DECLARED_HIDDEN_INPUTS = new Set([MAIN_IMAGE_INPUT, LORA_CHAIN_INPUT]);
const REQUIRED_WIDGET_ORDER = [
	BASE_PROMPT_WIDGET,
	"negative_prompt",
	ACTION_TEXT_WIDGET,
	UNET_WIDGET,
	LORA1_WIDGET,
	LORA1_STRENGTH_WIDGET,
	LORA2_WIDGET,
	LORA2_STRENGTH_WIDGET,
	"seed",
	"save_each_image",
];
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
	characterAsset: [
		"白色背景,近距离大头特写，只拍头部和肩膀，构图紧凑，清晰保留完整面部特征。",
		"白色背景,标准正面，完整全身构图，全身取景，全身照，完整人体，双脚完整在画面内，画面底部预留足够空间容纳双脚",
		"白色背景,主体45°斜侧身，全身无裁剪，从头到脚，姿态自然。顶部、底部各留白5%，居中。",
		"白色背景,主体后视图，全身无裁剪，从头到脚，轮廓标准。顶部、底部各留白5%，居中。",
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

const ACTION_MIGRATION_LORA_1 = "QWEN\\lighting\\FireRed-Image-Edit-1.0-Lightning-8steps-v1.1.safetensors";
const ACTION_MIGRATION_LORA_1_STRENGTH = 1.0;
const ACTION_MIGRATION_LORA_2 = "QWEN\\2511\\edit_2511人景融合20.safetensors";
const ACTION_MIGRATION_LORA_2_STRENGTH = 1.0;

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

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
}

function widgetChoices(widget) {
	const values = widget?.options?.values || widget?.options?.items || widget?.values;
	return Array.isArray(values) ? values.map((value) => String(value)) : null;
}

function asBool(value) {
	if (typeof value === "boolean") {
		return value;
	}
	return ["true", "1", "yes", "on", "开", "保存"].includes(String(value ?? "").toLowerCase());
}

function isWidgetValueCompatible(widget, value) {
	if (!widget || value === undefined) {
		return false;
	}
	const choices = widgetChoices(widget);
	if (choices?.length) {
		const text = String(value ?? "");
		return choices.some((item) => item.toLowerCase() === text.toLowerCase());
	}
	const type = String(widget.type || "").toUpperCase();
	if (type.includes("BOOLEAN") || typeof widget.value === "boolean") {
		return typeof value === "boolean" || ["true", "false", "1", "0", "yes", "no", "on", "off", "开", "关", "保存", "不保存"].includes(String(value ?? "").toLowerCase());
	}
	if (type.includes("INT") || type.includes("FLOAT") || type.includes("NUMBER") || typeof widget.value === "number") {
		return Number.isFinite(Number(value));
	}
	return true;
}

function coerceWidgetValue(widget, value) {
	if (!widget) {
		return value;
	}
	const choices = widgetChoices(widget);
	if (choices?.length) {
		const text = String(value ?? "");
		const match = choices.find((item) => item.toLowerCase() === text.toLowerCase());
		return match ?? widget.value;
	}
	const type = String(widget.type || "").toUpperCase();
	if (type.includes("BOOLEAN") || typeof widget.value === "boolean") {
		return asBool(value);
	}
	if (type.includes("INT")) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : widget.value;
	}
	if (type.includes("FLOAT") || type.includes("NUMBER") || typeof widget.value === "number") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : widget.value;
	}
	return value;
}

function serializedWidgetValues(node) {
	return REQUIRED_WIDGET_ORDER.map((name) => getWidget(node, name)?.value);
}

function syncWidgetValuesCache(node, serializedNode = null) {
	const values = serializedWidgetValues(node);
	node.widgets_values = values;
	if (serializedNode) {
		serializedNode.widgets_values = values;
	}
	return values;
}

function looksLikeActionPromptValue(value) {
	const text = String(value ?? "");
	return text.includes("\n") || /生成.*视图|动作|白色背景|主体/.test(text);
}

function legacyVisualOrderValues(rawValues) {
	if (rawValues[0] === undefined && rawValues.length >= REQUIRED_WIDGET_ORDER.length + 1 && looksLikeActionPromptValue(rawValues[1])) {
		return [
			rawValues[2],
			rawValues[3],
			rawValues[1],
			...rawValues.slice(4, 4 + REQUIRED_WIDGET_ORDER.length - 3),
		];
	}
	if (
		rawValues.length >= REQUIRED_WIDGET_ORDER.length
		&& looksLikeActionPromptValue(rawValues[0])
		&& !looksLikeActionPromptValue(rawValues[2])
	) {
		return [
			rawValues[1],
			rawValues[2],
			rawValues[0],
			...rawValues.slice(3, 3 + REQUIRED_WIDGET_ORDER.length - 3),
		];
	}
	return null;
}

function restoreSerializedValues(node, serializedNode) {
	const rawValues = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values.slice() : null;
	if (!rawValues?.length) {
		return;
	}
	let values = legacyVisualOrderValues(rawValues);
	let bestScore = -1;
	if (!values) {
		for (let offset = 0; offset <= Math.max(0, rawValues.length - REQUIRED_WIDGET_ORDER.length); offset += 1) {
			const candidate = rawValues.slice(offset, offset + REQUIRED_WIDGET_ORDER.length);
			let score = 0;
			for (let index = 0; index < REQUIRED_WIDGET_ORDER.length; index += 1) {
				const widget = getWidget(node, REQUIRED_WIDGET_ORDER[index]);
				if (isWidgetValueCompatible(widget, candidate[index])) {
					score += 1;
				}
			}
			if (score > bestScore) {
				bestScore = score;
				values = candidate;
			}
		}
	}
	if (values && bestScore < 0) {
		bestScore = REQUIRED_WIDGET_ORDER.length;
	}
	if (!values || values.length !== REQUIRED_WIDGET_ORDER.length || bestScore < Math.max(3, REQUIRED_WIDGET_ORDER.length - 2)) {
		return;
	}
	for (let index = 0; index < REQUIRED_WIDGET_ORDER.length; index += 1) {
		const widget = getWidget(node, REQUIRED_WIDGET_ORDER[index]);
		if (!widget) {
			continue;
		}
		setWidgetValue(widget, coerceWidgetValue(widget, values[index]));
	}
	syncWidgetValuesCache(node);
}

function graphForNode(node) {
	return node?.graph || app?.canvas?.graph || app?.graph || null;
}

function getInputSlot(node, name) {
	return Array.isArray(node?.inputs)
		? node.inputs.findIndex((input) => input?.name === name)
		: -1;
}

function hasMainImageLink(node) {
	const input = findInput(node, MAIN_IMAGE_INPUT);
	return Boolean(input?.link);
}

function setNodeWidgetValue(node, name, value) {
	const widget = node?.widgets?.find((item) => item?.name === name) || node?.widgets?.[0];
	if (!widget) {
		return false;
	}
	if (Array.isArray(widget.options?.values) && value && !widget.options.values.includes(value)) {
		widget.options.values = [value, ...widget.options.values];
	}
	if (widget.inputEl && "value" in widget.inputEl) {
		widget.inputEl.value = value;
	}
	widget.value = value;
	const index = node.widgets.indexOf(widget);
	if (!Array.isArray(node.widgets_values)) {
		node.widgets_values = node.widgets.map((item) => item?.value);
	}
	if (index >= 0) {
		node.widgets_values[index] = value;
	}
	widget.callback?.(value);
	return true;
}

function uploadedImageWidgetValue(uploaded) {
	const filename = String(uploaded?.filename || uploaded?.name || uploaded?.file || "").replace(/\\/g, "/").trim();
	const subfolder = String(uploaded?.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
	return subfolder && !filename.startsWith(`${subfolder}/`) ? `${subfolder}/${filename}` : filename;
}

function normalizeUploadedImage(data, fallbackName) {
	return {
		filename: String(data?.name || data?.filename || data?.file || fallbackName || "").replace(/\\/g, "/").trim(),
		subfolder: String(data?.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim(),
		type: String(data?.type || "input"),
	};
}

async function uploadMainImageFile(file) {
	const form = new FormData();
	form.append("image", file, file.name);
	form.append("type", "input");
	form.append("overwrite", "true");
	const endpoints = ["/upload/image", "/api/upload/image"];
	let lastError = null;
	for (const endpoint of endpoints) {
		try {
			const response = await (api?.fetchApi
				? api.fetchApi(endpoint, { method: "POST", body: form })
				: fetch(endpoint, { method: "POST", body: form }));
			if (!response.ok) {
				lastError = new Error(`HTTP ${response.status}`);
				continue;
			}
			const data = await response.json().catch(() => ({}));
			return normalizeUploadedImage(data, file.name);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new Error("图片上传失败");
}

function autoLoadImagePosition(node) {
	const width = 315;
	const height = 315;
	const x = Number(node?.pos?.[0] || 0) - width - 80;
	const y = Number(node?.pos?.[1] || 0);
	return [x, y - Math.max(0, (height - Number(node?.size?.[1] || 260)) * 0.3)];
}

function getExistingAutoLoadImageNode(node) {
	const graph = graphForNode(node);
	const id = node?.properties?.[AUTO_LOAD_IMAGE_PROPERTY];
	if (!graph || id == null) {
		return null;
	}
	return (graph._nodes || []).find((item) => String(item?.id) === String(id)) || null;
}

function addOrUpdateMainLoadImage(node, uploaded) {
	const graph = graphForNode(node);
	if (!graph) {
		throw new Error("无法访问当前工作流画布");
	}
	let imageNode = getExistingAutoLoadImageNode(node);
	if (!imageNode) {
		imageNode = globalThis.LiteGraph?.createNode?.("LoadImage");
		if (!imageNode) {
			throw new Error("无法创建 LoadImage 节点");
		}
		imageNode.title = "主图";
		imageNode.pos = autoLoadImagePosition(node);
		graph.add(imageNode);
		if (!node.properties) {
			node.properties = {};
		}
		node.properties[AUTO_LOAD_IMAGE_PROPERTY] = imageNode.id;
	}
	const value = uploadedImageWidgetValue(uploaded);
	if (!setNodeWidgetValue(imageNode, "image", value)) {
		throw new Error("LoadImage 节点缺少 image 控件");
	}
	const slot = getInputSlot(node, MAIN_IMAGE_INPUT);
	if (slot < 0) {
		throw new Error("主图输入口不存在");
	}
	if (findInput(node, MAIN_IMAGE_INPUT)?.link != null) {
		node.disconnectInput?.(slot);
	}
	imageNode.connect?.(0, node, slot);
	imageNode.setDirtyCanvas?.(true, true);
	graph.change?.();
	graph.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
	updateMainImageButtonState(node);
	refreshNode(node);
}

function openMainImageFile(node) {
	if (hasMainImageLink(node)) {
		return;
	}
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*,.png,.jpg,.jpeg,.webp,.bmp";
	input.style.display = "none";
	document.body.appendChild(input);
	input.addEventListener("change", async () => {
		const file = input.files?.[0];
		input.remove();
		if (!file) {
			return;
		}
		const button = node.__gjjCharacterMultiViewMainImageButton;
		const oldText = button?.textContent || "📁";
		try {
			if (button) {
				button.disabled = true;
				button.textContent = "…";
			}
			const uploaded = await uploadMainImageFile(file);
			addOrUpdateMainLoadImage(node, uploaded);
			setStatus(node, `已打开主图：${uploadedImageWidgetValue(uploaded)}`);
		} catch (error) {
			setStatus(node, `打开主图失败：${error?.message || error}`);
		} finally {
			if (button) {
				button.textContent = oldText;
			}
			updateMainImageButtonState(node);
		}
	}, { once: true });
	input.click();
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

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
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

function optionDeclaresHidden(options) {
	return Boolean(options?.hidden === true || options?.display === "hidden");
}

function inputNameDeclaresHidden(name) {
	const text = String(name || "");
	return PY_DECLARED_HIDDEN_INPUTS.has(text) || text.startsWith(ACTION_PREFIX);
}

function widgetDeclaresCompactHidden(widget) {
	if (!widget) {
		return false;
	}
	if (widget.__gjjCharacterMultiViewDeclaredHidden == null) {
		widget.__gjjCharacterMultiViewDeclaredHidden = optionDeclaresHidden(widget.options)
			|| PY_DECLARED_HIDDEN_WIDGETS.has(String(widget.name || ""));
	}
	return Boolean(widget.__gjjCharacterMultiViewDeclaredHidden);
}

function inputDeclaresCompactHidden(input) {
	if (!input) {
		return false;
	}
	if (input.__gjjCharacterMultiViewDeclaredHidden == null) {
		input.__gjjCharacterMultiViewDeclaredHidden = optionDeclaresHidden(input.options)
			|| optionDeclaresHidden(input.widget?.options)
			|| inputNameDeclaresHidden(input.name);
	}
	return Boolean(input.__gjjCharacterMultiViewDeclaredHidden);
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
	if (inputNameDeclaresHidden(name)) {
		input.__gjjCharacterMultiViewDeclaredHidden = true;
		if (!input.options || typeof input.options !== "object") {
			input.options = {};
		}
		input.options.hidden = true;
		input.options.display = "hidden";
	}
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
	// LoRA 接口放在动态接口前面，避免被挡住
	push(findInput(node, LORA_CHAIN_INPUT));
	for (const input of getActionInputs(node)) {
		push(input);
	}
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
	node.addInput(formatActionName(nextIndex), "GJJ_BATCH_IMAGE,IMAGE");
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
			"GJJ_BATCH_IMAGE,IMAGE",
			"动作 / 姿势参考图。支持 GJJ_BATCH_IMAGE 和 IMAGE 两种类型。连上后会自动扩展下一张动作图输入。",
		);
	});
}

function stabilizeActions(node) {
	trimTrailingUnusedActions(node);
	ensureTrailingEmptyAction(node);
	// 先重排接口顺序，再设置类型，确保 findInput 找到的接口位置正确
	reorderInputs(node);
	renameActionsSequentially(node);
	setInputMeta(
		findInput(node, MAIN_IMAGE_INPUT),
		MAIN_IMAGE_INPUT,
		"主图",
		"GJJ_BATCH_IMAGE,IMAGE",
		"主体主参考图，可选。支持 GJJ_BATCH_IMAGE 和 IMAGE 两种类型；未接入时按动作文本直接生成。",
	);
	setInputMeta(
		findInput(node, LORA_CHAIN_INPUT),
		LORA_CHAIN_INPUT,
		"LoRA串联配置",
		"LORA_CHAIN_CONFIG",
		"可选接入 GJJ · LoRA串联配置 的输出；会在面板 LoRA 1 / LoRA 2 之后继续按顺序串联应用多组 LoRA。",
	);

	// 当有动作图输入时，自动清空动作文本列表，并填充主体补充提示词
	const actionInputs = getActionInputs(node);
	const hasActionInput = actionInputs.some(input => input?.link);
	if (hasActionInput) {
		const textWidget = getWidget(node, ACTION_TEXT_WIDGET);
		if (textWidget && textWidget.value) {
			setWidgetValue(textWidget, "");
		}
		const basePromptWidget = getWidget(node, BASE_PROMPT_WIDGET);
		if (basePromptWidget) {
			setWidgetValue(basePromptWidget, "让图1的人做图2的动作");
		}
		setWidgetValue(getWidget(node, LORA1_WIDGET), resolveWidgetOption(getWidget(node, LORA1_WIDGET), ACTION_MIGRATION_LORA_1));
		setWidgetValue(getWidget(node, LORA1_STRENGTH_WIDGET), ACTION_MIGRATION_LORA_1_STRENGTH);
		setWidgetValue(getWidget(node, LORA2_WIDGET), resolveWidgetOption(getWidget(node, LORA2_WIDGET), ACTION_MIGRATION_LORA_2));
		setWidgetValue(getWidget(node, LORA2_STRENGTH_WIDGET), ACTION_MIGRATION_LORA_2_STRENGTH);
	} else {
		applyModelPreset(node, true);
	}

	// 强制刷新类型颜色
	globalThis.GJJApplyTypeColorsToNode?.(node);
	updateMainImageButtonState(node);
	applyCompactVisibility(node);
	syncWidgetValuesCache(node);
	node.setDirtyCanvas(true, true);
}

function scheduleStabilize(node, ms = 24) {
	clearTimeout(node.__gjjCharacterMultiViewTimer);
	node.__gjjCharacterMultiViewTimer = setTimeout(() => {
		stabilizeActions(node);
		refreshNode(node);
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
	const actionInputs = getActionInputs(node);
	const hasActionInput = actionInputs.some(input => input?.link);
	if (hasActionInput) {
		return;
	}
	const unetName = String(getWidget(node, UNET_WIDGET)?.value || "");
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
	setWidgetValue(getWidget(node, LORA1_WIDGET), resolveWidgetOption(getWidget(node, LORA1_WIDGET), preset.lora1 || ""));
	setWidgetValue(getWidget(node, LORA1_STRENGTH_WIDGET), preset.lora1Strength ?? 0);
	setWidgetValue(getWidget(node, LORA2_WIDGET), resolveWidgetOption(getWidget(node, LORA2_WIDGET), preset.lora2 || ""));
	setWidgetValue(getWidget(node, LORA2_STRENGTH_WIDGET), preset.lora2Strength ?? 0);
	node.__gjjCharacterMultiViewLastPresetKey = preset.keywords[0];
	node.__gjjCharacterMultiViewPresetInitialized = true;
	syncWidgetValuesCache(node);
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

function createButton(label, title, onClick, container) {
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
		"transition:all 0.15s ease",
	].join(";");

	// 点击视觉区分：active 状态
	button.addEventListener("mousedown", (event) => {
		event.stopPropagation();
		button.style.background = "#2a3f4a";
		button.style.borderColor = "#5a7a8a";
		button.style.color = "#ffffff";
	});
	button.addEventListener("mouseup", (event) => {
		button.style.background = "#172026";
		button.style.borderColor = "#41535b";
		button.style.color = "#dce7e2";
	});
	button.addEventListener("mouseleave", (event) => {
		button.style.background = "#172026";
		button.style.borderColor = "#41535b";
		button.style.color = "#dce7e2";
	});

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		// 添加短暂的点击反馈效果
		button.style.transform = "scale(0.95)";
		setTimeout(() => {
			button.style.transform = "scale(1)";
		}, 100);
		onClick?.(event);
	});

	// 鼠标悬停效果
	button.addEventListener("mouseenter", (event) => {
		if (button.style.transform !== "scale(0.95)") {
			button.style.background = "#1e2d36";
			button.style.borderColor = "#4a636f";
		}
	});

	return button;
}

function setToolbarButtonDisabled(button, disabled) {
	if (!button) {
		return;
	}
	button.disabled = Boolean(disabled);
	button.style.opacity = disabled ? "0.45" : "1";
	button.style.cursor = disabled ? "not-allowed" : "pointer";
	button.style.filter = disabled ? "grayscale(0.85)" : "";
}

function updateMainImageButtonState(node) {
	const button = node?.__gjjCharacterMultiViewMainImageButton;
	if (!button) {
		return;
	}
	const linked = hasMainImageLink(node);
	setToolbarButtonDisabled(button, linked);
	button.title = linked ? "主图已连接，断开主图输入后可从本地打开图片。" : "打开本地图片，上传后自动接入主图。";
}

function nativeWidgetType(widget) {
	const type = String(widget?.type || "");
	if (type && !type.startsWith("converted-widget:") && type !== "hidden") {
		return type;
	}
	if (Array.isArray(widget?.options?.values) || Array.isArray(widget?.options?.items)) {
		return "combo";
	}
	if (typeof widget?.value === "boolean") {
		return "toggle";
	}
	if (typeof widget?.value === "number") {
		return "number";
	}
	return "text";
}

function setWidgetHidden(widget, hidden) {
	if (!widget) {
		return;
	}
	if (!widget.__gjjCharacterMultiViewOriginals) {
		const type = String(widget.type || "");
		const loadedHidden = Boolean(
			widget.hidden
			|| type.startsWith("converted-widget:")
			|| type === "hidden"
			|| widget.options?.hidden === true
			|| widget.options?.display === "hidden"
		);
		widget.__gjjCharacterMultiViewOriginals = {
			computeSize: loadedHidden ? null : widget.computeSize,
			getHeight: loadedHidden ? null : widget.getHeight,
			type: nativeWidgetType(widget),
			draw: loadedHidden ? null : widget.draw,
			label: widget.label,
			size: loadedHidden ? null : (Array.isArray(widget.size) ? [...widget.size] : widget.size),
			margin_top: widget.margin_top,
			optionsHidden: widget.options?.hidden,
			optionsDisplay: widget.options?.display,
		};
	}
	const element = widget.element || widget.inputEl;
	if (hidden) {
		widget.hidden = true;
		if (widget.options && typeof widget.options === "object") {
			widget.options.hidden = true;
			widget.options.display = "hidden";
		}
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.label = "";
		widget.last_y = 0;
		widget.computedHeight = 0;
		widget.margin_top = 0;
		widget.size = [0, 0];
		if (element?.style) {
			element.style.display = "none";
			element.style.height = "0";
			element.style.overflow = "hidden";
			element.style.margin = "0";
			element.style.padding = "0";
		}
		return;
	}
	const originals = widget.__gjjCharacterMultiViewOriginals || {};
	widget.hidden = false;
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = false;
		if (widget.options.display === "hidden") {
			widget.options.display = "default";
		}
	}
	if (originals.computeSize) {
		widget.computeSize = originals.computeSize;
	} else {
		delete widget.computeSize;
	}
	if (originals.getHeight) {
		widget.getHeight = originals.getHeight;
	} else {
		delete widget.getHeight;
	}
	if (originals.type) {
		widget.type = originals.type;
	}
	if (originals.draw) {
		widget.draw = originals.draw;
	} else {
		delete widget.draw;
	}
	widget.label = originals.label ?? widget.name ?? "";
	if (originals.size) {
		widget.size = Array.isArray(originals.size) ? [...originals.size] : originals.size;
	} else {
		delete widget.size;
	}
	widget.margin_top = originals.margin_top;
	if (element?.style) {
		element.style.display = "";
		element.style.height = "";
		element.style.overflow = "";
		element.style.margin = "";
		element.style.padding = "";
	}
}

function setInputHidden(input, hidden) {
	if (!input) {
		return;
	}
	if (!input.__gjjCharacterMultiViewInputOriginals) {
		input.__gjjCharacterMultiViewInputOriginals = {
			hidden: input.hidden,
			visible: input.visible,
		};
	}
	if (hidden) {
		input.hidden = true;
		input.visible = false;
		return;
	}
	const originals = input.__gjjCharacterMultiViewInputOriginals || {};
	input.hidden = false;
	input.visible = originals.visible ?? true;
}

function showSettings(node) {
	return Boolean(node?.properties?.[SETTINGS_PROPERTY]);
}

function setSettingsVisible(node, visible) {
	if (!node.properties) {
		node.properties = {};
	}
	node.properties[SETTINGS_PROPERTY] = Boolean(visible);
	applyCompactVisibility(node);
	syncWidgetValuesCache(node);
}

function updateSettingsButtonState(node) {
	const button = node?.__gjjCharacterMultiViewSettingsButton;
	if (!button) {
		return;
	}
	const open = showSettings(node);
	button.textContent = open ? "⚙️收起" : "⚙️";
	button.title = open ? "收起其它参数，只保留顶部按钮和动作文本列表。" : "显示模型、LoRA、提示词、种子和保存参数。";
	button.style.background = open ? "#2a3f4a" : "#172026";
	button.style.borderColor = open ? "#5a7a8a" : "#41535b";
}

function widgetVisibilityRank(widget) {
	const name = String(widget?.name || "");
	if (name === PRESET_WIDGET_NAME) return 0;
	if (name === ACTION_TEXT_WIDGET) return 1;
	if (name === STATUS_WIDGET_NAME) return 99;
	return 10;
}

function reorderCompactWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((a, b) => widgetVisibilityRank(a.widget) - widgetVisibilityRank(b.widget) || a.index - b.index)
		.map((item) => item.widget);
}

function applyCompactVisibility(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const open = showSettings(node);
	for (const widget of node.widgets) {
		const name = String(widget?.name || "");
		if (name === PRESET_WIDGET_NAME || name === ACTION_TEXT_WIDGET) {
			setWidgetHidden(widget, false);
		} else if (name === STATUS_WIDGET_NAME) {
			setWidgetHidden(widget, true);
		} else if (widgetDeclaresCompactHidden(widget)) {
			setWidgetHidden(widget, !open);
		}
	}
	for (const input of node.inputs || []) {
		if (inputDeclaresCompactHidden(input)) {
			setInputHidden(input, !open);
		}
	}
	reorderCompactWidgets(node);
	updateMainImageButtonState(node);
	updateSettingsButtonState(node);
	syncWidgetValuesCache(node);
	refreshNode(node);
}

function ensureToolbar(node) {
	if (node.__gjjCharacterMultiViewToolbar) {
		return;
	}
	const textWidget = getWidget(node, ACTION_TEXT_WIDGET);
	if (!textWidget) {
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = "display:flex;flex-wrap:nowrap;gap:6px;padding:4px 0 2px;align-items:center;overflow:hidden;";

	const setActionLines = (lines) => {
		setWidgetValue(textWidget, lines.join("\n"));
		syncWidgetValuesCache(node);
		refreshNode(node);
	};

	const openImageButton = createButton("📁", "打开本地图片，上传后自动接入主图。", () => openMainImageFile(node));
	node.__gjjCharacterMultiViewMainImageButton = openImageButton;
	container.appendChild(openImageButton);
	container.appendChild(createButton("人物资产", "填入超写实真人角色四连图动作文本（大头特写+正面全身+斜侧全身+正侧全身）", () => setActionLines(PRESET_ACTION_GROUPS.characterAsset)));
	container.appendChild(createButton("产品四视图", "填入产品正左后右四视图动作文本", () => setActionLines(PRESET_ACTION_GROUPS.productFour)));
	container.appendChild(createButton("标准五视图", "填入 1 张标准照 + 2x2 拼版的五视图动作文本", () => setActionLines(PRESET_ACTION_GROUPS.five)));
	container.appendChild(createButton("标准六视图", "填入六视图动作文本，拼版自动使用 2x3 或 3x2", () => setActionLines(PRESET_ACTION_GROUPS.six)));
	container.appendChild(createButton("标准九视图", "填入九视图常用动作文本，并追加一张主体变体图", () => setActionLines(PRESET_ACTION_GROUPS.nine)));
	container.appendChild(createButton("半身特写", "填入半身和局部补充视图", () => setActionLines(PRESET_ACTION_GROUPS.closeup)));
	container.appendChild(createButton("清空动作", "清空动作文本列表", () => setActionLines([])));
	const settingsButton = createButton("⚙️", "显示模型、LoRA、提示词、种子和保存参数。", () => {
		setSettingsVisible(node, !showSettings(node));
	});
	node.__gjjCharacterMultiViewSettingsButton = settingsButton;
	container.appendChild(settingsButton);

	const measureToolbarHeight = () => Math.max(34, Math.ceil(container.scrollHeight || container.offsetHeight || 34));

	const widget = node.addDOMWidget?.(PRESET_WIDGET_NAME, PRESET_WIDGET_NAME, container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => measureToolbarHeight(),
	});
	if (widget) {
		widget.serialize = false;
		widget.options ||= {};
		widget.options.serialize = false;
		widget.value = undefined;
		widget.computeSize = (width) => [Math.max(280, width || 280), measureToolbarHeight()];
	}

	node.__gjjCharacterMultiViewToolbar = widget || { element: container };
	updateMainImageButtonState(node);
	updateSettingsButtonState(node);
	requestAnimationFrame(() => refreshNode(node));
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
		widget.serialize = false;
		widget.options ||= {};
		widget.options.serialize = false;
		widget.value = undefined;
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
	refreshNode(node);
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
	applyCompactVisibility(node);

	const unetWidget = getWidget(node, UNET_WIDGET);
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
		updateMainImageButtonState(this);
		applyCompactVisibility(this);
		scheduleStabilize(this);
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
	applyCompactVisibility(node);
	syncWidgetValuesCache(node);
	node.__gjjCharacterMultiViewPatched = true;
	refreshNode(node);
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
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || "")) || nodeType.prototype.__gjjCharacterMultiViewRegistered) {
			return;
		}
		nodeType.prototype.__gjjCharacterMultiViewRegistered = true;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = typeof originalOnNodeCreated === "function"
				? originalOnNodeCreated.apply(this, args)
				: undefined;
			setTimeout(() => patchNode(this), 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = typeof originalOnConfigure === "function"
				? originalOnConfigure.call(this, serializedNode, ...args)
				: undefined;
			restoreSerializedValues(this, serializedNode);
			setTimeout(() => {
				restoreSerializedValues(this, serializedNode);
				patchNode(this);
				syncWidgetValuesCache(this);
			}, 80);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			syncWidgetValuesCache(this, serializedNode);
			const result = typeof originalOnSerialize === "function"
				? originalOnSerialize.call(this, serializedNode, ...args)
				: undefined;
			syncWidgetValuesCache(this, serializedNode);
			return result;
		};
	},
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

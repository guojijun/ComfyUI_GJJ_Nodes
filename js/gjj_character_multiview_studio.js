import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_CharacterMultiViewStudio"]);
const ACTION_PREFIX = "action_image_";
const MAIN_IMAGE_INPUT = "main_image";
const LORA_CHAIN_INPUT = "lora_chain_config";
const MIN_VISIBLE_ACTIONS = 1;
const MAX_ACTIONS = 9;
const PRESET_WIDGET_NAME = "gjj_multiview_toolbar";
const STATUS_WIDGET_NAME = "gjj_multiview_status";
const PREVIEW_WIDGET_NAME = "gjj_multiview_live_preview";
const LORA_LIST_WIDGET_NAME = "gjj_multiview_lora_list";
const NATIVE_CANVAS_PREVIEW_WIDGET = "$$canvas-image-preview";
const NATIVE_PREVIEW_WIDGET_PATTERN = /(?:preview|image|images|img|预览|图像|图片)/i;
const ACTION_TEXT_WIDGET = "action_prompts";
const BASE_PROMPT_WIDGET = "base_prompt";
const SETTINGS_PROPERTY = "gjj_multiview_show_settings";
const AUTO_LOAD_IMAGE_PROPERTY = "gjj_multiview_auto_load_image_node_id";
const KEEP_MODEL_PROPERTY = "gjj_multiview_keep_model";
const RANDOM_SEED_PROPERTY = "gjj_multiview_random_seed";
const PREVIEW_LAYOUT_PROPERTY = "gjj_multiview_preview_layout";
const PREVIEW_PAGE_PROPERTY = "gjj_multiview_preview_page";
const FLOATING_PANEL_PROPERTY = "gjj_multiview_floating_panel";
const PREVIEW_DRAG_MIME = "application/x-gjj-character-multiview-preview";
const GJJ_MULTI_IMAGE_DRAG_MIME = "application/x-gjj-multi-image-ref";
const ANY_PREVIEW_HELD_IMAGES_PROPERTY = "gjj_any_preview_held_images";
const TEMPLATE_API_PATH = "/gjj/character_multiview/templates";
const UNET_WIDGET = "unet_name";
const LORA1_WIDGET = "lora_1_name";
const LORA1_STRENGTH_WIDGET = "lora_1_strength";
const LORA2_WIDGET = "lora_2_name";
const LORA2_STRENGTH_WIDGET = "lora_2_strength";
const LORA3_WIDGET = "lora_3_name";
const LORA3_STRENGTH_WIDGET = "lora_3_strength";
const CLIP_WIDGET = "clip_name";
const VAE_WIDGET = "vae_name";
const RMBG_WIDGET = "rmbg_model_name";
const TEMPLATE_NAME_WIDGET = "template_name";
const LORA_METADATA_API_PATH = "/gjj/lora-metadata";
const LORA_PREVIEW_API_PREFIX = "/gjj/lora-preview/";
const TEMP_OUTPUT_NODE_FLAG = "__gjjCharacterMultiViewTempOutputNode";
const DEFAULT_QWEN2511_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors";
const DEFAULT_QWEN2511_VAE = "qwen_image_vae.safetensors";
const DEFAULT_RMBG14_MODEL = "rmbg1.4.safetensors";
const PY_DECLARED_HIDDEN_WIDGETS = new Set([
	BASE_PROMPT_WIDGET,
	"negative_prompt",
	UNET_WIDGET,
	LORA1_WIDGET,
	LORA1_STRENGTH_WIDGET,
	LORA2_WIDGET,
	LORA2_STRENGTH_WIDGET,
	LORA3_WIDGET,
	LORA3_STRENGTH_WIDGET,
	"seed",
	"save_each_image",
	"keep_model",
	CLIP_WIDGET,
	VAE_WIDGET,
	RMBG_WIDGET,
	TEMPLATE_NAME_WIDGET,
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
	LORA3_WIDGET,
	LORA3_STRENGTH_WIDGET,
	"seed",
	"save_each_image",
	"keep_model",
	CLIP_WIDGET,
	VAE_WIDGET,
	RMBG_WIDGET,
	TEMPLATE_NAME_WIDGET,
	"sampling_steps",
	"sampling_cfg",
	"sampling_sampler",
	"sampling_scheduler",
	"sampling_denoise",
];
const SAMPLING_WIDGET_NAMES = [
	"sampling_steps",
	"sampling_cfg",
	"sampling_sampler",
	"sampling_scheduler",
	"sampling_denoise",
];
const LEGACY_REQUIRED_WIDGET_COUNT = REQUIRED_WIDGET_ORDER.length - SAMPLING_WIDGET_NAMES.length;
const WIDGET_CHINESE_META = {
	base_prompt: {
		label: "主体补充提示词",
		tooltip: "补充主体的材质、结构、颜色、风格或背景氛围；会和每行动作文本组合后生成对应视图。",
	},
	negative_prompt: {
		label: "反向提示词",
		tooltip: "用于排除不想出现的内容；留空时节点会自动使用零反向条件。",
	},
	action_prompts: {
		label: "动作文本列表",
		tooltip: "每行一个动作或视角描述；如果接入了对应动作图，会自动和同一行文本配对。",
	},
	unet_name: {
		label: "主模型",
		tooltip: "选择图生图或编辑型主模型；这里会过滤掉纯文生图底模。",
	},
	lora_1_name: {
		label: "第1组微调模型",
		tooltip: "主要加速或风格微调模型，默认推荐适配当前主模型的加速微调模型。",
	},
	lora_1_strength: {
		label: "第1组微调强度",
		tooltip: "控制第1组微调模型的影响强度；必须大于 0。",
	},
	lora_2_name: {
		label: "第2组微调模型",
		tooltip: "第二组可选微调模型；多视图默认推荐多角度微调模型。",
	},
	lora_2_strength: {
		label: "第2组微调强度",
		tooltip: "控制第2组微调模型的影响强度；0 表示不参与。",
	},
	lora_3_name: {
		label: "第3组微调模型",
		tooltip: "第三组可选微调模型；默认不启用。",
	},
	lora_3_strength: {
		label: "第3组微调强度",
		tooltip: "控制第3组微调模型的影响强度；0 表示关闭。",
	},
	seed: {
		label: "随机种子",
		tooltip: "基础随机种子；每个视图会在这个数值上依次加 1。",
	},
	sampling_steps: {
		label: "采样步数",
		tooltip: "0 表示自动使用当前模型预设；大于 0 时手动覆盖。",
	},
	sampling_cfg: {
		label: "CFG",
		tooltip: "-1 表示自动使用当前模型预设；大于等于 0 时手动覆盖。",
	},
	sampling_sampler: {
		label: "采样器",
		tooltip: "自动表示使用当前模型预设采样器。",
	},
	sampling_scheduler: {
		label: "调度器",
		tooltip: "自动表示使用当前模型预设调度器。",
	},
	sampling_denoise: {
		label: "降噪强度",
		tooltip: "-1 表示自动使用当前模型预设；0–1 时手动覆盖。",
	},
	save_each_image: {
		label: "保存单张图片",
		tooltip: "开启后会把每张单图保存到输出目录，并写入当前工作流元数据。",
	},
	keep_model: {
		label: "保持模型",
		tooltip: "开启后执行完成会尽量保留当前模型在内存中；关闭后允许释放模型缓存。",
	},
	clip_name: {
		label: "文本编码器",
		tooltip: "Qwen Image Edit 使用的文本 / 视觉编码器，可在模型树中切换其它量化版本。",
	},
	vae_name: {
		label: "VAE",
		tooltip: "Qwen Image VAE，可在模型树中切换其它量化版本。",
	},
	rmbg_model_name: {
		label: "RMBG1.4 抠图模型",
		tooltip: "人物资产分支使用的 RMBG1.4 抠图模型，可在模型树中切换其它量化版本。",
	},
	template_name: {
		label: "当前模板名",
		tooltip: "由模板按钮自动写入，用于后端识别人物资产等专用拼接分支。",
	},
};
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

function templateTextFromGroups() {
	const defaultBase = "保持图一主体的类别、轮廓、材质、颜色、结构细节、标识与整体风格一致，单主体，白色背景。";
	const blocks = [
		["人物资产", defaultBase, PRESET_ACTION_GROUPS.characterAsset],
		["产品四视图", "保持产品的类别、轮廓、材质、颜色、结构细节、标识与整体风格一致，单主体，白色背景。", PRESET_ACTION_GROUPS.productFour],
		["标准五视图", defaultBase, PRESET_ACTION_GROUPS.five],
		["标准六视图", defaultBase, PRESET_ACTION_GROUPS.six],
		["标准九视图", defaultBase, PRESET_ACTION_GROUPS.nine],
		["半身特写", defaultBase, PRESET_ACTION_GROUPS.closeup],
	];
	return blocks
		.map(([name, basePrompt, lines]) => `《${name}》(${basePrompt})\n${lines.join("\n")}`)
		.join("\n---\n");
}

const DEFAULT_TEMPLATE_TEXT = templateTextFromGroups();

const DEFAULT_MULTI_ANGLES_LORA = "qwen-image-edit-2511-multiple-angles-lora.safetensors";

const ACTION_MIGRATION_LORA_1 = "FireRed-Image-Edit-1.0-Lightning-8steps-v1.1.safetensors";
const ACTION_MIGRATION_LORA_1_STRENGTH = 1.0;
const ACTION_MIGRATION_LORA_2 = "edit_2511人景融合20.safetensors";
const ACTION_MIGRATION_LORA_2_STRENGTH = 1.0;

const MODEL_PRESETS = [
	{
		keywords: ["qwen_image_edit_2511", "firered-image-edit", "realfire"],
		lora1: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
		lora1Strength: 1.0,
		lora2: DEFAULT_MULTI_ANGLES_LORA,
		lora2Strength: 1.0,
		lora3: "",
		lora3Strength: 0.0,
	},
	{
		keywords: ["qwen_image_edit"],
		lora1: "Qwen-Image-Lightning-4steps-V1.0.safetensors",
		lora1Strength: 1.0,
		lora2: DEFAULT_MULTI_ANGLES_LORA,
		lora2Strength: 1.0,
		lora3: "",
		lora3Strength: 0.0,
	},
	{
		keywords: ["lotus-depth-"],
		lora1: "qwen_image_union_diffsynth_lora.safetensors",
		lora1Strength: 1.0,
		lora2: "",
		lora2Strength: 0.0,
		lora3: "",
		lora3Strength: 0.0,
	},
	{
		keywords: ["flux1-fill-dev", "flux1-dev-kontext", "flux1-canny-dev"],
		lora1: "",
		lora1Strength: 0.0,
		lora2: "",
		lora2Strength: 0.0,
		lora3: "",
		lora3Strength: 0.0,
	},
];

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function hideNativePreviewWidget(widget) {
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
	if (!widget || widget === node?.__gjjCharacterMultiViewPreview?.widget) {
		return false;
	}
	const name = String(widget?.name || "");
	if (name === PRESET_WIDGET_NAME || name === STATUS_WIDGET_NAME || name === PREVIEW_WIDGET_NAME || name === LORA_LIST_WIDGET_NAME || name === ACTION_TEXT_WIDGET) {
		return false;
	}
	if (PY_DECLARED_HIDDEN_WIDGETS.has(name) || name.startsWith(ACTION_PREFIX)) {
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

function hideLegacyNativePreviewWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return false;
	}
	let changed = false;
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		const widget = node.widgets[index];
		if (!isNativePreviewWidget(node, widget)) {
			continue;
		}
		hideNativePreviewWidget(widget);
		node.widgets.splice(index, 1);
		changed = true;
	}
	return changed;
}

function nativePreviewEmptyArray(node, key) {
	if (!node.__gjjCharacterMultiViewNativeEmptyArrays) {
		Object.defineProperty(node, "__gjjCharacterMultiViewNativeEmptyArrays", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: {},
		});
	}
	if (!Array.isArray(node.__gjjCharacterMultiViewNativeEmptyArrays[key])) {
		node.__gjjCharacterMultiViewNativeEmptyArrays[key] = [];
	}
	node.__gjjCharacterMultiViewNativeEmptyArrays[key].length = 0;
	return node.__gjjCharacterMultiViewNativeEmptyArrays[key];
}

function defineSuppressedNativePreviewProperty(node, key, emptyValue) {
	const descriptor = Object.getOwnPropertyDescriptor(node, key);
	if (descriptor?.get?.__gjjCharacterMultiViewSuppressNativePreview) {
		return;
	}
	const getter = function () {
		return Array.isArray(emptyValue) ? nativePreviewEmptyArray(this, key) : emptyValue;
	};
	getter.__gjjCharacterMultiViewSuppressNativePreview = true;
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
	} catch (_) {
		try {
			node[key] = Array.isArray(emptyValue) ? [] : emptyValue;
		} catch (_) {}
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
	hideLegacyNativePreviewWidgets(node);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function scheduleNativePreviewClear(node) {
	clearNativePreview(node);
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => clearNativePreview(node));
	}
	for (const delay of [80, 180, 360, 720, 1400, 2400, 4200, 6500]) {
		setTimeout(() => clearNativePreview(node), delay);
	}
	clearInterval(node.__gjjCharacterMultiViewNativePreviewClearInterval);
	const startedAt = Date.now();
	node.__gjjCharacterMultiViewNativePreviewClearInterval = setInterval(() => {
		clearNativePreview(node);
		node?.graph?.setDirtyCanvas?.(true, true);
		if (Date.now() - startedAt > 7000) {
			clearInterval(node.__gjjCharacterMultiViewNativePreviewClearInterval);
			node.__gjjCharacterMultiViewNativePreviewClearInterval = null;
		}
	}, 120);
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

function mutableWidgetChoices(widget) {
	const values = widget?.options?.values || widget?.options?.items || widget?.values;
	return Array.isArray(values) ? values : null;
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
		if (match) {
			return match;
		}
		const current = String(widget.value ?? "");
		const currentMatch = choices.find((item) => item.toLowerCase() === current.toLowerCase());
		return currentMatch ?? choices[0];
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
	if (rawValues.length === LEGACY_REQUIRED_WIDGET_COUNT - 2) {
		rawValues.splice(8, 0, "", 0);
	}
	if (rawValues.length === LEGACY_REQUIRED_WIDGET_COUNT - 3) {
		rawValues.splice(8, 0, "", 0);
		rawValues.push(true);
	}
	if (rawValues.length === LEGACY_REQUIRED_WIDGET_COUNT - 1) {
		rawValues.push(true);
	}
	if (rawValues.length === LEGACY_REQUIRED_WIDGET_COUNT) {
		for (const name of SAMPLING_WIDGET_NAMES) {
			rawValues.push(getWidget(node, name)?.value);
		}
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

function mediaItemToUrl(item) {
	if (!item?.filename) {
		return "";
	}
	const previewFormat =
		typeof app.getPreviewFormatParam === "function"
			? app.getPreviewFormatParam()
			: "";
	const randParam =
		typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function compactPreviewImageRef(item) {
	if (!item?.filename) {
		return null;
	}
	return {
		filename: String(item.filename || ""),
		subfolder: String(item.subfolder || ""),
		type: String(item.type || "temp"),
		hash: String(item.hash || ""),
		format: String(item.format || ""),
		media_type: String(item.media_type || "image"),
		width: Number(item.width || item.preview_width || item.w || 0),
		height: Number(item.height || item.preview_height || item.h || 0),
		mtime_ns: Number(item.mtime_ns || 0),
		size_bytes: Number(item.size_bytes || 0),
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

function graphDropPosition(event, fallbackNode = null) {
	if (app.canvas?.convertEventToCanvasOffset) {
		try {
			const point = app.canvas.convertEventToCanvasOffset(event);
			if (Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
				return [Math.round(point[0]), Math.round(point[1])];
			}
		} catch (_) {}
	}
	const canvas = app.canvas?.canvas;
	const rect = canvas?.getBoundingClientRect?.();
	const ds = app.canvas?.ds;
	if (rect && ds) {
		const scale = Number(ds.scale || 1);
		const offset = Array.isArray(ds.offset) ? ds.offset : [0, 0];
		return [
			Math.round((Number(event.clientX) - rect.left) / Math.max(0.01, scale) - Number(offset[0] || 0)),
			Math.round((Number(event.clientY) - rect.top) / Math.max(0.01, scale) - Number(offset[1] || 0)),
		];
	}
	return [
		Math.round(Number(fallbackNode?.pos?.[0] || 0) + Number(fallbackNode?.size?.[0] || 320) + 80),
		Math.round(Number(fallbackNode?.pos?.[1] || 0)),
	];
}

async function copyPreviewImageToInput(item) {
	const response = await api.fetchApi("/gjj/any_preview/copy_media_to_input", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ images: [{ ...item }] }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok || !Array.isArray(data?.images) || !data.images[0]?.filename) {
		throw new Error(data?.error || "复制图片失败");
	}
	return data.images[0];
}

function addLoadImageNodeAt(item, pos) {
	const graph = app.canvas?.graph || app.graph;
	const imageNode = globalThis.LiteGraph?.createNode?.("LoadImage");
	if (!graph?.add || !imageNode) {
		throw new Error("无法创建 LoadImage 节点");
	}
	graph.add(imageNode);
	imageNode.title = "多视图预览图";
	imageNode.pos = [Math.round(pos[0]), Math.round(pos[1])];
	if (!setNodeWidgetValue(imageNode, "image", uploadedImageWidgetValue(item))) {
		throw new Error("LoadImage 节点缺少 image 控件");
	}
	app.canvas?.selectNode?.(imageNode, false);
	imageNode.setDirtyCanvas?.(true, true);
	graph.change?.();
	graph.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
	return imageNode;
}

function addAnyPreviewNodeAt(item, pos) {
	const graph = app.canvas?.graph || app.graph;
	const previewNode = globalThis.LiteGraph?.createNode?.("GJJ_AnyPreview");
	if (!graph?.add || !previewNode) {
		throw new Error("无法创建预览节点");
	}
	graph.add(previewNode);
	previewNode.title = "多视图预览";
	previewNode.pos = [Math.round(pos[0]), Math.round(pos[1])];
	previewNode.properties ||= {};
	previewNode.properties[ANY_PREVIEW_HELD_IMAGES_PROPERTY] = [{ ...item }];
	app.canvas?.selectNode?.(previewNode, false);
	previewNode.setDirtyCanvas?.(true, true);
	graph.change?.();
	graph.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
	return previewNode;
}

async function createNodeFromDraggedPreview(item, event, sourceNode = null) {
	const pos = graphDropPosition(event, sourceNode);
	try {
		const inputItem = item?.type === "input" ? item : await copyPreviewImageToInput(item);
		addLoadImageNodeAt(inputItem, pos);
		setStatus(sourceNode, "已拖拽生成 LoadImage 节点");
		return;
	} catch (error) {
		console.warn("[GJJ CharacterMultiViewStudio] 拖拽创建 LoadImage 失败，降级为预览节点。", error);
	}
	try {
		addAnyPreviewNodeAt(item, pos);
		setStatus(sourceNode, "已拖拽生成预览节点");
	} catch (error) {
		setStatus(sourceNode, `拖拽创建节点失败：${error?.message || error}`);
	}
}

function setupPreviewImageDrag(card, image, node, item) {
	const payload = JSON.stringify({ item, nodeId: node?.id ?? null });
	const imageRef = compactPreviewImageRef(item);
	const imageRefPayload = imageRef ? JSON.stringify(imageRef) : "";
	card.draggable = true;
	image.draggable = true;
	card.title = "点击放大预览；拖到其它节点或画布可使用这张图";
	const onDragStart = (event) => {
		event.stopPropagation();
		if (!event.dataTransfer) {
			return;
		}
		const url = mediaItemToUrl(item);
		event.dataTransfer.effectAllowed = "copy";
		event.dataTransfer.setData(PREVIEW_DRAG_MIME, payload);
		if (imageRefPayload) {
			event.dataTransfer.setData(GJJ_MULTI_IMAGE_DRAG_MIME, imageRefPayload);
			event.dataTransfer.setData("application/json", imageRefPayload);
		}
		event.dataTransfer.setData("text/plain", url);
		event.dataTransfer.setData("text/uri-list", url);
		try {
			event.dataTransfer.setDragImage(image, Math.min(48, image.width / 2 || 24), Math.min(48, image.height / 2 || 24));
		} catch (_) {}
	};
	card.addEventListener("dragstart", onDragStart);
	image.addEventListener("dragstart", onDragStart);
}

function ensurePreviewDropHandler() {
	if (window.__gjjCharacterMultiViewPreviewDropHandler) {
		return;
	}
	window.__gjjCharacterMultiViewPreviewDropHandler = true;
	const hasPreviewDragType = (transfer) => Array.from(transfer?.types || []).includes(PREVIEW_DRAG_MIME);
	const isCanvasDropTarget = (event) => {
		const target = event?.target;
		const canvas = app.canvas?.canvas;
		if (!target || target === document || target === document.body || target === canvas) {
			return true;
		}
		if (target instanceof HTMLCanvasElement) {
			return true;
		}
		return false;
	};
	document.addEventListener("dragover", (event) => {
		if (!hasPreviewDragType(event.dataTransfer)) {
			return;
		}
		if (!isCanvasDropTarget(event)) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	}, true);
	document.addEventListener("drop", (event) => {
		const raw = event.dataTransfer?.getData?.(PREVIEW_DRAG_MIME);
		if (!raw) {
			return;
		}
		if (!isCanvasDropTarget(event)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		let payload = null;
		try {
			payload = JSON.parse(raw);
		} catch (_) {
			payload = null;
		}
		const item = payload?.item;
		if (!item?.filename) {
			return;
		}
		const graph = app.canvas?.graph || app.graph;
		const sourceNode = payload?.nodeId != null ? graph?.getNodeById?.(payload.nodeId) : null;
		createNodeFromDraggedPreview(item, event, sourceNode);
	}, true);
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
	refreshOpenModelFloatingPanel(node);
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

function chineseWidgetMeta(widgetOrName) {
	const name = typeof widgetOrName === "string"
		? widgetOrName
		: String(widgetOrName?.name || "");
	return WIDGET_CHINESE_META[name] || null;
}

function applyChineseWidgetMeta(widget) {
	const meta = chineseWidgetMeta(widget);
	if (!widget || !meta) {
		return;
	}
	widget.label = meta.label;
	widget.localized_name = meta.label;
	widget.display_name = meta.label;
	widget.tooltip = meta.tooltip;
	if (widget.options && typeof widget.options === "object") {
		widget.options.display_name = meta.label;
		widget.options.tooltip = meta.tooltip;
	}
	const element = widget.element || widget.inputEl;
	if (element?.setAttribute) {
		element.setAttribute("title", meta.tooltip);
	}
}

function applyChineseLabelsAndTooltips(node) {
	for (const widget of node?.widgets || []) {
		applyChineseWidgetMeta(widget);
	}
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
	// 微调模型接口放在动态接口前面，避免被挡住
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
		"微调模型串联配置",
		"LORA_CHAIN_CONFIG",
		"可选接入 GJJ · 微调模型串联配置 的输出；会在面板微调模型之后继续按顺序串联应用多组微调模型。",
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
		setWidgetValue(getWidget(node, LORA3_STRENGTH_WIDGET), 0);
		renderLoraList(node);
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
	setWidgetValue(getWidget(node, LORA3_WIDGET), resolveWidgetOption(getWidget(node, LORA3_WIDGET), preset.lora3 || ""));
	setWidgetValue(getWidget(node, LORA3_STRENGTH_WIDGET), preset.lora3Strength ?? 0);
	node.__gjjCharacterMultiViewLastPresetKey = preset.keywords[0];
	node.__gjjCharacterMultiViewPresetInitialized = true;
	syncWidgetValuesCache(node);
	renderLoraList(node);
}

function normalizeStrength(value, fallback = 1.0) {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function isPartialNumericInput(value) {
	const text = String(value ?? "").trim();
	return text === "" || text === "-" || text === "+" || text === "." || text === "-." || text === "+.";
}

function formatStrength(value, fallback = 1.0) {
	return normalizeStrength(value, fallback).toFixed(2);
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

function getLoraMetadata(node, loraName) {
	const selected = normalizeLoraToken(loraName);
	if (!selected) {
		return null;
	}
	const metadata = Array.isArray(node?.__gjjCharacterMultiViewLoraMetadata)
		? node.__gjjCharacterMultiViewLoraMetadata
		: [];
	return metadata.find((item) => {
		const matches = Array.isArray(item?.match) ? item.match : [];
		return matches.some((keyword) => {
			const token = normalizeLoraToken(keyword);
			return token && (selected.includes(token) || token.includes(selected));
		});
	}) || null;
}

function loraSearchHaystack(node, value) {
	const metadata = getLoraMetadata(node, value);
	return [
		value,
		metadata?.title,
		metadata?.trigger,
		metadata?.summary,
		...(Array.isArray(metadata?.match) ? metadata.match : []),
	].map((item) => normalizeLoraKeyword(item)).filter(Boolean).join(" ");
}

function loraFilterGroups(query) {
	return String(query || "")
		.toLowerCase()
		.split(/[,\|]+/)
		.map((group) => group.split(/[\s&]+/).map((term) => term.trim()).filter(Boolean))
		.filter((group) => group.length);
}

function loraMatchesFilter(node, value, query) {
	if (!String(value || "").trim()) {
		return true;
	}
	const groups = loraFilterGroups(query);
	if (!groups.length) {
		return true;
	}
	const haystack = loraSearchHaystack(node, value);
	return groups.some((group) => group.every((term) => haystack.includes(term)));
}

function loraPreviewUrl(node, loraName) {
	const name = String(loraName || "");
	if (!name) {
		return "";
	}
	const previews = node?.__gjjCharacterMultiViewLoraPreviews || {};
	return previews[name] ? String(previews[name]) : `${LORA_PREVIEW_API_PREFIX}${encodeURIComponent(name)}`;
}

function loraRowDefs() {
	return [
		{ index: 1, label: "第1组微调", name: LORA1_WIDGET, strength: LORA1_STRENGTH_WIDGET, required: true },
		{ index: 2, label: "第2组微调", name: LORA2_WIDGET, strength: LORA2_STRENGTH_WIDGET, required: false },
		{ index: 3, label: "第3组微调", name: LORA3_WIDGET, strength: LORA3_STRENGTH_WIDGET, required: false },
	];
}

function loraChoicesForNode(node, widget, filterText = "") {
	const values = widgetChoices(widget) || [];
	const current = String(widget?.value || "");
	const combined = current && !values.includes(current) ? [current, ...values] : values;
	const unique = [];
	for (const value of combined) {
		const text = String(value || "");
		if (!unique.includes(text) && (text === current || loraMatchesFilter(node, text, filterText))) {
			unique.push(text);
		}
	}
	if (!unique.includes("")) {
		unique.unshift("");
	}
	return unique;
}

function ensureCharacterMultiViewLoraPopup() {
	if (globalThis.__gjjCharacterMultiViewLoraPopup) {
		return globalThis.__gjjCharacterMultiViewLoraPopup;
	}
	const panel = document.createElement("div");
	panel.className = "gjj-mv-lora-popup";
	panel.style.cssText = [
		"display:none",
		"flex-direction:column",
		"gap:6px",
		"position:fixed",
		"left:12px",
		"top:12px",
		"min-width:360px",
		"max-width:680px",
		"width:max-content",
		"padding:6px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#10171b",
		"box-sizing:border-box",
		"z-index:99999",
		"box-shadow:0 8px 24px rgba(0,0,0,.35)",
	].join(";");

	const search = document.createElement("input");
	search.type = "text";
	search.className = "gjj-mv-lora-popup-search";
	search.style.cssText = [
		"width:100%",
		"min-width:0",
		"background:#11181c",
		"color:#dce7e2",
		"border:1px solid #41535b",
		"border-radius:6px",
		"padding:4px 6px",
		"box-sizing:border-box",
	].join(";");

	const list = document.createElement("div");
	list.className = "gjj-mv-lora-popup-list";
	list.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"max-height:300px",
		"overflow:auto",
	].join(";");

	panel.append(search, list);
	document.body.appendChild(panel);
	panel.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
	panel.addEventListener("mousedown", (event) => event.stopPropagation(), true);
	panel.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
	list.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	const popup = {
		panel,
		search,
		list,
		state: null,
		close() {
			panel.style.display = "none";
			search.value = "";
			list.replaceChildren();
			this.state = null;
			document.removeEventListener("pointerdown", outsideHandler, true);
		},
		reposition() {
			const anchor = this.state?.anchorEl;
			if (!anchor) {
				return;
			}
			const rect = anchor.getBoundingClientRect?.();
			const viewportWidth = Math.max(320, window.innerWidth || 320);
			const viewportHeight = Math.max(240, window.innerHeight || 240);
			const padding = 12;
			const targetWidth = Math.min(Math.max(Math.ceil(rect?.width || 360), 360), viewportWidth - padding * 2, 680);
			const below = Math.max(120, viewportHeight - Math.ceil(rect?.bottom || 0) - padding - 6);
			const above = Math.max(120, Math.floor(rect?.top || 0) - padding - 6);
			const openAbove = below < 220 && above > below;
			const maxHeight = Math.max(180, Math.min(420, openAbove ? above : below));
			const left = Math.max(padding, Math.min(Math.floor(rect?.left || padding), viewportWidth - targetWidth - padding));
			panel.style.width = `${targetWidth}px`;
			panel.style.maxHeight = `${maxHeight}px`;
			list.style.maxHeight = `${Math.max(96, maxHeight - 52)}px`;
			panel.style.left = `${left}px`;
			if (openAbove) {
				panel.style.top = "auto";
				panel.style.bottom = `${Math.max(padding, viewportHeight - Math.floor(rect?.top || 0) + 6)}px`;
			} else {
				panel.style.bottom = "auto";
				panel.style.top = `${Math.max(padding, Math.ceil(rect?.bottom || padding) + 6)}px`;
			}
		},
		render() {
			if (!this.state) {
				return;
			}
			const selected = String(this.state.getSelectedValue?.() || "");
			const options = this.state.getOptions(search.value);
			list.replaceChildren();
			if (!options.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-mv-lora-popup-empty";
				empty.textContent = "没有匹配的微调模型";
				list.appendChild(empty);
				this.reposition();
				return;
			}
			for (const option of options) {
				const value = String(option || "");
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-mv-lora-popup-item";
				if (value === selected) {
					item.classList.add("selected");
				}
				item.textContent = `${value === selected ? "✓ " : ""}${value || "未选择"}`;
				item.title = value || "未选择";
				item.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
				item.addEventListener("mousedown", (event) => event.stopPropagation(), true);
				item.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					this.state?.onSelect?.(value);
				}, true);
				list.appendChild(item);
			}
			this.reposition();
		},
		isOpenFor(anchorEl) {
			return panel.style.display === "flex" && this.state?.anchorEl === anchorEl;
		},
		open(state) {
			closeCharacterMultiViewFloatingPanels(this);
			this.state = state;
			search.value = String(state.searchValue || "");
			search.placeholder = "搜索微调模型";
			search.title = "输入关键词筛选当前这一行可选的微调模型；支持 & 与，, 或 | 表示或。";
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

	search.addEventListener("input", () => popup.render());
	search.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Escape") {
			event.preventDefault();
			popup.close();
		}
	});
	window.addEventListener("resize", () => popup.reposition());

	globalThis.__gjjCharacterMultiViewLoraPopup = popup;
	return popup;
}

function syncLoraListValue(node, def, rawName, rawStrength, enabled) {
	const nameWidget = getWidget(node, def.name);
	const strengthWidget = getWidget(node, def.strength);
	const name = enabled ? resolveWidgetOption(nameWidget, rawName) : "";
	if (nameWidget) {
		const choices = mutableWidgetChoices(nameWidget);
		if (choices && name && !choices.includes(name)) {
			choices.unshift(name);
		}
		setWidgetValue(nameWidget, name);
	}
	if (strengthWidget) {
		setWidgetValue(strengthWidget, enabled ? normalizeStrength(rawStrength, 1.0) : 0);
	}
	syncWidgetValuesCache(node);
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

async function refreshLoraMetadata(node) {
	if (!node || node.__gjjCharacterMultiViewLoraMetadataLoading) {
		return;
	}
	node.__gjjCharacterMultiViewLoraMetadataLoading = true;
	try {
		const response = await fetch(LORA_METADATA_API_PATH);
		if (!response.ok) {
			return;
		}
		const data = await response.json().catch(() => ({}));
		node.__gjjCharacterMultiViewLoraMetadata = Array.isArray(data?.metadata) ? data.metadata : [];
		node.__gjjCharacterMultiViewLoraPreviews = data?.previews && typeof data.previews === "object" ? data.previews : {};
		renderLoraList(node);
	} catch (_) {
		node.__gjjCharacterMultiViewLoraMetadata = [];
		node.__gjjCharacterMultiViewLoraPreviews = {};
	} finally {
		node.__gjjCharacterMultiViewLoraMetadataLoading = false;
	}
}

function renderLoraList(node) {
	const rowsContainer = node?.__gjjCharacterMultiViewLoraRows;
	if (!rowsContainer) {
		return;
	}
	rowsContainer.replaceChildren();
	for (const def of loraRowDefs()) {
		const nameWidget = getWidget(node, def.name);
		const strengthWidget = getWidget(node, def.strength);
		const currentName = String(nameWidget?.value || "");
		const currentStrength = normalizeStrength(strengthWidget?.value, def.required ? 1.0 : 0.0);
		const enabled = def.required || (currentName.trim() && Math.abs(currentStrength) > 1e-6);
		const metadata = getLoraMetadata(node, currentName);

		const row = document.createElement("div");
		row.className = `gjj-mv-lora-row${enabled ? "" : " off"}`;

		const main = document.createElement("div");
		main.className = "gjj-mv-lora-main";

		const picker = document.createElement("button");
		picker.type = "button";
		picker.className = "gjj-mv-lora-picker";
		picker.title = `点击展开 ${def.label} 的可搜索微调模型列表。`;
		picker.textContent = currentName || "未选择";
		picker.dataset.value = currentName;

		const meta = document.createElement("div");
		meta.className = "gjj-mv-lora-meta";

		if (metadata) {
			const title = document.createElement("span");
			title.className = "gjj-mv-lora-meta-title";
			title.textContent = String(metadata.title || def.label);

			const trigger = document.createElement("span");
			trigger.className = "gjj-mv-lora-meta-trigger";
			trigger.textContent = String(metadata.trigger || "");
			trigger.title = `触发词：${metadata.trigger || ""}`;

			const recommendedStrength = document.createElement("span");
			recommendedStrength.className = "gjj-mv-lora-meta-strength";
			recommendedStrength.textContent = formatStrength(metadata.strength, 1.0);

			const previewButton = document.createElement("button");
			previewButton.type = "button";
			previewButton.className = "gjj-mv-lora-preview-btn";
			previewButton.textContent = "▣";
			previewButton.title = "展开缩略图和简介。";

			const previewCard = document.createElement("div");
			previewCard.className = "gjj-mv-lora-preview-card";

			const image = document.createElement("img");
			image.alt = String(metadata.title || currentName || "微调模型预览图");
			image.loading = "lazy";
			image.decoding = "async";
			image.dataset.src = loraPreviewUrl(node, currentName);
			image.addEventListener("error", () => {
				const fallback = document.createElement("div");
				fallback.className = "gjj-mv-lora-preview-fallback";
				fallback.textContent = "可放同名 preview 小图";
				image.replaceWith(fallback);
			}, { once: true });

			const copy = document.createElement("div");
			copy.className = "gjj-mv-lora-preview-copy";
			copy.innerHTML = "<strong></strong><span></span><code></code><span></span>";
			copy.children[0].textContent = String(metadata.title || currentName || "");
			copy.children[1].textContent = String(metadata.summary || "");
			copy.children[2].textContent = String(metadata.trigger || "");
			copy.children[3].textContent = `推荐强度 ${formatStrength(metadata.strength, 1.0)}`;
			previewCard.append(image, copy);

			previewButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const open = !previewCard.classList.contains("open");
				if (open && image.dataset.src && !image.src) {
					image.src = image.dataset.src;
				}
				previewCard.classList.toggle("open", open);
				previewButton.classList.toggle("open", open);
				refreshNode(node);
			});

			meta.append(title, trigger, recommendedStrength, previewButton);
			main.append(picker, meta, previewCard);
		} else {
			const title = document.createElement("span");
			title.className = "gjj-mv-lora-meta-title";
			title.textContent = currentName ? def.label : "未选择";
			meta.appendChild(title);
			main.append(picker, meta);
		}

		const side = document.createElement("div");
		side.className = "gjj-mv-lora-side";

		const toggleWrap = document.createElement("label");
		toggleWrap.className = "gjj-mv-lora-toggle";
		toggleWrap.title = def.required ? "第一组微调模型默认启用。" : `控制 ${def.label} 是否参与加载。`;

		const toggle = document.createElement("input");
		toggle.type = "checkbox";
		toggle.checked = enabled;
		toggle.disabled = def.required;
		toggleWrap.append(toggle, document.createTextNode("启用"));

		const strength = document.createElement("input");
		strength.type = "number";
		strength.className = "gjj-mv-lora-strength";
		strength.step = "0.05";
		strength.value = formatStrength(currentStrength, def.required ? 1.0 : 0.0);
		strength.title = `设置 ${def.label} 强度。`;

		const commit = () => {
			const nextEnabled = def.required || toggle.checked;
			strength.value = formatStrength(strength.value, nextEnabled ? 1.0 : 0.0);
			syncLoraListValue(node, def, picker.dataset.value || "", strength.value, nextEnabled);
			renderLoraList(node);
		};

		function selectLoraValue(value) {
			picker.dataset.value = String(value || "");
			picker.textContent = picker.dataset.value || "未选择";
			const selectedMetadata = getLoraMetadata(node, picker.dataset.value);
			if (selectedMetadata && (!String(currentName || "").trim() || Math.abs(currentStrength - 1.0) < 0.0001)) {
				strength.value = formatStrength(selectedMetadata.strength, 1.0);
			}
			if (picker.dataset.value && !toggle.checked) {
				toggle.checked = true;
			}
			commit();
		}

		function openLoraPicker(event) {
			event.preventDefault();
			event.stopPropagation();
			const now = Date.now();
			if (event.type === "click" && now - Number(picker.__gjjLastLoraPointerUp || 0) < 250) {
				return;
			}
			if (event.type === "pointerup") {
				picker.__gjjLastLoraPointerUp = now;
			}
			const popup = ensureCharacterMultiViewLoraPopup();
			if (popup.isOpenFor(picker)) {
				popup.close();
				return;
			}
			popup.open({
				node,
				anchorEl: picker,
				getSelectedValue() {
					return String(picker.dataset.value || "");
				},
				getOptions(searchText) {
					return loraChoicesForNode(node, nameWidget, searchText);
				},
				onSelect(value) {
					selectLoraValue(value);
					popup.close();
				},
			});
		}

		picker.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
		picker.addEventListener("mousedown", (event) => event.stopPropagation(), true);
		picker.addEventListener("pointerup", openLoraPicker, true);
		picker.addEventListener("click", openLoraPicker, true);
		toggle.addEventListener("change", commit);
		strength.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Enter") {
				commit();
				strength.blur();
			}
		});
		strength.addEventListener("input", () => {
			if (isPartialNumericInput(strength.value)) {
				return;
			}
			syncLoraListValue(node, def, picker.dataset.value || "", strength.value, def.required || toggle.checked);
		});
		strength.addEventListener("change", commit);
		strength.addEventListener("blur", commit);

		side.append(toggleWrap, strength);
		row.append(main, side);
		rowsContainer.appendChild(row);
	}
	refreshNode(node);
}

function ensureLoraListWidget(node) {
	if (node.__gjjCharacterMultiViewLoraWidget) {
		renderLoraList(node);
		return;
	}
	const container = document.createElement("div");
	container.className = "gjj-mv-lora-wrap";
	container.style.display = showSettings(node) ? "flex" : "none";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-mv-lora-wrap { flex-direction:column; gap:6px; width:100%; box-sizing:border-box; margin:4px 0 2px; pointer-events:auto; }
		.gjj-mv-lora-rows { display:flex; flex-direction:column; gap:6px; }
		.gjj-mv-lora-row { display:flex; align-items:flex-start; gap:6px; padding:6px; border:1px solid #3c4c54; border-radius:8px; background:#172026; box-sizing:border-box; }
		.gjj-mv-lora-row.off { opacity:.65; }
		.gjj-mv-lora-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; position:relative; }
		.gjj-mv-lora-picker { width:100%; min-width:0; height:26px; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:3px 7px; box-sizing:border-box; font-size:12px; text-align:left; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
		.gjj-mv-lora-picker:hover { border-color:#6aa6b8; background:#172329; }
		.gjj-mv-lora-meta { display:flex; align-items:center; gap:6px; min-height:18px; color:#b9c9cf; font-size:11px; line-height:1.25; }
		.gjj-mv-lora-meta-title { color:#eef8f4; font-weight:600; white-space:nowrap; }
		.gjj-mv-lora-meta-trigger { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9fd4c3; }
		.gjj-mv-lora-meta-strength { flex:0 0 auto; color:#d7c587; }
		.gjj-mv-lora-preview-btn { width:24px; height:20px; flex:0 0 24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:12px; line-height:16px; padding:0; text-align:center; }
		.gjj-mv-lora-preview-btn:hover, .gjj-mv-lora-preview-btn.open { border-color:#6aa6b8; background:#26363d; }
		.gjj-mv-lora-preview-card { display:none; position:absolute; left:0; top:calc(100% + 6px); width:min(360px,100%); padding:8px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-shadow:0 8px 24px rgba(0,0,0,.38); z-index:9998; box-sizing:border-box; }
		.gjj-mv-lora-preview-card.open { display:grid; grid-template-columns:92px minmax(0,1fr); gap:8px; }
		.gjj-mv-lora-preview-card img, .gjj-mv-lora-preview-fallback { width:92px; height:92px; border-radius:6px; border:1px solid #2e4149; background:#172026; }
		.gjj-mv-lora-preview-card img { object-fit:cover; }
		.gjj-mv-lora-preview-fallback { display:flex; align-items:center; justify-content:center; text-align:center; padding:8px; box-sizing:border-box; color:#9fb0b7; font-size:11px; }
		.gjj-mv-lora-preview-copy { min-width:0; display:flex; flex-direction:column; gap:5px; font-size:11px; color:#c7d5d8; line-height:1.35; }
		.gjj-mv-lora-preview-copy strong { color:#eef8f4; font-size:12px; }
		.gjj-mv-lora-preview-copy code { color:#9fd4c3; white-space:normal; word-break:break-word; }
		.gjj-mv-lora-side { display:flex; align-items:center; gap:6px; padding-top:1px; flex:0 0 auto; white-space:nowrap; }
		.gjj-mv-lora-toggle { display:flex; align-items:center; gap:4px; color:#dce7e2; font-size:11px; white-space:nowrap; }
		.gjj-mv-lora-strength { width:64px; height:26px; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:3px 6px; text-align:center; box-sizing:border-box; }
		.gjj-mv-lora-popup-item { width:100%; display:block; background:#182127; color:#dce7e2; border:1px solid #33454c; border-radius:6px; padding:5px 8px; text-align:left; cursor:pointer; box-sizing:border-box; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:1.3; }
		.gjj-mv-lora-popup-item:hover { background:#223039; }
		.gjj-mv-lora-popup-item.selected { background:#18352f; border-color:#2f7d67; color:#e8fff6; }
		.gjj-mv-lora-popup-empty { color:#8da2ad; font-size:11px; padding:4px 2px; }
	`;

	const rows = document.createElement("div");
	rows.className = "gjj-mv-lora-rows";
	container.append(style, rows);

	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		container.addEventListener(eventName, (event) => {
			if (event.target?.closest?.("button,input,select,textarea,.gjj-mv-lora-picker")) {
				return;
			}
			event.stopPropagation();
		}, true);
	}
	container.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	node.__gjjCharacterMultiViewLoraContainer = container;
	node.__gjjCharacterMultiViewLoraRows = rows;
	const widget = node.addDOMWidget?.(LORA_LIST_WIDGET_NAME, "微调模型列表", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => showSettings(node) ? Math.max(196, Math.ceil(container.scrollHeight || container.offsetHeight || 196)) : 0,
	});
	if (widget) {
		widget.serialize = false;
		widget.options ||= {};
		widget.options.serialize = false;
		widget.value = undefined;
		widget.computeSize = (width) => [
			Math.max(280, width || 280),
			showSettings(node) ? Math.max(196, Math.ceil(container.scrollHeight || container.offsetHeight || 196)) : 0,
		];
	}
	node.__gjjCharacterMultiViewLoraWidget = widget || { element: container };
	renderLoraList(node);
	void refreshLoraMetadata(node);
}

function enforceRequiredModelChoices(node) {
	const unetWidget = getWidget(node, UNET_WIDGET);
	const unetValues = mutableWidgetChoices(unetWidget);
	if (unetValues?.length) {
		const filtered = unetValues.filter((value) => String(value || "").toLowerCase().includes("2511"));
		if (filtered.length) {
			filtered.sort((a, b) => {
				const left = modelNameScore(a, [], 0);
				const right = modelNameScore(b, [], 1);
				return (left?.[0] ?? 9) - (right?.[0] ?? 9) || String(a).localeCompare(String(b));
			});
			unetValues.splice(0, unetValues.length, ...filtered);
			if (!String(unetWidget.value || "").trim()) {
				setWidgetValue(unetWidget, filtered[0]);
			}
		}
	}
	for (const name of [LORA1_WIDGET, LORA2_WIDGET, LORA3_WIDGET]) {
		const widget = getWidget(node, name);
		const values = mutableWidgetChoices(widget);
		if (values?.length) {
			values.sort((a, b) => {
				const left = modelNameScore(a, [], 0);
				const right = modelNameScore(b, [], 1);
				return (left?.[0] ?? 9) - (right?.[0] ?? 9) || String(a).localeCompare(String(b));
			});
			if (values.length && !String(widget.value || "").trim()) {
				setWidgetValue(widget, values[0]);
			}
		}
	}
	if (!String(getWidget(node, LORA3_STRENGTH_WIDGET)?.value ?? "").trim()) {
		setWidgetValue(getWidget(node, LORA3_STRENGTH_WIDGET), 0);
	}
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
		if (button.__gjjToggleButton) {
			return;
		}
		button.style.background = "#172026";
		button.style.borderColor = "#41535b";
		button.style.color = "#dce7e2";
	});
	button.addEventListener("mouseleave", (event) => {
		if (button.__gjjToggleButton) {
			return;
		}
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
		if (button.__gjjToggleButton) {
			return;
		}
		if (button.style.transform !== "scale(0.95)") {
			button.style.background = "#1e2d36";
			button.style.borderColor = "#4a636f";
		}
	});

	return button;
}

function floatingRegistry() {
	if (!globalThis.__gjjCharacterMultiViewFloatingPanels) {
		globalThis.__gjjCharacterMultiViewFloatingPanels = new Set();
	}
	return globalThis.__gjjCharacterMultiViewFloatingPanels;
}

function refreshOpenModelFloatingPanel(node) {
	for (const panel of Array.from(floatingRegistry())) {
		if (panel?.node === node && panel?.key === "models") {
			panel.refresh?.();
		}
	}
}

function closeCharacterMultiViewFloatingPanels(except = null) {
	for (const panel of Array.from(floatingRegistry())) {
		if (panel && panel !== except) {
			panel.close?.();
		}
	}
	if (except !== globalThis.__gjjCharacterMultiViewLoraPopup) {
		globalThis.__gjjCharacterMultiViewLoraPopup?.close?.();
	}
}

function modelSearchTokens(query) {
	return String(query || "")
		.toLowerCase()
		.split(/[\s,，;；|/\\]+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function modelNameScore(value, tokens, index) {
	const text = String(value || "").toLowerCase();
	const normalized = normalizeModelText(text);
	const suffixScore = text.endsWith(".safetensors") ? 0 : text.endsWith(".gguf") ? 1 : 2;
	if (!tokens.length) {
		return [suffixScore, index];
	}
	let positionScore = 0;
	for (const token of tokens) {
		const normalizedToken = normalizeModelText(token);
		if (!text.includes(token) && (!normalizedToken || !normalized.includes(normalizedToken))) {
			return null;
		}
		const rawIndex = text.indexOf(token);
		const normIndex = normalizedToken ? normalized.indexOf(normalizedToken) : rawIndex;
		positionScore += rawIndex >= 0 ? rawIndex : Math.max(0, normIndex);
	}
	return [suffixScore, positionScore, index];
}

function filteredModelChoices(widget, query = "", limit = 80) {
	const values = widgetChoices(widget) || [];
	const current = String(widget?.value || "");
	const seen = new Set();
	const tokens = modelSearchTokens(query);
	const scored = [];
	values.forEach((value, index) => {
		const text = String(value || "");
		if (seen.has(text)) {
			return;
		}
		seen.add(text);
		const score = modelNameScore(text, tokens, index);
		if (score) {
			scored.push({ text, score });
		}
	});
	scored.sort((a, b) => {
		for (let index = 0; index < a.score.length; index += 1) {
			if (a.score[index] !== b.score[index]) {
				return a.score[index] - b.score[index];
			}
		}
		return a.text.localeCompare(b.text);
	});
	const result = scored.slice(0, limit).map((item) => item.text);
	if (current && !result.includes(current) && (!tokens.length || modelNameScore(current, tokens, -1))) {
		result.unshift(current);
	}
	return result;
}

function selectFirstModelChoice(widget, query = "") {
	const first = filteredModelChoices(widget, query, 1)[0];
	if (widget && first != null && String(widget.value || "") !== String(first || "")) {
		setWidgetValue(widget, first);
		return first;
	}
	return first ?? "";
}

function makeFloatingPanel(node, key, anchor, title) {
	closeCharacterMultiViewFloatingPanels();
	const panel = document.createElement("div");
	panel.className = "gjj-mv-floating-panel";
	panel.style.cssText = [
		"position:fixed",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"width:min(560px,calc(100vw - 24px))",
		"max-height:min(680px,calc(100vh - 24px))",
		"overflow:auto",
		"padding:10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#10171b",
		"color:#dce7e2",
		"box-shadow:0 12px 32px rgba(0,0,0,.42)",
		"box-sizing:border-box",
		"z-index:100000",
		"font-size:12px",
	].join(";");
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;color:#eef8f4;";
	const titleEl = document.createElement("div");
	titleEl.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;";
	titleEl.textContent = title;
	const close = createButton("✖关闭", "关闭窗口", () => popup.close());
	close.style.minWidth = "58px";
	close.style.padding = "2px 8px";
	header.append(titleEl, close);
	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:8px;";
	panel.append(header, body);
	document.body.appendChild(panel);

	const popup = {
		key,
		node,
		panel,
		titleEl,
		body,
		refreshers: new Set(),
		refresh() {
			for (const refresher of Array.from(this.refreshers || [])) {
				refresher?.();
			}
			updateKeepModelHeaderButtonState(node);
		},
		close() {
			panel.remove();
			floatingRegistry().delete(this);
			if (key === "models" && node?.__gjjCharacterMultiViewKeepModelHeaderButton) {
				delete node.__gjjCharacterMultiViewKeepModelHeaderButton;
			}
			if (node?.properties?.[FLOATING_PANEL_PROPERTY] === key) {
				delete node.properties[FLOATING_PANEL_PROPERTY];
			}
			updateFloatingButtonStates(node);
			document.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("resize", reposition);
		},
		reposition() {
			const rect = anchor?.getBoundingClientRect?.() || { left: 12, right: 12, bottom: 36, top: 12 };
			const pad = 12;
			const width = Math.min(560, Math.max(320, window.innerWidth - pad * 2));
			const left = Math.max(pad, Math.min(Math.floor(rect.left), window.innerWidth - width - pad));
			panel.style.width = `${width}px`;
			panel.style.left = `${left}px`;
			panel.style.top = `${Math.max(pad, Math.min(Math.ceil(rect.bottom + 6), window.innerHeight - 160))}px`;
		},
	};
	function outside(event) {
		if (panel.contains(event.target) || anchor?.contains?.(event.target)) {
			return;
		}
		popup.close();
	}
	function reposition() {
		popup.reposition();
	}
	panel.addEventListener("pointerdown", (event) => event.stopPropagation());
	panel.addEventListener("mousedown", (event) => event.stopPropagation());
	panel.addEventListener("click", (event) => event.stopPropagation());
	panel.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
	document.addEventListener("pointerdown", outside, true);
	window.addEventListener("resize", reposition);
	floatingRegistry().add(popup);
	node.properties ||= {};
	node.properties[FLOATING_PANEL_PROPERTY] = key;
	popup.reposition();
	updateFloatingButtonStates(node);
	return popup;
}

function parseMultiviewTemplates(text) {
	const blocks = String(text || "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split(/^\s*---+\s*$/m);
	const templates = [];
	for (const block of blocks) {
		const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
		if (!lines.length) {
			continue;
		}
		const header = lines[0];
		const match = header.match(/^《([^》]+)》\s*(?:\((.*)\))?\s*$/);
		if (!match) {
			continue;
		}
		const name = String(match[1] || "").trim();
		const basePrompt = String(match[2] || "").trim();
		const actions = lines.slice(1).filter((line) => line && line !== "---");
		if (!name || !actions.length) {
			continue;
		}
		templates.push({ name, basePrompt, actions });
	}
	return templates;
}

async function loadMultiviewTemplateText() {
	try {
		const response = await api.fetchApi(TEMPLATE_API_PATH);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		return String(data?.text || DEFAULT_TEMPLATE_TEXT);
	} catch (error) {
		console.warn("[GJJ CharacterMultiViewStudio] 模板读取失败，使用内置模板。", error);
		return DEFAULT_TEMPLATE_TEXT;
	}
}

async function saveMultiviewTemplateText(text) {
	const response = await api.fetchApi(TEMPLATE_API_PATH, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: String(text || "") }),
	});
	if (!response.ok) {
		const message = await response.text().catch(() => "");
		throw new Error(message || `HTTP ${response.status}`);
	}
	return response.json();
}

function applyMultiviewTemplate(node, template) {
	const textWidget = getWidget(node, ACTION_TEXT_WIDGET);
	const basePromptWidget = getWidget(node, BASE_PROMPT_WIDGET);
	const templateNameWidget = getWidget(node, TEMPLATE_NAME_WIDGET);
	if (basePromptWidget) {
		setWidgetValue(basePromptWidget, template.basePrompt || "");
	}
	if (textWidget) {
		setWidgetValue(textWidget, (template.actions || []).join("\n"));
	}
	if (templateNameWidget) {
		setWidgetValue(templateNameWidget, template.name || "");
	}
	syncWidgetValuesCache(node);
	setStatus(node, `已应用模板：${template.name}`);
	refreshNode(node);
}

function renderTemplateButtons(node) {
	const wrap = node?.__gjjCharacterMultiViewTemplateButtons;
	if (!wrap) {
		return;
	}
	const templates = parseMultiviewTemplates(node.__gjjCharacterMultiViewTemplateText || DEFAULT_TEMPLATE_TEXT);
	for (const button of node.__gjjCharacterMultiViewTemplateButtonElements || []) {
		button.remove();
	}
	node.__gjjCharacterMultiViewTemplateButtonElements = [];
	for (const template of templates) {
		const button = createButton(
			template.name,
			`应用模板：${template.name}`,
			() => applyMultiviewTemplate(node, template),
		);
		wrap.insertBefore(button, node.__gjjCharacterMultiViewTemplateInsertBefore || null);
		node.__gjjCharacterMultiViewTemplateButtonElements.push(button);
	}
	refreshNode(node);
}

async function refreshTemplateButtons(node) {
	node.__gjjCharacterMultiViewTemplateText = await loadMultiviewTemplateText();
	renderTemplateButtons(node);
}

function openTemplateEditor(node) {
	const overlay = document.createElement("div");
	overlay.style.cssText = [
		"position:fixed",
		"inset:0",
		"z-index:100000",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"background:rgba(0,0,0,.58)",
		"font-family:system-ui,\"Microsoft YaHei\",sans-serif",
	].join(";");
	const panel = document.createElement("div");
	panel.style.cssText = [
		"width:min(760px,calc(100vw - 28px))",
		"height:min(620px,calc(100vh - 28px))",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"border:1px solid #455a63",
		"border-radius:8px",
		"background:#10171b",
		"color:#e7f2f4",
		"box-shadow:0 18px 46px rgba(0,0,0,.54)",
		"padding:10px",
	].join(";");
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:800;";
	const title = document.createElement("div");
	title.textContent = "多视图模板";
	const path = document.createElement("div");
	path.textContent = "保存到 presets/gjj_character_multiview_templates.txt";
	path.style.cssText = "font-size:11px;font-weight:500;color:#91a8ae;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
	header.append(title, path);

	const textarea = document.createElement("textarea");
	textarea.value = String(node.__gjjCharacterMultiViewTemplateText || DEFAULT_TEMPLATE_TEXT);
	textarea.spellcheck = false;
	textarea.style.cssText = [
		"flex:1 1 auto",
		"min-height:0",
		"width:100%",
		"box-sizing:border-box",
		"resize:none",
		"border:1px solid #34464e",
		"border-radius:7px",
		"background:#0b1114",
		"color:#dce7e2",
		"padding:9px",
		"font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,\"Microsoft YaHei\",monospace",
		"outline:none",
		"white-space:pre",
	].join(";");
	const footer = document.createElement("div");
	footer.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:7px;";
	const status = document.createElement("span");
	status.style.cssText = "margin-right:auto;color:#9eb3b7;font-size:12px;";
	const reset = createButton("恢复内置", "用内置模板覆盖编辑框内容", () => {
		textarea.value = DEFAULT_TEMPLATE_TEXT;
		status.textContent = "已恢复到内置模板，保存后生效";
	});
	const close = createButton("关闭", "关闭模板编辑器", () => overlay.remove());
	const save = createButton("保存", "保存模板到 presets 并刷新按钮", async () => {
		const oldText = save.textContent;
		try {
			save.disabled = true;
			save.textContent = "保存中...";
			const data = await saveMultiviewTemplateText(textarea.value);
			node.__gjjCharacterMultiViewTemplateText = String(data?.text || textarea.value);
			renderTemplateButtons(node);
			status.textContent = "已保存";
		} catch (error) {
			status.textContent = `保存失败：${error?.message || error}`;
		} finally {
			save.disabled = false;
			save.textContent = oldText;
		}
	});
	footer.append(status, reset, close, save);
	panel.append(header, textarea, footer);
	overlay.appendChild(panel);
	const stop = (event) => event.stopPropagation();
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu", "keydown"]) {
		panel.addEventListener(eventName, stop);
	}
	overlay.addEventListener("click", () => overlay.remove());
	document.body.appendChild(overlay);
	textarea.focus();
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
	widget.label = chineseWidgetMeta(widget)?.label || originals.label || widget.name || "";
	applyChineseWidgetMeta(widget);
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
	return false;
}

function setSettingsVisible(node, visible) {
	if (!node.properties) {
		node.properties = {};
	}
	node.properties[SETTINGS_PROPERTY] = false;
	applyCompactVisibility(node);
	syncWidgetValuesCache(node);
}

function keepModelEnabled(node) {
	if (!node) {
		return true;
	}
	node.properties ||= {};
	if (node.properties[KEEP_MODEL_PROPERTY] == null) {
		node.properties[KEEP_MODEL_PROPERTY] = true;
	}
	return node.properties[KEEP_MODEL_PROPERTY] !== false;
}

function setKeepModelEnabled(node, enabled) {
	node.properties ||= {};
	node.properties[KEEP_MODEL_PROPERTY] = Boolean(enabled);
	setWidgetValue(getWidget(node, "keep_model"), Boolean(enabled));
	updateKeepModelButtonState(node);
	updateKeepModelHeaderButtonState(node);
	syncWidgetValuesCache(node);
	refreshNode(node);
}

function randomSeedEnabled(node) {
	return Boolean(node?.properties?.[RANDOM_SEED_PROPERTY]);
}

function randomSeedValue() {
	return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function setRandomSeedEnabled(node, enabled) {
	node.properties ||= {};
	node.properties[RANDOM_SEED_PROPERTY] = Boolean(enabled);
	updateRandomSeedButtonState(node);
	refreshNode(node);
}

function randomizeSeedIfEnabled(node) {
	if (!randomSeedEnabled(node)) {
		return null;
	}
	const seed = randomSeedValue();
	setWidgetValue(getWidget(node, "seed"), seed);
	syncWidgetValuesCache(node);
	return seed;
}

function updateSettingsButtonState(node) {
	updateFloatingButtonStates(node);
}

function applyToolbarToggleStyle(button, enabled, colors) {
	if (!button) {
		return;
	}
	button.__gjjToggleButton = true;
	button.setAttribute("aria-pressed", enabled ? "true" : "false");
	button.style.minWidth = "34px";
	button.style.padding = "3px 9px";
	button.style.fontWeight = "700";
	button.style.background = enabled ? colors.onBg : "#11181c";
	button.style.borderColor = enabled ? colors.onBorder : "#43555f";
	button.style.color = enabled ? colors.onColor : "#7f9199";
	button.style.boxShadow = enabled
		? `inset 0 0 0 1px ${colors.onInset}, 0 0 8px ${colors.onGlow}`
		: "inset 0 0 0 1px rgba(255,255,255,0.03)";
	button.style.opacity = enabled ? "1" : "0.72";
}

function updateKeepModelButtonState(node) {
	const button = node?.__gjjCharacterMultiViewKeepModelButton;
	if (!button) {
		return;
	}
	const enabled = keepModelEnabled(node);
	const widget = getWidget(node, "keep_model");
	if (widget && widget.value !== enabled) {
		widget.value = enabled;
	}
	updateFloatingButtonStates(node);
}

function updateRandomSeedButtonState(node) {
	const button = node?.__gjjCharacterMultiViewRandomSeedButton;
	if (!button) {
		return;
	}
	const enabled = randomSeedEnabled(node);
	button.textContent = "🎲";
	button.title = enabled ? "随机种：开启。每次运行前自动更换随机种子。" : "随机种：关闭。点击开启每次运行前自动更换随机种子。";
	applyToolbarToggleStyle(button, enabled, {
		onBg: "#463413",
		onBorder: "#f2b84b",
		onColor: "#fff4d7",
		onInset: "rgba(255,207,98,0.28)",
		onGlow: "rgba(242,184,75,0.34)",
	});
}

function makeBooleanRow(node, widgetName, labelText) {
	const widget = getWidget(node, widgetName);
	const label = document.createElement("label");
	label.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px;border:1px solid #33454c;border-radius:8px;background:#172026;";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = Boolean(widget?.value);
	const text = document.createElement("span");
	text.textContent = labelText || chineseWidgetMeta(widgetName)?.label || widgetName;
	input.addEventListener("change", () => {
		setWidgetValue(widget, Boolean(input.checked));
		if (widgetName === "keep_model") {
			node.properties ||= {};
			node.properties[KEEP_MODEL_PROPERTY] = Boolean(input.checked);
			updateKeepModelButtonState(node);
		}
		syncWidgetValuesCache(node);
		refreshNode(node);
	});
	label.append(input, text);
	return label;
}

function styleKeepModelHeaderButton(button, enabled) {
	if (!button) {
		return;
	}
	button.textContent = enabled ? "保持模型：开" : "保持模型：关";
	button.title = enabled ? "保持模型已开启，点击关闭。" : "保持模型已关闭，点击开启。";
	button.style.minWidth = "82px";
	button.style.padding = "3px 8px";
	button.style.fontSize = "11px";
	button.style.fontWeight = "700";
	button.style.background = enabled ? "#1d3d34" : "#11181c";
	button.style.borderColor = enabled ? "#54c985" : "#43555f";
	button.style.color = enabled ? "#eafff2" : "#8fa0a8";
	button.style.boxShadow = enabled
		? "inset 0 0 0 1px rgba(111,255,174,0.28), 0 0 8px rgba(84,201,133,0.26)"
		: "inset 0 0 0 1px rgba(255,255,255,0.03)";
}

function makeKeepModelHeaderButton(node) {
	const button = createButton("", "", () => {
		setKeepModelEnabled(node, !keepModelEnabled(node));
	});
	button.__gjjToggleButton = true;
	node.__gjjCharacterMultiViewKeepModelHeaderButton = button;
	styleKeepModelHeaderButton(button, keepModelEnabled(node));
	return button;
}

function updateKeepModelHeaderButtonState(node) {
	styleKeepModelHeaderButton(node?.__gjjCharacterMultiViewKeepModelHeaderButton, keepModelEnabled(node));
}

function makeNumberRow(node, widgetName) {
	const widget = getWidget(node, widgetName);
	const wrap = document.createElement("label");
	wrap.style.cssText = "display:grid;grid-template-columns:110px minmax(0,1fr);align-items:center;gap:8px;padding:7px;border:1px solid #33454c;border-radius:8px;background:#172026;";
	const label = document.createElement("span");
	label.textContent = chineseWidgetMeta(widgetName)?.label || widgetName;
	const input = document.createElement("input");
	input.type = "number";
	input.value = String(widget?.value ?? 0);
	input.style.cssText = "min-width:0;background:#11181c;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:5px 7px;box-sizing:border-box;";
	input.addEventListener("change", () => {
		setWidgetValue(widget, coerceWidgetValue(widget, input.value));
		syncWidgetValuesCache(node);
		refreshNode(node);
	});
	wrap.append(label, input);
	return wrap;
}

function makeComboRow(node, widgetName) {
	const widget = getWidget(node, widgetName);
	const wrap = document.createElement("label");
	wrap.style.cssText = "display:grid;grid-template-columns:110px minmax(0,1fr);align-items:center;gap:8px;padding:7px;border:1px solid #33454c;border-radius:8px;background:#172026;";
	const label = document.createElement("span");
	label.textContent = chineseWidgetMeta(widgetName)?.label || widgetName;
	const select = document.createElement("select");
	select.style.cssText = "min-width:0;background:#11181c;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:5px 7px;box-sizing:border-box;";
	for (const value of widgetChoices(widget) || []) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		select.appendChild(option);
	}
	select.value = String(widget?.value ?? "");
	select.addEventListener("change", () => {
		setWidgetValue(widget, select.value);
		syncWidgetValuesCache(node);
		refreshNode(node);
	});
	wrap.append(label, select);
	return wrap;
}

function makeTextRow(node, widgetName) {
	const widget = getWidget(node, widgetName);
	const wrap = document.createElement("label");
	wrap.style.cssText = "display:flex;flex-direction:column;gap:5px;padding:7px;border:1px solid #33454c;border-radius:8px;background:#172026;";
	const label = document.createElement("span");
	label.textContent = chineseWidgetMeta(widgetName)?.label || widgetName;
	const input = document.createElement("textarea");
	input.value = String(widget?.value || "");
	input.rows = widgetName === BASE_PROMPT_WIDGET ? 2 : 3;
	input.style.cssText = "width:100%;min-height:54px;resize:vertical;background:#11181c;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:6px 7px;box-sizing:border-box;font-size:12px;";
	input.addEventListener("change", () => {
		setWidgetValue(widget, input.value);
		syncWidgetValuesCache(node);
		refreshNode(node);
	});
	wrap.append(label, input);
	return wrap;
}

function makeModelSearchRow(node, widgetName, strengthWidgetName = "") {
	const widget = getWidget(node, widgetName);
	const strengthWidget = strengthWidgetName ? getWidget(node, strengthWidgetName) : null;
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #33454c;border-radius:8px;background:#172026;";

	const top = document.createElement("div");
	top.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 76px;gap:6px;align-items:center;";
	const label = document.createElement("div");
	label.style.cssText = "font-weight:700;color:#eef8f4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
	label.textContent = chineseWidgetMeta(widgetName)?.label || widgetName;
	const strength = document.createElement("input");
	strength.type = "number";
	strength.step = "0.01";
	strength.value = String(strengthWidget?.value ?? "");
	strength.placeholder = "强度";
	strength.style.cssText = "display:" + (strengthWidget ? "block" : "none") + ";width:76px;background:#11181c;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:4px 6px;box-sizing:border-box;text-align:center;";
	strength.addEventListener("change", () => {
		setWidgetValue(strengthWidget, coerceWidgetValue(strengthWidget, strength.value));
		syncWidgetValuesCache(node);
		refreshNode(node);
	});
	top.append(label, strength);

	const search = document.createElement("input");
	search.type = "text";
	search.placeholder = "输入关键词搜索，自动使用第一个匹配模型";
	search.style.cssText = "width:100%;background:#11181c;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:5px 7px;box-sizing:border-box;";

	const current = document.createElement("div");
	current.style.cssText = "color:#9fd4c3;font-size:11px;line-height:1.35;word-break:break-all;";
	const list = document.createElement("div");
	list.style.cssText = "display:flex;flex-direction:column;gap:4px;max-height:170px;overflow:auto;";

	const applyValue = (value) => {
		if (value == null || !widget) {
			return;
		}
		const choices = mutableWidgetChoices(widget);
		if (choices && value && !choices.includes(value)) {
			choices.unshift(value);
		}
		setWidgetValue(widget, value);
		if (widgetName === UNET_WIDGET) {
			applyPresetForCurrentModel(node);
		}
		current.textContent = `当前：${String(widget.value || "未选择")}`;
		syncWidgetValuesCache(node);
		refreshNode(node);
	};

	const render = (autoPick = false) => {
		const options = filteredModelChoices(widget, search.value, 60);
		if ((autoPick || !String(widget?.value || "").trim()) && options.length) {
			applyValue(options[0]);
		}
		current.textContent = `当前：${String(widget?.value || "未选择")}`;
		list.replaceChildren();
		if (!options.length) {
			const empty = document.createElement("div");
			empty.style.cssText = "color:#8da2ad;font-size:11px;padding:4px 2px;";
			empty.textContent = "没有匹配模型";
			list.appendChild(empty);
			return;
		}
		for (const option of options) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = `${String(option || "") === String(widget?.value || "") ? "✓ " : ""}${option || "未选择"}`;
			button.title = option || "未选择";
			button.style.cssText = "width:100%;display:block;text-align:left;background:#182127;color:#dce7e2;border:1px solid #33454c;border-radius:6px;padding:5px 7px;box-sizing:border-box;white-space:normal;word-break:break-all;cursor:pointer;";
			if (String(option || "") === String(widget?.value || "")) {
				button.style.background = "#18352f";
				button.style.borderColor = "#2f7d67";
			}
			button.addEventListener("click", () => {
				applyValue(option);
				render(false);
			});
			list.appendChild(button);
		}
	};
	search.addEventListener("input", () => render(true));
	search.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			const first = filteredModelChoices(widget, search.value, 1)[0];
			if (first != null) {
				applyValue(first);
				render(false);
			}
		}
	});
	wrap.append(top, search, current, list);
	render(false);
	return wrap;
}

function displayModelFilename(value, fallback = "") {
	const text = String(value || fallback || "").trim();
	if (!text) {
		return "未选择";
	}
	return text.replace(/\\/g, "/").split("/").pop() || text;
}

function modelTreeLine(prefix, icon, filename, { clickable = false, selected = false } = {}) {
	const row = document.createElement(clickable ? "button" : "div");
	if (clickable) {
		row.type = "button";
	}
	row.style.cssText = [
		"display:block",
		"width:100%",
		"border:0",
		"background:" + (selected ? "#18352f" : "transparent"),
		"color:#dce7e2",
		"padding:2px 4px",
		"border-radius:5px",
		"text-align:left",
		"font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace",
		"white-space:pre",
		"cursor:" + (clickable ? "pointer" : "default"),
	].join(";");
	row.textContent = `${prefix}${icon} ${filename}`;
	if (clickable) {
		row.addEventListener("mouseenter", () => {
			if (!selected) row.style.background = "#17262d";
		});
		row.addEventListener("mouseleave", () => {
			if (!selected) row.style.background = "transparent";
		});
	}
	return row;
}

function makeModelChoicePanel(node, widget, onApply, strengthWidget = null) {
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;flex-direction:column;gap:5px;margin:3px 0 5px 26px;padding:7px;border:1px solid #33454c;border-radius:8px;background:#11181c;";
	if (strengthWidget) {
		const strengthRow = document.createElement("label");
		strengthRow.style.cssText = "display:grid;grid-template-columns:52px minmax(0,1fr);gap:6px;align-items:center;color:#b9c9cf;";
		const strengthLabel = document.createElement("span");
		strengthLabel.textContent = "强度";
		const strength = document.createElement("input");
		strength.type = "number";
		strength.step = "0.01";
		strength.value = String(strengthWidget.value ?? "");
		strength.style.cssText = "min-width:0;background:#0d1418;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:5px 7px;box-sizing:border-box;";
		strength.addEventListener("change", () => {
			setWidgetValue(strengthWidget, coerceWidgetValue(strengthWidget, strength.value));
			syncWidgetValuesCache(node);
			refreshNode(node);
		});
		strengthRow.append(strengthLabel, strength);
		wrap.appendChild(strengthRow);
	}
	const search = document.createElement("input");
	search.type = "text";
	search.placeholder = "输入关键词，自动使用第一个匹配模型";
	search.style.cssText = "width:100%;background:#0d1418;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:5px 7px;box-sizing:border-box;";
	const list = document.createElement("div");
	list.style.cssText = "display:flex;flex-direction:column;gap:4px;max-height:210px;overflow:auto;";

	const render = (autoPick = false) => {
		const options = filteredModelChoices(widget, search.value, 80);
		if (autoPick && options.length) {
			onApply(options[0]);
		}
		list.replaceChildren();
		if (!options.length) {
			const empty = document.createElement("div");
			empty.style.cssText = "color:#8da2ad;font-size:11px;padding:4px 2px;";
			empty.textContent = "没有匹配模型";
			list.appendChild(empty);
			return;
		}
		for (const option of options) {
			const button = document.createElement("button");
			button.type = "button";
			const selected = String(option || "") === String(widget?.value || "");
			button.textContent = `${selected ? "✓ " : ""}${displayModelFilename(option)}`;
			button.title = String(option || "");
			button.style.cssText = [
				"width:100%",
				"display:block",
				"text-align:left",
				"background:" + (selected ? "#18352f" : "#182127"),
				"color:#dce7e2",
				"border:1px solid " + (selected ? "#2f7d67" : "#33454c"),
				"border-radius:6px",
				"padding:5px 7px",
				"box-sizing:border-box",
				"white-space:normal",
				"word-break:break-all",
				"cursor:pointer",
			].join(";");
			button.addEventListener("click", () => {
				onApply(option);
				render(false);
			});
			list.appendChild(button);
		}
	};
	search.addEventListener("input", () => render(true));
	search.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			const first = filteredModelChoices(widget, search.value, 1)[0];
			if (first != null) {
				onApply(first);
				render(false);
			}
		}
	});
	wrap.append(search, list);
	render(false);
	setTimeout(() => search.focus(), 0);
	return wrap;
}

function characterModelTreeEntries(node) {
	return [
		{
			widget: UNET_WIDGET,
			label: "主模型",
			folder: "diffusion_models",
			icon: "🟣",
			models: widgetChoices(getWidget(node, UNET_WIDGET)) || [],
			keywords: ["qwen", "image", "edit", "2511"],
			fallback: "qwen_image_edit_2511_int8_convrot.safetensors",
			description: "Qwen Image Edit 2511 多视图主生成模型。",
		},
		{
			widget: LORA2_WIDGET,
			label: "多角度 LoRA",
			folder: "loras",
			icon: "🟠",
			models: widgetChoices(getWidget(node, LORA2_WIDGET)) || [],
			keywords: [],
			fallback: DEFAULT_MULTI_ANGLES_LORA,
			description: "多视图角度一致性 LoRA。",
			strengthWidgetName: LORA2_STRENGTH_WIDGET,
		},
		{
			widget: LORA1_WIDGET,
			label: "Lightning LoRA",
			folder: "loras",
			icon: "🟠",
			models: widgetChoices(getWidget(node, LORA1_WIDGET)) || [],
			keywords: [],
			fallback: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
			description: "Qwen Image Edit 2511 加速 LoRA。",
			strengthWidgetName: LORA1_STRENGTH_WIDGET,
		},
		{
			widget: RMBG_WIDGET,
			label: "RMBG1.4",
			folder: "RMBG",
			icon: "🟣",
			models: widgetChoices(getWidget(node, RMBG_WIDGET)) || [],
			keywords: ["rmbg", "1.4"],
			fallback: DEFAULT_RMBG14_MODEL,
			description: "人物资产分支使用的 RMBG 抠图模型。",
		},
		{
			widget: CLIP_WIDGET,
			label: "CLIP / VL",
			folder: "text_encoders",
			icon: "🟡",
			models: widgetChoices(getWidget(node, CLIP_WIDGET)) || [],
			keywords: ["qwen", "2.5", "vl"],
			fallback: DEFAULT_QWEN2511_CLIP,
			description: "Qwen Image Edit 2511 文本/视觉编码器。",
		},
		{
			widget: VAE_WIDGET,
			label: "VAE",
			folder: "vae",
			icon: "🔴",
			models: widgetChoices(getWidget(node, VAE_WIDGET)) || [],
			keywords: ["qwen", "image", "vae"],
			fallback: DEFAULT_QWEN2511_VAE,
			description: "Qwen Image VAE。",
		},
	];
}

function makeClickableModelTreeFile(node, widgetName, prefix, icon, fallback = "", afterApply = null, strengthWidgetName = "", popup = null) {
	const widget = getWidget(node, widgetName);
	const strengthWidget = strengthWidgetName ? getWidget(node, strengthWidgetName) : null;
	if (widget && !String(widget.value || "").trim()) {
		const first = filteredModelChoices(widget, "", 1).find((item) => String(item || "").trim());
		if (first) {
			setWidgetValue(widget, first);
		}
	}
	const host = document.createElement("div");
	let choicePanel = null;
	const renderLine = () => {
		const filename = displayModelFilename(widget?.value, fallback);
		const line = modelTreeLine(prefix, icon, filename, { clickable: true, selected: Boolean(choicePanel) });
		line.title = String(widget?.value || fallback || "");
		line.addEventListener("click", () => {
			if (choicePanel) {
				choicePanel.remove();
				choicePanel = null;
				renderLine();
				return;
			}
			choicePanel = makeModelChoicePanel(node, widget, (value) => {
				const choices = mutableWidgetChoices(widget);
				if (choices && value && !choices.includes(value)) {
					choices.unshift(value);
				}
				setWidgetValue(widget, value);
				afterApply?.(value);
				syncWidgetValuesCache(node);
				refreshNode(node);
				renderLine();
			}, strengthWidget);
			host.appendChild(choicePanel);
			renderLine();
		});
		const existing = host.firstChild;
		if (existing) {
			host.replaceChild(line, existing);
		} else {
			host.prepend(line);
		}
	};
	renderLine();
	popup?.refreshers?.add(renderLine);
	return host;
}

function makeModelTreeView(node, popup = null) {
	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:1px;padding:8px;border:1px solid #33454c;border-radius:8px;background:#0f171b;overflow:auto;";
	root.append(
		modelTreeLine("", "📁", "models/"),
		modelTreeLine("├─", "📁", "diffusion_models/"),
		makeClickableModelTreeFile(node, UNET_WIDGET, "│　└─", "🟣", "", () => applyPresetForCurrentModel(node), "", popup),
		modelTreeLine("├─", "📁", "loras/"),
		makeClickableModelTreeFile(node, LORA2_WIDGET, "│　└─", "🟠", DEFAULT_MULTI_ANGLES_LORA, null, LORA2_STRENGTH_WIDGET, popup),
		makeClickableModelTreeFile(node, LORA1_WIDGET, "│　└─", "🟠", "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", null, LORA1_STRENGTH_WIDGET, popup),
		modelTreeLine("├─", "📁", "RMBG/"),
		makeClickableModelTreeFile(node, RMBG_WIDGET, "│　└─", "🟣", DEFAULT_RMBG14_MODEL, null, "", popup),
		modelTreeLine("├─", "📁", "text_encoders/"),
		makeClickableModelTreeFile(node, CLIP_WIDGET, "│　└─", "🟡", DEFAULT_QWEN2511_CLIP, null, "", popup),
		modelTreeLine("├─", "📁", "vae/"),
		makeClickableModelTreeFile(node, VAE_WIDGET, "│　└─", "🔴", DEFAULT_QWEN2511_VAE, null, "", popup)
	);
	return root;
}

function openModelFloatingPanel(node, anchor) {
	if (node?.properties?.[FLOATING_PANEL_PROPERTY] === "models") {
		closeCharacterMultiViewFloatingPanels();
		return;
	}
	const popup = makeFloatingPanel(node, "models", anchor, "🧠 模型");
	popup.titleEl.appendChild(makeKeepModelHeaderButton(node));
	const renderTree = () => {
		popup.body.replaceChildren(
			GJJ_Utils.createModelTreeView({
				node,
				entries: characterModelTreeEntries(node),
				refresh: () => {
					requestAnimationFrame(() => {
						syncWidgetValuesCache(node);
						renderLoraList(node);
						updateFloatingButtonStates(node);
						app.graph?.setDirtyCanvas?.(true, true);
					});
				},
				onApply: (entry, value) => {
					if (entry.widget === UNET_WIDGET) {
						applyPresetForCurrentModel(node, true);
					}
					syncWidgetValuesCache(node);
				},
			})
		);
	};
	popup.refresh = renderTree;
	renderTree();
	popup.reposition();
}

function openSettingsFloatingPanel(node, anchor) {
	if (node?.properties?.[FLOATING_PANEL_PROPERTY] === "settings") {
		closeCharacterMultiViewFloatingPanels();
		return;
	}
	const popup = makeFloatingPanel(node, "settings", anchor, "⚙️ 参数");
	popup.body.append(
		makeTextRow(node, BASE_PROMPT_WIDGET),
		makeTextRow(node, "negative_prompt"),
		makeNumberRow(node, "seed"),
		makeBooleanRow(node, "save_each_image"),
		makeNumberRow(node, "sampling_steps"),
		makeNumberRow(node, "sampling_cfg"),
		makeComboRow(node, "sampling_sampler"),
		makeComboRow(node, "sampling_scheduler"),
		makeNumberRow(node, "sampling_denoise")
	);
	popup.reposition();
}

function updateFloatingButtonStates(node) {
	const active = String(node?.properties?.[FLOATING_PANEL_PROPERTY] || "");
	const modelButton = node?.__gjjCharacterMultiViewKeepModelButton;
	const settingsButton = node?.__gjjCharacterMultiViewSettingsButton;
	if (modelButton) {
		const enabled = keepModelEnabled(node);
		modelButton.textContent = "🧠";
		modelButton.title = "打开模型窗口：主模型、微调模型、保持模型。";
		applyToolbarToggleStyle(modelButton, enabled, {
			onBg: "#1d3d34",
			onBorder: "#54c985",
			onColor: "#eafff2",
			onInset: "rgba(111,255,174,0.28)",
			onGlow: "rgba(84,201,133,0.32)",
		});
		if (active === "models") {
			modelButton.style.boxShadow = `${modelButton.style.boxShadow}, 0 0 0 2px rgba(127,167,187,0.38)`;
		}
	}
	updateKeepModelHeaderButtonState(node);
	if (settingsButton) {
		const open = active === "settings";
		settingsButton.textContent = "⚙️";
		settingsButton.title = "打开参数窗口：提示词、种子、采样参数、保存选项。";
		settingsButton.style.background = open ? "#2a3f4a" : "#172026";
		settingsButton.style.borderColor = open ? "#5a7a8a" : "#41535b";
		settingsButton.style.color = open ? "#ffffff" : "#dce7e2";
	}
}

async function runCurrentCharacterMultiViewNode(node) {
	const button = node?.__gjjCharacterMultiViewRunButton;
	const previousOutputNode = node?.constructor?.nodeData?.output_node;
	try {
		if (button) {
			button.disabled = true;
			button.textContent = "…";
		}
		enforceRequiredModelChoices(node);
		const randomizedSeed = randomizeSeedIfEnabled(node);
		clearLivePreview(node);
		node.properties ||= {};
		node.properties[TEMP_OUTPUT_NODE_FLAG] = true;
		if (node.constructor?.nodeData) node.constructor.nodeData.output_node = true;
		node.output_node = true;
		const queued = await queueOnlyCurrentNode(node);
		setStatus(node, queued
			? (randomizedSeed == null ? "已加入队列" : `已加入队列，随机种子：${randomizedSeed}`)
			: "运行失败");
	} catch (error) {
		setStatus(node, `运行失败：${error?.message || error}`);
	} finally {
		if (node?.properties) delete node.properties[TEMP_OUTPUT_NODE_FLAG];
		if (node?.constructor?.nodeData) node.constructor.nodeData.output_node = previousOutputNode;
		if (node) delete node.output_node;
		if (button) {
			button.disabled = false;
			button.textContent = "▶";
		}
	}
}

function widgetVisibilityRank(widget) {
	const name = String(widget?.name || "");
	if (name === PRESET_WIDGET_NAME) return 0;
	if (name === ACTION_TEXT_WIDGET) return 1;
	if (name === LORA_LIST_WIDGET_NAME) return 2;
	if (name === PREVIEW_WIDGET_NAME) return 3;
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
	const open = false;
	const hiddenLoraWidgets = new Set([
		LORA1_WIDGET,
		LORA1_STRENGTH_WIDGET,
		LORA2_WIDGET,
		LORA2_STRENGTH_WIDGET,
		LORA3_WIDGET,
		LORA3_STRENGTH_WIDGET,
	]);
	for (const widget of node.widgets) {
		const name = String(widget?.name || "");
		if (name === PRESET_WIDGET_NAME || name === ACTION_TEXT_WIDGET || name === PREVIEW_WIDGET_NAME) {
			setWidgetHidden(widget, false);
		} else if (name === LORA_LIST_WIDGET_NAME) {
			const container = node.__gjjCharacterMultiViewLoraContainer;
			if (container?.style) {
				container.style.display = open ? "flex" : "none";
			}
			setWidgetHidden(widget, !open);
		} else if (name === STATUS_WIDGET_NAME) {
			setWidgetHidden(widget, true);
		} else if (hiddenLoraWidgets.has(name)) {
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
	updateKeepModelButtonState(node);
	updateRandomSeedButtonState(node);
	renderLoraList(node);
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
	container.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 2px;align-items:center;overflow:hidden;";

	const setActionLines = (lines) => {
		setWidgetValue(textWidget, lines.join("\n"));
		if (!lines.length) {
			setWidgetValue(getWidget(node, TEMPLATE_NAME_WIDGET), "");
		}
		syncWidgetValuesCache(node);
		refreshNode(node);
	};

	const openImageButton = createButton("📁", "打开本地图片，上传后自动接入主图。", () => openMainImageFile(node));
	node.__gjjCharacterMultiViewMainImageButton = openImageButton;
	container.appendChild(openImageButton);

	const runButton = createButton("▶", "运行当前主体一键多视图节点，不需要外接输出。", () => runCurrentCharacterMultiViewNode(node));
	node.__gjjCharacterMultiViewRunButton = runButton;

	const keepModelButton = createButton("🧠", "打开模型窗口：主模型、微调模型、保持模型。", (event) => {
		openModelFloatingPanel(node, event.currentTarget || keepModelButton);
	});
	node.__gjjCharacterMultiViewKeepModelButton = keepModelButton;
	container.appendChild(keepModelButton);

	const randomSeedButton = createButton("🎲", "随机种：关闭。点击开启每次运行前自动更换随机种子。", () => {
		setRandomSeedEnabled(node, !randomSeedEnabled(node));
	});
	node.__gjjCharacterMultiViewRandomSeedButton = randomSeedButton;
	container.appendChild(randomSeedButton);

	const templateEditorButton = createButton("📚", "编辑多视图模板，保存到 presets/gjj_character_multiview_templates.txt。", () => openTemplateEditor(node));
	node.__gjjCharacterMultiViewTemplateEditorButton = templateEditorButton;
	container.appendChild(templateEditorButton);

	const clearButton = createButton("清空动作", "清空动作文本列表", () => setActionLines([]));
	node.__gjjCharacterMultiViewTemplateButtons = container;
	node.__gjjCharacterMultiViewTemplateInsertBefore = clearButton;
	node.__gjjCharacterMultiViewTemplateButtonElements = [];
	container.appendChild(clearButton);
	const settingsButton = createButton("⚙️", "打开参数窗口：提示词、种子、采样参数、保存选项。", (event) => {
		openSettingsFloatingPanel(node, event.currentTarget || settingsButton);
	});
	node.__gjjCharacterMultiViewSettingsButton = settingsButton;
	container.appendChild(settingsButton);
	container.appendChild(runButton);
	refreshTemplateButtons(node).catch((error) => {
		console.warn("[GJJ CharacterMultiViewStudio] 模板按钮刷新失败。", error);
		node.__gjjCharacterMultiViewTemplateText = DEFAULT_TEMPLATE_TEXT;
		renderTemplateButtons(node);
	});

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
	updateKeepModelButtonState(node);
	updateRandomSeedButtonState(node);
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

function previewLayoutMode(node) {
	const mode = String(node?.properties?.[PREVIEW_LAYOUT_PROPERTY] || "tile");
	return mode === "page" ? "page" : "tile";
}

function setPreviewLayoutMode(node, mode) {
	node.properties ||= {};
	node.properties[PREVIEW_LAYOUT_PROPERTY] = mode === "page" ? "page" : "tile";
	updateLivePreviewLayout(node);
	refreshNode(node);
}

function previewPageIndex(node, total = 0) {
	node.properties ||= {};
	const max = Math.max(0, Number(total || 0) - 1);
	const value = Math.max(0, Math.floor(Number(node.properties[PREVIEW_PAGE_PROPERTY] || 0) || 0));
	const next = Math.min(value, max);
	node.properties[PREVIEW_PAGE_PROPERTY] = next;
	return next;
}

function setPreviewPageIndex(node, index) {
	node.properties ||= {};
	const wrap = node?.__gjjCharacterMultiViewPreview?.wrap;
	const total = Number(wrap?.children?.length || 0);
	const max = Math.max(0, total - 1);
	node.properties[PREVIEW_PAGE_PROPERTY] = Math.max(0, Math.min(max, Math.floor(Number(index || 0) || 0)));
	updateLivePreviewLayout(node);
	refreshNode(node);
}

function ensurePreviewWidget(node) {
	if (node.__gjjCharacterMultiViewPreview) {
		return;
	}
	const root = document.createElement("div");
	root.style.cssText = [
		"display:none",
		"width:100%",
		"box-sizing:border-box",
		"padding:4px 0 2px",
	].join(";");
	const controls = document.createElement("div");
	controls.style.cssText = [
		"display:none",
		"align-items:center",
		"gap:5px",
		"margin:0 0 5px",
		"min-height:24px",
	].join(";");
	const modeButton = createButton("平铺", "切换多图浏览方式：平铺 / 分页。", () => {
		setPreviewLayoutMode(node, previewLayoutMode(node) === "page" ? "tile" : "page");
	});
	modeButton.style.height = "22px";
	modeButton.style.fontSize = "11px";
	const prevButton = createButton("◀", "上一张预览。", () => {
		const total = Number(node.__gjjCharacterMultiViewPreview?.wrap?.children?.length || 0);
		setPreviewPageIndex(node, previewPageIndex(node, total) - 1);
	});
	prevButton.style.height = "22px";
	prevButton.style.width = "24px";
	const pageLabel = document.createElement("span");
	pageLabel.style.cssText = "color:#9eb3b7;font:11px/1.2 system-ui,\"Microsoft YaHei\",sans-serif;min-width:48px;text-align:center;";
	const nextButton = createButton("▶", "下一张预览。", () => {
		const total = Number(node.__gjjCharacterMultiViewPreview?.wrap?.children?.length || 0);
		setPreviewPageIndex(node, previewPageIndex(node, total) + 1);
	});
	nextButton.style.height = "22px";
	nextButton.style.width = "24px";
	controls.append(modeButton, prevButton, pageLabel, nextButton);
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:grid",
		"grid-template-columns:repeat(auto-fill,minmax(86px,1fr))",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");
	root.append(controls, wrap);
	const widget = node.addDOMWidget?.(PREVIEW_WIDGET_NAME, PREVIEW_WIDGET_NAME, root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => {
			if (root.style.display === "none") {
				return 0;
			}
			return Math.max(96, Math.ceil(root.scrollHeight || root.offsetHeight || 96));
		},
	});
	if (widget) {
		widget.serialize = false;
		widget.options ||= {};
		widget.options.serialize = false;
		widget.value = undefined;
		widget.computeSize = (width) => [
			Math.max(280, width || 280),
			root.style.display === "none" ? 0 : Math.max(96, Math.ceil(root.scrollHeight || root.offsetHeight || 96)),
		];
	}
	node.__gjjCharacterMultiViewPreview = { widget, root, wrap, controls, modeButton, prevButton, nextButton, pageLabel };
}

function clearLivePreview(node) {
	const preview = node?.__gjjCharacterMultiViewPreview;
	const wrap = preview?.wrap;
	if (!wrap || !preview?.root) {
		return;
	}
	wrap.replaceChildren();
	preview.root.style.display = "none";
	refreshNode(node);
}

function mediaAspectRatio(item) {
	const width = Number(item?.width || 0);
	const height = Number(item?.height || 0);
	return width > 0 && height > 0 ? `${width} / ${height}` : "1 / 1";
}

function updateLivePreviewLayout(node) {
	const preview = node?.__gjjCharacterMultiViewPreview;
	const wrap = preview?.wrap;
	if (!wrap || !preview?.root) {
		return;
	}
	const cards = Array.from(wrap.children || []);
	if (!cards.length) {
		preview.root.style.display = "none";
		return;
	}
	preview.root.style.display = "block";
	wrap.style.display = "grid";
	const mode = previewLayoutMode(node);
	const paged = mode === "page" && cards.length > 1;
	const page = previewPageIndex(node, cards.length);
	if (preview.controls) preview.controls.style.display = cards.length > 1 ? "flex" : "none";
	if (preview.modeButton) {
		preview.modeButton.textContent = paged ? "分页" : "平铺";
		preview.modeButton.title = paged ? "当前为分页浏览，点击切换为平铺。" : "当前为平铺浏览，点击切换为分页。";
		preview.modeButton.__gjjToggleButton = paged;
		preview.modeButton.style.background = paged ? "#245c42" : "#172026";
		preview.modeButton.style.borderColor = paged ? "#5fc585" : "#41535b";
		preview.modeButton.style.color = paged ? "#ffffff" : "#dce7e2";
	}
	if (preview.pageLabel) preview.pageLabel.textContent = `${page + 1}/${cards.length}`;
	if (preview.prevButton) preview.prevButton.disabled = !paged || page <= 0;
	if (preview.nextButton) preview.nextButton.disabled = !paged || page >= cards.length - 1;
	const single = cards.length === 1 || paged;
	wrap.style.gridTemplateColumns = single ? "minmax(0, 1fr)" : "repeat(auto-fill,minmax(86px,1fr))";
	for (const [index, card] of cards.entries()) {
		card.style.display = !paged || index === page ? "block" : "none";
		const item = card.__gjjCharacterMultiViewPreviewItem || {};
		card.style.aspectRatio = single ? mediaAspectRatio(item) : "1 / 1";
		const image = card.querySelector("img");
		if (image) {
			image.style.objectFit = single ? "contain" : "cover";
		}
	}
}

function currentLivePreviewItems(node) {
	const wrap = node?.__gjjCharacterMultiViewPreview?.wrap;
	return Array.from(wrap?.children || [])
		.map((card) => card.__gjjCharacterMultiViewPreviewItem)
		.filter((item) => item?.filename);
}

function openLivePreviewOverlay(node, startItem) {
	const items = currentLivePreviewItems(node);
	if (!items.length) {
		return;
	}
	let index = Math.max(0, items.findIndex((item) => item === startItem));
	if (index < 0) index = 0;
	let scale = 1;

	const overlay = document.createElement("div");
	overlay.style.cssText = [
		"position:fixed",
		"inset:0",
		"z-index:100000",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"background:rgba(0,0,0,.9)",
		"cursor:zoom-out",
		"overflow:hidden",
	].join(";");
	const image = document.createElement("img");
	image.draggable = false;
	image.style.cssText = [
		"max-width:92vw",
		"max-height:92vh",
		"object-fit:contain",
		"border-radius:8px",
		"box-shadow:0 16px 42px rgba(0,0,0,.5)",
		"transform-origin:center center",
		"transition:transform .08s ease",
		"cursor:zoom-in",
	].join(";");
	const badge = document.createElement("div");
	badge.style.cssText = [
		"position:absolute",
		"right:18px",
		"bottom:16px",
		"padding:5px 10px",
		"border-radius:999px",
		"background:rgba(0,0,0,.55)",
		"color:#fff",
		"font:12px/1.2 system-ui,\"Microsoft YaHei\",sans-serif",
		"pointer-events:none",
	].join(";");
	const render = () => {
		const item = items[index] || items[0];
		image.src = mediaItemToUrl(item);
		image.style.transform = `scale(${scale})`;
		badge.textContent = `${index + 1}/${items.length} · ${Math.round(scale * 100)}%`;
	};
	const cycle = (delta = 1) => {
		index = (index + delta + items.length) % items.length;
		scale = 1;
		render();
	};
	const close = () => {
		window.removeEventListener("keydown", onKeyDown, true);
		overlay.remove();
	};
	const onKeyDown = (event) => {
		if (event.code === "Space") {
			event.preventDefault();
			event.stopPropagation();
			cycle(1);
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			event.stopPropagation();
			cycle(1);
		} else if (event.key === "ArrowLeft") {
			event.preventDefault();
			event.stopPropagation();
			cycle(-1);
		}
	};
	overlay.addEventListener("wheel", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const factor = event.deltaY < 0 ? 1.12 : 0.89;
		scale = Math.min(8, Math.max(0.2, scale * factor));
		render();
	}, { passive: false });
	overlay.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		close();
	});
	image.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		close();
	});
	overlay.append(image, badge);
	document.body.appendChild(overlay);
	window.addEventListener("keydown", onKeyDown, true);
	render();
}

function appendLivePreviewImage(node, item) {
	const wrap = node?.__gjjCharacterMultiViewPreview?.wrap;
	if (!wrap || !item?.filename) {
		return;
	}
	wrap.style.display = "grid";
	const card = document.createElement("div");
	card.style.cssText = [
		"position:relative",
		"aspect-ratio:1/1",
		"overflow:hidden",
		"border:1px solid #33434a",
		"border-radius:7px",
		"background:#0c1114",
		"box-sizing:border-box",
	].join(";");
	card.__gjjCharacterMultiViewPreviewItem = item;
	card.title = "点击放大预览；拖到其它节点或画布可使用这张图";
	card.style.cursor = "grab";
	card.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openLivePreviewOverlay(node, item);
	});
	const image = document.createElement("img");
	image.draggable = false;
	image.src = mediaItemToUrl(item);
	image.style.cssText = [
		"width:100%",
		"height:100%",
		"object-fit:cover",
		"display:block",
	].join(";");
	image.onload = () => refreshNode(node);
	setupPreviewImageDrag(card, image, node, item);
	const badge = document.createElement("div");
	badge.textContent = String(item.index || wrap.children.length + 1);
	badge.style.cssText = [
		"position:absolute",
		"right:5px",
		"bottom:5px",
		"padding:2px 6px",
		"border-radius:999px",
		"background:rgba(0,0,0,.58)",
		"color:#fff",
		"font-size:10px",
		"font-weight:700",
		"line-height:1.2",
		"pointer-events:none",
	].join(";");
	card.append(image, badge);
	wrap.appendChild(card);
	updateLivePreviewLayout(node);
	refreshNode(node);
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

	clearNativePreview(node);
	ensureToolbar(node);
	ensurePreviewWidget(node);
	ensureStatusWidget(node);
	ensureLoraListWidget(node);
	ensureOutputs(node);
	applyChineseLabelsAndTooltips(node);
	enforceRequiredModelChoices(node);
	stabilizeActions(node);
	applyModelPreset(node, true);
	applyCompactVisibility(node);
	applyChineseLabelsAndTooltips(node);

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
		const width = message?.images?.[0]?.width || message?.preview_images?.[0]?.width;
		const height = message?.images?.[0]?.height || message?.preview_images?.[0]?.height;
		clearExecutedPreviewPayload(message);
		const result = typeof originalExecuted === "function"
			? originalExecuted.apply(this, arguments)
			: undefined;
		setStatus(this, width && height ? `完成：${width} × ${height}` : "完成");
		scheduleNativePreviewClear(this);
		return result;
	};

	setStatus(node, "等待执行");
	applyCompactVisibility(node);
	applyChineseLabelsAndTooltips(node);
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

api.addEventListener("gjj_character_multiview_preview", (event) => {
	const detail = event?.detail || {};
	const nodeId = String(detail.node || "");
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			continue;
		}
		if (String(node.id) !== nodeId) {
			continue;
		}
		ensurePreviewWidget(node);
		if (detail.reset) {
			clearLivePreview(node);
		}
		if (detail.image) {
			appendLivePreviewImage(node, detail.image);
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
		nodeData.output_preview = false;
		nodeType.prototype.hideOutputImages = true;
		if (Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}
		const originalAddCustomWidget = nodeType.prototype.addCustomWidget;
		nodeType.prototype.addCustomWidget = function (widget, ...args) {
			if (isNativePreviewWidget(this, widget)) {
				return hideNativePreviewWidget(widget);
			}
			return typeof originalAddCustomWidget === "function"
				? originalAddCustomWidget.call(this, widget, ...args)
				: widget;
		};
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = typeof originalOnNodeCreated === "function"
				? originalOnNodeCreated.apply(this, args)
				: undefined;
			clearNativePreview(this);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = typeof originalOnConfigure === "function"
				? originalOnConfigure.call(this, serializedNode, ...args)
				: undefined;
			clearNativePreview(this);
			restoreSerializedValues(this, serializedNode);
			setTimeout(() => {
				clearNativePreview(this);
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
		ensurePreviewDropHandler();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				patchNode(node);
			}
		}
	},
});

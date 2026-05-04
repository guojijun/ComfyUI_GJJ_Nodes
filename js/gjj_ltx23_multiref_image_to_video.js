import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set([
	"GJJ_LTX23ImageToVideoMultiRef",
	"GJJ_LTX23WorkflowMultiImageReference",
	"GJJ_LTX23WorkflowDigitalHumanMultiRef",
	"GJJ_LTX23WorkflowFourPanel",
	"GJJ_LTX23WorkflowAllReference",
]);
const SCENE_PREFIX = "scene_";
const STATUS_WIDGET_NAME = "gjj_ltx23_multiref_status";
const MIN_VISIBLE_SCENES = 1;
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const PANEL_WIDTH_PROPERTY = "gjj_ltx23_multiref_panel_width";
const PANEL_HEIGHT_PROPERTY = "gjj_ltx23_multiref_panel_height";
const PANEL_SIZE_SOURCE_PROPERTY = "gjj_ltx23_multiref_panel_size_source";
const BATCH_SCENES_INPUT_NAME = "batch_scenes";
const LORA_CHAIN_INPUT_NAME = "lora_chain_config";
const AUDIO_INPUT_NAME = "input_audio";
const REFERENCE_VIDEO_INPUT_NAME = "reference_video";
const MULTI_IMAGE_LOADER_CLASS = "GJJ_MultiImageLoader";
const FIXED_INPUT_ORDER = [BATCH_SCENES_INPUT_NAME, LORA_CHAIN_INPUT_NAME, AUDIO_INPUT_NAME, REFERENCE_VIDEO_INPUT_NAME];
const PROMPT_WIDGETS = new Set(["positive_prompt", "negative_prompt"]);
const LEGACY_WIDGET_NAMES = new Set([
  "duration_seconds",
  "guide_2_seconds",
  "guide_3_seconds",
  "guide_4_seconds",
  "guide_5_seconds",
  "output_long_edge",
  "distilled_lora_name",
  "distilled_lora_strength",
  "talking_head_lora_name",
  "talking_head_lora_strength",
  "transition_lora_name",
  "transition_lora_strength",
  "headswap_lora_name",
  "headswap_lora_strength",
]);
const LORA_NOTICE_RE = /LoRA.+(未找到|跳过)|以下可选 LoRA 未找到|已自动跳过/i;
const TRANSITION_TOGGLE_WIDGET = "transition_enabled";
const TRANSITION_CONTROL_WIDGETS = [
	["transition_curve", "过渡曲线"],
	["transition_early_tail_ratio", "尾帧提前注入"],
	["transition_implicit_guide_count", "中间隐式guide"],
	["transition_implicit_guide_strength", "隐式guide强度"],
	["transition_early_tail_strength", "提前尾帧强度"],
	["transition_final_guide_strength", "终点guide强度"],
];

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => String(widget?.name || "") === String(name || "")) || null;
}

function getWidgetIndex(node, name) {
	return node?.widgets?.findIndex((widget) => String(widget?.name || "") === String(name || "")) ?? -1;
}

function getInput(node, name) {
	return node?.inputs?.find((input) => String(input?.name || "") === String(name || "")) || null;
}

function getSizeInput(node, name) {
	const candidates = new Set([String(name || ""), `${String(name || "")}_input`]);
	return node?.inputs?.find((input) => candidates.has(String(input?.name || ""))) || null;
}

function isSizeInputConnected(node, name) {
	return Boolean(getSizeInput(node, name)?.link);
}

function hasAnySizeInputConnected(node) {
	return isSizeInputConnected(node, WIDTH_WIDGET) || isSizeInputConnected(node, HEIGHT_WIDGET);
}

function normalizeDimension(value) {
	return Math.max(64, Math.round(Number(value || 0) || 0));
}

function persistedDimension(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? normalizeDimension(numeric) : null;
}

function ensureNodeProperties(node) {
	if (!node.properties) {
		node.properties = {};
	}
	return node.properties;
}

function clearPersistedPanelSize(node) {
	if (!node) {
		return;
	}
	const properties = ensureNodeProperties(node);
	delete properties[PANEL_WIDTH_PROPERTY];
	delete properties[PANEL_HEIGHT_PROPERTY];
	delete properties[PANEL_SIZE_SOURCE_PROPERTY];
}

function panelSizeFromWidgets(node) {
	const width = persistedDimension(getWidget(node, WIDTH_WIDGET)?.value);
	const height = persistedDimension(getWidget(node, HEIGHT_WIDGET)?.value);
	return width && height ? { width, height } : null;
}

function panelSizeFromProperties(node) {
	const properties = node?.properties || {};
	const width = persistedDimension(properties[PANEL_WIDTH_PROPERTY]);
	const height = persistedDimension(properties[PANEL_HEIGHT_PROPERTY]);
	return width && height ? { width, height } : null;
}

function persistPanelSize(node, sourceSignature = null) {
	if (!node) {
		return;
	}
	if (hasAnySizeInputConnected(node)) {
		clearPersistedPanelSize(node);
		return;
	}
	const size = panelSizeFromWidgets(node);
	if (!size) {
		return;
	}
	const properties = ensureNodeProperties(node);
	properties[PANEL_WIDTH_PROPERTY] = size.width;
	properties[PANEL_HEIGHT_PROPERTY] = size.height;
	const currentSource = imageSourceSignature(node);
	const signature = sourceSignature ?? (
		node.__gjjLtx23MultiRefAppliedSizeSignature === currentSource ? currentSource : ""
	);
	if (signature) {
		properties[PANEL_SIZE_SOURCE_PROPERTY] = String(signature);
	} else {
		delete properties[PANEL_SIZE_SOURCE_PROPERTY];
	}
}

function restorePanelSizeFromProperties(node) {
	if (!node || hasAnySizeInputConnected(node)) {
		return false;
	}
	const size = panelSizeFromProperties(node);
	if (!size) {
		return false;
	}
	applyPanelSize(node, size.width, size.height, { persist: false });
	const currentSource = imageSourceSignature(node);
	const storedSource = String(node.properties?.[PANEL_SIZE_SOURCE_PROPERTY] || "");
	if (storedSource && storedSource === currentSource) {
		node.__gjjLtx23MultiRefAppliedSizeSignature = storedSource;
	}
	return true;
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	if (widget.inputEl && "value" in widget.inputEl) {
		widget.inputEl.value = String(value);
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = String(value);
	}
	widget.callback?.(value);
}

function widgetBooleanValue(widget) {
	if (!widget) {
		return false;
	}
	if (typeof widget.value === "boolean") {
		return widget.value;
	}
	const text = String(widget.value ?? "").trim().toLowerCase();
	return ["true", "1", "yes", "on"].includes(text);
}

function getDomWidgetTargets(widget) {
	const seeds = [widget?.inputEl, widget?.element].filter(Boolean);
	const targets = [];
	const seen = new Set();
	const addTarget = (element) => {
		if (!element || seen.has(element)) {
			return;
		}
		seen.add(element);
		targets.push(element);
	};
	for (const seed of seeds) {
		addTarget(seed);
		let current = seed.parentElement;
		let depth = 0;
		while (current && depth < 4) {
			const className = String(current.className || "");
			const tagName = String(current.tagName || "").toUpperCase();
			if (/widget|property|row|control|field|input/i.test(className) || tagName === "LABEL" || tagName === "LI") {
				addTarget(current);
			}
			current = current.parentElement;
			depth += 1;
		}
	}
	return targets;
}

function setWidgetEnabled(widget, enabled, disabledText = "") {
	if (!widget) {
		return;
	}
	const isEnabled = Boolean(enabled);
	widget.disabled = !isEnabled;
	widget.options = widget.options || {};
	widget.options.disabled = !isEnabled;
	widget.__gjjLtx23MultiRefDisabled = !isEnabled;
	if (disabledText) {
		widget.__gjjLtx23MultiRefDisabledText = disabledText;
	}
	for (const element of [widget.inputEl, widget.element].filter(Boolean)) {
		if ("disabled" in element) {
			element.disabled = !isEnabled;
		}
		if ("readOnly" in element) {
			element.readOnly = !isEnabled;
		}
		if (element.style) {
			element.style.opacity = isEnabled ? "" : "0.55";
			element.style.pointerEvents = isEnabled ? "" : "none";
		}
	}
	for (const target of getDomWidgetTargets(widget)) {
		if (!target?.style) {
			continue;
		}
		target.style.opacity = isEnabled ? "" : "0.55";
		target.style.pointerEvents = isEnabled ? "" : "none";
	}
}

function setWidgetVisualText(widget, text) {
	if (!widget) {
		return;
	}
	for (const element of [widget.inputEl, widget.element].filter(Boolean)) {
		if ("value" in element) {
			element.value = text;
		}
	}
}

function applyPanelSize(node, width, height, options = {}) {
	if (width == null || height == null) {
		return;
	}
	const suppressPersist = options.persist === false;
	const previousSuppress = node.__gjjLtx23MultiRefSuppressPanelSizePersist;
	node.__gjjLtx23MultiRefSuppressPanelSizePersist = previousSuppress || suppressPersist;
	try {
		setWidgetValue(getWidget(node, WIDTH_WIDGET), normalizeDimension(width));
		setWidgetValue(getWidget(node, HEIGHT_WIDGET), normalizeDimension(height));
	} finally {
		node.__gjjLtx23MultiRefSuppressPanelSizePersist = previousSuppress;
	}
	if (!suppressPersist && !node.__gjjLtx23MultiRefSuppressPanelSizePersist) {
		persistPanelSize(node, options.sourceSignature);
	}
}

function updateSizeInputLabels(node) {
	for (const [name, label] of [[WIDTH_WIDGET, "宽度"], [HEIGHT_WIDGET, "高度"]]) {
		const input = getSizeInput(node, name);
		const widget = getWidget(node, name);
		const connected = Boolean(input?.link);
		if (input) {
			input.label = connected ? `${label}（直连）` : label;
			input.localized_name = input.label;
			input.tooltip = connected
				? `已连接外部${label}，面板${label}显示清空并以直连数据为准。`
				: `外部${label}输入。未连接时使用面板${label}。`;
		}
		if (!widget) {
			continue;
		}
		if (connected) {
			widget.__gjjLtx23MultiRefSizeInputBlank = true;
			setWidgetVisualText(widget, "");
		} else if (widget.__gjjLtx23MultiRefSizeInputBlank) {
			widget.__gjjLtx23MultiRefSizeInputBlank = false;
			setWidgetVisualText(widget, String(widget.value ?? ""));
		}
	}
}

function buildViewUrl(item, fallbackType = "input") {
	if (!item?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || fallbackType)}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function loadImageSizeFromUrl(url) {
	if (!url) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		return [];
	}
}

function sameImageItem(left, right) {
	return String(left?.filename || "") === String(right?.filename || "")
		&& String(left?.subfolder || "") === String(right?.subfolder || "");
}

function multiLoaderSelection(sourceNode) {
	const state = sourceNode?.__gjjMultiImageState || {};
	const rawSelection = getWidget(sourceNode, "selected_images")?.value || sourceNode?.properties?.selected_images || "[]";
	const selection = Array.isArray(state.selection) && state.selection.length
		? state.selection
		: parseSelection(rawSelection);
	const options = Array.isArray(state.options) ? state.options : [];
	return selection.map((item) => {
		const matched = options.find((option) => sameImageItem(option, item)) || {};
		return {
			...item,
			type: item.type || matched.type || "input",
			width: Number(item.width || matched.width || 0),
			height: Number(item.height || matched.height || 0),
		};
	});
}

async function loadImageSizeFromMultiImageLoader(sourceNode, outputSlot = 0) {
	const selected = multiLoaderSelection(sourceNode);
	const index = Math.max(0, Number(outputSlot || 0) - 1);
	const item = selected[index] || selected[0];
	if (item?.width && item?.height) {
		return { width: Number(item.width), height: Number(item.height) };
	}
	const state = sourceNode?.__gjjMultiImageState || {};
	const executed = Array.isArray(state.executedImages) ? state.executedImages : [];
	const executedItem = executed[index] || executed[0];
	if (executedItem?.width && executedItem?.height) {
		return { width: Number(executedItem.width), height: Number(executedItem.height) };
	}
	if (item?.filename) {
		return loadImageSizeFromUrl(buildViewUrl(item, "input"));
	}
	if (executedItem?.filename) {
		return loadImageSizeFromUrl(buildViewUrl(executedItem, executedItem.type || "temp"));
	}
	return null;
}

function linkedSourceInfo(input) {
	const linkId = input?.link;
	if (linkId == null || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	return sourceNode ? { input, link, sourceNode } : null;
}

function primaryImageSourceInfo(node) {
	const batchInfo = linkedSourceInfo(getInput(node, BATCH_SCENES_INPUT_NAME));
	if (batchInfo) {
		return batchInfo;
	}
	for (const input of getSceneInputs(node)) {
		const info = linkedSourceInfo(input);
		if (info) {
			return info;
		}
	}
	return null;
}

function imageSourceSignature(node) {
	const info = primaryImageSourceInfo(node);
	if (!info) {
		return "";
	}
	const sourceNode = info.sourceNode;
	const base = `${info.input?.name || ""}:${info.link?.id || info.input?.link || 0}:${info.link?.origin_id || ""}:${info.link?.origin_slot ?? ""}:${sourceNode?.comfyClass || sourceNode?.type || ""}`;
	if (sourceNode?.comfyClass === MULTI_IMAGE_LOADER_CLASS) {
		const selection = multiLoaderSelection(sourceNode)
			.map((item) => `${item.subfolder || ""}/${item.filename || ""}:${item.width || ""}x${item.height || ""}`)
			.join("|");
		return `${base}:${selection}`;
	}
	const imageValue = getWidget(sourceNode, "image")?.value;
	if (imageValue != null) {
		return `${base}:${String(imageValue)}`;
	}
	return base;
}

async function loadImageSizeFromSourceInfo(info) {
	const sourceNode = info?.sourceNode;
	if (!sourceNode) {
		return null;
	}
	patchSourceImageNode(sourceNode);
	if (sourceNode.comfyClass === MULTI_IMAGE_LOADER_CLASS) {
		return loadImageSizeFromMultiImageLoader(sourceNode, info.link?.origin_slot || 0);
	}
	const imageWidget = getWidget(sourceNode, "image");
	const filename = String(imageWidget?.value || "").trim();
	if (filename) {
		const type = sourceNode.comfyClass === "LoadImageOutput" ? "output" : "input";
		return loadImageSizeFromUrl(buildViewUrl({ filename, type }, type));
	}
	return null;
}

async function trySyncPanelSizeFromImageSource(node, force = false) {
	if (!node) {
		return;
	}
	updateSizeInputLabels(node);
	if (hasAnySizeInputConnected(node)) {
		node.__gjjLtx23MultiRefAppliedSizeSignature = "";
		clearPersistedPanelSize(node);
		return;
	}
	const signature = imageSourceSignature(node);
	if (!signature) {
		return;
	}
	const storedSize = panelSizeFromProperties(node);
	const storedSignature = String(node.properties?.[PANEL_SIZE_SOURCE_PROPERTY] || "");
	if (storedSize && storedSignature === signature) {
		node.__gjjLtx23MultiRefAppliedSizeSignature = signature;
		return;
	}
	if (!force && node.__gjjLtx23MultiRefAppliedSizeSignature === signature) {
		return;
	}
	if (node.__gjjLtx23MultiRefPendingSizeSignature === signature) {
		return;
	}
	node.__gjjLtx23MultiRefPendingSizeSignature = signature;
	const size = await loadImageSizeFromSourceInfo(primaryImageSourceInfo(node));
	node.__gjjLtx23MultiRefPendingSizeSignature = "";
	if (!size?.width || !size?.height || hasAnySizeInputConnected(node)) {
		return;
	}
	applyPanelSize(node, size.width, size.height, { sourceSignature: signature });
	node.__gjjLtx23MultiRefAppliedSizeSignature = signature;
	refreshNode(node);
}

function syncTargetsLinkedFromSource(sourceNode) {
	setTimeout(() => {
		for (const node of app.graph?._nodes || []) {
			if (!TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				continue;
			}
			const info = primaryImageSourceInfo(node);
			if (info?.sourceNode?.id === sourceNode?.id) {
				trySyncPanelSizeFromImageSource(node, true);
			}
		}
	}, 0);
}

function patchSourceImageNode(sourceNode) {
	if (!sourceNode || sourceNode.__gjjLtx23MultiRefSourcePatched) {
		return;
	}
	if (!["LoadImage", "LoadImageOutput"].includes(sourceNode.comfyClass)) {
		return;
	}
	const imageWidget = getWidget(sourceNode, "image");
	if (!imageWidget) {
		return;
	}
	const originalCallback = imageWidget.callback;
	imageWidget.callback = function (value, ...args) {
		const result = typeof originalCallback === "function"
			? originalCallback.call(this, value, ...args)
			: undefined;
		syncTargetsLinkedFromSource(sourceNode);
		return result;
	};
	sourceNode.__gjjLtx23MultiRefSourcePatched = true;
}

function hideWidget(widget) {
	if (!widget) {
		return;
	}
	if (widget.__gjjLtx23MultiRefHidden) {
		widget.computeSize = () => [0, -4];
		widget.draw = () => {};
		widget.hidden = true;
		if (widget.element?.style) {
			widget.element.style.display = "none";
		}
		if (widget.inputEl?.style) {
			widget.inputEl.style.display = "none";
		}
		return;
	}
	widget.__gjjLtx23MultiRefOriginal = widget.__gjjLtx23MultiRefOriginal || {
		type: widget.type,
		computeSize: widget.computeSize,
		draw: widget.draw,
		label: widget.label,
		localized_name: widget.localized_name,
		hidden: widget.hidden,
	};
	widget.__gjjLtx23MultiRefHidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.hidden = true;
	widget.computeSize = () => [0, -4];
	widget.draw = () => {};
	widget.label = "";
	if (widget.element?.style) {
		widget.element.style.display = "none";
	}
	if (widget.inputEl?.style) {
		widget.inputEl.style.display = "none";
	}
}

function restoreWidget(widget, fallbackLabel = "") {
	if (!widget) {
		return;
	}
	const original = widget.__gjjLtx23MultiRefOriginal || {};
	if (String(widget.type || "").startsWith("converted-widget")) {
		widget.type = original.type || widget.options?.type || "number";
	}
	widget.hidden = false;
	if (original.computeSize) {
		widget.computeSize = original.computeSize;
	} else {
		delete widget.computeSize;
	}
	if (original.draw) {
		widget.draw = original.draw;
	} else {
		delete widget.draw;
	}
	widget.__gjjLtx23MultiRefHidden = false;
	const label = fallbackLabel || original.localized_name || original.label || widget.label || widget.name || "";
	widget.label = label;
	widget.localized_name = label;
	if (widget.options) {
		widget.options.display_name = label;
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "";
		widget.inputEl.disabled = false;
		widget.inputEl.readOnly = false;
	}
	if (widget.element?.style) {
		widget.element.style.display = "";
	}
}

function restorePromptWidget(widget) {
	if (!widget || !PROMPT_WIDGETS.has(String(widget.name || ""))) {
		return;
	}
	const wasConverted = String(widget.type || "").startsWith("converted-widget");
	if (String(widget.type || "").startsWith("converted-widget")) {
		widget.type = "text";
	}
	widget.hidden = false;
	if (wasConverted || widget.__gjjLtx23MultiRefHidden) {
		delete widget.computeSize;
	}
	widget.__gjjLtx23MultiRefHidden = false;
	widget.label = String(widget.name || "") === "negative_prompt" ? "反向提示词" : "正向提示词";
	widget.localized_name = widget.label;
	widget.options = widget.options || {};
	widget.options.display_name = widget.label;
	widget.options.multiline = false;
	if (widget.inputEl) {
		widget.inputEl.style.display = "";
		widget.inputEl.disabled = false;
		widget.inputEl.readOnly = false;
	}
	if (widget.element?.style) {
		widget.element.style.display = "";
	}
}

function formatSceneName(index) {
	return `${SCENE_PREFIX}${String(index).padStart(2, "0")}`;
}

function getSceneIndex(name) {
	const text = String(name || "");
	if (text.startsWith(SCENE_PREFIX)) {
		return Number.parseInt(text.slice(SCENE_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
	}
	if (text === "main_image") {
		return 1;
	}
	if (text.startsWith("guide_image_")) {
		return Number.parseInt(text.slice("guide_image_".length), 10) || Number.MAX_SAFE_INTEGER;
	}
	return Number.MAX_SAFE_INTEGER;
}

function isManagedSceneInput(input) {
	const name = String(input?.name || "");
	return name.startsWith(SCENE_PREFIX) || name === "main_image" || name.startsWith("guide_image_");
}

function getSceneInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs]
			.filter((input) => isManagedSceneInput(input))
			.sort((a, b) => getSceneIndex(a?.name) - getSceneIndex(b?.name))
		: [];
}

function setInputText(input, name, label, tooltip) {
	if (!input) {
		return;
	}
	input.name = name;
	input.label = label;
	input.localized_name = label;
	input.tooltip = tooltip;
}

function normalizeFixedInputs(node) {
	for (const widget of node?.widgets || []) {
		restorePromptWidget(widget);
	}
	const legacyBatch = getInput(node, "scene_batch");
	if (legacyBatch && !getInput(node, BATCH_SCENES_INPUT_NAME)) {
		legacyBatch.name = BATCH_SCENES_INPUT_NAME;
	}
	setInputText(
		getInput(node, BATCH_SCENES_INPUT_NAME),
		BATCH_SCENES_INPUT_NAME,
		"批量场景图",
		"可直接接入 GJJ · 批量多图片加载预览器 的批量图片队列，节点会按队列顺序作为场景1、场景2继续生成。",
	);
	setInputText(
		getInput(node, LORA_CHAIN_INPUT_NAME),
		LORA_CHAIN_INPUT_NAME,
		"LoRA串联配置",
		"可选。统一接入所有需要的 LoRA 串联配置；本节点不再提供单独 LoRA 下拉和强度面板。",
	);
	setInputText(
		getInput(node, AUDIO_INPUT_NAME),
		AUDIO_INPUT_NAME,
		"驱动音频",
		"可选。接入后自动切换为数字人流程，时长直接由音频决定，并把这段音频作为最终视频音轨；音频越长、面板宽高越大，占用显存越高，建议先用短音频测试。",
	);
	setInputText(
		getInput(node, REFERENCE_VIDEO_INPUT_NAME),
		REFERENCE_VIDEO_INPUT_NAME,
		"参考视频",
		"可选。LTX全能参考预设会内部拆出关键帧作为 guide；不需要先手动转成图片帧。",
	);
}

function getFixedInputRank(name) {
	const text = String(name || "");
	if (text === "scene_batch") {
		return 0;
	}
	const index = FIXED_INPUT_ORDER.indexOf(text);
	return index >= 0 ? index : -1;
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	const originalOrder = new Map(node.inputs.map((input, index) => [input, index]));
	const rankInput = (input) => {
		const fixedRank = getFixedInputRank(input?.name);
		if (fixedRank >= 0) {
			return fixedRank;
		}
		if (isManagedSceneInput(input)) {
			return 10 + getSceneIndex(input?.name);
		}
		return 10000 + (originalOrder.get(input) ?? 0);
	};
	node.inputs.sort((left, right) => {
		const diff = rankInput(left) - rankInput(right);
		return diff || ((originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0));
	});
	for (let index = 0; index < node.inputs.length; index += 1) {
		const input = node.inputs[index];
		const linkId = input?.link;
		if (linkId != null && app.graph?.links?.[linkId]) {
			app.graph.links[linkId].target_slot = index;
		}
	}
}

function sceneHasLink(input) {
	return Boolean(input?.link);
}

function getSceneLinkSignature(node) {
	return getSceneInputs(node)
		.map((input) => `${input?.name || ""}:${input?.link || 0}`)
		.join("|");
}

function estimateBatchSceneCount(node) {
	const info = linkedSourceInfo(getInput(node, BATCH_SCENES_INPUT_NAME));
	if (!info) {
		return 0;
	}
	const sourceNode = info.sourceNode;
	if (sourceNode?.comfyClass === MULTI_IMAGE_LOADER_CLASS) {
		const state = sourceNode.__gjjMultiImageState || {};
		const selectedCount = multiLoaderSelection(sourceNode).length;
		const mergedCount = Number(state.mergedCount || 0);
		const externalCount = Number(state.externalCount || 0);
		return Math.max(0, selectedCount, mergedCount, externalCount);
	}
	return 2;
}

function estimateReferenceSceneCount(node) {
	const batchCount = estimateBatchSceneCount(node);
	const socketCount = getSceneInputs(node).filter((input) => sceneHasLink(input)).length;
	return batchCount + socketCount;
}

function patchTransitionToggleCallback(node) {
	const widget = getWidget(node, TRANSITION_TOGGLE_WIDGET);
	if (!widget || widget.__gjjLtx23MultiRefTransitionPatched) {
		return;
	}
	const originalCallback = widget.callback;
	widget.callback = function (value, ...args) {
		const result = typeof originalCallback === "function"
			? originalCallback.call(this, value, ...args)
			: undefined;
		scheduleStabilize(node, 0);
		return result;
	};
	widget.__gjjLtx23MultiRefTransitionPatched = true;
}

function updateTransitionWidgets(node) {
	patchTransitionToggleCallback(node);
	const referenceCount = estimateReferenceSceneCount(node);
	const hasEnoughReferences = referenceCount >= 2;
	const toggle = getWidget(node, TRANSITION_TOGGLE_WIDGET);
	setWidgetEnabled(toggle, hasEnoughReferences, "至少需要两张有效场景图才可启用转场控制。");
	if (toggle) {
		toggle.label = "转场控制";
		toggle.localized_name = "转场控制";
		if (toggle.options) {
			toggle.options.display_name = "转场控制";
		}
	}
	const controlsEnabled = hasEnoughReferences && widgetBooleanValue(toggle);
	const disabledText = hasEnoughReferences
		? "开启“转场控制”后此项参与运算。"
		: "至少需要两张有效场景图才参与运算。";
	for (const [name, label] of TRANSITION_CONTROL_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget) {
			continue;
		}
		widget.label = label;
		widget.localized_name = label;
		if (widget.options) {
			widget.options.display_name = label;
		}
		setWidgetEnabled(widget, controlsEnabled, disabledText);
	}
}

function patchSizeWidgetPersistence(node) {
	if (!node) {
		return;
	}
	for (const name of [WIDTH_WIDGET, HEIGHT_WIDGET]) {
		const widget = getWidget(node, name);
		if (!widget || widget.__gjjLtx23MultiRefSizePersistPatched) {
			continue;
		}
		const originalCallback = widget.callback;
		widget.callback = function (value, ...args) {
			const result = typeof originalCallback === "function"
				? originalCallback.call(this, value, ...args)
				: undefined;
			if (!node.__gjjLtx23MultiRefSuppressPanelSizePersist) {
				persistPanelSize(node);
			}
			return result;
		};
		widget.__gjjLtx23MultiRefSizePersistPatched = true;
	}
}

function setSerializedWidgetValue(serializedNode, node, widgetName, value) {
	const index = getWidgetIndex(node, widgetName);
	if (index < 0 || !Array.isArray(serializedNode?.widgets_values)) {
		return;
	}
	serializedNode.widgets_values[index] = value;
}

function writePanelSizeToSerializedNode(node, serializedNode) {
	if (!node || !serializedNode) {
		return;
	}
	persistPanelSize(node);
	serializedNode.properties = serializedNode.properties || {};
	delete serializedNode.properties[PANEL_WIDTH_PROPERTY];
	delete serializedNode.properties[PANEL_HEIGHT_PROPERTY];
	delete serializedNode.properties[PANEL_SIZE_SOURCE_PROPERTY];
	if (hasAnySizeInputConnected(node)) {
		return;
	}
	const size = panelSizeFromWidgets(node) || panelSizeFromProperties(node);
	if (!size) {
		return;
	}
	serializedNode.properties[PANEL_WIDTH_PROPERTY] = size.width;
	serializedNode.properties[PANEL_HEIGHT_PROPERTY] = size.height;
	const sourceSignature = String(node.properties?.[PANEL_SIZE_SOURCE_PROPERTY] || "");
	if (sourceSignature) {
		serializedNode.properties[PANEL_SIZE_SOURCE_PROPERTY] = sourceSignature;
	}
	setSerializedWidgetValue(serializedNode, node, WIDTH_WIDGET, size.width);
	setSerializedWidgetValue(serializedNode, node, HEIGHT_WIDGET, size.height);
}

function getSizeLinkSignature(node) {
	return [WIDTH_WIDGET, HEIGHT_WIDGET]
		.map((name) => {
			const input = getSizeInput(node, name);
			return `${name}:${input?.link || 0}`;
		})
		.join("|");
}

function getStabilizeSignature(node) {
	return [
		getSceneLinkSignature(node),
		getSizeLinkSignature(node),
		imageSourceSignature(node),
		`refs:${estimateReferenceSceneCount(node)}`,
		`transition:${widgetBooleanValue(getWidget(node, TRANSITION_TOGGLE_WIDGET)) ? 1 : 0}`,
	].join("||");
}

function addSceneInput(node) {
	const nextIndex = getSceneInputs(node).length + 1;
	node.addInput(formatSceneName(nextIndex), "IMAGE");
}

function trimTrailingUnusedScenes(node) {
	const inputs = getSceneInputs(node);
	let removable = 0;
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_SCENES; index -= 1) {
		if (sceneHasLink(inputs[index])) {
			break;
		}
		removable += 1;
	}
	for (let index = 0; index < removable; index += 1) {
		const currentInputs = getSceneInputs(node);
		const target = currentInputs[currentInputs.length - 1];
		const slotIndex = node.inputs.indexOf(target);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
}

function ensureTrailingEmptyScene(node) {
	const inputs = getSceneInputs(node);
	if (!inputs.length) {
		addSceneInput(node);
		return;
	}
	const lastInput = inputs[inputs.length - 1];
	if (sceneHasLink(lastInput)) {
		addSceneInput(node);
	}
}

function renameScenesSequentially(node) {
	getSceneInputs(node).forEach((input, zeroIndex) => {
		const index = zeroIndex + 1;
		const label = `场景${index}`;
		input.name = formatSceneName(index);
		input.label = label;
		input.localized_name = label;
		input.type = "IMAGE";
		input.tooltip = index === 1
			? "可选起始场景图。新连接图片时会同步面板宽高；留空时走文生视频；连上当前最后一张场景图后，会自动扩展下一张输入。"
			: "场景参考图。中间图会作为过渡帧，当前最后一张会作为结束帧。连上当前最后一张场景图后，会自动扩展下一张输入。";
	});
}

function parseProgress(detail = {}, fallback = 0) {
	if (Number.isFinite(detail.progress)) {
		return Math.max(0, Math.min(100, Number(detail.progress) * 100));
	}
	const text = String(detail.text || "");
	const match = text.match(/(\d+)\s*\/\s*(\d+)/);
	if (match) {
		const current = Math.max(0, Number(match[1] || 0));
		const total = Math.max(1, Number(match[2] || 1));
		return Math.max(0, Math.min(100, (current / total) * 100));
	}
	if (text.includes("完成") || text.includes("失败")) {
		return 100;
	}
	return Math.max(0, Math.min(100, Number(fallback) || 0));
}

function extractLoraNotice(text) {
	const lines = String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const noticeLines = lines.filter((line) => LORA_NOTICE_RE.test(line));
	return noticeLines.length ? noticeLines.join("\n") : "";
}

function removeNoticeLines(text) {
	const lines = String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !LORA_NOTICE_RE.test(line));
	return lines.join("\n");
}

function mediaUrl(media) {
	if (!media?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(media.filename)}&type=${encodeURIComponent(media.type || "output")}&subfolder=${encodeURIComponent(media.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function measureStatusWidget(node) {
	const state = node?.__gjjLtx23MultiRefStatus;
	if (!state?.wrap) {
		return;
	}
	requestAnimationFrame(() => {
		const nextHeight = Math.max(92, Math.ceil(state.wrap.scrollHeight || state.wrap.offsetHeight || 92));
		if (state.height !== nextHeight) {
			state.height = nextHeight;
			refreshNode(node);
		}
	});
}

function clearSegmentPreviews(node) {
	const state = ensureStatusWidget(node);
	state.segments = [];
	state.segmentList.innerHTML = "";
	state.segmentList.style.display = "none";
	measureStatusWidget(node);
}

function renderSegmentPreviews(node) {
	const state = ensureStatusWidget(node);
	const segments = Array.isArray(state.segments) ? state.segments : [];
	state.segmentList.innerHTML = "";
	state.segmentList.style.display = segments.length ? "flex" : "none";
	for (const segment of segments) {
		const card = document.createElement("div");
		card.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:5px",
			"padding:6px",
			"border:1px solid #344952",
			"border-radius:8px",
			"background:#10181d",
		].join(";");

		const title = document.createElement("div");
		title.textContent = segment?.label || `第 ${segment?.index || segments.indexOf(segment) + 1} 段`;
		title.style.cssText = "color:#dce7e2;font-size:12px;line-height:1.3;font-weight:600;word-break:break-word";
		card.appendChild(title);

		const url = mediaUrl(segment?.media || {});
		if (url) {
			const video = document.createElement("video");
			video.controls = true;
			video.muted = true;
			video.preload = "metadata";
			video.src = url;
			video.style.cssText = [
				"display:block",
				"width:100%",
				"max-height:160px",
				"background:#05080a",
				"border-radius:6px",
			].join(";");
			card.appendChild(video);
		}

		const meta = document.createElement("div");
		const sizeText = segment?.width && segment?.height ? `${segment.width} × ${segment.height}` : "";
		const frameText = segment?.frame_count ? `${segment.frame_count} 帧` : "";
		meta.textContent = [sizeText, frameText, segment?.path || ""].filter(Boolean).join(" / ");
		meta.title = segment?.path || "";
		meta.style.cssText = "color:#9fb0b8;font-size:11px;line-height:1.35;word-break:break-all";
		card.appendChild(meta);
		state.segmentList.appendChild(card);
	}
	measureStatusWidget(node);
}

function addSegmentPreview(node, detail) {
	const state = ensureStatusWidget(node);
	const incoming = { ...(detail || {}) };
	const index = Number(incoming.index || 0);
	const existing = state.segments.findIndex((item) => Number(item?.index || 0) === index && index > 0);
	if (existing >= 0) {
		state.segments[existing] = incoming;
	} else {
		state.segments.push(incoming);
	}
	state.segments.sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0));
	renderSegmentPreviews(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjLtx23MultiRefStatus) {
		return node.__gjjLtx23MultiRefStatus;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"min-height:48px",
	].join(";");

	const text = document.createElement("div");
	text.textContent = "等待执行";
	text.style.cssText = [
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:10px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");

	const notice = document.createElement("div");
	notice.style.cssText = [
		"display:none",
		"padding:6px 10px",
		"border:1px solid #7c5a17",
		"border-radius:10px",
		"background:#2a200d",
		"color:#f5d48a",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");

	const progressOuter = document.createElement("div");
	progressOuter.style.cssText = [
		"height:8px",
		"border-radius:999px",
		"background:#1a262c",
		"overflow:hidden",
		"border:1px solid #33454c",
	].join(";");

	const progressInner = document.createElement("div");
	progressInner.style.cssText = [
		"height:100%",
		"width:0%",
		"background:linear-gradient(90deg,#34d399,#22c55e)",
		"transition:width 120ms ease",
	].join(";");

	progressOuter.appendChild(progressInner);
	const segmentList = document.createElement("div");
	segmentList.style.cssText = [
		"display:none",
		"flex-direction:column",
		"gap:8px",
	].join(";");

	wrap.append(text, notice, progressOuter, segmentList);
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => node.__gjjLtx23MultiRefStatus?.height || 92,
	});
	node.__gjjLtx23MultiRefStatus = {
		widget,
		wrap,
		text,
		notice,
		progressInner,
		segmentList,
		segments: [],
		height: 92,
		progress: 0,
		noticeText: "",
		lastStatusText: "等待执行",
	};
	return node.__gjjLtx23MultiRefStatus;
}

function setStatus(node, detail) {
	const state = ensureStatusWidget(node);
	const incomingText = String(detail?.text || "等待执行");
	const noticeText = extractLoraNotice(incomingText);
	const mainText = removeNoticeLines(incomingText);
	if (incomingText === "等待执行" || /^\s*1\s*\/\s*8\b/.test(incomingText)) {
		state.noticeText = "";
		clearSegmentPreviews(node);
	}
	if (noticeText) {
		state.noticeText = noticeText;
	}
	if (mainText) {
		state.lastStatusText = mainText;
	} else if (!noticeText) {
		state.lastStatusText = incomingText || "等待执行";
	}
	state.text.textContent = state.lastStatusText || "等待执行";
	state.notice.textContent = state.noticeText || "";
	state.notice.style.display = state.noticeText ? "block" : "none";
	state.progress = parseProgress(detail, state.progress);
	state.progressInner.style.width = `${state.progress}%`;
	measureStatusWidget(node);
	refreshNode(node);
}

function hideLegacyWidgets(node) {
	for (const widget of node?.widgets || []) {
		if (LEGACY_WIDGET_NAMES.has(String(widget?.name || ""))) {
			hideWidget(widget);
		}
	}
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	patchSizeWidgetPersistence(node);
	ensureStatusWidget(node);
	hideLegacyWidgets(node);
	trimTrailingUnusedScenes(node);
	ensureTrailingEmptyScene(node);
	renameScenesSequentially(node);
	normalizeFixedInputs(node);
	reorderInputs(node);
	updateSizeInputLabels(node);
	updateTransitionWidgets(node);
	trySyncPanelSizeFromImageSource(node);
	node.__gjjLtx23MultiRefLinkSignature = getStabilizeSignature(node);
	refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjLtx23MultiRefTimer);
	node.__gjjLtx23MultiRefTimer = setTimeout(() => stabilizeNode(node), ms);
}

function patchNode(node) {
	if (!node || node.__gjjLtx23MultiRefPatched) {
		return;
	}
	node.__gjjLtx23MultiRefPatched = true;
	patchSizeWidgetPersistence(node);
	restorePanelSizeFromProperties(node);
	ensureStatusWidget(node);
	setStatus(node, { text: "等待执行", progress: 0 });
	stabilizeNode(node);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setStatus(targetNode, detail);
});

api.addEventListener("gjj_ltx23_multiref_segment", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	addSegmentPreview(targetNode, detail);
});

app.registerExtension({
	name: "GJJ.LTX23ImageToVideoMultiRef",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			restorePanelSizeFromProperties(this);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const result = originalOnSerialize?.apply(this, arguments);
			writePanelSizeToSerializedNode(this, serializedNode);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			const segments = Array.isArray(message?.segment_videos)
				? message.segment_videos
				: (Array.isArray(message?.preview_segments) ? message.preview_segments : []);
			if (segments.length) {
				const state = ensureStatusWidget(this);
				state.segments = segments.map((item) => ({ ...(item || {}) }));
				renderSegmentPreviews(this);
			}
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const signature = getStabilizeSignature(this);
			if (signature !== this.__gjjLtx23MultiRefLinkSignature) {
				scheduleStabilize(this, 0);
			}
			return typeof originalOnDrawBackground === "function"
				? originalOnDrawBackground.apply(this, args)
				: undefined;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				patchNode(node);
			}
		}
	},
});

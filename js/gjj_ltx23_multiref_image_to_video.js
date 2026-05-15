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
function isLtx23TargetName(value) {
	const text = String(value || "");
	return TARGET_NODES.has(text)
		|| /GJJ.*LTX23/i.test(text)
		|| /LTX.*多图参考/i.test(text)
		|| /LTX图文生视频多图参考器/i.test(text);
}

function isTargetNodeDef(nodeData) {
	return isLtx23TargetName(nodeData?.name)
		|| isLtx23TargetName(nodeData?.display_name)
		|| isLtx23TargetName(nodeData?.title);
}

function isTargetNodeInstance(node) {
	return isLtx23TargetName(node?.comfyClass)
		|| isLtx23TargetName(node?.type)
		|| isLtx23TargetName(node?.title)
		|| isLtx23TargetName(node?.constructor?.type);
}

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
const FIRST_SCENE_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const FIXED_INPUT_ORDER = [AUDIO_INPUT_NAME, LORA_CHAIN_INPUT_NAME, REFERENCE_VIDEO_INPUT_NAME];
const LEGACY_SCENE_NAME_RE = /^(?:🖼️\s*)?\d+$/;
const CHINESE_SCENE_NAME_RE = /^场景\s*\d+$/;
const PROMPT_WIDGETS = new Set(["positive_prompt", "negative_prompt"]);
// v15：ComfyUI 把 widget 转成输入口时，会生成同名输入口。
// 这些口不能被动态场景口挤到后面，否则新拉出的“正向提示词”会被 link.target_slot 错修到“场景2”。
const CONVERTIBLE_WIDGET_INPUT_ORDER = [
	"ltx_model_name",
	"positive_prompt",
	"negative_prompt",
	"segment_seconds",
	"width",
	"height",
	"fps",
	"seed",
	"denoise_strength",
	"transition_enabled",
	"transition_curve",
	"transition_early_tail_ratio",
	"transition_implicit_guide_count",
	"transition_implicit_guide_strength",
	"transition_early_tail_strength",
	"transition_final_guide_strength",
	"segmented_execution",
	"segment_save_preset",
	"segment_video_format",
];
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
const SEGMENT_TOGGLE_WIDGET = "segmented_execution";
const SEGMENT_CONTROL_WIDGETS = [
	["segment_save_preset", "分段保存位置预设"],
	["segment_video_format", "分段视频格式"],
];
const SECTION_TABS_WIDGET_NAME = "gjj_ltx23_section_tabs";
const SECTION_STATE_PROPERTY = "gjj_ltx23_active_section";
const SECTION_NONE = "none";
const SECTION_TRANSITION = "transition";
const SECTION_SEGMENT = "segment";

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
			if (!isTargetNodeInstance(node)) {
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

function sceneInputType(index) {
	return Number(index) <= 1 ? FIRST_SCENE_INPUT_TYPE : "IMAGE";
}

function sceneTooltip(index) {
	return Number(index) <= 1
		? "第一张场景图输入：支持单张 IMAGE，也支持自定义批量图片 GJJ_BATCH_IMAGE；接入后会统一拆成图片列表，并自动显示下一张场景输入。留空时走文生视频。"
		: "追加场景参考图：用于首尾帧或多图参考；连上当前最后一张后，会自动扩展下一张输入。";
}

function sceneIndexFromText(value) {
	const text = String(value || "").trim();
	if (!text) {
		return Number.MAX_SAFE_INTEGER;
	}
	if (text.startsWith(SCENE_PREFIX)) {
		return Number.parseInt(text.slice(SCENE_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
	}
	if (text === "main_image") {
		return 1;
	}
	if (text.startsWith("guide_image_")) {
		return (Number.parseInt(text.slice("guide_image_".length), 10) || Number.MAX_SAFE_INTEGER) + 1;
	}
	const legacy = text.match(/(\d+)$/);
	if (legacy && (LEGACY_SCENE_NAME_RE.test(text) || CHINESE_SCENE_NAME_RE.test(text))) {
		return Number.parseInt(legacy[1], 10) || Number.MAX_SAFE_INTEGER;
	}
	return Number.MAX_SAFE_INTEGER;
}

function getSceneIndex(inputOrName) {
	if (typeof inputOrName === "object" && inputOrName) {
		return Math.min(
			sceneIndexFromText(inputOrName.name),
			sceneIndexFromText(inputOrName.label),
			sceneIndexFromText(inputOrName.localized_name),
		);
	}
	return sceneIndexFromText(inputOrName);
}

function isSceneLikeText(value) {
	const text = String(value || "").trim();
	return text.startsWith(SCENE_PREFIX)
		|| text === "main_image"
		|| text.startsWith("guide_image_")
		|| LEGACY_SCENE_NAME_RE.test(text)
		|| CHINESE_SCENE_NAME_RE.test(text);
}

function isLegacyNumberedSceneInput(input) {
	const name = String(input?.name || "").trim();
	const label = String(input?.label || input?.localized_name || "").trim();
	const type = String(input?.type || "").toUpperCase();
	return (type.includes("IMAGE") || type.includes("GJJ_BATCH_IMAGE")) && (isSceneLikeText(name) || isSceneLikeText(label));
}

function isManagedSceneInput(input) {
	const name = String(input?.name || "");
	return name.startsWith(SCENE_PREFIX) || name === "main_image" || name.startsWith("guide_image_") || isLegacyNumberedSceneInput(input);
}

function getSceneInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs]
			.filter((input) => isManagedSceneInput(input))
			.sort((a, b) => getSceneIndex(a) - getSceneIndex(b))
		: [];
}

function dedupeSceneInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	const originalOrder = new Map(node.inputs.map((input, index) => [input, index]));
	const groups = new Map();
	for (const input of node.inputs) {
		if (!isManagedSceneInput(input)) {
			continue;
		}
		const index = getSceneIndex(input);
		if (!Number.isFinite(index) || index === Number.MAX_SAFE_INTEGER) {
			continue;
		}
		if (!groups.has(index)) {
			groups.set(index, []);
		}
		groups.get(index).push(input);
	}
	for (const [index, inputs] of groups) {
		if (inputs.length <= 1) {
			continue;
		}
		inputs.sort((a, b) => {
			const linkDiff = (b?.link ? 1 : 0) - (a?.link ? 1 : 0);
			return linkDiff || ((originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));
		});
		const keep = inputs[0];
		for (const input of inputs.slice(1)) {
			if (input?.link && !keep.link) {
				keep.link = input.link;
			}
			const slotIndex = node.inputs.indexOf(input);
			if (slotIndex >= 0) {
				node.removeInput(slotIndex);
			}
		}
	}
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

function forceInputType(input, type) {
	if (!input || !type) {
		return;
	}
	input.type = type;
	input.widget = null;
	input.options = input.options || {};
	input.options.type = type;
}

function graphLinkById(linkId) {
	if (linkId == null || !app?.graph?.links) {
		return null;
	}
	const links = app.graph.links;
	if (links instanceof Map) {
		return links.get(linkId) || links.get(String(linkId)) || null;
	}
	return links[linkId] || links[String(linkId)] || null;
}

function repairInputLinkSlots(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = 0; index < node.inputs.length; index += 1) {
		const input = node.inputs[index];
		input.slot_index = index;
		const link = graphLinkById(input?.link);
		if (!link) {
			continue;
		}
		link.target_id = node.id;
		link.target_slot = index;
		if (input.type) {
			link.type = input.type;
		}
	}
}

function normalizeFixedInputs(node) {
	for (const widget of node?.widgets || []) {
		// 如果用户已经把正/反向提示词 widget 转成输入口，不要在稳定化时强制还原 widget。
		// 否则 ComfyUI 会同时存在“converted widget input”和被恢复的 widget，拖线时容易落到场景口。
		if (PROMPT_WIDGETS.has(String(widget?.name || "")) && getInput(node, widget.name)) {
			continue;
		}
		restorePromptWidget(widget);
	}
	// v9：取消单独“批量场景图”接口。旧工作流里的 batch_scenes/scene_batch 会迁移到 scene_01。
	for (const legacyName of ["scene_batch", BATCH_SCENES_INPUT_NAME]) {
		const legacyBatch = getInput(node, legacyName);
		if (!legacyBatch) {
			continue;
		}
		const sceneInputs = getSceneInputs(node).filter((input) => input !== legacyBatch);
		const firstScene = sceneInputs[0];
		if (legacyBatch.link && (!firstScene || !firstScene.link)) {
			if (firstScene && !firstScene.link) {
				const slotIndex = node.inputs.indexOf(firstScene);
				if (slotIndex >= 0) {
					node.removeInput(slotIndex);
				}
			}
			setInputText(legacyBatch, formatSceneName(1), "场景1", sceneTooltip(1));
			legacyBatch.type = FIRST_SCENE_INPUT_TYPE;
		} else if (!legacyBatch.link) {
			const slotIndex = node.inputs.indexOf(legacyBatch);
			if (slotIndex >= 0) {
				node.removeInput(slotIndex);
			}
		}
	}
	// 如果旧节点被前端重排/去重误删固定口，这里重新补回正确类型。
	if (!getInput(node, AUDIO_INPUT_NAME)) {
		node.addInput(AUDIO_INPUT_NAME, "AUDIO");
	}
	if (!getInput(node, LORA_CHAIN_INPUT_NAME)) {
		node.addInput(LORA_CHAIN_INPUT_NAME, "LORA_CHAIN_CONFIG");
	}

	const audioInput = getInput(node, AUDIO_INPUT_NAME);
	setInputText(
		audioInput,
		AUDIO_INPUT_NAME,
		"驱动音频",
		"可选。接入后自动切换为数字人流程，时长直接由音频决定，并把这段音频作为最终视频音轨；音频越长、面板宽高越大，占用显存越高，建议先用短音频测试。",
	);
	forceInputType(audioInput, "AUDIO");

	const loraInput = getInput(node, LORA_CHAIN_INPUT_NAME);
	setInputText(
		loraInput,
		LORA_CHAIN_INPUT_NAME,
		"LoRA串联配置",
		"可选。统一接入所有需要的 LoRA 串联配置；本节点不再提供单独 LoRA 下拉和强度面板。",
	);
	forceInputType(loraInput, "LORA_CHAIN_CONFIG");

	const referenceVideoInput = getInput(node, REFERENCE_VIDEO_INPUT_NAME);
	setInputText(
		referenceVideoInput,
		REFERENCE_VIDEO_INPUT_NAME,
		"参考视频",
		"可选。LTX全能参考预设会内部拆出关键帧作为 guide；不需要先手动转成图片帧。",
	);
	// 旧版本偶尔会把固定口错继承为 IMAGE；这里只在参考视频口存在时纠正。
	forceInputType(referenceVideoInput, "VIDEO");

	for (const input of node.inputs || []) {
		if (isConvertibleWidgetInput(input)) {
			forceInputType(input, widgetInputType(input.name));
		}
	}
}

function getFixedInputRank(name) {
	const text = String(name || "");
	const index = FIXED_INPUT_ORDER.indexOf(text);
	return index >= 0 ? index : -1;
}

function getConvertibleWidgetInputRank(name) {
	const text = String(name || "");
	const index = CONVERTIBLE_WIDGET_INPUT_ORDER.indexOf(text);
	return index >= 0 ? index : -1;
}

function isConvertibleWidgetInput(input) {
	return getConvertibleWidgetInputRank(input?.name) >= 0;
}


function pruneUnlinkedConvertibleWidgetInputs(node, options = {}) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	// v23：只在节点刚创建/刚反序列化后的“初始化清理”阶段删除幽灵 widget socket。
	// 用户之后从 widget 前面手动拉出的输入口即使暂时未连线，也不能马上删除，
	// 否则会表现为“参数前面的接口不能外联”。
	const force = options.force === true;
	if (!force && node.__gjjLtx23InitialWidgetSocketPruneDone) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (!isConvertibleWidgetInput(input)) {
			continue;
		}
		if (input?.link) {
			continue;
		}
		// 保留用户刚从 widget 拉出来、还未来得及接线的 socket。
		// 只有旧工作流里自动遗留、没有对应 widget 或明确被标记为 ghost 的 socket 才清理。
		const widget = getWidget(node, input.name);
		const isGhost = input.__gjjLtx23Ghost === true || !widget;
		if (!isGhost && !force) {
			continue;
		}
		node.removeInput(index);
	}
	node.__gjjLtx23InitialWidgetSocketPruneDone = true;
}

function widgetInputType(name) {
	const text = String(name || "");
	if (text === "ltx_model_name" || text === "positive_prompt" || text === "negative_prompt") {
		return "STRING";
	}
	if (["segment_seconds", "denoise_strength", "transition_early_tail_ratio", "transition_implicit_guide_strength", "transition_early_tail_strength", "transition_final_guide_strength"].includes(text)) {
		return "FLOAT";
	}
	if (["width", "height", "fps", "seed", "transition_implicit_guide_count"].includes(text)) {
		return "INT";
	}
	if (text === "transition_enabled" || text === "segmented_execution") {
		return "BOOLEAN";
	}
	return "STRING";
}

function inputDisplayRank(input, originalOrder) {
	const fixedRank = getFixedInputRank(input?.name);
	if (fixedRank >= 0) {
		// 固定接口永远在动态场景接口之前，防止“场景2”追加后把 Audio / LoRA 的 slot 挤错位。
		return fixedRank;
	}
	const widgetRank = getConvertibleWidgetInputRank(input?.name);
	if (widgetRank >= 0) {
		// 用户从 widget 拉出来的输入口必须排在动态场景口之前。
		// 否则新建“场景2”后，ComfyUI 可能把正向提示词的连线修到场景2。
		return 20 + widgetRank;
	}
	if (isManagedSceneInput(input)) {
		return 200 + getSceneIndex(input);
	}
	return 10000 + (originalOrder.get(input) ?? 0);
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	const originalOrder = new Map(node.inputs.map((input, index) => [input, index]));
	node.inputs.sort((left, right) => {
		const diff = inputDisplayRank(left, originalOrder) - inputDisplayRank(right, originalOrder);
		return diff || ((originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0));
	});
	repairInputLinkSlots(node);
}

function hardNormalizeInputOrderAndTypes(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	// 先固定所有受管接口的类型，避免 LiteGraph 在动态追加后继承成 COMBO。
	const audioInput = getInput(node, AUDIO_INPUT_NAME);
	forceInputType(audioInput, "AUDIO");
	const loraInput = getInput(node, LORA_CHAIN_INPUT_NAME);
	forceInputType(loraInput, "LORA_CHAIN_CONFIG");
	const referenceVideoInput = getInput(node, REFERENCE_VIDEO_INPUT_NAME);
	forceInputType(referenceVideoInput, "VIDEO");
	for (const input of node.inputs) {
		if (isConvertibleWidgetInput(input)) {
			forceInputType(input, widgetInputType(input.name));
		}
	}
	getSceneInputs(node).forEach((input, zeroIndex) => {
		forceInputType(input, sceneInputType(zeroIndex + 1));
	});

	// 再重排：固定口在前，场景口在后。这样场景2出现时不会挤乱 Audio/LoRA 的 target_slot。
	const originalOrder = new Map(node.inputs.map((input, index) => [input, index]));
	const sorted = [...node.inputs].sort((left, right) => {
		const diff = inputDisplayRank(left, originalOrder) - inputDisplayRank(right, originalOrder);
		return diff || ((originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0));
	});
	node.inputs.length = 0;
	node.inputs.push(...sorted);
	repairInputLinkSlots(node);
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
	const firstScene = getSceneInputs(node)[0];
	const batchInput = getInput(node, BATCH_SCENES_INPUT_NAME) || getInput(node, "scene_batch");
	const info = linkedSourceInfo(firstScene) || linkedSourceInfo(batchInput);
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
	const sceneInputs = getSceneInputs(node);
	const firstScene = sceneInputs[0];
	const socketCount = sceneInputs.filter((input) => {
		if (batchCount > 0 && input === firstScene) {
			return false;
		}
		return sceneHasLink(input);
	}).length;
	return batchCount + socketCount;
}


function getActiveSection(node) {
	const raw = String(node?.properties?.[SECTION_STATE_PROPERTY] || SECTION_NONE);
	return [SECTION_TRANSITION, SECTION_SEGMENT].includes(raw) ? raw : SECTION_NONE;
}

function setActiveSection(node, section) {
	const props = ensureNodeProperties(node);
	props[SECTION_STATE_PROPERTY] = [SECTION_TRANSITION, SECTION_SEGMENT].includes(section) ? section : SECTION_NONE;
}

function widgetLabelText(widget, fallback = "") {
	return fallback || String(widget?.localized_name || widget?.label || widget?.options?.display_name || widget?.name || "");
}

function showSectionWidget(widget, visible, label = "") {
	if (!widget) {
		return;
	}
	if (visible) {
		restoreWidget(widget, widgetLabelText(widget, label));
		setWidgetEnabled(widget, true);
	} else {
		hideWidget(widget);
	}
}

function styleSectionButton(button, enabled, active) {
	if (!button?.style) {
		return;
	}
	button.style.cssText = [
		"flex:1 1 0",
		"height:28px",
		"border-radius:9px",
		"border:1px solid " + (active ? "#5eead4" : enabled ? "#3f6c78" : "#34444c"),
		"background:" + (active ? "linear-gradient(180deg,#1f5560,#16343c)" : enabled ? "#182a31" : "#121a1f"),
		"color:" + (active ? "#eafffb" : enabled ? "#d7f3ee" : "#9fb0b8"),
		"font-size:12px",
		"font-weight:700",
		"cursor:pointer",
		"user-select:none",
		"white-space:nowrap",
		"overflow:hidden",
		"text-overflow:ellipsis",
		"box-shadow:" + (active ? "0 0 0 1px rgba(94,234,212,.18) inset" : "none"),
	].join(";");
}

function installButtonEvents(button, handler) {
	for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
		button.addEventListener(eventName, (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (eventName === "click") {
				handler(event);
			}
		});
	}
}

function ensureSectionTabsWidget(node) {
	// v23：旧工作流/热更新后，缓存对象可能还在，但 widget 已经被 ComfyUI 移出 node.widgets，
	// 这会导致“按钮全部没有了”。缓存无效时必须重建。
	if (node.__gjjLtx23SectionTabs?.widget && node.widgets?.includes?.(node.__gjjLtx23SectionTabs.widget)) {
		return node.__gjjLtx23SectionTabs;
	}
	if (node.__gjjLtx23SectionTabs) {
		try {
			node.__gjjLtx23SectionTabs.root?.remove?.();
			node.__gjjLtx23SectionTabs.wrap?.remove?.();
		} catch (_) {}
		node.__gjjLtx23SectionTabs = null;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"gap:6px",
		"align-items:center",
		"padding:2px 0 4px 0",
		"box-sizing:border-box",
	].join(";");
	const transitionButton = document.createElement("button");
	const segmentButton = document.createElement("button");
	transitionButton.type = "button";
	segmentButton.type = "button";
	wrap.append(transitionButton, segmentButton);

	installButtonEvents(transitionButton, () => {
		const toggle = getWidget(node, TRANSITION_TOGGLE_WIDGET);
		const isOpen = getActiveSection(node) === SECTION_TRANSITION;
		const isEnabled = widgetBooleanValue(toggle);
		if (isOpen && isEnabled) {
			setWidgetValue(toggle, false);
			setActiveSection(node, SECTION_NONE);
		} else {
			setWidgetValue(toggle, true);
			setActiveSection(node, SECTION_TRANSITION);
		}
		scheduleStabilize(node, 0);
	});
	installButtonEvents(segmentButton, () => {
		const toggle = getWidget(node, SEGMENT_TOGGLE_WIDGET);
		const isOpen = getActiveSection(node) === SECTION_SEGMENT;
		const isEnabled = widgetBooleanValue(toggle);
		if (isOpen && isEnabled) {
			setWidgetValue(toggle, false);
			setActiveSection(node, SECTION_NONE);
		} else {
			setWidgetValue(toggle, true);
			setActiveSection(node, SECTION_SEGMENT);
		}
		scheduleStabilize(node, 0);
	});

	const widget = node.addDOMWidget?.(SECTION_TABS_WIDGET_NAME, SECTION_TABS_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => 36,
	});
	if (widget) {
		widget.computeSize = (width) => [width || 320, 36];
		const currentIndex = node.widgets?.indexOf(widget) ?? -1;
		const transitionIndex = getWidgetIndex(node, TRANSITION_TOGGLE_WIDGET);
		const segmentIndex = getWidgetIndex(node, SEGMENT_TOGGLE_WIDGET);
		const targetIndex = Math.min(
			...([transitionIndex, segmentIndex].filter((index) => index >= 0))
		);
		if (currentIndex >= 0 && Number.isFinite(targetIndex) && targetIndex >= 0 && currentIndex !== targetIndex) {
			node.widgets.splice(currentIndex, 1);
			node.widgets.splice(Math.max(0, Math.min(targetIndex, node.widgets.length)), 0, widget);
		}
	}
	node.__gjjLtx23SectionTabs = { widget, wrap, transitionButton, segmentButton };
	return node.__gjjLtx23SectionTabs;
}

function updateSectionTabs(node) {
	const state = ensureSectionTabsWidget(node);
	const active = getActiveSection(node);
	const transitionEnabled = widgetBooleanValue(getWidget(node, TRANSITION_TOGGLE_WIDGET));
	const segmentEnabled = widgetBooleanValue(getWidget(node, SEGMENT_TOGGLE_WIDGET));
	if (state.transitionButton) {
		state.transitionButton.textContent = `${transitionEnabled ? "✅" : "⬜"} 转场控制`;
		state.transitionButton.title = transitionEnabled ? "点击关闭转场控制并隐藏参数" : "点击开启转场控制并显示参数";
		styleSectionButton(state.transitionButton, transitionEnabled, active === SECTION_TRANSITION);
	}
	if (state.segmentButton) {
		state.segmentButton.textContent = `${segmentEnabled ? "✅" : "⬜"} 多图分段执行`;
		state.segmentButton.title = segmentEnabled ? "点击关闭多图分段执行并隐藏参数" : "点击开启多图分段执行并显示参数";
		styleSectionButton(state.segmentButton, segmentEnabled, active === SECTION_SEGMENT);
	}
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
	const transitionToggle = getWidget(node, TRANSITION_TOGGLE_WIDGET);
	const segmentToggle = getWidget(node, SEGMENT_TOGGLE_WIDGET);
	if (transitionToggle) {
		transitionToggle.label = "转场控制";
		transitionToggle.localized_name = "转场控制";
		transitionToggle.options = transitionToggle.options || {};
		transitionToggle.options.display_name = "转场控制";
		transitionToggle.options.disabled = false;
		setWidgetEnabled(transitionToggle, true);
		hideWidget(transitionToggle);
	}
	if (segmentToggle) {
		segmentToggle.label = "多图分段执行";
		segmentToggle.localized_name = "多图分段执行";
		segmentToggle.options = segmentToggle.options || {};
		segmentToggle.options.display_name = "多图分段执行";
		segmentToggle.options.disabled = false;
		setWidgetEnabled(segmentToggle, true);
		hideWidget(segmentToggle);
	}

	let active = getActiveSection(node);
	const transitionEnabled = widgetBooleanValue(transitionToggle);
	const segmentEnabled = widgetBooleanValue(segmentToggle);
	if (active === SECTION_TRANSITION && !transitionEnabled) {
		active = SECTION_NONE;
		setActiveSection(node, SECTION_NONE);
	}
	if (active === SECTION_SEGMENT && !segmentEnabled) {
		active = SECTION_NONE;
		setActiveSection(node, SECTION_NONE);
	}
	const showTransition = active === SECTION_TRANSITION && transitionEnabled;
	const showSegment = active === SECTION_SEGMENT && segmentEnabled;

	for (const [name, label] of TRANSITION_CONTROL_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget) {
			continue;
		}
		widget.__gjjLtx23MultiRefDisabledText = "";
		if (widget.options) {
			widget.options.display_name = label;
			widget.options.disabled = false;
		}
		widget.label = label;
		widget.localized_name = label;
		showSectionWidget(widget, showTransition, label);
	}
	for (const [name, label] of SEGMENT_CONTROL_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget) {
			continue;
		}
		widget.__gjjLtx23MultiRefDisabledText = "";
		if (widget.options) {
			widget.options.display_name = label;
			widget.options.disabled = false;
		}
		widget.label = label;
		widget.localized_name = label;
		showSectionWidget(widget, showSegment, label);
	}
	updateSectionTabs(node);
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
		`segment:${widgetBooleanValue(getWidget(node, SEGMENT_TOGGLE_WIDGET)) ? 1 : 0}`,
		`section:${getActiveSection(node)}`,
	].join("||");
}

function addSceneInput(node) {
	const nextIndex = getSceneInputs(node).length + 1;
	node.addInput(formatSceneName(nextIndex), sceneInputType(nextIndex));
	const input = getInput(node, formatSceneName(nextIndex));
	if (input) {
		const label = `场景${nextIndex}`;
		setInputText(input, formatSceneName(nextIndex), label, sceneTooltip(nextIndex));
		forceInputType(input, sceneInputType(nextIndex));
	}
	hardNormalizeInputOrderAndTypes(node);
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
		forceInputType(input, sceneInputType(index));
		input.tooltip = sceneTooltip(index);
	});
	repairInputLinkSlots(node);
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
	// v23：缓存状态存在但 DOM widget 已不在 node.widgets 时，重新创建状态条。
	// 解决“状态条消失”的问题。
	if (node.__gjjLtx23MultiRefStatus?.widget && node.widgets?.includes?.(node.__gjjLtx23MultiRefStatus.widget)) {
		return node.__gjjLtx23MultiRefStatus;
	}
	if (node.__gjjLtx23MultiRefStatus) {
		try {
			node.__gjjLtx23MultiRefStatus.wrap?.remove?.();
		} catch (_) {}
		node.__gjjLtx23MultiRefStatus = null;
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
	let widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => node.__gjjLtx23MultiRefStatus?.height || 92,
	});
	if (!widget && typeof node.addWidget === "function") {
		widget = node.addWidget("text", STATUS_WIDGET_NAME, "等待执行", () => {}, { multiline: false });
		widget.computeSize = (width) => [width || 320, 28];
	}
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
	// 先清理未连线的 widget 转输入口，再补齐/纠正固定口；最后再完整重排并修复 link.target_slot。
	pruneUnlinkedConvertibleWidgetInputs(node, { force: !node.__gjjLtx23InitialWidgetSocketPruneDone });
	normalizeFixedInputs(node);
	reorderInputs(node);
	dedupeSceneInputs(node);
	trimTrailingUnusedScenes(node);
	ensureTrailingEmptyScene(node);
	dedupeSceneInputs(node);
	renameScenesSequentially(node);
	pruneUnlinkedConvertibleWidgetInputs(node);
	normalizeFixedInputs(node);
	hardNormalizeInputOrderAndTypes(node);
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

const GJJ_LTX23_PATCH_VERSION = "v24_force_ui_scene_expand";

function patchNode(node) {
	if (!node) {
		return;
	}
	const alreadySameVersion = node.__gjjLtx23MultiRefPatchedVersion === GJJ_LTX23_PATCH_VERSION;
	if (!alreadySameVersion) {
		console.log("[GJJ LTX2.3] input order patch v24: force DOM tabs/status restore + reliable scene expansion");
	}
	node.__gjjLtx23MultiRefPatched = true;
	node.__gjjLtx23MultiRefPatchedVersion = GJJ_LTX23_PATCH_VERSION;
	patchSizeWidgetPersistence(node);
	restorePanelSizeFromProperties(node);
	if (node.__gjjLtx23MultiRefStatus?.widget && !node.widgets?.includes?.(node.__gjjLtx23MultiRefStatus.widget)) node.__gjjLtx23MultiRefStatus = null;
	if (node.__gjjLtx23SectionTabs?.widget && !node.widgets?.includes?.(node.__gjjLtx23SectionTabs.widget)) node.__gjjLtx23SectionTabs = null;
	ensureStatusWidget(node);
	setStatus(node, { text: "等待执行", progress: 0 });
	stabilizeNode(node);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !isTargetNodeInstance(targetNode)) {
		return;
	}
	setStatus(targetNode, detail);
});

api.addEventListener("gjj_ltx23_multiref_segment", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !isTargetNodeInstance(targetNode)) {
		return;
	}
	addSegmentPreview(targetNode, detail);
});



// v22 override：转场/分段参数改为纯前端 DOM + node.properties。
// Python 后端不再声明这些 widgets，所以不会再有“隐藏控件仍占高度”的空白。
const GJJ_LTX23_V22_SECTION_FIELDS = new Set([
	"transition_enabled",
	"transition_curve",
	"transition_early_tail_ratio",
	"transition_implicit_guide_count",
	"transition_implicit_guide_strength",
	"transition_early_tail_strength",
	"transition_final_guide_strength",
	"segmented_execution",
	"segment_save_preset",
	"segment_video_format",
]);

function gjjV22Props(node) {
	return ensureNodeProperties(node);
}

function gjjV22Get(node, name, fallback) {
	const props = gjjV22Props(node);
	const value = props[name];
	return value === undefined || value === null || value === "" ? fallback : value;
}

function gjjV22Set(node, name, value) {
	const props = gjjV22Props(node);
	props[name] = value;
	node.graph?.change?.();
	app.graph?.setDirtyCanvas?.(true, true);
}

function gjjV22Bool(node, name, fallback = false) {
	const value = gjjV22Get(node, name, fallback);
	if (typeof value === "boolean") {
		return value;
	}
	const text = String(value).trim().toLowerCase();
	return ["true", "1", "yes", "on", "启用", "开启"].includes(text);
}

function gjjV22RemoveLegacySectionWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		const widget = node.widgets[index];
		if (!GJJ_LTX23_V22_SECTION_FIELDS.has(String(widget?.name || ""))) {
			continue;
		}
		try {
			widget.element?.remove?.();
			widget.inputEl?.remove?.();
		} catch (_) {}
		node.widgets.splice(index, 1);
	}
}

function gjjV22RemoveUnlinkedLegacySectionInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (!GJJ_LTX23_V22_SECTION_FIELDS.has(String(input?.name || ""))) {
			continue;
		}
		if (input?.link) {
			continue;
		}
		node.removeInput(index);
	}
}


function gjjV23StopCanvasEvents(element) {
	for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown"]) {
		element.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}
}

function gjjV22ControlStyle(el) {
	if (!el?.style) {
		return;
	}
	el.style.cssText = [
		"width:100%",
		"height:28px",
		"box-sizing:border-box",
		"border:1px solid #314a55",
		"border-radius:8px",
		"background:#202b31",
		"color:#e5f2f4",
		"padding:0 8px",
		"font-size:12px",
		"outline:none",
	].join(";");
}

function gjjV22MakeRow(labelText, inputEl) {
	const row = document.createElement("div");
	row.style.cssText = [
		"display:grid",
		"grid-template-columns:118px 1fr",
		"gap:8px",
		"align-items:center",
		"height:32px",
		"box-sizing:border-box",
	].join(";");
	const label = document.createElement("div");
	label.textContent = labelText;
	label.style.cssText = "font-size:12px;color:#b7c9d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	row.append(label, inputEl);
	return row;
}

function gjjV22CreateSelect(node, name, values, fallback) {
	const select = document.createElement("select");
	for (const value of values) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		select.appendChild(option);
	}
	select.value = String(gjjV22Get(node, name, fallback));
	gjjV22ControlStyle(select);
	gjjV23StopCanvasEvents(select);
	select.addEventListener("change", (event) => {
		event.stopPropagation();
		gjjV22Set(node, name, select.value);
		scheduleStabilize(node, 0);
	});
	return select;
}

function gjjV22CreateNumber(node, name, fallback, step = 0.01, min = 0, max = 1) {
	const input = document.createElement("input");
	input.type = "number";
	input.step = String(step);
	input.min = String(min);
	input.max = String(max);
	input.value = String(gjjV22Get(node, name, fallback));
	gjjV22ControlStyle(input);
	gjjV23StopCanvasEvents(input);
	input.addEventListener("change", (event) => {
		event.stopPropagation();
		const numeric = Number(input.value);
		gjjV22Set(node, name, Number.isFinite(numeric) ? numeric : fallback);
		scheduleStabilize(node, 0);
	});
	return input;
}

function gjjV22PanelHeight(node) {
	const active = getActiveSection(node);
	const showTransition = active === SECTION_TRANSITION && gjjV22Bool(node, "transition_enabled", false);
	const showSegment = active === SECTION_SEGMENT && gjjV22Bool(node, "segmented_execution", false);
	if (showTransition) {
		return 36 + 6 * 32 + 8;
	}
	if (showSegment) {
		return 36 + 2 * 32 + 8;
	}
	return 36;
}

function ensureSectionTabsWidget(node) {
	// v23：旧工作流/热更新后，缓存对象可能还在，但 widget 已经被 ComfyUI 移出 node.widgets，
	// 这会导致“按钮全部没有了”。缓存无效时必须重建。
	if (node.__gjjLtx23SectionTabs?.widget && node.widgets?.includes?.(node.__gjjLtx23SectionTabs.widget)) {
		return node.__gjjLtx23SectionTabs;
	}
	if (node.__gjjLtx23SectionTabs) {
		try {
			node.__gjjLtx23SectionTabs.root?.remove?.();
			node.__gjjLtx23SectionTabs.wrap?.remove?.();
		} catch (_) {}
		node.__gjjLtx23SectionTabs = null;
	}
	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:6px;box-sizing:border-box;";
	const tabs = document.createElement("div");
	tabs.style.cssText = "display:flex;gap:6px;align-items:center;box-sizing:border-box;";
	const transitionButton = document.createElement("button");
	const segmentButton = document.createElement("button");
	transitionButton.type = "button";
	segmentButton.type = "button";
	tabs.append(transitionButton, segmentButton);

	const transitionPanel = document.createElement("div");
	transitionPanel.style.cssText = "display:flex;flex-direction:column;gap:2px;";
	transitionPanel.append(
		gjjV22MakeRow("过渡曲线", gjjV22CreateSelect(node, "transition_curve", ["前置过渡", "平滑过渡", "线性过渡", "后置过渡"], "前置过渡")),
		gjjV22MakeRow("尾帧提前注入", gjjV22CreateNumber(node, "transition_early_tail_ratio", 0.75, 0.01, 0.1, 0.95)),
		gjjV22MakeRow("中间隐式guide", gjjV22CreateNumber(node, "transition_implicit_guide_count", 2, 1, 0, 4)),
		gjjV22MakeRow("隐式guide强度", gjjV22CreateNumber(node, "transition_implicit_guide_strength", 0.55, 0.01, 0, 1)),
		gjjV22MakeRow("提前尾帧强度", gjjV22CreateNumber(node, "transition_early_tail_strength", 0.75, 0.01, 0, 1)),
		gjjV22MakeRow("终点guide强度", gjjV22CreateNumber(node, "transition_final_guide_strength", 1.0, 0.01, 0, 1)),
	);

	const segmentPanel = document.createElement("div");
	segmentPanel.style.cssText = "display:flex;flex-direction:column;gap:2px;";
	segmentPanel.append(
		gjjV22MakeRow("保存位置预设", gjjV22CreateSelect(node, "segment_save_preset", [
			"video/GJJ_LTX多图分段",
			"video/GJJ_LTX多图分段/{date}",
			"video/GJJ_LTX多图分段/{date}/{time}",
			"video/GJJ_LTX多图分段/{date}/任务{node}",
		], "video/GJJ_LTX多图分段")),
		gjjV22MakeRow("视频格式", gjjV22CreateSelect(node, "segment_video_format", ["video/h264-mp4", "video/h265-mp4", "video/webm"], "video/h264-mp4")),
	);

	root.append(tabs, transitionPanel, segmentPanel);
	installButtonEvents(transitionButton, () => {
		const enabled = gjjV22Bool(node, "transition_enabled", false);
		const isOpen = getActiveSection(node) === SECTION_TRANSITION;
		if (enabled && isOpen) {
			gjjV22Set(node, "transition_enabled", false);
			setActiveSection(node, SECTION_NONE);
		} else {
			gjjV22Set(node, "transition_enabled", true);
			setActiveSection(node, SECTION_TRANSITION);
		}
		scheduleStabilize(node, 0);
	});
	installButtonEvents(segmentButton, () => {
		const enabled = gjjV22Bool(node, "segmented_execution", false);
		const isOpen = getActiveSection(node) === SECTION_SEGMENT;
		if (enabled && isOpen) {
			gjjV22Set(node, "segmented_execution", false);
			setActiveSection(node, SECTION_NONE);
		} else {
			gjjV22Set(node, "segmented_execution", true);
			setActiveSection(node, SECTION_SEGMENT);
		}
		scheduleStabilize(node, 0);
	});

	let widget = node.addDOMWidget?.(SECTION_TABS_WIDGET_NAME, SECTION_TABS_WIDGET_NAME, root, {
		hideOnZoom: false,
		getHeight: () => gjjV22PanelHeight(node),
	});
	if (!widget && typeof node.addWidget === "function") {
		// 极少数前端版本没有 addDOMWidget 时，至少保留一个可见占位，避免按钮完全消失。
		widget = node.addWidget("button", SECTION_TABS_WIDGET_NAME, "高级参数", () => {
			const enabled = gjjV22Bool(node, "transition_enabled", false);
			gjjV22Set(node, "transition_enabled", !enabled);
			setActiveSection(node, !enabled ? SECTION_TRANSITION : SECTION_NONE);
			scheduleStabilize(node, 0);
		});
	}
	if (widget) {
		widget.computeSize = (width) => [width || 320, gjjV22PanelHeight(node)];
		const currentIndex = node.widgets?.indexOf(widget) ?? -1;
		const denoiseIndex = getWidgetIndex(node, "denoise_strength");
		const targetIndex = denoiseIndex >= 0 ? denoiseIndex + 1 : node.widgets.length;
		if (currentIndex >= 0 && currentIndex !== targetIndex) {
			node.widgets.splice(currentIndex, 1);
			node.widgets.splice(Math.max(0, Math.min(targetIndex, node.widgets.length)), 0, widget);
		}
	}
	node.__gjjLtx23SectionTabs = { widget, root, tabs, transitionButton, segmentButton, transitionPanel, segmentPanel };
	return node.__gjjLtx23SectionTabs;
}

function updateSectionTabs(node) {
	const state = ensureSectionTabsWidget(node);
	const active = getActiveSection(node);
	const transitionEnabled = gjjV22Bool(node, "transition_enabled", false);
	const segmentEnabled = gjjV22Bool(node, "segmented_execution", false);
	state.transitionPanel.style.display = active === SECTION_TRANSITION && transitionEnabled ? "flex" : "none";
	state.segmentPanel.style.display = active === SECTION_SEGMENT && segmentEnabled ? "flex" : "none";
	state.transitionButton.textContent = `${transitionEnabled ? "✅" : "⬜"} 转场控制`;
	state.transitionButton.title = transitionEnabled ? "点击关闭转场控制并隐藏参数" : "点击开启转场控制并显示参数";
	styleSectionButton(state.transitionButton, transitionEnabled, active === SECTION_TRANSITION);
	state.segmentButton.textContent = `${segmentEnabled ? "✅" : "⬜"} 多图分段执行`;
	state.segmentButton.title = segmentEnabled ? "点击关闭多图分段执行并隐藏参数" : "点击开启多图分段执行并显示参数";
	styleSectionButton(state.segmentButton, segmentEnabled, active === SECTION_SEGMENT);
	if (state.widget) {
		state.widget.computeSize = (width) => [width || 320, gjjV22PanelHeight(node)];
	}
}

function updateTransitionWidgets(node) {
	gjjV22RemoveLegacySectionWidgets(node);
	gjjV22RemoveUnlinkedLegacySectionInputs(node);
	const active = getActiveSection(node);
	if (active === SECTION_TRANSITION && !gjjV22Bool(node, "transition_enabled", false)) {
		setActiveSection(node, SECTION_NONE);
	}
	if (active === SECTION_SEGMENT && !gjjV22Bool(node, "segmented_execution", false)) {
		setActiveSection(node, SECTION_NONE);
	}
	ensureSectionTabsWidget(node);
	updateSectionTabs(node);
}

app.registerExtension({
	name: "GJJ.LTX23ImageToVideoMultiRef",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!isTargetNodeDef(nodeData)) {
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
			if (isTargetNodeInstance(node)) {
				patchNode(node);
			}
		}
		if (!window.__gjjLtx23V24SceneExpandTimer) {
			window.__gjjLtx23V24SceneExpandTimer = setInterval(() => {
				for (const node of app.graph?._nodes || []) {
					if (!isTargetNodeInstance(node)) {
						continue;
					}
					patchNode(node);
					// 连接场景1后，有些 ComfyUI 版本不会立刻触发 onConnectionsChange；
					// 这里低频兜底，确保动态场景口、DOM 按钮、状态条都能恢复。
					const before = getSceneInputs(node).length;
					stabilizeNode(node);
					const after = getSceneInputs(node).length;
					if (after !== before) {
						refreshNode(node);
					}
				}
			}, 600);
		}
	},
});

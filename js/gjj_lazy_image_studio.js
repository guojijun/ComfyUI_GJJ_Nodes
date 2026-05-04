import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
	getCachedModelFamilyPresets,
	getModelFamilyPresets,
} from "./gjj_model_family_preset_table.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_LazyImageStudio"]);
const IMAGE_PREFIX = "image_";
const PRIMARY_IMAGE_INPUT_NAME = "image_01";
const BATCH_SOURCE_IMAGES_WIDGET = "batch_source_images";
const MAIN_MASK_NAME = "mask";
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const MIN_VISIBLE_IMAGES = 1;
const MAX_IMAGES = Number.POSITIVE_INFINITY;
const SEARCHABLE_WIDGET_NAMES = new Set([
	"unet_name",
	"clip_name1",
	"vae_name",
	"lora_1_name",
	"lora_2_name",
]);
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const IMAGE_TOOLTIP = "参考图片输入；不连接时走文生图，连接后会自动扩展下一张图片插槽。";
const PRIMARY_IMAGE_TOOLTIP = "可直接接入 GJJ · 多图片加载预览器 的批量图片输出；节点会在后端按原图顺序恢复多图参考，不会自动补连其它图片口，并在所有图片里不分先后取最大图自动同步宽高。";
const MASK_TOOLTIP = "主图可选遮罩；局部编辑时会作为 noise_mask 使用。";
const STATUS_WIDGET_NAME = "gjj_lazy_image_status";

const SearchUtils = globalThis.GJJSearchUtils || {
	normalizeText(value) {
		return String(value || "").trim().toLowerCase();
	},
	canonicalizeText(value) {
		return this.normalizeText(value).replace(/[\\/_\-\.\s]+/g, "");
	},
	parseQuery(query) {
		const normalized = String(query || "").trim().toLowerCase();
		if (!normalized) {
			return [];
		}
		return normalized
			.split(/\s+/)
			.map((term) => term.split(",").map((token) => this.canonicalizeText(token)).filter(Boolean))
			.filter((group) => group.length);
	},
	fuzzyTokenMatch(text, canonicalText, token) {
		if (!token) {
			return true;
		}
		if (text.includes(token) || canonicalText.includes(token)) {
			return true;
		}
		let pointer = 0;
		for (const char of canonicalText) {
			if (char === token[pointer]) {
				pointer += 1;
				if (pointer >= token.length) {
					return true;
				}
			}
		}
		return false;
	},
	filterValues(values, query, currentValue = "") {
		const groups = this.parseQuery(query);
		const list = Array.isArray(values) ? values.map((item) => String(item ?? "")) : [];
		if (!groups.length) {
			return list;
		}
		const current = String(currentValue ?? "");
		const filtered = list.filter((item) => {
			const normalizedItem = this.normalizeText(item);
			const canonicalItem = this.canonicalizeText(item);
			return groups.every((group) => group.some((token) => this.fuzzyTokenMatch(normalizedItem, canonicalItem, token)));
		});
		if (current && !filtered.includes(current) && list.includes(current)) {
			filtered.unshift(current);
		}
		return filtered.length ? filtered : (current ? [current] : list.slice(0, 1));
	},
};

// 一套模型族一块，按 Python 侧当前生效的配套关系展开，便于逐项核对。
let MODEL_PRESETS = getCachedModelFamilyPresets();

async function ensureModelPresetsLoaded() {
	if (MODEL_PRESETS.length) {
		return MODEL_PRESETS;
	}
	MODEL_PRESETS = await getModelFamilyPresets();
	return MODEL_PRESETS;
}

function refreshPresetDrivenNodes() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(node?.comfyClass)) {
			scheduleStabilize(node, 0, true);
		}
	}
}

function formatName(prefix, index) {
	return `${prefix}${String(index).padStart(2, "0")}`;
}

function getIndex(name, prefix) {
	const text = String(name || "");
	if (!text.startsWith(prefix)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(prefix.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getInput(node, name) {
	return node.inputs?.find((input) => input?.name === name);
}

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function getImageInputs(node) {
	return (node.inputs || [])
		.filter((input) => String(input?.name || "").startsWith(IMAGE_PREFIX))
		.sort((a, b) => getIndex(a?.name, IMAGE_PREFIX) - getIndex(b?.name, IMAGE_PREFIX));
}

function getImages(node) {
	return getImageInputs(node).map((imageInput, idx) => ({
		index: idx + 1,
		image: imageInput,
	}));
}

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function refreshNode(node) {
	setDirty(node);
}

function roundToMultipleOfEight(value) {
	return Math.max(8, Math.round(Number(value || 0) / 8) * 8);
}

function patchPrimarySourceImageNode(sourceNode) {
	if (!sourceNode || sourceNode.__gjjLazyPrimarySourcePatched) {
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
		setTimeout(() => {
			for (const node of app.graph?._nodes || []) {
				if (!TARGET_NODES.has(node?.comfyClass)) {
					continue;
				}
				const input = getInput(node, PRIMARY_IMAGE_INPUT_NAME);
				const linkId = input?.link;
				const link = linkId && app.graph?.links ? app.graph.links[linkId] : null;
				if (link?.origin_id === sourceNode.id) {
					void trySyncPrimaryImageSize(node);
				}
			}
		}, 0);
		return result;
	};
	sourceNode.__gjjLazyPrimarySourcePatched = true;
}

async function loadImageDimensionsFromSourceNode(sourceNode) {
	if (!sourceNode) {
		return null;
	}
	const loadImageDimensionsFromUrl = (url) => new Promise((resolve) => {
		if (!url) {
			resolve(null);
			return;
		}
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => resolve(null);
		image.src = url;
	});
	const buildViewUrl = (filename, viewType, subfolder = "") => {
		if (!filename || !viewType) {
			return "";
		}
		return `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(viewType)}&subfolder=${encodeURIComponent(subfolder || "")}&rand=${Date.now()}`;
	};
	if (sourceNode.comfyClass === "GJJ_MultiImageLoader") {
		const state = sourceNode.__gjjMultiImageState || {};
		const normalizeItems = (items, defaultType = "input") => (Array.isArray(items) ? items : [])
			.map((item) => ({
				filename: String(item?.filename || "").trim(),
				subfolder: String(item?.subfolder || "").trim(),
				type: String(item?.type || defaultType).trim() || defaultType,
			}))
			.filter((item) => item.filename);
		const executedImages = normalizeItems(state.executedImages, "temp");
		const selectedWidget = getWidget(sourceNode, "selected_images");
		let selectedImages = [];
		try {
			const parsed = JSON.parse(String(selectedWidget?.value || "[]"));
			selectedImages = normalizeItems(parsed, "input");
		} catch (error) {
			selectedImages = [];
		}
		const items = executedImages.length > 0 ? executedImages : selectedImages;
		if (!items.length) {
			return null;
		}
		const cacheKey = JSON.stringify(items);
		if (sourceNode.__gjjLazyLargestImageSizeCacheKey === cacheKey) {
			return sourceNode.__gjjLazyLargestImageSizeCacheValue || null;
		}
		const sizes = await Promise.all(items.map((item) => loadImageDimensionsFromUrl(buildViewUrl(item.filename, item.type, item.subfolder))));
		let bestSize = null;
		let bestArea = -1;
		for (const size of sizes) {
			if (!size) {
				continue;
			}
			const area = Number(size.width || 0) * Number(size.height || 0);
			if (!bestSize || area > bestArea || (area === bestArea && Number(size.width || 0) > Number(bestSize.width || 0))) {
				bestArea = area;
				bestSize = size;
			}
		}
		sourceNode.__gjjLazyLargestImageSizeCacheKey = cacheKey;
		sourceNode.__gjjLazyLargestImageSizeCacheValue = bestSize ? {
			width: Number(bestSize.width || 0),
			height: Number(bestSize.height || 0),
		} : null;
		return sourceNode.__gjjLazyLargestImageSizeCacheValue;
	}
	patchPrimarySourceImageNode(sourceNode);
	const imageWidget = getWidget(sourceNode, "image");
	const filename = String(imageWidget?.value || "").trim();
	if (!filename) {
		return null;
	}
	let viewType = null;
	if (sourceNode.comfyClass === "LoadImage") {
		viewType = "input";
	} else if (sourceNode.comfyClass === "LoadImageOutput") {
		viewType = "output";
	} else {
		return null;
	}
	return loadImageDimensionsFromUrl(buildViewUrl(filename, viewType));
}

async function trySyncPrimaryImageSize(node) {
	const input = getInput(node, PRIMARY_IMAGE_INPUT_NAME);
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return;
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const size = await loadImageDimensionsFromSourceNode(sourceNode);
	if (!size) {
		return;
	}
	setWidgetValue(getWidget(node, WIDTH_WIDGET), roundToMultipleOfEight(size.width));
	setWidgetValue(getWidget(node, HEIGHT_WIDGET), roundToMultipleOfEight(size.height));
	refreshNode(node);
}

function getPrimaryImageLinkInfo(node) {
	const input = getInput(node, PRIMARY_IMAGE_INPUT_NAME);
	const linkId = input?.link;
	if (!input || !linkId || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	if (!link) {
		return null;
	}
	const sourceNode = link.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const sourceSlotIndex = Number.isInteger(link.origin_slot) ? link.origin_slot : -1;
	return { input, linkId, link, sourceNode, sourceSlotIndex };
}

function cleanupRedundantMultiLoaderLinks(node) {
	if (!node || node.__gjjLazyBatchCleaning || typeof node.disconnectInput !== "function") {
		return false;
	}
	const info = getPrimaryImageLinkInfo(node);
	if (!info || info.sourceNode?.comfyClass !== "GJJ_MultiImageLoader" || info.sourceSlotIndex !== 0) {
		return false;
	}
	node.__gjjLazyBatchCleaning = true;
	let changed = false;
	try {
		getImages(node).forEach((item, zeroIndex) => {
			if (zeroIndex <= 0) {
				return;
			}
			const input = item?.image;
			const linkId = input?.link;
			const inputIndex = node.inputs?.indexOf(input) ?? -1;
			if (!linkId || inputIndex < 0 || !app.graph?.links) {
				return;
			}
			const link = app.graph.links[linkId];
			if (!link || link.origin_id !== info.link.origin_id) {
				return;
			}
			const sourceSlotIndex = Number.isInteger(link.origin_slot) ? link.origin_slot : -1;
			if (sourceSlotIndex !== zeroIndex) {
				return;
			}
			node.disconnectInput(inputIndex);
			changed = true;
		});
		return changed;
	} finally {
		node.__gjjLazyBatchCleaning = false;
	}
}

function buildMultiLoaderSelectionPayload(sourceNode) {
	const selectedWidget = getWidget(sourceNode, "selected_images");
	const rawValue = String(selectedWidget?.value || "[]").trim();
	return rawValue || "[]";
}

function syncPrimaryBatchSource(node) {
	const widget = getWidget(node, BATCH_SOURCE_IMAGES_WIDGET);
	if (!widget) {
		return;
	}
	const info = getPrimaryImageLinkInfo(node);
	if (!info || info.sourceNode?.comfyClass !== "GJJ_MultiImageLoader" || info.sourceSlotIndex !== 0) {
		widget.value = "[]";
		return;
	}
	widget.value = buildMultiLoaderSelectionPayload(info.sourceNode);
}

function parseProgress(text) {
	const value = String(text || "");
	const match = value.match(/(\d+)\s*\/\s*(\d+)/);
	if (match) {
		const current = Math.max(0, Number(match[1] || 0));
		const total = Math.max(1, Number(match[2] || 1));
		return Math.max(0, Math.min(100, (current / total) * 100));
	}
	if (value.includes("完成")) {
		return 100;
	}
	if (value.includes("失败")) {
		return 100;
	}
	return 8;
}

function getDomHideTargets(widget) {
	const seeds = [
		widget?.element,
		widget?.inputEl,
		widget?.widget,
		widget?.domElement,
	].filter(Boolean);
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
		while (current && depth < 5) {
			const className = String(current.className || "");
			const tagName = String(current.tagName || "").toUpperCase();
			const looksLikeWidgetRow =
				/widget|property|row|control|field|input|dom/i.test(className) ||
				tagName === "LABEL" ||
				tagName === "LI";
			if (looksLikeWidgetRow) {
				addTarget(current);
			}
			current = current.parentElement;
			depth += 1;
		}
	}
	return targets;
}

function disableDomPointerChain(element) {
	if (!element) {
		return;
	}
	let current = element;
	let depth = 0;
	while (current && depth < 5) {
		const className = String(current.className || "");
		const tagName = String(current.tagName || "").toUpperCase();
		const isWidgetLayer = /widget|property|row|control|field|input|dom/i.test(className) || tagName === "LABEL" || tagName === "LI";
		if (current !== element && !isWidgetLayer) {
			break;
		}
		current.style.pointerEvents = "none";
		current = current.parentElement;
		depth += 1;
	}
}

function disableStatusPointerEvents(state) {
	if (!state) {
		return;
	}
	for (const element of [
		state.wrap,
		state.text,
		state.progressInner,
		state.widget?.element,
		state.widget?.inputEl,
		state.widget?.widget,
		state.widget?.domElement,
	].filter(Boolean)) {
		disableDomPointerChain(element);
	}
}

function drawRoundRect(ctx, x, y, width, height, radius) {
	if (typeof ctx.roundRect === "function") {
		ctx.beginPath();
		ctx.roundRect(x, y, width, height, radius);
		return;
	}
	const r = Math.max(0, Math.min(radius, width / 2, height / 2));
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + width - r, y);
	ctx.quadraticCurveTo(x + width, y, x + width, y + r);
	ctx.lineTo(x + width, y + height - r);
	ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
	ctx.lineTo(x + r, y + height);
	ctx.quadraticCurveTo(x, y + height, x, y + height - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
}

function cleanupLegacyStatusWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		const widget = node.widgets[index];
		if (widget?.name !== STATUS_WIDGET_NAME || widget.__gjjCanvasStatusWidget) {
			continue;
		}
		for (const element of getDomHideTargets(widget)) {
			element.style.display = "none";
			element.style.pointerEvents = "none";
		}
		node.widgets.splice(index, 1);
	}
}

function ensureStatusWidget(node) {
	cleanupLegacyStatusWidgets(node);
	if (node.__gjjLazyImageStatus?.widget?.__gjjCanvasStatusWidget) {
		return node.__gjjLazyImageStatus;
	}
	const widget = {
		name: STATUS_WIDGET_NAME,
		type: "gjj_status",
		value: "等待执行",
		__gjjCanvasStatusWidget: true,
		computeSize(width) {
			return [Math.max(200, Number(width || node?.size?.[0] || 200)), 62];
		},
		draw(ctx, targetNode, width, y) {
			const message = String(widget.value || "等待执行");
			const progress = parseProgress(message);
			const x = 10;
			const boxY = y + 4;
			const boxWidth = Math.max(80, Number(width || targetNode?.size?.[0] || 200) - 20);
			const boxHeight = 52;
			ctx.save();
			drawRoundRect(ctx, x, boxY, boxWidth, boxHeight, 10);
			ctx.fillStyle = "#0f1a1f";
			ctx.fill();
			ctx.strokeStyle = "#31464f";
			ctx.lineWidth = 1;
			ctx.stroke();
			ctx.fillStyle = "#dce7e2";
			ctx.font = "12px sans-serif";
			ctx.textBaseline = "top";
			const compact = message.length > 34 ? `${message.slice(0, 33)}...` : message;
			ctx.fillText(compact, x + 10, boxY + 8);
			drawRoundRect(ctx, x + 10, boxY + 34, boxWidth - 20, 7, 999);
			ctx.fillStyle = "#1a262c";
			ctx.fill();
			drawRoundRect(ctx, x + 10, boxY + 34, Math.max(4, (boxWidth - 20) * progress / 100), 7, 999);
			ctx.fillStyle = "#34d399";
			ctx.fill();
			ctx.restore();
		},
	};
	node.widgets = node.widgets || [];
	node.widgets.push(widget);
	node.__gjjLazyImageStatus = { widget };
	return node.__gjjLazyImageStatus;
}

function setStatus(node, text) {
	const state = ensureStatusWidget(node);
	state.widget.value = String(text || "等待执行");
	refreshNode(node);
}

function addImage(node) {
	if (getImages(node).length >= MAX_IMAGES) {
		return;
	}
	const nextIndex = getImages(node).length + 1;
	node.addInput(formatName(IMAGE_PREFIX, nextIndex), nextIndex === 1 ? BATCH_IMAGE_TYPE : "IMAGE");
}

function imageHasLink(image) {
	return Boolean(image?.image?.link);
}

function ensureTrailingEmptyImage(node) {
	const images = getImages(node);
	if (images.length === 0) {
		addImage(node);
		return;
	}
	if (images.length >= MAX_IMAGES) {
		return;
	}
	const lastImage = images[images.length - 1];
	if (imageHasLink(lastImage)) {
		addImage(node);
	}
}

function removeUnusedImagesFromEnd(node, minImages = MIN_VISIBLE_IMAGES) {
	const images = getImages(node);
	for (let i = images.length - 1; i >= minImages; i -= 1) {
		const image = images[i];
		if (imageHasLink(image)) {
			break;
		}
		const imageSlotIndex = node.inputs.indexOf(image.image);
		if (imageSlotIndex >= 0) {
			node.removeInput(imageSlotIndex);
		}
	}
}

function renameImages(node) {
	getImages(node).forEach((item, zeroIndex) => {
		const index = zeroIndex + 1;
		if (item.image) {
			item.image.name = formatName(IMAGE_PREFIX, index);
			item.image.label = index === 1 ? "批量图片" : `图片 ${index - 1}`;
			item.image.localized_name = item.image.label;
			item.image.tooltip = index === 1 ? PRIMARY_IMAGE_TOOLTIP : IMAGE_TOOLTIP;
			item.image.type = index === 1 ? BATCH_IMAGE_TYPE : "IMAGE";
		}
	});
	const maskInput = getInput(node, MAIN_MASK_NAME);
	if (maskInput) {
		maskInput.label = "主图遮罩";
		maskInput.localized_name = "主图遮罩";
		maskInput.tooltip = MASK_TOOLTIP;
		maskInput.type = "MASK";
		maskInput.hidden = false;
	}
	hideWidget(getWidget(node, BATCH_SOURCE_IMAGES_WIDGET));
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function hideWidget(widget) {
	if (!widget || widget.__gjjHidden) {
		return;
	}
	widget.__gjjHidden = true;
	widget.__gjjOriginalType = widget.type;
	widget.__gjjOriginalHidden = widget.hidden;
	widget.__gjjOriginalComputeSize = widget.computeSize;
	widget.__gjjOriginalDraw = widget.draw;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, -4];
	widget.draw = () => {};
	widget.hidden = true;
	widget.__gjjDomHideTargets = getDomHideTargets(widget);
	for (const element of widget.__gjjDomHideTargets) {
		if (!element.__gjjOriginalDisplayStored) {
			element.__gjjOriginalDisplayStored = true;
			element.__gjjOriginalDisplay = element.style.display;
			element.__gjjOriginalPointerEvents = element.style.pointerEvents;
		}
		element.style.display = "none";
		element.style.pointerEvents = "none";
	}
}

function showWidget(widget) {
	if (!widget || !widget.__gjjHidden) {
		return;
	}
	widget.__gjjHidden = false;
	widget.type = widget.__gjjOriginalType || widget.type;
	widget.computeSize = widget.__gjjOriginalComputeSize || widget.computeSize;
	widget.draw = widget.__gjjOriginalDraw || widget.draw;
	widget.hidden = Boolean(widget.__gjjOriginalHidden);
	for (const element of widget.__gjjDomHideTargets || []) {
		if (element.__gjjOriginalDisplayStored) {
			element.style.display = element.__gjjOriginalDisplay || "";
			element.style.pointerEvents = element.__gjjOriginalPointerEvents || "";
		} else {
			element.style.display = "";
			element.style.pointerEvents = "";
		}
	}
}

function setWidgetValue(widget, value) {
	if (!widget || value === undefined || value === null || value === "") {
		return;
	}
	const options = Array.isArray(widget.__gjjSearchSourceValues)
		? widget.__gjjSearchSourceValues
		: (Array.isArray(widget.options?.values) ? widget.options.values : []);
	let resolvedValue = value;
	if (options.length && !options.includes(value) && widget.type !== "text" && widget.type !== "number") {
		const expectedText = String(value || "");
		const expected = SearchUtils.canonicalizeText(expectedText.split(/[\\/]/).pop() || expectedText);
		let matched = null;
		let bestScore = -1;
		for (const option of options) {
			const optionText = String(option || "");
			const basename = optionText.split(/[\\/]/).pop() || optionText;
			const optionCanonical = SearchUtils.canonicalizeText(optionText);
			const basenameCanonical = SearchUtils.canonicalizeText(basename);
			let score = -1;
			if (optionText === expectedText || basename === expectedText) {
				score = 1000;
			} else if (basenameCanonical === expected || optionCanonical === expected) {
				score = 900;
			} else if (expected && (basenameCanonical.includes(expected) || optionCanonical.includes(expected))) {
				const penalty = Math.max(0, (basenameCanonical.length || optionCanonical.length) - expected.length);
				score = 700 - penalty;
				if (widget.name === "lora_1_name" || widget.name === "lora_2_name") {
					if (optionCanonical.includes("4step") || basenameCanonical.includes("4step")) {
						score += 8;
					}
					if (optionCanonical.includes("8step") || basenameCanonical.includes("8step")) {
						score += 4;
					}
				}
			}
			if (score > bestScore) {
				bestScore = score;
				matched = option;
			}
		}
		if (matched) {
			resolvedValue = matched;
		} else if (SEARCHABLE_WIDGET_NAMES.has(widget.name)) {
			resolvedValue = String(value);
			setWidgetSyntheticPresetValue(widget, resolvedValue);
		}
	}
	if (
		!options.length
		|| options.includes(resolvedValue)
		|| widget.type === "text"
		|| widget.type === "number"
		|| SEARCHABLE_WIDGET_NAMES.has(widget.name)
	) {
		widget.value = resolvedValue;
		widget.callback?.(resolvedValue);
	}
}

function setWidgetEnabled(widget, enabled) {
	if (!widget) {
		return;
	}
	widget.disabled = !enabled;
	if (widget.options) {
		widget.options.disabled = !enabled;
	}
	const opacity = enabled ? "1" : "0.45";
	if (widget.inputEl) {
		widget.inputEl.disabled = !enabled;
		widget.inputEl.style.opacity = opacity;
		widget.inputEl.style.pointerEvents = enabled ? "" : "none";
	}
	if (widget.element && "disabled" in widget.element) {
		widget.element.disabled = !enabled;
		widget.element.style.opacity = opacity;
		widget.element.style.pointerEvents = enabled ? "" : "none";
	}
}

function matchPreset(unetName) {
	const normalized = SearchUtils.normalizeText(unetName);
	const canonical = SearchUtils.canonicalizeText(unetName);
	let best = null;
	let bestLength = -1;
	for (const preset of MODEL_PRESETS) {
		for (const keyword of preset.keywords || []) {
			const normalizedKeyword = SearchUtils.normalizeText(keyword);
			const canonicalKeyword = SearchUtils.canonicalizeText(keyword);
			if (
				(normalized.includes(normalizedKeyword) || (canonicalKeyword && canonical.includes(canonicalKeyword)))
				&& (canonicalKeyword || normalizedKeyword).length > bestLength
			) {
				best = preset;
				bestLength = (canonicalKeyword || normalizedKeyword).length;
			}
		}
	}
	return best;
}

function getWidgetOptionValues(widget) {
	if (!widget) {
		return [];
	}
	if (!Array.isArray(widget.__gjjAllValues)) {
		widget.__gjjAllValues = Array.isArray(widget.options?.values) ? [...widget.options.values] : [];
	}
	return widget.__gjjAllValues;
}

function setWidgetOptionValues(widget, values) {
	if (!widget) {
		return;
	}
	const nextValues = Array.isArray(values) ? [...values] : [];
	if (!widget.options) {
		widget.options = {};
	}
	widget.options.values = nextValues;
	widget.__gjjSearchSourceValues = nextValues;
}

function setWidgetSyntheticPresetValue(widget, value) {
	if (!widget || !SEARCHABLE_WIDGET_NAMES.has(widget.name)) {
		return;
	}
	const baseValues = getWidgetOptionValues(widget);
	if (!widget.options) {
		widget.options = {};
	}
	if (!value) {
		widget.options.values = [...baseValues];
		widget.__gjjSearchSourceValues = [...baseValues];
		return;
	}
	const textValue = String(value);
	const nextValues = [textValue, ...baseValues.filter((item) => String(item) !== textValue)];
	widget.options.values = nextValues;
	widget.__gjjSearchSourceValues = nextValues;
}

function getFluxOptionalClipCandidates(widget, preset) {
	const available = getWidgetOptionValues(widget);
	const preferred = [
		preset?.clipNames?.[1] || "",
		"t5xxl_fp16.safetensors",
		"t5xxl_fp8_e4m3fn_scaled.safetensors",
		"t5xxl_fp8_e4m3fn.safetensors",
	];
	return [...new Set(preferred.filter((name) => name && available.includes(name)))];
}

function ensureSearchPicker() {
	if (globalThis.__gjjSearchPicker) {
		return globalThis.__gjjSearchPicker;
	}
	const panel = document.createElement("div");
	panel.style.position = "fixed";
	panel.style.zIndex = "99999";
	panel.style.minWidth = "320px";
	panel.style.maxWidth = "420px";
	panel.style.maxHeight = "420px";
	panel.style.display = "none";
	panel.style.flexDirection = "column";
	panel.style.gap = "8px";
	panel.style.padding = "10px";
	panel.style.borderRadius = "12px";
	panel.style.border = "1px solid rgba(120,140,170,0.45)";
	panel.style.background = "#182127";
	panel.style.boxShadow = "0 14px 38px rgba(0,0,0,0.45)";

	const searchRow = document.createElement("div");
	searchRow.style.display = "flex";
	searchRow.style.alignItems = "center";
	searchRow.style.gap = "8px";

	const icon = document.createElement("div");
	icon.textContent = "🔍";
	icon.style.flex = "0 0 auto";
	icon.style.fontSize = "15px";
	icon.style.lineHeight = "1";
	icon.style.opacity = "0.95";

	const search = document.createElement("input");
	search.type = "text";
	search.placeholder = "搜索：空格=与，逗号=或";
	search.style.width = "100%";
	search.style.height = "34px";
	search.style.padding = "0 12px";
	search.style.borderRadius = "9px";
	search.style.border = "1px solid rgba(120,140,170,0.4)";
	search.style.background = "#11181d";
	search.style.color = "#e7edf3";
	search.style.outline = "none";

	const list = document.createElement("div");
	list.style.display = "flex";
	list.style.flexDirection = "column";
	list.style.gap = "6px";
	list.style.overflow = "auto";
	list.style.maxHeight = "360px";

	searchRow.appendChild(icon);
	searchRow.appendChild(search);
	panel.appendChild(searchRow);
	panel.appendChild(list);
	document.body.appendChild(panel);

	const picker = {
		panel,
		search,
		list,
		state: null,
		close() {
			panel.style.display = "none";
			search.value = "";
			list.innerHTML = "";
			this.state = null;
		},
		render() {
			if (!this.state) {
				return;
			}
			const { widget, onSelect } = this.state;
			const source = widget.__gjjSearchSourceValues || [];
			const filtered = SearchUtils.filterValues(source, search.value, widget.value || "");
			list.innerHTML = "";
			for (const value of filtered.slice(0, 120)) {
				const item = document.createElement("button");
				item.type = "button";
				item.textContent = value || "(空)";
				item.title = value || "";
				item.style.textAlign = "left";
				item.style.padding = "8px 10px";
				item.style.borderRadius = "8px";
				item.style.border = "1px solid rgba(120,140,170,0.24)";
				item.style.background = String(value) === String(widget.value) ? "#23313c" : "#12191f";
				item.style.color = "#e7edf3";
				item.style.cursor = "pointer";
				item.addEventListener("click", () => {
					onSelect(value);
					this.close();
				});
				list.appendChild(item);
			}
			if (!list.children.length) {
				const empty = document.createElement("div");
				empty.textContent = "没有匹配结果";
				empty.style.padding = "8px 10px";
				empty.style.color = "#93a1ad";
				list.appendChild(empty);
			}
		},
		open(anchor, widget, onSelect) {
			const rect = anchor?.getBoundingClientRect?.();
			const anchorLeft = Number.isFinite(anchor?.x) ? anchor.x : rect?.left;
			const anchorTop = Number.isFinite(anchor?.y) ? anchor.y : rect?.bottom;
			this.state = { widget, onSelect };
			panel.style.left = `${Math.max(12, Math.min(anchorLeft || 12, window.innerWidth - 440))}px`;
			panel.style.top = `${Math.max(12, Math.min((anchorTop || 12) + 6, window.innerHeight - 440))}px`;
			panel.style.display = "flex";
			search.value = "";
			this.render();
			setTimeout(() => search.focus(), 0);
		},
	};

	search.addEventListener("input", () => picker.render());
	search.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			picker.close();
		}
	});

	document.addEventListener("mousedown", (event) => {
		if (!picker.state) {
			return;
		}
		if (!panel.contains(event.target)) {
			picker.close();
		}
	});

	globalThis.__gjjSearchPicker = picker;
	return picker;
}

function isSearchableWidget(widget) {
	return Boolean(widget && SEARCHABLE_WIDGET_NAMES.has(widget.name));
}

function getWidgetHeight(node, widget) {
	if (!widget || widget.hidden) {
		return 0;
	}
	try {
		const size = widget.computeSize?.(node.size?.[0] || 0);
		if (Array.isArray(size) && Number.isFinite(size[1])) {
			return size[1];
		}
	} catch {
		// ignore and fall back to default height
	}
	return Number(globalThis.LiteGraph?.NODE_WIDGET_HEIGHT) || 20;
}

function getWidgetTop(node, widget) {
	if (Number.isFinite(widget?.last_y)) {
		return widget.last_y;
	}
	if (Number.isFinite(widget?.y)) {
		return widget.y;
	}
	let top = 0;
	for (const current of node.widgets || []) {
		if (current === widget) {
			return top;
		}
		top += getWidgetHeight(node, current) + 4;
	}
	return top;
}

function getSearchableWidgetAt(node, localPos) {
	if (!node || !Array.isArray(localPos)) {
		return null;
	}
	const [x, y] = localPos;
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return null;
	}
	if (x < 12 || x > (node.size?.[0] || 0) - 12) {
		return null;
	}
	for (const widget of node.widgets || []) {
		if (!isSearchableWidget(widget) || widget.__gjjHidden || widget.hidden) {
			continue;
		}
		const top = getWidgetTop(node, widget);
		const height = getWidgetHeight(node, widget);
		if (!Number.isFinite(top) || height <= 0) {
			continue;
		}
		if (y >= top && y <= top + height) {
			return widget;
		}
	}
	return null;
}

function openSearchablePicker(node, widget, event) {
	if (!widget) {
		return false;
	}
	if (!Array.isArray(widget.__gjjSearchSourceValues)) {
		widget.__gjjSearchSourceValues = Array.isArray(widget.options?.values) ? [...widget.options.values] : [];
	}
	if (!widget.__gjjSearchSourceValues.length) {
		return false;
	}
	const picker = ensureSearchPicker();
	picker.open(
		{
			x: Number.isFinite(event?.clientX) ? event.clientX : 24,
			y: Number.isFinite(event?.clientY) ? event.clientY : 24,
		},
		widget,
		(value) => {
			widget.value = value;
			widget.callback?.(value);
			setDirty(node);
		},
	);
	return true;
}

function enhanceSearchableCombo(node, widgetName) {
	const widget = getWidget(node, widgetName);
	if (!widget) {
		return;
	}
	getWidgetOptionValues(widget);
	if (!Array.isArray(widget.__gjjSearchSourceValues)) {
		widget.__gjjSearchSourceValues = Array.isArray(widget.options?.values) ? [...widget.options.values] : [];
	}
	if (widget.__gjjSearchHooked) {
		return;
	}
	widget.__gjjSearchHooked = true;
	if (widget.inputEl) {
		widget.inputEl.readOnly = true;
		widget.inputEl.spellcheck = false;
		widget.inputEl.autocomplete = "off";
		widget.inputEl.title = "点击打开 🔍 搜索面板";
		const openPicker = (event) => {
			event.preventDefault();
			event.stopPropagation();
			openSearchablePicker(node, widget, event);
		};
		widget.inputEl.addEventListener("mousedown", openPicker);
		widget.inputEl.addEventListener("click", openPicker);
		widget.inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
				openPicker(event);
			}
		});
	}
}

function updateClipWidgetVisibility(node, clipCount) {
	const clipWidget = getWidget(node, "clip_name1");
	if (!clipWidget) {
		return;
	}
	const preset = matchPreset(getWidget(node, "unet_name")?.value || "");
	const isFluxOptional = Boolean(
		preset
		&& preset.clipType === "flux"
		&& Array.isArray(preset.clipNames)
		&& preset.clipNames[0] === "clip_l.safetensors"
	);
	if (!isFluxOptional) {
		setWidgetOptionValues(clipWidget, getWidgetOptionValues(clipWidget));
		showWidget(clipWidget);
		return;
	}

	const options = getFluxOptionalClipCandidates(clipWidget, preset);
	if (!options.length) {
		setWidgetOptionValues(clipWidget, getWidgetOptionValues(clipWidget));
		showWidget(clipWidget);
		return;
	}
	setWidgetOptionValues(clipWidget, options);
	if (!options.includes(String(clipWidget.value || ""))) {
		clipWidget.value = options[0];
	}
	showWidget(clipWidget);
}

function hasOptionValue(widget, value) {
	if (!widget || !value) {
		return false;
	}
	const options = Array.isArray(widget.__gjjSearchSourceValues)
		? widget.__gjjSearchSourceValues
		: (Array.isArray(widget.options?.values) ? widget.options.values : []);
	return options.includes(value);
}

function setWidgetValueOrClear(widget, value) {
	if (!widget) {
		return;
	}
	if (value === undefined || value === null || value === "") {
		setWidgetSyntheticPresetValue(widget, "");
		widget.value = "";
		widget.callback?.("");
		return;
	}
	setWidgetValue(widget, value);
}

function usesEqualReferenceCanvas(preset, unetName = "") {
	const text = SearchUtils.canonicalizeText([
		preset?.id || "",
		...(preset?.keywords || []),
		unetName || "",
	].join("|"));
	return text.includes("qwenimageedit2511") || text.includes("fireredimageedit11");
}

function updateMainImageIndexVisibility(node, preset = null) {
	const widget = getWidget(node, "main_image_index");
	if (!widget) {
		return;
	}
	const equalReference = usesEqualReferenceCanvas(preset, getWidget(node, "unet_name")?.value || "");
	setWidgetEnabled(widget, !equalReference);
	widget.tooltip = equalReference
		? "当前 Qwen Image Edit 2511 / FireRed Image Edit 1.1 分支使用平等参考：所有图片统一到最大图画布，主图序号不参与。"
		: "有多张参考图时，哪一张作为主参考排在最前；部分旧多图编辑分支会使用该序号。";
}

function updateLoraWidgetVisibility(node, preset = null) {
	const rows = [
		{ name: "lora_1_name", strength: "lora_1_strength", presetValue: preset?.lora1 || "" },
		{ name: "lora_2_name", strength: "lora_2_strength", presetValue: preset?.lora2 || "" },
	];
	for (const row of rows) {
		const nameWidget = getWidget(node, row.name);
		const strengthWidget = getWidget(node, row.strength);
		showWidget(nameWidget);
		showWidget(strengthWidget);
	}
}

function isLoraEnabled(name, strength) {
	return Boolean(String(name || "").trim()) && Math.abs(Number(strength || 0)) > 1e-6;
}

function resolveLoraSuggestedSteps(loraName) {
	const text = String(loraName || "").toLowerCase();
	if (text.includes("flux_2-turbo-lora_comfyui_8steps_v2")) {
		return 8;
	}
	if (text.includes("flux2turbocomfyv2")) {
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

function syncStepsFromCurrentLoras(node) {
	const stepsWidget = getWidget(node, "steps");
	if (!stepsWidget) {
		return;
	}
	const preset = matchPreset(getWidget(node, "unet_name")?.value || "");
	const lora1Name = getWidget(node, "lora_1_name")?.value || "";
	const lora2Name = getWidget(node, "lora_2_name")?.value || "";
	const lora1Strength = getWidget(node, "lora_1_strength")?.value || 0;
	const lora2Strength = getWidget(node, "lora_2_strength")?.value || 0;

	if (isLoraEnabled(lora1Name, lora1Strength)) {
		const suggested = resolveLoraSuggestedSteps(lora1Name);
		if (Number.isFinite(suggested)) {
			setWidgetValue(stepsWidget, suggested);
			return;
		}
	}

	if (isLoraEnabled(lora2Name, lora2Strength)) {
		const suggested = resolveLoraSuggestedSteps(lora2Name);
		if (Number.isFinite(suggested)) {
			setWidgetValue(stepsWidget, suggested);
			return;
		}
	}

	if (preset && Number.isFinite(preset.baseSteps)) {
		setWidgetValue(stepsWidget, preset.baseSteps);
	}
}

function applyPreset(node, force = false) {
	const unetWidget = getWidget(node, "unet_name");
	if (!unetWidget) {
		return;
	}
	const preset = matchPreset(unetWidget.value);
	if (!preset) {
		setWidgetValueOrClear(getWidget(node, "lora_1_name"), "");
		setWidgetValueOrClear(getWidget(node, "lora_2_name"), "");
		updateClipWidgetVisibility(node, 1);
		updateLoraWidgetVisibility(node, null);
		updateMainImageIndexVisibility(node, null);
		return;
	}
	updateClipWidgetVisibility(node, (preset.clipNames || []).length || 1);
	updateLoraWidgetVisibility(node, preset);
	updateMainImageIndexVisibility(node, preset);
	if (!force && node.__gjjPresetInitialized) {
		setDirty(node);
		return;
	}
	const clipWidget = getWidget(node, "clip_name1");
	const isFluxOptional = Boolean(
		preset.clipType === "flux"
		&& Array.isArray(preset.clipNames)
		&& preset.clipNames[0] === "clip_l.safetensors"
	);
	if (isFluxOptional) {
		const options = getFluxOptionalClipCandidates(clipWidget, preset);
		if (options.length) {
			setWidgetValueOrClear(clipWidget, preset.clipNames?.[1] || options[0]);
		}
	} else {
		setWidgetValueOrClear(clipWidget, preset.clipNames?.[0] || "");
	}
	setWidgetValueOrClear(getWidget(node, "vae_name"), preset.vaeName);
	setWidgetValueOrClear(getWidget(node, "lora_1_name"), preset.lora1);
	setWidgetValue(getWidget(node, "lora_1_strength"), preset.lora1Strength);
	setWidgetValueOrClear(getWidget(node, "lora_2_name"), preset.lora2);
	setWidgetValue(getWidget(node, "lora_2_strength"), preset.lora2Strength);
	setWidgetValue(getWidget(node, "steps"), preset.steps);
	setWidgetValue(getWidget(node, "cfg"), preset.cfg);
	setWidgetValue(getWidget(node, "sampler_name"), preset.sampler);
	setWidgetValue(getWidget(node, "scheduler"), preset.scheduler);
	setWidgetValue(getWidget(node, "denoise"), preset.denoise);
	setWidgetValue(getWidget(node, "width"), preset.width);
	setWidgetValue(getWidget(node, "height"), preset.height);
	node.__gjjPresetInitialized = true;
	updateLoraWidgetVisibility(node, preset);
	updateMainImageIndexVisibility(node, preset);
	syncStepsFromCurrentLoras(node);
	setDirty(node);
}

function enhanceUnetWidget(node) {
	const widget = getWidget(node, "unet_name");
	if (!widget || widget.__gjjPresetHooked) {
		return;
	}
	widget.__gjjPresetHooked = true;
	const originalCallback = widget.callback;
	widget.callback = function (value, ...args) {
		const result = originalCallback?.call(this, value, ...args);
		applyPreset(node, true);
		return result;
	};
}

function enhanceLoraWidgets(node) {
	for (const name of ["lora_1_name", "lora_2_name"]) {
		const widget = getWidget(node, name);
		if (!widget || widget.__gjjLoraStepsHooked) {
			continue;
		}
		widget.__gjjLoraStepsHooked = true;
		const originalCallback = widget.callback;
		widget.callback = function (value, ...args) {
			const result = originalCallback?.call(this, value, ...args);
			syncStepsFromCurrentLoras(node);
			return result;
		};
	}
	for (const name of ["lora_1_strength", "lora_2_strength"]) {
		const widget = getWidget(node, name);
		if (!widget || widget.__gjjLoraStrengthHooked) {
			continue;
		}
		widget.__gjjLoraStrengthHooked = true;
		const originalCallback = widget.callback;
		widget.callback = function (value, ...args) {
			const result = originalCallback?.call(this, value, ...args);
			syncStepsFromCurrentLoras(node);
			return result;
		};
	}
}

function enhanceSearchableCombos(node) {
	["unet_name", "clip_name1", "vae_name", "lora_1_name", "lora_2_name"].forEach((name) => {
		enhanceSearchableCombo(node, name);
	});
}

function stabilizeNode(node, { forcePreset = false } = {}) {
	if (!node) {
		return;
	}
	ensureStatusWidget(node);
	removeUnusedImagesFromEnd(node, MIN_VISIBLE_IMAGES);
	ensureTrailingEmptyImage(node);
	renameImages(node);
	enhanceUnetWidget(node);
	enhanceLoraWidgets(node);
	enhanceSearchableCombos(node);
	applyPreset(node, forcePreset);
	setDirty(node);
}

function scheduleStabilize(node, ms = 32, forcePreset = false) {
	clearTimeout(node.__gjjImageStudioTimer);
	node.__gjjImageStudioTimer = setTimeout(() => stabilizeNode(node, { forcePreset }), ms);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setStatus(targetNode, detail.text || "处理中...");
});

globalThis.GJJLazyImageStudioSyncBatchSources = function (sourceNode) {
	if (!sourceNode) {
		return;
	}
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			continue;
		}
		const info = getPrimaryImageLinkInfo(node);
		if (!info || info.sourceNode?.id !== sourceNode.id || info.sourceSlotIndex !== 0) {
			continue;
		}
		syncPrimaryBatchSource(node);
	}
};

app.registerExtension({
	name: "Comfy.GJJ.LazyImageStudio",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			ensureStatusWidget(this);
			setStatus(this, "等待执行");
			setTimeout(() => {
				cleanupRedundantMultiLoaderLinks(this);
				syncPrimaryBatchSource(this);
				void trySyncPrimaryImageSize(this);
			}, 0);
			setTimeout(() => stabilizeNode(this, { forcePreset: true }), 0);
			void ensureModelPresetsLoaded().then(() => scheduleStabilize(this, 0, true));
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			ensureStatusWidget(this);
			if (!this.__gjjLazyImageStatus?.widget?.value) {
				setStatus(this, "等待执行");
			}
			setTimeout(() => {
				cleanupRedundantMultiLoaderLinks(this);
				syncPrimaryBatchSource(this);
				void trySyncPrimaryImageSize(this);
			}, 0);
			setTimeout(() => stabilizeNode(this, { forcePreset: false }), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => {
				cleanupRedundantMultiLoaderLinks(this);
				syncPrimaryBatchSource(this);
				void trySyncPrimaryImageSize(this);
			}, 0);
			scheduleStabilize(this);
			return result;
		};

		const originalOnMouseDown = nodeType.prototype.onMouseDown;
		nodeType.prototype.onMouseDown = function (event, localPos, canvas) {
			const widget = getSearchableWidgetAt(this, localPos);
			if (widget && openSearchablePicker(this, widget, event)) {
				this.__gjjSwallowSearchMouseUp = true;
				event?.preventDefault?.();
				event?.stopPropagation?.();
				return true;
			}
			return originalOnMouseDown?.apply(this, arguments);
		};

		const originalOnMouseUp = nodeType.prototype.onMouseUp;
		nodeType.prototype.onMouseUp = function (event, localPos, canvas) {
			if (this.__gjjSwallowSearchMouseUp) {
				this.__gjjSwallowSearchMouseUp = false;
				event?.preventDefault?.();
				event?.stopPropagation?.();
				return true;
			}
			return originalOnMouseUp?.apply(this, arguments);
		};
	},

	setup() {
		void ensureModelPresetsLoaded().then(() => refreshPresetDrivenNodes());
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				ensureStatusWidget(node);
				setStatus(node, node.__gjjLazyImageStatus?.widget?.value || "等待执行");
				stabilizeNode(node, { forcePreset: false });
			}
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_MultiImageLoader"]);
const DATA_WIDGET_NAME = "selected_images";
const GJJ_HELP_WIDGET_NAME = "gjj_help_button";
const SEQUENCE_RANGE_WIDGET_NAME = "sequence_range";
const MAX_OUTPUT_IMAGES = 20;
const MIN_WIDTH = 420;
const MIN_HEIGHT = 220;
const DOM_WIDGET_NAME = "gjj_multi_image_loader_dom";
const IMAGE_API_PATH = "/gjj/input_images";
const THUMB_API_PATH = "/gjj/input_image_thumb";
const UPLOAD_SUBFOLDER = "gjj_multi_image_loader";
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const FILE_NAME_COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
const DEFAULT_THUMB_SIZE = 132;
const MIN_THUMB_SIZE = 72;
const MAX_THUMB_SIZE = 220;
const THUMB_STEP = 16;
const MAX_PREVIEW_HEIGHT = 560;
const RANGE_PLACEHOLDER = "例如：[1,3,5] 或 [1:8]";
const SLIDE_START_INPUT_NAME = "slide_start_index";
const SLIDE_START_INPUT_LABEL = "滑动起始序号";
const SLIDE_QUEUE_DELAY_MS = 180;

let activeSlideRun = null;
let slideQueueTimer = null;
let lastPromptId = null;

function getDataWidget(node) {
	return node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
}

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function hideDataWidget(widget) {
	if (!widget) {
		return;
	}
	widget.serialize = false;
	if (widget.__gjjHidden) {
		widget.computeSize = () => [0, 0];
		widget.draw = () => {};
		if (widget.inputEl) {
			widget.inputEl.style.display = "none";
		}
		if (widget.element) {
			widget.element.style.display = "none";
		}
		if (widget.widget) {
			widget.widget.style.display = "none";
		}
		return;
	}
	widget.__gjjHidden = true;
	widget.__gjjOriginalType = widget.type;
	widget.__gjjOriginalComputeSize = widget.computeSize;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.hidden = true;
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
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

function detachWidgetByName(node, name) {
	if (!Array.isArray(node?.widgets)) {
		return null;
	}
	const index = node.widgets.findIndex((widget) => widget?.name === name);
	if (index < 0) {
		return null;
	}
	const [widget] = node.widgets.splice(index, 1);
	hideDataWidget(widget);
	return widget;
}

function removeInternalDataWidget(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	// 这里不只是隐藏，而是从 widgets 布局数组中移除，避免前台 JSON/序列范围 widget 继续挤出空行。
	node.__gjjSelectedImagesWidget = node.__gjjSelectedImagesWidget || detachWidgetByName(node, DATA_WIDGET_NAME);
	node.__gjjSequenceRangeWidget = node.__gjjSequenceRangeWidget || detachWidgetByName(node, SEQUENCE_RANGE_WIDGET_NAME);
}

function removeInternalDataInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const label = String(input?.label || input?.localized_name || "");
		if (name !== DATA_WIDGET_NAME && label !== "已选图片") {
			continue;
		}
		if (input?.link != null) {
			node.disconnectInput?.(index);
		}
		node.removeInput?.(index);
	}
}

function normalizeSequenceRangeWidget(node) {
	const widget = getWidget(node, SEQUENCE_RANGE_WIDGET_NAME) || node.__gjjSequenceRangeWidget;
	if (widget) {
		hideDataWidget(widget);
	}
	return null;
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const ordered = [];
	const used = new Set();
	const pushWidget = (widget) => {
		if (!widget || used.has(widget)) {
			return;
		}
		ordered.push(widget);
		used.add(widget);
	};
	pushWidget(getWidget(node, GJJ_HELP_WIDGET_NAME));
	normalizeSequenceRangeWidget(node);
	pushWidget(node.__gjjMultiImageWidget);
	for (const widget of node.widgets) {
		pushWidget(widget);
	}
	node.widgets.splice(0, node.widgets.length, ...ordered);
}

function requestRedraw(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function markGraphChanged(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
}

function serializeSelection(selection) {
	return JSON.stringify(
		(selection || []).map((item) => ({
			filename: String(item?.filename || ""),
			subfolder: String(item?.subfolder || ""),
		})),
	);
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		return [];
	}
}

function serializedSelectionFromNode(node, serializedNode = null) {
	const propertyValue = String(node?.properties?.[DATA_WIDGET_NAME] || "");
	const widgetValue = String(getDataWidget(node)?.value || "");
	if (parseSelection(propertyValue).length > 0) {
		return propertyValue;
	}
	if (parseSelection(widgetValue).length > 0) {
		return widgetValue;
	}
	const serializedValues = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	for (const value of serializedValues) {
		const text = String(value || "");
		if (parseSelection(text).length > 0) {
			return text;
		}
	}
	return propertyValue || widgetValue || "[]";
}

function imageDataToUrl(item, options = {}) {
	if (!item?.filename) {
		return "";
	}
	const type = String(item.type || "input");
	const subfolder = String(item.subfolder || "");
	const filename = String(item.filename || "");
	const size = Math.max(64, Math.min(512, Number(options.size || DEFAULT_THUMB_SIZE)));

	// 节点内缩略图优先走后端缩略图缓存，避免 88px 小图反复加载 2K/4K 原图。
	// 只有 input 目录图片使用缩略图接口；执行后的 temp/output 预览继续使用 ComfyUI 原生 /view。
	if (options.thumbnail && type === "input" && !item.image) {
		const version = item.mtime_ns || item.size_bytes || "";
		return api.apiURL(
			`${THUMB_API_PATH}?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}&size=${encodeURIComponent(size)}${version ? `&v=${encodeURIComponent(version)}` : ""}`,
		);
	}

	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	// 不再给节点内缩略图附加 randParam；randParam 会强制绕过浏览器缓存，是加载变慢的主要原因之一。
	const randParam = options.noRand ? "" : (typeof app.getRandParam === "function" ? app.getRandParam() : "");
	return api.apiURL(
		`/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}${previewFormat}${randParam}`,
	);
}

function ensureState(node) {
	node.properties = node.properties || {};
	node.__gjjMultiImageState = node.__gjjMultiImageState || {
		options: [],
		selection: parseSelection(serializedSelectionFromNode(node)),
		externalCount: 0,
		executedImages: [],
		mergedCount: 0,
		showIndividualOutputs: Boolean(node?.properties?.show_individual_outputs),
		slideOutputEnabled: Boolean(node?.properties?.slide_output_enabled),
		slideOutputIndex: Math.max(1, Number.parseInt(node?.properties?.slide_output_index || "1", 10) || 1),
		slideOutputSize: Math.max(1, Math.min(3, Number.parseInt(node?.properties?.slide_output_size || "2", 10) || 2)),
		thumbSize: Number(node?.properties?.thumb_size || DEFAULT_THUMB_SIZE),
		rangeExpanded: Boolean(node?.properties?.sequence_range_expanded),
		dragIndex: null,
	};
	return node.__gjjMultiImageState;
}

async function fetchOptions() {
	try {
		const response = await fetch(IMAGE_API_PATH);
		if (!response.ok) {
			return [];
		}
		const data = await response.json();
		return Array.isArray(data?.images) ? data.images : [];
	} catch (error) {
		return [];
	}
}

function enrichSelectionWithOptions(state) {
	if (!state || !Array.isArray(state.selection) || !Array.isArray(state.options) || state.options.length === 0) {
		return;
	}
	const metaByKey = new Map(state.options.map((item) => [itemKey(item), item]));
	for (const item of state.selection) {
		const meta = metaByKey.get(itemKey(item));
		if (!meta) {
			continue;
		}
		if (meta.width) item.width = meta.width;
		if (meta.height) item.height = meta.height;
		if (meta.mtime_ns) item.mtime_ns = meta.mtime_ns;
		if (meta.size_bytes) item.size_bytes = meta.size_bytes;
	}
}

async function uploadFiles(node, files) {
	const list = Array.from(files || [])
		.filter((file) => file instanceof File)
		.sort((a, b) => FILE_NAME_COLLATOR.compare(a.name || "", b.name || ""));
	if (!list.length) {
		return;
	}
	const state = ensureState(node);
	const uploaded = [];
	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.textContent = `正在导入 ${list.length} 张...`;
	}
	for (const file of list) {
		const formData = new FormData();
		formData.append("image", file, file.name);
		formData.append("type", "input");
		formData.append("subfolder", UPLOAD_SUBFOLDER);
		const response = await fetch(api.apiURL("/upload/image"), {
			method: "POST",
			body: formData,
		});
		if (!response.ok) {
			throw new Error(`上传失败：${file.name}`);
		}
		const payload = await response.json();
		uploaded.push({
			filename: payload?.name || file.name,
			subfolder: payload?.subfolder || UPLOAD_SUBFOLDER,
		});
	}
	await refreshOptions(node);
	for (const item of uploaded) {
		const alreadySelected = state.selection.some((selected) => selected.filename === item.filename && selected.subfolder === item.subfolder);
		// 移除20张限制，允许上传并选择任意数量的图片
		if (!alreadySelected) {
			state.selection.push(item);
		}
	}
	enrichSelectionWithOptions(state);
	syncDataWidget(node);
	ensureOutputs(node, totalImageCount(node));
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function syncDataWidget(node) {
	const state = ensureState(node);
	const serialized = serializeSelection(state.selection);
	node.properties = node.properties || {};
	node.properties[DATA_WIDGET_NAME] = serialized;
	const widget = getDataWidget(node) || node.__gjjSelectedImagesWidget;
	if (widget) {
		widget.value = serialized;
		widget.callback?.(serialized, app.canvas, node, undefined, widget);
	}
	globalThis.GJJLazyImageStudioSyncBatchSources?.(node);
	markGraphChanged(node);
}

function getSequenceRange(node) {
	return String(node?.properties?.[SEQUENCE_RANGE_WIDGET_NAME] ?? (getWidget(node, SEQUENCE_RANGE_WIDGET_NAME) || node.__gjjSequenceRangeWidget)?.value ?? "");
}

function syncSequenceRange(node, value) {
	node.properties = node.properties || {};
	node.properties[SEQUENCE_RANGE_WIDGET_NAME] = String(value || "");
	const widget = getWidget(node, SEQUENCE_RANGE_WIDGET_NAME) || node.__gjjSequenceRangeWidget;
	if (widget) {
		widget.value = String(value || "");
		widget.callback?.(widget.value, app.canvas, node, undefined, widget);
	}
	markGraphChanged(node);
}

function formatSlidingRange(index, count, size = 2) {
	const total = Math.max(0, Number(count || 0));
	if (total <= 0) {
		return "";
	}
	const first = ((Math.max(1, Number(index || 1)) - 1) % total) + 1;
	const span = Math.max(1, Math.min(3, Number(size || 1)));
	const values = [];
	for (let offset = 0; offset < span; offset++) {
		values.push(((first - 1 + offset) % total) + 1);
	}
	return `[${values.join(",")}]`;
}

function applySlidingRange(node) {
	const state = ensureState(node);
	const count = slidingSourceCount(node);
	if (!state.slideOutputEnabled || count <= 0) {
		return;
	}
	state.slideOutputIndex = ((Math.max(1, Number(state.slideOutputIndex || 1)) - 1) % count) + 1;
	node.properties = node.properties || {};
	node.properties.slide_output_enabled = true;
	node.properties.slide_output_index = state.slideOutputIndex;
	node.properties.slide_output_size = state.slideOutputSize;
	const nextRange = formatSlidingRange(state.slideOutputIndex, count, state.slideOutputSize);
	node.properties[SEQUENCE_RANGE_WIDGET_NAME] = nextRange;
	if (getSequenceRange(node) !== nextRange) {
		syncSequenceRange(node, nextRange);
	}
	if (node.__gjjMultiImageRangeInput) {
		node.__gjjMultiImageRangeInput.value = getSequenceRange(node);
	}
	updateSummary(node);
}

function advanceSlidingRange(node) {
	const state = ensureState(node);
	if (!state.slideOutputEnabled) {
		return;
	}
	if (hasSlideStartIndexLink(node)) {
		updateSlideOutputButtonsState(node);
		return;
	}
	const count = slidingSourceCount(node);
	if (count <= 0) {
		return;
	}
	state.slideOutputIndex = (Math.max(1, Number(state.slideOutputIndex || 1)) % count) + 1;
	node.properties = node.properties || {};
	node.properties.slide_output_index = state.slideOutputIndex;
	applySlidingRange(node);
	updateSlideOutputButtonsState(node);
	queueSlidingOutput(node, "continue");
}

function hasSlideStartIndexLink(node) {
	return Boolean((node.inputs || []).find((input) => input?.name === SLIDE_START_INPUT_NAME && input.link != null));
}

function ensureSlideStartInput(node) {
	let input = (node.inputs || []).find((item) => item?.name === SLIDE_START_INPUT_NAME);
	if (!input) {
		node.addInput?.(SLIDE_START_INPUT_NAME, "INT");
		input = (node.inputs || []).find((item) => item?.name === SLIDE_START_INPUT_NAME);
	}
	if (input) {
		input.name = SLIDE_START_INPUT_NAME;
		input.label = SLIDE_START_INPUT_LABEL;
		input.localized_name = SLIDE_START_INPUT_LABEL;
		input.type = "INT";
		input.tooltip = "可选：接入整数后，按 x mod 图片总数决定滑动输出起始序号。";
	}
	return input;
}

function removeSlideStartInputIfUnused(node) {
	const index = (node.inputs || []).findIndex((input) => input?.name === SLIDE_START_INPUT_NAME);
	if (index < 0) return;
	if (node.inputs[index]?.link != null) return;
	node.removeInput?.(index);
}

function syncSlideStartInput(node) {
	const state = ensureState(node);
	if (state.extraToolsExpanded) ensureSlideStartInput(node);
	else removeSlideStartInputIfUnused(node);
}

function resetSlidingRange(node) {
	const state = ensureState(node);
	state.slideOutputIndex = 1;
	node.properties = node.properties || {};
	node.properties.slide_output_index = 1;
	applySlidingRange(node);
	updateSlideOutputButtonsState(node);
	updateSummary(node);
}

function queueSlidingOutput(node, reason = "start") {
	const state = ensureState(node);
	if (!state.slideOutputEnabled || state.__slideQueuePending) {
		return;
	}
	if (typeof app.queuePrompt !== "function") {
		console.warn("[GJJ] app.queuePrompt 不存在，无法自动执行滑动输出。");
		return;
	}
	state.__slideQueuePending = true;
	activeSlideRun = { node, reason };
	clearTimeout(slideQueueTimer);
	slideQueueTimer = setTimeout(async () => {
		slideQueueTimer = null;
		state.__slideQueuePending = false;
		if (!ensureState(node).slideOutputEnabled) {
			return;
		}
		try {
			activeSlideRun = { node, reason };
			await app.queuePrompt(0);
		} catch (error) {
			ensureState(node).slideOutputEnabled = false;
			node.properties = node.properties || {};
			node.properties.slide_output_enabled = false;
			updateSlideOutputButtonsState(node);
			activeSlideRun = null;
			console.warn("[GJJ] 滑动输出自动执行失败：", error);
		}
	}, SLIDE_QUEUE_DELAY_MS);
}

function stopSlidingOutput(node) {
	const state = ensureState(node);
	state.slideOutputEnabled = false;
	state.__slideQueuePending = false;
	node.properties = node.properties || {};
	node.properties.slide_output_enabled = false;
	clearTimeout(slideQueueTimer);
	slideQueueTimer = null;
	if (activeSlideRun?.node === node) activeSlideRun = null;
	updateSlideOutputButtonsState(node);
	updateSummary(node);
	requestRedraw(node);
}

function totalImageCount(node) {
	const state = ensureState(node);
	return Math.max(0, Number(state.mergedCount || 0) || (Number(state.selection?.length || 0) + Number(state.externalCount || 0)));
}

function slidingSourceCount(node) {
	const state = ensureState(node);
	const selectedCount = Number(state.selection?.length || 0);
	const externalCount = Number(state.externalCount || 0);
	const sourceCount = selectedCount + externalCount;
	if (sourceCount > 0) {
		return sourceCount;
	}
	return Math.max(0, Number(state.mergedCount || 0));
}

function updateOutputButtonState(node) {
	const state = ensureState(node);
	const button = node.__gjjMultiImageOutputButton;
	if (!button) {
		return;
	}
	const count = totalImageCount(node);
	button.textContent = "🔌";
	button.title = state.showIndividualOutputs
		? `当前已展开 ${Math.min(count, MAX_OUTPUT_IMAGES)} 个单图输出口。点击后收起未连接的单图输出口。`
		: `单图片输出口默认隐藏。点击后按当前图片数量展开，最多 ${MAX_OUTPUT_IMAGES} 个。`;
	button.style.background = state.showIndividualOutputs ? "#2b4250" : "#1a2328";
	button.style.borderColor = state.showIndividualOutputs ? "#5ca6d6" : "#465761";
	button.style.boxShadow = state.showIndividualOutputs ? "0 0 0 1px rgba(92,166,214,.3) inset" : "none";
	button.__gjjStyleRefresh = () => {
		button.style.background = state.showIndividualOutputs ? "#2b4250" : "#1a2328";
		button.style.borderColor = state.showIndividualOutputs ? "#5ca6d6" : "#465761";
		button.style.boxShadow = state.showIndividualOutputs ? "0 0 0 1px rgba(92,166,214,.3) inset" : "none";
	};
	button.style.opacity = count > 0 ? "1" : "0.55";
}

function updateSlideOutputButtonsState(node) {
	const state = ensureState(node);
	const count = slidingSourceCount(node);
	const buttons = node.__gjjMultiImageSlideButtons || {};
	for (const [sizeText, button] of Object.entries(buttons)) {
		if (!button) continue;
		const size = Number(sizeText);
		const active = state.slideOutputEnabled && Number(state.slideOutputSize || 1) === size;
		const rangeText = active ? formatSlidingRange(state.slideOutputIndex, count, size) : "";
		button.textContent = active ? ["１", "２", "３"][size - 1] : ["1️⃣", "2️⃣", "3️⃣"][size - 1];
		button.style.background = active ? "#1f6f55" : "#1a2328";
		button.style.borderColor = active ? "#33c48d" : "#465761";
		button.style.boxShadow = active ? "0 0 0 1px rgba(51,196,141,.55) inset, 0 0 10px rgba(51,196,141,.32)" : "none";
		button.__gjjStyleRefresh = () => {
			button.style.background = active ? "#1f6f55" : "#1a2328";
			button.style.borderColor = active ? "#33c48d" : "#465761";
			button.style.boxShadow = active ? "0 0 0 1px rgba(51,196,141,.55) inset, 0 0 10px rgba(51,196,141,.32)" : "none";
		};
		button.style.opacity = count > 0 ? "1" : "0.55";
		button.title = active
			? `滑动输出 ${size} 张已开启：当前 ${rangeText || "等待图片"}。再次点击停止。`
			: `滑动输出 ${size} 张：点击后自动执行并循环推进。`;
	}
	const initButton = node.__gjjMultiImageSlideInitButton;
	if (initButton) {
		initButton.style.opacity = count > 0 ? "1" : "0.55";
		initButton.title = "初始化滑动输出：重置为从第 1 张开始。";
	}
	if (node.__gjjMultiImageRangeInput) {
		node.__gjjMultiImageRangeInput.value = getSequenceRange(node);
	}
}

function hasExternalImageLink(node) {
	return Array.isArray(node?.inputs) && node.inputs.some((input) => input?.name === "input_images" && !!input?.link);
}

function ensureOutputs(node, count) {
	const state = ensureState(node);
	const imageCount = Math.max(0, Number(count || 0));
	const individualCount = state.showIndividualOutputs ? Math.min(imageCount, MAX_OUTPUT_IMAGES) : 0;
	const visibleCount = 1 + individualCount;

	while ((node.outputs?.length || 0) < visibleCount) {
		const outputIndex = node.outputs?.length || 0;
		if (outputIndex === 0) {
			node.addOutput?.("批量图片队列", BATCH_IMAGE_TYPE);
			continue;
		}
		node.addOutput?.(`图片 ${outputIndex}`, "IMAGE");
	}
	while ((node.outputs?.length || 0) > visibleCount) {
		const lastIndex = node.outputs.length - 1;
		const output = node.outputs[lastIndex];
		if (lastIndex === 0) {
			break;
		}
		if (Array.isArray(output?.links) && output.links.length > 0) {
			break;
		}
		node.removeOutput?.(lastIndex);
	}
	(node.outputs || []).forEach((output, index) => {
		if (index === 0) {
			output.name = "批量图片队列";
			output.label = output.name;
			output.localized_name = output.name;
			output.type = BATCH_IMAGE_TYPE;
			output.tooltip = imageCount > MAX_OUTPUT_IMAGES
				? `已选择 ${imageCount} 张图片，单图输出最多展开 ${MAX_OUTPUT_IMAGES} 个；批量队列不限制。`
				: "将所有已选图片按顺序打包成一个 GJJ 专用批量图片队列输出。";
			return;
		}
		output.name = `图片 ${index}`;
		output.label = output.name;
		output.localized_name = output.name;
		output.type = "IMAGE";
		output.tooltip = `第 ${index} 张已选图片的单独输出。`;
	});
	node.properties = node.properties || {};
	node.properties.show_individual_outputs = Boolean(state.showIndividualOutputs);
	updateOutputButtonState(node);
	updateSlideOutputButtonsState(node);
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function isSelected(state, item) {
	return state.selection.some((selected) => selected.filename === item.filename && selected.subfolder === item.subfolder);
}

function toggleSelection(node, item) {
	const state = ensureState(node);
	const existingIndex = state.selection.findIndex((selected) => selected.filename === item.filename && selected.subfolder === item.subfolder);
	if (existingIndex >= 0) {
		state.selection.splice(existingIndex, 1);
	} else {
		// 移除20张限制，允许选择任意数量的图片
		state.selection.push(item);
	}
	syncDataWidget(node);
	ensureOutputs(node, totalImageCount(node));
	if (state.slideOutputEnabled) {
		applySlidingRange(node);
	}
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function renderBrowser(node) {
	return;
}

function itemKey(item) {
	return `${String(item?.subfolder || "")}\u0000${String(item?.filename || "")}`;
}

function moveSelectionItem(node, fromIndex, toIndex) {
	const state = ensureState(node);
	if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) {
		return;
	}
	if (fromIndex >= state.selection.length || toIndex >= state.selection.length) {
		return;
	}
	const [item] = state.selection.splice(fromIndex, 1);
	state.selection.splice(toIndex, 0, item);
	syncDataWidget(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function applyThumbnailSize(node) {
	const state = ensureState(node);
	const size = Math.max(MIN_THUMB_SIZE, Math.min(MAX_THUMB_SIZE, Number(state.thumbSize || DEFAULT_THUMB_SIZE)));
	state.thumbSize = size;
	node.properties = node.properties || {};
	node.properties.thumb_size = size;
	if (node.__gjjMultiImageGrid) {
		node.__gjjMultiImageGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
	}
	if (node.__gjjMultiImageThumbLabel) {
		node.__gjjMultiImageThumbLabel.textContent = `${size}px`;
		node.__gjjMultiImageThumbLabel.title = `当前缩略图尺寸：${size}px`;
	}
	if (node.__gjjMultiImageZoomOutButton) {
		node.__gjjMultiImageZoomOutButton.title = `缩小缩略图：当前 ${size}px`;
	}
	if (node.__gjjMultiImageZoomInButton) {
		node.__gjjMultiImageZoomInButton.title = `放大缩略图：当前 ${size}px`;
	}
}

function renderPreview(node) {
	const state = ensureState(node);
	const grid = node.__gjjMultiImageGrid;
	const empty = node.__gjjMultiImageEmpty;
	if (!grid || !empty) {
		return;
	}
	applyThumbnailSize(node);
	grid.replaceChildren();
	const executedItems = Array.isArray(state.executedImages) ? state.executedImages : [];
	const hasExternalPreview = Number(state.externalCount || 0) > 0 && executedItems.length > 0;
	const items = hasExternalPreview ? executedItems : (state.selection || []);
	empty.style.display = items.length > 0 ? "none" : "flex";

	const nodeRef = node;
	for (const [index, item] of items.entries()) {
		const card = document.createElement("div");
		card.className = "gjj-image-card";
		card.draggable = !hasExternalPreview;
		card.dataset.index = String(index);
		card.title = hasExternalPreview ? "外部输入预览不能在这里排序" : "拖拽可调整图片顺序";
		card.style.cssText = [
			"position:relative",
			"width:100%",
			"aspect-ratio:1/1",
			"overflow:hidden",
			"border-radius:7px",
			"cursor:grab",
			"transition:transform 0.15s ease, opacity 0.15s ease, outline 0.15s ease",
			"background:#111a20",
		].join(";");

		card.addEventListener("dragstart", (event) => {
			if (hasExternalPreview) {
				event.preventDefault();
				return;
			}
			state.dragIndex = index;
			card.style.opacity = "0.45";
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("text/plain", String(index));
		});
		card.addEventListener("dragend", () => {
			state.dragIndex = null;
			card.style.opacity = "1";
			card.style.outline = "none";
		});
		card.addEventListener("dragover", (event) => {
			if (hasExternalPreview || state.dragIndex == null) {
				return;
			}
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			card.style.outline = "2px solid rgba(100, 190, 255, 0.85)";
		});
		card.addEventListener("dragleave", () => {
			card.style.outline = "none";
		});
		card.addEventListener("drop", (event) => {
			if (hasExternalPreview) {
				return;
			}
			event.preventDefault();
			card.style.outline = "none";
			const fromIndex = Number(event.dataTransfer.getData("text/plain") || state.dragIndex);
			moveSelectionItem(nodeRef, fromIndex, index);
		});

		card.addEventListener("mouseenter", () => {
			card.style.transform = "scale(1.025)";
		});
		card.addEventListener("mouseleave", () => {
			card.style.transform = "scale(1)";
		});

		const image = document.createElement("img");
		image.decoding = "async";
		image.loading = index < 12 ? "eager" : "lazy";
		image.fetchPriority = index < 8 ? "high" : "low";
		image.src = imageDataToUrl(item, { thumbnail: true, size: Math.ceil(Number(state.thumbSize || DEFAULT_THUMB_SIZE) * Math.max(1, window.devicePixelRatio || 1)), noRand: true });
		image.draggable = false;
		image.className = "gjj-image-preview";
		image.style.cssText = [
			"width:100%",
			"height:100%",
			"object-fit:cover",
			"display:block",
			"user-select:none",
		].join(";");

		const indexBadge = document.createElement("div");
		indexBadge.textContent = index + 1;
		indexBadge.style.cssText = [
			"position:absolute",
			"top:6px",
			"left:6px",
			"min-width:24px",
			"height:24px",
			"padding:0 6px",
			"border-radius:12px",
			"background:rgba(0,0,0,0.52)",
			"backdrop-filter:blur(4px)",
			"color:#fff",
			"font-size:11px",
			"font-weight:bold",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"pointer-events:none",
			"z-index:2",
		].join(";");

		const sizeBadge = document.createElement("div");
		sizeBadge.style.cssText = [
			"position:absolute",
			"top:6px",
			"right:6px",
			"padding:2px 8px",
			"border-radius:4px",
			"background:rgba(0,0,0,0.52)",
			"backdrop-filter:blur(4px)",
			"color:#fff",
			"font-size:10px",
			"pointer-events:none",
			"z-index:2",
			"white-space:nowrap",
		].join(";");
		if (item.width && item.height) {
			sizeBadge.textContent = `${item.width}×${item.height}`;
		} else if (item.image) {
			sizeBadge.textContent = "外部输入";
		} else {
			sizeBadge.textContent = "加载中...";
			image.onload = () => {
				sizeBadge.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
				requestRedraw(nodeRef);
			};
		}
		image.onerror = () => {
			sizeBadge.textContent = "加载失败";
			item._error = true;
			card.style.opacity = "0.5";
			card.style.filter = "grayscale(0.8)";
			scheduleLayout(nodeRef);
		};

		const deleteBtn = document.createElement("button");
		deleteBtn.type = "button";
		deleteBtn.innerHTML = "×";
		deleteBtn.title = "从当前选择中移除这张图片";
		deleteBtn.style.cssText = [
			"position:absolute",
			"bottom:6px",
			"right:6px",
			"width:26px",
			"height:26px",
			"border-radius:50%",
			"border:none",
			"background:rgba(220,53,69,0.86)",
			"backdrop-filter:blur(4px)",
			"color:#fff",
			"font-size:18px",
			"font-weight:bold",
			"line-height:1",
			"cursor:pointer",
			"pointer-events:auto",
			"z-index:3",
			"display:flex",
			"align-items:center",
			"justify-content:center",
		].join(";");
		deleteBtn.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleSelection(nodeRef, item);
		});

		card.addEventListener("click", (event) => {
			if (event.target === deleteBtn || deleteBtn.contains(event.target)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const overlay = document.createElement("div");
			overlay.style.cssText = [
				"position:fixed",
				"inset:0",
				"background:rgba(0,0,0,0.9)",
				"backdrop-filter:blur(10px)",
				"z-index:10000",
				"display:flex",
				"align-items:center",
				"justify-content:center",
				"cursor:zoom-out",
			].join(";");
			const previewImg = document.createElement("img");
			previewImg.src = imageDataToUrl(item, { noRand: true });
			previewImg.style.cssText = [
				"max-width:90%",
				"max-height:90%",
				"object-fit:contain",
				"border-radius:8px",
				"box-shadow:0 0 40px rgba(0,0,0,0.5)",
				"transition:transform 0.1s ease",
			].join(";");
			let currentScale = 1;
			overlay.addEventListener("wheel", (e) => {
				e.preventDefault();
				e.stopPropagation();
				currentScale = Math.max(0.1, Math.min(10, currentScale + (e.deltaY > 0 ? -0.1 : 0.1)));
				previewImg.style.transform = `scale(${currentScale})`;
			});
			previewImg.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				currentScale = 1;
				previewImg.style.transform = "scale(1)";
			});
			const closeHint = document.createElement("div");
			closeHint.textContent = "滚轮缩放 · 双击重置 · 点击关闭";
			closeHint.style.cssText = "position:absolute;bottom:20px;left:50%;transform:translateX(-50%);color:#fff;font-size:13px;opacity:.65;pointer-events:none;white-space:nowrap";
			overlay.appendChild(previewImg);
			overlay.appendChild(closeHint);
			document.body.appendChild(overlay);
			overlay.addEventListener("click", () => overlay.remove());
		});

		card.appendChild(image);
		card.appendChild(indexBadge);
		card.appendChild(sizeBadge);
		card.appendChild(deleteBtn);
		grid.appendChild(card);
	}
	updatePreviewPanelHeight(node);
}

function updateSummary(node) {
	const state = ensureState(node);
	const selectedCount = Number(state.selection?.length || 0);
	const externalCount = Number(state.externalCount || 0);
	const mergedCount = Number(state.mergedCount || 0);
	const slideSourceCount = slidingSourceCount(node);
	const slideText = state.slideOutputEnabled ? ` · 滑动 ${formatSlidingRange(state.slideOutputIndex, slideSourceCount, state.slideOutputSize) || "等待图片"}` : "";
	if (node.__gjjMultiImageSummary) {
		if (externalCount > 0 || selectedCount > 0) {
			const parts = [];
			if (externalCount > 0) {
				parts.push(`外部 ${externalCount} 张`);
			}
			if (selectedCount > 0) {
				parts.push(`已选 ${selectedCount} 张`);
			}
			// 当超过20张时，显示实际总数，不再限制为MAX_OUTPUT_IMAGES
			const sourceTotal = externalCount + selectedCount;
			const total = sourceTotal > 0 ? sourceTotal : mergedCount;
			if (total > MAX_OUTPUT_IMAGES) {
				node.__gjjMultiImageSummary.textContent = `${parts.join(" + ")}，共 ${total} 张（批量队列输出）${slideText}`;
			} else {
				const outputText = ensureState(node).showIndividualOutputs ? "单图口已展开" : "单图口隐藏";
				node.__gjjMultiImageSummary.textContent = `${parts.join(" + ")}，共 ${total} / ${MAX_OUTPUT_IMAGES} 张 · ${outputText}${slideText}`;
			}
			return;
		}
		node.__gjjMultiImageSummary.textContent = "点击 📁 导入，或外部连接 GJJ 批量图片队列";
	}
}

function clearErrorImages(node) {
	const state = ensureState(node);
	const beforeCount = state.selection.length;
	state.selection = state.selection.filter((item) => !item._error);
	const removedCount = beforeCount - state.selection.length;
	if (removedCount > 0) {
		syncDataWidget(node);
		ensureOutputs(node, totalImageCount(node));
		renderPreview(node);
		updateSummary(node);
		scheduleLayout(node);
	}
}

function clearAllImages(node) {
	const state = ensureState(node);
	if (state.selection.length === 0) {
		return;
	}
	state.selection = [];
	syncDataWidget(node);
	ensureOutputs(node, totalImageCount(node));
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function getLayoutSignature(node) {
	const state = ensureState(node);
	const count = Math.max(0, (Number(state.externalCount || 0) > 0 && Array.isArray(state.executedImages)) ? state.executedImages.length : state.selection.length);
	const widthBucket = Math.round(Number(node.size?.[0] || MIN_WIDTH));
	const compact = widthBucket < 520 ? 1 : 0;
	const ultraCompact = widthBucket < 390 ? 1 : 0;
	const rangeExpanded = state.rangeExpanded ? 1 : 0;
	const extraExpanded = state.extraToolsExpanded ? 1 : 0;
	const outputs = state.showIndividualOutputs ? Math.min(totalImageCount(node), MAX_OUTPUT_IMAGES) : 0;
	const slide = `${state.slideOutputEnabled ? 1 : 0}:${state.slideOutputIndex || 1}:${state.slideOutputSize || 1}:${getSequenceRange(node)}`;
	return [count, Number(state.thumbSize || DEFAULT_THUMB_SIZE), widthBucket, compact, ultraCompact, rangeExpanded, extraExpanded, outputs, slide].join("|");
}

function computePreviewNaturalHeight(node) {
	const state = ensureState(node);
	const count = Math.max(1, (Number(state.externalCount || 0) > 0 && Array.isArray(state.executedImages)) ? state.executedImages.length : state.selection.length);
	const width = Math.max(220, Number(node.size?.[0] || MIN_WIDTH) - 28);
	const thumb = Math.max(MIN_THUMB_SIZE, Math.min(MAX_THUMB_SIZE, Number(state.thumbSize || DEFAULT_THUMB_SIZE)));
	const gap = 8;
	const cols = Math.max(1, Math.floor((width - 20 + gap) / (thumb + gap)));
	const rows = Math.max(1, Math.ceil(count / cols));
	return Math.min(MAX_PREVIEW_HEIGHT, Math.max(132, rows * thumb + Math.max(0, rows - 1) * gap + 22));
}

function measureHeight(node) {
	const container = node.__gjjMultiImageContainer;
	if (!container) {
		return MIN_HEIGHT;
	}
	updatePreviewPanelHeight(node);
	const contentHeight = Math.ceil(container.scrollHeight || container.offsetHeight || MIN_HEIGHT);
	return Math.max(MIN_HEIGHT, contentHeight + 10);
}

function updateLayout(node, force = false) {
	if (!node) {
		return;
	}
	const signature = getLayoutSignature(node);
	if (!force && node.__gjjMultiImageLayoutSignature === signature) {
		return;
	}
	node.__gjjMultiImageLayoutSignature = signature;
	updateSummary(node);
	const height = measureHeight(node);
	node.__gjjMultiImageCachedHeight = height;
	const currentHeight = Number(node.size?.[1] || MIN_HEIGHT);
	// 加 2px 容差，避免浏览器 scrollHeight / 小数取整导致节点反复抖动。
	if (Math.abs(height - currentHeight) > 2) {
		node.setSize?.([node.size?.[0], height]);
		requestRedraw(node);
	}
}

function scheduleLayout(node, force = false) {
	if (!node || node.__gjjMultiImageLayoutQueued) {
		return;
	}
	node.__gjjMultiImageLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjMultiImageLayoutQueued = false;
		updateLayout(node, force);
	});
}

async function refreshOptions(node) {
	const state = ensureState(node);
	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.textContent = "正在刷新图片列表...";
	}
	state.options = await fetchOptions();
	enrichSelectionWithOptions(state);
	syncDataWidget(node);
	ensureOutputs(node, totalImageCount(node));
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node, true);
	requestRedraw(node);
}

function makeIconButton(icon, tooltip) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = icon;
	button.title = tooltip;
	button.style.cssText = [
		"width:28px",
		"height:26px",
		"padding:0",
		"border:1px solid #465761",
		"border-radius:7px",
		"background:#1a2328",
		"color:#dce7e2",
		"font-size:14px",
		"line-height:1",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
	].join(";");
	button.addEventListener("mouseenter", () => {
		button.style.background = "#243039";
		button.style.borderColor = "#5f7b8d";
	});
	button.addEventListener("mouseleave", () => {
		if (typeof button.__gjjStyleRefresh === "function") {
			button.__gjjStyleRefresh();
			return;
		}
		button.style.background = "#1a2328";
		button.style.borderColor = "#465761";
	});
	return button;
}

function updateToolbarCompact(node) {
	const toolbar = node.__gjjMultiImageToolbar;
	if (!toolbar) {
		return;
	}
	const width = Number(node.size?.[0] || MIN_WIDTH);
	const extraTools = node.__gjjMultiImageExtraTools || [];
	const summary = node.__gjjMultiImageSummary;
	const thumbLabel = node.__gjjMultiImageThumbLabel;
	const moreButton = node.__gjjMultiImageMoreButton;
	const state = ensureState(node);
	const compact = width < 520;
	const ultraCompact = width < 390;
	const expanded = Boolean(state.extraToolsExpanded);
	const extraSet = new Set(extraTools);
	for (const child of Array.from(toolbar.children || [])) {
		if (extraSet.has(child)) child.style.order = "20";
	}
	for (const item of extraTools) {
		item.style.display = expanded ? "inline-flex" : "none";
	}
	if (thumbLabel) {
		thumbLabel.style.display = "none";
	}
	if (summary) {
		summary.style.display = ultraCompact ? "none" : "block";
		summary.style.flexBasis = compact ? "100%" : "80px";
		summary.style.order = compact ? "99" : "0";
	}
	if (moreButton) {
		moreButton.style.display = "inline-flex";
		moreButton.style.order = "30";
		moreButton.textContent = state.extraToolsExpanded ? "⏮️" : "⏯️";
		moreButton.title = state.extraToolsExpanded
			? "折叠更多工具。"
			: "展开更多工具。";
		moreButton.style.background = state.extraToolsExpanded ? "#2b4250" : "#1a2328";
		moreButton.style.borderColor = state.extraToolsExpanded ? "#5ca6d6" : "#465761";
		moreButton.__gjjStyleRefresh = () => {
			moreButton.style.background = state.extraToolsExpanded ? "#2b4250" : "#1a2328";
			moreButton.style.borderColor = state.extraToolsExpanded ? "#5ca6d6" : "#465761";
		};
	}
}

function updatePreviewPanelHeight(node) {
	const wrap = node.__gjjMultiImagePreviewWrap;
	if (!wrap) {
		return;
	}
	updateToolbarCompact(node);
	// 只按图片数量、缩略图尺寸和节点宽度计算自然高度；不再反向读取当前节点高度填满剩余空间，避免越算越高/抖动。
	const height = computePreviewNaturalHeight(node);
	if (wrap.__gjjLastPreviewHeight !== height) {
		wrap.__gjjLastPreviewHeight = height;
		wrap.style.height = `${height}px`;
		wrap.style.maxHeight = `${MAX_PREVIEW_HEIGHT}px`;
	}
}

function buildDom(node) {
	const state = ensureState(node);
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"height:auto",
		"min-height:unset",
		"box-sizing:border-box",
		"padding:2px 0 0 0",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = [
		"display:flex",
		"gap:5px",
		"row-gap:5px",
		"align-items:flex-start",
		"align-content:flex-start",
		"flex-wrap:wrap",
		"padding:0 2px",
		"box-sizing:border-box",
		"max-width:100%",
		"overflow:hidden",
	].join(";");

	const browseButton = makeIconButton("📁", "浏览图片：打开系统图片选择器，可用 Shift/Ctrl 一次选择多张图片。");
	const refreshButton = makeIconButton("🔄", "刷新：重新扫描 ComfyUI input 目录中的图片列表，并刷新当前预览。");
	const clearErrorButton = makeIconButton("🧹", "清理错误：移除当前列表里加载失败或损坏的图片。");
	const clearAllButton = makeIconButton("🗑️", "清空：清空所有已选图片，保留外部输入连接。");
	const rangeButton = makeIconButton("#️⃣", "序列范围：点击展开/收起设置栏。支持 [1,3,5] 和 [1:8]。");
	const outputButton = makeIconButton("🔌", `单图片输出口：默认隐藏。点击后按当前图片数量展开，最多 ${MAX_OUTPUT_IMAGES} 个。`);
	const slideButton1 = makeIconButton("1️⃣", "滑动输出 1 张：点击后自动执行并循环推进。");
	const slideButton2 = makeIconButton("2️⃣", "滑动输出 2 张：点击后自动执行并循环推进。");
	const slideButton3 = makeIconButton("3️⃣", "滑动输出 3 张：点击后自动执行并循环推进。");
	const slideInitButton = makeIconButton("🏁", "初始化滑动输出：重置为从第 1 张开始。");
	const zoomOutButton = makeIconButton("🔎−", "缩小缩略图：减少每张预览图尺寸，节点高度会自动重算。");
	const zoomInButton = makeIconButton("🔍+", "放大缩略图：增加每张预览图尺寸，节点高度会自动重算。");
	const moreButton = makeIconButton("⏯️", "展开更多工具。");
	zoomOutButton.style.width = "36px";
	zoomInButton.style.width = "36px";

	const thumbLabel = document.createElement("span");
	thumbLabel.style.cssText = "display:none;font-size:10px;color:#8ea0a8;min-width:34px;text-align:center;user-select:none";

	refreshButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshOptions(node);
	});
	clearErrorButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		clearErrorImages(node);
	});
	clearAllButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		clearAllImages(node);
	});
	rangeButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		state.rangeExpanded = !state.rangeExpanded;
		node.properties = node.properties || {};
		node.properties.sequence_range_expanded = state.rangeExpanded;
		if (node.__gjjMultiImageRangeRow) {
			node.__gjjMultiImageRangeRow.style.display = state.rangeExpanded ? "flex" : "none";
		}
		rangeButton.style.background = state.rangeExpanded ? "#2b4250" : "#1a2328";
		scheduleLayout(node);
	});
	outputButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		state.showIndividualOutputs = !state.showIndividualOutputs;
		node.properties = node.properties || {};
		node.properties.show_individual_outputs = state.showIndividualOutputs;
		ensureOutputs(node, totalImageCount(node));
		updateSummary(node);
		requestRedraw(node);
	});
	const toggleSlideMode = (size) => {
		const sameActive = state.slideOutputEnabled && Number(state.slideOutputSize || 1) === size;
		if (sameActive) {
			stopSlidingOutput(node);
			return;
		}
		state.slideOutputEnabled = true;
		state.slideOutputSize = size;
		node.properties = node.properties || {};
		node.properties.slide_output_enabled = state.slideOutputEnabled;
		node.properties.slide_output_size = size;
		if (state.slideOutputEnabled) {
			state.slideOutputIndex = Math.max(1, Number(state.slideOutputIndex || 1));
			state.rangeExpanded = true;
			node.properties.sequence_range_expanded = true;
			applySlidingRange(node);
			if (node.__gjjMultiImageRangeRow) {
				node.__gjjMultiImageRangeRow.style.display = "flex";
			}
			if (!hasSlideStartIndexLink(node)) {
				queueSlidingOutput(node, "start");
			}
		}
		updateSlideOutputButtonsState(node);
		updateSummary(node);
		scheduleLayout(node, true);
		requestRedraw(node);
	};
	for (const [button, size] of [[slideButton1, 1], [slideButton2, 2], [slideButton3, 3]]) {
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleSlideMode(size);
		});
	}
	slideInitButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		resetSlidingRange(node);
		scheduleLayout(node, true);
		requestRedraw(node);
	});
	zoomOutButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		state.thumbSize = Math.max(MIN_THUMB_SIZE, Number(state.thumbSize || DEFAULT_THUMB_SIZE) - THUMB_STEP);
		applyThumbnailSize(node);
		renderPreview(node);
		scheduleLayout(node);
	});
	zoomInButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		state.thumbSize = Math.min(MAX_THUMB_SIZE, Number(state.thumbSize || DEFAULT_THUMB_SIZE) + THUMB_STEP);
		applyThumbnailSize(node);
		renderPreview(node);
		scheduleLayout(node);
	});
	moreButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		state.extraToolsExpanded = !state.extraToolsExpanded;
		const extraTools = node.__gjjMultiImageExtraTools || [slideButton1, slideButton2, slideButton3, slideInitButton, clearErrorButton, clearAllButton, zoomOutButton, zoomInButton];
		for (const item of extraTools) {
			item.style.display = state.extraToolsExpanded ? "inline-flex" : "none";
		}
		if (thumbLabel) {
			thumbLabel.style.display = "none";
		}
		syncSlideStartInput(node);
		moreButton.textContent = state.extraToolsExpanded ? "⏮️" : "⏯️";
		moreButton.title = state.extraToolsExpanded
			? "折叠更多工具。"
			: "展开更多工具。";
		moreButton.style.background = state.extraToolsExpanded ? "#2b4250" : "#1a2328";
		moreButton.style.borderColor = state.extraToolsExpanded ? "#5ca6d6" : "#465761";
		moreButton.__gjjStyleRefresh = () => {
			moreButton.style.background = state.extraToolsExpanded ? "#2b4250" : "#1a2328";
			moreButton.style.borderColor = state.extraToolsExpanded ? "#5ca6d6" : "#465761";
		};
		scheduleLayout(node);
	});

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "image/*";
	fileInput.multiple = true;
	fileInput.style.display = "none";
	fileInput.addEventListener("click", (event) => event.stopPropagation());
	fileInput.addEventListener("change", async (event) => {
		event.stopPropagation();
		const files = Array.from(event.target?.files || []);
		fileInput.value = "";
		if (!files.length) {
			return;
		}
		try {
			await uploadFiles(node, files);
		} catch (error) {
			if (node.__gjjMultiImageSummary) {
				node.__gjjMultiImageSummary.textContent = error?.message || "导入图片失败";
			}
			requestRedraw(node);
		}
	});
	browseButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		fileInput.click();
	});

	const summary = document.createElement("div");
	summary.style.cssText = [
		"font-size:11px",
		"color:#dce7e2",
		"padding:2px 7px",
		"background:rgba(0,0,0,0.28)",
		"border-radius:5px",
		"flex:1 1 80px",
		"min-width:0",
		"overflow:hidden",
		"text-overflow:ellipsis",
		"white-space:nowrap",
	].join(";");

	toolbar.appendChild(browseButton);
	toolbar.appendChild(refreshButton);
	toolbar.appendChild(rangeButton);
	toolbar.appendChild(outputButton);
	toolbar.appendChild(slideButton1);
	toolbar.appendChild(slideButton2);
	toolbar.appendChild(slideButton3);
	toolbar.appendChild(slideInitButton);
	toolbar.appendChild(clearErrorButton);
	toolbar.appendChild(clearAllButton);
	toolbar.appendChild(zoomOutButton);
	toolbar.appendChild(thumbLabel);
	toolbar.appendChild(zoomInButton);
	toolbar.appendChild(moreButton);
	toolbar.appendChild(summary);

	const rangeRow = document.createElement("div");
	rangeRow.style.cssText = [
		"display:flex",
		"gap:6px",
		"align-items:center",
		"padding:0 2px",
	].join(";");
	rangeRow.style.display = state.rangeExpanded ? "flex" : "none";
	const rangeInput = document.createElement("input");
	rangeInput.type = "text";
	rangeInput.placeholder = RANGE_PLACEHOLDER;
	rangeInput.value = getSequenceRange(node);
	rangeInput.title = "序列范围：留空输出全部；[1,3,5] 输出指定序号；[1:8] 输出闭区间。";
	rangeInput.style.cssText = [
		"height:26px",
		"flex:1",
		"min-width:0",
		"box-sizing:border-box",
		"border:1px solid #465761",
		"border-radius:7px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:11px",
		"padding:0 8px",
		"outline:none",
	].join(";");
	rangeInput.addEventListener("pointerdown", (event) => event.stopPropagation());
	rangeInput.addEventListener("keydown", (event) => event.stopPropagation());
	rangeInput.addEventListener("input", () => {
		syncSequenceRange(node, rangeInput.value);
	});
	rangeRow.appendChild(rangeInput);

	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = [
		"position:relative",
		"border:1px solid #33434a",
		"border-radius:8px",
		"background:#0f1418",
		"padding:6px",
		"box-sizing:border-box",
		"overflow-y:auto",
		"overflow-x:hidden",
		"min-height:132px",
		"flex:1 1 auto",
		"scrollbar-width:thin",
	].join(";");

	const empty = document.createElement("div");
	empty.textContent = "点击 📁 导入图片，或连接外部 GJJ 批量图片队列";
	empty.style.cssText = [
		"position:absolute",
		"inset:0",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"padding:12px",
		"font-size:12px",
		"color:#8ea0a8",
		"text-align:center",
		"pointer-events:none",
	].join(";");

	const grid = document.createElement("div");
	grid.style.cssText = [
		"display:grid",
		`grid-template-columns:repeat(auto-fill, minmax(${state.thumbSize || DEFAULT_THUMB_SIZE}px, 1fr))`,
		"gap:8px",
		"padding:4px",
	].join(";");

	previewWrap.appendChild(grid);
	previewWrap.appendChild(empty);
	container.appendChild(toolbar);
	container.appendChild(rangeRow);
	container.appendChild(previewWrap);
	container.appendChild(fileInput);

	node.__gjjMultiImageContainer = container;
	node.__gjjMultiImageToolbar = toolbar;
	node.__gjjMultiImageExtraTools = [slideButton1, slideButton2, slideButton3, slideInitButton, clearErrorButton, clearAllButton, zoomOutButton, zoomInButton];
	node.__gjjMultiImageMoreButton = moreButton;
	node.__gjjMultiImageBrowseButton = browseButton;
	node.__gjjMultiImageOutputButton = outputButton;
	node.__gjjMultiImageSlideButtons = { 1: slideButton1, 2: slideButton2, 3: slideButton3 };
	node.__gjjMultiImageSlideInitButton = slideInitButton;
	node.__gjjMultiImageZoomOutButton = zoomOutButton;
	node.__gjjMultiImageZoomInButton = zoomInButton;
	node.__gjjMultiImageThumbLabel = thumbLabel;
	node.__gjjMultiImageRangeButton = rangeButton;
	node.__gjjMultiImageRangeRow = rangeRow;
	node.__gjjMultiImageRangeInput = rangeInput;
	node.__gjjMultiImageSummary = summary;
	node.__gjjMultiImagePreviewWrap = previewWrap;
	node.__gjjMultiImageGrid = grid;
	node.__gjjMultiImageEmpty = empty;
	applyThumbnailSize(node);
	updateOutputButtonState(node);
	updateToolbarCompact(node);
	return container;
}

function ensureDomWidget(node) {
	if (node.__gjjMultiImageWidget) {
		return node.__gjjMultiImageWidget;
	}
	const container = buildDom(node);
	const widget = node.addDOMWidget(DOM_WIDGET_NAME, "HTML", container, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => {
		const w = Math.max(MIN_WIDTH, Number(width || MIN_WIDTH));
		// computeSize 会被 ComfyUI 频繁调用，只返回缓存高度；真正重算由 scheduleLayout 控制。
		return [w, Math.max(MIN_HEIGHT, Number(node.__gjjMultiImageCachedHeight || measureHeight(node)))];
	};
	widget.draw = () => {};
	node.__gjjMultiImageWidget = widget;
	reorderWidgets(node);
	return widget;
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	removeInternalDataInputs(node);
	removeInternalDataWidget(node);
	ensureDomWidget(node);
	reorderWidgets(node);
	const state = ensureState(node);
	syncSlideStartInput(node);
	syncDataWidget(node);
	applySlidingRange(node);
	ensureOutputs(node, totalImageCount(node));
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function scheduleStabilize(node, ms = 32) {
	if (!node) {
		return;
	}
	clearTimeout(node.__gjjMultiImageStabilizeTimer);
	node.__gjjMultiImageStabilizeTimer = setTimeout(() => stabilizeNode(node), ms);
}

function eventPromptId(event) {
	return event?.detail?.prompt_id || null;
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !(promptId && lastPromptId && promptId !== lastPromptId);
}

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
	clearTimeout(slideQueueTimer);
	slideQueueTimer = null;
});

api.addEventListener("execution_success", (event) => {
	if (!samePrompt(event) || !activeSlideRun?.node) {
		activeSlideRun = null;
		return;
	}
	const node = activeSlideRun.node;
	activeSlideRun = null;
	if (ensureState(node).slideOutputEnabled) {
		advanceSlidingRange(node);
	}
});

api.addEventListener("execution_error", () => {
	clearTimeout(slideQueueTimer);
	slideQueueTimer = null;
	if (activeSlideRun?.node) {
		stopSlidingOutput(activeSlideRun.node);
	}
	activeSlideRun = null;
});

api.addEventListener("execution_interrupted", () => {
	clearTimeout(slideQueueTimer);
	slideQueueTimer = null;
	if (activeSlideRun?.node) {
		stopSlidingOutput(activeSlideRun.node);
	}
	activeSlideRun = null;
});

app.registerExtension({
	name: "Comfy.GJJ.MultiImageLoader",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			refreshOptions(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			const state = ensureState(this);
			state.selection = parseSelection(serializedSelectionFromNode(this, args[0]));
			state.showIndividualOutputs = Boolean(this.properties?.show_individual_outputs);
			state.slideOutputEnabled = Boolean(this.properties?.slide_output_enabled);
			state.slideOutputIndex = Math.max(1, Number.parseInt(this.properties?.slide_output_index || "1", 10) || 1);
			state.slideOutputSize = Math.max(1, Math.min(3, Number.parseInt(this.properties?.slide_output_size || "2", 10) || 2));
			state.thumbSize = Number(this.properties?.thumb_size || DEFAULT_THUMB_SIZE);
			state.rangeExpanded = Boolean(this.properties?.sequence_range_expanded);
			state.externalCount = 0;
			state.executedImages = [];
			state.mergedCount = state.selection.length;
			syncDataWidget(this);
			scheduleStabilize(this, 0);
			refreshOptions(this);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			syncDataWidget(this);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			const serialized = serializeSelection(ensureState(this).selection);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[DATA_WIDGET_NAME] = serialized;
				serializedNode.properties[SEQUENCE_RANGE_WIDGET_NAME] = getSequenceRange(this);
				serializedNode.properties.show_individual_outputs = Boolean(ensureState(this).showIndividualOutputs);
				serializedNode.properties.slide_output_enabled = Boolean(ensureState(this).slideOutputEnabled);
				serializedNode.properties.slide_output_index = Math.max(1, Number(ensureState(this).slideOutputIndex || 1));
				serializedNode.properties.slide_output_size = Math.max(1, Math.min(3, Number(ensureState(this).slideOutputSize || 1)));
				serializedNode.properties.thumb_size = Number(ensureState(this).thumbSize || DEFAULT_THUMB_SIZE);
				serializedNode.properties.sequence_range_expanded = Boolean(ensureState(this).rangeExpanded);
				if (Array.isArray(serializedNode.widgets_values) && Array.isArray(this.widgets)) {
					const widgetIndex = this.widgets.findIndex((widget) => widget?.name === DATA_WIDGET_NAME);
					if (widgetIndex >= 0) {
						serializedNode.widgets_values[widgetIndex] = serialized;
					}
				}
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const state = ensureState(this);
			state.executedImages = Array.isArray(message?.preview_images) ? message.preview_images : [];
			state.externalCount = Number(message?.external_image_count?.[0] || 0);
			state.mergedCount = Number(message?.merged_image_count?.[0] || 0);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			const state = ensureState(this);
			if (!hasExternalImageLink(this)) {
				state.externalCount = 0;
				state.executedImages = [];
				state.mergedCount = state.selection.length;
			}
			scheduleStabilize(this);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			// 只有宽度变化会影响列数和高度；高度变化不反向驱动预览区，避免抖动。
			const width = Math.round(Number(this.size?.[0] || MIN_WIDTH));
			if (this.__gjjMultiImageLastWidth !== width) {
				this.__gjjMultiImageLastWidth = width;
				scheduleLayout(this, true);
			}
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
				refreshOptions(node);
			}
		}
	},
});

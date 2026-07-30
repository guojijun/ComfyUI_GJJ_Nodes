import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_MultiImageLoader"]);
const DATA_WIDGET_NAME = "selected_images";
const GJJ_HELP_WIDGET_NAME = "gjj_help_button";
const SEQUENCE_RANGE_WIDGET_NAME = "sequence_range";
const MAX_OUTPUT_IMAGES = 20;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 220;
const DOM_WIDGET_NAME = "gjj_multi_image_loader_dom";
const INPUT_LINK_MEMORY_PROPERTY = "gjj_multi_image_loader_input_link_memory";
const IMAGE_API_PATH = "/gjj/input_images";
const THUMB_API_PATH = "/gjj/input_image_thumb";
const DEFAULT_NETWORK_IMAGE_API_PATH = "/gjj/multi_image_loader/default_image";
const TEMP_UPLOAD_API_PATH = "/gjj/multi_image_loader/upload_temp_images";
const GJJ_MULTI_IMAGE_DRAG_MIME = "application/x-gjj-multi-image-ref";
const GJJ_PROMPT_STYLE_IMAGE_DRAG_MIME = "application/x-gjj-prompt-preset-style-image";
const UPLOAD_SUBFOLDER = "gjj_multi_image_loader";
const NETWORK_CACHE_SUBFOLDER = "GJJ_TemplateParams";
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const BATCH_IMAGE_OUTPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const INPUT_IMAGES_NAME = "input_images";
const INPUT_IMAGES_LABEL = "导入图片";
const INPUT_IMAGES_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const SEQUENCE_RANGE_INPUT_TYPE = "INT,STRING,FLOAT";
const FILE_NAME_COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
const DEFAULT_THUMB_SIZE = 132;
const MIN_THUMB_SIZE = 72;
const MAX_THUMB_SIZE = 220;
const THUMB_STEP = 16;
const MAX_PREVIEW_HEIGHT = 560;
const SEQUENCE_RANGE_INPUT_LABEL = "序列范围";
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

function legacyInputElement(widget) {
	const descriptor = widget ? Object.getOwnPropertyDescriptor(widget, "inputEl") : null;
	return descriptor?.value instanceof HTMLElement ? descriptor.value : null;
}

function hideDataWidget(widget) {
	if (!widget) {
		return;
	}
	widget.serialize = false;
	if (widget.__gjjHidden) {
		widget.computeSize = () => [0, 0];
		widget.draw = () => {};
		const inputEl = legacyInputElement(widget);
		if (inputEl) {
			inputEl.style.display = "none";
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
	const inputEl = legacyInputElement(widget);
	if (inputEl) {
		inputEl.style.display = "none";
	}
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.widget) {
		widget.widget.style.display = "none";
	}
}

function rememberWidgetShape(widget) {
	if (!widget || widget.__gjjNativeShapeSaved) {
		return;
	}
	if (widget.__gjjOriginalType !== undefined || widget.__gjjOriginalComputeSize !== undefined) {
		widget.__gjjNativeShapeSaved = true;
		return;
	}
	widget.__gjjNativeShapeSaved = true;
	widget.__gjjOriginalType = widget.type;
	widget.__gjjOriginalComputeSize = widget.computeSize;
	widget.__gjjOriginalGetHeight = widget.getHeight;
	widget.__gjjOriginalDraw = widget.draw;
	widget.__gjjOriginalMouse = widget.mouse;
}

function hideNativeWidget(widget) {
	if (!widget) return;
	rememberWidgetShape(widget);
	widget.hidden = true;
	widget.disabled = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.y = -10000;
	widget.last_y = -10000;
	widget.options = widget.options || {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
}

function restoreNativeWidget(widget, fallbackType = "text") {
	if (!widget) return;
	widget.hidden = false;
	widget.disabled = false;
	widget.type = widget.__gjjOriginalType || fallbackType;
	if (widget.__gjjOriginalComputeSize) widget.computeSize = widget.__gjjOriginalComputeSize;
	else delete widget.computeSize;
	if (widget.__gjjOriginalGetHeight) widget.getHeight = widget.__gjjOriginalGetHeight;
	else delete widget.getHeight;
	if (widget.__gjjOriginalDraw) widget.draw = widget.__gjjOriginalDraw;
	else delete widget.draw;
	if (widget.__gjjOriginalMouse) widget.mouse = widget.__gjjOriginalMouse;
	else delete widget.mouse;
	widget.options = widget.options || {};
	delete widget.options.hidden;
	delete widget.options.display;
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
	// 这里不只是隐藏，而是从 widgets 布局数组中移除，避免前台 JSON widget 继续挤出空行。
	node.__gjjSelectedImagesWidget = node.__gjjSelectedImagesWidget || detachWidgetByName(node, DATA_WIDGET_NAME);
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
	pushWidget(node.__gjjMultiImageWidget);
	pushWidget(getWidget(node, SEQUENCE_RANGE_WIDGET_NAME) || node.__gjjSequenceRangeWidget);
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
			type: String(item?.type || "input"),
			width: Number(item?.width || 0),
			height: Number(item?.height || 0),
			mtime_ns: Number(item?.mtime_ns || 0),
			size_bytes: Number(item?.size_bytes || 0),
			hash: String(item?.hash || ""),
			format: String(item?.format || ""),
			media_type: String(item?.media_type || ""),
		})),
	);
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed.filter((item) => item?.filename).map(normalizeInputImageItem) : [];
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
	if (item?.url) {
		const url = String(item.url);
		if (/^(?:https?:|blob:|data:)/i.test(url)) {
			return url;
		}
	}
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
		slideOutputLoop: Boolean(node?.properties?.slide_output_loop),
		thumbSize: Number(node?.properties?.thumb_size || DEFAULT_THUMB_SIZE),
		rangeExpanded: Boolean(node?.properties?.sequence_range_expanded),
		dragIndex: null,
	};
	return node.__gjjMultiImageState;
}

async function fetchOptions() {
	try {
		const response = await fetch(api.apiURL ? api.apiURL(IMAGE_API_PATH) : IMAGE_API_PATH);
		if (!response.ok) {
			return [];
		}
		const data = await response.json();
		return Array.isArray(data?.images) ? data.images : [];
	} catch (error) {
		return [];
	}
}

function uploadUrl(path) {
	try {
		if (api?.apiURL) return api.apiURL(path);
	} catch (_) {}
	return path;
}

function splitInputRelativePath(filename) {
	let text = String(filename || "").trim().replace(/\\/g, "/");
	if (!text) return { filename: "", subfolder: "" };
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	if (annotated) text = text.slice(0, annotated.index).trim();
	const parts = text.split("/").filter(Boolean);
	if (["input", "output", "temp"].includes(String(parts[0] || "").toLowerCase())) parts.shift();
	const name = parts.pop() || "";
	return { filename: name, subfolder: parts.join("/") };
}

function inputViewUrlForFilename(filename) {
	const parts = splitInputRelativePath(filename);
	let url = `/view?filename=${encodeURIComponent(parts.filename)}&type=input`;
	if (parts.subfolder) url += `&subfolder=${encodeURIComponent(parts.subfolder)}`;
	return url;
}

async function inputFileExists(filename) {
	const url = uploadUrl(inputViewUrlForFilename(filename));
	try {
		let response = await fetch(url, { method: "HEAD", cache: "no-store" });
		if (response?.ok) return true;
		if (response?.status && response.status !== 405) return false;
		response = await fetch(url, { method: "GET", cache: "no-store" });
		return Boolean(response?.ok);
	} catch (_) {
		return false;
	}
}

function safeMediaFilename(name, mediaType = "IMAGE") {
	let text = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
	try { text = decodeURIComponent(text); } catch (_) {}
	text = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/^[ ._]+|[ ._]+$/g, "");
	if (!text) text = "downloaded_media";
	const ext = mediaType === "IMAGE" ? ".png" : "";
	if (ext && !/\.(?:png|jpe?g|webp|bmp|gif|avif|tiff?)$/i.test(text)) {
		text += ext;
	}
	return text;
}

function safeMediaSubdirPart(name) {
	let text = String(name || "");
	try { text = decodeURIComponent(text); } catch (_) {}
	text = text.replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, "_").trim().replace(/^[ ._]+|[ ._]+$/g, "");
	return (text || "network").slice(0, 72).replace(/[ ._]+$/g, "") || "network";
}

function filenameFromNetworkUrl(url) {
	try {
		const parsed = new URL(String(url || "").trim(), window.location.href);
		return safeMediaFilename(parsed.pathname.split("/").pop() || "", "IMAGE");
	} catch (_) {
		return safeMediaFilename(String(url || "").split("?")[0], "IMAGE");
	}
}

async function shortSha1(text) {
	try {
		const subtle = globalThis.crypto?.subtle;
		if (subtle && globalThis.TextEncoder) {
			const digest = await subtle.digest("SHA-1", new TextEncoder().encode(String(text || "")));
			return Array.from(new Uint8Array(digest)).slice(0, 5).map((value) => value.toString(16).padStart(2, "0")).join("");
		}
	} catch (_) {}

	let hash = 2166136261;
	const source = String(text || "");
	for (let index = 0; index < source.length; index++) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 10);
}

async function networkImageCachePath(url) {
	const filename = filenameFromNetworkUrl(url);
	try {
		const parsed = new URL(String(url || "").trim(), window.location.href);
		const pathParts = parsed.pathname
			.split("/")
			.map((part) => {
				try { return decodeURIComponent(part); } catch (_) { return part; }
			})
			.filter(Boolean);
		const sourceName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : (parsed.host || "network");
		const sourceDir = pathParts.slice(0, -1).join("/");
		let sourceKey = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}/${sourceDir}`;
		if (parsed.search) sourceKey += parsed.search;
		const digest = await shortSha1(sourceKey);
		const subfolder = `${NETWORK_CACHE_SUBFOLDER}/${safeMediaSubdirPart(sourceName)}_${digest}`;
		return { filename, subfolder, relativePath: `${subfolder}/${filename}` };
	} catch (_) {
		const digest = await shortSha1(String(url || ""));
		const subfolder = `${NETWORK_CACHE_SUBFOLDER}/network_${digest}`;
		return { filename, subfolder, relativePath: `${subfolder}/${filename}` };
	}
}

function inputItemFromRelativePath(relativePath, extra = {}) {
	const parts = splitInputRelativePath(relativePath);
	return normalizeInputImageItem({
		filename: parts.filename,
		subfolder: parts.subfolder,
		type: "input",
		...extra,
	});
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

function addSelectionItems(node, items) {
	const state = ensureState(node);
	let changed = false;
	for (const rawItem of items || []) {
		const item = normalizeInputImageItem(rawItem);
		if (!item.filename) {
			continue;
		}
		const alreadySelected = state.selection.some((selected) => itemKey(selected) === itemKey(item));
		if (!alreadySelected) {
			state.selection.push(item);
			changed = true;
		}
	}
	if (!changed) {
		return false;
	}
	enrichSelectionWithOptions(state);
	syncDataWidget(node);
	ensureOutputs(node, totalImageCount(node));
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
	return true;
}

function graphLink(linkId) {
	const links = app.graph?.links || app.graph?._links;
	if (linkId == null || !links) return null;
	if (typeof links.get === "function") return links.get(linkId) || links.get(String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function linkField(link, name) {
	if (!link) return null;
	if (!Array.isArray(link)) return link[name];
	const indexes = { id: 0, origin_id: 1, origin_slot: 2, target_id: 3, target_slot: 4, type: 5 };
	return link[indexes[name]];
}

function inputIndexByName(node, name) {
	return (node?.inputs || []).findIndex((input) => input?.name === name);
}

function findGraphNodeById(id) {
	if (id == null) return null;
	const found = app.graph?.getNodeById?.(id);
	if (found) return found;
	return (app.graph?._nodes || []).find((item) => String(item?.id) === String(id)) || null;
}

function currentInputImageLinkRecord(node) {
	const targetSlot = inputIndexByName(node, INPUT_IMAGES_NAME);
	const input = targetSlot >= 0 ? node.inputs?.[targetSlot] : null;
	const linkId = input?.link;
	const link = graphLink(linkId);
	if (targetSlot < 0 || linkId == null || !link) return null;
	const originId = linkField(link, "origin_id") ?? linkField(link, "source_id") ?? linkField(link, "from_id");
	const originSlot = linkField(link, "origin_slot") ?? linkField(link, "source_slot") ?? linkField(link, "from_slot");
	const source = findGraphNodeById(originId);
	if (originId == null || !Number.isFinite(Number(originSlot))) return null;
	return {
		input_name: INPUT_IMAGES_NAME,
		origin_id: originId,
		origin_slot: Number(originSlot),
		target_slot: Number(linkField(link, "target_slot") ?? targetSlot),
		type: String(linkField(link, "type") || input?.type || INPUT_IMAGES_TYPE),
		origin_name: String(source?.title || source?.comfyClass || source?.type || "上游节点"),
	};
}

function inputImageLinkMemory(node, create = false) {
	if (!create && (!node?.properties || !node.properties[INPUT_LINK_MEMORY_PROPERTY])) return null;
	node.properties = node.properties || {};
	const memory = node.properties[INPUT_LINK_MEMORY_PROPERTY];
	if (memory && typeof memory === "object" && !Array.isArray(memory)) return memory;
	if (!create) return null;
	node.properties[INPUT_LINK_MEMORY_PROPERTY] = {};
	return node.properties[INPUT_LINK_MEMORY_PROPERTY];
}

function rememberedInputImageLink(node) {
	const memory = inputImageLinkMemory(node);
	return memory && typeof memory === "object" ? memory : null;
}

function hasRememberedInputImageLink(node) {
	const record = rememberedInputImageLink(node);
	return Boolean(record?.origin_id != null && Number.isFinite(Number(record?.origin_slot)));
}

function updateInputLinkButtonState(node) {
	const button = node?.__gjjMultiImageLinkButton;
	if (!button) return;
	const active = Boolean(currentInputImageLinkRecord(node));
	const remembered = hasRememberedInputImageLink(node);
	button.style.display = active || remembered ? "inline-flex" : "none";
	button.textContent = "🔗";
	button.title = active
		? "断开导入图片上游连接，并记住来源。再次点击可恢复。"
		: "恢复刚才断开的导入图片上游连接。";
	button.style.background = active ? "#20362f" : "#2b4250";
	button.style.borderColor = active ? "#4f8f7a" : "#5ca6d6";
	button.style.boxShadow = active ? "0 0 0 1px rgba(79,143,122,.28) inset" : "0 0 0 1px rgba(92,166,214,.3) inset";
	button.__gjjStyleRefresh = () => {
		button.style.background = active ? "#20362f" : "#2b4250";
		button.style.borderColor = active ? "#4f8f7a" : "#5ca6d6";
		button.style.boxShadow = active ? "0 0 0 1px rgba(79,143,122,.28) inset" : "0 0 0 1px rgba(92,166,214,.3) inset";
	};
}

function disconnectRememberedInputImageLink(node) {
	const record = currentInputImageLinkRecord(node);
	if (!record) {
		updateInputLinkButtonState(node);
		return false;
	}
	inputImageLinkMemory(node, true);
	node.properties[INPUT_LINK_MEMORY_PROPERTY] = record;
	const targetSlot = inputIndexByName(node, INPUT_IMAGES_NAME);
	try {
		node.disconnectInput?.(targetSlot);
	} catch (_) {
		if (node.inputs?.[targetSlot]) node.inputs[targetSlot].link = null;
	}
	markGraphChanged(node);
	updateInputLinkButtonState(node);
	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.textContent = `已断开上游：${record.origin_name || "上游节点"}`;
	}
	scheduleLayout(node, true);
	return true;
}

function reconnectRememberedInputImageLink(node) {
	const record = rememberedInputImageLink(node);
	if (!record) {
		updateInputLinkButtonState(node);
		return false;
	}
	const source = findGraphNodeById(record.origin_id);
	const sourceSlot = Number(record.origin_slot);
	ensureExternalImageInput(node);
	reorderInputSlots(node);
	const targetSlot = inputIndexByName(node, INPUT_IMAGES_NAME);
	if (!source || !source.outputs?.[sourceSlot] || targetSlot < 0) {
		if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.textContent = "上游节点或接口不存在，无法恢复连接";
		}
		updateInputLinkButtonState(node);
		return false;
	}
	try {
		if (node.inputs?.[targetSlot]?.link != null) node.disconnectInput?.(targetSlot);
		source.connect(sourceSlot, node, targetSlot);
		node.properties = node.properties || {};
		node.properties[INPUT_LINK_MEMORY_PROPERTY] = { ...record, target_slot: targetSlot };
		markGraphChanged(node);
		updateInputLinkButtonState(node);
		if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.textContent = `已恢复上游：${record.origin_name || "上游节点"}`;
		}
		scheduleStabilize(node, 0);
		return true;
	} catch (error) {
		console.warn("[GJJ_MultiImageLoader] reconnect upstream failed", error);
		if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.textContent = error?.message || "恢复上游连接失败";
		}
		updateInputLinkButtonState(node);
		return false;
	}
}

function toggleInputImageLink(node) {
	if (currentInputImageLinkRecord(node)) {
		return disconnectRememberedInputImageLink(node);
	}
	return reconnectRememberedInputImageLink(node);
}

function linkedInputImageSources(node) {
	const input = (node?.inputs || []).find((item) => item?.name === INPUT_IMAGES_NAME);
	const linkIds = Array.isArray(input?.link) ? input.link : (input?.link == null ? [] : [input.link]);
	const sources = [];
	for (const linkId of linkIds) {
		const link = graphLink(linkId);
		const sourceId = linkField(link, "origin_id") ?? linkField(link, "source_id") ?? linkField(link, "from_id");
		if (sourceId == null) {
			continue;
		}
		const source = findGraphNodeById(sourceId);
		if (source) {
			sources.push(source);
		}
	}
	return sources;
}

function mediaItemsFromPreviewItems(items) {
	const result = [];
	for (const item of Array.isArray(items) ? items : []) {
		for (const key of ["images", "preview_images", "__gjj_queue_images"]) {
			const payload = item?.[key];
			if (Array.isArray(payload)) {
				for (const media of payload.flat()) {
					if (media?.filename) result.push(media);
				}
			} else if (payload?.filename) {
				result.push(payload);
			}
		}
	}
	return result;
}

function normalizeUpstreamImageRef(item) {
	if (!item?.filename) {
		return null;
	}
	return normalizeInputImageItem({
		filename: String(item.filename || ""),
		subfolder: String(item.subfolder || ""),
		type: String(item.type || "temp"),
		width: Number(item.width || item.preview_width || item.w || 0),
		height: Number(item.height || item.preview_height || item.h || 0),
		mtime_ns: Number(item.mtime_ns || 0),
		size_bytes: Number(item.size_bytes || 0),
		hash: String(item.hash || ""),
		format: String(item.format || ""),
		media_type: String(item.media_type || "image"),
		source_url: String(item.source_url || ""),
	});
}

function imageRefsFromUpstreamNode(source) {
	const refs = [];
	const state = source?.__gjjMultiImageState || source?.__gjjMultiImageLoaderState || {};
	for (const payload of [
		state.executedImages,
		state.selection,
		parseSelection(source?.properties?.[DATA_WIDGET_NAME]),
		source?.__gjjAnyPreviewImages,
		mediaItemsFromPreviewItems(source?.__gjjAnyPreviewItems),
		source?.properties?.gjj_any_preview_held_images,
	]) {
		const list = Array.isArray(payload) ? payload : (payload?.filename ? [payload] : []);
		for (const item of list) {
			const ref = normalizeUpstreamImageRef(item);
			if (ref) refs.push(ref);
		}
	}
	const seen = new Set();
	return refs.filter((item) => {
		const key = itemKey(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function importLinkedUpstreamImages(node) {
	const sources = linkedInputImageSources(node);
	if (!sources.length) {
		return false;
	}
	const items = sources.flatMap((source) => imageRefsFromUpstreamNode(source));
	if (!items.length) {
		await refreshOptions(node);
		if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.textContent = "上游暂无可获取的图片，请先执行或刷新上游节点";
		}
		requestRedraw(node);
		return true;
	}
	const state = ensureState(node);
	state.selection = items;
	state.executedImages = [];
	state.externalCount = 0;
	state.mergedCount = state.selection.length;
	if (state.slideOutputEnabled) {
		applySlidingRange(node);
	} else {
		syncSequenceRange(node, "");
		syncSequenceRangeInput(node);
	}
	syncDataWidget(node);
	ensureOutputs(node, totalImageCount(node));
	await refreshOptions(node);
	enrichSelectionWithOptions(state);
	renderPreview(node);
	updateSummary(node);
	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.textContent = `已从上游获取 ${items.length} 张图片到本节点`;
	}
	scheduleLayout(node, true);
	requestRedraw(node);
	return true;
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
	addSelectionItems(node, uploaded.map((item) => ({ ...item, type: "input" })));
}

function imageFilesFromDropEvent(event) {
	const files = Array.from(event?.dataTransfer?.files || []);
	return files
		.filter((file) => String(file?.type || "").startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(file?.name || ""))
		.sort((a, b) => FILE_NAME_COLLATOR.compare(a.name || "", b.name || ""));
}

function draggedImageRefsFromDropEvent(event) {
	const transfer = event?.dataTransfer;
	if (!hasDraggedImageRefs(event)) {
		return [];
	}
	try {
		const raw = transfer.getData(GJJ_MULTI_IMAGE_DRAG_MIME);
		const parsed = JSON.parse(String(raw || "null"));
		const list = Array.isArray(parsed) ? parsed : [parsed];
		return list
			.filter((item) => item?.filename)
			.map((item) => normalizeInputImageItem({
				filename: String(item.filename || ""),
				subfolder: String(item.subfolder || ""),
				type: String(item.type || "temp"),
				width: Number(item.width || item.preview_width || item.w || 0),
				height: Number(item.height || item.preview_height || item.h || 0),
				mtime_ns: Number(item.mtime_ns || 0),
				size_bytes: Number(item.size_bytes || 0),
				hash: String(item.hash || ""),
				format: String(item.format || ""),
				media_type: String(item.media_type || "image"),
			}));
	} catch (_) {
		return [];
	}
}

function hasDraggedImageRefs(event) {
	return Array.from(event?.dataTransfer?.types || []).includes(GJJ_MULTI_IMAGE_DRAG_MIME);
}

function draggedPromptStyleFromDropEvent(event) {
	if (!Array.from(event?.dataTransfer?.types || []).includes(GJJ_PROMPT_STYLE_IMAGE_DRAG_MIME)) {
		return null;
	}
	try {
		const payload = JSON.parse(event.dataTransfer.getData(GJJ_PROMPT_STYLE_IMAGE_DRAG_MIME) || "null");
		return payload?.item?.thumbnail ? payload.item : null;
	} catch (_) {
		return null;
	}
}

async function promptStyleImageFile(item) {
	const url = String(item?.thumbnail || "").trim();
	if (!url) {
		throw new Error("风格图片地址为空");
	}
	const response = await fetch(url, { credentials: "same-origin" });
	if (!response.ok) {
		throw new Error(`下载风格图片失败：HTTP ${response.status}`);
	}
	const blob = await response.blob();
	if (!String(blob.type || "").startsWith("image/")) {
		throw new Error("风格预览不是有效图片");
	}
	let extension = "";
	try {
		extension = new URL(url, window.location.href).pathname.match(/\.[a-z0-9]{2,5}$/i)?.[0] || "";
	} catch (_) {}
	if (!extension) {
		extension = blob.type === "image/jpeg" ? ".jpg" : blob.type === "image/webp" ? ".webp" : ".png";
	}
	const stem = String(item?.name || item?.name_cn || "style")
		.replace(/[^a-z0-9\u4e00-\u9fff_-]+/gi, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80) || "style";
	return new File([blob], `gjj_prompt_preset_${stem}${extension}`, { type: blob.type || "image/png" });
}

async function uploadFilesToTemp(node, files) {
	const list = Array.from(files || []);
	if (!list.length) {
		return [];
	}
	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.textContent = `正在拖入 ${list.length} 张...`;
	}
	const formData = new FormData();
	for (const file of list) {
		formData.append("images", file, file.name || "image.png");
	}
	const response = api?.fetchApi
		? await api.fetchApi(TEMP_UPLOAD_API_PATH, { method: "POST", body: formData })
		: await fetch(uploadUrl(TEMP_UPLOAD_API_PATH), { method: "POST", body: formData });
	const data = await response.json().catch(() => ({}));
	if (!response?.ok || data?.ok === false) {
		throw new Error(data?.error || `拖拽导入失败：HTTP ${response?.status || "?"}`);
	}
	const items = Array.isArray(data?.items) && data.items.length ? data.items : (Array.isArray(data?.images) ? data.images : []);
	if (!items.length) {
		throw new Error("拖拽导入没有返回图片");
	}
	return items.map((item) => normalizeInputImageItem({ ...item, type: item?.type || "temp" }));
}

function normalizeUploadFilename(data, file, requestedSubfolder = "") {
	const filename = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
	if (!filename) return "";
	if (filename.includes("/")) return filename;
	const subfolder = String(data?.subfolder ?? requestedSubfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadImageFileToInput(file, subfolder = "") {
	const cleanSubfolder = String(subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const formData = new FormData();
	formData.append("image", file, file.name);
	formData.append("type", "input");
	formData.append("overwrite", "true");
	if (cleanSubfolder) formData.append("subfolder", cleanSubfolder);

	const response = api?.fetchApi
		? await api.fetchApi("/upload/image", { method: "POST", body: formData })
		: await fetch(uploadUrl("/upload/image"), { method: "POST", body: formData });
	if (!response?.ok) {
		let detail = "";
		try { detail = await response.text(); } catch (_) {}
		throw new Error(`上传到 input 失败：HTTP ${response?.status || "?"}${detail ? ` ${detail}` : ""}`);
	}
	const data = await response.json().catch(() => ({}));
	const filename = normalizeUploadFilename(data, file, cleanSubfolder);
	if (!filename) throw new Error("上传成功但没有返回 input 文件名");
	return filename;
}

async function downloadNetworkImageViaBackend(url) {
	const request = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ urls: [url] }),
	};
	const response = api?.fetchApi
		? await api.fetchApi(DEFAULT_NETWORK_IMAGE_API_PATH, request)
		: await fetch(uploadUrl(DEFAULT_NETWORK_IMAGE_API_PATH), request);
	const data = await response.json().catch(() => ({}));
	if (!response?.ok || data?.ok === false) {
		throw new Error(data?.error || `后端下载 HTTP ${response?.status || "?"}`);
	}
	const items = Array.isArray(data?.items) && data.items.length ? data.items : (data?.item ? [data.item] : []);
	const item = items.find((entry) => entry?.filename);
	if (!item) throw new Error("后端没有返回 input 图片文件名");
	return normalizeInputImageItem({ ...item, source_url: url });
}

async function downloadNetworkImageInBrowser(url, cacheInfo) {
	const response = await fetch(url, { cache: "no-store" });
	if (!response?.ok) {
		throw new Error(`浏览器下载 HTTP ${response?.status || "?"}`);
	}
	const blob = await response.blob();
	if (!blob || blob.size <= 0) {
		throw new Error("浏览器下载结果为空");
	}
	const file = new File([blob], cacheInfo.filename, { type: blob.type || "image/jpeg" });
	const uploadedName = await uploadImageFileToInput(file, cacheInfo.subfolder);
	return inputItemFromRelativePath(uploadedName, { source_url: url });
}

async function ensureNetworkImageInInput(url) {
	const cacheInfo = await networkImageCachePath(url);
	if (await inputFileExists(cacheInfo.relativePath)) {
		return inputItemFromRelativePath(cacheInfo.relativePath, { source_url: url });
	}

	let backendError = null;
	try {
		return await downloadNetworkImageViaBackend(url);
	} catch (error) {
		backendError = error;
	}

	try {
		return await downloadNetworkImageInBrowser(url, cacheInfo);
	} catch (browserError) {
		const backendMessage = backendError?.message || backendError || "未知错误";
		const browserMessage = browserError?.message || browserError || "未知错误";
		throw new Error(`后端下载失败：${backendMessage}；浏览器上传到 input 失败：${browserMessage}`);
	}
}

function parseNetworkImageUrls(text) {
	const matches = String(text || "").match(/https?:\/\/[^\s<>"'“”‘’]+/gi) || [];
	const seen = new Set();
	const urls = [];
	for (const raw of matches) {
		const url = String(raw || "")
			.trim()
			.replace(/^[\[\]({【「『]+/g, "")
			.replace(/[,，;；。.!！?？\]\)}】」』]+$/g, "");
		if (!url || seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	return urls;
}

function networkUrlsFromProperties(properties) {
	if (Array.isArray(properties?.default_network_image_urls)) {
		return properties.default_network_image_urls
			.flatMap((item) => parseNetworkImageUrls(item))
			.filter(Boolean);
	}
	return parseNetworkImageUrls(properties?.default_network_image_url || "");
}

function persistNetworkUrls(node, urls, options = {}) {
	node.properties = node.properties || {};
	const cleaned = Array.isArray(urls) ? urls.flatMap((item) => parseNetworkImageUrls(item)) : parseNetworkImageUrls(urls);
	node.properties.default_network_image_urls = cleaned;
	node.properties.default_network_image_url = cleaned.join("\n");
	if (options.notify !== false) {
		markGraphChanged(node);
	}
	return cleaned;
}

function normalizeInputImageItem(item) {
	const filename = String(item?.filename || "");
	const subfolder = String(item?.subfolder || "").replace(/\\/g, "/");
	const type = ["input", "temp", "output"].includes(String(item?.type || "").toLowerCase())
		? String(item.type).toLowerCase()
		: "input";
	return {
		filename,
		subfolder,
		type,
		label: String(item?.label || (subfolder ? `${subfolder}/${filename}` : filename)),
		width: Number(item?.width || 0),
		height: Number(item?.height || 0),
		mtime_ns: Number(item?.mtime_ns || 0),
		size_bytes: Number(item?.size_bytes || 0),
		hash: String(item?.hash || ""),
		format: String(item?.format || ""),
		media_type: String(item?.media_type || ""),
		source_url: String(item?.source_url || ""),
	};
}

function askNetworkImageUrls(initialText = "") {
	return new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.style.cssText = [
			"position:fixed",
			"inset:0",
			"z-index:10050",
			"background:rgba(0,0,0,.58)",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"padding:24px",
			"box-sizing:border-box",
		].join(";");
		const panel = document.createElement("div");
		panel.style.cssText = [
			"width:min(560px, calc(100vw - 48px))",
			"border:1px solid #41535b",
			"border-radius:9px",
			"background:#10181d",
			"box-shadow:0 18px 50px rgba(0,0,0,.42)",
			"padding:12px",
			"box-sizing:border-box",
			"color:#dce7e2",
			"display:flex",
			"flex-direction:column",
			"gap:9px",
		].join(";");
		const title = document.createElement("div");
		title.textContent = "设置默认网络图片";
		title.style.cssText = "font:700 14px/20px sans-serif;color:#f1f7f4";
		const hint = document.createElement("div");
		hint.textContent = "可粘贴多条 http/https 图片地址，一行一个，也可用空格或逗号分隔。";
		hint.style.cssText = "font:12px/18px sans-serif;color:#9fb0b7";
		const input = document.createElement("textarea");
		input.value = String(initialText || "");
		input.placeholder = "https://example.com/a.png\nhttps://example.com/b.jpg";
		input.spellcheck = false;
		input.style.cssText = [
			"width:100%",
			"min-height:138px",
			"resize:vertical",
			"border:1px solid #33464e",
			"border-radius:8px",
			"background:#0a1115",
			"color:#edf5f2",
			"outline:none",
			"padding:8px",
			"box-sizing:border-box",
			"font:12px/1.45 Consolas, ui-monospace, monospace",
		].join(";");
		const actions = document.createElement("div");
		actions.style.cssText = "display:flex;justify-content:flex-end;gap:7px";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.textContent = "取消";
		const ok = document.createElement("button");
		ok.type = "button";
		ok.textContent = "确定";
		for (const button of [cancel, ok]) {
			button.style.cssText = "height:28px;padding:0 12px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;font:12px/26px sans-serif";
		}
		ok.style.background = "#20362f";
		ok.style.borderColor = "#4f8f7a";
		const done = (value) => {
			overlay.remove();
			resolve(value);
		};
		cancel.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			done(null);
		});
		ok.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			done(input.value);
		});
		input.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				done(null);
			} else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				done(input.value);
			}
		});
		for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
			overlay.addEventListener(eventName, (event) => event.stopPropagation());
		}
		actions.append(cancel, ok);
		panel.append(title, hint, input, actions);
		overlay.appendChild(panel);
		document.body.appendChild(overlay);
		setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	});
}

async function setDefaultNetworkImage(node) {
	const state = ensureState(node);
	const currentText = networkUrlsFromProperties(node?.properties || {}).join("\n");
	const text = await askNetworkImageUrls(currentText);
	if (text == null) {
		return;
	}
	const urls = parseNetworkImageUrls(text);
	if (!urls.length) {
		if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.textContent = "请输入至少一条 http/https 网络图片地址";
		}
		requestRedraw(node);
		return;
	}

	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.textContent = `正在下载 ${urls.length} 张网络图片并设置默认图片...`;
	}
	persistNetworkUrls(node, urls);
	try {
		const items = [];
		const errors = [];
		for (const [index, url] of urls.entries()) {
			if (node.__gjjMultiImageSummary) {
				node.__gjjMultiImageSummary.textContent = `正在写入 input：${index + 1}/${urls.length}`;
			}
			try {
				const item = await ensureNetworkImageInInput(url);
				if (item?.filename) {
					items.push(normalizeInputImageItem(item));
				} else {
					errors.push(`第 ${index + 1} 条没有返回 input 文件名：${url}`);
				}
			} catch (error) {
				errors.push(`第 ${index + 1} 条失败：${error?.message || error}`);
			}
		}

		if (!items.length) {
			throw new Error(errors.slice(0, 5).join("；") || "没有网络图片成功写入 input。");
		}

		node.properties = node.properties || {};
		state.selection = items;
		state.executedImages = [];
		state.externalCount = 0;
		state.mergedCount = state.selection.length;
		if (state.slideOutputEnabled) {
			applySlidingRange(node);
		} else {
			syncSequenceRange(node, "");
			syncSequenceRangeInput(node);
		}
		syncDataWidget(node);
		ensureOutputs(node, totalImageCount(node));
		await refreshOptions(node);
		enrichSelectionWithOptions(state);
		renderPreview(node);
		updateSummary(node);
		if (node.__gjjMultiImageSummary && errors.length) {
			node.__gjjMultiImageSummary.textContent = `已设置 ${state.selection.length} 张，${errors.length} 条失败`;
			node.__gjjMultiImageSummary.title = errors.join("\n");
		} else if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.title = "";
		}
		scheduleLayout(node, true);
	} catch (error) {
		if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.textContent = error?.message || "设置默认图片失败";
		}
		requestRedraw(node);
	}
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
	const widget = getSequenceRangeWidget(node);
	if (widget && !widget.hidden && widget.value != null) {
		return String(widget.value || "");
	}
	return String(node?.properties?.[SEQUENCE_RANGE_WIDGET_NAME] ?? widget?.value ?? "");
}

function getSequenceRangeWidget(node) {
	let widget = getWidget(node, SEQUENCE_RANGE_WIDGET_NAME) || node.__gjjSequenceRangeWidget;
	if (!widget && typeof node?.addWidget === "function") {
		widget = node.addWidget("text", SEQUENCE_RANGE_WIDGET_NAME, String(node?.properties?.[SEQUENCE_RANGE_WIDGET_NAME] || ""), (value) => {
			node.properties = node.properties || {};
			node.properties[SEQUENCE_RANGE_WIDGET_NAME] = String(value || "");
		}, {
			display_name: SEQUENCE_RANGE_INPUT_LABEL,
			tooltip: "留空输出全部；[1,3,5] 输出指定序号；[1:8] 输出闭区间。",
		});
		if (widget) {
			widget.serialize = true;
		}
	}
	if (widget) {
		node.__gjjSequenceRangeWidget = widget;
	}
	return widget;
}

function patchSequenceRangeWidgetCallback(node, widget) {
	if (!widget || widget.__gjjSequenceRangeCallbackPatched) return;
	const originalCallback = widget.callback;
	widget.__gjjSequenceRangeCallbackPatched = true;
	widget.callback = function (value, ...args) {
		node.properties = node.properties || {};
		node.properties[SEQUENCE_RANGE_WIDGET_NAME] = String(value || "");
		const result = originalCallback?.apply(this, [value, ...args]);
		markGraphChanged(node);
		updateSummary(node);
		return result;
	};
}

function syncSequenceRange(node, value) {
	node.properties = node.properties || {};
	node.properties[SEQUENCE_RANGE_WIDGET_NAME] = String(value || "");
	const widget = getSequenceRangeWidget(node);
	if (widget) {
		widget.value = String(value || "");
		widget.callback?.(widget.value, app.canvas, node, undefined, widget);
	}
	markGraphChanged(node);
}

function ensureSequenceRangeInput(node) {
	let input = (node.inputs || []).find((item) => item?.name === SEQUENCE_RANGE_WIDGET_NAME);
	if (!input) {
		node.addInput?.(SEQUENCE_RANGE_WIDGET_NAME, SEQUENCE_RANGE_INPUT_TYPE);
		input = (node.inputs || []).find((item) => item?.name === SEQUENCE_RANGE_WIDGET_NAME);
	}
	if (input) {
		input.name = SEQUENCE_RANGE_WIDGET_NAME;
		input.label = SEQUENCE_RANGE_INPUT_LABEL;
		input.localized_name = SEQUENCE_RANGE_INPUT_LABEL;
		input.type = SEQUENCE_RANGE_INPUT_TYPE;
		input.tooltip = "可选：外部输入序列范围。STRING 支持 [1,3,5] / [1:8]；INT/FLOAT 会转成单个序号。";
		input.widget = { name: SEQUENCE_RANGE_WIDGET_NAME };
	}
	return input;
}

function removeSequenceRangeInput(node) {
	const index = (node.inputs || []).findIndex((input) => input?.name === SEQUENCE_RANGE_WIDGET_NAME);
	if (index < 0) return;
	if (node.inputs[index]?.link != null) {
		node.disconnectInput?.(index);
	}
	node.removeInput?.(index);
}

function syncSequenceRangeInput(node) {
	const state = ensureState(node);
	const widget = getSequenceRangeWidget(node);
	if (!widget) return;
	patchSequenceRangeWidgetCallback(node, widget);
	widget.value = getSequenceRange(node);
	if (state.rangeExpanded) {
		restoreNativeWidget(widget, "text");
		ensureSequenceRangeInput(node);
	} else {
		removeSequenceRangeInput(node);
		hideNativeWidget(widget);
	}
}

function formatSlidingRange(index, count, size = 2, loop = true) {
	const total = Math.max(0, Number(count || 0));
	if (total <= 0) {
		return "";
	}
	const span = Math.max(1, Math.min(3, Number(size || 1)));
	const first = loop
		? ((Math.max(1, Number(index || 1)) - 1) % total) + 1
		: Math.min(Math.max(1, Number(index || 1)), Math.max(1, total - span + 1));
	const values = [];
	for (let offset = 0; offset < span; offset++) {
		const value = first + offset;
		if (!loop && value > total) break;
		values.push(loop ? ((value - 1) % total) + 1 : value);
	}
	return `[${values.join(",")}]`;
}

function applySlidingRange(node) {
	const state = ensureState(node);
	const count = slidingSourceCount(node);
	if (!state.slideOutputEnabled || count <= 0) {
		return;
	}
	const span = Math.max(1, Math.min(3, Number(state.slideOutputSize || 1)));
	state.slideOutputIndex = state.slideOutputLoop
		? ((Math.max(1, Number(state.slideOutputIndex || 1)) - 1) % count) + 1
		: Math.min(Math.max(1, Number(state.slideOutputIndex || 1)), Math.max(1, count - span + 1));
	node.properties = node.properties || {};
	node.properties.slide_output_enabled = true;
	node.properties.slide_output_index = state.slideOutputIndex;
	node.properties.slide_output_size = state.slideOutputSize;
	node.properties.slide_output_loop = Boolean(state.slideOutputLoop);
	const nextRange = formatSlidingRange(state.slideOutputIndex, count, state.slideOutputSize, state.slideOutputLoop);
	node.properties[SEQUENCE_RANGE_WIDGET_NAME] = nextRange;
	if (getSequenceRange(node) !== nextRange) {
		syncSequenceRange(node, nextRange);
	}
	syncSequenceRangeInput(node);
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
	const lastIndex = Math.max(1, count - Math.max(1, Math.min(3, Number(state.slideOutputSize || 1))) + 1);
	if (!state.slideOutputLoop && Math.max(1, Number(state.slideOutputIndex || 1)) >= lastIndex) {
		stopSlidingOutput(node);
		return;
	}
	state.slideOutputIndex = state.slideOutputLoop
		? (Math.max(1, Number(state.slideOutputIndex || 1)) % count) + 1
		: Math.min(lastIndex, Math.max(1, Number(state.slideOutputIndex || 1)) + 1);
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
	reorderInputSlots(node);
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
	const selectedCount = Number(state.selection?.length || 0);
	const externalCount = Number(state.externalCount || 0);
	const mergedCount = Number(state.mergedCount || 0);
	if (hasExternalImageLink(node)) {
		return Math.max(0, externalCount > 0 ? selectedCount + externalCount : Math.max(selectedCount, mergedCount));
	}
	if (externalCount > 0) {
		return Math.max(0, selectedCount + externalCount);
	}
	return Math.max(0, selectedCount);
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
		const rangeText = active ? formatSlidingRange(state.slideOutputIndex, count, size, state.slideOutputLoop) : "";
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
			: `滑动输出 ${size} 张：点击后自动执行并推进。`;
	}
	const loopButton = node.__gjjMultiImageSlideLoopButton;
	if (loopButton) {
		const active = Boolean(state.slideOutputLoop);
		loopButton.style.background = active ? "#1f6f55" : "#1a2328";
		loopButton.style.borderColor = active ? "#33c48d" : "#465761";
		loopButton.style.boxShadow = active ? "0 0 0 1px rgba(51,196,141,.55) inset, 0 0 10px rgba(51,196,141,.32)" : "none";
		loopButton.title = active ? "循环已开启：滑动输出会一直循环。" : "循环已关闭：输出到最后一张图片后结束。";
	}
	const initButton = node.__gjjMultiImageSlideInitButton;
	if (initButton) {
		initButton.style.opacity = count > 0 ? "1" : "0.55";
		initButton.title = "初始化滑动输出：重置为从第 1 张开始。";
	}
	syncSequenceRangeInput(node);
}

function hasExternalImageLink(node) {
	return Array.isArray(node?.inputs) && node.inputs.some((input) => input?.name === INPUT_IMAGES_NAME && !!input?.link);
}

function ensureExternalImageInput(node) {
	let input = (node.inputs || []).find((item) => item?.name === INPUT_IMAGES_NAME);
	if (!input) {
		node.addInput?.(INPUT_IMAGES_NAME, INPUT_IMAGES_TYPE);
		input = (node.inputs || []).find((item) => item?.name === INPUT_IMAGES_NAME);
	}
	if (input) {
		input.name = INPUT_IMAGES_NAME;
		input.label = INPUT_IMAGES_LABEL;
		input.localized_name = INPUT_IMAGES_LABEL;
		input.type = INPUT_IMAGES_TYPE;
		input.forceInput = true;
		input.tooltip = "可接入 GJJ 专用批量图片队列或普通 IMAGE batch；会与当前已选图片合并预览并一起输出。";
		if (input.widget?.name === INPUT_IMAGES_NAME) {
			delete input.widget;
		}
	}
	return input;
}

function syncInputLinkSlots(node) {
	const links = app.graph?.links;
	if (!links || !Array.isArray(node?.inputs)) {
		return;
	}
	node.inputs.forEach((input, index) => {
		const linkIds = Array.isArray(input?.link) ? input.link : (input?.link == null ? [] : [input.link]);
		for (const linkId of linkIds) {
			const link = links[linkId];
			if (link && Number(link.target_id) === Number(node.id)) {
				link.target_slot = index;
			}
		}
	});
}

function reorderInputSlots(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	const priority = (input, index) => {
		const name = String(input?.name || "");
		if (name === INPUT_IMAGES_NAME) return 10;
		if (name === SEQUENCE_RANGE_WIDGET_NAME) return 20;
		if (name === SLIDE_START_INPUT_NAME) return 30;
		return 100 + index;
	};
	const ordered = node.inputs
		.map((input, index) => ({ input, index }))
		.sort((left, right) => priority(left.input, left.index) - priority(right.input, right.index) || left.index - right.index)
		.map((item) => item.input);
	const changed = ordered.some((input, index) => input !== node.inputs[index]);
	if (!changed) {
		return;
	}
	node.inputs.splice(0, node.inputs.length, ...ordered);
	syncInputLinkSlots(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function ensureOutputs(node, count) {
	const state = ensureState(node);
	const imageCount = Math.max(0, Number(count || 0));
	const individualCount = state.showIndividualOutputs ? Math.min(imageCount, MAX_OUTPUT_IMAGES) : 0;
	const visibleCount = 1 + individualCount;
	let changed = false;

	while ((node.outputs?.length || 0) < visibleCount) {
		const outputIndex = node.outputs?.length || 0;
		if (outputIndex === 0) {
			node.addOutput?.("批量图片队列", BATCH_IMAGE_OUTPUT_TYPE);
			changed = true;
			continue;
		}
		node.addOutput?.(`图片 ${outputIndex}`, "IMAGE");
		changed = true;
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
		changed = true;
	}
	(node.outputs || []).forEach((output, index) => {
		if (index === 0) {
			if (output.name !== "批量图片队列" || output.type !== BATCH_IMAGE_OUTPUT_TYPE) {
				changed = true;
			}
			output.name = "批量图片队列";
			output.label = output.name;
			output.localized_name = output.name;
			output.type = BATCH_IMAGE_OUTPUT_TYPE;
			output.tooltip = imageCount > MAX_OUTPUT_IMAGES
				? `已选择 ${imageCount} 张图片，单图输出最多展开 ${MAX_OUTPUT_IMAGES} 个；批量队列不限制。`
				: "将所有已选图片按顺序打包成一个 GJJ 专用批量图片队列输出。";
			return;
		}
		if (output.name !== `图片 ${index}` || output.type !== "IMAGE") {
			changed = true;
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
	if (changed) {
		markGraphChanged(node);
	}
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
	if (!hasExternalImageLink(node)) {
		state.executedImages = [];
		state.externalCount = 0;
		state.mergedCount = state.selection.length;
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
	return `${String(item?.type || "input")}\u0000${String(item?.subfolder || "")}\u0000${String(item?.filename || "")}`;
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

function replaceSelectionItem(node, index, rawItem) {
	const state = ensureState(node);
	if (index < 0 || index >= state.selection.length) {
		return false;
	}
	const item = normalizeInputImageItem(rawItem);
	if (!item.filename) {
		return false;
	}
	state.selection[index] = item;
	enrichSelectionWithOptions(state);
	syncDataWidget(node);
	ensureOutputs(node, totalImageCount(node));
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
	return true;
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
			event.dataTransfer.effectAllowed = "copyMove";
			event.dataTransfer.setData("text/plain", String(index));
			event.dataTransfer.setData(GJJ_MULTI_IMAGE_DRAG_MIME, JSON.stringify({
				filename: String(item?.filename || ""),
				subfolder: String(item?.subfolder || ""),
				type: String(item?.type || "input"),
				width: Number(item?.width || item?.preview_width || item?.w || 0),
				height: Number(item?.height || item?.preview_height || item?.h || 0),
			}));
		});
		card.addEventListener("dragend", () => {
			state.dragIndex = null;
			card.style.opacity = "1";
			card.style.outline = "none";
		});
		card.addEventListener("dragover", (event) => {
			if (draggedPromptStyleFromDropEvent(event)) {
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "copy";
				card.style.outline = "2px solid rgba(56, 189, 248, 0.95)";
				return;
			}
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
			const styleItem = draggedPromptStyleFromDropEvent(event);
			if (styleItem) {
				event.preventDefault();
				event.stopPropagation();
				card.style.outline = "none";
				void (async () => {
					setDropTargetActive(nodeRef, true, `正在替换第 ${index + 1} 张...`);
					try {
						const file = await promptStyleImageFile(styleItem);
						const [uploaded] = await uploadFilesToTemp(nodeRef, [file]);
						if (!uploaded || !replaceSelectionItem(nodeRef, index, uploaded)) {
							throw new Error("替换图片失败");
						}
						if (nodeRef.__gjjMultiImageSummary) {
							nodeRef.__gjjMultiImageSummary.textContent = `已替换第 ${index + 1} 张`;
						}
						setDropTargetActive(nodeRef, false);
					} catch (error) {
						console.warn("[GJJ_MultiImageLoader] style image replace failed", error);
						setDropTargetActive(nodeRef, true, error?.message || "替换图片失败");
						setTimeout(() => setDropTargetActive(nodeRef, false), 1300);
					}
					requestRedraw(nodeRef);
				})();
				return;
			}
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
		}
		image.onload = () => {
			item._error = false;
			card.style.opacity = "1";
			card.style.filter = "";
			if (!item.width || !item.height || sizeBadge.textContent === "原图预览") {
				sizeBadge.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
			}
			requestRedraw(nodeRef);
		};
		image.onerror = () => {
			if (!image.__gjjFullImageFallbackTried && !item.image) {
				image.__gjjFullImageFallbackTried = true;
				sizeBadge.textContent = "原图预览";
				image.src = imageDataToUrl(item, { noRand: true });
				return;
			}
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
	const slideText = state.slideOutputEnabled ? ` · 滑动 ${formatSlidingRange(state.slideOutputIndex, slideSourceCount, state.slideOutputSize, state.slideOutputLoop) || "等待图片"}` : "";
	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.title = "";
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
		if (!hasExternalImageLink(node)) {
			state.executedImages = [];
			state.externalCount = 0;
			state.mergedCount = state.selection.length;
		}
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
	if (!hasExternalImageLink(node)) {
		state.executedImages = [];
		state.externalCount = 0;
		state.mergedCount = 0;
	}
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

function setDropTargetActive(node, active, text = "") {
	const previewWrap = node?.__gjjMultiImagePreviewWrap;
	if (!previewWrap) {
		return;
	}
	previewWrap.style.borderColor = active ? "#38bdf8" : "#33434a";
	previewWrap.style.boxShadow = active
		? "0 0 0 2px rgba(56, 189, 248, 0.28), inset 0 0 0 1px rgba(56, 189, 248, 0.18)"
		: "";
	if (node.__gjjMultiImageDropHint) {
		node.__gjjMultiImageDropHint.textContent = text || "松开导入多张图片";
		node.__gjjMultiImageDropHint.style.display = active ? "flex" : "none";
	}
}

async function importDroppedFiles(node, files) {
	if (!node || !files.length) {
		return;
	}
	setDropTargetActive(node, true, "上传中...");
	try {
		const items = await uploadFilesToTemp(node, files);
		addSelectionItems(node, items);
		if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.textContent = `已拖入 ${items.length} 张`;
		}
	} catch (error) {
		console.warn("[GJJ_MultiImageLoader] drop upload failed", error);
		if (node.__gjjMultiImageSummary) {
			node.__gjjMultiImageSummary.textContent = error?.message || "拖拽导入失败";
		}
		setDropTargetActive(node, true, error?.message || "拖拽导入失败");
		setTimeout(() => setDropTargetActive(node, false), 1300);
		requestRedraw(node);
		return;
	}
	setDropTargetActive(node, false);
	requestRedraw(node);
}

function importDraggedImageRefs(node, refs) {
	if (!node || !refs.length) {
		return;
	}
	const changed = addSelectionItems(node, refs);
	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.textContent = changed
			? `已加入 ${refs.length} 张`
			: "图片已在列表中";
	}
	setDropTargetActive(node, false);
	requestRedraw(node);
}

function installDropTarget(node, elements) {
	if (!node || node.__gjjMultiImageDropInstalled) {
		return;
	}
	node.__gjjMultiImageDropInstalled = true;
	const targets = elements.filter(Boolean);
	let dragDepth = 0;
	const eventHasImages = (event) => (
		imageFilesFromDropEvent(event).length > 0
		|| Array.from(event?.dataTransfer?.items || []).some((item) => String(item?.type || "").startsWith("image/"))
		|| hasDraggedImageRefs(event)
		|| Boolean(draggedPromptStyleFromDropEvent(event))
	);
	const protect = (event) => {
		if (ensureState(node).dragIndex != null) {
			return false;
		}
		if (!eventHasImages(event)) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "copy";
		return true;
	};
	for (const target of targets) {
		target.addEventListener("dragenter", (event) => {
			if (!protect(event)) return;
			dragDepth += 1;
			setDropTargetActive(node, true);
		});
		target.addEventListener("dragover", (event) => {
			protect(event);
		});
		target.addEventListener("dragleave", (event) => {
			if (!protect(event)) return;
			dragDepth = Math.max(0, dragDepth - 1);
			if (!dragDepth) {
				setDropTargetActive(node, false);
			}
		});
		target.addEventListener("drop", (event) => {
			if (!protect(event)) return;
			dragDepth = 0;
			const styleItem = draggedPromptStyleFromDropEvent(event);
			if (styleItem) {
				void (async () => {
					try {
						const file = await promptStyleImageFile(styleItem);
						await importDroppedFiles(node, [file]);
					} catch (error) {
						console.warn("[GJJ_MultiImageLoader] style image drop failed", error);
						setDropTargetActive(node, true, error?.message || "拖入风格图片失败");
						setTimeout(() => setDropTargetActive(node, false), 1300);
					}
				})();
				return;
			}
			const refs = draggedImageRefsFromDropEvent(event);
			if (refs.length) {
				importDraggedImageRefs(node, refs);
				return;
			}
			const files = imageFilesFromDropEvent(event);
			if (!files.length) {
				setDropTargetActive(node, false);
				return;
			}
			void importDroppedFiles(node, files);
		});
	}
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
	const linkButton = makeIconButton("🔗", "断开或恢复导入图片上游连接。");
	linkButton.style.display = "none";
	const clearErrorButton = makeIconButton("🧹", "清理错误：移除当前列表里加载失败或损坏的图片。");
	const clearAllButton = makeIconButton("🗑️", "清空：清空所有已选图片，保留外部输入连接。");
	const defaultImageButton = makeIconButton("🌐", "设置默认图片：输入一条或多条 http/https 网络图片地址，下载到 ComfyUI input 后作为当前默认已选图片。");
	const rangeButton = makeIconButton("#️⃣", "序列范围：点击展开/收起设置栏。支持 [1,3,5] 和 [1:8]。");
	const outputButton = makeIconButton("🔌", `单图片输出口：默认隐藏。点击后按当前图片数量展开，最多 ${MAX_OUTPUT_IMAGES} 个。`);
	const slideButton1 = makeIconButton("1️⃣", "滑动输出 1 张：点击后自动执行并推进。");
	const slideButton2 = makeIconButton("2️⃣", "滑动输出 2 张：点击后自动执行并推进。");
	const slideButton3 = makeIconButton("3️⃣", "滑动输出 3 张：点击后自动执行并推进。");
	const slideLoopButton = makeIconButton("♻️", "循环：默认关闭；开启后滑动输出会一直循环。");
	const slideInitButton = makeIconButton("🏁", "初始化滑动输出：重置为从第 1 张开始。");
	const zoomOutButton = makeIconButton("🔎−", "缩小缩略图：减少每张预览图尺寸，节点高度会自动重算。");
	const zoomInButton = makeIconButton("🔍+", "放大缩略图：增加每张预览图尺寸，节点高度会自动重算。");
	const moreButton = makeIconButton("⏯️", "展开更多工具。");
	zoomOutButton.style.width = "36px";
	zoomInButton.style.width = "36px";

	const thumbLabel = document.createElement("span");
	thumbLabel.style.cssText = "display:none;font-size:10px;color:#8ea0a8;min-width:34px;text-align:center;user-select:none";

	refreshButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		const imported = await importLinkedUpstreamImages(node);
		if (!imported) {
			await refreshOptions(node);
		}
	});
	linkButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		toggleInputImageLink(node);
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
	defaultImageButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setDefaultNetworkImage(node);
	});
	rangeButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		state.rangeExpanded = !state.rangeExpanded;
		node.properties = node.properties || {};
		node.properties.sequence_range_expanded = state.rangeExpanded;
		syncSequenceRangeInput(node);
		reorderWidgets(node);
		rangeButton.style.background = state.rangeExpanded ? "#2b4250" : "#1a2328";
		scheduleLayout(node, true);
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
			syncSequenceRangeInput(node);
			reorderWidgets(node);
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
	slideLoopButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		state.slideOutputLoop = !state.slideOutputLoop;
		node.properties = node.properties || {};
		node.properties.slide_output_loop = state.slideOutputLoop;
		applySlidingRange(node);
		updateSlideOutputButtonsState(node);
		updateSummary(node);
		requestRedraw(node);
	});
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
		const extraTools = node.__gjjMultiImageExtraTools || [slideButton1, slideButton2, slideButton3, slideLoopButton, slideInitButton, defaultImageButton, clearErrorButton, clearAllButton, zoomOutButton, zoomInButton];
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
	toolbar.appendChild(linkButton);
	toolbar.appendChild(rangeButton);
	toolbar.appendChild(outputButton);
	toolbar.appendChild(slideButton1);
	toolbar.appendChild(slideButton2);
	toolbar.appendChild(slideButton3);
	toolbar.appendChild(slideLoopButton);
	toolbar.appendChild(slideInitButton);
	toolbar.appendChild(defaultImageButton);
	toolbar.appendChild(clearErrorButton);
	toolbar.appendChild(clearAllButton);
	toolbar.appendChild(zoomOutButton);
	toolbar.appendChild(thumbLabel);
	toolbar.appendChild(zoomInButton);
	toolbar.appendChild(moreButton);
	toolbar.appendChild(summary);

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
	empty.textContent = "点击 📁 导入图片，拖入多张图片，或连接外部 GJJ 批量图片队列";
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
	const dropHint = document.createElement("div");
	dropHint.textContent = "松开导入多张图片";
	dropHint.style.cssText = [
		"position:absolute",
		"inset:8px",
		"z-index:5",
		"display:none",
		"align-items:center",
		"justify-content:center",
		"border:1px dashed #67e8f9",
		"border-radius:8px",
		"background:rgba(8,20,24,0.78)",
		"color:#e0faff",
		"font-size:13px",
		"font-weight:700",
		"pointer-events:none",
	].join(";");
	previewWrap.appendChild(dropHint);
	container.appendChild(toolbar);
	container.appendChild(previewWrap);
	container.appendChild(fileInput);

	node.__gjjMultiImageContainer = container;
	node.__gjjMultiImageToolbar = toolbar;
	node.__gjjMultiImageLinkButton = linkButton;
	node.__gjjMultiImageExtraTools = [slideButton1, slideButton2, slideButton3, slideLoopButton, slideInitButton, defaultImageButton, clearErrorButton, clearAllButton, zoomOutButton, zoomInButton];
	node.__gjjMultiImageMoreButton = moreButton;
	node.__gjjMultiImageBrowseButton = browseButton;
	node.__gjjMultiImageOutputButton = outputButton;
	node.__gjjMultiImageSlideButtons = { 1: slideButton1, 2: slideButton2, 3: slideButton3 };
	node.__gjjMultiImageSlideLoopButton = slideLoopButton;
	node.__gjjMultiImageSlideInitButton = slideInitButton;
	node.__gjjMultiImageZoomOutButton = zoomOutButton;
	node.__gjjMultiImageZoomInButton = zoomInButton;
	node.__gjjMultiImageThumbLabel = thumbLabel;
	node.__gjjMultiImageRangeButton = rangeButton;
	node.__gjjMultiImageSummary = summary;
	node.__gjjMultiImagePreviewWrap = previewWrap;
	node.__gjjMultiImageGrid = grid;
	node.__gjjMultiImageEmpty = empty;
	node.__gjjMultiImageDropHint = dropHint;
	installDropTarget(node, [container, previewWrap, grid, empty]);
	applyThumbnailSize(node);
	updateInputLinkButtonState(node);
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
	ensureExternalImageInput(node);
	ensureDomWidget(node);
	reorderWidgets(node);
	syncSequenceRangeInput(node);
	syncSlideStartInput(node);
	reorderInputSlots(node);
	syncDataWidget(node);
	applySlidingRange(node);
	ensureOutputs(node, totalImageCount(node));
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	updateInputLinkButtonState(node);
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
	name: "Comfy.GJJ.MultiImageLoader.NetworkBatchRangeFix",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}
		for (const section of [nodeData?.input?.required, nodeData?.input?.optional]) {
			const def = section?.[SEQUENCE_RANGE_WIDGET_NAME];
			if (Array.isArray(def)) {
				def[0] = SEQUENCE_RANGE_INPUT_TYPE;
			}
			const inputImagesDef = section?.[INPUT_IMAGES_NAME];
			if (Array.isArray(inputImagesDef)) {
				inputImagesDef[0] = INPUT_IMAGES_TYPE;
				inputImagesDef[1] = {
					...(inputImagesDef[1] || {}),
					display_name: INPUT_IMAGES_LABEL,
					forceInput: true,
				};
			}
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
			persistNetworkUrls(this, networkUrlsFromProperties(this.properties || {}), { notify: false });
			state.selection = parseSelection(serializedSelectionFromNode(this, args[0]));
			state.showIndividualOutputs = Boolean(this.properties?.show_individual_outputs);
			state.slideOutputEnabled = Boolean(this.properties?.slide_output_enabled);
			state.slideOutputIndex = Math.max(1, Number.parseInt(this.properties?.slide_output_index || "1", 10) || 1);
			state.slideOutputSize = Math.max(1, Math.min(3, Number.parseInt(this.properties?.slide_output_size || "2", 10) || 2));
			state.slideOutputLoop = Boolean(this.properties?.slide_output_loop);
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
				serializedNode.properties.slide_output_loop = Boolean(ensureState(this).slideOutputLoop);
				serializedNode.properties.thumb_size = Number(ensureState(this).thumbSize || DEFAULT_THUMB_SIZE);
				serializedNode.properties.sequence_range_expanded = Boolean(ensureState(this).rangeExpanded);
				const networkUrls = persistNetworkUrls(this, networkUrlsFromProperties(this.properties || {}), { notify: false });
				serializedNode.properties.default_network_image_urls = networkUrls;
				serializedNode.properties.default_network_image_url = networkUrls.join("\n");
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
			updateInputLinkButtonState(this);
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

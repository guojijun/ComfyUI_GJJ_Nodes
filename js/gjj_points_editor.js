import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_PointsEditor"]);
const WIDTH_PROPERTY = "gjj_points_editor_width";
const HEIGHT_PROPERTY = "gjj_points_editor_height";
const SOURCE_PROPERTY = "gjj_points_editor_image_source";
const IMAGE_STORE_PROPERTY = "gjj_points_editor_image_store";
const STATE_PROPERTY = "gjj_points_editor_state";
const MORE_OUTPUTS_PROPERTY = "gjj_points_editor_more_outputs";
const MIN_NODE_WIDTH = 420;
const DEFAULT_NODE_WIDTH = 520;
const DEFAULT_NODE_HEIGHT = 360;
const TOOLBAR_HEIGHT = 34;
const NODE_FRAME_EXTRA = 10;
const HIDDEN_WIDGET_SET = new Set(["points_store", "coordinates", "neg_coordinates", "bbox_store", "image_store", "bboxes", "editor_state"]);

const OUTPUT_DEFS = [
	{ name: "前景点坐标", type: "STRING", tooltip: "前景点位坐标 JSON 文本。"},
	{ name: "背景点坐标", type: "STRING", tooltip: "背景点位坐标 JSON 文本。"},
	{ name: "框选范围信息", type: "BBOX", tooltip: "框选结果，按所选格式输出边框数组。"},
	{ name: "框选遮罩图像", type: "MASK", tooltip: "根据边框填充得到的遮罩。"},
	{ name: "首个裁切图像", type: "IMAGE", tooltip: "若接了背景图则输出第一组边框裁切图，否则输出当前背景图或空白画布。"},
];
let queuePatched = false;
let queuePatchRetryCount = 0;

function graphDirty() {
	app.graph?.setDirtyCanvas?.(true, true);
}

function compactPointsNode(node) {
	if (!node) {
		return;
	}
	HIDDEN_WIDGET_SET.forEach((name) => hideWidget(node.widgets?.find((widget) => widget?.name === name)));
	GJJ_Utils.removeHiddenInputSockets?.(node, HIDDEN_WIDGET_SET);
	GJJ_Utils.reorderWidgets?.(node, HIDDEN_WIDGET_SET);
}

function hideWidget(widget) {
	if (!widget) {
		return;
	}
	widget.__gjjPointsHidden ||= {
		type: widget.type,
		computeSize: widget.computeSize,
	};
	GJJ_Utils.hideWidget(widget);
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.serialize = true;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.hidden = true;
	widget.y = 0;
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	widget.label = "";
	widget.localized_name = "";
	widget.tooltip = "";
	if (widget.element) {
		widget.element.style.display = "none";
		widget.element.style.height = "0px";
		widget.element.style.minHeight = "0px";
		widget.element.style.margin = "0";
		widget.element.style.padding = "0";
		widget.element.style.overflow = "hidden";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
		widget.inputEl.style.height = "0px";
		widget.inputEl.style.minHeight = "0px";
		widget.inputEl.style.margin = "0";
		widget.inputEl.style.padding = "0";
	}
}

function safeParseArray(raw, fallback = []) {
	try {
		const value = JSON.parse(String(raw || "[]"));
		return Array.isArray(value) ? value : fallback;
	} catch {
		return fallback;
	}
}

function safeParseStore(raw) {
	try {
		const value = JSON.parse(String(raw || "{}"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

function safeParseState(raw) {
	try {
		const value = JSON.parse(String(raw || "{}"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

function coerceBoolean(value) {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value !== 0;
	}
	const text = String(value ?? "").trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(text)) {
		return true;
	}
	if (["false", "0", "no", "off", ""].includes(text)) {
		return false;
	}
	return Boolean(value);
}

function finitePositiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

function coerceDimension(value, fallback = 512) {
	return finitePositiveNumber(value) ?? fallback;
}

function validBboxFormat(value) {
	const text = String(value || "");
	return ["xyxy", "xywh"].includes(text) ? text : null;
}

function validNormalizeValue(value) {
	if (typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		return ["true", "false", "1", "0", "yes", "no", "on", "off", ""].includes(text) ? value : null;
	}
	return null;
}

function hasStatePayload(state) {
	return Boolean(
		state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		(
			Array.isArray(state.positive) ||
			Array.isArray(state.negative) ||
			Array.isArray(state.boxes) ||
			Array.isArray(state.coordinates) ||
			Array.isArray(state.neg_coordinates) ||
			Array.isArray(state.bboxes) ||
			(typeof state.image_store === "string" && state.image_store.length > 0) ||
			finitePositiveNumber(state.width) != null ||
			finitePositiveNumber(state.height) != null ||
			validBboxFormat(state.bbox_format) != null ||
			validNormalizeValue(state.normalize) != null
		)
	);
}

function readEditorState(node, editorStateWidget) {
	const widgetState = safeParseState(editorStateWidget?.value);
	if (hasStatePayload(widgetState)) {
		return widgetState;
	}
	const propertyState = safeParseState(node?.properties?.[STATE_PROPERTY]);
	if (hasStatePayload(propertyState)) {
		return propertyState;
	}
	return widgetState;
}

function isJsonArray(raw) {
	try {
		return Array.isArray(JSON.parse(String(raw || "[]")));
	} catch {
		return false;
	}
}

function parseBox(box) {
	if (!box || box.startX == null || box.startY == null || box.endX == null || box.endY == null) {
		return null;
	}
	const startX = Number(box.startX);
	const startY = Number(box.startY);
	const endX = Number(box.endX);
	const endY = Number(box.endY);
	if (![startX, startY, endX, endY].every(Number.isFinite)) {
		return null;
	}
	return {
		startX: Math.min(startX, endX),
		startY: Math.min(startY, endY),
		endX: Math.max(startX, endX),
		endY: Math.max(startY, endY),
	};
}

function hasPoints(points) {
	return Array.isArray(points) && points.length > 0;
}

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name) || null;
}

function setWidgetValue(widget, value, callCallback = true) {
	if (!widget) {
		return;
	}
	if (widget.value === value) {
		return;
	}
	widget.value = value;
	if (callCallback) {
		widget.callback?.(value);
	}
}

function getStoredWidth(node) {
	const stored = Number(node?.properties?.[WIDTH_PROPERTY] || 0);
	const current = Number(node?.size?.[0] || 0);
	return Math.max(MIN_NODE_WIDTH, current || stored || DEFAULT_NODE_WIDTH);
}

function getStoredHeight(node) {
	return Math.max(DEFAULT_NODE_HEIGHT, Number(node?.properties?.[HEIGHT_PROPERTY] || node?.size?.[1] || DEFAULT_NODE_HEIGHT));
}

function ensureNodeSize(node) {
	node.properties ||= {};
	node.properties[WIDTH_PROPERTY] = getStoredWidth(node);
	node.properties[HEIGHT_PROPERTY] = getStoredHeight(node);
	node.size ||= [node.properties[WIDTH_PROPERTY], node.properties[HEIGHT_PROPERTY]];
	node.size[0] = node.properties[WIDTH_PROPERTY];
	node.size[1] = node.properties[HEIGHT_PROPERTY];
	node.min_width = MIN_NODE_WIDTH;
	node.minWidth = MIN_NODE_WIDTH;
}

function persistNodeSize(node) {
	node.properties ||= {};
	node.properties[WIDTH_PROPERTY] = getStoredWidth(node);
	node.properties[HEIGHT_PROPERTY] = getStoredHeight(node);
}

function getDynamicOutputs(node) {
	return Array.isArray(node?.outputs) ? node.outputs : [];
}

function hasLinkedExtraOutputs(node) {
	return getDynamicOutputs(node).slice(1).some((output) => Array.isArray(output?.links) && output.links.length > 0);
}

function stabilizeOutputs(node) {
	if (!node) {
		return;
	}

	node.properties ||= {};
	const expanded = Boolean(node.properties[MORE_OUTPUTS_PROPERTY] || hasLinkedExtraOutputs(node));
	node.properties[MORE_OUTPUTS_PROPERTY] = expanded;
	const wanted = expanded ? OUTPUT_DEFS.length : 1;
	const outputs = getDynamicOutputs(node);

	for (let index = outputs.length - 1; index >= wanted; index -= 1) {
		const output = outputs[index];
		if (Array.isArray(output?.links) && output.links.length > 0) {
			node.properties[MORE_OUTPUTS_PROPERTY] = true;
			break;
		}
		node.removeOutput?.(index);
	}

	while (getDynamicOutputs(node).length < wanted) {
		const def = OUTPUT_DEFS[getDynamicOutputs(node).length];
		node.addOutput?.(def.name, def.type);
	}

	getDynamicOutputs(node).forEach((output, index) => {
		const def = OUTPUT_DEFS[index];
		if (!def) {
			return;
		}
		output.name = def.name;
		output.label = def.name;
		output.localized_name = def.name;
		output.type = def.type;
		output.tooltip = def.tooltip;
	});

	const moreOutputsButton = node.__gjjPointsEditor?.moreOutputsButton;
	if (moreOutputsButton) {
		const expanded = Boolean(node.properties?.[MORE_OUTPUTS_PROPERTY] || hasLinkedExtraOutputs(node));
		moreOutputsButton.disabled = expanded;
		moreOutputsButton.title = buildOutputTitle(expanded);
	}

	graphDirty();
}

function buildOutputTitle(expanded) {
	return expanded
		? "已展开更多输出口：当前会显示背景点、框选范围、遮罩和裁切图。"
		: "默认只显示前景点坐标。点击后展开更多输出口。";
}

function workflowNodeById(workflow, nodeId) {
	const idText = String(nodeId ?? "");
	const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
	return nodes.find((node) => String(node?.id ?? node?.node_id ?? "") === idText) || null;
}

function stateFromWorkflowNode(nodeInfo) {
	const properties = nodeInfo?.properties && typeof nodeInfo.properties === "object" ? nodeInfo.properties : {};
	return safeParseState(properties[STATE_PROPERTY]) || {};
}

function syncNodeToPrompt(node, output, workflow) {
	if (!node) {
		return;
	}
	const view = ensureEditor(node);
	view.writeBack?.();
	const state = view.buildEditorState?.() || {};
	const promptNode = output?.[String(node.id)];
	if (!promptNode || typeof promptNode !== "object") {
		return;
	}
	const inputs = promptNode.inputs ||= {};
	const positive = Array.isArray(state.positive) ? state.positive : [];
	const negative = Array.isArray(state.negative) ? state.negative : [];
	const boxes = Array.isArray(state.boxes) ? state.boxes : [];
	const stateText = JSON.stringify(state);
	inputs.points_store = JSON.stringify({ positive, negative }, null, 0);
	inputs.coordinates = JSON.stringify(positive);
	inputs.neg_coordinates = JSON.stringify(negative);
	inputs.bbox_store = JSON.stringify(boxes);
	inputs.bboxes = JSON.stringify(boxes);
	inputs.bbox_format = validBboxFormat(state.bbox_format) || "xyxy";
	inputs.width = coerceDimension(state.width, coerceDimension(node.widgets?.find((w) => w?.name === "width")?.value, 512));
	inputs.height = coerceDimension(state.height, coerceDimension(node.widgets?.find((w) => w?.name === "height")?.value, 512));
	inputs.normalize = coerceBoolean(state.normalize);
	inputs.image_store = String(state.image_store || "");
	inputs.editor_state = stateText;

	const workflowNode = workflowNodeById(workflow, node.id);
	if (workflowNode) {
		workflowNode.properties ||= {};
		workflowNode.properties[STATE_PROPERTY] = stateText;
		workflowNode.properties[IMAGE_STORE_PROPERTY] = String(state.image_store || "");
		workflowNode.properties[WIDTH_PROPERTY] = coerceDimension(state.width, workflowNode.properties[WIDTH_PROPERTY] || 512);
		workflowNode.properties[HEIGHT_PROPERTY] = coerceDimension(state.height, workflowNode.properties[HEIGHT_PROPERTY] || 512);
	}
}

function syncAllPointsEditorsToPrompt(output, workflow) {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			syncNodeToPrompt(node, output, workflow);
		}
	}
}

function syncAllPointsEditorsToWidgets() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			ensureEditor(node).writeBack?.();
		}
	}
}

function patchQueuePrompt() {
	if (!queuePatched && typeof api.queuePrompt === "function") {
		const original = api.queuePrompt;
		api.queuePrompt = async function (number, promptData, ...args) {
			try {
				syncAllPointsEditorsToPrompt(promptData?.output, promptData?.workflow);
			} catch (error) {
				console.warn("[GJJ] 点位编辑器提交前同步失败：", error);
			}
			return original.call(this, number, promptData, ...args);
		};
		queuePatched = true;
		return;
	}
	if (!queuePatched && queuePatchRetryCount < 30) {
		queuePatchRetryCount += 1;
		window.setTimeout(patchQueuePrompt, 500);
	}
}

function stopEvent(event) {
	event.preventDefault?.();
	event.stopPropagation?.();
	event.stopImmediatePropagation?.();
}

function splitAnnotatedPath(value) {
	const text = String(value || "").trim().replace(/\\/g, "/");
	if (!text) {
		return { filename: "", subfolder: "" };
	}
	const parts = text.split("/");
	if (parts.length <= 1) {
		return { filename: text, subfolder: "" };
	}
	return {
		filename: parts.at(-1) || "",
		subfolder: parts.slice(0, -1).join("/"),
	};
}

function buildUploadedImageUrl(rawValue) {
	const { filename, subfolder } = splitAnnotatedPath(rawValue);
	if (!filename) {
		return "";
	}
	return api.apiURL(
		`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`,
	);
}

function imageSourceSignature(src) {
	try {
		const url = new URL(src, window.location.href);
		url.searchParams.delete("rand");
		url.searchParams.delete("preview");
		return `${url.pathname}?${url.searchParams.toString()}`;
	} catch {
		return String(src || "").replace(/([?&])rand=\d+/g, "$1").replace(/[?&]$/, "");
	}
}

function getInputSourceNode(node) {
	const input = node.inputs?.find((slot) => slot?.name === "bg_image");
	if (!input?.link || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[input.link];
	const sourceId = link?.origin_id ?? link?.source_id ?? link?.from_id;
	return sourceId != null ? app.graph.getNodeById?.(sourceId) : null;
}

function buildLinkedImageUrl(node) {
	const sourceNode = getInputSourceNode(node);
	if (!sourceNode) {
		return "";
	}
	const fileWidget = sourceNode.widgets?.find((widget) => widget?.name === "image" || widget?.name === "file" || widget?.name === "filename");
	const filename = fileWidget?.value;
	if (!filename) {
		const src = sourceNode.imgs?.[0]?.src || sourceNode.image?.src || sourceNode.preview?.src;
		if (src) {
			return src;
		}
		return "";
	}
	const viewType = sourceNode.comfyClass === "LoadImageOutput" ? "output" : "input";
	return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(viewType)}&subfolder=&rand=${Date.now()}`);
}

function uploadFile(file) {
	const formData = new FormData();
	formData.append("image", file, file.name);
	formData.append("type", "input");
	formData.append("overwrite", "true");
	return fetch(api.apiURL("/upload/image"), {
		method: "POST",
		body: formData,
	});
}

async function uploadAndResolveFile(file) {
	const response = await uploadFile(file);
	if (!response.ok) {
		throw new Error(`上传失败：HTTP ${response.status}`);
	}
	const payload = await response.json().catch(() => ({}));
	const filename = payload?.name || payload?.filename || file.name;
	const subfolder = payload?.subfolder || "";
	return subfolder ? `${subfolder}/${filename}` : filename;
}

function ensureEditor(node) {
	if (node.__gjjPointsEditor) {
		return node.__gjjPointsEditor;
	}

	const coordsWidget = getWidget(node, "coordinates");
	const negCoordsWidget = getWidget(node, "neg_coordinates");
	const storeWidget = getWidget(node, "points_store");
	const bboxStoreWidget = getWidget(node, "bbox_store");
	const imageStoreWidget = getWidget(node, "image_store");
	const editorStateWidget = getWidget(node, "editor_state");
	const bboxWidget = getWidget(node, "bboxes");
	const bboxFormatWidget = getWidget(node, "bbox_format");
	const widthWidget = getWidget(node, "width");
	const heightWidget = getWidget(node, "height");
	const normalizeWidget = getWidget(node, "normalize");
	const initialState = readEditorState(node, editorStateWidget);

	const root = document.createElement("div");
	root.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"height:100%",
		"box-sizing:border-box",
		"padding:2px 0",
		"pointer-events:auto",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		root.addEventListener(eventName, (event) => event.stopPropagation());
	}

	const toolbar = document.createElement("div");
	toolbar.style.cssText = [
		"display:flex",
		"gap:6px",
		"align-items:center",
		"flex-wrap:nowrap",
		"width:100%",
		"box-sizing:border-box",
	].join(";");
	root.appendChild(toolbar);

	const buttonStyle = [
		"width:28px",
		"height:28px",
		"min-width:28px",
		"padding:0",
		"border-radius:6px",
		"border:1px solid #41535b",
		"background:#182127",
		"color:#dce7e2",
		"cursor:pointer",
		"font-size:15px",
		"line-height:1",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"flex:0 0 auto",
	].join(";");

	const loadButton = document.createElement("button");
	loadButton.textContent = "📁";
	loadButton.title = "载入图片。选择本地图片后会上传到 ComfyUI input 目录，并作为当前编辑画布。";
	loadButton.style.cssText = buttonStyle;
	toolbar.appendChild(loadButton);

	const clearButton = document.createElement("button");
	clearButton.textContent = "🗑";
	clearButton.title = "清理图片。清除当前本地载入的图片预览，但保留点位与框选数据。";
	clearButton.style.cssText = buttonStyle;
	toolbar.appendChild(clearButton);

	const newCanvasButton = document.createElement("button");
	newCanvasButton.textContent = "🆕";
	newCanvasButton.title = "新建画布。清空点位、框选和本地图片，保留当前宽高。";
	newCanvasButton.style.cssText = buttonStyle;
	toolbar.appendChild(newCanvasButton);

	const moreOutputsButton = document.createElement("button");
	moreOutputsButton.textContent = "➕";
	moreOutputsButton.title = buildOutputTitle(Boolean(node.properties?.[MORE_OUTPUTS_PROPERTY]));
	moreOutputsButton.style.cssText = buttonStyle;
	toolbar.appendChild(moreOutputsButton);

	const wrap = document.createElement("div");
	wrap.title = "左键添加前景点，右键添加背景点；按住 Ctrl 并拖拽可创建第三输出口的框选范围。";
	wrap.style.cssText = [
		"position:relative",
		"height:320px",
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #34444c",
		"border-radius:10px",
		"background:#0b1013",
		"overflow:hidden",
		"touch-action:none",
		"cursor:crosshair",
	].join(";");
	root.appendChild(wrap);

	const canvas = document.createElement("canvas");
	canvas.style.cssText = [
		"position:absolute",
		"inset:0",
		"width:100%",
		"height:100%",
		"display:block",
		"user-select:none",
	].join(";");
	wrap.appendChild(canvas);

	const image = new Image();
	image.crossOrigin = "anonymous";

	const storedPayload = safeParseStore(storeWidget?.value);
	const storedPos = Array.isArray(storedPayload.positive) ? storedPayload.positive : [];
	const storedNeg = Array.isArray(storedPayload.negative) ? storedPayload.negative : [];
	const initialPositive = Array.isArray(initialState.positive)
		? initialState.positive
		: Array.isArray(initialState.coordinates)
			? initialState.coordinates
			: safeParseArray(coordsWidget?.value, storedPos);
	const initialNegative = Array.isArray(initialState.negative)
		? initialState.negative
		: Array.isArray(initialState.neg_coordinates)
			? initialState.neg_coordinates
			: safeParseArray(negCoordsWidget?.value, storedNeg);
	const initialBoxes = Array.isArray(initialState.boxes)
		? initialState.boxes
		: Array.isArray(initialState.bboxes)
			? initialState.bboxes
			: safeParseArray(bboxWidget?.value, safeParseArray(bboxStoreWidget?.value));

	const editor = {
		root,
		canvas,
		image,
		imageLoaded: false,
		imageSource: "",
		posPoints: initialPositive,
		negPoints: initialNegative,
		boxes: initialBoxes.map(parseBox).filter(Boolean),
		currentBox: null,
		drawingBox: false,
		pendingPoint: null,
		usingDefaultPoints: false,
		loadingToken: 0,
		getModelWidth() {
			sanitizeVisibleWidgets(false);
			if (this.imageLoaded && image.naturalWidth > 0) {
				return Math.max(1, Math.round(image.naturalWidth));
			}
			return Math.max(1, Math.round(coerceDimension(widthWidget?.value, 512)));
		},
		getModelHeight() {
			sanitizeVisibleWidgets(false);
			if (this.imageLoaded && image.naturalHeight > 0) {
				return Math.max(1, Math.round(image.naturalHeight));
			}
			return Math.max(1, Math.round(coerceDimension(heightWidget?.value, 512)));
		},
		setImageSource(src) {
			if (!src || src === this.imageSource) {
				return;
			}
			this.imageSource = src;
			this.imageLoaded = false;
			image.src = src;
			scheduleDraw();
		},
		clearImage() {
			this.imageSource = "";
			this.imageLoaded = false;
			image.removeAttribute("src");
			scheduleDraw();
		},
	};

	function makeDefaultPoints() {
		const width = editor.getModelWidth();
		const height = editor.getModelHeight();
		return {
			positive: [{ x: Math.round(width / 2), y: Math.round(height / 2) }],
			negative: [{
				x: Math.max(0, Math.min(width, Math.round(width * 0.05))),
				y: Math.max(0, Math.min(height, Math.round(height * 0.05))),
			}],
		};
	}

	function setDefaultPoints() {
		const defaults = makeDefaultPoints();
		editor.posPoints = defaults.positive;
		editor.negPoints = defaults.negative;
		editor.usingDefaultPoints = true;
	}

	function sanitizeVisibleWidgets(forceImageSize = false) {
		if (node.__gjjPointsSanitizing) {
			return false;
		}
		node.__gjjPointsSanitizing = true;
		let changed = false;
		try {
			if (bboxFormatWidget && !validBboxFormat(bboxFormatWidget.value)) {
				setWidgetValue(bboxFormatWidget, "xyxy", false);
				changed = true;
			}
			const imageWidth = editor.imageLoaded && image.naturalWidth > 0 ? Math.round(image.naturalWidth) : null;
			const imageHeight = editor.imageLoaded && image.naturalHeight > 0 ? Math.round(image.naturalHeight) : null;
			const fallbackWidth = imageWidth || 512;
			const fallbackHeight = imageHeight || 512;
			const currentWidth = finitePositiveNumber(widthWidget?.value);
			const currentHeight = finitePositiveNumber(heightWidget?.value);
			if (widthWidget && (currentWidth == null || (forceImageSize && imageWidth != null && Math.round(currentWidth) !== imageWidth))) {
				setWidgetValue(widthWidget, fallbackWidth, false);
				changed = true;
			}
			if (heightWidget && (currentHeight == null || (forceImageSize && imageHeight != null && Math.round(currentHeight) !== imageHeight))) {
				setWidgetValue(heightWidget, fallbackHeight, false);
				changed = true;
			}
			if (normalizeWidget && validNormalizeValue(normalizeWidget.value) == null) {
				setWidgetValue(normalizeWidget, false, false);
				changed = true;
			}
		} finally {
			node.__gjjPointsSanitizing = false;
		}
		if (changed) {
			graphDirty();
		}
		return changed;
	}

	function repairWidgetValues(forceImageSize = false) {
		const repaired = sanitizeVisibleWidgets(forceImageSize);
		const state = readEditorState(node, editorStateWidget);
		if (normalizeWidget && validNormalizeValue(state.normalize) != null) {
			setWidgetValue(normalizeWidget, coerceBoolean(state.normalize), false);
		}
		if (editorStateWidget && !hasStatePayload(state)) {
			const builtState = buildEditorState();
			const text = JSON.stringify(builtState);
			setWidgetValue(editorStateWidget, text, false);
			node.properties ||= {};
			node.properties[STATE_PROPERTY] = text;
		}
		if (repaired) {
			scheduleDraw();
		}
		return repaired;
	}

	function buildEditorState() {
		return {
			version: 1,
			positive: editor.posPoints,
			negative: editor.negPoints,
			boxes: editor.boxes,
			image_store: String(imageStoreWidget?.value || node.properties?.[IMAGE_STORE_PROPERTY] || "").trim(),
			width: editor.getModelWidth(),
			height: editor.getModelHeight(),
			bbox_format: validBboxFormat(bboxFormatWidget?.value) || "xyxy",
			normalize: coerceBoolean(normalizeWidget?.value),
		};
	}

	for (const widget of [widthWidget, heightWidget]) {
		if (!widget || widget.__gjjPointsSizePatched) {
			continue;
		}
		widget.__gjjPointsSizePatched = true;
		const originalCallback = widget.callback;
		widget.callback = function (...args) {
			const result = originalCallback?.apply(this, args);
			if (!editor.imageLoaded) {
				if (editor.usingDefaultPoints) {
					setDefaultPoints();
				}
				syncLayout();
				scheduleDraw();
			}
			writeBack();
			return result;
		};
	}
	for (const widget of [bboxFormatWidget, normalizeWidget]) {
		if (!widget || widget.__gjjPointsValuePatched) {
			continue;
		}
		widget.__gjjPointsValuePatched = true;
		const originalCallback = widget.callback;
		widget.callback = function (...args) {
			const result = originalCallback?.apply(this, args);
			writeBack();
			return result;
		};
	}

	function getCanvasMetrics() {
		const modelWidth = editor.getModelWidth();
		const modelHeight = editor.getModelHeight();
		const displayWidth = Math.max(1, Math.round(wrap.clientWidth || root.clientWidth || getStoredWidth(node) - 18));
		const displayHeight = Math.max(1, Math.round(displayWidth * (modelHeight / Math.max(1, modelWidth))));
		return { modelWidth, modelHeight, displayWidth, displayHeight };
	}

	function syncLayout(adjustNode = true) {
		const metrics = getCanvasMetrics();
		const widgetHeight = metrics.displayHeight + TOOLBAR_HEIGHT + NODE_FRAME_EXTRA;
		wrap.style.height = `${metrics.displayHeight}px`;
		canvas.style.aspectRatio = `${metrics.modelWidth} / ${metrics.modelHeight}`;
		if (canvas.width !== metrics.modelWidth || canvas.height !== metrics.modelHeight) {
			canvas.width = metrics.modelWidth;
			canvas.height = metrics.modelHeight;
		}
		if (node.__gjjPointsEditor?.widget) {
			node.__gjjPointsEditor.widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || getStoredWidth(node))), widgetHeight];
			node.__gjjPointsEditor.widget.getHeight = () => widgetHeight;
		}
		if (adjustNode) {
			node.properties ||= {};
			const width = getStoredWidth(node);
			const computedHeight = Number(node.computeSize?.()?.[1] || 0);
			const height = Math.ceil(Math.max(widgetHeight + 88, computedHeight));
			const prevWidth = Number(node.size?.[0] || 0);
			const prevHeight = Number(node.size?.[1] || 0);
			node.properties[HEIGHT_PROPERTY] = height;
			node.size ||= [width, height];
			node.size[0] = width;
			node.size[1] = height;
			node.min_width = MIN_NODE_WIDTH;
			node.minWidth = MIN_NODE_WIDTH;
			if (Math.abs(prevWidth - width) > 0 || Math.abs(prevHeight - height) > 1) {
				try {
					node.__gjjPointsApplyingSize = true;
					node.setSize?.([width, height]);
				} finally {
					node.__gjjPointsApplyingSize = false;
				}
			}
		}
		return metrics;
	}

	function getSourceFrame() {
		const modelWidth = editor.getModelWidth();
		const modelHeight = editor.getModelHeight();
		return {
			left: 0,
			top: 0,
			width: modelWidth,
			height: modelHeight,
			modelWidth,
			modelHeight,
			viewWidth: modelWidth,
			viewHeight: modelHeight,
		};
	}

	function writeBack() {
		sanitizeVisibleWidgets(false);
		editor.boxes = editor.boxes.map(parseBox).filter(Boolean);
		const payload = { positive: editor.posPoints, negative: editor.negPoints };
		if (coordsWidget) {
			coordsWidget.value = JSON.stringify(editor.posPoints);
			coordsWidget.callback?.(coordsWidget.value);
		}
		if (negCoordsWidget) {
			negCoordsWidget.value = JSON.stringify(editor.negPoints);
			negCoordsWidget.callback?.(negCoordsWidget.value);
		}
		if (storeWidget) {
			storeWidget.value = JSON.stringify(payload);
			storeWidget.callback?.(storeWidget.value);
		}
		if (bboxStoreWidget) {
			bboxStoreWidget.value = JSON.stringify(editor.boxes);
			bboxStoreWidget.callback?.(bboxStoreWidget.value);
		}
		if (bboxWidget) {
			bboxWidget.value = JSON.stringify(editor.boxes);
			bboxWidget.callback?.(bboxWidget.value);
		}
		if (editorStateWidget) {
			const stateText = JSON.stringify(buildEditorState());
			editorStateWidget.value = stateText;
			editorStateWidget.callback?.(stateText);
			node.properties ||= {};
			node.properties[STATE_PROPERTY] = stateText;
		}
		graphDirty();
		scheduleDraw();
	}

	function syncStoredImage(rawValue) {
		const value = String(rawValue || "").trim();
		node.properties ||= {};
		node.properties[IMAGE_STORE_PROPERTY] = value;
		if (imageStoreWidget) {
			imageStoreWidget.value = value;
			imageStoreWidget.callback?.(value);
		}
	}

	function syncImageSizeFromSource() {
		const signature = imageSourceSignature(editor.imageSource);
		node.properties ||= {};
		const currentWidth = Number(widthWidget?.value);
		const currentHeight = Number(heightWidget?.value);
		const widthChanged = finitePositiveNumber(currentWidth) == null || currentWidth === 512;
		const heightChanged = finitePositiveNumber(currentHeight) == null || currentHeight === 512;
		const dimensionsMismatch = !Number.isFinite(currentWidth) || !Number.isFinite(currentHeight) || Math.abs(currentWidth - image.naturalWidth) > 1 || Math.abs(currentHeight - image.naturalHeight) > 1;
		if (signature && (node.properties[SOURCE_PROPERTY] !== signature || widthChanged || heightChanged || dimensionsMismatch)) {
			setWidgetValue(widthWidget, image.naturalWidth, false);
			setWidgetValue(heightWidget, image.naturalHeight, false);
			node.properties[SOURCE_PROPERTY] = signature;
			writeBack();
		}
	}

	function getViewport() {
		return getSourceFrame();
	}

	function toModelPoint(event) {
		const rect = canvas.getBoundingClientRect();
		const localX = event.clientX - rect.left;
		const localY = event.clientY - rect.top;
		if (
			localX < 0 ||
			localX > rect.width ||
			localY < 0 ||
			localY > rect.height
		) {
			return null;
		}
		const modelWidth = editor.getModelWidth();
		const modelHeight = editor.getModelHeight();
		return {
			x: Math.max(0, Math.min(modelWidth, Math.round(localX * (modelWidth / Math.max(1, rect.width))))),
			y: Math.max(0, Math.min(modelHeight, Math.round(localY * (modelHeight / Math.max(1, rect.height))))),
		};
	}

	function drawPoint(ctx, bounds, point, index, color, labelColor) {
		const x = bounds.left + (Number(point.x || 0) / bounds.modelWidth) * bounds.width;
		const y = bounds.top + (Number(point.y || 0) / bounds.modelHeight) * bounds.height;
		const radius = Math.max(8, Math.min(18, Math.log(Math.max(2, Math.min(bounds.modelWidth, bounds.modelHeight))) * 2.6));
		ctx.save();
		ctx.lineWidth = 3;
		ctx.strokeStyle = color;
		ctx.fillStyle = "rgba(25, 29, 31, 0.55)";
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = "#ff3b3b";
		ctx.beginPath();
		ctx.arc(x, y, 2.4, 0, Math.PI * 2);
		ctx.fill();
		ctx.font = "bold 15px sans-serif";
		ctx.textBaseline = "middle";
		ctx.lineWidth = 4;
		const offsetX = x < bounds.left + bounds.width / 2 ? radius + 6 : -radius - 18;
		const offsetY = y < bounds.top + bounds.height / 2 ? radius + 8 : -radius - 8;
		ctx.strokeStyle = "rgba(0,0,0,0.75)";
		ctx.strokeText(String(index), x + offsetX, y + offsetY);
		ctx.fillStyle = labelColor;
		ctx.fillText(String(index), x + offsetX, y + offsetY);
		ctx.restore();
	}

	function drawBox(ctx, bounds, box, color) {
		const normalized = parseBox(box);
		if (!normalized) {
			return;
		}
		const x1 = bounds.left + (normalized.startX / bounds.modelWidth) * bounds.width;
		const y1 = bounds.top + (normalized.startY / bounds.modelHeight) * bounds.height;
		const x2 = bounds.left + (normalized.endX / bounds.modelWidth) * bounds.width;
		const y2 = bounds.top + (normalized.endY / bounds.modelHeight) * bounds.height;
		ctx.save();
		ctx.fillStyle = "rgba(56, 200, 255, 0.18)";
		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
		ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
		ctx.restore();
	}

	function draw() {
		const metrics = syncLayout(false);
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, metrics.modelWidth, metrics.modelHeight);
		ctx.fillStyle = "#0f1519";
		ctx.fillRect(0, 0, metrics.modelWidth, metrics.modelHeight);
		const bounds = getViewport();
		if (editor.imageLoaded) {
			ctx.drawImage(image, bounds.left, bounds.top, bounds.width, bounds.height);
		} else {
			ctx.fillStyle = "#111b20";
			ctx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
			ctx.strokeStyle = "#34444c";
			ctx.lineWidth = 1;
			ctx.strokeRect(bounds.left + 0.5, bounds.top + 0.5, bounds.width - 1, bounds.height - 1);
		}
		editor.boxes.forEach((box) => drawBox(ctx, bounds, box, "#38c8ff"));
		if (editor.currentBox) {
			drawBox(ctx, bounds, editor.currentBox, "#79dcff");
		}
		editor.posPoints.forEach((point, index) => drawPoint(ctx, bounds, point, index, "#08cc48", "#2cff68"));
		editor.negPoints.forEach((point, index) => drawPoint(ctx, bounds, point, index, "#e03b3b", "#ff6d6d"));
	}

	let drawHandle = 0;
	function scheduleDraw() {
		window.cancelAnimationFrame(drawHandle);
		drawHandle = window.requestAnimationFrame(draw);
	}

	function syncFromWidgets() {
		sanitizeVisibleWidgets(false);
		const store = safeParseStore(storeWidget?.value);
		const state = readEditorState(node, editorStateWidget);
		const positiveSource = Array.isArray(state.positive)
			? state.positive
			: Array.isArray(state.coordinates)
				? state.coordinates
				: safeParseArray(coordsWidget?.value, Array.isArray(store.positive) ? store.positive : []);
		const negativeSource = Array.isArray(state.negative)
			? state.negative
			: Array.isArray(state.neg_coordinates)
				? state.neg_coordinates
				: safeParseArray(negCoordsWidget?.value, Array.isArray(store.negative) ? store.negative : []);
		const boxesSource = Array.isArray(state.boxes)
			? state.boxes
			: Array.isArray(state.bboxes)
				? state.bboxes
				: safeParseArray(bboxWidget?.value, safeParseArray(bboxStoreWidget?.value));
		editor.posPoints = positiveSource;
		editor.negPoints = negativeSource;
		editor.boxes = boxesSource.map(parseBox).filter(Boolean);
		if (!hasPoints(editor.posPoints) && !hasPoints(editor.negPoints)) {
			setDefaultPoints();
		} else {
			editor.usingDefaultPoints = false;
		}
		if (state.image_store != null) {
			syncStoredImage(String(state.image_store || ""));
		}
		const stateBboxFormat = validBboxFormat(state.bbox_format);
		if (stateBboxFormat) {
			setWidgetValue(bboxFormatWidget, stateBboxFormat, false);
		}
		const stateWidth = finitePositiveNumber(state.width);
		if (stateWidth != null) {
			setWidgetValue(widthWidget, stateWidth, false);
		}
		const stateHeight = finitePositiveNumber(state.height);
		if (stateHeight != null) {
			setWidgetValue(heightWidget, stateHeight, false);
		}
		if (normalizeWidget && validNormalizeValue(state.normalize) != null) {
			setWidgetValue(normalizeWidget, coerceBoolean(state.normalize), false);
		}
		repairWidgetValues();
		scheduleDraw();
	}

	function loadCurrentPreview() {
		const linkedUrl = buildLinkedImageUrl(node);
		if (linkedUrl) {
			editor.setImageSource(linkedUrl);
			return;
		}
		const storedValue = String(imageStoreWidget?.value || node.properties?.[IMAGE_STORE_PROPERTY] || "").trim();
		if (storedValue) {
			editor.setImageSource(buildUploadedImageUrl(storedValue));
			return;
		}
		editor.clearImage();
	}

	async function loadLocalImageFromButton() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.style.display = "none";
		document.body.appendChild(input);
		input.addEventListener("change", async () => {
			const file = input.files?.[0];
			input.remove();
			if (!file) {
				return;
			}
			const objectUrl = URL.createObjectURL(file);
			editor.setImageSource(objectUrl);
			try {
				const storedValue = await uploadAndResolveFile(file);
				syncStoredImage(storedValue);
				writeBack();
				editor.setImageSource(buildUploadedImageUrl(storedValue));
			} catch (error) {
				console.warn("[GJJ] 载入图片失败：", error);
			} finally {
				window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
			}
		}, { once: true });
		input.click();
	}

	function clearLocalImage() {
		syncStoredImage("");
		editor.clearImage();
		writeBack();
		loadCurrentPreview();
		scheduleDraw();
	}

	function newCanvas() {
		syncStoredImage("");
		setDefaultPoints();
		editor.boxes = [];
		editor.currentBox = null;
		writeBack();
		loadCurrentPreview();
	}

	function revealMoreOutputs() {
		node.properties ||= {};
		node.properties[MORE_OUTPUTS_PROPERTY] = true;
		stabilizeOutputs(node);
		moreOutputsButton.disabled = true;
		moreOutputsButton.title = buildOutputTitle(true);
	}

	loadButton.onclick = loadLocalImageFromButton;
	clearButton.onclick = clearLocalImage;
	newCanvasButton.onclick = newCanvas;
	moreOutputsButton.onclick = revealMoreOutputs;

	wrap.addEventListener("contextmenu", stopEvent);
	function startBox(point) {
		editor.pendingPoint = null;
		editor.drawingBox = true;
		editor.currentBox = { startX: point.x, startY: point.y, endX: point.x, endY: point.y };
		scheduleDraw();
	}

	wrap.addEventListener("pointerdown", (event) => {
		stopEvent(event);
		wrap.setPointerCapture?.(event.pointerId);
		const point = toModelPoint(event);
		if (!point) {
			return;
		}
		if (event.ctrlKey) {
			startBox(point);
			return;
		}
		if (event.button === 2) {
			editor.usingDefaultPoints = false;
			editor.negPoints.push(point);
			writeBack();
			return;
		}
		editor.pendingPoint = {
			point,
			clientX: event.clientX,
			clientY: event.clientY,
			pointerId: event.pointerId,
		};
	});

	wrap.addEventListener("pointermove", (event) => {
		if (editor.pendingPoint && event.pointerId === editor.pendingPoint.pointerId) {
			const moved = Math.hypot(event.clientX - editor.pendingPoint.clientX, event.clientY - editor.pendingPoint.clientY);
			if (moved >= 6) {
				stopEvent(event);
				startBox(editor.pendingPoint.point);
			}
		}
		if (!editor.drawingBox || !editor.currentBox) {
			return;
		}
		stopEvent(event);
		const point = toModelPoint(event);
		if (!point) {
			return;
		}
		editor.currentBox.endX = point.x;
		editor.currentBox.endY = point.y;
		scheduleDraw();
	});

	function finishPointer(event) {
		if (editor.pendingPoint && event.pointerId === editor.pendingPoint.pointerId) {
			stopEvent(event);
			editor.usingDefaultPoints = false;
			editor.posPoints.push(editor.pendingPoint.point);
			editor.pendingPoint = null;
			writeBack();
			return;
		}
		if (!editor.drawingBox || !editor.currentBox) {
			return;
		}
		stopEvent(event);
		const point = toModelPoint(event);
		if (point) {
			editor.currentBox.endX = point.x;
			editor.currentBox.endY = point.y;
		}
		const box = parseBox(editor.currentBox);
		if (box && Math.abs(box.endX - box.startX) > 0 && Math.abs(box.endY - box.startY) > 0) {
			editor.boxes.push(box);
		}
		editor.currentBox = null;
		editor.drawingBox = false;
		try {
			if (event?.pointerId != null) {
				wrap.releasePointerCapture?.(event.pointerId);
			}
		} catch {
			// Pointer capture may already be released by the browser.
		}
		writeBack();
	}

	wrap.addEventListener("pointerup", finishPointer);
	wrap.addEventListener("pointercancel", finishPointer);
	canvas.addEventListener("pointerup", finishPointer);
	canvas.addEventListener("pointercancel", finishPointer);
	window.addEventListener("pointerup", finishPointer);

	image.onload = () => {
		editor.imageLoaded = true;
		repairWidgetValues(true);
		syncImageSizeFromSource();
		if (editor.usingDefaultPoints) {
			setDefaultPoints();
			writeBack();
		}
		syncLayout();
		scheduleDraw();
	};
	image.onerror = () => {
		editor.imageLoaded = false;
		syncLayout();
		scheduleDraw();
	};

	const widget = node.addDOMWidget("gjj_points_editor", "gjj_points_editor", root, {
		hideOnZoom: false,
		getHeight: () => getStoredHeight(node),
		getMinHeight: () => DEFAULT_NODE_HEIGHT,
		getMaxHeight: () => getStoredHeight(node),
	});
	widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || getStoredWidth(node))), getStoredHeight(node)];

	node.__gjjPointsEditor = {
		widget,
		editor,
		draw: scheduleDraw,
		syncFromWidgets,
		loadCurrentPreview,
		revealMoreOutputs,
		moreOutputsButton,
		repairWidgetValues,
		writeBack,
		buildEditorState,
		syncLayout: () => syncLayout(true),
	};

	syncFromWidgets();
	repairWidgetValues();
	writeBack();
	loadCurrentPreview();
	syncLayout();
	stabilizeOutputs(node);
	return node.__gjjPointsEditor;
}

function patchNode(node) {
	if (!node || node.__gjjPointsPatched) {
		return;
	}
	node.__gjjPointsPatched = true;
	node.properties ||= {};
	if (!node.properties[WIDTH_PROPERTY]) {
		node.properties[WIDTH_PROPERTY] = Math.max(MIN_NODE_WIDTH, DEFAULT_NODE_WIDTH, Number(node.size?.[0] || 0));
	}
	if (!node.properties[HEIGHT_PROPERTY]) {
		node.properties[HEIGHT_PROPERTY] = Math.max(DEFAULT_NODE_HEIGHT, Number(node.size?.[1] || 0));
	}
	compactPointsNode(node);
	ensureEditor(node);
	compactPointsNode(node);
	ensureNodeSize(node);
	stabilizeOutputs(node);
	graphDirty();
}

function afterNodeReady(node) {
	patchNode(node);
	const view = ensureEditor(node);
	compactPointsNode(node);
	view.syncFromWidgets();
	view.repairWidgetValues?.(true);
	view.loadCurrentPreview();
	view.syncLayout?.();
	stabilizeOutputs(node);
	for (const delay of [0, 120, 450, 1000, 2000]) {
		window.setTimeout(() => {
			const delayedView = ensureEditor(node);
			compactPointsNode(node);
			delayedView.repairWidgetValues?.(true);
			delayedView.syncLayout?.();
			delayedView.draw?.();
		}, delay);
	}
}

app.registerExtension({
	name: "GJJ.PointsEditor",
	beforeQueuePrompt() {
		syncAllPointsEditorsToWidgets();
	},
	beforeQueued() {
		syncAllPointsEditorsToWidgets();
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			afterNodeReady(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			ensureNodeSize(this);
			afterNodeReady(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			if (message?.bg_image?.[0]) {
				ensureEditor(this).editor.setImageSource(`data:image/png;base64,${message.bg_image[0]}`);
			}
			ensureEditor(this).draw();
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			window.setTimeout(() => {
				ensureEditor(this).loadCurrentPreview();
				stabilizeOutputs(this);
			}, 0);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (this.__gjjPointsApplyingSize) {
				return result;
			}
			this.properties ||= {};
			this.properties[WIDTH_PROPERTY] = Math.max(MIN_NODE_WIDTH, Number(this.size?.[0] || 0));
			const view = ensureEditor(this);
			try {
				this.__gjjPointsApplyingSize = true;
				view.syncLayout?.();
			} finally {
				this.__gjjPointsApplyingSize = false;
			}
			view.draw();
			return result;
		};

	const originalOnSerialize = nodeType.prototype.onSerialize;
	nodeType.prototype.onSerialize = function (data) {
		const result = originalOnSerialize?.apply(this, arguments);
		ensureEditor(this).writeBack?.();
		persistNodeSize(this);
		if (data) {
			data.properties ||= {};
			data.properties[WIDTH_PROPERTY] = this.properties?.[WIDTH_PROPERTY];
			data.properties[HEIGHT_PROPERTY] = this.properties?.[HEIGHT_PROPERTY];
			data.properties[MORE_OUTPUTS_PROPERTY] = this.properties?.[MORE_OUTPUTS_PROPERTY] || false;
			data.properties[IMAGE_STORE_PROPERTY] = this.properties?.[IMAGE_STORE_PROPERTY] || "";
			data.properties[STATE_PROPERTY] = this.properties?.[STATE_PROPERTY] || "";
		}
		return result;
	};
	},
	setup() {
		patchQueuePrompt();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node.comfyClass || node.type || ""))) {
				afterNodeReady(node);
			}
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_SAM2PointMaskEditor"]);
const WIDTH_PROPERTY = "gjj_sam2_mask_editor_width";
const HEIGHT_PROPERTY = "gjj_sam2_mask_editor_height";
const SOURCE_PROPERTY = "gjj_sam2_mask_editor_source";
const IMAGE_STORE_PROPERTY = "gjj_sam2_mask_editor_image_store";
const STATE_PROPERTY = "gjj_sam2_mask_editor_state";
const MIN_NODE_WIDTH = 420;
const DEFAULT_NODE_WIDTH = 520;
const DEFAULT_NODE_HEIGHT = 360;
const TOOLBAR_HEIGHT = 34;
const STATUS_HEIGHT = 24;
const NODE_FRAME_EXTRA = 12;
const HIDDEN_WIDGETS = new Set(["coordinates", "neg_coordinates", "bboxes", "editor_state", "image_store"]);
const SERIALIZED_WIDGETS = [
	"sam2_model",
	"segmentor",
	"device",
	"precision",
	"expand",
	"tapered_corners",
	"block_size",
	"color",
	"keep_model_loaded",
	"coordinates",
	"neg_coordinates",
	"bboxes",
	"editor_state",
	"image_store",
];
const SEGMENTOR_VALUES = new Set(["video", "single_image"]);
const DEVICE_VALUES = new Set(["auto", "cuda", "cpu", "mps"]);
const PRECISION_VALUES = new Set(["fp16", "bf16", "fp32"]);
const DEFAULT_WIDGET_VALUES = {
	sam2_model: "sam2_hiera_base_plus.safetensors",
	segmentor: "video",
	device: "auto",
	precision: "fp16",
	expand: 10,
	tapered_corners: true,
	block_size: 32,
	color: "0, 0, 0",
	keep_model_loaded: true,
	coordinates: "[]",
	neg_coordinates: "[]",
	bboxes: "[]",
	editor_state: "{}",
	image_store: "",
};
const OUTPUT_DEFS = [
	{ name: "遮罩队列", type: "MASK", tooltip: "输出单张遮罩或按输入帧数排列的遮罩队列。" },
	{ name: "遮罩覆盖图像队列", type: "GJJ_BATCH_IMAGE,IMAGE", tooltip: "输出被遮罩颜色覆盖后的图片或图片队列。" },
];

let queuePatched = false;

function graphDirty() {
	app.graph?.setDirtyCanvas?.(true, true);
}

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name) || null;
}

function stringValue(value) {
	return String(value ?? "").trim();
}

function boolValue(value, fallback = false) {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value !== 0;
	}
	const text = stringValue(value).toLowerCase();
	if (["true", "1", "yes", "on"].includes(text)) {
		return true;
	}
	if (["false", "0", "no", "off", ""].includes(text)) {
		return false;
	}
	return fallback;
}

function intValue(value, fallback) {
	if (typeof value === "boolean") {
		return fallback;
	}
	const text = stringValue(value);
	if (!/^-?\d+$/.test(text)) {
		return fallback;
	}
	const numeric = Number.parseInt(text, 10);
	return Number.isFinite(numeric) ? numeric : fallback;
}

function isBoolLike(value) {
	if (typeof value === "boolean") {
		return true;
	}
	const text = stringValue(value).toLowerCase();
	return ["true", "false", "yes", "no", "on", "off"].includes(text);
}

function isIntLike(value) {
	return typeof value !== "boolean" && /^-?\d+$/.test(stringValue(value));
}

function isColorLike(value) {
	const text = stringValue(value);
	return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(text) || /^-?\d+\s*,\s*-?\d+\s*,\s*-?\d+(\s*,\s*-?\d+)?$/.test(text);
}

function modelOptions(node) {
	const values = getWidget(node, "sam2_model")?.options?.values;
	return Array.isArray(values) ? values.map((value) => String(value)) : [];
}

function isModelValue(value, node) {
	const text = stringValue(value);
	if (!text) {
		return false;
	}
	const options = modelOptions(node);
	return options.includes(text) || /\.(safetensors|pt|pth|ckpt|bin)$/i.test(text) || /^sam2(\.|_|-)?/i.test(text);
}

function findValueIndex(values, predicate, start = 0) {
	for (let index = Math.max(0, start); index < values.length; index += 1) {
		if (predicate(values[index], index)) {
			return index;
		}
	}
	return -1;
}

function fallbackWidgetValue(name, node) {
	if (name === "sam2_model") {
		return modelOptions(node)[0] || DEFAULT_WIDGET_VALUES.sam2_model;
	}
	if (name === "editor_state") {
		return stringValue(node?.properties?.[STATE_PROPERTY] || DEFAULT_WIDGET_VALUES.editor_state);
	}
	if (name === "image_store") {
		return stringValue(node?.properties?.[IMAGE_STORE_PROPERTY] || DEFAULT_WIDGET_VALUES.image_store);
	}
	return DEFAULT_WIDGET_VALUES[name];
}

function validJsonString(value, fallback) {
	const text = stringValue(value);
	if (!text) {
		return fallback;
	}
	try {
		JSON.parse(text);
		return text;
	} catch {
		return fallback;
	}
}

function semanticWidgetValues(values, node) {
	const rawValues = Array.isArray(values) ? values.slice() : [];
	const modelIndex = findValueIndex(rawValues, (value) => isModelValue(value, node));
	const segmentorIndex = findValueIndex(rawValues, (value) => SEGMENTOR_VALUES.has(stringValue(value)), modelIndex >= 0 ? modelIndex + 1 : 0);
	const deviceIndex = findValueIndex(rawValues, (value) => DEVICE_VALUES.has(stringValue(value)), segmentorIndex >= 0 ? segmentorIndex + 1 : 0);
	const precisionIndex = findValueIndex(rawValues, (value) => PRECISION_VALUES.has(stringValue(value)), deviceIndex >= 0 ? deviceIndex + 1 : 0);
	const tailStart = Math.max(modelIndex, segmentorIndex, deviceIndex, precisionIndex, 3) + 1;

	const expandIndex = findValueIndex(rawValues, isIntLike, tailStart);
	const blockSizeIndex = findValueIndex(rawValues, isIntLike, expandIndex >= 0 ? expandIndex + 1 : tailStart);
	const taperedIndex = findValueIndex(rawValues, isBoolLike, tailStart);
	const keepModelIndex = findValueIndex(rawValues, isBoolLike, taperedIndex >= 0 ? taperedIndex + 1 : tailStart);
	const colorIndex = findValueIndex(rawValues, isColorLike, blockSizeIndex >= 0 ? blockSizeIndex + 1 : tailStart);

	const currentState = getWidget(node, "editor_state")?.value || node?.properties?.[STATE_PROPERTY];
	const currentStore = getWidget(node, "image_store")?.value || node?.properties?.[IMAGE_STORE_PROPERTY];

	return [
		modelIndex >= 0 ? stringValue(rawValues[modelIndex]) : fallbackWidgetValue("sam2_model", node),
		segmentorIndex >= 0 ? stringValue(rawValues[segmentorIndex]) : fallbackWidgetValue("segmentor", node),
		deviceIndex >= 0 ? stringValue(rawValues[deviceIndex]) : fallbackWidgetValue("device", node),
		precisionIndex >= 0 ? stringValue(rawValues[precisionIndex]) : fallbackWidgetValue("precision", node),
		intValue(expandIndex >= 0 ? rawValues[expandIndex] : undefined, fallbackWidgetValue("expand", node)),
		boolValue(taperedIndex >= 0 ? rawValues[taperedIndex] : undefined, fallbackWidgetValue("tapered_corners", node)),
		intValue(blockSizeIndex >= 0 ? rawValues[blockSizeIndex] : undefined, fallbackWidgetValue("block_size", node)),
		colorIndex >= 0 ? stringValue(rawValues[colorIndex]) : fallbackWidgetValue("color", node),
		boolValue(keepModelIndex >= 0 ? rawValues[keepModelIndex] : undefined, fallbackWidgetValue("keep_model_loaded", node)),
		validJsonString(getWidget(node, "coordinates")?.value, fallbackWidgetValue("coordinates", node)),
		validJsonString(getWidget(node, "neg_coordinates")?.value, fallbackWidgetValue("neg_coordinates", node)),
		validJsonString(getWidget(node, "bboxes")?.value, fallbackWidgetValue("bboxes", node)),
		validJsonString(currentState, fallbackWidgetValue("editor_state", node)),
		stringValue(currentStore || fallbackWidgetValue("image_store", node)),
	];
}

function currentSerializableValues(node) {
	return SERIALIZED_WIDGETS.map((name) => getWidget(node, name)?.value);
}

function sameWidgetValues(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
}

function applySerializableValues(node, values) {
	SERIALIZED_WIDGETS.forEach((name, index) => {
		const widget = getWidget(node, name);
		if (!widget) {
			return;
		}
		setWidgetValue(widget, values[index], false);
	});
}

function repairLiveWidgetValues(node, sourceValues = null) {
	const current = currentSerializableValues(node);
	const values = Array.isArray(sourceValues) && sourceValues.length ? sourceValues : current;
	const fixed = semanticWidgetValues(values, node);
	if (sameWidgetValues(current, fixed)) {
		return false;
	}
	applySerializableValues(node, fixed);
	node.widgets_values = fixed.slice();
	graphDirty();
	return true;
}

function sanitizeSerializedNodeWidgets(serializedNode, node = null) {
	if (!serializedNode || !Array.isArray(serializedNode.widgets_values)) {
		return false;
	}
	const fixed = semanticWidgetValues(serializedNode.widgets_values, node);
	const changed = !sameWidgetValues(serializedNode.widgets_values, fixed);
	if (changed) {
		serializedNode.widgets_values = fixed;
	}
	return changed;
}

function writeSerializedWidgetValues(node, serializedNode) {
	if (!serializedNode) {
		return;
	}
	const fixed = semanticWidgetValues(currentSerializableValues(node), node);
	serializedNode.widgets_values = fixed;
	node.widgets_values = fixed.slice();
}

function hideWidget(widget) {
	if (!widget) {
		return;
	}
	GJJ_Utils.hideWidget(widget);
	widget.serialize = true;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.hidden = true;
	widget.y = 0;
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	widget.label = "";
	widget.localized_name = "";
	widget.tooltip = "";
}

function compactNode(node) {
	HIDDEN_WIDGETS.forEach((name) => hideWidget(getWidget(node, name)));
	GJJ_Utils.removeHiddenInputSockets?.(node, HIDDEN_WIDGETS);
	GJJ_Utils.reorderWidgets?.(node, HIDDEN_WIDGETS);
}

function safeParse(raw, fallback) {
	try {
		const value = JSON.parse(String(raw || ""));
		return value == null ? fallback : value;
	} catch {
		return fallback;
	}
}

function safeArray(raw) {
	const value = safeParse(raw, []);
	return Array.isArray(value) ? value : [];
}

function safeState(raw) {
	const value = safeParse(raw, {});
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function normalizeOutputs(node) {
	const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
	while (outputs.length < OUTPUT_DEFS.length) {
		const def = OUTPUT_DEFS[outputs.length];
		node.addOutput?.(def.name, def.type);
	}
	(Array.isArray(node?.outputs) ? node.outputs : []).slice(0, OUTPUT_DEFS.length).forEach((output, index) => {
		const def = OUTPUT_DEFS[index];
		output.name = def.name;
		output.label = def.name;
		output.localized_name = def.name;
		output.type = def.type;
		output.tooltip = def.tooltip;
	});
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
	return { filename: parts.at(-1) || "", subfolder: parts.slice(0, -1).join("/") };
}

function buildUploadedImageUrl(rawValue) {
	const { filename, subfolder } = splitAnnotatedPath(rawValue);
	if (!filename) {
		return "";
	}
	return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`);
}

function imageSourceSignature(src) {
	try {
		const url = new URL(src, window.location.href);
		url.searchParams.delete("rand");
		return `${url.pathname}?${url.searchParams.toString()}`;
	} catch {
		return String(src || "").replace(/([?&])rand=\d+/g, "$1").replace(/[?&]$/, "");
	}
}

function sourceNodeFromLinkId(linkId) {
	if (!linkId || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	const sourceId = link?.origin_id ?? link?.source_id ?? link?.from_id;
	return sourceId != null ? app.graph.getNodeById?.(sourceId) : null;
}

function getInputSourceNode(node, inputName = "image") {
	const input = node.inputs?.find((slot) => slot?.name === inputName);
	return input?.link ? sourceNodeFromLinkId(input.link) : null;
}

function linkedSourceNodes(node) {
	const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
	const priority = (input) => /image|img|video|mask|ref|reference|pixel|latent|图|视频|遮罩|参考/i.test(String(input?.name || "")) ? 0 : 1;
	return inputs
		.filter((input) => input?.link)
		.slice()
		.sort((left, right) => priority(left) - priority(right))
		.map((input) => sourceNodeFromLinkId(input.link))
		.filter(Boolean);
}

function buildWidgetImageUrl(sourceNode) {
	if (!sourceNode) {
		return "";
	}
	const widgets = Array.isArray(sourceNode.widgets) ? sourceNode.widgets : [];
	const fileWidget = widgets.find((widget) => {
		const name = String(widget?.name || "").toLowerCase();
		const value = stringValue(widget?.value);
		return (
			["image", "file", "filename", "reference_image", "input_image"].includes(name) ||
			(/image|img|file|filename|ref|reference|图|文件|参考/.test(name) && /\.(png|jpe?g|webp|bmp)$/i.test(value)) ||
			/\.(png|jpe?g|webp|bmp)$/i.test(value)
		);
	});
	const filename = stringValue(fileWidget?.value);
	if (!filename) {
		return "";
	}
	const { filename: baseName, subfolder } = splitAnnotatedPath(filename);
	if (!baseName) {
		return "";
	}
	const viewType = sourceNode.comfyClass === "LoadImageOutput" ? "output" : "input";
	return api.apiURL(`/view?filename=${encodeURIComponent(baseName)}&type=${encodeURIComponent(viewType)}&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`);
}

function buildPreviewImageUrl(sourceNode) {
	if (!sourceNode) {
		return "";
	}
	const imageElements = [
		...(Array.isArray(sourceNode.imgs) ? sourceNode.imgs : []),
		sourceNode.image,
		sourceNode.preview,
	];
	for (const item of imageElements) {
		const src = item?.src || item?.currentSrc || "";
		if (src) {
			return src;
		}
	}
	for (const widget of sourceNode.widgets || []) {
		const element = widget?.element;
		const image = element?.querySelector?.("img");
		if (image?.src) {
			return image.src;
		}
		const video = element?.querySelector?.("video");
		if (video?.poster) {
			return video.poster;
		}
	}
	return "";
}

function buildNodeImageUrl(sourceNode) {
	return buildWidgetImageUrl(sourceNode) || buildPreviewImageUrl(sourceNode);
}

function buildLinkedImageUrl(node) {
	const firstSource = getInputSourceNode(node);
	if (!firstSource) {
		return "";
	}
	const queue = [firstSource];
	const visited = new Set();
	let depthGuard = 0;
	while (queue.length && depthGuard < 80) {
		depthGuard += 1;
		const current = queue.shift();
		const id = String(current?.id ?? "");
		if (!current || visited.has(id)) {
			continue;
		}
		visited.add(id);
		const url = buildNodeImageUrl(current);
		if (url) {
			return url;
		}
		for (const upstream of linkedSourceNodes(current)) {
			if (!visited.has(String(upstream?.id ?? ""))) {
				queue.push(upstream);
			}
		}
	}
	return "";
}

function uploadFile(file) {
	const formData = new FormData();
	formData.append("image", file, file.name);
	formData.append("type", "input");
	formData.append("overwrite", "true");
	return fetch(api.apiURL("/upload/image"), { method: "POST", body: formData });
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

function stopEvent(event) {
	event.preventDefault?.();
	event.stopPropagation?.();
	event.stopImmediatePropagation?.();
}

function ensureEditor(node) {
	if (node.__gjjSAM2MaskEditor) {
		return node.__gjjSAM2MaskEditor;
	}

	const coordsWidget = getWidget(node, "coordinates");
	const negCoordsWidget = getWidget(node, "neg_coordinates");
	const boxesWidget = getWidget(node, "bboxes");
	const stateWidget = getWidget(node, "editor_state");
	const imageStoreWidget = getWidget(node, "image_store");
	const initialState = safeState(stateWidget?.value || node.properties?.[STATE_PROPERTY]);

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
		"width:60px",
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
	loadButton.textContent = "📁载入";
	loadButton.title = "载入图片。选择本地图片后会上传到 ComfyUI input 目录，并作为当前编辑画布。";
	loadButton.style.cssText = buttonStyle;
	toolbar.appendChild(loadButton);

	const upstreamButton = document.createElement("button");
	upstreamButton.textContent = "⬆️获取";
	upstreamButton.title = "获取上游图片。连接“输入图片/视频”后，点击从上游节点刷新当前编辑画布。";
	upstreamButton.style.cssText = buttonStyle;
	toolbar.appendChild(upstreamButton);

	const clearButton = document.createElement("button");
	clearButton.textContent = "🗑️删除";
	clearButton.title = "清理图片。清除当前本地载入的图片预览，但保留点位与框选数据。";
	clearButton.style.cssText = buttonStyle;
	toolbar.appendChild(clearButton);

	const newCanvasButton = document.createElement("button");
	newCanvasButton.textContent = "☸️新层";
	newCanvasButton.title = "新建画布。重置为中心正点、左上负点，并清空框选。";
	newCanvasButton.style.cssText = buttonStyle;
	toolbar.appendChild(newCanvasButton);

	const wrap = document.createElement("div");
	wrap.title = "已有点位可直接左键拖动；右键点位可删除；左键空白处添加正向点，右键空白处添加负向点，Ctrl+拖拽可创建框选范围。";
	wrap.style.cssText = [
		"position:relative",
		"height:300px",
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #34444c",
		"border-radius:8px",
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

	const status = document.createElement("div");
	status.textContent = "等待执行";
	status.style.cssText = [
		"height:20px",
		"line-height:20px",
		"font:700 11px sans-serif",
		"color:#cfe7df",
		"background:#10191e",
		"border:1px solid #2d3d45",
		"border-radius:5px",
		"padding:0 7px",
		"overflow:hidden",
		"text-overflow:ellipsis",
		"white-space:nowrap",
	].join(";");
	root.appendChild(status);

	const image = new Image();
	image.crossOrigin = "anonymous";
	const initialPositive = Array.isArray(initialState.positive)
		? initialState.positive
		: Array.isArray(initialState.coordinates)
			? initialState.coordinates
			: safeArray(coordsWidget?.value);
	const initialNegative = Array.isArray(initialState.negative)
		? initialState.negative
		: Array.isArray(initialState.neg_coordinates)
			? initialState.neg_coordinates
			: safeArray(negCoordsWidget?.value);
	const initialBoxes = Array.isArray(initialState.boxes)
		? initialState.boxes
		: Array.isArray(initialState.bboxes)
			? initialState.bboxes
			: safeArray(boxesWidget?.value);

	const editor = {
		imageLoaded: false,
		imageSource: "",
		modelWidth: Number(initialState.width || 512) || 512,
		modelHeight: Number(initialState.height || 512) || 512,
		posPoints: initialPositive,
		negPoints: initialNegative,
		boxes: initialBoxes.map(parseBox).filter(Boolean),
		currentBox: null,
		drawingBox: false,
		pendingPoint: null,
		dragPoint: null,
		activePoint: null,
		usingDefaultPoints: false,
		pendingLoadStatus: "",
		setImageSource(src, force = false, loadStatus = "") {
			if (!src || (!force && src === this.imageSource)) {
				return;
			}
			if (force && src === this.imageSource) {
				image.removeAttribute("src");
			}
			this.imageSource = src;
			this.imageLoaded = false;
			this.pendingLoadStatus = loadStatus;
			image.src = src;
			scheduleDraw();
		},
		clearImage() {
			this.imageSource = "";
			this.imageLoaded = false;
			this.pendingLoadStatus = "";
			image.removeAttribute("src");
			scheduleDraw();
		},
	};

	function getModelWidth() {
		return Math.max(1, Math.round(editor.modelWidth || 512));
	}

	function getModelHeight() {
		return Math.max(1, Math.round(editor.modelHeight || 512));
	}

	function makeDefaultPoints() {
		const width = getModelWidth();
		const height = getModelHeight();
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

	function buildState() {
		return {
			version: 1,
			positive: editor.posPoints,
			negative: editor.negPoints,
			boxes: editor.boxes,
			width: getModelWidth(),
			height: getModelHeight(),
			image_store: String(imageStoreWidget?.value || node.properties?.[IMAGE_STORE_PROPERTY] || "").trim(),
		};
	}

	function writeBack() {
		editor.boxes = editor.boxes.map(parseBox).filter(Boolean);
		const state = buildState();
		const stateText = JSON.stringify(state);
		if (coordsWidget) {
			coordsWidget.value = JSON.stringify(editor.posPoints);
			coordsWidget.callback?.(coordsWidget.value);
		}
		if (negCoordsWidget) {
			negCoordsWidget.value = JSON.stringify(editor.negPoints);
			negCoordsWidget.callback?.(negCoordsWidget.value);
		}
		if (boxesWidget) {
			boxesWidget.value = JSON.stringify(editor.boxes);
			boxesWidget.callback?.(boxesWidget.value);
		}
		if (stateWidget) {
			stateWidget.value = stateText;
			stateWidget.callback?.(stateText);
		}
		node.properties ||= {};
		node.properties[STATE_PROPERTY] = stateText;
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

	function syncFromWidgets() {
		const state = safeState(stateWidget?.value || node.properties?.[STATE_PROPERTY]);
		editor.posPoints = Array.isArray(state.positive)
			? state.positive
			: Array.isArray(state.coordinates)
				? state.coordinates
				: safeArray(coordsWidget?.value);
		editor.negPoints = Array.isArray(state.negative)
			? state.negative
			: Array.isArray(state.neg_coordinates)
				? state.neg_coordinates
				: safeArray(negCoordsWidget?.value);
		const boxes = Array.isArray(state.boxes)
			? state.boxes
			: Array.isArray(state.bboxes)
				? state.bboxes
				: safeArray(boxesWidget?.value);
		editor.boxes = boxes.map(parseBox).filter(Boolean);
		if (Number(state.width) > 0) {
			editor.modelWidth = Number(state.width);
		}
		if (Number(state.height) > 0) {
			editor.modelHeight = Number(state.height);
		}
		if (state.image_store != null) {
			syncStoredImage(String(state.image_store || ""));
		}
		if (!hasPoints(editor.posPoints) && !hasPoints(editor.negPoints)) {
			setDefaultPoints();
		} else {
			editor.usingDefaultPoints = false;
		}
		scheduleDraw();
	}

	function getCanvasMetrics() {
		const modelWidth = getModelWidth();
		const modelHeight = getModelHeight();
		const displayWidth = Math.max(1, Math.round(wrap.clientWidth || root.clientWidth || getStoredWidth(node) - 18));
		const displayHeight = Math.max(1, Math.round(displayWidth * (modelHeight / Math.max(1, modelWidth))));
		return { modelWidth, modelHeight, displayWidth, displayHeight };
	}

	function syncLayout(adjustNode = true) {
		const metrics = getCanvasMetrics();
		const widgetHeight = metrics.displayHeight + TOOLBAR_HEIGHT + STATUS_HEIGHT + NODE_FRAME_EXTRA;
		wrap.style.height = `${metrics.displayHeight}px`;
		canvas.style.aspectRatio = `${metrics.modelWidth} / ${metrics.modelHeight}`;
		if (canvas.width !== metrics.modelWidth || canvas.height !== metrics.modelHeight) {
			canvas.width = metrics.modelWidth;
			canvas.height = metrics.modelHeight;
		}
		if (node.__gjjSAM2MaskEditor?.widget) {
			node.__gjjSAM2MaskEditor.widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || getStoredWidth(node))), widgetHeight];
			node.__gjjSAM2MaskEditor.widget.getHeight = () => widgetHeight;
		}
		if (adjustNode) {
			node.properties ||= {};
			const width = getStoredWidth(node);
			const computedHeight = Number(node.computeSize?.()?.[1] || 0);
			const height = Math.ceil(Math.max(widgetHeight + 220, computedHeight));
			node.properties[HEIGHT_PROPERTY] = height;
			node.size ||= [width, height];
			node.size[0] = width;
			node.size[1] = height;
			try {
				node.__gjjSAM2ApplyingSize = true;
				node.setSize?.([width, height]);
			} finally {
				node.__gjjSAM2ApplyingSize = false;
			}
		}
		return metrics;
	}

	function toModelPoint(event) {
		const rect = canvas.getBoundingClientRect();
		const localX = event.clientX - rect.left;
		const localY = event.clientY - rect.top;
		if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) {
			return null;
		}
		return {
			x: Math.max(0, Math.min(getModelWidth(), Math.round(localX * (getModelWidth() / Math.max(1, rect.width))))),
			y: Math.max(0, Math.min(getModelHeight(), Math.round(localY * (getModelHeight() / Math.max(1, rect.height))))),
		};
	}

	function getPointHitRadius() {
		return Math.max(8, Math.min(18, Math.log(Math.max(2, Math.min(getModelWidth(), getModelHeight()))) * 2.6));
	}

	function hitTestPoint(event) {
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) {
			return null;
		}
		const localX = event.clientX - rect.left;
		const localY = event.clientY - rect.top;
		if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) {
			return null;
		}
		const scale = Math.max(rect.width / Math.max(1, getModelWidth()), rect.height / Math.max(1, getModelHeight()));
		const hitRadius = Math.max(12, getPointHitRadius() * scale + 6);
		const groups = [
			["negative", editor.negPoints],
			["positive", editor.posPoints],
		];
		for (const [kind, list] of groups) {
			for (let index = list.length - 1; index >= 0; index -= 1) {
				const point = list[index];
				const px = (Number(point?.x || 0) / getModelWidth()) * rect.width;
				const py = (Number(point?.y || 0) / getModelHeight()) * rect.height;
				if (Math.hypot(localX - px, localY - py) <= hitRadius) {
					return { kind, index, point };
				}
			}
		}
		return null;
	}

	function setActivePoint(hit) {
		editor.activePoint = hit ? { kind: hit.kind, index: hit.index } : null;
	}

	function deletePoint(hit) {
		if (!hit) {
			return false;
		}
		const list = hit.kind === "negative" ? editor.negPoints : editor.posPoints;
		if (!Array.isArray(list) || hit.index < 0 || hit.index >= list.length) {
			return false;
		}
		list.splice(hit.index, 1);
		if (editor.activePoint?.kind === hit.kind) {
			if (editor.activePoint.index === hit.index) {
				editor.activePoint = null;
			} else if (editor.activePoint.index > hit.index) {
				editor.activePoint.index -= 1;
			}
		}
		if (editor.dragPoint?.kind === hit.kind) {
			if (editor.dragPoint.index === hit.index) {
				editor.dragPoint = null;
			} else if (editor.dragPoint.index > hit.index) {
				editor.dragPoint.index -= 1;
			}
		}
		editor.usingDefaultPoints = false;
		writeBack();
		scheduleDraw();
		return true;
	}

	function movePoint(hit, point) {
		if (!hit || !point) {
			return;
		}
		const list = hit.kind === "negative" ? editor.negPoints : editor.posPoints;
		if (!Array.isArray(list) || hit.index < 0 || hit.index >= list.length) {
			return;
		}
		list[hit.index] = { x: point.x, y: point.y };
		editor.usingDefaultPoints = false;
	}

	function drawPoint(ctx, point, index, color, labelColor, active = false) {
		const x = (Number(point.x || 0) / getModelWidth()) * getModelWidth();
		const y = (Number(point.y || 0) / getModelHeight()) * getModelHeight();
		const radius = Math.max(8, Math.min(18, Math.log(Math.max(2, Math.min(getModelWidth(), getModelHeight()))) * 2.6));
		ctx.save();
		if (active) {
			ctx.lineWidth = 3;
			ctx.strokeStyle = "#79dcff";
			ctx.setLineDash([6, 4]);
			ctx.beginPath();
			ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}
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
		ctx.strokeStyle = "rgba(0,0,0,0.75)";
		ctx.strokeText(String(index), x + radius + 6, y + radius + 8);
		ctx.fillStyle = labelColor;
		ctx.fillText(String(index), x + radius + 6, y + radius + 8);
		ctx.restore();
	}

	function drawBox(ctx, box, color) {
		const normalized = parseBox(box);
		if (!normalized) {
			return;
		}
		ctx.save();
		ctx.fillStyle = "rgba(56, 200, 255, 0.18)";
		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.fillRect(normalized.startX, normalized.startY, normalized.endX - normalized.startX, normalized.endY - normalized.startY);
		ctx.strokeRect(normalized.startX, normalized.startY, normalized.endX - normalized.startX, normalized.endY - normalized.startY);
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
		if (editor.imageLoaded) {
			ctx.drawImage(image, 0, 0, metrics.modelWidth, metrics.modelHeight);
		} else {
			ctx.fillStyle = "#111b20";
			ctx.fillRect(0, 0, metrics.modelWidth, metrics.modelHeight);
			ctx.strokeStyle = "#34444c";
			ctx.strokeRect(0.5, 0.5, metrics.modelWidth - 1, metrics.modelHeight - 1);
		}
		editor.boxes.forEach((box) => drawBox(ctx, box, "#38c8ff"));
		if (editor.currentBox) {
			drawBox(ctx, editor.currentBox, "#79dcff");
		}
		editor.posPoints.forEach((point, index) => drawPoint(ctx, point, index + 1, "#08cc48", "#2cff68", editor.activePoint?.kind === "positive" && editor.activePoint?.index === index));
		editor.negPoints.forEach((point, index) => drawPoint(ctx, point, index + 1, "#e03b3b", "#ff6d6d", editor.activePoint?.kind === "negative" && editor.activePoint?.index === index));
	}

	let drawHandle = 0;
	function scheduleDraw() {
		window.cancelAnimationFrame(drawHandle);
		drawHandle = window.requestAnimationFrame(draw);
	}

	function loadCurrentPreview(force = false, announce = false) {
		const linkedUrl = buildLinkedImageUrl(node);
		if (linkedUrl) {
			editor.setImageSource(linkedUrl, force, announce ? "已获取上游图片" : "");
			return "linked";
		}
		const storedValue = String(imageStoreWidget?.value || node.properties?.[IMAGE_STORE_PROPERTY] || "").trim();
		if (storedValue) {
			editor.setImageSource(buildUploadedImageUrl(storedValue), force, announce ? "已刷新本地图片" : "");
			return "stored";
		}
		editor.clearImage();
		return "empty";
	}

	function refreshUpstreamImage() {
		const source = loadCurrentPreview(true, true);
		if (source === "linked") {
			status.textContent = "正在获取上游图片...";
		} else if (source === "stored") {
			status.textContent = "未连接上游，已刷新本地图片";
		} else {
			status.textContent = "未检测到上游图片";
		}
		scheduleDraw();
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
	}

	function newCanvas() {
		syncStoredImage("");
		setDefaultPoints();
		editor.boxes = [];
		editor.currentBox = null;
		editor.drawingBox = false;
		editor.pendingPoint = null;
		editor.dragPoint = null;
		editor.activePoint = null;
		writeBack();
		loadCurrentPreview();
	}

	function startBox(point) {
		editor.pendingPoint = null;
		editor.drawingBox = true;
		editor.currentBox = { startX: point.x, startY: point.y, endX: point.x, endY: point.y };
		scheduleDraw();
	}

	loadButton.onclick = loadLocalImageFromButton;
	upstreamButton.onclick = refreshUpstreamImage;
	clearButton.onclick = clearLocalImage;
	newCanvasButton.onclick = newCanvas;

	root.tabIndex = 0;
	root.addEventListener("keydown", (event) => {
		if (event.key !== "Delete" && event.key !== "Backspace") {
			return;
		}
		if (!editor.activePoint) {
			return;
		}
		stopEvent(event);
		deletePoint(editor.activePoint);
	});

	wrap.addEventListener("contextmenu", stopEvent);
	wrap.addEventListener("pointerdown", (event) => {
		stopEvent(event);
		root.focus?.({ preventScroll: true });
		wrap.setPointerCapture?.(event.pointerId);
		const point = toModelPoint(event);
		if (!point) {
			return;
		}
		const hit = hitTestPoint(event);
		if (hit) {
			setActivePoint(hit);
			if (event.button === 2) {
				deletePoint(hit);
				return;
			}
			editor.dragPoint = {
				kind: hit.kind,
				index: hit.index,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
			};
			return;
		}
		editor.activePoint = null;
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
		editor.pendingPoint = { point, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
	});

	wrap.addEventListener("pointermove", (event) => {
		if (editor.dragPoint && event.pointerId === editor.dragPoint.pointerId) {
			stopEvent(event);
			const dragPoint = toModelPoint(event);
			if (dragPoint) {
				movePoint(editor.dragPoint, dragPoint);
				scheduleDraw();
			}
			return;
		}
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
		if (editor.dragPoint && event.pointerId === editor.dragPoint.pointerId) {
			stopEvent(event);
			const dragPoint = toModelPoint(event);
			if (dragPoint) {
				movePoint(editor.dragPoint, dragPoint);
			}
			editor.dragPoint = null;
			writeBack();
		} else if (editor.pendingPoint && event.pointerId === editor.pendingPoint.pointerId) {
			stopEvent(event);
			editor.usingDefaultPoints = false;
			editor.posPoints.push(editor.pendingPoint.point);
			editor.pendingPoint = null;
			writeBack();
		} else if (editor.drawingBox && editor.currentBox) {
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
			writeBack();
		}
		try {
			if (event?.pointerId != null) {
				wrap.releasePointerCapture?.(event.pointerId);
			}
		} catch {
			// Pointer capture may already be released.
		}
		scheduleDraw();
	}

	wrap.addEventListener("pointerup", finishPointer);
	wrap.addEventListener("pointercancel", finishPointer);
	canvas.addEventListener("pointerup", finishPointer);
	canvas.addEventListener("pointercancel", finishPointer);
	window.addEventListener("pointerup", finishPointer);

	image.onload = () => {
		editor.imageLoaded = true;
		editor.modelWidth = Math.max(1, Math.round(image.naturalWidth || editor.modelWidth || 512));
		editor.modelHeight = Math.max(1, Math.round(image.naturalHeight || editor.modelHeight || 512));
		if (editor.pendingLoadStatus) {
			status.textContent = `${editor.pendingLoadStatus}：${editor.modelWidth} x ${editor.modelHeight}`;
			editor.pendingLoadStatus = "";
		}
		const signature = imageSourceSignature(editor.imageSource);
		node.properties ||= {};
		node.properties[SOURCE_PROPERTY] = signature;
		if (editor.usingDefaultPoints) {
			setDefaultPoints();
		}
		writeBack();
		syncLayout();
		scheduleDraw();
	};
	image.onerror = () => {
		editor.imageLoaded = false;
		if (editor.pendingLoadStatus) {
			status.textContent = "图片加载失败";
			editor.pendingLoadStatus = "";
		}
		syncLayout();
		scheduleDraw();
	};

	const widget = node.addDOMWidget("gjj_sam2_mask_editor", "gjj_sam2_mask_editor", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => getStoredHeight(node),
		getMinHeight: () => DEFAULT_NODE_HEIGHT,
		getMaxHeight: () => getStoredHeight(node),
	});
	widget.serialize = false;
	widget.options ||= {};
	widget.options.serialize = false;
	widget.serializeValue = () => undefined;
	widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || getStoredWidth(node))), getStoredHeight(node)];

	node.__gjjSAM2MaskEditor = {
		widget,
		editor,
		status,
		syncFromWidgets,
		loadCurrentPreview,
		writeBack,
		buildState,
		draw: scheduleDraw,
		syncLayout: () => syncLayout(true),
		setImageSource: (src) => editor.setImageSource(src),
		setStatus: (text) => { status.textContent = text; },
	};

	syncFromWidgets();
	writeBack();
	loadCurrentPreview();
	syncLayout();
	return node.__gjjSAM2MaskEditor;
}

function patchNode(node) {
	if (!node || node.__gjjSAM2MaskPatched) {
		return;
	}
	node.__gjjSAM2MaskPatched = true;
	node.properties ||= {};
	repairLiveWidgetValues(node);
	if (!node.properties[WIDTH_PROPERTY]) {
		node.properties[WIDTH_PROPERTY] = Math.max(MIN_NODE_WIDTH, DEFAULT_NODE_WIDTH, Number(node.size?.[0] || 0));
	}
	if (!node.properties[HEIGHT_PROPERTY]) {
		node.properties[HEIGHT_PROPERTY] = Math.max(DEFAULT_NODE_HEIGHT, Number(node.size?.[1] || 0));
	}
	compactNode(node);
	ensureEditor(node);
	normalizeOutputs(node);
	compactNode(node);
	ensureNodeSize(node);
	graphDirty();
}

function afterNodeReady(node) {
	patchNode(node);
	repairLiveWidgetValues(node);
	const view = ensureEditor(node);
	compactNode(node);
	normalizeOutputs(node);
	view.syncFromWidgets?.();
	view.loadCurrentPreview?.();
	view.syncLayout?.();
	for (const delay of [0, 120, 450, 1000]) {
		window.setTimeout(() => {
			const delayed = ensureEditor(node);
			compactNode(node);
			delayed.syncLayout?.();
			delayed.draw?.();
		}, delay);
	}
}

function workflowNodeById(workflow, nodeId) {
	const idText = String(nodeId ?? "");
	const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
	return nodes.find((node) => String(node?.id ?? node?.node_id ?? "") === idText) || null;
}

function syncNodeToPrompt(node, output, workflow) {
	const view = ensureEditor(node);
	view.writeBack?.();
	const state = view.buildState?.() || {};
	const promptNode = output?.[String(node.id)];
	if (!promptNode || typeof promptNode !== "object") {
		return;
	}
	const inputs = promptNode.inputs ||= {};
	inputs.coordinates = JSON.stringify(Array.isArray(state.positive) ? state.positive : []);
	inputs.neg_coordinates = JSON.stringify(Array.isArray(state.negative) ? state.negative : []);
	inputs.bboxes = JSON.stringify(Array.isArray(state.boxes) ? state.boxes : []);
	inputs.editor_state = JSON.stringify(state);
	inputs.image_store = String(state.image_store || "");
	const workflowNode = workflowNodeById(workflow, node.id);
	if (workflowNode) {
		workflowNode.properties ||= {};
		workflowNode.properties[STATE_PROPERTY] = JSON.stringify(state);
		workflowNode.properties[IMAGE_STORE_PROPERTY] = String(state.image_store || "");
	}
}

function syncAllEditors(output, workflow) {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			syncNodeToPrompt(node, output, workflow);
		}
	}
}

function patchQueuePrompt() {
	if (queuePatched || typeof api.queuePrompt !== "function") {
		return;
	}
	const original = api.queuePrompt;
	api.queuePrompt = async function (number, promptData, ...args) {
		try {
			syncAllEditors(promptData?.output, promptData?.workflow);
		} catch (error) {
			console.warn("[GJJ] SAM2 点选遮罩提交前同步失败：", error);
		}
		return original.call(this, number, promptData, ...args);
	};
	queuePatched = true;
}

app.registerExtension({
	name: "GJJ.SAM2PointMaskEditor",
	setup() {
		patchQueuePrompt();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node.comfyClass || node.type || ""))) {
				afterNodeReady(node);
			}
		}
	},
	beforeQueuePrompt() {
		syncAllEditors();
	},
	beforeQueued() {
		syncAllEditors();
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
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			sanitizeSerializedNodeWidgets(serializedNode, this);
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			repairLiveWidgetValues(this, serializedNode?.widgets_values);
			ensureNodeSize(this);
			afterNodeReady(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			const view = ensureEditor(this);
			if (message?.bg_image?.[0]) {
				view.setImageSource?.(`data:image/png;base64,${message.bg_image[0]}`);
			}
			view.setStatus?.("执行完成");
			view.draw?.();
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			window.setTimeout(() => {
				ensureEditor(this).loadCurrentPreview?.();
			}, 0);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (this.__gjjSAM2ApplyingSize) {
				return result;
			}
			this.properties ||= {};
			this.properties[WIDTH_PROPERTY] = Math.max(MIN_NODE_WIDTH, Number(this.size?.[0] || 0));
			const view = ensureEditor(this);
			try {
				this.__gjjSAM2ApplyingSize = true;
				view.syncLayout?.();
			} finally {
				this.__gjjSAM2ApplyingSize = false;
			}
			view.draw?.();
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) {
			const result = originalOnSerialize?.apply(this, arguments);
			repairLiveWidgetValues(this);
			const view = ensureEditor(this);
			view.writeBack?.();
			if (data) {
				data.properties ||= {};
				data.properties[WIDTH_PROPERTY] = this.properties?.[WIDTH_PROPERTY];
				data.properties[HEIGHT_PROPERTY] = this.properties?.[HEIGHT_PROPERTY];
				data.properties[IMAGE_STORE_PROPERTY] = this.properties?.[IMAGE_STORE_PROPERTY] || "";
				data.properties[STATE_PROPERTY] = this.properties?.[STATE_PROPERTY] || "";
				writeSerializedWidgetValues(this, data);
			}
			return result;
		};
	},
});

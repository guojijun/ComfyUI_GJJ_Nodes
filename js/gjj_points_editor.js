import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_PointsEditor"]);
const HIDDEN_WIDGETS = ["points_store", "coordinates", "neg_coordinates", "bbox_store", "bboxes"];
const WIDTH_PROPERTY = "gjj_points_editor_width";
const SOURCE_PROPERTY = "gjj_points_editor_image_source";
const MIN_NODE_WIDTH = 520;
const DEFAULT_NODE_WIDTH = 620;
const NODE_SIDE_PADDING = 28;
const MIN_VIEW_HEIGHT = 180;
const MAX_VIEW_HEIGHT = 520;
const EDITOR_HEIGHT = 560;

function graphDirty() {
	app.graph?.setDirtyCanvas?.(true, true);
}

function getStoredNodeWidth(node) {
	return Math.max(MIN_NODE_WIDTH, Number(node?.properties?.[WIDTH_PROPERTY] || 0), Number(node?.size?.[0] || 0), DEFAULT_NODE_WIDTH);
}

function preserveNodeSize(node, preferredHeight = EDITOR_HEIGHT + 120) {
	const currentWidth = getStoredNodeWidth(node);
	node.properties ||= {};
	node.properties[WIDTH_PROPERTY] = currentWidth;
	node.size ||= [currentWidth, preferredHeight];
	node.size[0] = currentWidth;
	node.min_width = currentWidth;
	node.minWidth = currentWidth;
	const currentHeight = Math.max(Number(node.size?.[1] || 0), Number(preferredHeight || 0));
	node.setSize?.([currentWidth, currentHeight]);
	graphDirty();
}

function hideWidget(widget) {
	if (!widget || widget.__gjjPointsHidden) {
		return;
	}
	widget.__gjjPointsHidden = {
		type: widget.type,
		computeSize: widget.computeSize,
	};
	widget.type = "converted-widget";
	widget.computeSize = () => [0, -4];
}

function safeParseArray(text, fallback = []) {
	try {
		const value = JSON.parse(String(text || "[]"));
		return Array.isArray(value) ? value : fallback;
	} catch {
		return fallback;
	}
}

function safeParseStore(text) {
	try {
		const value = JSON.parse(String(text || "{}"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

function parseArrayWithFallback(text, fallback = []) {
	const raw = String(text ?? "").trim();
	if (!raw || raw === "[]") {
		return Array.isArray(fallback) ? [...fallback] : [];
	}
	return safeParseArray(raw, fallback);
}

function stopCanvasEvent(event) {
	event.preventDefault?.();
	event.stopPropagation?.();
	event.stopImmediatePropagation?.();
}

function getInput(node, name) {
	return node.inputs?.find((input) => input.name === name);
}

function getSourceNode(node, inputName) {
	const input = getInput(node, inputName);
	if (input?.link == null || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[input.link];
	const sourceId = link?.origin_id ?? link?.source_id ?? link?.from_id;
	return sourceId != null ? app.graph.getNodeById?.(sourceId) : null;
}

function buildLoadImageUrl(sourceNode) {
	if (!sourceNode) {
		return "";
	}
	const fileWidget = sourceNode.widgets?.find((widget) => widget.name === "image" || widget.name === "file" || widget.name === "filename");
	const filename = fileWidget?.value;
	if (!filename) {
		return "";
	}
	const viewType = sourceNode.comfyClass === "LoadImageOutput" ? "output" : "input";
	return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(viewType)}&subfolder=&rand=${Date.now()}`);
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

function getLinkedImageUrl(node) {
	const sourceNode = getSourceNode(node, "bg_image");
	if (!sourceNode) {
		return "";
	}
	const img = Array.isArray(sourceNode.imgs) ? sourceNode.imgs[0] : null;
	if (img?.src) {
		return img.src;
	}
	const src = sourceNode.image?.src || sourceNode.preview?.src;
	if (src) {
		return src;
	}
	if (["LoadImage", "LoadImageOutput"].includes(sourceNode.comfyClass)) {
		return buildLoadImageUrl(sourceNode);
	}
	return "";
}

function setWidgetValue(widget, value) {
	if (!widget || Number(widget.value) === Number(value)) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
}

function normalizeBox(box) {
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

function ensureEditor(node) {
	if (node.__gjjPointsEditor) {
		return node.__gjjPointsEditor;
	}

	const coordsWidget = node.widgets?.find((w) => w.name === "coordinates");
	const negCoordsWidget = node.widgets?.find((w) => w.name === "neg_coordinates");
	const storeWidget = node.widgets?.find((w) => w.name === "points_store");
	const bboxStoreWidget = node.widgets?.find((w) => w.name === "bbox_store");
	const bboxWidget = node.widgets?.find((w) => w.name === "bboxes");
	const widthWidget = node.widgets?.find((w) => w.name === "width");
	const heightWidget = node.widgets?.find((w) => w.name === "height");

	const root = document.createElement("div");
	root.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"height:100%",
		"width:100%",
		"box-sizing:border-box",
		"padding:2px 0",
		"pointer-events:auto",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		root.addEventListener(eventName, (event) => event.stopPropagation());
	}

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
	root.appendChild(toolbar);

	const hint = document.createElement("div");
	hint.textContent = "左键前景点，右键背景点，Ctrl+拖拽画框";
	hint.style.cssText = "font-size:12px;color:#c9d6d0;flex:1 1 auto;";
	toolbar.appendChild(hint);

	const count = document.createElement("div");
	count.style.cssText = "font-size:12px;color:#9eb3ab;";
	toolbar.appendChild(count);

	const clearButton = document.createElement("button");
	clearButton.textContent = "清空";
	clearButton.style.cssText = [
		"padding:4px 10px",
		"border-radius:999px",
		"border:1px solid #41535b",
		"background:#182127",
		"color:#dce7e2",
		"cursor:pointer",
	].join(";");
	toolbar.appendChild(clearButton);

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"position:relative",
		"height:320px",
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #34444c",
		"border-radius:12px",
		"background:#0b1013",
		"overflow:hidden",
		"touch-action:none",
		"cursor:crosshair",
	].join(";");
	root.appendChild(wrap);

	const canvas = document.createElement("canvas");
	canvas.style.cssText = [
		"display:block",
		"width:100%",
		"height:100%",
		"background:#0f1519",
		"user-select:none",
	].join(";");
	wrap.appendChild(canvas);

	const image = new Image();
	image.crossOrigin = "anonymous";

	const storedPayload = safeParseStore(storeWidget?.value);
	const storedPos = Array.isArray(storedPayload.positive) ? storedPayload.positive : [];
	const storedNeg = Array.isArray(storedPayload.negative) ? storedPayload.negative : [];

	const editor = {
		root,
		canvas,
		image,
		imageLoaded: false,
		imageSource: "",
		posPoints: parseArrayWithFallback(coordsWidget?.value, storedPos),
		negPoints: parseArrayWithFallback(negCoordsWidget?.value, storedNeg),
		boxes: parseArrayWithFallback(bboxWidget?.value, safeParseArray(bboxStoreWidget?.value)).map(normalizeBox).filter(Boolean),
		currentBox: null,
		drawingBox: false,
		getWidth() {
			return Math.max(1, Number(widthWidget?.value || image.naturalWidth || 512));
		},
		getHeight() {
			return Math.max(1, Number(heightWidget?.value || image.naturalHeight || 512));
		},
		setImageSource(src) {
			if (!src || src === this.imageSource) {
				return;
			}
			this.imageLoaded = false;
			this.imageSource = src;
			image.src = src;
			scheduleDraw();
		},
		setImageBase64(base64) {
			if (!base64) {
				return;
			}
			this.setImageSource(`data:image/png;base64,${base64}`);
		},
	};

	function getModelSize() {
		return {
			width: editor.getWidth(),
			height: editor.getHeight(),
		};
	}

	function syncEditorLayout(adjustNode = true) {
		const nodeWidth = getStoredNodeWidth(node);
		const usableWidth = Math.max(240, nodeWidth - NODE_SIDE_PADDING);
		const model = getModelSize();
		const aspectHeight = usableWidth * (model.height / Math.max(1, model.width));
		const displayHeight = Math.round(Math.max(MIN_VIEW_HEIGHT, Math.min(MAX_VIEW_HEIGHT, aspectHeight)));
		wrap.style.height = `${displayHeight}px`;
		const widgetHeight = displayHeight + 90;
		if (node.__gjjPointsEditor?.widget) {
			node.__gjjPointsEditor.widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || getStoredNodeWidth(node))), widgetHeight];
		}
		if (adjustNode) {
			preserveNodeSize(node, widgetHeight + 135);
		}
		return displayHeight;
	}

	function getViewport() {
		const rect = wrap.getBoundingClientRect();
		const viewWidth = Math.max(1, rect.width || canvas.clientWidth || 1);
		const viewHeight = Math.max(1, rect.height || canvas.clientHeight || 1);
		const model = getModelSize();
		return { left: 0, top: 0, width: viewWidth, height: viewHeight, modelWidth: model.width, modelHeight: model.height, viewWidth, viewHeight };
	}

	function toModelPoint(event) {
		const bounds = getViewport();
		const rect = wrap.getBoundingClientRect();
		const localX = event.clientX - rect.left;
		const localY = event.clientY - rect.top;
		if (
			localX < bounds.left ||
			localX > bounds.left + bounds.width ||
			localY < bounds.top ||
			localY > bounds.top + bounds.height
		) {
			return null;
		}
		return {
			x: Math.round(((localX - bounds.left) / bounds.width) * bounds.modelWidth),
			y: Math.round(((localY - bounds.top) / bounds.height) * bounds.modelHeight),
		};
	}

	function writeBack() {
		editor.boxes = editor.boxes.map(normalizeBox).filter(Boolean);
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
		count.textContent = `前景 ${editor.posPoints.length} / 背景 ${editor.negPoints.length} / 框 ${editor.boxes.length}`;
		syncEditorLayout();
		scheduleDraw();
	}

	function drawPoint(ctx, bounds, point, index, color, labelColor) {
		const x = bounds.left + (Number(point.x || 0) / bounds.modelWidth) * bounds.width;
		const y = bounds.top + (Number(point.y || 0) / bounds.modelHeight) * bounds.height;
		const radius = Math.max(8, Math.min(18, Math.log(Math.min(bounds.modelWidth, bounds.modelHeight)) * 2.6));
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
		const normalized = normalizeBox(box);
		if (!normalized) {
			return;
		}
		const x1 = bounds.left + (normalized.startX / bounds.modelWidth) * bounds.width;
		const y1 = bounds.top + (normalized.startY / bounds.modelHeight) * bounds.height;
		const x2 = bounds.left + (normalized.endX / bounds.modelWidth) * bounds.width;
		const y2 = bounds.top + (normalized.endY / bounds.modelHeight) * bounds.height;
		ctx.save();
		ctx.fillStyle = "rgba(56, 200, 255, 0.2)";
		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
		ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
		ctx.restore();
	}

	function draw() {
		syncEditorLayout(false);
		const dpr = Math.max(1, window.devicePixelRatio || 1);
		const cssWidth = Math.max(1, wrap.clientWidth || 1);
		const cssHeight = Math.max(1, wrap.clientHeight || 1);
		const realWidth = Math.round(cssWidth * dpr);
		const realHeight = Math.round(cssHeight * dpr);
		if (canvas.width !== realWidth || canvas.height !== realHeight) {
			canvas.width = realWidth;
			canvas.height = realHeight;
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssWidth, cssHeight);
		ctx.fillStyle = "#0f1519";
		ctx.fillRect(0, 0, cssWidth, cssHeight);
		const bounds = getViewport();
		if (editor.imageLoaded) {
			ctx.drawImage(image, bounds.left, bounds.top, bounds.width, bounds.height);
		} else {
			ctx.fillStyle = "#111b20";
			ctx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
			ctx.strokeStyle = "#34444c";
			ctx.lineWidth = 1;
			ctx.strokeRect(bounds.left + 0.5, bounds.top + 0.5, bounds.width - 1, bounds.height - 1);
			ctx.fillStyle = "#91a39b";
			ctx.font = "12px sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText("未执行时会优先读取已连接 LoadImage / 已有预览；否则使用空白画布", cssWidth / 2, cssHeight / 2);
			ctx.textAlign = "start";
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
		const store = safeParseStore(storeWidget?.value);
		editor.posPoints = parseArrayWithFallback(coordsWidget?.value, Array.isArray(store.positive) ? store.positive : []);
		editor.negPoints = parseArrayWithFallback(negCoordsWidget?.value, Array.isArray(store.negative) ? store.negative : []);
		editor.boxes = parseArrayWithFallback(bboxWidget?.value, safeParseArray(bboxStoreWidget?.value)).map(normalizeBox).filter(Boolean);
		count.textContent = `前景 ${editor.posPoints.length} / 背景 ${editor.negPoints.length} / 框 ${editor.boxes.length}`;
		scheduleDraw();
	}

	function loadLinkedPreview() {
		const url = getLinkedImageUrl(node);
		if (url) {
			editor.setImageSource(url);
		}
	}

	clearButton.onclick = () => {
		editor.posPoints = [];
		editor.negPoints = [];
		editor.boxes = [];
		editor.currentBox = null;
		writeBack();
	};

	wrap.addEventListener("contextmenu", stopCanvasEvent);
	wrap.addEventListener("pointerdown", (event) => {
		stopCanvasEvent(event);
		wrap.setPointerCapture?.(event.pointerId);
		const point = toModelPoint(event);
		if (!point) {
			return;
		}
		if (event.ctrlKey) {
			editor.drawingBox = true;
			editor.currentBox = { startX: point.x, startY: point.y, endX: point.x, endY: point.y };
			scheduleDraw();
			return;
		}
		if (event.button === 2) {
			editor.negPoints.push(point);
		} else {
			editor.posPoints.push(point);
		}
		writeBack();
	});

	wrap.addEventListener("pointermove", (event) => {
		if (!editor.drawingBox || !editor.currentBox) {
			return;
		}
		stopCanvasEvent(event);
		const point = toModelPoint(event);
		if (!point) {
			return;
		}
		editor.currentBox.endX = point.x;
		editor.currentBox.endY = point.y;
		scheduleDraw();
	});

	window.addEventListener("pointerup", (event) => {
		if (!editor.drawingBox || !editor.currentBox) {
			return;
		}
		stopCanvasEvent(event);
		const box = normalizeBox(editor.currentBox);
		if (box) {
			editor.boxes.push(box);
		}
		editor.currentBox = null;
		editor.drawingBox = false;
		writeBack();
	});

	image.onload = () => {
		editor.imageLoaded = true;
		const signature = imageSourceSignature(editor.imageSource);
		node.properties ||= {};
		const currentWidth = Number(widthWidget?.value || 0);
		const currentHeight = Number(heightWidget?.value || 0);
		const dimensionsMismatch = Math.abs(currentWidth - image.naturalWidth) > 1 || Math.abs(currentHeight - image.naturalHeight) > 1;
		const stillDefaultSquare = currentWidth === 512 && currentHeight === 512 && image.naturalWidth !== image.naturalHeight;
		if (signature && (node.properties[SOURCE_PROPERTY] !== signature || dimensionsMismatch || stillDefaultSquare)) {
			setWidgetValue(widthWidget, image.naturalWidth);
			setWidgetValue(heightWidget, image.naturalHeight);
			node.properties[SOURCE_PROPERTY] = signature;
		}
		syncEditorLayout();
		scheduleDraw();
	};
	image.onerror = () => {
		editor.imageLoaded = false;
		syncEditorLayout();
		scheduleDraw();
	};

	const widget = node.addDOMWidget("gjj_points_editor", "gjj_points_editor", root, {
		hideOnZoom: false,
		getHeight: () => EDITOR_HEIGHT,
		getMinHeight: () => EDITOR_HEIGHT,
		getMaxHeight: () => EDITOR_HEIGHT,
	});
	widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || getStoredNodeWidth(node))), EDITOR_HEIGHT];

	node.__gjjPointsEditor = { widget, editor, draw: scheduleDraw, syncFromWidgets, loadLinkedPreview };
	writeBack();
	loadLinkedPreview();
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
	HIDDEN_WIDGETS.forEach((name) => hideWidget(node.widgets?.find((w) => w.name === name)));
	ensureEditor(node);
	preserveNodeSize(node);
}

function afterNodeReady(node) {
	patchNode(node);
	const view = ensureEditor(node);
	view.syncFromWidgets();
	view.loadLinkedPreview();
}

app.registerExtension({
	name: "GJJ.PointsEditor",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalOnNodeCreated?.apply(this, arguments);
			afterNodeReady(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			if (this.properties?.[WIDTH_PROPERTY]) {
				this.size ||= [MIN_NODE_WIDTH, EDITOR_HEIGHT];
				this.size[0] = getStoredNodeWidth(this);
			}
			afterNodeReady(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			if (message?.bg_image?.[0]) {
				ensureEditor(this).editor.setImageBase64(message.bg_image[0]);
			}
			ensureEditor(this).draw();
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			window.setTimeout(() => ensureEditor(this).loadLinkedPreview(), 0);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			this.properties ||= {};
			this.properties[WIDTH_PROPERTY] = Math.max(MIN_NODE_WIDTH, DEFAULT_NODE_WIDTH, Number(this.size?.[0] || 0), Number(this.properties[WIDTH_PROPERTY] || 0));
			ensureEditor(this).draw();
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) {
			const result = originalOnSerialize?.apply(this, arguments);
			this.properties ||= {};
			this.properties[WIDTH_PROPERTY] = getStoredNodeWidth(this);
			if (data) {
				data.properties ||= {};
				data.properties[WIDTH_PROPERTY] = this.properties[WIDTH_PROPERTY];
			}
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node.comfyClass || node.type || ""))) {
				afterNodeReady(node);
			}
		}
	},
});

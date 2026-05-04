import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";

const POINT_NODE = "GJJ_SAM3PointCollector";
const BBOX_NODE = "GJJ_SAM3BBoxCollector";

function hideWidget(widget) {
	if (!widget || widget.__gjjSam3Hidden) {
		return;
	}
	widget.__gjjSam3Hidden = {
		type: widget.type,
		computeSize: widget.computeSize,
	};
	widget.type = "converted-widget";
	widget.computeSize = () => [0, -4];
}

function createContainer(height = 320) {
	const root = document.createElement("div");
	root.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"height:100%",
		"padding:2px 0",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
	root.appendChild(toolbar);

	const hint = document.createElement("div");
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
		`height:${height}px`,
		"border:1px solid #34444c",
		"border-radius:12px",
		"background:#0f1519",
		"overflow:hidden",
	].join(";");
	root.appendChild(wrap);

	const empty = document.createElement("div");
	empty.textContent = "先执行一次，让图像显示在这里";
	empty.style.cssText = [
		"position:absolute",
		"inset:0",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"padding:16px",
		"text-align:center",
		"font-size:12px",
		"color:#91a39b",
	].join(";");
	wrap.appendChild(empty);

	const img = document.createElement("img");
	img.style.cssText = [
		"position:absolute",
		"inset:0",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"display:none",
		"user-select:none",
		"-webkit-user-drag:none",
	].join(";");
	wrap.appendChild(img);

	const overlay = document.createElement("svg");
	overlay.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	overlay.style.cssText = [
		"position:absolute",
		"inset:0",
		"width:100%",
		"height:100%",
	].join(";");
	wrap.appendChild(overlay);

	return { root, toolbar, hint, count, clearButton, wrap, empty, img, overlay };
}

function getImageBounds(img, wrap) {
	if (!img.naturalWidth || !img.naturalHeight) {
		return null;
	}
	const wrapRect = wrap.getBoundingClientRect();
	const imageRatio = img.naturalWidth / img.naturalHeight;
	const wrapRatio = wrapRect.width / wrapRect.height;
	let width = wrapRect.width;
	let height = wrapRect.height;
	let left = 0;
	let top = 0;
	if (imageRatio > wrapRatio) {
		height = width / imageRatio;
		top = (wrapRect.height - height) / 2;
	} else {
		width = height * imageRatio;
		left = (wrapRect.width - width) / 2;
	}
	return { left, top, width, height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
}

function toCanvasPoint(event, img, wrap) {
	const bounds = getImageBounds(img, wrap);
	if (!bounds) {
		return null;
	}
	const wrapRect = wrap.getBoundingClientRect();
	const localX = event.clientX - wrapRect.left;
	const localY = event.clientY - wrapRect.top;
	if (
		localX < bounds.left ||
		localX > bounds.left + bounds.width ||
		localY < bounds.top ||
		localY > bounds.top + bounds.height
	) {
		return null;
	}
	return {
		x: ((localX - bounds.left) / bounds.width) * bounds.naturalWidth,
		y: ((localY - bounds.top) / bounds.height) * bounds.naturalHeight,
	};
}

function registerPointCollector(nodeType) {
	const onNodeCreated = nodeType.prototype.onNodeCreated;
	nodeType.prototype.onNodeCreated = function () {
		const result = onNodeCreated?.apply(this, arguments);
		const posWidget = this.widgets?.find((w) => w.name === "coordinates");
		const negWidget = this.widgets?.find((w) => w.name === "neg_coordinates");
		const storeWidget = this.widgets?.find((w) => w.name === "points_store");
		hideWidget(posWidget);
		hideWidget(negWidget);
		hideWidget(storeWidget);

		const ui = createContainer(320);
		ui.hint.textContent = "左键加前景点，右键加背景点";
		ui.count.textContent = "前景 0 / 背景 0";

		const state = {
			posPoints: [],
			negPoints: [],
			imgBase64: "",
		};

		const widget = this.addDOMWidget("gjj_sam3_points_editor", "gjj_sam3_points_editor", ui.root, {
			hideOnZoom: false,
			getHeight: () => 360,
		});
		widget.computeSize = (width) => [width, 360];

		const writeBack = () => {
			if (posWidget) {
				posWidget.value = JSON.stringify(state.posPoints);
				posWidget.callback?.(posWidget.value);
			}
			if (negWidget) {
				negWidget.value = JSON.stringify(state.negPoints);
				negWidget.callback?.(negWidget.value);
			}
			if (storeWidget) {
				storeWidget.value = JSON.stringify({ positive: state.posPoints, negative: state.negPoints });
				storeWidget.callback?.(storeWidget.value);
			}
			ui.count.textContent = `前景 ${state.posPoints.length} / 背景 ${state.negPoints.length}`;
			GJJ_Utils.refreshNode(this);
		};

		const draw = () => {
			while (ui.overlay.firstChild) {
				ui.overlay.removeChild(ui.overlay.firstChild);
			}
			const bounds = getImageBounds(ui.img, ui.wrap);
			if (!bounds) {
				return;
			}
			const drawOne = (pt, color) => {
				const cx = bounds.left + (pt.x / bounds.naturalWidth) * bounds.width;
				const cy = bounds.top + (pt.y / bounds.naturalHeight) * bounds.height;
				const outer = document.createElementNS("http://www.w3.org/2000/svg", "circle");
				outer.setAttribute("cx", String(cx));
				outer.setAttribute("cy", String(cy));
				outer.setAttribute("r", "9");
				outer.setAttribute("fill", "none");
				outer.setAttribute("stroke", color);
				outer.setAttribute("stroke-width", "2");
				ui.overlay.appendChild(outer);
				const inner = document.createElementNS("http://www.w3.org/2000/svg", "circle");
				inner.setAttribute("cx", String(cx));
				inner.setAttribute("cy", String(cy));
				inner.setAttribute("r", "5");
				inner.setAttribute("fill", color);
				ui.overlay.appendChild(inner);
			};
			state.posPoints.forEach((pt) => drawOne(pt, "#53df82"));
			state.negPoints.forEach((pt) => drawOne(pt, "#ff6d6d"));
		};

		ui.clearButton.onclick = () => {
			state.posPoints = [];
			state.negPoints = [];
			writeBack();
			draw();
		};

		ui.wrap.addEventListener("contextmenu", (event) => event.preventDefault());
		ui.wrap.addEventListener("pointerdown", (event) => {
			const point = toCanvasPoint(event, ui.img, ui.wrap);
			if (!point) {
				return;
			}
			if (event.button === 2) {
				state.negPoints.push(point);
			} else {
				state.posPoints.push(point);
			}
			writeBack();
			draw();
		});

		ui.img.onload = () => draw();

		const onExecuted = this.onExecuted;
		this.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);
			const encoded = message?.bg_image?.[0];
			if (encoded) {
				state.imgBase64 = encoded;
				ui.img.src = `data:image/png;base64,${encoded}`;
				ui.img.style.display = "block";
				ui.empty.style.display = "none";
			}
			draw();
			writeBack();
		};

		return result;
	};
}

function registerBBoxCollector(nodeType) {
	const onNodeCreated = nodeType.prototype.onNodeCreated;
	nodeType.prototype.onNodeCreated = function () {
		const result = onNodeCreated?.apply(this, arguments);
		const posWidget = this.widgets?.find((w) => w.name === "bboxes");
		const negWidget = this.widgets?.find((w) => w.name === "neg_bboxes");
		hideWidget(posWidget);
		hideWidget(negWidget);

		const ui = createContainer(320);
		ui.hint.textContent = "左键拖正向框，右键拖反向框";
		ui.count.textContent = "正向 0 / 反向 0";

		const state = {
			posBoxes: [],
			negBoxes: [],
			currentBox: null,
		};

		const widget = this.addDOMWidget("gjj_sam3_bbox_editor", "gjj_sam3_bbox_editor", ui.root, {
			hideOnZoom: false,
			getHeight: () => 360,
		});
		widget.computeSize = (width) => [width, 360];

		const writeBack = () => {
			if (posWidget) {
				posWidget.value = JSON.stringify(state.posBoxes);
				posWidget.callback?.(posWidget.value);
			}
			if (negWidget) {
				negWidget.value = JSON.stringify(state.negBoxes);
				negWidget.callback?.(negWidget.value);
			}
			ui.count.textContent = `正向 ${state.posBoxes.length} / 反向 ${state.negBoxes.length}`;
			GJJ_Utils.refreshNode(this);
		};

		const draw = () => {
			while (ui.overlay.firstChild) {
				ui.overlay.removeChild(ui.overlay.firstChild);
			}
			const bounds = getImageBounds(ui.img, ui.wrap);
			if (!bounds) {
				return;
			}
			const drawBox = (bbox, color) => {
				const x = bounds.left + (bbox.x1 / bounds.naturalWidth) * bounds.width;
				const y = bounds.top + (bbox.y1 / bounds.naturalHeight) * bounds.height;
				const w = ((bbox.x2 - bbox.x1) / bounds.naturalWidth) * bounds.width;
				const h = ((bbox.y2 - bbox.y1) / bounds.naturalHeight) * bounds.height;
				const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
				rect.setAttribute("x", String(x));
				rect.setAttribute("y", String(y));
				rect.setAttribute("width", String(w));
				rect.setAttribute("height", String(h));
				rect.setAttribute("fill", "none");
				rect.setAttribute("stroke", color);
				rect.setAttribute("stroke-width", "2");
				ui.overlay.appendChild(rect);
			};
			state.posBoxes.forEach((bbox) => drawBox(bbox, "#33d8ff"));
			state.negBoxes.forEach((bbox) => drawBox(bbox, "#ff6d6d"));
			if (state.currentBox) {
				drawBox(state.currentBox.bbox, state.currentBox.isNegative ? "#ff6d6d" : "#33d8ff");
			}
		};

		ui.clearButton.onclick = () => {
			state.posBoxes = [];
			state.negBoxes = [];
			state.currentBox = null;
			writeBack();
			draw();
		};

		ui.wrap.addEventListener("contextmenu", (event) => event.preventDefault());
		ui.wrap.addEventListener("pointerdown", (event) => {
			const point = toCanvasPoint(event, ui.img, ui.wrap);
			if (!point) {
				return;
			}
			state.currentBox = {
				isNegative: event.button === 2,
				bbox: { x1: point.x, y1: point.y, x2: point.x, y2: point.y },
			};
			draw();
		});
		ui.wrap.addEventListener("pointermove", (event) => {
			if (!state.currentBox) {
				return;
			}
			const point = toCanvasPoint(event, ui.img, ui.wrap);
			if (!point) {
				return;
			}
			state.currentBox.bbox.x2 = point.x;
			state.currentBox.bbox.y2 = point.y;
			draw();
		});
		window.addEventListener("pointerup", () => {
			if (!state.currentBox) {
				return;
			}
			const bbox = state.currentBox.bbox;
			const normalized = {
				x1: Math.min(bbox.x1, bbox.x2),
				y1: Math.min(bbox.y1, bbox.y2),
				x2: Math.max(bbox.x1, bbox.x2),
				y2: Math.max(bbox.y1, bbox.y2),
			};
			if (state.currentBox.isNegative) {
				state.negBoxes.push(normalized);
			} else {
				state.posBoxes.push(normalized);
			}
			state.currentBox = null;
			writeBack();
			draw();
		});

		ui.img.onload = () => draw();

		const onExecuted = this.onExecuted;
		this.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);
			const encoded = message?.bg_image?.[0];
			if (encoded) {
				ui.img.src = `data:image/png;base64,${encoded}`;
				ui.img.style.display = "block";
				ui.empty.style.display = "none";
			}
			draw();
			writeBack();
		};

		return result;
	};
}

app.registerExtension({
	name: "GJJ.SAM3Segmenter",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name === POINT_NODE) {
			registerPointCollector(nodeType);
		}
		if (nodeData.name === BBOX_NODE) {
			registerBBoxCollector(nodeType);
		}
	},
});

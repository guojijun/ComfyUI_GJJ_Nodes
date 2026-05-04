import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_SEM2PointSegmenter"]);
const POS_WIDGET = "positive_points";
const NEG_WIDGET = "negative_points";
const STATUS_WIDGET = "gjj_sem2_segmenter_status";
const EDITOR_WIDGET = "gjj_sem2_segmenter_editor";
const EDITOR_HEIGHT = 360;

function refreshNode(node) {
	const currentWidth = Math.max(420, Number(node.size?.[0] || 0));
	const computed = node.computeSize?.() || node.size;
	node.setSize?.([currentWidth, Math.max(Number(computed?.[1] || 0), EDITOR_HEIGHT + 120)]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideWidget(node, widget) {
	if (!widget || widget.__gjjSem2Hidden) {
		return;
	}
	widget.__gjjSem2Hidden = {
		type: widget.type,
		computeSize: widget.computeSize,
	};
	widget.type = "converted-widget";
	widget.serialize = true;
	widget.serializeValue = () => widget.value;
	widget.computeSize = () => [0, -4];
}

function forceWidgetValue(node, widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.serialize = true;
	widget.serializeValue = () => widget.value;
	widget.callback?.(widget.value);
	const index = node.widgets?.indexOf(widget) ?? -1;
	if (index >= 0) {
		node.widgets_values ||= [];
		node.widgets_values[index] = widget.value;
	}
}

function ensureStatus(node) {
	if (node.__gjjSem2Status) {
		return node.__gjjSem2Status;
	}
	const box = document.createElement("div");
	box.textContent = "等待执行";
	box.style.cssText = [
		"min-height:24px",
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
	const widget = node.addDOMWidget?.(STATUS_WIDGET, STATUS_WIDGET, box, {
		hideOnZoom: false,
		getHeight: () => 42,
	});
	node.__gjjSem2Status = { widget, box };
	return node.__gjjSem2Status;
}

function setStatus(node, text) {
	const box = node?.__gjjSem2Status?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	refreshNode(node);
}

function safeParse(text) {
	try {
		const value = JSON.parse(String(text || "[]"));
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

function ensureEditor(node) {
	if (node.__gjjSem2Editor) {
		return node.__gjjSem2Editor;
	}
	const posWidget = node.widgets?.find((w) => w.name === POS_WIDGET);
	const negWidget = node.widgets?.find((w) => w.name === NEG_WIDGET);

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

	const hint = document.createElement("div");
	hint.textContent = "左键人物加绿点，右键背景加红点";
	hint.style.cssText = "font-size:12px;color:#c9d6d0;flex:1 1 auto;";
	toolbar.appendChild(hint);

	const count = document.createElement("div");
	count.style.cssText = "font-size:12px;color:#9eb3ab;";
	toolbar.appendChild(count);

	const clearButton = document.createElement("button");
	clearButton.textContent = "清空点位";
	clearButton.style.cssText = [
		"padding:4px 10px",
		"border-radius:999px",
		"border:1px solid #41535b",
		"background:#182127",
		"color:#dce7e2",
		"cursor:pointer",
	].join(";");
	toolbar.appendChild(clearButton);
	root.appendChild(toolbar);

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"position:relative",
		"height:300px",
		"border:1px solid #34444c",
		"border-radius:12px",
		"background:#0f1519",
		"overflow:hidden",
	].join(";");
	root.appendChild(wrap);

	const empty = document.createElement("div");
	empty.textContent = "先执行一次，让首帧图像显示在这里";
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
		"pointer-events:none",
	].join(";");
	wrap.appendChild(overlay);

	function writeBack() {
		forceWidgetValue(node, posWidget, JSON.stringify(editor.posPoints));
		forceWidgetValue(node, negWidget, JSON.stringify(editor.negPoints));
		count.textContent = `正点 ${editor.posPoints.length} / 负点 ${editor.negPoints.length}`;
		refreshNode(node);
	}

	function drawPoints() {
		while (overlay.firstChild) {
			overlay.removeChild(overlay.firstChild);
		}
		const bounds = editor.getImageBounds();
		if (!bounds) {
			return;
		}
		const drawOne = (point, color) => {
			const cx = bounds.left + (point.x / bounds.naturalWidth) * bounds.width;
			const cy = bounds.top + (point.y / bounds.naturalHeight) * bounds.height;
			const outer = document.createElementNS("http://www.w3.org/2000/svg", "circle");
			outer.setAttribute("cx", String(cx));
			outer.setAttribute("cy", String(cy));
			outer.setAttribute("r", "10");
			outer.setAttribute("fill", "none");
			outer.setAttribute("stroke", color);
			outer.setAttribute("stroke-width", "2");
			overlay.appendChild(outer);
			const inner = document.createElementNS("http://www.w3.org/2000/svg", "circle");
			inner.setAttribute("cx", String(cx));
			inner.setAttribute("cy", String(cy));
			inner.setAttribute("r", "5");
			inner.setAttribute("fill", color);
			overlay.appendChild(inner);
		};
		editor.posPoints.forEach((point) => drawOne(point, "#53df82"));
		editor.negPoints.forEach((point) => drawOne(point, "#ff6d6d"));
	}

	const editor = {
		root,
		img,
		overlay,
		empty,
		posPoints: safeParse(posWidget?.value),
		negPoints: safeParse(negWidget?.value),
		setImage(base64) {
			if (!base64) {
				img.style.display = "none";
				empty.style.display = "flex";
				drawPoints();
				return;
			}
			img.src = `data:image/png;base64,${base64}`;
			img.style.display = "block";
			empty.style.display = "none";
		},
		getImageBounds() {
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
			return {
				left,
				top,
				width,
				height,
				naturalWidth: img.naturalWidth,
				naturalHeight: img.naturalHeight,
			};
		},
		toPoint(event) {
			const bounds = editor.getImageBounds();
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
				x: Math.round(((localX - bounds.left) / bounds.width) * bounds.naturalWidth),
				y: Math.round(((localY - bounds.top) / bounds.height) * bounds.naturalHeight),
			};
		},
	};

	clearButton.addEventListener("click", () => {
		editor.posPoints = [];
		editor.negPoints = [];
		writeBack();
		drawPoints();
	});

	wrap.addEventListener("click", (event) => {
		if (!img.src) {
			return;
		}
		const point = editor.toPoint(event);
		if (!point) {
			return;
		}
		editor.posPoints.push(point);
		writeBack();
		drawPoints();
	});

	wrap.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		if (!img.src) {
			return;
		}
		const point = editor.toPoint(event);
		if (!point) {
			return;
		}
		editor.negPoints.push(point);
		writeBack();
		drawPoints();
	});

	img.addEventListener("load", () => {
		drawPoints();
	});

	const widget = node.addDOMWidget?.(EDITOR_WIDGET, EDITOR_WIDGET, root, {
		hideOnZoom: false,
		getHeight: () => EDITOR_HEIGHT,
	});

	node.__gjjSem2Editor = { widget, editor, drawPoints };
	writeBack();
	drawPoints();
	return node.__gjjSem2Editor;
}

function patchNode(node) {
	if (!node || node.__gjjSem2Patched) {
		return;
	}
	node.__gjjSem2Patched = true;
	hideWidget(node, node.widgets?.find((w) => w.name === POS_WIDGET));
	hideWidget(node, node.widgets?.find((w) => w.name === NEG_WIDGET));
	ensureStatus(node);
	ensureEditor(node);
	setStatus(node, "等待执行");

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function () {
		const result = originalOnConfigure?.apply(this, arguments);
		hideWidget(this, this.widgets?.find((w) => w.name === POS_WIDGET));
		hideWidget(this, this.widgets?.find((w) => w.name === NEG_WIDGET));
		ensureStatus(this);
		ensureEditor(this);
		this.__gjjSem2Editor.editor.posPoints = safeParse(this.widgets?.find((w) => w.name === POS_WIDGET)?.value);
		this.__gjjSem2Editor.editor.negPoints = safeParse(this.widgets?.find((w) => w.name === NEG_WIDGET)?.value);
		this.__gjjSem2Editor.drawPoints();
		return result;
	};

	const originalOnExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = originalOnExecuted?.apply(this, arguments);
		if (message?.bg_image?.[0]) {
			ensureEditor(this).editor.setImage(message.bg_image[0]);
			ensureEditor(this).drawPoints();
		}
		return result;
	};
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensureStatus(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.SEM2PointSegmenter",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalOnNodeCreated?.apply(this, arguments);
			patchNode(this);
			return result;
		};
	},
});

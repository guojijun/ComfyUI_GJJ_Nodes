/**
 * GJJ 节点帮助按钮管理器
 * 
 * 将帮助按钮（?）固定到 GJJ 节点标题栏。
 *
 * 不再使用 DOMWidget 伪装标题栏按钮。DOMWidget 的坐标会跟随正文控件布局，
 * 在部分节点上会掉到输入口区域。这里使用全局 DOM 按钮贴到画布标题栏坐标，
 * 并保留 canvas 自绘兜底，避免节点 clip_area 或 title_buttons 差异导致按钮消失。
 */

import { app } from "/scripts/app.js";

// GJJ 节点前缀列表
const GJJ_NODE_PREFIXES = ["GJJ_"];
const SKIP_HELP_BUTTON_CLASSES = new Set(["GJJ_WorkflowTitle"]);
const PATCH_FLAG = "__gjjHeaderHelpButtonPatched";
const CANVAS_SYNC_FLAG = "__gjjHeaderHelpOverlayDrawPatched";
const FALLBACK_WIDGET_NAME = "gjj_header_help_button";
const DOM_BUTTON_CLASS = "gjj-header-help-overlay-button";
const HELP_BUTTON_SIZE = 20;
const HELP_BUTTON_RIGHT = 12;
const DOM_BUTTON_SIZE = 20;
const DOM_BUTTON_FONT_SIZE = 18;
const DOM_BUTTON_MIN_SCALE = 0.42;
const DOM_BUTTON_MIN_SIZE = 9;
const DOM_BUTTON_MAX_SIZE = 34;
const HELP_BUTTONS = new Map();
let overlayStylesInstalled = false;
let overlayUpdateRaf = 0;
let overlayUpdateTimer = 0;
let overlayTrackingRaf = 0;
let lastOverlayViewSignature = "";
let overlayUpdateInProgress = false;

// 帮助文档 URL 映射
const HELP_URLS = {
	"default": "https://github.com/guojijun/ComfyUI_GJJ",
};

/**
 * 获取节点的帮助 URL
 */
function getNodeHelpUrl(nodeType) {
	return HELP_URLS[nodeType] || HELP_URLS["default"];
}

/**
 * 检查是否为 GJJ 节点
 */
function isGJJNode(node) {
	if (!node?.comfyClass) return false;
	if (SKIP_HELP_BUTTON_CLASSES.has(String(node.comfyClass || ""))) return false;
	return GJJ_NODE_PREFIXES.some(prefix => node.comfyClass.startsWith(prefix));
}

function openNodeHelp(node) {
	const standardizer = globalThis.GJJ_CommonNodeStandardizer;
	if (typeof standardizer?.showHelpDialog === "function") {
		standardizer.showHelpDialog(node);
		return;
	}
	const helpUrl = getNodeHelpUrl(node?.comfyClass);
	window.open(helpUrl, "_blank");
}

function refreshCanvas(node) {
	try {
		node?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	} catch (_) {}
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function titleHeight() {
	return Math.max(24, Number(globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 30));
}

function getButtonRect(node) {
	const width = Math.max(120, Number(node?.size?.[0] || 120));
	const headerHeight = titleHeight();
	return {
		x: Math.max(34, width - HELP_BUTTON_SIZE - HELP_BUTTON_RIGHT),
		y: -headerHeight + Math.max(2, (headerHeight - HELP_BUTTON_SIZE) / 2),
		w: HELP_BUTTON_SIZE,
		h: HELP_BUTTON_SIZE,
	};
}

function isPointInRect(point, rect) {
	return point
		&& point[0] >= rect.x
		&& point[0] <= rect.x + rect.w
		&& point[1] >= rect.y
		&& point[1] <= rect.y + rect.h;
}

function getLocalPos(node, pos, event) {
	if (Array.isArray(pos)) {
		return pos;
	}
	if (event && typeof event.canvasX === "number" && typeof event.canvasY === "number") {
		return [event.canvasX - Number(node?.pos?.[0] || 0), event.canvasY - Number(node?.pos?.[1] || 0)];
	}
	if (event && app.canvas?.convertEventToCanvasOffset) {
		const converted = app.canvas.convertEventToCanvasOffset(event);
		if (Array.isArray(converted)) {
			return [converted[0] - Number(node?.pos?.[0] || 0), converted[1] - Number(node?.pos?.[1] || 0)];
		}
	}
	return [0, 0];
}

function drawHelpButton(node, ctx) {
	if (!ctx || !isGJJNode(node)) {
		return;
	}
	if (node.__gjjHeaderHelpDomActive) {
		return;
	}
	const rect = getButtonRect(node);
	node.__gjjHeaderHelpButtonRect = rect;

	ctx.save();
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.font = "bold 18px Arial, sans-serif";
	ctx.fillStyle = node.__gjjHeaderHelpHover ? "#ffd45a" : "#ffb000";
	ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
	ctx.shadowBlur = 2;
	ctx.fillText("?", rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5);
	ctx.restore();
}

function removeFallbackHelpButton(node) {
	if (!node) {
		return false;
	}
	let removed = false;
	if (Array.isArray(node.widgets)) {
		for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
			if (String(node.widgets[index]?.name || "") === FALLBACK_WIDGET_NAME) {
				node.widgets.splice(index, 1);
				removed = true;
			}
		}
	}
	node.__gjjHeaderHelpState?.wrap?.remove?.();
	if (node.__gjjHeaderHelpWidget || node.__gjjHeaderHelpState) {
		delete node.__gjjHeaderHelpWidget;
		delete node.__gjjHeaderHelpState;
		removed = true;
	}
	return removed;
}

function installOverlayStyles() {
	if (overlayStylesInstalled || document.getElementById("gjj-header-help-overlay-style")) {
		overlayStylesInstalled = true;
		return;
	}
	const style = document.createElement("style");
	style.id = "gjj-header-help-overlay-style";
	style.textContent = `
		.${DOM_BUTTON_CLASS} {
			position: fixed;
			display: none;
			align-items: center;
			justify-content: center;
			box-sizing: border-box;
			padding: 0;
			border: 0;
			background: transparent;
			color: #ffb000;
			font-family: Arial, sans-serif;
			font-weight: 800;
			line-height: 1;
			text-align: center;
			text-shadow: 0 1px 3px rgba(0, 0, 0, 0.72);
			cursor: pointer;
			pointer-events: auto;
			z-index: 20;
		}
		.${DOM_BUTTON_CLASS}:hover {
			color: #ffd45a;
		}
	`;
	document.head.appendChild(style);
	overlayStylesInstalled = true;
}

function nodeKey(node) {
	if (!node) {
		return "";
	}
	if (!node.__gjjHeaderHelpDomKey) {
		node.__gjjHeaderHelpDomKey = `${node.comfyClass || node.type || "GJJ"}:${node.id ?? Math.random().toString(36).slice(2)}`;
	}
	return node.__gjjHeaderHelpDomKey;
}

function removeDomHelpButton(node) {
	const key = nodeKey(node);
	if (!key) {
		return;
	}
	const state = HELP_BUTTONS.get(key);
	state?.button?.remove?.();
	HELP_BUTTONS.delete(key);
	if (node) {
		node.__gjjHeaderHelpDomActive = false;
		node.__gjjHeaderHelpDomVisible = false;
	}
}

function ensureDomHelpButton(node) {
	if (!isGJJNode(node)) {
		return null;
	}
	installOverlayStyles();
	const key = nodeKey(node);
	let state = HELP_BUTTONS.get(key);
	if (state?.button?.isConnected) {
		state.node = node;
		node.__gjjHeaderHelpDomActive = true;
		return state.button;
	}
	const button = document.createElement("button");
	button.type = "button";
	button.className = DOM_BUTTON_CLASS;
	button.textContent = "?";
	button.title = `查看 ${node?.title || node?.comfyClass || "GJJ 节点"} 的功能、模型和依赖`;
	button.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
	});
	button.addEventListener("mousedown", (event) => {
		event.preventDefault();
		event.stopPropagation();
	});
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openNodeHelp(node);
	});
	document.body.appendChild(button);
	state = { node, button };
	HELP_BUTTONS.set(key, state);
	node.__gjjHeaderHelpDomActive = true;
	return button;
}

function hideDomHelpButton(node, button) {
	if (button) {
		button.style.display = "none";
	}
	if (node) {
		node.__gjjHeaderHelpDomVisible = false;
	}
}

function graphPointToClient(canvas, x, y) {
	const element = canvas?.canvas;
	const rect = element?.getBoundingClientRect?.();
	if (!rect) {
		return null;
	}
	const converted = typeof canvas.convertOffsetToCanvas === "function"
		? canvas.convertOffsetToCanvas([x, y])
		: [
			(x + Number(canvas?.ds?.offset?.[0] || 0)) * Number(canvas?.ds?.scale || 1),
			(y + Number(canvas?.ds?.offset?.[1] || 0)) * Number(canvas?.ds?.scale || 1),
		];
	return {
		x: rect.left + converted[0],
		y: rect.top + converted[1],
		canvasRect: rect,
	};
}

function clientPointToGraph(canvas, x, y) {
	const element = canvas?.canvas;
	const rect = element?.getBoundingClientRect?.();
	if (!rect) {
		return null;
	}
	const canvasPoint = [x - rect.left, y - rect.top];
	if (typeof canvas.convertCanvasToOffset === "function") {
		return canvas.convertCanvasToOffset(canvasPoint);
	}
	const scale = Math.max(0.1, Number(canvas?.ds?.scale || 1));
	const offset = canvas?.ds?.offset || [0, 0];
	return [
		canvasPoint[0] / scale - Number(offset[0] || 0),
		canvasPoint[1] / scale - Number(offset[1] || 0),
	];
}

function nodeContainsGraphPoint(node, x, y) {
	if (!node) {
		return false;
	}
	if (typeof node.isPointInside === "function") {
		return Boolean(node.isPointInside(x, y));
	}
	const rect = node.boundingRect;
	if (rect && typeof rect.containsXy === "function") {
		return rect.containsXy(x, y);
	}
	if (Array.isArray(rect)) {
		return x >= rect[0] && x <= rect[0] + rect[2] && y >= rect[1] && y <= rect[1] + rect[3];
	}
	const headerHeight = titleHeight();
	const nodeX = Number(node.pos?.[0] || 0);
	const nodeY = Number(node.pos?.[1] || 0) - headerHeight;
	const width = Math.max(120, Number(node.size?.[0] || 120));
	const height = Number(node.size?.[1] || 0) + headerHeight;
	return x >= nodeX && x <= nodeX + width && y >= nodeY && y <= nodeY + height;
}

function graphRectForNode(node) {
	const rect = node?.boundingRect;
	if (Array.isArray(rect) && Number.isFinite(Number(rect[0]))) {
		return [
			Number(rect[0]),
			Number(rect[1]),
			Math.max(0, Number(rect[2])),
			Math.max(0, Number(rect[3])),
		];
	}
	const headerHeight = titleHeight();
	return [
		Number(node?.pos?.[0] || 0),
		Number(node?.pos?.[1] || 0) - headerHeight,
		Math.max(120, Number(node?.size?.[0] || 120)),
		Math.max(0, Number(node?.size?.[1] || 0) + headerHeight),
	];
}

function graphRectForDomButton(left, top, size, canvasRect) {
	const topLeft = clientPointToGraph(app.canvas, left, top);
	const bottomRight = clientPointToGraph(app.canvas, left + size, top + size);
	if (!topLeft || !bottomRight) {
		return null;
	}
	return [
		Math.min(topLeft[0], bottomRight[0]),
		Math.min(topLeft[1], bottomRight[1]),
		Math.abs(bottomRight[0] - topLeft[0]),
		Math.abs(bottomRight[1] - topLeft[1]),
	];
}

function rectsOverlap(a, b) {
	return Boolean(
		a && b
		&& a[0] < b[0] + b[2]
		&& a[0] + a[2] > b[0]
		&& a[1] < b[1] + b[3]
		&& a[1] + a[3] > b[1]
	);
}

function drawOrderNodes() {
	const visible = app.canvas?.visible_nodes;
	if (Array.isArray(visible) && visible.length) {
		return visible;
	}
	return Array.isArray(app.graph?._nodes) ? app.graph._nodes : [];
}

function isNodeDrawnAbove(candidate, node, nodes) {
	if (!candidate || candidate === node) {
		return false;
	}
	if (candidate.selected && !node?.selected) {
		return true;
	}
	const candidateIndex = nodes.indexOf(candidate);
	const nodeIndex = nodes.indexOf(node);
	if (candidateIndex >= 0 && nodeIndex >= 0) {
		return candidateIndex > nodeIndex;
	}
	return false;
}

function isDomButtonOccluded(node, left, top, size, canvasRect) {
	const buttonRect = graphRectForDomButton(left, top, size, canvasRect);
	const nodes = drawOrderNodes();
	if (buttonRect) {
		for (let index = nodes.length - 1; index >= 0; index -= 1) {
			const candidate = nodes[index];
			if (!isNodeDrawnAbove(candidate, node, nodes)) {
				continue;
			}
			if (rectsOverlap(buttonRect, graphRectForNode(candidate))) {
				return true;
			}
		}
	}
	const inset = Math.max(1, Math.min(4, size * 0.2));
	const points = [
		[left + size / 2, top + size / 2],
		[left + inset, top + inset],
		[left + size - inset, top + inset],
		[left + inset, top + size - inset],
		[left + size - inset, top + size - inset],
	];
	for (const [clientX, clientY] of points) {
		if (
			clientX < canvasRect.left
			|| clientX > canvasRect.right
			|| clientY < canvasRect.top
			|| clientY > canvasRect.bottom
		) {
			continue;
		}
		const graphPoint = clientPointToGraph(app.canvas, clientX, clientY);
		if (!graphPoint) {
			continue;
		}
		const topNode = nodes.findLast
			? nodes.findLast((candidate) => nodeContainsGraphPoint(candidate, graphPoint[0], graphPoint[1]))
			: [...nodes].reverse().find((candidate) => nodeContainsGraphPoint(candidate, graphPoint[0], graphPoint[1]));
		if (isNodeDrawnAbove(topNode, node, nodes)) {
			return true;
		}
	}
	return false;
}

function isCollapsed(node) {
	return Boolean(node?.flags?.collapsed || node?.collapsed);
}

function updateDomHelpButton(node) {
	const button = ensureDomHelpButton(node);
	const canvas = app.canvas;
	if (!button || !canvas?.canvas || !isGJJNode(node) || isCollapsed(node)) {
		hideDomHelpButton(node, button);
		return;
	}
	const width = Math.max(120, Number(node?.size?.[0] || 120));
	const headerHeight = titleHeight();
	const titleTopLeft = graphPointToClient(
		canvas,
		Number(node.pos?.[0] || 0),
		Number(node.pos?.[1] || 0) - headerHeight,
	);
	const titleTopRight = graphPointToClient(
		canvas,
		Number(node.pos?.[0] || 0) + width,
		Number(node.pos?.[1] || 0) - headerHeight,
	);
	if (!titleTopLeft || !titleTopRight) {
		hideDomHelpButton(node, button);
		return;
	}

	const scale = Math.max(0.1, Number(canvas?.ds?.scale || 1));
	const headerScreenHeight = Math.max(0, headerHeight * scale);
	if (scale < DOM_BUTTON_MIN_SCALE || headerScreenHeight < DOM_BUTTON_MIN_SIZE) {
		hideDomHelpButton(node, button);
		return;
	}
	const size = clamp(DOM_BUTTON_SIZE * scale, DOM_BUTTON_MIN_SIZE, DOM_BUTTON_MAX_SIZE);
	const fontSize = clamp(DOM_BUTTON_FONT_SIZE * scale, 8, DOM_BUTTON_MAX_SIZE - 3);
	const rightInset = clamp(HELP_BUTTON_RIGHT * scale, 5, 16);
	const left = titleTopRight.x - size - rightInset;
	const top = titleTopLeft.y + (headerScreenHeight - size) / 2;
	const { canvasRect } = titleTopLeft;
	const insideCanvas = (
		left + size >= canvasRect.left
		&& left <= canvasRect.right
		&& top + size >= canvasRect.top
		&& top <= canvasRect.bottom
	);
	if (!insideCanvas) {
		hideDomHelpButton(node, button);
		return;
	}
	if (isDomButtonOccluded(node, left, top, size, canvasRect)) {
		hideDomHelpButton(node, button);
		return;
	}
	button.style.display = "flex";
	button.style.left = `${left}px`;
	button.style.top = `${top}px`;
	button.style.width = `${size}px`;
	button.style.height = `${size}px`;
	button.style.fontSize = `${fontSize}px`;
	button.title = `查看 ${node?.title || node?.comfyClass || "GJJ 节点"} 的功能、模型和依赖`;
	node.__gjjHeaderHelpDomVisible = true;
}

function updateAllDomHelpButtons() {
	if (overlayUpdateInProgress) {
		return;
	}
	overlayUpdateInProgress = true;
	try {
		const nodes = Array.isArray(app.graph?._nodes) ? app.graph._nodes : [];
		const activeKeys = new Set();
		for (const node of nodes) {
			if (!isGJJNode(node)) {
				continue;
			}
			const key = nodeKey(node);
			activeKeys.add(key);
			updateDomHelpButton(node);
		}
		for (const [key, state] of HELP_BUTTONS.entries()) {
			if (!activeKeys.has(key)) {
				state?.button?.remove?.();
				if (state?.node) {
					state.node.__gjjHeaderHelpDomActive = false;
					state.node.__gjjHeaderHelpDomVisible = false;
				}
				HELP_BUTTONS.delete(key);
			}
		}
		lastOverlayViewSignature = overlayViewSignature();
	} finally {
		overlayUpdateInProgress = false;
	}
}

function updateAllDomHelpButtonsSafely() {
	try {
		updateAllDomHelpButtons();
	} catch (error) {
		console.warn("[GJJ] 帮助按钮位置同步失败:", error);
	}
}

function scheduleOverlayUpdate() {
	if (overlayUpdateRaf) {
		return;
	}
	overlayUpdateRaf = requestAnimationFrame(() => {
		overlayUpdateRaf = 0;
		updateAllDomHelpButtonsSafely();
	});
}

function overlayViewSignature() {
	const canvas = app.canvas;
	const element = canvas?.canvas;
	const rect = element?.getBoundingClientRect?.();
	const offset = canvas?.ds?.offset || [];
	return [
		Number(canvas?.ds?.scale || 0).toFixed(5),
		Number(offset[0] || 0).toFixed(5),
		Number(offset[1] || 0).toFixed(5),
		rect ? Math.round(rect.left) : 0,
		rect ? Math.round(rect.top) : 0,
		rect ? Math.round(rect.width) : 0,
		rect ? Math.round(rect.height) : 0,
	].join("|");
}

function patchCanvasDrawSync() {
	const canvas = app.canvas;
	if (!canvas || canvas[CANVAS_SYNC_FLAG]) {
		return;
	}
	const originalDraw = canvas.draw;
	if (typeof originalDraw !== "function") {
		return;
	}
	canvas[CANVAS_SYNC_FLAG] = true;
	canvas.draw = function(...args) {
		try {
			return originalDraw.apply(this, args);
		} finally {
			updateAllDomHelpButtonsSafely();
		}
	};
}

function startOverlayTrackingLoop() {
	if (overlayTrackingRaf) {
		return;
	}
	const tick = () => {
		patchCanvasDrawSync();
		attachCanvasOverlayEvents();
		const signature = overlayViewSignature();
		if (signature !== lastOverlayViewSignature) {
			lastOverlayViewSignature = signature;
			updateAllDomHelpButtonsSafely();
		}
		overlayTrackingRaf = requestAnimationFrame(tick);
	};
	overlayTrackingRaf = requestAnimationFrame(tick);
}

function attachCanvasOverlayEvents() {
	const element = app.canvas?.canvas;
	if (!element || element.__gjjHeaderHelpOverlayEvents) {
		return;
	}
	element.__gjjHeaderHelpOverlayEvents = true;
	for (const eventName of ["pointerdown", "pointermove", "pointerup", "wheel", "mousewheel"]) {
		element.addEventListener(eventName, scheduleOverlayUpdate, { capture: true, passive: true });
	}
}

function startOverlayUpdater() {
	installOverlayStyles();
	if (!overlayUpdateTimer) {
		overlayUpdateTimer = window.setInterval(updateAllDomHelpButtonsSafely, 1000);
		window.addEventListener("resize", scheduleOverlayUpdate);
		window.addEventListener("scroll", scheduleOverlayUpdate, true);
	}
	patchCanvasDrawSync();
	attachCanvasOverlayEvents();
	startOverlayTrackingLoop();
	scheduleOverlayUpdate();
}

/**
 * 在节点标题栏绘制帮助按钮并处理点击
 */
function setupHelpButton(nodeType) {
	if (!nodeType?.prototype || nodeType.prototype[PATCH_FLAG]) {
		return;
	}
	nodeType.prototype[PATCH_FLAG] = true;
	const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
	const originalOnConfigure = nodeType.prototype.onConfigure;
	const originalOnResize = nodeType.prototype.onResize;
	const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
	const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
	const originalOnMouseMove = nodeType.prototype.onMouseMove;
	const originalOnMouseDown = nodeType.prototype.onMouseDown;

	nodeType.prototype.onNodeCreated = function(...args) {
		const result = originalOnNodeCreated?.apply(this, args);
		if (removeFallbackHelpButton(this)) {
			refreshCanvas(this);
		}
		updateDomHelpButton(this);
		return result;
	};

	nodeType.prototype.onConfigure = function(...args) {
		const result = originalOnConfigure?.apply(this, args);
		setTimeout(() => {
			if (removeFallbackHelpButton(this)) {
				refreshCanvas(this);
			}
			updateDomHelpButton(this);
		}, 0);
		return result;
	};

	nodeType.prototype.onResize = function(...args) {
		const result = originalOnResize?.apply(this, args);
		scheduleOverlayUpdate();
		refreshCanvas(this);
		return result;
	};

	nodeType.prototype.onConnectionsChange = function(...args) {
		const result = originalOnConnectionsChange?.apply(this, args);
		scheduleOverlayUpdate();
		refreshCanvas(this);
		return result;
	};

	nodeType.prototype.onDrawForeground = function(...args) {
		const result = originalOnDrawForeground?.apply(this, args);
		drawHelpButton(this, args[0]);
		scheduleOverlayUpdate();
		return result;
	};

	nodeType.prototype.onMouseMove = function(event, pos, canvas) {
		const rect = this.__gjjHeaderHelpButtonRect || getButtonRect(this);
		const hover = isPointInRect(getLocalPos(this, pos, event), rect);
		if (Boolean(this.__gjjHeaderHelpHover) !== hover) {
			this.__gjjHeaderHelpHover = hover;
			refreshCanvas(this);
		}
		scheduleOverlayUpdate();
		return originalOnMouseMove?.apply(this, arguments);
	};

	nodeType.prototype.onMouseDown = function(event, pos, canvas) {
		const rect = this.__gjjHeaderHelpButtonRect || getButtonRect(this);
		if (isPointInRect(getLocalPos(this, pos, event), rect)) {
			event?.preventDefault?.();
			event?.stopPropagation?.();
			openNodeHelp(this);
			return true;
		}
		return originalOnMouseDown?.apply(this, arguments);
	};
}

/**
 * 注册扩展
 */
app.registerExtension({
	name: "GJJ.HelpButtonManager",
	
	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		// 只为 GJJ 节点添加帮助按钮
		if (isGJJNode({ comfyClass: nodeData?.name })) {
			setupHelpButton(nodeType);
		}
	},
	
	async setup() {
		for (const node of app.graph?._nodes || []) {
			if (isGJJNode(node)) {
				removeFallbackHelpButton(node);
				updateDomHelpButton(node);
				refreshCanvas(node);
			}
		}
		startOverlayUpdater();
		console.log("[GJJ] ✅ 帮助按钮管理器已加载 - 所有 GJJ 节点的 ? 按钮将显示在标题栏右上角");
	},
});

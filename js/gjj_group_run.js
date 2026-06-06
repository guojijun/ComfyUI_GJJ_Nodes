import { app } from "/scripts/app.js";

const BUTTON_ID_PREFIX = "gjj-group-run-button-";
const OVERLAY_ID = "gjj-group-run-overlay";
const BUTTON_SIZE = 18;
const BUTTON_MIN_SIZE = 12;
const BUTTON_MAX_SIZE = 22;
const BUTTON_MIN_SCALE = 0.42;
const TITLE_TOP = 5;
const TITLE_RIGHT = 6;
const BYPASS_MODE = 4;

const buttonByGroupId = new Map();
const syntheticGroupIds = new WeakMap();
let overlayElement = null;
let syncScheduled = false;
let loopStarted = false;
let canvasDrawPatched = false;
let runningGroupId = null;
let nextSyntheticGroupId = 1;

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function getCanvas() {
	return app.canvas?.canvas || app.canvas?.htmlCanvas || null;
}

function getCanvasRect() {
	const canvas = getCanvas();
	return canvas?.getBoundingClientRect?.() || null;
}

function getGraphScale() {
	return Number(app.canvas?.ds?.scale || 1);
}

function getGraphOffset() {
	const offset = app.canvas?.ds?.offset;
	return isArrayLikeBounds(offset) ? [Number(offset[0] || 0), Number(offset[1] || 0)] : [0, 0];
}

function isArrayLikeBounds(value) {
	return value && typeof value.length === "number" && value.length >= 2;
}

function getGroups() {
	return Array.isArray(app.graph?._groups) ? app.graph._groups : [];
}

function getGroupId(group) {
	const rawId = group?.id;
	if (rawId !== undefined && rawId !== null && String(rawId) !== "") {
		return String(rawId);
	}
	if (!group || typeof group !== "object") {
		return "";
	}
	if (!syntheticGroupIds.has(group)) {
		syntheticGroupIds.set(group, `synthetic-${nextSyntheticGroupId}`);
		nextSyntheticGroupId += 1;
	}
	return syntheticGroupIds.get(group);
}

function getGroupNodes(group) {
	group?.recomputeInsideNodes?.();
	return Array.isArray(group?._nodes) ? group._nodes.filter(Boolean) : [];
}

function getGroupBounds(group) {
	const pos = isArrayLikeBounds(group?.pos) ? group.pos : [0, 0];
	const size = isArrayLikeBounds(group?.size) ? group.size : [0, 0];
	return {
		x: Number(pos[0] || 0),
		y: Number(pos[1] || 0),
		w: Math.max(0, Number(size[0] || 0)),
		h: Math.max(0, Number(size[1] || 0)),
	};
}

function graphToClient(x, y) {
	const canvas = app.canvas;
	const canvasRect = canvas?.canvas?.getBoundingClientRect?.() || getCanvasRect();
	if (!canvasRect) {
		return null;
	}

	const canvasPos = typeof canvas?.convertOffsetToCanvas === "function"
		? canvas.convertOffsetToCanvas([x, y])
		: null;
	if (isArrayLikeBounds(canvasPos)) {
		return {
			x: canvasRect.left + Number(canvasPos[0] || 0),
			y: canvasRect.top + Number(canvasPos[1] || 0),
			canvasRect,
		};
	}

	const scale = getGraphScale();
	const [offsetX, offsetY] = getGraphOffset();
	return {
		x: canvasRect.left + (x + offsetX) * scale,
		y: canvasRect.top + (y + offsetY) * scale,
		canvasRect,
	};
}

function clientToGraph(x, y) {
	const canvas = app.canvas;
	const canvasRect = canvas?.canvas?.getBoundingClientRect?.() || getCanvasRect();
	if (!canvasRect) {
		return null;
	}
	const canvasPoint = [x - canvasRect.left, y - canvasRect.top];
	if (typeof canvas?.convertCanvasToOffset === "function") {
		return canvas.convertCanvasToOffset(canvasPoint);
	}
	const scale = Math.max(0.1, getGraphScale());
	const [offsetX, offsetY] = getGraphOffset();
	return [
		canvasPoint[0] / scale - offsetX,
		canvasPoint[1] / scale - offsetY,
	];
}

function graphRectForNode(node) {
	const rect = node?.boundingRect;
	if (Array.isArray(rect) && Number.isFinite(Number(rect[0]))) {
		return [
			Number(rect[0]),
			Number(rect[1]),
			Math.max(0, Number(rect[2] || 0)),
			Math.max(0, Number(rect[3] || 0)),
		];
	}
	const titleHeight = Number(globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 24);
	return [
		Number(node?.pos?.[0] || 0),
		Number(node?.pos?.[1] || 0) - titleHeight,
		Math.max(120, Number(node?.size?.[0] || 120)),
		Math.max(0, Number(node?.size?.[1] || 0) + titleHeight),
	];
}

function graphRectForButton(left, top, size) {
	const topLeft = clientToGraph(left, top);
	const bottomRight = clientToGraph(left + size, top + size);
	if (!topLeft || !bottomRight) {
		return null;
	}
	return [
		Math.min(Number(topLeft[0] || 0), Number(bottomRight[0] || 0)),
		Math.min(Number(topLeft[1] || 0), Number(bottomRight[1] || 0)),
		Math.abs(Number(bottomRight[0] || 0) - Number(topLeft[0] || 0)),
		Math.abs(Number(bottomRight[1] || 0) - Number(topLeft[1] || 0)),
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

function isButtonCoveredByNode(left, top, size) {
	const buttonRect = graphRectForButton(left, top, size);
	if (!buttonRect) {
		return false;
	}
	const nodes = Array.isArray(app.canvas?.visible_nodes) && app.canvas.visible_nodes.length
		? app.canvas.visible_nodes
		: (Array.isArray(app.graph?._nodes) ? app.graph._nodes : []);
	return nodes.some((node) => rectsOverlap(buttonRect, graphRectForNode(node)));
}

function ensureOverlay() {
	if (overlayElement) {
		return overlayElement;
	}

	let overlay = document.getElementById(OVERLAY_ID);
	if (!overlay) {
		overlay = document.createElement("div");
		overlay.id = OVERLAY_ID;
		overlay.style.cssText = [
			"position:fixed",
			"left:0",
			"top:0",
			"width:100vw",
			"height:100vh",
			"pointer-events:none",
			"z-index:20",
			"overflow:visible",
		].join(";");
		document.body.appendChild(overlay);
	}

	overlayElement = overlay;
	return overlayElement;
}

function createRunButton(groupId) {
	const button = document.createElement("button");
	button.type = "button";
	button.id = `${BUTTON_ID_PREFIX}${groupId}`;
	button.textContent = "▶";
	button.title = "运行当前组，仅暂时旁路其它组，结束后恢复原状态";
	button.setAttribute("aria-label", "运行当前组");
	button.style.cssText = [
		"position:absolute",
		"width:18px",
		"height:18px",
		"padding:0",
		"border:1px solid rgba(97, 170, 126, 0.75)",
		"border-radius:4px",
		"background:#21382b",
		"color:#d8f4df",
		"font:700 12px/16px sans-serif",
		"display:none",
		"align-items:center",
		"justify-content:center",
		"cursor:pointer",
		"pointer-events:auto",
		"box-sizing:border-box",
		"box-shadow:none",
	].join(";");

	const stop = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};

	button.addEventListener("pointerdown", stop);
	button.addEventListener("mousedown", stop);
	button.addEventListener("contextmenu", stop);
	button.addEventListener("click", async (event) => {
		stop(event);
		await runCurrentGroup(button.__gjjGroupRef, button);
	});

	return button;
}

function setButtonBusy(button, busy) {
	if (!button) {
		return;
	}
	button.textContent = busy ? "⏳" : "▶";
	button.style.opacity = busy ? "0.85" : "1";
	button.style.background = busy ? "#304f3d" : "#21382b";
}

function updateButtonPosition(group, button) {
	const bounds = getGroupBounds(group);
	if (bounds.w <= 0 || bounds.h <= 0) {
		button.style.display = "none";
		return;
	}

	const topRight = graphToClient(bounds.x + bounds.w, bounds.y);
	if (!topRight) {
		button.style.display = "none";
		return;
	}
	const canvasRect = topRight.canvasRect;
	const scale = Math.max(0.1, getGraphScale());
	if (scale < BUTTON_MIN_SCALE) {
		button.style.display = "none";
		return;
	}
	const size = clamp(BUTTON_SIZE * scale, BUTTON_MIN_SIZE, BUTTON_MAX_SIZE);
	const rightInset = clamp(TITLE_RIGHT * scale, 4, 14);
	const topInset = clamp(TITLE_TOP * scale, 3, 12);
	const left = topRight.x - size - rightInset;
	const top = topRight.y + topInset;
	if (
		left + size < canvasRect.left
		|| left > canvasRect.right
		|| top + size < canvasRect.top
		|| top > canvasRect.bottom
	) {
		button.style.display = "none";
		return;
	}
	if (isButtonCoveredByNode(left, top, size)) {
		button.style.display = "none";
		return;
	}

	button.style.display = "flex";
	button.style.left = `${left}px`;
	button.style.top = `${top}px`;
	button.style.width = `${size}px`;
	button.style.height = `${size}px`;
	button.style.fontSize = `${clamp(12 * scale, 9, 13)}px`;
	button.style.lineHeight = "1";
}

function syncButtons() {
	syncScheduled = false;
	const groups = getGroups();
	const liveIds = new Set();
	const overlay = ensureOverlay();

	for (const group of groups) {
		const groupId = getGroupId(group);
		if (!groupId) {
			continue;
		}
		liveIds.add(groupId);

		let button = buttonByGroupId.get(groupId);
		if (!button) {
			button = createRunButton(groupId);
			buttonByGroupId.set(groupId, button);
			overlay.appendChild(button);
		}
		button.__gjjGroupRef = group;

		const nodes = getGroupNodes(group);
		const hasNodes = nodes.length > 0;
		button.disabled = !hasNodes || Boolean(runningGroupId);
		button.title = hasNodes
			? "运行当前组，仅暂时旁路其它组，结束后恢复原状态"
			: "当前分组内没有可运行节点";
		setButtonBusy(button, runningGroupId === groupId);
		updateButtonPosition(group, button);
	}

	for (const [groupId, button] of buttonByGroupId.entries()) {
		if (liveIds.has(groupId)) {
			continue;
		}
		button.remove();
		buttonByGroupId.delete(groupId);
	}
}

function requestSync() {
	if (syncScheduled) {
		return;
	}
	syncScheduled = true;
	requestAnimationFrame(syncButtons);
}

function startLoop() {
	if (loopStarted) {
		return;
	}
	loopStarted = true;
	const tick = () => {
		requestSync();
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

function patchCanvasDrawSync() {
	const canvas = app.canvas;
	if (!canvas || canvasDrawPatched) {
		return;
	}
	const originalDraw = canvas.draw;
	if (typeof originalDraw !== "function") {
		return;
	}
	canvasDrawPatched = true;
	canvas.draw = function(...args) {
		const result = originalDraw.apply(this, args);
		requestSync();
		return result;
	};
}

function snapshotModes(nodes) {
	const snapshot = new Map();
	for (const node of nodes) {
		snapshot.set(String(node.id), Number(node.mode ?? 0));
	}
	return snapshot;
}

function applyModes(nodes, mode, exceptIds = new Set()) {
	for (const node of nodes) {
		if (exceptIds.has(String(node.id))) {
			continue;
		}
		node.mode = mode;
	}
}

async function runCurrentGroup(group, button) {
	if (!group || runningGroupId) {
		return;
	}

	const groupId = getGroupId(group);
	const groupNodes = getGroupNodes(group);
	if (!groupNodes.length) {
		return;
	}

	const graphNodes = Array.isArray(app.graph?._nodes) ? app.graph._nodes.filter(Boolean) : [];
	const targetIds = new Set(groupNodes.map((node) => String(node.id)));
	const snapshot = snapshotModes(graphNodes);

	runningGroupId = groupId;
	setButtonBusy(button, true);
	requestSync();

	try {
		app.graph?.beforeChange?.();
		applyModes(graphNodes, BYPASS_MODE, targetIds);
		app.graph?.afterChange?.();
		app.graph?.setDirtyCanvas?.(true, true);
		await app.queuePrompt(0);
	} catch (error) {
		console.error("[GJJ GroupRun] 运行当前组失败:", error);
		const message = error?.message || String(error || "未知错误");
		alert(`运行当前组失败：\n${message}`);
	} finally {
		app.graph?.beforeChange?.();
		for (const node of graphNodes) {
			const previousMode = snapshot.get(String(node.id));
			if (previousMode !== undefined) {
				node.mode = previousMode;
			}
		}
		app.graph?.afterChange?.();
		app.graph?.setDirtyCanvas?.(true, true);
		runningGroupId = null;
		requestSync();
	}
}

app.registerExtension({
	name: "GJJ.GroupRunButton",

	setup() {
		ensureOverlay();
		patchCanvasDrawSync();
		startLoop();
		requestSync();
	},

	nodeCreated() {
		requestSync();
	},
});

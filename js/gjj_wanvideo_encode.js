import { app } from "/scripts/app.js";

const TARGET_NODE = "GJJ_WanVideoEncode";
const ENABLE_WIDGET = "enable_vae_tiling";
const TILING_WIDGETS = ["tile_x", "tile_y", "tile_stride_x", "tile_stride_y"];

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function widgetEnabled(widget) {
	const value = widget?.value;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	return ["1", "true", "yes", "on", "开", "开启", "启用"].includes(String(value ?? "").trim().toLowerCase());
}

function inputLinked(node, name) {
	const input = node?.inputs?.find((item) => item?.name === name);
	return input?.link != null;
}

function rememberWidget(widget) {
	if (!widget || widget.__gjjWanEncodeOriginal) return;
	widget.__gjjWanEncodeOriginal = {
		hidden: widget.hidden,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		type: widget.type,
	};
}

function setWidgetVisible(widget, visible) {
	if (!widget) return;
	rememberWidget(widget);
	const original = widget.__gjjWanEncodeOriginal || {};
	if (visible) {
		widget.hidden = Boolean(original.hidden);
		widget.type = original.type ?? widget.type;
		if (original.computeSize !== undefined) widget.computeSize = original.computeSize;
		else delete widget.computeSize;
		if (original.getHeight !== undefined) widget.getHeight = original.getHeight;
		else delete widget.getHeight;
		if (original.draw !== undefined) widget.draw = original.draw;
		else delete widget.draw;
		return;
	}
	widget.hidden = true;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
}

function resizeNode(node) {
	if (!node?.size) return;
	const currentWidth = Math.max(300, Number(node.size[0] || 300));
	const computed = node.computeSize?.() || node.size;
	const nextHeight = Math.max(80, Number(computed?.[1] || node.size[1] || 80));
	node.setSize?.([currentWidth, nextHeight]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function updateTilingWidgets(node) {
	if (!node) return;
	const enableWidget = findWidget(node, ENABLE_WIDGET);
	const visible = widgetEnabled(enableWidget) || inputLinked(node, ENABLE_WIDGET);
	for (const name of TILING_WIDGETS) {
		setWidgetVisible(findWidget(node, name), visible);
	}
	resizeNode(node);
}

function wrapEnableCallback(node) {
	const widget = findWidget(node, ENABLE_WIDGET);
	if (!widget || widget.__gjjWanEncodeWrapped) return;
	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		const result = originalCallback?.apply(this, args);
		setTimeout(() => updateTilingWidgets(node), 0);
		return result;
	};
	widget.__gjjWanEncodeWrapped = true;
}

function stabilize(node, delay = 0) {
	clearTimeout(node.__gjjWanEncodeTimer);
	node.__gjjWanEncodeTimer = setTimeout(() => {
		wrapEnableCallback(node);
		updateTilingWidgets(node);
	}, delay);
}

app.registerExtension({
	name: "Comfy.GJJ.WanVideoEncodeTilingPanel",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			stabilize(this, 0);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			stabilize(this, 0);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			stabilize(this, 0);
			return result;
		};
	},
	loadedGraphNode(node) {
		if (node?.comfyClass === TARGET_NODE) stabilize(node, 0);
	},
});

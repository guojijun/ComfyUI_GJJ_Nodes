import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_LTX23ImageToVideo"]);
const STATUS_WIDGET_NAME = "gjj_ltx23_i2v_status";
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const FRAME_COUNT_WIDGET = "frame_count";
const AUTO_SIZE_WIDGET = "auto_use_first_image_size";
const IMAGE_INPUT_NAME = "input_image";
const MULTI_IMAGE_LOADER_CLASS = "GJJ_MultiImageLoader";

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function getInput(node, name) {
	return node?.inputs?.find((input) => input?.name === name) || null;
}

function setWidgetValue(widget, value) {
	if (!widget || value == null) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
}

function roundUpTo32(value) {
	const numeric = Math.max(1, Number(value || 0) || 0);
	return Math.max(64, Math.ceil(numeric / 32) * 32);
}

function isAutoSizeEnabled(node) {
	return Boolean(getWidget(node, AUTO_SIZE_WIDGET)?.value);
}

function applyAlignedSize(node, width, height) {
	if (width == null || height == null) {
		return;
	}
	setWidgetValue(getWidget(node, WIDTH_WIDGET), roundUpTo32(width));
	setWidgetValue(getWidget(node, HEIGHT_WIDGET), roundUpTo32(height));
}

function applyFrameCount(node, frameCount) {
	if (frameCount == null) {
		return;
	}
	const value = Math.max(1, Math.round(Number(frameCount) || 1));
	setWidgetValue(getWidget(node, FRAME_COUNT_WIDGET), value);
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function getLinkedSourceNode(node) {
	const input = getInput(node, IMAGE_INPUT_NAME);
	const linkId = input?.link;
	if (linkId == null || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	return link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
}

function buildViewUrl(item) {
	if (!item?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "input")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function loadImageSizeFromUrl(url) {
	if (!url) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		return [];
	}
}

async function loadFirstImageSizeFromMultiImageLoader(sourceNode) {
	const state = sourceNode?.__gjjMultiImageState || {};
	const firstSelected = Array.isArray(state.selection) ? state.selection[0] : null;
	if (firstSelected?.width && firstSelected?.height) {
		return { width: Number(firstSelected.width), height: Number(firstSelected.height) };
	}
	const rawSelection = getWidget(sourceNode, "selected_images")?.value || sourceNode?.properties?.selected_images || "[]";
	const parsedSelection = parseSelection(rawSelection);
	const first = parsedSelection[0];
	if (first?.width && first?.height) {
		return { width: Number(first.width), height: Number(first.height) };
	}
	const executedImages = Array.isArray(state.executedImages) ? state.executedImages : [];
	const firstExecuted = executedImages[0];
	if (firstExecuted?.width && firstExecuted?.height) {
		return { width: Number(firstExecuted.width), height: Number(firstExecuted.height) };
	}
	if (firstExecuted?.filename) {
		return loadImageSizeFromUrl(buildViewUrl(firstExecuted));
	}
	return null;
}

async function loadFirstImageSizeFromSource(sourceNode) {
	if (!sourceNode) {
		return null;
	}
	if (sourceNode.comfyClass === MULTI_IMAGE_LOADER_CLASS) {
		return loadFirstImageSizeFromMultiImageLoader(sourceNode);
	}
	const imageWidget = getWidget(sourceNode, "image");
	const filename = String(imageWidget?.value || "").trim();
	if (filename) {
		return loadImageSizeFromUrl(buildViewUrl({ filename, type: "input" }));
	}
	return null;
}

async function trySyncImageSize(node, force = false) {
	if (!node || (!force && !isAutoSizeEnabled(node))) {
		return;
	}
	const sourceNode = getLinkedSourceNode(node);
	const size = await loadFirstImageSizeFromSource(sourceNode);
	if (!size?.width || !size?.height) {
		return;
	}
	applyAlignedSize(node, size.width, size.height);
	refreshNode(node);
}

function applyExecutionResolvedValues(node, message) {
	const width = message?.resolved_width?.[0];
	const height = message?.resolved_height?.[0];
	const frameCount = message?.resolved_frame_count?.[0];
	if (width != null && height != null && Number(message?.source_image_count?.[0] || 0) > 0) {
		applyAlignedSize(node, width, height);
	}
	if (frameCount != null) {
		applyFrameCount(node, frameCount);
	}
	refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjLtx23I2vStatus) {
		return node.__gjjLtx23I2vStatus;
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
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		hideOnZoom: false,
		getHeight: () => 42,
	});
	node.__gjjLtx23I2vStatus = { widget, box };
	return node.__gjjLtx23I2vStatus;
}

function setStatus(node, text) {
	const box = node?.__gjjLtx23I2vStatus?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjLtx23I2vPatched) {
		return;
	}
	node.__gjjLtx23I2vPatched = true;
	ensureStatusWidget(node);
	setStatus(node, "等待执行");
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.LTX23ImageToVideo",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			setTimeout(() => trySyncImageSize(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			setTimeout(() => trySyncImageSize(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => trySyncImageSize(this), 0);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalOnExecuted?.apply(this, [message, ...args]);
			patchNode(this);
			applyExecutionResolvedValues(this, message || {});
			return result;
		};
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_Wan22RapidAIOMega"]);
const STATUS_WIDGET_NAME = "gjj_wan22_rapid_aio_mega_status";
const MIN_WIDTH = 320;
const PANEL_HEIGHT = 88;
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const AUTO_SIZE_WIDGET = "auto_use_first_image_size";
const IMAGE_INPUT_NAME = "images";
const MULTI_IMAGE_LOADER_CLASS = "GJJ_MultiImageLoader";
const IMAGE_OPTIONS_API = "/gjj/input_images";

let loaderOptionsPromise = null;

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function getInput(node, name) {
	return node?.inputs?.find((input) => input?.name === name) || null;
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function roundUpTo32(value) {
	const numeric = Math.max(1, Number(value || 0) || 0);
	return Math.max(32, Math.ceil(numeric / 32) * 32);
}

function applyAlignedSize(node, width, height) {
	setWidgetValue(getWidget(node, WIDTH_WIDGET), roundUpTo32(width));
	setWidgetValue(getWidget(node, HEIGHT_WIDGET), roundUpTo32(height));
}

function isAutoSizeEnabled(node) {
	return Boolean(getWidget(node, AUTO_SIZE_WIDGET)?.value);
}

function getLinkedSourceNode(node) {
	const input = getInput(node, IMAGE_INPUT_NAME);
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	return link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		return [];
	}
}

async function fetchLoaderOptions() {
	if (!loaderOptionsPromise) {
		loaderOptionsPromise = fetch(IMAGE_OPTIONS_API)
			.then((response) => (response.ok ? response.json() : { images: [] }))
			.then((payload) => (Array.isArray(payload?.images) ? payload.images : []))
			.catch(() => []);
	}
	return loaderOptionsPromise;
}

function matchSelectionWithOptions(entry, options) {
	const filename = String(entry?.filename || "");
	const subfolder = String(entry?.subfolder || "");
	return (options || []).find((item) => (
		String(item?.filename || "") === filename &&
		String(item?.subfolder || "") === subfolder
	)) || null;
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

async function loadFirstImageSizeFromMultiImageLoader(sourceNode) {
	if (!sourceNode || sourceNode.comfyClass !== MULTI_IMAGE_LOADER_CLASS) {
		return null;
	}

	const state = sourceNode.__gjjMultiImageState || {};
	const firstSelected = Array.isArray(state.selection) ? state.selection[0] : null;
	if (firstSelected?.width && firstSelected?.height) {
		return { width: Number(firstSelected.width), height: Number(firstSelected.height) };
	}

	const rawSelection = getWidget(sourceNode, "selected_images")?.value
		|| sourceNode.properties?.selected_images
		|| "[]";
	const parsedSelection = parseSelection(rawSelection);
	if (parsedSelection.length > 0) {
		const matched = matchSelectionWithOptions(parsedSelection[0], await fetchLoaderOptions());
		if (matched?.width && matched?.height) {
			return { width: Number(matched.width), height: Number(matched.height) };
		}
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
	return null;
}

async function trySyncImageSize(node, force = false) {
	if (!node || (!force && !isAutoSizeEnabled(node))) {
		return;
	}
	const sourceNode = getLinkedSourceNode(node);
	if (!sourceNode) {
		return;
	}
	const size = await loadFirstImageSizeFromSource(sourceNode);
	if (!size?.width || !size?.height) {
		return;
	}
	applyAlignedSize(node, size.width, size.height);
	refreshNode(node);
}

function ensurePanelWidget(node) {
	if (node.__gjjWan22RapidMegaStatus) {
		return node.__gjjWan22RapidMegaStatus;
	}

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"min-height:42px",
		"padding:8px 10px",
		"border:1px solid #41535b",
		"border-radius:10px",
		"background:#121a1f",
	].join(";");

	const text = document.createElement("div");
	text.textContent = "等待执行";
	text.style.cssText = [
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.4",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");

	const progressOuter = document.createElement("div");
	progressOuter.style.cssText = [
		"height:6px",
		"border-radius:999px",
		"overflow:hidden",
		"background:#223038",
	].join(";");

	const progressInner = document.createElement("div");
	progressInner.style.cssText = [
		"height:100%",
		"width:0%",
		"background:linear-gradient(90deg,#72c1ff,#7ed6a7)",
		"transition:width 120ms ease",
	].join(";");
	progressOuter.appendChild(progressInner);
	wrap.append(text, progressOuter);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => PANEL_HEIGHT,
	});
	node.__gjjWan22RapidMegaStatus = { widget, wrap, text, progressInner };
	return node.__gjjWan22RapidMegaStatus;
}

function setStatus(node, detail = {}) {
	const state = node?.__gjjWan22RapidMegaStatus;
	if (!state) {
		return;
	}
	state.text.textContent = String(detail.text || "等待执行");
	const progress = Number.isFinite(detail.progress)
		? Math.max(0, Math.min(100, Number(detail.progress) * 100))
		: 0;
	state.progressInner.style.width = `${progress}%`;
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjWan22RapidMegaPatched) {
		return;
	}
	node.__gjjWan22RapidMegaPatched = true;
	ensurePanelWidget(node);
	setStatus(node, { text: "等待执行", progress: 0 });
	if (!Array.isArray(node.size) || node.size.length < 2) {
		node.setSize?.([MIN_WIDTH, PANEL_HEIGHT + 8]);
	} else {
		node.setSize?.([
			Math.max(MIN_WIDTH, Number(node.size[0] || MIN_WIDTH)),
			Math.max(PANEL_HEIGHT + 8, Number(node.size[1] || 0)),
		]);
	}

	const originalOnConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = originalOnConnectionsChange?.apply(this, args);
		setTimeout(() => {
			trySyncImageSize(this);
		}, 0);
		return result;
	};

	const originalOnExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = originalOnExecuted?.apply(this, arguments);
		const width = message?.resolved_width?.[0];
		const height = message?.resolved_height?.[0];
		if (width != null && height != null && Number(message?.source_image_count?.[0] || 0) > 0) {
			applyAlignedSize(this, width, height);
			refreshNode(this);
		}
		return result;
	};

	setTimeout(() => {
		trySyncImageSize(node);
	}, 0);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensurePanelWidget(targetNode);
	setStatus(targetNode, detail);
});

app.registerExtension({
	name: "GJJ.Wan22RapidAIOMega",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			return result;
		};
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_LocalLipSync"]);
const MEDIA_INPUT = "input_media";
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const SIG_PROPERTY = "gjj_lipsync_media_signature";

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function getInput(node, name) {
	return node?.inputs?.find((input) => input?.name === name) || null;
}

function getLinkedSource(node) {
	const input = getInput(node, MEDIA_INPUT);
	const linkId = input?.link;
	if (linkId == null || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	const source = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	return { link, source };
}

function setWidgetValue(widget, value) {
	if (!widget || value == null || !Number.isFinite(Number(value))) {
		return;
	}
	const safe = Math.max(64, Math.round(Number(value)));
	if (Number(widget.value) === safe) {
		return;
	}
	widget.value = safe;
	widget.callback?.(safe);
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function buildViewUrl(item, fallbackType = "input") {
	if (!item?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || fallbackType)}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function loadImageSize(url) {
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

function loadVideoSize(url) {
	if (!url) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		const video = document.createElement("video");
		video.preload = "metadata";
		video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight });
		video.onerror = () => resolve(null);
		video.src = url;
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

function firstGjjVideoSelection(sourceNode) {
	const state = sourceNode?.__gjjMultiVideoState || {};
	const fromState = Array.isArray(state.selection) ? state.selection[0] : null;
	if (fromState?.width && fromState?.height) {
		return fromState;
	}
	const property = sourceNode?.properties?.selected_videos;
	const fromProperty = parseSelection(property)[0];
	if (!fromProperty) {
		return null;
	}
	const optionByKey = new Map(
		(state.options || []).map((item) => [`${String(item?.subfolder || "")}/${String(item?.filename || "")}`, item]),
	);
	return optionByKey.get(`${String(fromProperty.subfolder || "")}/${String(fromProperty.filename || "")}`) || fromProperty;
}

function sourceWidgetValue(sourceNode) {
	const names = ["image", "video", "video_path", "filename", "file", "upload", "path"];
	const values = [];
	for (const name of names) {
		const widget = getWidget(sourceNode, name);
		if (widget?.value != null && String(widget.value).trim()) {
			values.push(`${name}:${String(widget.value).trim()}`);
		}
	}
	return values.join("|");
}

function sourceSignature(node, link, sourceNode) {
	if (!sourceNode || !link) {
		return "";
	}
	const gjjSelection = sourceNode.comfyClass === "GJJ_MultiVideoLoader"
		? JSON.stringify(firstGjjVideoSelection(sourceNode) || {})
		: "";
	return [
		link.id,
		sourceNode.id,
		link.origin_slot,
		sourceNode.comfyClass || sourceNode.type || "",
		sourceWidgetValue(sourceNode),
		gjjSelection,
	].join("::");
}

async function loadSizeFromSource(sourceNode, link) {
	if (!sourceNode) {
		return null;
	}
	if (sourceNode.comfyClass === "GJJ_MultiVideoLoader") {
		const first = firstGjjVideoSelection(sourceNode);
		if (first?.width && first?.height) {
			return { width: Number(first.width), height: Number(first.height) };
		}
	}

	const output = sourceNode.outputs?.[Number(link?.origin_slot || 0)];
	const outputType = String(output?.type || "").toUpperCase();
	const imageName = String(getWidget(sourceNode, "image")?.value || "").trim();
	if (imageName) {
		const type = sourceNode.comfyClass === "LoadImageOutput" ? "output" : "input";
		return loadImageSize(buildViewUrl({ filename: imageName, type }, type));
	}

	const videoWidget = getWidget(sourceNode, "video") || getWidget(sourceNode, "video_path") || getWidget(sourceNode, "filename") || getWidget(sourceNode, "path");
	const videoName = String(videoWidget?.value || "").trim();
	if (videoName && (outputType === "VIDEO" || /\.(mp4|webm|mov|mkv|m4v|avi|wmv|flv|gif)$/i.test(videoName))) {
		return loadVideoSize(buildViewUrl({ filename: videoName, type: "input" }, "input"));
	}
	return null;
}

function applySize(node, size, signature) {
	if (!size?.width || !size?.height) {
		return;
	}
	node.properties = node.properties || {};
	node.properties[SIG_PROPERTY] = signature;
	setWidgetValue(getWidget(node, WIDTH_WIDGET), size.width);
	setWidgetValue(getWidget(node, HEIGHT_WIDGET), size.height);
	refreshNode(node);
}

async function syncMediaSize(node, force = false) {
	const linked = getLinkedSource(node);
	if (!linked?.source) {
		return;
	}
	const signature = sourceSignature(node, linked.link, linked.source);
	node.properties = node.properties || {};
	if (!force && signature && node.properties[SIG_PROPERTY] === signature) {
		return;
	}
	const size = await loadSizeFromSource(linked.source, linked.link);
	if (!size?.width || !size?.height) {
		return;
	}
	applySize(node, size, signature);
}

function scheduleSync(node, force = false, delay = 30) {
	clearTimeout(node.__gjjLipSyncSizeTimer);
	node.__gjjLipSyncSizeTimer = setTimeout(() => syncMediaSize(node, force), delay);
}

function patchSourceNode(sourceNode) {
	if (!sourceNode || sourceNode.__gjjLipSyncSourcePatched) {
		return;
	}
	sourceNode.__gjjLipSyncSourcePatched = true;
	for (const widget of sourceNode.widgets || []) {
		const name = String(widget?.name || "");
		if (!["image", "video", "video_path", "filename", "file", "upload", "path", "selected_videos"].includes(name)) {
			continue;
		}
		const original = widget.callback;
		widget.callback = function (value, ...args) {
			const result = original?.call(this, value, ...args);
			setTimeout(() => {
				for (const node of app.graph?._nodes || []) {
					if (!TARGET_NODES.has(node?.comfyClass)) {
						continue;
					}
					const linked = getLinkedSource(node);
					if (linked?.source?.id === sourceNode.id) {
						scheduleSync(node, false, 0);
					}
				}
			}, 0);
			return result;
		};
	}
}

function patchNode(node) {
	if (!node || node.__gjjLipSyncPatched) {
		return;
	}
	node.__gjjLipSyncPatched = true;
	const originalConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = originalConnectionsChange?.apply(this, args);
		const linked = getLinkedSource(this);
		patchSourceNode(linked?.source);
		scheduleSync(this, false, 0);
		return result;
	};
	const linked = getLinkedSource(node);
	patchSourceNode(linked?.source);
	scheduleSync(node, false, 0);
	clearInterval(node.__gjjLipSyncSizePoller);
	node.__gjjLipSyncSizePoller = setInterval(() => {
		if (!app.graph?._nodes?.includes(node)) {
			clearInterval(node.__gjjLipSyncSizePoller);
			return;
		}
		syncMediaSize(node, false);
	}, 1000);
}

app.registerExtension({
	name: "GJJ.LocalLipSync",
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

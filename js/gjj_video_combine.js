import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_VideoCombine"]);
const STATUS_WIDGET_NAME = "gjj_video_combine_status";
const MIN_WIDTH = 340;
const PANEL_HEIGHT = 318;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function removeLegacyVideoInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (!String(input?.name || "").startsWith("video_")) {
			continue;
		}
		if (input?.link != null) {
			node.disconnectInput?.(index);
		}
		node.removeInput?.(index);
	}
}

function ensurePanelWidget(node) {
	if (node.__gjjVideoCombineStatus) {
		return node.__gjjVideoCombineStatus;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"min-height:42px",
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:10px",
		"background:#121a1f",
	].join(";");

	const statusCard = document.createElement("div");
	statusCard.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"padding:0",
	].join(";");

	const text = document.createElement("div");
	text.textContent = "等待执行";
	text.style.cssText = [
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
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
		"background:linear-gradient(90deg,#5fa8ff,#7ed6a7)",
		"transition:width 120ms ease",
	].join(";");
	progressOuter.appendChild(progressInner);
	statusCard.append(text, progressOuter);

	const previewCard = document.createElement("div");
	previewCard.style.cssText = [
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"height:230px",
		"border:1px solid #25333b",
		"border-radius:10px",
		"overflow:hidden",
		"background:#0d1418",
		"position:relative",
	].join(";");

	const empty = document.createElement("div");
	empty.textContent = "执行后在这里预览视频或动图";
	empty.style.cssText = [
		"padding:12px",
		"color:#7f97a2",
		"font-size:12px",
		"line-height:1.5",
		"text-align:center",
		"pointer-events:none",
	].join(";");

	const video = document.createElement("video");
	video.controls = true;
	video.muted = true;
	video.loop = true;
	video.playsInline = true;
	video.preload = "metadata";
	video.style.cssText = [
		"display:none",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"background:#000",
	].join(";");

	const image = document.createElement("img");
	image.alt = "视频预览";
	image.style.cssText = [
		"display:none",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"background:#0d1418",
	].join(";");

	previewCard.append(empty, video, image);
	wrap.append(statusCard, previewCard);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => PANEL_HEIGHT,
	});
	node.__gjjVideoCombineStatus = { widget, wrap, text, progressInner, previewCard, empty, video, image };
	return node.__gjjVideoCombineStatus;
}

function buildViewUrl(item) {
	if (!item?.filename) {
		return "";
	}
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${randParam}`,
	);
}

function isVideoPreview(item, detail = {}) {
	const explicitFlag = Array.isArray(detail?.preview_is_video) ? detail.preview_is_video[0] : detail?.preview_is_video;
	if (explicitFlag != null) {
		return Boolean(explicitFlag);
	}
	const filename = String(item?.filename || "");
	const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
	return VIDEO_EXTENSIONS.has(ext);
}

function parseProgress(detail = {}) {
	if (Number.isFinite(detail.progress)) {
		return Math.max(0, Math.min(100, Number(detail.progress) * 100));
	}
	return null;
}

function setStatus(node, detail = {}) {
	const state = node?.__gjjVideoCombineStatus;
	if (!state) {
		return;
	}
	state.text.textContent = String(detail.text || "等待执行");
	const progress = parseProgress(detail);
	state.progressInner.style.width = `${progress == null ? 0 : progress}%`;
	refreshNode(node);
}

function setPreview(node, detail = {}) {
	const state = node?.__gjjVideoCombineStatus;
	if (!state) {
		return;
	}
	const item = Array.isArray(detail?.preview_media) ? detail.preview_media[0] : null;
	const url = buildViewUrl(item);
	const shouldUseVideo = !!url && isVideoPreview(item, detail);

	state.video.pause?.();
	state.video.removeAttribute("src");
	state.video.load?.();
	state.image.removeAttribute("src");

	if (!url) {
		state.empty.style.display = "flex";
		state.video.style.display = "none";
		state.image.style.display = "none";
		state.empty.textContent = "执行后在这里预览视频或动图";
		refreshNode(node);
		return;
	}

	if (shouldUseVideo) {
		state.empty.style.display = "none";
		state.image.style.display = "none";
		state.video.style.display = "block";
		state.video.src = url;
		state.video.load?.();
		const autoplayPromise = state.video.play?.();
		if (autoplayPromise?.catch) {
			autoplayPromise.catch(() => {});
		}
	} else {
		state.empty.style.display = "none";
		state.video.style.display = "none";
		state.image.style.display = "block";
		state.image.src = url;
	}
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjVideoCombinePatched) {
		return;
	}
	node.__gjjVideoCombinePatched = true;
	removeLegacyVideoInputs(node);
	ensurePanelWidget(node);
	setStatus(node, { text: "等待执行", progress: 0 });
	setPreview(node, {});
	if (!Array.isArray(node.size) || node.size.length < 2) {
		node.setSize?.([MIN_WIDTH, PANEL_HEIGHT + 8]);
	} else {
		node.setSize?.([
			Math.max(MIN_WIDTH, Number(node.size[0] || MIN_WIDTH)),
			Math.max(PANEL_HEIGHT + 8, Number(node.size[1] || 0)),
		]);
	}
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
	name: "GJJ.VideoCombine",
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

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			patchNode(this);
			setPreview(this, message || {});
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				patchNode(node);
			}
		}
	},
});

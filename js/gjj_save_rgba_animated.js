import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_SaveRGBAAnimated"]);
const STATUS_WIDGET_NAME = "gjj_save_rgba_animated_status";
const MIN_WIDTH = 340;
const PANEL_HEIGHT = 318;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const TRANSPARENCY_COLOR_INPUT_RE = /(gif_transparency_color|GIF\s*透明底色|透明底色|converted-widget:gif_transparency_color)/i;

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function ensurePanelWidget(node) {
	if (node.__gjjSaveRgbaAnimatedStatus) {
		return node.__gjjSaveRgbaAnimatedStatus;
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
		"position:relative",
		"background-color:#111820",
		"background-image:linear-gradient(45deg,rgba(255,255,255,.08) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.08) 75%,rgba(255,255,255,.08)),linear-gradient(45deg,rgba(255,255,255,.08) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.08) 75%,rgba(255,255,255,.08))",
		"background-position:0 0,10px 10px",
		"background-size:20px 20px",
	].join(";");

	const empty = document.createElement("div");
	empty.textContent = "执行后在这里预览透明动画";
	empty.style.cssText = [
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"padding:12px",
		"color:#7f97a2",
		"font-size:12px",
		"line-height:1.5",
		"text-align:center",
		"pointer-events:none",
		"width:100%",
		"height:100%",
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
		"background:transparent",
	].join(";");

	const image = document.createElement("img");
	image.alt = "透明动画预览";
	image.style.cssText = [
		"display:none",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"background:transparent",
	].join(";");

	previewCard.append(empty, video, image);
	wrap.append(statusCard, previewCard);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => PANEL_HEIGHT,
	});
	node.__gjjSaveRgbaAnimatedStatus = { widget, wrap, text, progressInner, previewCard, empty, video, image };
	return node.__gjjSaveRgbaAnimatedStatus;
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
	const state = node?.__gjjSaveRgbaAnimatedStatus;
	if (!state) return;
	state.text.textContent = String(detail.text || "等待执行");
	const progress = parseProgress(detail);
	state.progressInner.style.width = `${progress == null ? 0 : progress}%`;
	refreshNode(node);
}

function clearNativePreview(node) {
	if (!node) return;
	node.imgs = [];
	node.imageIndex = null;
	node.overIndex = null;
	node.animatedImages = [];
	node.videoContainer = null;
	node.preview = null;
	node.previews = null;
	if (node.properties) {
		delete node.properties.image;
		delete node.properties.images;
		delete node.properties.preview;
		delete node.properties.previews;
		delete node.properties.gifs;
		delete node.properties.animated;
	}
	app.graph?.setDirtyCanvas?.(true, true);
	refreshNode(node);
}

function removeTransparencyColorInput(node) {
	if (!Array.isArray(node?.inputs)) return;
	let changed = false;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const text = [
			input?.name,
			input?.label,
			input?.localized_name,
			input?.type,
			input?.tooltip,
		].filter(Boolean).join(" ");
		if (!TRANSPARENCY_COLOR_INPUT_RE.test(text)) continue;
		try { node.disconnectInput?.(index); } catch (_) {}
		if (typeof node.removeInput === "function") {
			try { node.removeInput(index); } catch (_) { node.inputs.splice(index, 1); }
		} else {
			node.inputs.splice(index, 1);
		}
		changed = true;
	}
	if (changed) {
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
		refreshNode(node);
	}
}

function firstPreviewItem(detail = {}) {
	if (Array.isArray(detail?.preview_media) && detail.preview_media.length) return detail.preview_media[0];
	if (Array.isArray(detail?.animated) && detail.animated.length) return detail.animated[0];
	if (Array.isArray(detail?.gifs) && detail.gifs.length) return detail.gifs[0];
	if (Array.isArray(detail?.images) && detail.images.length) return detail.images[0];
	return null;
}

function setPreview(node, detail = {}) {
	const state = node?.__gjjSaveRgbaAnimatedStatus;
	if (!state) return;
	const item = firstPreviewItem(detail);
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
		state.empty.textContent = "执行后在这里预览透明动画";
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
		if (autoplayPromise?.catch) autoplayPromise.catch(() => {});
	} else {
		state.empty.style.display = "none";
		state.video.style.display = "none";
		state.image.style.display = "block";
		state.image.src = url;
	}
	refreshNode(node);
}

function patchNode(node) {
	if (!node) return;
	removeTransparencyColorInput(node);
	if (node.__gjjSaveRgbaAnimatedPatched) return;
	node.__gjjSaveRgbaAnimatedPatched = true;
	ensurePanelWidget(node);
	clearNativePreview(node);
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
	name: "GJJ.SaveRGBAAnimated",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			setTimeout(() => removeTransparencyColorInput(this), 80);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			removeTransparencyColorInput(this);
			setTimeout(() => removeTransparencyColorInput(this), 80);
			clearNativePreview(this);
			return result;
		};

		nodeType.prototype.onExecuted = function (message) {
			patchNode(this);
			removeTransparencyColorInput(this);
			setPreview(this, message || {});
			clearNativePreview(this);
			requestAnimationFrame(() => clearNativePreview(this));
			setTimeout(() => clearNativePreview(this), 80);
			setTimeout(() => clearNativePreview(this), 240);
			return undefined;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (!TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) continue;
			patchNode(node);
			clearNativePreview(node);
		}
	},
});

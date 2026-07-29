import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE = "GJJ_VideoBackgroundAudioOverlay";
const PREVIEW_WIDGET = "gjj_video_background_audio_overlay_preview";

function viewUrl(item) {
	if (!item?.filename) return "";
	const params = new URLSearchParams({
		filename: String(item.filename),
		type: String(item.type || "temp"),
	});
	if (item.subfolder) params.set("subfolder", String(item.subfolder));
	return `/view?${params.toString()}`;
}

function previewHeight(node, width = null) {
	const state = node?.__gjjBackgroundAudioPreview;
	if (!state?.hasPreview) return 0;
	const availableWidth = Math.max(320, Number(width || node.size?.[0] || 360)) - 12;
	return Math.max(120, Math.round(availableWidth * Number(state.aspect || 9 / 16))) + 12;
}

function setPreviewAspect(node, width, height) {
	const state = node?.__gjjBackgroundAudioPreview;
	if (!state) return;
	const w = Math.max(1, Number(width || 16));
	const h = Math.max(1, Number(height || 9));
	state.aspect = Math.max(0.1, Math.min(8, h / w));
	state.video.style.aspectRatio = `${w} / ${h}`;
	if (state.widget) {
		state.widget.getHeight = () => previewHeight(node);
		state.widget.computedHeight = previewHeight(node);
	}
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 360, minHeight: 150 + previewHeight(node) });
}

function ensurePreview(node) {
	if (node.__gjjBackgroundAudioPreview) return node.__gjjBackgroundAudioPreview;
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:none;padding:6px;box-sizing:border-box";
	const video = document.createElement("video");
	video.controls = true;
	video.loop = true;
	video.playsInline = true;
	video.preload = "metadata";
	video.style.cssText = "display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:contain;border:1px solid #30434b;border-radius:8px;background:#000;box-sizing:border-box";
	for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
		wrap.addEventListener(name, (event) => event.stopPropagation());
		video.addEventListener(name, (event) => event.stopPropagation());
	}
	video.addEventListener("loadedmetadata", () => setPreviewAspect(node, video.videoWidth, video.videoHeight));
	wrap.appendChild(video);
	const widget = node.addDOMWidget?.(PREVIEW_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => previewHeight(node),
	});
	if (widget) widget.computeSize = (width) => [Math.max(360, Number(width || node.size?.[0] || 360)), previewHeight(node, width)];
	node.__gjjBackgroundAudioPreview = { wrap, video, widget, hasPreview: false, aspect: 9 / 16 };
	return node.__gjjBackgroundAudioPreview;
}

function setPreview(node, message = {}) {
	const state = ensurePreview(node);
	const item = Array.isArray(message?.preview_media) ? message.preview_media[0] : null;
	const url = viewUrl(item);
	if (!url) {
		state.video.pause?.();
		state.video.removeAttribute("src");
		state.hasPreview = false;
		state.wrap.style.display = "none";
		GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 360, minHeight: 150 });
		return;
	}
	state.hasPreview = true;
	const width = Number(item?.width || message?.preview_width?.[0] || 0);
	const height = Number(item?.height || message?.preview_height?.[0] || 0);
	if (width > 0 && height > 0) setPreviewAspect(node, width, height);
	state.wrap.style.display = "block";
	state.video.src = url;
	state.video.load?.();
	state.video.play?.()?.catch?.(() => {});
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 360, minHeight: 150 + previewHeight(node) });
}

app.registerExtension({
	name: "GJJ.VideoBackgroundAudioOverlay",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE) return;
		const created = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = created?.apply(this, args);
			ensurePreview(this);
			this.setSize?.([Math.max(360, this.size?.[0] || 0), Math.max(150, this.size?.[1] || 0)]);
			return result;
		};
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = configured?.apply(this, args);
			ensurePreview(this);
			return result;
		};
		const executed = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = executed?.apply(this, [message, ...args]);
			setPreview(this, message);
			return result;
		};
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { gjjOpenMediaBrowser } from "./gjj_common_media_preview.js";

const TARGET = "GJJ_SeedVR2ImageUpscaler";
const PANEL_WIDGET = "gjj_seedvr2_live_preview_v2";
const ANY_PREVIEW_MEDIA_DRAG_MIME = "application/x-gjj-any-preview-media";

function isTarget(node) {
	return String(node?.comfyClass || node?.type || "") === TARGET;
}

function safeNodeId(node) {
	return String(node?.id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function previewUrl(node, detail = {}) {
	const filename = String(detail.preview_filename || `seedvr2_preview_${safeNodeId(node)}.png`);
	return api.apiURL(
		`/view?filename=${encodeURIComponent(filename)}&type=temp&subfolder=GJJ&rand=${Date.now()}`,
	);
}

function formatDuration(seconds) {
	const value = Math.max(0, Math.round(Number(seconds || 0)));
	const hours = Math.floor(value / 3600);
	const minutes = Math.floor((value % 3600) / 60);
	const secs = value % 60;
	if (hours > 0) return `${hours}小时${minutes}分`;
	if (minutes > 0) return `${minutes}分${secs}秒`;
	return `${secs}秒`;
}

function ensurePanel(node) {
	if (node.__gjjSeedvr2PreviewBridge) return node.__gjjSeedvr2PreviewBridge;
	const root = document.createElement("div");
	root.style.cssText = "display:none;width:100%;box-sizing:border-box;padding:4px 0;";
	const image = document.createElement("img");
	image.alt = "当前视频段首帧";
	image.draggable = true;
	image.title = "点击放大预览；拖到空白画布可创建 GJJ_AnyPreview，也可拖到已有 GJJ_AnyPreview。";
	image.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const mediaItem = image.__gjjSeedvr2BrowserItem;
		if (mediaItem?.url || mediaItem?.filename) gjjOpenMediaBrowser(mediaItem);
	});
	image.addEventListener("dragstart", (event) => {
		const payload = image.__gjjAnyPreviewPayload;
		if (!event.dataTransfer || !payload?.filename) {
			event.preventDefault();
			return;
		}
		event.dataTransfer.effectAllowed = "copy";
		event.dataTransfer.setData(ANY_PREVIEW_MEDIA_DRAG_MIME, JSON.stringify(payload));
		event.dataTransfer.setData("text/plain", String(payload.filename));
	});
	image.style.cssText = "display:block;width:100%;height:auto;object-fit:contain;border-radius:8px;background:#05090c;";
	const meta = document.createElement("div");
	meta.style.cssText = "padding:5px 2px 0;color:#63d5ff;font:700 12px sans-serif;";
	root.append(image, meta);
	const measuredHeight = (width) => {
		if (root.style.display === "none") return 0;
		const contentWidth = Math.max(120, Number(width || node.size?.[0] || 360) - 24);
		const ratio = image.naturalWidth > 0 ? image.naturalHeight / image.naturalWidth : 9 / 16;
		return Math.round(contentWidth * ratio + 38);
	};
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		root.addEventListener(eventName, (event) => event.stopPropagation());
	}
	const widget = node.addDOMWidget?.(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.serialize = false;
		widget.options ||= {};
		widget.options.serialize = false;
		widget.computeSize = (width) => [
			Math.round(width || node.size?.[0] || 360),
			measuredHeight(width),
		];
		widget.getHeight = () => measuredHeight(node.size?.[0]);
	}
	node.__gjjSeedvr2PreviewBridge = { root, image, meta, widget, lastUrl: "" };
	return node.__gjjSeedvr2PreviewBridge;
}

function showPreview(node, detail = {}) {
	if (!isTarget(node)) return;
	const state = ensurePanel(node);
	const url = previewUrl(node, detail);
	const previewItem = detail?.preview_image;
	const fallbackFilename = String(detail.preview_filename || `seedvr2_preview_${safeNodeId(node)}.png`);
	state.image.__gjjAnyPreviewPayload = {
		filename: String(previewItem?.filename || fallbackFilename),
		subfolder: String(previewItem?.subfolder ?? "GJJ"),
		type: String(previewItem?.type || "temp"),
		media_type: "image",
	};
	state.image.__gjjSeedvr2BrowserItem = {
		...state.image.__gjjAnyPreviewPayload,
		kind: "image",
		title: "SeedVR2 放大预览",
		url,
	};
	if (state.lastUrl === url) return;
	const loader = new Image();
	loader.onload = () => {
		state.lastUrl = url;
		state.image.src = url;
		state.root.style.display = "block";
		if (detail.segment != null) {
			const segment = Number(detail.segment || 1);
			const total = Number(detail.total_segments || 1);
			const start = Number(detail.start_frame || 1);
			const end = Number(detail.end_frame || start);
			const frames = Number(detail.total_frames || end);
			const eta = Number(detail.eta_seconds || 0);
			const etaText = eta > 0 ? ` · 预计剩余 ${formatDuration(eta)}` : " · 正在统计剩余时间";
			state.meta.textContent = `当前第 ${segment} 段 · 预计共 ${total} 段 · ${start}–${end}/${frames} 帧${etaText}`;
		}
		// Also feed ComfyUI's native node preview path as a fallback.
		node.imgs = [loader];
		node.imageIndex = 0;
		requestAnimationFrame(() => {
			const computed = node.computeSize?.();
			if (Array.isArray(computed)) {
				node.setSize?.([node.size?.[0] || computed[0], computed[1]]);
			}
			node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		});
	};
	loader.src = url;
}

function eventHandler(event) {
	const detail = event?.detail || {};
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail.node));
	if (!node || !isTarget(node)) return;
	showPreview(node, detail);
}

api.addEventListener("gjj_node_progress", eventHandler);
api.addEventListener("gjj_seedvr2_segment_preview", eventHandler);

app.registerExtension({
	name: "GJJ.SeedVR2PreviewBridgeV2",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (String(nodeData?.name || "") !== TARGET) return;
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply?.(this, args);
			ensurePanel(this);
			return result;
		};
	},
	async setup() {
		for (const node of app.graph?._nodes || []) {
			if (isTarget(node)) ensurePanel(node);
		}
	},
});

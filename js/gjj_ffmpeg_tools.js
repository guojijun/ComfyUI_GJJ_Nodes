import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_FFmpegMuxAudioVideo"]);
const PREVIEW_WIDGET_NAME = "gjj_ffmpeg_mux_preview";
const HIDDEN_WIDGETS = new Set([
	"filename_prefix",
	"default_fps",
	"ffmpeg_path",
	"ffprobe_path",
	"video_path",
	"audio_path",
]);
const INPUT_SPECS = [
	["images", "GJJ_BATCH_IMAGE,IMAGE,VIDEO,STRING", "图片帧", "可连接视频片段、图片帧、VIDEO 对象，或分段视频文件名前缀。"],
	["audio", "AUDIO,VIDEO,STRING", "音频", "可选。支持 AUDIO、VIDEO 或音频/视频文件路径。"],
	["fps", "INT,FLOAT,STRING,VIDEO", "帧率", "可选。支持 INT、FLOAT、STRING；接 VIDEO 时读取源帧率。"],
	["condition", "BOOLEAN", "条件通行", "可选布尔门控；为假时本节点跳过。"],
];

function buildViewUrl(item) {
	if (!item?.filename) return "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}${randParam}`,
	);
}

function normalizeSlotName(value) {
	return String(value || "").replace(/^converted-widget:/i, "");
}

function inputSpecInfo(input) {
	const name = normalizeSlotName(input?.name);
	const label = String(input?.localized_name || input?.label || input?.display_name || "");
	const widgetName = String(input?.widget?.name || input?.widget_name || "");
	return INPUT_SPECS.findIndex((spec) => spec[0] === name || spec[2] === label || spec[0] === widgetName);
}

function applyInputSpec(input, spec) {
	if (!input || !spec) return;
	const [name, type, label, tooltip] = spec;
	input.name = name;
	input.type = type;
	input.label = label;
	input.localized_name = label;
	input.display_name = label;
	input.tooltip = tooltip;
	input.hidden = false;
	input.visible = true;
}

function ensureInput(node, spec) {
	const [name] = spec;
	let input = Array.isArray(node?.inputs)
		? node.inputs.find((item) => normalizeSlotName(item?.name) === name || String(item?.localized_name || item?.label || "") === spec[2])
		: null;
	if (!input) {
		node.addInput?.(name, spec[1]);
		input = node.inputs?.[node.inputs.length - 1] || null;
	}
	applyInputSpec(input, spec);
}

function syncInputLinkSlots(node) {
	const links = node?.graph?.links || app.graph?.links || {};
	for (let index = 0; index < (node.inputs?.length || 0); index += 1) {
		const linkId = node.inputs[index]?.link;
		const link = linkId != null ? links[linkId] : null;
		if (link) link.target_slot = index;
	}
}

function preferredNodeWidth(node) {
	return Math.max(320, Math.round(Number(node?.size?.[0] || 360)));
}

function ensurePreviewWidget(node) {
	if (node.__gjjFfmpegMuxPreview) return node.__gjjFfmpegMuxPreview;
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:none",
		"width:100%",
		"box-sizing:border-box",
		"padding:0",
	].join(";");
	const card = document.createElement("div");
	card.style.cssText = [
		"width:100%",
		"height:180px",
		"box-sizing:border-box",
		"border:1px solid #263a42",
		"border-radius:8px",
		"overflow:hidden",
		"background:#05090c",
		"display:flex",
		"align-items:center",
		"justify-content:center",
	].join(";");
	const video = document.createElement("video");
	video.controls = true;
	video.loop = true;
	video.muted = true;
	video.playsInline = true;
	video.preload = "metadata";
	video.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;display:block;";
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		wrap.addEventListener(eventName, (event) => event.stopPropagation());
		video.addEventListener(eventName, (event) => event.stopPropagation());
	}
	card.append(video);
	wrap.append(card);
	const widget = node.addDOMWidget?.(PREVIEW_WIDGET_NAME, "HTML", wrap, {
		hideOnZoom: false,
		serialize: false,
		getHeight: () => (wrap.style.display === "none" ? 0 : 190),
	});
	if (widget) {
		widget.computeSize = (width) => [preferredNodeWidth({ ...node, size: [width || node.size?.[0], node.size?.[1]] }), wrap.style.display === "none" ? 0 : 190];
	}
	node.__gjjFfmpegMuxPreview = { wrap, card, video, widget };
	return node.__gjjFfmpegMuxPreview;
}

function setMuxPreview(node, message = {}) {
	const state = ensurePreviewWidget(node);
	const item = Array.isArray(message?.preview_media) ? message.preview_media[0] : null;
	const url = buildViewUrl(item);
	if (!url) {
		state.video.pause?.();
		state.video.removeAttribute("src");
		state.video.load?.();
		state.wrap.style.display = "none";
		if (state.widget) {
			state.widget.getHeight = () => 0;
			state.widget.computedHeight = 0;
		}
		GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 320, minHeight: 170 });
		return;
	}
	const width = Math.max(1, Number(item?.width || message?.preview_width?.[0] || 0));
	const height = Math.max(1, Number(item?.height || message?.preview_height?.[0] || 0));
	const aspect = width > 1 && height > 1 ? Math.max(0.2, Math.min(5, width / height)) : 16 / 9;
	const contentWidth = Math.max(260, preferredNodeWidth(node) - 24);
	const previewHeight = Math.round(Math.max(150, Math.min(420, contentWidth / aspect)));
	state.card.style.height = `${previewHeight}px`;
	state.wrap.style.display = "block";
	if (state.widget) {
		state.widget.getHeight = () => previewHeight + 10;
		state.widget.computedHeight = previewHeight + 10;
	}
	state.video.src = url;
	state.video.load?.();
	state.video.play?.()?.catch?.(() => {});
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 320, minHeight: 170 + previewHeight });
}

function compactMuxNode(node) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;

	for (const name of HIDDEN_WIDGETS) {
		const widget = GJJ_Utils.getWidget(node, name);
		if (widget) {
			GJJ_Utils.hideWidget(widget);
			widget.options ||= {};
			widget.options.hidden = true;
			widget.options.display = "hidden";
		}
	}

	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGETS);
	for (const spec of INPUT_SPECS) ensureInput(node, spec);
	if (Array.isArray(node.inputs)) {
		node.inputs.sort((a, b) => {
			const ai = inputSpecInfo(a);
			const bi = inputSpecInfo(b);
			return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
		});
	}
	syncInputLinkSlots(node);
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
	ensurePreviewWidget(node);
	GJJ_Utils.refreshNode(node, {
		preserveWidth: true,
		minWidth: 320,
		minHeight: 170,
	});
}

function scheduleCompact(node, delay = 0) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	clearTimeout(node.__gjjFfmpegMuxCompactTimer);
	node.__gjjFfmpegMuxCompactTimer = setTimeout(() => {
		compactMuxNode(node);
		GJJ_Utils.scheduleRefreshNode(node, {
			delay: 80,
			preserveWidth: true,
			minWidth: 320,
			minHeight: 170,
		});
	}, delay);
}

app.registerExtension({
	name: "Comfy.GJJ.FFmpegMuxAudioVideo",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			scheduleCompact(this, 0);
			scheduleCompact(this, 160);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			scheduleCompact(this, 0);
			scheduleCompact(this, 180);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			scheduleCompact(this, 0);
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalExecuted?.apply(this, [message, ...args]);
			setMuxPreview(this, message);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			scheduleCompact(node, 0);
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_AnyVideoConcat"]);
const INPUT_PREFIX = "video_";
const INPUT_TYPE = "VIDEO,STRING";
const MIN_VISIBLE_INPUTS = 1;
const PREVIEW_WIDGET_NAME = "gjj_any_video_concat_preview";
const HIDDEN_WIDGETS = new Set(["ffmpeg_path", "ffprobe_path"]);

function formatInputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getInputIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(INPUT_PREFIX)) return Number.MAX_SAFE_INTEGER;
	return Number.parseInt(text.slice(INPUT_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getVideoInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs].filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX)).sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name))
		: [];
}

function addDynamicInput(node) {
	const nextIndex = getVideoInputs(node).length + 1;
	node.addInput?.(formatInputName(nextIndex), INPUT_TYPE);
}

function removeUnusedInputsFromEnd(node, minInputs = MIN_VISIBLE_INPUTS) {
	const inputs = getVideoInputs(node);
	for (let index = inputs.length - 1; index >= minInputs; index -= 1) {
		const input = inputs[index];
		if (input?.link != null) break;
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) node.removeInput(slotIndex);
	}
}

function ensureTrailingEmptyInput(node) {
	const inputs = getVideoInputs(node);
	if (!inputs.length) {
		addDynamicInput(node);
		return;
	}
	if (inputs[inputs.length - 1]?.link != null) addDynamicInput(node);
}

function renameInputsSequentially(node) {
	getVideoInputs(node).forEach((input, index) => {
		input.name = formatInputName(index + 1);
		input.type = INPUT_TYPE;
		input.label = `视频 ${index + 1}`;
		input.localized_name = input.label;
		input.display_name = input.label;
		input.tooltip = "按从上到下顺序合并；开启删除锚点帧时会删除非最后片段的尾帧。";
	});
}

function syncInputLinkSlots(node) {
	const links = node?.graph?.links || app.graph?.links || {};
	for (let index = 0; index < (node.inputs?.length || 0); index += 1) {
		const linkId = node.inputs[index]?.link;
		const link = linkId != null ? links[linkId] : null;
		if (link) link.target_slot = index;
	}
}

function ensureOutputs(node) {
	const defs = [
		["视频", "VIDEO"],
		["输出视频路径", "STRING"],
		["视频时长", "FLOAT"],
		["总帧数", "INT"],
		["合并信息JSON", "STRING"],
	];
	if (!Array.isArray(node.outputs)) node.outputs = [];
	for (let index = 0; index < defs.length; index += 1) {
		const [name, type] = defs[index];
		if (!node.outputs[index]) node.addOutput?.(name, type);
		const output = node.outputs[index];
		if (!output) continue;
		output.name = name;
		output.label = name;
		output.localized_name = name;
		output.type = type;
	}
}

function buildViewUrl(item) {
	if (!item?.filename) return "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}${randParam}`);
}

function preferredNodeWidth(node) {
	return Math.max(340, Math.round(Number(node?.size?.[0] || 380)));
}

function ensurePreviewWidget(node) {
	if (node.__gjjAnyVideoConcatPreview) return node.__gjjAnyVideoConcatPreview;

	const wrap = document.createElement("div");
	wrap.style.cssText = "display:none;width:100%;box-sizing:border-box;padding:0;";

	const card = document.createElement("div");
	card.style.cssText = [
		"width:100%",
		"height:190px",
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
		getHeight: () => (wrap.style.display === "none" ? 0 : 200),
	});
	if (widget) {
		widget.computeSize = (width) => [preferredNodeWidth({ ...node, size: [width || node.size?.[0], node.size?.[1]] }), wrap.style.display === "none" ? 0 : 200];
	}

	node.__gjjAnyVideoConcatPreview = { wrap, card, video, widget };
	return node.__gjjAnyVideoConcatPreview;
}

function setPreview(node, message = {}) {
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
		GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 340, minHeight: 180 });
		return;
	}

	const width = Math.max(1, Number(item?.width || message?.preview_width?.[0] || 0));
	const height = Math.max(1, Number(item?.height || message?.preview_height?.[0] || 0));
	const aspect = width > 1 && height > 1 ? Math.max(0.2, Math.min(5, width / height)) : 16 / 9;
	const contentWidth = Math.max(280, preferredNodeWidth(node) - 24);
	const previewHeight = Math.round(Math.max(150, Math.min(460, contentWidth / aspect)));

	state.card.style.height = `${previewHeight}px`;
	state.wrap.style.display = "block";
	if (state.widget) {
		state.widget.getHeight = () => previewHeight + 10;
		state.widget.computedHeight = previewHeight + 10;
	}
	state.video.src = url;
	state.video.load?.();
	state.video.play?.()?.catch?.(() => {});
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 340, minHeight: 190 + previewHeight });
}

function compactNode(node) {
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

	removeUnusedInputsFromEnd(node);
	ensureTrailingEmptyInput(node);
	renameInputsSequentially(node);
	syncInputLinkSlots(node);
	ensureOutputs(node);
	ensurePreviewWidget(node);
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 340, minHeight: 180 });
}

function scheduleCompact(node, delay = 0) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	clearTimeout(node.__gjjAnyVideoConcatTimer);
	node.__gjjAnyVideoConcatTimer = setTimeout(() => compactNode(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.AnyVideoConcat",

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
			setPreview(this, message);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			scheduleCompact(node, 0);
		}
	},
});

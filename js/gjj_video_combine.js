import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_VideoCombine"]);
const TOOLBAR_WIDGET_NAME = "gjj_video_combine_toolbar";
const STATUS_WIDGET_NAME = "gjj_video_combine_status";
const MIN_WIDTH = 340;
const TOOLBAR_HEIGHT = 36;
const PANEL_HEIGHT = 318;
const STATUS_PANEL_HEIGHT = 70;
const HIDDEN_PANEL_HEIGHT = 0;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const PRIMARY_INPUT_NAME = "images";
const PRIMARY_INPUT_ALIASES = new Set(["images", "图像"]);
const OPTIONAL_INPUTS = [
	{ name: "audio", type: "AUDIO", label: "音频", localized_name: "音频" },
	{ name: "vae", type: "VAE", label: "VAE 解码器", localized_name: "VAE 解码器" },
];
const OUTPUTS = [
	{ name: "视频", type: "VIDEO", label: "视频", localized_name: "视频" },
	{ name: "主输出文件", type: "STRING", label: "主输出文件", localized_name: "主输出文件" },
	{ name: "输出文件列表JSON", type: "STRING", label: "输出文件列表JSON", localized_name: "输出文件列表JSON" },
];
const BOOL_WIDGETS = [
	{ name: "pingpong", label: "往返", on: "往返 开", off: "往返 关" },
	{ name: "save_output", label: "保存", on: "保存 开", off: "保存 关" },
	{ name: "use_source_fps", label: "源帧率", on: "源帧率 开", off: "源帧率 关" },
];

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

function injectToolbarStyle() {
	if (document.getElementById("gjj-video-combine-style")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "gjj-video-combine-style";
	style.textContent = `
		.gjj-video-combine-toolbar {
			display: flex;
			gap: 6px;
			padding: 4px 2px 2px;
			box-sizing: border-box;
			width: 100%;
		}
		.gjj-video-combine-toolbar button {
			flex: 1 1 0;
			min-width: 0;
			height: 28px;
			border: 1px solid #41535b;
			border-radius: 6px;
			background: #172026;
			color: #dce7e2;
			font-size: 12px;
			font-weight: 700;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.gjj-video-combine-toolbar button:hover {
			background: #20313a;
			border-color: #55707d;
		}
		.gjj-video-combine-toolbar button.on {
			background: #1f4b37;
			border-color: #57a773;
			color: #ffffff;
		}
		.gjj-video-combine-toolbar button.more-on {
			background: #274665;
			border-color: #5fa8ff;
			color: #ffffff;
		}
	`;
	document.head.appendChild(style);
}

function getWidget(node, name) {
	return (node?.widgets || []).find((widget) => String(widget?.name || "") === name) || null;
}

function isBoolControlWidgetName(name) {
	return BOOL_WIDGETS.some((config) => config.name === String(name || ""));
}

function isPrimaryInputName(name) {
	return PRIMARY_INPUT_ALIASES.has(String(name || ""));
}

function cloneSlot(slot) {
	const copy = {};
	for (const [key, value] of Object.entries(slot || {})) {
		if (key === "_node" || key === "node" || key === "graph") {
			continue;
		}
		if (key === "widget") {
			copy.widget = value?.name ? { name: value.name } : value;
			continue;
		}
		if (key === "links") {
			copy.links = Array.isArray(value) ? [...value] : (value ?? null);
			continue;
		}
		copy[key] = value;
	}
	return copy;
}

function readBoolWidget(node, name) {
	const widget = getWidget(node, name);
	return Boolean(widget?.value);
}

function writeBoolWidget(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) {
		return;
	}
	widget.value = Boolean(value);
	widget.callback?.(widget.value, app.canvas, node, app.canvas?.graph_mouse);
	refreshNode(node);
}

function getMoreOpen(node) {
	return Boolean(node?.properties?.gjj_video_combine_show_more);
}

function setMoreOpen(node, value) {
	node.properties ||= {};
	node.properties.gjj_video_combine_show_more = Boolean(value);
	updateToolbar(node);
	applySlotVisibility(node);
	refreshNode(node);
}

function makeToolbarButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	return button;
}

function ensureToolbarWidget(node) {
	if (node.__gjjVideoCombineToolbar) {
		return node.__gjjVideoCombineToolbar;
	}
	injectToolbarStyle();
	const wrap = document.createElement("div");
	wrap.className = "gjj-video-combine-toolbar";

	const buttons = {};
	for (const config of BOOL_WIDGETS) {
		buttons[config.name] = makeToolbarButton(config.off, config.label, () => {
			writeBoolWidget(node, config.name, !readBoolWidget(node, config.name));
			updateToolbar(node);
		});
		wrap.appendChild(buttons[config.name]);
	}

	buttons.more = makeToolbarButton("接口", "显示/隐藏其它输入输出口；默认只保留【图像】输入口。", () => {
		setMoreOpen(node, !getMoreOpen(node));
	});
	wrap.appendChild(buttons.more);

	const widget = node.addDOMWidget?.(TOOLBAR_WIDGET_NAME, TOOLBAR_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => TOOLBAR_HEIGHT,
	});
	node.__gjjVideoCombineToolbar = { widget, wrap, buttons };
	updateToolbar(node);
	return node.__gjjVideoCombineToolbar;
}

function updateToolbar(node) {
	const toolbar = node?.__gjjVideoCombineToolbar;
	if (!toolbar) {
		return;
	}
	for (const config of BOOL_WIDGETS) {
		const button = toolbar.buttons[config.name];
		const on = readBoolWidget(node, config.name);
		if (!button) {
			continue;
		}
		button.textContent = on ? config.on : config.off;
		button.classList.toggle("on", on);
		button.title = `${config.label}：${on ? "开启" : "关闭"}`;
	}
	const moreOpen = getMoreOpen(node);
	toolbar.buttons.more.textContent = moreOpen ? "接口 开" : "接口 关";
	toolbar.buttons.more.classList.toggle("more-on", moreOpen);
	toolbar.buttons.more.title = moreOpen
		? "当前显示其它输入输出口；点击后只保留【图像】输入口。"
		: "当前隐藏其它输入输出口；点击后显示音频、VAE 和输出口。";
}

function hideNativeBooleanWidgets(node) {
	for (const config of BOOL_WIDGETS) {
		const widget = getWidget(node, config.name);
		if (!widget) {
			continue;
		}
		GJJ_Utils.hideWidget(widget);
		if (widget.options && typeof widget.options === "object") {
			widget.options.hidden = true;
			widget.options.display = "hidden";
		}
	}
}

function slotHasLink(slot, isOutput) {
	if (!slot) {
		return false;
	}
	if (isOutput) {
		return Array.isArray(slot.links) ? slot.links.length > 0 : slot.links != null;
	}
	return slot.link != null;
}

function applySlotVisibility(node) {
	const moreOpen = getMoreOpen(node);
	captureFullSlots(node);
	if (Array.isArray(node?.inputs)) {
		const fullInputs = getFullInputs(node);
		const visibleInputs = [];
		for (const input of fullInputs) {
			const name = String(input?.name || "");
			const isPrimary = isPrimaryInputName(name);
			const isWidgetInput = !!input?.widget && !isBoolControlWidgetName(input?.widget?.name || name);
			if (isPrimary) {
				const primary = cloneSlot(input);
				primary.name = PRIMARY_INPUT_NAME;
				primary.type = "GJJ_BATCH_IMAGE,IMAGE";
				primary.label = "图像";
				primary.localized_name = "图像";
				visibleInputs.push(primary);
			} else if (isWidgetInput || moreOpen || slotHasLink(input, false)) {
				visibleInputs.push(cloneSlot(input));
			}
		}
		node.inputs = visibleInputs;
	}
	if (Array.isArray(node?.outputs)) {
		const fullOutputs = getFullOutputs(node);
		const visibleOutputs = [];
		for (const output of fullOutputs) {
			if (moreOpen || slotHasLink(output, true)) {
				visibleOutputs.push(cloneSlot(output));
			}
		}
		node.outputs = visibleOutputs;
	}
	refreshNode(node);
}

function captureFullSlots(node) {
	if (!node) {
		return;
	}
	if (!node.__gjjVideoCombineFullInputs && Array.isArray(node.inputs)) {
		node.__gjjVideoCombineFullInputs = node.inputs.map(cloneSlot);
	}
	if (!node.__gjjVideoCombineFullOutputs && Array.isArray(node.outputs)) {
		node.__gjjVideoCombineFullOutputs = node.outputs.map(cloneSlot);
	}
}

function getFullInputs(node) {
	const current = Array.isArray(node?.inputs) ? node.inputs : [];
	const base = Array.isArray(node?.__gjjVideoCombineFullInputs)
		? node.__gjjVideoCombineFullInputs
		: current;
	const byName = new Map();
	for (const slot of base) {
		const key = isPrimaryInputName(slot?.name) ? PRIMARY_INPUT_NAME : String(slot?.name || "");
		byName.set(key, cloneSlot(slot));
	}
	for (const slot of current) {
		const name = isPrimaryInputName(slot?.name) ? PRIMARY_INPUT_NAME : String(slot?.name || "");
		if (!name) {
			continue;
		}
		const saved = byName.get(name) || {};
		byName.set(name, { ...saved, ...cloneSlot(slot) });
	}
	if (!byName.has(PRIMARY_INPUT_NAME)) {
		byName.set(PRIMARY_INPUT_NAME, {
			name: PRIMARY_INPUT_NAME,
			type: "GJJ_BATCH_IMAGE,IMAGE",
			label: "图像",
			localized_name: "图像",
			link: null,
		});
	}
	for (const fallback of OPTIONAL_INPUTS) {
		if (!byName.has(fallback.name)) {
			byName.set(fallback.name, { ...fallback, link: null });
		}
	}
	const ordered = [
		byName.get(PRIMARY_INPUT_NAME),
		...Array.from(byName.values()).filter((slot) => {
			const name = String(slot?.name || "");
			return !isPrimaryInputName(name)
				&& !OPTIONAL_INPUTS.some((optional) => optional.name === name)
				&& !!slot?.widget
				&& !isBoolControlWidgetName(slot?.widget?.name || name);
		}),
		...OPTIONAL_INPUTS.map((slot) => byName.get(slot.name)),
	].filter(Boolean);
	node.__gjjVideoCombineFullInputs = ordered.map(cloneSlot);
	return ordered;
}

function getFullOutputs(node) {
	const current = Array.isArray(node?.outputs) ? node.outputs : [];
	const base = Array.isArray(node?.__gjjVideoCombineFullOutputs)
		? node.__gjjVideoCombineFullOutputs
		: current;
	const byName = new Map();
	for (const slot of base) {
		byName.set(String(slot?.name || ""), cloneSlot(slot));
	}
	for (const slot of current) {
		const name = String(slot?.name || "");
		if (!name) {
			continue;
		}
		const saved = byName.get(name) || {};
		byName.set(name, { ...saved, ...cloneSlot(slot) });
	}
	for (const fallback of OUTPUTS) {
		if (!byName.has(fallback.name)) {
			byName.set(fallback.name, { ...fallback, links: null });
		}
	}
	const ordered = OUTPUTS.map((slot) => byName.get(slot.name)).filter(Boolean);
	node.__gjjVideoCombineFullOutputs = ordered.map(cloneSlot);
	return ordered;
}

function ensurePanelWidget(node) {
	if (node.__gjjVideoCombineStatus) {
		return node.__gjjVideoCombineStatus;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:none",
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
		getHeight: () => getPanelHeight(node),
	});
	node.__gjjVideoCombineStatus = { widget, wrap, text, progressInner, previewCard, empty, video, image };
	setPanelMode(node, node.__gjjVideoCombinePanelMode || "hidden");
	return node.__gjjVideoCombineStatus;
}

function getPanelHeight(node) {
	const mode = String(node?.__gjjVideoCombinePanelMode || "hidden");
	if (mode === "preview") {
		return PANEL_HEIGHT;
	}
	if (mode === "status") {
		return STATUS_PANEL_HEIGHT;
	}
	return HIDDEN_PANEL_HEIGHT;
}

function resizeNodeToContent(node) {
	if (!node) {
		return;
	}
	requestAnimationFrame(() => {
		const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
		const computed = typeof node.computeSize === "function" ? node.computeSize() : node.size;
		const height = Math.max(80, Number(computed?.[1] || node.size?.[1] || 80));
		node.setSize?.([width, height]);
		refreshNode(node);
	});
}

function setPanelMode(node, mode) {
	const state = node?.__gjjVideoCombineStatus;
	if (!state) {
		return;
	}
	const nextMode = ["hidden", "status", "preview"].includes(mode) ? mode : "hidden";
	if (node.__gjjVideoCombinePanelMode === nextMode) {
		return;
	}
	node.__gjjVideoCombinePanelMode = nextMode;
	state.wrap.style.display = nextMode === "hidden" ? "none" : "flex";
	state.previewCard.style.display = nextMode === "preview" ? "flex" : "none";
	if (state.widget) {
		state.widget.getHeight = () => getPanelHeight(node);
		state.widget.computedHeight = getPanelHeight(node);
	}
	refreshNode(node);
	resizeNodeToContent(node);
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
	if (node.__gjjVideoCombinePanelMode !== "preview") {
		setPanelMode(node, "status");
	}
	refreshNode(node);
}
function clearNativePreview(node) {
	if (!node) {
		return;
	}

	// 清理 ComfyUI / LiteGraph 原生图片预览缓存
	node.imgs = [];
	node.imageIndex = null;
	node.overIndex = null;

	// 清理可能存在的动态图 / 视频预览缓存
	node.animatedImages = [];
	node.videoContainer = null;
	node.preview = null;
	node.previews = null;

	// 部分版本会挂在 properties 里
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
		setPanelMode(node, "hidden");
		refreshNode(node);
		return;
	}

	setPanelMode(node, "preview");
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
	if (!node) {
		return;
	}
	node.__gjjVideoCombinePatched = true;
	removeLegacyVideoInputs(node);
	hideNativeBooleanWidgets(node);
	ensureToolbarWidget(node);
	ensurePanelWidget(node);
	applySlotVisibility(node);
	clearNativePreview(node);
	if (!Array.isArray(node.size) || node.size.length < 2) {
		node.setSize?.([MIN_WIDTH, Math.max(80, getPanelHeight(node) + TOOLBAR_HEIGHT + 8)]);
	} else {
		node.setSize?.([
			Math.max(MIN_WIDTH, Number(node.size[0] || MIN_WIDTH)),
			Number(node.size[1] || 80),
		]);
	}
	if (!node.__gjjVideoCombinePanelMode) {
		setPanelMode(node, "hidden");
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

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (isBoolControlWidgetName(name)) {
				GJJ_Utils.hideWidget(widget);
			}
			return widget;
		};

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
			clearNativePreview(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			requestAnimationFrame(() => {
				applySlotVisibility(this);
				updateToolbar(this);
			});
			return result;
		};

		nodeType.prototype.onExecuted = function (message) {
			patchNode(this);

			// 只使用本扩展的 DOM 视频预览，不再调用 ComfyUI 原生 onExecuted 预览。
			setPreview(this, message || {});
			clearNativePreview(this);

			// 有些版本会在 onExecuted 之后异步回填原生预览，延迟再清一次。
			requestAnimationFrame(() => clearNativePreview(this));
			setTimeout(() => clearNativePreview(this), 80);
			setTimeout(() => clearNativePreview(this), 240);

			return undefined;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				patchNode(node);
				clearNativePreview(node);
			}
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "GJJ_VideoSegmentQueue";
const UI_KEY = "gjj_video_segment_queue";
const SELECTED_VIDEO_WIDGET = "selected_video";
const SEGMENT_FRAMES_WIDGET = "segment_frames";
const SEGMENT_INDEX_WIDGET = "segment_index";
const LEGACY_SLIDE_INDEX_INPUT = "slide_start_index";
const MEDIA_INPUT = "media";
const DOM_WIDGET = "gjj_video_segment_queue_controls";
const AUTO_PROP = "gjj_video_segment_queue_auto";
const SELECTED_VIDEO_PROP = "selected_video";
const UPLOAD_API = "/gjj/video_segment_queue/upload";
const META_API = "/gjj/video_segment_queue/meta";
const MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const CONTROL_PANEL_HEIGHT = 58;
const PREVIEW_GAP = 6;
const PY_WIDGET_ORDER = [SELECTED_VIDEO_WIDGET, SEGMENT_FRAMES_WIDGET, SEGMENT_INDEX_WIDGET];
const PARAM_DEFAULTS = {
	[SELECTED_VIDEO_WIDGET]: "",
	[SEGMENT_FRAMES_WIDGET]: 81,
	[SEGMENT_INDEX_WIDGET]: 1,
};
const OUTPUT_DEFS = [
	{ name: "当前段视频帧", type: "GJJ_BATCH_IMAGE,IMAGE", tooltip: "当前分段的 IMAGE batch，兼容 GJJ_BATCH_IMAGE。" },
	{ name: "当前段序号", type: "INT", tooltip: "当前实际输出的 1 基分段序号。" },
];
const WIDGET_INPUT_DEFS = [
	{
		name: SEGMENT_FRAMES_WIDGET,
		type: "INT",
		label: "每段帧数",
		tooltip: "必须是 8N+1：9、17、25、33... 可连接本行前的小圆点用外部数值控制。",
	},
	{
		name: SEGMENT_INDEX_WIDGET,
		type: "INT",
		label: "当前分段序号",
		tooltip: "1 基分段序号。可连接本行前的小圆点作为外部滑动序号；未连接时循环到最后一段停止。",
	},
];
const QUEUE_DELAY_MS = 360;

let activeLoopNodeId = null;
let loopTimer = null;

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function normalizeSlotName(value) {
	return String(value || "").replace(/^converted-widget:/i, "");
}

function findInput(node, name) {
	return node?.inputs?.find((input) => {
		const inputName = normalizeSlotName(input?.name);
		const inputType = normalizeSlotName(input?.type);
		const widgetName = String(input?.widget?.name || input?.widget_name || "");
		return inputName === name || inputType === name || widgetName === name;
	});
}

function hasInputLink(node, name) {
	return Boolean(findInput(node, name)?.link != null);
}

function hasExternalIndexLink(node) {
	return hasInputLink(node, SEGMENT_INDEX_WIDGET);
}

function dirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) return false;
	widget.value = value;
	node.properties ||= {};
	node.properties[name] = value;
	widget.callback?.call(widget, value);
	dirty(node);
	return true;
}

function hideWidget(widget) {
	if (!widget) return;
	if (!widget.__gjjVideoSegmentQueueHidden) {
		widget.__gjjVideoSegmentQueueHidden = true;
		widget.__gjjOriginalType = widget.type;
		widget.__gjjOriginalComputeSize = widget.computeSize;
		widget.__gjjOriginalGetHeight = widget.getHeight;
		widget.__gjjOriginalDraw = widget.draw;
		widget.__gjjOriginalMouse = widget.mouse;
	}
	widget.serialize = true;
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.y = -10000;
	widget.last_y = -10000;
	widget.options = widget.options || {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function removeSelectedVideoInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (input?.name !== SELECTED_VIDEO_WIDGET) continue;
		if (input.link != null) node.disconnectInput?.(index);
		node.removeInput?.(index);
	}
}

function removeInputAt(node, index) {
	if (!Array.isArray(node?.inputs) || index < 0 || index >= node.inputs.length) return;
	if (node.inputs[index]?.link != null) {
		try { node.disconnectInput?.(index); } catch (_) {}
	}
	try { node.removeInput?.(index); }
	catch (_) { node.inputs.splice(index, 1); }
}

function outputDisplayName(output) {
	return normalizeSlotName(output?.localized_name || output?.label || output?.display_name || output?.name);
}

function removeOutputAt(node, index) {
	if (!Array.isArray(node?.outputs) || index < 0 || index >= node.outputs.length) return;
	try { node.disconnectOutput?.(index); } catch (_) {}
	try { node.removeOutput?.(index); }
	catch (_) { node.outputs.splice(index, 1); }
}

function restoreNativeWidget(widget, fallbackType = "number") {
	if (!widget) return;
	const wasConverted = String(widget.type || "").startsWith("converted-widget:");
	const wasHidden = Boolean(widget.hidden || widget.options?.hidden || widget.options?.display === "hidden");
	widget.hidden = false;
	widget.disabled = false;
	widget.serialize = true;
	if (wasConverted) {
		widget.type = widget.__gjjOriginalType || fallbackType;
	}
	if (widget.__gjjOriginalComputeSize) widget.computeSize = widget.__gjjOriginalComputeSize;
	else if (wasConverted || wasHidden) delete widget.computeSize;
	if (widget.__gjjOriginalGetHeight) widget.getHeight = widget.__gjjOriginalGetHeight;
	else if (wasConverted || wasHidden) delete widget.getHeight;
	if (widget.__gjjOriginalDraw) widget.draw = widget.__gjjOriginalDraw;
	else if (wasConverted || wasHidden) delete widget.draw;
	if (widget.__gjjOriginalMouse) widget.mouse = widget.__gjjOriginalMouse;
	else if (wasConverted || wasHidden) delete widget.mouse;
	widget.y = Number.isFinite(Number(widget.y)) ? Math.max(0, Number(widget.y)) : 0;
	widget.last_y = Number.isFinite(Number(widget.last_y)) ? Math.max(0, Number(widget.last_y)) : 0;
	widget.options = widget.options || {};
	delete widget.options.hidden;
	delete widget.options.display;
	for (const element of [widget.inputEl, widget.element, widget.widget]) {
		if (!element?.style) continue;
		element.style.display = "";
		element.style.height = "";
		element.style.minHeight = "";
		element.style.margin = "";
		element.style.padding = "";
		element.style.border = "";
		element.style.overflow = "";
	}
}

function decorateNumberWidget(node, def) {
	const widget = findWidget(node, def.name);
	if (!widget) return null;
	restoreNativeWidget(widget, "number");
	widget.name = def.name;
	widget.label = def.label;
	widget.localized_name = def.label;
	widget.display_name = def.label;
	widget.tooltip = def.tooltip;
	widget.forceInput = false;
	widget.options = widget.options || {};
	widget.options.forceInput = false;
	widget.options.display_name = def.label;
	widget.options.tooltip = def.tooltip;
	if (def.name === SEGMENT_FRAMES_WIDGET) {
		widget.options.step = 8;
		widget.options.min = 9;
	}
	return widget;
}

function ensureWidgetInput(node, def, replacementInput = null) {
	let input = replacementInput || findInput(node, def.name);
	if (!input) {
		node.addInput?.(def.name, def.type);
		input = node.inputs?.[node.inputs.length - 1] || null;
	}
	if (!input) return null;
	input.name = def.name;
	input.type = def.type;
	input.label = def.label;
	input.localized_name = def.label;
	input.display_name = def.label;
	input.tooltip = def.tooltip;
	input.widget = { name: def.name };
	input.forceInput = false;
	input.hidden = false;
	input.visible = true;
	return input;
}

function widgetInputDef(input) {
	const widgetName = String(input?.widget?.name || input?.widget_name || "");
	const inputName = normalizeSlotName(input?.name);
	const inputType = normalizeSlotName(input?.type);
	return WIDGET_INPUT_DEFS.find((def) => def.name === widgetName || def.name === inputName || def.name === inputType) || null;
}

function repairInputLinkSlots(node) {
	const graphLinks = node?.graph?.links || app.graph?.links;
	if (!graphLinks || !Array.isArray(node?.inputs)) return;
	node.inputs.forEach((input, index) => {
		if (input?.link == null) return;
		const link = graphLinks[input.link];
		if (!link) return;
		if (Array.isArray(link)) {
			link[3] = node.id;
			link[4] = index;
		} else {
			link.target_id = node.id;
			link.target_slot = index;
		}
	});
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const managed = new Map();
	const fixed = [];
	for (const input of node.inputs) {
		const def = widgetInputDef(input);
		if (def) {
			if (!managed.has(def.name)) managed.set(def.name, input);
			continue;
		}
		fixed.push(input);
	}
	const orderedManaged = WIDGET_INPUT_DEFS.map((def) => managed.get(def.name)).filter(Boolean);
	const next = [...fixed, ...orderedManaged];
	if (next.length !== node.inputs.length) return;
	let changed = false;
	for (let index = 0; index < next.length; index += 1) {
		if (next[index] !== node.inputs[index]) {
			changed = true;
			break;
		}
	}
	if (changed) {
		node.inputs = next;
		repairInputLinkSlots(node);
	}
}

function snapSegmentFrames(value) {
	let number = Number.parseInt(String(value ?? "").trim(), 10);
	if (!Number.isFinite(number)) number = 81;
	if (number < 9) return 9;
	const n = Math.max(1, Math.round((number - 1) / 8));
	return n * 8 + 1;
}

function normalizeParamValue(name, value) {
	if (name === SELECTED_VIDEO_WIDGET) {
		return typeof value === "string" ? value : "";
	}
	if (name === SEGMENT_FRAMES_WIDGET) {
		return snapSegmentFrames(value);
	}
	if (name === SEGMENT_INDEX_WIDGET) {
		const number = Number.parseInt(String(value ?? ""), 10);
		return Number.isFinite(number) ? Math.max(1, number) : PARAM_DEFAULTS[name];
	}
	return value ?? PARAM_DEFAULTS[name];
}

function canonicalWidgetValues(properties = {}) {
	return PY_WIDGET_ORDER.map((name) => normalizeParamValue(name, properties?.[name]));
}

function putPythonWidgetsFirst(node) {
	if (!Array.isArray(node?.widgets)) return;
	const byName = new Map(node.widgets.map((item) => [String(item?.name || ""), item]));
	const pythonWidgets = PY_WIDGET_ORDER.map((name) => byName.get(name)).filter(Boolean);
	const pythonSet = new Set(pythonWidgets);
	node.widgets = [...pythonWidgets, ...node.widgets.filter((item) => !pythonSet.has(item))];
}

function prepareSerializedParameters(serializedNode) {
	if (!serializedNode) return;
	serializedNode.properties ||= {};
	const raw = Array.isArray(serializedNode.widgets_values) ? serializedNode.widgets_values : [];
	const oldReordered = Number.isFinite(Number(raw[0])) && Number.isFinite(Number(raw[1])) && typeof raw[2] === "string";
	const recovered = oldReordered
		? {
			[SELECTED_VIDEO_WIDGET]: raw[2],
			[SEGMENT_FRAMES_WIDGET]: raw[0],
			[SEGMENT_INDEX_WIDGET]: raw[1],
		}
		: {
			[SELECTED_VIDEO_WIDGET]: raw[0],
			[SEGMENT_FRAMES_WIDGET]: raw[1],
			[SEGMENT_INDEX_WIDGET]: raw[2],
		};
	for (const name of PY_WIDGET_ORDER) {
		const source = serializedNode.properties[name] ?? recovered[name] ?? PARAM_DEFAULTS[name];
		serializedNode.properties[name] = normalizeParamValue(name, source);
	}
	serializedNode.widgets_values = canonicalWidgetValues(serializedNode.properties);
}

function restorePropertiesToWidgets(node) {
	node.properties ||= {};
	for (const name of PY_WIDGET_ORDER) {
		const item = findWidget(node, name);
		const value = normalizeParamValue(name, node.properties[name] ?? item?.value ?? PARAM_DEFAULTS[name]);
		node.properties[name] = value;
		if (item) item.value = value;
	}
}

function normalizeSegmentFrameWidget(node) {
	const widget = findWidget(node, SEGMENT_FRAMES_WIDGET);
	if (!widget) return;
	widget.options = widget.options || {};
	widget.options.step = 8;
	widget.options.min = 9;
	const snapped = snapSegmentFrames(widget.value);
	if (Number(widget.value) !== snapped) {
		widget.value = snapped;
	}
	if (!widget.__gjjVideoSegmentQueueSnapPatched) {
		const originalCallback = widget.callback;
		widget.callback = function (value, ...args) {
			const fixed = snapSegmentFrames(value);
			if (fixed !== value) {
				this.value = fixed;
			}
			return originalCallback?.call(this, fixed, ...args);
		};
		widget.__gjjVideoSegmentQueueSnapPatched = true;
	}
}

function parseSelectedVideo(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || ""));
		const item = Array.isArray(parsed) ? parsed[0] : parsed;
		return item && typeof item === "object" && item.filename ? item : null;
	} catch (_) {
		return null;
	}
}

function selectedVideoFromNode(node, serializedNode = null) {
	const propValue = String(node?.properties?.[SELECTED_VIDEO_PROP] || "");
	if (parseSelectedVideo(propValue)) return propValue;
	const widgetValue = String(findWidget(node, SELECTED_VIDEO_WIDGET)?.value || "");
	if (parseSelectedVideo(widgetValue)) return widgetValue;
	const serializedProp = String(serializedNode?.properties?.[SELECTED_VIDEO_PROP] || "");
	if (parseSelectedVideo(serializedProp)) return serializedProp;
	return propValue || widgetValue || serializedProp || "";
}

function videoLabel(item) {
	if (!item?.filename) return "";
	const subfolder = String(item.subfolder || "");
	return subfolder ? `${subfolder}/${item.filename}` : String(item.filename);
}

function videoViewUrl(item) {
	if (!item?.filename) return "";
	const rand = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}`
		+ `&subfolder=${encodeURIComponent(item.subfolder || "")}`
		+ `&type=${encodeURIComponent(item.type || "input")}${rand}`
	);
}

function previewAspect(item, video = null) {
	const width = Number(item?.width || video?.videoWidth || 0);
	const height = Number(item?.height || video?.videoHeight || 0);
	return width > 0 && height > 0 ? width / height : 16 / 9;
}

function previewHeight(node) {
	const elements = node.__gjjVideoSegmentQueueElements;
	if (!elements?.previewWrap || elements.previewWrap.style.display === "none") return 0;
	const width = Math.max(1, Math.round(Number(node.size?.[0] || 260) - 12));
	const aspect = Math.max(0.05, Number(elements.previewAspect || 16 / 9));
	return Math.max(1, Math.round(width / aspect));
}

function panelHeight(node) {
	const preview = previewHeight(node);
	return Math.round(CONTROL_PANEL_HEIGHT + (preview > 0 ? PREVIEW_GAP + preview : 0));
}

function scheduleNodeResize(node) {
	if (!node) return;
	cancelAnimationFrame(node.__gjjVideoSegmentQueueResizeFrame);
	node.__gjjVideoSegmentQueueResizeFrame = requestAnimationFrame(() => {
		const width = Math.round(Number(node.size?.[0] || 260));
		const computed = node.computeSize?.();
		const height = Math.round(Number(computed?.[1] || node.size?.[1] || panelHeight(node) + 80));
		node.setSize?.([width, height]);
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	});
}

function formatMeta(item) {
	const parts = [];
	const width = Number(item?.width || 0);
	const height = Number(item?.height || 0);
	const frames = Number(item?.frames || 0);
	const fps = Number(item?.fps || 0);
	if (width > 0 && height > 0) parts.push(`${width}×${height}`);
	if (frames > 0) parts.push(`${frames} 帧`);
	if (fps > 0) parts.push(`${fps.toFixed(fps >= 10 ? 1 : 2)} FPS`);
	return parts.join(" · ");
}

function syncSelectedVideo(node, item) {
	const value = item?.filename ? JSON.stringify(item) : "";
	node.properties = node.properties || {};
	node.properties[SELECTED_VIDEO_PROP] = value;
	setWidgetValue(node, SELECTED_VIDEO_WIDGET, value);
	const state = ensureState(node);
	state.selectedVideo = item?.filename ? item : null;
	renderControls(node);
}

function isAutoEnabled(node) {
	return Boolean(node?.properties?.[AUTO_PROP]);
}

function setAutoEnabled(node, enabled) {
	node.properties = node.properties || {};
	node.properties[AUTO_PROP] = Boolean(enabled);
	if (enabled) activeLoopNodeId = String(node.id);
	else if (activeLoopNodeId === String(node.id)) activeLoopNodeId = null;
	renderControls(node);
	dirty(node);
}

function stopLoop(node) {
	if (loopTimer) {
		clearTimeout(loopTimer);
		loopTimer = null;
	}
	setAutoEnabled(node, false);
}

function ensureState(node) {
	node.properties = node.properties || {};
	node.__gjjVideoSegmentQueueState = node.__gjjVideoSegmentQueueState || {
		selectedVideo: parseSelectedVideo(selectedVideoFromNode(node)),
		lastData: null,
		uploading: false,
	};
	return node.__gjjVideoSegmentQueueState;
}

function ensureInputShape(node) {
	const media = findInput(node, MEDIA_INPUT);
	if (media) {
		media.name = MEDIA_INPUT;
		media.label = "外接视频/帧队列";
		media.localized_name = media.label;
		media.type = MEDIA_INPUT_TYPE;
		media.tooltip = "可选。支持 GJJ_BATCH_IMAGE、IMAGE、VIDEO；连接后优先使用外接输入。";
	}
	for (const def of WIDGET_INPUT_DEFS) {
		decorateNumberWidget(node, def);
	}
	const legacyInput = findInput(node, LEGACY_SLIDE_INDEX_INPUT);
	const segmentInput = ensureWidgetInput(
		node,
		WIDGET_INPUT_DEFS.find((def) => def.name === SEGMENT_INDEX_WIDGET),
		legacyInput?.link != null ? legacyInput : null
	);
	const frameInput = ensureWidgetInput(node, WIDGET_INPUT_DEFS.find((def) => def.name === SEGMENT_FRAMES_WIDGET));
	const keptInputs = new Set([segmentInput, frameInput].filter(Boolean));
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (keptInputs.has(input)) continue;
		const inputName = normalizeSlotName(input?.name);
		const inputType = normalizeSlotName(input?.type);
		const widgetName = String(input?.widget?.name || input?.widget_name || "");
		if (
			inputName === SEGMENT_INDEX_WIDGET ||
			inputName === SEGMENT_FRAMES_WIDGET ||
			inputName === LEGACY_SLIDE_INDEX_INPUT ||
			inputType === SEGMENT_INDEX_WIDGET ||
			inputType === SEGMENT_FRAMES_WIDGET ||
			widgetName === SEGMENT_INDEX_WIDGET ||
			widgetName === SEGMENT_FRAMES_WIDGET
		) {
			removeInputAt(node, index);
		}
	}
	reorderInputs(node);
}

function ensureOutputShape(node) {
	if (!Array.isArray(node?.outputs)) return;
	for (let index = node.outputs.length - 1; index >= 0 && node.outputs.length > OUTPUT_DEFS.length; index -= 1) {
		if (outputDisplayName(node.outputs[index]) === "总段数") {
			removeOutputAt(node, index);
		}
	}
	while (node.outputs.length > OUTPUT_DEFS.length) {
		removeOutputAt(node, node.outputs.length - 1);
	}
	while (node.outputs.length < OUTPUT_DEFS.length) {
		const def = OUTPUT_DEFS[node.outputs.length];
		node.addOutput?.(def.name, def.type);
	}
	node.outputs.forEach((output, index) => {
		const def = OUTPUT_DEFS[index];
		if (!def) return;
		output.name = def.name;
		output.label = def.name;
		output.localized_name = def.name;
		output.type = def.type;
		output.tooltip = def.tooltip;
	});
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function ensureStyles(root) {
	if (root.__gjjVideoSegmentQueueStyles) return;
	root.__gjjVideoSegmentQueueStyles = true;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-video-segment-queue{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:5px;padding:1px 2px 0;color:#dce7e2;font:12px/1.35 sans-serif}
		.gjj-video-segment-queue .toolbar{display:flex;gap:5px;align-items:center;min-width:0}
		.gjj-video-segment-queue button{height:28px;min-width:34px;background:#1b252b;border:1px solid #40535d;border-radius:5px;color:#f2fbff;padding:2px 7px;font:700 12px sans-serif;cursor:pointer;white-space:nowrap}
		.gjj-video-segment-queue button.on{background:#1f6b43;border-color:#4db376;color:#fff;box-shadow:0 0 0 1px rgba(77,179,118,.28) inset}
		.gjj-video-segment-queue .summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9c8ce;background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.06);border-radius:5px;padding:4px 7px}
		.gjj-video-segment-queue .status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8fa7b1;font-size:11px;padding:0 2px}
		.gjj-video-segment-queue .preview{display:none;width:100%;box-sizing:border-box;overflow:hidden;border:1px solid #33454d;border-radius:6px;background:#080d10}
		.gjj-video-segment-queue .preview video{display:block;width:100%;height:auto;max-width:none;max-height:none;object-fit:contain;background:#080d10}
	`;
	root.appendChild(style);
}

function makeButton(text, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = text;
	button.title = title;
	return button;
}

async function fetchMeta(item) {
	if (!item?.filename) return item;
	try {
		const url = api.apiURL(`${META_API}?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder || "")}`);
		const response = await fetch(url, { cache: "no-store" });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data?.ok === false) throw new Error(data?.error || "读取视频信息失败");
		return { ...item, ...(data.video || {}) };
	} catch (_) {
		return item;
	}
}

async function uploadVideo(node, file) {
	const state = ensureState(node);
	state.uploading = true;
	renderControls(node);
	try {
		const formData = new FormData();
		formData.append("video", file, file.name || "video.mp4");
		const response = await fetch(api.apiURL(UPLOAD_API), { method: "POST", body: formData });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data?.ok === false) throw new Error(data?.error || `上传失败：HTTP ${response.status}`);
		const item = await fetchMeta(data.video || {});
		syncSelectedVideo(node, item);
	} catch (error) {
		state.lastData = { status: error?.message || "视频导入失败" };
		renderControls(node);
	} finally {
		state.uploading = false;
		renderControls(node);
	}
}

function buildControls(node) {
	const container = document.createElement("div");
	container.className = "gjj-video-segment-queue";
	ensureStyles(container);

	const toolbar = document.createElement("div");
	toolbar.className = "toolbar";
	const browseButton = makeButton("📁", "打开视频：导入一个视频到 ComfyUI input 目录并作为内部视频源。");
	const resetButton = makeButton("🏁", "初始化：当前分段序号重置为 1。");
	const loopButton = makeButton("▶️ 循环", "循环队列：未接外部滑动序号时，执行后自动推进分段，到最后一段后停止。");
	const summary = document.createElement("div");
	summary.className = "summary";
	const status = document.createElement("div");
	status.className = "status";
	const previewWrap = document.createElement("div");
	previewWrap.className = "preview";
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "video/*,.mp4,.mov,.m4v,.webm,.avi,.mkv,.wmv,.flv,.mpeg,.mpg,.gif";
	input.style.display = "none";

	for (const eventName of ["mousedown", "pointerdown", "click"]) {
		container.addEventListener(eventName, (event) => event.stopPropagation());
	}

	browseButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		input.click();
	});
	resetButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (loopTimer) {
			clearTimeout(loopTimer);
			loopTimer = null;
		}
		setWidgetValue(node, SEGMENT_INDEX_WIDGET, 1);
	});
	loopButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (hasExternalIndexLink(node)) {
			stopLoop(node);
			return;
		}
		if (isAutoEnabled(node)) {
			stopLoop(node);
			return;
		}
		setAutoEnabled(node, true);
		try {
			await app.queuePrompt(0);
		} catch (_) {
			stopLoop(node);
		}
	});
	input.addEventListener("click", (event) => event.stopPropagation());
	input.addEventListener("change", async (event) => {
		event.stopPropagation();
		const file = Array.from(event.target?.files || [])[0];
		input.value = "";
		if (file) await uploadVideo(node, file);
	});

	toolbar.append(browseButton, resetButton, loopButton, summary);
	container.append(toolbar, status, input);
	node.__gjjVideoSegmentQueueElements = {
		container,
		browseButton,
		resetButton,
		loopButton,
		summary,
		status,
		previewWrap,
		video: null,
		input,
	};
	return container;
}

function renderVideoPreview(node, selected) {
	const elements = node.__gjjVideoSegmentQueueElements;
	if (!elements) return;
	if (!selected?.filename) {
		if (elements.video) {
			elements.video.pause?.();
			elements.video.removeAttribute("src");
			elements.video.load?.();
			elements.video.remove();
			elements.video = null;
		}
		elements.previewWrap.remove();
		elements.previewWrap.style.display = "none";
		elements.previewSource = "";
		elements.previewSignature = "";
		scheduleNodeResize(node);
		return;
	}

	if (!elements.previewWrap.isConnected) {
		elements.container.appendChild(elements.previewWrap);
	}
	const signature = [
		selected.type || "input",
		selected.subfolder || "",
		selected.filename || "",
		selected.mtime_ns || "",
		selected.size_bytes || "",
	].join("|");
	elements.previewAspect = previewAspect(selected, elements.video);
	elements.previewWrap.style.display = "block";
	elements.previewWrap.style.aspectRatio = String(elements.previewAspect);
	if (!elements.video) {
		const video = document.createElement("video");
		video.controls = true;
		video.preload = "metadata";
		video.playsInline = true;
		video.muted = true;
		video.loop = true;
		video.title = "原视频预览";
		for (const eventName of ["mousedown", "pointerdown", "click", "dblclick", "wheel"]) {
			video.addEventListener(eventName, (event) => event.stopPropagation());
		}
		video.addEventListener("loadedmetadata", () => {
			elements.previewAspect = previewAspect(selected, video);
			elements.previewWrap.style.aspectRatio = String(elements.previewAspect);
			scheduleNodeResize(node);
		});
		elements.previewWrap.appendChild(video);
		elements.video = video;
	}
	if (elements.previewSignature !== signature) {
		elements.previewSignature = signature;
		elements.previewSource = videoViewUrl(selected);
		elements.video.src = elements.previewSource;
		elements.video.load();
	}
	scheduleNodeResize(node);
}

function renderControls(node) {
	const state = ensureState(node);
	const elements = node.__gjjVideoSegmentQueueElements;
	if (!elements) return;
	const selected = state.selectedVideo || parseSelectedVideo(selectedVideoFromNode(node));
	state.selectedVideo = selected;
	const externalMedia = hasInputLink(node, MEDIA_INPUT);
	const externalIndex = hasExternalIndexLink(node);
	const auto = isAutoEnabled(node) && !externalIndex;
	elements.loopButton.classList.toggle("on", auto);
	elements.loopButton.textContent = externalIndex ? "🔗 外控" : (auto ? "⏹️ 停止" : "▶️ 循环");
	elements.loopButton.title = externalIndex
		? "已接入滑动序号：当前分段交给外部序号控制。"
		: (auto ? "停止循环队列。" : "启动循环队列：执行后自动推进分段，到最后一段后停止。");
	elements.loopButton.style.opacity = externalIndex ? "0.72" : "1";
	elements.browseButton.disabled = state.uploading;
	elements.browseButton.textContent = state.uploading ? "⏳" : "📁";

	const meta = selected ? formatMeta(selected) : "";
	if (externalMedia) {
		elements.summary.textContent = "外接输入优先";
	} else if (state.uploading) {
		elements.summary.textContent = "正在导入视频...";
	} else if (selected) {
		elements.summary.textContent = meta ? `${videoLabel(selected)} · ${meta}` : videoLabel(selected);
	} else {
		elements.summary.textContent = "点击 📁 导入视频，或连接外接视频/帧队列";
	}
	const data = state.lastData || {};
	elements.status.textContent = data.status || data.range_text || "每段帧数按 9、17、25、33... 递进，末段只裁齐不补帧";
	renderVideoPreview(node, externalMedia ? null : selected);
}

function ensureDomWidget(node) {
	if (node.__gjjVideoSegmentQueueWidget) {
		renderControls(node);
		return;
	}
	const container = buildControls(node);
	const widget = node.addDOMWidget(DOM_WIDGET, "HTML", container, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 260)), panelHeight(node)];
	widget.getHeight = () => panelHeight(node);
	widget.draw = () => {};
	node.__gjjVideoSegmentQueueWidget = widget;
	reorderWidgets(node);
	renderControls(node);
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	const priority = (widget) => {
		const name = String(widget?.name || "");
		if (name === DOM_WIDGET) return 10;
		if (name === SEGMENT_FRAMES_WIDGET) return 20;
		if (name === SEGMENT_INDEX_WIDGET) return 30;
		if (name === SELECTED_VIDEO_WIDGET) return 90;
		return 50;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((a, b) => priority(a.widget) - priority(b.widget) || a.index - b.index)
		.map((entry) => entry.widget);
}

function stabilizeNode(node) {
	if (!node || node.comfyClass !== NODE_NAME) return;
	restorePropertiesToWidgets(node);
	hideWidget(findWidget(node, SELECTED_VIDEO_WIDGET));
	removeSelectedVideoInputs(node);
	normalizeSegmentFrameWidget(node);
	ensureInputShape(node);
	ensureOutputShape(node);
	ensureDomWidget(node);
	reorderWidgets(node);
	if (hasExternalIndexLink(node) && isAutoEnabled(node)) {
		stopLoop(node);
	}
	renderControls(node);
	dirty(node);
}

function scheduleStabilize(node, ms = 32) {
	if (!node || node.comfyClass !== NODE_NAME) return;
	clearTimeout(node.__gjjVideoSegmentQueueTimer);
	node.__gjjVideoSegmentQueueTimer = setTimeout(() => stabilizeNode(node), ms);
}

function queueNext(node, data) {
	if (!node || !isAutoEnabled(node) || hasExternalIndexLink(node)) {
		if (node) stopLoop(node);
		return;
	}
	const total = Number(data?.total_segments || 0);
	if (!Number.isFinite(total) || total <= 0) {
		stopLoop(node);
		return;
	}
	const current = Number(data?.current_segment || findWidget(node, SEGMENT_INDEX_WIDGET)?.value || 1);
	if (current >= total) {
		stopLoop(node);
		return;
	}
	const next = current + 1;
	setWidgetValue(node, SEGMENT_INDEX_WIDGET, next);
	loopTimer = setTimeout(async () => {
		loopTimer = null;
		if (!isAutoEnabled(node) || hasExternalIndexLink(node)) {
			stopLoop(node);
			return;
		}
		try {
			await app.queuePrompt(0);
		} catch (_) {
			stopLoop(node);
		}
	}, QUEUE_DELAY_MS);
}

function activeLoopNode() {
	if (!activeLoopNodeId) return null;
	return app.graph?.getNodeById?.(Number(activeLoopNodeId)) || app.graph?._nodes_by_id?.[activeLoopNodeId] || null;
}

api.addEventListener("execution_error", () => {
	const node = activeLoopNode();
	if (node) stopLoop(node);
});

api.addEventListener("execution_interrupted", () => {
	const node = activeLoopNode();
	if (node) stopLoop(node);
});

api.addEventListener("execution_success", () => {
	const node = activeLoopNode();
	if (!node || node.comfyClass !== NODE_NAME) return;
	const data = ensureState(node).lastData;
	if (data) queueNext(node, data);
});

app.registerExtension({
	name: "GJJ.VideoSegmentQueue",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			setTimeout(() => stabilizeNode(this), 80);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			prepareSerializedParameters(args[0]);
			putPythonWidgetsFirst(this);
			const result = originalOnConfigure?.apply(this, args);
			this.properties ||= {};
			Object.assign(this.properties, args[0]?.properties || {});
			restorePropertiesToWidgets(this);
			const state = ensureState(this);
			state.selectedVideo = parseSelectedVideo(selectedVideoFromNode(this, args[0]));
			if (state.selectedVideo) syncSelectedVideo(this, state.selectedVideo);
			scheduleStabilize(this, 0);
			setTimeout(() => stabilizeNode(this), 80);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const selected = selectedVideoFromNode(this);
			this.properties = this.properties || {};
			this.properties[SELECTED_VIDEO_PROP] = selected;
			for (const name of PY_WIDGET_ORDER) {
				const item = findWidget(this, name);
				if (item) this.properties[name] = normalizeParamValue(name, item.value);
			}
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				Object.assign(serializedNode.properties, this.properties);
				serializedNode.properties[AUTO_PROP] = Boolean(this.properties[AUTO_PROP]);
				serializedNode.widgets_values = canonicalWidgetValues(this.properties);
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			if (data) {
				ensureState(this).lastData = data;
				if (hasExternalIndexLink(this)) {
					setWidgetValue(this, SEGMENT_INDEX_WIDGET, Math.max(1, Number(data.current_segment || 1)));
					stopLoop(this);
				}
			}
			renderControls(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			if (hasExternalIndexLink(this)) stopLoop(this);
			scheduleStabilize(this);
			setTimeout(() => stabilizeNode(this), 80);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (size, ...args) {
			const result = originalOnResize?.apply(this, [size, ...args]);
			const width = Math.round(Number(size?.[0] || this.size?.[0] || 0));
			if (width > 0 && width !== this.__gjjVideoSegmentQueueLastWidth) {
				this.__gjjVideoSegmentQueueLastWidth = width;
				scheduleNodeResize(this);
			}
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_NAME) {
				scheduleStabilize(node, 0);
			}
		}
	},
});

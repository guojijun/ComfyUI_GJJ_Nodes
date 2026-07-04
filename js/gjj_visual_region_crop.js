import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_VisualRegionCrop"]);
const WIDGET_NAME = "gjj_visual_region_crop_editor";
const CROP_WIDGET = "crop_data";
const PREVIEW_WIDTH_WIDGET = "preview_width";
const SELECTED_VIDEO_WIDGET = "selected_video";
const PREVIEW_FRAME_WIDGET = "preview_frame";
const MEDIA_INPUT = "media";
const EXTRA_OUTPUTS_PROPERTY = "gjj_visual_region_crop_show_extra_outputs";
const SELECTED_VIDEO_PROPERTY = "selected_video";
const UPLOAD_API = "/gjj/visual_region_crop/upload";
const META_API = "/gjj/visual_region_crop/meta";
const MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const ALIGN = 64;
const MIN_CROP_SIZE = 256;
const NATIVE_CANVAS_PREVIEW_WIDGET = "$$canvas-image-preview";
const NATIVE_PREVIEW_WIDGET_PATTERN = /(?:preview|image|images|img|预览|图像|图片)/i;
const OUTPUT_DEFS = [
	{ name: "裁切帧序列", type: "IMAGE", tooltip: "裁切后的连续视频帧序列。" },
	{ name: "宽度", type: "INT,FLOAT,STRING", tooltip: "当前裁切区域宽度。点击 🔌 可显示或收起。" },
	{ name: "高度", type: "INT,FLOAT,STRING", tooltip: "当前裁切区域高度。点击 🔌 可显示或收起。" },
	{ name: "帧数", type: "INT", tooltip: "输出帧序列数量。点击 🔌 可显示或收起。" },
	{ name: "关键帧JSON", type: "STRING", tooltip: "裁切区域关键帧 JSON。点击 🔌 可显示或收起。" },
];

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function inputMatchesName(input, name) {
	const inputName = String(input?.name || "").replace(/^converted-widget:/i, "");
	const inputType = String(input?.type || "").replace(/^converted-widget:/i, "");
	const widgetName = String(input?.widget?.name || input?.widget_name || "");
	return inputName === name || inputType === name || widgetName === name;
}

function hasInputLink(node, name) {
	return Boolean(node?.inputs?.some((input) => inputMatchesName(input, name) && input?.link != null));
}

function widgetValue(node, name, fallback = "") {
	const w = widget(node, name);
	return w?.value ?? fallback;
}

function setWidgetValue(node, name, value) {
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	try { w.callback?.(value); } catch (_) {}
}

function clearNativePreview(node) {
	if (!node) return;
	suppressNativePreviewProperties(node);
	node.imgs = [];
	node.images = [];
	node._imgs = [];
	node._images = [];
	node.imageRects = [];
	node.animatedImages = [];
	node.imageIndex = 0;
	node.overIndex = null;
	node.pointerOverPos = null;
	node.image = null;
	node.preview = null;
	node.previews = null;
	node.hideOutputImages = true;
	hideLegacyPreviewWidgets(node);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideNativeWidget(widget) {
	if (!widget) return widget;
	widget.type = "hidden";
	widget.hidden = true;
	widget.serialize = false;
	widget.serializeValue = () => undefined;
	widget.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0 });
	widget.computeSize = () => [0, 0];
	widget.drawWidget = () => {};
	widget.draw = () => {};
	for (const key of ["element", "inputEl", "container", "dom", "root"]) {
		const element = widget?.[key];
		if (element?.style) element.style.display = "none";
		if (typeof element?.remove === "function") element.remove();
	}
	return widget;
}

function isNativePreviewWidget(node, widget) {
	if (!widget || widget === node?.__gjjVisualRegionCrop?.widget) return false;
	const name = String(widget?.name || "");
	if (name === WIDGET_NAME) return false;
	if (name === NATIVE_CANVAS_PREVIEW_WIDGET) return true;
	const label = String(widget?.label || "");
	const type = String(widget?.type || "");
	const optionsType = String(widget?.options?.type || "");
	const optionsName = String(widget?.options?.name || "");
	const constructorName = String(widget?.constructor?.name || "");
	const text = `${name} ${label} ${type} ${optionsType} ${optionsName} ${constructorName}`;
	if (NATIVE_PREVIEW_WIDGET_PATTERN.test(text) && !/^(number|combo|text|string|customtext|toggle|boolean|slider|html)$/i.test(type)) {
		return true;
	}
	for (const key of ["element", "inputEl", "container", "dom", "root"]) {
		const element = widget?.[key];
		if (typeof element?.querySelector === "function" && element.querySelector("img, canvas, video")) {
			return true;
		}
	}
	return false;
}

function hideLegacyPreviewWidgets(node) {
	if (!Array.isArray(node?.widgets)) return false;
	let changed = false;
	for (let index = node.widgets.length - 1; index >= 0; index--) {
		const current = node.widgets[index];
		if (!isNativePreviewWidget(node, current)) continue;
		hideNativeWidget(current);
		node.widgets.splice(index, 1);
		changed = true;
	}
	return changed;
}

function nativePreviewEmptyArray(node, key) {
	if (!node.__gjjVisualRegionCropNativeEmptyArrays) {
		Object.defineProperty(node, "__gjjVisualRegionCropNativeEmptyArrays", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: {},
		});
	}
	if (!Array.isArray(node.__gjjVisualRegionCropNativeEmptyArrays[key])) {
		node.__gjjVisualRegionCropNativeEmptyArrays[key] = [];
	}
	node.__gjjVisualRegionCropNativeEmptyArrays[key].length = 0;
	return node.__gjjVisualRegionCropNativeEmptyArrays[key];
}

function defineSuppressedNativePreviewProperty(node, key, emptyValue) {
	const descriptor = Object.getOwnPropertyDescriptor(node, key);
	if (descriptor?.get?.__gjjVisualRegionCropSuppressNativePreview) return;
	const getter = function () {
		return Array.isArray(emptyValue) ? nativePreviewEmptyArray(this, key) : emptyValue;
	};
	getter.__gjjVisualRegionCropSuppressNativePreview = true;
	try {
		Object.defineProperty(node, key, {
			configurable: true,
			enumerable: false,
			get: getter,
			set() {
				if (Array.isArray(emptyValue)) nativePreviewEmptyArray(this, key);
			},
		});
	} catch (_) {
		try { node[key] = Array.isArray(emptyValue) ? [] : emptyValue; } catch (_error) {}
	}
}

function suppressNativePreviewProperties(node) {
	if (!node) return;
	defineSuppressedNativePreviewProperty(node, "imgs", []);
	defineSuppressedNativePreviewProperty(node, "images", []);
	defineSuppressedNativePreviewProperty(node, "_imgs", []);
	defineSuppressedNativePreviewProperty(node, "_images", []);
	defineSuppressedNativePreviewProperty(node, "imageRects", []);
	defineSuppressedNativePreviewProperty(node, "animatedImages", []);
	defineSuppressedNativePreviewProperty(node, "preview", null);
	defineSuppressedNativePreviewProperty(node, "previews", null);
	defineSuppressedNativePreviewProperty(node, "image", null);
	defineSuppressedNativePreviewProperty(node, "imageIndex", null);
	defineSuppressedNativePreviewProperty(node, "overIndex", null);
	defineSuppressedNativePreviewProperty(node, "hideOutputImages", true);
	if (node.constructor?.nodeData) node.constructor.nodeData.output_preview = false;
}

function scheduleNativePreviewClear(node) {
	clearNativePreview(node);
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => clearNativePreview(node));
	}
	for (const delay of [80, 180, 360, 720, 1400, 2400]) {
		setTimeout(() => clearNativePreview(node), delay);
	}
}

function clearExecutedPreviewPayload(message) {
	if (!message || typeof message !== "object") return;
	for (const key of ["images", "imgs", "preview", "previews", "animatedImages"]) {
		if (Object.prototype.hasOwnProperty.call(message, key)) {
			message[key] = Array.isArray(message[key]) ? [] : null;
		}
	}
	for (const parent of [message.ui, message.output, message.results]) {
		if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
		for (const key of ["images", "imgs", "preview", "previews", "animatedImages"]) {
			if (Object.prototype.hasOwnProperty.call(parent, key)) {
				parent[key] = Array.isArray(parent[key]) ? [] : null;
			}
		}
	}
	if (Array.isArray(message.ui)) {
		for (const item of message.ui) clearExecutedPreviewPayload(item);
	}
}

function syncNodeWidgetValues(node) {
	if (!Array.isArray(node?.widgets)) return;
	try {
		node.widgets_values = node.widgets.map((item) => {
			try {
				if (typeof item?.serializeValue === "function") return item.serializeValue(node, item);
			} catch (_) {}
			return item?.value;
		});
	} catch (_) {}
}

function hideWidget(node, name) {
	const w = widget(node, name);
	if (!w) return;
	GJJ_Utils.hideWidget(w);
	w.options ||= {};
	w.options.hidden = true;
	w.options.display = "hidden";
}

function parseJson(text, fallback = {}) {
	try {
		const data = JSON.parse(String(text || ""));
		return data && typeof data === "object" && !Array.isArray(data) ? data : fallback;
	} catch (_) {
		return fallback;
	}
}

function parseSelectedVideo(value) {
	if (!value) return null;
	let parsed = value;
	if (typeof value === "string") {
		const text = value.trim();
		if (!text) return null;
		try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
	}
	if (Array.isArray(parsed)) parsed = parsed[0];
	if (parsed && typeof parsed === "object") {
		const filename = String(parsed.filename || "").trim();
		const subfolder = String(parsed.subfolder || "").trim().replaceAll("\\", "/");
		return filename ? { ...parsed, filename, subfolder } : null;
	}
	const text = String(parsed || "").trim().replaceAll("\\", "/");
	if (!text) return null;
	const parts = text.split("/").filter(Boolean);
	if (!parts.length) return null;
	return { filename: parts[parts.length - 1], subfolder: parts.slice(0, -1).join("/") };
}

function selectedVideoFromNode(node) {
	return node?.properties?.[SELECTED_VIDEO_PROPERTY] || widgetValue(node, SELECTED_VIDEO_WIDGET, "");
}

function videoLabel(item) {
	if (!item?.filename) return "";
	const folder = item.subfolder ? `${item.subfolder}/` : "";
	return `${folder}${item.filename}`;
}

function formatMeta(item) {
	const parts = [];
	if (item?.width && item?.height) parts.push(`${item.width}x${item.height}`);
	if (item?.frames) parts.push(`${item.frames}帧`);
	if (item?.fps) parts.push(`${Number(item.fps).toFixed(Number(item.fps) % 1 ? 2 : 0)}fps`);
	return parts.join(" / ");
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, Number(value) || 0));
}

function positiveNumber(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : fallback;
}

function alignDownRaw(value) {
	const raw = Math.max(1, Math.round(Number(value) || 1));
	if (raw < ALIGN) return raw;
	return Math.max(ALIGN, Math.floor(raw / ALIGN) * ALIGN);
}

function minCropSize(limit) {
	const max = Math.max(1, Math.round(positiveNumber(limit, MIN_CROP_SIZE)));
	return max < MIN_CROP_SIZE ? alignDownRaw(max) : MIN_CROP_SIZE;
}

function alignDown(value, limit = Infinity) {
	const fallbackLimit = Math.max(1, Math.round(Number(value) || MIN_CROP_SIZE));
	const max = Math.max(1, Math.round(positiveNumber(limit, fallbackLimit)));
	const minSize = minCropSize(max);
	let raw = Math.max(minSize, Math.min(max, Math.round(Number(value) || minSize)));
	if (raw >= ALIGN) raw = alignDownRaw(raw);
	if (raw < minSize) raw = minSize;
	if (raw > max) raw = alignDownRaw(max);
	return Math.max(1, Math.min(max, raw));
}

function buildViewUrl(item, defaultType = "temp", cacheBust = true) {
	if (!item?.filename) return "";
	const rand = cacheBust ? (typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`) : "";
	return api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || defaultType)}&subfolder=${encodeURIComponent(item.subfolder || "")}${rand}`);
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

function sourceVideoItem(node, state) {
	if (state?.upstreamVideo?.filename) return state.upstreamVideo;
	if (hasInputLink(node, MEDIA_INPUT)) return null;
	return state?.selectedVideo || parseSelectedVideo(selectedVideoFromNode(node));
}

function frameTimeForVideo(state) {
	const item = state.videoItem || state.selectedVideo || {};
	const fps = positiveNumber(item.fps);
	if (fps > 0) return state.frame / fps;
	const duration = positiveNumber(item.duration) || positiveNumber(state.video?.duration);
	if (duration > 0 && state.data.frame_count > 1) {
		return (state.frame / Math.max(1, state.data.frame_count - 1)) * duration;
	}
	return 0;
}

function syncVideoFrame(state) {
	if (!state?.video || !state.videoReady || !state.videoBackgroundUrl) return;
	const target = frameTimeForVideo(state);
	if (!Number.isFinite(target)) return;
	const duration = positiveNumber(state.video.duration, target);
	const nextTime = Math.max(0, Math.min(duration, target));
	if (Math.abs(Number(state.video.currentTime || 0) - nextTime) <= 0.035) return;
	try { state.video.currentTime = nextTime; } catch (_) {}
}

function syncPreviewFrameWidget(node, state) {
	setWidgetValue(node, PREVIEW_FRAME_WIDGET, Math.max(0, Math.round(Number(state?.frame || 0))));
}

function scheduleExternalPreviewRefresh(node, delay = 260) {
	const state = node?.__gjjVisualRegionCrop;
	if (!state || !hasInputLink(node, MEDIA_INPUT)) return;
	if (state.upstreamVideo?.filename) {
		syncVideoFrame(state);
		drawState(node, state);
		return;
	}
	clearTimeout(state.previewFrameTimer);
	state.previewFrameTimer = setTimeout(async () => {
		syncPreviewFrameWidget(node, state);
		await refreshPreview(node);
	}, delay);
}

function syncVideoBackground(node, state) {
	const item = sourceVideoItem(node, state);
	const url = item?.filename ? buildViewUrl(item, "input", false) : "";
	if (!url) {
		if (state.videoBackgroundUrl) {
			try { state.video.pause(); } catch (_) {}
			try { state.video.removeAttribute("src"); state.video.load(); } catch (_) {}
		}
		state.videoBackgroundUrl = "";
		state.videoReady = false;
		state.videoItem = null;
		return;
	}
	state.videoItem = item;
	if (state.videoBackgroundUrl === url) {
		syncVideoFrame(state);
		return;
	}
	state.videoBackgroundUrl = url;
	state.videoReady = false;
	state.video.muted = true;
	state.video.playsInline = true;
	state.video.preload = "auto";
	state.video.src = url;
	try { state.video.load(); } catch (_) {}
}

function frameFromSliderEvent(state, event) {
	const rect = state.slider.getBoundingClientRect();
	const ratio = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
	return Math.round(ratio * Math.max(0, state.data.frame_count - 1));
}

function lockRangeEnd(start, end, frameCount) {
	const maxFrame = Math.max(0, Math.round(Number(frameCount || 1)) - 1);
	const startFrame = Math.round(clamp(start, 0, maxFrame));
	const rawEnd = Math.round(clamp(end, startFrame, maxFrame));
	return startFrame + Math.floor((rawEnd - startFrame) / 8) * 8;
}

function normalizeFrameRange(data, frameCount) {
	const frames = Math.max(1, Math.round(Number(frameCount || 1)));
	const maxFrame = frames - 1;
	const start = Math.round(clamp(data?.range_start ?? 0, 0, maxFrame));
	const rawEnd = data?.range_end ?? maxFrame;
	const end = lockRangeEnd(start, rawEnd, frames);
	return {
		range_start: start,
		range_end: end,
		output_frame_count: Math.max(1, end - start + 1),
	};
}

function setRangeStart(data, frame) {
	const start = Math.round(clamp(frame, 0, data.frame_count - 1));
	data.range_start = start;
	data.range_end = lockRangeEnd(start, data.range_end ?? data.frame_count - 1, data.frame_count);
	data.output_frame_count = data.range_end - data.range_start + 1;
	data.range_user_set = true;
}

function setRangeEnd(data, frame) {
	data.range_end = lockRangeEnd(data.range_start ?? 0, frame, data.frame_count);
	data.output_frame_count = data.range_end - data.range_start + 1;
	data.range_user_set = true;
}

function renderKeyframeMarks(state) {
	if (!state?.sliderMarks) return;
	state.sliderMarks.replaceChildren();
	const maxFrame = Math.max(0, state.data.frame_count - 1);
	const rangeStart = Math.round(clamp(state.data.range_start ?? 0, 0, maxFrame));
	const rangeEnd = Math.round(clamp(state.data.range_end ?? maxFrame, 0, maxFrame));
	for (const range of [
		["range-start", rangeStart, `起始帧 ${rangeStart + 1}`],
		["range-end", rangeEnd, `结束帧 ${rangeEnd + 1} / 输出 ${Math.max(1, rangeEnd - rangeStart + 1)} 帧`],
	]) {
		const mark = document.createElement("span");
		mark.className = `gjj-visual-crop-range-mark ${range[0]}`;
		mark.title = range[2];
		mark.style.left = maxFrame > 0 ? `${(range[1] / maxFrame) * 100}%` : "0%";
		state.sliderMarks.append(mark);
	}
	for (const key of state.data.keyframes || []) {
		const frame = Math.round(clamp(key.frame, 0, maxFrame));
		const mark = document.createElement("span");
		mark.className = "gjj-visual-crop-slider-mark";
		mark.dataset.frame = String(frame);
		mark.title = `关键帧 ${frame + 1}`;
		mark.style.left = maxFrame > 0 ? `${(frame / maxFrame) * 100}%` : "0%";
		state.sliderMarks.append(mark);
	}
}

function defaultData(sourceWidth = 0, sourceHeight = 0, frameCount = 1) {
	const width = alignDown(sourceWidth || 512, sourceWidth || 512);
	const height = alignDown(sourceHeight || 512, sourceHeight || 512);
	const frames = Math.max(1, Math.round(frameCount || 1));
	const range = normalizeFrameRange({ range_start: 0, range_end: frames - 1 }, frames);
	return {
		version: 1,
		source_width: Math.max(1, Math.round(sourceWidth || width)),
		source_height: Math.max(1, Math.round(sourceHeight || height)),
		frame_count: frames,
		...range,
		width,
		height,
		keyframes: [{
			frame: 0,
			x: Math.max(0, Math.round(((sourceWidth || width) - width) / 2)),
			y: Math.max(0, Math.round(((sourceHeight || height) - height) / 2)),
		}],
	};
}

function normalizeData(data, sourceWidth = 0, sourceHeight = 0, frameCount = 0) {
	const fallback = defaultData(sourceWidth, sourceHeight, frameCount);
	const srcW = Math.max(1, Math.round(positiveNumber(sourceWidth) || positiveNumber(data?.source_width) || fallback.source_width));
	const srcH = Math.max(1, Math.round(positiveNumber(sourceHeight) || positiveNumber(data?.source_height) || fallback.source_height));
	const frames = Math.max(1, Math.round(positiveNumber(frameCount) || positiveNumber(data?.frame_count) || fallback.frame_count));
	const width = alignDown(data?.width || fallback.width, srcW);
	const height = alignDown(data?.height || fallback.height, srcH);
	const rangeUserSet = data?.range_user_set === true || data?.range_user_set === 1 || data?.range_user_set === "true";
	const legacyFirstFrameDefault = !rangeUserSet
		&& data
		&& Number(data.range_start ?? 0) === 0
		&& Number(data.range_end ?? 0) === 0;
	const missingRange = !data || data.range_start == null || data.range_end == null;
	const rangeSource = (missingRange || legacyFirstFrameDefault)
		? { ...(data || fallback), range_start: 0, range_end: frames - 1 }
		: data;
	const range = normalizeFrameRange(rangeSource || fallback, frames);
	const fullRange = range.range_start === 0 && range.range_end === lockRangeEnd(0, frames - 1, frames);
	const maxX = Math.max(0, srcW - width);
	const maxY = Math.max(0, srcH - height);
	const byFrame = new Map();
	for (const raw of Array.isArray(data?.keyframes) ? data.keyframes : fallback.keyframes) {
		if (!raw || typeof raw !== "object") continue;
		const frame = Math.round(clamp(raw.frame, 0, frames - 1));
		byFrame.set(frame, {
			frame,
			x: Math.round(clamp(raw.x, 0, maxX)),
			y: Math.round(clamp(raw.y, 0, maxY)),
		});
	}
	if (!byFrame.size) byFrame.set(0, fallback.keyframes[0]);
	return {
		version: 1,
		source_width: srcW,
		source_height: srcH,
		frame_count: frames,
		...range,
		width,
		height,
		keyframes: [...byFrame.values()].sort((a, b) => a.frame - b.frame),
		range_user_set: rangeUserSet || (!missingRange && !legacyFirstFrameDefault && !fullRange),
	};
}

function keyframeAt(data, frame) {
	return data.keyframes.find((item) => item.frame === frame) || null;
}

function interpolatedRect(data, frame) {
	const keys = data.keyframes;
	if (!keys.length) return { x: 0, y: 0, width: data.width, height: data.height };
	if (frame <= keys[0].frame) return { x: keys[0].x, y: keys[0].y, width: data.width, height: data.height };
	if (frame >= keys[keys.length - 1].frame) return { x: keys[keys.length - 1].x, y: keys[keys.length - 1].y, width: data.width, height: data.height };
	let left = keys[0];
	let right = keys[keys.length - 1];
	for (let i = 0; i < keys.length - 1; i += 1) {
		if (keys[i].frame <= frame && frame <= keys[i + 1].frame) {
			left = keys[i];
			right = keys[i + 1];
			break;
		}
	}
	const t = (frame - left.frame) / Math.max(1, right.frame - left.frame);
	return {
		x: Math.round(left.x + (right.x - left.x) * t),
		y: Math.round(left.y + (right.y - left.y) * t),
		width: data.width,
		height: data.height,
	};
}

function setKeyframe(data, frame, rect) {
	const maxX = Math.max(0, data.source_width - data.width);
	const maxY = Math.max(0, data.source_height - data.height);
	const item = {
		frame: Math.round(clamp(frame, 0, data.frame_count - 1)),
		x: Math.round(clamp(rect.x, 0, maxX)),
		y: Math.round(clamp(rect.y, 0, maxY)),
	};
	const index = data.keyframes.findIndex((key) => key.frame === item.frame);
	if (index >= 0) data.keyframes[index] = item;
	else data.keyframes.push(item);
	data.keyframes.sort((a, b) => a.frame - b.frame);
}

function removeKeyframe(data, frame) {
	if (data.keyframes.length <= 1) return;
	data.keyframes = data.keyframes.filter((item) => item.frame !== frame);
}

function serializeData(data) {
	return JSON.stringify({
		version: 1,
		source_width: data.source_width,
		source_height: data.source_height,
		frame_count: data.frame_count,
		range_start: data.range_start,
		range_end: data.range_end,
		output_frame_count: data.output_frame_count,
		width: data.width,
		height: data.height,
		keyframes: data.keyframes,
		range_user_set: Boolean(data.range_user_set),
	});
}

function showExtraOutputs(node) {
	return node?.properties?.[EXTRA_OUTPUTS_PROPERTY] === true;
}

function setExtraOutputsVisible(node, visible) {
	node.properties = node.properties || {};
	node.properties[EXTRA_OUTPUTS_PROPERTY] = Boolean(visible);
}

function restoreExtraOutputState(node, serializedNode = null) {
	node.properties = node.properties || {};
	const serializedOutputs = Array.isArray(serializedNode?.outputs) ? serializedNode.outputs : [];
	const hasSerializedLinkedExtra = serializedOutputs.slice(1).some((output) => Array.isArray(output?.links) && output.links.some((link) => link != null));
	if (hasSerializedLinkedExtra) {
		node.properties[EXTRA_OUTPUTS_PROPERTY] = true;
		return;
	}
	const saved = serializedNode?.properties?.[EXTRA_OUTPUTS_PROPERTY] ?? node.properties[EXTRA_OUTPUTS_PROPERTY];
	if (saved === true || saved === false) {
		node.properties[EXTRA_OUTPUTS_PROPERTY] = saved === true;
		return;
	}
	const hasSerializedExtra = serializedOutputs.slice(1).some((output) => OUTPUT_DEFS.slice(1).some((def) => output?.name === def.name));
	node.properties[EXTRA_OUTPUTS_PROPERTY] = hasSerializedExtra;
}

function applyOutputMeta(node, { fromUser = false } = {}) {
	if (!Array.isArray(node?.outputs)) return;
	if (!showExtraOutputs(node) && !fromUser && node.outputs.slice(1).some((output) => Array.isArray(output?.links) && output.links.some((link) => link != null))) {
		setExtraOutputsVisible(node, true);
	}
	const target = showExtraOutputs(node) ? OUTPUT_DEFS : [OUTPUT_DEFS[0]];
	for (let index = node.outputs.length - 1; index >= target.length; index -= 1) {
		try { node.disconnectOutput?.(index); } catch (_) {}
		if (typeof node.removeOutput === "function") {
			node.removeOutput(index);
		} else {
			node.outputs.splice(index, 1);
		}
	}
	while (node.outputs.length < target.length) {
		const def = target[node.outputs.length];
		const previousLength = node.outputs.length;
		if (typeof node.addOutput === "function") {
			node.addOutput(def.name, def.type);
		}
		if (node.outputs.length === previousLength) {
			node.outputs.push({ name: def.name, type: def.type, links: [] });
		}
	}
	target.forEach((def, index) => {
		const output = node.outputs[index];
		if (!output) return;
		output.name = def.name;
		output.label = def.name;
		output.localized_name = def.name;
		output.type = def.type;
		output.tooltip = def.tooltip;
	});
}

function setDirty(node) {
	globalThis.GJJApplyTypeColorsToNode?.(node);
	try { node?.graph?.change?.(); } catch (_) {}
	try { app.graph?.change?.(); } catch (_) {}
	if (node?.graph) {
		node.graph._version = Number(node.graph._version || 0) + 1;
	}
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function linkValue(link, key) {
	if (!Array.isArray(link)) return link?.[key];
	const indexes = { id: 0, origin_id: 1, origin_slot: 2, target_id: 3, target_slot: 4, type: 5 };
	return link[indexes[key]];
}

function getGraphLink(graph, linkId) {
	const links = graph?.links || app.graph?.links;
	if (!links || linkId == null) return null;
	if (typeof links.get === "function") return links.get(linkId) || links.get(Number(linkId)) || links.get(String(linkId)) || null;
	if (links[linkId]) return links[linkId];
	if (links[String(linkId)]) return links[String(linkId)];
	if (Array.isArray(links)) return links.find((link) => String(linkValue(link, "id")) === String(linkId)) || null;
	return null;
}

function getGraphNodeById(graph, id) {
	if (id == null) return null;
	const numberId = Number(id);
	return graph?.getNodeById?.(Number.isFinite(numberId) ? numberId : id)
		|| graph?._nodes_by_id?.[id]
		|| graph?._nodes_by_id?.[String(id)]
		|| (graph?._nodes || []).find((node) => String(node?.id) === String(id))
		|| null;
}

function collectUpstreamNodeIds(node) {
	const graph = node?.graph || app.graph;
	const keep = new Set();
	const visit = (current) => {
		if (!Array.isArray(current?.inputs)) return;
		for (const input of current.inputs) {
			const link = getGraphLink(graph, input?.link);
			const originId = linkValue(link, "origin_id");
			if (originId == null) continue;
			const key = String(originId);
			if (keep.has(key)) continue;
			keep.add(key);
			const originNode = getGraphNodeById(graph, originId);
			if (originNode) visit(originNode);
		}
	};
	visit(node);
	return keep;
}

function isExecutionOutputNode(node) {
	return Boolean(node?.constructor?.nodeData?.output_node || node?.nodeData?.output_node || node?.flags?.output || TARGET_NODES.has(node?.comfyClass));
}

async function queueOnlyCurrentNode(node) {
	if (!node || !node.graph) return false;
	const graph = node.graph || app.graph;
	const allNodes = graph?._nodes || app.graph?._nodes || [];
	const upstreamNodeIds = collectUpstreamNodeIds(node);
	const savedModes = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;
	try {
		for (const item of allNodes) {
			if (!item || item === node) continue;
			if (upstreamNodeIds.has(String(item.id))) continue;
			if (isExecutionOutputNode(item)) {
				savedModes.push([item, item.mode]);
				item.mode = 2;
			}
		}
		if (app.canvas) {
			app.canvas.selected_nodes = {};
			app.canvas.selected_nodes[node.id] = node;
			app.canvas.selected_node = node;
		}
		syncNodeWidgetValues(node);
		setDirty(node);
		if (typeof app.queuePrompt === "function") {
			await app.queuePrompt(0, 1);
			return true;
		}
		return false;
	} finally {
		for (const [item, mode] of savedModes) item.mode = mode;
		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}
		setDirty(node);
	}
}

function ensureState(node) {
	const state = ensureWidget(node);
	state.selectedVideo = state.selectedVideo || parseSelectedVideo(selectedVideoFromNode(node));
	return state;
}

function syncSelectedVideo(node, item) {
	const value = item?.filename ? JSON.stringify(item) : "";
	node.properties ||= {};
	node.properties[SELECTED_VIDEO_PROPERTY] = value;
	setWidgetValue(node, SELECTED_VIDEO_WIDGET, value);
	const state = ensureState(node);
	state.selectedVideo = item?.filename ? item : null;
	state.statusText = "";
	if (item?.width && item?.height) {
		state.data = normalizeData(state.data, item.width, item.height, item.frames || state.data.frame_count || 1);
		setWidgetValue(node, CROP_WIDGET, serializeData(state.data));
	}
	syncNodeWidgetValues(node);
	syncVideoBackground(node, state);
	renderControls(node);
	drawState(node, state);
	setDirty(node);
}

async function refreshPreview(node) {
	const state = ensureState(node);
	if (state.uploading || state.refreshing) return false;
	const selected = state.selectedVideo || parseSelectedVideo(selectedVideoFromNode(node));
	if (!hasInputLink(node, MEDIA_INPUT) && !selected) {
		state.statusText = "请先点击 📁 打开视频，或连接上游图片/视频帧。";
		renderControls(node);
		return false;
	}
	state.refreshing = true;
	state.statusText = "正在更新预览...";
	renderControls(node);
	try {
		syncPreviewFrameWidget(node, state);
		const ok = await queueOnlyCurrentNode(node);
		if (!ok) throw new Error("预览队列启动失败");
		return true;
	} catch (error) {
		state.refreshing = false;
		state.statusText = error?.message || "预览更新失败";
		renderControls(node);
		return false;
	}
}

async function uploadVideo(node, file) {
	const state = ensureState(node);
	clearNativePreview(node);
	state.uploading = true;
	state.refreshing = false;
	state.statusText = "";
	renderControls(node);
	try {
		const formData = new FormData();
		formData.append("video", file, file.name || "video.mp4");
		const response = await fetch(api.apiURL(UPLOAD_API), { method: "POST", body: formData });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data?.ok === false) throw new Error(data?.error || `上传失败：HTTP ${response.status}`);
		const item = await fetchMeta(data.video || {});
		syncSelectedVideo(node, item);
		state.uploading = false;
		renderControls(node);
		await refreshPreview(node);
	} catch (error) {
		state.statusText = error?.message || "视频打开失败";
		renderControls(node);
	} finally {
		state.uploading = false;
		renderControls(node);
	}
}

function renderControls(node) {
	const state = node.__gjjVisualRegionCrop;
	if (!state) return;
	const external = hasInputLink(node, MEDIA_INPUT);
	const selected = state.selectedVideo || parseSelectedVideo(selectedVideoFromNode(node));
	state.selectedVideo = selected;
	if (state.browseButton) {
		state.browseButton.disabled = state.uploading || state.refreshing;
		state.browseButton.textContent = state.uploading ? "..." : "📁";
		state.browseButton.title = external
			? "打开视频：已连接上游时仍优先使用上游。"
			: "打开视频：选择本地视频并写入本节点内部源。";
	}
	if (state.refreshButton) {
		const canRefresh = !state.uploading && !state.refreshing && (external || selected);
		state.refreshButton.disabled = !canRefresh;
		state.refreshButton.textContent = state.refreshing ? "..." : "🔄";
		state.refreshButton.title = canRefresh
			? "更新预览：只执行当前节点和上游，刷新源图底图。"
			: "请先打开视频，或连接上游图片/视频帧。";
	}
	const upstreamVideo = state.upstreamVideo?.filename ? state.upstreamVideo : null;
	const base = external
		? upstreamVideo
			? `上游视频 ${videoLabel(upstreamVideo)}${formatMeta(upstreamVideo) ? ` / ${formatMeta(upstreamVideo)}` : ""}`
			: "上游优先"
		: selected
			? `${videoLabel(selected)}${formatMeta(selected) ? ` / ${formatMeta(selected)}` : ""}`
			: "点击 📁 打开视频，或连接上游";
	state.sourceText = state.statusText || base;
}

function ensureWidget(node) {
	if (node.__gjjVisualRegionCrop) return node.__gjjVisualRegionCrop;

	const wrap = document.createElement("div");
	wrap.className = "gjj-visual-crop";
	wrap.style.cssText = [
		"width:100%",
		"box-sizing:border-box",
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"padding:0",
		"font:12px/1.3 ui-sans-serif,system-ui,sans-serif",
		"color:#d5e3e0",
	].join(";");

	const style = document.createElement("style");
	style.textContent = `
		.gjj-visual-crop canvas { display:block; max-width:100%; height:auto; border:1px solid #30464f; border-radius:8px; background:#06090c; cursor:crosshair; box-sizing:border-box; }
		.gjj-visual-crop-toolbar { display:flex; flex-wrap:wrap; gap:5px; align-items:center; min-width:0; width:100%; }
		.gjj-visual-crop-toolbar .frame-label { flex:0 0 auto; }
		.gjj-visual-crop-toolbar input[type="number"] { width:58px; height:24px; box-sizing:border-box; border:1px solid #33464e; border-radius:6px; background:#20282d; color:#ecf4f2; padding:1px 4px; }
		.gjj-visual-crop-slider-row { position:relative; display:flex; align-items:center; width:100%; min-width:0; height:24px; box-sizing:border-box; }
		.gjj-visual-crop-slider-row input[type="range"] { width:100%; min-width:0; flex:1 1 auto; margin:0; }
		.gjj-visual-crop-slider-marks { position:absolute; left:7px; right:7px; top:0; bottom:0; pointer-events:none; }
		.gjj-visual-crop-slider-mark { position:absolute; top:4px; width:7px; height:16px; transform:translateX(-50%); border-radius:4px; background:#5ee6a8; border:1px solid #143a2b; box-shadow:0 0 0 1px rgba(255,255,255,.28); pointer-events:auto; cursor:pointer; box-sizing:border-box; }
		.gjj-visual-crop-slider-mark:hover { background:#e8fff5; }
		.gjj-visual-crop-range-mark { position:absolute; top:1px; width:5px; height:22px; transform:translateX(-50%); border-radius:3px; background:#ffd166; box-shadow:0 0 0 1px rgba(0,0,0,.55); box-sizing:border-box; }
		.gjj-visual-crop-range-mark.range-end { background:#ef476f; }
		.gjj-visual-crop button { height:24px; padding:0 7px; border:1px solid #40545d; border-radius:6px; background:#202b31; color:#e2ece9; cursor:pointer; white-space:nowrap; }
		.gjj-visual-crop button:hover { background:#2b3a41; }
		.gjj-visual-crop button:disabled { opacity:.55; cursor:default; }
		.gjj-visual-crop button.on { background:#1f6b43; border-color:#48ad73; color:#fff; }
		.gjj-visual-crop-info { color:#9fb2b9; white-space:pre-wrap; overflow:hidden; text-overflow:ellipsis; }
	`;

	const canvas = document.createElement("canvas");
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-visual-crop-toolbar";
	const sliderRow = document.createElement("div");
	sliderRow.className = "gjj-visual-crop-slider-row";
	const frameLabel = document.createElement("span");
	frameLabel.className = "frame-label";
	frameLabel.textContent = "帧";
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = "1";
	slider.max = "1";
	slider.value = "1";
	slider.title = "拖动预览帧；双击添加关键帧；右键删除关键帧";
	const sliderMarks = document.createElement("div");
	sliderMarks.className = "gjj-visual-crop-slider-marks";
	const frameInput = document.createElement("input");
	frameInput.type = "number";
	frameInput.min = "1";
	frameInput.value = "1";
	const keyButton = document.createElement("button");
	keyButton.type = "button";
	keyButton.textContent = "🔑";
	keyButton.title = "将当前裁切框保存为当前帧关键帧";
	const deleteButton = document.createElement("button");
	deleteButton.type = "button";
	deleteButton.textContent = "删除";
	deleteButton.title = "删除当前帧关键帧，至少保留一个";
	const startButton = document.createElement("button");
	startButton.type = "button";
	startButton.textContent = "⏮";
	startButton.title = "将当前帧设为最终输出起始帧；起始帧不锁定。";
	const endButton = document.createElement("button");
	endButton.type = "button";
	endButton.textContent = "⏭";
	endButton.title = "将当前帧设为最终输出结束帧；尾帧按 8n+1 锁定。";
	const centerButton = document.createElement("button");
	centerButton.type = "button";
	centerButton.textContent = "居中";
	centerButton.title = "把当前帧裁切框移到画面中心";
	const outputButton = document.createElement("button");
	outputButton.type = "button";
	outputButton.textContent = "🔌";
	outputButton.title = "显示 / 收起宽度、高度、帧数和关键帧 JSON 输出口";
	const browseButton = document.createElement("button");
	browseButton.type = "button";
	browseButton.textContent = "📁";
	browseButton.title = "打开视频";
	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.textContent = "🔄";
	refreshButton.title = "更新预览";
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "video/*,.mp4,.mov,.m4v,.webm,.avi,.mkv,.wmv,.flv,.mpeg,.mpg,.gif";
	fileInput.style.display = "none";
	sliderRow.append(slider, sliderMarks);
	toolbar.append(browseButton, refreshButton, frameLabel, frameInput, startButton, endButton, keyButton, deleteButton, centerButton, outputButton);

	const info = document.createElement("div");
	info.className = "gjj-visual-crop-info";
	info.textContent = "执行节点后显示源媒体预览；拖动框体移动，拖动四角控制点调整宽高，最小 256。";

	wrap.append(style, canvas, sliderRow, toolbar, info, fileInput);
	for (const el of [wrap, canvas, sliderRow, toolbar, slider, sliderMarks, frameInput, startButton, endButton, keyButton, deleteButton, centerButton, browseButton, refreshButton, outputButton, fileInput]) {
		for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
			el.addEventListener(eventName, (event) => event.stopPropagation());
		}
	}

	const state = {
		wrap,
		canvas,
		ctx: canvas.getContext("2d"),
		slider,
		sliderMarks,
		frameInput,
		startButton,
		endButton,
		keyButton,
		deleteButton,
		centerButton,
		browseButton,
		refreshButton,
		outputButton,
		fileInput,
		info,
		image: new Image(),
		imageLoaded: false,
		video: document.createElement("video"),
		videoReady: false,
		videoBackgroundUrl: "",
		videoItem: null,
		upstreamVideo: null,
		data: normalizeData(parseJson(widgetValue(node, CROP_WIDGET, ""))),
		frame: 0,
		drag: null,
		previewFrameTimer: null,
		widget: null,
		selectedVideo: parseSelectedVideo(selectedVideoFromNode(node)),
		uploading: false,
		refreshing: false,
		statusText: "",
		sourceText: "",
	};

	const draw = () => drawState(node, state);
	state.video.addEventListener("loadedmetadata", () => {
		state.videoReady = true;
		syncVideoFrame(state);
		draw();
	});
	state.video.addEventListener("loadeddata", () => {
		state.videoReady = true;
		draw();
	});
	state.video.addEventListener("seeked", draw);
	state.video.addEventListener("error", () => {
		state.videoReady = false;
		draw();
	});
	state.image.onload = () => {
		state.imageLoaded = true;
		draw();
	};

	const commit = () => {
		state.data = normalizeData(state.data);
		setWidgetValue(node, CROP_WIDGET, serializeData(state.data));
		syncPreviewFrameWidget(node, state);
		draw();
		GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 360 });
	};

	const setFrame = (value) => {
		state.frame = Math.round(clamp(Number(value) - 1, 0, state.data.frame_count - 1));
		state.slider.value = String(state.frame + 1);
		state.frameInput.value = String(state.frame + 1);
		syncPreviewFrameWidget(node, state);
		syncVideoFrame(state);
		draw();
	};

	slider.addEventListener("input", () => setFrame(slider.value));
	slider.addEventListener("change", () => scheduleExternalPreviewRefresh(node));
	slider.addEventListener("dblclick", (event) => {
		event.preventDefault();
		const frame = frameFromSliderEvent(state, event);
		setFrame(frame + 1);
		setKeyframe(state.data, state.frame, interpolatedRect(state.data, state.frame));
		commit();
		scheduleExternalPreviewRefresh(node, 0);
	});
	slider.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		const frame = frameFromSliderEvent(state, event);
		setFrame(frame + 1);
		removeKeyframe(state.data, state.frame);
		commit();
		scheduleExternalPreviewRefresh(node, 0);
	});
	sliderMarks.addEventListener("pointerdown", (event) => {
		const mark = event.target?.closest?.(".gjj-visual-crop-slider-mark");
		if (!mark) return;
		event.preventDefault();
		event.stopPropagation();
		setFrame(Number(mark.dataset.frame || 0) + 1);
		scheduleExternalPreviewRefresh(node, 0);
	});
	sliderMarks.addEventListener("contextmenu", (event) => {
		const mark = event.target?.closest?.(".gjj-visual-crop-slider-mark");
		if (!mark) return;
		event.preventDefault();
		event.stopPropagation();
		setFrame(Number(mark.dataset.frame || 0) + 1);
		removeKeyframe(state.data, state.frame);
		commit();
		scheduleExternalPreviewRefresh(node, 0);
	});
	frameInput.addEventListener("change", () => {
		setFrame(frameInput.value);
		scheduleExternalPreviewRefresh(node, 0);
	});
	startButton.addEventListener("click", () => {
		setRangeStart(state.data, state.frame);
		commit();
	});
	endButton.addEventListener("click", () => {
		setRangeEnd(state.data, state.frame);
		commit();
	});
	keyButton.addEventListener("click", () => {
		setKeyframe(state.data, state.frame, interpolatedRect(state.data, state.frame));
		commit();
	});
	deleteButton.addEventListener("click", () => {
		removeKeyframe(state.data, state.frame);
		commit();
	});
	centerButton.addEventListener("click", () => {
		setKeyframe(state.data, state.frame, {
			x: Math.round((state.data.source_width - state.data.width) / 2),
			y: Math.round((state.data.source_height - state.data.height) / 2),
		});
		commit();
	});
	outputButton.addEventListener("click", () => {
		setExtraOutputsVisible(node, !showExtraOutputs(node));
		applyOutputMeta(node, { fromUser: true });
		outputButton.classList.toggle("on", showExtraOutputs(node));
		setDirty(node);
	});
	browseButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		fileInput.click();
	});
	refreshButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		await refreshPreview(node);
	});
	fileInput.addEventListener("change", async (event) => {
		event.stopPropagation();
		const file = Array.from(event.target?.files || [])[0];
		fileInput.value = "";
		if (file) await uploadVideo(node, file);
	});

	canvas.addEventListener("pointerdown", (event) => {
		const hit = hitTest(state, event);
		if (!hit) return;
		event.preventDefault();
		try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
		const rect = interpolatedRect(state.data, state.frame);
		setKeyframe(state.data, state.frame, rect);
		state.drag = {
			mode: hit,
			start: pointerSourcePoint(state, event),
			rect: { ...rect },
		};
	});
	canvas.addEventListener("pointermove", (event) => {
		if (!state.drag) {
			const hit = hitTest(state, event);
			canvas.style.cursor = hit === "move" ? "grab" : hit ? `${hit}-resize` : "crosshair";
			return;
		}
		event.preventDefault();
		const current = pointerSourcePoint(state, event);
		const dx = current.x - state.drag.start.x;
		const dy = current.y - state.drag.start.y;
		applyDrag(state, dx, dy);
		commit();
	});
	canvas.addEventListener("pointerup", (event) => {
		state.drag = null;
		try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
	});
	canvas.addEventListener("pointerleave", () => {
		if (!state.drag) canvas.style.cursor = "crosshair";
	});

	state.widget = node.addDOMWidget?.(WIDGET_NAME, "HTML", wrap, {
		hideOnZoom: false,
		serialize: false,
		getHeight: () => computeHeight(state),
	});
	if (state.widget) {
		state.widget.computeSize = (width) => [Math.max(220, Number(width || node.size?.[0] || 260)), computeHeight(state)];
	}

	node.__gjjVisualRegionCrop = state;
	outputButton.classList.toggle("on", showExtraOutputs(node));
	syncPreviewFrameWidget(node, state);
	syncVideoBackground(node, state);
	renderControls(node);
	return state;
}

function displayWidth(node, state) {
	const available = Math.max(120, Number(node?.size?.[0] || state?.wrap?.clientWidth || 260) - 18);
	return Math.round(available);
}

function displayScale(node, state) {
	return displayWidth(node, state) / Math.max(1, state.data.source_width);
}

function computeHeight(state) {
	const aspect = state.data.source_width > 0 && state.data.source_height > 0
		? state.data.source_height / state.data.source_width
		: 9 / 16;
	const width = Math.max(120, Number(state.canvas?.clientWidth || state.canvas?.width || 260));
	return Math.round(Math.max(220, width * aspect + 96));
}

function drawState(node, state) {
	state.data = normalizeData(state.data);
	syncVideoFrame(state);
	const cssW = displayWidth(node, state);
	const scale = cssW / Math.max(1, state.data.source_width);
	const cssH = Math.round(state.data.source_height * scale);
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	state.canvas.style.width = `${cssW}px`;
	state.canvas.style.height = `${cssH}px`;
	state.canvas.width = Math.round(cssW * dpr);
	state.canvas.height = Math.round(cssH * dpr);
	const ctx = state.ctx;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, cssW, cssH);

	let drewBackground = false;
	if (state.videoReady && state.video?.readyState >= 2) {
		try {
			ctx.drawImage(state.video, 0, 0, cssW, cssH);
			drewBackground = true;
		} catch (_) {
			state.videoReady = false;
		}
	}
	if (!drewBackground && state.imageLoaded) {
		ctx.drawImage(state.image, 0, 0, cssW, cssH);
		drewBackground = true;
	}
	if (!drewBackground) {
		ctx.fillStyle = "#06090c";
		ctx.fillRect(0, 0, cssW, cssH);
		ctx.fillStyle = "#8da0a7";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.font = "12px sans-serif";
		ctx.fillText("执行后显示预览", cssW / 2, cssH / 2);
	}

	const rect = interpolatedRect(state.data, state.frame);
	const x = rect.x * scale;
	const y = rect.y * scale;
	const w = rect.width * scale;
	const h = rect.height * scale;
	ctx.save();
	ctx.fillStyle = "rgba(0,0,0,.18)";
	ctx.fillRect(0, 0, cssW, Math.max(0, y));
	ctx.fillRect(0, y + h, cssW, Math.max(0, cssH - y - h));
	ctx.fillRect(0, y, Math.max(0, x), h);
	ctx.fillRect(x + w, y, Math.max(0, cssW - x - w), h);
	ctx.fillStyle = "rgba(94,230,168,.18)";
	ctx.fillRect(x, y, w, h);
	ctx.strokeStyle = "#5ee6a8";
	ctx.lineWidth = 2;
	ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
	for (const point of handlePoints(x, y, w, h)) {
		ctx.fillStyle = "#e8fff5";
		ctx.strokeStyle = "#143a2b";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	}
	ctx.restore();

	state.slider.max = String(state.data.frame_count);
	state.frameInput.max = String(state.data.frame_count);
	state.slider.value = String(state.frame + 1);
	state.frameInput.value = String(state.frame + 1);
	renderKeyframeMarks(state);
	const hasKey = Boolean(keyframeAt(state.data, state.frame));
	const rangeStart = Math.round(clamp(state.data.range_start ?? 0, 0, state.data.frame_count - 1));
	const rangeEnd = Math.round(clamp(state.data.range_end ?? state.data.frame_count - 1, 0, state.data.frame_count - 1));
	const outputFrames = Math.max(1, rangeEnd - rangeStart + 1);
	state.startButton?.classList.toggle("on", state.frame === rangeStart);
	state.endButton?.classList.toggle("on", state.frame === rangeEnd);
	const sourceText = state.sourceText ? `${state.sourceText}\n` : "";
	state.info.textContent = `${sourceText}源 ${state.data.source_width}x${state.data.source_height} / 裁切 ${state.data.width}x${state.data.height} / 范围 ${rangeStart + 1}-${rangeEnd + 1} / 输出 ${outputFrames} 帧 / 预览 ${state.frame + 1}/${state.data.frame_count} / 关键帧 ${state.data.keyframes.length}${hasKey ? " / 当前帧已标记" : ""}`;
}

function handlePoints(x, y, w, h) {
	return [
		{ name: "nw", x, y },
		{ name: "n", x: x + w / 2, y },
		{ name: "ne", x: x + w, y },
		{ name: "e", x: x + w, y: y + h / 2 },
		{ name: "se", x: x + w, y: y + h },
		{ name: "s", x: x + w / 2, y: y + h },
		{ name: "sw", x, y: y + h },
		{ name: "w", x, y: y + h / 2 },
	];
}

function canvasPoint(state, event) {
	const rect = state.canvas.getBoundingClientRect();
	return {
		x: event.clientX - rect.left,
		y: event.clientY - rect.top,
	};
}

function pointerSourcePoint(state, event) {
	const p = canvasPoint(state, event);
	const scale = state.canvas.clientWidth / Math.max(1, state.data.source_width);
	return {
		x: Math.round(p.x / scale),
		y: Math.round(p.y / scale),
	};
}

function hitTest(state, event) {
	const scale = state.canvas.clientWidth / Math.max(1, state.data.source_width);
	const p = canvasPoint(state, event);
	const rect = interpolatedRect(state.data, state.frame);
	const x = rect.x * scale;
	const y = rect.y * scale;
	const w = rect.width * scale;
	const h = rect.height * scale;
	for (const point of handlePoints(x, y, w, h)) {
		if (Math.hypot(p.x - point.x, p.y - point.y) <= 20) return point.name;
	}
	const edge = 16;
	const insideY = p.y >= y - edge && p.y <= y + h + edge;
	const insideX = p.x >= x - edge && p.x <= x + w + edge;
	if (insideY && Math.abs(p.x - x) <= edge) return "w";
	if (insideY && Math.abs(p.x - (x + w)) <= edge) return "e";
	if (insideX && Math.abs(p.y - y) <= edge) return "n";
	if (insideX && Math.abs(p.y - (y + h)) <= edge) return "s";
	if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return "move";
	return null;
}

function applyDrag(state, dx, dy) {
	const data = state.data;
	const start = state.drag.rect;
	let x = start.x;
	let y = start.y;
	let right = start.x + start.width;
	let bottom = start.y + start.height;
	const minW = minCropSize(data.source_width);
	const minH = minCropSize(data.source_height);
	if (state.drag.mode === "move") {
		x = clamp(start.x + dx, 0, data.source_width - start.width);
		y = clamp(start.y + dy, 0, data.source_height - start.height);
	} else {
		if (state.drag.mode.includes("w")) x = clamp(start.x + dx, 0, right - minW);
		if (state.drag.mode.includes("e")) right = clamp(right + dx, x + minW, data.source_width);
		if (state.drag.mode.includes("n")) y = clamp(start.y + dy, 0, bottom - minH);
		if (state.drag.mode.includes("s")) bottom = clamp(bottom + dy, y + minH, data.source_height);
		data.width = alignDown(right - x, data.source_width);
		data.height = alignDown(bottom - y, data.source_height);
		if (state.drag.mode.includes("w")) x = right - data.width;
		if (state.drag.mode.includes("n")) y = bottom - data.height;
		x = clamp(x, 0, data.source_width - data.width);
		y = clamp(y, 0, data.source_height - data.height);
	}
	setKeyframe(data, state.frame, { x, y });
}

function applyExecutedMessage(node, message) {
	clearNativePreview(node);
	const state = ensureWidget(node);
	state.refreshing = false;
	state.uploading = false;
	state.statusText = "";
	const item = Array.isArray(message?.preview_image) ? message.preview_image[0] : null;
	const sourceVideo = Array.isArray(message?.source_video) ? message.source_video[0] : null;
	const backendData = Array.isArray(message?.crop_data) ? parseJson(message.crop_data[0], null) : null;
	const sourceW = Number(message?.source_width?.[0] || item?.width || backendData?.source_width || 0);
	const sourceH = Number(message?.source_height?.[0] || item?.height || backendData?.source_height || 0);
	const frames = Number(message?.frame_count?.[0] || backendData?.frame_count || 1);
	const previewFrame = Number(message?.preview_frame?.[0]);
	const saved = parseJson(widgetValue(node, CROP_WIDGET, ""), {});
	state.data = normalizeData(backendData || saved, sourceW, sourceH, frames);
	state.frame = clamp(Number.isFinite(previewFrame) ? previewFrame : state.frame, 0, state.data.frame_count - 1);
	state.upstreamVideo = sourceVideo?.filename ? sourceVideo : null;
	setWidgetValue(node, CROP_WIDGET, serializeData(state.data));
	syncPreviewFrameWidget(node, state);
	syncVideoBackground(node, state);
	const url = buildViewUrl(item, "temp");
	if (url) {
		state.imageLoaded = false;
		state.image.src = url;
	}
	drawState(node, state);
	renderControls(node);
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 220 });
}

function stabilize(node) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	clearNativePreview(node);
	hideWidget(node, PREVIEW_WIDTH_WIDGET);
	hideWidget(node, CROP_WIDGET);
	hideWidget(node, SELECTED_VIDEO_WIDGET);
	hideWidget(node, PREVIEW_FRAME_WIDGET);
	const storedVideo = node.properties?.[SELECTED_VIDEO_PROPERTY] || "";
	const widgetVideo = widgetValue(node, SELECTED_VIDEO_WIDGET, "");
	if (storedVideo && storedVideo !== widgetVideo) {
		setWidgetValue(node, SELECTED_VIDEO_WIDGET, storedVideo);
	} else if (widgetVideo && !storedVideo) {
		node.properties ||= {};
		node.properties[SELECTED_VIDEO_PROPERTY] = widgetVideo;
	}
	for (const input of node.inputs || []) {
		if (!inputMatchesName(input, MEDIA_INPUT)) continue;
		input.name = MEDIA_INPUT;
		input.label = "图片/视频帧";
		input.localized_name = input.label;
		input.type = MEDIA_INPUT_TYPE;
		input.tooltip = "可选。支持 GJJ_BATCH_IMAGE、IMAGE、VIDEO；连接后优先使用上游。";
	}
	const state = ensureWidget(node);
	state.selectedVideo = parseSelectedVideo(selectedVideoFromNode(node));
	if (!hasInputLink(node, MEDIA_INPUT)) state.upstreamVideo = null;
	const savedData = parseJson(widgetValue(node, CROP_WIDGET, ""), state.data || {});
	if (state.selectedVideo?.width && state.selectedVideo?.height) {
		state.data = normalizeData(savedData, state.selectedVideo.width, state.selectedVideo.height, state.selectedVideo.frames || state.data.frame_count || 1);
	} else {
		state.data = normalizeData(savedData);
	}
	setWidgetValue(node, CROP_WIDGET, serializeData(state.data));
	state.frame = clamp(widgetValue(node, PREVIEW_FRAME_WIDGET, state.frame), 0, state.data.frame_count - 1);
	syncPreviewFrameWidget(node, state);
	applyOutputMeta(node);
	state.outputButton?.classList.toggle("on", showExtraOutputs(node));
	syncVideoBackground(node, state);
	renderControls(node);
	drawState(node, state);
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 220 });
}

function schedule(node, delay = 0) {
	clearTimeout(node.__gjjVisualRegionCropTimer);
	node.__gjjVisualRegionCropTimer = setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.VisualRegionCrop",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;
		nodeData.output_preview = false;
		nodeType.prototype.hideOutputImages = true;
		if (Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}
		const originalAddCustomWidget = nodeType.prototype.addCustomWidget;
		nodeType.prototype.addCustomWidget = function (customWidget, ...args) {
			if (isNativePreviewWidget(this, customWidget)) {
				return hideNativeWidget(customWidget);
			}
			return typeof originalAddCustomWidget === "function"
				? originalAddCustomWidget.call(this, customWidget, ...args)
				: customWidget;
		};
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			scheduleNativePreviewClear(this);
			schedule(this, 0);
			schedule(this, 150);
			return result;
		};
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			scheduleNativePreviewClear(this);
			restoreExtraOutputState(this, serializedNode);
			schedule(this, 0);
			schedule(this, 180);
			return result;
		};
		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[EXTRA_OUTPUTS_PROPERTY] = showExtraOutputs(this);
			serializedNode.properties[SELECTED_VIDEO_PROPERTY] = widgetValue(this, SELECTED_VIDEO_WIDGET, "") || this.properties?.[SELECTED_VIDEO_PROPERTY] || "";
			return result;
		};
		nodeType.prototype.onDrawBackground = function (...args) {
			clearNativePreview(this);
			return undefined;
		};
		nodeType.prototype.onDrawForeground = function (...args) {
			clearNativePreview(this);
			return undefined;
		};
		nodeType.prototype.onExecuted = function (message, ...args) {
			clearNativePreview(this);
			applyExecutedMessage(this, message || {});
			clearExecutedPreviewPayload(message);
			scheduleNativePreviewClear(this);
			return undefined;
		};
	},
	nodeCreated(node) {
		if (TARGET_NODES.has(node?.comfyClass)) schedule(node, 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilize(node);
		}
	},
});

for (const eventName of ["execution_error", "execution_interrupted"]) {
	api.addEventListener(eventName, () => {
		for (const node of app.graph?._nodes || []) {
			if (!TARGET_NODES.has(node?.comfyClass)) continue;
			const state = node.__gjjVisualRegionCrop;
			if (!state) continue;
			state.uploading = false;
			state.refreshing = false;
			state.statusText = "预览更新已停止";
			renderControls(node);
			drawState(node, state);
		}
	});
}

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_NAME = "GJJ_VideoFrameScreenshot";
const PANEL_WIDGET = "gjj_video_frame_screenshot_panel";
const FRAME_WIDGET = "frame_indices";
const SOURCE_WIDGET = "source_media";
const MEDIA_INPUT_NAMES = new Set(["media", "视频/图像序列"]);
const DEFAULT_PREVIEW_ASPECT = 16 / 9;
const VIDEO_UPLOAD_API_PATH = "/gjj/video_frame_screenshot/upload";
const ANIMATED_MEDIA_RE = /\.(mp4|webm|mov|mkv|avi|m4v|wmv|flv|mpeg|mpg|gif|webp|apng)$/i;
const VIDEO_MEDIA_RE = /\.(mp4|webm|mov|mkv|avi|m4v|wmv|flv|mpeg|mpg)$/i;

function unwrapFirst(value) {
	let current = value;
	while (Array.isArray(current) && current.length === 1) current = current[0];
	return current;
}

function videoDataToUrl(previewVideo) {
	previewVideo = unwrapFirst(previewVideo);
	if (previewVideo && !Array.isArray(previewVideo) && typeof previewVideo === "object") {
		previewVideo = [previewVideo];
	}
	if (!Array.isArray(previewVideo) || !previewVideo.length) return null;
	const data = previewVideo[0];
	if (!data?.filename) return null;
	const type = data.type || "temp";
	const subfolder = data.subfolder || "";
	const stamp = data.mtime_ns || data.ts || Date.now();
	return `/view?filename=${encodeURIComponent(data.filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}&t=${encodeURIComponent(stamp)}`;
}

function parseFrames(text) {
	const raw = String(text || "").trim();
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		const source = Array.isArray(parsed)
			? parsed
			: Array.isArray(parsed?.frames)
				? parsed.frames
				: Array.isArray(parsed?.indices)
					? parsed.indices
					: [];
		return source.map((item) => Math.round(Number(item))).filter(Number.isFinite);
	} catch (_) {}

	const result = [];
	for (const part of raw.split(/[\s,;，；]+/).filter(Boolean)) {
		const match = part.match(/^(-?\d+)\s*[-~:：]\s*(-?\d+)$/);
		if (match) {
			const start = Number(match[1]);
			const end = Number(match[2]);
			const step = end >= start ? 1 : -1;
			for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
				result.push(value);
			}
			continue;
		}
		const value = Math.round(Number(part));
		if (Number.isFinite(value)) result.push(value);
	}
	return result;
}

function serializeFrames(frames) {
	return (frames || []).map((item) => Math.max(1, Math.round(Number(item) || 1))).join(", ");
}

function frameWidget(node) {
	return node?.widgets?.find((widget) => widget?.name === FRAME_WIDGET);
}

function sourceWidget(node) {
	return node?.widgets?.find((widget) => widget?.name === SOURCE_WIDGET);
}

function widgetIndex(node, widgetName) {
	return (node?.widgets || []).findIndex((widget) => widget?.name === widgetName);
}

function keepSerialized(widget) {
	if (!widget) return;
	widget.serialize = true;
	widget.options = { ...(widget.options || {}), serialize: true };
	widget.serializeValue = () => String(widget.value ?? "");
}

function setFrameWidgetValue(node, value) {
	const widget = frameWidget(node);
	if (!widget) return;
	widget.value = String(value || "");
	keepSerialized(widget);
	const index = widgetIndex(node, FRAME_WIDGET);
	if (index >= 0) {
		node.widgets_values ||= [];
		node.widgets_values[index] = widget.value;
	}
	try {
		widget.callback?.(widget.value);
	} catch (_) {}
}

function refresh(node) {
	try { node?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { node?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app.canvas?.setDirty?.(true, true); } catch (_) {}
}

function hideFrameWidget(node) {
	const widget = frameWidget(node);
	if (widget) {
		GJJ_Utils.hideWidget(widget);
		keepSerialized(widget);
	}
	const source = sourceWidget(node);
	if (source) {
		GJJ_Utils.hideWidget(source);
		keepSerialized(source);
	}
}

function hasMediaInputLink(node) {
	const input = (node?.inputs || []).find((slot) => MEDIA_INPUT_NAMES.has(slot?.name) || MEDIA_INPUT_NAMES.has(slot?.label));
	return input?.link != null;
}

function makeButton(text, title) {
	const button = document.createElement("button");
	button.textContent = text;
	button.title = title || "";
	button.style.cssText = [
		"background:#334047",
		"color:#e9f0f2",
		"border:1px solid #4c5b63",
		"border-radius:4px",
		"padding:4px 6px",
		"font-size:14px",
		"line-height:16px",
		"cursor:pointer",
		"min-width:28px",
		"text-align:center",
	].join(";");
	button.setAttribute("aria-label", title || text);
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	return button;
}

function clampFrame(frame, total) {
	const max = Math.max(1, Math.round(Number(total) || 1));
	return Math.max(1, Math.min(max, Math.round(Number(frame) || 1)));
}

function sourceNodeForMediaInput(node) {
	const graph = node?.graph || app.graph;
	const input = (node?.inputs || []).find((slot) => MEDIA_INPUT_NAMES.has(slot?.name) || MEDIA_INPUT_NAMES.has(slot?.label));
	const linkId = input?.link;
	if (linkId == null) return null;
	const link = graph?.links?.[linkId] || app.graph?.links?.[linkId];
	if (!link || link.origin_id == null) return null;
	return graph?.getNodeById?.(link.origin_id) || (graph?._nodes || []).find((item) => String(item?.id) === String(link.origin_id)) || null;
}

function collectUpstreamNodeIds(node) {
	const graph = node?.graph || app.graph;
	const keep = new Set();
	const visit = (n) => {
		if (!n?.inputs || keep.has(String(n.id))) return;
		for (const input of n.inputs) {
			const linkId = input?.link;
			if (linkId == null) continue;
			const link = graph?.links?.[linkId] || app.graph?.links?.[linkId];
			if (!link || link.origin_id == null) continue;
			const originId = String(link.origin_id);
			keep.add(originId);
			const originNode = graph?.getNodeById?.(link.origin_id) || (graph?._nodes || []).find((item) => String(item?.id) === originId);
			if (originNode) visit(originNode);
		}
	};
	visit(node);
	return keep;
}

function isExecutionOutputNode(node) {
	return !!(node?.constructor?.nodeData?.output_node || node?.nodeData?.output_node || node?.flags?.output || node?.comfyClass === NODE_NAME);
}

async function queueOnlyCurrentNode(node) {
	if (!node || !node.graph) return false;
	const savedSource = parseSavedSource(node);
	if (!hasMediaInputLink(node) && !savedSource) return false;
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
		refresh(node);
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
		refresh(node);
	}
}

function setSourceWidgetValue(node, value) {
	const widget = sourceWidget(node);
	if (!widget) return;
	widget.value = typeof value === "string" ? value : JSON.stringify(value || {});
	keepSerialized(widget);
	const index = widgetIndex(node, SOURCE_WIDGET);
	if (index >= 0) {
		node.widgets_values ||= [];
		node.widgets_values[index] = widget.value;
	}
	try {
		widget.callback?.(widget.value);
	} catch (_) {}
	node.properties ||= {};
	node.properties[SOURCE_WIDGET] = widget.value;
}

function parseSavedSource(node) {
	const text = String(sourceWidget(node)?.value || node?.properties?.[SOURCE_WIDGET] || "").trim();
	if (!text) return null;
	try {
		const parsed = JSON.parse(text);
		if (parsed?.filename) return parsed;
	} catch (_) {}
	return null;
}

function restoreSerializedValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node?.properties || {};
	const source = String(props?.[SOURCE_WIDGET] || "").trim();
	if (source && sourceWidget(node) && !String(sourceWidget(node).value || "").trim()) {
		setSourceWidgetValue(node, source);
	}
	const frames = String(props?.[FRAME_WIDGET] || "").trim();
	if (frames && frameWidget(node) && !String(frameWidget(node).value || "").trim()) {
		setFrameWidgetValue(node, frames);
	}
}

function writeSerializedValues(node, serializedNode = null) {
	const source = String(sourceWidget(node)?.value || node?.properties?.[SOURCE_WIDGET] || "").trim();
	const frames = String(frameWidget(node)?.value || node?.properties?.[FRAME_WIDGET] || "").trim();
	node.properties ||= {};
	node.properties[SOURCE_WIDGET] = source;
	node.properties[FRAME_WIDGET] = frames;
	if (!serializedNode) return;
	serializedNode.properties ||= {};
	serializedNode.properties[SOURCE_WIDGET] = source;
	serializedNode.properties[FRAME_WIDGET] = frames;
	serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values) ? serializedNode.widgets_values : [];
	const sourceIndex = widgetIndex(node, SOURCE_WIDGET);
	if (sourceIndex >= 0) serializedNode.widgets_values[sourceIndex] = source;
	const frameIndex = widgetIndex(node, FRAME_WIDGET);
	if (frameIndex >= 0) serializedNode.widgets_values[frameIndex] = frames;
}

function inputMediaUrl(item) {
	if (!item?.filename) return "";
	const type = item.type || "input";
	const subfolder = item.subfolder || "";
	const stamp = item.mtime_ns || item.ts || Date.now();
	return `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}&t=${encodeURIComponent(stamp)}`;
}

async function uploadMediaFile(file) {
	const formData = new FormData();
	formData.append("media", file, file.name);
	const response = await fetch(api.apiURL(VIDEO_UPLOAD_API_PATH), { method: "POST", body: formData });
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(payload?.error || `上传失败：${file.name}`);
	const item = payload?.media?.[0];
	if (!item?.filename) throw new Error("上传后没有返回文件名。");
	return item;
}

function mediaSourceFromUpstream(node) {
	const source = sourceNodeForMediaInput(node);
	if (!source) return null;
	const widgets = source.widgets || [];
	for (const widget of widgets) {
		const value = widget?.value;
		if (typeof value === "string" && /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(value)) {
			const normalized = value.replaceAll("\\", "/");
			const parts = normalized.split("/");
			const filename = parts.pop() || normalized;
			const subfolder = parts.join("/");
			return {
				kind: "video",
				url: `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}&t=${Date.now()}`,
			};
		}
	}

	const candidates = [];
	if (source.__imageWidget?.element) candidates.push(source.__imageWidget.element);
	if (source.imgs) candidates.push(...source.imgs);
	if (source.image) candidates.push(source.image);
	const dom = source.__domWidget?.element || source.domElement || source.widgets?.find((w) => w?.element)?.element;
	if (dom?.querySelectorAll) candidates.push(...dom.querySelectorAll("video,img"));
	for (const widget of source.widgets || []) {
		if (widget?.element?.querySelectorAll) candidates.push(...widget.element.querySelectorAll("video,img"));
		if (widget?.element instanceof HTMLVideoElement || widget?.element instanceof HTMLImageElement) candidates.push(widget.element);
	}

	for (const item of candidates) {
		if (!item) continue;
		if (item instanceof HTMLVideoElement) {
			const url = item.currentSrc || item.src;
			if (url) {
				return {
					kind: "video",
					url,
					duration: Number.isFinite(item.duration) ? item.duration : 0,
					width: Number(item.videoWidth || 0),
					height: Number(item.videoHeight || 0),
				};
			}
		}
		if (item instanceof HTMLImageElement) {
			const url = item.currentSrc || item.src;
			if (url) {
				return {
					kind: "image",
					url,
					width: Number(item.naturalWidth || item.width || 0),
					height: Number(item.naturalHeight || item.height || 0),
				};
			}
		}
	}
	return null;
}

function buildPanel(node) {
	if (node.__gjjFrameScreenshotPanel) return node.__gjjFrameScreenshotPanel;

	const state = {
		frames: parseFrames(frameWidget(node)?.value || ""),
		total: 0,
		fps: 24,
		selectedThumb: -1,
		thumbVersion: 0,
		sourceKind: "",
		localObjectUrl: "",
		previewAspect: DEFAULT_PREVIEW_ASPECT,
		videoClickTimer: 0,
	};

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"padding:6px 8px",
		"box-sizing:border-box",
		"font-size:11px",
		"color:#d9e1e5",
	].join(";");

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "video/*,.mp4,.webm,.mov,.mkv,.avi,.m4v,.wmv,.flv,.mpeg,.mpg,.gif,.webp,.apng";
	fileInput.style.display = "none";
	wrap.appendChild(fileInput);

	const previewShell = document.createElement("div");
	previewShell.style.cssText = [
		"position:relative",
		"width:100%",
		"aspect-ratio:16/9",
		"background:transparent",
		"border:0",
		"border-radius:4px",
		"overflow:hidden",
		"display:none",
		"line-height:0",
	].join(";");

	const video = document.createElement("video");
	video.controls = true;
	video.controlsList = "nofullscreen";
	video.playsInline = true;
	video.preload = "metadata";
	video.style.cssText = "width:100%;height:auto;display:none;background:transparent;";

	const image = document.createElement("img");
	image.alt = "";
	image.style.cssText = "width:100%;height:auto;display:none;background:transparent;";
	previewShell.append(video, image);
	wrap.appendChild(previewShell);

	const scrub = document.createElement("input");
	scrub.type = "range";
	scrub.min = "1";
	scrub.max = "1";
	scrub.step = "1";
	scrub.value = "1";
	scrub.title = "拖动定位视频帧";
	scrub.style.cssText = "width:100%;height:18px;margin:0;accent-color:#f6a21a;display:none;";
	wrap.appendChild(scrub);

	const controls = document.createElement("div");
	controls.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
	const openBtn = makeButton("📁", "打开本地视频或图片作为面板预览");
	const refreshBtn = makeButton("🔄", "只刷新当前截图节点");
	const prevFrameBtn = makeButton("◀️", "向后微调 1 帧");
	const nextFrameBtn = makeButton("▶️", "向前微调 1 帧");
	const addCurrent = makeButton("📸", "把预览当前帧加入截图列表");
	const addStart = makeButton("⏮️", "添加第 1 帧");
	const addEnd = makeButton("⏭️", "添加最后 1 帧");
	const sortBtn = makeButton("🔢", "按帧号升序排列");
	const dedupeBtn = makeButton("🧹", "保留首次出现顺序并移除重复帧号");
	const clearBtn = makeButton("🗑️", "清空截图列表");
	controls.append(openBtn, refreshBtn, prevFrameBtn, nextFrameBtn, addCurrent, addStart, addEnd, sortBtn, dedupeBtn, clearBtn);
	wrap.appendChild(controls);

	const thumbs = document.createElement("div");
	thumbs.style.cssText = [
		"display:none",
		"gap:6px",
		"overflow-x:auto",
		"padding:2px 0 4px",
	].join(";");
	wrap.appendChild(thumbs);

	const status = document.createElement("div");
	status.style.cssText = "color:#8fa2aa;min-height:16px;";
	wrap.appendChild(status);

	for (const el of [video, image, scrub, thumbs, previewShell]) {
		for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "keydown"]) {
			el.addEventListener(eventName, (event) => {
				if (eventName === "dblclick") event.preventDefault();
				event.stopPropagation();
			});
		}
	}

	function mediaDuration(media = video) {
		return Number.isFinite(media?.duration) && media.duration > 0 ? media.duration : 0;
	}

	function frameToPreviewTime(frame, media = video) {
		const total = Math.max(1, Math.round(Number(state.total) || 1));
		const duration = mediaDuration(media);
		const safeFrame = clampFrame(frame, total);
		if (total <= 1 || duration <= 0) return 0;
		return Math.min(Math.max(0, duration - 0.001), Math.max(0, ((safeFrame - 1) / total) * duration));
	}

	function previewTimeToFrame(time, media = video) {
		const total = Math.max(1, Math.round(Number(state.total) || 1));
		const duration = mediaDuration(media);
		if (total <= 1 || duration <= 0) return clampFrame(scrub.value, total);
		const ratio = Math.max(0, Math.min(1, Number(time || 0) / duration));
		return clampFrame(Math.floor(ratio * total) + 1, total);
	}

	function currentFrame() {
		if (state.sourceKind === "image") return 1;
		return previewTimeToFrame(video.currentTime, video);
	}

	function syncVideoToScrub() {
		const frame = clampFrame(scrub.value, state.total);
		if (mediaDuration(video) > 0) {
			video.currentTime = frameToPreviewTime(frame, video);
		}
		updateStatus();
	}

	function syncScrubToVideo() {
		scrub.value = String(currentFrame());
		updateStatus();
	}

	function fitNode() {
		GJJ_Utils.scheduleRefreshNode?.(node, {
			preserveWidth: true,
			minWidth: 260,
			minHeight: 120,
			delay: 30,
		});
	}

	function hasPreviewSource() {
		return state.sourceKind === "video" || state.sourceKind === "image";
	}

	function commitFrames(frames) {
		if (!hasPreviewSource()) {
			state.frames = [];
			state.selectedThumb = -1;
			renderThumbs();
			updateStatus();
			fitNode();
			refresh(node);
			return;
		}
		const total = state.total || 1;
		state.frames = frames.map((item) => clampFrame(item, total));
		setFrameWidgetValue(node, serializeFrames(state.frames));
		renderThumbs();
		updateStatus();
		refresh(node);
	}

	function addFrame(frame) {
		if (!hasPreviewSource()) return;
		commitFrames([...state.frames, clampFrame(frame, state.total || 1)]);
	}

	function stepFrame(delta) {
		if (!hasPreviewSource() || state.sourceKind !== "video") return;
		const total = state.total || 1;
		video.pause?.();
		clearTimeout(state.videoClickTimer);
		const base = Number.isFinite(Number(scrub.value)) ? Number(scrub.value) : currentFrame();
		scrub.value = String(clampFrame(base + delta, total));
		syncVideoToScrub();
	}

	function updateStatus() {
		if (!hasPreviewSource()) {
			status.textContent = "等待预览";
			return;
		}
		const current = state.sourceKind ? `当前 ${currentFrame()}f` : "等待预览";
		const total = state.total ? ` / 总帧 ${state.total}` : "";
		status.textContent = `${current} · 已选 ${state.frames.length} 帧${total}`;
	}

	function setPreviewAspect(width, height) {
		const w = Number(width || 0);
		const h = Number(height || 0);
		const aspect = w > 0 && h > 0 ? w / h : DEFAULT_PREVIEW_ASPECT;
		state.previewAspect = Math.max(0.05, aspect);
		previewShell.style.aspectRatio = `${w > 0 ? w : 16} / ${h > 0 ? h : 9}`;
		refresh(node);
	}

	function previewHeight(width) {
		if (previewShell.style.display === "none") return 0;
		const measuredWidth = previewShell.clientWidth || Math.max(160, Number(width || node.size?.[0] || 320) - 32);
		return Math.max(1, Math.round(measuredWidth / (state.previewAspect || DEFAULT_PREVIEW_ASPECT)));
	}

	function drawThumbPlaceholder(canvas, frame) {
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#070a0c";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = "#8799a1";
		ctx.font = "18px sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(`${frame}f`, canvas.width / 2, canvas.height / 2);
	}

	function captureImageThumb(canvas) {
		const ctx = canvas.getContext("2d");
		if (!image.complete || !image.naturalWidth) return;
		ctx.fillStyle = "#050708";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		const ratio = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
		const width = image.naturalWidth * ratio;
		const height = image.naturalHeight * ratio;
		ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
	}

	function captureVideoThumb(canvas, frame, version) {
		const src = video.currentSrc || video.src;
		if (!src || !state.total) return;
		const thumbVideo = document.createElement("video");
		thumbVideo.muted = true;
		thumbVideo.playsInline = true;
		thumbVideo.preload = "auto";
		thumbVideo.src = src;
		const cleanup = () => {
			thumbVideo.removeAttribute("src");
			try { thumbVideo.load(); } catch (_) {}
		};
		thumbVideo.addEventListener("loadedmetadata", () => {
			try {
				thumbVideo.currentTime = frameToPreviewTime(frame, thumbVideo);
			} catch (_) {
				cleanup();
			}
		}, { once: true });
		thumbVideo.addEventListener("seeked", () => {
			if (version !== state.thumbVersion) {
				cleanup();
				return;
			}
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#050708";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			const ratio = Math.min(canvas.width / thumbVideo.videoWidth, canvas.height / thumbVideo.videoHeight);
			const width = thumbVideo.videoWidth * ratio;
			const height = thumbVideo.videoHeight * ratio;
			try {
				ctx.drawImage(thumbVideo, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
			} catch (_) {}
			cleanup();
		}, { once: true });
		thumbVideo.addEventListener("error", cleanup, { once: true });
	}

	function renderThumbs() {
		state.thumbVersion += 1;
		const version = state.thumbVersion;
		thumbs.replaceChildren();
		if (!hasPreviewSource() || !state.frames.length) {
			thumbs.style.display = "none";
			return;
		}
		thumbs.style.display = "flex";
		state.frames.forEach((frame, index) => {
			const item = document.createElement("div");
			item.title = "双击删除这张截图";
			item.style.cssText = [
				"position:relative",
				"flex:0 0 84px",
				"height:64px",
				"border:1px solid " + (index === state.selectedThumb ? "#58d5ff" : "#405058"),
				"background:#11191e",
				"border-radius:4px",
				"cursor:pointer",
				"box-sizing:border-box",
				"overflow:hidden",
			].join(";");
			const canvas = document.createElement("canvas");
			canvas.width = 160;
			canvas.height = 100;
			canvas.style.cssText = "width:100%;height:100%;display:block;background:#050708;";
			const badge = document.createElement("div");
			badge.textContent = `${index + 1}`;
			badge.style.cssText = "position:absolute;left:4px;top:3px;min-width:16px;height:16px;border-radius:8px;background:rgba(246,162,26,.92);color:#111;font-weight:700;font-size:11px;line-height:16px;text-align:center;";
			const label = document.createElement("div");
			label.textContent = `${frame}f`;
			label.style.cssText = "position:absolute;right:3px;bottom:3px;background:rgba(0,0,0,.62);color:#fff;border-radius:3px;padding:1px 4px;font-size:10px;";
			item.append(canvas, badge, label);
			drawThumbPlaceholder(canvas, frame);
			if (state.sourceKind === "image") captureImageThumb(canvas);
			else captureVideoThumb(canvas, frame, version);
			item.addEventListener("click", () => {
				state.selectedThumb = index;
				scrub.value = String(clampFrame(frame, state.total || 1));
				if (state.sourceKind === "video") syncVideoToScrub();
				renderThumbs();
			});
			item.addEventListener("dblclick", () => {
				const next = state.frames.slice();
				next.splice(index, 1);
				state.selectedThumb = -1;
				commitFrames(next);
			});
			thumbs.appendChild(item);
		});
	}

	function setPreviewSource(source) {
		const url = source?.url || "";
		if (!url) {
			clearTimeout(state.videoClickTimer);
			previewShell.style.display = "none";
			video.style.display = "none";
			image.style.display = "none";
			scrub.style.display = "none";
			thumbs.style.display = "none";
			video.pause?.();
			video.removeAttribute("src");
			image.removeAttribute("src");
			try { video.load?.(); } catch (_) {}
			state.total = 0;
			state.sourceKind = "";
			state.selectedThumb = -1;
			renderThumbs();
			updateStatus();
			fitNode();
			refresh(node);
			return;
		}

		previewShell.style.display = "block";
		state.sourceKind = source.kind || "video";
		if (state.sourceKind === "image") {
			video.pause();
			video.style.display = "none";
			video.removeAttribute("src");
			image.style.display = "block";
			if (image.src !== new URL(url, window.location.href).href) image.src = url;
			state.total = 1;
			setPreviewAspect(source.width, source.height);
			scrub.style.display = "none";
		} else {
			image.style.display = "none";
			image.removeAttribute("src");
			video.style.display = "block";
			if (video.src !== new URL(url, window.location.href).href) {
				video.src = url;
				video.load();
			}
			if (!state.total && source.duration && state.fps) state.total = Math.max(1, Math.round(source.duration * state.fps));
			setPreviewAspect(source.width, source.height);
			scrub.style.display = "";
			scrub.max = String(Math.max(1, state.total || 1));
		}
		renderThumbs();
		updateStatus();
		fitNode();
	}

	function applyUpstreamPreview() {
		const source = mediaSourceFromUpstream(node);
		if (!source) return false;
		setPreviewSource(source);
		return true;
	}

	function applySavedPreview() {
		const saved = parseSavedSource(node);
		if (!saved?.filename) return false;
		const filename = String(saved.filename || "");
		const kind = VIDEO_MEDIA_RE.test(filename) ? "video" : "image";
		setPreviewSource({
			...saved,
			kind,
			url: inputMediaUrl(saved),
		});
		return true;
	}

	function applyData(data = {}) {
		const total = Number(data.frame_count ?? data.preview_total_frames ?? state.total ?? 0);
		const fps = Number(data.preview_frame_rate ?? state.fps ?? 24);
		state.total = total > 0 ? Math.round(total) : state.total;
		state.fps = fps > 0 ? fps : state.fps;
		scrub.max = String(Math.max(1, state.total || 1));
		const videoUrl = videoDataToUrl(data.preview_video);
		if (videoUrl) setPreviewSource({ kind: "video", url: videoUrl });
		else if (!applyUpstreamPreview() && !applySavedPreview()) setPreviewSource(null);
		const selected = data.selected_frames ? parseFrames(data.selected_frames) : parseFrames(frameWidget(node)?.value || "");
		state.frames = selected.map((item) => clampFrame(item, state.total || 1));
		setFrameWidgetValue(node, serializeFrames(state.frames));
		renderThumbs();
		updateStatus();
		refresh(node);
	}

	openBtn.addEventListener("click", () => fileInput.click());
	fileInput.addEventListener("change", async () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		const oldText = openBtn.textContent;
		try {
			if (!ANIMATED_MEDIA_RE.test(file.name || "")) {
				throw new Error("请选择视频或动图格式：mp4/webm/mov/mkv/avi/gif/webp/apng。");
			}
			openBtn.textContent = "⏳";
			openBtn.disabled = true;
			if (state.localObjectUrl) URL.revokeObjectURL(state.localObjectUrl);
			state.localObjectUrl = "";
			const saved = await uploadMediaFile(file);
			setSourceWidgetValue(node, saved);
			state.frames = [];
			state.selectedThumb = -1;
			setFrameWidgetValue(node, "");
			const filename = String(saved.filename || file.name || "");
			setPreviewSource({
				...saved,
				kind: VIDEO_MEDIA_RE.test(filename) ? "video" : "image",
				url: inputMediaUrl(saved),
			});
			refresh(node);
		} catch (error) {
			status.textContent = error?.message || String(error || "打开视频失败");
		} finally {
			openBtn.textContent = oldText || "📁";
			openBtn.disabled = false;
			fileInput.value = "";
		}
	});
	refreshBtn.addEventListener("click", async () => {
		const text = refreshBtn.textContent;
		try {
			refreshBtn.textContent = "…";
			refreshBtn.disabled = true;
			await queueOnlyCurrentNode(node);
		} finally {
			setTimeout(() => {
				refreshBtn.textContent = text || "🔄";
				refreshBtn.disabled = false;
			}, 300);
		}
	});
	prevFrameBtn.addEventListener("click", () => stepFrame(-1));
	nextFrameBtn.addEventListener("click", () => stepFrame(1));
	addCurrent.addEventListener("click", () => addFrame(currentFrame()));
	addStart.addEventListener("click", () => addFrame(1));
	addEnd.addEventListener("click", () => addFrame(state.total || 1));
	sortBtn.addEventListener("click", () => commitFrames([...state.frames].sort((a, b) => a - b)));
	dedupeBtn.addEventListener("click", () => {
		const seen = new Set();
		const frames = [];
		for (const frame of state.frames) {
			const value = clampFrame(frame, state.total || 1);
			if (seen.has(value)) continue;
			seen.add(value);
			frames.push(value);
		}
		commitFrames(frames);
	});
	clearBtn.addEventListener("click", () => commitFrames([]));
	scrub.addEventListener("input", syncVideoToScrub);
	video.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (!hasPreviewSource()) return;
		clearTimeout(state.videoClickTimer);
		state.videoClickTimer = setTimeout(() => {
			if (video.paused || video.ended) {
				video.play?.()?.catch?.(() => {});
			} else {
				video.pause?.();
			}
		}, 180);
	});
	video.addEventListener("timeupdate", syncScrubToVideo);
	video.addEventListener("seeked", syncScrubToVideo);
	video.addEventListener("loadedmetadata", () => {
		setPreviewAspect(video.videoWidth, video.videoHeight);
		if (!state.total && Number.isFinite(video.duration) && video.duration > 0) {
			state.total = Math.max(1, Math.round(video.duration * (state.fps || 24)));
		}
		scrub.max = String(Math.max(1, state.total || 1));
		syncScrubToVideo();
	});
	video.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		clearTimeout(state.videoClickTimer);
		addFrame(currentFrame());
	});
	image.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		addFrame(1);
	});
	image.addEventListener("load", () => {
		state.total = 1;
		setPreviewAspect(image.naturalWidth, image.naturalHeight);
		renderThumbs();
		updateStatus();
	});

	const panel = { wrap, applyData, applyUpstreamPreview, applySavedPreview };
	node.__gjjFrameScreenshotPanel = panel;
	node.__gjjFrameScreenshotPanelWidget = node.addDOMWidget?.(PANEL_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => {
			const preview = previewHeight() + (previewShell.style.display === "none" ? 0 : 6);
			const thumb = thumbs.style.display === "none" ? 0 : 72;
			return preview + thumb + 78;
		},
		getMinHeight: () => {
			const preview = previewHeight() + (previewShell.style.display === "none" ? 0 : 6);
			const thumb = thumbs.style.display === "none" ? 0 : 72;
			return preview + thumb + 78;
		},
	});
	if (node.__gjjFrameScreenshotPanelWidget) {
		node.__gjjFrameScreenshotPanelWidget.computeSize = (width) => [
			Math.round(Number(width || node.size?.[0] || 320)),
			previewHeight(width) + (previewShell.style.display === "none" ? 0 : 6) + (thumbs.style.display === "none" ? 0 : 72) + 78,
		];
	}
	applyData({});
	return panel;
}

function applyNodeState(node) {
	restoreSerializedValues(node);
	hideFrameWidget(node);
	const panel = buildPanel(node);
	if (!panel.applySavedPreview?.()) {
		if (!panel.applyUpstreamPreview()) panel.applyData?.({});
	}
	refresh(node);
}

app.registerExtension({
	name: `GJJ.${NODE_NAME}`,
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== NODE_NAME) return;

		const origOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = origOnNodeCreated?.apply(this, arguments);
			requestAnimationFrame(() => applyNodeState(this));
			return result;
		};

		const origOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = origOnConfigure?.apply(this, [serializedNode, ...args]);
			restoreSerializedValues(this, serializedNode);
			requestAnimationFrame(() => applyNodeState(this));
			return result;
		};

		const origOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = origOnSerialize?.apply(this, [serializedNode, ...args]);
			writeSerializedValues(this, serializedNode);
			return result;
		};

		const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function () {
			const result = origOnConnectionsChange?.apply(this, arguments);
			setTimeout(() => applyNodeState(this), 60);
			return result;
		};

		const origOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			origOnExecuted?.apply(this, arguments);
			const panel = buildPanel(this);
			panel.applyData({
				preview_video: message?.preview_video,
				preview_frame_rate: message?.preview_frame_rate?.[0],
				frame_count: message?.frame_count?.[0],
				selected_frames: message?.selected_frames?.[0],
			});
		};
	},
});

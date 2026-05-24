import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET_CLASS = "GJJ_TrajectoryJSON";
const STATE_WIDGET = "trajectory_json";
const WIDTH_WIDGET = "canvas_width";
const HEIGHT_WIDGET = "canvas_height";
const FRAME_WIDGET = "frame_count";
const PANEL_WIDGET = "gjj_trajectory_panel";
const IMAGE_INPUT = "image";

const DEFAULT_TRACKS = [[
	{ x: 393, y: 126 },
	{ x: 393, y: 126 },
	{ x: 388, y: 123 },
	{ x: 372, y: 122 },
	{ x: 312, y: 121 },
	{ x: 263, y: 123 },
	{ x: 226, y: 137 },
	{ x: 226, y: 142 },
	{ x: 252, y: 149 },
	{ x: 307, y: 153 },
	{ x: 367, y: 165 },
	{ x: 448, y: 175 },
	{ x: 523, y: 181 },
	{ x: 590, y: 187 },
	{ x: 625, y: 192 },
	{ x: 632, y: 218 },
]];

const TRACK_COLORS = ["#66d9ef", "#a6e22e", "#fd971f", "#f92672", "#ae81ff", "#e6db74", "#4dd0e1", "#ff8a65"];

function stringifyTracks(tracks) {
	return JSON.stringify(normalizeTracks(tracks));
}

function pointDistance(a, b) {
	return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

function resampleTrack(points, frameCount) {
	const target = Math.max(1, Math.round(Number(frameCount) || 121));
	if (!Array.isArray(points) || points.length === 0) return Array.from({ length: target }, () => ({ x: 0, y: 0 }));
	if (points.length === 1) return Array.from({ length: target }, () => ({ ...points[0] }));
	if (points.length === target) return points.map((point) => ({ ...point }));

	const lengths = [0];
	for (let i = 1; i < points.length; i += 1) {
		lengths.push(lengths[lengths.length - 1] + pointDistance(points[i - 1], points[i]));
	}
	const total = lengths[lengths.length - 1];
	if (total <= 1e-6) return Array.from({ length: target }, () => ({ ...points[0] }));

	const result = [];
	let srcIndex = 1;
	for (let outIndex = 0; outIndex < target; outIndex += 1) {
		const distance = total * outIndex / Math.max(1, target - 1);
		while (srcIndex < lengths.length - 1 && lengths[srcIndex] < distance) srcIndex += 1;
		const leftIndex = Math.max(0, srcIndex - 1);
		const rightIndex = Math.min(srcIndex, points.length - 1);
		const span = Math.max(1e-6, lengths[rightIndex] - lengths[leftIndex]);
		const ratio = Math.max(0, Math.min(1, (distance - lengths[leftIndex]) / span));
		const left = points[leftIndex];
		const right = points[rightIndex];
		result.push({
			x: Math.round(Number(left.x) + (Number(right.x) - Number(left.x)) * ratio),
			y: Math.round(Number(left.y) + (Number(right.y) - Number(left.y)) * ratio),
		});
	}
	return result;
}

function gcd(a, b) {
	let x = Math.abs(Math.round(Number(a) || 0));
	let y = Math.abs(Math.round(Number(b) || 0));
	while (y) {
		const next = x % y;
		x = y;
		y = next;
	}
	return x || 1;
}

function wanProcessedLength(length) {
	const numFrames = Math.max(0, Math.round(Number(length) || 1) - 1);
	if (numFrames <= 0) return 1;
	const divisor = gcd(120, numFrames);
	const step = 120 / divisor;
	const repeat = numFrames / divisor;
	const repeatedLen = 120 * repeat;
	const sampledLen = repeatedLen <= 1 ? 0 : Math.floor((repeatedLen - 2) / step) + 1;
	return 1 + sampledLen;
}

function wanRequiredLength(length) {
	const latentT = Math.floor((Math.max(1, Math.round(Number(length) || 1)) - 1) / 4) + 1;
	return 1 + 4 * (latentT - 1);
}

function safeWanLength(length) {
	const requested = Math.max(1, Math.round(Number(length) || 81));
	if (wanProcessedLength(requested) === wanRequiredLength(requested)) return requested;
	for (let candidate = requested + 1; candidate <= 4096; candidate += 1) {
		if ((candidate - 1) % 4 === 0 && wanProcessedLength(candidate) === wanRequiredLength(candidate)) return candidate;
	}
	for (let candidate = requested - 1; candidate > 0; candidate -= 1) {
		if ((candidate - 1) % 4 === 0 && wanProcessedLength(candidate) === wanRequiredLength(candidate)) return candidate;
	}
	return 81;
}

function effectiveTracks(node, tracks) {
	const frameCount = getWidgetNumber(node, FRAME_WIDGET, 121);
	return normalizeTracks(tracks).map((track) => resampleTrack(track, frameCount));
}

function normalizePoint(value) {
	if (!value || typeof value !== "object") return null;
	const x = Math.round(Number(value.x));
	const y = Math.round(Number(value.y));
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x, y };
}

function normalizeTracks(value) {
	let tracks = value;
	if (!Array.isArray(tracks)) return structuredClone(DEFAULT_TRACKS);
	if (tracks.length > 0 && tracks.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
		tracks = [tracks];
	}
	if (tracks.length > 0 && tracks.every((batch) => Array.isArray(batch) && batch.every((track) => Array.isArray(track)))) {
		tracks = tracks.flat();
	}
	if (!Array.isArray(tracks)) return structuredClone(DEFAULT_TRACKS);
	const result = [];
	for (const track of tracks) {
		if (!Array.isArray(track)) continue;
		const points = track.map(normalizePoint).filter(Boolean);
		if (points.length > 0) result.push(points);
	}
	return result.length > 0 ? result : [[]];
}

function parseTracks(raw) {
	try {
		return normalizeTracks(JSON.parse(String(raw || "")));
	} catch (_) {
		return structuredClone(DEFAULT_TRACKS);
	}
}

function findWidget(node, name) {
	return node?.widgets?.find?.((widget) => widget?.name === name);
}

function getWidgetNumber(node, name, fallback) {
	const widget = findWidget(node, name);
	const value = Number(widget?.value);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function setWidgetNumber(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) return;
	widget.value = Math.max(16, Math.round(Number(value) || 16));
	widget.callback?.(widget.value);
}

function getUpstreamImageSrc(node) {
	const input = node.inputs?.find?.((item) => item?.name === IMAGE_INPUT);
	if (!input || input.link == null || !app.graph?.links) return null;
	const link = app.graph.links[input.link];
	if (!link) return null;
	const srcId = link.origin_id ?? link.source_id ?? link.from_id;
	if (srcId == null) return null;
	const srcNode = app.graph.getNodeById?.(srcId);
	if (!srcNode) return null;

	if (Array.isArray(srcNode.imgs)) {
		for (const img of srcNode.imgs) {
			if (img?.src) return img.src;
		}
	}
	if (srcNode.image?.src) return srcNode.image.src;
	if (srcNode.preview?.src) return srcNode.preview.src;

	const imageWidget = findWidget(srcNode, "image") || findWidget(srcNode, "file") || findWidget(srcNode, "filename");
	if (imageWidget?.value && (srcNode.comfyClass === "LoadImage" || srcNode.comfyClass === "LoadImageOutput")) {
		const type = srcNode.comfyClass === "LoadImageOutput" ? "output" : "input";
		return api.apiURL(`/view?filename=${encodeURIComponent(imageWidget.value)}&type=${type}&subfolder=&rand=${Date.now()}`);
	}

	return null;
}

function getStoredJson(node) {
	const prop = node?.properties?.[STATE_WIDGET];
	if (typeof prop === "string" && prop.trim()) return prop;
	const widget = findWidget(node, STATE_WIDGET);
	return String(widget?.value || stringifyTracks(DEFAULT_TRACKS));
}

function setStoredJson(node, value) {
	const text = stringifyTracks(parseTracks(value));
	node.properties = node.properties || {};
	node.properties[STATE_WIDGET] = text;
	const widget = findWidget(node, STATE_WIDGET);
	if (widget) {
		widget.value = text;
		widget.serializeValue = () => text;
		widget.callback?.(text);
	}
	refreshNode(node);
	return text;
}

function hideBackingWidget(widget) {
	if (!widget || widget.__gjjTrajectoryHidden) return;
	widget.__gjjTrajectoryHidden = true;
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || STATE_WIDGET}`;
	widget.label = "";
	widget.localized_name = "";
	widget.tooltip = "";
	widget.options = { ...(widget.options || {}), tooltip: "" };
	widget.serialize = true;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.y = 0;
	widget.last_y = 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	if (widget.element?.style) {
		widget.element.style.display = "none";
		widget.element.style.height = "0px";
		widget.element.style.minHeight = "0px";
		widget.element.style.margin = "0";
		widget.element.style.padding = "0";
		widget.element.style.overflow = "hidden";
		widget.element.style.pointerEvents = "none";
	}
	if (widget.inputEl?.style) {
		widget.inputEl.style.display = "none";
		widget.inputEl.title = "";
		widget.inputEl.style.pointerEvents = "none";
	}
}

function removeHiddenInputSockets(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const type = String(input?.type || "");
		const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
		if (name === STATE_WIDGET || converted === STATE_WIDGET) {
			try { node.disconnectInput?.(index); } catch (_) {}
			if (typeof node.removeInput === "function") node.removeInput(index);
			else node.inputs.splice(index, 1);
		}
	}
}

function compactNode(node) {
	hideBackingWidget(findWidget(node, STATE_WIDGET));
	removeHiddenInputSockets(node);
	if (Array.isArray(node?.widgets)) {
		node.widgets = node.widgets
			.map((widget, index) => ({ widget, index }))
			.sort((a, b) => {
				const ap = a.widget?.name === PANEL_WIDGET ? 0 : a.widget?.name === STATE_WIDGET ? 90 : 50;
				const bp = b.widget?.name === PANEL_WIDGET ? 0 : b.widget?.name === STATE_WIDGET ? 90 : 50;
				return ap - bp || a.index - b.index;
			})
			.map((entry) => entry.widget);
	}
}

function refreshNode(node) {
	try { node?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { node?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app?.canvas?.setDirty?.(true, true); } catch (_) {}
}

function protectDomEvents(element) {
	const stop = (event) => {
		const tag = String(event.target?.tagName || "").toLowerCase();
		if (["button", "input", "textarea", "select", "canvas"].includes(tag)) event.stopPropagation();
	};
	for (const name of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "click", "dblclick", "wheel", "contextmenu", "keydown", "keyup"]) {
		element.addEventListener(name, stop);
	}
}

function createButton(label, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title || label;
	button.style.cssText = [
		"border:1px solid rgba(120,210,230,.28)",
		"background:linear-gradient(180deg,#223239,#182329)",
		"color:#d8f7ff",
		"border-radius:6px",
		"padding:4px 6px",
		"font-size:11.5px",
		"font-weight:700",
		"cursor:pointer",
		"pointer-events:auto",
		"min-width:0",
		"flex:1 1 calc(25% - 4px)",
		"white-space:nowrap",
	].join(";");
	for (const name of ["pointerdown", "mousedown", "click", "dblclick"]) {
		button.addEventListener(name, (event) => {
			event.stopPropagation();
		});
	}
	button.addEventListener("mouseenter", () => { button.style.borderColor = "rgba(120,230,255,.62)"; });
	button.addEventListener("mouseleave", () => { button.style.borderColor = "rgba(120,210,230,.28)"; });
	return button;
}

function createPanel(node) {
	if (node.__gjjTrajectoryPanel || typeof node.addDOMWidget !== "function") {
		compactNode(node);
		return;
	}

	let tracks = parseTracks(getStoredJson(node));
	let activeTrack = null;
	let drawing = false;
	let hoverPoint = null;
	let backgroundImage = null;
	let backgroundLabel = "";
	let backgroundLoadToken = 0;
	let refreshingByExecution = false;

	const root = document.createElement("div");
	root.className = "gjj-trajectory-root";
	root.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"padding:6px 0 7px",
		"color:#dceff4",
		"font-family:'Microsoft YaHei',sans-serif",
		"pointer-events:auto",
		"user-select:none",
	].join(";");
	protectDomEvents(root);

	const toolbar = document.createElement("div");
	toolbar.style.cssText = [
		"display:flex",
		"flex-wrap:wrap",
		"gap:4px",
		"margin-bottom:6px",
	].join(";");

	const canvasWrap = document.createElement("div");
	canvasWrap.style.cssText = [
		"position:relative",
		"box-sizing:border-box",
		"width:100%",
		"border:1px solid rgba(115,205,225,.32)",
		"border-radius:9px",
		"background:radial-gradient(circle at 20% 0%,rgba(90,180,210,.16),transparent 36%),#0d1418",
		"overflow:hidden",
	].join(";");

	const canvas = document.createElement("canvas");
	canvas.style.cssText = "display:block;width:100%;height:260px;cursor:crosshair;";
	canvasWrap.append(canvas);

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "image/*";
	fileInput.style.display = "none";
	root.append(fileInput);

	const status = document.createElement("div");
	status.style.cssText = [
		"margin-top:6px",
		"padding:5px 7px",
		"border:1px solid rgba(120,210,230,.18)",
		"border-radius:7px",
		"background:rgba(8,13,16,.62)",
		"font-size:12px",
		"line-height:1.35",
		"color:#bcd5dc",
		"white-space:nowrap",
		"overflow:hidden",
		"text-overflow:ellipsis",
	].join(";");

	const updateStatus = () => {
		const pointCount = tracks.reduce((sum, track) => sum + track.length, 0);
		const outputCount = Math.max(1, Math.round(getWidgetNumber(node, FRAME_WIDGET, 121)));
		const wanLength = safeWanLength(outputCount);
		const wanText = wanLength === outputCount ? ` / Wan length ${wanLength}` : ` / Wan length ${wanLength}（避开${outputCount}）`;
		const hover = hoverPoint ? ` | 坐标 ${hoverPoint.x}, ${hoverPoint.y}` : "";
		const bg = backgroundLabel ? ` | 背景 ${backgroundLabel}` : "";
		status.textContent = `拖动画轨迹：${tracks.length} 条 / 原始 ${pointCount} 点 / JSON ${outputCount} 点${wanText}${hover}${bg}`;
	};

	const getDims = () => ({
		width: Math.max(16, Math.round(getWidgetNumber(node, WIDTH_WIDGET, 768))),
		height: Math.max(16, Math.round(getWidgetNumber(node, HEIGHT_WIDGET, 432))),
	});

	const getDisplaySize = () => {
		const dims = getDims();
		const outerWidth = Math.max(320, Math.round((node.size?.[0] || 460) - 28));
		const h = Math.max(180, Math.round(outerWidth * dims.height / Math.max(1, dims.width)));
		return { width: outerWidth, height: h };
	};

	const getCanvasCssSize = () => {
		const fallback = getDisplaySize();
		const width = Math.max(1, Math.round(canvas.clientWidth || fallback.width));
		const height = Math.max(1, Math.round(canvas.clientHeight || fallback.height));
		return { width, height };
	};

	const getRenderFrame = () => {
		const dims = getDims();
		const size = getCanvasCssSize();
		const cw = size.width;
		const ch = size.height;
		const scale = Math.min(cw / Math.max(1, dims.width), ch / Math.max(1, dims.height));
		const width = dims.width * scale;
		const height = dims.height * scale;
		return {
			x: (cw - width) / 2,
			y: (ch - height) / 2,
			width,
			height,
		};
	};

	const modelToCanvas = (point) => {
		const dims = getDims();
		const frame = getRenderFrame();
		return {
			x: frame.x + point.x / dims.width * frame.width,
			y: frame.y + point.y / dims.height * frame.height,
		};
	};

	const eventToPoint = (event) => {
		const dims = getDims();
		const frame = getRenderFrame();
		const rect = canvas.getBoundingClientRect();
		const size = getCanvasCssSize();
		const localXRaw = (event.clientX - rect.left) / Math.max(1, rect.width) * size.width;
		const localYRaw = (event.clientY - rect.top) / Math.max(1, rect.height) * size.height;
		const localX = Math.max(frame.x, Math.min(frame.x + frame.width, localXRaw));
		const localY = Math.max(frame.y, Math.min(frame.y + frame.height, localYRaw));
		const x = Math.max(0, Math.min(dims.width, Math.round((localX - frame.x) / Math.max(1, frame.width) * dims.width)));
		const y = Math.max(0, Math.min(dims.height, Math.round((localY - frame.y) / Math.max(1, frame.height) * dims.height)));
		return { x, y };
	};

	const commit = () => {
		tracks = normalizeTracks(tracks);
		setStoredJson(node, stringifyTracks(tracks));
		updateStatus();
		draw();
	};

	const resizeCanvas = () => {
		const size = getDisplaySize();
		const dpr = Math.max(1, window.devicePixelRatio || 1);
		canvas.style.height = `${size.height}px`;
		canvas.width = Math.round(size.width * dpr);
		canvas.height = Math.round(size.height * dpr);
		canvas.style.width = "100%";
		const ctx = canvas.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		draw();
		const targetHeight = Math.max(Number(node.size?.[1] || 0), size.height + 150);
		if (Number.isFinite(targetHeight) && node.size?.[1] < targetHeight - 2) {
			node.setSize?.([Math.max(460, Number(node.size?.[0] || 460)), targetHeight]);
		}
	};

	const drawGrid = (ctx, w, h) => {
		ctx.fillStyle = "#0d1418";
		ctx.fillRect(0, 0, w, h);
		const frame = getRenderFrame();
		if (backgroundImage) {
			ctx.globalAlpha = 0.72;
			ctx.drawImage(backgroundImage, frame.x, frame.y, frame.width, frame.height);
			ctx.globalAlpha = 1;
			ctx.fillStyle = "rgba(13,20,24,.28)";
			ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
		}
		ctx.save();
		ctx.beginPath();
		ctx.rect(frame.x, frame.y, frame.width, frame.height);
		ctx.clip();
		ctx.strokeStyle = "rgba(136,200,214,.13)";
		ctx.lineWidth = 1;
		for (let i = 0; i <= 8; i += 1) {
			const x = Math.round(frame.x + i * frame.width / 8) + 0.5;
			ctx.beginPath();
			ctx.moveTo(x, frame.y);
			ctx.lineTo(x, frame.y + frame.height);
			ctx.stroke();
		}
		for (let i = 0; i <= 6; i += 1) {
			const y = Math.round(frame.y + i * frame.height / 6) + 0.5;
			ctx.beginPath();
			ctx.moveTo(frame.x, y);
			ctx.lineTo(frame.x + frame.width, y);
			ctx.stroke();
		}
		ctx.restore();
	};

	const setBackgroundImage = (img, label = "图片") => {
		backgroundImage = img;
		backgroundLabel = label;
		const iw = Math.round(img.naturalWidth || img.width || 0);
		const ih = Math.round(img.naturalHeight || img.height || 0);
		if (iw > 0 && ih > 0) {
			setWidgetNumber(node, WIDTH_WIDGET, iw);
			setWidgetNumber(node, HEIGHT_WIDGET, ih);
		}
		resizeCanvas();
		updateStatus();
	};

	const loadBackgroundUrl = (src, label = "上游图片") => {
		if (!src) return false;
		const token = ++backgroundLoadToken;
		const img = new Image();
		if (!String(src).startsWith("data:")) img.crossOrigin = "anonymous";
		img.onload = () => {
			if (token !== backgroundLoadToken) return;
			setBackgroundImage(img, label);
		};
		img.onerror = () => {
			if (token !== backgroundLoadToken) return;
			backgroundImage = null;
			backgroundLabel = "";
			updateStatus();
			draw();
		};
		img.src = src;
		return true;
	};

	const refreshUpstreamImage = (statusOnMissing = false) => {
		const src = getUpstreamImageSrc(node);
		if (src) {
			const loaded = loadBackgroundUrl(src, "上游图片");
			if (loaded) status.textContent = "正在刷新上游图片…";
			return loaded;
		}
		if (statusOnMissing) {
			backgroundImage = null;
			backgroundLabel = "";
			updateStatus();
			status.textContent = node.inputs?.some?.((input) => input?.name === IMAGE_INPUT && input.link != null)
				? "已刷新画布；上游节点还没有可读取的预览图片"
				: "已刷新画布；未检测到上游图片";
			draw();
		}
		return false;
	};

	const refreshThroughExecution = async () => {
		if (refreshingByExecution) return false;
		refreshingByExecution = true;
		status.textContent = "正在执行当前节点读取传入图片…";
		try {
			const ok = await queueOnlyCurrentNode(node);
			if (!ok) {
				status.textContent = "刷新失败：当前 ComfyUI 前端不支持只执行当前节点";
			}
			return ok;
		} catch (error) {
			console.warn("[GJJ] 轨迹JSON刷新传入图片失败：", error);
			status.textContent = `刷新失败：${error?.message || error}`;
			return false;
		} finally {
			refreshingByExecution = false;
		}
	};

	const scheduleUpstreamImageRefresh = (delay = 320, statusOnMissing = false) => {
		clearTimeout(node.__gjjTrajectoryUpstreamTimer);
		const hasLinkedImage = node.inputs?.some?.((input) => input?.name === IMAGE_INPUT && input.link != null);
		node.__gjjTrajectoryUpstreamTimer = setTimeout(() => {
			refreshUpstreamImage(statusOnMissing);
		}, delay);
		return Boolean(hasLinkedImage);
	};

	function draw() {
		const ctx = canvas.getContext("2d");
		const size = getCanvasCssSize();
		const w = size.width;
		const h = size.height;
		drawGrid(ctx, w, h);

		tracks.forEach((track, trackIndex) => {
			if (!Array.isArray(track) || track.length === 0) return;
			const color = TRACK_COLORS[trackIndex % TRACK_COLORS.length];
			ctx.lineJoin = "round";
			ctx.lineCap = "round";
			ctx.lineWidth = 3;
			ctx.strokeStyle = color;
			ctx.shadowColor = color;
			ctx.shadowBlur = 7;
			ctx.beginPath();
			track.forEach((point, pointIndex) => {
				const p = modelToCanvas(point);
				if (pointIndex === 0) ctx.moveTo(p.x, p.y);
				else ctx.lineTo(p.x, p.y);
			});
			ctx.stroke();
			ctx.shadowBlur = 0;

			for (let i = 0; i < track.length; i += Math.max(1, Math.ceil(track.length / 36))) {
				const p = modelToCanvas(track[i]);
				ctx.fillStyle = i === 0 ? "#ffffff" : color;
				ctx.beginPath();
				ctx.arc(p.x, p.y, i === 0 ? 4.5 : 2.8, 0, Math.PI * 2);
				ctx.fill();
			}

			const end = modelToCanvas(track[track.length - 1]);
			ctx.fillStyle = "#ffdf6e";
			ctx.beginPath();
			ctx.arc(end.x, end.y, 5, 0, Math.PI * 2);
			ctx.fill();
		});

		if (hoverPoint) {
			const p = modelToCanvas(hoverPoint);
			ctx.strokeStyle = "rgba(255,255,255,.72)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(p.x - 6, p.y);
			ctx.lineTo(p.x + 6, p.y);
			ctx.moveTo(p.x, p.y - 6);
			ctx.lineTo(p.x, p.y + 6);
			ctx.stroke();
		}
	}

	const appendPoint = (point) => {
		if (!activeTrack) return;
		const last = activeTrack[activeTrack.length - 1];
		if (last && Math.abs(last.x - point.x) < 1 && Math.abs(last.y - point.y) < 1) return;
		activeTrack.push(point);
		hoverPoint = point;
		draw();
		updateStatus();
	};

	canvas.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		canvas.setPointerCapture?.(event.pointerId);
		drawing = true;
		activeTrack = [];
		tracks.push(activeTrack);
		appendPoint(eventToPoint(event));
		event.preventDefault();
	});

	canvas.addEventListener("pointermove", (event) => {
		const point = eventToPoint(event);
		hoverPoint = point;
		if (drawing) appendPoint(point);
		else {
			updateStatus();
			draw();
		}
	});

	canvas.addEventListener("pointerup", (event) => {
		if (!drawing) return;
		const point = eventToPoint(event);
		appendPoint(point);
		if (activeTrack && activeTrack.length === 1) activeTrack.push({ ...activeTrack[0] });
		drawing = false;
		activeTrack = null;
		commit();
		event.preventDefault();
	});

	canvas.addEventListener("pointerleave", () => {
		hoverPoint = null;
		updateStatus();
		draw();
	});

	canvas.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		if (tracks.length === 0) return;
		const last = tracks[tracks.length - 1];
		if (last && last.length > 0) {
			last.pop();
			if (last.length === 0) tracks.pop();
			commit();
		}
	});

	const undoButton = createButton("↩️撤销", "删除最后一条轨迹");
	undoButton.addEventListener("click", () => {
		tracks.pop();
		if (tracks.length === 0) tracks = [[]];
		commit();
	});

	const clearButton = createButton("🧹清空", "清空全部轨迹");
	clearButton.addEventListener("click", () => {
		tracks = [[]];
		commit();
	});

	const sampleButton = createButton("✨示例", "恢复默认示例轨迹");
	sampleButton.addEventListener("click", () => {
		tracks = structuredClone(DEFAULT_TRACKS);
		commit();
	});

	const reverseButton = createButton("🔁反向", "反转每条轨迹的点位顺序");
	reverseButton.addEventListener("click", () => {
		tracks = normalizeTracks(tracks).map((track) => [...track].reverse());
		commit();
	});

	const importButton = createButton("📥JSON", "粘贴 JSON 并恢复轨迹");
	importButton.addEventListener("click", () => {
		const text = window.prompt("粘贴轨迹 JSON，可用 [[{\"x\":1,\"y\":2}]] 或 {\"trajectories\":[...]}", stringifyTracks(tracks));
		if (!text) return;
		let parsed = text;
		try {
			const data = JSON.parse(text);
			parsed = Array.isArray(data?.trajectories) ? data.trajectories : data;
		} catch (_) {}
		tracks = normalizeTracks(parsed);
		commit();
	});

	const copyButton = createButton("📋复制", "复制当前轨迹 JSON");
	copyButton.addEventListener("click", async () => {
		const text = JSON.stringify(effectiveTracks(node, tracks));
		try {
			await navigator.clipboard?.writeText(text);
			status.textContent = `已复制 ${text.length} 字符`;
		} catch (_) {
			window.prompt("复制轨迹 JSON", text);
		}
	});

	const imageButton = createButton("🖼️图片", "导入本地图片作为轨迹背景");
	imageButton.addEventListener("click", () => fileInput.click());

	const refreshButton = createButton("🔄刷新", "重新读取上游图片并刷新画布");
	refreshButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		status.textContent = "正在刷新画布…";
		const loaded = refreshUpstreamImage(true);
		resizeCanvas();
		updateStatus();
		if (!loaded) {
			refreshUpstreamImage(true);
			if (node.inputs?.some?.((input) => input?.name === IMAGE_INPUT && input.link != null)) {
				await refreshThroughExecution();
			}
		}
	});

	fileInput.addEventListener("change", () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => loadBackgroundUrl(String(reader.result || ""), file.name || "本地图片");
		reader.readAsDataURL(file);
		fileInput.value = "";
	});

	toolbar.append(undoButton, clearButton, sampleButton, reverseButton, importButton, imageButton, refreshButton, copyButton);
	root.append(toolbar, canvasWrap, status);

	const panelWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(252, Math.round(canvas.clientHeight || 260) + 50),
	});
	panelWidget.computeSize = (width) => [Math.max(320, Number(width || node.size?.[0] || 460)), Math.max(252, Math.round(canvas.clientHeight || 260) + 50)];
	panelWidget.serialize = false;
	panelWidget.draw = () => {};

	node.__gjjTrajectoryPanel = { root, canvas, panelWidget, resizeCanvas };

	const patchDimensionWidget = (name) => {
		const widget = findWidget(node, name);
		if (!widget || widget.__gjjTrajectoryDimPatched) return;
		widget.__gjjTrajectoryDimPatched = true;
		const originalCallback = widget.callback;
		widget.callback = function (...args) {
			const result = originalCallback?.apply(this, args);
			setTimeout(() => {
				resizeCanvas();
				updateStatus();
			}, 0);
			return result;
		};
	};

	patchDimensionWidget(WIDTH_WIDGET);
	patchDimensionWidget(HEIGHT_WIDGET);
	patchDimensionWidget(FRAME_WIDGET);

	scheduleUpstreamImageRefresh(250);

	const originalConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (slotType, slotIndex, connected, linkInfo) {
		originalConnectionsChange?.apply(this, arguments);
		const input = node.inputs?.[slotIndex];
		if (!input || input.name !== IMAGE_INPUT) return;
		scheduleUpstreamImageRefresh(350);
	};

	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message, ...args) {
		const result = originalExecuted?.apply(this, [message, ...args]);
		const preview = Array.isArray(message?.bg_image) ? message.bg_image[0] : null;
		if (preview) {
			loadBackgroundUrl(`data:image/png;base64,${preview}`, "传入图片");
			return result;
		}
		if (node.inputs?.some?.((input) => input?.name === IMAGE_INPUT && input.link != null)) {
			scheduleUpstreamImageRefresh(260);
		}
		return result;
	};

	const handleApiExecuted = () => {
		if (node.inputs?.some?.((input) => input?.name === IMAGE_INPUT && input.link != null)) {
			scheduleUpstreamImageRefresh(300);
		}
	};
	try { api.addEventListener?.("executed", handleApiExecuted); } catch (_) {}

	const originalRemoved = node.onRemoved;
	node.onRemoved = function (...args) {
		clearTimeout(node.__gjjTrajectoryUpstreamTimer);
		try { api.removeEventListener?.("executed", handleApiExecuted); } catch (_) {}
		return originalRemoved?.apply(this, args);
	};

	if (!node.size || node.size[0] < 460) {
		node.setSize?.([460, Math.max(390, node.size?.[1] || 390)]);
	}

	compactNode(node);
	updateStatus();
	requestAnimationFrame(resizeCanvas);
	setTimeout(resizeCanvas, 100);
}

app.registerExtension({
	name: "GJJ.TrajectoryJSON",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_CLASS) return;

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			this.properties = this.properties || {};
			const stored = this.properties[STATE_WIDGET] || findWidget(this, STATE_WIDGET)?.value || stringifyTracks(DEFAULT_TRACKS);
			setStoredJson(this, stored);
			compactNode(this);
			setTimeout(() => createPanel(this), 60);
			setTimeout(() => compactNode(this), 100);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[STATE_WIDGET] = setStoredJson(this, getStoredJson(this));
			originalOnSerialize?.apply(this, [serializedNode]);
		};
	},

	nodeCreated(node) {
		if (node.comfyClass !== TARGET_CLASS) return;
		compactNode(node);
		requestAnimationFrame(() => createPanel(node));
		setTimeout(() => compactNode(node), 0);
		setTimeout(() => compactNode(node), 120);
	},
});

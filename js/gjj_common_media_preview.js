import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

export const GJJ_COMMON_MEDIA_OPEN_FOLDER_API = "/gjj/common/open_media_folder";
export const GJJ_AUDIO_PLAYER_HEIGHT = 24;
export const GJJ_AUDIO_WAVEFORM_HEIGHT = 72;
export const GJJ_ANY_PREVIEW_MEDIA_DRAG_MIME = "application/x-gjj-any-preview-media";

const STYLE_ID = "gjj-common-media-preview-style";
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif", "tiff"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus", "aiff", "aif"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi", "flv", "mpeg", "mpg", "m4v", "wmv"]);

const KIND_LABELS = {
	image: "图片",
	audio: "音频",
	video: "视频",
};

let audioWaveformContext = null;
const audioWaveformCache = new Map();
const audioWaveformPeaks = new WeakMap();

function ensureStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		.gjj-common-media-preview { width:100%; min-width:0; box-sizing:border-box; display:block; }
		.gjj-common-media-preview * { box-sizing:border-box; }
		.gjj-common-media-preview.gjj-common-media-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(var(--gjj-media-tile-min, 118px), 1fr)); gap:8px; align-items:start; }
		.gjj-common-media-card { position:relative; min-width:0; overflow:hidden; border:1px solid #263a42; border-radius:8px; background:#0b1317; color:#dce7e2; }
		.gjj-common-media-card-single { width:100%; display:flex; flex-direction:column; gap:7px; padding:8px; }
		.gjj-common-media-card-grid { aspect-ratio:1 / 1; min-height:var(--gjj-media-tile-height, 108px); cursor:pointer; }
		.gjj-common-media-card-grid-caption { aspect-ratio:auto; min-height:0; display:flex; flex-direction:column; }
		.gjj-common-media-stage { position:relative; width:100%; min-width:0; overflow:hidden; border-radius:6px; background:#081015; display:flex; align-items:center; justify-content:center; }
		.gjj-common-media-card-single .gjj-common-media-stage { min-height:var(--gjj-media-single-min, 168px); max-height:var(--gjj-media-single-max, 360px); }
		.gjj-common-media-card-grid .gjj-common-media-stage { position:absolute; inset:0; border-radius:0; }
		.gjj-common-media-card-grid-caption .gjj-common-media-stage { position:relative; inset:auto; aspect-ratio:1 / 1; min-height:var(--gjj-media-tile-height, 108px); flex:0 0 auto; }
		.gjj-common-media-card img, .gjj-common-media-card video { width:100%; height:100%; display:block; background:#081015; }
		.gjj-common-media-card-single img, .gjj-common-media-card-single video { object-fit:contain; max-height:var(--gjj-media-single-max, 360px); }
		.gjj-common-media-card-grid img, .gjj-common-media-card-grid video { object-fit:cover; }
		.gjj-common-media-card-grid video { pointer-events:none; }
		.gjj-common-media-audio-stage { min-height:78px; background:linear-gradient(135deg, #101b20, #0b1216); }
		.gjj-common-media-card-single .gjj-common-media-audio-stage { flex-direction:column; gap:8px; padding:10px; }
		.gjj-common-audio-waveform { position:relative; width:100%; height:var(--gjj-audio-waveform-height, 72px); border:1px solid #263a42; border-radius:7px; background:#081015; overflow:hidden; box-sizing:border-box; cursor:pointer; }
		.gjj-common-audio-waveform canvas { width:100%; height:100%; display:block; }
		.gjj-common-media-card-grid .gjj-common-audio-waveform { position:absolute; inset:0; width:100%; height:100%; border:0; border-radius:0; }
		.gjj-common-media-card-single audio { width:100%; height:28px; display:block; }
		.gjj-common-media-card-grid audio { position:absolute; left:7px; right:7px; bottom:7px; z-index:4; width:calc(100% - 14px); height:24px; }
		.gjj-common-media-info { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; align-items:start; gap:6px; width:100%; min-width:0; font:12px/1.35 ui-sans-serif, system-ui, sans-serif; color:#cfe0dc; }
		.gjj-common-media-info-main { min-width:0; overflow-wrap:anywhere; word-break:break-word; }
		.gjj-common-media-info-title { color:#e7f3ef; font-weight:650; }
		.gjj-common-media-info-meta { color:#9fb0ad; }
		.gjj-common-media-folder { border:1px solid #34464e; border-radius:5px; background:#182329; color:#e7f3ef; width:24px; height:22px; padding:0; display:flex; align-items:center; justify-content:center; font-size:12px; cursor:pointer; }
		.gjj-common-media-folder:hover { background:#223139; border-color:#56707a; }
		.gjj-common-media-badge { position:absolute; z-index:5; top:6px; left:6px; max-width:calc(100% - 12px); padding:2px 7px; border-radius:999px; background:rgba(0,0,0,.52); color:#fff; font-size:10px; line-height:1.3; font-weight:700; pointer-events:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-common-media-size { position:absolute; z-index:5; right:6px; top:6px; padding:2px 6px; border-radius:5px; background:rgba(0,0,0,.48); color:#fff; font-size:10px; line-height:1.3; pointer-events:none; white-space:nowrap; }
		.gjj-common-media-grid-action { position:absolute; z-index:6; right:6px; top:6px; width:24px; height:22px; padding:0; border:1px solid rgba(120,148,158,.78); border-radius:6px; background:rgba(12,19,23,.78); color:#f4fbff; font-size:12px; line-height:1; display:flex; align-items:center; justify-content:center; cursor:pointer; }
		.gjj-common-media-grid-action:hover { background:rgba(36,50,57,.92); border-color:#7db0c4; }
		.gjj-common-media-single-action { right:8px; top:8px; width:32px; height:30px; border-radius:8px; font-size:16px; background:rgba(12,19,23,.86); }
		.gjj-common-media-grid-caption-text { min-width:0; padding:4px 5px 5px; color:#c9d8dc; font-size:10px; line-height:1.2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:#0b1317; }
		.gjj-common-media-empty, .gjj-common-media-message { width:100%; min-height:54px; display:flex; align-items:center; justify-content:center; padding:10px; border:1px dashed #30434b; border-radius:8px; background:#0a1216; color:#7f9298; font-size:12px; text-align:center; white-space:pre-wrap; }
		.gjj-common-media-message-error { border-color:#765048; background:#211413; color:#ffb4a8; }
		.gjj-common-media-browser { position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,.9); backdrop-filter:blur(8px); display:flex; flex-direction:column; align-items:stretch; justify-content:center; padding:18px; cursor:zoom-out; }
		.gjj-common-media-browser-bar { position:absolute; left:18px; right:18px; top:14px; display:flex; align-items:center; gap:8px; color:#e7f3ef; font:12px/1.35 ui-sans-serif, system-ui, sans-serif; pointer-events:none; }
		.gjj-common-media-browser-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:5px 8px; border-radius:7px; background:rgba(10,17,21,.72); }
		.gjj-common-media-browser-actions { margin-left:auto; display:flex; gap:6px; pointer-events:auto; }
		.gjj-common-media-browser-actions button { border:1px solid #44565f; border-radius:7px; background:#172329; color:#e7f3ef; height:28px; padding:0 9px; cursor:pointer; }
		.gjj-common-media-browser-content { width:100%; height:100%; display:flex; align-items:center; justify-content:center; min-width:0; min-height:0; }
		.gjj-common-media-browser-content img, .gjj-common-media-browser-content video { max-width:94vw; max-height:88vh; object-fit:contain; border-radius:8px; box-shadow:0 0 44px rgba(0,0,0,.55); cursor:grab; }
		.gjj-common-media-browser-content audio { width:min(720px, 86vw); }
		.gjj-common-media-browser-hint { position:absolute; left:50%; bottom:18px; transform:translateX(-50%); padding:5px 9px; border-radius:999px; background:rgba(10,17,21,.62); color:rgba(255,255,255,.68); font-size:12px; pointer-events:none; white-space:nowrap; }
	`;
	document.head.appendChild(style);
}

function apiUrl(path) {
	try {
		return api?.apiURL ? api.apiURL(path) : path;
	} catch (_) {
		return path;
	}
}

function stopGraphEvent(event) {
	event.stopPropagation();
}

function protectElement(element) {
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu"]) {
		element.addEventListener(eventName, stopGraphEvent);
	}
}

function normalizeKind(kind) {
	const text = String(kind || "").trim().toLowerCase();
	if (["image", "图片"].includes(text) || text === "IMAGE".toLowerCase()) return "image";
	if (["audio", "音频"].includes(text) || text === "AUDIO".toLowerCase()) return "audio";
	if (["video", "视频"].includes(text) || text === "VIDEO".toLowerCase()) return "video";
	return "";
}

function filenameFromText(value) {
	const text = String(value || "").trim();
	if (!text) return "";
	try {
		const url = new URL(text, window.location.origin);
		if (url.pathname.endsWith("/view")) {
			return url.searchParams.get("filename") || "";
		}
		if (/^(?:https?:|blob:|data:)/i.test(text)) {
			return url.pathname.split("/").pop() || text;
		}
	} catch (_) {}
	const cleaned = text
		.replace(/\s+\[(input|output|temp)\]$/i, "")
		.split(/[?#]/, 1)[0]
		.replace(/\\/g, "/");
	return cleaned.split("/").pop() || cleaned;
}

export function gjjDetectMediaKind(value, fallback = "") {
	const fallbackKind = normalizeKind(fallback);
	const source =
		value && typeof value === "object"
			? String(value.media_type || value.kind || value.type_hint || value.filename || value.url || "")
			: String(value || "");
	const filename = filenameFromText(source).toLowerCase();
	const ext = filename.includes(".") ? filename.split(".").pop() : "";
	if (IMAGE_EXTS.has(ext)) return "image";
	if (AUDIO_EXTS.has(ext)) return "audio";
	if (VIDEO_EXTS.has(ext)) return "video";
	return fallbackKind || "";
}

function parseViewUrl(text) {
	try {
		const url = new URL(text, window.location.origin);
		if (!url.pathname.endsWith("/view")) return null;
		return {
			filename: url.searchParams.get("filename") || "",
			type: url.searchParams.get("type") || "input",
			subfolder: url.searchParams.get("subfolder") || "",
		};
	} catch (_) {
		return null;
	}
}

function parseMediaReference(value) {
	const raw = String(value || "").trim();
	if (!raw) return {};
	const view = parseViewUrl(raw);
	if (view?.filename) return view;
	if (/^(?:blob:|data:|https?:\/\/)/i.test(raw)) return { url: raw, filename: filenameFromText(raw) };
	let text = raw.replace(/\\/g, "/");
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	let type = "input";
	if (annotated) {
		type = annotated[1].toLowerCase();
		text = text.slice(0, annotated.index).trim();
	}
	if (/^[A-Za-z]:\//.test(text) || text.startsWith("//")) {
		return {
			filename: filenameFromText(text),
			unservedPath: text,
		};
	}
	const parts = text.split("/").filter(Boolean);
	const first = String(parts[0] || "").toLowerCase();
	if (["input", "output", "temp"].includes(first)) {
		type = first;
		parts.shift();
	}
	const filename = parts.pop() || text;
	return {
		filename,
		type,
		subfolder: parts.join("/"),
	};
}

export function gjjMediaRefToViewUrl(value) {
	const parsed = parseMediaReference(value);
	if (parsed.url) return parsed.url;
	if (!parsed.filename || parsed.unservedPath) return "";
	const previewFormat =
		typeof app.getPreviewFormatParam === "function"
			? app.getPreviewFormatParam()
			: "";
	const randParam =
		typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return apiUrl(
		`/view?filename=${encodeURIComponent(parsed.filename)}&type=${encodeURIComponent(parsed.type || "input")}&subfolder=${encodeURIComponent(parsed.subfolder || "")}${previewFormat}${randParam}`,
	);
}

export function gjjMediaRefToItem(value, options = {}) {
	if (value && typeof value === "object" && (value.filename || value.url || value.empty)) {
		const kind = gjjDetectMediaKind(value, options.kind || value.kind);
		return {
			...value,
			kind,
			title: value.title || options.title || value.filename || KIND_LABELS[kind] || "媒体",
			description: value.description || options.description || "",
			emptyText: value.emptyText || options.emptyText || `无${KIND_LABELS[kind] || "媒体"}`,
		};
	}
	const text = String(value || "").trim();
	const kind = gjjDetectMediaKind(text, options.kind);
	const parsed = parseMediaReference(text);
	const title = options.title || parsed.filename || KIND_LABELS[kind] || "媒体";
	if (!text) {
		return {
			kind,
			title,
			empty: true,
			emptyText: options.emptyText || `无${KIND_LABELS[kind] || "媒体"}`,
			description: options.description || "",
		};
	}
	return {
		...parsed,
		kind,
		title,
		description: options.description || "",
		emptyText: options.emptyText || `无${KIND_LABELS[kind] || "媒体"}`,
	};
}

export function gjjMediaItemToUrl(item) {
	if (!item) return "";
	if (item.url) return String(item.url);
	if (item.filename) {
		const previewFormat =
			typeof app.getPreviewFormatParam === "function"
				? app.getPreviewFormatParam()
				: "";
		const randParam =
			typeof app.getRandParam === "function" ? app.getRandParam() : "";
		return apiUrl(
			`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "input")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
		);
	}
	return gjjMediaRefToViewUrl(item);
}

export function gjjNormalizeMediaItems(items, options = {}) {
	const source = Array.isArray(items) ? items : [items];
	return source.map((item) => gjjMediaRefToItem(item, options));
}

function mediaEmoji(kind) {
	if (kind === "audio") return "🎧";
	if (kind === "video") return "🎬";
	return "🖼️";
}

function compactText(text) {
	return String(text || "").replace(/\s+/g, " ").trim();
}

export function gjjStyleCompactAudioPlayer(player, height = GJJ_AUDIO_PLAYER_HEIGHT) {
	if (!player) return;
	const safeHeight = Math.max(20, Number(height) || GJJ_AUDIO_PLAYER_HEIGHT);
	player.style.cssText = [
		"width:100%",
		`height:${safeHeight}px`,
		`min-height:${safeHeight}px`,
		`max-height:${safeHeight}px`,
		"display:block",
		"border-radius:5px",
		"overflow:hidden",
	].join(";");
}

function getAudioWaveformContext() {
	if (audioWaveformContext) return audioWaveformContext;
	const AudioContextClass = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextClass) return null;
	audioWaveformContext = new AudioContextClass();
	return audioWaveformContext;
}

function decodeAudioForWaveform(audioUrl) {
	const key = String(audioUrl || "");
	if (!key) return Promise.reject(new Error("音频地址为空"));
	if (audioWaveformCache.has(key)) return audioWaveformCache.get(key);
	const promise = fetch(key)
		.then((response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return response.arrayBuffer();
		})
		.then((buffer) => {
			const context = getAudioWaveformContext();
			if (!context) throw new Error("当前浏览器不支持 AudioContext");
			return context.decodeAudioData(buffer.slice(0));
		})
		.catch((error) => {
			audioWaveformCache.delete(key);
			throw error;
		});
	audioWaveformCache.set(key, promise);
	if (audioWaveformCache.size > 24) {
		const firstKey = audioWaveformCache.keys().next().value;
		audioWaveformCache.delete(firstKey);
	}
	return promise;
}

function resizeWaveformCanvas(canvas, fallbackHeight = GJJ_AUDIO_WAVEFORM_HEIGHT) {
	const ratio = Math.max(1, window.devicePixelRatio || 1);
	const width = Math.max(180, Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 300));
	const height = Math.max(40, Math.floor(canvas.clientHeight || canvas.parentElement?.clientHeight || fallbackHeight));
	const pixelWidth = Math.floor(width * ratio);
	const pixelHeight = Math.floor(height * ratio);
	if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
		canvas.width = pixelWidth;
		canvas.height = pixelHeight;
	}
	const ctx = canvas.getContext("2d");
	if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	return { width, height, ctx };
}

function drawWaveformPlaceholder(canvas, text = "正在读取波形...", options = {}) {
	const { width, height, ctx } = resizeWaveformCanvas(canvas, options.height);
	if (!ctx) return;
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "#081015";
	ctx.fillRect(0, 0, width, height);
	ctx.strokeStyle = "rgba(255,255,255,0.07)";
	ctx.beginPath();
	ctx.moveTo(0, height / 2);
	ctx.lineTo(width, height / 2);
	ctx.stroke();
	ctx.fillStyle = "#8ea0a8";
	ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
	ctx.textBaseline = "middle";
	ctx.fillText(text, 12, height / 2);
}

function getWaveformPeaks(audioBuffer, columns) {
	const key = Math.max(1, Math.floor(columns || 1));
	let byWidth = audioWaveformPeaks.get(audioBuffer);
	if (!byWidth) {
		byWidth = new Map();
		audioWaveformPeaks.set(audioBuffer, byWidth);
	}
	if (byWidth.has(key)) return byWidth.get(key);

	const channelCount = Math.max(1, Math.min(2, audioBuffer.numberOfChannels || 1));
	const length = audioBuffer.length || 0;
	const samplesPerColumn = Math.max(1, Math.floor(length / key));
	const peaks = new Float32Array(key);
	for (let x = 0; x < key; x += 1) {
		const start = x * samplesPerColumn;
		const end = Math.min(length, start + samplesPerColumn);
		let peak = 0;
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
			const data = audioBuffer.getChannelData(channelIndex);
			for (let i = start; i < end; i += 1) {
				const value = Math.abs(data[i] || 0);
				if (value > peak) peak = value;
			}
		}
		peaks[x] = peak;
	}
	byWidth.set(key, peaks);
	if (byWidth.size > 8) {
		const firstKey = byWidth.keys().next().value;
		byWidth.delete(firstKey);
	}
	return peaks;
}

function drawDecodedWaveform(canvas, audioBuffer, player = null, options = {}) {
	const { width, height, ctx } = resizeWaveformCanvas(canvas, options.height);
	if (!ctx || !audioBuffer) return;
	const center = Math.round(height / 2);
	const usableHeight = Math.max(16, height - 18);
	const amp = usableHeight / 2;
	const columns = Math.max(1, Math.floor(width));
	const peaks = getWaveformPeaks(audioBuffer, columns);

	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "#081015";
	ctx.fillRect(0, 0, width, height);

	ctx.strokeStyle = "rgba(255,255,255,0.06)";
	ctx.lineWidth = 1;
	for (let i = 1; i < 4; i += 1) {
		const y = Math.round((height * i) / 4);
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
		ctx.stroke();
	}

	const gradient = ctx.createLinearGradient(0, 0, width, 0);
	gradient.addColorStop(0, "#77d4c4");
	gradient.addColorStop(0.55, "#b7e28b");
	gradient.addColorStop(1, "#f1ca73");
	ctx.strokeStyle = gradient;
	ctx.lineWidth = 1;

	for (let x = 0; x < columns; x += 1) {
		const peak = peaks[x] || 0;
		const bar = Math.max(1, Math.min(amp, peak * amp));
		ctx.beginPath();
		ctx.moveTo(x + 0.5, center - bar);
		ctx.lineTo(x + 0.5, center + bar);
		ctx.stroke();
	}

	if (player && Number.isFinite(player.duration) && player.duration > 0) {
		const progress = Math.max(0, Math.min(1, Number(player.currentTime || 0) / player.duration));
		const cursorX = Math.round(progress * width) + 0.5;
		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(cursorX, 5);
		ctx.lineTo(cursorX, height - 5);
		ctx.stroke();
	}
}

export function gjjRenderAudioWaveformPreview(parent, audioUrl, player = null, options = {}) {
	ensureStyle();
	if (!parent) return null;
	const height = Math.max(40, Number(options.height || GJJ_AUDIO_WAVEFORM_HEIGHT) || GJJ_AUDIO_WAVEFORM_HEIGHT);
	const wrap = document.createElement("div");
	wrap.className = ["gjj-common-audio-waveform", options.className || ""].filter(Boolean).join(" ");
	wrap.style.setProperty("--gjj-audio-waveform-height", `${height}px`);
	wrap.title = options.title || "点击波形可跳转播放位置";
	protectElement(wrap);

	const canvas = document.createElement("canvas");
	wrap.appendChild(canvas);
	parent.appendChild(wrap);

	let decodedBuffer = null;
	const redraw = () => {
		if (decodedBuffer) drawDecodedWaveform(canvas, decodedBuffer, player, { height });
		else drawWaveformPlaceholder(canvas, options.loadingText || "正在读取波形...", { height });
	};

	drawWaveformPlaceholder(canvas, options.loadingText || "正在读取波形...", { height });
	decodeAudioForWaveform(audioUrl)
		.then((audioBuffer) => {
			decodedBuffer = audioBuffer;
			drawDecodedWaveform(canvas, decodedBuffer, player, { height });
			options.onLayout?.();
		})
		.catch((error) => {
			console.warn(options.loggerPrefix || "[GJJ CommonMedia]", "绘制音频波形失败:", error);
			drawWaveformPlaceholder(canvas, options.errorText || "波形解码失败，仍可使用播放条", { height });
			options.onLayout?.();
		});

	if (player) {
		player.addEventListener("timeupdate", redraw);
		player.addEventListener("seeked", redraw);
		player.addEventListener("loadedmetadata", redraw);
	}
	wrap.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (!player || !decodedBuffer || !Number.isFinite(player.duration) || player.duration <= 0) return;
		const rect = wrap.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
		player.currentTime = ratio * player.duration;
		drawDecodedWaveform(canvas, decodedBuffer, player, { height });
	});
	if (window.ResizeObserver) {
		const observer = new ResizeObserver(redraw);
		observer.observe(wrap);
	}
	requestAnimationFrame(redraw);
	return { wrap, canvas, redraw };
}

async function openMediaFolder(item, button) {
	if (!item?.filename && !item?.subfolder) return;
	const params = new URLSearchParams();
	params.set("type", item.type || "input");
	params.set("subfolder", item.subfolder || "");
	params.set("filename", item.filename || "");
	const oldText = button?.textContent || "📁";
	const endpoints = [
		`${GJJ_COMMON_MEDIA_OPEN_FOLDER_API}?${params.toString()}`,
		`/gjj/any_preview/open_media_folder?${params.toString()}`,
	];
	try {
		if (button) {
			button.disabled = true;
			button.textContent = "…";
		}
		let lastError = null;
		for (const endpoint of endpoints) {
			try {
				const response = await api.fetchApi(endpoint, { method: "POST" });
				if (response.ok) return;
				lastError = new Error(await response.text().catch(() => `HTTP ${response.status}`));
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError || new Error("打开目录失败");
	} catch (error) {
		console.warn("[GJJ CommonMedia] 打开所在目录失败:", error);
		if (button) button.title = `打开所在目录失败：${error?.message || error}`;
	} finally {
		if (button) {
			button.disabled = false;
			button.textContent = oldText;
		}
	}
}

function createInfoRow(item) {
	const row = document.createElement("div");
	row.className = "gjj-common-media-info";

	const icon = document.createElement("span");
	icon.textContent = mediaEmoji(item.kind);

	const main = document.createElement("div");
	main.className = "gjj-common-media-info-main";
	const title = document.createElement("span");
	title.className = "gjj-common-media-info-title";
	title.textContent = item.filename || item.title || KIND_LABELS[item.kind] || "媒体";
	title.title = title.textContent;
	const metaText = compactText(item.description);
	const meta = document.createElement("span");
	meta.className = "gjj-common-media-info-meta";
	meta.textContent = metaText ? ` · ${metaText}` : "";
	main.append(title, meta);

	const folder = document.createElement("button");
	folder.type = "button";
	folder.className = "gjj-common-media-folder";
	folder.textContent = "📁";
	folder.title = "打开所在目录";
	protectElement(folder);
	folder.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openMediaFolder(item, folder);
	});

	row.append(icon, main, folder);
	return row;
}

function addBadge(parent, text, className = "gjj-common-media-badge") {
	if (!String(text || "").trim()) return null;
	const badge = document.createElement("div");
	badge.className = className;
	badge.textContent = text;
	parent.appendChild(badge);
	return badge;
}

export function gjjOpenMediaBrowser(item) {
	ensureStyle();
	const url = gjjMediaItemToUrl(item);
	if (!url) return;
	const overlay = document.createElement("div");
	overlay.className = "gjj-common-media-browser";
	protectElement(overlay);

	const bar = document.createElement("div");
	bar.className = "gjj-common-media-browser-bar";
	const title = document.createElement("div");
	title.className = "gjj-common-media-browser-title";
	title.textContent = [item.title, item.filename].filter(Boolean).join(" · ") || KIND_LABELS[item.kind] || "媒体预览";
	const actions = document.createElement("div");
	actions.className = "gjj-common-media-browser-actions";
	const folder = document.createElement("button");
	folder.type = "button";
	folder.textContent = "📁 所在目录";
	folder.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openMediaFolder(item, folder);
	});
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "关闭";
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		overlay.remove();
	});
	actions.append(folder, close);
	bar.append(title, actions);

	const content = document.createElement("div");
	content.className = "gjj-common-media-browser-content";
	let element;
	if (item.kind === "video") {
		element = document.createElement("video");
		element.controls = true;
		element.autoplay = true;
		element.src = url;
	} else if (item.kind === "audio") {
		const audioWrap = document.createElement("div");
		audioWrap.style.cssText = "width:min(720px,86vw);display:flex;flex-direction:column;gap:10px;";
		element = document.createElement("audio");
		element.controls = true;
		element.autoplay = true;
		element.src = url;
		gjjStyleCompactAudioPlayer(element, 28);
		gjjRenderAudioWaveformPreview(audioWrap, url, element, {
			height: 96,
			loggerPrefix: "[GJJ CommonMedia]",
		});
		audioWrap.appendChild(element);
		content.appendChild(audioWrap);
	} else {
		element = document.createElement("img");
		element.src = url;
		let scale = 1;
		overlay.addEventListener("wheel", (event) => {
			event.preventDefault();
			event.stopPropagation();
			scale = Math.max(0.1, Math.min(10, scale + (event.deltaY > 0 ? -0.1 : 0.1)));
			element.style.transform = `scale(${scale})`;
		});
		element.addEventListener("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
			scale = 1;
			element.style.transform = "scale(1)";
		});
	}
	protectElement(element);
	if (item.kind !== "audio") {
		content.appendChild(element);
	}

	const hint = document.createElement("div");
	hint.className = "gjj-common-media-browser-hint";
	hint.textContent = item.kind === "image" ? "滚轮缩放 · 点击任意位置关闭" : "点击任意位置关闭";

	overlay.append(bar, content, hint);
	overlay.addEventListener("click", (event) => {
		if (event.target?.closest?.(".gjj-common-media-browser-actions button")) return;
		overlay.remove();
	});
	document.body.appendChild(overlay);
}

function createMediaElement(item, isSingle, options = {}) {
	const onLayout = options.onLayout;
	const previewItem = item?.preview_filename
		? {
			...item,
			url: "",
			filename: item.preview_filename,
			subfolder: item.preview_subfolder || item.subfolder || "",
			type: item.preview_type || item.type || "temp",
		}
		: item;
	const url = gjjMediaItemToUrl(previewItem);
	const stage = document.createElement("div");
	stage.className = `gjj-common-media-stage gjj-common-media-${item.kind || "image"}-stage`;
	if (!url) {
		const empty = document.createElement("div");
		empty.className = "gjj-common-media-empty";
		empty.textContent = item.unservedPath
			? "本地绝对路径需要先用 📁 复制到 ComfyUI input 后才能预览"
			: (item.emptyText || "无媒体");
		stage.appendChild(empty);
		return stage;
	}
	if (item.kind === "video") {
		const video = document.createElement("video");
		video.src = url;
		video.preload = "metadata";
		video.controls = isSingle;
		if (!isSingle) {
			video.muted = true;
			video.loop = true;
			video.playsInline = true;
			video.autoplay = true;
			video.addEventListener("canplay", () => {
				const promise = video.play?.();
				if (promise?.catch) promise.catch(() => {});
			}, { once: true });
		}
		video.addEventListener("loadedmetadata", () => onLayout?.());
		stage.appendChild(video);
		return stage;
	}
	if (item.kind === "audio") {
		const audio = document.createElement("audio");
		audio.controls = true;
		audio.src = url;
		audio.preload = "metadata";
		gjjRenderAudioWaveformPreview(stage, url, audio, {
			onLayout,
			loggerPrefix: "[GJJ CommonMedia]",
		});
		audio.addEventListener("loadedmetadata", () => onLayout?.());
		stage.appendChild(audio);
		return stage;
	}
	const image = document.createElement("img");
	image.src = url;
	image.draggable = Boolean(options.enableAnyPreviewDrag && item?.filename);
	if (image.draggable) {
		image.title = options.anyPreviewDragTitle || "拖到空白画布可创建 GJJ_AnyPreview；也可拖到已有 GJJ_AnyPreview。";
		image.addEventListener("dragstart", (event) => {
			if (!event.dataTransfer) return;
			const remoteUrl = /^(?:https?:|blob:|data:)/i.test(String(item.url || "")) ? String(item.url) : "";
			const payload = {
				filename: String(item.filename),
				subfolder: String(item.subfolder || ""),
				type: String(item.type || "input"),
				media_type: "image",
				...(remoteUrl ? { preview_url: remoteUrl } : {}),
			};
			event.dataTransfer.effectAllowed = "copy";
			event.dataTransfer.setData(GJJ_ANY_PREVIEW_MEDIA_DRAG_MIME, JSON.stringify(payload));
			event.dataTransfer.setData("text/plain", String(item.filename));
		});
	}
	image.addEventListener("load", () => onLayout?.());
	image.addEventListener("error", () => onLayout?.());
	stage.appendChild(image);
	return stage;
}

function appendMediaAction(card, item, index, total, options) {
	if (typeof options.renderGridAction !== "function") return false;
	const action = options.renderGridAction(item, index, total);
	if (!action) return false;
	action.classList.add("gjj-common-media-grid-action");
	protectElement(action);
	card.appendChild(action);
	return true;
}

function createMediaCard(item, index, total, options) {
	const isSingle = !options.forceGrid && total <= 1;
	const gridCaptionText = !isSingle && typeof options.gridCaption === "function"
		? compactText(options.gridCaption(item, index, total))
		: "";
	const card = document.createElement("div");
	card.className = `gjj-common-media-card ${isSingle ? "gjj-common-media-card-single" : "gjj-common-media-card-grid"}${gridCaptionText ? " gjj-common-media-card-grid-caption" : ""}`;
	protectElement(card);
	const decoratedEmpty = item.empty && (options.forceGrid || typeof options.renderGridAction === "function" || typeof options.gridCaption === "function");
	if (item.empty && !decoratedEmpty) {
		const empty = document.createElement("div");
		empty.className = "gjj-common-media-empty";
		empty.textContent = item.emptyText || "无媒体";
		card.appendChild(empty);
		return card;
	}

	const stage = createMediaElement(item, isSingle, options);
	card.appendChild(stage);
	const hasAction = appendMediaAction(card, item, index, total, options);
	if (hasAction && isSingle) {
		const action = card.querySelector(".gjj-common-media-grid-action");
		action?.classList.add("gjj-common-media-single-action");
	}
	if (!isSingle) {
		addBadge(card, total > 1 ? `${index + 1}` : "");
		if (!hasAction && options.showGridKindBadge !== false) {
			addBadge(card, KIND_LABELS[item.kind] || "媒体", "gjj-common-media-size");
		}
		if (gridCaptionText) {
			const caption = document.createElement("div");
			caption.className = "gjj-common-media-grid-caption-text";
			caption.textContent = gridCaptionText;
			caption.title = gridCaptionText;
			card.appendChild(caption);
		}
	} else {
		card.appendChild(createInfoRow(item));
	}
	card.addEventListener("click", (event) => {
		if (event.target?.closest?.("button,audio,video")) return;
		event.preventDefault();
		event.stopPropagation();
		gjjOpenMediaBrowser(item);
	});
	return card;
}

export function gjjSetMediaPreviewMessage(container, text, options = {}) {
	ensureStyle();
	if (!container) return;
	container.classList.add("gjj-common-media-preview");
	container.style.display = "block";
	container.style.width = "100%";
	container.replaceChildren();
	const message = document.createElement("div");
	message.className = `gjj-common-media-message${options.isError ? " gjj-common-media-message-error" : ""}`;
	message.textContent = String(text || "");
	container.appendChild(message);
}

export function gjjRenderMediaPreview(container, items, options = {}) {
	ensureStyle();
	if (!container) return;
	const normalized = gjjNormalizeMediaItems(items, options);
	const useGrid = Boolean(options.forceGrid) || normalized.length > 1;
	container.classList.add("gjj-common-media-preview");
	container.classList.toggle("gjj-common-media-grid", useGrid);
	container.style.display = useGrid ? "grid" : "block";
	container.style.width = "100%";
	container.style.minWidth = "0";
	container.style.setProperty("--gjj-media-single-min", `${Number(options.singleMinHeight || 168)}px`);
	container.style.setProperty("--gjj-media-single-max", `${Number(options.singleMaxHeight || 360)}px`);
	container.style.setProperty("--gjj-media-tile-min", `${Number(options.tileMinWidth || 118)}px`);
	container.style.setProperty("--gjj-media-tile-height", `${Number(options.tileMinHeight || 108)}px`);
	container.replaceChildren();
	if (!normalized.length) {
		gjjSetMediaPreviewMessage(container, options.emptyText || "无媒体");
		return;
	}
	for (const [index, item] of normalized.entries()) {
		container.appendChild(createMediaCard(item, index, normalized.length, options));
	}
	options.onLayout?.();
}

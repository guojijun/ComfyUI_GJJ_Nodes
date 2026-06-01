import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

export const GJJ_COMMON_MEDIA_OPEN_FOLDER_API = "/gjj/common/open_media_folder";

const STYLE_ID = "gjj-common-media-preview-style";
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif", "tiff"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus", "aiff", "aif"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi", "flv", "mpeg", "mpg", "m4v", "wmv"]);

const KIND_LABELS = {
	image: "图片",
	audio: "音频",
	video: "视频",
};

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
		.gjj-common-media-stage { position:relative; width:100%; min-width:0; overflow:hidden; border-radius:6px; background:#081015; display:flex; align-items:center; justify-content:center; }
		.gjj-common-media-card-single .gjj-common-media-stage { min-height:var(--gjj-media-single-min, 168px); max-height:var(--gjj-media-single-max, 360px); }
		.gjj-common-media-card-grid .gjj-common-media-stage { position:absolute; inset:0; border-radius:0; }
		.gjj-common-media-card img, .gjj-common-media-card video { width:100%; height:100%; display:block; background:#081015; }
		.gjj-common-media-card-single img, .gjj-common-media-card-single video { object-fit:contain; max-height:var(--gjj-media-single-max, 360px); }
		.gjj-common-media-card-grid img, .gjj-common-media-card-grid video { object-fit:cover; }
		.gjj-common-media-card-grid video { pointer-events:none; }
		.gjj-common-media-audio-stage { min-height:78px; background:linear-gradient(135deg, #101b20, #0b1216); }
		.gjj-common-media-card-single .gjj-common-media-audio-stage { flex-direction:column; gap:8px; padding:10px; }
		.gjj-common-media-audio-icon { font-size:34px; opacity:.9; }
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
		element = document.createElement("audio");
		element.controls = true;
		element.autoplay = true;
		element.src = url;
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
	content.appendChild(element);

	const hint = document.createElement("div");
	hint.className = "gjj-common-media-browser-hint";
	hint.textContent = item.kind === "image" ? "滚轮缩放 · 双击重置 · 点击空白关闭" : "点击空白关闭";

	overlay.append(bar, content, hint);
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay || event.target === content) overlay.remove();
	});
	document.body.appendChild(overlay);
}

function createMediaElement(item, isSingle, onLayout) {
	const url = gjjMediaItemToUrl(item);
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
		const icon = document.createElement("div");
		icon.className = "gjj-common-media-audio-icon";
		icon.textContent = "🎧";
		stage.appendChild(icon);
		const audio = document.createElement("audio");
		audio.controls = true;
		audio.src = url;
		audio.preload = "metadata";
		audio.addEventListener("loadedmetadata", () => onLayout?.());
		stage.appendChild(audio);
		return stage;
	}
	const image = document.createElement("img");
	image.src = url;
	image.draggable = false;
	image.addEventListener("load", () => onLayout?.());
	image.addEventListener("error", () => onLayout?.());
	stage.appendChild(image);
	return stage;
}

function createMediaCard(item, index, total, options) {
	const isSingle = total <= 1;
	const card = document.createElement("div");
	card.className = `gjj-common-media-card ${isSingle ? "gjj-common-media-card-single" : "gjj-common-media-card-grid"}`;
	protectElement(card);
	if (item.empty) {
		const empty = document.createElement("div");
		empty.className = "gjj-common-media-empty";
		empty.textContent = item.emptyText || "无媒体";
		card.appendChild(empty);
		return card;
	}

	const stage = createMediaElement(item, isSingle, options.onLayout);
	card.appendChild(stage);
	if (!isSingle) {
		addBadge(card, total > 1 ? `${index + 1}` : "");
		addBadge(card, KIND_LABELS[item.kind] || "媒体", "gjj-common-media-size");
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
	container.classList.add("gjj-common-media-preview");
	container.classList.toggle("gjj-common-media-grid", normalized.length > 1);
	container.style.display = normalized.length > 1 ? "grid" : "block";
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

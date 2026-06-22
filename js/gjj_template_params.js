
/* =========================
   GJJ MEDIA V2 PATCH
   ========================= */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
	gjjDetectMediaKind,
	gjjMediaRefToItem,
	gjjRenderMediaPreview,
	gjjSetMediaPreviewMessage,
} from "./gjj_common_media_preview.js";

const MEDIA_COPY_SUBDIR = "GJJ_TemplateParams";

function detectMediaType(value) {
	const kind = gjjDetectMediaKind(value);
	return kind ? kind.toUpperCase() : null;
}

function updatePreview(preview, value, isImage, isAudio, isVideo, directUrl = null, options = {}) {
	if (!preview) return;
	const kind = isImage ? "image" : isAudio ? "audio" : isVideo ? "video" : gjjDetectMediaKind(value);
	const item = gjjMediaRefToItem(value, {
		kind,
		title: options.title || "媒体预览",
		description: options.description || "",
		emptyText: kind === "image" ? "无图片" : kind === "video" ? "无视频" : kind === "audio" ? "无音频" : "无媒体",
	});
	if (directUrl) item.url = directUrl;
	gjjRenderMediaPreview(preview, [item], {
		singleMinHeight: kind === "audio" ? 78 : 168,
		singleMaxHeight: kind === "video" ? 300 : 360,
		tileMinHeight: 108,
		onLayout: options.onLayout,
	});
}

function setPreviewMessage(preview, text, isError = false) {
	if (!preview) return;
	gjjSetMediaPreviewMessage(preview, text, { isError });
}

function isMediaType(type) {
	return type === "IMAGE" || type === "AUDIO" || type === "VIDEO";
}

function mediaTypeFromField(field, value = null) {
	const detected = detectMediaType(String(value ?? ""));
	if (detected) return detected;
	return isMediaType(field?.type) ? field.type : null;
}

function mediaFlags(mediaType) {
	return {
		isImage: mediaType === "IMAGE",
		isAudio: mediaType === "AUDIO",
		isVideo: mediaType === "VIDEO",
	};
}

function mediaPreviewClass(mediaType) {
	if (mediaType === "VIDEO") return "gjj-template-param-preview-video";
	if (mediaType === "AUDIO") return "gjj-template-param-preview-audio";
	return "gjj-template-param-preview-image";
}

function getPreviewForField(node, key, row = null) {
	const preview = node?.__gjjTemplateParamsPreviewMap?.get(String(key || ""));
	if (preview) return preview;
	return row?.querySelector?.(
		".gjj-template-param-preview-image, .gjj-template-param-preview-audio, .gjj-template-param-preview-video"
	) || null;
}

function mediaItemForField(node, field, values) {
	const value = String(values?.[field.key] ?? field.default ?? "");
	const displayValue = String(node?.__gjjTemplateParamsNetworkDisplay?.get?.(String(field.key || "")) || value);
	const mediaType = mediaTypeFromField(field, value) || field.type;
	const kind = String(mediaType || "").toLowerCase();
	const item = gjjMediaRefToItem(displayValue, {
		kind,
		title: field.label || "媒体",
		description: field.tooltip || "",
		emptyText: kind === "image" ? "无图片" : kind === "video" ? "无视频" : kind === "audio" ? "无音频" : "无媒体",
	});
	item.templateFieldKey = String(field.key || "");
	item.templateFieldLabel = String(field.label || "");
	item.templateFieldTooltip = String(field.tooltip || "");
	item.templateMediaType = mediaType;
	return item;
}

function renderGroupedMediaPreview(node, fields = null, values = null) {
	const group = node?.__gjjTemplateParamsMediaGroup;
	if (!group) return false;
	const state = fields && values ? { fields, values } : normalizeState(node);
	const mediaFields = state.fields.filter((field) => isMediaType(field?.type));
	const items = mediaFields.map((field) => mediaItemForField(node, field, state.values));
	gjjRenderMediaPreview(group, items, {
		forceGrid: items.length > 1,
		singleMinHeight: 168,
		singleMaxHeight: 360,
		tileMinWidth: 118,
		tileMinHeight: 112,
		showGridKindBadge: false,
		gridCaption: (item) => templateMediaCaption(item),
		renderGridAction: (item) => makeMediaReplaceButton(node, item),
		onLayout: () => refreshNode(node),
	});
	refreshNode(node);
	return true;
}

function updatePreviewForField(node, field, value, row = null, directUrl = null) {
	const mediaType = mediaTypeFromField(field, value);
	if (!mediaType) return;
	if (node?.__gjjTemplateParamsMediaGroup) {
		renderGroupedMediaPreview(node);
		return;
	}
	const preview = getPreviewForField(node, field?.key, row);
	if (!preview) return;
	const flags = mediaFlags(mediaType);
	preview.classList.remove(
		"gjj-template-param-preview-image",
		"gjj-template-param-preview-audio",
		"gjj-template-param-preview-video",
	);
	preview.classList.add(mediaPreviewClass(mediaType));
	updatePreview(preview, String(value ?? ""), flags.isImage, flags.isAudio, flags.isVideo, directUrl, {
		title: field?.label || "媒体",
		description: field?.tooltip || "",
		onLayout: () => refreshNode(node),
	});
	refreshNode(node);
}

function eventNodeId(event) {
	return String(
		event?.detail?.node_id
			?? event?.detail?.node
			?? event?.detail?.display_node
			?? event?.detail?.nodeId
			?? "",
	);
}

function findTemplateParamsNode(nodeId) {
	if (!nodeId) return null;
	return app.graph?.getNodeById?.(Number(nodeId))
		|| app.graph?._nodes?.find((node) => String(node?.id || "") === String(nodeId))
		|| null;
}

function normalizeWarningList(payload) {
	const raw = payload?.[WARNINGS_UI_KEY];
	if (Array.isArray(raw)) {
		return raw.flatMap((item) => Array.isArray(item) ? item : [item])
			.map((item) => String(item || "").trim())
			.filter(Boolean);
	}
	const text = String(raw || "").trim();
	return text ? [text] : [];
}

function normalizeWarningMessages(warnings = []) {
	return Array.isArray(warnings)
		? warnings.map((item) => String(item || "").trim()).filter(Boolean)
		: [];
}

function renderWarningMessages(node) {
	const notice = node?.__gjjTemplateParamsWarning;
	if (!notice) return;
	const backendWarnings = normalizeWarningMessages(node.__gjjTemplateParamsBackendWarnings || []);
	const networkWarnings = Array.from(node.__gjjTemplateParamsNetworkWarnings?.values?.() || [])
		.map((item) => String(item || "").trim())
		.filter(Boolean);
	const list = [...backendWarnings, ...networkWarnings];
	if (!list.length) {
		notice.textContent = "";
		notice.style.display = "none";
		refreshNode(node);
		return;
	}
	notice.textContent = `⚠ ${list.join("\n")}`;
	notice.style.display = "block";
	refreshNode(node);
}

function setWarningMessages(node, warnings = []) {
	if (!node) return;
	node.__gjjTemplateParamsBackendWarnings = normalizeWarningMessages(warnings);
	renderWarningMessages(node);
}

function setNetworkWarningMessage(node, field, message = "") {
	if (!node) return;
	node.__gjjTemplateParamsNetworkWarnings = node.__gjjTemplateParamsNetworkWarnings || new Map();
	const key = String(field?.key || field?.label || "media");
	const text = String(message || "").trim();
	if (text) node.__gjjTemplateParamsNetworkWarnings.set(key, text);
	else node.__gjjTemplateParamsNetworkWarnings.delete(key);
	renderWarningMessages(node);
}

function setNetworkMediaDisplayPath(node, field, value = "") {
	if (!node) return;
	node.__gjjTemplateParamsNetworkDisplay = node.__gjjTemplateParamsNetworkDisplay || new Map();
	const key = String(field?.key || "");
	if (!key) return;
	const text = String(value || "").trim();
	if (text) node.__gjjTemplateParamsNetworkDisplay.set(key, text);
	else node.__gjjTemplateParamsNetworkDisplay.delete(key);
}

function setNetworkMediaMapping(node, field, originalUrl = "", localPath = "") {
	if (!node) return;
	node.__gjjTemplateParamsNetworkMappings = node.__gjjTemplateParamsNetworkMappings || new Map();
	const key = String(field?.key || "");
	if (!key) return;
	const url = String(originalUrl || "").trim();
	const path = normalizeMediaPathForCompare(localPath);
	if (url && path) node.__gjjTemplateParamsNetworkMappings.set(key, { url, path });
	else node.__gjjTemplateParamsNetworkMappings.delete(key);
}

function networkMediaMapping(node, field) {
	const key = String(field?.key || "");
	return key ? node?.__gjjTemplateParamsNetworkMappings?.get?.(key) || null : null;
}

function selectedFilePath(file) {
	return String(file?.path || file?.webkitRelativePath || file?.name || "").trim();
}

function mediaRefToViewUrl(value) {
	let text = String(value || "").trim().replace(/\\/g, "/");
	if (/^(?:blob:|data:|https?:\/\/)/i.test(text)) return text;
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	let mediaRoot = "input";
	if (annotated) {
		mediaRoot = annotated[1].toLowerCase();
		text = text.slice(0, annotated.index).trim();
	}
	const parts = text.split("/").filter(Boolean);
	if (["input", "output", "temp"].includes(String(parts[0] || "").toLowerCase())) {
		mediaRoot = parts.shift().toLowerCase();
	}
	const filename = parts.pop() || text;
	const subfolder = parts.join("/");
	let url = "/view?filename=" + encodeURIComponent(filename) + "&type=" + encodeURIComponent(mediaRoot);
	if (subfolder) url += "&subfolder=" + encodeURIComponent(subfolder);
	return url;
}

function uploadUrl(path) {
	try {
		if (api?.apiURL) return api.apiURL(path);
	} catch (_) {}
	return path;
}

function normalizeUploadFilename(data, file, requestedSubfolder = "") {
	const filename = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
	if (!filename) return "";
	if (filename.includes("/")) return filename;
	const subfolder = String(data?.subfolder ?? requestedSubfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function firstExistingInputFilename(candidates = []) {
	const seen = new Set();
	for (const candidate of candidates) {
		const filename = String(candidate || "").trim().replace(/\\/g, "/");
		if (!filename || seen.has(filename)) continue;
		seen.add(filename);
		if (await inputFileExists(filename)) return filename;
	}
	return "";
}

async function uploadMediaToInput(file, subfolder = "") {
	const endpoints = ["/upload/image", "/api/upload/image"];
	let lastError = null;
	const cleanSubfolder = String(subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const requestedName = normalizeUploadFilename({ name: file?.name || "", subfolder: cleanSubfolder }, file, cleanSubfolder);

	for (const endpoint of endpoints) {
		const form = new FormData();
		// ComfyUI 的上传接口字段名叫 image，但可作为通用 input 文件上传使用。
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");
		if (cleanSubfolder) form.append("subfolder", cleanSubfolder);

		try {
			const response = api?.fetchApi && endpoint === "/upload/image"
				? await api.fetchApi(endpoint, { method: "POST", body: form })
				: await fetch(uploadUrl(endpoint), { method: "POST", body: form });
			if (!response?.ok) {
				let detail = "";
				try { detail = await response.text(); } catch (_) {}
				lastError = new Error(`上传失败：HTTP ${response?.status || "?"}${detail ? ` ${detail}` : ""}`);
				continue;
			}
			const data = await response.json().catch(() => ({}));
			const filename = normalizeUploadFilename(data, file, cleanSubfolder);
			if (!filename) throw new Error("上传成功但没有返回文件名");
			const existingName = await firstExistingInputFilename([filename, requestedName]);
			if (existingName) return existingName;
			lastError = new Error(`上传成功但 /view 无法读取：${filename}`);
		} catch (err) {
			lastError = err;
		}
	}

	throw lastError || new Error("上传失败：未知错误");
}

function isNetworkMediaUrl(value) {
	return /^https?:\/\//i.test(String(value || "").trim());
}

function safeMediaFilename(name, mediaType = "") {
	let text = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
	try { text = decodeURIComponent(text); } catch (_) {}
	text = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/^[ ._]+|[ ._]+$/g, "");
	if (!text) text = "downloaded_media";
	if (!/\.[A-Za-z0-9]{2,8}$/.test(text)) {
		const ext = mediaType === "IMAGE" ? ".png" : mediaType === "VIDEO" ? ".mp4" : mediaType === "AUDIO" ? ".wav" : "";
		text += ext;
	}
	return text;
}

function safeMediaSubdirPart(name) {
	let text = String(name || "");
	try { text = decodeURIComponent(text); } catch (_) {}
	text = text.replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, "_").trim().replace(/^[ ._]+|[ ._]+$/g, "");
	return (text || "network").slice(0, 72).replace(/[ ._]+$/g, "") || "network";
}

function filenameFromNetworkUrl(url, mediaType = "") {
	try {
		const parsed = new URL(String(url || "").trim(), window.location.href);
		return safeMediaFilename(parsed.pathname.split("/").pop() || "", mediaType);
	} catch (_) {
		return safeMediaFilename(String(url || "").split("?")[0], mediaType);
	}
}

async function shortSha1(text) {
	try {
		const subtle = globalThis.crypto?.subtle;
		if (subtle && globalThis.TextEncoder) {
			const digest = await subtle.digest("SHA-1", new TextEncoder().encode(String(text || "")));
			return Array.from(new Uint8Array(digest))
				.slice(0, 5)
				.map((value) => value.toString(16).padStart(2, "0"))
				.join("");
		}
	} catch (_) {}

	let hash = 2166136261;
	const source = String(text || "");
	for (let index = 0; index < source.length; index++) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 10);
}

async function networkMediaCachePath(url, mediaType = "") {
	const filename = filenameFromNetworkUrl(url, mediaType);
	try {
		const parsed = new URL(String(url || "").trim(), window.location.href);
		const pathParts = parsed.pathname
			.split("/")
			.map((part) => {
				try { return decodeURIComponent(part); } catch (_) { return part; }
			})
			.filter(Boolean);
		const sourceName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : (parsed.host || "network");
		const sourceDir = pathParts.slice(0, -1).join("/");
		let sourceKey = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}/${sourceDir}`;
		if (parsed.search) sourceKey += parsed.search;
		const digest = await shortSha1(sourceKey);
		const subfolder = `${MEDIA_COPY_SUBDIR}/${safeMediaSubdirPart(sourceName)}_${digest}`;
		return { filename, subfolder, relativePath: `${subfolder}/${filename}` };
	} catch (_) {
		const digest = await shortSha1(String(url || ""));
		const subfolder = `${MEDIA_COPY_SUBDIR}/network_${digest}`;
		return { filename, subfolder, relativePath: `${subfolder}/${filename}` };
	}
}

function splitInputRelativePath(filename) {
	let text = String(filename || "").trim().replace(/\\/g, "/");
	if (!text) return { filename: "", subfolder: "" };
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	if (annotated) text = text.slice(0, annotated.index).trim();
	const parts = text.split("/").filter(Boolean);
	if (["input", "output", "temp"].includes(String(parts[0] || "").toLowerCase())) parts.shift();
	const name = parts.pop() || "";
	return { filename: name, subfolder: parts.join("/") };
}

function normalizeMediaPathForCompare(value = "") {
	let text = String(value || "").trim().replace(/\\/g, "/");
	if (!text) return "";
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	if (annotated) text = text.slice(0, annotated.index).trim();
	const parts = text.split("/").filter(Boolean);
	if (["input", "output", "temp"].includes(String(parts[0] || "").toLowerCase())) parts.shift();
	return parts.join("/").toLowerCase();
}

function inputViewUrlForFilename(filename) {
	const parts = splitInputRelativePath(filename);
	let url = "/view?filename=" + encodeURIComponent(parts.filename) + "&type=input";
	if (parts.subfolder) url += "&subfolder=" + encodeURIComponent(parts.subfolder);
	return url;
}

async function inputFileExists(filename) {
	const url = uploadUrl(inputViewUrlForFilename(filename));
	try {
		let response = await fetch(url, { method: "HEAD", cache: "no-store" });
		if (response?.ok) return true;
		if (response?.status && response.status !== 405) return false;
		response = await fetch(url, { method: "GET", cache: "no-store" });
		return Boolean(response?.ok);
	} catch (_) {
		return false;
	}
}

async function localMediaExists(value, mediaType = "") {
	const text = String(value || "").trim();
	if (!text || isNetworkMediaUrl(text)) return false;
	const endpoint = "/gjj/template_params/media_exists";
	const options = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ value: text, media_type: mediaType }),
	};
	try {
		const response = api?.fetchApi
			? await api.fetchApi(endpoint, options)
			: await fetch(uploadUrl(endpoint), options);
		if (!response?.ok) return false;
		const data = await response.json().catch(() => ({}));
		return data?.exists === true;
	} catch (_) {
		return inputFileExists(text);
	}
}

function currentInputForField(node, field, fallback = null) {
	const current = node?.__gjjTemplateParamsRows?.get?.(String(field?.key || ""));
	if (current && "value" in current) return current;
	return fallback;
}

function currentFieldValue(node, field, values = null, input = null) {
	const current = currentInputForField(node, field, input);
	if (current && "value" in current) return String(current.value || "").trim();
	if (values && Object.prototype.hasOwnProperty.call(values, field?.key)) {
		return String(values[field.key] || "").trim();
	}
	return String(field?.default || "").trim();
}

async function remoteUrlForFieldIfActive(node, field, values = null, input = null) {
	const currentValue = currentFieldValue(node, field, values, input);
	const defaultValue = String(field?.default || "").trim();
	if (isNetworkMediaUrl(currentValue)) return currentValue;
	if (!isNetworkMediaUrl(defaultValue)) return "";
	if (!currentValue) return defaultValue;
	const cacheInfo = await networkMediaCachePath(defaultValue, mediaTypeFromField(field, defaultValue));
	const mappedPath = normalizeMediaPathForCompare(cacheInfo.relativePath);
	const currentPath = normalizeMediaPathForCompare(currentValue);
	const remembered = networkMediaMapping(node, field);
	if (currentPath && currentPath === mappedPath) return defaultValue;
	if (remembered?.url === defaultValue && currentPath && currentPath === remembered.path) return defaultValue;
	return await localMediaExists(currentValue, mediaTypeFromField(field, currentValue))
		? ""
		: defaultValue;
}

async function syncManualMediaMappingState(node, field, value = "") {
	const text = String(value || "").trim();
	const defaultValue = String(field?.default || "").trim();
	if (!isNetworkMediaUrl(defaultValue)) {
		setNetworkWarningMessage(node, field, "");
		setNetworkMediaDisplayPath(node, field, "");
		setNetworkMediaMapping(node, field, "", "");
		return "";
	}
	const cacheInfo = await networkMediaCachePath(defaultValue, mediaTypeFromField(field, defaultValue));
	if (normalizeMediaPathForCompare(text) === normalizeMediaPathForCompare(cacheInfo.relativePath)) {
		setNetworkMediaMapping(node, field, defaultValue, cacheInfo.relativePath);
		setNetworkMediaDisplayPath(node, field, cacheInfo.relativePath);
		setNetworkWarningMessage(node, field, "");
		return defaultValue;
	}
	setNetworkWarningMessage(node, field, "");
	setNetworkMediaDisplayPath(node, field, "");
	setNetworkMediaMapping(node, field, "", "");
	return "";
}

async function downloadNetworkMediaViaBackend(originalUrl, mediaType) {
	const endpoint = "/gjj/template_params/download_media";
	const body = JSON.stringify({ url: originalUrl, media_type: mediaType });
	const options = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	};
	const response = api?.fetchApi
		? await api.fetchApi(endpoint, options)
		: await fetch(uploadUrl(endpoint), options);
	if (!response?.ok) {
		let detail = "";
		try {
			const data = await response.json();
			detail = data?.error || JSON.stringify(data);
		} catch (_) {
			try { detail = await response.text(); } catch (_) {}
		}
		throw new Error(detail || `后端下载接口 HTTP ${response?.status || "?"}`);
	}
	const data = await response.json().catch(() => ({}));
	if (data?.ok === false || data?.error) {
		throw new Error(data?.error || "后端下载失败");
	}
	const filename = String(data?.filename || data?.name || "").trim();
	if (!filename) throw new Error("后端下载成功但没有返回文件名");
	return filename;
}

function mimeForMediaType(mediaType) {
	if (mediaType === "IMAGE") return "image/png";
	if (mediaType === "VIDEO") return "video/mp4";
	if (mediaType === "AUDIO") return "audio/wav";
	return "application/octet-stream";
}

async function downloadNetworkMediaInBrowser(originalUrl, mediaType, cacheInfo) {
	const response = await fetch(originalUrl, { cache: "no-store" });
	if (!response?.ok) {
		throw new Error(`浏览器下载 HTTP ${response?.status || "?"}`);
	}
	const blob = await response.blob();
	const filename = cacheInfo?.filename || filenameFromNetworkUrl(originalUrl, mediaType);
	const file = new File([blob], filename, { type: blob.type || mimeForMediaType(mediaType) });
	return uploadMediaToInput(file, cacheInfo?.subfolder || "");
}

function canvasExportFilename(filename = "") {
	const safe = safeMediaFilename(filename || "network_image.png", "IMAGE");
	return safe.replace(/\.[A-Za-z0-9]{2,8}$/i, ".png");
}

function imageToCanvasBlob(image) {
	const width = Number(image?.naturalWidth || image?.width || 0);
	const height = Number(image?.naturalHeight || image?.height || 0);
	if (!width || !height) throw new Error("图片尺寸为空，无法导出");
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("当前浏览器无法创建 canvas");
	ctx.drawImage(image, 0, 0, width, height);
	return new Promise((resolve, reject) => {
		try {
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new Error("canvas 导出为空，可能被跨域保护阻止"));
			}, "image/png");
		} catch (err) {
			reject(err);
		}
	});
}

async function downloadNetworkImageViaCanvas(originalUrl, cacheInfo) {
	const image = new Image();
	image.crossOrigin = "anonymous";
	image.referrerPolicy = "no-referrer";
	image.decoding = "async";
	const loaded = new Promise((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error("浏览器图片加载成功但跨域导出加载失败"));
	});
	image.src = originalUrl;
	await loaded;
	const blob = await imageToCanvasBlob(image);
	const filename = canvasExportFilename(cacheInfo?.filename || filenameFromNetworkUrl(originalUrl, "IMAGE"));
	const file = new File([blob], filename, { type: "image/png" });
	return uploadMediaToInput(file, cacheInfo?.subfolder || "");
}

async function uploadLoadedPreviewImage(image, originalUrl, cacheInfo) {
	if (!image || !image.complete || !Number(image.naturalWidth || 0) || !Number(image.naturalHeight || 0)) {
		throw new Error("预览图尚未加载完成");
	}
	const blob = await imageToCanvasBlob(image);
	const filename = canvasExportFilename(cacheInfo?.filename || filenameFromNetworkUrl(originalUrl, "IMAGE"));
	const file = new File([blob], filename, { type: "image/png" });
	return uploadMediaToInput(file, cacheInfo?.subfolder || "");
}

function saveFieldValue(node, field, values, nextValue) {
	if (values && typeof values === "object") values[field.key] = nextValue;
	const state = normalizeState(node);
	state.values[field.key] = nextValue;
	saveState(node, state.template, state.fields, state.values);
	updateOutputs(node, state.fields, state.values);
}

async function ensureNetworkMediaInInput(node, field, input, values, wrap = null) {
	input = currentInputForField(node, field, input);
	const originalUrl = await remoteUrlForFieldIfActive(node, field, values, input);
	if (!isNetworkMediaUrl(originalUrl)) return;
	const mediaType = mediaTypeFromField(field, originalUrl);
	if (!mediaType) return;

	node.__gjjTemplateParamsNetworkJobs = node.__gjjTemplateParamsNetworkJobs || new Map();
	const jobKey = `${field.key}\n${originalUrl}`;
	if (node.__gjjTemplateParamsNetworkJobs.has(jobKey)) return node.__gjjTemplateParamsNetworkJobs.get(jobKey);

	const job = (async () => {
		const cacheInfo = await networkMediaCachePath(originalUrl, mediaType);
		const filename = cacheInfo.relativePath;
		const row = wrap || input.closest?.(".gjj-template-param-row");
		const preview = getPreviewForField(node, field.key, row);
		const loadedPreviewImage = preview?.querySelector?.("img") || null;
		try {
			if (await inputFileExists(filename)) {
				const activeInput = currentInputForField(node, field, input);
				const activeUrl = await remoteUrlForFieldIfActive(node, field, values, activeInput);
				if (activeUrl !== originalUrl) return;
				const activeValue = String(activeInput?.value || "").trim();
				if (!isNetworkMediaUrl(activeValue)) {
					if (activeInput && "value" in activeInput) activeInput.value = filename;
					saveFieldValue(node, field, values, filename);
				}
				setNetworkMediaMapping(node, field, originalUrl, filename);
				setNetworkMediaDisplayPath(node, field, filename);
				updatePreviewForField(node, field, originalUrl, row, inputViewUrlForFilename(filename));
				setNetworkWarningMessage(node, field, "");
				return;
			}

			setPreviewMessage(preview, `正在下载到 ComfyUI input：${filename}`);
			let uploadedName = "";
			let backendError = null;
			try {
				uploadedName = await downloadNetworkMediaViaBackend(originalUrl, mediaType);
			} catch (backendErr) {
				backendError = backendErr;
				console.warn("[GJJ_TemplateParams] 后端下载网络媒体失败，改用浏览器上传:", backendErr);
				try {
					uploadedName = await downloadNetworkMediaInBrowser(originalUrl, mediaType, cacheInfo);
				} catch (browserErr) {
					if (mediaType === "IMAGE") {
						try {
							uploadedName = await uploadLoadedPreviewImage(loadedPreviewImage, originalUrl, cacheInfo);
						} catch (previewCanvasErr) {
							try {
								uploadedName = await downloadNetworkImageViaCanvas(originalUrl, cacheInfo);
							} catch (canvasErr) {
								const backendMessage = backendError?.message || backendError || "未知错误";
								const browserMessage = browserErr?.message || browserErr || "未知错误";
								const previewCanvasMessage = previewCanvasErr?.message || previewCanvasErr || "未知错误";
								const canvasMessage = canvasErr?.message || canvasErr || "未知错误";
								throw new Error(`后端下载失败：${backendMessage}；浏览器下载失败：${browserMessage}；预览图导出失败：${previewCanvasMessage}；画布导出失败：${canvasMessage}`);
							}
						}
					} else {
						const backendMessage = backendError?.message || backendError || "未知错误";
						const browserMessage = browserErr?.message || browserErr || "未知错误";
						throw new Error(`后端下载失败：${backendMessage}；浏览器下载失败：${browserMessage}`);
					}
				}
			}
			const activeInput = currentInputForField(node, field, input);
			const activeUrl = await remoteUrlForFieldIfActive(node, field, values, activeInput);
			if (activeUrl !== originalUrl) return;
			const activeValue = String(activeInput?.value || "").trim();
			if (!isNetworkMediaUrl(activeValue)) {
				if (activeInput && "value" in activeInput) activeInput.value = uploadedName;
				saveFieldValue(node, field, values, uploadedName);
			}
			setNetworkMediaMapping(node, field, originalUrl, uploadedName);
			setNetworkMediaDisplayPath(node, field, uploadedName);
			updatePreviewForField(node, field, originalUrl, row, inputViewUrlForFilename(uploadedName));
			setNetworkWarningMessage(node, field, "");
		} catch (err) {
			console.warn("[GJJ_TemplateParams] 网络媒体下载到 input 失败:", err);
			const activeInput = currentInputForField(node, field, input);
			const activeValue = String(activeInput?.value || "").trim();
			const activeUrl = await remoteUrlForFieldIfActive(node, field, values, activeInput);
			if (activeUrl !== originalUrl || (!isNetworkMediaUrl(activeValue) && !activeUrl)) {
				setNetworkWarningMessage(node, field, "");
				setNetworkMediaDisplayPath(node, field, "");
				updatePreviewForField(node, field, activeValue, row);
				return;
			}
			setNetworkWarningMessage(node, field, `${field?.label || "媒体"}：下载到 input 失败：${err?.message || err}`);
			setPreviewMessage(preview, `下载到 input 失败：${err?.message || err}`, true);
		}
	})();

	node.__gjjTemplateParamsNetworkJobs.set(jobKey, job);
	try {
		await job;
	} finally {
		node.__gjjTemplateParamsNetworkJobs?.delete(jobKey);
	}
}

function scheduleNetworkMediaToInput(node, field, input, values, wrap = null, delay = 450) {
	node.__gjjTemplateParamsNetworkTimers = node.__gjjTemplateParamsNetworkTimers || new Map();
	const key = String(field?.key || "");
	clearTimeout(node.__gjjTemplateParamsNetworkTimers.get(key));
	const timer = setTimeout(() => {
		remoteUrlForFieldIfActive(node, field, values, input).then((url) => {
			if (!isNetworkMediaUrl(url)) {
				setNetworkWarningMessage(node, field, "");
				setNetworkMediaDisplayPath(node, field, "");
				setNetworkMediaMapping(node, field, "", "");
				return;
			}
			ensureNetworkMediaInInput(node, field, input, values, wrap);
		});
	}, Math.max(0, Number(delay) || 0));
	node.__gjjTemplateParamsNetworkTimers.set(key, timer);
}

function compactMediaPathName(value = "") {
	const text = String(value || "").trim();
	if (!text) return "";
	try {
		const url = new URL(text, window.location.origin);
		if (url.pathname.endsWith("/view")) {
			return url.searchParams.get("filename") || "";
		}
		if (/^(?:https?:|blob:|data:)/i.test(text)) {
			return decodeURIComponent(url.pathname.split("/").pop() || text);
		}
	} catch (_) {}
	const cleaned = text
		.replace(/\s+\[(input|output|temp)\]$/i, "")
		.split(/[?#]/, 1)[0]
		.replace(/\\/g, "/");
	return cleaned.split("/").pop() || cleaned;
}

function templateMediaCaption(item) {
	const label = String(item?.templateFieldLabel || item?.title || "").trim();
	const name = compactMediaPathName(item?.filename || item?.url || item?.unservedPath || "");
	return [label, name].filter(Boolean).join(" · ") || "媒体";
}

function fieldByKey(node, key) {
	const state = normalizeState(node);
	const text = String(key || "");
	return state.fields.find((field) => String(field?.key || "") === text) || null;
}

function makeMediaReplaceButton(node, item) {
	const field = fieldByKey(node, item?.templateFieldKey);
	if (!field) return null;
	const state = normalizeState(node);
	const input = currentInputForField(node, field, null);
	if (!input) return null;
	const mediaType = mediaTypeFromField(field, input.value) || item?.templateMediaType || field.type;
	const flags = mediaFlags(mediaType);
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "📁";
	button.title = `更换${field.label || "媒体"}：选择新的${flags.isImage ? "图片" : flags.isVideo ? "视频" : "音频"}`;
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openFileDialog(node, field, input, state.values, flags.isImage, flags.isAudio, flags.isVideo, button);
	});
	return button;
}

function openFileDialog(node, field, input, values, isImage, isAudio, isVideo, triggerButton = null) {
	const inputElement = document.createElement("input");

	inputElement.type = "file";

	inputElement.accept = isImage
		? "image/*"
		: isVideo
			? "video/*,.mp4,.mov,.mkv,.webm,.avi,.flv,.mpeg,.mpg,.m4v,.wmv"
			: "audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus,.wma,.aiff,.aif";

	inputElement.addEventListener("change", async (event) => {
		const file = event.target.files?.[0];

		if (!file) return;

		const row = input.closest?.(".gjj-template-param-row") || null;
		const preview = getPreviewForField(node, field.key, row);
		const button = triggerButton || row?.querySelector(".gjj-template-param-file-button");
		const oldButtonText = button?.textContent || "📁";
		setPreviewMessage(preview, `正在复制到 ComfyUI input：${file.name}`);
		if (button) {
			button.disabled = true;
			button.textContent = "⏳";
			button.style.cursor = "wait";
		}

		try {
			const uploadedName = await uploadMediaToInput(file);
			input.value = uploadedName;
			values[field.key] = uploadedName;
			await syncManualMediaMappingState(node, field, uploadedName);

			const template = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
			const fields = parseTemplate(template);

			saveState(node, template, fields, values);
			updateOutputs(node, fields, values);

			updatePreviewForField(node, field, uploadedName, row);
		} catch (err) {
			console.error("[GJJ_TemplateParams] 打开媒体文件失败:", err);
			setPreviewMessage(preview, `打开失败：${err?.message || err}`, true);
		} finally {
			if (button) {
				button.disabled = false;
				button.textContent = oldButtonText;
				button.style.cursor = "pointer";
			}
		}
	});

	inputElement.click();
}

const TARGET_NODES = new Set(["GJJ_TemplateParams"]);
const TEMPLATE_WIDGET = "template_text";
const VALUES_WIDGET = "values_json";
const SCHEMA_WIDGET = "schema_json";
const DOM_WIDGET = "gjj_template_params_dom";
const WARNINGS_UI_KEY = "gjj_template_params_warnings";
const SAVED_TEMPLATE = "gjj_template_params_template";
const SAVED_VALUES = "gjj_template_params_values";
const SAVED_SCHEMA = "gjj_template_params_schema";
const SAVED_SIZE = "gjj_template_params_size";
const SAVED_TEXTAREA_HEIGHTS = "gjj_template_params_textarea_heights";
const BROADCAST_PROPERTY = "gjj_variable_broadcast_enabled";
const OUTPUTS_ENABLED_PROPERTY = "gjj_template_params_outputs_enabled";
const MAX_OUTPUTS = 64;
const DEFAULT_TEMPLATE = "帧率 (frame_rate) [INT,FLOAT]：8.0 # 每秒帧数\n时长 (duration) [INT,FLOAT]：5 # 秒数或帧数\n宽度（width）：512\n高度（height）：512\nLora加速（use_accel_lora）：true{开启加速|关闭加速} # 布尔按钮\n提示词（positive_text_input）:首尾帧\n首帧（start_image）：https://raw.githubusercontent.com/Comfy-Org/example_workflows/refs/heads/main/wan2.1_flf2v/input/start_image.png\n尾帧（end_image）：https://raw.githubusercontent.com/Comfy-Org/example_workflows/refs/heads/main/wan2.1_flf2v/input/end_image.png";
const DEFAULT_WIDTH = 300;
const MAX_EXTRA_IDLE_HEIGHT = 72;
const TEXTAREA_MIN_HEIGHT = 58;
const TEXTAREA_MAX_HEIGHT = 2400;

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function outputHasLinks(output) {
	if (!output) return false;
	if (Array.isArray(output.links)) return output.links.length > 0;
	return output.link != null;
}

function removeOutputLinks(node, output) {
	const graph = node?.graph || app.graph;
	for (const linkId of [...(output?.links || [])]) {
		try { graph?.removeLink?.(linkId); } catch (_) {}
		if (app.graph?.links && app.graph.links[linkId]) delete app.graph.links[linkId];
	}
	if (output) output.links = null;
}

function getGraphLink(node, linkId) {
	if (linkId == null) return null;
	const links = node?.graph?.links || app.graph?.links;
	if (!links) return null;
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function setOutputLinkSlot(link, nodeId, slot, type) {
	if (!link) return;
	if (Array.isArray(link)) {
		link[1] = nodeId;
		link[2] = slot;
		if (type) link[5] = type;
		return;
	}
	link.origin_id = nodeId;
	link.origin_slot = slot;
	if (type) link.type = type;
}

function repairOutputLinkSlots(node) {
	if (!Array.isArray(node?.outputs)) return;
	for (let index = 0; index < node.outputs.length; index += 1) {
		const output = node.outputs[index];
		for (const linkId of output?.links || []) {
			setOutputLinkSlot(getGraphLink(node, linkId), node.id, index, output.type);
		}
	}
}

function normalizeOutputMatchName(value) {
	return String(value ?? "").trim();
}

function takeOutputFromMap(map, key, used) {
	const list = map?.get?.(key);
	if (!Array.isArray(list)) return null;
	while (list.length) {
		const output = list.shift();
		if (output && !used.has(output)) {
			used.add(output);
			return output;
		}
	}
	return null;
}

function collectPreviousOutputs(outputs) {
	const byKey = new Map();
	const byName = new Map();
	for (const output of outputs || []) {
		const key = String(output?.gjj_template_param_key || "");
		if (key) {
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key).push(output);
		}
		const name = normalizeOutputMatchName(output?.name || output?.label || output?.localized_name);
		if (name) {
			if (!byName.has(name)) byName.set(name, []);
			byName.get(name).push(output);
		}
	}
	return { byKey, byName };
}

function resolvePreviousOutput(previous, field, index, used) {
	const key = String(field?.key || "");
	if (key) {
		const output = takeOutputFromMap(previous.byKey, key, used);
		if (output) return output;
	}
	const label = normalizeOutputMatchName(field?.label || "");
	if (label) {
		const output = takeOutputFromMap(previous.byName, label, used);
		if (output) return output;
	}
	const indexed = previous.outputs?.[index];
	if (indexed && !used.has(indexed)) {
		used.add(indexed);
		return indexed;
	}
	return null;
}

function getWidgetValue(node, name, fallback = "") {
	const widget = getWidget(node, name);
	return String(widget?.value ?? fallback ?? "");
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	const next = String(value ?? "");
	widget.value = next;
	if (widget.inputEl) widget.inputEl.value = next;
	if (widget.element && "value" in widget.element) widget.element.value = next;
	widget.callback?.(next);
}

function currentNodeWidth(node) {
	const width = Number(node?.size?.[0]);
	return Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_WIDTH;
}

function inputHasLink(input) {
	if (!input) return false;
	if (Array.isArray(input.link)) return input.link.length > 0;
	return input.link != null;
}

function pruneLegacyWidgetInputs(node) {
	if (!node || !Array.isArray(node.inputs)) return;
	node.inputs = node.inputs.filter((input) => {
		const name = String(input?.name || input?.widget?.name || "");
		const isHiddenWidgetInput = [TEMPLATE_WIDGET, VALUES_WIDGET, SCHEMA_WIDGET].includes(name) || Boolean(input?.widget);
		return !isHiddenWidgetInput || inputHasLink(input);
	});
}

function safeJsonParse(text, fallback) {
	try {
		const value = JSON.parse(String(text || ""));
		return value ?? fallback;
	} catch (_) {
		return fallback;
	}
}

function normalizeTextareaHeight(value) {
	const height = Number.parseFloat(value);
	if (!Number.isFinite(height)) return 0;
	return Math.min(TEXTAREA_MAX_HEIGHT, Math.max(TEXTAREA_MIN_HEIGHT, Math.round(height)));
}

function sanitizeTextareaHeights(raw) {
	let data = raw;
	if (typeof data === "string") data = safeJsonParse(data, {});
	if (!data || typeof data !== "object" || Array.isArray(data)) return {};
	const result = {};
	for (const [key, value] of Object.entries(data)) {
		const height = normalizeTextareaHeight(value);
		if (key && height) result[String(key)] = height;
	}
	return result;
}

function textareaHeightKeys(field) {
	const keys = [];
	const key = String(field?.key || "");
	const label = String(field?.label || "");
	if (key) keys.push(key);
	if (label) keys.push(`label:${label}`);
	return keys;
}

function ensureTextareaHeights(node) {
	node.properties = node.properties || {};
	const data = sanitizeTextareaHeights(node.properties[SAVED_TEXTAREA_HEIGHTS]);
	node.properties[SAVED_TEXTAREA_HEIGHTS] = data;
	return data;
}

function getSavedTextareaHeight(node, field) {
	const data = ensureTextareaHeights(node);
	for (const key of textareaHeightKeys(field)) {
		const height = normalizeTextareaHeight(data[key]);
		if (height) return height;
	}
	return 0;
}

function measureTextareaHeight(textarea) {
	if (!textarea) return 0;
	const rectHeight = Number(textarea.getBoundingClientRect?.().height || 0);
	return normalizeTextareaHeight(
		rectHeight
		|| Number(textarea.offsetHeight || 0)
		|| Number.parseFloat(textarea.style?.height || "0")
	);
}

function rememberTextareaHeight(node, field, textarea) {
	const height = measureTextareaHeight(textarea);
	if (!node || !field || !height) return;
	const data = ensureTextareaHeights(node);
	for (const key of textareaHeightKeys(field)) data[key] = height;
	node.properties[SAVED_TEXTAREA_HEIGHTS] = data;
}

function syncTextareaHeightsFromDom(node) {
	if (!node?.__gjjTemplateParamsRows) return;
	const data = ensureTextareaHeights(node);
	for (const [key, input] of node.__gjjTemplateParamsRows.entries()) {
		if (input?.tagName !== "TEXTAREA") continue;
		const height = measureTextareaHeight(input);
		if (!height) continue;
		data[String(key)] = height;
		const label = String(input.dataset?.gjjTemplateParamLabel || "");
		if (label) data[`label:${label}`] = height;
	}
	node.properties[SAVED_TEXTAREA_HEIGHTS] = sanitizeTextareaHeights(data);
}

function disconnectTextareaHeightObservers(node) {
	const observers = Array.isArray(node?.__gjjTemplateParamsTextareaObservers)
		? node.__gjjTemplateParamsTextareaObservers
		: [];
	for (const observer of observers) {
		try { observer.disconnect?.(); } catch (_) {}
	}
	if (node) node.__gjjTemplateParamsTextareaObservers = [];
}

function observeTextareaHeight(node, field, textarea) {
	if (!node || !field || !textarea) return;
	let pointerStartHeight = 0;
	let manualResizeArmed = false;
	textarea.addEventListener("pointerdown", () => {
		pointerStartHeight = measureTextareaHeight(textarea);
		manualResizeArmed = true;
	});
	if (typeof ResizeObserver !== "undefined") {
		const observer = new ResizeObserver(() => {
			if (manualResizeArmed) {
				rememberTextareaHeight(node, field, textarea);
				refreshNode(node, { resize: false });
			}
		});
		observer.observe(textarea);
		node.__gjjTemplateParamsTextareaObservers = node.__gjjTemplateParamsTextareaObservers || [];
		node.__gjjTemplateParamsTextareaObservers.push(observer);
	}
	for (const eventName of ["pointerup", "mouseup", "blur", "change"]) {
		textarea.addEventListener(eventName, () => {
			setTimeout(() => {
				const currentHeight = measureTextareaHeight(textarea);
				if (!pointerStartHeight || Math.abs(currentHeight - pointerStartHeight) > 1) {
					node.__gjjTemplateParamsPreferSavedSize = false;
				}
				rememberTextareaHeight(node, field, textarea);
				refreshNode(node);
				pointerStartHeight = currentHeight;
				manualResizeArmed = false;
			}, 0);
		});
	}
}

function parseValue(text) {
	if (typeof text !== "string") return text;
	const raw = text.trim();
	if (!raw) return "";
	const forced = raw.match(/^\s*(int|float|str|string|bool|boolean|json)\s*\(([\s\S]*)\)\s*$/i);
	if (forced) {
		const kind = forced[1].toLowerCase();
		let inner = stripQuotes(forced[2].trim());
		if (kind === "int") return Number.parseInt(Number.parseFloat(inner), 10);
		if (kind === "float") return Number.parseFloat(inner);
		if (kind === "str" || kind === "string") return inner;
		if (kind === "bool" || kind === "boolean") return /^(1|true|yes|y|on|是|真)$/i.test(inner);
		if (kind === "json") {
			try { return JSON.parse(forced[2].trim()); } catch (_) { return inner; }
		}
	}
	if (isStringLiteralText(raw)) return stripQuotes(raw);
	if (/^(true|yes|on|是|真)$/i.test(raw)) return true;
	if (/^(false|no|off|否|假)$/i.test(raw)) return false;
	if (/^(none|null|nil)$/i.test(raw)) return null;
	if (/^[-+]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) || /^[-+]?\d+[eE][-+]?\d+$/.test(raw)) return Number.parseFloat(raw);
	if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
		try { return JSON.parse(raw); } catch (_) {}
	}
	return text;
}

function inferType(value) {
	const mediaType = detectMediaType(value);

	if (mediaType) return mediaType;

	if (typeof value === "boolean") return "BOOLEAN";
	if (Number.isInteger(value)) return "INT";
	if (typeof value === "number") return "FLOAT";
	if (Array.isArray(value) || (value && typeof value === "object")) return "*";
	if (value === null) return "*";
	return "STRING";
}

function inferTypeFromRaw(rawText, parsedValue) {
	const raw = String(rawText ?? "").trim();

	const mediaType = detectMediaType(raw);

	if (mediaType) return mediaType;

	// 强制格式优先：float(5) 必须是 FLOAT，int(5.0) 必须是 INT。
	const forced = raw.match(/^\s*(int|float|str|string|bool|boolean|json)\s*\(/i);
	if (forced) {
		const kind = forced[1].toLowerCase();
		if (kind === "int") return "INT";
		if (kind === "float") return "FLOAT";
		if (kind === "bool" || kind === "boolean") return "BOOLEAN";
		if (kind === "json") return "*";
		return "STRING";
	}

	// 关键修复：JS 里 Number.isInteger(5.0) 会返回 true，
	// 所以必须看原始文本是否带小数点或科学计数法。
	if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) || /^[-+]?\d+[eE][-+]?\d+$/.test(raw)) {
		return "FLOAT";
	}
	if (/^[-+]?\d+$/.test(raw)) return "INT";

	return inferType(parsedValue);
}

function normalizeSocketType(value) {
	let text = String(value || "").trim();
	if (!text) return "";
	text = text.replace(/，/g, ",").replace(/\s+/g, "");
	if (/^(any|\*)$/i.test(text)) return "*";
	return text.toUpperCase();
}

function splitLabelAndType(rawLabel) {
	const label = String(rawLabel || "").trim();
	const match = label.match(/\s*(?:\[\s*([^\]]+?)\s*\]|【\s*([^】]+?)\s*】)\s*$/);
	if (!match) return { label, socketType: "" };
	return {
		label: label.slice(0, match.index).trim(),
		socketType: normalizeSocketType(match[1] || match[2] || ""),
	};
}

const IMPLICIT_TEMPLATE_KEY_ALIASES = new Map(Object.entries({
	width: "width",
	宽度: "width",
	图像宽度: "width",
	视频宽度: "width",
	height: "height",
	高度: "height",
	图像高度: "height",
	视频高度: "height",
	duration: "duration",
	seconds: "duration",
	second: "duration",
	secs: "duration",
	sec: "duration",
	time: "duration",
	时长: "duration",
	持续时间: "duration",
	视频时长: "duration",
	frame_rate: "frame_rate",
	framerate: "frame_rate",
	fps: "frame_rate",
	帧率: "frame_rate",
	每秒帧数: "frame_rate",
	帧每秒: "frame_rate",
	length: "length",
	frames: "length",
	frame_count: "length",
	framecount: "length",
	帧数: "length",
	视频帧数: "length",
	总帧数: "length",
	wan_mode: "wan_mode",
	video_mode: "wan_mode",
	mode: "wan_mode",
	模式: "wan_mode",
	视频模式: "wan_mode",
	生成模式: "wan_mode",
	wan模式: "wan_mode",
	start_image: "start_image",
	first_image: "start_image",
	首帧: "start_image",
	首图: "start_image",
	起始图: "start_image",
	起始帧: "start_image",
	end_image: "end_image",
	last_image: "end_image",
	尾帧: "end_image",
	尾图: "end_image",
	结束图: "end_image",
	结束帧: "end_image",
}));

function implicitTemplateKeySource(label) {
	const text = String(label || "").trim();
	const compact = text.replace(/[\s_-]+/g, "").toLowerCase();
	const underscored = text.replace(/[\s-]+/g, "_").toLowerCase();
	return IMPLICIT_TEMPLATE_KEY_ALIASES.get(compact)
		|| IMPLICIT_TEMPLATE_KEY_ALIASES.get(underscored)
		|| text;
}

function splitLabelAndBroadcastKey(rawLabel, index) {
	let label = String(rawLabel || "").trim() || `参数 ${index + 1}`;
	const explicit = label.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
	if (!explicit) return { label, keySource: implicitTemplateKeySource(label), broadcastKeys: [] };
	label = explicit[1].trim() || label;
	const firstKey = String(explicit[2] || "").split(/\s*(?:\||,|，|；|;|\bor\b|或)\s*/i)[0] || "";
	const broadcastKey = firstKey.trim()
		.replace(/[^0-9A-Za-z_\u4e00-\u9fff-]+/g, "_")
		.replace(/^_+|_+$/g, "") || `param_${index + 1}`;
	return { label, keySource: broadcastKey, broadcastKeys: [broadcastKey] };
}

function uniqueBroadcastKeys(values) {
	const result = [];
	const seen = new Set();
	for (const value of values || []) {
		const key = String(value || "").trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(key);
	}
	return result;
}

function makeUniqueKey(source, index, seen) {
	let key = String(source || "")
		.trim()
		.replace(/\s+/g, "_")
		.replace(/[^0-9A-Za-z_\u4e00-\u9fff-]/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!key) key = `param_${index + 1}`;
	const count = seen.get(key) || 0;
	seen.set(key, count + 1);
	return count ? `${key}_${count + 1}` : key;
}

function splitValueAndTooltip(text) {
	const raw = String(text || "");
	let escaped = false;
	let tripleQuote = "";
	let quote = "";
	for (let i = 0; i < raw.length;) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			i += 1;
			continue;
		}
		if (tripleQuote) {
			if (raw.startsWith(tripleQuote, i)) {
				tripleQuote = "";
				i += 3;
				continue;
			}
			i += 1;
			continue;
		}
		if (!quote && (raw.startsWith('"""', i) || raw.startsWith("'''", i))) {
			tripleQuote = raw.slice(i, i + 3);
			i += 3;
			continue;
		}
		if (ch === '"' || ch === "'") {
			if (quote === ch) quote = "";
			else if (!quote) quote = ch;
			i += 1;
			continue;
		}
		if (ch === "#" && !quote) {
			return {
				value: raw.slice(0, i).replace(/\\#/g, "#").trim(),
				tooltip: raw.slice(i + 1).trim(),
			};
		}
		i += 1;
	}
	return { value: raw.replace(/\\#/g, "#").trim(), tooltip: "" };
}

function stripQuotes(text) {
	const raw = String(text ?? "").trim();
	if (raw.length >= 6 && (raw.startsWith('"""') || raw.startsWith("'''")) && raw.endsWith(raw.slice(0, 3))) {
		let inner = raw.slice(3, -3);
		if (inner.startsWith("\n")) inner = inner.slice(1);
		if (inner.endsWith("\n")) inner = inner.slice(0, -1);
		return inner;
	}
	if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
		return raw.slice(1, -1);
	}
	return raw;
}

function isStringLiteralText(text) {
	const raw = String(text ?? "").trim();
	return (raw.length >= 6 && (raw.startsWith('"""') || raw.startsWith("'''")) && raw.endsWith(raw.slice(0, 3)))
		|| (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))));
}

function scanTripleQuoteState(text, quote = "") {
	const raw = String(text || "");
	let escaped = false;
	for (let i = 0; i < raw.length;) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			i += 1;
			continue;
		}
		if (quote) {
			if (raw.startsWith(quote, i)) {
				quote = "";
				i += 3;
				continue;
			}
			i += 1;
			continue;
		}
		if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) {
			quote = raw.slice(i, i + 3);
			i += 3;
			continue;
		}
		i += 1;
	}
	return quote;
}

function isEmptyAssignmentLine(line) {
	return /^([^:=：=]+?)\s*[:：=]\s*$/.test(String(line || "").trim());
}

function lineStartsTripleQuote(line) {
	const raw = String(line || "").trimStart();
	return raw.startsWith('"""') || raw.startsWith("'''");
}

function templateLogicalLines(template) {
	const lines = String(template || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const result = [];
	let current = [];
	let quote = "";
	let pendingEmptyValue = false;

	const flushCurrent = () => {
		const logical = current.join("\n").trim();
		if (logical) result.push(logical);
		current = [];
		pendingEmptyValue = false;
	};

	for (let index = 0; index < lines.length;) {
		const line = lines[index];
		const raw = line.trim();
		if (quote) {
			current.push(line);
			quote = scanTripleQuoteState(line, quote);
			if (!quote) flushCurrent();
			index += 1;
			continue;
		}
		if (pendingEmptyValue) {
			if (!raw) {
				current.push(line);
				index += 1;
				continue;
			}
			if (raw.startsWith("#") || raw.startsWith("//") || raw.startsWith(";") || ["...", "....", "……", "…"].includes(raw)) {
				index += 1;
				continue;
			}
			if (lineStartsTripleQuote(line)) {
				current.push(line);
				quote = scanTripleQuoteState(line, quote);
				if (!quote) flushCurrent();
				index += 1;
				continue;
			}
			flushCurrent();
			continue;
		}
		if (!current.length && (!raw || raw.startsWith("#") || raw.startsWith("//") || raw.startsWith(";") || ["...", "....", "……", "…"].includes(raw))) {
			index += 1;
			continue;
		}
		current.push(line);
		quote = scanTripleQuoteState(line, quote);
		if (quote) {
			index += 1;
			continue;
		}
		if (isEmptyAssignmentLine(line)) {
			pendingEmptyValue = true;
			index += 1;
			continue;
		}
		flushCurrent();
		index += 1;
	}
	if (current.length) flushCurrent();
	return result;
}

function splitEnumOptions(inner) {
	const options = [];
	let escaped = false;
	let quote = "";
	let current = "";
	for (const ch of String(inner || "")) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			if (quote === ch) {
				quote = "";
				continue;
			}
			if (!quote) {
				quote = ch;
				continue;
			}
		}
		if ((ch === "," || ch === "，" || ch === "、" || ch === "|") && !quote) {
			const option = stripQuotes(current);
			if (option) options.push(option);
			current = "";
			continue;
		}
		current += ch;
	}
	const option = stripQuotes(current);
	if (option) options.push(option);
	return options;
}

const BOOK_PROMPT_RE = /^\s*(?:(?:提示词|正向提示词|prompt|positive_prompt|positive)\s*[：:])?\s*《([\s\S]*?)》\s*(?:#.*)?$/i;
const CHOICE_GROUP_RE = /^\s*【([^】]+)】\s*(?:[：:]\s*)?[｛{]([\s\S]*?)[｝}]\s*(?:#(.*))?$/i;

function joinPromptParts(parts) {
	return (parts || [])
		.map((part) => String(part ?? "").trim().replace(/^[，,。；;\s]+|[，,。；;\s]+$/g, ""))
		.filter(Boolean)
		.join("，")
		.trim();
}

function parseBookPromptDirective(raw) {
	const match = String(raw || "").trim().match(BOOK_PROMPT_RE);
	return match ? String(match[1] || "").trim() : "";
}

function parseChoiceGroupDirective(raw) {
	const match = String(raw || "").trim().match(CHOICE_GROUP_RE);
	if (!match) return null;
	const label = String(match[1] || "").trim();
	const options = splitEnumOptions(match[2])
		.map((item) => parseOptionItem(item))
		.filter((item) => optionValue(item));
	if (!label || !options.length) return null;
	return {
		label,
		options,
		tooltip: String(match[3] || "").trim(),
	};
}

function selectedPromptGroupLines(fields, values) {
	const byKey = new Map((fields || []).map((field) => [String(field?.key || ""), field]));
	const lines = [];
	for (const field of fields || []) {
		if (!field?.template_prompt) continue;
		for (const key of field.prompt_group_keys || []) {
			const group = byKey.get(String(key || ""));
			if (!group) continue;
			const rawValue = values?.[group.key] ?? values?.[group.label] ?? group.default ?? "";
			const selected = normalizeEnumValue(group, rawValue);
			if (group.label && selected) lines.push(`${group.label}：${selected}`);
		}
	}
	return lines;
}

function combinedPromptValue(field, fields, values) {
	const base = field?.template_prompt ? field.default : (values?.[field.key] ?? values?.[field.label] ?? field.default ?? "");
	return joinPromptParts([base, ...selectedPromptGroupLines(fields, values)]);
}

function splitPipePair(text) {
	const parts = splitEnumOptions(text);
	if (!parts.length) return ["", ""];
	if (parts.length === 1) return [parts[0], parts[0]];
	return [parts[0], parts[1]];
}

function parseOptionItem(item) {
	if (item && typeof item === "object" && !Array.isArray(item)) {
		const label = String(item.label ?? item.name ?? item.text ?? item.value ?? "").trim();
		const value = String(item.value ?? item.id ?? label).trim();
		return { label: label || value, value: value || label };
	}
	const raw = stripQuotes(item).trim();
	const assign = raw.match(/^(.+?)\s*(?:=>|=|:|：)\s*(.+)$/);
	if (assign) {
		const label = assign[1].trim();
		const value = assign[2].trim();
		return { label: label || value, value: value || label };
	}
	const paren = raw.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
	if (paren) {
		const label = paren[1].trim();
		const value = paren[2].trim();
		return { label: label || value, value: value || label };
	}
	return { label: raw, value: raw };
}

function optionLabel(option) {
	return String((option && typeof option === "object" ? option.label ?? option.value : option) ?? "").trim();
}

function optionValue(option) {
	return String((option && typeof option === "object" ? option.value ?? option.label : option) ?? "").trim();
}

function isNumberText(value) {
	const text = String(value ?? "").trim();
	return /^[-+]?\d+$/.test(text)
		|| /^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)
		|| /^[-+]?\d+[eE][-+]?\d+$/.test(text);
}

function enumOutputsNumber(field) {
	const options = Array.isArray(field?.options) ? field.options : [];
	return Boolean(options.length) && options.every((option) => isNumberText(optionValue(option)));
}

function normalizeEnumValue(field, value) {
	const options = Array.isArray(field?.options) ? field.options : [];
	const fallback = optionValue(options[0] || "");
	const text = String(value ?? "").trim();
	const matched = options.find((item) => text === optionValue(item) || text === optionLabel(item));
	return matched ? optionValue(matched) : fallback;
}

function parseEnumOptions(defaultText, tooltip = "") {
	const raw = String(defaultText || "").trim();
	const isSquare = raw.startsWith("[") && raw.endsWith("]");
	const isBrace = (raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("｛") && raw.endsWith("｝"));
	if (!isSquare && !isBrace) return [];
	const inner = raw.slice(1, -1).trim();
	if (!inner) return [];
	const tooltipText = String(tooltip || "").toLowerCase();
	if (isSquare) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed) && (tooltipText.includes("枚举") || tooltipText.includes("enum"))) {
				return parsed.map((item) => parseOptionItem(item)).filter((item) => optionValue(item));
			}
			return [];
		} catch (_) {
			return splitEnumOptions(inner).map((item) => parseOptionItem(item)).filter((item) => optionValue(item));
		}
	}
	return splitEnumOptions(inner).map((item) => parseOptionItem(item)).filter((item) => optionValue(item));
}

function parseBoolSpec(defaultText) {
	const raw = String(defaultText || "").trim();
	const brace = raw.match(/^\s*(true|false|yes|no|on|off|1|0|是|否|开|关)?\s*[{｛]\s*([\s\S]*?)\s*[}｝]\s*$/i);
	if (brace) {
		const defaultRaw = brace[1] || "true";
		const hasExplicitDefault = Boolean(brace[1]);
		const parts = splitEnumOptions(brace[2]);
		if (!hasExplicitDefault && parts.length !== 2) return null;
		if (hasExplicitDefault && parts.length < 2) return null;
		const [trueLabel, falseLabel] = parts;
		return {
			defaultValue: parseValue(defaultRaw) === true,
			labels: {
				true_label: trueLabel || "开启",
				false_label: falseLabel || "关闭",
			},
		};
	}
	const boolCall = raw.match(/^\s*(?:bool|boolean)\s*\(([\s\S]*)\)\s*$/i);
	if (!boolCall) return null;
	const parts = splitEnumOptions(boolCall[1]);
	if (parts.length < 2) return null;
	let defaultValue = true;
	let trueLabel = "";
	let falseLabel = "";
	if (parts.length >= 3 && typeof parseValue(parts[0]) === "boolean") {
		defaultValue = parseValue(parts[0]) === true;
		trueLabel = parts[1];
		falseLabel = parts[2];
	} else {
		[trueLabel, falseLabel] = splitPipePair(boolCall[1]);
	}
	if (!trueLabel && !falseLabel) return null;
	return {
		defaultValue,
		labels: {
			true_label: trueLabel || "开启",
			false_label: falseLabel || "关闭",
		},
	};
}

function parseTemplate(template) {
	const seen = new Map();
	const fields = [];
	const promptParts = [];
	const choiceGroups = [];
	const normalLines = [];
	for (const raw of templateLogicalLines(template)) {
		const promptText = parseBookPromptDirective(raw);
		if (promptText) {
			promptParts.push(promptText);
			continue;
		}
		const choiceGroup = parseChoiceGroupDirective(raw);
		if (choiceGroup) {
			choiceGroups.push(choiceGroup);
			continue;
		}
		normalLines.push(raw);
	}

	let promptField = null;
	if (promptParts.length || choiceGroups.length) {
		const key = makeUniqueKey("prompt", fields.length, seen);
		const defaultText = joinPromptParts(promptParts);
		promptField = {
			key,
			label: "提示词",
			output_enabled: true,
			broadcast_key: "",
			broadcast_keys: [],
			default: defaultText,
			tooltip: "由《...》基础提示词与下方【分组】选择自动组合输出。",
			socket_type: "STRING",
			type: "STRING",
			options: [],
			template_prompt: true,
			prompt_group_keys: [],
		};
		fields.push(promptField);
	}

	for (const group of choiceGroups) {
		const key = makeUniqueKey(implicitTemplateKeySource(group.label), fields.length, seen);
		const field = {
			key,
			label: group.label,
			output_enabled: true,
			broadcast_key: "",
			broadcast_keys: [],
			default: optionValue(group.options[0]),
			tooltip: group.tooltip || "同一分组内选择一个选项；提示词输出会自动附加“名称：选项”。",
			socket_type: "",
			type: "ENUM",
			options: group.options,
			prompt_group: true,
		};
		fields.push(field);
		if (promptField) promptField.prompt_group_keys.push(key);
		if (fields.length >= MAX_OUTPUTS) return fields;
	}

	for (const raw of normalLines) {
		const match = raw.match(/^([^:=：=]+?)\s*[:：=]\s*([\s\S]*)$/);
		if (!match) continue;
		const { label: typedLabel, socketType } = splitLabelAndType(match[1].trim());
		const { label, keySource, broadcastKeys } = splitLabelAndBroadcastKey(typedLabel, fields.length);
		const { value: defaultText, tooltip } = splitValueAndTooltip(match[2].trim());
		if (!label) continue;
		const boolSpec = parseBoolSpec(defaultText);
		const enumOptions = boolSpec ? [] : parseEnumOptions(defaultText, tooltip);
		const value = boolSpec ? boolSpec.defaultValue : (enumOptions.length ? optionValue(enumOptions[0]) : parseValue(defaultText));
		const defaultValue = boolSpec
			? (boolSpec.defaultValue ? "true" : "false")
			: (enumOptions.length ? optionValue(enumOptions[0]) : (typeof value === "string" && isStringLiteralText(defaultText) ? value : defaultText));
		const key = makeUniqueKey(keySource, fields.length, seen);
		const broadcastKeyList = broadcastKeys.length ? uniqueBroadcastKeys([...broadcastKeys, key]) : [];
		const field = {
			key,
			label,
			output_enabled: true,
			broadcast_key: broadcastKeyList[0] || "",
			broadcast_keys: broadcastKeyList,
			default: defaultValue,
			tooltip,
			socket_type: socketType,
			type: boolSpec ? "BOOLEAN" : (enumOptions.length ? "ENUM" : (socketType || inferType(value))),
			options: enumOptions,
		};
		if (boolSpec) field.bool_labels = boolSpec.labels;
		fields.push(field);
		if (fields.length >= MAX_OUTPUTS) break;
	}
	return fields;
}

function refreshNode(node, options = {}) {
	if (!node) return;
	const allowResize = options.resize !== false;

	// 工作流加载后优先尊重保存的节点尺寸，避免 DOM 重建时按 scrollHeight 把节点拉长。
	if (allowResize && node.__gjjTemplateParamsPreferSavedSize && Array.isArray(node.__gjjTemplateParamsSavedSize)) {
		const [, savedH] = node.__gjjTemplateParamsSavedSize;
		const width = currentNodeWidth(node);
		const height = Math.round(Number(savedH || 0));
		if (shouldTreatSavedHeightAsBroken(node, savedH)) {
			node.__gjjTemplateParamsPreferSavedSize = false;
			clampBrokenHeight(node, "refresh-broken-saved");
		} else if (!node.__gjjTemplateParamsSizing && width > 0 && height > 0) {
			node.__gjjTemplateParamsSizing = true;
			try {
				node.setSize?.([width, height]);
			} finally {
				requestAnimationFrame(() => { node.__gjjTemplateParamsSizing = false; });
			}
		}
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
		return;
	}

	const width = currentNodeWidth(node);
	const height = Math.round(Math.max(80, Math.ceil(node.__gjjTemplateParamsContainer?.scrollHeight || node.size?.[1] || 80) + 12));
	const currentWidth = Number(node?.size?.[0] || width);
	const currentHeight = Number(node?.size?.[1] || height);
	const widthChanged = Math.abs(currentWidth - width) > 1;
	const heightChanged = Math.abs(currentHeight - height) > 1;
	if (allowResize && !node.__gjjTemplateParamsSizing && (widthChanged || heightChanged)) {
		node.__gjjTemplateParamsSizing = true;
		try {
			node.setSize?.([Math.round(width), Math.round(height)]);
		} finally {
			requestAnimationFrame(() => { node.__gjjTemplateParamsSizing = false; });
		}
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function broadcastEnabled(node) {
	return Boolean(node?.properties?.[BROADCAST_PROPERTY]);
}

function notifyBroadcastChanged(node) {
	try {
		window.dispatchEvent(new CustomEvent("gjj-variable-broadcast-updated", {
			detail: { nodeId: node?.id, enabled: broadcastEnabled(node) },
		}));
	} catch (_) {}
}

function notifyTemplateParamsUpdated(node) {
	try {
		window.dispatchEvent(new CustomEvent("gjj-template-params-updated", {
			detail: { nodeId: node?.id },
		}));
	} catch (_) {}
}

function updateBroadcastButton(node) {
	const button = node?.__gjjTemplateParamsBroadcastButton;
	if (!button) return;
	const enabled = broadcastEnabled(node);
	button.classList.toggle("active", enabled);
	button.setAttribute("aria-pressed", String(enabled));
	button.dataset.value = enabled ? "true" : "false";
	button.title = enabled
		? "⚡ 已开启：只广播模板中用 (变量名) 明确声明的字段，按单一变量名和类型匹配空输入口。"
		: "⚡ 默认关闭：开启后仅广播写了 (变量名) 的字段，例如 帧率 (frame_rate) [INT,FLOAT]：24.0。";
}

function updateTemplateOutputsButton(node) {
	const button = node?.__gjjTemplateParamsOutputsButton;
	if (!button) return;
	const enabled = templateOutputsEnabled(node);
	button.classList.toggle("active", enabled);
	button.setAttribute("aria-pressed", String(enabled));
	button.dataset.value = enabled ? "true" : "false";
	button.title = enabled
		? "🔌 输出口已打开：按模板顺序生成所有输出口，避免参数错位。"
		: "🔌 输出口已关闭：隐藏模板参数输出口；变量读取仍可按变量名获取。";
}

function setBroadcastEnabled(node, enabled) {
	if (!node) return false;
	node.properties = node.properties || {};
	node.properties[BROADCAST_PROPERTY] = Boolean(enabled);
	updateBroadcastButton(node);
	notifyBroadcastChanged(node);
	refreshNode(node, { resize: false });
	return node.properties[BROADCAST_PROPERTY];
}


function getNaturalCompactHeight(node) {
	const container = node.__gjjTemplateParamsContainer;
	if (!container) return Math.round(Math.max(80, Number(node?.size?.[1] || 80)));

	// 设置面板展开时不要收拢，避免正在编辑模板时高度被压回去。
	const panel = container.querySelector?.(".gjj-template-param-panel");
	if (panel && panel.style.display === "flex") {
		return Math.round(Math.max(80, Math.ceil(container.scrollHeight || 80) + 12));
	}

	return Math.round(Math.max(80, Math.ceil(container.scrollHeight || 80) + 12));
}

function shouldTreatSavedHeightAsBroken(node, savedHeight) {
	const natural = getNaturalCompactHeight(node);
	return Number(savedHeight || 0) > natural + MAX_EXTRA_IDLE_HEIGHT;
}

function clampBrokenHeight(node, reason = "") {
	if (!node || !node.__gjjTemplateParamsContainer) return;
	const naturalHeight = getNaturalCompactHeight(node);
	const currentHeight = Number(node.size?.[1] || 0);
	const panel = node.__gjjTemplateParamsContainer.querySelector?.(".gjj-template-param-panel");
	const panelOpen = panel && panel.style.display === "flex";
	if (panelOpen) return;

	// 打开旧工作流时，如果保存/恢复出异常大高度，自动收拢到当前 DOM 需要的高度。
	if (currentHeight > naturalHeight + MAX_EXTRA_IDLE_HEIGHT) {
		node.__gjjTemplateParamsSizing = true;
		try {
			const width = Math.round(currentNodeWidth(node));
			const height = Math.round(naturalHeight);
			node.setSize?.([width, height]);
			node.properties = node.properties || {};
			node.properties[SAVED_SIZE] = [width, height];
			node.__gjjTemplateParamsSavedSize = [width, height];
			node.__gjjTemplateParamsPreferSavedSize = true;
		} finally {
			requestAnimationFrame(() => { node.__gjjTemplateParamsSizing = false; });
		}
	}
}

function safeAssign(widget, key, value) {
	try { widget[key] = value; } catch (_) {}
}

function collapseElement(el) {
	if (!el?.style) return;
	el.style.display = "none";
	el.style.pointerEvents = "none";
	el.style.height = "0px";
	el.style.minHeight = "0px";
	el.style.maxHeight = "0px";
	el.style.margin = "0px";
	el.style.padding = "0px";
	el.style.border = "0px";
	el.style.overflow = "hidden";
}

function collapseWidget(widget) {
	if (!widget || widget.__gjjTemplateParamsCollapsed) return;
	widget.__gjjTemplateParamsCollapsed = true;
	safeAssign(widget, "hidden", true);
	safeAssign(widget, "type", `converted-widget:${widget.name || "hidden"}`);
	safeAssign(widget, "label", "");
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	safeAssign(widget, "y", 0);
	safeAssign(widget, "last_y", 0);
	safeAssign(widget, "size", [0, -4]);
	safeAssign(widget, "height", -4);
	safeAssign(widget, "serialize", true);
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
	collapseElement(widget.inputEl);
	collapseElement(widget.element);
	collapseElement(widget.widget);
}

function collapseNativeWidgets(node) {
	collapseWidget(getWidget(node, TEMPLATE_WIDGET));
	collapseWidget(getWidget(node, VALUES_WIDGET));
	collapseWidget(getWidget(node, SCHEMA_WIDGET));
}

function disableStandardStatus(node) {
	const state = node?.__gjjStandardStatus;
	if (!state) return;
	state.visible = false;
	if (state.wrap) state.wrap.style.display = "none";
	if (state.widget) {
		state.widget.hidden = true;
		state.widget.computeSize = () => [0, -4];
		state.widget.getHeight = () => -4;
		state.widget.draw = () => {};
	}
}

function normalizeState(node) {
	const template = getWidgetValue(node, TEMPLATE_WIDGET, node?.properties?.[SAVED_TEMPLATE] || DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
	let fields = parseTemplate(template);
	const values = safeJsonParse(getWidgetValue(node, VALUES_WIDGET, node?.properties?.[SAVED_VALUES] || "{}"), {});
	const schema = safeJsonParse(getWidgetValue(node, SCHEMA_WIDGET, node?.properties?.[SAVED_SCHEMA] || "[]"), []);
	fields = applySavedFieldSettings(fields, schema);
	if (!fields.length && Array.isArray(schema) && schema.length) fields = schema;
	for (const field of fields) {
		if (!(field.key in values)) values[field.key] = field.default ?? "";
	}
	return { template, fields, values };
}


function makeFieldSignature(field) {
	return [
		String(field?.key ?? ""),
		String(field?.label ?? ""),
		String(field?.default ?? ""),
		String(field?.type ?? ""),
		JSON.stringify(Array.isArray(field?.options) ? field.options : []),
		JSON.stringify(field?.bool_labels || {}),
		String(field?.tooltip ?? ""),
	].join("\u0001");
}

function templateOutputsEnabled(node) {
	const value = node?.properties?.[OUTPUTS_ENABLED_PROPERTY];
	return value !== false;
}

function setTemplateOutputsEnabled(node, enabled) {
	if (!node) return;
	node.properties = node.properties || {};
	node.properties[OUTPUTS_ENABLED_PROPERTY] = Boolean(enabled);
	updateTemplateOutputsButton(node);
	const state = normalizeState(node);
	updateOutputs(node, state.fields, state.values);
	node.__gjjTemplateParamsUpdateCount?.();
}

function applySavedFieldSettings(fields, savedFields) {
	if (!Array.isArray(fields) || !Array.isArray(savedFields) || !savedFields.length) return fields;
	const savedByKey = new Map(savedFields.map((field) => [String(field?.key || ""), field]));
	const savedByLabel = new Map(savedFields.map((field) => [String(field?.label || ""), field]));
	for (const field of fields) {
		const saved = savedByKey.get(String(field.key || "")) || savedByLabel.get(String(field.label || ""));
		if (saved && saved.output_enabled === false) field.output_enabled = false;
	}
	return fields;
}

function valuesForNewTemplate(oldState, nextFields) {
	const oldFields = Array.isArray(oldState?.fields) ? oldState.fields : [];
	const oldValues = oldState?.values || {};
	const oldByKey = new Map(oldFields.map((field) => [String(field.key || ""), field]));
	const oldByLabel = new Map(oldFields.map((field) => [String(field.label || ""), field]));
	const nextValues = {};
	for (const field of nextFields) {
		const key = String(field.key || "");
		const label = String(field.label || "");
		const oldField = oldByKey.get(key) || oldByLabel.get(label);
		const oldValue = oldValues[key] ?? oldValues[label];

		// 模板默认值、类型、tooltip 任一改变时，以新模板为准，避免旧值把输出口类型锁死。
		if (field.template_prompt) {
			nextValues[key] = field.default ?? "";
		} else if (oldField && makeFieldSignature(oldField) === makeFieldSignature(field) && oldValue !== undefined) {
			nextValues[key] = oldValue;
		} else {
			nextValues[key] = field.default ?? "";
		}
		if (oldField && oldField.output_enabled === false) field.output_enabled = false;
	}
	return nextValues;
}

function forceRefreshTemplate(node, templateText = null) {
	node.__gjjTemplateParamsPreferSavedSize = false;
	const old = normalizeState(node);
	const template = templateText ?? getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) ?? DEFAULT_TEMPLATE;
	const fields = applySavedFieldSettings(parseTemplate(template), old.fields);
	const values = valuesForNewTemplate(old, fields);
	saveState(node, template, fields, values);
	renderRows(node);
	node.__gjjTemplateParamsUpdateCount?.();
	if (node.__gjjTemplateParamsPreferSavedSize && Array.isArray(node.__gjjTemplateParamsSavedSize)) {
		requestAnimationFrame(() => {
			if (Array.isArray(node.__gjjTemplateParamsSavedSize)) {
				const [, savedH] = node.__gjjTemplateParamsSavedSize;
				// 如果保存的是异常长高度，直接丢弃并收拢。
				if (shouldTreatSavedHeightAsBroken(node, savedH)) {
					clampBrokenHeight(node, "broken-saved-size");
					return;
				}
				node.__gjjTemplateParamsSizing = true;
				try {
					node.setSize?.([Math.round(currentNodeWidth(node)), Math.round(Number(savedH || 80))]);
				} finally {
					requestAnimationFrame(() => { node.__gjjTemplateParamsSizing = false; });
				}
			}
			requestAnimationFrame(() => clampBrokenHeight(node, "post-stabilize"));
		});
	} else {
		requestAnimationFrame(() => clampBrokenHeight(node, "post-stabilize-nosaved"));
	}
	refreshNode(node);
}

function saveState(node, template, fields, values, options = {}) {
	node.properties = node.properties || {};
	const schemaText = JSON.stringify(fields);
	const valuesText = JSON.stringify(values);
	const oldTemplate = String(node.properties[SAVED_TEMPLATE] ?? getWidgetValue(node, TEMPLATE_WIDGET, ""));
	const oldValues = String(node.properties[SAVED_VALUES] ?? getWidgetValue(node, VALUES_WIDGET, ""));
	const oldSchema = String(node.properties[SAVED_SCHEMA] ?? getWidgetValue(node, SCHEMA_WIDGET, ""));
	setWidgetValue(node, TEMPLATE_WIDGET, template);
	setWidgetValue(node, VALUES_WIDGET, valuesText);
	setWidgetValue(node, SCHEMA_WIDGET, schemaText);
	node.properties[SAVED_TEMPLATE] = template;
	node.properties[SAVED_VALUES] = valuesText;
	node.properties[SAVED_SCHEMA] = schemaText;
	const changed = oldTemplate !== String(template) || oldValues !== valuesText || oldSchema !== schemaText;
	if (options.notify !== false && changed) {
		notifyTemplateParamsUpdated(node);
		if (broadcastEnabled(node)) notifyBroadcastChanged(node);
	}
}

function syncValuesFromDom(node) {
	if (!node.__gjjTemplateParamsRows) return;
	const { template, fields, values } = normalizeState(node);
	for (const [key, input] of node.__gjjTemplateParamsRows.entries()) {
		values[key] = input.value;
	}
	syncTextareaHeightsFromDom(node);
	saveState(node, template, fields, values);
	updateOutputs(node, fields, values);
}

function updateOutputs(node, fields, values) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	if (!templateOutputsEnabled(node)) {
		for (const output of node.outputs || []) removeOutputLinks(node, output);
		node.outputs = [];
		repairOutputLinkSlots(node);
		refreshNode(node);
		return;
	}
	const enabledFields = fields;
	const previousOutputs = Array.isArray(node.outputs) ? [...node.outputs] : [];
	const previous = { outputs: previousOutputs, ...collectPreviousOutputs(previousOutputs) };
	const usedPreviousOutputs = new Set();
	const nextOutputs = [];
	for (let i = 0; i < enabledFields.length; i += 1) {
		const field = enabledFields[i];
		const output = resolvePreviousOutput(previous, field, i, usedPreviousOutputs)
			|| { name: field.label, type: "*", links: null };
		const rawValue = values[field.key] ?? field.default ?? "";
		const value = parseValue(rawValue);
		// 输出类型必须按“当前输入文本”实时推断。
		// JS 的 Number.isInteger(5.0) 会返回 true，所以 5.0 不能只看 parsed number。
		const nextType = field.type === "ENUM"
			? (enumOutputsNumber(field) ? "INT,FLOAT,STRING" : "COMBO")
			: (field.socket_type ? normalizeSocketType(field.socket_type) : inferTypeFromRaw(rawValue, value));
		output.name = field.label || `输出${i + 1}`;
		output.label = output.name;
		output.localized_name = output.name;
		output.type = nextType;
		output.gjj_template_param_key = field.key || "";
		output.gjj_broadcast_names = Array.isArray(field.broadcast_keys) ? [...field.broadcast_keys] : [];
		output.gjj_broadcast_key = field.broadcast_key || output.gjj_broadcast_names[0] || "";
		// 已连接的旧 link 也同步类型，否则画布上可能还显示旧类型。
		for (const linkId of output.links || []) {
			const link = app.graph?.links?.[linkId];
			if (link) link.type = nextType;
		}
		const displayValue = field.template_prompt
			? combinedPromptValue(field, fields, values)
			: displayValueForField(field, values[field.key] ?? field.default ?? "");
		output.tooltip = [
			`模板参数：${field.label}`,
			output.gjj_broadcast_key ? `广播变量：${output.gjj_broadcast_key}` : "",
			field.tooltip ? `说明：${field.tooltip}` : "",
			`当前值：${displayValue}`,
		].filter(Boolean).join("\n");
		nextOutputs[i] = output;
	}
	const kept = new Set(nextOutputs);
	for (const output of previousOutputs) {
		if (!kept.has(output)) removeOutputLinks(node, output);
	}
	node.outputs = nextOutputs;
	repairOutputLinkSlots(node);
	refreshNode(node);
}

function displayValueForField(field, rawValue) {
	if (field?.type === "ENUM") {
		const normalized = normalizeEnumValue(field, rawValue);
		const option = (Array.isArray(field.options) ? field.options : []).find((item) => normalized === optionValue(item));
		return option ? `${optionLabel(option)} (${optionValue(option)})` : normalized;
	}
	if (field?.type === "BOOLEAN") {
		const enabled = parseValue(rawValue) === true;
		const labels = field?.bool_labels || {};
		return enabled ? (labels.true_label || "true") : (labels.false_label || "false");
	}
	return String(rawValue ?? "");
}

function buildFieldLabel(node, field, typeText = "") {
	const wrap = document.createElement("span");
	wrap.className = "gjj-template-param-label gjj-template-param-label-wrap";
	const text = document.createElement("span");
	text.className = "gjj-template-param-label-text";
	text.textContent = field.label;
	text.title = field.tooltip || typeText || field.type || "";
	wrap.append(text);
	return wrap;
}

function isBooleanField(field, values) {
	const value = parseValue(values?.[field.key] ?? field.default ?? "");
	return field?.type === "BOOLEAN" || typeof value === "boolean";
}

function boolToText(value) {
	return parseValue(value) ? "true" : "false";
}

function buildBoolButtonForField(node, field, values) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-template-param-row";
	const label = buildFieldLabel(node, field, "BOOLEAN");

	const box = document.createElement("div");
	box.className = "gjj-template-param-bool";
	const labels = field?.bool_labels || {};
	const trueLabel = String(labels.true_label || "true");
	const falseLabel = String(labels.false_label || "false");
	box.title = field.tooltip || `布尔参数：${trueLabel} / ${falseLabel} 互斥选择`;
	const buttons = [];

	const sync = () => {
		const enabled = parseValue(values[field.key] ?? field.default ?? "false") === true;
		for (const button of buttons) {
			const active = button.dataset.boolValue === (enabled ? "true" : "false");
			button.dataset.value = active ? "true" : "false";
			button.classList.toggle("active", active);
			button.setAttribute("aria-pressed", String(active));
		}
	};

	const commit = (nextBool) => {
		values[field.key] = nextBool ? "true" : "false";
		sync();
		const template = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
		const fields = parseTemplate(template);
		saveState(node, template, fields, values);
		updateOutputs(node, fields, values);
	};

	for (const [nextBool, text] of [[true, trueLabel], [false, falseLabel]]) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-template-param-bool-button";
		button.textContent = text;
		button.dataset.boolValue = nextBool ? "true" : "false";
		button.title = `${field.label || "布尔参数"}：${text}`;
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("mousedown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			commit(nextBool);
		});
		buttons.push(button);
		box.appendChild(button);
	}

	wrap.append(label, box);
	sync();
	node.__gjjTemplateParamsRows.set(field.key, {
		get value() { return boolToText(values[field.key] ?? field.default ?? "false"); },
		set value(next) { values[field.key] = boolToText(next); sync(); },
	});
	return wrap;
}

function buildEnumSelectForField(node, field, values) {
	const options = Array.isArray(field.options) ? field.options : [];
	if (!options.length) return null;

	const wrap = document.createElement("div");
	wrap.className = "gjj-template-param-row";

	const label = buildFieldLabel(node, field, "ENUM");

	const box = document.createElement("div");
	box.className = "gjj-template-param-enum";
	box.title = field.tooltip || "枚举参数：点击选择输出值";

	const normalizeCurrent = (value) => normalizeEnumValue(field, value);
	values[field.key] = normalizeCurrent(values[field.key] ?? field.default ?? optionValue(options[0] || ""));

	const buttons = [];
	const sync = () => {
		const current = normalizeCurrent(values[field.key]);
		values[field.key] = current;
		for (const button of buttons) {
			button.dataset.value = button.dataset.optionValue === current ? "true" : "false";
			button.classList.toggle("active", button.dataset.optionValue === current);
		}
	};
	const commit = (nextValue) => {
		values[field.key] = normalizeCurrent(nextValue);
		sync();
		const template = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
		const fields = parseTemplate(template);
		saveState(node, template, fields, values);
		updateOutputs(node, fields, values);
	};

	for (const option of options) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-template-param-enum-button";
		button.textContent = optionLabel(option);
		button.dataset.optionValue = optionValue(option);
		button.title = `${optionLabel(option)} → ${optionValue(option)}`;
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("mousedown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			commit(button.dataset.optionValue || "");
		});
		buttons.push(button);
		box.appendChild(button);
	}

	wrap.append(label, box);
	sync();
	node.__gjjTemplateParamsRows.set(field.key, {
		get value() { return normalizeCurrent(values[field.key]); },
		set value(next) { values[field.key] = normalizeCurrent(next); sync(); },
	});
	return wrap;
}

function registerHiddenPromptField(node, field, values) {
	const key = String(field?.key || "");
	if (!key) return null;
	values[key] = String(field?.default ?? "");
	const input = {
		get value() {
			return String(field?.default ?? "");
		},
		set value(_next) {
			values[key] = String(field?.default ?? "");
		},
		closest() {
			return null;
		},
	};
	node.__gjjTemplateParamsRows.set(key, input);
	return input;
}

function buildCompactPromptGroupForField(node, field, values) {
	const options = Array.isArray(field.options) ? field.options : [];
	if (!options.length) return null;

	const wrap = document.createElement("div");
	wrap.className = "gjj-template-param-prompt-group";
	wrap.title = field.tooltip || "同一分组内选择一个选项；会自动拼到提示词输出后面。";

	const label = document.createElement("span");
	label.className = "gjj-template-param-prompt-group-label";
	label.textContent = `${field.label || "选项"}：`;
	label.title = field.tooltip || label.textContent;

	const buttons = [];
	const normalizeCurrent = (value) => normalizeEnumValue(field, value);
	values[field.key] = normalizeCurrent(values[field.key] ?? field.default ?? optionValue(options[0] || ""));
	const sync = () => {
		const current = normalizeCurrent(values[field.key]);
		values[field.key] = current;
		for (const button of buttons) {
			const active = button.dataset.optionValue === current;
			button.dataset.value = active ? "true" : "false";
			button.classList.toggle("active", active);
		}
	};
	const commit = (nextValue) => {
		values[field.key] = normalizeCurrent(nextValue);
		sync();
		const template = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
		const fields = parseTemplate(template);
		saveState(node, template, fields, values);
		updateOutputs(node, fields, values);
	};

	wrap.appendChild(label);
	for (const option of options) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-template-param-enum-button gjj-template-param-prompt-group-button";
		button.textContent = optionLabel(option);
		button.dataset.optionValue = optionValue(option);
		button.title = `${field.label || "选项"}：${optionLabel(option)}`;
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("mousedown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			commit(button.dataset.optionValue || "");
		});
		buttons.push(button);
		wrap.appendChild(button);
	}

	sync();
	node.__gjjTemplateParamsRows.set(field.key, {
		get value() { return normalizeCurrent(values[field.key]); },
		set value(next) { values[field.key] = normalizeCurrent(next); sync(); },
	});
	return wrap;
}

function shouldUseMultilineText(field, value, isMedia) {
	if (isMedia || field?.type !== "STRING") return false;
	const text = String(value ?? field?.default ?? "");
	const hint = [field?.label, field?.tooltip].filter(Boolean).join(" ");
	return text.length > 28
		|| text.includes("\n")
		|| /(文本|内容|描述|提示词|正向|反向|prompt|text|description|caption)/i.test(hint);
}

function autoresizeTextarea(textarea, node = null, options = {}) {
	if (!textarea) return;
	const savedHeight = normalizeTextareaHeight(options.savedHeight);
	if (savedHeight) {
		textarea.style.height = `${savedHeight}px`;
	}
	if (node) refreshNode(node, { resize: false });
}

function registerHiddenMediaField(node, field, values) {
	const key = String(field?.key || "");
	if (!key) return null;
	if (values[key] === undefined) values[key] = String(field?.default ?? "");
	const input = {
		get value() {
			return String(values[key] ?? field?.default ?? "");
		},
		set value(next) {
			values[key] = String(next ?? "");
		},
		closest() {
			return null;
		},
	};
	node.__gjjTemplateParamsRows.set(key, input);
	setTimeout(() => scheduleNetworkMediaToInput(node, field, input, values, null, 0), 0);
	return input;
}

function buildInputForField(node, field, values, options = {}) {
	if (field?.template_prompt) {
		registerHiddenPromptField(node, field, values);
		return null;
	}
	if (field?.prompt_group) {
		return buildCompactPromptGroupForField(node, field, values);
	}
	if (isBooleanField(field, values)) {
		return buildBoolButtonForField(node, field, values);
	}
	if (field?.type === "ENUM") {
		const enumRow = buildEnumSelectForField(node, field, values);
		if (enumRow) return enumRow;
	}

	const isImage = field.type === "IMAGE";
	const isAudio = field.type === "AUDIO";
	const isVideo = field.type === "VIDEO";
	const isMedia = isImage || isAudio || isVideo;
	const groupedMediaPreview = Boolean(options.groupedMediaPreview);
	const currentValue = String(values[field.key] ?? field.default ?? "");
	const multiline = shouldUseMultilineText(field, currentValue, isMedia);

	if (isMedia && groupedMediaPreview) {
		registerHiddenMediaField(node, field, values);
		return null;
	}

	const wrap = document.createElement("div");
	wrap.className = multiline ? "gjj-template-param-row gjj-template-param-row-full gjj-template-param-row-multiline" : "gjj-template-param-row";

	const label = buildFieldLabel(node, field, field.type || "STRING");

	const inputWrap = document.createElement("div");
	inputWrap.style.display = "flex";
	inputWrap.style.gap = "6px";
	inputWrap.style.alignItems = multiline ? "stretch" : "center";

	const input = document.createElement(multiline ? "textarea" : "input");
	input.className = multiline ? "gjj-template-param-input gjj-template-param-textarea" : "gjj-template-param-input";
	input.value = currentValue;
	input.placeholder = String(field.default ?? "");
	input.spellcheck = false;
	input.title = field.tooltip || field.type || "STRING";
	input.style.flex = "1";
	let savedTextareaHeight = 0;
	if (multiline) {
		savedTextareaHeight = getSavedTextareaHeight(node, field);
		input.dataset.gjjTemplateParamKey = String(field.key || "");
		input.dataset.gjjTemplateParamLabel = String(field.label || "");
		input.rows = 2;
		input.wrap = "soft";
		if (savedTextareaHeight) input.style.height = `${savedTextareaHeight}px`;
	}

	input.addEventListener("pointerdown", (event) => event.stopPropagation());
	input.addEventListener("mousedown", (event) => event.stopPropagation());
	input.addEventListener("input", () => {
		values[field.key] = input.value;
		if (isMedia) {
			setWarningMessages(node, []);
			setNetworkWarningMessage(node, field, "");
			setNetworkMediaDisplayPath(node, field, "");
			setNetworkMediaMapping(node, field, "", "");
		}
		if (multiline) {
			refreshNode(node, { resize: false });
		}
		saveFieldValue(node, field, values, input.value);

		if (isMedia) {
			updatePreviewForField(node, field, input.value, wrap);
			scheduleNetworkMediaToInput(node, field, input, values, wrap, 650);
		}
	});
	if (isMedia) {
		for (const eventName of ["change", "blur"]) {
			input.addEventListener(eventName, () => scheduleNetworkMediaToInput(node, field, input, values, wrap, 0));
		}
	}
	if (multiline) {
		observeTextareaHeight(node, field, input);
		setTimeout(() => {
			if (savedTextareaHeight) autoresizeTextarea(input, node, { savedHeight: savedTextareaHeight });
		}, 0);
	}

	inputWrap.appendChild(input);

	// 添加文件选择按钮（仅媒体类型）
	if (isMedia) {
		const fileButton = document.createElement("button");
		fileButton.type = "button";
		fileButton.className = "gjj-template-param-file-button";
		fileButton.textContent = "📁";
		fileButton.title = isImage ? "选择图片" : isVideo ? "选择视频" : "选择音频";
		fileButton.style.cssText = [
			"height:30px",
			"width:36px",
			"padding:0",
			"border:1px solid #33464e",
			"border-radius:8px",
			"background:#2b2d30",
			"color:#f1f5f5",
			"cursor:pointer",
			"font-size:14px",
			"display:flex",
			"align-items:center",
			"justify-content:center",
		].join(";");

		fileButton.addEventListener("pointerdown", (event) => event.stopPropagation());
		fileButton.addEventListener("mousedown", (event) => event.stopPropagation());
		fileButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openFileDialog(node, field, input, values, isImage, isAudio, isVideo);
		});

		inputWrap.appendChild(fileButton);
	}

	wrap.append(label, inputWrap);

	// 添加预览区域（仅媒体类型）
	if (isMedia && !groupedMediaPreview) {
		const preview = document.createElement("div");
		preview.className = mediaPreviewClass(field.type);
		preview.dataset.fieldKey = field.key;
		preview.style.cssText = [
			"grid-column: 1 / -1",
			"margin-top: 4px",
			"min-height: 40px",
			"display:flex",
			"align-items:center",
			"justify-content:center",
		].join(";");

		updatePreview(preview, input.value, isImage, isAudio, isVideo, null, {
			title: field.label || "媒体",
			description: field.tooltip || "",
			onLayout: () => refreshNode(node),
		});
		node.__gjjTemplateParamsPreviewMap?.set(String(field.key), preview);
		wrap.appendChild(preview);
	}

	node.__gjjTemplateParamsRows.set(field.key, input);
	if (isMedia) {
		setTimeout(() => scheduleNetworkMediaToInput(node, field, input, values, wrap, 0), 0);
	}
	return wrap;
}

function buildGroupedMediaPreview(node, fields, values) {
	const mediaFields = fields.filter((field) => isMediaType(field?.type));
	if (mediaFields.length < 1) return null;

	const group = document.createElement("div");
	group.className = "gjj-template-param-media-preview-group";
	node.__gjjTemplateParamsMediaGroup = group;
	node.__gjjTemplateParamsMediaFieldKeys = mediaFields.map((field) => String(field.key || ""));
	renderGroupedMediaPreview(node, fields, values);
	return group;
}

function renderRows(node) {
	const state = normalizeState(node);
	saveState(node, state.template, state.fields, state.values, { notify: false });
	node.__gjjTemplateParamsUpdateCount?.();
	const rows = node.__gjjTemplateParamsRowsWrap;
	if (!rows) return;
	disconnectTextareaHeightObservers(node);
	rows.innerHTML = "";
	node.__gjjTemplateParamsRows = new Map();
	node.__gjjTemplateParamsPreviewMap = new Map();
	node.__gjjTemplateParamsMediaGroup = null;
	node.__gjjTemplateParamsMediaFieldKeys = [];
	if (!state.fields.length) {
		const empty = document.createElement("div");
		empty.className = "gjj-template-param-empty";
		empty.textContent = "点击 ⚙ 设置，按“名称：默认值 # 说明”填写模板。";
		rows.appendChild(empty);
	} else {
		const mediaFields = state.fields.filter((field) => isMediaType(field?.type));
		const useGroupedMediaPreview = mediaFields.length > 0;
		const lastMediaIndex = useGroupedMediaPreview
			? state.fields.reduce((last, field, index) => isMediaType(field?.type) ? index : last, -1)
			: -1;

		for (let i = 0; i < state.fields.length; i += 1) {
			const field = state.fields[i];
			const row = buildInputForField(node, field, state.values, { groupedMediaPreview: useGroupedMediaPreview });
			if (row) rows.appendChild(row);
			if (useGroupedMediaPreview && i === lastMediaIndex) {
				const mediaGroup = buildGroupedMediaPreview(node, state.fields, state.values);
				if (mediaGroup) rows.appendChild(mediaGroup);
			}
		}
	}
	updateOutputs(node, state.fields, state.values);
	refreshNode(node);
}

function buildDom(node) {
	const container = document.createElement("div");
	container.className = "gjj-template-params";
	container.style.cssText = "width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:0;";
	const style = document.createElement("style");
	style.textContent = `
		.gjj-template-params * { box-sizing: border-box; }
		.gjj-template-param-toolbar { display:flex; align-items:center; gap:6px; }
		.gjj-template-param-gear, .gjj-template-param-refresh, .gjj-template-param-broadcast, .gjj-template-param-output-plug, .gjj-template-param-ok, .gjj-template-param-cancel { border:1px solid #44565f; border-radius:7px; background:#202b31; color:#dce7e2; cursor:pointer; height:24px; padding:0 8px; font-size:12px; }
		.gjj-template-param-broadcast, .gjj-template-param-output-plug { width:26px; flex:0 0 26px; padding:0; font-size:14px; line-height:20px; }
		.gjj-template-param-gear:hover, .gjj-template-param-refresh:hover, .gjj-template-param-broadcast:hover, .gjj-template-param-output-plug:hover, .gjj-template-param-ok:hover, .gjj-template-param-cancel:hover { background:#2c3b43; }
		.gjj-template-param-broadcast.active, .gjj-template-param-broadcast[data-value="true"], .gjj-template-param-output-plug.active, .gjj-template-param-output-plug[data-value="true"] { border-color:#69b980; background:#20362f; color:#ecfff1; }
		.gjj-template-param-output-plug[data-value="false"] { border-color:#46535a; background:#24282b; color:#8ea0a8; opacity:.78; filter:grayscale(.8); }
		.gjj-template-param-count { color:#8ea0a8; font-size:11px; }
		.gjj-template-param-panel { display:none; flex-direction:column; gap:6px; padding:6px; border:1px solid #33464e; border-radius:9px; background:#0d1519; }
		.gjj-template-param-template { width:100%; min-height:108px; height:118px; resize:vertical; overflow:auto; padding:7px 8px; border:1px solid #33464e; border-radius:8px; outline:none; background:#2b2d30; color:#f1f5f5; font:12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space:pre-wrap; }
		.gjj-template-param-help { color:#8ea0a8; font-size:11px; line-height:1.45; white-space:pre-wrap; }
		.gjj-template-param-actions { display:flex; gap:6px; justify-content:flex-end; }
		.gjj-template-param-warning { display:none; padding:6px 8px; border:1px solid #8a5a08; border-radius:8px; background:#2a2111; color:#ffcf86; font-size:11px; line-height:1.45; white-space:pre-wrap; }
		.gjj-template-param-rows { display:flex; flex-direction:column; gap:6px; }
		.gjj-template-param-row { display:grid; grid-template-columns:74px minmax(0,1fr); gap:7px; align-items:center; }
		.gjj-template-param-row-full { grid-template-columns:1fr; gap:4px; align-items:stretch; }
		.gjj-template-param-row-full .gjj-template-param-label { width:100%; }
		.gjj-template-param-row-full > div { width:100%; }
		.gjj-template-param-label { color:#b9c8cc; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-template-param-label-wrap { display:flex; align-items:center; gap:4px; min-width:0; }
		.gjj-template-param-label-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-template-param-input { width:100%; height:30px; padding:4px 8px; border:1px solid #33464e; border-radius:8px; outline:none; background:#2b2d30; color:#f1f5f5; font-size:13px; }
		.gjj-template-param-textarea { min-height:58px; height:auto; resize:vertical; line-height:1.45; white-space:pre-wrap; overflow:auto; }
		.gjj-template-param-template.gjj-template-param-textarea { min-height:108px; height:118px; font:12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
		.gjj-template-param-input:focus { border-color:#6aa6b8; background:#22282c; }
		.gjj-template-param-file-button { height:30px; width:36px; padding:0; border:1px solid #33464e; border-radius:8px; background:#2b2d30; color:#f1f5f5; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; }
		.gjj-template-param-file-button:hover { background:#3a3d40; border-color:#6aa6b8; }
		.gjj-template-param-preview-image, .gjj-template-param-preview-video, .gjj-template-param-preview-audio { grid-column: 1 / -1; margin-top: 4px; min-height: 40px; display:block; width:100%; }
		.gjj-template-param-media-preview-group { display:block; width:100%; min-width:0; padding:6px; border:1px solid #253841; border-radius:8px; background:#0a1418; }
		.gjj-template-param-bool { display:flex; align-items:center; gap:5px; min-width:0; width:100%; }
		.gjj-template-param-bool-button { min-width:0; flex:1 1 72px; height:30px; padding:4px 8px; border:1px solid #33464e; border-radius:8px; outline:none; background:#24282b; color:#cdd5d8; font-size:13px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-template-param-bool-button.active, .gjj-template-param-bool-button[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; font-weight:700; }
		.gjj-template-param-bool-button[data-value="false"] { border-color:#46535a; background:#24282b; color:#cdd5d8; }
		.gjj-template-param-bool-button:hover { filter:brightness(1.12); }
		.gjj-template-param-enum { display:flex; align-items:center; gap:5px; min-width:0; width:100%; flex-wrap:wrap; }
		.gjj-template-param-enum-button { min-width:34px; max-width:100%; flex:0 0 auto; width:auto; height:26px; padding:2px 8px; border:1px solid #33464e; border-radius:7px; outline:none; background:#24282b; color:#cdd5d8; font-size:12px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-template-param-enum-button.active, .gjj-template-param-enum-button[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; font-weight:700; }
		.gjj-template-param-enum-button:hover { filter:brightness(1.12); border-color:#6aa6b8; }
		.gjj-template-param-prompt-group { display:flex; align-items:center; gap:4px; flex-wrap:wrap; min-width:0; width:100%; padding:0; }
		.gjj-template-param-prompt-group-label { flex:0 0 auto; color:#9fb2b9; font-size:11px; font-weight:700; line-height:22px; white-space:nowrap; }
		.gjj-template-param-prompt-group-button { flex:0 0 auto; min-width:0; width:auto; height:22px; padding:1px 8px; border-radius:6px; font-size:11px; line-height:1; }
		.gjj-template-param-empty { color:#8ea0a8; font-size:12px; padding:4px 0; }
	`;

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-template-param-toolbar";
	const gear = document.createElement("button");
	gear.type = "button";
	gear.className = "gjj-template-param-gear";
	gear.textContent = "⚙️ 设置";
	gear.title = "编辑隐藏模板，确定后自动生成输入框和输出口";

	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.className = "gjj-template-param-refresh";
	refresh.textContent = "↻";
	refresh.title = "刷新：重新解析模板、重建面板，并同步输出口名称 / 类型 / tooltip";

	const broadcast = document.createElement("button");
	broadcast.type = "button";
	broadcast.className = "gjj-template-param-broadcast";
	broadcast.textContent = "⚡";
	broadcast.setAttribute("aria-label", "切换模板参数广播");

	const outputPlug = document.createElement("button");
	outputPlug.type = "button";
	outputPlug.className = "gjj-template-param-output-plug";
	outputPlug.textContent = "🔌";
	outputPlug.setAttribute("aria-label", "切换模板参数输出口");

	const count = document.createElement("span");
	count.className = "gjj-template-param-count";
	toolbar.append(gear, broadcast, outputPlug, refresh, count);

	const panel = document.createElement("div");
	panel.className = "gjj-template-param-panel";
	const template = document.createElement("textarea");
	template.className = "gjj-template-param-input gjj-template-param-textarea gjj-template-param-template";
	template.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
	template.placeholder = DEFAULT_TEMPLATE;
	template.rows = 4;
	template.wrap = "soft";
	const help = document.createElement("div");
	help.className = "gjj-template-param-help";
	help.textContent = [
		"每行一个参数：名称：默认值 # 说明",
		"广播示例：帧率 (frame_rate) [INT,FLOAT]：24.0 # 每秒帧数",
		"多段提示词：提示词：'''第一段\\n第二段''' 或 提示词：\"\"\"多段文本\"\"\"。",
		"组合提示词：提示词：《基础提示》；【风格】｛真实、日漫、美漫｝ 会生成风格按钮，并在第一个“提示词”输出里自动组合。",
		"支持 int(1)、float(1)、true / false、json([1,2])、图片/音频/视频路径。",
		"⚡ 默认关闭；开启后只广播写了 (变量名) 的字段，括号内只使用一个严格变量名。",
		"🔌 控制本节点是否显示输出口；变量读取可不依赖输出口和广播开关。",
		"布尔按钮：true{开启文案|关闭文案}；简写 {开启文案|关闭文案} 默认开启。",
		"枚举按钮：[显示=输出值, 显示2=输出值2]；兼容 [显示(输出值), ...]。",
		"空行、整行 # 注释、.... 会被忽略；如果值里要写 #，请用 \\#，三引号内部可直接写 #。",
	].join("\n");
	const actions = document.createElement("div");
	actions.className = "gjj-template-param-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "gjj-template-param-cancel";
	cancel.textContent = "取消";
	const ok = document.createElement("button");
	ok.type = "button";
	ok.className = "gjj-template-param-ok";
	ok.textContent = "确定";
	actions.append(cancel, ok);
	panel.append(template, actions, help);

	const rows = document.createElement("div");
	rows.className = "gjj-template-param-rows";
	const warning = document.createElement("div");
	warning.className = "gjj-template-param-warning";

	const stop = (event) => event.stopPropagation();
	for (const el of [container, gear, refresh, broadcast, outputPlug, panel, template, ok, cancel]) {
		el.addEventListener("pointerdown", stop);
		el.addEventListener("mousedown", stop);
	}
	gear.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		template.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
		const opening = panel.style.display !== "flex";
		panel.style.display = opening ? "flex" : "none";
		node.__gjjTemplateParamsPreferSavedSize = !opening;
		refreshNode(node);
		if (opening) setTimeout(() => template.focus(), 0);
	});
	refresh.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		forceRefreshTemplate(node);
	});
	broadcast.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setBroadcastEnabled(node, !broadcastEnabled(node));
	});
	outputPlug.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setTemplateOutputsEnabled(node, !templateOutputsEnabled(node));
	});
	cancel.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		panel.style.display = "none";
		node.__gjjTemplateParamsPreferSavedSize = true;
		refreshNode(node);
	});
	ok.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const old = normalizeState(node);
		const fields = parseTemplate(template.value);
		const values = valuesForNewTemplate(old, fields);
		saveState(node, template.value, fields, values);
		panel.style.display = "none";
		node.__gjjTemplateParamsPreferSavedSize = false;
		renderRows(node);
		node.properties = node.properties || {};
		node.properties[SAVED_SIZE] = [Math.round(Number(node.size?.[0] || DEFAULT_WIDTH)), Math.round(Number(node.size?.[1] || 80))];
	});
	for (const eventName of ["input", "change", "keydown", "keyup", "wheel", "dblclick", "contextmenu"]) {
		template.addEventListener(eventName, stop);
	}
	if (typeof ResizeObserver !== "undefined") {
		const observer = new ResizeObserver(() => refreshNode(node));
		observer.observe(template);
		node.__gjjTemplateParamsTemplateResizeObserver = observer;
	}
	for (const eventName of ["pointerup", "mouseup", "blur"]) {
		template.addEventListener(eventName, () => refreshNode(node));
	}

	container.append(style, toolbar, panel, warning, rows);
	node.__gjjTemplateParamsContainer = container;
	node.__gjjTemplateParamsRowsWrap = rows;
	node.__gjjTemplateParamsWarning = warning;
	node.__gjjTemplateParamsCount = count;
	node.__gjjTemplateParamsBroadcastButton = broadcast;
	node.__gjjTemplateParamsOutputsButton = outputPlug;
	const updateCount = () => {
		const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
		const saved = safeJsonParse(getWidgetValue(node, SCHEMA_WIDGET, node?.properties?.[SAVED_SCHEMA] || "[]"), []);
		applySavedFieldSettings(fields, saved);
		const outputCount = templateOutputsEnabled(node) ? fields.length : 0;
		count.textContent = `${fields.length} 参数 / ${outputCount} 输出`;
	};
	node.__gjjTemplateParamsUpdateCount = updateCount;
	updateCount();
	updateBroadcastButton(node);
	updateTemplateOutputsButton(node);
	return container;
}

function ensureDom(node) {
	if (!node || node.__gjjTemplateParamsWidget) return;
	const container = buildDom(node);
	const widget = node.addDOMWidget?.(DOM_WIDGET, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.computeSize = (width) => [
			Math.round(Number(width || currentNodeWidth(node))),
			Math.round(Math.max(40, Math.ceil(container.scrollHeight || 40))),
		];
		node.__gjjTemplateParamsWidget = widget;
	}
}

function stabilize(node) {
	if (!node) return;
	ensureDom(node);
	pruneLegacyWidgetInputs(node);
	collapseNativeWidgets(node);
	disableStandardStatus(node);
	updateBroadcastButton(node);
	updateTemplateOutputsButton(node);
	if (!getWidgetValue(node, TEMPLATE_WIDGET, "")) {
		setWidgetValue(node, TEMPLATE_WIDGET, node?.properties?.[SAVED_TEMPLATE] || DEFAULT_TEMPLATE);
	}
	if (!getWidgetValue(node, VALUES_WIDGET, "")) setWidgetValue(node, VALUES_WIDGET, node?.properties?.[SAVED_VALUES] || "{}");
	if (!getWidgetValue(node, SCHEMA_WIDGET, "")) setWidgetValue(node, SCHEMA_WIDGET, node?.properties?.[SAVED_SCHEMA] || "[]");
	renderRows(node);
	node.__gjjTemplateParamsUpdateCount?.();
	if (node.__gjjTemplateParamsPreferSavedSize && Array.isArray(node.__gjjTemplateParamsSavedSize)) {
		requestAnimationFrame(() => {
			if (Array.isArray(node.__gjjTemplateParamsSavedSize)) {
				const [, savedH] = node.__gjjTemplateParamsSavedSize;
				// 如果保存的是异常长高度，直接丢弃并收拢。
				if (shouldTreatSavedHeightAsBroken(node, savedH)) {
					clampBrokenHeight(node, "broken-saved-size");
					return;
				}
				node.__gjjTemplateParamsSizing = true;
				try {
					node.setSize?.([Math.round(currentNodeWidth(node)), Math.round(Number(savedH || 80))]);
				} finally {
					requestAnimationFrame(() => { node.__gjjTemplateParamsSizing = false; });
				}
			}
			requestAnimationFrame(() => clampBrokenHeight(node, "post-stabilize"));
		});
	} else {
		requestAnimationFrame(() => clampBrokenHeight(node, "post-stabilize-nosaved"));
	}
}

function scheduleStabilize(node, ms = 0) {
	clearTimeout(node.__gjjTemplateParamsTimer);
	node.__gjjTemplateParamsTimer = setTimeout(() => {
		stabilize(node);
		setTimeout(() => clampBrokenHeight(node, "delayed-1"), 80);
		setTimeout(() => clampBrokenHeight(node, "delayed-2"), 240);
	}, Math.round(Number(ms) || 0));
}

app.registerExtension({
	name: "Comfy.GJJ.TemplateParams",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if ([TEMPLATE_WIDGET, VALUES_WIDGET, SCHEMA_WIDGET].includes(name)) collapseWidget(widget);
			return widget;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			const props = serializedNode?.properties || this.properties || {};
			this.properties = this.properties || {};
			if (props[SAVED_TEMPLATE]) setWidgetValue(this, TEMPLATE_WIDGET, props[SAVED_TEMPLATE]);
			if (props[SAVED_VALUES]) setWidgetValue(this, VALUES_WIDGET, props[SAVED_VALUES]);
			if (props[SAVED_SCHEMA]) setWidgetValue(this, SCHEMA_WIDGET, props[SAVED_SCHEMA]);
			if (props[SAVED_TEXTAREA_HEIGHTS]) {
				this.properties[SAVED_TEXTAREA_HEIGHTS] = sanitizeTextareaHeights(props[SAVED_TEXTAREA_HEIGHTS]);
			}
			this.properties[BROADCAST_PROPERTY] = Boolean(props[BROADCAST_PROPERTY]);
			this.properties[OUTPUTS_ENABLED_PROPERTY] = props[OUTPUTS_ENABLED_PROPERTY] !== false;
			updateBroadcastButton(this);
			updateTemplateOutputsButton(this);
			if (Array.isArray(props[SAVED_SIZE])) {
				this.__gjjTemplateParamsSavedSize = props[SAVED_SIZE].map((value) => Math.round(Number(value) || 0));
				this.__gjjTemplateParamsPreferSavedSize = true;
				this.size = [Math.round(currentNodeWidth(this)), Math.round(Number(this.__gjjTemplateParamsSavedSize[1] || 80))];
			} else {
				// 老工作流没有 gjj_template_params_size，但 serializedNode.size 可能已经被异常高度污染。
				this.__gjjTemplateParamsPreferSavedSize = false;
			}
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			syncValuesFromDom(this);
			syncTextareaHeightsFromDom(this);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[SAVED_TEMPLATE] = getWidgetValue(this, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
				serializedNode.properties[SAVED_VALUES] = getWidgetValue(this, VALUES_WIDGET, "{}");
				serializedNode.properties[SAVED_SCHEMA] = getWidgetValue(this, SCHEMA_WIDGET, "[]");
				serializedNode.properties[SAVED_TEXTAREA_HEIGHTS] = sanitizeTextareaHeights(this.properties?.[SAVED_TEXTAREA_HEIGHTS]);
				serializedNode.properties[BROADCAST_PROPERTY] = broadcastEnabled(this);
				serializedNode.properties[OUTPUTS_ENABLED_PROPERTY] = templateOutputsEnabled(this);
				const naturalHeight = getNaturalCompactHeight(this);
				const currentHeight = Number(this.size?.[1] || 80);
				const saveHeight = currentHeight > naturalHeight + MAX_EXTRA_IDLE_HEIGHT ? naturalHeight : currentHeight;
				serializedNode.properties[SAVED_SIZE] = [Math.round(Number(this.size?.[0] || DEFAULT_WIDTH)), Math.round(saveHeight)];
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjTemplateParamsSizing) {
				this.properties = this.properties || {};
				this.properties[SAVED_SIZE] = [Math.round(Number(this.size?.[0] || DEFAULT_WIDTH)), Math.round(Number(this.size?.[1] || 80))];
				this.__gjjTemplateParamsSavedSize = [...this.properties[SAVED_SIZE]];
				this.__gjjTemplateParamsPreferSavedSize = true;
			}
			refreshNode(this, { resize: false });
			return result;
		};
	},

	nodeCreated(node) {
		if (TARGET_NODES.has(node?.comfyClass)) scheduleStabilize(node, 0);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilize(node);
		}
	},
});

api.addEventListener("executing", (event) => {
	const node = findTemplateParamsNode(eventNodeId(event));
	if (TARGET_NODES.has(node?.comfyClass)) setWarningMessages(node, []);
});

api.addEventListener("executed", (event) => {
	const node = findTemplateParamsNode(eventNodeId(event));
	if (!TARGET_NODES.has(node?.comfyClass)) return;
	const payload = event?.detail?.output || event?.detail || {};
	setWarningMessages(node, normalizeWarningList(payload));
});

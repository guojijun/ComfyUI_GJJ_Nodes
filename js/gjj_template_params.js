
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

function mediaItemForField(field, values) {
	const value = String(values?.[field.key] ?? field.default ?? "");
	const mediaType = mediaTypeFromField(field, value) || field.type;
	const kind = String(mediaType || "").toLowerCase();
	return gjjMediaRefToItem(value, {
		kind,
		title: field.label || "媒体",
		description: field.tooltip || "",
		emptyText: kind === "image" ? "无图片" : kind === "video" ? "无视频" : kind === "audio" ? "无音频" : "无媒体",
	});
}

function renderGroupedMediaPreview(node, fields = null, values = null) {
	const group = node?.__gjjTemplateParamsMediaGroup;
	if (!group) return false;
	const state = fields && values ? { fields, values } : normalizeState(node);
	const mediaFields = state.fields.filter((field) => isMediaType(field?.type));
	const items = mediaFields.map((field) => mediaItemForField(field, state.values));
	gjjRenderMediaPreview(group, items, {
		singleMinHeight: 168,
		singleMaxHeight: 360,
		tileMinWidth: 118,
		tileMinHeight: 112,
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

function normalizeUploadFilename(data, file) {
	const filename = data?.name || data?.filename || data?.file || file?.name;
	const subfolder = data?.subfolder || "";
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadMediaToInput(file) {
	const endpoints = ["/upload/image", "/api/upload/image"];
	let lastError = null;

	for (const endpoint of endpoints) {
		const form = new FormData();
		// ComfyUI 的上传接口字段名叫 image，但可作为通用 input 文件上传使用。
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");

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
			const filename = normalizeUploadFilename(data, file);
			if (!filename) throw new Error("上传成功但没有返回文件名");
			return filename;
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

function filenameFromNetworkUrl(url, mediaType = "") {
	try {
		const parsed = new URL(String(url || "").trim(), window.location.href);
		return safeMediaFilename(parsed.pathname.split("/").pop() || "", mediaType);
	} catch (_) {
		return safeMediaFilename(String(url || "").split("?")[0], mediaType);
	}
}

function inputViewUrlForFilename(filename) {
	return "/view?filename=" + encodeURIComponent(filename) + "&type=input";
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

function currentInputForField(node, field, fallback = null) {
	const current = node?.__gjjTemplateParamsRows?.get?.(String(field?.key || ""));
	if (current && "value" in current) return current;
	return fallback;
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

async function downloadNetworkMediaInBrowser(originalUrl, mediaType, filename) {
	const response = await fetch(originalUrl, { cache: "no-store" });
	if (!response?.ok) {
		throw new Error(`浏览器下载 HTTP ${response?.status || "?"}`);
	}
	const blob = await response.blob();
	const file = new File([blob], filename, { type: blob.type || mimeForMediaType(mediaType) });
	return uploadMediaToInput(file);
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
	const originalUrl = String(input?.value || "").trim();
	if (!isNetworkMediaUrl(originalUrl)) return;
	const mediaType = mediaTypeFromField(field, originalUrl);
	if (!mediaType) return;

	node.__gjjTemplateParamsNetworkJobs = node.__gjjTemplateParamsNetworkJobs || new Map();
	const jobKey = `${field.key}\n${originalUrl}`;
	if (node.__gjjTemplateParamsNetworkJobs.has(jobKey)) return node.__gjjTemplateParamsNetworkJobs.get(jobKey);

	const job = (async () => {
		const filename = filenameFromNetworkUrl(originalUrl, mediaType);
		const row = wrap || input.closest?.(".gjj-template-param-row");
		const preview = getPreviewForField(node, field.key, row);
		try {
			if (await inputFileExists(filename)) {
				const activeInput = currentInputForField(node, field, input);
				if (String(activeInput?.value || "").trim() !== originalUrl) return;
				activeInput.value = filename;
				saveFieldValue(node, field, values, filename);
				updatePreviewForField(node, field, filename, row);
				setNetworkWarningMessage(node, field, "");
				return;
			}

			setPreviewMessage(preview, `正在下载到 ComfyUI input：${filename}`);
			let uploadedName = "";
			try {
				uploadedName = await downloadNetworkMediaViaBackend(originalUrl, mediaType);
			} catch (backendErr) {
				console.warn("[GJJ_TemplateParams] 后端下载网络媒体失败，改用浏览器上传:", backendErr);
				uploadedName = await downloadNetworkMediaInBrowser(originalUrl, mediaType, filename);
			}
			const activeInput = currentInputForField(node, field, input);
			if (String(activeInput?.value || "").trim() !== originalUrl) return;
			activeInput.value = uploadedName;
			saveFieldValue(node, field, values, uploadedName);
			updatePreviewForField(node, field, uploadedName, row);
			setNetworkWarningMessage(node, field, "");
		} catch (err) {
			console.warn("[GJJ_TemplateParams] 网络媒体下载到 input 失败:", err);
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
	if (!isNetworkMediaUrl(input?.value)) return;
	node.__gjjTemplateParamsNetworkTimers = node.__gjjTemplateParamsNetworkTimers || new Map();
	const key = String(field?.key || "");
	clearTimeout(node.__gjjTemplateParamsNetworkTimers.get(key));
	const timer = setTimeout(() => {
		ensureNetworkMediaInInput(node, field, input, values, wrap);
	}, Math.max(0, Number(delay) || 0));
	node.__gjjTemplateParamsNetworkTimers.set(key, timer);
}

function openFileDialog(node, field, input, values, isImage, isAudio, isVideo) {
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

		const row = input.closest(".gjj-template-param-row");
		const preview = getPreviewForField(node, field.key, row);
		const button = row?.querySelector(".gjj-template-param-file-button");
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
const MAX_OUTPUTS = 64;
const DEFAULT_TEMPLATE = "帧率：24.0 # 浮点\n时长：5 # 整数\nLora加速：true{开启加速|关闭加速} # 布尔按钮\n是否启用：[启用=enable, 禁用=disable] # 枚举按钮";
const DEFAULT_WIDTH = 300;
const MAX_EXTRA_IDLE_HEIGHT = 72;

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function outputHasLinks(output) {
	if (!output) return false;
	if (Array.isArray(output.links)) return output.links.length > 0;
	return output.link != null;
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
	return Number.isFinite(width) && width > 0 ? width : DEFAULT_WIDTH;
}

function safeJsonParse(text, fallback) {
	try {
		const value = JSON.parse(String(text || ""));
		return value ?? fallback;
	} catch (_) {
		return fallback;
	}
}

function parseValue(text) {
	if (typeof text !== "string") return text;
	const raw = text.trim();
	if (!raw) return "";
	const forced = raw.match(/^\s*(int|float|str|string|bool|boolean|json)\s*\(([\s\S]*)\)\s*$/i);
	if (forced) {
		const kind = forced[1].toLowerCase();
		let inner = forced[2].trim();
		if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
			inner = inner.slice(1, -1);
		}
		if (kind === "int") return Number.parseInt(Number.parseFloat(inner), 10);
		if (kind === "float") return Number.parseFloat(inner);
		if (kind === "str" || kind === "string") return inner;
		if (kind === "bool" || kind === "boolean") return /^(1|true|yes|y|on|是|真)$/i.test(inner);
		if (kind === "json") {
			try { return JSON.parse(forced[2].trim()); } catch (_) { return inner; }
		}
	}
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

function slugKey(label, index, seen) {
	let key = String(label || "")
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
	let quote = "";
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			if (quote === ch) quote = "";
			else if (!quote) quote = ch;
			continue;
		}
		if (ch === "#" && !quote) {
			return {
				value: raw.slice(0, i).replace(/\\#/g, "#").trim(),
				tooltip: raw.slice(i + 1).trim(),
			};
		}
	}
	return { value: raw.replace(/\\#/g, "#").trim(), tooltip: "" };
}

function stripQuotes(text) {
	const raw = String(text ?? "").trim();
	if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
		return raw.slice(1, -1);
	}
	return raw;
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
		if ((ch === "," || ch === "，" || ch === "|") && !quote) {
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

function parseEnumOptions(defaultText, tooltip = "") {
	const raw = String(defaultText || "").trim();
	if (!raw.startsWith("[") || !raw.endsWith("]")) return [];
	const inner = raw.slice(1, -1).trim();
	if (!inner) return [];
	const tooltipText = String(tooltip || "").toLowerCase();
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && (tooltipText.includes("枚举") || tooltipText.includes("enum"))) {
			return parsed.map((item) => parseOptionItem(item));
		}
		return [];
	} catch (_) {
		return splitEnumOptions(inner).map((item) => parseOptionItem(item));
	}
}

function parseBoolSpec(defaultText) {
	const raw = String(defaultText || "").trim();
	const brace = raw.match(/^\s*(true|false|yes|no|on|off|1|0|是|否|开|关)?\s*[{｛]\s*([\s\S]*?)\s*[}｝]\s*$/i);
	if (brace) {
		const defaultRaw = brace[1] || "true";
		const [trueLabel, falseLabel] = splitPipePair(brace[2]);
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
	for (const line of String(template || "").replace(/\r\n/g, "\n").split("\n")) {
		const raw = line.trim();
		if (!raw || raw.startsWith("#") || raw.startsWith("//") || raw.startsWith(";")) continue;
		if (["...", "....", "……", "…"].includes(raw)) continue;
		const match = raw.match(/^([^:=：=]+?)\s*[:：=]\s*([\s\S]*)$/);
		if (!match) continue;
		const label = match[1].trim();
		const { value: defaultText, tooltip } = splitValueAndTooltip(match[2].trim());
		if (!label) continue;
		const boolSpec = parseBoolSpec(defaultText);
		const enumOptions = boolSpec ? [] : parseEnumOptions(defaultText, tooltip);
		const value = boolSpec ? boolSpec.defaultValue : (enumOptions.length ? optionValue(enumOptions[0]) : parseValue(defaultText));
		const field = {
			key: slugKey(label, fields.length, seen),
			label,
			default: boolSpec ? (boolSpec.defaultValue ? "true" : "false") : (enumOptions.length ? optionValue(enumOptions[0]) : defaultText),
			tooltip,
			type: boolSpec ? "BOOLEAN" : (enumOptions.length ? "ENUM" : inferType(value)),
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
		const [savedW, savedH] = node.__gjjTemplateParamsSavedSize;
		if (shouldTreatSavedHeightAsBroken(node, savedH)) {
			node.__gjjTemplateParamsPreferSavedSize = false;
			clampBrokenHeight(node, "refresh-broken-saved");
		} else if (!node.__gjjTemplateParamsSizing && savedW > 0 && savedH > 0) {
			node.__gjjTemplateParamsSizing = true;
			try {
				node.setSize?.([savedW, savedH]);
			} finally {
				requestAnimationFrame(() => { node.__gjjTemplateParamsSizing = false; });
			}
		}
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
		return;
	}

	const width = currentNodeWidth(node);
	const height = Math.max(80, Math.ceil(node.__gjjTemplateParamsContainer?.scrollHeight || node.size?.[1] || 80) + 12);
	const currentWidth = Number(node?.size?.[0] || width);
	const currentHeight = Number(node?.size?.[1] || height);
	const widthChanged = Math.abs(currentWidth - width) > 1;
	const heightChanged = Math.abs(currentHeight - height) > 1;
	if (allowResize && !node.__gjjTemplateParamsSizing && (widthChanged || heightChanged)) {
		node.__gjjTemplateParamsSizing = true;
		try {
			node.setSize?.([width, height]);
		} finally {
			requestAnimationFrame(() => { node.__gjjTemplateParamsSizing = false; });
		}
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}


function getNaturalCompactHeight(node) {
	const container = node.__gjjTemplateParamsContainer;
	if (!container) return Math.max(80, Number(node?.size?.[1] || 80));

	// 设置面板展开时不要收拢，避免正在编辑模板时高度被压回去。
	const panel = container.querySelector?.(".gjj-template-param-panel");
	if (panel && panel.style.display === "flex") {
		return Math.max(80, Math.ceil(container.scrollHeight || 80) + 12);
	}

	return Math.max(80, Math.ceil(container.scrollHeight || 80) + 12);
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
			const width = currentNodeWidth(node);
			node.setSize?.([width, naturalHeight]);
			node.properties = node.properties || {};
			node.properties[SAVED_SIZE] = [width, naturalHeight];
			node.__gjjTemplateParamsSavedSize = [width, naturalHeight];
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
		if (oldField && makeFieldSignature(oldField) === makeFieldSignature(field) && oldValue !== undefined) {
			nextValues[key] = oldValue;
		} else {
			nextValues[key] = field.default ?? "";
		}
	}
	return nextValues;
}

function forceRefreshTemplate(node, templateText = null) {
	node.__gjjTemplateParamsPreferSavedSize = false;
	const old = normalizeState(node);
	const template = templateText ?? getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) ?? DEFAULT_TEMPLATE;
	const fields = parseTemplate(template);
	const values = valuesForNewTemplate(old, fields);
	saveState(node, template, fields, values);
	renderRows(node);
	node.__gjjTemplateParamsUpdateCount?.();
	if (node.__gjjTemplateParamsPreferSavedSize && Array.isArray(node.__gjjTemplateParamsSavedSize)) {
		requestAnimationFrame(() => {
			if (Array.isArray(node.__gjjTemplateParamsSavedSize)) {
				const [savedW, savedH] = node.__gjjTemplateParamsSavedSize;
				// 如果保存的是异常长高度，直接丢弃并收拢。
				if (shouldTreatSavedHeightAsBroken(node, savedH)) {
					clampBrokenHeight(node, "broken-saved-size");
					return;
				}
				node.__gjjTemplateParamsSizing = true;
				try {
					node.setSize?.([...node.__gjjTemplateParamsSavedSize]);
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

function saveState(node, template, fields, values) {
	node.properties = node.properties || {};
	const schemaText = JSON.stringify(fields);
	const valuesText = JSON.stringify(values);
	setWidgetValue(node, TEMPLATE_WIDGET, template);
	setWidgetValue(node, VALUES_WIDGET, valuesText);
	setWidgetValue(node, SCHEMA_WIDGET, schemaText);
	node.properties[SAVED_TEMPLATE] = template;
	node.properties[SAVED_VALUES] = valuesText;
	node.properties[SAVED_SCHEMA] = schemaText;
}

function syncValuesFromDom(node) {
	if (!node.__gjjTemplateParamsRows) return;
	const { template, fields, values } = normalizeState(node);
	for (const [key, input] of node.__gjjTemplateParamsRows.entries()) {
		values[key] = input.value;
	}
	saveState(node, template, fields, values);
	updateOutputs(node, fields, values);
}

function updateOutputs(node, fields, values) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	while (node.outputs.length < fields.length) {
		node.addOutput?.(`输出${node.outputs.length + 1}`, "*");
		if (node.outputs.length === 0) node.outputs.push({ name: "输出1", type: "*", links: null });
	}
	for (let i = 0; i < fields.length; i += 1) {
		const field = fields[i];
		const output = node.outputs[i] || { name: field.label, type: "*", links: null };
		const rawValue = values[field.key] ?? field.default ?? "";
		const value = parseValue(rawValue);
		// 输出类型必须按“当前输入文本”实时推断。
		// JS 的 Number.isInteger(5.0) 会返回 true，所以 5.0 不能只看 parsed number。
		const nextType = field.type === "ENUM" ? "COMBO" : inferTypeFromRaw(rawValue, value);
		output.name = field.label || `输出${i + 1}`;
		output.label = output.name;
		output.localized_name = output.name;
		output.type = nextType;
		// 已连接的旧 link 也同步类型，否则画布上可能还显示旧类型。
		for (const linkId of output.links || []) {
			const link = app.graph?.links?.[linkId];
			if (link) link.type = nextType;
		}
		output.tooltip = [
			`模板参数：${field.label}`,
			field.tooltip ? `说明：${field.tooltip}` : "",
			`当前值：${displayValueForField(field, values[field.key] ?? field.default ?? "")}`,
		].filter(Boolean).join("\n");
		node.outputs[i] = output;
	}
	for (let i = node.outputs.length - 1; i >= fields.length; i -= 1) {
		const output = node.outputs[i];
		if (outputHasLinks(output)) break;
		node.outputs.splice(i, 1);
	}
	repairOutputLinkSlots(node);
	refreshNode(node);
}

function displayValueForField(field, rawValue) {
	if (field?.type === "ENUM") {
		const text = String(rawValue ?? "").trim();
		const option = (Array.isArray(field.options) ? field.options : []).find((item) => {
			return text === optionValue(item) || text === optionLabel(item);
		});
		return option ? `${optionLabel(option)} (${optionValue(option)})` : text;
	}
	if (field?.type === "BOOLEAN") {
		const enabled = parseValue(rawValue) === true;
		const labels = field?.bool_labels || {};
		return enabled ? (labels.true_label || "true") : (labels.false_label || "false");
	}
	return String(rawValue ?? "");
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
	const label = document.createElement("span");
	label.className = "gjj-template-param-label";
	label.textContent = field.label;
	label.title = field.tooltip || "BOOLEAN";

	const box = document.createElement("div");
	box.className = "gjj-template-param-bool";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-template-param-bool-button";
	const labels = field?.bool_labels || {};
	const trueLabel = String(labels.true_label || "true");
	const falseLabel = String(labels.false_label || "false");
	button.title = field.tooltip || `布尔参数：点击切换 ${trueLabel} / ${falseLabel}`;

	const sync = () => {
		const enabled = parseValue(values[field.key] ?? field.default ?? "false") === true;
		button.dataset.value = enabled ? "true" : "false";
		button.textContent = enabled ? `✅ ${trueLabel}` : `⬜ ${falseLabel}`;
	};

	const commit = (nextBool) => {
		values[field.key] = nextBool ? "true" : "false";
		sync();
		const template = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
		const fields = parseTemplate(template);
		saveState(node, template, fields, values);
		updateOutputs(node, fields, values);
	};

	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		commit(!(parseValue(values[field.key] ?? field.default ?? "false") === true));
	});

	box.appendChild(button);
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
	const fallback = optionValue(options[0] || "");
	if (!options.length) return null;

	const wrap = document.createElement("div");
	wrap.className = "gjj-template-param-row";

	const label = document.createElement("span");
	label.className = "gjj-template-param-label";
	label.textContent = field.label;
	label.title = field.tooltip || "ENUM";

	const box = document.createElement("div");
	box.className = "gjj-template-param-enum";
	box.title = field.tooltip || "枚举参数：点击选择输出值";

	const normalizeCurrent = (value) => {
		const text = String(value ?? "").trim();
		const matched = options.find((item) => text === optionValue(item) || text === optionLabel(item));
		return matched ? optionValue(matched) : fallback;
	};
	values[field.key] = normalizeCurrent(values[field.key] ?? field.default ?? fallback);

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

function shouldUseMultilineText(field, value, isMedia) {
	if (isMedia || field?.type !== "STRING") return false;
	const text = String(value ?? field?.default ?? "");
	const hint = [field?.label, field?.tooltip].filter(Boolean).join(" ");
	return text.length > 28
		|| text.includes("\n")
		|| /(文本|内容|描述|提示词|正向|反向|prompt|text|description|caption)/i.test(hint);
}

function autoresizeTextarea(textarea, node = null) {
	if (!textarea) return;
	textarea.style.height = "auto";
	textarea.style.height = `${Math.max(58, textarea.scrollHeight || 58)}px`;
	if (node) refreshNode(node);
}

function buildInputForField(node, field, values, options = {}) {
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

	const wrap = document.createElement("div");
	wrap.className = multiline ? "gjj-template-param-row gjj-template-param-row-full gjj-template-param-row-multiline" : "gjj-template-param-row";

	const label = document.createElement("span");
	label.className = "gjj-template-param-label";
	label.textContent = field.label;
	label.title = field.tooltip || field.type || "STRING";

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
	if (multiline) {
		input.rows = 2;
		input.wrap = "soft";
	}

	input.addEventListener("pointerdown", (event) => event.stopPropagation());
	input.addEventListener("mousedown", (event) => event.stopPropagation());
	input.addEventListener("input", () => {
		values[field.key] = input.value;
		if (isMedia) {
			setWarningMessages(node, []);
			setNetworkWarningMessage(node, field, "");
		}
		if (multiline) autoresizeTextarea(input, node);
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
		setTimeout(() => autoresizeTextarea(input, node), 0);
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
	if (mediaFields.length < 2) return null;

	const group = document.createElement("div");
	group.className = "gjj-template-param-media-preview-group";
	node.__gjjTemplateParamsMediaGroup = group;
	node.__gjjTemplateParamsMediaFieldKeys = mediaFields.map((field) => String(field.key || ""));
	renderGroupedMediaPreview(node, fields, values);
	return group;
}

function renderRows(node) {
	const state = normalizeState(node);
	saveState(node, state.template, state.fields, state.values);
	const rows = node.__gjjTemplateParamsRowsWrap;
	if (!rows) return;
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
		const useGroupedMediaPreview = mediaFields.length > 1;
		const lastMediaIndex = useGroupedMediaPreview
			? state.fields.reduce((last, field, index) => isMediaType(field?.type) ? index : last, -1)
			: -1;

		for (let i = 0; i < state.fields.length; i += 1) {
			const field = state.fields[i];
			rows.appendChild(buildInputForField(node, field, state.values, { groupedMediaPreview: useGroupedMediaPreview }));
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
		.gjj-template-param-gear, .gjj-template-param-refresh, .gjj-template-param-ok, .gjj-template-param-cancel { border:1px solid #44565f; border-radius:7px; background:#202b31; color:#dce7e2; cursor:pointer; height:24px; padding:0 8px; font-size:12px; }
		.gjj-template-param-gear:hover, .gjj-template-param-refresh:hover, .gjj-template-param-ok:hover, .gjj-template-param-cancel:hover { background:#2c3b43; }
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
		.gjj-template-param-input { width:100%; height:30px; padding:4px 8px; border:1px solid #33464e; border-radius:8px; outline:none; background:#2b2d30; color:#f1f5f5; font-size:13px; }
		.gjj-template-param-textarea { min-height:58px; height:auto; resize:vertical; line-height:1.45; white-space:pre-wrap; overflow:auto; }
		.gjj-template-param-template.gjj-template-param-textarea { min-height:108px; height:118px; font:12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
		.gjj-template-param-input:focus { border-color:#6aa6b8; background:#22282c; }
		.gjj-template-param-file-button { height:30px; width:36px; padding:0; border:1px solid #33464e; border-radius:8px; background:#2b2d30; color:#f1f5f5; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; }
		.gjj-template-param-file-button:hover { background:#3a3d40; border-color:#6aa6b8; }
		.gjj-template-param-preview-image, .gjj-template-param-preview-video, .gjj-template-param-preview-audio { grid-column: 1 / -1; margin-top: 4px; min-height: 40px; display:block; width:100%; }
		.gjj-template-param-media-preview-group { display:block; width:100%; min-width:0; padding:6px; border:1px solid #253841; border-radius:8px; background:#0a1418; }
		.gjj-template-param-media-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(78px, 1fr)); gap:6px; }
		.gjj-template-param-media-item { min-width:0; display:flex; flex-direction:column; gap:4px; }
		.gjj-template-param-media-label { color:#8ea0a8; font-size:11px; line-height:1.2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-template-param-media-item .gjj-template-param-preview-image,
		.gjj-template-param-media-item .gjj-template-param-preview-video,
		.gjj-template-param-media-item .gjj-template-param-preview-audio { grid-column:auto; margin-top:0; min-height:74px; height:96px; padding:4px; border:1px solid #253841; border-radius:7px; background:#071013; overflow:hidden; --gjj-template-preview-max-height:88px; --gjj-template-preview-video-max-height:88px; }
		.gjj-template-param-media-item .gjj-template-param-preview-audio { min-height:48px; height:54px; }
		.gjj-template-param-media-item audio { height:30px; }
		.gjj-template-param-bool { display:flex; align-items:center; min-width:0; }
		.gjj-template-param-bool-button { width:100%; height:30px; padding:4px 8px; border:1px solid #33464e; border-radius:8px; outline:none; background:#2b2d30; color:#f1f5f5; font-size:13px; cursor:pointer; text-align:left; }
		.gjj-template-param-bool-button[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-template-param-bool-button[data-value="false"] { border-color:#46535a; background:#24282b; color:#cdd5d8; }
		.gjj-template-param-bool-button:hover { filter:brightness(1.12); }
		.gjj-template-param-enum { display:flex; align-items:center; gap:5px; min-width:0; width:100%; flex-wrap:wrap; }
		.gjj-template-param-enum-button { min-width:0; flex:1 1 72px; height:30px; padding:4px 8px; border:1px solid #33464e; border-radius:8px; outline:none; background:#24282b; color:#cdd5d8; font-size:13px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-template-param-enum-button.active, .gjj-template-param-enum-button[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; font-weight:700; }
		.gjj-template-param-enum-button:hover { filter:brightness(1.12); border-color:#6aa6b8; }
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

	const count = document.createElement("span");
	count.className = "gjj-template-param-count";
	toolbar.append(gear, refresh, count);

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
		"示例：帧率：24.0 # 每秒帧数",
		"支持 int(1)、float(1)、true / false、json([1,2])、图片/音频/视频路径。",
		"布尔按钮：true{开启文案|关闭文案}；简写 {开启文案|关闭文案} 默认开启。",
		"枚举按钮：[显示=输出值, 显示2=输出值2]；兼容 [显示(输出值), ...]。",
		"空行、整行 # 注释、.... 会被忽略；如果值里要写 #，请用 \\#。",
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
	panel.append(template, help, actions);

	const rows = document.createElement("div");
	rows.className = "gjj-template-param-rows";
	const warning = document.createElement("div");
	warning.className = "gjj-template-param-warning";

	const stop = (event) => event.stopPropagation();
	for (const el of [container, gear, refresh, panel, template, ok, cancel]) {
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
		node.properties[SAVED_SIZE] = [Number(node.size?.[0] || DEFAULT_WIDTH), Number(node.size?.[1] || 80)];
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
	const updateCount = () => {
		const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
		count.textContent = `${fields.length} 个参数`;
	};
	node.__gjjTemplateParamsUpdateCount = updateCount;
	updateCount();
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
			Number(width || currentNodeWidth(node)),
			Math.max(40, Math.ceil(container.scrollHeight || 40)),
		];
		node.__gjjTemplateParamsWidget = widget;
	}
}

function stabilize(node) {
	if (!node) return;
	ensureDom(node);
	collapseNativeWidgets(node);
	disableStandardStatus(node);
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
				const [savedW, savedH] = node.__gjjTemplateParamsSavedSize;
				// 如果保存的是异常长高度，直接丢弃并收拢。
				if (shouldTreatSavedHeightAsBroken(node, savedH)) {
					clampBrokenHeight(node, "broken-saved-size");
					return;
				}
				node.__gjjTemplateParamsSizing = true;
				try {
					node.setSize?.([...node.__gjjTemplateParamsSavedSize]);
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
	}, ms);
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
			if (props[SAVED_TEMPLATE]) setWidgetValue(this, TEMPLATE_WIDGET, props[SAVED_TEMPLATE]);
			if (props[SAVED_VALUES]) setWidgetValue(this, VALUES_WIDGET, props[SAVED_VALUES]);
			if (props[SAVED_SCHEMA]) setWidgetValue(this, SCHEMA_WIDGET, props[SAVED_SCHEMA]);
			if (Array.isArray(props[SAVED_SIZE])) {
				this.__gjjTemplateParamsSavedSize = props[SAVED_SIZE].map(Number);
				this.__gjjTemplateParamsPreferSavedSize = true;
				this.size = [...this.__gjjTemplateParamsSavedSize];
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
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[SAVED_TEMPLATE] = getWidgetValue(this, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
				serializedNode.properties[SAVED_VALUES] = getWidgetValue(this, VALUES_WIDGET, "{}");
				serializedNode.properties[SAVED_SCHEMA] = getWidgetValue(this, SCHEMA_WIDGET, "[]");
				const naturalHeight = getNaturalCompactHeight(this);
				const currentHeight = Number(this.size?.[1] || 80);
				const saveHeight = currentHeight > naturalHeight + MAX_EXTRA_IDLE_HEIGHT ? naturalHeight : currentHeight;
				serializedNode.properties[SAVED_SIZE] = [Number(this.size?.[0] || DEFAULT_WIDTH), saveHeight];
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjTemplateParamsSizing) {
				this.properties = this.properties || {};
				this.properties[SAVED_SIZE] = [Number(this.size?.[0] || DEFAULT_WIDTH), Number(this.size?.[1] || 80)];
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

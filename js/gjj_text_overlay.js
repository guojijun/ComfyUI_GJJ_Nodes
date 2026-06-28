import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const TARGET = "GJJ_TextOverlay";
const PANEL = "gjj_text_overlay_live_panel";
const PANEL_MIN_HEIGHT = 220;
const PANEL_MAX_HEIGHT = 620;
const HIDDEN_WIDGETS = new Set([
	"texts",
	"split_char",
	"indexes",
	"text_opacity",
	"watermark_opacity",
	"watermark_width",
	"direction",
	"spacing",
	"seed",
	"strip_empty",
	"font_path",
	"font_size",
	"x",
	"y",
	"text_x",
	"text_y",
	"watermark_x",
	"watermark_y",
	"color_hex",
	"stroke_color_hex",
	"use_stroke",
	"stroke_width",
	"watermark_upload_name",
	"logo_remove_bg",
	"logo_shadow_enabled",
	"logo_shadow_blur",
	"logo_shadow_x",
	"logo_shadow_y",
	"logo_shadow_color_hex",
	"logo_stroke_enabled",
	"logo_stroke_width",
	"logo_stroke_color_hex",
	"logo_default_url",
	"has_watermark_input",
]);
const TEXT_WIDGETS = [
	"texts",
	"text_opacity",
	"direction",
	"spacing",
	"font_path",
	"font_size",
	"color_hex",
	"stroke_color_hex",
	"use_stroke",
	"stroke_width",
];
const WATERMARK_WIDGETS = [
	"watermark_opacity",
	"watermark_width",
	"watermark_upload_name",
	"logo_remove_bg",
	"logo_shadow_enabled",
	"logo_shadow_blur",
	"logo_shadow_x",
	"logo_shadow_y",
	"logo_shadow_color_hex",
	"logo_stroke_enabled",
	"logo_stroke_width",
	"logo_stroke_color_hex",
	"logo_default_url",
];
const PERSISTED_WIDGETS = new Set([
	"font_size",
	"text_x",
	"text_y",
	"watermark_x",
	"watermark_y",
	"watermark_width",
	"watermark_upload_name",
	"logo_default_url",
]);
const SIZE_PROPERTIES = {
	bgWidth: "gjj_text_overlay_bg_width",
	bgHeight: "gjj_text_overlay_bg_height",
	watermarkWidth: "gjj_text_overlay_watermark_source_width",
	watermarkHeight: "gjj_text_overlay_watermark_source_height",
};
const RMBG14_PREVIEW_API = "/gjj/text_overlay/rmbg14_preview";
const FETCH_LOGO_API = "/gjj/text_overlay/fetch_logo_url";
const DEFAULT_LOGO_URL = "https://mintcdn.com/dripart/QzWbjSCBG7w61rR3/logo/dark.svg";
function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name) || null;
}

function input(node, name) {
	return node?.inputs?.find((item) => item?.name === name) || null;
}

function linkPresent(slot) {
	return slot?.link != null || (Array.isArray(slot?.links) && slot.links.length > 0);
}

function graphLink(linkId) {
	const links = app.graph?.links;
	if (linkId == null || !links) return null;
	if (typeof links.get === "function") return links.get(linkId) || links.get(String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function linkField(link, name) {
	if (!link) return null;
	if (!Array.isArray(link)) return link[name];
	const indexes = { id: 0, origin_id: 1, origin_slot: 2, target_id: 3, target_slot: 4, type: 5 };
	return link[indexes[name]];
}

function inputIndex(node, name) {
	const list = node?.inputs || [];
	return list.findIndex((item) => item?.name === name);
}

function sourceNodeFromInput(node, name) {
	const slot = input(node, name);
	if (!slot || slot.link == null || !app.graph?.links) return null;
	const link = graphLink(slot.link);
	const sourceId = linkField(link, "origin_id") ?? linkField(link, "source_id") ?? linkField(link, "from_id");
	return sourceId == null ? null : findNodeById(sourceId);
}

function linkMemory(node, create = false) {
	if (!create && (!node?.properties || !node.properties.gjj_text_overlay_link_memory)) return {};
	node.properties ||= {};
	const memory = node.properties.gjj_text_overlay_link_memory;
	if (memory && typeof memory === "object" && !Array.isArray(memory)) return memory;
	if (!create) return {};
	node.properties.gjj_text_overlay_link_memory = {};
	return node.properties.gjj_text_overlay_link_memory;
}

function findNodeById(id) {
	const found = app.graph?.getNodeById?.(id);
	if (found) return found;
	return (app.graph?._nodes || []).find((item) => String(item?.id) === String(id)) || null;
}

function currentInputLinkRecord(node, inputName) {
	const slotIndex = inputIndex(node, inputName);
	const slot = slotIndex >= 0 ? node.inputs?.[slotIndex] : null;
	const linkId = slot?.link;
	const link = graphLink(linkId);
	if (slotIndex < 0 || linkId == null || !link) return null;
	const originId = linkField(link, "origin_id") ?? linkField(link, "source_id") ?? linkField(link, "from_id");
	const originSlot = linkField(link, "origin_slot") ?? linkField(link, "source_slot") ?? linkField(link, "from_slot");
	const source = findNodeById(originId);
	return {
		input_name: inputName,
		origin_id: originId,
		origin_slot: originSlot,
		target_slot: linkField(link, "target_slot") ?? slotIndex,
		type: linkField(link, "type") || slot?.type || "",
		origin_name: source?.title || source?.comfyClass || source?.type || "",
	};
}

function rememberedInputLink(node, inputName) {
	const record = linkMemory(node)[inputName];
	return record && typeof record === "object" ? record : null;
}

function markGraphChanged(node) {
	try { node.graph?.change?.(); } catch (_) {}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function showPanelStatus(node, message, delay = 1600) {
	const status = node?.__gjjTextOverlayUI?.status;
	if (!status || !message) return;
	status.textContent = message;
	status.dataset.show = "true";
	clearTimeout(node.__gjjTextOverlayStatusTimer);
	node.__gjjTextOverlayStatusTimer = setTimeout(() => { status.dataset.show = "false"; }, delay);
}

function refreshInputPreviewAfterLinkChange(node, inputName) {
	if (inputName === "background_image") {
		if (linkPresent(input(node, inputName))) refreshBackground(node, true);
	} else if (inputName === "watermark_image") {
		refreshWatermarkPreview(node, true);
	}
	renderPanel(node, { fitText: false });
	updateLinkToggleButtons(node);
}

function disconnectRememberedInputLink(node, inputName) {
	const record = currentInputLinkRecord(node, inputName);
	if (!record) {
		updateLinkToggleButtons(node);
		return false;
	}
	linkMemory(node, true)[inputName] = record;
	const targetSlot = Number.isFinite(Number(record.target_slot)) ? Number(record.target_slot) : inputIndex(node, inputName);
	try {
		node.disconnectInput?.(targetSlot);
	} catch (_) {
		const slot = node.inputs?.[targetSlot];
		if (slot) slot.link = null;
	}
	markGraphChanged(node);
	refreshInputPreviewAfterLinkChange(node, inputName);
	showPanelStatus(node, `已断开：${record.origin_name || "上游节点"}`);
	return true;
}

function reconnectRememberedInputLink(node, inputName) {
	const record = rememberedInputLink(node, inputName);
	if (!record) {
		updateLinkToggleButtons(node);
		showPanelStatus(node, "没有上游连接记录");
		return false;
	}
	const source = findNodeById(record.origin_id);
	const sourceSlot = Number(record.origin_slot);
	const targetSlot = inputIndex(node, inputName);
	if (!source || !source.outputs?.[sourceSlot] || targetSlot < 0) {
		showPanelStatus(node, "上游节点或接口不存在", 2200);
		updateLinkToggleButtons(node);
		return false;
	}
	try {
		if (node.inputs?.[targetSlot]?.link != null) node.disconnectInput?.(targetSlot);
		source.connect(sourceSlot, node, targetSlot);
		linkMemory(node, true)[inputName] = { ...record, target_slot: targetSlot };
		markGraphChanged(node);
		refreshInputPreviewAfterLinkChange(node, inputName);
		showPanelStatus(node, `已连接：${record.origin_name || "上游节点"}`);
		return true;
	} catch (error) {
		console.warn("[GJJ_TextOverlay] 恢复上游连接失败", error);
		showPanelStatus(node, "恢复上游连接失败", 2200);
		updateLinkToggleButtons(node);
		return false;
	}
}

function toggleRememberedInputLink(node, inputName) {
	if (currentInputLinkRecord(node, inputName)) return disconnectRememberedInputLink(node, inputName);
	return reconnectRememberedInputLink(node, inputName);
}

function updateLinkToggleButtons(node) {
	const ui = node?.__gjjTextOverlayUI;
	if (!ui) return;
	const defs = [
		["background_image", ui.backgroundLinkButton, "背景图"],
		["watermark_image", ui.watermarkLinkButton, "水印图"],
	];
	for (const [inputName, button, label] of defs) {
		if (!button) continue;
		const active = Boolean(currentInputLinkRecord(node, inputName));
		const remembered = Boolean(rememberedInputLink(node, inputName));
		button.style.display = active || remembered ? "flex" : "none";
		button.dataset.active = active ? "true" : "false";
		button.title = active ? `断开${label}上游链接` : `恢复${label}上游链接`;
	}
}

function imageRefToViewUrl(item) {
	if (!item?.filename) return "";
	const filename = String(item.filename || "");
	const type = String(item.type || "input");
	const subfolder = String(item.subfolder || "");
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}${previewFormat}${randParam}`,
	);
}

function imageRefToViewInfo(item) {
	const src = imageRefToViewUrl(item);
	if (!src) return null;
	const width = Number(item?.width || item?.preview_width || item?.w || 0);
	const height = Number(item?.height || item?.preview_height || item?.h || 0);
	return {
		src,
		width: Number.isFinite(width) && width > 0 ? width : 0,
		height: Number.isFinite(height) && height > 0 ? height : 0,
	};
}

function inferImageInfoFromUrl(src) {
	if (!src) return null;
	let filename = "";
	try {
		const url = new URL(src, window.location.href);
		filename = decodeURIComponent(url.searchParams.get("filename") || "");
	} catch (_) {
		filename = String(src);
	}
	const match = filename.match(/(?:^|[^0-9])(\d{2,5})[xX×](\d{2,5})(?:[^0-9]|$)/);
	if (!match) return { src, width: 0, height: 0 };
	return {
		src,
		width: Number(match[1]) || 0,
		height: Number(match[2]) || 0,
	};
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (_) {
		return [];
	}
}

function firstMultiImageLoaderSrc(sourceNode) {
	const state = sourceNode?.__gjjMultiImageState;
	const executed = Array.isArray(state?.executedImages) ? state.executedImages : [];
	const executedSrc = imageRefToViewUrl(executed.find((item) => item?.filename));
	if (executedSrc) return executedSrc;

	const selected = Array.isArray(state?.selection) ? state.selection : [];
	const selectedSrc = imageRefToViewUrl(selected.find((item) => item?.filename));
	if (selectedSrc) return selectedSrc;

	const propertySrc = imageRefToViewUrl(parseSelection(sourceNode?.properties?.selected_images).find((item) => item?.filename));
	if (propertySrc) return propertySrc;

	const selectedWidget = widget(sourceNode, "selected_images") || sourceNode?.__gjjSelectedImagesWidget;
	return imageRefToViewUrl(parseSelection(selectedWidget?.value).find((item) => item?.filename));
}

function firstMultiImageLoaderInfo(sourceNode) {
	const state = sourceNode?.__gjjMultiImageState;
	const executed = Array.isArray(state?.executedImages) ? state.executedImages : [];
	const executedInfo = imageRefToViewInfo(executed.find((item) => item?.filename));
	if (executedInfo) return executedInfo;

	const selected = Array.isArray(state?.selection) ? state.selection : [];
	const selectedInfo = imageRefToViewInfo(selected.find((item) => item?.filename));
	if (selectedInfo) return selectedInfo;

	const propertyInfo = imageRefToViewInfo(parseSelection(sourceNode?.properties?.selected_images).find((item) => item?.filename));
	if (propertyInfo) return propertyInfo;

	const selectedWidget = widget(sourceNode, "selected_images") || sourceNode?.__gjjSelectedImagesWidget;
	return imageRefToViewInfo(parseSelection(selectedWidget?.value).find((item) => item?.filename));
}

function firstDomImageSrc(sourceNode) {
	const roots = [
		sourceNode?.__gjjAnyPreviewContainer,
		sourceNode?.__gjjAnyPreviewGrid,
		sourceNode?.__gjjAnyPreviewBody,
		sourceNode?.__gjjTemplateParamsContainer,
		sourceNode?.__gjjTemplateParamsMediaGroup,
		sourceNode?.__gjjTemplateParamsRowsWrap,
		sourceNode?.__gjjMultiImageContainer,
		sourceNode?.__gjjMultiImagePreviewWrap,
	];
	for (const root of roots) {
		const img = root?.querySelector?.("img[src]");
		if (img?.src) return img.src;
	}
	if (sourceNode?.widgets) {
		for (const item of sourceNode.widgets) {
			const img = item?.element?.querySelector?.("img[src]") || item?.inputEl?.querySelector?.("img[src]");
			if (img?.src) return img.src;
		}
	}
	return "";
}

function firstDomImageInfo(sourceNode) {
	const src = firstDomImageSrc(sourceNode);
	if (!src) return null;
	const roots = [
		sourceNode?.__gjjAnyPreviewContainer,
		sourceNode?.__gjjAnyPreviewGrid,
		sourceNode?.__gjjAnyPreviewBody,
		sourceNode?.__gjjTemplateParamsContainer,
		sourceNode?.__gjjTemplateParamsMediaGroup,
		sourceNode?.__gjjTemplateParamsRowsWrap,
		sourceNode?.__gjjMultiImageContainer,
		sourceNode?.__gjjMultiImagePreviewWrap,
	];
	for (const root of roots) {
		const img = root?.querySelector?.(`img[src="${CSS.escape(src)}"]`) || root?.querySelector?.("img[src]");
		if (img?.src === src || img?.src) {
			const width = Number(img.naturalWidth || img.width || 0);
			const height = Number(img.naturalHeight || img.height || 0);
			return { src, width: width > 0 ? width : 0, height: height > 0 ? height : 0 };
		}
	}
	return { src, width: 0, height: 0 };
}

function firstAnyPreviewImageSrc(sourceNode) {
	const images = Array.isArray(sourceNode?.__gjjAnyPreviewImages) ? sourceNode.__gjjAnyPreviewImages : [];
	const items = Array.isArray(sourceNode?.__gjjAnyPreviewItems) ? sourceNode.__gjjAnyPreviewItems : [];
	return imageRefToViewUrl(images.find((item) => item?.filename))
		|| imageRefToViewUrl(items.find((item) => item?.filename))
		|| firstDomImageSrc(sourceNode);
}

function firstAnyPreviewImageInfo(sourceNode) {
	const images = Array.isArray(sourceNode?.__gjjAnyPreviewImages) ? sourceNode.__gjjAnyPreviewImages : [];
	const items = Array.isArray(sourceNode?.__gjjAnyPreviewItems) ? sourceNode.__gjjAnyPreviewItems : [];
	return imageRefToViewInfo(images.find((item) => item?.filename))
		|| imageRefToViewInfo(items.find((item) => item?.filename))
		|| firstDomImageInfo(sourceNode);
}

function getUpstreamImageSrc(node, inputName = "background_image") {
	const sourceNode = sourceNodeFromInput(node, inputName);
	if (!sourceNode) return "";
	const anyPreviewSrc = firstAnyPreviewImageSrc(sourceNode);
	if (anyPreviewSrc) return anyPreviewSrc;
	const multiSrc = firstMultiImageLoaderSrc(sourceNode);
	if (multiSrc) return multiSrc;
	if (Array.isArray(sourceNode.imgs)) {
		const img = sourceNode.imgs.find((item) => item?.src);
		if (img?.src) return img.src;
	}
	if (sourceNode.image?.src) return sourceNode.image.src;
	if (sourceNode.preview?.src) return sourceNode.preview.src;
	const domSrc = firstDomImageSrc(sourceNode);
	if (domSrc) return domSrc;
	if (Array.isArray(sourceNode.images)) {
		const item = sourceNode.images.find((entry) => entry?.src || entry?.url || entry?.filename);
		if (item?.src || item?.url) return item.src || item.url;
		const src = imageRefToViewUrl(item);
		if (src) return src;
	}
	if (sourceNode.comfyClass === "LoadImage" || sourceNode.type === "LoadImage") {
		const file = widget(sourceNode, "image") || widget(sourceNode, "file") || widget(sourceNode, "filename");
		if (file?.value) {
			return api.apiURL(`/view?filename=${encodeURIComponent(file.value)}&type=input&subfolder=&rand=${Date.now()}`);
		}
	}
	return "";
}

function getUpstreamImageInfo(node, inputName = "background_image") {
	const sourceNode = sourceNodeFromInput(node, inputName);
	if (!sourceNode) return null;
	const anyPreviewInfo = firstAnyPreviewImageInfo(sourceNode);
	if (anyPreviewInfo?.src) return anyPreviewInfo;
	const multiInfo = firstMultiImageLoaderInfo(sourceNode);
	if (multiInfo?.src) return multiInfo;
	if (Array.isArray(sourceNode.imgs)) {
		const img = sourceNode.imgs.find((item) => item?.src);
		if (img?.src) return { src: img.src, width: Number(img.naturalWidth || img.width || 0), height: Number(img.naturalHeight || img.height || 0) };
	}
	if (sourceNode.image?.src) return { src: sourceNode.image.src, width: Number(sourceNode.image.naturalWidth || sourceNode.image.width || 0), height: Number(sourceNode.image.naturalHeight || sourceNode.image.height || 0) };
	if (sourceNode.preview?.src) return { src: sourceNode.preview.src, width: Number(sourceNode.preview.naturalWidth || sourceNode.preview.width || 0), height: Number(sourceNode.preview.naturalHeight || sourceNode.preview.height || 0) };
	const domInfo = firstDomImageInfo(sourceNode);
	if (domInfo?.src) return domInfo;
	if (Array.isArray(sourceNode.images)) {
		const item = sourceNode.images.find((entry) => entry?.src || entry?.url || entry?.filename);
		if (item?.src || item?.url) return { src: item.src || item.url, width: Number(item.width || item.w || 0), height: Number(item.height || item.h || 0) };
		const info = imageRefToViewInfo(item);
		if (info) return info;
	}
	if (sourceNode.comfyClass === "LoadImage" || sourceNode.type === "LoadImage") {
		const file = widget(sourceNode, "image") || widget(sourceNode, "file") || widget(sourceNode, "filename");
		if (file?.value) {
			return { src: api.apiURL(`/view?filename=${encodeURIComponent(file.value)}&type=input&subfolder=&rand=${Date.now()}`), width: 0, height: 0 };
		}
	}
	return null;
}

function readLocalFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result || ""));
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

function dataUrlToBlob(dataUrl) {
	const [header, body = ""] = String(dataUrl || "").split(",", 2);
	const mime = header.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
	const binary = header.includes(";base64") ? atob(body) : decodeURIComponent(body);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}

function imageDataUrlToPngFile(dataUrl, filename = "logo.png") {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => {
			const width = Math.max(1, image.naturalWidth || image.width || 512);
			const height = Math.max(1, image.naturalHeight || image.height || 512);
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			ctx.clearRect(0, 0, width, height);
			ctx.drawImage(image, 0, 0, width, height);
			canvas.toBlob((blob) => {
				if (!blob) return reject(new Error("Logo 转 PNG 失败"));
				resolve(new File([blob], filename.replace(/\.[^.]+$/, "") + ".png", { type: "image/png" }));
			}, "image/png");
		};
		image.onerror = () => reject(new Error("Logo 图片解析失败"));
		image.src = dataUrl;
	});
}

async function fetchNetworkLogo(url) {
	const response = await api.fetchApi(FETCH_LOGO_API, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response?.ok || !data?.ok || !data?.src) throw new Error(data?.error || "网络 logo 解析失败");
	return data;
}

function normalizeUploadFilename(data, file, requestedSubfolder = "") {
	const filename = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
	if (!filename) return "";
	if (filename.includes("/")) return filename;
	const subfolder = String(data?.subfolder ?? requestedSubfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadImageToInput(file, subfolder = "gjj_text_overlay_logo") {
	const cleanSubfolder = String(subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const form = new FormData();
	form.append("image", file, file.name);
	form.append("type", "input");
	form.append("overwrite", "true");
	if (cleanSubfolder) form.append("subfolder", cleanSubfolder);
	const response = api?.fetchApi
		? await api.fetchApi("/upload/image", { method: "POST", body: form })
		: await fetch(api.apiURL("/upload/image"), { method: "POST", body: form });
	if (!response?.ok) {
		let detail = "";
		try { detail = await response.text(); } catch (_) {}
		throw new Error(`上传失败：HTTP ${response?.status || "?"}${detail ? ` ${detail}` : ""}`);
	}
	const data = await response.json().catch(() => ({}));
	const filename = normalizeUploadFilename(data, file, cleanSubfolder);
	if (!filename) throw new Error("上传成功但没有返回文件名");
	return filename;
}

function inputImageViewInfo(filename) {
	const value = String(filename || "").replace(/\\/g, "/").trim();
	if (!value) return null;
	const parts = value.split("/");
	const name = parts.pop() || value;
	const subfolder = parts.join("/");
	return {
		src: api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`),
		width: 0,
		height: 0,
	};
}

function viewUrlToImageInfo(src) {
	if (!src) return null;
	try {
		const url = new URL(src, window.location.href);
		const filename = url.searchParams.get("filename") || "";
		if (!filename) return null;
		return {
			filename,
			type: url.searchParams.get("type") || "input",
			subfolder: url.searchParams.get("subfolder") || "",
		};
	} catch (_) {
		return null;
	}
}

async function requestRmbg14Preview(info) {
	const parsed = typeof info === "string" ? viewUrlToImageInfo(info) : {
		filename: info?.filename || info?.name || "",
		type: info?.type || "input",
		subfolder: info?.subfolder || "",
	};
	if (!parsed?.filename) return null;
	const response = await api.fetchApi(RMBG14_PREVIEW_API, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(parsed),
	});
	const data = await response.json().catch(() => ({}));
	if (!response?.ok || !data?.ok || !data?.src) throw new Error(data?.error || "RMBG1.4 预览失败");
	return { src: data.src, width: Number(data.width || 0), height: Number(data.height || 0) };
}

function numberValue(node, name, fallback = 0) {
	const value = Number(widget(node, name)?.value);
	return Number.isFinite(value) ? value : fallback;
}

function stringValue(node, name, fallback = "") {
	return String(widget(node, name)?.value ?? fallback ?? "");
}

function boolValue(node, name, fallback = false) {
	const value = widget(node, name)?.value;
	if (typeof value === "boolean") return value;
	if (value == null) return fallback;
	return ["true", "1", "yes", "on", "是", "开", "启用"].includes(String(value).trim().toLowerCase());
}

function setWidgetValue(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	item.value = value;
	if (PERSISTED_WIDGETS.has(name)) {
		node.properties ||= {};
		node.properties[name] = value;
	}
	if (item.inputEl) {
		if (item.inputEl.type === "checkbox") item.inputEl.checked = Boolean(value);
		else item.inputEl.value = value;
	}
	if (item.element && "value" in item.element) item.element.value = value;
	if (item.element && "checked" in item.element) item.element.checked = Boolean(value);
	item.callback?.(value);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function clamp01(value, fallback = 0.5) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(0, Math.min(1, number));
}

function positionValue(node, name, fallbackName) {
	const raw = numberValue(node, name, -1);
	if (raw >= 0) return clamp01(raw);
	return clamp01(numberValue(node, fallbackName, 0.5));
}

function clampStagePoint(x, y) {
	return {
		x: Number(clamp01(x).toFixed(4)),
		y: Number(clamp01(y).toFixed(4)),
	};
}

function persistPreviewSize(node, kind, width, height) {
	width = Math.round(Number(width || 0));
	height = Math.round(Number(height || 0));
	if (!node || width <= 0 || height <= 0) return;
	node.properties ||= {};
	if (kind === "background") {
		node.properties[SIZE_PROPERTIES.bgWidth] = width;
		node.properties[SIZE_PROPERTIES.bgHeight] = height;
	} else if (kind === "watermark") {
		node.properties[SIZE_PROPERTIES.watermarkWidth] = width;
		node.properties[SIZE_PROPERTIES.watermarkHeight] = height;
	}
}

function setStageAspect(node, width, height) {
	const stage = node?.__gjjTextOverlayUI?.stage;
	if (!stage) return;
	const w = Math.max(1, Number(width || 0));
	const h = Math.max(1, Number(height || 0));
	stage.style.aspectRatio = `${w} / ${h}`;
	stage.style.width = "100%";
	stage.style.maxHeight = "none";
}

function restorePreviewSizes(node) {
	const props = node?.properties || {};
	const bgWidth = Number(props[SIZE_PROPERTIES.bgWidth] || 0);
	const bgHeight = Number(props[SIZE_PROPERTIES.bgHeight] || 0);
	if (bgWidth > 0 && bgHeight > 0) {
		node.__gjjTextOverlayBgSize = { width: bgWidth, height: bgHeight };
		setStageAspect(node, bgWidth, bgHeight);
	}
	const wmWidth = Number(props[SIZE_PROPERTIES.watermarkWidth] || 0);
	const wmHeight = Number(props[SIZE_PROPERTIES.watermarkHeight] || 0);
	if (wmWidth > 0 && wmHeight > 0) {
		node.__gjjTextOverlayWatermarkSize = { width: wmWidth, height: wmHeight };
	}
}

function syncBackgroundSizeFromImage(node) {
	const ui = node.__gjjTextOverlayUI;
	if (node.__gjjTextOverlayBgSize?.width && node.__gjjTextOverlayBgSize?.height) {
		return true;
	}
	const image = ui?.bg;
	const width = Number(image?.naturalWidth || 0);
	const height = Number(image?.naturalHeight || 0);
	if (width > 0 && height > 0) {
		const old = node.__gjjTextOverlayBgSize || {};
		if (old.width !== width || old.height !== height) {
			node.__gjjTextOverlayBgSize = { width, height };
			setStageAspect(node, width, height);
		}
		return true;
	}
	return Boolean(node.__gjjTextOverlayBgSize?.width && node.__gjjTextOverlayBgSize?.height);
}

function setPosition(node, target, x, y) {
	const pos = clampStagePoint(x, y);
	if (target === "watermark") {
		setWidgetValue(node, "watermark_x", pos.x);
		setWidgetValue(node, "watermark_y", pos.y);
	} else {
		setWidgetValue(node, "text_x", pos.x);
		setWidgetValue(node, "text_y", pos.y);
	}
	renderPanel(node);
}

function scheduleRenderPanel(node, options = {}) {
	if (!node) return;
	if (node.__gjjTextOverlayRenderFrame) cancelAnimationFrame(node.__gjjTextOverlayRenderFrame);
	node.__gjjTextOverlayRenderFrame = requestAnimationFrame(() => {
		node.__gjjTextOverlayRenderFrame = 0;
		renderPanel(node, options);
	});
}

function hideWidget(item) {
	if (!item || item.__gjjTextOverlayHidden) return;
	item.__gjjTextOverlayHidden = true;
	item.hidden = true;
	item.computeSize = () => [0, 0];
	item.getHeight = () => 0;
	item.draw = () => {};
	item.label = "";
	item.last_y = 0;
	item.computedHeight = 0;
	item.size = [0, 0];
	item.serialize = true;
	item.options ||= {};
	item.options.hidden = true;
	item.options.display = "hidden";
	if (item.element) item.element.style.display = "none";
	if (item.inputEl) item.inputEl.style.display = "none";
}

function hideNativeWidgets(node) {
	for (const name of HIDDEN_WIDGETS) hideWidget(widget(node, name));
}

function installStyles() {
	if (document.getElementById("gjj-text-overlay-live-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-text-overlay-live-style";
	style.textContent = `
		.gjj-text-overlay-panel{width:100%;display:flex;flex-direction:column;gap:5px;color:#dce7e2;font:12px system-ui,"Microsoft YaHei",sans-serif;box-sizing:border-box;overflow:hidden;padding:0 2px 3px;}
		.gjj-text-overlay-toolbar{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;}
		.gjj-text-overlay-settings{display:none;flex-wrap:wrap;align-items:flex-start;gap:5px;min-width:0;}
		.gjj-text-overlay-settings[data-open="true"]{display:flex;}
		.gjj-text-overlay-icon-button{width:26px;height:24px;min-width:26px;border:1px solid #3c5058;border-radius:6px;background:#17252b;color:#f3fbfb;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
		.gjj-text-overlay-icon-button:hover{background:#213942;border-color:#63838d;}
		.gjj-text-overlay-icon-button[data-active="true"]{background:#244850;border-color:#82b9c5;}
		.gjj-text-overlay-preview{position:relative;width:100%;min-width:0;border:1px solid #34484f;border-radius:7px;background:#10181c;overflow:hidden;display:flex;justify-content:center;}
		.gjj-text-overlay-status{position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);padding:3px 7px;border-radius:6px;background:rgba(8,14,17,.72);color:#b7cbd0;font-size:11px;line-height:1.3;pointer-events:none;opacity:0;transition:opacity .15s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.gjj-text-overlay-status[data-show="true"]{opacity:1;}
		.gjj-text-overlay-stage{position:relative;width:100%;aspect-ratio:16/9;background:linear-gradient(45deg,#182126 25%,#121a1e 25%,#121a1e 50%,#182126 50%,#182126 75%,#121a1e 75%);background-size:22px 22px;overflow:hidden;margin:0 auto;}
		.gjj-text-overlay-base{position:absolute;inset:0;background:radial-gradient(circle at 30% 25%,rgba(112,151,163,.35),transparent 35%),linear-gradient(135deg,#202c32,#0d1418);opacity:.9;}
		.gjj-text-overlay-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:none;}
		.gjj-text-overlay-item{position:absolute;left:50%;top:50%;user-select:none;touch-action:none;cursor:grab;border:1px solid transparent;border-radius:5px;}
		.gjj-text-overlay-item:active{cursor:grabbing;}
		.gjj-text-overlay-item[data-active="true"]{border-color:#7fa7b3;box-shadow:0 0 0 2px rgba(127,167,179,.22);}
		.gjj-text-overlay-text{display:block;max-width:none;padding:0;image-rendering:auto;}
		.gjj-text-overlay-text-img{display:block;width:100%;height:100%;pointer-events:none;}
		.gjj-text-overlay-resize{position:absolute;width:14px;height:14px;border:2px solid #071014;border-radius:50%;background:#ffd84d;box-shadow:0 0 0 1px rgba(255,255,255,.7);display:none;z-index:3;}
		.gjj-text-overlay-resize[data-corner="nw"]{left:2px;top:2px;cursor:nwse-resize;}
		.gjj-text-overlay-resize[data-corner="se"]{right:2px;bottom:2px;cursor:nwse-resize;}
		.gjj-text-overlay-item[data-active="true"] .gjj-text-overlay-resize{display:block;}
		.gjj-text-overlay-watermark{width:72px;height:46px;background:transparent;display:flex;align-items:center;justify-content:center;color:#ecfff6;font-weight:800;letter-spacing:0;border-radius:0;}
		.gjj-text-overlay-watermark[data-active="true"]{border-color:transparent;box-shadow:none;}
		.gjj-text-overlay-watermark-img{display:none;width:100%;height:100%;object-fit:contain;pointer-events:none;}
		.gjj-text-overlay-section{width:132px;min-width:132px;height:54px;border:1px solid #2d4148;border-radius:7px;background:#0f171b;padding:5px;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;overflow:hidden;}
		.gjj-text-overlay-wide{width:220px;min-width:220px;height:54px;}
		.gjj-text-overlay-action{width:118px;min-width:118px;height:54px;}
		.gjj-text-overlay-check{width:96px;min-width:96px;height:54px;display:flex;gap:6px;align-items:center;justify-content:center;color:#c9d8dc;border:1px solid #2d4148;border-radius:7px;background:#0f171b;padding:5px;box-sizing:border-box;}
		.gjj-text-overlay-label{color:#9fb0b7;font-size:11px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.gjj-text-overlay-input,.gjj-text-overlay-select{width:100%;min-width:0;height:27px;border:1px solid #3c5058;border-radius:7px;background:#23282b;color:#f1f5f5;padding:3px 7px;box-sizing:border-box;font-size:12px;}
		.gjj-text-overlay-textarea{height:56px;min-height:56px;resize:none;line-height:1.35;}
		.gjj-text-overlay-row{display:grid;grid-template-columns:1fr auto;gap:5px;align-items:center;}
		.gjj-text-overlay-swatch{width:29px;height:27px;border:1px solid #3c5058;border-radius:7px;background:#222;cursor:pointer;padding:0;}
		.gjj-text-overlay-range{width:100%;accent-color:#7fa7b3;}
		.gjj-text-overlay-button{width:100%;height:27px;border:1px solid #4a6871;border-radius:7px;background:#183038;color:#ecfffb;font-size:12px;font-weight:700;cursor:pointer;}
		.gjj-text-overlay-button:hover{background:#20414a;}
		.gjj-text-overlay-segmented{height:27px;display:grid;grid-template-columns:1fr 1fr;gap:4px;}
		.gjj-text-overlay-segmented button{border:1px solid #3c5058;border-radius:7px;background:#182329;color:#c7d5d9;font-size:12px;font-weight:700;cursor:pointer;}
		.gjj-text-overlay-segmented button[data-active="true"]{background:#244850;border-color:#82b9c5;color:#fff;}
	`;
	document.head.appendChild(style);
}

function control(node, col, label, name, kind = "text", options = {}) {
	const item = widget(node, name);
	if (!item) return null;
	const wrap = document.createElement("label");
	wrap.className = "gjj-text-overlay-section";
	if (options.wide) wrap.classList.add("gjj-text-overlay-wide");
	const title = document.createElement("div");
	title.className = "gjj-text-overlay-label";
	title.textContent = label;
	wrap.appendChild(title);
	let field;
	if (kind === "textarea") {
		field = document.createElement("textarea");
		field.className = "gjj-text-overlay-input gjj-text-overlay-textarea";
		field.value = item.value ?? "";
		field.addEventListener("input", () => {
			setWidgetValue(node, name, field.value);
			renderPanel(node);
		});
	} else if (kind === "select") {
		field = document.createElement("select");
		field.className = "gjj-text-overlay-select";
		const values = options.values || item.options?.values || item.options?.comboValues || item.values || [];
		for (const value of values) {
			const opt = document.createElement("option");
			opt.value = value;
			opt.textContent = value;
			field.appendChild(opt);
		}
		field.value = item.value;
		field.addEventListener("change", () => {
			setWidgetValue(node, name, field.value);
			renderPanel(node);
		});
	} else if (kind === "checkbox") {
		wrap.className = "gjj-text-overlay-check";
		field = document.createElement("input");
		field.type = "checkbox";
		field.checked = Boolean(item.value);
		wrap.append(field, title);
		field.addEventListener("change", () => {
			setWidgetValue(node, name, field.checked);
			renderPanel(node);
		});
		col.appendChild(wrap);
		return field;
	} else if (kind === "color") {
		const row = document.createElement("div");
		row.className = "gjj-text-overlay-row";
		field = document.createElement("input");
		field.className = "gjj-text-overlay-input";
		field.value = item.value || "#000000";
		const swatch = document.createElement("input");
		swatch.type = "color";
		swatch.className = "gjj-text-overlay-swatch";
		swatch.value = /^#[0-9a-f]{6}$/i.test(field.value) ? field.value : "#000000";
		const sync = (value) => {
			field.value = value;
			swatch.value = /^#[0-9a-f]{6}$/i.test(value) ? value : swatch.value;
			setWidgetValue(node, name, value);
			renderPanel(node);
		};
		field.addEventListener("change", () => sync(field.value));
		swatch.addEventListener("input", () => sync(swatch.value));
		row.append(field, swatch);
		wrap.appendChild(row);
		col.appendChild(wrap);
		return field;
	} else {
		field = document.createElement("input");
		field.className = "gjj-text-overlay-input";
		field.type = kind === "number" ? "number" : "text";
		if (kind === "range") {
			field.type = "range";
			field.className = "gjj-text-overlay-range";
		}
		field.value = item.value ?? "";
		if (options.min != null) field.min = options.min;
		if (options.max != null) field.max = options.max;
		if (options.step != null) field.step = options.step;
		field.addEventListener(kind === "range" ? "input" : "change", () => {
			const value = kind === "number" || kind === "range" ? Number(field.value) : field.value;
			setWidgetValue(node, name, value);
			renderPanel(node);
		});
	}
	wrap.appendChild(field);
	col.appendChild(wrap);
	return field;
}

function segmentedControl(node, col, label, name, values) {
	const item = widget(node, name);
	if (!item) return null;
	const wrap = document.createElement("div");
	wrap.className = "gjj-text-overlay-section";
	const title = document.createElement("div");
	title.className = "gjj-text-overlay-label";
	title.textContent = label;
	const row = document.createElement("div");
	row.className = "gjj-text-overlay-segmented";
	const update = () => {
		for (const button of row.children) {
			button.dataset.active = button.dataset.value === String(item.value) ? "true" : "false";
		}
	};
	for (const value of values) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = value;
		button.dataset.value = value;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(node, name, value);
			update();
			renderPanel(node);
		});
		row.appendChild(button);
	}
	wrap.append(title, row);
	col.appendChild(wrap);
	update();
	return row;
}

function makePanel(node) {
	installStyles();
	const root = document.createElement("div");
	root.className = "gjj-text-overlay-panel";

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-text-overlay-toolbar";
	const preview = document.createElement("div");
	preview.className = "gjj-text-overlay-preview";
	const status = document.createElement("div");
	status.className = "gjj-text-overlay-status";
	const stage = document.createElement("div");
	stage.className = "gjj-text-overlay-stage";
	const base = document.createElement("div");
	base.className = "gjj-text-overlay-base";
	const bg = document.createElement("img");
	bg.className = "gjj-text-overlay-bg";
	bg.alt = "";
	const text = document.createElement("div");
	text.className = "gjj-text-overlay-item gjj-text-overlay-text";
	text.dataset.kind = "text";
	const textImg = document.createElement("img");
	textImg.className = "gjj-text-overlay-text-img";
	textImg.alt = "";
	textImg.draggable = false;
	const textResizeNw = document.createElement("div");
	textResizeNw.className = "gjj-text-overlay-resize";
	textResizeNw.dataset.corner = "nw";
	const textResizeSe = document.createElement("div");
	textResizeSe.className = "gjj-text-overlay-resize";
	textResizeSe.dataset.corner = "se";
	text.append(textImg, textResizeNw, textResizeSe);
	const watermark = document.createElement("div");
	watermark.className = "gjj-text-overlay-item gjj-text-overlay-watermark";
	watermark.dataset.kind = "watermark";
	const watermarkImg = document.createElement("img");
	watermarkImg.className = "gjj-text-overlay-watermark-img";
	watermarkImg.alt = "";
	watermarkImg.draggable = false;
	const watermarkResizeNw = document.createElement("div");
	watermarkResizeNw.className = "gjj-text-overlay-resize";
	watermarkResizeNw.dataset.corner = "nw";
	const watermarkResizeSe = document.createElement("div");
	watermarkResizeSe.className = "gjj-text-overlay-resize";
	watermarkResizeSe.dataset.corner = "se";
	watermark.append(watermarkImg, watermarkResizeNw, watermarkResizeSe);
	stage.append(base, bg, watermark, text);
	preview.append(stage, status);

	const settings = document.createElement("div");
	settings.className = "gjj-text-overlay-settings";
	settings.dataset.open = node.properties?.gjj_text_overlay_settings_open ? "true" : "false";
	root.append(toolbar, settings, preview);

	for (const el of [root, toolbar, settings, preview, stage]) {
		for (const name of ["pointerdown", "mousedown", "wheel"]) {
			el.addEventListener(name, (event) => event.stopPropagation());
		}
	}

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "image/png,image/jpeg,image/webp,image/bmp";
	fileInput.style.display = "none";
	document.body.appendChild(fileInput);

	const logoFileInput = document.createElement("input");
	logoFileInput.type = "file";
	logoFileInput.accept = "image/png,image/jpeg,image/webp,image/bmp";
	logoFileInput.style.display = "none";
	document.body.appendChild(logoFileInput);

	const addIconButton = (icon, title, callback) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-text-overlay-icon-button";
		button.textContent = icon;
		button.title = title;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			callback(button);
		});
		toolbar.appendChild(button);
		return button;
	};

	addIconButton("📂", "打开本地背景图", () => fileInput.click());
	const backgroundLinkButton = addIconButton("🔗", "断开背景图上游链接", () => toggleRememberedInputLink(node, "background_image"));
	backgroundLinkButton.style.display = "none";
	addIconButton("🧩", "打开本地 logo，并使用 RMBG1.4 抠图预览", () => logoFileInput.click());
	const watermarkLinkButton = addIconButton("🔗", "断开水印图上游链接", () => toggleRememberedInputLink(node, "watermark_image"));
	watermarkLinkButton.style.display = "none";
	addIconButton("🌏", "设置网络默认 logo", async () => {
		const current = stringValue(node, "logo_default_url", "") || DEFAULT_LOGO_URL;
		const url = window.prompt("网络默认 logo URL", current);
		if (!url) return;
		try {
			if (status) {
				status.textContent = "正在解析网络 logo...";
				status.dataset.show = "true";
			}
			const data = await fetchNetworkLogo(url.trim());
			setWatermarkPreviewImage(node, { src: data.src });
			const file = await imageDataUrlToPngFile(data.src, data.filename || "logo.png");
			const filename = await uploadImageToInput(file);
			setWidgetValue(node, "logo_default_url", url.trim());
			setWidgetValue(node, "watermark_upload_name", filename);
			node.__gjjTextOverlayWatermarkSrc = data.src;
			node.__gjjTextOverlayWatermarkSourceKey = `upload:${filename}`;
			if (boolValue(node, "logo_remove_bg", true)) {
				try {
					const cutout = await requestRmbg14Preview({ filename, type: "input", subfolder: "" });
					if (cutout?.src) {
						node.__gjjTextOverlayWatermarkSrc = cutout.src;
						setWatermarkPreviewImage(node, cutout);
					}
				} catch (error) {
					console.warn("[GJJ_TextOverlay] RMBG1.4 网络 logo 预览失败", error);
				}
			}
			if (status) {
				status.textContent = "网络默认 logo 已设置";
				clearTimeout(node.__gjjTextOverlayStatusTimer);
				node.__gjjTextOverlayStatusTimer = setTimeout(() => { status.dataset.show = "false"; }, 1400);
			}
			renderPanel(node);
		} catch (error) {
			console.warn("[GJJ_TextOverlay] 网络 logo 设置失败", error);
			if (status) {
				status.textContent = `网络 logo 设置失败：${error?.message || error}`;
				status.dataset.show = "true";
			}
		}
	});
	addIconButton("🌘", "开关 logo 阴影", (button) => {
		const next = !boolValue(node, "logo_shadow_enabled", false);
		setWidgetValue(node, "logo_shadow_enabled", next);
		button.dataset.active = next ? "true" : "false";
		renderPanel(node);
	});
	addIconButton("✒️", "开关 logo 描边", (button) => {
		const next = !boolValue(node, "logo_stroke_enabled", false);
		setWidgetValue(node, "logo_stroke_enabled", next);
		button.dataset.active = next ? "true" : "false";
		renderPanel(node);
	});
	const settingsButton = addIconButton("⚙️", "其它设置", (button) => {
		const open = settings.dataset.open !== "true";
		settings.dataset.open = open ? "true" : "false";
		button.dataset.active = open ? "true" : "false";
		node.properties ||= {};
		node.properties.gjj_text_overlay_settings_open = open;
		setStageAspect(node, node.__gjjTextOverlayBgSize?.width || 16, node.__gjjTextOverlayBgSize?.height || 9);
		updatePanelHeight(node);
	});
	settingsButton.dataset.active = settings.dataset.open === "true" ? "true" : "false";

	control(node, settings, "文本", "texts", "text", { wide: true });
	control(node, settings, "字体", "font_path", "select");
	control(node, settings, "文字透明度", "text_opacity", "range", { min: 0, max: 1, step: 0.01 });
	segmentedControl(node, settings, "方向", "direction", ["横向", "纵向"]);
	control(node, settings, "字间距", "spacing", "number", { step: 0.1 });
	control(node, settings, "文字颜色", "color_hex", "color");
	control(node, settings, "描边颜色", "stroke_color_hex", "color");
	control(node, settings, "启用描边", "use_stroke", "checkbox");
	control(node, settings, "描边宽度", "stroke_width", "number", { min: 0, step: 1 });
	control(node, settings, "水印透明度", "watermark_opacity", "range", { min: 0, max: 1, step: 0.01 });
	control(node, settings, "RMBG1.4抠图", "logo_remove_bg", "checkbox");
	control(node, settings, "Logo阴影模糊", "logo_shadow_blur", "number", { min: 0, step: 0.5 });
	control(node, settings, "Logo阴影X", "logo_shadow_x", "number", { step: 1 });
	control(node, settings, "Logo阴影Y", "logo_shadow_y", "number", { step: 1 });
	control(node, settings, "Logo阴影颜色", "logo_shadow_color_hex", "color");
	control(node, settings, "Logo描边宽度", "logo_stroke_width", "number", { min: 0, step: 1 });
	control(node, settings, "Logo描边颜色", "logo_stroke_color_hex", "color");

	fileInput.addEventListener("change", async () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		try {
			setBackgroundImage(node, await readLocalFile(file), file.name);
		} catch (error) {
			console.warn("[GJJ_TextOverlay] 打开背景预览失败", error);
		} finally {
			fileInput.value = "";
		}
	});

	logoFileInput.addEventListener("change", async () => {
		const file = logoFileInput.files?.[0];
		if (!file) return;
		try {
			const src = await readLocalFile(file);
			setWatermarkPreviewImage(node, { src });
			const filename = await uploadImageToInput(file);
			setWidgetValue(node, "watermark_upload_name", filename);
			node.__gjjTextOverlayWatermarkSrc = src;
			node.__gjjTextOverlayWatermarkSourceKey = `upload:${filename}`;
			if (boolValue(node, "logo_remove_bg", true)) {
				try {
					const cutout = await requestRmbg14Preview({ filename, type: "input", subfolder: "" });
					if (cutout?.src) {
						node.__gjjTextOverlayWatermarkSrc = cutout.src;
						setWatermarkPreviewImage(node, cutout);
					}
				} catch (error) {
					console.warn("[GJJ_TextOverlay] RMBG1.4 logo 预览失败", error);
				}
			}
			if (status) {
				status.textContent = boolValue(node, "logo_remove_bg", true) ? "Logo 已选择，执行时使用 RMBG1.4 抠图" : "Logo 已选择";
				status.dataset.show = "true";
				clearTimeout(node.__gjjTextOverlayStatusTimer);
				node.__gjjTextOverlayStatusTimer = setTimeout(() => { status.dataset.show = "false"; }, 1400);
			}
			renderPanel(node);
		} catch (error) {
			console.warn("[GJJ_TextOverlay] 打开 logo 失败", error);
			if (status) {
				status.textContent = "Logo 打开失败";
				status.dataset.show = "true";
			}
		} finally {
			logoFileInput.value = "";
		}
	});

	const activate = (kind) => {
		node.__gjjTextOverlayActive = kind;
		text.dataset.active = kind === "text" ? "true" : "false";
		watermark.dataset.active = kind === "watermark" ? "true" : "false";
	};
	text.addEventListener("pointerdown", () => activate("text"));
	watermark.addEventListener("pointerdown", () => activate("watermark"));

	let dragging = "";
	let dragOffset = { x: 0, y: 0 };
	let resizingKind = "";
	let resizeStart = null;
	const drag = (event, kind = dragging) => {
		if (!kind) return;
		const rect = stage.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		const x = (event.clientX - rect.left - dragOffset.x) / rect.width;
		const y = (event.clientY - rect.top - dragOffset.y) / rect.height;
		setPosition(node, kind, x, y);
	};
	const startResize = (event, kind, corner, element) => {
		event.preventDefault();
		event.stopPropagation();
		resizingKind = kind;
		dragging = "";
		activate(kind);
		const target = kind === "watermark" ? watermark : text;
		const rect = target.getBoundingClientRect();
		const stageRect = stage.getBoundingClientRect();
		const left = rect.left - stageRect.left;
		const top = rect.top - stageRect.top;
		const width = Math.max(1, rect.width);
		const height = Math.max(1, rect.height);
		resizeStart = {
			x: event.clientX,
			y: event.clientY,
			corner,
			width,
			height,
			left,
			top,
			anchorX: corner === "nw" ? left + width : left,
			anchorY: corner === "nw" ? top + height : top,
			stageWidth: Math.max(1, stageRect.width),
			stageHeight: Math.max(1, stageRect.height),
			fontSize: Math.max(1, numberValue(node, "font_size", 48)),
			watermarkWidth: Math.max(0.1, numberValue(node, "watermark_width", 1)),
		};
		element.setPointerCapture?.(event.pointerId);
	};
	textResizeNw.addEventListener("pointerdown", (event) => startResize(event, "text", "nw", textResizeNw));
	textResizeSe.addEventListener("pointerdown", (event) => startResize(event, "text", "se", textResizeSe));
	watermarkResizeNw.addEventListener("pointerdown", (event) => startResize(event, "watermark", "nw", watermarkResizeNw));
	watermarkResizeSe.addEventListener("pointerdown", (event) => startResize(event, "watermark", "se", watermarkResizeSe));
	for (const item of [text, watermark]) {
		item.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			dragging = item.dataset.kind;
			activate(dragging);
			const itemRect = item.getBoundingClientRect();
			dragOffset = {
				x: event.clientX - itemRect.left,
				y: event.clientY - itemRect.top,
			};
			item.setPointerCapture?.(event.pointerId);
			drag(event, dragging);
		});
	}
	stage.addEventListener("pointerdown", (event) => {
		if (event.target !== stage && event.target !== base && event.target !== bg) return;
		event.preventDefault();
		dragging = node.__gjjTextOverlayActive || "text";
		dragOffset = { x: 0, y: 0 };
		drag(event, dragging);
	});
	stage.addEventListener("pointermove", (event) => {
		if (resizingKind && resizeStart) {
			event.preventDefault();
			const stageRect = stage.getBoundingClientRect();
			const pointerX = Math.max(0, Math.min(resizeStart.stageWidth, event.clientX - stageRect.left));
			const pointerY = Math.max(0, Math.min(resizeStart.stageHeight, event.clientY - stageRect.top));
			const widthRatio = Math.abs(pointerX - resizeStart.anchorX) / resizeStart.width;
			const heightRatio = Math.abs(pointerY - resizeStart.anchorY) / resizeStart.height;
			const rawRatio = Math.max(widthRatio, heightRatio);
			const maxWidthRatio = resizeStart.corner === "nw"
				? resizeStart.anchorX / resizeStart.width
				: (resizeStart.stageWidth - resizeStart.anchorX) / resizeStart.width;
			const maxHeightRatio = resizeStart.corner === "nw"
				? resizeStart.anchorY / resizeStart.height
				: (resizeStart.stageHeight - resizeStart.anchorY) / resizeStart.height;
			const maxRatio = Math.max(0.01, Math.min(10, maxWidthRatio, maxHeightRatio));
			const minRatio = Math.min(0.1, maxRatio);
			const ratio = Math.max(minRatio, Math.min(maxRatio, rawRatio));
			const nextWidth = resizeStart.width * ratio;
			const nextHeight = resizeStart.height * ratio;
			if (resizingKind === "text") {
				const nextSize = Math.max(1, Math.min(512, Math.round(resizeStart.fontSize * ratio)));
				setWidgetValue(node, "font_size", nextSize);
			} else {
				const nextScale = Math.max(0.1, Math.min(10, Number((resizeStart.watermarkWidth * ratio).toFixed(4))));
				setWidgetValue(node, "watermark_width", nextScale);
			}
			if (resizeStart.corner === "nw") {
				const nextLeft = (resizeStart.left + resizeStart.width - nextWidth) / resizeStart.stageWidth;
				const nextTop = (resizeStart.top + resizeStart.height - nextHeight) / resizeStart.stageHeight;
				const pos = clampStagePoint(nextLeft, nextTop);
				if (resizingKind === "watermark") {
					setWidgetValue(node, "watermark_x", pos.x);
					setWidgetValue(node, "watermark_y", pos.y);
				} else {
					setWidgetValue(node, "text_x", pos.x);
					setWidgetValue(node, "text_y", pos.y);
				}
			} else {
				const pos = clampStagePoint(
					resizeStart.left / resizeStart.stageWidth,
					resizeStart.top / resizeStart.stageHeight,
				);
				if (resizingKind === "watermark") {
					setWidgetValue(node, "watermark_x", pos.x);
					setWidgetValue(node, "watermark_y", pos.y);
				} else {
					setWidgetValue(node, "text_x", pos.x);
					setWidgetValue(node, "text_y", pos.y);
				}
			}
			renderPanel(node);
			return;
		}
		if (!dragging) return;
		event.preventDefault();
		drag(event, dragging);
	});
	stage.addEventListener("pointerup", () => { dragging = ""; resizingKind = ""; resizeStart = null; });
	stage.addEventListener("pointerleave", () => { dragging = ""; resizingKind = ""; resizeStart = null; });

	let observedStageWidth = 0;
	const resizeObserver = new ResizeObserver(() => {
		updatePanelHeight(node);
		const nextStageWidth = Math.round(stage.clientWidth || 0);
		if (nextStageWidth > 1 && nextStageWidth !== observedStageWidth) {
			observedStageWidth = nextStageWidth;
			scheduleRenderPanel(node);
		}
	});
	resizeObserver.observe(root);
	const originalRemoved = node.onRemoved;
	node.onRemoved = function (...args) {
		if (node.__gjjTextOverlayRenderFrame) {
			cancelAnimationFrame(node.__gjjTextOverlayRenderFrame);
			node.__gjjTextOverlayRenderFrame = 0;
		}
		resizeObserver.disconnect();
		fileInput.remove();
		logoFileInput.remove();
		return originalRemoved?.apply(this, args);
	};

	node.__gjjTextOverlayUI = { root, toolbar, settings, preview, status, stage, base, bg, text, textImg, textResizeNw, textResizeSe, watermark, watermarkImg, watermarkResizeNw, watermarkResizeSe, backgroundLinkButton, watermarkLinkButton, activate };
	activate(node.__gjjTextOverlayActive || "text");
	updateLinkToggleButtons(node);
	scheduleRenderPanel(node);
	setTimeout(() => refreshBackground(node, false), 300);
	setTimeout(() => refreshWatermarkPreview(node, true), 450);
	return root;
}

function updatePanelHeight(node) {
	const root = node.__gjjTextOverlayUI?.root;
	if (!root) return;
	const height = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, Math.ceil(root.scrollHeight + 8)));
	node.__gjjTextOverlayHeight = height;
	node.__gjjTextOverlayPanelWidget?.callback?.();
	if (!node.__gjjTextOverlaySizing) {
		node.__gjjTextOverlaySizing = true;
		requestAnimationFrame(() => {
			try {
				const computed = node.computeSize?.() || node.size || [];
				const width = Math.round(Number(node.size?.[0] || computed[0] || 360));
				const targetHeight = Math.max(PANEL_MIN_HEIGHT + 34, Math.round(Number(computed[1] || height + 34)));
				if (Math.abs(Number(node.size?.[1] || 0) - targetHeight) > 2) {
					node.setSize?.([width, targetHeight]);
				}
			} finally {
				node.__gjjTextOverlaySizing = false;
			}
			node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		});
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function setBackgroundImage(node, info, label = "") {
	const ui = node.__gjjTextOverlayUI;
	const src = typeof info === "string" ? info : info?.src;
	if (!ui || !src) return;
	const preferredWidth = Number(info?.width || 0);
	const preferredHeight = Number(info?.height || 0);
	if (preferredWidth > 0 && preferredHeight > 0) {
		node.__gjjTextOverlayBgSize = { width: preferredWidth, height: preferredHeight };
		persistPreviewSize(node, "background", preferredWidth, preferredHeight);
		setStageAspect(node, preferredWidth, preferredHeight);
	}
	const image = new Image();
	image.crossOrigin = "anonymous";
	image.onload = () => {
		const width = preferredWidth || image.naturalWidth || image.width || 16;
		const height = preferredHeight || image.naturalHeight || image.height || 9;
		node.__gjjTextOverlayBgSize = { width, height };
		persistPreviewSize(node, "background", width, height);
		ui.bg.src = src;
		ui.bg.style.display = "block";
		ui.base.style.opacity = "0";
		setStageAspect(node, width, height);
		ui.preview.title = label ? `${label} · ${width}×${height}` : `${width}×${height}`;
		node.__gjjTextOverlayBgSrc = src;
		updatePanelHeight(node);
		scheduleRenderPanel(node);
	};
	image.onerror = () => {
		if (label) ui.preview.title = `${label} 加载失败`;
	};
	image.src = src;
}

function setWatermarkPreviewImage(node, info) {
	const ui = node.__gjjTextOverlayUI;
	const src = typeof info === "string" ? info : info?.src;
	if (!ui || !src) return;
	const image = new Image();
	image.crossOrigin = "anonymous";
	image.onload = () => {
		const width = Number(info?.width || 0) || image.naturalWidth || image.width || 72;
		const height = Number(info?.height || 0) || image.naturalHeight || image.height || 72;
		node.__gjjTextOverlayWatermarkSize = { width, height };
		persistPreviewSize(node, "watermark", width, height);
		ui.watermarkImg.src = src;
		ui.watermarkImg.style.display = "block";
		ui.watermark.style.background = "transparent";
		ui.watermark.style.display = "flex";
		updateWatermarkPreviewStyle(node);
		scheduleRenderPanel(node, { fitText: false });
	};
	image.onerror = () => {
		node.__gjjTextOverlayWatermarkSize = null;
	};
	image.src = src;
}

function refreshWatermarkPreview(node, force = false) {
	const info = getUpstreamImageInfo(node, "watermark_image");
	const src = info?.src || "";
	const ui = node.__gjjTextOverlayUI;
	if (!src) {
		const uploaded = stringValue(node, "watermark_upload_name", "");
		if (uploaded) {
			const sourceKey = `upload:${uploaded}`;
			if (!force && node.__gjjTextOverlayWatermarkSourceKey === sourceKey && ui?.watermarkImg?.src) return true;
			node.__gjjTextOverlayWatermarkSourceKey = sourceKey;
			if (!node.__gjjTextOverlayWatermarkSrc || force || !ui?.watermarkImg?.src) {
				const uploadedInfo = inputImageViewInfo(uploaded);
				if (uploadedInfo?.src) {
					node.__gjjTextOverlayWatermarkSrc = uploadedInfo.src;
					setWatermarkPreviewImage(node, uploadedInfo);
					if (boolValue(node, "logo_remove_bg", true)) {
						requestRmbg14Preview({ filename: uploaded, type: "input", subfolder: "" })
							.then((cutout) => {
								if (!cutout?.src || node.__gjjTextOverlayWatermarkSourceKey !== sourceKey) return;
								node.__gjjTextOverlayWatermarkSrc = cutout.src;
								setWatermarkPreviewImage(node, cutout);
							})
							.catch((error) => console.warn("[GJJ_TextOverlay] RMBG1.4 logo 预览失败", error));
					}
				}
			}
			return true;
		}
		const defaultUrl = stringValue(node, "logo_default_url", "");
		if (defaultUrl) {
			const sourceKey = `url:${defaultUrl}`;
			if (!node.__gjjTextOverlayDefaultLogoLoading && (force || node.__gjjTextOverlayWatermarkSourceKey !== sourceKey)) {
				node.__gjjTextOverlayDefaultLogoLoading = true;
				fetchNetworkLogo(defaultUrl)
					.then(async (data) => {
						setWatermarkPreviewImage(node, { src: data.src });
						const file = await imageDataUrlToPngFile(data.src, data.filename || "logo.png");
						const filename = await uploadImageToInput(file);
						setWidgetValue(node, "watermark_upload_name", filename);
						node.__gjjTextOverlayWatermarkSourceKey = `upload:${filename}`;
						node.__gjjTextOverlayWatermarkSrc = data.src;
						if (boolValue(node, "logo_remove_bg", true)) {
							const cutout = await requestRmbg14Preview({ filename, type: "input", subfolder: "" });
							if (cutout?.src) {
								node.__gjjTextOverlayWatermarkSrc = cutout.src;
								setWatermarkPreviewImage(node, cutout);
							}
						}
						renderPanel(node);
					})
					.catch((error) => console.warn("[GJJ_TextOverlay] 默认网络 logo 恢复失败", error))
					.finally(() => { node.__gjjTextOverlayDefaultLogoLoading = false; });
			}
			return true;
		}
		node.__gjjTextOverlayWatermarkSrc = "";
		node.__gjjTextOverlayWatermarkSourceKey = "";
		if (ui?.watermarkImg) ui.watermarkImg.removeAttribute("src");
		if (ui?.watermark) ui.watermark.style.display = "none";
		if (force && ui?.status) {
			ui.status.textContent = "未找到上游水印图片预览，请先执行上游节点。";
			ui.status.dataset.show = "true";
			clearTimeout(node.__gjjTextOverlayStatusTimer);
			node.__gjjTextOverlayStatusTimer = setTimeout(() => { ui.status.dataset.show = "false"; }, 2200);
		}
		return false;
	}
	const sourceKey = `src:${src}`;
	if (!force && node.__gjjTextOverlayWatermarkSourceKey === sourceKey && ui?.watermarkImg?.src) return true;
	node.__gjjTextOverlayWatermarkSourceKey = sourceKey;
	node.__gjjTextOverlayWatermarkSrc = src;
	setWatermarkPreviewImage(node, info);
	if (boolValue(node, "logo_remove_bg", true)) {
		const parsed = viewUrlToImageInfo(src);
		if (parsed?.filename) {
			requestRmbg14Preview(parsed)
				.then((cutout) => {
					if (!cutout?.src || node.__gjjTextOverlayWatermarkSourceKey !== sourceKey) return;
					node.__gjjTextOverlayWatermarkSrc = cutout.src;
					setWatermarkPreviewImage(node, cutout);
				})
				.catch((error) => console.warn("[GJJ_TextOverlay] RMBG1.4 logo 预览失败", error));
		}
	}
	return true;
}

function drawTextPreviewImage(node) {
	const rawText = stringValue(node, "texts", "").replace(/\s*\r?\n\s*/g, " ").trim();
	if (!rawText) return null;
	const lines = [rawText];
	syncBackgroundSizeFromImage(node);
	const stageWidth = Math.max(1, node.__gjjTextOverlayUI?.stage?.clientWidth || 1);
	const bgWidth = Math.max(1, node.__gjjTextOverlayBgSize?.width || stageWidth);
	const displayScale = stageWidth / bgWidth;
	const fontSize = Math.max(1, numberValue(node, "font_size", 48)) * displayScale;
	const spacing = numberValue(node, "spacing", 0) * displayScale;
	const strokeWidth = boolValue(node, "use_stroke", true)
		? Math.max(0, numberValue(node, "stroke_width", 2) * displayScale)
		: 0;
	const pad = Math.ceil(strokeWidth + Math.max(2, fontSize * 0.08));
	const familyRaw = stringValue(node, "font_path", "");
	const familyName = familyRaw ? familyRaw.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ") : "Microsoft YaHei";
	const font = `800 ${fontSize}px "${familyName}","Microsoft YaHei",sans-serif`;
	const isVertical = stringValue(node, "direction", "横向") === "纵向";
	const measureCanvas = document.createElement("canvas");
	const measure = measureCanvas.getContext("2d");
	measure.font = font;
	measure.textBaseline = "top";
	const lineGap = Math.max(2, fontSize * 0.22);
	const charHeight = fontSize * 1.08;
	let width = 1;
	let height = 1;

	if (isVertical) {
		const colWidths = lines.map((line) => {
			const chars = Array.from(line || " ");
			return Math.max(...chars.map((ch) => measure.measureText(ch).width), fontSize * 0.65);
		});
		width = Math.ceil(colWidths.reduce((sum, value) => sum + value, 0) + Math.max(0, lines.length - 1) * (spacing + lineGap) + pad * 2);
		height = Math.ceil(Math.max(...lines.map((line) => Array.from(line || " ").length * (charHeight + spacing) - spacing), charHeight) + pad * 2);
	} else {
		width = Math.ceil(Math.max(...lines.map((line) => {
			const chars = Array.from(line || " ");
			return chars.reduce((sum, ch, idx) => sum + measure.measureText(ch).width + (idx ? spacing : 0), 0);
		}), fontSize) + pad * 2);
		height = Math.ceil(lines.length * (fontSize * 1.22) + Math.max(0, lines.length - 1) * lineGap + pad * 2);
	}

	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, width);
	canvas.height = Math.max(1, height);
	const ctx = canvas.getContext("2d");
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.font = font;
	ctx.textBaseline = "top";
	ctx.lineJoin = "round";
	ctx.fillStyle = stringValue(node, "color_hex", "#FFD700");
	ctx.strokeStyle = stringValue(node, "stroke_color_hex", "#000000");
	ctx.lineWidth = strokeWidth * 2;
	const opacity = clamp01(numberValue(node, "text_opacity", 1), 1);
	ctx.globalAlpha = opacity;

	const drawChar = (ch, x, y) => {
		if (strokeWidth > 0) ctx.strokeText(ch, x, y);
		ctx.fillText(ch, x, y);
	};
	if (isVertical) {
		let x = pad;
		for (const line of lines) {
			const chars = Array.from(line || " ");
			const colWidth = Math.max(...chars.map((ch) => measure.measureText(ch).width), fontSize * 0.65);
			let y = pad;
			for (const ch of chars) {
				drawChar(ch, x, y);
				y += charHeight + spacing;
			}
			x += colWidth + spacing + lineGap;
		}
	} else {
		let y = pad;
		for (const line of lines) {
			let x = pad;
			for (const ch of Array.from(line || " ")) {
				drawChar(ch, x, y);
				x += measure.measureText(ch).width + spacing;
			}
			y += fontSize * 1.22 + lineGap;
		}
	}
	return { src: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

function refreshBackground(node, force = false) {
	let info = getUpstreamImageInfo(node);
	if (info?.src && (!info.width || !info.height)) {
		const inferred = inferImageInfoFromUrl(info.src);
		if (inferred?.width && inferred?.height) info = { ...info, width: inferred.width, height: inferred.height };
	}
	const src = info?.src || "";
	const ui = node.__gjjTextOverlayUI;
	if (!src) {
		if (force && ui?.status) {
			ui.status.textContent = "未找到上游背景预览，请先执行上游节点或使用打开图片。";
			ui.status.dataset.show = "true";
			clearTimeout(node.__gjjTextOverlayStatusTimer);
			node.__gjjTextOverlayStatusTimer = setTimeout(() => { ui.status.dataset.show = "false"; }, 2200);
		}
		return false;
	}
	if (!force && node.__gjjTextOverlayBgSrc === src) return true;
	setBackgroundImage(node, info || src, "上游背景图");
	if (force && ui?.status) {
		ui.status.textContent = "已加载上游背景图";
		ui.status.dataset.show = "true";
		clearTimeout(node.__gjjTextOverlayStatusTimer);
		node.__gjjTextOverlayStatusTimer = setTimeout(() => { ui.status.dataset.show = "false"; }, 1400);
	}
	return true;
}

function updateWatermarkPreviewStyle(node) {
	const ui = node.__gjjTextOverlayUI;
	if (!ui?.watermarkImg) return;
	const filters = [];
	const displayScale = (() => {
		const stageWidth = Math.max(1, ui.stage?.clientWidth || 1);
		const bgWidth = Math.max(1, node.__gjjTextOverlayBgSize?.width || stageWidth);
		return stageWidth / bgWidth;
	})();
	if (boolValue(node, "logo_stroke_enabled", false)) {
		const width = Math.max(0, numberValue(node, "logo_stroke_width", 3) * displayScale);
		const color = stringValue(node, "logo_stroke_color_hex", "#FFFFFF");
		if (width > 0) {
			const px = Math.max(1, Math.round(width));
			filters.push(
				`drop-shadow(${px}px 0 0 ${color})`,
				`drop-shadow(${-px}px 0 0 ${color})`,
				`drop-shadow(0 ${px}px 0 ${color})`,
				`drop-shadow(0 ${-px}px 0 ${color})`,
			);
		}
	}
	if (boolValue(node, "logo_shadow_enabled", false)) {
		const color = stringValue(node, "logo_shadow_color_hex", "#000000");
		const dx = Math.round(numberValue(node, "logo_shadow_x", 4) * displayScale);
		const dy = Math.round(numberValue(node, "logo_shadow_y", 4) * displayScale);
		const blur = Math.max(0, numberValue(node, "logo_shadow_blur", 8) * displayScale);
		filters.push(`drop-shadow(${dx}px ${dy}px ${blur}px ${color})`);
	}
	ui.watermarkImg.style.filter = filters.join(" ");
}

function renderPanel(node, options = {}) {
	const ui = node.__gjjTextOverlayUI;
	if (!ui) return;
	const hasBgSize = syncBackgroundSizeFromImage(node);
	const textX = positionValue(node, "text_x", "x");
	const textY = positionValue(node, "text_y", "y");
	const wmX = positionValue(node, "watermark_x", "x");
	const wmY = positionValue(node, "watermark_y", "y");
	if (!hasBgSize && ui.bg.src) {
		ui.text.style.display = "none";
		ui.watermark.style.display = "none";
		updatePanelHeight(node);
		return;
	}
	let textImage = drawTextPreviewImage(node);
	const textPos = clampStagePoint(textX, textY);
	ui.text.style.left = `${textPos.x * 100}%`;
	ui.text.style.top = `${textPos.y * 100}%`;
	if (textImage) {
		ui.text.style.display = "block";
		ui.textImg.src = textImage.src;
		ui.text.style.width = `${textImage.width}px`;
		ui.text.style.height = `${textImage.height}px`;
	} else {
		ui.text.style.display = "none";
		ui.textImg.removeAttribute("src");
	}
	ui.watermark.style.opacity = String(clamp01(numberValue(node, "watermark_opacity", 1), 1));
	const scale = Math.max(0.1, Math.min(10, numberValue(node, "watermark_width", 1)));
	const wmSize = node.__gjjTextOverlayWatermarkSize || { width: 72, height: 72 };
	const baseW = Math.max(1, wmSize.width);
	const baseH = Math.max(1, wmSize.height);
	const stageWidth = Math.max(1, ui.stage.clientWidth || 1);
	const bgWidth = Math.max(1, node.__gjjTextOverlayBgSize?.width || stageWidth);
	const displayScale = stageWidth / bgWidth;
	const wmDisplayWidth = Math.round(baseW * scale * displayScale);
	const wmDisplayHeight = Math.round(baseH * scale * displayScale);
	const wmPos = clampStagePoint(wmX, wmY);
	ui.watermark.style.left = `${wmPos.x * 100}%`;
	ui.watermark.style.top = `${wmPos.y * 100}%`;
	ui.watermark.style.width = `${wmDisplayWidth}px`;
	ui.watermark.style.height = `${wmDisplayHeight}px`;
	updateWatermarkPreviewStyle(node);
	ui.watermark.style.display = (linkPresent(input(node, "watermark_image")) || stringValue(node, "watermark_upload_name", "")) && ui.watermarkImg.src ? "flex" : "none";
	if (linkPresent(input(node, "watermark_image"))) refreshWatermarkPreview(node, false);
	updateLinkToggleButtons(node);
	updatePanelHeight(node);
}

function ensurePanel(node) {
	if (node.__gjjTextOverlayPanelWidget) {
		renderPanel(node);
		return;
	}
	const root = makePanel(node);
	const panel = node.addDOMWidget?.(PANEL, PANEL, root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => node.__gjjTextOverlayHeight || PANEL_MIN_HEIGHT,
	});
	if (panel) {
		panel.computeSize = (width) => [
			Math.round(Number(width || node.size?.[0] || 520)),
			node.__gjjTextOverlayHeight || PANEL_MIN_HEIGHT,
		];
		panel.last_y = 0;
	}
	node.__gjjTextOverlayPanelWidget = panel || { element: root };
	renderPanel(node);
}

function patchNode(node) {
	if (!node || node.__gjjTextOverlayPatched) return;
	node.__gjjTextOverlayPatched = true;
	for (const name of PERSISTED_WIDGETS) {
		const item = widget(node, name);
		if (item && node.properties && node.properties[name] != null) item.value = node.properties[name];
	}
	restorePreviewSizes(node);
	hideNativeWidgets(node);
	ensurePanel(node);
	restorePreviewSizes(node);
	renderPanel(node);
	for (const name of [...TEXT_WIDGETS, ...WATERMARK_WIDGETS]) {
		const item = widget(node, name);
		if (!item || item.__gjjTextOverlayCallbackPatched) continue;
		item.__gjjTextOverlayCallbackPatched = true;
		const original = item.callback;
		item.callback = function (...args) {
			const result = original?.apply(this, args);
			renderPanel(node);
			return result;
		};
	}
}

function restorePersistedWidgets(node) {
	for (const name of PERSISTED_WIDGETS) {
		const item = widget(node, name);
		if (item && node?.properties?.[name] != null) item.value = node.properties[name];
	}
}

function applyBackendPreviewMeta(node, message) {
	const meta = Array.isArray(message?.gjj_text_overlay)
		? message.gjj_text_overlay[0]
		: (Array.isArray(message?.ui?.gjj_text_overlay) ? message.ui.gjj_text_overlay[0] : null);
	if (!meta) return;
	const bgW = Number(meta.background_width || 0);
	const bgH = Number(meta.background_height || 0);
	if (linkPresent(input(node, "background_image"))) {
		node.__gjjTextOverlayBgSrc = "";
		refreshBackground(node, true);
	}
	if (bgW > 0 && bgH > 0) {
		node.__gjjTextOverlayBgSize = { width: bgW, height: bgH };
		persistPreviewSize(node, "background", bgW, bgH);
		setStageAspect(node, bgW, bgH);
	}
	const srcW = Number(meta.watermark_source_width || 0);
	const srcH = Number(meta.watermark_source_height || 0);
	if (srcW > 0 && srcH > 0) {
		node.__gjjTextOverlayWatermarkSize = { width: srcW, height: srcH };
		persistPreviewSize(node, "watermark", srcW, srcH);
	}
	renderPanel(node);
}

app.registerExtension({
	name: "GJJ.TextOverlay",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => {
				this.__gjjTextOverlayPatched = false;
				patchNode(this);
			}, 0);
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => {
				refreshBackground(this, false);
				refreshWatermarkPreview(this, true);
				renderPanel(this, { fitText: false });
				updateLinkToggleButtons(this);
			}, 150);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (...args) {
			restorePersistedWidgets(this);
			return originalOnSerialize?.apply(this, args);
		};
		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...rest) {
			const result = originalOnExecuted?.apply(this, [message, ...rest]);
			setTimeout(() => applyBackendPreviewMeta(this, message), 0);
			return result;
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === TARGET || node?.type === TARGET) {
			setTimeout(() => patchNode(node), 0);
		}
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET || node?.type === TARGET) {
				patchNode(node);
			}
		}
	},
});

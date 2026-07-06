import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const TARGET = "GJJ_TextOverlay";
const PANEL = "gjj_text_overlay_live_panel";
const PANEL_MIN_HEIGHT = 220;
const PANEL_MAX_HEIGHT = 620;
const FOREGROUND_INPUT_PREFIX = "watermark_image_";
const FOREGROUND_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const MAX_FOREGROUND_INPUTS = 64;
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
	"watermark_objects_json",
	"background_image_ref_json",
	"fusion_unet_name",
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
	"watermark_objects_json",
	"background_image_ref_json",
	"fusion_unet_name",
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
const WRITE_TEMP_IMAGE_API = "/gjj/text_overlay/write_temp_image";
const FUSION_UNET_MODELS_API = "/gjj/text_overlay/fusion_unets";
const GJJ_MULTI_IMAGE_DRAG_MIME = "application/x-gjj-multi-image-ref";
const DEFAULT_LOGO_URL = "https://mintcdn.com/dripart/QzWbjSCBG7w61rR3/logo/dark.svg";
const DEFAULT_FUSION_UNET = "qwen_image_edit_2511_fp8mixed.safetensors";
const FUSION_UNET_FILTER = "2511";
const ZOOM_IN_ICON = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M815.3 959.1H208.9c-79.7 0-144.4-64.6-144.4-144.4V208.3c0-79.7 64.6-144.4 144.4-144.4h606.5c79.7 0 144.4 64.6 144.4 144.4v606.5c-0.1 79.7-64.7 144.3-144.5 144.3zM266.6 540.4c0-23.9-19.4-43.3-43.3-43.3S180 516.5 180 540.4v259.9c0 23.9 19.4 43.3 43.3 43.3h259.9c23.9 0 43.3-19.4 43.3-43.3S507.1 757 483.2 757H266.6V540.4z m577.6-317.7c0-23.9-19.4-43.3-43.3-43.3H541c-23.9 0-43.3 19.4-43.3 43.3S517.1 266 541 266h216.6v216.6c0 23.9 19.4 43.3 43.3 43.3s43.3-19.4 43.3-43.3V222.7z" fill="#1296db"></path></svg>`;
const ZOOM_OUT_ICON = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M815.5 63.9H208.7c-79.8 0-144.5 64.7-144.5 144.5V815c0 79.8 64.7 144.5 144.5 144.5h606.7c79.8 0 144.5-64.7 144.5-144.5V208.3c0-79.8-64.7-144.4-144.4-144.4z m-289 736.7c0 23.9-19.4 43.3-43.3 43.3s-43.3-19.4-43.3-43.3V583.9H223.2c-23.9 0-43.3-19.4-43.3-43.3s19.4-43.3 43.3-43.3h260c23.9 0 43.3 19.4 43.3 43.3v260z m303.4-303.4h-260c-23.9 0-43.3-19.4-43.3-43.3v-260c0-23.9 19.4-43.3 43.3-43.3s43.3 19.4 43.3 43.3v216.7h216.7c23.9 0 43.3 19.4 43.3 43.3s-19.4 43.3-43.3 43.3z" fill="#1296db"></path></svg>`;
function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name) || null;
}

function input(node, name) {
	return node?.inputs?.find((item) => item?.name === name) || null;
}

function foregroundInputIndex(name) {
	const match = String(name || "").match(/^watermark_image_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : null;
}

function foregroundInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs
			.filter((item) => foregroundInputIndex(item?.name) != null)
			.sort((a, b) => foregroundInputIndex(a.name) - foregroundInputIndex(b.name))
		: [];
}

function setForegroundInputMeta(slot, index) {
	if (!slot) return;
	slot.name = `${FOREGROUND_INPUT_PREFIX}${index}`;
	slot.type = FOREGROUND_INPUT_TYPE;
	slot.label = `前景图 ${index}`;
	slot.localized_name = slot.label;
	slot.tooltip = "额外前景图。支持 IMAGE / GJJ_BATCH_IMAGE；连上最后一路后会自动展开下一路。";
}

function hasInputLink(slot) {
	return slot?.link != null || (Array.isArray(slot?.links) && slot.links.length > 0);
}

function ensureForegroundInputs(node) {
	if (!node) return;
	let slots = foregroundInputs(node);
	const primaryLinked = hasInputLink(input(node, "watermark_image"));
	for (let index = slots.length - 1; index >= 0; index -= 1) {
		const previousLinked = index === 0 ? primaryLinked : hasInputLink(slots[index - 1]);
		if (hasInputLink(slots[index]) || previousLinked) break;
		const slotIndex = node.inputs?.indexOf(slots[index]) ?? -1;
		if (slotIndex >= 0) node.removeInput?.(slotIndex);
	}

	slots = foregroundInputs(node);
	const lastLinked = slots.length ? hasInputLink(slots[slots.length - 1]) : false;
	if ((primaryLinked || lastLinked) && slots.length < MAX_FOREGROUND_INPUTS) {
		node.addInput?.(`${FOREGROUND_INPUT_PREFIX}${slots.length + 1}`, FOREGROUND_INPUT_TYPE);
	}

	foregroundInputs(node).forEach((slot, index) => setForegroundInputMeta(slot, index + 1));
	markGraphChanged(node);
}

function firstConnectedForegroundInputName(node) {
	if (hasInputLink(input(node, "watermark_image"))) return "watermark_image";
	const slot = foregroundInputs(node).find((item) => hasInputLink(item));
	return slot?.name || "watermark_image";
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

function sourceInfoFromInput(node, name) {
	const slot = input(node, name);
	if (!slot || slot.link == null || !app.graph?.links) return null;
	const link = graphLink(slot.link);
	if (!link) return null;
	const sourceId = linkField(link, "origin_id") ?? linkField(link, "source_id") ?? linkField(link, "from_id");
	const sourceSlot = linkField(link, "origin_slot") ?? linkField(link, "source_slot") ?? linkField(link, "from_slot");
	const source = sourceId == null ? null : findNodeById(sourceId);
	return source ? { source, sourceId, sourceSlot: Number(sourceSlot || 0), link } : null;
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
		["watermark_image", ui.watermarkLinkButton, "前景图"],
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
		filename: String(item?.filename || ""),
		type: String(item?.type || "input"),
		subfolder: String(item?.subfolder || ""),
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

function multiImageLoaderItems(sourceNode) {
	const state = sourceNode?.__gjjMultiImageState;
	const executed = Array.isArray(state?.executedImages) ? state.executedImages.filter((item) => item?.filename) : [];
	if (executed.length) return executed;
	const selected = Array.isArray(state?.selection) ? state.selection.filter((item) => item?.filename) : [];
	if (selected.length) return selected;
	const propertyItems = parseSelection(sourceNode?.properties?.selected_images).filter((item) => item?.filename);
	if (propertyItems.length) return propertyItems;
	const selectedWidget = widget(sourceNode, "selected_images") || sourceNode?.__gjjSelectedImagesWidget;
	return parseSelection(selectedWidget?.value).filter((item) => item?.filename);
}

function connectedForegroundInputNames(node) {
	const names = ["watermark_image"];
	for (const slot of foregroundInputs(node)) names.push(slot.name);
	return names.filter((name) => hasInputLink(input(node, name)));
}

function imageInfosForForegroundInput(node, inputName) {
	const info = sourceInfoFromInput(node, inputName);
	if (!info?.source) return [];
	const sourceNode = info.source;
	if (sourceNode?.comfyClass === "GJJ_MultiImageLoader" || sourceNode?.type === "GJJ_MultiImageLoader") {
		const items = multiImageLoaderItems(sourceNode);
		if (info.sourceSlot > 0) {
			const one = imageRefToViewInfo(items[info.sourceSlot - 1]);
			return one?.src ? [{ ...one, source_batch_index: 0, source_item: items[info.sourceSlot - 1] }] : [];
		}
		return items
			.map((item, index) => ({ ...imageRefToViewInfo(item), source_batch_index: index, source_item: item }))
			.filter((item) => item?.src);
	}
	const one = getUpstreamImageInfo(node, inputName);
	if (!one?.src) return [];
	const parsed = viewUrlToImageInfo(one.src);
	return [{
		...one,
		...(parsed || {}),
		source_batch_index: 0,
	}];
}

function linkedForegroundStablePart(info, index) {
	if (info?.filename) {
		return [
			info.type || "input",
			info.subfolder || "",
			info.filename || "",
			info.source_batch_index ?? index,
		].join("/");
	}
	return `slot:${info?.source_batch_index ?? index}:${info?.src || ""}`;
}

function linkedCutoutCache(node) {
	if (!node.__gjjTextOverlayLinkedCutoutCache) node.__gjjTextOverlayLinkedCutoutCache = new Map();
	return node.__gjjTextOverlayLinkedCutoutCache;
}

function linkedDisplayInfo(node, info, key) {
	if (!boolValue(node, "logo_remove_bg", true) || !info?.filename) return info || {};
	const cache = linkedCutoutCache(node);
	const cached = cache.get(key);
	if (cached === "loading") return info || {};
	if (cached) return { ...info, ...cached };
	cache.set(key, "loading");
	requestRmbg14Preview({
		filename: info.filename,
		type: info.type || "input",
		subfolder: info.subfolder || "",
	})
		.then((cutout) => {
			if (cutout?.src) cache.set(key, cutout);
			else cache.delete(key);
			scheduleRenderPanel(node, { fitText: false });
		})
		.catch((error) => {
			cache.delete(key);
			console.warn("[GJJ_TextOverlay] 连线前景抠图预览失败", error);
		});
	return info || {};
}

function linkedForegroundInfos(node) {
	const result = [];
	for (const inputName of connectedForegroundInputNames(node)) {
		const source = sourceInfoFromInput(node, inputName);
		const infos = imageInfosForForegroundInput(node, inputName);
		infos.forEach((info, index) => {
			const stable = linkedForegroundStablePart(info, index);
			const key = [
				inputName,
				source?.sourceId ?? "",
				source?.sourceSlot ?? "",
				stable,
			].join("|");
			const display = linkedDisplayInfo(node, info, key);
			if (display.src) setObjectPreviewInfo(node, `linked:${key}`, display);
			result.push({
				...info,
				src: display.src || info.src,
				width: Number(display.width || info.width || 72),
				height: Number(display.height || info.height || 72),
				input_name: inputName,
				linked_key: key,
			});
		});
	}
	return result;
}

function syncLinkedWatermarkObjects(node) {
	const linkedInfos = linkedForegroundInfos(node);
	const objects = watermarkObjects(node);
	const oldLinked = new Map(objects.filter((item) => item?.source === "linked").map((item) => [item.linked_key, item]));
	const localObjects = objects.filter((item) => item?.source !== "linked");
	const linkedObjects = linkedInfos.map((info, index) => {
		const old = oldLinked.get(info.linked_key);
		const cutoutRef = info.type === "temp" && info.filename ? compactImageRef(info) : null;
		if (old) {
			const keepStoredCutout = !cutoutRef && old.filename && (old.type || "input") !== "input";
			return {
				...old,
				...(cutoutRef || {}),
				width: Number((keepStoredCutout ? old.width : info.width) || old.width || 72),
				height: Number((keepStoredCutout ? old.height : info.height) || old.height || 72),
				input_name: info.input_name,
			};
		}
		const point = {
			x: Math.min(0.82, 0.18 + index * 0.08),
			y: Math.min(0.72, 0.22 + index * 0.05),
		};
		const fit = fitWatermarkObjectToBackground(node, info, point);
		return {
			source: "linked",
			linked_key: info.linked_key,
			input_name: info.input_name,
			...(cutoutRef || {}),
			width: Number(info.width || 72),
			height: Number(info.height || 72),
			x: fit.x,
			y: fit.y,
			scale: fit.scale,
			stroke_enabled: boolValue(node, "logo_stroke_enabled", false),
			stroke_width: Math.max(1, Math.round(numberValue(node, "logo_stroke_width", 3))),
			stroke_color_hex: stringValue(node, "logo_stroke_color_hex", "#FFFFFF") || "#FFFFFF",
		};
	});
	const next = [...localObjects, ...linkedObjects];
	const hasSerializedPreview = objects.some((item) => item?.src || item?.preview_src);
	if (hasSerializedPreview || JSON.stringify(next.map(serializeWatermarkObject)) !== JSON.stringify(objects.map(serializeWatermarkObject))) {
		setWatermarkObjects(node, next, false);
	}
	return linkedObjects.length;
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

function imageSourceDetails(src) {
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => {
			const width = Math.max(1, image.naturalWidth || image.width || 1);
			const height = Math.max(1, image.naturalHeight || image.height || 1);
			let hasTransparency = false;
			try {
				const canvas = document.createElement("canvas");
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				ctx.clearRect(0, 0, width, height);
				ctx.drawImage(image, 0, 0, width, height);
				const data = ctx.getImageData(0, 0, width, height).data;
				for (let i = 3; i < data.length; i += 4) {
					if (data[i] < 255) {
						hasTransparency = true;
						break;
					}
				}
			} catch (_) {}
			resolve({ width, height, hasTransparency });
		};
		image.onerror = () => resolve({ width: 72, height: 72, hasTransparency: false });
		image.src = src;
	});
}

function imageDataUrlToPngFile(dataUrl, filename = "foreground.png") {
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
				if (!blob) return reject(new Error("前景图转 PNG 失败"));
				resolve(new File([blob], filename.replace(/\.[^.]+$/, "") + ".png", { type: "image/png" }));
			}, "image/png");
		};
		image.onerror = () => reject(new Error("前景图解析失败"));
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
	if (!response?.ok || !data?.ok || !data?.src) throw new Error(data?.error || "网络前景图解析失败");
	return data;
}

function normalizeUploadFilename(data, file, requestedSubfolder = "") {
	const filename = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
	if (!filename) return "";
	if (filename.includes("/")) return filename;
	const subfolder = String(data?.subfolder ?? requestedSubfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadImageToInput(file, subfolder = "gjj_text_overlay_foreground") {
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

async function writeTempImageFromDataUrl(src, file = null) {
	const response = await api.fetchApi(WRITE_TEMP_IMAGE_API, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ src, name: file?.name || "object.png" }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response?.ok || !data?.ok || !data?.filename) throw new Error(data?.error || "临时图片写入失败");
	return data;
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
		filename: name,
		type: "input",
		subfolder,
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
	if (!response?.ok || !data?.ok) throw new Error(data?.error || "RMBG1.4 预览失败");
	const src = data.src || imageRefToViewUrl(data);
	if (!src) throw new Error(data?.error || "RMBG1.4 预览失败");
	return {
		src,
		filename: String(data.filename || ""),
		type: String(data.type || "temp"),
		subfolder: String(data.subfolder || "GJJ"),
		width: Number(data.width || 0),
		height: Number(data.height || 0),
	};
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

function dedupe(values) {
	const seen = new Set();
	const result = [];
	for (const value of values || []) {
		const text = String(value || "").trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		result.push(text);
	}
	return result;
}

function fusionUnetInitialOptions(node) {
	const current = stringValue(node, "fusion_unet_name", DEFAULT_FUSION_UNET);
	return dedupe([current, DEFAULT_FUSION_UNET].filter(Boolean));
}

async function loadFusionUnetOptions(node) {
	try {
		const response = await api.fetchApi(FUSION_UNET_MODELS_API);
		const data = await response.json();
		const current = stringValue(node, "fusion_unet_name", DEFAULT_FUSION_UNET);
		return dedupe([
			current,
			...(Array.isArray(data?.models) ? data.models : []),
			DEFAULT_FUSION_UNET,
		].filter((name) => name === current || String(name).toLowerCase().includes(FUSION_UNET_FILTER)));
	} catch (error) {
		console.warn("[GJJ_TextOverlay] 融合 UNET 列表加载失败", error);
		return fusionUnetInitialOptions(node);
	}
}

function updateSelectOptions(select, values, current) {
	if (!select) return;
	const previous = current || select.value;
	select.replaceChildren();
	for (const value of dedupe([previous, ...(values || [])])) {
		const opt = document.createElement("option");
		opt.value = value;
		opt.textContent = value;
		select.appendChild(opt);
	}
	select.value = previous;
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

function watermarkObjects(node) {
	try {
		const parsed = JSON.parse(stringValue(node, "watermark_objects_json", "[]"));
		return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
	} catch (_) {
		return [];
	}
}

function objectPreviewKey(item) {
	if (!item) return "";
	if (item.linked_key) return `linked:${item.linked_key}`;
	if (item.hash) return `hash:${item.hash}`;
	if (item.filename) return `file:${item.type || "input"}:${item.subfolder || ""}:${item.filename}`;
	return "";
}

function compactImageRef(info) {
	if (!info?.filename) return null;
	return {
		filename: info.filename,
		type: info.type || "temp",
		subfolder: info.subfolder || "",
		hash: info.hash || "",
		width: Number(info.width || 0),
		height: Number(info.height || 0),
	};
}

function objectPreviewCache(node) {
	if (!node.__gjjTextOverlayObjectPreviewCache) node.__gjjTextOverlayObjectPreviewCache = new Map();
	return node.__gjjTextOverlayObjectPreviewCache;
}

function setObjectPreviewInfo(node, key, info) {
	if (!key || !info?.src) return;
	objectPreviewCache(node).set(key, info);
}

function objectPreviewInfo(node, item) {
	const key = objectPreviewKey(item);
	return key ? objectPreviewCache(node).get(key) : null;
}

function serializeWatermarkObject(item) {
	const copy = { ...(item || {}) };
	delete copy.src;
	delete copy.preview_src;
	return copy;
}

function setWatermarkObjects(node, objects, notify = true) {
	const value = JSON.stringify(Array.isArray(objects) ? objects.map(serializeWatermarkObject) : []);
	if (notify) {
		setWidgetValue(node, "watermark_objects_json", value);
		return;
	}
	const item = widget(node, "watermark_objects_json");
	if (item) item.value = value;
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function updateWatermarkObject(node, index, patch, notify = true) {
	const objects = watermarkObjects(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) return false;
	objects[index] = { ...objects[index], ...(patch || {}) };
	setWatermarkObjects(node, objects, notify);
	return true;
}

function removeWatermarkObject(node, index, notify = true) {
	const objects = watermarkObjects(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) return false;
	objects.splice(index, 1);
	const selected = selectedWatermarkObjectIndex(node);
	if (selected >= objects.length) node.__gjjTextOverlaySelectedObjectIndex = objects.length - 1;
	else if (selected > index) node.__gjjTextOverlaySelectedObjectIndex = selected - 1;
	setWatermarkObjects(node, objects, notify);
	return true;
}

function selectedWatermarkObjectIndex(node) {
	const index = Number(node.__gjjTextOverlaySelectedObjectIndex);
	return Number.isInteger(index) ? index : -1;
}

function activeWatermarkObjectIndex(node) {
	const objects = watermarkObjects(node);
	let index = selectedWatermarkObjectIndex(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) {
		index = objects.length - 1;
		node.__gjjTextOverlaySelectedObjectIndex = index;
	}
	return index;
}

function fitWatermarkObjectToBackground(node, imageInfo, point = { x: 0.5, y: 0.5 }) {
	const bgWidth = Math.max(1, Number(node.__gjjTextOverlayBgSize?.width || node.__gjjTextOverlayUI?.stage?.clientWidth || 1));
	const bgHeight = Math.max(1, Number(node.__gjjTextOverlayBgSize?.height || node.__gjjTextOverlayUI?.stage?.clientHeight || 1));
	const imageWidth = Math.max(1, Number(imageInfo?.width || 72));
	const imageHeight = Math.max(1, Number(imageInfo?.height || 72));
	const scale = Math.max(0.01, Math.min(10, 1, bgWidth / imageWidth, bgHeight / imageHeight));
	const widthRatio = Math.min(1, (imageWidth * scale) / bgWidth);
	const heightRatio = Math.min(1, (imageHeight * scale) / bgHeight);
	return {
		scale: Number(scale.toFixed(4)),
		x: Number(Math.max(0, Math.min(Math.max(0, 1 - widthRatio), Number(point?.x ?? 0.5))).toFixed(4)),
		y: Number(Math.max(0, Math.min(Math.max(0, 1 - heightRatio), Number(point?.y ?? 0.5))).toFixed(4)),
	};
}

function adjustWatermarkObjectScale(node, index, delta, fine = false) {
	const objects = watermarkObjects(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) return false;
	if (objects[index]?.locked) return false;
	const current = Math.max(0.01, Math.min(10, Number(objects[index].scale || 1)));
	const step = fine ? 0.01 : 0.05;
	const next = Math.max(0.01, Math.min(10, Number((current + Math.sign(delta) * step).toFixed(4))));
	if (next === current) return false;
	objects[index] = { ...objects[index], scale: next };
	setWatermarkObjects(node, objects);
	return true;
}

function toggleWatermarkObjectMirror(node, index) {
	const objects = watermarkObjects(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) return false;
	if (objects[index]?.locked) return false;
	const current = objects[index] || {};
	objects[index] = { ...current, mirror_x: !current.mirror_x };
	setWatermarkObjects(node, objects);
	return true;
}

function nudgeWatermarkObject(node, index, dx, dy, fine = false) {
	const objects = watermarkObjects(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) return false;
	if (objects[index]?.locked) return false;
	const step = fine ? 0.001 : 0.005;
	const current = clampStagePoint(objects[index].x ?? 0.5, objects[index].y ?? 0.5);
	const pos = clampStagePoint(current.x + dx * step, current.y + dy * step);
	objects[index] = { ...objects[index], x: Number(pos.x.toFixed(4)), y: Number(pos.y.toFixed(4)) };
	setWatermarkObjects(node, objects);
	return true;
}

function moveWatermarkObjectLayer(node, index, delta) {
	const objects = watermarkObjects(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) return false;
	const nextIndex = Math.max(0, Math.min(objects.length - 1, index + Math.sign(delta)));
	if (nextIndex === index) return false;
	const [item] = objects.splice(index, 1);
	objects.splice(nextIndex, 0, item);
	node.__gjjTextOverlaySelectedObjectIndex = nextIndex;
	setWatermarkObjects(node, objects);
	return true;
}

function toggleWatermarkObjectLock(node, index) {
	const objects = watermarkObjects(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) return false;
	objects[index] = { ...objects[index], locked: !objects[index].locked };
	setWatermarkObjects(node, objects);
	return true;
}

function toggleWatermarkObjectStroke(node, index) {
	const objects = watermarkObjects(node);
	if (!Number.isInteger(index) || index < 0 || index >= objects.length) return false;
	const current = objects[index] || {};
	const enabled = !current.stroke_enabled;
	objects[index] = {
		...current,
		stroke_enabled: enabled,
		stroke_width: Math.max(1, Math.round(numberValue(node, "logo_stroke_width", 3))),
		stroke_color_hex: stringValue(node, "logo_stroke_color_hex", "#FFFFFF") || "#FFFFFF",
	};
	setWatermarkObjects(node, objects);
	return true;
}

function foregroundStrokeFilter(item, displayScale = 1) {
	if (!item?.stroke_enabled) return "";
	const width = Math.max(0, Number(item.stroke_width || 3) * displayScale);
	if (width <= 0) return "";
	const color = String(item.stroke_color_hex || "#FFFFFF");
	const px = Math.max(1, Math.round(width));
	return [
		`drop-shadow(${px}px 0 0 ${color})`,
		`drop-shadow(${-px}px 0 0 ${color})`,
		`drop-shadow(0 ${px}px 0 ${color})`,
		`drop-shadow(0 ${-px}px 0 ${color})`,
	].join(" ");
}

function storedImageSrc(item) {
	const cutout = item?.cutout_ref;
	if (cutout?.filename) return imageRefToViewUrl(cutout);
	if (!item?.filename) return "";
	if (item.type && item.type !== "input") return imageRefToViewUrl(item);
	return inputImageViewInfo(item.filename)?.src || "";
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
		.gjj-text-overlay-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0;overflow:visible;}
		.gjj-text-overlay-settings{display:none;flex-wrap:wrap;align-items:flex-start;gap:5px;min-width:0;}
		.gjj-text-overlay-settings[data-open="true"]{display:flex;}
		.gjj-text-overlay-icon-button{width:26px;height:24px;min-width:26px;border:1px solid #3c5058;border-radius:6px;background:#17252b;color:#f3fbfb;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
		.gjj-text-overlay-icon-button svg{width:16px;height:16px;display:block;pointer-events:none;}
		.gjj-text-overlay-icon-button:hover{background:#213942;border-color:#63838d;}
		.gjj-text-overlay-icon-button[data-active="true"]{background:#244850;border-color:#82b9c5;}
		.gjj-text-overlay-object-picker{display:flex;align-items:center;flex-wrap:wrap;gap:2px;min-width:0;max-width:100%;overflow:visible;scrollbar-width:none;}
		.gjj-text-overlay-object-picker::-webkit-scrollbar{display:none;}
		.gjj-text-overlay-object-picker-button{height:22px;min-width:25px;border:1px solid transparent;border-radius:5px;background:transparent;color:#eaf3f3;font-size:11px;font-weight:800;line-height:1;padding:0 3px;cursor:pointer;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.8);}
		.gjj-text-overlay-object-picker-button:hover{background:#213942;border-color:#63838d;}
		.gjj-text-overlay-object-picker-button[data-active="true"]{background:#39422a;border-color:#ffd84d;color:#fff6bf;}
		.gjj-text-overlay-preview{position:relative;width:100%;min-width:0;border:1px solid #34484f;border-radius:7px;background:#10181c;overflow:hidden;display:flex;justify-content:center;}
		.gjj-text-overlay-preview[data-dragging-image="true"]{border-color:#ffd84d;box-shadow:0 0 0 2px rgba(255,216,77,.28) inset;}
		.gjj-text-overlay-status{position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);padding:3px 7px;border-radius:6px;background:rgba(8,14,17,.72);color:#b7cbd0;font-size:11px;line-height:1.3;pointer-events:none;opacity:0;transition:opacity .15s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.gjj-text-overlay-status[data-show="true"]{opacity:1;}
		.gjj-text-overlay-stage{position:relative;width:100%;aspect-ratio:16/9;background:linear-gradient(45deg,#182126 25%,#121a1e 25%,#121a1e 50%,#182126 50%,#182126 75%,#121a1e 75%);background-size:22px 22px;overflow:hidden;margin:0 auto;}
		.gjj-text-overlay-base{position:absolute;inset:0;z-index:0;background:radial-gradient(circle at 30% 25%,rgba(112,151,163,.35),transparent 35%),linear-gradient(135deg,#202c32,#0d1418);opacity:.9;}
		.gjj-text-overlay-bg{position:absolute;inset:0;z-index:1;width:100%;height:100%;object-fit:fill;display:none;}
		.gjj-text-overlay-object-layer{position:absolute;inset:0;z-index:4;pointer-events:none;}
		.gjj-text-overlay-object{position:absolute;user-select:none;touch-action:none;cursor:grab;border:1px solid transparent;border-radius:5px;pointer-events:auto;}
		.gjj-text-overlay-object:active{cursor:grabbing;}
		.gjj-text-overlay-object[data-selected="true"]{border-color:#ffd84d;box-shadow:0 0 0 2px rgba(255,216,77,.26);}
		.gjj-text-overlay-object[data-selected="true"] .gjj-text-overlay-resize{display:block;}
		.gjj-text-overlay-object[data-locked="true"]{border-style:dashed;}
		.gjj-text-overlay-object[data-locked="true"] .gjj-text-overlay-resize{display:none;}
		.gjj-text-overlay-object img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;}
		.gjj-text-overlay-object-tools{position:absolute;left:calc(100% + 4px);top:0;display:flex;flex-direction:column;gap:1px;align-items:center;padding:0;background:transparent;pointer-events:auto;z-index:9;}
		.gjj-text-overlay-object-tool{width:18px;height:18px;border:1px solid transparent;border-radius:4px;background:transparent;color:#f4fbfb;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;text-shadow:0 1px 3px rgba(0,0,0,.9);}
		.gjj-text-overlay-object-tool:hover{background:rgba(20,31,36,.68);border-color:rgba(126,162,173,.78);}
		.gjj-text-overlay-object-tool[data-active="true"]{background:rgba(80,69,18,.72);border-color:#ffd84d;color:#fff6bf;}
		.gjj-text-overlay-item{position:absolute;left:50%;top:50%;z-index:3;user-select:none;touch-action:none;cursor:grab;border:1px solid transparent;border-radius:5px;}
		.gjj-text-overlay-item:active{cursor:grabbing;}
		.gjj-text-overlay-item[data-active="true"]{border-color:#7fa7b3;box-shadow:0 0 0 2px rgba(127,167,179,.22);}
		.gjj-text-overlay-text{z-index:5;display:block;max-width:none;padding:0;image-rendering:auto;}
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
	preview.tabIndex = 0;
	const status = document.createElement("div");
	status.className = "gjj-text-overlay-status";
	const stage = document.createElement("div");
	stage.className = "gjj-text-overlay-stage";
	const base = document.createElement("div");
	base.className = "gjj-text-overlay-base";
	const bg = document.createElement("img");
	bg.className = "gjj-text-overlay-bg";
	bg.alt = "";
	const objectLayer = document.createElement("div");
	objectLayer.className = "gjj-text-overlay-object-layer";
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
	stage.append(base, bg, objectLayer, watermark, text);
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

	const firstImageFile = (items) => {
		for (const item of Array.from(items || [])) {
			const file = item?.kind === "file" ? item.getAsFile?.() : item;
			if (!file) continue;
			if (String(file.type || "").startsWith("image/") || /\.(png|jpe?g|webp|bmp)$/i.test(file.name || "")) return file;
		}
		return null;
	};

	const draggedImageRef = (dataTransfer) => {
		if (!dataTransfer) return null;
		try {
			const raw = dataTransfer.getData(GJJ_MULTI_IMAGE_DRAG_MIME);
			if (!raw) return null;
			const item = JSON.parse(raw);
			return item?.filename ? item : null;
		} catch (_) {
			return null;
		}
	};
	const hasDraggedImageRef = (dataTransfer) => {
		const types = Array.from(dataTransfer?.types || []);
		return types.includes(GJJ_MULTI_IMAGE_DRAG_MIME);
	};

	const dropPointOnStage = (event) => {
		const rect = stage.getBoundingClientRect();
		if (!rect.width || !rect.height) return { x: 0.5, y: 0.5 };
		return {
			x: (event.clientX - rect.left) / rect.width,
			y: (event.clientY - rect.top) / rect.height,
		};
	};

	const useFileAsWatermark = async (file, event = null) => {
		if (!file) return;
		if (!syncBackgroundSizeFromImage(node)) {
			showPanelStatus(node, "请先放入背景图，再拖入前景图片", 2200);
			return;
		}
		const point = event ? dropPointOnStage(event) : { x: positionValue(node, "watermark_x", "x"), y: positionValue(node, "watermark_y", "y") };
		try {
			preview.dataset.draggingImage = "false";
			showPanelStatus(node, "正在添加前景图片...", 2200);
			const src = await readLocalFile(file);
			const imageInfo = await imageSourceDetails(src);
			const hasTransparency = imageInfo.hasTransparency;
			setWidgetValue(node, "logo_default_url", "");
			setPosition(node, "watermark", point.x, point.y);
			activate("watermark");
			const tempInfo = await writeTempImageFromDataUrl(src, file);
			let displayInfo = { ...tempInfo, src, width: imageInfo.width || 72, height: imageInfo.height || 72 };
			let cutoutRef = null;
			if (boolValue(node, "logo_remove_bg", true)) {
				try {
					const cutout = await requestRmbg14Preview(tempInfo);
					if (cutout?.src) {
						displayInfo = { ...displayInfo, ...cutout };
						cutoutRef = compactImageRef(cutout);
					}
				} catch (error) {
					console.warn("[GJJ_TextOverlay] 拖拽前景抠图预览失败", error);
				}
			}
			const objects = watermarkObjects(node);
			const fit = fitWatermarkObjectToBackground(node, displayInfo, clampStagePoint(point.x, point.y));
			const storedRef = cutoutRef || compactImageRef(tempInfo) || tempInfo;
			const nextObject = {
				filename: storedRef.filename,
				type: storedRef.type || "temp",
				subfolder: storedRef.subfolder || "GJJ",
				hash: storedRef.hash || "",
				x: fit.x,
				y: fit.y,
				scale: fit.scale,
				width: Number(displayInfo.width || imageInfo.width || 72),
				height: Number(displayInfo.height || imageInfo.height || 72),
			};
			setObjectPreviewInfo(node, objectPreviewKey(nextObject), displayInfo);
			objects.push(nextObject);
			node.__gjjTextOverlaySelectedObjectIndex = objects.length - 1;
			setWatermarkObjects(node, objects);
			showPanelStatus(node, hasTransparency ? "透明前景已直接添加" : (boolValue(node, "logo_remove_bg", true) ? "前景已添加，执行时会自动抠图" : "前景已添加"), 1600);
			renderPanel(node, { fitText: false });
		} catch (error) {
			console.warn("[GJJ_TextOverlay] 拖拽添加前景失败", error);
			showPanelStatus(node, "前景添加失败", 2200);
		}
	};

	const useImageRefAsWatermark = async (item, event = null) => {
		if (!item?.filename) return;
		if (!syncBackgroundSizeFromImage(node)) {
			showPanelStatus(node, "请先放入背景图，再拖入前景图片", 2200);
			return;
		}
		const point = event ? dropPointOnStage(event) : { x: positionValue(node, "watermark_x", "x"), y: positionValue(node, "watermark_y", "y") };
		const info = imageRefToViewInfo(item);
		if (!info?.src) return;
		try {
			preview.dataset.draggingImage = "false";
			showPanelStatus(node, "正在添加前景图片...", 2200);
			setWidgetValue(node, "logo_default_url", "");
			setPosition(node, "watermark", point.x, point.y);
			activate("watermark");
			let displayInfo = info;
			let cutoutRef = null;
			if (boolValue(node, "logo_remove_bg", true)) {
				try {
					const cutout = await requestRmbg14Preview({
						filename: info.filename,
						type: info.type || "input",
						subfolder: info.subfolder || "",
					});
					if (cutout?.src) {
						displayInfo = { ...info, ...cutout };
						cutoutRef = compactImageRef(cutout);
					}
				} catch (error) {
					console.warn("[GJJ_TextOverlay] 拖拽前景抠图预览失败", error);
				}
			}
			const objects = watermarkObjects(node);
			const fit = fitWatermarkObjectToBackground(node, displayInfo, clampStagePoint(point.x, point.y));
			const storedRef = cutoutRef || compactImageRef(info) || info;
			const nextObject = {
				filename: storedRef.filename,
				type: storedRef.type || "input",
				subfolder: storedRef.subfolder || "",
				hash: storedRef.hash || "",
				x: fit.x,
				y: fit.y,
				scale: fit.scale,
				width: Number(displayInfo.width || info.width || 72),
				height: Number(displayInfo.height || info.height || 72),
			};
			setObjectPreviewInfo(node, objectPreviewKey(nextObject), displayInfo);
			objects.push(nextObject);
			node.__gjjTextOverlaySelectedObjectIndex = objects.length - 1;
			setWatermarkObjects(node, objects);
			showPanelStatus(node, boolValue(node, "logo_remove_bg", true) ? "前景已抠图添加" : "前景已添加", 1600);
			renderPanel(node, { fitText: false });
		} catch (error) {
			console.warn("[GJJ_TextOverlay] 拖拽添加前景失败", error);
			showPanelStatus(node, "前景添加失败", 2200);
		}
	};

	const deleteSelectedWatermarkObject = () => {
		const objects = watermarkObjects(node);
		const index = Number(node.__gjjTextOverlaySelectedObjectIndex);
		if (!Number.isInteger(index) || index < 0 || index >= objects.length) {
			showPanelStatus(node, "请先选择要删除的对象", 1400);
			return;
		}
		objects.splice(index, 1);
		node.__gjjTextOverlaySelectedObjectIndex = Math.min(index, objects.length - 1);
		setWatermarkObjects(node, objects);
		showPanelStatus(node, "对象已删除", 1200);
		renderPanel(node, { fitText: false });
	};
	const moveSelectedWatermarkObject = (delta) => {
		const index = selectedWatermarkObjectIndex(node);
		if (moveWatermarkObjectLayer(node, index, delta)) {
			showPanelStatus(node, delta > 0 ? "对象已上移一层" : "对象已下移一层", 1000);
			renderPanel(node, { fitText: false });
		} else {
			showPanelStatus(node, "请先选择可调整的对象", 1400);
		}
	};
	const scaleSelectedWatermarkObject = (delta) => {
		const index = activeWatermarkObjectIndex(node);
		if (adjustWatermarkObjectScale(node, index, delta, false)) {
			showPanelStatus(node, delta > 0 ? "对象已放大" : "对象已缩小", 900);
			renderPanel(node, { fitText: false });
		} else {
			const locked = watermarkObjects(node)[index]?.locked;
			showPanelStatus(node, locked ? "对象已锁定" : "请先选择可缩放的对象", 1400);
		}
	};
	const mirrorSelectedWatermarkObject = () => {
		const index = activeWatermarkObjectIndex(node);
		if (toggleWatermarkObjectMirror(node, index)) {
			showPanelStatus(node, watermarkObjects(node)[index]?.mirror_x ? "对象已镜像" : "对象已取消镜像", 900);
			renderPanel(node, { fitText: false });
		} else {
			const locked = watermarkObjects(node)[index]?.locked;
			showPanelStatus(node, locked ? "对象已锁定" : "请先选择可镜像的对象", 1400);
		}
	};

	const addIconButton = (icon, title, callback) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-text-overlay-icon-button";
		if (String(icon || "").trim().startsWith("<svg")) button.innerHTML = icon;
		else button.textContent = icon;
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
	addIconButton("🧩", "打开本地前景图，并使用 RMBG1.4 抠图预览", () => logoFileInput.click());
	addIconButton("⬇", "选中对象下移一层", () => moveSelectedWatermarkObject(-1));
	addIconButton("⬆", "选中对象上移一层", () => moveSelectedWatermarkObject(1));
	addIconButton(ZOOM_IN_ICON, "放大选中对象", () => scaleSelectedWatermarkObject(1));
	addIconButton(ZOOM_OUT_ICON, "缩小选中对象", () => scaleSelectedWatermarkObject(-1));
	addIconButton("↔️", "水平镜像选中对象", mirrorSelectedWatermarkObject);
	addIconButton("🗑", "删除选中的拖拽对象", deleteSelectedWatermarkObject);
	const objectPicker = document.createElement("div");
	objectPicker.className = "gjj-text-overlay-object-picker";
	objectPicker.style.display = "none";
	const watermarkLinkButton = addIconButton("🔗", "断开前景图上游链接", () => toggleRememberedInputLink(node, "watermark_image"));
	watermarkLinkButton.style.display = "none";
	addIconButton("🌏", "设置网络默认前景图", async () => {
		const current = stringValue(node, "logo_default_url", "") || DEFAULT_LOGO_URL;
		const url = window.prompt("网络默认前景图 URL", current);
		if (!url) return;
		try {
			if (status) {
				status.textContent = "正在解析网络前景图...";
				status.dataset.show = "true";
			}
			const data = await fetchNetworkLogo(url.trim());
			setWatermarkPreviewImage(node, { src: data.src });
			const file = await imageDataUrlToPngFile(data.src, data.filename || "foreground.png");
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
					console.warn("[GJJ_TextOverlay] RMBG1.4 网络前景图预览失败", error);
				}
			}
			if (status) {
				status.textContent = "网络默认前景图已设置";
				clearTimeout(node.__gjjTextOverlayStatusTimer);
				node.__gjjTextOverlayStatusTimer = setTimeout(() => { status.dataset.show = "false"; }, 1400);
			}
			renderPanel(node);
		} catch (error) {
			console.warn("[GJJ_TextOverlay] 网络前景图设置失败", error);
			if (status) {
				status.textContent = `网络前景图设置失败：${error?.message || error}`;
				status.dataset.show = "true";
			}
		}
	});
	addIconButton("🌘", "开关前景阴影", (button) => {
		const next = !boolValue(node, "logo_shadow_enabled", false);
		setWidgetValue(node, "logo_shadow_enabled", next);
		button.dataset.active = next ? "true" : "false";
		renderPanel(node);
	});
	const foregroundStrokeButton = addIconButton("✒️", "给选中前景描边；未选中时切换全局前景描边", (button) => {
		const index = selectedWatermarkObjectIndex(node);
		const objects = watermarkObjects(node);
		if (Number.isInteger(index) && index >= 0 && index < objects.length) {
			toggleWatermarkObjectStroke(node, index);
			const enabled = watermarkObjects(node)[index]?.stroke_enabled;
			button.dataset.active = enabled ? "true" : "false";
			showPanelStatus(node, enabled ? "选中前景描边已开启" : "选中前景描边已关闭", 1200);
			renderPanel(node, { fitText: false });
			return;
		}
		const next = !boolValue(node, "logo_stroke_enabled", false);
		setWidgetValue(node, "logo_stroke_enabled", next);
		button.dataset.active = next ? "true" : "false";
		showPanelStatus(node, next ? "全局前景描边已开启" : "全局前景描边已关闭", 1200);
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
	toolbar.appendChild(objectPicker);

	control(node, settings, "文本", "texts", "text", { wide: true });
	control(node, settings, "字体", "font_path", "select");
	control(node, settings, "文字透明度", "text_opacity", "range", { min: 0, max: 1, step: 0.01 });
	segmentedControl(node, settings, "方向", "direction", ["横向", "纵向"]);
	control(node, settings, "字间距", "spacing", "number", { step: 0.1 });
	control(node, settings, "文字颜色", "color_hex", "color");
	control(node, settings, "描边颜色", "stroke_color_hex", "color");
	control(node, settings, "启用描边", "use_stroke", "checkbox");
	control(node, settings, "描边宽度", "stroke_width", "number", { min: 0, step: 1 });
	control(node, settings, "前景透明度", "watermark_opacity", "range", { min: 0, max: 1, step: 0.01 });
	control(node, settings, "RMBG1.4抠图", "logo_remove_bg", "checkbox");
	control(node, settings, "前景阴影模糊", "logo_shadow_blur", "number", { min: 0, step: 0.5 });
	control(node, settings, "前景阴影X", "logo_shadow_x", "number", { step: 1 });
	control(node, settings, "前景阴影Y", "logo_shadow_y", "number", { step: 1 });
	control(node, settings, "前景阴影颜色", "logo_shadow_color_hex", "color");
	control(node, settings, "前景描边宽度", "logo_stroke_width", "number", { min: 0, step: 1 });
	control(node, settings, "前景描边颜色", "logo_stroke_color_hex", "color");
	const fusionUnetSelect = control(node, settings, "融合UNET", "fusion_unet_name", "select", { values: fusionUnetInitialOptions(node), wide: true });
	loadFusionUnetOptions(node).then((values) => {
		updateSelectOptions(fusionUnetSelect, values, stringValue(node, "fusion_unet_name", DEFAULT_FUSION_UNET));
	});

	fileInput.addEventListener("change", async () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		try {
			const src = await readLocalFile(file);
			const imageInfo = await imageSourceDetails(src);
			setBackgroundImage(node, { src, width: imageInfo.width, height: imageInfo.height }, file.name);
			const tempInfo = await writeTempImageFromDataUrl(src, file);
			setWidgetValue(node, "background_image_ref_json", JSON.stringify({
				...tempInfo,
				original_name: file.name || tempInfo.filename || "",
				width: imageInfo.width || 0,
				height: imageInfo.height || 0,
			}));
			showPanelStatus(node, "背景图已载入，可直接执行", 1600);
		} catch (error) {
			console.warn("[GJJ_TextOverlay] 打开背景预览失败", error);
			showPanelStatus(node, "背景图打开失败", 2200);
		} finally {
			fileInput.value = "";
		}
	});

	let dragImageDepth = 0;
	const showDragImageTarget = (show) => {
		preview.dataset.draggingImage = show ? "true" : "false";
	};
	for (const el of [preview, stage]) {
		el.addEventListener("dragenter", (event) => {
			const file = firstImageFile(event.dataTransfer?.items);
			if (!file && !hasDraggedImageRef(event.dataTransfer)) return;
			event.preventDefault();
			event.stopPropagation();
			dragImageDepth += 1;
			showDragImageTarget(true);
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
			showPanelStatus(node, syncBackgroundSizeFromImage(node) ? "松开后作为前景添加" : "请先放入背景图", 1200);
		});
		el.addEventListener("dragover", (event) => {
			const file = firstImageFile(event.dataTransfer?.items);
			if (!file && !hasDraggedImageRef(event.dataTransfer)) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		});
		el.addEventListener("dragleave", (event) => {
			const file = firstImageFile(event.dataTransfer?.items);
			if (!file && !hasDraggedImageRef(event.dataTransfer)) return;
			event.preventDefault();
			event.stopPropagation();
			dragImageDepth = Math.max(0, dragImageDepth - 1);
			if (dragImageDepth <= 0) showDragImageTarget(false);
		});
		el.addEventListener("drop", async (event) => {
			const ref = draggedImageRef(event.dataTransfer);
			const file = firstImageFile(event.dataTransfer?.files) || firstImageFile(event.dataTransfer?.items);
			if (!file && !ref) return;
			event.preventDefault();
			event.stopPropagation();
			dragImageDepth = 0;
			showDragImageTarget(false);
			if (ref) await useImageRefAsWatermark(ref, event);
			else await useFileAsWatermark(file, event);
		});
	}

	preview.addEventListener("keydown", (event) => {
		if (event.key === "[" || event.key === "]" || event.key === "PageUp" || event.key === "PageDown") {
			event.preventDefault();
			event.stopPropagation();
			const delta = (event.key === "]" || event.key === "PageUp") ? 1 : -1;
			moveSelectedWatermarkObject(delta);
			return;
		}
		if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") {
			event.preventDefault();
			event.stopPropagation();
			const index = selectedWatermarkObjectIndex(node);
			const direction = (event.key === "+" || event.key === "=") ? 1 : -1;
			if (adjustWatermarkObjectScale(node, index, direction, event.shiftKey || event.altKey)) {
				renderPanel(node, { fitText: false });
			}
			return;
		}
		if (event.key !== "Delete" && event.key !== "Backspace") return;
		event.preventDefault();
		event.stopPropagation();
		deleteSelectedWatermarkObject();
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
					console.warn("[GJJ_TextOverlay] RMBG1.4 前景预览失败", error);
				}
			}
			if (status) {
				status.textContent = boolValue(node, "logo_remove_bg", true) ? "前景已选择，执行时使用 RMBG1.4 抠图" : "前景已选择";
				status.dataset.show = "true";
				clearTimeout(node.__gjjTextOverlayStatusTimer);
				node.__gjjTextOverlayStatusTimer = setTimeout(() => { status.dataset.show = "false"; }, 1400);
			}
			renderPanel(node);
		} catch (error) {
			console.warn("[GJJ_TextOverlay] 打开前景失败", error);
			if (status) {
				status.textContent = "前景打开失败";
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
	let draggingObjectIndex = -1;
	let draggingObjectElement = null;
	let resizingKind = "";
	let resizeStart = null;
	const drag = (event, kind = dragging) => {
		if (!kind) return;
		const rect = stage.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		const x = (event.clientX - rect.left - dragOffset.x) / rect.width;
		const y = (event.clientY - rect.top - dragOffset.y) / rect.height;
		if (kind === "object") {
			const pos = clampStagePoint(x, y);
			updateWatermarkObject(node, draggingObjectIndex, { x: pos.x, y: pos.y }, false);
			if (draggingObjectElement) {
				draggingObjectElement.style.left = `${pos.x * 100}%`;
				draggingObjectElement.style.top = `${pos.y * 100}%`;
			}
			return;
		}
		setPosition(node, kind, x, y);
	};
	const startResize = (event, kind, corner, element, objectIndex = -1, objectElement = null) => {
		event.preventDefault();
		event.stopPropagation();
		resizingKind = kind;
		dragging = "";
		activate(kind);
		const target = kind === "object" ? objectElement : (kind === "watermark" ? watermark : text);
		if (!target) return;
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
			startPointerX: event.clientX - stageRect.left,
			startPointerY: event.clientY - stageRect.top,
			stageWidth: Math.max(1, stageRect.width),
			stageHeight: Math.max(1, stageRect.height),
			fontSize: Math.max(1, numberValue(node, "font_size", 48)),
			watermarkWidth: Math.max(0.1, numberValue(node, "watermark_width", 1)),
			objectIndex,
			objectScale: Math.max(0.01, Number(watermarkObjects(node)[objectIndex]?.scale || 1)),
			objectElement,
			baseWidth: Math.max(1, Number(watermarkObjects(node)[objectIndex]?.width || width)),
			baseHeight: Math.max(1, Number(watermarkObjects(node)[objectIndex]?.height || height)),
			displayScale: (() => {
				const bgWidth = Math.max(1, node.__gjjTextOverlayBgSize?.width || Math.max(1, stageRect.width));
				return Math.max(1, stageRect.width) / bgWidth;
			})(),
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
	node.__gjjTextOverlayStartObjectDrag = (event, index, element) => {
		event.preventDefault();
		event.stopPropagation();
		preview?.focus?.();
		node.__gjjTextOverlaySelectedObjectIndex = index;
		activate("object");
		objectLayer.querySelectorAll?.(".gjj-text-overlay-object").forEach((item) => {
			item.dataset.selected = item === element ? "true" : "false";
		});
		if (watermarkObjects(node)[index]?.locked) {
			renderPanel(node, { fitText: false });
			return;
		}
		dragging = "object";
		draggingObjectIndex = index;
		draggingObjectElement = element;
		resizingKind = "";
		resizeStart = null;
		const itemRect = element.getBoundingClientRect();
		dragOffset = {
			x: event.clientX - itemRect.left,
			y: event.clientY - itemRect.top,
		};
		element.setPointerCapture?.(event.pointerId);
		drag(event, "object");
	};
	node.__gjjTextOverlayStartObjectResize = (event, index, corner, objectElement, handleElement) => {
		node.__gjjTextOverlaySelectedObjectIndex = index;
		objectLayer.querySelectorAll?.(".gjj-text-overlay-object").forEach((item) => {
			item.dataset.selected = item === objectElement ? "true" : "false";
		});
		if (watermarkObjects(node)[index]?.locked) {
			event.preventDefault();
			event.stopPropagation();
			renderPanel(node, { fitText: false });
			return;
		}
		startResize(event, "object", corner, handleElement, index, objectElement);
	};
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
			let pointerX = Math.max(0, Math.min(resizeStart.stageWidth, event.clientX - stageRect.left));
			let pointerY = Math.max(0, Math.min(resizeStart.stageHeight, event.clientY - stageRect.top));
			if (resizingKind === "object" && (event.shiftKey || event.altKey || event.ctrlKey)) {
				const fineFactor = event.altKey ? 0.05 : (event.ctrlKey ? 0.1 : 0.2);
				pointerX = resizeStart.startPointerX + (pointerX - resizeStart.startPointerX) * fineFactor;
				pointerY = resizeStart.startPointerY + (pointerY - resizeStart.startPointerY) * fineFactor;
			}
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
			} else if (resizingKind === "object") {
				const nextScale = Math.max(0.01, Math.min(10, Number((resizeStart.objectScale * ratio).toFixed(4))));
				updateWatermarkObject(node, resizeStart.objectIndex, { scale: nextScale }, false);
				if (resizeStart.objectElement) {
					resizeStart.objectElement.style.width = `${Math.round(resizeStart.baseWidth * nextScale * resizeStart.displayScale)}px`;
					resizeStart.objectElement.style.height = `${Math.round(resizeStart.baseHeight * nextScale * resizeStart.displayScale)}px`;
				}
			} else {
				const nextScale = Math.max(0.1, Math.min(10, Number((resizeStart.watermarkWidth * ratio).toFixed(4))));
				setWidgetValue(node, "watermark_width", nextScale);
			}
			if (resizeStart.corner === "nw") {
				const nextLeft = (resizeStart.left + resizeStart.width - nextWidth) / resizeStart.stageWidth;
				const nextTop = (resizeStart.top + resizeStart.height - nextHeight) / resizeStart.stageHeight;
				const pos = clampStagePoint(nextLeft, nextTop);
				if (resizingKind === "object") {
					updateWatermarkObject(node, resizeStart.objectIndex, { x: pos.x, y: pos.y }, false);
					if (resizeStart.objectElement) {
						resizeStart.objectElement.style.left = `${pos.x * 100}%`;
						resizeStart.objectElement.style.top = `${pos.y * 100}%`;
					}
				} else if (resizingKind === "watermark") {
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
				if (resizingKind === "object") {
					updateWatermarkObject(node, resizeStart.objectIndex, { x: pos.x, y: pos.y }, false);
					if (resizeStart.objectElement) {
						resizeStart.objectElement.style.left = `${pos.x * 100}%`;
						resizeStart.objectElement.style.top = `${pos.y * 100}%`;
					}
				} else if (resizingKind === "watermark") {
					setWidgetValue(node, "watermark_x", pos.x);
					setWidgetValue(node, "watermark_y", pos.y);
				} else {
					setWidgetValue(node, "text_x", pos.x);
					setWidgetValue(node, "text_y", pos.y);
				}
			}
			if (resizingKind !== "object") renderPanel(node, { fitText: false });
			return;
		}
		if (!dragging) return;
		event.preventDefault();
		drag(event, dragging);
	});
	const finishPointerEdit = () => {
		const wasObjectEdit = dragging === "object" || resizingKind === "object";
		dragging = "";
		draggingObjectIndex = -1;
		draggingObjectElement = null;
		resizingKind = "";
		resizeStart = null;
		if (wasObjectEdit) renderPanel(node, { fitText: false });
	};
	stage.addEventListener("pointerup", finishPointerEdit);
	stage.addEventListener("pointerleave", finishPointerEdit);

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

	node.__gjjTextOverlayUI = { root, toolbar, settings, preview, status, stage, base, bg, objectLayer, objectPicker, foregroundStrokeButton, text, textImg, textResizeNw, textResizeSe, watermark, watermarkImg, watermarkResizeNw, watermarkResizeSe, backgroundLinkButton, watermarkLinkButton, activate };
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
	const info = getUpstreamImageInfo(node, firstConnectedForegroundInputName(node));
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
							.catch((error) => console.warn("[GJJ_TextOverlay] RMBG1.4 前景预览失败", error));
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
						const file = await imageDataUrlToPngFile(data.src, data.filename || "foreground.png");
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
					.catch((error) => console.warn("[GJJ_TextOverlay] 默认网络前景图恢复失败", error))
					.finally(() => { node.__gjjTextOverlayDefaultLogoLoading = false; });
			}
			return true;
		}
		node.__gjjTextOverlayWatermarkSrc = "";
		node.__gjjTextOverlayWatermarkSourceKey = "";
		if (ui?.watermarkImg) ui.watermarkImg.removeAttribute("src");
		if (ui?.watermark) ui.watermark.style.display = "none";
		if (force && ui?.status) {
			ui.status.textContent = "未找到上游前景图片预览，请先执行上游节点。";
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
				.catch((error) => console.warn("[GJJ_TextOverlay] RMBG1.4 前景预览失败", error));
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

function restorePanelBackground(node) {
	if (linkPresent(input(node, "background_image"))) return false;
	let ref = null;
	try {
		const parsed = JSON.parse(stringValue(node, "background_image_ref_json", "{}"));
		if (parsed && typeof parsed === "object" && parsed.filename) ref = parsed;
	} catch (_) {
		ref = null;
	}
	if (!ref) return false;
	const src = imageRefToViewUrl(ref);
	if (!src) return false;
	if (node.__gjjTextOverlayBgSrc === src && node.__gjjTextOverlayUI?.bg?.src) return true;
	setBackgroundImage(node, {
		src,
		width: Number(ref.width || 0),
		height: Number(ref.height || 0),
	}, ref.original_name || ref.filename || "面板背景图");
	return true;
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
		if (restorePanelBackground(node)) return true;
		if (force && ui?.status) {
			ui.status.textContent = "未找到上游背景预览，请先执行上游节点或使用打开图片。";
			ui.status.dataset.show = "true";
			clearTimeout(node.__gjjTextOverlayStatusTimer);
			node.__gjjTextOverlayStatusTimer = setTimeout(() => { ui.status.dataset.show = "false"; }, 2200);
		}
		return false;
	}
	if (!force && node.__gjjTextOverlayBgSrc === src) return true;
	setWidgetValue(node, "background_image_ref_json", "{}");
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

function renderObjectPicker(node) {
	const ui = node.__gjjTextOverlayUI;
	const picker = ui?.objectPicker;
	if (!picker) return;
	const objects = watermarkObjects(node);
	picker.replaceChildren();
	if (!objects.length) {
		picker.style.display = "none";
		if (ui.foregroundStrokeButton) ui.foregroundStrokeButton.dataset.active = boolValue(node, "logo_stroke_enabled", false) ? "true" : "false";
		return;
	}
	picker.style.display = "flex";
	let selected = selectedWatermarkObjectIndex(node);
	if (selected < 0 || selected >= objects.length) {
		selected = objects.length - 1;
		node.__gjjTextOverlaySelectedObjectIndex = selected;
	}
	if (ui.foregroundStrokeButton) {
		ui.foregroundStrokeButton.dataset.active = objects[selected]?.stroke_enabled ? "true" : "false";
	}
	objects.forEach((item, index) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-text-overlay-object-picker-button";
		button.textContent = `👤${index + 1}`;
		button.title = `选择人物 ${index + 1}${item.locked ? "（已锁定）" : ""}${item.stroke_enabled ? "（已描边）" : ""}`;
		button.dataset.active = index === selected ? "true" : "false";
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			node.__gjjTextOverlaySelectedObjectIndex = index;
			node.__gjjTextOverlayActive = "object";
			renderPanel(node, { fitText: false });
		});
		picker.appendChild(button);
	});
}

function renderWatermarkObjects(node, displayScale) {
	const ui = node.__gjjTextOverlayUI;
	const layer = ui?.objectLayer;
	if (!layer) return;
	layer.replaceChildren();
	const objects = watermarkObjects(node);
	const selected = Number(node.__gjjTextOverlaySelectedObjectIndex);
	for (const [index, item] of objects.entries()) {
		const preview = objectPreviewInfo(node, item);
		const src = preview?.src || storedImageSrc(item) || item.src;
		if (!src) continue;
		const wrap = document.createElement("div");
		wrap.className = "gjj-text-overlay-object";
		wrap.dataset.index = String(index);
		wrap.dataset.selected = index === selected ? "true" : "false";
		wrap.dataset.locked = item.locked ? "true" : "false";
		const pos = clampStagePoint(item.x ?? 0.5, item.y ?? 0.5);
		const scale = Math.max(0.01, Math.min(10, Number(item.scale || 1)));
		const baseW = Math.max(1, Number(item.width || 72));
		const baseH = Math.max(1, Number(item.height || 72));
		const displayW = Math.round(baseW * scale * displayScale);
		const displayH = Math.round(baseH * scale * displayScale);
		wrap.style.left = `${pos.x * 100}%`;
		wrap.style.top = `${pos.y * 100}%`;
		wrap.style.width = `${displayW}px`;
		wrap.style.height = `${displayH}px`;
		const img = document.createElement("img");
		img.src = src;
		img.draggable = false;
		img.style.filter = foregroundStrokeFilter(item, displayScale);
		img.style.transform = item.mirror_x ? "scaleX(-1)" : "";
		img.onerror = () => {
			if (removeWatermarkObject(node, index)) {
				showPanelStatus(node, "已清理失效资源", 1200);
				renderPanel(node, { fitText: false });
			}
		};
		const resizeNw = document.createElement("div");
		resizeNw.className = "gjj-text-overlay-resize";
		resizeNw.dataset.corner = "nw";
		const resizeSe = document.createElement("div");
		resizeSe.className = "gjj-text-overlay-resize";
		resizeSe.dataset.corner = "se";
		wrap.append(img, resizeNw, resizeSe);
		if (index === selected) {
			const tools = document.createElement("div");
			tools.className = "gjj-text-overlay-object-tools";
			const addTool = (icon, title, callback) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "gjj-text-overlay-object-tool";
				button.textContent = icon;
				button.title = title;
				button.addEventListener("pointerdown", (event) => {
					event.preventDefault();
					event.stopPropagation();
				});
				button.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					callback(event);
				});
				button.addEventListener("wheel", (event) => {
					event.preventDefault();
					event.stopPropagation();
				}, { passive: false });
				tools.appendChild(button);
				return button;
			};
			const rerender = () => renderPanel(node, { fitText: false });
			addTool("⬇", "下移一层", () => {
				if (moveWatermarkObjectLayer(node, index, -1)) rerender();
			});
			addTool("⬆", "上移一层", () => {
				if (moveWatermarkObjectLayer(node, index, 1)) rerender();
			});
			addTool("←", "向左微调", (event) => {
				if (nudgeWatermarkObject(node, selectedWatermarkObjectIndex(node), -1, 0, event.shiftKey || event.altKey)) rerender();
				else showPanelStatus(node, "对象已锁定", 900);
			});
			addTool("↑", "向上微调", (event) => {
				if (nudgeWatermarkObject(node, selectedWatermarkObjectIndex(node), 0, -1, event.shiftKey || event.altKey)) rerender();
				else showPanelStatus(node, "对象已锁定", 900);
			});
			addTool("↓", "向下微调", (event) => {
				if (nudgeWatermarkObject(node, selectedWatermarkObjectIndex(node), 0, 1, event.shiftKey || event.altKey)) rerender();
				else showPanelStatus(node, "对象已锁定", 900);
			});
			addTool("→", "向右微调", (event) => {
				if (nudgeWatermarkObject(node, selectedWatermarkObjectIndex(node), 1, 0, event.shiftKey || event.altKey)) rerender();
				else showPanelStatus(node, "对象已锁定", 900);
			});
			addTool("＋", "放大", () => {
				if (adjustWatermarkObjectScale(node, selectedWatermarkObjectIndex(node), 1, false)) rerender();
				else showPanelStatus(node, "对象已锁定", 900);
			});
			addTool("－", "缩小", () => {
				if (adjustWatermarkObjectScale(node, selectedWatermarkObjectIndex(node), -1, false)) rerender();
				else showPanelStatus(node, "对象已锁定", 900);
			});
			const mirrorButton = addTool("↔", "水平镜像", () => {
				if (toggleWatermarkObjectMirror(node, selectedWatermarkObjectIndex(node))) rerender();
				else showPanelStatus(node, "对象已锁定", 900);
			});
			if (mirrorButton) mirrorButton.dataset.active = item.mirror_x ? "true" : "false";
			const lockButton = addTool(item.locked ? "🔒" : "🔓", item.locked ? "已锁定，点击解锁" : "未锁定，点击锁定", () => {
				if (toggleWatermarkObjectLock(node, selectedWatermarkObjectIndex(node))) rerender();
			});
			if (lockButton) lockButton.dataset.active = item.locked ? "true" : "false";
			const stageWidth = Math.max(1, ui.stage?.clientWidth || 1);
			const stageHeight = Math.max(1, ui.stage?.clientHeight || 1);
			const objectLeft = pos.x * stageWidth;
			const objectTop = pos.y * stageHeight;
			const toolWidth = 28;
			const toolGap = 4;
			const toolHeight = Math.min(
				stageHeight - 8,
				10 * 19,
			);
			const rightFits = objectLeft + displayW + toolGap + toolWidth <= stageWidth;
			const leftFits = objectLeft - toolGap - toolWidth >= 0;
			if (!rightFits && leftFits) {
				tools.style.left = "auto";
				tools.style.right = `calc(100% + ${toolGap}px)`;
			}
			if (objectTop + toolHeight > stageHeight) {
				tools.style.top = `${Math.max(-objectTop, stageHeight - objectTop - toolHeight)}px`;
			}
			tools.style.maxHeight = `${Math.max(48, stageHeight - 8)}px`;
			tools.style.overflowY = "auto";
			wrap.appendChild(tools);
		}
		wrap.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			ui.preview?.focus?.();
			node.__gjjTextOverlaySelectedObjectIndex = index;
			if (item.locked) {
				node.__gjjTextOverlayActive = "object";
				renderPanel(node, { fitText: false });
				return;
			}
			node.__gjjTextOverlayStartObjectDrag?.(event, index, wrap);
		});
		wrap.addEventListener("wheel", (event) => {
			event.preventDefault();
			event.stopPropagation();
			ui.preview?.focus?.();
			node.__gjjTextOverlaySelectedObjectIndex = index;
			const direction = event.deltaY < 0 ? 1 : -1;
			if (adjustWatermarkObjectScale(node, index, direction, event.shiftKey || event.altKey)) {
				renderPanel(node, { fitText: false });
			} else if (item.locked) {
				showPanelStatus(node, "对象已锁定", 900);
			}
		}, { passive: false });
		resizeNw.addEventListener("pointerdown", (event) => {
			if (!item.locked) node.__gjjTextOverlayStartObjectResize?.(event, index, "nw", wrap, resizeNw);
		});
		resizeSe.addEventListener("pointerdown", (event) => {
			if (!item.locked) node.__gjjTextOverlayStartObjectResize?.(event, index, "se", wrap, resizeSe);
		});
		layer.appendChild(wrap);
	}
}

function renderPanel(node, options = {}) {
	const ui = node.__gjjTextOverlayUI;
	if (!ui) return;
	const hasBgSize = syncBackgroundSizeFromImage(node);
	const linkedObjectCount = syncLinkedWatermarkObjects(node);
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
	renderObjectPicker(node);
	renderWatermarkObjects(node, displayScale);
	const wmDisplayWidth = Math.round(baseW * scale * displayScale);
	const wmDisplayHeight = Math.round(baseH * scale * displayScale);
	const wmPos = clampStagePoint(wmX, wmY);
	ui.watermark.style.left = `${wmPos.x * 100}%`;
	ui.watermark.style.top = `${wmPos.y * 100}%`;
	ui.watermark.style.width = `${wmDisplayWidth}px`;
	ui.watermark.style.height = `${wmDisplayHeight}px`;
	updateWatermarkPreviewStyle(node);
	ui.watermark.style.display = linkedObjectCount <= 0 && (connectedForegroundInputNames(node).length > 0 || stringValue(node, "watermark_upload_name", "")) && ui.watermarkImg.src ? "flex" : "none";
	if (connectedForegroundInputNames(node).length > 0) refreshWatermarkPreview(node, false);
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
	ensureForegroundInputs(node);
	ensurePanel(node);
	restorePreviewSizes(node);
	refreshBackground(node, false);
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
				ensureForegroundInputs(this);
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

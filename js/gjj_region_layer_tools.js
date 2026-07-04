import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_BOX = "GJJ_RegionBox";
const TARGET_CROP = "GJJ_RegionCrop";
const TARGET_COMPOSITE = "GJJ_RegionComposite";
const BOX_IMAGE_INPUT = "image";
const CROP_IMAGE_INPUT = "image";
const CROP_REGION_INPUT = "region";
const CROP_CONFIG_WIDGET = "crop_config";
const CROP_IMAGE_FILE_WIDGET = "image_file";
const CROP_TOTAL_PIXELS_WIDGET = "total_pixels";
const CROP_SCALE_RATIO_WIDGET = "scale_ratio";
const CROP_ALIGN_MULTIPLE_WIDGET = "align_multiple";
const CROP_PANEL_WIDGET = "gjj_region_crop_panel";
const CROP_STORED_LINKS_PROPERTY = "__gjjRegionCropStoredLinks";
const CROP_EXTRA_PORTS_PROPERTY = "__gjjRegionCropExtraPorts";
const CROP_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const CROP_IMAGE_OUTPUT = "裁剪图像";
const CROP_MASK_OUTPUT = "裁剪遮罩";
const COMPOSITE_IMAGE_INPUT = "base_image";
const CANVAS_W_WIDGET = "canvas_width";
const CANVAS_H_WIDGET = "canvas_height";
const CROP_PREVIEW_PAD = 12;
const CROP_PREVIEW_LABEL_H = 22;
const CROP_PREVIEW_MIN_W = 160;
const CROP_PANEL_MIN_H = 170;
const CROP_SOURCE_WATCH_MS = 350;
const CROP_HANDLE_SIZE = 10;
const CROP_HANDLE_HIT_RADIUS = 18;
const CROP_MOVE_HANDLE_SIZE = 18;
const CROP_MOVE_HIT_RADIUS = 24;
const CROP_ROTATE_HANDLE_SIZE = 10;
const CROP_ROTATE_HIT_RADIUS = 18;
const CROP_ROTATE_HANDLE_OFFSET = 28;
const CROP_HIDDEN_WIDGETS = [CROP_CONFIG_WIDGET, CROP_IMAGE_FILE_WIDGET, CROP_TOTAL_PIXELS_WIDGET, CROP_SCALE_RATIO_WIDGET, CROP_ALIGN_MULTIPLE_WIDGET];
const CROP_ALIGN_POWERS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

// ─── Helpers ───────────────────────────────────────────────────────

function getWidget(node, name) {
	return node.widgets?.find?.((w) => w.name === name);
}

function getFirstValue(arr) {
	if (Array.isArray(arr) && arr.length > 0) return arr[0];
	return arr;
}

function refreshNode(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function clearCropNativePreview(node) {
	if (!node) return;
	node.imgs = null;
	node.imageIndex = 0;
	node.overIndex = null;
	node.animatedImages = null;
	node.currentImage = null;
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
	const num = Number(getFirstValue(value));
	return Number.isFinite(num) ? num : fallback;
}

function safeJsonParse(value, fallback = {}) {
	try {
		const data = JSON.parse(String(value || "").trim() || "{}");
		return data && typeof data === "object" ? data : fallback;
	} catch (_) {
		return fallback;
	}
}

function hasInputLink(node, name) {
	const input = node.inputs?.find?.((i) => i.name === name);
	return Boolean(input?.link);
}

function hasOutputLink(node, name) {
	const output = node.outputs?.find?.((item) => item.name === name);
	return Array.isArray(output?.links) && output.links.some((link) => link != null);
}

function removeInputSlot(node, index) {
	if (!Array.isArray(node?.inputs) || index < 0 || index >= node.inputs.length) return;
	try { node.disconnectInput?.(index); } catch (_) {}
	try { node.removeInput?.(index); } catch (_) { node.inputs.splice(index, 1); }
}

function removeOutputSlot(node, index) {
	if (!Array.isArray(node?.outputs) || index < 0 || index >= node.outputs.length) return;
	try { node.disconnectOutput?.(index); } catch (_) {}
	try { node.removeOutput?.(index); } catch (_) { node.outputs.splice(index, 1); }
}

function hideWidget(widget) {
	if (!widget || widget.__gjjHidden) return;
	widget.__gjjHidden = {
		type: widget.type,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		y: widget.y,
		last_y: widget.last_y,
	};
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	if (widget.options) {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.y = -99999;
	widget.last_y = -99999;
}

function removeConvertedWidgetInput(node, widgetName) {
	for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
		const input = node.inputs[i];
		const type = String(input?.type || "");
		const name = String(input?.name || "");
		const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
		if (name === widgetName || converted === widgetName || input?.widget?.name === widgetName) {
			try { node.disconnectInput?.(i); } catch (_) {}
			try { node.removeInput?.(i); } catch (_) { node.inputs.splice(i, 1); }
		}
	}
}

function ensureCropConfigWidget(node) {
	const widget = getWidget(node, CROP_CONFIG_WIDGET);
	if (widget) {
		hideWidget(widget);
		widget.serialize = true;
		widget.serializeValue = () => String(widget.value || "");
	}
	removeConvertedWidgetInput(node, CROP_CONFIG_WIDGET);
	return widget;
}

function ensureCropHiddenWidgets(node) {
	for (const name of CROP_HIDDEN_WIDGETS) {
		const widget = getWidget(node, name);
		if (widget) hideWidget(widget);
		removeConvertedWidgetInput(node, name);
	}
	return getWidget(node, CROP_CONFIG_WIDGET);
}

function showCropExtraPorts(node) {
	return node?.properties?.[CROP_EXTRA_PORTS_PROPERTY] === true;
}

function updateCropPortsButton(node) {
	const button = node.__gjjRegionCropPortsButton;
	if (!button) return;
	const active = showCropExtraPorts(node);
	button.style.opacity = active ? "1" : "0.62";
	button.style.background = active ? "#1f3b35" : "#172429";
	button.title = active ? "隐藏区域数据输入和裁剪遮罩输出。" : "显示区域数据输入和裁剪遮罩输出。";
}

function applyCropPorts(node, fromUser = false) {
	if (!node) return;
	node.properties ??= {};
	if (!Array.isArray(node.inputs)) node.inputs = [];
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const hasRegionLink = hasInputLink(node, CROP_REGION_INPUT);
	const hasMaskLink = hasOutputLink(node, CROP_MASK_OUTPUT);
	if (!showCropExtraPorts(node) && !fromUser && (hasRegionLink || hasMaskLink)) {
		node.properties[CROP_EXTRA_PORTS_PROPERTY] = true;
	}
	const showExtra = showCropExtraPorts(node);

	let imageInput = node.inputs.find((input) => input.name === CROP_IMAGE_INPUT);
	if (!imageInput) {
		node.addInput?.(CROP_IMAGE_INPUT, CROP_IMAGE_TYPE);
		imageInput = node.inputs[node.inputs.length - 1];
	}
	if (imageInput) {
		imageInput.name = CROP_IMAGE_INPUT;
		imageInput.label = "输入图像";
		imageInput.localized_name = "输入图像";
		imageInput.type = CROP_IMAGE_TYPE;
	}

	let regionIndex = node.inputs.findIndex((input) => input.name === CROP_REGION_INPUT);
	if (showExtra) {
		if (regionIndex < 0) {
			node.addInput?.(CROP_REGION_INPUT, "GJJ_REGION");
			regionIndex = node.inputs.length - 1;
		}
		const regionInput = node.inputs[regionIndex];
		if (regionInput) {
			regionInput.name = CROP_REGION_INPUT;
			regionInput.label = "区域数据";
			regionInput.localized_name = "区域数据";
			regionInput.type = "GJJ_REGION";
		}
	} else if (regionIndex >= 0 && (!hasRegionLink || fromUser)) {
		removeInputSlot(node, regionIndex);
	}

	while (node.outputs.length < 1) node.addOutput?.(CROP_IMAGE_OUTPUT, CROP_IMAGE_TYPE);
	const imageOutput = node.outputs[0];
	if (imageOutput) {
		imageOutput.name = CROP_IMAGE_OUTPUT;
		imageOutput.label = CROP_IMAGE_OUTPUT;
		imageOutput.localized_name = CROP_IMAGE_OUTPUT;
		imageOutput.type = CROP_IMAGE_TYPE;
	}
	let maskIndex = node.outputs.findIndex((output, index) => index > 0 && output.name === CROP_MASK_OUTPUT);
	if (maskIndex < 0 && node.outputs[1]?.type === "MASK") maskIndex = 1;
	if (showExtra) {
		if (maskIndex < 0) {
			node.addOutput?.(CROP_MASK_OUTPUT, "MASK");
			maskIndex = node.outputs.length - 1;
		}
		const maskOutput = node.outputs[maskIndex];
		if (maskOutput) {
			maskOutput.name = CROP_MASK_OUTPUT;
			maskOutput.label = CROP_MASK_OUTPUT;
			maskOutput.localized_name = CROP_MASK_OUTPUT;
			maskOutput.type = "MASK";
		}
	} else if (maskIndex >= 0 && (!hasMaskLink || fromUser)) {
		removeOutputSlot(node, maskIndex);
	}

	updateCropPortsButton(node);
	refreshNode(node);
}

function toggleCropExtraPorts(node) {
	node.properties ??= {};
	node.properties[CROP_EXTRA_PORTS_PROPERTY] = !showCropExtraPorts(node);
	applyCropPorts(node, true);
}

function readCropConfig(node) {
	return safeJsonParse(getWidget(node, CROP_CONFIG_WIDGET)?.value, {});
}

function writeCropConfig(node, patch) {
	const widget = getWidget(node, CROP_CONFIG_WIDGET);
	if (!widget) return;
	const previous = readCropConfig(node);
	const next = { ...previous, ...patch };
	for (const key of ["x", "y", "width", "height", "canvas_width", "canvas_height"]) {
		next[key] = Math.round(toNumber(next[key], key.includes("width") || key.includes("height") ? 1 : 0));
	}
	next.angle = normalizeAngle(toNumber(next.angle, 0));
	const serialized = JSON.stringify(next);
	widget.value = serialized;
	widget.serialize = true;
	widget.serializeValue = () => serialized;
	node.properties ??= {};
	node.properties.__gjjRegionCropConfig = next;
	try {
		widget.callback?.call(widget, serialized, app.canvas, node);
	} catch (_) {}
	try {
		node.graph?.change?.();
	} catch (_) {}
	try {
		app.graph?.change?.();
	} catch (_) {}
	refreshNode(node);
}

function uploadUrl(path) {
	try {
		if (api?.apiURL) return api.apiURL(path);
	} catch (_) {}
	return path;
}

function uploadedImageWidgetValue(data, fallbackName = "") {
	const filename = String(data?.name || data?.filename || data?.file || fallbackName || "").replace(/\\/g, "/").trim();
	const subfolder = String(data?.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
	return subfolder && !filename.startsWith(`${subfolder}/`) ? `${subfolder}/${filename}` : filename;
}

async function uploadCropImageFile(file) {
	const endpoints = ["/upload/image", "/api/upload/image"];
	let lastError = null;
	for (const endpoint of endpoints) {
		const form = new FormData();
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");
		try {
			const response = await (api?.fetchApi
				? api.fetchApi(endpoint, { method: "POST", body: form })
				: fetch(uploadUrl(endpoint), { method: "POST", body: form }));
			if (!response.ok) {
				lastError = new Error(`HTTP ${response.status}`);
				continue;
			}
			const data = await response.json().catch(() => ({}));
			return uploadedImageWidgetValue(data, file.name);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new Error("图片上传失败");
}

async function loadCropUserSettings() {
	try {
		const response = await (api?.fetchApi ? api.fetchApi("/gjj/region_crop/settings") : fetch(uploadUrl("/gjj/region_crop/settings")));
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		return {
			total_pixels: Math.max(10, Math.round(toNumber(data?.total_pixels, 10))),
			align_multiple: nearestCropAlignPower(data?.align_multiple ?? 8),
		};
	} catch (_) {
		return null;
	}
}

async function saveCropUserSettings(totalPixels, alignMultiple) {
	const payload = {
		total_pixels: Math.max(10, Math.round(toNumber(totalPixels, 10))),
		align_multiple: nearestCropAlignPower(alignMultiple),
	};
	try {
		const response = await (api?.fetchApi
			? api.fetchApi("/gjj/region_crop/settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			})
			: fetch(uploadUrl("/gjj/region_crop/settings"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}));
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await response.json();
	} catch (error) {
		console.error("[GJJ RegionCrop] 保存参数失败：", error);
		return payload;
	}
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return false;
	widget.options ??= {};
	const values = widget.options.values || widget.options.comboValues || widget.values;
	if (Array.isArray(values) && value && !values.includes(value)) values.push(value);
	widget.value = value;
	try { widget.callback?.call(widget, value, app.canvas, node); } catch (_) {}
	try { node.graph?.change?.(); } catch (_) {}
	refreshNode(node);
	return true;
}

function cropImageFileUrl(value) {
	const text = String(value || "").replace(/\\/g, "/").trim();
	if (!text) return "";
	const parts = text.split("/");
	const filename = parts.pop() || "";
	const subfolder = parts.join("/");
	return `/api/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`;
}

function degToRad(value) {
	return Number(value || 0) * Math.PI / 180;
}

function radToDeg(value) {
	return Number(value || 0) * 180 / Math.PI;
}

function normalizeAngle(value) {
	let angle = Number(value || 0);
	if (!Number.isFinite(angle)) angle = 0;
	angle = ((angle + 180) % 360 + 360) % 360 - 180;
	return Math.round(angle * 10) / 10;
}

function rotatePoint(x, y, cx, cy, angleRad) {
	const dx = x - cx;
	const dy = y - cy;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// ─── GJJ_RegionBox image → canvas size auto-sync ──────────────────

function syncRegionBoxImageSize(node, message) {
	const imgW = getFirstValue(message?.image_width);
	const imgH = getFirstValue(message?.image_height);
	if (imgW == null || imgH == null) return;

	const w = Number(imgW);
	const h = Number(imgH);
	if (!Number.isFinite(w) || !Number.isFinite(h)) return;

	const sig = `${w}x${h}`;
	const props = (node.properties ??= {});
	// 仅在图片尺寸确实变化时才同步，已手动编辑的值会被保留
	if (props.__gjjRegionBoxImageSig === sig) return;
	props.__gjjRegionBoxImageSig = sig;

	const cw = getWidget(node, CANVAS_W_WIDGET);
	const ch = getWidget(node, CANVAS_H_WIDGET);
	if (cw) cw.value = w;
	if (ch) ch.value = h;
	refreshNode(node);
}

// ─── GJJ_RegionCrop node-layer preview ────────────────────────────

function ensureCropPreviewState(node) {
	return (node.__gjjRegionCropPreview ??= {
		image: null,
		loadingSrc: "",
		src: "",
		sourceWidth: 0,
		sourceHeight: 0,
		cropX: 0,
		cropY: 0,
		cropWidth: 0,
		cropHeight: 0,
	});
}

function getCropPreviewGeometry(node) {
	const state = node.__gjjRegionCropPreview;
	if (!state?.image || node.flags?.collapsed) return null;

	const sourceW = Math.max(1, state.sourceWidth || state.image.naturalWidth || state.image.width || 1);
	const sourceH = Math.max(1, state.sourceHeight || state.image.naturalHeight || state.image.height || 1);
	const areaW = Math.max(CROP_PREVIEW_MIN_W, (node.size?.[0] || 300) - CROP_PREVIEW_PAD * 2);
	const imageH = Math.max(1, Math.round(areaW * sourceH / sourceW));
	const totalH = imageH + CROP_PREVIEW_LABEL_H + CROP_PREVIEW_PAD * 2;
	const x = CROP_PREVIEW_PAD;
	const y = Math.max(44, (node.size?.[1] || totalH) - totalH + CROP_PREVIEW_PAD);
	return { x, y, areaW, imageH, totalH, sourceW, sourceH };
}

function getCropPreviewExtraHeight(node) {
	return 0;
}

function ensureCropPreviewSize(node) {
	if (!node?.__gjjRegionCropPreview?.image) return;
	const currentW = Math.max(CROP_PREVIEW_MIN_W + CROP_PREVIEW_PAD * 2, node.size?.[0] || 300);
	const computed = node.computeSize?.() || [currentW, node.size?.[1] || 160];
	node.setSize?.([currentW, Math.round(computed[1])]);
	refreshNode(node);
}

function clearCropPreview(node) {
	if (!node) return;
	node.__gjjRegionCropPreview = null;
	refreshNode(node);
}

function clearCropPanelImage(node, statusText = "等待图片预览") {
	const panel = node.__gjjRegionCropPanel;
	if (!panel) return;
	panel.image = null;
	panel.src = "";
	panel.sourceSignature = "";
	panel.sourceWidth = 0;
	panel.sourceHeight = 0;
	if (panel.sizeLine) panel.sizeLine.textContent = statusText;
	renderCropPanel(node);
	refreshNode(node);
}

function getCropSourceDescriptor(node) {
	const input = node.inputs?.find?.((i) => i.name === CROP_IMAGE_INPUT);
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) return null;
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	if (!sourceNode) return null;
	const imageWidget = getWidget(sourceNode, "image");
	const filename = String(imageWidget?.value || "").trim();
	if (!filename) return null;
	let viewType = null;
	if (sourceNode.comfyClass === "LoadImage") viewType = "input";
	else if (sourceNode.comfyClass === "LoadImageOutput") viewType = "output";
	if (!viewType) return null;
	const signature = `${linkId}:${sourceNode.id}:${sourceNode.comfyClass}:${viewType}:${filename}`;
	return { filename, signature, sourceNode, viewType };
}

function getCropFileDescriptor(node) {
	const value = String(getWidget(node, CROP_IMAGE_FILE_WIDGET)?.value || "").trim();
	if (!value) return null;
	const src = cropImageFileUrl(value);
	if (!src) return null;
	return { src, signature: `file:${value}`, filename: value };
}

function setCropPanelImage(node, src, width = 0, height = 0, signature = "") {
	const panel = node.__gjjRegionCropPanel;
	if (!panel || !src) return;
	if (signature && panel.sourceSignature === signature && panel.image) {
		renderCropPanel(node);
		return;
	}
	if (!signature && panel.src === src && panel.image) {
		renderCropPanel(node);
		return;
	}
	panel.src = src;
	panel.sourceSignature = signature || src;
	if (panel.sizeLine) panel.sizeLine.textContent = "加载预览中...";
	const image = new Image();
	image.onload = () => {
		if (panel.src !== src || (signature && panel.sourceSignature !== signature)) return;
		panel.image = image;
		panel.sourceWidth = Math.round(width || image.naturalWidth || image.width || 1);
		panel.sourceHeight = Math.round(height || image.naturalHeight || image.height || 1);
		const config = readCropConfig(node);
		if (!config.width || !config.height || config.canvas_width !== panel.sourceWidth || config.canvas_height !== panel.sourceHeight) {
			const defaultW = Math.max(1, Math.round(panel.sourceWidth / 2));
			const defaultH = Math.max(1, Math.round(panel.sourceHeight / 2));
			writeCropConfig(node, {
				x: Math.max(0, Math.round((panel.sourceWidth - defaultW) / 2)),
				y: Math.max(0, Math.round((panel.sourceHeight - defaultH) / 2)),
				width: defaultW,
				height: defaultH,
				angle: 0,
				canvas_width: panel.sourceWidth,
				canvas_height: panel.sourceHeight,
			});
		}
		resizeCropPanel(node);
		renderCropPanel(node);
	};
	image.onerror = () => {
		if (panel.src === src && panel.sizeLine) panel.sizeLine.textContent = "预览加载失败，执行后会刷新。";
		renderCropPanel(node);
	};
	image.src = src;
}

function updateCropPreview(node, message) {
	const src = getFirstValue(message?.preview_image) || getFirstValue(message?.ui?.preview_image);
	if (!src) return;

	const state = ensureCropPreviewState(node);
	state.sourceWidth = toNumber(message?.source_width ?? message?.ui?.source_width, state.sourceWidth);
	state.sourceHeight = toNumber(message?.source_height ?? message?.ui?.source_height, state.sourceHeight);
	state.cropX = toNumber(message?.crop_x ?? message?.ui?.crop_x, state.cropX);
	state.cropY = toNumber(message?.crop_y ?? message?.ui?.crop_y, state.cropY);
	state.cropWidth = toNumber(message?.crop_width ?? message?.ui?.crop_width, state.cropWidth);
	state.cropHeight = toNumber(message?.crop_height ?? message?.ui?.crop_height, state.cropHeight);
	const regionX = toNumber(message?.region_x ?? message?.ui?.region_x, state.cropX);
	const regionY = toNumber(message?.region_y ?? message?.ui?.region_y, state.cropY);
	const regionW = toNumber(message?.region_width ?? message?.ui?.region_width, state.cropWidth);
	const regionH = toNumber(message?.region_height ?? message?.ui?.region_height, state.cropHeight);
	const currentConfig = readCropConfig(node);
	const angle = toNumber(message?.crop_angle ?? message?.ui?.crop_angle, currentConfig.angle || 0);
	writeCropConfig(node, {
		x: regionX,
		y: regionY,
		width: regionW,
		height: regionH,
		angle,
		canvas_width: state.sourceWidth,
		canvas_height: state.sourceHeight,
	});
	const descriptor = getCropSourceDescriptor(node);
	const signature = descriptor?.signature || `executed:${src.length}:${state.sourceWidth}x${state.sourceHeight}`;
	setCropPanelImage(node, src, state.sourceWidth, state.sourceHeight, signature);

	if (state.src === src && state.image) {
		ensureCropPreviewSize(node);
		return;
	}
	state.loadingSrc = src;

	const image = new Image();
	image.onload = () => {
		if (ensureCropPreviewState(node).loadingSrc !== src) return;
		const current = ensureCropPreviewState(node);
		current.image = image;
		current.src = src;
		current.loadingSrc = "";
		if (!current.sourceWidth) current.sourceWidth = image.naturalWidth || image.width || 1;
		if (!current.sourceHeight) current.sourceHeight = image.naturalHeight || image.height || 1;
		ensureCropPreviewSize(node);
	};
	image.onerror = () => {
		if (node.__gjjRegionCropPreview?.loadingSrc === src) node.__gjjRegionCropPreview.loadingSrc = "";
		refreshNode(node);
	};
	image.src = src;
}

function cropPanelHeight(node) {
	const panel = node.__gjjRegionCropPanel;
	const sourceW = Math.max(1, panel?.sourceWidth || panel?.image?.naturalWidth || 1);
	const sourceH = Math.max(1, panel?.sourceHeight || panel?.image?.naturalHeight || 1);
	const width = Math.max(160, Math.round((node.size?.[0] || 300) - 24));
	const imageH = panel?.image ? Math.round(width * sourceH / sourceW) : 132;
	return Math.max(CROP_PANEL_MIN_H, imageH + 84);
}

function alignCropSize(value, multiple) {
	const align = nearestCropAlignPower(multiple);
	if (align <= 1) return Math.max(1, Math.round(value));
	return Math.max(align, Math.round(Math.max(1, value) / align) * align);
}

function nearestCropAlignPower(value) {
	const raw = clamp(Math.round(toNumber(value, 8)), 1, 256);
	return CROP_ALIGN_POWERS.reduce((best, item) => Math.abs(item - raw) < Math.abs(best - raw) ? item : best, 8);
}

function cropAlignPowerIndex(value) {
	const align = nearestCropAlignPower(value);
	return Math.max(0, CROP_ALIGN_POWERS.indexOf(align));
}

function outputCropSize(node, width, height) {
	const totalWanPixels = Math.max(10, Math.round(toNumber(getWidget(node, CROP_TOTAL_PIXELS_WIDGET)?.value, 10)));
	const totalPixels = totalWanPixels > 10000 ? Math.round(totalWanPixels) : Math.round(totalWanPixels * 10000);
	const alignMultiple = nearestCropAlignPower(getWidget(node, CROP_ALIGN_MULTIPLE_WIDGET)?.value);
	let ratio = 1;
	if (totalPixels > 0) {
		ratio *= Math.sqrt(totalPixels / Math.max(1, width * height));
	}
	return {
		width: alignCropSize(width * ratio, alignMultiple),
		height: alignCropSize(height * ratio, alignMultiple),
	};
}

function getCropPanelCanvasRect(node) {
	const panel = node.__gjjRegionCropPanel;
	if (!panel?.canvas) return null;
	const width = Math.max(140, Math.round((node.size?.[0] || 300) - 24));
	const sourceW = Math.max(1, panel.sourceWidth || panel.image?.naturalWidth || 1);
	const sourceH = Math.max(1, panel.sourceHeight || panel.image?.naturalHeight || 1);
	const height = panel.image ? Math.max(1, Math.round(width * sourceH / sourceW)) : 132;
	return { width, height, sourceW, sourceH };
}

function clampCropConfig(node, config = readCropConfig(node)) {
	const panel = node.__gjjRegionCropPanel || {};
	const sourceW = Math.max(1, panel.sourceWidth || config.canvas_width || 1);
	const sourceH = Math.max(1, panel.sourceHeight || config.canvas_height || 1);
	const w = clamp(Math.round(toNumber(config.width, Math.round(sourceW / 2))), 1, sourceW);
	const h = clamp(Math.round(toNumber(config.height, Math.round(sourceH / 2))), 1, sourceH);
	const x = clamp(Math.round(toNumber(config.x, 0)), 0, Math.max(0, sourceW - w));
	const y = clamp(Math.round(toNumber(config.y, 0)), 0, Math.max(0, sourceH - h));
	const angle = normalizeAngle(toNumber(config.angle, 0));
	return { x, y, width: w, height: h, angle, canvas_width: sourceW, canvas_height: sourceH };
}

function renderCropPanel(node) {
	const panel = node.__gjjRegionCropPanel;
	const rect = getCropPanelCanvasRect(node);
	if (!panel?.canvas || !rect) return;
	const { canvas, sizeLine } = panel;
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	canvas.style.width = `${rect.width}px`;
	canvas.style.height = `${rect.height}px`;
	canvas.width = Math.round(rect.width * dpr);
	canvas.height = Math.round(rect.height * dpr);
	const ctx = canvas.getContext("2d");
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, rect.width, rect.height);
	ctx.fillStyle = "#10181b";
	ctx.fillRect(0, 0, rect.width, rect.height);

	if (!panel.image) {
		ctx.strokeStyle = "rgba(255,255,255,0.18)";
		ctx.strokeRect(0.5, 0.5, rect.width - 1, rect.height - 1);
		ctx.fillStyle = "#8fa2a6";
		ctx.font = "12px Arial";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText("连接图片后显示框选预览", rect.width / 2, rect.height / 2);
		if (sizeLine) sizeLine.textContent = "裁剪后宽高 -- x --";
		return;
	}

	ctx.drawImage(panel.image, 0, 0, rect.width, rect.height);
	const config = clampCropConfig(node);
	const box = cropDisplayBoxFromConfig(config, rect);
	const { left: x, top: y, right, bottom, points } = box;
	const w = Math.max(1, right - x);
	const h = Math.max(1, bottom - y);
	ctx.fillStyle = "rgba(0,0,0,0.46)";
	ctx.beginPath();
	ctx.rect(0, 0, rect.width, rect.height);
	ctx.moveTo(points.nw.x, points.nw.y);
	ctx.lineTo(points.ne.x, points.ne.y);
	ctx.lineTo(points.se.x, points.se.y);
	ctx.lineTo(points.sw.x, points.sw.y);
	ctx.closePath();
	ctx.fill("evenodd");
	ctx.strokeStyle = "#35e2c2";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(points.nw.x, points.nw.y);
	ctx.lineTo(points.ne.x, points.ne.y);
	ctx.lineTo(points.se.x, points.se.y);
	ctx.lineTo(points.sw.x, points.sw.y);
	ctx.closePath();
	ctx.stroke();
	ctx.fillStyle = "#35e2c2";
	ctx.strokeStyle = "rgba(7,18,20,0.85)";
	ctx.lineWidth = 1;
	for (const handle of cropHandleRects(box)) {
		const { cx, cy, left, top } = handle;
		ctx.fillRect(left, top, CROP_HANDLE_SIZE, CROP_HANDLE_SIZE);
		ctx.strokeRect(left + 0.5, top + 0.5, CROP_HANDLE_SIZE - 1, CROP_HANDLE_SIZE - 1);
		ctx.fillStyle = "rgba(255,255,255,0.75)";
		ctx.fillRect(cx - 1, cy - 1, 2, 2);
		ctx.fillStyle = "#35e2c2";
	}
	const moveHandle = cropMoveHandleRect(box);
	ctx.fillStyle = "rgba(53,226,194,0.96)";
	ctx.beginPath();
	ctx.arc(moveHandle.cx, moveHandle.cy, CROP_MOVE_HANDLE_SIZE / 2, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = "rgba(255,255,255,0.9)";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(moveHandle.cx - CROP_MOVE_HANDLE_SIZE / 2 + 3, moveHandle.cy);
	ctx.lineTo(moveHandle.cx + CROP_MOVE_HANDLE_SIZE / 2 - 3, moveHandle.cy);
	ctx.moveTo(moveHandle.cx, moveHandle.cy - CROP_MOVE_HANDLE_SIZE / 2 + 3);
	ctx.lineTo(moveHandle.cx, moveHandle.cy + CROP_MOVE_HANDLE_SIZE / 2 - 3);
	ctx.stroke();
	ctx.strokeStyle = "rgba(7,18,20,0.85)";
	ctx.lineWidth = 1;
	const rotateHandle = cropRotateHandleRect(box);
	ctx.beginPath();
	ctx.moveTo(box.center.x, box.center.y);
	ctx.lineTo(rotateHandle.cx, rotateHandle.cy);
	ctx.stroke();
	ctx.fillStyle = "#ffcf4a";
	ctx.beginPath();
	ctx.arc(rotateHandle.cx, rotateHandle.cy, CROP_ROTATE_HANDLE_SIZE / 2, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();
	if (sizeLine) {
		const out = outputCropSize(node, config.width, config.height);
		const suffix = out.width === config.width && out.height === config.height ? "" : ` -> ${out.width} x ${out.height}`;
		sizeLine.textContent = `裁剪后宽高 ${config.width} x ${config.height}${suffix}  旋转 ${Math.round(config.angle)}°`;
	}
}

function resizeCropPanel(node) {
	const panel = node.__gjjRegionCropPanel;
	if (!panel?.widget) return;
	const width = Math.round(node.size?.[0] || 300);
	const height = Math.round(cropPanelHeight(node));
	panel.widget.computeSize = () => [width, height];
	panel.widget.getHeight = () => height;
	panel.root.style.width = `${Math.max(160, width - 18)}px`;
	panel.root.style.height = `${height}px`;
	panel.root.style.overflow = "hidden";
	renderCropPanel(node);
	setTimeout(() => {
		const nextH = Math.round(node.computeSize?.()[1] || height);
		const currentH = Math.round(node.size?.[1] || 0);
		if (Math.abs(nextH - currentH) > 1) {
			node.setSize?.([Math.round(node.size?.[0] || width), nextH]);
		}
		refreshNode(node);
	}, 0);
}

function cropCanvasPoint(node, event) {
	const geo = getCropPanelCanvasRect(node);
	const point = cropCanvasDisplayPoint(node, event);
	if (!point || !geo) return null;
	const x = clamp(point.x / Math.max(1, geo.width) * geo.sourceW, 0, geo.sourceW);
	const y = clamp(point.y / Math.max(1, geo.height) * geo.sourceH, 0, geo.sourceH);
	return { x, y };
}

function cropDisplayBoxFromConfig(config, rect) {
	const scaleX = rect.width / rect.sourceW;
	const scaleY = rect.height / rect.sourceH;
	const left = Math.round(config.x * scaleX);
	const top = Math.round(config.y * scaleY);
	const right = Math.round((config.x + config.width) * scaleX);
	const bottom = Math.round((config.y + config.height) * scaleY);
	const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
	const angleRad = degToRad(config.angle || 0);
	const points = {
		nw: rotatePoint(left, top, center.x, center.y, angleRad),
		ne: rotatePoint(right, top, center.x, center.y, angleRad),
		sw: rotatePoint(left, bottom, center.x, center.y, angleRad),
		se: rotatePoint(right, bottom, center.x, center.y, angleRad),
	};
	return {
		left: clamp(left, 0, rect.width),
		top: clamp(top, 0, rect.height),
		right: clamp(right, 0, rect.width),
		bottom: clamp(bottom, 0, rect.height),
		center,
		points,
		angle: config.angle || 0,
		scaleX,
		scaleY,
	};
}

function cropDisplayGeometry(node) {
	const rect = getCropPanelCanvasRect(node);
	if (!rect) return null;
	const config = clampCropConfig(node);
	const box = cropDisplayBoxFromConfig(config, rect);
	return {
		rect,
		config,
		x: box.left,
		y: box.top,
		w: Math.max(1, box.right - box.left),
		h: Math.max(1, box.bottom - box.top),
		right: box.right,
		bottom: box.bottom,
		center: box.center,
		points: box.points,
		angle: box.angle,
		scaleX: box.scaleX,
		scaleY: box.scaleY,
	};
}

function cropCanvasDisplayPoint(node, event) {
	const panel = node.__gjjRegionCropPanel;
	const canvas = panel?.canvas;
	const bounds = canvas?.getBoundingClientRect?.();
	const rect = getCropPanelCanvasRect(node);
	if (!bounds || !rect) return null;
	const offsetX = Number(event?.offsetX);
	const offsetY = Number(event?.offsetY);
	if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
		const displayW = Math.max(1, Number(canvas?.clientWidth || bounds.width || rect.width));
		const displayH = Math.max(1, Number(canvas?.clientHeight || bounds.height || rect.height));
		return {
			x: clamp(offsetX / displayW * rect.width, 0, rect.width),
			y: clamp(offsetY / displayH * rect.height, 0, rect.height),
		};
	}
	return {
		x: clamp(event.clientX - bounds.left, 0, rect.width),
		y: clamp(event.clientY - bounds.top, 0, rect.height),
	};
}

function cropHandleRects(geo) {
	const half = CROP_HANDLE_SIZE / 2;
	return [
		{ name: "nw", cx: geo.points.nw.x, cy: geo.points.nw.y, left: geo.points.nw.x - half, top: geo.points.nw.y - half },
		{ name: "ne", cx: geo.points.ne.x, cy: geo.points.ne.y, left: geo.points.ne.x - half, top: geo.points.ne.y - half },
		{ name: "sw", cx: geo.points.sw.x, cy: geo.points.sw.y, left: geo.points.sw.x - half, top: geo.points.sw.y - half },
		{ name: "se", cx: geo.points.se.x, cy: geo.points.se.y, left: geo.points.se.x - half, top: geo.points.se.y - half },
	];
}

function cropMoveHandleRect(geo) {
	return { name: "move", cx: geo.center.x, cy: geo.center.y };
}

function cropRotateHandleRect(geo) {
	const angleRad = degToRad(geo.angle || 0);
	const topMid = {
		x: (geo.points.nw.x + geo.points.ne.x) / 2,
		y: (geo.points.nw.y + geo.points.ne.y) / 2,
	};
	return {
		name: "rotate",
		cx: topMid.x + Math.sin(angleRad) * CROP_ROTATE_HANDLE_OFFSET,
		cy: topMid.y - Math.cos(angleRad) * CROP_ROTATE_HANDLE_OFFSET,
	};
}

function getCropHandleAtPoint(node, event) {
	const geo = cropDisplayGeometry(node);
	const point = cropCanvasDisplayPoint(node, event);
	if (!geo || !point) return "";
	const rotate = cropRotateHandleRect(geo);
	if (Math.hypot(point.x - rotate.cx, point.y - rotate.cy) <= CROP_ROTATE_HIT_RADIUS) return "rotate";
	const move = cropMoveHandleRect(geo);
	if (Math.hypot(point.x - move.cx, point.y - move.cy) <= CROP_MOVE_HIT_RADIUS) return "move";
	for (const handle of cropHandleRects(geo)) {
		if (Math.hypot(point.x - handle.cx, point.y - handle.cy) <= CROP_HANDLE_HIT_RADIUS) {
			return handle.name;
		}
	}
	return "";
}

function handleAnchorBox(anchor, mode, end) {
	if (!anchor || mode === "new") return null;
	const left = anchor.x;
	const top = anchor.y;
	const right = anchor.x + anchor.width;
	const bottom = anchor.y + anchor.height;
	if (mode === "nw") return { x1: end.x, y1: end.y, x2: right, y2: bottom };
	if (mode === "ne") return { x1: left, y1: end.y, x2: end.x, y2: bottom };
	if (mode === "sw") return { x1: end.x, y1: top, x2: right, y2: end.y };
	if (mode === "se") return { x1: left, y1: top, x2: end.x, y2: end.y };
	return null;
}

function commitCropDrag(node, start, end, mode = "new", anchor = null) {
	const panel = node.__gjjRegionCropPanel;
	if (!panel || !start || !end) return;
	const sourceW = Math.max(1, panel.sourceWidth || 1);
	const sourceH = Math.max(1, panel.sourceHeight || 1);
	let x1 = Math.min(start.x, end.x);
	let y1 = Math.min(start.y, end.y);
	let x2 = Math.max(start.x, end.x);
	let y2 = Math.max(start.y, end.y);
	if (mode === "move" && anchor) {
		const dx = Math.round(end.x - start.x);
		const dy = Math.round(end.y - start.y);
		const nextX = clamp(anchor.x + dx, 0, Math.max(0, sourceW - anchor.width));
		const nextY = clamp(anchor.y + dy, 0, Math.max(0, sourceH - anchor.height));
		writeCropConfig(node, { ...anchor, x: nextX, y: nextY, canvas_width: sourceW, canvas_height: sourceH });
		renderCropPanel(node);
		refreshNode(node);
		return;
	}
	if (mode === "rotate" && anchor) {
		const cx = anchor.x + anchor.width / 2;
		const cy = anchor.y + anchor.height / 2;
		const baseAngle = Math.atan2(start.y - cy, start.x - cx);
		const currentAngle = Math.atan2(end.y - cy, end.x - cx);
		const angle = normalizeAngle((anchor.angle || 0) + radToDeg(currentAngle - baseAngle));
		writeCropConfig(node, { ...anchor, angle, canvas_width: sourceW, canvas_height: sourceH });
		renderCropPanel(node);
		refreshNode(node);
		return;
	}
	const handleBox = handleAnchorBox(anchor, mode, end);
	if (handleBox) {
		({ x1, y1, x2, y2 } = handleBox);
	}
	if (x1 > x2) [x1, x2] = [x2, x1];
	if (y1 > y2) [y1, y2] = [y2, y1];
	x1 = clamp(Math.round(x1), 0, sourceW - 1);
	y1 = clamp(Math.round(y1), 0, sourceH - 1);
	x2 = clamp(Math.round(x2), x1 + 1, sourceW);
	y2 = clamp(Math.round(y2), y1 + 1, sourceH);
	writeCropConfig(node, { x: x1, y: y1, width: x2 - x1, height: y2 - y1, angle: anchor?.angle || 0, canvas_width: sourceW, canvas_height: sourceH });
	renderCropPanel(node);
	refreshNode(node);
}

async function tryLoadCropSourceFromLink(node, force = false) {
	const descriptor = getCropSourceDescriptor(node);
	const panel = node.__gjjRegionCropPanel;
	if (!panel) return;
	if (!descriptor) {
		const fileDescriptor = getCropFileDescriptor(node);
		if (!fileDescriptor) {
			if (panel.image || panel.sourceSignature) clearCropPanelImage(node);
			return;
		}
		if (!force && panel.sourceSignature === fileDescriptor.signature && panel.image) return;
		if (panel.sizeLine) panel.sizeLine.textContent = "正在打开图片文件...";
		clearCropPreview(node);
		setCropPanelImage(node, fileDescriptor.src, 0, 0, fileDescriptor.signature);
		return;
	}
	if (!force && panel.sourceSignature === descriptor.signature && panel.image) return;
	if (panel.sizeLine) panel.sizeLine.textContent = "上游图片已变化，正在刷新...";
	clearCropPreview(node);
	const src = `/api/view?filename=${encodeURIComponent(descriptor.filename)}&type=${encodeURIComponent(descriptor.viewType)}&rand=${Date.now()}`;
	setCropPanelImage(node, src, 0, 0, descriptor.signature);
}

function makeCropButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"width:28px",
		"height:24px",
		"border:1px solid rgba(255,255,255,0.18)",
		"border-radius:6px",
		"background:#172429",
		"color:#d7eef0",
		"font:13px Arial, sans-serif",
		"cursor:pointer",
		"padding:0",
	].join(";");
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(button);
	});
	return button;
}

async function openCropImageFile(node, button) {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff";
	input.style.display = "none";
	document.body.appendChild(input);
	input.addEventListener("change", async () => {
		const file = input.files?.[0];
		input.remove();
		if (!file) return;
		const oldText = button?.textContent || "📁";
		try {
			if (button) {
				button.disabled = true;
				button.textContent = "...";
			}
			const uploaded = await uploadCropImageFile(file);
			setWidgetValue(node, CROP_IMAGE_FILE_WIDGET, uploaded);
			clearCropNativePreview(node);
			setTimeout(() => clearCropNativePreview(node), 0);
			setTimeout(() => tryLoadCropSourceFromLink(node, true), 0);
		} catch (error) {
			console.error("[GJJ RegionCrop] 打开图片失败：", error);
			alert(`打开图片失败：${error?.message || error}`);
		} finally {
			if (button) {
				button.disabled = false;
				button.textContent = oldText;
			}
			updateCropLinkButton(node);
		}
	}, { once: true });
	input.click();
}

function currentCropExternalLinks(node) {
	const links = [];
	for (const name of [CROP_IMAGE_INPUT, CROP_REGION_INPUT]) {
		const slot = node.inputs?.findIndex?.((input) => input.name === name) ?? -1;
		const input = slot >= 0 ? node.inputs[slot] : null;
		const linkId = input?.link;
		const graphLinks = app.graph?.links || node.graph?.links;
		let link = linkId != null
			? (typeof graphLinks?.get === "function" ? graphLinks.get(linkId) : graphLinks?.[linkId])
			: null;
		if (!link && linkId != null && graphLinks && typeof graphLinks === "object") {
			link = Object.values(graphLinks).find((item) => String(item?.id ?? item?.[0] ?? "") === String(linkId));
		}
		const originId = link?.origin_id ?? link?.[1];
		const originSlot = link?.origin_slot ?? link?.[2] ?? 0;
		if (originId != null) {
			links.push({
				inputName: name,
				target_slot: slot,
				origin_id: originId,
				origin_slot: originSlot,
			});
		}
	}
	return links;
}

function toggleCropExternalLinks(node) {
	node.properties ??= {};
	const active = currentCropExternalLinks(node);
	if (active.length) {
		node.properties[CROP_STORED_LINKS_PROPERTY] = active;
		for (const item of active) {
			const slot = node.inputs?.findIndex?.((input) => input.name === item.inputName) ?? -1;
			if (slot >= 0) {
				try { node.disconnectInput?.(slot); } catch (_) {}
			}
		}
		tryLoadCropSourceFromLink(node, true);
		updateCropLinkButton(node);
		refreshNode(node);
		return;
	}
	const stored = Array.isArray(node.properties[CROP_STORED_LINKS_PROPERTY]) ? node.properties[CROP_STORED_LINKS_PROPERTY] : [];
	let restored = 0;
	for (const item of stored) {
		const sourceNode = item?.origin_id != null ? app.graph?.getNodeById?.(item.origin_id) : null;
		const namedSlot = node.inputs?.findIndex?.((input) => input.name === item.inputName) ?? -1;
		const slot = Number.isInteger(item?.target_slot) && node.inputs?.[item.target_slot]
			? item.target_slot
			: namedSlot;
		if (sourceNode && slot >= 0) {
			try {
				sourceNode.connect?.(Number(item.origin_slot || 0), node, slot);
				restored++;
			} catch (_) {}
		}
	}
	if (restored) {
		node.properties[CROP_STORED_LINKS_PROPERTY] = [];
		setTimeout(() => tryLoadCropSourceFromLink(node, true), 0);
	}
	updateCropLinkButton(node);
	refreshNode(node);
}

function updateCropLinkButton(node) {
	const button = node.__gjjRegionCropLinkButton;
	if (!button) return;
	const active = currentCropExternalLinks(node).length;
	const stored = Array.isArray(node.properties?.[CROP_STORED_LINKS_PROPERTY]) && node.properties[CROP_STORED_LINKS_PROPERTY].length;
	button.disabled = false;
	button.style.opacity = !active && !stored ? "0.62" : "1";
	button.style.background = active ? "#1f3b35" : stored ? "#3b321f" : "#172429";
	button.title = active ? "断开并记住当前外部链接；再次点击可恢复。" : stored ? "恢复上次记住的外部链接。" : "没有可断开或恢复的外部链接。";
}

async function openCropSettings(node) {
	node.__gjjRegionCropSettingsModal?.remove?.();
	const savedSettings = await loadCropUserSettings();
	if (savedSettings) {
		setWidgetValue(node, CROP_TOTAL_PIXELS_WIDGET, savedSettings.total_pixels);
		setWidgetValue(node, CROP_ALIGN_MULTIPLE_WIDGET, savedSettings.align_multiple);
	}

	const config = clampCropConfig(node);
	const overlay = document.createElement("div");
	overlay.className = "gjj-region-crop-settings-overlay";
	overlay.style.cssText = [
		"position:fixed",
		"inset:0",
		"z-index:10030",
		"background:rgba(0,0,0,0.34)",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"font:13px Arial, sans-serif",
		"color:#d7eef0",
	].join(";");

	const dialog = document.createElement("div");
	dialog.style.cssText = [
		"width:min(420px,calc(100vw - 32px))",
		"box-sizing:border-box",
		"padding:16px",
		"border:1px solid rgba(255,255,255,0.16)",
		"border-radius:10px",
		"background:#11191d",
		"box-shadow:0 18px 50px rgba(0,0,0,0.45)",
	].join(";");

	const title = document.createElement("div");
	title.textContent = "区域裁切参数";
	title.style.cssText = "font-size:15px;font-weight:700;margin-bottom:12px;color:#ffffff;";

	const body = document.createElement("div");
	body.style.cssText = "display:grid;grid-template-columns:96px 1fr;gap:10px 12px;align-items:center;";

	const makeLabel = (text, hint) => {
		const wrap = document.createElement("label");
		wrap.style.cssText = "color:#bcd0d5;line-height:1.35;";
		wrap.textContent = text;
		if (hint) wrap.title = hint;
		return wrap;
	};
	let updatePreview = () => {};
	const makeSliderControl = (name, value, attrs = {}, formatter = (v) => String(v)) => {
		const wrap = document.createElement("div");
		wrap.style.cssText = "display:grid;grid-template-columns:1fr 74px;gap:8px;align-items:center;";
		const slider = document.createElement("input");
		slider.name = name;
		slider.type = "range";
		slider.value = String(value);
		slider.style.cssText = "width:100%;accent-color:#35e2c2;cursor:pointer;";
		for (const [key, attrValue] of Object.entries(attrs)) slider.setAttribute(key, String(attrValue));
		const valueButton = document.createElement("button");
		valueButton.type = "button";
		valueButton.style.cssText = [
			"height:28px",
			"border:1px solid #52626d",
			"border-radius:7px",
			"background:#0b1113",
			"color:#e8f6f8",
			"cursor:text",
			"font:12px Arial,sans-serif",
		].join(";");
		const min = toNumber(attrs.min, 0);
		const max = toNumber(attrs.max, 1);
		const step = toNumber(attrs.step, 1);
		const decimals = String(attrs.step ?? "").includes(".") ? String(attrs.step).split(".")[1].length : 0;
		const normalize = (raw) => {
			let next = clamp(toNumber(raw, value), min, max);
			if (step > 0) next = Math.round(next / step) * step;
			return decimals > 0 ? Number(next.toFixed(decimals)) : Math.round(next);
		};
		const setValue = (raw) => {
			const next = normalize(raw);
			slider.value = String(next);
			valueButton.textContent = formatter(next);
			updatePreview();
			return next;
		};
		slider.addEventListener("input", () => setValue(slider.value));
		valueButton.addEventListener("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const input = document.createElement("input");
			input.type = "number";
			input.value = slider.value;
			input.min = String(min);
			input.max = String(max);
			input.step = String(step);
			input.style.cssText = valueButton.style.cssText + ";width:74px;box-sizing:border-box;padding:0 6px;";
			valueButton.replaceWith(input);
			const commit = () => {
				setValue(input.value);
				input.replaceWith(valueButton);
			};
			input.addEventListener("keydown", (keyEvent) => {
				if (keyEvent.key === "Enter") commit();
				if (keyEvent.key === "Escape") input.replaceWith(valueButton);
			});
			input.addEventListener("blur", commit, { once: true });
			input.focus();
			input.select?.();
		});
		wrap.append(slider, valueButton);
		setValue(value);
		return { wrap, slider, get value() { return slider.value; } };
	};

	const pixelsInput = makeSliderControl("total_pixels", Math.round(toNumber(getWidget(node, CROP_TOTAL_PIXELS_WIDGET)?.value, 10)), { min: 10, max: 6400, step: 5 }, (v) => `${v}万`);
	const alignInput = makeSliderControl("align_multiple", cropAlignPowerIndex(getWidget(node, CROP_ALIGN_MULTIPLE_WIDGET)?.value ?? 8), { min: 0, max: CROP_ALIGN_POWERS.length - 1, step: 1 }, (v) => `${CROP_ALIGN_POWERS[v]}`);

	body.append(
		makeLabel("总像素(万)", "单位为万像素。30 表示约 30 万像素；最低 10 万，步长 5 万。"),
		pixelsInput.wrap,
		makeLabel("对齐倍数", "输出宽高按 2 的 n 次方对齐：1/2/4/8/16/32/64/128/256。"),
		alignInput.wrap,
	);

	const preview = document.createElement("div");
	preview.style.cssText = "margin-top:12px;padding:9px 10px;border-radius:7px;background:#0b1113;color:#35e2c2;font-weight:700;";
	updatePreview = () => {
		const previous = {
			pixels: getWidget(node, CROP_TOTAL_PIXELS_WIDGET)?.value,
			align: getWidget(node, CROP_ALIGN_MULTIPLE_WIDGET)?.value,
		};
		getWidget(node, CROP_TOTAL_PIXELS_WIDGET).value = Math.max(10, Math.round(toNumber(pixelsInput.value, 10)));
		getWidget(node, CROP_ALIGN_MULTIPLE_WIDGET).value = CROP_ALIGN_POWERS[clamp(Math.round(toNumber(alignInput.value, 3)), 0, CROP_ALIGN_POWERS.length - 1)] || 8;
		const out = outputCropSize(node, config.width, config.height);
		getWidget(node, CROP_TOTAL_PIXELS_WIDGET).value = previous.pixels;
		getWidget(node, CROP_ALIGN_MULTIPLE_WIDGET).value = previous.align;
		preview.textContent = `输出尺寸预览：${config.width} x ${config.height} -> ${out.width} x ${out.height}`;
	};
	const footer = document.createElement("div");
	footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
	const makeDialogButton = (text, primary = false) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = text;
		button.style.cssText = [
			"height:30px",
			"min-width:68px",
			"border-radius:7px",
			`border:1px solid ${primary ? "#35e2c2" : "#52626d"}`,
			`background:${primary ? "#1f6f62" : "#273036"}`,
			"color:#fff",
			"cursor:pointer",
		].join(";");
		return button;
	};
	const ok = makeDialogButton("确定", true);
	const cancel = makeDialogButton("取消");
	footer.append(cancel, ok);

	const close = () => {
		if (node.__gjjRegionCropSettingsModal === overlay) node.__gjjRegionCropSettingsModal = null;
		overlay.remove();
	};
	cancel.addEventListener("click", close);
	ok.addEventListener("click", async () => {
		const totalPixels = Math.max(10, Math.round(toNumber(pixelsInput.value, 10)));
		const alignMultiple = CROP_ALIGN_POWERS[clamp(Math.round(toNumber(alignInput.value, 3)), 0, CROP_ALIGN_POWERS.length - 1)] || 8;
		const saved = await saveCropUserSettings(totalPixels, alignMultiple);
		setWidgetValue(node, CROP_TOTAL_PIXELS_WIDGET, saved?.total_pixels ?? totalPixels);
		setWidgetValue(node, CROP_ALIGN_MULTIPLE_WIDGET, saved?.align_multiple ?? alignMultiple);
		renderCropPanel(node);
		close();
	});
	overlay.addEventListener("pointerdown", (event) => {
		if (event.target === overlay) close();
	});
	dialog.addEventListener("pointerdown", (event) => event.stopPropagation());
	dialog.addEventListener("mousedown", (event) => event.stopPropagation());
	dialog.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	dialog.append(title, body, preview, footer);
	overlay.append(dialog);
	document.body.append(overlay);
	node.__gjjRegionCropSettingsModal = overlay;
	updatePreview();
	pixelsInput.slider.focus();
	pixelsInput.slider.select?.();
}

function startCropSourceWatcher(node) {
	const panel = node.__gjjRegionCropPanel;
	if (!panel || panel.sourceWatcher) return;
	panel.sourceWatcher = window.setInterval(() => {
		const currentPanel = node.__gjjRegionCropPanel;
		if (!currentPanel?.root?.isConnected) {
			window.clearInterval(panel.sourceWatcher);
			panel.sourceWatcher = null;
			return;
		}
		tryLoadCropSourceFromLink(node);
	}, CROP_SOURCE_WATCH_MS);
}

function mountCropPanel(node) {
	if (node.__gjjRegionCropPanel || typeof node.addDOMWidget !== "function") return;
	ensureCropHiddenWidgets(node);
	const root = document.createElement("div");
	root.className = "gjj-region-crop-panel";
	root.style.cssText = [
		"box-sizing:border-box",
		"padding:8px 8px 10px",
		"background:#10181b",
		"border:1px solid rgba(255,255,255,0.12)",
		"border-radius:8px",
		"color:#d7eef0",
		"font:12px Arial, sans-serif",
		"user-select:none",
	].join(";");
	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-bottom:6px;";
	const openButton = makeCropButton("📁", "打开图片文件；会上传到 ComfyUI/input，并在没有外部图像输入时使用。", (button) => openCropImageFile(node, button));
	const settingsButton = makeCropButton("⚙️", "参数设置：总像素、对齐倍数。", () => openCropSettings(node));
	const linkButton = makeCropButton("🔗", "断开/恢复外部链接。", () => toggleCropExternalLinks(node));
	const portsButton = makeCropButton("🔌", "显示/隐藏区域数据输入和裁剪遮罩输出。", () => toggleCropExtraPorts(node));
	node.__gjjRegionCropLinkButton = linkButton;
	node.__gjjRegionCropPortsButton = portsButton;
	toolbar.append(openButton, settingsButton, portsButton, linkButton);
	const canvas = document.createElement("canvas");
	canvas.style.cssText = "display:block;width:100%;height:132px;border-radius:6px;background:#0b1113;cursor:crosshair;";
	const sizeLine = document.createElement("div");
	sizeLine.style.cssText = "height:18px;line-height:18px;margin-top:6px;text-align:center;color:#35e2c2;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	sizeLine.textContent = "裁剪后宽高 -- x --";
	root.append(toolbar, canvas, sizeLine);
	const widget = node.addDOMWidget(CROP_PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	node.__gjjRegionCropPanel = { root, canvas, sizeLine, widget, image: null, src: "", sourceSignature: "", sourceWidth: 0, sourceHeight: 0, dragging: false, dragMode: "new", dragAnchor: null, start: null };

	canvas.addEventListener("pointerdown", (event) => {
		const panel = node.__gjjRegionCropPanel;
		if (!panel?.image || hasInputLink(node, CROP_REGION_INPUT)) return;
		const point = cropCanvasPoint(node, event);
		if (!point) return;
		event.preventDefault();
		event.stopPropagation();
		panel.dragging = true;
		panel.dragMode = getCropHandleAtPoint(node, event) || "new";
		panel.dragAnchor = clampCropConfig(node);
		panel.start = point;
		canvas.setPointerCapture?.(event.pointerId);
	});
	canvas.addEventListener("pointermove", (event) => {
		const panel = node.__gjjRegionCropPanel;
		if (!panel?.dragging && panel?.image && !hasInputLink(node, CROP_REGION_INPUT)) {
			const handle = getCropHandleAtPoint(node, event);
			canvas.style.cursor = handle === "move" ? "move" : handle === "rotate" ? "grab" : handle === "nw" || handle === "se" ? "nwse-resize" : handle === "ne" || handle === "sw" ? "nesw-resize" : "crosshair";
		}
		if (!panel?.dragging || !panel.start) return;
		canvas.style.cursor = panel.dragMode === "move" ? "move" : panel.dragMode === "rotate" ? "grabbing" : canvas.style.cursor;
		const point = cropCanvasPoint(node, event);
		if (!point) return;
		commitCropDrag(node, panel.start, point, panel.dragMode || "new", panel.dragAnchor);
	});
	canvas.addEventListener("pointerup", (event) => {
		const panel = node.__gjjRegionCropPanel;
		if (!panel?.dragging) return;
		const point = cropCanvasPoint(node, event);
		if (point) commitCropDrag(node, panel.start, point, panel.dragMode || "new", panel.dragAnchor);
		panel.dragging = false;
		panel.dragMode = "new";
		panel.dragAnchor = null;
		panel.start = null;
		canvas.releasePointerCapture?.(event.pointerId);
	});
	canvas.addEventListener("pointerleave", (event) => {
		const panel = node.__gjjRegionCropPanel;
		if (!panel?.dragging) canvas.style.cursor = "crosshair";
		if (!panel?.dragging) return;
		panel.dragging = false;
		panel.dragMode = "new";
		panel.dragAnchor = null;
		panel.start = null;
		canvas.releasePointerCapture?.(event.pointerId);
	});

	resizeCropPanel(node);
	applyCropPorts(node);
	updateCropLinkButton(node);
	updateCropPortsButton(node);
	startCropSourceWatcher(node);
	setTimeout(() => tryLoadCropSourceFromLink(node), 0);
}

function drawCropPreview(node, ctx) {
	return;
	const state = node.__gjjRegionCropPreview;
	const geometry = getCropPreviewGeometry(node);
	if (!state?.image || !geometry) return;

	const { x, y, areaW, imageH, sourceW, sourceH } = geometry;
	const scaleX = areaW / sourceW;
	const scaleY = imageH / sourceH;
	const cropX = x + clamp(state.cropX, 0, sourceW) * scaleX;
	const cropY = y + clamp(state.cropY, 0, sourceH) * scaleY;
	const cropW = clamp(state.cropWidth, 0, sourceW - clamp(state.cropX, 0, sourceW)) * scaleX;
	const cropH = clamp(state.cropHeight, 0, sourceH - clamp(state.cropY, 0, sourceH)) * scaleY;
	const labelY = y + imageH + 15;

	ctx.save();
	ctx.fillStyle = "rgba(0,0,0,0.22)";
	ctx.fillRect(x - 1, y - 1, areaW + 2, imageH + CROP_PREVIEW_LABEL_H + 2);

	ctx.drawImage(state.image, x, y, areaW, imageH);

	ctx.fillStyle = "rgba(0,0,0,0.42)";
	ctx.fillRect(x, y, areaW, Math.max(0, cropY - y));
	ctx.fillRect(x, cropY + cropH, areaW, Math.max(0, y + imageH - (cropY + cropH)));
	ctx.fillRect(x, cropY, Math.max(0, cropX - x), cropH);
	ctx.fillRect(cropX + cropW, cropY, Math.max(0, x + areaW - (cropX + cropW)), cropH);

	ctx.strokeStyle = "#35e2c2";
	ctx.lineWidth = 2;
	ctx.strokeRect(cropX + 0.5, cropY + 0.5, Math.max(1, cropW), Math.max(1, cropH));
	ctx.strokeStyle = "rgba(255,255,255,0.65)";
	ctx.lineWidth = 1;
	ctx.strokeRect(x + 0.5, y + 0.5, areaW - 1, imageH - 1);

	ctx.font = "11px Arial";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = "#d7eef0";
	ctx.fillText(`裁切 ${Math.round(state.cropX)}, ${Math.round(state.cropY)}  ${Math.round(state.cropWidth)} x ${Math.round(state.cropHeight)}`, x + areaW / 2, labelY);
	ctx.restore();
}

// ─── GJJ_RegionComposite base_image → canvas size sync ────────────

async function loadImageDimensionsFromSourceNode(sourceNode) {
	if (!sourceNode) return null;
	const imageWidget = getWidget(sourceNode, "image");
	const filename = String(imageWidget?.value || "").trim();
	if (!filename) return null;

	let viewType = null;
	if (sourceNode.comfyClass === "LoadImage") {
		viewType = "input";
	} else if (sourceNode.comfyClass === "LoadImageOutput") {
		viewType = "output";
	} else {
		return null;
	}

	const url = `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(viewType)}&rand=${Date.now()}`;
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

async function trySyncCanvasSize(node) {
	const input = node.inputs?.find?.((i) => i.name === COMPOSITE_IMAGE_INPUT);
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) return;

	const link = app.graph.links[linkId];
	if (!link) return;
	const sourceNode = link.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	if (!sourceNode) return;

	const size = await loadImageDimensionsFromSourceNode(sourceNode);
	if (!size) return;

	const cw = getWidget(node, CANVAS_W_WIDGET);
	const ch = getWidget(node, CANVAS_H_WIDGET);

	// 仅当 widget 当前值为 0（自动）时才更新
	if (cw && (cw.value == null || cw.value === 0)) {
		cw.value = size.width;
	}
	if (ch && (ch.value == null || ch.value === 0)) {
		ch.value = size.height;
	}
	refreshNode(node);
}

// ─── Extension ─────────────────────────────────────────────────────

app.registerExtension({
	name: "GJJ.RegionLayerTools",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		// ── GJJ_RegionBox ──────────────────────────────────────
		if (nodeData?.name === TARGET_BOX) {
			const originalOnExecuted = nodeType.prototype.onExecuted;
			nodeType.prototype.onExecuted = function (message) {
				const result = originalOnExecuted?.apply(this, arguments);
				syncRegionBoxImageSize(this, message);
				return result;
			};

			const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
			nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, linkInfo) {
				const result = originalOnConnectionsChange?.apply(this, arguments);
				// 图片连接变化时清除签名，下次执行时会按新图片尺寸同步
				if (slotType === 0) {
					const input = this.inputs?.[slotIndex];
					if (input?.name === BOX_IMAGE_INPUT) {
						if (this.properties) {
							this.properties.__gjjRegionBoxImageSig = null;
						}
					}
				}
				return result;
			};
		}

		// ── GJJ_RegionCrop ─────────────────────────────────────
		if (nodeData?.name === TARGET_CROP) {
			const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function () {
				const result = originalOnNodeCreated?.apply(this, arguments);
				clearCropNativePreview(this);
				mountCropPanel(this);
				applyCropPorts(this);
				return result;
			};

			const originalOnConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function () {
				const result = originalOnConfigure?.apply(this, arguments);
				clearCropNativePreview(this);
				mountCropPanel(this);
				ensureCropHiddenWidgets(this);
				applyCropPorts(this);
				const saved = this.properties?.__gjjRegionCropConfig;
				if (saved && getWidget(this, CROP_CONFIG_WIDGET) && !getWidget(this, CROP_CONFIG_WIDGET).value) {
					writeCropConfig(this, saved);
				}
				setTimeout(() => {
					resizeCropPanel(this);
					tryLoadCropSourceFromLink(this);
				}, 0);
				return result;
			};

			const originalComputeSize = nodeType.prototype.computeSize;
			nodeType.prototype.computeSize = function () {
				const size = originalComputeSize
					? originalComputeSize.apply(this, arguments)
					: [this.size?.[0] || 300, this.size?.[1] || 160];
				return [size[0], size[1] + getCropPreviewExtraHeight(this)];
			};

			const originalOnResize = nodeType.prototype.onResize;
			nodeType.prototype.onResize = function () {
				const result = originalOnResize?.apply(this, arguments);
				resizeCropPanel(this);
				return result;
			};

			const originalOnExecuted = nodeType.prototype.onExecuted;
			nodeType.prototype.onExecuted = function (message) {
				const result = originalOnExecuted?.apply(this, arguments);
				clearCropNativePreview(this);
				ensureCropHiddenWidgets(this);
				applyCropPorts(this);
				updateCropPreview(this, message);
				updateCropLinkButton(this);
				return result;
			};

			const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
			nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, linkInfo) {
				const result = originalOnConnectionsChange?.apply(this, arguments);
				if (slotType === 0) {
					const input = this.inputs?.[slotIndex];
					if (input?.name === CROP_IMAGE_INPUT || input?.name === CROP_REGION_INPUT) {
						clearCropPreview(this);
						if (input?.name === CROP_IMAGE_INPUT && connected) {
							setTimeout(() => tryLoadCropSourceFromLink(this), 0);
						}
						if (input?.name === CROP_IMAGE_INPUT && !connected) {
							setTimeout(() => tryLoadCropSourceFromLink(this, true), 0);
						}
						if (input?.name === CROP_REGION_INPUT) {
							renderCropPanel(this);
						}
						updateCropLinkButton(this);
					}
				}
				if (slotType === 1 || slotType === 0) {
					applyCropPorts(this);
				}
				return result;
			};

			const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
			nodeType.prototype.onDrawBackground = function (ctx) {
				clearCropNativePreview(this);
				originalOnDrawBackground?.apply(this, arguments);
				clearCropNativePreview(this);
				drawCropPreview(this, ctx);
			};
		}

		// ── GJJ_RegionComposite ─────────────────────────────────
		if (nodeData?.name !== TARGET_COMPOSITE) return;

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, linkInfo) {
			const result = originalOnConnectionsChange?.apply(this, arguments);
			// 输入口变化时尝试同步画布尺寸
			if (slotType === 0) {
				const input = this.inputs?.[slotIndex];
				if (input?.name === COMPOSITE_IMAGE_INPUT && connected) {
					setTimeout(() => trySyncCanvasSize(this), 0);
				}
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			const width = getFirstValue(message?.canvas_width);
			const height = getFirstValue(message?.canvas_height);
			if (width != null && height != null && Number.isFinite(Number(width)) && Number.isFinite(Number(height))) {
				const cw = getWidget(this, CANVAS_W_WIDGET);
				const ch = getWidget(this, CANVAS_H_WIDGET);
				if (cw) cw.value = Number(width);
				if (ch) ch.value = Number(height);
				refreshNode(this);
			}
			return result;
		};
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
	getCachedModelFamilyPresets,
	getModelFamilyPresets,
} from "./gjj_model_family_preset_table.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_LazyImageStudio"]);
const IMAGE_PREFIX = "image_";
const PRIMARY_IMAGE_INPUT = "image_01";
const BATCH_SOURCE_WIDGET = "batch_source_images";
const MAIN_MASK_INPUT = "mask";
const LAST_PRESET_KEY = "gjj_lazy_last_preset_unet";
const MIN_VISIBLE_IMAGES = 1;
const MAX_IMAGES = Number.POSITIVE_INFINITY;
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const IMAGE_TOOLTIP = "参考图片输入；有连接时会自动补出下一个图片插槽。";
const PRIMARY_IMAGE_TOOLTIP = "可直接接入 GJJ · 多图片加载预览器 的批量图片输出；后端会按原图顺序恢复多图参考。";
const MASK_TOOLTIP = "主图可选遮罩；存在时会走带 noise_mask 的局部编辑逻辑。";

const EXECUTE_BUTTON_NAME = "__gjj_execute_button";
const IMAGE_PREVIEW_NAME = "__gjj_image_preview";
const LORA_CHAIN_CONFIG_INPUT = "lora_chain_config";
const LORA_DATA_WIDGET_NAME = "lora_data";

const DEFAULT_EMPTY_OPTION = { value: "", label: "未选择" };
const DEFAULT_ROW = { enabled: true, name: "", strength: 1.0 };
const DEFAULT_FIRST_SEARCH_TERMS = "";
const PANEL_SYNC_WIDGETS = [
	"prompt",
	"negative_prompt",
	"main_image_index",
	"width",
	"height",
	"batch_size",
	"unet_name",
	"unet_dtype",
	"clip_name1",
	"vae_name",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"grow_mask_by",
];

let MODEL_PRESETS = getCachedModelFamilyPresets();

function normalizeText(value) {
	return String(value || "").trim().toLowerCase();
}

function canonicalizeText(value) {
	return normalizeText(value).replace(/[\\/_\-.|\s]+/g, "");
}

async function ensureModelPresetsLoaded() {
	if (MODEL_PRESETS.length) {
		return MODEL_PRESETS;
	}
	MODEL_PRESETS = await getModelFamilyPresets();
	return MODEL_PRESETS;
}

function getWidget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function getInput(node, name) {
	return GJJ_Utils.getInput(node, name);
}

function setWidgetValue(widget, value) {
	if (!widget || value === undefined || value === null) {
		return;
	}
	widget.value = value;
	if (widget.inputEl) {
		widget.inputEl.value = String(value);
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = value;
	}
	widget.callback?.(value);
}

function setWidgetEnabled(widget, enabled) {
	if (!widget) {
		return;
	}
	widget.disabled = !enabled;
	if (widget.options) {
		widget.options.disabled = !enabled;
	}
	const opacity = enabled ? "1" : "0.45";
	if (widget.inputEl) {
		widget.inputEl.disabled = !enabled;
		widget.inputEl.style.opacity = opacity;
	}
	if (widget.element && "disabled" in widget.element) {
		widget.element.disabled = !enabled;
		widget.element.style.opacity = opacity;
	}
}

function preferredValue(values, desired) {
	const list = Array.isArray(values) ? values.map((item) => String(item ?? "")) : [];
	const wanted = String(desired || "").trim();
	if (!wanted) {
		return list[0] || "";
	}
	if (list.includes(wanted)) {
		return wanted;
	}
	const wantedBase = wanted.split(/[\\/]/).pop() || wanted;
	const wantedCanonical = canonicalizeText(wantedBase);
	let best = "";
	let bestScore = -1;
	for (const candidate of list) {
		const candidateBase = candidate.split(/[\\/]/).pop() || candidate;
		const candidateCanonical = canonicalizeText(candidateBase);
		const fullCanonical = canonicalizeText(candidate);
		let score = -1;
		if (candidate === wanted || candidateBase === wantedBase) {
			score = 1000;
		} else if (candidateCanonical === wantedCanonical || fullCanonical === wantedCanonical) {
			score = 900;
		} else if (wantedCanonical && (candidateCanonical.includes(wantedCanonical) || fullCanonical.includes(wantedCanonical))) {
			score = 700 - Math.max(0, candidateCanonical.length - wantedCanonical.length);
		}
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best || list[0] || wanted;
}

function getImageInputs(node) {
	return (node.inputs || [])
		.filter((input) => String(input?.name || "").startsWith(IMAGE_PREFIX))
		.sort((a, b) => {
			const ai = Number.parseInt(String(a?.name || "").slice(IMAGE_PREFIX.length), 10) || 9999;
			const bi = Number.parseInt(String(b?.name || "").slice(IMAGE_PREFIX.length), 10) || 9999;
			return ai - bi;
		});
}

function addImageInput(node) {
	const nextIndex = getImageInputs(node).length + 1;
	const name = `${IMAGE_PREFIX}${String(nextIndex).padStart(2, "0")}`;
	const type = nextIndex === 1 ? BATCH_IMAGE_TYPE : "IMAGE";
	node.addInput?.(name, type);
}

function hasLinked(input) {
	return Boolean(input?.link);
}

function trimUnusedImageInputs(node) {
	const inputs = getImageInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_IMAGES; index -= 1) {
		const input = inputs[index];
		if (hasLinked(input)) {
			break;
		}
		const slot = node.inputs?.indexOf(input) ?? -1;
		if (slot >= 0) {
			node.removeInput?.(slot);
		}
	}
}

function ensureTrailingImageInput(node) {
	const inputs = getImageInputs(node);
	if (!inputs.length) {
		addImageInput(node);
		return;
	}
	if (inputs.length >= MAX_IMAGES) {
		return;
	}
	if (hasLinked(inputs[inputs.length - 1])) {
		addImageInput(node);
	}
}

function renameImageInputs(node) {
	getImageInputs(node).forEach((input, idx) => {
		const displayIndex = idx + 1;
		input.name = `${IMAGE_PREFIX}${String(displayIndex).padStart(2, "0")}`;
		input.type = displayIndex === 1 ? BATCH_IMAGE_TYPE : "IMAGE";
		input.label = displayIndex === 1 ? "批量图片" : `图片 ${displayIndex - 1}`;
		input.localized_name = input.label;
		input.tooltip = displayIndex === 1 ? PRIMARY_IMAGE_TOOLTIP : IMAGE_TOOLTIP;
	});
	const maskInput = getInput(node, MAIN_MASK_INPUT);
	if (maskInput) {
		maskInput.type = "MASK";
		maskInput.label = "主图遮罩";
		maskInput.localized_name = "主图遮罩";
		maskInput.tooltip = MASK_TOOLTIP;
	}
}

function cleanupRedundantMultiLoaderLinks(node) {
	const primary = getInput(node, PRIMARY_IMAGE_INPUT);
	const primaryLinkId = primary?.link;
	if (!primaryLinkId || !app.graph?.links) {
		return;
	}
	const primaryLink = app.graph.links[primaryLinkId];
	const sourceNode = primaryLink?.origin_id != null ? app.graph.getNodeById?.(primaryLink.origin_id) : null;
	if (sourceNode?.comfyClass !== "GJJ_MultiImageLoader" || Number(primaryLink?.origin_slot) !== 0) {
		return;
	}
	getImageInputs(node).forEach((input, idx) => {
		if (idx === 0 || !input?.link) {
			return;
		}
		const link = app.graph.links[input.link];
		if (!link || link.origin_id !== primaryLink.origin_id) {
			return;
		}
		const inputIndex = node.inputs?.indexOf(input) ?? -1;
		if (inputIndex >= 0) {
			node.disconnectInput?.(inputIndex);
		}
	});
}

function buildMultiLoaderSelectionPayload(sourceNode) {
	const widget = getWidget(sourceNode, "selected_images");
	const raw = String(widget?.value || "[]").trim();
	return raw || "[]";
}

function syncBatchSourceWidget(node) {
	const widget = getWidget(node, BATCH_SOURCE_WIDGET);
	if (!widget) {
		return;
	}
	const primary = getInput(node, PRIMARY_IMAGE_INPUT);
	const linkId = primary?.link;
	if (!linkId || !app.graph?.links) {
		widget.value = "[]";
		return;
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	if (sourceNode?.comfyClass !== "GJJ_MultiImageLoader" || Number(link?.origin_slot) !== 0) {
		widget.value = "[]";
		return;
	}
	widget.value = buildMultiLoaderSelectionPayload(sourceNode);
}

function loadImageDimensions(url) {
	return new Promise((resolve) => {
		if (!url) {
			resolve(null);
			return;
		}
		const image = new Image();
		image.onload = () => resolve({
			width: Number(image.naturalWidth || 0),
			height: Number(image.naturalHeight || 0),
		});
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

function roundToEight(value) {
	return Math.max(8, Math.round(Number(value || 0) / 8) * 8);
}

function getLinkedWidgetInput(node, widgetName) {
	return (node.inputs || []).find((input) => (
		input?.link != null &&
		(String(input?.widget?.name || "") === widgetName || String(input?.name || "") === widgetName)
	)) || null;
}

function readResizeNodeConfig(sourceNode) {
	const cfg = sourceNode?.properties?.gjj_mf_resize_config;
	if (cfg && typeof cfg === "object") {
		return cfg;
	}
	const widget = getWidget(sourceNode, "config_json");
	try {
		const parsed = JSON.parse(String(widget?.value || "{}"));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function inferExternalOutputValue(link, targetWidgetName = "") {
	if (!link || !app.graph) {
		return undefined;
	}
	const sourceNode = link.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const output = sourceNode?.outputs?.[Number(link.origin_slot || 0)];
	const outputName = String(output?.name || output?.label || "").trim();
	if (!sourceNode || !outputName) {
		return undefined;
	}
	if (sourceNode.comfyClass === "GJJ_ImageResizeKJv2") {
		const cfg = readResizeNodeConfig(sourceNode);
		if (cfg) {
			const slotKey = Array.isArray(cfg.extra_outputs)
				? cfg.extra_outputs[Number(link.origin_slot || 0) - 2]
				: "";
			if (targetWidgetName === "width") return Number(cfg.width || 0) || undefined;
			if (targetWidgetName === "height") return Number(cfg.height || 0) || undefined;
			if (slotKey === "output_width" || outputName.includes("宽度")) return Number(cfg.width || 0) || undefined;
			if (slotKey === "output_height" || outputName.includes("高度")) return Number(cfg.height || 0) || undefined;
		}
	}
	const candidateWidgetNames = [
		outputName,
		"value",
		"int",
		"float",
		"number",
		"text",
		"string",
		"seed",
	];
	for (const name of candidateWidgetNames) {
		const widget = getWidget(sourceNode, name);
		if (widget?.value !== undefined && widget?.value !== null && String(widget.value) !== "") {
			return widget.value;
		}
	}
	return sourceNode.__gjjLastOutputValues?.[Number(link.origin_slot || 0)];
}

function externalPanelSignature(node) {
	const parts = [];
	for (const widgetName of PANEL_SYNC_WIDGETS) {
		const input = getLinkedWidgetInput(node, widgetName);
		if (!input?.link || !app.graph?.links) {
			continue;
		}
		const link = app.graph.links[input.link];
		const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
		const resizeCfg = sourceNode?.comfyClass === "GJJ_ImageResizeKJv2" ? readResizeNodeConfig(sourceNode) : null;
		const widgetValues = (sourceNode?.widgets || []).map((widget) => [widget?.name, widget?.value]);
		parts.push([widgetName, link?.origin_id, link?.origin_slot, resizeCfg, widgetValues]);
	}
	return JSON.stringify(parts);
}

function applyEffectiveParamsToPanel(node, params, onlyLinked = false) {
	if (!params || typeof params !== "object") {
		return;
	}
	for (const widgetName of PANEL_SYNC_WIDGETS) {
		if (onlyLinked && !getLinkedWidgetInput(node, widgetName)) {
			continue;
		}
		if (!Object.prototype.hasOwnProperty.call(params, widgetName)) {
			continue;
		}
		setWidgetValue(getWidget(node, widgetName), params[widgetName]);
	}
}

function syncPanelFromLinkedSources(node) {
	const values = {};
	for (const widgetName of PANEL_SYNC_WIDGETS) {
		const input = getLinkedWidgetInput(node, widgetName);
		if (!input?.link || !app.graph?.links) {
			continue;
		}
		const value = inferExternalOutputValue(app.graph.links[input.link], widgetName);
		if (value !== undefined && value !== null && String(value) !== "") {
			values[widgetName] = value;
		}
	}
	applyEffectiveParamsToPanel(node, values, true);
}

async function largestMultiImageLoaderSize(sourceNode) {
	const widget = getWidget(sourceNode, "selected_images");
	let items = [];
	try {
		items = JSON.parse(String(widget?.value || "[]"));
	} catch {
		items = [];
	}
	items = Array.isArray(items) ? items : [];
	if (!items.length) {
		return null;
	}
	const sizes = await Promise.all(items.map((item) => {
		const filename = String(item?.filename || "").trim();
		const type = String(item?.type || "input").trim() || "input";
		const subfolder = String(item?.subfolder || "").trim();
		const url = `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`;
		return loadImageDimensions(url);
	}));
	let best = null;
	let area = -1;
	for (const size of sizes) {
		if (!size) {
			continue;
		}
		const nextArea = Number(size.width || 0) * Number(size.height || 0);
		if (!best || nextArea > area) {
			best = size;
			area = nextArea;
		}
	}
	return best;
}

async function syncSizeFromPrimaryInput(node) {
	if (getLinkedWidgetInput(node, "width") || getLinkedWidgetInput(node, "height")) {
		return;
	}
	const primary = getInput(node, PRIMARY_IMAGE_INPUT);
	const linkId = primary?.link;
	if (!linkId || !app.graph?.links) {
		return;
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	if (!sourceNode) {
		return;
	}
	let size = null;
	if (sourceNode.comfyClass === "GJJ_MultiImageLoader") {
		size = await largestMultiImageLoaderSize(sourceNode);
	} else if (["LoadImage", "LoadImageOutput"].includes(sourceNode.comfyClass)) {
		const imageWidget = getWidget(sourceNode, "image");
		const filename = String(imageWidget?.value || "").trim();
		const type = sourceNode.comfyClass === "LoadImage" ? "input" : "output";
		if (filename) {
			size = await loadImageDimensions(
				`/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=&rand=${Date.now()}`
			);
		}
	}
	if (!size) {
		return;
	}
	setWidgetValue(getWidget(node, "width"), roundToEight(size.width));
	setWidgetValue(getWidget(node, "height"), roundToEight(size.height));
}

function createButtons(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:row",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	// 刷新Lora按钮
	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.innerHTML = "🔄 刷新LoRA";
	refreshButton.title = "刷新LoRA选项列表";
	refreshButton.style.cssText = [
		"height:32px",
		"padding:0 12px",
		"border:1px solid #3b82f6",
		"border-radius:6px",
		"background:linear-gradient(135deg, #1e3a5f, #1e40af)",
		"color:#e0e7ff",
		"font-size:12px",
		"font-weight:500",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"flex:1",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1001",
		"pointer-events:auto",
		"user-select:none",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"gap:4px",
	].join(";");

	// 生成图片按钮
	const generateButton = document.createElement("button");
	generateButton.type = "button";
	generateButton.innerHTML = "✨ 生成图片";
	generateButton.title = "只执行当前节点，无需连接其他节点";
	generateButton.style.cssText = [
		"height:32px",
		"padding:0 12px",
		"border:1px solid #10b981",
		"border-radius:6px",
		"background:linear-gradient(135deg, #064e3b, #059669)",
		"color:#a7f3d0",
		"font-size:12px",
		"font-weight:500",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"flex:1",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1001",
		"pointer-events:auto",
		"user-select:none",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"gap:4px",
	].join(";");

	// 按钮悬停效果函数
	function setupButtonHover(btn, defaultBg, hoverBg) {
		btn.addEventListener("mouseenter", () => {
			btn.style.background = hoverBg;
			btn.style.transform = "translateY(-1px)";
		});

		btn.addEventListener("mouseleave", () => {
			btn.style.background = defaultBg;
			btn.style.transform = "translateY(0)";
		});

		btn.addEventListener("mousedown", () => {
			btn.style.transform = "translateY(0) scale(0.98)";
		});

		btn.addEventListener("mouseup", () => {
			btn.style.transform = "translateY(-1px)";
		});
	}

	function protectEvent(event) {
		event.preventDefault();
		event.stopPropagation();
	}

	function setupButtonEvents(btn, handler) {
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			btn.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}
		btn.addEventListener("pointerup", handler, true);
		btn.addEventListener("click", handler, true);
	}

	// 刷新LoRA按钮
	async function handleRefresh(event) {
		protectEvent(event);
		console.log("[GJJ] 刷新Lora按钮被点击", node?.id, node?.comfyClass);

		const originalText = refreshButton.innerHTML;
		refreshButton.innerHTML = "⏳ 刷新中";
		refreshButton.disabled = true;
		refreshButton.style.opacity = "0.7";

		try {
			await refreshLoraOptions(node, true);
			refreshButton.innerHTML = "✅ 已刷新";
			refreshButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
			refreshButton.style.borderColor = "#10b981";
		} catch (error) {
			console.error("[GJJ] 刷新LoRA时发生错误:", error);
			refreshButton.innerHTML = "❌ 失败";
			refreshButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			refreshButton.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				refreshButton.innerHTML = originalText;
				refreshButton.disabled = false;
				refreshButton.style.opacity = "1";
				refreshButton.style.background = "linear-gradient(135deg, #1e3a5f, #1e40af)";
				refreshButton.style.borderColor = "#3b82f6";
			}, 1000);
		}
	}

	// 生成图片按钮
	async function handleGenerate(event) {
		protectEvent(event);
		console.log("[GJJ] 生成图片按钮被点击", node?.id, node?.comfyClass);

		const originalText = generateButton.innerHTML;
		generateButton.innerHTML = "⏳ 执行中";
		generateButton.disabled = true;
		generateButton.style.opacity = "0.7";

		try {
			const ok = await queueOnlyCurrentNode(node);
			if (!ok) {
				console.warn("[GJJ] 当前节点执行失败：queueOnlyCurrentNode 返回 false");
				generateButton.innerHTML = "❌ 执行失败";
				generateButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
				generateButton.style.borderColor = "#ef4444";
			} else {
				generateButton.innerHTML = "✅ 执行中";
				generateButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				generateButton.style.borderColor = "#10b981";
			}
		} catch (error) {
			console.error("[GJJ] 执行当前节点时发生错误:", error);
			generateButton.innerHTML = "❌ 错误";
			generateButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			generateButton.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				generateButton.innerHTML = originalText;
				generateButton.disabled = false;
				generateButton.style.opacity = "1";
				generateButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				generateButton.style.borderColor = "#10b981";
			}, 1500);
		}
	}

	setupButtonHover(refreshButton, "linear-gradient(135deg, #1e3a5f, #1e40af)", "linear-gradient(135deg, #1e40af, #3b82f6)");
	setupButtonHover(generateButton, "linear-gradient(135deg, #064e3b, #059669)", "linear-gradient(135deg, #059669, #10b981)");
	setupButtonEvents(refreshButton, handleRefresh);
	setupButtonEvents(generateButton, handleGenerate);

	container.appendChild(refreshButton);
	container.appendChild(generateButton);
	return container;
}

function createImagePreview(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const image = document.createElement("img");
	// 给自定义预览添加标记，避免被隐藏
	image.dataset.gjjCustomPreview = "true";
	image.style.cssText = [
		"max-width:100%",
		"max-height:400px",
		"object-fit:contain",
		"display:none",
		"cursor:pointer",
		"border-radius:8px",
		"border:1px solid #33434a",
		"background:#0f1418",
		"pointer-events:auto",
		"position:relative",
		"z-index:100",
		"transition:transform 0.2s ease",
	].join(";");

	// 鼠标悬停效果
	image.addEventListener("mouseenter", () => {
		image.style.transform = "scale(1.02)";
	});
	image.addEventListener("mouseleave", () => {
		image.style.transform = "scale(1)";
	});

	// 图片点击放大功能 - 完全参考批量多图片加载器
	image.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();

		const overlay = document.createElement("div");
		overlay.style.cssText = [
			"position:fixed",
			"inset:0",
			"background:rgba(0, 0, 0, 0.9)",
			"backdrop-filter:blur(10px)",
			"z-index:10000",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"cursor:zoom-out",
		].join(";");

		const previewImg = document.createElement("img");
		previewImg.src = image.src;
		previewImg.style.cssText = [
			"max-width:90%",
			"max-height:90%",
			"object-fit:contain",
			"border-radius:8px",
			"box-shadow:0 0 40px rgba(0, 0, 0, 0.5)",
			"transition:transform 0.1s ease",
			"cursor:grab",
		].join(";");

		// 滚轮缩放功能
		let currentScale = 1;
		const minScale = 0.1;
		const maxScale = 10;

		overlay.addEventListener("wheel", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			currentScale = Math.max(minScale, Math.min(maxScale, currentScale + delta));
			previewImg.style.transform = `scale(${currentScale})`;
		});

		// 双击重置缩放
		previewImg.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			currentScale = 1;
			previewImg.style.transform = `scale(${currentScale})`;
		});

		const closeHint = document.createElement("div");
		closeHint.textContent = "滚轮缩放 · 双击重置 · 点击关闭";
		closeHint.style.cssText = [
			"position:absolute",
			"bottom:20px",
			"left:50%",
			"transform:translateX(-50%)",
			"color:#fff",
			"font-size:13px",
			"opacity:0.6",
			"pointer-events:none",
			"white-space:nowrap",
		].join(";");

		overlay.appendChild(previewImg);
		overlay.appendChild(closeHint);
		document.body.appendChild(overlay);

		// 点击关闭
		overlay.addEventListener("click", () => {
			overlay.remove();
		});
	});

	container.appendChild(image);

	node.__gjjPreviewImage = image;
	return container;
}

function imageDataToUrl(item) {
	if (!item?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function updateImagePreview(node, images) {
	if (!node.__gjjPreviewImage) return;

	if (!images || !images.length) {
		node.__gjjPreviewImage.style.display = "none";
		return;
	}

	console.log("[GJJ] 图片预览数据:", images);
	const imageUrl = imageDataToUrl(images[0]);
	console.log("[GJJ] 图片预览 URL:", imageUrl);
	node.__gjjPreviewImage.src = imageUrl;
	// 确保自定义预览图的样式完全正常！
	node.__gjjPreviewImage.style.display = "block";
	node.__gjjPreviewImage.style.visibility = "visible";
	node.__gjjPreviewImage.style.height = "";
	node.__gjjPreviewImage.style.width = "";
	node.__gjjPreviewImage.style.margin = "";
	node.__gjjPreviewImage.style.padding = "";
	node.__gjjPreviewImage.style.opacity = "";
	node.__gjjPreviewImage.style.position = "";
	node.__gjjPreviewImage.style.left = "";

	// 刷新节点尺寸
	GJJ_Utils.refreshNode(node);
}

function matchPreset(unetName) {
	const normalized = normalizeText(unetName);
	const canonical = canonicalizeText(unetName);
	let best = null;
	let bestLength = -1;
	for (const preset of MODEL_PRESETS) {
		for (const keyword of preset.keywords || []) {
			const normalizedKeyword = normalizeText(keyword);
			const canonicalKeyword = canonicalizeText(keyword);
			if (
				(normalized.includes(normalizedKeyword) || (canonicalKeyword && canonical.includes(canonicalKeyword))) &&
				(canonicalKeyword || normalizedKeyword).length > bestLength
			) {
				best = preset;
				bestLength = (canonicalKeyword || normalizedKeyword).length;
			}
		}
	}
	return best;
}

function usesEqualReferenceCanvas(preset, unetName = "") {
	const text = canonicalizeText([
		preset?.id || "",
		...(preset?.keywords || []),
		unetName || "",
	].join("|"));
	return text.includes("qwenimageedit2511") || text.includes("fireredimageedit11");
}

function updateMainImageIndexState(node, preset) {
	const widget = getWidget(node, "main_image_index");
	if (!widget) {
		return;
	}
	const locked = usesEqualReferenceCanvas(preset, getWidget(node, "unet_name")?.value || "");
	setWidgetEnabled(widget, !locked);
	widget.tooltip = locked
		? "当前 Qwen Image Edit 2511 / FireRed Image Edit 1.1 分支使用平等参考；主图序号不参与。"
		: "有多张参考图时，哪一张作为主参考排在最前。";
}

function resolveLoraSuggestedSteps(loraName) {
	const text = String(loraName || "").toLowerCase();
	if (text.includes("flux_2-turbo-lora-comfyui_8steps_v2") || text.includes("flux2turbocomfyv2")) {
		return 8;
	}
	if (text.includes("8step")) {
		return 8;
	}
	if (text.includes("4step")) {
		return 4;
	}
	return null;
}

function isLoraEnabled(name, strength) {
	return Boolean(String(name || "").trim()) && Math.abs(Number(strength || 0)) > 1e-6;
}

function syncStepsFromLoras(node) {
	const stepsWidget = getWidget(node, "steps");
	if (!stepsWidget) {
		return;
	}
	const preset = matchPreset(getWidget(node, "unet_name")?.value || "");
	const loraState = ensureLoraNodeState(node);
	for (const row of loraState.rows) {
		if (row.enabled && row.name) {
			const suggested = resolveLoraSuggestedSteps(row.name);
			if (Number.isFinite(suggested)) {
				setWidgetValue(stepsWidget, suggested);
				return;
			}
		}
	}
	if (preset && Number.isFinite(preset.baseSteps)) {
		setWidgetValue(stepsWidget, preset.baseSteps);
	}
}

function applyPreset(node, force = false) {
	const unetWidget = getWidget(node, "unet_name");
	if (!unetWidget) {
		return;
	}
	node.properties = node.properties || {};
	const currentUnet = String(unetWidget.value || "");
	const preset = matchPreset(currentUnet);
	updateMainImageIndexState(node, preset);
	if (!preset) {
		return;
	}
	if (!force && node.properties[LAST_PRESET_KEY] === currentUnet) {
		return;
	}
	const clipWidget = getWidget(node, "clip_name1");
	const vaeWidget = getWidget(node, "vae_name");
	const clipValues = Array.isArray(clipWidget?.options?.values) ? clipWidget.options.values : [];
	const vaeValues = Array.isArray(vaeWidget?.options?.values) ? vaeWidget.options.values : [];

	setWidgetValue(clipWidget, preferredValue(clipValues, (preset.clipNames || [])[0] || ""));
	setWidgetValue(vaeWidget, preferredValue(vaeValues, preset.vaeName || ""));
	if (Number.isFinite(preset.steps)) {
		setWidgetValue(getWidget(node, "steps"), Number(preset.steps));
	}
	if (Number.isFinite(preset.cfg)) {
		setWidgetValue(getWidget(node, "cfg"), Number(preset.cfg));
	}
	if (preset.sampler) {
		setWidgetValue(getWidget(node, "sampler_name"), preset.sampler);
	}
	if (preset.scheduler) {
		setWidgetValue(getWidget(node, "scheduler"), preset.scheduler);
	}
	if (Number.isFinite(preset.denoise)) {
		setWidgetValue(getWidget(node, "denoise"), Number(preset.denoise));
	}
	if (Number.isFinite(preset.width)) {
		setWidgetValue(getWidget(node, "width"), Number(preset.width));
	}
	if (Number.isFinite(preset.height)) {
		setWidgetValue(getWidget(node, "height"), Number(preset.height));
	}

	// 完全彻底地重置 LoRA 状态，不管有没有预设都清空旧数据
	// 第一步：清除所有持久化数据
	if (node.properties) {
		node.properties[LORA_DATA_WIDGET_NAME] = "[]";
	}

	// 第二步：清除内存中的状态（完全重置）
	if (node.__gjjLoraState) {
		node.__gjjLoraState.rows = []; // 先清空
	}

	// 第三步：判断预设中是否有 LoRA 配置
	const hasPresetLora = (preset.lora1 && String(preset.lora1).trim()) ||
						(preset.lora2 && String(preset.lora2).trim());

	let newLoraRows = [];
	if (hasPresetLora) {
		// 预设中有 LoRA，应用预设
		if (preset.lora1 && String(preset.lora1).trim()) {
			newLoraRows.push({
				enabled: true,
				name: String(preset.lora1),
				strength: normalizeStrength(preset.lora1Strength, 1.0),
			});
		}
		if (preset.lora2 && String(preset.lora2).trim()) {
			newLoraRows.push({
				enabled: true,
				name: String(preset.lora2),
				strength: normalizeStrength(preset.lora2Strength, 0.7),
			});
		}
		// 添加空行用于新增
		newLoraRows.push({ ...DEFAULT_ROW });
	} else {
		// 预设中没有 LoRA，完全清空，只保留一个空行
		newLoraRows = [{ ...DEFAULT_ROW }];
	}

	// 第四步：强制更新内存状态
	if (node.__gjjLoraState) {
		node.__gjjLoraState.rows = newLoraRows;
	} else {
		// 如果还没有状态，创建一个全新的
		node.__gjjLoraState = {
			rows: newLoraRows,
			options: [{ ...DEFAULT_EMPTY_OPTION }],
		};
	}

	// 第五步：强制更新 widget 值和 UI
	updateLoraDataWidget(node);
	renderLoraUi(node);
	syncStepsFromLoras(node);

	node.properties[LAST_PRESET_KEY] = currentUnet;
}

function hookUnetWidget(node) {
	const widget = getWidget(node, "unet_name");
	if (!widget || widget.__gjjLazyHooked) {
		return;
	}
	widget.__gjjLazyHooked = true;
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const result = original?.call(this, value, ...args);

		// 第一步：清除所有持久化数据
		if (node.properties) {
			node.properties[LAST_PRESET_KEY] = "";
			node.properties[LORA_DATA_WIDGET_NAME] = "[]";
		}

		// 第二步：完全重置内存中的 LoRA 状态
		if (node.__gjjLoraState) {
			node.__gjjLoraState.rows = []; // 先清空
			// 然后设置为默认值（只有一个空行）
			node.__gjjLoraState.rows = [{ ...DEFAULT_ROW }];
		}

		// 第三步：应用预设
		applyPreset(node, true);
		GJJ_Utils.refreshNode(node);
		return result;
	};
}

function normalizeStrength(value, fallback = 1.0) {
	const parsed = Number.parseFloat(value);
	if (Number.isNaN(parsed)) {
		return fallback;
	}
	return parsed;
}

function isPartialNumericInput(value) {
	const text = String(value ?? "").trim();
	return text === "" || text === "-" || text === "+" || text === "." || text === "-." || text === "+.";
}

function formatStrength(value, fallback = 1.0) {
	return normalizeStrength(value, fallback).toFixed(2);
}

function normalizeRows(value) {
	let parsed = [];
	try {
		const raw = JSON.parse(String(value || "[]"));
		if (Array.isArray(raw)) {
			parsed = raw;
		}
	} catch (error) {
		parsed = [];
	}

	const rows = parsed
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			enabled: item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
		}));

	const nonEmptyRows = rows.filter((item) => item.name);
	nonEmptyRows.push({ ...DEFAULT_ROW });
	return nonEmptyRows.length > 0 ? nonEmptyRows : [{ ...DEFAULT_ROW }];
}

function serializeRows(rows) {
	const cleaned = rows
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			enabled: item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
		}));
	return JSON.stringify(cleaned);
}

async function fetchLoraOptions() {
	try {
		const response = await fetch("/gjj/loras");
		if (!response.ok) {
			return [DEFAULT_EMPTY_OPTION];
		}

		const data = await response.json();
		const values = Array.isArray(data?.loras) ? data.loras : [];
		const options = [];
		for (const item of values) {
			const value = String(item || "");
			if (!options.some((option) => option.value === value)) {
				options.push({
					value,
					label: value || DEFAULT_EMPTY_OPTION.label,
				});
			}
		}
		if (!options.some((option) => option.value === "")) {
			options.unshift({ ...DEFAULT_EMPTY_OPTION });
		}
		return options;
	} catch (error) {
		return [DEFAULT_EMPTY_OPTION];
	}
}

function hideLoraDataWidget(node, widget) {
	if (!widget) {
		return;
	}
	widget.__gjjNode = node;
	widget.type = "hidden";
	widget.hidden = true;
	widget.serialize = true;
	widget.serializeValue = () => {
		const targetNode = widget.__gjjNode || node;
		const state = ensureLoraNodeState(targetNode);
		const serialized = serializeRows(state.rows);
		const widgetIndex = Array.isArray(targetNode?.widgets)
			? targetNode.widgets.indexOf(widget)
			: -1;
		if (Array.isArray(targetNode?.widgets_values) && widgetIndex >= 0) {
			targetNode.widgets_values[widgetIndex] = serialized;
		}
		return serialized;
	};
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	widget.label = "";
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.widget) {
		widget.widget.style.display = "none";
	}
}

function ensureLoraNodeState(node) {
	node.properties = node.properties || {};
	if (node.__gjjLoraState) {
		// 如果内存中已有状态，直接返回（优先使用内存中的状态）
		return node.__gjjLoraState;
	}
	// 第一次初始化时，从 properties 读取
	node.__gjjLoraState = {
		rows: normalizeRows(node.properties[LORA_DATA_WIDGET_NAME] || "[]"),
		options: [{ ...DEFAULT_EMPTY_OPTION }],
	};
	return node.__gjjLoraState;
}

function updateLoraNodeHeight(node, rowCount) {
	const baseHeight = 78;
	const rowHeight = 50;
	const targetHeight = baseHeight + rowCount * rowHeight;
	node.size = [Math.max(node.size?.[0] || 420, 420), targetHeight];
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function updateLoraDataWidget(node) {
	const state = ensureLoraNodeState(node);
	const serialized = serializeRows(state.rows);

	// 保存到 node.properties（用于持久化和后端读取）
	if (!node.properties) node.properties = {};
	node.properties[LORA_DATA_WIDGET_NAME] = serialized;

	// 同步步数
	syncStepsFromLoras(node);

	// 通知 ComfyUI 节点已更改
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function ensureTrailingEmptyRow(node) {
	const state = ensureLoraNodeState(node);
	const rows = state.rows.filter((item) => item && typeof item === "object");
	const normalized = rows.filter((item, index) => item.name || index < rows.length - 1);
	if (normalized.length === 0 || normalized[normalized.length - 1].name) {
		normalized.push({ ...DEFAULT_ROW });
	}
	state.rows = normalized.map((item) => ({
		enabled: item.enabled !== false,
		name: String(item.name || ""),
		strength: normalizeStrength(item.strength, 1.0),
	}));
}

function getDefaultSearchValue(index) {
	return index === 0 ? DEFAULT_FIRST_SEARCH_TERMS : "";
}

function stopCanvasPointerCapture(event) {
	event.stopPropagation();
}

function stopCanvasWheelCapture(event) {
	event.stopPropagation();
}

function ensureGlobalLoraPopup() {
	if (globalThis.__gjjLoraPopup) {
		return globalThis.__gjjLoraPopup;
	}

	const panel = document.createElement("div");
	panel.className = "gjj-lora-popup";
	// 确保面板有正确的样式，不使用 CSS class 中的 position:absolute，直接使用 fixed
	panel.style.cssText = `
		display: none;
		flex-direction: column;
		gap: 6px;
		position: fixed;
		left: 12px;
		top: 12px;
		min-width: max(100%, 420px);
		max-width: 680px;
		width: max-content;
		padding: 6px;
		border: 1px solid #41535b;
		border-radius: 8px;
		background: #10171b;
		box-sizing: border-box;
		z-index: 99999;
		box-shadow: 0 8px 24px rgba(0,0,0,0.35);
	`;

	const search = document.createElement("input");
	search.type = "text";
	search.className = "gjj-lora-popup-search";
	search.style.cssText = `
		width: 100%;
		min-width: 0;
		background: #11181c;
		color: #dce7e2;
		border: 1px solid #41535b;
		border-radius: 6px;
		padding: 4px 6px;
		box-sizing: border-box;
	`;

	const list = document.createElement("div");
	list.className = "gjj-lora-popup-list";
	list.style.cssText = `
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 180px;
		overflow: auto;
	`;

	panel.appendChild(search);
	panel.appendChild(list);
	document.body.appendChild(panel);

	// 阻止事件冒泡但不阻止正常的点击事件
	const stopPropagationOnly = (event) => {
		event.stopPropagation();
	};

	// 只在 mousedown 和 pointerdown 上阻止事件冒泡，不在 click 上阻止
	panel.addEventListener("mousedown", stopPropagationOnly, true);
	panel.addEventListener("pointerdown", stopPropagationOnly, true);
	panel.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	panel.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });
	list.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	list.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });

	const popup = {
		panel,
		search,
		list,
		state: null,
		close() {
			panel.style.display = "none";
			search.value = "";
			search.placeholder = "搜索";
			search.title = "";
			list.replaceChildren();
			this.state = null;
			document.removeEventListener("pointerdown", outsideHandler, true);
		},
		reposition() {
			if (!this.state?.anchorEl) {
				return;
			}
			const rect = this.state.anchorEl?.getBoundingClientRect?.();
			const viewportWidth = Math.max(320, window.innerWidth || 320);
			const viewportHeight = Math.max(240, window.innerHeight || 240);
			const horizontalPadding = 12;
			const verticalPadding = 12;
			const targetWidth = Math.min(
				Math.max(Math.ceil(rect?.width || 420), 420),
				Math.max(320, viewportWidth - horizontalPadding * 2),
				680,
			);
			const spaceBelow = Math.max(120, viewportHeight - Math.ceil(rect?.bottom || 0) - verticalPadding - 6);
			const spaceAbove = Math.max(120, Math.floor(rect?.top || 0) - verticalPadding - 6);
			const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
			const panelMaxHeight = Math.max(180, Math.min(420, openAbove ? spaceAbove : spaceBelow));
			const listMaxHeight = Math.max(96, panelMaxHeight - 52);
			const rawLeft = Math.floor(rect?.left || horizontalPadding);
			const left = Math.max(horizontalPadding, Math.min(rawLeft, viewportWidth - targetWidth - horizontalPadding));

			panel.style.width = `${targetWidth}px`;
			panel.style.maxWidth = `${Math.max(320, viewportWidth - horizontalPadding * 2)}px`;
			panel.style.maxHeight = `${panelMaxHeight}px`;
			list.style.maxHeight = `${listMaxHeight}px`;
			panel.style.left = `${left}px`;

			if (openAbove) {
				panel.style.top = "auto";
				panel.style.bottom = `${Math.max(verticalPadding, viewportHeight - Math.floor(rect?.top || 0) + 6)}px`;
			} else {
				panel.style.bottom = "auto";
				panel.style.top = `${Math.max(verticalPadding, Math.ceil(rect?.bottom || verticalPadding) + 6)}px`;
			}
		},
		render() {
			if (!this.state) {
				return;
			}

			const selectedValue = String(this.state.getSelectedValue?.() || "");
			const options = this.state.getOptions(search.value);
			list.replaceChildren();

			if (!options.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-lora-popup-empty";
				empty.textContent = "没有匹配的 LoRA";
				list.appendChild(empty);
				this.reposition();
				return;
			}

			for (const option of options) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-lora-popup-item";
				item.style.cssText = [
					"pointer-events:auto",
					"user-select:none",
				].join(";");
				const isSelected = String(option.value || "") === selectedValue;
				if (isSelected) {
					item.classList.add("selected");
					item.textContent = `✔ ${option.label}`;
				} else {
					item.textContent = option.label;
				}

				function runItemClick(event) {
					event.preventDefault();
					event.stopPropagation();
					console.log("[GJJ] LoRA 弹出窗口选项被点击", option.value);
					popup.state?.onSelect?.(String(option.value || ""));
				}

				// 根据指南：在 mousedown 和 pointerdown 上只阻止冒泡
				for (const eventName of ["pointerdown", "mousedown"]) {
					item.addEventListener(eventName, (event) => event.stopPropagation(), true);
				}

				// 在 pointerup 和 click 上处理点击逻辑
				for (const eventName of ["pointerup", "click"]) {
					item.addEventListener(eventName, runItemClick, true);
				}

				list.appendChild(item);
			}

			this.reposition();
		},
		isOpenFor(anchorEl) {
			return panel.style.display === "flex" && this.state?.anchorEl === anchorEl;
		},
		open(state) {
			this.state = state;
			search.value = String(state.searchValue || "");
			search.placeholder = String(state.placeholder || "搜索");
			search.title = String(state.searchTitle || "");
			panel.style.display = "flex";
			this.reposition();
			this.render();
			document.addEventListener("pointerdown", outsideHandler, true);
			setTimeout(() => search.focus(), 0);
		},
	};

	function outsideHandler(event) {
		if (!popup.state) {
			return;
		}
		if (panel.contains(event.target) || popup.state.anchorEl?.contains?.(event.target)) {
			return;
		}
		popup.close();
	}

	search.addEventListener("input", () => {
		if (!popup.state) {
			return;
		}
		popup.state.onSearchChange?.(search.value);
		popup.render();
	});
	search.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Escape") {
			event.preventDefault();
			popup.close();
		}
	});
	window.addEventListener("resize", () => popup.reposition());

	globalThis.__gjjLoraPopup = popup;
	return popup;
}

function buildLoraRow(node, row, index, rowsContainer) {
	const state = ensureLoraNodeState(node);
	const rowElement = document.createElement("div");
	rowElement.className = `gjj-lora-row${row.enabled ? "" : " off"}`;

	const mainColumn = document.createElement("div");
	mainColumn.className = "gjj-lora-main";

	const picker = document.createElement("button");
	picker.type = "button";
	picker.className = "gjj-lora-picker";
	picker.title = "点击展开当前这一行 LoRA 的可搜索下拉列表。";

	const toggleWrap = document.createElement("label");
	toggleWrap.className = "gjj-lora-toggle-wrap";
	toggleWrap.title = "控制当前这一行 LoRA 是否参与串联加载。";

	const toggle = document.createElement("input");
	toggle.type = "checkbox";
	toggle.checked = row.enabled !== false;
	toggleWrap.appendChild(toggle);
	toggleWrap.appendChild(document.createTextNode("启用"));

	const strength = document.createElement("input");
	strength.type = "number";
	strength.className = "gjj-lora-strength";
	strength.step = "0.05";
	strength.value = formatStrength(row.strength, 1.0);
	strength.title = "设置当前 LoRA 的模型与 CLIP 共用强度值。";

	function updatePickerLabel() {
		picker.textContent = row.name || DEFAULT_EMPTY_OPTION.label;
	}

	// 根据指南文档：按钮点击事件处理
	async function runPickerClick(event) {
		event.preventDefault();
		event.stopPropagation();
		console.log("[GJJ] LoRA 选择器按钮被点击", node?.id, index);

		const popup = ensureGlobalLoraPopup();
		if (popup.isOpenFor(picker)) {
			popup.close();
			return;
		}
		popup.open({
			node,
			anchorEl: picker,
			searchValue: getDefaultSearchValue(index),
			placeholder: index === 0 ? "首槽默认加速关键词" : "搜索",
			searchTitle: "输入关键词筛选当前这一行可选的 LoRA 文件名；不区分大小写。语法：& 表示与，, 或 | 表示或。示例：flux & turbo,lightning,hyper",
			onSearchChange(searchValue) {
				// 不保存每行搜索，避免与原来的实现冲突
			},
			getSelectedValue() {
				return String(state.rows[index]?.name || "");
			},
			getOptions(searchText) {
				let options = state.options;
				if (state.rows[index]?.name && !options.some((option) => option.value === state.rows[index].name)) {
					options = [...options, { value: state.rows[index].name, label: state.rows[index].name }];
				}
				if (!searchText) {
					return options;
				}
				const terms = searchText.toLowerCase().split(/[,\s]+/).filter(Boolean);
				return options.filter((opt) => {
					if (!opt.value) return true;
					const lowerValue = opt.value.toLowerCase();
					return terms.every((term) => lowerValue.includes(term));
				});
			},
			onSelect(value) {
				state.rows[index].name = value;
				ensureTrailingEmptyRow(node);
				updateLoraDataWidget(node);
				popup.close();
				renderLoraUi(node);
			},
		});
	}

	// 根据指南：在多个事件类型上绑定，使用捕获阶段确保不被 canvas 拦截
	for (const eventName of ["pointerup", "click"]) {
		picker.addEventListener(eventName, runPickerClick, true);
	}

	// 在 mousedown 和 pointerdown 上只阻止冒泡，不阻止点击逻辑
	for (const eventName of ["pointerdown", "mousedown"]) {
		picker.addEventListener(eventName, (event) => event.stopPropagation(), true);
	}

	toggle.addEventListener("change", () => {
		state.rows[index].enabled = toggle.checked;
		updateLoraDataWidget(node);
		rowElement.classList.toggle("off", !toggle.checked);
	});

	const syncStrengthInput = () => {
		if (isPartialNumericInput(strength.value)) {
			return;
		}
		state.rows[index].strength = normalizeStrength(strength.value, state.rows[index].strength ?? 1.0);
		updateLoraDataWidget(node);
	};

	const commitStrength = () => {
		state.rows[index].strength = normalizeStrength(strength.value, state.rows[index].strength ?? 1.0);
		strength.value = formatStrength(state.rows[index].strength, 1.0);
		updateLoraDataWidget(node);
	};

	// 对于输入框，只阻止必要的事件冒泡
	strength.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Enter") {
			commitStrength();
			strength.blur();
		}
	});
	strength.addEventListener("input", syncStrengthInput);
	strength.addEventListener("change", commitStrength);
	strength.addEventListener("blur", commitStrength);

	updatePickerLabel();
	mainColumn.appendChild(picker);

	const sideColumn = document.createElement("div");
	sideColumn.className = "gjj-lora-side";
	sideColumn.appendChild(toggleWrap);
	sideColumn.appendChild(strength);

	rowElement.appendChild(mainColumn);
	rowElement.appendChild(sideColumn);
	rowsContainer.appendChild(rowElement);
}

function renderLoraUi(node) {
	const state = ensureLoraNodeState(node);
	const container = node.__gjjLoraContainer;
	const rowsContainer = node.__gjjLoraRows;
	if (!container || !rowsContainer) {
		return;
	}
	const dataWidget = node.widgets?.find((widget) => widget?.name === LORA_DATA_WIDGET_NAME);
	if (dataWidget) {
		hideLoraDataWidget(node, dataWidget);
	}

	if (globalThis.__gjjLoraPopup?.state?.node === node) {
		globalThis.__gjjLoraPopup.close();
	}

	ensureTrailingEmptyRow(node);
	rowsContainer.replaceChildren();
	state.rows.forEach((row, index) => buildLoraRow(node, row, index, rowsContainer));
	updateLoraNodeHeight(node, state.rows.length);
	updateLoraDataWidget(node);
}

async function refreshLoraOptions(node, rerender = true) {
	const state = ensureLoraNodeState(node);
	state.options = await fetchLoraOptions();
	if (rerender) {
		renderLoraUi(node);
	}
}



function setupLoraUi(node) {
	if (node.__gjjLoraContainer) {
		return;
	}

	// Step 1: 从 properties 读取初始数据
	let initialData = node.properties?.[LORA_DATA_WIDGET_NAME] || "";

	// 初始化 state
	ensureLoraNodeState(node).rows = normalizeRows(initialData || "[]");

	const container = document.createElement("div");
	container.className = "gjj-lora-wrap";
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"margin-top:4px",
		"pointer-events:auto",
		"position:relative",
		"z-index:100"
	].join(";");

	const style = document.createElement("style");
	style.textContent = `
		.gjj-lora-toolbar { display:flex; flex-direction:row; gap:6px; align-items:center; }
		.gjj-lora-refresh { padding:2px 8px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; }
		.gjj-lora-rows { display:flex; flex-direction:column; gap:6px; }
		.gjj-lora-row { display:flex; align-items:flex-start; gap:6px; padding:6px; border:1px solid #3c4c54; border-radius:8px; background:#172026; }
		.gjj-lora-row.off { opacity:0.65; }
		.gjj-lora-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; position:relative; }
		.gjj-lora-picker { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 8px; box-sizing:border-box; text-align:left; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:auto; }
		.gjj-lora-popup { display:none; flex-direction:column; gap:6px; position:absolute; top:calc(100% + 6px); left:0; min-width:max(100%, 420px); max-width:680px; width:max-content; padding:6px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-sizing:border-box; z-index:9999; box-shadow:0 8px 24px rgba(0,0,0,0.35); }
		.gjj-lora-popup.open { display:flex; }
		.gjj-lora-popup-search { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; box-sizing:border-box; pointer-events:auto; }
		.gjj-lora-popup-list { display:flex; flex-direction:column; gap:4px; max-height:180px; overflow:auto; }
		.gjj-lora-popup-item { width:100%; background:#182127; color:#dce7e2; border:1px solid #33454c; border-radius:6px; padding:5px 8px; text-align:left; cursor:pointer; box-sizing:border-box; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:1.3; pointer-events:auto; }
		.gjj-lora-popup-item:hover { background:#223039; }
		.gjj-lora-popup-item.selected { background:#18352f; border-color:#2f7d67; color:#e8fff6; }
		.gjj-lora-popup-item.selected:hover { background:#1d433a; }
		.gjj-lora-popup-empty { color:#8da2ad; font-size:11px; padding:4px 2px; }
		.gjj-lora-side { display:flex; align-items:center; gap:6px; padding-top:2px; flex:0 0 auto; white-space:nowrap; pointer-events:auto; }
		.gjj-lora-toggle-wrap { display:flex; align-items:center; gap:4px; color:#dce7e2; font-size:11px; white-space:nowrap; flex:0 0 auto; pointer-events:auto; }
		.gjj-lora-strength { width:68px; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; text-align:center; pointer-events:auto; }
	`;
	container.appendChild(style);

	// 刷新按钮已移到按钮区域，这里不需要 toolbar

	const rowsContainer = document.createElement("div");
	rowsContainer.className = "gjj-lora-rows";
	container.appendChild(rowsContainer);

	// 根据指南文档：在面板上统一阻止所有关键事件
	const eventNamesToPrevent = [
		"pointerdown",
		"mousedown",
		"click",
		"dblclick",
		"contextmenu",
		"wheel",
		"keydown",
		"keyup"
	];

	for (const eventName of eventNamesToPrevent) {
		container.addEventListener(eventName, (event) => {
			event.stopPropagation();
			// 注意：不要在所有事件上都 preventDefault，否则会影响输入框等正常功能
		}, true);
	}

	// 特别处理 wheel 事件
	container.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	container.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });

	node.__gjjLoraContainer = container;
	node.__gjjLoraRows = rowsContainer;

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		if (typeof originalOnSerialize === "function") {
			originalOnSerialize.apply(this, arguments);
		}
		if (serializedNode) {
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[LORA_DATA_WIDGET_NAME] = serializeRows(ensureLoraNodeState(this).rows);
		}
	};

	node.addDOMWidget("LoRA 串联", "HTML", container, { serialize: false });

	refreshLoraOptions(node, false).then(() => {
		renderLoraUi(node);
	});
}

function removeInternalInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let i = node.inputs.length - 1; i >= 0; i--) {
		const input = node.inputs[i];
		const name = String(input?.name || "");
		if (name === BATCH_SOURCE_WIDGET) {
			if (input?.link != null) {
				node.disconnectInput?.(i);
			}
			if (typeof node.removeInput === "function") {
				node.removeInput(i);
			} else {
				node.inputs.splice(i, 1);
			}
		}
	}
}

function stabilizeNode(node, forcePreset = false) {
	if (!node) {
		return;
	}
	trimUnusedImageInputs(node);
	ensureTrailingImageInput(node);
	renameImageInputs(node);
	hookUnetWidget(node);

	removeInternalInputs(node);

	// 彻底隐藏 batch_source_images widget
	let batchSourceWidget = getWidget(node, BATCH_SOURCE_WIDGET);

	// 如果找不到，尝试用其他方式查找
	if (!batchSourceWidget && Array.isArray(node.widgets)) {
		for (const w of node.widgets) {
			const name = String(w?.name || "").toLowerCase();
			const label = String(w?.label || "").toLowerCase();
			if (name === BATCH_SOURCE_WIDGET.toLowerCase() ||
				name.includes("batch_source") ||
				label.includes("批量图片来源")) {
				batchSourceWidget = w;
				console.log(`[GJJ] 找到并准备隐藏 widget: ${w.name} - ${w.label}`);
				break;
			}
		}
	}

	if (batchSourceWidget) {
		GJJ_Utils.hideWidget(batchSourceWidget);
	}

	// 先创建按钮和 LoRA UI
	if (!node.__gjjExecuteButtonWidget) {
		const buttonsContainer = createButtons(node);
		node.__gjjExecuteButtonWidget = node.addDOMWidget(EXECUTE_BUTTON_NAME, "HTML", buttonsContainer, { serialize: false });
	}

	setupLoraUi(node);

	// 最后创建图片预览，这样它就会在最下面
	if (!node.__gjjImagePreviewWidget) {
		const previewContainer = createImagePreview(node);
		node.__gjjImagePreviewWidget = node.addDOMWidget(IMAGE_PREVIEW_NAME, "HTML", previewContainer, { serialize: false });
	}

	applyPreset(node, forcePreset);
	syncPanelFromLinkedSources(node);
	GJJ_Utils.refreshNode(node);
}

function hideDefaultPreviewElements(node) {
	// 按照文档中的终极方案：彻底隐藏默认预览
	// 找到节点的 DOM 元素
	let nodeElement = null;
	try {
		// 尝试多种方式获取节点元素
		if (node.imgs) {
			nodeElement = node.imgs;
		} else if (node.element) {
			nodeElement = node.element;
		} else if (node.dummyEl) {
			nodeElement = node.dummyEl;
		} else {
			// 通过 DOM 查找所有可能的节点
			const allCanvasNodes = document.querySelectorAll('.litegraph');
			for (const canvasNode of allCanvasNodes) {
				const potentialNodes = canvasNode.querySelectorAll ?
					canvasNode.querySelectorAll('[data-node-id]') : [];
				for (const el of potentialNodes) {
					if (el.getAttribute('data-node-id') === String(node.id)) {
						nodeElement = el;
						break;
					}
				}
			}
		}
	} catch (e) {
		console.log("[GJJ] Error finding node element:", e);
	}

	// 只要找到了任何节点相关的元素，都尝试查找并隐藏
	if (nodeElement) {
		// 查找所有元素
		const allElements = nodeElement.querySelectorAll ?
			nodeElement.querySelectorAll("*") : [];

		// 查找所有图片元素
		const allImgs = nodeElement.querySelectorAll ?
			nodeElement.querySelectorAll("img") : [];

		// 隐藏所有非自定义的图片
		for (const img of allImgs) {
			if (!img.dataset?.gjjCustomPreview) {
				img.style.display = "none";
				img.style.visibility = "hidden";
			}
		}

		// 隐藏所有看起来是预览的元素
		for (const el of allElements) {
			const classStr = String(el.className || "").toLowerCase();
			const idStr = String(el.id || "").toLowerCase();
			const tagName = String(el.tagName || "").toLowerCase();

			// 判断是否是预览相关的元素
			if (
				classStr.includes("preview") ||
				idStr.includes("preview") ||
				(tagName === "div" && el.querySelector && el.querySelector("img"))) {
				// 检查这个元素是否是我们的自定义预览容器
				let isOurCustomPreview = false;
				const customImgs = el.querySelectorAll ?
					el.querySelectorAll("img[data-gjj-custom-preview='true']") : [];
				if (customImgs.length > 0) {
					isOurCustomPreview = true;
				}

				// 如果不是我们的自定义预览，就隐藏它
				if (!isOurCustomPreview) {
					// 只隐藏明显的预览容器，不隐藏整个节点！
					// 小心地只调整高度！
					el.style.visibility = "hidden";
					el.style.height = "0px";
					el.style.overflow = "hidden";
					el.style.margin = "0px";
					el.style.padding = "0px";
				}
			}
		}
	}
}

function setupPreviewObserver(node) {
	// 按照文档：使用 MutationObserver 实时隐藏默认预览
	// 停止之前的观察器
	if (node.__gjjPreviewObserver) {
		try {
			node.__gjjPreviewObserver.disconnect();
		} catch (e) {
			// 忽略错误
		}
	}

	// 尝试找到节点的 DOM 元素
	let targetElement = null;
	try {
		if (node.imgs) {
			targetElement = node.imgs;
		} else if (node.element) {
			targetElement = node.element;
		} else if (node.dummyEl) {
			targetElement = node.dummyEl;
		}
	} catch (e) {
		// 忽略错误
	}

	// 如果找到了元素，设置观察器
	if (targetElement && targetElement.ownerDocument) {
		node.__gjjPreviewObserver = new MutationObserver((mutations) => {
			// 只要有任何变化，就尝试隐藏预览
			let needsHide = false;

			for (const mutation of mutations) {
				if (mutation.addedNodes && mutation.addedNodes.length > 0) {
					needsHide = true;
					break;
				}
				if (mutation.type === 'attributes' &&
					(mutation.attributeName === 'style' ||
					 mutation.attributeName === 'class' ||
					 mutation.attributeName === 'src')) {
					needsHide = true;
					break;
				}
			}

			if (needsHide) {
				// 延迟隐藏，确保元素完全添加
				setTimeout(() => hideDefaultPreviewElements(node), 0);
				setTimeout(() => hideDefaultPreviewElements(node), 20);
				setTimeout(() => hideDefaultPreviewElements(node), 50);
			}
		});

		// 观察元素的变化
		try {
			node.__gjjPreviewObserver.observe(targetElement, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['style', 'class', 'src'],
			});
		} catch (e) {
			console.log("[GJJ] Error setting up MutationObserver:", e);
		}
	}
}

function scheduleStabilize(node, forcePreset = false) {
	clearTimeout(node.__gjjLazyImageStudioTimer);
	node.__gjjLazyImageStudioTimer = setTimeout(() => {
		stabilizeNode(node, forcePreset);
	}, 16);
}

globalThis.GJJLazyImageStudioSyncBatchSources = function (sourceNode) {
	if (!sourceNode) {
		return;
	}
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			continue;
		}
		const primary = getInput(node, PRIMARY_IMAGE_INPUT);
		const linkId = primary?.link;
		if (!linkId || !app.graph?.links) {
			continue;
		}
		const link = app.graph.links[linkId];
		if (link?.origin_id === sourceNode.id) {
			syncBatchSourceWidget(node);
		}
	}
};

app.registerExtension({
	name: "Comfy.GJJ.LazyImageStudio",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		// 隐藏节点默认的图片预览 - 更彻底的方式
		nodeData.output_preview = false;
		// 确保对所有输出都禁用预览
		if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);

			// 创建观察器，确保任何时候添加的预览都会被隐藏
			this.__gjjPreviewObserver = null;

			setTimeout(() => {
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
				stabilizeNode(this, true);
				syncPanelFromLinkedSources(this);

				// 隐藏默认预览元素
				hideDefaultPreviewElements(this);

				// 启动 DOM 变化观察器
				setupPreviewObserver(this);
			}, 0);
			void ensureModelPresetsLoaded().then(() => scheduleStabilize(this, true));
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			setTimeout(() => {
				const state = ensureLoraNodeState(this);
				const dataWidget = this.widgets?.find((widget) => widget?.name === LORA_DATA_WIDGET_NAME);
				if (dataWidget) {
					state.rows = normalizeRows(dataWidget?.value || this.properties?.[LORA_DATA_WIDGET_NAME] || "[]");
				}
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
				stabilizeNode(this, false);
				syncPanelFromLinkedSources(this);

				// 隐藏默认预览元素
				hideDefaultPreviewElements(this);
			}, 0);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			setTimeout(() => {
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
				stabilizeNode(this, false);
				syncPanelFromLinkedSources(this);
			}, 0);
			return result;
		};

		const originalDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalDrawBackground?.apply(this, args);
			const signature = externalPanelSignature(this);
			if (signature !== this.__gjjLazyExternalPanelSignature) {
				this.__gjjLazyExternalPanelSignature = signature;
				syncPanelFromLinkedSources(this);
			}
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			console.log("[GJJ] onExecuted message:", message);

			// 不调用 originalExecuted，避免显示默认预览
			// const result = originalExecuted?.apply(this, [message]);

			// 处理不同格式的图片数据
			let images = null;

			if (message?.images) {
				images = message.images;
			} else if (message?.ui?.images) {
				images = message.ui.images;
			} else if (message?.output?.images) {
				images = message.output.images;
			} else if (message?.results?.images) {
				images = message.results.images;
			} else if (Array.isArray(message?.ui)) {
				// 处理 ui 是数组的情况
				for (const uiItem of message.ui) {
					if (uiItem?.images) {
						images = uiItem.images;
						break;
					}
				}
			}

			if (images) {
				console.log("[GJJ] Updating image preview with images:", images);
				updateImagePreview(this, images);
			}

			const effectiveParams = Array.isArray(message?.effective_params)
				? message.effective_params[0]
				: (Array.isArray(message?.ui?.effective_params) ? message.ui.effective_params[0] : null);
			applyEffectiveParamsToPanel(this, effectiveParams, true);

			// 按照文档：不管怎样都执行一次隐藏，确保之前的被隐藏
			setTimeout(() => hideDefaultPreviewElements(this), 0);
			setTimeout(() => hideDefaultPreviewElements(this), 50);
			setTimeout(() => hideDefaultPreviewElements(this), 150);

			// 不返回 result，因为我们没有调用 originalExecuted
			return;
		};
	},

	setup() {
		void ensureModelPresetsLoaded().then(() => {
			for (const node of app.graph?._nodes || []) {
				if (!TARGET_NODES.has(node?.comfyClass)) {
					continue;
				}
				stabilizeNode(node, false);
				syncPanelFromLinkedSources(node);
			}
		});
	},
});

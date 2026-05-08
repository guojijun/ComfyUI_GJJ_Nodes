import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
	getCachedModelFamilyPresets,
	getModelFamilyPresets,
} from "./gjj_model_family_preset_table.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_LazyImageStudio"]);
const IMAGE_PREFIX = "image_";
const PRIMARY_IMAGE_INPUT = "image_01";
const BATCH_SOURCE_WIDGET = "batch_source_images";
const MAIN_MASK_INPUT = "mask";
const STATUS_WIDGET = "gjj_lazy_image_status";
const LAST_PRESET_KEY = "gjj_lazy_last_preset_unet";
const MIN_VISIBLE_IMAGES = 1;
const MAX_IMAGES = Number.POSITIVE_INFINITY;
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const IMAGE_TOOLTIP = "参考图片输入；有连接时会自动补出下一个图片插槽。";
const PRIMARY_IMAGE_TOOLTIP = "可直接接入 GJJ · 多图片加载预览器 的批量图片输出；后端会按原图顺序恢复多图参考。";
const MASK_TOOLTIP = "主图可选遮罩；存在时会走带 noise_mask 的局部编辑逻辑。";

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

function parseProgress(text) {
	const value = String(text || "");
	const match = value.match(/(\d+)\s*\/\s*(\d+)/);
	if (match) {
		const current = Math.max(0, Number(match[1] || 0));
		const total = Math.max(1, Number(match[2] || 1));
		return Math.max(0, Math.min(100, (current / total) * 100));
	}
	if (value.includes("完成") || value.includes("失败")) {
		return 100;
	}
	return 8;
}

function ensureStatusWidget(node) {
	if (node.__gjjLazyStatus?.widget) {
		return node.__gjjLazyStatus;
	}
	const widget = {
		name: STATUS_WIDGET,
		type: "gjj_status",
		value: "等待执行",
		computeSize(width) {
			return [Math.max(240, Number(width || node.size?.[0] || 240)), 62];
		},
		draw(ctx, currentNode, width, y) {
			const message = String(widget.value || "等待执行");
			const progress = parseProgress(message);
			const x = 10;
			const boxY = y + 4;
			const boxWidth = Math.max(80, Number(width || currentNode?.size?.[0] || 240) - 20);
			const boxHeight = 52;
			ctx.save();
			ctx.beginPath();
			ctx.roundRect?.(x, boxY, boxWidth, boxHeight, 10);
			if (typeof ctx.roundRect !== "function") {
				ctx.rect(x, boxY, boxWidth, boxHeight);
			}
			ctx.fillStyle = "#0f1a1f";
			ctx.fill();
			ctx.strokeStyle = "#31464f";
			ctx.lineWidth = 1;
			ctx.stroke();
			ctx.fillStyle = "#dce7e2";
			ctx.font = "12px sans-serif";
			ctx.textBaseline = "top";
			ctx.fillText(message.length > 34 ? `${message.slice(0, 33)}...` : message, x + 10, boxY + 8);
			ctx.beginPath();
			ctx.roundRect?.(x + 10, boxY + 34, boxWidth - 20, 7, 999);
			if (typeof ctx.roundRect !== "function") {
				ctx.rect(x + 10, boxY + 34, boxWidth - 20, 7);
			}
			ctx.fillStyle = "#1a262c";
			ctx.fill();
			ctx.beginPath();
			ctx.roundRect?.(x + 10, boxY + 34, Math.max(4, (boxWidth - 20) * progress / 100), 7, 999);
			if (typeof ctx.roundRect !== "function") {
				ctx.rect(x + 10, boxY + 34, Math.max(4, (boxWidth - 20) * progress / 100), 7);
			}
			ctx.fillStyle = "#34d399";
			ctx.fill();
			ctx.restore();
		},
	};
	node.widgets = node.widgets || [];
	node.widgets.push(widget);
	node.__gjjLazyStatus = { widget };
	return node.__gjjLazyStatus;
}

function setStatus(node, text) {
	const state = ensureStatusWidget(node);
	state.widget.value = String(text || "等待执行");
	GJJ_Utils.dirtyCanvas(node);
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
				(normalized.includes(normalizedKeyword) || (canonicalKeyword && canonical.includes(canonicalKeyword)))
				&& (canonicalKeyword || normalizedKeyword).length > bestLength
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
	if (text.includes("flux_2-turbo-lora_comfyui_8steps_v2") || text.includes("flux2turbocomfyv2")) {
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
	const pairs = [
		[getWidget(node, "lora_1_name")?.value, getWidget(node, "lora_1_strength")?.value],
		[getWidget(node, "lora_2_name")?.value, getWidget(node, "lora_2_strength")?.value],
	];
	for (const [name, strength] of pairs) {
		if (!isLoraEnabled(name, strength)) {
			continue;
		}
		const suggested = resolveLoraSuggestedSteps(name);
		if (Number.isFinite(suggested)) {
			setWidgetValue(stepsWidget, suggested);
			return;
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
	const lora1Widget = getWidget(node, "lora_1_name");
	const lora2Widget = getWidget(node, "lora_2_name");
	const clipValues = Array.isArray(clipWidget?.options?.values) ? clipWidget.options.values : [];
	const vaeValues = Array.isArray(vaeWidget?.options?.values) ? vaeWidget.options.values : [];
	const lora1Values = Array.isArray(lora1Widget?.options?.values) ? lora1Widget.options.values : [];
	const lora2Values = Array.isArray(lora2Widget?.options?.values) ? lora2Widget.options.values : [];

	setWidgetValue(clipWidget, preferredValue(clipValues, (preset.clipNames || [])[0] || ""));
	setWidgetValue(vaeWidget, preferredValue(vaeValues, preset.vaeName || ""));
	setWidgetValue(lora1Widget, preferredValue(lora1Values, preset.lora1 || ""));
	setWidgetValue(getWidget(node, "lora_1_strength"), Number(preset.lora1Strength || 0));
	setWidgetValue(lora2Widget, preferredValue(lora2Values, preset.lora2 || ""));
	setWidgetValue(getWidget(node, "lora_2_strength"), Number(preset.lora2Strength || 0));
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
	node.properties[LAST_PRESET_KEY] = currentUnet;
	syncStepsFromLoras(node);
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
		if (node.properties) {
			node.properties[LAST_PRESET_KEY] = "";
		}
		applyPreset(node, true);
		GJJ_Utils.refreshNode(node);
		return result;
	};
}

function hookLoraWidgets(node) {
	for (const name of ["lora_1_name", "lora_1_strength", "lora_2_name", "lora_2_strength"]) {
		const widget = getWidget(node, name);
		if (!widget || widget.__gjjLazyLoraHooked) {
			continue;
		}
		widget.__gjjLazyLoraHooked = true;
		const original = widget.callback;
		widget.callback = function (value, ...args) {
			const result = original?.call(this, value, ...args);
			syncStepsFromLoras(node);
			GJJ_Utils.dirtyCanvas(node);
			return result;
		};
	}
}

function stabilizeNode(node, forcePreset = false) {
	if (!node) {
		return;
	}
	ensureStatusWidget(node);
	trimUnusedImageInputs(node);
	ensureTrailingImageInput(node);
	renameImageInputs(node);
	hookUnetWidget(node);
	hookLoraWidgets(node);
	GJJ_Utils.hideWidget(getWidget(node, BATCH_SOURCE_WIDGET));
	applyPreset(node, forcePreset);
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, forcePreset = false) {
	clearTimeout(node.__gjjLazyImageStudioTimer);
	node.__gjjLazyImageStudioTimer = setTimeout(() => {
		stabilizeNode(node, forcePreset);
	}, 16);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setStatus(targetNode, detail.text || "处理中...");
});

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

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setStatus(this, "等待执行");
			setTimeout(() => {
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
				stabilizeNode(this, true);
			}, 0);
			void ensureModelPresetsLoaded().then(() => scheduleStabilize(this, true));
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			setTimeout(() => {
				cleanupRedundantMultiLoaderLinks(this);
				syncBatchSourceWidget(this);
				void syncSizeFromPrimaryInput(this);
				stabilizeNode(this, false);
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
			}, 0);
			return result;
		};
	},

	setup() {
		void ensureModelPresetsLoaded().then(() => {
			for (const node of app.graph?._nodes || []) {
				if (!TARGET_NODES.has(node?.comfyClass)) {
					continue;
				}
				if (!node.__gjjLazyStatus?.widget?.value) {
					setStatus(node, "等待执行");
				}
				stabilizeNode(node, false);
			}
		});
	},
});

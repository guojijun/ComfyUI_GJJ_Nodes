import { app } from "/scripts/app.js";

const NODE_TYPE = "GJJ_ImageBatchMulti";
const IMAGE_PREFIX = "image_";
const COMPAT_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const MIN_INPUTS = 1;
const CONTROL_WIDGET = "gjj_image_batch_multi_controls";
const SAVED_INPUT_COUNT_PROPERTY = "gjj_image_batch_multi_input_count";
const INTERNAL_WIDGET_INPUTS = new Set([
	"width",
	"height",
	"宽度",
	"高度",
	"size_preset",
	"orientation",
	"prepend_frame",
	"custom_size",
	"custom_ratio",
	"尺寸档位",
	"画幅方向",
	"前置帧",
	"自定义尺寸",
	"自定义比例",
]);
const HIDDEN_WIDGETS = new Set(["width", "height", "size_preset", "orientation", "prepend_frame", "custom_size", "custom_ratio"]);
const DEFAULT_VALUES = {
	size_preset: "720",
	orientation: "横屏",
	prepend_frame: "无",
	width: 0,
	height: 0,
	custom_size: 0,
	custom_ratio: "16:9",
};

const SIZE_DIMENSIONS = {
	"320": { "横屏": [576, 320], "竖屏": [320, 576], "正方形": [320, 320] },
	"480": { "横屏": [864, 480], "竖屏": [480, 864], "正方形": [480, 480] },
	"720": { "横屏": [1280, 720], "竖屏": [720, 1280], "正方形": [720, 720] },
	"1024": { "横屏": [1824, 1024], "竖屏": [1024, 1824], "正方形": [1024, 1024] },
	"2K": { "横屏": [2048, 1152], "竖屏": [1152, 2048], "正方形": [2048, 2048] },
	"4K": { "横屏": [3840, 2160], "竖屏": [2160, 3840], "正方形": [3840, 3840] },
};
const SIZE_OPTIONS = [
	{ value: "320", emoji: "3️⃣", tooltip: "320 档位。横屏 576 x 320，竖屏 320 x 576，正方形 320 x 320；最终尺寸按 16 对齐。" },
	{ value: "480", emoji: "4️⃣", tooltip: "480 档位。横屏 864 x 480，竖屏 480 x 864，正方形 480 x 480；最终尺寸按 16 对齐。" },
	{ value: "720", emoji: "7️⃣", tooltip: "720 档位。横屏 1280 x 720，竖屏 720 x 1280，正方形 720 x 720；最终尺寸按 16 对齐。" },
	{ value: "1024", emoji: "1️⃣", tooltip: "1024 档位。横屏 1824 x 1024，竖屏 1024 x 1824，正方形 1024 x 1024；最终尺寸按 16 对齐。" },
	{ value: "2K", emoji: "2️⃣", tooltip: "2K 档位。横屏 2048 x 1152，竖屏 1152 x 2048，正方形 2048 x 2048；最终尺寸按 16 对齐。" },
	{ value: "4K", emoji: "#️⃣", tooltip: "4K 档位。横屏 3840 x 2160，竖屏 2160 x 3840，正方形 3840 x 3840；最终尺寸按 16 对齐。" },
];
const ORIENTATION_OPTIONS = [
	{ value: "横屏", emoji: "⏩", tooltip: "横屏。按当前尺寸档位输出 16:9 横向画幅。" },
	{ value: "竖屏", emoji: "⏫", tooltip: "竖屏。按当前尺寸档位输出 9:16 竖向画幅。" },
	{ value: "正方形", emoji: "🟦", tooltip: "正方形。按当前尺寸档位输出 1:1 方图。" },
];
const PREPEND_OPTIONS = [
	{ value: "黑帧", emoji: "◼️", tooltip: "前置黑帧。与白帧互斥；再次点击可取消前置帧。" },
	{ value: "白帧", emoji: "⬜️", tooltip: "前置白帧。与黑帧互斥；再次点击可取消前置帧。" },
];

function isTarget(node) {
	return node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE;
}

function injectStyles() {
	if (document.getElementById("gjj-image-batch-multi-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-image-batch-multi-style";
	style.textContent = `
		.gjj-ibm-controls{display:flex;flex-wrap:wrap;align-items:center;gap:4px;width:100%;box-sizing:border-box;padding:3px 0 2px}
		.gjj-ibm-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:24px;padding:0;border:1px solid #3b5360;border-radius:6px;background:#18242b;color:#dce7e2;font:14px/1 "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;font-variant-emoji:emoji;cursor:pointer;box-sizing:border-box}
		.gjj-ibm-icon{display:inline-flex;align-items:center;justify-content:center;font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;font-variant-emoji:emoji;line-height:1}
		.gjj-ibm-btn:hover{background:#22333d;border-color:#5d7c8e}
		.gjj-ibm-btn.on{background:#1f6b43;border-color:#48ad73;color:#fff}
		.gjj-ibm-sep{display:inline-flex;align-items:center;height:24px;color:#6f8790;font-size:12px;font-weight:700;padding:0 1px;user-select:none}
		.gjj-ibm-summary{display:inline-flex;align-items:center;min-height:24px;color:#b9d7df;font-size:12px;line-height:1.2;padding:0 2px;white-space:nowrap}
		.gjj-ibm-custom-panel{flex:1 0 100%;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;width:100%;padding:6px;margin-top:2px;border:1px solid #2d4753;border-radius:7px;background:#0b151a;box-sizing:border-box}
		.gjj-ibm-custom-panel[hidden]{display:none}
		.gjj-ibm-custom-field{display:flex;align-items:center;gap:4px;min-width:0}
		.gjj-ibm-custom-field span{flex:0 0 auto;color:#9fb4bc;font-size:11px;line-height:1;white-space:nowrap}
		.gjj-ibm-custom-input{min-width:0;width:100%;height:24px;padding:2px 6px;border:1px solid #344b55;border-radius:6px;background:#1d2529;color:#e7f3f6;font-size:12px;outline:none;box-sizing:border-box}
		.gjj-ibm-custom-input:focus{border-color:#6aa6b8;background:#202d33}
		.gjj-ibm-custom-actions{display:flex;gap:4px;grid-column:1/-1;align-items:center;justify-content:flex-end;min-width:0}
		.gjj-ibm-mini{height:23px;padding:0 7px;border:1px solid #3b5360;border-radius:6px;background:#17252c;color:#dce7e2;font:12px/1 "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;font-variant-emoji:emoji;cursor:pointer}
		.gjj-ibm-mini:hover{background:#24343d;border-color:#5d7c8e}
		.gjj-ibm-mini.primary{background:#1f6b43;border-color:#48ad73;color:#fff}
	`;
	document.head.appendChild(style);
}

function imageIndex(input) {
	const match = String(input?.name || "").match(/^image_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function imageInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => /^image_\d+$/.test(String(input?.name || ""))).sort((a, b) => imageIndex(a) - imageIndex(b))
		: [];
}

function formatImageInputName(index) {
	return `${IMAGE_PREFIX}${String(index).padStart(2, "0")}`;
}

function setImageInputMeta(input, index) {
	const name = formatImageInputName(index);
	input.name = name;
	input.type = COMPAT_TYPE;
	input.label = `图片 ${index}`;
	input.localized_name = input.label;
	input.tooltip = `第 ${index} 路图片输入；支持普通 IMAGE 或 GJJ 批量图片。连接最后一个输入口后会自动展开下一路。`;
}

function removeInput(node, input) {
	const slot = node.inputs?.indexOf(input) ?? -1;
	if (slot < 0) return;
	try { node.disconnectInput?.(slot); } catch (_) {}
	if (typeof node.removeInput === "function") {
		node.removeInput(slot);
	} else {
		node.inputs.splice(slot, 1);
	}
}

function removeInternalWidgetInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const widgetName = String(input?.widget?.name || "");
		if (!INTERNAL_WIDGET_INPUTS.has(name) && !INTERNAL_WIDGET_INPUTS.has(widgetName)) {
			continue;
		}
		try { node.disconnectInput?.(index); } catch (_) {}
		if (typeof node.removeInput === "function") {
			node.removeInput(index);
		} else {
			node.inputs.splice(index, 1);
		}
	}
}

function findWidget(node, name) {
	return Array.isArray(node?.widgets) ? node.widgets.find((widget) => String(widget?.name || "") === name) : null;
}

function hideWidget(widget) {
	if (!widget) return;
	widget.__gjjImageBatchMultiHidden = true;
	widget.hidden = true;
	widget.serialize = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.label = "";
	widget.localized_name = "";
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	widget.options = widget.options || {};
	widget.options.display_name = "";
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
	if (widget.widget) widget.widget.style.display = "none";
}

function hideNativeWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		hideWidget(findWidget(node, name));
	}
}

function readWidget(node, name) {
	const widget = findWidget(node, name);
	return String(widget?.value ?? DEFAULT_VALUES[name] ?? "");
}

function writeWidget(node, name, value) {
	let widget = findWidget(node, name);
	if (!widget) {
		ensureBackingWidgets(node);
		widget = findWidget(node, name);
	}
	if (!widget) return;
	widget.value = value;
	const index = node.widgets?.indexOf(widget) ?? -1;
	if (index >= 0 && Array.isArray(node.widgets_values)) {
		node.widgets_values[index] = value;
	}
	try {
		widget.callback?.call(widget, value, app.canvas, node, app.graph);
	} catch (_) {}
}

function ensureBackingWidgets(node) {
	if (!node || typeof node.addWidget !== "function") return;
	const defs = [
		{ name: "size_preset", type: "text", value: DEFAULT_VALUES.size_preset, options: {} },
		{ name: "orientation", type: "text", value: DEFAULT_VALUES.orientation, options: {} },
		{ name: "prepend_frame", type: "text", value: DEFAULT_VALUES.prepend_frame, options: {} },
		{ name: "width", type: "number", value: 0, options: { min: 0, max: 8192, step: 16 } },
		{ name: "height", type: "number", value: 0, options: { min: 0, max: 8192, step: 16 } },
		{ name: "custom_size", type: "number", value: DEFAULT_VALUES.custom_size, options: { min: 0, max: 8192, step: 16 } },
		{ name: "custom_ratio", type: "text", value: DEFAULT_VALUES.custom_ratio, options: {} },
	];
	for (const def of defs) {
		if (findWidget(node, def.name)) continue;
		const widget = node.addWidget(def.type, def.name, def.value, null, {
			...def.options,
			serialize: true,
			display_name: "",
		});
		if (widget) widget.serialize = true;
	}
}

function readNumberWidget(node, name, fallback = 0) {
	const value = Number(readWidget(node, name));
	return Number.isFinite(value) ? value : fallback;
}

function alignTo16(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 16;
	return Math.max(16, Math.round(Math.max(1, number) / 16) * 16);
}

function gcd(a, b) {
	let left = Math.max(1, Math.round(Math.abs(Number(a) || 1)));
	let right = Math.max(1, Math.round(Math.abs(Number(b) || 1)));
	while (right) {
		const next = left % right;
		left = right;
		right = next;
	}
	return left || 1;
}

function ratioTextFromDimensions(width, height) {
	const divisor = gcd(width, height);
	return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function parseRatio(value) {
	let text = String(value || DEFAULT_VALUES.custom_ratio).trim().toLowerCase();
	const aliases = {
		"横": "16:9",
		"横屏": "16:9",
		"landscape": "16:9",
		"horizontal": "16:9",
		"wide": "16:9",
		"⏩": "16:9",
		"竖": "9:16",
		"竖屏": "9:16",
		"portrait": "9:16",
		"vertical": "9:16",
		"tall": "9:16",
		"⏫": "9:16",
		"方": "1:1",
		"正方形": "1:1",
		"square": "1:1",
		"🟦": "1:1",
	};
	text = aliases[text] || text;
	const match = text.match(/^\s*(\d+(?:\.\d+)?)\s*[:/x×,，]\s*(\d+(?:\.\d+)?)\s*$/);
	if (match) {
		const left = Number(match[1]);
		const right = Number(match[2]);
		return left > 0 && right > 0 ? [left, right] : null;
	}
	const ratio = Number(text);
	return ratio > 0 ? [ratio, 1] : null;
}

function dimensionsFromSizeRatio(sizeValue, ratioValue) {
	const size = alignTo16(sizeValue);
	const ratio = parseRatio(ratioValue);
	if (!ratio) return null;
	const [ratioWidth, ratioHeight] = ratio;
	const width = ratioWidth >= ratioHeight ? size * ratioWidth / ratioHeight : size;
	const height = ratioWidth >= ratioHeight ? size : size * ratioHeight / ratioWidth;
	return [alignTo16(width), alignTo16(height)];
}

function presetDimensions(sizePreset, orientation) {
	const size = normalizeSize(sizePreset);
	const direction = normalizeOrientation(orientation);
	return SIZE_DIMENSIONS[size]?.[direction] || SIZE_DIMENSIONS[DEFAULT_VALUES.size_preset][DEFAULT_VALUES.orientation];
}

function customDimensions(node) {
	const width = readNumberWidget(node, "width", 0);
	const height = readNumberWidget(node, "height", 0);
	return width > 0 && height > 0 ? [alignTo16(width), alignTo16(height)] : null;
}

function customActive(node) {
	return Boolean(customDimensions(node));
}

function effectiveDimensions(node) {
	return customDimensions(node) || presetDimensions(readWidget(node, "size_preset"), readWidget(node, "orientation"));
}

function refreshControlSize(node) {
	const state = node?.__gjjImageBatchMultiControls;
	if (!node || !state?.widget) return;
	state.widget.computedHeight = state.widget.getHeight?.();
	requestAnimationFrame(() => {
		const currentWidth = Math.max(220, Number(node.size?.[0] || 260));
		const computed = node.computeSize?.();
		const nextHeight = Math.max(80, Number(computed?.[1] || node.size?.[1] || 80));
		node.setSize?.([currentWidth, nextHeight]);
		setDirty(node);
	});
}

function normalizeSize(value) {
	const text = String(value || "").trim().toLowerCase();
	if (text === "320" || text === "3" || text === "3️⃣") return "320";
	if (text === "480" || text === "4" || text === "4️⃣") return "480";
	if (text === "720" || text === "7" || text === "7️⃣") return "720";
	if (text === "1024" || text === "1" || text === "1️⃣") return "1024";
	if (text === "2k" || text === "2" || text === "2️⃣") return "2K";
	if (text === "4k" || text === "#" || text === "#️⃣") return "4K";
	return DEFAULT_VALUES.size_preset;
}

function normalizeOrientation(value) {
	const text = String(value || "").trim().toLowerCase();
	if (["横屏", "landscape", "horizontal", "⏩"].includes(text)) return "横屏";
	if (["竖屏", "portrait", "vertical", "⏫"].includes(text)) return "竖屏";
	if (["正方形", "square", "1:1", "🟦"].includes(text)) return "正方形";
	return DEFAULT_VALUES.orientation;
}

function normalizePrepend(value) {
	const text = String(value || "").trim().toLowerCase();
	if (["黑帧", "black", "blackframe", "◼", "◼️"].includes(text)) return "黑帧";
	if (["白帧", "white", "whiteframe", "⬜", "⬜️"].includes(text)) return "白帧";
	return DEFAULT_VALUES.prepend_frame;
}

function trimUnusedTail(node) {
	let inputs = imageInputs(node);
	while (inputs.length > MIN_INPUTS) {
		const last = inputs[inputs.length - 1];
		const prev = inputs[inputs.length - 2];
		if (last?.link != null || prev?.link != null) break;
		removeInput(node, last);
		inputs = imageInputs(node);
	}
}

function ensureTrailingEmpty(node) {
	let inputs = imageInputs(node);
	if (!inputs.length) {
		node.addInput?.(formatImageInputName(1), COMPAT_TYPE);
		inputs = imageInputs(node);
	}
	const last = inputs[inputs.length - 1];
	if (last?.link != null) {
		node.addInput?.(formatImageInputName(inputs.length + 1), COMPAT_TYPE);
	}
}

function syncLinkTargetSlots(node) {
	if (!Array.isArray(node?.inputs) || !app.graph?.links) return;
	for (let index = 0; index < node.inputs.length; index += 1) {
		const input = node.inputs[index];
		const linkId = input?.link;
		if (linkId == null) continue;
		const link = app.graph.links[linkId];
		if (!link) continue;
		link.target_id = node.id;
		link.target_slot = index;
	}
}

function connectedImageInputCount(node) {
	let lastLinkedIndex = -1;
	for (const [index, input] of imageInputs(node).entries()) {
		if (input?.link != null) lastLinkedIndex = index;
	}
	return lastLinkedIndex + 1;
}

function visibleImageInputCount(node) {
	return imageInputs(node).length;
}

function desiredImageInputCount(node) {
	const savedCount = Number(node?.properties?.[SAVED_INPUT_COUNT_PROPERTY] || 0);
	return Math.max(MIN_INPUTS, savedCount || 0, connectedImageInputCount(node) + 1);
}

function ensureImageInputCount(node, count) {
	if (!node || typeof node.addInput !== "function") return;
	const target = Math.max(MIN_INPUTS, Number.parseInt(count, 10) || MIN_INPUTS);
	let inputs = imageInputs(node);
	while (inputs.length < target) {
		node.addInput(formatImageInputName(inputs.length + 1), COMPAT_TYPE);
		inputs = imageInputs(node);
	}
	inputs.forEach((input, index) => setImageInputMeta(input, index + 1));
	syncLinkTargetSlots(node);
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const images = imageInputs(node);
	const changed = node.inputs.length !== images.length || node.inputs.some((input, index) => input !== images[index]);
	if (changed) {
		node.inputs.splice(0, node.inputs.length, ...images);
	}
	syncLinkTargetSlots(node);
}

function persistInputCount(node, serializedNode = null) {
	const count = Math.max(MIN_INPUTS, visibleImageInputCount(node), connectedImageInputCount(node) + 1);
	node.properties = node.properties || {};
	node.properties[SAVED_INPUT_COUNT_PROPERTY] = count;
	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[SAVED_INPUT_COUNT_PROPERTY] = count;
	}
	return count;
}

function serializeImageInputs(node, serializedNode) {
	if (!serializedNode) return;
	const count = persistInputCount(node, serializedNode);
	ensureImageInputCount(node, count);
	reorderInputs(node);
	const liveInputs = imageInputs(node);
	serializedNode.inputs = liveInputs.map((input, index) => ({
		name: formatImageInputName(index + 1),
		type: COMPAT_TYPE,
		link: input?.link ?? null,
		label: `图片 ${index + 1}`,
		localized_name: `图片 ${index + 1}`,
	}));
	syncLinkTargetSlots(node);
}

function restoreSerializedInputCount(node, serializedNode = null) {
	const serializedInputs = Array.isArray(serializedNode?.inputs)
		? serializedNode.inputs.filter((input) => /^image_\d+$/.test(String(input?.name || "")))
		: [];
	const savedCount = Number(serializedNode?.properties?.[SAVED_INPUT_COUNT_PROPERTY] || node?.properties?.[SAVED_INPUT_COUNT_PROPERTY] || 0);
	const connectedCount = serializedInputs.filter((input) => input?.link != null).length;
	const count = Math.max(MIN_INPUTS, savedCount || 0, serializedInputs.length, connectedCount + 1);
	node.properties = node.properties || {};
	node.properties[SAVED_INPUT_COUNT_PROPERTY] = count;
	ensureImageInputCount(node, count);
}

function applyOutputMeta(node) {
	const output = node?.outputs?.[0];
	if (!output) return;
	output.name = "批量图像";
	output.label = "批量图像";
	output.localized_name = "批量图像";
	output.type = COMPAT_TYPE;
	output.tooltip = "兼容 GJJ 批量图片和普通 IMAGE batch 的输出。";
}

function setDirty(node) {
	globalThis.GJJApplyTypeColorsToNode?.(node);
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function stopCanvasEvent(event) {
	event?.preventDefault?.();
	event?.stopPropagation?.();
}

function clearStaleCanvasDrag(event) {
	if (event?.buttons) {
		return;
	}
	const canvas = app.canvas;
	if (!canvas) {
		return;
	}
	canvas.node_dragged = null;
	canvas.dragging_rectangle = null;
}

function stopAndClearCanvasEvent(event) {
	clearStaleCanvasDrag(event);
	stopCanvasEvent(event);
}

function shieldControlEvents(element) {
	if (!element || element.__gjjImageBatchMultiShielded) {
		return;
	}
	element.__gjjImageBatchMultiShielded = true;
	for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, stopCanvasEvent);
	}
	element.addEventListener("pointerenter", clearStaleCanvasDrag);
	element.addEventListener("mouseenter", clearStaleCanvasDrag);
	element.addEventListener("pointermove", stopAndClearCanvasEvent);
	element.addEventListener("mousemove", stopAndClearCanvasEvent);
	element.addEventListener("pointerleave", clearStaleCanvasDrag);
	element.addEventListener("mouseleave", clearStaleCanvasDrag);
}

function shieldInputEvents(element) {
	if (!element || element.__gjjImageBatchMultiInputShielded) {
		return;
	}
	element.__gjjImageBatchMultiInputShielded = true;
	for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu", "wheel", "keydown", "keyup", "input", "change"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

function updateCustomDimensionInputs(state) {
	if (!state?.customSizeInput || !state?.customRatioInput || !state?.customWidthInput || !state?.customHeightInput) return;
	const dims = dimensionsFromSizeRatio(state.customSizeInput.value, state.customRatioInput.value);
	if (!dims) return;
	state.customWidthInput.value = String(dims[0]);
	state.customHeightInput.value = String(dims[1]);
}

function populateCustomPanel(node) {
	const state = node.__gjjImageBatchMultiControls;
	if (!state) return;
	const dims = effectiveDimensions(node);
	const width = alignTo16(dims[0]);
	const height = alignTo16(dims[1]);
	const storedSize = readNumberWidget(node, "custom_size", 0);
	const storedRatio = String(readWidget(node, "custom_ratio") || "").trim();
	const active = customActive(node);
	state.customSizeInput.value = String(storedSize > 0 && active ? alignTo16(storedSize) : Math.min(width, height));
	state.customRatioInput.value = active && storedRatio ? storedRatio : ratioTextFromDimensions(width, height);
	state.customWidthInput.value = String(width);
	state.customHeightInput.value = String(height);
}

function setCustomPanelOpen(node, open) {
	const state = node?.__gjjImageBatchMultiControls;
	if (!state?.customPanel) return;
	if (open) populateCustomPanel(node);
	state.customPanel.hidden = !open;
	state.customButton?.classList.toggle("open", open);
	refreshControlSize(node);
}

function exitCustomMode(node, refreshSize = true) {
	writeWidget(node, "width", 0);
	writeWidget(node, "height", 0);
	writeWidget(node, "custom_size", 0);
	writeWidget(node, "custom_ratio", DEFAULT_VALUES.custom_ratio);
	const state = node?.__gjjImageBatchMultiControls;
	if (state?.customPanel) {
		state.customPanel.hidden = true;
		state.customButton?.classList.remove("open");
	}
	if (refreshSize) refreshControlSize(node);
}

function applyCustomSettings(node) {
	const state = node.__gjjImageBatchMultiControls;
	if (!state) return;
	const ratioText = String(state.customRatioInput.value || DEFAULT_VALUES.custom_ratio).trim() || DEFAULT_VALUES.custom_ratio;
	const ratioDims = dimensionsFromSizeRatio(state.customSizeInput.value, ratioText);
	const directWidth = Number(state.customWidthInput.value);
	const directHeight = Number(state.customHeightInput.value);
	if (!ratioDims && !(directWidth > 0 && directHeight > 0)) {
		alert("自定义比例格式不正确，请填写类似 16:9、9:16、1:1 或 1.777。");
		return;
	}
	const width = alignTo16(directWidth || ratioDims[0]);
	const height = alignTo16(directHeight || ratioDims[1]);
	writeWidget(node, "width", width);
	writeWidget(node, "height", height);
	writeWidget(node, "custom_size", ratioDims ? alignTo16(state.customSizeInput.value) : Math.min(width, height));
	writeWidget(node, "custom_ratio", ratioDims ? ratioText : ratioTextFromDimensions(width, height));
	setCustomPanelOpen(node, false);
	syncControlButtons(node);
	setDirty(node);
}

function clearCustomSettings(node) {
	exitCustomMode(node);
	syncControlButtons(node);
	setDirty(node);
}

function syncControlButtons(node) {
	const state = node.__gjjImageBatchMultiControls;
	if (!state) return;
	const selectedSize = normalizeSize(readWidget(node, "size_preset"));
	const selectedOrientation = normalizeOrientation(readWidget(node, "orientation"));
	const selectedPrepend = normalizePrepend(readWidget(node, "prepend_frame"));
	const selectedCustom = customActive(node);
	for (const item of state.buttons) {
		const active =
			(item.group === "size_preset" && !selectedCustom && item.value === selectedSize) ||
			(item.group === "orientation" && !selectedCustom && item.value === selectedOrientation) ||
			(item.group === "prepend_frame" && item.value === selectedPrepend);
		item.button.classList.toggle("on", active);
	}
	state.customButton?.classList.toggle("on", selectedCustom);
	if (state.summary) {
		const frameText = selectedPrepend === "无" ? "无帧" : selectedPrepend;
		if (selectedCustom) {
			const [width, height] = customDimensions(node);
			const ratio = String(readWidget(node, "custom_ratio") || ratioTextFromDimensions(width, height)).trim();
			state.summary.textContent = `${frameText} 自定 ${width}x${height}`;
			state.summary.title = `当前组合：自定义尺寸 ${width} x ${height}，比例 ${ratio}。点击 ⚙️ 可修改；清除后恢复尺寸档位和画幅方向。`;
		} else {
			state.summary.textContent = `${frameText} ${selectedSize} ${selectedOrientation}`;
			state.summary.title = `当前组合：${selectedSize} / ${selectedOrientation} / ${selectedPrepend === "无" ? "不添加前置帧" : `前置${selectedPrepend}`}。按钮同组互斥，黑白帧再次点击可取消。`;
		}
	}
}

function addButton(node, wrap, state, group, option) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-ibm-btn";
	const icon = document.createElement("span");
	icon.className = "gjj-ibm-icon";
	icon.textContent = option.emoji;
	button.appendChild(icon);
	button.title = option.tooltip;
	shieldControlEvents(button);
	button.addEventListener("click", (event) => {
		stopCanvasEvent(event);
		if (group === "size_preset" || group === "orientation") {
			exitCustomMode(node, false);
		}
		if (group === "prepend_frame" && normalizePrepend(readWidget(node, group)) === option.value) {
			writeWidget(node, group, DEFAULT_VALUES.prepend_frame);
		} else {
			writeWidget(node, group, option.value);
		}
		syncControlButtons(node);
		if (group === "size_preset" || group === "orientation") refreshControlSize(node);
		setDirty(node);
	});
	wrap.appendChild(button);
	state.buttons.push({ group, value: option.value, button });
}

function addSeparator(wrap) {
	const sep = document.createElement("span");
	sep.className = "gjj-ibm-sep";
	sep.textContent = "|";
	wrap.appendChild(sep);
}

function makeCustomField(label, input) {
	const field = document.createElement("label");
	field.className = "gjj-ibm-custom-field";
	const text = document.createElement("span");
	text.textContent = label;
	input.className = "gjj-ibm-custom-input";
	shieldInputEvents(input);
	field.append(text, input);
	return field;
}

function makeMiniButton(text, title, className, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `gjj-ibm-mini${className ? ` ${className}` : ""}`;
	button.textContent = text;
	button.title = title;
	shieldControlEvents(button);
	button.addEventListener("click", (event) => {
		stopCanvasEvent(event);
		onClick?.();
	});
	return button;
}

function buildCustomPanel(node, state) {
	const panel = document.createElement("div");
	panel.className = "gjj-ibm-custom-panel";
	panel.hidden = true;

	const sizeInput = document.createElement("input");
	sizeInput.type = "number";
	sizeInput.min = "16";
	sizeInput.max = "8192";
	sizeInput.step = "16";
	sizeInput.title = "自定义尺寸：作为短边；正方形时作为边长。";

	const ratioInput = document.createElement("input");
	ratioInput.type = "text";
	ratioInput.placeholder = "16:9";
	ratioInput.title = "自定义比例：支持 16:9、9:16、1:1、4:3、1.777。";

	const widthInput = document.createElement("input");
	widthInput.type = "number";
	widthInput.min = "16";
	widthInput.max = "8192";
	widthInput.step = "16";
	widthInput.title = "最终宽度，会自动对齐到 16。也可直接修改。";

	const heightInput = document.createElement("input");
	heightInput.type = "number";
	heightInput.min = "16";
	heightInput.max = "8192";
	heightInput.step = "16";
	heightInput.title = "最终高度，会自动对齐到 16。也可直接修改。";

	state.customSizeInput = sizeInput;
	state.customRatioInput = ratioInput;
	state.customWidthInput = widthInput;
	state.customHeightInput = heightInput;

	const syncPreview = () => updateCustomDimensionInputs(state);
	sizeInput.addEventListener("input", syncPreview);
	ratioInput.addEventListener("input", syncPreview);
	for (const input of [widthInput, heightInput]) {
		input.addEventListener("change", () => {
			input.value = String(alignTo16(input.value));
		});
	}

	const actions = document.createElement("div");
	actions.className = "gjj-ibm-custom-actions";
	actions.append(
		makeMiniButton("应用", "应用自定义尺寸和比例", "primary", () => applyCustomSettings(node)),
		makeMiniButton("清除", "清除自定义尺寸，恢复图标档位和方向", "", () => clearCustomSettings(node)),
		makeMiniButton("收起", "只收起设置面板，不改当前配置", "", () => setCustomPanelOpen(node, false)),
	);

	panel.append(
		makeCustomField("尺寸", sizeInput),
		makeCustomField("比例", ratioInput),
		makeCustomField("宽", widthInput),
		makeCustomField("高", heightInput),
		actions,
	);
	return panel;
}

function ensureControls(node) {
	if (!node || node.__gjjImageBatchMultiControls || typeof node.addDOMWidget !== "function") {
		syncControlButtons(node);
		return;
	}
	injectStyles();
	const wrap = document.createElement("div");
	wrap.className = "gjj-ibm-controls";
	shieldControlEvents(wrap);
	const state = { buttons: [] };

	for (const option of PREPEND_OPTIONS) addButton(node, wrap, state, "prepend_frame", option);
	addSeparator(wrap);
	for (const option of SIZE_OPTIONS) addButton(node, wrap, state, "size_preset", option);
	addSeparator(wrap);
	for (const option of ORIENTATION_OPTIONS) addButton(node, wrap, state, "orientation", option);
	const customButton = document.createElement("button");
	customButton.type = "button";
	customButton.className = "gjj-ibm-btn";
	const customIcon = document.createElement("span");
	customIcon.className = "gjj-ibm-icon";
	customIcon.textContent = "⚙️";
	customButton.appendChild(customIcon);
	customButton.title = "自定义尺寸 / 比例。应用后会覆盖图标档位和方向；清除后恢复档位。";
	shieldControlEvents(customButton);
	customButton.addEventListener("click", (event) => {
		stopCanvasEvent(event);
		setCustomPanelOpen(node, state.customPanel?.hidden !== false);
	});
	wrap.appendChild(customButton);
	state.customButton = customButton;
	const summary = document.createElement("span");
	summary.className = "gjj-ibm-summary";
	summary.textContent = "";
	wrap.appendChild(summary);
	state.summary = summary;
	const customPanel = buildCustomPanel(node, state);
	wrap.appendChild(customPanel);
	state.customPanel = customPanel;

	const widget = node.addDOMWidget(CONTROL_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(30, Math.ceil(wrap.scrollHeight || wrap.offsetHeight || 28) + 4),
	});
	state.widget = widget;
	state.wrap = wrap;
	node.__gjjImageBatchMultiControls = state;
	syncControlButtons(node);
}

function stabilize(node) {
	if (!isTarget(node)) return;
	ensureBackingWidgets(node);
	hideNativeWidgets(node);
	ensureControls(node);
	removeInternalWidgetInputs(node);
	ensureImageInputCount(node, desiredImageInputCount(node));
	trimUnusedTail(node);
	ensureTrailingEmpty(node);
	imageInputs(node).forEach((input, index) => setImageInputMeta(input, index + 1));
	reorderInputs(node);
	applyOutputMeta(node);
	persistInputCount(node);
	node.__gjjImageBatchMultiSignature = currentSignature(node);
	setDirty(node);
}

function scheduleStabilize(node, delay = 32) {
	if (!isTarget(node)) return;
	clearTimeout(node.__gjjImageBatchMultiTimer);
	node.__gjjImageBatchMultiTimer = setTimeout(() => stabilize(node), delay);
}

function currentSignature(node) {
	return [
		...imageInputs(node).map((input) => `${input.name}:${input.link ?? ""}`),
		`size:${normalizeSize(readWidget(node, "size_preset"))}`,
		`orient:${normalizeOrientation(readWidget(node, "orientation"))}`,
		`prepend:${normalizePrepend(readWidget(node, "prepend_frame"))}`,
		`custom:${readNumberWidget(node, "width", 0)}x${readNumberWidget(node, "height", 0)}:${readNumberWidget(node, "custom_size", 0)}:${readWidget(node, "custom_ratio")}`,
	].join("|");
}

app.registerExtension({
	name: "GJJ.ImageBatchMulti.DynamicInputs",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			scheduleStabilize(this, 80);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			restoreSerializedInputCount(this, serializedNode);
			scheduleStabilize(this, 0);
			scheduleStabilize(this, 80);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			stabilize(this);
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			serializeImageInputs(this, serializedNode);
			return result;
		};

		const originalDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalDrawBackground?.apply(this, args);
			const signature = currentSignature(this);
			if (signature !== this.__gjjImageBatchMultiSignature) {
				this.__gjjImageBatchMultiSignature = signature;
				scheduleStabilize(this, 0);
			}
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (isTarget(node)) {
				scheduleStabilize(node, 0);
			}
		}
	},
});

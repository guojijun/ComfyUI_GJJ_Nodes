import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_Qwen2511EditOutpaint"]);
const STATUS_WIDGET_NAME = "gjj_qwen2511_edit_outpaint_status";
const PARAMS_WIDGET_NAME = "gjj_qwen2511_edit_outpaint_params";
const LAYOUT_WIDGET_NAME = "layout_mode";
const PRIMARY_IMAGE_INPUT_NAME = "image";
const PRIMARY_IMAGE_INPUT_LABEL = "批量图片";
const BATCH_OUTPUT_LABEL = "批量图片";
const LEGACY_RESULT_OUTPUT_LABEL = "最终生成图像";
const SINGLE_OUTPUT_PREFIX = "输入 ";
const MAX_DYNAMIC_IMAGE_OUTPUTS = 20;
const PRIMARY_IMAGE_PREFERRED_NODE = "GJJ_MultiImageLoader";
const PRIMARY_IMAGE_PREFERRED_SEARCH = "多图片加载预览器";
const RESULT_OUTPUT_PREFERRED_NODE = "GJJ_AnyPreview";
const RESULT_OUTPUT_PREFERRED_SEARCH = "任意对象预览器";
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const TARGET_MODE_VALUE = "按目标尺寸扩图";
const EDGE_MODE_VALUE = "按四边像素扩图";
const TARGET_ONLY_WIDGETS = ["target_width", "target_height", "expand_method", "original_ratio", "expand_direction"];
const EDGE_ONLY_WIDGETS = ["left", "top", "right", "bottom"];
const FEATHER_WIDGET_NAME = "feathering";
const AFTER_GENERATE_WIDGET_NAME = "control_after_generate";
const PARAM_LABELS = {
	target_width: "目标宽度",
	target_height: "目标高度",
	expand_method: "扩图方式",
	original_ratio: "原图占比",
	expand_direction: "扩图方向",
	left: "左扩",
	top: "上扩",
	right: "右扩",
	bottom: "下扩",
};

function getNodeClassName(node) {
	return String(node?.comfyClass || node?.type || "");
}

function getSlotText(slot) {
	return String(slot?.localized_name || slot?.label || slot?.name || "").trim();
}

function resolveSlotRef(node, slotRef, isOutput) {
	if (!node) {
		return { slot: null, index: -1, type: "*" };
	}
	if (typeof slotRef === "number") {
		const list = isOutput ? node.outputs : node.inputs;
		const slot = list?.[slotRef] || null;
		return {
			slot,
			index: slotRef,
			type: String(slot?.type || "*"),
		};
	}
	if (typeof slotRef === "string") {
		const index = isOutput ? node.findOutputSlot?.(slotRef, false) : node.findInputSlot?.(slotRef, false);
		const list = isOutput ? node.outputs : node.inputs;
		const slot = index >= 0 ? list?.[index] || null : null;
		return {
			slot,
			index,
			type: String(slot?.type || "*"),
		};
	}
	const slot = slotRef || null;
	const index = slot
		? (isOutput ? node.findOutputSlot?.(slot.name, false) : node.findInputSlot?.(slot.name, false))
		: -1;
	return {
		slot,
		index,
		type: String(slot?.type || "*"),
	};
}

function clampImageCount(count) {
	return Math.max(1, Math.min(MAX_DYNAMIC_IMAGE_OUTPUTS, Number.parseInt(count, 10) || 1));
}

function parseSelectedImageCount(node) {
	const state = node?.__gjjMultiImageState;
	const selectedCount = Array.isArray(state?.selection) ? state.selection.length : 0;
	const externalCount = Number(state?.externalCount || 0);
	const mergedCount = Number(state?.mergedCount || 0);
	if (mergedCount > 0) {
		return clampImageCount(mergedCount);
	}
	if (selectedCount + externalCount > 0) {
		return clampImageCount(selectedCount + externalCount);
	}
	const widget = node?.widgets?.find((item) => item?.name === "selected_images");
	const rawValue = widget?.value ?? node?.properties?.selected_images;
	if (rawValue == null || String(rawValue || "").trim() === "") {
		return 0;
	}
	try {
		const parsed = JSON.parse(String(rawValue));
		return Array.isArray(parsed) ? clampImageCount(parsed.length) : 0;
	} catch (error) {
		return 0;
	}
}

function getHighestLinkedSingleOutput(node) {
	let highest = 0;
	for (let index = 1; index < (node?.outputs?.length || 0); index += 1) {
		const output = node.outputs[index];
		if (Array.isArray(output?.links) && output.links.some((link) => link != null)) {
			highest = index;
		}
	}
	return highest;
}

function getPrimaryImageInput(node) {
	return node?.inputs?.find((input) => String(input?.name || "") === PRIMARY_IMAGE_INPUT_NAME) || null;
}

function getPrimaryImageLinkInfo(node) {
	const input = getPrimaryImageInput(node);
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return { input, linkId: 0, sourceNode: null, sourceSlot: null, sourceSlotIndex: -1 };
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const sourceSlotIndex = Number.isInteger(link?.origin_slot) ? link.origin_slot : -1;
	const sourceSlot = sourceNode?.outputs?.[sourceSlotIndex] || null;
	return { input, linkId, sourceNode, sourceSlot, sourceSlotIndex };
}

function estimateOutputCountFromInput(node) {
	const { sourceNode, sourceSlotIndex } = getPrimaryImageLinkInfo(node);
	if (!sourceNode) {
		return 1;
	}
	const sourceClass = getNodeClassName(sourceNode);
	if (sourceClass === PRIMARY_IMAGE_PREFERRED_NODE && sourceSlotIndex === 0) {
		const selectedCount = parseSelectedImageCount(sourceNode);
		if (selectedCount > 0) {
			return selectedCount;
		}
		return clampImageCount(Math.min(MAX_DYNAMIC_IMAGE_OUTPUTS, Math.max(1, (sourceNode.outputs?.length || 2) - 1)));
	}
	if (TARGET_NODES.has(sourceClass) && sourceSlotIndex === 0) {
		return clampImageCount(sourceNode.__gjjQwen2511OutputCount || ((sourceNode.outputs?.length || 1) - 1));
	}
	return 1;
}

function getDesiredOutputCount(node) {
	const storedRaw = Number.parseInt(node?.__gjjQwen2511OutputCount, 10);
	const stored = storedRaw > 0 ? clampImageCount(storedRaw) : 0;
	const estimated = estimateOutputCountFromInput(node);
	const linkedHighest = getHighestLinkedSingleOutput(node);
	let desired = Math.max(1, stored || 0, estimated || 0, linkedHighest || 0);
	if (linkedHighest >= desired && desired < MAX_DYNAMIC_IMAGE_OUTPUTS) {
		desired += 1;
	}
	return clampImageCount(desired);
}

function ensureOutputs(node, count) {
	const imageCount = clampImageCount(count);
	const visibleCount = imageCount + 1;
	while ((node.outputs?.length || 0) < visibleCount) {
		const outputIndex = node.outputs?.length || 0;
		if (outputIndex === 0) {
			node.addOutput?.(BATCH_OUTPUT_LABEL, BATCH_IMAGE_TYPE);
			continue;
		}
		node.addOutput?.(`${SINGLE_OUTPUT_PREFIX}${outputIndex}`, "IMAGE");
	}
	while ((node.outputs?.length || 0) > visibleCount) {
		const lastIndex = node.outputs.length - 1;
		const output = node.outputs[lastIndex];
		if (lastIndex === 0) {
			break;
		}
		if (Array.isArray(output?.links) && output.links.length > 0) {
			break;
		}
		node.removeOutput?.(lastIndex);
	}
}

function getConnectionSignature(node) {
	const inputSig = (node?.inputs || []).map((input) => `${input?.name || ""}:${input?.link || 0}`).join("|");
	const outputSig = (node?.outputs || []).map((output, index) => `${index}:${Array.isArray(output?.links) ? output.links.join(",") : ""}`).join("|");
	return `${inputSig}=>${outputSig}|desired:${getDesiredOutputCount(node)}`;
}

function resolvePreferredNodeConfig(opts) {
	const isFrom = opts?.nodeFrom && opts?.slotFrom != null;
	const isTo = !isFrom && opts?.nodeTo && opts?.slotTo != null;
	if (isTo && TARGET_NODES.has(getNodeClassName(opts.nodeTo))) {
		const { slot, type } = resolveSlotRef(opts.nodeTo, opts.slotTo, false);
		const slotText = getSlotText(slot);
		if (String(slot?.name || "") === PRIMARY_IMAGE_INPUT_NAME || slotText === PRIMARY_IMAGE_INPUT_LABEL) {
			return {
				nodeName: PRIMARY_IMAGE_PREFERRED_NODE,
				searchText: PRIMARY_IMAGE_PREFERRED_SEARCH,
				slotType: type || "IMAGE",
				direction: "out",
			};
		}
	}
	if (isFrom && TARGET_NODES.has(getNodeClassName(opts.nodeFrom))) {
		const { slot, type, index } = resolveSlotRef(opts.nodeFrom, opts.slotFrom, true);
		if (String(type || "*") === "IMAGE" || (index === 0 && String(type || "*") === BATCH_IMAGE_TYPE)) {
			return {
				nodeName: RESULT_OUTPUT_PREFERRED_NODE,
				searchText: RESULT_OUTPUT_PREFERRED_SEARCH,
				slotType: type || "IMAGE",
				direction: "in",
			};
		}
	}
	return null;
}

function withTemporaryPreferredDefault(config, callback) {
	if (!config?.slotType || !config?.nodeName) {
		return callback();
	}
	const map = config.direction === "in" ? LiteGraph.slot_types_default_in : LiteGraph.slot_types_default_out;
	if (!map) {
		return callback();
	}
	const slotType = String(config.slotType || "*");
	const existing = map[slotType];
	const list = Array.isArray(existing)
		? [...existing]
		: (existing ? [existing] : []);
	const filtered = list.filter((item) => {
		const name = typeof item === "string" ? item : String(item?.node || "");
		return name !== config.nodeName;
	});
	map[slotType] = [config.nodeName, ...filtered];
	try {
		return callback();
	} finally {
		if (existing === undefined) {
			delete map[slotType];
		} else {
			map[slotType] = existing;
		}
	}
}

function primePreferredSearchBox(searchText) {
	if (!searchText) {
		return;
	}
	requestAnimationFrame(() => {
		const inputs = [...document.querySelectorAll('input[placeholder*="添加节点"], input[placeholder*="Add"]')];
		const input = inputs.at(-1);
		if (!input || String(input.value || "").trim()) {
			return;
		}
		input.value = String(searchText);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.select?.();
	});
}

function createPreferredNodeForSlot(canvas, opts, config) {
	if (!canvas || !opts || !config?.nodeName) {
		return false;
	}
	const graph = canvas.graph || app.graph;
	if (!graph) {
		return false;
	}
	const isFrom = opts.nodeFrom && opts.slotFrom != null;
	const isTo = !isFrom && opts.nodeTo && opts.slotTo != null;
	if (!isFrom && !isTo) {
		return false;
	}
	const newNode = LiteGraph.createNode(config.nodeName);
	if (!newNode) {
		return false;
	}
	if (config.nodeName === RESULT_OUTPUT_PREFERRED_NODE && (!newNode.inputs || newNode.inputs.length === 0)) {
		newNode.addInput?.("any_01", "*");
	}
	graph.add(newNode);
	const position = Array.isArray(opts.position) && opts.position.length >= 2
		? opts.position
		: [opts.e?.canvasX || 0, opts.e?.canvasY || 0];
	newNode.pos = [position[0], position[1]];

	if (isFrom) {
		const { index, type } = resolveSlotRef(opts.nodeFrom, opts.slotFrom, true);
		if (index < 0) {
			return false;
		}
		opts.nodeFrom.connectByType?.(index, newNode, type || config.slotType || "*");
	} else {
		const { index, type } = resolveSlotRef(opts.nodeTo, opts.slotTo, false);
		if (index < 0) {
			return false;
		}
		if (config.nodeName === PRIMARY_IMAGE_PREFERRED_NODE && typeof newNode.connect === "function") {
			const connected = newNode.connect(0, opts.nodeTo, index);
			if (!connected) {
				opts.nodeTo.connectByTypeOutput?.(index, newNode, type || config.slotType || "*");
			}
		} else {
			opts.nodeTo.connectByTypeOutput?.(index, newNode, type || config.slotType || "*");
		}
	}

	app.canvas?.selectNode?.(newNode, false);
	graph.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	return true;
}

function syncSlotLabels(node) {
	if (!node) {
		return;
	}
	const primaryInput = getPrimaryImageInput(node);
	if (primaryInput) {
		primaryInput.name = PRIMARY_IMAGE_INPUT_NAME;
		primaryInput.label = PRIMARY_IMAGE_INPUT_LABEL;
		primaryInput.localized_name = PRIMARY_IMAGE_INPUT_LABEL;
		primaryInput.type = BATCH_IMAGE_TYPE;
	}
	(node.outputs || []).forEach((output, index) => {
		if (index === 0) {
			output.name = BATCH_OUTPUT_LABEL;
			output.label = BATCH_OUTPUT_LABEL;
			output.localized_name = BATCH_OUTPUT_LABEL;
			output.type = BATCH_IMAGE_TYPE;
			output.tooltip = "将全部外扩结果按顺序打包成一个 GJJ 专用批量图片输出。";
			return;
		}
		const label = `${SINGLE_OUTPUT_PREFIX}${index}`;
		output.name = label;
		output.label = label;
		output.localized_name = label;
		output.type = "IMAGE";
		output.tooltip = `第 ${index} 张外扩结果的单图输出；命名与任意对象预览器输入风格对齐。`;
	});
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	ensureOutputs(node, getDesiredOutputCount(node));
	syncSlotLabels(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node?.__gjjQwen2511StabilizeTimer);
	node.__gjjQwen2511StabilizeTimer = setTimeout(() => stabilizeNode(node), ms);
}

function stabilizeExistingTargetNodes(ms = 0) {
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			continue;
		}
		patchNode(node);
		scheduleStabilize(node, ms);
	}
}

function moveWidgetBefore(node, widgetName, beforeName) {
	if (!node?.widgets?.length) {
		return;
	}
	const fromIndex = node.widgets.findIndex((widget) => widget?.name === widgetName);
	const toIndex = node.widgets.findIndex((widget) => widget?.name === beforeName);
	if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
		return;
	}
	const [widget] = node.widgets.splice(fromIndex, 1);
	const adjustedIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
	node.widgets.splice(adjustedIndex, 0, widget);
}

function moveWidgetAfter(node, widgetName, afterName) {
	if (!node?.widgets?.length) {
		return;
	}
	const fromIndex = node.widgets.findIndex((widget) => widget?.name === widgetName);
	const afterIndex = node.widgets.findIndex((widget) => widget?.name === afterName);
	if (fromIndex === -1 || afterIndex === -1 || fromIndex === afterIndex) {
		return;
	}
	const [widget] = node.widgets.splice(fromIndex, 1);
	const adjustedIndex = fromIndex < afterIndex ? afterIndex : afterIndex + 1;
	node.widgets.splice(adjustedIndex, 0, widget);
}

function shieldDomEvents(element) {
	if (!element || element.__gjjQwen2511EventShield) {
		return;
	}
	element.__gjjQwen2511EventShield = true;
	const stopCanvasCapture = (event) => event.stopPropagation();
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, stopCanvasCapture);
	}
}

function isActuallyVisibleWidget(widget) {
	if (!widget || widget.hidden) {
		return false;
	}
	if (String(widget.type || "").startsWith("converted-widget:")) {
		return false;
	}
	return true;
}

function getWidgetHeight(widget, node) {
	if (!widget) {
		return 0;
	}
	try {
		const size = widget.computeSize?.(node?.size?.[0] || 0);
		if (Array.isArray(size)) {
			return Math.max(0, Number(size[1] || 0));
		}
	} catch (error) {
		// noop
	}
	if (widget.name === PARAMS_WIDGET_NAME) {
		return getCurrentLayoutMode(node) === TARGET_MODE_VALUE ? 194 : 156;
	}
	if (widget.name === STATUS_WIDGET_NAME) {
		return 42;
	}
	if (widget.name === "gjj_qwen2511_layout_buttons") {
		return 38;
	}
	return 28;
}

function computeCompactHeight(node, fallbackHeight) {
	let bottom = 0;
	for (const widget of node.widgets || []) {
		if (!isActuallyVisibleWidget(widget)) {
			continue;
		}
		const y = Number(widget.last_y || widget.y || 0);
		const h = getWidgetHeight(widget, node);
		bottom = Math.max(bottom, y + h);
	}
	if (bottom <= 0) {
		return fallbackHeight;
	}
	return Math.max(140, Math.ceil(bottom + 18));
}

function getDomHideTargets(widget) {
	const seeds = [widget?.element, widget?.inputEl].filter(Boolean);
	const targets = [];
	const seen = new Set();
	const addTarget = (element) => {
		if (!element || seen.has(element)) {
			return;
		}
		seen.add(element);
		targets.push(element);
	};

	for (const seed of seeds) {
		addTarget(seed);
		let current = seed.parentElement;
		let depth = 0;
		while (current && depth < 4) {
			const className = String(current.className || "");
			const tagName = String(current.tagName || "").toUpperCase();
			const looksLikeWidgetRow =
				/widget|property|row|control|field|input/i.test(className) ||
				tagName === "LABEL" ||
				tagName === "LI";
			if (looksLikeWidgetRow) {
				addTarget(current);
			}
			current = current.parentElement;
			depth += 1;
		}
	}
	return targets;
}

function createRow(labelText) {
	const row = document.createElement("div");
	row.style.cssText = [
		"display:flex",
		"align-items:center",
		"gap:8px",
	].join(";");

	const label = document.createElement("div");
	label.textContent = labelText;
	label.style.cssText = [
		"flex:0 0 72px",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.2",
		"white-space:nowrap",
	].join(";");

	const controlWrap = document.createElement("div");
	controlWrap.style.cssText = [
		"flex:1 1 auto",
		"display:flex",
	].join(";");

	row.appendChild(label);
	row.appendChild(controlWrap);
	return { row, controlWrap };
}

function styleControl(control) {
	control.style.cssText = [
		"width:100%",
		"min-height:30px",
		"padding:4px 10px",
		"border-radius:10px",
		"border:1px solid #41535b",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"box-sizing:border-box",
	].join(";");
}

function syncCustomControlFromWidget(control, widget) {
	if (!control || !widget) {
		return;
	}
	if (control.tagName === "SELECT") {
		control.value = String(widget.value ?? "");
		return;
	}
	control.value = String(widget.value ?? "");
}

function createControlForWidget(node, widgetName) {
	const widget = GJJ_Utils.getWidget(node, widgetName);
	if (!widget) {
		return null;
	}
	const values = Array.isArray(widget?.options?.values) ? widget.options.values.map((item) => String(item)) : null;
	let control = null;
	if (values?.length) {
		control = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			control.appendChild(option);
		}
	} else {
		control = document.createElement("input");
		control.type = "number";
		control.step = widgetName === "original_ratio" ? "0.01" : "1";
		if (widgetName === "original_ratio") {
			control.min = "0.1";
			control.max = "1.0";
		} else {
			control.min = "0";
		}
	}
	styleControl(control);
	shieldDomEvents(control);
	syncCustomControlFromWidget(control, widget);
	const commit = () => {
		const value = control.tagName === "SELECT"
			? control.value
			: (widgetName === "original_ratio" ? Number.parseFloat(control.value || "0") : Number.parseInt(control.value || "0", 10));
		setWidgetValue(widget, value);
		GJJ_Utils.refreshNode(node);
	};
	control.addEventListener("change", commit);
	control.addEventListener("input", () => {
		if (control.tagName !== "SELECT") {
			setWidgetValue(widget, widgetName === "original_ratio" ? Number.parseFloat(control.value || "0") : Number.parseInt(control.value || "0", 10));
		}
	});
	return control;
}

function hideWidget(widget, useConvertedType = false) {
	if (!widget || widget.__gjjHidden) {
		return;
	}
	widget.__gjjHidden = true;
	widget.__gjjOriginalType = widget.type;
	widget.__gjjOriginalHasOwnComputeSize = Object.prototype.hasOwnProperty.call(widget, "computeSize");
	widget.__gjjOriginalComputeSize = widget.computeSize;
	widget.__gjjOriginalHasOwnDraw = Object.prototype.hasOwnProperty.call(widget, "draw");
	widget.__gjjOriginalDraw = widget.draw;
	if (useConvertedType) {
		widget.type = `converted-widget:${widget.name || "hidden"}`;
	}
	widget.computeSize = () => [0, -4];
	widget.draw = () => {};
	widget.hidden = true;
	widget.__gjjDomHideTargets = getDomHideTargets(widget);
	for (const element of widget.__gjjDomHideTargets) {
		if (!element.__gjjOriginalDisplayStored) {
			element.__gjjOriginalDisplayStored = true;
			element.__gjjOriginalDisplay = element.style.display;
		}
		element.style.display = "none";
	}
}

function showWidget(widget) {
	if (!widget || !widget.__gjjHidden) {
		return;
	}
	widget.__gjjHidden = false;
	widget.type = widget.__gjjOriginalType || widget.type;
	if (widget.__gjjOriginalHasOwnComputeSize) {
		widget.computeSize = widget.__gjjOriginalComputeSize;
	} else {
		delete widget.computeSize;
	}
	if (widget.__gjjOriginalHasOwnDraw) {
		widget.draw = widget.__gjjOriginalDraw;
	} else {
		delete widget.draw;
	}
	widget.hidden = false;
	for (const element of widget.__gjjDomHideTargets || []) {
		if (element.__gjjOriginalDisplayStored) {
			element.style.display = element.__gjjOriginalDisplay || "";
		} else {
			element.style.display = "";
		}
	}
}

function setWidgetValue(widget, value) {
	if (!widget) {
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
		widget.inputEl.style.pointerEvents = enabled ? "" : "none";
	}
	if (widget.element && "disabled" in widget.element) {
		widget.element.disabled = !enabled;
		widget.element.style.opacity = opacity;
		widget.element.style.pointerEvents = enabled ? "" : "none";
	}
	for (const element of getDomHideTargets(widget)) {
		if (!element) {
			continue;
		}
		element.style.opacity = opacity;
	}
}

function ensureLayoutWidget(node) {
	return GJJ_Utils.getWidget(node, LAYOUT_WIDGET_NAME);
}

function getCurrentLayoutMode(node) {
	const stored = String(node?.__gjjLayoutModeValue || "").trim();
	if (stored) {
		return stored;
	}
	const widget = ensureLayoutWidget(node);
	const widgetValue = String(widget?.value || "").trim();
	if (widgetValue) {
		return widgetValue;
	}
	const propertyValue = String(node?.properties?.[LAYOUT_WIDGET_NAME] || "").trim();
	if (propertyValue) {
		return propertyValue;
	}
	return TARGET_MODE_VALUE;
}

function updateLayoutButtons(node) {
	const state = node.__gjjQwen2511LayoutButtons;
	if (!state) {
		return;
	}
	const activeValue = getCurrentLayoutMode(node);
	for (const [value, button] of state.buttons.entries()) {
		const active = value === activeValue;
		button.style.background = active ? "#27404a" : "#172026";
		button.style.borderColor = active ? "#5d95a6" : "#314047";
		button.style.color = active ? "#eff7fb" : "#dce7e2";
	}
}

function updateLayoutModeVisibility(node) {
	const layoutWidget = ensureLayoutWidget(node);
	if (!layoutWidget) {
		return;
	}
	const layoutMode = getCurrentLayoutMode(node);
	node.__gjjLayoutModeValue = layoutMode;
	layoutWidget.value = layoutMode;
	if (layoutWidget.inputEl) {
		layoutWidget.inputEl.value = String(layoutMode);
	}
	if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, LAYOUT_WIDGET_NAME)) {
		node.properties[LAYOUT_WIDGET_NAME] = layoutMode;
	}
	hideWidget(layoutWidget, true);
	for (const name of TARGET_ONLY_WIDGETS) {
		const widget = GJJ_Utils.getWidget(node, name);
		showWidget(widget);
		setWidgetEnabled(widget, layoutMode === TARGET_MODE_VALUE);
	}
	for (const name of EDGE_ONLY_WIDGETS) {
		const widget = GJJ_Utils.getWidget(node, name);
		showWidget(widget);
		setWidgetEnabled(widget, layoutMode === EDGE_MODE_VALUE);
	}
	updateLayoutButtons(node);
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
	GJJ_Utils.refreshNode(node);
}

function ensureModePanel(node) {
	if (node.__gjjQwen2511ModePanel) {
		return node.__gjjQwen2511ModePanel;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
	].join(";");

	const targetPanel = document.createElement("div");
	targetPanel.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
	].join(";");
	const edgePanel = document.createElement("div");
	edgePanel.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
	].join(";");

	const controls = new Map();
	for (const name of TARGET_ONLY_WIDGETS) {
		const { row, controlWrap } = createRow(PARAM_LABELS[name] || name);
		const control = createControlForWidget(node, name);
		if (control) {
			controlWrap.appendChild(control);
			targetPanel.appendChild(row);
			controls.set(name, control);
		}
	}
	for (const name of EDGE_ONLY_WIDGETS) {
		const { row, controlWrap } = createRow(PARAM_LABELS[name] || name);
		const control = createControlForWidget(node, name);
		if (control) {
			controlWrap.appendChild(control);
			edgePanel.appendChild(row);
			controls.set(name, control);
		}
	}

	wrap.appendChild(targetPanel);
	wrap.appendChild(edgePanel);
	shieldDomEvents(wrap);

	const widget = node.addDOMWidget?.(PARAMS_WIDGET_NAME, PARAMS_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => {
			const mode = getCurrentLayoutMode(node);
			return mode === TARGET_MODE_VALUE ? 194 : 156;
		},
	});
	node.__gjjQwen2511ModePanel = { widget, wrap, targetPanel, edgePanel, controls };
	updateModePanel(node);
	return node.__gjjQwen2511ModePanel;
}

function updateModePanel(node) {
	const state = node.__gjjQwen2511ModePanel;
	if (!state) {
		return;
	}
	const mode = getCurrentLayoutMode(node);
	for (const [name, control] of state.controls.entries()) {
		syncCustomControlFromWidget(control, GJJ_Utils.getWidget(node, name));
	}
	state.targetPanel.style.display = mode === TARGET_MODE_VALUE ? "flex" : "none";
	state.edgePanel.style.display = mode === EDGE_MODE_VALUE ? "flex" : "none";
}

function ensureLayoutButtons(node) {
	if (node.__gjjQwen2511LayoutButtons) {
		return node.__gjjQwen2511LayoutButtons;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"gap:8px",
		"align-items:center",
	].join(";");

	const buttons = new Map();
	const createButton = (label, value) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.style.cssText = [
			"flex:1 1 0",
			"height:32px",
			"padding:0 10px",
			"border-radius:10px",
			"border:1px solid #314047",
			"background:#172026",
			"color:#dce7e2",
			"font-size:12px",
			"cursor:pointer",
		].join(";");
		shieldDomEvents(button);
		button.addEventListener("click", () => {
			const layoutWidget = ensureLayoutWidget(node);
			if (!layoutWidget) {
				return;
			}
			node.__gjjLayoutModeValue = value;
			setWidgetValue(layoutWidget, value);
			updateLayoutModeVisibility(node);
			requestAnimationFrame(() => updateLayoutModeVisibility(node));
			setTimeout(() => updateLayoutModeVisibility(node), 0);
		});
		buttons.set(value, button);
		wrap.appendChild(button);
	};

	createButton("目标尺寸扩图", TARGET_MODE_VALUE);
	createButton("四边像素扩图", EDGE_MODE_VALUE);
	shieldDomEvents(wrap);

	const widget = node.addDOMWidget?.("gjj_qwen2511_layout_buttons", "扩图方案按钮", wrap, {
		hideOnZoom: false,
		getHeight: () => 38,
	});
	node.__gjjQwen2511LayoutButtons = { widget, wrap, buttons };
	updateLayoutButtons(node);
	return node.__gjjQwen2511LayoutButtons;
}

function reorderCustomWidgets(node) {
	moveWidgetBefore(node, "gjj_qwen2511_layout_buttons", TARGET_ONLY_WIDGETS[0]);
	moveWidgetAfter(node, STATUS_WIDGET_NAME, AFTER_GENERATE_WIDGET_NAME);
	moveWidgetAfter(node, LAYOUT_WIDGET_NAME, STATUS_WIDGET_NAME);
}

function ensureStatusWidget(node) {
	if (node.__gjjQwen2511EditOutpaintStatus) {
		return node.__gjjQwen2511EditOutpaintStatus;
	}
	const box = document.createElement("div");
	box.textContent = "等待执行";
	box.style.cssText = [
		"min-height:24px",
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:10px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");
	shieldDomEvents(box);
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		hideOnZoom: false,
		getHeight: () => 42,
	});
	node.__gjjQwen2511EditOutpaintStatus = { widget, box };
	return node.__gjjQwen2511EditOutpaintStatus;
}

function setStatus(node, text) {
	const box = node?.__gjjQwen2511EditOutpaintStatus?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	GJJ_Utils.refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjQwen2511EditOutpaintPatched) {
		return;
	}
	node.__gjjQwen2511EditOutpaintPatched = true;
	node.__gjjQwen2511OutputCount = clampImageCount(node.__gjjQwen2511OutputCount || estimateOutputCountFromInput(node));
	stabilizeNode(node);
	node.__gjjLayoutModeValue = getCurrentLayoutMode(node);
	ensureLayoutButtons(node);
	ensureStatusWidget(node);
	reorderCustomWidgets(node);
	setStatus(node, "等待执行");
	updateLayoutModeVisibility(node);

	const originalOnNodeCreated = node.onNodeCreated;
	node.onNodeCreated = function () {
		const result = originalOnNodeCreated?.apply(this, arguments);
		this.__gjjQwen2511OutputCount = clampImageCount(this.__gjjQwen2511OutputCount || estimateOutputCountFromInput(this));
		stabilizeNode(this);

				GJJ_Utils.refreshNode(this);		ensureLayoutButtons(this);
		ensureStatusWidget(this);
		reorderCustomWidgets(this);
		setStatus(this, "等待执行");
		this.__gjjLayoutModeValue = getCurrentLayoutMode(this);
		updateLayoutModeVisibility(this);
		return result;
	};

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function () {
		const result = originalOnConfigure?.apply(this, arguments);
		this.__gjjQwen2511OutputCount = clampImageCount(this.__gjjQwen2511OutputCount || estimateOutputCountFromInput(this));
		stabilizeNode(this);

				GJJ_Utils.refreshNode(this);		ensureLayoutButtons(this);
		ensureStatusWidget(this);
		reorderCustomWidgets(this);
		setStatus(this, "等待执行");
		this.__gjjLayoutModeValue = getCurrentLayoutMode(this);
		updateLayoutModeVisibility(this);
		return result;
	};

	const layoutWidget = ensureLayoutWidget(node);
	if (layoutWidget && !layoutWidget.__gjjLayoutModeHooked) {
		layoutWidget.__gjjLayoutModeHooked = true;
		const originalCallback = layoutWidget.callback;
		layoutWidget.callback = function (value, ...args) {
			const result = originalCallback?.call(this, value, ...args);
			node.__gjjLayoutModeValue = value;
			if (node.properties) {
				node.properties[LAYOUT_WIDGET_NAME] = value;
			}
			updateLayoutModeVisibility(node);
			return result;
		};
	}

	const originalOnExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = originalOnExecuted?.apply(this, arguments);
		this.__gjjQwen2511OutputCount = clampImageCount(message?.result_image_count?.[0] || estimateOutputCountFromInput(this));
		stabilizeNode(this);

				GJJ_Utils.refreshNode(this);
				return result;
	};

	const originalOnConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = originalOnConnectionsChange?.apply(this, args);
		if (!getPrimaryImageInput(this)?.link) {
			this.__gjjQwen2511OutputCount = 1;
		} else if (!this.__gjjQwen2511OutputCount || this.__gjjQwen2511OutputCount <= 1) {
			this.__gjjQwen2511OutputCount = estimateOutputCountFromInput(this);
		}
		scheduleStabilize(this);
		return result;
	};

	const originalOnDrawBackground = node.onDrawBackground;
	node.onDrawBackground = function (...args) {
		const result = originalOnDrawBackground?.apply(this, args);
		const signature = getConnectionSignature(this);
		if (this.__gjjQwen2511LastSignature !== signature) {
			this.__gjjQwen2511LastSignature = signature;
			scheduleStabilize(this);
		}
		syncSlotLabels(this);
		const currentMode = getCurrentLayoutMode(this);
		if (this.__gjjLastAppliedLayoutMode !== currentMode) {
			this.__gjjLastAppliedLayoutMode = currentMode;
			updateLayoutModeVisibility(this);
		}
		return result;
	};
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.Qwen2511EditOutpaint",
	setup() {
		if (window.__gjjQwen2511EditOutpaintConnectionDefaultsPatched) {
			stabilizeExistingTargetNodes(0);
			stabilizeExistingTargetNodes(250);
			return;
		}
		window.__gjjQwen2511EditOutpaintConnectionDefaultsPatched = true;

		const originalCreateDefaultNodeForSlot = LGraphCanvas.prototype.createDefaultNodeForSlot;
		LGraphCanvas.prototype.createDefaultNodeForSlot = function (optPass) {
			const config = resolvePreferredNodeConfig(optPass);
			if (config && createPreferredNodeForSlot(this, optPass, config)) {
				return true;
			}
			return config
				? withTemporaryPreferredDefault(config, () => originalCreateDefaultNodeForSlot.call(this, optPass))
				: originalCreateDefaultNodeForSlot.call(this, optPass);
		};

		const originalShowConnectionMenu = LGraphCanvas.prototype.showConnectionMenu;
		if (typeof originalShowConnectionMenu === "function") {
			LGraphCanvas.prototype.showConnectionMenu = function (optPass) {
				const config = resolvePreferredNodeConfig(optPass);
				return config
					? withTemporaryPreferredDefault(config, () => originalShowConnectionMenu.call(this, optPass))
					: originalShowConnectionMenu.call(this, optPass);
			};
		}

		const originalShowSearchBox = LGraphCanvas.prototype.showSearchBox;
		if (typeof originalShowSearchBox === "function") {
			LGraphCanvas.prototype.showSearchBox = function (...args) {
				const options = args?.[1] || {};
				const config = resolvePreferredNodeConfig({
					nodeFrom: options.node_from || null,
					slotFrom: options.slot_from ?? null,
					nodeTo: options.node_to || null,
					slotTo: options.slot_to ?? options.slot_from ?? null,
				});
				if (!config) {
					return originalShowSearchBox.apply(this, args);
				}
				return withTemporaryPreferredDefault(config, () => {
					const result = originalShowSearchBox.apply(this, args);
					primePreferredSearchBox(config.searchText);
					return result;
				});
			};
		}

		stabilizeExistingTargetNodes(0);
		stabilizeExistingTargetNodes(250);
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalOnNodeCreated?.apply(this, arguments);
			patchNode(this);
			return result;
		};
	},
});

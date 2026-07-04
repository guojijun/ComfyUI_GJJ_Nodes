import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_PointsEditor"]);
const WIDTH_PROPERTY = "gjj_points_editor_width";
const HEIGHT_PROPERTY = "gjj_points_editor_height";
const SOURCE_PROPERTY = "gjj_points_editor_image_source";
const IMAGE_STORE_PROPERTY = "gjj_points_editor_image_store";
const STATE_PROPERTY = "gjj_points_editor_state";
const MORE_OUTPUTS_PROPERTY = "gjj_points_editor_more_outputs";
const ENABLED_OUTPUTS_PROPERTY = "enabled_outputs";
const PARAMETERS_VISIBLE_PROPERTY = "gjj_points_editor_parameters_visible";
const NODE_CLASS_NAME = "GJJ_PointsEditor";
const MIN_NODE_WIDTH = 420;
const DEFAULT_NODE_WIDTH = 520;
const DEFAULT_NODE_HEIGHT = 360;
const TOOLBAR_HEIGHT = 34;
const NODE_FRAME_EXTRA = 10;
const HIDDEN_WIDGET_SET = new Set(["points_store", "coordinates", "neg_coordinates", "bbox_store", "image_store", "bboxes", "editor_state", "enabled_outputs", "parameters_visible"]);
const PARAMETER_WIDGET_SET = new Set(["bbox_format", "width", "height", "normalize"]);

const DEFAULT_OUTPUT_KEYS = ["positive", "negative", "bbox"];
const BASE_OUTPUT_DEFS = [
	{ key: "positive", name: "前景点坐标", type: "STRING", tooltip: "前景点位坐标 JSON 文本。"},
	{ key: "negative", name: "背景点坐标", type: "STRING", tooltip: "背景点位坐标 JSON 文本。"},
	{ key: "bbox", name: "框选范围信息", type: "BBOX", tooltip: "框选结果，按所选格式输出边框数组。"},
];
const OPTIONAL_OUTPUT_DEFS = [
	{ key: "mask", name: "框选遮罩图像", type: "MASK", tooltip: "根据边框填充得到的遮罩。"},
	{ key: "crop", name: "首个裁切图像", type: "IMAGE", tooltip: "若接了背景图则输出第一组边框裁切图，否则输出当前背景图或空白画布。"},
	{ key: "bbox_preview", name: "框选预览图像", type: "IMAGE", tooltip: "在原图上绘制框选范围后的预览图像。"},
];
const OUTPUT_DEFS = [...BASE_OUTPUT_DEFS, ...OPTIONAL_OUTPUT_DEFS];
const OUTPUT_DEF_BY_KEY = new Map(OUTPUT_DEFS.map((def) => [def.key, def]));
let promptPatched = false;
let queuePatchRetryCount = 0;

function graphDirty() {
	app.graph?.setDirtyCanvas?.(true, true);
}

function compactPointsNode(node) {
	if (!node) {
		return;
	}
	HIDDEN_WIDGET_SET.forEach((name) => hideWidget(node.widgets?.find((widget) => widget?.name === name)));
	PARAMETER_WIDGET_SET.forEach((name) => hideWidget(node.widgets?.find((widget) => widget?.name === name)));
	GJJ_Utils.removeHiddenInputSockets?.(node, HIDDEN_WIDGET_SET);
	GJJ_Utils.reorderWidgets?.(node, HIDDEN_WIDGET_SET);
}

function hideWidget(widget) {
	if (!widget) {
		return;
	}
	widget.__gjjPointsHidden ||= {
		type: widget.type,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		hidden: widget.hidden,
		y: widget.y,
		last_y: widget.last_y,
		computedHeight: widget.computedHeight,
		margin_top: widget.margin_top,
		size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
		label: widget.label,
		localized_name: widget.localized_name,
		tooltip: widget.tooltip,
		elementDisplay: widget.element?.style?.display,
		elementHeight: widget.element?.style?.height,
		elementMinHeight: widget.element?.style?.minHeight,
		elementMargin: widget.element?.style?.margin,
		elementPadding: widget.element?.style?.padding,
		elementOverflow: widget.element?.style?.overflow,
		inputDisplay: widget.inputEl?.style?.display,
		inputHeight: widget.inputEl?.style?.height,
		inputMinHeight: widget.inputEl?.style?.minHeight,
		inputMargin: widget.inputEl?.style?.margin,
		inputPadding: widget.inputEl?.style?.padding,
	};
	GJJ_Utils.hideWidget(widget);
	widget.type = "hidden";
	widget.serialize = true;
	widget.disabled = true;
	widget.advanced = true;
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.options.widget = "hidden";
	widget.options.forceInput = false;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.hidden = true;
	widget.y = 0;
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	widget.label = "";
	widget.localized_name = "";
	widget.tooltip = "";
	if (widget.element) {
		widget.element.style.display = "none";
		widget.element.style.height = "0px";
		widget.element.style.minHeight = "0px";
		widget.element.style.maxHeight = "0px";
		widget.element.style.margin = "0";
		widget.element.style.padding = "0";
		widget.element.style.border = "0";
		widget.element.style.overflow = "hidden";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
		widget.inputEl.style.height = "0px";
		widget.inputEl.style.minHeight = "0px";
		widget.inputEl.style.maxHeight = "0px";
		widget.inputEl.style.margin = "0";
		widget.inputEl.style.padding = "0";
		widget.inputEl.style.border = "0";
	}
}

function showWidget(widget) {
	if (!widget) {
		return;
	}
	const stored = widget.__gjjPointsHidden;
	if (stored) {
		widget.type = stored.type;
		widget.computeSize = stored.computeSize;
		widget.getHeight = stored.getHeight;
		widget.draw = stored.draw;
		widget.mouse = stored.mouse;
		widget.hidden = stored.hidden || false;
		widget.y = stored.y;
		widget.last_y = stored.last_y;
		widget.computedHeight = stored.computedHeight;
		widget.margin_top = stored.margin_top;
		widget.size = Array.isArray(stored.size) ? [...stored.size] : stored.size;
		widget.label = stored.label;
		widget.localized_name = stored.localized_name;
		widget.tooltip = stored.tooltip;
	}
	if (widget.element) {
		widget.element.style.display = stored?.elementDisplay || "";
		widget.element.style.height = stored?.elementHeight || "";
		widget.element.style.minHeight = stored?.elementMinHeight || "";
		widget.element.style.margin = stored?.elementMargin || "";
		widget.element.style.padding = stored?.elementPadding || "";
		widget.element.style.overflow = stored?.elementOverflow || "";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = stored?.inputDisplay || "";
		widget.inputEl.style.height = stored?.inputHeight || "";
		widget.inputEl.style.minHeight = stored?.inputMinHeight || "";
		widget.inputEl.style.margin = stored?.inputMargin || "";
		widget.inputEl.style.padding = stored?.inputPadding || "";
	}
}

function safeParseArray(raw, fallback = []) {
	try {
		const value = JSON.parse(String(raw || "[]"));
		return Array.isArray(value) ? value : fallback;
	} catch {
		return fallback;
	}
}

function safeParseStore(raw) {
	try {
		const value = JSON.parse(String(raw || "{}"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

function safeParseState(raw) {
	try {
		const value = JSON.parse(String(raw || "{}"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

function coerceBoolean(value) {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value !== 0;
	}
	const text = String(value ?? "").trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(text)) {
		return true;
	}
	if (["false", "0", "no", "off", ""].includes(text)) {
		return false;
	}
	return Boolean(value);
}

function readParametersVisible(node) {
	const widget = getWidget(node, "parameters_visible");
	const raw = node?.properties?.[PARAMETERS_VISIBLE_PROPERTY] ?? widget?.value ?? false;
	return coerceBoolean(raw);
}

function writeParametersVisible(node, visible) {
	node.properties ||= {};
	node.properties[PARAMETERS_VISIBLE_PROPERTY] = Boolean(visible);
	const widget = getWidget(node, "parameters_visible");
	if (widget) {
		setWidgetValue(widget, visible ? "true" : "false", false);
	}
}

function updateSettingsButton(node) {
	const button = node.__gjjPointsEditor?.settingsButton;
	if (!button) {
		return;
	}
	const visible = readParametersVisible(node);
	button.style.background = visible ? "#24475b" : "#182127";
	button.style.borderColor = visible ? "#5fa8d3" : "#41535b";
	button.title = visible ? "隐藏参数" : "显示参数";
}

function applyParameterVisibility(node, visible = readParametersVisible(node)) {
	PARAMETER_WIDGET_SET.forEach((name) => hideWidget(getWidget(node, name)));
	writeParametersVisible(node, visible);
	if (node.__gjjPointsEditor?.settingsPanel) {
		node.__gjjPointsEditor.settingsPanel.style.display = visible ? "flex" : "none";
	}
	updateSettingsButton(node);
	graphDirty();
}

function finitePositiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

function coerceDimension(value, fallback = 512) {
	return finitePositiveNumber(value) ?? fallback;
}

function validBboxFormat(value) {
	if (value === 0 || value === "0") {
		return "xyxy";
	}
	if (value === 1 || value === "1") {
		return "xywh";
	}
	const text = String(value || "");
	return ["xyxy", "xywh"].includes(text) ? text : null;
}

function validNormalizeValue(value) {
	if (typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		return ["true", "false", "1", "0", "yes", "no", "on", "off", ""].includes(text) ? value : null;
	}
	return null;
}

function hasStatePayload(state) {
	return Boolean(
		state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		(
			Array.isArray(state.positive) ||
			Array.isArray(state.negative) ||
			Array.isArray(state.boxes) ||
			Array.isArray(state.coordinates) ||
			Array.isArray(state.neg_coordinates) ||
			Array.isArray(state.bboxes) ||
			(typeof state.image_store === "string" && state.image_store.length > 0) ||
			finitePositiveNumber(state.width) != null ||
			finitePositiveNumber(state.height) != null ||
			validBboxFormat(state.bbox_format) != null ||
			validNormalizeValue(state.normalize) != null
		)
	);
}

function readEditorState(node, editorStateWidget) {
	const widgetState = safeParseState(editorStateWidget?.value);
	if (hasStatePayload(widgetState)) {
		return widgetState;
	}
	const propertyState = safeParseState(node?.properties?.[STATE_PROPERTY]);
	if (hasStatePayload(propertyState)) {
		return propertyState;
	}
	return widgetState;
}

function isJsonArray(raw) {
	try {
		return Array.isArray(JSON.parse(String(raw || "[]")));
	} catch {
		return false;
	}
}

function parseBox(box) {
	if (!box || box.startX == null || box.startY == null || box.endX == null || box.endY == null) {
		return null;
	}
	const startX = Number(box.startX);
	const startY = Number(box.startY);
	const endX = Number(box.endX);
	const endY = Number(box.endY);
	if (![startX, startY, endX, endY].every(Number.isFinite)) {
		return null;
	}
	return {
		startX: Math.min(startX, endX),
		startY: Math.min(startY, endY),
		endX: Math.max(startX, endX),
		endY: Math.max(startY, endY),
	};
}

function hasPoints(points) {
	return Array.isArray(points) && points.length > 0;
}

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name) || null;
}

function setWidgetValue(widget, value, callCallback = true) {
	if (!widget) {
		return;
	}
	if (widget.value === value) {
		return;
	}
	widget.value = value;
	if (callCallback) {
		widget.callback?.(value);
	}
}

function getStoredWidth(node) {
	const stored = Number(node?.properties?.[WIDTH_PROPERTY] || 0);
	const current = Number(node?.size?.[0] || 0);
	return Math.max(MIN_NODE_WIDTH, current || stored || DEFAULT_NODE_WIDTH);
}

function getStoredHeight(node) {
	return Math.max(DEFAULT_NODE_HEIGHT, Number(node?.properties?.[HEIGHT_PROPERTY] || node?.size?.[1] || DEFAULT_NODE_HEIGHT));
}

function ensureNodeSize(node) {
	node.properties ||= {};
	node.properties[WIDTH_PROPERTY] = getStoredWidth(node);
	node.properties[HEIGHT_PROPERTY] = getStoredHeight(node);
	node.size ||= [node.properties[WIDTH_PROPERTY], node.properties[HEIGHT_PROPERTY]];
	node.size[0] = node.properties[WIDTH_PROPERTY];
	node.size[1] = node.properties[HEIGHT_PROPERTY];
	node.min_width = MIN_NODE_WIDTH;
	node.minWidth = MIN_NODE_WIDTH;
}

function persistNodeSize(node) {
	node.properties ||= {};
	node.properties[WIDTH_PROPERTY] = getStoredWidth(node);
	node.properties[HEIGHT_PROPERTY] = getStoredHeight(node);
}

function parseJsonValue(rawValue, fallback = null) {
	try {
		return JSON.parse(String(rawValue || ""));
	} catch {
		return fallback;
	}
}

function normalizeOutputKeys(value) {
	const source = Array.isArray(value)
		? value
		: Array.isArray(value?.outputs)
			? value.outputs
			: Array.isArray(value?.enabled_outputs)
				? value.enabled_outputs
				: [];
	const result = [];
	for (const item of source) {
		const key = String(typeof item === "object" && item ? item.key : item || "");
		if (OUTPUT_DEF_BY_KEY.has(key) && !result.includes(key)) {
			result.push(key);
		}
	}
	return result;
}

function parseEnabledOutputs(rawValue) {
	return normalizeOutputKeys(parseJsonValue(rawValue, []));
}

function serializeEnabledOutputs(keys) {
	return JSON.stringify({
		version: 2,
		outputs: normalizeOutputKeys(keys).map((key) => {
			const def = OUTPUT_DEF_BY_KEY.get(key);
			return { key, name: def?.name || key, type: def?.type || "*" };
		}),
	});
}

function outputSlotKey(output, index) {
	const explicit = String(output?.__gjj_key || output?.gjj_key || output?.key || "");
	if (OUTPUT_DEF_BY_KEY.has(explicit)) return explicit;
	const label = String(output?.name || output?.label || output?.localized_name || output?.display_name || "");
	const matched = OUTPUT_DEFS.find((def) => def.name === label);
	if (matched) return matched.key;
	return OUTPUT_DEFS[index]?.key || "";
}

function outputLinked(output) {
	return Array.isArray(output?.links) && output.links.length > 0;
}

function linkedOutputKeys(node) {
	const result = [];
	for (let index = 0; index < (node.outputs || []).length; index += 1) {
		const output = node.outputs[index];
		const key = outputSlotKey(output, index);
		if (OUTPUT_DEF_BY_KEY.has(key) && outputLinked(output) && !result.includes(key)) {
			result.push(key);
		}
	}
	return result;
}

function enabledOutputKeys(node) {
	return parseEnabledOutputs(node?.properties?.[ENABLED_OUTPUTS_PROPERTY]);
}

function currentOutputDefs(node) {
	const keys = enabledOutputKeys(node);
	return keys.map((key) => OUTPUT_DEF_BY_KEY.get(key)).filter(Boolean);
}

function applyOutputSpec(output, def, index) {
	if (!output || !def) return;
	output.name = def.name;
	output.label = def.name;
	output.localized_name = def.name;
	output.display_name = def.name;
	output.type = def.type;
	output.tooltip = def.tooltip;
	output.__gjj_key = def.key;
	output.gjj_key = def.key;
	output.hidden = false;
	output.visible = true;
	output.disabled = false;
	output.not_show = false;
	output.__gjj_hidden = false;
	output.slot_index = index;
	if (!Array.isArray(output.links)) output.links = [];
}

function collectOutputLinksByKey(node) {
	const saved = [];
	for (let index = 0; index < (node.outputs || []).length; index += 1) {
		const output = node.outputs[index];
		const key = outputSlotKey(output, index);
		if (!key) continue;
		for (const linkId of (Array.isArray(output?.links) ? output.links.slice() : [])) {
			const link = app.graph?.links?.[linkId];
			if (!link) continue;
			saved.push({
				id: linkId,
				key,
				link,
				target_id: link.target_id,
				target_slot: link.target_slot,
			});
		}
		output.links = [];
	}
	return saved;
}

function restoreOutputLinksByKey(node, savedLinks, defs) {
	const byKey = new Map(defs.map((def, index) => [def.key, { def, index }]));
	const restored = new Set();
	for (const item of savedLinks || []) {
		const target = byKey.get(item.key);
		if (!target) continue;
		const output = node.outputs?.[target.index];
		const link = app.graph?.links?.[item.id] || item.link;
		if (!output || !link) continue;
		const graphUsesSerializableLinks = Object.values(app.graph?.links || {}).some((candidate) => candidate && typeof candidate.asSerialisable === "function");
		if (graphUsesSerializableLinks && typeof link.asSerialisable !== "function") continue;
		link.id = item.id;
		link.origin_id = node.id;
		link.origin_slot = target.index;
		link.type = target.def.type;
		app.graph.links ||= {};
		app.graph.links[item.id] = link;
		if (!Array.isArray(output.links)) output.links = [];
		if (!output.links.includes(item.id)) output.links.push(item.id);
		const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (targetInput) targetInput.link = item.id;
		restored.add(item.id);
	}
	return restored;
}

function deleteUnrestoredOutputLinks(savedLinks, restoredIds) {
	for (const item of savedLinks || []) {
		if (restoredIds?.has?.(item.id)) continue;
		const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (targetInput?.link === item.id) targetInput.link = null;
		try { app.graph?.removeLink?.(item.id); } catch (_) {}
		try { if (app.graph?.links?.[item.id]) delete app.graph.links[item.id]; } catch (_) {}
	}
}

function rebuildOutputSlots(node, defs) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const savedLinks = collectOutputLinksByKey(node);
	while (node.outputs.length > 0) {
		try { node.removeOutput?.(node.outputs.length - 1); }
		catch { node.outputs.pop(); }
	}
	for (const def of defs) {
		try { node.addOutput?.(def.name, def.type); }
		catch { node.outputs.push({ name: def.name, type: def.type, links: [] }); }
	}
	defs.forEach((def, index) => applyOutputSpec(node.outputs?.[index], def, index));
	const restored = restoreOutputLinksByKey(node, savedLinks, defs);
	deleteUnrestoredOutputLinks(savedLinks, restored);
}

function serializedOutputObject(existing, def, index) {
	const links = Array.isArray(existing?.links) ? [...existing.links] : [];
	return {
		name: def.name,
		label: def.name,
		localized_name: def.name,
		display_name: def.name,
		type: def.type,
		links,
		slot_index: index,
		tooltip: def.tooltip,
		gjj_key: def.key,
		hidden: false,
		visible: true,
		disabled: false,
		not_show: false,
		__gjj_hidden: false,
	};
}

function writeSerializedOutputSlots(serializedNode, defs) {
	if (!serializedNode) return;
	const existing = Array.isArray(serializedNode.outputs) ? serializedNode.outputs : [];
	const existingByKey = new Map();
	existing.forEach((output, index) => {
		const key = outputSlotKey(output, index);
		if (key && !existingByKey.has(key)) existingByKey.set(key, output);
	});
	const liveNode = app.graph?.getNodeById?.(serializedNode.id) || app.graph?._nodes_by_id?.[serializedNode.id];
	const liveByKey = new Map();
	(liveNode?.outputs || []).forEach((output, index) => {
		const key = outputSlotKey(output, index);
		if (key && !liveByKey.has(key)) liveByKey.set(key, output);
	});
	serializedNode.outputs = defs.map((def, index) => {
		return serializedOutputObject(liveByKey.get(def.key) || existingByKey.get(def.key), def, index);
	});
}

function refreshNodeAfterOutputChange(node) {
	if (!node) return;
	if (typeof node.computeSize === "function") {
		try {
			const size = node.computeSize();
			if (Array.isArray(size) && size.length >= 2) {
				node.size = [Math.max(node.size?.[0] || MIN_NODE_WIDTH, size[0]), Math.max(DEFAULT_NODE_HEIGHT, size[1])];
			}
		} catch {}
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function outputShapeMatches(node, defs) {
	if (!Array.isArray(node?.outputs) || node.outputs.length !== defs.length) return false;
	return defs.every((def, index) => {
		const output = node.outputs[index];
		return output && outputSlotKey(output, index) === def.key && String(output.type || "") === def.type;
	});
}

function stabilizeOutputs(node) {
	if (!node) {
		return;
	}

	node.properties ||= {};
	if (!node.properties[ENABLED_OUTPUTS_PROPERTY]) {
		const recovered = linkedOutputKeys(node);
		const existing = Array.isArray(node.outputs) && node.outputs.length > 0
			? node.outputs.map((output, index) => outputSlotKey(output, index)).filter((key) => OUTPUT_DEF_BY_KEY.has(key))
			: [];
		node.properties[ENABLED_OUTPUTS_PROPERTY] = serializeEnabledOutputs(recovered.length ? recovered : existing.length ? existing : DEFAULT_OUTPUT_KEYS);
	}
	const defs = currentOutputDefs(node);
	if (!outputShapeMatches(node, defs)) {
		rebuildOutputSlots(node, defs);
	} else {
		defs.forEach((def, index) => applyOutputSpec(node.outputs?.[index], def, index));
	}
	node.properties[MORE_OUTPUTS_PROPERTY] = enabledOutputKeys(node).length === OUTPUT_DEFS.length;

	const moreOutputsButton = node.__gjjPointsEditor?.moreOutputsButton;
	if (moreOutputsButton) {
		const expanded = Boolean(node.properties?.[MORE_OUTPUTS_PROPERTY]);
		moreOutputsButton.disabled = false;
		moreOutputsButton.title = buildOutputTitle(expanded);
		moreOutputsButton.style.background = expanded ? "#24475b" : "#182127";
		moreOutputsButton.style.borderColor = expanded ? "#5fa8d3" : "#41535b";
	}
	globalThis.GJJApplyTypeColorsToNode?.(node);
	refreshNodeAfterOutputChange(node);
	graphDirty();
}

function buildOutputTitle(expanded) {
	return expanded
		? "已展开全部输出口。点击后收起未连接的尾部输出口。"
		: "默认显示前景点、背景点和框选范围。点击后展开遮罩、裁切图和框选预览图输出口。";
}

function workflowNodeById(workflow, nodeId) {
	const idText = String(nodeId ?? "");
	const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
	return nodes.find((node) => String(node?.id ?? node?.node_id ?? "") === idText) || null;
}

function stateFromWorkflowNode(nodeInfo) {
	const properties = nodeInfo?.properties && typeof nodeInfo.properties === "object" ? nodeInfo.properties : {};
	return safeParseState(properties[STATE_PROPERTY]) || {};
}

function syncNodeToPrompt(node, output, workflow) {
	if (!node) {
		return;
	}
	const view = ensureEditor(node);
	view.writeBack?.();
	const state = view.buildEditorState?.() || {};
	const promptNode = output?.[String(node.id)];
	if (!promptNode || typeof promptNode !== "object") {
		return;
	}
	const inputs = promptNode.inputs ||= {};
	const positive = Array.isArray(state.positive) ? state.positive : [];
	const negative = Array.isArray(state.negative) ? state.negative : [];
	const boxes = Array.isArray(state.boxes) ? state.boxes : [];
	const stateText = JSON.stringify(state);
	const bboxFormatWidget = getWidget(node, "bbox_format");
	const widthWidget = getWidget(node, "width");
	const heightWidget = getWidget(node, "height");
	inputs.points_store = JSON.stringify({ positive, negative }, null, 0);
	inputs.coordinates = JSON.stringify(positive);
	inputs.neg_coordinates = JSON.stringify(negative);
	inputs.bbox_store = JSON.stringify(boxes);
	inputs.bboxes = JSON.stringify(boxes);
	inputs.bbox_format = validBboxFormat(bboxFormatWidget?.value) || validBboxFormat(state.bbox_format) || "xywh";
	inputs.width = coerceDimension(state.width, coerceDimension(widthWidget?.value, 512));
	inputs.height = coerceDimension(state.height, coerceDimension(heightWidget?.value, 512));
	inputs.normalize = coerceBoolean(state.normalize);
	inputs.image_store = String(state.image_store || "");
	inputs.editor_state = stateText;
	inputs.enabled_outputs = String(node.properties?.[ENABLED_OUTPUTS_PROPERTY] || serializeEnabledOutputs(enabledOutputKeys(node).length ? enabledOutputKeys(node) : DEFAULT_OUTPUT_KEYS));
	inputs.parameters_visible = readParametersVisible(node) ? "true" : "false";

	const workflowNode = workflowNodeById(workflow, node.id);
	if (workflowNode) {
		workflowNode.properties ||= {};
		workflowNode.properties[STATE_PROPERTY] = stateText;
		workflowNode.properties[IMAGE_STORE_PROPERTY] = String(state.image_store || "");
		workflowNode.properties[WIDTH_PROPERTY] = coerceDimension(state.width, workflowNode.properties[WIDTH_PROPERTY] || 512);
		workflowNode.properties[HEIGHT_PROPERTY] = coerceDimension(state.height, workflowNode.properties[HEIGHT_PROPERTY] || 512);
		workflowNode.properties[ENABLED_OUTPUTS_PROPERTY] = inputs.enabled_outputs;
		workflowNode.properties[PARAMETERS_VISIBLE_PROPERTY] = readParametersVisible(node);
		writeSerializedOutputSlots(workflowNode, currentOutputDefs(node));
	}
}

function syncAllPointsEditorsToPrompt(output, workflow) {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			syncNodeToPrompt(node, output, workflow);
		}
	}
}

function syncAllPointsEditorsToWidgets() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			ensureEditor(node).writeBack?.();
		}
	}
}

function patchQueuePrompt() {
	if (!api.__gjjPointsEditorPromptPatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjPointsEditorPromptPatchInstalled = true;
		const original = api.queuePrompt.bind(api);
		api.queuePrompt = async function (number, promptData, ...args) {
			try {
				syncAllPointsEditorsToPrompt(promptData?.output, promptData?.workflow);
			} catch (error) {
				console.warn("[GJJ] 点位编辑器提交前同步失败：", error);
			}
			return original(number, promptData, ...args);
		};
		promptPatched = true;
	}
	if (!app.__gjjPointsEditorPromptPatchInstalled && typeof app.graphToPrompt === "function") {
		app.__gjjPointsEditorPromptPatchInstalled = true;
		const originalGraphToPrompt = app.graphToPrompt.bind(app);
		app.graphToPrompt = async function (...args) {
			const result = await originalGraphToPrompt(...args);
			try {
				const graph = args[0] || this.rootGraph || this.graph || app.rootGraph || app.graph;
				syncAllPointsEditorsToPrompt(
					result?.output || result?.prompt?.output,
					result?.workflow || result?.prompt?.workflow || graph?.serialize?.(),
				);
			} catch (error) {
				console.warn("[GJJ] 点位编辑器 graphToPrompt 同步失败：", error);
			}
			return result;
		};
		promptPatched = true;
	}
	if (!promptPatched && queuePatchRetryCount < 30) {
		queuePatchRetryCount += 1;
		window.setTimeout(patchQueuePrompt, 500);
	}
}

function stopEvent(event) {
	event.preventDefault?.();
	event.stopPropagation?.();
	event.stopImmediatePropagation?.();
}

function splitAnnotatedPath(value) {
	const text = String(value || "").trim().replace(/\\/g, "/");
	if (!text) {
		return { filename: "", subfolder: "" };
	}
	const parts = text.split("/");
	if (parts.length <= 1) {
		return { filename: text, subfolder: "" };
	}
	return {
		filename: parts.at(-1) || "",
		subfolder: parts.slice(0, -1).join("/"),
	};
}

function buildUploadedImageUrl(rawValue) {
	const { filename, subfolder } = splitAnnotatedPath(rawValue);
	if (!filename) {
		return "";
	}
	return api.apiURL(
		`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`,
	);
}

function imageSourceSignature(src) {
	try {
		const url = new URL(src, window.location.href);
		url.searchParams.delete("rand");
		url.searchParams.delete("preview");
		return `${url.pathname}?${url.searchParams.toString()}`;
	} catch {
		return String(src || "").replace(/([?&])rand=\d+/g, "$1").replace(/[?&]$/, "");
	}
}

function getInputSourceNode(node) {
	const input = node.inputs?.find((slot) => slot?.name === "bg_image");
	if (!input?.link || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[input.link];
	const sourceId = link?.origin_id ?? link?.source_id ?? link?.from_id;
	return sourceId != null ? app.graph.getNodeById?.(sourceId) : null;
}

function buildLinkedImageUrl(node) {
	const sourceNode = getInputSourceNode(node);
	if (!sourceNode) {
		return "";
	}
	const fileWidget = sourceNode.widgets?.find((widget) => widget?.name === "image" || widget?.name === "file" || widget?.name === "filename");
	const filename = fileWidget?.value;
	if (!filename) {
		const src = sourceNode.imgs?.[0]?.src || sourceNode.image?.src || sourceNode.preview?.src;
		if (src) {
			return src;
		}
		return "";
	}
	const viewType = sourceNode.comfyClass === "LoadImageOutput" ? "output" : "input";
	return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(viewType)}&subfolder=&rand=${Date.now()}`);
}

function uploadFile(file) {
	const formData = new FormData();
	formData.append("image", file, file.name);
	formData.append("type", "input");
	formData.append("overwrite", "true");
	return fetch(api.apiURL("/upload/image"), {
		method: "POST",
		body: formData,
	});
}

async function uploadAndResolveFile(file) {
	const response = await uploadFile(file);
	if (!response.ok) {
		throw new Error(`上传失败：HTTP ${response.status}`);
	}
	const payload = await response.json().catch(() => ({}));
	const filename = payload?.name || payload?.filename || file.name;
	const subfolder = payload?.subfolder || "";
	return subfolder ? `${subfolder}/${filename}` : filename;
}

function ensureEditor(node) {
	if (node.__gjjPointsEditor) {
		return node.__gjjPointsEditor;
	}

	const coordsWidget = getWidget(node, "coordinates");
	const negCoordsWidget = getWidget(node, "neg_coordinates");
	const storeWidget = getWidget(node, "points_store");
	const bboxStoreWidget = getWidget(node, "bbox_store");
	const imageStoreWidget = getWidget(node, "image_store");
	const editorStateWidget = getWidget(node, "editor_state");
	const enabledOutputsWidget = getWidget(node, "enabled_outputs");
	const parametersVisibleWidget = getWidget(node, "parameters_visible");
	const bboxWidget = getWidget(node, "bboxes");
	const bboxFormatWidget = getWidget(node, "bbox_format");
	const widthWidget = getWidget(node, "width");
	const heightWidget = getWidget(node, "height");
	const normalizeWidget = getWidget(node, "normalize");
	const initialState = readEditorState(node, editorStateWidget);

	const root = document.createElement("div");
	root.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"height:100%",
		"box-sizing:border-box",
		"padding:2px 0",
		"pointer-events:auto",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		root.addEventListener(eventName, (event) => event.stopPropagation());
	}

	const toolbar = document.createElement("div");
	toolbar.style.cssText = [
		"display:flex",
		"gap:6px",
		"align-items:center",
		"flex-wrap:nowrap",
		"width:100%",
		"box-sizing:border-box",
	].join(";");
	root.appendChild(toolbar);

	const buttonStyle = [
		"width:28px",
		"height:28px",
		"min-width:28px",
		"padding:0",
		"border-radius:6px",
		"border:1px solid #41535b",
		"background:#182127",
		"color:#dce7e2",
		"cursor:pointer",
		"font-size:15px",
		"line-height:1",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"flex:0 0 auto",
	].join(";");

	const loadButton = document.createElement("button");
	loadButton.textContent = "📁";
	loadButton.title = "载入图片。选择本地图片后会上传到 ComfyUI input 目录，并作为当前编辑画布。";
	loadButton.style.cssText = buttonStyle;
	toolbar.appendChild(loadButton);

	const clearButton = document.createElement("button");
	clearButton.textContent = "🗑";
	clearButton.title = "清理图片。清除当前本地载入的图片预览，但保留点位与框选数据。";
	clearButton.style.cssText = buttonStyle;
	toolbar.appendChild(clearButton);

	const newCanvasButton = document.createElement("button");
	newCanvasButton.textContent = "🆕";
	newCanvasButton.title = "新建画布。清空点位、框选和本地图片，保留当前宽高。";
	newCanvasButton.style.cssText = buttonStyle;
	toolbar.appendChild(newCanvasButton);

	const resetDrawingButton = document.createElement("button");
	resetDrawingButton.textContent = "🔄";
	resetDrawingButton.title = "初始化绘制内容。重置前景点、背景点和默认框选，保留当前图片。";
	resetDrawingButton.style.cssText = buttonStyle;
	toolbar.appendChild(resetDrawingButton);

	const moreOutputsButton = document.createElement("button");
	moreOutputsButton.textContent = "🔌";
	moreOutputsButton.title = buildOutputTitle(Boolean(node.properties?.[MORE_OUTPUTS_PROPERTY]));
	moreOutputsButton.style.cssText = buttonStyle;
	toolbar.appendChild(moreOutputsButton);

	const settingsButton = document.createElement("button");
	settingsButton.textContent = "⚙️";
	settingsButton.title = readParametersVisible(node) ? "隐藏参数" : "显示参数";
	settingsButton.style.cssText = buttonStyle;
	toolbar.appendChild(settingsButton);

	const wrap = document.createElement("div");
	wrap.title = "左键添加前景点，右键添加背景点；按住 Ctrl 并拖拽可创建第三输出口的框选范围。";
	wrap.style.cssText = [
		"position:relative",
		"height:320px",
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #34444c",
		"border-radius:10px",
		"background:#0b1013",
		"overflow:hidden",
		"touch-action:none",
		"cursor:crosshair",
	].join(";");
	root.appendChild(wrap);

	const canvas = document.createElement("canvas");
	canvas.style.cssText = [
		"position:absolute",
		"inset:0",
		"width:100%",
		"height:100%",
		"display:block",
		"user-select:none",
	].join(";");
	wrap.appendChild(canvas);

	const settingsPanel = document.createElement("div");
	settingsPanel.style.cssText = [
		"display:none",
		"flex-direction:column",
		"gap:6px",
		"border:1px solid #33444b",
		"border-radius:8px",
		"background:#111a1f",
		"padding:8px",
		"box-sizing:border-box",
	].join(";");
	root.appendChild(settingsPanel);

	const controlStyle = [
		"width:100%",
		"height:28px",
		"box-sizing:border-box",
		"border:1px solid #33444b",
		"border-radius:6px",
		"background:#263038",
		"color:#e5efea",
		"padding:0 10px",
		"font-size:13px",
	].join(";");
	const labelStyle = "color:#b7c3c8;font-size:12px;line-height:28px;white-space:nowrap;";
	const rowStyle = "display:grid;grid-template-columns:92px minmax(0,1fr);gap:8px;align-items:center;";
	function addSettingsRow(label, control) {
		const row = document.createElement("label");
		row.style.cssText = rowStyle;
		const text = document.createElement("span");
		text.textContent = label;
		text.style.cssText = labelStyle;
		row.appendChild(text);
		row.appendChild(control);
		settingsPanel.appendChild(row);
	}

	const bboxFormatControl = document.createElement("select");
	bboxFormatControl.style.cssText = controlStyle;
	for (const format of ["xyxy", "xywh"]) {
		const option = document.createElement("option");
		option.value = format;
		option.textContent = format;
		bboxFormatControl.appendChild(option);
	}
	addSettingsRow("边框格式", bboxFormatControl);

	const widthControl = document.createElement("input");
	widthControl.type = "number";
	widthControl.min = "8";
	widthControl.max = "4096";
	widthControl.step = "8";
	widthControl.style.cssText = controlStyle;
	addSettingsRow("宽度", widthControl);

	const heightControl = document.createElement("input");
	heightControl.type = "number";
	heightControl.min = "8";
	heightControl.max = "4096";
	heightControl.step = "8";
	heightControl.style.cssText = controlStyle;
	addSettingsRow("高度", heightControl);

	const normalizeControl = document.createElement("input");
	normalizeControl.type = "checkbox";
	normalizeControl.style.cssText = "width:22px;height:22px;margin:0;accent-color:#6ca7d4;";
	addSettingsRow("归一化坐标", normalizeControl);

	const image = new Image();
	image.crossOrigin = "anonymous";

	const storedPayload = safeParseStore(storeWidget?.value);
	const storedPos = Array.isArray(storedPayload.positive) ? storedPayload.positive : [];
	const storedNeg = Array.isArray(storedPayload.negative) ? storedPayload.negative : [];
	const initialPositive = Array.isArray(initialState.positive)
		? initialState.positive
		: Array.isArray(initialState.coordinates)
			? initialState.coordinates
			: safeParseArray(coordsWidget?.value, storedPos);
	const initialNegative = Array.isArray(initialState.negative)
		? initialState.negative
		: Array.isArray(initialState.neg_coordinates)
			? initialState.neg_coordinates
			: safeParseArray(negCoordsWidget?.value, storedNeg);
	const initialBoxes = Array.isArray(initialState.boxes)
		? initialState.boxes
		: Array.isArray(initialState.bboxes)
			? initialState.bboxes
			: safeParseArray(bboxWidget?.value, safeParseArray(bboxStoreWidget?.value));

	const editor = {
		root,
		canvas,
		image,
		imageLoaded: false,
		imageSource: "",
		posPoints: initialPositive,
		negPoints: initialNegative,
		boxes: initialBoxes.map(parseBox).filter(Boolean),
		currentBox: null,
		drawingBox: false,
		boxDragMode: null,
		boxDragStartPoint: null,
		boxDragStartBox: null,
		pendingPoint: null,
		usingDefaultPoints: false,
		loadingToken: 0,
		getModelWidth() {
			sanitizeVisibleWidgets(false);
			if (this.imageLoaded && image.naturalWidth > 0) {
				return Math.max(1, Math.round(image.naturalWidth));
			}
			return Math.max(1, Math.round(coerceDimension(widthWidget?.value, 512)));
		},
		getModelHeight() {
			sanitizeVisibleWidgets(false);
			if (this.imageLoaded && image.naturalHeight > 0) {
				return Math.max(1, Math.round(image.naturalHeight));
			}
			return Math.max(1, Math.round(coerceDimension(heightWidget?.value, 512)));
		},
		setImageSource(src) {
			if (!src || src === this.imageSource) {
				return;
			}
			this.imageSource = src;
			this.imageLoaded = false;
			image.src = src;
			scheduleDraw();
		},
		clearImage() {
			this.imageSource = "";
			this.imageLoaded = false;
			image.removeAttribute("src");
			scheduleDraw();
		},
	};

	function makeDefaultPoints() {
		const width = editor.getModelWidth();
		const height = editor.getModelHeight();
		return {
			positive: [{ x: Math.round(width / 2), y: Math.round(height / 2) }],
			negative: [{
				x: Math.max(0, Math.min(width, Math.round(width * 0.05))),
				y: Math.max(0, Math.min(height, Math.round(height * 0.05))),
			}],
		};
	}

	function makeDefaultBox() {
		const width = editor.getModelWidth();
		const height = editor.getModelHeight();
		const boxWidth = Math.max(1, Math.round(width * 0.35));
		const boxHeight = Math.max(1, Math.round(height * 0.35));
		const startX = Math.max(0, Math.round((width - boxWidth) / 2));
		const startY = Math.max(0, Math.round((height - boxHeight) / 2));
		return {
			startX,
			startY,
			endX: Math.min(width, startX + boxWidth),
			endY: Math.min(height, startY + boxHeight),
		};
	}

	function setDefaultPoints() {
		const defaults = makeDefaultPoints();
		editor.posPoints = defaults.positive;
		editor.negPoints = defaults.negative;
		editor.usingDefaultPoints = true;
	}

	function syncSettingsControlsFromWidgets() {
		bboxFormatControl.value = validBboxFormat(bboxFormatWidget?.value) || "xywh";
		widthControl.value = String(Math.max(1, Math.round(coerceDimension(widthWidget?.value, 512))));
		heightControl.value = String(Math.max(1, Math.round(coerceDimension(heightWidget?.value, 512))));
		normalizeControl.checked = coerceBoolean(normalizeWidget?.value);
	}

	function bindSettingsControl(control, applyValue, afterChange = null) {
		control.addEventListener("change", (event) => {
			event.preventDefault();
			event.stopPropagation();
			applyValue();
			afterChange?.();
			writeBack();
			syncSettingsControlsFromWidgets();
			syncLayout(true);
			scheduleDraw();
		});
	}

	bindSettingsControl(bboxFormatControl, () => {
		setWidgetValue(bboxFormatWidget, validBboxFormat(bboxFormatControl.value) || "xywh", true);
	});
	bindSettingsControl(widthControl, () => {
		setWidgetValue(widthWidget, Math.max(8, Math.round(coerceDimension(widthControl.value, 512))), true);
	}, () => {
		if (!editor.imageLoaded && editor.usingDefaultPoints) setDefaultPoints();
	});
	bindSettingsControl(heightControl, () => {
		setWidgetValue(heightWidget, Math.max(8, Math.round(coerceDimension(heightControl.value, 512))), true);
	}, () => {
		if (!editor.imageLoaded && editor.usingDefaultPoints) setDefaultPoints();
	});
	bindSettingsControl(normalizeControl, () => {
		setWidgetValue(normalizeWidget, Boolean(normalizeControl.checked), true);
	});

	function setEnabledOutputKeys(keys) {
		node.properties ||= {};
		const next = normalizeOutputKeys(keys);
		const serialized = serializeEnabledOutputs(next);
		node.properties[ENABLED_OUTPUTS_PROPERTY] = serialized;
		node.properties[MORE_OUTPUTS_PROPERTY] = next.length === OUTPUT_DEFS.length;
		if (enabledOutputsWidget) {
			enabledOutputsWidget.value = serialized;
			enabledOutputsWidget.callback?.(serialized);
		}
		stabilizeOutputs(node);
		writeBack();
		syncLayout(true);
		scheduleDraw();
	}

	function sanitizeVisibleWidgets(forceImageSize = false) {
		if (node.__gjjPointsSanitizing) {
			return false;
		}
		node.__gjjPointsSanitizing = true;
		let changed = false;
		try {
			if (bboxFormatWidget && !validBboxFormat(bboxFormatWidget.value)) {
				setWidgetValue(bboxFormatWidget, "xywh", false);
				changed = true;
			}
			const imageWidth = editor.imageLoaded && image.naturalWidth > 0 ? Math.round(image.naturalWidth) : null;
			const imageHeight = editor.imageLoaded && image.naturalHeight > 0 ? Math.round(image.naturalHeight) : null;
			const fallbackWidth = imageWidth || 512;
			const fallbackHeight = imageHeight || 512;
			const currentWidth = finitePositiveNumber(widthWidget?.value);
			const currentHeight = finitePositiveNumber(heightWidget?.value);
			if (widthWidget && (currentWidth == null || (forceImageSize && imageWidth != null && Math.round(currentWidth) !== imageWidth))) {
				setWidgetValue(widthWidget, fallbackWidth, false);
				changed = true;
			}
			if (heightWidget && (currentHeight == null || (forceImageSize && imageHeight != null && Math.round(currentHeight) !== imageHeight))) {
				setWidgetValue(heightWidget, fallbackHeight, false);
				changed = true;
			}
			if (normalizeWidget && validNormalizeValue(normalizeWidget.value) == null) {
				setWidgetValue(normalizeWidget, false, false);
				changed = true;
			}
		} finally {
			node.__gjjPointsSanitizing = false;
		}
		if (changed) {
			syncSettingsControlsFromWidgets();
			graphDirty();
		}
		return changed;
	}

	function repairWidgetValues(forceImageSize = false) {
		const repaired = sanitizeVisibleWidgets(forceImageSize);
		const state = readEditorState(node, editorStateWidget);
		if (normalizeWidget && validNormalizeValue(state.normalize) != null) {
			setWidgetValue(normalizeWidget, coerceBoolean(state.normalize), false);
		}
		if (editorStateWidget && !hasStatePayload(state)) {
			const builtState = buildEditorState();
			const text = JSON.stringify(builtState);
			setWidgetValue(editorStateWidget, text, false);
			node.properties ||= {};
			node.properties[STATE_PROPERTY] = text;
		}
		if (repaired) {
			scheduleDraw();
		}
		syncSettingsControlsFromWidgets();
		return repaired;
	}

	function buildEditorState() {
		return {
			version: 1,
			positive: editor.posPoints,
			negative: editor.negPoints,
			boxes: editor.boxes,
			image_store: String(imageStoreWidget?.value || node.properties?.[IMAGE_STORE_PROPERTY] || "").trim(),
			width: editor.getModelWidth(),
			height: editor.getModelHeight(),
			bbox_format: validBboxFormat(bboxFormatWidget?.value) || "xywh",
			normalize: coerceBoolean(normalizeWidget?.value),
		};
	}

	for (const widget of [widthWidget, heightWidget]) {
		if (!widget || widget.__gjjPointsSizePatched) {
			continue;
		}
		widget.__gjjPointsSizePatched = true;
		const originalCallback = widget.callback;
		widget.callback = function (...args) {
			const result = originalCallback?.apply(this, args);
			if (!editor.imageLoaded) {
				if (editor.usingDefaultPoints) {
					setDefaultPoints();
				}
				syncLayout();
				scheduleDraw();
			}
			writeBack();
			return result;
		};
	}
	for (const widget of [bboxFormatWidget, normalizeWidget]) {
		if (!widget || widget.__gjjPointsValuePatched) {
			continue;
		}
		widget.__gjjPointsValuePatched = true;
		const originalCallback = widget.callback;
		widget.callback = function (...args) {
			const result = originalCallback?.apply(this, args);
			writeBack();
			return result;
		};
	}

	function getCanvasMetrics() {
		const modelWidth = editor.getModelWidth();
		const modelHeight = editor.getModelHeight();
		const displayWidth = Math.max(1, Math.round(wrap.clientWidth || root.clientWidth || getStoredWidth(node) - 18));
		const displayHeight = Math.max(1, Math.round(displayWidth * (modelHeight / Math.max(1, modelWidth))));
		return { modelWidth, modelHeight, displayWidth, displayHeight };
	}

	function syncLayout(adjustNode = true) {
		const metrics = getCanvasMetrics();
		const panelVisible = settingsPanel.style.display !== "none";
		const panelHeight = panelVisible ? Math.max(128, Math.ceil(settingsPanel.offsetHeight || 128)) : 0;
		const widgetHeight = metrics.displayHeight + TOOLBAR_HEIGHT + panelHeight + NODE_FRAME_EXTRA + (panelVisible ? 8 : 0);
		wrap.style.height = `${metrics.displayHeight}px`;
		canvas.style.aspectRatio = `${metrics.modelWidth} / ${metrics.modelHeight}`;
		if (canvas.width !== metrics.modelWidth || canvas.height !== metrics.modelHeight) {
			canvas.width = metrics.modelWidth;
			canvas.height = metrics.modelHeight;
		}
		if (node.__gjjPointsEditor?.widget) {
			node.__gjjPointsEditor.widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || getStoredWidth(node))), widgetHeight];
			node.__gjjPointsEditor.widget.getHeight = () => widgetHeight;
		}
		if (adjustNode) {
			node.properties ||= {};
			const width = getStoredWidth(node);
			const computedHeight = Number(node.computeSize?.()?.[1] || 0);
			const height = Math.ceil(Math.max(widgetHeight + 88, computedHeight));
			const prevWidth = Number(node.size?.[0] || 0);
			const prevHeight = Number(node.size?.[1] || 0);
			node.properties[HEIGHT_PROPERTY] = height;
			node.size ||= [width, height];
			node.size[0] = width;
			node.size[1] = height;
			node.min_width = MIN_NODE_WIDTH;
			node.minWidth = MIN_NODE_WIDTH;
			if (Math.abs(prevWidth - width) > 0 || Math.abs(prevHeight - height) > 1) {
				try {
					node.__gjjPointsApplyingSize = true;
					node.setSize?.([width, height]);
				} finally {
					node.__gjjPointsApplyingSize = false;
				}
			}
		}
		return metrics;
	}

	function getSourceFrame() {
		const modelWidth = editor.getModelWidth();
		const modelHeight = editor.getModelHeight();
		return {
			left: 0,
			top: 0,
			width: modelWidth,
			height: modelHeight,
			modelWidth,
			modelHeight,
			viewWidth: modelWidth,
			viewHeight: modelHeight,
		};
	}

	function writeBack() {
		sanitizeVisibleWidgets(false);
		editor.boxes = editor.boxes.map(parseBox).filter(Boolean).slice(-1);
		const payload = { positive: editor.posPoints, negative: editor.negPoints };
		if (coordsWidget) {
			coordsWidget.value = JSON.stringify(editor.posPoints);
			coordsWidget.callback?.(coordsWidget.value);
		}
		if (negCoordsWidget) {
			negCoordsWidget.value = JSON.stringify(editor.negPoints);
			negCoordsWidget.callback?.(negCoordsWidget.value);
		}
		if (storeWidget) {
			storeWidget.value = JSON.stringify(payload);
			storeWidget.callback?.(storeWidget.value);
		}
		if (bboxStoreWidget) {
			bboxStoreWidget.value = JSON.stringify(editor.boxes);
			bboxStoreWidget.callback?.(bboxStoreWidget.value);
		}
		if (bboxWidget) {
			bboxWidget.value = JSON.stringify(editor.boxes);
			bboxWidget.callback?.(bboxWidget.value);
		}
		if (editorStateWidget) {
			const stateText = JSON.stringify(buildEditorState());
			editorStateWidget.value = stateText;
			editorStateWidget.callback?.(stateText);
			node.properties ||= {};
			node.properties[STATE_PROPERTY] = stateText;
		}
		if (enabledOutputsWidget) {
			const serialized = String(node.properties?.[ENABLED_OUTPUTS_PROPERTY] || serializeEnabledOutputs(enabledOutputKeys(node)));
			enabledOutputsWidget.value = serialized;
			enabledOutputsWidget.callback?.(serialized);
		}
		if (parametersVisibleWidget) {
			const visible = readParametersVisible(node);
			parametersVisibleWidget.value = visible ? "true" : "false";
			parametersVisibleWidget.callback?.(parametersVisibleWidget.value);
		}
		graphDirty();
		scheduleDraw();
	}

	function syncStoredImage(rawValue) {
		const value = String(rawValue || "").trim();
		node.properties ||= {};
		node.properties[IMAGE_STORE_PROPERTY] = value;
		if (imageStoreWidget) {
			imageStoreWidget.value = value;
			imageStoreWidget.callback?.(value);
		}
	}

	function syncImageSizeFromSource() {
		const signature = imageSourceSignature(editor.imageSource);
		node.properties ||= {};
		const currentWidth = Number(widthWidget?.value);
		const currentHeight = Number(heightWidget?.value);
		const widthChanged = finitePositiveNumber(currentWidth) == null || currentWidth === 512;
		const heightChanged = finitePositiveNumber(currentHeight) == null || currentHeight === 512;
		const dimensionsMismatch = !Number.isFinite(currentWidth) || !Number.isFinite(currentHeight) || Math.abs(currentWidth - image.naturalWidth) > 1 || Math.abs(currentHeight - image.naturalHeight) > 1;
		if (signature && (node.properties[SOURCE_PROPERTY] !== signature || widthChanged || heightChanged || dimensionsMismatch)) {
			setWidgetValue(widthWidget, image.naturalWidth, false);
			setWidgetValue(heightWidget, image.naturalHeight, false);
			node.properties[SOURCE_PROPERTY] = signature;
			writeBack();
		}
	}

	function getViewport() {
		return getSourceFrame();
	}

	function toModelPoint(event, allowOutside = false) {
		const rect = canvas.getBoundingClientRect();
		const localX = event.clientX - rect.left;
		const localY = event.clientY - rect.top;
		if (
			!allowOutside && (
				localX < 0 ||
				localX > rect.width ||
				localY < 0 ||
				localY > rect.height
			)
		) {
			return null;
		}
		const modelWidth = editor.getModelWidth();
		const modelHeight = editor.getModelHeight();
		return {
			x: Math.max(0, Math.min(modelWidth, localX * (modelWidth / Math.max(1, rect.width)))),
			y: Math.max(0, Math.min(modelHeight, localY * (modelHeight / Math.max(1, rect.height)))),
		};
	}

	function drawPoint(ctx, bounds, point, index, color, labelColor) {
		const x = bounds.left + (Number(point.x || 0) / bounds.modelWidth) * bounds.width;
		const y = bounds.top + (Number(point.y || 0) / bounds.modelHeight) * bounds.height;
		const radius = Math.max(8, Math.min(18, Math.log(Math.max(2, Math.min(bounds.modelWidth, bounds.modelHeight))) * 2.6));
		ctx.save();
		ctx.lineWidth = 3;
		ctx.strokeStyle = color;
		ctx.fillStyle = "rgba(25, 29, 31, 0.55)";
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = "#ff3b3b";
		ctx.beginPath();
		ctx.arc(x, y, 2.4, 0, Math.PI * 2);
		ctx.fill();
		ctx.font = "bold 15px sans-serif";
		ctx.textBaseline = "middle";
		ctx.lineWidth = 4;
		const offsetX = x < bounds.left + bounds.width / 2 ? radius + 6 : -radius - 18;
		const offsetY = y < bounds.top + bounds.height / 2 ? radius + 8 : -radius - 8;
		ctx.strokeStyle = "rgba(0,0,0,0.75)";
		ctx.strokeText(String(index), x + offsetX, y + offsetY);
		ctx.fillStyle = labelColor;
		ctx.fillText(String(index), x + offsetX, y + offsetY);
		ctx.restore();
	}

	function drawBox(ctx, bounds, box, color) {
		const normalized = parseBox(box);
		if (!normalized) {
			return;
		}
		const x1 = bounds.left + (normalized.startX / bounds.modelWidth) * bounds.width;
		const y1 = bounds.top + (normalized.startY / bounds.modelHeight) * bounds.height;
		const x2 = bounds.left + (normalized.endX / bounds.modelWidth) * bounds.width;
		const y2 = bounds.top + (normalized.endY / bounds.modelHeight) * bounds.height;
		ctx.save();
		ctx.fillStyle = "rgba(56, 200, 255, 0.18)";
		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
		ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
		const handleSize = Math.max(10, Math.min(18, Math.min(bounds.modelWidth, bounds.modelHeight) * 0.018));
		const half = handleSize / 2;
		const handles = [
			[x1, y1],
			[x2, y1],
			[x1, y2],
			[x2, y2],
		];
		ctx.fillStyle = "rgba(56, 200, 255, 0.95)";
		ctx.strokeStyle = "rgba(16, 65, 86, 0.95)";
		ctx.lineWidth = 1.5;
		for (const [x, y] of handles) {
			ctx.fillRect(x - half, y - half, handleSize, handleSize);
			ctx.strokeRect(x - half, y - half, handleSize, handleSize);
		}
		ctx.restore();
	}

	function draw() {
		const metrics = syncLayout(false);
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, metrics.modelWidth, metrics.modelHeight);
		ctx.fillStyle = "#0f1519";
		ctx.fillRect(0, 0, metrics.modelWidth, metrics.modelHeight);
		const bounds = getViewport();
		if (editor.imageLoaded) {
			ctx.drawImage(image, bounds.left, bounds.top, bounds.width, bounds.height);
		} else {
			ctx.fillStyle = "#111b20";
			ctx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
			ctx.strokeStyle = "#34444c";
			ctx.lineWidth = 1;
			ctx.strokeRect(bounds.left + 0.5, bounds.top + 0.5, bounds.width - 1, bounds.height - 1);
		}
		editor.boxes.forEach((box) => drawBox(ctx, bounds, box, "#38c8ff"));
		if (editor.currentBox) {
			drawBox(ctx, bounds, editor.currentBox, "#79dcff");
		}
		editor.posPoints.forEach((point, index) => drawPoint(ctx, bounds, point, index, "#08cc48", "#2cff68"));
		editor.negPoints.forEach((point, index) => drawPoint(ctx, bounds, point, index, "#e03b3b", "#ff6d6d"));
	}

	let drawHandle = 0;
	function scheduleDraw() {
		window.cancelAnimationFrame(drawHandle);
		drawHandle = window.requestAnimationFrame(draw);
	}

	function syncFromWidgets() {
		sanitizeVisibleWidgets(false);
		const store = safeParseStore(storeWidget?.value);
		const state = readEditorState(node, editorStateWidget);
		const positiveSource = Array.isArray(state.positive)
			? state.positive
			: Array.isArray(state.coordinates)
				? state.coordinates
				: safeParseArray(coordsWidget?.value, Array.isArray(store.positive) ? store.positive : []);
		const negativeSource = Array.isArray(state.negative)
			? state.negative
			: Array.isArray(state.neg_coordinates)
				? state.neg_coordinates
				: safeParseArray(negCoordsWidget?.value, Array.isArray(store.negative) ? store.negative : []);
		const boxesSource = Array.isArray(state.boxes)
			? state.boxes
			: Array.isArray(state.bboxes)
				? state.bboxes
				: safeParseArray(bboxWidget?.value, safeParseArray(bboxStoreWidget?.value));
		editor.posPoints = positiveSource;
		editor.negPoints = negativeSource;
		editor.boxes = boxesSource.map(parseBox).filter(Boolean).slice(-1);
		if (!hasPoints(editor.posPoints) && !hasPoints(editor.negPoints)) {
			setDefaultPoints();
		} else {
			editor.usingDefaultPoints = false;
		}
		if (typeof state.image_store === "string" && state.image_store.trim()) {
			syncStoredImage(String(state.image_store || ""));
		}
		const stateWidth = finitePositiveNumber(state.width);
		if (stateWidth != null) {
			setWidgetValue(widthWidget, stateWidth, false);
		}
		const stateHeight = finitePositiveNumber(state.height);
		if (stateHeight != null) {
			setWidgetValue(heightWidget, stateHeight, false);
		}
		if (normalizeWidget && validNormalizeValue(state.normalize) != null) {
			setWidgetValue(normalizeWidget, coerceBoolean(state.normalize), false);
		}
		repairWidgetValues();
		scheduleDraw();
	}

	function loadCurrentPreview() {
		const linkedUrl = buildLinkedImageUrl(node);
		if (linkedUrl) {
			editor.setImageSource(linkedUrl);
			return;
		}
		const storedValue = String(imageStoreWidget?.value || node.properties?.[IMAGE_STORE_PROPERTY] || "").trim();
		if (storedValue) {
			editor.setImageSource(buildUploadedImageUrl(storedValue));
			return;
		}
		editor.clearImage();
	}

	async function loadLocalImageFromButton() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.style.display = "none";
		document.body.appendChild(input);
		input.addEventListener("change", async () => {
			const file = input.files?.[0];
			input.remove();
			if (!file) {
				return;
			}
			const objectUrl = URL.createObjectURL(file);
			editor.setImageSource(objectUrl);
			try {
				const storedValue = await uploadAndResolveFile(file);
				syncStoredImage(storedValue);
				writeBack();
				editor.setImageSource(buildUploadedImageUrl(storedValue));
			} catch (error) {
				console.warn("[GJJ] 载入图片失败：", error);
			} finally {
				window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
			}
		}, { once: true });
		input.click();
	}

	function clearLocalImage() {
		syncStoredImage("");
		editor.clearImage();
		writeBack();
		loadCurrentPreview();
		scheduleDraw();
	}

	function newCanvas() {
		syncStoredImage("");
		setDefaultPoints();
		editor.boxes = [];
		editor.currentBox = null;
		editor.drawingBox = false;
		editor.boxDragMode = null;
		editor.boxDragStartPoint = null;
		editor.boxDragStartBox = null;
		writeBack();
		loadCurrentPreview();
	}

	function resetDrawing() {
		setDefaultPoints();
		editor.boxes = [makeDefaultBox()];
		editor.currentBox = null;
		editor.drawingBox = false;
		editor.boxDragMode = null;
		editor.boxDragStartPoint = null;
		editor.boxDragStartBox = null;
		editor.pendingPoint = null;
		writeBack();
	}

	function toggleMoreOutputs() {
		const current = enabledOutputKeys(node);
		const showingAll = current.length === OUTPUT_DEFS.length;
		const next = showingAll ? linkedOutputKeys(node) : OUTPUT_DEFS.map((def) => def.key);
		setEnabledOutputKeys(next);
		moreOutputsButton.title = buildOutputTitle(Boolean(node.properties[MORE_OUTPUTS_PROPERTY]));
	}

	function toggleParameterVisibility() {
		applyParameterVisibility(node, !readParametersVisible(node));
		syncSettingsControlsFromWidgets();
		writeBack();
		syncLayout(true);
		scheduleDraw();
	}

	loadButton.onclick = loadLocalImageFromButton;
	clearButton.onclick = clearLocalImage;
	newCanvasButton.onclick = newCanvas;
	resetDrawingButton.onclick = resetDrawing;
	moreOutputsButton.onclick = toggleMoreOutputs;
	settingsButton.onclick = toggleParameterVisibility;

	wrap.addEventListener("contextmenu", stopEvent);

	function getBoxHitTolerance() {
		const rect = canvas.getBoundingClientRect();
		const scaleX = editor.getModelWidth() / Math.max(1, rect.width);
		const scaleY = editor.getModelHeight() / Math.max(1, rect.height);
		return Math.max(8, 12 * Math.max(scaleX, scaleY));
	}

	function normalizeBoxForEdit(box) {
		const normalized = parseBox(box);
		if (!normalized) {
			return null;
		}
		return {
			x1: Math.min(normalized.startX, normalized.endX),
			y1: Math.min(normalized.startY, normalized.endY),
			x2: Math.max(normalized.startX, normalized.endX),
			y2: Math.max(normalized.startY, normalized.endY),
		};
	}

	function hitTestBox(point) {
		const box = normalizeBoxForEdit(editor.boxes[0]);
		if (!box) {
			return null;
		}
		const tolerance = getBoxHitTolerance();
		const nearLeft = Math.abs(point.x - box.x1) <= tolerance;
		const nearRight = Math.abs(point.x - box.x2) <= tolerance;
		const nearTop = Math.abs(point.y - box.y1) <= tolerance;
		const nearBottom = Math.abs(point.y - box.y2) <= tolerance;
		if (nearLeft && nearTop) return "resize-tl";
		if (nearRight && nearTop) return "resize-tr";
		if (nearLeft && nearBottom) return "resize-bl";
		if (nearRight && nearBottom) return "resize-br";
		if (point.x >= box.x1 && point.x <= box.x2 && point.y >= box.y1 && point.y <= box.y2) {
			return "move";
		}
		return null;
	}

	function cursorForBoxMode(mode) {
		if (mode === "move") return "move";
		if (mode === "resize-tl" || mode === "resize-br") return "nwse-resize";
		if (mode === "resize-tr" || mode === "resize-bl") return "nesw-resize";
		return "crosshair";
	}

	function startBoxEdit(mode, point) {
		const box = normalizeBoxForEdit(editor.boxes[0]);
		if (!box) {
			return false;
		}
		editor.pendingPoint = null;
		editor.drawingBox = false;
		editor.currentBox = null;
		editor.boxDragMode = mode;
		editor.boxDragStartPoint = point;
		editor.boxDragStartBox = box;
		wrap.style.cursor = cursorForBoxMode(mode);
		return true;
	}

	function releasePointer(event) {
		try {
			if (event?.pointerId != null) {
				wrap.releasePointerCapture?.(event.pointerId);
			}
		} catch {
			// Pointer capture may already be released by the browser.
		}
	}

	function updateBoxEdit(point) {
		const mode = editor.boxDragMode;
		const start = editor.boxDragStartPoint;
		const box = editor.boxDragStartBox;
		if (!mode || !start || !box) {
			return;
		}
		const width = editor.getModelWidth();
		const height = editor.getModelHeight();
		let x1 = box.x1;
		let y1 = box.y1;
		let x2 = box.x2;
		let y2 = box.y2;
		if (mode === "move") {
			const boxWidth = box.x2 - box.x1;
			const boxHeight = box.y2 - box.y1;
			const targetX = Math.max(0, Math.min(width - boxWidth, box.x1 + point.x - start.x));
			const targetY = Math.max(0, Math.min(height - boxHeight, box.y1 + point.y - start.y));
			editor.boxes = [{ startX: targetX, startY: targetY, endX: targetX + boxWidth, endY: targetY + boxHeight }];
			return;
		}
		if (mode.includes("l")) x1 = point.x;
		if (mode.includes("r")) x2 = point.x;
		if (mode.includes("t")) y1 = point.y;
		if (mode.includes("b")) y2 = point.y;
		editor.boxes = [{
			startX: Math.max(0, Math.min(width, x1)),
			startY: Math.max(0, Math.min(height, y1)),
			endX: Math.max(0, Math.min(width, x2)),
			endY: Math.max(0, Math.min(height, y2)),
		}];
	}

	function startBox(point) {
		editor.pendingPoint = null;
		editor.drawingBox = true;
		editor.boxDragMode = null;
		editor.boxDragStartPoint = null;
		editor.boxDragStartBox = null;
		editor.boxes = [];
		editor.currentBox = { startX: point.x, startY: point.y, endX: point.x, endY: point.y };
		wrap.style.cursor = "crosshair";
		scheduleDraw();
	}

	wrap.addEventListener("pointerdown", (event) => {
		stopEvent(event);
		wrap.setPointerCapture?.(event.pointerId);
		const point = toModelPoint(event);
		if (!point) {
			return;
		}
		if (event.button === 2) {
			editor.usingDefaultPoints = false;
			editor.negPoints.push(point);
			releasePointer(event);
			writeBack();
			return;
		}
		const boxMode = hitTestBox(point);
		if (event.button === 0 && !event.ctrlKey && boxMode && startBoxEdit(boxMode, point)) {
			return;
		}
		if (event.ctrlKey) {
			startBox(point);
			return;
		}
		editor.pendingPoint = {
			point,
			clientX: event.clientX,
			clientY: event.clientY,
			pointerId: event.pointerId,
		};
	});

	wrap.addEventListener("pointermove", (event) => {
		const point = toModelPoint(event, Boolean(editor.boxDragMode || editor.drawingBox));
		if (editor.boxDragMode) {
			stopEvent(event);
			if (point) {
				updateBoxEdit(point);
				scheduleDraw();
			}
			return;
		}
		if (editor.pendingPoint && event.pointerId === editor.pendingPoint.pointerId) {
			const moved = Math.hypot(event.clientX - editor.pendingPoint.clientX, event.clientY - editor.pendingPoint.clientY);
			if (moved >= 6) {
				stopEvent(event);
				startBox(editor.pendingPoint.point);
			}
		}
		if (!editor.drawingBox || !editor.currentBox) {
			if (!editor.pendingPoint && point) {
				wrap.style.cursor = cursorForBoxMode(hitTestBox(point));
			}
			return;
		}
		stopEvent(event);
		if (!point) {
			return;
		}
		editor.currentBox.endX = point.x;
		editor.currentBox.endY = point.y;
		scheduleDraw();
	});

	function finishPointer(event) {
		if (editor.boxDragMode) {
			stopEvent(event);
			editor.boxes = editor.boxes.map(parseBox).filter(Boolean).slice(-1);
			editor.boxDragMode = null;
			editor.boxDragStartPoint = null;
			editor.boxDragStartBox = null;
			wrap.style.cursor = "crosshair";
			releasePointer(event);
			writeBack();
			return;
		}
		if (editor.pendingPoint && event.pointerId === editor.pendingPoint.pointerId) {
			stopEvent(event);
			editor.usingDefaultPoints = false;
			editor.posPoints.push(editor.pendingPoint.point);
			editor.pendingPoint = null;
			releasePointer(event);
			writeBack();
			return;
		}
		if (!editor.drawingBox || !editor.currentBox) {
			return;
		}
		stopEvent(event);
		const point = toModelPoint(event, true);
		if (point) {
			editor.currentBox.endX = point.x;
			editor.currentBox.endY = point.y;
		}
		const box = parseBox(editor.currentBox);
		if (box && Math.abs(box.endX - box.startX) > 0 && Math.abs(box.endY - box.startY) > 0) {
			editor.boxes = [box];
		}
		editor.currentBox = null;
		editor.drawingBox = false;
		wrap.style.cursor = "crosshair";
		releasePointer(event);
		writeBack();
	}

	wrap.addEventListener("pointerup", finishPointer);
	wrap.addEventListener("pointercancel", finishPointer);
	canvas.addEventListener("pointerup", finishPointer);
	canvas.addEventListener("pointercancel", finishPointer);
	window.addEventListener("pointerup", finishPointer);

	image.onload = () => {
		editor.imageLoaded = true;
		repairWidgetValues(true);
		syncImageSizeFromSource();
		if (editor.usingDefaultPoints) {
			setDefaultPoints();
			writeBack();
		}
		syncLayout();
		scheduleDraw();
	};
	image.onerror = () => {
		editor.imageLoaded = false;
		syncLayout();
		scheduleDraw();
	};

	const widget = node.addDOMWidget("gjj_points_editor", "gjj_points_editor", root, {
		hideOnZoom: false,
		getHeight: () => getStoredHeight(node),
		getMinHeight: () => DEFAULT_NODE_HEIGHT,
		getMaxHeight: () => getStoredHeight(node),
	});
	widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || getStoredWidth(node))), getStoredHeight(node)];

	node.__gjjPointsEditor = {
		widget,
		editor,
		draw: scheduleDraw,
		syncFromWidgets,
		loadCurrentPreview,
		toggleMoreOutputs,
		moreOutputsButton,
		toggleParameterVisibility,
		settingsButton,
		settingsPanel,
		repairWidgetValues,
		writeBack,
		buildEditorState,
		syncLayout: () => syncLayout(true),
	};

	applyParameterVisibility(node);
	syncFromWidgets();
	repairWidgetValues();
	writeBack();
	loadCurrentPreview();
	syncLayout();
	stabilizeOutputs(node);
	return node.__gjjPointsEditor;
}

function patchNode(node) {
	if (!node || node.__gjjPointsPatched) {
		return;
	}
	node.__gjjPointsPatched = true;
	node.properties ||= {};
	if (!node.properties[WIDTH_PROPERTY]) {
		node.properties[WIDTH_PROPERTY] = Math.max(MIN_NODE_WIDTH, DEFAULT_NODE_WIDTH, Number(node.size?.[0] || 0));
	}
	if (!node.properties[HEIGHT_PROPERTY]) {
		node.properties[HEIGHT_PROPERTY] = Math.max(DEFAULT_NODE_HEIGHT, Number(node.size?.[1] || 0));
	}
	compactPointsNode(node);
	ensureEditor(node);
	compactPointsNode(node);
	ensureNodeSize(node);
	stabilizeOutputs(node);
	graphDirty();
}

function afterNodeReady(node) {
	patchNode(node);
	const view = ensureEditor(node);
	compactPointsNode(node);
	view.syncFromWidgets();
	view.repairWidgetValues?.(true);
	view.loadCurrentPreview();
	view.syncLayout?.();
	stabilizeOutputs(node);
	for (const delay of [0, 120, 450, 1000, 2000]) {
		window.setTimeout(() => {
			const delayedView = ensureEditor(node);
			compactPointsNode(node);
			delayedView.repairWidgetValues?.(true);
			delayedView.syncLayout?.();
			delayedView.draw?.();
		}, delay);
	}
}

app.registerExtension({
	name: "GJJ.PointsEditor",
	beforeQueuePrompt() {
		syncAllPointsEditorsToWidgets();
	},
	beforeQueued() {
		syncAllPointsEditorsToWidgets();
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			afterNodeReady(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			ensureNodeSize(this);
			afterNodeReady(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			if (message?.bg_image?.[0]) {
				ensureEditor(this).editor.setImageSource(`data:image/png;base64,${message.bg_image[0]}`);
			}
			ensureEditor(this).draw();
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			window.setTimeout(() => {
				ensureEditor(this).loadCurrentPreview();
				stabilizeOutputs(this);
			}, 0);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (this.__gjjPointsApplyingSize) {
				return result;
			}
			this.properties ||= {};
			this.properties[WIDTH_PROPERTY] = Math.max(MIN_NODE_WIDTH, Number(this.size?.[0] || 0));
			const view = ensureEditor(this);
			try {
				this.__gjjPointsApplyingSize = true;
				view.syncLayout?.();
			} finally {
				this.__gjjPointsApplyingSize = false;
			}
			view.draw();
			return result;
		};

	const originalOnSerialize = nodeType.prototype.onSerialize;
	nodeType.prototype.onSerialize = function (data) {
		const result = originalOnSerialize?.apply(this, arguments);
		ensureEditor(this).writeBack?.();
		persistNodeSize(this);
		if (data) {
			data.properties ||= {};
			data.properties[WIDTH_PROPERTY] = this.properties?.[WIDTH_PROPERTY];
			data.properties[HEIGHT_PROPERTY] = this.properties?.[HEIGHT_PROPERTY];
			data.properties[MORE_OUTPUTS_PROPERTY] = this.properties?.[MORE_OUTPUTS_PROPERTY] || false;
			data.properties[ENABLED_OUTPUTS_PROPERTY] = this.properties?.[ENABLED_OUTPUTS_PROPERTY] || serializeEnabledOutputs(enabledOutputKeys(this));
			data.properties[PARAMETERS_VISIBLE_PROPERTY] = readParametersVisible(this);
			data.properties[IMAGE_STORE_PROPERTY] = this.properties?.[IMAGE_STORE_PROPERTY] || "";
			data.properties[STATE_PROPERTY] = this.properties?.[STATE_PROPERTY] || "";
			writeSerializedOutputSlots(data, currentOutputDefs(this));
		}
		return result;
	};
	},
	setup() {
		patchQueuePrompt();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node.comfyClass || node.type || ""))) {
				afterNodeReady(node);
			}
		}
	},
});

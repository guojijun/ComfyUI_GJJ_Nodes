import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_BatchCropResize"]);
const MAX_GROUPS = 16;
const DIM_TYPE = "INT,STRING,FLOAT";
const INPUT_MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const OUTPUT_MEDIA_TYPE = "IMAGE";

function mediaName(index) {
	return `media_${String(index).padStart(2, "0")}`;
}

function resultName(index) {
	return `result_${String(index).padStart(2, "0")}`;
}

function mediaIndex(value) {
	const text = String(value || "").trim();
	let match = text.match(/^(?:media|result)_(\d+)$/);
	if (!match) match = text.match(/^(?:图片\/视频帧|结果)\s*(\d+)$/);
	if (!match) return null;
	const index = Number.parseInt(match[1], 10);
	return Number.isFinite(index) && index >= 1 && index <= MAX_GROUPS ? index : null;
}

function slotMediaIndex(slot) {
	return mediaIndex(slot?.name)
		|| mediaIndex(slot?.label)
		|| mediaIndex(slot?.localized_name)
		|| mediaIndex(slot?.display_name)
		|| mediaIndex(slot?.displayName);
}

function isWidthSlot(slot) {
	const values = [slot?.name, slot?.label, slot?.localized_name, slot?.display_name, slot?.displayName];
	return values.some((value) => String(value || "").trim() === "width" || String(value || "").trim() === "宽度");
}

function isHeightSlot(slot) {
	const values = [slot?.name, slot?.label, slot?.localized_name, slot?.display_name, slot?.displayName];
	return values.some((value) => String(value || "").trim() === "height" || String(value || "").trim() === "高度");
}

function hasInputLink(input) {
	return input?.link !== undefined && input?.link !== null;
}

function hasOutputLink(output) {
	return Array.isArray(output?.links) && output.links.length > 0;
}

function linkById(id) {
	if (id == null) return null;
	const links = app.graph?.links;
	if (!links) return null;
	return links instanceof Map ? links.get(id) || links.get(String(id)) : links[id];
}

function linkField(link, name) {
	if (!Array.isArray(link)) return link?.[name];
	if (name === "origin_id") return link[1];
	if (name === "origin_slot") return link[2];
	if (name === "target_id") return link[3];
	if (name === "target_slot") return link[4];
	return undefined;
}

function setLinkField(link, name, value) {
	if (!link) return;
	if (Array.isArray(link)) {
		if (name === "origin_id") link[1] = value;
		else if (name === "origin_slot") link[2] = value;
		else if (name === "target_id") link[3] = value;
		else if (name === "target_slot") link[4] = value;
		return;
	}
	link[name] = value;
}

function isLiveLink(id) {
	return id != null && !!linkById(id);
}

function cleanLabel(value) {
	const text = String(value || "").trim();
	if (!text || text === "*" || text === "undefined" || text === "null") return "";
	return text.replace(/^GJJ\s*·\s*/i, "").trim();
}

function slotLabel(slot) {
	return cleanLabel(slot?.localized_name)
		|| cleanLabel(slot?.label)
		|| cleanLabel(slot?.display_name)
		|| cleanLabel(slot?.displayName)
		|| cleanLabel(slot?.name);
}

function linkedSourceLabel(input) {
	if (!isLiveLink(input?.link)) return "";
	const link = linkById(input.link);
	const originId = linkField(link, "origin_id");
	const originSlot = linkField(link, "origin_slot");
	const sourceNode = originId != null ? app.graph?.getNodeById?.(originId) : null;
	const sourceSlot = sourceNode?.outputs?.[originSlot];
	return slotLabel(sourceSlot);
}

function linkedTargetLabel(output) {
	const links = Array.isArray(output?.links) ? output.links.filter((id) => isLiveLink(id)) : [];
	for (const id of links) {
		const link = linkById(id);
		const targetId = linkField(link, "target_id");
		const targetSlotIndex = linkField(link, "target_slot");
		const targetNode = targetId != null ? app.graph?.getNodeById?.(targetId) : null;
		const targetSlot = targetNode?.inputs?.[targetSlotIndex];
		const label = slotLabel(targetSlot);
		if (label) return label;
	}
	return "";
}

function syncSlotLinkIndices(node) {
	if (!node) return;
	for (const [slot, input] of (node.inputs || []).entries()) {
		const link = linkById(input?.link);
		if (!link) continue;
		setLinkField(link, "target_id", node.id);
		setLinkField(link, "target_slot", slot);
	}
	for (const [slot, output] of (node.outputs || []).entries()) {
		const links = Array.isArray(output?.links) ? output.links.filter((id) => isLiveLink(id)) : [];
		output.links = links.length ? links : null;
		for (const id of links) {
			const link = linkById(id);
			if (!link) continue;
			setLinkField(link, "origin_id", node.id);
			setLinkField(link, "origin_slot", slot);
		}
	}
}

function disconnectInput(node, index) {
	try {
		if (node.inputs?.[index]?.link != null) node.disconnectInput?.(index);
	} catch (_) {}
}

function removeInputSlot(node, input) {
	const index = node.inputs?.indexOf(input) ?? -1;
	if (index < 0) return;
	disconnectInput(node, index);
	try { node.removeInput?.(index); }
	catch (_) { node.inputs.splice(index, 1); }
}

function removeOutputSlot(node, output) {
	const index = node.outputs?.indexOf(output) ?? -1;
	if (index < 0) return;
	for (const linkId of [...(output.links || [])]) {
		try { node.graph?.removeLink?.(linkId); } catch (_) {}
	}
	try { node.removeOutput?.(index); }
	catch (_) { node.outputs.splice(index, 1); }
}

function pickSlot(slots, predicate) {
	const matches = (slots || []).filter(predicate);
	if (!matches.length) return null;
	return matches.find(hasInputLink) || matches.find(hasOutputLink) || matches[0];
}

function ensureInput(node, name, type) {
	let input = null;
	if (name === "width") input = pickSlot(node.inputs, isWidthSlot);
	else if (name === "height") input = pickSlot(node.inputs, isHeightSlot);
	else {
		const index = mediaIndex(name);
		input = index ? pickSlot(node.inputs, (slot) => slotMediaIndex(slot) === index) : null;
	}
	input ||= (node.inputs || []).find((slot) => slot?.name === name);
	if (!input) {
		node.addInput?.(name, type);
		input = node.inputs?.[node.inputs.length - 1];
	}
	return input;
}

function ensureOutput(node, name, type) {
	let output = null;
	if (name === "width") output = pickSlot(node.outputs, isWidthSlot);
	else if (name === "height") output = pickSlot(node.outputs, isHeightSlot);
	else {
		const index = mediaIndex(name);
		output = index ? pickSlot(node.outputs, (slot) => slotMediaIndex(slot) === index) : null;
	}
	output ||= (node.outputs || []).find((slot) => slot?.name === name);
	if (!output) {
		node.addOutput?.(name, type);
		output = node.outputs?.[node.outputs.length - 1];
	}
	return output;
}

function applyDimInput(input, name, label) {
	input.name = name;
	input.type = DIM_TYPE;
	input.label = label;
	input.localized_name = label;
	input.display_name = label;
	input.tooltip = `${label}统一目标尺寸；不连接时按第一路第一帧尺寸对齐倍数。`;
}

function applyDimOutput(output, name, label) {
	output.name = name;
	output.type = DIM_TYPE;
	output.label = label;
	output.localized_name = label;
	output.display_name = label;
	output.tooltip = `统一实际输出${label}。`;
}

function applyMediaInput(input, index, label = "") {
	label = cleanLabel(label) || `图片/视频帧 ${index}`;
	input.name = mediaName(index);
	input.type = INPUT_MEDIA_TYPE;
	input.label = label;
	input.localized_name = label;
	input.display_name = label;
	input.tooltip = "图片、批量图片或官方 VIDEO；连接后自动扩展下一路。";
	input.gjj_dynamic = true;
}

function applyResultOutput(output, index, label = "") {
	label = cleanLabel(label) || `结果 ${index}`;
	output.name = resultName(index);
	output.type = OUTPUT_MEDIA_TYPE;
	output.label = label;
	output.localized_name = label;
	output.display_name = label;
	output.tooltip = "该线路裁剪后的图片帧（IMAGE）。";
	output.gjj_dynamic = true;
}

function highestUsedMediaIndex(node) {
	let highest = 0;
	for (const input of node.inputs || []) {
		const index = slotMediaIndex(input);
		if (index && hasInputLink(input)) highest = Math.max(highest, index);
	}
	for (const output of node.outputs || []) {
		const index = slotMediaIndex(output);
		if (index && hasOutputLink(output)) highest = Math.max(highest, index);
	}
	return highest;
}

function desiredMediaCount(node) {
	return Math.max(1, Math.min(MAX_GROUPS, highestUsedMediaIndex(node) + 1));
}

function trimMediaSlots(node, count) {
	for (const input of [...(node.inputs || [])]) {
		const index = slotMediaIndex(input);
		if (index && index > count) removeInputSlot(node, input);
	}
	for (const output of [...(node.outputs || [])]) {
		const index = slotMediaIndex(output);
		if (index && index > count) removeOutputSlot(node, output);
	}
}

function removeDuplicateSlots(node, keepInputs, keepOutputs) {
	const keepInputSet = new Set(keepInputs);
	const keepOutputSet = new Set(keepOutputs);
	for (const input of [...(node.inputs || [])]) {
		if ((isWidthSlot(input) || isHeightSlot(input) || slotMediaIndex(input)) && !keepInputSet.has(input)) {
			removeInputSlot(node, input);
		}
	}
	for (const output of [...(node.outputs || [])]) {
		if ((isWidthSlot(output) || isHeightSlot(output) || slotMediaIndex(output)) && !keepOutputSet.has(output)) {
			removeOutputSlot(node, output);
		}
	}
}

function reorderSlotsInPlace(node, mediaInputs, resultOutputs) {
	// 获取当前 inputs/outputs 数组引用
	const inputs = node.inputs || [];
	const outputs = node.outputs || [];

	// 收集需要保留的 slots（按顺序）
	const widthInput = inputs.find(isWidthSlot);
	const heightInput = inputs.find(isHeightSlot);
	const otherInputs = inputs.filter((slot) => {
		return slot !== widthInput && slot !== heightInput && !slotMediaIndex(slot) && !isWidthSlot(slot) && !isHeightSlot(slot);
	});

	const widthOutput = outputs.find(isWidthSlot);
	const heightOutput = outputs.find(isHeightSlot);
	const otherOutputs = outputs.filter((slot) => {
		return slot !== widthOutput && slot !== heightOutput && !slotMediaIndex(slot) && !isWidthSlot(slot) && !isHeightSlot(slot);
	});

	// 重建 inputs 数组：先清空，再按正确顺序 push
	// 注意：不能替换数组引用，只能修改原数组内容
	inputs.length = 0;
	if (widthInput) inputs.push(widthInput);
	if (heightInput) inputs.push(heightInput);
	for (const mi of mediaInputs) {
		if (mi && !inputs.includes(mi)) inputs.push(mi);
	}
	for (const oi of otherInputs) {
		if (oi && !inputs.includes(oi)) inputs.push(oi);
	}

	outputs.length = 0;
	if (widthOutput) outputs.push(widthOutput);
	if (heightOutput) outputs.push(heightOutput);
	for (const ro of resultOutputs) {
		if (ro && !outputs.includes(ro)) outputs.push(ro);
	}
	for (const oo of otherOutputs) {
		if (oo && !outputs.includes(oo)) outputs.push(oo);
	}
}

function stabilizeNode(node) {
	if (!node) return;
	const count = desiredMediaCount(node);
	trimMediaSlots(node, count);

	const widthInput = ensureInput(node, "width", DIM_TYPE);
	const heightInput = ensureInput(node, "height", DIM_TYPE);
	applyDimInput(widthInput, "width", "宽度");
	applyDimInput(heightInput, "height", "高度");

	const mediaInputs = [];
	for (let i = 1; i <= count; i += 1) {
		const input = ensureInput(node, mediaName(i), INPUT_MEDIA_TYPE);
		applyMediaInput(input, i);
		mediaInputs.push(input);
	}

	const widthOutput = ensureOutput(node, "width", DIM_TYPE);
	const heightOutput = ensureOutput(node, "height", DIM_TYPE);
	applyDimOutput(widthOutput, "width", "宽度");
	applyDimOutput(heightOutput, "height", "高度");

	const resultOutputs = [];
	for (let i = 1; i <= count; i += 1) {
		const output = ensureOutput(node, resultName(i), OUTPUT_MEDIA_TYPE);
		applyResultOutput(output, i);
		resultOutputs.push(output);
	}

	for (let i = 1; i <= count; i += 1) {
		const input = mediaInputs[i - 1];
		const output = resultOutputs[i - 1];
		const sourceLabel = linkedSourceLabel(input);
		const targetLabel = linkedTargetLabel(output);
		applyMediaInput(input, i, sourceLabel || targetLabel);
		applyResultOutput(output, i, targetLabel || sourceLabel);
	}

	removeDuplicateSlots(node, [widthInput, heightInput, ...mediaInputs], [widthOutput, heightOutput, ...resultOutputs]);

	// 关键修复：使用 reorderSlotsInPlace 而不是直接替换数组引用
	reorderSlotsInPlace(node, mediaInputs, resultOutputs);

	syncSlotLinkIndices(node);
	node.properties = node.properties || {};
	node.properties.gjj_batch_crop_resize_media_count = count;
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjBatchCropResizeTimer);
	node.__gjjBatchCropResizeTimer = setTimeout(() => stabilizeNode(node), ms);
}

function isTargetNode(node) {
	return TARGET_NODES.has(node?.comfyClass) || TARGET_NODES.has(node?.type);
}

function registerNodeArrangerLayoutStabilizer() {
	const registry = globalThis.GJJ_NodeArrangerLayoutStabilizers ||= [];
	const id = "GJJ_BatchCropResize";
	if (registry.some((item) => item?.id === id)) return;
	registry.push({
		id,
		matches: isTargetNode,
		stabilize: (node) => stabilizeNode(node),
	});
}

globalThis.GJJ_BatchCropResize = {
	...(globalThis.GJJ_BatchCropResize || {}),
	isTargetNode,
	stabilizeNode,
	scheduleStabilize,
};

registerNodeArrangerLayoutStabilizer();

app.registerExtension({
	name: "Comfy.GJJ.BatchCropResize",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this, 20);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilizeNode(node);
		}
	},
});

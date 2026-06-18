import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_TextEncodeBooguEdit";
const INPUT_PREFIX = "image_";
const INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const MAX_INPUTS = 16;
const MIN_INPUTS = 1;

function formatInputName(index) {
	return `${INPUT_PREFIX}${index}`;
}

function inputIndex(input) {
	const text = String(input?.name || "");
	if (!text.startsWith(INPUT_PREFIX)) return Number.MAX_SAFE_INTEGER;
	const value = Number.parseInt(text.slice(INPUT_PREFIX.length), 10);
	return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function imageInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs].filter((input) => inputIndex(input) !== Number.MAX_SAFE_INTEGER).sort((a, b) => inputIndex(a) - inputIndex(b))
		: [];
}

function addImageInput(node) {
	const count = imageInputs(node).length;
	if (count >= MAX_INPUTS) return;
	node.addInput?.(formatInputName(count + 1), INPUT_TYPE);
}

function removeTrailingEmptyInputs(node) {
	const inputs = imageInputs(node);
	for (let index = inputs.length - 1; index >= MIN_INPUTS; index -= 1) {
		const input = inputs[index];
		if (input?.link != null) break;
		const slot = node.inputs?.indexOf(input);
		if (slot >= 0) node.removeInput?.(slot);
	}
}

function ensureOneTrailingInput(node) {
	const inputs = imageInputs(node);
	if (!inputs.length) {
		addImageInput(node);
		return;
	}
	if (inputs.length < MAX_INPUTS && inputs[inputs.length - 1]?.link != null) {
		addImageInput(node);
	}
}

function renameSequentially(node) {
	imageInputs(node).forEach((input, index) => {
		const number = index + 1;
		input.name = formatInputName(number);
		input.type = INPUT_TYPE;
		input.label = number === 1 ? "图片" : `图片 ${number}`;
		input.localized_name = input.label;
		input.display_name = input.label;
		input.tooltip = "支持 GJJ_BATCH_IMAGE 或 IMAGE；批量图会按顺序拆成多张 Boogu 参考图。";
	});
}

function syncLinkSlots(node) {
	const links = node?.graph?.links || app.graph?.links || {};
	for (let index = 0; index < (node.inputs?.length || 0); index += 1) {
		const linkId = node.inputs[index]?.link;
		const link = linkId != null ? links[linkId] : null;
		if (link) link.target_slot = index;
	}
}

function refresh(node) {
	try {
		node?.setDirtyCanvas?.(true, true);
		node?.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	} catch (_) {}
}

function compact(node) {
	if (!node || node.comfyClass !== NODE_NAME) return;
	removeTrailingEmptyInputs(node);
	ensureOneTrailingInput(node);
	renameSequentially(node);
	syncLinkSlots(node);
	refresh(node);
}

function scheduleCompact(node, delay = 0) {
	if (!node || node.comfyClass !== NODE_NAME) return;
	clearTimeout(node.__gjjBooguEditInputTimer);
	node.__gjjBooguEditInputTimer = setTimeout(() => compact(node), delay);
}

app.registerExtension({
	name: "GJJ.TextEncodeBooguEdit.DynamicImages",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			scheduleCompact(this, 0);
			scheduleCompact(this, 150);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			scheduleCompact(this, 0);
			scheduleCompact(this, 180);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			scheduleCompact(this, 0);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			scheduleCompact(node, 0);
		}
	},
});

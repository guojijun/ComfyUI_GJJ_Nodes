import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_ImageToBatchImage"]);
const INPUT_PREFIX = "image_";
const LEGACY_INPUT_NAME = "image";
const MIN_VISIBLE_INPUTS = 1;
const INPUT_TOOLTIP = "可接单张 IMAGE 或 IMAGE batch；节点会按输入顺序合并后打包成批量图片。";
const OUTPUT_NAME = "批量图片";
const OUTPUT_TOOLTIP = "把所有已连接图片按顺序打包成 GJJ 专用批量图片输出；尺寸不一致时会自动补齐。";

function formatInputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getInputIndex(name) {
	const text = String(name || "");
	if (text === LEGACY_INPUT_NAME) {
		return 1;
	}
	if (!text.startsWith(INPUT_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(INPUT_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getDynamicInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs].filter((input) => {
			const name = String(input?.name || "");
			return name === LEGACY_INPUT_NAME || name.startsWith(INPUT_PREFIX);
		}).sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name))
		: [];
}

function requestRedraw(node) {
	GJJ_Utils.refreshNode(node);
}

function ensureOutput(node) {
	if (!Array.isArray(node.outputs) || node.outputs.length === 0) {
		node.addOutput?.(OUTPUT_NAME, "GJJ_BATCH_IMAGE");
	}
	const output = node.outputs?.[0];
	if (output) {
		output.name = OUTPUT_NAME;
		output.label = OUTPUT_NAME;
		output.localized_name = OUTPUT_NAME;
		output.type = "GJJ_BATCH_IMAGE";
		output.tooltip = OUTPUT_TOOLTIP;
	}
}

function addDynamicInput(node) {
	const nextIndex = getDynamicInputs(node).length + 1;
	node.addInput?.(formatInputName(nextIndex), "IMAGE");
}

function ensureTrailingEmptyInput(node) {
	const inputs = getDynamicInputs(node);
	if (inputs.length === 0) {
		addDynamicInput(node);
		return;
	}
	const lastInput = inputs[inputs.length - 1];
	if (lastInput?.link) {
		addDynamicInput(node);
	}
}

function removeUnusedInputsFromEnd(node, minInputs = MIN_VISIBLE_INPUTS) {
	const inputs = getDynamicInputs(node);
	for (let index = inputs.length - 1; index >= minInputs; index -= 1) {
		const input = inputs[index];
		if (input?.link) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput?.(slotIndex);
		}
	}
}

function renameInputsSequentially(node) {
	getDynamicInputs(node).forEach((input, zeroIndex) => {
		const index = zeroIndex + 1;
		input.name = formatInputName(index);
		input.label = `图片 ${index}`;
		input.localized_name = input.label;
		input.type = "IMAGE";
		input.tooltip = INPUT_TOOLTIP;
	});
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	ensureOutput(node);
	removeUnusedInputsFromEnd(node, MIN_VISIBLE_INPUTS);
	ensureTrailingEmptyInput(node);
	renameInputsSequentially(node);
	globalThis.GJJApplyTypeColorsToNode?.(node);
	requestRedraw(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjBatchImageBridgeTimer);
	node.__gjjBatchImageBridgeTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.BatchImageBridge",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
	},
});

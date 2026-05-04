import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set([
	"GJJ_AnySwitch",
]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const INPUT_DISPLAY_PREFIX = "输入 ";
const INPUT_TOOLTIP = "按顺序检查这些输入，节点会输出第一个非空值。";
const OUTPUT_NAME = "切换结果";
const OUTPUT_TOOLTIP = "返回第一个非空输入的值；若全部为空，则输出空值。";

function formatInputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getInputIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(INPUT_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(INPUT_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs].sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name))
		: [];
}

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function ensureOutput(node) {
	if (!Array.isArray(node.outputs) || node.outputs.length === 0) {
		node.addOutput?.("输出", "*");
	}
}

function addDynamicInput(node, type = "*") {
	const nextIndex = getInputs(node).length + 1;
	node.addInput(formatInputName(nextIndex), type || "*");
}

function ensureTrailingEmptyInput(node) {
	const inputs = getInputs(node);
	if (inputs.length === 0) {
		addDynamicInput(node);
		return;
	}

	const lastInput = inputs[inputs.length - 1];
	if (lastInput?.link) {
		addDynamicInput(node, lastInput.type || "*");
	}
}

function removeUnusedInputsFromEnd(node, minInputs = MIN_VISIBLE_INPUTS) {
	const inputs = getInputs(node);
	for (let index = inputs.length - 1; index >= minInputs; index -= 1) {
		const input = inputs[index];
		if (input?.link) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
}

function renameInputsSequentially(node) {
	getInputs(node).forEach((input, index) => {
		input.name = formatInputName(index + 1);
		input.label = `${INPUT_DISPLAY_PREFIX}${index + 1}`;
		input.localized_name = input.label;
		input.tooltip = INPUT_TOOLTIP;
	});
}

function getLinkedOutputInfo(node, input) {
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const sourceSlot = sourceNode?.outputs?.[link.origin_slot];
	if (!sourceSlot) {
		return null;
	}
	return {
		type: sourceSlot.type || "*",
		label: sourceSlot.label || sourceSlot.name || sourceSlot.type || "*",
	};
}

function getLinkedInputInfo(node, output) {
	const links = Array.isArray(output?.links) ? output.links : [];
	for (const linkId of links) {
		const link = app.graph?.links?.[linkId];
		const targetNode = link?.target_id != null ? app.graph.getNodeById?.(link.target_id) : null;
		const targetSlot = targetNode?.inputs?.[link.target_slot];
		if (targetSlot) {
			return {
				type: targetSlot.type || "*",
				label: targetSlot.label || targetSlot.name || targetSlot.type || "*",
			};
		}
	}
	return null;
}

function detectConnectedType(node) {
	for (const input of getInputs(node)) {
		const info = getLinkedOutputInfo(node, input);
		if (info?.type) {
			return info;
		}
	}

	for (const output of node.outputs || []) {
		const info = getLinkedInputInfo(node, output);
		if (info?.type) {
			return info;
		}
	}

	return { type: "*", label: "输出" };
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}

	ensureOutput(node);
	removeUnusedInputsFromEnd(node, MIN_VISIBLE_INPUTS);
	ensureTrailingEmptyInput(node);
	renameInputsSequentially(node);

	const connectedType = detectConnectedType(node);
	const resolvedType = connectedType?.type || "*";
	const resolvedLabel = connectedType?.label || "输出";

	for (const input of getInputs(node)) {
		input.type = resolvedType;
	}
	for (const output of node.outputs || []) {
		output.type = resolvedType;
		output.label = Array.isArray(resolvedType) ? resolvedLabel : String(resolvedLabel || resolvedType || OUTPUT_NAME);
		output.name = OUTPUT_NAME;
		output.localized_name = OUTPUT_NAME;
		output.tooltip = OUTPUT_TOOLTIP;
	}

	setDirty(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjAnySwitchTimer);
	node.__gjjAnySwitchTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.AnySwitch",

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

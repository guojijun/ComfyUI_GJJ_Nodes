import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_TXTParagraphSplitter"]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const BASE_OUTPUT_COUNT = 2;
const INPUT_TOOLTIP = "可选外部文本/任意对象输入；分段方式为“端口”时每个端口独立成段，其它模式会合并进主文本。";
const OUTPUT_TOOLTIPS = [
	"筛选后的段落数量。",
	"只输出“输出段落”参数指定的单个段落；0 或超出范围时输出空字符串。",
];

function formatInputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getInputIndex(name) {
	const match = String(name || "").match(/^any_0*(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function dynamicInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => getInputIndex(input?.name) !== Number.MAX_SAFE_INTEGER).sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name))
		: [];
}

function addDynamicInput(node, type = "*") {
	const nextIndex = dynamicInputs(node).length + 1;
	node.addInput?.(formatInputName(nextIndex), type || "*");
}

function ensureTrailingEmptyInput(node) {
	const inputs = dynamicInputs(node);
	if (!inputs.length) {
		addDynamicInput(node);
		return;
	}
	const last = inputs[inputs.length - 1];
	if (last?.link != null) {
		addDynamicInput(node, last.type || "*");
	}
}

function removeUnusedTrailingInputs(node) {
	const inputs = dynamicInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_INPUTS; index -= 1) {
		const input = inputs[index];
		if (input?.link != null) break;
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) node.removeInput(slotIndex);
	}
}

function getLinkedOutputType(input) {
	const link = input?.link != null ? app.graph?.links?.[input.link] : null;
	const sourceNode = link?.origin_id != null ? app.graph?.getNodeById?.(link.origin_id) : null;
	return sourceNode?.outputs?.[link?.origin_slot]?.type || "*";
}

function renameSequentially(node) {
	for (const [index, input] of dynamicInputs(node).entries()) {
		const number = index + 1;
		input.name = formatInputName(number);
		input.label = `输入 ${number}`;
		input.localized_name = input.label;
		input.tooltip = INPUT_TOOLTIP;
		input.type = getLinkedOutputType(input) || "*";
	}
}

function applyOutputVisibility(node, output, index) {
	if (!output) return;

	if (index === 0) {
		output.name = "段落数量";
		output.label = "段落数量";
		output.localized_name = "段落数量";
		output.type = "INT";
		output.tooltip = OUTPUT_TOOLTIPS[0];
	} else if (index === 1) {
		output.name = "指定段落";
		output.label = "指定段落";
		output.localized_name = "指定段落";
		output.type = "STRING";
		output.tooltip = OUTPUT_TOOLTIPS[1];
	}

	const visible = index < BASE_OUTPUT_COUNT;
	output.hidden = !visible;
	output.visible = visible;
	output.disabled = !visible;
	output.not_show = !visible;

	if (typeof node.hideOutput === "function") {
		try {
			node.hideOutput(index, !visible);
		} catch (_) {
			// Older ComfyUI builds may not expose hideOutput.
		}
	}
}

function stabilizeOutputs(node) {
	if (!Array.isArray(node?.outputs)) return;
	for (let index = node.outputs.length - 1; index >= BASE_OUTPUT_COUNT; index -= 1) {
		try {
			node.removeOutput(index);
		} catch (_) {
			node.outputs.splice(index, 1);
		}
	}
	node.outputs.forEach((output, index) => applyOutputVisibility(node, output, index));
}

function stabilizeNode(node) {
	if (!node) return;
	removeUnusedTrailingInputs(node);
	ensureTrailingEmptyInput(node);
	renameSequentially(node);
	stabilizeOutputs(node);
	GJJ_Utils.scheduleRefreshNode(node, { delay: 0, minWidth: 340 });
}

function scheduleStabilize(node, delay = 32) {
	clearTimeout(node.__gjjTxtParagraphSplitterTimer);
	node.__gjjTxtParagraphSplitterTimer = setTimeout(() => stabilizeNode(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.TXTParagraphSplitter",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const serialized = args[0];
			const values = serialized?.widgets_values;
			if (Array.isArray(values) && values.length >= 8) {
				serialized.widgets_values = [values[0], values[1], values[2], values[4]];
			}
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

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalOnDrawBackground?.apply(this, args);
			stabilizeOutputs(this);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilizeNode(node);
		}
	},
});

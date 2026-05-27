import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_AdvancedPassthroughRouter"]);
const SLOT_PREFIX = "any_";
const OUTPUT_PREFIX = "out_";
const MIN_PAIRS = 1;
const MAX_PAIRS = 64;
const DEFAULT_TYPE = "*";
const HELP_WIDGET_NAME = "gjj_help_button";
const COMPACT_MIN_WIDTH = 40;
const COMPACT_DEFAULT_WIDTH = 140;
const INPUT_TOOLTIP = "透传任意类型数据；连接后会自动追加下一组输入/输出。";
const OUTPUT_TOOLTIP = "输出同序号输入口的数据，类型和标签会跟随输入来源。";

function getNoTitleMode() {
	return globalThis.LiteGraph?.TitleMode?.NO_TITLE ?? 1;
}

function getSlotHeight() {
	return Number(globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20);
}

function formatInputName(index) {
	return `${SLOT_PREFIX}${String(index).padStart(2, "0")}`;
}

function formatOutputName(index) {
	return `${OUTPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function formatFallbackLabel(index, kind) {
	return `${kind} ${index}`;
}

function orderedInputs(node) {
	return Array.isArray(node?.inputs) ? node.inputs : [];
}

function orderedOutputs(node) {
	return Array.isArray(node?.outputs) ? node.outputs : [];
}

function compactRowCount(node) {
	return Math.max(MIN_PAIRS, orderedInputs(node).length, orderedOutputs(node).length);
}

function computeCompactSize(node, out = [0, 0]) {
	const rowCount = compactRowCount(node);
	out[0] = COMPACT_MIN_WIDTH;
	out[1] = rowCount * getSlotHeight() + 6;
	return out;
}

function currentWidth(node) {
	const width = Number(node?.size?.[0]);
	return Number.isFinite(width) && width > 0 ? width : COMPACT_DEFAULT_WIDTH;
}

function suppressHelpWidget(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		if (String(node.widgets[index]?.name || "") === HELP_WIDGET_NAME) {
			node.widgets.splice(index, 1);
		}
	}
	delete node.__gjjHelpWidget;
	delete node.__gjjHelpWidgetState;
}

function applyCompactChrome(node) {
	if (!node) {
		return;
	}
	if (node.constructor) {
		node.constructor.title_mode = getNoTitleMode();
	}
	node.badges = [];
	node.drawBadges = function () {};
	suppressHelpWidget(node);
}

function setDirty(node) {
	if (!node) {
		return;
	}
	applyCompactChrome(node);
	const height = computeCompactSize(node)[1];
	node.setSize?.([currentWidth(node), height]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function isLinkedInput(input) {
	return input?.link != null;
}

function hasOutputLinks(output) {
	return Array.isArray(output?.links) && output.links.length > 0;
}

function getInputSourceInfo(input) {
	const linkId = input?.link;
	const link = linkId != null ? app.graph?.links?.[linkId] : null;
	const sourceNode = link?.origin_id != null ? app.graph?.getNodeById?.(link.origin_id) : null;
	const sourceSlot = sourceNode?.outputs?.[link.origin_slot];
	if (!sourceSlot) {
		return null;
	}
	const label = sourceSlot.label || sourceSlot.localized_name || sourceSlot.name || sourceSlot.type || DEFAULT_TYPE;
	return {
		type: sourceSlot.type || DEFAULT_TYPE,
		label: String(label),
	};
}

function getOutputTargetInfo(output) {
	const links = Array.isArray(output?.links) ? output.links : [];
	for (const linkId of links) {
		const link = app.graph?.links?.[linkId];
		const targetNode = link?.target_id != null ? app.graph?.getNodeById?.(link.target_id) : null;
		const targetSlot = targetNode?.inputs?.[link.target_slot];
		if (!targetSlot) {
			continue;
		}
		const label = targetSlot.label || targetSlot.localized_name || targetSlot.name || targetSlot.type || DEFAULT_TYPE;
		return {
			type: targetSlot.type || DEFAULT_TYPE,
			label: String(label),
		};
	}
	return null;
}

function getPairInfo(input, output, index) {
	const sourceInfo = getInputSourceInfo(input);
	if (sourceInfo?.type) {
		return sourceInfo;
	}

	const targetInfo = getOutputTargetInfo(output);
	if (targetInfo?.type) {
		return targetInfo;
	}

	const savedType = input?.type && input.type !== DEFAULT_TYPE ? input.type : output?.type;
	const savedLabel = input?.label || input?.localized_name || output?.label || output?.localized_name;
	if (savedType && savedType !== DEFAULT_TYPE && savedLabel) {
		return { type: savedType, label: String(savedLabel) };
	}

	return {
		type: DEFAULT_TYPE,
		label: formatFallbackLabel(index, "输出"),
	};
}

function removeInputAt(node, input) {
	const slotIndex = node.inputs?.indexOf(input) ?? -1;
	if (slotIndex >= 0) {
		node.removeInput(slotIndex);
	}
}

function removeOutputAt(node, output) {
	const slotIndex = node.outputs?.indexOf(output) ?? -1;
	if (slotIndex >= 0) {
		node.removeOutput(slotIndex);
	}
}

function addInput(node, index) {
	node.addInput?.(formatInputName(index), DEFAULT_TYPE);
}

function addOutput(node, index) {
	node.addOutput?.(formatOutputName(index), DEFAULT_TYPE);
}

function countNeededPairs(node) {
	const inputs = orderedInputs(node);
	const outputs = orderedOutputs(node);
	let highestUsed = 0;
	const maxLength = Math.max(inputs.length, outputs.length);
	for (let index = 1; index <= maxLength; index += 1) {
		const input = inputs[index - 1];
		const output = outputs[index - 1];
		if (isLinkedInput(input) || hasOutputLinks(output)) {
			highestUsed = index;
		}
	}
	return Math.min(MAX_PAIRS, Math.max(MIN_PAIRS, highestUsed + 1));
}

function trimToNeededPairs(node, neededPairs) {
	for (let index = orderedInputs(node).length - 1; index >= neededPairs; index -= 1) {
		const input = orderedInputs(node)[index];
		if (!isLinkedInput(input)) {
			removeInputAt(node, input);
		}
	}
	for (let index = orderedOutputs(node).length - 1; index >= neededPairs; index -= 1) {
		const output = orderedOutputs(node)[index];
		if (!hasOutputLinks(output)) {
			removeOutputAt(node, output);
		}
	}
}

function ensurePairCount(node, neededPairs) {
	while (orderedInputs(node).length < neededPairs) {
		addInput(node, orderedInputs(node).length + 1);
	}
	while (orderedOutputs(node).length < neededPairs) {
		addOutput(node, orderedOutputs(node).length + 1);
	}
	while (orderedInputs(node).length > MAX_PAIRS) {
		removeInputAt(node, orderedInputs(node).at(-1));
	}
	while (orderedOutputs(node).length > MAX_PAIRS) {
		removeOutputAt(node, orderedOutputs(node).at(-1));
	}
}

function applyPairLabels(node) {
	const inputs = orderedInputs(node);
	const outputs = orderedOutputs(node);
	const pairCount = Math.max(inputs.length, outputs.length);

	for (let zeroIndex = 0; zeroIndex < pairCount; zeroIndex += 1) {
		const index = zeroIndex + 1;
		const input = inputs[zeroIndex];
		const output = outputs[zeroIndex];
		const info = getPairInfo(input, output, index);
		const isActive = isLinkedInput(input) || hasOutputLinks(output);
		const inputLabel = isActive ? info.label : formatFallbackLabel(index, "输入");
		const outputLabel = isActive ? info.label : formatFallbackLabel(index, "输出");

		if (input) {
			input.name = formatInputName(index);
			input.type = info.type || DEFAULT_TYPE;
			input.label = inputLabel;
			input.localized_name = inputLabel;
			input.tooltip = INPUT_TOOLTIP;
		}

		if (output) {
			output.name = formatOutputName(index);
			output.type = info.type || DEFAULT_TYPE;
			output.label = outputLabel;
			output.localized_name = outputLabel;
			output.tooltip = OUTPUT_TOOLTIP;
		}
	}
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}

	const neededPairs = countNeededPairs(node);
	trimToNeededPairs(node, neededPairs);
	ensurePairCount(node, neededPairs);
	applyPairLabels(node);
	setDirty(node);
}

function linkSignature(node) {
	const inputPart = orderedInputs(node)
		.map((input) => `${input.name}:${input.link ?? ""}:${input.type ?? ""}`)
		.join("|");
	const outputPart = orderedOutputs(node)
		.map((output) => `${output.name}:${(output.links || []).join(",")}:${output.type ?? ""}`)
		.join("|");
	return `${inputPart}=>${outputPart}`;
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjAdvancedPassthroughRouterTimer);
	node.__gjjAdvancedPassthroughRouterTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.AdvancedPassthroughRouter",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		nodeType.title_mode = getNoTitleMode();
		nodeType.prototype.computeSize = function (out) {
			return computeCompactSize(this, out);
		};
		nodeType.prototype.drawBadges = function () {};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			applyCompactChrome(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			applyCompactChrome(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			applyCompactChrome(this);
			scheduleStabilize(this);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			applyCompactChrome(this);
			stabilizeNode(this);
			originalOnSerialize?.apply(this, [serializedNode, ...args]);
			if (Array.isArray(serializedNode?.inputs)) {
				serializedNode.inputs.forEach((input, index) => {
					input.name = formatInputName(index + 1);
				});
			}
			if (Array.isArray(serializedNode?.outputs)) {
				serializedNode.outputs.forEach((output, index) => {
					output.name = formatOutputName(index + 1);
				});
			}
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			applyCompactChrome(this);
			const result = originalOnDrawBackground?.apply(this, args);
			const signature = linkSignature(this);
			if (signature !== this.__gjjAdvancedPassthroughRouterSignature) {
				this.__gjjAdvancedPassthroughRouterSignature = signature;
				scheduleStabilize(this);
			}
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				applyCompactChrome(node);
				stabilizeNode(node);
			}
		}
	},
});

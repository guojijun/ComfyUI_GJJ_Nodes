import { app } from "/scripts/app.js";

const NODE_TYPE = "GJJ_ImageBatchMulti";
const IMAGE_PREFIX = "image_";
const COMPAT_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const MIN_INPUTS = 1;
const INTERNAL_WIDGET_INPUTS = new Set(["width", "height", "宽度", "高度"]);

function isTarget(node) {
	return node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE;
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

function setImageInputMeta(input, index) {
	const name = `${IMAGE_PREFIX}${String(index).padStart(2, "0")}`;
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
		node.addInput?.("image_01", COMPAT_TYPE);
		inputs = imageInputs(node);
	}
	const last = inputs[inputs.length - 1];
	if (last?.link != null) {
		node.addInput?.(`${IMAGE_PREFIX}${String(inputs.length + 1).padStart(2, "0")}`, COMPAT_TYPE);
	}
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const images = imageInputs(node);
	node.inputs = [...images];
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

function stabilize(node) {
	if (!isTarget(node)) return;
	removeInternalWidgetInputs(node);
	trimUnusedTail(node);
	ensureTrailingEmpty(node);
	imageInputs(node).forEach((input, index) => setImageInputMeta(input, index + 1));
	reorderInputs(node);
	applyOutputMeta(node);
	const signature = imageInputs(node).map((input) => `${input.name}:${input.link ?? ""}`).join("|");
	node.__gjjImageBatchMultiSignature = signature;
	setDirty(node);
}

function scheduleStabilize(node, delay = 32) {
	if (!isTarget(node)) return;
	clearTimeout(node.__gjjImageBatchMultiTimer);
	node.__gjjImageBatchMultiTimer = setTimeout(() => stabilize(node), delay);
}

function currentSignature(node) {
	return imageInputs(node).map((input) => `${input.name}:${input.link ?? ""}`).join("|");
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
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
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

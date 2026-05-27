import { app } from "/scripts/app.js";

const NODE_TYPE = "GJJ_ImageAddMulti";
const IMAGE_PREFIX = "image_";
const MIN_INPUTS = 2;
const MAX_INPUTS = 1000;

function imageIndex(name) {
	const match = String(name || "").match(/^image_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function getImageInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => /^image_\d+$/.test(String(input?.name || ""))).sort((a, b) => imageIndex(a.name) - imageIndex(b.name))
		: [];
}

function getInputCount(node) {
	const widget = node.widgets?.find?.((item) => item?.name === "inputcount");
	const raw = Number(widget?.value ?? MIN_INPUTS);
	return Math.max(MIN_INPUTS, Math.min(MAX_INPUTS, Number.isFinite(raw) ? Math.round(raw) : MIN_INPUTS));
}

function setImageInputMeta(input, index) {
	input.name = `${IMAGE_PREFIX}${index}`;
	input.type = "IMAGE";
	input.label = `图像 ${index}`;
	input.localized_name = input.label;
	input.tooltip = `第 ${index} 张参与混合的 IMAGE。`;
}

function ensureImageInputs(node) {
	if (!node) return;
	const targetCount = getInputCount(node);
	let inputs = getImageInputs(node);

	for (let index = inputs.length + 1; index <= targetCount; index += 1) {
		node.addInput?.(`${IMAGE_PREFIX}${index}`, "IMAGE");
	}

	inputs = getImageInputs(node);
	for (let index = inputs.length; index > targetCount; index -= 1) {
		const input = inputs[index - 1];
		const slot = node.inputs?.indexOf(input) ?? -1;
		if (slot >= 0) {
			try { node.disconnectInput?.(slot); } catch (_) {}
			try { node.removeInput?.(slot); } catch (_) { node.inputs.splice(slot, 1); }
		}
	}

	getImageInputs(node).forEach((input, zeroIndex) => setImageInputMeta(input, zeroIndex + 1));
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function patchInputCountWidget(node) {
	const widget = node.widgets?.find?.((item) => item?.name === "inputcount");
	if (!widget || widget.__gjjImageAddMultiPatched) return;
	widget.__gjjImageAddMultiPatched = true;
	widget.label = "输入数量";
	widget.localized_name = "输入数量";
	widget.options ||= {};
	widget.options.display_name = "输入数量";
	widget.options.tooltip = "需要混合的 IMAGE 输入数量；改变后会自动增减图像输入槽。";
	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		const result = originalCallback?.apply(this, args);
		setTimeout(() => ensureImageInputs(node), 0);
		return result;
	};
}

function stabilize(node) {
	if (!node || node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE) return;
	patchInputCountWidget(node);
	ensureImageInputs(node);
}

app.registerExtension({
	name: "GJJ.ImageAddMulti.DynamicInputs",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE) {
				stabilize(node);
			}
		}
	},
});

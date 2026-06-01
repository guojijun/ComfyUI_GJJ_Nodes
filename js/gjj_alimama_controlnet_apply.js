import { app } from "/scripts/app.js";

const TARGET_NODE = "GJJ_AliMamaControlNetApply";
const MODEL_WIDGET = "control_net_name";
const MASK_INPUT = "mask";
const VAE_INPUT = "vae";
const OPTIONAL_INPUTS = [VAE_INPUT, MASK_INPUT];
const OPTIONAL_VISIBLE_PROPERTY = "gjj_alimama_optional_inputs_visible";
const MASK_VISIBLE_PROPERTY = "gjj_alimama_mask_visible";

const VAE_INPUT_META = {
	name: VAE_INPUT,
	type: "VAE",
	label: "VAE",
	localized_name: "VAE",
	tooltip: "可选。传给官方 ControlNet Apply；部分 ControlNet 或局部重绘模型需要 VAE 编码辅助条件。",
};
const MASK_INPUT_META = {
	name: MASK_INPUT,
	type: "MASK",
	label: "遮罩",
	localized_name: "遮罩",
	tooltip: "可选。连接后按阿里妈妈局部重绘 ControlNet 逻辑处理；关闭时节点按普通 ControlNet 应用。",
};

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function inputIndex(node, name) {
	return (node?.inputs || []).findIndex((input) => input?.name === name);
}

function inputByName(node, name) {
	const index = inputIndex(node, name);
	return index >= 0 ? node.inputs[index] : null;
}

function inputHasLink(input) {
	if (!input) return false;
	if (Array.isArray(input.link)) return input.link.length > 0;
	return input.link !== null && input.link !== undefined;
}

function optionalInputsHaveLinks(node) {
	return OPTIONAL_INPUTS.some((name) => inputHasLink(inputByName(node, name)));
}

function optionalInputsVisible(node) {
	return Boolean(node?.properties?.[OPTIONAL_VISIBLE_PROPERTY])
		|| Boolean(node?.properties?.[MASK_VISIBLE_PROPERTY])
		|| optionalInputsHaveLinks(node);
}

function setDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function applyInputMeta(input, meta) {
	if (!input) return;
	input.name = meta.name;
	input.type = meta.type;
	input.label = meta.label;
	input.localized_name = meta.localized_name;
	input.tooltip = meta.tooltip;
}

function applyMaskInputMeta(input) {
	applyInputMeta(input, MASK_INPUT_META);
	input.color_on = "#EF5F7A";
	input.color_off = "#8F2F45";
}

function applyVaeInputMeta(input) {
	applyInputMeta(input, VAE_INPUT_META);
	input.color_on = "#FF6B81";
	input.color_off = "#8B3646";
}

function removeInputByName(node, name) {
	const index = inputIndex(node, name);
	if (index < 0) return;
	try { node.disconnectInput?.(index); } catch (_) {}
	try { node.removeInput?.(index); } catch (_) { node.inputs?.splice?.(index, 1); }
}

function insertInputAfter(node, inputName, afterName) {
	const index = inputIndex(node, inputName);
	const after = inputIndex(node, afterName);
	if (index < 0 || after < 0 || index === after + 1) return;
	const [input] = node.inputs.splice(index, 1);
	const updatedAfter = inputIndex(node, afterName);
	node.inputs.splice(updatedAfter + 1, 0, input);
}

function ensureOptionalInput(node, meta, afterName, applyMeta) {
	let index = inputIndex(node, meta.name);
	if (index < 0) {
		try { node.addInput?.(meta.name, meta.type); }
		catch (_) { node.inputs = [...(node.inputs || []), { ...meta, link: null }]; }
	}
	insertInputAfter(node, meta.name, afterName);
	applyMeta(inputByName(node, meta.name));
}

function ensureOptionalInputs(node) {
	ensureOptionalInput(node, VAE_INPUT_META, "image", applyVaeInputMeta);
	ensureOptionalInput(node, MASK_INPUT_META, VAE_INPUT, applyMaskInputMeta);
}

function removeOptionalInputs(node) {
	for (const name of [MASK_INPUT, VAE_INPUT]) removeInputByName(node, name);
}

function updateOptionalButton(node) {
	const button = node?.__gjjAliMamaMaskButton;
	if (!button) return;
	const visible = optionalInputsVisible(node);
	button.name = visible ? "🔌 VAE/遮罩 开" : "🔌 VAE/遮罩 关";
	button.label = button.name;
	button.value = button.name;
	button.disabled = optionalInputsHaveLinks(node);
	button.tooltip = visible
		? "VAE 与遮罩输入已显示；如已有连线，需先断开连线才能关闭。"
		: "点击显示 VAE 与遮罩输入口；默认按普通 ControlNet 应用。";
}

function stabilizeOptionalInputs(node) {
	if (!node) return;
	node.properties = node.properties || {};
	if (optionalInputsVisible(node)) {
		node.properties[OPTIONAL_VISIBLE_PROPERTY] = true;
		node.properties[MASK_VISIBLE_PROPERTY] = true;
		ensureOptionalInputs(node);
	} else {
		node.properties[OPTIONAL_VISIBLE_PROPERTY] = false;
		node.properties[MASK_VISIBLE_PROPERTY] = false;
		removeOptionalInputs(node);
	}
	updateOptionalButton(node);
	setDirty(node);
}

function ensureOptionalToggleButton(node) {
	if (!node || node.__gjjAliMamaMaskButton) return;
	const button = node.addWidget?.("button", "🔌 VAE/遮罩 关", null, () => {
		if (optionalInputsHaveLinks(node)) return;
		node.properties = node.properties || {};
		const next = !optionalInputsVisible(node);
		node.properties[OPTIONAL_VISIBLE_PROPERTY] = next;
		node.properties[MASK_VISIBLE_PROPERTY] = next;
		stabilizeOptionalInputs(node);
	});
	if (!button) return;
	button.serialize = false;
	button.options = button.options || {};
	button.options.serialize = false;
	node.__gjjAliMamaMaskButton = button;
	updateOptionalButton(node);
}

function scheduleStabilize(node, delay = 32) {
	clearTimeout(node.__gjjAliMamaMaskTimer);
	node.__gjjAliMamaMaskTimer = setTimeout(() => stabilizeOptionalInputs(node), delay);
}

function comboValues(widget) {
	const raw = widget?.options?.values || widget?.options?.comboValues || widget?.values || [];
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item) => {
			if (typeof item === "string") return item;
			return String(item?.value ?? item?.name ?? item?.label ?? "");
		})
		.map((item) => item.trim())
		.filter(Boolean);
}

function ensureDefaultModel(node) {
	const widget = getWidget(node, MODEL_WIDGET);
	if (!widget) return;
	const current = String(widget.value ?? "").trim();
	if (current) return;
	const first = comboValues(widget)[0] || "";
	if (!first) return;
	widget.value = first;
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function attachHelpModelProvider(node) {
	if (!node || node.__gjjAliMamaControlNetHelpAttached) return;
	node.__gjjAliMamaControlNetHelpAttached = true;
	node.__gjjHelpModelEntries = () => {
		const widget = getWidget(node, MODEL_WIDGET);
		const value = String(widget?.value || comboValues(widget)[0] || "").trim();
		return value
			? [{
				label: "ControlNet",
				kind: "controlnet",
				folder: "controlnet",
				value,
			}]
			: [];
	};
	node.__gjjHelpModelTreeEntries = node.__gjjHelpModelEntries;
}

function patchNode(node) {
	if (!node) return;
	if (!node.__gjjAliMamaControlNetPatched) {
		node.__gjjAliMamaControlNetPatched = true;
		attachHelpModelProvider(node);
		ensureOptionalToggleButton(node);
	}
	ensureDefaultModel(node);
	stabilizeOptionalInputs(node);
	setTimeout(() => ensureDefaultModel(node), 0);
	setTimeout(() => ensureDefaultModel(node), 80);
	setTimeout(() => stabilizeOptionalInputs(node), 0);
	setTimeout(() => stabilizeOptionalInputs(node), 80);
}

app.registerExtension({
	name: "GJJ.AliMamaControlNetApply",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			stabilizeOptionalInputs(this);
			originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[OPTIONAL_VISIBLE_PROPERTY] = optionalInputsVisible(this);
				serializedNode.properties[MASK_VISIBLE_PROPERTY] = optionalInputsVisible(this);
			}
		};
	},

	nodeCreated(node) {
		if (node?.comfyClass === TARGET_NODE || node?.type === TARGET_NODE) patchNode(node);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET_NODE || node?.type === TARGET_NODE) patchNode(node);
		}
	},
});

import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_BerniniConditioning"]);
const MIXED_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const REF_PREFIX = "reference_image_";

const INPUT_META = {
	source_video: ["source_video", "源视频帧输入。支持 IMAGE 与 GJJ_BATCH_IMAGE。"],
	reference_video: ["reference_video", "参考视频帧输入。支持 IMAGE 与 GJJ_BATCH_IMAGE。"],
};

function refIndex(name) {
	const match = String(name || "").match(/^reference_image_(\d+)$/);
	return match ? Number(match[1]) : null;
}

function isRefInput(input) {
	return refIndex(input?.name) !== null;
}

function refInputName(index) {
	return `${REF_PREFIX}${Math.max(0, Number(index) || 0)}`;
}

function isConnected(input) {
	return input?.link != null || (Array.isArray(input?.links) && input.links.length > 0);
}

function setInputMeta(input) {
	if (!input) return;
	const idx = refIndex(input.name);
	if (idx !== null) {
		input.type = MIXED_IMAGE_TYPE;
		input.label = input.name;
		input.localized_name = input.name;
		input.tooltip = `参考图片 ${idx}。支持 IMAGE 与 GJJ_BATCH_IMAGE。连接最后一个参考图口后会自动扩展。`;
		return;
	}
	const meta = INPUT_META[input.name];
	if (!meta) return;
	input.type = MIXED_IMAGE_TYPE;
	input.label = meta[0];
	input.localized_name = meta[0];
	input.tooltip = meta[1];
}

function ensureReferenceInputs(node) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;

	for (const input of node.inputs || []) setInputMeta(input);

	let refs = (node.inputs || []).filter(isRefInput);
	if (!refs.length && typeof node.addInput === "function") {
		node.addInput(refInputName(0), MIXED_IMAGE_TYPE);
		refs = (node.inputs || []).filter(isRefInput);
	}

	refs.sort((a, b) => (refIndex(a.name) ?? 0) - (refIndex(b.name) ?? 0));
	let maxConnected = -1;
	for (const input of refs) {
		const idx = refIndex(input.name);
		if (idx !== null && isConnected(input)) maxConnected = Math.max(maxConnected, idx);
	}

	const neededLast = Math.max(0, maxConnected + 1);
	for (let index = 0; index <= neededLast; index++) {
		const name = refInputName(index);
		if (!node.inputs?.some((input) => input?.name === name)) {
			node.addInput?.(name, MIXED_IMAGE_TYPE);
		}
	}

	refs = (node.inputs || []).filter(isRefInput);
	for (const input of refs) {
		const idx = refIndex(input.name);
		if (idx !== null && idx > neededLast && !isConnected(input)) {
			const slot = node.inputs.indexOf(input);
			if (slot >= 0) node.removeInput?.(slot);
		}
	}

	for (const input of node.inputs || []) setInputMeta(input);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function schedule(node, ms = 0) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	clearTimeout(node.__gjjBerniniDynamicTimer);
	node.__gjjBerniniDynamicTimer = setTimeout(() => ensureReferenceInputs(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.BerniniDynamicReferenceInputs",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			schedule(this, 0);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			schedule(this, 0);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			schedule(this, 0);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) schedule(node, 0);
		}
	},
});

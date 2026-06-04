import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_BerniniConditioning"]);
const MIXED_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";

const INPUT_META = {
	source_video: ["源视频帧", "源视频帧输入。支持 IMAGE 与 GJJ_BATCH_IMAGE。"],
	reference_video: ["参考视频帧", "参考视频帧输入。支持 IMAGE 与 GJJ_BATCH_IMAGE。"],
	reference_image_01: ["参考图 1", "参考图片或批量图片。支持 IMAGE 与 GJJ_BATCH_IMAGE。"],
	reference_image_02: ["参考图 2", "参考图片或批量图片。支持 IMAGE 与 GJJ_BATCH_IMAGE。"],
};

function applyInputMeta(node) {
	for (const input of node?.inputs || []) {
		const meta = INPUT_META[input?.name];
		if (!meta) continue;
		input.type = MIXED_IMAGE_TYPE;
		input.label = meta[0];
		input.localized_name = meta[0];
		input.tooltip = meta[1];
	}
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function scheduleApply(node, ms = 0) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	clearTimeout(node.__gjjBerniniFixedTimer);
	node.__gjjBerniniFixedTimer = setTimeout(() => applyInputMeta(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.BerniniFixedInputs",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			scheduleApply(this, 0);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			scheduleApply(this, 0);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) scheduleApply(node, 0);
		}
	},
});

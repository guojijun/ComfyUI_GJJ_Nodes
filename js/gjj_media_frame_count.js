import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_MediaFrameCount"]);
const INPUT_NAME = "media";
const BASE_LABEL = "视频/帧序列";
const OUTPUT_LABEL = "数量";
const BASE_TITLE = "GJJ · 🔢 视频帧数量";
const COMPACT_NODE_WIDTH = 220;
const COMPACT_NODE_HEIGHT = 86;
const SOCKET_ROW_Y = 64;

function getMediaInput(node) {
	return (node.inputs || []).find((input) => input?.name === INPUT_NAME)
		|| (node.inputs || [])[0]
		|| null;
}

function cleanCount(value) {
	const text = String(value ?? "").trim();
	if (!text) return "";
	const number = Number.parseInt(text, 10);
	return Number.isFinite(number) && number >= 0 ? String(number) : "";
}

function markCanvasDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function titleForCount(count = "") {
	const clean = cleanCount(count);
	return clean ? `${BASE_TITLE}（${clean}帧）` : BASE_TITLE;
}

function applySocketMetadata(node, count = "") {
	if (!node) return;
	const clean = cleanCount(count);
	node.title = titleForCount(clean);
	const input = getMediaInput(node);
	if (input) {
		input.name = INPUT_NAME;
		input.label = BASE_LABEL;
		input.localized_name = BASE_LABEL;
		input.display_name = BASE_LABEL;
		input.tooltip = "支持 GJJ_BATCH_IMAGE、IMAGE 批次和官方 VIDEO。执行后显示帧数量。";
		input.pos = [0, SOCKET_ROW_Y];
		node.properties = node.properties || {};
		if (clean) node.properties.gjj_media_frame_count = clean;
		else delete node.properties.gjj_media_frame_count;
	}
	const output = (node.outputs || [])[0];
	if (output) {
		output.name = OUTPUT_LABEL;
		output.label = OUTPUT_LABEL;
		output.localized_name = OUTPUT_LABEL;
		output.tooltip = "输入视频或帧序列的帧数量。";
		output.pos = [COMPACT_NODE_WIDTH, SOCKET_ROW_Y];
	}
}

function applyCompactSize(node) {
	if (!node) return;
	node.minWidth = COMPACT_NODE_WIDTH;
	node.min_width = COMPACT_NODE_WIDTH;
	node.size = [
		Math.round(COMPACT_NODE_WIDTH),
		Math.round(Math.max(COMPACT_NODE_HEIGHT, Number(node.size?.[1] || 0))),
	];
	node.setSize?.([COMPACT_NODE_WIDTH, node.size[1]]);
	markCanvasDirty(node);
}

function syncNode(node, count = "") {
	applySocketMetadata(node, count);
	applyCompactSize(node);
}

function applyInputLabel(node, count = "") {
	const clean = cleanCount(count);
	syncNode(node, clean);
	for (const delay of [0, 60, 180]) {
		setTimeout(() => syncNode(node, clean), delay);
	}
}

function messageCount(message) {
	const raw = Array.isArray(message?.frame_count) ? message.frame_count[0] : message?.frame_count;
	return cleanCount(raw);
}

app.registerExtension({
	name: "Comfy.GJJ.MediaFrameCount",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalComputeSize = nodeType.prototype.computeSize;
		nodeType.prototype.computeSize = function (...args) {
			const computed = originalComputeSize?.apply(this, args) || this.size || [COMPACT_NODE_WIDTH, COMPACT_NODE_HEIGHT];
			const height = Math.max(COMPACT_NODE_HEIGHT, Math.round(Number(computed?.[1] || this.size?.[1] || COMPACT_NODE_HEIGHT)));
			return [COMPACT_NODE_WIDTH, height];
		};

		const originalGetConnectionPos = nodeType.prototype.getConnectionPos;
		nodeType.prototype.getConnectionPos = function (isInput, slotNumber, out) {
			const target = out || [0, 0];
			const index = Number(slotNumber || 0);
			if (this.flags?.collapsed || index !== 0) {
				if (typeof originalGetConnectionPos === "function") {
					return originalGetConnectionPos.call(this, isInput, slotNumber, target);
				}
			}
			const x = Math.round(Number(this.pos?.[0] || 0) + (isInput ? 0 : Number(this.size?.[0] || COMPACT_NODE_WIDTH)));
			const y = Math.round(Number(this.pos?.[1] || 0) + SOCKET_ROW_Y);
			target[0] = x;
			target[1] = y;
			return target;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			applyInputLabel(this, this.properties?.gjj_media_frame_count || "");
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => applyInputLabel(this, this.properties?.gjj_media_frame_count || ""), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			const input = getMediaInput(this);
			if (!input?.link) applyInputLabel(this, "");
			else if (!this.properties?.gjj_media_frame_count) applyInputLabel(this, "");
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.call(this, message);
			applyInputLabel(this, messageCount(message));
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) applyInputLabel(node, node.properties?.gjj_media_frame_count || "");
		}
	},
});

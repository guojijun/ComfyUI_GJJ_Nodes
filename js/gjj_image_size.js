import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET = "GJJ_ImageSize";
const BASE_TITLE = "GJJ · 📐 获取图像尺寸";
const PROP_SIZE = "gjj_image_size";

function markDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function eventNodeId(event) {
	return String(event?.detail?.node_id ?? event?.detail?.node ?? event?.detail?.display_node ?? event?.detail?.nodeId ?? "");
}

function findNodeById(nodeId) {
	if (!nodeId) return null;
	return app.graph?.getNodeById?.(Number(nodeId))
		|| app.graph?._nodes?.find((node) => String(node?.id || "") === String(nodeId))
		|| null;
}

function cleanDim(value) {
	const number = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

function sizeFromMessage(message) {
	const width = cleanDim(message?.width);
	const height = cleanDim(message?.height);
	if (width > 0 && height > 0) return { width, height };
	const text = String(Array.isArray(message?.size) ? message.size[0] : message?.size || "").trim();
	if (!text || text === "未连接") return null;
	const match = text.match(/(\d+)\s*[x×]\s*(\d+)/i);
	return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function applyLabels(node, size = null) {
	if (!node) return;
	const width = cleanDim(size?.width);
	const height = cleanDim(size?.height);
	const suffix = width > 0 && height > 0 ? `（${width}×${height}）` : "";
	node.title = `${BASE_TITLE}${suffix}`;
	node.properties = node.properties || {};
	if (suffix) node.properties[PROP_SIZE] = { width, height };
	else delete node.properties[PROP_SIZE];

	const input = (node.inputs || [])[0];
	if (input) {
		input.name = "media";
		input.label = "图片或视频";
		input.localized_name = "图片或视频";
		input.tooltip = "支持 GJJ_BATCH_IMAGE、IMAGE 和 VIDEO。";
	}
	const outputs = node.outputs || [];
	if (outputs[0]) {
		outputs[0].name = "宽度";
		outputs[0].label = width > 0 ? `宽度 ${width}` : "宽度";
		outputs[0].localized_name = outputs[0].label;
	}
	if (outputs[1]) {
		outputs[1].name = "高度";
		outputs[1].label = height > 0 ? `高度 ${height}` : "高度";
		outputs[1].localized_name = outputs[1].label;
	}
	markDirty(node);
}

app.registerExtension({
	name: "Comfy.GJJ.ImageSize",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			applyLabels(this, this.properties?.[PROP_SIZE] || null);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => applyLabels(this, this.properties?.[PROP_SIZE] || null), 0);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.call(this, message);
			applyLabels(this, sizeFromMessage(message));
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET) applyLabels(node, node.properties?.[PROP_SIZE] || null);
		}
	},
});

api.addEventListener("executed", (event) => {
	const node = findNodeById(eventNodeId(event));
	if (node?.comfyClass !== TARGET) return;
	const payload = event?.detail?.output || event?.detail || {};
	applyLabels(node, sizeFromMessage(payload));
});

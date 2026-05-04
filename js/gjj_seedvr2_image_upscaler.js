import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_SeedVR2ImageUpscaler"]);
const STATUS_WIDGET_NAME = "gjj_seedvr2_status";
const COMMON_VIDEO_HEIGHT_WIDGET = "common_video_height";
const RESOLUTION_WIDGET = "resolution";

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjSeedvr2Status) {
		return node.__gjjSeedvr2Status;
	}
	const box = document.createElement("div");
	box.textContent = "等待执行";
	box.style.cssText = [
		"min-height:24px",
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:10px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		hideOnZoom: false,
		getHeight: () => 42,
	});
	node.__gjjSeedvr2Status = { widget, box };
	return node.__gjjSeedvr2Status;
}

function setStatus(node, text) {
	const box = node?.__gjjSeedvr2Status?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	refreshNode(node);
}

function getInputByName(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.find((input) => String(input?.name) === String(name)) : null;
}

function getWidget(node, name) {
	return Array.isArray(node?.widgets) ? node.widgets.find((widget) => String(widget?.name) === String(name)) : null;
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
	if (widget.inputEl) {
		widget.inputEl.value = String(value);
	}
}

function patchCommonVideoHeight(node) {
	const commonHeightWidget = getWidget(node, COMMON_VIDEO_HEIGHT_WIDGET);
	const resolutionWidget = getWidget(node, RESOLUTION_WIDGET);
	if (!commonHeightWidget || !resolutionWidget || commonHeightWidget.__gjjSeedvr2Patched) {
		return;
	}
	const originalCallback = commonHeightWidget.callback;
	commonHeightWidget.callback = function (value, ...args) {
		const result = typeof originalCallback === "function"
			? originalCallback.call(this, value, ...args)
			: undefined;
		const selected = String(value || "").trim();
		if (selected && selected !== "手动输入") {
			const parsed = Number.parseInt(selected, 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				setWidgetValue(resolutionWidget, parsed);
			}
		}
		refreshNode(node);
		return result;
	};
	const initial = String(commonHeightWidget.value || "").trim();
	if (initial && initial !== "手动输入") {
		const parsed = Number.parseInt(initial, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			setWidgetValue(resolutionWidget, parsed);
		}
	}
	commonHeightWidget.__gjjSeedvr2Patched = true;
}

function updateOutputType(node) {
	const output = Array.isArray(node?.outputs) ? node.outputs[0] : null;
	if (!output) {
		return;
	}
	const videoInput = getInputByName(node, "video");
	const imageInput = getInputByName(node, "image");
	if (videoInput?.link) {
		output.type = "VIDEO";
		output.name = "结果视频";
		output.label = "结果视频";
		output.localized_name = "结果视频";
		output.tooltip = "输入视频时输出放大后的视频，并保留原音频与帧率。";
		return;
	}
	if (imageInput?.link) {
		output.type = "IMAGE";
		output.name = "结果图像";
		output.label = "结果图像";
		output.localized_name = "结果图像";
		output.tooltip = "输入图像时输出放大后的图像。";
		return;
	}
	output.type = "*";
	output.name = "放大结果";
	output.label = "放大结果";
	output.localized_name = "放大结果";
	output.tooltip = "输入图像时输出 IMAGE，输入视频时输出 VIDEO。";
}

function patchNode(node) {
	if (!node || node.__gjjSeedvr2Patched) {
		return;
	}
	node.__gjjSeedvr2Patched = true;
	ensureStatusWidget(node);
	patchCommonVideoHeight(node);
	setStatus(node, "等待执行");
	updateOutputType(node);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.SeedVR2ImageUpscaler",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

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
			updateOutputType(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			updateOutputType(this);
			refreshNode(this);
			return result;
		};
	},
});

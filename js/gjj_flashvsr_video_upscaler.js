import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_FlashVSRVideoUpscaler"]);
const STATUS_WIDGET_NAME = "gjj_flashvsr_status";
const STATIC_FRAME_INPUT = "input_frames";
const FRAME_INPUT_PREFIX = "input_frames_";
const FRAME_INPUT_TYPE = "IMAGE";

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjFlashvsrStatus) {
		return node.__gjjFlashvsrStatus;
	}
	const box = document.createElement("div");
	box.textContent = "等待执行";
	box.style.cssText = [
		"min-height:24px",
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 42,
	});
	node.__gjjFlashvsrStatus = { widget, box };
	return node.__gjjFlashvsrStatus;
}

function setStatus(node, text) {
	const box = node?.__gjjFlashvsrStatus?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	refreshNode(node);
}

function getInputByName(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.find((input) => String(input?.name) === String(name)) : null;
}

function formatFrameInputName(index) {
	return index <= 1 ? STATIC_FRAME_INPUT : `${FRAME_INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getFrameInputIndex(input) {
	const name = String(input?.name || "");
	if (name === STATIC_FRAME_INPUT) {
		return 1;
	}
	if (name.startsWith(FRAME_INPUT_PREFIX)) {
		const parsed = Number.parseInt(name.slice(FRAME_INPUT_PREFIX.length), 10);
		return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
	}
	return Number.MAX_SAFE_INTEGER;
}

function getFrameInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs
			.filter((input) => {
				const name = String(input?.name || "");
				return name === STATIC_FRAME_INPUT || name.startsWith(FRAME_INPUT_PREFIX);
			})
			.sort((a, b) => getFrameInputIndex(a) - getFrameInputIndex(b))
		: [];
}

function addFrameInput(node) {
	const nextIndex = getFrameInputs(node).length + 1;
	node.addInput?.(formatFrameInputName(nextIndex), FRAME_INPUT_TYPE);
}

function removeUnusedFrameInputsFromEnd(node) {
	const frameInputs = getFrameInputs(node);
	for (let index = frameInputs.length - 1; index >= 1; index -= 1) {
		const input = frameInputs[index];
		if (input?.link) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
}

function ensureTrailingFrameInput(node) {
	const frameInputs = getFrameInputs(node);
	if (frameInputs.length === 0) {
		return;
	}
	const lastInput = frameInputs[frameInputs.length - 1];
	if (lastInput?.link) {
		addFrameInput(node);
	}
}

function labelFrameInputs(node) {
	getFrameInputs(node).forEach((input, index) => {
		const number = index + 1;
		input.name = formatFrameInputName(number);
		input.type = FRAME_INPUT_TYPE;
		input.label = `输入图片 ${number}`;
		input.localized_name = input.label;
		input.tooltip = "可接单张 IMAGE 或 IMAGE 批次；多路输入会按编号拼成帧序列。";
	});
}

function stabilizeFrameInputs(node) {
	if (!node) {
		return;
	}
	removeUnusedFrameInputsFromEnd(node);
	ensureTrailingFrameInput(node);
	labelFrameInputs(node);
}

function hasAnyFrameInputLink(node) {
	return getFrameInputs(node).some((input) => Boolean(input?.link));
}

function updateOutputType(node) {
	const output = Array.isArray(node?.outputs) ? node.outputs[0] : null;
	if (!output) {
		return;
	}
	const videoInput = getInputByName(node, "input_video");
	if (videoInput?.link) {
		output.type = "VIDEO";
		output.name = "结果视频";
		output.label = "结果视频";
		output.localized_name = "结果视频";
		output.tooltip = "输入视频时输出带原音轨、原帧率的超分视频。";
		return;
	}
	if (hasAnyFrameInputLink(node)) {
		output.type = "IMAGE";
		output.name = "结果帧";
		output.label = "结果帧";
		output.localized_name = "结果帧";
		output.tooltip = "输入图片或帧序列时输出超分后的 IMAGE 批次。";
		return;
	}
	output.type = "*";
	output.name = "超分结果";
	output.label = "超分结果";
	output.localized_name = "超分结果";
	output.tooltip = "输入视频时输出 VIDEO，输入图片或帧序列时输出 IMAGE。";
}

function patchNode(node) {
	if (!node || node.__gjjFlashvsrPatched) {
		return;
	}
	node.__gjjFlashvsrPatched = true;
	ensureStatusWidget(node);
	setStatus(node, "等待执行");
	stabilizeFrameInputs(node);
	updateOutputType(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjFlashvsrSlotTimer);
	node.__gjjFlashvsrSlotTimer = setTimeout(() => {
		stabilizeFrameInputs(node);
		updateOutputType(node);
		refreshNode(node);
	}, ms);
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
	name: "GJJ.FlashVSRVideoUpscaler",
	beforeRegisterNodeDef(nodeType, nodeData) {
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
			stabilizeFrameInputs(this);
			updateOutputType(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				patchNode(node);
				stabilizeFrameInputs(node);
				updateOutputType(node);
				refreshNode(node);
			}
		}
	},
});

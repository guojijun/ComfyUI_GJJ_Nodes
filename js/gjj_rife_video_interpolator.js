import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_RifeVideoInterpolator"]);
const STATUS_WIDGET_NAME = "gjj_rife_vfi_status";
const MEDIA_INPUT = {
	name: "media",
	type: "GJJ_BATCH_IMAGE,IMAGE,VIDEO",
	label: "输入媒体",
	tooltip: "单输入口兼容 GJJ_BATCH_IMAGE、IMAGE、VIDEO。接 VIDEO 时自动读取视频帧并尽量保留音频/源帧率；接普通图片或 GJJ 批量图片时自动整理为插帧帧序列。",
};

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function getLink(node, linkId) {
	const links = node?.graph?.links || app.graph?.links;
	if (linkId == null || !links) return null;
	if (Array.isArray(links)) return links.find((link) => String(Array.isArray(link) ? link[0] : link?.id) === String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function inputLinked(node, input) {
	if (!input) return false;
	const link = Array.isArray(input.link) ? input.link[0] : input.link;
	return link != null && !!getLink(node, link);
}

function setInputSlotOnLink(link, node, slot) {
	if (!link || !node) return;
	if (Array.isArray(link)) {
		link[3] = node.id;
		link[4] = slot;
		if (MEDIA_INPUT.type) link[5] = MEDIA_INPUT.type;
		return;
	}
	link.target_id = node.id;
	link.target_slot = slot;
	link.type = MEDIA_INPUT.type;
}

function repairInputLinks(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = 0; index < node.inputs.length; index++) {
		const input = node.inputs[index];
		const linkId = Array.isArray(input?.link) ? input.link[0] : input?.link;
		const link = getLink(node, linkId);
		if (link) setInputSlotOnLink(link, node, index);
	}
}

function applyMediaInput(input) {
	if (!input) return;
	input.name = MEDIA_INPUT.name;
	input.type = MEDIA_INPUT.type;
	input.label = MEDIA_INPUT.label;
	input.localized_name = MEDIA_INPUT.label;
	input.display_name = MEDIA_INPUT.label;
	input.tooltip = MEDIA_INPUT.tooltip;
}

function stabilizeMediaInput(node) {
	if (!Array.isArray(node?.inputs)) return;
	const isMedia = (input) => {
		const text = [input?.name, input?.label, input?.localized_name, input?.display_name].map((item) => String(item || "")).join(" ");
		return /\bmedia\b|输入媒体|input_video|输入视频|input_frames|输入帧序列/i.test(text);
	};
	const candidates = node.inputs.filter(isMedia);
	let picked = candidates.find((input) => inputLinked(node, input))
		|| node.inputs.find((input) => String(input?.name || "") === MEDIA_INPUT.name)
		|| candidates[0]
		|| null;
	if (!picked) {
		node.addInput?.(MEDIA_INPUT.name, MEDIA_INPUT.type);
		picked = node.inputs[node.inputs.length - 1];
	}
	applyMediaInput(picked);
	for (let index = node.inputs.length - 1; index >= 0; index--) {
		const input = node.inputs[index];
		if (input === picked || !isMedia(input)) continue;
		try { node.removeInput?.(index); } catch (_) { node.inputs.splice(index, 1); }
	}
	const others = node.inputs.filter((input) => input !== picked);
	node.inputs = [picked, ...others];
	repairInputLinks(node);
	refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjRifeVfiStatus) {
		return node.__gjjRifeVfiStatus;
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
	node.__gjjRifeVfiStatus = { widget, box };
	return node.__gjjRifeVfiStatus;
}

function setStatus(node, text) {
	const box = node?.__gjjRifeVfiStatus?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjRifeVfiPatched) {
		return;
	}
	node.__gjjRifeVfiPatched = true;
	stabilizeMediaInput(node);
	ensureStatusWidget(node);
	setStatus(node, "等待执行");
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
	name: "GJJ.RifeVideoInterpolator",
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
			setTimeout(() => stabilizeMediaInput(this), 0);
			return result;
		};
	},
});

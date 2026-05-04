import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_Wan22FirstLastVideo"]);
const STATUS_WIDGET_NAME = "gjj_wan22_flf2v_status";

function ensureStatusWidget(node) {
	if (node.__gjjWanFlf2vStatus) {
		return node.__gjjWanFlf2vStatus;
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
	node.__gjjWanFlf2vStatus = { widget, box };
	return node.__gjjWanFlf2vStatus;
}

function setStatus(node, text) {
	const box = node?.__gjjWanFlf2vStatus?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	GJJ_Utils.refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjWanFlf2vPatched) {
		return;
	}
	node.__gjjWanFlf2vPatched = true;
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
	name: "GJJ.Wan22FirstLastVideo",
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
			return result;
		};
	},
});

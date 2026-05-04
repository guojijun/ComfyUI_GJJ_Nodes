import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_LTX23FirstLastOutfit"]);
const STATUS_WIDGET_NAME = "gjj_ltx23_first_last_outfit_status";

function parseProgress(detail = {}, fallback = 0) {
	if (Number.isFinite(detail.progress)) {
		return Math.max(0, Math.min(100, Number(detail.progress) * 100));
	}
	const text = String(detail.text || "");
	const match = text.match(/(\d+)\s*\/\s*(\d+)/);
	if (match) {
		const current = Math.max(0, Number(match[1] || 0));
		const total = Math.max(1, Number(match[2] || 1));
		return Math.max(0, Math.min(100, (current / total) * 100));
	}
	if (text.includes("完成") || text.includes("失败")) {
		return 100;
	}
	return Math.max(0, Math.min(100, Number(fallback) || 0));
}

function ensureStatusWidget(node) {
	if (node.__gjjLtx23FirstLastOutfitStatus) {
		return node.__gjjLtx23FirstLastOutfitStatus;
	}

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"min-height:50px",
	].join(";");

	const text = document.createElement("div");
	text.textContent = "等待执行";
	text.style.cssText = [
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

	const progressOuter = document.createElement("div");
	progressOuter.style.cssText = [
		"height:8px",
		"border-radius:8px",
		"background:#1a262c",
		"overflow:hidden",
		"border:1px solid #33454c",
	].join(";");

	const progressInner = document.createElement("div");
	progressInner.style.cssText = [
		"height:100%",
		"width:0%",
		"background:linear-gradient(90deg,#34d399,#22c55e)",
		"transition:width 120ms ease",
	].join(";");

	progressOuter.appendChild(progressInner);
	wrap.append(text, progressOuter);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 72,
	});
	node.__gjjLtx23FirstLastOutfitStatus = { widget, wrap, text, progressInner, progress: 0 };
	return node.__gjjLtx23FirstLastOutfitStatus;
}

function setStatus(node, detail) {
	const state = ensureStatusWidget(node);
	const text = String(detail?.text || "等待执行");
	state.text.textContent = text;
	state.progress = parseProgress(detail, state.progress);
	state.progressInner.style.width = `${state.progress}%`;
	GJJ_Utils.refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjLtx23FirstLastOutfitPatched) {
		return;
	}
	node.__gjjLtx23FirstLastOutfitPatched = true;
	ensureStatusWidget(node);
	setStatus(node, { text: "等待执行", progress: 0 });
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setStatus(targetNode, detail);
});

app.registerExtension({
	name: "GJJ.LTX23FirstLastOutfit",
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

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				patchNode(node);
			}
		}
	},
});

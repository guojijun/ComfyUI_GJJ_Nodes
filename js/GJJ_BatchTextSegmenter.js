import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_BatchTextSegmenter"]);
const STALE_STATUS_WIDGET = "gjj_batch_text_segmenter_status";

function cleanupStaleStatusWidget(node) {
	if (!node?.widgets?.length) {
		return;
	}
	const staleWidgets = node.widgets.filter((widget) => widget?.name === STALE_STATUS_WIDGET);
	if (!staleWidgets.length) {
		return;
	}
	for (const widget of staleWidgets) {
		for (const element of [widget.element, widget.inputEl, widget.widget, widget.domElement].filter(Boolean)) {
			element.style.display = "none";
			element.style.pointerEvents = "none";
			element.remove?.();
		}
		widget.hidden = true;
		widget.draw = () => {};
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.y = -10000;
		widget.last_y = -10000;
	}
	node.widgets = node.widgets.filter((widget) => widget?.name !== STALE_STATUS_WIDGET);
	if (node.__gjjBatchTextSegmenterStatus?.box) {
		node.__gjjBatchTextSegmenterStatus.box.remove?.();
	}
	delete node.__gjjBatchTextSegmenterStatus;
}

function setBackingWarning(node, text) {
	const widget = GJJ_Utils.getWidget(node, "warning_panel");
	if (!widget) {
		return;
	}
	widget.value = text || "等待执行";
	if (widget.inputEl) {
		widget.inputEl.value = widget.value;
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = widget.value;
	}
}

function setStatus(node, text) {
	const value = String(text || "等待执行");
	setBackingWarning(node, value);
	GJJ_Utils.refreshNode(node);
}

function patchNode(node) {
	if (!node) {
		return;
	}
	cleanupStaleStatusWidget(node);
	if (node.__gjjBatchTextSegmenterPatched) {
		GJJ_Utils.refreshNode(node);
		return;
	}
	setStatus(node, GJJ_Utils.getWidget(node, "warning_panel")?.value || "等待执行");
	node.__gjjBatchTextSegmenterPatched = true;
	GJJ_Utils.refreshNode(node);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.BatchTextSegmenter",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			const warningText = message?.warning_text?.[0] || message?.ui?.warning_text?.[0];
			if (warningText) {
				setStatus(this, warningText);
			}
			return result;
		};
	},
	nodeCreated(node) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			patchNode(node);
		}
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				patchNode(node);
			}
		}
	},
});

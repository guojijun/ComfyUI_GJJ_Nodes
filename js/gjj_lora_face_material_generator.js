import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODE = "GJJ_LoraFaceMaterialGenerator";
const STATUS_WIDGET_NAME = "状态";
const PROGRESS_WIDGET_NAME = "进度";

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function ensureWidgets(node) {
	let statusWidget = node.widgets?.find((widget) => widget.name === STATUS_WIDGET_NAME);
	if (!statusWidget) {
		statusWidget = node.addWidget("text", STATUS_WIDGET_NAME, "等待执行");
		statusWidget.serialize = false;
	}

	let progressWidget = node.widgets?.find((widget) => widget.name === PROGRESS_WIDGET_NAME);
	if (!progressWidget) {
		progressWidget = node.addWidget("text", PROGRESS_WIDGET_NAME, "请连接一张或一批参考图。");
		progressWidget.serialize = false;
	}

	node.__gjjFaceStatusWidget = statusWidget;
	node.__gjjFaceProgressWidget = progressWidget;
}

function updateWidgetText(node) {
	ensureWidgets(node);
	const input = Array.isArray(node.inputs)
		? node.inputs.find((slot) => slot?.name === "reference_batch")
		: null;
	node.__gjjFaceProgressWidget.value = input?.link
		? "已接入参考图队列，执行后会输出素材队列和预览图板。"
		: "请连接一张或一批参考图。";
	if (!node.__gjjFaceStatusWidget.value) {
		node.__gjjFaceStatusWidget.value = "等待执行";
	}
}

function stabilizeNode(node) {
	if (!node || node.comfyClass !== TARGET_NODE) {
		return;
	}
	ensureWidgets(node);
	updateWidgetText(node);
	setDirty(node);
}

app.registerExtension({
	name: "Comfy.GJJ.LoraFaceMaterialGenerator",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			ensureWidgets(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			ensureWidgets(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			updateWidgetText(this);
			setDirty(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			originalOnExecuted?.apply(this, arguments);
			ensureWidgets(this);
			const text = message?.ui?.text?.[0];
			this.__gjjFaceStatusWidget.value = text || "执行完成";
			updateWidgetText(this);
			setDirty(this);
		};
	},

	setup() {
		api.addEventListener("executing", ({ detail }) => {
			for (const node of app.graph?._nodes || []) {
				if (node?.comfyClass !== TARGET_NODE) {
					continue;
				}
				ensureWidgets(node);
				if (detail === node.id) {
					node.__gjjFaceStatusWidget.value = "正在生成单人训练素材...";
					setDirty(node);
				}
			}
		});

		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET_NODE) {
				stabilizeNode(node);
			}
		}
	},
});

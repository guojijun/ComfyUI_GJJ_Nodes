import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_AudioSilenceTrimmer"]);
const MAX_DURATION_NAME = "max_duration";
const NUMBER_SOCKET_TYPE = "INT,FLOAT";

function normalizeMaxDurationInput(node) {
	for (const input of node?.inputs || []) {
		const name = String(input?.name || "");
		const widgetName = String(input?.widget?.name || "");
		if (name !== MAX_DURATION_NAME && widgetName !== MAX_DURATION_NAME) continue;
		input.type = NUMBER_SOCKET_TYPE;
		input.label = "最长保留时长";
		input.localized_name = "最长保留时长";
		input.tooltip = "0 表示不限；前方接口支持连接 INT 或 FLOAT。";
	}
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function scheduleNormalize(node, delay = 0) {
	setTimeout(() => normalizeMaxDurationInput(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.AudioSilenceTrimmer",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleNormalize(this, 0);
			scheduleNormalize(this, 80);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			scheduleNormalize(this, 0);
			scheduleNormalize(this, 80);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleNormalize(this, 16);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				normalizeMaxDurationInput(node);
			}
		}
	},
});

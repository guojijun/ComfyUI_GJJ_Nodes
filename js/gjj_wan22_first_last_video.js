import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_Wan22FirstLastVideo"]);
const LEGACY_WIDGETS = new Set(["gjj_wan22_flf2v_panel", "gjj_wan22_flf2v_status"]);

function markCanvasDirty() {
	app.graph?.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
}

function removeLegacyPanel(node) {
	if (!node || !Array.isArray(node.widgets)) {
		return;
	}

	let removed = false;
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		const widget = node.widgets[index];
		if (
			LEGACY_WIDGETS.has(String(widget?.name || "")) ||
			widget === node.__gjjWanFlf2vPanel?.widget ||
			widget === node.__gjjWanFlf2vStatus?.widget
		) {
			node.widgets.splice(index, 1);
			removed = true;
		}
	}

	delete node.__gjjWanFlf2vPanel;
	delete node.__gjjWanFlf2vStatus;
	delete node.__gjjWanFlf2vPatched;

	if (removed) {
		const computed = node.computeSize?.();
		if (Array.isArray(computed)) {
			node.setSize?.(computed);
		}
		markCanvasDirty();
	}
}

function isTargetNode(node) {
	return TARGET_NODES.has(String(node?.comfyClass || node?.type || ""));
}

function patchNode(node) {
	if (isTargetNode(node)) {
		removeLegacyPanel(node);
	}
}

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
	setup() {
		for (const node of app.graph?._nodes || []) {
			patchNode(node);
		}
	},
});

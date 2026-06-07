import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_Wan22FirstLastVideo"]);
const LEGACY_WIDGETS = new Set(["gjj_wan22_flf2v_panel", "gjj_wan22_flf2v_status"]);
const FPS_SOCKET_TYPE = "INT,FLOAT";

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

function isFpsInput(input) {
	const name = String(input?.name || "");
	const widgetName = String(input?.widget?.name || "");
	return name === "fps" || widgetName === "fps";
}

function linkField(link, key, arrayIndex, fallback = undefined) {
	if (!link) return fallback;
	if (typeof link === "object" && !Array.isArray(link) && key in link) return link[key];
	if (Array.isArray(link) && link.length > arrayIndex) return link[arrayIndex];
	return fallback;
}

function setLinkField(link, key, arrayIndex, value) {
	if (!link) return;
	if (typeof link === "object" && !Array.isArray(link)) link[key] = value;
	if (Array.isArray(link) && link.length > arrayIndex) link[arrayIndex] = value;
}

function getGraphLink(node, linkId) {
	const links = node?.graph?.links || app.graph?.links;
	if (!links || linkId == null) return null;
	return links[linkId] || (Array.isArray(links) ? links.find(l => String(linkField(l, "id", 0)) === String(linkId)) : null);
}

function stabilizeFrameRateInput(node) {
	if (!isTargetNode(node) || !Array.isArray(node.inputs)) return;
	for (const [index, input] of node.inputs.entries()) {
		if (!isFpsInput(input)) continue;
		input.type = FPS_SOCKET_TYPE;
		input.label ||= "🎞️ 帧率";
		input.localized_name ||= "🎞️ 帧率";
		input.slot_index = index;
		const link = input.link != null ? getGraphLink(node, input.link) : null;
		if (link) {
			setLinkField(link, "target_id", 3, node.id);
			setLinkField(link, "target_slot", 4, index);
			setLinkField(link, "type", 5, FPS_SOCKET_TYPE);
		}
	}
	markCanvasDirty();
}

function patchNode(node) {
	if (isTargetNode(node)) {
		removeLegacyPanel(node);
		stabilizeFrameRateInput(node);
	}
}

function schedulePatch(node) {
	patchNode(node);
	requestAnimationFrame(() => patchNode(node));
	setTimeout(() => patchNode(node), 120);
	setTimeout(() => patchNode(node), 400);
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
			schedulePatch(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			schedulePatch(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			requestAnimationFrame(() => stabilizeFrameRateInput(this));
			setTimeout(() => stabilizeFrameRateInput(this), 80);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			schedulePatch(node);
		}
	},
});

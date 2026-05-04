import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";

const GJJ_THEME = {
	name: "Comfy.GJJ.NodeTheme",
	categoryPrefix: "GJJ",
	header: "#1B252B",
	panel: "#141B1F",
	outline: "#3E4D54",
	text: "#E6F0EB",
};

function isGjjCategory(category) {
	return typeof category === "string" && category.startsWith(GJJ_THEME.categoryPrefix);
}

function applyTheme(node) {
	node.color = GJJ_THEME.header;
	node.bgcolor = GJJ_THEME.panel;
	node.boxcolor = GJJ_THEME.outline;
	node.fgcolor = GJJ_THEME.text;
}

app.registerExtension({
	name: GJJ_THEME.name,

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!isGjjCategory(nodeData?.category)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			applyTheme(this);
			return result;
		};
	},

	async nodeCreated(node) {
		if (isGjjCategory(node?.category) || String(node?.comfyClass || "").startsWith("GJJ")) {
			applyTheme(node);
		}
	},
});

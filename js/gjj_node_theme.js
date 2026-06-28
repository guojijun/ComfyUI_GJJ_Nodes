import { app } from "/scripts/app.js";

const GJJ_THEME = {
	name: "Comfy.GJJ.NodeTheme",
	categoryPrefix: "GJJ",
	header: "#1B252B",
	panel: "#141B1F",
	outline: "#3E4D54",
	text: "#E6F0EB",
};

const NODE_THEME_OVERRIDES = {
	GJJ_GemmaTextGenerate: {
		header: "#2B5D72",
		panel: "#111B22",
		outline: "#5EA9C6",
		text: "#E8F6FB",
	},
	GJJ_LlamaAssistant: {
		header: "#2B5D72",
		panel: "#111B22",
		outline: "#5EA9C6",
		text: "#E8F6FB",
	},
	GJJ_OllamaAssistant: {
		header: "#2B5D72",
		panel: "#111B22",
		outline: "#5EA9C6",
		text: "#E8F6FB",
	},
	GJJ_VideoUniversalModelLoader: {
		header: "#A87818",
		panel: "#211B10",
		outline: "#D6A83F",
		text: "#FFF4CC",
	},
	GJJ_VideoKijaiModelLoader: {
		header: "#A87818",
		panel: "#211B10",
		outline: "#D6A83F",
		text: "#FFF4CC",
	},
	GJJ_ModelBundleLoader: {
		header: "#A87818",
		panel: "#211B10",
		outline: "#D6A83F",
		text: "#FFF4CC",
	},
	GJJ_TemplateParams: {
		header: "#B45A16",
		panel: "#21170F",
		outline: "#F08A2A",
		text: "#FFE6CC",
	},
};
const USER_COLOR_THEME_PROPERTY = "gjj_color_theme";

function isGjjCategory(category) {
	return typeof category === "string" && category.startsWith(GJJ_THEME.categoryPrefix);
}

function nodeClassName(node, nodeData = null) {
	return String(node?.comfyClass || node?.type || nodeData?.name || "");
}

function themeForNode(node, nodeData = null) {
	return NODE_THEME_OVERRIDES[nodeClassName(node, nodeData)] || GJJ_THEME;
}

function applyTheme(node, nodeData = null) {
	const userTheme = node?.properties?.[USER_COLOR_THEME_PROPERTY];
	if (userTheme && typeof userTheme === "object") {
		node.color = userTheme.header || node.color;
		node.bgcolor = userTheme.panel || node.bgcolor;
		node.boxcolor = userTheme.outline || node.boxcolor;
		node.fgcolor = userTheme.text || node.fgcolor;
		return;
	}
	const theme = themeForNode(node, nodeData);
	node.color = theme.header;
	node.bgcolor = theme.panel;
	node.boxcolor = theme.outline;
	node.fgcolor = theme.text;
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
			applyTheme(this, nodeData);
			return result;
		};
	},

	async nodeCreated(node) {
		if (isGjjCategory(node?.category) || String(node?.comfyClass || "").startsWith("GJJ")) {
			applyTheme(node);
		}
	},
});

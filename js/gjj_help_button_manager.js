/**
 * GJJ 节点帮助按钮管理器
 * 
 * 使用 ComfyUI 标准的 getTitleButtons API 将帮助按钮（❓）添加到节点标题栏
 */

import { app } from "/scripts/app.js";

// GJJ 节点前缀列表
const GJJ_NODE_PREFIXES = ["GJJ_"];

// 帮助文档 URL 映射
const HELP_URLS = {
	"default": "https://github.com/guojijun/ComfyUI_GJJ",
};

/**
 * 获取节点的帮助 URL
 */
function getNodeHelpUrl(nodeType) {
	return HELP_URLS[nodeType] || HELP_URLS["default"];
}

/**
 * 检查是否为 GJJ 节点
 */
function isGJJNode(node) {
	if (!node?.comfyClass) return false;
	return GJJ_NODE_PREFIXES.some(prefix => node.comfyClass.startsWith(prefix));
}

/**
 * 在节点上添加帮助按钮到 title_buttons
 */
function setupHelpButton(nodeType) {
	const originalGetTitleButtons = nodeType.prototype.getTitleButtons;
	
	nodeType.prototype.getTitleButtons = function() {
		const buttons = originalGetTitleButtons ? originalGetTitleButtons.call(this) : [];
		
		// 添加帮助按钮
		buttons.push({
			content: "❓",
			callback: () => {
				const helpUrl = getNodeHelpUrl(this.comfyClass);
				window.open(helpUrl, "_blank");
			},
			hint: `查看 ${this.comfyClass} 的帮助文档`,
		});
		
		return buttons;
	};
}

/**
 * 注册扩展
 */
app.registerExtension({
	name: "GJJ.HelpButtonManager",
	
	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		// 只为 GJJ 节点添加帮助按钮
		if (isGJJNode({ comfyClass: nodeData.name })) {
			setupHelpButton(nodeType);
		}
	},
	
	async setup() {
		console.log("[GJJ] ✅ 帮助按钮管理器已加载 - 所有 GJJ 节点的 ❓ 按钮将显示在 header 右上角");
	},
});

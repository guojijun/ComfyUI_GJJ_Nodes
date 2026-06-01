/**
 * GJJ 节点帮助按钮管理器
 * 
 * 将帮助按钮（❓）固定到 GJJ 节点标题栏。
 *
 * 部分前端版本不会渲染 getTitleButtons，所以这里同时提供一个不占高度的
 * DOMWidget 兜底按钮。兜底按钮锚定节点 header，不跟随正文面板高度跳动。
 */

import { app } from "/scripts/app.js";

// GJJ 节点前缀列表
const GJJ_NODE_PREFIXES = ["GJJ_"];
const PATCH_FLAG = "__gjjHeaderHelpButtonPatched";
const BUTTON_FLAG = "__gjjHeaderHelpButton";
const FALLBACK_WIDGET_NAME = "gjj_header_help_button";
const HELP_BUTTON_SIZE = 22;
const HELP_BUTTON_RIGHT = 12;
const HELP_BUTTON_TOP = 3;

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

function openNodeHelp(node) {
	const standardizer = globalThis.GJJ_CommonNodeStandardizer;
	if (typeof standardizer?.showHelpDialog === "function") {
		standardizer.showHelpDialog(node);
		return;
	}
	const helpUrl = getNodeHelpUrl(node?.comfyClass);
	window.open(helpUrl, "_blank");
}

function refreshCanvas(node) {
	try {
		node?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	} catch (_) {}
}

function moveWidgetToFront(node, widget) {
	if (!node || !widget || !Array.isArray(node.widgets)) {
		return;
	}
	const index = node.widgets.indexOf(widget);
	if (index >= 0 && index !== node.widgets.length - 1) {
		node.widgets.splice(index, 1);
		node.widgets.push(widget);
	}
}

function widgetY(widget) {
	const lastY = Number(widget?.last_y);
	if (Number.isFinite(lastY) && lastY !== 0) {
		return lastY;
	}
	const y = Number(widget?.y);
	return Number.isFinite(y) ? y : 0;
}

function updateFallbackPosition(node) {
	const state = node?.__gjjHeaderHelpState;
	if (!state?.button) {
		return;
	}
	const width = Math.max(120, Number(node?.size?.[0] || 120));
	const x = Math.max(34, width - HELP_BUTTON_SIZE - HELP_BUTTON_RIGHT);
	const y = widgetY(state.widget);

	state.button.style.left = `${Math.round(x)}px`;
	state.button.style.top = `${Math.round(HELP_BUTTON_TOP - y)}px`;
}

function scheduleFallbackPositionUpdate(node) {
	for (const delay of [0, 16, 80, 220]) {
		setTimeout(() => updateFallbackPosition(node), delay);
	}
	try {
		requestAnimationFrame(() => updateFallbackPosition(node));
	} catch (_) {}
}

function createFallbackButton(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-header-help-wrap";
	wrap.style.cssText = [
		"position:relative",
		"width:100%",
		"height:0",
		"overflow:visible",
		"pointer-events:none",
		"box-sizing:border-box",
		"z-index:9999",
	].join(";");

	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "❓";
	button.title = `查看 ${node?.comfyClass || "GJJ 节点"} 的功能、模型和依赖`;
	button.className = "gjj-header-help-button";
	button.style.cssText = [
		"position:absolute",
		`width:${HELP_BUTTON_SIZE}px`,
		`height:${HELP_BUTTON_SIZE}px`,
		"padding:0",
		"border:1px solid rgba(113, 189, 255, 0.62)",
		"border-radius:7px",
		"background:rgba(25, 42, 50, 0.96)",
		"color:#dff4ff",
		"font-size:13px",
		"font-weight:700",
		"line-height:20px",
		"text-align:center",
		"cursor:pointer",
		"pointer-events:auto",
		"box-shadow:0 0 0 1px rgba(0, 0, 0, 0.24), 0 2px 7px rgba(0, 0, 0, 0.26)",
		"z-index:10000",
	].join(";");
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openNodeHelp(node);
	});
	wrap.appendChild(button);
	return { wrap, button };
}

function ensureFallbackHelpButton(node) {
	if (!isGJJNode(node)) {
		return null;
	}
	if (node.__gjjHeaderHelpWidget) {
		moveWidgetToFront(node, node.__gjjHeaderHelpWidget);
		scheduleFallbackPositionUpdate(node);
		return node.__gjjHeaderHelpWidget;
	}
	if (typeof node.addDOMWidget !== "function") {
		return null;
	}

	const { wrap, button } = createFallbackButton(node);
	const widget = node.addDOMWidget(FALLBACK_WIDGET_NAME, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 0,
	});
	if (!widget) {
		return null;
	}
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => 0;
	widget.serialize = false;

	node.__gjjHeaderHelpWidget = widget;
	node.__gjjHeaderHelpState = { wrap, button, widget };
	moveWidgetToFront(node, widget);
	scheduleFallbackPositionUpdate(node);
	refreshCanvas(node);
	return widget;
}

/**
 * 在节点上添加帮助按钮到 title_buttons
 */
function setupHelpButton(nodeType) {
	if (!nodeType?.prototype || nodeType.prototype[PATCH_FLAG]) {
		return;
	}
	nodeType.prototype[PATCH_FLAG] = true;
	const originalGetTitleButtons = nodeType.prototype.getTitleButtons;
	const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
	const originalOnConfigure = nodeType.prototype.onConfigure;
	const originalOnResize = nodeType.prototype.onResize;
	const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
	const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
	
	nodeType.prototype.getTitleButtons = function(...args) {
		const originalButtons = originalGetTitleButtons ? originalGetTitleButtons.apply(this, args) : [];
		const buttons = Array.isArray(originalButtons) ? [...originalButtons] : [];
		if (this?.__gjjHeaderHelpWidget) {
			return buttons;
		}
		if (buttons.some((button) => button?.[BUTTON_FLAG] || button?.content === "❓")) {
			return buttons;
		}
		
		buttons.push({
			[BUTTON_FLAG]: true,
			content: "❓",
			callback: () => {
				openNodeHelp(this);
			},
			hint: `查看 ${this.comfyClass || "GJJ 节点"} 的功能、模型和依赖`,
		});
		
		return buttons;
	};

	nodeType.prototype.onNodeCreated = function(...args) {
		const result = originalOnNodeCreated?.apply(this, args);
		ensureFallbackHelpButton(this);
		return result;
	};

	nodeType.prototype.onConfigure = function(...args) {
		const result = originalOnConfigure?.apply(this, args);
		setTimeout(() => ensureFallbackHelpButton(this), 0);
		return result;
	};

	nodeType.prototype.onResize = function(...args) {
		const result = originalOnResize?.apply(this, args);
		scheduleFallbackPositionUpdate(this);
		return result;
	};

	nodeType.prototype.onConnectionsChange = function(...args) {
		const result = originalOnConnectionsChange?.apply(this, args);
		scheduleFallbackPositionUpdate(this);
		return result;
	};

	nodeType.prototype.onDrawForeground = function(...args) {
		const result = originalOnDrawForeground?.apply(this, args);
		updateFallbackPosition(this);
		return result;
	};
}

/**
 * 注册扩展
 */
app.registerExtension({
	name: "GJJ.HelpButtonManager",
	
	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		// 只为 GJJ 节点添加帮助按钮
		if (isGJJNode({ comfyClass: nodeData?.name })) {
			setupHelpButton(nodeType);
		}
	},
	
	async setup() {
		for (const node of app.graph?._nodes || []) {
			if (isGJJNode(node)) {
				ensureFallbackHelpButton(node);
			}
		}
		console.log("[GJJ] ✅ 帮助按钮管理器已加载 - 所有 GJJ 节点的 ❓ 按钮将显示在 header 右上角");
	},
});

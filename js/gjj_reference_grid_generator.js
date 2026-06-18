import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_ReferenceGridGenerator"]);
const STATUS_WIDGET_NAME = "gjj_reference_grid_status";
const TOOLBAR_WIDGET_NAME = "gjj_reference_grid_toolbar";
const PROMPT_WIDGET = "positive_prompt";
const LAYOUT_WIDGET = "layout_mode";
const KEEP_WIDGET = "keep_models_loaded";

const EXAMPLE_PROMPT = `**左上（人物）：**一位肤色温暖的年轻亚裔女性。她深色的头发中分，编成两条长辫子垂在胸前。她身穿橄榄绿短袖T恤、卡其色工装裤、深棕色登山靴，左臂戴着黑色手表。她表情严肃而自然。

**右上（道具 - 背包）：**一个结实耐用的蓝色大型登山背包。背包外部有银色金属框架，多个侧面和顶部口袋，黑色可调节肩带，底部附近有一块棕色皮革方片。

**左中（道具 - 手杖）：**一根简单粗壮的天然木制手杖，树皮纹理粗糙，一端略微分叉或结节。

**右中（人物/动物 - 牦牛）：**一头体型庞大、健壮的牦牛，长着蓬松的白色和金色长毛，以及弯曲的灰色犄角。它身披华丽的鞍毯，毯子上饰有精美的蓝、红、黄三色图案，鞍上配有金属马镫。五彩缤纷的流苏垂挂在它的耳朵和胸前。

**左下（场景 - 风景）：**壮丽辽阔的山景。一条泥路蜿蜒穿过绿意盎然的岩石山坡，通往远处巍峨耸立、白雪皑皑的山峰，头顶是湛蓝的天空，点缀着朵朵白云。

**右下（场景 - 建筑）：**一座小巧的传统方形石砌建筑（神社或寺庙）。它有着平坦略微倾斜的屋顶，屋檐下垂着明亮的黄色布幔。窗户饰有亮蓝色边框，木门漆成红色。旁边矗立着一座小小的石塔。`;

const THREE_VIEW_PROMPT = `**三视图长版单图：**同一个角色或产品的三视图参考图，三联横向排布，front view, side view, back view，正视图、侧视图、背视图，白色背景，比例一致，服装、材质、颜色和细节完全统一，clean reference sheet, sharp details`;

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function createButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"border:1px solid #41535b",
		"background:#172026",
		"color:#dce7e2",
		"border-radius:8px",
		"padding:3px 9px",
		"font-size:11px",
		"line-height:1.2",
		"cursor:pointer",
		"white-space:nowrap",
	].join(";");
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	button.addEventListener("mouseenter", () => {
		button.style.background = "#1f2d34";
	});
	button.addEventListener("mouseleave", () => {
		button.style.background = "#172026";
	});
	return button;
}

function ensureToolbar(node) {
	if (node.__gjjReferenceGridToolbar) {
		return;
	}
	const container = document.createElement("div");
	container.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 2px;";

	container.appendChild(createButton("示例六宫格", "填入人物、道具、场景六宫格示例提示词", () => {
		setWidgetValue(getWidget(node, PROMPT_WIDGET), EXAMPLE_PROMPT);
		refreshNode(node);
	}));
	container.appendChild(createButton("六宫格 3x2", "横版六宫格：3列2行", () => {
		setWidgetValue(getWidget(node, LAYOUT_WIDGET), "3x2");
		refreshNode(node);
	}));
	container.appendChild(createButton("六宫格 2x3", "竖版六宫格：2列3行", () => {
		setWidgetValue(getWidget(node, LAYOUT_WIDGET), "2x3");
		refreshNode(node);
	}));
	container.appendChild(createButton("三视图长图", "填入单张长版三视图参考图关键词", () => {
		setWidgetValue(getWidget(node, PROMPT_WIDGET), THREE_VIEW_PROMPT);
		refreshNode(node);
	}));
	container.appendChild(createButton("清空提示词", "只保留图片输入走智能拼图", () => {
		setWidgetValue(getWidget(node, PROMPT_WIDGET), "");
		refreshNode(node);
	}));
	container.appendChild(createButton("模型常驻", "切换模型常驻缓存，重复执行更快但会占用显存/内存", () => {
		const keep = getWidget(node, KEEP_WIDGET);
		setWidgetValue(keep, !Boolean(keep?.value));
		setStatus(node, Boolean(keep?.value) ? "模型常驻：开启" : "模型常驻：关闭");
		refreshNode(node);
	}));

	const getHeight = () => Math.max(32, Math.ceil(container.scrollHeight || container.offsetHeight || 32));
	const widget = node.addDOMWidget?.(TOOLBAR_WIDGET_NAME, TOOLBAR_WIDGET_NAME, container, {
		serialize: false,
		hideOnZoom: false,
		getHeight,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(280, width || 280), getHeight()];
	}
	node.__gjjReferenceGridToolbar = widget || { element: container };
}

function ensureStatusWidget(node) {
	if (node.__gjjReferenceGridStatus) {
		return;
	}
	const box = document.createElement("div");
	box.style.cssText = [
		"padding:6px 8px",
		"border:1px solid #33434a",
		"border-radius:8px",
		"background:#10171b",
		"color:#9eb3b7",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"min-height:22px",
	].join(";");
	box.textContent = "等待执行";
	const getHeight = () => Math.max(34, Math.ceil(box.scrollHeight || box.offsetHeight || 34));
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(280, width || 280), getHeight()];
	}
	node.__gjjReferenceGridStatus = { widget, box };
}

function setStatus(node, text) {
	const box = node?.__gjjReferenceGridStatus?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "").trim() || "等待执行";
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjReferenceGridPatched) {
		return;
	}
	ensureToolbar(node);
	ensureStatusWidget(node);
	setStatus(node, "等待执行");

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = typeof originalOnConfigure === "function"
			? originalOnConfigure.apply(this, args)
			: undefined;
		setTimeout(() => {
			ensureToolbar(this);
			ensureStatusWidget(this);
			setStatus(this, "等待执行");
		}, 0);
		return result;
	};

	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = typeof originalExecuted === "function"
			? originalExecuted.apply(this, arguments)
			: undefined;
		const text = message?.text?.[0] || message?.preview_text?.[0] || "完成";
		setStatus(this, text);
		return result;
	};

	node.__gjjReferenceGridPatched = true;
	refreshNode(node);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const nodeId = String(detail.node || "");
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			continue;
		}
		if (String(node.id) === nodeId) {
			setStatus(node, detail.text || "");
		}
	}
});

app.registerExtension({
	name: "GJJ.ReferenceGridGenerator",
	async nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			return;
		}
		setTimeout(() => patchNode(node), 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				patchNode(node);
			}
		}
	},
});

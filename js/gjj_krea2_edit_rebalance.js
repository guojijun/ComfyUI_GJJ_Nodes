import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODE = "GJJ_Krea2EditRebalance";
const PANEL_WIDGET = "gjj_krea2_advanced_panel";
const ADVANCED_PROPERTY = "gjj_krea2_advanced_open";
const ADVANCED_WIDGETS = [
	"advanced_enabled",
	"positive_strength",
	"negative_strength",
	"positive_layers",
	"negative_layers",
	"enable_step",
];
const RESTORE_WIDGET_TYPES = {
	advanced_enabled: "toggle",
	positive_strength: "number",
	negative_strength: "number",
	positive_layers: "text",
	negative_layers: "text",
	enable_step: "number",
};
const WIDGET_LABELS = {
	positive_strength: "正向强度",
	negative_strength: "反向强度",
	positive_layers: "正向层权重",
	negative_layers: "反向层权重",
	enable_step: "高级分段起点",
};
const WIDGET_TOOLTIPS = {
	positive_strength: "高级模式下正向条件的整体倍率，对应 Krea2EditRebalanceC 的 positive_strength。",
	negative_strength: "高级模式下参考/反向条件的整体倍率，对应 Krea2EditRebalanceC 的 negative_strength。",
	positive_layers: "高级模式下 12 个 Krea2/Qwen-VL 条件层的正向权重，用英文逗号或分号分隔。",
	negative_layers: "高级模式下 12 个 Krea2/Qwen-VL 条件层的参考/反向权重，用英文逗号或分号分隔。",
	enable_step: "高级模式下图文条件开始生效的时间点。0 表示从采样开始使用图文条件，1 表示只使用纯文本段。",
};

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function advancedOpen(node) {
	return Boolean(node?.properties?.[ADVANCED_PROPERTY]);
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	widget.value = value;
	if (widget.inputEl) {
		if (widget.inputEl.type === "checkbox") {
			widget.inputEl.checked = Boolean(value);
		} else {
			widget.inputEl.value = value;
		}
	}
	widget.callback?.(value);
}

function collapseElement(element) {
	if (!element) return;
	element.style.display = "none";
	element.style.visibility = "hidden";
	element.style.height = "0";
	element.style.minHeight = "0";
	element.style.maxHeight = "0";
	element.style.margin = "0";
	element.style.padding = "0";
	element.style.overflow = "hidden";
}

function expandElement(element, display = "") {
	if (!element) return;
	element.style.display = display || "";
	element.style.visibility = "";
	element.style.height = "";
	element.style.minHeight = "";
	element.style.maxHeight = "";
	element.style.margin = "";
	element.style.padding = "";
	element.style.overflow = "";
}

function rememberWidget(widget) {
	if (!widget || widget.__gjjKrea2VisibilityState) return;
	widget.options = widget.options || {};
	widget.__gjjKrea2VisibilityState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		computeLayoutSize: widget.computeLayoutSize,
		draw: widget.draw,
		drawWidget: widget.drawWidget,
		mouse: widget.mouse,
		label: widget.label,
		localized_name: widget.localized_name,
		y: widget.y,
		last_y: widget.last_y,
		size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
		computedHeight: widget.computedHeight,
		margin_top: widget.margin_top,
		optionsHidden: widget.options.hidden,
		optionsDisplay: widget.options.display,
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
	};
}

function hideWidget(widget) {
	if (!widget) return;
	rememberWidget(widget);
	widget.options = widget.options || {};
	widget.__gjjUtilsHidden = true;
	widget.hidden = true;
	widget.disabled = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0 });
	widget.draw = () => {};
	widget.drawWidget = () => {};
	widget.mouse = () => false;
	widget.label = "";
	widget.localized_name = "";
	widget.y = 0;
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	collapseElement(widget.element);
	collapseElement(widget.inputEl);
	collapseElement(widget.widget);
}

function showWidget(widget) {
	if (!widget) return;
	rememberWidget(widget);
	const state = widget.__gjjKrea2VisibilityState || {};
	widget.options = widget.options || {};
	widget.__gjjUtilsHidden = false;
	widget.hidden = false;
	widget.disabled = false;
	const originalType = state.type && !String(state.type).startsWith("converted-widget:")
		? state.type
		: RESTORE_WIDGET_TYPES[widget.name] || "text";
	widget.type = originalType;
	if (state.computeSize) widget.computeSize = state.computeSize;
	else delete widget.computeSize;
	if (state.getHeight) widget.getHeight = state.getHeight;
	else delete widget.getHeight;
	if (state.computeLayoutSize) widget.computeLayoutSize = state.computeLayoutSize;
	else delete widget.computeLayoutSize;
	if (state.draw) widget.draw = state.draw;
	else delete widget.draw;
	if (state.drawWidget) widget.drawWidget = state.drawWidget;
	else delete widget.drawWidget;
	if (state.mouse) widget.mouse = state.mouse;
	else delete widget.mouse;
	if (state.y !== undefined) widget.y = state.y;
	else delete widget.y;
	if (state.last_y !== undefined) widget.last_y = state.last_y;
	else delete widget.last_y;
	if (state.computedHeight !== undefined) widget.computedHeight = state.computedHeight;
	else delete widget.computedHeight;
	if (state.margin_top !== undefined) widget.margin_top = state.margin_top;
	else delete widget.margin_top;
	if (state.size !== undefined) widget.size = Array.isArray(state.size) ? [...state.size] : state.size;
	else delete widget.size;
	widget.label = state.label ?? widget.label ?? widget.name;
	widget.localized_name = state.localized_name ?? widget.localized_name ?? widget.label;
	if (WIDGET_LABELS[widget.name]) {
		widget.label = WIDGET_LABELS[widget.name];
		widget.localized_name = WIDGET_LABELS[widget.name];
		widget.options.display_name = WIDGET_LABELS[widget.name];
	}
	if (WIDGET_TOOLTIPS[widget.name]) {
		widget.tooltip = WIDGET_TOOLTIPS[widget.name];
		widget.options.tooltip = WIDGET_TOOLTIPS[widget.name];
	}
	widget.options.hidden = state.optionsHidden === true ? false : state.optionsHidden;
	if (widget.options.hidden === undefined || widget.options.hidden === false) delete widget.options.hidden;
	widget.options.display = state.optionsDisplay === "hidden" ? "" : state.optionsDisplay;
	if (!widget.options.display) delete widget.options.display;
	expandElement(widget.element, state.elementDisplay);
	expandElement(widget.inputEl, state.inputDisplay);
	expandElement(widget.widget);
	if (widget.inputEl) {
		widget.inputEl.disabled = false;
		widget.inputEl.readOnly = false;
		widget.inputEl.style.pointerEvents = "";
	}
}

function updateButton(node) {
	const button = node?.__gjjKrea2AdvancedButton;
	if (!button) return;
	const open = advancedOpen(node);
	button.textContent = open ? "高级：开" : "高级";
	button.title = open ? "收起高级参数并恢复简化版重平衡。" : "显示并启用 Krea2EditRebalanceC 高级参数。";
	button.style.background = open ? "#263846" : "#172026";
	button.style.borderColor = open ? "#8aa8b4" : "#465960";
	button.style.color = open ? "#ffffff" : "#dce7e2";
}

function applyVisibility(node) {
	if (!node || !Array.isArray(node.widgets)) return;
	const open = advancedOpen(node);
	for (const name of ADVANCED_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		if (name === "advanced_enabled") {
			setWidgetValue(widget, open);
			hideWidget(widget);
			continue;
		}
		if (open) showWidget(widget);
		else hideWidget(widget);
	}
	updateButton(node);
	forceRefresh(node);
}

function setAdvancedOpen(node, open) {
	node.properties = node.properties || {};
	node.properties[ADVANCED_PROPERTY] = Boolean(open);
	applyVisibility(node);
}

function forceRefresh(node) {
	const refresh = () => {
		GJJ_Utils.refreshNode(node, { minWidth: 0, minHeight: 120 });
		node?.setDirtyCanvas?.(true, true);
		node?.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	};
	refresh();
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(refresh);
	for (const delay of [40, 120]) setTimeout(refresh, delay);
}

function createButton(node) {
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;overflow:hidden;";
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "高级";
	button.style.cssText = [
		"height:28px",
		"border:1px solid #465960",
		"border-radius:6px",
		"background:#172026",
		"color:#dce7e2",
		"font:700 12px system-ui,'Microsoft YaHei',sans-serif",
		"padding:0 10px",
		"cursor:pointer",
		"white-space:nowrap",
		"min-width:0",
	].join(";");
	let lastToggleAt = 0;
	const toggle = (event) => {
		event?.stopPropagation?.();
		const now = Date.now();
		if (now - lastToggleAt < 180) return;
		lastToggleAt = now;
		setAdvancedOpen(node, !advancedOpen(node));
	};
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		button.addEventListener(eventName, (event) => {
			event.stopPropagation();
		}, true);
	}
	button.addEventListener("pointerup", toggle, true);
	button.addEventListener("click", (event) => {
		toggle(event);
	}, true);
	wrap.appendChild(button);
	node.__gjjKrea2AdvancedButton = button;
	updateButton(node);
	return wrap;
}

function ensurePanel(node) {
	if (node.__gjjKrea2AdvancedPanel || typeof node.addDOMWidget !== "function") return;
	const panel = createButton(node);
	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", panel, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 220)), 32];
	}
	node.__gjjKrea2AdvancedPanel = widget || { element: panel };
}

function stabilize(node) {
	if (!node) return;
	ensurePanel(node);
	applyVisibility(node);
}

function scheduleStabilize(node) {
	for (const delay of [0, 40, 120, 300]) {
		setTimeout(() => stabilize(node), delay);
	}
}

app.registerExtension({
	name: "Comfy.GJJ.Krea2EditRebalance",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};
	},

	nodeCreated(node) {
		if (String(node?.comfyClass || node?.type || "") === TARGET_NODE) {
			scheduleStabilize(node);
		}
	},
});

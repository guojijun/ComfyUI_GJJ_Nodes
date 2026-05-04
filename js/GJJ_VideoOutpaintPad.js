import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_VideoOutpaintPad"]);
const EXPAND_WIDGET_NAME = "expand_mode";
const FILL_WIDGET_NAME = "fill_mode";
const STATUS_WIDGET_NAME = "gjj_video_outpaint_pad_status";

const MODE_MARGINS = "边距扩充";
const MODE_RATIO = "目标比例扩充";
const FILL_BLACK = "黑色";
const FILL_EDGE = "边缘延展";
const FILL_BLUR = "模糊背景";

const MARGIN_ONLY_WIDGETS = ["left", "right", "top", "bottom"];
const RATIO_ONLY_WIDGETS = ["target_ratio", "target_width", "target_height", "anchor"];
const COLOR_ONLY_WIDGETS = ["fill_color"];

function getNodeClassName(node) {
	return String(node?.comfyClass || node?.type || "");
}

function getDomHideTargets(widget) {
	const seeds = [widget?.element, widget?.inputEl].filter(Boolean);
	const targets = [];
	const seen = new Set();
	const addTarget = (element) => {
		if (!element || seen.has(element)) {
			return;
		}
		seen.add(element);
		targets.push(element);
	};

	for (const seed of seeds) {
		addTarget(seed);
		let current = seed.parentElement;
		let depth = 0;
		while (current && depth < 4) {
			const className = String(current.className || "");
			const tagName = String(current.tagName || "").toUpperCase();
			if (/widget|property|row|control|field|input/i.test(className) || tagName === "LABEL" || tagName === "LI") {
				addTarget(current);
			}
			current = current.parentElement;
			depth += 1;
		}
	}
	return targets;
}

function hideWidget(widget) {
	if (!widget || widget.__gjjVideoOutpaintHidden) {
		return;
	}
	widget.__gjjVideoOutpaintHidden = true;
	widget.__gjjOriginalType = widget.type;
	widget.__gjjOriginalHasOwnComputeSize = Object.prototype.hasOwnProperty.call(widget, "computeSize");
	widget.__gjjOriginalComputeSize = widget.computeSize;
	widget.__gjjOriginalHasOwnDraw = Object.prototype.hasOwnProperty.call(widget, "draw");
	widget.__gjjOriginalDraw = widget.draw;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.hidden = true;
	widget.y = -10000;
	widget.last_y = -10000;
	widget.__gjjDomHideTargets = getDomHideTargets(widget);
	for (const element of widget.__gjjDomHideTargets) {
		if (!element.__gjjOriginalDisplayStored) {
			element.__gjjOriginalDisplayStored = true;
			element.__gjjOriginalDisplay = element.style.display;
		}
		element.style.display = "none";
	}
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	if (widget.inputEl) {
		widget.inputEl.value = String(value);
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = value;
	}
	widget.callback?.(value);
}

function setWidgetValueSilent(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	if (widget.inputEl) {
		widget.inputEl.value = String(value);
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = value;
	}
}

function setWidgetEnabled(widget, enabled) {
	if (!widget) {
		return;
	}
	widget.disabled = !enabled;
	if (widget.options) {
		widget.options.disabled = !enabled;
	}
	const opacity = enabled ? "1" : "0.42";
	const pointerEvents = enabled ? "" : "none";
	if (widget.inputEl) {
		widget.inputEl.disabled = !enabled;
		widget.inputEl.style.opacity = opacity;
		widget.inputEl.style.pointerEvents = pointerEvents;
	}
	if (widget.element) {
		if ("disabled" in widget.element) {
			widget.element.disabled = !enabled;
		}
		widget.element.style.opacity = opacity;
		widget.element.style.pointerEvents = pointerEvents;
	}
	for (const element of getDomHideTargets(widget)) {
		element.style.opacity = opacity;
	}
}

function currentWidgetValue(node, widgetName, fallback) {
	const stored = String(node?.properties?.[widgetName] || "").trim();
	if (stored) {
		return stored;
	}
	const value = String(GJJ_Utils.getWidget(node, widgetName)?.value || "").trim();
	return value || fallback;
}

function styleButton(button) {
	button.type = "button";
	button.style.cssText = [
		"flex:1 1 0",
		"height:30px",
		"min-width:0",
		"padding:0 8px",
		"border-radius:8px",
		"border:1px solid #314047",
		"background:#172026",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1",
		"cursor:pointer",
	].join(";");
}

function setButtonActive(button, active) {
	button.style.background = active ? "#27404a" : "#172026";
	button.style.borderColor = active ? "#5d95a6" : "#314047";
	button.style.color = active ? "#eff7fb" : "#dce7e2";
}

function createButtonRow(node, stateKey, widgetName, label, values) {
	if (node[stateKey]) {
		return node[stateKey];
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
	].join(";");

	const title = document.createElement("div");
	title.textContent = label;
	title.style.cssText = [
		"color:#b9c9c4",
		"font-size:12px",
		"line-height:1.2",
	].join(";");
	wrap.appendChild(title);

	const row = document.createElement("div");
	row.style.cssText = [
		"display:flex",
		"gap:8px",
		"align-items:center",
	].join(";");
	wrap.appendChild(row);

	const buttons = new Map();
	for (const value of values) {
		const button = document.createElement("button");
		button.textContent = value;
		styleButton(button);
		button.addEventListener("click", () => {
			const widget = GJJ_Utils.getWidget(node, widgetName);
			setWidgetValue(widget, value);
			if (node.properties) {
				node.properties[widgetName] = value;
			}
			updateVisibility(node);
			requestAnimationFrame(() => updateVisibility(node));
		});
		buttons.set(value, button);
		row.appendChild(button);
	}

	const widget = node.addDOMWidget?.(`gjj_video_outpaint_${widgetName}_buttons`, label, wrap, {
		hideOnZoom: false,
		getHeight: () => 58,
	});
	node[stateKey] = { widget, wrap, buttons, widgetName };
	return node[stateKey];
}

function moveWidgetBefore(node, widgetName, beforeName) {
	if (!node?.widgets?.length) {
		return;
	}
	const fromIndex = node.widgets.findIndex((widget) => widget?.name === widgetName);
	const toIndex = node.widgets.findIndex((widget) => widget?.name === beforeName);
	if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
		return;
	}
	const [widget] = node.widgets.splice(fromIndex, 1);
	node.widgets.splice(fromIndex < toIndex ? toIndex - 1 : toIndex, 0, widget);
}

function moveWidgetAfter(node, widgetName, afterName) {
	if (!node?.widgets?.length) {
		return;
	}
	const fromIndex = node.widgets.findIndex((widget) => widget?.name === widgetName);
	const afterIndex = node.widgets.findIndex((widget) => widget?.name === afterName);
	if (fromIndex === -1 || afterIndex === -1 || fromIndex === afterIndex) {
		return;
	}
	const [widget] = node.widgets.splice(fromIndex, 1);
	node.widgets.splice(fromIndex < afterIndex ? afterIndex : afterIndex + 1, 0, widget);
}

function updateButtons(node, state) {
	const activeValue = currentWidgetValue(node, state.widgetName, state.widgetName === FILL_WIDGET_NAME ? FILL_EDGE : MODE_MARGINS);
	for (const [value, button] of state.buttons.entries()) {
		setButtonActive(button, value === activeValue);
	}
}

function updateVisibility(node) {
	const expandWidget = GJJ_Utils.getWidget(node, EXPAND_WIDGET_NAME);
	const fillWidget = GJJ_Utils.getWidget(node, FILL_WIDGET_NAME);
	const expandMode = currentWidgetValue(node, EXPAND_WIDGET_NAME, MODE_MARGINS);
	const fillMode = currentWidgetValue(node, FILL_WIDGET_NAME, FILL_EDGE);

	if (expandWidget) {
		setWidgetValueSilent(expandWidget, expandMode);
		hideWidget(expandWidget);
	}
	if (fillWidget) {
		setWidgetValueSilent(fillWidget, fillMode);
		hideWidget(fillWidget);
	}

	for (const name of MARGIN_ONLY_WIDGETS) {
		setWidgetEnabled(GJJ_Utils.getWidget(node, name), expandMode === MODE_MARGINS);
	}
	for (const name of RATIO_ONLY_WIDGETS) {
		setWidgetEnabled(GJJ_Utils.getWidget(node, name), expandMode === MODE_RATIO);
	}
	for (const name of COLOR_ONLY_WIDGETS) {
		setWidgetEnabled(GJJ_Utils.getWidget(node, name), fillMode === FILL_BLACK);
	}

	if (node.__gjjVideoOutpaintExpandButtons) {
		updateButtons(node, node.__gjjVideoOutpaintExpandButtons);
	}
	if (node.__gjjVideoOutpaintFillButtons) {
		updateButtons(node, node.__gjjVideoOutpaintFillButtons);
	}
	GJJ_Utils.refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjVideoOutpaintStatus) {
		return node.__gjjVideoOutpaintStatus;
	}
	const box = document.createElement("div");
	box.textContent = "等待执行";
	box.style.cssText = [
		"min-height:24px",
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		hideOnZoom: false,
		getHeight: () => 42,
	});
	node.__gjjVideoOutpaintStatus = { widget, box };
	return node.__gjjVideoOutpaintStatus;
}

function setStatus(node, text) {
	const box = node?.__gjjVideoOutpaintStatus?.box;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	GJJ_Utils.refreshNode(node);
}

function ensurePanels(node) {
	createButtonRow(
		node,
		"__gjjVideoOutpaintExpandButtons",
		EXPAND_WIDGET_NAME,
		"扩充方式",
		[MODE_MARGINS, MODE_RATIO],
	);
	createButtonRow(
		node,
		"__gjjVideoOutpaintFillButtons",
		FILL_WIDGET_NAME,
		"填充方式",
		[FILL_EDGE, FILL_BLACK, FILL_BLUR],
	);
	ensureStatusWidget(node);
	moveWidgetBefore(node, "gjj_video_outpaint_expand_mode_buttons", FILL_WIDGET_NAME);
	moveWidgetBefore(node, "gjj_video_outpaint_fill_mode_buttons", "alignment");
	moveWidgetAfter(node, STATUS_WIDGET_NAME, "fill_color");
	updateVisibility(node);
}

function patchWidgetCallback(node, widgetName) {
	const widget = GJJ_Utils.getWidget(node, widgetName);
	if (!widget || widget.__gjjVideoOutpaintHooked) {
		return;
	}
	widget.__gjjVideoOutpaintHooked = true;
	const originalCallback = widget.callback;
	widget.callback = function (value, ...args) {
		const result = originalCallback?.call(this, value, ...args);
		if (node.properties) {
			node.properties[widgetName] = value;
		}
		updateVisibility(node);
		return result;
	};
}

function patchNode(node) {
	if (!node || node.__gjjVideoOutpaintPatched) {
		return;
	}
	node.__gjjVideoOutpaintPatched = true;
	patchWidgetCallback(node, EXPAND_WIDGET_NAME);
	patchWidgetCallback(node, FILL_WIDGET_NAME);
	ensurePanels(node);
	setStatus(node, "等待执行");

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function () {
		const result = originalOnConfigure?.apply(this, arguments);
		patchWidgetCallback(this, EXPAND_WIDGET_NAME);
		patchWidgetCallback(this, FILL_WIDGET_NAME);
		ensurePanels(this);
		setStatus(this, "等待执行");
		return result;
	};

	const originalOnDrawBackground = node.onDrawBackground;
	node.onDrawBackground = function (...args) {
		const result = originalOnDrawBackground?.apply(this, args);
		const signature = `${currentWidgetValue(this, EXPAND_WIDGET_NAME, MODE_MARGINS)}|${currentWidgetValue(this, FILL_WIDGET_NAME, FILL_EDGE)}`;
		if (this.__gjjVideoOutpaintLastSignature !== signature) {
			this.__gjjVideoOutpaintLastSignature = signature;
			updateVisibility(this);
		}
		return result;
	};
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(getNodeClassName(targetNode))) {
		return;
	}
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.VideoOutpaintPad",
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(getNodeClassName(node))) {
				patchNode(node);
			}
		}
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalOnNodeCreated?.apply(this, arguments);
			patchNode(this);
			return result;
		};
	},
});

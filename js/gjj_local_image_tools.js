import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const PANEL_WIDGET = "gjj_local_image_color_panel";
const TARGETS = {
	GJJ_SolidColorImage: ["color", "颜色"],
	GJJ_GradientImage: ["start_color", "end_color", "起始颜色", "结束颜色"],
};

function stop(event) {
	event.stopPropagation();
}

function normalizeColor(value, fallback = "#000000") {
	const text = String(value || "").trim();
	if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toUpperCase();
	if (/^#[0-9a-fA-F]{8}$/.test(text)) return text.slice(0, 7).toUpperCase();
	return fallback;
}

function colorWidgetDefs(node) {
	return TARGETS[targetClass(node)] || [];
}

function targetClass(node) {
	return String(node?.comfyClass || node?.type || "");
}

function findWidget(node, name) {
	return (node?.widgets || []).find((widget) => widget?.name === name);
}

function hideWidget(widget) {
	if (!widget || widget.__gjjLocalImageColorHidden) return;
	widget.__gjjLocalImageColorHidden = true;
	widget.__gjjLocalImageColorOriginal = {
		type: widget.type,
		computeSize: widget.computeSize,
		draw: widget.draw,
		mouse: widget.mouse,
		label: widget.label,
		size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
		last_y: widget.last_y,
		computedHeight: widget.computedHeight,
		margin_top: widget.margin_top,
	};
	widget.type = "hidden";
	widget.hidden = true;
	widget.disabled = true;
	widget.serialize = true;
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.label = "";
	widget.size = [0, 0];
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	for (const el of [widget.inputEl, widget.element, widget.widget]) {
		if (!el?.style) continue;
		el.style.display = "none";
		el.style.height = "0";
		el.style.minHeight = "0";
		el.style.margin = "0";
		el.style.padding = "0";
		el.style.border = "0";
		el.style.overflow = "hidden";
	}
}

function setWidgetValue(node, widget, value) {
	if (!widget) return;
	const next = normalizeColor(value, "#000000");
	widget.value = next;
	try {
		widget.callback?.(next, app.canvas, node, app.canvas?.graph_mouse, {});
	} catch (_) {}
	GJJ_Utils.refreshNode(node);
}

function ensureStyles() {
	if (document.getElementById("gjj-local-image-color-style-v1")) return;
	const style = document.createElement("style");
	style.id = "gjj-local-image-color-style-v1";
	style.textContent = `
.gjj-local-color-root{box-sizing:border-box;width:100%;padding:0 0 4px 0;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#dbeafe;pointer-events:auto;user-select:none;}
.gjj-local-color-panel{display:flex;flex-direction:column;gap:7px;}
.gjj-local-color-field{display:flex;align-items:center;gap:7px;min-height:28px;}
.gjj-local-color-label{width:82px;min-width:82px;color:#cbd5e1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-local-color-input{flex:1;min-width:0;height:28px;border:1px solid rgba(148,163,184,.28);background:rgba(17,24,39,.82);color:#fff;border-radius:8px;padding:2px 5px;outline:none;box-sizing:border-box;cursor:pointer;}
.gjj-local-color-input:focus{border-color:#22d3ee;box-shadow:0 0 0 1px rgba(34,211,238,.25);}
`;
	document.head.appendChild(style);
}

function createColorRow(node, def) {
	const widget = findWidget(node, def.key);
	const row = document.createElement("label");
	row.className = "gjj-local-color-field";
	row.title = `${def.label}。`;

	const label = document.createElement("span");
	label.className = "gjj-local-color-label";
	label.textContent = def.label;

	const input = document.createElement("input");
	input.className = "gjj-local-color-input";
	input.type = "color";
	input.value = normalizeColor(widget?.value, def.fallback);
	input.addEventListener("input", (event) => {
		stop(event);
		setWidgetValue(node, widget, input.value);
	});
	input.addEventListener("change", stop);
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "wheel"]) {
		input.addEventListener(eventName, stop);
	}

	row.append(label, input);
	return row;
}

function createPanel(node) {
	ensureStyles();
	const root = document.createElement("div");
	root.className = "gjj-local-color-root";
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		root.addEventListener(eventName, stop);
	}
	const panel = document.createElement("div");
	panel.className = "gjj-local-color-panel";
	for (const def of colorWidgetDefs(node)) {
		panel.appendChild(createColorRow(node, def));
	}
	root.appendChild(panel);
	node.__gjjLocalImageColorDom = { root, panel };
	return root;
}

function buildPanel(node) {
	const dom = node.__gjjLocalImageColorDom;
	if (!dom?.panel) return;
	dom.panel.replaceChildren();
	for (const def of colorWidgetDefs(node)) {
		dom.panel.appendChild(createColorRow(node, def));
	}
	redraw(node);
}

function redraw(node) {
	requestAnimationFrame(() => {
		try {
			if (node.size) node.size[0] = Math.max(node.size[0], 260);
			const widget = node.__gjjLocalImageColorWidget;
			const root = node.__gjjLocalImageColorDom?.root;
			if (widget && root) {
				const height = Math.max(1, Math.ceil(root.scrollHeight || root.offsetHeight || 1));
				widget.computedHeight = height + 6;
				widget.last_y = 0;
			}
		} catch (_) {}
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	});
}

function ensureColorPanel(node) {
	const names = colorWidgetDefs(node);
	if (!names.length) return;
	if (!GJJ_Utils.setupColorPickers(node, names)) {
		const retries = Number(node.__gjjLocalImageColorRetryCount || 0);
		if (retries < 8) {
			node.__gjjLocalImageColorRetryCount = retries + 1;
			setTimeout(() => ensureColorPanel(node), 60);
		}
		return;
	}
	redraw(node);
}

function scheduleColorSetup(node) {
	setTimeout(() => ensureColorPanel(node), 0);
	setTimeout(() => ensureColorPanel(node), 80);
	setTimeout(() => ensureColorPanel(node), 240);
	setTimeout(() => ensureColorPanel(node), 800);
}

app.registerExtension({
	name: "GJJ.LocalImageTools.ColorPanel",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGETS[nodeData?.name]) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (...args) {
			const widget = originalAddWidget?.apply(this, args);
			GJJ_Utils.setupColorPickers(this, colorWidgetDefs(this));
			return widget;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleColorSetup(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			scheduleColorSetup(this);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (...args) {
			const result = originalOnSerialize?.apply(this, args);
			if (Array.isArray(this.widgets)) {
				for (const widget of this.widgets) {
					if (widget?.name !== PANEL_WIDGET) continue;
					widget.serialize = false;
					widget.options ||= {};
					widget.options.serialize = false;
					widget.value = undefined;
				}
			}
			return result;
		};
	},

	nodeCreated(node) {
		if (!TARGETS[targetClass(node)]) return;
		scheduleColorSetup(node);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (!TARGETS[targetClass(node)]) continue;
			ensureColorPanel(node);
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_CLASS = "GJJ_WorkflowTitle";
const CONFIG_WIDGET = "config_json";
const SAVED_CONFIG_PROPERTY = "gjj_workflow_title_config";
const PANEL_WIDGET = "gjj_workflow_title_panel";
const HELP_WIDGET_NAME = "gjj_help_button";
const STYLE_ID = "gjj-workflow-title-style";
const MIN_WIDTH = 120;
const SETTINGS_WIDTH = 360;
const MAX_DISPLAY_WIDTH = 1200;

const DEFAULT_STATE = {
	version: 3,
	text: "工作流标题",
	font: "",
	fontSize: 96,
	colorA: "#F8FFF7",
	colorB: "#55C685",
	gradient: true,
	gradientDirection: "水平",
	opacity: 1,
	letterSpacing: 1,
	lineSpacing: 12,
	paddingX: 0,
	paddingY: 0,
	strokeWidth: 2,
	strokeMode: "自定义",
	strokeColor: "#2E7D62",
	strokeOpacity: 1,
	backgroundColor: "#1E5A48",
	borderMode: "透明",
	borderColor: "#55C685",
	borderOpacity: 1,
	shadowEnabled: true,
	shadowColor: "#2B5568",
	shadowOpacity: 0.42,
	shadowBlur: 8,
	shadowX: 2,
	shadowY: 4,
	align: "居中",
};

let fontInfoPromise = null;

function getNoTitleMode() {
	return globalThis.LiteGraph?.TitleMode?.NO_TITLE ?? 1;
}

function ensureStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.gjj-title-root{position:relative;box-sizing:border-box;width:100%;min-width:0;padding:0;background:transparent;color:#dce7e2;font-family:system-ui,"Microsoft YaHei",sans-serif;pointer-events:auto;user-select:none;}
.gjj-title-canvas{display:block;background:transparent;pointer-events:none;}
.gjj-title-gear{position:absolute;left:0;top:0;z-index:4;width:24px;height:24px;padding:0;border:0;border-radius:5px;background:rgba(11,16,20,.34);color:#effff8;font-size:14px;line-height:24px;cursor:pointer;opacity:.62;}
.gjj-title-root:hover .gjj-title-gear,.gjj-title-root.open .gjj-title-gear{opacity:1;background:rgba(20,31,37,.82);box-shadow:0 0 0 1px rgba(85,198,133,.28);}
.gjj-title-panel{display:none;box-sizing:border-box;width:${SETTINGS_WIDTH}px;margin-top:6px;padding:8px;border:1px solid rgba(85,198,133,.28);border-radius:7px;background:rgba(13,20,24,.96);box-shadow:0 8px 28px rgba(0,0,0,.28);}
.gjj-title-root.open .gjj-title-panel{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
.gjj-title-field{display:flex;flex-direction:column;gap:3px;min-width:0;}
.gjj-title-field.wide{grid-column:1 / -1;}
.gjj-title-field label{font-size:11px;color:#9fb5bd;font-weight:700;}
.gjj-title-field input,.gjj-title-field select,.gjj-title-field textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid #33464e;border-radius:5px;background:#111b20;color:#ecf6f3;outline:none;font-size:12px;}
.gjj-title-field input,.gjj-title-field select{height:26px;padding:0 7px;}
.gjj-title-field textarea{height:54px;resize:vertical;padding:6px 7px;line-height:1.35;}
.gjj-title-field input[type="color"]{padding:2px;}
.gjj-title-check{display:flex;align-items:center;gap:6px;min-height:26px;color:#cbdade;font-size:12px;font-weight:700;}
.gjj-title-check input{width:auto;height:auto;}
.gjj-title-range{display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:5px;align-items:center;}
.gjj-title-range input{padding:0;}
.gjj-title-range output{font-size:10px;color:#9fb5bd;text-align:right;font-variant-numeric:tabular-nums;}
.gjj-title-actions{grid-column:1 / -1;display:flex;justify-content:flex-end;gap:6px;padding-top:2px;}
.gjj-title-actions button{height:26px;padding:0 10px;border:1px solid #40545d;border-radius:5px;background:#172329;color:#dce7e2;font-size:12px;font-weight:800;cursor:pointer;}
.gjj-title-actions button.primary{background:#1d563d;border-color:#55c685;color:#fff;}
`;
	document.head.appendChild(style);
}

function stop(event) {
	event.preventDefault();
	event.stopPropagation();
}

function targetClass(node) {
	return String(node?.comfyClass || node?.type || "");
}

function findWidget(node, name) {
	return node.widgets?.find?.((widget) => widget?.name === name);
}

function getWidgetValue(node, name, fallback = "") {
	if (name === CONFIG_WIDGET) {
		const saved = node.properties?.[SAVED_CONFIG_PROPERTY];
		if (saved !== undefined && saved !== null && saved !== "") return String(saved);
	}
	const prop = node.properties?.[name];
	if (prop !== undefined && prop !== null && prop !== "") return String(prop);
	const widget = findWidget(node, name);
	return widget?.value ?? fallback;
}

function setWidgetValue(node, name, value) {
	node.properties = node.properties || {};
	node.properties[name] = String(value ?? "");
	if (name === CONFIG_WIDGET) {
		node.properties[SAVED_CONFIG_PROPERTY] = String(value ?? "");
	}
	const widget = findWidget(node, name);
	if (widget) {
		widget.value = String(value ?? "");
		try { widget.callback?.(widget.value, app.canvas, node); } catch (_) {}
	}
	if (Array.isArray(node.widgets)) {
		const index = node.widgets.indexOf(widget);
		if (index >= 0) {
			if (!Array.isArray(node.widgets_values)) {
				node.widgets_values = node.widgets.map((item) => item?.value);
			}
			node.widgets_values[index] = String(value ?? "");
		}
	}
	node.graph?.change?.();
	app.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function collapseElement(element) {
	if (!element?.style) return;
	element.style.display = "none";
	element.style.height = "0";
	element.style.minHeight = "0";
	element.style.margin = "0";
	element.style.padding = "0";
	element.style.border = "0";
	element.style.overflow = "hidden";
}

function collapseWidget(widget) {
	if (!widget) return;
	widget.hidden = true;
	widget.computeSize = () => [0, -4];
	widget.type = widget.type || "hidden";
	collapseElement(widget.inputEl);
	collapseElement(widget.element);
	collapseElement(widget.widget);
}

function suppressHelpWidget(node) {
	if (!Array.isArray(node?.widgets)) return;
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		if (String(node.widgets[index]?.name || "") === HELP_WIDGET_NAME) {
			node.widgets.splice(index, 1);
		}
	}
	delete node.__gjjHelpWidget;
	delete node.__gjjHelpWidgetState;
}

function removeAllOutputs(node) {
	if (!Array.isArray(node?.outputs) || !node.outputs.length) return;
	for (let index = node.outputs.length - 1; index >= 0; index -= 1) {
		try {
			node.removeOutput?.(index);
		} catch (_) {
			node.outputs.splice(index, 1);
		}
	}
	if (Array.isArray(node.outputs) && node.outputs.length) node.outputs.length = 0;
}

function safeSetProperty(target, key, value) {
	if (!target) return false;
	try {
		target[key] = value;
		return true;
	} catch (_) {
		return false;
	}
}

function applyTransparentChrome(node, sourceState = null) {
	if (!node) return;
	const state = normalizeState(sourceState || node.__gjjWorkflowTitleState || parseState(getWidgetValue(node, CONFIG_WIDGET, serializeState(DEFAULT_STATE))));
	if (node.constructor) safeSetProperty(node.constructor, "title_mode", getNoTitleMode());
	safeSetProperty(node, "color", "rgba(0,0,0,0)");
	safeSetProperty(node, "bgcolor", "rgba(0,0,0,0)");
	safeSetProperty(node, "boxcolor", borderColorForState(state));
	node.badges = [];
	node.drawBadges = function () {};
	removeAllOutputs(node);
	collapseWidget(findWidget(node, CONFIG_WIDGET));
	suppressHelpWidget(node);
}

function parseState(raw) {
	try {
		const value = JSON.parse(String(raw || "{}"));
		return normalizeState(value && typeof value === "object" ? value : {});
	} catch (_) {
		return { ...DEFAULT_STATE };
	}
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function finite(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function normalizeState(value) {
	const state = { ...DEFAULT_STATE, ...value };
	state.text = String(state.text || DEFAULT_STATE.text);
	state.font = String(state.font || "");
	state.fontSize = Math.round(clamp(finite(state.fontSize, DEFAULT_STATE.fontSize), 8, 512));
	state.colorA = normalizeColor(state.colorA, DEFAULT_STATE.colorA);
	state.colorB = normalizeColor(state.colorB, DEFAULT_STATE.colorB);
	state.gradient = Boolean(state.gradient);
	state.gradientDirection = ["水平", "垂直", "对角"].includes(String(state.gradientDirection)) ? String(state.gradientDirection) : "水平";
	state.opacity = clamp(finite(state.opacity, 1), 0, 1);
	state.letterSpacing = clamp(finite(state.letterSpacing, 1), -50, 200);
	state.lineSpacing = clamp(finite(state.lineSpacing, 12), -80, 300);
	state.paddingX = clamp(finite(state.paddingX, DEFAULT_STATE.paddingX), 0, 600);
	state.paddingY = clamp(finite(state.paddingY, DEFAULT_STATE.paddingY), 0, 600);
	state.strokeWidth = clamp(finite(state.strokeWidth, 2), 0, 80);
	state.strokeMode = ["自定义", "背景色", "透明"].includes(String(state.strokeMode)) ? String(state.strokeMode) : "自定义";
	state.strokeColor = normalizeColor(state.strokeColor, DEFAULT_STATE.strokeColor);
	state.strokeOpacity = clamp(finite(state.strokeOpacity, 1), 0, 1);
	state.backgroundColor = normalizeColor(state.backgroundColor, DEFAULT_STATE.backgroundColor);
	state.borderMode = ["透明", "背景色", "自定义"].includes(String(state.borderMode)) ? String(state.borderMode) : "透明";
	state.borderColor = normalizeColor(state.borderColor, DEFAULT_STATE.borderColor);
	state.borderOpacity = clamp(finite(state.borderOpacity, 1), 0, 1);
	state.shadowEnabled = Boolean(state.shadowEnabled);
	state.shadowColor = normalizeColor(state.shadowColor, DEFAULT_STATE.shadowColor);
	state.shadowOpacity = clamp(finite(state.shadowOpacity, 0.42), 0, 1);
	state.shadowBlur = clamp(finite(state.shadowBlur, 8), 0, 120);
	state.shadowX = clamp(finite(state.shadowX, 2), -200, 200);
	state.shadowY = clamp(finite(state.shadowY, 4), -200, 200);
	state.align = ["左对齐", "居中", "右对齐"].includes(String(state.align)) ? String(state.align) : "居中";
	state.version = 3;
	return state;
}

function normalizeColor(value, fallback) {
	const text = String(value || "").trim();
	return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : fallback;
}

function serializeState(state) {
	return JSON.stringify(normalizeState(state));
}

function serializedWidgetValue(node, serializedNode, name) {
	const values = serializedNode?.widgets_values;
	if (!Array.isArray(values) || !values.length) return "";
	const index = Array.isArray(node?.widgets) ? node.widgets.findIndex((widget) => widget?.name === name) : -1;
	if (index >= 0 && values[index] !== undefined && values[index] !== null && values[index] !== "") return String(values[index]);
	if (name === CONFIG_WIDGET && values[0] !== undefined && values[0] !== null && values[0] !== "") return String(values[0]);
	return "";
}

function currentConfigValue(node) {
	if (node?.__gjjWorkflowTitleState) return serializeState(node.__gjjWorkflowTitleState);
	return serializeState(parseState(getWidgetValue(node, CONFIG_WIDGET, serializeState(DEFAULT_STATE))));
}

function restoreConfigValue(node, serializedNode = null) {
	const props = serializedNode?.properties || node?.properties || {};
	const raw = props[SAVED_CONFIG_PROPERTY]
		|| props[CONFIG_WIDGET]
		|| serializedWidgetValue(node, serializedNode, CONFIG_WIDGET)
		|| getWidgetValue(node, CONFIG_WIDGET, serializeState(DEFAULT_STATE));
	const state = parseState(raw);
	const serialized = serializeState(state);
	node.__gjjWorkflowTitleState = state;
	setWidgetValue(node, CONFIG_WIDGET, serialized);
	return serialized;
}

function writeSerializedConfig(node, serializedNode) {
	if (!serializedNode) return;
	const serialized = currentConfigValue(node);
	serializedNode.properties = serializedNode.properties || {};
	serializedNode.properties[CONFIG_WIDGET] = serialized;
	serializedNode.properties[SAVED_CONFIG_PROPERTY] = serialized;
	if (Array.isArray(serializedNode.widgets_values) && Array.isArray(node?.widgets)) {
		const index = node.widgets.findIndex((widget) => widget?.name === CONFIG_WIDGET);
		if (index >= 0) serializedNode.widgets_values[index] = serialized;
		else if (!serializedNode.widgets_values.length) serializedNode.widgets_values[0] = serialized;
	}
}

function persistTitleState(node, state) {
	const serialized = serializeState(state);
	node.__gjjWorkflowTitleState = normalizeState(state);
	setWidgetValue(node, CONFIG_WIDGET, serialized);
	node.properties = node.properties || {};
	node.properties[CONFIG_WIDGET] = serialized;
	node.properties[SAVED_CONFIG_PROPERTY] = serialized;
	return serialized;
}

function cssFamilyForFont(name) {
	const text = String(name || "").toLowerCase();
	if (text.includes("msyh") || text.includes("雅黑")) return `"Microsoft YaHei"`;
	if (text.includes("simhei") || text.includes("黑体")) return `"SimHei"`;
	if (text.includes("simsun") || text.includes("宋体")) return `"SimSun"`;
	if (text.includes("simkai") || text.includes("楷体")) return `"KaiTi"`;
	if (text.includes("fangsong") || text.includes("仿宋")) return `"FangSong"`;
	if (text.includes("noto") || text.includes("cjk")) return `"Noto Sans CJK SC"`;
	if (text.includes("sourcehan") || text.includes("思源")) return `"Source Han Sans SC"`;
	const base = String(name || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.(ttf|otf|ttc|otc)$/i, "") || "";
	return base ? `"${base}"` : `"Microsoft YaHei"`;
}

function canvasFont(state) {
	return `700 ${state.fontSize}px ${cssFamilyForFont(state.font)}, "Microsoft YaHei", "SimHei", sans-serif`;
}

function lineWidth(ctx, line, spacing) {
	const chars = Array.from(String(line || ""));
	if (!chars.length) return 0;
	return chars.reduce((total, char) => total + ctx.measureText(char).width, 0) + Math.max(0, chars.length - 1) * spacing;
}

function measureLayout(state) {
	const probe = document.createElement("canvas");
	const ctx = probe.getContext("2d");
	ctx.font = canvasFont(state);
	const lines = String(state.text || DEFAULT_STATE.text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (!lines.some((line) => line.trim())) lines.splice(0, lines.length, DEFAULT_STATE.text);
	const widths = lines.map((line) => lineWidth(ctx, line, state.letterSpacing));
	const lineHeight = Math.max(1, state.fontSize * 1.18);
	const textWidth = Math.max(1, ...widths);
	const textHeight = lines.length * lineHeight + Math.max(0, lines.length - 1) * state.lineSpacing;
	const margin = Math.ceil(state.strokeWidth * 2 + (state.shadowEnabled ? state.shadowBlur * 2 + Math.max(Math.abs(state.shadowX), Math.abs(state.shadowY)) : 0) + 4);
	const imageWidth = Math.max(1, Math.ceil(textWidth + state.paddingX * 2 + margin * 2));
	const imageHeight = Math.max(1, Math.ceil(textHeight + state.paddingY * 2 + margin * 2));
	return { lines, widths, lineHeight, textWidth, textHeight, margin, imageWidth, imageHeight };
}

function drawSpacedText(ctx, text, x, y, spacing, mode) {
	for (const char of Array.from(String(text || ""))) {
		if (mode === "stroke") ctx.strokeText(char, x, y);
		else ctx.fillText(char, x, y);
		x += ctx.measureText(char).width + spacing;
	}
}

function makeGradient(ctx, state, width, height) {
	if (!state.gradient) return state.colorA;
	let gradient;
	if (state.gradientDirection === "垂直") gradient = ctx.createLinearGradient(0, 0, 0, height);
	else if (state.gradientDirection === "对角") gradient = ctx.createLinearGradient(0, 0, width, height);
	else gradient = ctx.createLinearGradient(0, 0, width, 0);
	gradient.addColorStop(0, state.colorA);
	gradient.addColorStop(1, state.colorB);
	return gradient;
}

function strokeColorForState(state) {
	if (state.strokeMode === "透明") return hexToRgba(state.strokeColor, 0);
	if (state.strokeMode === "背景色") return hexToRgba(state.backgroundColor, state.strokeOpacity);
	return hexToRgba(state.strokeColor, state.strokeOpacity);
}

function borderColorForState(state) {
	if (state.borderMode === "透明") return "rgba(0,0,0,0)";
	if (state.borderMode === "背景色") return hexToRgba(state.backgroundColor, state.borderOpacity);
	return hexToRgba(state.borderColor, state.borderOpacity);
}

function alignedX(baseX, maxWidth, currentWidth, align) {
	if (align === "左对齐") return baseX;
	if (align === "右对齐") return baseX + maxWidth - currentWidth;
	return baseX + (maxWidth - currentWidth) / 2;
}

function drawTitle(ctx, state, layout) {
	ctx.clearRect(0, 0, layout.imageWidth, layout.imageHeight);
	ctx.font = canvasFont(state);
	ctx.textBaseline = "top";
	ctx.globalAlpha = state.opacity;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	const baseX = layout.margin + state.paddingX;
	const baseY = layout.margin + state.paddingY;
	const fill = makeGradient(ctx, state, layout.imageWidth, layout.imageHeight);
	const strokeColor = strokeColorForState(state);

	if (state.shadowEnabled && (state.shadowBlur > 0 || state.shadowX || state.shadowY)) {
		ctx.save();
		ctx.shadowColor = hexToRgba(state.shadowColor, state.shadowOpacity);
		ctx.shadowBlur = state.shadowBlur;
		ctx.shadowOffsetX = state.shadowX;
		ctx.shadowOffsetY = state.shadowY;
		ctx.fillStyle = fill;
		ctx.strokeStyle = strokeColor;
		ctx.lineWidth = Math.max(0, state.strokeWidth * 2);
		let y = baseY;
		layout.lines.forEach((line, index) => {
			const x = alignedX(baseX, layout.textWidth, layout.widths[index], state.align);
			if (state.strokeWidth > 0) drawSpacedText(ctx, line, x, y, state.letterSpacing, "stroke");
			drawSpacedText(ctx, line, x, y, state.letterSpacing, "fill");
			y += layout.lineHeight + state.lineSpacing;
		});
		ctx.restore();
	}

	ctx.shadowColor = "transparent";
	ctx.shadowBlur = 0;
	ctx.shadowOffsetX = 0;
	ctx.shadowOffsetY = 0;
	ctx.fillStyle = fill;
	ctx.strokeStyle = strokeColor;
	ctx.lineWidth = Math.max(0, state.strokeWidth * 2);
	let y = baseY;
	layout.lines.forEach((line, index) => {
		const x = alignedX(baseX, layout.textWidth, layout.widths[index], state.align);
		if (state.strokeWidth > 0) drawSpacedText(ctx, line, x, y, state.letterSpacing, "stroke");
		drawSpacedText(ctx, line, x, y, state.letterSpacing, "fill");
		y += layout.lineHeight + state.lineSpacing;
	});
	ctx.globalAlpha = 1;
}

function hexToRgba(hex, alpha) {
	const text = normalizeColor(hex, "#000000").slice(1);
	const r = parseInt(text.slice(0, 2), 16);
	const g = parseInt(text.slice(2, 4), 16);
	const b = parseInt(text.slice(4, 6), 16);
	return `rgba(${r},${g},${b},${clamp(finite(alpha, 1), 0, 1)})`;
}

async function loadFontInfo() {
	if (!fontInfoPromise) {
		fontInfoPromise = api.fetchApi("/gjj/workflow_title/fonts")
			.then((response) => response.json())
			.catch(() => ({ fonts: [], default: "" }));
	}
	return fontInfoPromise;
}

function makeButton(text, title = "") {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = text;
	button.title = title;
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		button.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return button;
}

function makeField(labelText, input, wide = false) {
	const wrap = document.createElement("div");
	wrap.className = `gjj-title-field${wide ? " wide" : ""}`;
	const label = document.createElement("label");
	label.textContent = labelText;
	wrap.append(label, input);
	return wrap;
}

function makeRange(labelText, min, max, step, getValue, setValue) {
	const input = document.createElement("input");
	input.type = "range";
	input.min = String(min);
	input.max = String(max);
	input.step = String(step);
	input.value = String(getValue());
	const output = document.createElement("output");
	const updateOutput = () => {
		const value = Number(input.value);
		output.textContent = Number.isInteger(value) ? String(value) : value.toFixed(step < 1 ? 2 : 1);
	};
	updateOutput();
	const row = document.createElement("div");
	row.className = "gjj-title-range";
	row.append(input, output);
	input.addEventListener("input", () => {
		setValue(Number(input.value));
		updateOutput();
	});
	return { field: makeField(labelText, row), input, output, updateOutput };
}

function makeCheck(labelText, checked, setValue) {
	const label = document.createElement("label");
	label.className = "gjj-title-check";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = Boolean(checked);
	input.addEventListener("change", () => setValue(input.checked));
	label.append(input, document.createTextNode(labelText));
	return label;
}

function createPanel(node) {
	ensureStyle();
	applyTransparentChrome(node);
	let state = parseState(restoreConfigValue(node));
	let panelOpen = false;
	let layout = measureLayout(state);
	node.__gjjWorkflowTitleState = state;

	const root = document.createElement("div");
	root.className = "gjj-title-root";
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		root.addEventListener(eventName, (event) => event.stopPropagation());
	}

	const canvas = document.createElement("canvas");
	canvas.className = "gjj-title-canvas";
	const gear = makeButton("⚙️", "设置工作流标题样式");
	gear.className = "gjj-title-gear";
	const settings = document.createElement("div");
	settings.className = "gjj-title-panel";

	const textInput = document.createElement("textarea");
	textInput.value = state.text;
	textInput.placeholder = "工作流标题";

	const fontSelect = document.createElement("select");

	const colorA = document.createElement("input");
	colorA.type = "color";
	colorA.value = state.colorA;
	const colorB = document.createElement("input");
	colorB.type = "color";
	colorB.value = state.colorB;
	const strokeColor = document.createElement("input");
	strokeColor.type = "color";
	strokeColor.value = state.strokeColor;
	const backgroundColor = document.createElement("input");
	backgroundColor.type = "color";
	backgroundColor.value = state.backgroundColor;
	const borderColor = document.createElement("input");
	borderColor.type = "color";
	borderColor.value = state.borderColor;
	const shadowColor = document.createElement("input");
	shadowColor.type = "color";
	shadowColor.value = state.shadowColor;

	const strokeMode = document.createElement("select");
	for (const item of ["自定义", "背景色", "透明"]) {
		const option = new Option(item, item);
		strokeMode.appendChild(option);
	}
	strokeMode.value = state.strokeMode;

	const borderMode = document.createElement("select");
	for (const item of ["透明", "背景色", "自定义"]) {
		const option = new Option(item, item);
		borderMode.appendChild(option);
	}
	borderMode.value = state.borderMode;

	const direction = document.createElement("select");
	for (const item of ["水平", "垂直", "对角"]) {
		const option = new Option(item, item);
		direction.appendChild(option);
	}
	direction.value = state.gradientDirection;

	const align = document.createElement("select");
	for (const item of ["左对齐", "居中", "右对齐"]) {
		const option = new Option(item, item);
		align.appendChild(option);
	}
	align.value = state.align;

	const controls = [
		makeRange("字号", 8, 512, 1, () => state.fontSize, (value) => { state.fontSize = value; syncFromControls(); }),
		makeRange("透明度", 0, 1, 0.01, () => state.opacity, (value) => { state.opacity = value; syncFromControls(); }),
		makeRange("字间距", -50, 200, 0.5, () => state.letterSpacing, (value) => { state.letterSpacing = value; syncFromControls(); }),
		makeRange("行间距", -80, 300, 1, () => state.lineSpacing, (value) => { state.lineSpacing = value; syncFromControls(); }),
		makeRange("描边", 0, 80, 1, () => state.strokeWidth, (value) => { state.strokeWidth = value; syncFromControls(); }),
		makeRange("描边透明", 0, 1, 0.01, () => state.strokeOpacity, (value) => { state.strokeOpacity = value; syncFromControls(); }),
		makeRange("边框透明", 0, 1, 0.01, () => state.borderOpacity, (value) => { state.borderOpacity = value; syncFromControls(); }),
		makeRange("阴影模糊", 0, 120, 1, () => state.shadowBlur, (value) => { state.shadowBlur = value; syncFromControls(); }),
		makeRange("阴影 X", -200, 200, 1, () => state.shadowX, (value) => { state.shadowX = value; syncFromControls(); }),
		makeRange("阴影 Y", -200, 200, 1, () => state.shadowY, (value) => { state.shadowY = value; syncFromControls(); }),
		makeRange("阴影透明", 0, 1, 0.01, () => state.shadowOpacity, (value) => { state.shadowOpacity = value; syncFromControls(); }),
		makeRange("横向留白", 0, 600, 1, () => state.paddingX, (value) => { state.paddingX = value; syncFromControls(); }),
		makeRange("纵向留白", 0, 600, 1, () => state.paddingY, (value) => { state.paddingY = value; syncFromControls(); }),
	];

	const gradientCheck = makeCheck("渐变", state.gradient, (value) => { state.gradient = value; syncFromControls(); });
	const shadowCheck = makeCheck("阴影", state.shadowEnabled, (value) => { state.shadowEnabled = value; syncFromControls(); });

	const reset = makeButton("重置", "恢复默认标题样式");
	const ok = makeButton("确定", "确认并隐藏设置面板");
	ok.classList.add("primary");
	const actions = document.createElement("div");
	actions.className = "gjj-title-actions";
	actions.append(reset, ok);

	settings.append(
		actions,
		makeField("标题", textInput, true),
		makeField("字体", fontSelect, true),
		controls[0].field,
		makeField("对齐", align),
		makeField("颜色 A", colorA),
		makeField("颜色 B", colorB),
		gradientCheck,
		makeField("渐变方向", direction),
		controls[1].field,
		controls[2].field,
		controls[3].field,
		controls[4].field,
		makeField("描边模式", strokeMode),
		makeField("描边颜色", strokeColor),
		controls[5].field,
		makeField("背景色", backgroundColor),
		makeField("边框模式", borderMode),
		makeField("边框颜色", borderColor),
		controls[6].field,
		shadowCheck,
		makeField("阴影颜色", shadowColor),
		controls[7].field,
		controls[8].field,
		controls[9].field,
		controls[10].field,
		controls[11].field,
		controls[12].field,
	);
	root.append(canvas, gear, settings);

	function syncFromControls() {
		state = normalizeState({
			...state,
			text: textInput.value,
			font: fontSelect.value || state.font,
			colorA: colorA.value,
			colorB: colorB.value,
			strokeMode: strokeMode.value,
			strokeColor: strokeColor.value,
			backgroundColor: backgroundColor.value,
			borderMode: borderMode.value,
			borderColor: borderColor.value,
			shadowColor: shadowColor.value,
			gradientDirection: direction.value,
			align: align.value,
		});
		persistTitleState(node, state);
		applyTransparentChrome(node, state);
		renderPreview();
		resizeNode();
	}

	for (const input of [textInput, fontSelect, colorA, colorB, strokeMode, strokeColor, backgroundColor, borderMode, borderColor, shadowColor, direction, align]) {
		input.addEventListener("input", syncFromControls);
		input.addEventListener("change", syncFromControls);
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "keyup"]) {
			input.addEventListener(eventName, (event) => event.stopPropagation());
		}
	}

	gear.addEventListener("click", (event) => {
		stop(event);
		panelOpen = !panelOpen;
		root.classList.toggle("open", panelOpen);
		resizeNode();
	});
	ok.addEventListener("click", (event) => {
		stop(event);
		panelOpen = false;
		root.classList.remove("open");
		syncFromControls();
	});
	reset.addEventListener("click", (event) => {
		stop(event);
		const font = state.font;
		state = normalizeState({ ...DEFAULT_STATE, font: font || DEFAULT_STATE.font });
		applyStateToControls();
		syncFromControls();
	});

	function applyStateToControls() {
		textInput.value = state.text;
		colorA.value = state.colorA;
		colorB.value = state.colorB;
		strokeMode.value = state.strokeMode;
		strokeColor.value = state.strokeColor;
		backgroundColor.value = state.backgroundColor;
		borderMode.value = state.borderMode;
		borderColor.value = state.borderColor;
		shadowColor.value = state.shadowColor;
		direction.value = state.gradientDirection;
		align.value = state.align;
		for (const control of controls) {
			const label = control.field.querySelector("label")?.textContent || "";
			if (label === "字号") control.input.value = String(state.fontSize);
			if (label === "透明度") control.input.value = String(state.opacity);
			if (label === "字间距") control.input.value = String(state.letterSpacing);
			if (label === "行间距") control.input.value = String(state.lineSpacing);
			if (label === "描边") control.input.value = String(state.strokeWidth);
			if (label === "描边透明") control.input.value = String(state.strokeOpacity);
			if (label === "边框透明") control.input.value = String(state.borderOpacity);
			if (label === "阴影模糊") control.input.value = String(state.shadowBlur);
			if (label === "阴影 X") control.input.value = String(state.shadowX);
			if (label === "阴影 Y") control.input.value = String(state.shadowY);
			if (label === "阴影透明") control.input.value = String(state.shadowOpacity);
			if (label === "横向留白") control.input.value = String(state.paddingX);
			if (label === "纵向留白") control.input.value = String(state.paddingY);
			control.updateOutput?.();
		}
		gradientCheck.querySelector("input").checked = Boolean(state.gradient);
		shadowCheck.querySelector("input").checked = Boolean(state.shadowEnabled);
	}

	function applyExternalState(nextState) {
		state = normalizeState(nextState);
		persistTitleState(node, state);
		applyStateToControls();
		applyTransparentChrome(node, state);
		renderPreview();
		resizeNode();
	}
	node.__gjjWorkflowTitleApplyState = applyExternalState;

	function renderPreview() {
		layout = measureLayout(state);
		const scale = Math.min(1, MAX_DISPLAY_WIDTH / Math.max(1, layout.imageWidth));
		const displayW = Math.max(1, Math.round(layout.imageWidth * scale));
		const displayH = Math.max(1, Math.round(layout.imageHeight * scale));
		const dpr = Math.max(1, window.devicePixelRatio || 1);
		canvas.style.width = `${displayW}px`;
		canvas.style.height = `${displayH}px`;
		canvas.width = Math.max(1, Math.round(displayW * dpr));
		canvas.height = Math.max(1, Math.round(displayH * dpr));
		const ctx = canvas.getContext("2d");
		ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
		drawTitle(ctx, state, layout);
	}

	function resizeNode() {
		requestAnimationFrame(() => {
			applyTransparentChrome(node);
			const width = Math.max(MIN_WIDTH, panelOpen ? SETTINGS_WIDTH : Math.round(Number(canvas.style.width?.replace("px", "")) || layout.imageWidth));
			const height = Math.max(24, Math.ceil(root.scrollHeight || root.offsetHeight || layout.imageHeight));
			node.__gjjWorkflowTitleSize = [width, height];
			node.minWidth = MIN_WIDTH;
			node.min_width = MIN_WIDTH;
			node.setSize?.([width, height]);
			node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		});
	}

	loadFontInfo().then((info) => {
		const fonts = Array.isArray(info?.fonts) ? info.fonts : [];
		const defaultFont = String(info?.default || fonts[0] || "");
		const selected = state.font || defaultFont;
		fontSelect.replaceChildren();
		for (const font of fonts.length ? fonts : [selected].filter(Boolean)) {
			fontSelect.appendChild(new Option(font, font));
		}
		if (selected && !fonts.includes(selected)) fontSelect.appendChild(new Option(selected, selected));
		state.font = selected || state.font;
		fontSelect.value = state.font;
		persistTitleState(node, state);
		applyStateToControls();
		applyTransparentChrome(node, state);
		renderPreview();
		resizeNode();
	});

	applyStateToControls();
	renderPreview();
	setTimeout(resizeNode, 30);
	return root;
}

function ensurePanel(node) {
	if (!node || node.__gjjWorkflowTitleWidget) return;
	applyTransparentChrome(node);
	if (!getWidgetValue(node, CONFIG_WIDGET, "")) {
		setWidgetValue(node, CONFIG_WIDGET, serializeState(DEFAULT_STATE));
	}
	const root = createPanel(node);
	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => node.__gjjWorkflowTitleSize?.[1] || Math.max(24, root.scrollHeight || root.offsetHeight || 24),
	});
	widget.serialize = false;
	node.__gjjWorkflowTitleWidget = widget;
	applyTransparentChrome(node);
}

app.registerExtension({
	name: "Comfy.GJJ.WorkflowTitle",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_CLASS) return;

		safeSetProperty(nodeType, "title_mode", getNoTitleMode());
		nodeType.prototype.computeSize = function (out = [0, 0]) {
			const size = this.__gjjWorkflowTitleSize || [MIN_WIDTH, 80];
			out[0] = size[0];
			out[1] = size[1];
			return out;
		};
		nodeType.prototype.drawBadges = function () {};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => ensurePanel(this), 0);
			setTimeout(() => applyTransparentChrome(this), 80);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			const serialized = restoreConfigValue(this, serializedNode);
			this.__gjjWorkflowTitleApplyState?.(parseState(serialized));
			setTimeout(() => ensurePanel(this), 0);
			setTimeout(() => applyTransparentChrome(this), 80);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			writeSerializedConfig(this, serializedNode);
			applyTransparentChrome(this);
			return result;
		};

		nodeType.prototype.onDrawBackground = function () {
			applyTransparentChrome(this);
		};
	},

	nodeCreated(node) {
		if (targetClass(node) !== TARGET_CLASS) return;
		ensurePanel(node);
		setTimeout(() => applyTransparentChrome(node), 120);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (targetClass(node) === TARGET_CLASS) {
				ensurePanel(node);
				applyTransparentChrome(node);
			}
		}
	},
});

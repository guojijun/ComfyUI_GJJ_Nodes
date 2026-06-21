import { app } from "/scripts/app.js";
import { queueOnlyCurrentNode } from "./gjj_utils.js";
import { translatePromptText } from "./gjj_common_prompt_translation.js";

const TARGET = "GJJ_DoodleCanvas";
const NODE_DISPLAY_NAME = "GJJ · 涂鸦画板";
const DOM_WIDGET = "gjj_doodle_canvas_dom";
const DATA_WIDGET = "doodle_data";
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const BG_WIDGET = "background_color";
const BRUSH_WIDGET = "default_brush_color";
const SIZE_WIDGET = "default_brush_size";
const MODE_WIDGET = "generation_mode";
const PROMPT_WIDGET = "positive_prompt";
const CKPT_WIDGET = "ckpt_name";
const CONTROLNET_WIDGET = "controlnet_name";
const SEED_WIDGET = "seed";
const OUTPUT_MODE_WIDGET = "output_mode";
const PROP_STATE = "gjj_doodle_canvas_state";
const PROP_NODE_SIZE = "gjj_doodle_canvas_node_size";
const PROP_SETTINGS_OPEN = "gjj_doodle_canvas_settings_open";
const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;
const DEFAULT_NODE_WIDTH = 560;
const MIN_NODE_WIDTH = 420;
const MAX_HISTORY = 30;
const TOOL_ICONS = Object.freeze({
	brush: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M40.044693 966.793296h572.067039v57.206704H40.044693z" fill="#1afa29"></path><path d="M566.346369 966.793296H986.815642v57.206704H566.346369zM655.01676 120.134078l240.268156 240.268157-526.301676 526.301676-240.268156-240.268157zM752.268156 25.743017l240.268157 240.268156L921.027933 337.519553l-240.268156-240.268156zM105.832402 672.178771l240.268157 240.268156L8.581006 1006.837989l97.251396-334.659218z" fill="#1afa29"></path><path d="M843.798883 22.882682l148.73743 148.73743c25.743017 25.743017 22.882682 65.787709-2.860335 91.530726s-68.648045 28.603352-91.530727 2.860335l-148.73743-148.73743c-25.743017-22.882682-25.743017-65.787709 2.860335-91.530726 25.743017-25.743017 65.787709-28.603352 91.530727-2.860335z" fill="#1afa29"></path></svg>`,
	eraser: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M597.333333 810.538667h298.666667v85.333333h-384l-170.581333 0.085333-276.778667-276.821333a42.666667 42.666667 0 0 1 0-60.330667L517.12 106.282667a42.666667 42.666667 0 0 1 60.330667 0l331.904 331.861333a42.666667 42.666667 0 0 1 0 60.330667L597.333333 810.538667z m70.698667-191.402667l150.826667-150.826667-271.530667-271.530666-150.826667 150.826666 271.530667 271.530667z" fill="#f4ea2a"></path></svg>`,
	line: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M13 51 51 13" fill="none" stroke="#48c6ff" stroke-width="8" stroke-linecap="round"></path><circle cx="13" cy="51" r="7" fill="#ffd166"></circle><circle cx="51" cy="13" r="7" fill="#ef476f"></circle></svg>`,
	rect: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><rect x="12" y="16" width="40" height="32" rx="5" fill="#1f3a5f" stroke="#45d483" stroke-width="7"></rect></svg>`,
	ellipse: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><ellipse cx="32" cy="32" rx="21" ry="16" fill="#302045" stroke="#c77dff" stroke-width="7"></ellipse><circle cx="44" cy="22" r="5" fill="#ffd166"></circle></svg>`,
	fill: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M18 12h23l11 13-24 24L8 29z" fill="#ffbe55" stroke="#ffe2a6" stroke-width="4" stroke-linejoin="round"></path><path d="M20 12 44 36" stroke="#3a2d1d" stroke-width="5" stroke-linecap="round"></path><path d="M44 41c4 5 7 9 7 12a7 7 0 0 1-14 0c0-3 3-7 7-12z" fill="#3aa0ff"></path></svg>`,
	picker: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M466.9952 400.7936l144.8448 144.8448-325.8368 325.8368a102.4 102.4 0 0 1-99.9936 26.2144l-8.3456 8.2944a51.2 51.2 0 0 1-72.448-72.448l9.1136-9.216c-8.6016-33.792 0.3584-71.168 26.8288-97.6896l325.8368-325.8368z" fill="#A3AEBF" opacity=".5"></path><path d="M684.2368 545.6384L466.9952 328.3968a51.2 51.2 0 0 1 0-72.3968l18.1248-18.1248a76.8 76.8 0 0 1 108.5952 0l181.0432 181.0432a76.8 76.8 0 0 1 0 108.5952l-18.1248 18.1248a51.2 51.2 0 0 1-72.3968 0z" fill="#297EFF"></path><path d="M648.027466 509.421603m-72.407735-72.407734l0 0q-72.407734-72.407734 0-144.815469l144.815469-144.815469q72.407734-72.407734 144.815469 0l0 0q72.407734 72.407734 0 144.815469l-144.815469 144.815469q-72.407734 72.407734-144.815469 0Z" fill="#297EFF"></path></svg>`,
	undo: "↩️",
	redo: "↪️",
	clear: "🧹",
	download: "📥",
	settings: "⚙️",
	outputDoodle: "🎨",
	outputGenerated: "🖼️",
	generate: "🚀",
	translate: "🌐",
});
const HIDDEN_WIDGETS = new Set([
	DATA_WIDGET,
	WIDTH_WIDGET,
	HEIGHT_WIDGET,
	BG_WIDGET,
	BRUSH_WIDGET,
	SIZE_WIDGET,
	MODE_WIDGET,
	PROMPT_WIDGET,
	CKPT_WIDGET,
	CONTROLNET_WIDGET,
	SEED_WIDGET,
	OUTPUT_MODE_WIDGET,
]);

function setButtonContent(button, content) {
	if (!button) return;
	const text = String(content ?? "");
	if (text.trim().startsWith("<svg")) {
		button.innerHTML = text;
	} else {
		button.textContent = text;
	}
}

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name || item?.options?.name === name) || null;
}

function getWidgetValue(node, name, fallback = "") {
	const value = widget(node, name)?.value;
	return value === undefined || value === null || value === "" ? fallback : value;
}

function setWidgetValue(node, name, value, callCallback = true) {
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	if (w.inputEl) w.inputEl.value = value;
	if (w.element && "value" in w.element) w.element.value = value;
	if (callCallback) {
		try { w.callback?.(value); } catch (_) {}
	}
}

function hasLinkedImageInput(node) {
	for (const input of node?.inputs || []) {
		const name = String(input?.name || input?.localized_name || input?.label || input?.display_name || "").toLowerCase();
		const type = String(input?.type || "").toLowerCase();
		const isImageInput = name === "image" || name === "图像" || type.includes("image");
		if (isImageInput && (input?.link !== null && input?.link !== undefined || Array.isArray(input?.links) && input.links.length > 0)) {
			return true;
		}
	}
	return false;
}

function collapseElement(element) {
	if (!element?.style) return;
	element.style.display = "none";
	element.style.height = "0px";
	element.style.minHeight = "0px";
	element.style.maxHeight = "0px";
	element.style.margin = "0px";
	element.style.padding = "0px";
	element.style.border = "0px";
	element.style.overflow = "hidden";
}

function collapseWidget(w) {
	if (!w || w.__gjjDoodleCollapsed) return;
	w.__gjjDoodleCollapsed = true;
	w.hidden = true;
	w.type = `converted-widget:${w.name || "hidden"}`;
	w.serialize = true;
	w.computeSize = () => [0, -4];
	w.getHeight = () => -4;
	w.draw = () => {};
	w.y = 0;
	w.last_y = 0;
	if (w.options && typeof w.options === "object") {
		w.options.hidden = true;
		w.options.display = "hidden";
	}
	collapseElement(w.inputEl);
	collapseElement(w.element);
	collapseElement(w.widget);
}

function parseJson(text, fallback) {
	try {
		const value = JSON.parse(String(text || ""));
		return value ?? fallback;
	} catch (_) {
		return fallback;
	}
}

function serializableWidgetIndex(node, name) {
	let index = -1;
	for (const w of node?.widgets || []) {
		if (w?.serialize !== false) index += 1;
		const widgetName = w?.name || w?.options?.name;
		if (widgetName === name) return w?.serialize === false ? -1 : index;
	}
	return -1;
}

function setSerializedWidgetValue(node, serializedNode, name, value) {
	if (!serializedNode) return;
	if (Array.isArray(serializedNode.widgets_values)) {
		const index = serializableWidgetIndex(node, name);
		if (index >= 0 && index < serializedNode.widgets_values.length) {
			serializedNode.widgets_values[index] = value;
		}
		return;
	}
	if (serializedNode.widgets_values && typeof serializedNode.widgets_values === "object") {
		serializedNode.widgets_values[name] = value;
	}
}

function compactStateForStorage(text) {
	const state = parseJson(text, null);
	if (!state || typeof state !== "object" || Array.isArray(state)) return String(text || "");
	const compact = { ...state };
	const doodleImage = compact.doodleImage || compact.image || compact.data_url || compact.png || "";
	if (doodleImage && !compact.doodleImage) compact.doodleImage = doodleImage;
	delete compact.image;
	delete compact.data_url;
	delete compact.png;
	delete compact.generatedImage;
	delete compact.generated_image;
	if (compact.displayImage === "generated") compact.displayImage = "doodle";
	return JSON.stringify(compact);
}

function firstMessageValue(...candidates) {
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			const value = candidate.find((item) => item !== undefined && item !== null && String(item).trim() !== "");
			if (value !== undefined && value !== null) return value;
			continue;
		}
		if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
			return candidate;
		}
	}
	return "";
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function coerceDimension(value, fallback) {
	const number = Math.round(Number(value));
	return Number.isFinite(number) ? clamp(number, 16, 4096) : fallback;
}

function coerceBrushSize(value, fallback = 6) {
	const number = Math.round(Number(value));
	return Number.isFinite(number) ? clamp(number, 1, 256) : fallback;
}

function normalizeHex(value, fallback = "#000000") {
	const text = String(value || "").trim();
	if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
	if (/^#[0-9a-f]{3}$/i.test(text)) {
		return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
	}
	const rgb = text.match(/^rgba?\(([^)]+)\)/i);
	if (rgb) {
		const parts = rgb[1].split(",").slice(0, 3).map((part) => clamp(Math.round(Number(part.trim())), 0, 255));
		if (parts.length === 3 && parts.every(Number.isFinite)) {
			return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
		}
	}
	return fallback;
}

function hexToRgba(value) {
	const hex = normalizeHex(value, "#000000");
	return [
		parseInt(hex.slice(1, 3), 16),
		parseInt(hex.slice(3, 5), 16),
		parseInt(hex.slice(5, 7), 16),
		255,
	];
}

function rgbaToHex(r, g, b) {
	return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function isSameColor(data, offset, rgba, tolerance = 0) {
	return Math.max(
		Math.abs(data[offset] - rgba[0]),
		Math.abs(data[offset + 1] - rgba[1]),
		Math.abs(data[offset + 2] - rgba[2]),
		Math.abs(data[offset + 3] - rgba[3]),
	) <= tolerance;
}

function ensureStyles() {
	if (document.getElementById("gjj-doodle-canvas-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-doodle-canvas-style";
	style.textContent = `
		.gjj-doodle { width:100%; box-sizing:border-box; display:flex; flex-direction:column; gap:7px; color:#dbe7e8; font:12px/1.35 Arial, sans-serif; }
		.gjj-doodle * { box-sizing:border-box; }
		.gjj-doodle-toolbar, .gjj-doodle-controls { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
		.gjj-doodle button { flex:0 0 32px; width:32px; min-width:32px; height:30px; padding:0; border:1px solid #3a4d55; border-radius:7px; background:#202b31; color:#e7f3f3; font-size:22px; font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",Arial,sans-serif; font-weight:700; cursor:pointer; line-height:1; display:inline-flex; align-items:center; justify-content:center; overflow:hidden; }
		.gjj-doodle button svg { width:25px; height:25px; display:block; pointer-events:none; }
		.gjj-doodle button:hover { background:#2d3a42; border-color:#6aa6b8; }
		.gjj-doodle button.on { border-color:#54c78b; background:#20382f; color:#dff8ea; }
		.gjj-doodle-color { width:30px; height:26px; padding:0; border:1px solid #3a4d55; border-radius:6px; background:#202b31; cursor:pointer; }
		.gjj-doodle-range { width:112px; height:26px; accent-color:#54c78b; }
		.gjj-doodle-size { min-width:32px; color:#b9c7ca; text-align:right; font-size:11px; }
		.gjj-doodle-prompt { display:grid; grid-template-columns:minmax(76px, 94px) minmax(0, 1fr) 32px; gap:6px; align-items:stretch; }
		.gjj-doodle-prompt-label { color:#b8c7ca; font-size:12px; display:flex; align-items:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-doodle-prompt textarea { width:100%; min-width:0; height:48px; min-height:48px; max-height:96px; resize:vertical; border:1px solid #354852; border-radius:6px; background:#151f25; color:#e5edf2; padding:6px 8px; font:12px/1.35 Arial, sans-serif; outline:none; }
		.gjj-doodle-prompt textarea:focus { border-color:#54c78b; }
		.gjj-doodle-settings { display:none; grid-template-columns:minmax(76px, 94px) minmax(0, 1fr); gap:6px 8px; align-items:center; padding:8px; border:1px solid #33464e; border-radius:8px; background:#101820; }
		.gjj-doodle-settings.open { display:grid; }
		.gjj-doodle-settings-label { color:#b8c7ca; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-doodle-settings input, .gjj-doodle-settings select { width:100%; min-width:0; height:28px; border:1px solid #354852; border-radius:6px; background:#242b31; color:#e5edf2; padding:0 8px; font:12px Arial, sans-serif; outline:none; }
		.gjj-doodle-settings input:focus, .gjj-doodle-settings select:focus { border-color:#54c78b; }
		.gjj-doodle-settings-pair { display:grid; grid-template-columns:1fr 1fr; gap:6px; min-width:0; }
		.gjj-doodle-canvas-wrap { width:100%; position:relative; overflow:hidden; border:1px solid #33464e; border-radius:8px; background:#071014; display:flex; align-items:center; justify-content:center; touch-action:none; }
		.gjj-doodle-canvas { display:block; max-width:100%; image-rendering:auto; cursor:crosshair; touch-action:none; }
		.gjj-doodle-status { color:#9eb1b6; min-height:16px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-doodle-swatch { border-color:rgba(255,255,255,0.22) !important; }
	`;
	document.head.appendChild(style);
}

class DoodleEditor {
	constructor(node, container) {
		this.node = node;
		this.container = container;
		this.tool = "brush";
		this.drag = null;
		this.history = [];
		this.historyIndex = -1;
		this.loadingImage = false;
		this.pendingStateText = "";
		this.generating = false;
		this.translating = false;
		this.outputMode = "doodle";
		this.doodleImageData = "";
		this.generatedImageData = "";
		this.activeImageKind = "doodle";
		this.displayWidth = 480;
		this.displayHeight = 480;
		this.buildDom();
		this.loadInitialState();
		this.bindEvents();
		this.layout();
		this.renderStatus();
	}

	buildDom() {
		this.container.innerHTML = "";
		this.container.className = "gjj-doodle";

		this.toolbar = document.createElement("div");
		this.toolbar.className = "gjj-doodle-toolbar";
		this.buttons = {
			brush: this.makeButton(TOOL_ICONS.brush, "自由线：拖动绘制自由线条", () => this.setTool("brush")),
			eraser: this.makeButton(TOOL_ICONS.eraser, "橡皮擦：用背景色擦除", () => this.setTool("eraser")),
			line: this.makeButton(TOOL_ICONS.line, "直线：拖动绘制线条", () => this.setTool("line")),
			rect: this.makeButton(TOOL_ICONS.rect, "矩形：拖动绘制矩形轮廓", () => this.setTool("rect")),
			ellipse: this.makeButton(TOOL_ICONS.ellipse, "椭圆：拖动绘制椭圆轮廓", () => this.setTool("ellipse")),
			fill: this.makeButton(TOOL_ICONS.fill, "油漆桶：填充相近颜色区域", () => this.setTool("fill")),
			picker: this.makeButton(TOOL_ICONS.picker, "取色：从画布采样颜色", () => this.setTool("picker")),
			undo: this.makeButton(TOOL_ICONS.undo, "撤销", () => this.restoreHistory(-1)),
			redo: this.makeButton(TOOL_ICONS.redo, "重做", () => this.restoreHistory(1)),
			clear: this.makeButton(TOOL_ICONS.clear, "清空画布并填充背景色", () => this.clearCanvas()),
			download: this.makeButton(TOOL_ICONS.download, "下载当前涂鸦 PNG", () => this.downloadPng()),
			settings: this.makeButton(TOOL_ICONS.settings, "设置", () => this.toggleSettings()),
			output: this.makeButton(TOOL_ICONS.outputDoodle, "当前输出：涂鸦。点击切换为生成图", () => this.toggleOutputMode()),
			generate: this.makeButton(TOOL_ICONS.generate, "用当前涂鸦直接原地生成图片", () => this.generateInPlace()),
		};
		this.toolbar.append(
			this.buttons.brush,
			this.buttons.eraser,
			this.buttons.line,
			this.buttons.rect,
			this.buttons.ellipse,
			this.buttons.fill,
			this.buttons.picker,
			this.buttons.undo,
			this.buttons.redo,
			this.buttons.clear,
			this.buttons.download,
			this.buttons.settings,
			this.buttons.output,
			this.buttons.generate,
		);

		this.controls = document.createElement("div");
		this.controls.className = "gjj-doodle-controls";
		this.brushColor = document.createElement("input");
		this.brushColor.type = "color";
		this.brushColor.className = "gjj-doodle-color";
		this.brushColor.title = "画笔颜色";
		this.bgColor = document.createElement("input");
		this.bgColor.type = "color";
		this.bgColor.className = "gjj-doodle-color";
		this.bgColor.title = "背景颜色/橡皮擦颜色";
		this.sizeRange = document.createElement("input");
		this.sizeRange.type = "range";
		this.sizeRange.min = "1";
		this.sizeRange.max = "256";
		this.sizeRange.step = "1";
		this.sizeRange.className = "gjj-doodle-range";
		this.sizeRange.title = "画笔粗细";
		this.sizeText = document.createElement("span");
		this.sizeText.className = "gjj-doodle-size";
		this.sizeText.textContent = "6";

		this.swatches = ["#ffffff", "#000000", "#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#af52de"].map((color) => {
			const button = this.makeButton("", `颜色 ${color}`, () => this.setBrushColor(color));
			button.classList.add("gjj-doodle-swatch");
			button.style.background = color;
			button.style.color = color;
			return button;
		});
		this.controls.append(this.brushColor, this.bgColor, this.sizeRange, this.sizeText, ...this.swatches);
		this.buildPromptPanel();
		this.buildSettingsPanel();

		this.canvasWrap = document.createElement("div");
		this.canvasWrap.className = "gjj-doodle-canvas-wrap";
		this.canvas = document.createElement("canvas");
		this.canvas.className = "gjj-doodle-canvas";
		this.canvasWrap.appendChild(this.canvas);
		this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
		this.status = document.createElement("div");
		this.status.className = "gjj-doodle-status";
		this.container.append(this.toolbar, this.controls, this.promptPanel, this.settingsPanel, this.canvasWrap, this.status);
		this.setTool("brush");
	}

	buildPromptPanel() {
		this.promptPanel = document.createElement("div");
		this.promptPanel.className = "gjj-doodle-prompt";
		const label = document.createElement("div");
		label.className = "gjj-doodle-prompt-label";
		label.textContent = "正向提示词";
		this.promptInput = this.makeTextarea("正向提示词");
		this.buttons.translate = this.makeButton(TOOL_ICONS.translate, "翻译正向提示词", () => this.translatePrompt());
		this.promptPanel.append(label, this.promptInput, this.buttons.translate);
	}

	buildSettingsPanel() {
		this.settingsPanel = document.createElement("div");
		this.settingsPanel.className = "gjj-doodle-settings";
		this.settingsPanel.title = "⚙️ 设置";
		this.dimensionWrap = document.createElement("div");
		this.dimensionWrap.className = "gjj-doodle-settings-pair";
		this.widthInput = this.makeInput("number", "画布宽度");
		this.heightInput = this.makeInput("number", "画布高度");
		for (const input of [this.widthInput, this.heightInput]) {
			input.min = "16";
			input.max = "4096";
			input.step = "8";
		}
		this.dimensionWrap.append(this.widthInput, this.heightInput);
		this.ckptSelect = this.makeSelect("UNET 主模型");
		this.controlnetSelect = this.makeSelect("涂鸦控制模型");
		this.seedInput = this.makeInput("text", "种子");
		this.appendSettingRow("画布尺寸", this.dimensionWrap);
		this.appendSettingRow("UNET 主模型", this.ckptSelect);
		this.appendSettingRow("涂鸦控制模型", this.controlnetSelect);
		this.appendSettingRow("种子", this.seedInput);
	}

	makeTextarea(title) {
		const textarea = document.createElement("textarea");
		textarea.title = title;
		textarea.spellcheck = false;
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
			textarea.addEventListener(eventName, (event) => event.stopPropagation());
		}
		return textarea;
	}

	makeInput(type, title) {
		const input = document.createElement("input");
		input.type = type;
		input.title = title;
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
			input.addEventListener(eventName, (event) => event.stopPropagation());
		}
		return input;
	}

	makeSelect(title) {
		const select = document.createElement("select");
		select.title = title;
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
			select.addEventListener(eventName, (event) => event.stopPropagation());
		}
		return select;
	}

	appendSettingRow(label, control) {
		const labelEl = document.createElement("div");
		labelEl.className = "gjj-doodle-settings-label";
		labelEl.textContent = label;
		this.settingsPanel.append(labelEl, control);
	}

	makeButton(label, title, action) {
		const button = document.createElement("button");
		button.type = "button";
		setButtonContent(button, label);
		button.title = title;
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "wheel", "contextmenu"]) {
			button.addEventListener(eventName, (event) => event.stopPropagation());
		}
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			action();
		});
		return button;
	}

	bindEvents() {
		for (const element of [this.container, this.canvasWrap, this.canvas, this.controls, this.toolbar, this.promptPanel, this.settingsPanel]) {
			for (const eventName of ["pointerdown", "mousedown", "mousemove", "mouseup", "wheel", "dblclick", "contextmenu"]) {
				element.addEventListener(eventName, (event) => event.stopPropagation());
			}
		}
		this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
		this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
		this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
		this.canvas.addEventListener("pointercancel", (event) => this.onPointerUp(event));
		this.canvas.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		this.canvas.addEventListener("wheel", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const next = coerceBrushSize(Number(this.sizeRange.value || 6) + (event.deltaY < 0 ? 1 : -1), 6);
			this.setBrushSize(next);
		}, { passive: false });
		this.brushColor.addEventListener("input", () => this.setBrushColor(this.brushColor.value, false));
		this.bgColor.addEventListener("input", () => this.setBackgroundColor(this.bgColor.value, false));
		this.sizeRange.addEventListener("input", () => this.setBrushSize(this.sizeRange.value, false));
		this.widthInput.addEventListener("change", () => this.applyCanvasSizeInputs());
		this.heightInput.addEventListener("change", () => this.applyCanvasSizeInputs());
		this.promptInput.addEventListener("input", () => this.syncGenerationSettings());
		this.ckptSelect.addEventListener("change", () => this.syncGenerationSettings());
		this.controlnetSelect.addEventListener("change", () => this.syncGenerationSettings());
		this.seedInput.addEventListener("input", () => this.syncGenerationSettings());
	}

	widgetOptions(name, currentValue = "") {
		const w = widget(this.node, name);
		const values = Array.isArray(w?.options?.values) ? w.options.values.map(String) : [];
		const current = String(currentValue || w?.value || "");
		if (current && !values.includes(current)) values.unshift(current);
		return values;
	}

	populateSelect(select, values, currentValue) {
		select.innerHTML = "";
		for (const value of values) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			select.appendChild(option);
		}
		if (currentValue) select.value = String(currentValue);
	}

	setSettingsOpen(open) {
		const value = Boolean(open);
		this.node.properties = this.node.properties || {};
		this.node.properties[PROP_SETTINGS_OPEN] = value;
		this.settingsPanel.classList.toggle("open", value);
		this.buttons.settings.classList.toggle("on", value);
		this.buttons.settings.title = value ? "收起设置" : "设置";
		this.layout();
		this.node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	toggleSettings() {
		this.setSettingsOpen(!this.settingsPanel.classList.contains("open"));
	}

	syncSettingsPanelFromWidgets(state = {}) {
		const width = coerceDimension(getWidgetValue(this.node, WIDTH_WIDGET, state.width || DEFAULT_WIDTH), DEFAULT_WIDTH);
		const height = coerceDimension(getWidgetValue(this.node, HEIGHT_WIDGET, state.height || DEFAULT_HEIGHT), DEFAULT_HEIGHT);
		const prompt = state.positivePrompt ?? getWidgetValue(this.node, PROMPT_WIDGET, "");
		const ckpt = state.ckptName ?? getWidgetValue(this.node, CKPT_WIDGET, "");
		const controlnet = state.controlnetName ?? getWidgetValue(this.node, CONTROLNET_WIDGET, "");
		const seed = state.seed ?? getWidgetValue(this.node, SEED_WIDGET, "240272355371031");
		const outputMode = state.outputMode ?? getWidgetValue(this.node, OUTPUT_MODE_WIDGET, "doodle");
		this.widthInput.value = String(width);
		this.heightInput.value = String(height);
		this.promptInput.value = String(prompt || "");
		this.populateSelect(this.ckptSelect, this.widgetOptions(CKPT_WIDGET, ckpt), ckpt);
		this.populateSelect(this.controlnetSelect, this.widgetOptions(CONTROLNET_WIDGET, controlnet), controlnet);
		this.seedInput.value = String(seed || "");
		setWidgetValue(this.node, PROMPT_WIDGET, this.promptInput.value, false);
		setWidgetValue(this.node, CKPT_WIDGET, this.ckptSelect.value, false);
		setWidgetValue(this.node, CONTROLNET_WIDGET, this.controlnetSelect.value, false);
		setWidgetValue(this.node, SEED_WIDGET, this.seedInput.value, false);
		setWidgetValue(this.node, MODE_WIDGET, "doodle", false);
		this.setOutputMode(outputMode, false);
		const open = state.settingsOpen ?? this.node.properties?.[PROP_SETTINGS_OPEN] ?? false;
		this.setSettingsOpen(open);
	}

	normalizeOutputMode(mode) {
		return String(mode || "").toLowerCase() === "generated" ? "generated" : "doodle";
	}

	setOutputMode(mode, shouldSync = true) {
		this.outputMode = this.normalizeOutputMode(mode);
		setWidgetValue(this.node, OUTPUT_MODE_WIDGET, this.outputMode, false);
		this.updateOutputButton();
		if (shouldSync) this.syncState();
	}

	toggleOutputMode() {
		this.setOutputMode(this.outputMode === "generated" ? "doodle" : "generated");
	}

	shouldGenerateOnQueue() {
		return this.normalizeOutputMode(this.outputMode || getWidgetValue(this.node, OUTPUT_MODE_WIDGET, "doodle")) === "generated";
	}

	updateOutputButton() {
		const button = this.buttons?.output;
		if (!button) return;
		const generated = this.outputMode === "generated";
		setButtonContent(button, generated ? TOOL_ICONS.outputGenerated : TOOL_ICONS.outputDoodle);
		button.classList.toggle("on", generated);
		button.title = generated
			? "当前输出：生成图；点击运行时会先生成。点击切换为涂鸦"
			: "当前输出：涂鸦。点击切换为生成图";
	}

	applyCanvasSizeInputs() {
		const width = coerceDimension(this.widthInput.value, this.canvas.width || DEFAULT_WIDTH);
		const height = coerceDimension(this.heightInput.value, this.canvas.height || DEFAULT_HEIGHT);
		this.widthInput.value = String(width);
		this.heightInput.value = String(height);
		setWidgetValue(this.node, WIDTH_WIDGET, width, false);
		setWidgetValue(this.node, HEIGHT_WIDGET, height, false);
		this.resizeFromWidgets(true);
	}

	syncGenerationSettings() {
		setWidgetValue(this.node, PROMPT_WIDGET, this.promptInput.value, false);
		setWidgetValue(this.node, CKPT_WIDGET, this.ckptSelect.value, false);
		setWidgetValue(this.node, CONTROLNET_WIDGET, this.controlnetSelect.value, false);
		setWidgetValue(this.node, SEED_WIDGET, this.seedInput.value, false);
		setWidgetValue(this.node, OUTPUT_MODE_WIDGET, this.outputMode, false);
		this.syncState();
	}

	async translatePrompt() {
		if (this.translating) return;
		const source = String(this.promptInput.value || "").trim();
		if (!source) {
			this.renderStatus("没有需要翻译的提示词");
			return;
		}
		const button = this.buttons.translate;
		const oldText = button.textContent;
		this.translating = true;
		button.textContent = "…";
		button.disabled = true;
		button.style.opacity = "0.7";
		this.renderStatus("正在翻译");
		try {
			const translated = await translatePromptText({
				node: this.node,
				text: source,
				device: "auto",
				maxLength: 512,
				batchSize: 8,
				unloadAfterUse: false,
				nodeName: NODE_DISPLAY_NAME,
			});
			if (translated.trim()) {
				this.promptInput.value = translated;
				this.syncGenerationSettings();
				this.renderStatus("翻译完成");
			} else {
				this.renderStatus("翻译结果为空");
			}
		} catch (error) {
			console.error("[GJJ] 涂鸦画板提示词翻译失败:", error);
			this.renderStatus(`翻译失败：${error?.message || error}`);
		} finally {
			this.translating = false;
			button.textContent = oldText;
			button.disabled = false;
			button.style.opacity = "1";
		}
	}

	async generateInPlace() {
		if (this.generating) return;
		this.prepareQueuedGeneration();
		this.node.__gjjDoodleExplicitGenerate = true;
		this.markQueuedGeneration("生成中");
		try {
			const ok = await queueOnlyCurrentNode(this.node);
			this.resetGenerationMode();
			if (!ok) {
				delete this.node.__gjjDoodleExplicitGenerate;
				this.finishGenerating("提交失败");
				return;
			}
			this.renderStatus("已提交生成");
			clearTimeout(this.generateFallbackTimer);
			this.generateFallbackTimer = window.setTimeout(() => this.finishGenerating(), 600000);
		} catch (error) {
			console.error("[GJJ] 涂鸦画板原地生成失败:", error);
			this.resetGenerationMode();
			delete this.node.__gjjDoodleExplicitGenerate;
			this.finishGenerating("生成失败");
		}
	}

	prepareQueuedDoodle() {
		if (this.activeImageKind === "doodle") {
			this.doodleImageData = this.canvas.toDataURL("image/png");
		}
		this.syncGenerationSettings();
		this.syncState();
		setWidgetValue(this.node, MODE_WIDGET, "doodle", false);
		delete this.node.__gjjDoodleQueueGeneration;
	}

	prepareQueuedGeneration(statusMessage = "") {
		if (this.activeImageKind !== "upstream") {
			this.doodleImageData = this.canvas.toDataURL("image/png");
		}
		this.node.__gjjDoodleQueueGeneration = true;
		setWidgetValue(this.node, MODE_WIDGET, "generate", false);
		this.syncGenerationSettings();
		this.syncState();
		if (statusMessage) this.renderStatus(statusMessage);
	}

	markQueuedGeneration(message = "生成中") {
		if (!this.generating) {
			this.generating = true;
			const button = this.buttons?.generate;
			if (button) {
				this.generateButtonText = button.textContent;
				button.textContent = "…";
				button.disabled = true;
				button.style.opacity = "0.7";
			}
		}
		if (message) this.renderStatus(message);
		clearTimeout(this.generateFallbackTimer);
		this.generateFallbackTimer = window.setTimeout(() => this.finishGenerating(), 600000);
	}

	finishGenerating(message = "") {
		clearTimeout(this.generateFallbackTimer);
		this.generating = false;
		const button = this.buttons?.generate;
		if (button) {
			button.textContent = this.generateButtonText || "✔";
			button.disabled = false;
			button.style.opacity = "1";
		}
		if (message) this.renderStatus(message);
		else this.renderStatus();
	}

	applyGeneratedImage(value) {
		const text = String(value || "").trim();
		if (!text) return false;
		const src = text.startsWith("data:") ? text : `data:image/png;base64,${text}`;
		this.generatedImageData = src;
		this.activeImageKind = "generated";
		const previousSnapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
		this.loadImage(src, true, "生成完成", previousSnapshot, "generated");
		this.finishGenerating("生成完成");
		return true;
	}

	hasUpstreamImage() {
		return hasLinkedImageInput(this.node);
	}

	applyUpstreamImage(value) {
		const text = String(value || "").trim();
		if (!text) return false;
		const src = text.startsWith("data:") ? text : `data:image/png;base64,${text}`;
		this.activeImageKind = "upstream";
		this.loadImage(src, false, "已使用上游图像", null, "upstream");
		return true;
	}

	resetGenerationMode() {
		if (String(getWidgetValue(this.node, MODE_WIDGET, "doodle")) !== "doodle") {
			setWidgetValue(this.node, MODE_WIDGET, "doodle", false);
		}
	}

	loadInitialState() {
		const raw = getWidgetValue(this.node, DATA_WIDGET, "") || this.node.properties?.[PROP_STATE] || "";
		const state = parseJson(raw, {});
		const width = coerceDimension(getWidgetValue(this.node, WIDTH_WIDGET, state.width || DEFAULT_WIDTH), DEFAULT_WIDTH);
		const height = coerceDimension(getWidgetValue(this.node, HEIGHT_WIDGET, state.height || DEFAULT_HEIGHT), DEFAULT_HEIGHT);
		const bg = normalizeHex(state.backgroundColor || getWidgetValue(this.node, BG_WIDGET, "#000000"), "#000000");
		const brush = normalizeHex(state.brushColor || getWidgetValue(this.node, BRUSH_WIDGET, "#ffffff"), "#ffffff");
		const size = coerceBrushSize(state.brushSize || getWidgetValue(this.node, SIZE_WIDGET, 6), 6);
		const storedVisibleImage = typeof state.image === "string" ? String(state.image || "") : "";
		const storedDoodleImage = String(state.doodleImage || storedVisibleImage || "");
		const storedGeneratedImage = String(state.generatedImage || state.generated_image || "");
		this.doodleImageData = storedDoodleImage;
		this.generatedImageData = storedGeneratedImage;
		const requestedDisplay = String(state.displayImage || "").toLowerCase();
		if (requestedDisplay === "generated" && storedGeneratedImage) {
			this.activeImageKind = "generated";
		} else if (!requestedDisplay && storedVisibleImage && storedDoodleImage && storedVisibleImage !== storedDoodleImage && storedGeneratedImage) {
			this.activeImageKind = "generated";
		} else {
			this.activeImageKind = "doodle";
		}
		const initialImage = !requestedDisplay && storedVisibleImage
			? storedVisibleImage
			: this.activeImageKind === "generated" && storedGeneratedImage
			? storedGeneratedImage
			: storedDoodleImage;
		this.brushColor.value = brush;
		this.bgColor.value = bg;
		this.sizeRange.value = String(size);
		this.sizeText.textContent = String(size);
		this.setCanvasSize(width, height, false);
		setWidgetValue(this.node, WIDTH_WIDGET, width, false);
		setWidgetValue(this.node, HEIGHT_WIDGET, height, false);
		setWidgetValue(this.node, BG_WIDGET, bg, false);
		setWidgetValue(this.node, BRUSH_WIDGET, brush, false);
		setWidgetValue(this.node, SIZE_WIDGET, size, false);
		this.syncSettingsPanelFromWidgets(state);

		if (initialImage) {
			this.pendingStateText = String(raw || "");
			this.loadImage(initialImage, false, "", null, this.activeImageKind);
			return;
		}
		this.fillBackground();
		this.resetHistory();
		this.syncState();
	}

	setCanvasSize(width, height, preserve = true) {
		width = coerceDimension(width, DEFAULT_WIDTH);
		height = coerceDimension(height, DEFAULT_HEIGHT);
		const old = document.createElement("canvas");
		if (preserve && this.canvas.width > 0 && this.canvas.height > 0) {
			old.width = this.canvas.width;
			old.height = this.canvas.height;
			old.getContext("2d").drawImage(this.canvas, 0, 0);
		}
		this.canvas.width = width;
		this.canvas.height = height;
		this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
		this.ctx.imageSmoothingEnabled = true;
		this.fillBackground();
		if (preserve && old.width > 0 && old.height > 0) {
			this.ctx.drawImage(old, 0, 0);
		}
	}

	resizeFromWidgets(record = true) {
		const width = coerceDimension(getWidgetValue(this.node, WIDTH_WIDGET, this.canvas.width || DEFAULT_WIDTH), DEFAULT_WIDTH);
		const height = coerceDimension(getWidgetValue(this.node, HEIGHT_WIDGET, this.canvas.height || DEFAULT_HEIGHT), DEFAULT_HEIGHT);
		if (this.widthInput) this.widthInput.value = String(width);
		if (this.heightInput) this.heightInput.value = String(height);
		if (width === this.canvas.width && height === this.canvas.height) return;
		this.setCanvasSize(width, height, true);
		this.layout();
		if (record) this.recordSnapshot();
		else this.syncState();
	}

	fillBackground() {
		if (!this.ctx) return;
		this.ctx.save();
		this.ctx.globalCompositeOperation = "source-over";
		this.ctx.fillStyle = this.currentBackgroundColor();
		this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.restore();
	}

	loadImage(src, shouldSync = true, statusMessage = "", previousSnapshot = null, imageKind = null) {
		const image = new Image();
		this.loadingImage = true;
		image.onload = () => {
			if (imageKind) this.activeImageKind = imageKind;
			this.setCanvasSize(this.canvas.width || image.naturalWidth || DEFAULT_WIDTH, this.canvas.height || image.naturalHeight || DEFAULT_HEIGHT, false);
			this.ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
			this.loadingImage = false;
			this.pendingStateText = "";
			if (previousSnapshot) {
				const generatedSnapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
				this.history = [previousSnapshot, generatedSnapshot];
				this.historyIndex = 1;
				this.updateHistoryButtons();
			} else {
				this.resetHistory();
			}
			this.layout();
			if (shouldSync) this.syncState();
			else this.renderStatus();
			if (statusMessage) this.renderStatus(statusMessage);
		};
		image.onerror = () => {
			this.loadingImage = false;
			this.pendingStateText = "";
			this.fillBackground();
			this.resetHistory();
			this.syncState();
		};
		image.src = src;
	}

	currentBackgroundColor() {
		return normalizeHex(this.bgColor.value, "#000000");
	}

	currentBrushColor() {
		return normalizeHex(this.brushColor.value, "#ffffff");
	}

	currentBrushSize() {
		return coerceBrushSize(this.sizeRange.value, 6);
	}

	setBrushColor(color, fromButton = true) {
		const value = normalizeHex(color, this.currentBrushColor());
		this.brushColor.value = value;
		setWidgetValue(this.node, BRUSH_WIDGET, value, false);
		if (fromButton) this.setTool("brush");
		this.syncState();
	}

	setBackgroundColor(color, fromButton = true) {
		const value = normalizeHex(color, this.currentBackgroundColor());
		this.bgColor.value = value;
		setWidgetValue(this.node, BG_WIDGET, value, false);
		if (fromButton) this.setTool("eraser");
		this.syncState();
	}

	setBrushSize(size, shouldSync = true) {
		const value = coerceBrushSize(size, 6);
		this.sizeRange.value = String(value);
		this.sizeText.textContent = String(value);
		setWidgetValue(this.node, SIZE_WIDGET, value, false);
		if (shouldSync) this.syncState();
		this.renderStatus();
	}

	setTool(tool) {
		this.tool = tool;
		for (const name of ["brush", "eraser", "line", "rect", "ellipse", "fill", "picker"]) {
			const button = this.buttons?.[name];
			button.classList.toggle("on", name === tool);
		}
		this.canvas.style.cursor = tool === "picker" ? "cell" : "crosshair";
		this.renderStatus();
	}

	eventPoint(event) {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: clamp((event.clientX - rect.left) * this.canvas.width / Math.max(1, rect.width), 0, this.canvas.width - 1),
			y: clamp((event.clientY - rect.top) * this.canvas.height / Math.max(1, rect.height), 0, this.canvas.height - 1),
		};
	}

	onPointerDown(event) {
		event.preventDefault();
		event.stopPropagation();
		if (event.button !== 0) return;
		const point = this.eventPoint(event);
		if (this.tool === "fill") {
			this.floodFill(Math.round(point.x), Math.round(point.y), this.currentBrushColor());
			this.recordSnapshot();
			return;
		}
		if (this.tool === "picker") {
			this.pickColor(point);
			return;
		}
		this.drag = {
			tool: this.tool,
			start: point,
			last: point,
			preview: ["line", "rect", "ellipse"].includes(this.tool)
				? this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
				: null,
			moved: false,
		};
		try { this.canvas.setPointerCapture(event.pointerId); } catch (_) {}
		if (this.tool === "brush" || this.tool === "eraser") {
			this.drawDot(point, this.tool === "eraser");
		}
	}

	onPointerMove(event) {
		if (!this.drag) return;
		event.preventDefault();
		event.stopPropagation();
		const point = this.eventPoint(event);
		this.drag.moved = true;
		if (this.drag.tool === "brush" || this.drag.tool === "eraser") {
			this.drawStroke(this.drag.last, point, this.drag.tool === "eraser");
			this.drag.last = point;
			return;
		}
		if (this.drag.preview) {
			this.ctx.putImageData(this.drag.preview, 0, 0);
			this.drawShape(this.drag.tool, this.drag.start, point);
		}
	}

	onPointerUp(event) {
		if (!this.drag) return;
		event.preventDefault();
		event.stopPropagation();
		const point = this.eventPoint(event);
		if (this.drag.preview) {
			this.ctx.putImageData(this.drag.preview, 0, 0);
			this.drawShape(this.drag.tool, this.drag.start, point);
		}
		this.drag = null;
		try { this.canvas.releasePointerCapture(event.pointerId); } catch (_) {}
		this.recordSnapshot();
	}

	applyStrokeStyle(isEraser = false) {
		const size = this.currentBrushSize();
		this.ctx.save();
		this.ctx.globalCompositeOperation = "source-over";
		this.ctx.lineWidth = size;
		this.ctx.lineCap = "round";
		this.ctx.lineJoin = "round";
		this.ctx.strokeStyle = isEraser ? this.currentBackgroundColor() : this.currentBrushColor();
		this.ctx.fillStyle = this.ctx.strokeStyle;
	}

	drawDot(point, isEraser = false) {
		const radius = this.currentBrushSize() / 2;
		this.applyStrokeStyle(isEraser);
		this.ctx.beginPath();
		this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
		this.ctx.fill();
		this.ctx.restore();
	}

	drawStroke(from, to, isEraser = false) {
		this.applyStrokeStyle(isEraser);
		this.ctx.beginPath();
		this.ctx.moveTo(from.x, from.y);
		this.ctx.lineTo(to.x, to.y);
		this.ctx.stroke();
		this.ctx.restore();
	}

	drawShape(tool, start, end) {
		this.applyStrokeStyle(false);
		const x = Math.min(start.x, end.x);
		const y = Math.min(start.y, end.y);
		const width = Math.abs(end.x - start.x);
		const height = Math.abs(end.y - start.y);
		this.ctx.beginPath();
		if (tool === "line") {
			this.ctx.moveTo(start.x, start.y);
			this.ctx.lineTo(end.x, end.y);
		} else if (tool === "rect") {
			this.ctx.rect(x, y, width, height);
		} else if (tool === "ellipse") {
			this.ctx.ellipse(x + width / 2, y + height / 2, Math.max(0.5, width / 2), Math.max(0.5, height / 2), 0, 0, Math.PI * 2);
		}
		this.ctx.stroke();
		this.ctx.restore();
	}

	floodFill(startX, startY, color) {
		const width = this.canvas.width;
		const height = this.canvas.height;
		const imageData = this.ctx.getImageData(0, 0, width, height);
		const data = imageData.data;
		const startIndex = (startY * width + startX) * 4;
		const target = [data[startIndex], data[startIndex + 1], data[startIndex + 2], data[startIndex + 3]];
		const replacement = hexToRgba(color);
		if (isSameColor(data, startIndex, replacement, 2)) return;
		const visited = new Uint8Array(width * height);
		const queue = [startY * width + startX];
		let head = 0;
		const tolerance = 18;
		while (head < queue.length) {
			const index = queue[head++];
			if (visited[index]) continue;
			visited[index] = 1;
			const offset = index * 4;
			if (Math.max(
				Math.abs(data[offset] - target[0]),
				Math.abs(data[offset + 1] - target[1]),
				Math.abs(data[offset + 2] - target[2]),
				Math.abs(data[offset + 3] - target[3]),
			) > tolerance) {
				continue;
			}
			data[offset] = replacement[0];
			data[offset + 1] = replacement[1];
			data[offset + 2] = replacement[2];
			data[offset + 3] = replacement[3];
			const x = index % width;
			if (x > 0) queue.push(index - 1);
			if (x < width - 1) queue.push(index + 1);
			if (index >= width) queue.push(index - width);
			if (index < width * (height - 1)) queue.push(index + width);
		}
		this.ctx.putImageData(imageData, 0, 0);
	}

	pickColor(point) {
		const x = Math.round(point.x);
		const y = Math.round(point.y);
		const data = this.ctx.getImageData(x, y, 1, 1).data;
		this.setBrushColor(rgbaToHex(data[0], data[1], data[2]));
		this.setTool("brush");
	}

	clearCanvas() {
		this.fillBackground();
		this.recordSnapshot();
	}

	downloadPng() {
		this.syncState();
		const link = document.createElement("a");
		link.href = this.canvas.toDataURL("image/png");
		link.download = `GJJ_doodle_${this.canvas.width}x${this.canvas.height}.png`;
		link.click();
	}

	resetHistory() {
		this.history = [this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)];
		this.historyIndex = 0;
		this.updateHistoryButtons();
	}

	recordSnapshot() {
		const snapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
		this.history = this.history.slice(0, this.historyIndex + 1);
		this.history.push(snapshot);
		if (this.history.length > MAX_HISTORY) this.history.shift();
		this.historyIndex = this.history.length - 1;
		this.updateHistoryButtons();
		this.activeImageKind = "doodle";
		this.doodleImageData = this.canvas.toDataURL("image/png");
		this.syncState();
	}

	restoreHistory(delta) {
		const next = this.historyIndex + delta;
		if (next < 0 || next >= this.history.length) return;
		this.historyIndex = next;
		const snapshot = this.history[this.historyIndex];
		if (snapshot.width !== this.canvas.width || snapshot.height !== this.canvas.height) {
			this.canvas.width = snapshot.width;
			this.canvas.height = snapshot.height;
		}
		this.ctx.putImageData(snapshot, 0, 0);
		this.updateHistoryButtons();
		if (this.historyIndex === 0 || !this.generatedImageData) {
			this.doodleImageData = this.canvas.toDataURL("image/png");
		}
		this.syncState();
	}

	updateHistoryButtons() {
		if (!this.buttons) return;
		this.buttons.undo.disabled = this.historyIndex <= 0;
		this.buttons.redo.disabled = this.historyIndex >= this.history.length - 1;
	}

	syncState() {
		if (this.loadingImage && this.pendingStateText) {
			setWidgetValue(this.node, DATA_WIDGET, this.pendingStateText, false);
			this.node.__gjjDoodleStateText = this.pendingStateText;
			if (this.node.properties) delete this.node.properties[PROP_STATE];
			this.node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
			this.renderStatus();
			return;
		}
		const width = this.canvas.width || DEFAULT_WIDTH;
		const height = this.canvas.height || DEFAULT_HEIGHT;
		const canvasImage = this.canvas.toDataURL("image/png");
		const fallbackDoodleImage = this.activeImageKind === "upstream" ? "" : canvasImage;
		const payload = {
			version: 1,
			width,
			height,
			backgroundColor: this.currentBackgroundColor(),
			brushColor: this.currentBrushColor(),
			brushSize: this.currentBrushSize(),
			settingsOpen: this.settingsPanel?.classList?.contains("open") || false,
			positivePrompt: String(this.promptInput?.value || ""),
			ckptName: String(this.ckptSelect?.value || ""),
			controlnetName: String(this.controlnetSelect?.value || ""),
			seed: String(this.seedInput?.value || ""),
			generationMode: this.node.__gjjDoodleQueueGeneration ? "generate" : String(getWidgetValue(this.node, MODE_WIDGET, "doodle")),
			outputMode: this.outputMode,
			displayImage: this.activeImageKind === "generated" && this.generatedImageData ? "generated" : "doodle",
			doodleImage: this.doodleImageData || fallbackDoodleImage,
			generatedImage: this.generatedImageData || "",
		};
		const text = JSON.stringify(payload);
		setWidgetValue(this.node, DATA_WIDGET, text, false);
		setWidgetValue(this.node, WIDTH_WIDGET, width, false);
		setWidgetValue(this.node, HEIGHT_WIDGET, height, false);
		setWidgetValue(this.node, BG_WIDGET, payload.backgroundColor, false);
		setWidgetValue(this.node, BRUSH_WIDGET, payload.brushColor, false);
		setWidgetValue(this.node, SIZE_WIDGET, payload.brushSize, false);
		setWidgetValue(this.node, PROMPT_WIDGET, payload.positivePrompt, false);
		setWidgetValue(this.node, CKPT_WIDGET, payload.ckptName, false);
		setWidgetValue(this.node, CONTROLNET_WIDGET, payload.controlnetName, false);
		setWidgetValue(this.node, SEED_WIDGET, payload.seed, false);
		setWidgetValue(this.node, OUTPUT_MODE_WIDGET, payload.outputMode, false);
		this.node.properties = this.node.properties || {};
		this.node.properties[PROP_SETTINGS_OPEN] = payload.settingsOpen;
		delete this.node.properties[PROP_STATE];
		this.node.__gjjDoodleStateText = text;
		this.node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
		this.renderStatus();
	}

	renderStatus(message = "") {
		if (!this.status) return;
		const toolNames = {
			brush: "自由线",
			eraser: "橡皮",
			line: "直线",
			rect: "矩形",
			ellipse: "椭圆",
			fill: "填充",
			picker: "取色",
		};
		const output = this.outputMode === "generated" ? "输出生成图" : "输出涂鸦";
		const base = `${this.canvas.width || DEFAULT_WIDTH}×${this.canvas.height || DEFAULT_HEIGHT} · ${toolNames[this.tool] || "画笔"} · ${this.currentBrushSize()}px · ${this.currentBrushColor()} · ${output}`;
		this.status.textContent = message ? `${message} · ${base}` : base;
	}

	measureChromeHeight() {
		const domY = Number(this.node.__gjjDoodleDomWidget?.y || 0);
		const toolbar = Math.ceil(this.toolbar?.offsetHeight || 32);
		const controls = Math.ceil(this.controls?.offsetHeight || 32);
		const prompt = Math.ceil(this.promptPanel?.offsetHeight || 0);
		const settings = Math.ceil(this.settingsPanel?.offsetHeight || 0);
		const status = Math.ceil(this.status?.offsetHeight || 16);
		return Math.max(128, domY + toolbar + controls + prompt + settings + status + 42);
	}

	layout(updateNode = true) {
		const nodeWidth = Math.max(MIN_NODE_WIDTH, Math.round(Number(this.node.size?.[0] || DEFAULT_NODE_WIDTH)));
		const maxWidth = Math.max(260, nodeWidth - 24);
		const ratio = (this.canvas.height || DEFAULT_HEIGHT) / Math.max(1, this.canvas.width || DEFAULT_WIDTH);
		const chromeHeight = this.measureChromeHeight();
		const nodeHeight = Math.max(320, Number(this.node.size?.[1] || 0));
		const maxHeight = Math.max(180, nodeHeight - chromeHeight);
		const widthByHeight = Math.round(maxHeight / Math.max(0.0001, ratio));
		this.displayWidth = Math.max(180, Math.min(maxWidth, widthByHeight));
		this.displayHeight = Math.max(140, Math.round(this.displayWidth * ratio));
		this.canvas.style.width = `${this.displayWidth}px`;
		this.canvas.style.height = `${this.displayHeight}px`;
		this.canvasWrap.style.height = `${this.displayHeight}px`;
		if (updateNode) this.scheduleSize();
		this.renderStatus();
	}

	scheduleSize() {
		clearTimeout(this.sizeTimer);
		this.sizeTimer = setTimeout(() => {
			const minHeight = Math.ceil(this.measureChromeHeight() + 180);
			const desiredHeight = Math.max(minHeight, Math.ceil(this.measureChromeHeight() + this.displayHeight + 8));
			const currentHeight = Math.round(Number(this.node.size?.[1] || 0));
			const currentWidth = Math.max(MIN_NODE_WIDTH, Math.round(Number(this.node.size?.[0] || DEFAULT_NODE_WIDTH)));
			this.node.min_width = MIN_NODE_WIDTH;
			this.node.minWidth = MIN_NODE_WIDTH;
			if (currentHeight >= desiredHeight && currentWidth >= MIN_NODE_WIDTH) return;
			this.node.__gjjDoodleSizing = true;
			this.node.setSize?.([Math.max(currentWidth, MIN_NODE_WIDTH), Math.max(currentHeight, desiredHeight)]);
			this.node.__gjjDoodleSizing = false;
		}, 0);
	}
}

function createContainer(node) {
	ensureStyles();
	const container = document.createElement("div");
	container.className = "gjj-doodle";
	const domWidget = node.addDOMWidget?.(DOM_WIDGET, "GJJ 涂鸦画板", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (domWidget) {
		domWidget.computeSize = (width) => [
			Math.max(MIN_NODE_WIDTH, Math.round(Number(width || node.size?.[0] || DEFAULT_NODE_WIDTH))),
			Math.max(220, Math.ceil(container.scrollHeight || 460)),
		];
		domWidget.getHeight = () => Math.max(220, Math.ceil(container.scrollHeight || 460));
	}
	node.__gjjDoodleDomWidget = domWidget;
	node.__gjjDoodleContainer = container;
	return container;
}

function patchWidgetCallbacks(node) {
	if (node.__gjjDoodleWidgetCallbacksPatched) return;
	node.__gjjDoodleWidgetCallbacksPatched = true;
	for (const name of [WIDTH_WIDGET, HEIGHT_WIDGET]) {
		const w = widget(node, name);
		if (!w) continue;
		const original = w.callback;
		w.callback = function (...args) {
			const result = original?.apply(this, args);
			node.__gjjDoodleEditor?.resizeFromWidgets(true);
			return result;
		};
	}
}

function ensureEditor(node) {
	if (!node || node.__gjjDoodleEditor) return;
	for (const name of HIDDEN_WIDGETS) collapseWidget(widget(node, name));
	if (node.properties?.[PROP_STATE] && !getWidgetValue(node, DATA_WIDGET, "")) {
		setWidgetValue(node, DATA_WIDGET, node.properties[PROP_STATE], false);
	}
	if (node.properties) delete node.properties[PROP_STATE];
	const container = node.__gjjDoodleContainer || createContainer(node);
	node.__gjjDoodleEditor = new DoodleEditor(node, container);
	patchWidgetCallbacks(node);
	const savedSize = node.properties?.[PROP_NODE_SIZE];
	if (Array.isArray(savedSize)) {
		node.setSize?.([
			Math.max(MIN_NODE_WIDTH, Number(savedSize[0]) || DEFAULT_NODE_WIDTH),
			Math.max(360, Number(savedSize[1]) || 460),
		]);
	} else {
		node.setSize?.([
			Math.max(MIN_NODE_WIDTH, Number(node.size?.[0] || DEFAULT_NODE_WIDTH)),
			Math.max(420, Number(node.size?.[1] || 0)),
		]);
	}
	requestAnimationFrame(() => node.__gjjDoodleEditor?.layout());
}

function scheduleEnsure(node, delay = 0) {
	clearTimeout(node.__gjjDoodleTimer);
	node.__gjjDoodleTimer = setTimeout(() => ensureEditor(node), delay);
}

function syncAllDoodles(options = {}) {
	const nodes = (app.graph?._nodes || []).filter((node) => node?.comfyClass === TARGET || node?.type === TARGET);
	const prepareGenerate = Boolean(options?.prepareGenerate);
	const explicitNodes = prepareGenerate ? nodes.filter((node) => node.__gjjDoodleExplicitGenerate) : [];
	for (const node of nodes) {
		if (node?.comfyClass === TARGET || node?.type === TARGET) {
			ensureEditor(node);
			const editor = node.__gjjDoodleEditor;
			const shouldGenerate = explicitNodes.length
				? explicitNodes.includes(node)
				: editor?.shouldGenerateOnQueue?.();
			if (prepareGenerate && shouldGenerate) {
				editor?.prepareQueuedGeneration();
				editor?.markQueuedGeneration(explicitNodes.includes(node) ? "生成中" : "已选择生成，提交队列");
			} else {
				editor?.prepareQueuedDoodle?.();
			}
		}
	}
}

app.registerExtension({
	name: "Comfy.GJJ.DoodleCanvas",
	beforeQueuePrompt() {
		syncAllDoodles({ prepareGenerate: true });
	},
	beforeQueued() {
		syncAllDoodles({ prepareGenerate: true });
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleEnsure(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			const props = serializedNode?.properties || this.properties || {};
			this.properties = this.properties || {};
			if (props[PROP_STATE]) {
				this.__gjjDoodleStateText = props[PROP_STATE];
				setWidgetValue(this, DATA_WIDGET, props[PROP_STATE], false);
			}
			delete this.properties[PROP_STATE];
			if (Array.isArray(props[PROP_NODE_SIZE])) this.properties[PROP_NODE_SIZE] = props[PROP_NODE_SIZE];
			if (props[PROP_SETTINGS_OPEN] !== undefined) this.properties[PROP_SETTINGS_OPEN] = Boolean(props[PROP_SETTINGS_OPEN]);
			scheduleEnsure(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			this.__gjjDoodleEditor?.syncState();
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				const stateText = getWidgetValue(this, DATA_WIDGET, "");
				const compactState = compactStateForStorage(stateText);
				const queueMode = this.__gjjDoodleQueueGeneration || this.__gjjDoodleExplicitGenerate ? "generate" : "doodle";
				serializedNode.properties = serializedNode.properties || {};
				delete serializedNode.properties[PROP_STATE];
				setSerializedWidgetValue(this, serializedNode, DATA_WIDGET, compactState);
				setSerializedWidgetValue(this, serializedNode, MODE_WIDGET, queueMode);
				setSerializedWidgetValue(this, serializedNode, OUTPUT_MODE_WIDGET, getWidgetValue(this, OUTPUT_MODE_WIDGET, "doodle"));
				serializedNode.properties[PROP_NODE_SIZE] = [
					Math.round(Number(this.size?.[0] || DEFAULT_NODE_WIDTH)),
					Math.round(Number(this.size?.[1] || 460)),
				];
				serializedNode.properties[PROP_SETTINGS_OPEN] = Boolean(this.properties?.[PROP_SETTINGS_OPEN]);
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjDoodleSizing) {
				this.properties = this.properties || {};
				this.properties[PROP_NODE_SIZE] = [
					Math.round(Number(this.size?.[0] || DEFAULT_NODE_WIDTH)),
					Math.round(Number(this.size?.[1] || 460)),
				];
			}
			this.__gjjDoodleEditor?.layout(false);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalOnExecuted?.apply(this, [message, ...args]);
			const editor = this.__gjjDoodleEditor;
			const generated = firstMessageValue(
				message?.generated_image,
				message?.ui?.generated_image,
				message?.output?.generated_image,
				message?.result?.generated_image,
			);
			const selected = firstMessageValue(
				message?.selected_image,
				message?.ui?.selected_image,
				message?.output?.selected_image,
				message?.result?.selected_image,
			);
			const doodle = firstMessageValue(
				message?.doodle_image,
				message?.ui?.doodle_image,
				message?.output?.doodle_image,
				message?.result?.doodle_image,
			);
			if (generated && (!editor?.hasUpstreamImage?.() || editor?.generating)) {
				editor?.applyGeneratedImage(generated);
			} else if (editor?.hasUpstreamImage?.() && (selected || doodle)) {
				editor?.applyUpstreamImage(selected || doodle);
				if (editor?.generating) editor.finishGenerating("已使用上游图像");
			} else if (generated) {
				editor?.applyGeneratedImage(generated);
			} else if (this.__gjjDoodleEditor?.generating) {
				this.__gjjDoodleEditor?.finishGenerating("执行完成");
			}
			this.__gjjDoodleEditor?.resetGenerationMode();
			delete this.__gjjDoodleQueueGeneration;
			delete this.__gjjDoodleExplicitGenerate;
			return result;
		};

	},
	nodeCreated(node) {
		if (node?.comfyClass === TARGET || node?.type === TARGET) scheduleEnsure(node, 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET || node?.type === TARGET) scheduleEnsure(node, 0);
		}
	},
});

if (typeof window !== "undefined") {
	window.addEventListener("beforeunload", syncAllDoodles);
}

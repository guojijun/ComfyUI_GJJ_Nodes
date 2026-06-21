import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { queueOnlyCurrentNode } from "./gjj_utils.js";
import { translatePromptText } from "./gjj_common_prompt_translation.js";

const TARGET = "GJJ_QwenInstantXInpaintCanvas";
const NODE_DISPLAY_NAME = "GJJ · 千问2512局部重绘画布";
const DOM_WIDGET = "gjj_qwen_instantx_inpaint_canvas_dom";
const PROP_NODE_SIZE = "gjj_qwen_instantx_inpaint_canvas_node_size";
const PROP_SETTINGS_OPEN = "gjj_qwen_instantx_inpaint_canvas_settings_open";
const PROP_STATE = "gjj_qwen_instantx_inpaint_canvas_state";
const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;
const DEFAULT_NODE_WIDTH = 620;
const MIN_NODE_WIDTH = 500;
const MAX_HISTORY = 30;

const FIELD = Object.freeze({
	data: "inpaint_data",
	positive: "positive_prompt",
	negative: "negative_prompt",
	unet: "unet_name",
	clip: "clip_name",
	controlnet: "controlnet_name",
	vae: "vae_name",
	lora: "lora_name",
	seed: "seed",
	steps: "steps",
	cfg: "cfg",
	sampler: "sampler_name",
	scheduler: "scheduler",
	denoise: "denoise",
	largestSize: "largest_size",
	maskExpand: "mask_expand",
	maskBlurRadius: "mask_blur_radius",
	maskBlurSigma: "mask_blur_sigma",
	controlStrength: "control_strength",
	startPercent: "start_percent",
	endPercent: "end_percent",
	loraStrength: "lora_strength",
	shift: "shift",
});

const HIDDEN_WIDGETS = new Set(Object.values(FIELD));

const TOOL_ICONS = Object.freeze({
	upload: "📂",
	brush: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M40.044693 966.793296h572.067039v57.206704H40.044693z" fill="#1afa29"></path><path d="M566.346369 966.793296H986.815642v57.206704H566.346369zM655.01676 120.134078l240.268156 240.268157-526.301676 526.301676-240.268156-240.268157zM752.268156 25.743017l240.268157 240.268156L921.027933 337.519553l-240.268156-240.268156zM105.832402 672.178771l240.268157 240.268156L8.581006 1006.837989l97.251396-334.659218z" fill="#1afa29"></path><path d="M843.798883 22.882682l148.73743 148.73743c25.743017 25.743017 22.882682 65.787709-2.860335 91.530726s-68.648045 28.603352-91.530727 2.860335l-148.73743-148.73743c-25.743017-22.882682-25.743017-65.787709 2.860335-91.530726 25.743017-25.743017 65.787709-28.603352 91.530727-2.860335z" fill="#1afa29"></path></svg>`,
	eraser: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M597.333333 810.538667h298.666667v85.333333h-384l-170.581333 0.085333-276.778667-276.821333a42.666667 42.666667 0 0 1 0-60.330667L517.12 106.282667a42.666667 42.666667 0 0 1 60.330667 0l331.904 331.861333a42.666667 42.666667 0 0 1 0 60.330667L597.333333 810.538667z m70.698667-191.402667l150.826667-150.826667-271.530667-271.530666-150.826667 150.826666 271.530667 271.530667z" fill="#f4ea2a"></path></svg>`,
	undo: "↩️",
	redo: "↪️",
	clear: "🧽",
	fill: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M18 12h23l11 13-24 24L8 29z" fill="#ffbe55" stroke="#ffe2a6" stroke-width="4" stroke-linejoin="round"></path><path d="M20 12 44 36" stroke="#3a2d1d" stroke-width="5" stroke-linecap="round"></path><path d="M44 41c4 5 7 9 7 12a7 7 0 0 1-14 0c0-3 3-7 7-12z" fill="#3aa0ff"></path></svg>`,
	mask: "👁️",
	settings: "⚙️",
	generate: "🚀",
	translate: "🌐",
	layerAdd: "➕",
	layerUp: "🔼",
	layerDown: "🔽",
	layerDelete: "🗑️",
});

const LAYER_COLORS = Object.freeze(["#ff6b6b", "#ffad4d", "#f6d95f", "#65d98b", "#66c2ff", "#c58bff", "#c28a5c", "#e8eef2"]);
const LAYER_NUMBER_EMOJIS = Object.freeze(["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]);

const NUMERIC_FIELDS = Object.freeze([
	FIELD.seed,
	FIELD.steps,
	FIELD.cfg,
	FIELD.denoise,
	FIELD.largestSize,
	FIELD.maskExpand,
	FIELD.maskBlurRadius,
	FIELD.maskBlurSigma,
	FIELD.controlStrength,
	FIELD.startPercent,
	FIELD.endPercent,
	FIELD.loraStrength,
	FIELD.shift,
]);

const SELECT_FIELDS = Object.freeze([
	FIELD.unet,
	FIELD.clip,
	FIELD.controlnet,
	FIELD.vae,
	FIELD.lora,
	FIELD.sampler,
	FIELD.scheduler,
]);

function setButtonContent(button, content) {
	if (!button) return;
	const text = String(content ?? "");
	if (text.trim().startsWith("<svg")) button.innerHTML = text;
	else button.textContent = text;
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
	if (!w || w.__gjjQwenInpaintCollapsed) return;
	w.__gjjQwenInpaintCollapsed = true;
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
	delete compact.generated_image;
	return JSON.stringify(compact);
}

function firstMessageValue(...candidates) {
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			const value = candidate.find((item) => item !== undefined && item !== null && String(item).trim() !== "");
			if (value !== undefined && value !== null) return value;
			continue;
		}
		if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") return candidate;
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

function coerceBrushSize(value, fallback = 48) {
	const number = Math.round(Number(value));
	return Number.isFinite(number) ? clamp(number, 1, 512) : fallback;
}

function normalizeModelKey(value) {
	let text = String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
	text = text.replace(/[-.\s]+/g, "_");
	while (text.includes("__")) text = text.replace(/__/g, "_");
	return text;
}

function isQwenOrFireRedUnet(value) {
	const key = normalizeModelKey(value);
	return key.includes("qwen") || key.includes("firered") || key.includes("fire_red");
}

function asDataUrl(value) {
	const text = String(value || "").trim();
	if (!text) return "";
	return text.startsWith("data:") ? text : `data:image/png;base64,${text}`;
}

function canvasToSourceDataUrl(canvas) {
	try {
		return canvas.toDataURL("image/jpeg", 0.94);
	} catch (_) {
		return canvas.toDataURL("image/png");
	}
}

function canvasToPngDataUrl(canvas) {
	return canvas.toDataURL("image/png");
}

function createCanvas(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
	const canvas = document.createElement("canvas");
	canvas.width = width || DEFAULT_WIDTH;
	canvas.height = height || DEFAULT_HEIGHT;
	return canvas;
}

function copyCanvas(source) {
	const canvas = createCanvas(source?.width || DEFAULT_WIDTH, source?.height || DEFAULT_HEIGHT);
	if (source?.width && source?.height) {
		canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
	}
	return canvas;
}

function canvasHasVisiblePixels(canvas) {
	if (!canvas?.width || !canvas?.height) return false;
	try {
		const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
		for (let index = 0; index < data.length; index += 4) {
			if (Math.max(data[index], data[index + 1], data[index + 2], data[index + 3]) > 0) return true;
		}
	} catch (_) {
		return true;
	}
	return false;
}

function summarizePromptForLayer(value) {
	const text = String(value || "")
		.replace(/\s+/g, " ")
		.replace(/[，。；;|]+/g, ",")
		.trim();
	if (!text) return "";
	const first = text.split(",").map((item) => item.trim()).find(Boolean) || text;
	return first.length > 22 ? `${first.slice(0, 22)}...` : first;
}

function layerNumberEmoji(index) {
	const number = Math.max(1, Math.floor(Number(index) || 0) + 1);
	if (LAYER_NUMBER_EMOJIS[number - 1]) return LAYER_NUMBER_EMOJIS[number - 1];
	return String(number).split("").map((digit) => `${digit}\uFE0F\u20E3`).join("");
}

function imageElementToCacheDataUrl(image) {
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth || image.width || DEFAULT_WIDTH;
	canvas.height = image.naturalHeight || image.height || DEFAULT_HEIGHT;
	const ctx = canvas.getContext("2d");
	ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
	return canvasToSourceDataUrl(canvas);
}

function hasLinkedInput(node, label, typePart) {
	for (const input of node?.inputs || []) {
		const name = String(input?.name || input?.localized_name || input?.label || input?.display_name || "").toLowerCase();
		const type = String(input?.type || "").toLowerCase();
		const matches = name === label || type.includes(typePart);
		if (matches && (input?.link !== null && input?.link !== undefined || Array.isArray(input?.links) && input.links.length > 0)) return true;
	}
	return false;
}

function protectDomEvents(element) {
	if (!element) return;
	for (const eventName of ["pointerdown", "mousedown", "mousemove", "mouseup", "wheel", "dblclick", "contextmenu"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

function positionQwenModelPopup(panel, list, anchorEl) {
	const rect = anchorEl?.getBoundingClientRect?.();
	const viewportWidth = Math.max(320, window.innerWidth || 320);
	const viewportHeight = Math.max(240, window.innerHeight || 240);
	const horizontalPadding = 12;
	const verticalPadding = 12;
	const targetWidth = Math.min(
		Math.max(Math.ceil(rect?.width || 420), 420),
		Math.max(320, viewportWidth - horizontalPadding * 2),
		680,
	);
	const spaceBelow = Math.max(120, viewportHeight - Math.ceil(rect?.bottom || 0) - verticalPadding - 6);
	const spaceAbove = Math.max(120, Math.floor(rect?.top || 0) - verticalPadding - 6);
	const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
	const panelMaxHeight = Math.max(180, Math.min(420, openAbove ? spaceAbove : spaceBelow));
	const listMaxHeight = Math.max(96, panelMaxHeight - 52);
	const rawLeft = Math.floor(rect?.left || horizontalPadding);
	const left = Math.max(horizontalPadding, Math.min(rawLeft, viewportWidth - targetWidth - horizontalPadding));
	panel.style.width = `${targetWidth}px`;
	panel.style.maxHeight = `${panelMaxHeight}px`;
	list.style.maxHeight = `${listMaxHeight}px`;
	panel.style.left = `${left}px`;
	if (openAbove) {
		panel.style.top = "auto";
		panel.style.bottom = `${Math.max(verticalPadding, viewportHeight - Math.floor(rect?.top || 0) + 6)}px`;
	} else {
		panel.style.bottom = "auto";
		panel.style.top = `${Math.max(verticalPadding, Math.ceil(rect?.bottom || verticalPadding) + 6)}px`;
	}
}

function ensureQwenModelPopup() {
	if (globalThis.__gjjQwenModelPopup) return globalThis.__gjjQwenModelPopup;
	const panel = document.createElement("div");
	panel.className = "gjj-qwen-model-popup";
	const search = document.createElement("input");
	search.type = "text";
	search.className = "gjj-qwen-model-popup-search";
	const list = document.createElement("div");
	list.className = "gjj-qwen-model-popup-list";
	panel.append(search, list);
	document.body.appendChild(panel);
	protectDomEvents(panel);
	protectDomEvents(search);
	protectDomEvents(list);
	const outsideHandler = (event) => {
		const state = popup.state;
		if (!state) return;
		if (panel.contains(event.target) || state.anchorEl?.contains?.(event.target)) return;
		popup.close();
	};
	const popup = {
		panel,
		search,
		list,
		state: null,
		close() {
			this.state?.anchorEl?.classList?.remove("open");
			panel.classList.remove("open");
			search.value = "";
			search.placeholder = "搜索模型";
			list.replaceChildren();
			this.state = null;
			document.removeEventListener("pointerdown", outsideHandler, true);
		},
		isOpenFor(anchorEl) {
			return Boolean(this.state && this.state.anchorEl === anchorEl && panel.classList.contains("open"));
		},
		reposition() {
			if (!this.state?.anchorEl) return;
			positionQwenModelPopup(panel, list, this.state.anchorEl);
		},
		render() {
			if (!this.state) return;
			const selectedValue = String(this.state.getSelectedValue?.() || "");
			const options = this.state.getOptions(search.value) || [];
			list.replaceChildren();
			if (!options.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-qwen-model-popup-empty";
				empty.textContent = "没有匹配的模型";
				list.appendChild(empty);
				this.reposition();
				return;
			}
			for (const option of options) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-qwen-model-popup-item";
				const isSelected = String(option.value || "") === selectedValue;
				if (isSelected) item.classList.add("selected");
				item.textContent = `${isSelected ? "✔ " : ""}${option.label}`;
				item.title = option.value;
				item.addEventListener("click", () => this.state?.onSelect?.(String(option.value || "")));
				list.appendChild(item);
			}
			this.reposition();
		},
		open(state) {
			this.close();
			this.state = state;
			search.placeholder = String(state.placeholder || "搜索模型");
			state.anchorEl?.classList?.add("open");
			panel.classList.add("open");
			this.render();
			setTimeout(() => {
				search.focus();
				search.select();
			}, 0);
			document.addEventListener("pointerdown", outsideHandler, true);
		},
	};
	search.addEventListener("input", () => popup.render());
	search.addEventListener("keydown", (event) => {
		if (event.key === "Escape") popup.close();
	});
	window.addEventListener("resize", () => popup.reposition());
	globalThis.__gjjQwenModelPopup = popup;
	return popup;
}

function ensureStyles() {
	if (document.getElementById("gjj-qwen-inpaint-canvas-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-qwen-inpaint-canvas-style";
	style.textContent = `
		.gjj-qwen-inpaint { width:100%; box-sizing:border-box; display:flex; flex-direction:column; gap:6px; color:#dbe7e8; font:12px/1.35 Arial, sans-serif; }
		.gjj-qwen-inpaint * { box-sizing:border-box; }
		.gjj-qwen-inpaint-toolbar, .gjj-qwen-inpaint-controls { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
		.gjj-qwen-inpaint button { flex:0 0 32px; width:32px; min-width:32px; height:30px; padding:0; border:1px solid #3a4d55; border-radius:7px; background:#202b31; color:#e7f3f3; font-size:22px; font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",Arial,sans-serif; font-weight:700; cursor:pointer; line-height:1; display:inline-flex; align-items:center; justify-content:center; overflow:hidden; }
		.gjj-qwen-inpaint button svg { width:25px; height:25px; display:block; pointer-events:none; }
		.gjj-qwen-inpaint button:hover { background:#2d3a42; border-color:#6aa6b8; }
		.gjj-qwen-inpaint button.on { border-color:#54c78b; background:#20382f; color:#dff8ea; }
		.gjj-qwen-inpaint button:disabled { opacity:.58; cursor:default; }
		.gjj-qwen-inpaint-range { width:130px; height:26px; accent-color:#54c78b; }
		.gjj-qwen-inpaint-size { min-width:44px; color:#b9c7ca; text-align:right; font-size:11px; }
		.gjj-qwen-inpaint-layer-shortcuts { display:flex; align-items:center; gap:2px; flex:0 1 auto; max-width:220px; overflow:hidden; flex-wrap:wrap; }
		.gjj-qwen-inpaint .gjj-qwen-inpaint-layer-shortcut { flex:0 0 26px; width:26px; min-width:26px; height:26px; border-radius:6px; font-size:16px; background:#151f25; border-color:#354852; opacity:.92; }
		.gjj-qwen-inpaint .gjj-qwen-inpaint-layer-shortcut.active { background:#21332d; box-shadow:0 0 0 1px rgba(84,199,139,.55) inset; }
		.gjj-qwen-inpaint .gjj-qwen-inpaint-layer-shortcut.hidden { opacity:.34; filter:grayscale(1); background:#12181c; border-color:#27343a; }
		.gjj-qwen-inpaint-prompt { display:grid; grid-template-columns:minmax(78px, 92px) minmax(0, 1fr) 32px; gap:6px; align-items:stretch; }
		.gjj-qwen-inpaint-label { color:#b8c7ca; font-size:12px; display:flex; align-items:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-qwen-inpaint textarea { width:100%; min-width:0; height:46px; min-height:46px; max-height:120px; resize:vertical; border:1px solid #354852; border-radius:6px; background:#151f25; color:#e5edf2; padding:6px 8px; font:12px/1.35 Arial, sans-serif; outline:none; }
		.gjj-qwen-inpaint textarea:focus { border-color:#54c78b; }
		.gjj-qwen-inpaint-settings { display:none; grid-template-columns:minmax(82px, 108px) minmax(0, 1fr); gap:6px 8px; align-items:center; padding:8px; border:1px solid #33464e; border-radius:8px; background:#101820; }
		.gjj-qwen-inpaint-settings.open { display:grid; }
		.gjj-qwen-inpaint-settings input, .gjj-qwen-inpaint-settings select { width:100%; min-width:0; height:28px; border:1px solid #354852; border-radius:6px; background:#242b31; color:#e5edf2; padding:0 8px; font:12px Arial, sans-serif; outline:none; }
		.gjj-qwen-inpaint-settings input:focus, .gjj-qwen-inpaint-settings select:focus { border-color:#54c78b; }
		.gjj-qwen-inpaint-select-wrap { position:relative; min-width:0; }
		.gjj-qwen-inpaint .gjj-qwen-inpaint-model-picker { flex:1 1 auto; width:100%; min-width:0; height:28px; border:1px solid #354852; border-radius:6px; background:#242b31; color:#e5edf2; padding:0 28px 0 8px; font:12px/28px Arial, sans-serif; font-weight:400; text-align:left; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; position:relative; display:block; }
		.gjj-qwen-inpaint-model-picker::after { content:"⌄"; position:absolute; right:8px; top:3px; color:#dcecee; font-size:16px; line-height:20px; }
		.gjj-qwen-inpaint .gjj-qwen-inpaint-model-picker:hover, .gjj-qwen-inpaint .gjj-qwen-inpaint-model-picker.open { border-color:#54c78b; background:#1d2b31; }
		.gjj-qwen-model-popup { display:none; flex-direction:column; gap:6px; position:fixed; z-index:99999; width:520px; max-width:calc(100vw - 24px); max-height:420px; padding:6px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-sizing:border-box; box-shadow:0 8px 24px rgba(0,0,0,0.35); }
		.gjj-qwen-model-popup.open { display:flex; }
		.gjj-qwen-model-popup-search { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #d7eff5; border-radius:6px; padding:4px 6px; box-sizing:border-box; }
		.gjj-qwen-model-popup-list { display:flex; flex-direction:column; gap:4px; max-height:350px; overflow:auto; }
		.gjj-qwen-model-popup-item { width:100%; min-height:28px; background:#182127; color:#dce7e2; border:1px solid #33454c; border-radius:6px; padding:5px 8px; text-align:left; cursor:pointer; box-sizing:border-box; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:1.3; }
		.gjj-qwen-model-popup-item:hover { background:#223039; }
		.gjj-qwen-model-popup-item.selected { background:#18352f; border-color:#2f7d67; color:#e8fff6; }
		.gjj-qwen-model-popup-empty { color:#8da2ad; font-size:11px; padding:4px 2px; }
		.gjj-qwen-inpaint-pair { display:grid; grid-template-columns:1fr 1fr; gap:6px; min-width:0; }
		.gjj-qwen-inpaint-layers { display:grid; grid-template-columns:minmax(0, 1fr) repeat(4, 32px); gap:4px; align-items:center; }
		.gjj-qwen-inpaint-layer-select { width:100%; min-width:0; height:30px; border:1px solid #354852; border-radius:7px; background:#151f25; color:#dcecee; padding:0 8px; font:12px Arial, sans-serif; outline:none; }
		.gjj-qwen-inpaint-layer-select:focus { border-color:#54c78b; }
		.gjj-qwen-inpaint-canvas-wrap { width:100%; position:relative; overflow:hidden; border:1px solid #33464e; border-radius:8px; background:#071014; display:flex; align-items:center; justify-content:center; touch-action:none; }
		.gjj-qwen-inpaint-canvas { display:block; max-width:100%; image-rendering:auto; cursor:crosshair; touch-action:none; }
		.gjj-qwen-inpaint-cursor { position:absolute; z-index:4; left:0; top:0; width:0; height:0; display:none; pointer-events:none; border:2px solid #1afa29; border-radius:50%; background:rgba(26,250,41,0.06); box-shadow:0 0 0 1px rgba(0,0,0,0.7),0 0 10px rgba(26,250,41,0.28); transform:translate(-50%,-50%); }
		.gjj-qwen-inpaint-cursor.eraser { border-color:#f4ea2a; background:rgba(244,234,42,0.08); box-shadow:0 0 0 1px rgba(0,0,0,0.74),0 0 10px rgba(244,234,42,0.24); }
		.gjj-qwen-inpaint-status { color:#9eb1b6; min-height:16px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-qwen-inpaint-drop { outline:1px dashed #54c78b; outline-offset:-6px; }
	`;
	document.head.appendChild(style);
}

class QwenInpaintEditor {
	constructor(node, container) {
		this.node = node;
		this.container = container;
		this.tool = "brush";
		this.brushSize = 48;
		this.showMask = true;
		this.generating = false;
		this.translating = false;
		this.history = [];
		this.historyIndex = -1;
		this.displayWidth = 560;
		this.displayHeight = 560;
		this.baseImageData = "";
		this.layers = [];
		this.activeLayerId = "";
		this.layerSerial = 0;
		this.layerImageData = "";
		this.generatedImageData = "";
		this.previewImage = null;
		this.cacheSignature = "";
		this.imageSignature = "";
		this.maskSignature = "";
		this.generatedSignature = "";
		this.drag = null;
		this.keyboardActive = false;
		this.cursorPoint = null;
		this.buildDom();
		this.loadInitialState();
		this.bindEvents();
		this.layout();
		this.renderStatus();
	}

	buildDom() {
		this.container.innerHTML = "";
		this.container.className = "gjj-qwen-inpaint";
		this.container.tabIndex = -1;

		this.fileInput = document.createElement("input");
		this.fileInput.type = "file";
		this.fileInput.accept = "image/*";
		this.fileInput.style.display = "none";

		this.toolbar = document.createElement("div");
		this.toolbar.className = "gjj-qwen-inpaint-toolbar";
		this.buttons = {
			upload: this.makeButton(TOOL_ICONS.upload, "导入图片", () => this.fileInput.click()),
			brush: this.makeButton(TOOL_ICONS.brush, "遮罩画笔：涂白处会被重绘", () => this.setTool("brush")),
			eraser: this.makeButton(TOOL_ICONS.eraser, "遮罩橡皮擦", () => this.setTool("eraser")),
			undo: this.makeButton(TOOL_ICONS.undo, "撤销遮罩", () => this.restoreHistory(-1)),
			redo: this.makeButton(TOOL_ICONS.redo, "重做遮罩", () => this.restoreHistory(1)),
			clear: this.makeButton(TOOL_ICONS.clear, "清理当前遮罩", () => this.clearMask()),
			fill: this.makeButton(TOOL_ICONS.fill, "油漆桶：点击画布填充封闭区域遮罩", () => this.setTool("fill")),
			mask: this.makeButton(TOOL_ICONS.mask, "显示/隐藏遮罩覆盖", () => this.toggleMask()),
			settings: this.makeButton(TOOL_ICONS.settings, "设置", () => this.toggleSettings()),
			generate: this.makeButton(TOOL_ICONS.generate, "用当前图像和遮罩只执行本节点生成", () => this.generateInPlace()),
		};
		this.layerShortcutBar = document.createElement("div");
		this.layerShortcutBar.className = "gjj-qwen-inpaint-layer-shortcuts";
		this.toolbar.append(
			this.buttons.upload,
			this.buttons.brush,
			this.buttons.eraser,
			this.buttons.undo,
			this.buttons.redo,
			this.buttons.clear,
			this.buttons.fill,
			this.buttons.mask,
			this.buttons.settings,
			this.buttons.generate,
		);

		this.controls = document.createElement("div");
		this.controls.className = "gjj-qwen-inpaint-controls";
		this.sizeRange = document.createElement("input");
		this.sizeRange.type = "range";
		this.sizeRange.min = "1";
		this.sizeRange.max = "512";
		this.sizeRange.step = "1";
		this.sizeRange.className = "gjj-qwen-inpaint-range";
		this.sizeRange.title = "遮罩笔刷大小";
		this.sizeText = document.createElement("span");
		this.sizeText.className = "gjj-qwen-inpaint-size";
		this.sizeText.textContent = "48px";
		this.controls.append(this.sizeRange, this.sizeText, this.layerShortcutBar);

		this.buildLayerPanel();
		this.buildPromptPanel();
		this.buildSettingsPanel();

		this.canvasWrap = document.createElement("div");
		this.canvasWrap.className = "gjj-qwen-inpaint-canvas-wrap";
		this.canvas = document.createElement("canvas");
		this.canvas.className = "gjj-qwen-inpaint-canvas";
		this.cursorPreview = document.createElement("div");
		this.cursorPreview.className = "gjj-qwen-inpaint-cursor";
		this.canvasWrap.append(this.canvas, this.cursorPreview);
		this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

		this.imageCanvas = document.createElement("canvas");
		this.imageCtx = this.imageCanvas.getContext("2d", { willReadFrequently: true });
		this.maskCanvas = document.createElement("canvas");
		this.maskCtx = this.maskCanvas.getContext("2d", { willReadFrequently: true });
		this.layerCanvas = document.createElement("canvas");
		this.layerCtx = this.layerCanvas.getContext("2d", { willReadFrequently: true });
		this.overlayCanvas = document.createElement("canvas");
		this.overlayCtx = this.overlayCanvas.getContext("2d", { willReadFrequently: true });

		this.status = document.createElement("div");
		this.status.className = "gjj-qwen-inpaint-status";
		this.container.append(this.fileInput, this.toolbar, this.controls, this.layerPanel, this.promptPanel, this.settingsPanel, this.canvasWrap, this.status);
		this.setTool("brush");
	}

	buildLayerPanel() {
		this.layerPanel = document.createElement("div");
		this.layerPanel.className = "gjj-qwen-inpaint-layers";
		this.layerSelect = document.createElement("select");
		this.layerSelect.className = "gjj-qwen-inpaint-layer-select";
		this.layerSelect.title = "选择当前透明图层";
		protectDomEvents(this.layerSelect);
		this.layerButtons = {
			add: this.makeButton(TOOL_ICONS.layerAdd, "新建透明图层", () => this.addLayer()),
			up: this.makeButton(TOOL_ICONS.layerUp, "当前图层上移", () => this.moveActiveLayer(1)),
			down: this.makeButton(TOOL_ICONS.layerDown, "当前图层下移", () => this.moveActiveLayer(-1)),
			delete: this.makeButton(TOOL_ICONS.layerDelete, "删除当前图层", () => this.deleteActiveLayer()),
		};
		this.layerPanel.append(
			this.layerSelect,
			this.layerButtons.add,
			this.layerButtons.up,
			this.layerButtons.down,
			this.layerButtons.delete,
		);
	}

	buildPromptPanel() {
		this.promptPanel = document.createElement("div");
		this.promptPanel.className = "gjj-qwen-inpaint-prompt";
		const label = document.createElement("div");
		label.className = "gjj-qwen-inpaint-label";
		label.textContent = "正向提示词";
		this.promptInput = this.makeTextarea("正向提示词");
		this.buttons.translate = this.makeButton(TOOL_ICONS.translate, "翻译正向提示词", () => this.translatePrompt());
		this.promptPanel.append(label, this.promptInput, this.buttons.translate);
	}

	buildSettingsPanel() {
		this.settingsPanel = document.createElement("div");
		this.settingsPanel.className = "gjj-qwen-inpaint-settings";
		this.selectControls = new Map();
		this.selectOptionLists = new Map();
		this.selectPickerButtons = new Map();
		this.inputControls = new Map();

		this.negativeInput = this.makeTextarea("反向提示词");
		this.appendSettingRow("反向提示词", this.negativeInput);

		for (const [label, name] of [
			["UNET", FIELD.unet],
			["CLIP", FIELD.clip],
			["ControlNet", FIELD.controlnet],
			["VAE", FIELD.vae],
			["LoRA", FIELD.lora],
			["采样器", FIELD.sampler],
			["调度器", FIELD.scheduler],
		]) {
			const { wrap } = this.makeSearchableSelect(name, label);
			this.appendSettingRow(label, wrap);
		}

		this.appendSettingRow("种子/步数", this.makePair([
			this.makeNumberInput(FIELD.seed, "种子", "1"),
			this.makeNumberInput(FIELD.steps, "步数", "1"),
		]));
		this.appendSettingRow("CFG/降噪", this.makePair([
			this.makeNumberInput(FIELD.cfg, "CFG", "0.1"),
			this.makeNumberInput(FIELD.denoise, "降噪", "0.01"),
		]));
		this.appendSettingRow("最大边/扩展", this.makePair([
			this.makeNumberInput(FIELD.largestSize, "最大边", "8"),
			this.makeNumberInput(FIELD.maskExpand, "遮罩扩展", "1"),
		]));
		this.appendSettingRow("模糊半径/Sigma", this.makePair([
			this.makeNumberInput(FIELD.maskBlurRadius, "遮罩模糊半径", "1"),
			this.makeNumberInput(FIELD.maskBlurSigma, "遮罩模糊 Sigma", "0.1"),
		]));
		this.appendSettingRow("Control范围", this.makePair([
			this.makeNumberInput(FIELD.startPercent, "开始百分比", "0.001"),
			this.makeNumberInput(FIELD.endPercent, "结束百分比", "0.001"),
		]));
		this.appendSettingRow("强度/Shift", this.makePair([
			this.makeNumberInput(FIELD.controlStrength, "ControlNet强度", "0.01"),
			this.makeNumberInput(FIELD.shift, "AuraFlow Shift", "0.01"),
		]));
		this.appendSettingRow("LoRA强度", this.makeNumberInput(FIELD.loraStrength, "LoRA强度", "0.01"));
	}

	makeTextarea(title) {
		const textarea = document.createElement("textarea");
		textarea.title = title;
		textarea.spellcheck = false;
		protectDomEvents(textarea);
		return textarea;
	}

	makeSelect(title) {
		const select = document.createElement("select");
		select.title = title;
		protectDomEvents(select);
		return select;
	}

	makeSearchableSelect(name, title) {
		const wrap = document.createElement("div");
		wrap.className = "gjj-qwen-inpaint-select-wrap";
		const select = this.makeSelect(title);
		select.dataset.field = name;
		select.style.display = "none";
		select.tabIndex = -1;
		const picker = document.createElement("button");
		picker.type = "button";
		picker.className = "gjj-qwen-inpaint-model-picker";
		picker.title = `${title}：点击展开可搜索列表`;
		picker.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openModelPopup(name);
		});
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "wheel", "contextmenu"]) {
			picker.addEventListener(eventName, (event) => event.stopPropagation());
		}
		this.selectControls.set(name, select);
		this.selectPickerButtons.set(name, picker);
		wrap.append(select, picker);
		return { wrap, select, picker };
	}

	makeNumberInput(name, title, step = "1") {
		const input = document.createElement("input");
		input.type = "number";
		input.step = step;
		input.title = title;
		this.inputControls.set(name, input);
		protectDomEvents(input);
		return input;
	}

	makePair(items) {
		const wrap = document.createElement("div");
		wrap.className = "gjj-qwen-inpaint-pair";
		wrap.append(...items);
		return wrap;
	}

	appendSettingRow(label, control) {
		const labelEl = document.createElement("div");
		labelEl.className = "gjj-qwen-inpaint-label";
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
		for (const element of [this.container, this.canvasWrap, this.canvas, this.controls, this.toolbar, this.layerPanel, this.promptPanel, this.settingsPanel]) {
			protectDomEvents(element);
		}
		this.container.addEventListener("pointerenter", () => { this.keyboardActive = true; });
		this.container.addEventListener("pointerleave", () => { this.keyboardActive = false; });
		this.container.addEventListener("focusin", () => { this.keyboardActive = true; });
		this.container.addEventListener("focusout", () => {
			window.setTimeout(() => {
				this.keyboardActive = this.container.contains(document.activeElement);
			}, 0);
		});
		this.keydownHandler = (event) => this.onKeyDown(event);
		document.addEventListener("keydown", this.keydownHandler, true);
		this.fileInput.addEventListener("change", () => {
			const file = this.fileInput.files?.[0];
			this.fileInput.value = "";
			if (file) this.loadFile(file);
		});
		this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
		this.canvas.addEventListener("pointerenter", (event) => this.updateCursorPreview(event));
		this.canvas.addEventListener("pointerleave", () => {
			if (!this.drag) this.hideCursorPreview();
		});
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
			const next = coerceBrushSize(Number(this.sizeRange.value || this.brushSize) + (event.deltaY < 0 ? 2 : -2), this.brushSize);
			this.setBrushSize(next);
		}, { passive: false });
		this.container.addEventListener("dragover", (event) => {
			event.preventDefault();
			this.canvasWrap.classList.add("gjj-qwen-inpaint-drop");
		});
		this.container.addEventListener("dragleave", () => this.canvasWrap.classList.remove("gjj-qwen-inpaint-drop"));
		this.container.addEventListener("drop", (event) => {
			event.preventDefault();
			this.canvasWrap.classList.remove("gjj-qwen-inpaint-drop");
			const file = Array.from(event.dataTransfer?.files || []).find((item) => String(item.type || "").startsWith("image/"));
			if (file) this.loadFile(file);
		});
		this.container.addEventListener("paste", (event) => {
			const file = Array.from(event.clipboardData?.files || []).find((item) => String(item.type || "").startsWith("image/"));
			if (file) {
				event.preventDefault();
				this.loadFile(file);
			}
		});
		this.sizeRange.addEventListener("input", () => this.setBrushSize(this.sizeRange.value, true));
		this.layerSelect.addEventListener("change", () => this.selectLayer(this.layerSelect.value));
		this.layerSelect.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.toggleActiveLayerVisible();
		});
		this.promptInput.addEventListener("input", () => this.invalidateGeneratedCacheAndSync());
		this.negativeInput.addEventListener("input", () => this.invalidateGeneratedCacheAndSync());
		for (const select of this.selectControls.values()) {
			select.addEventListener("change", () => this.invalidateGeneratedCacheAndSync());
		}
		for (const input of this.inputControls.values()) {
			input.addEventListener("input", () => this.invalidateGeneratedCacheAndSync());
		}
	}

	widgetOptions(name, currentValue = "") {
		const w = widget(this.node, name);
		let values = Array.isArray(w?.options?.values) ? w.options.values.map(String) : [];
		if (name === FIELD.unet) values = values.filter(isQwenOrFireRedUnet);
		const current = String(currentValue || w?.value || "");
		if (current && !values.includes(current) && (name !== FIELD.unet || isQwenOrFireRedUnet(current))) values.unshift(current);
		return values;
	}

	filterSelectOptions(name, values, currentValue = "", searchText = "") {
		const filter = String(searchText || "").trim().toLowerCase();
		const terms = filter.split(/\s+/).filter(Boolean);
		const source = (values || []).filter((value) => name !== FIELD.unet || isQwenOrFireRedUnet(value));
		let filtered = source;
		if (terms.length) {
			filtered = source.filter((value) => {
				const haystack = String(value || "").toLowerCase();
				const key = normalizeModelKey(value);
				return terms.every((term) => haystack.includes(term) || key.includes(term.replace(/[-.\s]+/g, "_")));
			});
		}
		const current = String(currentValue || "");
		if (current && (name !== FIELD.unet || isQwenOrFireRedUnet(current)) && !filtered.includes(current)) {
			filtered = [current, ...filtered];
		}
		return filtered;
	}

	populateSelect(select, values, currentValue) {
		const name = select?.dataset?.field || "";
		const sourceValues = Array.isArray(values) ? values.map(String) : [];
		if (name) this.selectOptionLists.set(name, sourceValues);
		values = name ? this.filterSelectOptions(name, sourceValues, currentValue, "") : sourceValues;
		select.innerHTML = "";
		for (const value of values) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			select.appendChild(option);
		}
		if (currentValue) select.value = String(currentValue);
		if (currentValue && select.value !== String(currentValue) && select.options.length) select.selectedIndex = 0;
		this.updateSelectPickerLabel(name);
	}

	updateSelectPickerLabel(name) {
		if (!name) return;
		const select = this.selectControls.get(name);
		const picker = this.selectPickerButtons.get(name);
		if (!select || !picker) return;
		const value = String(select.value || "");
		picker.textContent = value || "未选择";
		picker.title = value || "未选择";
	}

	openModelPopup(name) {
		const select = this.selectControls.get(name);
		const picker = this.selectPickerButtons.get(name);
		if (!select || !picker) return;
		const popup = ensureQwenModelPopup();
		if (popup.isOpenFor(picker)) {
			popup.close();
			return;
		}
		const values = this.selectOptionLists.get(name) || this.widgetOptions(name, select.value);
		popup.open({
			anchorEl: picker,
			placeholder: name === FIELD.unet ? "搜索 qwen / firered / gguf" : "搜索模型",
			getSelectedValue: () => String(select.value || ""),
			getOptions: (searchText) => this.filterSelectOptions(name, values, select.value, searchText).map((value) => ({ value, label: value || "未选择" })),
			onSelect: (value) => {
				select.value = String(value || "");
				setWidgetValue(this.node, name, select.value, false);
				this.updateSelectPickerLabel(name);
				this.invalidateGeneratedCacheAndSync();
				popup.close();
			},
		});
	}

	syncControlsFromWidgets(state = {}) {
		this.promptInput.value = String(state.positivePrompt ?? getWidgetValue(this.node, FIELD.positive, "虎头"));
		this.negativeInput.value = String(state.negativePrompt ?? getWidgetValue(this.node, FIELD.negative, " "));
		for (const name of SELECT_FIELDS) {
			const select = this.selectControls.get(name);
			if (!select) continue;
			const value = state[name] ?? getWidgetValue(this.node, name, "");
			this.populateSelect(select, this.widgetOptions(name, value), value);
		}
		for (const name of NUMERIC_FIELDS) {
			const input = this.inputControls.get(name);
			if (!input) continue;
			input.value = String(state[name] ?? getWidgetValue(this.node, name, ""));
		}
		setWidgetValue(this.node, FIELD.positive, this.promptInput.value, false);
		setWidgetValue(this.node, FIELD.negative, this.negativeInput.value, false);
		for (const [name, select] of this.selectControls) setWidgetValue(this.node, name, select.value, false);
		for (const [name, input] of this.inputControls) setWidgetValue(this.node, name, input.value, false);
		const open = state.settingsOpen ?? this.node.properties?.[PROP_SETTINGS_OPEN] ?? false;
		this.setSettingsOpen(open);
	}

	syncSettingsToWidgets() {
		setWidgetValue(this.node, FIELD.positive, this.promptInput.value, false);
		setWidgetValue(this.node, FIELD.negative, this.negativeInput.value, false);
		for (const [name, select] of this.selectControls) setWidgetValue(this.node, name, select.value, false);
		for (const [name, input] of this.inputControls) setWidgetValue(this.node, name, input.value, false);
		this.syncState();
	}

	invalidateGeneratedCacheAndSync() {
		this.invalidateGeneratedCache(false);
		this.syncSettingsToWidgets();
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

	setCanvasSize(width, height, preserve = false) {
		width = coerceDimension(width, DEFAULT_WIDTH);
		height = coerceDimension(height, DEFAULT_HEIGHT);
		this.storeActiveLayerState();
		const oldImage = document.createElement("canvas");
		const oldLayers = preserve ? this.captureLayers() : [];
		if (preserve && this.canvas.width > 0 && this.canvas.height > 0) {
			oldImage.width = this.imageCanvas.width;
			oldImage.height = this.imageCanvas.height;
			oldImage.getContext("2d").drawImage(this.imageCanvas, 0, 0);
		}
		for (const item of [this.canvas, this.imageCanvas, this.layerCanvas, this.overlayCanvas]) {
			item.width = width;
			item.height = height;
		}
		this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
		this.imageCtx = this.imageCanvas.getContext("2d", { willReadFrequently: true });
		this.layerCtx = this.layerCanvas.getContext("2d", { willReadFrequently: true });
		this.overlayCtx = this.overlayCanvas.getContext("2d", { willReadFrequently: true });
		this.imageCtx.fillStyle = "#000000";
		this.imageCtx.fillRect(0, 0, width, height);
		if (preserve && oldImage.width > 0 && oldImage.height > 0) {
			this.imageCtx.drawImage(oldImage, 0, 0, width, height);
			this.restoreLayerCopies(oldLayers, width, height);
		} else {
			this.resetLayers(false);
		}
		this.rebuildLayerComposite({ render: false, sync: false });
		this.render();
	}

	nextLayerId() {
		this.layerSerial += 1;
		return `layer_${Date.now().toString(36)}_${this.layerSerial}`;
	}

	createLayer(name = "", options = {}) {
		const width = this.canvas.width || DEFAULT_WIDTH;
		const height = this.canvas.height || DEFAULT_HEIGHT;
		const canvas = createCanvas(width, height);
		const maskCanvas = createCanvas(width, height);
		return {
			id: String(options.id || this.nextLayerId()),
			name: String(name || `图层 ${this.layers.length + 1}`),
			visible: options.visible !== false,
			prompt: String(options.prompt || ""),
			canvas,
			ctx: canvas.getContext("2d", { willReadFrequently: true }),
			maskCanvas,
			maskCtx: maskCanvas.getContext("2d", { willReadFrequently: true }),
			hasContent: Boolean(options.hasContent),
			maskHasContent: Boolean(options.maskHasContent),
			history: [],
			historyIndex: -1,
		};
	}

	captureLayers() {
		this.storeActiveLayerState();
		return (this.layers || []).map((layer) => {
			this.ensureLayerSurfaces(layer);
			const canvas = copyCanvas(layer.canvas);
			const maskCanvas = copyCanvas(layer.maskCanvas);
			return {
				id: layer.id,
				name: layer.name,
				visible: layer.visible !== false,
				prompt: layer.prompt || "",
				canvas,
				maskCanvas,
				hasContent: Boolean(layer.hasContent),
				maskHasContent: Boolean(layer.maskHasContent || canvasHasVisiblePixels(layer.maskCanvas)),
			};
		});
	}

	restoreLayerCopies(copies, width, height) {
		this.layers = (copies || []).map((item, index) => {
			const layer = this.createLayer(item.name || `图层 ${index + 1}`, {
				id: item.id,
				visible: item.visible !== false,
				prompt: item.prompt || "",
				hasContent: item.hasContent,
				maskHasContent: item.maskHasContent,
			});
			layer.canvas.width = width;
			layer.canvas.height = height;
			layer.ctx = layer.canvas.getContext("2d", { willReadFrequently: true });
			if (item.canvas?.width && item.canvas?.height && item.hasContent) {
				layer.ctx.drawImage(item.canvas, 0, 0, width, height);
			}
			layer.maskCanvas.width = width;
			layer.maskCanvas.height = height;
			layer.maskCtx = layer.maskCanvas.getContext("2d", { willReadFrequently: true });
			if (item.maskCanvas?.width && item.maskCanvas?.height && item.maskHasContent) {
				layer.maskCtx.drawImage(item.maskCanvas, 0, 0, width, height);
				layer.maskHasContent = true;
			}
			return layer;
		});
		const layer = this.ensureLayer();
		this.activateLayerMask(layer, true);
	}

	resetLayers(shouldSync = true) {
		this.layers = [this.createLayer("图层 1")];
		this.activeLayerId = this.layers[0].id;
		this.activateLayerMask(this.layers[0], true);
		this.rebuildLayerComposite({ render: true, sync: shouldSync });
	}

	ensureLayer() {
		if (!Array.isArray(this.layers)) this.layers = [];
		if (!this.layers.length) this.layers.push(this.createLayer("图层 1"));
		if (!this.layers.some((layer) => layer.id === this.activeLayerId)) {
			this.activeLayerId = this.layers[this.layers.length - 1]?.id || "";
		}
		const layer = this.activeLayer();
		this.ensureLayerSurfaces(layer);
		return layer;
	}

	activeLayer() {
		return this.layers.find((layer) => layer.id === this.activeLayerId) || this.layers[this.layers.length - 1] || null;
	}

	activeLayerIndex() {
		return this.layers.findIndex((layer) => layer.id === this.activeLayerId);
	}

	ensureLayerSurfaces(layer) {
		if (!layer) return null;
		const width = this.canvas.width || DEFAULT_WIDTH;
		const height = this.canvas.height || DEFAULT_HEIGHT;
		if (!layer.canvas) {
			layer.canvas = createCanvas(width, height);
			layer.ctx = layer.canvas.getContext("2d", { willReadFrequently: true });
		}
		if (layer.canvas.width !== width || layer.canvas.height !== height) {
			const oldCanvas = copyCanvas(layer.canvas);
			layer.canvas.width = width;
			layer.canvas.height = height;
			layer.ctx = layer.canvas.getContext("2d", { willReadFrequently: true });
			if (oldCanvas.width && oldCanvas.height && layer.hasContent) {
				layer.ctx.drawImage(oldCanvas, 0, 0, width, height);
			}
		}
		if (!layer.maskCanvas) {
			layer.maskCanvas = createCanvas(width, height);
			layer.maskCtx = layer.maskCanvas.getContext("2d", { willReadFrequently: true });
		}
		if (layer.maskCanvas.width !== width || layer.maskCanvas.height !== height) {
			const oldMask = copyCanvas(layer.maskCanvas);
			layer.maskCanvas.width = width;
			layer.maskCanvas.height = height;
			layer.maskCtx = layer.maskCanvas.getContext("2d", { willReadFrequently: true });
			if (oldMask.width && oldMask.height && (layer.maskHasContent || canvasHasVisiblePixels(oldMask))) {
				layer.maskCtx.drawImage(oldMask, 0, 0, width, height);
				layer.maskHasContent = true;
			}
		}
		if (!layer.ctx) layer.ctx = layer.canvas.getContext("2d", { willReadFrequently: true });
		if (!layer.maskCtx) layer.maskCtx = layer.maskCanvas.getContext("2d", { willReadFrequently: true });
		if (!Array.isArray(layer.history)) layer.history = [];
		if (!Number.isFinite(Number(layer.historyIndex))) layer.historyIndex = -1;
		return layer;
	}

	activateLayerMask(layer, resetHistoryIfEmpty = false) {
		this.ensureLayerSurfaces(layer);
		if (!layer) return;
		this.maskCanvas = layer.maskCanvas;
		this.maskCtx = layer.maskCtx;
		this.history = Array.isArray(layer.history) ? layer.history : [];
		this.historyIndex = Number.isFinite(Number(layer.historyIndex)) ? Number(layer.historyIndex) : -1;
		if (resetHistoryIfEmpty || !this.history.length) this.resetHistory();
		else this.updateHistoryButtons();
		this.render();
	}

	storeActiveLayerState() {
		const layer = this.activeLayer();
		if (!layer || !this.maskCanvas) return;
		this.ensureLayerSurfaces(layer);
		layer.maskHasContent = canvasHasVisiblePixels(this.maskCanvas);
		layer.history = this.history || [];
		layer.historyIndex = this.historyIndex ?? -1;
	}

	currentLayerPrompt() {
		return summarizePromptForLayer(this.promptInput?.value || getWidgetValue(this.node, FIELD.positive, ""));
	}

	layerColor(index, layer) {
		if (layer?.visible === false) return "#647178";
		return LAYER_COLORS[index % LAYER_COLORS.length];
	}

	layerLabel(layer, index) {
		const visible = layer?.visible !== false;
		const icon = layerNumberEmoji(index);
		const prompt = summarizePromptForLayer(layer?.prompt || "");
		const name = String(layer?.name || `图层 ${index + 1}`);
		const state = visible ? "显示" : "隐藏";
		return `${icon} ${name}${prompt ? ` · ${prompt}` : ""} · ${state}`;
	}

	updateLayerShortcuts() {
		if (!this.layerShortcutBar) return;
		this.layerShortcutBar.replaceChildren();
		this.layers.forEach((layer, index) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "gjj-qwen-inpaint-layer-shortcut";
			button.textContent = layerNumberEmoji(index);
			button.title = `${this.layerLabel(layer, index)}；点击选择并切换显示/隐藏`;
			button.style.color = this.layerColor(index, layer);
			button.style.borderColor = this.layerColor(index, layer);
			button.classList.toggle("active", layer.id === this.activeLayerId);
			button.classList.toggle("hidden", layer.visible === false);
			for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "wheel", "contextmenu"]) {
				button.addEventListener(eventName, (event) => event.stopPropagation());
			}
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.handleLayerShortcut(layer.id);
			});
			this.layerShortcutBar.appendChild(button);
		});
	}

	rebuildLayerComposite(options = {}) {
		const { render = true, sync = false } = options;
		if (!this.layerCtx || !this.layerCanvas) return;
		this.ensureLayer();
		this.layerCtx.clearRect(0, 0, this.layerCanvas.width, this.layerCanvas.height);
		let hasVisibleContent = false;
		for (const layer of this.layers) {
			if (layer.visible === false || !layer.hasContent) continue;
			this.layerCtx.drawImage(layer.canvas, 0, 0, this.layerCanvas.width, this.layerCanvas.height);
			hasVisibleContent = true;
		}
		this.layerImageData = hasVisibleContent ? canvasToPngDataUrl(this.layerCanvas) : "";
		this.updateLayerPanel();
		if (render) this.render();
		if (sync) this.syncState();
	}

	serializeLayers() {
		this.storeActiveLayerState();
		this.ensureLayer();
		return this.layers.map((layer, index) => ({
			id: layer.id,
			name: layer.name || `图层 ${index + 1}`,
			visible: layer.visible !== false,
			prompt: layer.prompt || "",
			image: layer.hasContent ? canvasToPngDataUrl(layer.canvas) : "",
			maskImage: layer.maskHasContent ? canvasToPngDataUrl(layer.maskCanvas) : "",
		}));
	}

	updateLayerPanel() {
		if (!this.layerSelect || !this.layerButtons) return;
		this.ensureLayer();
		this.layerSelect.innerHTML = "";
		this.layers.forEach((layer, index) => {
			const option = document.createElement("option");
			option.value = layer.id;
			option.textContent = this.layerLabel(layer, index);
			option.style.color = this.layerColor(index, layer);
			option.style.backgroundColor = layer.visible === false ? "#101417" : "#151f25";
			option.style.opacity = layer.visible === false ? "0.5" : "1";
			this.layerSelect.appendChild(option);
		});
		this.layerSelect.value = this.activeLayerId;
		const index = this.activeLayerIndex();
		const active = this.activeLayer();
		this.layerSelect.style.color = this.layerColor(Math.max(0, index), active);
		this.layerSelect.style.borderColor = this.layerColor(Math.max(0, index), active);
		this.layerSelect.style.opacity = active?.visible === false ? "0.56" : "1";
		this.layerSelect.title = `${active ? this.layerLabel(active, Math.max(0, index)) : "选择图层"}；右键切换显示/隐藏`;
		this.updateLayerShortcuts();
		this.layerButtons.up.disabled = index < 0 || index >= this.layers.length - 1;
		this.layerButtons.down.disabled = index <= 0;
		this.layerButtons.delete.disabled = this.layers.length <= 1;
	}

	handleLayerShortcut(id) {
		const layer = this.layers.find((item) => item.id === id);
		if (!layer) return;
		this.storeActiveLayerState();
		this.activeLayerId = id;
		this.activateLayerMask(layer, false);
		layer.visible = layer.visible === false;
		this.invalidateGeneratedCache(false);
		this.rebuildLayerComposite({ render: true, sync: true });
		this.renderStatus(layer.visible ? "已选择并显示图层" : "已选择并隐藏图层");
	}

	selectLayer(id, shouldSync = true) {
		if (!this.layers.some((layer) => layer.id === id)) return;
		this.storeActiveLayerState();
		this.activeLayerId = id;
		this.activateLayerMask(this.activeLayer(), false);
		this.updateLayerPanel();
		if (shouldSync) this.syncState();
		this.renderStatus("已选择图层");
	}

	addLayer() {
		this.storeActiveLayerState();
		const sourceMask = this.maskCanvas && canvasHasVisiblePixels(this.maskCanvas)
			? copyCanvas(this.maskCanvas)
			: null;
		const layer = this.createLayer(`图层 ${this.layers.length + 1}`, { prompt: this.currentLayerPrompt() });
		if (sourceMask) {
			layer.maskCtx.drawImage(sourceMask, 0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
			layer.maskHasContent = true;
		}
		this.layers.push(layer);
		this.activeLayerId = layer.id;
		this.activateLayerMask(layer, true);
		this.updateLayerPanel();
		this.syncState();
		this.renderStatus(sourceMask ? "已新建图层并复制当前蒙版" : "已新建透明图层");
	}

	toggleActiveLayerVisible() {
		const layer = this.activeLayer();
		if (!layer) return;
		layer.visible = layer.visible === false;
		this.invalidateGeneratedCache(false);
		this.rebuildLayerComposite({ render: true, sync: true });
		this.renderStatus(layer.visible ? "已显示当前图层" : "已隐藏当前图层");
	}

	moveActiveLayer(delta) {
		const index = this.activeLayerIndex();
		const next = index + delta;
		if (index < 0 || next < 0 || next >= this.layers.length) return;
		this.storeActiveLayerState();
		const [layer] = this.layers.splice(index, 1);
		this.layers.splice(next, 0, layer);
		this.invalidateGeneratedCache(false);
		this.rebuildLayerComposite({ render: true, sync: true });
		this.renderStatus(delta > 0 ? "图层已上移" : "图层已下移");
	}

	deleteActiveLayer() {
		const index = this.activeLayerIndex();
		if (index < 0 || this.layers.length <= 1) return;
		this.storeActiveLayerState();
		this.layers.splice(index, 1);
		this.activeLayerId = this.layers[Math.min(index, this.layers.length - 1)]?.id || "";
		this.activateLayerMask(this.activeLayer(), false);
		this.invalidateGeneratedCache(false);
		this.rebuildLayerComposite({ render: true, sync: true });
		this.renderStatus("已删除当前图层");
	}

	loadImageToLayer(layer, src) {
		const value = asDataUrl(src);
		if (!layer || !value) return Promise.resolve(false);
		return new Promise((resolve) => {
			const image = new Image();
			image.onload = () => {
				layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
				layer.ctx.drawImage(image, 0, 0, layer.canvas.width, layer.canvas.height);
				layer.hasContent = true;
				resolve(true);
			};
			image.onerror = () => resolve(false);
			image.src = value;
		});
	}

	loadMaskToLayer(layer, src) {
		const value = asDataUrl(src);
		if (!layer || !value) return Promise.resolve(false);
		this.ensureLayerSurfaces(layer);
		return new Promise((resolve) => {
			const image = new Image();
			image.onload = () => {
				layer.maskCtx.clearRect(0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
				layer.maskCtx.drawImage(image, 0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
				layer.maskHasContent = canvasHasVisiblePixels(layer.maskCanvas);
				layer.history = [];
				layer.historyIndex = -1;
				resolve(true);
			};
			image.onerror = () => resolve(false);
			image.src = value;
		});
	}

	async loadLayersFromState(state = {}, fallbackLayerImage = "", shouldSync = true) {
		const savedLayers = Array.isArray(state.layers) ? state.layers : [];
		const legacyMaskImage = state.maskImage || state.mask || state.maskData || state.mask_data || "";
		this.layers = [];
		for (let index = 0; index < savedLayers.length; index += 1) {
			const item = savedLayers[index] || {};
			const layer = this.createLayer(item.name || `图层 ${index + 1}`, {
				id: item.id,
				visible: item.visible !== false,
				prompt: item.prompt || item.positivePrompt || "",
			});
			await this.loadImageToLayer(layer, item.image || item.layerImage || "");
			const layerMask = item.maskImage || item.mask || item.maskData || "";
			await this.loadMaskToLayer(layer, layerMask || (item.id === state.activeLayerId ? legacyMaskImage : ""));
			this.layers.push(layer);
		}
		if (!this.layers.length) {
			const layer = this.createLayer("图层 1", { prompt: this.currentLayerPrompt() });
			await this.loadImageToLayer(layer, fallbackLayerImage);
			await this.loadMaskToLayer(layer, legacyMaskImage);
			this.layers.push(layer);
		}
		this.activeLayerId = this.layers.some((layer) => layer.id === state.activeLayerId)
			? state.activeLayerId
			: this.layers[this.layers.length - 1]?.id || "";
		this.activateLayerMask(this.activeLayer(), false);
		this.rebuildLayerComposite({ render: true, sync: shouldSync });
	}

	loadInitialState() {
		const raw = getWidgetValue(this.node, FIELD.data, "") || this.node.properties?.[PROP_STATE] || "";
		const state = parseJson(raw, {});
		const width = coerceDimension(state.width || DEFAULT_WIDTH, DEFAULT_WIDTH);
		const height = coerceDimension(state.height || DEFAULT_HEIGHT, DEFAULT_HEIGHT);
		this.brushSize = coerceBrushSize(state.brushSize || 48, 48);
		this.showMask = state.showMask !== false;
		this.sizeRange.value = String(this.brushSize);
		this.sizeText.textContent = `${this.brushSize}px`;
		this.syncControlsFromWidgets(state);
		this.setCanvasSize(width, height, false);
		const baseImage = state.baseImage || state.sourceImage || state.image || "";
		const layerImage = state.layerImage || state.editLayerImage || "";
		const generatedImage = state.generatedImage || state.generated_image || "";
		this.generatedImageData = generatedImage ? asDataUrl(generatedImage) : "";
		this.cacheSignature = String(state.cacheSignature || state.generationSignature || "");
		this.imageSignature = String(state.imageSignature || "");
		this.maskSignature = String(state.maskSignature || "");
		this.generatedSignature = String(state.generatedSignature || "");
		if (baseImage) {
			this.loadImage(asDataUrl(baseImage), { sync: false, clearMask: true, status: "", invalidateCache: false }).then(() => {
				this.loadLayersFromState(state, layerImage ? asDataUrl(layerImage) : "", false).then(() => {
					if (this.generatedImageData && !this.hasLayerContent()) this.loadGeneratedPreview(this.generatedImageData, false);
					this.syncState();
				});
			});
		} else {
			this.loadLayersFromState(state, layerImage ? asDataUrl(layerImage) : "", false).then(() => {
				if (this.generatedImageData && !this.hasLayerContent()) this.loadGeneratedPreview(this.generatedImageData, false);
				this.syncState();
			});
		}
		this.updateMaskButton();
	}

	loadFile(file) {
		const reader = new FileReader();
		reader.onload = () => {
			this.loadImage(String(reader.result || ""), { sync: true, clearMask: true, status: "已导入图片" });
		};
		reader.readAsDataURL(file);
	}

	loadImage(src, options = {}) {
		const { sync = true, clearMask = false, status = "", preserveMask = false, preserveLayer = false, invalidateCache = true } = options;
		return new Promise((resolve) => {
			const image = new Image();
			image.onload = () => {
				const nextWidth = image.naturalWidth || this.canvas.width || DEFAULT_WIDTH;
				const nextHeight = image.naturalHeight || this.canvas.height || DEFAULT_HEIGHT;
				const oldLayers = preserveLayer || preserveMask ? this.captureLayers() : [];
				this.setCanvasSize(nextWidth, nextHeight, false);
				this.imageCtx.drawImage(image, 0, 0, this.imageCanvas.width, this.imageCanvas.height);
				if ((preserveLayer || preserveMask) && oldLayers.length) {
					this.restoreLayerCopies(oldLayers, this.layerCanvas.width, this.layerCanvas.height);
					this.rebuildLayerComposite({ render: false, sync: false });
				} else {
					this.resetLayers(false);
				}
				if (clearMask) this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
				this.baseImageData = canvasToSourceDataUrl(this.imageCanvas);
				if (invalidateCache) this.invalidateGeneratedCache(false);
				this.render();
				this.resetHistory();
				this.layout();
				if (sync) this.syncState();
				if (status) this.renderStatus(status);
				resolve(true);
			};
			image.onerror = () => {
				this.renderStatus("图片读取失败");
				resolve(false);
			};
			image.src = src;
		});
	}

	loadMask(src, shouldSync = true) {
		const image = new Image();
		image.onload = () => {
			const layer = this.ensureLayer();
			this.activateLayerMask(layer, false);
			this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
			this.maskCtx.drawImage(image, 0, 0, this.maskCanvas.width, this.maskCanvas.height);
			layer.maskHasContent = canvasHasVisiblePixels(this.maskCanvas);
			this.render();
			this.resetHistory();
			if (shouldSync) this.syncState();
		};
		image.src = src;
	}

	loadLayer(src, shouldSync = true) {
		return this.loadLayersFromState({}, src, shouldSync);
	}

	loadGeneratedPreview(src, shouldRender = true) {
		const image = new Image();
		image.onload = () => {
			this.previewImage = image;
			if (shouldRender) this.render();
		};
		image.src = src;
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
				this.syncSettingsToWidgets();
				this.renderStatus("翻译完成");
			} else {
				this.renderStatus("翻译结果为空");
			}
		} catch (error) {
			console.error("[GJJ] 千问局部重绘提示词翻译失败:", error);
			this.renderStatus(`翻译失败：${error?.message || error}`);
		} finally {
			this.translating = false;
			button.textContent = oldText;
			button.disabled = false;
		}
	}

	async generateInPlace() {
		if (this.generating) return;
		this.node.__gjjQwenInpaintExplicitGenerate = true;
		this.prepareQueue();
		this.markGenerating("生成中");
		try {
			const ok = await queueOnlyCurrentNode(this.node);
			if (!ok) {
				delete this.node.__gjjQwenInpaintExplicitGenerate;
				this.prepareQueue();
				this.finishGenerating("提交失败");
				return;
			}
			this.renderStatus("已提交生成");
			clearTimeout(this.generateFallbackTimer);
			this.generateFallbackTimer = window.setTimeout(() => this.finishGenerating(), 600000);
		} catch (error) {
			console.error("[GJJ] 千问局部重绘原地生成失败:", error);
			delete this.node.__gjjQwenInpaintExplicitGenerate;
			this.prepareQueue();
			this.finishGenerating("生成失败");
		}
	}

	markGenerating(message = "生成中") {
		this.generating = true;
		const button = this.buttons.generate;
		if (button) {
			this.generateButtonContent = button.innerHTML || button.textContent;
			button.textContent = "…";
			button.disabled = true;
			button.style.opacity = "0.7";
		}
		this.renderStatus(message);
	}

	finishGenerating(message = "") {
		clearTimeout(this.generateFallbackTimer);
		this.generating = false;
		const button = this.buttons.generate;
		if (button) {
			if (this.generateButtonContent?.trim?.().startsWith("<svg")) button.innerHTML = this.generateButtonContent;
			else setButtonContent(button, TOOL_ICONS.generate);
			button.disabled = false;
			button.style.opacity = "1";
		}
		if (message) this.renderStatus(message);
		else this.renderStatus();
	}

	prepareQueue() {
		this.syncSettingsToWidgets();
		this.syncState();
	}

	setTool(tool) {
		this.tool = tool;
		this.buttons.brush.classList.toggle("on", tool === "brush");
		this.buttons.eraser.classList.toggle("on", tool === "eraser");
		this.buttons.fill.classList.toggle("on", tool === "fill");
		this.canvas.style.cursor = tool === "fill" ? "cell" : "none";
		this.updateCursorPreview();
		this.renderStatus();
	}

	setBrushSize(size, shouldSync = true) {
		this.brushSize = coerceBrushSize(size, 48);
		this.sizeRange.value = String(this.brushSize);
		this.sizeText.textContent = `${this.brushSize}px`;
		this.updateCursorPreview();
		if (shouldSync) this.syncState();
		this.renderStatus();
	}

	toggleMask() {
		this.showMask = !this.showMask;
		this.updateMaskButton();
		this.render();
		this.syncState();
	}

	updateMaskButton() {
		this.buttons.mask.classList.toggle("on", this.showMask);
		this.buttons.mask.title = this.showMask ? "当前显示遮罩覆盖；点击隐藏" : "当前隐藏遮罩覆盖；点击显示";
	}

	showMaskForDrawing() {
		if (this.showMask) return;
		this.showMask = true;
		this.updateMaskButton();
	}

	clearMask() {
		const layer = this.ensureLayer();
		this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
		if (layer) layer.maskHasContent = false;
		this.recordSnapshot(false);
		this.renderStatus("已清空遮罩");
	}

	invalidateGeneratedCache(render = true) {
		this.generatedImageData = "";
		this.previewImage = null;
		this.cacheSignature = "";
		this.imageSignature = "";
		this.maskSignature = "";
		this.generatedSignature = "";
		if (render) this.render();
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
		this.keyboardActive = true;
		try { this.container.focus({ preventScroll: true }); } catch (_) {}
		this.updateCursorPreview(event);
		const point = this.eventPoint(event);
		if (this.tool === "fill") {
			if (this.floodFillMask(point)) {
				this.recordSnapshot();
				this.renderStatus("已填充封闭区域");
			}
			return;
		}
		if (this.tool === "brush" || this.tool === "eraser") this.showMaskForDrawing();
		this.drag = { last: point, moved: false };
		try { this.canvas.setPointerCapture(event.pointerId); } catch (_) {}
		this.drawDot(point, this.tool === "eraser");
	}

	onPointerMove(event) {
		this.updateCursorPreview(event);
		if (!this.drag) return;
		event.preventDefault();
		event.stopPropagation();
		const point = this.eventPoint(event);
		this.drag.moved = true;
		this.drawStroke(this.drag.last, point, this.tool === "eraser");
		this.drag.last = point;
	}

	onPointerUp(event) {
		if (!this.drag) return;
		event.preventDefault();
		event.stopPropagation();
		this.drag = null;
		try { this.canvas.releasePointerCapture(event.pointerId); } catch (_) {}
		this.recordSnapshot();
		this.updateCursorPreview(event);
	}

	hideCursorPreview() {
		this.cursorPoint = null;
		if (this.cursorPreview) this.cursorPreview.style.display = "none";
	}

	updateCursorPreview(event = null) {
		if (!this.cursorPreview || !this.canvas) return;
		const isBrushLike = this.tool === "brush" || this.tool === "eraser";
		if (!isBrushLike) {
			this.hideCursorPreview();
			return;
		}
		const canvasRect = this.canvas.getBoundingClientRect();
		if (!canvasRect.width || !canvasRect.height || !this.canvas.width || !this.canvas.height) {
			this.hideCursorPreview();
			return;
		}
		if (event?.clientX !== undefined && event?.clientY !== undefined) {
			this.cursorPoint = this.eventPoint(event);
		}
		if (!this.cursorPoint) {
			this.cursorPreview.classList.toggle("eraser", this.tool === "eraser");
			return;
		}
		const displayWidth = Math.max(1, this.canvas.offsetWidth || this.displayWidth || canvasRect.width);
		const displayHeight = Math.max(1, this.canvas.offsetHeight || this.displayHeight || canvasRect.height);
		const scaleX = displayWidth / Math.max(1, this.canvas.width);
		const scaleY = displayHeight / Math.max(1, this.canvas.height);
		const diameterX = Math.max(4, Math.round(this.brushSize * scaleX));
		const diameterY = Math.max(4, Math.round(this.brushSize * scaleY));
		this.cursorPreview.style.width = `${diameterX}px`;
		this.cursorPreview.style.height = `${diameterY}px`;
		this.cursorPreview.classList.toggle("eraser", this.tool === "eraser");
		this.cursorPreview.style.left = `${this.canvas.offsetLeft + this.cursorPoint.x * scaleX}px`;
		this.cursorPreview.style.top = `${this.canvas.offsetTop + this.cursorPoint.y * scaleY}px`;
		this.cursorPreview.style.display = "block";
	}

	isTextEditingTarget(target) {
		const element = target instanceof Element ? target : null;
		if (!element) return false;
		const tag = String(element.tagName || "").toLowerCase();
		return tag === "textarea" || tag === "input" || tag === "select" || element.isContentEditable;
	}

	onKeyDown(event) {
		if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
		const key = String(event.key || "").toLowerCase();
		const wantsUndo = key === "z" && !event.shiftKey;
		const wantsRedo = key === "y" || key === "z" && event.shiftKey;
		if (!wantsUndo && !wantsRedo) return;
		if (this.isTextEditingTarget(event.target)) return;
		if (!this.keyboardActive && !this.container.matches(":hover")) return;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation?.();
		if (wantsRedo) {
			this.restoreHistory(1);
			this.renderStatus("已重做遮罩");
		} else {
			this.restoreHistory(-1);
			this.renderStatus("已撤销遮罩");
		}
	}

	applyStrokeStyle(isEraser = false) {
		this.maskCtx.save();
		this.maskCtx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
		this.maskCtx.lineWidth = this.brushSize;
		this.maskCtx.lineCap = "round";
		this.maskCtx.lineJoin = "round";
		this.maskCtx.strokeStyle = "rgba(255,255,255,1)";
		this.maskCtx.fillStyle = "rgba(255,255,255,1)";
	}

	drawDot(point, isEraser = false) {
		this.applyStrokeStyle(isEraser);
		this.maskCtx.beginPath();
		this.maskCtx.arc(point.x, point.y, this.brushSize / 2, 0, Math.PI * 2);
		this.maskCtx.fill();
		this.maskCtx.restore();
		this.render();
	}

	floodFillMask(point) {
		const width = this.maskCanvas.width;
		const height = this.maskCanvas.height;
		if (!width || !height) return false;
		const startX = Math.round(clamp(point.x, 0, width - 1));
		const startY = Math.round(clamp(point.y, 0, height - 1));
		const imageData = this.maskCtx.getImageData(0, 0, width, height);
		const data = imageData.data;
		const threshold = 18;
		const maskValueAt = (index) => {
			const offset = index * 4;
			return Math.max(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
		};
		const startIndex = startY * width + startX;
		if (maskValueAt(startIndex) > threshold) {
			this.renderStatus("这里已经是遮罩");
			return false;
		}
		const total = width * height;
		const visited = new Uint8Array(total);
		const queue = new Int32Array(total);
		let head = 0;
		let tail = 0;
		const enqueue = (index) => {
			if (visited[index]) return;
			visited[index] = 1;
			queue[tail++] = index;
		};
		enqueue(startIndex);
		while (head < tail) {
			const index = queue[head++];
			if (maskValueAt(index) > threshold) continue;
			const offset = index * 4;
			data[offset] = 255;
			data[offset + 1] = 255;
			data[offset + 2] = 255;
			data[offset + 3] = 255;
			const x = index % width;
			if (x > 0) enqueue(index - 1);
			if (x < width - 1) enqueue(index + 1);
			if (index >= width) enqueue(index - width);
			if (index < total - width) enqueue(index + width);
		}
		this.maskCtx.putImageData(imageData, 0, 0);
		this.render();
		return true;
	}

	drawStroke(from, to, isEraser = false) {
		this.applyStrokeStyle(isEraser);
		this.maskCtx.beginPath();
		this.maskCtx.moveTo(from.x, from.y);
		this.maskCtx.lineTo(to.x, to.y);
		this.maskCtx.stroke();
		this.maskCtx.restore();
		this.render();
	}

	resetHistory() {
		this.history = [this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height)];
		this.historyIndex = 0;
		const layer = this.activeLayer();
		if (layer) {
			layer.history = this.history;
			layer.historyIndex = this.historyIndex;
			layer.maskHasContent = canvasHasVisiblePixels(this.maskCanvas);
		}
		this.updateHistoryButtons();
	}

	recordSnapshot(invalidateCache = true) {
		if (invalidateCache) this.invalidateGeneratedCache(false);
		const snapshot = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
		this.history = this.history.slice(0, this.historyIndex + 1);
		this.history.push(snapshot);
		if (this.history.length > MAX_HISTORY) this.history.shift();
		this.historyIndex = this.history.length - 1;
		this.storeActiveLayerState();
		this.updateHistoryButtons();
		this.render();
		this.syncState();
	}

	restoreHistory(delta) {
		const next = this.historyIndex + delta;
		if (next < 0 || next >= this.history.length) return;
		this.invalidateGeneratedCache(false);
		this.historyIndex = next;
		const snapshot = this.history[this.historyIndex];
		if (snapshot.width !== this.maskCanvas.width || snapshot.height !== this.maskCanvas.height) {
			this.setCanvasSize(snapshot.width, snapshot.height, true);
		}
		this.maskCtx.putImageData(snapshot, 0, 0);
		this.storeActiveLayerState();
		this.updateHistoryButtons();
		this.render();
		this.syncState();
	}

	updateHistoryButtons() {
		if (!this.buttons) return;
		this.buttons.undo.disabled = this.historyIndex <= 0;
		this.buttons.redo.disabled = this.historyIndex >= this.history.length - 1;
	}

	render() {
		if (!this.ctx) return;
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.drawImage(this.imageCanvas, 0, 0, this.canvas.width, this.canvas.height);
		if (this.hasLayerContent()) {
			this.ctx.drawImage(this.layerCanvas, 0, 0, this.canvas.width, this.canvas.height);
		} else if (this.previewImage?.complete) {
			this.ctx.drawImage(this.previewImage, 0, 0, this.canvas.width, this.canvas.height);
		}
		if (this.showMask) this.drawMaskOverlay();
	}

	hasLayerContent() {
		return Boolean(this.layerImageData);
	}

	composeFinalImageDataUrl() {
		const canvas = document.createElement("canvas");
		canvas.width = this.canvas.width || DEFAULT_WIDTH;
		canvas.height = this.canvas.height || DEFAULT_HEIGHT;
		const ctx = canvas.getContext("2d");
		ctx.drawImage(this.imageCanvas, 0, 0, canvas.width, canvas.height);
		ctx.drawImage(this.layerCanvas, 0, 0, canvas.width, canvas.height);
		return canvasToSourceDataUrl(canvas);
	}

	drawMaskOverlay() {
		const width = this.maskCanvas.width;
		const height = this.maskCanvas.height;
		if (!width || !height) return;
		const maskData = this.maskCtx.getImageData(0, 0, width, height);
		const overlay = this.overlayCtx.createImageData(width, height);
		for (let offset = 0; offset < maskData.data.length; offset += 4) {
			const strength = Math.max(maskData.data[offset], maskData.data[offset + 1], maskData.data[offset + 2], maskData.data[offset + 3]) / 255;
			if (strength <= 0) continue;
			overlay.data[offset] = 255;
			overlay.data[offset + 1] = 64;
			overlay.data[offset + 2] = 64;
			overlay.data[offset + 3] = Math.round(145 * strength);
		}
		this.overlayCtx.putImageData(overlay, 0, 0);
		this.ctx.drawImage(this.overlayCanvas, 0, 0);
	}

	syncState() {
		this.storeActiveLayerState();
		if (!this.baseImageData) this.baseImageData = canvasToSourceDataUrl(this.imageCanvas);
		const shouldStoreSourceImage = !this.hasImageLink();
		const payload = {
			version: 1,
			width: this.canvas.width || DEFAULT_WIDTH,
			height: this.canvas.height || DEFAULT_HEIGHT,
			brushSize: this.brushSize,
			showMask: this.showMask,
			settingsOpen: this.settingsPanel?.classList?.contains("open") || false,
			baseImage: shouldStoreSourceImage ? this.baseImageData : "",
			layerImage: this.layerImageData || "",
			maskImage: this.maskCanvas.toDataURL("image/png"),
			executionMode: this.node.__gjjQwenInpaintExplicitGenerate ? "inpaint" : "composite",
			generatedImage: this.generatedImageData || "",
			cacheSignature: this.cacheSignature || "",
			imageSignature: this.imageSignature || "",
			maskSignature: this.maskSignature || "",
			generatedSignature: this.generatedSignature || "",
			positivePrompt: String(this.promptInput?.value || ""),
			negativePrompt: String(this.negativeInput?.value || ""),
			layers: this.serializeLayers(),
			activeLayerId: this.activeLayerId || "",
		};
		for (const [name, select] of this.selectControls) payload[name] = String(select.value || "");
		for (const [name, input] of this.inputControls) payload[name] = String(input.value || "");
		const text = JSON.stringify(payload);
		setWidgetValue(this.node, FIELD.data, text, false);
		setWidgetValue(this.node, FIELD.positive, payload.positivePrompt, false);
		setWidgetValue(this.node, FIELD.negative, payload.negativePrompt, false);
		for (const [name, select] of this.selectControls) setWidgetValue(this.node, name, select.value, false);
		for (const [name, input] of this.inputControls) setWidgetValue(this.node, name, input.value, false);
		this.node.properties = this.node.properties || {};
		this.node.properties[PROP_SETTINGS_OPEN] = payload.settingsOpen;
		delete this.node.properties[PROP_STATE];
		this.node.__gjjQwenInpaintStateText = text;
		this.node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
		this.renderStatus();
	}

	hasImageLink() {
		return hasLinkedInput(this.node, "image", "image");
	}

	applyGeneratedImage(value, signatures = {}) {
		const src = asDataUrl(value);
		if (!src) return false;
		const layerSrc = asDataUrl(signatures.layerImage || "");
		const image = new Image();
		image.onload = () => {
			const finish = () => {
				if (layerSrc) {
					this.previewImage = null;
					this.generatedImageData = this.composeFinalImageDataUrl();
				} else if (this.hasLayerContent()) {
					this.previewImage = null;
					this.generatedImageData = this.composeFinalImageDataUrl();
				} else {
					this.previewImage = image;
					this.generatedImageData = imageElementToCacheDataUrl(image);
				}
				this.cacheSignature = String(signatures.cacheSignature || signatures.generationSignature || "");
				this.imageSignature = String(signatures.imageSignature || "");
				this.maskSignature = String(signatures.maskSignature || "");
				this.generatedSignature = String(signatures.generatedSignature || "");
				this.render();
				this.syncState();
				this.finishGenerating(signatures.cacheHit ? "命中缓存" : "已添加到透明图层");
			};
			if (layerSrc) {
				this.mergeGeneratedLayer(layerSrc).then(finish);
			} else {
				finish();
			}
		};
		image.onerror = () => {
			this.generatedImageData = src;
			this.cacheSignature = String(signatures.cacheSignature || signatures.generationSignature || "");
			this.imageSignature = String(signatures.imageSignature || "");
			this.maskSignature = String(signatures.maskSignature || "");
			this.generatedSignature = String(signatures.generatedSignature || "");
			this.syncState();
			this.finishGenerating(signatures.cacheHit ? "命中缓存" : "生成完成");
		};
		image.src = src;
		return true;
	}

	mergeGeneratedLayer(src) {
		return new Promise((resolve) => {
			const image = new Image();
			image.onload = () => {
				const layer = this.activeLayer() || this.ensureLayer();
				if (layer) {
					layer.visible = true;
					layer.prompt = this.currentLayerPrompt();
					layer.ctx.drawImage(image, 0, 0, layer.canvas.width, layer.canvas.height);
					layer.hasContent = true;
				}
				this.rebuildLayerComposite({ render: false, sync: false });
				resolve(true);
			};
			image.onerror = () => resolve(false);
			image.src = src;
		});
	}

	applySourceImage(value, options = {}) {
		const src = asDataUrl(value);
		if (!src) return false;
		const {
			sync = true,
			invalidateCache = true,
			status = "已同步上游图像",
		} = options;
		this.loadImage(src, { sync, preserveMask: true, preserveLayer: true, status, invalidateCache });
		return true;
	}

	applyMaskImage(value) {
		const src = asDataUrl(value);
		if (!src) return false;
		this.loadMask(src, true);
		return true;
	}

	renderStatus(message = "") {
		if (!this.status) return;
		const toolName = this.tool === "fill" ? "油漆桶" : this.tool === "eraser" ? "遮罩橡皮" : "遮罩画笔";
		const source = this.hasImageLink() ? "上游图像优先" : (this.baseImageData ? "面板图像" : "空白画布");
		const mask = this.showMask ? "显示遮罩" : "隐藏遮罩";
		const layer = this.activeLayer();
		const layerName = layer ? `${layer.name || "图层"}${layer.visible === false ? "(隐藏)" : ""}` : "无图层";
		const base = `${this.canvas.width || DEFAULT_WIDTH}×${this.canvas.height || DEFAULT_HEIGHT} · ${toolName} · ${this.brushSize}px · ${source} · ${mask} · ${layerName}`;
		this.status.textContent = message ? `${message} · ${base}` : base;
	}

	measureChromeHeight() {
		const domY = Number(this.node.__gjjQwenInpaintDomWidget?.y || 0);
		const toolbar = Math.ceil(this.toolbar?.offsetHeight || 32);
		const controls = Math.ceil(this.controls?.offsetHeight || 30);
		const layers = Math.ceil(this.layerPanel?.offsetHeight || 30);
		const prompt = Math.ceil(this.promptPanel?.offsetHeight || 0);
		const settings = Math.ceil(this.settingsPanel?.offsetHeight || 0);
		const status = Math.ceil(this.status?.offsetHeight || 16);
		return Math.max(130, domY + toolbar + controls + layers + prompt + settings + status + 42);
	}

	layout(updateNode = true) {
		const nodeWidth = Math.max(MIN_NODE_WIDTH, Math.round(Number(this.node.size?.[0] || DEFAULT_NODE_WIDTH)));
		const maxWidth = Math.max(300, nodeWidth - 24);
		const ratio = (this.canvas.height || DEFAULT_HEIGHT) / Math.max(1, this.canvas.width || DEFAULT_WIDTH);
		const chromeHeight = this.measureChromeHeight();
		const nodeHeight = Math.max(360, Number(this.node.size?.[1] || 0));
		const maxHeight = Math.max(220, nodeHeight - chromeHeight);
		const widthByHeight = Math.round(maxHeight / Math.max(0.0001, ratio));
		this.displayWidth = Math.max(220, Math.min(maxWidth, widthByHeight));
		this.displayHeight = Math.max(180, Math.round(this.displayWidth * ratio));
		this.canvas.style.width = `${this.displayWidth}px`;
		this.canvas.style.height = `${this.displayHeight}px`;
		this.canvasWrap.style.height = `${this.displayHeight}px`;
		if (updateNode) this.scheduleSize();
		this.renderStatus();
	}

	scheduleSize() {
		clearTimeout(this.sizeTimer);
		this.sizeTimer = setTimeout(() => {
			const minHeight = Math.ceil(this.measureChromeHeight() + 220);
			const desiredHeight = Math.max(minHeight, Math.ceil(this.measureChromeHeight() + this.displayHeight + 8));
			const currentHeight = Math.round(Number(this.node.size?.[1] || 0));
			const currentWidth = Math.max(MIN_NODE_WIDTH, Math.round(Number(this.node.size?.[0] || DEFAULT_NODE_WIDTH)));
			this.node.min_width = MIN_NODE_WIDTH;
			this.node.minWidth = MIN_NODE_WIDTH;
			if (Math.abs(currentHeight - desiredHeight) <= 8 && currentWidth >= MIN_NODE_WIDTH) return;
			this.node.__gjjQwenInpaintSizing = true;
			GJJ_Utils.refreshNode(this.node, {
				width: Math.max(currentWidth, MIN_NODE_WIDTH),
				height: desiredHeight,
				minWidth: MIN_NODE_WIDTH,
				minHeight,
			});
			this.node.__gjjQwenInpaintSizing = false;
		}, 0);
	}
}

function createContainer(node) {
	ensureStyles();
	const container = document.createElement("div");
	container.className = "gjj-qwen-inpaint";
	const domWidget = node.addDOMWidget?.(DOM_WIDGET, "GJJ 千问局部重绘画布", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (domWidget) {
		domWidget.computeSize = (width) => [
			Math.max(MIN_NODE_WIDTH, Math.round(Number(width || node.size?.[0] || DEFAULT_NODE_WIDTH))),
			Math.max(260, Math.ceil(container.scrollHeight || 520)),
		];
		domWidget.getHeight = () => Math.max(260, Math.ceil(container.scrollHeight || 520));
	}
	node.__gjjQwenInpaintDomWidget = domWidget;
	node.__gjjQwenInpaintContainer = container;
	return container;
}

function ensureEditor(node) {
	if (!node || node.__gjjQwenInpaintEditor) return;
	for (const name of HIDDEN_WIDGETS) collapseWidget(widget(node, name));
	if (node.properties?.[PROP_STATE] && !getWidgetValue(node, FIELD.data, "")) {
		setWidgetValue(node, FIELD.data, node.properties[PROP_STATE], false);
	}
	if (node.properties) delete node.properties[PROP_STATE];
	const container = node.__gjjQwenInpaintContainer || createContainer(node);
	node.__gjjQwenInpaintEditor = new QwenInpaintEditor(node, container);
	const savedSize = node.properties?.[PROP_NODE_SIZE];
	if (Array.isArray(savedSize)) {
		node.setSize?.([
			Math.max(MIN_NODE_WIDTH, Number(savedSize[0]) || DEFAULT_NODE_WIDTH),
			Math.max(420, Number(savedSize[1]) || 520),
		]);
	} else {
		node.setSize?.([
			Math.max(MIN_NODE_WIDTH, Number(node.size?.[0] || DEFAULT_NODE_WIDTH)),
			Math.max(520, Number(node.size?.[1] || 0)),
		]);
	}
	requestAnimationFrame(() => node.__gjjQwenInpaintEditor?.layout());
}

function scheduleEnsure(node, delay = 0) {
	clearTimeout(node.__gjjQwenInpaintTimer);
	node.__gjjQwenInpaintTimer = setTimeout(() => ensureEditor(node), delay);
}

function syncAllInpaintNodes(options = {}) {
	const nodes = (app.graph?._nodes || []).filter((node) => node?.comfyClass === TARGET || node?.type === TARGET);
	const mark = Boolean(options?.markGenerating);
	for (const node of nodes) {
		ensureEditor(node);
		const editor = node.__gjjQwenInpaintEditor;
		editor?.prepareQueue?.();
		if (mark && (node.__gjjQwenInpaintExplicitGenerate || nodes.length === 1)) {
			editor?.markGenerating?.(node.__gjjQwenInpaintExplicitGenerate ? "生成中" : "已提交生成");
		}
	}
}

app.registerExtension({
	name: "Comfy.GJJ.QwenInstantXInpaintCanvas",
	beforeQueuePrompt() {
		syncAllInpaintNodes({ markGenerating: true });
	},
	beforeQueued() {
		syncAllInpaintNodes({ markGenerating: true });
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
				this.__gjjQwenInpaintStateText = props[PROP_STATE];
				setWidgetValue(this, FIELD.data, props[PROP_STATE], false);
			}
			delete this.properties[PROP_STATE];
			if (Array.isArray(props[PROP_NODE_SIZE])) this.properties[PROP_NODE_SIZE] = props[PROP_NODE_SIZE];
			if (props[PROP_SETTINGS_OPEN] !== undefined) this.properties[PROP_SETTINGS_OPEN] = Boolean(props[PROP_SETTINGS_OPEN]);
			scheduleEnsure(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			this.__gjjQwenInpaintEditor?.syncState();
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				const stateText = getWidgetValue(this, FIELD.data, "");
				const compactState = compactStateForStorage(stateText);
				serializedNode.properties = serializedNode.properties || {};
				delete serializedNode.properties[PROP_STATE];
				setSerializedWidgetValue(this, serializedNode, FIELD.data, compactState);
				for (const name of Object.values(FIELD)) {
					if (name === FIELD.data) continue;
					setSerializedWidgetValue(this, serializedNode, name, getWidgetValue(this, name, ""));
				}
				serializedNode.properties[PROP_NODE_SIZE] = [
					Math.round(Number(this.size?.[0] || DEFAULT_NODE_WIDTH)),
					Math.round(Number(this.size?.[1] || 520)),
				];
				serializedNode.properties[PROP_SETTINGS_OPEN] = Boolean(this.properties?.[PROP_SETTINGS_OPEN]);
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjQwenInpaintSizing) {
				this.properties = this.properties || {};
				this.properties[PROP_NODE_SIZE] = [
					Math.round(Number(this.size?.[0] || DEFAULT_NODE_WIDTH)),
					Math.round(Number(this.size?.[1] || 520)),
				];
			}
			this.__gjjQwenInpaintEditor?.layout(false);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalOnExecuted?.apply(this, [message, ...args]);
			const editor = this.__gjjQwenInpaintEditor;
			const source = firstMessageValue(
				message?.source_image,
				message?.ui?.source_image,
				message?.output?.source_image,
				message?.result?.source_image,
			);
			const base = firstMessageValue(
				message?.base_image,
				message?.ui?.base_image,
				message?.output?.base_image,
				message?.result?.base_image,
			);
			const generated = firstMessageValue(
				message?.generated_image,
				message?.ui?.generated_image,
				message?.output?.generated_image,
				message?.result?.generated_image,
			);
			const generatedLayer = firstMessageValue(
				message?.generated_layer_image,
				message?.ui?.generated_layer_image,
				message?.output?.generated_layer_image,
				message?.result?.generated_layer_image,
			);
			const cacheSignature = firstMessageValue(
				message?.cache_signature,
				message?.ui?.cache_signature,
				message?.generation_signature,
				message?.ui?.generation_signature,
			);
			const imageSignature = firstMessageValue(message?.image_signature, message?.ui?.image_signature);
			const maskSignature = firstMessageValue(message?.mask_signature, message?.ui?.mask_signature);
			const generatedSignature = firstMessageValue(message?.generated_signature, message?.ui?.generated_signature);
			const cacheHit = String(firstMessageValue(message?.cache_hit, message?.ui?.cache_hit)).toLowerCase() === "true";
			if (generated) {
				if (base && editor?.hasImageLink?.()) {
					editor?.applySourceImage(base, { sync: false, invalidateCache: false, status: "" });
				}
				editor?.applyGeneratedImage(generated, {
					layerImage: generatedLayer,
					cacheSignature,
					imageSignature,
					maskSignature,
					generatedSignature,
					cacheHit,
				});
			} else {
				if (source && editor?.hasImageLink?.()) editor?.applySourceImage(source);
				editor?.finishGenerating?.("执行完成");
			}
			delete this.__gjjQwenInpaintExplicitGenerate;
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
	window.addEventListener("beforeunload", () => syncAllInpaintNodes());
}

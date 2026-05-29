import { app } from "/scripts/app.js";

const TARGET_NODE = "GJJ_WanVideoModelLoader";
const PANEL_WIDGET = "gjj_wanvideo_model_loader_panel";
const MODEL_WIDGETS = [
	"model",
	"base_precision",
	"quantization",
	"load_device",
	"vae_name",
	"vae_precision",
	"vae_use_cpu_cache",
	"clip_name",
	"clip_type",
	"clip_device",
	"clip_vision_name",
	"accel_lora_name",
	"accel_lora_strength",
];
const SEARCHABLE_WIDGETS = new Set([
	"model",
	"vae_name",
	"clip_name",
	"clip_vision_name",
	"accel_lora_name",
]);
let ACTIVE_GJJ_WANMODEL_POPUP = null;

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function valuesOf(widget) {
	return Array.isArray(widget?.options?.values) ? widget.options.values.map(String) : [];
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	let next = value;
	if (typeof widget.value === "number") {
		next = Number(value);
		if (!Number.isFinite(next)) next = 0;
	} else if (typeof widget.value === "boolean") {
		next = !!value;
	}
	if (widget.value === next) return;
	widget.value = next;
	widget.callback?.(next);
	app.graph?.setDirtyCanvas?.(true, true);
}

function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		element?.addEventListener?.(eventName, (event) => event.stopPropagation());
	}
}

function closeSearchPopup() {
	if (ACTIVE_GJJ_WANMODEL_POPUP?.remove) ACTIVE_GJJ_WANMODEL_POPUP.remove();
	ACTIVE_GJJ_WANMODEL_POPUP = null;
}

if (!window.__gjjWanModelClosePopupBound) {
	window.__gjjWanModelClosePopupBound = true;
	document.addEventListener("pointerdown", () => closeSearchPopup());
}

function hideNativeModelWidgets(node) {
	for (const name of MODEL_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		if (!widget.__gjjWanModelOriginals) {
			widget.__gjjWanModelOriginals = {
				type: widget.type,
				draw: widget.draw,
				computeSize: widget.computeSize,
				getHeight: widget.getHeight,
				mouse: widget.mouse,
				y: widget.y,
				last_y: widget.last_y,
			};
		}
		widget.hidden = true;
		widget.disabled = true;
		widget.type = `converted-widget:${widget.name || "hidden"}`;
		widget.options = widget.options || {};
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.y = -10000;
		widget.last_y = -10000;
		widget.computedHeight = 0;
		widget.size = [0, 0];
		for (const element of [widget.element, widget.inputEl, widget.widget]) {
			if (!element?.style) continue;
			element.style.display = "none";
			element.style.height = "0";
			element.style.margin = "0";
			element.style.padding = "0";
		}
	}
}

function optionList(widget) {
	const values = valuesOf(widget);
	const current = String(widget?.value ?? "");
	if (current && !values.includes(current)) {
		return [current, ...values];
	}
	return values.length ? values : [current || ""];
}

function splitWords(text) {
	return String(text || "").trim().toLowerCase().split(/[\s,，;；|]+/).filter(Boolean);
}

function makeNativeSelect(node, widgetName, title = "") {
	const widget = getWidget(node, widgetName);
	const select = document.createElement("select");
	select.className = "gjj-wanmodel-control";
	select.dataset.widgetName = widgetName;
	select.title = title || String(widget?.value ?? "");
	for (const value of optionList(widget)) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		select.appendChild(option);
	}
	select.value = String(widget?.value ?? "");
	select.addEventListener("change", () => {
		setWidgetValue(widget, select.value);
		select.title = select.value;
	});
	protect(select);
	return select;
}

function makeSearchableSelect(node, widgetName, title = "") {
	const widget = getWidget(node, widgetName);
	const values = optionList(widget);
	const box = document.createElement("div");
	box.className = "gjj-wanmodel-combo";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-wanmodel-combo-button";
	const text = document.createElement("span");
	text.className = "gjj-wanmodel-combo-text";
	const arrow = document.createElement("span");
	arrow.className = "gjj-wanmodel-combo-arrow";
	arrow.textContent = "⌄";
	button.append(text, arrow);
	box.appendChild(button);

	let optionValues = values.slice();
	let searchText = "";
	const setVisualValue = (value) => {
		const raw = String(value ?? "");
		text.textContent = raw || "未选择";
		button.title = title || raw || "未选择";
	};
	const setValue = (value) => {
		const next = String(value ?? "");
		setWidgetValue(widget, next);
		setVisualValue(next);
	};

	function openPopup() {
		closeSearchPopup();
		const rect = button.getBoundingClientRect();
		const popup = document.createElement("div");
		popup.className = "gjj-wanmodel-popup";
		popup.style.left = `${Math.round(rect.left)}px`;
		popup.style.top = `${Math.round(rect.bottom + 4)}px`;
		popup.style.width = `${Math.max(280, Math.round(rect.width))}px`;

		const input = document.createElement("input");
		input.className = "gjj-wanmodel-popup-search";
		input.placeholder = "输入关键词实时过滤";
		input.value = searchText;
		const listWrap = document.createElement("div");
		listWrap.className = "gjj-wanmodel-popup-list";

		const render = () => {
			searchText = input.value || "";
			const words = splitWords(searchText);
			const current = String(widget?.value ?? "");
			const shown = optionValues.filter((value) => {
				const hay = String(value || "").toLowerCase().replaceAll("\\", "/");
				return words.every((word) => hay.includes(word));
			}).slice(0, 180);
			listWrap.replaceChildren();
			if (!shown.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-wanmodel-popup-empty";
				empty.textContent = "没有匹配项";
				listWrap.appendChild(empty);
				return;
			}
			for (const value of shown) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-wanmodel-popup-item";
				if (current === value) item.classList.add("active");
				item.textContent = `${current === value ? "✓ " : ""}${value}`;
				item.title = value;
				item.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					setValue(value);
					closeSearchPopup();
				});
				listWrap.appendChild(item);
			}
		};

		input.addEventListener("input", render);
		for (const element of [popup, input, listWrap]) protect(element);
		popup.append(input, listWrap);
		document.body.appendChild(popup);
		ACTIVE_GJJ_WANMODEL_POPUP = popup;
		render();
		setTimeout(() => input.focus(), 0);
	}

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		optionValues = optionList(widget);
		openPopup();
	});
	protect(button);
	setVisualValue(widget?.value ?? values[0] ?? "");
	return box;
}

function makeSelect(node, widgetName, title = "") {
	if (SEARCHABLE_WIDGETS.has(widgetName)) {
		return makeSearchableSelect(node, widgetName, title);
	}
	return makeNativeSelect(node, widgetName, title);
}

function makeNumber(node, widgetName) {
	const widget = getWidget(node, widgetName);
	const input = document.createElement("input");
	input.className = "gjj-wanmodel-control";
	input.type = "number";
	input.value = String(widget?.value ?? 0);
	input.min = String(widget?.options?.min ?? -20);
	input.max = String(widget?.options?.max ?? 20);
	input.step = String(widget?.options?.step ?? 0.05);
	input.title = "加速 LoRA 强度";
	input.addEventListener("input", () => setWidgetValue(widget, input.value));
	protect(input);
	return input;
}

function makeCheckbox(node, widgetName, labelText) {
	const widget = getWidget(node, widgetName);
	const label = document.createElement("label");
	label.className = "gjj-wanmodel-check";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = !!widget?.value;
	input.addEventListener("change", () => setWidgetValue(widget, input.checked));
	const span = document.createElement("span");
	span.textContent = labelText;
	label.append(input, span);
	protect(label);
	return label;
}

function row(labelText, className, ...controls) {
	const item = document.createElement("div");
	item.className = `gjj-wanmodel-row ${className}`;
	const label = document.createElement("div");
	label.className = "gjj-wanmodel-label";
	label.textContent = labelText;
	item.append(label, ...controls);
	return item;
}

function panelHeight() {
	return 162;
}

function buildPanel(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-wanmodel-panel";
	const style = document.createElement("style");
	style.textContent = `
		.gjj-wanmodel-panel { box-sizing:border-box; display:flex; flex-direction:column; gap:4px; padding:0 16px 0 0; margin-left:-10px; }
		.gjj-wanmodel-panel * { box-sizing:border-box; }
		.gjj-wanmodel-row { display:grid; gap:6px; align-items:center; min-width:0; }
		.gjj-wanmodel-row.model { grid-template-columns:96px minmax(180px,1fr) 78px 138px 118px; }
		.gjj-wanmodel-row.vae { grid-template-columns:96px minmax(180px,1fr) 78px 96px; }
		.gjj-wanmodel-row.clip { grid-template-columns:96px minmax(180px,1fr) 118px 92px; }
		.gjj-wanmodel-row.vision { grid-template-columns:96px minmax(180px,1fr); }
		.gjj-wanmodel-row.lora { grid-template-columns:96px minmax(180px,1fr) 86px; }
		.gjj-wanmodel-label { color:#c4d0d3; font-size:12px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
		.gjj-wanmodel-control {
			width:100%; min-width:0; height:28px; padding:3px 8px; border:1px solid #344b54; border-radius:7px;
			background:#263036; color:#f2f5f5; outline:none; font-size:12px;
		}
		.gjj-wanmodel-control:focus { border-color:#5b8d9a; background:#1d2b31; }
		.gjj-wanmodel-combo { width:100%; min-width:0; position:relative; }
		.gjj-wanmodel-combo-button {
			width:100%; min-width:0; height:28px; display:flex; align-items:center; justify-content:space-between; gap:8px;
			padding:3px 8px; border:1px solid #344b54; border-radius:7px; background:#263036; color:#f2f5f5;
			outline:none; font-size:12px; text-align:left; cursor:pointer;
		}
		.gjj-wanmodel-combo-button:focus { border-color:#5b8d9a; background:#1d2b31; }
		.gjj-wanmodel-combo-text { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
		.gjj-wanmodel-combo-arrow { flex:0 0 auto; color:#9fb4ba; font-size:12px; }
		.gjj-wanmodel-check { width:100%; min-width:0; height:28px; display:flex; align-items:center; gap:5px; padding:3px 8px; border:1px solid #344b54; border-radius:7px; background:#263036; color:#f2f5f5; font-size:12px; white-space:nowrap; }
		.gjj-wanmodel-check input { width:14px; height:14px; margin:0; accent-color:#6ac7d8; }
		.gjj-wanmodel-popup {
			position:fixed; z-index:100000; max-height:340px; padding:6px; border:1px solid #42626c; border-radius:8px;
			background:#11181c; box-shadow:0 12px 28px rgba(0,0,0,.42); display:flex; flex-direction:column; gap:6px;
		}
		.gjj-wanmodel-popup-search {
			width:100%; height:34px; padding:5px 10px; border:1px solid #5f8fa0; border-radius:7px; background:#070b0d;
			color:#f4f8f9; outline:none; font-size:13px;
		}
		.gjj-wanmodel-popup-search:focus { border-color:#8cbad0; }
		.gjj-wanmodel-popup-list { max-height:286px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
		.gjj-wanmodel-popup-item {
			width:100%; min-height:28px; padding:5px 8px; border:0; border-radius:5px; background:transparent; color:#dce8eb;
			text-align:left; font-size:12px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; cursor:pointer;
		}
		.gjj-wanmodel-popup-item:hover, .gjj-wanmodel-popup-item.active { background:#26364d; color:#ffffff; }
		.gjj-wanmodel-popup-empty { padding:8px; color:#9fb4ba; font-size:12px; }
	`;
	wrap.appendChild(style);
	wrap.append(
		row("🟣 模型", "model", makeSelect(node, "model"), makeSelect(node, "base_precision"), makeSelect(node, "quantization"), makeSelect(node, "load_device")),
		row("🔴 VAE", "vae", makeSelect(node, "vae_name"), makeSelect(node, "vae_precision"), makeCheckbox(node, "vae_use_cpu_cache", "CPU缓存")),
		row("🟡 CLIP编码器", "clip", makeSelect(node, "clip_name"), makeSelect(node, "clip_type"), makeSelect(node, "clip_device")),
		row("🔵 CLIP视觉", "vision", makeSelect(node, "clip_vision_name")),
		row("🟠 加速LoRA", "lora", makeSelect(node, "accel_lora_name"), makeNumber(node, "accel_lora_strength")),
	);
	return wrap;
}

function ensurePanel(node) {
	if (!node || typeof node.addDOMWidget !== "function") return;
	if (!node.__gjjWanModelPanelWidget) {
		const panel = buildPanel(node);
		node.__gjjWanModelPanel = panel;
		const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", panel, { serialize: false, hideOnZoom: false });
		widget.computeSize = (width) => [Math.max(720, Number(width || node.size?.[0] || 720)), panelHeight()];
		widget.getHeight = () => panelHeight();
		node.__gjjWanModelPanelWidget = widget;
		const index = node.widgets?.indexOf(widget);
		if (index > 0) {
			node.widgets.splice(index, 1);
			node.widgets.unshift(widget);
		}
	} else if (node.__gjjWanModelPanel) {
		const next = buildPanel(node);
		node.__gjjWanModelPanel.replaceChildren(...Array.from(next.childNodes));
	}
}

function shrinkNodeToContent(node) {
	requestAnimationFrame(() => {
		const computed = node.computeSize?.() || node.size || [720, 240];
		const width = Math.max(720, Number(node.size?.[0] || computed[0] || 720));
		const height = Math.max(230, Number(computed[1] || 230));
		node.setSize?.([width, height]);
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	});
}

function stabilizeNode(node) {
	hideNativeModelWidgets(node);
	ensurePanel(node);
	shrinkNodeToContent(node);
	setTimeout(() => {
		hideNativeModelWidgets(node);
		shrinkNodeToContent(node);
	}, 80);
}

app.registerExtension({
	name: "Comfy.GJJ.WanVideoModelLoader",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		const origCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = origCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const origConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = origConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};
	},

	nodeCreated(node) {
		if (node.comfyClass !== TARGET_NODE) return;
		stabilizeNode(node);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET_NODE) {
				stabilizeNode(node);
			}
		}
	},
});

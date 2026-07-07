import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODE = "GJJ_Krea2ControlAIO";
const PANEL_WIDGET = "gjj_krea2_control_button_panel";
const SETTINGS_PROPERTY = "gjj_krea2_control_settings_open";
const SETTINGS_WIDGETS = ["lora_name", "strength"];
const BUTTON_WIDGETS = ["resize", "upscale_method", "crop", "channel_mode", "normalize", "invert", "batch_mode"];
const HIDDEN_WIDGETS = [...SETTINGS_WIDGETS, ...BUTTON_WIDGETS];
const OUTPUT_LABELS = ["模型", "控制潜空间", "编码控制图"];

const CONTROL_DEFS = [
	{
		name: "resize",
		icon: "📐",
		title: "尺寸",
		values: [
			{ value: "匹配潜空间尺寸", aliases: ["match_latent_size", "匹配 latent 尺寸"], label: "匹配" },
			{ value: "保持控制图尺寸", aliases: ["keep_control_image_size"], label: "原图" },
		],
	},
	{
		name: "upscale_method",
		icon: "🔍",
		title: "缩放",
		values: [
			{ value: "兰索斯", aliases: ["lanczos"], label: "兰索" },
			{ value: "双三次", aliases: ["bicubic"], label: "三次" },
			{ value: "双线性", aliases: ["bilinear"], label: "线性" },
			{ value: "区域", aliases: ["area"], label: "区域" },
			{ value: "最近邻精确", aliases: ["nearest-exact"], label: "最近" },
		],
	},
	{
		name: "crop",
		icon: "✂️",
		title: "裁剪",
		values: [
			{ value: "居中裁剪", aliases: ["center"], label: "居中" },
			{ value: "不裁剪", aliases: ["disabled"], label: "关闭" },
		],
	},
	{
		name: "channel_mode",
		icon: "🎨",
		title: "通道",
		values: [
			{ value: "RGB 彩色", aliases: ["rgb"], label: "彩色" },
			{ value: "灰度", aliases: ["grayscale"], label: "灰度" },
		],
	},
	{
		name: "normalize",
		icon: "⚖️",
		title: "归一化",
		values: [
			{ value: "不归一化", aliases: ["none"], label: "关闭" },
			{ value: "单图最小最大", aliases: ["per_image_minmax"], label: "单图" },
		],
	},
	{
		name: "invert",
		icon: "◐",
		title: "反相",
		values: [
			{ value: false, label: "正常" },
			{ value: true, label: "反相" },
		],
	},
	{
		name: "batch_mode",
		icon: "🖼️",
		title: "批次",
		values: [
			{ value: "独立图片", aliases: ["independent_images"], label: "图片" },
			{ value: "视频帧", aliases: ["video_frames"], label: "视频" },
		],
	},
];

const LABELS = {
	lora_name: "控制 LoRA",
	strength: "强度",
};

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function settingsOpen(node) {
	return Boolean(node?.properties?.[SETTINGS_PROPERTY]);
}

function stopEvent(event) {
	event?.preventDefault?.();
	event?.stopPropagation?.();
	event?.stopImmediatePropagation?.();
}

function keepEventLocal(event) {
	event?.stopPropagation?.();
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
	if (!widget || widget.__gjjKrea2ControlState) return;
	widget.options = widget.options || {};
	widget.__gjjKrea2ControlState = {
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
		size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
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
	widget.size = [0, 0];
	collapseElement(widget.element);
	collapseElement(widget.inputEl);
	collapseElement(widget.widget);
}

function showWidget(widget) {
	if (!widget) return;
	rememberWidget(widget);
	const state = widget.__gjjKrea2ControlState || {};
	widget.options = widget.options || {};
	widget.__gjjUtilsHidden = false;
	widget.hidden = false;
	widget.disabled = false;
	widget.type = state.type && !String(state.type).startsWith("converted-widget:") ? state.type : "text";
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
	if (state.size !== undefined) widget.size = Array.isArray(state.size) ? [...state.size] : state.size;
	widget.label = LABELS[widget.name] || state.label || widget.label || widget.name;
	widget.localized_name = widget.label;
	widget.options.display_name = widget.label;
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

function normalized(value) {
	return String(value ?? "").trim();
}

function optionIndex(def, value) {
	const current = normalized(value);
	const found = def.values.findIndex((item) => {
		if (typeof item.value === "boolean") return Boolean(value) === item.value;
		return normalized(item.value) === current || (item.aliases || []).some((alias) => normalized(alias) === current);
	});
	return found >= 0 ? found : 0;
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	widget.value = value;
	if (widget.inputEl) {
		if (widget.inputEl.type === "checkbox") widget.inputEl.checked = Boolean(value);
		else widget.inputEl.value = value;
	}
	widget.callback?.(value);
}

function updateControlButton(node, def) {
	const button = node?.__gjjKrea2ControlButtons?.[def.name];
	const widget = getWidget(node, def.name);
	if (!button || !widget) return;
	const index = optionIndex(def, widget.value);
	const item = def.values[index] || def.values[0];
	button.textContent = `${def.icon} ${item.label}`;
	button.title = `${def.title}：${item.value === true ? "开启" : item.value === false ? "关闭" : item.value}`;
	button.style.borderColor = item.value === true ? "#9cc7ff" : "#51606a";
	button.style.background = item.value === true ? "#25384c" : "#1b252c";
}

function updateSettingsButton(node) {
	const button = node?.__gjjKrea2SettingsButton;
	if (!button) return;
	button.textContent = "⚙️ 参数";
	button.title = "打开控制 LoRA 和强度浮动面板。";
	button.style.background = "#202a31";
	button.style.borderColor = "#51606a";
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

function applyVisibility(node) {
	if (!node || !Array.isArray(node.widgets)) return;
	for (const name of HIDDEN_WIDGETS) hideWidget(getWidget(node, name));
	for (const def of CONTROL_DEFS) updateControlButton(node, def);
	updateSettingsButton(node);
	forceRefresh(node);
}

function setSettingsOpen(node, open) {
	node.properties = node.properties || {};
	node.properties[SETTINGS_PROPERTY] = Boolean(open);
	applyVisibility(node);
}

function protectButton(button) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		button.addEventListener(eventName, keepEventLocal, true);
	}
}

function createSmallButton(text, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = text;
	button.title = title;
	button.style.cssText = [
		"height:26px",
		"border:1px solid #51606a",
		"border-radius:6px",
		"background:#1b252c",
		"color:#eef5f2",
		"font:700 11px system-ui,'Microsoft YaHei',sans-serif",
		"padding:0 7px",
		"cursor:pointer",
		"white-space:nowrap",
		"min-width:0",
	].join(";");
	protectButton(button);
	return button;
}

function widgetValues(widget) {
	const raw = widget?.options?.values || widget?.options?.comboValues || widget?.values || [];
	return Array.isArray(raw) ? raw.map((item) => String(item)) : [];
}

function closeFloatingPanel(node) {
	const panel = node?.__gjjKrea2FloatingPanel;
	if (!panel) return;
	panel.remove();
	node.__gjjKrea2FloatingPanel = null;
	node.__gjjKrea2FloatingBackdrop = null;
}

function styleFloatingInput(element) {
	element.style.cssText = [
		"width:100%",
		"height:30px",
		"box-sizing:border-box",
		"border:1px solid #51606a",
		"border-radius:6px",
		"background:#10181e",
		"color:#eef5f2",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
		"padding:0 8px",
		"outline:none",
	].join(";");
}

function addField(parent, labelText, field) {
	const row = document.createElement("label");
	row.style.cssText = "display:grid;grid-template-columns:68px minmax(0,1fr);align-items:center;gap:8px;color:#b9c4c8;font:12px system-ui,'Microsoft YaHei',sans-serif;";
	const label = document.createElement("span");
	label.textContent = labelText;
	label.style.cssText = "white-space:nowrap;";
	row.appendChild(label);
	row.appendChild(field);
	parent.appendChild(row);
}

function openFloatingPanel(node, event) {
	stopEvent(event);
	if (!node) return;
	if (node.__gjjKrea2FloatingPanel) {
		closeFloatingPanel(node);
		return;
	}

	const loraWidget = getWidget(node, "lora_name");
	const strengthWidget = getWidget(node, "strength");
	const backdrop = document.createElement("div");
	backdrop.style.cssText = "position:fixed;inset:0;z-index:9998;background:transparent;";
	const panel = document.createElement("div");
	panel.style.cssText = [
		"position:fixed",
		"z-index:9999",
		"width:min(360px,calc(100vw - 24px))",
		"box-sizing:border-box",
		"border:1px solid #6b7b86",
		"border-radius:8px",
		"background:#121b21",
		"box-shadow:0 18px 48px rgba(0,0,0,.45)",
		"padding:12px",
		"color:#eef5f2",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
	].join(";");

	const rect = event?.currentTarget?.getBoundingClientRect?.();
	const left = Math.min(Math.max(12, rect ? rect.left : window.innerWidth / 2 - 180), window.innerWidth - 372);
	const top = Math.min(Math.max(12, rect ? rect.bottom + 8 : window.innerHeight / 2 - 80), window.innerHeight - 190);
	panel.style.left = `${left}px`;
	panel.style.top = `${top}px`;

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;";
	const title = document.createElement("div");
	title.textContent = "参数";
	title.style.cssText = "font:700 13px system-ui,'Microsoft YaHei',sans-serif;color:#fff;";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "关闭";
	close.style.cssText = "height:26px;border:1px solid #51606a;border-radius:6px;background:#202a31;color:#eef5f2;font:700 12px system-ui,'Microsoft YaHei',sans-serif;padding:0 10px;cursor:pointer;";
	close.addEventListener("click", (closeEvent) => {
		stopEvent(closeEvent);
		closeFloatingPanel(node);
	}, true);
	header.appendChild(title);
	header.appendChild(close);
	panel.appendChild(header);

	const body = document.createElement("div");
	body.style.cssText = "display:grid;gap:9px;";
	const select = document.createElement("select");
	styleFloatingInput(select);
	const values = widgetValues(loraWidget);
	const currentLora = String(loraWidget?.value ?? "");
	for (const value of values.length ? values : [currentLora]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value || "未选择";
		select.appendChild(option);
	}
	select.value = currentLora;
	select.addEventListener("change", () => setWidgetValue(loraWidget, select.value));
	addField(body, "控制 LoRA", select);

	const strength = document.createElement("input");
	strength.type = "number";
	strength.step = "0.01";
	strength.min = "-100";
	strength.max = "100";
	strength.value = String(strengthWidget?.value ?? 1);
	styleFloatingInput(strength);
	strength.addEventListener("input", () => setWidgetValue(strengthWidget, Number(strength.value)));
	strength.addEventListener("change", () => setWidgetValue(strengthWidget, Number(strength.value)));
	addField(body, "强度", strength);
	panel.appendChild(body);

	backdrop.addEventListener("pointerdown", (backdropEvent) => {
		if (backdropEvent.target === backdrop) {
			stopEvent(backdropEvent);
			closeFloatingPanel(node);
		}
	}, true);
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
		panel.addEventListener(eventName, keepEventLocal);
	}
	document.body.appendChild(backdrop);
	backdrop.appendChild(panel);
	node.__gjjKrea2FloatingPanel = panel;
	node.__gjjKrea2FloatingBackdrop = backdrop;
	strength.focus();
}

function createPanel(node) {
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:5px;width:100%;box-sizing:border-box;overflow:hidden;padding:1px 0;";
	node.__gjjKrea2ControlButtons = node.__gjjKrea2ControlButtons || {};
	for (const def of CONTROL_DEFS) {
		const button = createSmallButton(def.icon, def.title);
		let lastClickAt = 0;
		const cycle = (event) => {
			event?.stopPropagation?.();
			const now = Date.now();
			if (now - lastClickAt < 120) return;
			lastClickAt = now;
			const widget = getWidget(node, def.name);
			if (!widget) return;
			const next = def.values[(optionIndex(def, widget.value) + 1) % def.values.length];
			setWidgetValue(widget, next.value);
			updateControlButton(node, def);
			forceRefresh(node);
		};
		button.addEventListener("pointerup", cycle, true);
		button.addEventListener("click", cycle, true);
		node.__gjjKrea2ControlButtons[def.name] = button;
		wrap.appendChild(button);
	}
	const settings = createSmallButton("⚙️ 参数", "显示控制 LoRA 和强度。");
	const openSettings = (event) => {
		const now = Date.now();
		if (now - Number(node.__gjjKrea2LastSettingsAt || 0) < 180) {
			stopEvent(event);
			return;
		}
		node.__gjjKrea2LastSettingsAt = now;
		openFloatingPanel(node, event);
	};
	settings.addEventListener("pointerup", openSettings, true);
	settings.addEventListener("click", openSettings, true);
	node.__gjjKrea2SettingsButton = settings;
	wrap.appendChild(settings);
	return wrap;
}

function ensurePanel(node) {
	if (node.__gjjKrea2ControlPanel || typeof node.addDOMWidget !== "function") return;
	const panel = createPanel(node);
	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", panel, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 260)), 60];
	}
	node.__gjjKrea2ControlPanel = widget || { element: panel };
}

function localizeWidgetLabels(node) {
	for (const [name, label] of Object.entries(LABELS)) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		widget.label = label;
		widget.localized_name = label;
		widget.options = widget.options || {};
		widget.options.display_name = label;
	}
}

function localizeSlots(node) {
	if (!node) return;
	const inputLabels = {
		model: "模型",
		control_image: "控制图",
		vae: "图像 VAE",
		latent: "潜空间",
	};
	for (const input of node.inputs || []) {
		const label = inputLabels[input?.name];
		if (!label) continue;
		input.label = label;
		input.localized_name = label;
	}
	for (let index = 0; index < OUTPUT_LABELS.length; index += 1) {
		const output = node.outputs?.[index];
		const label = OUTPUT_LABELS[index];
		if (!output || !label) continue;
		output.name = label;
		output.label = label;
		output.localized_name = label;
	}
}

function stabilize(node) {
	if (!node) return;
	localizeWidgetLabels(node);
	localizeSlots(node);
	ensurePanel(node);
	applyVisibility(node);
}

function scheduleStabilize(node) {
	for (const delay of [0, 40, 120, 300]) setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.Krea2ControlAIO",

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
		if (String(node?.comfyClass || node?.type || "") === TARGET_NODE) scheduleStabilize(node);
	},
});

import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_WanUnifiedVideoConditioning"]);
const MODE_WIDGET = "gjj_mode";
const PANEL_WIDGET = "gjj_wan_unified_mode_panel";
const TEMPLATE_PARAMS_NODE = "GJJ_TemplateParams";
const TEMPLATE_WIDGET = "template_text";
const VALUES_WIDGET = "values_json";
const SCHEMA_WIDGET = "schema_json";
const PARAM_ENABLED_PROPERTY = "gjj_wan_unified_template_params_enabled";
const PARAM_SOURCE_PROPERTY = "gjj_wan_unified_template_params_source";
const PARAM_WIDGETS = ["width", "height", "length"];
const MODE_PARAM_NAMES = ["wan_mode", "video_mode", "mode", "模式", "视频模式", "生成模式"];

const MODES = [
	{ value: "文生", label: "文生", title: "只输出空视频 latent，隐藏 VAE、图片和 CLIP 视觉接口。" },
	{ value: "图生", label: "图生", title: "使用起始图和起始图 CLIP 视觉条件，隐藏结束帧相关接口。" },
	{ value: "首尾帧", label: "首尾帧", title: "使用起始图、结束图和两端 CLIP 视觉条件。" },
];

const SOCKETS = {
	positive: {
		type: "CONDITIONING",
		label: "正向条件",
		localized_name: "正向条件",
		tooltip: "文生模式原样透传；图生和首尾帧模式会在其中写入图像条件。",
	},
	negative: {
		type: "CONDITIONING",
		label: "反向条件",
		localized_name: "反向条件",
		tooltip: "文生模式原样透传；图生和首尾帧模式会在其中写入图像条件。",
	},
	vae: {
		type: "VAE",
		label: "VAE",
		localized_name: "VAE",
		tooltip: "图生和首尾帧模式需要连接，用于把参考帧编码为视频条件；文生模式不使用。",
	},
	clip_vision_start_image: {
		type: "CLIP_VISION_OUTPUT",
		label: "起始图CLIP视觉条件",
		localized_name: "起始图CLIP视觉条件",
		tooltip: "图生模式使用的 CLIP 图像条件；首尾帧模式中代表起始图视觉条件。",
	},
	clip_vision_end_image: {
		type: "CLIP_VISION_OUTPUT",
		label: "结束图CLIP视觉条件",
		localized_name: "结束图CLIP视觉条件",
		tooltip: "仅首尾帧模式使用。连接后会与起始图 CLIP 视觉条件拼接。",
	},
	start_image: {
		type: "IMAGE",
		label: "起始图",
		localized_name: "起始图",
		tooltip: "图生视频首帧，或首尾帧模式的起始帧；会自动缩放到目标宽高。",
	},
	end_image: {
		type: "IMAGE",
		label: "结束图",
		localized_name: "结束图",
		tooltip: "仅首尾帧模式使用的结束帧；会自动缩放到目标宽高并写入末尾遮罩区域。",
	},
};

const SOCKET_ORDER = [
	"positive",
	"negative",
	"vae",
	"clip_vision_start_image",
	"clip_vision_end_image",
	"start_image",
	"end_image",
];

function markCanvasDirty() {
	app.graph?.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
}

function isTargetNode(node) {
	return TARGET_NODES.has(String(node?.comfyClass || node?.type || ""));
}

function normalizeMode(value) {
	const text = String(value || "").trim();
	if (text === "文生" || text === "文生视频" || text === "text_to_video" || text === "t2v") return "文生";
	if (text === "图生" || text === "图生视频" || text === "image_to_video" || text === "i2v") return "图生";
	if (text === "首尾帧" || text === "first_last" || text === "flf") return "首尾帧";
	return "首尾帧";
}

function findWidget(node, name) {
	return (node?.widgets || []).find((widget) => String(widget?.name || "") === name);
}

function getWidgetValue(node, name, fallback = "") {
	const widget = findWidget(node, name);
	return widget?.value ?? fallback;
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) return false;
	const next = String(value ?? "");
	widget.value = next;
	if (widget.inputEl) widget.inputEl.value = next;
	if (widget.element && "value" in widget.element) widget.element.value = next;
	widget.callback?.(next);
	return true;
}

function safeJsonParse(text, fallback) {
	try {
		const value = JSON.parse(String(text || ""));
		return value ?? fallback;
	} catch (_) {
		return fallback;
	}
}

function parseScalar(value) {
	if (typeof value !== "string") return value;
	const raw = value.trim();
	if (!raw) return "";
	const forced = raw.match(/^\s*(int|float|str|string|bool|boolean|json)\s*\(([\s\S]*)\)\s*$/i);
	if (forced) {
		const kind = forced[1].toLowerCase();
		const inner = forced[2].trim().replace(/^["']|["']$/g, "");
		if (kind === "int") return Math.trunc(Number.parseFloat(inner));
		if (kind === "float") return Number.parseFloat(inner);
		if (kind === "bool" || kind === "boolean") return /^(1|true|yes|on|是|真)$/i.test(inner);
		if (kind === "json") {
			try { return JSON.parse(forced[2].trim()); } catch (_) { return inner; }
		}
		return inner;
	}
	if (/^(true|yes|on|是|真)$/i.test(raw)) return true;
	if (/^(false|no|off|否|假)$/i.test(raw)) return false;
	if (/^[-+]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) || /^[-+]?\d+[eE][-+]?\d+$/.test(raw)) return Number.parseFloat(raw);
	return value;
}

function splitTemplateLine(line) {
	const raw = String(line || "").trim();
	if (!raw || raw.startsWith("#") || raw.startsWith("//") || raw.startsWith(";")) return null;
	const match = raw.match(/^([^:=：=]+?)\s*[:：=]\s*([\s\S]*)$/);
	if (!match) return null;
	let labelText = match[1].trim();
	labelText = labelText.replace(/\s*(?:\[[^\]]+?\]|【[^】]+?】)\s*$/, "").trim();
	let key = "";
	const explicit = labelText.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
	if (explicit) {
		labelText = explicit[1].trim();
		key = String(explicit[2] || "").split(/\s*(?:\||,|，|；|;|\bor\b|或)\s*/i)[0].trim();
	}
	let value = match[2].trim();
	const hashIndex = value.indexOf("#");
	if (hashIndex >= 0) value = value.slice(0, hashIndex).trim();
	return { key, label: labelText, value: parseScalar(value) };
}

function templateParamsState(templateNode) {
	const values = safeJsonParse(getWidgetValue(templateNode, VALUES_WIDGET, "{}"), {});
	const schema = safeJsonParse(getWidgetValue(templateNode, SCHEMA_WIDGET, "[]"), []);
	const entries = new Map();
	const addEntry = (key, value) => {
		const cleanKey = String(key || "").trim();
		if (!cleanKey) return;
		entries.set(cleanKey.toLowerCase(), value);
		entries.set(cleanKey, value);
	};

	if (Array.isArray(schema)) {
		for (const field of schema) {
			if (!field || typeof field !== "object") continue;
			const key = String(field.key || "").trim();
			const label = String(field.label || "").trim();
			const rawValue = values[key] ?? values[label] ?? field.default ?? "";
			const value = parseScalar(rawValue);
			addEntry(key, value);
			addEntry(label, value);
		}
	}

	const template = String(getWidgetValue(templateNode, TEMPLATE_WIDGET, "") || "");
	for (const line of template.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
		const parsed = splitTemplateLine(line);
		if (!parsed) continue;
		const rawValue = values[parsed.key] ?? values[parsed.label] ?? parsed.value;
		const value = parseScalar(rawValue);
		addEntry(parsed.key, value);
		addEntry(parsed.label, value);
	}

	for (const [key, value] of Object.entries(values || {})) {
		addEntry(key, parseScalar(value));
	}

	return entries;
}

function getParam(entries, names) {
	for (const name of names) {
		if (entries.has(name)) return entries.get(name);
		const lower = String(name || "").toLowerCase();
		if (entries.has(lower)) return entries.get(lower);
	}
	return undefined;
}

function asFiniteNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function alignTo16(value) {
	const number = Math.round(Number(value) || 0);
	return Math.max(16, Math.floor(number / 16) * 16);
}

function templateParamsNodes() {
	return (app.graph?._nodes || []).filter((node) => String(node?.comfyClass || node?.type || "") === TEMPLATE_PARAMS_NODE);
}

function templateNodeLabel(node) {
	const title = String(node?.title || "").trim();
	return title || `模板参数 #${node?.id ?? "?"}`;
}

function getTemplateParamsSourceNode(node) {
	const sourceId = String(node?.properties?.[PARAM_SOURCE_PROPERTY] || "").trim();
	if (!sourceId) return null;
	return (app.graph?._nodes || []).find((item) => String(item?.id ?? "") === sourceId) || null;
}

function paramsEnabled(node) {
	return Boolean(node?.properties?.[PARAM_ENABLED_PROPERTY] && node?.properties?.[PARAM_SOURCE_PROPERTY]);
}

function applyTemplateParams(targetNode, templateNode) {
	const entries = templateParamsState(templateNode);
	const width = asFiniteNumber(getParam(entries, ["width", "宽度"]));
	const height = asFiniteNumber(getParam(entries, ["height", "高度"]));
	const duration = asFiniteNumber(getParam(entries, ["duration", "时长"]));
	const fps = asFiniteNumber(getParam(entries, ["frame_rate", "fps", "帧率"]));
	const modeValue = getParam(entries, MODE_PARAM_NAMES);
	const missing = [];
	if (width == null) missing.push("width/宽度");
	if (height == null) missing.push("height/高度");
	if (duration == null) missing.push("duration/时长");
	if (fps == null) missing.push("frame_rate/fps/帧率");
	if (missing.length) {
		alert(`模板参数缺少：${missing.join("、")}`);
		return;
	}
	const length = Math.trunc(Math.floor((duration * fps) / 8) * 8 + 1);
	setWidgetValue(targetNode, "width", alignTo16(width));
	setWidgetValue(targetNode, "height", alignTo16(height));
	setWidgetValue(targetNode, "length", Math.max(1, length));
	if (modeValue !== undefined && String(modeValue || "").trim()) {
		setModeValueOnly(targetNode, normalizeMode(modeValue));
	}
	targetNode.properties ||= {};
	targetNode.properties[PARAM_SOURCE_PROPERTY] = String(templateNode?.id ?? "");
	markCanvasDirty();
	return true;
}

function collapseParamWidget(widget) {
	if (!widget || widget.__gjjWanUnifiedParamHidden) return;
	widget.__gjjWanUnifiedParamHidden = {
		type: widget.type,
		hidden: widget.hidden,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		y: widget.y,
		last_y: widget.last_y,
		optionsHidden: widget.options?.hidden,
		optionsDisplay: widget.options?.display,
	};
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.y = -100000;
	widget.last_y = -100000;
}

function restoreParamWidget(widget) {
	const saved = widget?.__gjjWanUnifiedParamHidden;
	if (!widget || !saved) return;
	widget.type = saved.type;
	widget.hidden = saved.hidden;
	widget.computeSize = saved.computeSize;
	widget.getHeight = saved.getHeight;
	widget.draw = saved.draw;
	widget.y = saved.y;
	widget.last_y = saved.last_y;
	widget.options ||= {};
	if (saved.optionsHidden === undefined) delete widget.options.hidden;
	else widget.options.hidden = saved.optionsHidden;
	if (saved.optionsDisplay === undefined) delete widget.options.display;
	else widget.options.display = saved.optionsDisplay;
	delete widget.__gjjWanUnifiedParamHidden;
}

function setParamsEnabled(node, enabled, sourceNode = null) {
	node.properties ||= {};
	if (enabled) {
		if (!sourceNode || !applyTemplateParams(node, sourceNode)) return false;
		node.properties[PARAM_ENABLED_PROPERTY] = true;
		node.properties[PARAM_SOURCE_PROPERTY] = String(sourceNode.id ?? "");
	} else {
		node.properties[PARAM_ENABLED_PROPERTY] = false;
		delete node.properties[PARAM_SOURCE_PROPERTY];
	}
	applyParamVisibility(node);
	refreshButtons(node);
	return true;
}

function syncActiveTemplateParams(node) {
	if (!paramsEnabled(node)) return false;
	const sourceNode = getTemplateParamsSourceNode(node);
	if (!sourceNode) return false;
	return applyTemplateParams(node, sourceNode);
}

function applyParamVisibility(node) {
	const active = paramsEnabled(node);
	if (active) syncActiveTemplateParams(node);
	for (const name of PARAM_WIDGETS) {
		const widget = findWidget(node, name);
		if (active) {
			removeInputByName(node, name);
			collapseParamWidget(widget);
		} else {
			restoreParamWidget(widget);
		}
	}
	const computed = node.computeSize?.();
	if (Array.isArray(computed)) {
		node.setSize?.([Math.round(node.size?.[0] || computed[0]), Math.round(computed[1])]);
	}
	markCanvasDirty();
}

function openParamsMenu(node, anchor) {
	const nodes = templateParamsNodes();
	if (!nodes.length && !paramsEnabled(node)) {
		alert("当前工作流里没有 GJJ_TemplateParams 节点。请先添加并设置宽度、高度、时长、帧率。");
		return;
	}
	const existing = document.querySelector(".gjj-wan-unified-param-menu");
	existing?.remove?.();
	const menu = document.createElement("div");
	menu.className = "gjj-wan-unified-param-menu";
	menu.style.cssText = [
		"position:fixed",
		"z-index:10000",
		"min-width:220px",
		"max-width:320px",
		"padding:6px",
		"border:1px solid #3e4d54",
		"border-radius:8px",
		"background:#10191d",
		"box-shadow:0 10px 28px rgba(0,0,0,.38)",
		"display:flex",
		"flex-direction:column",
		"gap:4px",
	].join(";");
	const rect = anchor?.getBoundingClientRect?.() || { left: 80, bottom: 80 };
	menu.style.left = `${Math.round(rect.left)}px`;
	menu.style.top = `${Math.round(rect.bottom + 4)}px`;
	if (paramsEnabled(node)) {
		const closeItem = document.createElement("button");
		closeItem.type = "button";
		closeItem.textContent = "⚡ 关闭参数联动";
		closeItem.title = "恢复本节点面板上的宽度、高度、帧数控件。";
		closeItem.style.cssText = [
			"width:100%",
			"text-align:left",
			"border:1px solid #5d4433",
			"border-radius:6px",
			"background:#2c2119",
			"color:#ffd9bd",
			"font-size:12px",
			"font-weight:700",
			"padding:7px 8px",
			"cursor:pointer",
		].join(";");
		closeItem.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			menu.remove();
			setParamsEnabled(node, false);
		});
		menu.appendChild(closeItem);
	}
	for (const templateNode of nodes) {
		const item = document.createElement("button");
		item.type = "button";
		item.textContent = `⚡ ${templateNodeLabel(templateNode)}`;
		item.title = "读取 width/宽度、height/高度、duration/时长、frame_rate/fps/帧率；宽高按原版 16 倍数对齐，帧数按 int((时长*帧率//8)*8+1) 写入。";
		item.style.cssText = [
			"width:100%",
			"text-align:left",
			"border:1px solid #2f424a",
			"border-radius:6px",
			"background:#172126",
			"color:#d8e6df",
			"font-size:12px",
			"font-weight:700",
			"padding:7px 8px",
			"cursor:pointer",
		].join(";");
		item.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			menu.remove();
			setParamsEnabled(node, true, templateNode);
		});
		menu.appendChild(item);
	}
	const close = (event) => {
		if (!menu.contains(event.target)) {
			menu.remove();
			window.removeEventListener("pointerdown", close, true);
		}
	};
	setTimeout(() => window.addEventListener("pointerdown", close, true), 0);
	document.body.appendChild(menu);
}

function hideBackingWidget(node) {
	const widget = findWidget(node, MODE_WIDGET);
	if (!widget || widget.__gjjWanUnifiedHidden) return;
	widget.__gjjWanUnifiedHidden = true;
	widget.hidden = true;
	widget.type = `converted-widget:${MODE_WIDGET}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.serialize = true;
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.y = -100000;
	widget.last_y = -100000;
}

function getMode(node) {
	return normalizeMode(findWidget(node, MODE_WIDGET)?.value || node?.properties?.gjj_wan_unified_mode);
}

function setModeValueOnly(node, mode) {
	const normalized = normalizeMode(mode);
	const widget = findWidget(node, MODE_WIDGET);
	if (widget) {
		widget.value = normalized;
		widget.callback?.(normalized);
	}
	node.properties ||= {};
	node.properties.gjj_wan_unified_mode = normalized;
	return normalized;
}

function setMode(node, mode) {
	setModeValueOnly(node, mode);
	applyMode(node);
}

function disconnectInput(node, index) {
	if (index < 0 || !node.inputs?.[index]) return;
	if (node.inputs[index].link != null) {
		node.disconnectInput?.(index);
	}
}

function removeInputByName(node, name) {
	const index = (node.inputs || []).findIndex((input) => String(input?.name || "") === name);
	if (index < 0) return;
	disconnectInput(node, index);
	node.removeInput?.(index);
}

function modeSocketNameFromInput(input) {
	const candidates = [
		input?.name,
		input?.label,
		input?.localized_name,
		input?.options?.display_name,
	].map((value) => String(value || "").trim()).filter(Boolean);
	for (const [name, info] of Object.entries(SOCKETS)) {
		if (candidates.includes(name) || candidates.includes(info.label) || candidates.includes(info.localized_name)) {
			return name;
		}
	}
	return "";
}

function applySocketInfo(input, name) {
	const info = SOCKETS[name];
	if (!input || !info) return;
	Object.assign(input, info);
	input.name = name;
	input.type = info.type;
	input.label = info.label;
	input.localized_name = info.localized_name;
	input.tooltip = info.tooltip;
	input.options ||= {};
	input.options.display_name = info.label;
	input.options.tooltip = info.tooltip;
	delete input.widget;
	delete input.widget_slot;
	delete input.widget_name;
	delete input.__convertedWidget;
}

function normalizeModeInputs(node) {
	for (const input of node.inputs || []) {
		const name = modeSocketNameFromInput(input);
		if (name) applySocketInfo(input, name);
	}
}

function ensureInput(node, name) {
	const info = SOCKETS[name];
	if (!info) return;
	let input = (node.inputs || []).find((item) => String(item?.name || "") === name);
	if (!input) {
		input = (node.inputs || []).find((item) => modeSocketNameFromInput(item) === name);
	}
	if (!input) {
		node.addInput?.(name, info.type);
		input = (node.inputs || []).find((item) => String(item?.name || "") === name);
	}
	applySocketInfo(input, name);
}

function decorateInputs(node) {
	for (const input of node.inputs || []) {
		const name = modeSocketNameFromInput(input);
		if (name) applySocketInfo(input, name);
	}
}

function reorderInputs(node) {
	if (!Array.isArray(node.inputs)) return;
	const rank = new Map(SOCKET_ORDER.map((name, index) => [name, index]));
	node.inputs.sort((a, b) => {
		const ar = rank.has(a?.name) ? rank.get(a.name) : 1000;
		const br = rank.has(b?.name) ? rank.get(b.name) : 1000;
		return ar - br;
	});
	node.inputs.forEach((input, index) => {
		input.slot_index = index;
	});
}

function visibleSocketsForMode(mode) {
	if (mode === "文生") return ["positive", "negative"];
	if (mode === "图生") return ["positive", "negative", "vae", "clip_vision_start_image", "start_image"];
	return Object.keys(SOCKETS);
}

function getGraphLink(node, linkId) {
	const links = node?.graph?.links || app.graph?.links;
	if (!links || linkId == null) return null;
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId));
	return links[linkId] || null;
}

function inputLinks(input) {
	if (!input) return [];
	if (Array.isArray(input.link)) return input.link;
	return input.link == null ? [] : [input.link];
}

function setLinkDimmed(node, input, dimmed) {
	for (const linkId of inputLinks(input)) {
		const link = getGraphLink(node, linkId);
		if (!link) continue;
		if (dimmed) {
			if (link.__gjjWanUnifiedOriginalColor === undefined) {
				link.__gjjWanUnifiedOriginalColor = link.color ?? null;
			}
			link.color = "#60666a";
		} else if (link.__gjjWanUnifiedOriginalColor !== undefined) {
			if (link.__gjjWanUnifiedOriginalColor === null) delete link.color;
			else link.color = link.__gjjWanUnifiedOriginalColor;
			delete link.__gjjWanUnifiedOriginalColor;
		}
	}
}

function applyDisabledSockets(node, visibleNames) {
	const visible = new Set(visibleNames);
	const paramMode = paramsEnabled(node);
	for (const input of node.inputs || []) {
		const name = String(input?.name || "");
		if (!(name in SOCKETS)) continue;
		const disabled = paramMode && !visible.has(name);
		input.disabled = disabled;
		input.color_on = disabled ? "#687076" : undefined;
		input.color_off = disabled ? "#454b50" : undefined;
		input.gjj_disabled = disabled;
		input.label = disabled ? `${SOCKETS[name].label}（禁用）` : SOCKETS[name].label;
		input.localized_name = input.label;
		setLinkDimmed(node, input, disabled);
	}
}

function applyMode(node) {
	if (!isTargetNode(node)) return;
	hideBackingWidget(node);
	normalizeModeInputs(node);
	const mode = getMode(node);
	const visibleNames = visibleSocketsForMode(mode);
	const visible = new Set(visibleNames);
	const keepAllSockets = paramsEnabled(node);
	for (const name of Object.keys(SOCKETS)) {
		if (visible.has(name) || keepAllSockets) {
			ensureInput(node, name);
		} else {
			removeInputByName(node, name);
		}
	}
	decorateInputs(node);
	reorderInputs(node);
	applyParamVisibility(node);
	applyDisabledSockets(node, visibleNames);
	refreshButtons(node);
	const computed = node.computeSize?.();
	if (Array.isArray(computed)) {
		node.setSize?.([Math.round(node.size?.[0] || computed[0]), Math.round(computed[1])]);
	}
	markCanvasDirty();
}

function refreshButtons(node) {
	const state = node.__gjjWanUnifiedModePanel;
	if (!state) return;
	const mode = getMode(node);
	for (const button of state.buttons || []) {
		const active = button.dataset.mode === mode;
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", active ? "true" : "false");
	}
	if (state.paramsButton) {
		const active = paramsEnabled(node);
		const sourceNode = getTemplateParamsSourceNode(node);
		state.paramsButton.classList.toggle("active", active);
		state.paramsButton.setAttribute("aria-pressed", active ? "true" : "false");
		state.paramsButton.textContent = active ? "⚡参" : "⚡参";
		state.paramsButton.title = active
			? `已启用参数联动：${sourceNode ? templateNodeLabel(sourceNode) : "来源缺失"}。点击可更换来源或关闭。`
			: "从 GJJ_TemplateParams 读取 width/宽度、height/高度、duration/时长、frame_rate/fps/帧率，可选读取 wan_mode/video_mode/模式；宽高按原版 16 倍数对齐，帧数按 int((时长*帧率//8)*8+1) 设置。";
	}
}

function addModePanel(node) {
	if (!isTargetNode(node) || node.__gjjWanUnifiedModePanel || typeof node.addDOMWidget !== "function") return;

	const root = document.createElement("div");
	root.className = "gjj-wan-unified-mode-panel";
	root.style.cssText = [
		"display:flex",
		"gap:4px",
		"padding:3px 0 2px",
		"box-sizing:border-box",
		"width:100%",
	].join(";");

	const buttons = MODES.map((mode) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = mode.label;
		button.title = mode.title;
		button.dataset.mode = mode.value;
		button.style.cssText = [
			"flex:1 1 0",
			"min-width:0",
			"height:26px",
			"border:1px solid #3e4d54",
			"border-radius:5px",
			"background:#172126",
			"color:#d8e6df",
			"font-size:11px",
			"font-weight:700",
			"cursor:pointer",
			"white-space:nowrap",
			"padding:0 3px",
		].join(";");
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setMode(node, mode.value);
		});
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		root.appendChild(button);
		return button;
	});

	const paramsButton = document.createElement("button");
	paramsButton.type = "button";
	paramsButton.textContent = "⚡参数";
	paramsButton.title = "从 GJJ_TemplateParams 读取 width/宽度、height/高度、duration/时长、frame_rate/fps/帧率，可选读取 wan_mode/video_mode/模式；宽高按原版 16 倍数对齐，帧数按 int((时长*帧率//8)*8+1) 设置。";
	paramsButton.style.cssText = [
		"flex:0.9 1 0",
		"min-width:0",
		"height:26px",
		"border:1px solid #44565f",
		"border-radius:5px",
		"background:#202b31",
		"color:#dce7e2",
		"font-size:11px",
		"font-weight:700",
		"cursor:pointer",
		"white-space:nowrap",
		"padding:0 3px",
	].join(";");
	paramsButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openParamsMenu(node, paramsButton);
	});
	paramsButton.addEventListener("pointerdown", (event) => event.stopPropagation());
	root.appendChild(paramsButton);

	const style = document.createElement("style");
	style.textContent = `
		.gjj-wan-unified-mode-panel button.active {
			background: #1f6f4a !important;
			border-color: #55c685 !important;
			color: #f3fff7 !important;
		}
		.gjj-wan-unified-mode-panel button:hover {
			border-color: #78a897 !important;
		}
		.gjj-wan-unified-mode-panel button[aria-pressed="true"] {
			box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
		}
	`;
	root.appendChild(style);

	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getValue: () => getMode(node),
		setValue: (value) => setMode(node, value),
	});
	widget.computeSize = (width) => [Math.round(width || node.size?.[0] || 320), 32];
	widget.getHeight = () => 32;
	node.__gjjWanUnifiedModePanel = { widget, buttons, paramsButton };
}

function patchNode(node) {
	if (!isTargetNode(node)) return;
	addModePanel(node);
	const widget = findWidget(node, MODE_WIDGET);
	if (widget && node?.properties?.gjj_wan_unified_mode) {
		widget.value = normalizeMode(node.properties.gjj_wan_unified_mode);
	}
	syncActiveTemplateParams(node);
	applyMode(node);
}

function schedulePatch(node) {
	patchNode(node);
	requestAnimationFrame(() => patchNode(node));
	setTimeout(() => patchNode(node), 120);
	setTimeout(() => patchNode(node), 400);
}

app.registerExtension({
	name: "GJJ.WanUnifiedVideoConditioning",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedulePatch(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			schedulePatch(this);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (info, ...args) {
			const result = originalOnSerialize?.apply(this, [info, ...args]);
			info.properties ||= {};
			info.properties.gjj_wan_unified_mode = getMode(this);
			info.properties[PARAM_ENABLED_PROPERTY] = paramsEnabled(this);
			if (this.properties?.[PARAM_SOURCE_PROPERTY]) {
				info.properties[PARAM_SOURCE_PROPERTY] = String(this.properties[PARAM_SOURCE_PROPERTY]);
			}
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			schedulePatch(node);
		}
		if (!window.__gjjWanUnifiedTemplateParamListener) {
			window.__gjjWanUnifiedTemplateParamListener = true;
			window.addEventListener("gjj-template-params-updated", () => {
				for (const node of app.graph?._nodes || []) {
					if (isTargetNode(node) && paramsEnabled(node)) {
						syncActiveTemplateParams(node);
						applyParamVisibility(node);
					}
				}
			});
		}
	},
});

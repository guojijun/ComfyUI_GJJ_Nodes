import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

// ───────────────────────── 常量 ─────────────────────────
const TARGET_NODES = new Set([
	"GJJ_RelayVSRVideoUpscaler",
]);
const STATUS_WIDGET_NAME = "gjj_relayvsr_status";
const COMPACT_PANEL_HEIGHT = 40;
// 与 py 的 UI_PARAMETER_ORDER 必须完全一致（15 个 widget）。
const PARAM_ORDER = [
	"unet_name",
	"vae_name",
	"steps",
	"cfg",
	"seed",
	"sampler_name",
	"scheduler",
	"detail",
	"weight_dtype",
	"bit_depth",
	"color_space",
	"chroma_subsampling",
	"codec",
	"scale",
	"video_file",
];
const RESTORE_WIDGET_TYPES = {
	unet_name: "combo",
	vae_name: "combo",
	steps: "number",
	cfg: "number",
	seed: "number",
	sampler_name: "combo",
	scheduler: "combo",
	detail: "number",
	weight_dtype: "combo",
	bit_depth: "combo",
	color_space: "combo",
	chroma_subsampling: "combo",
	codec: "combo",
	scale: "combo",
	video_file: "text",
};
const MODEL_COMBO_NAMES = ["unet_name", "vae_name"];
// 家族过滤关键词（单一配置源，与后端 MODEL_KEYWORD 对应），模型树通用过滤逻辑复用。
const MODEL_KEYWORD = "relayvsr";
const PANEL_GROUPS = {
	seed: { title: "🎲 种子", names: ["seed"] },
	model: { title: "🧠 RelayVSR 模型树", names: [] },
	sample: {
		title: "🎛️ 采样参数",
		names: ["steps", "cfg", "seed", "sampler_name", "scheduler", "detail", "weight_dtype"],
	},
	video: {
		title: "🎞️ 视频输出参数",
		names: ["bit_depth", "color_space", "chroma_subsampling", "codec"],
	},
};
const DICE_OFF_COLOR = "#4a4f5c";
const DICE_ON_COLOR = "#0f8a52";
const SCALE_BUTTON_OFF_COLOR = "#2a3138";
const SCALE_BUTTON_ON_COLOR = "#1f7a4d";

// ───────────────────────── 基础工具 ─────────────────────────
function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function orderedParamValues(node) {
	return PARAM_ORDER.map((name) => getWidget(node, name)?.value);
}

function syncOrderedWidgetValues(node) {
	if (!node) return;
	node.widgets_values = orderedParamValues(node);
}

function applyOrderedWidgetValues(node, values) {
	if (!node || !Array.isArray(values)) return;
	for (let index = 0; index < PARAM_ORDER.length; index += 1) {
		if (index >= values.length) break;
		const widget = getWidget(node, PARAM_ORDER[index]);
		if (!widget) continue;
		widget.value = values[index];
		try {
			widget.callback?.(widget.value);
		} catch (_) {}
	}
	syncOrderedWidgetValues(node);
}

// 形参还原：按键名从 widgets_values_named 取值，彻底不依赖控件位置。
function applyNamedWidgetValues(node, named) {
	if (!node || !named || typeof named !== "object") return false;
	let applied = 0;
	for (const name of Object.keys(named)) {
		if (!PARAM_ORDER.includes(name)) continue;
		const widget = getWidget(node, name);
		if (!widget) continue;
		widget.value = named[name];
		try {
			widget.callback?.(widget.value);
		} catch (_) {}
		applied += 1;
	}
	if (applied > 0) syncOrderedWidgetValues(node);
	return applied > 0;
}

// 保证模型 combo 候选始终包含当前值，避免启动时序下被核心误判缺失。
function ensureModelComboValues(node) {
	if (!node) return;
	for (const name of MODEL_COMBO_NAMES) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		widget.options = widget.options || {};
		let values = widget.options.values;
		if (typeof values === "function") values = values(widget);
		if (!Array.isArray(values)) values = [];
		const current = widget.value;
		if (current != null && String(current).trim() && !values.includes(current)) {
			values.push(current);
		}
		widget.options.values = values;
	}
}

// 启动后自动重跑核心“缺失模型”扫描，消除加载时序误报。
function scheduleStartupModelRescan(node) {
	if (!node || node.__gjjRelayVsrRescanScheduled) return;
	node.__gjjRelayVsrRescanScheduled = true;
	const rescan = async () => {
		try {
			ensureModelComboValues(node);
			if (typeof app?.refreshMissingModels === "function") {
				await app.refreshMissingModels({ silent: true, reloadDefs: false });
			}
		} catch (error) {
			console.warn("[GJJ][RelayVSR] 启动后重扫缺失模型失败:", error);
		}
	};
	setTimeout(rescan, 300);
	setTimeout(rescan, 1000);
}

function writePromptInputsFromWidgets(node, promptData) {
	const promptNode = promptData?.prompt?.[String(node?.id)] || promptData?.prompt?.[node?.id];
	if (!promptNode?.inputs) return;
	for (const name of PARAM_ORDER) {
		const widget = getWidget(node, name);
		if (widget) promptNode.inputs[name] = widget.value;
	}
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = value;
	try {
		widget.callback?.(value);
	} catch (_) {}
	if (Array.isArray(node.widgets_values)) {
		const index = PARAM_ORDER.indexOf(name);
		if (index >= 0) node.widgets_values[index] = value;
	}
	syncOrderedWidgetValues(node);
	node.graph && (node.graph._version += 1);
	refreshNode(node);
}

// ───────────────────────── 控件显隐（py 声明 / js 管理） ─────────────────────────
function rememberWidgetState(widget) {
	if (!widget || widget.__gjjRelayVsrVisibilityState) return;
	widget.options = widget.options || {};
	widget.__gjjRelayVsrVisibilityState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		label: widget.label,
		localized_name: widget.localized_name,
		optionsHidden: widget.options.hidden,
		optionsDisplay: widget.options.display,
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
		widgetDisplay: widget.widget?.style?.display || "",
	};
}

function setWidgetHidden(widget, hidden) {
	if (!widget) return;
	rememberWidgetState(widget);
	widget.options = widget.options || {};
	const state = widget.__gjjRelayVsrVisibilityState || {};
	if (hidden) {
		widget.hidden = true;
		widget.disabled = true;
		widget.type = "hidden";
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.computeSize = () => [0, -4];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.label = "";
		widget.localized_name = "";
		widget.last_y = 0;
		widget.computedHeight = 0;
		widget.margin_top = 0;
		if (widget.element) widget.element.style.display = "none";
		if (widget.inputEl) widget.inputEl.style.display = "none";
		if (widget.widget) widget.widget.style.display = "none";
		return;
	}
	widget.hidden = Boolean(state.hidden);
	widget.disabled = Boolean(state.disabled);
	widget.type = state.type && state.type !== "hidden"
		? state.type
		: (RESTORE_WIDGET_TYPES[widget.name] || state.type || "text");
	if (state.computeSize) widget.computeSize = state.computeSize;
	else delete widget.computeSize;
	if (state.getHeight) widget.getHeight = state.getHeight;
	else delete widget.getHeight;
	if (state.draw) widget.draw = state.draw;
	else delete widget.draw;
	if (state.mouse) widget.mouse = state.mouse;
	else delete widget.mouse;
	widget.label = state.label ?? widget.label;
	widget.localized_name = state.localized_name ?? widget.localized_name;
	if (state.optionsHidden === undefined) delete widget.options.hidden;
	else widget.options.hidden = state.optionsHidden;
	if (state.optionsDisplay === undefined) delete widget.options.display;
	else widget.options.display = state.optionsDisplay;
	if (widget.element) widget.element.style.display = state.elementDisplay || "";
	if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
	if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
}

// 默认折叠全部功能参数（真实 widget 继续承载数值与序列化），交互交给浮动面板。
function hideParameterWidgets(node) {
	for (const name of PARAM_ORDER) {
		setWidgetHidden(getWidget(node, name), true);
	}
	// 折叠功能参数之外的游离原生控件（典型：seed 的 control_after_generate），
	// 避免核心缺失模型扫描扫到被错位污染的附属 combo。本节点 DOM 控件除外。
	const domNames = new Set([STATUS_WIDGET_NAME]);
	for (const widget of node.widgets || []) {
		if (!widget || domNames.has(widget.name)) continue;
		if (widget.type === "hidden") continue;
		setWidgetHidden(widget, true);
	}
}

function restoreParameterWidgetOrder(node) {
	if (!node || !Array.isArray(node.widgets)) return;
	const ordered = [];
	const used = new Set();
	for (const name of PARAM_ORDER) {
		const widget = getWidget(node, name);
		if (widget && !used.has(widget)) {
			ordered.push(widget);
			used.add(widget);
		}
	}
	for (const widget of node.widgets) {
		if (!used.has(widget)) {
			ordered.push(widget);
			used.add(widget);
		}
	}
	node.widgets = ordered;
}

function placeToolbarFirst(node) {
	const status = node?.__gjjRelayVsrStatus?.widget;
	if (!status || !Array.isArray(node.widgets)) return;
	const rest = node.widgets.filter((widget) => widget !== status);
	node.widgets = [status, ...rest];
}

function scheduleToolbarFirst(node) {
	const move = () => {
		placeToolbarFirst(node);
		refreshNode(node);
	};
	requestAnimationFrame?.(move);
	setTimeout(move, 0);
}

// 节点高度按内容自然计算，不写死固定高度。
function fitNodeToContent(node) {
	if (!node) return;
	const natural = node.computeSize?.();
	const naturalHeight = Array.isArray(natural) ? Number(natural[1]) : NaN;
	const fallbackWidth = Array.isArray(natural) ? Number(natural[0]) : 360;
	const width = Math.max(360, Number(node.size?.[0] || fallbackWidth || 360));
	const height = Number.isFinite(naturalHeight)
		? Math.max(COMPACT_PANEL_HEIGHT + 30, naturalHeight)
		: (Number(node.size?.[1]) || 120);
	node.size = [width, height];
	node.setSize?.([width, height]);
	refreshNode(node);
}

function scheduleFitNodeToContent(node) {
	fitNodeToContent(node);
	requestAnimationFrame?.(() => fitNodeToContent(node));
	setTimeout(() => fitNodeToContent(node), 0);
}

function patchPromptData(promptData) {
	const nodes = app.graph?._nodes || [];
	for (const node of nodes) {
		if (!node || !TARGET_NODES.has(String(node.comfyClass || node.type || ""))) continue;
		syncOrderedWidgetValues(node);
		writePromptInputsFromWidgets(node, promptData);
	}
	return promptData;
}

function installGraphToPromptPatch() {
	if (app.__gjjRelayVsrGraphToPromptPatched || typeof app.graphToPrompt !== "function") return;
	app.__gjjRelayVsrGraphToPromptPatched = true;
	const originalGraphToPrompt = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		const result = await originalGraphToPrompt(...args);
		return patchPromptData(result);
	};
}

// ───────────────────────── 浮动面板 ─────────────────────────
function protectPanelEvents(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	element.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
}

function floatingPanelStyle() {
	return [
		"position:fixed",
		"z-index:900",
		"width:min(440px, calc(100vw - 28px))",
		"max-height:min(560px, calc(100vh - 32px))",
		"overflow:auto",
		"display:none",
		"flex-direction:column",
		"gap:8px",
		"padding:10px",
		"box-sizing:border-box",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#10171b",
		"color:#dce7e2",
		"box-shadow:0 16px 42px rgba(0,0,0,.45)",
		"pointer-events:auto",
	].join(";");
}

function createFloatingPanel(node, key) {
	const config = PANEL_GROUPS[key];
	if (!config) return null;
	const panel = document.createElement("div");
	panel.className = `gjj-relayvsr-floating-panel gjj-relayvsr-${key}-panel`;
	panel.style.cssText = floatingPanelStyle();
	protectPanelEvents(panel);

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;position:sticky;top:0;background:#10171b;padding-bottom:4px;z-index:1";
	const title = document.createElement("div");
	title.textContent = config.title;
	title.style.cssText = "font-size:13px;font-weight:700;color:#f2faf7";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	close.style.cssText = "width:26px;height:24px;border:1px solid #41535b;border-radius:6px;background:#1a2328;color:#dce7e2;cursor:pointer";
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setPanelOpen(node, key, false);
	});
	header.append(title, close);

	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:8px";
	panel.append(header, body);
	document.body.appendChild(panel);
	return { panel, body, key };
}

function ensureFloatingPanels(node) {
	node.__gjjRelayVsrPanels ||= {};
	for (const key of Object.keys(PANEL_GROUPS)) {
		if (!node.__gjjRelayVsrPanels[key]) {
			node.__gjjRelayVsrPanels[key] = createFloatingPanel(node, key);
		}
	}
	return node.__gjjRelayVsrPanels;
}

function panelOpenKey(node) {
	return String(node?.properties?.gjj_relayvsr_open_panel || "");
}

function setPanelOpen(node, key, open) {
	node.properties ||= {};
	node.properties.gjj_relayvsr_open_panel = open ? key : "";
	syncFloatingPanels(node);
}

function positionFloatingPanel(node, panel, anchor) {
	if (!panel) return;
	const rect = anchor?.getBoundingClientRect?.();
	const width = Math.min(440, Math.max(320, window.innerWidth - 28));
	const left = Math.min(window.innerWidth - width - 14, Math.max(14, rect?.left || 80));
	const top = Math.min(window.innerHeight - 120, Math.max(14, (rect?.bottom || 80) + 6));
	panel.style.width = `${width}px`;
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(top)}px`;
}

function removeFloatingPanels(node) {
	for (const panelInfo of Object.values(node?.__gjjRelayVsrPanels || {})) {
		panelInfo?.panel?.remove?.();
	}
	node.__gjjRelayVsrPanels = {};
}

function positionOpenFloatingPanels(node) {
	const panels = node?.__gjjRelayVsrPanels;
	const openKey = panelOpenKey(node);
	const panelInfo = panels?.[openKey];
	if (!panelInfo?.panel || panelInfo.panel.style.display === "none") return;
	positionFloatingPanel(node, panelInfo.panel, node.__gjjRelayVsrButtons?.[openKey]);
}

function positionAllOpenFloatingPanels() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(String(node?.comfyClass || node.type || ""))) {
			positionOpenFloatingPanels(node);
		}
	}
}

function installWindowPositionHandlers() {
	if (app.__gjjRelayVsrWindowHandlersInstalled || typeof window === "undefined") return;
	app.__gjjRelayVsrWindowHandlersInstalled = true;
	window.addEventListener("resize", positionAllOpenFloatingPanels);
	window.addEventListener("scroll", positionAllOpenFloatingPanels, true);
}

// ───────────────────────── 面板镜像控件 ─────────────────────────
function widgetLabel(widget, fallback) {
	return String(widget?.options?.display_name || widget?.label || widget?.localized_name || widget?.name || fallback || "");
}

function widgetChoices(widget) {
	const values = widget?.options?.values || widget?.options?.items || widget?.values;
	return Array.isArray(values) ? values : [];
}

function createFloatingControl(node, name) {
	const widget = getWidget(node, name);
	if (!widget) return null;
	const row = document.createElement("label");
	row.dataset.widgetName = name;
	row.style.cssText = "display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:8px";

	const label = document.createElement("span");
	label.textContent = widgetLabel(widget, name);
	label.title = widget?.options?.tooltip || "";
	label.style.cssText = "font-size:12px;color:#aebfbd;line-height:1.25";

	const choices = widgetChoices(widget);
	let input;
	if (choices.length) {
		input = document.createElement("select");
		for (const value of choices) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			input.appendChild(option);
		}
	} else if (typeof widget.value === "boolean") {
		input = document.createElement("input");
		input.type = "checkbox";
	} else {
		input = document.createElement("input");
		input.type = typeof widget.value === "number" ? "number" : "text";
		if (input.type === "number") {
			if (widget.options?.min != null) input.min = String(widget.options.min);
			if (widget.options?.max != null) input.max = String(widget.options.max);
			if (widget.options?.step != null) input.step = String(widget.options.step);
		}
	}
	input.title = widget?.options?.tooltip || "";
	input.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"min-height:28px",
		"border:1px solid rgba(255,255,255,.1)",
		"border-radius:6px",
		"background:#2d3034",
		"color:#eef5f1",
		"font:12px/1.35 sans-serif",
		"padding:5px 7px",
		"outline:none",
	].join(";");

	const readInputValue = () => {
		if (input.type === "checkbox") return input.checked;
		if (input.type === "number") return Number(input.value);
		return input.value;
	};
	const refresh = () => {
		if (input.type === "checkbox") input.checked = !!widget.value;
		else input.value = widget.value ?? "";
	};
	input.addEventListener("change", () => setWidgetValue(node, name, readInputValue()));
	if (input.type !== "checkbox") {
		input.addEventListener("blur", () => setWidgetValue(node, name, readInputValue()));
	}
	row.__gjjRefresh = refresh;
	row.append(label, input);
	refresh();
	return row;
}

function appendPanelHint(body, text, warn = false) {
	const hint = document.createElement("div");
	hint.textContent = text;
	hint.style.cssText = [
		"font-size:12px",
		"line-height:1.35",
		"padding:6px 8px",
		"border-radius:6px",
		warn
			? "background:rgba(255,160,90,.12);color:#ffc99a;border:1px solid rgba(255,160,90,.3)"
			: "background:rgba(110,170,255,.1);color:#a9cdff;border:1px solid rgba(110,170,255,.28)",
	].join(";");
	body.appendChild(hint);
}

// ───────────────────────── 🧠 模型树（GJJ_Utils.createModelTreeView） ─────────────────────────
// 从文件名提取倍数 token：relayvsr_x4_... → "x4"，与后端同一套通用规则。
function scaleTokenOf(name) {
	const match = String(name || "").match(/(?:^|[_\-. ])x(\d)(?=$|[_\-. ])/i);
	return match ? `x${match[1]}`.toLowerCase() : "";
}

// 倍率控件值 → 内部 token："×2" / "2" → "x2"，与后端 resolve_scale_choice 一致。
function scaleKeyOf(value) {
	const match = String(value ?? "").toLowerCase().replace(/[×*]/g, "x").match(/(\d+)/);
	return match ? `x${match[1]}` : "";
}

function scaleLabelOf(key) {
	const digits = String(key || "").replace(/\D/g, "");
	return digits ? `×${digits}` : String(key || "");
}

function currentScaleKey(node) {
	return scaleKeyOf(getWidget(node, "scale")?.value);
}

function modelWidgetChoices(node, name) {
	const widget = getWidget(node, name);
	const values = widget?.options?.values || widget?.options?.items || widget?.values;
	return (Array.isArray(values) ? values : [])
		.map((item) => String(item || "").trim())
		.filter(Boolean);
}

// 按当前倍率挑同倍数模型：优先 relayvsr 家族，其次任意同 token 候选。
function pickScaleModel(node, name, scale) {
	const widget = getWidget(node, name);
	if (!widget || !scale) return "";
	const choices = modelWidgetChoices(node, name);
	if (!choices.length) return "";
	const family = choices.filter((item) => item.toLowerCase().includes(MODEL_KEYWORD));
	const pool = family.length ? family : choices;
	return pool.find((item) => scaleTokenOf(item) === scale) || "";
}

// 切换放大倍率后，把扩散模型与 VAE 一起换成同倍率权重（x2 / x4 不可混用）。
function applyScaleToModels(node, scaleValue = null) {
	const scale = scaleKeyOf(scaleValue ?? getWidget(node, "scale")?.value);
	if (!scale) return false;
	let changed = false;
	for (const name of MODEL_COMBO_NAMES) {
		const widget = getWidget(node, name);
		if (!widget || scaleTokenOf(widget.value) === scale) continue;
		const hit = pickScaleModel(node, name, scale);
		if (!hit) continue;
		widget.value = hit;
		try {
			widget.callback?.(hit);
		} catch (_) {}
		changed = true;
	}
	if (changed) {
		syncOrderedWidgetValues(node);
		refreshNode(node);
	}
	syncScaleButton(node);
	return changed;
}

// 用户在模型树里换了任意一侧模型时，把倍率控件同步到该模型的倍数，避免两者互相矛盾。
function syncScaleFromModel(node, scale) {
	const widget = getWidget(node, "scale");
	if (!widget || !scale) return;
	if (scaleKeyOf(widget.value) === scale) return;
	const choices = modelWidgetChoices(node, "scale");
	const label = choices.find((item) => scaleKeyOf(item) === scale) || scaleLabelOf(scale);
	widget.value = label;
	try {
		widget.callback?.(label);
	} catch (_) {}
}

// 接管倍率控件的回调：用户切倍率 → 立即换模型；面板内容随后异步刷新。
function installScaleBehavior(node) {
	const widget = getWidget(node, "scale");
	if (!widget || widget.__gjjRelayVsrScaleHooked) return;
	widget.__gjjRelayVsrScaleHooked = true;
	const original = widget.callback;
	widget.callback = function (...args) {
		const result = original?.apply(this, args);
		const value = args[0] ?? widget.value;
		applyScaleToModels(node, value);
		setTimeout(() => syncFloatingPanels(node), 0);
		return result;
	};
}

// 主面板 ×2 / ×4 快捷键：直接切倍率，和节点内「放大倍率」下拉是同一个控件值。
function setScaleByKey(node, scale) {
	const widget = getWidget(node, "scale");
	if (!widget) return;
	const choices = modelWidgetChoices(node, "scale");
	const label = choices.find((item) => scaleKeyOf(item) === scale) || scaleLabelOf(scale);
	if (widget.value !== label) {
		widget.value = label;
		try {
			widget.callback?.(label);
		} catch (_) {}
	}
	// 下拉被隐藏时核心回调不一定触发，这里显式再对齐一次模型（幂等）。
	applyScaleToModels(node, label);
	syncScaleButton(node);
	refreshNode(node);
	setTimeout(() => syncFloatingPanels(node), 0);
}

// 单个「2️⃣→4️⃣」倍率按钮：当前倍率的那一侧亮、另一侧灰；点一下即切换。
function syncScaleButton(node) {
	const button = node?.__gjjRelayVsrButtons?.scale;
	if (!button) return;
	const current = currentScaleKey(node);
	const side = (icon, active) =>
		`<span style="opacity:${active ? 1 : 0.3};filter:${active ? "none" : "grayscale(1)"};transition:opacity 120ms ease">${icon}</span>`;
	button.innerHTML = `${side("2️⃣", current === "x2")}<span style="opacity:.6;margin:0 2px">→</span>${side("4️⃣", current === "x4")}`;
	button.style.background = SCALE_BUTTON_OFF_COLOR;
	button.style.border = "1px solid rgba(255,255,255,.14)";
	button.title = current
		? `放大倍率：当前 ×${current.slice(1)}，点击切换到 ×${current === "x2" ? "4" : "2"}（自动换同倍率模型）`
		: "放大倍率切换：×2 ⇄ ×4（自动换同倍率模型）";
}

// ───────────────────────── 📁 打开本机视频 ─────────────────────────
function videoInputLinked(node) {
	return (node?.inputs || []).some(
		(input) => String(input?.name || "") === "video" && input?.link != null
	);
}

async function uploadVideoFile(file) {
	const endpoints = ["/upload/image", "/api/upload/image"];
	let lastError = null;
	for (const endpoint of endpoints) {
		const form = new FormData();
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");
		try {
			const url = typeof api?.apiURL === "function" ? api.apiURL(endpoint) : endpoint;
			const response = await fetch(url, { method: "POST", body: form });
			if (!response.ok) {
				lastError = new Error(`HTTP ${response.status}`);
				continue;
			}
			const data = await response.json().catch(() => ({}));
			const filename = data?.name || data?.filename || data?.file || file.name;
			const subfolder = data?.subfolder || "";
			return subfolder ? `${subfolder}/${filename}` : filename;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new Error("上传失败");
}

// 📁 按钮提示：显示当前选中的视频文件；上游已连接时注明优先级。
function syncOpenButton(node) {
	const button = node?.__gjjRelayVsrButtons?.open;
	if (!button) return;
	const file = String(getWidget(node, "video_file")?.value || "").trim();
	button.title = file
		? `打开视频（当前：${file}）`
		: "打开视频：从本机选择视频，上传到 ComfyUI/input 后作为本节点输入";
	if (videoInputLinked(node)) {
		button.title += "（已连接上游 VIDEO，优先使用输入口）";
	}
}

function flashOpenButton(node, text) {
	const button = node?.__gjjRelayVsrButtons?.open;
	if (!button) return;
	const oldText = button.textContent;
	button.textContent = text;
	clearTimeout(button.__gjjRelayVsrFlash);
	button.__gjjRelayVsrFlash = setTimeout(() => {
		button.textContent = oldText || "📁";
	}, 1200);
}

// 主面板 📁：选择本机视频 → 上传到 ComfyUI/input → 写入 video_file 字段（上游已连接时优先用上游）。
function openLocalVideo(node) {
	if (videoInputLinked(node)) {
		setStatus(node, "已连接上游 VIDEO：优先使用输入口，📁 选择的文件不会生效");
		return;
	}
	const picker = document.createElement("input");
	picker.type = "file";
	picker.accept = "video/*,.mp4,.mov,.m4v,.mkv,.webm,.avi,.flv,.wmv,.mpg,.mpeg,.ts";
	picker.style.display = "none";
	picker.addEventListener("change", async () => {
		const file = picker.files?.[0];
		picker.remove();
		if (!file) return;
		flashOpenButton(node, "⏳");
		setStatus(node, `正在上传视频：${file.name} …`);
		try {
			const uploaded = await uploadVideoFile(file);
			setWidgetValue(node, "video_file", uploaded);
			syncOpenButton(node);
			flashOpenButton(node, "✅");
			setStatus(node, `已载入视频：${uploaded}（未接上游时使用该文件）`);
		} catch (error) {
			console.warn("[GJJ][RelayVSR] 上传视频失败:", error);
			flashOpenButton(node, "❌");
			setStatus(node, "上传视频失败，请查看控制台；也可手动把视频放进 ComfyUI/input 后重选。");
		}
	});
	document.body.appendChild(picker);
	picker.click();
}

// 换扩散模型 / VAE 后，按文件名倍数 token 自动配对另一侧同倍数家族模型。
// 仅在存在合法候选时调整，绝不阻塞选择；后端还会再做一次配对校验。
function autoPairCounterpart(node, changedName, changedValue) {
	const scale = scaleTokenOf(changedValue);
	if (!scale) return;
	const counterpartName = changedName === "unet_name" ? "vae_name" : "unet_name";
	const counterpart = getWidget(node, counterpartName);
	if (!counterpart) return;
	if (scaleTokenOf(counterpart.value) === scale) return;
	const choices = GJJ_Utils._modelTreeWidgetChoices(counterpart);
	const hit = choices.find((item) =>
		String(item).toLowerCase().includes(MODEL_KEYWORD) && scaleTokenOf(item) === scale
	);
	if (hit) {
		counterpart.value = hit;
		try {
			counterpart.callback?.(hit);
		} catch (_) {}
	}
	// 手动换模后让倍率控件跟随模型倍数，保证「倍率 ↔ 模型」始终一致。
	syncScaleFromModel(node, scale);
}

function relayVsrModelTreeEntries(node) {
	const scale = currentScaleKey(node);
	// 模型树只列当前倍率的权重；若该倍率还没有任何文件，则退回完整列表，避免面板空白。
	const byScale = (models) => {
		if (!scale) return models;
		const matched = models.filter((item) => scaleTokenOf(item) === scale || !scaleTokenOf(item));
		return matched.length ? matched : models;
	};
	return [
		{
			widget: "unet_name",
			label: "RelayVSR 扩散模型",
			folder: "diffusion_models",
			icon: "🟣",
			models: byScale(modelWidgetChoices(node, "unet_name")),
			keywords: [MODEL_KEYWORD],
			fallback: getWidget(node, "unet_name")?.value || "",
			description: "diffusion_models 下的 RelayVSR 扩散权重；列表随放大倍率过滤，选择后自动配对同倍数 VAE。",
			floatingChoices: true,
			onApply: (value) => autoPairCounterpart(node, "unet_name", value),
		},
		{
			widget: "vae_name",
			label: "RelayVSR Flash VAE",
			folder: "vae",
			icon: "🔴",
			models: byScale(modelWidgetChoices(node, "vae_name")),
			keywords: [MODEL_KEYWORD],
			fallback: getWidget(node, "vae_name")?.value || "",
			description: "vae 下的 RelayVSR Flash 解码器；列表随放大倍率过滤，x2/x4 权重不可混用。",
			floatingChoices: true,
			onApply: (value) => autoPairCounterpart(node, "vae_name", value),
		},
	];
}

function renderModelPanel(node, panelInfo) {
	if (!panelInfo?.body) return;
	panelInfo.body.replaceChildren();
	// 面板顶部先放「放大倍率」：切倍率即自动把上下两侧模型换成同倍数权重。
	const scaleControl = createFloatingControl(node, "scale");
	if (scaleControl) {
		scaleControl.dataset.widgetName = "scale";
		scaleControl.style.padding = "2px 0 4px";
		panelInfo.body.appendChild(scaleControl);
	}
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: relayVsrModelTreeEntries(node),
		refresh: () => {
			syncOrderedWidgetValues(node);
			GJJ_Utils.refreshNode(node);
			syncFloatingPanels(node);
		},
		onApply: () => {
			syncOrderedWidgetValues(node);
			GJJ_Utils.refreshNode(node);
		},
	});
	tree.style.maxHeight = "360px";
	panelInfo.body.appendChild(tree);
	appendPanelHint(
		panelInfo.body,
		"顶部「放大倍率」决定用哪套 RelayVSR 权重：切到 ×2 或 ×4 时扩散模型与 VAE 会自动一起切换，下方模型树也随之只列同倍率文件；手动换模时倍率会跟随模型倍数同步。x2 与 x4 权重不可混用。",
	);
}

function renderPanelControls(node, panelInfo, names) {
	if (!panelInfo?.body) return;
	panelInfo.body.replaceChildren();
	for (const name of names) {
		const control = createFloatingControl(node, name);
		if (!control) continue;
		control.__gjjRefresh?.();
		panelInfo.body.appendChild(control);
	}
}

function syncFloatingPanels(node) {
	const panels = ensureFloatingPanels(node);
	const openKey = panelOpenKey(node);
	for (const [key, panelInfo] of Object.entries(panels)) {
		if (!panelInfo) continue;
		if (key === "model") renderModelPanel(node, panelInfo);
		else renderPanelControls(node, panelInfo, PANEL_GROUPS[key]?.names || []);
		const open = key === openKey;
		panelInfo.panel.style.display = open ? "flex" : "none";
		if (open) {
			positionFloatingPanel(node, panelInfo.panel, node.__gjjRelayVsrButtons?.[key]);
		}
	}
}

// ───────────────────────── 工具栏与状态 ─────────────────────────
function createIconButton({ icon, title, color = "#293340", onClick }) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = icon;
	button.title = title;
	button.style.cssText = [
		"width:28px",
		"height:28px",
		"border:1px solid rgba(255,255,255,.12)",
		"border-radius:6px",
		`background:${color}`,
		"color:#fff",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"font-size:14px",
		"line-height:1",
		"cursor:pointer",
		"padding:0",
		"box-shadow:inset 0 1px 0 rgba(255,255,255,.08)",
	].join(";");
	button.addEventListener("mouseenter", () => {
		button.style.filter = "brightness(1.15)";
	});
	button.addEventListener("mouseleave", () => {
		button.style.filter = "";
	});
	if (onClick) button.addEventListener("click", onClick);
	return button;
}

function setRandomizeMode(node, on, { sync = true } = {}) {
	const control = node?.widgets?.find((widget) => widget.name === "control_after_generate");
	if (control) {
		control.value = on ? "randomize" : "fixed";
		try {
			control.callback?.(control.value);
		} catch (_) {}
	}
	const button = node?.__gjjRelayVsrButtons?.dice;
	if (button) {
		button.style.background = on ? DICE_ON_COLOR : DICE_OFF_COLOR;
		button.title = on
			? "已开启每次随机：每次执行自动更换种子（左键关闭）；右键设置种子"
			: "左键开启每次随机；右键设置种子";
	}
	if (sync) syncOrderedWidgetValues(node);
}

function progressFromText(text) {
	const value = String(text || "");
	if (value.includes("完成")) return 100;
	if (value.includes("重建") || value.includes("解码")) return 90;
	if (value.includes("采样")) return 70;
	if (value.includes("VAE")) return 55;
	if (value.includes("条件") || value.includes("Latent")) return 40;
	if (value.includes("扩散模型")) return 25;
	if (value.includes("解析")) return 10;
	if (value.includes("失败") || value.includes("错误")) return 100;
	return 0;
}

function normalizeProgress(progress, fallback) {
	const value = Number(progress);
	if (!Number.isFinite(value)) return fallback;
	return value <= 1 ? value * 100 : value;
}

function ensureStatusWidget(node) {
	if (node.__gjjRelayVsrStatus) return node.__gjjRelayVsrStatus;
	const box = document.createElement("div");
	box.style.cssText = [
		"box-sizing:border-box",
		"padding:4px 8px 6px",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
	].join(";");

	const statusRow = document.createElement("div");
	statusRow.style.cssText = "display:flex;gap:5px;align-items:center;min-width:0;margin-bottom:6px;overflow:hidden";

	const statusContent = document.createElement("div");
	statusContent.style.cssText = "flex:1;min-width:0;display:flex;align-items:center;gap:5px";

	const label = document.createElement("div");
	label.textContent = "等待执行";
	label.title = "等待执行";
	label.style.cssText = "display:none";

	const track = document.createElement("div");
	track.style.cssText = [
		"height:4px",
		"overflow:hidden",
		"border-radius:999px",
		"background:#253038",
		"flex:1",
		"min-width:26px",
	].join(";");
	const bar = document.createElement("div");
	bar.style.cssText = [
		"width:0%",
		"height:100%",
		"border-radius:999px",
		"background:#5aa8ff",
		"transition:width 160ms ease",
	].join(";");
	track.appendChild(bar);
	statusContent.append(track, label);

	const buttons = {};
	const panelButton = (key, icon, title, color) => {
		const button = createIconButton({
			icon,
			title,
			color,
			onClick: () => setPanelOpen(node, key, panelOpenKey(node) !== key),
		});
		buttons[key] = button;
		return button;
	};

	const diceBtn = createIconButton({
		icon: "🎲",
		title: "左键开启每次随机；右键设置种子",
		color: DICE_OFF_COLOR,
		onClick: () => {
			const control = node.widgets?.find((widget) => widget.name === "control_after_generate");
			setRandomizeMode(node, control?.value !== "randomize");
		},
	});
	diceBtn.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		setPanelOpen(node, "seed", panelOpenKey(node) !== "seed");
	});
	buttons.dice = diceBtn;

	const generateBtn = createIconButton({
		icon: "▶️",
		title: "只执行当前节点，开始视频超分",
		color: "#16845a",
	});
	buttons.generate = generateBtn;

	// 主面板「📁 打开视频」+ 单个「2️⃣→4️⃣」倍率切换按钮（点一次切一次，不是两个按钮）。
	const openBtn = createIconButton({
		icon: "📁",
		title: "打开视频：从本机选择视频，上传到 ComfyUI/input 后作为本节点输入",
		color: "#2f4152",
		onClick: () => openLocalVideo(node),
	});
	buttons.open = openBtn;

	const scaleBtn = createIconButton({
		icon: "2️⃣→4️⃣",
		title: "放大倍率切换：×2 ⇄ ×4（自动换同倍率模型）",
		color: SCALE_BUTTON_OFF_COLOR,
		onClick: () => setScaleByKey(node, currentScaleKey(node) === "x4" ? "x2" : "x4"),
	});
	scaleBtn.style.width = "auto";
	scaleBtn.style.minWidth = "56px";
	scaleBtn.style.padding = "0 6px";
	scaleBtn.style.fontSize = "13px";
	buttons.scale = scaleBtn;

	statusRow.append(
		openBtn,
		createIconButton({ icon: "🔄", title: "刷新节点", color: "#315db9", onClick: () => refreshNode(node) }),
		scaleBtn,
		diceBtn,
		panelButton("model", "🧠", "模型树：放大倍率 ×2 / ×4 与 RelayVSR 模型配对", "#4d3d83"),
		panelButton("sample", "🎛️", "采样参数：步数 / CFG / 种子 / detail", "#72500f"),
		panelButton("video", "🎞️", "视频输出参数：位深 / 色彩空间 / 色度 / 编码", "#16697a"),
		generateBtn,
		statusContent,
	);
	box.append(statusRow);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => COMPACT_PANEL_HEIGHT,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(320, Number(width || node.size?.[0] || 360)), COMPACT_PANEL_HEIGHT];
	}

	node.__gjjRelayVsrButtons = buttons;
	node.__gjjRelayVsrStatus = { widget, box, label, bar, generateBtn };
	return node.__gjjRelayVsrStatus;
}

function setStatus(node, text, progress = null) {
	const status = node?.__gjjRelayVsrStatus;
	if (!status) return;
	const message = String(text || "等待执行");
	status.label.textContent = message;
	status.label.title = message;
	const percent = normalizeProgress(progress, progressFromText(message));
	status.bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
	refreshNode(node);
}

// ───────────────────────── 节点装配 ─────────────────────────
function patchNode(node) {
	if (!node || node.__gjjRelayVsrPatched) return;
	node.__gjjRelayVsrPatched = true;
	ensureStatusWidget(node);
	syncOrderedWidgetValues(node);
	ensureModelComboValues(node);
	installScaleBehavior(node);
	hideParameterWidgets(node);
	ensureFloatingPanels(node);
	syncFloatingPanels(node);
	syncScaleButton(node);
	syncOpenButton(node);
	setStatus(node, "等待执行");

	scheduleFitNodeToContent(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);

	const status = node.__gjjRelayVsrStatus;
	status?.generateBtn.addEventListener("click", async () => {
		const btn = status.generateBtn;
		const originalText = btn.textContent;
		try {
			btn.textContent = "⏳";
			btn.title = "超分中...";
			btn.disabled = true;
			btn.style.cursor = "not-allowed";
			btn.style.opacity = "0.65";
			setStatus(node, "正在执行 RelayVSR 视频超分...");
			const ok = await queueOnlyCurrentNode(node);
			if (!ok) {
				console.warn("[GJJ][RelayVSR] queueOnlyCurrentNode 返回 false");
				setStatus(node, "执行失败");
			}
		} catch (error) {
			console.error("[GJJ][RelayVSR] 执行失败:", error);
			setStatus(node, "执行失败");
		} finally {
			setTimeout(() => {
				btn.textContent = originalText;
				btn.title = "只执行当前节点，开始视频超分";
				btn.disabled = false;
				btn.style.cursor = "pointer";
				btn.style.opacity = "1";
			}, 500);
		}
	});
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) return;
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.RelayVSRVideoUpscaler",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) return;
		installGraphToPromptPatch();
		installWindowPositionHandlers();

		const originalComputeSize = nodeType.prototype.computeSize;
		nodeType.prototype.computeSize = function (out) {
			const size = originalComputeSize?.apply(this, arguments)
				|| [this.size?.[0] || 360, this.size?.[1] || 120];
			size[0] = Math.max(360, Number(size[0] || this.size?.[0] || 360));
			return size;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			scheduleToolbarFirst(this);
			return result;
		};

		const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (...args) {
			const result = originalOnDrawForeground?.apply(this, args);
			positionOpenFloatingPanels(this);
			return result;
		};

		const originalOnRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			removeFloatingPanels(this);
			return originalOnRemoved?.apply(this, args);
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			restoreParameterWidgetOrder(this);
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			const named = serializedNode?.widgets_values_named;
			if (named && typeof named === "object" && Object.keys(named).length) {
				applyNamedWidgetValues(this, named);
			} else if (Array.isArray(serializedNode?.widgets_values)) {
				applyOrderedWidgetValues(this, serializedNode.widgets_values);
			} else {
				syncOrderedWidgetValues(this);
			}
			// combo 错位自愈（含创建期已被折叠的 control_after_generate 游离 combo）。
			GJJ_Utils.healComboWidgets(this, named);
			ensureModelComboValues(this);
			// 幂等再折叠，防止 configure 过程中 widget 类型被还原。
			hideParameterWidgets(this);
			patchNode(this);
			scheduleToolbarFirst(this);
			scheduleFitNodeToContent(this);
			scheduleStartupModelRescan(this);
			// 载入后按倍率校正一次模型配对：旧工作流可能仍带着另一倍率的权重。
			setTimeout(() => {
				try {
					applyScaleToModels(this);
				} catch (error) {
					console.warn("[GJJ][RelayVSR] 按倍率校正模型失败:", error);
				}
				syncScaleButton(this);
				syncOpenButton(this);
				syncFloatingPanels(this);
			}, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) {
			const result = originalOnSerialize?.apply(this, arguments);
			syncOrderedWidgetValues(this);
			if (data) {
				data.widgets_values = orderedParamValues(this);
				const named = {};
				for (const widget of this.widgets || []) {
					if (widget && widget.name) named[widget.name] = widget.value;
				}
				data.widgets_values_named = named;
			}
			return result;
		};
	},
});

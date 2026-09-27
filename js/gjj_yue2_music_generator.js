import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_Yue2MusicGenerator"]);
const STATUS_WIDGET_NAME = "gjj_yue2_music_status";
const AUDIO_WIDGET_NAME = "gjj_yue2_music_audio";
const COMPACT_PANEL_HEIGHT = 40;
// 节点高度不写死，统一由内容（工具栏 / 音频预览）自然计算。

// 与 py 的 UI_PARAMETER_ORDER 必须完全一致（25 个 widget）。
const PARAM_ORDER = [
	"generation_mode",
	"style",
	"lyrics",
	"mode",
	"max_duration",
	"seed",
	"ckpt_name",
	"abc_planning",
	"max_abc_tokens",
	"abc_temperature",
	"abc_top_p",
	"abc_top_k",
	"abc_repetition_penalty",
	"penalty_window",
	"audio_encoder_name",
	"temperature",
	"top_p",
	"top_k",
	"repetition_penalty",
	"cfg_scale",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
];
// 恢复显隐时用于把 widget.type 还原成 ComfyUI 原生类型。
const RESTORE_WIDGET_TYPES = {
	generation_mode: "combo",
	style: "text",
	lyrics: "text",
	mode: "combo",
	max_duration: "number",
	seed: "number",
	ckpt_name: "combo",
	abc_planning: "toggle",
	max_abc_tokens: "number",
	abc_temperature: "number",
	abc_top_p: "number",
	abc_top_k: "number",
	abc_repetition_penalty: "number",
	penalty_window: "number",
	audio_encoder_name: "combo",
	temperature: "number",
	top_p: "number",
	top_k: "number",
	repetition_penalty: "number",
	cfg_scale: "number",
	steps: "number",
	cfg: "number",
	sampler_name: "combo",
	scheduler: "combo",
	denoise: "number",
};
const PANEL_GROUPS = {
	seed: { title: "🎲 种子", names: ["seed"] },
	text: { title: "📒 风格 / 歌词", names: ["style", "lyrics"] },
	structure: { title: "🌐 规划模式与时长", names: ["mode", "max_duration"] },
	abc: { title: "📝 ABC 规划（文生曲）", names: ["abc_planning", "max_abc_tokens", "abc_temperature", "abc_top_p", "abc_top_k", "abc_repetition_penalty", "penalty_window"] },
	cover: { title: "🎤 参考歌曲接入", names: [] },
	model: { title: "🧠 模型树", names: [] },
	generate: { title: "🎛️ 生成参数", names: ["temperature", "top_p", "top_k", "repetition_penalty", "cfg_scale", "steps", "cfg", "sampler_name", "scheduler", "denoise"] },
};

function isExecutionOutputNode(node) {
	if (!node) return false;
	if (node.comfyClass === "GJJ_Yue2MusicGenerator") return true;
	if (node.constructor?.nodeData?.output_node === true) return true;
	if (node.nodeData?.output_node === true) return true;
	if (node.flags?.output === true) return true;
	return false;
}

async function queueOnlyCurrentNode(node) {
	if (!node || !node.graph) return false;

	const graph = node.graph || app.graph;
	const allNodes = graph?._nodes || app.graph?._nodes || [];

	const savedModes = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;

	try {
		for (const n of allNodes) {
			if (!n || n === node) continue;
			if (isExecutionOutputNode(n)) {
				savedModes.push([n, n.mode]);
				n.mode = 2;
			}
		}

		if (app.canvas) {
			app.canvas.selected_nodes = {};
			app.canvas.selected_nodes[node.id] = node;
			app.canvas.selected_node = node;
		}

		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);

		if (typeof app.queuePrompt === "function") {
			await app.queuePrompt(0, 1);
			return true;
		}

		console.warn("[GJJ] app.queuePrompt 不存在，无法只刷新当前节点");
		return false;
	} finally {
		for (const [n, mode] of savedModes) {
			n.mode = mode;
		}

		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}

		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}
}

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

// 形参还原：直接按键名从 widgets_values_named 取值，彻底不依赖位置，
// 这样即便 widget 顺序变化、中间插入控件也不会错位。
function applyNamedWidgetValues(node, named) {
	if (!node || !named || typeof named !== "object") return false;
	let applied = 0;
	for (const name of Object.keys(named)) {
		if (!PARAM_ORDER.includes(name)) continue; // 只还原功能参数，忽略 DOM/临时控件
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

// 模型类 combo 控件（其候选来自 models 目录扫描）。
const MODEL_COMBO_NAMES = ["ckpt_name", "audio_encoder_name"];

// 保证模型 combo 的候选列表始终包含当前值。
// 核心模型扫描在“当前值不在候选列表”时会判缺失；启动时序下候选可能尚未就绪，
// 这里把当前值补进列表，确保任何时刻扫描都不会误判。
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

// 启动加载完成后，自动重跑一次核心“缺失模型”扫描。
// 这与右键【重新加载节点】消除误报是同一机制，但自动、轻量、无需重建节点。
function scheduleStartupModelRescan(node) {
	if (!node || node.__gjjYue2RescanScheduled) return;
	node.__gjjYue2RescanScheduled = true;
	const rescan = async () => {
		try {
			ensureModelComboValues(node);
			if (typeof app?.refreshMissingModels === "function") {
				// 只按已知模型重扫当前图，避免重新拉取节点定义带来的额外开销。
				await app.refreshMissingModels({ silent: true, reloadDefs: false });
			}
		} catch (error) {
			console.warn("[GJJ] 启动后重扫缺失模型失败:", error);
		}
	};
	// loadGraphData 末尾会先跑一次扫描；这里在其完成之后再纠正，分次延迟覆盖不同启动速度。
	setTimeout(rescan, 300);
	setTimeout(rescan, 1000);
}

function writePromptInputsFromWidgets(node, promptData) {
	const promptNode = promptData?.prompt?.[String(node?.id)] || promptData?.prompt?.[node?.id];
	if (!promptNode?.inputs) return;
	for (const name of PARAM_ORDER) {
		const widget = getWidget(node, name);
		if (widget) {
			promptNode.inputs[name] = widget.value;
		}
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
		if (index >= 0) {
			node.widgets_values[index] = value;
		}
	}
	syncOrderedWidgetValues(node);
	node.graph && (node.graph._version += 1);
	refreshNode(node);
}

// 记录 widget 被前端接管前的原始状态，保证显隐可完全还原（与懒人工作室一致）。
function rememberWidgetState(widget) {
	if (!widget || widget.__gjjYue2VisibilityState) return;
	widget.options = widget.options || {};
	widget.__gjjYue2VisibilityState = {
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

// 统一的参数显隐管理：仅折叠真实 widget（仍负责承载数值与序列化），不删除。
function setWidgetHidden(widget, hidden) {
	if (!widget) return;
	rememberWidgetState(widget);
	widget.options = widget.options || {};
	const state = widget.__gjjYue2VisibilityState || {};
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

// 默认把全部功能参数折叠，由浮动窗口中的镜像控件接管交互。
function hideParameterWidgets(node) {
	for (const name of PARAM_ORDER) {
		setWidgetHidden(getWidget(node, name), true);
	}
	// 功能参数之外的“游离原生控件”也一并折叠，典型是 ComfyUI 给 seed 自动生成的
	// control_after_generate：它不在参数清单里，但会被核心当作 combo 扫描；configure
	// 按位赋值时一旦把模型名错位塞给它，就会被核心永久判为“缺失模型”。排除本节点 DOM 控件。
	const domNames = new Set([STATUS_WIDGET_NAME, AUDIO_WIDGET_NAME]);
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
	const status = node?.__gjjYue2MusicStatus?.widget;
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

// 按当前内容自然计算节点高度（音频区隐藏时高度为 0），同时保证最小宽度。
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
	if (app.__gjjYue2GraphToPromptPatched || typeof app.graphToPrompt !== "function") {
		return;
	}
	app.__gjjYue2GraphToPromptPatched = true;
	const originalGraphToPrompt = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		const result = await originalGraphToPrompt(...args);
		return patchPromptData(result);
	};
}

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
	panel.className = `gjj-yue2-floating-panel gjj-yue2-${key}-panel`;
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

function widgetLabel(widget, fallback) {
	return String(widget?.options?.display_name || widget?.label || widget?.localized_name || widget?.name || fallback || "");
}

function widgetChoices(widget) {
	const values = widget?.options?.values || widget?.options?.items || widget?.values;
	return Array.isArray(values) ? values : [];
}

// 通用多行文本判定，兼容三种形态：
// 1) 显式 options.multiline（标准 STRING 参数声明 {"multiline": true}）；
// 2) 核心为多行文本创建的 DOM widget（原始 type='customtext'，element 为 textarea）；
// 3) 已被本节点折叠（type='hidden'）时，从折叠前快照的原始类型/元素判断。
function isMultilineWidget(widget) {
	if (!widget) return false;
	if (widget.options?.multiline === true) return true;
	if (widget.element?.tagName === "TEXTAREA") return true;
	const state = widget.__gjjYue2VisibilityState;
	if (state?.type === "customtext" || state?.type === "textarea") return true;
	return widget.type === "customtext" || widget.type === "textarea";
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

	let input;
	// 多行文本：通用判定，兼容 options.multiline 与核心 customtext DOM widget。
	const multiline = isMultilineWidget(widget);
	const choices = widgetChoices(widget);
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
	} else if (multiline) {
		input = document.createElement("textarea");
		input.rows = 4;
		input.wrap = "soft";
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
	// 多行文本：更高的编辑区、可纵向拖拽调整大小，标签改为顶部对齐。
	if (input.tagName === "TEXTAREA") {
		input.style.minHeight = "70px";
		input.style.resize = "vertical";
		row.style.alignItems = "start";
		label.style.paddingTop = "6px";
	}

	const readInputValue = () => {
		if (input.type === "checkbox") return input.checked;
		if (input.type === "number") return Number(input.value);
		return input.value;
	};
	const refresh = () => {
		if (input.type === "checkbox") input.checked = !!widget.value;
		else input.value = widget.value ?? "";
	};
	// change/blur 保存，避免输入即保存导致失焦。
	input.addEventListener("change", () => setWidgetValue(node, name, readInputValue()));
	if (input.type !== "checkbox") {
		input.addEventListener("blur", () => setWidgetValue(node, name, readInputValue()));
	}
	row.__gjjRefresh = refresh;
	row.append(label, input);
	refresh();
	return row;
}

// ───────────────────── 翻唱：参考歌曲连接状态 ─────────────────────
function referenceAudioConnected(node) {
	const slotIndex = node?.inputs?.findIndex((item) => item?.name === "reference_audio");
	if (slotIndex == null || slotIndex < 0) return false;
	// 新版 API 更准确，但在 onNodeCreated / configure 创建节点阶段（节点尚未加入 graph），
	// getInputLink / isInputConnected 会抛 NullGraphError。必须空安全，失败再回退原始值。
	if (typeof node.getInputLink === "function") {
		try { if (node.getInputLink(slotIndex) != null) return true; } catch (_) {}
	}
	if (typeof node.isInputConnected === "function") {
		try { if (node.isInputConnected(slotIndex)) return true; } catch (_) {}
	}
	return Boolean(node.inputs[slotIndex]?.link);
}

function createReferenceAudioRow(node) {
	const row = document.createElement("div");
	row.style.cssText = "display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:8px";
	const label = document.createElement("span");
	label.textContent = "参考歌曲";
	label.style.cssText = "font-size:12px;color:#aebfbd;line-height:1.25";
	const value = document.createElement("div");
	value.style.cssText = [
		"box-sizing:border-box",
		"min-height:28px",
		"display:flex",
		"align-items:center",
		"padding:5px 7px",
		"border:1px solid rgba(255,255,255,.1)",
		"border-radius:6px",
		"background:#2d3034",
		"font-size:12px",
	].join(";");
	row.__gjjRefresh = () => {
		const connected = referenceAudioConnected(node);
		value.textContent = connected
			? "✅ 已接入参考歌曲（自动进入歌曲翻唱）"
			: "❌ 未接入（接入后自动进入翻唱模式）";
		value.style.color = connected ? "#8fe6b0" : "#ff9d9d";
	};
	row.append(label, value);
	return row;
}

// 只读的当前模式行：文生曲 / 歌曲翻唱按参考歌曲接入状态自动判定，不提供手动选择入口。
function createAutoModeRow(node) {
	const row = document.createElement("div");
	row.style.cssText = "display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:8px";
	const label = document.createElement("span");
	label.textContent = "当前模式";
	label.style.cssText = "font-size:12px;color:#aebfbd;line-height:1.25";
	const value = document.createElement("div");
	value.style.cssText = [
		"box-sizing:border-box",
		"min-height:28px",
		"display:flex",
		"align-items:center",
		"padding:5px 7px",
		"border:1px solid rgba(255,255,255,.1)",
		"border-radius:6px",
		"background:#2d3034",
		"font-size:12px",
	].join(";");
	row.__gjjRefresh = () => {
		const cover = referenceAudioConnected(node);
		value.textContent = cover
			? "🎤 歌曲翻唱：已接入参考歌曲，模式自动切换"
			: "🎵 文生曲：接入参考歌曲即自动转为翻唱";
		value.style.color = cover ? "#8fe6c8" : "#9cc8ff";
	};
	row.append(label, value);
	return row;
}

// ───────────────────── 面板提示行（模式相关性） ─────────────────────
function appendPanelHint(body, text, warn = false) {
	const hint = document.createElement("div");
	hint.textContent = text;
	hint.style.cssText = [
		"font-size:12px",
		"line-height:1.35",
		"padding:6px 8px",
		"border-radius:6px",
		warn ? "background:rgba(255,160,90,.12);color:#ffc99a;border:1px solid rgba(255,160,90,.3)"
			: "background:rgba(110,170,255,.1);color:#a9cdff;border:1px solid rgba(110,170,255,.28)",
	].join(";");
	body.appendChild(hint);
}

function ensureFloatingPanels(node) {
	node.__gjjYue2Panels ||= {};
	for (const key of Object.keys(PANEL_GROUPS)) {
		if (!node.__gjjYue2Panels[key]) {
			node.__gjjYue2Panels[key] = createFloatingPanel(node, key);
		}
	}
	return node.__gjjYue2Panels;
}

function panelOpenKey(node) {
	return String(node?.properties?.gjj_yue2_open_panel || "");
}

function setPanelOpen(node, key, open) {
	node.properties ||= {};
	node.properties.gjj_yue2_open_panel = open ? key : "";
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

function modelWidgetChoices(node, name) {
	const widget = getWidget(node, name);
	const values = widget?.options?.values || widget?.options?.items || widget?.values;
	return (Array.isArray(values) ? values : [])
		.map((item) => String(item || "").trim())
		.filter(Boolean);
}

// 🧠 模型树条目：参照 GJJ_LazyImageStudio，按目录自动分组。
function yue2ModelTreeEntries(node) {
	return [
		{
			widget: "ckpt_name",
			label: "YuE2 主模型 checkpoint",
			folder: "checkpoints",
			icon: "🟣",
			models: modelWidgetChoices(node, "ckpt_name"),
			keywords: ["yue2"],
			fallback: getWidget(node, "ckpt_name")?.value || "yue2_3b_int8_convrot.safetensors",
			description: "YuE2 3B int8 整包 checkpoint，自带 MODEL / CLIP / VAE，文生曲与翻唱共用。",
		},
		{
			widget: "audio_encoder_name",
			label: "SheetSage2 音频编码器",
			folder: "audio_encoders",
			icon: "🟢",
			models: modelWidgetChoices(node, "audio_encoder_name"),
			keywords: ["sheetsage"],
			fallback: getWidget(node, "audio_encoder_name")?.value || "sheetsage2_bf16.safetensors",
			description: "仅歌曲翻唱需要：把参考歌曲转录成 ABC 旋律；文生曲用不到。",
		},
	];
}

function renderModelPanel(node, panelInfo) {
	if (!panelInfo?.body) return;
	panelInfo.body.replaceChildren();
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: yue2ModelTreeEntries(node).map((entry) => ({ ...entry, floatingChoices: true })),
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
	tree.style.maxHeight = "320px";
	panelInfo.body.appendChild(tree);

	const mode = referenceAudioConnected(node) ? "cover" : "text2music";
	if (mode === "cover") {
		appendPanelHint(panelInfo.body, "歌曲翻唱：上方两个模型都会用到；参考歌曲请在 🎤 面板确认已接入。");
	} else {
		appendPanelHint(panelInfo.body, "文生曲：只需要 checkpoints 下的主模型；audio_encoders 下的 SheetSage2 用不到。");
	}
}

function renderPanelControls(node, panelInfo, names) {
	if (!panelInfo?.body) return;
	panelInfo.body.replaceChildren();
	const mode = referenceAudioConnected(node) ? "cover" : "text2music";
	// 📒 面板顶部显示只读的当前模式行（模式自动判定，无手动入口）。
	if (panelInfo.key === "text") {
		const modeRow = createAutoModeRow(node);
		modeRow.__gjjRefresh?.();
		panelInfo.body.appendChild(modeRow);
	}
	for (const name of names) {
		const control = createFloatingControl(node, name);
		if (!control) continue;
		control.__gjjRefresh?.();
		panelInfo.body.appendChild(control);
	}
	// 各面板附加模式相关性提示。
	if (panelInfo.key === "abc") {
		if (mode === "cover") {
			appendPanelHint(panelInfo.body, "当前为歌曲翻唱：ABC 旋律由 SheetSage2 从参考歌曲转录，本组参数不生效。", true);
		} else {
			appendPanelHint(panelInfo.body, "当前为文生曲：开启 ABC 规划后先生成符号乐谱，再生成歌曲。");
		}
	} else if (panelInfo.key === "cover") {
		if (mode === "cover") {
			appendPanelHint(panelInfo.body, "翻唱流程：参考歌曲（本面板确认接入，也可用工具栏 📂 载入）→ SheetSage2（在 🧠 模型树选择）转 ABC 旋律 → YuE2 按新风格/歌词重新演绎。");
		} else {
			appendPanelHint(panelInfo.body, "当前为文生曲：接入参考歌曲后将自动切换为歌曲翻唱，无需手动选择。", false);
		}
	}
}

function renderCoverPanel(node, panelInfo) {
	renderPanelControls(node, panelInfo, PANEL_GROUPS.cover.names);
	const referenceRow = createReferenceAudioRow(node);
	referenceRow.__gjjRefresh?.();
	panelInfo.body.appendChild(referenceRow);
}

function syncFloatingPanels(node) {
	const panels = ensureFloatingPanels(node);
	const openKey = panelOpenKey(node);
	for (const [key, panelInfo] of Object.entries(panels)) {
		if (!panelInfo) continue;
		if (key === "cover") renderCoverPanel(node, panelInfo);
		else if (key === "model") renderModelPanel(node, panelInfo);
		else renderPanelControls(node, panelInfo, PANEL_GROUPS[key]?.names || []);
		const open = key === openKey;
		panelInfo.panel.style.display = open ? "flex" : "none";
		if (open) {
			positionFloatingPanel(node, panelInfo.panel, node.__gjjYue2Buttons?.[key]);
		}
	}
}

function positionOpenFloatingPanels(node) {
	const panels = node?.__gjjYue2Panels;
	const openKey = panelOpenKey(node);
	const panelInfo = panels?.[openKey];
	if (!panelInfo?.panel || panelInfo.panel.style.display === "none") return;
	positionFloatingPanel(node, panelInfo.panel, node.__gjjYue2Buttons?.[openKey]);
}

function positionAllOpenFloatingPanels() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			positionOpenFloatingPanels(node);
		}
	}
}

function removeFloatingPanels(node) {
	for (const panelInfo of Object.values(node?.__gjjYue2Panels || {})) {
		panelInfo?.panel?.remove?.();
	}
	node.__gjjYue2Panels = {};
}

function installWindowPositionHandlers() {
	if (app.__gjjYue2WindowHandlersInstalled || typeof window === "undefined") return;
	app.__gjjYue2WindowHandlersInstalled = true;
	window.addEventListener("resize", positionAllOpenFloatingPanels);
	window.addEventListener("scroll", positionAllOpenFloatingPanels, true);
}

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
	if (onClick) {
		button.addEventListener("click", onClick);
	}
	return button;
}

// 按参考音频连接状态同步生成模式：接入→翻唱(melody)，断开→文生曲(full)。
// silent 用于 configure 恢复阶段：只更新值，不刷新 DOM（避免重建/递归）。
function syncModeByReference(node, { silent = false } = {}) {
	if (!node) return;
	const connected = referenceAudioConnected(node);
	const modeWidget = getWidget(node, "generation_mode");
	const planWidget = getWidget(node, "mode");
	let changed = false;
	if (connected) {
		if (modeWidget && modeWidget.value !== "cover") { modeWidget.value = "cover"; changed = true; }
		if (planWidget && planWidget.value !== "melody") { planWidget.value = "melody"; changed = true; }
	} else {
		if (modeWidget && modeWidget.value !== "text2music") { modeWidget.value = "text2music"; changed = true; }
		if (planWidget && planWidget.value !== "full") { planWidget.value = "full"; changed = true; }
	}
	if (changed) {
		syncOrderedWidgetValues(node);
		if (!silent) refreshNode(node);
	}
}

// 监听参考音频插槽的连接/断开，实时同步生成模式。
function installReferenceAudioBehavior(node) {
	if (!node || node.__gjjRefAudioBehavior) return;
	node.__gjjRefAudioBehavior = true;
	const original = node.onConnectionsChange;
	node.onConnectionsChange = function (type, slotIndex, connected, linkInfo, inputSlot) {
			try {
				original?.apply(this, arguments);
			} catch (_) {}
			// inputSlot 即被改动的输入槽；用其名称确认是参考音频。
			const slotName = inputSlot?.name ?? this.inputs?.[slotIndex]?.name;
			if (slotName !== "reference_audio") return;
			// 延迟到当前 connect / graph.configure 操作完成后再同步，
			// 避免在 configure 恢复链接的中途刷新 DOM 而导致整图加载失败。
			if (this.__gjjRefConnRaf) cancelAnimationFrame(this.__gjjRefConnRaf);
			this.__gjjRefConnRaf = requestAnimationFrame(() => {
				this.__gjjRefConnRaf = null;
				syncModeByReference(this, { silent: false });
				refreshToolbarButtons(this);
			});
		};
}

// ===== 参考音频：本地文件载入 / 链接挂起与恢复 / 随机种子开关 =====

const OPEN_FILE_OFF_COLOR = "#5a4630";
const LINK_BTN_CONNECTED_COLOR = "#31508f";
const LINK_BTN_SUSPENDED_COLOR = "#a6530c";
const DICE_OFF_COLOR = "#4a4f5c";
const DICE_ON_COLOR = "#0f8a52";

function referenceSlotIndex(node) {
	return node?.inputs?.findIndex((item) => item?.name === "reference_audio") ?? -1;
}

// 通用上传：把本地音频文件上传到 input 目录，返回 {name, subfolder, type}。
// 复用 ComfyUI 内置 /upload/image（该端点不限制文件类型），不引入额外依赖。
async function uploadAudioFile(file) {
	const form = new FormData();
	form.append("image", file, file.name);
	form.append("type", "input");
	const response = api?.fetchApi
		? await api.fetchApi("/upload/image", { method: "POST", body: form })
		: await fetch("/upload/image", { method: "POST", body: form });
	if (!response?.ok) throw new Error(`上传失败：HTTP ${response?.status || "?"}`);
	const data = await response.json().catch(() => ({}));
	return { name: data.name || file.name, subfolder: data.subfolder || "", type: data.type || "input" };
}

// 创建内置 LoadAudio 节点并接入本节点参考音频插槽。
function attachAudioLoader(node, filename) {
	const loader = LiteGraph.createNode("LoadAudio");
	const fileWidget = loader.widgets?.find((w) => w.name === "audio");
	if (fileWidget) {
		const values = GJJ_Utils._modelTreeWidgetChoices(fileWidget);
		if (values.length && !values.includes(filename)) values.push(filename);
		fileWidget.value = filename;
	}
	// 放置在本节点左侧，避免遮挡。
	const loaderWidth = loader.size?.[0] || 270;
	loader.pos = [Math.max(20, node.pos[0] - loaderWidth - 60), node.pos[1]];
	(node.graph || app.graph).add(loader);
	const slot = referenceSlotIndex(node);
	loader.connect(0, node, slot);
	return loader;
}

// 弹出文件选择框，选择后上传并接入。
function chooseLocalAudioFile(node) {
	if (!node) return;
	if (referenceAudioConnected(node)) {
		setStatus(node, "参考歌曲已连接外部音频，📂 已灰显禁用；如需本地载入请先用 🔗 断开。");
		return;
	}
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "audio/*,video/*";
	input.multiple = false;
	input.onchange = async () => {
		const file = (input.files || [])[0];
		if (!file) return;
		setStatus(node, `📤 正在上传参考歌曲：${file.name}…`, 0.1);
		try {
			const info = await uploadAudioFile(file);
			node.__gjjRefSuspended = false;
			node.__gjjSavedRef = null;
			attachAudioLoader(node, info.name);
			setStatus(node, `📂 已载入参考歌曲：${info.name}`, 0);
			refreshToolbarButtons(node);
		} catch (error) {
			setStatus(node, `参考歌曲载入失败：${error?.message || error}`, 0);
		}
	};
	input.click();
}

// 🔗：已连接→记住来源并断开；已挂起→恢复原连接。
function toggleReferenceLink(node) {
	if (!node) return;
	const slot = referenceSlotIndex(node);
	if (slot < 0) return;
	if (referenceAudioConnected(node)) {
		let link = null;
		try { link = node.getInputLink(slot); } catch (_) { link = null; }
		if (link) {
			node.__gjjSavedRef = { originId: link.origin_id, originSlot: link.origin_slot };
		}
		node.disconnectInput(slot);
		node.__gjjRefSuspended = true;
	} else {
		const saved = node.__gjjSavedRef;
		const source = saved ? (node.graph || app.graph).getNodeById(saved.originId) : null;
		if (source && saved) {
			source.connect(saved.originSlot, node, slot);
			node.__gjjRefSuspended = false;
		} else {
			// 来源节点已被删除，无法恢复，重置挂起状态。
			node.__gjjRefSuspended = false;
			node.__gjjSavedRef = null;
		}
	}
	refreshToolbarButtons(node);
}

// 🎲：切换“每次执行随机种子”。本质是设置 seed 自带的 control_after_generate
// （randomize=随机 / fixed=固定），核心在排队前的 beforeQueued 阶段应用。
function setRandomizeMode(node, on, { sync = true } = {}) {
	const control = node?.widgets?.find((w) => w.name === "control_after_generate");
	if (control) {
		control.value = on ? "randomize" : "fixed";
		try { control.callback?.(control.value); } catch (_) {}
	}
	const button = node?.__gjjYue2Buttons?.dice;
	if (button) {
		button.style.background = on ? DICE_ON_COLOR : DICE_OFF_COLOR;
		button.title = on
			? "已开启每次随机：每次执行自动更换种子（左键关闭）；右键设置种子"
			: "左键开启每次随机；右键设置种子";
	}
	if (sync) syncOrderedWidgetValues(node);
}

// 根据连接/挂起/随机状态刷新工具栏按钮外观。
function refreshToolbarButtons(node) {
	if (!node?.__gjjYue2Buttons) return;
	const buttons = node.__gjjYue2Buttons;
	const connected = referenceAudioConnected(node);
	const saved = node.__gjjSavedRef;
	const graph = node.graph || app.graph;
	const sourceAlive = saved ? graph.getNodeById(saved.originId) != null : false;
	const suspended = node.__gjjRefSuspended === true && !connected && sourceAlive;

	// 📂：有真实连接时灰显禁用。
	buttons.openFile.disabled = connected;
	buttons.openFile.style.opacity = connected ? ".45" : "1";
	buttons.openFile.style.cursor = connected ? "not-allowed" : "pointer";
	buttons.openFile.title = connected
		? "参考歌曲已连接外部音频，已禁用；如需本地载入请先用 🔗 断开"
		: "从磁盘任意位置选择音频文件作为参考歌曲（自动创建 LoadAudio 并连接）";

	// 🔗：连接中或挂起（且来源仍在）时显示。
	buttons.toggleLink.style.display = connected || suspended ? "inline-flex" : "none";
	buttons.toggleLink.style.background = connected
		? LINK_BTN_CONNECTED_COLOR
		: LINK_BTN_SUSPENDED_COLOR;
	buttons.toggleLink.title = connected
		? "记住并断开参考歌曲链接（再次点击恢复）"
		: "恢复参考歌曲链接";

	// 🎲：以 control_after_generate 当前值为准。
	const control = node.widgets?.find((w) => w.name === "control_after_generate");
	const randomOn = control?.value === "randomize";
	buttons.dice.style.background = randomOn ? DICE_ON_COLOR : DICE_OFF_COLOR;
	buttons.dice.title = randomOn
		? "已开启每次随机：每次执行自动更换种子（左键关闭）；右键设置种子"
		: "左键开启每次随机；右键设置种子";
}

function progressFromText(text) {
	const value = String(text || "");
	if (value.includes("完成")) return 100;
	if (value.includes("解码")) return 83;
	if (value.includes("采样")) return 66;
	if (value.includes("条件")) return 50;
	if (value.includes("规划") || value.includes("转谱") || value.includes("转录")) return 33;
	if (value.includes("加载")) return 16;
	if (value.includes("失败")) return 100;
	return 0;
}

function normalizeProgress(progress, fallback) {
	const value = Number(progress);
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return value <= 1 ? value * 100 : value;
}

function ensureStatusWidget(node) {
	if (node.__gjjYue2MusicStatus) {
		return node.__gjjYue2MusicStatus;
	}
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

	const generateBtn = createIconButton({ icon: "▶️", title: "只执行当前节点，生成歌曲", color: "#16845a" });
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

	// 📂 第一位：从磁盘任意位置载入参考音频。
	const openFileBtn = createIconButton({
		icon: "📂",
		title: "从磁盘任意位置选择音频文件作为参考歌曲（自动创建 LoadAudio 并连接）",
		color: OPEN_FILE_OFF_COLOR,
		onClick: () => chooseLocalAudioFile(node),
	});
	buttons.openFile = openFileBtn;

	// 🔗 紧随其后：记住并断开 / 恢复参考链接（无连接时隐藏）。
	const toggleLinkBtn = createIconButton({
		icon: "🔗",
		title: "记住并断开参考歌曲链接（再次点击恢复）",
		color: LINK_BTN_CONNECTED_COLOR,
		onClick: () => toggleReferenceLink(node),
	});
	toggleLinkBtn.style.display = "none";
	buttons.toggleLink = toggleLinkBtn;

	// 🎲 随机种子开关：左键切换每次随机，右键打开种子面板设置固定种子。
	const diceBtn = createIconButton({
		icon: "🎲",
		title: "左键开启每次随机；右键设置种子",
		color: DICE_OFF_COLOR,
		onClick: () => {
			const control = node.widgets?.find((w) => w.name === "control_after_generate");
			setRandomizeMode(node, control?.value !== "randomize");
		},
	});
	diceBtn.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		setPanelOpen(node, "seed", panelOpenKey(node) !== "seed");
	});
	buttons.dice = diceBtn;

	statusRow.append(
		openFileBtn,
		toggleLinkBtn,
		createIconButton({ icon: "🔄", title: "刷新节点", color: "#315db9", onClick: () => refreshNode(node) }),
		diceBtn,
		panelButton("text", "📒", "音乐风格 / 歌词（模式按参考歌曲自动切换）", "#a65f00"),
		panelButton("structure", "🌐", "规划模式与最大时长", "#16728d"),
		panelButton("abc", "📝", "ABC 规划（文生曲）", "#7a3b16"),
		panelButton("cover", "🎤", "参考歌曲接入状态：接入即自动进入歌曲翻唱", "#16697a"),
		panelButton("model", "🧠", "模型树：checkpoint 与 SheetSage2", "#4d3d83"),
		panelButton("generate", "🎛️", "生成参数：音乐采样与主采样", "#72500f"),
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

	node.__gjjYue2Buttons = buttons;
	node.__gjjYue2MusicStatus = { widget, box, label, bar, generateBtn };
	return node.__gjjYue2MusicStatus;
}

function setStatus(node, text, progress = null) {
	const status = node?.__gjjYue2MusicStatus;
	if (!status) return;
	const message = String(text || "等待执行");
	status.label.textContent = message;
	status.label.title = message;
	const percent = normalizeProgress(progress, progressFromText(message));
	status.bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
	refreshNode(node);
}

function buildViewUrl(item) {
	const params = new URLSearchParams();
	params.set("filename", item.filename || "");
	params.set("type", item.type || "output");
	if (item.subfolder) {
		params.set("subfolder", item.subfolder);
	}
	params.set("rand", String(Date.now()));
	return `/view?${params.toString()}`;
}

function buildAudioPeaks(audioBuffer, count = 240) {
	const channels = Math.max(1, audioBuffer.numberOfChannels || 1);
	const length = Math.max(1, audioBuffer.length || 1);
	const block = Math.max(1, Math.floor(length / count));
	const peaks = [];
	for (let index = 0; index < count; index += 1) {
		const start = index * block;
		const end = Math.min(length, start + block);
		let peak = 0;
		for (let channel = 0; channel < channels; channel += 1) {
			const data = audioBuffer.getChannelData(channel);
			for (let sample = start; sample < end; sample += 1) {
				const value = Math.abs(data[sample] || 0);
				if (value > peak) peak = value;
			}
		}
		peaks.push(Math.min(1, peak));
	}
	const maxPeak = Math.max(0.01, ...peaks);
	return peaks.map((peak) => peak / maxPeak);
}

function drawWaveform(audioWidget) {
	const { canvas, audio } = audioWidget;
	const peaks = audioWidget.peaks || [];
	const rect = canvas.getBoundingClientRect();
	const width = Math.max(1, Math.floor(rect.width || 1));
	const height = Math.max(1, Math.floor(rect.height || 1));
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
		canvas.width = Math.floor(width * dpr);
		canvas.height = Math.floor(height * dpr);
	}
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "#0d1519";
	ctx.fillRect(0, 0, width, height);
	const progress = audio.duration > 0 ? Math.max(0, Math.min(1, audio.currentTime / audio.duration)) : 0;
	const barCount = peaks.length || 96;
	const gap = 1;
	const barWidth = Math.max(1, (width - gap * (barCount - 1)) / barCount);
	for (let index = 0; index < barCount; index += 1) {
		const x = index * (barWidth + gap);
		const value = peaks[index] ?? (0.2 + 0.18 * Math.sin(index * 0.37));
		const barHeight = Math.max(2, value * (height - 10));
		const y = (height - barHeight) / 2;
		const active = index / Math.max(1, barCount - 1) <= progress;
		ctx.fillStyle = active ? "#75d2c5" : "#3f555c";
		ctx.fillRect(x, y, Math.max(1, barWidth), barHeight);
	}
	ctx.fillStyle = "#ffd86a";
	ctx.fillRect(Math.max(0, Math.min(width - 2, width * progress)), 0, 2, height);
}

async function loadWaveform(audioWidget, url) {
	audioWidget.peaks = [];
	drawWaveform(audioWidget);
	try {
		const response = await fetch(url, { cache: "force-cache" });
		const arrayBuffer = await response.arrayBuffer();
		const AudioContextClass = window.AudioContext || window.webkitAudioContext;
		if (!AudioContextClass) return;
		const context = new AudioContextClass();
		const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
		audioWidget.peaks = buildAudioPeaks(decoded);
		await context.close?.();
		drawWaveform(audioWidget);
	} catch (error) {
		console.warn("[GJJ] 音频波形解析失败:", error);
	}
}

function ensureAudioWidget(node) {
	if (node.__gjjYue2MusicAudio) {
		return node.__gjjYue2MusicAudio;
	}
	const box = document.createElement("div");
	box.style.cssText = [
		"display:none",
		"padding:8px 10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#22282d",
		"box-sizing:border-box",
	].join(";");
	const canvas = document.createElement("canvas");
	canvas.style.cssText = [
		"display:block",
		"width:100%",
		"height:86px",
		"border:1px solid #31454d",
		"border-radius:7px",
		"background:#0d1519",
		"cursor:pointer",
		"box-sizing:border-box",
	].join(";");
	const audio = document.createElement("audio");
	audio.controls = true;
	audio.preload = "metadata";
	audio.style.cssText = "display:block;width:100%;height:34px;margin-top:6px";
	const row = document.createElement("div");
	row.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:6px;font-size:12px";
	const openLink = document.createElement("a");
	openLink.textContent = "打开";
	openLink.target = "_blank";
	openLink.rel = "noopener";
	openLink.style.cssText = "color:#9ecbff;text-decoration:none";
	const downloadLink = document.createElement("a");
	downloadLink.textContent = "下载";
	downloadLink.download = "";
	downloadLink.style.cssText = "color:#9ecbff;text-decoration:none";
	row.append(openLink, downloadLink);
	box.append(canvas, audio, row);
	const widget = node.addDOMWidget?.(AUDIO_WIDGET_NAME, AUDIO_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => (box.style.display === "none" ? 0 : 168),
	});
	const audioWidget = { widget, box, canvas, audio, openLink, downloadLink, peaks: [] };
	canvas.addEventListener("click", (event) => {
		if (!audio.duration) return;
		const rect = canvas.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
		audio.currentTime = ratio * audio.duration;
		drawWaveform(audioWidget);
	});
	audio.addEventListener("timeupdate", () => drawWaveform(audioWidget));
	audio.addEventListener("loadedmetadata", () => drawWaveform(audioWidget));
	window.addEventListener("resize", () => drawWaveform(audioWidget));
	node.__gjjYue2MusicAudio = audioWidget;
	return node.__gjjYue2MusicAudio;
}

function extractAudioItem(message) {
	const audioList = message?.audio;
	if (!Array.isArray(audioList) || !audioList.length) {
		return null;
	}
	const first = audioList[0];
	if (typeof first === "string") {
		return { filename: first, type: "output" };
	}
	if (first && typeof first === "object" && first.filename) {
		return first;
	}
	return null;
}

function setAudioPreview(node, message) {
	const item = extractAudioItem(message);
	if (!item) return;
	const audioWidget = ensureAudioWidget(node);
	const url = buildViewUrl(item);
	const itemKey = `${item.type || "output"}\n${item.subfolder || ""}\n${item.filename || ""}`;
	if (audioWidget.itemKey !== itemKey) {
		audioWidget.itemKey = itemKey;
		audioWidget.audio.src = url;
		loadWaveform(audioWidget, url);
	}
	audioWidget.openLink.href = url;
	audioWidget.downloadLink.href = url;
	audioWidget.downloadLink.download = item.filename || "GJJ_YuE2.flac";
	audioWidget.box.style.display = "block";
	refreshNode(node);
	// 音频区展开后，让节点按内容长高（不预留大片空白）。
	scheduleFitNodeToContent(node);
}

function patchNode(node) {
	if (!node || node.__gjjYue2MusicPatched) {
		return;
	}
	node.__gjjYue2MusicPatched = true;
	ensureStatusWidget(node);
	ensureAudioWidget(node);
	installReferenceAudioBehavior(node);
	syncOrderedWidgetValues(node);
	ensureModelComboValues(node);
	hideParameterWidgets(node);
	ensureFloatingPanels(node);
	syncFloatingPanels(node);
	setStatus(node, "等待执行");

	scheduleFitNodeToContent(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);

	const status = node.__gjjYue2MusicStatus;
	if (status?.generateBtn) {
		status.generateBtn.addEventListener("click", async () => {
			console.log("[GJJ] 生成歌曲: 只执行当前节点");
			const btn = status.generateBtn;
			const originalText = btn.textContent;

			try {
				btn.textContent = "⏳";
				btn.title = "生成中...";
				btn.disabled = true;
				btn.style.cursor = "not-allowed";
				btn.style.opacity = "0.65";

				setStatus(node, "正在生成歌曲...");
				const ok = await queueOnlyCurrentNode(node);

				if (!ok) {
					console.warn("[GJJ] 生成歌曲失败：queueOnlyCurrentNode 返回 false");
					setStatus(node, "生成失败");
				}
			} catch (err) {
				console.error("[GJJ] 生成歌曲失败:", err);
				setStatus(node, "生成失败");
			} finally {
				setTimeout(() => {
					btn.textContent = originalText;
					btn.title = "只执行当前节点，生成歌曲";
					btn.disabled = false;
					btn.style.cursor = "pointer";
					btn.style.opacity = "1";
				}, 500);
			}
		});
	}
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

api.addEventListener("gjj_node_audio", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setAudioPreview(targetNode, detail);
});

app.registerExtension({
	name: "GJJ.Yue2MusicGenerator",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
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
			// 优先按键名（形参）还原，避免任何位置错位；无命名数据时才回退到位参。
			const named = serializedNode?.widgets_values_named;
			if (named && typeof named === "object" && Object.keys(named).length) {
				applyNamedWidgetValues(this, named);
			} else if (Array.isArray(serializedNode?.widgets_values)) {
				applyOrderedWidgetValues(this, serializedNode.widgets_values);
			} else {
				syncOrderedWidgetValues(this);
			}
			// 折叠前先对所有 combo 做错位自愈：configure 按位赋值可能把模型名错位塞进
			// seed 的 control_after_generate 等附属 combo，按形参（或首个候选）校正。
			GJJ_Utils.healComboWidgets(this, named);
			// 还原后立即保证模型 combo 候选包含当前值，避免启动扫描误判缺失。
			ensureModelComboValues(this);
			// 幂等再折叠：防止 configure 过程中 widget 类型被还原成原生可见控件。
			hideParameterWidgets(this);
			patchNode(this);
			scheduleToolbarFirst(this);
			scheduleFitNodeToContent(this);
			// 启动加载完成后自动重扫，清除时序误报（等同右键重新加载节点的效果）。
			scheduleStartupModelRescan(this);
			// graph 的 links 在节点 configure 之后才恢复，延迟到连接恢复后，
			// 再按参考音频连接状态同步生成模式（处理“加载时已接好参考音频”的情况）。
			if (!this.__gjjRefSyncScheduled) {
				this.__gjjRefSyncScheduled = true;
				requestAnimationFrame(() => {
					syncModeByReference(this, { silent: true });
					refreshToolbarButtons(this);
				});
				setTimeout(() => {
					syncModeByReference(this, { silent: true });
					refreshToolbarButtons(this);
				}, 300);
			}
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) {
			const result = originalOnSerialize?.apply(this, arguments);
			syncOrderedWidgetValues(this);
			if (data) {
				data.widgets_values = orderedParamValues(this);
				// 同时写一份按键名的形参快照，供下次加载时按名还原。
				const named = {};
				for (const widget of this.widgets || []) {
					if (widget && widget.name) named[widget.name] = widget.value;
				}
				data.widgets_values_named = named;
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			if (message?.audio && Array.isArray(message.audio) && message.audio.length > 0) {
				setAudioPreview(this, message);
			}
			return result;
		};
	},
});

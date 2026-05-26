import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_MultifunctionCalculator"]);
const INPUT_PREFIX = "value_";
const MAX_INPUTS = 24;
const FORMULA_WIDGET = "formula";
const ADVANCED_STATE_PROPERTY = "gjj_calculator_advanced_open";
const SHOW_INT_OUTPUT_PROPERTY = "gjj_calculator_show_int_output";
const SHOW_FORMULA_OUTPUT_PROPERTY = "gjj_calculator_show_formula_output";
const SHOW_INT_WIDGET = "show_int_output";
const SHOW_FORMULA_WIDGET = "show_formula_output";
const INTERNAL_CONTROL_WIDGETS = new Set([SHOW_INT_WIDGET, SHOW_FORMULA_WIDGET]);
const MIN_VISIBLE_INPUTS = 1;
const PANEL_MIN_HEIGHT = 28;
const OUTPUT_DEFS = [
	{ index: 0, type: "*", name: "自动结果", tooltip: "公式计算后的自动类型结果：整数为 INT，小数为 FLOAT，文本为 STRING。", always: true },
	{ index: 1, type: "*", name: "互转/断行结果", tooltip: "自动结果为 FLOAT 时输出取整 INT；自动结果为 INT/帧数时输出 FLOAT；文本结果时按标点符号换行。", property: SHOW_INT_OUTPUT_PROPERTY },
	{ index: 2, type: "STRING", name: "输出公式", tooltip: "实际参与计算的公式文本，便于传给其他文本节点记录。", property: SHOW_FORMULA_OUTPUT_PROPERTY },
];
const OPERATORS = [
	{ label: "➕", insert: " + ", title: "加法" },
	{ label: "➖", insert: " - ", title: "减法" },
	{ label: "✖", insert: " * ", title: "乘法" },
	{ label: "➗", insert: " / ", title: "除法" },
	{ label: "%", insert: " % ", title: "取余 / 模数" },
	{ label: "//", insert: " // ", title: "整除" },
	{ label: "**", insert: " ** ", title: "幂运算" },
	{ label: "(", insert: "(", title: "左括号" },
	{ label: ")", insert: ")", title: "右括号" },
	{ label: ",", insert: ", ", title: "函数参数分隔" },
];
const FUNCTIONS = [
	{ label: "🔺 最大", insert: "max(", title: "最大值 max(x1, x2)" },
	{ label: "🔻 最小", insert: "min(", title: "最小值 min(x1, x2)" },
	{ label: "⚖️ 平均", insert: "avg(", title: "平均值 avg(x1, x2)" },
	{ label: "➕ 求和", insert: "sum(", title: "求和 sum(x1, x2)" },
	{ label: "🎯 任意", insert: "any(", title: "任意值 any(x1, x2)；不填参数时返回第一个已连接输入" },
	{ label: "🧲 绝对", insert: "abs(", title: "绝对值 abs(x)" },
	{ label: "🔘 四舍", insert: "round(", title: "四舍五入 round(x)" },
	{ label: "🔢 取整", insert: "int(", title: "强制输出整数 int(x)" },
	{ label: "🔣 浮点", insert: "float(", title: "强制输出浮点 float(x)" },
	{ label: "⬇️ 向下", insert: "floor(", title: "向下取整 floor(x)" },
	{ label: "⬆️ 向上", insert: "ceil(", title: "向上取整 ceil(x)" },
	{ label: "🔁 取模", insert: "mod(", title: "取模函数 mod(x1, x2)" },
	{ label: "✴️ 幂", insert: "pow(", title: "幂函数 pow(x1, 2)" },
];
const WRAP_CURRENT_FORMULA_FUNCTIONS = new Set(["abs", "round", "int", "float", "floor", "ceil"]);
const COMMON_FORMULAS = [
	{ label: "🎞️ 总帧", formula: "(x1*x2)+1", title: "总帧数：(帧率 x 时长) + 1" },
	{ label: "🔢 对齐8", formula: "(x1//8)*8", title: "分辨率向下对齐到 8 的倍数。" },
	{ label: "🔢 对齐16", formula: "(x1//16)*16", title: "分辨率向下对齐到 16 的倍数。" },
	{ label: "🔼 上8", formula: "ceil(x1/8)*8", title: "分辨率向上对齐到 8 的倍数。" },
	{ label: "🔼 上16", formula: "ceil(x1/16)*16", title: "分辨率向上对齐到 16 的倍数。" },
	{ label: "🧩 宽高积", formula: "x1*x2", title: "宽 x 高，常用于像素面积。" },
	{ label: "📝 拼接", formula: "x1 + x2", title: "字符串拼接或数字相加。" },
];

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function formatInputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getInputIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(INPUT_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(INPUT_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getValueInputs(node) {
	return (node.inputs || [])
		.filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX))
		.sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name));
}

function inputHasLink(input) {
	return Boolean(input?.link);
}

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = String(value ?? "");
	if (widget.inputEl) {
		widget.inputEl.value = widget.value;
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = widget.value;
	}
	widget.callback?.(widget.value);
}

function getFormulaElement(node) {
	const widget = getWidget(node, FORMULA_WIDGET);
	return widget?.inputEl || widget?.element?.querySelector?.("textarea,input") || null;
}

function addDynamicInput(node) {
	const inputs = getValueInputs(node);
	const nextIndex = inputs.length ? getInputIndex(inputs[inputs.length - 1]?.name) + 1 : 1;
	if (nextIndex <= MAX_INPUTS) {
		node.addInput(formatInputName(nextIndex), "*");
	}
}

function trimTrailingUnusedInputs(node) {
	const inputs = getValueInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_INPUTS; index -= 1) {
		if (inputHasLink(inputs[index])) {
			break;
		}
		const slot = node.inputs.indexOf(inputs[index]);
		if (slot >= 0) {
			node.removeInput(slot);
		}
	}
}

function ensureTrailingEmptyInput(node) {
	const inputs = getValueInputs(node);
	if (!inputs.length) {
		addDynamicInput(node);
		return;
	}
	if (inputHasLink(inputs[inputs.length - 1]) && inputs.length < MAX_INPUTS) {
		addDynamicInput(node);
	}
}

function renameInputs(node) {
	getValueInputs(node).forEach((input, zeroIndex) => {
		const index = zeroIndex + 1;
		input.name = formatInputName(index);
		input.label = `x${index}`;
		input.localized_name = `x${index}`;
		input.type = "*";
		input.tooltip = `动态输入；可接入数字或可转换为数字的字符串，公式中使用 x${index} 引用。`;
	});
}

function hideLegacyValueWidgets(node) {
	for (const widget of node.widgets || []) {
		if (!String(widget?.name || "").startsWith(INPUT_PREFIX) || widget.__gjjCalculatorHidden) {
			continue;
		}
		widget.__gjjCalculatorHidden = true;
		widget.type = `converted-widget:${widget.name || "value"}`;
		widget.hidden = true;
		widget.serialize = false;
		widget.computeSize = () => [0, 0];
		widget.draw = () => {};
		widget.label = "";
		widget.name = widget.name || "gjj_hidden_value";
		widget.last_y = 0;
		widget.y = 0;
		if (widget.inputEl) {
			widget.inputEl.style.display = "none";
		}
		if (widget.element) {
			widget.element.style.display = "none";
		}
	}
}

function getLinkSignature(node) {
	return getValueInputs(node)
		.map((input) => `${input.name}:${input.link || 0}`)
		.join("|");
}

function createRow() {
	const row = document.createElement("div");
	row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;overflow:visible;";
	return row;
}

function createButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"border:1px solid #465960",
		"background:#172026",
		"color:#dce7e2",
		"border-radius:7px",
		"padding:4px 9px",
		"font-size:11px",
		"line-height:1.2",
		"cursor:pointer",
		"white-space:nowrap",
		"flex:0 0 auto",
	].join(";");
	button.addEventListener("mousedown", (event) => {
		event.preventDefault();
		event.stopPropagation();
	});
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(event);
	});
	return button;
}


function isAdvancedOpen(node) {
	return Boolean(node?.properties?.[ADVANCED_STATE_PROPERTY] ?? node?.__gjjCalculatorAdvancedOpen);
}

function setAdvancedOpen(node, open) {
	node.__gjjCalculatorAdvancedOpen = Boolean(open);
	node.properties = node.properties || {};
	node.properties[ADVANCED_STATE_PROPERTY] = Boolean(open);
	updateAdvancedVisibility(node);
	measurePanel(node);
	setDirty(node);
}

function boolFromValue(value, fallback = false) {
	if (value === undefined || value === null || value === "") {
		return Boolean(fallback);
	}
	if (typeof value === "string") {
		return ["true", "1", "yes", "on"].includes(value.toLowerCase());
	}
	return Boolean(value);
}

function propertyToWidgetName(property) {
	if (property === SHOW_INT_OUTPUT_PROPERTY) {
		return SHOW_INT_WIDGET;
	}
	if (property === SHOW_FORMULA_OUTPUT_PROPERTY) {
		return SHOW_FORMULA_WIDGET;
	}
	return null;
}

function getBoolProperty(node, property, fallback = false) {
	const widgetName = propertyToWidgetName(property);
	const widget = widgetName ? getWidget(node, widgetName) : null;
	if (node?.properties && Object.prototype.hasOwnProperty.call(node.properties, property)) {
		return boolFromValue(node.properties[property], fallback);
	}
	if (widget) {
		return boolFromValue(widget.value, fallback);
	}
	return Boolean(fallback);
}

function setBoolProperty(node, property, value) {
	const resolved = Boolean(value);
	node.properties = node.properties || {};
	node.properties[property] = resolved;
	const widgetName = propertyToWidgetName(property);
	const widget = widgetName ? getWidget(node, widgetName) : null;
	if (widget) {
		widget.value = resolved;
		if (widget.inputEl) {
			widget.inputEl.value = String(resolved);
			widget.inputEl.checked = resolved;
		}
		if (widget.element) {
			if ("value" in widget.element) widget.element.value = String(resolved);
			if ("checked" in widget.element) widget.element.checked = resolved;
		}
		widget.callback?.(resolved);
	}
}

function hideInternalControlWidgets(node) {
	for (const widget of node.widgets || []) {
		if (!INTERNAL_CONTROL_WIDGETS.has(String(widget?.name || ""))) {
			continue;
		}
		// 这些 BOOLEAN 只是给后端传递开关状态，必须保留 serialize，
		// 但不能改成 converted-widget，否则 ComfyUI 会在左侧画出一个输入点。
		widget.__gjjCalculatorInternalHidden = true;
		widget.hidden = true;
		widget.serialize = true;
		widget.computeSize = () => [0, 0];
		widget.draw = () => {};
		widget.label = "";
		widget.display_name = "";
		widget.options = widget.options || {};
		widget.options.display = "hidden";
		widget.options.hidden = true;
		widget.last_y = 0;
		widget.y = 0;
		if (widget.inputEl) {
			widget.inputEl.style.display = "none";
			widget.inputEl.style.height = "0";
			widget.inputEl.style.margin = "0";
			widget.inputEl.style.padding = "0";
		}
		if (widget.element) {
			widget.element.style.display = "none";
			widget.element.style.height = "0";
			widget.element.style.margin = "0";
			widget.element.style.padding = "0";
		}
	}
}

function removeInternalControlInputs(node) {
	// 保险处理：某些版本/主题会把隐藏 BOOLEAN 误转为输入槽，直接移除，避免左侧多一个蓝点。
	for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
		const name = String(node.inputs[index]?.name || "");
		if (INTERNAL_CONTROL_WIDGETS.has(name)) {
			node.removeInput(index);
		}
	}
}

function syncOutputStateFromWidgets(node) {
	setBoolProperty(node, SHOW_INT_OUTPUT_PROPERTY, getBoolProperty(node, SHOW_INT_OUTPUT_PROPERTY, false));
	setBoolProperty(node, SHOW_FORMULA_OUTPUT_PROPERTY, getBoolProperty(node, SHOW_FORMULA_OUTPUT_PROPERTY, false));
}

function setButtonActive(button, active) {
	if (!button) {
		return;
	}
	button.style.borderColor = active ? "#7fa7b3" : "#465960";
	button.style.background = active ? "#20333b" : "#172026";
	button.style.color = active ? "#ffffff" : "#dce7e2";
	button.style.opacity = active ? "1" : "0.78";
}

function outputVisible(node, def) {
	return Boolean(def.always || getBoolProperty(node, def.property, false));
}

function getVisibleOutputDefs(node) {
	return OUTPUT_DEFS.filter((def) => outputVisible(node, def));
}

function ensureOutputSlots(node) {
	if (!node) {
		return;
	}
	if (!Array.isArray(node.outputs)) {
		node.outputs = [];
	}
	const visibleDefs = getVisibleOutputDefs(node);
	// 真正移除隐藏输出口，而不是改名为 hidden，避免界面上出现 __gjj_hidden_output。
	while (node.outputs.length > visibleDefs.length) {
		node.removeOutput(node.outputs.length - 1);
	}
	while (node.outputs.length < visibleDefs.length) {
		const def = visibleDefs[node.outputs.length];
		node.addOutput(def.name, def.type);
	}
	visibleDefs.forEach((def, slot) => {
		const output = node.outputs[slot];
		if (!output) return;
		output.name = def.name;
		output.label = def.name;
		output.display_name = def.name;
		output.localized_name = def.name;
		output.type = def.type;
		output.tooltip = def.tooltip;
		delete output.hidden;
		delete output.__gjjCalculatorHidden;
	});
	applyResultOutputTypes(node);
	updateOutputButtons(node);
}

function applyResultOutputTypes(node) {
	const resultType = String(node?.__gjjCalculatorResultType || "");
	const pairType = String(node?.__gjjCalculatorPairType || "");
	if (node?.outputs?.[0] && ["INT", "FLOAT", "STRING"].includes(resultType)) {
		const output = node.outputs[0];
		output.type = resultType;
		output.name = `自动结果 ${resultType}`;
		output.label = output.name;
		output.display_name = output.name;
		output.localized_name = output.name;
	}
	const visibleDefs = getVisibleOutputDefs(node);
	const pairSlot = visibleDefs.findIndex((def) => def.property === SHOW_INT_OUTPUT_PROPERTY);
	if (pairSlot >= 0 && node?.outputs?.[pairSlot] && ["INT", "FLOAT", "STRING"].includes(pairType)) {
		const output = node.outputs[pairSlot];
		output.type = pairType;
		output.name = pairType === "INT" ? "互转结果 INT" : (pairType === "FLOAT" ? "互转结果 FLOAT" : "断行结果 STRING");
		output.label = output.name;
		output.display_name = output.name;
		output.localized_name = output.name;
	}
}

function normalizeLegacyOutputLabels(node) {
	if (!node?.outputs?.length) {
		return;
	}
	const first = node.outputs[0];
	if (first && (first.name === "浮点结果" || first.label === "浮点结果" || first.display_name === "浮点结果")) {
		first.name = "自动结果";
		first.label = "自动结果";
		first.display_name = "自动结果";
		first.localized_name = "自动结果";
		first.type = "*";
	}
	for (const output of node.outputs) {
		if (!output) continue;
		if (output.name === "整数结果" || output.label === "整数结果" || output.display_name === "整数结果") {
			output.name = "互转/断行结果";
			output.label = output.name;
			output.display_name = output.name;
			output.localized_name = output.name;
			output.type = "*";
		}
	}
	applyResultOutputTypes(node);
}

function toggleOutput(node, property) {
	setBoolProperty(node, property, !getBoolProperty(node, property, false));
	ensureOutputSlots(node);
	measurePanel(node);
	setDirty(node);
}

function updateOutputButtons(node) {
	setButtonActive(node.__gjjCalculatorIntOutputButton, getBoolProperty(node, SHOW_INT_OUTPUT_PROPERTY, false));
	setButtonActive(node.__gjjCalculatorFormulaOutputButton, getBoolProperty(node, SHOW_FORMULA_OUTPUT_PROPERTY, false));
}

function updateAdvancedVisibility(node) {
	const open = isAdvancedOpen(node);
	if (node.__gjjCalculatorAdvancedWrap) {
		node.__gjjCalculatorAdvancedWrap.style.display = open ? "flex" : "none";
	}
	if (node.__gjjCalculatorAdvancedButton) {
		node.__gjjCalculatorAdvancedButton.textContent = open ? "⏮️ 收起" : "⚙️ 更多";
		node.__gjjCalculatorAdvancedButton.title = open ? "隐藏高级计算按钮" : "显示高级计算按钮";
		node.__gjjCalculatorAdvancedButton.style.borderColor = open ? "#7fa7b3" : "#465960";
		node.__gjjCalculatorAdvancedButton.style.background = open ? "#20333b" : "#172026";
	}
}

function getFormula(node) {
	return String(getWidget(node, FORMULA_WIDGET)?.value || "");
}

function setFormula(node, formula, selectionStart = null, selectionEnd = null, validateNow = false) {
	setWidgetValue(getWidget(node, FORMULA_WIDGET), formula);
	invalidateResultPreview(node);
	if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
		node.__gjjCalculatorSelection = { start: selectionStart, end: selectionEnd };
		requestAnimationFrame(() => {
			const input = getFormulaElement(node);
			if (input?.setSelectionRange) {
				input.focus?.();
				input.setSelectionRange(selectionStart, selectionEnd);
			}
		});
	}
	if (validateNow) {
		updateHint(node);
	} else {
		scheduleValidate(node);
	}
	setDirty(node);
}

function getFormulaSelection(node) {
	const formula = getFormula(node);
	const input = getFormulaElement(node);
	const saved = node.__gjjCalculatorSelection;
	const normalizedSaved = saved && Number.isInteger(saved.start) && Number.isInteger(saved.end)
		? {
			start: Math.max(0, Math.min(saved.start, formula.length)),
			end: Math.max(0, Math.min(saved.end, formula.length)),
		}
		: null;
	if (input && Number.isInteger(input.selectionStart) && Number.isInteger(input.selectionEnd)) {
		const live = {
			start: Math.max(0, Math.min(input.selectionStart, formula.length)),
			end: Math.max(0, Math.min(input.selectionEnd, formula.length)),
		};
		if (document.activeElement !== input && normalizedSaved && normalizedSaved.start !== normalizedSaved.end) {
			return normalizedSaved;
		}
		return live;
	}
	if (normalizedSaved) {
		return normalizedSaved;
	}
	return { start: formula.length, end: formula.length };
}

function rememberFormulaSelection(node) {
	const input = getFormulaElement(node);
	if (!input || !Number.isInteger(input.selectionStart) || !Number.isInteger(input.selectionEnd)) {
		return;
	}
	node.__gjjCalculatorSelection = {
		start: input.selectionStart,
		end: input.selectionEnd,
	};
}

function appendFormula(node, text) {
	const current = getFormula(node);
	const selection = getFormulaSelection(node);
	const before = current.slice(0, selection.start);
	const after = current.slice(selection.end);
	const next = `${before}${text}${after}`;
	const caret = before.length + text.length;
	setFormula(node, next, caret, caret, false);
}

function applyFunctionFormula(node, text) {
	const current = getFormula(node);
	const selection = getFormulaSelection(node);
	const selected = current.slice(selection.start, selection.end);
	const functionName = String(text || "").replace(/\($/, "").trim();
	if (selected && functionName) {
		const before = current.slice(0, selection.start);
		const after = current.slice(selection.end);
		const wrapped = `${functionName}(${selected})`;
		const caret = before.length + wrapped.length;
		setFormula(node, `${before}${wrapped}${after}`, caret, caret, true);
		return;
	}
	if (functionName && WRAP_CURRENT_FORMULA_FUNCTIONS.has(functionName) && current.trim()) {
		const next = `${functionName}(${current})`;
		setFormula(node, next, next.length, next.length, true);
		return;
	}
	if (functionName) {
		const args = connectedVariableExpression(node);
		const next = `${functionName}(${args})`;
		setFormula(node, next, next.length, next.length, true);
		return;
	}
	appendFormula(node, text);
}

function backspaceFormula(node) {
	const current = getFormula(node);
	const selection = getFormulaSelection(node);
	if (selection.start !== selection.end) {
		setFormula(node, `${current.slice(0, selection.start)}${current.slice(selection.end)}`, selection.start, selection.start, false);
		return;
	}
	const removeAt = Math.max(0, selection.start - 1);
	setFormula(node, `${current.slice(0, removeAt)}${current.slice(selection.end)}`, removeAt, removeAt, false);
}

function clearFormula(node) {
	setFormula(node, "", 0, 0, true);
}

function getConnectedVariableNames(node) {
	return getValueInputs(node)
		.filter((input) => inputHasLink(input))
		.map((input) => `x${getInputIndex(input.name)}`);
}

function upstreamOutputLabel(input) {
	if (!input?.link || !app.graph?.links) {
		return "";
	}
	const link = app.graph.links[input.link];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const output = sourceNode?.outputs?.[Number(link?.origin_slot || 0)];
	return String(output?.localized_name || output?.label || output?.name || "").trim();
}

function buildLabelValueTemplate(node) {
	const parts = getValueInputs(node)
		.filter((input) => inputHasLink(input))
		.map((input) => {
			const index = getInputIndex(input.name);
			const label = upstreamOutputLabel(input) || `x${index}`;
			return `${label}：x${index}`;
		});
	return parts.length ? parts.join("； ") : "x1";
}

function connectedVariableExpression(node, fallback = "x1") {
	const names = getConnectedVariableNames(node);
	return names.length ? names.join(", ") : fallback;
}

function validateFormulaText(node) {
	const formula = getFormula(node).trim();
	if (!formula) {
		return { ok: false, text: "规则提示：公式为空，点击输入变量或运算按钮开始。" };
	}
	const connected = new Set(getConnectedVariableNames(node));
	const used = new Set(Array.from(formula.matchAll(/\bx(\d+)\b/g)).map((match) => `x${match[1]}`));
	for (const name of used) {
		if (!connected.has(name)) {
			return { ok: false, text: `规则提示：${name} 还没有连接数值输入。` };
		}
	}
	if (/[\+\-\*\/%]{3,}/.test(formula.replace(/\*\*/g, "^").replace(/\/\//g, "~"))) {
		return { ok: false, text: "规则提示：连续运算符过多，请检查公式。" };
	}
	let depth = 0;
	for (const char of formula) {
		if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth -= 1;
			if (depth < 0) {
				return { ok: false, text: "规则提示：右括号数量过多。" };
			}
		}
	}
	if (depth !== 0) {
		return { ok: false, text: "规则提示：括号还没有闭合。" };
	}
	return { ok: true, text: "规则提示：执行时自动判断 INT / FLOAT / STRING，互转结果会随类型变化。" };
}

function updateHint(node, result = null) {
	const hint = node.__gjjCalculatorHint;
	if (!hint) {
		return;
	}
	const resolved = result || validateFormulaText(node);
	hint.textContent = resolved.text;
	hint.style.color = resolved.error ? "#fecaca" : (resolved.ok ? "#9dd7b2" : "#f0c674");
	hint.style.fontWeight = resolved.error ? "700" : "400";
	hint.style.padding = resolved.error ? "6px 8px" : "0";
	hint.style.border = resolved.error ? "1px solid rgba(248,113,113,.75)" : "0";
	hint.style.borderRadius = resolved.error ? "7px" : "0";
	hint.style.background = resolved.error ? "rgba(127,29,29,.35)" : "transparent";
}

function scheduleValidate(node, ms = 220) {
	clearTimeout(node.__gjjCalculatorValidateTimer);
	node.__gjjCalculatorValidateTimer = setTimeout(() => updateHint(node), ms);
}

function updateResultPreview(node, value = null) {
	const target = node.__gjjCalculatorResultText || node.__gjjCalculatorFormulaText;
	if (!target) {
		return;
	}
	if (value == null || value === "") {
		target.textContent = "等待执行后显示计算结果";
		target.style.color = "#aebdc4";
		return;
	}
	target.textContent = String(value);
	target.style.color = "#e6f0ec";
	target.style.borderColor = "#3f5057";
	target.style.background = "#10171b";
}

function showCalculatorError(node, message) {
	const text = String(message || "公式计算失败，请检查输入。");
	node.__gjjCalculatorLastResult = null;
	updateResultPreview(node);
	const target = node.__gjjCalculatorResultText || node.__gjjCalculatorFormulaText;
	if (target) {
		target.textContent = `⚠️ ${text}`;
		target.style.color = "#fecaca";
		target.style.borderColor = "rgba(248,113,113,.85)";
		target.style.background = "rgba(127,29,29,.35)";
	}
	updateHint(node, { ok: false, error: true, text: `⚠️ 公式没有执行：${text}` });
	measurePanel(node);
}

function invalidateResultPreview(node) {
	node.__gjjCalculatorLastResult = null;
	updateResultPreview(node);
}

function rebuildInputButtons(node) {
	const row = node.__gjjCalculatorInputRow;
	const advancedInputRow = node.__gjjCalculatorAdvancedInputRow;
	if (!row) {
		return;
	}
	row.textContent = "";
	if (advancedInputRow) {
		advancedInputRow.textContent = "";
	}
	const inputs = getValueInputs(node);
	for (const input of inputs) {
		const index = getInputIndex(input.name);
		const variable = `x${index}`;
		const button = createButton(`🔹 ${variable}`, `插入变量 ${variable}`, () => appendFormula(node, variable));
		button.style.borderColor = inputHasLink(input) ? "#6a8b97" : "#39484e";
		button.style.opacity = inputHasLink(input) ? "1" : "0.62";
		if (advancedInputRow) {
			advancedInputRow.appendChild(button);
		} else {
			row.appendChild(button);
		}
	}
	if (!node.__gjjCalculatorAdvancedButton) {
		const advancedButton = createButton("⚙️ 更多", "显示高级计算按钮和常用公式", () => setAdvancedOpen(node, !isAdvancedOpen(node)));
		node.__gjjCalculatorAdvancedButton = advancedButton;
	}
	if (!node.__gjjCalculatorIntOutputButton) {
		const button = createButton("🔁 互转", "显示/隐藏“互转/断行结果”输出口：FLOAT 转 INT，INT/帧数转 FLOAT，STRING 按标点换行。", () => toggleOutput(node, SHOW_INT_OUTPUT_PROPERTY));
		node.__gjjCalculatorIntOutputButton = button;
	}
	if (!node.__gjjCalculatorFormulaOutputButton) {
		const button = createButton("🧾 公式", "显示/隐藏“公式文本”输出口", () => toggleOutput(node, SHOW_FORMULA_OUTPUT_PROPERTY));
		node.__gjjCalculatorFormulaOutputButton = button;
	}
	row.appendChild(node.__gjjCalculatorAdvancedButton);
	row.appendChild(node.__gjjCalculatorIntOutputButton);
	row.appendChild(node.__gjjCalculatorFormulaOutputButton);
	updateAdvancedVisibility(node);
	updateOutputButtons(node);
	measurePanel(node);
}

function measurePanel(node) {
	const widget = node?.__gjjCalculatorPanel;
	const container = widget?.element || widget;
	if (!container) {
		return;
	}
	clearTimeout(node.__gjjCalculatorMeasureTimer);
	node.__gjjCalculatorMeasureTimer = setTimeout(() => {
		requestAnimationFrame(() => {
			// 先把 DOM widget 高度收回到内容高度，再读取 scrollHeight，避免旧高度反向撑开。
			container.style.height = "auto";
			container.style.minHeight = "0";
			const height = Math.max(PANEL_MIN_HEIGHT, Math.ceil(container.scrollHeight || container.getBoundingClientRect?.().height || PANEL_MIN_HEIGHT) + 2);
			if (node.__gjjCalculatorPanelHeight !== height) {
				node.__gjjCalculatorPanelHeight = height;
				if (widget && typeof widget.computeSize === "function") {
					widget.last_y = 0;
				}
				setDirty(node);
			}
		});
	}, 20);
}

function ensureCalculatorPanel(node) {
	if (!node || node.__gjjCalculatorPanel) {
		updateResultPreview(node, node.__gjjCalculatorLastResult);
		rebuildInputButtons(node);
		updateHint(node);
		updateAdvancedVisibility(node);
		measurePanel(node);
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:2px 0 0;color:#dce7e2;overflow:visible;";

	const inputRow = createRow();
	container.appendChild(inputRow);
	node.__gjjCalculatorInputRow = inputRow;

	const advancedWrap = document.createElement("div");
	advancedWrap.style.cssText = "display:none;flex-direction:column;gap:7px;overflow:visible;";
	node.__gjjCalculatorAdvancedWrap = advancedWrap;

	const advancedInputRow = createRow();
	advancedWrap.appendChild(advancedInputRow);
	node.__gjjCalculatorAdvancedInputRow = advancedInputRow;

	const operatorRow = createRow();
	for (const item of OPERATORS) {
		operatorRow.appendChild(createButton(item.label, item.title, () => appendFormula(node, item.insert)));
	}
	advancedWrap.appendChild(operatorRow);

	const commonRow = createRow();
	commonRow.appendChild(createButton("🧷 文本拼接", "按已连接上游输出标签生成：标签：x1；标签：x2。执行时会替换成实际值。", () => {
		const next = buildLabelValueTemplate(node);
		setFormula(node, next, next.length, next.length, true);
	}));
	for (const item of COMMON_FORMULAS) {
		commonRow.appendChild(createButton(item.label, item.title, () => setFormula(node, item.formula, item.formula.length, item.formula.length, true)));
	}
	advancedWrap.appendChild(commonRow);

	const functionRow = createRow();
	for (const item of FUNCTIONS) {
		functionRow.appendChild(createButton(item.label, item.title, () => applyFunctionFormula(node, item.insert)));
	}
	functionRow.appendChild(createButton("⌫ 退格", "删除最后一个字符", () => backspaceFormula(node)));
	functionRow.appendChild(createButton("🧹 清空", "清空当前公式", () => clearFormula(node)));
	advancedWrap.appendChild(functionRow);

	container.appendChild(advancedWrap);

	const resultBox = document.createElement("div");
	resultBox.style.cssText = [
		"min-height:34px",
		"border:1px solid #3f5057",
		"background:#10171b",
		"border-radius:7px",
		"padding:7px 9px",
		"font-size:12px",
		"line-height:1.45",
		"white-space:pre-wrap",
		"word-break:break-word",
		"color:#e6f0ec",
	].join(";");
	resultBox.title = "计算结果";
	node.__gjjCalculatorResultText = resultBox;
	node.__gjjCalculatorFormulaText = resultBox;
	advancedWrap.appendChild(resultBox);

	const hint = document.createElement("div");
	hint.style.cssText = "font-size:11px;line-height:1.35;color:#f0c674;";
	node.__gjjCalculatorHint = hint;
	advancedWrap.appendChild(hint);

	const widget = node.addDOMWidget?.("gjj_calculator_panel", "calculator_panel", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(PANEL_MIN_HEIGHT, node.__gjjCalculatorPanelHeight || PANEL_MIN_HEIGHT),
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(260, width || 260), Math.max(PANEL_MIN_HEIGHT, node.__gjjCalculatorPanelHeight || PANEL_MIN_HEIGHT)];
		widget.last_y = 0;
	}
	node.__gjjCalculatorPanel = widget || { element: container };
	updateResultPreview(node, node.__gjjCalculatorLastResult);
	rebuildInputButtons(node);
	updateHint(node);
	updateAdvancedVisibility(node);
	measurePanel(node);
}

function patchFormulaWidget(node) {
	const widget = getWidget(node, FORMULA_WIDGET);
	if (!widget) {
		return;
	}
	if (!widget.__gjjCalculatorPatched) {
		const originalCallback = widget.callback;
		widget.callback = function (value, ...args) {
			const result = typeof originalCallback === "function" ? originalCallback.call(this, value, ...args) : undefined;
			rememberFormulaSelection(node);
			invalidateResultPreview(node);
			scheduleValidate(node);
			return result;
		};
		widget.__gjjCalculatorPatched = true;
	}
	const input = getFormulaElement(node);
	if (input && !input.__gjjCalculatorSelectionPatched) {
		for (const eventName of ["keyup", "mouseup", "select", "input", "focus"]) {
			input.addEventListener(eventName, () => rememberFormulaSelection(node));
		}
		input.__gjjCalculatorSelectionPatched = true;
	}
}

function patchExecution(node) {
	if (node.__gjjCalculatorExecutionPatched) {
		return;
	}
	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = typeof originalExecuted === "function" ? originalExecuted.call(this, message) : undefined;
		if (message?.calculator_error?.[0]) {
			showCalculatorError(this, message.calculator_error[0]);
			return result;
		}
		if (message?.calculator_result?.[0] != null) {
			this.__gjjCalculatorLastResult = message.calculator_result[0];
			this.__gjjCalculatorResultType = String(message?.calculator_result_type?.[0] || "");
			this.__gjjCalculatorPairType = String(message?.calculator_pair_type?.[0] || "");
			applyResultOutputTypes(this);
			updateResultPreview(this, message.calculator_result[0]);
			const typeText = this.__gjjCalculatorResultType || "AUTO";
			const pairText = this.__gjjCalculatorPairType ? `，互转：${this.__gjjCalculatorPairType}` : "";
			updateHint(this, { ok: true, text: `计算结果（${typeText}${pairText}）：${message.calculator_result[0]}` });
		}
		if (message?.calculator_formula?.[0] != null) {
			updateResultPreview(this, this.__gjjCalculatorLastResult);
		}
		return result;
	};
	node.__gjjCalculatorExecutionPatched = true;
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	removeInternalControlInputs(node);
	trimTrailingUnusedInputs(node);
	ensureTrailingEmptyInput(node);
	renameInputs(node);
	hideLegacyValueWidgets(node);
	hideInternalControlWidgets(node);
	syncOutputStateFromWidgets(node);
	ensureOutputSlots(node);
	normalizeLegacyOutputLabels(node);
	patchFormulaWidget(node);
	patchExecution(node);
	ensureCalculatorPanel(node);
	node.__gjjCalculatorLinkSignature = getLinkSignature(node);
	setDirty(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjCalculatorTimer);
	node.__gjjCalculatorTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "GJJ.MultifunctionCalculator",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		// 新建节点时默认只显示“自动结果”，另外两个输出由按钮真正添加。
		nodeData.output = ["*"];
		nodeData.output_name = ["自动结果"];
		nodeData.output_tooltips = ["公式计算后的自动类型结果：整数为 INT，小数为 FLOAT，文本为 STRING。"];

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = typeof originalOnConnectionsChange === "function"
				? originalOnConnectionsChange.apply(this, args)
				: undefined;
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			normalizeLegacyOutputLabels(this);
			const signature = getLinkSignature(this);
			if (signature !== this.__gjjCalculatorLinkSignature) {
				scheduleStabilize(this, 0);
			}
			return typeof originalOnDrawBackground === "function"
				? originalOnDrawBackground.apply(this, args)
				: undefined;
		};
	},

	nodeCreated(node) {
		if (TARGET_NODES.has(node?.comfyClass)) {
			setTimeout(() => stabilizeNode(node), 0);
		}
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
	},
});

import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_MultifunctionCalculator"]);
const INPUT_PREFIX = "value_";
const MAX_INPUTS = 24;
const FORMULA_WIDGET = "formula";
const MIN_VISIBLE_INPUTS = 1;
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
	{ label: "最大(max)", insert: "max(", title: "最大值 max(x1, x2)" },
	{ label: "最小(min)", insert: "min(", title: "最小值 min(x1, x2)" },
	{ label: "平均(avg)", insert: "avg(", title: "平均值 avg(x1, x2)" },
	{ label: "求和(sum)", insert: "sum(", title: "求和 sum(x1, x2)" },
	{ label: "任意(any)", insert: "any(", title: "任意值 any(x1, x2)；不填参数时返回第一个已连接输入" },
	{ label: "绝对(abs)", insert: "abs(", title: "绝对值 abs(x)" },
	{ label: "四舍五入(round)", insert: "round(", title: "四舍五入 round(x)" },
	{ label: "向下(floor)", insert: "floor(", title: "向下取整 floor(x)" },
	{ label: "向上(ceil)", insert: "ceil(", title: "向上取整 ceil(x)" },
	{ label: "取模(mod)", insert: "mod(", title: "取模函数 mod(x1, x2)" },
	{ label: "幂(pow)", insert: "pow(", title: "幂函数 pow(x1, 2)" },
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
		widget.computeSize = () => [0, 0];
		widget.draw = () => {};
		widget.label = "";
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
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(event);
	});
	return button;
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
	if (input && Number.isInteger(input.selectionStart) && Number.isInteger(input.selectionEnd)) {
		return {
			start: Math.max(0, Math.min(input.selectionStart, formula.length)),
			end: Math.max(0, Math.min(input.selectionEnd, formula.length)),
		};
	}
	const saved = node.__gjjCalculatorSelection;
	if (saved && Number.isInteger(saved.start) && Number.isInteger(saved.end)) {
		return {
			start: Math.max(0, Math.min(saved.start, formula.length)),
			end: Math.max(0, Math.min(saved.end, formula.length)),
		};
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
	return { ok: true, text: "规则提示：公式格式通过前端检查，执行时会再次安全校验。" };
}

function updateHint(node, result = null) {
	const hint = node.__gjjCalculatorHint;
	if (!hint) {
		return;
	}
	const resolved = result || validateFormulaText(node);
	hint.textContent = resolved.text;
	hint.style.color = resolved.ok ? "#9dd7b2" : "#f0c674";
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
}

function invalidateResultPreview(node) {
	node.__gjjCalculatorLastResult = null;
	updateResultPreview(node);
}

function rebuildInputButtons(node) {
	const row = node.__gjjCalculatorInputRow;
	if (!row) {
		return;
	}
	row.textContent = "";
	const inputs = getValueInputs(node);
	for (const input of inputs) {
		const index = getInputIndex(input.name);
		const variable = `x${index}`;
		const button = createButton(variable, `插入变量 ${variable}`, () => appendFormula(node, variable));
		button.style.borderColor = inputHasLink(input) ? "#6a8b97" : "#39484e";
		button.style.opacity = inputHasLink(input) ? "1" : "0.62";
		row.appendChild(button);
	}
}

function measurePanel(node) {
	const container = node?.__gjjCalculatorPanel?.element || node?.__gjjCalculatorPanel;
	if (!container) {
		return;
	}
	requestAnimationFrame(() => {
		const height = Math.max(170, Math.ceil(container.scrollHeight || container.offsetHeight || 170));
		if (node.__gjjCalculatorPanelHeight !== height) {
			node.__gjjCalculatorPanelHeight = height;
			setDirty(node);
		}
	});
}

function ensureCalculatorPanel(node) {
	if (!node || node.__gjjCalculatorPanel) {
		updateResultPreview(node, node.__gjjCalculatorLastResult);
		rebuildInputButtons(node);
		updateHint(node);
		measurePanel(node);
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = "display:flex;flex-direction:column;gap:7px;padding:4px 0 2px;color:#dce7e2;";

	const inputRow = createRow();
	container.appendChild(inputRow);
	node.__gjjCalculatorInputRow = inputRow;

	const operatorRow = createRow();
	for (const item of OPERATORS) {
		operatorRow.appendChild(createButton(item.label, item.title, () => appendFormula(node, item.insert)));
	}
	container.appendChild(operatorRow);

	const functionRow = createRow();
	for (const item of FUNCTIONS) {
		functionRow.appendChild(createButton(item.label, item.title, () => applyFunctionFormula(node, item.insert)));
	}
	functionRow.appendChild(createButton("退格", "删除最后一个字符", () => backspaceFormula(node)));
	functionRow.appendChild(createButton("清空", "清空当前公式", () => clearFormula(node)));
	container.appendChild(functionRow);

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
	container.appendChild(resultBox);

	const hint = document.createElement("div");
	hint.style.cssText = "font-size:11px;line-height:1.35;color:#f0c674;";
	node.__gjjCalculatorHint = hint;
	container.appendChild(hint);

	const widget = node.addDOMWidget?.("gjj_calculator_panel", "calculator_panel", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(170, node.__gjjCalculatorPanelHeight || 170),
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(300, width || 300), Math.max(170, node.__gjjCalculatorPanelHeight || 170)];
	}
	node.__gjjCalculatorPanel = widget || { element: container };
	updateResultPreview(node, node.__gjjCalculatorLastResult);
	rebuildInputButtons(node);
	updateHint(node);
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
		if (message?.calculator_result?.[0] != null) {
			this.__gjjCalculatorLastResult = message.calculator_result[0];
			updateResultPreview(this, message.calculator_result[0]);
			updateHint(this, { ok: true, text: `计算结果：${message.calculator_result[0]}` });
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
	trimTrailingUnusedInputs(node);
	ensureTrailingEmptyInput(node);
	renameInputs(node);
	hideLegacyValueWidgets(node);
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

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_ConditionalRouteSwitch"]);
const ROUTE_PREFIX = "any_";
const CONDITION_PREFIX = "value_";
const FORMULA_WIDGET = "formula";
const VARIABLE_NAMES_WIDGET = "variable_names_json";
const VARIABLE_MODE_PROPERTY = "gjj_conditional_route_variable_mode";
const SELECTED_VARIABLES_PROPERTY = "gjj_conditional_route_selected_variables";
const VARIABLE_NAMES_PROPERTY = "gjj_conditional_route_variable_names";
const MIN_PAIRS = 1;
const MAX_PAIRS = 16;
const MAX_VARIABLES = 3;
const DEFAULT_TYPE = "*";
const BYPASS_MODE = 4;
const INPUT_TOOLTIP = "待路由的任意对象；公式结果等于本路序号时才会请求并透传。";
const OUTPUT_TOOLTIP = "公式结果等于本路序号时输出同序号输入；变量模式下未选中路会在提交前旁路下游。";

function formatRouteName(index) {
	return `${ROUTE_PREFIX}${String(index).padStart(2, "0")}`;
}

function formatConditionName(index) {
	return `${CONDITION_PREFIX}${String(index).padStart(2, "0")}`;
}

function getIndex(name, prefix) {
	const text = String(name || "");
	if (!text.startsWith(prefix)) return Number.MAX_SAFE_INTEGER;
	return Number.parseInt(text.slice(prefix.length), 10) || Number.MAX_SAFE_INTEGER;
}

function routeInputs(node) {
	return (node.inputs || [])
		.filter((input) => String(input?.name || "").startsWith(ROUTE_PREFIX))
		.sort((a, b) => getIndex(a?.name, ROUTE_PREFIX) - getIndex(b?.name, ROUTE_PREFIX));
}

function conditionInputs(node) {
	return (node.inputs || [])
		.filter((input) => String(input?.name || "").startsWith(CONDITION_PREFIX))
		.sort((a, b) => getIndex(a?.name, CONDITION_PREFIX) - getIndex(b?.name, CONDITION_PREFIX));
}

function outputs(node) {
	return Array.isArray(node?.outputs) ? node.outputs : [];
}

function nodeType(node) {
	return node?.type || node?.comfyClass || node?.constructor?.type || "";
}

function isTargetNode(node) {
	return TARGET_NODES.has(nodeType(node)) || TARGET_NODES.has(node?.comfyClass);
}

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	widget.value = value;
	if (widget.inputEl) widget.inputEl.value = value;
	widget.callback?.(value);
}

function uniqueNames(values) {
	const result = [];
	const seen = new Set();
	for (const value of Array.isArray(values) ? values : String(values || "").split(/[\n,，]+/)) {
		const text = String(value || "").trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		result.push(text);
	}
	return result;
}

function variableModeEnabled(node) {
	return Boolean(node?.properties?.[VARIABLE_MODE_PROPERTY]);
}

function selectedVariables(node) {
	return uniqueNames(node?.properties?.[SELECTED_VARIABLES_PROPERTY] || []);
}

function variableCompactMode(node) {
	return variableModeEnabled(node) && selectedVariables(node).length > 0;
}

function variableOptions(node) {
	const apiObject = globalThis.GJJ_VariableBroadcast;
	const graph = node?.graph || app.graph;
	return apiObject?.getVisibleSetOptions?.(graph) || [];
}

function variableOptionForName(node, name) {
	return variableOptions(node).find((item) => item.value === name) || { value: name, label: name };
}

function variableDisplayParts(option) {
	const value = String(option?.value || "").trim();
	const label = String(option?.label || value).trim();
	const match = label.match(/^(.*?)\s*[（(]([^（）()]*)[）)]\s*$/);
	if (match && match[2]?.includes(" · ")) {
		const source = match[2].trim();
		const sourceMatch = source.match(/^(.*?)[\s·]+(.+)$/);
		return {
			title: (sourceMatch?.[2] || match[1] || value).trim(),
			source: (sourceMatch?.[1] || source).trim(),
			value,
		};
	}
	return { title: label || value, source: "", value };
}

function variableAliases(node, name) {
	const option = variableOptionForName(node, name);
	const parts = variableDisplayParts(option);
	return uniqueNames([name, parts.title, parts.value]).filter((item) => item && item !== "*");
}

function syncVariableNamesWidget(node) {
	const data = {};
	selectedVariables(node).forEach((name, index) => {
		const aliases = variableAliases(node, name);
		data[`x${index + 1}`] = aliases.length > 1 ? aliases : (aliases[0] || name);
	});
	const serialized = JSON.stringify(data);
	node.properties = node.properties || {};
	node.properties[VARIABLE_NAMES_PROPERTY] = serialized;
	setWidgetValue(getWidget(node, VARIABLE_NAMES_WIDGET), serialized);
	return data;
}

function formulaLooksLikeVariableMap(value) {
	const text = String(value || "").trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return false;
	try {
		const data = JSON.parse(text);
		return data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).some((key) => String(key).startsWith("x"));
	} catch {
		return false;
	}
}

function ensureFormulaValue(node) {
	const widget = getWidget(node, FORMULA_WIDGET);
	if (!widget) return;
	const text = String(widget.value ?? "").trim();
	if (variableCompactMode(node)) {
		setWidgetValue(widget, "x1");
		return;
	}
	if (!text || formulaLooksLikeVariableMap(text)) {
		setWidgetValue(widget, "1");
	}
}

function hideFormulaWidget(node) {
	const widget = getWidget(node, FORMULA_WIDGET);
	if (!widget) return;
	ensureFormulaValue(node);
	widget.hidden = true;
	widget.type = `converted-widget:${FORMULA_WIDGET}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
	if (widget.inputEl) {
		widget.inputEl.disabled = true;
		widget.inputEl.readOnly = true;
		widget.inputEl.style.display = "none";
		widget.inputEl.style.pointerEvents = "none";
	}
	if (widget.options) {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
}

function orderStateWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	const preferred = [FORMULA_WIDGET, VARIABLE_NAMES_WIDGET, "gjj_conditional_route_panel"];
	const ordered = [];
	for (const name of preferred) {
		const widget = node.widgets.find((item) => item?.name === name);
		if (widget && !ordered.includes(widget)) ordered.push(widget);
	}
	for (const widget of node.widgets) {
		if (!ordered.includes(widget)) ordered.push(widget);
	}
	node.widgets = ordered;
}

function serializedWidgetValues(node) {
	if (!Array.isArray(node?.widgets)) return [];
	return node.widgets
		.filter((widget) => widget?.options?.serialize !== false && widget?.serialize !== false)
		.map((widget) => widget?.value);
}

function hideVariableNamesWidget(node) {
	const widget = getWidget(node, VARIABLE_NAMES_WIDGET);
	if (!widget || widget.__gjjConditionalRouteHidden) return;
	widget.__gjjConditionalRouteHidden = true;
	widget.hidden = true;
	widget.type = `converted-widget:${VARIABLE_NAMES_WIDGET}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
	if (widget.options) {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
}

function removeInputsByPrefix(node, prefix) {
	for (let index = (node.inputs || []).length - 1; index >= 0; index -= 1) {
		if (String(node.inputs[index]?.name || "").startsWith(prefix)) {
			node.removeInput(index);
		}
	}
}

function removeInternalInputs(node) {
	for (let index = (node.inputs || []).length - 1; index >= 0; index -= 1) {
		if (String(node.inputs[index]?.name || "") === VARIABLE_NAMES_WIDGET) {
			node.removeInput(index);
		}
	}
}

function formulaInput(node) {
	return (node.inputs || []).find((input) => String(input?.name || "") === FORMULA_WIDGET);
}

function restoreFormulaWidget(node) {
	const widget = getWidget(node, FORMULA_WIDGET);
	const input = formulaInput(node);
	if (input && !inputLinked(input)) {
		const index = node.inputs.indexOf(input);
		if (index >= 0) node.removeInput(index);
	}
	if (!widget) return;
	ensureFormulaValue(node);
	widget.hidden = false;
	if (String(widget.type || "").startsWith("converted-widget:")) {
		widget.type = "text";
	}
	widget.disabled = false;
	widget.readOnly = false;
	if (widget.inputEl) {
		widget.inputEl.disabled = false;
		widget.inputEl.readOnly = false;
		widget.inputEl.style.display = "";
		widget.inputEl.style.pointerEvents = "";
		widget.inputEl.title = "路由公式：结果为 1 走第 1 路，结果为 2 走第 2 路；也可写 [1,2] 同时走多路。";
	}
	if (widget.options) {
		widget.options.hidden = false;
		widget.options.display = "";
	}
}

function inputLinked(input) {
	return input?.link != null;
}

function outputLinked(output) {
	return Array.isArray(output?.links) && output.links.length > 0;
}

function graphLink(linkId) {
	if (linkId == null) return null;
	const links = app.graph?.links;
	return Array.isArray(links) ? links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) : links?.[linkId];
}

function sourceInfo(input) {
	const link = graphLink(input?.link);
	const sourceNode = link?.origin_id != null ? app.graph?.getNodeById?.(link.origin_id) : null;
	const sourceSlot = sourceNode?.outputs?.[link?.origin_slot];
	if (!sourceSlot) return null;
	const label = sourceSlot.label || sourceSlot.localized_name || sourceSlot.name || sourceSlot.type || DEFAULT_TYPE;
	return { type: sourceSlot.type || DEFAULT_TYPE, label: String(label) };
}

function targetInfo(output) {
	for (const linkId of output?.links || []) {
		const link = graphLink(linkId);
		const targetNode = link?.target_id != null ? app.graph?.getNodeById?.(link.target_id) : null;
		const targetSlot = targetNode?.inputs?.[link?.target_slot];
		if (!targetSlot) continue;
		const label = targetSlot.label || targetSlot.localized_name || targetSlot.name || targetSlot.type || DEFAULT_TYPE;
		return { type: targetSlot.type || DEFAULT_TYPE, label: String(label) };
	}
	return null;
}

function pairInfo(input, output, index) {
	const linkedInfo = sourceInfo(input) || targetInfo(output);
	if (linkedInfo?.type) return linkedInfo;
	return { type: DEFAULT_TYPE, label: `第 ${index} 路` };
}

function neededPairs(node) {
	let highestUsed = 0;
	const inputs = routeInputs(node);
	const outs = outputs(node);
	const count = Math.max(inputs.length, outs.length);
	for (let index = 1; index <= count; index += 1) {
		if (inputLinked(inputs[index - 1]) || outputLinked(outs[index - 1])) highestUsed = index;
	}
	return Math.min(MAX_PAIRS, Math.max(MIN_PAIRS, highestUsed + 1));
}

function trimPairs(node, needed) {
	for (let index = routeInputs(node).length - 1; index >= needed; index -= 1) {
		const input = routeInputs(node)[index];
		const slot = node.inputs.indexOf(input);
		if (slot >= 0 && !inputLinked(input)) node.removeInput(slot);
	}
	for (let index = outputs(node).length - 1; index >= needed; index -= 1) {
		if (!outputLinked(outputs(node)[index])) node.removeOutput?.(index);
	}
}

function ensurePairs(node, needed) {
	while (routeInputs(node).length < needed) {
		node.addInput?.(formatRouteName(routeInputs(node).length + 1), DEFAULT_TYPE);
	}
	while (outputs(node).length < needed) {
		node.addOutput?.(`输出 ${outputs(node).length + 1}`, DEFAULT_TYPE);
	}
}

function applyLabels(node) {
	const inputs = routeInputs(node);
	const outs = outputs(node);
	const count = Math.max(inputs.length, outs.length);
	for (let zeroIndex = 0; zeroIndex < count; zeroIndex += 1) {
		const index = zeroIndex + 1;
		const input = inputs[zeroIndex];
		const output = outs[zeroIndex];
		const info = pairInfo(input, output, index);
		if (input) {
			input.name = formatRouteName(index);
			input.type = info.type || DEFAULT_TYPE;
			input.label = inputLinked(input) ? info.label : `输入 ${index}`;
			input.localized_name = input.label;
			input.tooltip = INPUT_TOOLTIP;
		}
		if (output) {
			output.name = `out_${String(index).padStart(2, "0")}`;
			output.type = info.type || DEFAULT_TYPE;
			output.label = outputLinked(output) || inputLinked(input) ? info.label : `输出 ${index}`;
			output.localized_name = output.label;
			output.tooltip = OUTPUT_TOOLTIP;
		}
	}
}

function createButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title || "";
	button.style.cssText = "height:26px;border:1px solid #465960;border-radius:6px;background:#172026;color:#dce7e2;font:700 12px system-ui,'Microsoft YaHei',sans-serif;padding:0 8px;cursor:pointer;white-space:nowrap;";
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	return button;
}

function setButtonActive(button, active) {
	if (!button) return;
	button.style.borderColor = active ? "#7fa7b3" : "#465960";
	button.style.background = active ? "#20333b" : "#172026";
	button.style.color = active ? "#ffffff" : "#dce7e2";
}

function closeVariablePicker(node) {
	node?.__gjjConditionalRouteVariablePicker?.remove?.();
	node.__gjjConditionalRouteVariablePicker = null;
}

function setSelectedVariables(node, names) {
	node.properties = node.properties || {};
	node.properties[SELECTED_VARIABLES_PROPERTY] = uniqueNames(names).slice(0, MAX_VARIABLES);
	node.properties[VARIABLE_MODE_PROPERTY] = Boolean(node.properties[SELECTED_VARIABLES_PROPERTY].length);
	syncVariableNamesWidget(node);
	ensureFormulaValue(node);
	closeVariablePicker(node);
	scheduleStabilize(node, 0);
}

function openVariablePicker(node) {
	closeVariablePicker(node);
	const options = variableOptions(node);
	const selected = new Set(selectedVariables(node));
	const popup = document.createElement("div");
	popup.style.cssText = "position:fixed;z-index:10050;width:min(520px,calc(100vw - 28px));max-height:min(620px,calc(100vh - 40px));overflow:hidden;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid #486575;border-radius:8px;background:#08151a;box-shadow:0 18px 46px rgba(0,0,0,.55);color:#dce7e2;font:12px system-ui,'Microsoft YaHei',sans-serif;";
	const rect = node.__gjjConditionalRouteVariableButton?.getBoundingClientRect?.() || { left: 24, bottom: 80 };
	popup.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - 540, rect.left || 24)))}px`;
	popup.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - 620, (rect.bottom || 80) + 6)))}px`;
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;gap:8px;";
	const title = document.createElement("div");
	title.style.cssText = "font-weight:800;flex:1 1 auto;";
	const clear = createButton("清空", "清空变量选择并恢复输入口", () => {
		selected.clear();
		renderList();
	});
	const done = createButton("完成", "使用当前变量选择", () => setSelectedVariables(node, [...selected]));
	const close = createButton("X", "关闭", () => closeVariablePicker(node));
	header.append(title, clear, done, close);
	popup.appendChild(header);
	const search = document.createElement("input");
	search.placeholder = "搜索变量，按顺序选择 x1 / x2 / x3";
	search.style.cssText = "height:34px;border:1px solid #3f5b66;border-radius:7px;background:#071015;color:#dce7e2;padding:0 10px;outline:none;";
	popup.appendChild(search);
	const list = document.createElement("div");
	list.style.cssText = "overflow:auto;display:flex;flex-direction:column;gap:5px;max-height:440px;padding-right:2px;";
	popup.appendChild(list);
	function renderList() {
		title.textContent = `设置变量 已选 ${selected.size} / ${MAX_VARIABLES}`;
		const needle = String(search.value || "").trim().toLowerCase();
		list.textContent = "";
		for (const option of options) {
			const value = String(option.value || "").trim();
			if (!value) continue;
			const parts = variableDisplayParts(option);
			if (needle && !`${parts.title} ${parts.source} ${parts.value} ${option.label || ""}`.toLowerCase().includes(needle)) continue;
			const order = [...selected].indexOf(value) + 1;
			const item = document.createElement("button");
			item.type = "button";
			item.style.cssText = `display:flex;align-items:center;gap:10px;text-align:left;border:0;border-radius:7px;padding:8px 10px;background:${order ? "#234a37" : "transparent"};color:#dce7e2;cursor:pointer;`;
			const mark = document.createElement("span");
			mark.textContent = order ? `x${order}` : "";
			mark.style.cssText = "width:24px;color:#7de39b;font-weight:900;";
			const text = document.createElement("span");
			text.innerHTML = `<b>${parts.title}</b><br><span style="color:#8fa3ad">${parts.source ? `${parts.source} · ` : ""}${parts.value}</span>`;
			item.append(mark, text);
			item.addEventListener("pointerdown", (event) => event.stopPropagation());
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (selected.has(value)) selected.delete(value);
				else if (selected.size < MAX_VARIABLES) selected.add(value);
				renderList();
			});
			list.appendChild(item);
		}
		if (!list.children.length) {
			const empty = document.createElement("div");
			empty.textContent = options.length ? "没有匹配的变量" : "当前工作流没有可选变量。请先添加 GJJ_SETNODE 或 GJJ_TemplateParams。";
			empty.style.cssText = "padding:16px 10px;color:#9aaab2;text-align:center;";
			list.appendChild(empty);
		}
	}
	search.addEventListener("input", renderList);
	popup.addEventListener("pointerdown", (event) => event.stopPropagation());
	document.body.appendChild(popup);
	node.__gjjConditionalRouteVariablePicker = popup;
	renderList();
	search.focus?.();
}

function updateVariableButton(node) {
	const button = node.__gjjConditionalRouteVariableButton;
	if (!button) return;
	const names = selectedVariables(node);
	button.textContent = names.length ? `⚡ 变量 ${names.length}` : "⚡ 设置变量和公式";
	button.title = names.length
		? `已选择：${names.map((name, index) => `x${index + 1}=${variableDisplayParts(variableOptionForName(node, name)).title || name}`).join("，")}；已按 x1 直接路由。`
		: "选择变量；未选择变量时可使用原生路由公式控件。";
	setButtonActive(button, variableCompactMode(node));
}

function ensurePanel(node) {
	if (node.__gjjConditionalRoutePanel) {
		updateVariableButton(node);
		return;
	}
	const container = document.createElement("div");
	container.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:1px 0 0;color:#dce7e2;overflow:visible;";
	const variableButton = createButton("⚡ 设置变量和公式", "选择变量；选择后直接按 x1 的值路由。", () => openVariablePicker(node));
	node.__gjjConditionalRouteVariableButton = variableButton;
	container.appendChild(variableButton);
	const widget = node.addDOMWidget?.("gjj_conditional_route_panel", "conditional_route_panel", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 28,
	});
	if (widget) widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 220)), 28];
	node.__gjjConditionalRoutePanel = widget || { element: container };
	updateVariableButton(node);
}

function stabilizeNode(node) {
	if (!node) return;
	removeInternalInputs(node);
	if (variableCompactMode(node)) {
		removeInputsByPrefix(node, CONDITION_PREFIX);
		hideFormulaWidget(node);
	} else {
		restoreFormulaWidget(node);
	}
	const needed = neededPairs(node);
	trimPairs(node, needed);
	ensurePairs(node, needed);
	applyLabels(node);
	hideVariableNamesWidget(node);
	syncVariableNamesWidget(node);
	ensureFormulaValue(node);
	orderStateWidgets(node);
	ensurePanel(node);
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjConditionalRouteTimer);
	node.__gjjConditionalRouteTimer = setTimeout(() => stabilizeNode(node), ms);
}

function signature(node) {
	const inPart = routeInputs(node).map((input) => `${input.name}:${input.link ?? ""}:${input.type ?? ""}`).join("|");
	const outPart = outputs(node).map((output) => `${output.name}:${(output.links || []).join(",")}:${output.type ?? ""}`).join("|");
	return `${inPart}=>${outPart}`;
}

function findNodeForPromptId(graph, promptId) {
	const id = String(promptId || "");
	const parts = id.split(":").filter(Boolean);
	const tail = parts.length ? parts[parts.length - 1] : id;
	const nodes = graph?._nodes || [];
	return nodes.find((node) => String(node?.id) === id) || nodes.find((node) => String(node?.id) === tail);
}

function resolveVariable(node, name) {
	const resolver = globalThis.GJJ_VariableBroadcast?.resolveVariableBroadcastSource;
	return typeof resolver === "function" ? resolver(node?.graph || app.graph, name) : null;
}

function getGraphNodeById(graph, id) {
	if (id == null || !graph) return null;
	return graph.getNodeById?.(id) || graph._nodes_by_id?.[id] || graph._nodes?.find((node) => String(node?.id) === String(id)) || null;
}

function getGraphLink(graph, linkId) {
	if (linkId == null || !graph) return null;
	if (typeof graph.getLink === "function") return graph.getLink(linkId);
	const links = graph.links || graph._links || {};
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function linkTargetId(link) {
	return Array.isArray(link) ? link[3] : link?.target_id;
}

function outputLinkIds(output) {
	if (!output) return [];
	if (Array.isArray(output.links)) return output.links.filter((item) => item != null);
	if (output.link != null) return [output.link];
	return [];
}

function parseJsonObject(value) {
	if (!value || typeof value === "object") return value && !Array.isArray(value) ? value : {};
	try {
		const parsed = JSON.parse(String(value));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function fieldCandidates(field) {
	return [
		field?.key,
		field?.broadcastKey,
		field?.inputName,
		field?.label,
		field?.displayLabel,
		...(Array.isArray(field?.broadcastKeys) ? field.broadcastKeys : []),
	].map((item) => String(item || "").trim()).filter(Boolean);
}

function findFieldForVariable(node, slot, name) {
	const props = node?.properties || {};
	const fields = Array.isArray(props.gjj_template_params_schema) ? props.gjj_template_params_schema
		: Array.isArray(props.gjj_template_set_variables_fields) ? props.gjj_template_set_variables_fields
			: [];
	const bySlot = fields.find((field) => Number(field?.outputIndex ?? field?.output_index ?? fields.indexOf(field)) === Number(slot));
	if (bySlot) return bySlot;
	return fields.find((field) => fieldCandidates(field).includes(name)) || null;
}

function valueFromTemplateNode(node, field, name) {
	const props = node?.properties || {};
	const values = parseJsonObject(props.gjj_template_params_values || props.gjj_template_set_variables_values);
	for (const key of fieldCandidates(field).concat(name)) {
		if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
	}
	const inputName = field?.inputName;
	if (inputName) {
		const input = node.inputs?.find((item) => item?.name === inputName);
		if (input?.link != null) return undefined;
	}
	return field?.value ?? field?.default ?? field?.defaultValue;
}

function widgetCurrentValue(widget) {
	if (!widget) return undefined;
	if (typeof widget.value !== "undefined") return widget.value;
	if (widget.inputEl) {
		if (widget.inputEl.type === "checkbox") return widget.inputEl.checked;
		if ("value" in widget.inputEl) return widget.inputEl.value;
	}
	if (widget.element) {
		if (widget.element.type === "checkbox") return widget.element.checked;
		if ("value" in widget.element) return widget.element.value;
	}
	return undefined;
}

function valueFromGenericSource(node, slot) {
	const output = node?.outputs?.[Number(slot || 0)];
	if (typeof output?.value !== "undefined") return output.value;
	const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
	if (widgets.length === 1) return widgetCurrentValue(widgets[0]);
	if (Array.isArray(node?.widgets_values) && node.widgets_values.length) return node.widgets_values[Number(slot || 0)] ?? node.widgets_values[0];
	return undefined;
}

function evaluateFirstVariableValue(node) {
	const name = selectedVariables(node)[0];
	if (!name) return undefined;
	const resolved = resolveVariable(node, name);
	if (!Array.isArray(resolved) || resolved.length !== 2) return undefined;
	const graph = node?.graph || app.graph;
	const source = getGraphNodeById(graph, resolved[0]);
	if (!source) return undefined;
	const sourceType = nodeType(source);
	if (sourceType === "GJJ_TemplateParams" || sourceType === "GJJ_TemplateSetVariables") {
		const field = findFieldForVariable(source, Number(resolved[1] || 0), name);
		return valueFromTemplateNode(source, field, name);
	}
	return valueFromGenericSource(source, Number(resolved[1] || 0));
}

function routeIndexesFromValue(value) {
	if (typeof value === "undefined" || value === null) return null;
	if (Array.isArray(value)) {
		const indexes = value.map((item) => routeIndexesFromValue(item)).filter(Boolean).flat();
		return indexes.length ? [...new Set(indexes)] : null;
	}
	if (typeof value === "boolean") return [value ? 1 : 0];
	if (typeof value === "number" && Number.isFinite(value)) return [Math.trunc(value)];
	const text = String(value).trim();
	if (!text) return null;
	if ((text.startsWith("[") || text.startsWith("(")) && (text.endsWith("]") || text.endsWith(")"))) {
		try {
			const parsed = JSON.parse(text.replace(/^\(/, "[").replace(/\)$/, "]"));
			return routeIndexesFromValue(parsed);
		} catch {
			// Fall through to comma splitting below.
		}
	}
	if (text.includes(",") || text.includes("，")) {
		const indexes = text.replace(/，/g, ",").split(",").map((part) => routeIndexesFromValue(part)).filter(Boolean).flat();
		return indexes.length ? [...new Set(indexes)] : null;
	}
	const numeric = Number(text);
	return Number.isFinite(numeric) ? [Math.trunc(numeric)] : null;
}

function collectDownstreamNodesFromOutput(node, outputIndex) {
	const graph = node?.graph || app.graph;
	const result = new Set();
	const queue = outputLinkIds(node?.outputs?.[outputIndex]).map((linkId) => getGraphLink(graph, linkId)).filter(Boolean);
	while (queue.length) {
		const link = queue.shift();
		const target = getGraphNodeById(graph, linkTargetId(link));
		if (!target || target === node || result.has(target)) continue;
		result.add(target);
		for (const output of target.outputs || []) {
			for (const linkId of outputLinkIds(output)) {
				const next = getGraphLink(graph, linkId);
				if (next) queue.push(next);
			}
		}
	}
	return result;
}

function collectRouteBypasses(graph) {
	const snapshots = [];
	for (const node of graph?._nodes || []) {
		if (!isTargetNode(node) || !variableCompactMode(node)) continue;
		const routeIndexes = routeIndexesFromValue(evaluateFirstVariableValue(node));
		if (!routeIndexes) continue;
		const selected = new Set(routeIndexes.filter((index) => index >= 1 && index <= MAX_PAIRS));
		const outs = outputs(node);
		const selectedDownstream = new Set();
		for (let index = 0; index < outs.length; index += 1) {
			if (!selected.has(index + 1)) continue;
			for (const target of collectDownstreamNodesFromOutput(node, index)) selectedDownstream.add(target);
		}
		for (let index = 0; index < outs.length; index += 1) {
			if (selected.has(index + 1)) continue;
			for (const target of collectDownstreamNodesFromOutput(node, index)) {
				if (selectedDownstream.has(target) || isTargetNode(target)) continue;
				if (snapshots.some((item) => item.node === target)) continue;
				snapshots.push({ node: target, mode: target.mode });
				target.mode = BYPASS_MODE;
			}
		}
	}
	return snapshots;
}

function restoreBypasses(snapshots) {
	for (const item of snapshots || []) {
		item.node.mode = item.mode;
	}
}

function patchVariablePrompt(promptResult, graph) {
	const output = promptResult?.output;
	if (!output) return promptResult;
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const node = findNodeForPromptId(graph, nodeId);
		if (!node || !TARGET_NODES.has(node.type || node.comfyClass) || !variableModeEnabled(node)) continue;
		const names = selectedVariables(node);
		if (!names.length) continue;
		nodeInfo.inputs = nodeInfo.inputs || {};
		const inputNames = {};
		names.slice(0, MAX_VARIABLES).forEach((name, index) => {
			const inputName = formatConditionName(index + 1);
			const aliases = variableAliases(node, name);
			inputNames[`x${index + 1}`] = aliases.length > 1 ? aliases : (aliases[0] || name);
			const resolved = resolveVariable(node, name);
			if (!Array.isArray(resolved) || resolved.length !== 2 || String(resolved[0]) === String(node.id)) return;
			nodeInfo.inputs[inputName] = [String(resolved[0]), Number(resolved[1] || 0)];
		});
		nodeInfo.inputs[VARIABLE_NAMES_WIDGET] = JSON.stringify(inputNames);
		nodeInfo.inputs[FORMULA_WIDGET] = "x1";
	}
	return promptResult;
}

function installPromptPatch() {
	if (!api.__gjjConditionalRouteVariableQueuePatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjConditionalRouteVariableQueuePatchInstalled = true;
		const originalQueuePrompt = api.queuePrompt.bind(api);
		api.queuePrompt = async function (...args) {
			patchVariablePrompt(args[1], app.rootGraph || app.graph);
			return originalQueuePrompt(...args);
		};
	}
	if (!app.__gjjConditionalRouteVariableGraphPatchInstalled && typeof app.graphToPrompt === "function") {
		app.__gjjConditionalRouteVariableGraphPatchInstalled = true;
		const originalGraphToPrompt = app.graphToPrompt.bind(app);
		app.graphToPrompt = async function (...args) {
			const promptGraph = args[0] || this.rootGraph || this.graph || app.rootGraph || app.graph;
			const snapshots = collectRouteBypasses(promptGraph);
			try {
				const result = await originalGraphToPrompt(...args);
				return patchVariablePrompt(result, promptGraph);
			} finally {
				restoreBypasses(snapshots);
			}
		};
	}
}

app.registerExtension({
	name: "Comfy.GJJ.ConditionalRouteSwitch",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

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

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			syncVariableNamesWidget(this);
			ensureFormulaValue(this);
			orderStateWidgets(this);
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			if (serializedNode) serializedNode.widgets_values = serializedWidgetValues(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalOnDrawBackground?.apply(this, args);
			const current = signature(this);
			if (current !== this.__gjjConditionalRouteSignature) {
				this.__gjjConditionalRouteSignature = current;
				scheduleStabilize(this, 0);
			}
			return result;
		};
	},

	setup() {
		installPromptPatch();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilizeNode(node);
		}
		if (!window.__gjjConditionalRouteVariableListener) {
			window.__gjjConditionalRouteVariableListener = true;
			window.addEventListener("gjj-variable-broadcast-updated", () => {
				for (const node of app.graph?._nodes || []) {
					if (TARGET_NODES.has(node?.comfyClass) && variableModeEnabled(node)) scheduleStabilize(node, 80);
				}
			});
		}
	},
});

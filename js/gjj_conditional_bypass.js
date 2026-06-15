import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_ConditionalBypass"]);
const INPUT_PREFIX = "value_";
const MAX_INPUTS = 3;
const MIN_VISIBLE_INPUTS = 1;
const VARIABLE_NAMES_WIDGET = "variable_names_json";
const VARIABLE_MODE_PROPERTY = "gjj_conditional_bypass_variable_mode";
const SELECTED_VARIABLES_PROPERTY = "gjj_conditional_bypass_selected_variables";
const INPUT_TOOLTIP = "动态条件输入。可在公式中使用 x1、x2、x3，或使用变量运算选择的变量显示名。";
const OUTPUT_DEFS = [
	{
		index: 0,
		type: "BOOLEAN",
		name: "条件通行",
		tooltip: "条件为真时输出 True；条件为假时阻断连接在此输出后的下游链路。",
	},
];

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

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	widget.value = value;
	if (widget.inputEl) widget.inputEl.value = value;
	widget.callback?.(value);
}

function inputHasLink(input) {
	return Boolean(input?.link);
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
	if (apiObject?.getVisibleSetOptions) {
		return apiObject.getVisibleSetOptions(graph) || [];
	}
	return [];
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

function setSelectedVariables(node, names) {
	node.properties = node.properties || {};
	node.properties[SELECTED_VARIABLES_PROPERTY] = uniqueNames(names).slice(0, MAX_INPUTS);
	node.properties[VARIABLE_MODE_PROPERTY] = Boolean(node.properties[SELECTED_VARIABLES_PROPERTY].length);
	syncVariableNamesWidget(node);
	closeVariablePicker(node);
	scheduleStabilize(node, 0);
}

function addDynamicInput(node, type = "*") {
	const nextIndex = getValueInputs(node).length + 1;
	if (nextIndex > MAX_INPUTS) {
		return;
	}
	node.addInput(formatInputName(nextIndex), type || "*");
}

function removeAllValueInputs(node) {
	for (let index = (node.inputs || []).length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (String(input?.name || "").startsWith(INPUT_PREFIX)) {
			node.removeInput(index);
		}
	}
}

function removeInternalInputs(node) {
	for (let index = (node.inputs || []).length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (String(input?.name || "") === VARIABLE_NAMES_WIDGET) {
			node.removeInput(index);
		}
	}
}

function removeUnusedInputsFromEnd(node) {
	const inputs = getValueInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_INPUTS; index -= 1) {
		const input = inputs[index];
		if (input?.link) {
			break;
		}
		const previous = inputs[index - 1];
		if (previous?.link) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
}

function ensureTrailingInput(node) {
	const inputs = getValueInputs(node);
	if (inputs.length === 0) {
		addDynamicInput(node);
		return;
	}
	if (inputs.length >= MAX_INPUTS) {
		return;
	}
	const lastInput = inputs[inputs.length - 1];
	if (lastInput?.link) {
		addDynamicInput(node, lastInput.type || "*");
	}
}

function renameInputsSequentially(node) {
	getValueInputs(node).forEach((input, index) => {
		const number = index + 1;
		input.name = formatInputName(number);
		input.label = `x${number}`;
		input.localized_name = `x${number}`;
		input.tooltip = INPUT_TOOLTIP;
	});
}

function getGraphLink(node, linkId) {
	if (linkId == null) return null;
	const graph = node?.graph || app.graph;
	const links = graph?.links || app.graph?.links;
	if (!links) return null;
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function getGraphNodeById(node, id) {
	const graph = node?.graph || app.graph;
	if (id == null || !graph) return null;
	return graph.getNodeById?.(id) || graph._nodes_by_id?.[id] || graph._nodes?.find((item) => String(item?.id) === String(id)) || null;
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkOriginSlot(link) {
	return Number(Array.isArray(link) ? link[2] : link?.origin_slot);
}

function ensureOutputs(node) {
	for (const def of OUTPUT_DEFS) {
		if (!node.outputs?.[def.index]) {
			node.addOutput?.(def.name, def.type);
		}
	}
	while ((node.outputs || []).length > OUTPUT_DEFS.length) {
		node.removeOutput?.(node.outputs.length - 1);
	}
	for (const def of OUTPUT_DEFS) {
		const output = node.outputs?.[def.index];
		if (!output) continue;
		output.name = def.name;
		output.label = def.name;
		output.localized_name = def.name;
		output.tooltip = def.tooltip;
		output.type = def.type;
	}
}

function hideVariableNamesWidget(node) {
	const widget = getWidget(node, VARIABLE_NAMES_WIDGET);
	if (!widget || widget.__gjjConditionalBypassHidden) {
		return;
	}
	widget.__gjjConditionalBypassHidden = true;
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

function createButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title || "";
	button.style.cssText = [
		"height:26px",
		"min-width:0",
		"border:1px solid #465960",
		"border-radius:6px",
		"background:#172026",
		"color:#dce7e2",
		"font:700 12px system-ui,'Microsoft YaHei',sans-serif",
		"padding:0 8px",
		"cursor:pointer",
		"white-space:nowrap",
	].join(";");
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
	node?.__gjjConditionalBypassVariablePicker?.remove?.();
	node.__gjjConditionalBypassVariablePicker = null;
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
	setWidgetValue(getWidget(node, VARIABLE_NAMES_WIDGET), JSON.stringify(data));
	return data;
}

function openVariablePicker(node) {
	closeVariablePicker(node);
	const options = variableOptions(node);
	const selected = new Set(selectedVariables(node));
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed",
		"z-index:10050",
		"width:min(520px,calc(100vw - 28px))",
		"max-height:min(620px,calc(100vh - 40px))",
		"overflow:hidden",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:12px",
		"border:1px solid #486575",
		"border-radius:8px",
		"background:#08151a",
		"box-shadow:0 18px 46px rgba(0,0,0,.55)",
		"color:#dce7e2",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	const rect = node.__gjjConditionalBypassVariableButton?.getBoundingClientRect?.() || { left: 24, bottom: 80 };
	popup.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - 540, rect.left || 24)))}px`;
	popup.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - 620, (rect.bottom || 80) + 6)))}px`;

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;gap:8px;";
	const title = document.createElement("div");
	title.style.cssText = "font-weight:800;flex:1 1 auto;";
	const clear = createButton("🧹 清空", "清空变量选择并恢复输入口", () => {
		selected.clear();
		renderList();
	});
	const done = createButton("✅ 完成", "使用当前变量选择", () => setSelectedVariables(node, [...selected]));
	const close = createButton("❌", "关闭", () => closeVariablePicker(node));
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
		title.textContent = `⚡ 条件变量  ✅ 已选 ${selected.size} / ${MAX_INPUTS}`;
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
			item.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:10px",
				"text-align:left",
				"border:0",
				"border-radius:7px",
				"padding:8px 10px",
				"background:" + (order ? "#234a37" : "transparent"),
				"color:#dce7e2",
				"cursor:pointer",
			].join(";");
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
				else if (selected.size < MAX_INPUTS) selected.add(value);
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
	node.__gjjConditionalBypassVariablePicker = popup;
	renderList();
	search.focus?.();
}

function updateVariableButton(node) {
	const button = node.__gjjConditionalBypassVariableButton;
	if (!button) return;
	const names = selectedVariables(node);
	button.textContent = names.length ? `⚡ 变量 ${names.length}` : "⚡ 变量运算";
	button.title = names.length
		? `已选择：${names.map((name, index) => `x${index + 1}=${variableDisplayParts(variableOptionForName(node, name)).title || name}`).join("，")}\n输入口已隐藏，公式可直接使用变量显示名。`
		: "选择 GJJ_SETNODE 或 GJJ_TemplateParams 变量参加公式条件运算";
	setButtonActive(button, variableCompactMode(node));
}

function measurePanel(node) {
	const widget = node?.__gjjConditionalBypassPanel;
	const container = widget?.element || widget;
	if (!container) return;
	clearTimeout(node.__gjjConditionalBypassMeasureTimer);
	node.__gjjConditionalBypassMeasureTimer = setTimeout(() => {
		requestAnimationFrame(() => {
			const height = Math.max(26, Math.ceil(container.scrollHeight || container.getBoundingClientRect?.().height || 26) + 2);
			if (node.__gjjConditionalBypassPanelHeight !== height) {
				node.__gjjConditionalBypassPanelHeight = height;
				setDirty(node);
			}
		});
	}, 20);
}

function ensurePanel(node) {
	if (node.__gjjConditionalBypassPanel) {
		updateVariableButton(node);
		measurePanel(node);
		return;
	}
	const container = document.createElement("div");
	container.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:1px 0 0;color:#dce7e2;overflow:visible;";
	const variableButton = createButton("⚡ 变量运算", "选择 GJJ_SETNODE 或 GJJ_TemplateParams 变量参加条件运算", () => openVariablePicker(node));
	node.__gjjConditionalBypassVariableButton = variableButton;
	container.appendChild(variableButton);
	const widget = node.addDOMWidget?.("gjj_conditional_bypass_panel", "conditional_bypass_panel", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(26, node.__gjjConditionalBypassPanelHeight || 26),
	});
	if (widget) {
		widget.computeSize = (width) => [
			Math.round(Number(width || node.size?.[0] || 220)),
			Math.round(Math.max(26, node.__gjjConditionalBypassPanelHeight || 26)),
		];
	}
	node.__gjjConditionalBypassPanel = widget || { element: container };
	updateVariableButton(node);
	measurePanel(node);
}

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function getLinkSignature(node) {
	return getValueInputs(node)
		.map((input) => `${input.name}:${input.link ?? ""}:${input.type ?? ""}`)
		.join("|");
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}

	removeInternalInputs(node);
	if (variableCompactMode(node)) {
		removeAllValueInputs(node);
	} else {
		removeUnusedInputsFromEnd(node);
		ensureTrailingInput(node);
		renameInputsSequentially(node);
	}
	ensureOutputs(node);
	hideVariableNamesWidget(node);
	syncVariableNamesWidget(node);
	ensurePanel(node);
	node.__gjjConditionalBypassLinkSignature = getLinkSignature(node);
	setDirty(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjConditionalBypassTimer);
	node.__gjjConditionalBypassTimer = setTimeout(() => stabilizeNode(node), ms);
}

function findConditionalBypassNodeForPromptId(graph, promptId) {
	const id = String(promptId || "");
	const nodes = graph?._nodes || [];
	const parts = id.split(":").filter(Boolean);
	const tail = parts.length ? parts[parts.length - 1] : id;
	return nodes.find((node) => String(node?.id) === id)
		|| nodes.find((node) => String(node?.id) === tail);
}

function resolveVariable(node, name) {
	const resolver = globalThis.GJJ_VariableBroadcast?.resolveVariableBroadcastSource;
	if (typeof resolver !== "function") {
		return null;
	}
	return resolver(node?.graph || app.graph, name);
}

function patchConditionalBypassVariablePrompt(promptResult, graph) {
	const output = promptResult?.output;
	if (!output) return promptResult;
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const node = findConditionalBypassNodeForPromptId(graph, nodeId);
		if (!node || !TARGET_NODES.has(node.type || node.comfyClass) || !variableModeEnabled(node)) {
			continue;
		}
		const names = selectedVariables(node);
		if (!names.length) continue;
		nodeInfo.inputs = nodeInfo.inputs || {};
		const inputNames = {};
		names.slice(0, MAX_INPUTS).forEach((name, index) => {
			const inputName = formatInputName(index + 1);
			const aliases = variableAliases(node, name);
			inputNames[`x${index + 1}`] = aliases.length > 1 ? aliases : (aliases[0] || name);
			const resolved = resolveVariable(node, name);
			if (!Array.isArray(resolved) || resolved.length !== 2 || String(resolved[0]) === String(node.id)) {
				return;
			}
			nodeInfo.inputs[inputName] = [String(resolved[0]), Number(resolved[1] || 0)];
		});
		nodeInfo.inputs[VARIABLE_NAMES_WIDGET] = JSON.stringify(inputNames);
	}
	return promptResult;
}

function installPromptPatch() {
	if (!api.__gjjConditionalBypassVariableQueuePatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjConditionalBypassVariableQueuePatchInstalled = true;
		const originalQueuePrompt = api.queuePrompt.bind(api);
		api.queuePrompt = async function (...args) {
			patchConditionalBypassVariablePrompt(args[1], app.rootGraph || app.graph);
			return originalQueuePrompt(...args);
		};
	}
	if (!app.__gjjConditionalBypassVariableGraphPatchInstalled && typeof app.graphToPrompt === "function") {
		app.__gjjConditionalBypassVariableGraphPatchInstalled = true;
		const originalGraphToPrompt = app.graphToPrompt.bind(app);
		app.graphToPrompt = async function (...args) {
			const result = await originalGraphToPrompt(...args);
			const promptGraph = args[0] || this.rootGraph || this.graph || app.rootGraph || app.graph;
			return patchConditionalBypassVariablePrompt(result, promptGraph);
		};
	}
}

app.registerExtension({
	name: "Comfy.GJJ.ConditionalBypass",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		nodeData.output = ["BOOLEAN"];
		nodeData.output_name = ["条件通行"];
		nodeData.output_tooltips = ["条件为真时输出 True；条件为假时阻断连接在此输出后的下游链路。"];

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
			return originalOnSerialize?.apply(this, [serializedNode, ...args]);
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
			const signature = getLinkSignature(this);
			if (signature !== this.__gjjConditionalBypassLinkSignature) {
				scheduleStabilize(this, 0);
			}
			return result;
		};
	},

	setup() {
		installPromptPatch();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
		if (!window.__gjjConditionalBypassVariableListener) {
			window.__gjjConditionalBypassVariableListener = true;
			window.addEventListener("gjj-variable-broadcast-updated", () => {
				for (const node of app.graph?._nodes || []) {
					if (TARGET_NODES.has(node?.comfyClass) && variableModeEnabled(node)) {
						scheduleStabilize(node, 80);
					}
				}
			});
		}
	},
});

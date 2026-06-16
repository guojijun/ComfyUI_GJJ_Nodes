import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODE = "GJJ_ConditionPassthrough";
const SELECTED_VARIABLE_PROPERTY = "gjj_condition_passthrough_variable";
const DOM_WIDGET = "gjj_condition_passthrough_dom";
const CONDITION_INPUT = "condition";
const INPUT_NAME = "input";
const OUTPUT_INDEX = 0;
const BYPASS_MODE = 4;

function nodeType(node) {
	return node?.type || node?.comfyClass || node?.constructor?.type || "";
}

function isTargetNode(node) {
	return nodeType(node) === TARGET_NODE || node?.comfyClass === TARGET_NODE;
}

function selectedVariable(node) {
	return String(node?.properties?.[SELECTED_VARIABLE_PROPERTY] || "").trim();
}

function setSelectedVariable(node, name) {
	node.properties = node.properties || {};
	const value = String(name || "").trim();
	if (value) node.properties[SELECTED_VARIABLE_PROPERTY] = value;
	else delete node.properties[SELECTED_VARIABLE_PROPERTY];
	updatePanel(node);
	refreshNode(node);
}

function variableOptions(node) {
	const apiObject = globalThis.GJJ_VariableBroadcast;
	const graph = node?.graph || app.graph;
	return typeof apiObject?.getVisibleSetOptions === "function" ? (apiObject.getVisibleSetOptions(graph) || []) : [];
}

function variableOption(node, name) {
	return variableOptions(node).find((item) => item.value === name) || { value: name, label: name };
}

function variableDisplay(option) {
	const value = String(option?.value || "").trim();
	const label = String(option?.label || value).trim();
	const match = label.match(/^[^()（）]+[（(]([^()（）]+?)[\s·]+([^()（）]+?)[）)]$/);
	if (match) return { title: match[2].trim() || value, source: match[1].trim(), value };
	const parts = String(option?.source || "").split(/\s*[·]\s*/).filter(Boolean);
	return { title: parts[1] || label || value, source: parts[0] || "", value };
}

function boolValue(value, fallback = true) {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	const text = String(value ?? "").trim().toLowerCase();
	if (!text) return fallback;
	if (["1", "true", "yes", "y", "on", "是", "真", "开", "启用"].includes(text)) return true;
	if (["0", "false", "no", "n", "off", "否", "假", "关", "禁用"].includes(text)) return false;
	return fallback;
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function getInput(node, name) {
	return node?.inputs?.find((input) => input?.name === name);
}

function inputHasLink(input) {
	if (!input) return false;
	if (Array.isArray(input.link)) return input.link.length > 0;
	return input.link != null;
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = value;
	widget.callback?.(value);
	if (widget.inputEl) {
		if (widget.inputEl.type === "checkbox") widget.inputEl.checked = Boolean(value);
		else widget.inputEl.value = value;
	}
	if (widget.element && "value" in widget.element) widget.element.value = value;
}

function resolveSelectedVariable(node) {
	const name = selectedVariable(node);
	const resolver = globalThis.GJJ_VariableBroadcast?.resolveVariableBroadcastSource;
	if (!name || typeof resolver !== "function") return null;
	return resolver(node?.graph || app.graph, name);
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
	} catch (_) {
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

function valueFromGenericBooleanSource(node, slot) {
	const output = node?.outputs?.[Number(slot || 0)];
	if (typeof output?.value !== "undefined") return output.value;
	const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
	const named = widgets.find((widget) => /bool|boolean|条件|启用|开关/i.test(String(widget?.name || widget?.label || "")));
	const namedValue = widgetCurrentValue(named);
	if (typeof namedValue !== "undefined") return namedValue;
	if ((String(output?.type || "").toUpperCase() === "BOOLEAN" || widgets.length === 1) && widgets[0]) {
		return widgetCurrentValue(widgets[0]);
	}
	if (Array.isArray(node?.widgets_values) && node.widgets_values.length) return node.widgets_values[0];
	return undefined;
}

function evaluateVariable(node) {
	const name = selectedVariable(node);
	if (!name) return true;
	const resolved = resolveSelectedVariable(node);
	if (!Array.isArray(resolved) || resolved.length !== 2) return true;
	const graph = node?.graph || app.graph;
	const source = getGraphNodeById(graph, resolved[0]);
	if (!source) return true;
	const sourceType = nodeType(source);
	if (sourceType === "GJJ_TemplateParams" || sourceType === "GJJ_TemplateSetVariables") {
		const field = findFieldForVariable(source, Number(resolved[1] || 0), name);
		const value = valueFromTemplateNode(source, field, name);
		return boolValue(value, true);
	}
	const sourceValue = valueFromGenericBooleanSource(source, Number(resolved[1] || 0));
	if (typeof sourceValue !== "undefined") return boolValue(sourceValue, true);
	return true;
}

function syncConditionInputVisibility(node) {
	if (!node || !Array.isArray(node.inputs)) return;
	const selected = selectedVariable(node);
	const index = node.inputs.findIndex((input) => input?.name === CONDITION_INPUT);
	const input = index >= 0 ? node.inputs[index] : null;
	if (selected && input) {
		try { node.removeInput?.(index); } catch (_) { node.inputs.splice(index, 1); }
		return;
	}
	if (!selected && index < 0) {
		node.addInput?.(CONDITION_INPUT, "BOOLEAN");
		const restored = getInput(node, CONDITION_INPUT);
		if (restored) {
			restored.label = "条件";
			restored.localized_name = "条件";
			restored.display_name = "条件";
			restored.tooltip = "可直接外接布尔值；使用 ⚡ 变量后此输入会隐藏，并在提交时自动接入变量。";
		}
	}
}

function collectDownstreamNodes(node) {
	const graph = node?.graph || app.graph;
	const result = new Set();
	const queue = outputLinkIds(node?.outputs?.[OUTPUT_INDEX]).map((linkId) => getGraphLink(graph, linkId));
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
	return [...result];
}

function collectFalseConditionBypasses(graph) {
	const snapshots = [];
	for (const node of graph?._nodes || []) {
		if (!isTargetNode(node) || evaluateVariable(node)) continue;
		for (const target of collectDownstreamNodes(node)) {
			if (isTargetNode(target)) continue;
			if (snapshots.some((item) => item.node === target)) continue;
			snapshots.push({ node: target, mode: target.mode });
			target.mode = BYPASS_MODE;
		}
	}
	return snapshots;
}

function restoreBypasses(snapshots) {
	for (const item of snapshots || []) {
		item.node.mode = item.mode;
	}
}

function findNodeForPromptId(graph, promptId) {
	const id = String(promptId || "");
	const nodes = graph?._nodes || [];
	const tail = id.split(":").filter(Boolean).pop() || id;
	return nodes.find((node) => String(node?.id) === id) || nodes.find((node) => String(node?.id) === tail) || null;
}

function patchConditionPrompt(promptResult, graph) {
	const output = promptResult?.output;
	if (!output) return promptResult;
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const node = findNodeForPromptId(graph, nodeId);
		if (!isTargetNode(node) || !selectedVariable(node)) continue;
		const resolved = resolveSelectedVariable(node);
		if (!Array.isArray(resolved) || resolved.length !== 2 || String(resolved[0]) === String(node.id)) continue;
		nodeInfo.inputs = nodeInfo.inputs || {};
		nodeInfo.inputs[CONDITION_INPUT] = [String(resolved[0]), Number(resolved[1] || 0)];
	}
	return promptResult;
}

function installPromptPatch() {
	if (!api.__gjjConditionPassthroughQueuePatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjConditionPassthroughQueuePatchInstalled = true;
		const originalQueuePrompt = api.queuePrompt.bind(api);
		api.queuePrompt = async function (...args) {
			patchConditionPrompt(args[1], app.rootGraph || app.graph);
			return originalQueuePrompt(...args);
		};
	}
	if (!app.__gjjConditionPassthroughGraphPatchInstalled && typeof app.graphToPrompt === "function") {
		app.__gjjConditionPassthroughGraphPatchInstalled = true;
		const originalGraphToPrompt = app.graphToPrompt.bind(app);
		app.graphToPrompt = async function (...args) {
			const graph = args[0] || this.rootGraph || this.graph || app.rootGraph || app.graph;
			const snapshots = collectFalseConditionBypasses(graph);
			try {
				const result = await originalGraphToPrompt(...args);
				return patchConditionPrompt(result, graph);
			} finally {
				restoreBypasses(snapshots);
			}
		};
	}
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function closeVariablePicker(node) {
	node?.__gjjConditionPassthroughPicker?.remove?.();
	node.__gjjConditionPassthroughPicker = null;
}

function openVariablePicker(node) {
	closeVariablePicker(node);
	const options = variableOptions(node);
	const current = selectedVariable(node);
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed",
		"z-index:10050",
		"width:min(460px,calc(100vw - 28px))",
		"max-height:min(560px,calc(100vh - 40px))",
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
	const rect = node.__gjjConditionPassthroughButton?.getBoundingClientRect?.() || { left: 24, bottom: 80 };
	popup.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - 480, rect.left || 24)))}px`;
	popup.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - 560, (rect.bottom || 80) + 6)))}px`;

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;gap:8px;";
	const title = document.createElement("div");
	title.textContent = "⚡ 选择布尔变量";
	title.style.cssText = "font-weight:800;flex:1 1 auto;";
	const clear = createSmallButton("清空", () => {
		setSelectedVariable(node, "");
		closeVariablePicker(node);
	});
	const close = createSmallButton("×", () => closeVariablePicker(node));
	header.append(title, clear, close);
	popup.appendChild(header);

	const search = document.createElement("input");
	search.placeholder = "搜索 GJJ_TemplateParams / GJJ_SETNODE 布尔变量";
	search.style.cssText = "height:32px;border:1px solid #3f5b66;border-radius:7px;background:#071015;color:#dce7e2;padding:0 10px;outline:none;";
	popup.appendChild(search);

	const list = document.createElement("div");
	list.style.cssText = "overflow:auto;display:flex;flex-direction:column;gap:5px;max-height:400px;padding-right:2px;";
	popup.appendChild(list);

	function render() {
		const needle = String(search.value || "").trim().toLowerCase();
		list.textContent = "";
		for (const option of options) {
			const parts = variableDisplay(option);
			if (!parts.value) continue;
			if (needle && !`${parts.title} ${parts.source} ${parts.value} ${option.label || ""}`.toLowerCase().includes(needle)) continue;
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
				"background:" + (current === parts.value ? "#234a37" : "transparent"),
				"color:#dce7e2",
				"cursor:pointer",
			].join(";");
			const mark = document.createElement("span");
			mark.textContent = current === parts.value ? "✓" : "";
			mark.style.cssText = "width:18px;color:#7de39b;font-weight:900;";
			const text = document.createElement("span");
			text.innerHTML = `<b>${parts.title}</b><br><span style="color:#8fa3ad">${parts.source ? `${parts.source} · ` : ""}${parts.value}</span>`;
			item.append(mark, text);
			item.addEventListener("pointerdown", (event) => event.stopPropagation());
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				setSelectedVariable(node, parts.value);
				closeVariablePicker(node);
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
	search.addEventListener("input", render);
	popup.addEventListener("pointerdown", (event) => event.stopPropagation());
	document.body.appendChild(popup);
	node.__gjjConditionPassthroughPicker = popup;
	render();
	search.focus?.();
}

function createSmallButton(label, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.style.cssText = "height:28px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:650;";
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	return button;
}

function ensurePanel(node) {
	if (node.__gjjConditionPassthroughWidget) return;
	const root = document.createElement("div");
	root.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0;padding:1px 0;color:#dce7e2;font:12px system-ui,'Microsoft YaHei',sans-serif;";
	const button = createSmallButton("⚡ 变量", () => openVariablePicker(node));
	button.style.maxWidth = "168px";
	button.style.overflow = "hidden";
	button.style.textOverflow = "ellipsis";
	button.style.whiteSpace = "nowrap";
	const status = document.createElement("span");
	status.style.cssText = "min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#93a5ad;";
	root.append(button, status);
	node.__gjjConditionPassthroughButton = button;
	node.__gjjConditionPassthroughStatus = status;
	const widget = node.addDOMWidget?.(DOM_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 28,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 240)), 28];
		node.__gjjConditionPassthroughWidget = widget;
	}
	updatePanel(node);
}

function updatePanel(node) {
	const button = node.__gjjConditionPassthroughButton;
	const status = node.__gjjConditionPassthroughStatus;
	if (!button || !status) return;
	const selected = selectedVariable(node);
	if (!selected) {
		button.textContent = "⚡ 变量";
		button.title = "从 GJJ_TemplateParams 或 GJJ_SETNODE 选择布尔变量";
		button.style.background = "#202b31";
		button.style.borderColor = "#44565f";
		status.textContent = "未选择变量，默认透传";
		return;
	}
	const display = variableDisplay(variableOption(node, selected));
	const value = evaluateVariable(node);
	button.textContent = `⚡ ${display.title || selected}`;
	button.title = `已选择变量：${display.title || selected}\n实际变量名：${selected}`;
	button.style.background = value ? "#20362f" : "#3a211f";
	button.style.borderColor = value ? "#69b980" : "#b36a5f";
	status.textContent = value ? "真：透传" : "假：提交时旁路下游";
	status.style.color = value ? "#9bd8aa" : "#ffb4a8";
}

function ensurePorts(node) {
	if (node?.inputs) {
		for (const input of node.inputs) {
			if (input.name === INPUT_NAME) {
				input.label = "任意输入";
				input.localized_name = "任意输入";
				input.type = "*";
			}
			if (input.name === CONDITION_INPUT) {
				input.label = "条件";
				input.localized_name = "条件";
				input.type = "BOOLEAN";
			}
		}
	}
	if (node?.outputs?.[OUTPUT_INDEX]) {
		const output = node.outputs[OUTPUT_INDEX];
		output.name = "任意输出";
		output.label = "任意输出";
		output.localized_name = "任意输出";
		output.type = "*";
	}
}

function stabilize(node) {
	if (!node) return;
	ensurePorts(node);
	syncConditionInputVisibility(node);
	ensurePanel(node);
	updatePanel(node);
	setWidgetValue(node, CONDITION_INPUT, evaluateVariable(node));
	refreshNode(node);
}

function scheduleStabilize(node, ms = 0) {
	clearTimeout(node.__gjjConditionPassthroughTimer);
	node.__gjjConditionPassthroughTimer = setTimeout(() => stabilize(node), Math.round(Number(ms) || 0));
}

app.registerExtension({
	name: "Comfy.GJJ.ConditionPassthrough",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;

		nodeData.output = ["*"];
		nodeData.output_name = ["任意输出"];
		nodeData.output_tooltips = ["条件为真时原样透传；条件为假时提交前临时旁路下游链路。"];

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			if (serializedNode?.properties?.[SELECTED_VARIABLE_PROPERTY]) {
				this.properties = this.properties || {};
				this.properties[SELECTED_VARIABLE_PROPERTY] = serializedNode.properties[SELECTED_VARIABLE_PROPERTY];
			}
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				if (selectedVariable(this)) serializedNode.properties[SELECTED_VARIABLE_PROPERTY] = selectedVariable(this);
				else delete serializedNode.properties[SELECTED_VARIABLE_PROPERTY];
			}
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};
	},

	nodeCreated(node) {
		if (isTargetNode(node)) scheduleStabilize(node, 0);
	},

	setup() {
		installPromptPatch();
		if (!window.__gjjConditionPassthroughVariableListener) {
			window.__gjjConditionPassthroughVariableListener = true;
			const refresh = () => {
				for (const node of app.graph?._nodes || []) {
					if (isTargetNode(node)) scheduleStabilize(node, 80);
				}
			};
			window.addEventListener("gjj-variable-broadcast-updated", refresh);
			window.addEventListener("gjj-template-params-updated", refresh);
		}
		for (const node of app.graph?._nodes || []) {
			if (isTargetNode(node)) stabilize(node);
		}
	},
});

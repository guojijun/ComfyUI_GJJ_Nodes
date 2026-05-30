import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { GJJ_STANDARDIZE_NODE } from "./gjj_common_node_standardizer.js";

const SET_TYPE = "GJJ_SetNode";
const GET_TYPE = "GJJ_GetNode";
const TEMPLATE_SET_TYPE = "GJJ_TemplateSetVariables";
const TEMPLATE_FIELD_SCHEMA = "gjj_template_set_variables_fields";
const TEMPLATE_SAVED_TEMPLATE = "gjj_template_set_variables_template";
const TEMPLATE_WIDGET = "template_text";
const GET_SELECTION_PROPERTY = "gjj_getnode_selected_names";
const GET_SELECTOR_WIDGET = "gjj_getnode_multi_selector";
const GET_STORAGE_WIDGET = "变量名";
const GET_SELECTION_SEPARATOR = "\n";
const GET_STYLE_ID = "gjj-set-get-node-style";
const SLOT_PREFIX = "value_";
const MIN_VISIBLE_SLOTS = 1;
const SET_TITLE = "GJJ · 📌 变量设置";
const GET_TITLE = "GJJ · 📍 变量读取";
const SET_CATEGORY = "GJJ/工具";
const GET_CATEGORY = "GJJ/工具";
const SET_DESCRIPTION = "把连接到本节点的值登记为 GJJ 变量，供配对的变量读取节点跨位置取用；连接最后一个输入口会自动增加新输入。";
const GET_DESCRIPTION = "从同一工作流作用域内的 GJJ 变量设置或模板变量设置节点读取已选择变量，可一次选择多个变量并按来源动态生成输出口。";
const GET_SELECTOR_TOOLTIP = "选择要读取的 GJJ 变量；支持多选，输出口会按选择内容和变量来源自动刷新。";
const GET_OUTPUT_TOOLTIP = "输出已选择变量的真实值；提交工作流时会解析到对应变量设置或模板变量设置节点。";
const DEFAULT_COLOR = "#1B252B";
const DEFAULT_BG = "#141B1F";

const pasteRenameMap = new Map();
let setNameSourceMap = new Map();
let activeGetSelectPopup = null;

GJJ_STANDARDIZE_NODE({
	nodeClass: SET_TYPE,
	displayName: SET_TITLE,
	category: SET_CATEGORY,
	description: SET_DESCRIPTION,
});

GJJ_STANDARDIZE_NODE({
	nodeClass: GET_TYPE,
	displayName: GET_TITLE,
	category: GET_CATEGORY,
	description: GET_DESCRIPTION,
});

function props(node) {
	node.properties = node.properties || {};
	return node.properties;
}

function ensureStyles() {
	if (document.getElementById(GET_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = GET_STYLE_ID;
	style.textContent = `
.gjj-getnode-popup{position:fixed;z-index:100000;min-width:260px;max-width:min(420px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 24px));display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #45606a;border-radius:8px;background:#10191e;color:#dce7e2;box-shadow:0 12px 32px rgba(0,0,0,.45);font-family:system-ui,"Microsoft YaHei",sans-serif;}
.gjj-getnode-search{height:26px;box-sizing:border-box;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 8px;font-size:12px;outline:none;}
.gjj-getnode-list{overflow:auto;max-height:380px;display:flex;flex-direction:column;gap:2px;padding-right:2px;}
.gjj-getnode-item{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;border:0;border-radius:6px;background:transparent;color:#dce7e2;text-align:left;padding:5px 6px;cursor:pointer;font-size:12px;}
.gjj-getnode-item:hover{background:#1f2c33;}
.gjj-getnode-item.active{background:#243c32;color:#d9ffe4;}
.gjj-getnode-check{width:14px;flex:0 0 14px;color:#7bd88f;font-weight:800;text-align:center;}
.gjj-getnode-main{min-width:0;display:flex;flex-direction:column;gap:1px;}
.gjj-getnode-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gjj-getnode-meta{color:#8fa2aa;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gjj-getnode-actions{display:flex;align-items:center;justify-content:space-between;gap:6px;border-top:1px solid #263842;padding-top:6px;}
.gjj-getnode-action{height:24px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;font-size:12px;cursor:pointer;padding:0 8px;}
.gjj-getnode-action:hover{background:#263844;}
.gjj-getnode-count{color:#9fb0b7;font-size:11px;white-space:nowrap;}
`;
	document.head.appendChild(style);
}

function closeGetSelectPopup() {
	if (activeGetSelectPopup?.remove) activeGetSelectPopup.remove();
	activeGetSelectPopup = null;
}

if (!window.__gjjGetNodePopupCloseBound) {
	window.__gjjGetNodePopupCloseBound = true;
	document.addEventListener("pointerdown", (event) => {
		if (activeGetSelectPopup && !activeGetSelectPopup.contains(event.target)) {
			closeGetSelectPopup();
		}
	});
}

function nodeType(node) {
	return node?.type || node?.comfyClass || node?.constructor?.type || "";
}

function isTemplateSetNode(node) {
	return nodeType(node) === TEMPLATE_SET_TYPE || node?.comfyClass === TEMPLATE_SET_TYPE;
}

function normalizeTemplateSocketType(value) {
	let text = String(value || "").trim();
	if (!text) return "";
	text = text.replace(/，/g, ",").replace(/\s+/g, "");
	if (/^(any|\*)$/i.test(text)) return "*";
	return text.toUpperCase();
}

function inferTemplateValueType(rawText) {
	const raw = String(rawText ?? "").trim();
	if (/^\s*(int)\s*\(/i.test(raw) || /^[-+]?\d+$/.test(raw)) return "INT";
	if (/^\s*(float)\s*\(/i.test(raw) || /^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) || /^[-+]?\d+[eE][-+]?\d+$/.test(raw)) return "FLOAT";
	if (/^\s*(bool|boolean)\s*\(/i.test(raw) || /^(true|false|yes|no|on|off|是|否|真|假|开|关)$/i.test(raw)) return "BOOLEAN";
	if (/^\s*(str|string)\s*\(/i.test(raw)) return "STRING";
	return "STRING";
}

function splitTemplateLabelAndType(rawLabel) {
	const label = String(rawLabel || "").trim();
	const match = label.match(/\s*(?:\[\s*([^\]]+?)\s*\]|【\s*([^】]+?)\s*】)\s*$/);
	if (!match) return { label, type: "" };
	return {
		label: label.slice(0, match.index).trim(),
		type: normalizeTemplateSocketType(match[1] || match[2] || ""),
	};
}

function parseTemplateLabelAndKey(rawLabel, index) {
	let label = String(rawLabel || "").trim() || `变量 ${index + 1}`;
	const explicit = label.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
	if (!explicit) {
		const key = label.replace(/[^0-9A-Za-z_\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "") || `var_${index + 1}`;
		return { label, key };
	}
	label = explicit[1].trim() || label;
	const key = explicit[2].trim().replace(/[^0-9A-Za-z_\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "") || `var_${index + 1}`;
	return { label, key };
}

function parseTemplateSetFields(templateText) {
	const fields = [];
	const seen = new Map();
	for (const rawLine of String(templateText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("....")) continue;
		const match = line.match(/^([^:：=]+?)\s*[:：=]\s*(.*?)\s*$/);
		const leftText = match ? match[1] : line;
		const rightText = match ? match[2] : "";
		const { label: typedLabel, type: explicitType } = splitTemplateLabelAndType(leftText);
		let { label, key } = parseTemplateLabelAndKey(typedLabel, fields.length);
		const count = seen.get(key) || 0;
		seen.set(key, count + 1);
		if (count) key = `${key}_${count + 1}`;
		const type = explicitType || inferTemplateValueType(rightText);
		fields.push({
			key,
			label,
			displayLabel: label === key ? label : `${label}（${key}）`,
			type,
			inputName: `var_${key}`,
			outputIndex: fields.length,
		});
	}
	return fields;
}

function formatSlotName(index) {
	return `${SLOT_PREFIX}${String(index).padStart(2, "0")}`;
}

function splitSelectedNames(value) {
	if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
	const text = String(value ?? "").trim();
	if (!text) return [];
	if (text.startsWith("[") && text.endsWith("]")) {
		try {
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed)) return splitSelectedNames(parsed);
		} catch (_) {}
	}
	return text.split(/\n|[,，;；|]/).map((item) => item.trim()).filter(Boolean);
}

function uniqueNames(names) {
	const clean = [];
	const seen = new Set();
	for (const name of splitSelectedNames(names)) {
		if (seen.has(name)) continue;
		seen.add(name);
		clean.push(name);
	}
	return clean;
}

function getNameWidget(node) {
	return node?.widgets?.find((widget) => widget?.name === GET_STORAGE_WIDGET || widget?.label === GET_STORAGE_WIDGET) || node?.widgets?.[0];
}

function getSelectedNames(node) {
	const saved = props(node)[GET_SELECTION_PROPERTY];
	const fromSaved = uniqueNames(saved);
	if (fromSaved.length) return fromSaved;
	return uniqueNames(getNameWidget(node)?.value || "");
}

function selectedValueText(names) {
	return uniqueNames(names).join(GET_SELECTION_SEPARATOR);
}

function setSelectedNames(node, names, stabilize = true) {
	const clean = uniqueNames(names);
	props(node)[GET_SELECTION_PROPERTY] = clean;
	const widget = getNameWidget(node);
	if (widget) widget.value = selectedValueText(clean);
	updateGetSelectorWidget(node);
	if (stabilize && !app.configuringGraph) stabilizeGetNode(node);
	else setDirty(node);
}

function replaceSelectedName(node, oldName, newName) {
	const next = getSelectedNames(node).map((name) => name === oldName ? newName : name);
	setSelectedNames(node, next);
}

function getSlotIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(SLOT_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(SLOT_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getGraphLinks(graph) {
	return graph?.links || graph?._links || {};
}

function getLink(graph, linkId) {
	if (linkId == null) {
		return null;
	}
	if (graph?.getLink) {
		return graph.getLink(linkId);
	}
	const links = getGraphLinks(graph);
	return links instanceof Map ? links.get(linkId) : links?.[linkId] ?? null;
}

function sortedInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs].sort((a, b) => getSlotIndex(a?.name) - getSlotIndex(b?.name))
		: [];
}

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function applyNodeDescription(node, description) {
	if (!node) return;
	node.desc = description;
	node.description = description;
	node.tooltip = description;
}

function applyRegisteredNodeTypeMetadata(type, title, category, description) {
	const registered = globalThis.LiteGraph?.registered_node_types?.[type];
	for (const target of [registered, registered?.prototype].filter(Boolean)) {
		target.title = title;
		target.category = category;
		target.desc = description;
		target.description = description;
		target.display_name = title;
		target.tooltip = description;
	}
}

function findRootGraph(graph) {
	return graph?.rootGraph || graph || null;
}

function findNodeByAnyId(graph, id) {
	const idText = String(id);
	for (const scopeGraph of collectAllGraphs(findRootGraph(graph))) {
		const node = scopeGraph?._nodes?.find((candidate) => String(candidate?.id) === idText);
		if (node) {
			return { node, graph: scopeGraph };
		}
	}
	return null;
}

function getGraphAncestors(graph) {
	if (!graph) {
		return [];
	}
	const root = findRootGraph(graph);
	if (!root || graph === root) {
		return [graph];
	}
	const chain = [graph];
	const visited = new Set([graph]);
	let current = graph;
	while (current !== root) {
		let foundParent = false;
		for (const candidate of collectAllGraphs(root)) {
			if (!candidate?._nodes || candidate === current) {
				continue;
			}
			for (const node of candidate._nodes) {
				if (node?.subgraph === current) {
					if (!visited.has(candidate)) {
						visited.add(candidate);
						chain.push(candidate);
					}
					current = candidate;
					foundParent = true;
					break;
				}
			}
			if (foundParent) {
				break;
			}
		}
		if (!foundParent) {
			if (root && !chain.includes(root)) {
				chain.push(root);
			}
			break;
		}
	}
	return chain;
}

function collectAllGraphs(root) {
	const graphs = [];
	const seen = new Set();
	function visit(graph) {
		if (!graph || seen.has(graph)) {
			return;
		}
		seen.add(graph);
		graphs.push(graph);
		for (const node of graph._nodes || []) {
			if (node?.subgraph) {
				visit(node.subgraph);
			}
		}
		const subgraphs = graph._subgraphs || graph.subgraphs;
		if (subgraphs?.values) {
			for (const subgraph of subgraphs.values()) {
				visit(subgraph);
			}
		}
	}
	visit(root);
	return graphs;
}

function collectNodesOfType(graphs, type) {
	const results = [];
	for (const graph of graphs) {
		for (const node of graph?._nodes || []) {
			if (node?.type === type) {
				results.push({ node, graph });
			}
		}
	}
	return results;
}

function collectTemplateSetNodes(graphs) {
	const results = [];
	for (const graph of graphs) {
		for (const node of graph?._nodes || []) {
			if (isTemplateSetNode(node)) {
				results.push({ node, graph });
			}
		}
	}
	return results;
}

function getWidgetValue(node, name, fallback = "") {
	const widget = node?.widgets?.find((item) => item?.name === name);
	return String(widget?.value ?? fallback ?? "");
}

function templateFieldsForNode(node) {
	const schema = node?.properties?.[TEMPLATE_FIELD_SCHEMA];
	if (Array.isArray(schema) && schema.length) {
		return schema.map((field, index) => {
			const key = String(field?.key || field?.name || `var_${index + 1}`).trim();
			const label = String(field?.label || key).trim();
			return {
				key,
				label,
				displayLabel: String(field?.displayLabel || (label === key ? label : `${label}（${key}）`)),
				type: normalizeTemplateSocketType(field?.type || "*") || "*",
				inputName: String(field?.inputName || `var_${key}`),
				outputIndex: Number.isFinite(Number(field?.outputIndex)) ? Number(field.outputIndex) : index,
			};
		}).filter((field) => field.key);
	}
	const template = getWidgetValue(node, TEMPLATE_WIDGET, node?.properties?.[TEMPLATE_SAVED_TEMPLATE] || "");
	return parseTemplateSetFields(template);
}

function collectTemplateSetFields(graphs) {
	const results = [];
	for (const entry of collectTemplateSetNodes(graphs)) {
		for (const field of templateFieldsForNode(entry.node)) {
			results.push({ ...entry, field, kind: "template" });
		}
	}
	return results;
}

function findSetterByName(graph, name) {
	if (!name) {
		return null;
	}
	for (const scopeGraph of getGraphAncestors(graph)) {
		const setter = scopeGraph?._nodes?.find(
			(node) => node?.type === SET_TYPE && node.widgets?.[0]?.value === name
		);
		if (setter) {
			return { node: setter, graph: scopeGraph, kind: "set" };
		}
	}
	for (const entry of collectTemplateSetFields(getGraphAncestors(graph))) {
		if (entry.field.key === name || entry.field.label === name || entry.field.displayLabel === name) {
			return entry;
		}
	}
	return null;
}

function findGettersByName(graph, name) {
	if (!name) {
		return [];
	}
	const root = findRootGraph(graph);
	return collectNodesOfType(collectAllGraphs(root), GET_TYPE).filter(
		(entry) => getSelectedNames(entry.node).includes(name)
	);
}

function getVisibleSetNames(graph) {
	const sourceMap = new Map();
	for (const entry of collectNodesOfType(getGraphAncestors(graph), SET_TYPE)) {
		const name = entry.node.widgets?.[0]?.value;
		if (!name || sourceMap.has(name)) {
			continue;
		}
		sourceMap.set(name, entry.graph === graph ? "local" : "parent");
	}
	for (const entry of collectTemplateSetFields(getGraphAncestors(graph))) {
		const name = entry.field.key;
		if (!name || sourceMap.has(name)) {
			continue;
		}
		const prefix = entry.graph === graph ? "模板" : "parent 模板";
		sourceMap.set(name, `${prefix} · ${entry.field.label}`);
	}
	setNameSourceMap = sourceMap;
	return [...sourceMap.keys()].sort((a, b) => a.localeCompare(b));
}

function getVisibleSetOptions(graph) {
	const names = getVisibleSetNames(graph);
	return names.map((value) => {
		const source = setNameSourceMap.get(value);
		return {
			value,
			label: source && source !== "local" ? `${value} (${source})` : value,
			source: source || "local",
		};
	});
}

function labelForSelectedName(node, name) {
	const option = getVisibleSetOptions(node?.graph).find((item) => item.value === name);
	return option?.label || name;
}

function selectionSummary(node) {
	const names = getSelectedNames(node);
	if (!names.length) return "选择变量";
	if (names.length === 1) return labelForSelectedName(node, names[0]);
	const first = labelForSelectedName(node, names[0]);
	return `已选 ${names.length} 个：${first}${names.length > 1 ? " ..." : ""}`;
}

function getLinkedOutputInfo(node, input) {
	const link = getLink(node.graph, input?.link);
	const sourceNode = link?.origin_id != null ? node.graph?.getNodeById?.(link.origin_id) : null;
	const sourceSlot = sourceNode?.outputs?.[link?.origin_slot];
	if (!sourceSlot) {
		return null;
	}
	return {
		type: sourceSlot.type || "*",
		name: sourceSlot.name || sourceSlot.label || sourceSlot.type || "*",
	};
}

function getLinkedTargetInfo(node, output) {
	for (const linkId of output?.links || []) {
		const link = getLink(node.graph, linkId);
		const targetNode = link?.target_id != null ? node.graph?.getNodeById?.(link.target_id) : null;
		const targetSlot = targetNode?.inputs?.[link?.target_slot];
		if (targetSlot) {
			return {
				type: targetSlot.type || "*",
				name: targetSlot.name || targetSlot.label || targetSlot.type || "*",
			};
		}
	}
	return null;
}

function getLinkedGetterTargetInfo(setNode, slotIndex) {
	const name = setNode?.widgets?.[0]?.value;
	if (!name || !setNode?.graph) {
		return null;
	}
	for (const { node: getter } of findGettersByName(setNode.graph, name)) {
		const output = getter.outputs?.[getGetterOutputIndexForSetSlot(getter, setNode, slotIndex)];
		const info = getLinkedTargetInfo(getter, output);
		if (info) {
			return info;
		}
	}
	return null;
}

function isSetSlotUsedByGetter(setNode, slotIndex) {
	const name = setNode?.widgets?.[0]?.value;
	if (!name || !setNode?.graph) {
		return false;
	}
	for (const { node: getter } of findGettersByName(setNode.graph, name)) {
		const output = getter.outputs?.[getGetterOutputIndexForSetSlot(getter, setNode, slotIndex)];
		if (Array.isArray(output?.links) && output.links.length > 0) {
			return true;
		}
	}
	return false;
}

function getGetterOutputIndexForSetSlot(getter, setNode, slotIndex) {
	let offset = 0;
	for (const name of getSelectedNames(getter)) {
		const entry = findSetterByName(getter.graph, name);
		if (!entry) continue;
		if (entry.kind === "template") {
			offset += 1;
			continue;
		}
		const count = Math.max(MIN_VISIBLE_SLOTS, sortedInputs(entry.node).length);
		if (entry.node === setNode) {
			return offset + slotIndex;
		}
		offset += count;
	}
	return slotIndex;
}

function slotInfoForSetInput(node, input, index) {
	const linked = getLinkedOutputInfo(node, input);
	if (linked) {
		return linked;
	}
	const output = node.outputs?.[index];
	const target = getLinkedTargetInfo(node, output);
	if (target) {
		return target;
	}
	const getterTarget = getLinkedGetterTargetInfo(node, index);
	if (getterTarget) {
		return getterTarget;
	}
	return {
		type: input?.type || output?.type || "*",
		name: input?.label || output?.label || input?.name || output?.name || formatSlotName(index + 1),
	};
}

function slotInfoForTemplateField(entry) {
	const field = entry?.field || {};
	return {
		type: field.type || "*",
		name: field.displayLabel || field.label || field.key || "模板变量",
	};
}

function sourceSlotsForName(graph, name, multiMode = false) {
	const entry = findSetterByName(graph, name);
	if (!entry) return [];
	if (entry.kind === "template") {
		const info = slotInfoForTemplateField(entry);
		return [{
			entry,
			sourceSlot: Number(entry.field?.outputIndex || 0),
			inputName: entry.field?.inputName || "",
			info: {
				...info,
				name: multiMode ? info.name : info.name,
			},
		}];
	}
	const setter = entry.node;
	const setterInputs = sortedInputs(setter);
	const count = Math.max(MIN_VISIBLE_SLOTS, setterInputs.length);
	const result = [];
	for (let index = 0; index < count; index += 1) {
		const setterInput = setterInputs[index];
		const info = setterInput
			? slotInfoForSetInput(setter, setterInput, index)
			: { type: "*", name: `值 ${index + 1}` };
		const displayName = info.name && info.name !== "*" ? String(info.name) : `值 ${index + 1}`;
		result.push({
			entry,
			sourceSlot: index,
			info: {
				type: info.type || "*",
				name: multiMode ? `${name} · ${displayName}` : displayName,
			},
		});
	}
	return result;
}

function sourceSlotsForGetNode(node) {
	const names = getSelectedNames(node);
	const multiMode = names.length > 1;
	const slots = [];
	for (const name of names) {
		slots.push(...sourceSlotsForName(node.graph, name, multiMode));
	}
	return slots;
}

function resolveSetPromptSource(setter, slotIndex) {
	const input = sortedInputs(setter)[Number(slotIndex) || 0];
	const link = getLink(setter?.graph, input?.link);
	if (!link) {
		return null;
	}
	return [String(link.origin_id), Number(link.origin_slot || 0)];
}

function resolveTemplatePromptSource(source) {
	const setter = source?.entry?.node;
	const setterGraph = source?.entry?.graph || setter?.graph;
	if (!setter) {
		return null;
	}
	const input = setter.inputs?.find((item) => item?.name === source.inputName);
	const link = getLink(setterGraph, input?.link);
	if (link) {
		return [String(link.origin_id), Number(link.origin_slot || 0)];
	}
	return [String(setter.id), Number(source.sourceSlot || 0)];
}

function resolveGetPromptSource(getter, slotIndex) {
	const source = sourceSlotsForGetNode(getter)[Number(slotIndex) || 0];
	const setterEntry = source?.entry;
	if (!setterEntry) {
		return null;
	}
	if (setterEntry.kind === "template") {
		return resolveTemplatePromptSource(source);
	}
	return resolveSetPromptSource(setterEntry.node, source.sourceSlot);
}

function resolveVirtualPromptInput(graph, inputValue) {
	if (!Array.isArray(inputValue) || inputValue.length !== 2) {
		return inputValue;
	}
	let next = [String(inputValue[0]), Number(inputValue[1] || 0)];
	for (let guard = 0; guard < 12; guard += 1) {
		const found = findNodeByAnyId(graph, next[0]);
		const sourceNode = found?.node;
		if (!sourceNode) {
			return next;
		}
		if (sourceNode.type === GET_TYPE) {
			const resolved = resolveGetPromptSource(sourceNode, next[1]);
			if (!resolved) return null;
			next = resolved;
			continue;
		}
		if (sourceNode.type === SET_TYPE) {
			const resolved = resolveSetPromptSource(sourceNode, next[1]);
			if (!resolved) return null;
			next = resolved;
			continue;
		}
		return next;
	}
	return next;
}

function findNodeForPromptId(graph, promptId) {
	const direct = findNodeByAnyId(graph, promptId);
	if (direct) {
		return direct;
	}
	const parts = String(promptId || "").split(":").filter(Boolean);
	if (parts.length > 1) {
		return findNodeByAnyId(graph, parts[parts.length - 1]);
	}
	return null;
}

function resolveGetterOutputForPrompt(getter, slotIndex) {
	const resolved = resolveGetPromptSource(getter, slotIndex);
	if (!resolved) {
		return null;
	}
	return resolveVirtualPromptInput(getter?.graph || app.rootGraph || app.graph, resolved);
}

function patchDirectGetNodeConsumers(promptResult, graph) {
	const output = promptResult?.output;
	if (!output || !graph) {
		return;
	}
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const found = findNodeForPromptId(graph, nodeId);
		const node = found?.node;
		if (!node?.inputs) {
			continue;
		}
		nodeInfo.inputs = nodeInfo.inputs || {};
		const inputs = nodeInfo.inputs;
		for (let index = 0; index < node.inputs.length; index += 1) {
			const input = node.inputs[index];
			if (!input?.name) {
				continue;
			}
			const link = getLink(node.graph || found.graph || graph, input?.link);
			if (!link) {
				continue;
			}
			const origin = findNodeForPromptId(node.graph || found.graph || graph, link.origin_id)?.node;
			if (origin?.type !== GET_TYPE) {
				continue;
			}
			const resolved = resolveGetterOutputForPrompt(origin, link.origin_slot);
			if (resolved === null) {
				delete inputs[input.name];
			} else if (Array.isArray(resolved) && resolved.length === 2) {
				inputs[input.name] = [String(resolved[0]), Number(resolved[1] || 0)];
			}
		}
	}
}

function patchSetGetPrompt(promptResult, graph) {
	const output = promptResult?.output;
	if (!output || !graph) {
		return promptResult;
	}
	patchDirectGetNodeConsumers(promptResult, graph);
	for (const nodeInfo of Object.values(output)) {
		const inputs = nodeInfo?.inputs || {};
		for (const [name, value] of Object.entries(inputs)) {
			const resolved = resolveVirtualPromptInput(graph, value);
			if (resolved === null) {
				delete inputs[name];
			} else {
				inputs[name] = resolved;
			}
		}
	}
	for (const nodeId of Object.keys(output)) {
		const found = findNodeForPromptId(graph, nodeId);
		if (found?.node?.type === GET_TYPE || found?.node?.type === SET_TYPE) {
			delete output[nodeId];
		}
	}
	return promptResult;
}

function installPromptPatch() {
	if (!api.__gjjSetGetQueuePatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjSetGetQueuePatchInstalled = true;
		const originalQueuePrompt = api.queuePrompt.bind(api);
		api.queuePrompt = async function (...args) {
			const promptData = args[1];
			patchSetGetPrompt(promptData, app.rootGraph || app.graph);
			return originalQueuePrompt(...args);
		};
	}
	if (!app.__gjjSetGetPromptPatchInstalled && typeof app.graphToPrompt === "function") {
		app.__gjjSetGetPromptPatchInstalled = true;
		const originalGraphToPrompt = app.graphToPrompt.bind(app);
		app.graphToPrompt = async function (...args) {
			const result = await originalGraphToPrompt(...args);
			const graph = args[0] || this.rootGraph || this.graph || app.rootGraph || app.graph;
			return patchSetGetPrompt(result, graph);
		};
	}
}

function ensureSetOutputCount(node) {
	const count = sortedInputs(node).length;
	while ((node.outputs || []).length < count) {
		node.addOutput?.("输出", "*");
	}
	while ((node.outputs || []).length > count) {
		node.removeOutput?.(node.outputs.length - 1);
	}
}

function removeUnusedSetInputsFromEnd(node) {
	const inputs = sortedInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_SLOTS; index -= 1) {
		const input = inputs[index];
		const output = node.outputs?.[index];
		const outputLinked = Array.isArray(output?.links) && output.links.length > 0;
		if (input?.link || outputLinked || isSetSlotUsedByGetter(node, index)) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
}

function ensureTrailingSetInput(node) {
	const inputs = sortedInputs(node);
	if (inputs.length === 0) {
		node.addInput?.(formatSlotName(1), "*");
		return;
	}
	const lastInput = inputs[inputs.length - 1];
	const lastOutput = node.outputs?.[inputs.length - 1];
	if (
		lastInput?.link ||
		(Array.isArray(lastOutput?.links) && lastOutput.links.length > 0) ||
		isSetSlotUsedByGetter(node, inputs.length - 1)
	) {
		node.addInput?.(formatSlotName(inputs.length + 1), lastInput.type || "*");
	}
}

function stabilizeSetNode(node) {
	if (!node) {
		return;
	}
	removeUnusedSetInputsFromEnd(node);
	ensureTrailingSetInput(node);
	ensureSetOutputCount(node);
	const inputs = sortedInputs(node);
	inputs.forEach((input, index) => {
		const output = node.outputs[index];
		const info = slotInfoForSetInput(node, input, index);
		const slotName = formatSlotName(index + 1);
		const displayName = info.name && info.name !== "*" ? String(info.name) : `值 ${index + 1}`;
		const type = info.type || "*";
		input.name = slotName;
		input.type = type;
		input.label = displayName;
		input.localized_name = displayName;
		input.tooltip = "连接需要在 GJJ 变量读取节点中取用的值；连接最后一个插槽会自动增加新插槽。";
		if (output) {
			output.name = slotName;
			output.type = type;
			output.label = displayName;
			output.localized_name = displayName;
			output.tooltip = "原值直通输出，可继续作为普通连接使用。";
		}
	});
	node.title = node.widgets?.[0]?.value ? `${SET_TITLE} · ${node.widgets[0].value}` : SET_TITLE;
	applyNodeDescription(node, SET_DESCRIPTION);
	setDirty(node);
	updateGettersForSetter(node);
}

function updateGettersForSetter(setter) {
	const name = setter?.widgets?.[0]?.value;
	if (!setter?.graph || !name) {
		return;
	}
	for (const { node } of findGettersByName(setter.graph, name)) {
		stabilizeGetNode(node);
	}
}

function stabilizeGetNode(node) {
	if (!node) {
		return;
	}
	if (props(node)[GET_SELECTION_PROPERTY] === undefined) {
		props(node)[GET_SELECTION_PROPERTY] = getSelectedNames(node);
	}
	const sourceSlots = sourceSlotsForGetNode(node);
	const desiredCount = Math.max(MIN_VISIBLE_SLOTS, sourceSlots.length);
	while ((node.outputs || []).length < desiredCount) {
		node.addOutput?.("输出", "*");
	}
	while ((node.outputs || []).length > desiredCount) {
		node.removeOutput?.(node.outputs.length - 1);
	}
	for (let index = 0; index < desiredCount; index += 1) {
		const source = sourceSlots[index];
		const info = source?.info || { type: "*", name: `值 ${index + 1}` };
		const output = node.outputs[index];
		if (!output) {
			continue;
		}
		const slotName = formatSlotName(index + 1);
		const displayName = info.name && info.name !== "*" ? String(info.name) : `值 ${index + 1}`;
		output.name = slotName;
		output.type = info.type || "*";
		output.label = displayName;
		output.localized_name = displayName;
		output.tooltip = source?.entry?.kind === "template"
			? "从 GJJ 模板变量设置节点读取对应变量；会优先使用模板变量行左侧小圆点的外部连接。"
			: GET_OUTPUT_TOOLTIP;
	}
	const names = getSelectedNames(node);
	node.title = names.length === 1 ? `${GET_TITLE} · ${names[0]}` : names.length > 1 ? `${GET_TITLE} · ${names.length}个变量` : GET_TITLE;
	applyNodeDescription(node, GET_DESCRIPTION);
	updateGetSelectorWidget(node);
	setDirty(node);
}

function scheduleSetStabilize(node, ms = 32) {
	clearTimeout(node.__gjjSetGetTimer);
	node.__gjjSetGetTimer = setTimeout(() => stabilizeSetNode(node), ms);
}

function scheduleGetStabilize(node, ms = 32) {
	clearTimeout(node.__gjjSetGetTimer);
	node.__gjjSetGetTimer = setTimeout(() => stabilizeGetNode(node), ms);
}

function scheduleAllGetStabilize(ms = 32) {
	for (const node of app.graph?._nodes || []) {
		if (node?.type === GET_TYPE) {
			scheduleGetStabilize(node, ms);
		}
	}
}

function hideStorageWidget(widget) {
	if (!widget) return;
	widget.hidden = true;
	widget.type = "hidden";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden" };
}

function updateGetSelectorWidget(node) {
	const widget = node?.__gjjGetMultiSelectorWidget;
	if (!widget) return;
	widget.value = selectionSummary(node);
	setDirty(node);
}

function openGetSelectPopup(node, event) {
	ensureStyles();
	closeGetSelectPopup();
	const options = getVisibleSetOptions(node.graph);
	let selected = getSelectedNames(node);
	let searchText = "";
	const popup = document.createElement("div");
	popup.className = "gjj-getnode-popup";
	const maxX = Math.max(8, window.innerWidth - 280);
	const maxY = Math.max(8, window.innerHeight - 120);
	const x = Math.min(maxX, Math.max(8, Number(event?.clientX || 0) || 120));
	const y = Math.min(maxY, Math.max(8, Number(event?.clientY || 0) || 120));
	popup.style.left = `${Math.round(x)}px`;
	popup.style.top = `${Math.round(y + 6)}px`;

	const search = document.createElement("input");
	search.className = "gjj-getnode-search";
	search.placeholder = "搜索变量，点击可多选";
	const list = document.createElement("div");
	list.className = "gjj-getnode-list";
	const actions = document.createElement("div");
	actions.className = "gjj-getnode-actions";
	const count = document.createElement("span");
	count.className = "gjj-getnode-count";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.className = "gjj-getnode-action";
	clear.textContent = "清空";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "gjj-getnode-action";
	close.textContent = "完成";
	actions.append(count, clear, close);

	function commit() {
		setSelectedNames(node, selected);
		count.textContent = selected.length ? `已选 ${selected.length} 个` : "未选择";
	}

	function render() {
		searchText = String(search.value || "").trim().toLowerCase();
		const words = searchText.split(/[\s,，;；|]+/).filter(Boolean);
		const shown = options.filter((option) => {
			const hay = `${option.value} ${option.label} ${option.source}`.toLowerCase();
			return words.every((word) => hay.includes(word));
		});
		list.replaceChildren();
		if (!shown.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-getnode-meta";
			empty.textContent = "没有匹配变量";
			empty.style.padding = "8px";
			list.appendChild(empty);
			return;
		}
		for (const option of shown) {
			const active = selected.includes(option.value);
			const item = document.createElement("button");
			item.type = "button";
			item.className = `gjj-getnode-item${active ? " active" : ""}`;
			item.title = option.value;
			const check = document.createElement("span");
			check.className = "gjj-getnode-check";
			check.textContent = active ? "✓" : "";
			const main = document.createElement("span");
			main.className = "gjj-getnode-main";
			const label = document.createElement("span");
			label.className = "gjj-getnode-label";
			label.textContent = option.label;
			const meta = document.createElement("span");
			meta.className = "gjj-getnode-meta";
			meta.textContent = option.value;
			main.append(label, meta);
			item.append(check, main);
			item.addEventListener("click", (clickEvent) => {
				clickEvent.preventDefault();
				clickEvent.stopPropagation();
				const index = selected.indexOf(option.value);
				if (index >= 0) selected.splice(index, 1);
				else selected.push(option.value);
				selected = uniqueNames(selected);
				commit();
				render();
			});
			list.appendChild(item);
		}
	}

	search.addEventListener("input", render);
	clear.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		clickEvent.stopPropagation();
		selected = [];
		commit();
		render();
	});
	close.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		clickEvent.stopPropagation();
		closeGetSelectPopup();
	});
	for (const el of [popup, search, list, actions, clear, close]) {
		for (const name of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
			el.addEventListener(name, (ev) => ev.stopPropagation());
		}
	}
	popup.append(search, list, actions);
	document.body.appendChild(popup);
	activeGetSelectPopup = popup;
	commit();
	render();
	setTimeout(() => search.focus(), 0);
}

function addGetMultiSelectorWidget(node) {
	if (node.__gjjGetMultiSelectorWidget) return;
	const widget = {
		name: GET_SELECTOR_WIDGET,
		type: "gjj_getnode_multi_select",
		value: selectionSummary(node),
		tooltip: GET_SELECTOR_TOOLTIP,
		options: {
			display_name: "变量名",
			tooltip: GET_SELECTOR_TOOLTIP,
		},
		serialize: false,
		computeSize(width) {
			return [width || 260, 32];
		},
		draw(ctx, nodeRef, widgetWidth, widgetY, height) {
			const h = height || 28;
			const label = "变量名";
			const text = selectionSummary(nodeRef);
			const left = 12;
			const labelW = 76;
			const boxX = left + labelW;
			const boxW = Math.max(120, widgetWidth - boxX - 12);
			ctx.save();
			ctx.font = "14px Arial";
			ctx.textAlign = "left";
			ctx.textBaseline = "middle";
			ctx.fillStyle = "#b8c0cc";
			ctx.fillText(label, left, widgetY + h * 0.5);
			ctx.fillStyle = "#2b3037";
			ctx.strokeStyle = "#3f515a";
			ctx.lineWidth = 1;
			const r = 7;
			const y = widgetY + 2;
			const bh = h - 4;
			ctx.beginPath();
			ctx.roundRect?.(boxX, y, boxW, bh, r);
			if (!ctx.roundRect) {
				ctx.rect(boxX, y, boxW, bh);
			}
			ctx.fill();
			ctx.stroke();
			ctx.save();
			ctx.beginPath();
			ctx.rect(boxX + 8, y, boxW - 30, bh);
			ctx.clip();
			ctx.fillStyle = text === "选择变量" ? "#8fa2aa" : "#ffffff";
			ctx.font = "13px Arial";
			ctx.fillText(text, boxX + 10, widgetY + h * 0.5);
			ctx.restore();
			ctx.fillStyle = "#8fa2aa";
			ctx.textAlign = "center";
			ctx.fillText("⌄", boxX + boxW - 16, widgetY + h * 0.5);
			ctx.restore();
		},
		mouse(event, pos, nodeRef) {
			const eventType = String(event?.type || "");
			if (eventType && !["pointerdown", "mousedown", "click"].includes(eventType)) return false;
			event?.preventDefault?.();
			event?.stopPropagation?.();
			openGetSelectPopup(nodeRef || node, event);
			return true;
		},
	};
	if (node.addCustomWidget) node.addCustomWidget(widget);
	else node.widgets?.push(widget);
	node.__gjjGetMultiSelectorWidget = widget;
}

function validateSetName(node, sameGraphOnly = false) {
	if (!node?.widgets?.[0]) {
		return false;
	}
	let value = String(node.widgets[0].value || "").trim();
	if (!value) {
		node.widgets[0].value = "";
		node.title = SET_TITLE;
		return false;
	}
	const scopeGraphs = sameGraphOnly ? [node.graph] : getGraphAncestors(node.graph);
	const usedNames = new Set();
	for (const { node: other } of collectNodesOfType(scopeGraphs, SET_TYPE)) {
		if (other !== node && other.widgets?.[0]?.value) {
			usedNames.add(other.widgets[0].value);
		}
	}
	const original = value;
	const base = node._justAdded ? value.replace(/_\d+$/, "") : value;
	let tries = 0;
	while (usedNames.has(value)) {
		value = `${base}_${tries}`;
		tries += 1;
	}
	node.widgets[0].value = value;
	node.title = `${SET_TITLE} · ${value}`;
	return value !== original;
}

function isCompatibleType(sourceType, targetType) {
	if (!sourceType || !targetType || sourceType === "*" || targetType === "*") {
		return true;
	}
	const sourceTypes = String(sourceType).split(",");
	const targetTypes = String(targetType).split(",");
	return sourceTypes.some((type) => targetTypes.includes(type));
}

app.registerExtension({
	name: "Comfy.GJJ.SetGetNode",

	registerCustomNodes() {
		const LGraphNode = LiteGraph.LGraphNode;

		class GJJSetNode extends LGraphNode {
			static title = SET_TITLE;
			static category = SET_CATEGORY;
			static desc = SET_DESCRIPTION;
			static description = SET_DESCRIPTION;
			serialize_widgets = true;
			isVirtualNode = true;
			color = DEFAULT_COLOR;
			bgcolor = DEFAULT_BG;

			constructor(title) {
				super(title);
				applyNodeDescription(this, SET_DESCRIPTION);
				this.properties = this.properties || {};
				this.properties.previousName = this.properties.previousName || "";
				this.properties["Node name for S&R"] = SET_TYPE;
				this.properties.aux_id = SET_TYPE;
				this.addWidget("text", "变量名", "", () => {
					if (app.configuringGraph) {
						return;
					}
					const previousName = this.properties.previousName;
					validateSetName(this);
					if (previousName && previousName !== this.widgets[0].value) {
						for (const getter of findGettersByName(this.graph, previousName).map((entry) => entry.node)) {
							replaceSelectedName(getter, previousName, this.widgets[0].value);
						}
					}
					this.properties.previousName = this.widgets[0].value;
					stabilizeSetNode(this);
				});
				this.addInput(formatSlotName(1), "*");
				this.addOutput(formatSlotName(1), "*");
				stabilizeSetNode(this);
			}

			onAdded() {
				this._justAdded = true;
			}

			onConfigure() {
				if (this._justAdded && this.graph && !app.configuringGraph) {
					const oldName = this.widgets?.[0]?.value;
					validateSetName(this, true);
					const newName = this.widgets?.[0]?.value;
					if (oldName && newName && oldName !== newName) {
						pasteRenameMap.set(oldName, newName);
						setTimeout(() => pasteRenameMap.delete(oldName), 0);
					}
				}
				this._justAdded = false;
				scheduleSetStabilize(this, 0);
			}

			onConnectionsChange() {
				if (app.configuringGraph) {
					return;
				}
				scheduleSetStabilize(this);
			}

			clone() {
				const cloned = super.clone();
				cloned._justAdded = true;
				return cloned;
			}

			getExtraMenuOptions(_, options) {
				options.unshift({
					content: "新增配对变量读取",
					callback: () => {
						const graph = this.graph || app.graph;
						const getter = LiteGraph.createNode(GET_TYPE);
						if (!getter || !graph) {
							return;
						}
						graph.add(getter);
						getter.pos = [this.pos[0] + this.size[0] + 30, this.pos[1]];
						setSelectedNames(getter, [this.widgets[0].value], false);
						stabilizeGetNode(getter);
						app.canvas?.selectNode?.(getter, false);
						setDirty(getter);
					},
				});
			}
		}

		class GJJGetNode extends LGraphNode {
			static title = GET_TITLE;
			static category = GET_CATEGORY;
			static desc = GET_DESCRIPTION;
			static description = GET_DESCRIPTION;
			serialize_widgets = true;
			isVirtualNode = true;
			color = DEFAULT_COLOR;
			bgcolor = DEFAULT_BG;

			constructor(title) {
				super(title);
				applyNodeDescription(this, GET_DESCRIPTION);
				this.properties = this.properties || {};
				this.properties["Node name for S&R"] = GET_TYPE;
				this.properties.aux_id = GET_TYPE;
				const storage = this.addWidget("text", GET_STORAGE_WIDGET, "", () => {
					if (!app.configuringGraph) {
						this.properties[GET_SELECTION_PROPERTY] = uniqueNames(storage.value);
						stabilizeGetNode(this);
					}
				}, { multiline: false });
				storage.serialize = true;
				hideStorageWidget(storage);
				addGetMultiSelectorWidget(this);
				this.addOutput(formatSlotName(1), "*");
				stabilizeGetNode(this);
			}

			onAdded() {
				this._justAdded = true;
			}

			onConfigure() {
				if (this._justAdded && !app.configuringGraph) {
					const names = getSelectedNames(this).map((name) => pasteRenameMap.get(name) || name);
					setSelectedNames(this, names, false);
				}
				if (this.properties?.[GET_SELECTION_PROPERTY] === undefined) {
					this.properties[GET_SELECTION_PROPERTY] = getSelectedNames(this);
				} else {
					const storage = getNameWidget(this);
					if (storage) storage.value = selectedValueText(this.properties[GET_SELECTION_PROPERTY]);
				}
				this._justAdded = false;
				scheduleGetStabilize(this, 0);
			}

			onConnectionsChange() {
				if (app.configuringGraph) {
					return;
				}
				this.validateLinks();
				for (const name of getSelectedNames(this)) {
					const setter = findSetterByName(this.graph, name)?.node;
					if (setter) {
						scheduleSetStabilize(setter);
					}
				}
				scheduleGetStabilize(this);
			}

			getInputLink(slot) {
				const source = sourceSlotsForGetNode(this)[slot];
				const setterEntry = source?.entry;
				const setter = setterEntry?.node;
				const setterGraph = setterEntry?.graph;
				if (!setter || !setterGraph) {
					return null;
				}
				if (setterEntry.kind === "template") {
					const input = setter.inputs?.find((item) => item?.name === source.inputName);
					if (input?.link == null) {
						return null;
					}
					return getLink(setterGraph, input.link);
				}
				const input = sortedInputs(setter)[source.sourceSlot];
				if (!input || input.link == null) {
					return null;
				}
				return getLink(setterGraph, input.link);
			}

			resolveVirtualOutput(slot) {
				const source = sourceSlotsForGetNode(this)[slot];
				const setterEntry = source?.entry;
				if (setterEntry?.kind === "template") {
					return { node: setterEntry.node, slot: source.sourceSlot || 0 };
				}
				if (!setterEntry || setterEntry.graph === this.graph) {
					return undefined;
				}
				const input = sortedInputs(setterEntry.node)[source.sourceSlot];
				const link = getLink(setterEntry.graph, input?.link);
				const sourceNode = link?.origin_id != null ? setterEntry.graph.getNodeById?.(link.origin_id) : null;
				if (!sourceNode) {
					return undefined;
				}
				return { node: sourceNode, slot: link.origin_slot };
			}

			validateLinks() {
				for (const output of this.outputs || []) {
					for (const linkId of [...(output.links || [])]) {
						const link = getLink(this.graph, linkId);
						const targetNode = link?.target_id != null ? this.graph?.getNodeById?.(link.target_id) : null;
						const targetType = targetNode?.inputs?.[link?.target_slot]?.type;
						if (!isCompatibleType(output.type, targetType)) {
							this.graph?.removeLink?.(linkId);
						}
					}
				}
			}

			getExtraMenuOptions(_, options) {
				options.unshift({
					content: "跳转到变量设置",
					callback: () => {
						const setter = findSetterByName(this.graph, getSelectedNames(this)[0])?.node;
						if (!setter) {
							return;
						}
						app.canvas?.centerOnNode?.(setter);
						app.canvas?.selectNode?.(setter, false);
						setDirty(setter);
					},
				});
			}
		}

		LiteGraph.registerNodeType(SET_TYPE, GJJSetNode);
		LiteGraph.registerNodeType(GET_TYPE, GJJGetNode);
		applyRegisteredNodeTypeMetadata(SET_TYPE, SET_TITLE, SET_CATEGORY, SET_DESCRIPTION);
		applyRegisteredNodeTypeMetadata(GET_TYPE, GET_TITLE, GET_CATEGORY, GET_DESCRIPTION);
	},

	setup() {
		installPromptPatch();
		if (!window.__gjjTemplateSetVariablesGetNodeListener) {
			window.__gjjTemplateSetVariablesGetNodeListener = true;
			window.addEventListener("gjj-template-set-variables-updated", () => scheduleAllGetStabilize(0));
		}
		for (const node of app.graph?._nodes || []) {
			if (node?.type === SET_TYPE) {
				stabilizeSetNode(node);
			} else if (node?.type === GET_TYPE) {
				stabilizeGetNode(node);
			}
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { GJJ_STANDARDIZE_NODE } from "./gjj_common_node_standardizer.js";

const SET_TYPE = "GJJ_SetNode";
const GET_TYPE = "GJJ_GetNode";
const TEMPLATE_SET_TYPE = "GJJ_TemplateSetVariables";
const BROADCAST_OUTPUT_SOURCE_TYPES = new Set([
	"GJJ_VideoUniversalModelLoader",
	"GJJ_VideoKijaiModelLoader",
	"GJJ_ModelBundleLoader",
]);
const TEMPLATE_FIELD_SCHEMA = "gjj_template_set_variables_fields";
const TEMPLATE_SAVED_TEMPLATE = "gjj_template_set_variables_template";
const TEMPLATE_WIDGET = "template_text";
const SET_NAME_WIDGET = "变量名";
const SET_NAME_DOM_WIDGET = "gjj_setnode_name_dom";
const SET_PREVIOUS_NAMES_PROPERTY = "gjj_setnode_previous_names";
const SET_MANUAL_NAMES_PROPERTY = "gjj_setnode_manual_names";
const SET_MANUAL_NAMES_LOCK_PROPERTY = "gjj_setnode_manual_names_locked";
const GET_SELECTION_PROPERTY = "gjj_getnode_selected_names";
const GET_SELECTOR_WIDGET = "gjj_getnode_multi_selector";
const GET_STORAGE_WIDGET = "变量名";
const GET_SELECTION_SEPARATOR = "\n";
const SET_NAME_SEPARATOR = ", ";
const BROADCAST_PROPERTY = "gjj_variable_broadcast_enabled";
const BROADCAST_WIDGET = "gjj_variable_broadcast_toggle";
const GET_STYLE_ID = "gjj-set-get-node-style";
const SLOT_PREFIX = "value_";
const MIN_VISIBLE_SLOTS = 1;
const SET_TITLE = "GJJ · 📌 变量设置";
const GET_TITLE = "GJJ · 📍 变量读取";
const SET_CATEGORY = "GJJ/工具";
const GET_CATEGORY = "GJJ/工具";
const SET_DESCRIPTION = "把连接到本节点的每个输入登记为 GJJ 变量；变量名可用逗号分隔，连接新输入时会按上游输出名自动补齐并保持唯一。";
const GET_DESCRIPTION = "从同一工作流作用域内的 GJJ 变量设置或模板变量设置节点读取已选择变量；支持一次选择多个变量，并按变量来源动态生成输出口。";
const GET_SELECTOR_TOOLTIP = "选择要读取的 GJJ 变量；支持多选，输出口会按选择内容和变量来源自动刷新。";
const GET_OUTPUT_TOOLTIP = "输出已选择变量的真实值；提交工作流时会解析到对应变量设置或模板变量设置节点。";
const DEFAULT_COLOR = "#1B252B";
const DEFAULT_BG = "#141B1F";

const pasteRenameMap = new Map();
let setNameSourceMap = new Map();
let activeGetSelectPopup = null;
let broadcastDrawConnectionsInstalled = false;

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

const SET_NODE_DATA = buildVirtualNodeData(SET_TYPE, SET_TITLE, SET_CATEGORY, SET_DESCRIPTION, {
	inputs: [{ name: "变量值", type: "*", tooltip: "连接任意值后自动生成对应变量名；多个变量名用逗号分隔。" }],
	outputs: [{ name: "原值直通", type: "*", tooltip: "与对应输入相同的原值直通输出。" }],
	tags: ["GJJ_SETNODE", "GJJ SetNode", "变量设置", "设置变量", "set"],
});

const GET_NODE_DATA = buildVirtualNodeData(GET_TYPE, GET_TITLE, GET_CATEGORY, GET_DESCRIPTION, {
	outputs: [{ name: "变量值", type: "*", tooltip: GET_OUTPUT_TOOLTIP }],
	tags: ["GJJ_GETNODE", "GJJ GetNode", "变量读取", "读取变量", "get"],
});

function buildVirtualNodeData(type, title, category, description, extra = {}) {
	const inputs = extra.inputs || [];
	const outputs = extra.outputs || [];
	return {
		name: type,
		display_name: title,
		displayName: title,
		title,
		category,
		description,
		desc: description,
		tooltip: description,
		input: { required: {}, optional: {} },
		output: outputs.map((item) => item.type || "*"),
		output_name: outputs.map((item) => item.name || "输出"),
		output_tooltips: outputs.map((item) => item.tooltip || ""),
		input_name: inputs.map((item) => item.name || "输入"),
		input_tooltips: inputs.map((item) => item.tooltip || ""),
		tags: extra.tags || [],
		search_tags: extra.tags || [],
		is_virtual_node: true,
	};
}

function props(node) {
	node.properties = node.properties || {};
	return node.properties;
}

function ensureStyles() {
	if (document.getElementById(GET_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = GET_STYLE_ID;
	style.textContent = `
.gjj-getnode-popup{position:fixed;z-index:100000;min-width:260px;width:min(360px,calc(100vw - 16px));max-width:calc(100vw - 16px);display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #45606a;border-radius:8px;background:#10191e;color:#dce7e2;box-shadow:0 12px 32px rgba(0,0,0,.45);font-family:system-ui,"Microsoft YaHei",sans-serif;box-sizing:border-box;overflow:hidden;}
.gjj-getnode-head{display:flex;align-items:center;gap:6px;min-height:28px;border-bottom:1px solid #263842;padding-bottom:5px;}
.gjj-getnode-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dce7e2;font-size:12px;font-weight:700;}
.gjj-getnode-close{width:24px;height:22px;flex:0 0 24px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;font-size:14px;line-height:18px;cursor:pointer;padding:0;}
.gjj-getnode-close:hover{background:#31424d;}
.gjj-getnode-search{height:26px;box-sizing:border-box;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 8px;font-size:12px;outline:none;}
.gjj-getnode-list{overflow:auto;flex:1 1 auto;min-height:70px;display:flex;flex-direction:column;gap:2px;padding-right:2px;}
.gjj-getnode-item{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;border:0;border-radius:6px;background:transparent;color:#dce7e2;text-align:left;padding:5px 6px;cursor:pointer;font-size:12px;}
.gjj-getnode-item:hover{background:#1f2c33;}
.gjj-getnode-item.active{background:#243c32;color:#d9ffe4;}
.gjj-getnode-check{width:14px;flex:0 0 14px;color:#7bd88f;font-weight:800;text-align:center;}
.gjj-getnode-main{min-width:0;display:flex;flex-direction:column;gap:1px;}
.gjj-getnode-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gjj-getnode-meta{color:#8fa2aa;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gjj-getnode-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;margin-left:auto;flex:0 0 auto;}
.gjj-getnode-action{height:24px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;font-size:12px;cursor:pointer;padding:0 8px;white-space:nowrap;}
.gjj-getnode-action:hover{background:#263844;}
.gjj-getnode-count{color:#9fb0b7;font-size:11px;white-space:nowrap;flex:0 0 auto;}
.gjj-setnode-name-row{box-sizing:border-box;width:100%;height:32px;display:flex;align-items:center;gap:7px;padding:2px 12px 2px 12px;color:#b8c0cc;font-family:system-ui,"Microsoft YaHei",sans-serif;pointer-events:auto;}
.gjj-setnode-broadcast{width:25px;height:24px;flex:0 0 25px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0;font-size:14px;line-height:20px;}
.gjj-setnode-broadcast:hover{background:#2c3b43;border-color:#6aa6b8;}
.gjj-setnode-broadcast.active{background:#284735;border-color:#69b980;color:#ecfff1;}
.gjj-setnode-name-label{flex:0 0 auto;font-size:14px;color:#b8c0cc;white-space:nowrap;}
.gjj-setnode-name-input{min-width:0;flex:1 1 auto;height:26px;box-sizing:border-box;border:0;border-radius:8px;background:#2f3137;color:#ffffff;padding:0 12px;font:bold 13px system-ui,"Microsoft YaHei",sans-serif;outline:none;}
.gjj-setnode-name-input:focus{box-shadow:0 0 0 1px #6aa6b8;background:#353941;}
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

function isOutputBroadcastSourceNode(node) {
	const type = nodeType(node);
	return BROADCAST_OUTPUT_SOURCE_TYPES.has(type) || BROADCAST_OUTPUT_SOURCE_TYPES.has(node?.comfyClass);
}

function normalizeTemplateSocketType(value) {
	let text = String(value || "").trim();
	if (!text) return "";
	text = text.replace(/，/g, ",").replace(/\s+/g, "");
	if (/^(any|\*)$/i.test(text)) return "*";
	return text.toUpperCase();
}

const GENERIC_BROADCAST_NAME_TYPES = new Set([
	"*", "ANY", "IMAGE", "LATENT", "MASK", "MODEL", "CLIP", "CLIP_VISION", "CLIP_VISION_OUTPUT",
	"VAE", "CONDITIONING", "CONTROL_NET", "INT", "FLOAT", "NUMBER", "STRING", "BOOLEAN",
	"COMBO", "SAMPLER", "SIGMAS", "GUIDER", "NOISE", "STYLE_MODEL",
]);

function broadcastNameTypeCandidate(type) {
	const normalized = normalizeTemplateSocketType(type);
	if (!normalized || GENERIC_BROADCAST_NAME_TYPES.has(normalized)) return "";
	const first = normalized.split(",").find((part) => part && !GENERIC_BROADCAST_NAME_TYPES.has(part));
	return first || "";
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

function setValueText(names) {
	return uniqueNames(names).join(SET_NAME_SEPARATOR);
}

function getSetNameWidget(node) {
	if (!Array.isArray(node?.widgets)) return null;
	return node.widgets.find((widget) => (
		widget?.name === SET_NAME_WIDGET
		|| widget?.label === SET_NAME_WIDGET
		|| String(widget?.label || "").includes(SET_NAME_WIDGET)
	)) || node.widgets.find((widget) => (
		widget?.name !== SET_NAME_DOM_WIDGET
		&& widget?.name !== BROADCAST_WIDGET
		&& widget?.type !== "HTML"
		&& widget?.type !== "DOM"
	)) || null;
}

function getSetNames(node) {
	return uniqueNames(getSetNameWidget(node)?.value || "");
}

function getPreviousSetNames(node) {
	const saved = props(node)[SET_PREVIOUS_NAMES_PROPERTY];
	const names = uniqueNames(Array.isArray(saved) ? saved : saved || node?.properties?.previousName || "");
	if (names.length) return names;
	return getSetNames(node);
}

function rememberSetNames(node) {
	const names = getSetNames(node);
	props(node)[SET_PREVIOUS_NAMES_PROPERTY] = names;
	node.properties.previousName = names[0] || "";
}

function getManualSetNames(node) {
	if (!props(node)[SET_MANUAL_NAMES_LOCK_PROPERTY]) return [];
	const saved = props(node)[SET_MANUAL_NAMES_PROPERTY];
	if (Array.isArray(saved)) return saved.map((item) => String(item || ""));
	return uniqueNames(saved || "");
}

function rememberManualSetNames(node) {
	props(node)[SET_MANUAL_NAMES_PROPERTY] = getSetNames(node);
	props(node)[SET_MANUAL_NAMES_LOCK_PROPERTY] = true;
}

function syncManualSetNamesFromUserEdit(node, previousNames) {
	const nextNames = getSetNames(node);
	const manual = getManualSetNames(node);
	const count = Math.max(previousNames?.length || 0, nextNames.length, manual.length);
	const synced = [];
	for (let index = 0; index < count; index += 1) {
		const previous = previousNames?.[index] || "";
		const next = nextNames[index] || "";
		const oldManual = manual[index] || "";
		if (next && next !== previous) {
			synced[index] = next;
		} else if (oldManual && next === oldManual) {
			synced[index] = oldManual;
		} else {
			synced[index] = "";
		}
	}
	props(node)[SET_MANUAL_NAMES_PROPERTY] = synced;
	props(node)[SET_MANUAL_NAMES_LOCK_PROPERTY] = true;
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

function outputHasLinks(output) {
	if (!output) return false;
	if (Array.isArray(output.links)) return output.links.length > 0;
	return output.link != null;
}

function setGraphLinkSlot(link, side, nodeId, slot, type) {
	if (!link) return;
	if (Array.isArray(link)) {
		if (side === "input") {
			link[3] = nodeId;
			link[4] = slot;
		} else {
			link[1] = nodeId;
			link[2] = slot;
		}
		if (type) link[5] = type;
		return;
	}
	if (side === "input") {
		link.target_id = nodeId;
		link.target_slot = slot;
	} else {
		link.origin_id = nodeId;
		link.origin_slot = slot;
	}
	if (type) link.type = type;
}

function repairSetNodeLinkSlots(node) {
	if (!node?.graph) return;
	for (let index = 0; index < (node.inputs?.length || 0); index += 1) {
		const input = node.inputs[index];
		if (input?.link == null) continue;
		setGraphLinkSlot(getLink(node.graph, input.link), "input", node.id, index, input.type);
	}
	for (let index = 0; index < (node.outputs?.length || 0); index += 1) {
		const output = node.outputs[index];
		for (const linkId of output?.links || []) {
			setGraphLinkSlot(getLink(node.graph, linkId), "output", node.id, index, output.type);
		}
	}
}

function highestLinkedOutputIndex(node) {
	let highest = -1;
	for (let index = 0; index < (node?.outputs?.length || 0); index += 1) {
		if (outputHasLinks(node.outputs[index])) highest = index;
	}
	return highest;
}

function sortedInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs].sort((a, b) => getSlotIndex(a?.name) - getSlotIndex(b?.name))
		: [];
}

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function releaseForcedDefaultColors(node) {
	if (!node) return;
	if (node.color === DEFAULT_COLOR) delete node.color;
	if (node.bgcolor === DEFAULT_BG) delete node.bgcolor;
}

function broadcastEnabled(node) {
	return Boolean(props(node)[BROADCAST_PROPERTY]);
}

function scheduleBroadcastCanvasRefresh() {
	try { app.canvas?.setDirty?.(true, true); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app.graph?.change?.(); } catch (_) {}
}

function notifyBroadcastChanged(node) {
	scheduleBroadcastCanvasRefresh();
	try {
		window.dispatchEvent(new CustomEvent("gjj-variable-broadcast-updated", {
			detail: { nodeId: node?.id, enabled: broadcastEnabled(node) },
		}));
	} catch (_) {}
}

function setBroadcastEnabled(node, enabled) {
	if (!node) return;
	props(node)[BROADCAST_PROPERTY] = Boolean(enabled);
	updateBroadcastToggleWidget(node);
	setDirty(node);
	notifyBroadcastChanged(node);
}

function applyNodeDescription(node, description) {
	if (!node) return;
	node.desc = description;
	node.description = description;
	node.tooltip = description;
}

function metadataForType(type, title, category, description) {
	if (type === SET_TYPE) return SET_NODE_DATA;
	if (type === GET_TYPE) return GET_NODE_DATA;
	return buildVirtualNodeData(type, title, category, description);
}

function applyRegisteredNodeTypeMetadata(type, title, category, description) {
	const registered = globalThis.LiteGraph?.registered_node_types?.[type];
	const nodeData = metadataForType(type, title, category, description);
	for (const target of [registered, registered?.prototype].filter(Boolean)) {
		target.title = title;
		target.category = category;
		target.desc = description;
		target.description = description;
		target.display_name = title;
		target.tooltip = description;
		target.comfyClass = type;
		target.nodeData = { ...(target.nodeData || {}), ...nodeData };
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

function collectOutputBroadcastSourceNodes(graphs) {
	const results = [];
	for (const graph of graphs) {
		for (const node of graph?._nodes || []) {
			if (isOutputBroadcastSourceNode(node)) {
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

function usedSetSlotCount(setNode) {
	const inputs = sortedInputs(setNode);
	let lastUsed = -1;
	for (let index = 0; index < inputs.length; index += 1) {
		const input = inputs[index];
		const output = setNode?.outputs?.[index];
		const outputLinked = Array.isArray(output?.links) && output.links.length > 0;
		if (input?.link || outputLinked) {
			lastUsed = index;
		}
	}
	return lastUsed + 1;
}

function activeSetSlotCount(setNode) {
	return Math.max(MIN_VISIBLE_SLOTS, usedSetSlotCount(setNode));
}

function setVariableEntriesForNode(node) {
	const names = getSetNames(node);
	if (!names.length) return [];
	const count = activeSetSlotCount(node);
	if (names.length === 1) {
		return count > 0 ? [{ name: names[0], sourceSlot: 0 }] : [];
	}
	return names
		.map((name, index) => ({ name, sourceSlot: index }))
		.filter((entry) => entry.name && entry.sourceSlot < count);
}

function setNamesForSlot(node, slotIndex) {
	const names = getSetNames(node);
	return names[slotIndex] ? [names[slotIndex]] : [];
}

function findSetterByName(graph, name) {
	if (!name) {
		return null;
	}
	for (const scopeGraph of getGraphAncestors(graph)) {
		for (const setter of scopeGraph?._nodes || []) {
			if (setter?.type !== SET_TYPE) continue;
			const match = setVariableEntriesForNode(setter).find((entry) => entry.name === name);
			if (match) {
				return { node: setter, graph: scopeGraph, kind: "set", sourceSlot: match.sourceSlot };
			}
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
		for (const item of setVariableEntriesForNode(entry.node)) {
			const name = item.name;
			if (!name || sourceMap.has(name)) {
				continue;
			}
			sourceMap.set(name, entry.graph === graph ? "local" : "parent");
		}
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
	const type = sourceSlot.type || "*";
	const name = preferredSlotSetName(sourceSlot)
		|| broadcastNameTypeCandidate(type)
		|| "*";
	return {
		type,
		name,
	};
}

function getLinkedTargetInfo(node, output) {
	for (const linkId of output?.links || []) {
		const link = getLink(node.graph, linkId);
		const targetNode = link?.target_id != null ? node.graph?.getNodeById?.(link.target_id) : null;
		const targetSlot = targetNode?.inputs?.[link?.target_slot];
		if (targetSlot) {
			const type = targetSlot.type || "*";
			const name = preferredSlotSetName(targetSlot)
				|| broadcastNameTypeCandidate(type)
				|| "*";
			return {
				type,
				name,
			};
		}
	}
	return null;
}

function getLinkedGetterTargetInfo(setNode, slotIndex) {
	const names = setNamesForSlot(setNode, slotIndex);
	if (!names.length || !setNode?.graph) {
		return null;
	}
	for (const name of names) {
		for (const { node: getter } of findGettersByName(setNode.graph, name)) {
			const output = getter.outputs?.[getGetterOutputIndexForSetSlot(getter, setNode, slotIndex)];
			const info = getLinkedTargetInfo(getter, output);
			if (info) {
				return info;
			}
		}
	}
	return null;
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
		const count = entry.sourceSlot == null ? activeSetSlotCount(entry.node) : 1;
		if (entry.node === setNode) {
			if (entry.sourceSlot == null) {
				return offset + slotIndex;
			}
			if (entry.sourceSlot === slotIndex) {
				return offset;
			}
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
	const outputLinked = Array.isArray(output?.links) && output.links.length > 0;
	if (!input?.link && !outputLinked) {
		return {
			type: input?.type || output?.type || "*",
			name: formatSlotName(index + 1),
		};
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

function displayNameForSource(name, displayName, multiMode) {
	if (!multiMode) return displayName;
	const left = String(name || "").trim();
	const right = String(displayName || "").trim();
	if (!left || !right || left.toLowerCase() === right.toLowerCase()) {
		return left || right;
	}
	return `${left} · ${right}`;
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
	if (entry.sourceSlot != null) {
		const index = Number(entry.sourceSlot || 0);
		if (index >= activeSetSlotCount(setter)) return [];
		const setterInput = setterInputs[index];
		const info = setterInput
			? slotInfoForSetInput(setter, setterInput, index)
			: { type: "*", name: name || `值 ${index + 1}` };
		const slotName = setNamesForSlot(setter, index)[0];
		const rawDisplayName = slotName || (info.name && info.name !== "*" ? String(info.name) : `值 ${index + 1}`);
		return [{
			entry,
			sourceSlot: index,
			info: {
				type: info.type || "*",
				name: displayNameForSource(name, rawDisplayName, multiMode),
			},
		}];
	}
	const count = activeSetSlotCount(setter);
	const result = [];
	for (let index = 0; index < count; index += 1) {
		const setterInput = setterInputs[index];
		const info = setterInput
			? slotInfoForSetInput(setter, setterInput, index)
			: { type: "*", name: `值 ${index + 1}` };
		const displayName = setNamesForSlot(setter, index)[0] || (info.name && info.name !== "*" ? String(info.name) : `值 ${index + 1}`);
		result.push({
			entry,
			sourceSlot: index,
			info: {
				type: info.type || "*",
				name: displayNameForSource(name, displayName, multiMode),
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

function normalizeBroadcastName(value) {
	const text = String(value ?? "").trim();
	if (!text) return "";
	return text
		.replace(/^var_/i, "")
		.replace(/[（(]\s*([A-Za-z][A-Za-z0-9_ -]*)\s*[）)]/g, " $1 ")
		.replace(/^[^0-9A-Za-z\u4e00-\u9fff]+/, "")
		.replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, "")
		.toLowerCase();
}

function pushBroadcastName(result, seen, value) {
	const normalized = normalizeBroadcastName(value);
	if (!normalized || seen.has(normalized)) return;
	seen.add(normalized);
	result.push(normalized);
}

function broadcastNameCandidates(...values) {
	const result = [];
	const seen = new Set();
	for (const value of values.flat()) {
		const raw = String(value ?? "").trim();
		if (!raw) continue;
		for (const candidate of [raw, raw.replace(/^var_/i, ""), sourceSetNameCandidate(raw)]) {
			const normalized = normalizeBroadcastName(candidate);
			pushBroadcastName(result, seen, normalized);
		}
	}
	return result;
}

function inputBroadcastNames(input) {
	return broadcastNameCandidates(
		input?.name,
		input?.label,
		input?.localized_name,
		input?.display_name,
		broadcastNameTypeCandidate(input?.type),
		input?.widget?.name,
		input?.widget?.label,
		broadcastNameTypeCandidate(input?.widget?.type),
		broadcastNameTypeCandidate(input?.widget?.options?.type)
	);
}

function broadcastNamesMatch(sourceNames, input) {
	if (!sourceNames?.length) return false;
	const targets = new Set(inputBroadcastNames(input));
	return sourceNames.some((name) => targets.has(name));
}

function normalizeBroadcastType(value) {
	return normalizeTemplateSocketType(value || "*") || "*";
}

function broadcastTypesMatch(sourceType, targetType) {
	return isCompatibleType(normalizeBroadcastType(sourceType), normalizeBroadcastType(targetType));
}

function hasRealInputLink(graph, input) {
	if (!input) return false;
	if (Array.isArray(input.link)) return input.link.length > 0;
	if (input.link != null) return true;
	return false;
}

function promptInputHasRealConnection(nodeInfo, input) {
	const value = nodeInfo?.inputs?.[input?.name];
	return Array.isArray(value) && value.length >= 2;
}

function highLowRoleFromText(value) {
	const raw = String(value || "");
	const lower = raw.toLowerCase();
	const hasHigh = /(^|[^a-z0-9])high([^a-z0-9]|$)/i.test(raw)
		|| /高(?:模|模型|噪|阶段|采样|步)|前段|第一段/.test(raw);
	const hasLow = /(^|[^a-z0-9])low([^a-z0-9]|$)/i.test(raw)
		|| /低(?:模|模型|噪|阶段|采样|步)|后段|第二段/.test(raw);
	if (hasHigh && !hasLow) return "high";
	if (hasLow && !hasHigh) return "low";
	if (lower.includes("universal_high_model") || lower.includes("kijai_high_model")) return "high";
	if (lower.includes("universal_low_model") || lower.includes("kijai_low_model")) return "low";
	return "";
}

function outputBroadcastRole(output) {
	return highLowRoleFromText([
		output?.gjj_slot_id,
		output?.gjj_slot_class,
		output?.gjj_output_kind,
		output?.label,
		output?.localized_name,
		output?.name,
	].map((item) => String(item || "")).join(" "));
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkTargetId(link) {
	return Array.isArray(link) ? link[3] : link?.target_id;
}

function linkOriginSlot(link) {
	return Number(Array.isArray(link) ? link[2] : link?.origin_slot);
}

function linkTargetSlot(link) {
	return Number(Array.isArray(link) ? link[4] : link?.target_slot);
}

function graphNodeById(graph, id) {
	if (id == null || !graph) return null;
	return graph.getNodeById?.(id) || graph._nodes_by_id?.[id] || graph._nodes?.find((node) => String(node?.id) === String(id)) || null;
}

function broadcastTypeParts(value) {
	return normalizeBroadcastType(value).split(",").map((part) => part.trim()).filter(Boolean);
}

function slotHasType(slot, type) {
	const target = normalizeBroadcastType(type);
	return broadcastTypeParts(slot?.type).includes(target);
}

function slotIsModelInput(input) {
	const parts = broadcastTypeParts(input?.type);
	return parts.includes("MODEL") || parts.includes("WANVIDEOMODEL");
}

function slotIsLatent(slot) {
	return slotHasType(slot, "LATENT");
}

function nodeHasModelInput(node) {
	return (node?.inputs || []).some(slotIsModelInput);
}

function nodeHasLatentInput(node) {
	return (node?.inputs || []).some(slotIsLatent);
}

function nodeHasLatentOutput(node) {
	return (node?.outputs || []).some(slotIsLatent);
}

function isSamplerLikeNode(node) {
	const text = [
		node?.title,
		node?.type,
		node?.comfyClass,
		node?.nodeData?.display_name,
		node?.nodeData?.name,
	].map((item) => String(item || "")).join(" ").toLowerCase();
	if (/ksampler|sampler|采样/.test(text)) return true;
	return nodeHasModelInput(node) && nodeHasLatentInput(node) && nodeHasLatentOutput(node);
}

function roleFromSamplerTopology(node) {
	if (!node?.graph || !isSamplerLikeNode(node)) return "";
	for (const input of node.inputs || []) {
		if (!slotIsLatent(input) || input.link == null) continue;
		const link = getLink(node.graph, input.link);
		const sourceNode = graphNodeById(node.graph, linkOriginId(link));
		if (sourceNode && sourceNode !== node && isSamplerLikeNode(sourceNode)) return "low";
	}
	for (const outputIndex in node.outputs || []) {
		const output = node.outputs?.[Number(outputIndex)];
		if (!slotIsLatent(output)) continue;
		for (const linkId of output?.links || []) {
			const link = getLink(node.graph, linkId);
			const targetNode = graphNodeById(node.graph, linkTargetId(link));
			const targetInput = targetNode?.inputs?.[linkTargetSlot(link)];
			if (targetNode && targetNode !== node && isSamplerLikeNode(targetNode) && slotIsLatent(targetInput)) return "high";
		}
	}
	return "";
}

function widgetMatchesAnyName(widget, names) {
	const hay = normalizeBroadcastName([
		widget?.name,
		widget?.label,
		widget?.localized_name,
		widget?.options?.display_name,
	].map((item) => String(item || "")).join(" "));
	return names.some((name) => {
		const needle = normalizeBroadcastName(name);
		return needle && hay.includes(needle);
	});
}

function numericWidgetValueByName(node, names) {
	for (const widget of node?.widgets || []) {
		if (!widgetMatchesAnyName(widget, names)) continue;
		const value = Number(widget.value);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

function roleFromSamplerStartStep(node) {
	if (!isSamplerLikeNode(node)) return "";
	const startStep = numericWidgetValueByName(node, [
		"start_step",
		"start_at_step",
		"start step",
		"起始步",
		"开始步",
		"开始步数",
		"开始步骤",
	]);
	if (!Number.isFinite(startStep)) return "";
	return startStep <= 0 ? "high" : "low";
}

function targetModelBroadcastRole(node, input) {
	if (!slotIsModelInput(input)) return "";
	return highLowRoleFromText([
		input?.name,
		input?.label,
		input?.localized_name,
		input?.display_name,
	].join(" "))
		|| roleFromSamplerTopology(node)
		|| roleFromSamplerStartStep(node)
		|| highLowRoleFromText([
			node?.title,
			node?.type,
			node?.comfyClass,
			node?.nodeData?.display_name,
			node?.nodeData?.name,
		].join(" "));
}

function outputBroadcastAliases(output) {
	const slotId = String(output?.gjj_slot_id || "").trim();
	const rawClass = String(output?.gjj_slot_class || "").trim();
	const semanticClass = rawClass.replace(/^(?:universal|kijai)_/i, "");
	const kind = String(output?.gjj_output_kind || "").trim();
	const label = String(output?.label || output?.localized_name || output?.name || "").trim();
	const text = `${slotId} ${semanticClass} ${kind} ${label}`.toLowerCase();
	const aliases = [slotId, semanticClass, kind];

	const isHigh = /(^|[_\s-])high([_\s-]|$)/i.test(text) || text.includes("高");
	const isLow = /(^|[_\s-])low([_\s-]|$)/i.test(text) || text.includes("低");
	if (isHigh) aliases.push("high_model", "高模型");
	if (isLow) aliases.push("low_model", "低模型");
	if (!isHigh && !isLow && (text.includes("main_model") || slotId === "model" || text.includes("主模型"))) {
		aliases.push("model", "main_model", "主模型");
	}

	const isAudioVae = text.includes("audio_vae") || text.includes("音频vae");
	const isAlphaVae = text.includes("alpha_vae") || text.includes("透明");
	const isRgbVae = text.includes("rgb_vae");
	if (isAudioVae) aliases.push("audio_vae", "音频VAE");
	else if (text.includes("vae")) {
		aliases.push("vae", "video_vae", "视频VAE");
		if (isAlphaVae) aliases.push("alpha_vae", "透明VAE");
		if (isRgbVae) aliases.push("rgb_vae");
	}

	if (text.includes("model_patch") || text.includes("模型补丁")) aliases.push("model_patch", "模型补丁");
	if (text.includes("clip_vision")) aliases.push("clip_vision", "视觉编码器");
	if (text.includes("audio_encoder")) aliases.push("audio_encoder", "音频编码器");
	if (text.includes("text_encoder") || text.includes("wan_t5") || text.includes("clip编码器") || kind.includes("clip")) {
		aliases.push("clip", "text_encoder", "文本编码器");
	}
	if (text.includes("wan_t5")) aliases.push("wan_t5", "wan_t5_encoder", "t5", "t5_encoder");
	if (text.includes("latent_upscale_model")) aliases.push("latent_upscale_model", "空间放大模型");
	if (text.includes("extra_model") || text.includes("vace")) aliases.push("extra_model", "vace_model", "扩展模型");
	if (text.includes("fantasytalking")) aliases.push("fantasytalking_model");
	if (text.includes("multitalk")) aliases.push("multitalk_model");
	if (text.includes("fantasyportrait")) aliases.push("fantasyportrait_model");
	if (text.includes("steps") || text.includes("步数")) aliases.push("steps", "采样步数", "推荐采样步数");
	if (text.includes("cfg") || text.includes("引导")) aliases.push("cfg", "引导强度", "cfg引导强度");
	if (text.includes("denoise") || text.includes("降噪")) aliases.push("denoise", "降噪强度");
	return aliases;
}

function outputTypeCounts(node) {
	const counts = new Map();
	for (const output of node?.outputs || []) {
		if (!output || output.hidden || output.gjj_hidden_unused) continue;
		const type = normalizeBroadcastType(output.type || "*");
		counts.set(type, (counts.get(type) || 0) + 1);
	}
	return counts;
}

function collectOutputBroadcastEntries(node, graph) {
	if (!broadcastEnabled(node) || !isOutputBroadcastSourceNode(node)) return [];
	const counts = outputTypeCounts(node);
	return (node.outputs || []).map((output, index) => {
		if (!output || output.hidden || output.gjj_hidden_unused) return null;
		const type = output.type || "*";
		const typeKey = normalizeBroadcastType(type);
		const typeName = counts.get(typeKey) === 1 ? broadcastNameTypeCandidate(type) : "";
		const role = outputBroadcastRole(output);
		const names = broadcastNameCandidates(
			output.name,
			output.label,
			output.localized_name,
			output.display_name,
			...outputBroadcastAliases(output),
			typeName
		);
		if (!names.length) return null;
		return {
			kind: "output",
			node,
			graph,
			sourceSlot: index,
			type,
			role,
			names,
			resolve: () => node?.id == null ? null : [String(node.id), Number(index || 0)],
		};
	}).filter(Boolean);
}

function collectSetBroadcastEntries(node, graph) {
	if (!broadcastEnabled(node)) return [];
	const inputs = sortedInputs(node);
	const count = activeSetSlotCount(node);
	const entries = [];
	for (let index = 0; index < count; index += 1) {
		const input = inputs[index];
		const info = input ? slotInfoForSetInput(node, input, index) : { type: "*", name: `值 ${index + 1}` };
		const names = broadcastNameCandidates(
			setNamesForSlot(node, index),
			info.name,
			input?.label,
			input?.localized_name,
			broadcastNameTypeCandidate(info.type),
			broadcastNameTypeCandidate(input?.type)
		);
		if (!names.length || !resolveSetPromptSource(node, index)) {
			continue;
		}
		entries.push({
			kind: "set",
			node,
			graph,
			sourceSlot: index,
			type: info.type || input?.type || "*",
			names,
			resolve: () => resolveSetPromptSource(node, index),
		});
	}
	return entries;
}

function collectTemplateBroadcastEntries(entry) {
	const node = entry?.node;
	const graph = entry?.graph || node?.graph;
	if (!broadcastEnabled(node)) return [];
	const fields = templateFieldsForNode(node);
	return fields.map((field) => ({
		kind: "template",
		node,
		graph,
		sourceSlot: Number(field.outputIndex || 0),
		inputName: field.inputName,
		type: field.type || "*",
		names: broadcastNameCandidates(field.key, field.label, field.displayLabel, field.inputName, broadcastNameTypeCandidate(field.type)),
		resolve: () => resolveTemplatePromptSource({
			entry: { node, graph, kind: "template" },
			field,
			sourceSlot: Number(field.outputIndex || 0),
			inputName: field.inputName,
		}),
	})).filter((item) => item.names.length);
}

function collectBroadcastEntriesForGraph(graph) {
	const entries = [];
	const scopeGraphs = getGraphAncestors(graph);
	for (const entry of collectNodesOfType(scopeGraphs, SET_TYPE)) {
		entries.push(...collectSetBroadcastEntries(entry.node, entry.graph));
	}
	for (const entry of collectTemplateSetNodes(scopeGraphs)) {
		entries.push(...collectTemplateBroadcastEntries(entry));
	}
	for (const entry of collectOutputBroadcastSourceNodes(scopeGraphs)) {
		entries.push(...collectOutputBroadcastEntries(entry.node, entry.graph));
	}
	return entries;
}

function targetBroadcastInputType(input) {
	const type = input?.type || input?.widget?.type || input?.widget?.options?.type || "*";
	return normalizeBroadcastType(type);
}

function findBroadcastEntryForInput(entries, targetNode, input) {
	if (!input?.name) return null;
	const targetType = targetBroadcastInputType(input);
	const targetRole = targetModelBroadcastRole(targetNode, input);
	for (const entry of entries) {
		if (!entry?.node || entry.node === targetNode) continue;
		if (!broadcastTypesMatch(entry.type, targetType)) continue;
		const roleMatched = Boolean(entry.role && targetRole && entry.role === targetRole);
		if (!roleMatched && !broadcastNamesMatch(entry.names, input)) continue;
		return entry;
	}
	return null;
}

function patchBroadcastConsumers(promptResult, graph) {
	const output = promptResult?.output;
	if (!output || !graph) {
		return;
	}
	const cache = new Map();
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const found = findNodeForPromptId(graph, nodeId);
		const target = found?.node;
		const targetGraph = found?.graph || target?.graph || graph;
		if (!target?.inputs || target.type === GET_TYPE || target.type === SET_TYPE) {
			continue;
		}
		if (!cache.has(targetGraph)) {
			cache.set(targetGraph, collectBroadcastEntriesForGraph(targetGraph));
		}
		const entries = cache.get(targetGraph);
		if (!entries?.length) {
			continue;
		}
		nodeInfo.inputs = nodeInfo.inputs || {};
		for (const input of target.inputs) {
			if (!input?.name || hasRealInputLink(targetGraph, input) || promptInputHasRealConnection(nodeInfo, input)) {
				continue;
			}
			const entry = findBroadcastEntryForInput(entries, target, input);
			if (!entry) {
				continue;
			}
			const resolved = resolveVirtualPromptInput(graph, entry.resolve());
			if (!Array.isArray(resolved) || resolved.length !== 2 || String(resolved[0]) === String(target.id)) {
				continue;
			}
			nodeInfo.inputs[input.name] = [String(resolved[0]), Number(resolved[1] || 0)];
		}
	}
}

function patchSetGetPrompt(promptResult, graph) {
	const output = promptResult?.output;
	if (!output || !graph) {
		return promptResult;
	}
	patchDirectGetNodeConsumers(promptResult, graph);
	patchBroadcastConsumers(promptResult, graph);
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
	let count = Math.max(MIN_VISIBLE_SLOTS, sortedInputs(node).length, highestLinkedOutputIndex(node) + 1);
	while (sortedInputs(node).length < count) {
		const slot = sortedInputs(node).length;
		node.addInput?.(formatSlotName(slot + 1), node.outputs?.[slot]?.type || "*");
	}
	while ((node.outputs || []).length < count) {
		node.addOutput?.("输出", "*");
	}
	while ((node.outputs || []).length > count) {
		if (outputHasLinks(node.outputs[node.outputs.length - 1])) break;
		node.removeOutput?.(node.outputs.length - 1);
	}
	repairSetNodeLinkSlots(node);
}

function removeUnusedSetInputsFromEnd(node) {
	const inputs = sortedInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_SLOTS; index -= 1) {
		const input = inputs[index];
		const output = node.outputs?.[index];
		const outputLinked = outputHasLinks(output);
		if (input?.link || outputLinked) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
	repairSetNodeLinkSlots(node);
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
		outputHasLinks(lastOutput)
	) {
		node.addInput?.(formatSlotName(inputs.length + 1), lastInput.type || "*");
	}
	repairSetNodeLinkSlots(node);
}

function applySetSlotLabels(node) {
	if (!node) return;
	ensureSetOutputCount(node);
	const inputs = sortedInputs(node);
	if (inputs.length === (node.inputs?.length || 0) && inputs.some((input, index) => input !== node.inputs[index])) {
		node.inputs = inputs;
		repairSetNodeLinkSlots(node);
	}
	inputs.forEach((input, index) => {
		const output = node.outputs[index];
		const info = slotInfoForSetInput(node, input, index);
		const slotName = formatSlotName(index + 1);
		const variableName = setNamesForSlot(node, index)[0];
		const displayName = variableName || (info.name && info.name !== "*" ? String(info.name) : `值 ${index + 1}`);
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
	repairSetNodeLinkSlots(node);
}

function stabilizeSetNode(node) {
	if (!node) {
		return;
	}
	repairSetNodeLinkSlots(node);
	ensureSetOutputCount(node);
	removeUnusedSetInputsFromEnd(node);
	ensureTrailingSetInput(node);
	ensureSetOutputCount(node);
	ensureSetNameDomWidget(node);
	const previousNames = getPreviousSetNames(node);
	validateSetNames(node, false, true);
	const nextNames = getSetNames(node);
	syncRenamedGetterSelections(node, previousNames, nextNames);
	rememberSetNames(node);
	applySetSlotLabels(node);
	updateSetTitle(node);
	updateBroadcastToggleWidget(node);
	updateSetNameDomWidget(node);
	applyNodeDescription(node, SET_DESCRIPTION);
	setDirty(node);
	updateGettersForSetter(node);
}

function updateGettersForSetter(setter) {
	const names = getSetNames(setter);
	if (!setter?.graph || !names.length) {
		return;
	}
	const seen = new Set();
	for (const name of names) {
		for (const { node } of findGettersByName(setter.graph, name)) {
			if (seen.has(node)) continue;
			seen.add(node);
			stabilizeGetNode(node);
		}
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
	node.title = compactVariableTitle("➡️", names, GET_TITLE);
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

function setNameDomHeight() {
	return 34;
}

function hideSetNameStorageWidget(widget) {
	if (!widget) return;
	widget.hidden = true;
	widget.label = SET_NAME_WIDGET;
	widget.localized_name = SET_NAME_WIDGET;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden", display_name: SET_NAME_WIDGET };
}

function shieldSetNameDomEvents(element) {
	if (!element?.addEventListener || element.__gjjSetNameEventsShielded) return;
	element.__gjjSetNameEventsShielded = true;
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation(), { passive: eventName === "wheel" });
	}
	element.addEventListener("keydown", (event) => event.stopPropagation());
}

function commitSetNameInput(node, nextValue) {
	const widget = getSetNameWidget(node);
	if (!widget) return;
	const previousNames = getPreviousSetNames(node);
	widget.value = String(nextValue ?? "");
	validateSetNames(node);
	const nextNames = getSetNames(node);
	syncRenamedGetterSelections(node, previousNames, nextNames);
	syncManualSetNamesFromUserEdit(node, previousNames);
	rememberSetNames(node);
	stabilizeSetNode(node);
}

function updateSetNameDomWidget(node) {
	const input = node?.__gjjSetNameInput;
	const button = node?.__gjjSetBroadcastButton;
	const widget = getSetNameWidget(node);
	if (input && document.activeElement !== input) {
		input.value = String(widget?.value || "");
	}
	if (button) {
		const enabled = broadcastEnabled(node);
		button.classList.toggle("active", enabled);
		button.setAttribute("aria-pressed", String(enabled));
		button.title = enabled
			? "🔍 已开启：提交工作流时会把变量广播到同类型、同名称且未物理连接的输入口。"
			: "🔍 已关闭：只通过真实连线和变量读取节点传递变量。";
	}
}

function ensureSetNameDomWidget(node) {
	if (!node) return false;
	const storageWidget = getSetNameWidget(node);
	if (storageWidget) hideSetNameStorageWidget(storageWidget);
	if (node.__gjjSetNameDomWidget) {
		updateSetNameDomWidget(node);
		return true;
	}
	if (typeof node.addDOMWidget !== "function") return false;
	ensureStyles();

	const root = document.createElement("div");
	root.className = "gjj-setnode-name-row";
	shieldSetNameDomEvents(root);

	const button = document.createElement("button");
	button.className = "gjj-setnode-broadcast";
	button.type = "button";
	button.textContent = "⚡";
	button.setAttribute("aria-label", "切换变量广播");
	shieldSetNameDomEvents(button);

	const label = document.createElement("div");
	label.className = "gjj-setnode-name-label";
	label.textContent = "变量名";

	const input = document.createElement("input");
	input.className = "gjj-setnode-name-input";
	input.type = "text";
	input.value = String(storageWidget?.value || "");
	input.placeholder = "变量名";
	input.spellcheck = false;
	shieldSetNameDomEvents(input);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setBroadcastEnabled(node, !broadcastEnabled(node));
		updateSetNameDomWidget(node);
	});
	input.addEventListener("input", () => {
		const widget = getSetNameWidget(node);
		if (widget) widget.value = input.value;
		updateSetTitle(node);
		applySetSlotLabels(node);
		setDirty(node);
	});
	input.addEventListener("change", () => commitSetNameInput(node, input.value));
	input.addEventListener("blur", () => commitSetNameInput(node, input.value));
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			commitSetNameInput(node, input.value);
			input.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			input.value = String(getSetNameWidget(node)?.value || "");
			input.blur();
		}
	});

	root.append(button, label, input);
	const domWidget = node.addDOMWidget(SET_NAME_DOM_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	if (!domWidget) return false;
	domWidget.computeSize = (width) => [Math.max(240, Number(width || node.size?.[0] || 320)), setNameDomHeight()];
	domWidget.getHeight = () => setNameDomHeight();
	node.__gjjSetNameDomWidget = domWidget;
	node.__gjjSetNameInput = input;
	node.__gjjSetBroadcastButton = button;
	node.__gjjBroadcastToggleWidget = button;
	updateSetNameDomWidget(node);
	return true;
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
	const margin = 8;
	const popupWidth = Math.min(360, Math.max(260, window.innerWidth - margin * 2));
	const clickX = Number(event?.clientX || 0) || 120;
	const clickY = Number(event?.clientY || 0) || 120;
	const belowHeight = window.innerHeight - clickY - margin - 6;
	const aboveHeight = clickY - margin - 6;
	const openAbove = belowHeight < 260 && aboveHeight > belowHeight;
	const availableHeight = Math.max(120, openAbove ? aboveHeight : belowHeight);
	const maxHeight = Math.min(520, window.innerHeight - margin * 2, availableHeight);
	const maxX = Math.max(margin, window.innerWidth - popupWidth - margin);
	const x = Math.min(maxX, Math.max(margin, clickX));
	const y = openAbove
		? Math.max(margin, clickY - maxHeight - 6)
		: Math.min(window.innerHeight - margin - maxHeight, Math.max(margin, clickY + 6));
	popup.style.left = `${Math.round(x)}px`;
	popup.style.top = `${Math.round(y)}px`;
	popup.style.maxHeight = `${Math.round(maxHeight)}px`;

	const head = document.createElement("div");
	head.className = "gjj-getnode-head";
	const title = document.createElement("div");
	title.className = "gjj-getnode-title";
	title.textContent = "📍 选择变量";
	const count = document.createElement("span");
	count.className = "gjj-getnode-count";
	const actions = document.createElement("div");
	actions.className = "gjj-getnode-actions";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.className = "gjj-getnode-action";
	clear.textContent = "🧹 清空";
	const done = document.createElement("button");
	done.type = "button";
	done.className = "gjj-getnode-action";
	done.textContent = "✅ 完成";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "gjj-getnode-close";
	close.textContent = "❌";
	close.title = "关闭变量选择";
	actions.append(clear, done, close);
	head.append(title, count, actions);
	const search = document.createElement("input");
	search.className = "gjj-getnode-search";
	search.placeholder = "搜索变量，点击可多选";
	const list = document.createElement("div");
	list.className = "gjj-getnode-list";

	function commit() {
		setSelectedNames(node, selected);
		count.textContent = selected.length ? `✅ 已选 ${selected.length} 个` : "未选择";
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
	search.addEventListener("keydown", (keyEvent) => {
		if (keyEvent.key === "Escape") {
			keyEvent.preventDefault();
			keyEvent.stopPropagation();
			closeGetSelectPopup();
		}
	});
	clear.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		clickEvent.stopPropagation();
		selected = [];
		commit();
		render();
	});
	done.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		clickEvent.stopPropagation();
		closeGetSelectPopup();
	});
	close.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		clickEvent.stopPropagation();
		closeGetSelectPopup();
	});
	for (const el of [popup, head, title, count, search, list, actions, clear, done, close]) {
		for (const name of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
			el.addEventListener(name, (ev) => ev.stopPropagation());
		}
	}
	popup.append(head, search, list);
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

function defaultSetNameForSlot(index) {
	return `变量${index + 1}`;
}

function isAutoSetName(value, index) {
	const text = cleanupSetNameText(value);
	return !text
		|| text === defaultSetNameForSlot(index)
		|| /^变量\d+$/i.test(text)
		|| /^value[_\s-]*\d*$/i.test(text)
		|| /^输出\d*$/i.test(text);
}

function inferredSetNameForSlot(node, index) {
	const inferred = normalizeSetName(inferSetNameForSlot(node, index), index);
	return isAutoSetName(inferred, index) ? "" : inferred;
}

function liveSetNameForSlot(node, index) {
	return inferredSetNameForSlot(node, index) || inferSetNameForSlot(node, index);
}

function isGeneratedTypeSetNameForSlot(node, index, value) {
	const text = cleanupSetNameText(value);
	if (!text) return false;
	const input = sortedInputs(node)[index];
	const output = node?.outputs?.[index];
	const linked = getLinkedOutputInfo(node, input);
	const target = getLinkedTargetInfo(node, output);
	const candidates = [
		broadcastNameTypeCandidate(linked?.type),
		broadcastNameTypeCandidate(target?.type),
		broadcastNameTypeCandidate(input?.type),
		broadcastNameTypeCandidate(output?.type),
	].map(cleanupSetNameText).filter(Boolean);
	return candidates.some((candidate) => {
		const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`^${escaped}(?:_\\d+)?$`, "i").test(text);
	});
}

function cleanupSetNameText(value) {
	return String(value || "")
		.trim()
		.replace(/^[^0-9A-Za-z_\u4e00-\u9fff]+|[^0-9A-Za-z_\u4e00-\u9fff]+$/g, "")
		.replace(/^[_\s-]+|[_\s-]+$/g, "")
		.replace(/\s+/g, "_")
		.replace(/_+/g, "_");
}

function isWeakSetNameCandidate(value) {
	const text = cleanupSetNameText(value).toLowerCase();
	return !text || [
		"model", "vae", "clip", "image", "mask", "latent", "conditioning", "positive", "negative",
		"input", "output", "value", "any", "anytype",
	].includes(text);
}

function sourceSetNameCandidate(...values) {
	for (const value of values) {
		const raw = String(value || "").trim();
		if (!raw) continue;
		const explicit = raw.match(/[（(]\s*([A-Za-z][A-Za-z0-9_ -]*)\s*[）)]/);
		if (explicit) {
			const text = cleanupSetNameText(explicit[1]);
			if (text && !isWeakSetNameCandidate(text)) return text;
		}
	}
	let best = "";
	for (const value of values) {
		const raw = String(value || "").trim();
		if (!raw) continue;
		const matches = raw.match(/[A-Za-z][A-Za-z0-9]*(?:[_ -]+[A-Za-z0-9]+)*/g) || [];
		for (const match of matches) {
			const text = cleanupSetNameText(match);
			if (!isWeakSetNameCandidate(text) && text.length > best.length) best = text;
		}
	}
	return best;
}

function preferredSlotSetName(slot) {
	const socketName = sourceSetNameCandidate(slot?.name, slot?.widget?.name, slot?.widget?.label);
	if (socketName) return socketName;
	const displayName = sourceSetNameCandidate(slot?.label, slot?.localized_name, slot?.display_name);
	if (displayName) return displayName;
	return broadcastNameTypeCandidate(slot?.type);
}

function normalizeSetName(value, index = 0) {
	let text = cleanupSetNameText(value);
	if (!text || text === "*" || /^value[_\s-]*\d*$/i.test(text) || /^输出\d*$/i.test(text)) {
		text = defaultSetNameForSlot(index);
	}
	return text;
}

function inferSetNameForSlot(node, index) {
	const input = sortedInputs(node)[index];
	const output = node?.outputs?.[index];
	const linked = getLinkedOutputInfo(node, input);
	const target = getLinkedTargetInfo(node, output);
	return normalizeSetName(
		sourceSetNameCandidate(
			linked?.name,
			target?.name,
			input?.label,
			input?.localized_name,
			output?.label,
			output?.localized_name,
			input?.name,
			output?.name
		) ||
		broadcastNameTypeCandidate(linked?.type) ||
		broadcastNameTypeCandidate(target?.type) ||
		broadcastNameTypeCandidate(input?.type) ||
		broadcastNameTypeCandidate(output?.type) ||
		linked?.name ||
		target?.name ||
		input?.label ||
		input?.localized_name ||
		output?.label ||
		output?.localized_name ||
		input?.name ||
		output?.name,
		index
	);
}

function collectUsedSetNames(node, sameGraphOnly = false) {
	const scopeGraphs = sameGraphOnly ? [node?.graph] : getGraphAncestors(node?.graph);
	const usedNames = new Set();
	for (const { node: other } of collectNodesOfType(scopeGraphs, SET_TYPE)) {
		if (other === node) continue;
		for (const name of getSetNames(other)) {
			if (name) usedNames.add(name);
		}
	}
	return usedNames;
}

function makeUniqueSetName(rawName, usedNames, index = 0) {
	const base = normalizeSetName(rawName, index);
	let value = base;
	let tries = 2;
	while (usedNames.has(value)) {
		value = `${base}_${String(tries).padStart(2, "0")}`;
		tries += 1;
	}
	usedNames.add(value);
	return value;
}

function compactVariableTitle(arrow, names, fallbackTitle) {
	const clean = uniqueNames(names);
	if (!clean.length) return fallbackTitle;
	const shown = clean.slice(0, 3).join(", ");
	const suffix = clean.length > 3 ? ` +${clean.length - 3}` : "";
	return `${arrow} ${shown}${suffix}`;
}

function updateSetTitle(node) {
	const names = getSetNames(node);
	node.title = compactVariableTitle("⬅️", names, SET_TITLE);
}

function validateSetNames(node, sameGraphOnly = false, fillMissing = false) {
	const widget = getSetNameWidget(node);
	if (!widget) {
		return false;
	}
	let names = uniqueNames(widget.value || "");
	const usedCount = fillMissing ? usedSetSlotCount(node) : 0;
	if (fillMissing && usedCount > 0) {
		names = names.slice(0, usedCount);
		const manualNames = getManualSetNames(node);
		for (let index = 0; index < usedCount; index += 1) {
			const manual = manualNames[index] || "";
			const live = liveSetNameForSlot(node, index);
			if (manual) {
				names[index] = manual;
			} else if (live && (!names[index] || isAutoSetName(names[index], index) || isGeneratedTypeSetNameForSlot(node, index, names[index]) || names[index] !== live)) {
				names[index] = live;
			}
		}
	}
	if (!names.length) {
		widget.value = "";
		updateSetTitle(node);
		return false;
	}
	const original = setValueText(names);
	const usedNames = collectUsedSetNames(node, sameGraphOnly);
	const nextNames = names.map((name, index) => makeUniqueSetName(name, usedNames, index));
	const nextValue = setValueText(nextNames);
	widget.value = nextValue;
	updateSetTitle(node);
	return nextValue !== original;
}

function syncRenamedGetterSelections(node, previousNames, nextNames) {
	if (!node?.graph) return;
	const pairs = [];
	const count = Math.min(previousNames.length, nextNames.length);
	for (let index = 0; index < count; index += 1) {
		const oldName = previousNames[index];
		const newName = nextNames[index];
		if (oldName && newName && oldName !== newName) pairs.push([oldName, newName]);
	}
	for (const [oldName, newName] of pairs) {
		for (const getter of findGettersByName(node.graph, oldName).map((entry) => entry.node)) {
			replaceSelectedName(getter, oldName, newName);
		}
	}
}

function isCompatibleType(sourceType, targetType) {
	if (!sourceType || !targetType || sourceType === "*" || targetType === "*") {
		return true;
	}
	const sourceTypes = String(sourceType).split(",");
	const targetTypes = String(targetType).split(",");
	return sourceTypes.some((type) => targetTypes.includes(type));
}

function localPosForNode(node, pos, event) {
	if (Array.isArray(pos)) return pos;
	if (event && typeof event.canvasX === "number" && typeof event.canvasY === "number") {
		return [event.canvasX - Number(node?.pos?.[0] || 0), event.canvasY - Number(node?.pos?.[1] || 0)];
	}
	if (event && app.canvas?.convertEventToCanvasOffset) {
		try {
			const canvasPos = app.canvas.convertEventToCanvasOffset(event);
			return [canvasPos[0] - Number(node?.pos?.[0] || 0), canvasPos[1] - Number(node?.pos?.[1] || 0)];
		} catch (_) {}
	}
	return [Number(event?.offsetX || 0), Number(event?.offsetY || 0)];
}

function roundedRectPath(ctx, x, y, w, h, radius) {
	ctx.beginPath();
	if (ctx.roundRect) {
		ctx.roundRect(x, y, w, h, radius);
		return;
	}
	ctx.moveTo(x + radius, y);
	ctx.lineTo(x + w - radius, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
	ctx.lineTo(x + w, y + h - radius);
	ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
	ctx.lineTo(x + radius, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
	ctx.lineTo(x, y + radius);
	ctx.quadraticCurveTo(x, y, x + radius, y);
}

function removeDetachedBroadcastToggleWidget(node) {
	if (!Array.isArray(node?.widgets)) return;
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		const widget = node.widgets[index];
		if (widget?.name !== BROADCAST_WIDGET) continue;
		node.widgets.splice(index, 1);
		try { widget.element?.remove?.(); } catch (_) {}
		try { widget.inputEl?.remove?.(); } catch (_) {}
	}
	if (node.__gjjBroadcastToggleWidget?.name === BROADCAST_WIDGET) {
		node.__gjjBroadcastToggleWidget = null;
	}
}

function setBroadcastInlineTooltip(node, widget) {
	if (!widget) return;
	const enabled = broadcastEnabled(node);
	widget.__gjjBroadcastInlineEnabled = enabled;
	widget.__gjjBroadcastInlineTooltip = enabled
		? "🔍 已开启：提交工作流时会把变量广播到同类型、同名称且未物理连接的输入口。"
		: "🔍 已关闭：只通过真实连线和变量读取节点传递变量。";
}

function getSetBroadcastToggleRect(node, fallbackY = null) {
	const widget = getSetNameWidget(node);
	if (!widget) return null;
	const rowH = Math.max(24, Math.min(34, Number(widget.computedHeight || widget.height || widget.size?.[1] || 32)));
	let rawY = Number(widget.last_y ?? widget.y);
	if (!Number.isFinite(rawY) && Number.isFinite(Number(fallbackY))) {
		rawY = Number(fallbackY) - rowH;
	}
	if (!Number.isFinite(rawY)) return null;
	const h = Math.max(20, Math.min(24, rowH - 6));
	const w = 24;
	const x = 14;
	const y = rawY + Math.max(2, (rowH - h) * 0.5);
	return { x, y, w, h };
}

function drawSetBroadcastInlineToggle(node, ctx, fallbackY = null) {
	const widget = getSetNameWidget(node);
	if (!widget || !ctx) return;
	const rect = getSetBroadcastToggleRect(node, fallbackY);
	if (!rect) return;
	widget.__gjjBroadcastToggleRect = rect;
	const enabled = broadcastEnabled(node);
	ctx.save();
	roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 6);
	ctx.fillStyle = enabled ? "#243c32" : "#202b31";
	ctx.strokeStyle = enabled ? "#69b980" : "#44565f";
	ctx.lineWidth = 1;
	ctx.fill();
	ctx.stroke();
	ctx.font = "14px Arial";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = enabled ? "#ecfff1" : "#dce7e2";
	ctx.fillText("🔍", rect.x + rect.w * 0.5, rect.y + rect.h * 0.5 + 0.5);
	ctx.restore();
}

function handleSetBroadcastInlineClick(node, event, pos, rowScoped = false) {
	const rect = getSetNameWidget(node)?.__gjjBroadcastToggleRect || getSetBroadcastToggleRect(node);
	const p = localPosForNode(node, pos, event);
	const x = Number(p?.[0]);
	const y = Number(p?.[1]);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
	if (rowScoped && x >= 8 && x <= 62) {
		const inKnownRow = rect && y >= rect.y - 8 && y <= rect.y + rect.h + 8;
		const looksWidgetLocal = y >= 0 && y <= 36;
		const looksNodeRow = !rect && y > 30;
		if (inKnownRow || looksWidgetLocal || looksNodeRow) {
			event?.preventDefault?.();
			event?.stopPropagation?.();
			setBroadcastEnabled(node, !broadcastEnabled(node));
			return true;
		}
	}
	if (!rect) return false;
	if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) return false;
	event?.preventDefault?.();
	event?.stopPropagation?.();
	setBroadcastEnabled(node, !broadcastEnabled(node));
	return true;
}

function forceRefreshSetNamesFromLinks(node) {
	const widget = getSetNameWidget(node);
	if (!widget) return false;
	const usedCount = usedSetSlotCount(node);
	if (usedCount <= 0) return false;
	const current = uniqueNames(widget.value || "");
	const manual = getManualSetNames(node);
	let changed = false;
	for (let index = 0; index < usedCount; index += 1) {
		if (manual[index]) {
			current[index] = manual[index];
			continue;
		}
		const live = liveSetNameForSlot(node, index);
		if (live && current[index] !== live) {
			current[index] = live;
			changed = true;
		}
	}
	if (!changed) return false;
	widget.value = setValueText(current.slice(0, Math.max(current.length, usedCount)));
	updateSetTitle(node);
	applySetSlotLabels(node);
	updateSetNameDomWidget(node);
	setDirty(node);
	return true;
}

function updateBroadcastToggleWidget(node) {
	if (node?.__gjjSetNameDomWidget || node?.__gjjSetBroadcastButton) {
		updateSetNameDomWidget(node);
		return;
	}
	const widget = node?.__gjjBroadcastToggleWidget || getSetNameWidget(node);
	const nameWidget = getSetNameWidget(node);
	if (!widget && !nameWidget) return;
	const enabled = broadcastEnabled(node);
	if (widget?.name === BROADCAST_WIDGET) widget.value = enabled;
	if (nameWidget) {
		const label = SET_NAME_WIDGET;
		nameWidget.label = label;
		nameWidget.localized_name = label;
		nameWidget.options = { ...(nameWidget.options || {}), display_name: label };
		setBroadcastInlineTooltip(node, nameWidget);
	}
	if (widget) setBroadcastInlineTooltip(node, widget);
}

function addSetBroadcastToggleWidget(node) {
	if (!node) return;
	removeDetachedBroadcastToggleWidget(node);
	if (ensureSetNameDomWidget(node)) {
		updateBroadcastToggleWidget(node);
		return;
	}
	const widget = getSetNameWidget(node);
	if (!widget) return;
	node.__gjjBroadcastToggleWidget = widget;
	if (!widget.__gjjBroadcastInlinePatched) {
		const originalMouse = typeof widget.mouse === "function" ? widget.mouse : null;
		widget.__gjjBroadcastInlinePatched = true;
		widget.__gjjBroadcastOriginalMouse = originalMouse;
		widget.mouse = function (event, pos, nodeRef) {
			const eventType = String(event?.type || "");
			if (["pointerdown", "mousedown", "click"].includes(eventType) && handleSetBroadcastInlineClick(nodeRef || node, event, pos, true)) {
				return true;
			}
			return originalMouse ? originalMouse.apply(this, arguments) : false;
		};
	}
	updateBroadcastToggleWidget(node);
}

function selectedNodesValues() {
	const selected = app.canvas?.selected_nodes;
	if (!selected) return [];
	if (selected instanceof Map) return [...selected.values()];
	if (Array.isArray(selected)) return selected;
	if (typeof selected === "object") return Object.values(selected);
	return [];
}

function isNodeSelected(node) {
	if (!node) return false;
	if (node.selected) return true;
	const selected = app.canvas?.selected_nodes;
	if (selected instanceof Map) {
		return selected.has(node.id) || selected.has(String(node.id)) || selected.has(node);
	}
	if (selected && typeof selected === "object" && (selected[node.id] || selected[String(node.id)])) {
		return true;
	}
	return selectedNodesValues().some((item) => item === node || String(item?.id) === String(node.id));
}

function connectionPosition(node, isInput, slotIndex) {
	if (!node) return [0, 0];
	const out = new Float32Array(2);
	try {
		if (node.getSlotPosition) {
			const pos = node.getSlotPosition(slotIndex, isInput);
			if (pos) return [Number(pos[0]), Number(pos[1])];
		}
		if (node.getConnectionPos) {
			const pos = node.getConnectionPos(isInput, slotIndex, out);
			if (pos) return [Number(pos[0]), Number(pos[1])];
		}
	} catch (_) {}
	const pos = Array.isArray(node.pos) ? node.pos : [0, 0];
	const size = Array.isArray(node.size) ? node.size : [220, 120];
	const slotY = pos[1] + 34 + Math.min(12, Math.max(0, slotIndex)) * 18;
	return [
		pos[0] + (isInput ? 0 : Number(size[0] || 220)),
		Math.min(pos[1] + Number(size[1] || 120) - 12, slotY),
	];
}

function sourceConnectionPosition(entry) {
	const node = entry?.node;
	const slot = Number(entry?.sourceSlot || 0);
	if (node?.outputs?.[slot]) {
		return connectionPosition(node, false, slot);
	}
	const pos = Array.isArray(node?.pos) ? node.pos : [0, 0];
	const size = Array.isArray(node?.size) ? node.size : [220, 120];
	return [
		pos[0] + Number(size[0] || 220),
		Math.min(pos[1] + Number(size[1] || 120) - 14, pos[1] + 34 + Math.min(12, slot) * 16),
	];
}

function collectBroadcastVisualLinks(sourceNode) {
	const graph = sourceNode?.graph;
	if (!graph || !broadcastEnabled(sourceNode)) return [];
	const sourceEntry = { node: sourceNode, graph };
	const entries = sourceNode.type === SET_TYPE
		? collectSetBroadcastEntries(sourceNode, graph)
		: isTemplateSetNode(sourceNode)
			? collectTemplateBroadcastEntries(sourceEntry)
			: isOutputBroadcastSourceNode(sourceNode)
				? collectOutputBroadcastEntries(sourceNode, graph)
				: [];
	if (!entries.length) return [];
	const result = [];
	for (const target of graph._nodes || []) {
		if (!target?.inputs || target === sourceNode || target.type === GET_TYPE || target.type === SET_TYPE) continue;
		for (let inputIndex = 0; inputIndex < target.inputs.length; inputIndex += 1) {
			const input = target.inputs[inputIndex];
			if (!input?.name || hasRealInputLink(graph, input)) continue;
			const entry = findBroadcastEntryForInput(entries, target, input);
			if (!entry) continue;
			const resolved = resolveVirtualPromptInput(graph, entry.resolve());
			if (!Array.isArray(resolved) || String(resolved[0]) === String(target.id)) continue;
			result.push({ entry, target, input, inputIndex });
		}
	}
	return result;
}

function drawBroadcastCurve(ctx, from, to, type) {
	const color = globalThis.LGraphCanvas?.link_type_colors?.[normalizeBroadcastType(type)] || "#7dd3fc";
	const dx = Math.max(60, Math.abs(to[0] - from[0]) * 0.5);
	ctx.save();
	ctx.strokeStyle = color;
	ctx.lineWidth = 2;
	ctx.globalAlpha = 0.82;
	ctx.setLineDash?.([8, 5]);
	ctx.shadowColor = color;
	ctx.shadowBlur = 6;
	ctx.beginPath();
	ctx.moveTo(from[0], from[1]);
	ctx.bezierCurveTo(from[0] + dx, from[1], to[0] - dx, to[1], to[0], to[1]);
	ctx.stroke();
	ctx.setLineDash?.([]);
	ctx.shadowBlur = 0;
	ctx.fillStyle = color;
	ctx.globalAlpha = 0.95;
	ctx.beginPath();
	ctx.arc(to[0], to[1], 4, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();
}

function drawBroadcastLinksForNode(node, ctx) {
	if (broadcastDrawConnectionsInstalled || !node || !ctx || !broadcastEnabled(node)) return;
	const links = collectBroadcastVisualLinks(node);
	if (!links.length) return;
	const sourceSelected = isNodeSelected(node);
	ctx.save();
	ctx.translate(-Number(node.pos?.[0] || 0), -Number(node.pos?.[1] || 0));
	for (const link of links) {
		if (!sourceSelected && !isNodeSelected(link.target)) continue;
		drawBroadcastCurve(
			ctx,
			sourceConnectionPosition(link.entry),
			connectionPosition(link.target, true, link.inputIndex),
			link.entry.type
		);
	}
	ctx.restore();
}

function drawBroadcastLinksOnCanvas(ctx, graph) {
	if (!ctx || !graph) return;
	for (const node of graph._nodes || []) {
		if (!broadcastEnabled(node) || (node.type !== SET_TYPE && !isTemplateSetNode(node) && !isOutputBroadcastSourceNode(node))) {
			continue;
		}
		const links = collectBroadcastVisualLinks(node);
		if (!links.length) continue;
		const sourceSelected = isNodeSelected(node);
		for (const link of links) {
			if (!sourceSelected && !isNodeSelected(link.target)) continue;
			drawBroadcastCurve(
				ctx,
				sourceConnectionPosition(link.entry),
				connectionPosition(link.target, true, link.inputIndex),
				link.entry.type
			);
		}
	}
}

function installBroadcastDrawPatch() {
	const proto = globalThis.LGraphCanvas?.prototype;
	if (!proto || proto.__gjjVariableBroadcastDrawPatchInstalled) {
		broadcastDrawConnectionsInstalled = Boolean(proto?.__gjjVariableBroadcastDrawPatchInstalled);
		return;
	}
	proto.__gjjVariableBroadcastDrawPatchInstalled = true;
	broadcastDrawConnectionsInstalled = true;
	const originalDrawConnections = proto.drawConnections;
	proto.drawConnections = function (ctx, ...args) {
		const result = originalDrawConnections?.apply(this, [ctx, ...args]);
		try {
			drawBroadcastLinksOnCanvas(ctx, this.graph || app.canvas?.graph || app.graph);
		} catch (error) {
			console.warn("[GJJ] variable broadcast draw failed:", error);
		}
		return result;
	};
}

app.registerExtension({
	name: "Comfy.GJJ.SetGetNode",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TEMPLATE_SET_TYPE) return;
		const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (ctx, ...args) {
			const result = originalOnDrawForeground?.apply(this, [ctx, ...args]);
			drawBroadcastLinksForNode(this, ctx);
			return result;
		};
	},

	registerCustomNodes() {
		const LGraphNode = LiteGraph.LGraphNode;

		class GJJSetNode extends LGraphNode {
			static title = SET_TITLE;
			static category = SET_CATEGORY;
			static desc = SET_DESCRIPTION;
			static description = SET_DESCRIPTION;
			static nodeData = SET_NODE_DATA;
			serialize_widgets = true;
			isVirtualNode = true;

			constructor(title) {
				super(title);
				releaseForcedDefaultColors(this);
				applyNodeDescription(this, SET_DESCRIPTION);
				this.properties = this.properties || {};
				this.properties.previousName = this.properties.previousName || "";
				this.properties[SET_PREVIOUS_NAMES_PROPERTY] = this.properties[SET_PREVIOUS_NAMES_PROPERTY] || [];
				this.properties["Node name for S&R"] = SET_TYPE;
				this.properties.aux_id = SET_TYPE;
				this.nodeData = SET_NODE_DATA;
				this.addWidget("text", SET_NAME_WIDGET, "", () => {
					if (app.configuringGraph) {
						return;
					}
					const previousNames = getPreviousSetNames(this);
					validateSetNames(this);
					const nextNames = getSetNames(this);
					syncRenamedGetterSelections(this, previousNames, nextNames);
					syncManualSetNamesFromUserEdit(this, previousNames);
					rememberSetNames(this);
					stabilizeSetNode(this);
				});
				addSetBroadcastToggleWidget(this);
				this.addInput(formatSlotName(1), "*");
				this.addOutput(formatSlotName(1), "*");
				stabilizeSetNode(this);
			}

			onAdded() {
				this._justAdded = true;
			}

			onConfigure() {
				releaseForcedDefaultColors(this);
				if (this._justAdded && this.graph && !app.configuringGraph) {
					const oldNames = getSetNames(this);
					validateSetNames(this, true, false);
					const newNames = getSetNames(this);
					const count = Math.min(oldNames.length, newNames.length);
					for (let index = 0; index < count; index += 1) {
						const oldName = oldNames[index];
						const newName = newNames[index];
						if (oldName && newName && oldName !== newName) {
							pasteRenameMap.set(oldName, newName);
						}
					}
					if (pasteRenameMap.size) setTimeout(() => pasteRenameMap.clear(), 0);
				}
				this._justAdded = false;
				rememberSetNames(this);
				updateBroadcastToggleWidget(this);
				scheduleSetStabilize(this, 0);
			}

			onSerialize(serializedNode) {
				if (serializedNode) {
					serializedNode.properties = serializedNode.properties || {};
					serializedNode.properties[BROADCAST_PROPERTY] = broadcastEnabled(this);
				}
			}

			onConnectionsChange() {
				if (app.configuringGraph) {
					return;
				}
				scheduleSetStabilize(this, 96);
			}

			onMouseDown(event, pos, canvas) {
				if (!this.__gjjSetNameDomWidget && handleSetBroadcastInlineClick(this, event, pos, true)) {
					return true;
				}
				return super.onMouseDown?.(event, pos, canvas);
			}

			onDrawForeground(ctx) {
				drawBroadcastLinksForNode(this, ctx);
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
						const names = setVariableEntriesForNode(this).map((entry) => entry.name);
						setSelectedNames(getter, names.length ? names : getSetNames(this), false);
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
			static nodeData = GET_NODE_DATA;
			serialize_widgets = true;
			isVirtualNode = true;

			constructor(title) {
				super(title);
				releaseForcedDefaultColors(this);
				applyNodeDescription(this, GET_DESCRIPTION);
				this.properties = this.properties || {};
				this.properties["Node name for S&R"] = GET_TYPE;
				this.properties.aux_id = GET_TYPE;
				this.nodeData = GET_NODE_DATA;
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
				releaseForcedDefaultColors(this);
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
		installBroadcastDrawPatch();
		if (!window.__gjjTemplateSetVariablesGetNodeListener) {
			window.__gjjTemplateSetVariablesGetNodeListener = true;
			window.addEventListener("gjj-template-set-variables-updated", () => scheduleAllGetStabilize(0));
		}
		if (!window.__gjjVariableBroadcastListener) {
			window.__gjjVariableBroadcastListener = true;
			window.addEventListener("gjj-variable-broadcast-updated", () => scheduleBroadcastCanvasRefresh());
		}
		for (const node of app.graph?._nodes || []) {
			if (node?.type === SET_TYPE) {
				releaseForcedDefaultColors(node);
				addSetBroadcastToggleWidget(node);
				stabilizeSetNode(node);
			} else if (node?.type === GET_TYPE) {
				releaseForcedDefaultColors(node);
				stabilizeGetNode(node);
			}
		}
	},
});

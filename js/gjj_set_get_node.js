import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const SET_TYPE = "GJJ_SetNode";
const GET_TYPE = "GJJ_GetNode";
const SLOT_PREFIX = "value_";
const MIN_VISIBLE_SLOTS = 1;
const SET_TITLE = "GJJ · 📌 变量设置";
const GET_TITLE = "GJJ · 📍 变量读取";
const SET_CATEGORY = "GJJ/工具";
const GET_CATEGORY = "GJJ/工具";
const DEFAULT_COLOR = "#1B252B";
const DEFAULT_BG = "#141B1F";

const pasteRenameMap = new Map();
let setNameSourceMap = new Map();

function formatSlotName(index) {
	return `${SLOT_PREFIX}${String(index).padStart(2, "0")}`;
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

function findRootGraph(graph) {
	return graph?.rootGraph || graph || null;
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

function findSetterByName(graph, name) {
	if (!name) {
		return null;
	}
	for (const scopeGraph of getGraphAncestors(graph)) {
		const setter = scopeGraph?._nodes?.find(
			(node) => node?.type === SET_TYPE && node.widgets?.[0]?.value === name
		);
		if (setter) {
			return { node: setter, graph: scopeGraph };
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
		(entry) => entry.node.widgets?.[0]?.value === name
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
	setNameSourceMap = sourceMap;
	return [...sourceMap.keys()].sort((a, b) => a.localeCompare(b));
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
		const output = getter.outputs?.[slotIndex];
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
		const output = getter.outputs?.[slotIndex];
		if (Array.isArray(output?.links) && output.links.length > 0) {
			return true;
		}
	}
	return false;
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
	const name = node.widgets?.[0]?.value;
	const setterEntry = findSetterByName(node.graph, name);
	const setter = setterEntry?.node;
	const setterInputs = setter ? sortedInputs(setter) : [];
	const desiredCount = Math.max(MIN_VISIBLE_SLOTS, setterInputs.length);
	while ((node.outputs || []).length < desiredCount) {
		node.addOutput?.("输出", "*");
	}
	while ((node.outputs || []).length > desiredCount) {
		node.removeOutput?.(node.outputs.length - 1);
	}
	for (let index = 0; index < desiredCount; index += 1) {
		const setterInput = setterInputs[index];
		const info = setterInput
			? slotInfoForSetInput(setter, setterInput, index)
			: { type: "*", name: `值 ${index + 1}` };
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
		output.tooltip = "从同名 GJJ 变量设置节点的对应插槽取值。";
	}
	node.title = name ? `${GET_TITLE} · ${name}` : GET_TITLE;
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
			serialize_widgets = true;
			isVirtualNode = true;
			color = DEFAULT_COLOR;
			bgcolor = DEFAULT_BG;

			constructor(title) {
				super(title);
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
							getter.widgets[0].value = this.widgets[0].value;
							stabilizeGetNode(getter);
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
						getter.widgets[0].value = this.widgets[0].value;
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
			serialize_widgets = true;
			isVirtualNode = true;
			color = DEFAULT_COLOR;
			bgcolor = DEFAULT_BG;

			constructor(title) {
				super(title);
				this.properties = this.properties || {};
				this.properties["Node name for S&R"] = GET_TYPE;
				this.properties.aux_id = GET_TYPE;
				const comboOptions = {
					getOptionLabel: (value) => {
						const source = setNameSourceMap.get(value);
						return source && source !== "local" ? `${value} (${source})` : value;
					},
				};
				Object.defineProperty(comboOptions, "values", {
					get: () => getVisibleSetNames(this.graph),
					enumerable: true,
					configurable: true,
				});
				this.addWidget("combo", "变量名", "", () => {
					if (!app.configuringGraph) {
						stabilizeGetNode(this);
					}
				}, comboOptions);
				this.addOutput(formatSlotName(1), "*");
				stabilizeGetNode(this);
			}

			onAdded() {
				this._justAdded = true;
			}

			onConfigure() {
				if (this._justAdded && !app.configuringGraph) {
					const name = this.widgets?.[0]?.value;
					const renamed = pasteRenameMap.get(name);
					if (renamed) {
						this.widgets[0].value = renamed;
					}
				}
				this._justAdded = false;
				scheduleGetStabilize(this, 0);
			}

			onConnectionsChange() {
				if (app.configuringGraph) {
					return;
				}
				this.validateLinks();
				const setter = findSetterByName(this.graph, this.widgets?.[0]?.value)?.node;
				if (setter) {
					scheduleSetStabilize(setter);
				}
				scheduleGetStabilize(this);
			}

			getInputLink(slot) {
				const name = this.widgets?.[0]?.value;
				const setterEntry = findSetterByName(this.graph, name);
				const setter = setterEntry?.node;
				const setterGraph = setterEntry?.graph;
				if (!setter || !setterGraph) {
					return null;
				}
				const input = sortedInputs(setter)[slot];
				if (!input || input.link == null) {
					return null;
				}
				return getLink(setterGraph, input.link);
			}

			resolveVirtualOutput(slot) {
				const name = this.widgets?.[0]?.value;
				const setterEntry = findSetterByName(this.graph, name);
				if (!setterEntry || setterEntry.graph === this.graph) {
					return undefined;
				}
				const input = sortedInputs(setterEntry.node)[slot];
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
						const setter = findSetterByName(this.graph, this.widgets?.[0]?.value)?.node;
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
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.type === SET_TYPE) {
				stabilizeSetNode(node);
			} else if (node?.type === GET_TYPE) {
				stabilizeGetNode(node);
			}
		}
	},
});

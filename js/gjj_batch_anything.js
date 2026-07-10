import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_batchAnything"]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const OUTPUT_NAME = "批量/拼接结果（单对象）";
const INPUT_TOOLTIP = "动态任意输入；连接最后一个输入口后会自动新增下一路，未连接的尾部输入不会参与执行。";
const OUTPUT_TOOLTIP = "按输入顺序合成一个单对象输出。图片和 latent 会自动对齐尺寸后拼接 batch，不是 ComfyUI 列表口。";
const GRAPH_PROMPT_PATCH_FLAG = "__gjjBatchAnythingGraphToPromptPatched";

function formatInputName(index) {
	return `${INPUT_PREFIX}${index}`;
}

function inputIndex(input) {
	const text = String(input?.name || "");
	if (!text.startsWith(INPUT_PREFIX)) return Number.MAX_SAFE_INTEGER;
	const value = Number.parseInt(text.slice(INPUT_PREFIX.length), 10);
	return Number.isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function normalizeLegacyInputName(input) {
	const text = String(input?.name || "");
	const match = text.match(/^any_(\d+)$/);
	if (!match) return;
	const value = Number.parseInt(match[1], 10);
	if (Number.isFinite(value) && value > 0) {
		input.name = formatInputName(value);
	}
}

function sortedInputs(node) {
	if (!Array.isArray(node?.inputs)) return [];
	for (const input of node.inputs) normalizeLegacyInputName(input);
	return [...node.inputs]
			.filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX))
			.sort((a, b) => inputIndex(a) - inputIndex(b))
}

function linkById(id) {
	return id != null ? app.graph?.links?.[id] : null;
}

function isLiveLink(id) {
	return id != null && !!linkById(id);
}

function cleanLabel(value) {
	const text = String(value || "").trim();
	if (!text || text === "*" || text === "undefined" || text === "null") return "";
	return text.replace(/^GJJ\s*·\s*/i, "").trim();
}

function slotLabel(slot) {
	return cleanLabel(slot?.localized_name)
		|| cleanLabel(slot?.label)
		|| cleanLabel(slot?.display_name)
		|| cleanLabel(slot?.name);
}

function linkedSourceInfo(input) {
	if (!isLiveLink(input?.link)) return null;
	const link = linkById(input.link);
	const sourceNode = link?.origin_id != null ? app.graph?.getNodeById?.(link.origin_id) : null;
	const sourceSlot = sourceNode?.outputs?.[link?.origin_slot];
	if (!sourceSlot) return null;
	return {
		type: sourceSlot.type || input.type || "*",
		label: slotLabel(sourceSlot),
	};
}

function linkedTargetInfo(output) {
	const links = Array.isArray(output?.links) ? output.links.filter((id) => isLiveLink(id)) : [];
	for (const id of links) {
		const link = linkById(id);
		const targetNode = link?.target_id != null ? app.graph?.getNodeById?.(link.target_id) : null;
		const targetSlot = targetNode?.inputs?.[link?.target_slot];
		if (targetSlot) {
			return {
				type: targetSlot.type || output.type || "*",
				label: slotLabel(targetSlot),
			};
		}
	}
	return null;
}

function firstSourceInfo(node) {
	for (const input of sortedInputs(node)) {
		const info = linkedSourceInfo(input);
		if (info) return info;
	}
	return null;
}

function outputInfo(node) {
	const output = node?.outputs?.[0];
	return linkedTargetInfo(output) || firstSourceInfo(node) || { type: "*", label: "" };
}

function disconnectInput(node, slotIndex) {
	try {
		node.disconnectInput?.(slotIndex);
	} catch (_) {}
}

function sanitizeStaleLinks(node) {
	if (!node) return false;
	let changed = false;
	for (const [slot, input] of (node.inputs || []).entries()) {
		if (input?.link != null && !isLiveLink(input.link)) {
			disconnectInput(node, slot);
			input.link = null;
			changed = true;
		}
	}
	for (const output of node.outputs || []) {
		if (!Array.isArray(output?.links)) continue;
		const live = output.links.filter((id) => isLiveLink(id));
		if (live.length !== output.links.length) {
			output.links = live;
			changed = true;
		}
	}
	return changed;
}

function ensureOutput(node) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	if (!node.outputs[0]) {
		node.addOutput?.(OUTPUT_NAME, "*");
	}
	while ((node.outputs?.length || 0) > 1) {
		node.removeOutput?.(node.outputs.length - 1);
	}
}

function addDynamicInput(node, type = "*") {
	const nextIndex = sortedInputs(node).length + 1;
	node.addInput?.(formatInputName(nextIndex), type || "*");
}

function removeUnusedInputsFromEnd(node) {
	const inputs = sortedInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_INPUTS; index -= 1) {
		const input = inputs[index];
		if (isLiveLink(input?.link)) break;
		const slotIndex = node.inputs?.indexOf(input) ?? -1;
		if (slotIndex >= 0) {
			disconnectInput(node, slotIndex);
			node.removeInput?.(slotIndex);
		}
	}
}

function compactDynamicInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const dynamic = sortedInputs(node);
	let linkedCount = 0;
	for (const input of dynamic) {
		if (isLiveLink(input?.link)) linkedCount += 1;
	}
	let keptEmpty = false;
	for (let index = dynamic.length - 1; index >= 0; index -= 1) {
		const input = dynamic[index];
		if (isLiveLink(input?.link)) continue;
		if (!keptEmpty && linkedCount === 0 && index === 0) {
			keptEmpty = true;
			continue;
		}
		if (!keptEmpty && index === dynamic.length - 1) {
			keptEmpty = true;
			continue;
		}
		const slotIndex = node.inputs?.indexOf(input) ?? -1;
		if (slotIndex >= 0) {
			disconnectInput(node, slotIndex);
			node.removeInput?.(slotIndex);
		}
	}
}

function ensureTrailingEmptyInput(node, fallbackType = "*") {
	const inputs = sortedInputs(node);
	if (inputs.length === 0) {
		addDynamicInput(node, fallbackType);
		return;
	}
	const last = inputs[inputs.length - 1];
	if (isLiveLink(last?.link)) {
		addDynamicInput(node, last.type || fallbackType || "*");
	}
}

function orderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const dynamic = sortedInputs(node).sort((a, b) => {
		const aLinked = isLiveLink(a?.link) ? 0 : 1;
		const bLinked = isLiveLink(b?.link) ? 0 : 1;
		return aLinked - bLinked || inputIndex(a) - inputIndex(b);
	});
	const fixed = node.inputs.filter((input) => !String(input?.name || "").startsWith(INPUT_PREFIX));
	node.inputs.splice(0, node.inputs.length, ...fixed, ...dynamic);
}

function applyInputMeta(node, fallbackInfo) {
	sortedInputs(node).forEach((input, index) => {
		const source = linkedSourceInfo(input);
		const resolvedType = source?.type || fallbackInfo?.type || "*";
		const fallbackLabel = `任意输入 ${index + 1}`;
		const label = source?.label || fallbackInfo?.label || fallbackLabel;
		input.name = formatInputName(index + 1);
		input.type = resolvedType;
		input.label = label || fallbackLabel;
		input.localized_name = input.label;
		input.tooltip = INPUT_TOOLTIP;
	});
}

function applyOutputMeta(node, info) {
	const output = node.outputs?.[0];
	if (!output) return;
	const target = linkedTargetInfo(output);
	const source = firstSourceInfo(node);
	const type = target?.type || source?.type || info?.type || "*";
	const label = target?.label || (source?.label ? `${source.label}批量/拼接` : "") || OUTPUT_NAME;
	output.name = OUTPUT_NAME;
	output.type = type;
	output.label = label;
	output.localized_name = label;
	output.tooltip = OUTPUT_TOOLTIP;
}

function linkSignature(node) {
	const ins = (node.inputs || []).map((input) => `${input.name}:${input.link ?? ""}`).join("|");
	const outs = (node.outputs || []).map((output) => `${output.name}:${(output.links || []).join(",")}`).join("|");
	return `${ins}=>${outs}`;
}

function stabilizeNode(node) {
	if (!node) return;
	sanitizeStaleLinks(node);
	ensureOutput(node);
	const info = outputInfo(node);
	compactDynamicInputs(node);
	removeUnusedInputsFromEnd(node);
	ensureTrailingEmptyInput(node, info?.type || "*");
	orderInputs(node);
	applyInputMeta(node, info);
	applyOutputMeta(node, info);
	node.__gjjBatchAnythingLinkSignature = linkSignature(node);
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjBatchAnythingTimer);
	node.__gjjBatchAnythingTimer = setTimeout(() => stabilizeNode(node), ms);
}

function stabilizeAllBatchAnythingNodes() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(node?.comfyClass || node?.type)) {
			stabilizeNode(node);
		}
	}
}

function patchGraphToPrompt() {
	if (app[GRAPH_PROMPT_PATCH_FLAG] || typeof app.graphToPrompt !== "function") return;
	app[GRAPH_PROMPT_PATCH_FLAG] = true;
	const original = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		stabilizeAllBatchAnythingNodes();
		return original(...args);
	};
}

app.registerExtension({
	name: "Comfy.GJJ.BatchAnything",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 150);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 150);
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
			const signature = linkSignature(this);
			if (signature !== this.__gjjBatchAnythingLinkSignature) {
				scheduleStabilize(this, 16);
			}
			return result;
		};
	},

	setup() {
		patchGraphToPrompt();
		stabilizeAllBatchAnythingNodes();
		setTimeout(stabilizeAllBatchAnythingNodes, 500);
	},
});

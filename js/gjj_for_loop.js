import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_ForLoopStart", "GJJ_ForLoopEnd"]);
const MAX_VALUES = 19;
const INPUT_PREFIX = "initial_value";
const OUTPUT_PREFIX = "值 ";
const STATUS_WIDGET = "gjj_for_loop_status";

function isStart(node) {
	return node?.comfyClass === "GJJ_ForLoopStart";
}

function dynamicInputIndex(input) {
	const match = String(input?.name || "").match(/^initial_value(\d+)$/);
	if (!match) return Number.MAX_SAFE_INTEGER;
	const index = Number.parseInt(match[1], 10);
	return index >= 1 ? index : Number.MAX_SAFE_INTEGER;
}

function dynamicOutputIndex(node, output, slotIndex) {
	const offset = isStart(node) ? 2 : 0;
	const index = slotIndex - offset + 1;
	if (index >= 1 && index <= MAX_VALUES) return index;
	const match = String(output?.name || output?.label || "").match(/(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function sortedDynamicInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => dynamicInputIndex(input) !== Number.MAX_SAFE_INTEGER)
			.sort((a, b) => dynamicInputIndex(a) - dynamicInputIndex(b))
		: [];
}

function sortedDynamicOutputs(node) {
	if (!Array.isArray(node?.outputs)) return [];
	const offset = isStart(node) ? 2 : 0;
	return node.outputs
		.map((output, slotIndex) => ({ output, slotIndex, index: dynamicOutputIndex(node, output, slotIndex) }))
		.filter((item) => item.slotIndex >= offset && item.index !== Number.MAX_SAFE_INTEGER)
		.sort((a, b) => a.index - b.index);
}

function linkById(id) {
	return id != null ? app.graph?.links?.[id] : null;
}

function isLiveLink(id) {
	return id != null && !!linkById(id);
}

function sanitizeStaleLinks(node) {
	if (!node) return false;
	let changed = false;
	if (Array.isArray(node.inputs)) {
		node.inputs.forEach((input, slot) => {
			if (input?.link != null && !isLiveLink(input.link)) {
				try {
					node.disconnectInput?.(slot);
				} catch (_) {}
				input.link = null;
				changed = true;
			}
		});
	}
	if (Array.isArray(node.outputs)) {
		node.outputs.forEach((output) => {
			if (!Array.isArray(output?.links)) return;
			const liveLinks = output.links.filter((id) => isLiveLink(id));
			if (liveLinks.length !== output.links.length) {
				output.links = liveLinks;
				changed = true;
			}
		});
	}
	return changed;
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
	const link = linkById(input?.link);
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

function preferredValueInfo(node, index, input, output) {
	const source = linkedSourceInfo(input);
	const target = linkedTargetInfo(output);
	const type = source?.type || target?.type || input?.type || output?.type || "*";
	const label = source?.label || target?.label || cleanLabel(type) || `${OUTPUT_PREFIX}${index}`;
	return {
		type,
		inputLabel: source?.label || target?.label || `初始值 ${index}`,
		outputLabel: target?.label || source?.label || `${OUTPUT_PREFIX}${index}`,
	};
}

function highestUsedIndex(node) {
	let highest = 0;
	for (const input of sortedDynamicInputs(node)) {
		if (isLiveLink(input?.link)) highest = Math.max(highest, dynamicInputIndex(input));
	}
	for (const item of sortedDynamicOutputs(node)) {
		if (Array.isArray(item.output?.links) && item.output.links.some((id) => isLiveLink(id))) {
			highest = Math.max(highest, item.index);
		}
	}
	return highest;
}

function removeInputByName(node, name) {
	const slot = node.inputs?.findIndex((input) => input?.name === name) ?? -1;
	if (slot >= 0) {
		if (node.disconnectInput) node.disconnectInput(slot);
		node.removeInput?.(slot);
	}
}

function ensureInput(node, index) {
	const name = `${INPUT_PREFIX}${index}`;
	let input = node.inputs?.find((item) => item?.name === name);
	if (!input) {
		node.addInput?.(name, "*");
		input = node.inputs?.[node.inputs.length - 1];
	}
	return input;
}

function ensureOutput(node, index) {
	const offset = isStart(node) ? 2 : 0;
	const slotIndex = offset + index - 1;
	while ((node.outputs?.length || 0) <= slotIndex) {
		const nextIndex = (node.outputs?.length || 0) - offset + 1;
		node.addOutput?.(`${OUTPUT_PREFIX}${nextIndex}`, "*");
	}
	return node.outputs?.[slotIndex];
}

function removeExtraOutputs(node, visibleCount) {
	const offset = isStart(node) ? 2 : 0;
	const keep = offset + visibleCount;
	while ((node.outputs?.length || 0) > keep) {
		node.removeOutput?.(node.outputs.length - 1);
	}
}

function orderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const fixed = node.inputs.filter((input) => dynamicInputIndex(input) === Number.MAX_SAFE_INTEGER);
	const dynamic = sortedDynamicInputs(node);
	node.inputs.splice(0, node.inputs.length, ...fixed, ...dynamic);
}

function applyFixedOutputMeta(node) {
	if (!isStart(node)) return;
	if (!Array.isArray(node.outputs)) node.outputs = [];
	if (!node.outputs[0]) node.addOutput?.("循环控制", "FLOW_CONTROL");
	if (!node.outputs[1]) node.addOutput?.("当前序号", "INT");
	const flow = node.outputs[0];
	const index = node.outputs[1];
	if (flow) {
		flow.name = "循环控制";
		flow.label = "循环控制";
		flow.localized_name = "循环控制";
		flow.type = "FLOW_CONTROL";
		flow.tooltip = "连接到 GJJ_ForLoopEnd 的循环控制口。";
	}
	if (index) {
		index.name = "当前序号";
		index.label = "当前序号";
		index.localized_name = "当前序号";
		index.type = "INT";
		index.tooltip = "当前循环序号，从 0 开始。";
	}
}

function stabilizeSlots(node) {
	if (!node) return;
	sanitizeStaleLinks(node);
	applyFixedOutputMeta(node);
	const visibleCount = Math.max(1, Math.min(MAX_VALUES, highestUsedIndex(node) + 1));

	for (let index = 1; index <= MAX_VALUES; index += 1) {
		if (index <= visibleCount) ensureInput(node, index);
		else removeInputByName(node, `${INPUT_PREFIX}${index}`);
	}
	removeExtraOutputs(node, visibleCount);
	for (let index = 1; index <= visibleCount; index += 1) {
		ensureOutput(node, index);
	}

	orderInputs(node);
	for (let index = 1; index <= visibleCount; index += 1) {
		const input = node.inputs?.find((item) => item?.name === `${INPUT_PREFIX}${index}`);
		const output = ensureOutput(node, index);
		const info = preferredValueInfo(node, index, input, output);
		if (input) {
			input.type = info.type || "*";
			input.label = info.inputLabel;
			input.localized_name = info.inputLabel;
			input.tooltip = `第 ${index} 路循环输入。连接后会自动显示下一路，并优先沿用上游或下游标签。`;
		}
		if (output) {
			output.type = info.type || "*";
			output.name = `${OUTPUT_PREFIX}${index}`;
			output.label = info.outputLabel;
			output.localized_name = info.outputLabel;
			output.tooltip = `第 ${index} 路循环输出。连接后会自动显示下一路，并优先沿用连接目标标签。`;
		}
	}

	refreshStatus(node);
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjForLoopStabilizeTimer);
	node.__gjjForLoopStabilizeTimer = setTimeout(() => stabilizeSlots(node), ms);
}

function stabilizeAllForLoopNodes() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(node?.comfyClass)) {
			stabilizeSlots(node);
		}
	}
}

function installGraphToPromptGuard() {
	if (app.__gjjForLoopGraphToPromptGuard) return;
	if (typeof app.graphToPrompt !== "function") {
		const retries = Number(app.__gjjForLoopGraphToPromptGuardRetries || 0);
		if (retries < 30) {
			app.__gjjForLoopGraphToPromptGuardRetries = retries + 1;
			setTimeout(installGraphToPromptGuard, 500);
		}
		return;
	}
	app.__gjjForLoopGraphToPromptGuard = true;
	const original = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		stabilizeAllForLoopNodes();
		return original(...args);
	};
}

function totalFromNode(node) {
	const widget = node?.widgets?.find((item) => item?.name === "total");
	const value = Number.parseInt(widget?.value, 10);
	return Number.isFinite(value) && value > 0 ? value : 1;
}

function panelHeight(root) {
	return Math.max(52, Math.ceil(root?.scrollHeight || root?.offsetHeight || 52));
}

function refreshStatus(node, message = null) {
	const state = node?.__gjjForLoopStatus;
	if (!state) return;
	const total = totalFromNode(node);
	const dynamicCount = Math.max(1, sortedDynamicInputs(node).length);
	const text = message || node.properties?.gjj_for_loop_status || "等待执行";
	state.title.textContent = isStart(node) ? `For循环开始 · 共 ${total} 轮` : "For循环结束";
	state.body.textContent = text;
	state.meta.textContent = `当前显示 ${dynamicCount} 路值`;
}

function ensureStatusPanel(node) {
	if (!node || node.__gjjForLoopStatus || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div");
	root.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"padding:7px 9px",
		"border:1px solid #3f5057",
		"border-radius:7px",
		"background:#10171b",
		"color:#d8e3e7",
		"font-size:12px",
		"line-height:1.35",
		"display:flex",
		"flex-direction:column",
		"gap:3px",
	].join(";");

	const title = document.createElement("div");
	title.style.cssText = "font-weight:700;color:#e8f2f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	const body = document.createElement("div");
	body.style.cssText = "color:#9fc7d4;white-space:pre-wrap;";
	const meta = document.createElement("div");
	meta.style.cssText = "color:#7f9299;font-size:11px;";
	root.append(title, body, meta);

	const widget = node.addDOMWidget(STATUS_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => panelHeight(root),
	});
	widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 320)), panelHeight(root)];
	node.__gjjForLoopStatus = { root, title, body, meta, widget };
	refreshStatus(node);
}

function setupWidgetCallbacks(node) {
	const total = node?.widgets?.find((item) => item?.name === "total");
	if (total && !total.__gjjForLoopPatched) {
		total.__gjjForLoopPatched = true;
		const original = total.callback;
		total.callback = function (...args) {
			const result = original?.apply(this, args);
			refreshStatus(node);
			return result;
		};
	}
}

app.registerExtension({
	name: "Comfy.GJJ.ForLoop",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			ensureStatusPanel(this);
			setupWidgetCallbacks(this);
			setTimeout(() => stabilizeSlots(this), 0);
			setTimeout(() => stabilizeSlots(this), 120);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			ensureStatusPanel(this);
			setupWidgetCallbacks(this);
			setTimeout(() => stabilizeSlots(this), 0);
			setTimeout(() => stabilizeSlots(this), 120);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalExecuted?.apply(this, [message, ...args]);
			ensureStatusPanel(this);
			refreshStatus(this);
			return result;
		};
	},

	setup() {
		installGraphToPromptGuard();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				ensureStatusPanel(node);
				setupWidgetCallbacks(node);
				stabilizeSlots(node);
			}
		}
	},
});

api.addEventListener("gjj_for_loop_status", (event) => {
	const detail = event?.detail || {};
	const node = app.graph?.getNodeById?.(Number(detail.node)) || app.graph?.getNodeById?.(detail.node);
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	const text = String(detail.text || "循环状态已更新");
	node.properties ||= {};
	node.properties.gjj_for_loop_status = text;
	ensureStatusPanel(node);
	refreshStatus(node, text);
	GJJ_Utils.refreshNode(node);
});

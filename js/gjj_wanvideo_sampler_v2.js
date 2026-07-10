import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_WanVideoSamplerV2"]);
const FIXED_INPUT_SPECS = [
	["model", "WANVIDEOMODEL", null, "WanVideo 模型"],
	["image_embeds", "WANVIDIMAGE_EMBEDS", null, "图像条件"],
	["text_embeds", "WANVIDEOTEXTEMBEDS", null, "文本条件"],
	["samples", "LATENT", null, "初始 latent"],
	["feta_args", "FETAARGS", null, "FETA 参数"],
	["context_options", "WANVIDCONTEXT", null, "上下文窗口"],
	["cache_args", "CACHEARGS", null, "缓存参数"],
	["flowedit_args", "FLOWEDITARGS", null, "FlowEdit 参数"],
	["slg_args", "SLGARGS", null, "SLG 参数"],
	["loop_args", "LOOPARGS", null, "循环参数"],
	["experimental_args", "EXPERIMENTALARGS", null, "实验参数"],
	["sigmas", "SIGMAS", null, "Sigmas"],
	["unianimate_poses", "UNIANIMATE_POSE", null, "UniAnimate 姿态"],
	["fantasytalking_embeds", "FANTASYTALKING_EMBEDS", null, "FantasyTalking 条件"],
	["uni3c_embeds", "UNI3C_EMBEDS", null, "Uni3C 条件"],
	["multitalk_embeds", "MULTITALK_EMBEDS", null, "MultiTalk 条件"],
	["freeinit_args", "FREEINITARGS", null, "FreeInit 参数"],
	["steps", "INT", "steps", "采样步数"],
	["cfg", "FLOAT", "cfg", "CFG"],
	["shift", "FLOAT", "shift", "Shift"],
	["seed", "INT", "seed", "种子"],
	["force_offload", "BOOLEAN", "force_offload", "采样后卸载"],
	["scheduler", "COMBO", "scheduler", "调度器"],
	["riflex_freq_index", "INT", "riflex_freq_index", "RIFLEX 频率索引"],
	["denoise_strength", "FLOAT", "denoise_strength", "降噪强度"],
	["batched_cfg", "BOOLEAN", "batched_cfg", "批量 CFG"],
	["rope_function", "COMBO", "rope_function", "RoPE 函数"],
	["start_step", "INT", "start_step", "起始步"],
	["end_step", "INT", "end_step", "结束步"],
	["add_noise_to_samples", "BOOLEAN", "add_noise_to_samples", "给 latent 加噪"],
	["teacache_args", "CACHEARGS", null, "TeaCache 兼容参数"],
	["scheduler_config", "WANVIDEOSCHEDULER", null, "调度器配置"],
	["extra_args", "WANVIDSAMPLEREXTRAARGS", null, "扩展参数"],
];

const FIXED_BY_NAME = new Map(FIXED_INPUT_SPECS.map((spec) => [spec[0], spec]));
const FIXED_BY_WIDGET = new Map(FIXED_INPUT_SPECS.filter((spec) => spec[2]).map((spec) => [spec[2], spec]));
const FIXED_BY_LABEL = new Map(FIXED_INPUT_SPECS.map((spec) => [spec[3], spec]));
const FIXED_INDEX_BY_NAME = new Map(FIXED_INPUT_SPECS.map((spec, index) => [spec[0], index]));
const GRAPH_PROMPT_PATCH_FLAG = "__gjjWanVideoSamplerV2GraphToPromptPatched";

function getFixedSpec(input) {
	const widgetName = String(input?.widget?.name || "");
	if (FIXED_BY_WIDGET.has(widgetName)) return FIXED_BY_WIDGET.get(widgetName);
	const name = String(input?.name || "");
	if (FIXED_BY_NAME.has(name)) return FIXED_BY_NAME.get(name);
	const dynamicMatch = name.match(/^wan_args_\d+__(.+)$/);
	if (dynamicMatch && FIXED_BY_NAME.has(dynamicMatch[1])) return FIXED_BY_NAME.get(dynamicMatch[1]);
	const label = String(input?.localized_name || input?.label || "");
	return FIXED_BY_LABEL.get(label) || null;
}

function applyFixedSpec(input, spec) {
	if (!input || !spec) return false;
	const [name, type, widgetName, label] = spec;
	let changed = false;
	if (input.name !== name) {
		input.name = name;
		changed = true;
	}
	if (input.type !== type) {
		input.type = type;
		changed = true;
	}
	input.label = label;
	input.localized_name = label;
	if (widgetName) input.widget = { name: widgetName };
	else delete input.widget;
	return changed;
}

function sanitizeInputs(owner) {
	if (!Array.isArray(owner?.inputs)) return false;
	let changed = false;
	for (const input of owner.inputs) {
		const spec = getFixedSpec(input);
		if (spec && applyFixedSpec(input, spec)) changed = true;
	}
	return changed;
}

function reorderFixedInputs(owner) {
	if (!Array.isArray(owner?.inputs)) return false;
	const original = owner.inputs;
	const recognized = [];
	const rest = [];
	for (const input of original) {
		const order = FIXED_INDEX_BY_NAME.get(String(input?.name || ""));
		if (order === undefined) rest.push(input);
		else recognized.push({ input, order });
	}
	recognized.sort((a, b) => a.order - b.order);
	const ordered = [...recognized.map((item) => item.input), ...rest];
	const changed = ordered.some((input, index) => input !== original[index]);
	if (changed) {
		owner.inputs.splice(0, owner.inputs.length, ...ordered);
	}
	return changed;
}

function syncGraphTargetSlots(node) {
	if (!Array.isArray(node?.inputs)) return;
	const nodeId = String(node.id);
	let changed = false;
	for (const [slot, input] of node.inputs.entries()) {
		const linkId = input?.link;
		const link = linkId != null ? app.graph?.links?.[linkId] : null;
		if (Array.isArray(link)) {
			if (String(link[3]) === nodeId && link[4] !== slot) {
				link[4] = slot;
				changed = true;
			}
		} else if (link && String(link.target_id) === nodeId && link.target_slot !== slot) {
			link.target_slot = slot;
			changed = true;
		}
	}
	if (changed) node.graph?.setDirtyCanvas?.(true, true);
}

function stabilizeNodeInputs(node) {
	node.properties = node.properties || {};
	node.properties["Node name for S&R"] = "WanVideoSampler";
	const renamed = sanitizeInputs(node);
	const reordered = reorderFixedInputs(node);
	syncGraphTargetSlots(node);
	if (renamed || reordered) node.setDirtyCanvas?.(true, true);
	return renamed || reordered;
}

function isTargetNode(node) {
	return TARGET_NODES.has(node?.comfyClass || node?.type);
}

function stabilizeAllNodes() {
	for (const node of app.graph?._nodes || []) {
		if (isTargetNode(node)) stabilizeNodeInputs(node);
	}
}

function patchGraphToPrompt() {
	if (app[GRAPH_PROMPT_PATCH_FLAG] || typeof app.graphToPrompt !== "function") return;
	app[GRAPH_PROMPT_PATCH_FLAG] = true;
	const originalGraphToPrompt = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		stabilizeAllNodes();
		return originalGraphToPrompt(...args);
	};
}

app.registerExtension({
	name: "Comfy.GJJ.WanVideoSamplerV2FixedInputs",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			sanitizeInputs(serializedNode);
			reorderFixedInputs(serializedNode);
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			setTimeout(() => stabilizeNodeInputs(this), 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			stabilizeNodeInputs(this);
			originalOnSerialize?.apply(this, [serializedNode]);
			sanitizeInputs(serializedNode);
			reorderFixedInputs(serializedNode);
		};
	},

	nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) return;
		stabilizeNodeInputs(node);
	},

	setup() {
		patchGraphToPrompt();
		stabilizeAllNodes();
		setTimeout(stabilizeAllNodes, 500);
	},
});

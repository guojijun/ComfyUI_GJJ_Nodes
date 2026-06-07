import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_WanVideoSamplerV2"]);
const FIXED_INPUT_SPECS = [
	["model", "WANVIDEOMODEL", null, "WanVideo 模型"],
	["image_embeds", "WANVIDIMAGE_EMBEDS", null, "图像条件"],
	["steps", "INT", "steps", "采样步数"],
	["cfg", "FLOAT", "cfg", "CFG"],
	["shift", "FLOAT", "shift", "Shift"],
	["force_offload", "BOOLEAN", "force_offload", "采样后卸载"],
	["scheduler", "COMBO", "scheduler", "调度器"],
	["riflex_freq_index", "INT", "riflex_freq_index", "RIFLEX 频率索引"],
	["text_embeds", "WANVIDEOTEXTEMBEDS", null, "文本条件"],
	["samples", "LATENT", null, "初始 latent"],
	["denoise_strength", "FLOAT", "denoise_strength", "降噪强度"],
	["feta_args", "FETAARGS", null, "FETA 参数"],
	["context_options", "WANVIDCONTEXT", null, "上下文窗口"],
	["cache_args", "CACHEARGS", null, "缓存参数"],
	["teacache_args", "CACHEARGS", null, "TeaCache 兼容参数"],
	["flowedit_args", "FLOWEDITARGS", null, "FlowEdit 参数"],
	["batched_cfg", "BOOLEAN", "batched_cfg", "批量 CFG"],
	["slg_args", "SLGARGS", null, "SLG 参数"],
	["rope_function", "COMBO", "rope_function", "RoPE 函数"],
	["loop_args", "LOOPARGS", null, "循环参数"],
	["experimental_args", "EXPERIMENTALARGS", null, "实验参数"],
	["sigmas", "SIGMAS", null, "Sigmas"],
	["unianimate_poses", "UNIANIMATE_POSE", null, "UniAnimate 姿态"],
	["fantasytalking_embeds", "FANTASYTALKING_EMBEDS", null, "FantasyTalking 条件"],
	["uni3c_embeds", "UNI3C_EMBEDS", null, "Uni3C 条件"],
	["multitalk_embeds", "MULTITALK_EMBEDS", null, "MultiTalk 条件"],
	["freeinit_args", "FREEINITARGS", null, "FreeInit 参数"],
	["start_step", "INT", "start_step", "起始步"],
	["end_step", "INT", "end_step", "结束步"],
	["add_noise_to_samples", "BOOLEAN", "add_noise_to_samples", "给 latent 加噪"],
	["extra_args", "WANVIDSAMPLEREXTRAARGS", null, "扩展参数"],
	["seed", "INT", "seed", "种子"],
];

const FIXED_BY_NAME = new Map(FIXED_INPUT_SPECS.map((spec) => [spec[0], spec]));
const FIXED_BY_WIDGET = new Map(FIXED_INPUT_SPECS.filter((spec) => spec[2]).map((spec) => [spec[2], spec]));
const FIXED_BY_LABEL = new Map(FIXED_INPUT_SPECS.map((spec) => [spec[3], spec]));

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

app.registerExtension({
	name: "Comfy.GJJ.WanVideoSamplerV2FixedInputs",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			sanitizeInputs(serializedNode);
			return originalOnConfigure?.apply(this, [serializedNode, ...args]);
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			originalOnSerialize?.apply(this, [serializedNode]);
			sanitizeInputs(serializedNode);
		};
	},

	nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) return;
		if (sanitizeInputs(node)) node.setDirtyCanvas?.(true, true);
	},
});

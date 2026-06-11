import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set([
	"GJJ_WanSCAILToVideo",
]);

const INPUT_SPECS = [
	["positive", "CONDITIONING", null, "正向条件", "来自 Wan 文本编码器的正向条件。"],
	["negative", "CONDITIONING", null, "负向条件", "来自 Wan 文本编码器的负向条件。"],
	["vae", "VAE", null, "VAE", "用于编码参考图、姿态视频和上一段帧。"],
	["width", "INT", "width", "宽度", "目标视频宽度；连接外部 INT 时覆盖面板数值。"],
	["height", "INT", "height", "高度", "目标视频高度；连接外部 INT 时覆盖面板数值。"],
	["length", "INT", "length", "帧数", "目标生成帧数；推荐 4n+1，例如 81。"],
	["batch_size", "INT", "batch_size", "批次数", "输出 latent 的批次数。"],
	["pose_video", "IMAGE", null, "姿态视频帧", "可选。用于姿态控制的视频帧队列。"],
	["pose_video_mask", "IMAGE", null, "姿态彩色遮罩", "SCAIL-2 可选。与姿态视频同步的彩色身份遮罩帧队列。"],
	["replacement_mode", "BOOLEAN", "replacement_mode", "替换模式", "SCAIL-2 可选。关闭为动画模式，开启为替换模式。"],
	["pose_strength", "FLOAT", "pose_strength", "姿态强度", "姿态 latent 的强度倍率。"],
	["pose_start", "FLOAT", "pose_start", "姿态开始比例", "姿态条件开始生效的采样比例。"],
	["pose_end", "FLOAT", "pose_end", "姿态结束比例", "姿态条件结束生效的采样比例。"],
	["reference_image", "IMAGE", null, "参考图", "可选参考图。多参考请在上游合成到单张图。"],
	["reference_image_mask", "IMAGE", null, "参考图彩色遮罩", "SCAIL-2 可选。参考图对应的彩色身份遮罩。"],
	["clip_vision_output", "CLIP_VISION_OUTPUT", null, "CLIP视觉条件", "可选。连接 CLIP Vision 输出后会写入正负条件。"],
	["video_frame_offset", "INT", "video_frame_offset", "视频帧偏移", "当前分段从完整控制视频的第几帧开始。"],
	["previous_frame_count", "INT", "previous_frame_count", "上一段锚定帧数", "续段时从上一段视频末尾取多少帧作为锚定。"],
	["previous_frames", "IMAGE", null, "上一段视频帧", "SCAIL-2 续段可选。上一段完整解码帧队列。"],
];

const SPEC_BY_NAME = new Map(INPUT_SPECS.map((spec, index) => [spec[0], { spec, index }]));
const SPEC_BY_WIDGET = new Map(INPUT_SPECS.filter((spec) => spec[2]).map((spec, index) => [spec[2], { spec, index }]));
const SPEC_BY_LABEL = new Map(INPUT_SPECS.map((spec, index) => [spec[3], { spec, index }]));

function findWidget(node, name) {
	return Array.isArray(node?.widgets) ? node.widgets.find((widget) => String(widget?.name || "") === name) : null;
}

function inputSpecInfo(input) {
	const widgetName = String(input?.widget?.name || input?.widget_name || "");
	if (SPEC_BY_WIDGET.has(widgetName)) return SPEC_BY_WIDGET.get(widgetName);
	const name = String(input?.name || "").replace(/^converted-widget:/i, "");
	if (SPEC_BY_NAME.has(name)) return SPEC_BY_NAME.get(name);
	const type = String(input?.type || "").replace(/^converted-widget:/i, "");
	if (SPEC_BY_WIDGET.has(type)) return SPEC_BY_WIDGET.get(type);
	const label = String(input?.localized_name || input?.label || "");
	return SPEC_BY_LABEL.get(label) || null;
}

function findInput(node, name, widgetName = null) {
	if (!Array.isArray(node?.inputs)) return null;
	return node.inputs.find((input) => {
		const inputName = String(input?.name || "").replace(/^converted-widget:/i, "");
		const inputType = String(input?.type || "").replace(/^converted-widget:/i, "");
		const boundWidget = String(input?.widget?.name || input?.widget_name || "");
		return inputName === name || inputType === widgetName || boundWidget === widgetName;
	});
}

function applyInputSpec(input, spec) {
	if (!input || !spec) return;
	const [name, type, widgetName, label, tooltip] = spec;
	input.name = name;
	input.type = type;
	input.label = label;
	input.localized_name = label;
	input.display_name = label;
	input.tooltip = tooltip;
	input.hidden = false;
	input.visible = true;
	if (widgetName) {
		input.widget = { name: widgetName };
		input.forceInput = false;
	} else {
		delete input.widget;
		delete input.widget_name;
	}
}

function decorateWidget(node, spec) {
	const [name, , widgetName, label, tooltip] = spec;
	const widget = widgetName ? findWidget(node, widgetName) : null;
	if (!widget) return;
	widget.name = widgetName || name;
	widget.label = label;
	widget.localized_name = label;
	widget.tooltip = tooltip;
	widget.options ||= {};
	widget.options.display_name = label;
	widget.options.tooltip = tooltip;
}

function ensureInput(node, spec) {
	const [name, type, widgetName] = spec;
	let input = findInput(node, name, widgetName);
	if (!input) {
		node.addInput?.(name, type);
		input = node.inputs?.[node.inputs.length - 1] || null;
	}
	applyInputSpec(input, spec);
	return input;
}

function compareInputs(a, b) {
	const ai = inputSpecInfo(a)?.index ?? Number.MAX_SAFE_INTEGER;
	const bi = inputSpecInfo(b)?.index ?? Number.MAX_SAFE_INTEGER;
	if (ai !== bi) return ai - bi;
	return 0;
}

function refreshNode(node) {
	requestAnimationFrame(() => {
		GJJ_Utils.refreshNode(node);
		app.canvas?.setDirty?.(true, true);
	});
}

function stabilizeNode(node) {
	if (!node || !Array.isArray(node.inputs)) return;
	for (const spec of INPUT_SPECS) {
		decorateWidget(node, spec);
		ensureInput(node, spec);
	}
	node.inputs.sort(compareInputs);
	refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjScailToVideoTimer);
	node.__gjjScailToVideoTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.WanSCAILToVideoLayout",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			scheduleStabilize(this, 120);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			scheduleStabilize(this, 0);
			scheduleStabilize(this, 120);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this, 16);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			scheduleStabilize(this, 16);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
	},
});

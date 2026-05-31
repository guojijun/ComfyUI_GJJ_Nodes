import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_WanVideoSamplerV2", "GJJ_WanVideoSamplerSettings"]);
const SCHEDULER_PREVIEW_NODE = "GJJ_WanVideoSchedulerV2";
const SCHEDULER_PREVIEW_WIDGET = "gjj_wanvideo_scheduler_sigmas_preview";
const SCHEDULER_PREVIEW_HEIGHT = 190;
const FIXED_INPUT_SPECS = [
	["model", "WANVIDEOMODEL", null, "WanVideo 模型"],
	["image_embeds", "WANVIDIMAGE_EMBEDS", null, "图像条件"],
	["steps", "INT", "steps", "采样步数"],
	["cfg", "FLOAT", "cfg", "CFG"],
	["shift", "FLOAT", "shift", "Shift"],
	["force_offload", "BOOLEAN", "force_offload", "采样后卸载"],
	["scheduler", "COMBO", "scheduler", "调度器"],
	["riflex_freq_index", "INT", "riflex_freq_index", "RIFLEX 频率索引"],
	["text_embeds", "WANVIDEOTEXTEMBEDS,CONDITIONING", null, "文本条件"],
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

function normalizeSigmas(value) {
	const raw = Array.isArray(value?.[0]) ? value[0] : value;
	if (!Array.isArray(raw)) return [];
	return raw.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function getExecutedSigmas(message, outputs) {
	const ui = message?.ui || message || {};
	return normalizeSigmas(ui?.sigmas?.[0] || ui?.sigmas || outputs?.[0]);
}

function ensureSchedulerPreview(node) {
	if (node.__gjjWanSchedulerPreview) return node.__gjjWanSchedulerPreview;
	if (typeof node.addDOMWidget !== "function") return null;

	const root = document.createElement("div");
	root.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		`height:${SCHEDULER_PREVIEW_HEIGHT}px`,
		"padding:6px 8px 8px 8px",
		"border:1px solid #34444c",
		"border-radius:8px",
		"background:#0f1519",
		"pointer-events:auto",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		root.addEventListener(eventName, (event) => event.stopPropagation(), { passive: eventName === "wheel" });
	}

	const canvas = document.createElement("canvas");
	canvas.style.cssText = "display:block;width:100%;height:100%;background:#141b1f;border-radius:5px;";
	root.appendChild(canvas);

	const widget = node.addDOMWidget(SCHEDULER_PREVIEW_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	if (!widget) return null;
	widget.computeSize = (width) => [Math.max(280, Number(width || node.size?.[0] || 300)), SCHEDULER_PREVIEW_HEIGHT + 10];
	widget.getHeight = () => SCHEDULER_PREVIEW_HEIGHT + 10;

	node.__gjjWanSchedulerPreview = { widget, root, canvas, sigmas: [] };
	return node.__gjjWanSchedulerPreview;
}

function drawSchedulerPreview(view, node) {
	const canvas = view?.canvas;
	const sigmas = normalizeSigmas(view?.sigmas);
	if (!canvas || sigmas.length < 2) return;
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	const width = Math.max(1, Math.floor(canvas.clientWidth || 1));
	const height = Math.max(1, Math.floor(canvas.clientHeight || 1));
	if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
	}
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "#141b1f";
	ctx.fillRect(0, 0, width, height);

	const pad = { left: 34, right: 12, top: 20, bottom: 24 };
	const area = {
		x: pad.left,
		y: pad.top,
		w: Math.max(1, width - pad.left - pad.right),
		h: Math.max(1, height - pad.top - pad.bottom),
	};
	const min = Math.min(0, ...sigmas);
	const max = Math.max(1, ...sigmas);
	const range = Math.max(1e-6, max - min);
	const xAt = (index) => area.x + (sigmas.length <= 1 ? 0 : (index / (sigmas.length - 1)) * area.w);
	const yAt = (value) => area.y + (1 - ((value - min) / range)) * area.h;

	ctx.strokeStyle = "#2a3a42";
	ctx.lineWidth = 1;
	ctx.fillStyle = "#6f8089";
	ctx.font = "10px system-ui, sans-serif";
	ctx.textAlign = "right";
	ctx.textBaseline = "middle";
	for (let i = 0; i <= 4; i += 1) {
		const t = i / 4;
		const y = area.y + t * area.h;
		const value = max - t * range;
		ctx.beginPath();
		ctx.moveTo(area.x, y);
		ctx.lineTo(area.x + area.w, y);
		ctx.stroke();
		ctx.fillText(value.toFixed(value >= 10 ? 0 : 2), area.x - 6, y);
	}

	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	const stepLabels = Math.min(6, sigmas.length);
	for (let i = 0; i < stepLabels; i += 1) {
		const index = Math.round((i / Math.max(1, stepLabels - 1)) * (sigmas.length - 1));
		const x = xAt(index);
		ctx.beginPath();
		ctx.moveTo(x, area.y);
		ctx.lineTo(x, area.y + area.h);
		ctx.stroke();
		ctx.fillText(String(index), x, area.y + area.h + 6);
	}

	const startStep = Number(node?.widgets?.find((widget) => widget.name === "start_step")?.value || 0);
	const endStep = Number(node?.widgets?.find((widget) => widget.name === "end_step")?.value || -1);
	const markStep = (step, color) => {
		if (!Number.isFinite(step) || step < 0 || step >= sigmas.length) return;
		const x = xAt(Math.round(step));
		ctx.save();
		ctx.strokeStyle = color;
		ctx.setLineDash([5, 4]);
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(x, area.y);
		ctx.lineTo(x, area.y + area.h);
		ctx.stroke();
		ctx.restore();
	};
	markStep(startStep, "#7bd88f");
	markStep(endStep >= 0 ? endStep : -1, "#ff6b6b");

	ctx.save();
	ctx.strokeStyle = "#68c5ff";
	ctx.lineWidth = 2;
	ctx.beginPath();
	sigmas.forEach((value, index) => {
		const x = xAt(index);
		const y = yAt(value);
		if (index === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	});
	ctx.stroke();
	ctx.fillStyle = "#dff6ff";
	sigmas.forEach((value, index) => {
		const x = xAt(index);
		const y = yAt(value);
		ctx.beginPath();
		ctx.arc(x, y, 2.2, 0, Math.PI * 2);
		ctx.fill();
	});
	ctx.restore();

	ctx.fillStyle = "#dce7e2";
	ctx.font = "11px system-ui, sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	ctx.fillText("Sigmas", area.x + area.w * 0.5, 4);
	ctx.fillStyle = "#9fb0b7";
	ctx.textAlign = "left";
	ctx.fillText(`${sigmas.length} 点`, area.x, 4);
	ctx.textAlign = "right";
	ctx.fillText(sigmas[sigmas.length - 1].toFixed(3), area.x + area.w, area.y + area.h - 14);
}

function updateSchedulerPreview(node, sigmas) {
	const clean = normalizeSigmas(sigmas);
	if (!node || clean.length < 2) return;
	const view = ensureSchedulerPreview(node);
	if (!view) return;
	view.sigmas = clean;
	drawSchedulerPreview(view, node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
	name: "Comfy.GJJ.WanVideoSamplerV2FixedInputs",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (TARGET_NODES.has(nodeData?.name)) {
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
		}

		if (nodeData?.name === SCHEDULER_PREVIEW_NODE) {
			const originalOnExecuted = nodeType.prototype.onExecuted;
			nodeType.prototype.onExecuted = function (message, outputs) {
				const result = originalOnExecuted?.apply(this, [message, outputs]);
				updateSchedulerPreview(this, getExecutedSigmas(message, outputs));
				return result;
			};

			const originalOnResize = nodeType.prototype.onResize;
			nodeType.prototype.onResize = function (...args) {
				const result = originalOnResize?.apply(this, args);
				if (this.__gjjWanSchedulerPreview) drawSchedulerPreview(this.__gjjWanSchedulerPreview, this);
				return result;
			};
		}
	},

	nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) return;
		if (sanitizeInputs(node)) node.setDirtyCanvas?.(true, true);
	},
});

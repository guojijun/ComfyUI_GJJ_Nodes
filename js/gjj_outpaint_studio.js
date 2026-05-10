import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_OutpaintStudio";
const API_PATH = "/gjj/outpaint_models";
const DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d";

const OUTPAINT_MODES = {
	sd15_inpaint: { icon: "🎨", name: "SD1.5", color: "#4CAF50" },
	flux1_fill: { icon: "🌀", name: "Flux1", color: "#2196F3" },
	flux2_klein: { icon: "✨", name: "Flux2", color: "#9C27B0" },
	qwen_image: { icon: "🌟", name: "Qwen", color: "#FF9800" },
};

const EXPAND_METHODS = {
	pixel_expand: { icon: "📏", name: "像素扩图" },
	target_size: { icon: "📐", name: "目标尺寸" },
};

const SAMPLERS = [
  { value: "euler", label: "Euler" },
  { value: "euler_ancestral", label: "Euler a" },
  { value: "heun", label: "Heun" },
  { value: "heunpp2", label: "HeunPP2" },
  { value: "dpm_2", label: "DPM2" },
  { value: "dpm_2_ancestral", label: "DPM2 a" },
  { value: "lms", label: "LMS" },
  { value: "dpm_fast", label: "DPM fast" },
  { value: "dpm_adaptive", label: "DPM adaptive" },
  { value: "dpmpp_2s_ancestral", label: "DPM++ 2S a" },
  { value: "dpmpp_sde", label: "DPM++ SDE" },
  { value: "dpmpp_sde_gpu", label: "DPM++ SDE (GPU)" },
  { value: "dpmpp_2m", label: "DPM++ 2M" },
  { value: "dpmpp_3m", label: "DPM++ 3M" },
  { value: "ddim", label: "DDIM" },
  { value: "plms", label: "PLMS" },
  { value: "uni_pc", label: "UniPC" },
  { value: "uni_pc_bh2", label: "UniPC BH2" }
];
const SCHEDULERS = [
  { value: "normal", label: "标准" },
  { value: "karras", label: "Karras" },
  { value: "exponential", label: "指数" },
  { value: "sgm_uniform", label: "SGM 均匀" },
  { value: "simple", label: "简单" },
  { value: "ddim_uniform", label: "DDIM 均匀" }
];
const UPSCALE_METHODS = [
  { value: "lanczos", label: "Lanczos" },
  { value: "bilinear", label: "双线性" },
  { value: "nearest", label: "最近邻" },
  { value: "bicubic", label: "双三次" }
];
const SCALE_MODES = [
  { value: "by_width", label: "按宽度缩放" },
  { value: "by_height", label: "按高度缩放" }
];
const DIRECTIONS = [
  { value: "all", label: "四边扩展" },
  { value: "left+right", label: "左右扩展" },
  { value: "top+bottom", label: "上下扩展" },
  { value: "left", label: "仅左侧" },
  { value: "right", label: "仅右侧" },
  { value: "top", label: "仅顶部" },
  { value: "bottom", label: "仅底部" }
];

function getDefaultConfig() {
	return {
		outpaint_mode: "sd15_inpaint",
		expand_method: "pixel_expand",
		pixel_left: 0,
		pixel_right: 128,
		pixel_top: 0,
		pixel_bottom: 128,
		target_width: 1024,
		target_height: 1024,
		target_scale_mode: "by_width",
		target_direction: "left+right",
		seed: 0,
		steps: 25,
		cfg: 7.0,
		guidance: 3.5,
		sampler_name: "euler",
		scheduler: "normal",
		upscale_method: "lanczos",
	};
}

function parseConfig(node) {
	const configWidget = node.widgets?.find(w => w.name === "outpaint_config");
	if (!configWidget) return getDefaultConfig();

	try {
		const saved = JSON.parse(configWidget.value || "{}");
		return { ...getDefaultConfig(), ...saved };
	} catch {
		return getDefaultConfig();
	}
}

function saveConfig(node, config) {
	const configWidget = node.widgets?.find(w => w.name === "outpaint_config");
	if (!configWidget) return;

	const json = JSON.stringify(config, null, 2);
	configWidget.value = json;
	configWidget.callback?.(json);

	const idx = node.widgets?.indexOf(configWidget);
	if (idx >= 0) {
		node.widgets_values = node.widgets_values || [];
		node.widgets_values[idx] = json;
	}

	node.properties = node.properties || {};
	node.properties.outpaint_config = json;
}

function hideConfigWidget(node) {
	const configWidget = node.widgets?.find(w => w.name === "outpaint_config");
	if (!configWidget) return;

	configWidget.hidden = true;
	configWidget.type = "hidden";
	configWidget.computeSize = () => [0, 0];
	configWidget.draw = () => {};
	configWidget.label = "";

	if (configWidget.element) {
		configWidget.element.style.display = "none";
		configWidget.element.style.visibility = "hidden";
	}
	if (configWidget.inputEl) {
		configWidget.inputEl.style.display = "none";
	}
}

function protectEvent(event) {
	const target = event.target;

	if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") {
		return;
	}

	if (target.closest("input") || target.closest("select") || target.closest("textarea")) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();
}

function createModeButtons(node, config, onChange) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"padding:8px",
		"background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
		"border-radius:6px",
		"margin:6px",
		"border:1px solid #333",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const label = document.createElement("div");
	label.textContent = "🔧 扩图模式";
	label.style.cssText = "font-size:11px;font-weight:bold;color:#e0e0e0;margin-bottom:2px;";
	container.appendChild(label);

	const buttons = document.createElement("div");
	buttons.style.cssText = "display:grid;grid-template-columns:repeat(2,1fr);gap:4px;";

	Object.entries(OUTPAINT_MODES).forEach(([modeId, info]) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = `${info.icon} ${info.name}`;
		btn.dataset.mode = modeId;
		btn.style.cssText = [
			"padding:6px 8px",
			"font-size:10px",
			"font-weight:bold",
			"border:2px solid " + (config.outpaint_mode === modeId ? info.color : "#333"),
			"background:" + (config.outpaint_mode === modeId ? info.color : "#2a2a4a"),
			"color:" + (config.outpaint_mode === modeId ? "#fff" : "#aaa"),
			"border-radius:4px",
			"cursor:pointer",
			"transition:all 0.15s ease",
			"flex:1",
			"box-sizing:border-box",
			"position:relative",
			"z-index:1001",
			"pointer-events:auto",
			"user-select:none",
		].join(";");

		function handleClick(event) {
			protectEvent(event);
			onChange({ ...config, outpaint_mode: modeId });
		}

		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			btn.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}
		btn.addEventListener("pointerup", handleClick, true);
		btn.addEventListener("click", handleClick, true);

		buttons.appendChild(btn);
	});

	container.appendChild(buttons);
	return container;
}

function createMethodButtons(node, config, onChange) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"padding:8px",
		"background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
		"border-radius:6px",
		"margin:6px",
		"border:1px solid #333",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const label = document.createElement("div");
	label.textContent = "📐 扩图方式";
	label.style.cssText = "font-size:11px;font-weight:bold;color:#e0e0e0;margin-bottom:2px;";
	container.appendChild(label);

	const buttons = document.createElement("div");
	buttons.style.cssText = "display:grid;grid-template-columns:repeat(2,1fr);gap:4px;";

	Object.entries(EXPAND_METHODS).forEach(([methodId, info]) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = `${info.icon} ${info.name}`;
		btn.dataset.method = methodId;
		const color = methodId === "pixel_expand" ? "#E91E63" : "#00BCD4";
		btn.style.cssText = [
			"padding:6px 8px",
			"font-size:10px",
			"font-weight:bold",
			"border:2px solid " + (config.expand_method === methodId ? color : "#333"),
			"background:" + (config.expand_method === methodId ? color : "#2a2a4a"),
			"color:" + (config.expand_method === methodId ? "#fff" : "#aaa"),
			"border-radius:4px",
			"cursor:pointer",
			"transition:all 0.15s ease",
			"flex:1",
			"box-sizing:border-box",
			"position:relative",
			"z-index:1001",
			"pointer-events:auto",
			"user-select:none",
		].join(";");

		function handleClick(event) {
			protectEvent(event);
			onChange({ ...config, expand_method: methodId });
		}

		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			btn.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}
		btn.addEventListener("pointerup", handleClick, true);
		btn.addEventListener("click", handleClick, true);

		buttons.appendChild(btn);
	});

	container.appendChild(buttons);
	return container;
}

function createPixelExpandPanel(node, config, onChange) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const rows = [
		{ key: "pixel_left", label: "⬅️ 左扩", value: config.pixel_left },
		{ key: "pixel_right", label: "➡️ 右扩", value: config.pixel_right },
		{ key: "pixel_top", label: "⬆️ 上扩", value: config.pixel_top },
		{ key: "pixel_bottom", label: "⬇️ 下扩", value: config.pixel_bottom },
	];

	rows.forEach(row => {
		const rowEl = document.createElement("div");
		rowEl.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0;";

		const label = document.createElement("span");
		label.textContent = row.label;
		label.style.cssText = "font-size:10px;color:#aaa;min-width:45px;";

		const input = document.createElement("input");
		input.type = "number";
		input.min = "0";
		input.max = "2048";
		input.step = "8";
		input.value = row.value;
		input.style.cssText = [
			"flex:1",
			"padding:3px 6px",
			"font-size:10px",
			"background:#2a2a4a",
			"border:1px solid #444",
			"border-radius:4px",
			"color:#fff",
			"text-align:center",
			"pointer-events:auto",
			"position:relative",
			"z-index:1001",
		].join(";");

		input.oninput = () => {
			const newConfig = { ...config };
			newConfig[row.key] = parseInt(input.value) || 0;
			onChange(newConfig);
		};

		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			input.addEventListener(eventName, protectEvent, true);
			rowEl.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}

		rowEl.appendChild(label);
		rowEl.appendChild(input);
		container.appendChild(rowEl);
	});

	return container;
}

function createTargetSizePanel(node, config, onChange) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const sizeRow = document.createElement("div");
	sizeRow.style.cssText = "display:flex;gap:6px;margin:2px 0;";

	const wInput = document.createElement("input");
	wInput.type = "number";
	wInput.min = "64";
	wInput.max = "4096";
	wInput.step = "8";
	wInput.value = config.target_width;
	wInput.style.cssText = [
		"flex:1",
		"padding:3px 6px",
		"font-size:10px",
		"background:#2a2a4a",
		"border:1px solid #444",
		"border-radius:4px",
		"color:#fff",
		"text-align:center",
		"pointer-events:auto",
		"position:relative",
		"z-index:1001",
	].join(";");
	wInput.oninput = () => onChange({ ...config, target_width: parseInt(wInput.value) || 64 });

	const hInput = document.createElement("input");
	hInput.type = "number";
	hInput.min = "64";
	hInput.max = "4096";
	hInput.step = "8";
	hInput.value = config.target_height;
	hInput.style.cssText = [
		"flex:1",
		"padding:3px 6px",
		"font-size:10px",
		"background:#2a2a4a",
		"border:1px solid #444",
		"border-radius:4px",
		"color:#fff",
		"text-align:center",
		"pointer-events:auto",
		"position:relative",
		"z-index:1001",
	].join(";");
	hInput.oninput = () => onChange({ ...config, target_height: parseInt(hInput.value) || 64 });

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		wInput.addEventListener(eventName, protectEvent, true);
		hInput.addEventListener(eventName, protectEvent, true);
		sizeRow.addEventListener(eventName, protectEvent, true);
		container.addEventListener(eventName, protectEvent, true);
	}

	sizeRow.appendChild(wInput);
	sizeRow.appendChild(hInput);
	container.appendChild(sizeRow);

	const scaleSelect = createSelect(node, "🔄 缩放", SCALE_MODES, config.target_scale_mode, (v) => {
		onChange({ ...config, target_scale_mode: v });
	});
	container.appendChild(scaleSelect);

	const dirSelect = createSelect(node, "↔️ 方向", DIRECTIONS, config.target_direction, (v) => {
		onChange({ ...config, target_direction: v });
	});
	container.appendChild(dirSelect);

	return container;
}

function createSelect(node, label, options, value, onChange) {
	const container = document.createElement("div");
	container.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0;box-sizing:border-box;position:relative;z-index:1000;pointer-events:auto;";

	const labelEl = document.createElement("span");
	labelEl.textContent = label;
	labelEl.style.cssText = "font-size:10px;color:#aaa;min-width:45px;";

	const select = document.createElement("select");
	options.forEach(opt => {
		const optEl = document.createElement("option");
		if (typeof opt === "object" && opt.value !== undefined) {
			optEl.value = opt.value;
			optEl.textContent = opt.label;
		} else {
			optEl.value = opt;
			optEl.textContent = opt;
		}
		select.appendChild(optEl);
	});
	if (typeof value === "object" && value.value !== undefined) {
		select.value = value.value;
	} else {
		select.value = value;
	}
	select.style.cssText = [
		"flex:1",
		"padding:3px 6px",
		"font-size:10px",
		"background:#2a2a4a",
		"border:1px solid #444",
		"border-radius:4px",
		"color:#fff",
		"pointer-events:auto",
		"position:relative",
		"z-index:1001",
	].join(";");
	select.onchange = () => onChange(select.value);

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		select.addEventListener(eventName, protectEvent, true);
		container.addEventListener(eventName, protectEvent, true);
	}

	container.appendChild(labelEl);
	container.appendChild(select);
	return container;
}

function createModelStatusPanel(node, config) {
	const container = document.createElement("div");
	container.style.cssText = [
		"padding:8px",
		"background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
		"border-radius:6px",
		"margin:6px",
		"border:1px solid #333",
		"font-size:9px",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		container.addEventListener(eventName, protectEvent, true);
	}

	const title = document.createElement("div");
	title.textContent = "🔲 模型状态";
	title.style.cssText = "font-size:10px;font-weight:bold;color:#e0e0e0;margin-bottom:2px;";
	container.appendChild(title);

	const statusText = document.createElement("div");
	statusText.textContent = "加载中...";
	statusText.style.color = "#aaa";
	container.appendChild(statusText);

	fetch(`${API_PATH}?mode=${config.outpaint_mode}`)
		.then(res => res.json())
		.then(data => {
			const { available, complete } = data;
			const modeLabel = OUTPAINT_MODES[config.outpaint_mode]?.name || "未知";

			let html = `<div style="color: ${complete ? '#4CAF50' : '#ff9800'}">${complete ? '✅' : '⚠️'} ${modeLabel}</div>`;

			const typeLabels = {
				checkpoints: "主模型", diffusion_models: "UNET", vae: "VAE",
				text_encoders: "CLIP", clip: "CLIP", controlnet: "ControlNet", loras: "LoRA"
			};

			Object.entries(available).forEach(([type, info]) => {
				const hasModel = info.best !== null;
				html += `
					<div style="display:flex;gap:4px;margin:2px 0;">
						<span>${hasModel ? '✓' : '✗'}</span>
						<span style="color:#aaa;">${typeLabels[type] || type}:</span>
						<span style="color: ${hasModel ? '#81C784' : '#f44336'};">
							${hasModel ? info.best.split(/[/\\]/).pop() : `'${info.keyword}'`}
						</span>
					</div>
				`;
			});

			if (!complete) {
				html += `
					<div style="margin-top:4px;padding:3px;background:rgba(255,152,0,0.1);border-radius:3px;">
						<div style="color:#ff9800;font-size:8px;">📥 下载</div>
						<a href="${DOWNLOAD_URL}" target="_blank" style="color:#64B5F6;font-size:8px;pointer-events:auto;z-index:1001;position:relative;display:inline-block;">
							${DOWNLOAD_URL}
						</a>
					</div>
				`;
			}

			statusText.innerHTML = html;
		})
		.catch(() => {
			statusText.textContent = "❌ 获取模型状态失败";
			statusText.style.color = "#f44336";
		});

	return container;
}

function createSamplerPanel(node, config, onChange, isFlux) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const seedRow = document.createElement("div");
	seedRow.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0;";
	const seedLabel = document.createElement("span");
	seedLabel.textContent = "🎲 种子";
	seedLabel.style.cssText = "font-size:10px;color:#aaa;min-width:45px;";
	const seedInput = document.createElement("input");
	seedInput.type = "number";
	seedInput.value = config.seed;
	seedInput.style.cssText = [
		"flex:1",
		"padding:3px 6px",
		"font-size:10px",
		"background:#2a2a4a",
		"border:1px solid #444",
		"border-radius:4px",
		"color:#fff",
		"pointer-events:auto",
		"position:relative",
		"z-index:1001",
	].join(";");
	seedInput.oninput = () => onChange({ ...config, seed: parseInt(seedInput.value) || 0 });
	seedRow.appendChild(seedLabel);
	seedRow.appendChild(seedInput);
	container.appendChild(seedRow);

	const stepsRow = document.createElement("div");
	stepsRow.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0;";
	const stepsLabel = document.createElement("span");
	stepsLabel.textContent = "👣 步数";
	stepsLabel.style.cssText = "font-size:10px;color:#aaa;min-width:45px;";
	const stepsInput = document.createElement("input");
	stepsInput.type = "number";
	stepsInput.min = "1";
	stepsInput.max = "100";
	stepsInput.value = config.steps;
	stepsInput.style.cssText = [
		"flex:1",
		"padding:3px 6px",
		"font-size:10px",
		"background:#2a2a4a",
		"border:1px solid #444",
		"border-radius:4px",
		"color:#fff",
		"pointer-events:auto",
		"position:relative",
		"z-index:1001",
	].join(";");
	stepsInput.oninput = () => onChange({ ...config, steps: parseInt(stepsInput.value) || 1 });
	stepsRow.appendChild(stepsLabel);
	stepsRow.appendChild(stepsInput);
	container.appendChild(stepsRow);

	if (isFlux) {
		const guidanceRow = document.createElement("div");
		guidanceRow.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0;";
		const guidanceLabel = document.createElement("span");
		guidanceLabel.textContent = "🎯 Guidance";
		guidanceLabel.style.cssText = "font-size:10px;color:#aaa;min-width:45px;";
		const guidanceInput = document.createElement("input");
		guidanceInput.type = "number";
		guidanceInput.min = "0";
		guidanceInput.max = "100";
		guidanceInput.step = "0.5";
		guidanceInput.value = config.guidance;
		guidanceInput.style.cssText = [
			"flex:1",
			"padding:3px 6px",
			"font-size:10px",
			"background:#2a2a4a",
			"border:1px solid #444",
			"border-radius:4px",
			"color:#fff",
			"pointer-events:auto",
			"position:relative",
			"z-index:1001",
		].join(";");
		guidanceInput.oninput = () => onChange({ ...config, guidance: parseFloat(guidanceInput.value) || 0 });
		guidanceRow.appendChild(guidanceLabel);
		guidanceRow.appendChild(guidanceInput);
		container.appendChild(guidanceRow);
	} else {
		const cfgRow = document.createElement("div");
		cfgRow.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0;";
		const cfgLabel = document.createElement("span");
		cfgLabel.textContent = "⚖️ CFG";
		cfgLabel.style.cssText = "font-size:10px;color:#aaa;min-width:45px;";
		const cfgInput = document.createElement("input");
		cfgInput.type = "number";
		cfgInput.min = "0";
		cfgInput.max = "30";
		cfgInput.step = "0.5";
		cfgInput.value = config.cfg;
		cfgInput.style.cssText = [
			"flex:1",
			"padding:3px 6px",
			"font-size:10px",
			"background:#2a2a4a",
			"border:1px solid #444",
			"border-radius:4px",
			"color:#fff",
			"pointer-events:auto",
			"position:relative",
			"z-index:1001",
		].join(";");
		cfgInput.oninput = () => onChange({ ...config, cfg: parseFloat(cfgInput.value) || 0 });
		cfgRow.appendChild(cfgLabel);
		cfgRow.appendChild(cfgInput);
		container.appendChild(cfgRow);

		const schedulerSelect = createSelect(node, "📊 调度器", SCHEDULERS, config.scheduler, (v) => {
			onChange({ ...config, scheduler: v });
		});
		container.appendChild(schedulerSelect);
	}

	const samplerSelect = createSelect(node, "🌀 采样器", SAMPLERS, config.sampler_name, (v) => {
		onChange({ ...config, sampler_name: v });
	});
	container.appendChild(samplerSelect);

	const upscaleSelect = createSelect(node, "🔍 缩放", UPSCALE_METHODS, config.upscale_method, (v) => {
		onChange({ ...config, upscale_method: v });
	});
	container.appendChild(upscaleSelect);

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		container.addEventListener(eventName, protectEvent, true);
	}

	return container;
}

function createStatusBar() {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"padding:8px",
		"background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
		"border-radius:6px",
		"margin:6px",
		"border:1px solid #333",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		container.addEventListener(eventName, protectEvent, true);
	}

	const statusText = document.createElement("div");
	statusText.id = "gjj_outpaint_status";
	statusText.textContent = "就绪";
	statusText.style.cssText = "font-size:10px;color:#4CAF50;text-align:center;";
	container.appendChild(statusText);

	const progressBar = document.createElement("div");
	progressBar.style.cssText = "width:100%;height:3px;background:#333;border-radius:2px;overflow:hidden;";

	const progressFill = document.createElement("div");
	progressFill.id = "gjj_outpaint_progress";
	progressFill.style.cssText = "width:0%;height:100%;background:linear-gradient(90deg, #4CAF50, #2196F3);border-radius:2px;transition:width 0.3s ease;";
	progressBar.appendChild(progressFill);
	container.appendChild(progressBar);

	return container;
}

function updateStatus(text, progress) {
	const statusText = document.getElementById("gjj_outpaint_status");
	const progressFill = document.getElementById("gjj_outpaint_progress");

	if (statusText) {
		statusText.textContent = text;
		statusText.style.color = text.includes("失败") ? "#f44336" :
			text.includes("完成") ? "#4CAF50" : "#2196F3";
	}

	if (progressFill) {
		progressFill.style.width = `${progress}%`;
	}
}

function createImagePreview(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		container.addEventListener(eventName, protectEvent, true);
	}

	const title = document.createElement("div");
	title.textContent = "🖼️ 预览结果";
	title.style.cssText = "font-size:10px;font-weight:bold;color:#e0e0e0;";
	container.appendChild(title);

	const image = document.createElement("img");
	image.dataset.gjjCustomPreview = "true";
	image.style.cssText = [
		"max-width:100%",
		"max-height:120px",
		"object-fit:contain",
		"display:none",
		"cursor:pointer",
		"border-radius:4px",
		"border:1px solid #3b82f6",
		"background:#0f1418",
		"pointer-events:auto",
		"position:relative",
		"z-index:1001",
		"transition:transform 0.15s ease",
	].join(";");

	image.addEventListener("mouseenter", () => {
		image.style.transform = "scale(1.02)";
	});
	image.addEventListener("mouseleave", () => {
		image.style.transform = "scale(1)";
	});

	image.addEventListener("click", (event) => {
		protectEvent(event);

		const overlay = document.createElement("div");
		overlay.style.cssText = [
			"position:fixed",
			"inset:0",
			"background:rgba(0,0,0,0.9)",
			"backdrop-filter:blur(10px)",
			"z-index:99999",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"cursor:zoom-out",
		].join(";");

		const previewImg = document.createElement("img");
		previewImg.src = image.src;
		previewImg.style.cssText = [
			"max-width:90%",
			"max-height:90%",
			"object-fit:contain",
			"border-radius:8px",
			"box-shadow:0 0 40px rgba(0,0,0,0.5)",
			"transition:transform 0.1s ease",
			"cursor:grab",
		].join(";");

		let currentScale = 1;
		const minScale = 0.1;
		const maxScale = 10;

		overlay.addEventListener("wheel", (e) => {
			protectEvent(e);
			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			currentScale = Math.max(minScale, Math.min(maxScale, currentScale + delta));
			previewImg.style.transform = `scale(${currentScale})`;
		});

		let isDragging = false;
		let startX, startY, translateX = 0, translateY = 0;

		previewImg.addEventListener("mousedown", (e) => {
			protectEvent(e);
			isDragging = true;
			startX = e.clientX - translateX;
			startY = e.clientY - translateY;
			previewImg.style.cursor = "grabbing";
		});

		document.addEventListener("mousemove", (e) => {
			if (!isDragging) return;
			translateX = e.clientX - startX;
			translateY = e.clientY - startY;
			previewImg.style.transform = `scale(${currentScale}) translate(${translateX}px, ${translateY}px)`;
		});

		document.addEventListener("mouseup", () => {
			isDragging = false;
			previewImg.style.cursor = "grab";
		});

		overlay.addEventListener("click", () => {
			overlay.remove();
		});

		overlay.appendChild(previewImg);
		document.body.appendChild(overlay);
	});

	container.appendChild(image);
	node.__gjjPreviewImage = image;
	return container;
}

function imageDataToUrl(imageData) {
	if (!imageData) return null;

	if (typeof imageData === "object" && !Array.isArray(imageData)) {
		imageData = [imageData];
	}

	if (Array.isArray(imageData) && imageData.length > 0) {
		const img = imageData[0];
		if (typeof img === "object") {
			let filename = img.filename || img.name || img.file || img.path || "";
			let subfolder = img.subfolder || img.sub || "";
			let type = img.type || img.t || "";

			if (img.full_path || img.fullPath || img.path) {
				const fullPath = img.full_path || img.fullPath || img.path;
				if (fullPath) {
					return api.apiURL(`/view?filename=${encodeURIComponent(fullPath)}`);
				}
			}

			if (filename) {
				let url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}`);
				if (subfolder) {
					url += `&subfolder=${encodeURIComponent(subfolder)}`;
				}
				if (type) {
					url += `&type=${encodeURIComponent(type)}`;
				}
				if (img.random_id || img.timestamp) {
					url += `&rand=${Math.random()}`;
				}
				return url;
			}
		}
	}

	if (typeof imageData === "string") {
		if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
			return imageData;
		}
		return api.apiURL(`/view?filename=${encodeURIComponent(imageData)}`);
	}

	return null;
}

function updateImagePreview(node, imageData) {
	if (!imageData) return;

	console.log("[GJJ] updateImagePreview called with:", imageData);

	if (node.__gjjPreviewImage) {
		const url = imageDataToUrl(imageData);
		if (url) {
			console.log("[GJJ] Setting preview image URL:", url);
			node.__gjjPreviewImage.src = url;

			// 确保我们的自定义预览图的样式完全正常！
			node.__gjjPreviewImage.style.display = "block";
			node.__gjjPreviewImage.style.visibility = "visible";
			node.__gjjPreviewImage.style.height = "";
			node.__gjjPreviewImage.style.width = "";
			node.__gjjPreviewImage.style.margin = "";
			node.__gjjPreviewImage.style.padding = "";
			node.__gjjPreviewImage.style.opacity = "";
			node.__gjjPreviewImage.style.position = "";
			node.__gjjPreviewImage.style.left = "";
			node.__gjjPreviewImage.style.top = "";
			node.__gjjPreviewImage.style.minHeight = "";
			node.__gjjPreviewImage.style.minWidth = "";
			node.__gjjPreviewImage.style.maxHeight = "";
			node.__gjjPreviewImage.style.maxWidth = "";

			GJJ_Utils.refreshNode(node);
		}
	}
}

function hideDefaultPreviewElements(node) {
	// 按照文档中的终极方案：彻底隐藏默认预览
	// 找到节点的 DOM 元素
	let nodeElement = null;
	try {
		// 尝试多种方式获取节点元素
		if (node.imgs) {
			nodeElement = node.imgs;
		} else if (node.element) {
			nodeElement = node.element;
		} else if (node.dummyEl) {
			nodeElement = node.dummyEl;
		} else {
			// 通过 DOM 查找所有可能的节点
			const allCanvasNodes = document.querySelectorAll('.litegraph');
			for (const canvasNode of allCanvasNodes) {
				const potentialNodes = canvasNode.querySelectorAll ?
					canvasNode.querySelectorAll('[data-node-id]') : [];
				for (const el of potentialNodes) {
					if (el.getAttribute('data-node-id') === String(node.id)) {
						nodeElement = el;
						break;
					}
				}
			}
		}
	} catch (e) {
		console.log("[GJJ] Error finding node element:", e);
	}

	// 只要找到了任何节点相关的元素，都尝试查找并隐藏
	if (nodeElement) {
		// 查找所有元素
		const allElements = nodeElement.querySelectorAll ?
			nodeElement.querySelectorAll("*") : [];

		// 查找所有图片元素
		const allImgs = nodeElement.querySelectorAll ?
			nodeElement.querySelectorAll("img") : [];

		// 隐藏所有非自定义的图片
		for (const img of allImgs) {
			if (!img.dataset?.gjjCustomPreview) {
				img.style.display = "none";
				img.style.visibility = "hidden";
			}
		}

		// 隐藏所有看起来是预览的元素
		for (const el of allElements) {
			const classStr = String(el.className || "").toLowerCase();
			const idStr = String(el.id || "").toLowerCase();
			const tagName = String(el.tagName || "").toLowerCase();

			// 判断是否是预览相关的元素
			if (
				classStr.includes("preview") ||
				idStr.includes("preview") ||
				(tagName === "div" && el.querySelector && el.querySelector("img"))) {
				// 检查这个元素是否是我们的自定义预览容器
				let isOurCustomPreview = false;
				const customImgs = el.querySelectorAll ?
					el.querySelectorAll("img[data-gjj-custom-preview='true']") : [];
				if (customImgs.length > 0) {
					isOurCustomPreview = true;
				}

				// 如果不是我们的自定义预览，就隐藏它
				if (!isOurCustomPreview) {
					// 只隐藏明显的预览容器，不隐藏整个节点！
					// 小心地只调整高度！
					el.style.visibility = "hidden";
					el.style.height = "0px";
					el.style.overflow = "hidden";
					el.style.margin = "0px";
					el.style.padding = "0px";
				}
			}
		}
	}
}

function setupPreviewObserver(node) {
	// 按照文档：使用 MutationObserver 实时隐藏默认预览
	// 停止之前的观察器
	if (node.__gjjPreviewObserver) {
		try {
			node.__gjjPreviewObserver.disconnect();
		} catch (e) {
			// 忽略错误
		}
	}

	// 尝试找到节点的 DOM 元素
	let targetElement = null;
	try {
		if (node.imgs) {
			targetElement = node.imgs;
		} else if (node.element) {
			targetElement = node.element;
		} else if (node.dummyEl) {
			targetElement = node.dummyEl;
		}
	} catch (e) {
		// 忽略错误
	}

	// 如果找到了元素，设置观察器
	if (targetElement && targetElement.ownerDocument) {
		node.__gjjPreviewObserver = new MutationObserver((mutations) => {
			// 只要有任何变化，就尝试隐藏预览
			let needsHide = false;

			for (const mutation of mutations) {
				if (mutation.addedNodes && mutation.addedNodes.length > 0) {
					needsHide = true;
					break;
				}
				if (mutation.type === 'attributes' &&
					(mutation.attributeName === 'style' ||
					 mutation.attributeName === 'class' ||
					 mutation.attributeName === 'src')) {
					needsHide = true;
					break;
				}
			}

			if (needsHide) {
				// 延迟隐藏，确保元素完全添加
				setTimeout(() => hideDefaultPreviewElements(node), 0);
				setTimeout(() => hideDefaultPreviewElements(node), 20);
				setTimeout(() => hideDefaultPreviewElements(node), 50);
			}
		});

		// 观察元素的变化
		try {
			node.__gjjPreviewObserver.observe(targetElement, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['style', 'class', 'src'],
			});
		} catch (e) {
			console.log("[GJJ] Error setting up MutationObserver:", e);
		}
	}
}

function createGenerateButton(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:row",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = "🚀 生成图片";
	btn.style.cssText = [
		"width:100%",
		"margin:6px",
		"padding:10px",
		"font-size:12px",
		"font-weight:bold",
		"color:#fff",
		"background:linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
		"border:1px solid #667eea",
		"border-radius:6px",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"box-shadow:0 4px 15px rgba(102,126,234,0.4)",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1001",
		"pointer-events:auto",
		"user-select:none",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"gap:4px",
	].join(";");

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		btn.addEventListener(eventName, protectEvent, true);
		container.addEventListener(eventName, protectEvent, true);
	}

	btn.addEventListener("mouseenter", () => {
		btn.style.transform = "translateY(-1px)";
		btn.style.boxShadow = "0 6px 20px rgba(102,126,234,0.6)";
	});

	btn.addEventListener("mouseleave", () => {
		btn.style.transform = "";
		btn.style.boxShadow = "0 4px 15px rgba(102,126,234,0.4)";
	});

	async function handleGenerate(event) {
		protectEvent(event);
		console.log("[GJJ] 生成图片按钮被点击", node?.id, node?.comfyClass);

		const originalText = btn.textContent;
		btn.textContent = "⏳ 执行中";
		btn.disabled = true;
		btn.style.opacity = "0.7";

		try {
			const ok = await queueOnlyCurrentNode(node);
			if (!ok) {
				console.warn("[GJJ] 当前节点执行失败: queueOnlyCurrentNode 返回 false");
				btn.textContent = "❌ 执行失败";
				btn.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
				btn.style.borderColor = "#ef4444";
			} else {
				btn.textContent = "✅ 执行中";
				btn.style.background = "linear-gradient(135deg, #064e3d, #059669)";
				btn.style.borderColor = "#10b981";
			}
		} catch (error) {
			console.error("[GJJ] 执行当前节点时发生错误:", error);
			btn.textContent = "❌ 错误";
			btn.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			btn.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				btn.textContent = originalText;
				btn.disabled = false;
				btn.style.opacity = "1";
				btn.style.background = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
				btn.style.borderColor = "#667eea";
			}, 1500);
		}
	}

	btn.addEventListener("pointerup", handleGenerate, true);
	btn.addEventListener("click", handleGenerate, true);

	container.appendChild(btn);
	return container;
}

function createMainContainer(node) {
	const container = document.createElement("div");
	container.className = "gjj_outpaint_container";
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		container.addEventListener(eventName, protectEvent, true);
	}

	return container;
}

function renderUI(node, config) {
	const mainWidget = node.widgets?.find(w => w.name === "gjj_outpaint_main");
	if (!mainWidget || !mainWidget.element) return;

	const container = mainWidget.element;
	container.innerHTML = "";

	const isFlux = ["flux1_fill", "flux2_klein", "qwen_image"].includes(config.outpaint_mode);

	container.appendChild(createModeButtons(node, config, (newConfig) => {
		saveConfig(node, newConfig);
		renderUI(node, newConfig);
	}));

	container.appendChild(createMethodButtons(node, config, (newConfig) => {
		saveConfig(node, newConfig);
		renderUI(node, newConfig);
	}));

	container.appendChild(createModelStatusPanel(node, config));

	const paramsPanel = document.createElement("div");
	paramsPanel.style.cssText = [
		"padding:8px",
		"background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
		"border-radius:6px",
		"margin:6px",
		"border:1px solid #333",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	if (config.expand_method === "pixel_expand") {
		paramsPanel.appendChild(createPixelExpandPanel(node, config, (newConfig) => {
			saveConfig(node, newConfig);
		}));
	} else {
		paramsPanel.appendChild(createTargetSizePanel(node, config, (newConfig) => {
			saveConfig(node, newConfig);
		}));
	}

	paramsPanel.appendChild(createSamplerPanel(node, config, (newConfig) => {
		saveConfig(node, newConfig);
	}, isFlux));

	container.appendChild(paramsPanel);
	container.appendChild(createStatusBar());

	updateNodeSize(node);
}

function updateNodeSize(node) {
	setTimeout(() => {
		GJJ_Utils.refreshNode(node);
	}, 50);
}

function setupNode(node) {
	if (node.__gjjSetupDone) return;
	node.__gjjSetupDone = true;

	hideConfigWidget(node);

	const config = parseConfig(node);
	saveConfig(node, config);

	const mainContainer = createMainContainer(node);
	node.addDOMWidget("gjj_outpaint_main", "HTML", mainContainer, { serialize: false });

	const previewContainer = createImagePreview(node);
	node.addDOMWidget("gjj_outpaint_preview", "HTML", previewContainer, { serialize: false });

	const generateContainer = createGenerateButton(node);
	node.addDOMWidget("gjj_outpaint_generate", "HTML", generateContainer, { serialize: false });

	renderUI(node, config);

	// 立即隐藏默认预览
	setTimeout(() => hideDefaultPreviewElements(node), 0);
	setTimeout(() => hideDefaultPreviewElements(node), 50);
	setTimeout(() => hideDefaultPreviewElements(node), 100);

	// 设置观察器实时隐藏
	setupPreviewObserver(node);
}

app.registerExtension({
	name: "GJJ.OutpaintStudio",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== NODE_TYPE) return;

		// 第一步：在注册节点时就隐藏默认预览（基础防线）
		nodeData.output_preview = false;
		if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}

		const origOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = origOnNodeCreated?.apply(this, args);
			setTimeout(() => {
				setupNode(this);
				hideDefaultPreviewElements(this);
			}, 50);
			return result;
		};

		const origOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = origOnConfigure?.apply(this, args);
			setTimeout(() => {
				const config = parseConfig(this);
				saveConfig(this, config);
				renderUI(this, config);
				hideDefaultPreviewElements(this);
			}, 50);
			return result;
		};

		nodeType.prototype.onExecuted = function (message) {
			console.log("[GJJ] onExecuted message:", message);

			// 第二步：不要调用 originalExecuted！会创建默认预览！
			// const result = originalExecuted?.apply(this, [message]); ❌ 不要调用！

			// 只处理自定义预览
			let images = null;
			if (message?.images) {
				images = message.images;
			} else if (message?.ui?.images) {
				images = message.ui.images;
			} else if (message?.output?.images) {
				images = message.output.images;
			} else if (Array.isArray(message?.ui)) {
				for (const uiItem of message.ui) {
					if (uiItem?.images) {
						images = uiItem.images;
						break;
					}
				}
			}

			if (images) {
				console.log("[GJJ] 更新图片预览:", images);
				updateImagePreview(this, images);
			}

			// 多次调用确保彻底隐藏
			setTimeout(() => hideDefaultPreviewElements(this), 0);
			setTimeout(() => hideDefaultPreviewElements(this), 50);
			setTimeout(() => hideDefaultPreviewElements(this), 100);
		};
	},

	setup() {
		setTimeout(() => {
			for (const node of app.graph?._nodes || []) {
				if (node.type === NODE_TYPE) {
					setupNode(node);
					hideDefaultPreviewElements(node);
				}
			}
		}, 200);
	},
});

console.log("[GJJ] 多功能扩图工具节点已加载");

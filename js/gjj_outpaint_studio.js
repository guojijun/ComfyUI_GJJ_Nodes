import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODE_TYPE = "GJJ_OutpaintStudio";
const CONFIG_WIDGET_NAME = "outpaint_config";

const OUTPAINT_MODES = [
	{ id: "sd15_inpaint", label: "🎨 SD1.5" },
	{ id: "flux1_fill", label: "🌀 Flux1" },
	{ id: "flux2_klein", label: "✨ Flux2" },
	{ id: "qwen_image", label: "🌟 Qwen" },
];

const EXPAND_METHODS = [
	{ id: "pixel_expand", label: "像素扩图" },
	{ id: "target_size", label: "目标尺寸" },
];

const SAMPLERS = [
	{ value: "euler", label: "euler" },
	{ value: "euler_ancestral", label: "euler a" },
	{ value: "heun", label: "heun" },
	{ value: "heunpp2", label: "heunpp2" },
	{ value: "dpm_2", label: "dpm_2" },
	{ value: "dpm_2_ancestral", label: "dpm_2 a" },
	{ value: "lms", label: "lms" },
	{ value: "dpm_fast", label: "dpm fast" },
	{ value: "dpm_adaptive", label: "dpm adaptive" },
	{ value: "dpmpp_2s_ancestral", label: "dpmpp 2s a" },
	{ value: "dpmpp_sde", label: "dpmpp sde" },
	{ value: "dpmpp_sde_gpu", label: "dpmpp sde (gpu)" },
	{ value: "dpmpp_2m", label: "dpmpp 2m" },
	{ value: "dpmpp_3m", label: "dpmpp 3m" },
	{ value: "ddim", label: "ddim" },
	{ value: "plms", label: "plms" },
	{ value: "uni_pc", label: "uni_pc" },
	{ value: "uni_pc_bh2", label: "uni_pc bh2" },
];

const SCHEDULERS = [
	{ value: "normal", label: "标准" },
	{ value: "karras", label: "karras" },
	{ value: "exponential", label: "指数" },
	{ value: "sgm_uniform", label: "sgm 均匀" },
	{ value: "simple", label: "简单" },
	{ value: "ddim_uniform", label: "ddim 均匀" },
];

const UPSCALE_METHODS = [
	{ value: "lanczos", label: "lanczos" },
	{ value: "bilinear", label: "双线性" },
	{ value: "nearest", label: "最近邻" },
	{ value: "bicubic", label: "双三次" },
];

const TARGET_DIRECTIONS = [
	{ value: "center", label: "居中扩展" },
	{ value: "left", label: "向左扩展" },
	{ value: "right", label: "向右扩展" },
	{ value: "top", label: "向上扩展" },
	{ value: "bottom", label: "向下扩展" },
	{ value: "top_left", label: "左上扩展" },
	{ value: "top_right", label: "右上扩展" },
	{ value: "bottom_left", label: "左下扩展" },
	{ value: "bottom_right", label: "右下扩展" },
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
		target_direction: "center",
		seed: 0,
		steps: 25,
		cfg: 7.0,
		guidance: 3.5,
		sampler_name: "euler",
		scheduler: "normal",
		upscale_method: "lanczos",
		mask_expand: 10,
	};
}

function parseConfig(node) {
	const configWidget = node.widgets?.find((w) => w.name === CONFIG_WIDGET_NAME);
	if (!configWidget) return getDefaultConfig();
	try {
		const saved = JSON.parse(configWidget.value || "{}");
		return { ...getDefaultConfig(), ...saved };
	} catch {
		return getDefaultConfig();
	}
}

function saveConfig(node, config) {
	const configWidget = node.widgets?.find((w) => w.name === CONFIG_WIDGET_NAME);
	if (!configWidget) return;
	const json = JSON.stringify(config, null, 2);
	configWidget.value = json;
	configWidget.callback?.(json);
	if (node.properties) {
		node.properties[CONFIG_WIDGET_NAME] = json;
	}
}

function hideConfigWidget(node) {
	const widget = node.widgets?.find((w) => w.name === CONFIG_WIDGET_NAME);
	if (!widget) return;
	widget.hidden = true;
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
}

function shieldDomEvents(element) {
	if (!element) return;
	const stop = (e) => e.stopPropagation();
	for (const name of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(name, stop, { passive: true });
	}
}

function styleControl(control) {
	control.style.cssText = [
		"width:100%",
		"min-height:30px",
		"padding:4px 10px",
		"border-radius:10px",
		"border:1px solid #41535b",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"box-sizing:border-box",
	].join(";");
}

function createRow(labelText) {
	const row = document.createElement("div");
	row.style.cssText = ["display:flex", "align-items:center", "gap:8px"].join(";");

	const label = document.createElement("div");
	label.textContent = labelText;
	label.style.cssText = [
		"flex:0 0 72px",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.2",
		"white-space:nowrap",
	].join(";");

	const wrap = document.createElement("div");
	wrap.style.cssText = ["flex:1 1 auto", "display:flex"].join(";");

	row.appendChild(label);
	row.appendChild(wrap);
	return { row, wrap };
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function createModeButtons(node, config) {
	const container = document.createElement("div");
	container.style.cssText = ["display:flex", "flex-direction:column", "gap:8px", "padding:8px"].join(";");

	const label = document.createElement("div");
	label.textContent = "扩图模式 (Ctrl+点击多选)";
	label.style.cssText = "font-size:12px;color:#dce7e2;line-height:1.2;";
	container.appendChild(label);

	const buttonsWrap = document.createElement("div");
	buttonsWrap.style.cssText = ["display:grid", "grid-template-columns:repeat(2,1fr)", "gap:8px"].join(";");

	let buttons = [];

	// 初始化多选状态（从 config 恢复，避免每次打开工作流丢失）
	node.__gjjSelectedModes =
		config.selected_modes?.length
			? [...config.selected_modes]
			: [config.outpaint_mode];

	for (const mode of OUTPAINT_MODES) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = mode.label;
		const updateButtonStyle = () => {
			const selected = node.__gjjSelectedModes?.includes(mode.id) || false;
			btn.style.cssText = [
				"flex:1 1 0",
				"height:32px",
				"padding:0 10px",
				"border-radius:10px",
				`border:1px solid ${selected ? "#5d95a6" : "#314047"}`,
				`background:${selected ? "#27404a" : "#172026"}`,
				`color:${selected ? "#eff7fb" : "#dce7e2"}`,
				"font-size:12px",
				"cursor:pointer",
				"box-sizing:border-box",
				"transition:all 0.15s ease",
			].join(";");
		};
		updateButtonStyle();
		btn.addEventListener("click", (e) => {
			e.stopPropagation();

			if (!node.__gjjSelectedModes) {
				node.__gjjSelectedModes = [];
			}

			if (e.ctrlKey || e.metaKey || e.shiftKey) {
				// Ctrl/Shift+点击：切换多选
				const idx = node.__gjjSelectedModes.indexOf(mode.id);
				if (idx > -1) {
					node.__gjjSelectedModes.splice(idx, 1);
				} else {
					node.__gjjSelectedModes.push(mode.id);
				}
				// 确保至少选中一个
				if (node.__gjjSelectedModes.length === 0) {
					node.__gjjSelectedModes = [mode.id];
				}
			} else {
				// 普通点击：单选
				node.__gjjSelectedModes = [mode.id];
			}

			// 更新当前选中的模式
			node.__gjjConfig = { ...node.__gjjConfig, outpaint_mode: node.__gjjSelectedModes[0], selected_modes: [...node.__gjjSelectedModes] };
			saveConfig(node, node.__gjjConfig);

			// 更新按钮样式
			updateAllButtonStyles();
			if (node.__gjjUpdateParamsVisibility) node.__gjjUpdateParamsVisibility();
			if (node.__gjjUpdateModelStatus) node.__gjjUpdateModelStatus();
		});
		buttons.push({ btn, mode, updateButtonStyle });
		buttonsWrap.appendChild(btn);
	}

	const updateAllButtonStyles = () => {
		for (const { updateButtonStyle } of buttons) {
			updateButtonStyle();
		}
	};

	container.appendChild(buttonsWrap);
	shieldDomEvents(container);

	return { container, updateAllButtonStyles };
}

function createMethodButtons(node, config) {
	const container = document.createElement("div");
	container.style.cssText = ["display:flex", "flex-direction:column", "gap:8px", "padding:8px"].join(";");

	const label = document.createElement("div");
	label.textContent = "扩图方式 (Ctrl+点击多选)";
	label.style.cssText = "font-size:12px;color:#dce7e2;line-height:1.2;";
	container.appendChild(label);

	const buttonsWrap = document.createElement("div");
	buttonsWrap.style.cssText = ["display:flex", "gap:8px", "align-items:center"].join(";");

	let buttons = [];

	// 初始化多选状态（从 config 恢复，避免每次打开工作流丢失）
	node.__gjjSelectedMethods =
		config.selected_methods?.length
			? [...config.selected_methods]
			: [config.expand_method];

	for (const method of EXPAND_METHODS) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = method.label;
		const updateButtonStyle = () => {
			const selected = node.__gjjSelectedMethods?.includes(method.id) || false;
			btn.style.cssText = [
				"flex:1 1 0",
				"height:32px",
				"padding:0 10px",
				"border-radius:10px",
				`border:1px solid ${selected ? "#5d95a6" : "#314047"}`,
				`background:${selected ? "#27404a" : "#172026"}`,
				`color:${selected ? "#eff7fb" : "#dce7e2"}`,
				"font-size:12px",
				"cursor:pointer",
				"box-sizing:border-box",
				"transition:all 0.15s ease",
			].join(";");
		};
		updateButtonStyle();
		btn.addEventListener("click", (e) => {
			e.stopPropagation();

			if (!node.__gjjSelectedMethods) {
				node.__gjjSelectedMethods = [];
			}

			if (e.ctrlKey || e.metaKey || e.shiftKey) {
				// Ctrl/Shift+点击：切换多选
				const idx = node.__gjjSelectedMethods.indexOf(method.id);
				if (idx > -1) {
					node.__gjjSelectedMethods.splice(idx, 1);
				} else {
					node.__gjjSelectedMethods.push(method.id);
				}
				// 确保至少选中一个
				if (node.__gjjSelectedMethods.length === 0) {
					node.__gjjSelectedMethods = [method.id];
				}
			} else {
				// 普通点击：单选
				node.__gjjSelectedMethods = [method.id];
			}

			// 更新当前选中的方式
			node.__gjjConfig = { ...node.__gjjConfig, expand_method: node.__gjjSelectedMethods[0], selected_methods: [...node.__gjjSelectedMethods] };
			saveConfig(node, node.__gjjConfig);

			// 更新按钮样式
			updateAllButtonStyles();
			if (node.__gjjUpdateParamsVisibility) node.__gjjUpdateParamsVisibility();
		});
		buttons.push({ btn, method, updateButtonStyle });
		buttonsWrap.appendChild(btn);
	}

	const updateAllButtonStyles = () => {
		for (const { updateButtonStyle } of buttons) {
			updateButtonStyle();
		}
	};

	container.appendChild(buttonsWrap);
	shieldDomEvents(container);

	return { container, updateAllButtonStyles };
}

function createModelStatus(node, config) {
	const container = document.createElement("div");
	container.style.cssText = ["display:flex", "flex-direction:column", "gap:8px", "padding:8px"].join(";");

	const label = document.createElement("div");
	label.textContent = "模型状态";
	label.style.cssText = "font-size:12px;color:#dce7e2;line-height:1.2;";
	container.appendChild(label);

	const status = document.createElement("div");
	status.textContent = "加载中...";
	status.style.cssText = [
		"min-height:24px",
		"padding:6px 10px",
		"border-radius:10px",
		"border:1px solid #41535b",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
		"box-sizing:border-box",
	].join(";");
	container.appendChild(status);

	const update = (cfg) => {
		fetch(`/gjj/outpaint_models?mode=${cfg.outpaint_mode}`)
			.then((r) => r.json())
			.then((data) => {
				const { available, complete } = data;
				const modeLabel = OUTPAINT_MODES.find((m) => m.id === cfg.outpaint_mode)?.label || "";
				let text = `${complete ? "✅" : "⚠️"} ${modeLabel}\n`;
				for (const [type, info] of Object.entries(available)) {
					const hasModel = info.best !== null;
					text += `${hasModel ? "✓" : "✗"} ${type}: ${hasModel ? info.best.split(/[/\\]/).pop() : "需要下载"}\n`;
				}
				if (!complete) {
					text += "请到 https://pan.quark.cn/s/6ec846f1f58d 下载";
				}
				status.textContent = text.trim();
			})
			.catch(() => {
				status.textContent = "❌ 获取失败";
			});
	};

	shieldDomEvents(container);
	return { container, update };
}

function createParamsPanel(node, config) {
	const container = document.createElement("div");
	container.style.cssText = ["display:flex", "flex-direction:column", "gap:8px", "padding:8px"].join(";");

	// 保存所有元素引用，用于显隐控制
	const elements = {
		pixelExpandRows: [],
		targetSizeRows: [],
		cfgRow: null,
		schedRow: null,
		guideRow: null,
	};

	// 像素扩图部分
	const pixelKeys = [
		{ label: "左扩", key: "pixel_left", step: 8 },
		{ label: "右扩", key: "pixel_right", step: 8 },
		{ label: "上扩", key: "pixel_top", step: 8 },
		{ label: "下扩", key: "pixel_bottom", step: 8 },
	];

	for (const { label, key, step } of pixelKeys) {
		const { row, wrap } = createRow(label);
		const input = document.createElement("input");
		input.type = "number";
		input.min = "0";
		input.step = String(step);
		input.value = config[key];
		styleControl(input);
		const saveValue = () => {
			node.__gjjConfig = { ...node.__gjjConfig, [key]: parseInt(input.value) || 0 };
			saveConfig(node, node.__gjjConfig);
		};
		input.addEventListener("change", saveValue);
		input.addEventListener("blur", saveValue);
		wrap.appendChild(input);
		container.appendChild(row);
		elements.pixelExpandRows.push(row);
	}

	// 目标尺寸部分
	const { row: wRow, wrap: wWrap } = createRow("目标宽");
	const wInput = document.createElement("input");
	wInput.type = "number";
	wInput.min = "64";
	wInput.step = "8";
	wInput.value = config.target_width;
	styleControl(wInput);
	const saveWidth = () => {
		node.__gjjConfig = { ...node.__gjjConfig, target_width: parseInt(wInput.value) || 64 };
		saveConfig(node, node.__gjjConfig);
	};
	wInput.addEventListener("change", saveWidth);
	wInput.addEventListener("blur", saveWidth);
	wWrap.appendChild(wInput);
	container.appendChild(wRow);
	elements.targetSizeRows.push(wRow);

	const { row: hRow, wrap: hWrap } = createRow("目标高");
	const hInput = document.createElement("input");
	hInput.type = "number";
	hInput.min = "64";
	hInput.step = "8";
	hInput.value = config.target_height;
	styleControl(hInput);
	const saveHeight = () => {
		node.__gjjConfig = { ...node.__gjjConfig, target_height: parseInt(hInput.value) || 64 };
		saveConfig(node, node.__gjjConfig);
	};
	hInput.addEventListener("change", saveHeight);
	hInput.addEventListener("blur", saveHeight);
	hWrap.appendChild(hInput);
	container.appendChild(hRow);
	elements.targetSizeRows.push(hRow);

	const { row: dirRow, wrap: dirWrap } = createRow("扩图方向");
	const dirSelect = document.createElement("select");
	for (const d of TARGET_DIRECTIONS) {
		const opt = document.createElement("option");
		opt.value = d.value;
		opt.textContent = d.label;
		dirSelect.appendChild(opt);
	}
	dirSelect.value = config.target_direction;
	styleControl(dirSelect);
	dirSelect.addEventListener("change", () => {
		node.__gjjConfig = { ...node.__gjjConfig, target_direction: dirSelect.value };
		saveConfig(node, node.__gjjConfig);
	});
	dirWrap.appendChild(dirSelect);
	container.appendChild(dirRow);
	elements.targetSizeRows.push(dirRow);

	// 公共参数
	const { row: seedRow, wrap: seedWrap } = createRow("种子");
	const seedInput = document.createElement("input");
	seedInput.type = "number";
	seedInput.value = config.seed;
	styleControl(seedInput);
	const saveSeed = () => {
		node.__gjjConfig = { ...node.__gjjConfig, seed: parseInt(seedInput.value) || 0 };
		saveConfig(node, node.__gjjConfig);
	};
	seedInput.addEventListener("change", saveSeed);
	seedInput.addEventListener("blur", saveSeed);
	seedWrap.appendChild(seedInput);
	container.appendChild(seedRow);

	const { row: stepsRow, wrap: stepsWrap } = createRow("步数");
	const stepsInput = document.createElement("input");
	stepsInput.type = "number";
	stepsInput.min = "1";
	stepsInput.value = config.steps;
	styleControl(stepsInput);
	const saveSteps = () => {
		node.__gjjConfig = { ...node.__gjjConfig, steps: parseInt(stepsInput.value) || 1 };
		saveConfig(node, node.__gjjConfig);
	};
	stepsInput.addEventListener("change", saveSteps);
	stepsInput.addEventListener("blur", saveSteps);
	stepsWrap.appendChild(stepsInput);
	container.appendChild(stepsRow);

	// CFG / Guidance
	const { row: cfgRow, wrap: cfgWrap } = createRow("CFG");
	const cfgInput = document.createElement("input");
	cfgInput.type = "number";
	cfgInput.min = "0";
	cfgInput.max = "30";
	cfgInput.step = "0.5";
	cfgInput.value = config.cfg;
	styleControl(cfgInput);
	const saveCfg = () => {
		node.__gjjConfig = { ...node.__gjjConfig, cfg: parseFloat(cfgInput.value) || 0 };
		saveConfig(node, node.__gjjConfig);
	};
	cfgInput.addEventListener("change", saveCfg);
	cfgInput.addEventListener("blur", saveCfg);
	cfgWrap.appendChild(cfgInput);
	container.appendChild(cfgRow);
	elements.cfgRow = cfgRow;

	const { row: schedRow, wrap: schedWrap } = createRow("调度器");
	const schedSelect = document.createElement("select");
	for (const s of SCHEDULERS) {
		const opt = document.createElement("option");
		opt.value = s.value;
		opt.label = s.label;
		schedSelect.appendChild(opt);
	}
	schedSelect.value = config.scheduler;
	styleControl(schedSelect);
	schedSelect.addEventListener("change", () => {
		node.__gjjConfig = { ...node.__gjjConfig, scheduler: schedSelect.value };
		saveConfig(node, node.__gjjConfig);
	});
	schedWrap.appendChild(schedSelect);
	container.appendChild(schedRow);
	elements.schedRow = schedRow;

	const { row: guideRow, wrap: guideWrap } = createRow("Guidance");
	const guideInput = document.createElement("input");
	guideInput.type = "number";
	guideInput.min = "0";
	guideInput.max = "100";
	guideInput.step = "0.5";
	guideInput.value = config.guidance;
	styleControl(guideInput);
	const saveGuidance = () => {
		node.__gjjConfig = { ...node.__gjjConfig, guidance: parseFloat(guideInput.value) || 0 };
		saveConfig(node, node.__gjjConfig);
	};
	guideInput.addEventListener("change", saveGuidance);
	guideInput.addEventListener("blur", saveGuidance);
	guideWrap.appendChild(guideInput);
	container.appendChild(guideRow);
	elements.guideRow = guideRow;

	// 采样器
	const { row: samplerRow, wrap: samplerWrap } = createRow("采样器");
	const samplerSelect = document.createElement("select");
	for (const s of SAMPLERS) {
		const opt = document.createElement("option");
		opt.value = s.value;
		opt.textContent = s.label;
		samplerSelect.appendChild(opt);
	}
	samplerSelect.value = config.sampler_name;
	styleControl(samplerSelect);
	samplerSelect.addEventListener("change", () => {
		node.__gjjConfig = { ...node.__gjjConfig, sampler_name: samplerSelect.value };
		saveConfig(node, node.__gjjConfig);
	});
	samplerWrap.appendChild(samplerSelect);
	container.appendChild(samplerRow);

	// 缩放
	const { row: upscaleRow, wrap: upscaleWrap } = createRow("缩放");
	const upscaleSelect = document.createElement("select");
	for (const u of UPSCALE_METHODS) {
		const opt = document.createElement("option");
		opt.value = u.value;
		opt.textContent = u.label;
		upscaleSelect.appendChild(opt);
	}
	upscaleSelect.value = config.upscale_method;
	styleControl(upscaleSelect);
	upscaleSelect.addEventListener("change", () => {
		node.__gjjConfig = { ...node.__gjjConfig, upscale_method: upscaleSelect.value };
		saveConfig(node, node.__gjjConfig);
	});
	upscaleWrap.appendChild(upscaleSelect);
	container.appendChild(upscaleRow);

	// 扩展遮罩
	const { row: maskRow, wrap: maskWrap } = createRow("扩展遮罩");
	const maskInput = document.createElement("input");
	maskInput.type = "number";
	maskInput.min = "0";
	maskInput.max = "100";
	maskInput.step = "1";
	maskInput.value = config.mask_expand;
	styleControl(maskInput);
	const saveMaskExpand = () => {
		node.__gjjConfig = { ...node.__gjjConfig, mask_expand: parseInt(maskInput.value) || 0 };
		saveConfig(node, node.__gjjConfig);
	};
	maskInput.addEventListener("change", saveMaskExpand);
	maskInput.addEventListener("blur", saveMaskExpand);
	maskWrap.appendChild(maskInput);
	container.appendChild(maskRow);

	shieldDomEvents(container);
	return { container, elements };
}

function createStatusBar(node) {
	const container = document.createElement("div");
	container.style.cssText = ["display:flex", "flex-direction:column", "gap:8px", "padding:8px"].join(";");

	const bar = document.createElement("div");
	bar.style.cssText = [
		"width:100%",
		"min-height:24px",
		"padding:6px 10px",
		"border-radius:10px",
		"border:1px solid #41535b",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
		"box-sizing:border-box",
	].join(";");
	bar.textContent = "就绪";

	container.appendChild(bar);
	shieldDomEvents(container);
	return { widget: container, bar };
}

function createPreviewPanel(node) {
	const container = document.createElement("div");
	container.style.cssText = ["display:flex", "flex-direction:column", "gap:8px", "padding:8px"].join(";");

	const label = document.createElement("div");
	label.textContent = "预览结果";
	label.style.cssText = "font-size:12px;color:#dce7e2;line-height:1.2;";
	container.appendChild(label);

	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = [
		"width:100%",
		"min-height:120px",
		"border-radius:10px",
		"border:1px solid #314047",
		"background:#172026",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"overflow:hidden",
		"box-sizing:border-box",
	].join(";");

	const img = document.createElement("img");
	img.dataset.gjjCustomPreview = "true";
	img.style.cssText = [
		"max-width:100%",
		"max-height:120px",
		"object-fit:contain",
		"display:none",
		"cursor:pointer",
	].join(";");
	img.addEventListener("click", (e) => {
		e.stopPropagation();
		const overlay = document.createElement("div");
		overlay.style.cssText = [
			"position:fixed",
			"inset:0",
			"background:rgba(0,0,0,0.9)",
			"z-index:99999",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"cursor:zoom-out",
		].join(";");
		const fullImg = document.createElement("img");
		fullImg.src = img.src;
		fullImg.style.cssText = ["max-width:90%", "max-height:90%", "object-fit:contain"].join(";");
		overlay.appendChild(fullImg);
		overlay.addEventListener("click", () => overlay.remove());
		document.body.appendChild(overlay);
	});

	const placeholder = document.createElement("div");
	placeholder.textContent = "等待生成...";
	placeholder.style.cssText = ["color:#8a9ba3", "font-size:12px"].join(";");

	previewWrap.appendChild(img);
	previewWrap.appendChild(placeholder);
	container.appendChild(previewWrap);

	shieldDomEvents(container);
	return { widget: container, img, placeholder };
}

function createGenerateButton(node) {
	const container = document.createElement("div");
	container.style.cssText = ["display:flex", "flex-direction:column", "gap:8px", "padding:8px"].join(";");

	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = "🚀 生成图片";
	btn.style.cssText = [
		"width:100%",
		"height:40px",
		"border-radius:10px",
		"border:1px solid #5d95a6",
		"background:#27404a",
		"color:#eff7fb",
		"font-size:12px",
		"font-weight:bold",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"box-sizing:border-box",
	].join(";");
	btn.addEventListener("mouseenter", () => {
		btn.style.background = "#355a66";
	});
	btn.addEventListener("mouseleave", () => {
		btn.style.background = "#27404a";
	});

	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		// 多选列表已在 mode / method 按钮点击时写入 config 的 selected_modes / selected_methods
		// 后端会一次性按这些列表执行三层循环
		app.queuePrompt(0);
	});

	container.appendChild(btn);
	shieldDomEvents(container);
	return container;
}

function setupNode(node) {
	if (node.__gjjOutpaintSetup) return;
	node.__gjjOutpaintSetup = true;

	hideConfigWidget(node);
	const config = parseConfig(node);
	node.__gjjConfig = { ...config, selected_modes: [...node.__gjjSelectedModes], selected_methods: [...node.__gjjSelectedMethods] };
	saveConfig(node, node.__gjjConfig);

	const mainWrap = document.createElement("div");
	mainWrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:0",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const mainWidget = node.addDOMWidget?.("gjj_outpaint_main", "gjj_outpaint_main", mainWrap, {
		hideOnZoom: false,
		getHeight: () => 600,
	});

	node.__gjjOutpaintMainWrap = mainWrap;

	// 创建所有组件
	const modeData = createModeButtons(node, config);
	node.__gjjModeButtons = modeData;
	mainWrap.appendChild(modeData.container);

	const methodData = createMethodButtons(node, config);
	node.__gjjMethodButtons = methodData;
	mainWrap.appendChild(methodData.container);

	const modelStatusData = createModelStatus(node, config);
	node.__gjjModelStatus = modelStatusData;
	mainWrap.appendChild(modelStatusData.container);

	const paramsData = createParamsPanel(node, config);
	node.__gjjParams = paramsData;
	mainWrap.appendChild(paramsData.container);

	const statusData = createStatusBar(node);
	node.__gjjOutpaintStatusBar = statusData;
	const statusWidget = node.addDOMWidget?.("gjj_outpaint_status", "gjj_outpaint_status", statusData.widget, {
		hideOnZoom: false,
		getHeight: () => 60,
	});

	const previewData = createPreviewPanel(node);
	node.__gjjOutpaintPreview = previewData;
	const previewWidget = node.addDOMWidget?.("gjj_outpaint_preview", "gjj_outpaint_preview", previewData.widget, {
		hideOnZoom: false,
		getHeight: () => 180,
	});

	const generateBtn = createGenerateButton(node);
	const generateWidget = node.addDOMWidget?.("gjj_outpaint_generate", "gjj_outpaint_generate", generateBtn, {
		hideOnZoom: false,
		getHeight: () => 60,
	});

	// 更新参数可见性的函数
	node.__gjjUpdateParamsVisibility = () => {
		const cfg = node.__gjjConfig;
		const isFlux = ["flux1_fill", "flux2_klein", "qwen_image"].includes(cfg.outpaint_mode);
		const isPixel = cfg.expand_method === "pixel_expand";

		// 更新像素/目标部分的显示
		if (paramsData.elements.pixelExpandRows) {
			for (const row of paramsData.elements.pixelExpandRows) {
				row.style.display = isPixel ? "flex" : "none";
			}
		}
		if (paramsData.elements.targetSizeRows) {
			for (const row of paramsData.elements.targetSizeRows) {
				row.style.display = isPixel ? "none" : "flex";
			}
		}

		// 更新 CFG/调度器/Guidance
		if (paramsData.elements.cfgRow) {
			paramsData.elements.cfgRow.style.display = isFlux ? "none" : "flex";
		}
		if (paramsData.elements.schedRow) {
			paramsData.elements.schedRow.style.display = isFlux ? "none" : "flex";
		}
		if (paramsData.elements.guideRow) {
			paramsData.elements.guideRow.style.display = isFlux ? "flex" : "none";
		}
	};

	// 更新模型状态的函数
	node.__gjjUpdateModelStatus = () => {
		node.__gjjModelStatus.update(node.__gjjConfig);
	};

	// 更新所有按钮样式的函数
	node.__gjjUpdateButtons = () => {
		node.__gjjModeButtons.updateAllButtonStyles();
		node.__gjjMethodButtons.updateAllButtonStyles();
	};

	// 初始更新
	node.__gjjUpdateParamsVisibility();
	node.__gjjUpdateModelStatus();

	refreshNode(node);
}

function imageDataToUrl(imageData) {
	if (!imageData) return null;
	if (typeof imageData === "object" && !Array.isArray(imageData)) {
		imageData = [imageData];
	}
	if (Array.isArray(imageData) && imageData.length > 0) {
		const img = imageData[0];
		if (typeof img === "object") {
			const filename = img.filename || img.name || img.file || img.path || "";
			const subfolder = img.subfolder || img.sub || "";
			if (filename) {
				let url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}`);
				if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;
				if (img.type) url += `&type=${encodeURIComponent(img.type)}`;
				url += `&rand=${Math.random()}`;
				return url;
			}
		}
	}
	if (typeof imageData === "string") {
		if (imageData.startsWith("http")) return imageData;
		return api.apiURL(`/view?filename=${encodeURIComponent(imageData)}`);
	}
	return null;
}

app.registerExtension({
	name: "GJJ.OutpaintStudio",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== TARGET_NODE_TYPE) return;

		nodeData.output_preview = false;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalOnNodeCreated?.apply(this, arguments);
			setupNode(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const result = originalOnConfigure?.apply(this, arguments);
			setupNode(this);
			return result;
		};

		nodeType.prototype.onExecuted = function (message) {
			const previewData = this.__gjjOutpaintPreview;
			if (previewData) {
				let images = null;
				if (message?.images) images = message.images;
				else if (message?.ui?.images) images = message.ui.images;

				if (images) {
					const url = imageDataToUrl(images);
					if (url) {
						previewData.img.src = url;
						previewData.img.style.display = "block";
						previewData.placeholder.style.display = "none";
					}
				}
			}
		};
	},

	setup() {
		setTimeout(() => {
			for (const node of app.graph?._nodes || []) {
				if (node.type === TARGET_NODE_TYPE) {
					setupNode(node);
				}
			}
		}, 200);
	},
});

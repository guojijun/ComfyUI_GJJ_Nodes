import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_ComprehensiveMatting";
const METHOD_WIDGET = "matting_method";
const STATUS_WIDGET = "model_status_json";
const SELECTED_METHODS_WIDGET = "selected_methods_json";
const PANEL_WIDGET = "gjj_matting_method_buttons";
const ADVANCED_PARAMS_PROP = "gjj_matting_params_expanded";
const MEDIA_INPUT = "media";
const MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const HIDDEN_NAMES = new Set([METHOD_WIDGET, STATUS_WIDGET, SELECTED_METHODS_WIDGET]);
const COLLAPSIBLE_PARAM_NAMES = [
	"background",
	"device",
	"process_res",
	"threshold",
	"mask_blur",
	"invert_output",
	"inspyrenet_jit",
];
const COLLAPSIBLE_PARAMS = new Set(COLLAPSIBLE_PARAM_NAMES);
const PARAM_LABELS = {
	background: "背景填充",
	device: "设备",
	process_res: "处理分辨率",
	threshold: "遮罩阈值",
	mask_blur: "遮罩模糊",
	invert_output: "反转遮罩",
	inspyrenet_jit: "Inspyrenet JIT",
};
const PARAM_HINTS = {
	background: "输出透明、白底或黑底。",
	device: "自动优先使用 CUDA。",
	process_res: "RMBG1.4/RMBG2/BiRefNet 内部推理分辨率。",
	threshold: "0 保留软遮罩，大于 0 时二值化。",
	mask_blur: "对最终遮罩做高斯模糊。",
	invert_output: "反转最终前景遮罩和透明通道。",
	inspyrenet_jit: "仅 Inspyrenet 使用，首次运行更慢。",
};
const HELP_ENDPOINT = "/gjj/node_help";

const METHODS = [
	{ value: "RMBG1.4", label: "RMBG1.4", suffix: "RMBG1.4", title: "RMBG1.4 默认背景移除" },
	{ value: "RMBG2", label: "RMBG2", suffix: "RMBG2", title: "RMBG2 通用背景移除" },
	{ value: "官方背景移除", label: "官方", suffix: "官方背景移除", title: "ComfyUI 官方背景移除模型" },
	{ value: "BiRefNet 通用", label: "通用", suffix: "BiRef通用", title: "BiRefNet General 通用抠图" },
	{ value: "BiRefNet 精细", label: "精细", suffix: "BiRef精细", title: "BiRefNet Matting 精细抠图" },
	{ value: "BEN2", label: "BEN2", suffix: "BEN2", title: "BEN2 抠图" },
	{ value: "Inspyrenet", label: "Inspyrenet", suffix: "Inspyrenet", title: "Inspyrenet 抠图" },
];
let backendStatusJson = "";
let helpLoadPromise = null;

function refreshNodeSize(node) {
	const width = Math.max(300, Number(node?.size?.[0] || 300));
	const computed = node.computeSize?.();
	node.setSize?.([width, Math.max(120, Number(computed?.[1] || 120))]);
	app.graph?.setDirtyCanvas?.(true, true);
}

function findInput(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.find((input) => input?.name === name) : null;
}

function isParamsExpanded(node) {
	const value = node?.properties?.[ADVANCED_PARAMS_PROP];
	return value === true || value === "true" || value === 1 || value === "1";
}

function removeUnlinkedParamInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const type = String(input?.type || "");
		const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
		if (!COLLAPSIBLE_PARAMS.has(name) && !COLLAPSIBLE_PARAMS.has(converted)) {
			continue;
		}
		if (input?.link != null) {
			input.label = input.label || name;
			input.localized_name = input.localized_name || input.label;
			continue;
		}
		if (typeof node.removeInput === "function") {
			node.removeInput(index);
		} else {
			node.inputs.splice(index, 1);
		}
	}
}

function setWidgetValue(node, name, value) {
	const widget = GJJ_Utils.getWidget(node, name);
	if (!widget) {
		return;
	}
	widget.value = value;
	node.properties = node.properties || {};
	node.properties[name] = value;
	widget.callback?.(widget.value, app.canvas, node, undefined, widget);
	node.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
}

function nativeValue(node, name) {
	return GJJ_Utils.getWidget(node, name)?.value;
}

function persistParamValues(node, target = null) {
	const props = target || node.properties || {};
	for (const name of COLLAPSIBLE_PARAM_NAMES) {
		const widget = GJJ_Utils.getWidget(node, name);
		if (widget) {
			props[name] = widget.value;
		}
	}
	return props;
}

function restoreParamValues(node, props) {
	if (!props) {
		return;
	}
	for (const name of COLLAPSIBLE_PARAM_NAMES) {
		if (!(name in props)) {
			continue;
		}
		const widget = GJJ_Utils.getWidget(node, name);
		if (widget) {
			widget.value = props[name];
		}
	}
}

function fieldStyle() {
	return [
		"height:26px",
		"min-width:0",
		"width:100%",
		"border-radius:5px",
		"border:1px solid #3f4d54",
		"background:#10171b",
		"color:#dce8ec",
		"padding:0 8px",
		"font:12px/24px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
		"box-sizing:border-box",
		"outline:none",
	].join(";");
}

function createParamControl(node, name) {
	const widget = GJJ_Utils.getWidget(node, name);
	const value = widget?.value;
	if (Array.isArray(widget?.options?.values)) {
		const select = document.createElement("select");
		select.dataset.paramName = name;
		select.style.cssText = fieldStyle();
		for (const item of widget.options.values) {
			const option = document.createElement("option");
			option.value = String(item);
			option.textContent = String(item);
			select.appendChild(option);
		}
		select.value = String(value ?? widget.options.values[0] ?? "");
		select.addEventListener("change", () => setWidgetValue(node, name, select.value));
		return select;
	}
	if (typeof value === "boolean") {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.paramName = name;
		const update = () => {
			const active = Boolean(nativeValue(node, name));
			button.textContent = active ? "开启" : "关闭";
			button.style.cssText = [
				fieldStyle(),
				`background:${active ? "#24452d" : "#10171b"}`,
				`border-color:${active ? "#6aa56f" : "#3f4d54"}`,
				`color:${active ? "#eaffed" : "#dce8ec"}`,
				"font-weight:700",
				"cursor:pointer",
			].join(";");
		};
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(node, name, !Boolean(nativeValue(node, name)));
			update();
		});
		update();
		return button;
	}
	const input = document.createElement("input");
	input.type = typeof value === "number" ? "number" : "text";
	input.dataset.paramName = name;
	input.style.cssText = fieldStyle();
	input.value = value ?? "";
	if (input.type === "number") {
		const options = widget?.options || {};
		if (options.min != null) input.min = String(options.min);
		if (options.max != null) input.max = String(options.max);
		if (options.step != null) input.step = String(options.step);
	}
	input.addEventListener("change", () => {
		const next = input.type === "number" ? Number(input.value) : input.value;
		setWidgetValue(node, name, Number.isNaN(next) ? 0 : next);
	});
	return input;
}

function createParamPanel(node) {
	const panel = document.createElement("div");
	panel.style.cssText = [
		"display:grid",
		"grid-template-columns:minmax(84px, 0.48fr) minmax(120px, 1fr)",
		"gap:6px 8px",
		"width:100%",
		"flex:1 0 100%",
		"padding:4px 0 0 0",
		"box-sizing:border-box",
	].join(";");
	panel.addEventListener("mousedown", (event) => event.stopPropagation());
	panel.addEventListener("pointerdown", (event) => event.stopPropagation());

	for (const name of COLLAPSIBLE_PARAM_NAMES) {
		const label = document.createElement("label");
		label.textContent = PARAM_LABELS[name] || name;
		label.title = PARAM_HINTS[name] || "";
		label.style.cssText = [
			"height:26px",
			"color:#aebcc2",
			"font:12px/26px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
			"white-space:nowrap",
			"overflow:hidden",
			"text-overflow:ellipsis",
			"box-sizing:border-box",
		].join(";");
		const control = createParamControl(node, name);
		control.title = PARAM_HINTS[name] || "";
		panel.appendChild(label);
		panel.appendChild(control);
	}
	return panel;
}

function syncParamPanel(node) {
	const state = node.__gjjMattingButtons;
	if (!state?.paramPanel) {
		return;
	}
	const expanded = isParamsExpanded(node);
	state.paramPanel.style.display = expanded ? "grid" : "none";
	if (!expanded) {
		return;
	}
	const controls = Array.from(state.paramPanel.querySelectorAll("[data-param-name]"));
	for (const control of controls) {
		const name = control.dataset.paramName;
		const value = nativeValue(node, name);
		if (control.tagName === "SELECT") {
			control.value = String(value ?? "");
		} else if (control.tagName === "INPUT") {
			control.value = value ?? "";
		} else if (control.tagName === "BUTTON") {
			const active = Boolean(value);
			control.textContent = active ? "开启" : "关闭";
			control.style.cssText = [
				fieldStyle(),
				`background:${active ? "#24452d" : "#10171b"}`,
				`border-color:${active ? "#6aa56f" : "#3f4d54"}`,
				`color:${active ? "#eaffed" : "#dce8ec"}`,
				"font-weight:700",
				"cursor:pointer",
			].join(";");
		}
	}
}

function applyBranchDependencyNotice(node) {
	const noticeApi = globalThis.GJJ_CommonDependencyModelNotice;
	if (!noticeApi?.applyNotice) {
		return;
	}
	const selected = parseSelectedMethods(node);
	const status = parseStatus(node);
	const reports = [];
	for (const method of selected) {
		const info = status?.[method] || {};
		if (!info.dependency_warning_message && !info.dependency_panel_message) {
			continue;
		}
		reports.push({ method, info });
	}
	if (!reports.length) {
		if (node.__gjjDependencyNotice) {
			noticeApi.applyNotice(node, { warning_message: "", panel_message: "", copy_text: "" });
		}
		return;
	}
	const labels = reports.map((item) => item.method).join("、");
	const first = reports[0].info;
	const installCommands = Array.from(new Set(reports.map((item) => String(item.info.dependency_install_cmd || item.info.dependency_copy_text || "").trim()).filter(Boolean)));
	noticeApi.applyNotice(node, {
		warning_message: `⚠️${labels} 分支缺失运行依赖，点击复制安装命令。`,
		panel_message: reports.map((item) => item.info.dependency_panel_message || item.info.dependency_warning_message || "").filter(Boolean).join("\n\n"),
		install_command: installCommands.join("\n"),
		copy_text: installCommands.join("\n"),
		copy_label: first.dependency_copy_label || "📋 复制安装命令",
		notice_level: first.dependency_notice_level || "error",
	}, { detailed: false });
}

function applyParamVisibility(node) {
	for (const name of COLLAPSIBLE_PARAM_NAMES) {
		const widget = GJJ_Utils.getWidget(node, name);
		if (!widget) {
			continue;
		}
		GJJ_Utils.hideWidget(widget);
	}
	removeUnlinkedParamInputs(node);
	const hiddenNames = new Set(HIDDEN_NAMES);
	for (const name of COLLAPSIBLE_PARAM_NAMES) {
		hiddenNames.add(name);
	}
	GJJ_Utils.reorderWidgets(node, hiddenNames);
	syncParamPanel(node);
	GJJ_Utils.refreshNode(node);
	applyBranchDependencyNotice(node);
}

function removeInternalInputs(node) {
	// 只删除 DOM 面板的输入槽，保留核心数据 Widget 的输入槽（序列化需要）
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const type = String(input?.type || '');
		const name = String(input?.name || '');
		if (name === PANEL_WIDGET || type.startsWith('converted-widget:' + PANEL_WIDGET)) {
			try { node.disconnectInput?.(index); } catch (_) {}
			node.removeInput?.(index);
		}
	}
}

function normalizeInputSlots(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	removeInternalInputs(node);

	let mediaInput = findInput(node, MEDIA_INPUT);
	if (!mediaInput) {
		mediaInput = Array.isArray(node.inputs)
			? node.inputs.find((input) => ["batch_image", "image"].includes(String(input?.name || "")) && input?.link != null)
			: null;
	}

	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		if ((name === "batch_image" || name === "image") && input !== mediaInput) {
			if (input?.link != null) {
				try { node.disconnectInput?.(index); } catch (_) {}
			}
			node.removeInput?.(index);
		}
	}

	if (mediaInput) {
		mediaInput.type = MEDIA_INPUT_TYPE;
		mediaInput.name = MEDIA_INPUT;
		mediaInput.label = "图片/视频";
		mediaInput.localized_name = mediaInput.label;
		mediaInput.tooltip = "统一输入口，支持 GJJ_BATCH_IMAGE、普通 IMAGE/IMAGE batch 和官方 VIDEO；接 VIDEO 时自动读取视频帧。";
	}

	if (mediaInput) {
		const mediaIndex = node.inputs.indexOf(mediaInput);
		if (mediaIndex > 0) {
			node.inputs.splice(mediaIndex, 1);
			node.inputs.unshift(mediaInput);
		}
	}
}

function normalizeOutputSlots(node) {
	if (!Array.isArray(node?.outputs)) {
		return;
	}
	while (node.outputs.length > 2) {
		node.removeOutput?.(node.outputs.length - 1);
	}
	if (!node.outputs.length) {
		node.addOutput?.("图像", "IMAGE");
	}
	if (node.outputs.length < 2) {
		node.addOutput?.("遮罩", "MASK");
	}
	const imageOutput = node.outputs[0];
	imageOutput.name = "图像";
	imageOutput.label = "图像";
	imageOutput.localized_name = "图像";
	imageOutput.type = "IMAGE";
	imageOutput.tooltip = "把所有已选路线的结果按路线顺序合并成一个 ComfyUI 原生 IMAGE batch 输出，可直接连接预览、保存和普通 IMAGE 节点。";
	const maskOutput = node.outputs[1];
	maskOutput.name = "遮罩";
	maskOutput.label = "遮罩";
	maskOutput.localized_name = "遮罩";
	maskOutput.type = "MASK";
	maskOutput.tooltip = "把所有已选路线生成的前景遮罩按路线顺序合并成 MASK batch 输出。";
}

function normalizeSlots(node) {
	normalizeInputSlots(node);
	normalizeOutputSlots(node);
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function hideInternalWidget(widget) {
	if (!widget) {
		return;
	}
	if (!widget.__gjjMattingOriginalWidgetState) {
		widget.__gjjMattingOriginalWidgetState = {
			type: widget.type,
			computeSize: widget.computeSize,
			getHeight: widget.getHeight,
			draw: widget.draw,
			mouse: widget.mouse,
			y: widget.y,
			last_y: widget.last_y,
		};
	}
	widget.hidden = true;
	widget.disabled = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.label = "";
	widget.localized_name = "";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.y = -100000;
	widget.last_y = -100000;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	widget.options = widget.options || {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	const elements = [
		widget.element,
		widget.inputEl,
		widget.container,
		widget.domElement,
	].filter(Boolean);
	for (const element of elements) {
		element.style.display = "none";
		element.style.height = "0";
		element.style.minHeight = "0";
		element.style.margin = "0";
		element.style.padding = "0";
		element.style.border = "0";
		element.style.overflow = "hidden";
	}
}

function removeLegacyInternalStateWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const removable = new Set([STATUS_WIDGET, SELECTED_METHODS_WIDGET]);
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		const widget = node.widgets[index];
		if (!removable.has(String(widget?.name || ""))) {
			continue;
		}
		for (const element of [widget.element, widget.inputEl, widget.container, widget.domElement]) {
			try { element?.remove?.(); } catch (_) {}
		}
		node.widgets.splice(index, 1);
	}
}

function compactNode(node) {
	// 标准 GJJ compact 模式：隐藏 → 删除输入槽 → 重排控件 → 刷新尺寸
	removeLegacyInternalStateWidgets(node);
	hideInternalWidget(GJJ_Utils.getWidget(node, METHOD_WIDGET));
	// 核心数据通过 onSerialize → properties → onConfigure 保证序列化往返
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_NAMES);
	// 重排控件：gjj_ 前缀排前，隐藏控件排后
	GJJ_Utils.reorderWidgets(node, HIDDEN_NAMES);
	GJJ_Utils.refreshNode(node);
}

function loadBackendStatusFromHelp() {
	if (helpLoadPromise) {
		return helpLoadPromise;
	}
	helpLoadPromise = fetch(HELP_ENDPOINT)
		.then((response) => response.json())
		.then((data) => {
			const status = data?.[NODE_TYPE]?.help?.model_status;
			if (status && typeof status === "object") {
				backendStatusJson = JSON.stringify(status);
			}
			return backendStatusJson;
		})
		.catch((error) => {
			console.warn("[GJJ] 综合抠图模型状态读取失败:", error);
			return backendStatusJson;
		});
	return helpLoadPromise;
}

function refreshStatusWidgetFromBackendDefault(node, statusJson) {
	const widget = GJJ_Utils.getWidget(node, STATUS_WIDGET);
	if (widget && statusJson) {
		widget.value = statusJson;
	}
	if (statusJson) {
		node.__gjjMattingBackendStatusJson = statusJson;
	}
	node.properties = node.properties || {};
	delete node.properties[STATUS_WIDGET];
}

function refreshStatusFromHelpAndSync(node) {
	loadBackendStatusFromHelp().then((statusJson) => {
		refreshStatusWidgetFromBackendDefault(node, statusJson);
		syncButtons(node);
		applyBranchDependencyNotice(node);
		refreshNodeSize(node);
	});
}

function parseStatus(node) {
	const widget = GJJ_Utils.getWidget(node, STATUS_WIDGET);
	const raw = String(widget?.value || node?.__gjjMattingBackendStatusJson || backendStatusJson || "");
	if (!raw) {
		return {};
	}
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function parseSelectedMethods(node) {
	const widget = GJJ_Utils.getWidget(node, SELECTED_METHODS_WIDGET);
	const fallback = GJJ_Utils.getWidget(node, METHOD_WIDGET)?.value || METHODS[0].value;
	let selected = [];
	try {
		const raw = String(widget?.value || node?.properties?.[SELECTED_METHODS_WIDGET] || "");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			selected = parsed.filter((value) => METHODS.some((method) => method.value === value));
		}
	} catch {
		selected = [];
	}
	if (!selected.length) {
		selected = [fallback];
	}
	return METHODS.map((method) => method.value).filter((value) => selected.includes(value));
}

function writeSelectedMethods(node, selected) {
	const cleaned = METHODS.map((method) => method.value).filter((value) => selected.includes(value));
	const finalSelection = cleaned.length ? cleaned : [METHODS[0].value];
	const serialized = JSON.stringify(finalSelection);
	node.properties = node.properties || {};
	node.properties[SELECTED_METHODS_WIDGET] = serialized;
	const widget = GJJ_Utils.getWidget(node, SELECTED_METHODS_WIDGET);
	if (widget) {
		widget.value = serialized;
		widget.callback?.(widget.value, app.canvas, node, undefined, widget);
	}
	const methodWidget = GJJ_Utils.getWidget(node, METHOD_WIDGET);
	if (methodWidget) {
		methodWidget.value = finalSelection[0];
		methodWidget.callback?.(methodWidget.value, app.canvas, node, undefined, methodWidget);
	}
	return finalSelection;
}

function buttonStyle(active, disabled) {
	return [
		"height:26px",
		"min-width:54px",
		"padding:0 10px",
		"border-radius:6px",
		"border:1px solid",
		`border-color:${disabled ? "#30383d" : (active ? "#78a9ba" : "#3f4d54")}`,
		`background:${disabled ? "#101519" : (active ? "#28424d" : "#161f24")}`,
		`color:${disabled ? "#66747a" : (active ? "#f3fbff" : "#cfd9dd")}`,
		`opacity:${disabled ? "0.55" : "1"}`,
		"font:12px/24px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
		"white-space:nowrap",
		`cursor:${disabled ? "not-allowed" : "pointer"}`,
		"box-sizing:border-box",
	].join(";");
}

function toggleButtonStyle(active) {
	return [
		"height:26px",
		"min-width:76px",
		"padding:0 10px",
		"border-radius:6px",
		"border:1px solid",
		`border-color:${active ? "#6aa56f" : "#3f4d54"}`,
		`background:${active ? "#24452d" : "#151d22"}`,
		`color:${active ? "#eaffed" : "#d1dde1"}`,
		"font:700 12px/24px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
		"white-space:nowrap",
		"cursor:pointer",
		"box-sizing:border-box",
	].join(";");
}

function statusTooltip(method, info) {
	if (info?.available === false) {
		return [
			method,
			"模型：未找到",
			String(info.message || "已在 models 下相关目录模糊搜索，但没有匹配文件。"),
		].join("\n");
	}
	const modelName = String(info?.model_name || "").trim();
	const modelPath = String(info?.model_path || "").trim();
	return [
		method,
		modelName ? `模型：${modelName}` : "",
		modelPath ? `路径：${modelPath}` : "",
	].filter(Boolean).join("\n");
}

function syncButtons(node) {
	const state = node.__gjjMattingButtons;
	if (!state) {
		return;
	}
	const selected = new Set(parseSelectedMethods(node));
	const status = parseStatus(node);
	for (const item of METHODS) {
		const button = state.buttons.get(item.value);
		if (button) {
			const info = status[item.value] || {};
			const disabled = info.available === false;
			button.disabled = disabled;
			const hint = "普通点击单选；按 Shift 点击可多选/取消该路线。";
			button.title = `${statusTooltip(item.value, info) || item.title || item.value}\n${hint}`;
			button.style.cssText = buttonStyle(selected.has(item.value), disabled);
		}
	}
	if (state.toggleButton) {
		const expanded = isParamsExpanded(node);
		state.toggleButton.textContent = expanded ? "⏮️ 折叠" : "⏯️ 展开";
		state.toggleButton.title = expanded ? "折叠下方抠图参数" : "展开下方抠图参数";
		state.toggleButton.style.cssText = toggleButtonStyle(expanded);
	}
	syncParamPanel(node);
	applyBranchDependencyNotice(node);
}

function setMethod(node, value, append = false) {
	const info = parseStatus(node)?.[value];
	if (info?.available === false) {
		return;
	}
	let selected = parseSelectedMethods(node);
	if (append) {
		if (selected.includes(value)) {
			selected = selected.filter((item) => item !== value);
		} else {
			selected.push(value);
		}
	} else {
		selected = [value];
	}
	writeSelectedMethods(node, selected);
	node.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
	syncButtons(node);
	normalizeSlots(node);
	applyParamVisibility(node);
	refreshNodeSize(node);
}

function setParamsExpanded(node, expanded) {
	node.properties = node.properties || {};
	node.properties[ADVANCED_PARAMS_PROP] = Boolean(expanded);
	applyParamVisibility(node);
	syncButtons(node);
	refreshNodeSize(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
}

function mountButtons(node) {
	if (node.__gjjMattingButtons || typeof node.addDOMWidget !== "function") {
		const state = node.__gjjMattingButtons;
		if (state?.wrap && !state.paramPanel) {
			state.paramPanel = createParamPanel(node);
			state.wrap.appendChild(state.paramPanel);
			if (state.widget) {
				state.widget.computeSize = (width) => [
					Math.max(300, Number(width || node.size?.[0] || 300)),
					isParamsExpanded(node) ? 302 : 62,
				];
			}
		}
		compactNode(node);
		normalizeSlots(node);
		applyParamVisibility(node);
		syncButtons(node);
		refreshNodeSize(node);
		return;
	}

	compactNode(node);
	normalizeSlots(node);

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-wrap:wrap",
		"gap:6px",
		"padding:2px 0 4px 0",
		"box-sizing:border-box",
		"width:100%",
	].join(";");

	const buttons = new Map();
	for (const item of METHODS) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = item.label;
		button.title = `${item.title}
普通点击单选；按 Shift 点击可多选/取消该路线。`;
		button.dataset.value = item.value;
		button.style.cssText = buttonStyle(false, false);
		button.addEventListener("mousedown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setMethod(node, item.value, Boolean(event.shiftKey));
		});
		buttons.set(item.value, button);
		wrap.appendChild(button);
	}

	const toggleButton = document.createElement("button");
	toggleButton.type = "button";
	toggleButton.addEventListener("mousedown", (event) => event.stopPropagation());
	toggleButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setParamsExpanded(node, !isParamsExpanded(node));
	});
	wrap.appendChild(toggleButton);

	const paramPanel = createParamPanel(node);
	wrap.appendChild(paramPanel);

	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", wrap, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [
		Math.max(300, Number(width || node.size?.[0] || 300)),
		isParamsExpanded(node) ? 302 : 62,
	];

	node.__gjjMattingButtons = { widget, wrap, buttons, toggleButton, paramPanel };
	syncButtons(node);
	applyParamVisibility(node);
	refreshNodeSize(node);
}

function stabilizeNode(node) {
	compactNode(node);
	normalizeSlots(node);
	mountButtons(node);
	applyParamVisibility(node);
	syncButtons(node);
	refreshNodeSize(node);
}

app.registerExtension({
	name: "GJJ.ComprehensiveMatting.Buttons",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) {
			return;
		}

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			originalCreated?.apply(this, args);
			refreshStatusWidgetFromBackendDefault(this, backendStatusJson);
			stabilizeNode(this);
			refreshStatusFromHelpAndSync(this);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 80);
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			originalConfigure?.apply(this, args);
			// 从 properties 恢复核心数据（不受 widget 重排影响）
			const props = this.properties || {};
			refreshStatusWidgetFromBackendDefault(this, backendStatusJson);
			const selectedWidget = GJJ_Utils.getWidget(this, SELECTED_METHODS_WIDGET);
			if (selectedWidget && props[SELECTED_METHODS_WIDGET]) {
				selectedWidget.value = props[SELECTED_METHODS_WIDGET];
			}
			const methodWidget = GJJ_Utils.getWidget(this, METHOD_WIDGET);
			if (methodWidget && props[METHOD_WIDGET]) {
				methodWidget.value = props[METHOD_WIDGET];
			}
			this.properties = this.properties || {};
			delete this.properties[STATUS_WIDGET];
			if (props[ADVANCED_PARAMS_PROP] === undefined) {
				this.properties[ADVANCED_PARAMS_PROP] = false;
			}
			restoreParamValues(this, props);
			stabilizeNode(this);
			refreshStatusFromHelpAndSync(this);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 80);
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const result = originalSerialize?.apply(this, [serializedNode]);
			// 核心数据全部写入 properties（不受 widget 重排和 serialize:false 影响）
			const selected = JSON.stringify(parseSelectedMethods(this));
			const method = GJJ_Utils.getWidget(this, METHOD_WIDGET)?.value || '';
			this.properties = this.properties || {};
			this.properties[SELECTED_METHODS_WIDGET] = selected;
			this.properties[METHOD_WIDGET] = method;
			delete this.properties[STATUS_WIDGET];
			this.properties[ADVANCED_PARAMS_PROP] = isParamsExpanded(this);
			persistParamValues(this, this.properties);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[SELECTED_METHODS_WIDGET] = selected;
				serializedNode.properties[METHOD_WIDGET] = method;
				delete serializedNode.properties[STATUS_WIDGET];
				serializedNode.properties[ADVANCED_PARAMS_PROP] = isParamsExpanded(this);
				persistParamValues(this, serializedNode.properties);
			}
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			stabilizeNode(this);
			return result;
		};
	},

	setup() {
		loadBackendStatusFromHelp().then((statusJson) => {
			for (const node of app.graph?._nodes || []) {
				if (node?.comfyClass === NODE_TYPE) {
					refreshStatusWidgetFromBackendDefault(node, statusJson);
					stabilizeNode(node);
				}
			}
		});
		// 初始化现有节点
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE) {
				stabilizeNode(node);
			}
		}
	},
});

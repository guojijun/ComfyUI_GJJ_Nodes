import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_ComprehensiveMatting";
const METHOD_WIDGET = "matting_method";
const STATUS_WIDGET = "model_status_json";
const SELECTED_METHODS_WIDGET = "selected_methods_json";
const PANEL_WIDGET = "gjj_matting_method_buttons";
const BATCH_INPUT = "batch_image";
const IMAGE_INPUT = "image";
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const HIDDEN_NAMES = new Set([METHOD_WIDGET, STATUS_WIDGET, SELECTED_METHODS_WIDGET]);

const METHODS = [
	{ value: "RMBG2", label: "RMBG2", suffix: "RMBG2", title: "RMBG2 通用背景移除" },
	{ value: "BiRefNet 通用", label: "通用", suffix: "BiRef通用", title: "BiRefNet General 通用抠图" },
	{ value: "BiRefNet 精细", label: "精细", suffix: "BiRef精细", title: "BiRefNet Matting 精细抠图" },
	{ value: "BEN2", label: "BEN2", suffix: "BEN2", title: "BEN2 抠图" },
	{ value: "Inspyrenet", label: "Inspyrenet", suffix: "Inspyrenet", title: "Inspyrenet 抠图" },
];

function refreshNodeSize(node) {
	const width = Math.max(300, Number(node?.size?.[0] || 300));
	const computed = node.computeSize?.();
	node.setSize?.([width, Math.max(120, Number(computed?.[1] || 120))]);
	app.graph?.setDirtyCanvas?.(true, true);
}

function findInput(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.find((input) => input?.name === name) : null;
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

	const batchInput = findInput(node, BATCH_INPUT);
	if (batchInput) {
		batchInput.type = BATCH_IMAGE_TYPE;
		batchInput.name = BATCH_INPUT;
		batchInput.label = "批量图";
		batchInput.localized_name = batchInput.label;
		batchInput.tooltip = "第一路输入。可直接接 GJJ · 批量多图片加载预览器，用同一组抠图参数批量去除背景。";
	}

	const imageInput = findInput(node, IMAGE_INPUT);
	if (imageInput) {
		imageInput.name = IMAGE_INPUT;
		imageInput.type = "IMAGE";
		imageInput.label = "图像";
		imageInput.localized_name = imageInput.label;
		imageInput.tooltip = "兼容普通 IMAGE 或 IMAGE batch；若同时连接 GJJ 批量图片，会排在批量图片之后一起处理。";
	}

	if (batchInput && imageInput) {
		const batchIndex = node.inputs.indexOf(batchInput);
		const imageIndex = node.inputs.indexOf(imageInput);
		if (batchIndex > imageIndex) {
			node.inputs.splice(batchIndex, 1);
			node.inputs.splice(imageIndex, 0, batchInput);
		}
	}
}

function normalizeOutputSlots(node) {
	if (!Array.isArray(node?.outputs)) {
		return;
	}
	while (node.outputs.length > 1) {
		node.removeOutput?.(node.outputs.length - 1);
	}
	if (!node.outputs.length) {
		node.addOutput?.("综合批量图", BATCH_IMAGE_TYPE);
	}
	const output = node.outputs[0];
	output.name = "综合批量图";
	output.label = "综合批量图";
	output.localized_name = "综合批量图";
	output.type = BATCH_IMAGE_TYPE;
	output.tooltip = "把所有已选路线的结果按路线顺序合并成一个 GJJ 专用批量图片输出。";
}

function normalizeSlots(node) {
	normalizeInputSlots(node);
	normalizeOutputSlots(node);
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function compactNode(node) {
	// 标准 GJJ compact 模式：隐藏 → 删除输入槽 → 重排控件 → 刷新尺寸
	GJJ_Utils.hideWidget(GJJ_Utils.getWidget(node, METHOD_WIDGET));
	GJJ_Utils.hideWidget(GJJ_Utils.getWidget(node, STATUS_WIDGET));
	GJJ_Utils.hideWidget(GJJ_Utils.getWidget(node, SELECTED_METHODS_WIDGET));
	// 核心数据通过 onSerialize → properties → onConfigure 保证序列化往返
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_NAMES);
	// 重排控件：gjj_ 前缀排前，隐藏控件排后
	GJJ_Utils.reorderWidgets(node, HIDDEN_NAMES);
	GJJ_Utils.refreshNode(node);
}

function parseStatus(node) {
	const widget = GJJ_Utils.getWidget(node, STATUS_WIDGET);
	if (!widget?.value) {
		return {};
	}
	try {
		return JSON.parse(widget.value);
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
	refreshNodeSize(node);
}

function mountButtons(node) {
	if (node.__gjjMattingButtons || typeof node.addDOMWidget !== "function") {
		compactNode(node);
		normalizeSlots(node);
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

	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", wrap, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [Math.max(300, Number(width || node.size?.[0] || 300)), 62];

	node.__gjjMattingButtons = { widget, wrap, buttons };
	syncButtons(node);
	refreshNodeSize(node);
}

function stabilizeNode(node) {
	compactNode(node);
	normalizeSlots(node);
	mountButtons(node);
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
			stabilizeNode(this);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 80);
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			originalConfigure?.apply(this, args);
			// 从 properties 恢复核心数据（不受 widget 重排影响）
			const props = this.properties || {};
			const selectedWidget = GJJ_Utils.getWidget(this, SELECTED_METHODS_WIDGET);
			if (selectedWidget && props[SELECTED_METHODS_WIDGET]) {
				selectedWidget.value = props[SELECTED_METHODS_WIDGET];
			}
			const methodWidget = GJJ_Utils.getWidget(this, METHOD_WIDGET);
			if (methodWidget && props[METHOD_WIDGET]) {
				methodWidget.value = props[METHOD_WIDGET];
			}
			const statusWidget = GJJ_Utils.getWidget(this, STATUS_WIDGET);
			if (statusWidget && props[STATUS_WIDGET]) {
				statusWidget.value = props[STATUS_WIDGET];
			}
			stabilizeNode(this);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 80);
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const result = originalSerialize?.apply(this, [serializedNode]);
			// 核心数据全部写入 properties（不受 widget 重排和 serialize:false 影响）
			const selected = JSON.stringify(parseSelectedMethods(this));
			const method = GJJ_Utils.getWidget(this, METHOD_WIDGET)?.value || '';
			const status = GJJ_Utils.getWidget(this, STATUS_WIDGET)?.value || '';
			this.properties = this.properties || {};
			this.properties[SELECTED_METHODS_WIDGET] = selected;
			this.properties[METHOD_WIDGET] = method;
			this.properties[STATUS_WIDGET] = status;
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[SELECTED_METHODS_WIDGET] = selected;
				serializedNode.properties[METHOD_WIDGET] = method;
				serializedNode.properties[STATUS_WIDGET] = status;
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
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE) {
				stabilizeNode(node);
			}
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_AudioSilenceTrimmer"]);
const UI_KEY = "gjj_audio_silence_trimmer";
const MAX_DURATION_NAME = "max_duration";
const QUEUE_MODE_NAME = "queue_mode";
const CURRENT_SEGMENT_NAME = "current_segment";
const MODE_BLANK = "空行";
const MODE_INITIAL = "初始";
const MODE_AUTO = "自动";
const NUMBER_SOCKET_TYPE = "INT,FLOAT";
const AUTO_PROPERTY = "gjj_audio_silence_trim_auto_queue";
const AUTO_STOP_REASON_PROPERTY = "gjj_audio_silence_trim_auto_stop_reason";
const QUEUE_DELAY_MS = 800;
let activeAutoNodeId = null;
let activeAutoToken = 0;
let queueTimer = null;
let pendingAutoData = null;
let lastPromptId = null;

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function firstArrayValue(value) {
	return Array.isArray(value) ? value[0] : value;
}

function readUiData(message) {
	const direct = firstArrayValue(message?.[UI_KEY]);
	if (direct && typeof direct === "object") return direct;
	const nested = firstArrayValue(message?.ui?.[UI_KEY]);
	if (nested && typeof nested === "object") return nested;
	return {
		segment_count: firstArrayValue(message?.segment_count ?? message?.ui?.segment_count ?? message?.output?.segment_count),
		segment_index: firstArrayValue(message?.segment_index ?? message?.ui?.segment_index ?? message?.output?.segment_index),
		queue_mode: firstArrayValue(message?.queue_mode ?? message?.ui?.queue_mode ?? message?.output?.queue_mode),
	};
}

function eventPromptId(event) {
	return event?.detail?.prompt_id || null;
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !(promptId && lastPromptId && promptId !== lastPromptId);
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = value;
	if (widget.inputEl) widget.inputEl.value = value;
	if (widget.element && "value" in widget.element) widget.element.value = value;
	widget.callback?.(value);
	node.widgets_values = node.widgets?.map((item) => item.value) || node.widgets_values;
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function inputLinked(node, name) {
	return Boolean((node?.inputs || []).find((input) => inputMatchesName(input, name))?.link);
}

function normalizeSlotName(value) {
	return String(value || "").replace(/^converted-widget:/i, "");
}

function inputMatchesName(input, name) {
	const inputName = normalizeSlotName(input?.name);
	const inputType = normalizeSlotName(input?.type);
	const widgetName = String(input?.widget?.name || input?.widget_name || "");
	return inputName === name || inputType === name || widgetName === name;
}

function findInput(node, name) {
	return node?.inputs?.find((input) => inputMatchesName(input, name));
}

function removeInputAt(node, index) {
	if (!Array.isArray(node?.inputs) || index < 0 || index >= node.inputs.length) return;
	if (node.inputs[index]?.link != null) {
		try { node.disconnectInput?.(index); } catch (_) {}
	}
	try { node.removeInput?.(index); }
	catch (_) { node.inputs.splice(index, 1); }
}

function ensureCurrentSegmentInput(node) {
	if (!node || !Array.isArray(node.inputs)) return;
	let current = findInput(node, CURRENT_SEGMENT_NAME);
	if (!current) {
		node.addInput?.(CURRENT_SEGMENT_NAME, "INT");
		current = node.inputs?.[node.inputs.length - 1] || null;
	}
	if (current) {
		current.name = CURRENT_SEGMENT_NAME;
		current.type = "INT";
		current.label = "当前分段";
		current.localized_name = "当前分段";
		current.display_name = "当前分段";
		current.tooltip = "可外接滑动序号；未外接时由面板数字框或自动队列控制。";
		current.widget = { name: CURRENT_SEGMENT_NAME };
		current.forceInput = false;
		current.hidden = false;
		current.visible = true;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (input === current) continue;
		if (inputMatchesName(input, "slide_start_index")) {
			removeInputAt(node, index);
		}
	}
}

async function queueRun(node) {
	if (typeof app.queuePrompt !== "function") {
		setStatus(node, "当前前端不支持自动排队");
		return;
	}
	try {
		await app.queuePrompt(0);
	} catch (error) {
		console.error("[GJJ] 音频静音修剪自动排队失败:", error);
		stopAuto(node, `自动排队失败：${error?.message || error || "未知错误"}`);
	}
}

function hideWidget(widget, hidden) {
	if (!widget) return;
	widget.options = widget.options || {};
	if (!widget.__gjjOriginalState) {
		widget.__gjjOriginalState = {
			computeSize: widget.computeSize,
			getHeight: widget.getHeight,
			draw: widget.draw,
			mouse: widget.mouse,
			type: widget.type,
		};
	}
	if (hidden) {
		widget.hidden = true;
		widget.disabled = true;
		widget.type = "hidden";
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.computeSize = () => [0, -4];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
	} else {
		const state = widget.__gjjOriginalState;
		widget.hidden = false;
		widget.disabled = false;
		widget.type = state.type || widget.type || "combo";
		widget.computeSize = state.computeSize;
		widget.getHeight = state.getHeight;
		if (state.draw) widget.draw = state.draw;
		else delete widget.draw;
		if (state.mouse) widget.mouse = state.mouse;
		else delete widget.mouse;
		delete widget.options.hidden;
		delete widget.options.display;
	}
}

function makeButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"border:1px solid #345b60",
		"background:#17363a",
		"color:#f0fbf5",
		"border-radius:6px",
		"padding:5px 10px",
		"font-size:13px",
		"font-weight:800",
		"line-height:1.15",
		"cursor:pointer",
		"white-space:nowrap",
		"min-width:72px",
	].join(";");
	button.addEventListener("mousedown", (event) => {
		event.preventDefault();
		event.stopPropagation();
	});
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	return button;
}

function setActive(button, active) {
	if (!button) return;
	button.style.background = active ? "#1c8f56" : "#17363a";
	button.style.borderColor = active ? "#58c27c" : "#345b60";
	button.style.color = active ? "#ffffff" : "#f0fbf5";
}

function setAutoButtonState(node, state) {
	const button = node?.__gjjSilenceTrimAutoBtn;
	if (!button) return;
	if (state === "running") {
		button.style.background = "#1c8f56";
		button.style.borderColor = "#58c27c";
		button.style.color = "#ffffff";
		return;
	}
	if (state === "stopped") {
		button.style.background = "#6f4b19";
		button.style.borderColor = "#bd8b35";
		button.style.color = "#fff4dc";
		return;
	}
	setActive(button, false);
}

function setStatus(node, text) {
	if (node?.__gjjSilenceTrimStatus) {
		node.__gjjSilenceTrimStatus.textContent = text || "等待执行";
	}
}

function isAutoRunning(node) {
	return Boolean(
		node?.properties?.[AUTO_PROPERTY]
		&& activeAutoNodeId === String(node.id)
		&& node.__gjjSilenceTrimAutoToken === activeAutoToken
	);
}

function updateToolbar(node) {
	if (!node) return;
	hideWidget(getWidget(node, QUEUE_MODE_NAME), true);
	hideWidget(getWidget(node, CURRENT_SEGMENT_NAME), false);
	ensureCurrentSegmentInput(node);
	const external = inputLinked(node, CURRENT_SEGMENT_NAME);
	const mode = getWidget(node, QUEUE_MODE_NAME)?.value || MODE_AUTO;
	const autoRunning = isAutoRunning(node) && !external;
	const autoStopped = Boolean(node.properties?.[AUTO_STOP_REASON_PROPERTY]) && !autoRunning && !external;
	const currentValue = Math.max(1, Number(getWidget(node, CURRENT_SEGMENT_NAME)?.value || 1));
	setActive(node.__gjjSilenceTrimBlankBtn, mode === MODE_BLANK && !external);
	setActive(node.__gjjSilenceTrimInitialBtn, mode === MODE_INITIAL && !external);
	setAutoButtonState(node, autoRunning ? "running" : (autoStopped ? "stopped" : "idle"));
	if (node.__gjjSilenceTrimAutoBtn) {
		node.__gjjSilenceTrimAutoBtn.textContent = autoRunning ? "■ 自动" : "▶ 自动";
		node.__gjjSilenceTrimAutoBtn.title = autoRunning
			? "停止自动队列"
			: (autoStopped ? `自动已关闭：${node.properties?.[AUTO_STOP_REASON_PROPERTY] || ""}` : "从当前分段开始自动排队执行");
	}
	for (const button of [node.__gjjSilenceTrimBlankBtn, node.__gjjSilenceTrimInitialBtn, node.__gjjSilenceTrimAutoBtn]) {
		if (!button) continue;
		button.disabled = external;
		button.style.opacity = external ? "0.58" : "1";
	}
	if (external) {
		setStatus(node, "外接当前分段已接管");
	} else if (!node.__gjjSilenceTrimExecuted) {
		setStatus(node, `当前：${mode} ｜ 第 ${currentValue} 段`);
	}
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function stopAuto(node, reason = "自动队列已停止") {
	activeAutoToken += 1;
	if (queueTimer) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
	if (activeAutoNodeId === String(node?.id)) {
		activeAutoNodeId = null;
	}
	if (!node || pendingAutoData?.node === node) {
		pendingAutoData = null;
	}
	node.properties = node.properties || {};
	node.properties[AUTO_PROPERTY] = false;
	node.properties[AUTO_STOP_REASON_PROPERTY] = reason;
	delete node.__gjjSilenceTrimAutoToken;
	setStatus(node, reason);
	updateToolbar(node);
}

function startAuto(node) {
	if (inputLinked(node, CURRENT_SEGMENT_NAME)) {
		stopAuto(node, "外接当前分段已接管");
		return;
	}
	node.properties = node.properties || {};
	if (queueTimer) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
	node.properties[AUTO_PROPERTY] = true;
	delete node.properties[AUTO_STOP_REASON_PROPERTY];
	activeAutoToken += 1;
	node.__gjjSilenceTrimAutoToken = activeAutoToken;
	activeAutoNodeId = String(node.id);
	pendingAutoData = null;
	setWidgetValue(node, QUEUE_MODE_NAME, MODE_AUTO);
	setWidgetValue(node, CURRENT_SEGMENT_NAME, Math.max(1, Number(getWidget(node, CURRENT_SEGMENT_NAME)?.value || 1)));
	node.__gjjSilenceTrimExecuted = false;
	setStatus(node, `自动队列启动：第 ${getWidget(node, CURRENT_SEGMENT_NAME)?.value || 1} 段`);
	updateToolbar(node);
	queueRun(node);
}

function queueNextIfNeeded(node, count, index, token) {
	if (!node || !node.properties?.[AUTO_PROPERTY] || activeAutoNodeId !== String(node.id) || token !== activeAutoToken || token !== node.__gjjSilenceTrimAutoToken) {
		return;
	}
	if (inputLinked(node, CURRENT_SEGMENT_NAME)) {
		stopAuto(node, "外接当前分段已接管，自动队列停止");
		return;
	}
	const total = Math.max(0, Math.floor(Number(count) || 0));
	const current = Math.max(0, Math.floor(Number(index) || 0));
	const next = current + 1;
	if (total <= 0) {
		stopAuto(node, "没有可执行的分段");
		return;
	}
	if (next > total) {
		setWidgetValue(node, CURRENT_SEGMENT_NAME, 1);
		stopAuto(node, "自动队列完成");
		return;
	}
	setWidgetValue(node, CURRENT_SEGMENT_NAME, next);
	setStatus(node, `已完成 ${current} / ${total}，下一段 ${next} / ${total}，${QUEUE_DELAY_MS}ms 后继续`);
	if (queueTimer) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
	queueTimer = setTimeout(async () => {
		queueTimer = null;
		if (!node.properties?.[AUTO_PROPERTY] || activeAutoNodeId !== String(node.id) || token !== activeAutoToken || token !== node.__gjjSilenceTrimAutoToken) {
			return;
		}
		if (inputLinked(node, CURRENT_SEGMENT_NAME)) {
			stopAuto(node, "外接当前分段已接管，自动队列停止");
			return;
		}
		await queueRun(node);
	}, QUEUE_DELAY_MS);
}

function queuePendingAfterWorkflow(reason = "执行完成") {
	const data = pendingAutoData;
	if (!data?.node) {
		return;
	}
	pendingAutoData = null;
	if (activeAutoNodeId !== String(data.node.id) || data.token !== activeAutoToken || data.token !== data.node.__gjjSilenceTrimAutoToken || !data.node.properties?.[AUTO_PROPERTY]) {
		return;
	}
	setStatus(data.node, `${reason}，准备推进分段`);
	queueNextIfNeeded(data.node, data.count, data.index, data.token);
}

function ensureToolbar(node) {
	if (!node || node.__gjjSilenceTrimToolbar) {
		updateToolbar(node);
		return;
	}
	const row = document.createElement("div");
	row.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:2px 0 0;overflow:hidden;";
	const buttonRow = document.createElement("div");
	buttonRow.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:nowrap;overflow:hidden;";

	node.__gjjSilenceTrimBlankBtn = makeButton("🧹 空行", "输出一个静音占位段", () => {
		if (isAutoRunning(node) || node.properties?.[AUTO_PROPERTY]) stopAuto(node, "自动队列已停止");
		delete node.properties?.[AUTO_STOP_REASON_PROPERTY];
		setWidgetValue(node, QUEUE_MODE_NAME, MODE_BLANK);
		updateToolbar(node);
	});
	node.__gjjSilenceTrimInitialBtn = makeButton("░ 初始", "只输出第一段，方便先预览", () => {
		if (isAutoRunning(node) || node.properties?.[AUTO_PROPERTY]) stopAuto(node, "自动队列已停止");
		delete node.properties?.[AUTO_STOP_REASON_PROPERTY];
		setWidgetValue(node, QUEUE_MODE_NAME, MODE_INITIAL);
		updateToolbar(node);
	});
	node.__gjjSilenceTrimAutoBtn = makeButton("▶ 自动", "输出完整分段队列，让后续节点自动逐段执行", () => {
		if (isAutoRunning(node)) stopAuto(node);
		else startAuto(node);
	});
	const status = document.createElement("span");
	status.style.cssText = "display:block;font-size:12px;color:#b8cac6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:16px;max-width:100%;";
	node.__gjjSilenceTrimStatus = status;
	buttonRow.append(node.__gjjSilenceTrimBlankBtn, node.__gjjSilenceTrimInitialBtn, node.__gjjSilenceTrimAutoBtn);
	row.append(buttonRow, status);

	const widget = node.addDOMWidget?.("gjj_silence_trim_queue_toolbar", "HTML", row, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 50,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(280, width || 280), 50];
	}
	node.__gjjSilenceTrimToolbar = widget || { element: row };
	updateToolbar(node);
}

function patchNode(node) {
	if (!node || node.__gjjSilenceTrimPatched) {
		updateToolbar(node);
		return;
	}
	node.__gjjSilenceTrimPatched = true;
	node.properties = node.properties || {};
	ensureCurrentSegmentInput(node);
	ensureToolbar(node);
	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = originalExecuted?.apply(this, arguments);
		const data = readUiData(message);
		const count = Number(data?.segment_count || 0);
		const index = Number(data?.segment_index || getWidget(this, CURRENT_SEGMENT_NAME)?.value || 1);
		this.__gjjSilenceTrimExecuted = true;
		setStatus(this, count > 0 ? `当前分段：${index} / ${count}` : "当前分段：0 / 0");
		const token = this.__gjjSilenceTrimAutoToken;
		const autoActive = Boolean(isAutoRunning(this) && token === activeAutoToken);
		if (autoActive) {
			updateToolbar(this);
			pendingAutoData = { node: this, count, index, token };
			setStatus(this, count > 0 ? `当前分段：${index} / ${count}，等待当前工作流结束` : "当前分段：0 / 0");
		}
		return result;
	};
	const widget = getWidget(node, QUEUE_MODE_NAME);
	if (widget && !widget.__gjjSilenceTrimCallbackPatched) {
		const original = widget.callback;
		widget.callback = function (...args) {
			const result = original?.apply(this, args);
			setTimeout(() => updateToolbar(node), 0);
			return result;
		};
		widget.__gjjSilenceTrimCallbackPatched = true;
	}
	const currentWidget = getWidget(node, CURRENT_SEGMENT_NAME);
	if (currentWidget && !currentWidget.__gjjSilenceTrimCallbackPatched) {
		const original = currentWidget.callback;
		currentWidget.callback = function (...args) {
			const result = original?.apply(this, args);
			node.__gjjSilenceTrimExecuted = false;
			setTimeout(() => updateToolbar(node), 0);
			return result;
		};
		currentWidget.__gjjSilenceTrimCallbackPatched = true;
	}
	updateToolbar(node);
}

function normalizeMaxDurationInput(node) {
	for (const input of node?.inputs || []) {
		const name = String(input?.name || "");
		const widgetName = String(input?.widget?.name || "");
		if (name !== MAX_DURATION_NAME && widgetName !== MAX_DURATION_NAME) continue;
		input.type = NUMBER_SOCKET_TYPE;
		input.label = "最长保留时长";
		input.localized_name = "最长保留时长";
		input.tooltip = "0 表示不限；前方接口支持连接 INT 或 FLOAT。";
	}
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function clearLoadedAutoState(node) {
	if (!node) return;
	if (queueTimer && activeAutoNodeId === String(node.id)) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
	if (activeAutoNodeId === String(node.id)) {
		activeAutoNodeId = null;
	}
	if (pendingAutoData?.node === node) {
		pendingAutoData = null;
	}
	node.properties = node.properties || {};
	delete node.properties[AUTO_STOP_REASON_PROPERTY];
	delete node.__gjjSilenceTrimAutoToken;
	clearTimeout(node.__gjjSilenceTrimAutoResumeTimer);
	delete node.__gjjSilenceTrimAutoResumeTimer;
}

function armAutoForManualRun(node) {
	if (!node?.properties?.[AUTO_PROPERTY] || isAutoRunning(node)) return false;
	if (node.properties?.[AUTO_STOP_REASON_PROPERTY] || inputLinked(node, CURRENT_SEGMENT_NAME)) return false;
	if (queueTimer) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
	activeAutoToken += 1;
	node.__gjjSilenceTrimAutoToken = activeAutoToken;
	activeAutoNodeId = String(node.id);
	pendingAutoData = null;
	node.__gjjSilenceTrimExecuted = false;
	setWidgetValue(node, QUEUE_MODE_NAME, MODE_AUTO);
	setStatus(node, `自动队列待续跑：第 ${getWidget(node, CURRENT_SEGMENT_NAME)?.value || 1} 段`);
	updateToolbar(node);
	return true;
}

function armFirstAutoNodeForManualRun() {
	if (activeAutoNodeId) return;
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) continue;
		if (armAutoForManualRun(node)) return;
	}
}

function scheduleNormalize(node, delay = 0) {
	setTimeout(() => {
		normalizeMaxDurationInput(node);
		patchNode(node);
	}, delay);
}

app.registerExtension({
	name: "Comfy.GJJ.AudioSilenceTrimmer",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleNormalize(this, 0);
			scheduleNormalize(this, 80);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			clearLoadedAutoState(this);
			scheduleNormalize(this, 0);
			scheduleNormalize(this, 80);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			if (inputLinked(this, CURRENT_SEGMENT_NAME) && this.properties?.[AUTO_PROPERTY]) {
				stopAuto(this, "外接当前分段已接管，自动队列停止");
			}
			scheduleNormalize(this, 16);
			setTimeout(() => updateToolbar(this), 32);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				normalizeMaxDurationInput(node);
				patchNode(node);
			}
		}
	},
});

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
	armFirstAutoNodeForManualRun();
	if (!activeAutoNodeId) {
		pendingAutoData = null;
	}
	if (queueTimer) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
});

api.addEventListener("execution_success", (event) => {
	if (!activeAutoNodeId || !samePrompt(event)) {
		pendingAutoData = null;
		return;
	}
	queuePendingAfterWorkflow("执行完成");
});

api.addEventListener("execution_error", (event) => {
	if (!activeAutoNodeId || !samePrompt(event)) {
		pendingAutoData = null;
		return;
	}
	const node = pendingAutoData?.node || app.graph?.getNodeById?.(activeAutoNodeId);
	if (node) {
		stopAuto(node, "执行出错，自动队列停止");
	}
	pendingAutoData = null;
});

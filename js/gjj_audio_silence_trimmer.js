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
const INTERFACES_PROPERTY = "gjj_audio_silence_trim_interfaces";
const OUTPUT_ORDER_PROPERTY = "gjj_audio_silence_trim_output_order";
const OUTPUT_STORAGE_NAME = "output_order_json";
const OUTPUT_DEFS = [
	{ key: "segment_audio", name: "分段音频", type: "AUDIO" },
	{ key: "segment_count", name: "分段总数", type: "INT" },
	{ key: "segment_index", name: "当前分段序号", type: "INT" },
	{ key: "background_audio", name: "分段背景声", type: "AUDIO" },
];
const PARAMETER_NAMES = ["threshold_db", "min_silence_duration", "keep_silence", "max_duration", "fade_duration", "current_segment", "fps"];
const PARAMETER_LABELS = {
	threshold_db: "静音阈值 dB", min_silence_duration: "最短静音秒", keep_silence: "保留静音秒",
	max_duration: "最长保留时长", fade_duration: "交叉淡化秒", current_segment: "当前分段", fps: "帧率",
};
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

function readOutputOrder(node, serialized = null) {
	node.properties ||= {};
	let order = node.properties[OUTPUT_ORDER_PROPERTY];
	if (serialized?.outputs?.length) {
		const byName = {
			"分段总数": "segment_count", "当前分段音频": "segment_audio", "分段音频": "segment_audio",
			"当前分段序号": "segment_index", "当前分段背景声": "background_audio", "分段背景声": "background_audio",
		};
		const restored = serialized.outputs.map((output) => byName[output?.name]).filter(Boolean);
		if (restored.length) order = restored;
	}
	if (!Array.isArray(order)) {
		try { order = JSON.parse(String(getWidget(node, OUTPUT_STORAGE_NAME)?.value || "[]")); } catch (_) { order = []; }
	}
	order = [...new Set((order || []).filter((key) => OUTPUT_DEFS.some((def) => def.key === key)))];
	if (!order.length) order = ["segment_audio"];
	node.properties[OUTPUT_ORDER_PROPERTY] = order;
	return order;
}

function applyOutputs(node, serialized = null) {
	const order = readOutputOrder(node, serialized);
	const targets = order.map((key) => OUTPUT_DEFS.find((def) => def.key === key)).filter(Boolean);
	for (let index = (node.outputs || []).length - 1; index >= targets.length; index -= 1) {
		if (node.outputs[index]?.links?.length) continue;
		node.removeOutput?.(index);
	}
	while ((node.outputs || []).length < targets.length) {
		const def = targets[node.outputs.length];
		node.addOutput?.(def.name, def.type);
	}
	targets.forEach((def, index) => {
		const output = node.outputs?.[index];
		if (!output) return;
		output.name = output.label = output.localized_name = def.name;
		output.type = def.type;
	});
	setWidgetValue(node, OUTPUT_STORAGE_NAME, JSON.stringify(order));
}

function enabledInterfaces(node, serialized = null) {
	node.properties ||= {};
	let values = node.properties[INTERFACES_PROPERTY];
	if (!Array.isArray(values)) values = [];
	if (serialized?.inputs?.length) {
		for (const input of serialized.inputs) {
			if (["current_segment", "background_audio"].includes(input?.name) && !values.includes(input.name)) values.push(input.name);
		}
	}
	node.properties[INTERFACES_PROPERTY] = [...new Set(values)];
	return node.properties[INTERFACES_PROPERTY];
}

function syncOptionalInputs(node, serialized = null) {
	const enabled = enabledInterfaces(node, serialized);
	for (const name of ["current_segment", "background_audio"]) {
		let input = findInput(node, name);
		const linked = Boolean(input?.link);
		if (enabled.includes(name) || linked) {
			if (!input) node.addInput?.(name, name === "background_audio" ? "AUDIO" : "INT");
			input = findInput(node, name);
			if (input && name === "background_audio") {
				input.label = input.localized_name = "背景声";
				input.type = "AUDIO";
			}
		} else if (input) {
			removeInputAt(node, node.inputs.indexOf(input));
		}
	}
}

function ensureCurrentSegmentInput(node) {
	if (!node || !Array.isArray(node.inputs)) return;
	let current = findInput(node, CURRENT_SEGMENT_NAME);
	if (!enabledInterfaces(node).includes(CURRENT_SEGMENT_NAME) && !current?.link) {
		if (current) removeInputAt(node, node.inputs.indexOf(current));
		return;
	}
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
	hideWidget(getWidget(node, CURRENT_SEGMENT_NAME), true);
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

function closePopup(node, key) {
	const popup = node?.[key];
	if (popup) popup.remove();
	if (node) node[key] = null;
}

function popupBox(title) {
	const popup = document.createElement("div");
	popup.style.cssText = "position:fixed;z-index:100000;width:340px;max-width:calc(100vw - 16px);padding:9px;border:1px solid #526873;border-radius:8px;background:#10171b;box-shadow:0 12px 28px #0008;color:#dce7e2;font:12px/1.35 system-ui,'Microsoft YaHei',sans-serif";
	const heading = document.createElement("div");
	heading.textContent = title;
	heading.style.cssText = "font-weight:700;margin-bottom:7px;color:#edf7fb";
	popup.append(heading);
	for (const event of ["mousedown", "pointerdown"]) popup.addEventListener(event, (e) => e.stopPropagation());
	return popup;
}

function showPopup(popup, anchor) {
	document.body.append(popup);
	const rect = anchor.getBoundingClientRect();
	popup.style.left = `${Math.min(innerWidth - popup.offsetWidth - 8, Math.max(8, rect.left))}px`;
	popup.style.top = `${Math.min(innerHeight - popup.offsetHeight - 8, Math.max(8, rect.bottom + 6))}px`;
}

function toggleSettings(node, anchor) {
	if (node.__gjjSilenceSettingsPopup) return closePopup(node, "__gjjSilenceSettingsPopup");
	closePopup(node, "__gjjSilenceInterfacesPopup");
	const popup = popupBox("音频静音修剪参数");
	for (const name of PARAMETER_NAMES) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		const row = document.createElement("label");
		row.style.cssText = "display:flex;align-items:center;gap:8px;margin:6px 0";
		const label = document.createElement("span");
		label.textContent = PARAMETER_LABELS[name] || name;
		label.style.cssText = "width:92px;color:#c9d6dc";
		const input = document.createElement("input");
		input.type = "number";
		input.value = String(widget.value ?? "");
		if (widget.options?.min != null) input.min = widget.options.min;
		if (widget.options?.max != null) input.max = widget.options.max;
		if (widget.options?.step != null) input.step = widget.options.step;
		input.style.cssText = "flex:1;min-width:0;padding:5px 7px;border:1px solid #41535b;border-radius:5px;background:#202a30;color:#eef7fa";
		input.onchange = () => setWidgetValue(node, name, Number(input.value));
		row.append(label, input);
		popup.append(row);
	}
	node.__gjjSilenceSettingsPopup = popup;
	showPopup(popup, anchor);
}

function toggleInterfaces(node, anchor) {
	if (node.__gjjSilenceInterfacesPopup) return closePopup(node, "__gjjSilenceInterfacesPopup");
	closePopup(node, "__gjjSilenceSettingsPopup");
	const popup = popupBox("输入 / 输出接口");
	const addToggle = (labelText, checked, disabled, onChange) => {
		const row = document.createElement("label");
		row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer";
		const check = document.createElement("input");
		check.type = "checkbox";
		check.checked = checked;
		check.disabled = disabled;
		check.onchange = () => onChange(check);
		row.append(check, document.createTextNode(labelText));
		popup.append(row);
	};
	const interfaces = enabledInterfaces(node);
	addToggle("输入：音频（默认）", true, true, () => {});
	for (const [name, label] of [["current_segment", "输入：当前分段"], ["background_audio", "输入：背景声"]]) {
		addToggle(label, interfaces.includes(name), false, (check) => {
			const next = enabledInterfaces(node).filter((item) => item !== name);
			if (check.checked) next.push(name);
			node.properties[INTERFACES_PROPERTY] = next;
			syncOptionalInputs(node);
			updateToolbar(node);
		});
	}
	const order = readOutputOrder(node);
	for (const def of OUTPUT_DEFS) {
		addToggle(`输出：${def.name}`, order.includes(def.key), def.key === "segment_audio", (check) => {
			const current = readOutputOrder(node);
			const index = current.indexOf(def.key);
			if (!check.checked && (node.outputs || []).some((output, slot) => slot >= index && output.links?.length)) {
				check.checked = true;
				return;
			}
			let next = current.filter((key) => key !== def.key);
			if (check.checked) next.push(def.key);
			node.properties[OUTPUT_ORDER_PROPERTY] = OUTPUT_DEFS.map((item) => item.key).filter((key) => next.includes(key));
			applyOutputs(node);
			node.graph?.change?.();
		});
	}
	node.__gjjSilenceInterfacesPopup = popup;
	showPopup(popup, anchor);
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
	node.__gjjSilenceTrimInterfacesBtn = makeButton("🔌", "管理输入与输出接口", () => toggleInterfaces(node, node.__gjjSilenceTrimInterfacesBtn));
	node.__gjjSilenceTrimSettingsBtn = makeButton("⚙️", "显示参数", () => toggleSettings(node, node.__gjjSilenceTrimSettingsBtn));
	node.__gjjSilenceTrimInterfacesBtn.style.minWidth = "34px";
	node.__gjjSilenceTrimSettingsBtn.style.minWidth = "34px";
	const status = document.createElement("span");
	status.style.cssText = "display:block;font-size:12px;color:#b8cac6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:16px;max-width:100%;";
	node.__gjjSilenceTrimStatus = status;
	buttonRow.append(node.__gjjSilenceTrimBlankBtn, node.__gjjSilenceTrimInitialBtn, node.__gjjSilenceTrimAutoBtn, node.__gjjSilenceTrimInterfacesBtn, node.__gjjSilenceTrimSettingsBtn);
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

function patchNode(node, serialized = null) {
	if (!node || node.__gjjSilenceTrimPatched) {
		syncOptionalInputs(node, serialized);
		applyOutputs(node, serialized);
		updateToolbar(node);
		return;
	}
	node.__gjjSilenceTrimPatched = true;
	node.properties = node.properties || {};
	syncOptionalInputs(node, serialized);
	applyOutputs(node, serialized);
	for (const name of [...PARAMETER_NAMES, QUEUE_MODE_NAME, OUTPUT_STORAGE_NAME]) hideWidget(getWidget(node, name), true);
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

function scheduleNormalize(node, delay = 0, serialized = null) {
	setTimeout(() => {
		normalizeMaxDurationInput(node);
		patchNode(node, serialized);
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
		nodeType.prototype.onConfigure = function (data, ...args) {
			const result = originalOnConfigure?.apply(this, [data, ...args]);
			clearLoadedAutoState(this);
			scheduleNormalize(this, 0, data);
			scheduleNormalize(this, 80, data);
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

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (...args) {
			setWidgetValue(this, OUTPUT_STORAGE_NAME, JSON.stringify(readOutputOrder(this)));
			return originalOnSerialize?.apply(this, args);
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

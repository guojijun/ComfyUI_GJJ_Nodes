import { app } from "/scripts/app.js";

const api = window.comfyAPI?.api?.api || window.api;
const TARGET = "GJJ_AudioSmartSegmenter";
const MODE_SILENCE = "静音分段";
const MODE_PARAGRAPH = "文本段落";
const ALIGN_COMPAT = "最大兼容(按比例)";
const ALIGN_WHISPER = "Whisper对齐(可选)";
const AUTO_PROPERTY = "gjj_audio_segment_auto";
const PANEL_MIN_HEIGHT = 34;
const VISIBLE_WIDGET_TYPES = {
	paragraph_text: "customtext",
	whisper_model: "combo",
	max_length_s: "number",
	silence_thresh_db: "number",
	min_silence_ms: "number",
	keep_silence_ms: "number",
	target_sample_rate: "number",
	index: "number",
};
let activeRun = null;

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = value;
	if (widget.inputEl) widget.inputEl.value = value;
	if (widget.element && "value" in widget.element) widget.element.value = value;
	widget.callback?.(value);
	node.widgets_values = node.widgets?.map((item) => item.value) || node.widgets_values;
	app.graph?.setDirtyCanvas?.(true, true);
}

function inputLinked(node, name) {
	return Boolean((node.inputs || []).find((input) => input?.name === name)?.link);
}

function makeButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"border:1px solid #42565f",
		"background:#172026",
		"color:#dce7e2",
		"border-radius:6px",
		"padding:4px 6px",
		"font-size:12px",
		"font-weight:700",
		"cursor:pointer",
		"white-space:nowrap",
		"line-height:1.15",
		"min-width:0",
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
	button.style.background = active ? "#1f6b43" : "#172026";
	button.style.borderColor = active ? "#61b27f" : "#42565f";
	button.style.color = active ? "#ffffff" : "#dce7e2";
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
			hidden: widget.hidden,
			disabled: widget.disabled,
			optionsHidden: widget.options.hidden,
			optionsDisplay: widget.options.display,
		};
	}
	widget.hidden = Boolean(hidden);
	if (hidden) {
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
		widget.type = state.type && state.type !== "hidden" ? state.type : (VISIBLE_WIDGET_TYPES[widget.name] || state.type || "text");
		widget.computeSize = state.computeSize;
		widget.getHeight = state.getHeight;
		if (state.draw) widget.draw = state.draw;
		else delete widget.draw;
		if (state.mouse) widget.mouse = state.mouse;
		else delete widget.mouse;
		delete widget.options.hidden;
		delete widget.options.display;
	}
	if (widget.inputEl) widget.inputEl.style.display = hidden ? "none" : "";
	if (widget.element) widget.element.style.display = hidden ? "none" : "";
}

function scheduleStabilize(node, ms = 32) {
	if (!node) return;
	clearTimeout(node.__gjjAudioSegStabilizeTimer);
	node.__gjjAudioSegStabilizeTimer = setTimeout(() => updateVisibility(node), ms);
}

function showButton(button, visible) {
	if (!button) return;
	button.style.display = visible ? "" : "none";
}

function updateVisibility(node) {
	const mode = getWidget(node, "mode")?.value || MODE_SILENCE;
	const align = getWidget(node, "paragraph_align")?.value || ALIGN_COMPAT;
	const paragraph = mode === MODE_PARAGRAPH;
	for (const name of ["mode", "paragraph_align", "media_path"]) {
		hideWidget(getWidget(node, name), true);
	}
	for (const name of ["max_length_s", "silence_thresh_db", "min_silence_ms", "keep_silence_ms"]) {
		hideWidget(getWidget(node, name), paragraph);
	}
	for (const name of ["paragraph_text"]) {
		hideWidget(getWidget(node, name), !paragraph);
	}
	hideWidget(getWidget(node, "whisper_model"), !paragraph || align !== ALIGN_WHISPER);
	setActive(node.__gjjAudioSegSilenceBtn, mode === MODE_SILENCE);
	setActive(node.__gjjAudioSegParagraphBtn, mode === MODE_PARAGRAPH);
	if (node.__gjjAudioSegCompatBtn) setActive(node.__gjjAudioSegCompatBtn, align === ALIGN_COMPAT);
	if (node.__gjjAudioSegWhisperBtn) setActive(node.__gjjAudioSegWhisperBtn, align === ALIGN_WHISPER);
	showButton(node.__gjjAudioSegCompatBtn, paragraph);
	showButton(node.__gjjAudioSegWhisperBtn, paragraph);
	const externalIndex = inputLinked(node, "index");
	if (node.__gjjAudioSegAutoBtn) {
		const enabled = Boolean(node.properties?.[AUTO_PROPERTY]) && !externalIndex;
		node.__gjjAudioSegAutoBtn.textContent = enabled ? "▶ 自动开" : (externalIndex ? "🔌 外接" : "▶ 自动关");
		setActive(node.__gjjAudioSegAutoBtn, enabled);
		node.__gjjAudioSegAutoBtn.disabled = externalIndex;
		node.__gjjAudioSegAutoBtn.style.opacity = externalIndex ? "0.58" : "1";
	}
	clearDependencyWarning(node);
	measurePanel(node);
	app.graph?.setDirtyCanvas?.(true, true);
}

function setStatus(node, text) {
	if (node.__gjjAudioSegStatus) {
		node.__gjjAudioSegStatus.textContent = text || "等待执行";
	}
}

function isWhisperAlignActive(node) {
	const mode = getWidget(node, "mode")?.value || MODE_SILENCE;
	const align = getWidget(node, "paragraph_align")?.value || ALIGN_COMPAT;
	return mode === MODE_PARAGRAPH && align === ALIGN_WHISPER;
}

function clearNodeErrorContainer(container, node) {
	if (!container || !node) return;
	const keys = [node.id, String(node.id)];
	if (container instanceof Map) {
		for (const key of keys) container.delete(key);
		return;
	}
	if (container instanceof Set) {
		for (const key of keys) container.delete(key);
		container.delete(node);
		return;
	}
	if (Array.isArray(container)) {
		for (let index = container.length - 1; index >= 0; index -= 1) {
			const item = container[index];
			if (item === node || keys.includes(item) || keys.includes(item?.node_id) || keys.includes(item?.node)) {
				container.splice(index, 1);
			}
		}
		return;
	}
	if (typeof container === "object") {
		for (const key of keys) {
			try { delete container[key]; } catch (_) {}
		}
	}
}

function clearCachedNodeErrors(node) {
	const holders = [app, app?.graph, app?.canvas, app?.ui];
	const names = [
		"node_errors",
		"nodeErrors",
		"last_node_errors",
		"lastNodeErrors",
		"execution_errors",
		"executionErrors",
		"lastExecutionErrors",
		"validation_errors",
		"validationErrors",
		"invalid_nodes",
		"invalidNodes",
		"error_nodes",
		"errorNodes",
	];
	for (const holder of holders) {
		if (!holder) continue;
		for (const name of names) clearNodeErrorContainer(holder[name], node);
	}
}

function clearDependencyWarning(node, { clearExecutionError = true } = {}) {
	if (!node || isWhisperAlignActive(node)) return;
	try {
		globalThis.GJJ_CommonDependencyModelNotice?.applyNotice?.(node, {
			warning_message: "",
			panel_message: "",
			copy_text: "",
			copy_label: "",
			notice_level: "",
		});
	} catch (_) {}
	const notice = node.__gjjDependencyNotice;
	if (notice?.root) notice.root.style.display = "none";
	if (notice?.message) notice.message.textContent = "";
	if (notice?.button) notice.button.style.display = "none";
	if (clearExecutionError) {
		for (const key of ["last_error", "execution_error", "error_message", "error", "errors"]) {
			try {
				if (key in node) node[key] = null;
			} catch (_) {}
		}
		if (node.flags) {
			delete node.flags.error;
			delete node.flags.has_errors;
		}
		clearCachedNodeErrors(node);
	}
}

function measurePanel(node) {
	const widget = node.__gjjAudioSegPanel;
	const container = widget?.element || widget;
	if (!container) return;
	clearTimeout(node.__gjjAudioSegMeasureTimer);
	node.__gjjAudioSegMeasureTimer = setTimeout(() => {
		requestAnimationFrame(() => {
			container.style.height = "auto";
			const height = Math.max(PANEL_MIN_HEIGHT, Math.ceil(container.scrollHeight || PANEL_MIN_HEIGHT) + 2);
			node.__gjjAudioSegPanelHeight = height;
			app.graph?.setDirtyCanvas?.(true, true);
		});
	}, 20);
}

async function queueRun(node) {
	if (typeof app.queuePrompt !== "function") {
		setStatus(node, "当前前端不支持自动排队");
		return;
	}
	await app.queuePrompt(0);
}

async function uploadDiskMedia(file) {
	if (!file) return null;
	const form = new FormData();
	form.append("image", file, file.name);
	form.append("type", "input");
	form.append("overwrite", "true");
	let response = null;
	if (api?.fetchApi) response = await api.fetchApi("/upload/image", { method: "POST", body: form });
	else response = await fetch("/upload/image", { method: "POST", body: form });
	if (!response?.ok) {
		let text = "";
		try { text = await response.text(); } catch (_) {}
		throw new Error(`上传失败：HTTP ${response?.status || "?"} ${text}`);
	}
	let data = null;
	try { data = await response.json(); } catch (_) {}
	return data?.name || data?.filename || file.name;
}

function openDiskMedia(node) {
	if (!node.__gjjAudioSegFileInput) return;
	const input = node.__gjjAudioSegFileInput;
	input.value = "";
	input.onchange = async () => {
		const file = input.files?.[0];
		if (!file) return;
		try {
			node.__gjjAudioSegPathBtn.disabled = true;
			node.__gjjAudioSegPathBtn.textContent = "⏳";
			setStatus(node, `正在上传：${file.name}`);
			const filename = await uploadDiskMedia(file);
			if (!filename) throw new Error("上传成功但没有返回文件名");
			setWidgetValue(node, "media_path", filename);
			setStatus(node, `已选择：${filename}`);
		} catch (err) {
			console.error("[GJJ] 打开音视频文件失败:", err);
			setStatus(node, `打开失败：${err?.message || err}`);
		} finally {
			setTimeout(() => {
				node.__gjjAudioSegPathBtn.textContent = "📁 路径";
				node.__gjjAudioSegPathBtn.disabled = false;
			}, 350);
		}
	};
	input.click();
}

function stopAuto(node, reason = "自动运行已停止") {
	if (activeRun?.node === node) activeRun = null;
	node.properties = node.properties || {};
	node.properties[AUTO_PROPERTY] = false;
	setStatus(node, reason);
	updateVisibility(node);
}

function startAuto(node) {
	if (inputLinked(node, "index")) {
		stopAuto(node, "外部 index 已连接，自动运行让位给外部调度");
		return;
	}
	node.properties = node.properties || {};
	node.properties[AUTO_PROPERTY] = true;
	activeRun = { node, running: true };
	setWidgetValue(node, "index", 1);
	setStatus(node, "自动运行从 index 1 开始");
	updateVisibility(node);
	queueRun(node);
}

function ensurePanel(node) {
	if (node.__gjjAudioSegPanel) {
		updateVisibility(node);
		return;
	}
	const container = document.createElement("div");
	container.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:2px 0 0;color:#dce7e2;overflow:visible;";
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "audio/*,video/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus,.wma,.aiff,.aif,.mp4,.mov,.mkv,.avi,.webm,.m4v,.flv,.wmv,.mpeg,.mpg";
	fileInput.style.display = "none";
	container.appendChild(fileInput);
	node.__gjjAudioSegFileInput = fileInput;
	const buttonRow = document.createElement("div");
	buttonRow.style.cssText = "display:flex;gap:5px;flex-wrap:nowrap;align-items:center;overflow:hidden;";
	node.__gjjAudioSegSilenceBtn = makeButton("🔇 静音", "按静音和最大长度切分", () => {
		setWidgetValue(node, "mode", MODE_SILENCE);
		updateVisibility(node);
	});
	node.__gjjAudioSegParagraphBtn = makeButton("📝 文本", "按文本段落切分", () => {
		setWidgetValue(node, "mode", MODE_PARAGRAPH);
		updateVisibility(node);
	});
	node.__gjjAudioSegCompatBtn = makeButton("🧩 兼容", "无额外依赖，按段落字数比例切分", () => {
		setWidgetValue(node, "paragraph_align", ALIGN_COMPAT);
		updateVisibility(node);
	});
	node.__gjjAudioSegWhisperBtn = makeButton("🎙️ Whisper", "可选依赖：按转写词时间戳对齐段落", () => {
		setWidgetValue(node, "paragraph_align", ALIGN_WHISPER);
		updateVisibility(node);
	});
	node.__gjjAudioSegPathBtn = makeButton("📁 路径", "打开浏览器文件选择器并上传到 ComfyUI input 目录", () => openDiskMedia(node));
	node.__gjjAudioSegAutoBtn = makeButton("▶ 自动关", "从 index=1 开始顺序排队执行；外接 index 时自动停用", () => {
		if (node.properties?.[AUTO_PROPERTY]) stopAuto(node);
		else startAuto(node);
	});
	buttonRow.append(
		node.__gjjAudioSegSilenceBtn,
		node.__gjjAudioSegParagraphBtn,
		node.__gjjAudioSegCompatBtn,
		node.__gjjAudioSegWhisperBtn,
		node.__gjjAudioSegPathBtn,
		node.__gjjAudioSegAutoBtn,
	);
	container.appendChild(buttonRow);

	const status = document.createElement("div");
	status.style.cssText = "min-height:30px;border:1px solid #3f5057;background:#10171b;border-radius:7px;padding:7px 9px;font-size:12px;line-height:1.4;white-space:pre-wrap;";
	status.textContent = "等待执行";
	node.__gjjAudioSegStatus = status;
	container.appendChild(status);

	const widget = node.addDOMWidget?.("gjj_audio_segment_panel", "audio_segment_panel", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(PANEL_MIN_HEIGHT, node.__gjjAudioSegPanelHeight || PANEL_MIN_HEIGHT),
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(280, width || 280), Math.max(PANEL_MIN_HEIGHT, node.__gjjAudioSegPanelHeight || PANEL_MIN_HEIGHT)];
	}
	node.__gjjAudioSegPanel = widget || { element: container };
	updateVisibility(node);
}

function patchNode(node) {
	if (!node || node.__gjjAudioSegPatched) return;
	node.__gjjAudioSegPatched = true;
	node.properties = node.properties || {};
	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = originalExecuted?.apply(this, arguments);
		clearDependencyWarning(this);
		const count = Number(message?.segment_count?.[0] || 0);
		const index = Number(message?.segment_index?.[0] || getWidget(this, "index")?.value || 1);
		const cacheText = message?.segment_cache_hit?.[0] ? "复用缓存" : "刷新缓存";
		setStatus(this, `${cacheText}：第 ${index} / ${count} 段\n来源：${message?.segment_source?.[0] || ""}`);
		if (activeRun?.node === this && this.properties?.[AUTO_PROPERTY]) {
			if (inputLinked(this, "index")) {
				stopAuto(this, "外部 index 已连接，自动运行已停止");
			} else if (index < count) {
				setWidgetValue(this, "index", index + 1);
				setTimeout(() => queueRun(this), 80);
			} else {
				stopAuto(this, "自动运行完成");
			}
		}
		return result;
	};
	for (const name of ["mode", "paragraph_align"]) {
		const widget = getWidget(node, name);
		if (widget && !widget.__gjjAudioSegCallbackPatched) {
			const original = widget.callback;
			widget.callback = function (...args) {
				const result = original?.apply(this, args);
			scheduleStabilize(node, 0);
			return result;
		};
			widget.__gjjAudioSegCallbackPatched = true;
		}
	}
	ensurePanel(node);
}

function noticeTargetNodes(data) {
	const nodes = Array.isArray(app.graph?._nodes) ? app.graph._nodes.filter(Boolean) : [];
	const nodeId = String(data?.node || "");
	if (nodeId) {
		const node = app.graph?.getNodeById?.(nodeId) || nodes.find((item) => String(item?.id) === nodeId);
		return node?.comfyClass === TARGET ? [node] : [];
	}
	const targetType = String(data?.node_type || data?.class_name || "");
	if (targetType) return targetType === TARGET ? nodes.filter((node) => node?.comfyClass === TARGET) : [];
	return nodes.filter((node) => node?.comfyClass === TARGET);
}

api?.addEventListener?.("gjj_dependency_model_notice", (event) => {
	const data = event.detail || {};
	setTimeout(() => {
		for (const node of noticeTargetNodes(data)) {
			clearDependencyWarning(node);
		}
	}, 0);
});

app.registerExtension({
	name: "GJJ.AudioSmartSegmenter",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;
		const created = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = created?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			setTimeout(() => scheduleStabilize(this), 120);
			return result;
		};
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = configured?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			setTimeout(() => scheduleStabilize(this), 120);
			return result;
		};
		const connections = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = connections?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === TARGET) {
			setTimeout(() => patchNode(node), 0);
			setTimeout(() => scheduleStabilize(node), 120);
		}
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET) patchNode(node);
		}
	},
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET = "GJJ_Qwen3ASRTextFormats";
const PANEL_WIDGET = "__gjj_qwen3_asr_panel";
const IMPORT_MEDIA_ENDPOINT = "/gjj/universal_tts/import_media";
const EMPTY_TEXT = "（暂无生成文本）";
const OUTPUT_PROPERTY = "gjj_qwen3_output_order";
const OUTPUT_STORAGE = "output_order_json";
const OUTPUT_DEFS = [
	{ key: "text_list", name: "分段文本", type: "STRING", tip: "每个识别片段一行。" },
	{ key: "timestamps", name: "时间戳表", type: "STRING", tip: "[开始s-结束s] 文本。" },
	{ key: "start_times", name: "开始时间列表", type: "STRING", tip: "片段开始时间数组。" },
	{ key: "end_times", name: "结束时间列表", type: "STRING", tip: "片段结束时间数组。" },
	{ key: "srt", name: "标准SRT", type: "STRING", tip: "标准 SubRip 字幕，可保存为 .srt 文件。" },
	{ key: "segment_audio", name: "分段音频", type: "AUDIO", tip: "按字幕时间裁切的 AUDIO 队列。" },
];
const PARAM_GROUPS = {
	model: ["asr_model_name", "aligner_model_name"],
	settings: ["asr_language", "align_language", "context", "precision", "max_inference_batch_size", "max_new_tokens"],
};
const LABELS = {
	example_audio: "示例音频", asr_model_name: "ASR模型", aligner_model_name: "对齐模型",
	asr_language: "识别语言", align_language: "对齐语言", context: "上下文提示",
	precision: "计算精度", max_inference_batch_size: "推理批量", max_new_tokens: "最大输出长度",
};

function widget(node, name) {
	return (node.widgets || []).find((item) => item?.name === name);
}

function setWidget(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	item.value = value;
	item.callback?.(value);
}

function hideWidget(item) {
	if (!item || item.__gjjHidden) return;
	item.__gjjHidden = true;
	item.__gjjComputeSize = item.computeSize;
	item.__gjjOriginalType = item.type;
	item.options ||= {};
	item.options.hidden = true;
	item.options.display = "hidden";
	item.type = "hidden";
	item.computeSize = () => [0, 0];
	item.getHeight = () => 0;
	item.hidden = true;
	const element = item.element || item.inputEl;
	if (element?.style) element.style.display = "none";
}

function ensureProperties(node) {
	node.properties ||= {};
	if (node.properties.segment_by_sentence === undefined) node.properties.segment_by_sentence = true;
}

function readOutputOrder(node, serialized = null) {
	ensureProperties(node);
	let order = node.properties[OUTPUT_PROPERTY];
	if (serialized) {
		const names = (serialized.outputs || []).map((output) => output?.name);
		const restored = names.map((name) => ({
			"时间戳表": "timestamps", "分段文本": "text_list",
			"开始时间列表": "start_times", "结束时间列表": "end_times", "标准SRT": "srt", "分段音频": "segment_audio",
		}[name])).filter(Boolean);
		if (restored.length) order = restored;
	}
	if (!Array.isArray(order)) {
		try { order = JSON.parse(String(widget(node, OUTPUT_STORAGE)?.value || "[]")); } catch (_) { order = []; }
	}
	order = order.filter((key) => OUTPUT_DEFS.some((def) => def.key === key));
	if (!order.length) order = ["text_list"];
	// ComfyUI's OUTPUT_IS_LIST is positional. Keep the AUDIO queue in its fixed
	// sixth slot so dynamically hidden text sockets cannot move the list flag.
	if (order.includes("segment_audio")) order = OUTPUT_DEFS.map((def) => def.key);
	node.properties[OUTPUT_PROPERTY] = [...new Set(order)];
	return node.properties[OUTPUT_PROPERTY];
}

function syncOutputStorage(node) {
	const value = JSON.stringify(readOutputOrder(node));
	setWidget(node, OUTPUT_STORAGE, value);
}

function applyOutputs(node, serialized = null) {
	const order = readOutputOrder(node, serialized);
	const targets = order.map((key) => OUTPUT_DEFS.find((def) => def.key === key)).filter(Boolean);
	for (let index = (node.outputs || []).length - 1; index >= targets.length; index--) {
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
		output.tooltip = def.tip;
	});
	syncOutputStorage(node);
	node.setDirtyCanvas?.(true, true);
}

function button(icon, title) {
	const control = document.createElement("button");
	control.type = "button";
	control.textContent = icon;
	control.title = title;
	control.style.cssText = "flex:1;min-width:28px;height:28px;padding:2px 5px;border:1px solid #46606a;border-radius:6px;background:#1f3037;color:#edf7fb;cursor:pointer;font-size:15px";
	return control;
}

function closePopups(node, except = "") {
	const state = node.__gjjQwen3Panel;
	if (!state) return;
	for (const key of ["modelPopup", "outputPopup", "settingsPopup"]) {
		if (key !== except && state[key]) {
			state[key].remove();
			state[key] = null;
		}
	}
	syncButtons(node);
}

function positionPopup(popup, anchor) {
	document.body.append(popup);
	const rect = anchor.getBoundingClientRect();
	const width = popup.offsetWidth || 330;
	popup.style.left = `${Math.min(innerWidth - width - 8, Math.max(8, rect.left))}px`;
	popup.style.top = `${Math.min(innerHeight - popup.offsetHeight - 8, Math.max(8, rect.bottom + 6))}px`;
}

function makePopup(title, onClose = null) {
	const popup = document.createElement("div");
	popup.style.cssText = "position:fixed;z-index:100000;width:330px;max-width:calc(100vw - 16px);padding:9px;border:1px solid #526873;border-radius:8px;background:#10171b;box-shadow:0 12px 28px #0008;color:#dce7e2;font:12px/1.35 system-ui,'Microsoft YaHei',sans-serif";
	const head = document.createElement("div");
	head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;color:#edf7fb;margin-bottom:7px";
	const caption = document.createElement("span");
	caption.textContent = title;
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	close.style.cssText = "width:24px;height:22px;border:1px solid #40535b;border-radius:6px;background:#172228;color:#dce7e2;cursor:pointer;padding:0;line-height:18px";
	close.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClose?.();
	};
	head.append(caption, close);
	popup.append(head);
	popup.tabIndex = -1;
	popup.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose?.();
		}
	});
	for (const event of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) popup.addEventListener(event, (e) => e.stopPropagation());
	return popup;
}

function optionsOf(item) {
	const values = item?.options?.values;
	return Array.isArray(values) ? values : [];
}

function addParameterRow(node, popup, name) {
	const item = widget(node, name);
	if (!item) return;
	const row = document.createElement("label");
	row.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin:6px 0";
	const label = document.createElement("span");
	label.textContent = LABELS[name] || name;
	label.style.cssText = "width:82px;flex:0 0 auto;padding-top:5px;color:#bdcbd1";
	let control;
	const values = optionsOf(item);
	if (values.length) {
		control = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = option.textContent = String(value);
			control.append(option);
		}
		control.value = String(item.value ?? "");
	} else if (name === "context") {
		control = document.createElement("textarea");
		control.rows = 4;
		control.value = String(item.value ?? "");
	} else {
		control = document.createElement("input");
		control.type = "number";
		control.value = String(item.value ?? "");
		if (item.options?.min != null) control.min = item.options.min;
		if (item.options?.max != null) control.max = item.options.max;
	}
	control.style.cssText = "box-sizing:border-box;flex:1;min-width:0;padding:5px 7px;border:1px solid #41535b;border-radius:5px;background:#0b1114;color:#e5f3f7";
	control.addEventListener("change", () => {
		const value = control.type === "number" ? Number(control.value) : control.value;
		setWidget(node, name, value);
		node.graph?.change?.();
	});
	row.append(label, control);
	popup.append(row);
}

function toggleParameterPopup(node, group, stateKey, anchor, title) {
	const state = node.__gjjQwen3Panel;
	if (state[stateKey]) {
		closePopups(node);
		return;
	}
	closePopups(node, stateKey);
	const popup = makePopup(title, () => closePopups(node));
	for (const name of PARAM_GROUPS[group]) addParameterRow(node, popup, name);
	const done = document.createElement("button");
	done.textContent = "确定";
	done.style.cssText = "float:right;margin-top:5px;padding:5px 12px;border:1px solid #6ea6cf;border-radius:6px;background:#245477;color:white;cursor:pointer";
	done.onclick = () => closePopups(node);
	popup.append(done);
	state[stateKey] = popup;
	positionPopup(popup, anchor);
	syncButtons(node);
}

function toggleOutputPopup(node) {
	const state = node.__gjjQwen3Panel;
	if (state.outputPopup) return closePopups(node);
	closePopups(node, "outputPopup");
	const popup = makePopup("输出接口", () => closePopups(node));
	const order = readOutputOrder(node);
	for (const def of OUTPUT_DEFS) {
		const row = document.createElement("label");
		row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px;border-radius:5px;cursor:pointer";
		const check = document.createElement("input");
		check.type = "checkbox";
		check.checked = order.includes(def.key);
		check.disabled = def.key === "text_list" || (order.includes("segment_audio") && def.key !== "segment_audio");
		check.onchange = () => {
			const current = readOutputOrder(node);
			let next = current.filter((key) => key !== def.key);
			if (check.checked) next.push(def.key);
			if (def.key === "segment_audio" && check.checked) next = OUTPUT_DEFS.map((item) => item.key);
			const removedIndex = current.indexOf(def.key);
			const linkedAtOrAfter = (node.outputs || []).some((output, index) => index >= removedIndex && output.links?.length);
			if (!check.checked && linkedAtOrAfter) {
				check.checked = true;
				check.title = "请先断开该接口及其后方接口的连线";
				return;
			}
			node.properties[OUTPUT_PROPERTY] = OUTPUT_DEFS.map((item) => item.key).filter((key) => next.includes(key));
			applyOutputs(node);
			node.graph?.change?.();
		};
		const text = document.createElement("span");
		text.textContent = `${def.name}　${def.tip}`;
		row.append(check, text);
		popup.append(row);
	}
	state.outputPopup = popup;
	positionPopup(popup, state.output);
	syncButtons(node);
}

function syncButtons(node) {
	const state = node.__gjjQwen3Panel;
	if (!state) return;
	state.segment.style.background = node.properties.segment_by_sentence ? "#245477" : "#1f3037";
	for (const [buttonName, popupName] of [["model", "modelPopup"], ["output", "outputPopup"], ["settings", "settingsPopup"]]) {
		state[buttonName].style.borderColor = state[popupName] ? "#9fc8e8" : "#46606a";
	}
}

function setStatus(node, text, progress) {
	const state = node.__gjjQwen3Panel;
	if (!state) return;
	state.status.style.display = text ? "flex" : "none";
	state.label.textContent = text;
	if (progress != null) state.bar.style.width = `${Math.max(0, Math.min(100, Math.round(progress * 100)))}%`;
	resizeNode(node);
}

function resizeNode(node) {
	requestAnimationFrame(() => {
		const size = node.computeSize?.();
		if (Array.isArray(size)) node.setSize?.([Math.max(340, node.size?.[0] || size[0]), size[1]]);
		node.setDirtyCanvas?.(true, true);
	});
}

function isOutputNode(node) {
	return node?.comfyClass === TARGET || node?.constructor?.nodeData?.output_node === true || node?.flags?.output === true;
}

async function queueOnlyCurrentNode(node) {
	const nodes = node.graph?._nodes || app.graph?._nodes || [];
	const saved = [];
	try {
		for (const item of nodes) if (item !== node && isOutputNode(item)) { saved.push([item, item.mode]); item.mode = 2; }
		await app.queuePrompt?.(0, 1);
		return true;
	} finally {
		for (const [item, mode] of saved) item.mode = mode;
	}
}

function ensurePanel(node) {
	if (node.__gjjQwen3Panel) return node.__gjjQwen3Panel;
	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:7px;padding:6px 8px;border:1px solid #41535b;border-radius:8px;background:#121a1f;color:#dce7e2;font:12px/1.35 system-ui,'Microsoft YaHei',sans-serif";
	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:5px";
	const file = button("📁", "选择示例音频");
	const model = button("🧠", "选择识别与对齐模型");
	const segment = button("📝", "按句分段");
	const output = button("🔌", "管理输出接口");
	const settings = button("⚙️", "其它参数");
	const copy = button("📋", "复制识别文本");
	const generate = button("🎤", "只执行当前节点");
	toolbar.append(file, model, segment, output, settings, copy, generate);
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = ".wav,.mp3,audio/wav,audio/mpeg";
	fileInput.style.display = "none";
	const status = document.createElement("div");
	status.style.cssText = "display:none;flex-direction:column;gap:4px";
	const label = document.createElement("div");
	label.textContent = "等待执行";
	const track = document.createElement("div");
	track.style.cssText = "height:5px;overflow:hidden;border-radius:999px;background:#27343b";
	const bar = document.createElement("div");
	bar.style.cssText = "width:0%;height:100%;border-radius:999px;background:#5aa8ff;transition:width 160ms ease";
	track.append(bar);
	status.append(label, track);
	const textDisplay = document.createElement("div");
	textDisplay.textContent = EMPTY_TEXT;
	textDisplay.style.cssText = "display:none;padding:8px;max-height:180px;overflow:auto;border:1px solid #3a4a52;border-radius:5px;background:#1a2329;color:#c8d6e5;white-space:pre-wrap;word-break:break-word";
	root.append(fileInput, toolbar, status, textDisplay);
	const panel = { root, file, model, segment, output, settings, copy, generate, fileInput, status, label, bar, textDisplay, modelPopup: null, outputPopup: null, settingsPopup: null };
	node.__gjjQwen3Panel = panel;
	node.addDOMWidget?.(PANEL_WIDGET, PANEL_WIDGET, root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => {
			let height = 44;
			if (status.style.display !== "none") height += 34;
			if (textDisplay.style.display !== "none") height += Math.min(196, Math.max(50, textDisplay.scrollHeight + 10));
			return height;
		},
	});
	file.onclick = () => fileInput.click();
	fileInput.onchange = async () => {
		const selected = fileInput.files?.[0];
		if (!selected) return;
		file.disabled = true;
		setStatus(node, `正在导入音频：${selected.name}`, 0.05);
		try {
			const body = new FormData();
			body.append("file", selected, selected.name);
			const response = await fetch(IMPORT_MEDIA_ENDPOINT, { method: "POST", body });
			const data = await response.json();
			if (!response.ok || !data?.ok) throw new Error(data?.error || "导入音频失败");
			setWidget(node, "example_audio", data.name || "");
			node.graph?.change?.();
			setStatus(node, `已载入：${data.name || selected.name}`, 1);
		} catch (error) {
			setStatus(node, `导入失败：${error?.message || error}`, 1);
		} finally {
			file.disabled = false;
			fileInput.value = "";
		}
	};
	model.onclick = () => toggleParameterPopup(node, "model", "modelPopup", model, "模型");
	settings.onclick = () => toggleParameterPopup(node, "settings", "settingsPopup", settings, "其它参数");
	output.onclick = () => toggleOutputPopup(node);
	segment.onclick = () => { node.properties.segment_by_sentence = !node.properties.segment_by_sentence; syncButtons(node); node.graph?.change?.(); };
	copy.onclick = async () => {
		if (textDisplay.textContent && textDisplay.textContent !== EMPTY_TEXT) await navigator.clipboard.writeText(textDisplay.textContent);
	};
	generate.onclick = async () => {
		generate.disabled = true;
		setStatus(node, "正在生成文本…", 0);
		try { await queueOnlyCurrentNode(node); } finally { setTimeout(() => { generate.disabled = false; }, 400); }
	};
	return panel;
}

function patchNode(node, serialized = null) {
	if (!node) return;
	ensureProperties(node);
	for (const name of ["example_audio", ...PARAM_GROUPS.model, ...PARAM_GROUPS.settings, OUTPUT_STORAGE]) hideWidget(widget(node, name));
	ensurePanel(node);
	applyOutputs(node, serialized);
	syncButtons(node);
	resizeNode(node);
}

app.registerExtension({
	name: "GJJ.Qwen3ASRTextFormats",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;
		const created = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = created?.apply(this, args);
			for (const delay of [0, 40, 150]) setTimeout(() => patchNode(this), delay);
			return result;
		};
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (data, ...args) {
			const result = configured?.apply(this, [data, ...args]);
			for (const delay of [0, 40, 150]) setTimeout(() => patchNode(this, data), delay);
			return result;
		};
		const serialized = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (...args) {
			syncOutputStorage(this);
			return serialized?.apply(this, args);
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) if (node.comfyClass === TARGET) patchNode(node);
		api.addEventListener("gjj_node_progress", (event) => {
			const data = event.detail || {};
			for (const node of app.graph?._nodes || []) if (node.comfyClass === TARGET && String(node.id) === String(data.node)) setStatus(node, data.text || "", data.progress);
		});
		api.addEventListener("gjj_qwen3_text_generated", (event) => {
			const data = event.detail || {};
			for (const node of app.graph?._nodes || []) if (node.comfyClass === TARGET && String(node.id) === String(data.node)) {
				const state = ensurePanel(node);
				state.textDisplay.textContent = data.text_list || EMPTY_TEXT;
				state.textDisplay.style.display = data.text_list ? "block" : "none";
				setStatus(node, "文本已生成", 1);
			}
		});
		api.addEventListener("gjj_qwen3_error", (event) => {
			const data = event.detail || {};
			for (const node of app.graph?._nodes || []) if (node.comfyClass === TARGET && String(node.id) === String(data.node)) {
				const state = ensurePanel(node);
				state.textDisplay.textContent = EMPTY_TEXT;
				state.textDisplay.style.display = "none";
				state.textDisplay.title = String(data.error || "");
				setStatus(node, "执行失败", 1);
			}
		});
	},
});

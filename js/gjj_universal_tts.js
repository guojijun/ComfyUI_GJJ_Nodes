const comfyApi = window.comfyAPI || {};
const appModule = comfyApi.app || {};
const apiModule = comfyApi.api || {};
const app = appModule.app || window.app || appModule;
const api = apiModule.api || window.api || apiModule;

const TARGET = "GJJ_UniversalTTS";
const MAX_REFERENCES = 10;
const AUDIO_PREFIX = "reference_";
const SETTINGS_ENDPOINT = "/gjj/user_settings";
const IMPORT_MEDIA_ENDPOINT = "/gjj/universal_tts/import_media";
const CHECK_ENDPOINT = "/gjj/universal_tts/check";
const STATUS_WIDGET = "gjj_universal_tts_panel";
const TOOLBAR_WIDGET = "gjj_universal_tts_toolbar";
const AUDIO_WIDGET = "gjj_universal_tts_audio";
const MANAGED_PROPS = {
	keep_model_loaded: true,
	random_seed: false,
	settings_open: false,
	output_audio_mode: "整体合并",
	output_text_format: "SRT",
	detached_links: {},
};

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const COMMON_WIDGETS = new Set([
	"text", "open_file_button", "keep_model_loaded", "branch", "link_button", "random_seed",
	"local_audio_name", "audio_output_mode", "timeline_format", "settings_button", "generate_button",
	"model_name", "default_reference_text",
	"edge_voice", "custom_voice", "speed", "pitch", "language", "device",
	"precision", "steps", "guidance_strength", "pause_after_speaker", "seed",
	"audio_output_mode", "timeline_format", "mp3_filename_prefix", "mp3_quality", "fail_mode",
]);

const CORE_WIDGETS = new Set(["text"]);
const SETTINGS_COMMON_WIDGETS = new Set([
	"branch", "audio_output_mode", "timeline_format", "mp3_filename_prefix", "mp3_quality", "fail_mode",
]);

const BRANCH_PRIVATE = {
	EdgeTTS: new Set(["edge_voice", "custom_voice", "speed", "pitch"]),
	FishAudioS2: new Set(["model_name", "local_audio_name", "default_reference_text", "language", "device", "precision", "seed", "pause_after_speaker"]),
	"LongCat-1B": new Set(["model_name", "local_audio_name", "default_reference_text", "device", "precision", "steps", "guidance_strength", "seed", "pause_after_speaker"]),
	"LongCat3.5B": new Set(["model_name", "local_audio_name", "default_reference_text", "device", "precision", "steps", "guidance_strength", "seed", "pause_after_speaker"]),
	"Fun-CosyVoice3-0.5B-2512": new Set(["model_name", "local_audio_name", "default_reference_text", "speed", "seed"]),
};

const BRANCH_VALUES = Object.keys(BRANCH_PRIVATE);
const CHOICE_DEFAULTS = {
	branch: "EdgeTTS",
	model_name: "自动",
	edge_voice: "[中文] zh-CN Xiaoxiao 女声",
	language: "auto",
	device: "auto",
	precision: "auto",
	audio_output_mode: "整体合并",
	timeline_format: "SRT",
	mp3_quality: "320k",
	fail_mode: "报错",
};

const NUMBER_DEFAULTS = {
	speed: { value: 1.0, min: 0.5, max: 2.0, decimals: 2 },
	pitch: { value: 0, min: -20, max: 20, int: true },
	steps: { value: 16, min: 1, max: 128, int: true },
	guidance_strength: { value: 4.0, min: 0, max: 20, decimals: 2 },
	pause_after_speaker: { value: 0.35, min: 0, max: 10, decimals: 2 },
	seed: { value: 42, min: 0, max: 0x7fffffff, int: true },
};

function isTarget(node) {
	const values = [
		node?.comfyClass,
		node?.type,
		node?.title,
		node?.constructor?.nodeData?.name,
		node?.constructor?.nodeData?.display_name,
		node?.constructor?.nodeData?.displayName,
		node?.nodeData?.name,
		node?.nodeData?.display_name,
		node?.nodeData?.displayName,
	].map((value) => String(value || ""));
	return values.some((value) => value === TARGET || value.includes("多功能文字转语音TTS"));
}

function isTargetNodeData(nodeData) {
	const values = [
		nodeData?.name,
		nodeData?.display_name,
		nodeData?.displayName,
		nodeData?.title,
	].map((value) => String(value || ""));
	return values.some((value) => value === TARGET || value.includes("多功能文字转语音TTS"));
}

function refresh(node) {
	const fit = () => {
		try {
			const computed = node?.computeSize?.();
			if (Array.isArray(computed)) {
				const width = Math.max(300, Math.round(node.size?.[0] || computed[0] || 300));
				const height = Math.max(100, Math.round(computed[1] || node.size?.[1] || 100));
				node.setSize?.([width, height]);
			}
		} catch (_) {}
		try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
		try { app.canvas?.setDirty?.(true, true); } catch (_) {}
		try { node?.graph?.change?.(); } catch (_) {}
	};
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
	else fit();
	setTimeout(fit, 80);
}

function hideWidget(item) {
	if (!item) return;
	if (!item.__gjjUniversalOriginal) {
		item.__gjjUniversalOriginal = {
			type: item.type,
			label: item.label,
			computeSize: item.computeSize || null,
			getHeight: item.getHeight || null,
			optionsHidden: item.options?.hidden,
			optionsDisplay: item.options?.display,
			draw: item.draw || null,
			mouse: item.mouse || null,
			widgetDisplay: item.widget?.style?.display || "",
			elementDisplay: item.element?.style?.display || "",
			inputDisplay: item.inputEl?.style?.display || "",
			y: item.y,
			lastY: item.last_y,
			computedHeight: item.computedHeight,
			marginTop: item.margin_top,
			size: Array.isArray(item.size) ? [...item.size] : item.size,
		};
	}
	if (!item.__gjjUniversalOriginalSize) {
		item.__gjjUniversalOriginalSize = item.computeSize || null;
	}
	item.hidden = true;
	item.disabled = true;
	item.options ||= {};
	item.options.hidden = true;
	item.options.display = "hidden";
	item.computeSize = () => [0, 0];
	item.getHeight = () => 0;
	item.draw = () => {};
	item.mouse = () => false;
	item.y = 0;
	item.last_y = 0;
	item.computedHeight = 0;
	item.margin_top = 0;
	item.size = [0, 0];
	if (item.widget) item.widget.style.display = "none";
	if (item.element) item.element.style.display = "none";
	if (item.inputEl) item.inputEl.style.display = "none";
}

function showWidget(item) {
	if (!item) return;
	item.hidden = false;
	item.disabled = false;
	const original = item.__gjjUniversalOriginal || {};
	if (original.type !== undefined) item.type = original.type;
	if (original.label !== undefined) item.label = original.label;
	if (original.computeSize) item.computeSize = original.computeSize;
	else delete item.computeSize;
	if (original.getHeight) item.getHeight = original.getHeight;
	else delete item.getHeight;
	if (original.draw) item.draw = original.draw;
	else delete item.draw;
	if (original.mouse) item.mouse = original.mouse;
	else delete item.mouse;
	if (item.options) {
		delete item.options.hidden;
		delete item.options.display;
	}
	item.y = original.y;
	item.last_y = original.lastY;
	if (original.computedHeight !== undefined) item.computedHeight = original.computedHeight;
	else delete item.computedHeight;
	if (original.marginTop !== undefined) item.margin_top = original.marginTop;
	else delete item.margin_top;
	if (original.size !== undefined) item.size = Array.isArray(original.size) ? [...original.size] : original.size;
	else delete item.size;
	if (item.widget) item.widget.style.display = original.widgetDisplay ?? "";
	if (item.element) item.element.style.display = original.elementDisplay ?? "";
	if (item.inputEl) item.inputEl.style.display = original.inputDisplay ?? "";
}

function moveWidgetToTop(node, widgetRef) {
	if (!widgetRef || !Array.isArray(node?.widgets)) return;
	const index = node.widgets.indexOf(widgetRef);
	if (index <= 0) return;
	node.widgets.splice(index, 1);
	node.widgets.unshift(widgetRef);
}

function moveWidgetsToTop(node, widgetRefs) {
	if (!Array.isArray(node?.widgets)) return;
	for (const widgetRef of [...widgetRefs].reverse()) {
		moveWidgetToTop(node, widgetRef);
	}
}

function removeToolbarWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	for (let i = node.widgets.length - 1; i >= 0; i -= 1) {
		const w = node.widgets[i];
		if (w === node.__gjjUniversalTTSToolbarWidget) continue;
		if (w?.__gjjUniversalToolbar || w?.__gjjUniversalCanvasToolbar || w?.name === "gjj_universal_tts_toolbar") {
			try { w.element?.remove?.(); } catch (_) {}
			node.widgets.splice(i, 1);
		}
	}
	node.__gjjUniversalNativeToolbar = null;
}

function widget(node, name) {
	return (node?.widgets || []).find((item) => item?.name === name);
}

function setWidgetValue(node, name, value) {
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	try { w.callback?.(value); } catch (_) {}
	node.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function formatAudioName(index) {
	return `${AUDIO_PREFIX}${String(index).padStart(2, "0")}_audio`;
}

function formatTextName(index) {
	return `${AUDIO_PREFIX}${String(index).padStart(2, "0")}_text`;
}

function inputIndex(name) {
	const match = String(name || "").match(/^reference_(\d+)_(audio|text)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function isManagedInput(input) {
	return /^reference_\d+_(audio|text)$/.test(String(input?.name || ""));
}

function pairs(node) {
	const map = new Map();
	for (const input of node?.inputs || []) {
		if (!isManagedInput(input)) continue;
		const index = inputIndex(input.name);
		if (!map.has(index)) map.set(index, { index, audio: null, text: null });
		if (String(input.name).endsWith("_audio")) map.get(index).audio = input;
		else map.get(index).text = input;
	}
	return [...map.values()].sort((a, b) => a.index - b.index);
}

function hasLink(input) {
	return Boolean(input?.link);
}

function pairLinked(pair) {
	return hasLink(pair?.audio) || hasLink(pair?.text);
}

function removeInput(node, input) {
	const slot = node?.inputs?.indexOf(input);
	if (slot >= 0) node.removeInput(slot);
}

function addPair(node) {
	const count = pairs(node).length;
	if (count >= MAX_REFERENCES) return;
	const index = count + 1;
	node.addInput(formatAudioName(index), "AUDIO");
	node.addInput(formatTextName(index), "STRING");
}

function normalizePairs(node) {
	let list = pairs(node);
	while (list.length < 1) {
		addPair(node);
		list = pairs(node);
	}
	for (let i = list.length - 1; i >= 1; i -= 1) {
		if (pairLinked(list[i])) break;
		removeInput(node, list[i].text);
		removeInput(node, list[i].audio);
	}
	list = pairs(node);
	if (list.length && pairLinked(list[list.length - 1]) && list.length < MAX_REFERENCES) addPair(node);
	list = pairs(node);
	for (const [zero, pair] of list.entries()) {
		const index = zero + 1;
		if (pair.audio) {
			pair.audio.name = formatAudioName(index);
			pair.audio.label = `参考音频${index}`;
			pair.audio.localized_name = pair.audio.label;
			pair.audio.type = "AUDIO";
		}
		if (pair.text) {
			pair.text.name = formatTextName(index);
			pair.text.label = `参考文本${index}`;
			pair.text.localized_name = pair.text.label;
			pair.text.type = "STRING";
		}
	}
	updateLinkButton(node);
	refresh(node);
}

function ensureProperties(node) {
	node.properties ||= {};
	for (const [key, value] of Object.entries(MANAGED_PROPS)) {
		if (node.properties[key] === undefined) node.properties[key] = cloneValue(value);
	}
}

function button(label, title = "") {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = label;
	btn.title = title;
	btn.style.cssText = [
		"width:27px", "height:27px", "min-width:27px", "padding:0",
		"border:1px solid #46606a", "border-radius:6px",
		"background:#1f3037", "color:#f2fbff", "cursor:pointer",
		"display:inline-flex", "align-items:center", "justify-content:center",
		"font:700 14px/1 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	btn.addEventListener("pointerdown", (event) => event.stopPropagation());
	btn.addEventListener("mousedown", (event) => event.stopPropagation());
	return btn;
}

function compactTextWidget(node) {
	const textWidget = widget(node, "text");
	if (!textWidget) return;
	textWidget.options ||= {};
	textWidget.options.rows = Math.min(Number(textWidget.options.rows || 4) || 4, 4);
	textWidget.__gjjUniversalCompact = true;
	textWidget.computeSize = (width) => [width, 94];
	textWidget.getHeight = () => 94;
	if (textWidget.element) {
		textWidget.element.style.minHeight = "0";
		textWidget.element.style.height = "94px";
	}
	if (textWidget.inputEl) {
		textWidget.inputEl.style.minHeight = "0";
		textWidget.inputEl.style.height = "74px";
		textWidget.inputEl.style.resize = "vertical";
	}
}

function toolbarHeight(state, width) {
	const measured = Number(state?.toolbar?.scrollHeight || 0);
	if (measured > 0) return Math.max(34, measured);
	return 34;
}

function ensureToolbarWidget(node, state) {
	const existing = node.__gjjUniversalTTSToolbarWidget;
	if (existing && node.widgets?.includes(existing)) {
		moveWidgetToTop(node, existing);
		return existing;
	}
	node.__gjjUniversalTTSToolbarWidget = null;
	removeToolbarWidgets(node);
	const toolbarWidget = node.addDOMWidget?.(TOOLBAR_WIDGET, "HTML", state.toolbar, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => toolbarHeight(state, node.size?.[0]),
	});
	if (toolbarWidget) {
		toolbarWidget.serialize = false;
		toolbarWidget.options ||= {};
		toolbarWidget.options.serialize = false;
		toolbarWidget.computeSize = (width) => [Math.max(260, Number(width || node.size?.[0] || 360)), toolbarHeight(state, width)];
		toolbarWidget.mouse = function (event) {
			const target = event?.target;
			if (target && state.toolbar.contains?.(target)) {
				event?.stopPropagation?.();
				return true;
			}
			return false;
		};
		node.__gjjUniversalTTSToolbarWidget = toolbarWidget;
		moveWidgetToTop(node, toolbarWidget);
		return toolbarWidget;
	}
	return null;
}

function ensurePanel(node) {
	if (node.__gjjUniversalTTS) return node.__gjjUniversalTTS;
	ensureProperties(node);
	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:4px;align-items:center;flex-wrap:nowrap;width:100%;box-sizing:border-box;overflow:visible";
	const open = button("📂", "打开文本、音频或视频文件");
	const keep = button("🧠", "切换是否保留模型");
	const branch = button("💱", "切换生成分支并保存预设");
	const link = button("🔗", "记住外部链接并断开/恢复");
	const seed = button("🎲", "切换固定/随机种子");
	const mp3 = button("📢", "显示 models/mp3 音频列表");
	const output = button("🔌", "选择输出口内容");
	const settings = button("⚙️", "显示/隐藏其它参数");
	const generate = button("🎤", "生成语音");
	toolbar.append(open, keep, branch, link, seed, mp3, output, settings, generate);

	const progress = document.createElement("div");
	progress.style.cssText = "display:none;padding:6px 8px;border:1px solid #41535b;border-radius:7px;background:#121a1f";
	const label = document.createElement("div");
	label.textContent = "";
	label.style.cssText = "margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
	const track = document.createElement("div");
	track.style.cssText = "height:6px;border-radius:999px;background:#27343b;overflow:hidden";
	const bar = document.createElement("div");
	bar.style.cssText = "width:0%;height:100%;background:#67c1ff;border-radius:999px;transition:width 160ms ease";
	track.append(bar);
	progress.append(label, track);

	const outputPanel = document.createElement("div");
	outputPanel.style.cssText = "display:none;padding:7px;border:1px solid #41535b;border-radius:7px;background:#10171b";

	const mp3List = document.createElement("div");
	mp3List.style.cssText = "display:none;max-height:160px;overflow:auto;padding:7px;border:1px solid #41535b;border-radius:7px;background:#10171b";
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = ".txt,.srt,.vtt,.lrc,.json,.wav,.mp3,.flac,.m4a,.ogg,.aac,.mp4,.mov,.mkv,.webm,text/*,audio/*,video/*";
	fileInput.style.display = "none";

	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:7px;width:100%;box-sizing:border-box;color:#dce7e2;font:12px/1.35 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif";
	root.append(fileInput, progress, outputPanel, mp3List);

	const state = { root, toolbar, open, keep, branch, link, seed, mp3, output, settings, generate, progress, label, bar, outputPanel, mp3List, fileInput };
	ensureToolbarWidget(node, state);
	const panelHeight = () => {
		let h = 0;
		if (progress.style.display !== "none") h += 52;
		if (outputPanel.style.display !== "none") h += Math.min(96, outputPanel.scrollHeight || 74);
		if (mp3List.style.display !== "none") h += Math.min(170, mp3List.scrollHeight || 120);
		return h;
	};
	const panel = node.addDOMWidget?.(STATUS_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: panelHeight,
	});
	if (panel) {
		panel.serialize = false;
		panel.options ||= {};
		panel.options.serialize = false;
		panel.computeSize = (width) => [Math.max(260, Number(width || node.size?.[0] || 300)), panelHeight()];
		panel.mouse = function (event) {
			const target = event?.target;
			if (root.contains?.(target)) {
				event?.stopPropagation?.();
				return true;
			}
			return false;
		};
	}
	state.widget = panel;
	node.__gjjUniversalTTS = state;
	wirePanel(node, state);
	syncButtons(node);
	return state;
}

function syncButtons(node) {
	const s = node.__gjjUniversalTTS;
	if (!s) return;
	ensureProperties(node);
	const branchValue = String(widget(node, "branch")?.value || "EdgeTTS");
	const audioMode = String(widget(node, "audio_output_mode")?.value || "整体合并");
	const textMode = String(widget(node, "timeline_format")?.value || "SRT");
	s.keep.style.background = node.properties.keep_model_loaded ? "#265f8f" : "#2a3034";
	s.keep.style.borderColor = node.properties.keep_model_loaded ? "#69b8e6" : "#46606a";
	s.keep.title = node.properties.keep_model_loaded ? "保留模型：开" : "保留模型：关";
	s.seed.style.background = node.properties.random_seed ? "#7a5c18" : "#2a3034";
	s.seed.style.borderColor = node.properties.random_seed ? "#ffc766" : "#46606a";
	s.seed.title = node.properties.random_seed ? "随机种子：每次变化" : `随机种子：固定 ${widget(node, "seed")?.value ?? 42}`;
	s.settings.style.background = node.properties.settings_open ? "#4d5860" : "#1f3037";
	s.settings.style.borderColor = node.properties.settings_open ? "#9fb0bd" : "#46606a";
	s.settings.title = node.properties.settings_open ? "隐藏其它参数" : "显示其它参数";
	const branchColors = ["#1f3037", "#273d62", "#3f3a1e", "#43304f", "#244437"];
	s.branch.style.background = branchColors[Math.max(0, BRANCH_VALUES.indexOf(branchValue)) % branchColors.length] || "#1f3037";
	s.branch.style.borderColor = branchValue === "EdgeTTS" ? "#46606a" : "#79a7d8";
	s.branch.title = `生成分支：${branchValue}`;
	s.output.style.background = s.outputPanel?.style.display !== "none" ? "#33414a" : "#1f3037";
	s.output.style.borderColor = s.outputPanel?.style.display !== "none" ? "#9fb0bd" : "#46606a";
	s.output.title = `输出：${audioMode} / ${textMode}`;
	s.link.style.display = pairs(node).some((pair) => pairLinked(pair)) || Object.keys(node.properties.detached_links || {}).length ? "" : "none";
	s.link.title = Object.keys(node.properties.detached_links || {}).length ? "恢复已记住的外部链接" : "记住外部链接并断开";
}

async function saveBranchPreset(node) {
	try {
		const branchWidget = widget(node, "branch");
		await fetch(SETTINGS_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ section: "nodes", values: { [TARGET]: { branch: String(branchWidget?.value || "EdgeTTS") } } }),
		});
	} catch (_) {}
}

async function refreshDependencyNotice(node) {
	try {
		const branchValue = String(widget(node, "branch")?.value || "EdgeTTS");
		const modelValue = String(widget(node, "model_name")?.value || "");
		const params = new URLSearchParams({ branch: branchValue, model_name: modelValue });
		const response = await fetch(`${CHECK_ENDPOINT}?${params.toString()}`);
		const data = await response.json();
		if (data?.report && globalThis.GJJ_CommonDependencyModelNotice?.applyNotice) {
			const level = String(data.report.notice_level || "ok");
			const hasNotice = level !== "ok"
				|| (Array.isArray(data.report.missing_dependencies) && data.report.missing_dependencies.length > 0)
				|| (Array.isArray(data.report.missing_models) && data.report.missing_models.length > 0)
				|| (Array.isArray(data.report.optional_dependencies) && data.report.optional_dependencies.length > 0);
			globalThis.GJJ_CommonDependencyModelNotice.applyNotice(node, hasNotice ? data.report : {}, {
				detailed: true,
				dismissible: false,
			});
		}
	} catch (_) {}
}

function optionValues(w) {
	const values = w?.options?.values || w?.options?.values_list || [];
	return Array.isArray(values) ? values : [];
}

function nextOption(w) {
	const values = optionValues(w);
	const index = values.indexOf(w?.value);
	return values.length ? values[(index + 1 + values.length) % values.length] : w?.value;
}

function coerceChoiceWidget(node, name, fallback) {
	const w = widget(node, name);
	if (!w) return;
	const values = optionValues(w);
	let value = String(w.value ?? "");
	if (values.length && !values.includes(value)) {
		value = values.includes(fallback) ? fallback : values[0];
		setWidgetValue(node, name, value);
	}
}

function coerceNumberWidget(node, name, config) {
	const w = widget(node, name);
	if (!w) return;
	let value = Number(w.value);
	if (!Number.isFinite(value)) value = Number(config.value);
	if (Number.isFinite(config.min)) value = Math.max(config.min, value);
	if (Number.isFinite(config.max)) value = Math.min(config.max, value);
	if (config.int) value = Math.round(value);
	else if (Number.isInteger(config.decimals)) value = Number(value.toFixed(config.decimals));
	setWidgetValue(node, name, String(value));
}

function normalizeRuntimeWidgetValues(node) {
	ensureProperties(node);
	for (const [name, fallback] of Object.entries(CHOICE_DEFAULTS)) {
		coerceChoiceWidget(node, name, fallback);
	}
	if (!BRANCH_VALUES.includes(String(widget(node, "branch")?.value || ""))) {
		setWidgetValue(node, "branch", "EdgeTTS");
	}
	for (const [name, config] of Object.entries(NUMBER_DEFAULTS)) {
		coerceNumberWidget(node, name, config);
	}
	const text = widget(node, "text");
	if (text && typeof text.value !== "string") setWidgetValue(node, "text", String(text.value ?? ""));
	syncButtons(node);
}

function wirePanel(node, state) {
	state.open.addEventListener("click", () => state.fileInput.click());
	state.fileInput.addEventListener("change", async () => {
		const file = state.fileInput.files?.[0];
		if (!file) return;
		if (file.type.startsWith("text/") || /\.(txt|srt|vtt|lrc|json)$/i.test(file.name)) {
			setWidgetValue(node, "text", await file.text());
		} else {
			setStatus(node, "正在导入参考音频…", 12);
			const body = new FormData();
			body.append("file", file, file.name);
			try {
				const response = await fetch(IMPORT_MEDIA_ENDPOINT, { method: "POST", body });
				const data = await response.json();
				if (!response.ok || !data?.ok) {
					if (data?.report && globalThis.GJJ_CommonDependencyModelNotice?.applyNotice) {
						globalThis.GJJ_CommonDependencyModelNotice.applyNotice(node, data.report, { detailed: true, dismissible: false });
					}
					throw new Error(data?.error || "导入失败");
				}
				setWidgetValue(node, "local_audio_name", data.name || "");
				setStatus(node, data.is_video ? "已提取视频音频作为参考音频" : "已导入参考音频", 100);
			} catch (error) {
				setStatus(node, `导入失败：${error?.message || error}`, 100);
			}
		}
		state.fileInput.value = "";
	});
	state.keep.addEventListener("click", () => {
		node.properties.keep_model_loaded = !node.properties.keep_model_loaded;
		syncButtons(node);
		node.graph?.change?.();
	});
	state.seed.addEventListener("click", () => {
		node.properties.random_seed = !node.properties.random_seed;
		syncButtons(node);
		node.graph?.change?.();
	});
	state.branch.addEventListener("click", () => {
		const w = widget(node, "branch");
		setWidgetValue(node, "branch", nextOption(w));
		normalizeRuntimeWidgetValues(node);
		saveBranchPreset(node);
		applyWidgetVisibility(node);
		refreshDependencyNotice(node);
		syncButtons(node);
	});
	state.output.addEventListener("click", () => {
		toggleOutputPanel(node);
	});
	state.settings.addEventListener("click", () => {
		node.properties.settings_open = !node.properties.settings_open;
		applyWidgetVisibility(node);
		syncButtons(node);
	});
	state.mp3.addEventListener("click", () => toggleMp3List(node));
	state.generate.addEventListener("click", async () => {
		const original = state.generate.textContent;
		const originalWidth = state.generate.style.width;
		const originalMinWidth = state.generate.style.minWidth;
		state.generate.textContent = "生成中…";
		state.generate.style.width = "74px";
		state.generate.style.minWidth = "74px";
		state.generate.disabled = true;
		setStatus(node, "正在生成语音…", 5);
		try {
			normalizeRuntimeWidgetValues(node);
			applyWidgetVisibility(node);
			await queueOnlyCurrentNode(node);
		} finally {
			setTimeout(() => {
				state.generate.textContent = original;
				state.generate.style.width = originalWidth;
				state.generate.style.minWidth = originalMinWidth;
				state.generate.disabled = false;
			}, 500);
		}
	});
	state.link.addEventListener("click", () => toggleDetachLinks(node));
}

function updateLinkButton(node) {
	syncButtons(node);
}

function toggleDetachLinks(node) {
	ensureProperties(node);
	const stored = node.properties.detached_links || {};
	if (Object.keys(stored).length) {
		for (const item of Object.values(stored)) {
			const input = node.inputs?.find((slot) => slot.name === item.inputName);
			if (!input || input.link) continue;
			const origin = app.graph?.getNodeById?.(item.originId);
			if (origin?.connect) origin.connect(item.originSlot, node, node.inputs.indexOf(input));
		}
		node.properties.detached_links = {};
	} else {
		const next = {};
		for (const input of node.inputs || []) {
			if (!isManagedInput(input) || !input.link) continue;
			const link = app.graph?.links?.[input.link];
			if (!link) continue;
			next[input.name] = { inputName: input.name, originId: link.origin_id, originSlot: link.origin_slot };
			node.disconnectInput(node.inputs.indexOf(input));
		}
		node.properties.detached_links = next;
	}
	normalizePairs(node);
}

function applyWidgetVisibility(node) {
	ensureProperties(node);
	const branch = String(widget(node, "branch")?.value || "EdgeTTS");
	const open = Boolean(node.properties.settings_open);
	const visiblePrivate = BRANCH_PRIVATE[branch] || new Set();
	for (const w of node.widgets || []) {
		if (!COMMON_WIDGETS.has(w.name)) continue;
		const visible = CORE_WIDGETS.has(w.name) || (open && (SETTINGS_COMMON_WIDGETS.has(w.name) || visiblePrivate.has(w.name)));
		if (visible) showWidget(w);
		else hideWidget(w);
	}
	moveWidgetToTop(node, node.__gjjUniversalTTS?.widget);
	moveWidgetToTop(node, node.__gjjUniversalTTSToolbarWidget);
	compactTextWidget(node);
	refresh(node);
}

function setupNode(node) {
	if (!isTarget(node)) return;
	safePatchNode(node);
	requestAnimationFrame(() => {
		normalizePairs(node);
		normalizeRuntimeWidgetValues(node);
		applyWidgetVisibility(node);
		compactTextWidget(node);
	});
	setTimeout(() => {
		normalizePairs(node);
		normalizeRuntimeWidgetValues(node);
		applyWidgetVisibility(node);
		compactTextWidget(node);
	}, 120);
}

function setStatus(node, text, progress = null) {
	const s = ensurePanel(node);
	s.progress.style.display = "";
	s.label.textContent = String(text || "");
	const value = Number(progress);
	const pct = Number.isFinite(value) ? (value <= 1 ? value * 100 : value) : 0;
	s.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
	refresh(node);
}

function buildViewUrl(item) {
	const params = new URLSearchParams();
	params.set("filename", item.filename || "");
	params.set("type", item.type || "output");
	if (item.subfolder) params.set("subfolder", item.subfolder);
	params.set("rand", String(Date.now()));
	return `/view?${params.toString()}`;
}

function ensureAudio(node) {
	if (node.__gjjUniversalTTSAudio) return node.__gjjUniversalTTSAudio;
	const box = document.createElement("div");
	box.style.cssText = "display:none;padding:8px;border:1px solid #41535b;border-radius:7px;background:#22282d";
	const audio = document.createElement("audio");
	audio.controls = true;
	audio.preload = "metadata";
	audio.style.cssText = "display:block;width:100%;height:34px";
	box.append(audio);
	const widgetRef = node.addDOMWidget?.(AUDIO_WIDGET, AUDIO_WIDGET, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => (box.style.display === "none" ? 0 : 54),
	});
	node.__gjjUniversalTTSAudio = { box, audio, widget: widgetRef };
	return node.__gjjUniversalTTSAudio;
}

function extractAudioItem(message) {
	const list = message?.audio;
	if (!Array.isArray(list) || !list.length) return null;
	const first = list[0];
	if (typeof first === "string") return { filename: first, type: "output" };
	return first?.filename ? first : null;
}

function setAudioPreview(node, message) {
	const item = extractAudioItem(message);
	if (!item) return;
	const state = ensureAudio(node);
	state.audio.src = buildViewUrl(item);
	state.box.style.display = "";
	refresh(node);
}

function makeSelectRow(node, labelText, widgetName) {
	const row = document.createElement("label");
	row.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0";
	const label = document.createElement("span");
	label.textContent = labelText;
	label.style.cssText = "width:70px;color:#c9d6dc;white-space:nowrap";
	const select = document.createElement("select");
	const w = widget(node, widgetName);
	const values = optionValues(w);
	select.style.cssText = "flex:1;min-width:0;background:#2b3035;color:#f4fbff;border:1px solid #465862;border-radius:5px;padding:4px 6px";
	for (const value of values.length ? values : [w?.value ?? ""]) {
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = String(value);
		select.append(option);
	}
	select.value = String(w?.value ?? "");
	select.addEventListener("pointerdown", (event) => event.stopPropagation());
	select.addEventListener("mousedown", (event) => event.stopPropagation());
	select.addEventListener("change", () => {
		setWidgetValue(node, widgetName, select.value);
		syncButtons(node);
		refresh(node);
	});
	row.append(label, select);
	return row;
}

function toggleOutputPanel(node) {
	const s = ensurePanel(node);
	if (s.outputPanel.style.display !== "none") {
		s.outputPanel.style.display = "none";
		syncButtons(node);
		refresh(node);
		return;
	}
	s.outputPanel.replaceChildren(
		makeSelectRow(node, "音频输出", "audio_output_mode"),
		makeSelectRow(node, "文本输出", "timeline_format"),
	);
	s.outputPanel.style.display = "";
	syncButtons(node);
	refresh(node);
}

function toggleMp3List(node) {
	const s = ensurePanel(node);
	if (s.mp3List.style.display !== "none") {
		s.mp3List.style.display = "none";
		refresh(node);
		return;
	}
	const w = widget(node, "local_audio_name");
	const values = optionValues(w).filter((item) => String(item || "").trim());
	const input = document.createElement("input");
	input.placeholder = "过滤关键词";
	input.style.cssText = "box-sizing:border-box;width:100%;margin-bottom:6px;background:#0b1114;color:#e5f3f7;border:1px solid #41535b;border-radius:5px;padding:5px";
	const list = document.createElement("div");
	const render = () => {
		const key = input.value.trim().toLowerCase();
		list.replaceChildren();
		for (const item of values.filter((value) => value.toLowerCase().includes(key)).sort((a, b) => a.localeCompare(b))) {
			const row = document.createElement("label");
			row.style.cssText = "display:flex;gap:6px;padding:3px 0;cursor:pointer";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.addEventListener("change", () => setWidgetValue(node, "local_audio_name", item));
			row.append(cb, document.createTextNode(item));
			list.append(row);
		}
	};
	input.addEventListener("input", render);
	s.mp3List.replaceChildren(input, list);
	render();
	s.mp3List.style.display = "";
	refresh(node);
}

function isExecutionOutputNode(node) {
	return Boolean(node?.flags?.output || node?.constructor?.nodeData?.output_node || node?.nodeData?.output_node);
}

async function queueOnlyCurrentNode(node) {
	const allNodes = app.graph?._nodes || [];
	const saved = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;
	try {
		for (const n of allNodes) {
			if (n !== node && isExecutionOutputNode(n)) {
				saved.push([n, n.mode]);
				n.mode = 2;
			}
		}
		if (app.canvas) {
			app.canvas.selected_nodes = { [node.id]: node };
			app.canvas.selected_node = node;
		}
		await app.queuePrompt?.(0, 1);
		return true;
	} finally {
		for (const [n, mode] of saved) n.mode = mode;
		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}
	}
}

function patchNode(node) {
	if (!node) return;
	ensurePanel(node);
	ensureAudio(node);
	normalizePairs(node);
	normalizeRuntimeWidgetValues(node);
	applyWidgetVisibility(node);
	compactTextWidget(node);
	const branchWidget = widget(node, "branch");
	if (branchWidget && !branchWidget.__gjjUniversalPatched) {
		branchWidget.__gjjUniversalPatched = true;
		const original = branchWidget.callback;
		branchWidget.callback = function (...args) {
			const result = original?.apply(this, args);
			saveBranchPreset(node);
			applyWidgetVisibility(node);
			refreshDependencyNotice(node);
			return result;
		};
	}
	setTimeout(() => {
		normalizePairs(node);
		normalizeRuntimeWidgetValues(node);
		applyWidgetVisibility(node);
		refreshDependencyNotice(node);
	}, 80);
	setTimeout(() => {
		normalizePairs(node);
		normalizeRuntimeWidgetValues(node);
		applyWidgetVisibility(node);
		refreshDependencyNotice(node);
	}, 300);
}

function safePatchNode(node) {
	try {
		patchNode(node);
	} catch (error) {
		console.warn("[GJJ] Universal TTS UI patch failed", error);
		try {
			if (node?.addDOMWidget && !node.__gjjUniversalTTSToolbarWidget) {
				const state = ensurePanel(node);
				ensureToolbarWidget(node, state);
			}
		} catch (_) {}
	}
}

function patchAllExistingNodes() {
	for (const node of app?.graph?._nodes || []) {
		if (isTarget(node)) safePatchNode(node);
	}
}

api?.addEventListener?.("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail.node));
	if (!isTarget(node)) return;
	setStatus(node, detail.text || "处理中…", detail.progress);
});

api?.addEventListener?.("gjj_node_audio", (event) => {
	const detail = event?.detail || {};
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail.node));
	if (!isTarget(node)) return;
	setAudioPreview(node, { audio: detail.audio || [] });
	setStatus(node, "完成，音频已保存", 100);
});

if (app?.registerExtension) {
	console.log("[GJJ] Universal TTS UI loaded");
	app.registerExtension({
		name: "Comfy.GJJ.UniversalTTS",
		beforeRegisterNodeDef(nodeType, nodeData) {
			if (!isTargetNodeData(nodeData)) return;
			const created = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) {
				const result = created?.apply(this, args);
				for (const delay of [0, 30, 120, 300]) {
					setTimeout(() => safePatchNode(this), delay);
				}
				return result;
			};
			const configured = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (...args) {
				const result = configured?.apply(this, args);
				for (const delay of [0, 30, 120, 300]) {
					setTimeout(() => safePatchNode(this), delay);
				}
				return result;
			};
			const connections = nodeType.prototype.onConnectionsChange;
			nodeType.prototype.onConnectionsChange = function (...args) {
				const result = connections?.apply(this, args);
				setTimeout(() => normalizePairs(this), 20);
				return result;
			};
			const executed = nodeType.prototype.onExecuted;
			nodeType.prototype.onExecuted = function (message, ...args) {
				const result = executed?.apply(this, [message, ...args]);
				setAudioPreview(this, message);
				return result;
			};
		},
		setup() {
			patchAllExistingNodes();
			for (const delay of [80, 300, 900, 1800]) setTimeout(patchAllExistingNodes, delay);
		},
		nodeCreated(node) {
			setupNode(node);
		},
		loadedGraphNode(node) {
			setupNode(node);
		},
	});
	for (const delay of [0, 250, 1000, 2200]) setTimeout(patchAllExistingNodes, delay);
} else {
	console.error("[GJJ] Universal TTS UI failed: Comfy app API is unavailable");
}

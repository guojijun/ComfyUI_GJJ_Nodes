import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_GemmaTextGenerate";
const PANEL_WIDGET = "gjj_gemma_text_generate_panel";
const PROMPT_WIDGET = "prompt";
const TEMPLATE_WIDGET = "system_prompt_templates";
const OUTPUT_RULE_WIDGET = "system_prompt_output_rule";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const USER_SETTINGS_SECTION = "ollama_assistant";
const WORKFLOW_VALUES_PROPERTY = "gjj_gemma_text_generate_values";
const MEDIA_INPUT = "media";
const MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const LEGACY_MEDIA_INPUTS = new Set(["image", "video", "图像", "视频帧", "媒体", "图片/视频"]);
const HIDDEN_WIDGETS = new Set([
	"clip_name",
	"clip_type",
	"clip_device",
	"max_length",
	"sampling_mode",
	"temperature",
	"top_k",
	"top_p",
	"min_p",
	"repetition_penalty",
	"seed",
	"presence_penalty",
	"thinking",
	"use_default_template",
	"system_prompt",
	TEMPLATE_WIDGET,
	OUTPUT_RULE_WIDGET,
]);
const BACKEND_WIDGETS = [
	"clip_name",
	"clip_type",
	"clip_device",
	PROMPT_WIDGET,
	"max_length",
	"sampling_mode",
	"temperature",
	"top_k",
	"top_p",
	"min_p",
	"repetition_penalty",
	"seed",
	"presence_penalty",
	"thinking",
	"use_default_template",
	"system_prompt",
	TEMPLATE_WIDGET,
	OUTPUT_RULE_WIDGET,
];
const REORDERED_WIDGETS = [
	PROMPT_WIDGET,
	...BACKEND_WIDGETS.filter((name) => name !== PROMPT_WIDGET),
];
const NUMERIC_WIDGETS = new Set([
	"max_length",
	"temperature",
	"top_k",
	"top_p",
	"min_p",
	"repetition_penalty",
	"seed",
	"presence_penalty",
]);
const NUMERIC_DEFAULTS = {
	max_length: 2048,
	temperature: 0.7,
	top_k: 64,
	top_p: 0.95,
	min_p: 0.05,
	repetition_penalty: 1.05,
	seed: 0,
	presence_penalty: 0,
};
let sharedSettingsPromise = null;

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function widgetValue(node, name, fallback = "") {
	return widget(node, name)?.value ?? fallback;
}

function protect(element) {
	if (!element || element.__gjjGemmaProtected) return element;
	element.__gjjGemmaProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return element;
}

function markChanged(node) {
	node.graph?.change?.();
	GJJ_Utils.dirtyCanvas(node);
}

function setWidgetValue(node, name, value) {
	const target = widget(node, name);
	if (!target) return;
	target.value = value;
	if (target.inputEl && "value" in target.inputEl) target.inputEl.value = value;
	if (target.element && "value" in target.element) target.element.value = value;
	target.callback?.(value, app.canvas, node, undefined, target);
	markChanged(node);
}

function collectWorkflowValues(node) {
	const values = {};
	for (const name of BACKEND_WIDGETS) {
		const target = widget(node, name);
		if (target) values[name] = target.value ?? "";
	}
	return values;
}

function rememberWorkflowValues(node, serializedNode = null) {
	if (!node || node.__gjjGemmaRestoring) return;
	const values = collectWorkflowValues(node);
	node.properties ||= {};
	node.properties[WORKFLOW_VALUES_PROPERTY] = { ...values };
	const ordered = BACKEND_WIDGETS.map((name) => values[name] ?? "");
	node.widgets_values = ordered.slice();
	if (serializedNode) {
		serializedNode.properties ||= {};
		serializedNode.properties[WORKFLOW_VALUES_PROPERTY] = { ...values };
		serializedNode.widgets_values = ordered.slice();
	}
}

function candidateFromOrder(rawValues, order, offset = 0) {
	if (!Array.isArray(rawValues) || rawValues.length <= offset) return null;
	const values = {};
	for (let index = 0; index < Math.min(order.length, rawValues.length - offset); index += 1) {
		values[order[index]] = rawValues[index + offset];
	}
	return values;
}

function workflowScore(values) {
	if (!values) return -100;
	let score = 0;
	const clipName = String(values.clip_name ?? "");
	if (/gemma|ideogram|\.safetensors$|\.gguf$/i.test(clipName)) score += 8;
	if (["ideogram4", "stable_diffusion", "sd3", "wan", "qwen_image", "flux2"].includes(String(values.clip_type ?? ""))) score += 5;
	if (["default", "cpu"].includes(String(values.clip_device ?? ""))) score += 4;
	if (["on", "off"].includes(String(values.sampling_mode ?? ""))) score += 3;
	if (typeof values.thinking === "boolean") score += 2;
	if (typeof values.use_default_template === "boolean") score += 2;
	for (const [name, min, max] of [
		["max_length", 1, 2048],
		["temperature", 0.01, 2],
		["top_k", 0, 1000],
		["top_p", 0, 1],
		["min_p", 0, 1],
		["repetition_penalty", 0, 5],
		["presence_penalty", 0, 5],
	]) {
		const number = Number(values[name]);
		if (Number.isFinite(number) && number >= min && number <= max) score += 1;
	}
	const templates = String(values[TEMPLATE_WIDGET] ?? "");
	if (parseTemplateText(templates).length > 1 || /【[^】]+】/.test(templates)) score += 8;
	return score;
}

function restoreWorkflowValues(node, serializedNode) {
	const saved = serializedNode?.properties?.[WORKFLOW_VALUES_PROPERTY]
		|| node?.properties?.[WORKFLOW_VALUES_PROPERTY];
	let values = saved && typeof saved === "object" ? { ...saved } : null;
	if (!values) {
		const raw = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
		const candidates = [];
		for (const order of [BACKEND_WIDGETS, REORDERED_WIDGETS]) {
			for (const offset of [0, 1]) {
				const candidate = candidateFromOrder(raw, order, offset);
				if (candidate) candidates.push({ values: candidate, score: workflowScore(candidate) });
			}
		}
		candidates.sort((left, right) => right.score - left.score);
		values = candidates[0]?.values || null;
	}
	if (!values) return;
	node.__gjjGemmaRestoring = true;
	try {
		for (const name of BACKEND_WIDGETS) {
			const target = widget(node, name);
			if (!target || values[name] === undefined) continue;
			let value = values[name];
			if (NUMERIC_WIDGETS.has(name)) {
				const parsed = Number(value);
				value = Number.isFinite(parsed) ? parsed : NUMERIC_DEFAULTS[name];
			} else if (typeof target.value === "number") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) value = parsed;
			} else if (typeof target.value === "boolean") {
				value = value === true || String(value).toLowerCase() === "true";
			} else {
				value = String(value ?? "");
			}
			target.value = value;
			if (target.inputEl && "value" in target.inputEl) target.inputEl.value = value;
			if (target.element && "value" in target.element) target.element.value = value;
		}
	} finally {
		node.__gjjGemmaRestoring = false;
	}
	rememberWorkflowValues(node);
}

function asBool(value) {
	return value === true || ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());
}

function splitTemplateBlocks(rawText) {
	const blocks = [];
	let current = [];
	for (const line of String(rawText || "").replace(/\r\n/g, "\n").split("\n")) {
		if (/^\s*-{3,}\s*$/.test(line) || (!line.trim() && current.some((item) => item.trim()))) {
			blocks.push(current.join("\n").trim());
			current = [];
			continue;
		}
		if (line.trim() || current.length) current.push(line);
	}
	if (current.some((item) => item.trim())) blocks.push(current.join("\n").trim());
	return blocks.filter(Boolean);
}

function parseTemplateText(rawText) {
	return splitTemplateBlocks(rawText).map((block, index) => {
		const match = block.match(/^【([^】]+)】\s*([\s\S]*)$/);
		if (!match) return null;
		return {
			key: `${index}:${String(match[1]).trim()}`,
			title: String(match[1]).trim(),
			text: String(match[2]).trim(),
		};
	}).filter((item) => item?.title && item?.text);
}

function templateTextToItems(text) {
	return parseTemplateText(text).map((item) => ({ title: item.title, prompt: item.text }));
}

function normalizeSharedSettings(settings) {
	const section = settings?.[USER_SETTINGS_SECTION] || settings || {};
	let templateText = String(section.system_prompt_templates || "").trim();
	if (!templateText && Array.isArray(section.templates)) {
		templateText = section.templates.map((item) => {
			const title = String(item?.title || item?.label || "").trim();
			const prompt = String(item?.prompt || item?.text || "").trim();
			return title && prompt ? `【${title}】${prompt}` : "";
		}).filter(Boolean).join("\n\n");
	}
	return {
		templateText,
		outputRule: String(section.system_prompt_output_rule || "").trim(),
	};
}

function loadSharedSettings() {
	if (!sharedSettingsPromise) {
		sharedSettingsPromise = api.fetchApi(USER_SETTINGS_ENDPOINT)
			.then((response) => response.json())
			.then((data) => normalizeSharedSettings(data?.settings || {}))
			.catch(() => ({ templateText: "", outputRule: "" }));
	}
	return sharedSettingsPromise;
}

async function saveSharedTemplates(node) {
	const templateText = String(widgetValue(node, TEMPLATE_WIDGET, "") || "");
	const outputRule = String(widgetValue(node, OUTPUT_RULE_WIDGET, "") || "");
	const response = await api.fetchApi(USER_SETTINGS_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			section: USER_SETTINGS_SECTION,
			values: {
				system_prompt_templates: templateText,
				templates: templateTextToItems(templateText),
				system_prompt_output_rule: outputRule,
			},
		}),
	});
	const data = await response.json();
	if (!response.ok || !data?.ok) throw new Error(data?.error || "保存失败");
	sharedSettingsPromise = Promise.resolve(normalizeSharedSettings(data.settings || {}));
	return data;
}

function templatePrompt(config, item) {
	return [String(item?.text || "").trim(), String(config?.outputRule || "").trim()]
		.filter(Boolean)
		.join("\n");
}

function button(label, title, handler) {
	const element = document.createElement("button");
	element.type = "button";
	element.className = "gjj-ia-button";
	element.textContent = label;
	element.title = title;
	protect(element);
	element.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		handler();
	});
	return element;
}

function textField(type, title) {
	const element = document.createElement("input");
	element.type = type;
	element.title = title;
	element.className = "gjj-ia-input";
	element.autocomplete = "off";
	protect(element);
	return element;
}

function selectField(title, options = []) {
	const element = document.createElement("select");
	element.title = title;
	element.className = "gjj-ia-input";
	for (const option of options) {
		const item = document.createElement("option");
		item.value = option;
		item.textContent = option;
		element.appendChild(item);
	}
	protect(element);
	return element;
}

function matchesKeywordFilter(value, query) {
	const text = String(value || "").toLowerCase();
	const groups = String(query || "")
		.toLowerCase()
		.split(/[|｜]/)
		.map((group) => group.trim())
		.filter(Boolean);
	if (!groups.length) return true;
	return groups.some((group) => {
		const terms = group.split(/\s+/).filter(Boolean);
		return terms.length > 0 && terms.every((term) => text.includes(term));
	});
}

function searchableSelectField(title, placeholder = "关键词过滤：空格=同时包含，|=任一包含") {
	const root = document.createElement("div");
	root.className = "gjj-ia-search-select";
	root.title = title;
	protect(root);

	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "gjj-ia-input gjj-ia-search-trigger";
	trigger.title = title;
	protect(trigger);

	const popup = document.createElement("div");
	popup.className = "gjj-ia-search-popup";
	popup.style.display = "none";
	protect(popup);

	const filter = textField("text", placeholder);
	filter.classList.add("gjj-ia-search-filter");
	filter.placeholder = placeholder;

	const hint = document.createElement("div");
	hint.className = "gjj-ia-search-hint";
	hint.textContent = "空格：同时包含　|：任一包含";

	const list = document.createElement("div");
	list.className = "gjj-ia-search-list";
	popup.append(filter, hint, list);
	document.body.appendChild(popup);

	const state = {
		options: [],
		value: "",
		onChange: null,
	};
	root.__gjjSearchSelect = state;

	const close = () => {
		popup.style.display = "none";
		root.classList.remove("open");
	};
	const positionPopup = () => {
		const anchor = state.anchor || trigger;
		const rect = anchor.getBoundingClientRect();
		const width = Math.max(320, rect.width);
		const maxLeft = Math.max(8, window.innerWidth - width - 8);
		popup.style.width = `${width}px`;
		popup.style.left = `${Math.max(8, Math.min(maxLeft, rect.left))}px`;
		popup.style.top = `${Math.min(window.innerHeight - 260, rect.bottom + 4)}px`;
	};
	const render = () => {
		const filtered = state.options.filter((value) => matchesKeywordFilter(value, filter.value));
		list.replaceChildren();
		if (!filtered.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-ia-search-empty";
			empty.textContent = "没有匹配项";
			list.appendChild(empty);
			return;
		}
		for (const value of filtered) {
			const option = document.createElement("button");
			option.type = "button";
			option.className = "gjj-ia-search-option";
			option.textContent = value;
			option.title = value;
			option.classList.toggle("active", value === state.value);
			protect(option);
			option.addEventListener("click", () => {
				state.value = value;
				trigger.textContent = value;
				trigger.title = value;
				state.onChange?.(value);
				close();
			});
			list.appendChild(option);
		}
	};
	const open = (anchor = trigger) => {
		state.anchor = anchor;
		positionPopup();
		popup.style.display = "flex";
		root.classList.add("open");
		filter.value = "";
		render();
		requestAnimationFrame(() => filter.focus());
	};

	trigger.addEventListener("click", () => {
		if (popup.style.display === "none") open(trigger);
		else close();
	});
	filter.addEventListener("input", render);
	filter.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close();
		}
	});
	document.addEventListener("pointerdown", (event) => {
		if (!root.contains(event.target) && !popup.contains(event.target)) close();
	});
	window.addEventListener("resize", () => {
		if (popup.style.display !== "none") positionPopup();
	});
	window.addEventListener("scroll", close, true);
	root.__gjjSearchSelectClose = close;
	root.__gjjSearchSelectOpen = open;
	root.__gjjSearchSelectRender = render;
	root.__gjjSearchSelectPopup = popup;
	root.appendChild(trigger);
	return root;
}

function syncSearchableSelect(control, values, selected) {
	const state = control?.__gjjSearchSelect;
	if (!state) return;
	const normalized = Array.from(new Set((values || []).map(String)));
	const signature = JSON.stringify(normalized);
	if (state.optionsSignature !== signature) {
		state.optionsSignature = signature;
		state.options = normalized;
	}
	state.value = String(selected ?? "");
	const trigger = control.querySelector(".gjj-ia-search-trigger");
	if (trigger) {
		trigger.textContent = state.value || "未选择";
		trigger.title = state.value || control.title || "选择模型";
	}
	control.__gjjSearchSelectRender?.();
}

function labelledField(label, control, action = null) {
	const line = document.createElement("label");
	line.className = "gjj-ia-field";
	line.title = control?.title || "";
	const name = document.createElement("span");
	name.textContent = label;
	name.className = "gjj-ia-label";
	if (action) {
		const header = document.createElement("span");
		header.className = "gjj-ia-label-row";
		header.append(name, action);
		line.append(header, control);
	} else {
		line.append(name, control);
	}
	return line;
}

function parameterField(label, control) {
	const line = labelledField(label, control);
	line.classList.add("gjj-ia-param");
	return line;
}

function choices(name, node) {
	const target = widget(node, name);
	let values = target?.options?.values || target?.options?.items || target?.values;
	if (typeof values === "function") {
		try { values = values(); } catch (_) { values = []; }
	}
	return Array.isArray(values) ? values.map(String) : [];
}

function syncSelectOptions(control, values, selected) {
	const signature = JSON.stringify(values);
	if (control.__gjjOptionsSignature !== signature) {
		control.__gjjOptionsSignature = signature;
		control.replaceChildren();
		for (const value of values) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			control.appendChild(option);
		}
	}
	if (document.activeElement !== control) control.value = String(selected ?? "");
}

function syncInputValue(control, value) {
	if (document.activeElement !== control && control.value !== String(value ?? "")) {
		control.value = String(value ?? "");
	}
}

function bindWidgetControl(node, name, control, converter = (value) => value) {
	control.addEventListener("change", () => {
		setWidgetValue(node, name, converter(control.value));
		syncPanel(node);
	});
}

function numericControl(node, name, title, min, max, step, integer = false) {
	const control = textField("number", title);
	control.min = String(min);
	control.max = String(max);
	control.step = String(step);
	bindWidgetControl(node, name, control, (value) => {
		const parsed = integer ? Number.parseInt(value || "0", 10) : Number.parseFloat(value || "0");
		return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : 0));
	});
	return control;
}

function hideBackendWidgets(node) {
	for (const name of HIDDEN_WIDGETS) GJJ_Utils.hideWidget(widget(node, name));
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
}

function restorePromptWidget(node) {
	const target = widget(node, PROMPT_WIDGET);
	if (!target) return null;
	target.hidden = false;
	target.disabled = false;
	if (String(target.type || "").startsWith("converted-widget:")) target.type = "customtext";
	if (target.__gjjUtilsHidden) delete target.__gjjUtilsHidden;
	target.label = "指令 / 原文";
	target.options ||= {};
	delete target.options.hidden;
	delete target.options.display;
	target.options.multiline = true;
	target.computeSize = undefined;
	target.getHeight = undefined;
	target.draw = undefined;
	target.last_y = 0;
	if (target.element?.style) target.element.style.display = "";
	if (target.inputEl?.style) target.inputEl.style.display = "";
	return target;
}

function ensurePromptInput(node) {
	if (!Array.isArray(node?.inputs)) node.inputs = [];
	let promptInput = node.inputs.find((input) =>
		String(input?.name || "") === PROMPT_WIDGET || String(input?.widget?.name || "") === PROMPT_WIDGET);
	if (!promptInput) {
		node.addInput?.(PROMPT_WIDGET, "STRING");
		promptInput = node.inputs[node.inputs.length - 1];
	}
	if (!promptInput) return;
	promptInput.name = PROMPT_WIDGET;
	promptInput.type = "STRING";
	promptInput.label = "指令 / 原文";
	promptInput.localized_name = "指令 / 原文";
	promptInput.tooltip = "外接 STRING 时作为用户指令；未连接时使用节点内文本框。";
	promptInput.widget = { name: PROMPT_WIDGET };
}

function normalizeMediaInput(node) {
	if (!Array.isArray(node?.inputs)) return;
	let mediaInput = node.inputs.find((input) => String(input?.name || "") === MEDIA_INPUT);
	if (!mediaInput) {
		mediaInput = node.inputs.find((input) => LEGACY_MEDIA_INPUTS.has(String(input?.name || "")) && input?.link != null)
			|| node.inputs.find((input) => LEGACY_MEDIA_INPUTS.has(String(input?.name || "")));
	}
	if (!mediaInput) {
		node.addInput?.(MEDIA_INPUT, MEDIA_INPUT_TYPE);
		mediaInput = node.inputs[node.inputs.length - 1];
	}
	if (!mediaInput) return;
	mediaInput.name = MEDIA_INPUT;
	mediaInput.type = MEDIA_INPUT_TYPE;
	mediaInput.label = "图片/视频";
	mediaInput.localized_name = "图片/视频";
	mediaInput.tooltip = "兼容 GJJ_BATCH_IMAGE、IMAGE 和官方 VIDEO；VIDEO 与其它张量会先转换为 RGB 图片批次。";
}

function placePromptAfterPanel(node) {
	const prompt = widget(node, PROMPT_WIDGET);
	const panel = widget(node, PANEL_WIDGET);
	if (!prompt || !panel || !Array.isArray(node.widgets)) return;
	const promptIndex = node.widgets.indexOf(prompt);
	if (promptIndex >= 0) node.widgets.splice(promptIndex, 1);
	const panelIndex = Math.max(0, node.widgets.indexOf(panel));
	node.widgets.splice(panelIndex + 1, 0, prompt);
}

function resizeNode(node) {
	GJJ_Utils.scheduleRefreshNode(node, {
		minWidth: 470,
		minHeight: 92,
		preserveWidth: true,
	});
}

function buildSettings(node) {
	const settings = document.createElement("div");
	settings.className = "gjj-ia-settings";

	const clipName = searchableSelectField("选择 text_encoders 目录中的 Gemma / Ideogram4 模型");
	clipName.__gjjSearchSelect.onChange = (value) => {
		setWidgetValue(node, "clip_name", value);
		syncPanel(node);
	};
	const clipType = selectField("传给官方 CLIPLoader 的类型");
	bindWidgetControl(node, "clip_type", clipType);
	const clipDevice = selectField("CLIP 加载设备");
	bindWidgetControl(node, "clip_device", clipDevice);

	const numeric = document.createElement("div");
	numeric.className = "gjj-ia-numeric";
	const maxLength = numericControl(node, "max_length", "生成文本的最大 token 长度", 1, 2048, 1, true);
	const temperature = numericControl(node, "temperature", "采样温度", 0.01, 2, 0.01);
	const topK = numericControl(node, "top_k", "Top K", 0, 1000, 1, true);
	const topP = numericControl(node, "top_p", "Top P", 0, 1, 0.01);
	const minP = numericControl(node, "min_p", "Min P", 0, 1, 0.01);
	const repetitionPenalty = numericControl(node, "repetition_penalty", "重复惩罚", 0, 5, 0.01);
	const presencePenalty = numericControl(node, "presence_penalty", "出现惩罚", 0, 5, 0.01);
	const seed = numericControl(node, "seed", "随机采样种子", 0, Number.MAX_SAFE_INTEGER, 1, true);
	numeric.append(
		parameterField("📐 最大长度", maxLength),
		parameterField("🌡 温度", temperature),
		parameterField("🎯 Top K", topK),
		parameterField("🧭 Top P", topP),
		parameterField("⚖️ Min P", minP),
		parameterField("🚫 重复惩罚", repetitionPenalty),
		parameterField("✨ 出现惩罚", presencePenalty),
		parameterField("🔢 种子", seed),
	);

	const templateEditor = document.createElement("textarea");
	templateEditor.className = "gjj-ia-textarea templates";
	templateEditor.placeholder = "与 GJJ_OllamaAssistant 共用：\n【🧡反推】系统提示词正文\n\n【🎬分镜】系统提示词正文";
	protect(templateEditor);
	templateEditor.addEventListener("input", () => {
		setWidgetValue(node, TEMPLATE_WIDGET, templateEditor.value);
		syncPanel(node);
	});
	const saveTemplates = button("💾", "保存到与 GJJ_OllamaAssistant 共用的预设", async () => {
		if (saveTemplates.disabled) return;
		saveTemplates.disabled = true;
		saveTemplates.textContent = "保存中";
		try {
			await saveSharedTemplates(node);
			saveTemplates.textContent = "已保存";
			saveTemplates.classList.add("active");
		} catch (error) {
			saveTemplates.textContent = "保存失败";
			saveTemplates.title = error?.message || "保存失败";
		}
		setTimeout(() => {
			saveTemplates.disabled = false;
			saveTemplates.textContent = "💾";
			saveTemplates.classList.remove("active");
		}, 1300);
	});
	saveTemplates.classList.add("compact");

	const outputRule = document.createElement("textarea");
	outputRule.className = "gjj-ia-textarea rule";
	outputRule.placeholder = "点击模板按钮时追加到模板正文之后。";
	protect(outputRule);
	outputRule.addEventListener("input", () => {
		setWidgetValue(node, OUTPUT_RULE_WIDGET, outputRule.value);
		syncPanel(node);
	});

	const systemPrompt = document.createElement("textarea");
	systemPrompt.className = "gjj-ia-textarea";
	systemPrompt.placeholder = "点击上方模板按钮自动写入，或在这里自定义系统提示词。";
	protect(systemPrompt);
	systemPrompt.addEventListener("input", () => {
		setWidgetValue(node, "system_prompt", systemPrompt.value);
		syncPanel(node);
	});

	settings.append(
		labelledField("🤖 CLIP 模型", clipName),
		labelledField("🧩 CLIP 类型", clipType),
		labelledField("💻 加载设备", clipDevice),
		numeric,
		labelledField("🧩 系统提示词模板", templateEditor, saveTemplates),
		labelledField("🚫 输出约束", outputRule),
		labelledField("🧾 当前系统提示词", systemPrompt),
	);
	return {
		settings,
		clipName,
		clipType,
		clipDevice,
		maxLength,
		temperature,
		topK,
		topP,
		minP,
		repetitionPenalty,
		presencePenalty,
		seed,
		templateEditor,
		saveTemplates,
		outputRule,
		systemPrompt,
	};
}

function renderTemplateButtons(node, config) {
	const state = node.__gjjGemmaPanel;
	if (!state || state.templateSignature === config.signature) return;
	state.templateSignature = config.signature;
	state.templateConfig = config;
	state.templates.replaceChildren();
	state.templateButtons = new Map();
	for (const item of config.templates) {
		const label = String(item.title || "模板").replace(/\s+/g, "");
		const choice = button(label, `设置系统提示词模板：${label}`, () => {
			setWidgetValue(node, "system_prompt", templatePrompt(config, item));
			syncPanel(node);
		});
		state.templateButtons.set(item.key, { button: choice, item });
		state.templates.appendChild(choice);
	}
}

function readTemplateConfig(node) {
	const rawTemplates = String(widgetValue(node, TEMPLATE_WIDGET, "") || "");
	const outputRule = String(widgetValue(node, OUTPUT_RULE_WIDGET, "") || "").trim();
	return {
		outputRule,
		templates: parseTemplateText(rawTemplates),
		signature: JSON.stringify([rawTemplates, outputRule]),
	};
}

function syncPanel(node) {
	const state = node.__gjjGemmaPanel;
	if (!state) return;
	const thinking = asBool(widgetValue(node, "thinking", false));
	const defaultTemplate = asBool(widgetValue(node, "use_default_template", true));
	const sampling = String(widgetValue(node, "sampling_mode", "on")) === "on";
	state.thinking.classList.toggle("active", thinking);
	state.thinking.title = thinking ? "思考模式：开。点击关闭。" : "思考模式：关。点击开启。";
	state.defaultTemplate.classList.toggle("active", defaultTemplate);
	state.defaultTemplate.title = defaultTemplate ? "模型默认模板：开。点击关闭。" : "模型默认模板：关。点击开启。";
	state.randomSeed.classList.toggle("active", sampling);
	state.randomSeed.title = sampling ? "随机采样：开。点击关闭采样。" : "随机采样：关。点击开启采样。";
	state.settingsButton.classList.toggle("active", state.expanded);
	state.settingsButton.title = state.expanded ? "收起模型、参数和提示词设置" : "展开模型、参数和提示词设置";
	state.settings.style.display = state.expanded ? "flex" : "none";
	state.modelButton.title = `当前模型：${String(widgetValue(node, "clip_name", "") || "未选择")}。点击直接选择模型。`;

	syncSearchableSelect(state.clipName, choices("clip_name", node), widgetValue(node, "clip_name", ""));
	syncSelectOptions(state.clipType, choices("clip_type", node), widgetValue(node, "clip_type", ""));
	syncSelectOptions(state.clipDevice, choices("clip_device", node), widgetValue(node, "clip_device", ""));
	for (const [control, name] of [
		[state.maxLength, "max_length"],
		[state.temperature, "temperature"],
		[state.topK, "top_k"],
		[state.topP, "top_p"],
		[state.minP, "min_p"],
		[state.repetitionPenalty, "repetition_penalty"],
		[state.presencePenalty, "presence_penalty"],
		[state.seed, "seed"],
	]) syncInputValue(control, widgetValue(node, name, ""));
	syncInputValue(state.templateEditor, widgetValue(node, TEMPLATE_WIDGET, ""));
	syncInputValue(state.outputRule, widgetValue(node, OUTPUT_RULE_WIDGET, ""));
	syncInputValue(state.systemPrompt, widgetValue(node, "system_prompt", ""));

	const config = readTemplateConfig(node);
	renderTemplateButtons(node, config);
	const currentPrompt = String(widgetValue(node, "system_prompt", ""));
	for (const entry of state.templateButtons.values()) {
		entry.button.classList.toggle("active", currentPrompt === templatePrompt(config, entry.item));
	}
	resizeNode(node);
}

function createPanel(node) {
	if (node.__gjjGemmaPanel || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div");
	root.className = "gjj-ia-panel gjj-gemma-assistant-panel";
	protect(root);
	const style = document.createElement("style");
	style.textContent = `
		.gjj-gemma-assistant-panel, .gjj-gemma-assistant-panel * { box-sizing:border-box; }
		.gjj-gemma-assistant-panel { display:flex; flex-direction:column; gap:7px; width:100%; padding:2px 0 4px; color:#dce6e8; font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; }
		.gjj-gemma-assistant-panel .gjj-ia-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:5px; overflow:visible; padding:0 0 3px; scrollbar-width:thin; }
		.gjj-gemma-assistant-panel .gjj-ia-templates { display:contents; }
		.gjj-gemma-assistant-panel .gjj-ia-button { flex:0 0 auto; height:27px; padding:0 9px; border:1px solid #3d5159; border-radius:6px; background:#172127; color:#dbe6e9; font:700 12px/25px system-ui,sans-serif; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
		.gjj-gemma-assistant-panel .gjj-ia-button.compact { width:auto; min-width:28px; max-width:74px; height:22px; padding:0 7px; font-size:11px; line-height:20px; }
		.gjj-gemma-assistant-panel .gjj-ia-button:disabled { opacity:.72; cursor:wait; }
		.gjj-gemma-assistant-panel .gjj-ia-button:hover { background:#24333b; border-color:#5f8590; }
		.gjj-gemma-assistant-panel .gjj-ia-button.active { background:#24452d; border-color:#65a271; color:#ebffee; }
		.gjj-gemma-assistant-panel .gjj-ia-settings { display:none; flex-direction:column; gap:7px; padding:8px; border:1px solid rgba(73,93,101,.7); border-radius:9px; background:rgba(15,22,26,.88); }
		.gjj-gemma-assistant-panel .gjj-ia-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
		.gjj-gemma-assistant-panel .gjj-ia-label { color:#aebfc4; font-weight:700; font-size:11px; letter-spacing:.02em; }
		.gjj-gemma-assistant-panel .gjj-ia-label-row { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
		.gjj-gemma-assistant-panel .gjj-ia-input,.gjj-gemma-assistant-panel .gjj-ia-textarea { width:100%; border:1px solid #334850; border-radius:6px; background:#10181c; color:#eef5f5; padding:5px 7px; outline:none; font:12px/1.4 system-ui,sans-serif; }
		.gjj-gemma-assistant-panel .gjj-ia-input { height:29px; }
		.gjj-gemma-assistant-panel .gjj-ia-search-select { position:relative; width:100%; min-width:0; }
		.gjj-gemma-assistant-panel .gjj-ia-search-trigger { display:block; text-align:left; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:24px; }
		.gjj-gemma-assistant-panel .gjj-ia-search-trigger::after { content:"▾"; position:absolute; right:9px; color:#91a5ab; }
		.gjj-gemma-assistant-panel .gjj-ia-input:focus,.gjj-gemma-assistant-panel .gjj-ia-textarea:focus { border-color:#6a9dae; background:#111e23; }
		.gjj-gemma-assistant-panel .gjj-ia-numeric { display:flex; flex-wrap:wrap; align-items:flex-start; gap:7px; width:100%; }
		.gjj-gemma-assistant-panel .gjj-ia-param { flex:1 1 128px; min-width:126px; max-width:190px; display:flex; flex-direction:row; align-items:center; gap:6px; padding:5px 6px; border:1px solid rgba(51,72,80,.72); border-radius:6px; background:rgba(16,24,28,.58); }
		.gjj-gemma-assistant-panel .gjj-ia-param .gjj-ia-label { flex:0 0 auto; max-width:72px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-gemma-assistant-panel .gjj-ia-param .gjj-ia-input { flex:1 1 54px; min-width:50px; height:27px; padding:4px 6px; }
		.gjj-gemma-assistant-panel .gjj-ia-textarea { min-height:86px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
		.gjj-gemma-assistant-panel .gjj-ia-textarea.rule { min-height:48px; }
		.gjj-gemma-assistant-panel .gjj-ia-textarea.templates { min-height:118px; }
		.gjj-ia-search-popup { position:fixed; z-index:100000; display:flex; flex-direction:column; gap:5px; max-height:360px; padding:7px; border:1px solid #526a73; border-radius:8px; background:#10181c; box-shadow:0 12px 32px rgba(0,0,0,.55); color:#eef5f5; font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; }
		.gjj-ia-search-filter { flex:0 0 auto; }
		.gjj-ia-search-hint { flex:0 0 auto; color:#8fa2a8; font-size:10px; padding:0 2px; }
		.gjj-ia-search-list { display:flex; flex-direction:column; min-height:36px; overflow:auto; border-top:1px solid rgba(82,106,115,.45); padding-top:4px; }
		.gjj-ia-search-option { flex:0 0 auto; width:100%; min-height:28px; border:0; border-radius:4px; background:transparent; color:#dce7e9; padding:5px 7px; text-align:left; cursor:pointer; white-space:normal; word-break:break-all; }
		.gjj-ia-search-option:hover { background:#25363d; color:#fff; }
		.gjj-ia-search-option.active { background:#24452d; color:#ebffee; }
		.gjj-ia-search-empty { color:#8fa2a8; padding:10px 7px; text-align:center; }
	`;
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-ia-toolbar";
	const templates = document.createElement("div");
	templates.className = "gjj-ia-templates";
	const modelButton = button("🤖", "当前 CLIP 模型。点击直接选择模型。", () => {
		node.__gjjGemmaPanel?.clipName?.__gjjSearchSelectOpen?.(modelButton);
	});
	const thinking = button("💭", "切换思考模式", () => {
		setWidgetValue(node, "thinking", !asBool(widgetValue(node, "thinking", false)));
		syncPanel(node);
	});
	const defaultTemplate = button("🧠", "切换模型默认模板", () => {
		setWidgetValue(node, "use_default_template", !asBool(widgetValue(node, "use_default_template", true)));
		syncPanel(node);
	});
	const randomSeed = button("🎲", "切换随机采样", () => {
		const enabled = String(widgetValue(node, "sampling_mode", "on")) === "on";
		setWidgetValue(node, "sampling_mode", enabled ? "off" : "on");
		syncPanel(node);
	});
	const settingsButton = button("⚙️", "展开模型、参数和提示词设置", () => {
		node.__gjjGemmaPanel.expanded = !node.__gjjGemmaPanel.expanded;
		syncPanel(node);
	});
	toolbar.append(templates, modelButton, thinking, defaultTemplate, randomSeed, settingsButton);

	const settingsState = buildSettings(node);
	root.append(style, toolbar, settingsState.settings);
	const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	domWidget.computeSize = (width) => [
		Math.max(470, Number(width || node.size?.[0] || 470)),
		Math.max(35, Math.ceil(root.scrollHeight || 35)),
	];
	node.__gjjGemmaPanel = {
		root,
		domWidget,
		templates,
		templateButtons: new Map(),
		modelButton,
		thinking,
		defaultTemplate,
		randomSeed,
		settingsButton,
		expanded: false,
		...settingsState,
	};
	const index = node.widgets?.indexOf(domWidget) ?? -1;
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(domWidget);
	}
	const originalOnRemoved = node.onRemoved;
	node.onRemoved = function (...args) {
		try { clipName.__gjjSearchSelectPopup?.remove(); } catch (_) {}
		return originalOnRemoved?.apply(this, args);
	};
	loadSharedSettings().then((settings) => {
		const currentTemplates = String(widgetValue(node, TEMPLATE_WIDGET, "") || "");
		if (!parseTemplateText(currentTemplates).length && settings.templateText) {
			setWidgetValue(node, TEMPLATE_WIDGET, settings.templateText);
		}
		if (!String(widgetValue(node, OUTPUT_RULE_WIDGET, "") || "").trim() && settings.outputRule) {
			setWidgetValue(node, OUTPUT_RULE_WIDGET, settings.outputRule);
		}
		syncPanel(node);
	});
	syncPanel(node);
}

function stabilize(node) {
	if (!node || String(node.comfyClass || node.type || "") !== NODE_TYPE) return;
	hideBackendWidgets(node);
	createPanel(node);
	restorePromptWidget(node);
	ensurePromptInput(node);
	normalizeMediaInput(node);
	placePromptAfterPanel(node);
	syncPanel(node);
}

function schedule(node, delay = 0) {
	setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.GemmaTextGenerate",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this);
			schedule(this, 80);
			schedule(this, 1200);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			restoreWorkflowValues(this, serializedNode);
			schedule(this);
			schedule(this, 80);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			rememberWorkflowValues(this, serializedNode);
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			schedule(this);
			return result;
		};
	},
	nodeCreated(node) {
		if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) schedule(node);
	},
});

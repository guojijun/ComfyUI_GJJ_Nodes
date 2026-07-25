import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { showAssistantResultPreview } from "./gjj_assistant_result_preview.js";

const NODE_TYPE = "GJJ_LlamaAssistant";
const NODE_TITLE_PREFIX = "GJJ·💙Llama🧠";
const NODE_TITLE_SUFFIX = " 图片反推提示词推理";
const PANEL_WIDGET = "gjj_llama_assistant_panel";
const TEMPLATE_WIDGET = "system_prompt_templates";
const OUTPUT_RULE_WIDGET = "system_prompt_output_rule";
const USER_PROMPT_WIDGET = "user_prompt";
const MODEL_ENDPOINT = "/gjj/llama_models";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const USER_SETTINGS_SECTION = "ollama_assistant";
const NO_MMPROJ = "无";
const USER_PROMPT_HEIGHT = 74;
const NODE_EXTRA_HEIGHT = 78;
const DEFAULT_TEMPLATE_TEXT = "";
const DEFAULT_OUTPUT_RULE = "";
const CACHE_TYPE_OPTIONS = ["默认(F16)", "q8_0"];
let assistantSettingsPromise = null;
const BACKEND_WIDGETS = [
	"main_model",
	"mmproj_model",
	"model_keep_alive",
	"thinking_mode",
	"temperature",
	"max_tokens",
	"seed_mode",
	"seed",
	"top_k",
	"top_p",
	"min_p",
	"presence_penalty",
	"frequency_penalty",
	"repeat_penalty",
	"context_length",
	"gpu_layers",
	"max_frames",
	"max_image_edge",
	"keep_think",
	"preserve_history_think",
	"cache_type_k",
	"cache_type_v",
	"cpu_moe",
	"n_cpu_moe",
	"system_prompt",
	TEMPLATE_WIDGET,
	OUTPUT_RULE_WIDGET,
	USER_PROMPT_WIDGET,
];
const HIDDEN_WIDGETS = new Set(BACKEND_WIDGETS.filter((name) => name !== USER_PROMPT_WIDGET));
const HIDDEN_INPUTS = new Set([...HIDDEN_WIDGETS, "unique_id", "UNIQUE_ID", "unique id"]);

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function value(node, name, fallback = "") {
	return widget(node, name)?.value ?? fallback;
}

function syncNodeTitle(node) {
	const model = String(value(node, "main_model", "") || "")
		.replaceAll("\\", "/").split("/").pop()
		.replace(/\.(?:safetensors|gguf|bin|pt|pth|ckpt)$/i, "");
	node.title = `${NODE_TITLE_PREFIX}${model || "未选择模型"}${NODE_TITLE_SUFFIX}`;
}

function boolValue(raw) {
	if (typeof raw === "boolean") return raw;
	const text = String(raw ?? "").trim().toLowerCase();
	return ["true", "1", "yes", "on", "开启", "启用"].includes(text);
}

function protect(element) {
	if (!element || element.__gjjLlamaProtected) return element;
	element.__gjjLlamaProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return element;
}

function setWidgetValue(node, name, nextValue) {
	const target = widget(node, name);
	if (!target) return;
	target.value = nextValue;
	if (target.inputEl && "value" in target.inputEl) target.inputEl.value = nextValue;
	if (target.element && "value" in target.element) target.element.value = nextValue;
	target.callback?.(nextValue, app.canvas, node, undefined, target);
	remember(node);
	node.graph?.change?.();
	resizeNode(node);
}

function removeLegacyHiddenInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const key = String(input?.name || input?.label || input?.type || input?.widget?.name || "")
			.toLowerCase()
			.replace(/[\s-]+/g, "_");
		if (key !== "unique_id" && key !== "uniqueid") continue;
		try {
			node.disconnectInput?.(index);
		} catch (_) {}
		if (typeof node.removeInput === "function") node.removeInput(index);
		else node.inputs.splice(index, 1);
	}
}

function hideBackendWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		GJJ_Utils.hideWidget(widget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_INPUTS);
	removeLegacyHiddenInputs(node);
	compactWidgetLayout(node);
	resizeNode(node);
}

function restoreUserPromptWidget(node) {
	const target = widget(node, USER_PROMPT_WIDGET);
	if (!target) return null;
	target.hidden = false;
	target.disabled = false;
	if (String(target.type || "").startsWith("converted-widget:")) {
		target.type = "customtext";
	}
	if (target.__gjjUtilsHidden) {
		delete target.__gjjUtilsHidden;
	}
	target.label = target.label || "指令 / 原文";
	target.options ||= {};
	delete target.options.hidden;
	delete target.options.display;
	target.options.multiline = true;
	target.computeSize = (width) => [Math.max(260, Number(width || node.size?.[0] || 470)), USER_PROMPT_HEIGHT];
	target.getHeight = () => USER_PROMPT_HEIGHT;
	target.draw = undefined;
	target.last_y = 0;
	target.computedHeight = USER_PROMPT_HEIGHT;
	target.margin_top = undefined;
	target.size = [Math.max(260, Number(node.size?.[0] || 470)), USER_PROMPT_HEIGHT];
	if (target.element?.style) {
		target.element.style.display = "";
		target.element.style.height = `${USER_PROMPT_HEIGHT}px`;
		target.element.style.minHeight = `${USER_PROMPT_HEIGHT}px`;
		target.element.style.maxHeight = `${USER_PROMPT_HEIGHT}px`;
		target.element.style.margin = "";
		target.element.style.padding = "";
	}
	if (target.inputEl?.style) {
		target.inputEl.style.display = "";
		target.inputEl.style.height = `${USER_PROMPT_HEIGHT}px`;
		target.inputEl.style.minHeight = `${USER_PROMPT_HEIGHT}px`;
		target.inputEl.style.maxHeight = `${USER_PROMPT_HEIGHT}px`;
		target.inputEl.style.margin = "";
		target.inputEl.style.padding = "";
	}
	return target;
}

function placeUserPromptWidget(node) {
	if (!Array.isArray(node?.widgets)) return;
	const prompt = widget(node, USER_PROMPT_WIDGET);
	const panel = widget(node, PANEL_WIDGET);
	if (!prompt || !panel) return;
	const promptIndex = node.widgets.indexOf(prompt);
	if (promptIndex >= 0) node.widgets.splice(promptIndex, 1);
	const panelIndex = Math.max(0, node.widgets.indexOf(panel));
	node.widgets.splice(panelIndex + 1, 0, prompt);
	compactWidgetLayout(node);
}

function compactWidgetLayout(node) {
	if (!Array.isArray(node?.widgets)) return;
	const panel = widget(node, PANEL_WIDGET);
	const prompt = widget(node, USER_PROMPT_WIDGET);
	const hidden = [];
	const rest = [];
	for (const item of node.widgets) {
		if (!item || item === panel || item === prompt) continue;
		const name = String(item.name || "");
		if (item.hidden || item.__gjjUtilsHidden || HIDDEN_WIDGETS.has(name)) hidden.push(item);
		else rest.push(item);
	}
	node.widgets = [panel, prompt, ...rest, ...hidden].filter(Boolean);
	for (const item of node.widgets) {
		if (!item) continue;
		const isHidden = item.hidden || item.__gjjUtilsHidden || HIDDEN_WIDGETS.has(String(item.name || ""));
		if (isHidden) {
			item.last_y = 0;
			item.computedHeight = 0;
			item.margin_top = 0;
			item.size = [0, 0];
			continue;
		}
		if (item === prompt) {
			item.last_y = 0;
			item.computedHeight = USER_PROMPT_HEIGHT;
			item.margin_top = 0;
			item.size = [Math.max(260, Number(node.size?.[0] || 470)), USER_PROMPT_HEIGHT];
		}
	}
}

function visibleWidgetHeight(node) {
	let total = 0;
	for (const item of node?.widgets || []) {
		if (!item || item.hidden || item.__gjjUtilsHidden) continue;
		try {
			const size = item.computeSize?.(node.size?.[0] || 470);
			if (Array.isArray(size) && Number.isFinite(Number(size[1]))) {
				total += Math.max(0, Number(size[1]));
				continue;
			}
		} catch (_) {}
		if (Number.isFinite(Number(item.computedHeight))) total += Math.max(0, Number(item.computedHeight));
		else if (Number.isFinite(Number(item.size?.[1]))) total += Math.max(0, Number(item.size[1]));
		else total += 20;
	}
	return total;
}

function resizeNode(node, delay = 0) {
	const run = () => {
		if (!node) return;
		compactWidgetLayout(node);
		const width = Math.max(470, Number(node.size?.[0] || 470));
		const contentHeight = Math.max(90, Math.ceil(visibleWidgetHeight(node) + NODE_EXTRA_HEIGHT));
		node.setSize?.([width, contentHeight]);
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	};
	if (delay > 0) {
		setTimeout(() => {
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
			else run();
		}, delay);
		return;
	}
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
	else run();
}

function button(text, title, onClick) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "gjj-la-button";
	btn.textContent = text;
	btn.title = title || "";
	btn.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(event);
	});
	return protect(btn);
}

function input(type, title) {
	const el = document.createElement("input");
	el.type = type;
	el.className = "gjj-la-input";
	el.title = title || "";
	return protect(el);
}

function select(title, values = []) {
	const el = document.createElement("select");
	el.className = "gjj-la-input";
	el.title = title || "";
	for (const item of values) {
		const option = document.createElement("option");
		option.value = item;
		option.textContent = item;
		el.appendChild(option);
	}
	return protect(el);
}

function field(label, control, extra = null) {
	const wrap = document.createElement("label");
	wrap.className = "gjj-la-field";
	const row = document.createElement("div");
	row.className = "gjj-la-label-row";
	const text = document.createElement("span");
	text.className = "gjj-la-label";
	text.textContent = label;
	row.append(text);
	if (extra) row.append(extra);
	wrap.append(row, control);
	return wrap;
}

function param(label, control) {
	const wrap = document.createElement("label");
	wrap.className = "gjj-la-param";
	const text = document.createElement("span");
	text.className = "gjj-la-label";
	text.textContent = label;
	wrap.append(text, control);
	return wrap;
}

function syncInput(control, nextValue) {
	if (!control) return;
	const text = String(nextValue ?? "");
	if (control.value !== text) control.value = text;
}

function templateItemsToText(items) {
	if (!Array.isArray(items)) return "";
	return items.map((item, index) => {
		const title = String(item?.title || item?.label || `模板${index + 1}`).trim();
		const prompt = String(item?.prompt || item?.text || "").trim();
		return title && prompt ? `【${title}】${prompt}` : "";
	}).filter(Boolean).join("\n\n");
}

function normalizeAssistantSettings(settings) {
	const section = settings?.[USER_SETTINGS_SECTION] || settings || {};
	const templateText = String(section.system_prompt_templates || "").trim()
		|| templateItemsToText(section.templates);
	return {
		templateText,
		outputRule: String(section.system_prompt_output_rule || "").trim(),
	};
}

function loadAssistantSettings() {
	if (!assistantSettingsPromise) {
		assistantSettingsPromise = api.fetchApi(USER_SETTINGS_ENDPOINT)
			.then((response) => response.json())
			.then((data) => normalizeAssistantSettings(data?.settings || {}))
			.catch(() => normalizeAssistantSettings({}));
	}
	return assistantSettingsPromise;
}

function workflowHasSavedValue(node, name) {
	const saved = node?.properties?.gjj_llama_assistant_values || {};
	return Object.prototype.hasOwnProperty.call(saved, name);
}

function applyAssistantSettingsDefaults(node, settings) {
	if (!node || !settings) return;
	node.__gjjLlamaAssistantUserSettings = settings;
	if (node.__gjjLlamaPanel) node.__gjjLlamaPanel.userSettings = settings;
	const templateWidget = widget(node, TEMPLATE_WIDGET);
	if (templateWidget && !workflowHasSavedValue(node, TEMPLATE_WIDGET) && !String(templateWidget.value || "").trim() && settings.templateText) {
		setWidgetValue(node, TEMPLATE_WIDGET, settings.templateText);
	}
	const ruleWidget = widget(node, OUTPUT_RULE_WIDGET);
	if (ruleWidget && !workflowHasSavedValue(node, OUTPUT_RULE_WIDGET) && !String(ruleWidget.value || "").trim() && settings.outputRule) {
		setWidgetValue(node, OUTPUT_RULE_WIDGET, settings.outputRule);
	}
}

function assistantSettingsValuesFromNode(node) {
	const templateText = String(value(node, TEMPLATE_WIDGET, "") || "");
	return {
		system_prompt_templates: templateText,
		templates: parseTemplates(templateText).map((item) => ({
			title: String(item.title || "").trim(),
			prompt: String(item.text || "").trim(),
		})).filter((item) => item.title && item.prompt),
		system_prompt_output_rule: String(value(node, OUTPUT_RULE_WIDGET, "") || "").trim(),
	};
}

async function saveAssistantSettingsNow(node) {
	const response = await api.fetchApi(USER_SETTINGS_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			section: USER_SETTINGS_SECTION,
			values: assistantSettingsValuesFromNode(node),
		}),
	});
	const data = await response.json();
	if (!response.ok || !data?.ok) {
		throw new Error(data?.error || "保存失败");
	}
	const normalized = normalizeAssistantSettings(data.settings || {});
	assistantSettingsPromise = Promise.resolve(normalized);
	if (node.__gjjLlamaPanel) node.__gjjLlamaPanel.userSettings = normalized;
	return data;
}

function flashSaveButton(button, ok, message = "") {
	if (!button) return;
	clearTimeout(button.__gjjLlamaSaveTimer);
	button.disabled = false;
	button.textContent = ok ? "✅" : "⚠️";
	button.title = ok ? "已保存到 presets/gjj_user_settings.json" : message || "保存失败";
	button.classList.toggle("active", ok);
	button.__gjjLlamaSaveTimer = setTimeout(() => {
		button.textContent = "💾";
		button.title = "保存当前系统提示词模板到 presets/gjj_user_settings.json";
		button.classList.remove("active");
	}, 1300);
}

function saveTemplateDefaults(node, button) {
	if (!node || button?.disabled) return;
	clearTimeout(button.__gjjLlamaSaveTimer);
	button.disabled = true;
	button.textContent = "⏳";
	button.title = "正在保存当前提示词模板...";
	saveAssistantSettingsNow(node)
		.then(() => flashSaveButton(button, true))
		.catch((error) => flashSaveButton(button, false, error?.message || ""));
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
		if (!line.trim() && !current.length) continue;
		current.push(line);
	}
	if (current.some((item) => item.trim())) blocks.push(current.join("\n").trim());
	return blocks.filter(Boolean);
}

function parseTemplates(rawText) {
	return splitTemplateBlocks(rawText).map((block, index) => {
		const match = block.match(/^【([^】]+)】\s*([\s\S]*)$/);
		return {
			title: String(match?.[1] || `模板${index + 1}`).trim(),
			text: String(match?.[2] || block).trim(),
		};
	}).filter((item) => item.title && item.text);
}

function templatePrompt(node, item) {
	return [item.text, String(value(node, OUTPUT_RULE_WIDGET, "") || "").trim()].filter(Boolean).join("\n");
}

function normalizedTokens(name) {
	return String(name || "")
		.toLowerCase()
		.replace(/\.[^.]+$/, "")
		.replace(/mmproj/g, " ")
		.split(/[^a-z0-9.]+/)
		.flatMap((part) => part.split(/(?<=\D)(?=\d)|(?<=\d)(?=\D)/))
		.filter((part) => part && !["model", "main", "instruct", "gguf", "bf16", "fp16", "q4", "q5", "q8"].includes(part));
}

function bestMmproj(mainModel, choices) {
	const candidates = (choices || []).filter((item) => item && item !== NO_MMPROJ);
	if (!candidates.length) return NO_MMPROJ;
	const tokens = normalizedTokens(mainModel);
	let best = candidates[0];
	let bestScore = -1;
	for (const candidate of candidates) {
		const candidateTokens = new Set(normalizedTokens(candidate));
		let score = 0;
		for (const token of tokens) {
			if (candidateTokens.has(token)) score += ["qwen", "gemma", "llama", "vl", "vision", "3", "4"].includes(token) ? 4 : 2;
			else if ([...candidateTokens].some((other) => token.includes(other) || other.includes(token))) score += 1;
		}
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return bestScore > 0 ? best : candidates[0];
}

async function fetchCatalog() {
	try {
		const response = await api.fetchApi(MODEL_ENDPOINT);
		const data = await response.json();
		if (data?.ok) return data;
	} catch (_) {}
	return { main_models: [], mmproj_models: [NO_MMPROJ] };
}

function setSelectOptions(control, values, selected) {
	if (!control) return;
	const keep = String(selected || "");
	control.replaceChildren();
	for (const item of values || []) {
		const option = document.createElement("option");
		option.value = item;
		option.textContent = item;
		control.appendChild(option);
	}
	if ([...control.options].some((option) => option.value === keep)) control.value = keep;
	else if (control.options.length) control.value = control.options[0].value;
}

async function refreshModels(node, autoPair = false) {
	const state = node.__gjjLlamaPanel;
	if (!state) return;
	const catalog = await fetchCatalog();
	state.catalog = catalog;
	const mainValues = catalog.main_models?.length ? catalog.main_models : [String(value(node, "main_model", ""))].filter(Boolean);
	const mmprojValues = catalog.mmproj_models?.length ? catalog.mmproj_models : [NO_MMPROJ];
	const currentMain = String(value(node, "main_model", mainValues[0] || ""));
	const useDefaultMain = !currentMain || !mainValues.includes(currentMain);
	const selectedMain = useDefaultMain ? (mainValues[0] || "") : currentMain;
	setSelectOptions(state.mainModel, mainValues, currentMain);
	setSelectOptions(state.mmprojModel, mmprojValues, value(node, "mmproj_model", NO_MMPROJ));
	widget(node, "main_model") && (widget(node, "main_model").options.values = mainValues);
	widget(node, "mmproj_model") && (widget(node, "mmproj_model").options.values = mmprojValues);
	if (useDefaultMain && selectedMain) {
		setWidgetValue(node, "main_model", selectedMain);
		state.mainModel.value = selectedMain;
	}
	if (autoPair || useDefaultMain) {
		const matched = bestMmproj(selectedMain || state.mainModel.value, mmprojValues);
		setWidgetValue(node, "mmproj_model", matched);
		state.mmprojModel.value = matched;
	}
	const activeModel = selectedMain || state.mainModel.value;
	const bytes = Number(catalog.model_sizes?.[activeModel] || 0);
	showAssistantResultPreview(node, {
		gjj_assistant_result: [{
			model: activeModel,
			model_size: bytes > 0 ? `${(bytes / (1024 ** 3)).toFixed(2)} GB` : "未知",
		}],
	}, {
		stateKey: "__gjjLlamaResultPreview",
		widgetName: "gjj_llama_assistant_result",
		layout: compactWidgetLayout,
		resize: resizeNode,
	});
	resizeNode(node);
}

function keepModelEnabled(node) {
	return String(value(node, "model_keep_alive", "保持模型")) === "保持模型";
}

function gpuPriorityEnabled(node) {
	return Number(value(node, "gpu_layers", -1)) !== 0;
}

function setKeepModelEnabled(node, enabled) {
	setWidgetValue(node, "model_keep_alive", enabled ? "保持模型" : "卸载模型");
	syncPanel(node);
}

function setGpuPriorityEnabled(node, enabled) {
	setWidgetValue(node, "gpu_layers", enabled ? -1 : 0);
	syncPanel(node);
}

function closeModelPopup(node) {
	const state = node?.__gjjLlamaPanel;
	if (!state) return;
	state.modelPopupOpen = false;
	state.modelPopup?.classList.remove("open");
	syncPanel(node);
}

function positionModelPopup(node) {
	const state = node?.__gjjLlamaPanel;
	const popup = state?.modelPopup;
	const anchor = state?.keepAlive;
	if (!popup || !anchor || !state.modelPopupOpen) return;
	const rect = anchor.getBoundingClientRect();
	const width = Math.min(540, Math.max(380, window.innerWidth - 28));
	const left = Math.min(window.innerWidth - width - 14, Math.max(14, rect.left));
	const top = Math.min(window.innerHeight - 120, Math.max(14, rect.bottom + 6));
	popup.style.width = `${width}px`;
	popup.style.left = `${Math.round(left)}px`;
	popup.style.top = `${Math.round(top)}px`;
}

function toggleModelPopup(node) {
	const state = node?.__gjjLlamaPanel;
	if (!state) return;
	state.modelPopupOpen = !state.modelPopupOpen;
	state.modelPopup?.classList.toggle("open", state.modelPopupOpen);
	syncPanel(node);
	positionModelPopup(node);
}

function remember(node, serializedNode = null) {
	if (!node || node.__gjjLlamaRestoring) return {};
	const values = {};
	for (const name of BACKEND_WIDGETS) {
		const target = widget(node, name);
		if (target) values[name] = target.value ?? "";
	}
	node.properties ||= {};
	node.properties.gjj_llama_assistant_values = { ...values };
	const ordered = BACKEND_WIDGETS.map((name) => values[name] ?? "");
	node.widgets_values = ordered.slice();
	if (serializedNode) serializedNode.widgets_values = ordered.slice();
	return values;
}

function restore(node, serializedNode = null) {
	const saved = serializedNode?.properties?.gjj_llama_assistant_values || node?.properties?.gjj_llama_assistant_values || {};
	const raw = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	const values = { ...saved };
	if (raw.length) {
		for (let index = 0; index < Math.min(raw.length, BACKEND_WIDGETS.length); index += 1) {
			values[BACKEND_WIDGETS[index]] ??= raw[index];
		}
	}
	node.__gjjLlamaRestoring = true;
	try {
		for (const [name, nextValue] of Object.entries(values)) {
			const target = widget(node, name);
			if (!target) continue;
			target.value = nextValue;
			if (target.inputEl && "value" in target.inputEl) target.inputEl.value = nextValue;
			if (target.element && "value" in target.element) target.element.value = nextValue;
		}
	} finally {
		node.__gjjLlamaRestoring = false;
	}
	remember(node);
}

function renderTemplates(node) {
	const state = node.__gjjLlamaPanel;
	if (!state) return;
	const fallback = state.userSettings?.templateText || DEFAULT_TEMPLATE_TEXT;
	const templates = parseTemplates(value(node, TEMPLATE_WIDGET, fallback) || fallback);
	state.templates.replaceChildren();
	for (const item of templates) {
		const label = String(item.title || "模板").replace(/\s+/g, "");
		const btn = button(label, `设置系统提示词模板：${label}`, () => {
			setWidgetValue(node, "system_prompt", templatePrompt(node, item));
			syncPanel(node);
		});
		btn.classList.toggle("active", String(value(node, "system_prompt", "")) === templatePrompt(node, item));
		state.templates.appendChild(btn);
	}
}

function syncPanel(node) {
	syncNodeTitle(node);
	const state = node.__gjjLlamaPanel;
	if (!state) return;
	restoreUserPromptWidget(node);
	placeUserPromptWidget(node);
	syncInput(state.mainModel, value(node, "main_model", ""));
	syncInput(state.mmprojModel, value(node, "mmproj_model", NO_MMPROJ));
	syncInput(state.temperature, value(node, "temperature", 0.7));
	syncInput(state.maxTokens, value(node, "max_tokens", 1024));
	syncInput(state.seedMode, value(node, "seed_mode", "每次随机"));
	syncInput(state.seed, value(node, "seed", 0));
	syncInput(state.topK, value(node, "top_k", 80));
	syncInput(state.topP, value(node, "top_p", 0.95));
	syncInput(state.minP, value(node, "min_p", 0.03));
	syncInput(state.presencePenalty, value(node, "presence_penalty", 0.3));
	syncInput(state.frequencyPenalty, value(node, "frequency_penalty", 0.2));
	syncInput(state.repeatPenalty, value(node, "repeat_penalty", 1.15));
	syncInput(state.contextLength, value(node, "context_length", 8192));
	syncInput(state.gpuLayers, value(node, "gpu_layers", -1));
	syncInput(state.cacheTypeK, value(node, "cache_type_k", CACHE_TYPE_OPTIONS[0]));
	syncInput(state.cacheTypeV, value(node, "cache_type_v", CACHE_TYPE_OPTIONS[0]));
	syncInput(state.nCpuMoe, value(node, "n_cpu_moe", 0));
	syncInput(state.maxFrames, value(node, "max_frames", 24));
	syncInput(state.maxImageEdge, value(node, "max_image_edge", 1024));
	syncInput(state.systemPrompt, value(node, "system_prompt", ""));
	syncInput(state.templateEditor, value(node, TEMPLATE_WIDGET, state.userSettings?.templateText || DEFAULT_TEMPLATE_TEXT));
	syncInput(state.outputRule, value(node, OUTPUT_RULE_WIDGET, state.userSettings?.outputRule || DEFAULT_OUTPUT_RULE));
	state.settings.style.display = state.expanded ? "flex" : "none";
	state.thinking.textContent = "💭";
	state.thinking.title = String(value(node, "thinking_mode", "关闭思考")) === "开启思考" ? "思考模式：开。点击关闭。" : "思考模式：关。点击开启。";
	state.keepAlive.textContent = "🧠";
	state.keepAlive.title = `${state.modelPopupOpen ? "关闭" : "打开"}模型参数\n主模型：${String(value(node, "main_model", "") || "未选择")}\n视觉模型：${String(value(node, "mmproj_model", NO_MMPROJ) || NO_MMPROJ)}\n${keepModelEnabled(node) ? "保持模型已开启" : "保持模型已关闭"}`;
	state.randomSeed.textContent = "🎲";
	state.randomSeed.title = String(value(node, "seed_mode", "每次随机")) === "每次随机" ? "随机种：开。" : "随机种：关。";
	state.runCurrent.textContent = "▶️";
	state.settingsButton.textContent = "⚙️";
	state.settingsButton.title = state.expanded ? "收起设置" : "展开设置";
	state.settingsButton.classList.toggle("active", state.expanded);
	state.thinking.classList.toggle("active", String(value(node, "thinking_mode", "关闭思考")) === "开启思考");
	state.keepAlive.classList.toggle("active", keepModelEnabled(node));
	state.keepAlive.classList.toggle("popup-open", Boolean(state.modelPopupOpen));
	state.randomSeed.classList.toggle("active", String(value(node, "seed_mode", "每次随机")) === "每次随机");
	state.modelPopup?.classList.toggle("open", Boolean(state.modelPopupOpen));
	state.modelPopup?.__gjjRefresh?.();
	positionModelPopup(node);
	renderTemplates(node);
	resizeNode(node);
	resizeNode(node, 120);
	resizeNode(node, 320);
}

function bindNumber(node, control, name, min, max, integer = false) {
	control.addEventListener("change", () => {
		let next = Number(control.value);
		if (!Number.isFinite(next)) next = Number(value(node, name, min));
		next = Math.max(min, Math.min(max, integer ? Math.round(next) : next));
		setWidgetValue(node, name, next);
		syncPanel(node);
	});
}

function buildSettings(node) {
	const settings = document.createElement("div");
	settings.className = "gjj-la-settings";

	const mainModel = select("主模型", []);
	mainModel.addEventListener("change", () => {
		setWidgetValue(node, "main_model", mainModel.value);
		const matched = bestMmproj(mainModel.value, node.__gjjLlamaPanel?.catalog?.mmproj_models || []);
		setWidgetValue(node, "mmproj_model", matched);
		syncPanel(node);
	});
	const mmprojModel = select("视觉模型 mmproj", [NO_MMPROJ]);
	mmprojModel.addEventListener("change", () => {
		setWidgetValue(node, "mmproj_model", mmprojModel.value);
		syncPanel(node);
	});
	const refresh = button("🔄", "重新读取 models/LLM 模型列表", () => refreshModels(node, true));
	refresh.classList.add("compact");

	const numeric = document.createElement("div");
	numeric.className = "gjj-la-numeric";
	const temperature = input("number", "温度");
	temperature.step = "0.01";
	bindNumber(node, temperature, "temperature", 0, 2);
	const maxTokens = input("number", "最大生成长度");
	bindNumber(node, maxTokens, "max_tokens", 16, 8192, true);
	const seedMode = select("种子模式", ["每次随机", "固定种子"]);
	seedMode.addEventListener("change", () => setWidgetValue(node, "seed_mode", seedMode.value));
	const seed = input("number", "固定种子");
	bindNumber(node, seed, "seed", 0, 2147483647, true);
	const topK = input("number", "Top K");
	bindNumber(node, topK, "top_k", 0, 1000, true);
	const topP = input("number", "Top P");
	topP.step = "0.01";
	bindNumber(node, topP, "top_p", 0, 1);
	const minP = input("number", "Min P");
	minP.step = "0.01";
	bindNumber(node, minP, "min_p", 0, 1);
	const presencePenalty = input("number", "出现惩罚");
	presencePenalty.step = "0.05";
	bindNumber(node, presencePenalty, "presence_penalty", -2, 2);
	const frequencyPenalty = input("number", "频率惩罚");
	frequencyPenalty.step = "0.05";
	bindNumber(node, frequencyPenalty, "frequency_penalty", -2, 2);
	const repeatPenalty = input("number", "重复惩罚");
	repeatPenalty.step = "0.05";
	bindNumber(node, repeatPenalty, "repeat_penalty", 0, 3);
	const contextLength = input("number", "上下文长度");
	bindNumber(node, contextLength, "context_length", 1024, 327680, true);
	const gpuLayers = input("number", "GPU层数");
	bindNumber(node, gpuLayers, "gpu_layers", -1, 9999, true);
	const cacheTypeK = select("KV缓存K类型", CACHE_TYPE_OPTIONS);
	cacheTypeK.addEventListener("change", () => {
		setWidgetValue(node, "cache_type_k", cacheTypeK.value);
		syncPanel(node);
	});
	const cacheTypeV = select("KV缓存V类型", CACHE_TYPE_OPTIONS);
	cacheTypeV.addEventListener("change", () => {
		setWidgetValue(node, "cache_type_v", cacheTypeV.value);
		syncPanel(node);
	});
	const nCpuMoe = input("number", "前N层专家上CPU");
	bindNumber(node, nCpuMoe, "n_cpu_moe", 0, 256, true);
	const maxFrames = input("number", "最多帧数");
	bindNumber(node, maxFrames, "max_frames", 2, 1024, true);
	const maxImageEdge = input("number", "最大边长");
	bindNumber(node, maxImageEdge, "max_image_edge", 128, 16384, true);
	numeric.append(
		param("温度", temperature),
		param("长度", maxTokens),
		param("种子", seedMode),
		param("固定", seed),
		param("Top K", topK),
		param("Top P", topP),
		param("Min P", minP),
		param("出现", presencePenalty),
		param("频率", frequencyPenalty),
		param("重复", repeatPenalty),
		param("帧数", maxFrames),
		param("边长", maxImageEdge),
	);

	const systemPrompt = document.createElement("textarea");
	systemPrompt.className = "gjj-la-textarea";
	protect(systemPrompt);
	systemPrompt.addEventListener("input", () => setWidgetValue(node, "system_prompt", systemPrompt.value));
	const templateEditor = document.createElement("textarea");
	templateEditor.className = "gjj-la-textarea templates";
	protect(templateEditor);
	templateEditor.addEventListener("input", () => {
		setWidgetValue(node, TEMPLATE_WIDGET, templateEditor.value);
		renderTemplates(node);
	});
	const saveTemplates = button("💾", "保存当前系统提示词模板到 presets/gjj_user_settings.json", () => {
		setWidgetValue(node, TEMPLATE_WIDGET, templateEditor.value);
		saveTemplateDefaults(node, saveTemplates);
	});
	saveTemplates.classList.add("compact");
	const outputRule = document.createElement("textarea");
	outputRule.className = "gjj-la-textarea rule";
	protect(outputRule);
	outputRule.addEventListener("input", () => setWidgetValue(node, OUTPUT_RULE_WIDGET, outputRule.value));

	settings.append(
		numeric,
		field("系统提示词模板", templateEditor, saveTemplates),
		field("输出约束", outputRule),
		field("当前系统提示词", systemPrompt),
	);
	return {
		settings,
		mainModel,
		mmprojModel,
		refresh,
		temperature,
		maxTokens,
		seedMode,
		seed,
		topK,
		topP,
		minP,
		presencePenalty,
		frequencyPenalty,
		repeatPenalty,
		contextLength,
		gpuLayers,
		cacheTypeK,
		cacheTypeV,
		nCpuMoe,
		maxFrames,
		maxImageEdge,
		systemPrompt,
		templateEditor,
		saveTemplates,
		outputRule,
	};
}

function buildModelPopup(node, controls) {
	const popup = document.createElement("div");
	popup.className = "gjj-la-model-popup";
	protect(popup);
	const head = document.createElement("div");
	head.className = "gjj-la-model-popup-head";
	const title = document.createElement("div");
	title.className = "gjj-la-model-popup-title";
	title.textContent = "🧠 模型参数";
	const close = button("×", "关闭模型参数", () => closeModelPopup(node));
	close.classList.add("compact");
	head.append(title, close);

	const toggles = document.createElement("div");
	toggles.className = "gjj-la-model-toggles";
	const gpuPriority = button("GPU优先", "开启后 GPU层数设为 -1，尽量让 llama.cpp 全部上 GPU。", () => {
		setGpuPriorityEnabled(node, !gpuPriorityEnabled(node));
	});
	const keepModel = button("保持模型", "切换模型常驻 / 用后卸载。", () => {
		setKeepModelEnabled(node, !keepModelEnabled(node));
	});
	const cpuMoe = button("MoE专家CPU", "仅 Qwen3.6-VL 相关模型支持；开启后 MoE 专家层可放到 CPU。", () => {
		setWidgetValue(node, "cpu_moe", !boolValue(value(node, "cpu_moe", false)));
		syncPanel(node);
	});
	toggles.append(gpuPriority, keepModel, cpuMoe);

	const grid = document.createElement("div");
	grid.className = "gjj-la-model-grid";
	grid.append(
		field("主模型", controls.mainModel, controls.refresh),
		field("视觉模型 mmproj", controls.mmprojModel),
		param("上下文", controls.contextLength),
		param("GPU层", controls.gpuLayers),
		field("KV缓存 K", controls.cacheTypeK),
		field("KV缓存 V", controls.cacheTypeV),
		param("MoE层数", controls.nCpuMoe),
	);
	popup.append(head, toggles, grid);
	popup.__gjjRefresh = () => {
		gpuPriority.textContent = gpuPriorityEnabled(node) ? "GPU优先" : "CPU优先";
		gpuPriority.classList.toggle("active", gpuPriorityEnabled(node));
		keepModel.textContent = keepModelEnabled(node) ? "保持模型" : "卸载模型";
		keepModel.classList.toggle("active", keepModelEnabled(node));
		cpuMoe.textContent = boolValue(value(node, "cpu_moe", false)) ? "MoE上CPU" : "MoE默认";
		cpuMoe.classList.toggle("active", boolValue(value(node, "cpu_moe", false)));
	};
	return popup;
}

function createPanel(node) {
	if (node.__gjjLlamaPanel || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div");
	root.className = "gjj-la-panel";
	protect(root);
	const style = document.createElement("style");
	style.textContent = `
		.gjj-la-panel,.gjj-la-panel *{box-sizing:border-box}
		.gjj-la-panel{display:flex;flex-direction:column;gap:7px;width:100%;padding:2px 0 4px;color:#dce6e8;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
		.gjj-la-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:0 0 3px}
		.gjj-la-templates{display:contents}
		.gjj-la-button{flex:0 0 auto;height:27px;padding:0 9px;border:1px solid #3d5159;border-radius:6px;background:#172127;color:#dbe6e9;font:700 12px/25px system-ui,sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
		.gjj-la-button.compact{width:auto;min-width:28px;max-width:74px;height:22px;padding:0 7px;font-size:11px;line-height:20px}
		.gjj-la-button:hover{background:#24333b;border-color:#5f8590}
		.gjj-la-button.active{background:#24452d;border-color:#65a271;color:#ebffee}
		.gjj-la-button.popup-open{box-shadow:0 0 0 2px rgba(102,178,255,.18);border-color:#72a7d7}
		.gjj-la-settings{display:none;flex-direction:column;gap:7px;padding:8px;border:1px solid rgba(73,93,101,.7);border-radius:8px;background:rgba(15,22,26,.88)}
		.gjj-la-model-popup{position:fixed;z-index:900;display:none;flex-direction:column;gap:9px;padding:10px;border:1px solid #41535b;border-radius:8px;background:#10171b;color:#dce7e2;box-shadow:0 16px 42px rgba(0,0,0,.45)}
		.gjj-la-model-popup.open{display:flex}
		.gjj-la-model-popup-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
		.gjj-la-model-popup-title{font-weight:900;font-size:14px;color:#f2faf7}
		.gjj-la-model-toggles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
		.gjj-la-model-toggles .gjj-la-button{width:100%;max-width:none;height:32px}
		.gjj-la-model-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:start}
		.gjj-la-model-grid .gjj-la-field,.gjj-la-model-grid .gjj-la-param{min-width:0;max-width:none}
		.gjj-la-model-grid .gjj-la-param{width:100%}
		.gjj-la-field{display:flex;flex-direction:column;gap:4px;min-width:0}
		.gjj-la-label-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
		.gjj-la-label{color:#aebfc4;font-weight:700;font-size:11px}
		.gjj-la-input,.gjj-la-textarea{width:100%;border:1px solid #334850;border-radius:6px;background:#10181c;color:#eef5f5;padding:5px 7px;outline:none;font:12px/1.4 system-ui,sans-serif}
		.gjj-la-input{height:29px}
		.gjj-la-input:focus,.gjj-la-textarea:focus{border-color:#6a9dae;background:#111e23}
		.gjj-la-numeric{display:flex;flex-wrap:wrap;align-items:flex-start;gap:7px;width:100%}
		.gjj-la-param{flex:1 1 128px;min-width:126px;max-width:190px;display:flex;flex-direction:row;align-items:center;gap:6px;padding:5px 6px;border:1px solid rgba(51,72,80,.72);border-radius:6px;background:rgba(16,24,28,.58)}
		.gjj-la-param .gjj-la-label{flex:0 0 auto;max-width:48px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.gjj-la-param .gjj-la-input{flex:1 1 54px;min-width:50px;height:27px;padding:4px 6px}
		.gjj-la-textarea{min-height:86px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
		.gjj-la-textarea.rule{min-height:48px}
		.gjj-la-textarea.templates{min-height:118px}
	`;
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-la-toolbar";
	const templates = document.createElement("div");
	templates.className = "gjj-la-templates";
	const thinking = button("💭", "切换思考模式", () => {
		const next = String(value(node, "thinking_mode", "关闭思考")) === "开启思考" ? "关闭思考" : "开启思考";
		setWidgetValue(node, "thinking_mode", next);
		syncPanel(node);
	});
	const keepAlive = button("🧠", "打开模型参数", () => toggleModelPopup(node));
	const randomSeed = button("🎲", "切换随机种模式", () => {
		const next = String(value(node, "seed_mode", "每次随机")) === "每次随机" ? "固定种子" : "每次随机";
		setWidgetValue(node, "seed_mode", next);
		syncPanel(node);
	});
	const runCurrent = button("▶️", "只执行当前 LLAMA 节点", () => queueOnlyCurrentNode(node));
	const settingsButton = button("⚙️", "展开 / 收起设置", () => {
		node.__gjjLlamaPanel.expanded = !node.__gjjLlamaPanel.expanded;
		syncPanel(node);
	});
	const settingsState = buildSettings(node);
	const modelPopup = buildModelPopup(node, settingsState);
	toolbar.append(templates, keepAlive, thinking, randomSeed, runCurrent, settingsButton);
	root.append(style, toolbar, settingsState.settings);
	(document.body || document.documentElement).appendChild(modelPopup);
	const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	domWidget.computeSize = (width) => [Math.max(470, Number(width || node.size?.[0] || 470)), Math.max(35, Math.ceil(root.scrollHeight || 35))];
	node.__gjjLlamaPanel = {
		root,
		domWidget,
		templates,
		modelPopup,
		modelPopupOpen: false,
		thinking,
		keepAlive,
		randomSeed,
		runCurrent,
		settingsButton,
		expanded: false,
		catalog: null,
		...settingsState,
	};
	const index = node.widgets?.indexOf(domWidget) ?? -1;
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(domWidget);
	}
	loadAssistantSettings().then((settings) => {
		applyAssistantSettingsDefaults(node, settings);
		syncPanel(node);
	});
	refreshModels(node, false).then(() => syncPanel(node));
	syncPanel(node);
}

function stabilize(node) {
	if (!node || String(node.comfyClass || node.type || "") !== NODE_TYPE) return;
	hideBackendWidgets(node);
	createPanel(node);
	showAssistantResultPreview(node, {
		gjj_assistant_result: [{ model: value(node, "main_model", "未知"), model_size: "待执行" }],
	}, {
		stateKey: "__gjjLlamaResultPreview",
		widgetName: "gjj_llama_assistant_result",
		layout: compactWidgetLayout,
		resize: resizeNode,
	});
	restoreUserPromptWidget(node);
	placeUserPromptWidget(node);
	syncPanel(node);
	resizeNode(node, 40);
	resizeNode(node, 240);
	resizeNode(node, 700);
}

function schedule(node, delay = 0) {
	setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.LlamaAssistant.Panel",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this);
			schedule(this, 100);
			schedule(this, 1000);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			restore(this, serializedNode);
			schedule(this);
			schedule(this, 100);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			remember(this, serializedNode);
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			schedule(this);
			return result;
		};
		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalOnExecuted?.apply(this, [message, ...args]);
			showAssistantResultPreview(this, message, {
				stateKey: "__gjjLlamaResultPreview",
				widgetName: "gjj_llama_assistant_result",
				layout: compactWidgetLayout,
				resize: (node) => {
					resizeNode(node);
					resizeNode(node, 80);
				},
			});
			return result;
		};
		const originalOnRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			this.__gjjLlamaPanel?.modelPopup?.remove?.();
			return originalOnRemoved?.apply(this, args);
		};
	},

	nodeCreated(node) {
		if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) schedule(node);
	},

	setup() {
		return;
	},
});

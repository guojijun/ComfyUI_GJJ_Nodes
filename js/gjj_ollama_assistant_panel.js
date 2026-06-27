import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_OllamaAssistant";
const PANEL_WIDGET = "gjj_ollama_assistant_panel";
const TEMPLATE_WIDGET = "system_prompt_templates";
const OUTPUT_RULE_WIDGET = "system_prompt_output_rule";
const USER_PROMPT_WIDGET = "user_prompt";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const USER_SETTINGS_SECTION = "ollama_assistant";
const WORKFLOW_VALUES_PROPERTY = "gjj_ollama_assistant_values";
const WORKFLOW_TEMPLATE_PROPERTY = "gjj_ollama_assistant_template_text";
const WORKFLOW_OUTPUT_RULE_PROPERTY = "gjj_ollama_assistant_output_rule";
const WORKFLOW_SAMPLING_PROPERTY = "gjj_ollama_assistant_sampling";
const BACKEND_WIDGETS = [
	"ollama_host",
	"model",
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
	"system_prompt",
	TEMPLATE_WIDGET,
	OUTPUT_RULE_WIDGET,
	USER_PROMPT_WIDGET,
];
const LEGACY_WIDGET_ORDERS = [
	BACKEND_WIDGETS,
	[
		"ollama_host",
		"model",
		"model_keep_alive",
		"thinking_mode",
		"temperature",
		"max_tokens",
		"system_prompt",
		TEMPLATE_WIDGET,
		OUTPUT_RULE_WIDGET,
		"user_prompt",
	],
	[
		"ollama_host",
		"ollama_port",
		"model",
		"temperature",
		"max_tokens",
		"system_prompt",
		"user_prompt",
	],
];
const USER_PROMPT_INPUT_TYPE = "STRING";
const USER_PROMPT_HIDDEN_NAMES = new Set(["user_prompt", "指令 / 原文"]);
const HIDDEN_WIDGETS = new Set(BACKEND_WIDGETS.filter((name) => name !== USER_PROMPT_WIDGET));
const DEFAULT_TEMPLATE_TEXT = "";
const DEFAULT_OUTPUT_RULE = "";
const DEFAULT_SAMPLING = {
	temperature: 0.7,
	max_tokens: 1024,
	seed_mode: "每次随机",
	seed: 0,
	top_k: 80,
	top_p: 0.95,
	min_p: 0.03,
	presence_penalty: 0.3,
	frequency_penalty: 0.2,
	repeat_penalty: 1.15,
};
const SAMPLING_FIELDS = [
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
];
let assistantSettingsPromise = null;

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function widgetValue(node, name, fallback = "") {
	return widget(node, name)?.value ?? fallback;
}

function protect(element) {
	if (!element || element.__gjjOllamaAssistantProtected) {
		return element;
	}
	element.__gjjOllamaAssistantProtected = true;
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
	if (!target) {
		return;
	}
	target.value = value;
	if (target.inputEl && "value" in target.inputEl) {
		target.inputEl.value = value;
	}
	if (target.element && "value" in target.element) {
		target.element.value = value;
	}
	target.callback?.(value, app.canvas, node, undefined, target);
	rememberWorkflowValues(node);
	markChanged(node);
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
		if (!line.trim() && !current.length) {
			continue;
		}
		current.push(line);
	}
	if (current.some((item) => item.trim())) {
		blocks.push(current.join("\n").trim());
	}
	return blocks.filter(Boolean);
}

function parseTemplateText(rawText) {
	const blocks = splitTemplateBlocks(rawText || DEFAULT_TEMPLATE_TEXT);
	const templates = [];
	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		const match = block.match(/^【([^】]+)】\s*([\s\S]*)$/);
		const title = String(match?.[1] || `模板${index + 1}`).trim();
		const text = String(match?.[2] || block).trim();
		if (!title || !text) {
			continue;
		}
		templates.push({
			key: `${index}:${title}`,
			title,
			text,
		});
	}
	if (!templates.length && DEFAULT_TEMPLATE_TEXT.trim() && rawText !== DEFAULT_TEMPLATE_TEXT) {
		return parseTemplateText(DEFAULT_TEMPLATE_TEXT);
	}
	return templates;
}

function templateItemsToText(items) {
	if (!Array.isArray(items)) {
		return "";
	}
	const blocks = [];
	for (const [index, item] of items.entries()) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const title = String(item.title || item.label || `模板${index + 1}`).trim();
		const prompt = String(item.prompt || item.text || "").trim();
		if (title && prompt) {
			blocks.push(`【${title}】${prompt}`);
		}
	}
	return blocks.join("\n\n");
}

function templateTextToItems(text) {
	return parseTemplateText(text).map((item) => ({
		title: String(item.title || "").trim(),
		prompt: String(item.text || "").trim(),
	})).filter((item) => item.title && item.prompt);
}

function hasOwn(object, key) {
	return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function fixedChoicesFor(name) {
	if (name === "model_keep_alive") {
		return new Set(["保持模型", "卸载模型"]);
	}
	if (name === "thinking_mode") {
		return new Set(["关闭思考", "开启思考"]);
	}
	if (name === "seed_mode") {
		return new Set(["每次随机", "固定种子"]);
	}
	return null;
}

function coerceWorkflowValue(node, name, value) {
	const target = widget(node, name);
	if (!target) {
		return value;
	}
	const choices = fixedChoicesFor(name);
	if (choices) {
		const text = String(value ?? "").trim();
		return choices.has(text) ? text : target.value;
	}
	if (typeof target.value === "number") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : target.value;
	}
	if (typeof target.value === "boolean") {
		return value === true || String(value).toLowerCase() === "true";
	}
	return String(value ?? "");
}

function collectWorkflowValues(node) {
	const values = {};
	for (const name of BACKEND_WIDGETS) {
		const target = widget(node, name);
		if (target) {
			values[name] = target.value ?? "";
		}
	}
	return values;
}

function writeWorkflowProperties(node, values) {
	if (!node || !values || typeof values !== "object") {
		return;
	}
	node.properties = node.properties || {};
	node.properties[WORKFLOW_VALUES_PROPERTY] = { ...values };
	node.properties[WORKFLOW_TEMPLATE_PROPERTY] = String(values[TEMPLATE_WIDGET] ?? "");
	node.properties[WORKFLOW_OUTPUT_RULE_PROPERTY] = String(values[OUTPUT_RULE_WIDGET] ?? "");
	node.properties[WORKFLOW_SAMPLING_PROPERTY] = normalizeSampling(values);
	for (const [name, value] of Object.entries(values)) {
		node.properties[`gjj_ollama_assistant_value_${name}`] = value;
	}
}

function writeSerializedWorkflowValues(node, serializedNode, values) {
	const ordered = BACKEND_WIDGETS.map((name) => values?.[name] ?? "");
	if (node) {
		node.widgets_values = ordered.slice();
	}
	if (serializedNode) {
		serializedNode.widgets_values = ordered.slice();
	}
}

function rememberWorkflowValues(node, serializedNode = null) {
	if (!node || node.__gjjOllamaAssistantRestoring) {
		return {};
	}
	const values = collectWorkflowValues(node);
	writeWorkflowProperties(node, values);
	writeSerializedWorkflowValues(node, serializedNode, values);
	return values;
}

function valuesFromProperties(props) {
	const saved = props?.[WORKFLOW_VALUES_PROPERTY];
	const values = {};
	for (const name of BACKEND_WIDGETS) {
		let value = saved && typeof saved === "object" ? saved[name] : undefined;
		if (value === undefined) {
			value = props?.[`gjj_ollama_assistant_value_${name}`];
		}
		if (value === undefined && name === TEMPLATE_WIDGET && hasOwn(props, WORKFLOW_TEMPLATE_PROPERTY)) {
			value = props[WORKFLOW_TEMPLATE_PROPERTY];
		}
		if (value === undefined && name === OUTPUT_RULE_WIDGET && hasOwn(props, WORKFLOW_OUTPUT_RULE_PROPERTY)) {
			value = props[WORKFLOW_OUTPUT_RULE_PROPERTY];
		}
		if (value !== undefined) {
			values[name] = value;
		}
	}
	return values;
}

function serializedValuesForOrder(rawValues, order, offset = 0) {
	if (!Array.isArray(rawValues) || rawValues.length <= offset) {
		return null;
	}
	const values = {};
	const count = Math.min(order.length, rawValues.length - offset);
	for (let index = 0; index < count; index += 1) {
		const name = order[index];
		if (BACKEND_WIDGETS.includes(name)) {
			values[name] = rawValues[index + offset];
		}
	}
	return values;
}

function isNumberInRange(value, min, max) {
	const number = Number(value);
	return Number.isFinite(number) && number >= min && number <= max;
}

function templateTextScore(value) {
	const text = String(value ?? "").trim();
	if (!text) {
		return 0;
	}
	const templates = parseTemplateText(text);
	const titledCount = (text.match(/(^|\n)\s*【[^】]+】/g) || []).length;
	let score = templates.length ? 1 : 0;
	if (titledCount) {
		score += 8 + titledCount;
	}
	if (templates.length > 1) {
		score += 2;
	}
	if (/模板|提示词|输出|翻译|分镜|反推/.test(text)) {
		score += 1;
	}
	return score;
}

function scoreWorkflowValues(values) {
	if (!values || typeof values !== "object") {
		return -100;
	}
	let score = 0;
	const host = String(values.ollama_host ?? "").trim();
	if (/^https?:\/\//i.test(host) || /127\.0\.0\.1|localhost/i.test(host)) {
		score += 3;
	}
	if (String(values.model ?? "").trim()) {
		score += 1;
	}
	for (const [name, allowed] of [
		["model_keep_alive", ["保持模型", "卸载模型"]],
		["thinking_mode", ["关闭思考", "开启思考"]],
		["seed_mode", ["每次随机", "固定种子"]],
	]) {
		if (!hasOwn(values, name)) {
			continue;
		}
		score += allowed.includes(String(values[name] ?? "")) ? 3 : -4;
	}
	if (hasOwn(values, "temperature")) {
		score += isNumberInRange(values.temperature, 0, 2) ? 2 : -3;
	}
	if (hasOwn(values, "max_tokens")) {
		score += isNumberInRange(values.max_tokens, 16, 8192) ? 2 : -3;
	}
	for (const [name, min, max] of [
		["seed", 0, 2147483647],
		["top_k", 1, 1000],
		["top_p", 0, 1],
		["min_p", 0, 1],
		["presence_penalty", -2, 2],
		["frequency_penalty", -2, 2],
		["repeat_penalty", 0, 3],
	]) {
		if (hasOwn(values, name)) {
			score += isNumberInRange(values[name], min, max) ? 1 : -2;
		}
	}
	const systemPrompt = String(values.system_prompt ?? "").trim();
	if (systemPrompt && !isNumberInRange(systemPrompt, -999999, 999999)) {
		score += 3;
	}
	score += templateTextScore(values[TEMPLATE_WIDGET]);
	const outputRule = String(values[OUTPUT_RULE_WIDGET] ?? "").trim();
	if (outputRule) {
		score += /输出|解释|Markdown|标题|前缀|台词/.test(outputRule) ? 3 : 1;
	}
	const userPrompt = String(values.user_prompt ?? "").trim();
	if (userPrompt && !isNumberInRange(userPrompt, -999999, 999999)) {
		score += 1;
	}
	return score;
}

function valuesFromSerializedWidgets(serializedNode) {
	const rawValues = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	if (!rawValues.length) {
		return {};
	}
	const candidates = [];
	for (const order of LEGACY_WIDGET_ORDERS) {
		for (const offset of [0, 1]) {
			const values = serializedValuesForOrder(rawValues, order, offset);
			if (values) {
				candidates.push({ values, score: scoreWorkflowValues(values) });
			}
		}
	}
	candidates.sort((a, b) => b.score - a.score);
	return candidates[0]?.score > 0 ? candidates[0].values : {};
}

function workflowHasSavedValue(node, name) {
	if (node?.__gjjOllamaAssistantRestoredKeys?.has?.(name)) {
		return true;
	}
	const props = node?.properties || {};
	const saved = props[WORKFLOW_VALUES_PROPERTY];
	return hasOwn(saved, name)
		|| hasOwn(props, `gjj_ollama_assistant_value_${name}`)
		|| (name === TEMPLATE_WIDGET && hasOwn(props, WORKFLOW_TEMPLATE_PROPERTY))
		|| (name === OUTPUT_RULE_WIDGET && hasOwn(props, WORKFLOW_OUTPUT_RULE_PROPERTY));
}

function restoreWorkflowValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node?.properties || {};
	const propertyValues = valuesFromProperties(props);
	const serializedValues = valuesFromSerializedWidgets(serializedNode);
	const propertyScore = scoreWorkflowValues(propertyValues);
	const serializedScore = scoreWorkflowValues(serializedValues);
	const preferSerialized = serializedScore > 0 && serializedScore > propertyScore + 4;
	const values = preferSerialized
		? { ...propertyValues, ...serializedValues }
		: { ...serializedValues, ...propertyValues };
	const keys = Object.keys(values).filter((name) => BACKEND_WIDGETS.includes(name));
	node.__gjjOllamaAssistantRestoredKeys = new Set(keys);
	if (!keys.length) {
		return;
	}
	node.__gjjOllamaAssistantRestoring = true;
	try {
		for (const name of keys) {
			const target = widget(node, name);
			if (!target) {
				continue;
			}
			const value = coerceWorkflowValue(node, name, values[name]);
			target.value = value;
			if (target.inputEl && "value" in target.inputEl) {
				target.inputEl.value = value;
			}
			if (target.element && "value" in target.element) {
				target.element.value = value;
			}
		}
	} finally {
		node.__gjjOllamaAssistantRestoring = false;
	}
	rememberWorkflowValues(node);
}

function clampNumber(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, parsed));
}

function clampInteger(value, fallback, min, max) {
	return Math.round(clampNumber(value, fallback, min, max));
}

function randomSeedValue() {
	const max = 2147483647;
	try {
		const values = new Uint32Array(1);
		globalThis.crypto?.getRandomValues?.(values);
		if (values[0]) {
			return values[0] % (max + 1);
		}
	} catch (_) {}
	return Math.floor(Math.random() * (max + 1));
}

function toggleRandomSeedMode(node) {
	const randomEnabled = String(widgetValue(node, "seed_mode", DEFAULT_SAMPLING.seed_mode)) === "每次随机";
	const nextMode = randomEnabled ? "固定种子" : "每次随机";
	setWidgetValue(node, "seed_mode", nextMode);
	if (nextMode === "固定种子" && Number(widgetValue(node, "seed", 0)) <= 0) {
		setWidgetValue(node, "seed", randomSeedValue());
	}
	saveAssistantSettings(node);
	syncPanel(node);
}

function normalizeSampling(value = {}) {
	const source = value && typeof value === "object" ? value : {};
	const seedMode = String(source.seed_mode || DEFAULT_SAMPLING.seed_mode) === "固定种子" ? "固定种子" : "每次随机";
	return {
		temperature: clampNumber(source.temperature, DEFAULT_SAMPLING.temperature, 0, 2),
		max_tokens: clampInteger(source.max_tokens, DEFAULT_SAMPLING.max_tokens, 16, 8192),
		seed_mode: seedMode,
		seed: clampInteger(source.seed, DEFAULT_SAMPLING.seed, 0, 2147483647),
		top_k: clampInteger(source.top_k, DEFAULT_SAMPLING.top_k, 1, 1000),
		top_p: clampNumber(source.top_p, DEFAULT_SAMPLING.top_p, 0, 1),
		min_p: clampNumber(source.min_p, DEFAULT_SAMPLING.min_p, 0, 1),
		presence_penalty: clampNumber(source.presence_penalty, DEFAULT_SAMPLING.presence_penalty, -2, 2),
		frequency_penalty: clampNumber(source.frequency_penalty, DEFAULT_SAMPLING.frequency_penalty, -2, 2),
		repeat_penalty: clampNumber(source.repeat_penalty, DEFAULT_SAMPLING.repeat_penalty, 0, 3),
	};
}

function samplingFromWidgets(node) {
	const result = {};
	for (const name of SAMPLING_FIELDS) {
		result[name] = widgetValue(node, name, DEFAULT_SAMPLING[name]);
	}
	return normalizeSampling(result);
}

function normalizeAssistantSettings(settings) {
	const section = settings?.[USER_SETTINGS_SECTION] || settings || {};
	const templateText = String(section.system_prompt_templates || "").trim()
		|| templateItemsToText(section.templates);
	return {
		templateText,
		outputRule: String(section.system_prompt_output_rule || "").trim(),
		sampling: normalizeSampling(section.sampling),
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

function readTemplateConfig(node) {
	const settings = node.__gjjOllamaAssistantUserSettings || {};
	const templateFallback = workflowHasSavedValue(node, TEMPLATE_WIDGET) ? "" : settings.templateText || DEFAULT_TEMPLATE_TEXT;
	const rawTemplates = String(widgetValue(node, TEMPLATE_WIDGET, templateFallback) || templateFallback);
	const outputRule = String(widgetValue(node, OUTPUT_RULE_WIDGET, settings.outputRule || DEFAULT_OUTPUT_RULE) || "").trim();
	const templates = parseTemplateText(rawTemplates);
	return {
		outputRule,
		templates,
		signature: JSON.stringify([rawTemplates, outputRule]),
	};
}

function applyAssistantSettingsDefaults(node, settings) {
	if (!node || !settings) {
		return;
	}
	node.__gjjOllamaAssistantUserSettings = settings;
	if (node.__gjjOllamaAssistantPanel) {
		node.__gjjOllamaAssistantPanel.userSettings = settings;
	}
	const templateWidget = widget(node, TEMPLATE_WIDGET);
	if (templateWidget && !workflowHasSavedValue(node, TEMPLATE_WIDGET) && !String(templateWidget.value || "").trim() && settings.templateText) {
		setWidgetValue(node, TEMPLATE_WIDGET, settings.templateText);
	}
	const ruleWidget = widget(node, OUTPUT_RULE_WIDGET);
	if (ruleWidget && !workflowHasSavedValue(node, OUTPUT_RULE_WIDGET) && !String(ruleWidget.value || "").trim() && settings.outputRule) {
		setWidgetValue(node, OUTPUT_RULE_WIDGET, settings.outputRule);
	}
	const sampling = normalizeSampling(settings.sampling);
	for (const name of SAMPLING_FIELDS) {
		const target = widget(node, name);
		if (target && !workflowHasSavedValue(node, name) && (target.value == null || target.value === "")) {
			setWidgetValue(node, name, sampling[name]);
		}
	}
}

function assistantSettingsValuesFromNode(node, options = {}) {
	const includeTemplate = options.includeTemplate !== false;
	const values = {
		system_prompt_output_rule: String(widgetValue(node, OUTPUT_RULE_WIDGET, "") || "").trim(),
		sampling: samplingFromWidgets(node),
	};
	if (includeTemplate) {
		const templateText = String(widgetValue(node, TEMPLATE_WIDGET, "") || "");
		values.system_prompt_templates = templateText;
		values.templates = templateTextToItems(templateText);
	}
	return values;
}

async function saveAssistantSettingsNow(node, options = {}) {
	const state = node.__gjjOllamaAssistantPanel;
	if (state) {
		clearTimeout(state.saveTimer);
	}
	const response = await api.fetchApi(USER_SETTINGS_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			section: USER_SETTINGS_SECTION,
			values: assistantSettingsValuesFromNode(node, options),
		}),
	});
	const data = await response.json();
	if (!response.ok || !data?.ok) {
		throw new Error(data?.error || "保存失败");
	}
	const normalized = normalizeAssistantSettings(data.settings || {});
	assistantSettingsPromise = Promise.resolve(normalized);
	if (state) {
		state.userSettings = normalized;
	}
	return data;
}

function saveAssistantSettings(node) {
	const state = node.__gjjOllamaAssistantPanel;
	if (!state) {
		return;
	}
	clearTimeout(state.saveTimer);
	state.saveTimer = setTimeout(() => {
		saveAssistantSettingsNow(node, { includeTemplate: false })
			.catch(() => {});
	}, 450);
}

function flashSaveButton(button, ok, message = "") {
	if (!button) {
		return;
	}
	clearTimeout(button.__gjjOllamaAssistantSaveTimer);
	button.disabled = false;
	button.textContent = ok ? "已保存" : "保存失败";
	button.title = ok
		? "已保存到 presets/gjj_user_settings.json，新建节点会调用此模板"
		: message || "保存失败";
	button.classList.toggle("active", ok);
	button.__gjjOllamaAssistantSaveTimer = setTimeout(() => {
		button.textContent = "💾";
		button.title = "保存当前系统提示词模板到 presets/gjj_user_settings.json，供新建节点调用";
		button.classList.remove("active");
		button.__gjjOllamaAssistantSaveTimer = null;
	}, 1300);
}

function saveTemplateDefaults(node, button) {
	if (!node || button?.disabled) {
		return;
	}
	if (button) {
		clearTimeout(button.__gjjOllamaAssistantSaveTimer);
		button.disabled = true;
		button.textContent = "保存中";
		button.title = "正在保存当前提示词模板...";
	}
	saveAssistantSettingsNow(node, { includeTemplate: true })
		.then(() => flashSaveButton(button, true))
		.catch((error) => flashSaveButton(button, false, error?.message || ""));
}

function templatePrompt(config, item) {
	if (!item?.text) {
		return "";
	}
	const outputRule = String(config?.outputRule || "").trim();
	return [item.text.trim(), outputRule].filter(Boolean).join("\n");
}

function resizeNode(node) {
	GJJ_Utils.scheduleRefreshNode(node, {
		minWidth: 470,
		minHeight: 92,
		preserveWidth: true,
	});
}

function hideBackerWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		GJJ_Utils.hideWidget(widget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGETS);
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
}

function restoreUserPromptWidget(node) {
	const target = widget(node, USER_PROMPT_WIDGET);
	if (!target) {
		return null;
	}
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
	target.options.tooltip = target.options.tooltip || "输入需要生成、翻译或结合图片处理的内容；可在左侧小圆点外接 STRING。";
	target.computeSize = undefined;
	target.getHeight = undefined;
	target.draw = undefined;
	target.last_y = 0;
	target.computedHeight = undefined;
	target.margin_top = undefined;
	target.size = undefined;
	if (target.element?.style) {
		target.element.style.display = "";
		target.element.style.height = "";
		target.element.style.margin = "";
		target.element.style.padding = "";
	}
	if (target.inputEl?.style) {
		target.inputEl.style.display = "";
		target.inputEl.style.height = "";
		target.inputEl.style.margin = "";
		target.inputEl.style.padding = "";
	}
	return target;
}

function disconnectAndRemoveInput(node, index) {
	if (!node || index < 0) {
		return;
	}
	try { node.disconnectInput?.(index); } catch (_) {}
	if (typeof node.removeInput === "function") {
		node.removeInput(index);
	} else if (Array.isArray(node.inputs)) {
		node.inputs.splice(index, 1);
	}
}

function ensureUserPromptInput(node) {
	if (!Array.isArray(node?.inputs)) {
		node.inputs = [];
	}
	let promptInput = null;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const widgetName = String(input?.widget?.name || "");
		const isPrompt = USER_PROMPT_HIDDEN_NAMES.has(name) || USER_PROMPT_HIDDEN_NAMES.has(widgetName);
		if (!isPrompt) {
			continue;
		}
		if (!promptInput) {
			promptInput = input;
		} else {
			disconnectAndRemoveInput(node, index);
		}
	}
	if (!promptInput) {
		node.addInput?.(USER_PROMPT_WIDGET, USER_PROMPT_INPUT_TYPE);
		promptInput = node.inputs[node.inputs.length - 1];
	}
	if (!promptInput) {
		return;
	}
	promptInput.name = USER_PROMPT_WIDGET;
	promptInput.type = USER_PROMPT_INPUT_TYPE;
	promptInput.label = "指令 / 原文";
	promptInput.localized_name = "指令 / 原文";
	promptInput.tooltip = "外接 STRING 时作为用户提示词；未连接时使用面板里的原生文本框。";
	promptInput.widget = { name: USER_PROMPT_WIDGET };
}

function placeUserPromptWidget(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const prompt = widget(node, USER_PROMPT_WIDGET);
	const panel = widget(node, PANEL_WIDGET);
	if (!prompt || !panel) {
		return;
	}
	const promptIndex = node.widgets.indexOf(prompt);
	if (promptIndex >= 0) {
		node.widgets.splice(promptIndex, 1);
	}
	const panelIndex = Math.max(0, node.widgets.indexOf(panel));
	node.widgets.splice(panelIndex + 1, 0, prompt);
}

function stabilizeUserPromptInput(node) {
	restoreUserPromptWidget(node);
	ensureUserPromptInput(node);
	placeUserPromptWidget(node);
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

function selectField(title, options) {
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
		return line;
	}
	line.append(name, control);
	return line;
}

function parameterField(label, control, action = null) {
	const line = labelledField(label, control, action);
	line.classList.add("gjj-ia-param");
	return line;
}

function syncInputValue(control, value) {
	if (document.activeElement !== control && control.value !== String(value ?? "")) {
		control.value = String(value ?? "");
	}
}

function sortModelNames(values) {
	const seen = new Set();
	const unique = [];
	for (const value of values || []) {
		const name = String(value || "").trim();
		if (!name) {
			continue;
		}
		const key = name.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(name);
	}
	return unique.sort((a, b) => {
		const left = String(a || "").trim();
		const right = String(b || "").trim();
		const lengthDiff = left.length - right.length;
		return lengthDiff || left.localeCompare(right);
	});
}

function modelChoices(node) {
	const modelWidget = widget(node, "model");
	let values = modelWidget?.options?.values;
	if (typeof values === "function") {
		try {
			values = values();
		} catch (_) {
			values = [];
		}
	}
	values = Array.isArray(values) ? values.map((value) => String(value || "").trim()).filter(Boolean) : [];
	const selected = String(modelWidget?.value || "").trim();
	if (selected && !values.includes(selected)) {
		values.unshift(selected);
	}
	return sortModelNames(values);
}

function renderModelButtons(node) {
	const state = node.__gjjOllamaAssistantPanel;
	if (!state) {
		return;
	}
	const selected = String(widgetValue(node, "model", ""));
	const values = modelChoices(node);
	const signature = JSON.stringify([selected, values]);
	if (state.modelSignature === signature) {
		return;
	}
	state.modelSignature = signature;
	const select = state.modelSelect;
	if (!select) {
		return;
	}
	select.replaceChildren();
	if (!values.length) {
		const empty = document.createElement("option");
		empty.value = "";
		empty.textContent = "未发现 Ollama 模型，请检查地址后刷新";
		select.appendChild(empty);
		select.disabled = true;
		return;
	}
	select.disabled = false;
	for (const name of values) {
		const option = document.createElement("option");
		option.value = name;
		option.textContent = name;
		select.appendChild(option);
	}
	select.value = values.includes(selected) ? selected : values[0] || "";
	select.title = select.value ? `当前 Ollama 模型：${select.value}` : "选择 Ollama 模型";
}

function renderTemplateButtons(node, config) {
	const state = node.__gjjOllamaAssistantPanel;
	if (!state || state.templateSignature === config.signature) {
		return;
	}
	state.templateSignature = config.signature;
	state.templateConfig = config;
	state.templates.replaceChildren();
	state.templateButtons = new Map();
	for (const item of config.templates) {
		const label = String(item.title || item.key || "模板").replace(/\s+/g, "");
		const choice = button(label, `设置系统提示词模板：${label}`, () => {
			setWidgetValue(node, "system_prompt", templatePrompt(config, item));
			syncPanel(node);
		});
		state.templateButtons.set(item.key, { button: choice, item });
		state.templates.appendChild(choice);
	}
}

function syncPanel(node) {
	const state = node.__gjjOllamaAssistantPanel;
	if (!state) {
		return;
	}
	const thinking = String(widgetValue(node, "thinking_mode", "关闭思考")) === "开启思考";
	const unload = String(widgetValue(node, "model_keep_alive", "保持模型")) === "卸载模型";
	state.thinking.textContent = "💭";
	state.thinking.title = thinking
		? "思考模式：开。点击关闭模型思考。"
		: "思考模式：关。点击开启模型思考。";
	state.thinking.classList.toggle("active", thinking);
	state.thinking.setAttribute("aria-pressed", thinking ? "true" : "false");
	state.keepAlive.textContent = "🧠";
	state.keepAlive.title = unload
		? "模型处理：用后卸载。点击改为模型常驻。"
		: "模型处理：模型常驻。点击改为用后卸载。";
	state.keepAlive.classList.toggle("active", !unload);
	state.keepAlive.setAttribute("aria-pressed", unload ? "false" : "true");
	if (state.modelButton) {
		const selectedModel = String(widgetValue(node, "model", "") || "").trim();
		state.modelButton.textContent = "🤖";
		state.modelButton.title = selectedModel
			? `当前模型：${selectedModel}。点击展开模型设置。`
			: "当前模型：未选择。点击展开模型设置。";
	}
	state.settingsButton.textContent = "⚙️";
	state.settingsButton.title = state.expanded
		? "收起 Ollama 地址、模型、参数和提示词设置"
		: "展开 Ollama 地址、模型、参数和提示词设置";
	state.settingsButton.classList.toggle("active", state.expanded);
	state.settings.style.display = state.expanded ? "flex" : "none";
	if (state.randomSeed) {
		const randomEnabled = String(widgetValue(node, "seed_mode", DEFAULT_SAMPLING.seed_mode)) === "每次随机";
		state.randomSeed.textContent = "🎲";
		state.randomSeed.classList.toggle("active", randomEnabled);
		state.randomSeed.title = randomEnabled
			? "随机种：开。每次执行自动变化 seed。"
			: "随机种：关。使用当前固定 seed。";
		state.randomSeed.setAttribute("aria-pressed", randomEnabled ? "true" : "false");
	}

	syncInputValue(state.host, widgetValue(node, "ollama_host", "http://127.0.0.1:11434"));
	syncInputValue(state.temperature, widgetValue(node, "temperature", 0.7));
	syncInputValue(state.maxTokens, widgetValue(node, "max_tokens", 1024));
	syncInputValue(state.modelSelect, widgetValue(node, "model", ""));
	syncInputValue(state.seedMode, widgetValue(node, "seed_mode", DEFAULT_SAMPLING.seed_mode));
	syncInputValue(state.seed, widgetValue(node, "seed", DEFAULT_SAMPLING.seed));
	syncInputValue(state.topK, widgetValue(node, "top_k", DEFAULT_SAMPLING.top_k));
	syncInputValue(state.topP, widgetValue(node, "top_p", DEFAULT_SAMPLING.top_p));
	syncInputValue(state.minP, widgetValue(node, "min_p", DEFAULT_SAMPLING.min_p));
	syncInputValue(state.presencePenalty, widgetValue(node, "presence_penalty", DEFAULT_SAMPLING.presence_penalty));
	syncInputValue(state.frequencyPenalty, widgetValue(node, "frequency_penalty", DEFAULT_SAMPLING.frequency_penalty));
	syncInputValue(state.repeatPenalty, widgetValue(node, "repeat_penalty", DEFAULT_SAMPLING.repeat_penalty));
	syncInputValue(state.systemPrompt, widgetValue(node, "system_prompt", ""));
	syncInputValue(state.templateEditor, widgetValue(node, TEMPLATE_WIDGET, state.userSettings?.templateText || DEFAULT_TEMPLATE_TEXT));
	syncInputValue(state.outputRule, widgetValue(node, OUTPUT_RULE_WIDGET, state.userSettings?.outputRule || DEFAULT_OUTPUT_RULE));
	const templateConfig = readTemplateConfig(node);
	renderTemplateButtons(node, templateConfig);
	const currentPrompt = String(widgetValue(node, "system_prompt", ""));
	for (const entry of state.templateButtons?.values?.() || []) {
		entry.button.classList.toggle("active", currentPrompt === templatePrompt(state.templateConfig, entry.item));
	}
	renderModelButtons(node);
	resizeNode(node);
}

function buildSettings(node) {
	const settings = document.createElement("div");
	settings.className = "gjj-ia-settings";

	const host = textField("text", "本机 Ollama 服务地址");
	host.placeholder = "http://127.0.0.1:11434";
	host.addEventListener("change", () => {
		setWidgetValue(node, "ollama_host", host.value.trim());
		setTimeout(() => renderModelButtons(node), 1200);
	});

	const numeric = document.createElement("div");
	numeric.className = "gjj-ia-numeric";
	const temperature = textField("number", "控制采样随机性。数值越低越稳定、越容易复现；数值越高越发散、同提示词更容易产生不同表达。建议 0.7-1.1；想要同提示词每次更不一样可用 0.9-1.2。");
	temperature.min = "0";
	temperature.max = "2";
	temperature.step = "0.1";
	temperature.addEventListener("change", () => {
		const value = Math.max(0, Math.min(2, Number(temperature.value) || 0));
		setWidgetValue(node, "temperature", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const maxTokens = textField("number", "限制本次最多生成多少 token。值越大越能输出长表格、长分镜或长故事，但会增加耗时；如果输出经常截断，调大这里。");
	maxTokens.min = "16";
	maxTokens.max = "8192";
	maxTokens.step = "1";
	maxTokens.addEventListener("change", () => {
		const value = Math.max(16, Math.min(8192, Math.round(Number(maxTokens.value) || 1024)));
		setWidgetValue(node, "max_tokens", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const seedMode = selectField("控制 seed 的使用方式。每次随机会在执行时自动生成新 seed，让相同提示词每次更容易不同；固定种子会使用下方 seed，方便复现。", ["每次随机", "固定种子"]);
	seedMode.addEventListener("change", () => {
		setWidgetValue(node, "seed_mode", seedMode.value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const seed = textField("number", "固定种子数，仅在“固定种子”模式生效。同模型、同提示词、同采样参数下，固定 seed 会尽量复现相同结果；改 seed 会改变输出。");
	seed.min = "0";
	seed.max = "2147483647";
	seed.step = "1";
	seed.addEventListener("change", () => {
		const value = Math.max(0, Math.min(2147483647, Math.round(Number(seed.value) || 0)));
		setWidgetValue(node, "seed", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const topK = textField("number", "每一步只从概率最高的 K 个候选 token 中采样。值越小越稳，值越大候选越多、变化更丰富。建议 40-100；想要更多变化可用 80 左右。");
	topK.min = "1";
	topK.max = "1000";
	topK.step = "1";
	topK.addEventListener("change", () => {
		const value = Math.max(1, Math.min(1000, Math.round(Number(topK.value) || DEFAULT_SAMPLING.top_k)));
		setWidgetValue(node, "top_k", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const topP = textField("number", "核采样阈值。模型从累计概率不超过该比例的候选集中采样；越接近 1，候选越多、结果越开放。建议 0.9-0.98。");
	topP.min = "0";
	topP.max = "1";
	topP.step = "0.01";
	topP.addEventListener("change", () => {
		const value = Math.max(0, Math.min(1, Number(topP.value) || 0));
		setWidgetValue(node, "top_p", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const minP = textField("number", "按最高概率 token 的相对比例过滤低概率候选。适当提高可减少离谱词，过高会变保守；想要变化但保持质量可用 0.02-0.08。");
	minP.min = "0";
	minP.max = "1";
	minP.step = "0.01";
	minP.addEventListener("change", () => {
		const value = Math.max(0, Math.min(1, Number(minP.value) || 0));
		setWidgetValue(node, "min_p", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const presencePenalty = textField("number", "降低已经出现过的内容再次出现的概率，鼓励模型引入新细节。值越高越不容易重复，但过高会跑题。建议 0.2-0.6。");
	presencePenalty.min = "-2";
	presencePenalty.max = "2";
	presencePenalty.step = "0.05";
	presencePenalty.addEventListener("change", () => {
		const value = Math.max(-2, Math.min(2, Number(presencePenalty.value) || 0));
		setWidgetValue(node, "presence_penalty", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const frequencyPenalty = textField("number", "按词语重复次数惩罚高频词，减少同一句式、同一描述反复出现。值越高越少重复，过高可能影响固定格式。建议 0.1-0.4。");
	frequencyPenalty.min = "-2";
	frequencyPenalty.max = "2";
	frequencyPenalty.step = "0.05";
	frequencyPenalty.addEventListener("change", () => {
		const value = Math.max(-2, Math.min(2, Number(frequencyPenalty.value) || 0));
		setWidgetValue(node, "frequency_penalty", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	const repeatPenalty = textField("number", "Ollama 的重复惩罚系数。1.0 基本不惩罚；大于 1 会抑制重复片段。表格/分镜任务建议 1.1-1.25，过高可能破坏固定格式。");
	repeatPenalty.min = "0";
	repeatPenalty.max = "3";
	repeatPenalty.step = "0.05";
	repeatPenalty.addEventListener("change", () => {
		const value = Math.max(0, Math.min(3, Number(repeatPenalty.value) || DEFAULT_SAMPLING.repeat_penalty));
		setWidgetValue(node, "repeat_penalty", value);
		saveAssistantSettings(node);
		syncPanel(node);
	});
	numeric.append(
		parameterField("🌡 温度", temperature),
		parameterField("📐 最大长度", maxTokens),
		parameterField("🎲 种子模式", seedMode),
		parameterField("🔢 固定种子", seed),
		parameterField("🎯 Top K", topK),
		parameterField("🧭 Top P", topP),
		parameterField("⚖️ Min P", minP),
		parameterField("✨ 出现惩罚", presencePenalty),
		parameterField("🔁 频率惩罚", frequencyPenalty),
		parameterField("🚫 重复惩罚", repeatPenalty),
	);

	const modelTitle = document.createElement("div");
	modelTitle.className = "gjj-ia-subtitle";
	const refresh = button("🔄", "按照当前 Ollama 地址重新获取模型列表", () => {
		setWidgetValue(node, "ollama_host", String(widgetValue(node, "ollama_host", "")).trim());
		setTimeout(() => renderModelButtons(node), 120);
		setTimeout(() => renderModelButtons(node), 1200);
	});
	modelTitle.append("🤖 Ollama 模型", refresh);
	const modelSelect = selectField("选择 Ollama 模型", []);
	modelSelect.addEventListener("change", () => {
		if (!modelSelect.value) {
			return;
		}
		setWidgetValue(node, "model", modelSelect.value);
		renderModelButtons(node);
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

	const templateEditor = document.createElement("textarea");
	templateEditor.className = "gjj-ia-textarea templates";
	templateEditor.placeholder = "每块一个按钮：\n【🧡反推】系统提示词正文\n\n【🎬分镜】系统提示词正文\n---\n【🌏翻译】系统提示词正文";
	protect(templateEditor);
	templateEditor.addEventListener("input", () => {
		setWidgetValue(node, TEMPLATE_WIDGET, templateEditor.value);
		syncPanel(node);
	});
	const saveTemplates = button("💾", "保存当前系统提示词模板到 presets/gjj_user_settings.json，供新建节点调用", () => {
		saveTemplateDefaults(node, saveTemplates);
	});
	saveTemplates.classList.add("compact");

	const outputRule = document.createElement("textarea");
	outputRule.className = "gjj-ia-textarea rule";
	outputRule.placeholder = "点击模板按钮时追加到系统提示词正文之后，可留空。";
	protect(outputRule);
	outputRule.addEventListener("input", () => {
		setWidgetValue(node, OUTPUT_RULE_WIDGET, outputRule.value);
		saveAssistantSettings(node);
		syncPanel(node);
	});

	settings.append(
		labelledField("🔌 Ollama 地址", host),
		numeric,
		modelTitle,
		labelledField("🤖 模型", modelSelect),
		labelledField("🧩 系统提示词模板", templateEditor, saveTemplates),
		labelledField("🚫 输出约束", outputRule),
		labelledField("🧾 当前系统提示词", systemPrompt),
	);

	return {
		settings,
		host,
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
		modelSelect,
		systemPrompt,
		templateEditor,
		saveTemplates,
		outputRule,
	};
}

function createPanel(node) {
	if (node.__gjjOllamaAssistantPanel || typeof node.addDOMWidget !== "function") {
		return;
	}
	const root = document.createElement("div");
	root.className = "gjj-ia-panel";
	protect(root);
	const style = document.createElement("style");
	style.textContent = `
		.gjj-ia-panel, .gjj-ia-panel * { box-sizing:border-box; }
		.gjj-ia-panel { display:flex; flex-direction:column; gap:7px; width:100%; padding:2px 0 4px; color:#dce6e8; font:12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
		.gjj-ia-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:5px; overflow:visible; padding:0 0 3px; scrollbar-width:thin; }
		.gjj-ia-templates { display:contents; }
		.gjj-ia-button { flex:0 0 auto; height:27px; padding:0 9px; border:1px solid #3d5159; border-radius:6px; background:#172127; color:#dbe6e9; font:700 12px/25px system-ui, sans-serif; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
		.gjj-ia-button.compact { width:auto; min-width:28px; max-width:74px; height:22px; padding:0 7px; font-size:11px; line-height:20px; }
		.gjj-ia-button:disabled { opacity:.72; cursor:wait; }
		.gjj-ia-button:hover { background:#24333b; border-color:#5f8590; }
		.gjj-ia-button.active { background:#24452d; border-color:#65a271; color:#ebffee; }
		.gjj-ia-settings { display:none; flex-direction:column; gap:7px; padding:8px; border:1px solid rgba(73,93,101,.7); border-radius:9px; background:rgba(15,22,26,.88); }
		.gjj-ia-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
		.gjj-ia-label, .gjj-ia-subtitle { color:#aebfc4; font-weight:700; font-size:11px; letter-spacing:.02em; }
		.gjj-ia-label-row { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
		.gjj-ia-label-row .gjj-ia-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-ia-input, .gjj-ia-textarea { width:100%; border:1px solid #334850; border-radius:6px; background:#10181c; color:#eef5f5; padding:5px 7px; outline:none; font:12px/1.4 system-ui, sans-serif; }
		.gjj-ia-input { height:29px; }
		.gjj-ia-input:focus, .gjj-ia-textarea:focus { border-color:#6a9dae; background:#111e23; }
		.gjj-ia-numeric { display:flex; flex-wrap:wrap; align-items:flex-start; gap:7px; width:100%; }
		.gjj-ia-numeric .gjj-ia-param { flex:1 1 128px; min-width:126px; max-width:190px; display:flex; flex-direction:row; align-items:center; gap:6px; padding:5px 6px; border:1px solid rgba(51,72,80,.72); border-radius:6px; background:rgba(16,24,28,.58); }
		.gjj-ia-numeric .gjj-ia-param .gjj-ia-label { flex:0 0 auto; max-width:72px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-ia-numeric .gjj-ia-param .gjj-ia-input { flex:1 1 54px; min-width:50px; height:27px; padding:4px 6px; }
		.gjj-ia-subtitle { display:flex; justify-content:space-between; align-items:center; margin-top:2px; }
		.gjj-ia-subtitle .gjj-ia-button { height:24px; font-size:11px; line-height:22px; }
		.gjj-ia-models { display:flex; flex-wrap:wrap; gap:5px; min-height:28px; }
		.gjj-ia-models .gjj-ia-button { max-width:100%; font-weight:500; }
		.gjj-ia-empty { color:#8b9ba1; font-size:11px; padding:5px 0; }
		.gjj-ia-textarea { min-height:86px; resize:vertical; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; }
		.gjj-ia-textarea.small { min-height:60px; }
		.gjj-ia-textarea.rule { min-height:48px; }
		.gjj-ia-textarea.templates { min-height:118px; }
	`;
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-ia-toolbar";
	const templates = document.createElement("div");
	templates.className = "gjj-ia-templates";
	const modelButton = button("🤖", "当前模型。点击展开模型设置。", () => {
		node.__gjjOllamaAssistantPanel.expanded = true;
		syncPanel(node);
	});
	const thinking = button("💭", "思考模式：关。点击开启模型思考。", () => {
		const value = String(widgetValue(node, "thinking_mode", "关闭思考")) === "开启思考" ? "关闭思考" : "开启思考";
		setWidgetValue(node, "thinking_mode", value);
		syncPanel(node);
	});
	const keepAlive = button("🧠", "模型处理：模型常驻。点击改为用后卸载。", () => {
		const value = String(widgetValue(node, "model_keep_alive", "保持模型")) === "保持模型" ? "卸载模型" : "保持模型";
		setWidgetValue(node, "model_keep_alive", value);
		syncPanel(node);
	});
	const randomSeed = button("🎲", "切换随机种模式", () => {
		toggleRandomSeedMode(node);
	});
	const settingsButton = button("⚙️", "展开 Ollama 地址、模型、参数和提示词设置", () => {
		node.__gjjOllamaAssistantPanel.expanded = !node.__gjjOllamaAssistantPanel.expanded;
		syncPanel(node);
	});
	toolbar.append(templates, modelButton, thinking, keepAlive, randomSeed, settingsButton);

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
	node.__gjjOllamaAssistantPanel = {
		root,
		domWidget,
		templates,
		templateButtons: new Map(),
		modelButton,
		thinking,
		keepAlive,
		randomSeed,
		settingsButton,
		expanded: false,
		...settingsState,
	};
	loadAssistantSettings().then((settings) => {
		applyAssistantSettingsDefaults(node, settings);
		syncPanel(node);
	});

	const index = node.widgets?.indexOf(domWidget) ?? -1;
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(domWidget);
	}
	stabilizeUserPromptInput(node);
	syncPanel(node);
	setTimeout(() => syncPanel(node), 120);
	setTimeout(() => syncPanel(node), 1200);
}

function stabilize(node) {
	if (!node || String(node.comfyClass || node.type || "") !== NODE_TYPE) {
		return;
	}
	hideBackerWidgets(node);
	createPanel(node);
	stabilizeUserPromptInput(node);
	syncPanel(node);
}

function schedule(node, delay = 0) {
	setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.OllamaAssistant.Panel",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this);
			schedule(this, 80);
			schedule(this, 1250);
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
		if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) {
			schedule(node);
		}
	},
});

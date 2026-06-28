import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODE = "GJJ_TemplatePrompt";
const TEMPLATE_WIDGET = "template_text";
const VALUES_WIDGET = "values_json";
const BINDINGS_WIDGET = "bindings_json";
const SCHEMA_WIDGET = "schema_json";
const EXTERNAL_TEMPLATE_INPUT = "external_template";
const DOM_WIDGET = "gjj_template_prompt_dom";
const DEFAULT_TEMPLATE = "一张{{主体}}的照片，{{风格}}，细节丰富";
const DEFAULT_WIDTH = 320;
const MIN_HEIGHT = 92;
const STYLE_ID = "gjj-template-prompt-style";
const MAX_BATCH_PROMPTS = 1000;
const USER_SETTINGS_SECTION = "template_prompt";
const USER_SETTINGS_KEY = "default_template";
const SET_NODE_TYPE = "GJJ_SetNode";
const TEMPLATE_PARAMS_TYPE = "GJJ_TemplateParams";
const TEMPLATE_PARAMS_SCHEMA = "gjj_template_params_schema";
let activeParamPopup = null;

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function getWidgetValue(node, name, fallback = "") {
	return String(getWidget(node, name)?.value ?? fallback ?? "");
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = String(value ?? "");
	if (widget.inputEl) widget.inputEl.value = widget.value;
	if (widget.element && "value" in widget.element) widget.element.value = widget.value;
	widget.callback?.(widget.value);
}

function safeJsonParse(value, fallback) {
	if (value && typeof value === "object") return value;
	try {
		return JSON.parse(String(value || ""));
	} catch (_) {
		return fallback;
	}
}

function slugKey(value) {
	return String(value || "").trim().replace(/[^0-9A-Za-z_\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "") || "param";
}

function outputLabel(value) {
	const source = String(value || "").trim();
	const cleaned = source
		.replace(/^[^0-9A-Za-z_\u4e00-\u9fff]+/u, "")
		.replace(/[\u200d\ufe0e\ufe0f]/g, "")
		.trim();
	return cleaned || source;
}

function parseDefaultExpression(expr) {
	const source = String(expr || "").trim();
	const close = source.endsWith(")") ? ")" : (source.endsWith("）") ? "）" : "");
	if (!close) return { label: source, defaultValue: "" };
	const openIndex = [...source].findIndex((char) => char === "(" || char === "（");
	if (openIndex <= 0) return { label: source, defaultValue: "" };
	const label = source.slice(0, openIndex).trim();
	const defaultValue = source.slice(openIndex + 1, -1).trim();
	if (!label || !defaultValue) return { label: source, defaultValue: "" };
	return { label, defaultValue };
}

function parsePlaceholderExpression(expr) {
	const source = String(expr || "").trim();
	if (source.includes(":")) {
		const [rawLabel, ...rest] = source.split(":");
		const parsedLabel = parseDefaultExpression(rawLabel);
		const label = parsedLabel.label;
		const optionText = rest.join(":");
		const options = optionText.split(/[,，、|]+/).map((item) => item.trim()).filter(Boolean);
		if (label && options.length >= 2) return {
			expr: source,
			label,
			outputLabel: outputLabel(label),
			keySource: label,
			kind: "choice",
			options,
			defaultValue: options.includes(parsedLabel.defaultValue) ? parsedLabel.defaultValue : options[0],
		};
	}
	const parsed = parseDefaultExpression(source);
	return {
		expr: source,
		label: parsed.label,
		outputLabel: outputLabel(parsed.label),
		keySource: parsed.label,
		kind: "text",
		options: [],
		defaultValue: parsed.defaultValue,
	};
}

function parseTemplate(templateText) {
	const fields = [];
	const seenNames = new Set();
	const seenKeys = new Map();
	const regex = /\{\{\s*([^{}]+?)\s*\}\}/g;
	let match;
	while ((match = regex.exec(String(templateText || DEFAULT_TEMPLATE)))) {
		const label = String(match[1] || "").trim();
		if (!label || seenNames.has(label)) continue;
		seenNames.add(label);
		const parsed = parsePlaceholderExpression(label);
		const base = slugKey(parsed.keySource);
		const count = seenKeys.get(base) || 0;
		seenKeys.set(base, count + 1);
		const key = count ? `${base}_${count + 1}` : base;
		fields.push({
			expr: parsed.expr,
			key,
			label: parsed.label,
			outputLabel: parsed.outputLabel,
			kind: parsed.kind,
			options: parsed.options,
			defaultValue: parsed.defaultValue,
			inputName: `param_${key}`,
			type: "STRING",
			outputIndex: 0,
			displayLabel: parsed.label === key ? parsed.label : `${parsed.label}（${key}）`,
		});
	}
	return fields;
}

function isChoiceField(field) {
	return String(field?.kind || "") === "choice" && Array.isArray(field?.options) && field.options.length > 0;
}

function bindableFields(fields) {
	return (fields || []).filter((field) => !isChoiceField(field));
}

function choiceFields(fields) {
	return (fields || []).filter(isChoiceField);
}

function uniqueValidOptions(items, options) {
	const valid = new Set((options || []).map((item) => String(item)));
	const result = [];
	for (const item of Array.isArray(items) ? items : [items]) {
		const text = String(item ?? "").trim();
		if (!valid.has(text) || result.includes(text)) continue;
		result.push(text);
	}
	return result;
}

function getChoiceValue(field, values = {}) {
	const sources = [
		field?.key,
		field?.label,
		field?.outputLabel,
		field?.expr,
		field?.expr ? slugKey(field.expr) : "",
	].filter(Boolean);
	for (const key of sources) {
		if (Object.prototype.hasOwnProperty.call(values || {}, key)) {
			return { found: true, raw: values[key] };
		}
	}
	return { found: false, raw: undefined };
}

function choiceSelections(field, values = {}) {
	const options = Array.isArray(field?.options) ? field.options.map((item) => String(item)) : [];
	const stored = getChoiceValue(field, values);
	if (stored.found) {
		const rawItems = Array.isArray(stored.raw) ? stored.raw : [stored.raw];
		const selected = uniqueValidOptions(rawItems, options);
		if (selected.length) return selected;
		if (Array.isArray(stored.raw) || String(stored.raw ?? "").trim() === "") return [];
	}
	const fallback = String(field?.defaultValue ?? options[0] ?? "").trim();
	return options.includes(fallback) ? [fallback] : (options.length ? [options[0]] : []);
}

function updateChoiceSelection(field, values, option, additive = false) {
	const selected = choiceSelections(field, values);
	const text = String(option ?? "").trim();
	if (!field.options.includes(text)) return selected;
	if (!additive) return [text];
	if (selected.includes(text)) {
		return selected.filter((item) => item !== text);
	}
	return [...selected, text];
}

function choiceCombinationCount(fields, values) {
	const choices = choiceFields(fields);
	if (!choices.length) return 0;
	return choices.reduce((total, field) => total * Math.max(1, choiceSelections(field, values).length), 1);
}

function choiceCombinations(fields, values) {
	const choices = choiceFields(fields);
	if (!choices.length) return [];
	let combinations = [{}];
	for (const field of choices) {
		const selected = choiceSelections(field, values);
		const options = selected.length ? selected : [""];
		const next = [];
		for (const combination of combinations) {
			for (const option of options) {
				next.push({ ...combination, [field.key]: option });
			}
		}
		combinations = next;
	}
	return combinations;
}

function fieldNames(fields) {
	return new Set(bindableFields(fields).map((field) => field.inputName));
}

function isExternalTemplateInput(input) {
	return input?.name === EXTERNAL_TEMPLATE_INPUT;
}

function externalTemplateInput(node) {
	return node?.inputs?.find(isExternalTemplateInput) || null;
}

function externalTemplateLinked(node) {
	syncInputLinksFromGraph(node);
	return inputHasLink(externalTemplateInput(node));
}

function currentNodeWidth(node) {
	const width = Number(node?.size?.[0]);
	return Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_WIDTH;
}

function setDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
}

function resetDomElementSize(el) {
	if (!el?.style) return;
	el.style.height = "";
	el.style.minHeight = "";
	el.style.maxHeight = "";
}

function visibleElementHeight(el) {
	if (!el) return 0;
	const style = window.getComputedStyle?.(el);
	if (style?.display === "none") return 0;
	const marginTop = Number.parseFloat(style?.marginTop || "0") || 0;
	const marginBottom = Number.parseFloat(style?.marginBottom || "0") || 0;
	return Math.ceil(Math.max(el.scrollHeight || 0, el.offsetHeight || 0, el.clientHeight || 0) + marginTop + marginBottom);
}

function templatePromptContentHeight(node) {
	const root = node?.__gjjTemplatePromptRoot;
	if (!root) return 36;
	resetDomElementSize(root);
	let height = 0;
	for (const child of root.children || []) height += visibleElementHeight(child);
	if (!height) height = Math.max(0, root.scrollHeight || 0);
	return Math.round(Math.max(0, height) + 4);
}

function invalidateWidgetLayout(node) {
	for (const widget of node?.widgets || []) {
		if (!widget) continue;
		delete widget.last_y;
		delete widget.y;
	}
}

function hideElement(el) {
	if (!el?.style) return;
	el.style.display = "none";
	el.style.pointerEvents = "none";
	el.style.height = "0px";
	el.style.minHeight = "0px";
	el.style.maxHeight = "0px";
	el.style.margin = "0px";
	el.style.padding = "0px";
	el.style.border = "0px";
	el.style.overflow = "hidden";
}

function hideWidget(widget) {
	if (!widget) return;
	if (!widget.__gjjTemplatePromptOriginal) {
		widget.__gjjTemplatePromptOriginal = {
			type: widget.type,
			computeSize: widget.computeSize,
			getHeight: widget.getHeight,
			draw: widget.draw,
			mouse: widget.mouse,
		};
	}
	widget.hidden = true;
	widget.disabled = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden" };
	for (const el of [widget.inputEl, widget.element, widget.widget]) hideElement(el);
}

function hideInternalWidgets(node) {
	for (const name of [TEMPLATE_WIDGET, VALUES_WIDGET, BINDINGS_WIDGET, SCHEMA_WIDGET]) {
		hideWidget(getWidget(node, name));
	}
}

function hideParamWidgets(node) {
	for (const widget of node?.widgets || []) {
		if (String(widget?.name || "").startsWith("param_")) hideWidget(widget);
	}
}

function hideParamInputs(node) {
	for (const input of node?.inputs || []) {
		if (!String(input?.name || "").startsWith("param_")) continue;
		input.hidden = true;
		input.visible = false;
	}
}

function restoreWidget(widget, fallbackType = "text") {
	if (!widget) return null;
	const original = widget.__gjjTemplatePromptOriginal || {};
	widget.hidden = false;
	widget.disabled = false;
	widget.serialize = true;
	widget.type = String(widget.type || "").startsWith("converted-widget:") ? (original.type || fallbackType) : (widget.type || fallbackType);
	if (original.computeSize) widget.computeSize = original.computeSize;
	else delete widget.computeSize;
	if (original.getHeight) widget.getHeight = original.getHeight;
	else delete widget.getHeight;
	if (original.draw) widget.draw = original.draw;
	else delete widget.draw;
	if (original.mouse) widget.mouse = original.mouse;
	else delete widget.mouse;
	widget.options = widget.options || {};
	delete widget.options.hidden;
	delete widget.options.display;
	for (const el of [widget.inputEl, widget.element, widget.widget]) {
		if (!el?.style) continue;
		el.style.display = "";
		el.style.pointerEvents = "";
		el.style.height = "";
		el.style.minHeight = "";
		el.style.maxHeight = "";
		el.style.margin = "";
		el.style.padding = "";
		el.style.border = "";
		el.style.overflow = "";
	}
	return widget;
}

function removeWidgetByName(node, name) {
	if (!Array.isArray(node?.widgets)) return false;
	const index = node.widgets.findIndex((widget) => widget?.name === name);
	if (index < 0) return false;
	node.widgets.splice(index, 1);
	return true;
}

function ensureParamWidget(node, field, value) {
	let widget = getWidget(node, field.inputName);
	if (!widget) {
		widget = node.addWidget?.("text", field.inputName, String(value ?? field.defaultValue ?? ""), () => {
			const template = activeTemplateForNode(node);
			const fields = parseTemplate(template);
			const nextValues = valuesFromDom(node, fields);
			saveState(node, template, fields, nextValues, bindingsForNode(node), { saveTemplate: shouldSaveInternalTemplate(node) });
		}, {
			serialize: true,
			multiline: false,
			display_name: field.label,
			tooltip: `模板参数：{{${field.expr || field.label}}}`,
		});
	}
	if (!widget) return null;
	restoreWidget(widget, "text");
	widget.name = field.inputName;
	widget.label = field.label;
	widget.localized_name = field.label;
	widget.display_name = field.label;
	widget.tooltip = `模板参数：{{${field.expr || field.label}}}`;
	widget.options = widget.options || {};
	widget.options.display_name = field.label;
	widget.options.tooltip = widget.tooltip;
	widget.options.multiline = false;
	widget.value = String(value ?? field.defaultValue ?? "");
	widget.callback = () => {
		const template = activeTemplateForNode(node);
		const fields = parseTemplate(template);
		const nextValues = valuesFromDom(node, fields);
		saveState(node, template, fields, nextValues, bindingsForNode(node), { saveTemplate: shouldSaveInternalTemplate(node) });
	};
	if (widget.inputEl) widget.inputEl.value = widget.value;
	if (widget.element && "value" in widget.element) widget.element.value = widget.value;
	return widget;
}

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.gjj-template-prompt{box-sizing:border-box;width:100%;padding:1px 0 2px 0;color:#dce7e2;font-family:system-ui,"Microsoft YaHei",sans-serif;pointer-events:auto;}
.gjj-template-prompt *{box-sizing:border-box;}
.gjj-template-prompt.external-template-linked .gjj-template-prompt-toolbar,
.gjj-template-prompt.external-template-linked .gjj-template-prompt-panel{display:none!important;}
.gjj-template-prompt-toolbar{display:flex;align-items:center;gap:4px;min-width:0;flex-wrap:wrap;}
.gjj-template-prompt-btn{height:23px;border:1px solid #44565f;border-radius:6px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 6px;font-size:11px;font-weight:650;white-space:nowrap;}
.gjj-template-prompt-btn:hover{background:#2c3b43;border-color:#6aa6b8;}
.gjj-template-prompt-count{color:#8ea0a8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-template-prompt-panel{display:none;flex-direction:column;gap:5px;margin-top:5px;padding:5px;border:1px solid #33464e;border-radius:8px;background:#0d1519;}
.gjj-template-prompt-template{width:100%;min-height:110px;resize:vertical;padding:7px 8px;border:1px solid #44565f;border-radius:7px;outline:none;background:#070f12;color:#dce7e2;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;}
.gjj-template-prompt-actions{display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap;}
.gjj-template-prompt-rows{display:flex;flex-direction:column;gap:4px;margin-top:4px;}
.gjj-template-prompt-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:5px;align-items:center;}
.gjj-template-prompt-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9c8cc;font-size:12px;}
.gjj-template-prompt-choice{display:flex;flex-wrap:wrap;gap:5px;min-width:0;}
.gjj-template-prompt-choice-row{display:flex;flex-wrap:wrap;gap:4px 5px;align-items:center;}
.gjj-template-prompt-choice-row .gjj-template-prompt-label{flex:0 0 auto;width:auto;max-width:100%;font-weight:800;color:#c8d7dc;}
.gjj-template-prompt-choice-separator{color:#78919b;font-size:11px;line-height:1;margin:1px 0 0 0;text-align:center;}
.gjj-template-prompt-choice-btn{min-height:24px;border:1px solid #33464e;border-radius:6px;background:#1b252b;color:#dce7e2;cursor:pointer;padding:0 7px;font-size:12px;font-weight:700;white-space:nowrap;}
.gjj-template-prompt-choice-btn:hover{background:#273943;border-color:#6aa6b8;}
.gjj-template-prompt-choice-btn.active{background:#194233;border-color:#64c78f;color:#e8fff1;box-shadow:0 0 0 1px rgba(100,199,143,.24) inset;}
.gjj-template-prompt-choice-action{min-height:22px;padding:0 6px;border-color:#4a5d66;background:#26323a;color:#c9d5d9;font-size:11px;font-weight:800;}
.gjj-template-prompt-choice-action:hover{background:#33434c;border-color:#78aaba;}
.gjj-template-prompt-bound{grid-column:1 / -1;border:1px solid #4f765e;border-radius:7px;background:#14251d;color:#c9f5d6;padding:6px 8px;font-size:11px;line-height:1.4;display:flex;justify-content:space-between;gap:6px;align-items:center;}
.gjj-template-prompt-empty{color:#8ea0a8;font-size:12px;padding:4px 0;}
.gjj-template-prompt-popup{position:fixed;z-index:100000;min-width:520px;width:min(720px,calc(100vw - 16px));max-width:calc(100vw - 16px);display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #45606a;border-radius:8px;background:#10191e;color:#dce7e2;box-shadow:0 12px 32px rgba(0,0,0,.45);font-family:system-ui,"Microsoft YaHei",sans-serif;}
.gjj-template-prompt-popup-head{display:flex;align-items:center;gap:6px;border-bottom:1px solid #263842;padding-bottom:5px;}
.gjj-template-prompt-popup-title{font-size:12px;font-weight:800;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gjj-template-prompt-search{height:26px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 8px;font-size:12px;outline:none;}
.gjj-template-prompt-columns{display:grid;grid-template-columns:minmax(190px,0.9fr) minmax(260px,1.1fr);gap:8px;min-height:120px;}
.gjj-template-prompt-col{min-width:0;display:flex;flex-direction:column;gap:5px;border:1px solid #263842;border-radius:7px;background:#071014;padding:6px;}
.gjj-template-prompt-col-head{display:flex;align-items:center;justify-content:space-between;gap:6px;color:#aebfc5;font-size:11px;font-weight:800;line-height:1.2;}
.gjj-template-prompt-col-count{color:#78919b;font-weight:700;}
.gjj-template-prompt-list{overflow:auto;min-height:70px;max-height:360px;display:flex;flex-direction:column;gap:3px;padding-right:2px;}
.gjj-template-prompt-item{display:flex;align-items:center;gap:7px;width:100%;border:0;border-radius:6px;background:transparent;color:#dce7e2;text-align:left;padding:6px;cursor:pointer;font-size:12px;}
.gjj-template-prompt-item:hover{background:#1f2c33;}
.gjj-template-prompt-item.active{background:#243c32;color:#d9ffe4;}
.gjj-template-prompt-item.matched{background:#14251d;border:1px solid #4f765e;color:#d9ffe4;}
.gjj-template-prompt-item.matched.active{background:#1f3a2b;border-color:#69b980;}
.gjj-template-prompt-item.unmatched{background:#241c10;border:1px solid #755830;color:#ffe0ad;}
.gjj-template-prompt-item.unmatched.active{background:#342613;border-color:#d4933d;}
.gjj-template-prompt-item.source-bound{background:#14251d;border:1px solid #4f765e;color:#d9ffe4;}
.gjj-template-prompt-item.source-bound.active{background:#1f3a2b;border-color:#69b980;}
.gjj-template-prompt-item.source-free{border:1px solid transparent;}
.gjj-template-prompt-status{flex:0 0 auto;width:18px;text-align:center;font-size:13px;}
.gjj-template-prompt-item-main{min-width:0;display:flex;flex-direction:column;gap:1px;}
.gjj-template-prompt-item-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800;color:#f1fff5;}
.gjj-template-prompt-item-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:#8fa2aa;}
`;
	document.head.appendChild(style);
}

function valuesFromDom(node, fields = null) {
	const parsedFields = fields || parseTemplate(activeTemplateForNode(node));
	const values = safeJsonParse(getWidgetValue(node, VALUES_WIDGET, "{}"), {});
	const stored = values && typeof values === "object" && !Array.isArray(values) ? values : {};
	const result = {};
	for (const field of parsedFields) {
		if (isChoiceField(field)) {
			result[field.key] = choiceSelections(field, stored);
			continue;
		}
		const widget = getWidget(node, field.inputName);
		if (widget && !widget.hidden) {
			const widgetValue = String(widget.value ?? "");
			result[field.key] = widgetValue || String(field.defaultValue ?? "");
		}
		else if (field.expr && field.expr in stored) result[field.key] = stored[field.expr];
		else if (field.expr && slugKey(field.expr) in stored) result[field.key] = stored[slugKey(field.expr)];
		else if (field.label && field.label in stored) result[field.key] = stored[field.label];
		else if (field.outputLabel && field.outputLabel in stored) result[field.key] = stored[field.outputLabel];
		else if (field.key in stored) result[field.key] = stored[field.key];
		else if (!(field.key in result)) result[field.key] = String(field.defaultValue ?? "");
	}
	return result;
}

function defaultValuesForFields(fields) {
	const result = {};
	for (const field of fields || []) {
		if (isChoiceField(field)) {
			const fallback = String(field.defaultValue ?? field.options?.[0] ?? "").trim();
			result[field.key] = fallback ? [fallback] : [];
		} else {
			result[field.key] = String(field.defaultValue ?? "");
		}
	}
	return result;
}

function resetStateForTemplate(node, template, fields, saveTemplate) {
	const values = defaultValuesForFields(fields);
	saveState(node, template, fields, values, {}, { saveTemplate });
	for (const field of bindableFields(fields)) {
		const widget = getWidget(node, field.inputName);
		if (!widget) continue;
		widget.value = String(values[field.key] ?? "");
		if (widget.inputEl) widget.inputEl.value = widget.value;
		if (widget.element && "value" in widget.element) widget.element.value = widget.value;
	}
	return values;
}

function bindingsForNode(node) {
	const bindings = safeJsonParse(getWidgetValue(node, BINDINGS_WIDGET, "{}"), {});
	return bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
}

function saveState(node, template, fields, values, bindings = null, options = {}) {
	const saveTemplate = options.saveTemplate !== false;
	if (saveTemplate) setWidgetValue(node, TEMPLATE_WIDGET, template || DEFAULT_TEMPLATE);
	setWidgetValue(node, VALUES_WIDGET, JSON.stringify(values || {}, null, 2));
	if (bindings) setWidgetValue(node, BINDINGS_WIDGET, JSON.stringify(bindings, null, 2));
	setWidgetValue(node, SCHEMA_WIDGET, JSON.stringify(fields, null, 2));
	node.properties = node.properties || {};
	if (saveTemplate) node.properties.gjj_template_prompt_template = template || DEFAULT_TEMPLATE;
	node.properties.gjj_template_prompt_values = values || {};
	node.properties.gjj_template_prompt_bindings = bindings || bindingsForNode(node);
	node.properties.gjj_template_prompt_fields = fields;
}

function inputHasLink(input) {
	return Array.isArray(input?.link) ? input.link.length > 0 : input?.link != null;
}

function graphLinks(node) {
	return node?.graph?.links || app.graph?.links || null;
}

function linkId(link) {
	return Array.isArray(link) ? link[0] : link?.id;
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkOriginSlot(link) {
	return Array.isArray(link) ? link[2] : link?.origin_slot;
}

function linkTargetId(link) {
	return Array.isArray(link) ? link[3] : link?.target_id;
}

function linkTargetSlot(link) {
	return Array.isArray(link) ? link[4] : link?.target_slot;
}

function getGraphLink(node, linkId) {
	const links = graphLinks(node);
	if (!links || linkId == null) return null;
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	if (links instanceof Map) return links.get(linkId) || links.get(String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function nodeType(node) {
	return node?.type || node?.comfyClass || node?.constructor?.type || "";
}

function getGraphNodeById(graph, id) {
	return graph?.getNodeById?.(Number(id)) || graph?._nodes?.find((node) => String(node?.id) === String(id)) || null;
}

function externalTemplateText(node) {
	const input = externalTemplateInput(node);
	if (!inputHasLink(input)) return "";
	const link = getGraphLink(node, Array.isArray(input.link) ? input.link[0] : input.link);
	const origin = getGraphNodeById(node?.graph || app.graph, linkOriginId(link));
	if (!origin) return "";
	const selector = globalThis.GJJ_PromptTemplateSelector;
	if (nodeType(origin) === "GJJ_PromptTemplateSelector" && selector?.selectedTemplateBody) {
		return String(selector.selectedTemplateBody(origin) || "");
	}
	return "";
}

function activeTemplateForNode(node) {
	if (externalTemplateLinked(node)) {
		const external = externalTemplateText(node).trim();
		if (external) return external;
	}
	return getWidgetValue(node, TEMPLATE_WIDGET, node?.properties?.gjj_template_prompt_template || DEFAULT_TEMPLATE);
}

function shouldSaveInternalTemplate(node) {
	return !externalTemplateLinked(node);
}

function disconnectInput(node, index) {
	try {
		if (typeof node.disconnectInput === "function") node.disconnectInput(index);
		else if (node.inputs?.[index]) node.inputs[index].link = null;
	} catch (_) {}
}

function removeInputAtIndex(node, index) {
	if (index < 0) return;
	disconnectInput(node, index);
	try { node.removeInput?.(index); }
	catch (_) { node.inputs?.splice?.(index, 1); }
}

function removeInputByName(node, name) {
	const index = node.inputs?.findIndex((input) => input?.name === name) ?? -1;
	removeInputAtIndex(node, index);
}

function syncInputLinksFromGraph(node) {
	if (!Array.isArray(node?.inputs)) return;
	const links = graphLinks(node);
	if (!links) return;
	const entries = links instanceof Map ? [...links.values()] : Array.isArray(links) ? links : Object.values(links);
	for (const input of node.inputs) {
		if (Array.isArray(input?.link) && input.link.length) continue;
		if (!Array.isArray(input?.link) && input?.link != null) continue;
		const index = node.inputs.indexOf(input);
		const link = entries.find((item) => String(linkTargetId(item)) === String(node.id) && Number(linkTargetSlot(item)) === index);
		if (link) input.link = linkId(link);
	}
}

function repairInputLinkSlots(node) {
	if (!Array.isArray(node?.inputs)) return;
	syncInputLinksFromGraph(node);
	for (let index = 0; index < node.inputs.length; index += 1) {
		const input = node.inputs[index];
		const link = getGraphLink(node, input?.link);
		if (!link) continue;
		if (Array.isArray(link)) {
			link[3] = node.id;
			link[4] = index;
			link[5] = input.type || "STRING";
		} else {
			link.target_id = node.id;
			link.target_slot = index;
			link.type = input.type || "STRING";
		}
	}
}

function ensureExternalTemplateInput(node) {
	let input = externalTemplateInput(node);
	if (!input) {
		node.addInput?.(EXTERNAL_TEMPLATE_INPUT, "GJJ_PROMPT");
		input = externalTemplateInput(node);
	}
	if (!input) return null;
	input.type = "GJJ_PROMPT";
	input.label = "外接模板";
	input.localized_name = "外接模板";
	input.display_name = "外接模板";
	input.tooltip = "可选。连接后优先使用外部模板，并隐藏节点内部设置和按钮；断开后恢复。";
	input.hidden = false;
	input.visible = true;
	delete input.widget;
	delete input.widget_name;
	input.forceInput = true;
	return input;
}

function ensureExternalTemplateInputLast(node) {
	const input = ensureExternalTemplateInput(node);
	if (!input || !Array.isArray(node?.inputs)) return input;
	const currentIndex = node.inputs.indexOf(input);
	if (currentIndex >= 0 && currentIndex !== node.inputs.length - 1 && !inputHasLink(input)) {
		node.inputs.splice(currentIndex, 1);
		node.inputs.push(input);
	}
	return input;
}

function setExternalTemplateMode(node, enabled) {
	const root = node?.__gjjTemplatePromptRoot;
	if (root) root.classList.toggle("external-template-linked", !!enabled);
	if (node?.__gjjTemplatePromptPanel && enabled) node.__gjjTemplatePromptPanel.style.display = "none";
	if (enabled) closeParamPopup();
}

function sourceLabelForBinding(node, name) {
	const options = globalThis.GJJ_VariableBroadcast?.getVisibleSetOptions?.(node?.graph) || [];
	const found = options.find((item) => item.value === name);
	return found?.label || localTemplateParamsOptions(node).find((item) => item.value === name)?.label || name;
}

function renderRows(node) {
	const rows = node?.__gjjTemplatePromptRows;
	if (!rows) return;
	const externalMode = externalTemplateLinked(node);
	setExternalTemplateMode(node, externalMode);
	const template = activeTemplateForNode(node);
	const fields = parseTemplate(template);
	const values = valuesFromDom(node, fields);
	const bindings = bindingsForNode(node);
	const saveOptions = { saveTemplate: !externalMode };
	const bindableKeys = new Set(bindableFields(fields).map((field) => field.key));
	for (const key of Object.keys(bindings)) {
		if (!bindableKeys.has(key)) delete bindings[key];
	}
	rows.replaceChildren();
	if (!fields.length) {
		const empty = document.createElement("div");
		empty.className = "gjj-template-prompt-empty";
		empty.textContent = "模板里写 {{参数名}} 后会在这里生成输入。";
		rows.appendChild(empty);
	}
	let choiceGroupSeen = false;
	for (const field of fields) {
		const binding = String(bindings[field.key] || "").trim();
		const choiceField = isChoiceField(field);
		if (choiceField && choiceGroupSeen) {
			const separator = document.createElement("div");
			separator.className = "gjj-template-prompt-choice-separator";
			separator.textContent = "---";
			rows.appendChild(separator);
		}
		if (choiceField) choiceGroupSeen = true;
		const row = document.createElement("div");
		row.className = `gjj-template-prompt-row${choiceField ? " gjj-template-prompt-choice-row" : ""}`;
		const label = document.createElement("div");
		label.className = "gjj-template-prompt-label";
		label.textContent = choiceField ? `${field.label}：` : field.label;
		label.title = `模板参数：{{${field.expr || field.label}}}`;
		if (choiceField) {
			const selected = new Set(choiceSelections(field, values));
			const saveChoiceValues = (selection) => {
				const nextValues = valuesFromDom(node, fields);
				nextValues[field.key] = selection;
				saveState(node, template, fields, nextValues, bindingsForNode(node), saveOptions);
				renderRows(node);
			};
			row.appendChild(label);
			const allButton = document.createElement("button");
			allButton.type = "button";
			allButton.className = "gjj-template-prompt-choice-btn gjj-template-prompt-choice-action";
			allButton.textContent = "全选";
			allButton.title = `选择 ${field.label} 的全部选项`;
			allButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				saveChoiceValues([...field.options]);
			});
			const clearButton = document.createElement("button");
			clearButton.type = "button";
			clearButton.className = "gjj-template-prompt-choice-btn gjj-template-prompt-choice-action";
			clearButton.textContent = "清除";
			clearButton.title = `清除 ${field.label} 的所有选择`;
			clearButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				saveChoiceValues([]);
			});
			row.append(allButton, clearButton);
			for (const option of field.options) {
				const btn = document.createElement("button");
				btn.type = "button";
				const active = selected.has(option);
				btn.className = `gjj-template-prompt-choice-btn${active ? " active" : ""}`;
				btn.textContent = option;
				btn.title = `${field.label}：${option}${active ? "（已选择）" : ""}；普通点击单选，Ctrl/Shift 点击多选`;
				btn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const nextValues = valuesFromDom(node, fields);
					nextValues[field.key] = updateChoiceSelection(field, nextValues, option, event.ctrlKey || event.shiftKey);
					saveState(node, template, fields, nextValues, bindingsForNode(node), saveOptions);
					renderRows(node);
				});
				row.appendChild(btn);
			}
		} else if (binding) {
			const bound = document.createElement("div");
			bound.className = "gjj-template-prompt-bound";
			const text = document.createElement("span");
			text.textContent = `⚡ 已接管：${sourceLabelForBinding(node, binding)}`;
			const clear = document.createElement("button");
			clear.type = "button";
			clear.className = "gjj-template-prompt-btn";
			clear.textContent = "解除";
			clear.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const next = bindingsForNode(node);
				delete next[field.key];
				saveState(node, template, fields, valuesFromDom(node, fields), next, saveOptions);
				stabilizeNode(node);
			});
			bound.append(text, clear);
			row.append(bound);
		} else {
			continue;
		}
		rows.appendChild(row);
	}
	const count = node.__gjjTemplatePromptCount;
	if (count) {
		const bindable = bindableFields(fields);
		const boundCount = bindable.filter((field) => bindings[field.key]).length;
		const choiceCount = choiceFields(fields).length;
		const comboCount = choiceCombinationCount(fields, values);
		count.textContent = `${fields.length} 参数${choiceCount ? ` · ${choiceCount} 按钮` : ""}${comboCount > 1 ? ` · ${comboCount} 组合` : ""}${boundCount ? ` · ${boundCount} 已接管` : ""}`;
	}
	const batchButton = node.__gjjTemplatePromptBatchButton;
	if (batchButton && !node.__gjjTemplatePromptBatchBusy) {
		const choiceCount = choiceFields(fields).length;
		const comboCount = choiceCombinationCount(fields, values);
		batchButton.disabled = choiceCount <= 0;
		batchButton.textContent = "🚀批量";
		batchButton.title = choiceCount > 0 ? `按已选按钮组合逐条加入队列：${Math.max(1, comboCount)} 条` : "模板中没有按钮组选项";
	}
	saveState(node, template, fields, values, bindings, saveOptions);
	refreshNode(node);
}

function ensureInputs(node, fields) {
	ensureExternalTemplateInputLast(node);
	const keep = fieldNames(fields);
	const bindings = bindingsForNode(node);
	const values = valuesFromDom(node, fields);
	for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		if (!name.startsWith("param_")) continue;
		const field = fields.find((item) => item.inputName === name);
		if (!keep.has(name) || (field && bindings[field.key])) removeInputByName(node, name);
	}
	for (const widget of [...(node.widgets || [])]) {
		const name = String(widget?.name || "");
		if (!name.startsWith("param_")) continue;
		const field = fields.find((item) => item.inputName === name);
		if (!field || bindings[field.key]) removeWidgetByName(node, name);
	}
	for (const field of bindableFields(fields)) {
		if (bindings[field.key]) {
			removeWidgetByName(node, field.inputName);
			continue;
		}
		ensureParamWidget(node, field, values[field.key]);
		let input = node.inputs?.find((item) => item?.name === field.inputName);
		if (!input) {
			node.addInput?.(field.inputName, "STRING");
			input = node.inputs?.find((item) => item?.name === field.inputName);
		}
		if (input) {
			input.type = "STRING";
			input.label = field.label;
			input.localized_name = field.label;
			input.display_name = field.label;
			input.tooltip = `模板参数：{{${field.label}}}`;
			input.widget = { name: field.inputName };
			input.hidden = false;
			input.visible = true;
			delete input.widget_name;
			delete input.forceInput;
		}
	}
	repairInputLinkSlots(node);
	ensureExternalTemplateInputLast(node);
}

function refreshNode(node, force = false) {
	if (!node) return;
	const widget = node.__gjjTemplatePromptDomWidget;
	const root = node.__gjjTemplatePromptRoot;
	const contentHeight = templatePromptContentHeight(node);
	if (widget && root) {
		resetDomElementSize(widget.element);
		resetDomElementSize(widget.inputEl);
		widget.computeSize = (width) => [Math.round(Number(width || currentNodeWidth(node))), domHeight(node)];
		widget.getHeight = () => domHeight(node);
	}
	const width = currentNodeWidth(node);
	const minHeight = MIN_HEIGHT;
	const height = Math.round(Math.max(minHeight, contentHeight + paramWidgetsHeight(node) + 8));
	invalidateWidgetLayout(node);
	if (force || Math.abs(Number(node.size?.[1] || 0) - height) > 2) {
		node.__gjjTemplatePromptSizing = true;
		try { node.setSize?.([width, height]); } finally { requestAnimationFrame(() => { node.__gjjTemplatePromptSizing = false; }); }
	}
	setDirty(node);
	if (!node.__gjjTemplatePromptRefreshFrame) {
		node.__gjjTemplatePromptRefreshFrame = requestAnimationFrame(() => {
			node.__gjjTemplatePromptRefreshFrame = null;
			resetDomElementSize(root);
			invalidateWidgetLayout(node);
			setDirty(node);
		});
	}
}

function domHeight(node) {
	return Math.round(Math.max(4, templatePromptContentHeight(node)));
}

function paramWidgetsHeight(node) {
	const visible = (node?.widgets || []).filter((widget) =>
		String(widget?.name || "").startsWith("param_") && !widget.hidden && !String(widget.type || "").startsWith("converted-widget:"));
	if (!visible.length) return 0;
	return visible.reduce((total, widget) => {
		const size = typeof widget.computeSize === "function" ? widget.computeSize(currentNodeWidth(node)) : null;
		const height = Array.isArray(size) ? Number(size[1]) : Number(widget.getHeight?.() || 24);
		return total + (Number.isFinite(height) && height > 0 ? height : 24) + 4;
	}, 0);
}

function closeParamPopup() {
	activeParamPopup?.remove?.();
	activeParamPopup = null;
}

function getVariableOptions(node) {
	const options = globalThis.GJJ_VariableBroadcast?.getVisibleSetOptions?.(node?.graph) || [];
	const merged = new Map();
	for (const item of options.map((item) => ({
		value: String(item.value || ""),
		label: String(item.label || item.value || ""),
		source: String(item.source || ""),
	})).filter((item) => item.value)) {
		merged.set(item.value, item);
	}
	for (const item of localTemplateParamsOptions(node)) {
		if (!merged.has(item.value)) merged.set(item.value, item);
	}
	return [...merged.values()];
}

function templateParamsFields(node) {
	const schema = safeJsonParse(node?.properties?.[TEMPLATE_PARAMS_SCHEMA], []);
	if (!Array.isArray(schema)) return [];
	return schema.map((field, index) => {
		const key = String(field?.key || field?.name || `param_${index + 1}`).trim();
		const label = String(field?.label || key).trim();
		return {
			key,
			label,
			inputName: String(field?.inputName || field?.input_name || `param_${key}`),
			outputIndex: Number.isFinite(Number(field?.outputIndex)) ? Number(field.outputIndex) : index,
		};
	}).filter((field) => field.key);
}

function localTemplateParamsOptions(node) {
	const graph = node?.graph || app.graph;
	const result = [];
	for (const source of graph?._nodes || []) {
		if (source === node || nodeType(source) !== TEMPLATE_PARAMS_TYPE) continue;
		for (const field of templateParamsFields(source)) {
			result.push({
				value: field.key,
				label: `${field.key} (模板参数 · ${field.label})`,
				source: `模板参数 · ${field.label}`,
				sourceNodeId: source.id,
				outputIndex: field.outputIndex,
				inputName: field.inputName,
			});
		}
	}
	return result;
}

function resolveLocalTemplateParamsSource(graph, name) {
	const target = String(name || "").trim();
	if (!target) return null;
	for (const source of graph?._nodes || []) {
		if (nodeType(source) !== TEMPLATE_PARAMS_TYPE) continue;
		for (const field of templateParamsFields(source)) {
			if (![field.key, field.label].includes(target)) continue;
			const input = source.inputs?.find((item) => item?.name === field.inputName);
			const link = getGraphLink(source, input?.link);
			if (link) {
				const originId = linkOriginId(link);
				const originSlot = linkOriginSlot(link);
				return [String(originId), Number(originSlot || 0)];
			}
			return [String(source.id), Number(field.outputIndex || 0)];
		}
	}
	return null;
}

function resolveBindingSource(graph, name) {
	const resolved = globalThis.GJJ_VariableBroadcast?.resolveVariableBroadcastSource?.(graph, name);
	if (Array.isArray(resolved) && resolved.length === 2) return resolved;
	return resolveLocalTemplateParamsSource(graph, name);
}

function openParamPopup(node, event) {
	closeParamPopup();
	const fields = bindableFields(parseTemplate(activeTemplateForNode(node)));
	const options = getVariableOptions(node);
	const bindings = bindingsForNode(node);
	const popup = document.createElement("div");
	popup.className = "gjj-template-prompt-popup";
	const popupWidth = Math.min(720, Math.max(520, window.innerWidth - 16));
	const x = Math.min(window.innerWidth - popupWidth - 8, Math.max(8, Number(event?.clientX || 120)));
	const y = Math.min(window.innerHeight - 440, Math.max(8, Number(event?.clientY || 120)));
	popup.style.left = `${Math.round(x)}px`;
	popup.style.top = `${Math.round(y)}px`;
	popup.style.width = `${Math.round(popupWidth)}px`;

	const head = document.createElement("div");
	head.className = "gjj-template-prompt-popup-head";
	const title = document.createElement("div");
	title.className = "gjj-template-prompt-popup-title";
	title.textContent = "⚡ 绑定模板参数";
	const clearCurrent = document.createElement("button");
	clearCurrent.type = "button";
	clearCurrent.className = "gjj-template-prompt-btn";
	clearCurrent.textContent = "解除当前";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.className = "gjj-template-prompt-btn";
	clear.textContent = "清空全部";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "gjj-template-prompt-btn";
	close.textContent = "关闭";
	head.append(title, clearCurrent, clear, close);
	const search = document.createElement("input");
	search.className = "gjj-template-prompt-search";
	search.placeholder = "搜索右侧来源；左侧选择目标，右侧点击来源绑定";
	const columns = document.createElement("div");
	columns.className = "gjj-template-prompt-columns";
	const targetCol = document.createElement("div");
	targetCol.className = "gjj-template-prompt-col";
	const sourceCol = document.createElement("div");
	sourceCol.className = "gjj-template-prompt-col";
	const targetHead = document.createElement("div");
	targetHead.className = "gjj-template-prompt-col-head";
	const targetTitle = document.createElement("span");
	targetTitle.textContent = "🎯 目标";
	const targetCount = document.createElement("span");
	targetCount.className = "gjj-template-prompt-col-count";
	targetHead.append(targetTitle, targetCount);
	const sourceHead = document.createElement("div");
	sourceHead.className = "gjj-template-prompt-col-head";
	const sourceTitle = document.createElement("span");
	sourceTitle.textContent = "📌 来源";
	const sourceCount = document.createElement("span");
	sourceCount.className = "gjj-template-prompt-col-count";
	sourceHead.append(sourceTitle, sourceCount);
	const targetList = document.createElement("div");
	targetList.className = "gjj-template-prompt-list";
	const sourceList = document.createElement("div");
	sourceList.className = "gjj-template-prompt-list";
	targetCol.append(targetHead, targetList);
	sourceCol.append(sourceHead, sourceList);
	columns.append(targetCol, sourceCol);
	const firstUnmatchedField = fields.find((field) => !bindings[field.key]);
	let selectedFieldKey = firstUnmatchedField?.key || fields[0]?.key || "";

	function commit(nextBindings) {
		const template = activeTemplateForNode(node);
		saveState(node, template, fields, valuesFromDom(node, fields), nextBindings, { saveTemplate: shouldSaveInternalTemplate(node) });
		stabilizeNode(node);
	}

	function render() {
		const words = String(search.value || "").trim().toLowerCase().split(/[\s,，;；|]+/).filter(Boolean);
		targetList.replaceChildren();
		sourceList.replaceChildren();
		const matchedCount = fields.filter((field) => bindings[field.key]).length;
		targetCount.textContent = `✅ ${matchedCount} / ⚠️ ${Math.max(0, fields.length - matchedCount)}`;
		const fieldOrder = new Map(fields.map((field, index) => [field.key, index]));
		const fieldLabelByKey = new Map(fields.map((field) => [field.key, field.label || field.key]));
		const sourceUsage = new Map();
		for (const field of fields) {
			const value = bindings[field.key];
			if (!value) continue;
			const usedBy = sourceUsage.get(value) || [];
			usedBy.push(field.label || field.key);
			sourceUsage.set(value, usedBy);
		}
		const sortedFields = [...fields].sort((a, b) => {
			const aMatched = Boolean(bindings[a.key]);
			const bMatched = Boolean(bindings[b.key]);
			if (aMatched !== bMatched) return aMatched ? 1 : -1;
			return (fieldOrder.get(a.key) || 0) - (fieldOrder.get(b.key) || 0);
		});
		for (const field of sortedFields) {
			const matched = Boolean(bindings[field.key]);
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = [
				"gjj-template-prompt-item",
				matched ? "matched" : "unmatched",
				selectedFieldKey === field.key ? "active" : "",
			].filter(Boolean).join(" ");
			const status = document.createElement("span");
			status.className = "gjj-template-prompt-status";
			status.textContent = matched ? "✅" : "⚠️";
			const main = document.createElement("span");
			main.className = "gjj-template-prompt-item-main";
			const titleEl = document.createElement("span");
			titleEl.className = "gjj-template-prompt-item-title";
			titleEl.textContent = `{{${field.label}}}`;
			const meta = document.createElement("span");
			meta.className = "gjj-template-prompt-item-meta";
			meta.textContent = matched ? `已匹配：${sourceLabelForBinding(node, bindings[field.key])}` : "未匹配：点击后在右侧选择来源";
			main.append(titleEl, meta);
			btn.append(status, main);
			btn.addEventListener("click", (clickEvent) => {
				clickEvent.preventDefault();
				clickEvent.stopPropagation();
				selectedFieldKey = field.key;
				render();
			});
			targetList.appendChild(btn);
		}
		const filtered = options.filter((option) => {
			const hay = `${option.value} ${option.label} ${option.source}`.toLowerCase();
			return words.every((word) => hay.includes(word));
		});
		const sortedSources = filtered.map((option, index) => ({
			option,
			index,
			usedBy: sourceUsage.get(option.value) || [],
		})).sort((a, b) => {
			const aBound = a.usedBy.length > 0;
			const bBound = b.usedBy.length > 0;
			if (aBound !== bBound) return aBound ? 1 : -1;
			return a.index - b.index;
		});
		const selectedBinding = selectedFieldKey ? bindings[selectedFieldKey] : "";
		const boundSourceCount = sortedSources.filter((item) => item.usedBy.length > 0).length;
		sourceCount.textContent = `➕ ${Math.max(0, sortedSources.length - boundSourceCount)} / ✅ ${boundSourceCount}`;
		if (!sortedSources.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-template-prompt-empty";
			empty.textContent = "没有可用参数。请先添加 GJJ_SETNODE、GJJ_TemplateParams 或模板变量设置。";
			sourceList.appendChild(empty);
		}
		for (const item of sortedSources) {
			const option = item.option;
			const active = selectedFieldKey && selectedBinding === option.value;
			const usedBy = item.usedBy;
			const bound = usedBy.length > 0;
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = [
				"gjj-template-prompt-item",
				bound ? "source-bound" : "source-free",
				active ? "active" : "",
			].filter(Boolean).join(" ");
			const status = document.createElement("span");
			status.className = "gjj-template-prompt-status";
			status.textContent = active ? "🔗" : (bound ? "✅" : "➕");
			const main = document.createElement("span");
			main.className = "gjj-template-prompt-item-main";
			const titleEl = document.createElement("span");
			titleEl.className = "gjj-template-prompt-item-title";
			titleEl.textContent = option.label || option.value;
			const meta = document.createElement("span");
			meta.className = "gjj-template-prompt-item-meta";
			const sourceText = option.source || option.value;
			if (active) {
				const selectedLabel = fieldLabelByKey.get(selectedFieldKey) || selectedFieldKey;
				meta.textContent = `当前已绑定：{{${selectedLabel}}} · ${sourceText}`;
			} else if (bound) {
				meta.textContent = `已绑定：${usedBy.map((name) => `{{${name}}}`).join("、")} · ${sourceText}`;
			} else {
				meta.textContent = `未绑定 · ${sourceText}`;
			}
			main.append(titleEl, meta);
			btn.append(status, main);
			btn.addEventListener("click", (clickEvent) => {
				clickEvent.preventDefault();
				clickEvent.stopPropagation();
				if (!selectedFieldKey) return;
				const next = bindingsForNode(node);
				next[selectedFieldKey] = option.value;
				commit(next);
				closeParamPopup();
			});
			sourceList.appendChild(btn);
		}
	}

	search.addEventListener("input", render);
	clearCurrent.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		if (!selectedFieldKey) return;
		const next = bindingsForNode(node);
		delete next[selectedFieldKey];
		commit(next);
		Object.keys(bindings).forEach((key) => delete bindings[key]);
		Object.assign(bindings, next);
		render();
	});
	clear.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		commit({});
		Object.keys(bindings).forEach((key) => delete bindings[key]);
		render();
	});
	close.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		closeParamPopup();
	});
	for (const el of [popup, head, title, clearCurrent, clear, close, search, columns, targetCol, sourceCol, targetList, sourceList]) {
		for (const name of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
			el.addEventListener(name, (ev) => ev.stopPropagation());
		}
	}
	popup.append(head, search, columns);
	document.body.appendChild(popup);
	activeParamPopup = popup;
	render();
	setTimeout(() => search.focus(), 0);
}

async function loadDefaultTemplate(node) {
	if (node.__gjjTemplatePromptLoadedDefault || app.configuringGraph) return;
	node.__gjjTemplatePromptLoadedDefault = true;
	try {
		const response = api?.fetchApi ? await api.fetchApi("/gjj/user_settings") : await fetch("/gjj/user_settings");
		const data = await response.json();
		const saved = String(data?.settings?.[USER_SETTINGS_SECTION]?.[USER_SETTINGS_KEY] || "").trim();
		const current = getWidgetValue(node, TEMPLATE_WIDGET, "");
		if (saved && (!current || current === DEFAULT_TEMPLATE)) {
			setWidgetValue(node, TEMPLATE_WIDGET, saved);
			stabilizeNode(node);
		}
	} catch (_) {}
}

async function saveDefaultTemplate(node) {
	const template = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
	const body = JSON.stringify({ section: USER_SETTINGS_SECTION, values: { [USER_SETTINGS_KEY]: template } });
	const options = { method: "POST", headers: { "Content-Type": "application/json" }, body };
	const response = api?.fetchApi ? await api.fetchApi("/gjj/user_settings", options) : await fetch("/gjj/user_settings", options);
	if (!response?.ok) throw new Error("保存失败");
	return response.json().catch(() => ({}));
}

async function queueCurrentWorkflowOnce() {
	if (typeof app.queuePrompt === "function") {
		await app.queuePrompt(0, 1);
		return;
	}
	if (typeof app.graphToPrompt === "function" && typeof api?.queuePrompt === "function") {
		const promptData = await app.graphToPrompt();
		await api.queuePrompt(0, promptData);
		return;
	}
	throw new Error("当前 ComfyUI 前端不支持加入队列");
}

async function queueChoiceBatchPrompts(node, button) {
	const template = activeTemplateForNode(node);
	const fields = parseTemplate(template);
	const choices = choiceFields(fields);
	if (!choices.length) return 0;

	const originalValues = valuesFromDom(node, fields);
	const originalBindings = bindingsForNode(node);
	const combinations = choiceCombinations(fields, originalValues);
	const total = combinations.length;
	if (!total) return 0;
	if (total > MAX_BATCH_PROMPTS) {
		throw new Error(`批量组合过多：${total} 条，当前上限 ${MAX_BATCH_PROMPTS} 条`);
	}

	let queued = 0;
	node.__gjjTemplatePromptBatchBusy = true;
	if (button) {
		button.disabled = true;
		button.textContent = `🚀0/${total}`;
		button.title = `正在加入队列：0 / ${total}`;
	}
	try {
		for (const combination of combinations) {
			const nextValues = { ...originalValues, ...combination };
			saveState(node, template, fields, nextValues, originalBindings, { saveTemplate: shouldSaveInternalTemplate(node) });
			await queueCurrentWorkflowOnce();
			queued += 1;
			if (button) {
				button.textContent = `🚀${queued}/${total}`;
				button.title = `正在加入队列：${queued} / ${total}`;
			}
		}
		return queued;
	} finally {
		saveState(node, template, fields, originalValues, originalBindings, { saveTemplate: shouldSaveInternalTemplate(node) });
		node.__gjjTemplatePromptBatchBusy = false;
		renderRows(node);
	}
}

function buildDom(node) {
	ensureStyles();
	const root = document.createElement("div");
	root.className = "gjj-template-prompt";
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-template-prompt-toolbar";
	const settings = document.createElement("button");
	settings.type = "button";
	settings.className = "gjj-template-prompt-btn";
	settings.textContent = "⚙️ 设置";
	const params = document.createElement("button");
	params.type = "button";
	params.className = "gjj-template-prompt-btn";
	params.textContent = "⚡参数";
	const batch = document.createElement("button");
	batch.type = "button";
	batch.className = "gjj-template-prompt-btn";
	batch.textContent = "🚀批量";
	const save = document.createElement("button");
	save.type = "button";
	save.className = "gjj-template-prompt-btn";
	save.textContent = "💾保存";
	const count = document.createElement("span");
	count.className = "gjj-template-prompt-count";
	toolbar.append(settings, params, batch, save, count);

	const panel = document.createElement("div");
	panel.className = "gjj-template-prompt-panel";
	const textarea = document.createElement("textarea");
	textarea.className = "gjj-template-prompt-template";
	textarea.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
	textarea.placeholder = "在这里写模板，例如：一张{{主体}}照片，{{背景(白色)}}背景，{{风格:真实,影视}}";
	const actions = document.createElement("div");
	actions.className = "gjj-template-prompt-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "gjj-template-prompt-btn";
	cancel.textContent = "取消";
	const ok = document.createElement("button");
	ok.type = "button";
	ok.className = "gjj-template-prompt-btn";
	ok.textContent = "确定";
	actions.append(cancel, ok);
	panel.append(textarea, actions);
	const rows = document.createElement("div");
	rows.className = "gjj-template-prompt-rows";
	root.append(toolbar, panel, rows);

	const stop = (event) => event.stopPropagation();
	for (const el of [root, toolbar, settings, params, batch, save, panel, textarea, cancel, ok, rows]) {
		for (const name of ["pointerdown", "mousedown", "click", "keydown", "keyup", "wheel", "dblclick", "contextmenu"]) {
			el.addEventListener(name, stop);
		}
	}
	settings.addEventListener("click", (event) => {
		event.preventDefault();
		textarea.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
		const open = panel.style.display !== "flex";
		panel.style.display = open ? "flex" : "none";
		refreshNode(node, true);
		if (open) setTimeout(() => textarea.focus(), 0);
	});
	params.addEventListener("click", (event) => {
		event.preventDefault();
		openParamPopup(node, event);
	});
	batch.addEventListener("click", async (event) => {
		event.preventDefault();
		try {
			const queued = await queueChoiceBatchPrompts(node, batch);
			batch.disabled = false;
			batch.textContent = queued ? `已加入 ${queued}` : "无组合";
			batch.title = queued ? `已加入队列：${queued} 条` : "模板中没有可用按钮组合";
			setTimeout(() => renderRows(node), 1200);
		} catch (err) {
			batch.disabled = false;
			batch.textContent = "批量失败";
			batch.title = err?.message || String(err || "批量加入队列失败");
			console.warn("[GJJ_TemplatePrompt] 批量加入队列失败", err);
			setTimeout(() => renderRows(node), 1600);
		}
	});
	save.addEventListener("click", async (event) => {
		event.preventDefault();
		try {
			save.disabled = true;
			save.textContent = "保存中";
			await saveDefaultTemplate(node);
			save.textContent = "已保存";
			setTimeout(() => { save.textContent = "💾保存"; save.disabled = false; }, 900);
		} catch (err) {
			save.textContent = "保存失败";
			setTimeout(() => { save.textContent = "💾保存"; save.disabled = false; }, 1200);
			console.warn("[GJJ_TemplatePrompt] 保存默认模板失败", err);
		}
	});
	cancel.addEventListener("click", (event) => {
		event.preventDefault();
		panel.style.display = "none";
		refreshNode(node, true);
	});
	ok.addEventListener("click", (event) => {
		event.preventDefault();
		const oldFields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
		const oldValues = valuesFromDom(node, oldFields);
		const oldBindings = bindingsForNode(node);
		const fields = parseTemplate(textarea.value);
		const nextValues = {};
		const nextBindings = {};
		for (const field of fields) {
			if (isChoiceField(field)) {
				nextValues[field.key] = choiceSelections(field, oldValues);
			} else {
				const oldValue = String(oldValues[field.key] ?? "");
				nextValues[field.key] = oldValue || String(field.defaultValue ?? "");
				if (oldBindings[field.key]) nextBindings[field.key] = oldBindings[field.key];
			}
		}
		saveState(node, textarea.value || DEFAULT_TEMPLATE, fields, nextValues, nextBindings);
		panel.style.display = "none";
		stabilizeNode(node);
	});
	node.__gjjTemplatePromptRoot = root;
	node.__gjjTemplatePromptRows = rows;
	node.__gjjTemplatePromptCount = count;
	node.__gjjTemplatePromptBatchButton = batch;
	node.__gjjTemplatePromptPanel = panel;
	return root;
}

function ensureDom(node) {
	if (!node || node.__gjjTemplatePromptDomWidget) return;
	const root = buildDom(node);
	const widget = node.addDOMWidget?.(DOM_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.round(Number(width || currentNodeWidth(node))), domHeight(node)];
		widget.getHeight = () => domHeight(node);
		node.__gjjTemplatePromptDomWidget = widget;
	}
}

function stabilizeNode(node) {
	if (!node || node.__gjjTemplatePromptStabilizing) return;
	node.__gjjTemplatePromptStabilizing = true;
	try {
		ensureDom(node);
		hideInternalWidgets(node);
		if (!getWidgetValue(node, TEMPLATE_WIDGET, "")) setWidgetValue(node, TEMPLATE_WIDGET, node.properties?.gjj_template_prompt_template || DEFAULT_TEMPLATE);
		if (!getWidgetValue(node, VALUES_WIDGET, "")) setWidgetValue(node, VALUES_WIDGET, JSON.stringify(node.properties?.gjj_template_prompt_values || {}, null, 2));
		if (!getWidgetValue(node, BINDINGS_WIDGET, "")) setWidgetValue(node, BINDINGS_WIDGET, JSON.stringify(node.properties?.gjj_template_prompt_bindings || {}, null, 2));
		const fields = parseTemplate(activeTemplateForNode(node));
		const template = activeTemplateForNode(node);
		const previousTemplate = node.__gjjTemplatePromptActiveTemplate;
		const templateChanged = previousTemplate !== undefined && previousTemplate !== template;
		node.__gjjTemplatePromptActiveTemplate = template;
		if (templateChanged) resetStateForTemplate(node, template, fields, shouldSaveInternalTemplate(node));
		ensureInputs(node, fields);
		renderRows(node);
		loadDefaultTemplate(node);
	} finally {
		node.__gjjTemplatePromptStabilizing = false;
	}
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjTemplatePromptTimer);
	node.__gjjTemplatePromptTimer = setTimeout(() => stabilizeNode(node), Math.round(Number(ms) || 0));
}

function patchPromptBindings(promptResult, graph) {
	const output = promptResult?.output;
	if (!output || !graph) return;
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const node = graph.getNodeById?.(Number(nodeId)) || graph._nodes?.find((item) => String(item?.id) === String(nodeId));
		if (!node || node.type !== TARGET_NODE) continue;
		const fields = parseTemplate(activeTemplateForNode(node));
		const bindings = bindingsForNode(node);
		nodeInfo.inputs = nodeInfo.inputs || {};
		for (const field of fields) {
			if (isChoiceField(field)) continue;
			const binding = String(bindings[field.key] || "").trim();
			if (!binding) continue;
			const resolved = resolveBindingSource(node.graph || graph, binding);
			if (Array.isArray(resolved) && resolved.length === 2) {
				nodeInfo.inputs[field.inputName] = [String(resolved[0]), Number(resolved[1] || 0)];
			}
		}
	}
}

function installPromptPatch() {
	if (!api.__gjjTemplatePromptQueuePatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjTemplatePromptQueuePatchInstalled = true;
		const original = api.queuePrompt.bind(api);
		api.queuePrompt = async function (number, promptData, ...args) {
			patchPromptBindings(promptData, app.rootGraph || app.graph);
			return original(number, promptData, ...args);
		};
	}
	if (!app.__gjjTemplatePromptGraphPatchInstalled && typeof app.graphToPrompt === "function") {
		app.__gjjTemplatePromptGraphPatchInstalled = true;
		const original = app.graphToPrompt.bind(app);
		app.graphToPrompt = async function (...args) {
			const result = await original(...args);
			patchPromptBindings(result?.workflow ? result : result?.output ? result : result?.prompt || result, app.rootGraph || app.graph);
			return result;
		};
	}
}

function refreshAllTemplatePrompts() {
	for (const node of app.graph?._nodes || []) {
		if (node?.type === TARGET_NODE || node?.comfyClass === TARGET_NODE) scheduleStabilize(node, 0);
	}
}

app.registerExtension({
	name: "Comfy.GJJ.TemplatePrompt",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if ([TEMPLATE_WIDGET, VALUES_WIDGET, BINDINGS_WIDGET, SCHEMA_WIDGET].includes(name)) hideWidget(widget);
			return widget;
		};
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			const props = serializedNode?.properties || this.properties || {};
			if (props.gjj_template_prompt_template) setWidgetValue(this, TEMPLATE_WIDGET, props.gjj_template_prompt_template);
			if (props.gjj_template_prompt_values !== undefined) setWidgetValue(this, VALUES_WIDGET, JSON.stringify(props.gjj_template_prompt_values || {}, null, 2));
			if (props.gjj_template_prompt_bindings !== undefined) setWidgetValue(this, BINDINGS_WIDGET, JSON.stringify(props.gjj_template_prompt_bindings || {}, null, 2));
			if (Array.isArray(props.gjj_template_prompt_fields)) setWidgetValue(this, SCHEMA_WIDGET, JSON.stringify(props.gjj_template_prompt_fields, null, 2));
			scheduleStabilize(this, 0);
			setTimeout(() => stabilizeNode(this), 80);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const template = activeTemplateForNode(this);
			const fields = parseTemplate(template);
			saveState(this, template, fields, valuesFromDom(this, fields), bindingsForNode(this), { saveTemplate: shouldSaveInternalTemplate(this) });
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties.gjj_template_prompt_template = this.properties.gjj_template_prompt_template;
				serializedNode.properties.gjj_template_prompt_values = this.properties.gjj_template_prompt_values;
				serializedNode.properties.gjj_template_prompt_bindings = this.properties.gjj_template_prompt_bindings;
				serializedNode.properties.gjj_template_prompt_fields = this.properties.gjj_template_prompt_fields;
			}
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this, 32);
			return result;
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === TARGET_NODE || node?.type === TARGET_NODE) scheduleStabilize(node, 0);
	},
	setup() {
		installPromptPatch();
		for (const node of app.graph?._nodes || []) {
			if (node?.type === TARGET_NODE || node?.comfyClass === TARGET_NODE) stabilizeNode(node);
		}
	},
});

if (!window.__gjjTemplatePromptPopupCloser) {
	window.__gjjTemplatePromptPopupCloser = true;
	document.addEventListener("pointerdown", (event) => {
		if (activeParamPopup && !activeParamPopup.contains(event.target)) closeParamPopup();
	});
}

if (!window.__gjjTemplatePromptSelectorListener) {
	window.__gjjTemplatePromptSelectorListener = true;
	window.addEventListener("gjj-prompt-template-selector-changed", refreshAllTemplatePrompts);
}

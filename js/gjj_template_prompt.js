import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODE = "GJJ_TemplatePrompt";
const TEMPLATE_WIDGET = "template_text";
const VALUES_WIDGET = "values_json";
const BINDINGS_WIDGET = "bindings_json";
const SCHEMA_WIDGET = "schema_json";
const DOM_WIDGET = "gjj_template_prompt_dom";
const DEFAULT_TEMPLATE = "一张{{主体}}的照片，{{风格}}，细节丰富";
const DEFAULT_WIDTH = 320;
const MIN_HEIGHT = 92;
const STYLE_ID = "gjj-template-prompt-style";
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
		const base = slugKey(label);
		const count = seenKeys.get(base) || 0;
		seenKeys.set(base, count + 1);
		const key = count ? `${base}_${count + 1}` : base;
		fields.push({
			key,
			label,
			inputName: `param_${key}`,
			type: "STRING",
			outputIndex: 0,
			displayLabel: label === key ? label : `${label}（${key}）`,
		});
	}
	return fields;
}

function fieldNames(fields) {
	return new Set(fields.map((field) => field.inputName));
}

function currentNodeWidth(node) {
	const width = Number(node?.size?.[0]);
	return Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_WIDTH;
}

function setDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
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

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.gjj-template-prompt{box-sizing:border-box;width:100%;padding:2px 0 4px 0;color:#dce7e2;font-family:system-ui,"Microsoft YaHei",sans-serif;pointer-events:auto;}
.gjj-template-prompt *{box-sizing:border-box;}
.gjj-template-prompt-toolbar{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;}
.gjj-template-prompt-btn{height:25px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:650;white-space:nowrap;}
.gjj-template-prompt-btn:hover{background:#2c3b43;border-color:#6aa6b8;}
.gjj-template-prompt-count{color:#8ea0a8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-template-prompt-panel{display:none;flex-direction:column;gap:6px;margin-top:6px;padding:6px;border:1px solid #33464e;border-radius:8px;background:#0d1519;}
.gjj-template-prompt-template{width:100%;min-height:110px;resize:vertical;padding:7px 8px;border:1px solid #44565f;border-radius:7px;outline:none;background:#070f12;color:#dce7e2;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;}
.gjj-template-prompt-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;}
.gjj-template-prompt-rows{display:flex;flex-direction:column;gap:6px;margin-top:6px;}
.gjj-template-prompt-row{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px;align-items:center;}
.gjj-template-prompt-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9c8cc;font-size:12px;}
.gjj-template-prompt-input{width:100%;height:30px;border:1px solid #33464e;border-radius:7px;background:#2b2d30;color:#f1f5f5;padding:4px 8px;outline:none;font-size:13px;}
.gjj-template-prompt-input:focus{border-color:#6aa6b8;background:#22282c;}
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
	const parsedFields = fields || parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
	const values = safeJsonParse(getWidgetValue(node, VALUES_WIDGET, "{}"), {});
	const result = values && typeof values === "object" && !Array.isArray(values) ? { ...values } : {};
	for (const field of parsedFields) {
		const input = node?.__gjjTemplatePromptInputs?.get(field.key);
		if (input) result[field.key] = input.value ?? "";
		else if (!(field.key in result)) result[field.key] = "";
	}
	return result;
}

function bindingsForNode(node) {
	const bindings = safeJsonParse(getWidgetValue(node, BINDINGS_WIDGET, "{}"), {});
	return bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
}

function saveState(node, template, fields, values, bindings = null) {
	setWidgetValue(node, TEMPLATE_WIDGET, template || DEFAULT_TEMPLATE);
	setWidgetValue(node, VALUES_WIDGET, JSON.stringify(values || {}, null, 2));
	if (bindings) setWidgetValue(node, BINDINGS_WIDGET, JSON.stringify(bindings, null, 2));
	setWidgetValue(node, SCHEMA_WIDGET, JSON.stringify(fields, null, 2));
	node.properties = node.properties || {};
	node.properties.gjj_template_prompt_template = template || DEFAULT_TEMPLATE;
	node.properties.gjj_template_prompt_values = values || {};
	node.properties.gjj_template_prompt_bindings = bindings || bindingsForNode(node);
	node.properties.gjj_template_prompt_fields = fields;
}

function inputHasLink(input) {
	return input?.link != null || (Array.isArray(input?.link) && input.link.length > 0);
}

function getGraphLink(node, linkId) {
	const links = node?.graph?.links || app.graph?.links;
	if (!links || linkId == null) return null;
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function nodeType(node) {
	return node?.type || node?.comfyClass || node?.constructor?.type || "";
}

function getGraphNodeById(graph, id) {
	return graph?.getNodeById?.(Number(id)) || graph?._nodes?.find((node) => String(node?.id) === String(id)) || null;
}

function disconnectInput(node, index) {
	try {
		if (typeof node.disconnectInput === "function") node.disconnectInput(index);
		else if (node.inputs?.[index]) node.inputs[index].link = null;
	} catch (_) {}
}

function removeInputByName(node, name) {
	const index = node.inputs?.findIndex((input) => input?.name === name) ?? -1;
	if (index < 0) return;
	disconnectInput(node, index);
	node.removeInput?.(index);
}

function repairInputLinkSlots(node) {
	if (!Array.isArray(node?.inputs)) return;
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

function sourceLabelForBinding(node, name) {
	const options = globalThis.GJJ_VariableBroadcast?.getVisibleSetOptions?.(node?.graph) || [];
	const found = options.find((item) => item.value === name);
	return found?.label || localTemplateParamsOptions(node).find((item) => item.value === name)?.label || name;
}

function renderRows(node) {
	const rows = node?.__gjjTemplatePromptRows;
	if (!rows) return;
	const template = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
	const fields = parseTemplate(template);
	const values = valuesFromDom(node, fields);
	const bindings = bindingsForNode(node);
	node.__gjjTemplatePromptInputs = new Map();
	rows.replaceChildren();
	if (!fields.length) {
		const empty = document.createElement("div");
		empty.className = "gjj-template-prompt-empty";
		empty.textContent = "模板里写 {{参数名}} 后会在这里生成输入。";
		rows.appendChild(empty);
	}
	for (const field of fields) {
		const binding = String(bindings[field.key] || "").trim();
		const row = document.createElement("div");
		row.className = "gjj-template-prompt-row";
		const label = document.createElement("div");
		label.className = "gjj-template-prompt-label";
		label.textContent = field.label;
		label.title = `模板参数：{{${field.label}}}`;
		if (binding) {
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
				saveState(node, template, fields, valuesFromDom(node, fields), next);
				stabilizeNode(node);
			});
			bound.append(text, clear);
			row.append(bound);
		} else {
			const input = document.createElement("input");
			input.className = "gjj-template-prompt-input";
			input.value = String(values[field.key] ?? "");
			input.placeholder = field.label;
			input.addEventListener("input", () => {
				const nextValues = valuesFromDom(node, fields);
				nextValues[field.key] = input.value;
				saveState(node, template, fields, nextValues, bindingsForNode(node));
			});
			node.__gjjTemplatePromptInputs.set(field.key, input);
			row.append(label, input);
		}
		rows.appendChild(row);
	}
	const count = node.__gjjTemplatePromptCount;
	if (count) {
		const boundCount = fields.filter((field) => bindings[field.key]).length;
		count.textContent = `${fields.length} 参数${boundCount ? ` · ${boundCount} 已接管` : ""}`;
	}
	saveState(node, template, fields, values, bindings);
	refreshNode(node);
}

function ensureInputs(node, fields) {
	const keep = fieldNames(fields);
	const bindings = bindingsForNode(node);
	for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		if (!name.startsWith("param_")) continue;
		const boundField = fields.find((field) => field.inputName === name && bindings[field.key]);
		if (!keep.has(name) || boundField) {
			disconnectInput(node, index);
			node.removeInput?.(index);
		}
	}
	for (const field of fields) {
		if (bindings[field.key]) continue;
		let input = node.inputs?.find((item) => item?.name === field.inputName);
		if (!input) {
			node.addInput?.(field.inputName, "STRING");
			input = node.inputs?.find((item) => item?.name === field.inputName);
		}
		if (input) {
			input.type = "STRING";
			input.label = field.label;
			input.localized_name = field.label;
			input.tooltip = `模板参数：{{${field.label}}}`;
		}
	}
	node.inputs = [
		...(node.inputs || []).filter((input) => !String(input?.name || "").startsWith("param_")),
		...fields.map((field) => node.inputs?.find((input) => input?.name === field.inputName)).filter(Boolean),
	];
	repairInputLinkSlots(node);
}

function refreshNode(node, force = false) {
	if (!node) return;
	const widget = node.__gjjTemplatePromptDomWidget;
	const root = node.__gjjTemplatePromptRoot;
	if (widget && root) {
		widget.computeSize = (width) => [Math.round(Number(width || currentNodeWidth(node))), domHeight(node)];
		widget.getHeight = () => domHeight(node);
	}
	const width = currentNodeWidth(node);
	const height = Math.round(Math.max(MIN_HEIGHT, Math.ceil(root?.scrollHeight || MIN_HEIGHT) + 8));
	if (force || Math.abs(Number(node.size?.[1] || 0) - height) > 2) {
		node.__gjjTemplatePromptSizing = true;
		try { node.setSize?.([width, height]); } finally { requestAnimationFrame(() => { node.__gjjTemplatePromptSizing = false; }); }
	}
	setDirty(node);
}

function domHeight(node) {
	return Math.round(Math.max(36, Math.ceil(node?.__gjjTemplatePromptRoot?.scrollHeight || 36) + 4));
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
				const originId = Array.isArray(link) ? link[1] : link.origin_id;
				const originSlot = Array.isArray(link) ? link[2] : link.origin_slot;
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
	const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
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
		saveState(node, getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE), fields, valuesFromDom(node, fields), nextBindings);
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
	const save = document.createElement("button");
	save.type = "button";
	save.className = "gjj-template-prompt-btn";
	save.textContent = "💾保存";
	const count = document.createElement("span");
	count.className = "gjj-template-prompt-count";
	toolbar.append(settings, params, save, count);

	const panel = document.createElement("div");
	panel.className = "gjj-template-prompt-panel";
	const textarea = document.createElement("textarea");
	textarea.className = "gjj-template-prompt-template";
	textarea.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
	textarea.placeholder = "在这里写模板，例如：{{主体}}，{{风格}}";
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
	for (const el of [root, toolbar, settings, params, save, panel, textarea, cancel, ok, rows]) {
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
			nextValues[field.key] = oldValues[field.key] ?? "";
			if (oldBindings[field.key]) nextBindings[field.key] = oldBindings[field.key];
		}
		saveState(node, textarea.value || DEFAULT_TEMPLATE, fields, nextValues, nextBindings);
		panel.style.display = "none";
		stabilizeNode(node);
	});
	node.__gjjTemplatePromptRoot = root;
	node.__gjjTemplatePromptRows = rows;
	node.__gjjTemplatePromptCount = count;
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
		const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
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
		const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, node.properties?.gjj_template_prompt_template || DEFAULT_TEMPLATE));
		const bindings = bindingsForNode(node);
		nodeInfo.inputs = nodeInfo.inputs || {};
		for (const field of fields) {
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
			if (props.gjj_template_prompt_template) setTimeout(() => setWidgetValue(this, TEMPLATE_WIDGET, props.gjj_template_prompt_template), 0);
			if (props.gjj_template_prompt_values !== undefined) setTimeout(() => setWidgetValue(this, VALUES_WIDGET, JSON.stringify(props.gjj_template_prompt_values || {}, null, 2)), 0);
			if (props.gjj_template_prompt_bindings !== undefined) setTimeout(() => setWidgetValue(this, BINDINGS_WIDGET, JSON.stringify(props.gjj_template_prompt_bindings || {}, null, 2)), 0);
			scheduleStabilize(this, 0);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const fields = parseTemplate(getWidgetValue(this, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
			saveState(this, getWidgetValue(this, TEMPLATE_WIDGET, DEFAULT_TEMPLATE), fields, valuesFromDom(this, fields), bindingsForNode(this));
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

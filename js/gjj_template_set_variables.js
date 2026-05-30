import { app } from "/scripts/app.js";

const TARGET_NODE = "GJJ_TemplateSetVariables";
const TEMPLATE_WIDGET = "template_text";
const VALUES_WIDGET = "values_json";
const DOM_WIDGET = "gjj_template_set_variables_dom";
const DEFAULT_TEMPLATE = "采样帧数（SampleFrames）[INT]：93\n宽度（Width）[INT]：640\n高度（Height）[INT]：608";
const MAX_VARIABLES = 32;
const INTERNAL_WIDGETS = new Set([TEMPLATE_WIDGET, VALUES_WIDGET]);
const OUTPUTS_VISIBLE_PROPERTY = "gjj_template_set_variables_outputs_visible";
const SAVED_SIZE = "gjj_template_set_variables_size";
const MIN_WIDTH = 240;
const DEFAULT_WIDTH = 300;
const MAX_AUTO_WIDTH = 340;
const MIN_HEIGHT = 96;
const MAX_EXTRA_IDLE_HEIGHT = 72;
const STYLE_ID = "gjj-template-set-variables-style";

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

function safeJsonParse(text, fallback) {
	try {
		const value = JSON.parse(String(text || ""));
		return value ?? fallback;
	} catch (_) {
		return fallback;
	}
}

function splitValueAndTooltip(text) {
	const raw = String(text || "");
	let escaped = false;
	let quote = "";
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			if (quote === ch) quote = "";
			else if (!quote) quote = ch;
			continue;
		}
		if (ch === "#" && !quote) {
			return {
				value: raw.slice(0, i).replace(/\\#/g, "#").trim(),
				tooltip: raw.slice(i + 1).trim(),
			};
		}
	}
	return { value: raw.replace(/\\#/g, "#").trim(), tooltip: "" };
}

function stripQuotes(text) {
	const raw = String(text ?? "").trim();
	if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
		return raw.slice(1, -1);
	}
	return raw;
}

function parseValue(text) {
	if (typeof text !== "string") return text;
	const raw = text.trim();
	if (!raw) return "";
	const forced = raw.match(/^\s*(int|float|str|string|bool|boolean|json)\s*\(([\s\S]*)\)\s*$/i);
	if (forced) {
		const kind = forced[1].toLowerCase();
		const inner = stripQuotes(forced[2].trim());
		if (kind === "int") return Number.parseInt(Number.parseFloat(inner || "0"), 10);
		if (kind === "float") return Number.parseFloat(inner || "0");
		if (kind === "bool" || kind === "boolean") return /^(1|true|yes|on|是|真|开)$/i.test(inner);
		if (kind === "json") {
			try { return JSON.parse(forced[2].trim()); } catch (_) { return inner; }
		}
		return inner;
	}
	if (/^(true|yes|on|是|真|开)$/i.test(raw)) return true;
	if (/^(false|no|off|否|假|关)$/i.test(raw)) return false;
	if (/^(none|null|nil)$/i.test(raw)) return null;
	if (/^[-+]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) || /^[-+]?\d+[eE][-+]?\d+$/.test(raw)) return Number.parseFloat(raw);
	if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
		try { return JSON.parse(raw); } catch (_) {}
	}
	return text;
}

function inferType(rawText, parsedValue) {
	const raw = String(rawText ?? "").trim();
	const forced = raw.match(/^\s*(int|float|str|string|bool|boolean|json)\s*\(/i);
	if (forced) {
		const kind = forced[1].toLowerCase();
		if (kind === "int") return "INT";
		if (kind === "float") return "FLOAT";
		if (kind === "bool" || kind === "boolean") return "BOOLEAN";
		if (kind === "json") return "*";
		return "STRING";
	}
	if (typeof parsedValue === "boolean") return "BOOLEAN";
	if (Number.isInteger(parsedValue)) return "INT";
	if (typeof parsedValue === "number" && Number.isFinite(parsedValue)) return "FLOAT";
	if (Array.isArray(parsedValue) || (parsedValue && typeof parsedValue === "object") || parsedValue === null) return "*";
	return "STRING";
}

function normalizeSocketType(value) {
	let text = String(value || "").trim();
	if (!text) return "";
	text = text.replace(/，/g, ",").replace(/\s+/g, "");
	if (/^(any|\*)$/i.test(text)) return "*";
	return text.toUpperCase();
}

function splitSocketTypes(socketType) {
	const normalized = normalizeSocketType(socketType);
	if (!normalized) return [];
	return normalized.split(",").filter(Boolean);
}

function valueTypeForSocket(socketType, inferredType) {
	const parts = splitSocketTypes(socketType);
	const inferred = normalizeSocketType(inferredType) || "*";
	if (!parts.length) return inferred;
	if (["INT", "FLOAT", "BOOLEAN", "STRING", "*"].includes(inferred) && (parts.includes(inferred) || parts.includes("*"))) {
		return inferred;
	}
	for (const primitive of ["INT", "FLOAT", "BOOLEAN", "STRING"]) {
		if (parts.includes(primitive)) return primitive;
	}
	return normalizeSocketType(socketType) || inferred;
}

function splitLabelAndSocketType(rawLabel) {
	const label = String(rawLabel || "").trim();
	const match = label.match(/\s*(?:\[\s*([^\]]+?)\s*\]|【\s*([^】]+?)\s*】)\s*$/);
	if (!match) return { label, socketType: "" };
	return {
		label: label.slice(0, match.index).trim(),
		socketType: normalizeSocketType(match[1] || match[2] || ""),
	};
}

function slugKey(label, index, seen) {
	let key = String(label || "").trim();
	const explicit = key.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
	if (explicit) key = explicit[2].trim();
	key = key.replace(/[^0-9A-Za-z_\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "") || `var_${index + 1}`;
	const count = seen.get(key) || 0;
	seen.set(key, count + 1);
	return count ? `${key}_${count + 1}` : key;
}

function labelAndKey(rawLabel, index, seen) {
	let label = String(rawLabel || "").trim() || `变量 ${index + 1}`;
	const explicit = label.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
	if (!explicit) return { label, key: slugKey(label, index, seen) };
	label = explicit[1].trim() || label;
	let key = explicit[2].trim().replace(/[^0-9A-Za-z_\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "") || slugKey(label, index, seen);
	const count = seen.get(key) || 0;
	seen.set(key, count + 1);
	if (count) key = `${key}_${count + 1}`;
	return { label, key };
}

function parseTemplate(templateText) {
	const fields = [];
	const seen = new Map();
	const lines = String(templateText || DEFAULT_TEMPLATE).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("....")) continue;
		const match = line.match(/^([^:：=]+?)\s*[:：=]\s*(.*?)\s*$/);
		const leftText = match ? match[1] : line;
		const rightText = match ? match[2] : "";
		const { label: labelText, socketType } = splitLabelAndSocketType(leftText);
		const { label, key } = labelAndKey(labelText, fields.length, seen);
		const { value: rawDefault, tooltip } = splitValueAndTooltip(rightText);
		const parsed = parseValue(rawDefault);
		const inferredType = inferType(rawDefault, parsed);
		const type = socketType || inferredType;
		const valueType = socketType ? valueTypeForSocket(socketType, inferredType) : inferredType;
		const displayLabel = label === key ? label : `${label}（${key}）`;
		fields.push({
			key,
			inputName: `var_${key}`,
			label,
			displayLabel,
			default: rawDefault,
			value: parsed,
			type,
			valueType,
			explicitType: socketType,
			tooltip,
		});
		if (fields.length >= MAX_VARIABLES) break;
	}
	return fields;
}

function coerceValue(value, type) {
	type = normalizeSocketType(type) || "*";
	if (type === "INT") {
		const number = Number.parseInt(Number.parseFloat(value), 10);
		return Number.isFinite(number) ? number : 0;
	}
	if (type === "FLOAT") {
		const number = Number.parseFloat(value);
		return Number.isFinite(number) ? number : 0;
	}
	if (type === "BOOLEAN") {
		if (typeof value === "string") return /^(1|true|yes|on|是|真|开)$/i.test(value.trim());
		return !!value;
	}
	if (type === "STRING") return String(value ?? "");
	return value;
}

function valuesFromWidgets(node, fields) {
	const existing = safeJsonParse(getWidgetValue(node, VALUES_WIDGET, "{}"), {});
	const values = { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}) };
	for (const field of fields) {
		const widget = getWidget(node, field.inputName);
		if (widget) values[field.key] = coerceValue(widget.value, field.valueType || field.type);
		else if (!(field.key in values)) values[field.key] = field.value;
	}
	return values;
}

function saveValues(node, fields) {
	const values = valuesFromWidgets(node, fields);
	setWidgetValue(node, VALUES_WIDGET, JSON.stringify(values, null, 2));
	node.properties = node.properties || {};
	node.properties.gjj_template_set_variables_values = values;
	return values;
}

function saveFieldSchema(node, fields) {
	node.properties = node.properties || {};
	node.properties.gjj_template_set_variables_fields = fields.map((field, index) => ({
		key: field.key,
		inputName: field.inputName,
		label: field.label,
		displayLabel: field.displayLabel || field.label || field.key,
		type: field.type || "*",
		valueType: field.valueType || field.type || "*",
		outputIndex: index,
	}));
	node.properties.gjj_template_set_variables_setnode = true;
}

function notifySetGetNodes(node) {
	try {
		window.dispatchEvent(new CustomEvent("gjj-template-set-variables-updated", {
			detail: { nodeId: node?.id },
		}));
	} catch (_) {}
}

function hasOwn(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function outputsVisible(node) {
	if (hasOwn(node?.properties, OUTPUTS_VISIBLE_PROPERTY)) {
		return Boolean(node.properties[OUTPUTS_VISIBLE_PROPERTY]);
	}
	return Boolean(node?.__gjjTemplateSetOutputsVisible);
}

function setOutputsVisible(node, visible) {
	if (!node) return false;
	node.properties = node.properties || {};
	const next = Boolean(visible);
	node.properties[OUTPUTS_VISIBLE_PROPERTY] = next;
	node.__gjjTemplateSetOutputsVisible = next;
	updateOutputToggle(node);
	return next;
}

function ensureOutputVisibilityState(node) {
	if (!node) return false;
	node.properties = node.properties || {};
	if (!hasOwn(node.properties, OUTPUTS_VISIBLE_PROPERTY)) {
		node.properties[OUTPUTS_VISIBLE_PROPERTY] = Boolean(node.__gjjTemplateSetOutputsVisible);
	}
	node.__gjjTemplateSetOutputsVisible = Boolean(node.properties[OUTPUTS_VISIBLE_PROPERTY]);
	updateOutputToggle(node);
	return node.__gjjTemplateSetOutputsVisible;
}

function updateOutputToggle(node) {
	const button = node?.__gjjTemplateSetOutputToggle;
	const visible = outputsVisible(node);
	for (let index = 0; index < (node?.outputs?.length || 0); index += 1) {
		const output = node.outputs[index];
		if (!output) continue;
		output.hidden = !visible;
		output.visible = visible;
		output.disabled = !visible;
		output.not_show = !visible;
		output.__gjj_template_set_hidden = !visible;
		if (typeof node.hideOutput === "function") {
			try { node.hideOutput(index, !visible); } catch (_) {}
		}
	}
	if (button) {
		button.classList.toggle("active", visible);
		button.setAttribute("aria-pressed", String(visible));
		button.title = visible
			? "隐藏右侧输出插口；仍保留全局变量给 GJJ 变量读取节点使用。"
			: "显示右侧输出插口，便于直接连线取值。";
	}
}

function setDirty(node) {
	try { node.setDirtyCanvas?.(true, true); } catch (_) {}
	try { node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
}

function safeAssign(target, key, value) {
	try { target[key] = value; } catch (_) {}
}

function collapseElement(el) {
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
	widget.__gjjTemplateSetHidden = true;
	safeAssign(widget, "hidden", true);
	safeAssign(widget, "disabled", true);
	safeAssign(widget, "type", `converted-widget:${widget.name || "hidden"}`);
	safeAssign(widget, "label", "");
	safeAssign(widget, "localized_name", "");
	safeAssign(widget, "display_name", "");
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.mouse = () => false;
	safeAssign(widget, "y", 0);
	safeAssign(widget, "last_y", 0);
	safeAssign(widget, "computedHeight", 0);
	safeAssign(widget, "margin_top", 0);
	safeAssign(widget, "size", [0, -4]);
	safeAssign(widget, "height", -4);
	safeAssign(widget, "display", "hidden");
	safeAssign(widget, "forceInput", false);
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden", forceInput: false };
	for (const el of [widget.inputEl, widget.element, widget.widget]) {
		collapseElement(el);
	}
}

function hideInternalWidgets(node) {
	hideWidget(getWidget(node, TEMPLATE_WIDGET));
	hideWidget(getWidget(node, VALUES_WIDGET));
}

function removeInternalInputSockets(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let i = node.inputs.length - 1; i >= 0; i -= 1) {
		const input = node.inputs[i];
		const name = String(input?.name || "");
		const type = String(input?.type || "");
		const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
		if (!INTERNAL_WIDGETS.has(name) && !INTERNAL_WIDGETS.has(converted)) continue;
		removeInputByIndex(node, i);
	}
}

function widgetTypeFor(field) {
	const valueType = field.valueType || field.type;
	if (valueType === "BOOLEAN") return "toggle";
	if (valueType === "INT" || valueType === "FLOAT") return "number";
	return "text";
}

function widgetOptionsFor(field) {
	const valueType = field.valueType || field.type;
	const explicit = field.explicitType ? `接口类型：${field.type}。` : "";
	const displayName = field.displayLabel || field.label;
	const options = {
		display_name: displayName,
		tooltip: field.tooltip || `${explicit}${field.label}：可手填，也可连接左侧小圆点覆盖。`,
	};
	if (valueType === "INT") Object.assign(options, { min: -2147483648, max: 2147483647, step: 1, precision: 0 });
	if (valueType === "FLOAT") Object.assign(options, { step: 0.01 });
	return options;
}

function removeWidget(node, widget) {
	if (!node?.widgets || !widget) return;
	const index = node.widgets.indexOf(widget);
	if (index >= 0) node.widgets.splice(index, 1);
	try { widget.inputEl?.remove?.(); } catch (_) {}
	try { widget.element?.remove?.(); } catch (_) {}
	try { widget.widget?.remove?.(); } catch (_) {}
}

function createVariableWidget(node, field, value) {
	const options = widgetOptionsFor(field);
	const callback = (nextValue) => {
		if (node.__gjjTemplateSetSyncing) return;
		const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
		saveValues(node, fields);
		setDirty(node);
	};
	let widget = null;
	try {
		widget = node.addWidget(widgetTypeFor(field), field.inputName, coerceValue(value, field.valueType || field.type), callback, options);
	} catch (_) {
		widget = node.addWidget?.("text", field.inputName, String(value ?? ""), callback, options);
	}
	if (widget) {
		widget.__gjjTemplateSetVariable = true;
		widget.__gjjTemplateSetType = field.type;
		widget.__gjjTemplateSetValueType = field.valueType || field.type;
		widget.name = field.inputName;
		widget.label = field.displayLabel || field.label;
		widget.localized_name = field.displayLabel || field.label;
		widget.options = { ...(widget.options || {}), ...options };
	}
	return widget;
}

function setupVariableWidget(node, field, values) {
	let widget = getWidget(node, field.inputName);
	if (widget?.__gjjTemplateSetValueType && widget.__gjjTemplateSetValueType !== (field.valueType || field.type)) {
		removeWidget(node, widget);
		widget = null;
	}
	const value = values[field.key] ?? field.value;
	if (!widget) widget = createVariableWidget(node, field, value);
	if (!widget) return null;
	widget.__gjjTemplateSetVariable = true;
	widget.__gjjTemplateSetType = field.type;
	widget.__gjjTemplateSetValueType = field.valueType || field.type;
	widget.name = field.inputName;
	widget.label = field.displayLabel || field.label;
	widget.localized_name = field.displayLabel || field.label;
	widget.options = { ...(widget.options || {}), ...widgetOptionsFor(field) };
	const coerced = coerceValue(value, field.valueType || field.type);
	if (widget.value !== coerced) widget.value = coerced;
	return widget;
}

function inputAliasesForField(field) {
	return [
		field?.inputName,
		field?.displayLabel,
		field?.label,
		field?.key,
	].map((item) => String(item || "")).filter(Boolean);
}

function findInput(node, name, aliases = []) {
	const names = new Set([name, ...aliases].map((item) => String(item || "")).filter(Boolean));
	return node?.inputs?.find((input) => (
		names.has(String(input?.name || ""))
		|| names.has(inputWidgetName(input))
		|| names.has(String(input?.label || ""))
		|| names.has(String(input?.localized_name || ""))
	)) || null;
}

function removeInputByIndex(node, index) {
	try { node.disconnectInput?.(index); } catch (_) {}
	try { node.removeInput?.(index); } catch (_) { node.inputs?.splice(index, 1); }
}

function setupVariableInput(node, field) {
	let input = findInput(node, field.inputName, inputAliasesForField(field));
	if (!input) {
		try { node.addInput?.(field.inputName, field.type || "*"); } catch (_) {}
		input = findInput(node, field.inputName);
	}
	if (!input) return null;
	input.name = field.inputName;
	input.type = field.type || "*";
	input.label = field.displayLabel || field.label;
	input.localized_name = field.displayLabel || field.label;
	input.tooltip = field.tooltip || `${field.displayLabel || field.label}：连接后会覆盖面板中的默认值。`;
	input.widget = { name: field.inputName };
	return input;
}

function inputWidgetName(input) {
	const widgetName = String(input?.widget?.name || "");
	if (widgetName) return widgetName;
	const type = String(input?.type || "");
	return type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
}

function cleanupVariableInputs(node, fieldNames, fieldAliases = new Set()) {
	if (!Array.isArray(node?.inputs)) return;
	for (let i = node.inputs.length - 1; i >= 0; i -= 1) {
		const input = node.inputs[i];
		const name = String(input?.name || "");
		const widgetName = inputWidgetName(input);
		const label = String(input?.label || "");
		const localizedName = String(input?.localized_name || "");
		if (
			fieldNames.has(name)
			|| fieldNames.has(widgetName)
			|| fieldAliases.has(name)
			|| fieldAliases.has(label)
			|| fieldAliases.has(localizedName)
		) continue;
		removeInputByIndex(node, i);
	}
}

function cleanupVariableWidgets(node, fieldNames) {
	if (!Array.isArray(node?.widgets)) return;
	for (const widget of [...node.widgets]) {
		if (!widget?.__gjjTemplateSetVariable && !String(widget?.name || "").startsWith("var_")) continue;
		if (!fieldNames.has(String(widget.name || ""))) removeWidget(node, widget);
	}
}

function reorderVariableWidgets(node, fields) {
	if (!Array.isArray(node?.widgets)) return;
	const widgets = fields.map((field) => getWidget(node, field.inputName)).filter(Boolean);
	const hiddenWidgets = [getWidget(node, TEMPLATE_WIDGET), getWidget(node, VALUES_WIDGET)].filter(Boolean);
	const domWidget = node.__gjjTemplateSetDomWidget;
	const reserved = new Set([...widgets, ...hiddenWidgets]);
	if (domWidget) reserved.add(domWidget);
	const visibleOthers = node.widgets.filter((widget) => !reserved.has(widget));
	node.widgets = [
		...(domWidget ? [domWidget] : []),
		...widgets,
		...visibleOthers,
		...hiddenWidgets,
	];
}

function repairOutput(node, field, index) {
	const out = node.outputs?.[index];
	if (!out) return;
	const visible = outputsVisible(node);
	out.name = field.displayLabel || field.label;
	out.label = field.displayLabel || field.label;
	out.localized_name = field.displayLabel || field.label;
	out.type = field.type || "*";
	out.tooltip = field.tooltip || `${field.label}（变量名：${field.key}）`;
	out.gjj_template_set_key = field.key;
	out.hidden = !visible;
	out.visible = visible;
	out.disabled = !visible;
	out.not_show = !visible;
	out.__gjj_template_set_hidden = !visible;
	if (typeof node.hideOutput === "function") {
		try { node.hideOutput(index, !visible); } catch (_) {}
	}
}

function updateOutputs(node, fields) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const target = outputsVisible(node) ? Math.max(0, Math.min(MAX_VARIABLES, fields.length)) : 0;
	for (let i = node.outputs.length - 1; i >= target; i -= 1) {
		try { node.removeOutput?.(i); } catch (_) { node.outputs.splice(i, 1); }
	}
	while (node.outputs.length < target) {
		try { node.addOutput?.("变量", "*"); } catch (_) { node.outputs.push({ name: "变量", type: "*", links: [] }); }
	}
	for (let i = 0; i < target; i += 1) repairOutput(node, fields[i], i);
}

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.gjj-template-set-root{box-sizing:border-box;width:100%;padding:2px 0 4px 0;color:#dce7e2;font-family:system-ui,"Microsoft YaHei",sans-serif;pointer-events:auto;}
.gjj-template-set-toolbar{display:flex;align-items:center;gap:6px;min-width:0;}
.gjj-template-set-button{height:25px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:650;white-space:nowrap;}
.gjj-template-set-button:hover{background:#2c3b43;border-color:#6aa6b8;}
.gjj-template-set-button.active{background:#284735;border-color:#69b980;color:#ecfff1;}
.gjj-template-set-count{color:#8ea0a8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-template-set-panel{display:none;flex-direction:column;gap:6px;margin-top:6px;padding:6px;border:1px solid #33464e;border-radius:8px;background:#0d1519;}
.gjj-template-set-template{width:100%;min-height:96px;resize:vertical;padding:7px 8px;border:1px solid #44565f;border-radius:7px;outline:none;background:#070f12;color:#dce7e2;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;}
.gjj-template-set-help{color:#8ea0a8;font-size:11px;line-height:1.45;white-space:pre-wrap;}
.gjj-template-set-actions{display:flex;gap:6px;justify-content:flex-end;}
`;
	document.head.appendChild(style);
}

function defer(callback) {
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(callback);
		return;
	}
	setTimeout(callback, 0);
}

function panelIsOpen(node) {
	const panel = node?.__gjjTemplateSetContainer?.querySelector?.(".gjj-template-set-panel");
	return panel?.style?.display === "flex";
}

function domWidgetHeight(node) {
	const container = node?.__gjjTemplateSetContainer;
	return Math.max(32, Math.ceil(container?.scrollHeight || container?.offsetHeight || 32) + 4);
}

function updateDomWidgetSize(node) {
	const widget = node.__gjjTemplateSetDomWidget;
	const container = node.__gjjTemplateSetContainer;
	if (widget && container) {
		widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || node.size?.[0] || DEFAULT_WIDTH)), domWidgetHeight(node)];
		widget.getHeight = () => domWidgetHeight(node);
	}
}

function naturalNodeHeight(node) {
	updateDomWidgetSize(node);
	const computed = node?.computeSize?.() || node?.size || [DEFAULT_WIDTH, MIN_HEIGHT];
	return Math.max(MIN_HEIGHT, Math.ceil(Number(computed?.[1] || MIN_HEIGHT)));
}

function defaultNodeWidth(currentWidth) {
	const width = Number(currentWidth || 0);
	if (!Number.isFinite(width) || width <= 0 || width > MAX_AUTO_WIDTH) return DEFAULT_WIDTH;
	return Math.max(DEFAULT_WIDTH, width);
}

function setNodeSize(node, width, height) {
	if (!node || node.__gjjTemplateSetSizing) return;
	node.__gjjTemplateSetSizing = true;
	try {
		node.setSize?.([width, height]);
	} finally {
		defer(() => { node.__gjjTemplateSetSizing = false; });
	}
}

function compactNodeSize(node, force = false) {
	if (!node) return;
	updateDomWidgetSize(node);
	const naturalHeight = naturalNodeHeight(node);
	const currentWidth = Number(node.size?.[0] || 0);
	const currentHeight = Number(node.size?.[1] || 0);
	const savedSize = node.__gjjTemplateSetSavedSize;
	const preferSaved = node.__gjjTemplateSetPreferSavedSize && Array.isArray(savedSize);
	const savedHeight = Number(savedSize?.[1] || 0);
	const savedBroken = preferSaved && !panelIsOpen(node) && savedHeight > naturalHeight + MAX_EXTRA_IDLE_HEIGHT;
	const savedTooSmall = preferSaved && savedHeight > 0 && savedHeight < naturalHeight - 2;

	if (preferSaved && !savedBroken && !savedTooSmall && !force) {
		const width = Math.max(MIN_WIDTH, Number(savedSize[0] || DEFAULT_WIDTH));
		const height = Math.max(MIN_HEIGHT, savedHeight || naturalHeight);
		if (Math.abs(currentWidth - width) > 1 || Math.abs(currentHeight - height) > 1) {
			setNodeSize(node, width, height);
		}
		setDirty(node);
		return;
	}

	if (savedBroken) {
		node.__gjjTemplateSetPreferSavedSize = false;
	}

	const useDefaultSize = !node.__gjjTemplateSetAutoSized && (!preferSaved || savedBroken);
	const width = useDefaultSize
		? defaultNodeWidth(currentWidth)
		: Math.max(MIN_WIDTH, Number(currentWidth || DEFAULT_WIDTH));
	const heightBroken = currentHeight > naturalHeight + MAX_EXTRA_IDLE_HEIGHT;
	const heightTooSmall = currentHeight > 0 && currentHeight < naturalHeight - 2;
	const shouldResize = force || useDefaultSize || heightBroken || heightTooSmall || currentWidth < MIN_WIDTH;

	node.__gjjTemplateSetAutoSized = true;
	if (shouldResize) {
		setNodeSize(node, width, naturalHeight);
		node.properties = node.properties || {};
		node.properties[SAVED_SIZE] = [width, naturalHeight];
		node.__gjjTemplateSetSavedSize = [width, naturalHeight];
	}
	setDirty(node);
}

function refreshNode(node, options = {}) {
	updateDomWidgetSize(node);
	if (options.resize === false) {
		setDirty(node);
		return;
	}
	defer(() => compactNodeSize(node, Boolean(options.force)));
	setDirty(node);
}

function buildDom(node) {
	ensureStyles();
	const root = document.createElement("div");
	root.className = "gjj-template-set-root";

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-template-set-toolbar";
	const gear = document.createElement("button");
	gear.type = "button";
	gear.className = "gjj-template-set-button";
	gear.textContent = "⚙ 模板";
	gear.title = "编辑模板设置：每行一个变量。";
	const outputToggle = document.createElement("button");
	outputToggle.type = "button";
	outputToggle.className = "gjj-template-set-button";
	outputToggle.textContent = "🔌";
	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.className = "gjj-template-set-button";
	refresh.textContent = "↻";
	refresh.title = "重新解析模板并刷新输入 / 输出口。";
	const count = document.createElement("span");
	count.className = "gjj-template-set-count";
	toolbar.append(gear, outputToggle, refresh, count);

	const panel = document.createElement("div");
	panel.className = "gjj-template-set-panel";
	const textarea = document.createElement("textarea");
	textarea.className = "gjj-template-set-template";
	textarea.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
	textarea.placeholder = DEFAULT_TEMPLATE;
	const help = document.createElement("div");
	help.className = "gjj-template-set-help";
	help.textContent = [
		"每行一个变量：中文标签（变量Key）[接口类型]：默认值 # 说明",
		"圆括号只表示变量Key；方括号才表示接口类型。",
		"示例：采样帧数（SampleFrames）[INT]：93",
		"示例：比例（SCALE）[INT,FLOAT]：1.0",
		"示例：视频VAE（VIDEO_VAE）[WANVAE]：",
		"示例：批量图（BATCH_IMAGE）[GJJ_BATCH_IMAGE,IMAGE]：",
		"未写 [接口类型] 时，会根据默认值智能判断。",
		"支持 int(1)、float(1)、true / false、string(text)、json({})。",
		"默认隐藏右侧插口；变量读取节点提交前会解析到真实变量来源。点 🔌 可显示同名输出口。",
	].join("\n");
	const actions = document.createElement("div");
	actions.className = "gjj-template-set-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "gjj-template-set-button";
	cancel.textContent = "取消";
	const ok = document.createElement("button");
	ok.type = "button";
	ok.className = "gjj-template-set-button";
	ok.textContent = "确定";
	actions.append(cancel, ok);
	panel.append(textarea, help, actions);
	root.append(toolbar, panel);

	const stop = (event) => event.stopPropagation();
	for (const el of [root, gear, outputToggle, refresh, panel, textarea, cancel, ok]) {
		for (const eventName of ["pointerdown", "mousedown", "click", "keydown", "keyup", "wheel", "dblclick", "contextmenu"]) {
			el.addEventListener(eventName, stop);
		}
	}

	const updateCount = () => {
		const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
		count.textContent = `${fields.length} 个变量 · ${outputsVisible(node) ? "输出开启" : "全局变量"}`;
		updateOutputToggle(node);
	};
	outputToggle.addEventListener("click", (event) => {
		event.preventDefault();
		setOutputsVisible(node, !outputsVisible(node));
		stabilizeNode(node);
		refreshNode(node, { force: true });
	});
	gear.addEventListener("click", (event) => {
		event.preventDefault();
		textarea.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
		const open = panel.style.display !== "flex";
		panel.style.display = open ? "flex" : "none";
		refreshNode(node);
		if (open) setTimeout(() => textarea.focus(), 0);
	});
	refresh.addEventListener("click", (event) => {
		event.preventDefault();
		stabilizeNode(node);
	});
	cancel.addEventListener("click", (event) => {
		event.preventDefault();
		panel.style.display = "none";
		refreshNode(node);
	});
	ok.addEventListener("click", (event) => {
		event.preventDefault();
		const oldValues = valuesFromWidgets(node, parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE)));
		const fields = parseTemplate(textarea.value);
		const nextValues = {};
		for (const field of fields) nextValues[field.key] = oldValues[field.key] ?? field.value;
		setWidgetValue(node, TEMPLATE_WIDGET, textarea.value || DEFAULT_TEMPLATE);
		setWidgetValue(node, VALUES_WIDGET, JSON.stringify(nextValues, null, 2));
		panel.style.display = "none";
		stabilizeNode(node);
	});
	node.__gjjTemplateSetUpdateCount = updateCount;
	node.__gjjTemplateSetContainer = root;
	node.__gjjTemplateSetOutputToggle = outputToggle;
	updateOutputToggle(node);
	updateCount();
	return root;
}

function ensureDom(node) {
	if (!node || node.__gjjTemplateSetDomWidget) return;
	const container = buildDom(node);
	const widget = node.addDOMWidget?.(DOM_WIDGET, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || node.size?.[0] || DEFAULT_WIDTH)), domWidgetHeight(node)];
		widget.getHeight = () => domWidgetHeight(node);
		node.__gjjTemplateSetDomWidget = widget;
	}
}

function stabilizeNode(node) {
	if (!node || node.__gjjTemplateSetStabilizing) return;
	node.__gjjTemplateSetStabilizing = true;
	try {
		ensureDom(node);
		hideInternalWidgets(node);
		removeInternalInputSockets(node);
		ensureOutputVisibilityState(node);
		if (!getWidgetValue(node, TEMPLATE_WIDGET, "")) setWidgetValue(node, TEMPLATE_WIDGET, node.properties?.gjj_template_set_variables_template || DEFAULT_TEMPLATE);
		if (!getWidgetValue(node, VALUES_WIDGET, "")) setWidgetValue(node, VALUES_WIDGET, JSON.stringify(node.properties?.gjj_template_set_variables_values || {}, null, 2));
		const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
		const fieldNames = new Set(fields.map((field) => field.inputName));
		const fieldAliases = new Set(fields.flatMap((field) => inputAliasesForField(field)));
		const values = safeJsonParse(getWidgetValue(node, VALUES_WIDGET, "{}"), {});
		saveFieldSchema(node, fields);
		cleanupVariableInputs(node, fieldNames, fieldAliases);
		cleanupVariableWidgets(node, fieldNames);
		for (const field of fields) {
			setupVariableWidget(node, field, values);
			setupVariableInput(node, field);
		}
		reorderVariableWidgets(node, fields);
		updateOutputs(node, fields);
		saveValues(node, fields);
		node.properties = node.properties || {};
		node.properties.gjj_template_set_variables_template = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
		saveFieldSchema(node, fields);
		node.__gjjTemplateSetUpdateCount?.();
		notifySetGetNodes(node);
		refreshNode(node);
	} finally {
		node.__gjjTemplateSetStabilizing = false;
	}
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjTemplateSetTimer);
	node.__gjjTemplateSetTimer = setTimeout(() => {
		stabilizeNode(node);
		setTimeout(() => compactNodeSize(node), 80);
		setTimeout(() => compactNodeSize(node), 240);
	}, ms);
}

app.registerExtension({
	name: "Comfy.GJJ.TemplateSetVariables",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if ([TEMPLATE_WIDGET, VALUES_WIDGET].includes(name)) hideWidget(widget);
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
			if (props.gjj_template_set_variables_template) setTimeout(() => setWidgetValue(this, TEMPLATE_WIDGET, props.gjj_template_set_variables_template), 0);
			if (props.gjj_template_set_variables_values !== undefined) {
				const savedValues = props.gjj_template_set_variables_values;
				setTimeout(() => setWidgetValue(this, VALUES_WIDGET, typeof savedValues === "string" ? savedValues : JSON.stringify(savedValues, null, 2)), 0);
			}
			this.__gjjTemplateSetOutputsVisible = hasOwn(props, OUTPUTS_VISIBLE_PROPERTY)
				? Boolean(props[OUTPUTS_VISIBLE_PROPERTY])
				: false;
			this.properties = this.properties || {};
			this.properties[OUTPUTS_VISIBLE_PROPERTY] = this.__gjjTemplateSetOutputsVisible;
			if (Array.isArray(props[SAVED_SIZE])) {
				this.__gjjTemplateSetSavedSize = props[SAVED_SIZE].map(Number);
				this.__gjjTemplateSetPreferSavedSize = true;
				this.size = [...this.__gjjTemplateSetSavedSize];
			} else {
				this.__gjjTemplateSetPreferSavedSize = false;
			}
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const fields = parseTemplate(getWidgetValue(this, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
			saveValues(this, fields);
			this.properties = this.properties || {};
			this.properties.gjj_template_set_variables_template = getWidgetValue(this, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties.gjj_template_set_variables_template = this.properties.gjj_template_set_variables_template;
				serializedNode.properties.gjj_template_set_variables_values = this.properties.gjj_template_set_variables_values;
				serializedNode.properties.gjj_template_set_variables_fields = this.properties.gjj_template_set_variables_fields;
				serializedNode.properties.gjj_template_set_variables_setnode = true;
				serializedNode.properties[OUTPUTS_VISIBLE_PROPERTY] = outputsVisible(this);
				this.properties[OUTPUTS_VISIBLE_PROPERTY] = serializedNode.properties[OUTPUTS_VISIBLE_PROPERTY];
				const naturalHeight = naturalNodeHeight(this);
				const currentHeight = Number(this.size?.[1] || MIN_HEIGHT);
				const saveHeight = currentHeight > naturalHeight + MAX_EXTRA_IDLE_HEIGHT ? naturalHeight : currentHeight;
				serializedNode.properties[SAVED_SIZE] = [Number(this.size?.[0] || DEFAULT_WIDTH), saveHeight];
				this.properties[SAVED_SIZE] = serializedNode.properties[SAVED_SIZE];
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjTemplateSetSizing) {
				this.properties = this.properties || {};
				this.properties[SAVED_SIZE] = [Number(this.size?.[0] || DEFAULT_WIDTH), Number(this.size?.[1] || MIN_HEIGHT)];
				this.__gjjTemplateSetSavedSize = [...this.properties[SAVED_SIZE]];
				this.__gjjTemplateSetPreferSavedSize = true;
			}
			refreshNode(this, { resize: false });
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};
	},

	nodeCreated(node) {
		if (node?.comfyClass === TARGET_NODE) scheduleStabilize(node, 0);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET_NODE) stabilizeNode(node);
		}
	},
});

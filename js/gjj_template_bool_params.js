import { app } from "/scripts/app.js";

const TARGET_NODE = "GJJ_TemplateBoolParams";
const BOOLEAN_WIDGET = "boolean";
const BOOLEAN_INPUT = "boolean_input";
const TEMPLATE_WIDGET = "template_text";
const DOM_WIDGET = "gjj_template_bool_params_dom";
const SAVED_TEMPLATE = "gjj_template_bool_params_template";
const SAVED_SIZE = "gjj_template_bool_params_size";
const DEFAULT_TEMPLATE = "#启用加速Lora\n步数（steps）：20|4\n遵循值（cfg）：2.5|1.0";
const DEFAULT_WIDTH = 320;
const MAX_OUTPUTS = 32;

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function getInput(node, name) {
	return node?.inputs?.find((input) => input?.name === name);
}

function boolValue(value, fallback = true) {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	const text = String(value ?? "").trim().toLowerCase();
	if (!text) return fallback;
	if (["1", "true", "yes", "y", "on", "是", "真", "开", "启用"].includes(text)) return true;
	if (["0", "false", "no", "n", "off", "否", "假", "关", "禁用"].includes(text)) return false;
	return fallback;
}

function getBool(node) {
	return boolValue(getWidget(node, BOOLEAN_WIDGET)?.value, true);
}

function setBool(node, value) {
	const widget = getWidget(node, BOOLEAN_WIDGET);
	if (!widget) return;
	const next = Boolean(value);
	widget.value = next;
	widget.callback?.(next);
	if (widget.inputEl) widget.inputEl.checked = next;
	if (widget.element && "checked" in widget.element) widget.element.checked = next;
}

function getGraphLink(node, linkId) {
	if (linkId == null) return null;
	const links = node?.graph?.links || app.graph?.links;
	if (!links) return null;
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function linkedBooleanInfo(node) {
	const input = getInput(node, BOOLEAN_INPUT);
	if (!input || input.link == null) return null;
	const link = getGraphLink(node, input.link);
	const originId = Array.isArray(link) ? link[1] : link?.origin_id;
	const originSlot = Array.isArray(link) ? link[2] : link?.origin_slot;
	const source = node?.graph?.getNodeById?.(originId)
		|| app.graph?.getNodeById?.(originId)
		|| app.graph?._nodes?.find((item) => String(item?.id) === String(originId))
		|| null;
	const output = source?.outputs?.[Number(originSlot)];
	const outputLabel = String(output?.localized_name || output?.label || output?.name || "").trim();
	const nodeLabel = String(source?.title || source?.properties?.NodeName || source?.comfyClass || "").trim();
	const label = outputLabel || nodeLabel || "外部布尔";
	return { label, nodeLabel, outputLabel };
}

function getWidgetValue(node, name, fallback = "") {
	return String(getWidget(node, name)?.value ?? fallback ?? "");
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	const next = String(value ?? "");
	widget.value = next;
	widget.callback?.(next);
	if (widget.inputEl) widget.inputEl.value = next;
	if (widget.element && "value" in widget.element) widget.element.value = next;
}

function stripQuotes(text) {
	const raw = String(text ?? "").trim();
	if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
		return raw.slice(1, -1);
	}
	return raw;
}

function splitPair(text) {
	const raw = String(text || "");
	let escaped = false;
	let quote = "";
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"' || char === "'") {
			if (quote === char) quote = "";
			else if (!quote) quote = char;
			continue;
		}
		if ((char === "|" || char === "｜") && !quote) {
			return [
				raw.slice(0, index).replace(/\\\|/g, "|").trim(),
				raw.slice(index + 1).replace(/\\\|/g, "|").trim(),
			];
		}
	}
	const value = raw.replace(/\\\|/g, "|").trim();
	return [value, value];
}

function parseValue(value) {
	const raw = String(value ?? "").trim();
	if (!raw) return "";
	const forced = raw.match(/^\s*(int|float|str|string|bool|boolean|json|none|null)\s*\(([\s\S]*)\)\s*$/i);
	if (forced) {
		const kind = forced[1].toLowerCase();
		const inner = forced[2].trim();
		if (kind === "int") return Number.parseInt(Number.parseFloat(stripQuotes(inner) || "0"), 10);
		if (kind === "float") return Number.parseFloat(stripQuotes(inner) || "0");
		if (kind === "str" || kind === "string") return stripQuotes(inner);
		if (kind === "bool" || kind === "boolean") return boolValue(stripQuotes(inner), false);
		if (kind === "none" || kind === "null") return null;
		if (kind === "json") {
			try { return JSON.parse(inner); } catch (_) { return stripQuotes(inner); }
		}
	}
	if (/^(true|yes|y|on|是|真|开|启用)$/i.test(raw)) return true;
	if (/^(false|no|n|off|否|假|关|禁用)$/i.test(raw)) return false;
	if (/^(none|null|nil|空)$/i.test(raw)) return null;
	if (/^[-+]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) || /^[-+]?\d+[eE][-+]?\d+$/.test(raw)) return Number.parseFloat(raw);
	if (raw.startsWith("[") || raw.startsWith("{")) {
		try { return JSON.parse(raw); } catch (_) {}
	}
	return raw;
}

function hasFloatSyntax(value) {
	const raw = String(value ?? "").trim();
	if (/^\s*float\s*\(/i.test(raw)) return true;
	return /^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) || /^[-+]?\d+[eE][-+]?\d+$/.test(raw);
}

function inferType(trueValue, falseValue, trueRaw = "", falseRaw = "") {
	const values = [trueValue, falseValue];
	if (values.every((item) => typeof item === "boolean")) return "BOOLEAN";
	if (values.every((item) => typeof item === "number" && Number.isFinite(item))) {
		if (hasFloatSyntax(trueRaw) || hasFloatSyntax(falseRaw)) return "FLOAT";
		if (values.every((item) => Number.isInteger(item))) return "INT";
		return "FLOAT";
	}
	if (values.every((item) => typeof item === "string")) return "STRING";
	return "*";
}

function labelAndKey(rawLabel, index) {
	let label = String(rawLabel || "").trim() || `参数 ${index + 1}`;
	let key = label;
	const match = label.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
	if (match) {
		label = match[1].trim() || label;
		key = match[2].trim() || key;
	}
	key = key.replace(/[^0-9A-Za-z_\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "") || `param_${index + 1}`;
	return { label, key };
}

function parseTemplate(templateText) {
	const fields = [];
	const seen = new Map();
	for (const line of String(templateText || DEFAULT_TEMPLATE).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
		const raw = line.trim();
		if (!raw || raw.startsWith("#") || raw.startsWith("//") || raw.startsWith(";")) continue;
		if (["...", "....", "…", "……"].includes(raw)) continue;
		const match = raw.match(/^([^:：=]+?)\s*[:：=]\s*([\s\S]*?)\s*$/);
		if (!match) continue;
		const { label, key: rawKey } = labelAndKey(match[1], fields.length);
		const count = seen.get(rawKey) || 0;
		seen.set(rawKey, count + 1);
		const key = count ? `${rawKey}_${count + 1}` : rawKey;
		const [trueRaw, falseRaw] = splitPair(match[2]);
		const trueValue = parseValue(trueRaw);
		const falseValue = parseValue(falseRaw);
		fields.push({
			label,
			key,
			trueRaw,
			falseRaw,
			trueValue,
			falseValue,
			type: inferType(trueValue, falseValue, trueRaw, falseRaw),
		});
		if (fields.length >= MAX_OUTPUTS) break;
	}
	return fields;
}

function templateButtonLabel(templateText) {
	for (const line of String(templateText || DEFAULT_TEMPLATE).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
		const raw = line.trim();
		if (!raw.startsWith("#")) continue;
		const label = raw.replace(/^#+/, "").trim();
		if (label) return label;
	}
	return "布尔输入";
}

function fieldDisplay(field) {
	if (!field) return "参数";
	return field.key && field.key !== field.label ? `${field.label}（${field.key}）` : field.label;
}

function displayValue(value) {
	if (value === null) return "null";
	if (value === undefined) return "";
	if (typeof value === "object") {
		try { return JSON.stringify(value); } catch (_) { return String(value); }
	}
	return String(value);
}

function displayTemplateValue(value, rawValue = "") {
	const raw = String(rawValue ?? "").trim();
	if (typeof value === "number" && Number.isFinite(value) && hasFloatSyntax(raw) && !/^\s*float\s*\(/i.test(raw)) {
		return raw;
	}
	return displayValue(value);
}

function outputHasLinks(output) {
	if (!output) return false;
	if (Array.isArray(output.links)) return output.links.length > 0;
	return output.link != null;
}

function highestLinkedOutputIndex(node) {
	if (!Array.isArray(node?.outputs)) return -1;
	let highest = -1;
	for (let index = 0; index < node.outputs.length; index += 1) {
		if (outputHasLinks(node.outputs[index])) highest = index;
	}
	return highest;
}

function outputFromField(field, index) {
	const slotName = `输出${index + 1}`;
	const displayName = fieldDisplay(field);
	return {
		name: slotName,
		label: displayName,
		localized_name: displayName,
		display_name: displayName,
		displayName: displayName,
		type: field?.type || "*",
		links: null,
		slot_index: index,
		gjj_template_bool_key: field?.key || "",
	};
}

function repairOutput(node, field, index) {
	const output = node.outputs?.[index];
	if (!output || !field) return;
	const slotName = `输出${index + 1}`;
	const displayName = fieldDisplay(field);
	output.name = slotName;
	output.label = displayName;
	output.localized_name = displayName;
	output.display_name = displayName;
	output.displayName = displayName;
	output.type = field.type || "*";
	output.tooltip = `${displayName}\n为真：${displayTemplateValue(field.trueValue, field.trueRaw)}\n为假：${displayTemplateValue(field.falseValue, field.falseRaw)}`;
	output.slot_index = index;
	output.gjj_template_bool_key = field.key || "";
}

function repairVisibleOutputs(node) {
	const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
	const target = Math.min(fields.length, node?.outputs?.length || 0, MAX_OUTPUTS);
	for (let index = 0; index < target; index += 1) repairOutput(node, fields[index], index);
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function scheduleOutputRepair(node) {
	if (!node) return;
	for (const timer of node.__gjjTemplateBoolRepairTimers || []) clearTimeout(timer);
	node.__gjjTemplateBoolRepairTimers = [];
	requestAnimationFrame(() => repairVisibleOutputs(node));
	for (const delay of [0, 80, 240, 500]) {
		node.__gjjTemplateBoolRepairTimers.push(setTimeout(() => repairVisibleOutputs(node), delay));
	}
}

function updateOutputs(node, fields) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const target = Math.min(MAX_OUTPUTS, fields.length);
	const preserve = Math.max(target, highestLinkedOutputIndex(node) + 1);
	for (let index = node.outputs.length - 1; index >= preserve; index -= 1) {
		if (outputHasLinks(node.outputs[index])) continue;
		try { node.removeOutput?.(index); } catch (_) { node.outputs.splice(index, 1); }
	}
	while (node.outputs.length < target) {
		const field = fields[node.outputs.length];
		try { node.addOutput?.(fieldDisplay(field), field?.type || "*"); }
		catch (_) { node.outputs.push(outputFromField(field, node.outputs.length)); }
	}
	for (let index = 0; index < target; index += 1) repairOutput(node, fields[index], index);
	scheduleOutputRepair(node);
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

function collapseWidget(widget) {
	if (!widget) return;
	safeAssign(widget, "hidden", true);
	safeAssign(widget, "disabled", true);
	safeAssign(widget, "type", `converted-widget:${widget.name || "hidden"}`);
	safeAssign(widget, "label", "");
	safeAssign(widget, "computeSize", () => [0, 0]);
	safeAssign(widget, "getHeight", () => 0);
	safeAssign(widget, "draw", () => {});
	safeAssign(widget, "mouse", () => false);
	safeAssign(widget, "size", [0, 0]);
	safeAssign(widget, "height", 0);
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
	collapseElement(widget.inputEl);
	collapseElement(widget.element);
	collapseElement(widget.widget);
}

function currentNodeWidth(node) {
	const width = Number(node?.size?.[0]);
	return Number.isFinite(width) && width > 0 ? width : DEFAULT_WIDTH;
}

function domHeight(node) {
	const container = node?.__gjjTemplateBoolContainer;
	return Math.max(66, Math.ceil(container?.scrollHeight || container?.offsetHeight || 66) + 8);
}

function refreshNode(node, resize = true) {
	if (!node) return;
	const widget = node.__gjjTemplateBoolWidget;
	if (widget) {
		widget.computeSize = (width) => [Number(width || currentNodeWidth(node)), domHeight(node)];
		widget.getHeight = () => domHeight(node);
	}
	if (resize && !node.__gjjTemplateBoolSizing) {
		node.__gjjTemplateBoolSizing = true;
		try {
			node.setSize?.([currentNodeWidth(node), domHeight(node)]);
		} finally {
			requestAnimationFrame(() => { node.__gjjTemplateBoolSizing = false; });
		}
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function saveTemplate(node, template) {
	setWidgetValue(node, TEMPLATE_WIDGET, template || DEFAULT_TEMPLATE);
	node.properties = node.properties || {};
	node.properties[SAVED_TEMPLATE] = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
}

function saveSize(node) {
	node.properties = node.properties || {};
	node.properties[SAVED_SIZE] = [Number(node.size?.[0] || DEFAULT_WIDTH), Number(node.size?.[1] || 80)];
}

function renderRows(node) {
	const rows = node.__gjjTemplateBoolRows;
	const count = node.__gjjTemplateBoolCount;
	if (!rows) return;
	const fields = parseTemplate(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
	const enabled = getBool(node);
	rows.replaceChildren();
	for (const field of fields) {
		const row = document.createElement("div");
		row.className = "gjj-template-bool-row";
		const label = document.createElement("div");
		label.className = "gjj-template-bool-label";
		label.textContent = `${fieldDisplay(field)}：`;
		label.title = `输出类型：${field.type || "*"}`;
		const values = document.createElement("div");
		values.className = "gjj-template-bool-values";
		const yes = document.createElement("span");
		yes.className = `gjj-template-bool-pill yes ${enabled ? "active" : ""}`;
		yes.textContent = `【✔️${displayTemplateValue(field.trueValue, field.trueRaw)}】`;
		const sep = document.createElement("span");
		sep.className = "gjj-template-bool-sep";
		sep.textContent = "|";
		const no = document.createElement("span");
		no.className = `gjj-template-bool-pill no ${!enabled ? "active" : ""}`;
		no.textContent = `【❌${displayTemplateValue(field.falseValue, field.falseRaw)}】`;
		values.append(yes, sep, no);
		row.append(label, values);
		rows.appendChild(row);
	}
	if (!fields.length) {
		const empty = document.createElement("div");
		empty.className = "gjj-template-bool-empty";
		empty.textContent = "点击 ⚙ 设置，按“名称（key）：真值|假值”填写模板。";
		rows.appendChild(empty);
	}
	if (count) count.textContent = `${fields.length} 个输出`;
	updateOutputs(node, fields);
	refreshNode(node);
}

function updateToggleButton(node) {
	const button = node.__gjjTemplateBoolToggle;
	if (!button) return;
	const external = linkedBooleanInfo(node);
	const enabled = getBool(node);
	const label = templateButtonLabel(getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE));
	if (external) {
		button.dataset.value = "external";
		button.classList.add("external");
		button.classList.remove("on");
		button.textContent = `🔗 ${label}`;
		button.title = external.nodeLabel && external.outputLabel
			? `已连接外部布尔：${external.nodeLabel} / ${external.outputLabel}\n按钮文字来自模板首行 #${label}。`
			: `已连接外部布尔：${external.label}\n按钮文字来自模板首行 #${label}。`;
		return;
	}
	button.classList.remove("external");
	button.dataset.value = String(enabled);
	button.classList.toggle("on", enabled);
	button.textContent = `${enabled ? "✔" : "❌"} ${label}`;
	button.title = `点击切换：${label}；若该布尔控件被外接，执行时以外部输入为准。`;
}

function buildDom(node) {
	const root = document.createElement("div");
	root.className = "gjj-template-bool";
	root.style.cssText = "width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:0;";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-template-bool *{box-sizing:border-box;}
		.gjj-template-bool-toolbar{display:flex;align-items:center;gap:6px;min-width:0;}
		.gjj-template-bool-gear,.gjj-template-bool-toggle,.gjj-template-bool-ok,.gjj-template-bool-cancel{height:25px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:650;white-space:nowrap;}
		.gjj-template-bool-gear:hover,.gjj-template-bool-toggle:hover,.gjj-template-bool-ok:hover,.gjj-template-bool-cancel:hover{background:#2c3b43;border-color:#6aa6b8;}
		.gjj-template-bool-toggle{max-width:168px;overflow:hidden;text-overflow:ellipsis;}
		.gjj-template-bool-toggle.on{background:#20362f;border-color:#69b980;color:#ecfff1;}
		.gjj-template-bool-toggle.external{background:#2a2417;border-color:#8a7440;color:#fff2c7;}
		.gjj-template-bool-count{color:#8ea0a8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.gjj-template-bool-panel{display:none;flex-direction:column;gap:6px;padding:6px;border:1px solid #33464e;border-radius:8px;background:#0d1519;}
		.gjj-template-bool-template{width:100%;min-height:78px;resize:vertical;padding:7px 8px;border:1px solid #44565f;border-radius:7px;outline:none;background:#070f12;color:#dce7e2;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;}
		.gjj-template-bool-help{color:#8ea0a8;font-size:11px;line-height:1.45;white-space:pre-wrap;}
		.gjj-template-bool-actions{display:flex;gap:6px;justify-content:flex-end;}
		.gjj-template-bool-rows{display:flex;flex-direction:column;gap:5px;}
		.gjj-template-bool-row{display:grid;grid-template-columns:92px minmax(0,1fr);gap:6px;align-items:center;min-width:0;}
		.gjj-template-bool-label{color:#b9c8cc;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		.gjj-template-bool-values{height:28px;display:flex;align-items:center;gap:4px;min-width:0;padding:4px 7px;border:1px solid #253940;border-radius:7px;background:#151f24;color:#c7d4d7;font-size:12px;overflow:hidden;}
		.gjj-template-bool-pill{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7;}
		.gjj-template-bool-pill.active{opacity:1;font-weight:800;}
		.gjj-template-bool-pill.yes.active{color:#bff4cf;}
		.gjj-template-bool-pill.no.active{color:#ffb4a8;}
		.gjj-template-bool-sep{color:#62747d;flex:0 0 auto;}
		.gjj-template-bool-empty{color:#8ea0a8;font-size:12px;padding:3px 0;}
	`;

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-template-bool-toolbar";
	const gear = document.createElement("button");
	gear.type = "button";
	gear.className = "gjj-template-bool-gear";
	gear.textContent = "⚙️ 设置";
	gear.title = "编辑模板：每行一个输出，格式：名称（key）：真值|假值。";
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "gjj-template-bool-toggle";
	const count = document.createElement("span");
	count.className = "gjj-template-bool-count";
	toolbar.append(gear, toggle, count);

	const panel = document.createElement("div");
	panel.className = "gjj-template-bool-panel";
	const textarea = document.createElement("textarea");
	textarea.className = "gjj-template-bool-template";
	textarea.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
	textarea.placeholder = DEFAULT_TEMPLATE;
	const help = document.createElement("div");
	help.className = "gjj-template-bool-help";
	help.textContent = [
		"第一行可写按钮文字：#启用加速Lora",
		"每行一个输出：名称（key）：真值|假值",
		"示例：步数（steps）：20|4",
		"示例：遵循值（cfg）：2.5|1.0",
		"布尔为真取左值，布尔为假取右值；输出口会按名称和类型自动刷新。",
	].join("\n");
	const actions = document.createElement("div");
	actions.className = "gjj-template-bool-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "gjj-template-bool-cancel";
	cancel.textContent = "取消";
	const ok = document.createElement("button");
	ok.type = "button";
	ok.className = "gjj-template-bool-ok";
	ok.textContent = "确定";
	actions.append(cancel, ok);
	panel.append(textarea, help, actions);

	const rows = document.createElement("div");
	rows.className = "gjj-template-bool-rows";

	const stop = (event) => event.stopPropagation();
	for (const el of [root, gear, toggle, panel, textarea, cancel, ok]) {
		for (const eventName of ["pointerdown", "mousedown", "click", "keydown", "keyup", "wheel", "dblclick", "contextmenu"]) {
			el.addEventListener(eventName, stop);
		}
	}

	gear.addEventListener("click", (event) => {
		event.preventDefault();
		textarea.value = getWidgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
		const opening = panel.style.display !== "flex";
		panel.style.display = opening ? "flex" : "none";
		refreshNode(node);
		if (opening) setTimeout(() => textarea.focus(), 0);
	});
	toggle.addEventListener("click", (event) => {
		event.preventDefault();
		if (linkedBooleanInfo(node)) return;
		setBool(node, !getBool(node));
		updateToggleButton(node);
		renderRows(node);
	});
	cancel.addEventListener("click", (event) => {
		event.preventDefault();
		panel.style.display = "none";
		refreshNode(node);
	});
	ok.addEventListener("click", (event) => {
		event.preventDefault();
		saveTemplate(node, textarea.value || DEFAULT_TEMPLATE);
		panel.style.display = "none";
		updateToggleButton(node);
		renderRows(node);
	});

	root.append(style, toolbar, panel, rows);
	node.__gjjTemplateBoolContainer = root;
	node.__gjjTemplateBoolRows = rows;
	node.__gjjTemplateBoolCount = count;
	node.__gjjTemplateBoolToggle = toggle;
	updateToggleButton(node);
	return root;
}

function ensureDom(node) {
	if (!node || node.__gjjTemplateBoolWidget) return;
	const container = buildDom(node);
	const widget = node.addDOMWidget?.(DOM_WIDGET, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.computeSize = (width) => [Number(width || currentNodeWidth(node)), domHeight(node)];
		widget.getHeight = () => domHeight(node);
		node.__gjjTemplateBoolWidget = widget;
	}
}

function stabilize(node) {
	if (!node) return;
	if (!getWidgetValue(node, TEMPLATE_WIDGET, "")) {
		setWidgetValue(node, TEMPLATE_WIDGET, node.properties?.[SAVED_TEMPLATE] || DEFAULT_TEMPLATE);
	}
	ensureDom(node);
	collapseWidget(getWidget(node, BOOLEAN_WIDGET));
	collapseWidget(getWidget(node, TEMPLATE_WIDGET));
	updateToggleButton(node);
	renderRows(node);
}

function scheduleStabilize(node, ms = 0) {
	clearTimeout(node.__gjjTemplateBoolTimer);
	node.__gjjTemplateBoolTimer = setTimeout(() => stabilize(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.TemplateBoolParams",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if ([BOOLEAN_WIDGET, TEMPLATE_WIDGET].includes(name)) collapseWidget(widget);
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
			if (props[SAVED_TEMPLATE]) setWidgetValue(this, TEMPLATE_WIDGET, props[SAVED_TEMPLATE]);
			if (Array.isArray(props[SAVED_SIZE])) {
				this.__gjjTemplateBoolSavedSize = props[SAVED_SIZE].map(Number);
				this.size = [...this.__gjjTemplateBoolSavedSize];
			}
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			this.properties = this.properties || {};
			this.properties[SAVED_TEMPLATE] = getWidgetValue(this, TEMPLATE_WIDGET, DEFAULT_TEMPLATE);
			saveSize(this);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[SAVED_TEMPLATE] = this.properties[SAVED_TEMPLATE];
				serializedNode.properties[SAVED_SIZE] = this.properties[SAVED_SIZE];
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjTemplateBoolSizing) saveSize(this);
			refreshNode(this, false);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};
	},

	nodeCreated(node) {
		if (node?.comfyClass === TARGET_NODE) scheduleStabilize(node, 0);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET_NODE) stabilize(node);
		}
	},
});

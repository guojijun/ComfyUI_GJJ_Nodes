import { app } from "/scripts/app.js";

export const TEMPLATE_SOURCE_PROPERTY = "gjj_generation_template_sources";
let ACTIVE_TEMPLATE_SOURCE_POPUP = null;

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function getInput(node, name) {
	return node?.inputs?.find((input) => input?.name === name) || null;
}

function inputHasLink(input) {
	if (!input) return false;
	if (Array.isArray(input.link)) return input.link.length > 0;
	return input.link != null;
}

function setWidgetValue(widget, value, field) {
	if (!widget || value === undefined || value === null) return;
	let next = value;
	if (field?.type === "INT") {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return;
		next = Math.round(numeric);
	} else if (field?.type === "FLOAT") {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return;
		next = numeric;
	} else if (field?.type === "BOOLEAN") {
		next = typeof value === "string" ? ["true", "1", "yes", "on", "是", "开启"].includes(value.trim().toLowerCase()) : Boolean(value);
	} else {
		next = String(value);
	}
	if (widget.value === next) return;
	widget.value = next;
	if (widget.inputEl) {
		if (widget.inputEl.type === "checkbox") widget.inputEl.checked = Boolean(next);
		else if ("value" in widget.inputEl) widget.inputEl.value = String(next);
	}
	if (widget.element && "value" in widget.element) widget.element.value = next;
	widget.callback?.(next);
}

function rememberEnabledState(widget) {
	if (!widget || widget.__gjjTemplateSourceEnabledState) return;
	widget.__gjjTemplateSourceEnabledState = {
		disabled: widget.hidden || widget.options?.hidden ? false : widget.disabled,
		optionsDisabled: widget.options?.disabled,
		inputDisabled: widget.inputEl?.disabled,
		elementDisabled: widget.element && "disabled" in widget.element ? widget.element.disabled : undefined,
		inputOpacity: widget.inputEl?.style?.opacity || "",
		elementOpacity: widget.element?.style?.opacity || "",
	};
}

function setWidgetEnabled(widget, enabled) {
	if (!widget) return;
	rememberEnabledState(widget);
	const state = widget.__gjjTemplateSourceEnabledState || {};
	widget.options = widget.options || {};
	if (enabled) {
		widget.disabled = Boolean(state.disabled);
		if (state.optionsDisabled === undefined) delete widget.options.disabled;
		else widget.options.disabled = state.optionsDisabled;
		if (widget.inputEl) {
			widget.inputEl.disabled = Boolean(state.inputDisabled);
			widget.inputEl.style.opacity = state.inputOpacity || "";
		}
		if (widget.element && "disabled" in widget.element) {
			widget.element.disabled = Boolean(state.elementDisabled);
			widget.element.style.opacity = state.elementOpacity || "";
		}
		return;
	}
	widget.disabled = true;
	widget.options.disabled = true;
	if (widget.inputEl) {
		widget.inputEl.disabled = true;
		widget.inputEl.style.opacity = "0.45";
	}
	if (widget.element && "disabled" in widget.element) {
		widget.element.disabled = true;
		widget.element.style.opacity = "0.45";
	}
}

function selectedSources(node) {
	const raw = node?.properties?.[TEMPLATE_SOURCE_PROPERTY];
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
	if (typeof raw === "string" && raw.trim()) {
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch (_) {
			return {};
		}
	}
	return {};
}

function setSelectedSource(node, fieldName, variableName) {
	node.properties = node.properties || {};
	const sources = selectedSources(node);
	const value = String(variableName || "").trim();
	if (value) sources[fieldName] = value;
	else delete sources[fieldName];
	node.properties[TEMPLATE_SOURCE_PROPERTY] = sources;
	updateTemplateSourcePanel(node);
	window.dispatchEvent(new CustomEvent("gjj-generation-template-sources-updated", { detail: { node } }));
}

function setSelectedSources(node, sources) {
	node.properties = node.properties || {};
	const clean = {};
	for (const [key, value] of Object.entries(sources || {})) {
		const text = String(value || "").trim();
		if (text) clean[key] = text;
	}
	node.properties[TEMPLATE_SOURCE_PROPERTY] = clean;
	updateTemplateSourcePanel(node);
	window.dispatchEvent(new CustomEvent("gjj-generation-template-sources-updated", { detail: { node } }));
}

function variableOptions(node) {
	const apiObject = globalThis.GJJ_VariableBroadcast;
	const graph = node?.graph || app.graph;
	return typeof apiObject?.getVisibleSetOptions === "function" ? (apiObject.getVisibleSetOptions(graph) || []) : [];
}

function optionDisplay(option) {
	const value = String(option?.value || "").trim();
	const label = String(option?.label || value).trim();
	const match = label.match(/^[^()（）]+[（(]([^()（）]+?)[\s·]+([^()（）]+?)[）)]$/);
	if (match) return { title: match[2].trim() || value, source: match[1].trim(), value };
	const parts = String(option?.source || "").split(/\s*[·]\s*/).filter(Boolean);
	return { title: parts[1] || label || value, source: parts[0] || "", value };
}

function optionMatchesField(option, field) {
	const aliases = (field.aliases || []).map((item) => String(item || "").toLowerCase()).filter(Boolean);
	if (!aliases.length) return true;
	const text = [option?.value, option?.label, option?.source].join(" ").toLowerCase();
	return aliases.some((alias) => text.includes(alias));
}

function graphNodeById(graph, id) {
	if (id == null || !graph) return null;
	return graph.getNodeById?.(id)
		|| graph._nodes_by_id?.[id]
		|| graph._nodes?.find((node) => String(node?.id) === String(id))
		|| null;
}

function getGraphLink(graph, linkId) {
	if (linkId == null || !graph) return null;
	if (typeof graph.getLink === "function") return graph.getLink(linkId);
	const links = graph.links || graph._links || {};
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkOriginSlot(link) {
	return Array.isArray(link) ? link[2] : link?.origin_slot;
}

function nodeType(node) {
	return node?.type || node?.comfyClass || node?.constructor?.type || "";
}

function isTemplateVariableNode(node) {
	const type = nodeType(node);
	return type === "GJJ_TemplateParams"
		|| type === "GJJ_TemplateSetVariables"
		|| type === "GJJ_SETNODE"
		|| type === "GJJ_SetNode";
}

function parseJsonObject(value) {
	if (!value || typeof value === "object") return value && !Array.isArray(value) ? value : {};
	try {
		const parsed = JSON.parse(String(value));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (_) {
		return {};
	}
}

function fieldCandidates(field) {
	return [
		field?.key,
		field?.broadcastKey,
		field?.broadcast_key,
		field?.inputName,
		field?.label,
		field?.displayLabel,
		...(Array.isArray(field?.broadcastKeys) ? field.broadcastKeys : []),
		...(Array.isArray(field?.broadcast_keys) ? field.broadcast_keys : []),
	].map((item) => String(item || "").trim()).filter(Boolean);
}

function findFieldForVariable(node, slot, name) {
	const props = node?.properties || {};
	const fields = Array.isArray(props.gjj_template_params_schema) ? props.gjj_template_params_schema
		: Array.isArray(props.gjj_template_set_variables_fields) ? props.gjj_template_set_variables_fields
			: [];
	const bySlot = fields.find((field, index) => Number(field?.outputIndex ?? field?.output_index ?? index) === Number(slot));
	if (bySlot) return bySlot;
	return fields.find((field) => fieldCandidates(field).includes(name)) || null;
}

function valueFromTemplateNode(node, field, name, graph) {
	const props = node?.properties || {};
	const values = parseJsonObject(props.gjj_template_params_values || props.gjj_template_set_variables_values);
	const mappedMediaValue = (value) => {
		const key = String(field?.key || "").trim();
		const mapping = key ? node?.__gjjTemplateParamsNetworkMappings?.get?.(key) : null;
		const original = String(value ?? "").trim();
		if (mapping?.path && (!mapping.url || String(mapping.url).trim() === original)) {
			return mapping.path;
		}
		return value;
	};
	for (const key of fieldCandidates(field).concat(name)) {
		if (Object.prototype.hasOwnProperty.call(values, key)) return mappedMediaValue(values[key]);
	}
	const inputName = field?.inputName;
	if (inputName) {
		const input = node.inputs?.find((item) => item?.name === inputName);
		const link = getGraphLink(graph || node?.graph || app.graph, input?.link);
		if (link) {
			const upstream = graphNodeById(graph || node?.graph || app.graph, linkOriginId(link));
			return valueFromNodeOutput(upstream, Number(linkOriginSlot(link) || 0), graph || node?.graph || app.graph);
		}
	}
	return mappedMediaValue(field?.value ?? field?.default ?? field?.defaultValue);
}

function widgetCurrentValue(widget) {
	if (!widget) return undefined;
	if (typeof widget.value !== "undefined") return widget.value;
	if (widget.inputEl) {
		if (widget.inputEl.type === "checkbox") return widget.inputEl.checked;
		if ("value" in widget.inputEl) return widget.inputEl.value;
	}
	if (widget.element) {
		if (widget.element.type === "checkbox") return widget.element.checked;
		if ("value" in widget.element) return widget.element.value;
	}
	return undefined;
}

function valueFromNodeOutput(source, slot, graph, variableName = "") {
	if (!source) return undefined;
	if (isTemplateVariableNode(source)) {
		const field = findFieldForVariable(source, Number(slot || 0), variableName);
		return valueFromTemplateNode(source, field, variableName, graph || source.graph || app.graph);
	}
	const output = source.outputs?.[Number(slot || 0)];
	if (typeof output?.value !== "undefined") return output.value;
	const widget = source.widgets?.[Number(slot || 0)] || source.widgets?.[0];
	const widgetValue = widgetCurrentValue(widget);
	if (typeof widgetValue !== "undefined") return widgetValue;
	if (Array.isArray(source.widgets_values) && source.widgets_values.length) {
		return source.widgets_values[Number(slot || 0)] ?? source.widgets_values[0];
	}
	return undefined;
}

function resolveVariableValue(node, variableName) {
	const resolver = globalThis.GJJ_VariableBroadcast?.resolveVariableBroadcastSource;
	if (!variableName || typeof resolver !== "function") return undefined;
	const graph = node?.graph || app.graph;
	const resolved = resolver(graph, variableName);
	if (!Array.isArray(resolved) || resolved.length !== 2) return undefined;
	const source = graphNodeById(graph, resolved[0]);
	return valueFromNodeOutput(source, Number(resolved[1] || 0), graph, variableName);
}

function closePopup(popup) {
	popup?.remove?.();
	if (!popup || ACTIVE_TEMPLATE_SOURCE_POPUP === popup) {
		ACTIVE_TEMPLATE_SOURCE_POPUP = null;
	}
}

export function closeTemplateSourcePicker() {
	closePopup(ACTIVE_TEMPLATE_SOURCE_POPUP);
}

function openVariablePicker(node, field = null) {
	const fields = field ? [field] : (node.__gjjTemplateSourceFields || []);
	if (!fields.length) return;
	window.dispatchEvent(new CustomEvent("gjj-template-source-picker-opening", { detail: { node } }));
	closeTemplateSourcePicker();
	const sources = selectedSources(node);
	const draftSources = { ...sources };
	const allOptions = variableOptions(node);
	let activeVariable = allOptions.find((option) => Object.values(draftSources).includes(option?.value))?.value
		|| allOptions[0]?.value
		|| "";

	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed",
		"z-index:100000",
		"width:min(720px,calc(100vw - 28px))",
		"max-height:min(540px,calc(100vh - 40px))",
		"display:flex",
		"flex-direction:column",
		"gap:7px",
		"padding:9px",
		"border:1px solid #45606a",
		"border-radius:8px",
		"background:#10191e",
		"color:#dce7e2",
		"box-shadow:0 12px 32px rgba(0,0,0,.45)",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
		"box-sizing:border-box",
	].join(";");

	const anchor = node?.__gjjTemplateSourceButton || node?.__gjjTemplateSourcePanel;
	const rect = anchor?.getBoundingClientRect?.();
	const popupWidth = Math.min(720, Math.max(360, window.innerWidth - 28));
	const left = Math.min(window.innerWidth - popupWidth - 14, Math.max(14, rect?.left || 80));
	const top = Math.min(window.innerHeight - 120, Math.max(14, (rect?.bottom || 80) + 6));
	popup.style.left = `${Math.round(left)}px`;
	popup.style.top = `${Math.round(top)}px`;

	const head = document.createElement("div");
	head.style.cssText = "display:flex;align-items:center;gap:6px;min-height:28px;border-bottom:1px solid #263842;padding-bottom:5px;";
	const title = document.createElement("div");
	title.textContent = field ? `⚡ 选择${field.label}变量` : "⚡ 选择参数变量";
	title.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800;";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.textContent = field ? "清空" : "清空全部";
	clear.style.cssText = "height:24px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 8px;";
	clear.onclick = () => {
		if (field) {
			delete draftSources[field.name];
		} else {
			for (const item of fields) delete draftSources[item.name];
		}
		render();
	};
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.style.cssText = "width:24px;height:24px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0;";
	close.onclick = () => closePopup(popup);
	head.append(title, clear, close);

	const search = document.createElement("input");
	search.placeholder = "搜索变量，点击选择";
	search.style.cssText = "height:30px;border:1px solid #3f5b66;border-radius:7px;background:#071015;color:#dce7e2;padding:0 10px;outline:none;";

	const columns = document.createElement("div");
	columns.style.cssText = "display:grid;grid-template-columns:minmax(220px,0.95fr) minmax(240px,1.05fr);gap:8px;min-height:0;max-height:400px;";
	const variableColumn = document.createElement("div");
	variableColumn.style.cssText = "min-width:0;overflow:auto;display:flex;flex-direction:column;gap:5px;border:1px solid #253842;border-radius:7px;padding:6px;background:#0b1418;";
	const matchColumn = document.createElement("div");
	matchColumn.style.cssText = "min-width:0;overflow:auto;display:flex;flex-direction:column;gap:5px;border:1px solid #253842;border-radius:7px;padding:6px;background:#0b1418;";
	columns.append(variableColumn, matchColumn);

	const columnHeader = (text) => {
		const header = document.createElement("div");
		header.textContent = text;
		header.style.cssText = "position:sticky;top:0;z-index:1;background:#0b1418;color:#a9c7d0;font-weight:800;border-bottom:1px solid #253842;padding:4px 2px 6px;";
		return header;
	};

	const render = () => {
		const query = search.value.trim().toLowerCase();
		variableColumn.replaceChildren(columnHeader("模板参数"));
		matchColumn.replaceChildren(columnHeader("匹配到的参数"));
		const visibleOptions = allOptions.filter((option) => {
			if (!query) return true;
			return [option?.value, option?.label, option?.source].join(" ").toLowerCase().includes(query);
		});
		if (activeVariable && !visibleOptions.some((option) => option.value === activeVariable)) {
			activeVariable = visibleOptions[0]?.value || "";
		}
		for (const option of visibleOptions) {
			const parts = optionDisplay(option);
			const row = document.createElement("button");
			row.type = "button";
			const selected = option.value === activeVariable;
			const boundCount = fields.filter((item) => draftSources[item.name] === option.value).length;
			row.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:7px",
				"width:100%",
				"border:1px solid " + (selected ? "#2f9a75" : "transparent"),
				"border-radius:7px",
				"background:" + (selected ? "rgba(16,122,92,.32)" : "transparent"),
				"color:#dce7e2",
				"text-align:left",
				"padding:6px",
				"cursor:pointer",
			].join(";");
			const mark = document.createElement("span");
			mark.textContent = boundCount ? "✓" : "";
			mark.style.cssText = "width:16px;color:#7de39b;font-weight:900;";
			const text = document.createElement("span");
			text.style.cssText = "min-width:0;display:flex;flex-direction:column;gap:1px;";
			const main = document.createElement("span");
			main.textContent = parts.title || option.value;
			main.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:750;color:#f1fff5;";
			const sub = document.createElement("span");
			sub.textContent = [option.value, parts.source, boundCount ? `已绑定 ${boundCount} 项` : ""].filter(Boolean).join(" · ");
			sub.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#9fc7d0;";
			text.append(main, sub);
			row.append(mark, text);
			const choose = (event) => {
				event?.preventDefault?.();
				event?.stopPropagation?.();
				activeVariable = option.value;
				render();
			};
			row.addEventListener("pointerup", choose, true);
			row.addEventListener("click", choose, true);
			variableColumn.appendChild(row);
		}
		if (!visibleOptions.length) {
			const empty = document.createElement("div");
			empty.textContent = allOptions.length ? "没有匹配的变量" : "当前工作流没有可选变量。请先添加 GJJ_SETNODE 或 GJJ_TemplateParams。";
			empty.style.cssText = "color:#8da2ad;padding:8px;";
			variableColumn.appendChild(empty);
		}
		const activeOption = allOptions.find((option) => option.value === activeVariable);
		let matchedFields = activeOption ? fields.filter((item) => optionMatchesField(activeOption, item)) : [];
		if (activeOption && !matchedFields.length) {
			matchedFields = fields.filter((item) => item.showWhenUnmatched === true);
		}
		for (const sectionField of matchedFields) {
			const current = String(draftSources[sectionField.name] || "");
			const selected = current === activeVariable;
			const row = document.createElement("button");
			row.type = "button";
			row.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:7px",
				"width:100%",
				"border:1px solid " + (selected ? "#2f9a75" : "transparent"),
				"border-radius:7px",
				"background:" + (selected ? "rgba(16,122,92,.32)" : "transparent"),
				"color:#dce7e2",
				"text-align:left",
				"padding:7px",
				"cursor:pointer",
			].join(";");
			const mark = document.createElement("span");
			mark.textContent = selected ? "✓" : "";
			mark.style.cssText = "width:16px;color:#7de39b;font-weight:900;";
			const text = document.createElement("span");
			text.style.cssText = "min-width:0;display:flex;flex-direction:column;gap:2px;";
			const main = document.createElement("span");
			main.textContent = sectionField.label;
			main.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800;color:#f1fff5;";
			const sub = document.createElement("span");
			sub.textContent = selected ? `使用 ${activeVariable}` : (current ? `当前：${current}` : "点击绑定左侧模板参数");
			sub.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#9fc7d0;";
			text.append(main, sub);
			row.append(mark, text);
			const choose = (event) => {
				event?.preventDefault?.();
				event?.stopPropagation?.();
				if (!activeVariable) return;
				if (draftSources[sectionField.name] === activeVariable) delete draftSources[sectionField.name];
				else draftSources[sectionField.name] = activeVariable;
				render();
			};
			row.addEventListener("pointerup", choose, true);
			row.addEventListener("click", choose, true);
			matchColumn.appendChild(row);
		}
		if (activeOption && !matchedFields.length) {
			const empty = document.createElement("div");
			empty.textContent = "这个模板参数没有匹配到当前节点参数";
			empty.style.cssText = "color:#8da2ad;padding:8px;";
			matchColumn.appendChild(empty);
		}
	};
	search.addEventListener("input", render);
	popup.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
	popup.addEventListener("mousedown", (event) => event.stopPropagation(), true);
	popup.addEventListener("click", (event) => event.stopPropagation());
	const footer = document.createElement("div");
	footer.style.cssText = "display:flex;justify-content:flex-end;gap:7px;border-top:1px solid #263842;padding-top:7px;";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "关闭";
	cancel.style.cssText = "height:28px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 12px;font-weight:700;";
	cancel.onclick = () => closePopup(popup);
	const confirm = document.createElement("button");
	confirm.type = "button";
	confirm.textContent = "确定";
	confirm.style.cssText = "height:28px;border:1px solid #10b981;border-radius:6px;background:linear-gradient(135deg,#064e3b,#059669);color:#d1fae5;cursor:pointer;padding:0 14px;font-weight:800;";
	confirm.onclick = () => {
		setSelectedSources(node, draftSources);
		closePopup(popup);
	};
	footer.append(cancel, confirm);
	popup.append(head, search, columns, footer);
	document.body.appendChild(popup);
	ACTIVE_TEMPLATE_SOURCE_POPUP = popup;
	render();
	search.focus();
}

export function openTemplateSourcePicker(node, fields = null, button = null) {
	installTemplateSourceListeners();
	if (Array.isArray(fields) && fields.length) node.__gjjTemplateSourceFields = fields;
	if (button) {
		node.__gjjTemplateSourceButton = button;
		node.__gjjTemplateSourcePanel = button;
	}
	updateTemplateSourcePanel(node, node.__gjjTemplateSourceFields || fields || []);
	openVariablePicker(node);
}

function buttonStyle(active) {
	return [
		"height:28px",
		"min-width:0",
		"flex:1 1 0",
		"border-radius:6px",
		"font-size:12px",
		"font-weight:700",
		"cursor:pointer",
		"padding:0 7px",
		"overflow:hidden",
		"text-overflow:ellipsis",
		"white-space:nowrap",
		"border:1px solid " + (active ? "#2f9a75" : "#44565f"),
		"background:" + (active ? "linear-gradient(135deg,#064e3b,#047857)" : "#202b31"),
		"color:" + (active ? "#d1fae5" : "#dce7e2"),
	].join(";");
}

function refreshAllTemplateSourcePanels() {
	for (const node of app.graph?._nodes || []) {
		if (node?.__gjjTemplateSourceFields?.length) {
			updateTemplateSourcePanel(node, node.__gjjTemplateSourceFields);
		}
	}
}

function installTemplateSourceListeners() {
	if (window.__gjjGenerationTemplateSourceListeners) return;
	window.__gjjGenerationTemplateSourceListeners = true;
	window.addEventListener("gjj-template-params-updated", () => setTimeout(refreshAllTemplateSourcePanels, 40));
	window.addEventListener("gjj-variable-broadcast-updated", () => setTimeout(refreshAllTemplateSourcePanels, 40));
	window.addEventListener("gjj-close-template-source-picker", () => closeTemplateSourcePicker());
}

export function installTemplateSourcePanel(node, fields, options = {}) {
	if (!node || !Array.isArray(fields) || !fields.length || node.__gjjTemplateSourceWidget || typeof node.addDOMWidget !== "function") {
		return;
	}
	installTemplateSourceListeners();
	const container = document.createElement("div");
	container.style.cssText = "display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;min-width:0;overflow:hidden;";
	node.__gjjTemplateSourcePanel = container;
	node.__gjjTemplateSourceButtons = {};
	for (const field of fields) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = `⚡ ${field.label}`;
		button.title = `从 GJJ_TemplateParams 或 GJJ_SETNODE 选择${field.label}变量`;
		button.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			openVariablePicker(node, field);
		};
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			button.addEventListener(eventName, (event) => event.stopPropagation(), true);
		}
		container.appendChild(button);
		node.__gjjTemplateSourceButtons[field.name] = button;
	}
	const widget = node.addDOMWidget(options.name || "⚡ 参数来源", "HTML", container, { serialize: false });
	widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 260)), 32];
	widget.getHeight = () => 32;
	node.__gjjTemplateSourceWidget = widget;
	updateTemplateSourcePanel(node, fields);
}

export function createTemplateSourceButton(node, fields, buttonStyle = []) {
	installTemplateSourceListeners();
	node.__gjjTemplateSourceFields = fields || [];
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "⚡";
	button.title = "选择 GJJ_TemplateParams / GJJ_SETNODE 的参数变量";
	button.style.cssText = [
		...buttonStyle,
		"width:34px",
		"flex:0 0 34px",
		"padding:0",
		"border:1px solid #d6a642",
		"background:linear-gradient(135deg,#3b2a10,#7c4d12)",
		"color:#ffe8a3",
	].join(";");
	button.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (typeof node.__gjjTemplateSourceFieldsProvider === "function") {
			node.__gjjTemplateSourceFields = node.__gjjTemplateSourceFieldsProvider(node) || node.__gjjTemplateSourceFields;
		}
		openVariablePicker(node);
	};
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		button.addEventListener(eventName, (event) => event.stopPropagation(), true);
	}
	node.__gjjTemplateSourceButton = button;
	node.__gjjTemplateSourcePanel = button;
	updateTemplateSourcePanel(node, fields);
	return button;
}

export function updateTemplateSourcePanel(node, fields = null) {
	if (!node) return;
	const activeFields = fields || node.__gjjTemplateSourceFields || [];
	node.__gjjTemplateSourceFields = activeFields;
	const sources = selectedSources(node);
	for (const field of activeFields) {
		const variableName = String(sources[field.name] || "").trim();
		const widget = getWidget(node, field.widget || field.name);
		if (variableName) {
			const value = resolveVariableValue(node, variableName);
			if (typeof field.applyValue === "function") {
				field.applyValue(node, value, field);
			} else if (!inputHasLink(getInput(node, field.widget || field.name))) {
				setWidgetValue(widget, value, field);
			}
			if (widget) setWidgetEnabled(widget, false);
		} else {
			if (widget) setWidgetEnabled(widget, true);
		}
		const button = node.__gjjTemplateSourceButtons?.[field.name];
		if (button) {
			button.textContent = variableName ? `⚡ ${field.label}*` : `⚡ ${field.label}`;
			button.title = variableName
				? `${field.label}变量：${variableName}\n面板控件已灰显；手动外接小圆点时外部连线优先。`
				: `从 GJJ_TemplateParams 或 GJJ_SETNODE 选择${field.label}变量`;
			button.style.cssText = buttonStyle(Boolean(variableName));
		}
	}
	const iconButton = node.__gjjTemplateSourceButton;
	if (iconButton) {
		const active = activeFields.filter((field) => String(sources[field.name] || "").trim());
		iconButton.textContent = "⚡";
		iconButton.title = active.length
			? `已接管：${active.map((field) => field.label).join("、")}\n点击选择或清空参数变量。`
			: "选择 GJJ_TemplateParams / GJJ_SETNODE 的参数变量";
		iconButton.style.borderColor = active.length ? "#f5c451" : "#d6a642";
		iconButton.style.background = active.length ? "linear-gradient(135deg,#5a3b0f,#b7791f)" : "linear-gradient(135deg,#3b2a10,#7c4d12)";
		iconButton.style.color = active.length ? "#fff6bf" : "#ffe8a3";
	}
	const signature = JSON.stringify(activeFields.map((field) => [field.name, String(sources[field.name] || "")]));
	if (node.__gjjTemplateSourceSignature !== signature) {
		node.__gjjTemplateSourceSignature = signature;
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}
}

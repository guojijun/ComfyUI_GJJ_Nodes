import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "GJJ_CsvTsvRowIterator";
const UI_KEY = "gjj_csv_tsv_row_iterator";
const MAX_COLUMNS = 64;
const MIN_VISIBLE_COLUMNS = 1;
const FIXED_OUTPUT_COUNT = 2;
const MIN_NODE_WIDTH = 320;
const MIN_PANEL_HEIGHT = 108;
const COLUMN_PREFIX = "列";
const BROWSER_MARKER_PREFIX = "浏览器选择：";
const QUEUE_DELAY_MS = 300;

const CURRENT_ROW_WIDGET = "current_row";
const SOURCE_PATH_WIDGET = "source_path";
const TIMEOUT_WIDGET = "timeout_seconds";
const STATE_WIDGET = "csv_state";
const PICK_BUTTON = "📁 浏览器选择 TSV/CSV";
const STATUS_WIDGET = "gjj_csv_tsv_status_panel";
const CONTROL_WIDGET = "gjj_csv_tsv_control_panel";

const DEFAULT_STATE = {
	auto_execute: true,
	skip_header: true,
	skip_empty_rows: true,
	refresh_file: false,
	browser_file_name: "",
	browser_file_text: "",
	column_count: 1,
	column_names: [],
	status: "未载入数据",
};

let lastPromptId = null;
let activeRun = null;
let autoQueueTimer = null;
let queuePatched = false;
let patchRetryCount = 0;

function dirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function widgetValue(node, name, fallback = "") {
	const widget = GJJ_Utils.getWidget(node, name);
	return widget ? widget.value : fallback;
}

function setWidgetValue(node, name, value) {
	const widget = GJJ_Utils.getWidget(node, name);
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.callback?.call(widget, value);
}

function boolValue(value, fallback = false) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	if (typeof value === "string") {
		return !["false", "0", "off", "no", "关", "关闭", "否"].includes(value.trim().toLowerCase());
	}
	return Boolean(value);
}

function state(node) {
	node.properties = node.properties || {};
	const props = node.properties;
	const stateWidget = GJJ_Utils.getWidget(node, STATE_WIDGET);
	if (stateWidget?.value && !props.__gjj_csv_tsv_state_loaded) {
		try {
			const parsed = JSON.parse(String(stateWidget.value || "{}"));
			if (parsed && typeof parsed === "object") {
				for (const [key, value] of Object.entries(parsed)) {
					props[`gjj_csv_tsv_${key}`] = value;
				}
			}
		} catch (error) {
			// Keep property defaults when old state JSON is invalid.
		}
		props.__gjj_csv_tsv_state_loaded = true;
	}
	const next = {
		auto_execute: boolValue(props.gjj_csv_tsv_auto_execute, DEFAULT_STATE.auto_execute),
		skip_header: boolValue(props.gjj_csv_tsv_skip_header, DEFAULT_STATE.skip_header),
		skip_empty_rows: boolValue(props.gjj_csv_tsv_skip_empty_rows, DEFAULT_STATE.skip_empty_rows),
		refresh_file: boolValue(props.gjj_csv_tsv_refresh_file, DEFAULT_STATE.refresh_file),
		browser_file_name: String(props.gjj_csv_tsv_browser_file_name || ""),
		browser_file_text: String(props.gjj_csv_tsv_browser_file_text || ""),
		column_count: Math.min(MAX_COLUMNS, Math.max(1, Number(props.gjj_csv_tsv_column_count || 1) || 1)),
		column_names: Array.isArray(props.gjj_csv_tsv_column_names) ? props.gjj_csv_tsv_column_names : [],
		status: String(props.gjj_csv_tsv_status || DEFAULT_STATE.status),
	};
	props.gjj_csv_tsv_auto_execute = next.auto_execute;
	props.gjj_csv_tsv_skip_header = next.skip_header;
	props.gjj_csv_tsv_skip_empty_rows = next.skip_empty_rows;
	props.gjj_csv_tsv_refresh_file = next.refresh_file;
	props.gjj_csv_tsv_browser_file_name = next.browser_file_name;
	props.gjj_csv_tsv_browser_file_text = next.browser_file_text;
	props.gjj_csv_tsv_column_count = next.column_count;
	props.gjj_csv_tsv_column_names = next.column_names;
	props.gjj_csv_tsv_status = next.status;
	if (stateWidget) {
		stateWidget.serialize = true;
		stateWidget.serializeValue = () => JSON.stringify({
			auto_execute: next.auto_execute,
			skip_header: next.skip_header,
			skip_empty_rows: next.skip_empty_rows,
			refresh_file: next.refresh_file,
			browser_file_name: next.browser_file_name,
			browser_file_text: next.browser_file_text,
		});
		stateWidget.value = stateWidget.serializeValue();
	}
	return next;
}

function statePayload(node) {
	const data = state(node);
	return JSON.stringify({
		auto_execute: data.auto_execute,
		skip_header: data.skip_header,
		skip_empty_rows: data.skip_empty_rows,
		refresh_file: data.refresh_file,
		browser_file_name: data.browser_file_name,
		browser_file_text: data.browser_file_text,
	});
}

function updateState(node, patch = {}) {
	const current = state(node);
	const next = { ...current, ...patch };
	node.properties.gjj_csv_tsv_auto_execute = Boolean(next.auto_execute);
	node.properties.gjj_csv_tsv_skip_header = Boolean(next.skip_header);
	node.properties.gjj_csv_tsv_skip_empty_rows = Boolean(next.skip_empty_rows);
	node.properties.gjj_csv_tsv_refresh_file = Boolean(next.refresh_file);
	node.properties.gjj_csv_tsv_browser_file_name = String(next.browser_file_name || "");
	node.properties.gjj_csv_tsv_browser_file_text = String(next.browser_file_text || "");
	node.properties.gjj_csv_tsv_column_count = Math.min(MAX_COLUMNS, Math.max(1, Number(next.column_count || 1) || 1));
	node.properties.gjj_csv_tsv_column_names = Array.isArray(next.column_names) ? next.column_names.slice(0, MAX_COLUMNS) : [];
	node.properties.gjj_csv_tsv_status = String(next.status || DEFAULT_STATE.status);
	syncStateWidget(node);
	return state(node);
}

function migrateOldWidgetValues(node, serialized) {
	const values = Array.isArray(serialized?.widgets_values) ? serialized.widgets_values : [];
	if (values.length < 7) {
		return;
	}
	const timeout = GJJ_Utils.getWidget(node, TIMEOUT_WIDGET);
	if (timeout && (typeof timeout.value === "boolean" || Number(timeout.value) < 1)) {
		const oldTimeout = Number(values[6]);
		if (Number.isFinite(oldTimeout) && oldTimeout >= 1) {
			timeout.value = oldTimeout;
		}
	}
	updateState(node, {
		auto_execute: boolValue(values[2], DEFAULT_STATE.auto_execute),
		skip_header: boolValue(values[3], DEFAULT_STATE.skip_header),
		skip_empty_rows: boolValue(values[4], DEFAULT_STATE.skip_empty_rows),
		refresh_file: boolValue(values[5], DEFAULT_STATE.refresh_file),
		browser_file_name: String(values[7] || state(node).browser_file_name || ""),
		browser_file_text: String(values[8] || state(node).browser_file_text || ""),
	});
}

function detectDelimiter(text) {
	const lines = String(text || "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.filter((line) => line.trim())
		.slice(0, 20);
	const tabs = lines.reduce((sum, line) => sum + (line.match(/\t/g)?.length || 0), 0);
	const commas = lines.reduce((sum, line) => sum + (line.match(/,/g)?.length || 0), 0);
	return tabs >= commas ? "\t" : ",";
}

function parseDelimitedText(text, skipEmptyRows) {
	const delimiter = detectDelimiter(text);
	const source = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const rows = [];
	let row = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (quoted) {
			if (char === '"') {
				if (source[index + 1] === '"') {
					cell += '"';
					index += 1;
				} else {
					quoted = false;
				}
			} else {
				cell += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === delimiter) {
			row.push(cell.trim());
			cell = "";
		} else if (char === "\n") {
			row.push(cell.trim());
			if (!skipEmptyRows || row.some((value) => value)) {
				rows.push(row);
			}
			row = [];
			cell = "";
		} else {
			cell += char;
		}
	}
	if (cell || row.length || source.endsWith(delimiter)) {
		row.push(cell.trim());
		if (!skipEmptyRows || row.some((value) => value)) {
			rows.push(row);
		}
	}
	return rows;
}

function browserAllRows(node) {
	const data = state(node);
	if (!data.browser_file_text.trim()) {
		return [];
	}
	return parseDelimitedText(data.browser_file_text, data.skip_empty_rows);
}

function browserRows(node) {
	const data = state(node);
	const rows = browserAllRows(node);
	return data.skip_header && rows.length ? rows.slice(1) : rows;
}

function browserHeaders(node) {
	const data = state(node);
	if (!data.skip_header) {
		return [];
	}
	const rows = browserAllRows(node);
	return Array.isArray(rows[0]) ? rows[0].map((item) => String(item || "").trim()) : [];
}

function browserStats(node) {
	const rows = browserRows(node);
	const headers = browserHeaders(node);
	const columnCount = Math.min(MAX_COLUMNS, Math.max(1, headers.length, ...rows.map((row) => row.length), 1));
	return {
		totalRows: rows.length,
		columnCount,
		columnNames: headers.slice(0, MAX_COLUMNS),
	};
}

function currentRow(node) {
	const value = Number(widgetValue(node, CURRENT_ROW_WIDGET, 1));
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function updateCurrentRowBounds(node, totalRows) {
	const widget = GJJ_Utils.getWidget(node, CURRENT_ROW_WIDGET);
	if (!widget) {
		return;
	}
	const max = Math.max(1, Number(totalRows || 0) || 1);
	widget.options = widget.options || {};
	widget.options.max = max;
	if (widget.value > max) {
		widget.value = max;
	}
	if (widget.value < 1) {
		widget.value = 1;
	}
}

function sourceLooksLikeBrowserMarker(node) {
	const source = String(widgetValue(node, SOURCE_PATH_WIDGET, "") || "");
	return source.startsWith(BROWSER_MARKER_PREFIX);
}

function statusText(node, stats) {
	const data = state(node);
	if (!stats.totalRows) {
		return sourceLooksLikeBrowserMarker(node)
			? "浏览器选择文件内容未保存，请重新点击按钮选择 TSV/CSV 文件"
			: data.status || "未载入数据";
	}
	const row = Math.min(currentRow(node), Math.max(1, stats.totalRows));
	const file = data.browser_file_name ? `文件：${data.browser_file_name}\n` : "";
	const header = data.columnNames?.length ? "\n标题：已使用首行标注输出口" : "";
	return `${file}数据：${stats.totalRows} 行 / ${stats.columnCount} 列\n当前：第 ${row} 行${header}`;
}

function cleanHeaderName(text, index) {
	const value = String(text || "").replace(/\s+/g, " ").trim();
	if (!value) {
		return `${COLUMN_PREFIX}${index}`;
	}
	return value.length > 18 ? `${value.slice(0, 17)}...` : value;
}

function parseOutputIndex(output, fallback) {
	if (Number.isFinite(output?.__gjjCsvTsvIndex)) {
		return output.__gjjCsvTsvIndex;
	}
	const match = String(output?.name || output?.label || "").match(/^列(\d+)|^(\d+)[.、]/);
	return match ? Number.parseInt(match[1] || match[2], 10) : fallback;
}

function setFixedOutput(output, name, tooltip) {
	if (!output) {
		return;
	}
	output.name = name;
	output.label = name;
	output.localized_name = name;
	output.type = "INT";
	output.tooltip = tooltip;
	output.__gjjCsvTsvFixed = true;
	delete output.__gjjCsvTsvIndex;
}

function updateLinkOriginSlots(node) {
	if (!Array.isArray(node?.outputs) || !app.graph?.links) {
		return;
	}
	node.outputs.forEach((output, slot) => {
		for (const linkId of output.links || []) {
			const link = app.graph.links[linkId];
			if (link) {
				link.origin_slot = slot;
			}
		}
	});
}

function insertFixedOutput(node, name, tooltip, index) {
	node.addOutput?.(name, "INT");
	const output = node.outputs?.pop();
	if (!output) {
		return;
	}
	setFixedOutput(output, name, tooltip);
	node.outputs.splice(index, 0, output);
}

function ensureFixedOutputs(node) {
	if (!Array.isArray(node?.outputs)) {
		return;
	}
	const first = node.outputs[0];
	const second = node.outputs[1];
	const needsInsert = first?.name !== "当前行数" || first?.type !== "INT" || second?.name !== "总行数" || second?.type !== "INT";
	if (needsInsert) {
		insertFixedOutput(node, "总行数", "当前 CSV/TSV 可输出的数据总行数；开启首行标题时不包含标题行。", 0);
		insertFixedOutput(node, "当前行数", "当前实际输出的数据行号；开启首行标题时不包含标题行。", 0);
	} else {
		setFixedOutput(node.outputs[0], "当前行数", "当前实际输出的数据行号；开启首行标题时不包含标题行。");
		setFixedOutput(node.outputs[1], "总行数", "当前 CSV/TSV 可输出的数据总行数；开启首行标题时不包含标题行。");
	}
	updateLinkOriginSlots(node);
}

function columnOutputs(node) {
	if (!Array.isArray(node?.outputs)) {
		return [];
	}
	ensureFixedOutputs(node);
	const columns = node.outputs.slice(FIXED_OUTPUT_COUNT);
	columns.forEach((output, index) => {
		output.__gjjCsvTsvIndex = parseOutputIndex(output, index + 1);
	});
	return [...columns].sort((a, b) => parseOutputIndex(a, 0) - parseOutputIndex(b, 0));
}

function outputHasLinks(output) {
	return Array.isArray(output?.links) && output.links.length > 0;
}

function addColumnOutput(node) {
	const outputs = columnOutputs(node);
	if (outputs.length >= MAX_COLUMNS) {
		return;
	}
	const index = outputs.length + 1;
	node.addOutput?.(`${COLUMN_PREFIX}${index}`, "STRING");
	const output = node.outputs?.[node.outputs.length - 1];
	if (output) {
		output.__gjjCsvTsvIndex = index;
	}
}

function removeOutputObject(node, output) {
	const slot = node.outputs?.indexOf(output) ?? -1;
	if (slot >= 0) {
		node.removeOutput(slot);
	}
}

function maxColumns(node) {
	const data = state(node);
	const stats = browserStats(node);
	return Math.min(MAX_COLUMNS, Math.max(MIN_VISIBLE_COLUMNS, data.column_count || 0, stats.columnCount || 0));
}

function stabilizeOutputs(node) {
	ensureFixedOutputs(node);
	let outputs = columnOutputs(node);
	if (!outputs.length) {
		addColumnOutput(node);
		outputs = columnOutputs(node);
	}
	const visibleColumns = maxColumns(node);
	while (outputs.length < visibleColumns) {
		addColumnOutput(node);
		outputs = columnOutputs(node);
	}
	for (let index = outputs.length - 1; index >= Math.max(MIN_VISIBLE_COLUMNS, visibleColumns); index -= 1) {
		if (outputHasLinks(outputs[index])) {
			break;
		}
		removeOutputObject(node, outputs[index]);
		outputs = columnOutputs(node);
	}
	const names = state(node).column_names || [];
	columnOutputs(node).forEach((output, index) => {
		const label = cleanHeaderName(names[index], index + 1);
		output.__gjjCsvTsvIndex = index + 1;
		output.name = label;
		output.label = label;
		output.localized_name = label;
		output.type = "STRING";
		output.tooltip = names[index] ? `第 ${index + 1} 列：${names[index]}` : "当前行对应列的文本。导入 CSV/TSV 后会按解析到的列数一次性展开。";
	});
}

function removeInputAt(node, index) {
	try {
		node.disconnectInput?.(index);
	} catch (error) {
		// Best effort cleanup for legacy converted widget inputs.
	}
	if (typeof node.removeInput === "function") {
		node.removeInput(index);
	} else {
		node.inputs.splice(index, 1);
	}
}

function cleanupLegacyInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	const hiddenNames = new Set([
		STATE_WIDGET,
		"auto_execute",
		"skip_header",
		"skip_empty_rows",
		"refresh_file",
		"browser_file_name",
		"browser_file_text",
	]);
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const type = String(input?.type || "");
		const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
		if (hiddenNames.has(name) || hiddenNames.has(converted)) {
			removeInputAt(node, index);
		}
	}
}

function hideStateWidget(node) {
	const widget = GJJ_Utils.getWidget(node, STATE_WIDGET);
	if (!widget) {
		return;
	}
	widget.__gjjCsvTsvHidden = true;
	widget.hidden = true;
	widget.serialize = true;
	widget.type = `converted-widget:${STATE_WIDGET}`;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
	widget.label = "CSV状态";
	widget.localized_name = "CSV状态";
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
	state(node);
}

function panelHeight(node) {
	const panel = node.__gjjCsvTsvPanel;
	if (!panel) {
		return MIN_PANEL_HEIGHT;
	}
	const height = Math.ceil(panel.scrollHeight || panel.offsetHeight || MIN_PANEL_HEIGHT);
	return Math.max(MIN_PANEL_HEIGHT, height + 4);
}

function refreshNodeSize(node) {
	if (!node) {
		return;
	}
	const width = Math.max(MIN_NODE_WIDTH, Number(node.size?.[0] || MIN_NODE_WIDTH));
	const computed = node.computeSize?.() || node.size || [width, 360];
	const height = Math.max(360, Number(computed?.[1] || 360));
	node.setSize?.([width, height]);
	dirty(node);
}

function scheduleNodeSize(node) {
	if (!node || node.__gjjCsvTsvSizeQueued) {
		return;
	}
	node.__gjjCsvTsvSizeQueued = true;
	requestAnimationFrame(() => {
		node.__gjjCsvTsvSizeQueued = false;
		refreshNodeSize(node);
	});
}

function ensureStyles(root) {
	if (!root || root.__gjjCsvTsvStyleReady) {
		return;
	}
	root.__gjjCsvTsvStyleReady = true;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-csv-tsv-panel{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:7px;padding:0 2px;color:#d7e2ea;font:12px/1.35 sans-serif}
		.gjj-csv-tsv-panel .row{display:flex;gap:6px;width:100%}
		.gjj-csv-tsv-panel button{flex:1;background:#20323a;border:1px solid #3b5560;border-radius:5px;color:#edf6fa;padding:5px 8px;font:700 12px sans-serif;cursor:pointer;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-csv-tsv-panel button.on{background:#1f6b43;border-color:#48ad73;color:#fff}
		.gjj-csv-tsv-status{box-sizing:border-box;min-height:36px;border:1px solid #3f535d;border-radius:7px;background:#10191f;color:#dce7e2;padding:7px 9px;white-space:pre-wrap;word-break:break-word}
	`;
	root.appendChild(style);
}

function setupPanel(node) {
	if (node.__gjjCsvTsvPanel) {
		return;
	}
	const wrap = document.createElement("div");
	wrap.className = "gjj-csv-tsv-panel";
	wrap.innerHTML = `
		<div class="gjj-csv-tsv-status">未载入数据</div>
		<div class="row"><button data-key="auto_execute" type="button"></button><button data-key="skip_header" type="button"></button></div>
		<div class="row"><button data-key="skip_empty_rows" type="button"></button><button data-key="refresh_file" type="button"></button></div>
	`;
	ensureStyles(wrap);
	for (const eventName of ["mousedown", "pointerdown", "click"]) {
		wrap.addEventListener(eventName, (event) => event.stopPropagation());
	}
	for (const button of wrap.querySelectorAll("button[data-key]")) {
		button.addEventListener("click", (event) => {
			event.preventDefault();
			const key = button.dataset.key;
			const data = state(node);
			updateState(node, { [key]: !data[key] });
			if (key === "skip_header" || key === "skip_empty_rows") {
				refreshFromBrowser(node, false);
			}
			renderPanel(node);
			dirty(node);
		});
	}
	node.__gjjCsvTsvPanel = wrap;
	node.__gjjCsvTsvPanelWidget = node.addDOMWidget(CONTROL_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
	});
	node.__gjjCsvTsvPanelWidget.computeSize = (width) => [
		Math.max(MIN_NODE_WIDTH, Number(width || node.size?.[0] || MIN_NODE_WIDTH)),
		panelHeight(node),
	];
	node.__gjjCsvTsvPanelWidget.getHeight = () => panelHeight(node);
	renderPanel(node);
	scheduleNodeSize(node);
}

function renderPanel(node) {
	const wrap = node.__gjjCsvTsvPanel;
	if (!wrap) {
		return;
	}
	const data = state(node);
	const labels = {
		auto_execute: "自动执行",
		skip_header: "首行标题",
		skip_empty_rows: "跳过空行",
		refresh_file: "重新读取",
	};
	for (const button of wrap.querySelectorAll("button[data-key]")) {
		const key = button.dataset.key;
		const active = Boolean(data[key]);
		button.textContent = `${labels[key] || key} ${active ? "开" : "关"}`;
		button.classList.toggle("on", active);
		button.setAttribute("aria-pressed", active ? "true" : "false");
	}
	const status = wrap.querySelector(".gjj-csv-tsv-status");
	if (status) {
		status.textContent = data.status || DEFAULT_STATE.status;
	}
}

function createFilePicker(node) {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".tsv,.csv,text/tab-separated-values,text/plain";
	input.style.display = "none";
	input.addEventListener("click", (event) => event.stopPropagation());
	input.addEventListener("change", async () => {
		const file = input.files?.[0];
		input.value = "";
		if (!file) {
			return;
		}
		const lower = String(file.name || "").toLowerCase();
		if (!lower.endsWith(".tsv") && !lower.endsWith(".csv")) {
			alert("请选择 .tsv 或 .csv 文件。");
			return;
		}
		let text = "";
		try {
			text = await file.text();
		} catch (error) {
			alert(`读取文件失败：${error?.message || error}`);
			return;
		}
		updateState(node, {
			browser_file_name: file.name,
			browser_file_text: text,
			refresh_file: true,
		});
		setWidgetValue(node, CURRENT_ROW_WIDGET, 1);
		const sourceWidget = GJJ_Utils.getWidget(node, SOURCE_PATH_WIDGET);
		if (sourceWidget) {
			sourceWidget.value = `${BROWSER_MARKER_PREFIX}${file.name}`;
		}
		refreshFromBrowser(node, true);
	});
	return input;
}

function setupPickButton(node) {
	if (node.__gjjCsvTsvPickButton) {
		return;
	}
	const input = createFilePicker(node);
	node.__gjjCsvTsvFileInput = input;
	const widget = node.addWidget?.("button", PICK_BUTTON, "", () => input.click(), { serialize: false });
	if (widget) {
		widget.tooltip = "从浏览器文件选择框读取本机 .tsv 或 .csv 内容，并保存到当前节点。";
		node.__gjjCsvTsvPickButton = widget;
	}
}

function moveWidgetAfter(node, widget, afterName) {
	if (!node || !widget || !Array.isArray(node.widgets)) {
		return;
	}
	const from = node.widgets.indexOf(widget);
	const after = node.widgets.findIndex((item) => item?.name === afterName);
	if (from < 0 || after < 0 || from === after || from === after + 1) {
		return;
	}
	node.widgets.splice(from, 1);
	const adjustedAfter = from < after ? after - 1 : after;
	node.widgets.splice(adjustedAfter + 1, 0, widget);
}

function ensureStateWidget(node) {
	let widget = GJJ_Utils.getWidget(node, STATE_WIDGET);
	if (!widget) {
		widget = node.addWidget?.("text", STATE_WIDGET, statePayload(node), () => {}, {
			serialize: true,
		});
		if (widget) {
			widget.name = STATE_WIDGET;
		}
	}
	if (widget) {
		widget.serialize = true;
		widget.serializeValue = () => statePayload(node);
		widget.value = statePayload(node);
		moveWidgetAfter(node, widget, TIMEOUT_WIDGET);
	}
	return widget;
}

function syncStateWidget(node) {
	const widget = GJJ_Utils.getWidget(node, STATE_WIDGET);
	if (!widget) {
		return;
	}
	widget.serialize = true;
	widget.serializeValue = () => statePayload(node);
	widget.value = statePayload(node);
}

function orderWidgets(node) {
	moveWidgetAfter(node, GJJ_Utils.getWidget(node, STATE_WIDGET), TIMEOUT_WIDGET);
	moveWidgetAfter(node, node.__gjjCsvTsvPickButton, CURRENT_ROW_WIDGET);
	moveWidgetAfter(node, node.__gjjCsvTsvPanelWidget, SOURCE_PATH_WIDGET);
}

function refreshFromBrowser(node, resetRow) {
	const stats = browserStats(node);
	if (resetRow) {
		setWidgetValue(node, CURRENT_ROW_WIDGET, 1);
	}
	updateCurrentRowBounds(node, stats.totalRows);
	updateState(node, {
		column_count: stats.columnCount,
		column_names: stats.columnNames,
		status: statusText(node, stats),
	});
	stabilizeOutputs(node);
	renderPanel(node);
	scheduleNodeSize(node);
	dirty(node);
}

function compactNode(node) {
	cleanupLegacyInputs(node);
	ensureStateWidget(node);
	hideStateWidget(node);
	cleanupLegacyInputs(node);
	setupPickButton(node);
	setupPanel(node);
	refreshFromBrowser(node, false);
	orderWidgets(node);
	scheduleNodeSize(node);
	dirty(node);
}

function scheduleCompact(node, ms = 32) {
	clearTimeout(node.__gjjCsvTsvCompactTimer);
	node.__gjjCsvTsvCompactTimer = setTimeout(() => compactNode(node), ms);
}

function compactSoonAndLater(node) {
	setTimeout(() => compactNode(node), 0);
	setTimeout(() => compactNode(node), 120);
	setTimeout(() => compactNode(node), 450);
}

function csvNodes() {
	return (app.graph?._nodes || []).filter((node) => node?.comfyClass === NODE_NAME);
}

function patchPromptQueue() {
	if (!queuePatched && typeof app.queuePrompt === "function") {
		const original = app.queuePrompt;
		app.queuePrompt = async function (...args) {
			for (const node of csvNodes()) {
				compactNode(node);
			}
			return original.apply(this, args);
		};
		queuePatched = true;
	}
	if (!queuePatched && patchRetryCount < 30) {
		patchRetryCount += 1;
		setTimeout(patchPromptQueue, 500);
	}
}

function eventPromptId(event) {
	return event?.detail?.prompt_id || null;
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !(promptId && lastPromptId && promptId !== lastPromptId);
}

function autoExecute(node) {
	return Boolean(state(node).auto_execute);
}

function queueNextIfNeeded(run, reason) {
	const node = run?.node;
	if (!node || run.finished) {
		return;
	}
	run.finished = true;
	const total = Math.max(0, Number(run.totalRows || 0) || 0);
	const effective = Math.max(1, Number(run.effectiveRow || currentRow(node)) || 1);
	if (total <= 0) {
		updateState(node, { status: `${reason}，没有可用数据行` });
		renderPanel(node);
		return;
	}
	if (effective >= total) {
		setWidgetValue(node, CURRENT_ROW_WIDGET, total);
		updateState(node, { status: `${reason}，已到末尾：${total} / ${total}` });
		renderPanel(node);
		dirty(node);
		return;
	}
	const next = effective + 1;
	setWidgetValue(node, CURRENT_ROW_WIDGET, next);
	updateCurrentRowBounds(node, total);
	if (!autoExecute(node)) {
		updateState(node, { status: `${reason}，下一行 ${next} / ${total}` });
		renderPanel(node);
		dirty(node);
		return;
	}
	updateState(node, { status: `${reason}，下一行 ${next} / ${total}，${QUEUE_DELAY_MS}ms 后继续` });
	renderPanel(node);
	dirty(node);
	clearTimeout(autoQueueTimer);
	autoQueueTimer = setTimeout(async () => {
		autoQueueTimer = null;
		try {
			await app.queuePrompt(0);
		} catch (error) {
			updateState(node, { status: `自动排队失败：${error?.message || error}` });
			renderPanel(node);
			dirty(node);
		}
	}, QUEUE_DELAY_MS);
}

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
	activeRun = null;
	clearTimeout(autoQueueTimer);
	autoQueueTimer = null;
});

api.addEventListener("execution_success", (event) => {
	if (!samePrompt(event) || !activeRun) {
		activeRun = null;
		return;
	}
	queueNextIfNeeded(activeRun, "执行完成");
	activeRun = null;
});

api.addEventListener("execution_error", () => {
	clearTimeout(autoQueueTimer);
	autoQueueTimer = null;
	if (activeRun?.node) {
		updateState(activeRun.node, { status: "执行出错，自动执行已停止" });
		renderPanel(activeRun.node);
		dirty(activeRun.node);
	}
	activeRun = null;
});

api.addEventListener("execution_interrupted", () => {
	clearTimeout(autoQueueTimer);
	autoQueueTimer = null;
	if (activeRun?.node) {
		updateState(activeRun.node, { status: "执行被中断，自动执行已停止" });
		renderPanel(activeRun.node);
		dirty(activeRun.node);
	}
	activeRun = null;
});

patchPromptQueue();

app.registerExtension({
	name: "Comfy.GJJ.CsvTsvRowIterator",

	beforeQueuePrompt() {
		for (const node of csvNodes()) {
			compactNode(node);
		}
	},

	beforeQueued() {
		for (const node of csvNodes()) {
			compactNode(node);
		}
	},

	nodeCreated(node) {
		if (node.comfyClass !== NODE_NAME) {
			return;
		}
		updateState(node, {
			auto_execute: true,
			skip_header: true,
			skip_empty_rows: true,
		});
		compactNode(node);
		setTimeout(() => compactNode(node), 0);
		setTimeout(() => compactNode(node), 120);
	},

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) {
			return;
		}
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			migrateOldWidgetValues(this, args?.[0]);
			compactSoonAndLater(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleCompact(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			if (data) {
				const columnNames = Array.isArray(data.column_names) ? data.column_names : [];
				updateCurrentRowBounds(this, data.total_rows || 0);
				updateState(this, {
					column_count: Number(data.column_count || 1) || 1,
					column_names: columnNames,
					status: data.status || `当前第 ${data.effective_row || currentRow(this)} 行`,
				});
				stabilizeOutputs(this);

				GJJ_Utils.refreshNode(this);				renderPanel(this);
				activeRun = {
					node: this,
					effectiveRow: Number(data.effective_row || currentRow(this)) || 1,
					totalRows: Number(data.total_rows || 0) || 0,
					finished: false,
				};
				dirty(this);
			}
			return result;
		};
	},

	setup() {
		for (const node of csvNodes()) {
			compactNode(node);
		}
	},
});

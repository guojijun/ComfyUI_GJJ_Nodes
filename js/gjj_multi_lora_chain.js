import { app } from "/scripts/app.js";

const TARGET_NODES = new Set([
	"GJJ_MultiLoraChainLoader",
	"GJJ_LoraChainConfig",
]);
const DATA_WIDGET_NAME = "lora_data";
const SEARCH_BY_ROW_PROPERTY = "gjj_lora_search_by_row";
const GLOBAL_SEARCH_PROPERTY = "gjj_lora_global_search";
const GROUP_RULES_PROPERTY = "gjj_lora_group_rules";
const ADVANCED_OPEN_PROPERTY = "gjj_lora_advanced_open";
const DEFAULT_EMPTY_OPTION = { value: "", label: "未选择" };
const DEFAULT_ROW = { enabled: true, name: "", strength: 1.0 };
const DEFAULT_FIRST_SEARCH_TERMS = "";

function normalizeStrength(value, fallback = 1.0) {
	const parsed = Number.parseFloat(value);
	if (Number.isNaN(parsed)) {
		return fallback;
	}
	return parsed;
}

function isPartialNumericInput(value) {
	const text = String(value ?? "").trim();
	return text === "" || text === "-" || text === "+" || text === "." || text === "-." || text === "+.";
}

function formatStrength(value, fallback = 1.0) {
	return normalizeStrength(value, fallback).toFixed(2);
}

function normalizeRows(value) {
	let parsed = [];
	try {
		const raw = JSON.parse(String(value || "[]"));
		if (Array.isArray(raw)) {
			parsed = raw;
		}
	} catch (error) {
		parsed = [];
	}

	const rows = parsed
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			enabled: item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
		}));

	const nonEmptyRows = rows.filter((item) => item.name);
	nonEmptyRows.push({ ...DEFAULT_ROW });
	return nonEmptyRows.length > 0 ? nonEmptyRows : [{ ...DEFAULT_ROW }];
}

function serializeRows(rows) {
	const cleaned = rows
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			enabled: item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
		}));
	return JSON.stringify(cleaned);
}

async function fetchLoraOptions() {
	try {
		const response = await fetch("/gjj/loras");
		if (!response.ok) {
			return [DEFAULT_EMPTY_OPTION];
		}

		const data = await response.json();
		const values = Array.isArray(data?.loras) ? data.loras : [];
		const options = [];
		for (const item of values) {
			const value = String(item || "");
			if (!options.some((option) => option.value === value)) {
				options.push({
					value,
					label: value || DEFAULT_EMPTY_OPTION.label,
				});
			}
		}
		if (!options.some((option) => option.value === "")) {
			options.unshift({ ...DEFAULT_EMPTY_OPTION });
		}
		return options;
	} catch (error) {
		return [DEFAULT_EMPTY_OPTION];
	}
}

function hideDataWidget(node, widget) {
	if (!widget) {
		return;
	}
	widget.__gjjNode = node;
	widget.type = "hidden";
	widget.hidden = true;
	widget.serialize = true;
	widget.serializeValue = () => {
		const targetNode = widget.__gjjNode || node;
		const state = ensureNodeState(targetNode);
		const serialized = serializeRows(state.rows);
		const widgetIndex = Array.isArray(targetNode?.widgets)
			? targetNode.widgets.indexOf(widget)
			: -1;
		if (Array.isArray(targetNode?.widgets_values) && widgetIndex >= 0) {
			targetNode.widgets_values[widgetIndex] = serialized;
		}
		return serialized;
	};
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	widget.label = "";
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.widget) {
		widget.widget.style.display = "none";
	}
}

function normalizeSearchByRow(value) {
	if (!value) {
		return {};
	}

	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [String(key), String(item || "")]),
		);
	}

	try {
		const parsed = JSON.parse(String(value));
		if (parsed && typeof parsed === "object") {
			return Object.fromEntries(
				Object.entries(parsed).map(([key, item]) => [String(key), String(item || "")]),
			);
		}
	} catch (error) {
		return {};
	}

	return {};
}

function ensureNodeState(node) {
	node.properties = node.properties || {};
	node.__gjjLoraState = node.__gjjLoraState || {
		rows: normalizeRows(node.properties[DATA_WIDGET_NAME] || "[]"),
		options: [{ ...DEFAULT_EMPTY_OPTION }],
		searchByRow: normalizeSearchByRow(node.properties[SEARCH_BY_ROW_PROPERTY]),
		globalSearch: String(node.properties[GLOBAL_SEARCH_PROPERTY] || ""),
		groupRulesText: String(node.properties[GROUP_RULES_PROPERTY] || ""),
		advancedOpen: Boolean(node.properties[ADVANCED_OPEN_PROPERTY]),
	};
	return node.__gjjLoraState;
}

function updateSearchByRow(node, value) {
	const state = ensureNodeState(node);
	state.searchByRow = normalizeSearchByRow(value);
	node.properties[SEARCH_BY_ROW_PROPERTY] = { ...state.searchByRow };
}

function updateNodeHeight(node, rowCount) {
	const state = ensureNodeState(node);
	const baseHeight = state.advancedOpen ? 126 : 78;
	const rowHeight = 50;
	const targetHeight = baseHeight + rowCount * rowHeight;
	node.size = [Math.max(node.size?.[0] || 420, 420), targetHeight];
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function updateDataWidget(node) {
	const dataWidget = node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
	if (!dataWidget) {
		return;
	}

	const state = ensureNodeState(node);
	const serialized = serializeRows(state.rows);
	dataWidget.value = serialized;
	dataWidget.callback?.(serialized);
	node.properties[DATA_WIDGET_NAME] = serialized;
	const widgetIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(dataWidget) : -1;
	if (widgetIndex >= 0) {
		node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
		node.widgets_values[widgetIndex] = serialized;
	}
}

function ensureTrailingEmptyRow(node) {
	const state = ensureNodeState(node);
	const rows = state.rows.filter((item) => item && typeof item === "object");
	const normalized = rows.filter((item, index) => item.name || index < rows.length - 1);
	if (normalized.length === 0 || normalized[normalized.length - 1].name) {
		normalized.push({ ...DEFAULT_ROW });
	}
	state.rows = normalized.map((item) => ({
		enabled: item.enabled !== false,
		name: String(item.name || ""),
		strength: normalizeStrength(item.strength, 1.0),
	}));
}

function normalizeKeyword(value) {
	return String(value || "").trim().toLowerCase();
}

function getDefaultSearchValue(index) {
	return index === 0 ? DEFAULT_FIRST_SEARCH_TERMS : "";
}

function getRowSearchValue(state, index) {
	if (!Object.prototype.hasOwnProperty.call(state.searchByRow, index)) {
		state.searchByRow[index] = getDefaultSearchValue(index);
	}
	return String(state.searchByRow[index] || "");
}

function parseSearchKeywords(value) {
	return String(value || "")
		.split(/[,\uFF0C\u3001;\uFF1B|]+/)
		.map((item) => normalizeKeyword(item))
		.filter(Boolean);
}

function parseSearchExpression(value) {
	return String(value || "")
		.split(/[&+＋]/)
		.map((item) => parseSearchKeywords(item))
		.filter((group) => group.length > 0);
}

function matchesSearchExpression(text, expressionGroups) {
	if (expressionGroups.length === 0) {
		return true;
	}

	return expressionGroups.every((group) => group.some((keyword) => text.includes(keyword)));
}

function parseGroupRules(text) {
	return String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [rawGroupName, ...rawKeywords] = line.split("=");
			if (!rawGroupName || rawKeywords.length === 0) {
				return null;
			}

			const groupName = String(rawGroupName || "").trim();
			const keywords = rawKeywords
				.join("=")
				.split(/[|,，、；;]/)
				.map((item) => normalizeKeyword(item))
				.filter(Boolean);

			if (!groupName || keywords.length === 0) {
				return null;
			}

			return { groupName, keywords };
		})
		.filter(Boolean);
}

function getGroupNameForLora(loraName, rules) {
	const text = normalizeKeyword(loraName);
	if (!text) {
		return "";
	}

	for (const rule of rules) {
		if (rule.keywords.some((keyword) => text.includes(keyword))) {
			return rule.groupName;
		}
	}

	return "";
}

function updateGroupRules(node, value) {
	const state = ensureNodeState(node);
	state.groupRulesText = String(value || "");
	node.properties[GROUP_RULES_PROPERTY] = state.groupRulesText;
}

function enforceRowUniqueness(node) {
	const state = ensureNodeState(node);
	const rules = parseGroupRules(state.groupRulesText);
	const usedNames = new Set();
	const usedGroups = new Set();

	state.rows = state.rows.map((row) => ({ ...row }));
	state.rows.forEach((row) => {
		const name = String(row?.name || "").trim();
		if (!name) {
			return;
		}

		const loweredName = normalizeKeyword(name);
		const groupName = getGroupNameForLora(name, rules);
		if (usedNames.has(loweredName) || (groupName && usedGroups.has(groupName))) {
			row.name = "";
			return;
		}

		usedNames.add(loweredName);
		if (groupName) {
			usedGroups.add(groupName);
		}
	});
}

function getBlockedNames(node, rowIndex) {
	const state = ensureNodeState(node);
	const blocked = new Set();
	state.rows.forEach((row, index) => {
		if (index === rowIndex) {
			return;
		}
		const name = normalizeKeyword(row?.name);
		if (name) {
			blocked.add(name);
		}
	});
	return blocked;
}

function getBlockedGroups(node, rowIndex) {
	const state = ensureNodeState(node);
	const rules = parseGroupRules(state.groupRulesText);
	const blocked = new Set();
	state.rows.forEach((row, index) => {
		if (index === rowIndex) {
			return;
		}
		const groupName = getGroupNameForLora(row?.name, rules);
		if (groupName) {
			blocked.add(groupName);
		}
	});
	return blocked;
}

function getRowOptions(node, rowIndex, searchText = "") {
	const state = ensureNodeState(node);
	const row = state.rows[rowIndex] || DEFAULT_ROW;
	const blockedNames = getBlockedNames(node, rowIndex);
	const blockedGroups = getBlockedGroups(node, rowIndex);
	const rules = parseGroupRules(state.groupRulesText);
	const mergedSearch = [String(state.globalSearch || ""), String(searchText || "")]
		.filter(Boolean)
		.join("&");
	const expressionGroups = parseSearchExpression(mergedSearch);

	return state.options.filter((option) => {
		const value = String(option?.value || "");
		if (!value) {
			return true;
		}

		const loweredValue = normalizeKeyword(value);
		const groupName = getGroupNameForLora(value, rules);
		const isCurrent = loweredValue === normalizeKeyword(row.name);
		if (!isCurrent && blockedNames.has(loweredValue)) {
			return false;
		}
		if (!isCurrent && groupName && blockedGroups.has(groupName)) {
			return false;
		}
		if (!matchesSearchExpression(loweredValue, expressionGroups)) {
			return false;
		}
		return true;
	});
}

function createStyleTag(container) {
	const style = document.createElement("style");
	style.textContent = `
		.gjj-lora-wrap { display:flex; flex-direction:column; gap:6px; width:100%; box-sizing:border-box; margin-top:4px; }
		.gjj-lora-toolbar { display:flex; flex-direction:column; gap:6px; }
		.gjj-lora-toolbar-main { display:flex; align-items:center; gap:6px; }
		.gjj-lora-global-search { flex:1; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 8px; font-size:11px; }
		.gjj-lora-refresh { padding:2px 8px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; }
		.gjj-lora-advanced-btn { padding:2px 8px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; }
		.gjj-lora-advanced-panel { display:none; }
		.gjj-lora-advanced-panel.open { display:block; width:100%; }
		.gjj-lora-rules-input { display:block; width:100%; min-height:38px; resize:vertical; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:6px 8px; font-size:11px; box-sizing:border-box; }
		.gjj-lora-rows { display:flex; flex-direction:column; gap:6px; }
		.gjj-lora-row { display:flex; align-items:flex-start; gap:6px; padding:6px; border:1px solid #3c4c54; border-radius:8px; background:#172026; }
		.gjj-lora-row.off { opacity:0.65; }
		.gjj-lora-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; position:relative; }
		.gjj-lora-search { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; box-sizing:border-box; }
		.gjj-lora-picker { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 8px; box-sizing:border-box; text-align:left; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
		.gjj-lora-popup { display:none; flex-direction:column; gap:6px; position:absolute; top:calc(100% + 6px); left:0; min-width:max(100%, 420px); max-width:680px; width:max-content; padding:6px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-sizing:border-box; z-index:9999; box-shadow:0 8px 24px rgba(0,0,0,0.35); }
		.gjj-lora-popup.open { display:flex; }
		.gjj-lora-popup-search { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; box-sizing:border-box; }
		.gjj-lora-popup-list { display:flex; flex-direction:column; gap:4px; max-height:180px; overflow:auto; }
		.gjj-lora-popup-item { width:100%; background:#182127; color:#dce7e2; border:1px solid #33454c; border-radius:6px; padding:5px 8px; text-align:left; cursor:pointer; box-sizing:border-box; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:1.3; }
		.gjj-lora-popup-item:hover { background:#223039; }
		.gjj-lora-popup-item.selected { background:#18352f; border-color:#2f7d67; color:#e8fff6; }
		.gjj-lora-popup-item.selected:hover { background:#1d433a; }
		.gjj-lora-popup-empty { color:#8da2ad; font-size:11px; padding:4px 2px; }
		.gjj-lora-side { display:flex; align-items:center; gap:6px; padding-top:2px; flex:0 0 auto; white-space:nowrap; }
		.gjj-lora-group-hint { width:26px; min-width:26px; text-align:center; font-size:14px; line-height:1; cursor:default; user-select:none; }
		.gjj-lora-toggle-wrap { display:flex; align-items:center; gap:4px; color:#dce7e2; font-size:11px; white-space:nowrap; flex:0 0 auto; }
		.gjj-lora-strength { width:68px; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; text-align:center; }
	`;
	container.appendChild(style);
}

function populateSelectOptions(select, options, selectedValue) {
	select.replaceChildren();
	for (const option of options) {
		const element = document.createElement("option");
		element.value = option.value;
		element.textContent = option.label;
		select.appendChild(element);
	}
	select.value = options.some((option) => option.value === selectedValue) ? selectedValue : "";
}

function stopCanvasPointerCapture(event) {
	event.stopPropagation();
}

function stopCanvasWheelCapture(event) {
	event.stopPropagation();
}

function positionGlobalLoraPopup(panel, list, anchorEl) {
	const rect = anchorEl?.getBoundingClientRect?.();
	const viewportWidth = Math.max(320, window.innerWidth || 320);
	const viewportHeight = Math.max(240, window.innerHeight || 240);
	const horizontalPadding = 12;
	const verticalPadding = 12;
	const targetWidth = Math.min(
		Math.max(Math.ceil(rect?.width || 420), 420),
		Math.max(320, viewportWidth - horizontalPadding * 2),
		680,
	);
	const spaceBelow = Math.max(120, viewportHeight - Math.ceil(rect?.bottom || 0) - verticalPadding - 6);
	const spaceAbove = Math.max(120, Math.floor(rect?.top || 0) - verticalPadding - 6);
	const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
	const panelMaxHeight = Math.max(180, Math.min(420, openAbove ? spaceAbove : spaceBelow));
	const listMaxHeight = Math.max(96, panelMaxHeight - 52);
	const rawLeft = Math.floor(rect?.left || horizontalPadding);
	const left = Math.max(horizontalPadding, Math.min(rawLeft, viewportWidth - targetWidth - horizontalPadding));

	panel.style.width = `${targetWidth}px`;
	panel.style.maxWidth = `${Math.max(320, viewportWidth - horizontalPadding * 2)}px`;
	panel.style.maxHeight = `${panelMaxHeight}px`;
	list.style.maxHeight = `${listMaxHeight}px`;
	panel.style.left = `${left}px`;

	if (openAbove) {
		panel.style.top = "auto";
		panel.style.bottom = `${Math.max(verticalPadding, viewportHeight - Math.floor(rect?.top || 0) + 6)}px`;
	} else {
		panel.style.bottom = "auto";
		panel.style.top = `${Math.max(verticalPadding, Math.ceil(rect?.bottom || verticalPadding) + 6)}px`;
	}

	const panelRect = panel.getBoundingClientRect();
	if (panelRect.bottom > viewportHeight - verticalPadding) {
		panel.style.bottom = "auto";
		panel.style.top = `${Math.max(verticalPadding, viewportHeight - verticalPadding - panelRect.height)}px`;
	}
	if (panelRect.top < verticalPadding) {
		panel.style.top = `${verticalPadding}px`;
		panel.style.bottom = "auto";
	}
}

function ensureGlobalLoraPopup() {
	if (globalThis.__gjjLoraPopup) {
		return globalThis.__gjjLoraPopup;
	}

	const panel = document.createElement("div");
	panel.className = "gjj-lora-popup";
	panel.style.position = "fixed";
	panel.style.left = "12px";
	panel.style.top = "12px";
	panel.style.zIndex = "99999";
	panel.style.margin = "0";

	const search = document.createElement("input");
	search.type = "text";
	search.className = "gjj-lora-popup-search";

	const list = document.createElement("div");
	list.className = "gjj-lora-popup-list";

	panel.appendChild(search);
	panel.appendChild(list);
	document.body.appendChild(panel);

	panel.addEventListener("mousedown", stopCanvasPointerCapture);
	panel.addEventListener("pointerdown", stopCanvasPointerCapture);
	panel.addEventListener("click", stopCanvasPointerCapture);
	panel.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	panel.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });
	list.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	list.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });

	const popup = {
		panel,
		search,
		list,
		state: null,
		close() {
			panel.classList.remove("open");
			search.value = "";
			search.placeholder = "搜索";
			search.title = "";
			list.replaceChildren();
			this.state = null;
			document.removeEventListener("pointerdown", outsideHandler, true);
		},
		reposition() {
			if (!this.state?.anchorEl) {
				return;
			}
			positionGlobalLoraPopup(panel, list, this.state.anchorEl);
		},
		render() {
			if (!this.state) {
				return;
			}

			const selectedValue = String(this.state.getSelectedValue?.() || "");
			const options = this.state.getOptions(search.value);
			list.replaceChildren();

			if (!options.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-lora-popup-empty";
				empty.textContent = "没有匹配的 LoRA";
				list.appendChild(empty);
				this.reposition();
				return;
			}

			for (const option of options) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-lora-popup-item";
				const isSelected = String(option.value || "") === selectedValue;
				if (isSelected) {
					item.classList.add("selected");
					item.textContent = `✔ ${option.label}`;
				} else {
					item.textContent = option.label;
				}
				item.addEventListener("click", () => {
					this.state?.onSelect?.(String(option.value || ""));
				});
				list.appendChild(item);
			}

			this.reposition();
		},
		isOpenFor(anchorEl) {
			return panel.classList.contains("open") && this.state?.anchorEl === anchorEl;
		},
		open(state) {
			this.state = state;
			search.value = String(state.searchValue || "");
			search.placeholder = String(state.placeholder || "搜索");
			search.title = String(state.searchTitle || "");
			panel.classList.add("open");
			this.render();
			document.addEventListener("pointerdown", outsideHandler, true);
			setTimeout(() => search.focus(), 0);
		},
	};

	function outsideHandler(event) {
		if (!popup.state) {
			return;
		}
		if (panel.contains(event.target) || popup.state.anchorEl?.contains?.(event.target)) {
			return;
		}
		popup.close();
	}

	search.addEventListener("input", () => {
		if (!popup.state) {
			return;
		}
		popup.state.onSearchChange?.(search.value);
		popup.render();
	});
	search.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Escape") {
			event.preventDefault();
			popup.close();
		}
	});
	window.addEventListener("resize", () => popup.reposition());

	globalThis.__gjjLoraPopup = popup;
	return popup;
}

function buildRow(node, row, index, rowsContainer) {
	const state = ensureNodeState(node);
	const rowElement = document.createElement("div");
	rowElement.className = `gjj-lora-row${row.enabled ? "" : " off"}`;

	const mainColumn = document.createElement("div");
	mainColumn.className = "gjj-lora-main";

	const picker = document.createElement("button");
	picker.type = "button";
	picker.className = "gjj-lora-picker";
	picker.title = "点击展开当前这一行 LoRA 的可搜索下拉列表。";

	const groupHint = document.createElement("div");
	groupHint.className = "gjj-lora-group-hint";
	const currentGroup = getGroupNameForLora(row.name, parseGroupRules(state.groupRulesText));
	groupHint.textContent = currentGroup ? "🧩" : "🙂";
	groupHint.title = currentGroup
		? `已命中互斥分组：${currentGroup}`
		: "当前 LoRA 未命中任何互斥分组规则。";

	const toggleWrap = document.createElement("label");
	toggleWrap.className = "gjj-lora-toggle-wrap";
	toggleWrap.title = "控制当前这一行 LoRA 是否参与串联加载。";

	const toggle = document.createElement("input");
	toggle.type = "checkbox";
	toggle.checked = row.enabled !== false;
	toggleWrap.appendChild(toggle);
	toggleWrap.appendChild(document.createTextNode("启用"));

	const strength = document.createElement("input");
	strength.type = "number";
	strength.className = "gjj-lora-strength";
	strength.step = "0.05";
	strength.value = formatStrength(row.strength, 1.0);
	strength.title = "设置当前 LoRA 的模型与 CLIP 共用强度值。";

	function updatePickerLabel() {
		picker.textContent = row.name || DEFAULT_EMPTY_OPTION.label;
	}

	picker.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const popup = ensureGlobalLoraPopup();
		if (popup.isOpenFor(picker)) {
			popup.close();
			return;
		}
		popup.open({
			node,
			anchorEl: picker,
			searchValue: getRowSearchValue(state, index),
			placeholder: index === 0 ? "首槽默认加速关键词" : "搜索",
			searchTitle: "输入关键词筛选当前这一行可选的 LoRA 文件名；不区分大小写。语法：& 表示与，, 或 | 表示或。示例：flux & turbo,lightning,hyper",
			onSearchChange(value) {
				state.searchByRow[index] = value;
				node.properties[SEARCH_BY_ROW_PROPERTY] = { ...state.searchByRow };
			},
			getSelectedValue() {
				return String(state.rows[index]?.name || "");
			},
			getOptions(searchText) {
				let options = getRowOptions(node, index, searchText);
				if (state.rows[index]?.name && !options.some((option) => option.value === state.rows[index].name)) {
					options = [...options, { value: state.rows[index].name, label: state.rows[index].name }];
				}
				return options;
			},
			onSelect(value) {
				state.rows[index].name = value;
				enforceRowUniqueness(node);
				ensureTrailingEmptyRow(node);
				updateDataWidget(node);
				popup.close();
				renderUi(node);
			},
		});
	});

	toggle.addEventListener("change", () => {
		state.rows[index].enabled = toggle.checked;
		updateDataWidget(node);
		rowElement.classList.toggle("off", !toggle.checked);
	});

	const syncStrengthInput = () => {
		if (isPartialNumericInput(strength.value)) {
			return;
		}
		state.rows[index].strength = normalizeStrength(strength.value, state.rows[index].strength ?? 1.0);
		updateDataWidget(node);
	};

	const commitStrength = () => {
		state.rows[index].strength = normalizeStrength(strength.value, state.rows[index].strength ?? 1.0);
		strength.value = formatStrength(state.rows[index].strength, 1.0);
		updateDataWidget(node);
	};

	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		strength.addEventListener(eventName, (event) => event.stopPropagation());
	}
	strength.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Enter") {
			commitStrength();
			strength.blur();
		}
	});
	strength.addEventListener("input", syncStrengthInput);
	strength.addEventListener("change", commitStrength);
	strength.addEventListener("blur", commitStrength);

	updatePickerLabel();
	mainColumn.appendChild(picker);

	const sideColumn = document.createElement("div");
	sideColumn.className = "gjj-lora-side";
	sideColumn.appendChild(groupHint);
	sideColumn.appendChild(toggleWrap);
	sideColumn.appendChild(strength);

	rowElement.appendChild(mainColumn);
	rowElement.appendChild(sideColumn);
	rowsContainer.appendChild(rowElement);
}

function renderUi(node) {
	const state = ensureNodeState(node);
	const container = node.__gjjLoraContainer;
	const rowsContainer = node.__gjjLoraRows;
	if (!container || !rowsContainer) {
		return;
	}
	hideDataWidget(node, node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME));
	if (node.__gjjLoraRulesInput && node.__gjjLoraRulesInput.value !== state.groupRulesText) {
		node.__gjjLoraRulesInput.value = state.groupRulesText;
	}
	if (node.__gjjLoraGlobalSearch && node.__gjjLoraGlobalSearch.value !== String(state.globalSearch || "")) {
		node.__gjjLoraGlobalSearch.value = String(state.globalSearch || "");
	}
	if (node.__gjjLoraAdvancedPanel) {
		node.__gjjLoraAdvancedPanel.classList.toggle("open", state.advancedOpen);
	}
	if (node.__gjjLoraAdvancedButton) {
		node.__gjjLoraAdvancedButton.textContent = state.advancedOpen ? "收起" : "高级";
	}
	if (globalThis.__gjjLoraPopup?.state?.node === node) {
		globalThis.__gjjLoraPopup.close();
	}

	enforceRowUniqueness(node);
	ensureTrailingEmptyRow(node);
	rowsContainer.replaceChildren();
	state.rows.forEach((row, index) => buildRow(node, row, index, rowsContainer));
	updateNodeHeight(node, state.rows.length);
	updateDataWidget(node);
}

async function refreshOptions(node, rerender = true) {
	const state = ensureNodeState(node);
	state.options = await fetchLoraOptions();
	if (rerender) {
		renderUi(node);
	}
}

function updateAdvancedOpen(node, value) {
	const state = ensureNodeState(node);
	state.advancedOpen = Boolean(value);
	node.properties[ADVANCED_OPEN_PROPERTY] = state.advancedOpen;
}

function setupUi(node) {
	if (node.__gjjLoraContainer) {
		return;
	}

	const dataWidget = node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
	hideDataWidget(node, dataWidget);
	ensureNodeState(node).rows = normalizeRows(dataWidget?.value || node.properties?.[DATA_WIDGET_NAME] || "[]");

	const container = document.createElement("div");
	container.className = "gjj-lora-wrap";
	createStyleTag(container);

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-lora-toolbar";

	const toolbarMain = document.createElement("div");
	toolbarMain.className = "gjj-lora-toolbar-main";

	const globalSearch = document.createElement("input");
	globalSearch.type = "text";
	globalSearch.className = "gjj-lora-global-search";
	globalSearch.placeholder = "全局过滤 LoRA";
	globalSearch.title = "按关键词过滤当前节点所有 LoRA 下拉选项；支持 & 与，, 或 | 表示或。";
	globalSearch.value = ensureNodeState(node).globalSearch;
	globalSearch.addEventListener("input", () => {
		const state = ensureNodeState(node);
		state.globalSearch = globalSearch.value;
		node.properties[GLOBAL_SEARCH_PROPERTY] = state.globalSearch;
		renderUi(node);
	});

	const refreshButton = document.createElement("button");
	refreshButton.className = "gjj-lora-refresh";
	refreshButton.type = "button";
	refreshButton.textContent = "刷新列表";
	refreshButton.title = "重新读取 ComfyUI 当前的 LoRA 文件列表。";
	refreshButton.addEventListener("click", () => {
		refreshOptions(node, true);
	});

	const advancedButton = document.createElement("button");
	advancedButton.className = "gjj-lora-advanced-btn";
	advancedButton.type = "button";
	advancedButton.textContent = "高级";
	advancedButton.title = "展开或收起互斥分组规则。前端自动维护的 JSON 仍保持隐藏。";
	advancedButton.addEventListener("click", () => {
		updateAdvancedOpen(node, !ensureNodeState(node).advancedOpen);
		renderUi(node);
	});

	toolbarMain.appendChild(globalSearch);
	toolbarMain.appendChild(refreshButton);
	toolbarMain.appendChild(advancedButton);
	toolbar.appendChild(toolbarMain);

	const advancedPanel = document.createElement("div");
	advancedPanel.className = "gjj-lora-advanced-panel";

	const rulesInput = document.createElement("textarea");
	rulesInput.className = "gjj-lora-rules-input";
	rulesInput.placeholder = "互斥分组规则\n人物 = girl, boy\n细节 = detail, face, eye\n加速 = lcm, lightning";
	rulesInput.value = ensureNodeState(node).groupRulesText;
	rulesInput.title = "每行格式为“分组名 = 关键词1,关键词2”；文件名命中同一分组的 LoRA 在当前节点中互斥。";
	rulesInput.addEventListener("input", () => {
		updateGroupRules(node, rulesInput.value);
		renderUi(node);
	});

	advancedPanel.appendChild(rulesInput);
	toolbar.appendChild(advancedPanel);
	container.appendChild(toolbar);

	const rowsContainer = document.createElement("div");
	rowsContainer.className = "gjj-lora-rows";
	container.appendChild(rowsContainer);

	container.addEventListener("mousedown", (event) => event.stopPropagation());
	container.addEventListener("pointerdown", stopCanvasPointerCapture);
	container.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	container.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });

	node.__gjjLoraContainer = container;
	node.__gjjLoraRows = rowsContainer;
	node.__gjjLoraGlobalSearch = globalSearch;
	node.__gjjLoraRulesInput = rulesInput;
	node.__gjjLoraAdvancedPanel = advancedPanel;
	node.__gjjLoraAdvancedButton = advancedButton;
	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		updateDataWidget(this);
		const result = typeof originalOnSerialize === "function"
			? originalOnSerialize.apply(this, arguments)
			: serializedNode;
		serializedNode.properties = serializedNode.properties || {};
		const widgetIndex = Array.isArray(this.widgets)
			? this.widgets.findIndex((widget) => widget?.name === DATA_WIDGET_NAME)
			: -1;
		if (widgetIndex >= 0) {
			serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values)
				? serializedNode.widgets_values
				: [];
			serializedNode.widgets_values[widgetIndex] = serializeRows(ensureNodeState(this).rows);
		}
		serializedNode.properties[SEARCH_BY_ROW_PROPERTY] = {
			...ensureNodeState(this).searchByRow,
		};
		serializedNode.properties[GLOBAL_SEARCH_PROPERTY] = String(ensureNodeState(this).globalSearch || "");
		serializedNode.properties[GROUP_RULES_PROPERTY] = ensureNodeState(this).groupRulesText;
		serializedNode.properties[ADVANCED_OPEN_PROPERTY] = ensureNodeState(this).advancedOpen;
		return result ?? serializedNode;
	};
	node.addDOMWidget("LoRA 串联", "HTML", container, { serialize: false });

	refreshOptions(node, false).then(() => {
		renderUi(node);
	});
}

app.registerExtension({
	name: "Comfy.GJJ.MultiLoraChain",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => setupUi(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => {
				const state = ensureNodeState(this);
				const dataWidget = this.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
				state.rows = normalizeRows(dataWidget?.value || this.properties?.[DATA_WIDGET_NAME] || "[]");
				updateSearchByRow(this, this.properties?.[SEARCH_BY_ROW_PROPERTY]);
				state.globalSearch = String(this.properties?.[GLOBAL_SEARCH_PROPERTY] || "");
				state.groupRulesText = String(this.properties?.[GROUP_RULES_PROPERTY] || "");
				state.advancedOpen = Boolean(this.properties?.[ADVANCED_OPEN_PROPERTY]);
				setupUi(this);
				renderUi(this);
			}, 0);
			return result;
		};
	},
});

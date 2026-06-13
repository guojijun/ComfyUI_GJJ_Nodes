import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_WanVideoHighLowLora";
const DATA_WIDGET_NAME = "wan_lora_data";
const LOW_MEM_WIDGET_NAME = "low_mem_load";
const MERGE_WIDGET_NAME = "merge_loras";
const API_PATH = "/gjj/wanvideo_loras";
const SEARCH_BY_ROW_PROPERTY = "gjj_wan_lora_search_by_row";
const GLOBAL_SEARCH_PROPERTY = "gjj_wan_lora_global_search";
const LOW_MEM_PROPERTY = "gjj_wan_lora_low_mem_load";
const MERGE_PROPERTY = "gjj_wan_lora_merge_loras";
const DEFAULT_EMPTY_OPTION = { value: "", label: "未选择" };
const DEFAULT_HIGH_ROW = { branch: "high", enabled: false, name: "", strength: 1.0, autoPair: false };

function normalizeStrength(value, fallback = 1.0) {
	const parsed = Number.parseFloat(value);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function formatStrength(value, fallback = 1.0) {
	return normalizeStrength(value, fallback).toFixed(2);
}

function isPartialNumericInput(value) {
	const text = String(value ?? "").trim();
	return text === "" || text === "-" || text === "+" || text === "." || text === "-." || text === "+.";
}

function normalizeBoolean(value) {
	return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function normalizeBranch(value) {
	return String(value || "").toLowerCase() === "low" ? "low" : "high";
}

function emptyHighRow() {
	return { ...DEFAULT_HIGH_ROW };
}

function normalizeRows(value) {
	let parsed = [];
	try {
		const raw = JSON.parse(String(value || "[]"));
		if (Array.isArray(raw)) parsed = raw;
	} catch (_) {
		parsed = [];
	}

	const rows = parsed
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			branch: normalizeBranch(item.branch),
			enabled: Boolean(item.name) && item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
			autoPair: item.autoPair === true,
		}))
		.filter((item) => item.name);

	rows.push(emptyHighRow());
	return rows;
}

function serializeRows(rows) {
	const cleaned = (rows || [])
		.filter((item) => item && typeof item === "object" && String(item.name || ""))
		.map((item) => ({
			branch: normalizeBranch(item.branch),
			enabled: Boolean(item.name) && item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
			autoPair: item.autoPair === true,
		}));
	return JSON.stringify(cleaned);
}

function ensureTrailingEmptyHighRow(node) {
	const state = ensureNodeState(node);
	const rows = state.rows
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			branch: normalizeBranch(item.branch),
			enabled: Boolean(item.name) && item.enabled !== false,
			name: String(item.name || ""),
			strength: normalizeStrength(item.strength, 1.0),
			autoPair: item.autoPair === true,
		}))
		.filter((item) => item.name);
	rows.push(emptyHighRow());
	state.rows = rows;
}

function getWidget(node, name) {
	return (node?.widgets || []).find((widget) => widget?.name === name);
}

function hideWidget(node, widget) {
	if (!widget) return;
	widget.__gjjNode = node;
	widget.type = "hidden";
	widget.hidden = true;
	widget.display = "hidden";
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden", forceInput: false };
	widget.forceInput = false;
	widget.serialize = true;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.label = "";
	widget.y = -10000;
	widget.last_y = -10000;
	if (widget.inputEl) widget.inputEl.style.display = "none";
	if (widget.element) widget.element.style.display = "none";
	if (widget.widget) widget.widget.style.display = "none";
}

function removeConvertedWidgetInput(node, widgetName) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (input?.widget?.name !== widgetName && input?.name !== widgetName) continue;
		if (input.link != null) continue;
		if (typeof node.removeInput === "function") node.removeInput(index);
		else node.inputs.splice(index, 1);
	}
}

function markNodeDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function normalizeSearchByRow(value) {
	if (!value) return {};
	if (typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key), String(item || "")]));
	}
	try {
		const parsed = JSON.parse(String(value));
		if (parsed && typeof parsed === "object") {
			return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [String(key), String(item || "")]));
		}
	} catch (_) {}
	return {};
}

function ensureNodeState(node) {
	node.properties = node.properties || {};
	const dataWidget = getWidget(node, DATA_WIDGET_NAME);
	const lowMemWidget = getWidget(node, LOW_MEM_WIDGET_NAME);
	const mergeWidget = getWidget(node, MERGE_WIDGET_NAME);
	node.__gjjWanLoraState = node.__gjjWanLoraState || {
		rows: normalizeRows(dataWidget?.value || node.properties[DATA_WIDGET_NAME] || "[]"),
		options: [{ ...DEFAULT_EMPTY_OPTION }],
		searchByRow: normalizeSearchByRow(node.properties[SEARCH_BY_ROW_PROPERTY]),
		globalSearch: String(node.properties[GLOBAL_SEARCH_PROPERTY] || ""),
		lowMemLoad: normalizeBoolean(lowMemWidget?.value ?? node.properties[LOW_MEM_PROPERTY]),
		mergeLoras: normalizeBoolean(mergeWidget?.value ?? node.properties[MERGE_PROPERTY]),
	};
	return node.__gjjWanLoraState;
}

function writeWidgetValue(node, widget, value) {
	if (!widget) return;
	widget.value = value;
	widget.callback?.(value);
	const index = Array.isArray(node?.widgets) ? node.widgets.indexOf(widget) : -1;
	if (index >= 0) {
		node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
		node.widgets_values[index] = value;
	}
}

function updateHiddenWidgets(node) {
	const state = ensureNodeState(node);
	const serialized = serializeRows(state.rows);
	writeWidgetValue(node, getWidget(node, DATA_WIDGET_NAME), serialized);
	writeWidgetValue(node, getWidget(node, LOW_MEM_WIDGET_NAME), Boolean(state.lowMemLoad));
	writeWidgetValue(node, getWidget(node, MERGE_WIDGET_NAME), Boolean(state.mergeLoras));
	node.properties[DATA_WIDGET_NAME] = serialized;
	node.properties[SEARCH_BY_ROW_PROPERTY] = { ...state.searchByRow };
	node.properties[GLOBAL_SEARCH_PROPERTY] = String(state.globalSearch || "");
	node.properties[LOW_MEM_PROPERTY] = Boolean(state.lowMemLoad);
	node.properties[MERGE_PROPERTY] = Boolean(state.mergeLoras);
}

async function fetchLoraOptions() {
	try {
		const response = await fetch(API_PATH);
		if (!response.ok) return [{ ...DEFAULT_EMPTY_OPTION }];
		const data = await response.json();
		const values = Array.isArray(data?.loras) ? data.loras : [];
		const options = [];
		for (const item of values) {
			const value = String(item || "");
			if (!options.some((option) => option.value === value)) {
				options.push({ value, label: value || DEFAULT_EMPTY_OPTION.label });
			}
		}
		if (!options.some((option) => option.value === "")) options.unshift({ ...DEFAULT_EMPTY_OPTION });
		return options;
	} catch (_) {
		return [{ ...DEFAULT_EMPTY_OPTION }];
	}
}

function normalizeKeyword(value) {
	return String(value || "").trim().toLowerCase();
}

function searchTokens(value) {
	return String(value || "")
		.split(/[\s,，、;；|]+/)
		.map((item) => normalizeKeyword(item))
		.filter(Boolean);
}

function matchesSearch(value, globalSearch, rowSearch) {
	const text = normalizeKeyword(value);
	const tokens = [...searchTokens(globalSearch), ...searchTokens(rowSearch)];
	return tokens.every((token) => text.includes(token));
}

function replaceHighLowToken(value, replacement) {
	const source = String(value || "");
	return source.replace(/(^|[^a-z0-9])(high|low)(?=$|[^a-z0-9])/gi, (match, prefix, token) => {
		const lowerReplacement = String(replacement || "").toLowerCase();
		let nextToken = lowerReplacement;
		if (token === token.toUpperCase()) nextToken = lowerReplacement.toUpperCase();
		else if (token[0] === token[0].toUpperCase()) nextToken = lowerReplacement[0].toUpperCase() + lowerReplacement.slice(1);
		return `${prefix}${nextToken}`;
	});
}

function getHighLowToken(value) {
	const match = String(value || "").match(/(^|[^a-z0-9])(high|low)(?=$|[^a-z0-9])/i);
	return match ? match[2].toLowerCase() : "";
}

function basename(value) {
	return String(value || "").split(/[\\/]/).pop();
}

function findPairName(selectedName, options) {
	const selected = String(selectedName || "");
	if (!selected) return "";
	const token = getHighLowToken(selected);
	if (token) {
		const counterpart = token === "high" ? "low" : "high";
		const candidate = replaceHighLowToken(selected, counterpart);
		const exact = (options || []).find((option) => normalizeKeyword(option?.value) === normalizeKeyword(candidate));
		if (exact?.value) return String(exact.value);
		const candidateBase = normalizeKeyword(basename(candidate));
		const byBase = (options || []).find((option) => normalizeKeyword(basename(option?.value)) === candidateBase);
		if (byBase?.value) return String(byBase.value);
	}
	return selected;
}

function applyLowPairAfterHigh(node, rowIndex, selectedName) {
	const state = ensureNodeState(node);
	const pairName = findPairName(selectedName, state.options);
	if (!pairName) return;

	const pairRow = {
		branch: "low",
		enabled: true,
		name: pairName,
		strength: normalizeStrength(state.rows[rowIndex]?.strength, 1.0),
		autoPair: true,
	};
	const nextRow = state.rows[rowIndex + 1];
	if (!nextRow || nextRow.branch !== "low") {
		state.rows.splice(rowIndex + 1, 0, pairRow);
		return;
	}
	if (!nextRow.name || nextRow.autoPair === true) {
		state.rows[rowIndex + 1] = {
			...pairRow,
			strength: normalizeStrength(nextRow.strength, pairRow.strength),
		};
	}
}

function getRowOptions(node, rowIndex, searchText = "") {
	const state = ensureNodeState(node);
	const row = state.rows[rowIndex] || DEFAULT_HIGH_ROW;
	return state.options.filter((option) => {
		const value = String(option?.value || "");
		if (!value) return true;
		if (value === row.name) return true;
		return matchesSearch(value, state.globalSearch, searchText);
	});
}

function stopCanvasPointerCapture(event) {
	event.stopPropagation();
}

function stopCanvasWheelCapture(event) {
	event.stopPropagation();
}

function positionPopup(panel, list, anchorEl) {
	const rect = anchorEl?.getBoundingClientRect?.();
	const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1200;
	const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
	const padding = 10;
	const width = Math.min(640, Math.max(320, Math.floor(rect?.width || 420)));
	const left = Math.min(Math.max(padding, Math.floor(rect?.left || padding)), viewportWidth - width - padding);
	const maxHeight = Math.max(180, Math.min(420, viewportHeight - padding * 2));
	panel.style.width = `${width}px`;
	panel.style.left = `${left}px`;
	list.style.maxHeight = `${maxHeight - 46}px`;

	const topBelow = Math.ceil(rect?.bottom || padding) + 6;
	if (topBelow + maxHeight > viewportHeight - padding) {
		panel.style.top = "auto";
		panel.style.bottom = `${Math.max(padding, viewportHeight - Math.floor(rect?.top || 0) + 6)}px`;
	} else {
		panel.style.bottom = "auto";
		panel.style.top = `${topBelow}px`;
	}
}

function ensurePopup() {
	if (globalThis.__gjjWanLoraPopup) return globalThis.__gjjWanLoraPopup;

	const panel = document.createElement("div");
	panel.className = "gjj-wan-lora-popup";
	panel.style.position = "fixed";
	panel.style.zIndex = "99999";

	const search = document.createElement("input");
	search.type = "text";
	search.className = "gjj-wan-lora-popup-search";
	search.placeholder = "当前槽过滤词";

	const list = document.createElement("div");
	list.className = "gjj-wan-lora-popup-list";
	panel.append(search, list);
	document.body.appendChild(panel);

	panel.addEventListener("mousedown", stopCanvasPointerCapture);
	panel.addEventListener("pointerdown", stopCanvasPointerCapture);
	panel.addEventListener("click", stopCanvasPointerCapture);
	panel.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	list.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });

	const popup = {
		panel,
		search,
		list,
		state: null,
		close() {
			panel.classList.remove("open");
			search.value = "";
			list.replaceChildren();
			this.state = null;
			document.removeEventListener("pointerdown", outsideHandler, true);
		},
		reposition() {
			if (this.state?.anchorEl) positionPopup(panel, list, this.state.anchorEl);
		},
		render() {
			if (!this.state) return;
			const options = this.state.getOptions(search.value);
			const selectedValue = String(this.state.getSelectedValue() || "");
			list.replaceChildren();
			if (!options.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-wan-lora-popup-empty";
				empty.textContent = "没有匹配的 WanVideo LoRA";
				list.appendChild(empty);
				this.reposition();
				return;
			}
			for (const option of options) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "gjj-wan-lora-popup-item";
				const value = String(option.value || "");
				button.textContent = value === selectedValue ? `✓ ${option.label}` : option.label;
				if (value === selectedValue) button.classList.add("selected");
				button.addEventListener("click", () => this.state?.onSelect(value));
				list.appendChild(button);
			}
			this.reposition();
		},
		isOpenFor(anchorEl) {
			return panel.classList.contains("open") && this.state?.anchorEl === anchorEl;
		},
		open(state) {
			this.state = state;
			search.value = String(state.searchValue || "");
			panel.classList.add("open");
			this.render();
			document.addEventListener("pointerdown", outsideHandler, true);
			setTimeout(() => search.focus(), 0);
		},
	};

	function outsideHandler(event) {
		if (!popup.state) return;
		if (panel.contains(event.target) || popup.state.anchorEl?.contains?.(event.target)) return;
		popup.close();
	}

	search.addEventListener("input", () => {
		if (!popup.state) return;
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
	globalThis.__gjjWanLoraPopup = popup;
	return popup;
}

function createStyleTag(container) {
	if (document.getElementById("gjj-wanvideo-high-low-lora-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-wanvideo-high-low-lora-style";
	style.textContent = `
		.gjj-wan-lora-wrap { display:flex; flex-direction:column; gap:6px; width:100%; box-sizing:border-box; margin-top:4px; color:#dce7e2; font-size:12px; }
		.gjj-wan-lora-toolbar { display:flex; align-items:center; gap:6px; width:100%; }
		.gjj-wan-lora-global-search { flex:1 1 auto; min-width:0; height:24px; box-sizing:border-box; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:3px 8px; font-size:11px; }
		.gjj-wan-lora-button { flex:0 0 auto; height:24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; padding:0 8px; font-size:11px; white-space:nowrap; }
		.gjj-wan-lora-button:hover { border-color:#6aa6b8; background:#26343b; }
		.gjj-wan-lora-button.on { border-color:#69b980; background:#20362f; color:#ecfff1; }
		.gjj-wan-lora-rows { display:flex; flex-direction:column; gap:6px; width:100%; }
		.gjj-wan-lora-row { display:grid; grid-template-columns:24px minmax(0,1fr) auto auto; align-items:center; gap:6px; min-height:34px; padding:5px; box-sizing:border-box; border:1px solid #2d454e; border-radius:7px; background:#101a1f; }
		.gjj-wan-lora-row.off { opacity:.62; }
		.gjj-wan-lora-branch { width:24px; height:24px; display:flex; align-items:center; justify-content:center; border:1px solid #36505a; border-radius:6px; background:#16232a; padding:0; cursor:pointer; font-size:14px; }
		.gjj-wan-lora-branch.high { color:#ffb05f; }
		.gjj-wan-lora-branch.low { color:#7ec8ff; }
		.gjj-wan-lora-picker { min-width:0; width:100%; height:25px; border:1px solid #41535b; border-radius:5px; background:#11181c; color:#dce7e2; cursor:pointer; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 8px; font-size:11px; }
		.gjj-wan-lora-picker:hover { border-color:#6aa6b8; background:#18242a; }
		.gjj-wan-lora-toggle { display:flex; align-items:center; gap:4px; white-space:nowrap; user-select:none; color:#dce7e2; font-size:11px; }
		.gjj-wan-lora-toggle input { width:13px; height:13px; margin:0; accent-color:#6abf8a; }
		.gjj-wan-lora-strength { width:64px; height:25px; box-sizing:border-box; border:1px solid #41535b; border-radius:5px; background:#11181c; color:#dce7e2; text-align:center; font-size:11px; }
		.gjj-wan-lora-popup { display:none; flex-direction:column; gap:6px; padding:7px; box-sizing:border-box; border:1px solid #42606b; border-radius:7px; background:#10191e; box-shadow:0 10px 28px rgba(0,0,0,.42); color:#dce7e2; }
		.gjj-wan-lora-popup.open { display:flex; }
		.gjj-wan-lora-popup-search { height:26px; border:1px solid #41535b; border-radius:5px; background:#11181c; color:#dce7e2; padding:3px 8px; box-sizing:border-box; font-size:12px; }
		.gjj-wan-lora-popup-list { display:flex; flex-direction:column; gap:3px; overflow:auto; }
		.gjj-wan-lora-popup-item { width:100%; min-height:24px; border:0; border-radius:5px; background:transparent; color:#dce7e2; text-align:left; cursor:pointer; padding:4px 7px; font-size:12px; overflow-wrap:anywhere; }
		.gjj-wan-lora-popup-item:hover { background:#1d2d34; }
		.gjj-wan-lora-popup-item.selected { background:#20362f; color:#ecfff1; }
		.gjj-wan-lora-popup-empty { padding:10px; text-align:center; color:#8fa4aa; }
	`;
	container.appendChild(style);
}

function updateNodeHeight(node) {
	const state = ensureNodeState(node);
	const currentWidth = Math.round(node.size?.[0] || 520);
	const targetHeight = Math.round(76 + state.rows.length * 42);
	if (typeof node.setSize === "function") node.setSize([currentWidth, targetHeight]);
	else node.size = [currentWidth, targetHeight];
	markNodeDirty(node);
}

function getRowSearchValue(state, index) {
	if (!Object.prototype.hasOwnProperty.call(state.searchByRow, index)) {
		state.searchByRow[index] = "";
	}
	return String(state.searchByRow[index] || "");
}

function buildRow(node, row, index, rowsContainer) {
	const state = ensureNodeState(node);
	const rowElement = document.createElement("div");
	rowElement.className = `gjj-wan-lora-row${row.enabled ? "" : " off"}`;

	const branchButton = document.createElement("button");
	branchButton.type = "button";
	branchButton.className = `gjj-wan-lora-branch ${row.branch === "low" ? "low" : "high"}`;
	branchButton.textContent = row.branch === "low" ? "🔻" : "🔺";
	branchButton.title = row.branch === "low" ? "Low 模型 LoRA 行。点击切换为 High 行。" : "High 模型 LoRA 行。点击切换为 Low 行。";
	branchButton.addEventListener("click", () => {
		state.rows[index].branch = row.branch === "low" ? "high" : "low";
		state.rows[index].autoPair = false;
		updateHiddenWidgets(node);
		renderUi(node);
	});

	const picker = document.createElement("button");
	picker.type = "button";
	picker.className = "gjj-wan-lora-picker";
	picker.textContent = row.name || DEFAULT_EMPTY_OPTION.label;
	picker.title = "点击展开当前槽的 LoRA 列表；弹窗过滤词支持空格模糊搜索。";
	picker.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const popup = ensurePopup();
		if (popup.isOpenFor(picker)) {
			popup.close();
			return;
		}
		popup.open({
			node,
			anchorEl: picker,
			searchValue: getRowSearchValue(state, index),
			onSearchChange(value) {
				state.searchByRow[index] = value;
				node.properties[SEARCH_BY_ROW_PROPERTY] = { ...state.searchByRow };
			},
			getSelectedValue() {
				return String(state.rows[index]?.name || "");
			},
			getOptions(searchText) {
				let options = getRowOptions(node, index, searchText);
				const selected = String(state.rows[index]?.name || "");
				if (selected && !options.some((option) => option.value === selected)) {
					options = [...options, { value: selected, label: selected }];
				}
				return options;
			},
			onSelect(value) {
				const current = state.rows[index] || emptyHighRow();
				const wasHigh = current.branch !== "low";
				if (!value && wasHigh && state.rows[index + 1]?.branch === "low" && state.rows[index + 1]?.autoPair === true) {
					state.rows.splice(index + 1, 1);
				}
				state.rows[index] = {
					...current,
					enabled: Boolean(value),
					name: value,
					autoPair: current.branch === "low" ? false : current.autoPair === true,
				};
				if (value && wasHigh) applyLowPairAfterHigh(node, index, value);
				ensureTrailingEmptyHighRow(node);
				updateHiddenWidgets(node);
				popup.close();
				renderUi(node);
			},
		});
	});

	const toggleWrap = document.createElement("label");
	toggleWrap.className = "gjj-wan-lora-toggle";
	toggleWrap.title = "控制当前这一行 LoRA 是否参与对应模型分支。";
	const toggle = document.createElement("input");
	toggle.type = "checkbox";
	toggle.checked = row.enabled !== false;
	toggleWrap.append(toggle, document.createTextNode("启用"));
	toggle.addEventListener("change", () => {
		state.rows[index].enabled = toggle.checked;
		updateHiddenWidgets(node);
		rowElement.classList.toggle("off", !toggle.checked);
	});

	const strength = document.createElement("input");
	strength.type = "number";
	strength.className = "gjj-wan-lora-strength";
	strength.step = "0.05";
	strength.value = formatStrength(row.strength, 1.0);
	strength.title = "当前行 LoRA 强度；High 与 Low 行各自独立。";
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		strength.addEventListener(eventName, (event) => event.stopPropagation());
	}
	const syncStrength = () => {
		if (isPartialNumericInput(strength.value)) return;
		state.rows[index].strength = normalizeStrength(strength.value, state.rows[index].strength ?? 1.0);
		updateHiddenWidgets(node);
	};
	const commitStrength = () => {
		state.rows[index].strength = normalizeStrength(strength.value, state.rows[index].strength ?? 1.0);
		strength.value = formatStrength(state.rows[index].strength, 1.0);
		updateHiddenWidgets(node);
	};
	strength.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Enter") {
			commitStrength();
			strength.blur();
		}
	});
	strength.addEventListener("input", syncStrength);
	strength.addEventListener("change", commitStrength);
	strength.addEventListener("blur", commitStrength);

	rowElement.append(branchButton, picker, toggleWrap, strength);
	rowsContainer.appendChild(rowElement);
}

function updateToggleButtons(node) {
	const state = ensureNodeState(node);
	if (node.__gjjWanLoraLowMemButton) {
		node.__gjjWanLoraLowMemButton.classList.toggle("on", Boolean(state.lowMemLoad));
		node.__gjjWanLoraLowMemButton.title = state.lowMemLoad
			? "低显存加载已开启；仅 WanVideo 合并加载路径有效。"
			: "低显存加载已关闭。";
	}
	if (node.__gjjWanLoraMergeButton) {
		node.__gjjWanLoraMergeButton.classList.toggle("on", Boolean(state.mergeLoras));
		node.__gjjWanLoraMergeButton.title = state.mergeLoras
			? "合并 LoRA 已开启；当前后置 WANVIDEOMODEL 节点执行时会提示不支持。"
			: "合并 LoRA 已关闭；使用 WanVideoSetLoRAs 后置应用路径。";
	}
}

function renderUi(node) {
	const state = ensureNodeState(node);
	hideWidget(node, getWidget(node, DATA_WIDGET_NAME));
	hideWidget(node, getWidget(node, LOW_MEM_WIDGET_NAME));
	hideWidget(node, getWidget(node, MERGE_WIDGET_NAME));
	removeConvertedWidgetInput(node, DATA_WIDGET_NAME);
	removeConvertedWidgetInput(node, LOW_MEM_WIDGET_NAME);
	removeConvertedWidgetInput(node, MERGE_WIDGET_NAME);

	if (node.__gjjWanLoraGlobalSearch && node.__gjjWanLoraGlobalSearch.value !== String(state.globalSearch || "")) {
		node.__gjjWanLoraGlobalSearch.value = String(state.globalSearch || "");
	}
	ensureTrailingEmptyHighRow(node);
	if (globalThis.__gjjWanLoraPopup?.state?.node === node) globalThis.__gjjWanLoraPopup.close();
	node.__gjjWanLoraRows?.replaceChildren();
	state.rows.forEach((row, index) => buildRow(node, row, index, node.__gjjWanLoraRows));
	updateToggleButtons(node);
	updateHiddenWidgets(node);
	updateNodeHeight(node);
}

async function refreshOptions(node, rerender = true) {
	const state = ensureNodeState(node);
	state.options = await fetchLoraOptions();
	if (rerender) renderUi(node);
}

function normalizeSockets(node) {
	if (node.inputs?.[0]) {
		node.inputs[0].name = "high_model";
		node.inputs[0].label = "🔺 High模型";
		node.inputs[0].localized_name = "🔺 High模型";
		node.inputs[0].type = "WANVIDEOMODEL";
	}
	if (node.inputs?.[1]) {
		node.inputs[1].name = "low_model";
		node.inputs[1].label = "🔻 Low模型";
		node.inputs[1].localized_name = "🔻 Low模型";
		node.inputs[1].type = "WANVIDEOMODEL";
	}
	if (node.outputs?.[0]) {
		node.outputs[0].name = "High模型";
		node.outputs[0].label = "🔺 High模型";
		node.outputs[0].localized_name = "🔺 High模型";
		node.outputs[0].type = "WANVIDEOMODEL";
	}
	if (node.outputs?.[1]) {
		node.outputs[1].name = "Low模型";
		node.outputs[1].label = "🔻 Low模型";
		node.outputs[1].localized_name = "🔻 Low模型";
		node.outputs[1].type = "WANVIDEOMODEL";
	}
}

function setupUi(node) {
	if (node.__gjjWanLoraContainer) return;
	node.properties = node.properties || {};
	normalizeSockets(node);

	for (const name of [DATA_WIDGET_NAME, LOW_MEM_WIDGET_NAME, MERGE_WIDGET_NAME]) {
		const widget = getWidget(node, name);
		hideWidget(node, widget);
		removeConvertedWidgetInput(node, name);
	}

	const state = ensureNodeState(node);
	state.rows = normalizeRows(getWidget(node, DATA_WIDGET_NAME)?.value || node.properties[DATA_WIDGET_NAME] || "[]");
	state.searchByRow = normalizeSearchByRow(node.properties[SEARCH_BY_ROW_PROPERTY]);
	state.globalSearch = String(node.properties[GLOBAL_SEARCH_PROPERTY] || "");
	state.lowMemLoad = normalizeBoolean(getWidget(node, LOW_MEM_WIDGET_NAME)?.value ?? node.properties[LOW_MEM_PROPERTY]);
	state.mergeLoras = normalizeBoolean(getWidget(node, MERGE_WIDGET_NAME)?.value ?? node.properties[MERGE_PROPERTY]);

	const container = document.createElement("div");
	container.className = "gjj-wan-lora-wrap";
	createStyleTag(container);

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-wan-lora-toolbar";

	const globalSearch = document.createElement("input");
	globalSearch.type = "text";
	globalSearch.className = "gjj-wan-lora-global-search";
	globalSearch.placeholder = "全局过滤 WanVideo LoRA";
	globalSearch.title = "顶部总过滤词；支持空格模糊搜索，例如：wan high。";
	globalSearch.value = state.globalSearch;
	globalSearch.addEventListener("input", () => {
		state.globalSearch = globalSearch.value;
		node.properties[GLOBAL_SEARCH_PROPERTY] = state.globalSearch;
		renderUi(node);
	});

	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.className = "gjj-wan-lora-button";
	refreshButton.textContent = "刷新列表";
	refreshButton.title = "重新读取 models/loras 下的 WanVideo LoRA 列表。";
	refreshButton.addEventListener("click", () => refreshOptions(node, true));

	const lowMemButton = document.createElement("button");
	lowMemButton.type = "button";
	lowMemButton.className = "gjj-wan-lora-button";
	lowMemButton.textContent = "💾低显存";
	lowMemButton.addEventListener("click", () => {
		state.lowMemLoad = !state.lowMemLoad;
		updateHiddenWidgets(node);
		updateToggleButtons(node);
	});

	const mergeButton = document.createElement("button");
	mergeButton.type = "button";
	mergeButton.className = "gjj-wan-lora-button";
	mergeButton.textContent = "🔗合并";
	mergeButton.addEventListener("click", () => {
		state.mergeLoras = !state.mergeLoras;
		updateHiddenWidgets(node);
		updateToggleButtons(node);
	});

	toolbar.append(globalSearch, refreshButton, lowMemButton, mergeButton);
	const rowsContainer = document.createElement("div");
	rowsContainer.className = "gjj-wan-lora-rows";
	container.append(toolbar, rowsContainer);

	container.addEventListener("mousedown", (event) => event.stopPropagation());
	container.addEventListener("pointerdown", stopCanvasPointerCapture);
	container.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	container.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });

	node.__gjjWanLoraContainer = container;
	node.__gjjWanLoraRows = rowsContainer;
	node.__gjjWanLoraGlobalSearch = globalSearch;
	node.__gjjWanLoraLowMemButton = lowMemButton;
	node.__gjjWanLoraMergeButton = mergeButton;

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		updateHiddenWidgets(this);
		originalOnSerialize?.apply(this, arguments);
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[DATA_WIDGET_NAME] = serializeRows(ensureNodeState(this).rows);
		serializedNode.properties[SEARCH_BY_ROW_PROPERTY] = { ...ensureNodeState(this).searchByRow };
		serializedNode.properties[GLOBAL_SEARCH_PROPERTY] = String(ensureNodeState(this).globalSearch || "");
		serializedNode.properties[LOW_MEM_PROPERTY] = Boolean(ensureNodeState(this).lowMemLoad);
		serializedNode.properties[MERGE_PROPERTY] = Boolean(ensureNodeState(this).mergeLoras);
	};

	node.__gjjWanLoraWidget = node.addDOMWidget("WanVideo LoRA", "HTML", container, { serialize: false });
	refreshOptions(node, false).then(() => renderUi(node));
}

app.registerExtension({
	name: "Comfy.GJJ.WanVideoHighLowLora",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;

		nodeData.output = ["WANVIDEOMODEL", "WANVIDEOMODEL"];
		nodeData.output_name = ["High模型", "Low模型"];

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
				state.rows = normalizeRows(getWidget(this, DATA_WIDGET_NAME)?.value || this.properties?.[DATA_WIDGET_NAME] || "[]");
				state.searchByRow = normalizeSearchByRow(this.properties?.[SEARCH_BY_ROW_PROPERTY]);
				state.globalSearch = String(this.properties?.[GLOBAL_SEARCH_PROPERTY] || "");
				state.lowMemLoad = normalizeBoolean(getWidget(this, LOW_MEM_WIDGET_NAME)?.value ?? this.properties?.[LOW_MEM_PROPERTY]);
				state.mergeLoras = normalizeBoolean(getWidget(this, MERGE_WIDGET_NAME)?.value ?? this.properties?.[MERGE_PROPERTY]);
				setupUi(this);
				renderUi(this);
			}, 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => {
				normalizeSockets(this);
				markNodeDirty(this);
			}, 0);
			return result;
		};
	},

	setup() {
		setTimeout(() => {
			for (const node of app.graph?._nodes || []) {
				if (node?.comfyClass === NODE_NAME || node?.type === NODE_NAME) setupUi(node);
			}
		}, 0);
	},
});

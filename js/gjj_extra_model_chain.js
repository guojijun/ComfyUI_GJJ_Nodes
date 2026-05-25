import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_ExtraModelChainConfig"]);
const DATA_WIDGET_NAME = "extra_model_data";
const LIST_API = "/gjj/extra_model_chain_lists";
const GLOBAL_SEARCH_PROPERTY = "gjj_extra_model_global_search";
const DEFAULT_ROW = { enabled: false, kind: "vace", name: "", branch: "both", base_precision: "fp16" };
const EMPTY_OPTION = { value: "", label: "未选择" };
const DEFAULT_KINDS = [
	{ value: "vace", label: "VACE", icon: "🧩" },
	{ value: "fantasytalking", label: "FantasyTalking", icon: "🗣" },
	{ value: "multitalk", label: "MultiTalk", icon: "🎤" },
	{ value: "fantasyportrait", label: "FantasyPortrait", icon: "🧑" },
];
const DEFAULT_BRANCHES = [
	{ value: "both", label: "全部" },
	{ value: "high", label: "High" },
	{ value: "low", label: "Low" },
];
const DEFAULT_PRECISIONS = ["fp16", "bf16", "fp32"];
const PRECISION_KINDS = new Set(["fantasytalking", "fantasyportrait"]);
const OUTPUT_DEFS = [
	{ name: "额外模型串联配置", type: "EXTRA_MODEL_CHAIN", tooltip: "额外模型链配置，可接 GJJ 视频通用模型加载器。" },
	{ name: "VACE模型", type: "VACEPATH", kind: "vace", tooltip: "启用 VACE 后输出 VACEPATH。" },
	{ name: "FantasyTalking模型", type: "FANTASYTALKINGMODEL", kind: "fantasytalking", tooltip: "启用 FantasyTalking 后输出对应模型对象。" },
	{ name: "MultiTalk模型", type: "MULTITALKMODEL", kind: "multitalk", tooltip: "启用 MultiTalk / InfiniteTalk 后输出对应模型对象。" },
	{ name: "FantasyPortrait模型", type: "FANTASYPORTRAITMODEL", kind: "fantasyportrait", tooltip: "启用 FantasyPortrait 后输出对应模型对象。" },
];

function normalizeKind(value) {
	const text = String(value || "vace").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
	const aliases = {
		fantasy_talking: "fantasytalking",
		ft: "fantasytalking",
		multi_talk: "multitalk",
		infinite_talk: "multitalk",
		infinitetalk: "multitalk",
		fantasy_portrait: "fantasyportrait",
		portrait: "fantasyportrait",
	};
	return aliases[text] || text || "vace";
}

function normalizeBranch(value) {
	const text = String(value || "both").trim().toLowerCase();
	if (["all", "全部"].includes(text)) return "both";
	if (["高"].includes(text)) return "high";
	if (["低"].includes(text)) return "low";
	return ["both", "high", "low"].includes(text) ? text : "both";
}

function normalizePrecision(value) {
	const text = String(value || "fp16").trim().toLowerCase();
	return DEFAULT_PRECISIONS.includes(text) ? text : "fp16";
}

function parseRows(value) {
	try {
		const parsed = JSON.parse(String(value || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (_) {
		return [];
	}
}

function kindOrderMap(kinds = DEFAULT_KINDS) {
	const map = new Map();
	(kinds || DEFAULT_KINDS).forEach((item, index) => {
		map.set(normalizeKind(item.value), index);
	});
	return map;
}

function normalizeRow(item, keepEmptyEnabled = false) {
	if (!item || typeof item !== "object") return null;
	const name = String(item.name || item.model || item.file || "").trim();
	const enabled = item.enabled !== false && (Boolean(name) || keepEmptyEnabled);
	return {
		enabled,
		kind: normalizeKind(item.kind),
		name,
		branch: normalizeBranch(item.branch),
		base_precision: normalizePrecision(item.base_precision || item.precision),
	};
}

function compactRows(rows, kinds = DEFAULT_KINDS, keepEmptyEnabled = false) {
	const byKind = new Map();
	for (const raw of rows || []) {
		const row = normalizeRow(raw, keepEmptyEnabled);
		if (!row || (!row.name && !row.enabled)) continue;
		const kind = normalizeKind(row.kind);
		const existing = byKind.get(kind);
		if (!existing) {
			byKind.set(kind, row);
			continue;
		}
		if (!existing.name && row.name) {
			byKind.set(kind, row);
		} else if (row.enabled && !existing.enabled) {
			existing.enabled = true;
		}
	}
	const order = kindOrderMap(kinds);
	return Array.from(byKind.values()).sort((a, b) => {
		const ai = order.has(a.kind) ? order.get(a.kind) : 999;
		const bi = order.has(b.kind) ? order.get(b.kind) : 999;
		if (ai !== bi) return ai - bi;
		return String(a.kind).localeCompare(String(b.kind), "zh-Hans-CN");
	});
}

function normalizeRows(value) {
	return compactRows(parseRows(value), DEFAULT_KINDS, false);
}

function serializeRows(rows) {
	const cleaned = compactRows(rows || [], DEFAULT_KINDS, false)
		.filter((item) => String(item.name || "").trim())
		.map((item) => ({
			enabled: item.enabled !== false,
			kind: normalizeKind(item.kind),
			name: String(item.name || "").trim(),
			branch: normalizeBranch(item.branch),
			base_precision: normalizePrecision(item.base_precision || item.precision),
		}));
	return JSON.stringify(cleaned);
}

function ensureTrailingEmptyRow(node) {
	const state = ensureNodeState(node);
	state.rows = compactRows(state.rows || [], state.kinds || DEFAULT_KINDS, true);
}

function hideDataWidget(node, widget) {
	if (!widget) return;
	widget.__gjjExtraModelNode = node;
	widget.type = "hidden";
	widget.hidden = true;
	widget.display = "hidden";
	widget.forceInput = false;
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden", forceInput: false };
	widget.serialize = true;
	widget.serializeValue = () => {
		const targetNode = widget.__gjjExtraModelNode || node;
		const serialized = serializeRows(ensureNodeState(targetNode).rows);
		const widgetIndex = Array.isArray(targetNode?.widgets) ? targetNode.widgets.indexOf(widget) : -1;
		if (Array.isArray(targetNode?.widgets_values) && widgetIndex >= 0) {
			targetNode.widgets_values[widgetIndex] = serialized;
		}
		return serialized;
	};
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	widget.label = "";
	widget.name = DATA_WIDGET_NAME;
	for (const el of [widget.inputEl, widget.element, widget.widget]) {
		if (el?.style) el.style.display = "none";
	}
}

function ensureNodeState(node) {
	node.properties = node.properties || {};
	node.__gjjExtraModelState = node.__gjjExtraModelState || {
		rows: normalizeRows(node.properties[DATA_WIDGET_NAME] || "[]"),
		kinds: DEFAULT_KINDS,
		branches: DEFAULT_BRANCHES,
		precisions: DEFAULT_PRECISIONS,
		models: {},
		allModels: [],
		globalSearch: String(node.properties[GLOBAL_SEARCH_PROPERTY] || ""),
	};
	return node.__gjjExtraModelState;
}

async function refreshOptions(node, rerender = true) {
	const state = ensureNodeState(node);
	try {
		const response = await fetch(LIST_API);
		if (response?.ok) {
			const payload = await response.json();
			state.kinds = Array.isArray(payload?.kinds) && payload.kinds.length ? payload.kinds : DEFAULT_KINDS;
			state.branches = Array.isArray(payload?.branches) && payload.branches.length ? payload.branches : DEFAULT_BRANCHES;
			state.precisions = Array.isArray(payload?.precisions) && payload.precisions.length ? payload.precisions.map(String) : DEFAULT_PRECISIONS;
			state.models = payload?.models && typeof payload.models === "object" ? payload.models : {};
			state.allModels = Array.isArray(payload?.all_models) ? payload.all_models.map(String) : [];
		}
	} catch (error) {
		console.warn("[GJJ Extra Model Chain] 模型列表读取失败", error);
	}
	fillMissingDefaultModels(state);
	if (rerender) renderUi(node);
}

function updateDataWidget(node) {
	const dataWidget = node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
	if (!dataWidget) return;
	const state = ensureNodeState(node);
	const serialized = serializeRows(state.rows);
	dataWidget.value = serialized;
	dataWidget.callback?.(serialized);
	node.properties = node.properties || {};
	node.properties[DATA_WIDGET_NAME] = serialized;
	const widgetIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(dataWidget) : -1;
	if (widgetIndex >= 0) {
		node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
		node.widgets_values[widgetIndex] = serialized;
	}
	updateOutputSockets(node);
}

function updateNodeHeight(node) {
	const state = ensureNodeState(node);
	const rowCount = Math.max(0, state.rows.length);
	node.size = [Math.max(node.size?.[0] || 480, 480), 52 + rowCount * 46];
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function enabledOutputKinds(node) {
	const state = ensureNodeState(node);
	return new Set((state.rows || [])
		.filter((row) => row?.enabled !== false && String(row?.name || "").trim())
		.map((row) => normalizeKind(row.kind)));
}

function visibleOutputDefs(node) {
	const enabledKinds = enabledOutputKinds(node);
	return OUTPUT_DEFS.filter((def, index) => index === 0 || enabledKinds.has(normalizeKind(def.kind)));
}

function outputKindKey(output, index) {
	return String(output?.__gjjExtraModelKind || (index === 0 ? "chain" : ""));
}

function collectOutputLinksByKind(node) {
	const saved = [];
	const outputs = Array.isArray(node.outputs) ? node.outputs : [];
	for (let index = 0; index < outputs.length; index += 1) {
		const output = outputs[index];
		const links = Array.isArray(output?.links) ? output.links.slice() : [];
		for (const linkId of links) {
			const link = app.graph?.links?.[linkId];
			if (!link) continue;
			saved.push({
				linkId,
				link,
				kind: outputKindKey(output, index),
				target_id: link.target_id,
				target_slot: link.target_slot,
			});
		}
	}
	return saved;
}

function detachAllOutputLinks(node) {
	for (const output of node.outputs || []) {
		if (output) output.links = [];
	}
}

function removeUnrestoredLinks(saved, restored) {
	for (const item of saved || []) {
		if (restored.has(item.linkId)) continue;
		const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (targetInput?.link === item.linkId) targetInput.link = null;
		try { app.graph?.removeLink?.(item.linkId); } catch (_) {}
		try { if (app.graph?.links?.[item.linkId]) delete app.graph.links[item.linkId]; } catch (_) {}
	}
}

function restoreOutputLinksByKind(node, saved) {
	const restored = new Set();
	const usedTargets = new Set();
	for (let index = 0; index < (node.outputs || []).length; index += 1) {
		const output = node.outputs[index];
		if (!output) continue;
		output.links = Array.isArray(output.links) ? output.links : [];
		const kind = outputKindKey(output, index);
		for (const item of saved || []) {
			if (item.kind !== kind || restored.has(item.linkId)) continue;
			const targetKey = `${item.target_id}:${item.target_slot}`;
			if (usedTargets.has(targetKey)) continue;
			const link = item.link;
			if (!link) continue;
			link.origin_id = node.id;
			link.origin_slot = index;
			link.type = output.type;
			app.graph.links = app.graph.links || {};
			app.graph.links[item.linkId] = link;
			if (!output.links.includes(item.linkId)) output.links.push(item.linkId);
			const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
			const targetInput = targetNode?.inputs?.[item.target_slot];
			if (targetInput) targetInput.link = item.linkId;
			restored.add(item.linkId);
			usedTargets.add(targetKey);
		}
	}
	removeUnrestoredLinks(saved, restored);
}

function repairVisibleOutput(output, def, index) {
	output.name = def.name;
	output.label = def.name;
	output.localized_name = def.name;
	output.type = def.type;
	output.tooltip = def.tooltip || "";
	output.__gjjExtraModelKind = def.kind || "chain";
	output.__gjjExtraModelOutput = true;
	output.slot_index = index;
	delete output.hidden;
	delete output.disabled;
	delete output.not_show;
	delete output.__gjj_hidden;
	if (Object.prototype.hasOwnProperty.call(output, "pos")) {
		try { delete output.pos; } catch (_) { output.pos = undefined; }
	}
	output.visible = true;
	if (!Array.isArray(output.links)) output.links = [];
	for (const linkId of output.links.slice()) {
		const link = app.graph?.links?.[linkId];
		if (!link) continue;
		link.origin_id = app.graph?.getNodeById?.(link.origin_id)?.id || link.origin_id;
		link.origin_slot = index;
		link.type = def.type;
	}
}

function updateOutputSockets(node) {
	if (!node) return;
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const defs = visibleOutputDefs(node);
	const savedLinks = collectOutputLinksByKind(node);
	detachAllOutputLinks(node);
	while (node.outputs.length > defs.length) {
		try { node.removeOutput(node.outputs.length - 1); }
		catch (_) { node.outputs.splice(node.outputs.length - 1, 1); }
	}
	while (node.outputs.length < defs.length) {
		try { node.addOutput?.("*", "*"); }
		catch (_) { node.outputs.push({ name: "*", type: "*", links: [] }); }
	}
	defs.forEach((def, index) => {
		const output = node.outputs[index];
		if (output) repairVisibleOutput(output, def, index);
	});
	restoreOutputLinksByKind(node, savedLinks);
	node.__gjjExtraModelOutputSignature = defs.map((def) => `${def.name}:${def.type}:${def.kind || "chain"}`).join("|");
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function stopCanvasPointerCapture(event) {
	event.stopPropagation();
}

function stopCanvasWheelCapture(event) {
	event.stopPropagation();
}

function createStyleTag(container) {
	const style = document.createElement("style");
	style.textContent = `
		.gjj-extra-wrap { display:flex; flex-direction:column; gap:6px; width:100%; box-sizing:border-box; margin-top:4px; }
		.gjj-extra-toolbar { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; align-items:center; }
		.gjj-extra-kind-btn { height:28px; min-width:0; padding:3px 5px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-extra-kind-btn:hover { background:#223039; }
		.gjj-extra-kind-btn.on { border-color:#4f8f7a; background:#17382f; color:#dff8ea; }
		.gjj-extra-rows { display:flex; flex-direction:column; gap:6px; }
		.gjj-extra-row { display:grid; grid-template-columns:112px minmax(0,1fr) 62px 58px 46px; gap:6px; align-items:center; padding:6px; border:1px solid #3c4c54; border-radius:8px; background:#172026; }
		.gjj-extra-row.off { opacity:.66; }
		.gjj-extra-kind-label { min-width:0; height:26px; display:flex; align-items:center; color:#b9c8cc; font-size:11px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-extra-branch, .gjj-extra-precision { width:100%; min-width:0; height:26px; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:2px 5px; font-size:11px; }
		.gjj-extra-picker, .gjj-extra-toggle { width:100%; min-width:0; height:26px; border:1px solid #41535b; border-radius:6px; background:#11181c; color:#dce7e2; cursor:pointer; font-size:11px; }
		.gjj-extra-picker { text-align:left; padding:3px 7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-extra-toggle { padding:0; text-align:center; background:#20282d; }
		.gjj-extra-toggle.on { border-color:#4f8f7a; background:#17382f; color:#dff8ea; }
		.gjj-extra-precision.hidden { visibility:hidden; }
		.gjj-extra-popup { display:none; flex-direction:column; gap:6px; position:fixed; z-index:99999; width:520px; max-width:calc(100vw - 24px); max-height:420px; padding:7px; border:1px solid #47616b; border-radius:9px; background:#10191d; box-shadow:0 10px 32px rgba(0,0,0,.45); }
		.gjj-extra-popup.open { display:flex; }
		.gjj-extra-popup-search { width:100%; height:28px; padding:3px 7px; border:1px solid #d7eff5; border-radius:6px; background:#0b1418; color:#f1f5f5; outline:none; font-size:12px; }
		.gjj-extra-popup-list { max-height:350px; overflow:auto; display:flex; flex-direction:column; gap:4px; }
		.gjj-extra-popup-item { width:100%; min-height:28px; padding:5px 8px; border:1px solid #31464e; border-radius:6px; background:#172328; color:#edf4f4; text-align:left; cursor:pointer; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-extra-popup-item:hover { background:#21323a; }
		.gjj-extra-popup-item.selected { border-color:#4f8f7a; background:#103b31; color:#dff8ea; }
		.gjj-extra-popup-empty { color:#9caab0; font-size:12px; padding:6px 4px; }
	`;
	container.appendChild(style);
}

function optionLabel(options, value) {
	const found = (options || []).find((item) => String(item.value) === String(value));
	return String(found?.label || value || "");
}

function kindIcon(state, kind) {
	const found = (state.kinds || DEFAULT_KINDS).find((item) => String(item.value) === String(kind));
	return String(found?.icon || "🧩");
}

function modelListForKind(state, kind) {
	const normalizedKind = normalizeKind(kind);
	const byKind = Array.isArray(state.models?.[normalizedKind]) ? state.models[normalizedKind].map(String) : [];
	const fallback = Array.isArray(state.allModels) ? state.allModels.map(String) : [];
	return (byKind.length ? byKind : fallback).filter((value) => String(value || "").trim());
}

function firstModelForKind(state, kind) {
	return modelListForKind(state, kind)[0] || "";
}

function hasLoadedModelLists(state) {
	return Object.keys(state.models || {}).length > 0 || (Array.isArray(state.allModels) && state.allModels.length > 0);
}

function fillMissingDefaultModels(state) {
	let changed = false;
	state.rows = compactRows(state.rows || [], state.kinds || DEFAULT_KINDS, true).map((row) => {
		if (!row.name && row.enabled) {
			const first = firstModelForKind(state, row.kind);
			if (first) {
				changed = true;
				return { ...row, name: first };
			}
		}
		return row;
	});
	return changed;
}

function splitSearch(value) {
	return String(value || "")
		.toLowerCase()
		.split(/[\s,，、;；|]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function getModelOptions(node, rowIndex, popupSearch = "") {
	const state = ensureNodeState(node);
	const row = state.rows[rowIndex] || DEFAULT_ROW;
	const kind = normalizeKind(row.kind);
	const baseList = modelListForKind(state, kind);
	const values = baseList.length ? baseList.slice() : [""];
	if (row.name && !values.includes(row.name)) values.push(row.name);
	const words = splitSearch(popupSearch);
	return values
		.filter((value) => {
			if (!value) return true;
			const text = String(value).replaceAll("\\", "/").toLowerCase();
			return words.every((word) => text.includes(word));
		})
		.slice(0, 180)
		.map((value) => ({ value, label: value || EMPTY_OPTION.label }));
}

function positionPopup(panel, anchorEl) {
	const rect = anchorEl?.getBoundingClientRect?.();
	const viewportWidth = Math.max(320, window.innerWidth || 320);
	const viewportHeight = Math.max(240, window.innerHeight || 240);
	const width = Math.min(520, Math.max(320, viewportWidth - 24));
	const left = Math.max(12, Math.min(Math.floor(rect?.left || 12), viewportWidth - width - 12));
	const below = Math.ceil(rect?.bottom || 12) + 6;
	panel.style.width = `${width}px`;
	panel.style.left = `${left}px`;
	panel.style.top = `${Math.min(below, viewportHeight - 180)}px`;
}

function ensurePopup() {
	if (globalThis.__gjjExtraModelPopup) return globalThis.__gjjExtraModelPopup;

	const panel = document.createElement("div");
	panel.className = "gjj-extra-popup";
	const search = document.createElement("input");
	search.className = "gjj-extra-popup-search";
	search.placeholder = "搜索模型";
	const list = document.createElement("div");
	list.className = "gjj-extra-popup-list";
	panel.append(search, list);
	document.body.appendChild(panel);

	for (const eventName of ["mousedown", "pointerdown", "click"]) panel.addEventListener(eventName, stopCanvasPointerCapture);
	for (const eventName of ["wheel", "mousewheel"]) {
		panel.addEventListener(eventName, stopCanvasWheelCapture, { passive: true });
		list.addEventListener(eventName, stopCanvasWheelCapture, { passive: true });
	}

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
		render() {
			if (!this.state) return;
			const options = this.state.getOptions(search.value);
			const selected = String(this.state.getSelectedValue() || "");
			list.replaceChildren();
			if (!options.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-extra-popup-empty";
				empty.textContent = "没有匹配的模型";
				list.appendChild(empty);
				return;
			}
			for (const option of options) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-extra-popup-item";
				if (String(option.value) === selected) item.classList.add("selected");
				item.textContent = `${String(option.value) === selected ? "✓ " : ""}${option.label}`;
				item.title = option.value;
				item.addEventListener("click", () => this.state?.onSelect?.(String(option.value || "")));
				list.appendChild(item);
			}
			positionPopup(panel, this.state.anchorEl);
		},
		isOpenFor(anchorEl) {
			return panel.classList.contains("open") && this.state?.anchorEl === anchorEl;
		},
		open(state) {
			this.state = state;
			search.value = "";
			panel.classList.add("open");
			positionPopup(panel, state.anchorEl);
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
	search.addEventListener("input", () => popup.render());
	search.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Escape") {
			event.preventDefault();
			popup.close();
		}
	});
	window.addEventListener("resize", () => popup.state && positionPopup(panel, popup.state.anchorEl));
	globalThis.__gjjExtraModelPopup = popup;
	return popup;
}

function buildRow(node, row, index, rowsContainer) {
	const state = ensureNodeState(node);
	const rowElement = document.createElement("div");
	rowElement.className = `gjj-extra-row${row.enabled ? "" : " off"}`;

	const kindLabel = document.createElement("div");
	kindLabel.className = "gjj-extra-kind-label";
	const kind = normalizeKind(row.kind);
	kindLabel.textContent = `${kindIcon(state, kind)} ${optionLabel(state.kinds, kind)}`;
	kindLabel.title = optionLabel(state.kinds, kind);

	const picker = document.createElement("button");
	picker.type = "button";
	picker.className = "gjj-extra-picker";
	picker.textContent = row.name || EMPTY_OPTION.label;
	picker.title = row.name || "点击选择模型文件。";
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
			getSelectedValue: () => state.rows[index]?.name || "",
			getOptions: (searchText) => getModelOptions(node, index, searchText),
			onSelect(value) {
				if (!value) {
					state.rows.splice(index, 1);
					updateDataWidget(node);
					popup.close();
					renderUi(node);
					return;
				}
				state.rows[index].name = value;
				state.rows[index].enabled = true;
				updateDataWidget(node);
				popup.close();
				renderUi(node);
			},
		});
	});

	const branchSelect = document.createElement("select");
	branchSelect.className = "gjj-extra-branch";
	branchSelect.title = "双模型流程可指定 High / Low；普通单模型保持全部。";
	for (const item of state.branches || DEFAULT_BRANCHES) {
		const option = document.createElement("option");
		option.value = String(item.value);
		option.textContent = String(item.label || item.value);
		branchSelect.appendChild(option);
	}
	branchSelect.value = normalizeBranch(row.branch);
	branchSelect.addEventListener("change", () => {
		state.rows[index].branch = normalizeBranch(branchSelect.value);
		updateDataWidget(node);
	});

	const precisionSelect = document.createElement("select");
	precisionSelect.className = `gjj-extra-precision${PRECISION_KINDS.has(normalizeKind(row.kind)) ? "" : " hidden"}`;
	precisionSelect.title = "FantasyTalking / FantasyPortrait 模型加载精度。";
	for (const value of state.precisions || DEFAULT_PRECISIONS) {
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = String(value);
		precisionSelect.appendChild(option);
	}
	precisionSelect.value = normalizePrecision(row.base_precision);
	precisionSelect.addEventListener("change", () => {
		state.rows[index].base_precision = normalizePrecision(precisionSelect.value);
		updateDataWidget(node);
	});

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = `gjj-extra-toggle${row.enabled ? " on" : ""}`;
	toggle.textContent = row.enabled ? "开" : "关";
	toggle.title = "控制当前这一行是否参与额外模型串联。";
	toggle.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		state.rows[index].enabled = !state.rows[index].enabled;
		updateDataWidget(node);
		renderUi(node);
	});

	for (const el of [kindLabel, picker, branchSelect, precisionSelect, toggle]) {
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
			el.addEventListener(eventName, stopCanvasPointerCapture);
		}
	}

	rowElement.title = `${kindIcon(state, row.kind)} ${optionLabel(state.kinds, row.kind)}`;
	rowElement.append(kindLabel, picker, branchSelect, precisionSelect, toggle);
	rowsContainer.appendChild(rowElement);
}

async function toggleKindRow(node, kindValue) {
	const state = ensureNodeState(node);
	const kind = normalizeKind(kindValue);
	const hasKind = (state.rows || []).some((row) => normalizeKind(row.kind) === kind);
	if (hasKind) {
		state.rows = compactRows(state.rows || [], state.kinds || DEFAULT_KINDS, true).filter((row) => normalizeKind(row.kind) !== kind);
		updateDataWidget(node);
		renderUi(node);
		return;
	}
	if (!hasLoadedModelLists(state)) {
		await refreshOptions(node, false);
	}
	const defaultModel = firstModelForKind(state, kind);
	state.rows = compactRows(
		[
			...(state.rows || []),
			{
				...DEFAULT_ROW,
				enabled: true,
				kind,
				name: defaultModel,
			},
		],
		state.kinds || DEFAULT_KINDS,
		true,
	);
	updateDataWidget(node);
	renderUi(node);
}

function buildKindToolbar(node, toolbar) {
	const state = ensureNodeState(node);
	toolbar.replaceChildren();
	for (const item of state.kinds || DEFAULT_KINDS) {
		const kind = normalizeKind(item.value);
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-extra-kind-btn";
		if ((state.rows || []).some((row) => normalizeKind(row.kind) === kind)) {
			button.classList.add("on");
		}
		button.textContent = `${item.icon || "🧩"} ${item.label || kind}`;
		button.title = button.classList.contains("on") ? `取消 ${item.label || kind}` : `启用 ${item.label || kind}`;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleKindRow(node, kind);
		});
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
			button.addEventListener(eventName, stopCanvasPointerCapture);
		}
		toolbar.appendChild(button);
	}
}

function renderUi(node) {
	const state = ensureNodeState(node);
	const rowsContainer = node.__gjjExtraModelRows;
	if (!rowsContainer) return;
	hideDataWidget(node, node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME));
	if (globalThis.__gjjExtraModelPopup?.state?.node === node) {
		globalThis.__gjjExtraModelPopup.close();
	}
	ensureTrailingEmptyRow(node);
	if (node.__gjjExtraModelToolbar) buildKindToolbar(node, node.__gjjExtraModelToolbar);
	rowsContainer.replaceChildren();
	state.rows.forEach((row, index) => buildRow(node, row, index, rowsContainer));
	updateDataWidget(node);
	updateOutputSockets(node);
	updateNodeHeight(node);
}

function setupUi(node) {
	if (node.__gjjExtraModelContainer) return;

	const dataWidget = node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
	hideDataWidget(node, dataWidget);
	ensureNodeState(node).rows = normalizeRows(dataWidget?.value || node.properties?.[DATA_WIDGET_NAME] || "[]");

	const container = document.createElement("div");
	container.className = "gjj-extra-wrap";
	createStyleTag(container);

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-extra-toolbar";
	buildKindToolbar(node, toolbar);
	container.appendChild(toolbar);

	const rowsContainer = document.createElement("div");
	rowsContainer.className = "gjj-extra-rows";
	container.appendChild(rowsContainer);

	container.addEventListener("mousedown", stopCanvasPointerCapture);
	container.addEventListener("pointerdown", stopCanvasPointerCapture);
	container.addEventListener("wheel", stopCanvasWheelCapture, { passive: true });
	container.addEventListener("mousewheel", stopCanvasWheelCapture, { passive: true });

	node.__gjjExtraModelContainer = container;
	node.__gjjExtraModelRows = rowsContainer;
	node.__gjjExtraModelToolbar = toolbar;

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		updateDataWidget(this);
		originalOnSerialize?.apply(this, arguments);
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[DATA_WIDGET_NAME] = serializeRows(ensureNodeState(this).rows);
		serializedNode.properties[GLOBAL_SEARCH_PROPERTY] = String(ensureNodeState(this).globalSearch || "");
		const widgetIndex = Array.isArray(this.widgets) ? this.widgets.findIndex((widget) => widget?.name === DATA_WIDGET_NAME) : -1;
		if (widgetIndex >= 0) {
			serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values) ? serializedNode.widgets_values : [];
			serializedNode.widgets_values[widgetIndex] = serializeRows(ensureNodeState(this).rows);
		}
	};

	node.addDOMWidget("额外模型串联", "HTML", container, { serialize: false });
	updateOutputSockets(node);
	refreshOptions(node, false).then(() => renderUi(node));
}

app.registerExtension({
	name: "Comfy.GJJ.ExtraModelChain",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => setupUi(this), 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			setTimeout(() => {
				const state = ensureNodeState(this);
				const dataWidget = this.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
				state.rows = normalizeRows(dataWidget?.value || this.properties?.[DATA_WIDGET_NAME] || "[]");
				state.globalSearch = String(this.properties?.[GLOBAL_SEARCH_PROPERTY] || "");
				setupUi(this);
				renderUi(this);
			}, 0);
			return result;
		};
	},
});

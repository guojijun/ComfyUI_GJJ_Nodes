import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "GJJ_ModelEffectTester";
const STATE_WIDGET = "test_state";
const INDEX_WIDGET = "current_index";
const SOURCE_WIDGET = "model_source";
const PANEL_WIDGET = "gjj_model_effect_tester_panel";
const CONTROL_WIDGET = "gjj_model_effect_tester_controls";
const API_PATH = "/gjj/model_effect_models";
const PASS_MARK = "✅ ";
const FAIL_MARK = "❌ ";
const OUTPUT_MODEL = 0;
const OUTPUT_LIST = 2;
const QUEUE_DELAY_MS = 800;
const PARAMS_PROPERTY = "gjj_model_effect_tester_params";
const PARAM_WIDGETS = [INDEX_WIDGET, SOURCE_WIDGET, "width", "label_height", "font_size", STATE_WIDGET];
const LIVE_TEXT_MAP_KEY = "__gjjModelEffectTesterLiveTextByNodeId";
const DEFAULT_STATE = {
	version: 1,
	filter: "",
	subdir: "",
	passed: [],
	failed: [],
	auto: true,
	skip: true,
	refresh: "",
};
const DEFAULT_PARAMS = {
	[INDEX_WIDGET]: 1,
	[SOURCE_WIDGET]: "diffusion_models",
	width: 1024,
	label_height: 96,
	font_size: 28,
	[STATE_WIDGET]: JSON.stringify(DEFAULT_STATE),
};

let cacheBySource = new Map();
let loadingBySource = new Map();
let activeRun = null;
let lastPromptId = null;
let autoQueueTimer = null;
let softFailedConsumerIds = new Set();

function cloneDefaultState() {
	return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function parseStringList(value) {
	const values = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/u);
	const result = [];
	for (const raw of values) {
		const item = String(raw || "").trim();
		if (item && !result.includes(item)) {
			result.push(item);
		}
	}
	return result;
}

function parseState(raw) {
	let parsed = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw || "{}");
		} catch (error) {
			parsed = {};
		}
	}
	const state = cloneDefaultState();
	if (parsed && typeof parsed === "object") {
		state.filter = String(parsed.filter || "");
		state.subdir = "";
		state.passed = parseStringList(parsed.passed);
		state.failed = parseStringList(parsed.failed);
		state.auto = parsed.auto !== false;
		state.skip = parsed.skip !== false;
		state.refresh = String(parsed.refresh || "");
	}
	return state;
}

function serializeState(state) {
	return JSON.stringify(parseState(state));
}

function looksLikeState(value) {
	try {
		const parsed = JSON.parse(String(value || ""));
		return Boolean(parsed && typeof parsed === "object" && (
			Object.prototype.hasOwnProperty.call(parsed, "filter")
			|| Object.prototype.hasOwnProperty.call(parsed, "subdir")
			|| Object.prototype.hasOwnProperty.call(parsed, "passed")
			|| Object.prototype.hasOwnProperty.call(parsed, "failed")
		));
	} catch (error) {
		return false;
	}
}

function intParam(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeParams(params) {
	const source = String(params?.[SOURCE_WIDGET] || DEFAULT_PARAMS[SOURCE_WIDGET]) === "checkpoints"
		? "checkpoints"
		: "diffusion_models";
	const stateText = looksLikeState(params?.[STATE_WIDGET])
		? String(params[STATE_WIDGET])
		: JSON.stringify(DEFAULT_STATE);
	return {
		[INDEX_WIDGET]: intParam(params?.[INDEX_WIDGET], DEFAULT_PARAMS[INDEX_WIDGET], 1, 0xFFFFFFFFFFFF),
		[SOURCE_WIDGET]: source,
		width: intParam(params?.width, DEFAULT_PARAMS.width, 64, 8192),
		label_height: intParam(params?.label_height, DEFAULT_PARAMS.label_height, 24, 512),
		font_size: intParam(params?.font_size, DEFAULT_PARAMS.font_size, 8, 160),
		[STATE_WIDGET]: serializeState(parseState(stateText)),
	};
}

function currentParams(node) {
	const params = {};
	for (const name of PARAM_WIDGETS) {
		if (name === STATE_WIDGET) {
			params[name] = serializeState(readState(node));
		} else {
			params[name] = findWidget(node, name)?.value ?? DEFAULT_PARAMS[name];
		}
	}
	return normalizeParams(params);
}

function paramsFromSerialized(serializedNode, node) {
	const fromProperties = serializedNode?.properties?.[PARAMS_PROPERTY];
	if (fromProperties && typeof fromProperties === "object") {
		return normalizeParams(fromProperties);
	}
	const raw = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	const stateText = raw.find((value) => looksLikeState(value))
		?? serializedNode?.properties?.[STATE_WIDGET]
		?? node?.properties?.[STATE_WIDGET]
		?? DEFAULT_PARAMS[STATE_WIDGET];
	const oldOrder = raw.length >= 7 && looksLikeState(raw[6]);
	return normalizeParams({
		[INDEX_WIDGET]: raw[0],
		[SOURCE_WIDGET]: raw[1],
		width: raw[2],
		label_height: oldOrder ? raw[4] : raw[3],
		font_size: oldOrder ? raw[5] : raw[4],
		[STATE_WIDGET]: stateText,
	});
}

function serializedParamValues(params) {
	const normalized = normalizeParams(params);
	return PARAM_WIDGETS.map((name) => normalized[name]);
}

function sanitizeSerializedNode(serializedNode, node) {
	if (!serializedNode) {
		return normalizeParams(DEFAULT_PARAMS);
	}
	const params = paramsFromSerialized(serializedNode, node);
	serializedNode.properties = serializedNode.properties || {};
	serializedNode.properties[PARAMS_PROPERTY] = { ...params };
	serializedNode.properties[STATE_WIDGET] = params[STATE_WIDGET];
	serializedNode.widgets_values = serializedParamValues(params);
	return params;
}

function applyParamsToWidgets(node, params) {
	const normalized = normalizeParams(params);
	for (const name of PARAM_WIDGETS) {
		const widget = findWidget(node, name);
		if (!widget) continue;
		widget.value = normalized[name];
	}
	node.properties = node.properties || {};
	node.properties[PARAMS_PROPERTY] = { ...normalized };
	node.properties[STATE_WIDGET] = normalized[STATE_WIDGET];
	node.__gjjModelEffectState = parseState(normalized[STATE_WIDGET]);
	refreshWidgetValues(node);
}

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function widgetValue(node, name) {
	return findWidget(node, name)?.value;
}

function refreshWidgetValues(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const params = currentParams(node);
	node.properties = node.properties || {};
	node.properties[PARAMS_PROPERTY] = { ...params };
	node.properties[STATE_WIDGET] = params[STATE_WIDGET];
	node.widgets_values = serializedParamValues(params);
}

function dirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) {
		return;
	}
	widget.value = value;
	node.properties = node.properties || {};
	node.properties[name] = value;
	refreshWidgetValues(node);
	dirty(node);
}

function readState(node) {
	if (!node.__gjjModelEffectState) {
		node.__gjjModelEffectState = parseState(
			node.properties?.[STATE_WIDGET] ?? findWidget(node, STATE_WIDGET)?.value ?? "",
		);
	}
	return node.__gjjModelEffectState;
}

function writeState(node, state = readState(node), bump = false) {
	const normalized = parseState(state);
	if (bump) {
		normalized.refresh = `${Date.now()}`;
	}
	node.__gjjModelEffectState = normalized;
	const text = serializeState(normalized);
	setWidgetValue(node, STATE_WIDGET, text);
	return normalized;
}

function currentIndex(node) {
	const value = Number(findWidget(node, INDEX_WIDGET)?.value ?? 1);
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function setCurrentIndex(node, value) {
	setWidgetValue(node, INDEX_WIDGET, Math.max(1, Math.floor(Number(value) || 1)));
}

function consumeDomEvent(event) {
	event.stopPropagation();
}

function hideWidget(widget, serialize, fallbackLabel = "") {
	if (!widget) {
		return;
	}
	widget.hidden = true;
	widget.serialize = serialize;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.y = -10000;
	widget.last_y = -10000;
	widget.label = fallbackLabel;
	widget.localized_name = fallbackLabel;
	widget.options = widget.options || {};
	widget.options.display_name = fallbackLabel;
	widget.options.hidden = true;
	widget.options.display = "hidden";
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const paramOrder = new Map(PARAM_WIDGETS.map((name, index) => [name, index]));
	const priority = (widget) => {
		const name = String(widget?.name || "");
		if (paramOrder.has(name)) return paramOrder.get(name);
		if (name === CONTROL_WIDGET) return 200;
		if (name === PANEL_WIDGET) return 201;
		return 100;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((a, b) => priority(a.widget) - priority(b.widget) || a.index - b.index)
		.map((entry) => entry.widget);
}

function compactNode(node) {
	const stateWidget = findWidget(node, STATE_WIDGET);
	if (stateWidget) {
		stateWidget.serialize = true;
		stateWidget.serializeValue = () => serializeState(readState(node));
		hideWidget(stateWidget, true, "测试状态");
	}
	reorderWidgets(node);
	refreshWidgetValues(node);
	dirty(node);
}

function normalizeKeyword(value) {
	return String(value || "").trim().toLowerCase().replaceAll("\\", "/");
}

function parseKeywordGroup(value) {
	return String(value || "")
		.split(/[,，、;；|]+/u)
		.map((item) => normalizeKeyword(item))
		.filter(Boolean);
}

function parseSearchExpression(value) {
	return String(value || "")
		.split(/[&+＋]/u)
		.map((part) => parseKeywordGroup(part))
		.filter((group) => group.length > 0);
}

function matchesSearch(text, expression) {
	if (!expression.length) {
		return true;
	}
	const lowered = normalizeKeyword(text);
	return expression.every((group) => group.some((keyword) => lowered.includes(keyword)));
}

function displayName(rawName) {
	return String(rawName || "").replace(/[\\/]+/gu, "\\");
}

function sourceValue(node) {
	const value = String(widgetValue(node, SOURCE_WIDGET) || "diffusion_models");
	return value === "checkpoints" ? "checkpoints" : "diffusion_models";
}

async function loadModels(source, force = false) {
	const key = source === "checkpoints" ? "checkpoints" : "diffusion_models";
	if (!force && cacheBySource.has(key)) {
		return cacheBySource.get(key);
	}
	if (loadingBySource.has(key) && !force) {
		return loadingBySource.get(key);
	}
	const promise = fetch(`${API_PATH}?source=${encodeURIComponent(key)}&t=${Date.now()}`, { cache: "no-store" })
		.then(async (response) => (response.ok ? response.json() : { models: [] }))
		.then((data) => {
			const payload = {
				models: Array.isArray(data?.models) ? data.models.map((item) => String(item || "").trim()).filter(Boolean) : [],
			};
			cacheBySource.set(key, payload);
			return payload;
		})
		.catch(() => ({ models: [] }))
		.finally(() => loadingBySource.delete(key));
	loadingBySource.set(key, promise);
	return promise;
}

function cachedPayload(node) {
	return cacheBySource.get(sourceValue(node)) || { models: [] };
}

function filteredModels(node, secondarySearch = "") {
	const state = readState(node);
	const query = [state.filter, secondarySearch].filter((item) => String(item || "").trim()).join("&");
	const expression = parseSearchExpression(query);
	return cachedPayload(node).models.filter((name) => matchesSearch(name, expression));
}

function comboItems(node) {
	const state = readState(node);
	const passed = new Set(state.passed);
	const failed = new Set(state.failed);
	return filteredModels(node).map((modelName) => {
		const mark = failed.has(modelName) ? FAIL_MARK : passed.has(modelName) ? PASS_MARK : "";
		return {
			key: modelName,
			modelName,
			nameLabel: displayName(modelName),
			label: `${mark}${displayName(modelName)}`,
		};
	});
}

function itemAtCurrentIndex(node) {
	const items = comboItems(node);
	const index = currentIndex(node);
	return index >= 1 && index <= items.length ? items[index - 1] : null;
}

function currentModelText(node) {
	return itemAtCurrentIndex(node)?.modelName || "";
}

function listText(node) {
	return comboItems(node).map((item) => item.label).join("\n");
}

function outputText(node, outputIndex) {
	if (outputIndex === OUTPUT_MODEL) {
		return currentModelText(node);
	}
	if (outputIndex === OUTPUT_LIST) {
		return listText(node);
	}
	return "";
}

function liveTextMap() {
	globalThis[LIVE_TEXT_MAP_KEY] = globalThis[LIVE_TEXT_MAP_KEY] || {};
	return globalThis[LIVE_TEXT_MAP_KEY];
}

function publishLiveText(node, outputIndex) {
	const text = outputText(node, outputIndex);
	node.__gjjModelEffectLiveTexts = node.__gjjModelEffectLiveTexts || {};
	node.__gjjModelEffectLiveTexts[String(outputIndex)] = text;
	node.__gjjLastOutputValues = node.__gjjLastOutputValues || {};
	node.__gjjLastOutputValues[Number(outputIndex)] = text;
	const all = liveTextMap();
	all[String(node.id)] = all[String(node.id)] || {};
	all[String(node.id)][String(outputIndex)] = text;
	return text;
}

function escapeHtml(text) {
	return String(text || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("\"", "&quot;")
		.replaceAll("'", "&#39;");
}

function previewHtml(text) {
	const lines = String(text || "").split(/\r?\n/u);
	return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("") || "<p></p>";
}

function resultCounts(node) {
	const state = readState(node);
	const allowed = new Set(comboItems(node).map((item) => item.key));
	const passed = state.passed.filter((key) => allowed.has(key)).length;
	const failed = state.failed.filter((key) => allowed.has(key)).length;
	return { passed, failed };
}

function shortStatus(text) {
	const value = String(text || "").trim();
	if (!value) {
		return "等待";
	}
	if (value.includes("生成节点完成") || value.includes("执行完成")) {
		return "已完成";
	}
	if (value.includes("执行出错") || value.includes("失败")) {
		return "出错";
	}
	if (value.includes("已刷新")) {
		return "已刷新";
	}
	if (value.includes("过滤")) {
		return "已过滤";
	}
	if (value.includes("已提交")) {
		return "执行中";
	}
	if (value.includes("已到末尾")) {
		return "末尾";
	}
	if (value.includes("等待执行")) {
		return "等待";
	}
	return value.length > 8 ? `${value.slice(0, 8)}...` : value;
}

function summaryText(node) {
	const total = comboItems(node).length;
	const index = total ? Math.min(currentIndex(node), total) : 0;
	const counts = resultCounts(node);
	const status = node.properties?.gjj_model_effect_tester_status || "等待执行";
	return `🔢 ${index}/${total} ✅ ${counts.passed} ❌ ${counts.failed} · ${shortStatus(status)}`;
}

function summaryTooltip(node) {
	const total = comboItems(node).length;
	const index = total ? Math.min(currentIndex(node), total) : 0;
	const counts = resultCounts(node);
	const item = itemAtCurrentIndex(node);
	const lines = [
		`过滤结果 ${total} 个，当前第 ${index} 个`,
		`测试状态：✅ ${counts.passed} / ❌ ${counts.failed}`,
		`当前模型：${item?.nameLabel || "无"}`,
		`详细状态：${node.properties?.gjj_model_effect_tester_status || "等待执行"}`,
	];
	return lines.join("\n");
}

function renderPanel(node) {
	const panel = node.__gjjModelEffectPanel;
	if (!panel) {
		return;
	}
	const state = readState(node);
	const items = comboItems(node);
	const item = itemAtCurrentIndex(node);
	const controls = node.__gjjModelEffectControlsWrap;
	const filter = panel.querySelector(".filter");
	const picker = panel.querySelector(".picker");
	const summary = panel.querySelector(".summary");
	const auto = controls?.querySelector(".auto");
	const skip = controls?.querySelector(".skip");
	if (filter && filter.value !== state.filter) {
		filter.value = state.filter;
	}
	if (picker) {
		picker.textContent = item?.label || (items.length ? "已到末尾" : "未匹配到模型");
		picker.title = item?.modelName || "";
	}
	if (summary) {
		const tip = summaryTooltip(node);
		summary.textContent = summaryText(node);
		summary.title = tip;
		summary.dataset.tip = tip;
	}
	if (auto) {
		auto.classList.toggle("on", state.auto);
		auto.textContent = state.auto ? "自动执行 开" : "自动执行 关";
	}
	if (skip) {
		skip.classList.toggle("on", state.skip);
		skip.textContent = state.skip ? "出错跳过 开" : "出错跳过 关";
	}
}

function markResult(node, key, passed) {
	if (!key) {
		return;
	}
	const state = readState(node);
	state.passed = state.passed.filter((item) => item !== key);
	state.failed = state.failed.filter((item) => item !== key);
	if (passed) {
		state.passed.push(key);
	} else {
		state.failed.push(key);
	}
	writeState(node, state, true);
	renderPanel(node);
	pushLivePreviews(node);
}

function resetPool(node, statusText) {
	const state = readState(node);
	state.passed = [];
	state.failed = [];
	writeState(node, state, true);
	setCurrentIndex(node, 1);
	setStatus(node, statusText || "测试池已重置");
	renderPanel(node);
	pushLivePreviews(node);
}

function makeButton(label, title, onclick) {
	const button = document.createElement("button");
	button.textContent = label;
	button.title = title;
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onclick();
	});
	return button;
}

function ensureStyles(panel) {
	if (panel.__gjjModelEffectStyleReady) {
		return;
	}
	panel.__gjjModelEffectStyleReady = true;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-model-effect{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:7px;padding:0 2px;color:#d7e2ea;font:12px/1.35 sans-serif}
		.gjj-model-effect-control{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;padding:0 2px}
		.gjj-model-effect-control .row{display:flex;gap:6px;width:100%}
		.gjj-model-effect-control button{flex:1;background:#20323a;border:1px solid #3b5560;border-radius:5px;color:#edf6fa;padding:5px 8px;font:700 12px sans-serif;cursor:pointer}
		.gjj-model-effect-control button.on{background:#1f6b43;border-color:#48ad73;color:#fff}
		.gjj-model-effect .row{display:flex;gap:6px;width:100%;align-items:center}
		.gjj-model-effect .filter-icon{flex:0 0 auto;color:#b7c7d1;font-size:13px;line-height:1}
		.gjj-model-effect input{min-width:0;flex:1;background:#10191e;border:1px solid #334852;border-radius:6px;color:#d7e2ea;padding:5px 7px;font:12px sans-serif}
		.gjj-model-effect button{background:#1c2b31;border:1px solid #3a535d;border-radius:6px;color:#edf6fa;padding:5px 8px;font:700 12px sans-serif;cursor:pointer}
		.gjj-model-effect button.on{background:#1f6b43;border-color:#48ad73;color:#fff}
		.gjj-model-effect .picker{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
		.gjj-model-effect .summary{position:relative;border:1px solid #28424d;background:#10191e;border-radius:6px;padding:6px 8px;min-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-model-effect .summary:hover::after{content:attr(data-tip);position:absolute;left:6px;right:6px;top:calc(100% + 5px);z-index:10001;white-space:pre-wrap;background:#251016;border:1px solid #d94a62;color:#ff8ba0;border-radius:6px;padding:7px 8px;box-shadow:0 8px 20px rgba(0,0,0,.45);font:12px/1.35 sans-serif}
		.gjj-model-effect-popup{position:fixed;z-index:10000;background:#10191e;border:1px solid #6e8791;border-radius:8px;padding:8px;box-shadow:0 10px 28px rgba(0,0,0,.45);color:#edf6fa}
		.gjj-model-effect-popup input{box-sizing:border-box;width:100%;background:#0b1216;border:1px solid #dce7ec;border-radius:6px;color:#fff;padding:6px 8px;margin-bottom:8px}
		.gjj-model-effect-popup .list{display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto}
		.gjj-model-effect-popup button{background:#14242a;border:1px solid #344c55;border-radius:6px;color:#edf6fa;text-align:left;padding:7px 9px;cursor:pointer}
		.gjj-model-effect-popup button:hover{background:#174832;border-color:#4faa75}
	`;
	panel.appendChild(style);
}

function clearPopup() {
	globalThis.__gjjModelEffectPopup?.remove?.();
	globalThis.__gjjModelEffectPopup = null;
}

function openPicker(node, anchor) {
	clearPopup();
	const popup = document.createElement("div");
	popup.className = "gjj-model-effect-popup";
	popup.innerHTML = "<input placeholder=\"二次搜索\"><div class=\"list\"></div>";
	document.body.appendChild(popup);
	globalThis.__gjjModelEffectPopup = popup;

	const rect = anchor.getBoundingClientRect();
	popup.style.left = `${Math.max(8, rect.left)}px`;
	popup.style.top = `${Math.min(window.innerHeight - 320, rect.bottom + 6)}px`;
	popup.style.minWidth = `${Math.max(260, rect.width)}px`;
	const input = popup.querySelector("input");
	const list = popup.querySelector(".list");
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		popup.addEventListener(eventName, consumeDomEvent);
	}
	popup.addEventListener("wheel", consumeDomEvent, { passive: true });

	const render = () => {
		const selected = itemAtCurrentIndex(node)?.modelName || "";
		list.textContent = "";
		for (const modelName of filteredModels(node, input.value)) {
			const row = document.createElement("button");
			row.type = "button";
			row.textContent = `${modelName === selected ? "✓ " : ""}${displayName(modelName)}`;
			row.title = modelName;
			row.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const index = comboItems(node).findIndex((item) => item.modelName === modelName);
				if (index >= 0) {
					setCurrentIndex(node, index + 1);
					setStatus(node, `已选择：${displayName(modelName)}`);
					renderPanel(node);
					pushLivePreviews(node);
				}
				clearPopup();
			});
			list.appendChild(row);
		}
	};
	input.addEventListener("input", render);
	setTimeout(() => input.focus(), 0);
	render();
	setTimeout(() => {
		const close = (event) => {
			if (!popup.contains(event.target) && event.target !== anchor) {
				clearPopup();
				document.removeEventListener("pointerdown", close, true);
			}
		};
		document.addEventListener("pointerdown", close, true);
	}, 0);
}

function setupControls(node) {
	if (node.__gjjModelEffectControls) {
		return;
	}
	const wrap = document.createElement("div");
	wrap.className = "gjj-model-effect-control";
	wrap.innerHTML = `
		<div class="row"><button class="reset" type="button">初始化序号</button><button class="stop" type="button">停止自动测试</button></div>
		<div class="row"><button class="auto" type="button"></button><button class="skip" type="button"></button></div>
	`;
	ensureStyles(wrap);
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		wrap.addEventListener(eventName, consumeDomEvent);
	}
	wrap.querySelector(".reset").addEventListener("click", (event) => {
		event.preventDefault();
		setCurrentIndex(node, 1);
		setStatus(node, "已初始化当前序号为 1");
		renderPanel(node);
		pushLivePreviews(node);
	});
	wrap.querySelector(".stop").addEventListener("click", (event) => {
		event.preventDefault();
		clearTimeout(autoQueueTimer);
		autoQueueTimer = null;
		const state = readState(node);
		state.auto = false;
		writeState(node, state, true);
		setStatus(node, "自动测试已手动停止");
		renderPanel(node);
	});
	wrap.querySelector(".auto").addEventListener("click", () => {
		const state = readState(node);
		state.auto = !state.auto;
		writeState(node, state, true);
		setStatus(node, state.auto ? "自动执行已开启" : "自动执行已关闭");
		renderPanel(node);
		pushLivePreviews(node);
	});
	wrap.querySelector(".skip").addEventListener("click", () => {
		const state = readState(node);
		state.skip = !state.skip;
		writeState(node, state, true);
		setStatus(node, state.skip ? "出错跳过已开启" : "出错跳过已关闭");
		renderPanel(node);
		pushLivePreviews(node);
	});
	node.__gjjModelEffectControlsWrap = wrap;
	node.__gjjModelEffectControls = node.addDOMWidget(CONTROL_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
	});
	renderPanel(node);
}

function buildPanel(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-model-effect";
	ensureStyles(wrap);

	const filterRow = document.createElement("div");
	filterRow.className = "row";
	const icon = document.createElement("span");
	icon.className = "filter-icon";
	icon.title = "过滤搜索";
	icon.textContent = "🔍";
	filterRow.appendChild(icon);
	const filter = document.createElement("input");
	filter.className = "filter";
	filter.placeholder = "关键词过滤：qwen&edit 或 flux,sdxl";
	filter.value = readState(node).filter || "";
	filter.addEventListener("input", () => {
		const state = readState(node);
		state.filter = filter.value;
		state.passed = [];
		state.failed = [];
		writeState(node, state, true);
		setCurrentIndex(node, 1);
		setStatus(node, state.filter ? "过滤条件已更新，已重置测试池" : "已清空过滤条件，已重置测试池");
		renderPanel(node);
		pushLivePreviews(node);
	});
	filterRow.appendChild(filter);
	filterRow.appendChild(makeButton("刷新列表", "重新扫描当前模型来源", async () => {
		setStatus(node, "正在刷新模型列表...");
		await loadModels(sourceValue(node), true);
		resetPool(node, `已刷新模型列表：${cachedPayload(node).models.length} 个`);
	}));
	wrap.appendChild(filterRow);

	const picker = document.createElement("button");
	picker.className = "picker";
	picker.type = "button";
	picker.addEventListener("click", (event) => {
		event.preventDefault();
		openPicker(node, picker);
	});
	wrap.appendChild(picker);

	const summary = document.createElement("div");
	summary.className = "summary";
	wrap.appendChild(summary);

	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		wrap.addEventListener(eventName, consumeDomEvent);
	}
	wrap.addEventListener("wheel", consumeDomEvent, { passive: true });
	return wrap;
}

async function setupNode(node) {
	if (node.__gjjModelEffectReady) {
		return;
	}
	node.__gjjModelEffectReady = true;
	compactNode(node);
	setupControls(node);
	node.__gjjModelEffectPanel = buildPanel(node);
	node.addDOMWidget(PANEL_WIDGET, "HTML", node.__gjjModelEffectPanel, {
		serialize: false,
		hideOnZoom: false,
	});
	await loadModels(sourceValue(node));
	renderPanel(node);
	pushLivePreviews(node);

	const sourceWidget = findWidget(node, SOURCE_WIDGET);
	if (sourceWidget && !sourceWidget.__gjjModelEffectHooked) {
		sourceWidget.__gjjModelEffectHooked = true;
		const original = sourceWidget.callback;
		sourceWidget.callback = function (value, ...args) {
			const result = original?.call(this, value, ...args);
			loadModels(String(value || "diffusion_models"), true).then(() => {
				setCurrentIndex(node, 1);
				renderPanel(node);
				pushLivePreviews(node);
			});
			return result;
		};
	}
}

function outputLinks(node, outputIndex) {
	const links = node?.outputs?.[outputIndex]?.links;
	if (!Array.isArray(links)) {
		return [];
	}
	return links.map((linkId) => app.graph?.links?.[linkId]).filter(Boolean);
}

function linkedNodes(node, outputIndex) {
	return outputLinks(node, outputIndex)
		.map((link) => app.graph?.getNodeById?.(link.target_id))
		.filter(Boolean);
}

function isPreviewNode(node) {
	const cls = String(node?.comfyClass || node?.type || "");
	return cls === "GJJ_AnyPreview" || cls.includes("AnyPreview") || Boolean(node?.__gjjAnyPreviewContainer);
}

function updatePreviewNode(previewNode, text, sourceNode, outputIndex) {
	if (!isPreviewNode(previewNode)) {
		return;
	}
	previewNode.__gjjModelEffectLiveText = text;
	previewNode.__gjjModelEffectLiveSourceId = sourceNode?.id;
	previewNode.__gjjModelEffectLiveOutputIndex = outputIndex;
	previewNode.__gjjAnyPreviewKind = "text";
	previewNode.__gjjAnyPreviewText = text;
	previewNode.__gjjAnyPreviewImages = [];
	previewNode.imgs = [];
	previewNode.images = [];
	previewNode.preview = null;
	if (previewNode.__gjjAnyPreviewBody) {
		previewNode.__gjjAnyPreviewBody.style.display = "block";
		previewNode.__gjjAnyPreviewBody.innerHTML = previewHtml(text);
	}
	if (previewNode.__gjjAnyPreviewEmpty) {
		previewNode.__gjjAnyPreviewEmpty.style.display = "none";
	}
	if (previewNode.__gjjAnyPreviewGrid) {
		previewNode.__gjjAnyPreviewGrid.style.display = "none";
	}
	dirty(previewNode);
}

function syncLinkedLazyStudio(node, text) {
	for (const link of outputLinks(node, OUTPUT_MODEL)) {
		const target = app.graph?.getNodeById?.(link.target_id);
		if (!target || String(target.comfyClass || target.type || "") !== "GJJ_LazyImageStudio") {
			continue;
		}
		const input = target.inputs?.[link.target_slot];
		const widgetName = String(input?.widget?.name || input?.name || "");
		if (widgetName !== "unet_name") {
			continue;
		}
		const widget = target.widgets?.find((item) => item?.name === "unet_name");
		if (widget && String(text || "").trim()) {
			const nextValue = String(text);
			const changed = String(widget.value || "") !== nextValue;
			widget.value = nextValue;
			target.properties = target.properties || {};
			target.properties.unet_name = nextValue;
			if (changed && typeof widget.callback === "function") {
				try {
					widget.callback.call(widget, nextValue, target, widget);
				} catch (error) {
					console.warn("[GJJ_ModelEffectTester] LazyImageStudio preset sync failed:", error);
				}
			}
			target.setDirtyCanvas?.(true, true);
		}
	}
}

function pushLivePreviews(node) {
	for (const outputIndex of [OUTPUT_MODEL, OUTPUT_LIST]) {
		const text = publishLiveText(node, outputIndex);
		if (outputIndex === OUTPUT_MODEL) {
			syncLinkedLazyStudio(node, text);
		}
		for (const target of linkedNodes(node, outputIndex)) {
			updatePreviewNode(target, text, node, outputIndex);
		}
	}
	dirty(node);
}

function modelConsumerIds(node) {
	const ids = new Set();
	for (const link of outputLinks(node, OUTPUT_MODEL)) {
		const target = app.graph?.getNodeById?.(link.target_id);
		if (target) {
			ids.add(String(target.id));
		}
	}
	return [...ids];
}

function eventPromptId(event) {
	return event?.detail?.prompt_id || null;
}

function eventNodeId(event) {
	return String(
		event?.detail?.node_id
		?? event?.detail?.node
		?? event?.detail?.display_node
		?? event?.detail?.nodeId
		?? "",
	);
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !(promptId && lastPromptId && promptId !== lastPromptId);
}

function isCurrentConsumer(run, nodeId) {
	return Boolean(run && nodeId && run.consumerIds.map(String).includes(String(nodeId)));
}

function setStatus(node, text) {
	node.properties = node.properties || {};
	node.properties.gjj_model_effect_tester_status = String(text || "");
	const panel = node.__gjjModelEffectPanel;
	const summary = panel?.querySelector(".summary");
	if (summary) {
		const tip = summaryTooltip(node);
		summary.textContent = summaryText(node);
		summary.title = tip;
		summary.dataset.tip = tip;
	}
	dirty(node);
}

function queueNextIfNeeded(run, passed, reason) {
	const node = run?.node;
	if (!node || run.finished) {
		return;
	}
	run.finished = true;
	markResult(node, run.key, passed);
	const state = readState(node);
	const total = Math.max(0, Number(run.totalCount || comboItems(node).length) || 0);
	const next = Number(run.currentIndex || 0) + 1;
	if (total <= 0) {
		setStatus(node, `${reason}，没有可执行项`);
		return;
	}
	if (next > total) {
		setCurrentIndex(node, total);
		setStatus(node, `${reason}，已到末尾：${total} / ${total}`);
		renderPanel(node);
		pushLivePreviews(node);
		return;
	}
	setCurrentIndex(node, next);
	renderPanel(node);
	pushLivePreviews(node);
	if (!state.auto) {
		setStatus(node, `${reason}，下一项 ${next} / ${total}`);
		return;
	}
	if (!passed && !state.skip) {
		setStatus(node, `${reason}，已停止`);
		return;
	}
	setStatus(node, `${reason}，下一项 ${next} / ${total}，${QUEUE_DELAY_MS}ms 后继续`);
	clearTimeout(autoQueueTimer);
	autoQueueTimer = setTimeout(async () => {
		autoQueueTimer = null;
		try {
			await app.queuePrompt(0);
		} catch (error) {
			setStatus(node, `自动排队失败：${error?.message || error}`);
		}
	}, QUEUE_DELAY_MS);
}

function runFromBackend(node, data = {}) {
	const key = String(data.current_key || "");
	return {
		node,
		promptId: lastPromptId,
		currentIndex: Number(data.current_index || currentIndex(node)) || 1,
		totalCount: Number(data.total_count || comboItems(node).length) || 0,
		key,
		label: String(data.current_name || displayName(key)),
		consumerIds: modelConsumerIds(node),
		consumerSucceeded: false,
		softFailed: false,
		finished: false,
	};
}

function activeTesterNodes() {
	return (app.graph?._nodes || []).filter((item) => item?.comfyClass === NODE_NAME);
}

function runFromCurrentPanel(node) {
	const item = itemAtCurrentIndex(node);
	return {
		node,
		promptId: lastPromptId,
		currentIndex: currentIndex(node),
		totalCount: comboItems(node).length,
		key: item?.key || "",
		label: item?.nameLabel || "",
		consumerIds: modelConsumerIds(node),
		consumerSucceeded: false,
		softFailed: false,
		finished: false,
	};
}

function fallbackRunForError(nodeId) {
	for (const node of activeTesterNodes()) {
		const run = runFromCurrentPanel(node);
		if (!run.key) {
			continue;
		}
		if (!nodeId || isCurrentConsumer(run, nodeId)) {
			return run;
		}
	}
	return null;
}

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
	activeRun = null;
	softFailedConsumerIds = new Set();
	clearTimeout(autoQueueTimer);
	autoQueueTimer = null;
	for (const node of activeTesterNodes()) {
		setStatus(node, "已提交执行，等待模型测试节点返回当前项");
	}
});

api.addEventListener("executed", (event) => {
	if (!samePrompt(event) || !activeRun) {
		return;
	}
	const nodeId = eventNodeId(event);
	if (isCurrentConsumer(activeRun, nodeId)) {
		activeRun.consumerSucceeded = true;
		if (softFailedConsumerIds.has(String(nodeId))) {
			activeRun.softFailed = true;
		}
		setStatus(activeRun.node, `生成节点完成：${activeRun.label}`);
	}
});

api.addEventListener("gjj_lazy_image_studio_soft_error", (event) => {
	const nodeId = eventNodeId(event);
	if (nodeId) {
		softFailedConsumerIds.add(String(nodeId));
	}
	const run = activeRun || fallbackRunForError(nodeId);
	if (!run) {
		return;
	}
	run.softFailed = true;
	activeRun = run;
	const message = detailText(event?.detail) || "LazyImageStudio 测试软失败";
	setStatus(run.node, `标记失败：${message}`);
});

api.addEventListener("execution_success", (event) => {
	if (!samePrompt(event) || !activeRun) {
		activeRun = null;
		return;
	}
	if (activeRun.softFailed) {
		queueNextIfNeeded(activeRun, false, "执行失败，已跳过");
	} else if (activeRun.consumerSucceeded) {
		queueNextIfNeeded(activeRun, true, "执行完成");
	} else if (!activeRun.consumerIds.length) {
		setStatus(activeRun.node, "当前模型已输出，但未连接生成节点");
	} else {
		setStatus(activeRun.node, "流程完成，但目标生成节点没有返回成功事件");
	}
	activeRun = null;
});

api.addEventListener("execution_error", (event) => {
	if (!samePrompt(event)) {
		activeRun = null;
		return;
	}
	const nodeId = eventNodeId(event);
	const run = activeRun || fallbackRunForError(nodeId);
	if (!run) {
		activeRun = null;
		return;
	}
	if (run.consumerSucceeded) {
		queueNextIfNeeded(run, true, "生成已成功，后续节点出错");
	} else if (!nodeId || isCurrentConsumer(run, nodeId)) {
		queueNextIfNeeded(run, false, "执行出错");
	} else {
		setStatus(run.node, "非当前模型生成节点出错，未标记当前项");
	}
	activeRun = null;
});

api.addEventListener("execution_interrupted", () => {
	if (activeRun?.node) {
		setStatus(activeRun.node, "执行被中断，自动测试已停止");
	}
	activeRun = null;
	clearTimeout(autoQueueTimer);
	autoQueueTimer = null;
});

app.registerExtension({
	name: "Comfy.GJJ.ModelEffectTester",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) {
			return;
		}
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			const params = normalizeParams({
				[INDEX_WIDGET]: findWidget(this, INDEX_WIDGET)?.value,
				[SOURCE_WIDGET]: findWidget(this, SOURCE_WIDGET)?.value,
				width: findWidget(this, "width")?.value,
				label_height: findWidget(this, "label_height")?.value,
				font_size: findWidget(this, "font_size")?.value,
				[STATE_WIDGET]: this.properties?.[STATE_WIDGET] ?? findWidget(this, STATE_WIDGET)?.value ?? "",
			});
			applyParamsToWidgets(this, params);
			setTimeout(() => void setupNode(this), 0);
			return result;
		};
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const params = sanitizeSerializedNode(serializedNode, this);
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			applyParamsToWidgets(this, params);
			setTimeout(() => {
				applyParamsToWidgets(this, params);
				void setupNode(this);
			}, 0);
			return result;
		};
		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.gjj_model_effect_tester) ? message.gjj_model_effect_tester[0] : null;
			if (data) {
				activeRun = runFromBackend(this, data);
				setStatus(this, data.status || `当前项：${activeRun.label}`);
				renderPanel(this);
				pushLivePreviews(this);
			}
			return result;
		};
		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			const params = currentParams(this);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[PARAMS_PROPERTY] = { ...params };
			serializedNode.properties[STATE_WIDGET] = params[STATE_WIDGET];
			serializedNode.widgets_values = serializedParamValues(params);
			this.widgets_values = serializedNode.widgets_values.slice();
			return result;
		};
	},
});

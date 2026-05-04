import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "GJJ_LoraEffectTester";
const UI_KEY = "gjj_lora_effect_tester";
const STATE_WIDGET = "test_state";
const INDEX_WIDGET = "current_index";
const PANEL_WIDGET = "gjj_lora_effect_tester_panel";
const CONTROL_WIDGET = "gjj_lora_effect_tester_controls";
const LIVE_TEXT_MAP_KEY = "__gjjLoraEffectTesterLiveTextByNodeId";
const LORA_API_PATH = "/gjj/loras";
const QUEUE_DELAY_MS = 800;
const PASS_MARK = "✅ ";
const FAIL_MARK = "❌ ";
const OUTPUT_CONFIG = 0;
const OUTPUT_NAME = 1;
const OUTPUT_LIST = 2;
const OUTPUT_TOTAL = 3;
const STRENGTH_CHOICES = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5];
const DEFAULT_STATE = {
	version: 2,
	filter: "",
	strengths: [1],
	passed: [],
	failed: [],
	auto: true,
	skip: true,
	refresh: "",
};
const OBSOLETE_WIDGETS = new Set([
	"auto_execute",
	"skip_errors",
	"filter_keywords",
	"strength_values",
	"failed_items",
	"passed_items",
	"refresh_token",
	"strength",
]);

let loraOptions = [];
let loraLoadPromise = null;
let queuePatched = false;
let graphPromptPatched = false;
let patchRetryCount = 0;
let activeRun = null;
let lastPromptId = null;
let autoQueueTimer = null;

function cloneDefaultState() {
	return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function asBool(value, fallback) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		if (["false", "0", "off", "no", "关"].includes(lowered)) {
			return false;
		}
		if (["true", "1", "on", "yes", "开"].includes(lowered)) {
			return true;
		}
	}
	return Boolean(value);
}

function formatStrength(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed.toFixed(1) : "1.0";
}

function parseStrengths(value) {
	const values = Array.isArray(value) ? value : String(value || "").split(/[,，、;；|\s]+/u);
	const result = [];
	for (const raw of values) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && !result.some((old) => Math.abs(old - parsed) < 1e-6)) {
			result.push(parsed);
		}
	}
	return result.length ? result.sort((a, b) => a - b) : [1];
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
		state.strengths = parseStrengths(parsed.strengths);
		state.passed = parseStringList(parsed.passed);
		state.failed = parseStringList(parsed.failed);
		state.auto = asBool(parsed.auto, true);
		state.skip = asBool(parsed.skip, true);
		state.refresh = String(parsed.refresh || "");
	}
	return state;
}

function serializeState(state) {
	return JSON.stringify(parseState(state));
}

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function widgetValue(node, widget, index) {
	if (!widget) {
		return undefined;
	}
	if (typeof widget.serializeValue === "function") {
		try {
			return widget.serializeValue(node, index);
		} catch (error) {
			return widget.value;
		}
	}
	return widget.value;
}

function refreshWidgetValues(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	node.widgets_values = node.widgets
		.filter((widget) => widget?.serialize !== false)
		.map((widget, index) => widgetValue(node, widget, index));
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
	if (!node.__gjjLoraEffectState) {
		node.__gjjLoraEffectState = parseState(
			node.properties?.[STATE_WIDGET] ?? findWidget(node, STATE_WIDGET)?.value ?? "",
		);
	}
	return node.__gjjLoraEffectState;
}

function writeState(node, state = readState(node), bump = false) {
	const normalized = parseState(state);
	if (bump) {
		normalized.refresh = `${Date.now()}`;
	}
	node.__gjjLoraEffectState = normalized;
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

function hideWidget(widget, serialize, fallbackLabel = "") {
	if (!widget) {
		return;
	}
	widget.__gjjLoraEffectHidden = true;
	widget.hidden = true;
	widget.serialize = serialize;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
	widget.label = fallbackLabel;
	widget.localized_name = fallbackLabel;
	widget.options = widget.options || {};
	widget.options.display_name = fallbackLabel;
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
}

function hideStateWidget(node) {
	const widget = findWidget(node, STATE_WIDGET);
	if (!widget) {
		return;
	}
	widget.label = "测试状态";
	widget.localized_name = "测试状态";
	widget.options = widget.options || {};
	widget.options.display_name = "测试状态";
	widget.options.tooltip = "前端面板维护的 JSON 状态；正常情况下会隐藏。";
	widget.serialize = true;
	widget.serializeValue = () => serializeState(readState(node));
	hideWidget(widget, true, "测试状态");
}

function removeHiddenInputSockets(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	const hiddenNames = new Set([STATE_WIDGET, ...OBSOLETE_WIDGETS]);
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const type = String(input?.type || "");
		const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
		if (!hiddenNames.has(name) && !hiddenNames.has(converted)) {
			continue;
		}
		try {
			node.disconnectInput?.(index);
		} catch (error) {
			// Best effort cleanup for old converted widgets.
		}
		if (typeof node.removeInput === "function") {
			node.removeInput(index);
		} else {
			node.inputs.splice(index, 1);
		}
	}
}

function compactNode(node) {
	for (const name of OBSOLETE_WIDGETS) {
		hideWidget(findWidget(node, name), false, "");
	}
	hideStateWidget(node);
	removeHiddenInputSockets(node);
	reorderWidgets(node);
	refreshWidgetValues(node);
	dirty(node);
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const priority = (widget) => {
		const name = String(widget?.name || "");
		if (name === CONTROL_WIDGET) {
			return 10;
		}
		if (name === PANEL_WIDGET) {
			return 20;
		}
		if (name === STATE_WIDGET) {
			return 90;
		}
		if (OBSOLETE_WIDGETS.has(name)) {
			return 95;
		}
		return 50;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((a, b) => priority(a.widget) - priority(b.widget) || a.index - b.index)
		.map((entry) => entry.widget);
}

function normalizeKeyword(value) {
	return String(value || "").trim().toLowerCase();
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
	return String(rawName || "")
		.replace(/\.[^/\\.\s]+$/u, "")
		.replace(/[\\/]+/gu, "_");
}

function comboKey(rawName, strength) {
	return `${rawName}::${formatStrength(strength)}`;
}

function normalizeLoraName(rawName) {
	return String(rawName || "").replace(/[\\/]+/gu, "\\").toLowerCase();
}

function getRawLoraOptions() {
	return loraOptions.filter((item) => item && item.value);
}

async function loadLoras(force = false) {
	if (!force && getRawLoraOptions().length) {
		return loraOptions;
	}
	if (loraLoadPromise && !force) {
		return loraLoadPromise;
	}
	loraLoadPromise = fetch(`${LORA_API_PATH}?t=${Date.now()}`, { cache: "no-store" })
		.then(async (response) => (response.ok ? response.json() : { loras: [] }))
		.then((data) => {
			const seen = new Set();
			const next = [];
			for (const raw of Array.isArray(data?.loras) ? data.loras : []) {
				const value = String(raw || "").trim();
				if (!value || seen.has(value)) {
					continue;
				}
				seen.add(value);
				next.push({ value, label: value });
			}
			loraOptions = next;
			return loraOptions;
		})
		.catch(() => {
			loraOptions = [];
			return loraOptions;
		})
		.finally(() => {
			loraLoadPromise = null;
		});
	return loraLoadPromise;
}

function filteredLoras(node, secondarySearch = "") {
	const state = readState(node);
	const query = [state.filter, secondarySearch].filter((item) => String(item || "").trim()).join("&");
	const expression = parseSearchExpression(query);
	return getRawLoraOptions().filter((option) => matchesSearch(option.value, expression));
}

function comboItems(node) {
	const state = readState(node);
	const passed = new Set(state.passed);
	const failed = new Set(state.failed);
	return filteredLoras(node).flatMap((option) => state.strengths.map((strength) => {
		const key = comboKey(option.value, strength);
		const mark = failed.has(key) ? FAIL_MARK : passed.has(key) ? PASS_MARK : "";
		return {
			key,
			loraName: option.value,
			strength,
			nameLabel: `(${formatStrength(strength)})${displayName(option.value)}`,
			label: `${mark}(${formatStrength(strength)})${displayName(option.value)}`,
		};
	}));
}

function itemAtCurrentIndex(node) {
	const items = comboItems(node);
	const index = currentIndex(node);
	return index >= 1 && index <= items.length ? items[index - 1] : null;
}

function configText(node) {
	const item = itemAtCurrentIndex(node);
	if (!item) {
		return "[]";
	}
	return JSON.stringify([{ enabled: true, name: item.loraName, strength: Number(item.strength) || 1 }]);
}

function nameText(node) {
	return itemAtCurrentIndex(node)?.nameLabel || "";
}

function listText(node) {
	return comboItems(node).map((item) => item.label).join("\n");
}

function totalText(node) {
	return String(comboItems(node).length);
}

function outputText(node, outputIndex) {
	if (outputIndex === OUTPUT_CONFIG) {
		return configText(node);
	}
	if (outputIndex === OUTPUT_NAME) {
		return nameText(node);
	}
	if (outputIndex === OUTPUT_LIST) {
		return listText(node);
	}
	if (outputIndex === OUTPUT_TOTAL) {
		return totalText(node);
	}
	return "";
}

function liveTextMap() {
	globalThis[LIVE_TEXT_MAP_KEY] = globalThis[LIVE_TEXT_MAP_KEY] || {};
	return globalThis[LIVE_TEXT_MAP_KEY];
}

function publishLiveText(node, outputIndex) {
	const text = outputText(node, outputIndex);
	node.__gjjLoraEffectLiveTexts = node.__gjjLoraEffectLiveTexts || {};
	node.__gjjLoraEffectLiveTexts[String(outputIndex)] = text;
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
	previewNode.__gjjLoraEffectLiveText = text;
	previewNode.__gjjLoraEffectLiveSourceId = sourceNode?.id;
	previewNode.__gjjLoraEffectLiveOutputIndex = outputIndex;
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

function pushLivePreviews(node) {
	for (const outputIndex of [OUTPUT_CONFIG, OUTPUT_NAME, OUTPUT_LIST, OUTPUT_TOTAL]) {
		const text = publishLiveText(node, outputIndex);
		for (const target of linkedNodes(node, outputIndex)) {
			updatePreviewNode(target, text, node, outputIndex);
		}
	}
	dirty(node);
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
	if (value.includes("LoRA 已应用")) {
		return "已应用";
	}
	if (value.includes("生成节点完成")) {
		return "已完成";
	}
	if (value.includes("执行出错") || value.includes("应用失败")) {
		return "出错";
	}
	if (value.includes("已刷新")) {
		return "已刷新";
	}
	if (value.includes("过滤条件")) {
		return "已过滤";
	}
	if (value.includes("强度队列")) {
		return "强度";
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
	const status = node.properties?.gjj_lora_effect_tester_status || "等待执行";
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
		`当前 LoRA：${item?.nameLabel || "无"}`,
		`详细状态：${node.properties?.gjj_lora_effect_tester_status || "等待执行"}`,
	];
	return lines.join("\n");
}

function setStatus(node, text) {
	node.properties = node.properties || {};
	node.properties.gjj_lora_effect_tester_status = String(text || "");
	const summary = node.__gjjLoraEffectPanel?.querySelector(".summary");
	if (summary) {
		summary.textContent = summaryText(node);
		summary.title = summaryTooltip(node);
		summary.dataset.tip = summaryTooltip(node);
	}
	dirty(node);
}

function ensureStyles(panel) {
	if (panel.__gjjLoraEffectStyleReady) {
		return;
	}
	panel.__gjjLoraEffectStyleReady = true;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-lora-effect{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:7px;padding:0 2px;color:#d7e2ea;font:12px/1.35 sans-serif}
		.gjj-lora-effect-control{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;padding:0 2px}
		.gjj-lora-effect-control .row{display:flex;gap:6px;width:100%}
		.gjj-lora-effect-control button{flex:1;background:#20323a;border:1px solid #3b5560;border-radius:5px;color:#edf6fa;padding:5px 8px;font:700 12px sans-serif;cursor:pointer}
		.gjj-lora-effect-control button.on{background:#1f6b43;border-color:#48ad73;color:#fff}
		.gjj-lora-effect .row{display:flex;gap:6px;width:100%;align-items:center}
		.gjj-lora-effect .filter-icon{flex:0 0 auto;color:#b7c7d1;font-size:13px;line-height:1}
		.gjj-lora-effect input{min-width:0;flex:1;background:#10191e;border:1px solid #334852;border-radius:6px;color:#d7e2ea;padding:5px 7px;font:12px sans-serif}
		.gjj-lora-effect button{background:#1c2b31;border:1px solid #3a535d;border-radius:6px;color:#edf6fa;padding:5px 8px;font:700 12px sans-serif;cursor:pointer}
		.gjj-lora-effect button.on{background:#1f6b43;border-color:#48ad73;color:#fff}
		.gjj-lora-effect .picker{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
		.gjj-lora-effect .summary{position:relative;border:1px solid #28424d;background:#10191e;border-radius:6px;padding:6px 8px;min-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-lora-effect .summary:hover::after{content:attr(data-tip);position:absolute;left:6px;right:6px;top:calc(100% + 5px);z-index:10001;white-space:pre-wrap;background:#251016;border:1px solid #d94a62;color:#ff8ba0;border-radius:6px;padding:7px 8px;box-shadow:0 8px 20px rgba(0,0,0,.45);font:12px/1.35 sans-serif}
		.gjj-lora-effect .strengths{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
		.gjj-lora-effect .strengths span{color:#aebdca;margin-right:2px}
		.gjj-lora-effect .strengths button{min-width:42px;padding:3px 6px}
		.gjj-lora-effect .strengths button.on{background:#1d5e92;border-color:#4ca7dd}
		.gjj-lora-effect-popup{position:fixed;z-index:10000;background:#10191e;border:1px solid #6e8791;border-radius:8px;padding:8px;box-shadow:0 10px 28px rgba(0,0,0,.45);color:#edf6fa}
		.gjj-lora-effect-popup input{box-sizing:border-box;width:100%;background:#0b1216;border:1px solid #dce7ec;border-radius:6px;color:#fff;padding:6px 8px;margin-bottom:8px}
		.gjj-lora-effect-popup .list{display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto}
		.gjj-lora-effect-popup button{background:#14242a;border:1px solid #344c55;border-radius:6px;color:#edf6fa;text-align:left;padding:7px 9px;cursor:pointer}
		.gjj-lora-effect-popup button:hover{background:#174832;border-color:#4faa75}
	`;
	panel.appendChild(style);
}

function renderPanel(node) {
	const panel = node.__gjjLoraEffectPanel;
	if (!panel) {
		return;
	}
	const state = readState(node);
	const items = comboItems(node);
	const item = itemAtCurrentIndex(node);
	const controls = node.__gjjLoraEffectControlsWrap;
	const filter = panel.querySelector(".filter");
	const picker = panel.querySelector(".picker");
	const summary = panel.querySelector(".summary");
	const auto = controls?.querySelector(".auto");
	const skip = controls?.querySelector(".skip");

	if (filter && filter.value !== state.filter) {
		filter.value = state.filter;
	}
	if (picker) {
		picker.textContent = item?.label || (items.length ? "已到末尾" : "未匹配到 LoRA");
		picker.title = item?.loraName || "";
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
	for (const button of panel.querySelectorAll("button[data-strength]")) {
		const value = Number(button.dataset.strength);
		button.classList.toggle("on", state.strengths.some((strength) => Math.abs(strength - value) < 1e-6));
	}
}

function clearPopup() {
	globalThis.__gjjLoraEffectPopup?.remove?.();
	globalThis.__gjjLoraEffectPopup = null;
}

function openPicker(node, anchor) {
	clearPopup();
	const popup = document.createElement("div");
	popup.className = "gjj-lora-effect-popup";
	popup.innerHTML = "<input placeholder=\"二次搜索\"><div class=\"list\"></div>";
	document.body.appendChild(popup);
	globalThis.__gjjLoraEffectPopup = popup;

	const rect = anchor.getBoundingClientRect();
	popup.style.left = `${Math.max(8, rect.left)}px`;
	popup.style.top = `${Math.min(window.innerHeight - 320, rect.bottom + 6)}px`;
	popup.style.minWidth = `${Math.max(260, rect.width)}px`;
	const input = popup.querySelector("input");
	const list = popup.querySelector(".list");

	const render = () => {
		const selected = itemAtCurrentIndex(node)?.loraName || "";
		list.textContent = "";
		for (const option of filteredLoras(node, input.value)) {
			const row = document.createElement("button");
			row.type = "button";
			row.textContent = `${option.value === selected ? "✓ " : ""}${displayName(option.value)}`;
			row.title = option.value;
			row.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const currentStrength = itemAtCurrentIndex(node)?.strength ?? readState(node).strengths[0] ?? 1;
				let index = comboItems(node).findIndex(
					(item) => item.loraName === option.value && Math.abs(item.strength - currentStrength) < 1e-6,
				);
				if (index < 0) {
					index = comboItems(node).findIndex((item) => item.loraName === option.value);
				}
				if (index >= 0) {
					setCurrentIndex(node, index + 1);
					setStatus(node, `已选择：${displayName(option.value)}`);
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
	if (node.__gjjLoraEffectControls) {
		return;
	}
	const wrap = document.createElement("div");
	wrap.className = "gjj-lora-effect-control";
	wrap.innerHTML = `
		<div class="row"><button class="reset" type="button">初始化序号</button><button class="stop" type="button">停止自动测试</button></div>
		<div class="row"><button class="auto" type="button"></button><button class="skip" type="button"></button></div>
	`;
	ensureStyles(wrap);
	const stop = wrap.querySelector(".stop");
	const auto = wrap.querySelector(".auto");
	const skip = wrap.querySelector(".skip");
	const resetButton = wrap.querySelector(".reset");
	for (const button of [resetButton, stop, auto, skip]) {
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
	}
	resetButton.addEventListener("click", (event) => {
		event.preventDefault();
		setCurrentIndex(node, 1);
		setStatus(node, "已初始化当前序号为 1");
		renderPanel(node);
		pushLivePreviews(node);
	});
	stop.addEventListener("click", (event) => {
		event.preventDefault();
		clearTimeout(autoQueueTimer);
		autoQueueTimer = null;
		const state = readState(node);
		state.auto = false;
		writeState(node, state, true);
		setStatus(node, "自动测试已手动停止");
		renderPanel(node);
	});
	auto.addEventListener("click", () => {
		const state = readState(node);
		state.auto = !state.auto;
		writeState(node, state, true);
		setStatus(node, state.auto ? "自动执行已开启" : "自动执行已关闭");
		renderPanel(node);
		pushLivePreviews(node);
	});
	skip.addEventListener("click", () => {
		const state = readState(node);
		state.skip = !state.skip;
		writeState(node, state, true);
		setStatus(node, state.skip ? "出错跳过已开启" : "出错跳过已关闭");
		renderPanel(node);
		pushLivePreviews(node);
	});
	node.__gjjLoraEffectControlsWrap = wrap;
	node.__gjjLoraEffectControls = node.addDOMWidget(CONTROL_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
	});
	renderPanel(node);
}

function setupPanel(node) {
	if (node.__gjjLoraEffectPanel) {
		return;
	}
	const panel = document.createElement("div");
	panel.className = "gjj-lora-effect";
	panel.innerHTML = `
		<div class="row"><span class="filter-icon" title="过滤搜索">🔍</span><input class="filter" placeholder="全局过滤 LoRA"><button class="refresh" type="button">刷新列表</button></div>
		<button class="picker" type="button"></button>
		<div class="strengths"><span title="强度">💪</span></div>
		<div class="summary">🔢 0/0 ✅ 0 ❌ 0 · 等待</div>
	`;
	ensureStyles(panel);
	const strengths = panel.querySelector(".strengths");
	for (const choice of STRENGTH_CHOICES) {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.strength = String(choice);
		button.textContent = formatStrength(choice);
		strengths.appendChild(button);
	}
	for (const eventName of ["mousedown", "pointerdown", "click"]) {
		panel.addEventListener(eventName, (event) => event.stopPropagation());
	}
	panel.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	const filter = panel.querySelector(".filter");
	const refresh = panel.querySelector(".refresh");
	const picker = panel.querySelector(".picker");

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
	refresh.addEventListener("click", async (event) => {
		event.preventDefault();
		setStatus(node, "正在刷新 LoRA 列表...");
		await loadLoras(true);
		resetPool(node, `已刷新 LoRA 列表：${getRawLoraOptions().length} 个`);
	});
	picker.addEventListener("click", (event) => {
		event.preventDefault();
		openPicker(node, picker);
	});
	strengths.addEventListener("click", (event) => {
		const button = event.target.closest?.("button[data-strength]");
		if (!button) {
			return;
		}
		const choice = Number(button.dataset.strength);
		const state = readState(node);
		const exists = state.strengths.some((strength) => Math.abs(strength - choice) < 1e-6);
		state.strengths = exists
			? state.strengths.filter((strength) => Math.abs(strength - choice) >= 1e-6)
			: [...state.strengths, choice];
		if (!state.strengths.length) {
			state.strengths = [choice];
		}
		state.strengths = parseStrengths(state.strengths);
		state.passed = [];
		state.failed = [];
		writeState(node, state, true);
		setCurrentIndex(node, 1);
		setStatus(node, `强度队列已更新：${state.strengths.map(formatStrength).join(", ")}`);
		renderPanel(node);
		pushLivePreviews(node);
	});

	node.__gjjLoraEffectPanel = panel;
	node.addDOMWidget(PANEL_WIDGET, "HTML", panel, {
		serialize: false,
		hideOnZoom: false,
	});
	renderPanel(node);
	loadLoras(false).then(() => {
		renderPanel(node);
		pushLivePreviews(node);
	});
}

function isLoraConsumerInput(targetNode, link) {
	const input = targetNode?.inputs?.[link?.target_slot];
	const type = String(input?.type || "");
	const name = String(input?.name || input?.label || "").toLowerCase();
	const display = String(input?.display_name || input?.localized_name || input?.label || "").toLowerCase();
	return type === "LORA_CHAIN_CONFIG"
		|| type.includes("LORA_CHAIN_CONFIG")
		|| name.includes("lora_chain")
		|| name.includes("lora串联")
		|| display.includes("lora串联");
}

function consumerIds(node) {
	const ids = new Set();
	for (const link of outputLinks(node, OUTPUT_CONFIG)) {
		const target = app.graph?.getNodeById?.(link.target_id);
		if (target && !isPreviewNode(target) && isLoraConsumerInput(target, link)) {
			ids.add(String(target.id));
		}
	}
	return [...ids];
}

function runFromBackend(node, data = {}) {
	const rawName = String(data.raw_lora_name || "");
	const strength = Number(data.current_strength ?? 1) || 1;
	const key = String(data.current_key || (rawName ? comboKey(rawName, strength) : ""));
	return {
		node,
		promptId: lastPromptId,
		currentIndex: Number(data.current_index || currentIndex(node)) || 1,
		totalCount: Number(data.total_count || comboItems(node).length) || 0,
		key,
		rawName,
		strength,
		label: String(data.current_name || (rawName ? `(${formatStrength(strength)})${displayName(rawName)}` : "")),
		consumerIds: consumerIds(node),
		consumerSucceeded: false,
		loraApplied: false,
		loraFailed: false,
		finished: false,
	};
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

function isCurrentLora(run, detail) {
	if (!run?.rawName) {
		return false;
	}
	return normalizeLoraName(run.rawName) === normalizeLoraName(detail?.name)
		&& Math.abs((Number(run.strength) || 1) - (Number(detail?.strength) || 1)) < 1e-4;
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

function activeTesterNodes() {
	return (app.graph?._nodes || []).filter((node) => node?.comfyClass === NODE_NAME);
}

function persistNode(node) {
	compactNode(node);
	writeState(node, readState(node), true);
	const total = comboItems(node).length;
	if (total > 0 && currentIndex(node) > total) {
		setCurrentIndex(node, 1);
	}
	renderPanel(node);
	pushLivePreviews(node);
}

function persistAll() {
	for (const node of activeTesterNodes()) {
		persistNode(node);
	}
}

function patchPromptQueue() {
	if (!queuePatched && typeof app.queuePrompt === "function") {
		const original = app.queuePrompt;
		app.queuePrompt = async function (...args) {
			await loadLoras(false);
			persistAll();
			return original.apply(this, args);
		};
		queuePatched = true;
	}
	if (!graphPromptPatched && typeof app.graphToPrompt === "function") {
		const original = app.graphToPrompt;
		app.graphToPrompt = function (...args) {
			persistAll();
			return original.apply(this, args);
		};
		graphPromptPatched = true;
	}
	if ((!queuePatched || !graphPromptPatched) && patchRetryCount < 30) {
		patchRetryCount += 1;
		setTimeout(patchPromptQueue, 500);
	}
}

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
	activeRun = null;
	clearTimeout(autoQueueTimer);
	autoQueueTimer = null;
	for (const node of activeTesterNodes()) {
		setStatus(node, "已提交执行，等待 LoRA 测试节点返回当前项");
	}
});

api.addEventListener("gjj_lora_applied", (event) => {
	const detail = event?.detail || {};
	if (!activeRun || !isCurrentConsumer(activeRun, detail.node) || !isCurrentLora(activeRun, detail)) {
		return;
	}
	activeRun.loraApplied = true;
	setStatus(activeRun.node, `LoRA 已应用：${activeRun.label}`);
});

api.addEventListener("gjj_lora_failed", (event) => {
	const detail = event?.detail || {};
	if (!activeRun || !isCurrentConsumer(activeRun, detail.node) || !isCurrentLora(activeRun, detail)) {
		return;
	}
	activeRun.loraFailed = true;
	markResult(activeRun.node, activeRun.key, false);
	setStatus(activeRun.node, `LoRA 应用失败：${activeRun.label}`);
});

api.addEventListener("executed", (event) => {
	if (!samePrompt(event) || !activeRun) {
		return;
	}
	if (!isCurrentConsumer(activeRun, eventNodeId(event))) {
		return;
	}
	activeRun.consumerSucceeded = true;
	markResult(activeRun.node, activeRun.key, true);
	setStatus(activeRun.node, `生成节点完成：${activeRun.label}`);
});

api.addEventListener("execution_success", (event) => {
	if (!samePrompt(event) || !activeRun) {
		activeRun = null;
		return;
	}
	if (activeRun.consumerSucceeded) {
		queueNextIfNeeded(activeRun, true, "执行完成");
	} else if (activeRun.loraApplied) {
		queueNextIfNeeded(activeRun, true, "LoRA 已应用且流程完成");
	} else if (activeRun.consumerIds.length) {
		setStatus(activeRun.node, "流程完成，但目标生成节点没有返回成功事件");
	} else {
		setStatus(activeRun.node, "未连接 LoRA 串联配置生成节点");
	}
	activeRun = null;
});

api.addEventListener("execution_error", (event) => {
	if (!samePrompt(event) || !activeRun) {
		activeRun = null;
		return;
	}
	const nodeId = eventNodeId(event);
	if (activeRun.consumerSucceeded) {
		queueNextIfNeeded(activeRun, true, "生成已成功，后续节点出错");
	} else if (activeRun.loraFailed || !nodeId || isCurrentConsumer(activeRun, nodeId)) {
		queueNextIfNeeded(activeRun, false, "执行出错");
	} else {
		setStatus(activeRun.node, "非当前 LoRA 生成节点出错，未标记当前项");
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

patchPromptQueue();

app.registerExtension({
	name: "GJJ.LoraEffectTester.CleanRewrite",

	async beforeQueuePrompt() {
		await loadLoras(false);
		persistAll();
	},

	beforeQueued() {
		persistAll();
	},

	nodeCreated(node) {
		if (node.comfyClass !== NODE_NAME) {
			return;
		}
		node.__gjjLoraEffectState = parseState(
			node.properties?.[STATE_WIDGET] ?? findWidget(node, STATE_WIDGET)?.value ?? "",
		);
		compactNode(node);
		setupControls(node);
		setupPanel(node);
		setStatus(node, node.properties?.gjj_lora_effect_tester_status || "等待执行");
		setTimeout(() => compactNode(node), 0);
		setTimeout(() => compactNode(node), 120);
	},

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) {
			return;
		}
		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			if (data) {
				activeRun = runFromBackend(this, data);
				if (!activeRun.key) {
					setStatus(this, data.status || "没有可执行 LoRA");
				} else if (!activeRun.consumerIds.length) {
					setStatus(this, "当前 LoRA 已输出，但未连接 LoRA 串联配置生成节点");
				} else {
					setStatus(this, data.status || `当前项：${activeRun.label}`);
				}
				renderPanel(this);
				pushLivePreviews(this);
			}
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => {
				this.__gjjLoraEffectState = parseState(
					this.properties?.[STATE_WIDGET] ?? findWidget(this, STATE_WIDGET)?.value ?? "",
				);
				compactNode(this);
				setupControls(this);
				setupPanel(this);
				renderPanel(this);
				pushLivePreviews(this);
			}, 0);
			return result;
		};
	},
});

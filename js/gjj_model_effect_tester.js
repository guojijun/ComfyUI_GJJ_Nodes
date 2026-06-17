import { app } from "../../scripts/app.js";

const NODE_NAME = "GJJ_ModelEffectTester";
const STATE_WIDGET = "test_state";
const INDEX_WIDGET = "current_index";
const SOURCE_WIDGET = "model_source";
const PANEL_WIDGET = "gjj_model_effect_tester_panel";
const CONTROL_WIDGET = "gjj_model_effect_tester_controls";
const API_PATH = "/gjj/model_effect_models";
const PASS_MARK = "✅ ";
const FAIL_MARK = "❌ ";
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

let cacheBySource = new Map();
let loadingBySource = new Map();

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
		state.subdir = String(parsed.subdir || "");
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
	node.widgets_values = node.widgets
		.filter((widget) => widget?.serialize !== false)
		.map((widget, index) => {
			if (typeof widget.serializeValue === "function") {
				try {
					return widget.serializeValue(node, index);
				} catch (error) {
					return widget.value;
				}
			}
			return widget.value;
		});
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
	widget.y = -10000;
	widget.last_y = -10000;
	widget.label = fallbackLabel;
	widget.localized_name = fallbackLabel;
	widget.options = widget.options || {};
	widget.options.display_name = fallbackLabel;
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function compactNode(node) {
	const stateWidget = findWidget(node, STATE_WIDGET);
	if (stateWidget) {
		stateWidget.serialize = true;
		stateWidget.serializeValue = () => serializeState(readState(node));
		hideWidget(stateWidget, true, "测试状态");
	}
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

function matchesSubdir(text, subdir) {
	const folder = normalizeKeyword(subdir).replace(/^\/+|\/+$/gu, "");
	if (!folder) {
		return true;
	}
	const value = normalizeKeyword(text);
	return value === folder || value.startsWith(`${folder}/`);
}

function displayName(rawName) {
	return String(rawName || "")
		.replace(/\.[^/\\.\s]+$/u, "")
		.replace(/[\\/]+/gu, "_");
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
		.then(async (response) => (response.ok ? response.json() : { models: [], subdirs: [] }))
		.then((data) => {
			const payload = {
				models: Array.isArray(data?.models) ? data.models.map((item) => String(item || "").trim()).filter(Boolean) : [],
				subdirs: Array.isArray(data?.subdirs) ? data.subdirs.map((item) => String(item || "").trim()).filter(Boolean) : [],
			};
			cacheBySource.set(key, payload);
			return payload;
		})
		.catch(() => ({ models: [], subdirs: [] }))
		.finally(() => loadingBySource.delete(key));
	loadingBySource.set(key, promise);
	return promise;
}

function cachedPayload(node) {
	return cacheBySource.get(sourceValue(node)) || { models: [], subdirs: [] };
}

function filteredModels(node, secondarySearch = "") {
	const state = readState(node);
	const query = [state.filter, secondarySearch].filter((item) => String(item || "").trim()).join("&");
	const expression = parseSearchExpression(query);
	return cachedPayload(node).models.filter((name) => matchesSubdir(name, state.subdir) && matchesSearch(name, expression));
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

function resultCounts(node) {
	const state = readState(node);
	const allowed = new Set(comboItems(node).map((item) => item.key));
	const passed = state.passed.filter((key) => allowed.has(key)).length;
	const failed = state.failed.filter((key) => allowed.has(key)).length;
	return { passed, failed };
}

function summaryText(node) {
	const total = comboItems(node).length;
	const index = total ? Math.min(currentIndex(node), total) : 0;
	const counts = resultCounts(node);
	return `🔢 ${index}/${total} ✅ ${counts.passed} ❌ ${counts.failed}`;
}

function renderPanel(node) {
	const panel = node.__gjjModelEffectPanel;
	if (!panel) {
		return;
	}
	const state = readState(node);
	const item = itemAtCurrentIndex(node);
	const payload = cachedPayload(node);
	panel.querySelector(".summary").textContent = summaryText(node);
	panel.querySelector(".current").textContent = item?.nameLabel || "未匹配到模型";

	const subdir = panel.querySelector(".subdir");
	const existing = new Set([...subdir.options].map((option) => option.value));
	for (const dir of ["", ...payload.subdirs]) {
		if (existing.has(dir)) continue;
		const option = document.createElement("option");
		option.value = dir;
		option.textContent = dir || "全部子目录";
		subdir.appendChild(option);
	}
	subdir.value = state.subdir || "";
}

function markCurrent(node, passed) {
	const item = itemAtCurrentIndex(node);
	if (!item) {
		return;
	}
	const state = readState(node);
	state.passed = state.passed.filter((key) => key !== item.key);
	state.failed = state.failed.filter((key) => key !== item.key);
	(passed ? state.passed : state.failed).push(item.key);
	writeState(node, state, true);
	setCurrentIndex(node, currentIndex(node) + 1);
	renderPanel(node);
}

function resetPool(node) {
	const state = readState(node);
	state.passed = [];
	state.failed = [];
	writeState(node, state, true);
	setCurrentIndex(node, 1);
	renderPanel(node);
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

function buildPanel(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-model-effect";
	wrap.innerHTML = `
		<style>
			.gjj-model-effect{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:7px;padding:0 2px;color:#d7e2ea;font:12px/1.35 sans-serif}
			.gjj-model-effect .row{display:flex;gap:6px;width:100%;align-items:center}
			.gjj-model-effect input,.gjj-model-effect select{min-width:0;flex:1;background:#10191e;border:1px solid #334852;border-radius:6px;color:#d7e2ea;padding:5px 7px;font:12px sans-serif}
			.gjj-model-effect button{background:#1c2b31;border:1px solid #3a535d;border-radius:6px;color:#edf6fa;padding:5px 8px;font:700 12px sans-serif;cursor:pointer}
			.gjj-model-effect button.pass{background:#1f5d39;border-color:#49a66d}
			.gjj-model-effect button.fail{background:#5d2430;border-color:#c3586b}
			.gjj-model-effect .summary{border:1px solid #28424d;background:#10191e;border-radius:6px;padding:6px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
			.gjj-model-effect .current{border:1px solid #28424d;background:#0f161a;border-radius:6px;padding:6px 8px;overflow-wrap:anywhere}
		</style>
	`;
	const summary = document.createElement("div");
	summary.className = "summary";
	wrap.appendChild(summary);

	const current = document.createElement("div");
	current.className = "current";
	wrap.appendChild(current);

	const filterRow = document.createElement("div");
	filterRow.className = "row";
	const filter = document.createElement("input");
	filter.placeholder = "关键词过滤：qwen&edit 或 flux,sdxl";
	filter.value = readState(node).filter || "";
	filter.addEventListener("change", () => {
		const state = readState(node);
		state.filter = filter.value;
		writeState(node, state, true);
		setCurrentIndex(node, 1);
		renderPanel(node);
	});
	filterRow.appendChild(filter);
	wrap.appendChild(filterRow);

	const subdirRow = document.createElement("div");
	subdirRow.className = "row";
	const subdir = document.createElement("select");
	subdir.className = "subdir";
	const allOption = document.createElement("option");
	allOption.value = "";
	allOption.textContent = "全部子目录";
	subdir.appendChild(allOption);
	subdir.addEventListener("change", () => {
		const state = readState(node);
		state.subdir = subdir.value;
		writeState(node, state, true);
		setCurrentIndex(node, 1);
		renderPanel(node);
	});
	subdirRow.appendChild(subdir);
	wrap.appendChild(subdirRow);

	const actions = document.createElement("div");
	actions.className = "row";
	actions.appendChild(makeButton("上一个", "切到上一个模型", () => {
		setCurrentIndex(node, Math.max(1, currentIndex(node) - 1));
		renderPanel(node);
	}));
	actions.appendChild(makeButton("通过", "标记当前模型通过并前进", () => markCurrent(node, true))).className = "pass";
	actions.appendChild(makeButton("失败", "标记当前模型失败并前进", () => markCurrent(node, false))).className = "fail";
	actions.appendChild(makeButton("下一个", "切到下一个模型", () => {
		setCurrentIndex(node, currentIndex(node) + 1);
		renderPanel(node);
	}));
	actions.appendChild(makeButton("重置", "清空通过/失败记录", () => resetPool(node)));
	wrap.appendChild(actions);

	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "wheel", "keydown", "keyup"]) {
		wrap.addEventListener(eventName, (event) => event.stopPropagation(), true);
	}
	return wrap;
}

async function setupNode(node) {
	if (node.__gjjModelEffectReady) {
		return;
	}
	node.__gjjModelEffectReady = true;
	compactNode(node);
	node.__gjjModelEffectPanel = buildPanel(node);
	node.addDOMWidget(PANEL_WIDGET, "HTML", node.__gjjModelEffectPanel, { serialize: false });
	await loadModels(sourceValue(node));
	renderPanel(node);

	const sourceWidget = findWidget(node, SOURCE_WIDGET);
	if (sourceWidget && !sourceWidget.__gjjModelEffectHooked) {
		sourceWidget.__gjjModelEffectHooked = true;
		const original = sourceWidget.callback;
		sourceWidget.callback = function (value, ...args) {
			const result = original?.call(this, value, ...args);
			loadModels(String(value || "diffusion_models"), true).then(() => {
				setCurrentIndex(node, 1);
				renderPanel(node);
			});
			return result;
		};
	}
}

app.registerExtension({
	name: "Comfy.GJJ.ModelEffectTester",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) {
			return;
		}
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => void setupNode(this), 0);
			return result;
		};
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			this.__gjjModelEffectState = parseState(
				serializedNode?.properties?.[STATE_WIDGET] ?? "",
			);
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			setTimeout(() => void setupNode(this), 0);
			return result;
		};
		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[STATE_WIDGET] = serializeState(readState(this));
			refreshWidgetValues(this);
			return result;
		};
	},
});

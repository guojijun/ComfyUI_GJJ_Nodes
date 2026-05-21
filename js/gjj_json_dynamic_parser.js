import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET = "GJJ_JsonDynamicParser";
const MAX_OUTPUTS = 64;
const PANEL_WIDGET = "panel_json";
const PATH_WIDGET = "json_file_path";
const ENCODING_WIDGET = "encoding";
const LEGACY_INPUT_NAME = "json_input";
const UPSTREAM_DEBOUNCE_MS = 1000;
const UPSTREAM_CACHE_RETRY_MS = 220;
const UPSTREAM_CACHE_RETRY_COUNT = 16;
const MIN_WIDTH = 360;

function dirty(node) {
	GJJ_Utils.refreshNode(node);
}

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name || item?.options?.name === name);
}

function setWidgetValue(node, name, value) {
	const w = widget(node, name);
	if (!w) return;
	const changed = w.value !== value;
	w.value = value;
	if (changed) {
		try { w.callback?.call(w, value); } catch (_) {}
	}
	const input = w.inputEl || w.element?.querySelector?.("textarea,input");
	if (input && input.value !== value) input.value = value;
}

function setDisabled(node, disabled) {
	for (const name of [PANEL_WIDGET, PATH_WIDGET, ENCODING_WIDGET]) {
		const w = widget(node, name);
		if (!w) continue;
		w.disabled = !!disabled;
		const input = w.inputEl || w.element?.querySelector?.("textarea,input");
		if (input) input.disabled = !!disabled;
		if (w.element) w.element.style.opacity = disabled ? "0.46" : "1";
	}
	const btn = node.__gjjJsonOpenButton;
	if (btn) {
		btn.disabled = !!disabled;
		btn.title = disabled ? "JSON文本已连接上游，打开文件暂时停用。" : "打开本地 JSON 文件，并把文本读取到本节点。";
	}
}

function hasExternalInput(node) {
	return (node?.inputs || []).some((input) => input?.name === PANEL_WIDGET && input?.link != null);
}

function cleanupInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		if (name === LEGACY_INPUT_NAME || input?.label === "外部JSON/文本") {
			try { node.removeInput(index); }
			catch (_) { node.inputs.splice(index, 1); }
			continue;
		}
		if (name === PANEL_WIDGET) {
			input.label = "JSON文本";
			input.localized_name = "JSON文本";
			input.type = "STRING";
			input.tooltip = "可连接上游 JSON/STRING；点击“解析上游”后按上游内容刷新输出口。";
		}
	}
}

function truncateName(text, fallback) {
	const value = String(text || "").trim() || fallback;
	return value.length > 18 ? `${value.slice(0, 17)}...` : value;
}

function inferType(value) {
	if (value === null || value === undefined) return "*";
	if (typeof value === "boolean") return "BOOLEAN";
	if (typeof value === "number") return Number.isInteger(value) ? "INT" : "FLOAT";
	if (typeof value === "string") return "STRING";
	if (Array.isArray(value) || typeof value === "object") return "JSON";
	return "*";
}

function fallbackValueForType(type) {
	if (type === "BOOLEAN") return true;
	if (type === "INT") return 1;
	if (type === "FLOAT") return 1.1;
	if (type === "STRING") return "";
	if (type === "JSON") return {};
	return null;
}

function typeLabel(type) {
	if (type === "BOOLEAN") return "布尔";
	if (type === "INT") return "整数";
	if (type === "FLOAT") return "小数";
	if (type === "STRING") return "文本";
	if (type === "JSON") return "JSON";
	return "任意";
}

function parseSourceText(node) {
	return parseRawJsonText(widget(node, PANEL_WIDGET)?.value || "");
}

function parseRawJsonText(text) {
	const source = String(text || "").trim();
	if (!source) return { items: [], error: "" };
	try {
		const data = JSON.parse(source);
		if (Array.isArray(data)) {
			return { items: data.map((value, index) => [`项目${index + 1}`, value]).slice(0, MAX_OUTPUTS), error: "" };
		}
		if (data && typeof data === "object") {
			return { items: Object.entries(data).slice(0, MAX_OUTPUTS), error: "" };
		}
		return { items: [["值", data]], error: "" };
	} catch (error) {
		return { items: [], error: `JSON格式错误：${error?.message || error}` };
	}
}

function upstreamLink(node) {
	const input = (node?.inputs || []).find((item) => item?.name === PANEL_WIDGET);
	const linkId = input?.link;
	return linkId != null ? app.graph?.links?.[linkId] : null;
}

function sameOriginOutputLinks(node) {
	const link = upstreamLink(node);
	if (!link) return [];
	const origin = app.graph?.getNodeById?.(link.origin_id);
	const output = origin?.outputs?.[link.origin_slot];
	const ids = Array.isArray(output?.links) ? output.links : [];
	return ids.map((id) => app.graph?.links?.[id]).filter(Boolean);
}

function previewTextFromSameUpstream(node) {
	for (const link of sameOriginOutputLinks(node)) {
		const target = app.graph?.getNodeById?.(link.target_id);
		if (!target || target === node) continue;
		const text = String(
			target.__gjjAnyPreviewText
			|| target.__gjjJsonLastPreviewText
			|| ""
		).trim();
		if (target.comfyClass === "GJJ_AnyPreview" && text) {
			return text;
		}
	}
	return "";
}

function applyPreviewCacheSchema(node) {
	const text = previewTextFromSameUpstream(node);
	if (!text) return false;
	const { items, error } = parseRawJsonText(text);
	if (!items.length || error) return false;
	applyOutputs(node, items, "");
	setStatus(node, `已从上游预览解析：${items.length} 个输出口`);
	node.__gjjJsonAwaitingUpstream = false;
	dirty(node);
	return true;
}

function retryPreviewCacheSchema(node, count = UPSTREAM_CACHE_RETRY_COUNT) {
	if (applyPreviewCacheSchema(node)) return;
	if (count <= 0 || !node.__gjjJsonAwaitingUpstream) {
		if (node.__gjjJsonAwaitingUpstream) {
			setStatus(node, "未收到上游解析结果；可确认同源预览器已执行，或再点一次解析上游。");
			node.__gjjJsonAwaitingUpstream = false;
		}
		return;
	}
	clearTimeout(node.__gjjJsonPreviewRetryTimer);
	node.__gjjJsonPreviewRetryTimer = setTimeout(() => retryPreviewCacheSchema(node, count - 1), UPSTREAM_CACHE_RETRY_MS);
}

async function inspectPathSource(node) {
	const path = String(widget(node, PATH_WIDGET)?.value || "").trim();
	if (!path) return { items: [], error: "" };
	const encoding = String(widget(node, ENCODING_WIDGET)?.value || "utf-8").trim() || "utf-8";
	try {
		const url = `/gjj/json_dynamic_parser/inspect?path=${encodeURIComponent(path)}&encoding=${encodeURIComponent(encoding)}`;
		const response = await api.fetchApi(url);
		const payload = await response.json();
		return payload?.ok
			? { items: (payload.items || []).map((item) => [item.name, fallbackValueForType(item.type)]), error: "" }
			: { items: [], error: payload?.error || "JSON文件读取失败" };
	} catch (error) {
		return { items: [], error: `JSON文件读取失败：${error?.message || error}` };
	}
}

function removeAllOutputs(node) {
	while ((node.outputs || []).length > 0) {
		try { node.removeOutput(node.outputs.length - 1); }
		catch (_) { node.outputs.pop(); }
	}
}

function ensureOutputCount(node, count) {
	const target = Math.max(1, Math.min(MAX_OUTPUTS, count || 1));
	while ((node.outputs || []).length < target) {
		node.addOutput?.(`输出${node.outputs.length + 1}`, "*");
	}
	while ((node.outputs || []).length > target) {
		const last = node.outputs[node.outputs.length - 1];
		if (last?.links?.length && node.outputs.length <= target) break;
		try { node.removeOutput(node.outputs.length - 1); }
		catch (_) { node.outputs.pop(); }
	}
}

function linkCountProtectedOutputCount(node, count) {
	let needed = count;
	(node.outputs || []).forEach((output, index) => {
		if (output?.links?.length) needed = Math.max(needed, index + 1);
	});
	return Math.min(MAX_OUTPUTS, Math.max(1, needed));
}

function applyOutputs(node, items, error) {
	if (items?.length) {
		node.__gjjJsonLastSchemaItems = items.slice(0, MAX_OUTPUTS);
	}
	if (error) {
		ensureOutputCount(node, 1);
		const output = node.outputs?.[0];
		if (output) {
			output.name = "JSON格式错误";
			output.label = "JSON格式错误";
			output.localized_name = "JSON格式错误";
			output.type = "*";
			output.tooltip = error;
		}
		return;
	}
	const safeItems = items.length ? items : [["空JSON", null]];
	ensureOutputCount(node, linkCountProtectedOutputCount(node, safeItems.length));
	for (let index = 0; index < (node.outputs || []).length; index += 1) {
		const [rawName, value] = safeItems[index] || [`输出${index + 1}`, null];
		const type = inferType(value);
		const name = truncateName(rawName, `输出${index + 1}`);
		const output = node.outputs[index];
		output.name = name;
		output.label = name;
		output.localized_name = name;
		output.type = type;
		output.tooltip = `${name}：${typeLabel(type)}。来自当前 JSON 的顶层键或数组项目。`;
	}
}

function itemsFromExecutedSchema(message) {
	const unwrap = (value) => {
		let current = value;
		for (let i = 0; i < 5; i += 1) {
			if (!Array.isArray(current)) return current;
			if (current.length === 0) return current;
			const first = current[0];
			if (first && typeof first === "object" && !Array.isArray(first) && ("name" in first || "type" in first)) {
				return current;
			}
			current = first;
		}
		return current;
	};
	const raw = unwrap(message?.json_schema ?? message?.ui?.json_schema);
	if (!Array.isArray(raw)) return [];
	return raw.slice(0, MAX_OUTPUTS).map((item, index) => [
		item?.name || `输出${index + 1}`,
		fallbackValueForType(item?.type || "*"),
	]);
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

function applyExecutedSchema(node, message) {
	const items = itemsFromExecutedSchema(message);
	if (!items.length) return false;
	applyOutputs(node, items, "");
	setStatus(node, `已解析上游：${items.length} 个输出口`);
	node.__gjjJsonAwaitingUpstream = false;
	dirty(node);
	return true;
}

function syncExternalState(node) {
	const external = hasExternalInput(node);
	if (external) {
		setWidgetValue(node, PANEL_WIDGET, "");
		setWidgetValue(node, PATH_WIDGET, "");
	}
	setDisabled(node, external);
	return external;
}

async function stabilize(node) {
	if (!node) return;
	cleanupInputs(node);
	node.min_width = Math.max(node.min_width || 0, MIN_WIDTH);
	if (Array.isArray(node.size)) node.size[0] = Math.max(node.size[0] || 0, MIN_WIDTH);
	const external = syncExternalState(node);
	setUpstreamBusy(node, node.__gjjJsonUpstreamBusy);
	if (external) {
		const cached = Array.isArray(node.__gjjJsonLastSchemaItems) ? node.__gjjJsonLastSchemaItems : [];
		if (cached.length) {
			applyOutputs(node, cached, "");
		} else {
			ensureOutputCount(node, 1);
			const output = node.outputs?.[0];
			if (output) {
				output.name = "上游解析结果";
				output.label = "上游解析结果";
				output.localized_name = "上游解析结果";
				output.type = "*";
				output.tooltip = "JSON文本已连接上游。点击“解析上游”执行一次后，会按上游 JSON 的真实内容刷新输出口。";
			}
		}
	} else {
		const panelText = String(widget(node, PANEL_WIDGET)?.value || "").trim();
		const { items, error } = panelText ? parseSourceText(node) : await inspectPathSource(node);
		applyOutputs(node, items, error);
	}
	dirty(node);
}

function schedule(node, ms = 40) {
	clearTimeout(node.__gjjJsonParserTimer);
	node.__gjjJsonParserTimer = setTimeout(() => stabilize(node), ms);
}

function stop(event) {
	try { event.preventDefault(); } catch (_) {}
	try { event.stopPropagation(); } catch (_) {}
}

function setStatus(node, text) {
	if (node?.__gjjJsonStatus) {
		node.__gjjJsonStatus.textContent = String(text || "");
	}
}

function setUpstreamBusy(node, busy) {
	node.__gjjJsonUpstreamBusy = !!busy;
	const btn = node.__gjjJsonUpstreamButton;
	if (!btn) return;
	btn.disabled = !!busy || !hasExternalInput(node);
	btn.textContent = busy ? "⏳" : "解析上游";
	btn.title = hasExternalInput(node)
		? "请求一次上游数据，并按返回 JSON 刷新输出口。已做防抖和忙碌锁，不会持续请求。"
		: "JSON文本未连接上游。连接后可点击解析。";
}

async function parseUpstreamOnce(node) {
	const now = Date.now();
	if (node.__gjjJsonUpstreamBusy) return;
	if (now - Number(node.__gjjJsonLastUpstreamAt || 0) < UPSTREAM_DEBOUNCE_MS) {
		setStatus(node, "请求太频繁，稍后再点。");
		return;
	}
	if (!hasExternalInput(node)) {
		setStatus(node, "JSON文本未连接上游。");
		setUpstreamBusy(node, false);
		return;
	}
	if (applyPreviewCacheSchema(node)) {
		return;
	}
	node.__gjjJsonLastUpstreamAt = now;
	node.__gjjJsonAwaitingUpstream = true;
	setUpstreamBusy(node, true);
	setStatus(node, "正在请求上游数据...");
	try {
		if (typeof app.queuePrompt !== "function") {
			throw new Error("当前前端不支持手动请求。");
		}
		await app.queuePrompt(0, 1);
		setStatus(node, "已请求上游，等待执行结果刷新输出口。");
		retryPreviewCacheSchema(node);
	} catch (error) {
		node.__gjjJsonAwaitingUpstream = false;
		setStatus(node, `解析上游失败：${error?.message || error}`);
	} finally {
		setTimeout(() => {
			setUpstreamBusy(node, false);
			dirty(node);
		}, UPSTREAM_DEBOUNCE_MS);
	}
}

function ensureToolbar(node) {
	if (node.__gjjJsonToolbarReady || typeof node.addDOMWidget !== "function") return;
	node.__gjjJsonToolbarReady = true;
	const wrap = document.createElement("div");
	wrap.style.cssText = "box-sizing:border-box;width:100%;display:grid;grid-template-columns:34px minmax(74px,92px) 1fr;gap:6px;padding:3px 0 5px 0;align-items:center;";
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "📁";
	button.title = "打开本地 JSON 文件，并把文本读取到本节点。";
	button.style.cssText = "height:28px;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:#223139;color:#fff;font-size:15px;cursor:pointer;";
	const upstream = document.createElement("button");
	upstream.type = "button";
	upstream.textContent = "解析上游";
	upstream.title = "JSON文本连接上游后，点击请求一次上游数据并刷新输出口。";
	upstream.style.cssText = "height:28px;min-width:0;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:#223139;color:#eaf5f7;font:700 12px system-ui,'Microsoft YaHei',sans-serif;cursor:pointer;padding:0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	const status = document.createElement("div");
	status.textContent = "JSON文本可粘贴、可外接；未外接时可用文件路径。";
	status.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(235,245,250,.72);font:12px system-ui,'Microsoft YaHei',sans-serif;";
	for (const el of [wrap, button, upstream]) {
		el.addEventListener("pointerdown", stop);
		el.addEventListener("mousedown", stop);
		el.addEventListener("mouseup", stop);
	}
	button.addEventListener("click", (event) => {
		stop(event);
		if (button.disabled) return;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,.txt,application/json,text/plain";
		input.style.display = "none";
		input.addEventListener("change", async () => {
			const file = input.files?.[0];
			input.remove();
			if (!file) return;
			try {
				const text = await file.text();
				setWidgetValue(node, PANEL_WIDGET, text);
				status.textContent = `已打开：${file.name}`;
				schedule(node, 0);
			} catch (error) {
				status.textContent = `打开失败：${error?.message || error}`;
			}
		}, { once: true });
		document.body.appendChild(input);
		input.click();
	});
	upstream.addEventListener("click", (event) => {
		stop(event);
		parseUpstreamOnce(node);
	});
	wrap.append(button, upstream, status);
	node.__gjjJsonOpenButton = button;
	node.__gjjJsonUpstreamButton = upstream;
	node.__gjjJsonStatus = status;
	node.addDOMWidget("gjj_json_open_toolbar", "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 36,
	});
	setUpstreamBusy(node, false);
}

function patchWidgetCallbacks(node) {
	if (node.__gjjJsonCallbacksPatched) return;
	node.__gjjJsonCallbacksPatched = true;
	for (const name of [PANEL_WIDGET, PATH_WIDGET, ENCODING_WIDGET]) {
		const w = widget(node, name);
		if (!w) continue;
		const old = w.callback;
		w.callback = function (...args) {
			const result = old?.apply(this, args);
			schedule(node);
			return result;
		};
		const input = w.inputEl || w.element?.querySelector?.("textarea,input");
		input?.addEventListener?.("input", () => schedule(node, 120));
	}
}

app.registerExtension({
	name: "Comfy.GJJ.JsonDynamicParser",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;

		const onCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = onCreated?.apply(this, args);
			ensureToolbar(this);
			patchWidgetCallbacks(this);
			setTimeout(() => stabilize(this), 0);
			return result;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = onConfigure?.apply(this, args);
			ensureToolbar(this);
			patchWidgetCallbacks(this);
			setTimeout(() => stabilize(this), 0);
			return result;
		};

		const onConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = onConnectionsChange?.apply(this, args);
			schedule(this);
			return result;
		};

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = onExecuted?.apply(this, [message, ...args]);
			applyExecutedSchema(this, message);
			return result;
		};

		const onSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) {
			const result = onSerialize?.apply(this, arguments);
			if (hasExternalInput(this)) {
				setWidgetValue(this, PANEL_WIDGET, "");
				setWidgetValue(this, PATH_WIDGET, "");
				if (Array.isArray(data?.widgets_values) && Array.isArray(this.widgets)) {
					for (const name of [PANEL_WIDGET, PATH_WIDGET]) {
						const index = this.widgets.findIndex((item) => item?.name === name);
						if (index >= 0) data.widgets_values[index] = "";
					}
				}
			}
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET) {
				ensureToolbar(node);
				patchWidgetCallbacks(node);
				stabilize(node);
			}
		}
	},
});

api.addEventListener("executed", (event) => {
	const nodeId = eventNodeId(event);
	if (!nodeId) return;
	const node = app.graph?.getNodeById?.(Number(nodeId)) || app.graph?._nodes?.find((item) => String(item?.id) === String(nodeId));
	if (node?.comfyClass !== TARGET) return;
	const payload = event?.detail?.output || event?.detail || {};
	applyExecutedSchema(node, payload);
});

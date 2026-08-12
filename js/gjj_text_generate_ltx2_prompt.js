import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE = "GJJ_TextGenerateLTX2Prompt";
const PANEL = "gjj_ltx2_prompt_panel";
const FILTER = "model_filter_keywords";
const DEFAULT_MODEL_FILTER = "gemma4_e2b_it";
const DEFAULT_MODEL_MIGRATION = "gjj_ltx2_prompt_default_model_gemma4_e2b_it_v2";
const MODEL_LIST_ENDPOINT = "/gjj/text_encoder_model_sizes";
const INTEGER_SETTINGS = new Set(["max_length", "top_k", "seed"]);
const FLOAT_SETTINGS = new Set(["temperature", "top_p", "min_p", "repetition_penalty"]);
let modelNamesPromise = null;
const HIDDEN = new Set([
	"clip_name", "clip_type", "clip_device", "max_length", "sampling_mode", "temperature",
	"top_k", "top_p", "min_p", "repetition_penalty", "seed", "presence_penalty", "thinking",
	"use_default_template", "system_prompt", "system_prompt_templates", "system_prompt_output_rule",
	"keep_model", "device_preference", "workflow_values_json", FILTER, "passthrough",
]);

const widget = (node, name) => node?.widgets?.find((item) => item?.name === name);
const value = (node, name, fallback = null) => widget(node, name)?.value ?? fallback;
const choices = (node, name) => {
	const values = widget(node, name)?.options?.values;
	return (typeof values === "function" ? values() : values) || [];
};
function setValue(node, name, next) {
	const item = widget(node, name);
	if (!item) return;
	item.value = next;
	item.callback?.(next, app.canvas, node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
}
function hide(item) {
	if (!item || item.name === PANEL || !HIDDEN.has(item.name)) return;
	item.type = `converted-widget:${item.name}`;
	item.computeSize = () => [0, 0];
	item.getHeight = () => 0;
	item.draw = () => {};
	item.mouse = () => false;
	item.options ||= {};
	item.options.hidden = true;
}
function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "contextmenu"])
		element.addEventListener(eventName, (event) => event.stopPropagation());
}
function familyStem(modelName) {
	return GJJ_Utils._modelTreeFamilyStem(String(modelName || ""));
}
async function availableModels(node) {
	if (!modelNamesPromise) {
		modelNamesPromise = api.fetchApi(MODEL_LIST_ENDPOINT)
			.then((response) => response.ok ? response.json() : {})
			.then((data) => Object.keys(data?.sizes || {}))
			.catch(() => []);
	}
	const serverModels = await modelNamesPromise;
	return Array.from(new Set([...choices(node, "clip_name").map(String), ...serverModels.map(String)])).filter(Boolean);
}
function filteredModels(node, models) {
	const filter = String(value(node, FILTER, familyStem(value(node, "clip_name", ""))) || "").trim().toLowerCase();
	if (!filter) return models;
	const groups = filter.split("|").map((group) => group.split(/\s+/).map((term) => GJJ_Utils._modelTreeKey(term)).filter(Boolean)).filter((group) => group.length);
	return models.filter((model) => {
		const key = GJJ_Utils._modelTreeKey(model);
		return groups.some((group) => group.every((term) => key.includes(term)));
	});
}
async function ensurePreferredDefaultModel(node) {
	node.properties ||= {};
	if (node.properties[DEFAULT_MODEL_MIGRATION]) return;
	const models = await availableModels(node);
	const preferred = models.find((name) => name.toLowerCase().includes(DEFAULT_MODEL_FILTER));
	if (preferred) {
		setValue(node, "clip_name", preferred);
		setValue(node, FILTER, DEFAULT_MODEL_FILTER);
		node.properties[DEFAULT_MODEL_MIGRATION] = true;
	}
}
function control(node, name) {
	const source = widget(node, name);
	if (!source) return null;
	const options = choices(node, name);
	let input;
	if (options.length) {
		input = document.createElement("select");
		for (const optionValue of options) {
			const option = document.createElement("option"); option.value = optionValue; option.textContent = optionValue; input.append(option);
		}
		input.value = String(source.value ?? "");
		input.onchange = () => setValue(node, name, input.value);
	} else {
		const numeric = INTEGER_SETTINGS.has(name) || FLOAT_SETTINGS.has(name);
		input = document.createElement(numeric ? "input" : "textarea");
		if (numeric) input.type = "number";
		input.value = String(source.value ?? "");
		input.onchange = () => setValue(node, name, numeric ? Number(input.value) : input.value);
	}
	return input;
}
function normalizeSettings(node) {
	for (const name of INTEGER_SETTINGS) {
		const item = widget(node, name);
		if (!item) continue;
		const next = Number(item.value);
		if (Number.isFinite(next)) item.value = Math.trunc(next);
	}
	for (const name of FLOAT_SETTINGS) {
		const item = widget(node, name);
		if (!item) continue;
		const next = Number(item.value);
		if (Number.isFinite(next)) item.value = next;
	}
	const presencePenalty = widget(node, "presence_penalty");
	if (presencePenalty) {
		const next = Number(presencePenalty.value);
		presencePenalty.value = String(Number.isFinite(next) ? next : 0);
	}
}
function popup(node, title, anchor, content) {
	node.__gjjLtx2Popup?.remove();
	const box = document.createElement("div"); box.className = "gjj-ltx2-popup"; protect(box);
	const head = document.createElement("div"); head.className = "gjj-ltx2-head"; head.textContent = title;
	const close = document.createElement("button"); close.textContent = "×"; close.onclick = () => box.remove(); head.append(close);
	box.append(head, content); document.body.append(box); node.__gjjLtx2Popup = box;
	const rect = anchor.getBoundingClientRect(); box.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 430))}px`; box.style.top = `${rect.bottom + 6}px`;
}
async function openModels(node, anchor) {
	await ensurePreferredDefaultModel(node);
	const selected = String(value(node, "clip_name", ""));
	const stem = familyStem(selected);
	const models = await availableModels(node);
	if (stem && models.includes(selected)) setValue(node, FILTER, stem);
	const visibleModels = filteredModels(node, models);
	const wrap = document.createElement("div");
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: [{
			widget: "clip_name", label: "LTX2 多模态提示词模型", folder: "models/text_encoders", icon: "🧠",
			models, defaultModel: selected, fallback: selected || "未找到模型", missingDefault: visibleModels.length === 0,
			searchValue: () => String(value(node, FILTER, stem) || ""), stateSearchValue: () => String(value(node, FILTER, stem) || ""),
		}],
		refresh: () => node.setDirtyCanvas?.(true, true),
		onApply: (_entry, next) => {
			const nextStem = familyStem(next); if (nextStem) setValue(node, FILTER, nextStem);
			node.__gjjLtx2Popup?.remove();
		},
	});
	if (!visibleModels.length) tree.style.outline = "2px solid #e34d59";
	wrap.append(tree); popup(node, "🧠 模型", anchor, wrap);
}
function openSettings(node, anchor) {
	const body = document.createElement("div"); body.className = "gjj-ltx2-settings";
	for (const [name, label] of [["max_length", "最大长度"], ["sampling_mode", "采样模式"], ["temperature", "温度"], ["top_k", "Top K"], ["top_p", "Top P"], ["min_p", "最小概率"], ["repetition_penalty", "重复惩罚"], ["seed", "种子"], ["presence_penalty", "出现惩罚"]]) {
		const input = control(node, name); if (!input) continue;
		const row = document.createElement("label"); row.append(document.createTextNode(label), input); body.append(row);
	}
	popup(node, "⚙️ 设置参数", anchor, body);
}
function create(node) {
	void ensurePreferredDefaultModel(node);
	if (node.__gjjLtx2Panel || typeof node.addDOMWidget !== "function") return;
	for (const item of node.widgets || []) hide(item);
	const root = document.createElement("div"); root.className = "gjj-ltx2-panel"; protect(root);
	const style = document.createElement("style"); style.textContent = `
		.gjj-ltx2-panel{display:flex;flex-direction:column;gap:6px;width:100%;padding:2px 3px;box-sizing:border-box}.gjj-ltx2-tools{display:flex;gap:5px}.gjj-ltx2-tools button{width:34px;height:27px;border:1px solid #45565d;border-radius:6px;background:#172228;color:#edf7fa;cursor:pointer}.gjj-ltx2-tools button.on{background:#245438;border-color:#71ce91}.gjj-ltx2-popup{position:fixed;z-index:100006;width:min(420px,calc(100vw - 16px));max-height:70vh;overflow:auto;padding:9px;border:1px solid #536870;border-radius:9px;background:#10191d;color:#e9f2f4;box-shadow:0 15px 42px #000b}.gjj-ltx2-head{display:flex;justify-content:space-between;align-items:center;font-weight:800;margin-bottom:7px}.gjj-ltx2-head button{border:0;background:transparent;color:#d6e3e6;font-size:20px;cursor:pointer}.gjj-ltx2-settings{display:grid;gap:6px}.gjj-ltx2-settings label{display:grid;grid-template-columns:105px 1fr;align-items:center;gap:7px}.gjj-ltx2-settings input,.gjj-ltx2-settings select,.gjj-ltx2-settings textarea{width:100%;box-sizing:border-box;background:#0b1418;color:#edf5f6;border:1px solid #3a4d55;border-radius:5px;padding:5px}`;
	const tools = document.createElement("div"); tools.className = "gjj-ltx2-tools";
	const model = document.createElement("button"); model.textContent = "🧠"; model.title = "模型"; model.onclick = () => { void openModels(node, model); };
	const settings = document.createElement("button"); settings.textContent = "⚙️"; settings.title = "设置参数"; settings.onclick = () => openSettings(node, settings);
	const pass = document.createElement("button");
	const syncPass = () => {
		const on = Boolean(value(node, "passthrough", false));
		pass.textContent = on ? "✅" : "✖️";
		pass.classList.toggle("on", on);
		pass.title = on ? "模型生成已开启：执行时加载模型" : "模型生成已关闭：直接原样输出用户文字，不加载模型";
	};
	pass.onclick = () => { setValue(node, "passthrough", !Boolean(value(node, "passthrough", false))); syncPass(); };
	const run = document.createElement("button"); run.textContent = "▶️"; run.title = "执行当前节点"; run.onclick = async () => { run.disabled = true; try { normalizeSettings(node); await queueOnlyCurrentNode(node); } finally { run.disabled = false; } };
	tools.append(model, settings, pass, run);
	root.append(style, tools); syncPass();
	const dom = node.addDOMWidget(PANEL, "HTML", root, { serialize: false, hideOnZoom: false });
	dom.computeSize = (width) => [Math.max(330, Number(width || 330)), 38];
	node.__gjjLtx2Panel = { root };
	node.setSize?.([Math.max(350, node.size?.[0] || 350), 180]);
}
function schedule(node) { setTimeout(() => create(node), 0); setTimeout(() => create(node), 100); }

app.registerExtension({
	name: "GJJ.TextGenerateLTX2Prompt",
	beforeQueuePrompt() {
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass || node?.type || "") === NODE) normalizeSettings(node);
		}
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE) return;
		for (const name of Object.keys(nodeData?.input?.optional || {})) if (/^reference_media_\d+$/.test(name)) delete nodeData.input.optional[name];
		const created = nodeType.prototype.onNodeCreated; nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); schedule(this); return result; };
		const configured = nodeType.prototype.onConfigure; nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); schedule(this); return result; };
	},
	nodeCreated(node) { if (String(node?.comfyClass || node?.type || "") === NODE) schedule(node); },
});

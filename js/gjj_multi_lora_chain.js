import { app } from "/scripts/app.js";

const TARGET_NODES = new Set([
	"GJJ_MultiLoraChainLoader",
	"GJJ_LoraChainConfig",
]);
const LOADER_NODE_NAME = "GJJ_MultiLoraChainLoader";
const CONFIG_NODE_NAME = "GJJ_LoraChainConfig";
const DATA_WIDGET_NAME = "lora_data";
const LORA_METADATA_API_PATH = "/gjj/lora-metadata";
const LORA_PREVIEW_API_PREFIX = "/gjj/lora-preview/";
const SEARCH_BY_ROW_PROPERTY = "gjj_lora_search_by_row";
const GLOBAL_SEARCH_PROPERTY = "gjj_lora_global_search";
const GROUP_RULES_PROPERTY = "gjj_lora_group_rules";
const ADVANCED_OPEN_PROPERTY = "gjj_lora_advanced_open";
const ENABLED_OUTPUTS_PROPERTY = "enabled_outputs";
const CLIP_PORTS_OPEN_PROPERTY = "gjj_lora_clip_ports_open";
const LORA_TRIGGERS_PROPERTY = "gjj_lora_triggers";
const BROADCAST_PROPERTY = "gjj_variable_broadcast_enabled";
const BROADCAST_USER_SET_PROPERTY = "gjj_variable_broadcast_user_set";
const MODEL_OUTPUT_NAME = "叠加模型输出";
const CONFIG_OUTPUT_NAME = "LoRA串联配置";
const TRIGGER_OUTPUT_NAME = "LoRA触发词";
const CLIP_INPUT_NAME = "clip";
const CLIP_INPUT_LABEL = "CLIP 输入";
const CLIP_OUTPUT_NAME = "叠加编码输出";
const ICLORA_FACTOR_OUTPUT_NAME = "IC-LoRA Latent缩放因子";
const ICLORA_MULTIPLE_OUTPUT_NAME = "IC-LoRA像素倍数";
const ICLORA_FACTOR_OUTPUT_INDEX = 2;
const ICLORA_MULTIPLE_OUTPUT_INDEX = 3;
const LOADER_TRIGGER_OUTPUT_INDEX = 4;
const DEFAULT_EMPTY_OPTION = { value: "", label: "未选择" };
const DEFAULT_ROW = { enabled: false, name: "", strength: 1.0 };
const OUTPUT_DEFS = [
	{ key: "clip", name: CLIP_OUTPUT_NAME, type: "CLIP", tooltip: "输出叠加 LoRA 后的 CLIP；未接入 CLIP 时这里会返回空值。" },
	{ key: "iclora_factor", name: ICLORA_FACTOR_OUTPUT_NAME, type: "FLOAT", tooltip: "链中最后一个 IC-LoRA 的 latent_downscale_factor；没有 IC-LoRA 或 metadata 缺失时为 1.0。" },
	{ key: "iclora_multiple", name: ICLORA_MULTIPLE_OUTPUT_NAME, type: "INT", tooltip: "round(latent_downscale_factor * 32)，可直接用于参考图预处理到像素整倍数。" },
	{ key: "lora_triggers", name: TRIGGER_OUTPUT_NAME, type: "STRING", tooltip: "当前启用 LoRA 的触发词；变量广播会自动添加到支持的正向提示词节点。" },
];
const OUTPUT_DEF_BY_KEY = new Map(OUTPUT_DEFS.map((def) => [def.key, def]));
const DEFAULT_GROUP_RULES = [
	"👤 人物角色 = 紫灵,韩立,南宫婉,梅凝,慕沛灵,沛灵,宋玉,如嫣",
	"🎨 画风风格 = 国风,古风,动画变真实,真实变动画,奇幻木偶,剪纸,像素,真实幻想,极致真实",
	"🏠 建筑室内 = 北欧,室内设计,家具,家居,别墅,建筑,场景视角",
	"⚡ 加速蒸馏 = flux,turbo,lightning,lightx2v,FastWan,distill,distilled,consistency,一致性增强,4steps,8steps,蒸馏加速,加速,sda",
	"🌊 Wan视频功能 = 无缝转场,丝滑转场",
	"🔍 细节增强 = detail,details,detailer,skin,Super_Skin,face,eye,eyes,texture,tattoo,glow,slider_detail,extract_tattoo,place_tattoo,细节,脸部,眼睛",
	"🖼️ 扩图修复 = uncrop,inpaint,masked,restore,restoration,unblur,upscale,outpaint,高清,修复,外扩,局部重绘",
	"💡 光影镜头 = light,lighting,shadow,cinematic,film,camera,cameraman,lens,closeup,portrait,wide,macro,光影,电影感,运镜,镜头,特写,人像,广角,微距",
	"👗 服装造型 = outfit,clothes,dress,hanfu,armor,服装,汉服,铠甲,high-neck,tight dress,bell sleeves,platform sandals",
	"🧱 材质质感 = metal,glass,wood,stone,fabric,材质,金属,玻璃,木纹,石头,texture",
	"🧪 临时测试 = test,temp,demo,644,pytorch_lora_weights,other,测试,临时,其它"
].join("\n");
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

function normalizeBoolean(value) {
	return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function loraNameLooksLikeIclora(value) {
	const text = String(value || "").toLowerCase();
	return text.includes("ic-lora") || text.includes("ic_lora") || text.includes("iclora");
}

function isLoaderNode(node) {
	return node?.comfyClass === LOADER_NODE_NAME || node?.type === LOADER_NODE_NAME;
}

function isConfigNode(node) {
	return node?.comfyClass === CONFIG_NODE_NAME || node?.type === CONFIG_NODE_NAME;
}

function hasOutputLinks(node) {
	return (node?.outputs || []).some((output) => Array.isArray(output?.links) && output.links.length > 0);
}

function broadcastEnabled(node) {
	return Boolean(node?.properties?.[BROADCAST_PROPERTY]);
}

function ensureAutoBroadcastForConfig(node) {
	if (!isConfigNode(node)) return;
	node.properties = node.properties || {};
	if (node.properties[BROADCAST_USER_SET_PROPERTY] === true) return;
	if (!hasOutputLinks(node)) {
		node.properties[BROADCAST_PROPERTY] = true;
	}
}

function notifyBroadcastChanged(node) {
	markNodeDirty(node);
	try {
		window.dispatchEvent(new CustomEvent("gjj-variable-broadcast-updated", {
			detail: { nodeId: node?.id, enabled: broadcastEnabled(node) },
		}));
	} catch (_) {}
}

function updateBroadcastButton(node) {
	const button = node?.__gjjLoraBroadcastButton;
	if (!button) return;
	const enabled = broadcastEnabled(node);
	button.dataset.value = enabled ? "true" : "false";
	button.classList.toggle("on", enabled);
	button.setAttribute("aria-pressed", String(enabled));
	button.title = enabled
		? "⚡ 已开启：未接真实连线时会广播到 LORA_CHAIN_CONFIG 类型的空输入口。"
		: "⚡ 已关闭：只通过真实连线传递 LoRA 串联配置。";
}

function setBroadcastEnabled(node, enabled, userSet = true) {
	if (!isConfigNode(node)) return;
	node.properties = node.properties || {};
	if (userSet) node.properties[BROADCAST_USER_SET_PROPERTY] = true;
	node.properties[BROADCAST_PROPERTY] = Boolean(enabled);
	updateBroadcastButton(node);
	notifyBroadcastChanged(node);
}

function createBroadcastButton(node) {
	const button = document.createElement("button");
	button.className = "gjj-lora-broadcast";
	button.type = "button";
	button.textContent = "⚡";
	button.setAttribute("aria-label", "切换 LoRA 配置广播");
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setBroadcastEnabled(node, !broadcastEnabled(node), true);
	});
	node.__gjjLoraBroadcastButton = button;
	updateBroadcastButton(node);
	return button;
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
		.map((item) => {
			const name = String(item.name || "");
			return {
				enabled: Boolean(name) && item.enabled !== false,
				name,
				strength: normalizeStrength(item.strength, 1.0),
			};
		});

	const nonEmptyRows = rows.filter((item) => item.name);
	nonEmptyRows.push({ ...DEFAULT_ROW });
	return nonEmptyRows.length > 0 ? nonEmptyRows : [{ ...DEFAULT_ROW }];
}

function serializeRows(rows) {
	const cleaned = rows
		.filter((item) => item && typeof item === "object")
		.map((item) => {
			const name = String(item.name || "");
			return {
				enabled: Boolean(name) && item.enabled !== false,
				name,
				strength: normalizeStrength(item.strength, 1.0),
			};
		});
	return JSON.stringify(cleaned);
}

function normalizeOutputKeys(value) {
	const source = Array.isArray(value)
		? value
		: Array.isArray(value?.outputs)
			? value.outputs
			: Array.isArray(value?.enabled_outputs)
				? value.enabled_outputs
				: [];
	const result = [];
	for (const item of source) {
		const key = String(typeof item === "object" && item ? item.key : item || "");
		if (OUTPUT_DEF_BY_KEY.has(key) && !result.includes(key)) result.push(key);
	}
	return result;
}

function serializeOutputs(keys) {
	const outputDefs = normalizeOutputKeys(keys).map((key, index) => {
		const def = OUTPUT_DEF_BY_KEY.get(key);
		return {
			key: def.key,
			name: def.name,
			type: def.type,
			index: index + 1,
		};
	});
	return JSON.stringify({ version: 1, outputs: outputDefs });
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

async function fetchLoraMetadata() {
	try {
		const response = await fetch(`${LORA_METADATA_API_PATH}?_=${Date.now()}`, {
			cache: "no-store",
		});
		if (!response.ok) {
			return { metadata: [], previews: {} };
		}
		const data = await response.json();
		return {
			metadata: Array.isArray(data?.metadata) ? data.metadata : [],
			previews: data?.previews && typeof data.previews === "object" ? data.previews : {},
		};
	} catch (error) {
		return { metadata: [], previews: {} };
	}
}

function hideDataWidget(node, widget) {
	if (!widget) {
		return;
	}
	widget.__gjjNode = node;
	widget.type = "hidden";
	widget.hidden = true;
	widget.display = "hidden";
	widget.forceInput = false;
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden", forceInput: false };
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
	widget.name = DATA_WIDGET_NAME;
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
		metadata: [],
		previews: {},
		searchByRow: normalizeSearchByRow(node.properties[SEARCH_BY_ROW_PROPERTY]),
		globalSearch: String(node.properties[GLOBAL_SEARCH_PROPERTY] || ""),
		groupRulesText: String(node.properties[GROUP_RULES_PROPERTY] || DEFAULT_GROUP_RULES),
		advancedOpen: Boolean(node.properties[ADVANCED_OPEN_PROPERTY]),
		clipPortsOpen: normalizeBoolean(node.properties[CLIP_PORTS_OPEN_PROPERTY]),
	};
	return node.__gjjLoraState;
}

function loraPreviewUrl(loraName, previews = {}) {
	const name = String(loraName || "");
	if (!name) {
		return "";
	}
	if (previews[name]) {
		return String(previews[name]);
	}
	return `${LORA_PREVIEW_API_PREFIX}${encodeURIComponent(name)}`;
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

function markNodeDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function findClipInputIndex(node) {
	return (node.inputs || []).findIndex((input) => {
		const name = String(input?.name || "");
		const label = String(input?.label || input?.localized_name || "");
		const type = String(input?.type || "").toUpperCase();
		return name === CLIP_INPUT_NAME || type === "CLIP" || /clip/i.test(`${name} ${label}`);
	});
}

function findClipOutputIndex(node) {
	return (node.outputs || []).findIndex((output, index) => {
		if (index === 0 && String(output?.type || "").toUpperCase() === "MODEL") {
			return false;
		}
		const name = String(output?.name || "");
		const label = String(output?.label || output?.localized_name || "");
		const type = String(output?.type || "").toUpperCase();
		return type === "CLIP" || /clip|编码/.test(`${name} ${label}`);
	});
}

function normalizeClipInput(input) {
	if (!input) {
		return;
	}
	input.name = CLIP_INPUT_NAME;
	input.label = CLIP_INPUT_LABEL;
	input.localized_name = CLIP_INPUT_LABEL;
	input.type = "CLIP";
	input.tooltip = "可选接入 CLIP；开启此端口后 LoRA 会同时作用到模型和 CLIP。";
}

function normalizeClipOutput(output) {
	if (!output) {
		return;
	}
	output.name = CLIP_OUTPUT_NAME;
	output.label = CLIP_OUTPUT_NAME;
	output.localized_name = CLIP_OUTPUT_NAME;
	output.type = "CLIP";
	output.tooltip = "开启 CLIP 端口后输出叠加 LoRA 后的 CLIP；未接入 CLIP 时这里会返回空值。";
}

function normalizeOutputSlot(output, name, type, tooltip = "") {
	if (!output) {
		return;
	}
	output.name = name;
	output.label = name;
	output.localized_name = name;
	output.type = type;
	if (tooltip) output.tooltip = tooltip;
}

function ensureOutputAt(node, index, name, type, tooltip = "") {
	while ((node.outputs || []).length <= index) {
		node.addOutput?.(name, type);
		if (!node.addOutput) {
			node.outputs = node.outputs || [];
			node.outputs.push({ name, type, links: [] });
		}
	}
	normalizeOutputSlot(node.outputs?.[index], name, type, tooltip);
}

function setOutputVisible(output, visible) {
	if (!output) return;
	output.hidden = !visible;
	output.visible = visible;
	output.disabled = !visible;
	output.not_show = !visible;
	output.__gjj_hidden = !visible;
	output.options = { ...(output.options || {}), hidden: !visible };
}

function outputSlotKey(output, index) {
	if (index === 0) return "model";
	const explicit = String(output?.__gjj_key || "");
	if (OUTPUT_DEF_BY_KEY.has(explicit)) return explicit;
	const serializedKey = String(output?.gjj_key || output?.key || "");
	if (OUTPUT_DEF_BY_KEY.has(serializedKey)) return serializedKey;
	const label = String(output?.name || output?.label || output?.localized_name || "");
	for (const def of OUTPUT_DEFS) {
		if (label === def.name) return def.key;
	}
	return "";
}

function desiredOutputKeys(node) {
	const state = ensureNodeState(node);
	const triggerText = buildSelectedLoraTriggerText(state);
	node.properties = node.properties || {};
	node.properties[LORA_TRIGGERS_PROPERTY] = triggerText;
	const keys = [];
	if (state.clipPortsOpen) keys.push("clip");
	if (loaderHasIcloraSelection(node)) keys.push("iclora_factor", "iclora_multiple");
	if (triggerText) keys.push("lora_triggers");
	return keys;
}

function currentLoaderOutputDefs(node) {
	return [
		{ key: "model", name: MODEL_OUTPUT_NAME, type: "MODEL", tooltip: "按当前节点中的 LoRA 顺序串联加载后的模型输出。" },
		...desiredOutputKeys(node).map((key) => OUTPUT_DEF_BY_KEY.get(key)).filter(Boolean),
	];
}

function applyOutputSpec(output, def, index) {
	if (!output || !def) return;
	normalizeOutputSlot(output, def.name, def.type, def.tooltip || "");
	output.display_name = def.name;
	output.__gjj_key = def.key;
	output.gjj_key = def.key;
	output.hidden = false;
	output.visible = true;
	output.disabled = false;
	output.not_show = false;
	output.__gjj_hidden = false;
	output.slot_index = index;
	if (def.key === "lora_triggers") output.gjj_lora_trigger_output = true;
	if (!Array.isArray(output.links)) output.links = [];
}

function outputShapeMatches(node, defs) {
	if (!Array.isArray(node?.outputs) || node.outputs.length !== defs.length) return false;
	for (let index = 0; index < defs.length; index++) {
		const output = node.outputs[index];
		const def = defs[index];
		if (!output || outputSlotKey(output, index) !== def.key) return false;
		if (String(output.name || output.label || "") !== def.name) return false;
		if (String(output.type || "") !== def.type) return false;
	}
	return true;
}

function collectOutputLinksByKey(node) {
	const saved = [];
	for (let index = 0; index < (node.outputs || []).length; index++) {
		const output = node.outputs[index];
		const key = outputSlotKey(output, index);
		if (!key) continue;
		for (const linkId of Array.isArray(output?.links) ? output.links.slice() : []) {
			const link = app.graph?.links?.[linkId];
			if (!link) continue;
			saved.push({
				id: linkId,
				key,
				link,
				target_id: link.target_id,
				target_slot: link.target_slot,
			});
		}
		output.links = [];
	}
	return saved;
}

function restoreOutputLinksByKey(node, savedLinks, defs) {
	const byKey = new Map(defs.map((def, index) => [def.key, { def, index }]));
	const restored = new Set();
	for (const item of savedLinks || []) {
		const target = byKey.get(item.key);
		if (!target) continue;
		const output = node.outputs?.[target.index];
		if (!output) continue;
		const link = app.graph?.links?.[item.id] || item.link;
		if (!link) continue;
		link.id = item.id;
		link.origin_id = node.id;
		link.origin_slot = target.index;
		link.type = target.def.type;
		app.graph.links = app.graph.links || {};
		app.graph.links[item.id] = link;
		if (!Array.isArray(output.links)) output.links = [];
		if (!output.links.includes(item.id)) output.links.push(item.id);
		const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (targetInput) targetInput.link = item.id;
		restored.add(item.id);
	}
	return restored;
}

function deleteUnrestoredOutputLinks(savedLinks, restoredIds) {
	for (const item of savedLinks || []) {
		if (restoredIds?.has?.(item.id)) continue;
		const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (targetInput?.link === item.id) targetInput.link = null;
		try { app.graph?.removeLink?.(item.id); } catch (_) {}
		try { if (app.graph?.links?.[item.id]) delete app.graph.links[item.id]; } catch (_) {}
	}
}

function rebuildOutputSlots(node, defs) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const savedLinks = collectOutputLinksByKey(node);
	while (node.outputs.length > 0) {
		try { node.removeOutput?.(node.outputs.length - 1); }
		catch (_) { node.outputs.pop(); }
	}
	for (const def of defs) {
		try { node.addOutput?.(def.name, def.type); }
		catch (_) { node.outputs.push({ name: def.name, type: def.type, links: [] }); }
	}
	defs.forEach((def, index) => applyOutputSpec(node.outputs?.[index], def, index));
	const restored = restoreOutputLinksByKey(node, savedLinks, defs);
	deleteUnrestoredOutputLinks(savedLinks, restored);
}

function writeSerializedOutputSlots(serializedNode, defs) {
	if (!serializedNode) return;
	const existing = Array.isArray(serializedNode.outputs) ? serializedNode.outputs : [];
	serializedNode.outputs = defs.map((def, index) => ({
		...(existing[index] && typeof existing[index] === "object" ? existing[index] : {}),
		name: def.name,
		label: def.name,
		localized_name: def.name,
		display_name: def.name,
		type: def.type,
		links: Array.isArray(existing[index]?.links) ? [...existing[index].links] : [],
		slot_index: index,
		tooltip: def.tooltip || "",
		gjj_key: def.key,
		hidden: false,
		visible: true,
		disabled: false,
		not_show: false,
		__gjj_hidden: false,
	}));
}

function refreshNodeAfterOutputChange(node) {
	if (typeof node?.computeSize === "function") {
		try {
			const size = node.computeSize();
			if (Array.isArray(size) && size.length >= 2) {
				node.size = [Math.max(node.size?.[0] || 420, size[0]), Math.max(node.size?.[1] || 160, size[1])];
			}
		} catch (_) {}
	}
	markNodeDirty(node);
}

function applyDynamicOutputs(node) {
	if (!isLoaderNode(node)) return;
	const defs = currentLoaderOutputDefs(node);
	const enabledKeys = defs.slice(1).map((def) => def.key);
	node.properties = node.properties || {};
	node.properties[ENABLED_OUTPUTS_PROPERTY] = serializeOutputs(enabledKeys);
	if (!outputShapeMatches(node, defs)) {
		rebuildOutputSlots(node, defs);
	} else {
		defs.forEach((def, index) => applyOutputSpec(node.outputs?.[index], def, index));
	}
	globalThis.GJJApplyTypeColorsToNode?.(node);
	refreshNodeAfterOutputChange(node);
}

function loaderHasIcloraSelection(node) {
	const state = ensureNodeState(node);
	return state.rows.some((row) => row?.enabled !== false && loraNameLooksLikeIclora(row?.name));
}

function ensureLoaderOutputs(node) {
	if (!isLoaderNode(node)) return;
	applyDynamicOutputs(node);
}

function ensureConfigOutputs(node) {
	if (!isConfigNode(node)) return;
	ensureOutputAt(node, 0, CONFIG_OUTPUT_NAME, "LORA_CHAIN_CONFIG", "由前端动态界面维护的 LoRA 串联配置，可直接接到支持该输入的节点。");
	setOutputVisible(node.outputs?.[0], true);
	if (node.outputs?.length > 1) {
		try { node.disconnectOutput?.(1); } catch (_) {}
		node.outputs.splice(1);
	}
}

function clipPortsHaveLinks(node) {
	const input = (node.inputs || [])[findClipInputIndex(node)];
	const output = (node.outputs || [])[findClipOutputIndex(node)];
	return Boolean(input?.link != null || (Array.isArray(output?.links) && output.links.length > 0));
}

function removeInputAt(node, index) {
	if (index < 0) {
		return false;
	}
	const input = node.inputs?.[index];
	if (input?.link != null) {
		return false;
	}
	if (typeof node.removeInput === "function") {
		node.removeInput(index);
	} else {
		node.inputs.splice(index, 1);
	}
	return true;
}

function removeOutputAt(node, index) {
	if (index < 0 || index >= (node.outputs || []).length) {
		return false;
	}
	const output = node.outputs?.[index];
	if (Array.isArray(output?.links) && output.links.length > 0) {
		return false;
	}
	if (typeof node.removeOutput === "function") {
		node.removeOutput(index);
	} else {
		node.outputs.splice(index, 1);
	}
	return true;
}

function removeGraphLink(linkId) {
	if (linkId == null) return;
	try { app.graph?.removeLink?.(linkId); } catch (_) {}
	try { if (app.graph?.links?.[linkId]) delete app.graph.links[linkId]; } catch (_) {}
}

function disconnectClipPorts(node) {
	const input = node.inputs?.[findClipInputIndex(node)];
	if (input?.link != null) {
		removeGraphLink(input.link);
		input.link = null;
	}
	const output = node.outputs?.[findClipOutputIndex(node)];
	for (const linkId of Array.isArray(output?.links) ? output.links.slice() : []) {
		const link = app.graph?.links?.[linkId];
		const targetNode = link && (app.graph?.getNodeById?.(link.target_id) || app.graph?._nodes_by_id?.[link.target_id]);
		const targetInput = targetNode?.inputs?.[link?.target_slot];
		if (targetInput?.link === linkId) targetInput.link = null;
		removeGraphLink(linkId);
	}
	if (output) output.links = [];
}

function ensureClipInput(node) {
	let index = findClipInputIndex(node);
	if (index < 0) {
		node.addInput?.(CLIP_INPUT_NAME, "CLIP");
		index = findClipInputIndex(node);
	}
	normalizeClipInput(node.inputs?.[index]);
}

function updateClipPortsButton(node) {
	const button = node.__gjjLoraClipPortsButton;
	if (!button) {
		return;
	}
	const open = Boolean(ensureNodeState(node).clipPortsOpen);
	button.textContent = "🟡CLIP";
	button.classList.toggle("on", open);
	button.title = open
		? "点击关闭 CLIP 输入与输出端口；关闭时会断开 CLIP 相关连线，采样时不再对 CLIP 加载 LoRA。"
		: "点击开启 CLIP 输入与输出端口；开启后 LoRA 会同时作用到模型和 CLIP。";
}

function applyClipPortVisibility(node) {
	if (!isLoaderNode(node)) {
		return;
	}
	const state = ensureNodeState(node);
	if (clipPortsHaveLinks(node)) {
		state.clipPortsOpen = true;
		node.properties[CLIP_PORTS_OPEN_PROPERTY] = true;
	}

	if (state.clipPortsOpen) {
		ensureClipInput(node);
	} else {
		disconnectClipPorts(node);
		removeInputAt(node, findClipInputIndex(node));
	}
	ensureLoaderOutputs(node);

	updateClipPortsButton(node);
	markNodeDirty(node);
}

function setClipPortsOpen(node, value) {
	if (!isLoaderNode(node)) {
		return;
	}
	const state = ensureNodeState(node);
	if (!value) disconnectClipPorts(node);
	state.clipPortsOpen = Boolean(value);
	node.properties[CLIP_PORTS_OPEN_PROPERTY] = state.clipPortsOpen;
	applyClipPortVisibility(node);
}

function updateDataWidget(node) {
	const dataWidget = node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
	if (!dataWidget) {
		return;
	}

	const state = ensureNodeState(node);
	const serialized = serializeRows(state.rows);
	node.properties = node.properties || {};
	dataWidget.value = serialized;
	dataWidget.callback?.(serialized);
	node.properties[DATA_WIDGET_NAME] = serialized;
	node.properties[LORA_TRIGGERS_PROPERTY] = buildSelectedLoraTriggerText(state);
	const widgetIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(dataWidget) : -1;
	if (widgetIndex >= 0) {
		node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
		node.widgets_values[widgetIndex] = serialized;
	}
	applyDynamicOutputs(node);
}

function ensureTrailingEmptyRow(node) {
	const state = ensureNodeState(node);
	const rows = state.rows.filter((item) => item && typeof item === "object");
	const normalized = rows.filter((item, index) => item.name || index < rows.length - 1);
	if (normalized.length === 0 || normalized[normalized.length - 1].name) {
		normalized.push({ ...DEFAULT_ROW });
	}
	state.rows = normalized.map((item) => {
		const name = String(item.name || "");
		return {
			enabled: Boolean(name) && item.enabled !== false,
			name,
			strength: normalizeStrength(item.strength, 1.0),
		};
	});
	applyDynamicOutputs(node);
}

function applyHighLowPairToNextRow(node, rowIndex, selectedName) {
	const state = ensureNodeState(node);
	const pairName = findHighLowPairName(selectedName, state.options);
	if (!pairName) {
		return false;
	}

	state.rows = state.rows.map((row) => ({ ...row }));
	while (state.rows.length <= rowIndex + 1) {
		state.rows.push({ ...DEFAULT_ROW });
	}

	const pairRow = {
		enabled: true,
		name: pairName,
		strength: normalizeStrength(state.rows[rowIndex]?.strength, 1.0),
	};
	const nextRow = state.rows[rowIndex + 1] || DEFAULT_ROW;
	if (!String(nextRow.name || "")) {
		state.rows[rowIndex + 1] = pairRow;
		return true;
	}
	if (areHighLowPairNames(selectedName, nextRow.name, state.options)) {
		state.rows[rowIndex + 1] = {
			...nextRow,
			enabled: true,
			strength: normalizeStrength(nextRow.strength, pairRow.strength),
		};
		return true;
	}

	const existingPairIndex = state.rows.findIndex((row, index) => {
		return index !== rowIndex && normalizeKeyword(row?.name) === normalizeKeyword(pairName);
	});
	if (existingPairIndex >= 0) {
		const [existingPair] = state.rows.splice(existingPairIndex, 1);
		const insertIndex = existingPairIndex < rowIndex + 1 ? rowIndex : rowIndex + 1;
		state.rows.splice(insertIndex, 0, {
			...existingPair,
			enabled: true,
			strength: normalizeStrength(existingPair.strength, pairRow.strength),
		});
		return true;
	}

	state.rows.splice(rowIndex + 1, 0, pairRow);
	return true;
}

function normalizeKeyword(value) {
	return String(value || "").trim().toLowerCase();
}

function normalizeLoraToken(value) {
	return normalizeKeyword(value)
		.split(/[\\/]/)
		.pop()
		.replace(/\.(safetensors|ckpt|pt|bin)$/i, "")
		.replace(/^krea-2-lora-/i, "")
		.replace(/^krea2[_-]/i, "")
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function getLoraMetadata(state, loraName) {
	const selected = normalizeLoraToken(loraName);
	if (!selected) {
		return null;
	}
	return (state.metadata || []).find((item) => {
		const matches = Array.isArray(item?.match) ? item.match : [];
		return matches.some((keyword) => {
			const token = normalizeLoraToken(keyword);
			return token && (selected.includes(token) || token.includes(selected));
		});
	}) || null;
}

function getLoraTrigger(state, loraName) {
	const metadata = getLoraMetadata(state, loraName);
	const trigger = String(metadata?.trigger || "").trim();
	if (trigger) {
		return trigger;
	}
	const stem = String(loraName || "").split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|bin)$/i, "");
	const match = stem.match(/触发词\s*(.+?)(?:强度\s*[-+]?\d+(?:\.\d+)?|$)/i);
	return match ? String(match[1] || "").replace(/\s+/g, " ").replace(/^[ _\-，,]+|[ _\-，,]+$/g, "") : "";
}

function buildSelectedLoraTriggerText(state) {
	const triggers = [];
	const seen = new Set();
	for (const row of state.rows || []) {
		if (!row?.name || row.enabled === false) continue;
		const trigger = getLoraTrigger(state, row.name);
		const key = trigger.toLowerCase();
		if (trigger && !seen.has(key)) {
			seen.add(key);
			triggers.push(trigger);
		}
	}
	return triggers.join(", ");
}

function replaceHighLowToken(value, replacement) {
	const source = String(value || "");
	return source.replace(
		/(^|[^a-z0-9])(high|low)(?=$|[^a-z0-9])/gi,
		(match, prefix, token) => {
			const lowerReplacement = String(replacement || "").toLowerCase();
			let nextToken = lowerReplacement;
			if (token === token.toUpperCase()) {
				nextToken = lowerReplacement.toUpperCase();
			} else if (token[0] === token[0].toUpperCase()) {
				nextToken = lowerReplacement[0].toUpperCase() + lowerReplacement.slice(1);
			}
			return `${prefix}${nextToken}`;
		},
	);
}

function getHighLowToken(value) {
	const match = String(value || "").match(/(^|[^a-z0-9])(high|low)(?=$|[^a-z0-9])/i);
	return match ? match[2].toLowerCase() : "";
}

function findHighLowPairName(loraName, options) {
	const token = getHighLowToken(loraName);
	if (!token) {
		return "";
	}

	const counterpart = token === "high" ? "low" : "high";
	const candidate = replaceHighLowToken(loraName, counterpart);
	const candidateKey = normalizeKeyword(candidate);
	const byExactValue = (options || []).find((option) => normalizeKeyword(option?.value) === candidateKey);
	if (byExactValue?.value) {
		return String(byExactValue.value);
	}

	const candidateBase = normalizeKeyword(candidate.split(/[\\/]/).pop());
	const byBasename = (options || []).find((option) => {
		const valueBase = normalizeKeyword(String(option?.value || "").split(/[\\/]/).pop());
		return valueBase && valueBase === candidateBase;
	});
	return byBasename?.value ? String(byBasename.value) : "";
}

function areHighLowPairNames(firstName, secondName, options = []) {
	const first = String(firstName || "");
	const second = String(secondName || "");
	if (!first || !second) {
		return false;
	}
	const paired = findHighLowPairName(first, options);
	return Boolean(paired) && normalizeKeyword(paired) === normalizeKeyword(second);
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

function parseRuleHeader(rawHeader, fallbackName) {
	const header = String(rawHeader || "").trim();
	const emojiMatch = header.match(/^([\p{Extended_Pictographic}\uFE0F\u200D]+(?:\s+[\p{Extended_Pictographic}\uFE0F\u200D]+)*)\s*/u);
	const icon = emojiMatch ? emojiMatch[1].trim() : "🧩";
	const groupName = header.replace(/^([\p{Extended_Pictographic}\uFE0F\u200D]+(?:\s+[\p{Extended_Pictographic}\uFE0F\u200D]+)*)\s*/u, "").trim() || fallbackName;
	return { icon, groupName };
}

function parseGroupRules(text) {
	return String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			const [rawGroupName, ...rawKeywords] = line.split("=");
			let groupName = "";
			let icon = "🧩";
			let keywordText = "";

			if (rawKeywords.length === 0) {
				// 兼容简写：紫灵,韩立,国风
				// 表示这一行内所有关键词属于同一个互斥组。
				groupName = `互斥组${index + 1}`;
				keywordText = line;
			} else {
				const parsedHeader = parseRuleHeader(rawGroupName, `互斥组${index + 1}`);
				groupName = parsedHeader.groupName;
				icon = parsedHeader.icon;
				keywordText = rawKeywords.join("=");
			}

			const keywords = keywordText
				.split(/[|,，、；;]/)
				.map((item) => normalizeKeyword(item))
				.filter(Boolean);

			if (!groupName || keywords.length === 0) {
				return null;
			}

			return { groupName, icon, keywords };
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

function getRuleForLora(loraName, rules) {
	const text = normalizeKeyword(loraName);
	if (!text) {
		return null;
	}

	return rules.find((rule) => rule.keywords.some((keyword) => text.includes(keyword))) || null;
}

function getRuleByGroupName(groupName, rules) {
	const target = normalizeKeyword(groupName);
	if (!target) {
		return null;
	}
	return rules.find((rule) => normalizeKeyword(rule.groupName) === target) || null;
}

function getActiveRuleForRow(row, rules, searchText = "", globalSearch = "") {
	const bySelected = getRuleForLora(row?.name, rules);
	if (bySelected) {
		return bySelected;
	}

	const searchParts = [String(searchText || ""), String(globalSearch || "")]
		.join(" ")
		.split(/[\s,，、；;|&+＋]+/)
		.map((item) => normalizeKeyword(item))
		.filter(Boolean);

	for (const part of searchParts) {
		const byName = getRuleByGroupName(part, rules);
		if (byName) {
			return byName;
		}
	}

	return null;
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
	const usedGroups = new Map();

	state.rows = state.rows.map((row) => ({ ...row }));
	state.rows.forEach((row) => {
		const name = String(row?.name || "").trim();
		if (!name) {
			return;
		}

		const loweredName = normalizeKeyword(name);
		const groupName = getGroupNameForLora(name, rules);
		const existingGroupName = groupName ? usedGroups.get(groupName) : "";
		if (
			usedNames.has(loweredName)
			|| (existingGroupName && !areHighLowPairNames(existingGroupName, name, state.options))
		) {
			row.name = "";
			row.enabled = false;
			return;
		}

		usedNames.add(loweredName);
		if (groupName) {
			usedGroups.set(groupName, name);
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
	const activeRule = getActiveRuleForRow(row, rules, searchText, state.globalSearch);
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
		if (activeRule && groupName !== activeRule.groupName && !isCurrent) {
			return false;
		}
		if (!isCurrent && blockedNames.has(loweredValue)) {
			return false;
		}
		const isHighLowPairForAnotherRow = state.rows.some((otherRow, otherIndex) => {
			return otherIndex !== rowIndex && areHighLowPairNames(value, otherRow?.name, state.options);
		});
		if (!isCurrent && groupName && blockedGroups.has(groupName) && !isHighLowPairForAnotherRow) {
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
		.gjj-lora-broadcast { width:26px; height:24px; flex:0 0 26px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:14px; line-height:20px; padding:0; text-align:center; }
		.gjj-lora-broadcast.on, .gjj-lora-broadcast[data-value="true"] { border-color:#69b980; background:#20362f; color:#ecfff1; }
		.gjj-lora-broadcast:hover { border-color:#6aa6b8; background:#2c3b43; }
		.gjj-lora-refresh { padding:2px 8px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; }
		.gjj-lora-advanced-btn { padding:2px 8px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; }
		.gjj-lora-clip-btn { padding:2px 8px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; white-space:nowrap; }
		.gjj-lora-clip-btn.on { border-color:#3b8d6c; background:#1b3a31; color:#dfffee; }
		.gjj-lora-advanced-panel { display:none; }
		.gjj-lora-advanced-panel.open { display:block; width:100%; }
		.gjj-lora-rules-input { display:block; width:100%; min-height:38px; resize:vertical; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:6px 8px; font-size:11px; box-sizing:border-box; }
		.gjj-lora-rows { display:flex; flex-direction:column; gap:6px; }
		.gjj-lora-row { display:flex; align-items:flex-start; gap:6px; padding:6px; border:1px solid #3c4c54; border-radius:8px; background:#172026; }
		.gjj-lora-row.off { opacity:0.65; }
		.gjj-lora-row-thumb-box { width:64px; height:64px; flex:0 0 64px; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius:7px; border:1px solid #2e4149; background:#10171b; color:#72858d; font-size:22px; box-sizing:border-box; }
		.gjj-lora-row-thumb { width:100%; height:100%; display:block; object-fit:cover; }
		.gjj-lora-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; position:relative; }
		.gjj-lora-search { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; box-sizing:border-box; }
		.gjj-lora-picker { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 8px; box-sizing:border-box; text-align:left; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
		.gjj-lora-meta { display:flex; align-items:center; gap:6px; min-height:20px; color:#b9c9cf; font-size:11px; line-height:1.25; }
		.gjj-lora-meta-title { color:#eef8f4; font-weight:600; white-space:nowrap; }
		.gjj-lora-meta-trigger { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9fd4c3; }
		.gjj-lora-meta-strength { flex:0 0 auto; color:#d7c587; }
		.gjj-lora-preview-btn { width:24px; height:22px; flex:0 0 24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:13px; line-height:18px; padding:0; text-align:center; }
		.gjj-lora-preview-btn:hover, .gjj-lora-preview-btn.open { border-color:#6aa6b8; background:#26363d; }
		.gjj-lora-source-btn { width:24px; height:22px; flex:0 0 24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:12px; line-height:18px; padding:0; text-align:center; }
		.gjj-lora-source-btn:hover { border-color:#6aa6b8; background:#26363d; }
		.gjj-lora-preview-card { display:none; position:absolute; left:0; top:calc(100% + 6px); width:min(360px, 100%); padding:8px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-shadow:0 8px 24px rgba(0,0,0,0.38); z-index:9998; box-sizing:border-box; }
		.gjj-lora-preview-card.open { display:grid; grid-template-columns:92px minmax(0,1fr); gap:8px; }
		.gjj-lora-preview-card.floating { position:fixed; width:min(560px,calc(100vw - 24px)); max-height:min(520px,calc(100vh - 24px)); overflow:auto; z-index:2147483647; box-shadow:0 18px 48px rgba(0,0,0,.72); }
		.gjj-lora-preview-card img { width:92px; height:92px; object-fit:cover; border-radius:6px; background:#172026; border:1px solid #2e4149; }
		.gjj-lora-preview-fallback { width:92px; height:92px; display:flex; align-items:center; justify-content:center; text-align:center; padding:8px; box-sizing:border-box; border-radius:6px; background:#1b252b; color:#9fb0b7; border:1px solid #2e4149; font-size:11px; }
		.gjj-lora-preview-copy { min-width:0; display:flex; flex-direction:column; gap:5px; font-size:11px; color:#c7d5d8; line-height:1.35; }
		.gjj-lora-preview-copy strong { color:#eef8f4; font-size:12px; }
		.gjj-lora-preview-copy code { color:#9fd4c3; white-space:normal; word-break:break-word; }
		.gjj-lora-popup { display:none; flex-direction:column; gap:6px; position:absolute; top:calc(100% + 6px); left:0; min-width:280px; max-width:560px; width:420px; padding:6px; border:1px solid #41535b; border-radius:8px; background:#10171b; box-sizing:border-box; z-index:9999; box-shadow:0 8px 24px rgba(0,0,0,0.35); }
		.gjj-lora-popup.open { display:flex; }
		.gjj-lora-popup-search { width:100%; min-width:0; background:#11181c; color:#dce7e2; border:1px solid #41535b; border-radius:6px; padding:4px 6px; box-sizing:border-box; }
		.gjj-lora-popup-list { display:flex; flex-direction:column; gap:4px; max-height:300px; overflow:auto; }
		.gjj-lora-popup-item { width:100%; display:flex; flex-direction:column; gap:4px; background:#182127; color:#dce7e2; border:1px solid #33454c; border-radius:6px; padding:5px 8px; text-align:left; cursor:pointer; box-sizing:border-box; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:1.3; }
		.gjj-lora-popup-item.with-thumb { display:grid; grid-template-columns:48px minmax(0,1fr); grid-template-rows:auto auto; column-gap:8px; row-gap:3px; align-items:center; min-height:60px; }
		.gjj-lora-popup-item:hover { background:#223039; }
		.gjj-lora-popup-item.selected { background:#18352f; border-color:#2f7d67; color:#e8fff6; }
		.gjj-lora-popup-item.selected:hover { background:#1d433a; }
		.gjj-lora-popup-name { font-size:12px; color:inherit; }
		.gjj-lora-popup-item.with-thumb .gjj-lora-popup-name { grid-column:2; grid-row:1; align-self:end; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-lora-popup-meta { display:flex; align-items:center; gap:6px; min-width:0; color:#aebfc5; font-size:11px; }
		.gjj-lora-popup-item.with-thumb .gjj-lora-popup-meta { grid-column:2; grid-row:2; align-self:start; }
		.gjj-lora-popup-thumb { grid-column:1; grid-row:1 / span 2; width:48px; height:48px; border-radius:6px; border:1px solid #2e4149; background:#10171b; object-fit:cover; align-self:center; justify-self:center; }
		.gjj-lora-popup-title { flex:0 0 auto; color:#eef8f4; font-weight:600; }
		.gjj-lora-popup-trigger { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9fd4c3; }
		.gjj-lora-popup-strength { flex:0 0 auto; color:#d7c587; }
		.gjj-lora-popup-preview { width:24px; height:20px; flex:0 0 24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:12px; line-height:16px; padding:0; text-align:center; }
		.gjj-lora-popup-source { width:24px; height:20px; flex:0 0 24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; font-size:11px; line-height:16px; padding:0; text-align:center; }
		.gjj-lora-popup-source:hover { border-color:#6aa6b8; background:#26363d; }
		.gjj-lora-popup-item .gjj-lora-preview-card { position:static; width:100%; margin-top:4px; box-shadow:none; }
		.gjj-lora-popup-item.with-thumb .gjj-lora-preview-card { grid-column:1 / -1; }
		.gjj-lora-popup-empty { color:#8da2ad; font-size:11px; padding:4px 2px; }
		.gjj-lora-side { display:flex; align-items:center; gap:6px; padding-top:2px; flex:0 0 auto; white-space:nowrap; }
		.gjj-lora-row.with-thumbnail .gjj-lora-side { display:grid; grid-template-columns:26px minmax(68px,auto); grid-template-rows:26px 30px; align-items:center; column-gap:6px; row-gap:2px; padding-top:0; }
		.gjj-lora-group-hint { width:26px; min-width:26px; text-align:center; font-size:14px; line-height:1; cursor:default; user-select:none; }
		.gjj-lora-row.with-thumbnail .gjj-lora-side .gjj-lora-group-hint { grid-column:1; grid-row:1; }
		.gjj-lora-row.with-thumbnail .gjj-lora-side .gjj-lora-toggle-wrap { grid-column:2; grid-row:1; }
		.gjj-lora-row.with-thumbnail .gjj-lora-side .gjj-lora-strength { grid-column:2; grid-row:2; align-self:end; }
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

function closeFloatingLoraPreview() {
	const active = globalThis.__gjjFloatingLoraPreview;
	if (!active) return;
	globalThis.__gjjFloatingLoraPreview = null;
	active.cleanup?.();
	active.card?.classList.remove("open", "floating");
	active.card?.remove?.();
	active.button?.classList.remove("open");
}

function openFloatingLoraPreview(card, button, image) {
	if (globalThis.__gjjFloatingLoraPreview?.card === card) {
		closeFloatingLoraPreview();
		return;
	}
	closeFloatingLoraPreview();
	if (image?.dataset?.src && !image.src) image.src = image.dataset.src;
	card.classList.add("open", "floating");
	button.classList.add("open");
	document.body.appendChild(card);

	const rect = button.getBoundingClientRect();
	const width = Math.min(560, Math.max(320, window.innerWidth - 24));
	const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
	card.style.left = `${left}px`;
	card.style.top = "12px";
	const cardHeight = Math.ceil(card.getBoundingClientRect().height || 160);
	const belowTop = rect.bottom + 8;
	const aboveTop = rect.top - cardHeight - 8;
	card.style.top = `${Math.max(12, belowTop + cardHeight <= window.innerHeight - 12 ? belowTop : aboveTop)}px`;

	const close = () => closeFloatingLoraPreview();
	const outside = (event) => {
		if (card.contains(event.target) || button.contains(event.target)) return;
		close();
	};
	const keydown = (event) => {
		if (event.key === "Escape") close();
	};
	card.addEventListener("pointerleave", close);
	window.addEventListener("blur", close);
	window.addEventListener("resize", close);
	document.addEventListener("pointerdown", outside, true);
	document.addEventListener("keydown", keydown, true);
	globalThis.__gjjFloatingLoraPreview = {
		card,
		button,
		cleanup: () => {
			card.removeEventListener("pointerleave", close);
			window.removeEventListener("blur", close);
			window.removeEventListener("resize", close);
			document.removeEventListener("pointerdown", outside, true);
			document.removeEventListener("keydown", keydown, true);
		},
	};
}

function stopCanvasPointerCapture(event) {
	event.stopPropagation();
}

function getHttpsSourceUrl(metadata) {
	const source = String(metadata?.source || "").trim();
	if (!source) {
		return "";
	}
	try {
		const url = new URL(source);
		return url.protocol === "https:" ? url.href : "";
	} catch {
		return "";
	}
}

function createSourceButton(metadata, className) {
	const sourceUrl = getHttpsSourceUrl(metadata);
	if (!sourceUrl) {
		return null;
	}

	const button = document.createElement("button");
	button.type = "button";
	button.className = className;
	button.textContent = "🌐";
	button.title = `打开 LoRA 网页：${sourceUrl}`;
	button.setAttribute("aria-label", "打开 LoRA 网页");
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		window.open(sourceUrl, "_blank", "noopener,noreferrer");
	});
	return button;
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
	const maxPopupWidth = 560;
	const minPopupWidth = Math.min(420, Math.max(280, viewportWidth - horizontalPadding * 2));
	const targetWidth = Math.min(
		Math.max(Math.min(Math.ceil(rect?.width || minPopupWidth), maxPopupWidth), minPopupWidth),
		Math.max(280, viewportWidth - horizontalPadding * 2),
		maxPopupWidth,
	);
	const spaceBelow = Math.max(120, viewportHeight - Math.ceil(rect?.bottom || 0) - verticalPadding - 6);
	const spaceAbove = Math.max(120, Math.floor(rect?.top || 0) - verticalPadding - 6);
	const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
	const panelMaxHeight = Math.max(160, Math.min(360, openAbove ? spaceAbove : spaceBelow));
	const listMaxHeight = Math.max(96, panelMaxHeight - 52);
	const rawLeft = Math.floor(rect?.left || horizontalPadding);
	const left = Math.max(horizontalPadding, Math.min(rawLeft, viewportWidth - targetWidth - horizontalPadding));

	panel.style.width = `${targetWidth}px`;
	panel.style.maxWidth = `${Math.min(maxPopupWidth, Math.max(280, viewportWidth - horizontalPadding * 2))}px`;
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
				const item = document.createElement("div");
				item.setAttribute("role", "button");
				item.tabIndex = 0;
				item.className = "gjj-lora-popup-item";
				const isSelected = String(option.value || "") === selectedValue;
				if (isSelected) {
					item.classList.add("selected");
				}

				const name = document.createElement("div");
				name.className = "gjj-lora-popup-name";
				name.textContent = `${isSelected ? "✔ " : ""}${option.label}`;
				item.appendChild(name);

				const metadata = this.state.getMetadata?.(String(option.value || ""));
				if (metadata) {
					const previewUrl = this.state.getPreviewUrl?.(String(option.value || "")) || "";
					const hasLocalPreview = Boolean(previewUrl && this.state.hasPreview?.(String(option.value || "")));
					if (hasLocalPreview) {
						item.classList.add("with-thumb");
						const thumb = document.createElement("img");
						thumb.className = "gjj-lora-popup-thumb";
						thumb.alt = String(metadata.title || option.label || "LoRA preview");
						thumb.loading = "lazy";
						thumb.decoding = "async";
						thumb.src = previewUrl;
						thumb.addEventListener("error", () => {
							item.classList.remove("with-thumb");
							thumb.remove();
						}, { once: true });
						item.insertBefore(thumb, name);
					}

					const meta = document.createElement("div");
					meta.className = "gjj-lora-popup-meta";

					const title = document.createElement("span");
					title.className = "gjj-lora-popup-title";
					title.textContent = String(metadata.title || "");

					const trigger = document.createElement("span");
					trigger.className = "gjj-lora-popup-trigger";
					trigger.textContent = String(metadata.trigger || "");
					trigger.title = `触发词：${metadata.trigger || ""}`;

					const strength = document.createElement("span");
					strength.className = "gjj-lora-popup-strength";
					strength.textContent = formatStrength(metadata.strength, 1.0);

					const previewButton = document.createElement("button");
					previewButton.type = "button";
					previewButton.className = "gjj-lora-popup-preview";
					previewButton.textContent = "▣";
					previewButton.title = "展开缩略图和简介。";

					const previewCard = document.createElement("div");
					previewCard.className = "gjj-lora-preview-card";

					const image = document.createElement("img");
					image.alt = String(metadata.title || option.label || "LoRA preview");
					image.loading = "lazy";
					image.decoding = "async";
					image.dataset.src = previewUrl;
					image.addEventListener("error", () => {
						const fallback = document.createElement("div");
						fallback.className = "gjj-lora-preview-fallback";
						fallback.textContent = "可放同名 preview 小图";
						image.replaceWith(fallback);
					}, { once: true });

					const copy = document.createElement("div");
					copy.className = "gjj-lora-preview-copy";
					copy.innerHTML = `
						<strong></strong>
						<span></span>
						<code></code>
						<span></span>
					`;
					copy.children[0].textContent = String(metadata.title || option.label || "");
					copy.children[1].textContent = String(metadata.summary || "");
					copy.children[2].textContent = String(metadata.trigger || "");
					copy.children[3].textContent = `推荐强度 ${formatStrength(metadata.strength, 1.0)}`;

					previewCard.appendChild(image);
					previewCard.appendChild(copy);

					previewButton.addEventListener("click", (event) => {
						event.preventDefault();
						event.stopPropagation();
						openFloatingLoraPreview(previewCard, previewButton, image);
						this.reposition();
					});

					meta.appendChild(title);
					meta.appendChild(trigger);
					meta.appendChild(strength);
					const sourceButton = createSourceButton(metadata, "gjj-lora-popup-source");
					if (sourceButton) {
						meta.appendChild(sourceButton);
					}
					meta.appendChild(previewButton);
					item.appendChild(meta);
					item.appendChild(previewCard);
				} else {
					item.title = String(option.label || "");
				}
				item.addEventListener("click", () => {
					this.state?.onSelect?.(String(option.value || ""));
				});
				item.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						this.state?.onSelect?.(String(option.value || ""));
					}
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
	const metadata = getLoraMetadata(state, row.name);
	const rowElement = document.createElement("div");
	rowElement.className = `gjj-lora-row${row.enabled ? "" : " off"}`;

	const previewUrl = loraPreviewUrl(row.name, state.previews);
	const hasLocalPreview = Boolean(row.name && state.previews?.[String(row.name)]);
	let thumbnailBox = null;
	if (hasLocalPreview && previewUrl) {
		rowElement.classList.add("with-thumbnail");
		thumbnailBox = document.createElement("div");
		thumbnailBox.className = "gjj-lora-row-thumb-box";
		thumbnailBox.title = String(metadata?.title || row.name || "");
		const rowThumbnail = document.createElement("img");
		rowThumbnail.className = "gjj-lora-row-thumb";
		rowThumbnail.alt = String(metadata?.title || row.name || "LoRA preview");
		rowThumbnail.loading = "lazy";
		rowThumbnail.decoding = "async";
		rowThumbnail.src = previewUrl;
		rowThumbnail.addEventListener("error", () => {
			thumbnailBox?.remove();
			thumbnailBox = null;
			rowElement.classList.remove("with-thumbnail");
		}, { once: true });
		thumbnailBox.appendChild(rowThumbnail);
	}

	const mainColumn = document.createElement("div");
	mainColumn.className = "gjj-lora-main";

	const picker = document.createElement("button");
	picker.type = "button";
	picker.className = "gjj-lora-picker";
	picker.title = "点击展开当前这一行 LoRA 的可搜索下拉列表。";

	const groupHint = document.createElement("div");
	groupHint.className = "gjj-lora-group-hint";
	const currentRule = getRuleForLora(row.name, parseGroupRules(state.groupRulesText));
	groupHint.textContent = currentRule ? currentRule.icon : "⭕";
	groupHint.title = currentRule
		? `已命中互斥分组：${currentRule.icon} ${currentRule.groupName}`
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
			getMetadata(value) {
				return getLoraMetadata(state, value);
			},
			getPreviewUrl(value) {
				return loraPreviewUrl(value, state.previews);
			},
			hasPreview(value) {
				return Boolean(state.previews?.[String(value || "")]);
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
				state.rows[index].enabled = Boolean(value);
				if (value) {
					applyHighLowPairToNextRow(node, index, value);
				}
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
	if (metadata) {
		const metaRow = document.createElement("div");
		metaRow.className = "gjj-lora-meta";

		const title = document.createElement("span");
		title.className = "gjj-lora-meta-title";
		title.textContent = String(metadata.title || "");

		const trigger = document.createElement("span");
		trigger.className = "gjj-lora-meta-trigger";
		trigger.textContent = String(metadata.trigger || "");
		trigger.title = `触发词：${metadata.trigger || ""}`;

		const defaultStrength = document.createElement("span");
		defaultStrength.className = "gjj-lora-meta-strength";
		defaultStrength.textContent = `建议 ${formatStrength(metadata.strength, 1.0)}`;

		const previewButton = document.createElement("button");
		previewButton.type = "button";
		previewButton.className = "gjj-lora-preview-btn";
		previewButton.textContent = "▣";
		previewButton.title = "查看 LoRA 缩略图、触发词和简介。";

		const previewCard = document.createElement("div");
		previewCard.className = "gjj-lora-preview-card";

		const image = document.createElement("img");
		image.alt = String(metadata.title || row.name || "LoRA preview");
		image.loading = "lazy";
		image.decoding = "async";
		image.dataset.src = loraPreviewUrl(row.name, state.previews);
		image.addEventListener("error", () => {
			const fallback = document.createElement("div");
			fallback.className = "gjj-lora-preview-fallback";
			fallback.textContent = "可放同名 preview 小图";
			image.replaceWith(fallback);
		}, { once: true });

		const copy = document.createElement("div");
		copy.className = "gjj-lora-preview-copy";
		copy.innerHTML = `
			<strong></strong>
			<span></span>
			<code></code>
			<span></span>
		`;
		copy.children[0].textContent = String(metadata.title || row.name || "");
		copy.children[1].textContent = String(metadata.summary || "");
		copy.children[2].textContent = String(metadata.trigger || "");
		copy.children[3].textContent = `推荐强度 ${formatStrength(metadata.strength, 1.0)}`;

		previewCard.appendChild(image);
		previewCard.appendChild(copy);

		previewButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openFloatingLoraPreview(previewCard, previewButton, image);
		});

		metaRow.appendChild(title);
		metaRow.appendChild(trigger);
		metaRow.appendChild(defaultStrength);
		const sourceButton = createSourceButton(metadata, "gjj-lora-source-btn");
		if (sourceButton) {
			metaRow.appendChild(sourceButton);
		}
		metaRow.appendChild(previewButton);
		mainColumn.appendChild(metaRow);
		mainColumn.appendChild(previewCard);
	}

	const sideColumn = document.createElement("div");
	sideColumn.className = "gjj-lora-side";
	sideColumn.appendChild(groupHint);
	sideColumn.appendChild(toggleWrap);
	sideColumn.appendChild(strength);

	if (thumbnailBox) rowElement.appendChild(thumbnailBox);
	rowElement.appendChild(mainColumn);
	rowElement.appendChild(sideColumn);
	rowsContainer.appendChild(rowElement);
}

function renderUi(node) {
	closeFloatingLoraPreview();
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
		node.__gjjLoraAdvancedButton.textContent = state.advancedOpen ? "收起设置" : "⚙️设置";
	}
	ensureAutoBroadcastForConfig(node);
	updateBroadcastButton(node);
	ensureConfigOutputs(node);
	applyClipPortVisibility(node);
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
	const [options, metadata] = await Promise.all([
		fetchLoraOptions(),
		fetchLoraMetadata(),
	]);
	state.options = options;
	state.metadata = metadata.metadata;
	state.previews = metadata.previews;
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
	advancedButton.textContent = "⚙️设置";
	advancedButton.title = "展开或收起 LoRA 互斥分组规则设置。";
	advancedButton.addEventListener("click", () => {
		updateAdvancedOpen(node, !ensureNodeState(node).advancedOpen);
		renderUi(node);
	});

	let broadcastButton = null;
	if (isConfigNode(node)) {
		ensureAutoBroadcastForConfig(node);
		broadcastButton = createBroadcastButton(node);
	}

	let clipPortsButton = null;
	if (isLoaderNode(node)) {
		clipPortsButton = document.createElement("button");
		clipPortsButton.className = "gjj-lora-clip-btn";
		clipPortsButton.type = "button";
		clipPortsButton.addEventListener("click", () => {
			const state = ensureNodeState(node);
			setClipPortsOpen(node, !state.clipPortsOpen);
			renderUi(node);
		});
	}

	toolbarMain.appendChild(globalSearch);
	if (broadcastButton) {
		toolbarMain.appendChild(broadcastButton);
	}
	toolbarMain.appendChild(refreshButton);
	toolbarMain.appendChild(advancedButton);
	if (clipPortsButton) {
		toolbarMain.appendChild(clipPortsButton);
	}
	toolbar.appendChild(toolbarMain);

	const advancedPanel = document.createElement("div");
	advancedPanel.className = "gjj-lora-advanced-panel";

	const rulesInput = document.createElement("textarea");
	rulesInput.className = "gjj-lora-rules-input";
	rulesInput.placeholder = "互斥分组规则\n👤 人物角色 = 紫灵,ziling,韩立,hanli\n⚡ 加速蒸馏 = flux,turbo,lightning,distilled\n🎬 LTX视频功能 = ltx,transition,转场";
	rulesInput.value = ensureNodeState(node).groupRulesText;
	rulesInput.title = "每行格式为“图标 分组名 = 关键词1,关键词2”，例如“👤 人物角色 = 紫灵,ziling,韩立”。图标会在命中后显示到行内；也兼容直接写“紫灵,韩立,国风”。";
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
	node.__gjjLoraBroadcastButton = broadcastButton;
	node.__gjjLoraClipPortsButton = clipPortsButton;
	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		updateDataWidget(this);
		if (typeof originalOnSerialize === "function") {
			originalOnSerialize.apply(this, arguments);
		}
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
		if (isConfigNode(this)) {
			serializedNode.properties[BROADCAST_PROPERTY] = broadcastEnabled(this);
			serializedNode.properties[BROADCAST_USER_SET_PROPERTY] = this.properties?.[BROADCAST_USER_SET_PROPERTY] === true;
			serializedNode.properties[LORA_TRIGGERS_PROPERTY] = buildSelectedLoraTriggerText(ensureNodeState(this));
		}
		if (isLoaderNode(this)) {
			const defs = currentLoaderOutputDefs(this);
			const enabledKeys = defs.slice(1).map((def) => def.key);
			serializedNode.properties[CLIP_PORTS_OPEN_PROPERTY] = Boolean(ensureNodeState(this).clipPortsOpen);
			serializedNode.properties[ENABLED_OUTPUTS_PROPERTY] = serializeOutputs(enabledKeys);
			writeSerializedOutputSlots(serializedNode, defs);
		}
	};
	node.addDOMWidget("LoRA 串联", "HTML", container, { serialize: false });

	applyClipPortVisibility(node);
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
		if (nodeData?.name === LOADER_NODE_NAME) {
			nodeData.output = ["MODEL", "CLIP", "FLOAT", "INT", "STRING"];
			nodeData.output_name = [
				MODEL_OUTPUT_NAME,
				CLIP_OUTPUT_NAME,
				ICLORA_FACTOR_OUTPUT_NAME,
				ICLORA_MULTIPLE_OUTPUT_NAME,
				TRIGGER_OUTPUT_NAME,
			];
			nodeData.output_tooltips = [
				"按当前节点中的 LoRA 顺序串联加载后的模型输出。",
				"输出叠加 LoRA 后的 CLIP；未接入 CLIP 时这里会返回空值。",
				"链中最后一个 IC-LoRA 的 latent_downscale_factor；没有 IC-LoRA 或 metadata 缺失时为 1.0。",
				"round(latent_downscale_factor * 32)，可直接用于参考图预处理到像素整倍数。",
				"当前启用 LoRA 的触发词；变量广播会自动添加到支持的正向提示词节点。",
			];
		}
		if (nodeData?.name === CONFIG_NODE_NAME) {
			nodeData.output = ["LORA_CHAIN_CONFIG"];
			nodeData.output_name = [
				CONFIG_OUTPUT_NAME,
			];
			nodeData.output_tooltips = [
				"由前端动态界面维护的 LoRA 串联配置，可直接接到支持该输入的节点。",
			];
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
				state.groupRulesText = String(this.properties?.[GROUP_RULES_PROPERTY] || DEFAULT_GROUP_RULES);
				state.advancedOpen = Boolean(this.properties?.[ADVANCED_OPEN_PROPERTY]);
				state.clipPortsOpen = normalizeBoolean(this.properties?.[CLIP_PORTS_OPEN_PROPERTY]);
				this.properties[LORA_TRIGGERS_PROPERTY] = buildSelectedLoraTriggerText(state);
				if (clipPortsHaveLinks(this)) {
					state.clipPortsOpen = true;
					this.properties[CLIP_PORTS_OPEN_PROPERTY] = true;
				}
				ensureAutoBroadcastForConfig(this);
				setupUi(this);
				renderUi(this);
			}, 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => {
				ensureAutoBroadcastForConfig(this);
				updateBroadcastButton(this);
				applyClipPortVisibility(this);
				markNodeDirty(this);
			}, 0);
			return result;
		};
	},
});

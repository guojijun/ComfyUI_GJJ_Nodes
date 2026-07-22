import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { GJJ_MODEL_DOWNLOAD_URL } from "./gjj_model_download_url.js";

const TARGET_NODE_APIS = {
	GJJ_VideoUniversalModelLoader: "/gjj/video_universal_loader_lists",
	GJJ_VideoKijaiModelLoader: "/gjj/video_kijai_loader_lists",
};
const TARGET_NODES = new Set(Object.keys(TARGET_NODE_APIS));
const LIST_API = "/gjj/video_universal_loader_lists";
const MAX_SLOTS = 12;
const SAVED_VALUES_PROPERTY = "gjj_video_universal_loader_values";
const METADATA_PROPERTY = "gjj_video_universal_loader_metadata";
const FILTER_PROPERTY = "gjj_video_universal_loader_filters";
const SETTINGS_OPEN_PROPERTY = "gjj_video_kijai_open_settings";
const SETTINGS_CONFIG_PROPERTY = "gjj_video_kijai_settings_config";
const BROADCAST_PROPERTY = "gjj_variable_broadcast_enabled";
const BROADCAST_USER_SET_PROPERTY = "gjj_variable_broadcast_user_set";
const LORA_BOOL_VARIABLE_PROPERTY = "gjj_video_universal_lora_bool_variable";
const OUTPUT_HIT_LANE = 20;
const WIDTH_PROPERTY = "gjj_video_universal_loader_width";
const DEFAULT_NODE_WIDTH = 470;
const DEFAULT_DTYPES = ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"];
const WEIGHT_DTYPES = ["bf16", "fp16", "fp32"];
const WEIGHT_DTYPE_CHOICES = ["default", ...WEIGHT_DTYPES];

const OUTPUT_TYPE_BY_KIND = {
	diffusion: "MODEL",
	checkpoint_model: "MODEL",
	checkpoint_clip: "CLIP",
	checkpoint_vae: "VAE",
	vae: "VAE",
	ltx_audio_vae: "VAE",
	clip: "CLIP",
	clip_vision: "CLIP_VISION",
	wanvideo_model: "WANVIDEOMODEL",
	wan_t5_encoder: "WANTEXTENCODER",
	wan_vae: "WANVAE",
	vace_model: "VACEPATH",
	extra_model: "VACEPATH",
	fantasytalking_model: "FANTASYTALKINGMODEL",
	multitalk_model: "MULTITALKMODEL",
	fantasyportrait_model: "FANTASYPORTRAITMODEL",
	wan_lora: "WANVIDLORA",
	audio_encoder: "AUDIO_ENCODER",
	empty: "*",
	latent_upscale_model: "LATENT_UPSCALE_MODEL",
	name: "STRING",
	name_any: "STRING",
};

const SETTING_FIELD_SUFFIXES = [
	"base_precision",
	"quantization",
	"load_device",
	"attention_mode",
	"rms_norm_function",
	"vae_precision",
	"vae_use_cpu_cache",
	"t5_precision",
	"t5_quantization",
	"t5_load_device",
	"extra_base_precision",
	"weight_dtype",
	"lora_strength",
	"lora_merge_loras",
	"lora_low_mem_load",
];
const WAN_BASE_PRECISIONS = ["fp32", "bf16", "fp16", "fp16_fast"];
const WAN_QUANTIZATIONS = ["disabled", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e4m3fn_scaled", "fp8_e4m3fn_scaled_fast", "fp8_e5m2", "fp8_e5m2_fast", "fp8_e5m2_scaled", "fp8_e5m2_scaled_fast"];
const WAN_LOAD_DEVICES = ["main_device", "offload_device"];
const WAN_ATTENTION_MODES = ["sdpa", "flash_attn_2", "flash_attn_3", "sageattn", "sageattn_3", "radial_sage_attention", "sageattn_compiled", "sageattn_ultravico", "comfy"];
const WAN_RMS_NORM_FUNCTIONS = ["default", "pytorch"];
const WAN_VAE_PRECISIONS = ["bf16", "fp16", "fp32"];
const WAN_T5_PRECISIONS = ["bf16", "fp32"];
const WAN_T5_QUANTIZATIONS = ["disabled", "fp8_e4m3fn"];
const EXTRA_BASE_PRECISIONS = ["fp16", "bf16", "fp32"];
const KIJAI_NODE_CLASS = "GJJ_VideoKijaiModelLoader";
const HELP_MODEL_FILE_EXT_RE = /\.(?:torchscript\.pt|safetensors|sft|ckpt|pt2|pth|pt|bin|gguf|pkl|onnx|engine)$/i;
const HELP_NON_MODEL_VALUES = new Set(["none", "null", "undefined", "default", "auto", "disabled", "false", "true", "未选择", "请选择"]);

const ALL_FIELDS = ["config", "use_accel_lora", "clip_type_override"];
for (let i = 1; i <= MAX_SLOTS; i++) {
	ALL_FIELDS.push(`file_${i}`, `secondary_file_${i}`, `dtype_${i}`);
	for (const suffix of SETTING_FIELD_SUFFIXES) ALL_FIELDS.push(`${suffix}_${i}`);
}

function getWidget(node, name) { return node.widgets?.find((w) => w?.name === name); }
function valueOf(node, name, fallback = "") { return String(getWidget(node, name)?.value ?? fallback ?? ""); }
function selectedLoraBoolVariable(node) {
	return String(node?.properties?.[LORA_BOOL_VARIABLE_PROPERTY] || "").trim();
}
function setSelectedLoraBoolVariable(node, name) {
	if (!node) return;
	node.properties = node.properties || {};
	const value = String(name || "").trim();
	if (value) node.properties[LORA_BOOL_VARIABLE_PROPERTY] = value;
	else delete node.properties[LORA_BOOL_VARIABLE_PROPERTY];
	node.__gjjVULoraToggleSync?.();
	saveWidgetValues(node);
	applyConfig(node);
}
function variableOptions(node) {
	const apiObject = globalThis.GJJ_VariableBroadcast;
	const graph = node?.graph || app.graph;
	return typeof apiObject?.getVisibleSetOptions === "function" ? (apiObject.getVisibleSetOptions(graph) || []) : [];
}
function variableOption(node, name) {
	return variableOptions(node).find((item) => item.value === name) || { value: name, label: name };
}
function variableDisplay(option) {
	const value = String(option?.value || "").trim();
	const label = String(option?.label || value).trim();
	const match = label.match(/^[^()（）]+[（(]([^()（）]+?)[\s·]+([^()（）]+?)[）)]$/);
	if (match) return { title: match[2].trim() || value, source: match[1].trim(), value };
	return { title: label || value, source: "", value };
}
function helpValueOf(node, name, fallback = "") {
	const widgetValue = String(getWidget(node, name)?.value ?? "").trim();
	const saved = node?.properties?.[SAVED_VALUES_PROPERTY]?.[name];
	const flat = node?.properties?.[`gjj_vu_value_${name}`];
	const savedValue = saved === undefined || saved === null ? "" : String(saved).trim();
	const flatValue = flat === undefined || flat === null ? "" : String(flat).trim();
	return widgetValue || savedValue || flatValue || String(fallback ?? "");
}
function safeAssign(obj, key, value) { try { obj[key] = value; } catch (_) {} }
function lower(text) { return String(text || "").replaceAll("\\", "/").toLowerCase(); }
function isKijaiNode(node) { return node?.comfyClass === KIJAI_NODE_CLASS; }

function looksLikeHelpModelFile(value) {
	const raw = String(value || "").trim();
	if (!raw || HELP_NON_MODEL_VALUES.has(raw.toLowerCase())) return false;
	const leaf = raw.replaceAll("\\", "/").split("/").pop() || raw;
	if (!leaf || !leaf.includes(".") || leaf.endsWith(".") || leaf.endsWith(".metadata.json")) return false;
	return HELP_MODEL_FILE_EXT_RE.test(leaf) || /\.[a-z0-9][a-z0-9_-]{1,15}$/i.test(leaf);
}

function firstHelpModelFile(...candidates) {
	for (const candidate of candidates) {
		const value = String(candidate || "").trim();
		if (looksLikeHelpModelFile(value)) return value;
	}
	return "";
}

const SEARCH_DROP_TOKENS = new Set([
	"fp", "fp8", "fp16", "fp32", "bf16", "int8", "int4", "nf4", "nvfp4", "mxfp4",
	"e4m3", "e4m3fn", "e5m2", "gguf", "bnb4bit", "bitsandbytes", "quant", "quantized",
	"input", "scaled", "scale", "fast", "dtype", "weight", "weights", "only",
]);
const SEARCH_KEEP_TOKENS = new Set(["t2v", "i2v", "s2v", "ti2v", "flf2v", "f2v", "vace", "x2"]);

function stripModelExtension(value) {
	return String(value || "")
		.replaceAll("\\", "/")
		.replace(/\.(torchscript\.pt|safetensors|ckpt|pt2|pth|pt|bin|gguf|sft|pkl)$/i, "");
}

function cleanSearchToken(token) {
	let value = String(token || "").trim().toLowerCase();
	if (!value) return "";
	if (SEARCH_KEEP_TOKENS.has(value)) return value;
	if (["wan21", "wan22", "ltx23"].includes(value)) return value;
	if (value === "wan2") return "wan";
	if (/^ltx(?:2(?:3)?)$/.test(value)) return "ltx";
	if (/^gemma\d+$/.test(value)) return "gemma";
	if (SEARCH_DROP_TOKENS.has(value)) return "";
	if (/^v?\d+(?:\.\d+)*$/.test(value)) return "";
	if (/^\d+(?:\.\d+)?b$/.test(value)) return "";
	if (/^(?:rank|dim|r)\d+$/.test(value)) return "";
	if (/^q\d(?:[_a-z0-9]*)?$/.test(value)) return "";
	if (/^(?:fp|bf|int)\d+(?:[_a-z0-9]*)?$/.test(value)) return "";
	if (/^e[45]m[23]fn?$/.test(value)) return "";
	return value;
}

function cleanSearchTokens(value) {
	let text = stripModelExtension(value).toLowerCase();
	text = text
		.replace(/wan[\s._-]*2[\s._-]*1(?=$|[\s._-])/g, " wan21 wan ")
		.replace(/wan[\s._-]*2[\s._-]*2(?=$|[\s._-])/g, " wan22 wan ")
		.replace(/\bwan[\s._-]*21(?=$|[\s._-])/g, " wan21 wan ")
		.replace(/\bwan[\s._-]*22(?=$|[\s._-])/g, " wan22 wan ")
		.replace(/\bltx[\s._-]*2[\s._-]*3(?=$|[\s._-])/g, " ltx23 ltx ")
		.replace(/\bltx23(?=$|[\s._-])/g, " ltx23 ltx ")
		.replace(/\bgemma[\s._-]*3\b/g, " gemma ");
	const seen = new Set();
	const tokens = [];
	for (const part of text.replace(/[^0-9a-z\u4e00-\u9fff]+/g, " ").split(/\s+/)) {
		const token = cleanSearchToken(part);
		if (token && !seen.has(token)) {
			seen.add(token);
			tokens.push(token);
		}
	}
	return tokens;
}

function currentNodeWidth(node) {
	const current = Number(node?.size?.[0] || 0);
	const saved = Number(node?.properties?.[WIDTH_PROPERTY] || 0);
	const width = current || saved || DEFAULT_NODE_WIDTH;
	return Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_NODE_WIDTH;
}

function rememberNodeWidth(node) {
	if (!node) return DEFAULT_NODE_WIDTH;
	node.properties = node.properties || {};
	const width = currentNodeWidth(node);
	node.properties[WIDTH_PROPERTY] = width;
	delete node.min_width;
	delete node.minWidth;
	return width;
}

function collapseElement(el) {
	if (!el?.style) return;
	el.style.display = "none"; el.style.pointerEvents = "none"; el.style.height = "0px";
	el.style.minHeight = "0px"; el.style.maxHeight = "0px"; el.style.margin = "0px";
	el.style.padding = "0px"; el.style.border = "0px"; el.style.overflow = "hidden";
}

function hideWidget(w) {
	if (!w || w.__gjjVideoUniversalKeep) return;
	safeAssign(w, "hidden", true);
	safeAssign(w, "type", `converted-widget:${w.name || "hidden"}`);
	safeAssign(w, "label", "");
	w.computeSize = () => [0, -4];
	w.getHeight = () => -4;
	w.draw = () => {};
	safeAssign(w, "y", 0); safeAssign(w, "last_y", 0); safeAssign(w, "size", [0, -4]); safeAssign(w, "height", -4);
	safeAssign(w, "serialize", true);
	if (w.options && typeof w.options === "object") { w.options.hidden = true; w.options.display = "hidden"; }
	collapseElement(w.inputEl); collapseElement(w.element); collapseElement(w.widget);
}
function hideNativeWidgets(node) { for (const name of ALL_FIELDS) hideWidget(getWidget(node, name)); }

function comboValues(w) {
	const values = w?.options?.values || w?.options?.values_list || w?.options?.items || [];
	return Array.isArray(values) ? values.map(String) : [];
}

function setComboOptions(w, values) {
	if (!w) return;
	const list = Array.isArray(values) ? values.map(String) : [];
	w.options = w.options || {};
	w.options.values = list; w.options.values_list = list; w.options.items = list;
	if (w.__gjjVUInput?.tagName === "SELECT") fillSelect(w.__gjjVUInput, list);
	if (typeof w.__gjjVUSetOptions === "function") w.__gjjVUSetOptions(list);
}

function fillSelect(select, values, labels = null) {
	select.replaceChildren();
	(values || []).forEach((value) => {
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = labels?.[value] || String(value);
		select.appendChild(option);
	});
}

const OFFICIAL_DROP_TOKENS = new Set([
	...SEARCH_DROP_TOKENS,
	"f16",
	"mixed",
]);

function modelStem(value) {
	return stripModelExtension(String(value || "").replaceAll("\\", "/").split("/").pop() || "");
}

function officialMatchKey(value) {
	let text = modelStem(value).toLowerCase();
	text = text
		.replace(/wan[\s._-]*2[\s._-]*1(?=$|[\s._-])/g, " wan21 ")
		.replace(/wan[\s._-]*2[\s._-]*2(?=$|[\s._-])/g, " wan22 ")
		.replace(/\bwan[\s._-]*21(?=$|[\s._-])/g, " wan21 ")
		.replace(/\bwan[\s._-]*22(?=$|[\s._-])/g, " wan22 ")
		.replace(/\bltx[\s._-]*2[\s._-]*3(?=$|[\s._-])/g, " ltx23 ")
		.replace(/\bltx23(?=$|[\s._-])/g, " ltx23 ");
	const kept = [];
	for (const part of text.replace(/[^0-9a-z\u4e00-\u9fff]+/g, " ").split(/\s+/)) {
		const token = part.trim().toLowerCase();
		if (!token || OFFICIAL_DROP_TOKENS.has(token)) continue;
		if (/^(?:fp|bf|int)\d+(?:[_a-z0-9]*)?$/.test(token)) continue;
		if (/^e[45]m[23]fn?$/.test(token)) continue;
		if (/^q\d(?:[_a-z0-9]*)?$/.test(token) || ["k", "m", "s", "xl", "xs", "xxl"].includes(token)) continue;
		kept.push(token);
	}
	return kept.join("");
}

function longestCommonSubstringLength(a, b) {
	if (!a || !b) return 0;
	let shorter = String(a);
	let longer = String(b);
	if (shorter.length > longer.length) [shorter, longer] = [longer, shorter];
	let previous = new Array(shorter.length + 1).fill(0);
	let best = 0;
	for (const charB of longer) {
		const current = new Array(shorter.length + 1).fill(0);
		for (let i = 1; i <= shorter.length; i++) {
			if (shorter[i - 1] === charB) {
				current[i] = previous[i - 1] + 1;
				if (current[i] > best) best = current[i];
			}
		}
		previous = current;
	}
	return best;
}

function officialNameSeeds(...values) {
	const result = [];
	const seen = new Set();
	for (const value of values || []) {
		const items = Array.isArray(value) ? value : [value];
		for (const item of items) {
			const text = String(item || "").trim();
			const key = text.replaceAll("\\", "/").toLowerCase();
			if (text && !seen.has(key)) {
				seen.add(key);
				result.push(text);
			}
		}
	}
	return result;
}

function bestOfficialNameMatch(names, seeds, allowAny = false) {
	const usable = (Array.isArray(names) ? names : [])
		.map(String)
		.filter((name) => isUsable(name, allowAny));
	const sourceSeeds = officialNameSeeds(seeds);
	if (!usable.length || !sourceSeeds.length) return "";

	const byFull = new Map();
	const byBase = new Map();
	for (const name of usable) {
		const full = name.replaceAll("\\", "/").toLowerCase();
		const base = full.split("/").pop();
		if (!byFull.has(full)) byFull.set(full, name);
		if (base && !byBase.has(base)) byBase.set(base, name);
	}
	for (const seed of sourceSeeds) {
		const full = seed.replaceAll("\\", "/").trim().toLowerCase();
		const base = full.split("/").pop();
		if (byFull.has(full)) return byFull.get(full);
		if (base && byBase.has(base)) return byBase.get(base);
	}

	let best = "";
	let bestScore = [0, 0, 0, ""];
	const seedKeys = sourceSeeds.map(officialMatchKey).filter(Boolean);
	for (const name of usable) {
		const candidateKey = officialMatchKey(name);
		if (!candidateKey) continue;
		for (const seedKey of seedKeys) {
			let score;
			if (candidateKey === seedKey) {
				score = [100000 + seedKey.length, seedKey.length, -Math.abs(candidateKey.length - seedKey.length), name.toLowerCase()];
			} else if (seedKey.includes(candidateKey) || candidateKey.includes(seedKey)) {
				const common = Math.min(seedKey.length, candidateKey.length);
				score = [50000 + common, common, -Math.abs(candidateKey.length - seedKey.length), name.toLowerCase()];
			} else {
				const common = longestCommonSubstringLength(candidateKey, seedKey);
				score = [common, common, -Math.abs(candidateKey.length - seedKey.length), name.toLowerCase()];
			}
			for (let i = 0; i < score.length; i++) {
				if (score[i] === bestScore[i]) continue;
				if (score[i] > bestScore[i]) {
					bestScore = score;
					best = name;
				}
				break;
			}
		}
	}
	return bestScore[1] >= 6 ? best : "";
}

function preferredNamesForSlot(slot, secondary = false) {
	if (secondary) {
		return officialNameSeeds(slot?.secondary_name, slot?.secondary_official_names || [], slot?.secondary_preferred_name);
	}
	return officialNameSeeds(slot?.required_name, slot?.preferred_name, slot?.official_names || []);
}

function selectFirstIfInvalid(node, name, values, preferred = "", forcePreferred = false) {
	const w = getWidget(node, name); if (!w) return;
	const list = Array.isArray(values) ? values.map(String) : [];
	const cur = String(w.value ?? "");
	const preferredSeeds = officialNameSeeds(preferred);
	const matched = bestOfficialNameMatch(list, preferredSeeds, true);
	if ((forcePreferred && matched && cur !== matched) || !cur || !list.includes(cur)) {
		if (matched) w.value = matched;
		else w.value = list[0] || "";
		w.callback?.(w.value);
	}
	if (w.__gjjVUInput && "value" in w.__gjjVUInput) w.__gjjVUInput.value = String(w.value ?? "");
	if (typeof w.__gjjVUSetValue === "function") w.__gjjVUSetValue(String(w.value ?? ""), false);
	saveWidgetValues(node);
}

function isUsable(name, allowAny = false) {
	const v = lower(name).trim();
	if (!v || v.endsWith(".metadata.json")) return false;
	if (allowAny) return /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|torchscript\.pt)$/i.test(v);
	return /\.(safetensors|sft|ckpt|pt|pth|gguf)$/i.test(v);
}

function matchText(text) {
	return cleanSearchTokens(text).join(" ");
}

function splitWords(text) { return lower(text).trim().split(/[\s,，;；|]+/).filter(Boolean); }

function scoreName(name, keywords = []) {
	const text = matchText(name); let score = 0;
	normalizeKeywords(keywords).forEach((word, idx) => {
		if (text.includes(word)) score += 100 - idx;
		if (text.split(/\s+/).includes(word)) score += 10;
	});
	if (lower(name).endsWith(".safetensors")) score += 10;
	score -= (text.match(/\//g) || []).length;
	return score;
}

function normalizeKeywords(keywords = []) {
	const result = [];
	const seen = new Set();
	for (const value of keywords || []) {
		for (const token of cleanSearchTokens(value)) {
			if (token && !seen.has(token)) {
				seen.add(token);
				result.push(token);
			}
		}
	}
	return result;
}

function wantsGgufOnly(keywords = [], fileExtension = "") {
	if (String(fileExtension || "").trim().toLowerCase() === "gguf") return true;
	return (keywords || []).some((value) => /\bgguf\b|\.gguf(?:$|[?#])/i.test(String(value || "")));
}

function applyExtensionConstraints(values, keywords = [], fileExtension = "") {
	const list = Array.isArray(values) ? values : [];
	if (wantsGgufOnly(keywords, fileExtension)) {
		return list.filter((name) => lower(name).endsWith(".gguf"));
	}
	return list;
}

function filterList(list, keywords = [], allowAny = false, fallbackKeywords = [], fileExtension = "") {
	const words = normalizeKeywords(keywords);
	const source = applyExtensionConstraints(
		Array.isArray(list) ? list.filter((name) => isUsable(name, allowAny)) : [],
		keywords,
		fileExtension
	);
	const findMatches = (group) => group.length ? source.filter((name) => {
		const text = matchText(name);
		return group.every((word) => text.includes(word));
	}) : source;
	let matched = findMatches(words);
	const groups = Array.isArray(fallbackKeywords) ? fallbackKeywords : [];
	for (const group of groups) {
		if (matched.length) break;
		if (!Array.isArray(group)) continue;
		matched = findMatches(normalizeKeywords(group));
	}
	return matched.slice().sort((a, b) => {
		const diff = scoreName(b, words) - scoreName(a, words);
		if (diff !== 0) return diff;
		return String(a).localeCompare(String(b), "zh-Hans-CN");
	});
}

function ensureState(node) {
	node.__gjjVUState = node.__gjjVUState || {
		configs: null,
		folders: null,
		dtypes: DEFAULT_DTYPES,
		clipTypes: ["auto", "wan", "ltxv", "hunyuan_video", "flux", "stable_diffusion"],
		loading: false,
	};
	return node.__gjjVUState;
}

function listApiFor(node) {
	return TARGET_NODE_APIS[node?.comfyClass] || LIST_API;
}

async function refreshBackendLists(node, rerender = true) {
	const state = ensureState(node);
	if (state.loading) return;
	state.loading = true;
	try {
		const response = await fetch(listApiFor(node));
		if (response?.ok) {
			const payload = await response.json();
			state.configs = payload?.configs || state.configs;
			state.folders = payload?.folders || state.folders;
			state.dtypes = Array.isArray(payload?.dtypes) ? payload.dtypes.map(String) : state.dtypes;
			state.clipTypes = Array.isArray(payload?.clip_types) ? payload.clip_types.map(String) : state.clipTypes;
		}
	} catch (error) {
		console.warn("[GJJ Video Loader] 模型列表读取失败", error);
	} finally {
		state.loading = false;
	}
	if (rerender) applyConfig(node);
}

function protect(el) {
	if (!el || el.__gjjVUProtected) return;
	el.__gjjVUProtected = true;
	for (const ev of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		el.addEventListener(ev, (event) => event.stopPropagation());
	}
}

function broadcastEnabled(node) {
	return Boolean(node?.properties?.[BROADCAST_PROPERTY]);
}

function ensureDefaultBroadcastEnabled(node) {
	if (!node) return;
	node.properties = node.properties || {};
	if (node.properties[BROADCAST_USER_SET_PROPERTY] !== true) {
		node.properties[BROADCAST_PROPERTY] = true;
	}
}

function notifyBroadcastChanged(node) {
	try { app.canvas?.setDirty?.(true, true); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try {
		window.dispatchEvent(new CustomEvent("gjj-variable-broadcast-updated", {
			detail: { nodeId: node?.id, enabled: broadcastEnabled(node) },
		}));
	} catch (_) {}
}

function updateBroadcastButton(node) {
	const button = node?.__gjjVUBroadcastButton;
	if (!button) return;
	const enabled = broadcastEnabled(node);
	button.dataset.value = enabled ? "true" : "false";
	button.classList.toggle("on", enabled);
	button.setAttribute("aria-pressed", String(enabled));
	button.title = enabled
		? "🔍 已开启：当前 Loader 的每个可见输出口会按接口名称/类型广播到未连接的同名输入。"
		: "🔍 已关闭：只通过真实连线传递模型对象。";
}

function setBroadcastEnabled(node, enabled, userSet = true) {
	if (!node) return;
	node.properties = node.properties || {};
	if (userSet) node.properties[BROADCAST_USER_SET_PROPERTY] = true;
	node.properties[BROADCAST_PROPERTY] = Boolean(enabled);
	updateBroadcastButton(node);
	saveWidgetValues(node);
	notifyBroadcastChanged(node);
}

function createBroadcastButton(node) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-vu-broadcast";
	button.textContent = "⚡";
	button.setAttribute("aria-label", "切换输出广播");
	protect(button);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setBroadcastEnabled(node, !broadcastEnabled(node));
	});
	node.__gjjVUBroadcastButton = button;
	updateBroadcastButton(node);
	return button;
}

if (!window.__gjjVUClosePopupBound) {
	window.__gjjVUClosePopupBound = true;
	document.addEventListener("pointerdown", () => closeSearchPopup?.());
}

function syncWidget(node, name, value) {
	const w = getWidget(node, name); if (!w) return;
	let next = value;
	if (typeof w.value === "boolean") next = Boolean(value);
	else if (typeof w.value === "number") next = Number.parseFloat(value);
	if (typeof w.__gjjVUSetValue === "function") {
		w.__gjjVUSetValue(String(next ?? ""), false);
	} else {
		w.value = next;
		w.callback?.(next);
		if (w.__gjjVUInput && "value" in w.__gjjVUInput) w.__gjjVUInput.value = String(w.value ?? "");
	}
	saveWidgetValues(node);
}

function quantizationFromModelName(value) {
	const raw = String(value || "").replaceAll("\\", "/").toLowerCase();
	if (!raw) return "";
	if (/\.gguf(?:$|[?#])/.test(raw)) return "disabled";
	const text = raw.replace(/[\s.\-]+/g, "_");
	if (text.includes("int4_convrot") || text.includes("int8_convrot")) return "disabled";
	if (!text.includes("fp8")) return "";
	const e5 = text.includes("e5m2");
	if (/fp8_(?:e4m3fn_|e5m2_)?scaled_fast|fp8_scaled_(?:e4m3fn_|e5m2_)?fast/.test(text)) {
		return e5 ? "fp8_e5m2_scaled_fast" : "fp8_e4m3fn_scaled_fast";
	}
	if (/fp8_(?:e4m3fn_|e5m2_)?scaled|fp8_scaled(?:_(?:e4m3fn|e5m2))?/.test(text)) {
		return e5 ? "fp8_e5m2_scaled" : "fp8_e4m3fn_scaled";
	}
	if (e5) return text.includes("fast") ? "fp8_e5m2_fast" : "fp8_e5m2";
	return text.includes("fast") ? "fp8_e4m3fn_fast" : "fp8_e4m3fn";
}

function syncBasePrecisionFromModelName(node, slot, index, fileValue) {
	if (String(slot?.kind || "") !== "wanvideo_model") return;
	const text = String(fileValue || "").replaceAll("\\", "/").toLowerCase().replace(/[\s.\-]+/g, "_");
	if (!text.includes("int4_convrot") && !text.includes("int8_convrot")) return;
	const name = settingName("base_precision", index);
	if (String(getWidget(node, name)?.value ?? "") === "bf16") return;
	syncWidget(node, name, "bf16");
}

function dtypeFromModelName(value) {
	const raw = modelBaseName(value).toLowerCase().replace(/[^0-9a-z]+/g, "_");
	if (raw.includes("fp8")) return raw.includes("e5m2") ? "fp8_e5m2" : "fp8_e4m3fn";
	for (const dtype of ["fp16", "bf16", "fp32"]) {
		if (new RegExp(`(?:^|_)${dtype}(?:_|$)`).test(raw)) return dtype;
	}
	return "";
}

function weightDtypeFromModelName(value) {
	const raw = modelBaseName(value).toLowerCase().replace(/[^0-9a-z]+/g, "_");
	for (const dtype of WEIGHT_DTYPES) {
		if (new RegExp(`(?:^|_)${dtype}(?:_|$)`).test(raw)) return dtype;
	}
	return "";
}

function syncQuantizationFromModelName(node, slot, index, fileValue) {
	if (String(slot?.kind || "") !== "wanvideo_model") return;
	const quantization = quantizationFromModelName(fileValue);
	if (!quantization || !WAN_QUANTIZATIONS.includes(quantization)) return;
	const name = settingName("quantization", index);
	if (String(getWidget(node, name)?.value ?? "") === quantization) return;
	syncWidget(node, name, quantization);
}

function syncDtypeFromModelName(node, slot, index, fileValue) {
	if (!slotNeedsDtype(slot)) return;
	const inferred = dtypeFromModelName(fileValue);
	const allowed = ensureState(node).dtypes || DEFAULT_DTYPES;
	if (!inferred || !allowed.includes(inferred)) return;
	const name = `dtype_${index}`;
	if (String(getWidget(node, name)?.value ?? "") === inferred) return;
	syncWidget(node, name, inferred);
}

function syncWeightDtypeFromModelName(node, slot, index, fileValue) {
	if (String(slot?.loader || "") !== "gjj_vae") return;
	const inferred = weightDtypeFromModelName(fileValue) || String(slot?.weight_dtype || "bf16");
	if (!WEIGHT_DTYPES.includes(inferred)) return;
	const name = settingName("weight_dtype", index);
	if (String(getWidget(node, name)?.value ?? "") === inferred) return;
	syncWidget(node, name, inferred);
}

function syncDerivedSettingsFromModelName(node, slot, index, fileValue) {
	syncBasePrecisionFromModelName(node, slot, index, fileValue);
	syncQuantizationFromModelName(node, slot, index, fileValue);
	syncDtypeFromModelName(node, slot, index, fileValue);
	syncWeightDtypeFromModelName(node, slot, index, fileValue);
}

function getFilters(node) {
	node.properties = node.properties || {};
	node.properties[FILTER_PROPERTY] = node.properties[FILTER_PROPERTY] || {};
	return node.properties[FILTER_PROPERTY];
}
function getFilter(node, key) { return String(getFilters(node)?.[key] ?? ""); }
function setFilter(node, key, value) { getFilters(node)[key] = String(value || ""); }

let ACTIVE_GJJ_VU_POPUP = null;

function closeSearchPopup() {
	if (ACTIVE_GJJ_VU_POPUP?.remove) ACTIVE_GJJ_VU_POPUP.remove();
	ACTIVE_GJJ_VU_POPUP = null;
}

function displayNameForValue(value, labels = null) {
	return labels?.[value] || String(value || "");
}

function modelBaseName(value) {
	return String(value || "")
		.replaceAll("\\", "/")
		.split("/")
		.pop()
		.replace(/\.(safetensors|sft|ckpt|pt|pth|bin|gguf|torchscript\.pt)$/i, "");
}

function modelMatchKey(value) {
	return matchText(modelBaseName(value))
		.replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

function exactLowPairKeyFromHigh(value) {
	const replaced = modelBaseName(value).toLowerCase().replace(
		/(^|[^a-z0-9])high(?=$|[^a-z0-9])/,
		"$1low"
	);
	return replaced.replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

function exactModelKey(value) {
	return modelBaseName(value).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

function modelQuantizationKey(value) {
	const text = modelBaseName(value).toLowerCase();
	const match = text.match(/(?:^|[^a-z0-9])(int4|int8|fp8|fp16|fp32|bf16|q[2-8](?:[_-][kms])?)(?=$|[^a-z0-9])/i);
	return String(match?.[1] || "").replaceAll("-", "_").toLowerCase();
}

function modelPrefixBeforeMarker(value, marker) {
	const raw = matchText(modelBaseName(value));
	const index = raw.indexOf(String(marker || "").toLowerCase());
	if (index < 0) return "";
	return modelMatchKey(raw.slice(0, index));
}

function modelSuffixAfterMarker(value, marker) {
	const word = String(marker || "").toLowerCase();
	const raw = matchText(modelBaseName(value));
	const index = raw.indexOf(word);
	if (index < 0) return "";
	return modelMatchKey(raw.slice(index + word.length));
}

function slotPairText(slot) {
	return [
		slot?.id,
		slot?.label,
		slot?.kind,
		slot?.target,
		...(Array.isArray(slot?.keywords) ? slot.keywords : []),
	].map((item) => String(item || "")).join(" ").toLowerCase();
}

function isPairableModelSlot(slot) {
	// High/Low 主模型与加速 LoRA 使用同一套配对规则。LoRA 槽位的
	// kind 通常是 name，但 folder=loras，可以安全地和普通模型区分。
	if (isLoraSlot(slot)) return true;
	const kind = String(slot?.kind || "");
	return ["diffusion", "checkpoint_model", "wanvideo_model"].includes(kind);
}

function isHighModelSlot(slot) {
	const text = slotPairText(slot);
	return isPairableModelSlot(slot) && (text.includes("high") || text.includes("高"));
}

function isLowModelSlot(slot) {
	const text = slotPairText(slot);
	return isPairableModelSlot(slot) && (text.includes("low") || text.includes("低"));
}

function pairKeywordSet(slot) {
	return new Set((Array.isArray(slot?.keywords) ? slot.keywords : [])
		.map((item) => matchText(item).trim())
		.filter((item) => item && !["high", "low", "高", "低"].includes(item)));
}

function findPairedLowSlot(cfg, highSlot, highIndex) {
	const slots = (cfg?.slots || []).slice(0, MAX_SLOTS);
	const highKeywords = pairKeywordSet(highSlot);
	let best = null;
	let bestScore = -1;
	slots.forEach((slot, index) => {
		if (index === highIndex || !isLowModelSlot(slot)) return;
		let score = 0;
		if (String(slot?.folder || "") === String(highSlot?.folder || "")) score += 20;
		if (index === highIndex + 1) score += 12;
		if (index > highIndex) score += 4;
		for (const keyword of pairKeywordSet(slot)) {
			if (highKeywords.has(keyword)) score += 3;
		}
		if (score > bestScore) {
			bestScore = score;
			best = { slot, index };
		}
	});
	return best;
}

function scoreLowModelCandidate(highValue, lowValue) {
	const exactLowKey = exactLowPairKeyFromHigh(highValue);
	const exactCandidateKey = exactModelKey(lowValue);
	const highPrefixRaw = modelPrefixBeforeMarker(highValue, "high");
	const highPrefix = highPrefixRaw.length >= 4 ? highPrefixRaw : "";
	const highToLowKey = highPrefix
		? `${highPrefix}low${modelSuffixAfterMarker(highValue, "high")}`
		: "";
	const lowKey = modelMatchKey(lowValue);
	const lowPrefix = modelPrefixBeforeMarker(lowValue, "low");
	if (!lowKey) return -Infinity;

	let score = -Infinity;
	if (exactLowKey && exactCandidateKey === exactLowKey) score = Math.max(score, 100000);
	if (highToLowKey && lowKey === highToLowKey) score = Math.max(score, 50000);
	if (highPrefix && lowPrefix && lowPrefix === highPrefix) score = Math.max(score, 40000 + Math.min(highPrefix.length, 200));
	if (highPrefix && lowKey.startsWith(highPrefix)) score = Math.max(score, 30000 + Math.min(highPrefix.length, 200));
	if (highPrefix && lowKey.includes(highPrefix)) score = Math.max(score, 20000 + Math.min(highPrefix.length, 200));
	if (!Number.isFinite(score)) return -Infinity;
	const highQuantization = modelQuantizationKey(highValue);
	const lowQuantization = modelQuantizationKey(lowValue);
	if (highQuantization && lowQuantization) {
		score += highQuantization === lowQuantization ? 5000 : -5000;
	}
	if (matchText(lowValue).includes("low") || String(lowValue || "").includes("低")) score += 500;
	return score;
}

function matchingLowModelForHigh(highValue, lowValues) {
	let best = "";
	let bestScore = -Infinity;
	(lowValues || []).forEach((value, index) => {
		const score = scoreLowModelCandidate(highValue, value);
		if (score > bestScore || (score === bestScore && index === 0)) {
			best = String(value || "");
			bestScore = score;
		}
	});
	return Number.isFinite(bestScore) ? best : "";
}

function syncPairedLowModelFromHigh(node, cfg, highSlot, highIndex, highValue, state) {
	if (!isHighModelSlot(highSlot) || !String(highValue || "").trim()) return;
	const pair = findPairedLowSlot(cfg, highSlot, highIndex);
	if (!pair) return;
	const lowSlot = pair.slot;
	const lowWidgetName = `file_${pair.index + 1}`;
	const lowWidget = getWidget(node, lowWidgetName);
	if (!lowWidget) return;
	const folder = String(lowSlot.folder || "");
	const sourceList = state?.folders?.[folder] || comboValues(lowWidget);
	const lowValues = filterList(
		sourceList,
		lowSlot.keywords || [],
		String(lowSlot.kind || "") === "name_any",
		lowSlot.fallback_keywords || [],
		lowSlot.file_extension || ""
	);
	const matched = matchingLowModelForHigh(highValue, lowValues);
	if (!matched || String(lowWidget.value ?? "") === matched) return;
	if (typeof lowWidget.__gjjVUSetValue === "function") {
		lowWidget.__gjjVUSetValue(matched, false);
	} else {
		lowWidget.value = matched;
		lowWidget.callback?.(matched);
	}
	syncDerivedSettingsFromModelName(node, lowSlot, pair.index + 1, matched);
	saveWidgetValues(node);
}

function uniqueList(values) {
	const result = [];
	const seen = new Set();
	for (const value of values || []) {
		const text = String(value || "").replace(/^models[\\/]/i, "").replace(/^[/\\]+|[/\\]+$/g, "");
		const key = text.toLowerCase();
		if (text && !seen.has(key)) {
			seen.add(key);
			result.push(text);
		}
	}
	return result;
}

function slotSearchFolders(slot, fallbackFolder = "") {
	const values = [fallbackFolder || slot?.folder || ""];
	const extra = slot?.search_folders;
	if (typeof extra === "string") values.push(extra);
	else if (Array.isArray(extra)) values.push(...extra);
	if (values.includes("diffusion_models")) values.push("unet_gguf");
	if (String(slot?.kind || "").toLowerCase() === "latent_upscale_model") {
		values.push("latent_upscale_models", "upscale_models");
	}
	return uniqueList(values);
}

function slotSearchFolderLabel(slot, fallbackFolder = "") {
	const folders = slotSearchFolders(slot, fallbackFolder);
	return folders.length ? folders.join(" / ") : "ComfyUI 已配置模型分类";
}

function slotListForState(state, slot, fallbackFolder = "") {
	const result = [];
	const seen = new Set();
	for (const folder of slotSearchFolders(slot, fallbackFolder)) {
		for (const name of state?.folders?.[folder] || []) {
			const text = String(name || "");
			const key = text.replaceAll("\\", "/").toLowerCase();
			if (text && !seen.has(key)) {
				seen.add(key);
				result.push(text);
			}
		}
	}
	return result;
}

function downloadUrlForSlot(slot, expectedName) {
	return GJJ_MODEL_DOWNLOAD_URL;
}

function missingModelForSlot(slot, values, secondary = false) {
	const seeds = preferredNamesForSlot(slot, secondary).filter(looksLikeHelpModelFile);
	if (!seeds.length) return "";
	const list = Array.isArray(values) ? values.map(String) : [];
	if (bestOfficialNameMatch(list, seeds, true)) return "";
	return firstHelpModelFile(...seeds);
}

function addVideoHelpModelEntry(entries, slot, index, filename, labelOverride = "") {
	const name = String(filename || "").trim();
	if (!name || String(slot?.kind || "") === "empty" || !looksLikeHelpModelFile(name)) return;
	entries.push({
		label: labelOverride || String(slot?.label || slot?.id || `模型${index + 1}`),
		folder: String(slot?.folder || ""),
		kind: String(slot?.kind || ""),
		value: name,
		icon: isLoraSlot(slot) ? "🟠" : officialIconFor(slot),
	});
}

function currentHelpConfigKey(node, state) {
	return activeConfigKey(node, state);
}

function helpModelFileForSlot(node, state, slot, index, secondary = false) {
	const folder = String(slot?.folder || "");
	const allowAny = String(slot?.kind || "") === "name_any";
	const sourceList = slotListForState(state, slot, folder);
	const values = secondary
		? sourceList.map(String)
		: filterList(sourceList, slot?.keywords || [], allowAny, slot?.fallback_keywords || [], slot?.file_extension || "");
	// 与主面板共用同一缺失判定。即使 fallback 关键词能匹配到其它本地模型，
	// 当前预设要求的官方模型不存在时，帮助树也应显示缺失的目标文件，
	// 不能把不兼容的候选模型当作已选模型展示。
	const missing = missingModelForSlot(slot, values, secondary);
	if (missing) return missing;
	const current = firstHelpModelFile(helpValueOf(node, `${secondary ? "secondary_file" : "file"}_${index + 1}`));
	const normalizedValues = new Set(values.map((value) => String(value).replaceAll("\\", "/").toLowerCase()));
	const currentKey = current.replaceAll("\\", "/").toLowerCase();
	if (current && (!values.length || normalizedValues.has(currentKey))) return current;
	if (current) {
		const currentBase = currentKey.split("/").pop();
		const matched = values.find((value) => String(value).replaceAll("\\", "/").toLowerCase().split("/").pop() === currentBase);
		if (matched) return matched;
	}
	const seeds = secondary
		? preferredNamesForSlot(slot, true)
		: preferredNamesForSlot(slot);
	const matched = bestOfficialNameMatch(values, seeds, true);
	return firstHelpModelFile(matched, ...seeds);
}

function videoLoaderHelpEntries(node) {
	const state = ensureState(node);
	try { saveWidgetValues(node); } catch (_) {}
	// 帮助树只读取当前下拉键对应的预设槽位。配置尚未就绪时返回空树，
	// 不能使用旧快照兜底，否则会显示上一个预设的模型。
	const key = currentHelpConfigKey(node, state);
	const cfg = state.configs?.[key] || null;
	if (!cfg) return [];
	const entries = [];
	const loraEnabled = effectiveUseLora(node);
	(cfg.slots || []).slice(0, MAX_SLOTS).forEach((slot, index) => {
		if (!slot || String(slot.kind || "") === "empty") return;
		if (isLoraSlot(slot) && !loraEnabled) return;
		const fileName = firstHelpModelFile(
			helpModelFileForSlot(node, state, slot, index),
			slot.required_name,
			slot.preferred_name,
			...(Array.isArray(slot.official_names) ? slot.official_names : [])
		);
		addVideoHelpModelEntry(entries, slot, index, fileName);
		if (isDualClipSlot(slot)) {
			const secondaryName = firstHelpModelFile(
				helpModelFileForSlot(node, state, slot, index, true),
				slot.secondary_name,
				...(Array.isArray(slot.secondary_official_names) ? slot.secondary_official_names : [])
			);
			addVideoHelpModelEntry(entries, slot, index, secondaryName, String(slot.secondary_label || "另一个模型"));
		}
	});
	return entries;
}

function attachHelpModelProvider(node) {
	node.__gjjHelpModelEntries = () => videoLoaderHelpEntries(node);
	node.__gjjHelpModelTreeEntries = node.__gjjHelpModelEntries;
	node.__gjjModelHelpEntries = node.__gjjHelpModelEntries;
}

function refreshOpenHelpDialog(node) {
	globalThis.GJJ_CommonNodeStandardizer?.refreshHelpDialog?.(node);
}

async function copyAndFlash(button, text, restoreLabel) {
	const oldText = button.textContent;
	const ok = await GJJ_Utils.copyTextToClipboard(text);
	button.textContent = ok ? "✅ 已复制" : "复制失败";
	button.classList.toggle("copied", ok);
	clearTimeout(button.__gjjVUMissingTimer);
	button.__gjjVUMissingTimer = setTimeout(() => {
		button.textContent = restoreLabel || oldText;
		button.classList.remove("copied");
	}, 1100);
}

function createMissingModelHint(node, slot, folder, expectedName) {
	const url = downloadUrlForSlot(slot, expectedName);
	const folderLabel = slotSearchFolderLabel(slot, folder);
	const solution = `解决方案：从统一模型地址下载 ${expectedName}，放到 ComfyUI 已配置的模型分类 ${folderLabel}，然后点击刷新按钮或刷新模型列表。`;
	const row = document.createElement("div");
	row.className = "gjj-vu-missing-row";
	const message = document.createElement("div");
	message.className = "gjj-vu-missing-text";
	message.textContent = `缺失：${expectedName}`;
	message.title = `${solution}\n文件名：${expectedName}`;

	const copyName = document.createElement("button");
	copyName.type = "button";
	copyName.className = "gjj-vu-missing-btn";
	copyName.textContent = "📋 名称";
	copyName.title = `复制模型文件名\n${expectedName}`;
	copyName.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		copyAndFlash(copyName, expectedName, "📋 名称");
	});
	protect(copyName);

	const download = document.createElement("button");
	download.type = "button";
	download.className = "gjj-vu-missing-btn";
	download.textContent = "🌏 地址";
	download.title = url ? `打开模型下载/搜索地址\n${url}` : "当前预设没有提供下载地址";
	download.disabled = !url;
	download.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		if (!url) return;
		window.open(url, "_blank", "noopener,noreferrer");
	});
	protect(download);

	row.append(message, copyName, download);
	return row;
}

function createSearchableSelect(node, name, values, onChange, labels = null, opts = {}) {
	const w = getWidget(node, name);
	const list = Array.isArray(values) && values.length ? values.map(String) : comboValues(w);
	setComboOptions(w, list);

	const box = document.createElement("div");
	box.className = "gjj-vu-combo";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-vu-combo-button";
	const text = document.createElement("span");
	text.className = "gjj-vu-combo-text";
	const arrow = document.createElement("span");
	arrow.className = "gjj-vu-combo-arrow";
	arrow.textContent = "⌄";
	button.append(text, arrow);
	box.appendChild(button);

	let optionValues = list.slice();
	let optionLabels = labels || null;
	const searchFilterKey = String(opts.filterKey || "").trim();
	let searchText = searchFilterKey ? getFilter(node, searchFilterKey) : "";

	const setVisualValue = (value) => {
		const raw = String(value ?? "");
		const missingText = String(opts.missingText || "").trim();
		button.classList.toggle("missing", !!missingText);
		text.textContent = missingText || displayNameForValue(raw, optionLabels) || "未选择";
		button.title = opts.title || raw || "未选择";
	};

	const setValue = (value, trigger = true) => {
		const next = String(value ?? "");
		box.__gjjVUValue = next;
		if (w) {
			w.value = next;
			w.callback?.(next);
		}
		setVisualValue(next);
		if (trigger) {
			saveWidgetValues(node);
			onChange?.(next);
		}
	};

	const setOptions = (nextValues, nextLabels = null) => {
		optionValues = Array.isArray(nextValues) ? nextValues.map(String) : [];
		if (nextLabels) optionLabels = nextLabels;
		const next = String(w?.value ?? box.__gjjVUValue ?? optionValues[0] ?? "");
		box.__gjjVUValue = next;
		setVisualValue(next);
	};

	function openPopup() {
		closeSearchPopup();
		const rect = button.getBoundingClientRect();
		const popup = document.createElement("div");
		popup.className = "gjj-vu-popup";
		popup.style.left = `${Math.round(rect.left)}px`;
		popup.style.top = `${Math.round(rect.bottom + 4)}px`;
		popup.style.width = `${Math.max(260, Math.round(rect.width))}px`;

		const input = document.createElement("input");
		input.className = "gjj-vu-popup-search";
		input.placeholder = opts.placeholder || "输入关键词实时过滤";
		input.value = searchText;
		const listWrap = document.createElement("div");
		listWrap.className = "gjj-vu-popup-list";

		const render = () => {
			searchText = input.value || "";
			if (searchFilterKey) {
				setFilter(node, searchFilterKey, searchText);
				saveWidgetValues(node);
			}
			const words = splitWords(searchText);
			let shown = optionValues.filter((value) => {
				const label = displayNameForValue(value, optionLabels);
				const hay = lower(`${value} ${label}`);
				return words.every((word) => hay.includes(word));
			});
			shown = shown.slice(0, 160);
			listWrap.replaceChildren();
			if (!shown.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-vu-popup-empty";
				empty.textContent = "没有匹配项";
				listWrap.appendChild(empty);
				return;
			}
			for (const value of shown) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-vu-popup-item";
				if (String(w?.value ?? "") === value) item.classList.add("active");
				item.textContent = `${String(w?.value ?? "") === value ? "✓ " : ""}${displayNameForValue(value, optionLabels)}`;
				item.title = value;
				item.addEventListener("click", (event) => {
					event.preventDefault(); event.stopPropagation();
					setValue(value, true);
					closeSearchPopup();
				});
				listWrap.appendChild(item);
			}
		};

		input.addEventListener("input", render);
		for (const el of [popup, input, listWrap]) protect(el);
		popup.append(input, listWrap);
		document.body.appendChild(popup);
		ACTIVE_GJJ_VU_POPUP = popup;
		render();
		setTimeout(() => input.focus(), 0);
	}

	button.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		openPopup();
	});
	protect(button);

	if (w) {
		w.__gjjVUInput = button;
		w.__gjjVUSetOptions = setOptions;
		w.__gjjVUSetValue = setValue;
	}
	box.__gjjVUValue = String(w?.value ?? list[0] ?? "");
	setVisualValue(box.__gjjVUValue);
	return box;
}

function createSelect(node, name, values, onChange, labels = null) {
	return createSearchableSelect(node, name, values, onChange, labels);
}

function createFilterBox(node, key, placeholder, onInput) {
	const input = document.createElement("input");
	input.className = "gjj-vu-filter";
	input.placeholder = placeholder;
	input.value = getFilter(node, key);
	input.title = "过滤关键词：不区分大小写，支持空格/逗号分隔，含子目录。";
	input.addEventListener("input", () => {
		setFilter(node, key, input.value);
		onInput?.(input.value);
		refreshNode(node);
	});
	protect(input);
	return input;
}

function getInputSlot(node, name, displayName = "") {
	return node.inputs?.find((input) => {
		const values = [input?.name, input?.display_name, input?.displayName, input?.localized_name, input?.label].map((item) => String(item || ""));
		return values.includes(name) || (displayName && values.includes(displayName));
	});
}
function inputHasLink(input) { return input?.link !== undefined && input?.link !== null; }
function hasLinkedLoraBool(node) {
	return inputHasLink(getInputSlot(node, "🚕 加速LoRA", "🚕 加速LoRA"))
		|| inputHasLink(getInputSlot(node, "use_accel_lora_in", "🚕 加速LoRA"));
}
function hasExternalLoraBool(node) {
	return Boolean(selectedLoraBoolVariable(node))
		|| hasLinkedLoraBool(node);
}
function hasExternalLoraConfig(node) {
	return inputHasLink(getInputSlot(node, "🧬 LoRA配置", "🧬 LoRA配置"))
		|| inputHasLink(getInputSlot(node, "lora_chain_config", "🧬 LoRA配置"));
}
function effectiveUseLora(node) {
	if (hasExternalLoraBool(node)) return true; // 前端不知道运行时值；连接后保持 LoRA 面板可见。
	const v = getWidget(node, "use_accel_lora")?.value;
	return v === true || String(v).toLowerCase() === "true";
}

function isLoraSlot(slot) { return String(slot?.folder || "") === "loras"; }
function isNameOnlySlot(slot) { return ["name", "name_any"].includes(String(slot?.kind || "")); }
function isDualClipSlot(slot) { return String(slot?.loader || "") === "dual_clip"; }
function isModelOutputSlot(slot) {
	return ["diffusion", "checkpoint_model"].includes(String(slot?.kind || ""));
}
function isVaeOutputSlot(slot) {
	return ["vae", "checkpoint_vae", "ltx_audio_vae"].includes(String(slot?.kind || ""));
}
function isClipOutputSlot(slot) {
	return ["clip", "checkpoint_clip"].includes(String(slot?.kind || ""));
}
function visibleOutputSlots(node, cfg) {
	// 后端也下发 output_slots；这里优先使用它，保证前端输出顺序与后端返回 tuple 一致。
	// Universal/Kijai 都按语义输出类压紧可见口，空占位/name/LoRA 只留在面板参数区，不画成右侧输出圆点。
	const source = Array.isArray(cfg?.output_slots) ? cfg.output_slots : (cfg?.slots || []);
	return source.slice(0, MAX_SLOTS).filter((slot) => !isLoraSlot(slot) && !isNameOnlySlot(slot) && !isUnusedOutputSlot(slot));
}
function hasLoraSlots(cfg) { return (cfg?.slots || []).some(isLoraSlot); }
function outputClassFor(slot, idx = 0) {
	const explicit = String(slot?.output_class || "").trim();
	if (explicit) return explicit;
	const id = String(slot?.id || "");
	const kind = String(slot?.kind || "");
	const label = String(slot?.label || "");
	const text = `${id} ${kind} ${label}`.toLowerCase();
	if (text.includes("high") || text.includes("高模")) return "high_model";
	if (text.includes("low") || text.includes("低模")) return "low_model";
	if (id === "video_vae" || label.includes("视频VAE")) return "video_vae";
	if (id === "audio_vae" || label.includes("音频VAE")) return "audio_vae";
	if (id) return id;
	return `${kind || "slot"}_${idx}`;
}
function semanticIdForSlot(slot, idx = 0) {
	return outputClassFor(slot, idx);
}
function slotKey(slot, idx = 0) {
	return `${outputClassFor(slot, idx)}::${String(slot?.id || `slot_${idx}`)}::${String(slot?.kind || "") }::${String(slot?.folder || "")}::${outputTypeFor(slot)}`;
}
function isGjjLoraInput(input) {
	const text = [input?.name, input?.localized_name, input?.label].map((v) => String(v || "")).join(" ");
	return text.includes("use_accel_lora_in") || text.includes("lora_chain_config") || text.includes("🚕") || text.includes("🧬");
}

function closeLoraVariablePicker(node) {
	node?.__gjjVULoraVariablePicker?.remove?.();
	node.__gjjVULoraVariablePicker = null;
}

function openLoraVariablePicker(node) {
	closeLoraVariablePicker(node);
	const options = variableOptions(node);
	const current = selectedLoraBoolVariable(node);
	const popup = document.createElement("div");
	popup.className = "gjj-vu-variable-popup";
	popup.style.cssText = [
		"position:fixed",
		"z-index:10050",
		"width:min(440px,calc(100vw - 28px))",
		"max-height:min(520px,calc(100vh - 40px))",
		"overflow:hidden",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:10px",
		"border:1px solid #486575",
		"border-radius:8px",
		"background:#08151a",
		"box-shadow:0 18px 46px rgba(0,0,0,.55)",
		"color:#dce7e2",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	const rect = node.__gjjVULoraVariableButton?.getBoundingClientRect?.() || { left: 24, bottom: 80 };
	popup.style.left = `${Math.max(12, Math.min(window.innerWidth - 460, rect.left || 24))}px`;
	popup.style.top = `${Math.max(12, Math.min(window.innerHeight - 540, (rect.bottom || 80) + 6))}px`;

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;gap:8px;";
	const title = document.createElement("div");
	title.textContent = "⚡ 选择 LoRA 开关变量";
	title.style.cssText = "font-weight:800;flex:1 1 auto;";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.textContent = "清空";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "关闭";
	for (const button of [clear, close]) {
		button.style.cssText = "height:28px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:650;";
	}
	header.append(title, clear, close);
	popup.appendChild(header);

	const search = document.createElement("input");
	search.placeholder = "搜索变量，点击选择";
	search.style.cssText = "height:30px;border:1px solid #3f5b66;border-radius:7px;background:#071015;color:#dce7e2;padding:0 10px;outline:none;";
	popup.appendChild(search);
	const list = document.createElement("div");
	list.style.cssText = "overflow:auto;display:flex;flex-direction:column;gap:5px;max-height:360px;padding-right:2px;";
	popup.appendChild(list);

	function render() {
		const needle = String(search.value || "").trim().toLowerCase();
		list.textContent = "";
		for (const option of options) {
			const parts = variableDisplay(option);
			if (!parts.value) continue;
			if (needle && !`${parts.title} ${parts.source} ${parts.value} ${option.label || ""}`.toLowerCase().includes(needle)) continue;
			const item = document.createElement("button");
			item.type = "button";
			item.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:8px",
				"text-align:left",
				"border:0",
				"border-radius:7px",
				"padding:8px 10px",
				"background:" + (current === parts.value ? "#234a37" : "transparent"),
				"color:#dce7e2",
				"cursor:pointer",
			].join(";");
			const mark = document.createElement("span");
			mark.textContent = current === parts.value ? "✓" : "";
			mark.style.cssText = "width:16px;color:#7de39b;font-weight:900;";
			const text = document.createElement("span");
			text.innerHTML = `<b>${parts.title}</b><br><span style="color:#8fa3ad">${parts.source ? `${parts.source} · ` : ""}${parts.value}</span>`;
			item.append(mark, text);
			item.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				setSelectedLoraBoolVariable(node, parts.value);
				closeLoraVariablePicker(node);
			});
			list.appendChild(item);
		}
		if (!list.children.length) {
			const empty = document.createElement("div");
			empty.textContent = options.length ? "没有匹配的变量" : "当前工作流没有可选变量";
			empty.style.cssText = "padding:14px 10px;color:#9aaab2;text-align:center;";
			list.appendChild(empty);
		}
	}
	clear.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setSelectedLoraBoolVariable(node, "");
		closeLoraVariablePicker(node);
	});
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closeLoraVariablePicker(node);
	});
	search.addEventListener("input", render);
	popup.addEventListener("pointerdown", (event) => event.stopPropagation());
	document.body.appendChild(popup);
	node.__gjjVULoraVariablePicker = popup;
	render();
	search.focus?.();
}

function createLoraBar(node, cfg) {
	const bar = document.createElement("div");
	bar.className = "gjj-vu-lora-bar";
	const uses = hasLoraSlots(cfg);
	// 没有内置加速 LoRA 的配置，不显示加速 LoRA 按钮，避免误导和占空间。
	if (!uses) {
		bar.style.display = "none";
		node.__gjjVULoraToggleSync = null;
		return bar;
	}
	bar.style.display = "grid";

	const loraLabelText = String(cfg?.lora_label || "🚕 加速LoRA");
	const label = document.createElement("span");
	label.className = "gjj-vu-small-label";
	label.textContent = loraLabelText;
	label.title = "控制当前配置的内置/预设 LoRA；没有内置 LoRA 的配置不显示此按钮。";

	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-vu-toggle";
	const sync = () => {
		const linked = hasLinkedLoraBool(node);
		const selectedVariable = linked ? "" : selectedLoraBoolVariable(node);
		const external = hasExternalLoraBool(node);
		const on = effectiveUseLora(node);
		button.dataset.value = external ? "external" : (on ? "true" : "false");
		button.style.display = selectedVariable ? "none" : "";
		button.textContent = selectedVariable ? "⚡ 变量" : (external ? "🧬 外接" : (on ? "✅ 开" : "⬜ 关"));
		button.disabled = external;
		button.title = selectedVariable
			? `LoRA 开关由变量控制：${selectedVariable}`
			: (external ? "LoRA 开关由外部 BOOLEAN 输入控制。" : "点击开关内部/外接 LoRA 叠加。");
		const variableButton = node.__gjjVULoraVariableButton;
		if (variableButton) {
			if (selectedVariable) {
				const display = variableDisplay(variableOption(node, selectedVariable));
				variableButton.textContent = `⚡ ${display.title || selectedVariable}`;
				variableButton.title = `已选择变量：${display.title || selectedVariable}\n实际变量名：${selectedVariable}`;
				variableButton.classList.add("on");
			} else {
				variableButton.textContent = "⚡ 变量";
				variableButton.title = "从 GJJ_TemplateParams 或 GJJ_SetNode 选择布尔变量";
				variableButton.classList.remove("on");
			}
		}
	};
	button.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		if (hasExternalLoraBool(node)) return;
		const cur = effectiveUseLora(node);
		syncWidget(node, "use_accel_lora", !cur);
		sync();
		applyConfig(node);
	});
	protect(button);

	const variableButton = document.createElement("button");
	variableButton.type = "button";
	variableButton.className = "gjj-vu-variable";
	variableButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openLoraVariablePicker(node);
	});
	protect(variableButton);
	node.__gjjVULoraVariableButton = variableButton;

	const hint = document.createElement("div");
	hint.className = "gjj-vu-lora-hint";
	bar.append(label, button, variableButton, hint);
	node.__gjjVULoraToggleSync = sync;
	const originalSync = node.__gjjVULoraToggleSync;
	node.__gjjVULoraToggleSync = () => {
		originalSync?.();
		const linked = hasLinkedLoraBool(node);
		const selectedVariable = linked ? "" : selectedLoraBoolVariable(node);
		if (selectedVariable) {
			const display = variableDisplay(variableOption(node, selectedVariable));
			hint.textContent = `⚡ 变量控制：${display.title || selectedVariable}`;
			hint.title = `执行时从变量读取 LoRA 开关：${selectedVariable}`;
		} else if (linked) {
			hint.textContent = "🔗 外部布尔控制";
			hint.title = "当前 LoRA 开关由左侧 BOOLEAN 输入控制。";
		} else {
			hint.textContent = hasExternalLoraConfig(node) ? "🧬 已接额外LoRA" : "🧬 可接额外LoRA";
			hint.title = "这里提示的是额外 LoRA 配置输入，不是开关变量。";
		}
	};
	sync();
	node.__gjjVULoraToggleSync();
	return bar;
}

function estimateNodeHeight(node) {
	const container = node?.__gjjVUContainer;
	const rows = node?.__gjjVURows;
	const rowCount = Math.max(
		Number(node?.__gjjVUVisibleRowCount || 0),
		Number(rows?.children?.length || rows?.childElementCount || 0),
	);
	const hasLoraBar = !!(node?.__gjjVULoraBarWrap?.childElementCount && node.__gjjVULoraBarWrap.style.display !== "none");
	const measured = Math.ceil(Number(container?.scrollHeight || rows?.scrollHeight || 0)) + 8;
	const estimated = 52 + (hasLoraBar ? 32 : 0) + (rowCount * 40);
	return Math.max(120, measured, estimated);
}

function buildDom(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-vu-loader";
	// 关键：DOMWidget 不能覆盖最右侧输出插口命中区域，否则低位输出口（例如 CLIP）会拖不出线。
	// 右侧留出固定命中通道；按钮/下拉仍可交互，但不会压住输出圆点。
	wrap.style.cssText = `width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:0 ${OUTPUT_HIT_LANE}px 0 0;margin-right:0;pointer-events:none;position:relative;`;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-vu-loader * { box-sizing:border-box; }
		.gjj-vu-loader,
		.gjj-vu-loader .gjj-vu-top,
		.gjj-vu-loader .gjj-vu-rows,
		.gjj-vu-loader .gjj-vu-row,
		.gjj-vu-loader .gjj-vu-lora-bar,
		.gjj-vu-loader .gjj-vu-combo,
		.gjj-vu-loader .gjj-vu-label,
		.gjj-vu-loader .gjj-vu-small-label { pointer-events:none; }
		.gjj-vu-loader .gjj-vu-combo-button,
		.gjj-vu-loader .gjj-vu-refresh,
		.gjj-vu-loader .gjj-vu-broadcast,
		.gjj-vu-loader .gjj-vu-toggle,
		.gjj-vu-loader .gjj-vu-variable,
		.gjj-vu-loader input,
		.gjj-vu-loader button,
		.gjj-vu-loader select { pointer-events:auto; }
		.gjj-vu-top { display:grid; grid-template-columns:minmax(0,1fr) 34px 34px; gap:6px; align-items:center; min-width:0; }
		.gjj-vu-row { display:grid; grid-template-columns:96px minmax(0,1fr) 72px; gap:6px; align-items:center; min-width:0; margin-bottom:4px; }
		.gjj-vu-row.no-dtype { grid-template-columns:108px minmax(0,1fr); }
		.gjj-vu-row.has-gear.no-dtype { grid-template-columns:108px minmax(0,1fr) 30px; }
		.gjj-vu-row.has-gear:not(.no-dtype) { grid-template-columns:88px minmax(0,1fr) 68px 30px; }
		.gjj-vu-label, .gjj-vu-small-label { color:#b9c8cc; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-vu-refresh, .gjj-vu-broadcast, .gjj-vu-toggle, .gjj-vu-variable, .gjj-vu-combo-button {
			width:100%; height:28px; min-width:0; padding:3px 7px; border:1px solid #33464e; border-radius:7px;
			background:#2b2d30; color:#f1f5f5; outline:none; font-size:12px;
		}
		.gjj-vu-gear {
			width:30px; height:28px; padding:0; border:1px solid #33464e; border-radius:7px;
			background:#24282b; color:#d7e3e6; cursor:pointer; font-size:14px; line-height:1;
		}
		.gjj-vu-gear.on { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-vu-param-panel {
			display:grid; grid-template-columns:repeat(auto-fit, minmax(142px, 1fr)); gap:5px 6px; margin:-1px 0 5px 0;
			padding:6px; border:1px solid #2d424a; border-radius:7px; background:#111b20; min-width:0;
		}
		.gjj-vu-param-field { display:grid; grid-template-columns:58px minmax(0,1fr); gap:5px; align-items:center; min-width:0; }
		.gjj-vu-param-label { color:#9fb0b7; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-vu-param-panel .gjj-vu-combo-button,
		.gjj-vu-param-number,
		.gjj-vu-param-toggle { height:24px; border-radius:6px; font-size:11px; }
		.gjj-vu-param-number {
			width:100%; min-width:0; padding:2px 6px; border:1px solid #33464e; background:#0b1418;
			color:#edf4f4; outline:none;
		}
		.gjj-vu-param-toggle { width:100%; padding:0 5px; border:1px solid #33464e; background:#24282b; color:#cdd5d8; cursor:pointer; }
		.gjj-vu-param-toggle.on { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-vu-combo { min-width:0; width:100%; position:relative; }
		.gjj-vu-combo-button { display:flex; align-items:center; justify-content:space-between; gap:6px; cursor:pointer; text-align:left; }
		.gjj-vu-combo-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
		.gjj-vu-combo-arrow { color:#9fb0b7; flex:0 0 auto; }
		.gjj-vu-combo-button.missing { border-color:#ef4444; background:#3a1518; color:#fecaca; }
		.gjj-vu-combo-button.missing .gjj-vu-combo-text { color:#fecaca; font-weight:800; }
		.gjj-vu-row.missing .gjj-vu-label { color:#fecaca; font-weight:700; }
		.gjj-vu-missing-row {
			display:grid; grid-template-columns:minmax(0,1fr) 64px 64px; gap:6px; align-items:center; min-width:0;
			margin:-1px 0 6px 0; padding:5px 6px; border:1px solid rgba(239,68,68,.52); border-radius:7px;
			background:rgba(127,29,29,.22); color:#fecaca; pointer-events:auto;
		}
		.gjj-vu-missing-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; font-weight:700; }
		.gjj-vu-missing-btn {
			height:24px; min-width:0; padding:0 5px; border:1px solid rgba(248,113,113,.5); border-radius:6px;
			background:#3a1518; color:#ffe4e6; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;
		}
		.gjj-vu-missing-btn:hover { background:#4a1d21; }
		.gjj-vu-missing-btn.copied { border-color:rgba(74,222,128,.7); background:#14532d; color:#dcfce7; }
		.gjj-vu-missing-btn:disabled { opacity:.42; cursor:not-allowed; }
		.gjj-vu-refresh, .gjj-vu-broadcast, .gjj-vu-toggle, .gjj-vu-variable { background:#24282b; color:#cdd5d8; cursor:pointer; padding:0; text-align:center; }
		.gjj-vu-broadcast.on,
		.gjj-vu-broadcast[data-value="true"] { border-color:#69b980; background:#20362f; color:#ecfff1; }
		.gjj-vu-broadcast:hover { border-color:#6aa6b8; background:#2c3b43; }
		.gjj-vu-toggle[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-vu-toggle[data-value="external"] { border-color:#4b5860; background:#1d2327; color:#9caab0; cursor:default; }
		.gjj-vu-variable { padding:0 6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-vu-variable.on { border-color:#7fa7b3; background:#20333b; color:#ffffff; }
		.gjj-vu-lora-bar { display:grid; grid-template-columns:74px 82px 82px minmax(0,1fr); gap:6px; align-items:center; min-width:0; }
		.gjj-vu-lora-hint { height:28px; padding:5px 2px; border:0; border-radius:0; background:transparent; color:#9caab0; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-vu-popup { position:fixed; z-index:999999; max-height:420px; padding:7px; border:1px solid #47616b; border-radius:9px; background:#10191d; box-shadow:0 10px 32px rgba(0,0,0,.45); }
		.gjj-vu-popup-search { width:100%; height:28px; margin-bottom:6px; padding:3px 7px; border:1px solid #d7eff5; border-radius:6px; background:#0b1418; color:#f1f5f5; outline:none; font-size:12px; }
		.gjj-vu-popup-list { max-height:360px; overflow:auto; display:flex; flex-direction:column; gap:4px; }
		.gjj-vu-popup-item { width:100%; min-height:28px; padding:5px 8px; border:1px solid #31464e; border-radius:6px; background:#172328; color:#edf4f4; text-align:left; cursor:pointer; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-vu-popup-item:hover { background:#21323a; }
		.gjj-vu-popup-item.active { border-color:#4f8f7a; background:#103b31; color:#dff8ea; }
		.gjj-vu-popup-empty { color:#9caab0; font-size:12px; padding:6px 4px; }
		.gjj-vu-sep { height:1px; background:rgba(105,125,134,0.24); margin:1px 0; }
		.gjj-vu-empty { color:#9caab0; font-size:12px; padding:4px 2px; }
	`;
	wrap.appendChild(style);

	const top = document.createElement("div");
	top.className = "gjj-vu-top";
	const configBox = document.createElement("div");
	configBox.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr);gap:6px;min-width:0;";
	const configSelect = createSearchableSelect(node, "config", comboValues(getWidget(node, "config")), () => applyConfig(node, { userConfigChanged: true }), null, { placeholder: "过滤配置", filterKey: "__config" });
	node.__gjjVUConfigSelect = configSelect;
	configBox.append(configSelect);
	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.className = "gjj-vu-refresh";
	refresh.textContent = "↻";
	refresh.title = "重新读取 models 目录和配置";
	protect(refresh);
	refresh.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshBackendLists(node, true).finally(() => refreshOpenHelpDialog(node));
	});
	top.append(configBox, refresh, createBroadcastButton(node));
	wrap.appendChild(top);

	const sep = document.createElement("div"); sep.className = "gjj-vu-sep"; wrap.appendChild(sep);
	const loraBarWrap = document.createElement("div"); node.__gjjVULoraBarWrap = loraBarWrap; wrap.appendChild(loraBarWrap);
	const rows = document.createElement("div"); rows.className = "gjj-vu-rows"; node.__gjjVURows = rows; wrap.appendChild(rows);

	// 不在整块 DOM 上拦截 pointerdown/mousedown，避免覆盖右侧输出插口。
	// 需要拦截的按钮、下拉、输入框已由 protect() 单独处理。
	return wrap;
}


function forceDomPassThrough(node) {
	const widget = node?.__gjjVUWidget;
	const container = node?.__gjjVUContainer;
	const candidates = [
		container,
		widget?.element,
		widget?.inputEl,
		widget?.widget,
		container?.parentElement,
		container?.parentElement?.parentElement,
	].filter(Boolean);
	for (const el of candidates) {
		if (!el?.style) continue;
		el.style.pointerEvents = "none";
	}
	const root = container?.parentElement || container;
	root?.querySelectorAll?.("button,input,select,textarea,.gjj-vu-combo-button,.gjj-vu-popup,.gjj-vu-popup *").forEach((el) => {
		if (el?.style) el.style.pointerEvents = "auto";
	});
}

function ensureDom(node) {
	if (node.__gjjVUWidget) return;
	const container = buildDom(node);
	node.__gjjVUContainer = container;
	const domWidget = node.addDOMWidget?.("gjj_video_universal_loader_dom", "HTML", container, { serialize: false, hideOnZoom: false });
	if (domWidget) {
		domWidget.computeSize = (width) => {
			const nodeWidth = Math.round(Number(width || currentNodeWidth(node)));
			return [nodeWidth, Math.round(estimateNodeHeight(node))];
		};
		domWidget.getHeight = () => Math.round(estimateNodeHeight(node));
		node.__gjjVUWidget = domWidget;
		forceDomPassThrough(node);
		requestAnimationFrame(() => forceDomPassThrough(node));
		setTimeout(() => forceDomPassThrough(node), 80);
		if (Array.isArray(node.widgets)) {
			const idx = node.widgets.indexOf(domWidget);
			if (idx > 0) { node.widgets.splice(idx, 1); node.widgets.unshift(domWidget); }
		}
	}
}

function collectWidgetValues(node) {
	const values = {};
	for (const name of ALL_FIELDS) { const w = getWidget(node, name); if (w) values[name] = w.value; }
	return values;
}
function saveWidgetValues(node, serializedNode = null) {
	const values = collectWidgetValues(node);
	node.properties = node.properties || {};
	node.properties[SAVED_VALUES_PROPERTY] = { ...values };
	for (const [k, v] of Object.entries(values)) node.properties[`gjj_vu_value_${k}`] = v;
	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[SAVED_VALUES_PROPERTY] = { ...values };
		if (node.properties[METADATA_PROPERTY]) {
			serializedNode.properties[METADATA_PROPERTY] = { ...node.properties[METADATA_PROPERTY] };
		}
		serializedNode.properties[FILTER_PROPERTY] = { ...(node.properties[FILTER_PROPERTY] || {}) };
		for (const [k, v] of Object.entries(values)) serializedNode.properties[`gjj_vu_value_${k}`] = v;
	}
	return values;
}
function restoreWidgetValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node.properties || {};
	const saved = props?.[SAVED_VALUES_PROPERTY] || {};
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name); if (!w) continue;
		let value = saved[name]; if (value === undefined) value = props[`gjj_vu_value_${name}`];
		if (value !== undefined && value !== null) w.value = value;
	}
	if (props?.[FILTER_PROPERTY]) { node.properties = node.properties || {}; node.properties[FILTER_PROPERTY] = { ...props[FILTER_PROPERTY] }; }
}

function slotNeedsDtype(slot) {
	const kind = String(slot?.kind || "");
	if (kind === "clip" && String(slot?.loader || "") === "dual_clip") return false;
	return ["diffusion", "clip"].includes(kind);
}
function officialIconFor(slot) {
	const kind = String(slot?.kind || "");
	const customIcon = String(slot?.icon || "").trim();
	if (customIcon) return customIcon;
	// 与官方插口颜色对齐：MODEL 紫、VAE 红、CLIP 黄。
	if (["diffusion", "checkpoint_model"].includes(kind)) return "🟣";
	if (["wanvideo_model"].includes(kind)) return "🟣";
	if (["vae", "checkpoint_vae", "ltx_audio_vae", "wan_vae"].includes(kind)) return "🔴";
	if (["clip", "checkpoint_clip", "wan_t5_encoder"].includes(kind)) return "🟡";
	if (["clip_vision", "audio_encoder"].includes(kind)) return "🔵";
	if (["vace_model", "extra_model"].includes(kind)) return "🧩";
	if (["fantasytalking_model"].includes(kind)) return "🗣";
	if (["multitalk_model"].includes(kind)) return "🎤";
	if (["fantasyportrait_model"].includes(kind)) return "🧑";
	if (["wan_lora"].includes(kind)) return "🟠";
	if (kind === "empty") return "";
	if (["latent_upscale_model", "name_any"].includes(kind)) return "🟤";
	if (["name"].includes(kind)) return "🟠";
	return String(slot?.icon || "⚪");
}
function outputTypeFor(slot) { return String(slot?.output_type || OUTPUT_TYPE_BY_KIND[String(slot?.kind || "")] || "*"); }
function outputLabelFor(slot) {
	if (String(slot?.kind || "") === "empty") return "";
	return `${officialIconFor(slot)} ${String(slot?.label || slot?.id || "输出")}`;
}
function isUnusedOutputSlot(slot) {
	return !slot || String(slot?.kind || "") === "empty" || slot?.unused === true;
}
function boolText(value) {
	return value === true || String(value).toLowerCase() === "true" ? "true" : "false";
}
function settingName(suffix, index) {
	return `${suffix}_${index}`;
}
function settingFieldName(def, index) {
	return def?.name || settingName(def?.suffix || "", index);
}
function extraKindFor(slot) {
	const kind = String(slot?.kind || "").replaceAll("-", "_").toLowerCase();
	if (kind === "vace_model" || kind === "extra_model") return "vace";
	if (kind === "fantasytalking_model" || kind === "fantasy_talking") return "fantasytalking";
	if (kind === "multitalk_model" || kind === "multi_talk" || kind === "infinitetalk" || kind === "infinite_talk") return "multitalk";
	if (kind === "fantasyportrait_model" || kind === "fantasy_portrait") return "fantasyportrait";
	return kind;
}
function paramDefsForSlot(node, slot) {
	const kind = String(slot?.kind || "");
	const extraKind = extraKindFor(slot);
	if (kind === "wanvideo_model") {
		return [
			{ suffix: "base_precision", label: "精度", type: "select", values: WAN_BASE_PRECISIONS, defaultValue: slot?.base_precision || "bf16" },
			{ suffix: "quantization", label: "量化", type: "select", values: WAN_QUANTIZATIONS, defaultValue: slot?.quantization || "disabled" },
			{ suffix: "load_device", label: "设备", type: "select", values: WAN_LOAD_DEVICES, defaultValue: slot?.load_device || "offload_device" },
			{ suffix: "attention_mode", label: "注意力", type: "select", values: WAN_ATTENTION_MODES, defaultValue: slot?.attention_mode || "sdpa" },
			{ suffix: "rms_norm_function", label: "RMS", type: "select", values: WAN_RMS_NORM_FUNCTIONS, defaultValue: slot?.rms_norm_function || "default" },
		];
	}
	if (kind === "wan_vae") {
		return [
			{ suffix: "vae_precision", label: "VAE精度", type: "select", values: WAN_VAE_PRECISIONS, defaultValue: slot?.precision || "bf16" },
			{ suffix: "vae_use_cpu_cache", label: "CPU缓存", type: "toggle", defaultValue: boolText(slot?.use_cpu_cache || false) },
		];
	}
	if (kind === "wan_t5_encoder") {
		return [
			{ suffix: "t5_precision", label: "T5精度", type: "select", values: WAN_T5_PRECISIONS, defaultValue: slot?.precision || "bf16" },
			{ suffix: "t5_quantization", label: "T5量化", type: "select", values: WAN_T5_QUANTIZATIONS, defaultValue: slot?.quantization || "disabled" },
			{ suffix: "t5_load_device", label: "设备", type: "select", values: WAN_LOAD_DEVICES, defaultValue: slot?.load_device || "offload_device" },
		];
	}
	if (extraKind === "fantasytalking" || extraKind === "fantasyportrait") {
		return [
			{ suffix: "extra_base_precision", label: "扩展精度", type: "select", values: EXTRA_BASE_PRECISIONS, defaultValue: slot?.base_precision || "fp16" },
		];
	}
	if (isLoraSlot(slot)) {
		return [
			{ suffix: "lora_strength", label: "强度", type: "number", defaultValue: String(slot?.strength ?? 1), min: -1000, max: 1000, step: 0.0001 },
			{ suffix: "lora_merge_loras", label: "合并", type: "toggle", defaultValue: boolText(slot?.merge_loras || false) },
			{ suffix: "lora_low_mem_load", label: "低显存", type: "toggle", defaultValue: boolText(slot?.low_mem_load || false) },
		];
	}
	if (!isKijaiNode(node)) {
		const params = [];
		if (slotNeedsDtype(slot)) {
			params.push({
				suffix: "dtype",
				label: "dtype",
				type: "select",
				values: ensureState(node).dtypes || DEFAULT_DTYPES,
				defaultValue: "default",
			});
		}
		if (kind === "clip" && String(slot?.loader || "") !== "dual_clip") {
			params.push({
				name: "clip_type_override",
				label: "CLIP类型",
				type: "select",
				values: ensureState(node).clipTypes || ["auto"],
				defaultValue: "auto",
			});
		}
		if (kind === "vae" && String(slot?.loader || "") === "gjj_vae") {
			params.push({
				suffix: "weight_dtype",
				label: "权重",
				type: "select",
				values: WEIGHT_DTYPE_CHOICES,
				defaultValue: slot?.weight_dtype || "bf16",
			});
		}
		return params;
	}
	return [];
}
function ensureSettingDefaults(node, slot, index, reset = false) {
	for (const def of paramDefsForSlot(node, slot)) {
		const name = settingFieldName(def, index);
		const w = getWidget(node, name);
		if (!w) continue;
		const cur = String(w.value ?? "").trim();
		if (reset || !cur || cur === "preset" || (def.values && !def.values.includes(cur))) {
			w.value = String(def.defaultValue ?? "");
			w.callback?.(w.value);
		}
		if (w.__gjjVUInput && "value" in w.__gjjVUInput) w.__gjjVUInput.value = String(w.value ?? "");
		if (typeof w.__gjjVUSetValue === "function") w.__gjjVUSetValue(String(w.value ?? ""), false);
	}
}
function openSettingsMap(node) {
	node.properties = node.properties || {};
	node.properties[SETTINGS_OPEN_PROPERTY] = node.properties[SETTINGS_OPEN_PROPERTY] || {};
	return node.properties[SETTINGS_OPEN_PROPERTY];
}
function settingsSlotKey(slot, index) {
	return `${index}:${String(slot?.id || "")}:${String(slot?.kind || "")}`;
}
function isSettingsOpen(node, slot, index) {
	return !!openSettingsMap(node)[settingsSlotKey(slot, index)];
}
function createSettingsGear(node, slot, index) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `gjj-vu-gear ${isSettingsOpen(node, slot, index) ? "on" : ""}`;
	button.textContent = "⚙️";
	button.title = "展开/收起该模型的加载参数";
	button.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		const map = openSettingsMap(node);
		const key = settingsSlotKey(slot, index);
		if (map[key]) delete map[key];
		else map[key] = true;
		applyConfig(node);
	});
	protect(button);
	return button;
}
function settingValue(node, name, fallback = "") {
	const raw = String(getWidget(node, name)?.value ?? "").trim();
	return raw || String(fallback ?? "");
}
function createNumberSetting(node, name, def) {
	const input = document.createElement("input");
	input.className = "gjj-vu-param-number";
	input.type = "number";
	input.step = String(def.step ?? 0.01);
	if (def.min !== undefined) input.min = String(def.min);
	if (def.max !== undefined) input.max = String(def.max);
	input.value = settingValue(node, name, def.defaultValue);
	input.title = "此值会覆盖当前预设的默认参数。";
	input.addEventListener("input", () => {
		syncWidget(node, name, input.value);
	});
	protect(input);
	return input;
}
function createToggleSetting(node, name, def) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-vu-param-toggle";
	const sync = () => {
		const on = settingValue(node, name, def.defaultValue) === "true";
		button.classList.toggle("on", on);
		button.textContent = on ? "开" : "关";
	};
	button.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		const next = settingValue(node, name, def.defaultValue) === "true" ? "false" : "true";
		syncWidget(node, name, next);
		sync();
	});
	button.title = "此开关会覆盖当前预设的默认参数。";
	protect(button);
	sync();
	return button;
}
function createParamPanel(node, slot, index) {
	const defs = paramDefsForSlot(node, slot);
	const panel = document.createElement("div");
	panel.className = "gjj-vu-param-panel";
	for (const def of defs) {
		const name = settingFieldName(def, index);
		const field = document.createElement("div");
		field.className = "gjj-vu-param-field";
		const label = document.createElement("div");
		label.className = "gjj-vu-param-label";
		label.textContent = def.label;
		label.title = `${def.label}\n默认值: ${String(def.defaultValue ?? "")}`;
		let control;
		if (def.type === "number") control = createNumberSetting(node, name, def);
		else if (def.type === "toggle") control = createToggleSetting(node, name, def);
		else control = createSearchableSelect(node, name, def.values || [], () => saveWidgetValues(node), null, { placeholder: "过滤参数" });
		field.append(label, control);
		panel.appendChild(field);
	}
	return panel;
}
function slotTitle(slot, folder) {
	const lines = [
		`模型分类: ${slotSearchFolderLabel(slot, folder)}`,
		`类型: ${String(slot?.kind || "")}`,
		`关键词: ${(slot?.keywords || []).join(", ")}`,
	];
	const fields = [
		["base_precision", "base_precision"],
		["precision", "precision"],
		["quantization", "quantization"],
		["weight_dtype", "weight_dtype"],
		["load_device", "load_device"],
		["attention_mode", "attention"],
		["rms_norm_function", "rms_norm"],
		["strength", "strength"],
		["target", "target"],
		["merge_loras", "merge_loras"],
		["low_mem_load", "low_mem_load"],
	];
	for (const [key, label] of fields) {
		if (slot?.[key] !== undefined && slot?.[key] !== null && String(slot[key]) !== "") lines.push(`${label}: ${String(slot[key])}`);
	}
	return lines.join("\n");
}
function makeOutput(slot, oldOut = null, idx = 0) {
	const label = outputLabelFor(slot);
	return {
		name: label,
		localized_name: label,
		label,
		type: outputTypeFor(slot),
		links: oldOut?.links || null,
		gjj_dynamic: true,
		gjj_slot_key: slotKey(slot, idx),
		gjj_slot_id: String(slot?.id || ""),
		gjj_slot_class: semanticIdForSlot(slot, idx),
	};
}
function sameOutputShape(node, slots) {
	if (!Array.isArray(node.outputs) || node.outputs.length !== slots.length) return false;
	for (let i = 0; i < slots.length; i++) {
		const out = node.outputs[i];
		const unused = isUnusedOutputSlot(slots[i]);
		const label = unused ? "" : outputLabelFor(slots[i]);
		const type = unused ? "*" : outputTypeFor(slots[i]);
		const expectedKey = unused ? `unused_${i}` : slotKey(slots[i], i);
		const actualKey = String(out?.gjj_slot_key || "");
		if (actualKey && actualKey !== expectedKey) return false;
		if (String(out?.name || out?.label || "") !== label) return false;
		if (String(out?.type || "") !== type) return false;
	}
	return true;
}

function collectOutputLinks(node) {
	const saved = [];
	const outputs = Array.isArray(node.outputs) ? node.outputs : [];
	for (let i = 0; i < outputs.length; i++) {
		const out = outputs[i];
		const ids = Array.isArray(out?.links) ? out.links.slice() : [];
		for (const linkId of ids) {
			const link = app.graph?.links?.[linkId];
			if (!link) continue;
			// 关键：保存 Link 对象引用，不能 {...link} 复制成普通对象。
			// 新版 Comfy/LiteGraph 序列化时会调用 link.asSerialisable()，普通对象会报 e.asSerialisable is not a function。
			saved.push({
				id: linkId,
				oldSlot: i,
				linkRef: link,
				target_id: link.target_id,
				target_slot: link.target_slot,
			});
		}
	}
	return saved;
}

function detachKeptOutputLinksBeforeRebuild(node, keepCount) {
	// removeOutput 会自动删除 output.links 里的 link。
	// 为了重建动态输出口时保留连线，先把有效输出口的 links 暂时摘掉，保留 graph.links 里的 Link 对象。
	const outputs = Array.isArray(node.outputs) ? node.outputs : [];
	for (let i = 0; i < Math.min(keepCount, outputs.length); i++) {
		if (outputs[i]) outputs[i].links = [];
	}
}

function restoreOutputLinksByIndex(node, savedLinks, slotCount) {
	if (!Array.isArray(node.outputs)) return;
	for (const out of node.outputs) {
		if (!Array.isArray(out.links)) out.links = [];
	}
	for (const item of savedLinks || []) {
		const nextSlot = Number(item.oldSlot);
		if (!Number.isFinite(nextSlot) || nextSlot < 0 || nextSlot >= slotCount) continue;
		const out = node.outputs[nextSlot];
		if (!out) continue;
		const linkId = item.id;
		const type = String(out.type || item.linkRef?.type || "*");

		// 优先使用现有 Link 对象；如果 removeOutput 已经删掉了 graph.links[id]，就把保存的 Link 对象引用放回去。
		let linkObj = app.graph?.links?.[linkId] || item.linkRef;
		if (!linkObj) continue;
		// 如果当前环境要求 Link.asSerialisable，而这里只剩普通对象，则不要塞回 graph.links，避免保存工作流时报错。
		const graphUsesSerializableLinks = Object.values(app.graph?.links || {}).some((link) => link && typeof link.asSerialisable === "function");
		if (graphUsesSerializableLinks && typeof linkObj.asSerialisable !== "function") continue;

		linkObj.id = linkId;
		linkObj.origin_id = node.id;
		linkObj.origin_slot = nextSlot;
		linkObj.type = type;
		app.graph.links = app.graph.links || {};
		app.graph.links[linkId] = linkObj;
		if (!Array.isArray(out.links)) out.links = [];
		if (!out.links.includes(linkId)) out.links.push(linkId);

		const targetNode = app.graph?.getNodeById?.(linkObj.target_id) || app.graph?._nodes_by_id?.[linkObj.target_id];
		const targetInput = targetNode?.inputs?.[linkObj.target_slot];
		if (targetInput) {
			targetInput.link = linkId;
			targetInput.type = targetInput.type || type;
		}
	}
}

function removeExtraOutputLinks(node, startIndex) {
	const outputs = Array.isArray(node.outputs) ? node.outputs : [];
	for (let i = startIndex; i < outputs.length; i++) {
		const out = outputs[i];
		const links = Array.isArray(out?.links) ? out.links.slice() : [];
		for (const linkId of links) {
			const link = app.graph?.links?.[linkId];
			const targetNode = link && (app.graph?.getNodeById?.(link.target_id) || app.graph?._nodes_by_id?.[link.target_id]);
			const targetInput = targetNode?.inputs?.[link?.target_slot];
			if (targetInput?.link === linkId) targetInput.link = null;
			try { app.graph?.removeLink?.(linkId); } catch (_) {}
			try { if (app.graph?.links?.[linkId]) delete app.graph.links[linkId]; } catch (_) {}
		}
		if (out) out.links = [];
	}
}

function repairOutputSlot(node, out, slot, index) {
	const label = outputLabelFor(slot);
	const type = outputTypeFor(slot);
	out.name = label;
	out.localized_name = label;
	out.label = label;
	out.type = type;
	out.gjj_dynamic = true;
	out.gjj_slot_key = slotKey(slot, index);
	out.gjj_slot_id = String(slot?.id || "");
	out.gjj_slot_class = semanticIdForSlot(slot, index);
	out.slot_index = index;
	out.gjj_arg_name = `file_${index + 1}`;
	out.gjj_output_kind = String(slot?.kind || "");
	out.gjj_output_type = type;
	if (!Array.isArray(out.links)) out.links = [];
	for (const linkId of out.links.slice()) {
		const link = app.graph?.links?.[linkId];
		if (!link) continue;
		link.origin_id = node.id;
		link.origin_slot = index;
		link.type = type;
	}
}


function currentConfigKey(node) {
	return String(getWidget(node, "config")?.value || "");
}

function activeConfigKey(node, state = null) {
	const configs = state?.configs || ensureState(node).configs || {};
	const hasConfig = (key) => !configs || !Object.keys(configs).length || Object.prototype.hasOwnProperty.call(configs, key);
	const candidates = [
		node?.__gjjVUConfigSelect?.__gjjVUValue,
		currentConfigKey(node),
		helpValueOf(node, "config", ""),
		node?.properties?.[SAVED_VALUES_PROPERTY]?.config,
		node?.properties?.gjj_vu_value_config,
		node?.__gjjVUAppliedConfigKey,
		node?.properties?.gjj_vu_applied_config_key,
	];
	for (const candidate of candidates) {
		const key = String(candidate ?? "").trim();
		if (key && hasConfig(key)) return key;
	}
	return Object.keys(configs)[0] || "";
}

function isMainModelSlot(slot) {
	if (isLoraSlot(slot)) return false;
	const kind = String(slot?.kind || "");
	return ["diffusion", "checkpoint_model", "wanvideo_model"].includes(kind);
}

function updateLoaderMetadata(node, cfg = null) {
	if (!node) return {};
	const configKey = activeConfigKey(node);
	const slots = Array.isArray(cfg?.slots) ? cfg.slots : [];
	const mainIndex = slots.findIndex(isMainModelSlot);
	const mainModel = mainIndex >= 0 ? valueOf(node, `file_${mainIndex + 1}`) : "";
	const metadata = {
		config_key: configKey,
		config_label: String(cfg?.label || configKey || "").trim(),
		main_model: String(mainModel || "").trim(),
		main_model_field: mainIndex >= 0 ? `file_${mainIndex + 1}` : "",
	};
	node.properties = node.properties || {};
	node.properties[METADATA_PROPERTY] = metadata;
	return metadata;
}

function collectSemanticOutputLinks(node) {
	const saved = [];
	const outputs = Array.isArray(node.outputs) ? node.outputs : [];
	for (let i = 0; i < outputs.length; i++) {
		const out = outputs[i];
		const slotId = String(out?.gjj_slot_class || out?.gjj_slot_id || "");
		if (!slotId) continue;
		const links = Array.isArray(out?.links) ? out.links.slice() : [];
		for (const linkId of links) {
			const link = app.graph?.links?.[linkId];
			if (!link) continue;
			saved.push({
				linkId,
				link, // 保留原始 Link 对象，不能 {...link}，否则保存工作流会缺 asSerialisable。
				slotId,
				oldIndex: i,
				target_id: link.target_id,
				target_slot: link.target_slot,
			});
		}
	}
	return saved;
}

function detachOutputLinksForRemap(node, savedLinks) {
	const savedIds = new Set((savedLinks || []).map((item) => item.linkId));
	for (const out of node.outputs || []) {
		if (Array.isArray(out?.links)) out.links = out.links.filter((id) => !savedIds.has(id));
	}
	for (const item of savedLinks || []) {
		const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (targetInput?.link === item.linkId) targetInput.link = null;
	}
}

function restoreSemanticOutputLinks(node, savedLinks, slots) {
	const restored = new Set();
	const usedTargetInputs = new Set();
	const bySlotId = new Map();
	for (const item of savedLinks || []) {
		if (!bySlotId.has(item.slotId)) bySlotId.set(item.slotId, []);
		bySlotId.get(item.slotId).push(item);
	}
	for (let i = 0; i < slots.length; i++) {
		const slotId = semanticIdForSlot(slots[i], i);
		if (!slotId || !bySlotId.has(slotId)) continue;
		const out = node.outputs?.[i];
		if (!out) continue;
		if (!Array.isArray(out.links)) out.links = [];
		const type = outputTypeFor(slots[i]);
		for (const item of bySlotId.get(slotId) || []) {
			const targetKey = `${item.target_id}:${item.target_slot}`;
			if (usedTargetInputs.has(targetKey)) continue;
			const link = item.link;
			if (!link) continue;
			link.origin_id = node.id;
			link.origin_slot = i;
			link.type = type;
			app.graph.links = app.graph.links || {};
			app.graph.links[item.linkId] = link;
			if (!out.links.includes(item.linkId)) out.links.push(item.linkId);
			const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
			const targetInput = targetNode?.inputs?.[item.target_slot];
			if (targetInput) {
				targetInput.link = item.linkId;
				// 不覆盖目标输入原有 type，只修正连线 type。
			}
			restored.add(item.linkId);
			usedTargetInputs.add(targetKey);
		}
	}
	return restored;
}

function deleteUnrestoredOutputLinks(savedLinks, restoredIds) {
	for (const item of savedLinks || []) {
		if (restoredIds?.has?.(item.linkId)) continue;
		const targetNode = app.graph?.getNodeById?.(item.target_id) || app.graph?._nodes_by_id?.[item.target_id];
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (targetInput?.link === item.linkId) targetInput.link = null;
		try { app.graph?.removeLink?.(item.linkId); } catch (_) {}
		try { if (app.graph?.links?.[item.linkId]) delete app.graph.links[item.linkId]; } catch (_) {}
	}
}

function unusedOutputLabel(index) { return ``; }
function unusedOutputType() { return "*"; }
function hardRefreshOutputs(node) {
	try { node.onResize?.(node.size); } catch (_) {}
	try { node.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	scheduleLayoutRefresh(node, [0, 48, 160]);
}

function scheduleAutoReloadAfterPresetChange(node) {
	if (!node || !node.graph) return;
	clearTimeout(node.__gjjVUAutoReloadTimer);
	node.__gjjVUAutoReloadTimer = setTimeout(() => {
		const reload = window.GJJ_ReloadNode?.reloadNode;
		if (typeof reload === "function" && node.graph) {
			try {
				reload(node);
				return;
			} catch (error) {
				console.warn("[GJJ Video Loader] 预设切换后自动重新加载节点失败，改用软刷新。", error);
			}
		}
		hardRefreshOutputs(node);
		scheduleLayoutRefresh(node, [0, 80, 220, 420]);
	}, 120);
}

function ensureActiveOutputCount(node, count) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const target = Math.max(0, Math.min(MAX_SLOTS, Number(count) || 0));
	// 后端固定 output1-output12 / *；前端结构变更必须走 LiteGraph API，
	// 不能直接 splice node.outputs，否则输出命中区和连线序号容易错位。
	for (let i = node.outputs.length - 1; i >= target; i--) {
		removeExtraOutputLinks(node, i);
		try { node.removeOutput?.(i); }
		catch (_) { node.outputs.splice(i, 1); }
	}
	while (node.outputs.length < target) {
		try { node.addOutput?.("*", "*"); }
		catch (_) { node.outputs.push({ name: "*", type: "*", links: [] }); }
	}
}

function repairFixedOutput(node, out, slot, index) {
	const kind = String(slot?.kind || "");
	const used = !isUnusedOutputSlot(slot);
	const label = used ? outputLabelFor(slot) : "";
	const type = used ? outputTypeFor(slot) : "*";
	out.name = label;
	out.localized_name = label;
	out.label = label;
	out.type = type;
	out.gjj_dynamic = true;
	out.gjj_fixed_any_output = true;
	out.gjj_used_output = used;
	out.gjj_slot_key = used ? slotKey(slot, index) : `unused_${index}`;
	out.gjj_slot_id = used ? String(slot?.id || "") : "";
	out.gjj_slot_class = used ? semanticIdForSlot(slot, index) : `unused_${index}`;
	out.slot_index = index;
	out.gjj_arg_name = `file_${index + 1}`;
	out.gjj_output_kind = used ? kind : "unused";
	out.gjj_output_type = type;
	// 未使用口不删除，只尽量隐藏显示。这样既不破坏固定 output1-output12 的序号，也避免面板出现一串 output5-output12。
	out.hidden = !used;
	out.gjj_hidden_unused = !used;
	if (out.options && typeof out.options === "object") out.options.hidden = !used;
	// 不手写 out.pos，让 LiteGraph 原生布局负责端口命中区。
	if (Object.prototype.hasOwnProperty.call(out, "pos")) {
		try { delete out.pos; } catch (_) { out.pos = undefined; }
	}
	if (!Array.isArray(out.links)) out.links = [];
	// 未使用输出口如果残留旧线，必须断开，否则切配置后会产生“线还在但语义错位”。
	if (!used && out.links.length) {
		for (const linkId of out.links.slice()) {
			const link = app.graph?.links?.[linkId];
			const targetNode = link && (app.graph?.getNodeById?.(link.target_id) || app.graph?._nodes_by_id?.[link.target_id]);
			const targetInput = targetNode?.inputs?.[link?.target_slot];
			if (targetInput?.link === linkId) targetInput.link = null;
			try { app.graph?.removeLink?.(linkId); } catch (_) {}
			try { if (app.graph?.links?.[linkId]) delete app.graph.links[linkId]; } catch (_) {}
		}
		out.links = [];
	}
	for (const linkId of out.links.slice()) {
		const link = app.graph?.links?.[linkId];
		if (!link) continue;
		link.origin_id = node.id;
		link.origin_slot = index;
		link.type = type;
	}
}

function updateOutputs(node, cfg, opts = {}) {
	const slots = visibleOutputSlots(node, cfg);
	const nextConfigKey = activeConfigKey(node);
	const previousConfigKey = String(node.__gjjVUAppliedConfigKey || node.properties?.gjj_vu_applied_config_key || "");
	const layoutChanged = !sameOutputShape(node, slots);
	const configChanged = Boolean(opts?.userConfigChanged || (previousConfigKey && nextConfigKey && previousConfigKey !== nextConfigKey) || layoutChanged);

	// 配置切换时不能按 output 序号复用连线：
	// TI2V/S2V -> I2V 时，output2 会从 VAE 变成 Low模型，output3 会从 CLIP 变成 VAE。
	// 因此先按旧输出口的语义 id 保存连线，再把 vae/clip/high_model/low_model 等同名语义恢复到新位置。
	const semanticLinks = configChanged ? collectSemanticOutputLinks(node) : [];
	if (configChanged) detachOutputLinksForRemap(node, semanticLinks);

	ensureActiveOutputCount(node, slots.length);

	// 只保留当前配置真正用到的输出口数量；每个输出口仍按 output1/output2... 的顺序承载语义。
	for (let i = 0; i < Math.min(slots.length, node.outputs?.length || 0); i++) {
		const out = node.outputs?.[i];
		if (!out) continue;
		repairFixedOutput(node, out, slots[i] || null, i);
	}

	if (configChanged) {
		const restored = restoreSemanticOutputLinks(node, semanticLinks, slots);
		deleteUnrestoredOutputLinks(semanticLinks, restored);
	}

	node.properties = node.properties || {};
	node.properties.gjj_vu_applied_config_key = nextConfigKey;
	node.__gjjVUAppliedConfigKey = nextConfigKey;
	node.properties.gjj_vu_output_slots = slots.map((slot, index) => ({
		name: outputLabelFor(slot),
		type: outputTypeFor(slot),
		id: String(slot?.id || ""),
		key: slotKey(slot, index),
		output_index: index,
	}));

	hardRefreshOutputs(node);
}
function isLoraConfigInput(input) {
	const text = [input?.name, input?.display_name, input?.displayName, input?.localized_name, input?.label].map((v) => String(v || "")).join(" ");
	return text.includes("lora_chain_config") || text.includes("🧬");
}
function isAccelLoraInput(input) {
	const text = [input?.name, input?.display_name, input?.displayName, input?.localized_name, input?.label].map((v) => String(v || "")).join(" ");
	return text.includes("use_accel_lora_in") || text.includes("🚕");
}
function isExtraModelChainInput(input) {
	const text = [input?.name, input?.display_name, input?.displayName, input?.localized_name, input?.label].map((v) => String(v || "")).join(" ");
	return text.includes("extra_model_chain") || text.includes("EXTRA_MODEL_CHAIN") || text.includes("🧩 额外模型");
}
function isWanRuntimeArgsInput(input) {
	const text = [input?.name, input?.type, input?.display_name, input?.displayName, input?.localized_name, input?.label].map((v) => String(v || "")).join(" ");
	return text.includes("wan_runtime_args")
		|| text.includes("WANCOMPILEARGS")
		|| text.includes("BLOCKSWAPARGS")
		|| text.includes("VRAM_MANAGEMENTARGS")
		|| text.includes("⚙️ Wan运行参数");
}
function captureBackendInputs(node) {
	if (node.__gjjVUBackendInputsCaptured) return;
	node.__gjjVUBackendInputsCaptured = true;
	node.__gjjVUWanRuntimeInput = (node.inputs || []).find(isWanRuntimeArgsInput) || null;
	node.__gjjVUExtraModelInput = (node.inputs || []).find(isExtraModelChainInput) || null;
	node.__gjjVULoraConfigInput = (node.inputs || []).find(isLoraConfigInput) || null;
	node.__gjjVUAccelLoraInput = (node.inputs || []).find(isAccelLoraInput) || null;
}
function fallbackBackendInput(name, type, displayName, oldIn = null) {
	// 仅作为异常兜底。正常情况下直接使用 Python INPUT_TYPES 生成的原生 input，显示文字完全依赖后端 display_name。
	return {
		name,
		type,
		link: oldIn?.link ?? null,
		display_name: displayName,
		tooltip: oldIn?.tooltip || "",
	};
}
function updateInputs(node, cfg) {
	if (!Array.isArray(node.inputs)) node.inputs = [];
	captureBackendInputs(node);
	const old = node.inputs || [];
	const wanArgsInput = old.find(isWanRuntimeArgsInput) || node.__gjjVUWanRuntimeInput || fallbackBackendInput("wan_runtime_args", "WANCOMPILEARGS,BLOCKSWAPARGS,VRAM_MANAGEMENTARGS", "⚙️ Wan运行参数");
	const extraInput = old.find(isExtraModelChainInput) || node.__gjjVUExtraModelInput || fallbackBackendInput("extra_model_chain", "EXTRA_MODEL_CHAIN", "🧩 额外模型配置");
	const cfgInput = old.find(isLoraConfigInput) || node.__gjjVULoraConfigInput || fallbackBackendInput("lora_chain_config", "LORA_CHAIN_CONFIG", "🧬 LoRA配置");
	const boolInput = old.find(isAccelLoraInput) || node.__gjjVUAccelLoraInput || fallbackBackendInput("use_accel_lora_in", "BOOLEAN", "🚕 加速LoRA");

	// 关键：前后端顺序保持一致：Wan 运行参数在前，额外模型配置次之，LoRA 配置和加速 LoRA BOOL 在后。
	// 不再新建/强改 label/localized_name/displayName，避免破坏 ComfyUI 根据后端 display_name 绘制输入文字。
	const rest = old.filter((input) => {
		if (isWanRuntimeArgsInput(input) || isExtraModelChainInput(input) || isLoraConfigInput(input) || isAccelLoraInput(input)) {
			return false;
		}
		const widgetName = String(input?.widget?.name || input?.name || "");
		const isLegacyWidgetInput = ALL_FIELDS.includes(widgetName) || Boolean(input?.widget);
		return !isLegacyWidgetInput || inputHasLink(input);
	});
	const nextInputs = [wanArgsInput, extraInput, cfgInput];
	const hideBoolInputForVariable = Boolean(selectedLoraBoolVariable(node)) && !inputHasLink(boolInput);
	if (hasLoraSlots(cfg) && !hideBoolInputForVariable) nextInputs.push(boolInput);
	node.inputs = [...nextInputs, ...rest];
}

function scheduleLayoutRefresh(node, delays = [0, 48, 160]) {
	if (!node) return;
	clearTimeout(node.__gjjVULayoutRefreshTimer);
	const firstDelay = Array.isArray(delays) ? delays[0] : delays;
	node.__gjjVULayoutRefreshTimer = setTimeout(() => {
		requestAnimationFrame(() => refreshNode(node));
	}, Math.max(0, Math.round(Number(firstDelay) || 0)));
}

function currentConfig(node, state) {
	const configKeys = Object.keys(state.configs || {});
	const cw = getWidget(node, "config");
	if (configKeys.length) {
		const labels = {};
		for (const key of configKeys) labels[key] = state.configs[key]?.label ? `${state.configs[key].label}` : key;
		setComboOptions(cw, configKeys);
		if (cw?.__gjjVUSetOptions) cw.__gjjVUSetOptions(configKeys, labels);
		const key = activeConfigKey(node, state) || configKeys[0];
		if (cw && String(cw.value ?? "") !== key) cw.value = key;
		if (cw?.__gjjVUSetValue) cw.__gjjVUSetValue(key, false);
	}
	const key = activeConfigKey(node, state) || configKeys[0] || "";
	return state.configs[key] || state.configs[configKeys[0]] || null;
}

function applyConfig(node, opts = {}) {
	const state = ensureState(node);
	if (!state.configs || !state.folders) { refreshBackendLists(node, false).finally(() => applyConfig(node, opts)); return; }
	const cfg = currentConfig(node, state);
	updateInputs(node, cfg);
	const rows = node.__gjjVURows; if (!rows) return;
	node.__gjjVUVisibleRowCount = 0;
	rows.replaceChildren();
	if (node.__gjjVULoraBarWrap) {
		node.__gjjVULoraBarWrap.replaceChildren();
		node.__gjjVULoraBarWrap.appendChild(createLoraBar(node, cfg));
	}
	if (!cfg) {
		const empty = document.createElement("div"); empty.className = "gjj-vu-empty"; empty.textContent = "未读取到模型配置。"; rows.appendChild(empty); node.__gjjVUVisibleRowCount = 1; scheduleLayoutRefresh(node, [0, 48, 160]); return;
	}
	const loraEnabled = effectiveUseLora(node);
	const configKey = activeConfigKey(node, state);
	// 同时记录配置键与配置对象。帮助树只接受键匹配的快照，避免刷新期间
	// 上一预设的对象与新预设键交叉，确保它和当前主面板选择严格一致。
	node.__gjjVUAppliedConfig = cfg;
	node.__gjjVUAppliedConfigSnapshot = { key: configKey, config: cfg };
	node.properties = node.properties || {};
	const previousSettingsConfig = String(node.properties[SETTINGS_CONFIG_PROPERTY] || "");
	const previousAppliedConfig = String(node.__gjjVUAppliedConfigKey || node.properties?.gjj_vu_applied_config_key || "");
	const resetSlotValues = Boolean(opts?.userConfigChanged || (previousAppliedConfig && configKey && previousAppliedConfig !== configKey));
	const resetSlotSettings = isKijaiNode(node) && previousSettingsConfig && previousSettingsConfig !== configKey;
	if (resetSlotSettings) node.properties[SETTINGS_OPEN_PROPERTY] = {};
	(cfg.slots || []).slice(0, MAX_SLOTS).forEach((slot, index) => {
		const i = index + 1;
		if (String(slot?.kind || "") === "empty") {
			syncWidget(node, `file_${i}`, "");
			syncWidget(node, `secondary_file_${i}`, "");
			syncWidget(node, `dtype_${i}`, "default");
			syncWidget(node, `weight_dtype_${i}`, "bf16");
			return;
		}
		const folder = String(slot.folder || "");
		const list = slotListForState(state, slot, folder);
		const allowAny = String(slot.kind || "") === "name_any";
		const values = filterList(list, slot.keywords || [], allowAny, slot.fallback_keywords || [], slot.file_extension || "");
		const secondaryValues = Array.isArray(list) ? list.map(String) : [];
		const fileName = `file_${i}`;
		const secondaryFileName = `secondary_file_${i}`;
		const dtypeName = `dtype_${i}`;
		setComboOptions(getWidget(node, fileName), values);
		const preferredName = preferredNamesForSlot(slot);
		selectFirstIfInvalid(node, fileName, values, preferredName, resetSlotValues);
		const missingModel = missingModelForSlot(slot, values);
		if (isDualClipSlot(slot)) {
			setComboOptions(getWidget(node, secondaryFileName), secondaryValues);
			const preferredSecondary = preferredNamesForSlot(slot, true);
			selectFirstIfInvalid(node, secondaryFileName, secondaryValues, preferredSecondary, resetSlotValues);
		} else {
			syncWidget(node, secondaryFileName, "");
		}
		setComboOptions(getWidget(node, dtypeName), state.dtypes || ["default"]);
		selectFirstIfInvalid(node, dtypeName, state.dtypes || ["default"]);
		ensureSettingDefaults(node, slot, i, resetSlotSettings);
		syncDerivedSettingsFromModelName(node, slot, i, valueOf(node, fileName));

		const row = document.createElement("div");
		const params = paramDefsForSlot(node, slot);
		const hasParams = params.length > 0;
		const showInlineDtype = slotNeedsDtype(slot) && !params.some((def) => def.suffix === "dtype");
		row.className = `gjj-vu-row ${showInlineDtype ? "" : "no-dtype"} ${hasParams ? "has-gear" : ""}`;
		row.classList.toggle("missing", missingModel);
		if (isLoraSlot(slot) && !loraEnabled) row.style.display = "none";
		const label = document.createElement("div");
		label.className = "gjj-vu-label";
		const icon = officialIconFor(slot);
		label.textContent = `${icon} ${String(slot.label || slot.id || `模型${i}`)}`;
		label.title = slotTitle(slot, folder);
		const select = createSearchableSelect(node, fileName, values, (value) => {
			syncDerivedSettingsFromModelName(node, slot, i, value);
			saveWidgetValues(node);
			syncPairedLowModelFromHigh(node, cfg, slot, index, value, state);
		}, null, {
			placeholder: "输入关键词实时过滤",
			title: missingModel
				? `${label.title}\n缺失：${missingModel}\n解决方案：从统一模型地址下载后放到 ComfyUI 已配置的模型分类：${slotSearchFolderLabel(slot, folder)}`
				: label.title,
			missingText: missingModel ? `缺失：${missingModel}` : "",
		});
		row.append(label, select);
		if (showInlineDtype) {
			const dtype = createSelect(node, dtypeName, state.dtypes || ["default"], () => saveWidgetValues(node));
			dtype.title = "加载 dtype；default 使用 ComfyUI 默认策略。";
			row.append(dtype);
		}
		if (hasParams) row.append(createSettingsGear(node, slot, i));
		rows.appendChild(row);
		node.__gjjVUVisibleRowCount += 1;
		if (missingModel && !(isLoraSlot(slot) && !loraEnabled)) {
			rows.appendChild(createMissingModelHint(node, slot, folder, missingModel));
			node.__gjjVUVisibleRowCount += 1;
		}
		if (hasParams && !(isLoraSlot(slot) && !loraEnabled) && isSettingsOpen(node, slot, i)) {
			rows.appendChild(createParamPanel(node, slot, i));
			node.__gjjVUVisibleRowCount += Math.max(1, Math.ceil(params.length / 2));
		}
		if (isDualClipSlot(slot)) {
			const missingSecondary = missingModelForSlot(slot, secondaryValues, true);
			const secondaryRow = document.createElement("div");
			secondaryRow.className = "gjj-vu-row no-dtype";
			secondaryRow.classList.toggle("missing", !!missingSecondary);
			const secondaryLabel = document.createElement("div");
			secondaryLabel.className = "gjj-vu-label";
			const secondaryIcon = officialIconFor(slot);
			const secondaryLabelText = String(slot.secondary_label || "另一个模型");
			secondaryLabel.textContent = `${secondaryIcon} ${secondaryLabelText}`;
			secondaryLabel.title = `模型分类: ${slotSearchFolderLabel(slot, folder)}\n类型: 另一个模型\n默认值: ${String(slot.secondary_name || "").trim() || "未设置"}`;
			const secondarySelect = createSearchableSelect(node, secondaryFileName, secondaryValues, () => saveWidgetValues(node), null, {
				placeholder: "输入关键词实时过滤",
				title: missingSecondary
					? `${secondaryLabel.title}\n缺失：${missingSecondary}\n解决方案：从统一模型地址下载后放到 ComfyUI 已配置的模型分类：${slotSearchFolderLabel(slot, folder)}`
					: secondaryLabel.title,
				missingText: missingSecondary ? `缺失：${missingSecondary}` : "",
			});
			secondaryRow.append(secondaryLabel, secondarySelect);
			rows.appendChild(secondaryRow);
			node.__gjjVUVisibleRowCount += 1;
			if (missingSecondary) {
				rows.appendChild(createMissingModelHint(node, slot, folder, missingSecondary));
				node.__gjjVUVisibleRowCount += 1;
			}
		}
	});
	for (let i = (cfg.slots || []).length + 1; i <= MAX_SLOTS; i++) { syncWidget(node, `file_${i}`, ""); syncWidget(node, `secondary_file_${i}`, ""); syncWidget(node, `dtype_${i}`, "default"); syncWidget(node, `weight_dtype_${i}`, "bf16"); }
	if (isKijaiNode(node)) node.properties[SETTINGS_CONFIG_PROPERTY] = configKey;
	updateOutputs(node, cfg, opts);
	node.__gjjVULoraToggleSync?.();
	updateLoaderMetadata(node, cfg);
	saveWidgetValues(node);
	refreshOpenHelpDialog(node);
	scheduleLayoutRefresh(node, [0, 48, 160]);
	if (opts?.userConfigChanged) scheduleAutoReloadAfterPresetChange(node);
}

function refreshNode(node) {
	if (!node) return;
	const width = rememberNodeWidth(node);
	const height = Math.round(estimateNodeHeight(node));
	if (!node.__gjjVUSizing && (Math.abs(Number(node.size?.[0] || 0) - width) > 1 || Math.abs(Number(node.size?.[1] || 0) - height) > 1)) {
		node.__gjjVUSizing = true;
		try { node.setSize?.([width, height]); }
		finally { requestAnimationFrame(() => { node.__gjjVUSizing = false; }); }
	}
	forceDomPassThrough(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function stabilize(node) {
	if (!node) return;
	rememberNodeWidth(node);
	attachHelpModelProvider(node);
	restoreWidgetValues(node);
	ensureDefaultBroadcastEnabled(node);
	ensureDom(node);
	updateBroadcastButton(node);
	hideNativeWidgets(node);
	applyConfig(node);
	if (!node.__gjjVUBackendListsRequested) {
		node.__gjjVUBackendListsRequested = true;
		refreshBackendLists(node, true);
	}
}
function schedule(node, ms = 0) { clearTimeout(node.__gjjVUTimer); node.__gjjVUTimer = setTimeout(() => stabilize(node), ms); }

function findVideoLoaderNodeForPromptId(graph, promptId) {
	const id = String(promptId || "");
	const nodes = graph?._nodes || [];
	const parts = id.split(":").filter(Boolean);
	const tail = parts.length ? parts[parts.length - 1] : id;
	return nodes.find((node) => String(node?.id) === id)
		|| nodes.find((node) => String(node?.id) === tail);
}

function resolveSelectedLoraBoolVariable(node) {
	const name = selectedLoraBoolVariable(node);
	const resolver = globalThis.GJJ_VariableBroadcast?.resolveVariableBroadcastSource;
	if (!name || typeof resolver !== "function") return null;
	return resolver(node?.graph || app.graph, name);
}

function patchVideoLoaderVariablePrompt(promptResult, graph) {
	const output = promptResult?.output;
	if (!output) return promptResult;
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const node = findVideoLoaderNodeForPromptId(graph, nodeId);
		if (!node || !TARGET_NODES.has(node?.comfyClass) || !selectedLoraBoolVariable(node)) continue;
		const input = getInputSlot(node, "use_accel_lora_in", "🚕 加速LoRA");
		if (input?.link != null) continue;
		const resolved = resolveSelectedLoraBoolVariable(node);
		if (!Array.isArray(resolved) || resolved.length !== 2 || String(resolved[0]) === String(node.id)) continue;
		nodeInfo.inputs = nodeInfo.inputs || {};
		nodeInfo.inputs.use_accel_lora_in = [String(resolved[0]), Number(resolved[1] || 0)];
	}
	return promptResult;
}

function installVariablePromptPatch() {
	if (!api.__gjjVideoUniversalLoraVariableQueuePatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjVideoUniversalLoraVariableQueuePatchInstalled = true;
		const originalQueuePrompt = api.queuePrompt.bind(api);
		api.queuePrompt = async function (...args) {
			patchVideoLoaderVariablePrompt(args[1], app.rootGraph || app.graph);
			return originalQueuePrompt(...args);
		};
	}
	if (!app.__gjjVideoUniversalLoraVariableGraphPatchInstalled && typeof app.graphToPrompt === "function") {
		app.__gjjVideoUniversalLoraVariableGraphPatchInstalled = true;
		const originalGraphToPrompt = app.graphToPrompt.bind(app);
		app.graphToPrompt = async function (...args) {
			const result = await originalGraphToPrompt(...args);
			const graph = args[0] || this.rootGraph || this.graph || app.rootGraph || app.graph;
			return patchVideoLoaderVariablePrompt(result, graph);
		};
	}
}

app.registerExtension({
	name: "Comfy.GJJ.VideoUniversalModelLoader",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;
		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const w = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (ALL_FIELDS.includes(name)) hideWidget(w);
			return w;
		};
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) { const result = originalOnNodeCreated?.apply(this, args); schedule(this, 0); return result; };
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) { const result = originalOnConfigure?.apply(this, [serializedNode, ...args]); restoreWidgetValues(this, serializedNode); schedule(this, 0); return result; };
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			rememberNodeWidth(this);
			saveWidgetValues(this, serializedNode);
			originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[WIDTH_PROPERTY] = this.properties?.[WIDTH_PROPERTY] || currentNodeWidth(this);
				serializedNode.properties[BROADCAST_PROPERTY] = broadcastEnabled(this);
				serializedNode.properties[BROADCAST_USER_SET_PROPERTY] = this.properties?.[BROADCAST_USER_SET_PROPERTY] === true;
			}
			saveWidgetValues(this, serializedNode);
		};
		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjVUSizing) {
				rememberNodeWidth(this);
				refreshNode(this);
				scheduleLayoutRefresh(this, [0, 80]);
			}
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) { const result = originalOnConnectionsChange?.apply(this, args); schedule(this, 0); return result; };
	},
	nodeCreated(node) { if (TARGET_NODES.has(node?.comfyClass)) schedule(node, 0); },
	setup() {
		installVariablePromptPatch();
		if (!window.__gjjVideoUniversalVariableListener) {
			window.__gjjVideoUniversalVariableListener = true;
			const refreshVariableUsers = () => {
				for (const node of app.graph?._nodes || []) {
					if (TARGET_NODES.has(node?.comfyClass) && selectedLoraBoolVariable(node)) schedule(node, 80);
				}
			};
			window.addEventListener("gjj-template-params-updated", refreshVariableUsers);
		}
		for (const node of app.graph?._nodes || []) if (TARGET_NODES.has(node?.comfyClass)) stabilize(node);
	},
});

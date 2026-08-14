import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET = "GJJ_AudioUniversalModelLoader";
const LIST_API = "/gjj/audio_universal_loader_lists";
const MAX_SLOTS = 8;
const SAVED_VALUES_PROPERTY = "gjj_audio_universal_loader_values";
const FILTER_PROPERTY = "gjj_audio_universal_loader_filters";
const WIDTH_PROPERTY = "gjj_audio_universal_loader_width";
const SETTINGS_OPEN_PROPERTY = "gjj_audio_universal_loader_open_settings";
const SETTINGS_CONFIG_PROPERTY = "gjj_audio_universal_loader_settings_config";
const OUTPUT_SLOTS_PROPERTY = "gjj_au_output_slots";          // 保存输出槽信息，用于重启后同步预建
const SAVED_LINKS_PROPERTY = "gjj_au_semantic_links";        // 保存语义链接，用于重启后按 slot_key 恢复
const BROADCAST_PROPERTY = "gjj_au_broadcast";               // ⚡️ 广播模式开关
const DEFAULT_NODE_WIDTH = 440;
const OUTPUT_HIT_LANE = 20;
const DEFAULT_DTYPES = ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"];
const WEIGHT_DTYPE_CHOICES = ["default", "bf16", "fp16", "fp32"];

const OUTPUT_TYPE_BY_KIND = {
	diffusion: "MODEL",
	checkpoint_model: "MODEL",
	vae: "VAE",
	ltx_audio_vae: "VAE",
	clip: "CLIP",
	clip_vision: "CLIP_VISION",
	audio_encoder: "AUDIO_ENCODER",
	empty: "*",
	name: "STRING",
	name_any: "STRING",
};

const ALL_FIELDS = ["config", "clip_type_override"];
for (let i = 1; i <= MAX_SLOTS; i++) {
	ALL_FIELDS.push(`file_${i}`, `secondary_file_${i}`, `dtype_${i}`, `weight_dtype_${i}`);
}

let ACTIVE_POPUP = null;

function getWidget(node, name) {
	return node.widgets?.find((w) => w?.name === name || w?.options?.name === name);
}
function valueOf(node, name, fallback = "") {
	return String(getWidget(node, name)?.value ?? fallback ?? "");
}
function lower(text) { return String(text || "").replaceAll("\\", "/").toLowerCase(); }
function splitWords(text) { return lower(text).trim().split(/[\s,，;；|]+/).filter(Boolean); }
function isUsable(name) {
	const v = lower(name).trim();
	if (!v || v.endsWith(".metadata.json")) return false;
	return /\.(safetensors|sft|ckpt|pt|pth|gguf)$/i.test(v);
}
function matchText(text) {
	return lower(text).replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}
function normalizeKeywords(keywords = []) {
	const result = [];
	const seen = new Set();
	for (const value of keywords || []) {
		for (const token of matchText(value).split(" ")) {
			if (token && !seen.has(token)) {
				seen.add(token);
				result.push(token);
			}
		}
	}
	return result;
}
function scoreName(name, keywords = []) {
	const text = matchText(name);
	let score = 0;
	normalizeKeywords(keywords).forEach((word, idx) => {
		if (text.includes(word)) score += 100 - idx;
		if (text.split(/\s+/).includes(word)) score += 10;
	});
	if (lower(name).endsWith(".safetensors")) score += 10;
	score -= (lower(name).match(/\//g) || []).length;
	return score;
}
function filterList(list, keywords = []) {
	const words = normalizeKeywords(keywords);
	const source = (Array.isArray(list) ? list : []).filter(isUsable);
	if (!words.length) return source;
	return source.filter((name) => words.every((word) => matchText(name).includes(word)))
		.sort((a, b) => scoreName(b, keywords) - scoreName(a, keywords));
}
function comboValues(w) {
	return Array.isArray(w?.options?.values) ? [...w.options.values] : [];
}
function setComboOptions(w, values) {
	if (!w) return;
	const list = Array.isArray(values) ? values.map(String) : [];
	try {
		if (w.options) w.options.values = list;
	} catch (_) {}
}
function modelStem(value) {
	const text = String(value || "").replace("\\", "/").split("/").pop();
	return text.replace(/\.(safetensors|sft|ckpt|pt|pth|gguf)$/i, "");
}
function officialMatchKey(value) {
	let text = modelStem(value).toLowerCase();
	text = text.replace(/[\s._-]+/g, " ");
	const dropTokens = new Set(["fp", "fp8", "fp16", "f16", "fp32", "bf16", "int8", "int4", "nf4", "nvfp4", "mxfp4", "e4m3", "e4m3fn", "e5m2", "gguf", "quant", "quantized", "input", "scaled", "scale", "fast", "dtype", "weight", "weights", "only", "mixed", "pruned", "turbo", "convrot"]);
	const parts = text.split(" ").filter((p) => {
		if (dropTokens.has(p)) return false;
		if (/^(fp|bf|int)\d+/.test(p)) return false;
		if (/^e[45]m[23]fn?$/.test(p)) return false;
		if (/^q\d/.test(p)) return false;
		return !["k", "m", "s", "xl", "xs", "xxl"].includes(p);
	});
	return parts.join("");
}
function longestCommonSubstringLength(a, b) {
	if (!a || !b) return 0;
	if (a.length > b.length) [a, b] = [b, a];
	const prev = new Array(a.length + 1).fill(0);
	let best = 0;
	for (let i = 0; i < b.length; i++) {
		const curr = new Array(a.length + 1).fill(0);
		for (let j = 0; j < a.length; j++) {
			if (a[j] === b[i]) {
				curr[j + 1] = prev[j] + 1;
				if (curr[j + 1] > best) best = curr[j + 1];
			}
		}
		prev.fill(0);
		for (let j = 0; j <= a.length; j++) prev[j] = curr[j];
	}
	return best;
}
function len(x) { return String(x || "").length; }
function bestOfficialNameMatch(names, seeds, allowAny = false) {
	if (!Array.isArray(names) || !names.length) return "";
	const seedKeys = (seeds || []).filter(Boolean).map((s) => officialMatchKey(s)).filter(Boolean);
	if (!seedKeys.length) return "";
	let best = "";
	let bestScore = 0;
	for (const name of names) {
		if (!isUsable(name)) continue;
		const nameKey = officialMatchKey(name);
		if (!nameKey) continue;
		let score = 0;
		for (const seedKey of seedKeys) {
			if (nameKey === seedKey) { score = Math.max(score, 1000); break; }
			const lcs = longestCommonSubstringLength(nameKey, seedKey);
			const ratio = lcs / Math.max(1, Math.min(nameKey.length, seedKey.length));
			score = Math.max(score, Math.round(ratio * 100));
		}
		if (score > bestScore) { bestScore = score; best = name; }
	}
	return bestScore >= 60 ? best : "";
}
function officialNameSeeds(...values) {
	const seeds = [];
	for (const v of values || []) {
		if (Array.isArray(v)) seeds.push(...v.filter(Boolean));
		else if (v) seeds.push(v);
	}
	return seeds;
}
function preferredNamesForSlot(slot) {
	return officialNameSeeds(slot?.required_name, slot?.preferred_name, slot?.official_names || []);
}
function missingModelForSlot(slot, values) {
	const preferred = preferredNamesForSlot(slot);
	if (!preferred.length) return "";
	const matched = bestOfficialNameMatch(values || [], preferred, true);
	return matched ? "" : (slot?.preferred_name || slot?.official_names?.[0] || "");
}

function protect(el) {
	if (!el || el.__gjjAuProtected) return;
	el.__gjjAuProtected = true;
	for (const ev of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		el.addEventListener(ev, (event) => event.stopPropagation());
	}
}
function safeAssign(obj, key, value) { try { obj[key] = value; } catch (_) {} }
function hideWidget(w) {
	if (!w || w.__gjjAuHidden) return;
	w.__gjjAuHidden = true;
	safeAssign(w, "hidden", true);
	safeAssign(w, "type", `converted-widget:${w.name || "hidden"}`);
	safeAssign(w, "label", "");
	w.computeSize = () => [0, -4];
	w.getHeight = () => -4;
	w.draw = () => {};
	safeAssign(w, "y", 0); safeAssign(w, "last_y", 0); safeAssign(w, "size", [0, -4]); safeAssign(w, "height", -4);
	safeAssign(w, "serialize", true);
	if (w.options && typeof w.options === "object") { w.options.hidden = true; w.options.display = "hidden"; }
	if (w.el) w.el.style.display = "none";
	if (w.inputEl) w.inputEl.style.display = "none";
	if (w.element) w.element.style.display = "none";
}
function hideNativeWidgets(node) { for (const name of ALL_FIELDS) hideWidget(getWidget(node, name)); }

function getFilters(node) {
	node.properties = node.properties || {};
	if (!node.properties[FILTER_PROPERTY]) node.properties[FILTER_PROPERTY] = {};
	return node.properties[FILTER_PROPERTY];
}
function getFilter(node, key) { return String(getFilters(node)?.[key] ?? ""); }
function setFilter(node, key, value) { getFilters(node)[key] = String(value || ""); }

function currentNodeWidth(node) {
	return Math.max(DEFAULT_NODE_WIDTH, Number(node.properties?.[WIDTH_PROPERTY] || 0) || Number(node.size?.[0] || 0) || DEFAULT_NODE_WIDTH);
}
function rememberNodeWidth(node) {
	const w = Math.round(Number(node.size?.[0] || 0));
	if (w > 100) {
		node.properties = node.properties || {};
		node.properties[WIDTH_PROPERTY] = w;
	}
	return currentNodeWidth(node);
}

function ensureState(node) {
	node.__gjjAuState = node.__gjjAuState || {
		configs: null,
		folders: null,
		dtypes: DEFAULT_DTYPES,
		clipTypes: ["auto", "minimax", "acestep"],
		loading: false,
	};
	return node.__gjjAuState;
}
async function refreshBackendLists(node, rerender = true, force = false) {
	const state = ensureState(node);
	if (state.loading) { if (force) state.refreshAfterLoad = true; return; }
	state.loading = true;
	try {
		const url = force ? `${LIST_API}?refresh=1&_=${Date.now()}` : LIST_API;
		const response = await fetch(url, { cache: "no-store", headers: { "Cache-Control": "no-cache" } });
		if (response?.ok) {
			const payload = await response.json();
			state.configs = payload?.configs || state.configs;
			state.folders = payload?.folders || state.folders;
			state.dtypes = Array.isArray(payload?.dtypes) ? payload.dtypes.map(String) : state.dtypes;
			state.clipTypes = Array.isArray(payload?.clip_types) ? payload.clip_types.map(String) : state.clipTypes;
		}
	} catch (error) {
		console.warn("[GJJ Audio Loader] 模型列表读取失败", error);
	} finally {
		state.loading = false;
	}
	if (state.refreshAfterLoad) {
		state.refreshAfterLoad = false;
		return refreshBackendLists(node, rerender, true);
	}
	if (rerender) applyConfig(node);
}

function slotListForState(state, slot, folder) {
	const folders = [folder || slot?.folder].filter(Boolean);
	const list = [];
	const seen = new Set();
	for (const f of folders) {
		const arr = Array.isArray(state?.folders?.[f]) ? state.folders[f] : [];
		for (const name of arr) {
			const key = lower(name);
			if (!seen.has(key)) { seen.add(key); list.push(String(name)); }
		}
	}
	return list;
}

function currentConfigKey(node) { return valueOf(node, "config"); }
function currentConfig(node, state) {
	const key = currentConfigKey(node);
	const configs = state?.configs || {};
	return configs[key] || configs[Object.keys(configs)[0] || ""] || null;
}

function isLoraSlot(slot) { return String(slot?.folder || "") === "loras"; }
function isNameOnlySlot(slot) { return ["name", "name_any"].includes(String(slot?.kind || "")); }
function isUnusedOutputSlot(slot) {
	if (isLoraSlot(slot)) return true;
	const kind = String(slot?.kind || "");
	return kind === "empty" || kind === "name" || kind === "name_any";
}
function isDualClipSlot(slot) { return String(slot?.loader || "") === "dual_clip"; }
function slotNeedsDtype(slot) {
	const kind = String(slot?.kind || "");
	if (kind === "clip" && isDualClipSlot(slot)) return false;
	return ["diffusion", "clip"].includes(kind);
}
function slotNeedsWeightDtype(slot) {
	return String(slot?.kind || "") === "vae";
}
function boolText(value) {
	return value === true || String(value).toLowerCase() === "true" ? "true" : "false";
}
function settingFieldName(def, index) {
	return def?.name || `${def?.suffix || ""}_${index}`;
}

function visibleOutputSlots(node, cfg) {
	const source = Array.isArray(cfg?.output_slots) ? cfg.output_slots : (cfg?.slots || []);
	return source.slice(0, MAX_SLOTS).filter((slot) => !isLoraSlot(slot) && !isNameOnlySlot(slot) && !isUnusedOutputSlot(slot));
}
function outputTypeFor(slot) { return String(slot?.output_type || OUTPUT_TYPE_BY_KIND[String(slot?.kind || "")] || "*"); }
function outputLabelFor(slot) {
	const label = String(slot?.label || "").trim();
	if (label) return label;
	const id = String(slot?.id || "");
	const kind = String(slot?.kind || "");
	if (kind === "diffusion") return "主模型";
	if (kind === "vae") return "VAE";
	if (kind === "clip") return "文本编码器";
	return id || "输出";
}
function officialIconFor(slot) {
	const kind = String(slot?.kind || "");
	const customIcon = String(slot?.icon || "").trim();
	if (customIcon) return customIcon;
	if (kind === "diffusion") return "🟣";
	if (kind === "vae") return "🔴";
	if (kind === "clip") return "🟡";
	if (kind === "audio_encoder") return "🔵";
	return "⚪";
}
function slotTitle(slot, folder) {
	const parts = [String(slot?.label || ""), String(slot?.id || "")].filter(Boolean);
	const label = parts.join(" - ");
	const keywords = normalizeKeywords(slot?.keywords || []);
	const preferred = slot?.preferred_name || slot?.official_names?.[0] || "";
	const tips = [];
	if (folder) tips.push(`目录: ${folder}`);
	if (keywords.length) tips.push(`关键词: ${keywords.join(", ")}`);
	if (preferred) tips.push(`推荐: ${preferred}`);
	return [label, tips.join(" | ")].filter(Boolean).join("\n");
}
function slotKey(slot, idx = 0) {
	const id = String(slot?.id || `slot_${idx}`);
	const kind = String(slot?.kind || "");
	const folder = String(slot?.folder || "");
	const type = outputTypeFor(slot);
	const outputClass = String(slot?.output_class || "").trim() || id;
	return `${outputClass}::${id}::${kind}::${folder}::${type}`;
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
	if (typeof w.__gjjAuSetValue === "function") w.__gjjAuSetValue(String(w.value ?? ""), false);
	saveWidgetValues(node);
}
function syncWidget(node, name, value) {
	const w = getWidget(node, name);
	if (!w) return;
	if (w.value !== value) { w.value = value; w.callback?.(value); }
}
function weightDtypeFromModelName(value) {
	const text = modelStem(value).toLowerCase();
	if (/(?:^|[_\s-])bf16(?:[_\s-]|$)/.test(text)) return "bf16";
	if (/(?:^|[_\s-])fp16(?:[_\s-]|$)/.test(text)) return "fp16";
	if (/(?:^|[_\s-])fp32(?:[_\s-]|$)/.test(text)) return "fp32";
	return "";
}
function dtypeFromModelName(value) {
	const text = lower(value);
	if (text.includes("fp8_e4m3fn")) return "fp8_e4m3fn";
	if (text.includes("fp8_e5m2")) return "fp8_e5m2";
	if (text.includes("fp16")) return "fp16";
	if (text.includes("bf16")) return "bf16";
	if (text.includes("fp32")) return "fp32";
	return "default";
}
function syncDerivedSettingsFromModelName(node, slot, index, fileValue) {
	const i = index + 1;
	syncWidget(node, `dtype_${i}`, dtypeFromModelName(fileValue));
	const inferred = weightDtypeFromModelName(fileValue);
	if (inferred) syncWidget(node, `weight_dtype_${i}`, inferred);
}

function saveWidgetValues(node, serializedNode = null) {
	const values = {};
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name);
		if (w) values[name] = w.value;
	}
	node.properties = node.properties || {};
	node.properties[SAVED_VALUES_PROPERTY] = { ...values };
	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[SAVED_VALUES_PROPERTY] = { ...values };
	}
	return values;
}
function restoreWidgetValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node.properties || {};
	const saved = props?.[SAVED_VALUES_PROPERTY] || {};
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name); if (!w) continue;
		const value = saved[name];
		if (value !== undefined && value !== null) w.value = value;
	}
	if (props?.[FILTER_PROPERTY]) {
		node.properties = node.properties || {};
		node.properties[FILTER_PROPERTY] = { ...props[FILTER_PROPERTY] };
	}
}

function closeSearchPopup() {
	if (ACTIVE_POPUP) { ACTIVE_POPUP.remove?.(); ACTIVE_POPUP = null; }
}
document.addEventListener("pointerdown", (e) => {
	if (ACTIVE_POPUP && !ACTIVE_POPUP.contains(e.target)) closeSearchPopup();
}, true);

function createSearchableSelect(node, name, values, onChange, opts = {}) {
	const w = getWidget(node, name);
	const list = Array.isArray(values) && values.length ? values.map(String) : comboValues(w);
	setComboOptions(w, list);

	const box = document.createElement("div");
	box.className = "gjj-au-combo";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-au-combo-button";
	const text = document.createElement("span");
	text.className = "gjj-au-combo-text";
	const arrow = document.createElement("span");
	arrow.className = "gjj-au-combo-arrow";
	arrow.textContent = "⌄";
	button.append(text, arrow);
	box.appendChild(button);

	let optionValues = list.slice();
	const searchFilterKey = String(opts.filterKey || "").trim();
	let searchText = searchFilterKey ? getFilter(node, searchFilterKey) : "";

	const setVisualValue = (value) => {
		const raw = String(value ?? "");
		const missingText = String(opts.missingText || "").trim();
		button.classList.toggle("missing", !!missingText);
		text.textContent = missingText || raw || "未选择";
		button.title = opts.title || raw || "未选择";
	};
	const setValue = (value, trigger = true) => {
		const next = String(value ?? "");
		box.__gjjAuValue = next;
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
	const setOptions = (nextValues) => {
		optionValues = Array.isArray(nextValues) ? nextValues.map(String) : [];
		const next = String(w?.value ?? box.__gjjAuValue ?? optionValues[0] ?? "");
		box.__gjjAuValue = next;
		setVisualValue(next);
	};

	function openPopup() {
		closeSearchPopup();
		const rect = button.getBoundingClientRect();
		const popup = document.createElement("div");
		popup.className = "gjj-au-popup";
		popup.style.left = `${Math.round(rect.left)}px`;
		popup.style.top = `${Math.round(rect.bottom + 4)}px`;
		popup.style.width = `${Math.max(260, Math.round(rect.width))}px`;

		const input = document.createElement("input");
		input.className = "gjj-au-popup-search";
		input.placeholder = opts.placeholder || "输入关键词实时过滤";
		input.value = searchText;
		const listWrap = document.createElement("div");
		listWrap.className = "gjj-au-popup-list";

		const render = () => {
			searchText = input.value || "";
			if (searchFilterKey) {
				setFilter(node, searchFilterKey, searchText);
				saveWidgetValues(node);
			}
			const words = splitWords(searchText);
			let shown = optionValues.filter((value) => {
				const hay = lower(value);
				return words.every((word) => hay.includes(word));
			});
			shown = shown.slice(0, 200);
			listWrap.replaceChildren();
			if (!shown.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-au-popup-empty";
				empty.textContent = "没有匹配项";
				listWrap.appendChild(empty);
				return;
			}
			for (const value of shown) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-au-popup-item";
				if (String(w?.value ?? "") === value) item.classList.add("active");
				item.textContent = `${String(w?.value ?? "") === value ? "✓ " : ""}${value}`;
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
		ACTIVE_POPUP = popup;
		render();
		setTimeout(() => input.focus(), 0);
	}
	button.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		openPopup();
	});
	protect(button);

	if (w) {
		w.__gjjAuInput = button;
		w.__gjjAuSetOptions = setOptions;
		w.__gjjAuSetValue = setValue;
	}
	box.__gjjAuValue = String(w?.value ?? list[0] ?? "");
	setVisualValue(box.__gjjAuValue);
	return box;
}

function createSelect(node, name, values, onChange, opts = {}) {
	const w = getWidget(node, name);
	const list = Array.isArray(values) && values.length ? values.map(String) : comboValues(w);
	setComboOptions(w, list);

	const box = document.createElement("div");
	box.className = "gjj-au-select-inline";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-au-combo-button";
	const text = document.createElement("span");
	text.className = "gjj-au-combo-text";
	const arrow = document.createElement("span");
	arrow.className = "gjj-au-combo-arrow";
	arrow.textContent = "⌄";
	button.append(text, arrow);
	box.appendChild(button);

	let optionValues = list.slice();

	const setVisualValue = (value) => {
		text.textContent = String(value ?? "") || "未选择";
	};
	const setValue = (value, trigger = true) => {
		const next = String(value ?? "");
		if (w) { w.value = next; w.callback?.(next); }
		setVisualValue(next);
		if (trigger) { saveWidgetValues(node); onChange?.(next); }
	};
	const setOptions = (nextValues) => {
		optionValues = Array.isArray(nextValues) ? nextValues.map(String) : [];
		const next = String(w?.value ?? optionValues[0] ?? "");
		setVisualValue(next);
	};

	function openPopup() {
		closeSearchPopup();
		const rect = button.getBoundingClientRect();
		const popup = document.createElement("div");
		popup.className = "gjj-au-popup";
		popup.style.left = `${Math.round(rect.left)}px`;
		popup.style.top = `${Math.round(rect.bottom + 4)}px`;
		popup.style.width = `${Math.max(200, Math.round(rect.width))}px`;

		const listWrap = document.createElement("div");
		listWrap.className = "gjj-au-popup-list";
		for (const value of optionValues) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = "gjj-au-popup-item";
			if (String(w?.value ?? "") === value) item.classList.add("active");
			item.textContent = value;
			item.title = value;
			item.addEventListener("click", (event) => {
				event.preventDefault(); event.stopPropagation();
				setValue(value, true);
				closeSearchPopup();
			});
			listWrap.appendChild(item);
		}
		for (const el of [popup, listWrap]) protect(el);
		popup.append(listWrap);
		document.body.appendChild(popup);
		ACTIVE_POPUP = popup;
	}
	button.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		openPopup();
	});
	protect(button);

	if (w) {
		w.__gjjAuInput = button;
		w.__gjjAuSetOptions = setOptions;
		w.__gjjAuSetValue = setValue;
	}
	box.__gjjAuValue = String(w?.value ?? list[0] ?? "");
	setVisualValue(box.__gjjAuValue);
	return box;
}

function createToggleSetting(node, name, def) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-au-param-toggle";
	const sync = () => {
		const on = String(getWidget(node, name)?.value ?? def.defaultValue) === "true";
		button.classList.toggle("on", on);
		button.textContent = on ? "开" : "关";
	};
	button.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		const cur = String(getWidget(node, name)?.value ?? def.defaultValue);
		const next = cur === "true" ? "false" : "true";
		syncWidget(node, name, next);
		sync();
	});
	protect(button);
	sync();
	return button;
}

function createNumberSetting(node, name, def) {
	const input = document.createElement("input");
	input.className = "gjj-au-param-number";
	input.type = "number";
	input.step = String(def.step ?? 0.01);
	if (def.min !== undefined) input.min = String(def.min);
	if (def.max !== undefined) input.max = String(def.max);
	input.value = String(getWidget(node, name)?.value ?? def.defaultValue);
	input.addEventListener("input", () => {
		syncWidget(node, name, input.value);
	});
	protect(input);
	return input;
}

function openSettingsMap(node) {
	node.properties = node.properties || {};
	if (!node.properties[SETTINGS_OPEN_PROPERTY]) node.properties[SETTINGS_OPEN_PROPERTY] = {};
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
	button.className = `gjj-au-gear ${isSettingsOpen(node, slot, index) ? "on" : ""}`;
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

function paramDefsForSlot(node, slot) {
	const kind = String(slot?.kind || "");
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
	if (kind === "clip" && !isDualClipSlot(slot)) {
		params.push({
			name: "clip_type_override",
			label: "CLIP类型",
			type: "select",
			values: ensureState(node).clipTypes || ["auto"],
			defaultValue: "auto",
		});
	}
	if (slotNeedsWeightDtype(slot)) {
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
	}
}

function createParamPanel(node, slot, index) {
	const defs = paramDefsForSlot(node, slot);
	const panel = document.createElement("div");
	panel.className = "gjj-au-param-panel";
	for (const def of defs) {
		const name = settingFieldName(def, index);
		const field = document.createElement("div");
		field.className = "gjj-au-param-field";
		const label = document.createElement("div");
		label.className = "gjj-au-param-label";
		label.textContent = def.label;
		field.appendChild(label);

		if (def.type === "select") {
			const select = createSelect(node, name, def.values || [], () => saveWidgetValues(node));
			field.appendChild(select);
		} else if (def.type === "toggle") {
			field.appendChild(createToggleSetting(node, name, def));
		} else if (def.type === "number") {
			field.appendChild(createNumberSetting(node, name, def));
		}
		panel.appendChild(field);
	}
	return panel;
}

function ensureActiveOutputCount(node, count) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const target = Math.max(0, Math.min(MAX_SLOTS, Number(count) || 0));
	for (let i = node.outputs.length - 1; i >= target; i--) {
		const out = node.outputs[i];
		if (Array.isArray(out?.links)) {
			for (const linkId of out.links.slice()) {
				const link = app.graph?.links?.[linkId];
				const targetNode = link && (app.graph?.getNodeById?.(link.target_id));
				const targetInput = targetNode?.inputs?.[link?.target_slot];
				if (targetInput?.link === linkId) targetInput.link = null;
				try { app.graph?.removeLink?.(linkId); } catch (_) {}
			}
			out.links = [];
		}
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
	out.gjj_used_output = used;
	out.gjj_slot_key = used ? slotKey(slot, index) : `unused_${index}`;
	out.gjj_slot_id = used ? String(slot?.id || "") : "";
	out.slot_index = index;
	out.gjj_arg_name = `file_${index + 1}`;
	out.hidden = !used;
	if (out.options && typeof out.options === "object") out.options.hidden = !used;
	if (Object.prototype.hasOwnProperty.call(out, "pos")) {
		try { delete out.pos; } catch (_) { out.pos = undefined; }
	}
	if (!Array.isArray(out.links)) out.links = [];
	for (const linkId of out.links.slice()) {
		const link = app.graph?.links?.[linkId];
		if (!link) continue;
		link.origin_id = node.id;
		link.origin_slot = index;
		link.type = type;
	}
}
function sameOutputShape(node, slots) {
	const cur = (node.outputs || []).filter((o) => !o?.hidden);
	if (cur.length !== slots.length) return false;
	for (let i = 0; i < slots.length; i++) {
		if (String(cur[i]?.gjj_slot_key || "") !== slotKey(slots[i], i)) return false;
		if (String(cur[i]?.type || "") !== outputTypeFor(slots[i])) return false;
	}
	return true;
}
function collectSemanticOutputLinks(node) {
	const result = [];
	for (let i = 0; i < (node.outputs || []).length; i++) {
		const out = node.outputs[i];
		if (!Array.isArray(out?.links) || !out.links.length) continue;
		const key = String(out.gjj_slot_key || out.gjj_slot_id || `slot_${i}`);
		for (const linkId of out.links.slice()) {
			const link = app.graph?.links?.[linkId];
			if (!link) continue;
			result.push({
				key,
				target_id: link.target_id,
				target_slot: link.target_slot,
				type: link.type,
			});
		}
	}
	return result;
}
function detachOutputLinksForRemap(node, savedLinks) {
	for (const item of savedLinks || []) {
		const linkId = findLinkByTarget(node, item);
		if (linkId == null) continue;
		const link = app.graph?.links?.[linkId];
		const targetNode = link && (app.graph?.getNodeById?.(link.target_id));
		const targetInput = targetNode?.inputs?.[link?.target_slot];
		if (targetInput?.link === linkId) targetInput.link = null;
		try { app.graph?.removeLink?.(linkId); } catch (_) {}
		const out = node.outputs?.find((o) => Array.isArray(o?.links) && o.links.includes(linkId));
		if (out) out.links = out.links.filter((id) => id !== linkId);
	}
}
function findLinkByTarget(node, item) {
	for (let i = 0; i < (node.outputs || []).length; i++) {
		const out = node.outputs[i];
		if (!Array.isArray(out?.links)) continue;
		for (const linkId of out.links) {
			const link = app.graph?.links?.[linkId];
			if (!link) continue;
			if (link.target_id === item.target_id && link.target_slot === item.target_slot) return linkId;
		}
	}
	return null;
}
function restoreSemanticOutputLinks(node, savedLinks, slots) {
	const restored = new Set();
	for (const item of savedLinks || []) {
		const targetIndex = slots.findIndex((s, idx) => slotKey(s, idx) === item.key);
		if (targetIndex < 0) continue;
		const out = node.outputs?.[targetIndex];
		if (!out) continue;
		const targetNode = app.graph?.getNodeById?.(item.target_id);
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (!targetInput) continue;
		try {
			const linkId = app.graph?.nextLinkId?.() || (app.graph.links.length + 1);
			const link = {
				id: linkId,
				origin_id: node.id,
				origin_slot: targetIndex,
				target_id: item.target_id,
				target_slot: item.target_slot,
				type: item.type || out.type,
			};
			app.graph.links[linkId] = link;
			if (!out.links) out.links = [];
			out.links.push(linkId);
			targetInput.link = linkId;
			if (Array.isArray(targetNode?.outputs)) {
				targetNode.setDirtyCanvas?.(true, true);
			}
			restored.add(item.key);
		} catch (_) {}
	}
	return restored;
}
function deleteUnrestoredOutputLinks(savedLinks, restoredKeys) {
	for (const item of savedLinks || []) {
		if (restoredKeys.has(item.key)) continue;
		const targetNode = app.graph?.getNodeById?.(item.target_id);
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (targetInput?.link != null) {
			const link = app.graph?.links?.[targetInput.link];
			if (!link) targetInput.link = null;
		}
	}
}

// ── ⚡️ 链接保持：同步预建输出 + 语义链接恢复 ────────────────────

function broadcastEnabled(node) {
	return node?.properties?.[BROADCAST_PROPERTY] !== false;   // 默认开启
}
function setBroadcastEnabled(node, v) {
	node.properties = node.properties || {};
	node.properties[BROADCAST_PROPERTY] = !!v;
}

function prebuildOutputsFromSaved(node, serializedNode = null) {
	// 优先使用 serializedNode.properties（刚加载工作流时），否则 node.properties
	const props = serializedNode?.properties || node?.properties || {};
	const savedSlots = Array.isArray(props[OUTPUT_SLOTS_PROPERTY]) ? props[OUTPUT_SLOTS_PROPERTY] : null;
	const savedLinks = Array.isArray(props[SAVED_LINKS_PROPERTY]) ? props[SAVED_LINKS_PROPERTY] : [];
	if (!Array.isArray(savedSlots) || !savedSlots.length) return false;

	ensureActiveOutputCount(node, savedSlots.length);
	const slotShims = savedSlots.map((s) => ({
		id: String(s.id || ""),
		kind: outputKindFromType(s.type),
		output_class: s.type,
	}));

	for (let i = 0; i < Math.min(savedSlots.length, (node.outputs || []).length); i++) {
		const out = node.outputs[i];
		const info = savedSlots[i];
		if (!out || !info) continue;
		out.name = String(info.name || `输出${i + 1}`);
		out.localized_name = String(info.name || `输出${i + 1}`);
		out.label = String(info.name || `输出${i + 1}`);
		out.type = String(info.type || "*");
		out.gjj_dynamic = true;
		out.gjj_used_output = true;
		out.gjj_slot_key = String(info.key || `slot_${i}`);
		out.gjj_slot_id = String(info.id || "");
		out.slot_index = i;
		out.gjj_arg_name = `file_${i + 1}`;
		out.hidden = false;
		if (!Array.isArray(out.links)) out.links = [];
	}

	// 保存到临时字段，稍后稳定后用于恢复语义链接（按 key 而非 index）
	node.__gjjAuSavedLinks = savedLinks.slice();
	node.__gjjAuPrebuiltSlots = savedSlots.slice();
	hardRefreshOutputs(node);
	return true;
}

function outputKindFromType(type) {
	const t = String(type || "*").toUpperCase();
	if (t === "MODEL") return "diffusion";
	if (t === "VAE") return "vae";
	if (t === "CLIP") return "clip";
	if (t === "CLIP_VISION") return "clip_vision";
	if (t === "AUDIO_ENCODER") return "audio_encoder";
	return "empty";
}

function tryRestoreSavedLinks(node) {
	const saved = node?.__gjjAuSavedLinks;
	if (!Array.isArray(saved) || !saved.length) return false;
	if (!Array.isArray(node?.outputs) || !node.outputs.length) return false;
	const keyToIndex = new Map();
	for (let i = 0; i < node.outputs.length; i++) {
		const o = node.outputs[i];
		const key = String(o?.gjj_slot_key || o?.gjj_slot_id || `slot_${i}`);
		keyToIndex.set(key, i);
	}
	const restored = new Set();
	for (const item of saved) {
		const key = String(item.key || "");
		const targetIndex = keyToIndex.has(key) ? keyToIndex.get(key) : Number(item.output_index);
		const out = node.outputs[targetIndex];
		if (!out) continue;
		const targetNode = app.graph?.getNodeById?.(item.target_id);
		const targetInput = targetNode?.inputs?.[item.target_slot];
		if (!targetInput || targetInput.link) continue;
		try {
			const linkId = app.graph?.nextLinkId?.() ?? (app.graph.links.length + 1);
			const link = {
				id: linkId,
				origin_id: node.id,
				origin_slot: targetIndex,
				target_id: item.target_id,
				target_slot: item.target_slot,
				type: item.type || out.type,
			};
			app.graph.links[linkId] = link;
			if (!out.links) out.links = [];
			out.links.push(linkId);
			targetInput.link = linkId;
			targetNode?.setDirtyCanvas?.(true, true);
			restored.add(key);
		} catch (_) {}
	}
	node.__gjjAuSavedLinks = [];
	hardRefreshOutputs(node);
	return restored.size > 0;
}

function updateOutputs(node, cfg, opts = {}) {
	const slots = visibleOutputSlots(node, cfg);
	const nextConfigKey = currentConfigKey(node);
	const previousConfigKey = String(node.__gjjAuAppliedConfigKey || node.properties?.gjj_au_applied_config_key || "");
	const layoutChanged = !sameOutputShape(node, slots);
	const configChanged = Boolean(opts?.userConfigChanged || (previousConfigKey && nextConfigKey && previousConfigKey !== nextConfigKey) || layoutChanged);

	const semanticLinks = configChanged ? collectSemanticOutputLinks(node) : [];
	if (configChanged) detachOutputLinksForRemap(node, semanticLinks);

	ensureActiveOutputCount(node, slots.length);

	for (let i = 0; i < Math.min(slots.length, node.outputs?.length || 0); i++) {
		const out = node.outputs?.[i];
		if (!out) continue;
		repairFixedOutput(node, out, slots[i] || null, i);
	}

	if (configChanged) {
		const restored = restoreSemanticOutputLinks(node, semanticLinks, slots);
		deleteUnrestoredOutputLinks(semanticLinks, restored);
	}

	// ⚡️ 广播开启时：在输出端口重建后，按 slot_key 恢复序列化时保存的语义链接
	if (broadcastEnabled(node)) {
		tryRestoreSavedLinks(node);
	} else {
		node.__gjjAuSavedLinks = [];
	}

	node.properties = node.properties || {};
	node.properties.gjj_au_applied_config_key = nextConfigKey;
	node.__gjjAuAppliedConfigKey = nextConfigKey;
	node.properties.gjj_au_output_slots = slots.map((slot, index) => ({
		name: outputLabelFor(slot),
		type: outputTypeFor(slot),
		id: String(slot?.id || ""),
		key: slotKey(slot, index),
		output_index: index,
	}));

	// ⚡️ 实时保存语义链接到 properties（即使没有点保存，输出断连时也能恢复）
	if (broadcastEnabled(node)) {
		node.properties[SAVED_LINKS_PROPERTY] = collectSemanticOutputLinks(node);
	} else {
		delete node.properties[SAVED_LINKS_PROPERTY];
	}
	node.properties[BROADCAST_PROPERTY] = broadcastEnabled(node);

	hardRefreshOutputs(node);
}

function applyConfig(node, opts = {}) {
	const state = ensureState(node);
	if (!state.configs || !state.folders) {
		refreshBackendLists(node, false).finally(() => applyConfig(node, opts));
		return;
	}
	const cfg = currentConfig(node, state);
	const rows = node.__gjjAuRows;
	if (!rows) return;
	node.__gjjAuVisibleRowCount = 0;
	rows.replaceChildren();
	if (!cfg) {
		const empty = document.createElement("div");
		empty.className = "gjj-au-empty";
		empty.textContent = "未读取到模型配置。";
		rows.appendChild(empty);
		node.__gjjAuVisibleRowCount = 1;
		scheduleLayoutRefresh(node, [0, 48, 160]);
		return;
	}
	const configKey = currentConfigKey(node);
	node.__gjjAuAppliedConfig = cfg;
	node.properties = node.properties || {};
	const previousAppliedConfig = String(node.__gjjAuAppliedConfigKey || node.properties?.gjj_au_applied_config_key || "");
	const resetSlotValues = Boolean(opts?.userConfigChanged || (previousAppliedConfig && configKey && previousAppliedConfig !== configKey));

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
		const filteredValues = filterList(list, slot.keywords || []);
		const fileName = `file_${i}`;
		const secondaryFileName = `secondary_file_${i}`;
		const dtypeName = `dtype_${i}`;
		setComboOptions(getWidget(node, fileName), filteredValues);
		const preferredName = preferredNamesForSlot(slot);
		selectFirstIfInvalid(node, fileName, filteredValues, preferredName, resetSlotValues);
		const missingModel = missingModelForSlot(slot, filteredValues);

		if (isDualClipSlot(slot)) {
			const secondaryValues = Array.isArray(list) ? list.map(String) : [];
			setComboOptions(getWidget(node, secondaryFileName), secondaryValues);
			const preferredSecondary = officialNameSeeds(
				slot?.secondary_name,
				slot?.secondary_official_names || [],
			);
			selectFirstIfInvalid(node, secondaryFileName, secondaryValues, preferredSecondary, resetSlotValues);
		} else {
			syncWidget(node, secondaryFileName, "");
		}

		setComboOptions(getWidget(node, dtypeName), state.dtypes || ["default"]);
		selectFirstIfInvalid(node, dtypeName, state.dtypes || ["default"]);
		ensureSettingDefaults(node, slot, i, resetSlotValues);
		syncDerivedSettingsFromModelName(node, slot, index, valueOf(node, fileName));

		const params = paramDefsForSlot(node, slot);
		const hasParams = params.length > 0;

		const row = document.createElement("div");
		row.className = `gjj-au-row ${hasParams ? "has-gear" : ""}`;
		row.classList.toggle("missing", !!missingModel);
		const label = document.createElement("div");
		label.className = "gjj-au-label";
		const icon = officialIconFor(slot);
		label.textContent = `${icon} ${String(slot.label || slot.id || `模型${i}`)}`;
		label.title = slotTitle(slot, folder);
		const select = createSearchableSelect(node, fileName, filteredValues, (value) => {
			syncDerivedSettingsFromModelName(node, slot, index, value);
			saveWidgetValues(node);
		}, {
			placeholder: "输入关键词实时过滤",
			filterKey: fileName,
			missingText: missingModel,
			title: slotTitle(slot, folder),
		});
		row.append(label, select);
		if (hasParams) row.append(createSettingsGear(node, slot, i));
		rows.appendChild(row);
		node.__gjjAuVisibleRowCount += 1;

		if (hasParams && isSettingsOpen(node, slot, i)) {
			rows.appendChild(createParamPanel(node, slot, i));
			node.__gjjAuVisibleRowCount += 1;
		}

		if (isDualClipSlot(slot)) {
			const secondaryValues = Array.isArray(list) ? list.map(String) : [];
			const missingSecondary = missingModelForSlot(slot, secondaryValues, true);
			const secondaryRow = document.createElement("div");
			secondaryRow.className = "gjj-au-row no-gear";
			secondaryRow.classList.toggle("missing", !!missingSecondary);
			const secondaryLabel = document.createElement("div");
			secondaryLabel.className = "gjj-au-label";
			secondaryLabel.textContent = `📎 ${String(slot.secondary_label || "另一个模型")}`;
			secondaryLabel.title = `模型分类: ${folder}\n类型: 另一个模型\n默认值: ${String(slot.secondary_name || "").trim() || "未设置"}`;
			const secondarySelect = createSearchableSelect(node, secondaryFileName, secondaryValues, () => saveWidgetValues(node), {
				placeholder: "输入关键词实时过滤",
				filterKey: secondaryFileName,
				missingText: missingSecondary ? `缺失：${missingSecondary}` : "",
				title: secondaryLabel.title,
			});
			secondaryRow.append(secondaryLabel, secondarySelect);
			rows.appendChild(secondaryRow);
			node.__gjjAuVisibleRowCount += 1;
		}
	});

	updateOutputs(node, cfg, opts);
	scheduleLayoutRefresh(node, [0, 48, 160]);
}

function estimateNodeHeight(node) {
	const rowCount = Math.max(1, Number(node.__gjjAuVisibleRowCount || 0));
	return 34 + 6 + rowCount * 34 + 14;
}

function hardRefreshOutputs(node) {
	try { node.onResize?.(node.size); } catch (_) {}
	try { node.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	scheduleLayoutRefresh(node, [0, 48, 160]);
}
function scheduleLayoutRefresh(node, delays = [0, 48, 160]) {
	if (!node) return;
	clearTimeout(node.__gjjAuLayoutRefreshTimer);
	const firstDelay = Array.isArray(delays) ? delays[0] : delays;
	node.__gjjAuLayoutRefreshTimer = setTimeout(() => {
		requestAnimationFrame(() => refreshNode(node));
	}, Math.max(0, Math.round(Number(firstDelay) || 0)));
}
function refreshNode(node) {
	if (!node) return;
	const width = rememberNodeWidth(node);
	const height = Math.round(estimateNodeHeight(node));
	if (!node.__gjjAuSizing && (Math.abs(Number(node.size?.[0] || 0) - width) > 1 || Math.abs(Number(node.size?.[1] || 0) - height) > 1)) {
		node.__gjjAuSizing = true;
		try { node.setSize?.([width, height]); }
		finally { requestAnimationFrame(() => { node.__gjjAuSizing = false; }); }
	}
	forceDomPassThrough(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function forceDomPassThrough(node) {
	const widget = node?.__gjjAuWidget;
	const container = node?.__gjjAuContainer;
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
	root?.querySelectorAll?.("button,input,select,textarea,.gjj-au-combo-button,.gjj-au-popup,.gjj-au-popup *").forEach((el) => {
		if (el?.style) el.style.pointerEvents = "auto";
	});
}

function buildDom(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-au-loader";
	wrap.style.cssText = `width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:0 ${OUTPUT_HIT_LANE}px 0 0;margin-right:0;pointer-events:none;position:relative;`;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-au-loader * { box-sizing:border-box; }
		.gjj-au-loader,
		.gjj-au-loader .gjj-au-top,
		.gjj-au-loader .gjj-au-rows,
		.gjj-au-loader .gjj-au-row,
		.gjj-au-loader .gjj-au-combo,
		.gjj-au-loader .gjj-au-label { pointer-events:none; }
		.gjj-au-loader .gjj-au-combo-button,
		.gjj-au-loader .gjj-au-refresh,
		.gjj-au-loader .gjj-au-gear,
		.gjj-au-loader .gjj-au-param-panel,
		.gjj-au-loader .gjj-au-param-panel *,
		.gjj-au-loader input,
		.gjj-au-loader button,
		.gjj-au-loader select { pointer-events:auto; }
		.gjj-au-top { display:grid; grid-template-columns:minmax(0,1fr) 34px; gap:6px; align-items:center; min-width:0; }
		.gjj-au-row { display:grid; grid-template-columns:96px minmax(0,1fr); gap:6px; align-items:center; min-width:0; margin-bottom:4px; }
		.gjj-au-row.has-gear { grid-template-columns:96px minmax(0,1fr) 30px; }
		.gjj-au-label { color:#b9c8cc; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-au-refresh,
		.gjj-au-combo-button {
			width:100%; height:28px; min-width:0; padding:3px 7px; border:1px solid #33464e; border-radius:7px;
			background:#2b2d30; color:#f1f5f5; outline:none; font-size:12px;
		}
		.gjj-au-combo { min-width:0; width:100%; position:relative; }
		.gjj-au-combo-button { display:flex; align-items:center; justify-content:space-between; gap:6px; cursor:pointer; text-align:left; }
		.gjj-au-combo-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
		.gjj-au-combo-arrow { color:#9fb0b7; flex:0 0 auto; }
		.gjj-au-combo-button.missing { border-color:#ef4444; background:#3a1518; color:#fecaca; }
		.gjj-au-combo-button.missing .gjj-au-combo-text { color:#fecaca; font-weight:800; }
		.gjj-au-row.missing .gjj-au-label { color:#fecaca; font-weight:700; }
		.gjj-au-refresh { background:#24282b; color:#cdd5d8; cursor:pointer; padding:0; text-align:center; }
		.gjj-au-gear { width:28px; height:28px; padding:0; border:1px solid #33464e; border-radius:7px; background:#24282b; color:#9fb0b7; cursor:pointer; font-size:14px; line-height:1; display:flex; align-items:center; justify-content:center; }
		.gjj-au-gear:hover { background:#2d3338; color:#dff8ea; }
		.gjj-au-gear.on { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-au-select-inline { min-width:0; width:100%; position:relative; }
		.gjj-au-select-inline .gjj-au-combo-button { height:26px; }
		.gjj-au-param-panel { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:4px 8px; padding:4px 0 6px 36px; margin-bottom:4px; border:1px dashed #33464e; border-radius:6px; background:#1a2024; }
		.gjj-au-param-field { display:flex; flex-direction:column; gap:2px; min-width:0; }
		.gjj-au-param-label { color:#7a8a90; font-size:11px; }
		.gjj-au-param-toggle { padding:2px 10px; border:1px solid #33464e; border-radius:5px; background:#2b2d30; color:#cdd5d8; font-size:11px; cursor:pointer; }
		.gjj-au-param-toggle.on { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-au-param-number { width:100%; padding:2px 5px; border:1px solid #33464e; border-radius:5px; background:#0b1418; color:#f1f5f5; font-size:12px; outline:none; }
		.gjj-au-popup { position:fixed; z-index:999999; max-height:420px; padding:7px; border:1px solid #47616b; border-radius:9px; background:#10191d; box-shadow:0 10px 32px rgba(0,0,0,.45); }
		.gjj-au-popup-search { width:100%; height:28px; margin-bottom:6px; padding:3px 7px; border:1px solid #d7eff5; border-radius:6px; background:#0b1418; color:#f1f5f5; outline:none; font-size:12px; }
		.gjj-au-popup-list { max-height:360px; overflow:auto; display:flex; flex-direction:column; gap:4px; }
		.gjj-au-popup-item { width:100%; min-height:28px; padding:5px 8px; border:1px solid #31464e; border-radius:6px; background:#172328; color:#edf4f4; text-align:left; cursor:pointer; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-au-popup-item:hover { background:#21323a; }
		.gjj-au-popup-item.active { border-color:#4f8f7a; background:#103b31; color:#dff8ea; }
		.gjj-au-popup-empty { color:#9caab0; font-size:12px; padding:6px 4px; }
		.gjj-au-sep { height:1px; background:rgba(105,125,134,0.24); margin:1px 0; }
		.gjj-au-empty { color:#9caab0; font-size:12px; padding:4px 2px; }
	`;
	wrap.appendChild(style);

	const top = document.createElement("div");
	top.className = "gjj-au-top";
	const configBox = document.createElement("div");
	configBox.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr);gap:6px;min-width:0;";
	const configSelect = createSearchableSelect(node, "config", comboValues(getWidget(node, "config")), () => applyConfig(node, { userConfigChanged: true }), {
		placeholder: "过滤配置",
		filterKey: "__config",
	});
	node.__gjjAuConfigSelect = configSelect;
	configBox.append(configSelect);
	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.className = "gjj-au-refresh";
	refresh.textContent = "↻";
	refresh.title = "重新读取 models 目录和配置";
	protect(refresh);
	refresh.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshBackendLists(node, true, true);
	});
	top.append(configBox, refresh);
	wrap.appendChild(top);

	const sep = document.createElement("div");
	sep.className = "gjj-au-sep";
	wrap.appendChild(sep);
	const rows = document.createElement("div");
	rows.className = "gjj-au-rows";
	node.__gjjAuRows = rows;
	wrap.appendChild(rows);

	return wrap;
}

function ensureDom(node) {
	if (node.__gjjAuWidget) return;
	const container = buildDom(node);
	node.__gjjAuContainer = container;
	const domWidget = node.addDOMWidget?.("gjj_audio_universal_loader_dom", "HTML", container, { serialize: false, hideOnZoom: false });
	if (domWidget) {
		domWidget.computeSize = (width) => {
			const nodeWidth = Math.round(Number(width || currentNodeWidth(node)));
			return [nodeWidth, Math.round(estimateNodeHeight(node))];
		};
		domWidget.getHeight = () => Math.round(estimateNodeHeight(node));
		node.__gjjAuWidget = domWidget;
		forceDomPassThrough(node);
		requestAnimationFrame(() => forceDomPassThrough(node));
		setTimeout(() => forceDomPassThrough(node), 80);
		if (Array.isArray(node.widgets)) {
			const idx = node.widgets.indexOf(domWidget);
			if (idx > 0) { node.widgets.splice(idx, 1); node.widgets.unshift(domWidget); }
		}
	}
}

function stabilize(node) {
	if (!node) return;
	rememberNodeWidth(node);
	restoreWidgetValues(node);
	ensureDom(node);
	hideNativeWidgets(node);
	applyConfig(node);
	if (!node.__gjjAuBackendListsRequested) {
		node.__gjjAuBackendListsRequested = true;
		refreshBackendLists(node, true);
	}
}
function schedule(node, ms = 0) {
	clearTimeout(node.__gjjAuTimer);
	node.__gjjAuTimer = setTimeout(() => stabilize(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.AudioUniversalModelLoader",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;
		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const w = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (ALL_FIELDS.includes(name)) hideWidget(w);
			return w;
		};
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this, 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			restoreWidgetValues(this, serializedNode);
			// ⚡️ 同步预建输出端口：必须在 ComfyUI 恢复链接之前完成（同步阶段）
			if (broadcastEnabled(this)) {
				try { prebuildOutputsFromSaved(this, serializedNode); } catch (_) {}
			}
			schedule(this, 0);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			rememberNodeWidth(this);
			saveWidgetValues(this, serializedNode);
			originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				// ⚡️ 保存输出槽信息 + 语义链接，供重启/刷新后恢复
				const slots = Array.isArray(this.properties?.[OUTPUT_SLOTS_PROPERTY])
					? this.properties[OUTPUT_SLOTS_PROPERTY]
					: (Array.isArray(this.properties?.gjj_au_output_slots) ? this.properties.gjj_au_output_slots : null);
				if (slots) serializedNode.properties[OUTPUT_SLOTS_PROPERTY] = slots;
				if (broadcastEnabled(this)) {
					try {
						const links = collectSemanticOutputLinks(this);
						serializedNode.properties[SAVED_LINKS_PROPERTY] = links;
						serializedNode.properties[BROADCAST_PROPERTY] = true;
					} catch (_) {}
				} else {
					serializedNode.properties[BROADCAST_PROPERTY] = false;
					delete serializedNode.properties[SAVED_LINKS_PROPERTY];
				}
				serializedNode.properties[SETTINGS_OPEN_PROPERTY] = { ...(this.properties?.[SETTINGS_OPEN_PROPERTY] || {}) };
				serializedNode.properties[FILTER_PROPERTY] = { ...(this.properties?.[FILTER_PROPERTY] || {}) };
				serializedNode.properties[WIDTH_PROPERTY] = this.properties?.[WIDTH_PROPERTY] || currentNodeWidth(this);
			}
		};
		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjAuSizing) {
				rememberNodeWidth(this);
				refreshNode(this);
				scheduleLayoutRefresh(this, [0, 80]);
			}
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			schedule(this, 0);
			return result;
		};
	},

	nodeCreated(node) {
		if (node?.comfyClass === TARGET) schedule(node, 0);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET) {
				stabilize(node);
				// ⚡️ 所有节点加载完后再次尝试恢复保存的语义链接
				// （onConfigure 时目标节点可能还没注册）
				if (broadcastEnabled(node)) {
					try { tryRestoreSavedLinks(node); } catch (_) {}
				}
			}
		}
	},
});
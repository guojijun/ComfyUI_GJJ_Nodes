import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_VideoUniversalModelLoader"]);
const LIST_API = "/gjj/video_universal_loader_lists";
const MAX_SLOTS = 12;
const SAVED_VALUES_PROPERTY = "gjj_video_universal_loader_values";
const FILTER_PROPERTY = "gjj_video_universal_loader_filters";
const OUTPUT_HIT_LANE = 34;

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
	audio_encoder: "AUDIO_ENCODER",
	empty: "*",
	latent_upscale_model: "LATENT_UPSCALE_MODEL",
	name: "STRING",
	name_any: "STRING",
};

const ALL_FIELDS = ["config", "use_accel_lora", "clip_type_override"];
for (let i = 1; i <= MAX_SLOTS; i++) ALL_FIELDS.push(`file_${i}`, `secondary_file_${i}`, `dtype_${i}`);

function getWidget(node, name) { return node.widgets?.find((w) => w?.name === name); }
function valueOf(node, name, fallback = "") { return String(getWidget(node, name)?.value ?? fallback ?? ""); }
function safeAssign(obj, key, value) { try { obj[key] = value; } catch (_) {} }
function lower(text) { return String(text || "").replaceAll("\\", "/").toLowerCase(); }

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

function selectFirstIfInvalid(node, name, values, preferred = "") {
	const w = getWidget(node, name); if (!w) return;
	const list = Array.isArray(values) ? values.map(String) : [];
	const cur = String(w.value ?? "");
	const preferredValue = String(preferred ?? "");
	if (!cur || !list.includes(cur)) {
		if (preferredValue && list.includes(preferredValue)) w.value = preferredValue;
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
	if (allowAny) return /\.(safetensors|sft|ckpt|pt|pth|bin|torchscript\.pt)$/i.test(v);
	return /\.(safetensors|sft|ckpt|pt|pth)$/i.test(v);
}

function splitWords(text) { return String(text || "").trim().toLowerCase().split(/[\s,，;；|]+/).filter(Boolean); }

function scoreName(name, keywords = []) {
	const text = lower(name); let score = 0;
	keywords.forEach((kw, idx) => {
		const word = String(kw || "").toLowerCase(); if (!word) return;
		if (text.includes(word)) score += 100 - idx;
		if (text.includes(`_${word}`) || text.includes(`-${word}`)) score += 10;
	});
	if (text.endsWith(".safetensors")) score += 10;
	score -= (text.match(/\//g) || []).length;
	return score;
}

function filterList(list, keywords = [], allowAny = false) {
	const words = (keywords || []).map((v) => String(v || "").trim().toLowerCase()).filter(Boolean);
	const source = Array.isArray(list) ? list.filter((name) => isUsable(name, allowAny)) : [];
	const matched = words.length ? source.filter((name) => words.every((word) => lower(name).includes(word))) : source;
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
		dtypes: ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"],
		clipTypes: ["auto", "wan", "ltxv", "hunyuan_video", "flux", "stable_diffusion"],
		loading: false,
	};
	return node.__gjjVUState;
}

async function refreshBackendLists(node, rerender = true) {
	const state = ensureState(node);
	if (state.loading) return;
	state.loading = true;
	try {
		const response = await fetch(LIST_API);
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

if (!window.__gjjVUClosePopupBound) {
	window.__gjjVUClosePopupBound = true;
	document.addEventListener("pointerdown", () => closeSearchPopup?.());
}

function syncWidget(node, name, value) {
	const w = getWidget(node, name); if (!w) return;
	let next = value;
	if (typeof w.value === "boolean") next = Boolean(value);
	else if (typeof w.value === "number") next = Number.parseFloat(value);
	w.value = next;
	w.callback?.(next);
	saveWidgetValues(node);
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
	let searchText = "";

	const setVisualValue = (value) => {
		const raw = String(value ?? "");
		text.textContent = displayNameForValue(raw, optionLabels) || "未选择";
		button.title = opts.title || raw || "未选择";
	};

	const setValue = (value, trigger = true) => {
		const next = String(value ?? "");
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
		setVisualValue(w?.value ?? optionValues[0] ?? "");
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
			const words = splitWords(searchText);
			let shown = optionValues.filter((value) => {
				const label = displayNameForValue(value, optionLabels);
				const hay = `${value} ${label}`.toLowerCase().replaceAll("\\", "/");
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
	setVisualValue(w?.value ?? list[0] ?? "");
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
		const values = [input?.name, input?.localized_name, input?.label].map((item) => String(item || ""));
		return values.includes(name) || (displayName && values.includes(displayName));
	});
}
function inputHasLink(input) { return input?.link !== undefined && input?.link !== null; }
function hasExternalLoraBool(node) {
	return inputHasLink(getInputSlot(node, "🚕 加速LoRA", "🚕 加速LoRA"))
		|| inputHasLink(getInputSlot(node, "use_accel_lora_in", "🚕 加速LoRA"));
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
function visibleOutputSlots(cfg) {
	// 后端也下发 output_slots；这里优先使用它，保证前端输出顺序与后端返回 tuple 一致。
	// V20 开始不再插入占位、不再动态增删输出口，只按配置顺序修正 output1-output12 的标签和类型。
	const source = Array.isArray(cfg?.output_slots) ? cfg.output_slots : (cfg?.slots || []);
	return source.slice(0, MAX_SLOTS).filter((slot) => !isLoraSlot(slot) && !isNameOnlySlot(slot));
}
function hasLoraSlots(cfg) { return (cfg?.slots || []).some(isLoraSlot); }
function slotKey(slot, idx = 0) {
	return `${String(slot?.id || `slot_${idx}`)}::${String(slot?.kind || "") }::${String(slot?.folder || "")}`;
}
function isGjjLoraInput(input) {
	const text = [input?.name, input?.localized_name, input?.label].map((v) => String(v || "")).join(" ");
	return text.includes("use_accel_lora_in") || text.includes("lora_chain_config") || text.includes("🚕") || text.includes("🧬");
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

	const label = document.createElement("span");
	label.className = "gjj-vu-small-label";
	label.textContent = "🚕 加速LoRA";
	label.title = "控制当前配置的内置加速 LoRA；没有内置加速 LoRA 的配置不显示此按钮。";

	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-vu-toggle";
	const sync = () => {
		const external = hasExternalLoraBool(node);
		const on = effectiveUseLora(node);
		button.dataset.value = external ? "external" : (on ? "true" : "false");
		button.textContent = external ? "🚕 外接" : (on ? "✅ 开" : "⬜ 关");
		button.disabled = external;
		button.title = external ? "加速 LoRA 开关由外部 BOOLEAN 输入控制。" : "点击开关内部/外接 LoRA 叠加。";
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

	const hint = document.createElement("div");
	hint.className = "gjj-vu-lora-hint";
	hint.textContent = hasExternalLoraConfig(node) ? "🧬 已接入 LoRA配置" : "🧬 可接 LoRA配置";
	bar.append(label, button, hint);
	node.__gjjVULoraToggleSync = sync;
	sync();
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
		.gjj-vu-loader .gjj-vu-toggle,
		.gjj-vu-loader input,
		.gjj-vu-loader button,
		.gjj-vu-loader select { pointer-events:auto; }
		.gjj-vu-top { display:grid; grid-template-columns:minmax(0,1fr) 34px; gap:6px; align-items:center; min-width:0; }
		.gjj-vu-row { display:grid; grid-template-columns:96px minmax(0,1fr) 72px; gap:6px; align-items:center; min-width:0; margin-bottom:4px; }
		.gjj-vu-row.no-dtype { grid-template-columns:108px minmax(0,1fr); }
		.gjj-vu-label, .gjj-vu-small-label { color:#b9c8cc; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-vu-refresh, .gjj-vu-toggle, .gjj-vu-combo-button {
			width:100%; height:28px; min-width:0; padding:3px 7px; border:1px solid #33464e; border-radius:7px;
			background:#2b2d30; color:#f1f5f5; outline:none; font-size:12px;
		}
		.gjj-vu-combo { min-width:0; width:100%; position:relative; }
		.gjj-vu-combo-button { display:flex; align-items:center; justify-content:space-between; gap:6px; cursor:pointer; text-align:left; }
		.gjj-vu-combo-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
		.gjj-vu-combo-arrow { color:#9fb0b7; flex:0 0 auto; }
		.gjj-vu-refresh, .gjj-vu-toggle { background:#24282b; color:#cdd5d8; cursor:pointer; padding:0; text-align:center; }
		.gjj-vu-toggle[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-vu-toggle[data-value="external"] { border-color:#4b5860; background:#1d2327; color:#9caab0; cursor:default; }
		.gjj-vu-lora-bar { display:grid; grid-template-columns:74px 82px minmax(0,1fr); gap:6px; align-items:center; min-width:0; }
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
	const configSelect = createSearchableSelect(node, "config", comboValues(getWidget(node, "config")), () => applyConfig(node, { userConfigChanged: true }), null, { placeholder: "过滤配置" });
	node.__gjjVUConfigSelect = configSelect;
	configBox.append(configSelect);
	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.className = "gjj-vu-refresh";
	refresh.textContent = "↻";
	refresh.title = "重新读取 models 目录和配置";
	protect(refresh);
	refresh.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); refreshBackendLists(node, true); });
	top.append(configBox, refresh);
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
			const nodeWidth = Math.max(430, Number(width || node.size?.[0] || 470));
			return [Math.max(400, nodeWidth), estimateNodeHeight(node)];
		};
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
	// 与官方插口颜色对齐：MODEL 紫、VAE 红、CLIP 黄。
	if (["diffusion", "checkpoint_model"].includes(kind)) return "🟣";
	if (["wanvideo_model"].includes(kind)) return "🟣";
	if (["vae", "checkpoint_vae", "ltx_audio_vae", "wan_vae"].includes(kind)) return "🔴";
	if (["clip", "checkpoint_clip", "wan_t5_encoder"].includes(kind)) return "🟡";
	if (["clip_vision", "audio_encoder"].includes(kind)) return "🔵";
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
	};
}
function sameOutputShape(node, slots) {
	if (!Array.isArray(node.outputs) || node.outputs.length !== slots.length) return false;
	for (let i = 0; i < slots.length; i++) {
		const out = node.outputs[i];
		const label = outputLabelFor(slots[i]);
		const type = outputTypeFor(slots[i]);
		const expectedKey = slotKey(slots[i], i);
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

function collectSemanticOutputLinks(node) {
	const saved = [];
	const outputs = Array.isArray(node.outputs) ? node.outputs : [];
	for (let i = 0; i < outputs.length; i++) {
		const out = outputs[i];
		const slotId = String(out?.gjj_slot_id || "");
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
		const slotId = String(slots[i]?.id || "");
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
function ensureActiveOutputCount(node, count) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	const target = Math.max(0, Math.min(MAX_SLOTS, Number(count) || 0));
	// 后端固定 output1-output12 / *，但前端只显示当前配置真正用到的前 N 个输出口。
	// 不再用 hidden 留空，因为 LiteGraph 仍会画圆点，占用视觉空间。
	removeExtraOutputLinks(node, target);
	if (node.outputs.length > target) node.outputs.splice(target);
	while (node.outputs.length < target) {
		try { node.addOutput?.("*", "*"); }
		catch (_) { node.outputs.push({ name: "*", type: "*", links: [] }); }
	}
}

function repairFixedOutput(node, out, slot, index) {
	const used = !!slot;
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
	out.slot_index = index;
	out.gjj_arg_name = `file_${index + 1}`;
	out.gjj_output_kind = used ? String(slot?.kind || "") : "unused";
	out.gjj_output_type = type;
	if (used && String(slot?.kind || "") === "empty") {
		out.name = "";
		out.label = "";
		out.localized_name = "";
		out.type = "*";
		out.color_on = "rgba(90,96,118,0.28)";
		out.color_off = "rgba(90,96,118,0.18)";
	}
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
	const slots = visibleOutputSlots(cfg);
	const nextConfigKey = currentConfigKey(node);
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
	for (let i = 0; i < slots.length; i++) {
		const out = node.outputs?.[i];
		if (!out) continue;
		repairFixedOutput(node, out, slots[i] || null, i);
		out.hidden = false;
		out.gjj_hidden_unused = false;
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
	const rest = old.filter((input) => !isWanRuntimeArgsInput(input) && !isExtraModelChainInput(input) && !isLoraConfigInput(input) && !isAccelLoraInput(input));
	const nextInputs = [wanArgsInput, extraInput, cfgInput];
	if (hasLoraSlots(cfg)) nextInputs.push(boolInput);
	node.inputs = [...nextInputs, ...rest];
}

function scheduleLayoutRefresh(node, delays = [0, 48, 160]) {
	if (!node) return;
	for (const delay of Array.isArray(delays) ? delays : [Number(delays) || 0]) {
		setTimeout(() => {
			requestAnimationFrame(() => refreshNode(node));
		}, Math.max(0, Number(delay) || 0));
	}
}

function currentConfig(node, state) {
	const configKeys = Object.keys(state.configs || {});
	const cw = getWidget(node, "config");
	if (configKeys.length) {
		const labels = {};
		for (const key of configKeys) labels[key] = state.configs[key]?.label ? `${state.configs[key].label}` : key;
		setComboOptions(cw, configKeys);
		if (cw?.__gjjVUSetOptions) cw.__gjjVUSetOptions(configKeys, labels);
		if (!configKeys.includes(String(cw?.value ?? ""))) { if (cw) cw.value = configKeys[0]; }
		if (cw?.__gjjVUSetValue) cw.__gjjVUSetValue(String(cw?.value ?? configKeys[0] ?? ""), false);
	}
	const key = valueOf(node, "config", configKeys[0] || "");
	return state.configs[key] || state.configs[configKeys[0]] || null;
}

function applyConfig(node, opts = {}) {
	const state = ensureState(node);
	if (!state.configs || !state.folders) { refreshBackendLists(node, false).finally(() => applyConfig(node)); return; }
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
	(cfg.slots || []).slice(0, MAX_SLOTS).forEach((slot, index) => {
		const i = index + 1;
		if (String(slot?.kind || "") === "empty") {
			syncWidget(node, `file_${i}`, "");
			syncWidget(node, `secondary_file_${i}`, "");
			syncWidget(node, `dtype_${i}`, "default");
			return;
		}
		const folder = String(slot.folder || "");
		const list = state.folders?.[folder] || [];
		const allowAny = String(slot.kind || "") === "name_any";
		const values = filterList(list, slot.keywords || [], allowAny);
		const secondaryValues = Array.isArray(list) ? list.map(String) : [];
		const fileName = `file_${i}`;
		const secondaryFileName = `secondary_file_${i}`;
		const dtypeName = `dtype_${i}`;
		setComboOptions(getWidget(node, fileName), values);
		const preferredName = String(slot.preferred_name || slot.required_name || "").trim();
		selectFirstIfInvalid(node, fileName, values, preferredName);
		if (isDualClipSlot(slot)) {
			setComboOptions(getWidget(node, secondaryFileName), secondaryValues);
			const preferredSecondary = String(slot.secondary_name || "").trim();
			selectFirstIfInvalid(node, secondaryFileName, secondaryValues, preferredSecondary);
		} else {
			syncWidget(node, secondaryFileName, "");
		}
		setComboOptions(getWidget(node, dtypeName), state.dtypes || ["default"]);
		selectFirstIfInvalid(node, dtypeName, state.dtypes || ["default"]);

		const row = document.createElement("div");
		row.className = `gjj-vu-row ${slotNeedsDtype(slot) ? "" : "no-dtype"}`;
		if (isLoraSlot(slot) && !loraEnabled) row.style.display = "none";
		const label = document.createElement("div");
		label.className = "gjj-vu-label";
		const icon = isLoraSlot(slot) ? "🟠" : officialIconFor(slot);
		label.textContent = `${icon} ${String(slot.label || slot.id || `模型${i}`)}`;
		label.title = `目录: models/${folder}\n类型: ${String(slot.kind || "")}\n关键词: ${(slot.keywords || []).join(", ")}`;
		const select = createSearchableSelect(node, fileName, values, () => saveWidgetValues(node), null, { placeholder: "输入关键词实时过滤", title: label.title });
		row.append(label, select);
		if (slotNeedsDtype(slot)) {
			const dtype = createSelect(node, dtypeName, state.dtypes || ["default"], () => saveWidgetValues(node));
			dtype.title = "加载 dtype；default 使用 ComfyUI 默认策略。";
			row.append(dtype);
		}
		rows.appendChild(row);
		node.__gjjVUVisibleRowCount += 1;
		if (isDualClipSlot(slot)) {
			const secondaryRow = document.createElement("div");
			secondaryRow.className = "gjj-vu-row no-dtype";
			const secondaryLabel = document.createElement("div");
			secondaryLabel.className = "gjj-vu-label";
			const secondaryIcon = officialIconFor(slot);
			const secondaryLabelText = String(slot.secondary_label || "另一个模型");
			secondaryLabel.textContent = `${secondaryIcon} ${secondaryLabelText}`;
			secondaryLabel.title = `目录: models/${folder}\n类型: 另一个模型\n默认值: ${String(slot.secondary_name || "").trim() || "未设置"}`;
			const secondarySelect = createSearchableSelect(node, secondaryFileName, secondaryValues, () => saveWidgetValues(node), null, { placeholder: "输入关键词实时过滤", title: secondaryLabel.title });
			secondaryRow.append(secondaryLabel, secondarySelect);
			rows.appendChild(secondaryRow);
			node.__gjjVUVisibleRowCount += 1;
		}
	});
	for (let i = (cfg.slots || []).length + 1; i <= MAX_SLOTS; i++) { syncWidget(node, `file_${i}`, ""); syncWidget(node, `secondary_file_${i}`, ""); syncWidget(node, `dtype_${i}`, "default"); }
	updateOutputs(node, cfg, opts);
	node.__gjjVULoraToggleSync?.();
	saveWidgetValues(node);
	scheduleLayoutRefresh(node, [0, 48, 160]);
}

function refreshNode(node) {
	if (!node) return;
	const width = Math.max(430, Math.min(Number(node.size?.[0] || 470), 500));
	const height = estimateNodeHeight(node);
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
	restoreWidgetValues(node);
	ensureDom(node);
	hideNativeWidgets(node);
	applyConfig(node);
	refreshBackendLists(node, true);
}
function schedule(node, ms = 0) { clearTimeout(node.__gjjVUTimer); node.__gjjVUTimer = setTimeout(() => stabilize(node), ms); }

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
			saveWidgetValues(this, serializedNode);
			originalOnSerialize?.apply(this, [serializedNode]);
			saveWidgetValues(this, serializedNode);
		};
		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) { const result = originalOnResize?.apply(this, args); if (!this.__gjjVUSizing) refreshNode(this); return result; };
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) { const result = originalOnConnectionsChange?.apply(this, args); schedule(this, 0); return result; };
	},
	nodeCreated(node) { if (TARGET_NODES.has(node?.comfyClass)) schedule(node, 0); },
	setup() { for (const node of app.graph?._nodes || []) if (TARGET_NODES.has(node?.comfyClass)) stabilize(node); },
});

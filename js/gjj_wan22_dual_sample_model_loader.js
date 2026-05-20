import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_Wan22DualSampleModelLoader"]);

const FIELD = {
	baseFilter: "base_filter",
	useLora: "use_accel_lora",
	useLoraIn: "use_accel_lora_in",
	loraConfig: "lora_chain_config",
	highModelFilter: "high_model_filter",
	lowModelFilter: "low_model_filter",
	highLoraFilter: "high_lora_filter",
	lowLoraFilter: "low_lora_filter",
	vaeFilter: "vae_filter",
	clipFilter: "clip_filter",
	vaeName: "vae_name",
	clipName: "clip_name",
	clipType: "clip_type",
	clipDtype: "clip_dtype",
	highModel: "high_model",
	highDtype: "high_dtype",
	lowModel: "low_model",
	lowDtype: "low_dtype",
	highLora: "high_lora",
	highLoraStrength: "high_lora_strength",
	lowLora: "low_lora",
	lowLoraStrength: "low_lora_strength",
};

const ALL_FIELDS = Object.values(FIELD);
const SELECT_FIELDS = new Set([
	FIELD.highModel, FIELD.lowModel, FIELD.highLora, FIELD.lowLora,
	FIELD.highDtype, FIELD.lowDtype, FIELD.vaeName, FIELD.clipName, FIELD.clipType, FIELD.clipDtype,
]);
const LIST_API = "/gjj/wan22_dual_loader_lists";
const SAVED_VALUES_PROPERTY = "gjj_wan22_saved_values";
const DEFAULTS = {
	[FIELD.baseFilter]: "wan2.2_t2v",
	[FIELD.highModelFilter]: "high_",
	[FIELD.lowModelFilter]: "low_",
	[FIELD.highLoraFilter]: "high_",
	[FIELD.lowLoraFilter]: "low_",
	[FIELD.vaeFilter]: "wan",
	[FIELD.clipFilter]: "umt5_xxl",
	[FIELD.clipType]: "wan",
	[FIELD.clipDtype]: "default",
	[FIELD.highDtype]: "default",
	[FIELD.lowDtype]: "default",
	[FIELD.highLoraStrength]: 1,
	[FIELD.lowLoraStrength]: 1,
};

const LABELS = {
	[FIELD.baseFilter]: "🔍",
	[FIELD.useLora]: "🚕",
	[FIELD.highModel]: "High",
	[FIELD.lowModel]: "Low",
	[FIELD.highDtype]: "⚙",
	[FIELD.lowDtype]: "⚙",
	[FIELD.highLora]: "High LoRA",
	[FIELD.lowLora]: "Low LoRA",
	[FIELD.highLoraStrength]: "💪",
	[FIELD.lowLoraStrength]: "💪",
};

const TIPS = {
	[FIELD.baseFilter]: "总过滤词：不区分大小写，支持子目录。默认 wan2.2_t2v。",
	[FIELD.useLora]: "加速 LoRA：开启后加载 high / low 对应 LoRA；关闭后隐藏 LoRA 行。",
	[FIELD.highModel]: "High 模型：models/diffusion_models 中匹配 总过滤词 + high_ 的文件。",
	[FIELD.lowModel]: "Low 模型：models/diffusion_models 中匹配 总过滤词 + low_ 的文件。",
	[FIELD.highDtype]: "High 模型数据类型",
	[FIELD.lowDtype]: "Low 模型数据类型",
	[FIELD.highLora]: "High LoRA：models/loras 中匹配 总过滤词 + high_ 的文件。",
	[FIELD.lowLora]: "Low LoRA：models/loras 中匹配 总过滤词 + low_ 的文件。",
	[FIELD.highLoraStrength]: "High LoRA 模型强度",
	[FIELD.lowLoraStrength]: "Low LoRA 模型强度",
	[FIELD.vaeName]: "VAE：models/vae 中默认匹配 wan 的文件。",
	[FIELD.clipName]: "CLIP：models/text_encoders 中默认匹配 umt5_xxl 的文件。",
	[FIELD.clipType]: "CLIP 类型。Wan2.2 通常使用 wan。",
	[FIELD.clipDtype]: "CLIP 数据类型，默认 default。",
};

function getWidget(node, name) {
	return node.widgets?.find((w) => w?.name === name);
}

function getInputSlot(node, name, displayName = "") {
	return node.inputs?.find((input) => {
		const values = [input?.name, input?.localized_name, input?.label].map((item) => String(item || ""));
		return values.includes(name) || (displayName && values.includes(displayName));
	});
}

function inputHasLink(input) {
	return input?.link !== undefined && input?.link !== null;
}

function hasLoraExternalControl(node) {
	return inputHasLink(getInputSlot(node, FIELD.useLoraIn, "🚕"))
		|| inputHasLink(getInputSlot(node, FIELD.useLoraIn, "🚕 加速LoRA"))
		|| inputHasLink(getInputSlot(node, FIELD.useLoraIn, "加速LoRA"));
}

function hasExternalLoraConfig(node) {
	return inputHasLink(getInputSlot(node, FIELD.loraConfig, "🧬"))
		|| inputHasLink(getInputSlot(node, FIELD.loraConfig, "🧬 LoRA配置"))
		|| inputHasLink(getInputSlot(node, FIELD.loraConfig, "LoRA配置"));
}

function effectiveUseLoraEnabled(node) {
	if (hasLoraExternalControl(node)) {
		// 连接外部布尔后，前端无法同步拿到运行时数值；面板只负责隐藏内部按钮。
		// 为避免误隐藏 LoRA 设置，连接时默认保持 LoRA 区域可见，实际执行由后端外部布尔决定。
		return true;
	}
	return Boolean(getWidget(node, FIELD.useLora)?.value);
}

function getValue(node, name, fallback = "") {
	return String(getWidget(node, name)?.value ?? DEFAULTS[name] ?? fallback ?? "");
}

function setValue(node, name, value) {
	const w = getWidget(node, name);
	if (!w) return;
	w.value = value;
	w.callback?.(value);
	if (w.element && "value" in w.element) w.element.value = value;
	if (w.inputEl && "value" in w.inputEl) w.inputEl.value = value;
	saveWidgetValues(node);
}

function comboValues(w) {
	if (!w) return [];
	const values = w.__gjjWan22AllValues || w.options?.values || w.options?.values_list || [];
	return Array.isArray(values) ? values.map(String) : [];
}

function ensureNodeState(node) {
	node.__gjjWan22State = node.__gjjWan22State || {
		diffusionModels: null,
		loras: null,
		vaes: null,
		textEncoders: null,
		loadingLists: false,
	};
	return node.__gjjWan22State;
}

function originalValues(node, name) {
	const state = ensureNodeState(node);
	if (name === FIELD.highModel || name === FIELD.lowModel) {
		return Array.isArray(state.diffusionModels) ? state.diffusionModels : comboValues(getWidget(node, name));
	}
	if (name === FIELD.highLora || name === FIELD.lowLora) {
		return Array.isArray(state.loras) ? state.loras : comboValues(getWidget(node, name));
	}
	if (name === FIELD.vaeName) {
		return Array.isArray(state.vaes) ? state.vaes : comboValues(getWidget(node, name));
	}
	if (name === FIELD.clipName) {
		return Array.isArray(state.textEncoders) ? state.textEncoders : comboValues(getWidget(node, name));
	}
	return comboValues(getWidget(node, name));
}

async function refreshBackendLists(node, rerender = true) {
	const state = ensureNodeState(node);
	if (state.loadingLists) return;
	state.loadingLists = true;
	try {
		const response = await fetch(LIST_API);
		if (response?.ok) {
			const payload = await response.json();
			state.diffusionModels = Array.isArray(payload?.diffusion_models) ? payload.diffusion_models.map(String) : state.diffusionModels;
			state.loras = Array.isArray(payload?.loras) ? payload.loras.map(String) : state.loras;
			state.vaes = Array.isArray(payload?.vae) ? payload.vae.map(String) : state.vaes;
			state.textEncoders = Array.isArray(payload?.text_encoders) ? payload.text_encoders.map(String) : state.textEncoders;
		}
	} catch (error) {
		console.warn("[GJJ Wan2.2] 模型/LoRA 列表读取失败，回退到节点初始列表", error);
	} finally {
		state.loadingLists = false;
	}
	if (rerender) {
		applyFilters(node);
		syncProxyInputs(node);
		updateLoraRows(node);
		refreshNode(node);
		requestAnimationFrame(() => {
			applyFilters(node);
			syncProxyInputs(node);
			updateLoraRows(node);
			refreshNode(node);
		});
	}
}

function rememberOriginalLists(node) {
	for (const name of [
		FIELD.highModel, FIELD.lowModel, FIELD.highLora, FIELD.lowLora,
		FIELD.highDtype, FIELD.lowDtype, FIELD.vaeName, FIELD.clipName, FIELD.clipType, FIELD.clipDtype,
	]) {
		const w = getWidget(node, name);
		if (w) w.__gjjWan22Node = node;
		if (w && !w.__gjjWan22AllValues) {
			w.__gjjWan22AllValues = comboValues(w);
		}
	}
	const state = ensureNodeState(node);
	if (!Array.isArray(state.diffusionModels) || !Array.isArray(state.loras) || !Array.isArray(state.vaes) || !Array.isArray(state.textEncoders)) {
		refreshBackendLists(node, true);
	}
}

function lower(text) {
	return String(text || "").replaceAll("\\", "/").toLowerCase();
}

function isUsableModelFile(name) {
	const value = lower(name);
	return value.endsWith(".safetensors") && !value.endsWith(".metadata.json");
}

function isUsableLoraFile(name) {
	const value = lower(name);
	return value.endsWith(".safetensors") && !value.endsWith(".metadata.json");
}

function filterList(list, ...keywords) {
	const words = keywords.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean);
	const source = Array.isArray(list) ? list : [];
	if (!words.length) return source.slice();
	return source.filter((name) => words.every((word) => lower(name).includes(word)));
}

function filterModelList(list, ...keywords) {
	return filterList(list, ...keywords).filter(isUsableModelFile);
}

function filterLoraList(list, ...keywords) {
	return filterList(list, ...keywords).filter(isUsableLoraFile);
}

function filterSafeTensorList(list, ...keywords) {
	return filterList(list, ...keywords).filter((name) => lower(name).endsWith(".safetensors"));
}

function branchPriorityScore(name, branch) {
	const text = lower(name);
	const target = String(branch || "").toLowerCase();
	let score = 0;

	if (target === "high_") {
		if (text.includes("high_noise")) score += 120;
		if (text.includes("high_")) score += 80;
		if (text.includes("_high")) score += 70;
		if (text.includes("high")) score += 30;
		if (text.includes("low_noise") || text.includes("low_") || text.includes("_low")) score -= 1000;
	} else if (target === "low_") {
		if (text.includes("low_noise")) score += 120;
		if (text.includes("low_")) score += 80;
		if (text.includes("_low")) score += 70;
		if (text.includes("low")) score += 30;
		if (text.includes("high_noise") || text.includes("high_") || text.includes("_high")) score -= 1000;
	}
	return score;
}

function sortBranchList(values, branch) {
	return values.slice().sort((a, b) => {
		const diff = branchPriorityScore(b, branch) - branchPriorityScore(a, branch);
		if (diff !== 0) return diff;
		return String(a).localeCompare(String(b), "zh-Hans-CN");
	});
}

function firstBranchValue(values, branch) {
	const sorted = sortBranchList(values, branch);
	return sorted[0] || "";
}


function setComboOptions(w, values) {
	if (!w) return;
	w.options = w.options || {};
	w.options.values = values;
	w.options.values_list = values;
	w.options.items = values;
	if (w.__gjjWan22Input?.tagName === "SELECT") {
		const select = w.__gjjWan22Input;
		select.replaceChildren();
		for (const value of values) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			select.appendChild(option);
		}
	}
}

function selectFirstIfInvalid(w, values, branch = "") {
	if (!w) return;
	const cur = String(w.value || "");
	if (!cur || !values.includes(cur)) {
		w.value = branch ? firstBranchValue(values, branch) : (values[0] || "");
		w.callback?.(w.value);
	}
	if (w.__gjjWan22Input && "value" in w.__gjjWan22Input) {
		w.__gjjWan22Input.value = String(w.value || "");
	}
	// 选中项、dtype、强度等都主动写入 properties，避免隐藏 widget 的值漏存。
	const node = w?.__gjjWan22Node;
	if (node) saveWidgetValues(node);
}

function applyFilters(node) {
	rememberOriginalLists(node);

	const base = getValue(node, FIELD.baseFilter, "wan2.2_t2v");

	const highModel = getWidget(node, FIELD.highModel);
	const lowModel = getWidget(node, FIELD.lowModel);
	const highLora = getWidget(node, FIELD.highLora);
	const lowLora = getWidget(node, FIELD.lowLora);
	const vae = getWidget(node, FIELD.vaeName);
	const clip = getWidget(node, FIELD.clipName);

	const highModelRole = getValue(node, FIELD.highModelFilter, "high_");
	const lowModelRole = getValue(node, FIELD.lowModelFilter, "low_");
	const highLoraRole = getValue(node, FIELD.highLoraFilter, "high_");
	const lowLoraRole = getValue(node, FIELD.lowLoraFilter, "low_");
	const vaeFilter = getValue(node, FIELD.vaeFilter, "wan");
	const clipFilter = getValue(node, FIELD.clipFilter, "umt5_xxl");

	let highModelList = filterModelList(originalValues(node, FIELD.highModel), base, highModelRole);
	let lowModelList = filterModelList(originalValues(node, FIELD.lowModel), base, lowModelRole);

	// 模型优先使用“总过滤词 + high_/low_”；如果总过滤词太窄，再退回只按 high_/low_。
	if (!highModelList.length) highModelList = filterModelList(originalValues(node, FIELD.highModel), highModelRole);
	if (!lowModelList.length) lowModelList = filterModelList(originalValues(node, FIELD.lowModel), lowModelRole);

	// LoRA 按你的要求只用后台 high_/low_ 过滤，不强制叠加总过滤词。
	let highLoraList = filterLoraList(originalValues(node, FIELD.highLora), highLoraRole);
	let lowLoraList = filterLoraList(originalValues(node, FIELD.lowLora), lowLoraRole);

	// 加速 LoRA、VAE、CLIP 基本固定，不受顶部动态关键词影响。
	// LoRA 只按后台 high_/low_ 分支词过滤；不再用 base 兜底，避免关键词改变时影响 LoRA 列表。
	let vaeList = filterSafeTensorList(originalValues(node, FIELD.vaeName), vaeFilter);
	if (!vaeList.length) vaeList = filterSafeTensorList(originalValues(node, FIELD.vaeName));

	let clipList = filterSafeTensorList(originalValues(node, FIELD.clipName), clipFilter);
	if (!clipList.length) clipList = filterSafeTensorList(originalValues(node, FIELD.clipName));

	highModelList = sortBranchList(highModelList, highModelRole);
	lowModelList = sortBranchList(lowModelList, lowModelRole);
	highLoraList = sortBranchList(highLoraList, highLoraRole);
	lowLoraList = sortBranchList(lowLoraList, lowLoraRole);

	setComboOptions(highModel, highModelList);
	setComboOptions(lowModel, lowModelList);
	setComboOptions(highLora, highLoraList);
	setComboOptions(lowLora, lowLoraList);
	setComboOptions(vae, vaeList);
	setComboOptions(clip, clipList);

	selectFirstIfInvalid(highModel, highModelList, highModelRole);
	selectFirstIfInvalid(lowModel, lowModelList, lowModelRole);
	selectFirstIfInvalid(highLora, highLoraList, highLoraRole);
	selectFirstIfInvalid(lowLora, lowLoraList, lowLoraRole);
	selectFirstIfInvalid(vae, vaeList);
	selectFirstIfInvalid(clip, clipList);

	updateLoraRows(node);
	refreshNode(node);
}

function safeAssign(w, key, value) {
	try { w[key] = value; } catch (_) {}
}

function collapseElement(el) {
	if (!el?.style) return;
	el.style.display = "none";
	el.style.pointerEvents = "none";
	el.style.height = "0px";
	el.style.minHeight = "0px";
	el.style.maxHeight = "0px";
	el.style.margin = "0px";
	el.style.padding = "0px";
	el.style.border = "0px";
	el.style.overflow = "hidden";
}

function hideWidget(w) {
	if (!w || w === w?.__gjjWan22SkipHide) return;
	safeAssign(w, "hidden", true);
	safeAssign(w, "type", `converted-widget:${w.name || "hidden"}`);
	safeAssign(w, "label", "");
	w.computeSize = () => [0, -4];
	w.getHeight = () => -4;
	w.draw = () => {};
	safeAssign(w, "y", 0);
	safeAssign(w, "last_y", 0);
	safeAssign(w, "size", [0, -4]);
	safeAssign(w, "height", -4);
	safeAssign(w, "serialize", true);
	if (w.options && typeof w.options === "object") {
		w.options.hidden = true;
		w.options.display = "hidden";
	}
	collapseElement(w.inputEl);
	collapseElement(w.element);
	collapseElement(w.widget);
}

function hideNativeWidgets(node) {
	for (const name of ALL_FIELDS) {
		hideWidget(getWidget(node, name));
	}
	// 状态栏也关掉，小工具节点不需要。
	const state = node.__gjjStandardStatus;
	if (state) {
		state.visible = false;
		if (state.wrap) state.wrap.style.display = "none";
		if (state.widget) hideWidget(state.widget);
	}
}

function protect(el) {
	if (!el || el.__gjjWan22Protected) return;
	el.__gjjWan22Protected = true;
	for (const ev of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		el.addEventListener(ev, (event) => event.stopPropagation());
	}
}

function syncWidgetFromInput(node, name, value) {
	const w = getWidget(node, name);
	if (!w) return;
	let next = value;
	if (typeof w.value === "boolean") next = Boolean(value);
	else if (typeof w.value === "number") next = Number.parseFloat(value);
	w.value = next;
	w.callback?.(next);
	saveWidgetValues(node);
}

function createField(node, name, opts = {}) {
	const w = getWidget(node, name);
	if (!w) return document.createTextNode("");
	const field = document.createElement("label");
	field.className = `gjj-wan22-field ${opts.compact ? "compact" : ""}`;
	const label = document.createElement("span");
	label.className = "gjj-wan22-label";
	label.textContent = opts.label || LABELS[name] || name;
	label.title = opts.tip || TIPS[name] || w.tooltip || "";

	let input;
	const values = originalValues(w);

	if (name === FIELD.useLora || w.type === "toggle" || typeof w.value === "boolean" || String(w.value).toLowerCase() === "true" || String(w.value).toLowerCase() === "false") {
		input = document.createElement("button");
		input.type = "button";
		input.className = "gjj-wan22-toggle";
		const sync = () => {
			const on = w.value === true || String(w.value).toLowerCase() === "true";
			input.dataset.value = on ? "true" : "false";
			input.textContent = on ? "✅ 开" : "⬜ 关";
		};
		input.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const current = w.value === true || String(w.value).toLowerCase() === "true";
			w.value = !current;
			w.callback?.(w.value);
			saveWidgetValues(node);
			sync();
			applyFilters(node);
		});
		w.__gjjWan22Sync = sync;
		sync();
	} else if (SELECT_FIELDS.has(name) || (Array.isArray(values) && values.length > 0)) {
		input = document.createElement("select");
		input.className = "gjj-wan22-select";
		let list = w.options?.values || values;
		if ((name === FIELD.highDtype || name === FIELD.lowDtype) && Array.isArray(list) && !list.includes("default")) {
			list = ["default", ...list];
			w.options = w.options || {};
			w.options.values = list;
		}
		if ((name === FIELD.highDtype || name === FIELD.lowDtype) && !w.value) {
			w.value = "default";
		}
		for (const value of list) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			input.appendChild(option);
		}
		input.value = String(w.value ?? "");
		input.addEventListener("change", () => {
			syncWidgetFromInput(node, name, input.value);
			saveWidgetValues(node);
			applyFilters(node);
		});
		w.__gjjWan22Input = input;
	} else {
		input = document.createElement("input");
		input.className = "gjj-wan22-input";
		if ((name === FIELD.highLoraStrength || name === FIELD.lowLoraStrength) && (w.value === undefined || w.value === null || String(w.value).trim() === "")) {
			w.value = 1;
		}
		input.value = String(w.value ?? "");
		input.addEventListener("input", () => {
			syncWidgetFromInput(node, name, input.value);
			saveWidgetValues(node);
			applyFilters(node);
		});
		w.__gjjWan22Input = input;
	}

	input.title = opts.tip || TIPS[name] || w.tooltip || "";
	protect(input);
	field.append(label, input);
	return field;
}

function createIconField(node, name, icon) {
	return createField(node, name, { label: icon || LABELS[name], compact: true });
}

function buildDom(node) {
	const container = document.createElement("div");
	container.className = "gjj-wan22-loader";
	container.style.cssText = "width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:0;";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-wan22-loader * { box-sizing:border-box; }
		.gjj-wan22-row { display:grid; gap:6px; align-items:center; min-width:0; }
		.gjj-wan22-row.top { grid-template-columns:minmax(0,1fr) 34px 86px 66px; }
		.gjj-wan22-row.triple { grid-template-columns:minmax(0,1fr) 86px 74px; }
		.gjj-wan22-row.cols1 { grid-template-columns:1fr; }
		.gjj-wan22-row.double { grid-template-columns:minmax(0,1fr) 96px; }
		.gjj-wan22-field { display:grid; grid-template-columns:48px minmax(0,1fr); gap:5px; align-items:center; min-width:0; }
		.gjj-wan22-field.compact { grid-template-columns:22px minmax(0,1fr); }
		.gjj-wan22-label { color:#b9c8cc; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; }
		.gjj-wan22-field.compact .gjj-wan22-label { text-align:center; color:#93a7ad; }
		.gjj-wan22-input, .gjj-wan22-select {
			width:100%; height:28px; min-width:0; padding:3px 7px; border:1px solid #33464e; border-radius:7px;
			background:#2b2d30; color:#f1f5f5; outline:none; font-size:12px;
		}
		.gjj-wan22-select { appearance:auto; }
		.gjj-wan22-toggle, .gjj-wan22-refresh {
			width:100%; height:28px; padding:3px 7px; border:1px solid #33464e; border-radius:7px;
			background:#24282b; color:#cdd5d8; cursor:pointer; text-align:center; font-size:12px; white-space:nowrap;
		}
		.gjj-wan22-refresh { text-align:center; padding:0; }
		.gjj-wan22-external-hint {
			height:28px; padding:3px 7px; border:1px solid #4f8f7a; border-radius:7px;
			background:#20362f; color:#dff8ea; font-size:12px; align-items:center; justify-content:center;
			white-space:nowrap;
			text-align:center;
		}
		.gjj-wan22-external-lora-hint {
			min-height:28px; padding:5px 8px; border:1px solid #4f8f7a; border-radius:7px;
			background:#20362f; color:#dff8ea; font-size:12px; align-items:center;
		}
		.gjj-wan22-toggle[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-wan22-toggle.external {
			border-color:#4b5860 !important;
			background:#1d2327 !important;
			color:#9caab0 !important;
			cursor:default !important;
			opacity:0.82;
		}
		.gjj-wan22-sep { height:1px; background:rgba(105,125,134,0.24); margin:1px 0; }
	`;

	container.appendChild(style);

	const rowTop = document.createElement("div");
	rowTop.className = "gjj-wan22-row top";
	rowTop.append(createField(node, FIELD.baseFilter, { label: "🔍" }));

	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.className = "gjj-wan22-refresh";
	refresh.textContent = "↻";
	refresh.title = "重新读取 models/diffusion_models 和 models/loras 列表";
	protect(refresh);
	refresh.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshBackendLists(node, true);
	});

	const useLoraField = createField(node, FIELD.useLora, { label: "🚕", compact: true });
	node.__gjjWan22UseLoraField = useLoraField;

	const externalHint = document.createElement("div");
	externalHint.className = "gjj-wan22-external-hint";
	externalHint.textContent = "🚕 外接";
	externalHint.title = "加速 LoRA 开关已由外部 BOOLEAN 输入控制";
	externalHint.style.display = "none";
	node.__gjjWan22ExternalHint = externalHint;

	rowTop.append(refresh);
	rowTop.append(useLoraField);
	rowTop.append(externalHint);
	container.append(rowTop);

	const sep1 = document.createElement("div");
	sep1.className = "gjj-wan22-sep";
	container.append(sep1);

	const rowHigh = document.createElement("div");
	rowHigh.className = "gjj-wan22-row double";
	rowHigh.append(createField(node, FIELD.highModel, { label: "High" }));
	rowHigh.append(createIconField(node, FIELD.highDtype, "⚙"));
	container.append(rowHigh);

	const rowLow = document.createElement("div");
	rowLow.className = "gjj-wan22-row double";
	rowLow.append(createField(node, FIELD.lowModel, { label: "Low" }));
	rowLow.append(createIconField(node, FIELD.lowDtype, "⚙"));
	container.append(rowLow);

	const sepVae = document.createElement("div");
	sepVae.className = "gjj-wan22-sep";
	container.append(sepVae);

	const rowVae = document.createElement("div");
	rowVae.className = "gjj-wan22-row cols1";
	rowVae.append(createField(node, FIELD.vaeName, { label: "VAE" }));
	container.append(rowVae);

	const rowClip = document.createElement("div");
	rowClip.className = "gjj-wan22-row triple";
	rowClip.append(createField(node, FIELD.clipName, { label: "CLIP" }));
	rowClip.append(createIconField(node, FIELD.clipType, "🏷"));
	rowClip.append(createIconField(node, FIELD.clipDtype, "⚙"));
	container.append(rowClip);

	const sep2 = document.createElement("div");
	sep2.className = "gjj-wan22-sep";
	container.append(sep2);

	const externalLoraHint = document.createElement("div");
	externalLoraHint.className = "gjj-wan22-external-lora-hint";
	externalLoraHint.textContent = "🧬 外接 LoRA 额外叠加：high_ → High分支，low_ → Low分支";
	externalLoraHint.title = "已连接 GJJ 多 LoRA 串联配置。外接 LoRA 会额外叠加，不会替代或修改节点内部 High/Low LoRA。";
	externalLoraHint.style.display = "none";
	node.__gjjWan22ExternalLoraHint = externalLoraHint;
	const rowHighLora = document.createElement("div");
	rowHighLora.className = "gjj-wan22-row double gjj-wan22-lora-row";
	rowHighLora.append(createField(node, FIELD.highLora, { label: "H-LoRA" }));
	rowHighLora.append(createIconField(node, FIELD.highLoraStrength, "💪"));
	container.append(rowHighLora);

	const rowLowLora = document.createElement("div");
	rowLowLora.className = "gjj-wan22-row double gjj-wan22-lora-row";
	rowLowLora.append(createField(node, FIELD.lowLora, { label: "L-LoRA" }));
	rowLowLora.append(createIconField(node, FIELD.lowLoraStrength, "💪"));
	container.append(rowLowLora);

	// 外接 LoRA 提示放到最下面，避免打断内部 LoRA 行。
	container.append(externalLoraHint);

	container.addEventListener("pointerdown", (event) => event.stopPropagation());
	container.addEventListener("mousedown", (event) => event.stopPropagation());
	container.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	node.__gjjWan22Container = container;
	node.__gjjWan22LoraRows = [sep2, rowHighLora, rowLowLora];
	return container;
}

function updateLoraRows(node) {
	const externalBool = hasLoraExternalControl(node);
	const externalLora = hasExternalLoraConfig(node);
	const enabled = effectiveUseLoraEnabled(node);

	// 先同步普通按钮状态；外接时后面再覆盖加速 LoRA 按钮，避免被 sync 改回“开”。
	for (const w of node.widgets || []) {
		if (!(externalBool && w?.name === FIELD.useLora)) {
			w.__gjjWan22Sync?.();
		}
	}

	if (node.__gjjWan22UseLoraField) {
		node.__gjjWan22UseLoraField.style.display = "";
		const button = node.__gjjWan22UseLoraField.querySelector?.("button");
		if (button) {
			button.classList.toggle("external", externalBool);
			if (externalBool) {
				button.textContent = "🚕外接";
				button.dataset.value = "external";
				button.disabled = true;
				button.title = "加速 LoRA 开关由外部 BOOLEAN 输入控制；运行时以外部布尔值为准。";
			} else {
				button.disabled = false;
				button.title = "是否启用加速 LoRA";
				getWidget(node, FIELD.useLora)?.__gjjWan22Sync?.();
			}
		}
	}
	if (node.__gjjWan22ExternalHint) {
		node.__gjjWan22ExternalHint.style.display = "none";
	}
	if (node.__gjjWan22ExternalLoraHint) {
		node.__gjjWan22ExternalLoraHint.style.display = externalLora && enabled ? "flex" : "none";
	}

	// 外接 LoRA 配置只做额外叠加，不隐藏、不修改内部 High/Low LoRA 行。
	for (const row of node.__gjjWan22LoraRows || []) {
		row.style.display = enabled ? "" : "none";
	}
}

function syncProxyInputs(node) {
	for (const w of node.widgets || []) {
		const input = w.__gjjWan22Input;
		if (!input) continue;
		if ("value" in input) input.value = String(w.value ?? "");
	}
}

function refreshNode(node) {
	if (!node) return;
	const width = Math.max(460, Number(node.size?.[0] || 520));
	const height = Math.max(100, Math.ceil(node.__gjjWan22Container?.scrollHeight || node.size?.[1] || 100) + 10);
	if (!node.__gjjWan22Sizing && (Math.abs(Number(node.size?.[0] || 0) - width) > 1 || Math.abs(Number(node.size?.[1] || 0) - height) > 1)) {
		node.__gjjWan22Sizing = true;
		try { node.setSize?.([width, height]); }
		finally { requestAnimationFrame(() => { node.__gjjWan22Sizing = false; }); }
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function ensureDom(node) {
	if (node.__gjjWan22Widget) return;
	const container = buildDom(node);
	const domWidget = node.addDOMWidget?.("gjj_wan22_dual_loader_dom", "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (domWidget) {
		domWidget.computeSize = (width) => [Math.max(460, Number(width || node.size?.[0] || 520)), Math.max(80, Math.ceil(container.scrollHeight || 80))];
		node.__gjjWan22Widget = domWidget;

		// 关键：把自定义 DOM widget 提到最前面。
		// 否则 ComfyUI 会先布局一堆已隐藏的原生 widget，顶部仍可能留下大块空白。
		if (Array.isArray(node.widgets)) {
			const domIndex = node.widgets.indexOf(domWidget);
			if (domIndex > 0) {
				node.widgets.splice(domIndex, 1);
				node.widgets.unshift(domWidget);
			}
		}
	}
}

function ensureWidgetDefaults(node) {
	const pairs = [
		[FIELD.highDtype, "default"],
		[FIELD.lowDtype, "default"],
		[FIELD.clipType, "wan"],
		[FIELD.clipDtype, "default"],
		[FIELD.highLoraStrength, 1],
		[FIELD.lowLoraStrength, 1],
	];
	for (const [name, fallback] of pairs) {
		const w = getWidget(node, name);
		if (!w) continue;
		const empty = w.value === undefined || w.value === null || String(w.value).trim() === "";
		if (empty) {
			w.value = fallback;
			w.callback?.(fallback);
		}
	}

	// dtype 下拉列表必须包含 default，并默认选中 default。
	for (const name of [FIELD.highDtype, FIELD.lowDtype, FIELD.clipDtype]) {
		const w = getWidget(node, name);
		if (!w) continue;
		const values = w.options?.values || w.__gjjWan22AllValues || [];
		if (Array.isArray(values) && !values.includes("default")) {
			values.unshift("default");
			w.options = w.options || {};
			w.options.values = values;
			w.options.values_list = values;
			w.__gjjWan22AllValues = values;
		}
		if (!w.value) w.value = "default";
	}
}

function applyInputSlotLabels(node) {
	for (const input of node.inputs || []) {
		const raw = String(input?.name || "");
		const text = [input?.name, input?.localized_name, input?.label].map((v) => String(v || "")).join(" ");
		if (raw === FIELD.useLoraIn || text.includes(FIELD.useLoraIn) || text.includes("🚕")) {
			input.label = "🚕 加速LoRA";
			input.localized_name = "🚕 加速LoRA";
			input.tooltip = "外部布尔控制加速 LoRA 开关；连接后优先使用外部输入，面板内部按钮会隐藏。";
		}
		if (raw === FIELD.loraConfig || text.includes(FIELD.loraConfig) || text.includes("🧬")) {
			input.label = "🧬 LoRA配置";
			input.localized_name = "🧬 LoRA配置";
			input.tooltip = "接入 GJJ 多 LoRA 串联配置。外接 LoRA 会额外叠加，不会替代或修改节点内部 High/Low LoRA。";
		}
	}
}

function collectWidgetValues(node) {
	const values = {};
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name);
		if (!w) continue;
		values[name] = w.value;
	}
	return values;
}

function saveWidgetValues(node, serializedNode = null) {
	const values = collectWidgetValues(node);
	node.properties = node.properties || {};
	const savedKey = typeof SAVED_VALUES_PROPERTY !== "undefined" ? SAVED_VALUES_PROPERTY : "gjj_wan22_saved_values";
	node.properties[savedKey] = { ...values };

	for (const [name, value] of Object.entries(values)) {
		node.properties[`gjj_wan22_value_${name}`] = value;
	}

	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		const savedKey = typeof SAVED_VALUES_PROPERTY !== "undefined" ? SAVED_VALUES_PROPERTY : "gjj_wan22_saved_values";
		serializedNode.properties[savedKey] = { ...values };
		for (const [name, value] of Object.entries(values)) {
			serializedNode.properties[`gjj_wan22_value_${name}`] = value;
		}

		if (Array.isArray(node.widgets)) {
			serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values)
				? serializedNode.widgets_values
				: [];
			for (const name of ALL_FIELDS) {
				const w = getWidget(node, name);
				const index = node.widgets.indexOf(w);
				if (w && index >= 0) {
					serializedNode.widgets_values[index] = w.value;
				}
			}
		}
	}

	return values;
}

function restoreWidgetValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node.properties || {};
	const savedKey = typeof SAVED_VALUES_PROPERTY !== "undefined" ? SAVED_VALUES_PROPERTY : "gjj_wan22_saved_values";
	const saved = props?.[savedKey] || {};
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name);
		if (!w) continue;
		let value = saved[name];
		if (value === undefined) value = props[`gjj_wan22_value_${name}`];
		if (value !== undefined && value !== null) {
			w.value = value;
			if (w.element && "value" in w.element) w.element.value = value;
			if (w.inputEl && "value" in w.inputEl) w.inputEl.value = value;
		}
	}
}

function stabilize(node) {
	if (!node) return;
	restoreWidgetValues(node);
	applyInputSlotLabels(node);
	ensureWidgetDefaults(node);
	rememberOriginalLists(node);

	// 后台固定过滤词，前台不显示。
	if (!getValue(node, FIELD.highModelFilter, "")) setValue(node, FIELD.highModelFilter, "high_");
	if (!getValue(node, FIELD.lowModelFilter, "")) setValue(node, FIELD.lowModelFilter, "low_");
	if (!getValue(node, FIELD.highLoraFilter, "")) setValue(node, FIELD.highLoraFilter, "high_");
	if (!getValue(node, FIELD.lowLoraFilter, "")) setValue(node, FIELD.lowLoraFilter, "low_");

	ensureDom(node);
	hideNativeWidgets(node);
	applyFilters(node);
	syncProxyInputs(node);
	updateLoraRows(node);
	refreshNode(node);
}

function schedule(node, ms = 0) {
	clearTimeout(node.__gjjWan22Timer);
	node.__gjjWan22Timer = setTimeout(() => stabilize(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.Wan22DualSampleModelLoader",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

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
			schedule(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			saveWidgetValues(this, serializedNode);
			originalOnSerialize?.apply(this, [serializedNode]);
			saveWidgetValues(this, serializedNode);
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjWan22Sizing) refreshNode(this);
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
		if (TARGET_NODES.has(node?.comfyClass)) schedule(node, 0);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilize(node);
		}
	},
});

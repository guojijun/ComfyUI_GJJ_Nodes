import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_SD3SamplingAlgorithmPanel"]);

const FIELD = {
	shift: "shift",
	addNoise: "add_noise",
	seed: "noise_seed",
	steps: "steps",
	cfg: "cfg",
	sampler: "sampler_name",
	scheduler: "scheduler",
	start: "start_at_step",
	end: "end_at_step",
	leftover: "return_with_leftover_noise",
};

const ALL_FIELDS = Object.values(FIELD);
const DOM_WIDGET = "gjj_sd3_sampling_algorithm_panel";
const SAVED_VALUES_PROPERTY = "gjj_sd3_sampling_panel_values";

const LABELS = {
	[FIELD.shift]: "移位",
	[FIELD.addNoise]: "🔊 添加噪波",
	[FIELD.seed]: "随机种",
	[FIELD.steps]: "步数",
	[FIELD.cfg]: "CFG",
	[FIELD.sampler]: "采样器",
	[FIELD.scheduler]: "调度器",
	[FIELD.start]: "开始",
	[FIELD.end]: "结束",
	[FIELD.leftover]: "↩️ 剩余噪波",
};

const BOOL_TIPS = {
	[FIELD.addNoise]: "添加噪波：对应 KSampler Advanced 的 add_noise",
	[FIELD.leftover]: "返回剩余噪波：对应 KSampler Advanced 的 return_with_leftover_noise",
};

function getWidget(node, name) {
	return node.widgets?.find((w) => w?.name === name);
}

function getValue(node, name, fallback = "") {
	const w = getWidget(node, name);
	return w?.value ?? fallback;
}

function setValue(node, name, value) {
	const w = getWidget(node, name);
	if (!w) return;
	w.value = value;
	w.callback?.(value);
	if (w.inputEl && "value" in w.inputEl) w.inputEl.value = value;
	if (w.element && "value" in w.element) w.element.value = value;
	saveValues(node);
}

function collectValues(node) {
	const values = {};
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name);
		if (w) values[name] = w.value;
	}
	return values;
}

function saveValues(node, serializedNode = null) {
	node.properties = node.properties || {};
	const values = collectValues(node);
	node.properties[SAVED_VALUES_PROPERTY] = { ...values };
	for (const [name, value] of Object.entries(values)) {
		node.properties[`gjj_sd3_sampling_value_${name}`] = value;
	}

	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[SAVED_VALUES_PROPERTY] = { ...values };
		for (const [name, value] of Object.entries(values)) {
			serializedNode.properties[`gjj_sd3_sampling_value_${name}`] = value;
		}
		if (Array.isArray(node.widgets)) {
			serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values)
				? serializedNode.widgets_values
				: [];
			for (const name of ALL_FIELDS) {
				const w = getWidget(node, name);
				const index = node.widgets.indexOf(w);
				if (w && index >= 0) serializedNode.widgets_values[index] = w.value;
			}
		}
	}
	return values;
}

function restoreValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node.properties || {};
	const saved = props?.[SAVED_VALUES_PROPERTY] || {};
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name);
		if (!w) continue;
		let value = saved[name];
		if (value === undefined) value = props[`gjj_sd3_sampling_value_${name}`];
		if (value === undefined || value === null) continue;
		w.value = value;
		if (w.inputEl && "value" in w.inputEl) w.inputEl.value = value;
		if (w.element && "value" in w.element) w.element.value = value;
	}
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
	if (!w) return;
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
	// 只隐藏布尔原生 widget，改成底部按钮。
	// 其它参数保留原生控件，方便右键转输入/外部连接参数。
	hideWidget(getWidget(node, FIELD.addNoise));
	hideWidget(getWidget(node, FIELD.leftover));
}

function protect(el) {
	if (!el || el.__gjjSd3SamplingProtected) return;
	el.__gjjSd3SamplingProtected = true;
	for (const ev of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		el.addEventListener(ev, (event) => event.stopPropagation());
	}
}

function isBoolWidget(widget, name) {
	return name === FIELD.addNoise || name === FIELD.leftover || widget?.type === "toggle" || typeof widget?.value === "boolean";
}

function isSelectWidget(widget) {
	const values = widget?.options?.values || widget?.options?.values_list;
	return Array.isArray(values) && values.length > 0;
}

function widgetValues(widget) {
	const values = widget?.options?.values || widget?.options?.values_list || [];
	return Array.isArray(values) ? values.map(String) : [];
}

function makeBoolButton(node, name, label) {
	const w = getWidget(node, name);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-sd3-bool";
	button.title = label;
	const sync = () => {
		const on = w?.value === true || String(w?.value).toLowerCase() === "true" || String(w?.value).toLowerCase() === "enable";
		button.disabled = false;
		button.classList.remove("external");
		button.dataset.value = on ? "true" : "false";
		button.textContent = `${on ? "✅" : "⬜"} ${label}`;
		button.title = BOOL_TIPS[name] || label;
	};
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const current = w?.value === true || String(w?.value).toLowerCase() === "true" || String(w?.value).toLowerCase() === "enable";
		setValue(node, name, current ? "false" : "true");
		sync();
	});
	protect(button);
	w.__gjjSd3Sync = sync;
	sync();
	return button;
}

function makeField(node, name, opts = {}) {
	const w = getWidget(node, name);
	const wrap = document.createElement("label");
	wrap.className = `gjj-sd3-field ${opts.compact ? "compact" : ""}`;
	const label = document.createElement("span");
	label.className = "gjj-sd3-label";
	label.textContent = opts.label || LABELS[name] || name;
	label.title = w?.tooltip || label.textContent;

	let input;
	if (isBoolWidget(w, name)) {
		input = makeBoolButton(node, name, opts.boolLabel || LABELS[name] || name);
		wrap.classList.add("bool-field");
		wrap.append(input);
		return wrap;
	} else if (isSelectWidget(w)) {
		input = document.createElement("select");
		input.className = "gjj-sd3-select";
		for (const value of widgetValues(w)) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			input.appendChild(option);
		}
		input.value = String(w?.value ?? "");
		input.addEventListener("change", () => {
			setValue(node, name, input.value);
		});
		protect(input);
		w.__gjjSd3Input = input;
	} else {
		input = document.createElement("input");
		input.className = "gjj-sd3-input";
		input.type = "text";
		input.value = String(w?.value ?? "");
		input.addEventListener("input", () => {
			const original = w?.value;
			let value = input.value;
			if (typeof original === "number") {
				const parsed = Number.parseFloat(value);
				if (!Number.isNaN(parsed)) value = Number.isInteger(original) ? Number.parseInt(value, 10) : parsed;
			}
			setValue(node, name, value);
		});
		protect(input);
		w.__gjjSd3Input = input;
	}

	input.title = w?.tooltip || label.textContent;
	wrap.append(label, input);
	return wrap;
}

function syncDom(node) {
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name);
		if (!w) continue;
		if (w.__gjjSd3Input && "value" in w.__gjjSd3Input) {
			w.__gjjSd3Input.value = String(w.value ?? "");
		}
		w.__gjjSd3Sync?.();
	}
}

function refreshNode(node) {
	if (!node) return;

	// 只自动调整高度，不再自动放宽节点。
	// 用户手动把节点调窄后，保持用户宽度。
	const width = Number(node.size?.[0] || 260);
	const height = Math.max(90, Math.ceil(node.__gjjSd3SamplingContainer?.scrollHeight || node.size?.[1] || 90) + 10);

	if (!node.__gjjSd3SamplingSizing && Math.abs(Number(node.size?.[1] || 0) - height) > 1) {
		node.__gjjSd3SamplingSizing = true;
		try { node.setSize?.([width, height]); }
		finally { requestAnimationFrame(() => { node.__gjjSd3SamplingSizing = false; }); }
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function buildDom(node) {
	const container = document.createElement("div");
	container.className = "gjj-sd3-panel";
	container.style.cssText = "width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:7px;padding:0;pointer-events:none;";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-sd3-panel * { box-sizing:border-box; }
		.gjj-sd3-panel { pointer-events:none; }
		.gjj-sd3-row { display:grid; gap:7px; align-items:center; min-width:0; }
		.gjj-sd3-row.bool-row { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
		.gjj-sd3-field.bool-field { display:block; min-width:0; }
		.gjj-sd3-bool {
			width:100%; height:29px; padding:3px 7px; border:1px solid #33464e; border-radius:7px;
			background:#24282b; color:#cdd5d8; cursor:pointer; text-align:center; font-size:12px; white-space:nowrap;
			overflow:hidden; text-overflow:ellipsis; min-width:0; pointer-events:auto;
		}
		.gjj-sd3-bool[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
	`;

	const boolRow = document.createElement("div");
	boolRow.className = "gjj-sd3-row bool-row";
	boolRow.append(
		makeField(node, FIELD.addNoise, { boolLabel: "🔊 添加噪波" }),
		makeField(node, FIELD.leftover, { boolLabel: "↩️ 剩余噪波" }),
	);

	container.append(style, boolRow);

	node.__gjjSd3SamplingContainer = container;
	syncDom(node);
	return container;
}
function ensureDom(node) {
	if (node.__gjjSd3SamplingWidget) return;
	const container = buildDom(node);
	const domWidget = node.addDOMWidget?.(DOM_WIDGET, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (domWidget) {
		domWidget.computeSize = (width) => [Number(width || node.size?.[0] || 260), Math.max(36, Math.ceil(container.scrollHeight || 36))];
		node.__gjjSd3SamplingWidget = domWidget;
		// 按需求：按钮放最后。保留 DOM widget 在原生参数后面，不再移动到第一位。
		if (Array.isArray(node.widgets)) {
			const index = node.widgets.indexOf(domWidget);
			if (index >= 0 && index !== node.widgets.length - 1) {
				node.widgets.splice(index, 1);
				node.widgets.push(domWidget);
			}
		}
	}
}

function normalizeVisibleInputLabels(node) {
	// 只改显示名称，不改 node.inputs 数组顺序。
	// 之前直接 splice node.inputs 会导致 LiteGraph slot 索引错位：
	// 鼠标看到的是 end_at_step，实际连到 model。
	for (const input of node.inputs || []) {
		if (input?.name === "start_at_step") {
			input.label = "开始步数";
			input.localized_name = "开始步数";
		}
		if (input?.name === "end_at_step") {
			input.label = "结束步数";
			input.localized_name = "结束步数";
		}
		if (input?.name === "cfg") {
			input.label = "CFG 引导强度";
			input.localized_name = "CFG 引导强度";
		}
	}
}

function hideInternalBooleanSockets(node) {
	// 不要 splice node.inputs，否则 LiteGraph slot 索引会错位。
	// 只把旧工作流里遗留的 add_noise / return_with_leftover_noise 插口标记隐藏。
	for (const input of node.inputs || []) {
		const text = [input?.name, input?.localized_name, input?.label].map((v) => String(v || "")).join(" ");
		const isInternalBool =
			text.includes("add_noise") ||
			text.includes("return_with_leftover_noise") ||
			text.includes("添加噪波") ||
			text.includes("剩余噪波") ||
			text.includes("返回剩余噪波");

		if (isInternalBool) {
			input.hidden = true;
			input.label = "";
			input.localized_name = "";
			input.tooltip = "内部按钮状态，已隐藏。";
			// 保留 name，不改顺序、不删除，避免连接槽错位。
		}
	}
}

function stabilize(node) {
	if (!node) return;
	hideInternalBooleanSockets(node);
	normalizeVisibleInputLabels(node);
	restoreValues(node);
	ensureDom(node);
	hideNativeWidgets(node);
	syncDom(node);
	refreshNode(node);
}

function schedule(node, ms = 0) {
	clearTimeout(node.__gjjSd3SamplingTimer);
	node.__gjjSd3SamplingTimer = setTimeout(() => stabilize(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.SD3SamplingAlgorithmPanel",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const w = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (name === FIELD.addNoise || name === FIELD.leftover) hideWidget(w);
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
			restoreValues(this, serializedNode);
			schedule(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			saveValues(this, serializedNode);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			saveValues(this, serializedNode);
			return result ?? serializedNode;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			// 用户手动调整宽度时不再自动放宽，只重绘。
			this.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
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

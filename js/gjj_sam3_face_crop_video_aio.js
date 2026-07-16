import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "GJJ_SAM3FaceCropVideoAIO";
const TOOLBAR_WIDGET = "gjj_face_crop_toolbar";
const PARAM_WIDGETS = [
	"checkpoint",
	"detection_threshold",
	"max_faces",
	"detect_interval",
	"smoothing",
	"square_crop",
	"speaker_name",
	"speaker_face_map",
	"timeline_default_duration",
	"frame_rate",
];

function getWidget(node, name) {
	return Array.isArray(node?.widgets) ? node.widgets.find((widget) => String(widget?.name || "") === name) : null;
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = value;
	if (Array.isArray(node.widgets_values)) {
		const index = node.widgets.indexOf(widget);
		if (index >= 0) node.widgets_values[index] = value;
	}
	try { widget.callback?.(value); } catch (_) {}
	app.graph?.setDirtyCanvas?.(true, true);
}

function rememberWidget(widget) {
	if (!widget || widget.__gjjFaceCropNativeState) return;
	widget.__gjjFaceCropNativeState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		widgetDisplay: widget.widget?.style?.display || "",
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
	};
}

function setWidgetHidden(widget, hidden) {
	if (!widget) return;
	rememberWidget(widget);
	const state = widget.__gjjFaceCropNativeState || {};
	widget.options ||= {};
	if (!hidden) {
		widget.hidden = false;
		widget.disabled = false;
		widget.serialize = true;
		widget.type = state.type || widget.type || "text";
		if (state.computeSize) widget.computeSize = state.computeSize; else delete widget.computeSize;
		if (state.getHeight) widget.getHeight = state.getHeight; else delete widget.getHeight;
		if (state.draw) widget.draw = state.draw; else delete widget.draw;
		if (state.mouse) widget.mouse = state.mouse; else delete widget.mouse;
		delete widget.options.hidden;
		delete widget.options.display;
		if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
		if (widget.element) widget.element.style.display = state.elementDisplay || "";
		if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
		return;
	}
	widget.hidden = true;
	widget.disabled = true;
	widget.serialize = true;
	widget.type = "hidden";
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	if (widget.widget) widget.widget.style.display = "none";
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function settingsOpen(node) {
	return Boolean(node?.properties?.gjj_face_crop_settings_open);
}

function setSettingsOpen(node, open) {
	node.properties ||= {};
	node.properties.gjj_face_crop_settings_open = Boolean(open);
	applyVisibility(node);
	flashStatus(node, open ? "已展开参数" : "已收起参数");
}

function cycleValue(node, name, values) {
	const widget = getWidget(node, name);
	if (!widget) return;
	const current = widget.value;
	const index = values.findIndex((value) => String(value) === String(current));
	const next = values[(index + 1) % values.length];
	setWidgetValue(node, name, next);
	updateToolbar(node);
	flashStatus(node, `${labelFor(name)}：${next}`);
}

function makeButton(text, title, onClick) {
	const button = document.createElement("button");
	button.textContent = text;
	button.title = title;
	button.type = "button";
	button.style.cssText = [
		"height:24px",
		"min-width:28px",
		"padding:0 6px",
		"border:1px solid #40515a",
		"border-radius:6px",
		"background:#17242b",
		"color:#d9e7ea",
		"font:12px/1 sans-serif",
		"cursor:pointer",
		"pointer-events:auto",
	].join(";");
	const swallow = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};
	button.addEventListener("pointerdown", swallow);
	button.addEventListener("mousedown", swallow);
	button.addEventListener("mouseup", swallow);
	button.addEventListener("touchstart", swallow, { passive: false });
	button.addEventListener("click", (event) => {
		swallow(event);
		onClick?.(event, button);
	});
	return button;
}

function closePopup(node) {
	if (node?.__gjjFaceCropPopup) {
		node.__gjjFaceCropPopup.remove();
		node.__gjjFaceCropPopup = null;
	}
}

function popupShell(node, anchor, title) {
	closePopup(node);
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed",
		"z-index:10000",
		"min-width:210px",
		"max-width:320px",
		"padding:8px",
		"border:1px solid #50636b",
		"border-radius:8px",
		"background:#101b20",
		"box-shadow:0 10px 28px rgba(0,0,0,.45)",
		"color:#dce9ec",
		"font:12px/1.35 sans-serif",
	].join(";");
	const rect = anchor?.getBoundingClientRect?.() || { left: 120, bottom: 120 };
	popup.style.left = `${Math.max(8, Math.min(window.innerWidth - 340, rect.left))}px`;
	popup.style.top = `${Math.max(8, Math.min(window.innerHeight - 260, rect.bottom + 6))}px`;
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;font-weight:700;color:#f3fbff;";
	const label = document.createElement("span");
	label.textContent = title;
	const close = document.createElement("button");
	close.textContent = "×";
	close.title = "关闭";
	close.style.cssText = "width:22px;height:22px;border:1px solid #455862;border-radius:5px;background:#1b2a31;color:#dce9ec;cursor:pointer;";
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closePopup(node);
	});
	header.append(label, close);
	popup.appendChild(header);
	document.body.appendChild(popup);
	node.__gjjFaceCropPopup = popup;
	return popup;
}

function openChoicePopup(node, anchor, title, widgetName, values, suffix = "") {
	const popup = popupShell(node, anchor, title);
	const current = String(getWidget(node, widgetName)?.value ?? "");
	const grid = document.createElement("div");
	grid.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;";
	for (const value of values) {
		const button = makeButton(`${value}${suffix}`, `${title} ${value}${suffix}`, () => {
			setWidgetValue(node, widgetName, value);
			updateToolbar(node);
			flashStatus(node, `${labelFor(widgetName)}：${value}${suffix}`);
			closePopup(node);
		});
		button.style.width = "100%";
		if (String(value) === current) {
			button.style.background = "#24513f";
			button.style.borderColor = "#4ed39a";
		}
		grid.appendChild(button);
	}
	popup.appendChild(grid);
}

function openTextPopup(node, anchor, title, widgetName, placeholder = "") {
	const popup = popupShell(node, anchor, title);
	const input = document.createElement("input");
	input.value = String(getWidget(node, widgetName)?.value ?? "");
	input.placeholder = placeholder;
	input.style.cssText = "width:100%;box-sizing:border-box;height:28px;border:1px solid #40515a;border-radius:6px;background:#0b1317;color:#dce9ec;padding:0 7px;";
	const save = makeButton("确定", "保存", () => {
		setWidgetValue(node, widgetName, input.value);
		updateToolbar(node);
		flashStatus(node, `${title} 已更新`);
		closePopup(node);
	});
	save.style.marginTop = "7px";
	save.style.width = "100%";
	popup.append(input, save);
	setTimeout(() => input.focus(), 0);
}

function openAllSettingsPopup(node, anchor) {
	const popup = popupShell(node, anchor, "全部参数");
	const rows = [
		["检测阈值", "detection_threshold", "0.5"],
		["无时间轴兜底人数", "max_faces", "2"],
		["检测间隔", "detect_interval", "1"],
		["裁剪框平滑", "smoothing", "0.35"],
		["指定说话人", "speaker_name", ""],
		["说话人-人脸映射", "speaker_face_map", "左边的男人=0;右边的女人=1"],
		["LRC默认时长", "timeline_default_duration", "2.0"],
		["帧率", "frame_rate", "16"],
	];
	for (const [label, name, placeholder] of rows) {
		const row = document.createElement("label");
		row.style.cssText = "display:grid;grid-template-columns:86px minmax(0,1fr);align-items:center;gap:6px;margin:5px 0;";
		const span = document.createElement("span");
		span.textContent = label;
		span.style.cssText = "color:#aabec4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
		const input = document.createElement("input");
		input.value = String(getWidget(node, name)?.value ?? "");
		input.placeholder = placeholder;
		input.style.cssText = "min-width:0;height:24px;border:1px solid #40515a;border-radius:5px;background:#0b1317;color:#dce9ec;padding:0 6px;";
		input.addEventListener("change", () => setWidgetValue(node, name, input.value));
		row.append(span, input);
		popup.appendChild(row);
	}
	const square = makeButton(getWidget(node, "square_crop")?.value ? "正方形裁剪：开" : "正方形裁剪：关", "切换正方形裁剪", () => {
		const next = !Boolean(getWidget(node, "square_crop")?.value);
		setWidgetValue(node, "square_crop", next);
		square.textContent = next ? "正方形裁剪：开" : "正方形裁剪：关";
	});
	square.style.width = "100%";
	square.style.marginTop = "7px";
	const done = makeButton("完成", "关闭", () => {
		updateToolbar(node);
		flashStatus(node, "参数已更新");
		closePopup(node);
	});
	done.style.width = "100%";
	done.style.marginTop = "6px";
	popup.append(square, done);
}

function createToolbar(node) {
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;min-height:44px;overflow:hidden;pointer-events:auto;";
	const row = document.createElement("div");
	row.style.cssText = "display:flex;align-items:center;gap:5px;min-height:28px;overflow:hidden;";
	row.appendChild(makeButton("🙂", "无时间轴兜底人数；有时间轴时自动按说话人数", (_event, button) => openChoicePopup(node, button, "无时间轴兜底人数", "max_faces", [1, 2, 3, 4, 6, 8])));
	row.appendChild(makeButton("🧊", "裁剪框平滑", (_event, button) => openChoicePopup(node, button, "裁剪框平滑", "smoothing", [0, 0.25, 0.35, 0.5, 0.65, 0.85])));
	row.appendChild(makeButton("📝", "指定说话人", (_event, button) => openTextPopup(node, button, "指定说话人", "speaker_name", "留空=全部时间轴")));
	const settingsButton = makeButton("⚙️", "全部参数", (_event, button) => openAllSettingsPopup(node, button));
	row.appendChild(settingsButton);
	const status = document.createElement("div");
	status.style.cssText = "height:14px;color:#9fb4ba;font:11px/14px sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	wrap.appendChild(row);
	wrap.appendChild(status);
	node.__gjjFaceCropToolbar = wrap;
	node.__gjjFaceCropToolbarStatus = status;
	node.__gjjFaceCropSettingsButton = settingsButton;
	updateToolbar(node);
	return wrap;
}

function labelFor(name) {
	return {
		max_faces: "兜底人数",
		smoothing: "平滑",
	}[name] || name;
}

function updateToolbar(node) {
	const wrap = node.__gjjFaceCropToolbar;
	if (!wrap) return;
	const maxFaces = getWidget(node, "max_faces")?.value ?? 8;
	const smooth = getWidget(node, "smoothing")?.value ?? 0.65;
	const summary = `时间轴智能人数 · 兜底 ${maxFaces} · 自动尺寸32倍数 · 平滑 ${smooth}`;
	wrap.title = summary;
	if (node.__gjjFaceCropToolbarStatus && !node.__gjjFaceCropStatusLocked) {
		node.__gjjFaceCropToolbarStatus.textContent = summary;
	}
	const gear = node.__gjjFaceCropSettingsButton;
	if (gear) {
		gear.textContent = settingsOpen(node) ? "🔼" : "⚙️";
		gear.style.background = settingsOpen(node) ? "#34414a" : "#17242b";
	}
}

function flashStatus(node, text) {
	const status = node.__gjjFaceCropToolbarStatus;
	if (!status) return;
	clearTimeout(node.__gjjFaceCropStatusTimer);
	node.__gjjFaceCropStatusLocked = true;
	status.textContent = text;
	status.style.color = "#d9fff2";
	node.__gjjFaceCropStatusTimer = setTimeout(() => {
		node.__gjjFaceCropStatusLocked = false;
		status.style.color = "#9fb4ba";
		updateToolbar(node);
		app.graph?.setDirtyCanvas?.(true, true);
	}, 1200);
	app.graph?.setDirtyCanvas?.(true, true);
}

function applyVisibility(node) {
	const open = settingsOpen(node);
	for (const name of PARAM_WIDGETS) setWidgetHidden(getWidget(node, name), !open);
	updateToolbar(node);
	resizeNode(node);
	app.graph?.setDirtyCanvas?.(true, true);
}

function resizeNode(node) {
	try {
		if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
			const size = node.computeSize();
			if (Array.isArray(size)) node.setSize([Math.max(node.size?.[0] || 320, size[0]), size[1]]);
		}
	} catch (_) {}
}

function patchNode(node) {
	if (!node || node.comfyClass !== NODE_TYPE) return;
	if (!node.__gjjFaceCropToolbarWidget && typeof node.addDOMWidget === "function") {
		node.__gjjFaceCropToolbarWidget = node.addDOMWidget(TOOLBAR_WIDGET, "HTML", createToolbar(node), { serialize: false });
	}
	applyVisibility(node);
	if (node.__gjjFaceCropPatched) return;
	node.__gjjFaceCropPatched = true;
	const onConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = onConfigure?.apply(this, args);
		setTimeout(() => patchNode(this), 0);
		return result;
	};
}

app.registerExtension({
	name: "GJJ.SAM3FaceCropVideoAIO",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = onNodeCreated?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = onConfigure?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) patchNode(node);
	},
});

const BERNINI_AIO_TYPE = "GJJ_BerniniSpeakerSegmentAIO";
const BERNINI_AIO_TOOLBAR = "gjj_bernini_speaker_aio_toolbar";
const BERNINI_AIO_WIDGETS = [
	"frame_rate",
	"checkpoint",
	"speaker_face_map",
	"positive_prompt",
	"negative_prompt",
	"steps",
	"high_steps",
	"cfg",
	"seed",
	"sampler_name",
	"scheduler",
	"denoise",
	"ref_max_size",
	"detection_threshold",
	"max_faces",
	"detect_interval",
	"smoothing",
	"feather_percent",
	"timeline_default_duration",
	"filename_prefix",
	"vae_tiling",
	"bernini_high_model",
	"bernini_low_model",
	"bernini_vae",
	"bernini_clip",
	"bernini_audio_encoder",
	"bernini_high_lora",
	"bernini_low_lora",
	"sam3_text_prompt",
];

function aioSummary(node) {
	const fps = getWidget(node, "frame_rate")?.value ?? 16;
	const steps = getWidget(node, "steps")?.value ?? 4;
	const high = getWidget(node, "high_steps")?.value ?? 2;
	const cfg = getWidget(node, "cfg")?.value ?? 1;
	const smooth = getWidget(node, "smoothing")?.value ?? 0.65;
	return `分段生成 · ${fps}fps · ${steps}/${high}步 · CFG ${cfg} · 平滑 ${smooth}`;
}

function openBerniniAioPopup(node, anchor, title, rows) {
	const popup = popupShell(node, anchor, title);
	for (const rowDef of rows) {
		const [label, name, placeholder = ""] = rowDef;
		const row = document.createElement("label");
		row.style.cssText = "display:grid;grid-template-columns:76px minmax(0,1fr);align-items:center;gap:6px;margin:5px 0;";
		const span = document.createElement("span");
		span.textContent = label;
		span.style.cssText = "color:#aabec4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
		const widget = getWidget(node, name);
		const isBoolean = typeof widget?.value === "boolean";
		const input = document.createElement(isBoolean ? "select" : (name === "positive_prompt" || name === "negative_prompt" ? "textarea" : "input"));
		if (isBoolean) {
			for (const value of ["true", "false"]) {
				const option = document.createElement("option");
				option.value = value;
				option.textContent = value === "true" ? "开启" : "关闭";
				if (String(Boolean(widget?.value)) === value) option.selected = true;
				input.appendChild(option);
			}
		} else {
			input.value = String(widget?.value ?? "");
		}
		input.placeholder = placeholder;
		input.style.cssText = [
			"min-width:0",
			name === "positive_prompt" || name === "negative_prompt" ? "height:58px" : "height:24px",
			"border:1px solid #40515a",
			"border-radius:5px",
			"background:#0b1317",
			"color:#dce9ec",
			"padding:3px 6px",
			"resize:vertical",
			"box-sizing:border-box",
		].join(";");
		input.addEventListener("change", () => {
			setWidgetValue(node, name, isBoolean ? input.value === "true" : input.value);
			updateBerniniAioToolbar(node);
		});
		row.append(span, input);
		popup.appendChild(row);
	}
	const done = makeButton("完成", "关闭", () => {
		updateBerniniAioToolbar(node);
		closePopup(node);
	});
	done.style.width = "100%";
	done.style.marginTop = "7px";
	popup.appendChild(done);
}

function getComboValues(widget) {
	const values = widget?.options?.values || widget?.options?.items || widget?.values || [];
	return Array.isArray(values) ? values.map((value) => String(value ?? "")) : [];
}

function shortModelName(value) {
	return String(value || "")
		.replace(/\\/g, "/")
		.split("/")
		.pop()
		.replace(/\.(safetensors|ckpt|pt|pth)$/i, "");
}

function pairKey(value) {
	return shortModelName(value)
		.toLowerCase()
		.replace(/\b(high|low)\b/g, "")
		.replace(/(^|[_\-.])(?:high|low)(?=$|[_\-.])/g, "$1")
		.replace(/highnoise|lownoise/g, "noise")
		.replace(/[^a-z0-9]+/g, "");
}

function highToLowCandidates(value) {
	const text = String(value || "");
	const variants = new Set();
	for (const [from, to] of [
		["HIGH", "LOW"],
		["High", "Low"],
		["high", "low"],
		["HighNoise", "LowNoise"],
		["high_noise", "low_noise"],
		["HIGH_NOISE", "LOW_NOISE"],
		["high-noise", "low-noise"],
		["HIGH-NOISE", "LOW-NOISE"],
	]) {
		if (text.includes(from)) variants.add(text.replaceAll(from, to));
	}
	return [...variants];
}

function bestPairedLowValue(highValue, lowValues) {
	const values = Array.isArray(lowValues) ? lowValues : [];
	if (!highValue || !values.length) return "";
	for (const candidate of highToLowCandidates(highValue)) {
		const direct = values.find((value) => value === candidate);
		if (direct) return direct;
		const byName = values.find((value) => shortModelName(value) === shortModelName(candidate));
		if (byName) return byName;
	}
	const key = pairKey(highValue);
	if (!key) return "";
	const scored = values
		.map((value) => ({ value, key: pairKey(value) }))
		.filter((item) => item.key && item.key === key);
	return scored[0]?.value || "";
}

function openBerniniModelPopup(node, anchor) {
	const popup = popupShell(node, anchor, "Bernini / SAM3.1 模型");
	popup.style.minWidth = "360px";
	const rows = [
		["🎯", "SAM3.1模型", "checkpoint"],
		["🟣", "High模型", "bernini_high_model"],
		["🟣", "Low模型", "bernini_low_model"],
		["🔴", "VAE", "bernini_vae"],
		["🟡", "CLIP编码器", "bernini_clip"],
		["🔵", "音频编码器", "bernini_audio_encoder"],
		["🟠", "High LoRA名称", "bernini_high_lora"],
		["🟠", "Low LoRA名称", "bernini_low_lora"],
	];
	const controls = {};
	const syncPairedLow = (highName, highValue) => {
		const lowName = highName === "bernini_high_model" ? "bernini_low_model" : (
			highName === "bernini_high_lora" ? "bernini_low_lora" : ""
		);
		if (!lowName || !controls[lowName]) return;
		const low = controls[lowName];
		const paired = bestPairedLowValue(highValue, low.allValues);
		if (!paired) return;
		setWidgetValue(node, lowName, paired);
		low.filter.value = "";
		low.refill();
		low.select.value = paired;
		updateBerniniAioToolbar(node);
	};
	for (const [dot, label, name] of rows) {
		const widget = getWidget(node, name);
		const allValues = getComboValues(widget);
		const row = document.createElement("div");
		row.style.cssText = "display:grid;grid-template-columns:128px minmax(0,1fr) 30px;gap:5px 6px;align-items:center;margin:6px 0;";
		const left = document.createElement("div");
		left.textContent = `${dot} ${label}`;
		left.style.cssText = "color:#c9d6dc;white-space:nowrap;line-height:28px;";
		const stack = document.createElement("div");
		stack.style.cssText = "display:flex;flex-direction:column;gap:4px;min-width:0;";
		const filter = document.createElement("input");
		filter.placeholder = "输入关键词实时过滤";
		filter.style.cssText = "display:none;height:28px;box-sizing:border-box;border:1px solid #8fbfd3;border-radius:5px;background:#071418;color:#dce9ec;padding:0 7px;";
		const select = document.createElement("select");
		select.title = label;
		select.style.cssText = "height:30px;box-sizing:border-box;border:1px solid #40515a;border-radius:6px;background:#17242b;color:#dce9ec;padding:0 7px;min-width:0;";
		let filterOpen = false;
		const setFilterOpen = (open, focus = false) => {
			filterOpen = Boolean(open);
			filter.style.display = filterOpen ? "" : "none";
			if (!filterOpen) {
				filter.value = "";
				refill();
			} else if (focus) {
				setTimeout(() => filter.focus(), 0);
			}
		};
		const refill = () => {
			const q = String(filter.value || "").trim().toLowerCase();
			const current = String(widget?.value ?? "");
			const selected = current && allValues.includes(current) ? current : (allValues[0] || "");
			const shown = allValues.filter((value) => !q || value.toLowerCase().includes(q) || shortModelName(value).toLowerCase().includes(q));
			select.replaceChildren();
			for (const value of (shown.length ? shown : allValues)) {
				const option = document.createElement("option");
				option.value = value;
				option.textContent = shortModelName(value) || value;
				option.title = value;
				if (value === selected) option.selected = true;
				select.appendChild(option);
			}
		};
		filter.addEventListener("input", refill);
		select.addEventListener("pointerdown", () => setFilterOpen(true, false));
		select.addEventListener("focus", () => setFilterOpen(true, false));
		select.addEventListener("change", () => {
			setWidgetValue(node, name, select.value);
			syncPairedLow(name, select.value);
			updateBerniniAioToolbar(node);
			setFilterOpen(false, false);
		});
		refill();
		controls[name] = { select, filter, refill, allValues };
		stack.append(select, filter);
		const gear = makeButton("⚙️", `${label} 过滤`, () => {
			filter.value = "";
			refill();
			setFilterOpen(!filterOpen, !filterOpen);
		});
		row.append(left, stack, gear);
		popup.appendChild(row);
	}
	const done = makeButton("完成", "关闭", () => {
		updateBerniniAioToolbar(node);
		closePopup(node);
	});
	done.style.width = "100%";
	done.style.marginTop = "8px";
	popup.appendChild(done);
}

function createBerniniAioToolbar(node) {
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;min-height:50px;overflow:hidden;pointer-events:auto;";
	const row = document.createElement("div");
	row.style.cssText = "display:flex;align-items:center;gap:5px;min-height:28px;overflow:hidden;flex-wrap:nowrap;";
	row.appendChild(makeButton("🎞️", "帧率", (_event, button) => openBerniniAioPopup(node, button, "时间", [["帧率", "frame_rate", "16"], ["LRC时长", "timeline_default_duration", "2.0"]])));
	row.appendChild(makeButton("🙂", "SAM3人脸", (_event, button) => openBerniniAioPopup(node, button, "SAM3", [["模型", "checkpoint"], ["阈值", "detection_threshold", "0.5"], ["人数", "max_faces", "8"], ["间隔", "detect_interval", "1"], ["平滑", "smoothing", "0.65"], ["目标", "sam3_text_prompt", "head"]])));
	row.appendChild(makeButton("🧭", "说话人映射", (_event, button) => openBerniniAioPopup(node, button, "说话人映射", [["映射", "speaker_face_map", "左边的男人=0;右边的女人=1"]])));
	row.appendChild(makeButton("🧠", "Bernini / SAM3.1 模型", (_event, button) => openBerniniModelPopup(node, button)));
	row.appendChild(makeButton("⚙️", "采样参数", (_event, button) => openBerniniAioPopup(node, button, "采样参数", [["步数", "steps", "4"], ["高噪", "high_steps", "2"], ["CFG", "cfg", "1"], ["种子", "seed", "999"], ["采样器", "sampler_name", "dpmpp_2m_sde"], ["调度器", "scheduler", "sgm_uniform"], ["降噪", "denoise", "1"], ["参考边", "ref_max_size", "1024"], ["VAE分块", "vae_tiling", "true"]])));
	row.appendChild(makeButton("📝", "提示词", (_event, button) => openBerniniAioPopup(node, button, "提示词", [["正向", "positive_prompt"], ["负向", "negative_prompt"]])));
	row.appendChild(makeButton("🪶", "贴回", (_event, button) => openBerniniAioPopup(node, button, "贴回", [["羽化%", "feather_percent", "4"]])));
	row.appendChild(makeButton("💾", "输出", (_event, button) => openBerniniAioPopup(node, button, "输出", [["前缀", "filename_prefix", "GJJ/bernini_speaker_aio/output"]])));
	const status = document.createElement("div");
	status.style.cssText = "height:14px;color:#9fb4ba;font:11px/14px sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	const track = document.createElement("div");
	track.style.cssText = "height:4px;border-radius:999px;background:#1c2a31;overflow:hidden;";
	const fill = document.createElement("div");
	fill.style.cssText = "height:100%;width:0%;border-radius:999px;background:#65d6ff;transition:width .18s ease;";
	track.appendChild(fill);
	wrap.append(row, status, track);
	node.__gjjBerniniAioToolbar = wrap;
	node.__gjjBerniniAioStatus = status;
	node.__gjjBerniniAioProgressFill = fill;
	node.__gjjBerniniAioProgressTrack = track;
	updateBerniniAioToolbar(node);
	return wrap;
}

function updateBerniniAioToolbar(node) {
	const summary = aioSummary(node);
	if (node.__gjjBerniniAioToolbar) node.__gjjBerniniAioToolbar.title = summary;
	if (node.__gjjBerniniAioStatus) node.__gjjBerniniAioStatus.textContent = summary;
}

function setBerniniAioProgress(node, text, progress = null) {
	if (!node) return;
	patchBerniniAioNode(node);
	const message = String(text || "处理中...");
	const value = Number(progress);
	const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value <= 1 ? value * 100 : value)) : null;
	if (node.__gjjBerniniAioStatus) {
		node.__gjjBerniniAioStatus.textContent = pct == null ? message : `${message} · ${Math.round(pct)}%`;
		node.__gjjBerniniAioStatus.style.color = "#d9fff2";
	}
	if (node.__gjjBerniniAioProgressFill && pct != null) {
		node.__gjjBerniniAioProgressFill.style.width = `${pct}%`;
	}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
}

function patchBerniniAioNode(node) {
	if (!node || node.comfyClass !== BERNINI_AIO_TYPE) return;
	if (!node.__gjjBerniniAioToolbarWidget && typeof node.addDOMWidget === "function") {
		node.__gjjBerniniAioToolbarWidget = node.addDOMWidget(BERNINI_AIO_TOOLBAR, "HTML", createBerniniAioToolbar(node), { serialize: false });
	}
	for (const name of BERNINI_AIO_WIDGETS) setWidgetHidden(getWidget(node, name), true);
	updateBerniniAioToolbar(node);
	resizeNode(node);
	if (node.__gjjBerniniAioPatched) return;
	node.__gjjBerniniAioPatched = true;
	const onConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = onConfigure?.apply(this, args);
		setTimeout(() => patchBerniniAioNode(this), 0);
		return result;
	};
}

app.registerExtension({
	name: "GJJ.BerniniSpeakerSegmentAIO",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== BERNINI_AIO_TYPE) return;
		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = onNodeCreated?.apply(this, args);
			setTimeout(() => patchBerniniAioNode(this), 0);
			return result;
		};
		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = onConfigure?.apply(this, args);
			setTimeout(() => patchBerniniAioNode(this), 0);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) patchBerniniAioNode(node);
	},
});

api?.addEventListener?.("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail.node));
	if (!node || node.comfyClass !== BERNINI_AIO_TYPE) return;
	setBerniniAioProgress(node, detail.text || "处理中...", detail.progress);
});

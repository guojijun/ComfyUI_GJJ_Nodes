import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET = "GJJ_WanMoveTrackVisualizer";
const JSON_WIDGET = "tracks_json";
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const FRAME_WIDGET = "frame_count";
const IMAGE_INPUT = "image";
const IMAGE_FILE = "gjj_wanmove_image_file";
const PANEL = "gjj_wanmove_track_panel";
const STATE = "gjj_wanmove_track_visual_state";
const EXTRA_OUTPUTS = "gjj_wanmove_show_extra_outputs";

const COLORS = ["#66e3ff", "#ffdf6e", "#8dff9a", "#ff8a65", "#b99cff", "#f472b6"];
const COLOR_EMOJIS = ["🔵", "🟡", "🟢", "🟠", "🟣", "🩷"];
const INTERPOLATIONS = [
	["linear", "📏", "线性插值"],
	["smooth", "〰️", "平滑插值"],
	["ease_in", "⤴️", "渐入插值"],
	["ease_out", "⤵️", "渐出插值"],
];
const DEFAULT_STATE = {
	tracks: [],
	activeTrack: 0,
};

const DEFAULT_TRACK = {
	start: { x: 0.6, y: 0.27 },
	end: { x: 0.22, y: 0.45 },
	control1: { x: 0.46, y: 0.46 },
	control2: { x: 0.44, y: 0.44 },
	trackCount: 1,
	spread: 0.007,
	bezier: true,
	interpolation: "linear",
};

function makeTrack(seed = {}, index = 0) {
	const shift = index * 0.06;
	const controls = Array.isArray(seed.controls)
		? seed.controls.map(normalizePoint)
		: [
			normalizePoint(seed.control1 || { x: DEFAULT_TRACK.control1.x + shift, y: DEFAULT_TRACK.control1.y }),
			normalizePoint(seed.control2 || { x: DEFAULT_TRACK.control2.x + shift, y: DEFAULT_TRACK.control2.y }),
		];
	return {
		enabled: seed.enabled !== false,
		start: normalizePoint(seed.start || { x: DEFAULT_TRACK.start.x + shift, y: DEFAULT_TRACK.start.y }),
		end: normalizePoint(seed.end || { x: DEFAULT_TRACK.end.x + shift, y: DEFAULT_TRACK.end.y }),
		controls: controls.slice(0, 8),
		trackCount: clamp(Math.round(Number(seed.trackCount) || DEFAULT_TRACK.trackCount), 1, 64),
		spread: clamp(Number(seed.spread) || DEFAULT_TRACK.spread, 0, 0.5),
		bezier: seed.bezier !== false,
		interpolation: ["linear", "smooth", "ease_in", "ease_out"].includes(String(seed.interpolation)) ? String(seed.interpolation) : "linear",
	};
}

function widget(node, name) {
	return node?.widgets?.find?.((item) => item?.name === name);
}

function keyText(value) {
	return String(value || "").toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, "");
}

function linkedSource(node, inputName) {
	const input = node.inputs?.find?.((item) => item?.name === inputName);
	if (!input || input.link == null || !app.graph?.links) return null;
	const link = app.graph.links[input.link];
	const sourceNode = app.graph.getNodeById?.(link?.origin_id ?? link?.source_id ?? link?.from_id);
	const sourceSlot = link?.origin_slot ?? link?.source_slot ?? link?.from_slot;
	return sourceNode ? { sourceNode, sourceSlot, output: sourceNode.outputs?.[sourceSlot] } : null;
}

function hasLinkedInput(node, inputName) {
	return Boolean(linkedSource(node, inputName));
}

function finiteNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

function connectedNumber(node, inputName) {
	const source = linkedSource(node, inputName);
	if (!source?.sourceNode) return null;
	const outputName = String(source.output?.name || "");
	const outputKey = keyText(outputName);
	const wantedKeys = [outputKey];
	if (inputName === WIDTH_WIDGET) wantedKeys.push("width", "输出宽度", "outputwidth");
	if (inputName === HEIGHT_WIDGET) wantedKeys.push("height", "输出高度", "outputheight");
	if (inputName === FRAME_WIDGET) wantedKeys.push("frame", "frames", "帧率", "轨迹长度", "整数结果");

	if (/整数结果|浮点结果/.test(outputName) && source.sourceNode.__gjjCalculatorLastResult != null) {
		const value = finiteNumber(source.sourceNode.__gjjCalculatorLastResult);
		if (value != null) return value;
	}

	const resizeCfg = source.sourceNode.properties?.gjj_mf_resize_config;
	if (resizeCfg && /输出宽度|output_width/i.test(outputName)) {
		const value = finiteNumber(resizeCfg.width);
		if (value != null) return value;
	}
	if (resizeCfg && /输出高度|output_height/i.test(outputName)) {
		const value = finiteNumber(resizeCfg.height);
		if (value != null) return value;
	}

	for (const item of source.sourceNode.widgets || []) {
		const names = [item?.name, item?.label, item?.displayName, item?.options?.display_name].map(keyText);
		if (names.some((name) => wantedKeys.map(keyText).includes(name))) {
			const value = finiteNumber(item.value);
			if (value != null) return value;
		}
	}
	for (const [key, value] of Object.entries(source.sourceNode.properties || {})) {
		if (wantedKeys.map(keyText).includes(keyText(key))) {
			const number = finiteNumber(value);
			if (number != null) return number;
		}
	}
	return null;
}

function getNumber(node, name, fallback) {
	const linked = connectedNumber(node, name);
	if (linked != null) return linked;
	const value = Number(widget(node, name)?.value);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function setWidget(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	item.value = value;
	item.callback?.(value);
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function normalizePoint(point) {
	return {
		x: clamp(Number(point?.x) || 0, 0, 1),
		y: clamp(Number(point?.y) || 0, 0, 1),
	};
}

function readState(node) {
	const raw = node?.properties?.[STATE];
	return normalizeState(raw && typeof raw === "object" ? raw : { ...DEFAULT_STATE });
}

function normalizeState(value) {
	const tracks = [];
	if (Array.isArray(value?.tracks)) {
		for (const track of value.tracks) tracks.push(makeTrack(track, tracks.length));
	}
	if (!tracks.length) tracks.push(makeTrack({}, 0));
	const activeTrack = clamp(Math.round(Number(value?.activeTrack) || 0), 0, tracks.length - 1);
	return {
		tracks,
		activeTrack,
	};
}

function activeTrackState(state) {
	return state.tracks[state.activeTrack] || state.tracks[0] || makeTrack({}, 0);
}

function saveState(node, state) {
	node.properties ||= {};
	node.properties[STATE] = normalizeState(state);
}

function ease(t, interpolation) {
	const v = clamp(Number(t) || 0, 0, 1);
	if (interpolation === "smooth") return v * v * (3 - 2 * v);
	if (interpolation === "ease_in") return v * v;
	if (interpolation === "ease_out") return 1 - (1 - v) * (1 - v);
	return v;
}

function bezierPoints(state) {
	return [state.start, ...(Array.isArray(state.controls) ? state.controls : []), state.end].map(normalizePoint);
}

function pathPoints(state) {
	return bezierPoints(state);
}

function deCasteljau(points, t) {
	let working = points.map((point) => ({ ...point }));
	while (working.length > 1) {
		const next = [];
		for (let i = 0; i < working.length - 1; i += 1) {
			next.push({
				x: working[i].x + (working[i + 1].x - working[i].x) * t,
				y: working[i].y + (working[i + 1].y - working[i].y) * t,
			});
		}
		working = next;
	}
	return working[0] || { x: 0, y: 0 };
}

function bezier(state, t) {
	return deCasteljau(bezierPoints(state), t);
}

function polylinePoint(state, t) {
	const points = pathPoints(state);
	if (points.length <= 1) return points[0] || { x: 0, y: 0 };
	const lengths = [0];
	for (let i = 1; i < points.length; i += 1) {
		lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
	}
	const total = lengths[lengths.length - 1];
	if (total <= 1e-6) return points[0];
	const target = total * clamp(t, 0, 1);
	let index = 1;
	while (index < lengths.length - 1 && lengths[index] < target) index += 1;
	const left = points[index - 1];
	const right = points[index];
	const span = Math.max(1e-6, lengths[index] - lengths[index - 1]);
	const ratio = clamp((target - lengths[index - 1]) / span, 0, 1);
	return {
		x: left.x + (right.x - left.x) * ratio,
		y: left.y + (right.y - left.y) * ratio,
	};
}

function pathPoint(state, t) {
	return state.bezier ? bezier(state, t) : polylinePoint(state, t);
}

function tangent(state, t) {
	const left = pathPoint(state, clamp(t - 0.01, 0, 1));
	const right = pathPoint(state, clamp(t + 0.01, 0, 1));
	return { x: right.x - left.x, y: right.y - left.y };
}

function centerPoint(state) {
	return pathPoint(state, 0.5);
}

function normalAtCenter(state) {
	const tan = tangent(state, 0.5);
	const len = Math.hypot(tan.x, tan.y) || 1;
	return { x: -tan.y / len, y: tan.x / len };
}

function spreadHandlePoint(state) {
	const center = centerPoint(state);
	const normal = normalAtCenter(state);
	const multiplier = Math.max(1, (state.trackCount - 1) / 2);
	return {
		x: clamp(center.x + normal.x * state.spread * multiplier, 0, 1),
		y: clamp(center.y + normal.y * state.spread * multiplier, 0, 1),
	};
}

function generateTracks(node, state) {
	const grouped = generateTrackGroups(node, state);
	return grouped.flatMap((group) => group.tracks);
}

function generateTrackGroups(node, state) {
	const width = getNumber(node, WIDTH_WIDGET, 720);
	const height = getNumber(node, HEIGHT_WIDGET, 480);
	const frames = getNumber(node, FRAME_WIDGET, 81);
	const groups = [];
	const sources = Array.isArray(state?.tracks) ? state.tracks : [activeTrackState(state)];
	for (const [sourceIndex, source] of sources.entries()) {
		if (source.enabled === false) continue;
		const tracks = [];
		for (let trackIndex = 0; trackIndex < source.trackCount; trackIndex += 1) {
			const offset = source.trackCount <= 1 ? 0 : (trackIndex - (source.trackCount - 1) / 2) * source.spread;
			const points = [];
			for (let frame = 0; frame < frames; frame += 1) {
				const rawT = frames <= 1 ? 0 : frame / (frames - 1);
				const t = ease(rawT, source.interpolation);
				const point = pathPoint(source, t);
				const tan = tangent(source, t);
				const len = Math.hypot(tan.x, tan.y) || 1;
				points.push({
					x: Math.round((point.x + (-tan.y / len) * offset) * width),
					y: Math.round((point.y + (tan.x / len) * offset) * height),
				});
			}
			tracks.push(points);
		}
		groups.push({ sourceIndex, source, tracks });
	}
	return groups;
}

function writeTracks(node, tracks) {
	const payload = {
		width: getNumber(node, WIDTH_WIDGET, 720),
		height: getNumber(node, HEIGHT_WIDGET, 480),
		frame_count: getNumber(node, FRAME_WIDGET, 81),
		tracks,
	};
	const text = JSON.stringify(payload);
	setWidget(node, JSON_WIDGET, text);
	node.properties ||= {};
	node.properties[JSON_WIDGET] = text;
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	return JSON.stringify(tracks);
}

function setDimensionWidgets(node, width, height) {
	const w = Math.max(16, Math.round(Number(width) || 720));
	const h = Math.max(16, Math.round(Number(height) || 480));
	node.properties ||= {};
	node.properties.__gjj_wanmove_last_width = w;
	node.properties.__gjj_wanmove_last_height = h;
	setWidget(node, WIDTH_WIDGET, w);
	setWidget(node, HEIGHT_WIDGET, h);
}

function syncLinkedWidgetDisplays(node) {
	const defaults = { [WIDTH_WIDGET]: 720, [HEIGHT_WIDGET]: 480, [FRAME_WIDGET]: 81 };
	for (const name of [WIDTH_WIDGET, HEIGHT_WIDGET, FRAME_WIDGET]) {
		const item = widget(node, name);
		if (!item) continue;
		if (hasLinkedInput(node, name)) {
			if (item.value !== "") {
				node.properties ||= {};
				const stored = Number(item.value);
				if (Number.isFinite(stored) && stored > 0) node.properties[`__gjj_wanmove_last_${name}`] = stored;
			}
			item.value = "";
		} else if (item.value === "" || item.value == null) {
			const fallback = node.properties?.[`__gjj_wanmove_last_${name}`] || defaults[name];
			item.value = fallback;
		}
	}
}

function imageSrcFromInput(node) {
	const input = node.inputs?.find?.((item) => item?.name === IMAGE_INPUT);
	if (!input || input.link == null || !app.graph?.links) return "";
	const link = app.graph.links[input.link];
	const srcNode = app.graph.getNodeById?.(link?.origin_id ?? link?.source_id ?? link?.from_id);
	if (!srcNode) return "";
	if (Array.isArray(srcNode.imgs)) {
		for (const img of srcNode.imgs) if (img?.src) return img.src;
	}
	if (srcNode.image?.src) return srcNode.image.src;
	const file = widget(srcNode, "image") || widget(srcNode, "file") || widget(srcNode, "filename");
	if (file?.value && (srcNode.comfyClass === "LoadImage" || srcNode.comfyClass === "LoadImageOutput")) {
		const type = srcNode.comfyClass === "LoadImageOutput" ? "output" : "input";
		return api.apiURL(`/view?filename=${encodeURIComponent(file.value)}&type=${type}&subfolder=&rand=${Date.now()}`);
	}
	return "";
}

function hideWidget(item) {
	if (!item) return;
	item.hidden = true;
	item.type = `converted-widget:${item.name || "hidden"}`;
	item.computeSize = () => [0, -4];
	item.getHeight = () => -4;
	item.draw = () => {};
	item.mouse = () => false;
}

function compact(node) {
	hideWidget(widget(node, JSON_WIDGET));
	if (!Array.isArray(node.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const type = String(input?.type || "");
		if (input?.name === JSON_WIDGET || type === `converted-widget:${JSON_WIDGET}`) {
			try { node.disconnectInput?.(index); } catch (_) {}
			node.removeInput?.(index);
		}
	}
}

function stabilizeOutputs(node) {
	if (!Array.isArray(node.outputs)) return;
	const showExtra = node?.properties?.[EXTRA_OUTPUTS] === true;
	const target = showExtra
		? [
			{ name: "WanMove轨道", type: "TRACKS" },
			{ name: "轨迹JSON", type: "STRING" },
			{ name: "Wan安全长度", type: "INT" },
		]
		: [{ name: "WanMove轨道", type: "TRACKS" }];
	for (let index = node.outputs.length - 1; index >= 0; index -= 1) {
		const output = node.outputs[index];
		const wanted = target[index];
		if (!wanted || output?.name !== wanted.name || output?.type !== wanted.type) {
			try { node.disconnectOutput?.(index); } catch (_) {}
			node.removeOutput?.(index);
		}
	}
	for (const [index, wanted] of target.entries()) {
		const output = node.outputs[index];
		if (!output) {
			node.addOutput?.(wanted.name, wanted.type);
		} else {
			output.name = wanted.name;
			output.type = wanted.type;
		}
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function button(label, title) {
	const el = document.createElement("button");
	el.type = "button";
	el.textContent = label;
	el.title = title || label;
	el.style.cssText = "width:28px;height:27px;border:1px solid rgba(120,210,230,.28);background:#202a30;color:#e8f7fa;border-radius:6px;padding:0;font-size:14px;font-weight:800;cursor:pointer;pointer-events:auto;flex:0 0 28px;line-height:1;";
	for (const name of ["pointerdown", "mousedown", "click"]) el.addEventListener(name, (event) => event.stopPropagation());
	return el;
}

function iconButton(label, title) {
	return button(label, title);
}

function interpolationMeta(value) {
	return INTERPOLATIONS.find((item) => item[0] === value) || INTERPOLATIONS[0];
}

function numberField(label, value, step = 0.01) {
	const wrap = document.createElement("label");
	wrap.style.cssText = "display:grid;grid-template-columns:auto minmax(86px,1fr);gap:6px;align-items:center;color:#aeb9c8;font-size:12px;flex:1 1 154px;min-width:148px;";
	const span = document.createElement("span");
	span.textContent = label;
	span.style.cssText = "white-space:nowrap;";
	const input = document.createElement("input");
	input.type = "number";
	input.step = String(step);
	input.value = String(value);
	input.style.cssText = "width:100%;min-width:0;height:28px;border:1px solid rgba(120,210,230,.2);border-radius:6px;background:#2b3036;color:white;padding:0 8px;box-sizing:border-box;font-weight:700;";
	for (const name of ["pointerdown", "mousedown", "click"]) input.addEventListener(name, (event) => event.stopPropagation());
	input.addEventListener("wheel", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const delta = event.deltaY < 0 ? 1 : -1;
		const next = Number(input.value || 0) + Number(step || 1) * delta;
		input.value = String(Math.max(0, Number(next.toFixed(4))));
		input.dispatchEvent(new Event("change"));
	});
	wrap.append(span, input);
	return { wrap, input };
}

function createPanel(node) {
	if (node.__gjjWanMovePanel || typeof node.addDOMWidget !== "function") {
		compact(node);
		stabilizeOutputs(node);
		return;
	}
	let state = readState(node);
	let bg = null;
	let active = "";

	const root = document.createElement("div");
	root.style.cssText = "width:100%;box-sizing:border-box;color:#dceff4;font-family:'Microsoft YaHei',sans-serif;pointer-events:auto;user-select:none;";
	for (const name of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) root.addEventListener(name, (event) => event.stopPropagation());

	const layout = document.createElement("div");
	layout.style.cssText = "display:flex;flex-direction:column;gap:8px;align-items:stretch;width:100%;box-sizing:border-box;";

	const trackBar = document.createElement("div");
	trackBar.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px;border:1px solid rgba(120,210,230,.18);border-radius:8px;background:rgba(8,13,16,.58);box-sizing:border-box;";
	const trackChips = document.createElement("div");
	trackChips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;flex:1 1 220px;min-width:180px;";
	const addTrackBtn = iconButton("➕", "添加一条轨迹");
	const deleteTrackBtn = iconButton("➖", "删除当前轨迹");
	trackBar.append(trackChips, addTrackBtn, deleteTrackBtn);

	const toolBar = document.createElement("div");
	toolBar.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px;border:1px solid rgba(120,210,230,.18);border-radius:8px;background:rgba(8,13,16,.58);box-sizing:border-box;";
	const countDownBtn = iconButton("⬇️", "当前选中轨迹：减少一条输出轨迹");
	const countUpBtn = iconButton("⬆️", "当前选中轨迹：增加一条输出轨迹");
	const addControlBtn = iconButton("📍", "当前选中轨迹：在曲线中间添加控制点");
	const removeControlBtn = iconButton("✂️", "当前选中轨迹：删除当前选中的中间控制点");
	const interpBtn = iconButton("📏", "线性插值");
	const bezierBtn = iconButton("📏", "当前轨迹为直线路径。点击切换为贝兹曲线");
	const openBtn = iconButton("📁", "打开本地图片作为背景，并同步宽高");
	const refreshBtn = iconButton("🔄", "刷新上游传入图片");
	const copyBtn = iconButton("📋", "复制当前轨迹 JSON");
	const outputsBtn = iconButton("🔌", "显示轨迹JSON和Wan安全长度输出口");
	const resetBtn = iconButton("↩️", "重置所有轨迹");
	const toolSpacer = document.createElement("div");
	toolSpacer.style.cssText = "flex:1 1 18px;min-width:12px;";
	toolBar.append(countDownBtn, countUpBtn, addControlBtn, removeControlBtn, bezierBtn, openBtn, refreshBtn, copyBtn, outputsBtn, resetBtn, toolSpacer, interpBtn);

	const canvas = document.createElement("canvas");
	canvas.style.cssText = "display:block;width:100%;height:360px;border:1px solid rgba(115,205,225,.32);border-radius:8px;background:#0d1418;cursor:crosshair;box-sizing:border-box;";

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "image/*";
	fileInput.style.display = "none";
	root.append(fileInput);

	layout.append(trackBar, toolBar, canvas);

	const status = document.createElement("div");
	status.style.cssText = "margin-top:8px;padding:6px 8px;border:1px solid rgba(120,210,230,.18);border-radius:8px;background:#081014;color:#bcd5dc;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

	root.append(layout, status);
	const panelHeight = () => Math.max(450, Math.round((canvas.clientHeight || 360) + trackBar.getBoundingClientRect().height + toolBar.getBoundingClientRect().height + 34));
	const panel = node.addDOMWidget(PANEL, "HTML", root, { serialize: false, hideOnZoom: false, getHeight: panelHeight });
	panel.computeSize = (width) => [Math.max(420, Number(width || 720)), panelHeight()];
	node.__gjjWanMovePanel = { panel };

	function renderTrackChips() {
		trackChips.replaceChildren();
		for (const [index, track] of state.tracks.entries()) {
			const chip = document.createElement("button");
			chip.type = "button";
			chip.title = `选择轨迹 ${index + 1}`;
			chip.style.cssText = [
				"height:28px;display:flex;align-items:center;gap:5px;border-radius:6px;padding:0 7px;font-size:12px;font-weight:800;cursor:pointer;pointer-events:auto;",
				index === state.activeTrack ? "border:1px solid rgba(255,255,255,.56);background:#263840;color:#f4feff;" : "border:1px solid rgba(120,210,230,.22);background:#171f24;color:#bfd6dc;",
			].join("");
			const dot = document.createElement("span");
			dot.textContent = COLOR_EMOJIS[index % COLOR_EMOJIS.length];
			dot.style.cssText = "font-size:15px;line-height:1;flex:0 0 auto;";
			const enabled = document.createElement("input");
			enabled.type = "checkbox";
			enabled.checked = track.enabled !== false;
			enabled.title = `启用轨迹 ${index + 1}`;
			enabled.style.cssText = "margin:0;width:14px;height:14px;accent-color:#79e6a0;";
			for (const name of ["pointerdown", "mousedown", "click"]) {
				chip.addEventListener(name, (event) => event.stopPropagation());
				enabled.addEventListener(name, (event) => event.stopPropagation());
			}
			chip.addEventListener("click", () => {
				state.activeTrack = index;
				syncToInputs();
				draw();
			});
			enabled.addEventListener("change", () => {
				track.enabled = enabled.checked;
				saveState(node, state);
				writeTracks(node, generateTracks(node, state));
				renderTrackChips();
				draw();
			});
			chip.append(dot, enabled);
			trackChips.append(chip);
		}
		deleteTrackBtn.disabled = state.tracks.length <= 1;
		deleteTrackBtn.style.opacity = state.tracks.length <= 1 ? ".48" : "1";
	}

	function syncFromInputs() {
		syncLinkedWidgetDisplays(node);
		const track = activeTrackState(state);
		state.tracks[state.activeTrack] = track;
		state = normalizeState(state);
		syncToInputs();
		saveState(node, state);
		writeTracks(node, generateTracks(node, state));
		draw();
	}

	function syncToInputs() {
		syncLinkedWidgetDisplays(node);
		const track = activeTrackState(state);
		const interpMeta = interpolationMeta(track.interpolation);
		interpBtn.textContent = interpMeta[1];
		interpBtn.title = `${interpMeta[2]}。点击切换当前轨迹插值模式`;
		countDownBtn.title = `当前轨迹输出 ${track.trackCount} 条。点击减少一条`;
		countUpBtn.title = `当前轨迹输出 ${track.trackCount} 条。点击增加一条`;
		addControlBtn.title = track.bezier ? `当前贝兹曲线有 ${track.controls.length} 个控制点。点击添加控制点` : `当前折线有 ${track.controls.length} 个中间点。点击添加折线点`;
		addControlBtn.disabled = false;
		addControlBtn.style.opacity = "1";
		removeControlBtn.title = active.startsWith("control:")
			? `删除当前选中的${track.bezier ? "控制点" : "折线点"} ${Number(active.split(":")[1]) + 1}`
			: `当前轨迹有 ${track.controls.length} 个中间点。点击删除最后一个`;
		removeControlBtn.disabled = track.controls.length <= 0;
		removeControlBtn.style.opacity = track.controls.length <= 0 ? ".48" : "1";
		bezierBtn.textContent = track.bezier ? "〰️" : "📏";
		bezierBtn.title = track.bezier ? "当前轨迹为贝兹曲线。点击切换为直线路径" : "当前轨迹为直线路径。点击切换为贝兹曲线";
		bezierBtn.style.opacity = track.bezier ? "1" : ".52";
		outputsBtn.style.opacity = node?.properties?.[EXTRA_OUTPUTS] === true ? "1" : ".52";
		outputsBtn.title = node?.properties?.[EXTRA_OUTPUTS] === true
			? "隐藏轨迹JSON和Wan安全长度输出口"
			: "显示轨迹JSON和Wan安全长度输出口";
		renderTrackChips();
	}

	function pointToCanvas(point) {
		const rect = canvas.getBoundingClientRect();
		return { x: point.x * rect.width, y: point.y * rect.height };
	}

	function eventPoint(event) {
		const rect = canvas.getBoundingClientRect();
		return {
			x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
			y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
		};
	}

	function hit(event) {
		const p = eventPoint(event);
		let best = "";
		let dist = Infinity;
		const track = activeTrackState(state);
		const points = {
			start: track.start,
			end: track.end,
			spread: spreadHandlePoint(track),
		};
		for (const [index, control] of track.controls.entries()) {
			points[`control:${index}`] = control;
		}
		for (const key of Object.keys(points)) {
			const d = Math.hypot(p.x - points[key].x, p.y - points[key].y);
			if (d < dist && d < 0.045) {
				dist = d;
				best = key;
			}
		}
		return best;
	}

	function updateActiveFromEvent(event) {
		const point = eventPoint(event);
		const track = activeTrackState(state);
		if (active === "spread") {
			const center = centerPoint(track);
			const normal = normalAtCenter(track);
			const projection = (point.x - center.x) * normal.x + (point.y - center.y) * normal.y;
			const multiplier = Math.max(1, (track.trackCount - 1) / 2);
			track.spread = clamp(Math.abs(projection) / multiplier, 0, 0.5);
			return;
		}
		if (active.startsWith("control:")) {
			const index = Number(active.split(":")[1]);
			if (Number.isInteger(index) && track.controls[index]) track.controls[index] = point;
			return;
		}
		if (active) track[active] = point;
	}

	function draw() {
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		const dpr = Math.max(1, window.devicePixelRatio || 1);
		canvas.width = Math.round(rect.width * dpr);
		canvas.height = Math.round(rect.height * dpr);
		const ctx = canvas.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = "#0d1418";
		ctx.fillRect(0, 0, rect.width, rect.height);
		if (bg) {
			ctx.globalAlpha = 0.72;
			ctx.drawImage(bg, 0, 0, rect.width, rect.height);
			ctx.globalAlpha = 1;
			ctx.fillStyle = "rgba(13,20,24,.2)";
			ctx.fillRect(0, 0, rect.width, rect.height);
		}
		ctx.strokeStyle = "rgba(136,200,214,.12)";
		for (let i = 0; i <= 12; i += 1) {
			const x = i * rect.width / 12;
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, rect.height);
			ctx.stroke();
		}
		for (let i = 0; i <= 8; i += 1) {
			const y = i * rect.height / 8;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(rect.width, y);
			ctx.stroke();
		}
		const width = getNumber(node, WIDTH_WIDGET, 720);
		const height = getNumber(node, HEIGHT_WIDGET, 480);
		const groups = generateTrackGroups(node, state);
		for (const group of groups) {
			const color = COLORS[group.sourceIndex % COLORS.length];
			const isActiveGroup = group.sourceIndex === state.activeTrack;
			ctx.globalAlpha = isActiveGroup ? 1 : 0.48;
			for (const track of group.tracks) {
				ctx.strokeStyle = color;
				ctx.lineWidth = isActiveGroup ? 3 : 2;
				ctx.shadowColor = color;
				ctx.shadowBlur = isActiveGroup ? 7 : 0;
				ctx.beginPath();
				for (const [index, point] of track.entries()) {
					const x = point.x / width * rect.width;
					const y = point.y / height * rect.height;
					if (index === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				}
				ctx.stroke();
				ctx.shadowBlur = 0;
				ctx.fillStyle = color;
				for (let i = Math.max(1, Math.floor(track.length / 5)); i < track.length; i += Math.max(1, Math.floor(track.length / 5))) {
					const prev = track[Math.max(0, i - 1)];
					const cur = track[i];
					const x = cur.x / width * rect.width;
					const y = cur.y / height * rect.height;
					const px = prev.x / width * rect.width;
					const py = prev.y / height * rect.height;
					const angle = Math.atan2(y - py, x - px);
					ctx.save();
					ctx.translate(x, y);
					ctx.rotate(angle);
					ctx.beginPath();
					ctx.moveTo(0, 0);
					ctx.lineTo(-8, -4);
					ctx.lineTo(-8, 4);
					ctx.closePath();
					ctx.fill();
					ctx.restore();
				}
			}
		}
		ctx.globalAlpha = 1;
		const track = activeTrackState(state);
		const activeColor = COLORS[state.activeTrack % COLORS.length];
		ctx.setLineDash([5, 5]);
		ctx.strokeStyle = activeColor;
		ctx.beginPath();
		const guidePoints = pathPoints(track);
		for (const [index, point] of guidePoints.entries()) {
			const p = pointToCanvas(point);
			if (index === 0) ctx.moveTo(p.x, p.y);
			else ctx.lineTo(p.x, p.y);
		}
		ctx.stroke();
		ctx.setLineDash([]);
		const center = pointToCanvas(centerPoint(track));
		const spread = pointToCanvas(spreadHandlePoint(track));
		ctx.setLineDash([3, 4]);
		ctx.strokeStyle = "rgba(255,255,255,.45)";
		ctx.beginPath();
		ctx.moveTo(center.x, center.y);
		ctx.lineTo(spread.x, spread.y);
		ctx.stroke();
		ctx.setLineDash([]);
		const handles = [
			["start", "起", track.start],
			...track.controls.map((point, index) => [`control:${index}`, `${track.bezier ? "控" : "点"}${index + 1}`, point]),
			["end", "终", track.end],
			["spread", "宽", spreadHandlePoint(track)],
		];
		const handleColor = (key) => {
			if (key === "start") return { point: "#7cf58a", text: "#b9ffbf" };
			if (key === "end") return { point: "#ffdf6e", text: "#ffeaa0" };
			if (key === "spread") return { point: "#ffffff", text: "#ffffff" };
			if (key.startsWith("control:")) {
				const index = Number(key.split(":")[1]) || 0;
				const palette = [
					{ point: "#ff8a65", text: "#ffc1ad" },
					{ point: "#b99cff", text: "#dccdff" },
					{ point: "#66e3ff", text: "#c6f6ff" },
					{ point: "#f472b6", text: "#ffd0e7" },
					{ point: "#8dff9a", text: "#cbffd0" },
					{ point: "#ffdf6e", text: "#ffeaa0" },
				];
				return palette[index % palette.length];
			}
			return { point: activeColor, text: activeColor };
		};
		for (const [key, label, point] of handles) {
			const p = pointToCanvas(point);
			const color = handleColor(key);
			ctx.fillStyle = "#0b1013";
			ctx.strokeStyle = color.point;
			ctx.lineWidth = active === key ? 3 : 2;
			ctx.beginPath();
			ctx.arc(p.x, p.y, active === key ? 9 : 7, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
			ctx.font = "bold 11px sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "bottom";
			ctx.lineWidth = 3;
			ctx.strokeStyle = "rgba(0,0,0,.72)";
			ctx.strokeText(label, p.x, p.y - 10);
			ctx.fillStyle = color.text;
			ctx.fillText(label, p.x, p.y - 10);
		}
		const fmt = (point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
		const length = getNumber(node, FRAME_WIDGET, 81);
		const outputCount = groups.reduce((sum, group) => sum + group.tracks.length, 0);
		const interpMeta = interpolationMeta(track.interpolation);
		const coordText = [track.start, ...track.controls, track.end].map((point) => `(${fmt(point)})`).join("-");
		status.textContent = `轨迹 ${state.activeTrack + 1}/${state.tracks.length} | 当前 ${track.trackCount} 条 / 控制点 ${track.controls.length} 个 / 输出 ${outputCount} 条 / ${interpMeta[2]} / 分布 ${track.spread.toFixed(3)} / JSON ${length} 点 | ${coordText}`;
		panel.computeSize = (width) => [Math.max(420, Number(width || node.size?.[0] || 720)), panelHeight()];
		node.setDirtyCanvas?.(true, true);
	}

	async function refreshImage() {
		const src = imageSrcFromInput(node);
		if (src) {
			loadImageFromUrl(src, "上游图片");
			return;
		}
		status.textContent = "正在执行当前节点读取传入图片…";
		await queueOnlyCurrentNode(node);
	}

	function loadImageFromUrl(src, label = "图片") {
		if (!src) return;
		const img = new Image();
		if (!String(src).startsWith("data:")) img.crossOrigin = "anonymous";
		img.onload = () => {
			bg = img;
			if (img.naturalWidth && img.naturalHeight) {
				setDimensionWidgets(node, img.naturalWidth, img.naturalHeight);
			}
			draw();
			status.textContent = `${label}已加载：${img.naturalWidth || img.width}x${img.naturalHeight || img.height}`;
		};
		img.onerror = () => { status.textContent = `${label}加载失败`; };
		img.src = src;
	}

	canvas.addEventListener("pointerdown", (event) => {
		active = hit(event);
		if (!active) return;
		canvas.setPointerCapture?.(event.pointerId);
		updateActiveFromEvent(event);
		syncToInputs();
		syncFromInputs();
		event.preventDefault();
	});
	canvas.addEventListener("pointermove", (event) => {
		if (!active) return;
		updateActiveFromEvent(event);
		syncToInputs();
		syncFromInputs();
		event.preventDefault();
	});
	canvas.addEventListener("pointerup", () => { active = ""; draw(); });
	canvas.addEventListener("pointercancel", () => { active = ""; draw(); });
	countDownBtn.addEventListener("click", () => {
		const track = activeTrackState(state);
		track.trackCount = clamp(track.trackCount - 1, 1, 64);
		syncToInputs();
		syncFromInputs();
	});
	countUpBtn.addEventListener("click", () => {
		const track = activeTrackState(state);
		track.trackCount = clamp(track.trackCount + 1, 1, 64);
		syncToInputs();
		syncFromInputs();
	});
	addControlBtn.addEventListener("click", () => {
		const track = activeTrackState(state);
		if (track.controls.length >= 8) return;
		const insertAt = Math.max(0, Math.ceil(track.controls.length / 2));
		const path = bezierPoints(track);
		const point = pathPoint(track, 0.5);
		const fallback = path[Math.min(insertAt + 1, path.length - 1)] || point;
		track.controls.splice(insertAt, 0, normalizePoint({ x: (point.x + fallback.x) / 2, y: (point.y + fallback.y) / 2 }));
		active = `control:${insertAt}`;
		syncToInputs();
		syncFromInputs();
	});
	removeControlBtn.addEventListener("click", () => {
		const track = activeTrackState(state);
		if (!track.controls.length) return;
		let index = active.startsWith("control:") ? Number(active.split(":")[1]) : track.controls.length - 1;
		if (!Number.isInteger(index) || index < 0 || index >= track.controls.length) index = track.controls.length - 1;
		track.controls.splice(index, 1);
		active = "";
		syncToInputs();
		syncFromInputs();
	});
	interpBtn.addEventListener("click", () => {
		const track = activeTrackState(state);
		const index = INTERPOLATIONS.findIndex((item) => item[0] === track.interpolation);
		track.interpolation = INTERPOLATIONS[(index + 1) % INTERPOLATIONS.length][0];
		syncToInputs();
		syncFromInputs();
	});
	addTrackBtn.addEventListener("click", () => {
		const clone = makeTrack(activeTrackState(state), state.tracks.length);
		const offset = 0.06 * state.tracks.length;
		for (const key of ["start", "end"]) {
			clone[key] = normalizePoint({ x: clone[key].x + offset, y: clone[key].y });
		}
		clone.controls = clone.controls.map((point) => normalizePoint({ x: point.x + offset, y: point.y }));
		state.tracks.push(clone);
		state.activeTrack = state.tracks.length - 1;
		syncToInputs();
		syncFromInputs();
	});
	deleteTrackBtn.addEventListener("click", () => {
		if (state.tracks.length <= 1) return;
		state.tracks.splice(state.activeTrack, 1);
		state.activeTrack = clamp(state.activeTrack, 0, state.tracks.length - 1);
		syncToInputs();
		syncFromInputs();
	});
	bezierBtn.addEventListener("click", () => {
		const track = activeTrackState(state);
		track.bezier = !track.bezier;
		syncToInputs();
		syncFromInputs();
	});
	refreshBtn.addEventListener("click", refreshImage);
	openBtn.addEventListener("click", () => fileInput.click());
	fileInput.addEventListener("change", () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => loadImageFromUrl(String(reader.result || ""), file.name || "本地图片");
		reader.readAsDataURL(file);
		fileInput.value = "";
	});
	copyBtn.addEventListener("click", async () => {
		const text = writeTracks(node, generateTracks(node, state));
		try { await navigator.clipboard?.writeText(text); } catch (_) { window.prompt("复制轨迹 JSON", text); }
	});
	outputsBtn.addEventListener("click", () => {
		node.properties ||= {};
		node.properties[EXTRA_OUTPUTS] = node.properties[EXTRA_OUTPUTS] !== true;
		stabilizeOutputs(node);
		syncToInputs();
	});
	resetBtn.addEventListener("click", () => { state = normalizeState(DEFAULT_STATE); syncToInputs(); syncFromInputs(); });

	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message, ...args) {
		const result = originalExecuted?.apply(this, [message, ...args]);
		const preview = Array.isArray(message?.bg_image) ? message.bg_image[0] : null;
		if (preview) {
			const img = new Image();
			img.onload = () => { bg = img; draw(); };
			img.src = `data:image/png;base64,${preview}`;
		}
		return result;
	};

	syncToInputs();
	syncFromInputs();
	stabilizeOutputs(node);
	syncLinkedWidgetDisplays(node);
	setTimeout(draw, 80);
	compact(node);
}

app.registerExtension({
	name: "GJJ.WanMoveTrackVisualizer",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			this.properties ||= {};
			this.properties[STATE] ||= normalizeState(DEFAULT_STATE);
			this.properties[EXTRA_OUTPUTS] = this.properties[EXTRA_OUTPUTS] === true;
			compact(this);
			stabilizeOutputs(this);
			setTimeout(() => createPanel(this), 60);
			return result;
		};
		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) {
			data.properties ||= {};
			syncLinkedWidgetDisplays(this);
			data.properties[STATE] = normalizeState(this.properties?.[STATE] || DEFAULT_STATE);
			data.properties[EXTRA_OUTPUTS] = this.properties?.[EXTRA_OUTPUTS] === true;
			originalSerialize?.apply(this, [data]);
		};
		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			if (this.comfyClass === TARGET) {
				syncLinkedWidgetDisplays(this);
				setTimeout(() => {
					syncLinkedWidgetDisplays(this);
					this.setDirtyCanvas?.(true, true);
				}, 0);
			}
			return result;
		};
	},
	nodeCreated(node) {
		if (node.comfyClass !== TARGET) return;
		compact(node);
		node.properties ||= {};
		node.properties[EXTRA_OUTPUTS] = node.properties[EXTRA_OUTPUTS] === true;
		stabilizeOutputs(node);
		requestAnimationFrame(() => createPanel(node));
	},
});

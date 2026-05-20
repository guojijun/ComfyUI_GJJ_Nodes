import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_CLASS = "GJJ_ImageSplitter";
const STATE_WIDGET = "split_state";
const FILE_WIDGET = "internal_file";
const HIDDEN_WIDGETS = new Set([STATE_WIDGET, FILE_WIDGET]);

const ALIGN_PX = [2, 4, 8, 16, 32];
const DEFAULT_ALIGN = 16;
const MAX_ROWS = 4;
const MAX_COLS = 4;

const NODE_WIDTH = 420;
const MIN_NODE_WIDTH = 340;
const CANVAS_W = NODE_WIDTH - 44;
const CANVAS_H = 380;
const HEADER_H = 26;
const CONTROLS_H = 90;
const BLOCK_PREVIEW_H = 180;
const TOTAL_H = HEADER_H + CANVAS_H + CONTROLS_H + BLOCK_PREVIEW_H + 18;

// ─── State ─────────────────────────────────────────────────────────

function defaultState() {
	return { rows: 2, cols: 2, h_positions: [0.5], v_positions: [0.5], show_blocks: false, align_px: DEFAULT_ALIGN };
}

function parseState(raw) {
	try {
		const v = JSON.parse(String(raw || "{}"));
		return v && typeof v === "object" ? v : defaultState();
	} catch { return defaultState(); }
}

function evenSplitPositions(count) {
	const p = [];
	for (let i = 1; i < count; i++) p.push(i / count);
	return p;
}

function snapToPixels(fraction, dimension, alignPx) {
	const px = fraction * dimension;
	const snapped = Math.round(px / alignPx) * alignPx;
	const clamped = Math.max(alignPx, Math.min(dimension - alignPx, snapped));
	return clamped / dimension;
}

// ─── Helpers ───────────────────────────────────────────────────────

function findWidget(n, name) {
	return n.widgets?.find?.((w) => w.name === name);
}

function getHiddenValue(node, name, fallback = "") {
	const prop = node.properties?.[name];
	if (prop !== undefined && prop !== null) return prop;
	const w = findWidget(node, name);
	return w?.value ?? fallback;
}

function setHiddenValue(node, name, value) {
	node.properties = node.properties || {};
	node.properties[name] = value;
	const w = findWidget(node, name);
	if (w) {
		w.value = value;
		w.callback?.(value);
	}
}

function hideWidget(w) {
	if (!w || w.__gjjSplitHidden) return;
	w.__gjjSplitHidden = true;
	w.hidden = true;
	w.__gjjOriginalType = w.type;
	// 关键：不要用负高度 / y=-10000。负高度会把隐藏 widget 的悬浮提示推到节点顶部。
	// 保留 widget 本体用于 ComfyUI 序列化和执行取值，但让它完全不绘制、不响应、不显示 tooltip。
	w.type = `converted-widget:${w.name || "hidden"}`;
	w.label = "";
	w.localized_name = "";
	w.tooltip = "";
	w.options = { ...(w.options || {}), tooltip: "" };
	w.computeSize = () => [0, -4];
	w.getHeight = () => -4;
	w.y = 0;
	w.last_y = 0;
	w.draw = () => {};
	w.mouse = () => false;
	w.callback = w.callback || (() => {});
	if (w.element) {
		w.element.style.display = "none";
		w.element.style.height = "0px";
		w.element.style.minHeight = "0px";
		w.element.style.margin = "0";
		w.element.style.padding = "0";
		w.element.style.overflow = "hidden";
		w.element.style.pointerEvents = "none";
	}
	if (w.inputEl) {
		w.inputEl.style.display = "none";
		w.inputEl.title = "";
		w.inputEl.style.pointerEvents = "none";
	}
}

function hideInternalWidgets(node) {
	hideWidget(findWidget(node, STATE_WIDGET));
	hideWidget(findWidget(node, FILE_WIDGET));
}

function removeHiddenInputSockets(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const type = String(input?.type || "");
		const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
		if (HIDDEN_WIDGETS.has(name) || HIDDEN_WIDGETS.has(converted)) {
			try { node.disconnectInput?.(index); } catch (_) {}
			if (typeof node.removeInput === "function") {
				node.removeInput(index);
			} else {
				node.inputs.splice(index, 1);
			}
		}
	}
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	const priority = (widget) => {
		const name = String(widget?.name || "");
		if (name.startsWith("gjj_")) return 10;
		if (HIDDEN_WIDGETS.has(name)) return 90;
		return 50;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((a, b) => priority(a.widget) - priority(b.widget) || a.index - b.index)
		.map((entry) => entry.widget);
}

function compactNode(node) {
	// v6：状态改由 node.properties + 后端 hidden EXTRA_PNGINFO 读取。
	// 旧工作流如果残留 split_state/internal_file widget，先把值迁移到 properties，再从 widgets 队列移除，彻底不参与布局。
	for (const name of HIDDEN_WIDGETS) {
		const w = findWidget(node, name);
		if (w && w.value !== undefined && node.properties?.[name] === undefined) setHiddenValue(node, name, w.value);
	}
	if (Array.isArray(node.widgets)) {
		node.widgets = node.widgets.filter((w) => !HIDDEN_WIDGETS.has(String(w?.name || "")));
	}
	reorderWidgets(node);
	GJJ_Utils.refreshNode(node);
}

function scheduleCompact(node, ms = 32) {
	clearTimeout(node.__gjjSplitCompactTimer);
	node.__gjjSplitCompactTimer = setTimeout(() => compactNode(node), ms);
}

function getUpstreamImageSrc(node) {
	const inputNames = ["image"];
	for (const name of inputNames) {
		const input = node.inputs?.find?.((i) => i.name === name);
		if (!input || input.link == null || !app.graph?.links) continue;
		const link = app.graph.links[input.link];
		if (!link) continue;
		const srcId = link.origin_id ?? link.source_id ?? link.from_id;
		if (srcId == null) continue;
		const srcNode = app.graph.getNodeById(srcId);
		if (!srcNode) continue;

		if (Array.isArray(srcNode.imgs)) {
			for (const img of srcNode.imgs) {
				if (img?.src) return img.src;
			}
		}
		if (srcNode.image?.src) return srcNode.image.src;
		if (srcNode.preview?.src) return srcNode.preview.src;

		if (srcNode.comfyClass === "LoadImage" || srcNode.comfyClass === "LoadImageOutput") {
			const fw = findWidget(srcNode, "image") || findWidget(srcNode, "file") || findWidget(srcNode, "filename");
			if (fw?.value) {
				const t = srcNode.comfyClass === "LoadImageOutput" ? "output" : "input";
				return api.apiURL(`/view?filename=${encodeURIComponent(fw.value)}&type=${t}&subfolder=&rand=${Date.now()}`);
			}
		}
	}
	return null;
}

// ─── Dynamic Output Manager ────────────────────────────────────────

function disconnectOutputLinks(node, outputIndex) {
	try { node.disconnectOutput?.(outputIndex); } catch (_) {}
	const out = node.outputs?.[outputIndex];
	const links = Array.isArray(out?.links) ? [...out.links] : (out?.link != null ? [out.link] : []);
	for (const linkId of links) {
		try { app.graph?.removeLink?.(linkId); } catch (_) {}
	}
}

function syncOutputs(node, rows, cols, showBlocks = false) {
	const imageCount = rows * cols;
	const visibleCount = showBlocks ? 1 + imageCount : 1;
	// slot 0 固定为批量图片；区块输出口默认隐藏，由顶部按钮控制显示。
	while ((node.outputs?.length || 0) < visibleCount) {
		const idx = node.outputs?.length || 0;
		if (idx === 0) {
			node.addOutput?.("批量图片", "GJJ_BATCH_IMAGE");
		} else {
			const imgIdx = idx - 1;
			const r = Math.floor(imgIdx / cols);
			const c = imgIdx % cols;
			node.addOutput?.(`区块_${r + 1}_${c + 1}`, "IMAGE");
		}
	}
	// 根据开关状态强制收拢/扩充区块输出口。
	while ((node.outputs?.length || 0) > visibleCount) {
		const lastIdx = node.outputs.length - 1;
		if (lastIdx === 0) break;
		disconnectOutputLinks(node, lastIdx);
		node.removeOutput?.(lastIdx);
	}
	// 统一重命名
	(node.outputs || []).forEach((out, idx) => {
		if (idx === 0) {
			out.name = "批量图片";
			out.label = "批量图片";
			out.localized_name = "批量图片";
			out.type = "GJJ_BATCH_IMAGE";
			out.tooltip = "所有裁剪区块合并为一张批量图片，便于后续批量处理";
		} else {
			const imgIdx = idx - 1;
			const r = Math.floor(imgIdx / cols);
			const c = imgIdx % cols;
			out.name = `区块_${r + 1}_${c + 1}`;
			out.label = `区块_${r + 1}_${c + 1}`;
			out.localized_name = `区块_${r + 1}_${c + 1}`;
			out.type = "IMAGE";
			out.tooltip = `第${r + 1}行第${c + 1}列的裁剪区块`;
		}
	});
	GJJ_Utils.refreshNode(node);
}

// ─── Image Upload ──────────────────────────────────────────────────

function createFileInput(node, onFileLoaded) {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/png,image/jpeg,image/webp,image/bmp";
	input.style.display = "none";
	input.onchange = async () => {
		const file = input.files?.[0];
		if (!file) return;
		try {
			const fd = new FormData();
			fd.append("image", file);
			fd.append("type", "input");
			fd.append("subfolder", "");
			fd.append("overwrite", "true");
			const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
			if (!resp.ok) { console.warn("[GJJ] 上传失败:", resp.status); return; }
			const data = await resp.json();
			const fn = data.name || data.image || "";
			if (!fn) return;

			setHiddenValue(node, FILE_WIDGET, fn);

			const url = api.apiURL(`/view?filename=${encodeURIComponent(fn)}&type=input&subfolder=&rand=${Date.now()}`);
			onFileLoaded(url);
		} catch (err) { console.warn("[GJJ] 图片上传:", err); }
	};
	document.body.appendChild(input);
	return input;
}

// ─── Main Widget Builder ───────────────────────────────────────────

let widgetCounter = 0;

function createSplitterWidget(node) {
	if (node.__gjjSplitterWidget) return;
	node.__gjjSplitterWidget = true;

	const uid = `gjj_split_${++widgetCounter}_${Date.now()}`;
	const state = parseState(getHiddenValue(node, STATE_WIDGET, JSON.stringify(defaultState())));
	let showBlocks = state.show_blocks === true;

	let loadedImage = null;
	let imgW = 0;
	let imgH = 0;

	// ── Container ──────────────────────────────────────────────
	const wrap = document.createElement("div");
	wrap.style.cssText = "position:relative;width:100%;box-sizing:border-box;padding:0 10px 0;overflow:hidden;pointer-events:auto;user-select:none;";

	// ── Header ─────────────────────────────────────────────────
	const header = document.createElement("div");
	header.style.cssText = "display:none;align-items:center;justify-content:space-between;height:20px;padding:3px 4px 1px;font-size:11px;color:#98d6d1;";
	const dimEl = document.createElement("span");
	dimEl.title = "当前预览图片的宽×高（像素）";
	dimEl.textContent = "等待图片...";
	const infoEl = document.createElement("span");
	infoEl.textContent = "";
	header.append(dimEl, infoEl);
	wrap.appendChild(header);

	// ── Canvas ─────────────────────────────────────────────────
	const canvasWrap = document.createElement("div");
	canvasWrap.style.cssText = "display:none;position:relative;width:100%;height:" + CANVAS_H + "px;border:1px solid rgba(113,137,148,0.4);border-radius:6px;overflow:hidden;background:#0d1216;";

	const canvas = document.createElement("canvas");
	canvas.width = CANVAS_W;
	canvas.height = CANVAS_H;
	canvas.style.cssText = "display:block;width:100%;height:100%;cursor:crosshair;";
	canvasWrap.appendChild(canvas);
	wrap.appendChild(canvasWrap);

	// ── File input (hidden) ────────────────────────────────────
	const fileInput = createFileInput(node, (url) => tryLoadImage(url));

	// ── Controls ───────────────────────────────────────────────
	const ctrl = document.createElement("div");
	ctrl.style.cssText = "display:flex;flex-direction:column;gap:3px;padding:4px 2px 1px;font-size:11px;color:#d9e4e8;";

	function btn(text, title) {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = text;
		b.title = title || "";
		b.style.cssText = "padding:1px 7px;border:1px solid rgba(113,137,148,0.45);border-radius:3px;background:#1b252b;color:#d9e4e8;font-size:12px;cursor:pointer;line-height:1.3;";
		return b;
	}

	// ── Top Toolbar: all buttons in one row ────────────────────
	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;align-items:center;gap:4px;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;";

	const openBtn = document.createElement("button");
	openBtn.type = "button";
	openBtn.textContent = "📁";
	openBtn.title = "打开图片：从本地选择图片加载到节点内（无需外部 IMAGE 连接）";
	openBtn.style.cssText = "width:24px;height:22px;padding:0;border:1px solid rgba(113,137,148,0.45);border-radius:4px;background:#1b2f35;color:#d9e4e8;font-size:13px;cursor:pointer;line-height:20px;";
	openBtn.onclick = () => fileInput.click();

	const rowDec = btn("−", "减少一行");
	const rowVal = document.createElement("span");
	rowVal.style.cssText = "min-width:13px;text-align:center;font-weight:620;color:#98d6d1;";
	rowVal.title = "当前行数";
	rowVal.textContent = String(state.rows);
	const rowInc = btn("+", "增加一行");
	const colDec = btn("−", "减少一列");
	const colVal = document.createElement("span");
	colVal.style.cssText = "min-width:13px;text-align:center;font-weight:620;color:#98d6d1;";
	colVal.title = "当前列数";
	colVal.textContent = String(state.cols);
	const colInc = btn("+", "增加一列");

	const rowBox = document.createElement("span");
	rowBox.title = "行数设置";
	rowBox.style.cssText = "display:inline-flex;align-items:center;gap:2px;";
	rowBox.append("↕", rowDec, rowVal, rowInc);
	const colBox = document.createElement("span");
	colBox.title = "列数设置";
	colBox.style.cssText = "display:inline-flex;align-items:center;gap:2px;";
	colBox.append("↔", colDec, colVal, colInc);

	const evenBtn = document.createElement("button");
	evenBtn.type = "button";
	evenBtn.textContent = "▦";
	evenBtn.title = "均分行列，使每个区块等大";
	evenBtn.style.cssText = "width:24px;height:22px;padding:0;border:1px solid rgba(152,214,209,0.5);border-radius:4px;background:#1b2f35;color:#98d6d1;font-size:13px;cursor:pointer;line-height:20px;";

	const blockToggleBtn = document.createElement("button");
	blockToggleBtn.type = "button";
	blockToggleBtn.textContent = "🔌";
	blockToggleBtn.title = "显示/隐藏区块输出口。默认隐藏，只保留“批量图片”输出口；打开后按行列数量显示独立 IMAGE 输出口。";
	blockToggleBtn.style.cssText = "width:24px;height:22px;padding:0;border:1px solid rgba(113,137,148,0.45);border-radius:4px;background:#1b252b;color:#9fb3bd;font-size:13px;cursor:pointer;line-height:20px;";
	function updateBlockToggleStyle() {
		blockToggleBtn.style.background = showBlocks ? "#1b3a30" : "#1b252b";
		blockToggleBtn.style.color = showBlocks ? "#9df0b1" : "#9fb3bd";
		blockToggleBtn.style.borderColor = showBlocks ? "rgba(157,240,177,0.55)" : "rgba(113,137,148,0.45)";
	}
	blockToggleBtn.onclick = () => {
		showBlocks = !showBlocks;
		state.show_blocks = showBlocks;
		updateBlockToggleStyle();
		syncOutputs(node, state.rows, state.cols, showBlocks);
		syncState();
	};
	updateBlockToggleStyle();

	let currentAlign = ALIGN_PX.includes(Number(state.align_px)) ? Number(state.align_px) : DEFAULT_ALIGN;
	const alignBox = document.createElement("span");
	alignBox.title = "拖拽分割线时吸附到指定像素倍数";
	alignBox.style.cssText = "display:inline-flex;align-items:center;gap:2px;margin-left:2px;color:#9fb3bd;font-size:10px;";
	alignBox.append("🎯");
	for (const v of ALIGN_PX) {
		const radio = document.createElement("input");
		radio.type = "radio";
		radio.name = uid + "_align";
		radio.value = String(v);
		radio.style.cssText = "margin:0;accent-color:#4fd1c5;transform:scale(0.85);";
		if (v === currentAlign) radio.checked = true;
		radio.title = `吸附到 ${v}px 的倍数`;
		radio.onchange = () => { currentAlign = v; state.align_px = v; syncState(); updateBlockPreviews(); };
		const lbl = document.createElement("label");
		lbl.style.cssText = "display:inline-flex;align-items:center;gap:1px;font-size:10px;color:#bccfd6;cursor:pointer;";
		lbl.title = `拖拽分割线时自动吸附到 ${v}px 的整数倍位置`;
		lbl.append(radio, String(v));
		alignBox.appendChild(lbl);
	}

	toolbar.append(openBtn, rowBox, colBox, evenBtn, blockToggleBtn, alignBox);
	ctrl.append(toolbar);
	wrap.insertBefore(ctrl, header);

	// ── Block previews ─────────────────────────────────────────
	const blocksHdr = document.createElement("div");
	blocksHdr.style.cssText = "font-size:10px;color:#98d6d1;padding:3px 0 1px;";
	blocksHdr.title = "分割后的每个区块缩略图预览，下方数字为实际像素尺寸";
	blocksHdr.textContent = "📦 区块:";

	const blocksGrid = document.createElement("div");
	blocksGrid.style.cssText = "display:grid;gap:3px;padding:1px;min-height:0;";

	const blocksOuter = document.createElement("div");
	blocksOuter.style.cssText = "display:none;max-height:180px;overflow-y:auto;touch-action:auto;";
	blocksOuter.addEventListener("wheel", (e) => {
		const canScroll = e.deltaY > 0
			? blocksOuter.scrollTop + blocksOuter.clientHeight < blocksOuter.scrollHeight
			: blocksOuter.scrollTop > 0;
		if (canScroll) e.stopPropagation();
	}, { passive: true });
	blocksOuter.append(blocksHdr, blocksGrid);
	wrap.appendChild(blocksOuter);

	const statusEl = document.createElement("div");
	statusEl.style.cssText = "display:none;position:absolute;left:12px;right:12px;bottom:2px;padding:3px 7px;border:1px solid rgba(113,137,148,0.35);border-radius:6px;background:rgba(16,24,29,0.92);color:#b9d7df;font-size:10px;line-height:1.15;pointer-events:none;z-index:20;box-sizing:border-box;";
	wrap.appendChild(statusEl);

	// ── Sync state ─────────────────────────────────────────────
	function syncState() {
		setHiddenValue(node, STATE_WIDGET, JSON.stringify({
			rows: state.rows,
			cols: state.cols,
			h_positions: state.h_positions.map(p => Math.round(p * 1e6) / 1e6),
			v_positions: state.v_positions.map(p => Math.round(p * 1e6) / 1e6),
			show_blocks: showBlocks,
			align_px: currentAlign,
		}));
		if (app.graph) app.graph.setDirtyCanvas(true, true);
	}

	// ── Row / Col handlers ─────────────────────────────────────
	function setRows(n) {
		const r = Math.max(1, Math.min(MAX_ROWS, n));
		if (r === state.rows) return;
		state.rows = r;
		state.h_positions = evenSplitPositions(r);
		rowVal.textContent = String(r);
		syncOutputs(node, state.rows, state.cols, showBlocks);
		syncState();
		draw();
		updateBlockPreviews();
	}

	function setCols(n) {
		const c = Math.max(1, Math.min(MAX_COLS, n));
		if (c === state.cols) return;
		state.cols = c;
		state.v_positions = evenSplitPositions(c);
		colVal.textContent = String(c);
		syncOutputs(node, state.rows, state.cols, showBlocks);
		syncState();
		draw();
		updateBlockPreviews();
	}

	rowDec.onclick = () => setRows(state.rows - 1);
	rowInc.onclick = () => setRows(state.rows + 1);
	colDec.onclick = () => setCols(state.cols - 1);
	colInc.onclick = () => setCols(state.cols + 1);

	evenBtn.onclick = () => {
		state.h_positions = evenSplitPositions(state.rows);
		state.v_positions = evenSplitPositions(state.cols);
		syncState();
		draw();
		updateBlockPreviews();
	};

	// ── Visibility / sizing ─────────────────────────────────────
	function getAdaptiveCanvasHeight() {
		const nodeW = Math.max(MIN_NODE_WIDTH, Number(node.size?.[0] || NODE_WIDTH));
		const innerW = Math.max(260, nodeW - 44);
		// 窄节点时降低预览高度，避免 DOM 从节点底部/侧边冒出；宽节点仍保持大预览。
		return Math.max(260, Math.min(CANVAS_H, Math.round(innerW * 0.82)));
	}

	function calcWidgetHeight() {
		const ctrlH = Math.max(24, Math.ceil(ctrl.getBoundingClientRect?.().height || 26));
		if (!loadedImage) return ctrlH;
		const canvasH = getAdaptiveCanvasHeight();
		const visibleBlockH = blocksOuter.style.display === "none" ? 0 : Math.min(BLOCK_PREVIEW_H, Math.max(0, blocksOuter.scrollHeight || 0));
		return ctrlH + HEADER_H + canvasH + visibleBlockH;
	}

	function resizeN() {
		const currentW = Number(node.size?.[0] || NODE_WIDTH);
		const w = Math.max(MIN_NODE_WIDTH, currentW);
		const exactH = Math.ceil(calcWidgetHeight());
		const h = Math.max(58, exactH);
		node.__gjjSplitterHeight = exactH;
		node.minWidth = MIN_NODE_WIDTH;
		node.min_width = MIN_NODE_WIDTH;
		node.size = [w, h];
		node.setSize?.(node.size);
		GJJ_Utils.refreshNode?.(node);
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	function applyVisibility() {
		const has = !!loadedImage;
		header.style.display = has ? "flex" : "none";
		canvasWrap.style.display = has ? "block" : "none";
		if (has) canvasWrap.style.height = `${getAdaptiveCanvasHeight()}px`;
		blocksOuter.style.display = has ? "block" : "none";
		requestAnimationFrame(resizeN);
	}

	// ── Canvas layout ──────────────────────────────────────────
	function getLayout() {
		const rect = canvas.getBoundingClientRect();
		const cw = rect.width || CANVAS_W;
		const ch = rect.height || CANVAS_H;
		if (!imgW || !imgH) return { cw, ch, scale: 1, dw: cw, dh: ch, ox: 0, oy: 0 };
		const s = Math.min(cw / imgW, ch / imgH);
		return { cw, ch, scale: s, dw: imgW * s, dh: imgH * s, ox: (cw - imgW * s) / 2, oy: (ch - imgH * s) / 2 };
	}

	// ── Draw ───────────────────────────────────────────────────
	function draw() {
		const ctx = canvas.getContext("2d");
		const ly = getLayout();
		const bw = Math.round(ly.cw);
		const bh = Math.round(ly.ch);
		if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw;
			canvas.height = bh; }

		ctx.fillStyle = "#0d1216";
		ctx.fillRect(0, 0, bw, bh);

		if (!loadedImage) {
			ctx.fillStyle = "#364a54";
			ctx.font = "13px system-ui, sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText("连接 IMAGE 或点击 📂 打开图片 加载", bw / 2, bh / 2 - 8);
			ctx.fillStyle = "#5a7a84";
			ctx.font = "11px system-ui, sans-serif";
			ctx.fillText("拖拽分割线调整裁剪区域", bw / 2, bh / 2 + 14);
			return;
		}

		ctx.drawImage(loadedImage, ly.ox, ly.oy, ly.dw, ly.dh);

		// Dividers
		ctx.lineWidth = 2;
		ctx.strokeStyle = "#4fd1c5";
		for (const p of (state.h_positions || [])) {
			const y = ly.oy + p * ly.dh;
			ctx.beginPath(); ctx.moveTo(ly.ox, y); ctx.lineTo(ly.ox + ly.dw, y); ctx.stroke();
		}
		for (const p of (state.v_positions || [])) {
			const x = ly.ox + p * ly.dw;
			ctx.beginPath(); ctx.moveTo(x, ly.oy); ctx.lineTo(x, ly.oy + ly.dh); ctx.stroke();
		}

		// Handles
		ctx.fillStyle = "#f0c040";
		for (const hp of (state.h_positions || [])) {
			for (const vp of (state.v_positions || [])) {
				const hx = ly.ox + vp * ly.dw;
				const hy = ly.oy + hp * ly.dh;
				ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill();
			}
		}

		// Block labels
		const allH = [0, ...(state.h_positions || []), 1];
		const allV = [0, ...(state.v_positions || []), 1];
		ctx.font = "bold 12px system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		for (let r = 0; r < state.rows && r < allH.length - 1; r++) {
			for (let c = 0; c < state.cols && c < allV.length - 1; c++) {
				const cx = ly.ox + ((allV[c] + allV[c + 1]) / 2) * ly.dw;
				const cy = ly.oy + ((allH[r] + allH[r + 1]) / 2) * ly.dh;
				ctx.fillStyle = "rgba(0,0,0,0.55)";
				ctx.fillRect(cx - 14, cy - 9, 28, 18);
				ctx.fillStyle = "#fff";
				ctx.fillText(`${r + 1},${c + 1}`, cx, cy + 1);
			}
		}
	}

	// ── Mouse drag ─────────────────────────────────────────────
	let drag = null;

	function hitTest(cx, cy) {
		const ly = getLayout();
		const t = 8;
		for (let i = 0; i < (state.h_positions || []).length; i++) {
			const y = ly.oy + state.h_positions[i] * ly.dh;
			if (Math.abs(cy - y) < t && cx >= ly.ox && cx <= ly.ox + ly.dw) return { axis: "h", idx: i };
		}
		for (let i = 0; i < (state.v_positions || []).length; i++) {
			const x = ly.ox + state.v_positions[i] * ly.dw;
			if (Math.abs(cx - x) < t && cy >= ly.oy && cy <= ly.oy + ly.dh) return { axis: "v", idx: i };
		}
		return null;
	}

	function cxy(e) {
		const r = canvas.getBoundingClientRect();
		return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
	}

	function onPD(e) {
		const { x, y } = cxy(e);
		const hit = hitTest(x, y);
		if (hit) {
			const pos = hit.axis === "h" ? state.h_positions : state.v_positions;
			drag = { ...hit, sv: pos[hit.idx], sx: e.clientX, sy: e.clientY };
			canvas.style.cursor = hit.axis === "h" ? "ns-resize" : "ew-resize";
			e.preventDefault(); e.stopPropagation();
		}
	}

	function onPM(e) {
		if (!drag) {
			const { x, y } = cxy(e);
			const hit = hitTest(x, y);
			canvas.style.cursor = hit ? (hit.axis === "h" ? "ns-resize" : "ew-resize") : "crosshair";
			return;
		}
		const ly = getLayout();
		const pos = drag.axis === "h" ? state.h_positions : state.v_positions;
		const dim = drag.axis === "h" ? imgH : imgW;

		let nf;
		if (drag.axis === "h") {
			nf = (e.clientY - drag.sy) / ly.dh + drag.sv;
		} else {
			nf = (e.clientX - drag.sx) / ly.dw + drag.sv;
		}
		nf = snapToPixels(Math.max(0.002, Math.min(0.998, nf)), dim, currentAlign);

		const mn = drag.idx > 0 ? pos[drag.idx - 1] + 0.002 : 0.002;
		const mx = drag.idx < pos.length - 1 ? pos[drag.idx + 1] - 0.002 : 0.998;
		pos[drag.idx] = Math.max(mn, Math.min(mx, nf));

		syncState(); draw(); updateBlockPreviews();
		e.preventDefault(); e.stopPropagation();
	}

	function onPU(e) {
		if (!drag) return;
		drag = null;
		canvas.style.cursor = "crosshair";
		e.preventDefault(); e.stopPropagation();
	}

	canvas.addEventListener("pointerdown", onPD);
	canvas.addEventListener("pointermove", onPM);
	canvas.addEventListener("pointerup", onPU);
	canvas.addEventListener("pointerleave", onPU);
	canvas.addEventListener("mousedown", (e) => onPD(e));
	canvas.addEventListener("mousemove", (e) => onPM(e));
	canvas.addEventListener("mouseup", (e) => onPU(e));
	canvas.addEventListener("mouseleave", (e) => onPU(e));

	// ── Block Previews ─────────────────────────────────────────
	function updateBlockPreviews() {
		if (!loadedImage) {
			blocksGrid.innerHTML = "";
			blocksGrid.style.gridTemplateColumns = "";
			applyVisibility();
			return;
		}
		const rows = state.rows;
		const cols = state.cols;
		blocksGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
		blocksGrid.innerHTML = "";

		const allH = [0, ...(state.h_positions || []), 1];
		const allV = [0, ...(state.v_positions || []), 1];

		for (let r = 0; r < rows && r < allH.length - 1; r++) {
			for (let c = 0; c < cols && c < allV.length - 1; c++) {
				const sx = allV[c] * imgW;
				const sy = allH[r] * imgH;
				const sw = (allV[c + 1] - allV[c]) * imgW;
				const sh = (allH[r + 1] - allH[r]) * imgH;
				const outW = Math.max(1, Math.floor(Math.round(sw) / currentAlign) * currentAlign || Math.round(sw));
				const outH = Math.max(1, Math.floor(Math.round(sh) / currentAlign) * currentAlign || Math.round(sh));
				const mw = 60;
				const mh = Math.max(24, Math.min(70, Math.round(mw * sh / sw)));

				const b = document.createElement("div");
				b.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:1px;";

				const mc = document.createElement("canvas");
				mc.width = mw; mc.height = mh;
				mc.style.cssText = `width:${mw}px;height:${mh}px;border:1px solid rgba(113,137,148,0.3);border-radius:3px;`;
				const mctx = mc.getContext("2d");
				mctx.drawImage(loadedImage, sx, sy, sw, sh, 0, 0, mw, mh);

				const lbl = document.createElement("span");
				lbl.style.cssText = "font-size:9px;color:#98d6d1;line-height:1;";
				lbl.title = `输出 ${outW}×${outH} 像素（${currentAlign}px 对齐）`;
				lbl.textContent = `${outW}×${outH}`;

				b.append(mc, lbl);
				blocksGrid.appendChild(b);
			}
		}
		applyVisibility();
	}

	// ── Image loading ──────────────────────────────────────────
	function setImage(img) {
		loadedImage = img;
		imgW = img.naturalWidth || img.width;
		imgH = img.naturalHeight || img.height;
		dimEl.title = `${imgW}×${imgH} 像素`;
		dimEl.textContent = `${imgW} × ${imgH}`;
		syncOutputs(node, state.rows, state.cols, showBlocks);
		applyVisibility();
		draw();
		updateBlockPreviews();
	}

	function tryLoadImage(src) {
		if (!src) { loadedImage = null; applyVisibility(); updateBlockPreviews(); return; }
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => setImage(img);
		img.onerror = () => { loadedImage = null; dimEl.textContent = "加载失败"; applyVisibility(); };
		img.src = src;
	}

	// ── DOM Widget ─────────────────────────────────────────────
	if (typeof node.addDOMWidget === "function") {
		node.addDOMWidget("gjj_splitter_main", "custom", wrap, {
			serialize: false,
			hideOnZoom: false,
			getHeight: () => node.__gjjSplitterHeight || calcWidgetHeight(),
			getWidth: () => Math.max(MIN_NODE_WIDTH, Number(node.size?.[0] || NODE_WIDTH)),
		});
	}

	// ── Node sizing ────────────────────────────────────────────
	reorderWidgets(node);
	hideInternalWidgets(node);
	resizeN();

	// ── ResizeObserver ─────────────────────────────────────────
	const ro = new ResizeObserver(() => { if (loadedImage) draw(); resizeN(); });
	ro.observe(canvasWrap);

	// ── Cleanup ────────────────────────────────────────────────
	const origRem = node.onRemoved;
	node.onRemoved = function () {
		origRem?.apply(this, arguments);
		ro.disconnect();
		if (fileInput && fileInput.parentNode) fileInput.parentNode.removeChild(fileInput);
	};

	// ── onExecuted ─────────────────────────────────────────────
	const origExec = node.onExecuted;
	node.onExecuted = function (message) {
		origExec?.apply(this, arguments);
		try {
			statusEl.textContent = "执行完成";
			statusEl.style.display = "block";
			clearTimeout(node.__gjjSplitStatusTimer);
			node.__gjjSplitStatusTimer = setTimeout(() => { statusEl.style.display = "none"; app.graph?.setDirtyCanvas?.(true, true); }, 1800);
			resizeN();
			const pd = message?.preview?.[0] || message?.preview;
			if (pd?.filename) {
				const url = api.apiURL(`/view?filename=${encodeURIComponent(pd.filename)}&type=temp&subfolder=&rand=${Date.now()}`);
				const img = new Image();
				img.crossOrigin = "anonymous";
				img.onload = () => {
					setImage(img);
					if (pd.rows > 0) { state.rows = pd.rows;
						rowVal.textContent = String(pd.rows); }
					if (pd.cols > 0) { state.cols = pd.cols;
						colVal.textContent = String(pd.cols); }
					if (pd.h_positions) state.h_positions = pd.h_positions;
					if (pd.v_positions) state.v_positions = pd.v_positions;
					syncState();
				};
				img.onerror = () => {
					const src = getUpstreamImageSrc(node);
					if (src) tryLoadImage(src);
				};
				img.src = url;
			}
		} catch (err) { console.warn("[GJJ_ImageSplitter] onExecuted:", err); }
	};

	// ── Connection change ──────────────────────────────────────
	const origConn = node.onConnectionsChange;
	node.onConnectionsChange = function (slotType, slotIndex, connected, linkInfo) {
		origConn?.apply(this, arguments);
		// 输入口（image）连接变化时重新加载预览
		if (slotType === 0) {
			const input = node.inputs?.[slotIndex];
			if (input && input.name === "image") {
				setTimeout(() => {
					const src = getUpstreamImageSrc(node);
					if (src) tryLoadImage(src);
				}, 300);
			}
		}
	};

	// ── Initial load ───────────────────────────────────────────
	syncOutputs(node, state.rows, state.cols, showBlocks);
	setTimeout(() => {
		// Try internal file first
		const internalFile = getHiddenValue(node, FILE_WIDGET, "");
		if (internalFile) {
			const url = api.apiURL(`/view?filename=${encodeURIComponent(internalFile)}&type=input&subfolder=&rand=${Date.now()}`);
			tryLoadImage(url);
			return;
		}
		// Then upstream
		const src = getUpstreamImageSrc(node);
		if (src) { tryLoadImage(src); } else { loadedImage = null; applyVisibility(); updateBlockPreviews(); }
	}, 400);
	requestAnimationFrame(resizeN);
}

// ─── Extension ─────────────────────────────────────────────────────

app.registerExtension({
	name: "GJJ.ImageSplitter.v6",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_CLASS) return;

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			this.properties = this.properties || {};
			compactNode(this);
			const state = parseState(getHiddenValue(this, STATE_WIDGET, JSON.stringify(defaultState())));
			syncOutputs(this, state.rows, state.cols, state.show_blocks === true);
			setTimeout(() => {
				const st = parseState(getHiddenValue(this, STATE_WIDGET, JSON.stringify(defaultState())));
				syncOutputs(this, st.rows, st.cols, st.show_blocks === true);
				createSplitterWidget(this);
			}, 80);
			setTimeout(() => compactNode(this), 120);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			// 核心数据只写入 properties，不再创建任何隐藏 widget 行。
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[STATE_WIDGET] = getHiddenValue(this, STATE_WIDGET, JSON.stringify(defaultState()));
			serializedNode.properties[FILE_WIDGET] = getHiddenValue(this, FILE_WIDGET, "");
			// 保存前修剪输出口
			const state = parseState(serializedNode.properties[STATE_WIDGET]);
			syncOutputs(this, state.rows, state.cols, state.show_blocks === true);
			originalOnSerialize?.apply(this, [serializedNode]);
		};
	},

	nodeCreated(node) {
		if (node.comfyClass !== TARGET_CLASS) return;
		compactNode(node);
		requestAnimationFrame(() => createSplitterWidget(node));
		setTimeout(() => compactNode(node), 0);
		setTimeout(() => compactNode(node), 120);
	},
});

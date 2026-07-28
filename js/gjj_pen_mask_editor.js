import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET = "GJJ_PenMaskEditor";
const DOM_WIDGET = "gjj_pen_mask_editor_dom";
const STATE_WIDGET = "mask_state";
const FILE_WIDGET = "image_file";
const MODE_WIDGET = "blend_mode";
const TOLERANCE_WIDGET = "wand_tolerance";
const INVERT_WIDGET = "invert";
const PROP_STATE = "gjj_pen_mask_state";
const PROP_SIZE = "gjj_pen_mask_size";
const PROP_IMAGE_SIZE = "gjj_pen_mask_image_size";
const DEFAULT_WIDTH = 520;

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name || item?.options?.name === name);
}

function getWidgetValue(node, name, fallback = "") {
	const value = widget(node, name)?.value;
	return value === undefined || value === null || value === "" ? fallback : value;
}

function setWidgetValue(node, name, value) {
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	if (w.inputEl) w.inputEl.value = value;
	if (w.element && "value" in w.element) w.element.value = value;
	try { w.callback?.(value); } catch (_) {}
}

function collapseElement(el) {
	if (!el?.style) return;
	el.style.display = "none";
	el.style.height = "0px";
	el.style.minHeight = "0px";
	el.style.maxHeight = "0px";
	el.style.margin = "0px";
	el.style.padding = "0px";
	el.style.border = "0px";
	el.style.overflow = "hidden";
}

function collapseWidget(w) {
	if (!w || w.__gjjPenMaskCollapsed) return;
	w.__gjjPenMaskCollapsed = true;
	w.hidden = true;
	w.type = `converted-widget:${w.name || "hidden"}`;
	w.computeSize = () => [0, -4];
	w.getHeight = () => -4;
	w.draw = () => {};
	w.y = 0;
	w.last_y = 0;
	w.serialize = true;
	if (w.options && typeof w.options === "object") {
		w.options.hidden = true;
		w.options.display = "hidden";
	}
	collapseElement(w.inputEl);
	collapseElement(w.element);
	collapseElement(w.widget);
}

function parseJson(text, fallback) {
	try {
		const parsed = JSON.parse(String(text || ""));
		return parsed ?? fallback;
	} catch (_) {
		return fallback;
	}
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

function ensureStyles() {
	if (document.getElementById("gjj-pen-mask-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-pen-mask-style";
	style.textContent = `
		.gjj-pen-mask { width:100%; box-sizing:border-box; display:flex; flex-direction:column; gap:7px; color:#dbe7e8; font:12px/1.35 Arial, sans-serif; }
		.gjj-pen-mask * { box-sizing:border-box; }
		.gjj-pen-mask-toolbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
		.gjj-pen-mask button { flex:0 0 34px; min-width:34px; height:26px; padding:0 4px; border:1px solid #3a4d55; border-radius:6px; background:#202b31; color:#e7f3f3; font-size:14px; line-height:24px; font-weight:700; cursor:pointer; overflow:visible; text-overflow:clip; white-space:nowrap; }
		.gjj-pen-mask button:hover { background:#2d3a42; border-color:#6aa6b8; }
		.gjj-pen-mask button.on { border-color:#4f8f7a; background:#20382f; color:#dff8ea; }
		.gjj-pen-mask-canvas-wrap { width:100%; position:relative; overflow:hidden; border:1px solid #33464e; border-radius:8px; background:#081014; display:flex; align-items:center; justify-content:center; }
		.gjj-pen-mask-canvas { display:block; max-width:100%; cursor:crosshair; }
		.gjj-pen-mask-status { color:#9eb1b6; min-height:16px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-pen-mask-file { display:none; }
	`;
	document.head.appendChild(style);
}

function eventNodeId(event) {
	return String(event?.detail?.node_id ?? event?.detail?.node ?? event?.detail?.display_node ?? event?.detail?.nodeId ?? "");
}

function findNodeById(nodeId) {
	if (!nodeId) return null;
	return app.graph?.getNodeById?.(Number(nodeId))
		|| app.graph?._nodes?.find((node) => String(node?.id || "") === String(nodeId))
		|| null;
}

function graphLink(linkId) {
	if (linkId == null || !app.graph?.links) return null;
	return typeof app.graph.links.get === "function" ? app.graph.links.get(linkId) : app.graph.links[linkId];
}

function upstreamImageSource(node) {
	const inputIndex = (node?.inputs || []).findIndex((input) => {
		const name = String(input?.name || "").toLowerCase();
		const type = String(input?.type || "").toUpperCase();
		return name === "image" || type.includes("IMAGE");
	});
	const input = inputIndex >= 0 ? node.inputs[inputIndex] : null;
	const link = graphLink(input?.link);
	if (!link) return null;
	const originId = Array.isArray(link) ? link[1] : link.origin_id ?? link.source_id ?? link.from_id;
	const originSlot = Number(Array.isArray(link) ? link[2] : link.origin_slot ?? link.source_slot ?? 0);
	const sourceNode = findNodeById(originId);
	if (!sourceNode) return null;

	// 模板参数节点的媒体预览就是参数当前值的即时可视结果，无需等待执行。
	// 按输出字段 key 选择对应卡片，避免模板中有多张图片时取错。
	if (sourceNode.comfyClass === "GJJ_TemplateParams" || sourceNode.type === "GJJ_TemplateParams") {
		const output = sourceNode.outputs?.[originSlot];
		const fieldKey = String(output?.gjj_template_param_key || "");
		const fieldKeys = sourceNode.__gjjTemplateParamsMediaFieldKeys || [];
		const mediaIndex = Math.max(0, fieldKey ? fieldKeys.indexOf(fieldKey) : originSlot);
		const root = sourceNode.__gjjTemplateParamsMediaGroup;
		const cards = root?.querySelectorAll?.(".gjj-common-media-card") || [];
		const image = cards[mediaIndex]?.querySelector?.("img") || root?.querySelector?.("img");
		if (image?.src) {
			return {
				src: image.src,
				signature: `template:${originId}:${fieldKey || originSlot}:${image.src}`,
			};
		}
	}

	const image = sourceNode.imgs?.find?.((item) => item?.src)
		|| sourceNode.image
		|| sourceNode.preview;
	return image?.src
		? { src: image.src, signature: `preview:${originId}:${originSlot}:${image.src}` }
		: null;
}

function prunePreviewOutput(node) {
	if (!Array.isArray(node?.outputs)) return;
	let changed = false;
	for (let index = node.outputs.length - 1; index >= 0; index -= 1) {
		const output = node.outputs[index];
		if (index < 2 && output?.name !== "遮罩预览") continue;
		for (const linkId of output?.links || []) {
			try { app.graph?.removeLink?.(linkId); } catch (_) {}
		}
		node.outputs.splice(index, 1);
		changed = true;
	}
	if (changed) {
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}
}

class PenMaskEditor {
	constructor(node, container) {
		this.node = node;
		this.container = container;
		this.tool = "pen";
		this.paths = [];
		this.wand = [];
		this.brush = [];
		this.brushRadius = 24;
		this.activePath = null;
		this.selected = null;
		this.selectedItems = [];
		this.drag = null;
		this.selectionRect = null;
		this.pointerPoint = null;
		this.image = null;
		this.imagePixels = null;
		this.wandPreviewCache = null;
		this.wandPreviewKey = "";
		this.imageWidth = 512;
		this.imageHeight = 512;
		this.displayWidth = 480;
		this.displayHeight = 320;
		this.buildDom();
		this.loadState();
		this.bindEvents();
		this.layout();
		this.render();
	}

	buildDom() {
		this.container.innerHTML = "";
		this.container.className = "gjj-pen-mask";
		this.toolbar = document.createElement("div");
		this.toolbar.className = "gjj-pen-mask-toolbar";
		this.buttons = {
			open: this.makeButton("📁", "打开本地图片并上传到 ComfyUI input", () => this.openFile()),
			wand: this.makeButton("🪄", "魔棒：点击相近颜色区域生成选区", () => this.setTool("wand")),
			pen: this.makeButton("🖋", "钢笔：点击加点，拖拽控制贝兹手柄，双击闭合", () => this.setTool("pen")),
			brush: this.makeButton("🪮", "笔刷：拖动直接刷出遮罩区域，滚轮调大小", () => this.setTool("brush")),
			eraser: this.makeButton("🧽", "橡皮擦：拖动擦除钢笔点、魔棒点和笔刷痕迹，滚轮调大小", () => this.setTool("eraser")),
			move: this.makeButton("✥", "选择/移动：拖动锚点或手柄", () => this.setTool("move")),
			close: this.makeButton("🔒", "闭合当前钢笔路径", () => this.closeActivePath()),
			modeReplace: this.makeButton("🔁", "新选区模式：替换", () => this.setMode("替换")),
			modeAdd: this.makeButton("➕", "新选区模式：添加", () => this.setMode("添加")),
			modeSubtract: this.makeButton("➖", "新选区模式：减去", () => this.setMode("减去")),
			invert: this.makeButton("🌔", "遮罩方向：正向；点击切换为反向遮罩", () => this.toggleInvert()),
			clear: this.makeButton("🗑", "清空全部钢笔路径、魔棒点和笔刷痕迹", () => this.clear()),
		};
		this.toolbar.append(
			this.buttons.open,
			this.buttons.wand,
			this.buttons.pen,
			this.buttons.brush,
			this.buttons.eraser,
			this.buttons.move,
			this.buttons.close,
			this.buttons.modeReplace,
			this.buttons.modeAdd,
			this.buttons.modeSubtract,
			this.buttons.invert,
			this.buttons.clear,
		);
		this.fileInput = document.createElement("input");
		this.fileInput.type = "file";
		this.fileInput.accept = "image/*,.png,.jpg,.jpeg,.webp";
		this.fileInput.className = "gjj-pen-mask-file";
		this.canvasWrap = document.createElement("div");
		this.canvasWrap.className = "gjj-pen-mask-canvas-wrap";
		this.canvas = document.createElement("canvas");
		this.canvas.className = "gjj-pen-mask-canvas";
		this.canvasWrap.appendChild(this.canvas);
		this.ctx = this.canvas.getContext("2d");
		this.status = document.createElement("div");
		this.status.className = "gjj-pen-mask-status";
		this.container.append(this.toolbar, this.fileInput, this.canvasWrap, this.status);
		this.setTool("pen");
	}

	makeButton(label, title, action) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.title = title;
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick"]) {
			button.addEventListener(eventName, (event) => event.stopPropagation());
		}
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			action();
		});
		return button;
	}

	bindEvents() {
		for (const el of [this.container, this.canvas, this.canvasWrap]) {
			for (const eventName of ["pointerdown", "mousedown", "mousemove", "mouseup", "wheel", "dblclick", "contextmenu"]) {
				el.addEventListener(eventName, (event) => event.stopPropagation());
			}
		}
		this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
		this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
		this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
		this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
		this.canvas.tabIndex = 0;
		this.canvas.addEventListener("keydown", (event) => {
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			event.preventDefault();
			event.stopPropagation();
			this.deleteSelected();
		});
		this.canvas.addEventListener("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.closeActivePath();
		});
		this.canvas.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.deleteSelected();
		});
		this.fileInput.onchange = async () => {
			const file = this.fileInput.files?.[0];
			if (!file) return;
			await this.loadLocalFile(file);
		};
	}

	loadState() {
		const stored = getWidgetValue(this.node, STATE_WIDGET, "") || this.node.properties?.[PROP_STATE] || "";
		const state = parseJson(stored, {});
		this.paths = Array.isArray(state.paths) ? state.paths : [];
		this.wand = Array.isArray(state.wand) ? state.wand : [];
		this.brush = Array.isArray(state.brush) ? state.brush : [];
	}

	syncState() {
		const payload = JSON.stringify({ version: 1, paths: this.paths, wand: this.wand, brush: this.brush });
		setWidgetValue(this.node, STATE_WIDGET, payload);
		this.node.properties = this.node.properties || {};
		this.node.properties[PROP_STATE] = payload;
		this.updateStatus();
		this.node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	setTool(tool) {
		this.tool = tool;
		this.syncButtonStates();
		this.canvas.style.cursor = this.cursorForTool();
		this.updateStatus();
	}

	syncButtonStates() {
		const modeMap = { modeReplace: "替换", modeAdd: "添加", modeSubtract: "减去" };
		for (const [name, button] of Object.entries(this.buttons || {})) {
			const isTool = ["wand", "pen", "brush", "eraser", "move"].includes(name) && name === this.tool;
			const isMode = modeMap[name] && modeMap[name] === this.currentMode();
			const isInvert = name === "invert" && this.currentInvert();
			button.classList.toggle("on", Boolean(isTool || isMode || isInvert));
		}
		const invert = this.buttons?.invert;
		if (invert) {
			const reversed = this.currentInvert();
			invert.textContent = reversed ? "🌘" : "🌔";
			invert.title = reversed
				? "遮罩方向：反向（黑白反相）；点击切换为正向遮罩"
				: "遮罩方向：正向；点击切换为反向遮罩";
			invert.setAttribute("aria-pressed", String(reversed));
		}
	}

	cursorForTool() {
		if (this.tool === "wand") return "cell";
		if (this.tool === "move") return "default";
		if (this.tool === "brush" || this.tool === "eraser") return "grab";
		return "crosshair";
	}

	layout(updateNode = true) {
		const maxWidth = Math.max(260, Math.round(Number(this.node.size?.[0] || DEFAULT_WIDTH) - 24));
		const ratio = this.imageHeight / Math.max(1, this.imageWidth);
		const chromeHeight = this.measureChromeHeight();
		const nodeHeight = Math.max(240, Number(this.node.size?.[1] || 430));
		const maxHeight = Math.max(160, Math.round(nodeHeight - chromeHeight));
		const widthByHeight = Math.round(maxHeight / Math.max(0.0001, ratio));
		this.displayWidth = Math.max(160, Math.min(maxWidth, widthByHeight));
		this.displayHeight = Math.max(120, Math.round(this.displayWidth * ratio));
		const dpr = window.devicePixelRatio || 1;
		this.canvas.style.width = `${this.displayWidth}px`;
		this.canvas.style.height = `${this.displayHeight}px`;
		this.canvasWrap.style.height = `${this.displayHeight}px`;
		this.canvas.width = Math.max(1, Math.round(this.displayWidth * dpr));
		this.canvas.height = Math.max(1, Math.round(this.displayHeight * dpr));
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.render();
		if (updateNode) this.scheduleSize();
	}

	measureChromeHeight() {
		const domY = Number(this.node.__gjjPenMaskDomWidget?.y || 0);
		const toolbar = Math.ceil(this.toolbar?.offsetHeight || 32);
		const status = Math.ceil(this.status?.offsetHeight || 16);
		const gap = 28;
		return Math.max(120, domY + toolbar + status + gap);
	}

	scheduleSize() {
		clearTimeout(this.sizeTimer);
		this.sizeTimer = setTimeout(() => {
			const minHeight = Math.ceil(this.measureChromeHeight() + 160);
			const currentHeight = Math.round(Number(this.node.size?.[1] || 0));
			if (currentHeight >= minHeight) return;
			this.node.__gjjPenMaskSizing = true;
			this.node.setSize?.([Math.round(Number(this.node.size?.[0] || DEFAULT_WIDTH)), minHeight]);
			this.node.__gjjPenMaskSizing = false;
		}, 0);
	}

	toCanvas(point) {
		return {
			x: point.x * this.displayWidth / Math.max(1, this.imageWidth),
			y: point.y * this.displayHeight / Math.max(1, this.imageHeight),
		};
	}

	fromEvent(event) {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: clamp((event.clientX - rect.left) * this.imageWidth / Math.max(1, rect.width), 0, this.imageWidth - 1),
			y: clamp((event.clientY - rect.top) * this.imageHeight / Math.max(1, rect.height), 0, this.imageHeight - 1),
		};
	}

	defaultHandles(point, prev) {
		const dx = prev ? (point.x - prev.x) * 0.35 : 34;
		const dy = prev ? (point.y - prev.y) * 0.35 : 0;
		return {
			...point,
			h1x: clamp(point.x - dx, 0, this.imageWidth - 1),
			h1y: clamp(point.y - dy, 0, this.imageHeight - 1),
			h2x: clamp(point.x + dx, 0, this.imageWidth - 1),
			h2y: clamp(point.y + dy, 0, this.imageHeight - 1),
		};
	}

	currentMode() {
		return String(getWidgetValue(this.node, MODE_WIDGET, "添加") || "添加");
	}

	setMode(mode) {
		setWidgetValue(this.node, MODE_WIDGET, mode);
		this.syncButtonStates();
		this.updateStatus();
		this.node.setDirtyCanvas?.(true, true);
	}

	currentInvert() {
		const value = getWidgetValue(this.node, INVERT_WIDGET, false);
		return value === true || value === "true" || value === "True" || value === 1 || value === "1";
	}

	toggleInvert() {
		setWidgetValue(this.node, INVERT_WIDGET, !this.currentInvert());
		this.syncButtonStates();
		this.updateStatus();
		this.node.setDirtyCanvas?.(true, true);
	}

	currentTolerance() {
		const value = Number(getWidgetValue(this.node, TOLERANCE_WIDGET, 28));
		return Number.isFinite(value) ? value : 28;
	}

	onPointerDown(event) {
		event.preventDefault();
		event.stopPropagation();
		const point = this.fromEvent(event);
		this.pointerPoint = point;
		if (event.button !== 0) return;
		this.canvas.focus?.();
		if (this.tool === "wand") {
			this.wand.push({ x: Math.round(point.x), y: Math.round(point.y), tolerance: this.currentTolerance(), mode: this.currentMode() });
			this.invalidateWandPreview();
			this.syncState();
			this.render();
			return;
		}
		if (this.tool === "brush") {
			this.addBrushPoint(point);
			this.drag = { kind: "brush" };
			try { this.canvas.setPointerCapture(event.pointerId); } catch (_) {}
			this.syncState();
			this.render();
			return;
		}
		if (this.tool === "eraser") {
			this.eraseAt(point);
			this.drag = { kind: "eraser" };
			try { this.canvas.setPointerCapture(event.pointerId); } catch (_) {}
			this.syncState();
			this.render();
			return;
		}
		if (this.tool === "move") {
			const objectHit = this.findObjectHit(point);
			if (objectHit) {
				if (!this.isSelectedItem(objectHit)) this.setSelection([objectHit]);
				this.drag = { kind: "multi", start: point, origins: this.captureSelectionOrigins() };
				try { this.canvas.setPointerCapture(event.pointerId); } catch (_) {}
				this.render();
				return;
			}
			this.setSelection([]);
			this.selectionRect = { start: point, current: point };
			this.drag = { kind: "selectBox" };
			try { this.canvas.setPointerCapture(event.pointerId); } catch (_) {}
			this.render();
			return;
		}
		const hit = this.findHit(point);
		if (hit) {
			this.selected = hit;
			this.selectedItems = [];
			this.drag = { ...hit, offset: this.hitOffset(hit, point) };
			try { this.canvas.setPointerCapture(event.pointerId); } catch (_) {}
			this.render();
			return;
		}
		if (!this.activePath || this.activePath.closed) {
			this.activePath = { closed: false, mode: this.currentMode(), points: [] };
			this.paths.push(this.activePath);
		}
		const prev = this.activePath.points[this.activePath.points.length - 1];
		this.activePath.points.push(this.defaultHandles(point, prev));
		this.selected = { pathIndex: this.paths.length - 1, pointIndex: this.activePath.points.length - 1, kind: "anchor" };
		this.selectedItems = [];
		this.syncState();
		this.render();
	}

	onPointerMove(event) {
		const point = this.fromEvent(event);
		this.pointerPoint = point;
		if (this.drag?.kind === "brush") {
			event.preventDefault();
			this.addBrushPoint(point);
			this.syncState();
			this.render();
			return;
		}
		if (this.drag?.kind === "eraser") {
			event.preventDefault();
			this.eraseAt(point);
			this.syncState();
			this.render();
			return;
		}
		if (this.drag?.kind === "selectBox") {
			event.preventDefault();
			this.selectionRect.current = point;
			this.render();
			return;
		}
		if (this.drag?.kind === "multi") {
			event.preventDefault();
			this.moveSelection(point.x - this.drag.start.x, point.y - this.drag.start.y, this.drag.origins);
			this.render();
			return;
		}
		if (!this.drag) {
			this.canvas.style.cursor = this.findHit(point) ? "move" : this.cursorForTool();
			return;
		}
		event.preventDefault();
		const path = this.paths[this.drag.pathIndex];
		const p = path?.points?.[this.drag.pointIndex];
		if (!p) return;
		const x = clamp(point.x - this.drag.offset.x, 0, this.imageWidth - 1);
		const y = clamp(point.y - this.drag.offset.y, 0, this.imageHeight - 1);
		if (this.drag.kind === "anchor") {
			const dx = x - p.x;
			const dy = y - p.y;
			p.x = x; p.y = y;
			p.h1x = clamp((p.h1x ?? p.x) + dx, 0, this.imageWidth - 1);
			p.h1y = clamp((p.h1y ?? p.y) + dy, 0, this.imageHeight - 1);
			p.h2x = clamp((p.h2x ?? p.x) + dx, 0, this.imageWidth - 1);
			p.h2y = clamp((p.h2y ?? p.y) + dy, 0, this.imageHeight - 1);
		} else {
			p[`${this.drag.kind}x`] = x;
			p[`${this.drag.kind}y`] = y;
			const other = this.drag.kind === "h1" ? "h2" : "h1";
			if (!event.altKey) {
				p[`${other}x`] = clamp(p.x * 2 - x, 0, this.imageWidth - 1);
				p[`${other}y`] = clamp(p.y * 2 - y, 0, this.imageHeight - 1);
			}
		}
		this.render();
	}

	onWheel(event) {
		if (this.tool !== "brush" && this.tool !== "eraser") return;
		event.preventDefault();
		event.stopPropagation();
		const delta = event.deltaY < 0 ? 2 : -2;
		this.brushRadius = clamp(this.brushRadius + delta, 2, 180);
		this.updateStatus();
		this.render();
	}

	addBrushPoint(point) {
		const last = this.brush[this.brush.length - 1];
		if (last && distance(last, point) < this.brushRadius * 0.35) return;
		this.brush.push({
			x: Math.round(point.x),
			y: Math.round(point.y),
			r: Math.round(this.brushRadius),
			mode: this.currentMode(),
		});
	}

	eraseAt(point) {
		const radius = Math.max(2, this.brushRadius);
		let changed = false;
		const beforeWand = this.wand.length;
		this.wand = this.wand.filter((item) => distance(item, point) > radius);
		changed = changed || this.wand.length !== beforeWand;
		const beforeBrush = this.brush.length;
		this.brush = this.brush.filter((item) => distance(item, point) > radius + Number(item.r || 0) * 0.35);
		changed = changed || this.brush.length !== beforeBrush;
		for (let pathIndex = this.paths.length - 1; pathIndex >= 0; pathIndex -= 1) {
			const path = this.paths[pathIndex];
			if (!Array.isArray(path?.points)) continue;
			const beforePoints = path.points.length;
			path.points = path.points.filter((p) => {
				const anchors = [
					{ x: Number(p.x || 0), y: Number(p.y || 0) },
					{ x: Number(p.h1x ?? p.x ?? 0), y: Number(p.h1y ?? p.y ?? 0) },
					{ x: Number(p.h2x ?? p.x ?? 0), y: Number(p.h2y ?? p.y ?? 0) },
				];
				return !anchors.some((anchor) => distance(anchor, point) <= radius);
			});
			if (path.points.length !== beforePoints) changed = true;
			if (path.points.length < 2) {
				this.paths.splice(pathIndex, 1);
				changed = true;
			} else if (path.closed && path.points.length < 4) {
				path.closed = false;
				changed = true;
			}
		}
		if (changed) {
			this.activePath = this.paths.includes(this.activePath) ? this.activePath : null;
			this.selected = null;
			this.invalidateWandPreview();
		}
	}

	onPointerUp(event) {
		if (!this.drag) return;
		try { this.canvas.releasePointerCapture(event.pointerId); } catch (_) {}
		if (this.drag.kind === "selectBox") {
			this.setSelection(this.objectsInRect(this.selectionRect));
			this.selectionRect = null;
			this.drag = null;
			this.render();
			return;
		}
		this.drag = null;
		this.syncState();
		this.render();
	}

	hitOffset(hit, point) {
		const p = this.paths[hit.pathIndex]?.points?.[hit.pointIndex];
		if (!p) return { x: 0, y: 0 };
		if (hit.kind === "anchor") return { x: point.x - p.x, y: point.y - p.y };
		return { x: point.x - (p[`${hit.kind}x`] ?? p.x), y: point.y - (p[`${hit.kind}y`] ?? p.y) };
	}

	findHit(point) {
		const radius = 12 * Math.max(this.imageWidth / this.displayWidth, this.imageHeight / this.displayHeight);
		for (let pathIndex = this.paths.length - 1; pathIndex >= 0; pathIndex -= 1) {
			const path = this.paths[pathIndex];
			for (let pointIndex = (path.points?.length || 0) - 1; pointIndex >= 0; pointIndex -= 1) {
				const p = path.points[pointIndex];
				for (const kind of ["h1", "h2"]) {
					if (distance(point, { x: p[`${kind}x`] ?? p.x, y: p[`${kind}y`] ?? p.y }) <= radius) {
						return { pathIndex, pointIndex, kind };
					}
				}
				if (distance(point, p) <= radius) return { pathIndex, pointIndex, kind: "anchor" };
			}
		}
		return null;
	}

	itemKey(item) {
		if (!item) return "";
		if (item.type === "path") return `path:${item.pathIndex}:${item.pointIndex}`;
		return `${item.type}:${item.index}`;
	}

	pathItemFromHit(hit) {
		return hit ? { type: "path", pathIndex: hit.pathIndex, pointIndex: hit.pointIndex } : null;
	}

	setSelection(items) {
		const seen = new Set();
		this.selectedItems = [];
		for (const item of items || []) {
			const key = this.itemKey(item);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			this.selectedItems.push({ ...item });
		}
		this.selected = this.selectedItems.length === 1 && this.selectedItems[0].type === "path"
			? { ...this.selectedItems[0], kind: "anchor" }
			: null;
	}

	isSelectedItem(item) {
		const key = this.itemKey(item);
		return Boolean(key && this.selectedItems.some((selected) => this.itemKey(selected) === key));
	}

	findObjectHit(point) {
		const scale = Math.max(this.imageWidth / this.displayWidth, this.imageHeight / this.displayHeight);
		const dotRadius = 12 * scale;
		for (let index = this.brush.length - 1; index >= 0; index -= 1) {
			const item = this.brush[index];
			if (distance(item, point) <= Math.max(dotRadius, Number(item.r || this.brushRadius))) return { type: "brush", index };
		}
		for (let index = this.wand.length - 1; index >= 0; index -= 1) {
			if (distance(this.wand[index], point) <= dotRadius) return { type: "wand", index };
		}
		return this.pathItemFromHit(this.findHit(point));
	}

	normalizedRect(rect) {
		if (!rect?.start || !rect?.current) return null;
		return {
			x1: Math.min(rect.start.x, rect.current.x),
			y1: Math.min(rect.start.y, rect.current.y),
			x2: Math.max(rect.start.x, rect.current.x),
			y2: Math.max(rect.start.y, rect.current.y),
		};
	}

	pointInRect(point, rect) {
		return point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2;
	}

	objectsInRect(rawRect) {
		const rect = this.normalizedRect(rawRect);
		if (!rect || Math.abs(rect.x2 - rect.x1) < 3 || Math.abs(rect.y2 - rect.y1) < 3) return [];
		const items = [];
		for (let pathIndex = 0; pathIndex < this.paths.length; pathIndex += 1) {
			const path = this.paths[pathIndex];
			for (let pointIndex = 0; pointIndex < (path.points?.length || 0); pointIndex += 1) {
				const point = path.points[pointIndex];
				if (this.pointInRect(point, rect)) items.push({ type: "path", pathIndex, pointIndex });
			}
		}
		for (let index = 0; index < this.wand.length; index += 1) {
			if (this.pointInRect(this.wand[index], rect)) items.push({ type: "wand", index });
		}
		for (let index = 0; index < this.brush.length; index += 1) {
			if (this.pointInRect(this.brush[index], rect)) items.push({ type: "brush", index });
		}
		return items;
	}

	captureSelectionOrigins() {
		return this.selectedItems.map((item) => {
			if (item.type === "path") {
				const point = this.paths[item.pathIndex]?.points?.[item.pointIndex];
				return { ...item, point: point ? { ...point } : null };
			}
			const source = item.type === "wand" ? this.wand[item.index] : this.brush[item.index];
			return { ...item, point: source ? { ...source } : null };
		});
	}

	moveSelection(dx, dy, origins) {
		for (const origin of origins || []) {
			if (!origin.point) continue;
			if (origin.type === "path") {
				const target = this.paths[origin.pathIndex]?.points?.[origin.pointIndex];
				if (!target) continue;
				const x = clamp(origin.point.x + dx, 0, this.imageWidth - 1);
				const y = clamp(origin.point.y + dy, 0, this.imageHeight - 1);
				const shiftX = x - origin.point.x;
				const shiftY = y - origin.point.y;
				target.x = x;
				target.y = y;
				target.h1x = clamp((origin.point.h1x ?? origin.point.x) + shiftX, 0, this.imageWidth - 1);
				target.h1y = clamp((origin.point.h1y ?? origin.point.y) + shiftY, 0, this.imageHeight - 1);
				target.h2x = clamp((origin.point.h2x ?? origin.point.x) + shiftX, 0, this.imageWidth - 1);
				target.h2y = clamp((origin.point.h2y ?? origin.point.y) + shiftY, 0, this.imageHeight - 1);
			} else {
				const target = origin.type === "wand" ? this.wand[origin.index] : this.brush[origin.index];
				if (!target) continue;
				target.x = clamp(origin.point.x + dx, 0, this.imageWidth - 1);
				target.y = clamp(origin.point.y + dy, 0, this.imageHeight - 1);
			}
		}
		this.invalidateWandPreview();
	}

	closeActivePath() {
		if (!this.activePath || this.activePath.points.length < 3) return;
		const first = this.activePath.points[0];
		const last = this.activePath.points[this.activePath.points.length - 1];
		if (distance(first, last) > 1) {
			this.activePath.points.push({ ...first });
		}
		this.activePath.closed = true;
		this.activePath = null;
		this.syncState();
		this.render();
	}

	deleteSelected() {
		if (this.selectedItems.length) {
			const pathItems = this.selectedItems
				.filter((item) => item.type === "path")
				.sort((a, b) => b.pathIndex - a.pathIndex || b.pointIndex - a.pointIndex);
			const wandItems = this.selectedItems
				.filter((item) => item.type === "wand")
				.sort((a, b) => b.index - a.index);
			const brushItems = this.selectedItems
				.filter((item) => item.type === "brush")
				.sort((a, b) => b.index - a.index);
			for (const item of brushItems) this.brush.splice(item.index, 1);
			for (const item of wandItems) this.wand.splice(item.index, 1);
			for (const item of pathItems) {
				const path = this.paths[item.pathIndex];
				if (!path?.points) continue;
				path.points.splice(item.pointIndex, 1);
				if (path.points.length < 2) this.paths.splice(item.pathIndex, 1);
			}
			this.selectedItems = [];
			this.selected = null;
			this.activePath = this.paths.includes(this.activePath) ? this.activePath : null;
			this.invalidateWandPreview();
			this.syncState();
			this.render();
			return;
		}
		if (!this.selected) return;
		const path = this.paths[this.selected.pathIndex];
		if (!path?.points) return;
		path.points.splice(this.selected.pointIndex, 1);
		if (path.points.length < 2) this.paths.splice(this.selected.pathIndex, 1);
		this.selected = null;
		this.syncState();
		this.render();
	}

	clear() {
		this.paths = [];
		this.wand = [];
		this.brush = [];
		this.activePath = null;
		this.selected = null;
		this.selectedItems = [];
		this.selectionRect = null;
		this.invalidateWandPreview();
		this.syncState();
		this.render();
	}

	openFile() {
		this.fileInput.value = "";
		this.fileInput.click();
	}

	async loadLocalFile(file) {
		const previewUrl = URL.createObjectURL(file);
		this.setImageSource(previewUrl);
		const form = new FormData();
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");
		this.status.textContent = `正在打开：${file.name}`;
		try {
			const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
			const data = await response.json();
			const name = data?.name || data?.filename || file.name;
			setWidgetValue(this.node, FILE_WIDGET, name);
			this.status.textContent = `已打开：${name}`;
			this.syncState();
		} catch (error) {
			this.status.textContent = `图片上传失败：${error?.message || error}`;
		}
	}

	setImageSource(src) {
		if (!src) return;
		const img = new Image();
		img.onload = () => {
			this.image = img;
			this.imageWidth = Math.max(1, img.naturalWidth || img.width || 512);
			this.imageHeight = Math.max(1, img.naturalHeight || img.height || 512);
			this.node.properties = this.node.properties || {};
			this.node.properties[PROP_IMAGE_SIZE] = {
				width: this.imageWidth,
				height: this.imageHeight,
				source: String(src || "").slice(0, 180),
			};
			this.readImagePixels();
			this.invalidateWandPreview();
			this.layout();
			this.render();
			try { globalThis.GJJLazyImageStudioSyncImageSources?.(this.node); } catch (_) {}
		};
		img.src = src;
	}

	setBackgroundBase64(base64) {
		if (!base64) return;
		this.setImageSource(`data:image/jpeg;base64,${String(base64).trim()}`);
	}

	syncUpstreamImage(force = false) {
		const source = upstreamImageSource(this.node);
		if (!source?.src) return false;
		if (!force && source.signature === this.node.__gjjPenMaskUpstreamSignature) return true;
		this.node.__gjjPenMaskUpstreamSignature = source.signature;
		this.setImageSource(source.src);
		return true;
	}

	updateStatus() {
		const active = this.activePath?.points?.length ? ` · 当前路径 ${this.activePath.points.length} 点` : "";
		const file = getWidgetValue(this.node, FILE_WIDGET, "");
		const source = this.image ? `${this.imageWidth}×${this.imageHeight}` : file ? "等待执行后刷新预览" : "未打开图片";
		const size = (this.tool === "brush" || this.tool === "eraser") ? ` · 半径 ${Math.round(this.brushRadius)}` : "";
		const selected = this.selectedItems.length ? ` · 已选 ${this.selectedItems.length}` : "";
		this.status.textContent = `${source} · ${this.currentMode()}${this.currentInvert() ? " · 反相" : ""} · 路径 ${this.paths.length} · 魔棒 ${this.wand.length} · 笔刷 ${this.brush.length}${selected}${size}${active}`;
		this.syncButtonStates();
	}

	readImagePixels() {
		this.imagePixels = null;
		if (!this.image) return;
		try {
			const canvas = document.createElement("canvas");
			canvas.width = this.imageWidth;
			canvas.height = this.imageHeight;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			ctx.drawImage(this.image, 0, 0, this.imageWidth, this.imageHeight);
			this.imagePixels = ctx.getImageData(0, 0, this.imageWidth, this.imageHeight).data;
		} catch (error) {
			console.warn("[GJJ] 魔棒读取图片像素失败:", error);
			this.imagePixels = null;
		}
	}

	invalidateWandPreview() {
		this.wandPreviewCache = null;
		this.wandPreviewKey = "";
	}

	floodFillMask(startX, startY, tolerance) {
		const width = this.imageWidth;
		const height = this.imageHeight;
		const pixels = this.imagePixels;
		const out = new Uint8Array(width * height);
		if (!pixels || width <= 0 || height <= 0) return out;
		const x0 = Math.round(clamp(startX, 0, width - 1));
		const y0 = Math.round(clamp(startY, 0, height - 1));
		const startIndex = (y0 * width + x0) * 4;
		const targetR = pixels[startIndex];
		const targetG = pixels[startIndex + 1];
		const targetB = pixels[startIndex + 2];
		const visited = new Uint8Array(width * height);
		const queue = [[x0, y0]];
		const threshold = clamp(Number(tolerance || 0), 0, 255);
		while (queue.length) {
			const [x, y] = queue.pop();
			if (x < 0 || y < 0 || x >= width || y >= height) continue;
			const index = y * width + x;
			if (visited[index]) continue;
			visited[index] = 1;
			const offset = index * 4;
			const diff = Math.max(
				Math.abs(pixels[offset] - targetR),
				Math.abs(pixels[offset + 1] - targetG),
				Math.abs(pixels[offset + 2] - targetB),
			);
			if (diff > threshold) continue;
			out[index] = 255;
			queue.push([x + 1, y]);
			queue.push([x - 1, y]);
			queue.push([x, y + 1]);
			queue.push([x, y - 1]);
		}
		return out;
	}

	buildWandPreviewMask() {
		if (!this.imagePixels || !this.wand.length) return null;
		const key = JSON.stringify({ w: this.imageWidth, h: this.imageHeight, wand: this.wand });
		if (this.wandPreviewCache && this.wandPreviewKey === key) return this.wandPreviewCache;
		const base = new Uint8Array(this.imageWidth * this.imageHeight);
		for (const item of this.wand) {
			const candidate = this.floodFillMask(
				Number(item.x || 0),
				Number(item.y || 0),
				Number(item.tolerance ?? this.currentTolerance()),
			);
			const mode = String(item.mode || "添加");
			for (let i = 0; i < base.length; i += 1) {
				if (mode === "减去") {
					if (candidate[i]) base[i] = 0;
				} else if (mode === "替换") {
					base[i] = candidate[i];
				} else if (candidate[i]) {
					base[i] = 255;
				}
			}
		}
		this.wandPreviewKey = key;
		this.wandPreviewCache = base;
		return base;
	}

	pathToCanvas(path) {
		if (!path?.points?.length) return null;
		const points = path.points;
		const first = this.toCanvas(points[0]);
		const p = new Path2D();
		p.moveTo(first.x, first.y);
		for (let i = 1; i < points.length; i += 1) {
			const prev = points[i - 1];
			const cur = points[i];
			const c1 = this.toCanvas({ x: prev.h2x ?? prev.x, y: prev.h2y ?? prev.y });
			const c2 = this.toCanvas({ x: cur.h1x ?? cur.x, y: cur.h1y ?? cur.y });
			const end = this.toCanvas(cur);
			p.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
		}
		if (path.closed) p.closePath();
		return p;
	}

	render() {
		if (!this.ctx) return;
		const ctx = this.ctx;
		const w = this.displayWidth || 480;
		const h = this.displayHeight || 320;
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = "#081014";
		ctx.fillRect(0, 0, w, h);
		if (this.image) ctx.drawImage(this.image, 0, 0, w, h);
		else this.drawEmpty(ctx, w, h);
		this.drawMaskOverlay(ctx);
		this.drawPaths(ctx);
		this.drawWandPoints(ctx);
		this.drawBrushPoints(ctx);
		this.drawToolRadius(ctx);
		this.drawSelectionRect(ctx);
		this.updateStatus();
	}

	drawEmpty(ctx, w, h) {
		ctx.save();
		ctx.strokeStyle = "rgba(160,180,190,0.16)";
		ctx.lineWidth = 1;
		for (let i = 1; i < 8; i += 1) {
			ctx.beginPath(); ctx.moveTo(w * i / 8, 0); ctx.lineTo(w * i / 8, h); ctx.stroke();
			ctx.beginPath(); ctx.moveTo(0, h * i / 8); ctx.lineTo(w, h * i / 8); ctx.stroke();
		}
		ctx.fillStyle = "rgba(220,235,238,0.62)";
		ctx.font = "12px Arial";
		ctx.textAlign = "center";
		ctx.fillText("连接上游图片后执行，或点击 📁 打开图片", w / 2, h / 2);
		ctx.restore();
	}

	drawMaskOverlay(ctx) {
		const overlay = document.createElement("canvas");
		overlay.width = Math.max(1, Math.round(this.displayWidth || 480));
		overlay.height = Math.max(1, Math.round(this.displayHeight || 320));
		const overlayCtx = overlay.getContext("2d");
		overlayCtx.save();
		overlayCtx.globalAlpha = 0.28;
		overlayCtx.fillStyle = "#45d483";
		for (const path of this.paths) {
			if (!path.closed) continue;
			const canvasPath = this.pathToCanvas(path);
			if (canvasPath) overlayCtx.fill(canvasPath);
		}
		const wandMask = this.buildWandPreviewMask();
		if (wandMask) {
			const imageData = new ImageData(this.imageWidth, this.imageHeight);
			for (let i = 0; i < wandMask.length; i += 1) {
				if (!wandMask[i]) continue;
				const offset = i * 4;
				imageData.data[offset] = 69;
				imageData.data[offset + 1] = 212;
				imageData.data[offset + 2] = 131;
				imageData.data[offset + 3] = 255;
			}
			const preview = document.createElement("canvas");
			preview.width = this.imageWidth;
			preview.height = this.imageHeight;
			preview.getContext("2d").putImageData(imageData, 0, 0);
			overlayCtx.drawImage(preview, 0, 0, this.displayWidth, this.displayHeight);
		}
		overlayCtx.restore();
		for (const item of this.brush) {
			const p = this.toCanvas(item);
			const r = Math.max(2, Number(item.r || this.brushRadius) * this.displayWidth / Math.max(1, this.imageWidth));
			const mode = String(item.mode || "添加");
			if (mode === "替换") overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
			overlayCtx.save();
			overlayCtx.globalCompositeOperation = mode === "减去" ? "destination-out" : "source-over";
			overlayCtx.globalAlpha = mode === "减去" ? 1 : 0.28;
			overlayCtx.fillStyle = "#45d483";
			overlayCtx.beginPath();
			overlayCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
			overlayCtx.fill();
			overlayCtx.restore();
		}
		ctx.drawImage(overlay, 0, 0);
	}

	drawPaths(ctx) {
		for (let pathIndex = 0; pathIndex < this.paths.length; pathIndex += 1) {
			const path = this.paths[pathIndex];
			const canvasPath = this.pathToCanvas(path);
			if (canvasPath) {
				ctx.save();
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				ctx.strokeStyle = "#050809";
				ctx.lineWidth = 5;
				ctx.stroke(canvasPath);
				ctx.strokeStyle = path.closed ? "#4ee58b" : "#f2d65c";
				ctx.lineWidth = 2;
				ctx.stroke(canvasPath);
				ctx.restore();
			}
			for (let pointIndex = 0; pointIndex < (path.points?.length || 0); pointIndex += 1) {
				this.drawPoint(ctx, path.points[pointIndex], pathIndex, pointIndex);
			}
		}
	}

	drawPoint(ctx, point, pathIndex, pointIndex) {
		const anchor = this.toCanvas(point);
		const h1 = this.toCanvas({ x: point.h1x ?? point.x, y: point.h1y ?? point.y });
		const h2 = this.toCanvas({ x: point.h2x ?? point.x, y: point.h2y ?? point.y });
		ctx.save();
		ctx.strokeStyle = "rgba(255,255,255,0.42)";
		ctx.lineWidth = 1;
		ctx.beginPath(); ctx.moveTo(h1.x, h1.y); ctx.lineTo(anchor.x, anchor.y); ctx.lineTo(h2.x, h2.y); ctx.stroke();
		for (const [kind, p] of [["h1", h1], ["h2", h2]]) {
			const selected = this.selected?.pathIndex === pathIndex && this.selected?.pointIndex === pointIndex && this.selected?.kind === kind;
			ctx.fillStyle = selected ? "#ffd166" : "#dbe7e8";
			ctx.strokeStyle = "#050809";
			ctx.beginPath(); ctx.rect(p.x - 4, p.y - 4, 8, 8); ctx.fill(); ctx.stroke();
		}
		const selected = (this.selected?.pathIndex === pathIndex && this.selected?.pointIndex === pointIndex && this.selected?.kind === "anchor")
			|| this.isSelectedItem({ type: "path", pathIndex, pointIndex });
		ctx.fillStyle = selected ? "#ffd166" : "#4ee58b";
		ctx.strokeStyle = "#050809";
		ctx.lineWidth = 2;
		ctx.beginPath(); ctx.arc(anchor.x, anchor.y, selected ? 7 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
		ctx.restore();
	}

	drawWandPoints(ctx) {
		ctx.save();
		ctx.fillStyle = "#7dc8ff";
		ctx.strokeStyle = "#050809";
		ctx.lineWidth = 2;
		for (let index = 0; index < this.wand.length; index += 1) {
			const item = this.wand[index];
			const p = this.toCanvas(item);
			const selected = this.isSelectedItem({ type: "wand", index });
			ctx.fillStyle = selected ? "#ffd166" : "#7dc8ff";
			ctx.beginPath();
			ctx.arc(p.x, p.y, selected ? 7 : 5, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
		}
		ctx.restore();
	}

	drawBrushPoints(ctx) {
		if (!this.brush.length) return;
		ctx.save();
		ctx.fillStyle = "rgba(255,220,112,0.2)";
		ctx.strokeStyle = "rgba(255,242,190,0.88)";
		ctx.lineWidth = 1.5;
		for (let index = 0; index < this.brush.length; index += 1) {
			const item = this.brush[index];
			const p = this.toCanvas(item);
			const r = Math.max(2, Number(item.r || this.brushRadius) * this.displayWidth / Math.max(1, this.imageWidth));
			const selected = this.isSelectedItem({ type: "brush", index });
			ctx.fillStyle = selected ? "rgba(255,209,102,0.28)" : "rgba(255,220,112,0.2)";
			ctx.strokeStyle = selected ? "#ffd166" : "rgba(255,242,190,0.88)";
			ctx.beginPath();
			ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
		}
		ctx.restore();
	}

	drawSelectionRect(ctx) {
		const rect = this.normalizedRect(this.selectionRect);
		if (!rect) return;
		const p1 = this.toCanvas({ x: rect.x1, y: rect.y1 });
		const p2 = this.toCanvas({ x: rect.x2, y: rect.y2 });
		ctx.save();
		ctx.fillStyle = "rgba(125,200,255,0.12)";
		ctx.strokeStyle = "rgba(125,200,255,0.95)";
		ctx.lineWidth = 1.5;
		ctx.setLineDash([5, 4]);
		ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
		ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
		ctx.restore();
	}

	drawToolRadius(ctx) {
		if ((this.tool !== "brush" && this.tool !== "eraser") || !this.pointerPoint) return;
		const p = this.toCanvas(this.pointerPoint);
		const r = Math.max(2, this.brushRadius * this.displayWidth / Math.max(1, this.imageWidth));
		ctx.save();
		ctx.strokeStyle = this.tool === "eraser" ? "rgba(255,120,120,0.95)" : "rgba(255,242,190,0.95)";
		ctx.fillStyle = this.tool === "eraser" ? "rgba(255,80,80,0.08)" : "rgba(255,220,112,0.08)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}
}

function createContainer(node) {
	ensureStyles();
	const container = document.createElement("div");
	container.className = "gjj-pen-mask";
	const domWidget = node.addDOMWidget?.(DOM_WIDGET, "GJJ 钢笔绘制遮罩", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (domWidget) {
		domWidget.computeSize = (width) => [
			Math.round(Number(width || node.size?.[0] || DEFAULT_WIDTH)),
			Math.max(180, Math.ceil(container.scrollHeight || 390)),
		];
		domWidget.getHeight = () => Math.max(180, Math.ceil(container.scrollHeight || 390));
	}
	node.__gjjPenMaskDomWidget = domWidget;
	node.__gjjPenMaskContainer = container;
	return container;
}

function ensureEditor(node) {
	if (!node || node.__gjjPenMaskEditor) return;
	prunePreviewOutput(node);
	collapseWidget(widget(node, STATE_WIDGET));
	collapseWidget(widget(node, FILE_WIDGET));
	collapseWidget(widget(node, MODE_WIDGET));
	collapseWidget(widget(node, INVERT_WIDGET));
	if (node.properties?.[PROP_STATE] && !getWidgetValue(node, STATE_WIDGET, "")) {
		setWidgetValue(node, STATE_WIDGET, node.properties[PROP_STATE]);
	}
	const container = node.__gjjPenMaskContainer || createContainer(node);
	node.__gjjPenMaskEditor = new PenMaskEditor(node, container);
	const savedSize = node.properties?.[PROP_SIZE];
	const width = Array.isArray(savedSize) ? Number(savedSize[0]) : Number(node.size?.[0] || DEFAULT_WIDTH);
	if (Number.isFinite(width) && width > 0) {
		node.setSize?.([Math.round(width), Math.max(Number(node.size?.[1] || 0), 430)]);
	}
	requestAnimationFrame(() => {
		node.__gjjPenMaskEditor?.layout();
		node.__gjjPenMaskEditor?.syncUpstreamImage(true);
	});
}

function scheduleEnsure(node, delay = 0) {
	clearTimeout(node.__gjjPenMaskTimer);
	node.__gjjPenMaskTimer = setTimeout(() => ensureEditor(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.PenMaskEditor",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleEnsure(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			const props = serializedNode?.properties || this.properties || {};
			this.properties = this.properties || {};
			if (props[PROP_STATE]) {
				this.properties[PROP_STATE] = props[PROP_STATE];
				setWidgetValue(this, STATE_WIDGET, props[PROP_STATE]);
			}
			if (Array.isArray(props[PROP_SIZE])) this.properties[PROP_SIZE] = props[PROP_SIZE];
			scheduleEnsure(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			this.__gjjPenMaskEditor?.syncState();
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[PROP_STATE] = getWidgetValue(this, STATE_WIDGET, "");
				serializedNode.properties[PROP_SIZE] = [
					Math.round(Number(this.size?.[0] || DEFAULT_WIDTH)),
					Math.round(Number(this.size?.[1] || 430)),
				];
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjPenMaskSizing) {
				this.properties = this.properties || {};
				this.properties[PROP_SIZE] = [
					Math.round(Number(this.size?.[0] || DEFAULT_WIDTH)),
					Math.round(Number(this.size?.[1] || 430)),
				];
			}
			this.__gjjPenMaskEditor?.layout(false);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			delete this.__gjjPenMaskUpstreamSignature;
			setTimeout(() => this.__gjjPenMaskEditor?.syncUpstreamImage(true), 0);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const now = Date.now();
			if (!this.__gjjPenMaskLastUpstreamCheck || now - this.__gjjPenMaskLastUpstreamCheck > 300) {
				this.__gjjPenMaskLastUpstreamCheck = now;
				setTimeout(() => this.__gjjPenMaskEditor?.syncUpstreamImage(false), 0);
			}
			return originalOnDrawBackground?.apply(this, args);
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === TARGET) scheduleEnsure(node, 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET) scheduleEnsure(node, 0);
		}
		window.addEventListener("gjj-template-params-updated", (event) => {
			const sourceId = String(event?.detail?.nodeId ?? "");
			for (const node of app.graph?._nodes || []) {
				if (node?.comfyClass !== TARGET) continue;
				const source = upstreamImageSource(node);
				if (!source || !source.signature.startsWith(`template:${sourceId}:`)) continue;
				delete node.__gjjPenMaskUpstreamSignature;
				setTimeout(() => node.__gjjPenMaskEditor?.syncUpstreamImage(true), 0);
			}
		});
	},
});

api.addEventListener("executed", (event) => {
	const node = findNodeById(eventNodeId(event));
	if (node?.comfyClass !== TARGET) return;
	const output = event?.detail?.output || event?.detail || {};
	const bg = Array.isArray(output.bg_image) ? output.bg_image[0] : null;
	if (bg) node.__gjjPenMaskEditor?.setBackgroundBase64(bg);
});

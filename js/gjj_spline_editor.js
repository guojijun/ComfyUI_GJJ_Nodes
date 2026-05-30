import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET = "GJJ_SplineEditor";
const POINTS_WIDGET = "points_store";
const COORDS_WIDGET = "coordinates";
const WIDTH_WIDGET = "mask_width";
const HEIGHT_WIDGET = "mask_height";
const SAMPLE_WIDGET = "points_to_sample";
const METHOD_WIDGET = "sampling_method";
const INTERP_WIDGET = "interpolation";
const TENSION_WIDGET = "tension";
const DOM_WIDGET = "gjj_spline_editor_dom";
const PROP_POINTS = "gjj_spline_points_store";
const PROP_EDITOR_SIZE = "gjj_spline_editor_size";
const MIN_NODE_WIDTH = 460;
const MAX_CANVAS_HEIGHT = 520;
const MIN_CANVAS_HEIGHT = 180;

const COLORS = ["#48a7ff", "#ff9f40", "#50d66b", "#ff5f71", "#ba8cff", "#d28b6b", "#ff7bc8", "#b4bf57", "#31d3d3", "#f0c44c"];

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name || item?.options?.name === name);
}

function getWidgetValue(node, name, fallback = "") {
	const value = widget(node, name)?.value;
	return value === undefined || value === null || value === "" ? fallback : value;
}

function getNumberWidget(node, name, fallback) {
	const value = Number(getWidgetValue(node, name, fallback));
	return Number.isFinite(value) ? value : fallback;
}

function setWidgetValue(node, name, value) {
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	if (w.inputEl) w.inputEl.value = value;
	if (w.element && "value" in w.element) w.element.value = value;
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
	if (!w || w.__gjjSplineCollapsed) return;
	w.__gjjSplineCollapsed = true;
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

function patchWidgetCallback(node, name) {
	const w = widget(node, name);
	if (!w || w.__gjjSplineCallbackPatched) return;
	w.__gjjSplineCallbackPatched = true;
	const original = w.callback;
	w.callback = function (...args) {
		const result = original?.apply(this, args);
		node.__gjjSplineEditor?.onWidgetChanged(name);
		return result;
	};
}

function eventNodeId(event) {
	return String(
		event?.detail?.node_id
			?? event?.detail?.node
			?? event?.detail?.display_node
			?? event?.detail?.nodeId
			?? "",
	);
}

function findNodeById(nodeId) {
	if (!nodeId) return null;
	return app.graph?.getNodeById?.(Number(nodeId))
		|| app.graph?._nodes?.find((node) => String(node?.id || "") === String(nodeId))
		|| null;
}

function safeParseJson(text, fallback) {
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
	if (document.getElementById("gjj-spline-editor-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-spline-editor-style";
	style.textContent = `
		.gjj-spline-editor { width:100%; box-sizing:border-box; display:flex; flex-direction:column; gap:7px; padding:0; color:#dbe7e8; font:12px/1.35 Arial, sans-serif; }
		.gjj-spline-editor * { box-sizing:border-box; }
		.gjj-spline-toolbar { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; }
		.gjj-spline-toolbar button { min-width:0; height:26px; padding:0 6px; border:1px solid #3a4d55; border-radius:6px; background:#202b31; color:#e7f3f3; font-size:12px; font-weight:700; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-spline-toolbar button:hover { background:#2d3a42; border-color:#6aa6b8; }
		.gjj-spline-toolbar button.on { border-color:#4f8f7a; background:#20382f; color:#dff8ea; }
		.gjj-spline-canvas-wrap { width:100%; position:relative; overflow:hidden; border:1px solid #33464e; border-radius:8px; background:#081014; }
		.gjj-spline-canvas { display:block; width:100%; height:260px; cursor:default; }
		.gjj-spline-status { color:#9eb1b6; min-height:16px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-spline-menu { position:fixed; z-index:100000; display:none; min-width:154px; padding:5px; border:1px solid #3c4f58; border-radius:7px; background:#11191d; box-shadow:0 10px 30px rgba(0,0,0,0.42); }
		.gjj-spline-menu button { display:block; width:100%; height:25px; margin:0; padding:0 8px; border:0; border-radius:5px; background:transparent; color:#e7f3f3; text-align:left; font-size:12px; cursor:pointer; }
		.gjj-spline-menu button:hover { background:#26343b; }
	`;
	document.head.appendChild(style);
}

const Interpolation = {
	_basisPoint(t0, p0, t1, p1, t2, p2, t3, p3) {
		return t0 * p0 + t1 * p1 + t2 * p2 + t3 * p3;
	},
	_pathBasis(p0, p1, p2, p3) {
		const bp = Interpolation._basisPoint;
		const x1 = bp(0, p0.x, 2 / 3, p1.x, 1 / 3, p2.x, 0, p3.x);
		const y1 = bp(0, p0.y, 2 / 3, p1.y, 1 / 3, p2.y, 0, p3.y);
		const x2 = bp(0, p0.x, 1 / 3, p1.x, 2 / 3, p2.x, 0, p3.x);
		const y2 = bp(0, p0.y, 1 / 3, p1.y, 2 / 3, p2.y, 0, p3.y);
		const x = bp(0, p0.x, 1 / 6, p1.x, 2 / 3, p2.x, 1 / 6, p3.x);
		const y = bp(0, p0.y, 1 / 6, p1.y, 2 / 3, p2.y, 1 / 6, p3.y);
		return `C${x1},${y1},${x2},${y2},${x},${y}`;
	},
	basis(points) {
		if (points.length <= 2) return Interpolation.linear(points);
		let d = "";
		let b0 = points[0], b1 = points[0], b2 = points[0], b3 = points[1];
		d += Interpolation._pathBasis(b0, b1, b2, b3);
		for (let i = 2; i < points.length; i += 1) {
			b0 = b1; b1 = b2; b2 = b3; b3 = points[i];
			d += Interpolation._pathBasis(b0, b1, b2, b3);
		}
		b0 = b1; b1 = b2; b2 = b3;
		d += Interpolation._pathBasis(b0, b1, b2, b3);
		b0 = b1; b1 = b2;
		d += Interpolation._pathBasis(b0, b1, b2, b3);
		return d;
	},
	_cardinalTangents(points, tension) {
		const alpha = (1 - Number(tension || 0)) / 2;
		const tangents = [];
		let f = points[0], g = points[1], h = points[2];
		for (let i = 3; i < points.length; i += 1) {
			tangents.push({ x: alpha * (h.x - f.x), y: alpha * (h.y - f.y) });
			f = g; g = h; h = points[i];
		}
		tangents.push({ x: alpha * (h.x - f.x), y: alpha * (h.y - f.y) });
		return tangents;
	},
	_hermite(points, tangents) {
		if (tangents.length < 1 || (points.length !== tangents.length && points.length !== tangents.length + 2)) return "";
		const quad = points.length !== tangents.length;
		let d = "";
		let g = points[0], h = points[1], i = tangents[0], j = i, k = 1;
		if (quad) {
			d += `Q${h.x - i.x * 2 / 3},${h.y - i.y * 2 / 3},${h.x},${h.y}`;
			g = points[1];
			k = 2;
		}
		if (tangents.length > 1) {
			j = tangents[1];
			h = points[k];
			k += 1;
			d += `C${g.x + i.x},${g.y + i.y},${h.x - j.x},${h.y - j.y},${h.x},${h.y}`;
			for (let idx = 2; idx < tangents.length; idx += 1, k += 1) {
				h = points[k];
				j = tangents[idx];
				d += `S${h.x - j.x},${h.y - j.y},${h.x},${h.y}`;
			}
		}
		if (quad) {
			const last = points[k];
			d += `Q${h.x + j.x * 2 / 3},${h.y + j.y * 2 / 3},${last.x},${last.y}`;
		}
		return d;
	},
	cardinal(points, tension) {
		if (points.length <= 2) return Interpolation.linear(points);
		return Interpolation._hermite(points, Interpolation._cardinalTangents(points, tension));
	},
	_monotoneTangents(points) {
		const n = points.length;
		const d = [], m = [], dx = [];
		for (let i = 0; i < n - 1; i += 1) {
			const run = points[i + 1].x - points[i].x;
			d.push(run === 0 ? 0 : (points[i + 1].y - points[i].y) / run);
		}
		m.push(d[0] || 0);
		for (let i = 1; i < n - 1; i += 1) m.push((d[i - 1] + d[i]) / 2);
		m.push(d[n - 2] || 0);
		dx.push(points[1].x - points[0].x);
		for (let i = 1; i < n - 1; i += 1) dx.push((points[i + 1].x - points[i - 1].x) / 2);
		dx.push(points[n - 1].x - points[n - 2].x);
		for (let i = 0; i < n - 1; i += 1) {
			if (Math.abs(d[i]) < 1e-7) {
				m[i] = 0;
				m[i + 1] = 0;
			}
		}
		for (let i = 0; i < n - 1; i += 1) {
			if (Math.abs(m[i]) >= 1e-5 && Math.abs(m[i + 1]) >= 1e-5 && d[i] !== 0) {
				const alpha = m[i] / d[i], beta = m[i + 1] / d[i], sigma = alpha * alpha + beta * beta;
				if (sigma > 9) {
					const k = 3 / Math.sqrt(sigma);
					m[i] = k * alpha * d[i];
					m[i + 1] = k * beta * d[i];
				}
			}
		}
		const tangents = [];
		for (let i = 0; i < n; i += 1) {
			const denom = 1 + m[i] * m[i];
			tangents.push({ x: (dx[i] || 0) / 3 / denom, y: m[i] * (dx[i] || 0) / 3 / denom });
		}
		return tangents;
	},
	monotone(points) {
		if (points.length <= 2) return Interpolation.linear(points);
		return Interpolation._hermite(points, Interpolation._monotoneTangents(points));
	},
	linear(points) {
		let d = "";
		for (let i = 1; i < points.length; i += 1) d += `L${points[i].x},${points[i].y}`;
		return d;
	},
	stepBefore(points) {
		let d = "";
		for (let i = 1; i < points.length; i += 1) d += `V${points[i].y}H${points[i].x}`;
		return d;
	},
	stepAfter(points) {
		let d = "";
		for (let i = 1; i < points.length; i += 1) d += `H${points[i].x}V${points[i].y}`;
		return d;
	},
	ensureBezierHandles(points) {
		for (let i = 0; i < points.length; i += 1) {
			if (points[i].h1x !== undefined) continue;
			const prev = points[Math.max(0, i - 1)];
			const next = points[Math.min(points.length - 1, i + 1)];
			const dx = (next.x - prev.x) * 0.25;
			const dy = (next.y - prev.y) * 0.25;
			points[i].h1x = points[i].x - dx;
			points[i].h1y = points[i].y - dy;
			points[i].h2x = points[i].x + dx;
			points[i].h2y = points[i].y + dy;
		}
	},
	bezier(points) {
		Interpolation.ensureBezierHandles(points);
		let d = "";
		for (let i = 1; i < points.length; i += 1) {
			const prev = points[i - 1];
			const cur = points[i];
			d += `C${prev.h2x ?? prev.x},${prev.h2y ?? prev.y},${cur.h1x ?? cur.x},${cur.h1y ?? cur.y},${cur.x},${cur.y}`;
		}
		return d;
	},
	buildPathD(points, interpolation, tension) {
		if (!points?.length) return "";
		let d = `M${points[0].x},${points[0].y}`;
		if (points.length === 1) return d;
		switch (interpolation) {
			case "basis": d += Interpolation.basis(points); break;
			case "cardinal": d += Interpolation.cardinal(points, tension); break;
			case "monotone": d += Interpolation.monotone(points); break;
			case "step-before": d += Interpolation.stepBefore(points); break;
			case "step-after": d += Interpolation.stepAfter(points); break;
			case "bezier": d += Interpolation.bezier(points); break;
			case "linear":
			default: d += Interpolation.linear(points); break;
		}
		return d;
	},
};

class PathSampler {
	constructor() {
		const ns = "http://www.w3.org/2000/svg";
		this.svg = document.createElementNS(ns, "svg");
		this.svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
		this.svg.setAttribute("aria-hidden", "true");
		this.path = document.createElementNS(ns, "path");
		this.svg.appendChild(this.path);
		document.body.appendChild(this.svg);
	}
	setPath(d) {
		this.path.setAttribute("d", d || "M0,0");
	}
	getTotalLength() {
		try { return this.path.getTotalLength(); } catch (_) { return 0; }
	}
	getPointAtLength(value) {
		try {
			const point = this.path.getPointAtLength(value);
			return { x: point.x, y: point.y };
		} catch (_) {
			return { x: 0, y: 0 };
		}
	}
	findPointAtX(targetX, pathLength) {
		let low = 0;
		let high = pathLength;
		let best = this.getPointAtLength(0);
		for (let i = 0; i < 24 && high - low > 0.5; i += 1) {
			const mid = (low + high) / 2;
			const point = this.getPointAtLength(mid);
			if (Math.abs(point.x - targetX) < Math.abs(best.x - targetX)) best = point;
			if (point.x < targetX) low = mid;
			else high = mid;
		}
		return best;
	}
	destroy() {
		this.svg?.parentNode?.removeChild(this.svg);
	}
}

class GjjSplineEditor {
	constructor(node, container) {
		this.node = node;
		this.container = container;
		this.coordWidth = Math.max(8, getNumberWidget(node, WIDTH_WIDGET, 512));
		this.coordHeight = Math.max(8, getNumberWidget(node, HEIGHT_WIDGET, 512));
		this.activeSplineIndex = 0;
		this.hoverIndex = -1;
		this.hoverSplineIndex = -1;
		this.drag = null;
		this.showSamples = false;
		this.showControlLines = false;
		this.sampledCoords = [];
		this.sampler = new PathSampler();
		this.buildDom();
		this.loadState();
		this.bindEvents();
		this.layout();
		this.updatePath(true);
	}

	buildDom() {
		this.container.innerHTML = "";
		this.container.className = "gjj-spline-editor";
		this.toolbar = document.createElement("div");
		this.toolbar.className = "gjj-spline-toolbar";
		this.buttons = {
			addSpline: this.makeButton("➕ 曲线", "添加一条新的样条曲线", () => this.addSpline()),
			addPoint: this.makeButton("● 单点", "在当前位置添加一条单点路径", () => this.addSinglePoint()),
			reverse: this.makeButton("⟲ 反向", "反转当前曲线的控制点顺序", () => this.reverseActive()),
			next: this.makeButton("➡ 下一条", "切换到下一条曲线", () => this.nextSpline()),
			samples: this.makeButton("👁 采样", "显示或隐藏采样点", () => {
				this.showSamples = !this.showSamples;
				this.buttons.samples.classList.toggle("on", this.showSamples);
				this.render();
			}),
			handles: this.makeButton("≡ 控制线", "显示或隐藏控制点连线", () => {
				this.showControlLines = !this.showControlLines;
				this.buttons.handles.classList.toggle("on", this.showControlLines);
				this.render();
			}),
			delete: this.makeButton("⌫ 删除", "删除当前曲线；至少保留一条", () => this.deleteActiveSpline()),
			reset: this.makeButton("↻ 重置", "重置当前画布", () => this.resetCanvas()),
		};
		this.toolbar.append(
			this.buttons.addSpline,
			this.buttons.addPoint,
			this.buttons.reverse,
			this.buttons.next,
			this.buttons.samples,
			this.buttons.handles,
			this.buttons.delete,
			this.buttons.reset,
		);

		this.canvasWrap = document.createElement("div");
		this.canvasWrap.className = "gjj-spline-canvas-wrap";
		this.canvas = document.createElement("canvas");
		this.canvas.className = "gjj-spline-canvas";
		this.canvasWrap.appendChild(this.canvas);
		this.ctx = this.canvas.getContext("2d");

		this.status = document.createElement("div");
		this.status.className = "gjj-spline-status";
		this.menu = this.buildMenu();
		document.body.appendChild(this.menu);
		this.container.append(this.toolbar, this.canvasWrap, this.status);
	}

	makeButton(label, title, action) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.title = title;
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("mousedown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			action();
		});
		return button;
	}

	buildMenu() {
		const menu = document.createElement("div");
		menu.className = "gjj-spline-menu";
		const items = [
			["添加新曲线", () => this.addSpline()],
			["添加单点", () => this.addSinglePoint()],
			["下一条曲线", () => this.nextSpline()],
			["反转当前曲线", () => this.reverseActive()],
			["删除当前曲线", () => this.deleteActiveSpline()],
		];
		for (const [label, action] of items) {
			const item = document.createElement("button");
			item.type = "button";
			item.textContent = label;
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.hideMenu();
				action();
			});
			menu.appendChild(item);
		}
		return menu;
	}

	bindEvents() {
		for (const el of [this.container, this.canvas, this.canvasWrap]) {
			for (const eventName of ["pointerdown", "mousedown", "mousemove", "mouseup", "wheel", "dblclick", "contextmenu"]) {
				el.addEventListener(eventName, (event) => event.stopPropagation());
			}
		}
		this.canvas.addEventListener("mousedown", (event) => this.onMouseDown(event));
		this.canvas.addEventListener("mousemove", (event) => this.onMouseMove(event));
		this.canvas.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		this.documentMove = (event) => this.onDocumentMouseMove(event);
		this.documentUp = () => this.onDocumentMouseUp();
		this.outsideClick = (event) => {
			if (!this.menu.contains(event.target)) this.hideMenu();
		};
		document.addEventListener("mousedown", this.outsideClick, true);
	}

	destroy() {
		document.removeEventListener("mousemove", this.documentMove, true);
		document.removeEventListener("mouseup", this.documentUp, true);
		document.removeEventListener("mousedown", this.outsideClick, true);
		this.menu?.parentNode?.removeChild(this.menu);
		this.sampler?.destroy();
	}

	defaultSplines() {
		const h = this.coordHeight;
		const w = this.coordWidth;
		return [{
			points: [
				{ x: 0, y: h },
				{ x: w * 0.4, y: h * 0.45 },
				{ x: w, y: 0 },
			],
			color: COLORS[0],
			name: "曲线 1",
		}];
	}

	normalizeSplines(value) {
		let parsed = safeParseJson(value, null);
		if (!parsed && this.node.properties?.[PROP_POINTS]) {
			parsed = safeParseJson(this.node.properties[PROP_POINTS], null);
		}
		if (!parsed) return this.defaultSplines();
		if (Array.isArray(parsed) && parsed.length && parsed[0]?.points) {
			return parsed.map((spline, index) => ({
				points: this.normalizePoints(spline.points),
				color: spline.color || COLORS[index % COLORS.length],
				name: spline.name || `曲线 ${index + 1}`,
				isSinglePoint: !!spline.isSinglePoint,
			})).filter((spline) => spline.points.length);
		}
		if (Array.isArray(parsed) && parsed.length && parsed[0]?.x !== undefined) {
			return [{
				points: this.normalizePoints(parsed),
				color: COLORS[0],
				name: "曲线 1",
			}];
		}
		return this.defaultSplines();
	}

	normalizePoints(points) {
		if (!Array.isArray(points)) return [];
		return points.map((point) => ({
			...point,
			x: clamp(Number(point?.x || 0), 0, this.coordWidth),
			y: clamp(Number(point?.y || 0), 0, this.coordHeight),
		})).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
	}

	loadState() {
		const stored = getWidgetValue(this.node, POINTS_WIDGET, "");
		this.splines = this.normalizeSplines(stored);
		this.activeSplineIndex = clamp(this.activeSplineIndex, 0, Math.max(0, this.splines.length - 1));
		this.syncHiddenWidgets();
	}

	layout(updateNode = true) {
		const width = Math.max(MIN_NODE_WIDTH - 24, Number(this.node.size?.[0] || MIN_NODE_WIDTH) - 24);
		const ratio = this.coordHeight / Math.max(1, this.coordWidth);
		this.displayWidth = Math.max(260, width);
		this.displayHeight = clamp(Math.round(this.displayWidth * ratio), MIN_CANVAS_HEIGHT, MAX_CANVAS_HEIGHT);
		const dpr = window.devicePixelRatio || 1;
		this.canvas.style.height = `${this.displayHeight}px`;
		this.canvas.width = Math.max(1, Math.round(this.displayWidth * dpr));
		this.canvas.height = Math.max(1, Math.round(this.displayHeight * dpr));
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.render();
		if (updateNode) this.updateNodeSize();
	}

	updateNodeSize() {
		if (this.node.__gjjSplineSizing) return;
		const width = Math.max(MIN_NODE_WIDTH, Number(this.node.size?.[0] || MIN_NODE_WIDTH));
		const height = Math.max(120, Math.ceil(this.container.scrollHeight || 120) + 12);
		const currentHeight = Number(this.node.size?.[1] || 0);
		if (Math.abs(currentHeight - height) > 2 || width !== this.node.size?.[0]) {
			this.node.__gjjSplineSizing = true;
			try {
				this.node.setSize?.([width, height]);
				this.node.properties = this.node.properties || {};
				this.node.properties[PROP_EDITOR_SIZE] = [width, height];
			} finally {
				requestAnimationFrame(() => { this.node.__gjjSplineSizing = false; });
			}
		}
		this.node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	get interpolation() {
		return String(getWidgetValue(this.node, INTERP_WIDGET, "cardinal"));
	}

	get samplingMethod() {
		return String(getWidgetValue(this.node, METHOD_WIDGET, "time"));
	}

	get sampleCount() {
		return Math.max(2, Math.round(getNumberWidget(this.node, SAMPLE_WIDGET, 16)));
	}

	get tension() {
		return getNumberWidget(this.node, TENSION_WIDGET, 0.5);
	}

	onWidgetChanged(name) {
		if (name === WIDTH_WIDGET || name === HEIGHT_WIDGET) {
			this.resizeCoordSpace(
				Math.max(8, getNumberWidget(this.node, WIDTH_WIDGET, this.coordWidth)),
				Math.max(8, getNumberWidget(this.node, HEIGHT_WIDGET, this.coordHeight)),
			);
			return;
		}
		if (name === POINTS_WIDGET) this.loadState();
		this.updatePath(true);
		this.layout(false);
		this.updateNodeSize();
	}

	resizeCoordSpace(nextW, nextH) {
		const oldW = this.coordWidth || nextW;
		const oldH = this.coordHeight || nextH;
		this.coordWidth = nextW;
		this.coordHeight = nextH;
		const sx = nextW / Math.max(1, oldW);
		const sy = nextH / Math.max(1, oldH);
		for (const spline of this.splines) {
			for (const point of spline.points) {
				point.x = clamp(point.x * sx, 0, nextW);
				point.y = clamp(point.y * sy, 0, nextH);
				if (point.h1x !== undefined) {
					point.h1x = clamp(point.h1x * sx, 0, nextW);
					point.h1y = clamp(point.h1y * sy, 0, nextH);
				}
				if (point.h2x !== undefined) {
					point.h2x = clamp(point.h2x * sx, 0, nextW);
					point.h2y = clamp(point.h2y * sy, 0, nextH);
				}
			}
		}
		this.updatePath(true);
		this.layout();
	}

	toCanvas(point) {
		return {
			x: point.x * this.displayWidth / Math.max(1, this.coordWidth),
			y: point.y * this.displayHeight / Math.max(1, this.coordHeight),
		};
	}

	fromEvent(event) {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: clamp((event.clientX - rect.left) * this.coordWidth / Math.max(1, rect.width), 0, this.coordWidth),
			y: clamp((event.clientY - rect.top) * this.coordHeight / Math.max(1, rect.height), 0, this.coordHeight),
		};
	}

	activeSpline() {
		return this.splines[this.activeSplineIndex];
	}

	findPointAt(point) {
		const active = this.activeSpline();
		if (!active?.points) return -1;
		const radius = 13 * Math.max(this.coordWidth / this.displayWidth, this.coordHeight / this.displayHeight);
		for (let i = active.points.length - 1; i >= 0; i -= 1) {
			if (distance(active.points[i], point) <= radius) return i;
		}
		return -1;
	}

	findClosestPair(points, point) {
		if (!points || points.length < 2) return null;
		let best = { index: 1, distance: Infinity };
		for (let i = 1; i < points.length; i += 1) {
			const midpoint = {
				x: (points[i - 1].x + points[i].x) / 2,
				y: (points[i - 1].y + points[i].y) / 2,
			};
			const dist = distance(midpoint, point);
			if (dist < best.distance) best = { index: i, distance: dist };
		}
		return best.index;
	}

	findSplineAt(point) {
		const threshold = 14 * Math.max(this.coordWidth / this.displayWidth, this.coordHeight / this.displayHeight);
		let bestIndex = -1;
		let bestDistance = Infinity;
		for (let index = 0; index < this.splines.length; index += 1) {
			const spline = this.splines[index];
			if (spline.points.length === 1 || spline.isSinglePoint) {
				const dist = distance(spline.points[0], point);
				if (dist < threshold && dist < bestDistance) {
					bestDistance = dist;
					bestIndex = index;
				}
				continue;
			}
			const sampled = this.sampleSpline(index, 96, "path");
			for (const sample of sampled) {
				const dist = distance(sample, point);
				if (dist < threshold && dist < bestDistance) {
					bestDistance = dist;
					bestIndex = index;
				}
			}
		}
		return bestIndex;
	}

	onMouseDown(event) {
		event.preventDefault();
		event.stopPropagation();
		this.hideMenu();
		const point = this.fromEvent(event);
		const active = this.activeSpline();
		if (event.button === 2) {
			const pointIndex = this.findPointAt(point);
			if (active?.points && pointIndex > 0 && pointIndex < active.points.length - 1) {
				active.points.splice(pointIndex, 1);
				this.updatePath(true);
				return;
			}
			this.lastMenuPoint = point;
			this.showMenu(event);
			return;
		}
		if (event.button !== 0) return;
		if (event.shiftKey && active?.points) {
			active.isSinglePoint = false;
			active.points.push(point);
			this.updatePath(true);
			return;
		}
		if (event.ctrlKey && active?.points?.length >= 2) {
			const insertAt = this.findClosestPair(active.points, point);
			if (insertAt !== null) {
				const prev = active.points[insertAt - 1];
				const next = active.points[insertAt];
				active.points.splice(insertAt, 0, { x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 });
				this.updatePath(true);
			}
			return;
		}
		const pointIndex = this.findPointAt(point);
		if (pointIndex >= 0) {
			this.drag = {
				index: pointIndex,
				offset: {
					x: point.x - active.points[pointIndex].x,
					y: point.y - active.points[pointIndex].y,
				},
			};
			document.addEventListener("mousemove", this.documentMove, true);
			document.addEventListener("mouseup", this.documentUp, true);
			return;
		}
		const splineIndex = this.findSplineAt(point);
		if (splineIndex >= 0) {
			this.activeSplineIndex = splineIndex;
			this.updatePath(true);
		}
	}

	onMouseMove(event) {
		const point = this.fromEvent(event);
		if (this.drag) return;
		const pointIndex = this.findPointAt(point);
		const splineIndex = pointIndex < 0 ? this.findSplineAt(point) : -1;
		this.canvas.style.cursor = pointIndex >= 0 ? "move" : splineIndex >= 0 ? "pointer" : "default";
		if (pointIndex !== this.hoverIndex || splineIndex !== this.hoverSplineIndex) {
			this.hoverIndex = pointIndex;
			this.hoverSplineIndex = splineIndex >= 0 && splineIndex !== this.activeSplineIndex ? splineIndex : -1;
			this.render();
		}
	}

	onDocumentMouseMove(event) {
		if (!this.drag) return;
		event.preventDefault();
		const active = this.activeSpline();
		if (!active?.points?.[this.drag.index]) return;
		const point = this.fromEvent(event);
		active.points[this.drag.index] = {
			...active.points[this.drag.index],
			x: clamp(point.x - this.drag.offset.x, 0, this.coordWidth),
			y: clamp(point.y - this.drag.offset.y, 0, this.coordHeight),
		};
		this.render();
	}

	onDocumentMouseUp() {
		if (!this.drag) return;
		this.drag = null;
		document.removeEventListener("mousemove", this.documentMove, true);
		document.removeEventListener("mouseup", this.documentUp, true);
		this.updatePath(true);
	}

	showMenu(event) {
		this.menu.style.left = `${event.clientX}px`;
		this.menu.style.top = `${event.clientY}px`;
		this.menu.style.display = "block";
	}

	hideMenu() {
		if (this.menu) this.menu.style.display = "none";
	}

	addSpline() {
		const index = this.splines.length;
		this.splines.push({
			points: [
				{ x: 0, y: this.coordHeight },
				{ x: this.coordWidth * 0.5, y: this.coordHeight * 0.5 },
				{ x: this.coordWidth, y: 0 },
			],
			color: COLORS[index % COLORS.length],
			name: `曲线 ${index + 1}`,
		});
		this.activeSplineIndex = index;
		this.updatePath(true);
	}

	addSinglePoint() {
		const index = this.splines.length;
		const point = this.lastMenuPoint || { x: this.coordWidth / 2, y: this.coordHeight / 2 };
		this.splines.push({
			points: [{ x: point.x, y: point.y }],
			color: COLORS[index % COLORS.length],
			name: `单点 ${index + 1}`,
			isSinglePoint: true,
		});
		this.activeSplineIndex = index;
		this.updatePath(true);
	}

	reverseActive() {
		const active = this.activeSpline();
		if (!active?.points) return;
		active.points.reverse();
		this.updatePath(true);
	}

	nextSpline() {
		if (!this.splines.length) return;
		this.activeSplineIndex = (this.activeSplineIndex + 1) % this.splines.length;
		this.updatePath(true);
	}

	deleteActiveSpline() {
		if (this.splines.length <= 1) return;
		this.splines.splice(this.activeSplineIndex, 1);
		this.activeSplineIndex = clamp(this.activeSplineIndex, 0, this.splines.length - 1);
		this.updatePath(true);
	}

	resetCanvas() {
		this.splines = this.defaultSplines();
		this.activeSplineIndex = 0;
		this.updatePath(true);
	}

	sampleSpline(index, count, method) {
		const spline = this.splines[index];
		if (!spline?.points?.length) return [];
		if (method === "controlpoints") return spline.points.map((p) => ({ x: p.x, y: p.y }));
		if (spline.points.length === 1 || spline.isSinglePoint) {
			return Array.from({ length: count }, () => ({ x: spline.points[0].x, y: spline.points[0].y }));
		}
		const pathD = Interpolation.buildPathD(spline.points, this.interpolation, this.tension);
		this.sampler.setPath(pathD);
		const pathLength = this.sampler.getTotalLength();
		if (!Number.isFinite(pathLength) || pathLength <= 0) return spline.points.map((p) => ({ x: p.x, y: p.y }));
		const safeCount = Math.max(2, count);
		const result = [];
		if (method === "speed") {
			const positions = spline.points.map((cp) => {
				let bestDistance = Infinity;
				let bestPos = 0;
				for (let i = 0; i <= 100; i += 1) {
					const pos = pathLength * i / 100;
					const point = this.sampler.getPointAtLength(pos);
					const dist = distance(cp, point);
					if (dist < bestDistance) {
						bestDistance = dist;
						bestPos = pos;
					}
				}
				return bestPos;
			}).sort((a, b) => a - b);
			const weights = [];
			let total = 0;
			for (let i = 0; i < positions.length - 1; i += 1) {
				const w = 1 / Math.max(positions[i + 1] - positions[i], 0.0001);
				weights.push(w);
				total += w;
			}
			const cumulative = [];
			let cum = 0;
			for (const w of weights) {
				cum += w / Math.max(total, 0.0001);
				cumulative.push(cum);
			}
			for (let i = 0; i < safeCount; i += 1) {
				const t = i / (safeCount - 1);
				let segment = cumulative.length - 1;
				for (let j = 0; j < cumulative.length; j += 1) {
					if (t <= cumulative[j]) {
						segment = j;
						break;
					}
				}
				const startT = segment > 0 ? cumulative[segment - 1] : 0;
				const endT = cumulative[segment] || 1;
				const localT = endT === startT ? 0 : (t - startT) / (endT - startT);
				const pos = positions[segment] + localT * ((positions[segment + 1] ?? pathLength) - positions[segment]);
				result.push(this.sampler.getPointAtLength(pos));
			}
			return result;
		}
		for (let i = 0; i < safeCount; i += 1) {
			const t = i / (safeCount - 1);
			const point = method === "time"
				? this.sampler.findPointAtX(this.coordWidth * t, pathLength)
				: this.sampler.getPointAtLength(pathLength * t);
			result.push(point);
		}
		if (result.length && spline.points.length > 1) {
			result[result.length - 1].y = spline.points[spline.points.length - 1].y;
		}
		return result;
	}

	updatePath(allDirty = false) {
		if (!this.splines.length) this.splines = this.defaultSplines();
		const method = this.samplingMethod;
		this.sampledCache = this.splines.map((_, index) => this.sampleSpline(index, this.sampleCount, method));
		this.sampledCoords = this.sampledCache[this.activeSplineIndex] || [];
		this.syncHiddenWidgets();
		this.updateStatus();
		this.render();
		if (allDirty) {
			this.node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		}
	}

	syncHiddenWidgets() {
		const pointsJson = JSON.stringify(this.splines);
		const coordsJson = JSON.stringify(this.sampledCache || []);
		setWidgetValue(this.node, POINTS_WIDGET, pointsJson);
		setWidgetValue(this.node, COORDS_WIDGET, coordsJson);
		this.node.properties = this.node.properties || {};
		this.node.properties[PROP_POINTS] = pointsJson;
	}

	updateStatus() {
		const active = this.activeSpline();
		const sampled = this.sampledCoords?.length || 0;
		this.status.textContent = `曲线 ${this.activeSplineIndex + 1} / ${this.splines.length} · 控制点 ${active?.points?.length || 0} · 采样 ${sampled}`;
	}

	setBackgroundBase64(base64) {
		if (!base64) return;
		const img = new Image();
		img.onload = () => {
			this.bgImage = img;
			this.render();
		};
		img.src = `data:image/jpeg;base64,${String(base64).trim()}`;
	}

	render() {
		if (!this.ctx) return;
		const ctx = this.ctx;
		const w = this.displayWidth || this.canvas.clientWidth || 300;
		const h = this.displayHeight || this.canvas.clientHeight || 260;
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = "#081014";
		ctx.fillRect(0, 0, w, h);
		if (this.bgImage) {
			ctx.save();
			ctx.globalAlpha = 0.56;
			ctx.drawImage(this.bgImage, 0, 0, w, h);
			ctx.restore();
		}
		this.drawGrid(ctx, w, h);
		this.drawSplines(ctx);
		this.drawControlPoints(ctx);
		if (this.showSamples) this.drawSamplePoints(ctx);
	}

	drawGrid(ctx, w, h) {
		ctx.save();
		ctx.strokeStyle = "rgba(160,180,190,0.16)";
		ctx.lineWidth = 1;
		for (let i = 1; i < 8; i += 1) {
			const x = w * i / 8;
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, h);
			ctx.stroke();
			const y = h * i / 8;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(w, y);
			ctx.stroke();
		}
		ctx.restore();
	}

	drawSplines(ctx) {
		const sx = this.displayWidth / Math.max(1, this.coordWidth);
		const sy = this.displayHeight / Math.max(1, this.coordHeight);
		for (let index = 0; index < this.splines.length; index += 1) {
			const spline = this.splines[index];
			const active = index === this.activeSplineIndex;
			const hover = index === this.hoverSplineIndex;
			if (!spline.points?.length) continue;
			if (spline.points.length === 1 || spline.isSinglePoint) {
				const p = this.toCanvas(spline.points[0]);
				const r = active ? 8 : 6;
				ctx.fillStyle = spline.color;
				ctx.strokeStyle = "#050809";
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
				ctx.fill();
				ctx.stroke();
				continue;
			}
			const d = Interpolation.buildPathD(spline.points, this.interpolation, this.tension);
			try {
				const path = new Path2D(d);
				ctx.save();
				ctx.scale(sx, sy);
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				ctx.strokeStyle = "#050809";
				ctx.lineWidth = (active ? 6 : hover ? 5 : 4) / Math.min(sx, sy);
				ctx.stroke(path);
				ctx.strokeStyle = spline.color;
				ctx.lineWidth = (active ? 3 : hover ? 2.4 : 1.8) / Math.min(sx, sy);
				ctx.stroke(path);
				ctx.restore();
			} catch (_) {
				ctx.strokeStyle = spline.color;
				ctx.lineWidth = active ? 3 : 2;
				ctx.beginPath();
				const first = this.toCanvas(spline.points[0]);
				ctx.moveTo(first.x, first.y);
				for (let i = 1; i < spline.points.length; i += 1) {
					const p = this.toCanvas(spline.points[i]);
					ctx.lineTo(p.x, p.y);
				}
				ctx.stroke();
			}
		}
	}

	drawControlPoints(ctx) {
		const active = this.activeSpline();
		if (!active?.points?.length) return;
		if (this.showControlLines && active.points.length > 1) {
			ctx.strokeStyle = "rgba(255,255,255,0.38)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			const first = this.toCanvas(active.points[0]);
			ctx.moveTo(first.x, first.y);
			for (let i = 1; i < active.points.length; i += 1) {
				const p = this.toCanvas(active.points[i]);
				ctx.lineTo(p.x, p.y);
			}
			ctx.stroke();
		}
		for (let i = 0; i < active.points.length; i += 1) {
			const p = this.toCanvas(active.points[i]);
			const hovered = i === this.hoverIndex;
			ctx.fillStyle = hovered ? "rgba(255,255,255,0.34)" : "rgba(80,110,125,0.36)";
			ctx.strokeStyle = hovered ? "#ffd166" : active.color;
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(p.x, p.y, hovered ? 12 : 10, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
		}
	}

	drawSamplePoints(ctx) {
		ctx.fillStyle = "#ff4f5e";
		ctx.strokeStyle = "#050809";
		ctx.lineWidth = 1;
		for (const point of this.sampledCoords || []) {
			const p = this.toCanvas(point);
			ctx.beginPath();
			ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
		}
	}
}

function createContainer(node) {
	ensureStyles();
	const container = document.createElement("div");
	container.className = "gjj-spline-editor";
	const widgetInstance = node.addDOMWidget?.(DOM_WIDGET, "GJJ 样条曲线编辑器", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widgetInstance) {
		widgetInstance.computeSize = (width) => [
			Math.max(MIN_NODE_WIDTH, Number(width || node.size?.[0] || MIN_NODE_WIDTH)),
			Math.max(120, Math.ceil(container.scrollHeight || 120)),
		];
		widgetInstance.getHeight = () => Math.max(120, Math.ceil(container.scrollHeight || 120));
	}
	node.__gjjSplineDomWidget = widgetInstance;
	node.__gjjSplineContainer = container;
	return container;
}

function ensureEditor(node) {
	if (!node || node.__gjjSplineEditor) return;
	collapseWidget(widget(node, POINTS_WIDGET));
	collapseWidget(widget(node, COORDS_WIDGET));
	for (const name of [POINTS_WIDGET, WIDTH_WIDGET, HEIGHT_WIDGET, SAMPLE_WIDGET, METHOD_WIDGET, INTERP_WIDGET, TENSION_WIDGET]) {
		patchWidgetCallback(node, name);
	}
	if (node.properties?.[PROP_POINTS] && !getWidgetValue(node, POINTS_WIDGET, "")) {
		setWidgetValue(node, POINTS_WIDGET, node.properties[PROP_POINTS]);
	}
	const container = node.__gjjSplineContainer || createContainer(node);
	node.__gjjSplineEditor = new GjjSplineEditor(node, container);
	const savedSize = node.properties?.[PROP_EDITOR_SIZE];
	const width = Array.isArray(savedSize) ? Number(savedSize[0]) : Number(node.size?.[0] || MIN_NODE_WIDTH);
	if (Number.isFinite(width) && width > 0) {
		node.setSize?.([Math.max(MIN_NODE_WIDTH, width), Math.max(Number(node.size?.[1] || 0), 420)]);
	}
	requestAnimationFrame(() => {
		node.__gjjSplineEditor?.layout();
	});
}

function scheduleEnsure(node, delay = 0) {
	clearTimeout(node.__gjjSplineTimer);
	node.__gjjSplineTimer = setTimeout(() => ensureEditor(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.SplineEditor",
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
			if (props[PROP_POINTS]) {
				this.properties[PROP_POINTS] = props[PROP_POINTS];
				setWidgetValue(this, POINTS_WIDGET, props[PROP_POINTS]);
			}
			if (Array.isArray(props[PROP_EDITOR_SIZE])) {
				this.properties[PROP_EDITOR_SIZE] = props[PROP_EDITOR_SIZE];
			}
			scheduleEnsure(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			this.__gjjSplineEditor?.syncHiddenWidgets();
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[PROP_POINTS] = getWidgetValue(this, POINTS_WIDGET, "");
				serializedNode.properties[PROP_EDITOR_SIZE] = [
					Number(this.size?.[0] || MIN_NODE_WIDTH),
					Number(this.size?.[1] || 420),
				];
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjSplineSizing) {
				this.properties = this.properties || {};
				this.properties[PROP_EDITOR_SIZE] = [
					Number(this.size?.[0] || MIN_NODE_WIDTH),
					Number(this.size?.[1] || 420),
				];
			}
			this.__gjjSplineEditor?.layout(false);
			return result;
		};

		const originalOnRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			this.__gjjSplineEditor?.destroy();
			this.__gjjSplineEditor = null;
			return originalOnRemoved?.apply(this, args);
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === TARGET) scheduleEnsure(node, 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET) scheduleEnsure(node, 0);
		}
	},
});

api.addEventListener("executed", (event) => {
	const node = findNodeById(eventNodeId(event));
	if (node?.comfyClass !== TARGET) return;
	const output = event?.detail?.output || event?.detail || {};
	const bg = Array.isArray(output.bg_image) ? output.bg_image[0] : null;
	if (bg) node.__gjjSplineEditor?.setBackgroundBase64(bg);
});

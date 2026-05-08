import { GJJ_Utils, queueNode } from "./gjj_utils.js";
const { app } = window.comfyAPI.app;

// ─── Constants ───
const NODE_NAME = "GJJ_AudioTimestampEditor";
const CANVAS_HEIGHT = 140;
const RULER_HEIGHT = 24;
const BLOCK_Y = RULER_HEIGHT + 4;
const BLOCK_H = 56;
const HANDLE_HIT_PX = 6;
const MIN_DURATION = 0.01;

const HIDDEN_WIDGET_NAMES = [
	"segments_json",
	"preview_text",
	"preview_kind",
	"preview_audio",
	"preview_sample_rate",
	"segment_count",
];

const SEGMENT_COLORS = [
	"#4f8edc", "#e07b3a", "#5cb85c", "#d9534f", "#9b6cd6",
	"#a07060", "#e377c2", "#7f7f7f", "#c4c447", "#3fbac4",
];

function clamp(v, min, max) {
	return Math.max(min, Math.min(max, v));
}

function pickColor(existingColors) {
	for (const c of SEGMENT_COLORS) {
		if (!existingColors.has(c)) return c;
	}

	const idx = existingColors.size;
	const hue = (idx * 137.508) % 360;
	return `hsl(${hue.toFixed(0)}, 55%, 55%)`;
}

function refreshNodeCanvas(node) {
	if (!node) return;

	try {
		node.setDirtyCanvas?.(true, true);
	} catch (_) {}

	try {
		node.graph?.setDirtyCanvas?.(true, true);
	} catch (_) {}

	try {
		app.graph?.setDirtyCanvas?.(true, true);
	} catch (_) {}

	try {
		app.canvas?.setDirty?.(true, true);
	} catch (_) {}
}

function isExecutionOutputNode(node) {
	if (!node) return false;

	if (node === undefined || node === null) return false;

	if (node.comfyClass === NODE_NAME) return true;

	if (node.constructor?.nodeData?.output_node === true) return true;
	if (node.nodeData?.output_node === true) return true;
	if (node.flags?.output === true) return true;

	return false;
}

async function queueOnlyCurrentNode(node) {
	if (!node || !node.graph) return false;

	const graph = node.graph || app.graph;
	const allNodes = graph?._nodes || app.graph?._nodes || [];

	const savedModes = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;

	try {
		for (const n of allNodes) {
			if (!n || n === node) continue;

			if (isExecutionOutputNode(n)) {
				savedModes.push([n, n.mode]);
				n.mode = 2;
			}
		}

		if (app.canvas) {
			app.canvas.selected_nodes = {};
			app.canvas.selected_nodes[node.id] = node;
			app.canvas.selected_node = node;
		}

		refreshNodeCanvas(node);

		if (typeof app.queuePrompt === "function") {
			await app.queuePrompt(0, 1);
			return true;
		}

		console.warn("[GJJ] app.queuePrompt 不存在，无法只刷新当前节点");
		return false;
	} finally {
		for (const [n, mode] of savedModes) {
			n.mode = mode;
		}

		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}

		refreshNodeCanvas(node);
	}
}

function hideWidget(w) {
	if (!w) return;

	if (!w.__gjjAudioSegHiddenState) {
		w.__gjjAudioSegHiddenState = {
			type: w.type,
			draw: w.draw,
			computeSize: w.computeSize,
		};
	}

	w.type = "hidden";
	w.hidden = true;
	w.draw = () => {};
	w.computeSize = () => [0, -4];

	if (w.inputEl?.style) {
		w.inputEl.style.display = "none";
	}

	if (w.element?.style) {
		w.element.style.display = "none";
	}
}

// ─── Parsing ───
function parseSegments(text) {
	try {
		const parsed = JSON.parse(text);

		if (Array.isArray(parsed)) {
			return parsed.filter(s => {
				return typeof s === "object" && s !== null && ("start" in s || "end" in s);
			});
		}

		return [];
	} catch (e) {
		return [];
	}
}

function audioDataToUrl(previewAudio) {
	if (!previewAudio || !Array.isArray(previewAudio) || previewAudio.length === 0) {
		return null;
	}

	const data = previewAudio[0];

	if (!data?.filename) return null;

	return `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type || "temp"}&subfolder=${data.subfolder || ""}`;
}

// ─── AudioSegmentEditorWidget ───
class AudioSegmentEditorWidget {
	constructor(node, container) {
		this.node = node;
		this.container = container;

		this.segments = [];
		this.duration = 0;
		this.sampleRate = 44100;
		this.audioBuffer = null;

		this.selectedIndex = 0;
		this.hoverIndex = -1;
		this.hoverHandle = -1;
		this.dragHandle = -1;
		this.dragStart = null;
		this.dragBaseline = null;

		this._displayedX = new Map();
		this._targetX = new Map();
		this._animRaf = null;

		this.buildDOM();
		this.bindEvents();
		this.resizeCanvas();
	}

	getMaxDuration() {
		return Math.max(MIN_DURATION, this.duration || 60);
	}

	formatTime(seconds) {
		if (seconds === undefined || seconds === null) return "0.0";

		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;

		if (mins > 0) {
			return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
		}

		return `${secs.toFixed(1)}`;
	}

	buildDOM() {
		this.container.innerHTML = "";
		this.container.style.cssText = `
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 6px 8px;
			box-sizing: border-box;
			font-family: sans-serif;
			font-size: 11px;
			color: #ddd;
			width: 100%;
		`;

		const audioPlayerContainer = document.createElement("div");
		audioPlayerContainer.style.cssText = `
			width: 100%;
			height: 60px;
			border-radius: 4px;
			overflow: hidden;
			background: #111;
			position: relative;
			flex-shrink: 0;
			display: flex;
			align-items: center;
			justify-content: center;
		`;
		this.container.appendChild(audioPlayerContainer);

		this.audioPlayer = document.createElement("audio");
		this.audioPlayer.controls = true;
		this.audioPlayer.style.cssText = `
			width: 100%;
			height: 100%;
			background: #000;
		`;
		audioPlayerContainer.appendChild(this.audioPlayer);

		this.canvas = document.createElement("canvas");
		this.canvas.style.cssText = `
			width: 100%;
			height: ${CANVAS_HEIGHT}px;
			display: block;
			background: #1a1a1a;
			border-radius: 4px;
			cursor: default;
			flex-shrink: 0;
		`;
		this.container.appendChild(this.canvas);

		this.ctx = this.canvas.getContext("2d");

		const infoRow = document.createElement("div");
		infoRow.style.cssText = `
			display: flex;
			gap: 12px;
			align-items: center;
			font-size: 10px;
			color: #888;
		`;

		this.durationLabel = document.createElement("span");
		this.durationLabel.textContent = "时长: --";

		this.sampleRateLabel = document.createElement("span");
		this.sampleRateLabel.textContent = "";

		infoRow.appendChild(this.durationLabel);
		infoRow.appendChild(this.sampleRateLabel);
		this.container.appendChild(infoRow);

		const row = document.createElement("div");
		row.style.cssText = `
			display: flex;
			gap: 6px;
			align-items: center;
			flex-wrap: wrap;
		`;

		this.addBtn = this.makeButton("+ 添加", "在末尾添加一个新分段");
		this.distributeBtn = this.makeButton("均分", "将所有分段均匀分布到整个时长");
		this.deleteBtn = this.makeButton("删除", "删除当前选中的分段（至少保留1个）");
		this.refreshBtn = this.makeButton("🔄 刷新", "只刷新当前音频分段节点");

		this.totalLabel = document.createElement("span");
		this.totalLabel.style.cssText = `
			color: #888;
			margin-left: 4px;
			flex: 1;
			text-align: right;
		`;
		this.totalLabel.textContent = "合计: --";

		row.appendChild(this.addBtn);
		row.appendChild(this.distributeBtn);
		row.appendChild(this.deleteBtn);
		row.appendChild(this.refreshBtn);
		row.appendChild(this.totalLabel);

		this.container.appendChild(row);
	}

	makeButton(label, tooltip) {
		const b = document.createElement("button");

		b.textContent = label;

		if (tooltip) {
			b.title = tooltip;
		}

		b.style.cssText = `
			background: #3a3a3a;
			color: #eee;
			border: 1px solid #555;
			border-radius: 3px;
			padding: 3px 10px;
			cursor: pointer;
			font-size: 11px;
		`;

		b.addEventListener("mouseenter", () => {
			if (!b.disabled) b.style.background = "#4a4a4a";
		});

		b.addEventListener("mouseleave", () => {
			if (!b.disabled) b.style.background = "#3a3a3a";
		});

		return b;
	}

	bindEvents() {
		this.canvas.addEventListener("pointerdown", e => {
			e.stopPropagation();
			this.onPointerDown(e);
		});

		this.canvas.addEventListener("pointermove", e => {
			e.stopPropagation();
			this.onPointerMove(e);
		});

		this.canvas.addEventListener("pointerup", e => {
			e.stopPropagation();
			this.onPointerUp(e);
		});

		this.canvas.addEventListener("contextmenu", e => {
			e.preventDefault();
			e.stopPropagation();
		});

		this.canvas.addEventListener("wheel", e => {
			e.stopPropagation();
		}, {
			passive: true,
		});

		this.canvas.addEventListener("pointerleave", () => {
			if (this.dragHandle < 0) {
				this.hoverIndex = -1;
				this.hoverHandle = -1;
				this.canvas.style.cursor = "default";
				this.render();
			}
		});

		this.addBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.addBtn.addEventListener("click", () => this.addSegment());

		this.distributeBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.distributeBtn.addEventListener("click", () => this.distributeEvenly());

		this.deleteBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.deleteBtn.addEventListener("click", () => this.deleteSelected());

		this.refreshBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.refreshBtn.addEventListener("click", () => this.refreshAudio());

		this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
		this.resizeObserver.observe(this.container);
	}

	resizeCanvas() {
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(50, Math.floor(this.canvas.offsetWidth));

		this.canvas.width = w * dpr;
		this.canvas.height = CANVAS_HEIGHT * dpr;

		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		this._cssWidth = w;

		this.render();
	}

	// ─── Layout ───
	pxPerSecond() {
		const max = this.getMaxDuration();
		return max > 0 ? this._cssWidth / max : 1;
	}

	segmentRects() {
		const rects = [];
		let cursor = 0;
		const pps = this.pxPerSecond();

		for (let i = 0; i < this.segments.length; i++) {
			const seg = this.segments[i];
			const startSec = seg.start || 0;
			const endSec = seg.end || startSec + MIN_DURATION;
			const len = Math.max(MIN_DURATION, endSec - startSec);

			rects.push({
				index: i,
				x: cursor * pps,
				w: len * pps,
				startSec,
				endSec: startSec + len,
			});

			cursor += len;
		}

		return rects;
	}

	hitBoundary(mx) {
		const rects = this.segmentRects();

		for (let i = 0; i < rects.length; i++) {
			const right = rects[i].x + rects[i].w;

			if (Math.abs(mx - right) <= HANDLE_HIT_PX) {
				return i;
			}
		}

		return -1;
	}

	hitBlock(mx, my) {
		if (my < RULER_HEIGHT) return -1;

		const rects = this.segmentRects();

		for (const r of rects) {
			if (mx >= r.x && mx < r.x + r.w) {
				return r.index;
			}
		}

		return -1;
	}

	localPos(e) {
		const rect = this.canvas.getBoundingClientRect();
		const sx = rect.width / this.canvas.offsetWidth || 1;
		const sy = rect.height / this.canvas.offsetHeight || 1;

		return {
			x: (e.clientX - rect.left) / sx,
			y: (e.clientY - rect.top) / sy,
		};
	}

	// ─── Pointer Events ───
	onPointerDown(e) {
		const { x, y } = this.localPos(e);
		const handle = this.hitBoundary(x);

		if (handle >= 0) {
			this.dragHandle = handle;
			this.dragBaseline = this.segments.map(s => ({
				start: s.start || 0,
				end: s.end || 0,
			}));
			this.dragStart = { x };

			try {
				this.canvas.setPointerCapture(e.pointerId);
			} catch (_) {}

			return;
		}

		const block = this.hitBlock(x, y);

		if (block >= 0) {
			this.selectedIndex = block;
			this.render();
			return;
		}

		this.selectedIndex = -1;
		this.render();
	}

	onPointerMove(e) {
		const { x, y } = this.localPos(e);

		if (this.dragHandle >= 0) {
			const pps = this.pxPerSecond();
			const dx = (x - this.dragStart.x) / pps;
			const handle = this.dragHandle;
			const baseline = this.dragBaseline;

			for (let i = 0; i < this.segments.length; i++) {
				this.segments[i].start = baseline[i].start;
				this.segments[i].end = baseline[i].end;
			}

			this._shiftBoundary(handle, dx);
			this._ensureMinDuration();
			this.commit();
			this.updateTotalLabel();
			this.render();

			return;
		}

		const handle = this.hitBoundary(x);
		const block = handle >= 0 ? -1 : this.hitBlock(x, y);

		if (handle !== this.hoverHandle || block !== this.hoverIndex) {
			this.hoverHandle = handle;
			this.hoverIndex = block;
			this.canvas.style.cursor = handle >= 0 ? "ew-resize" : block >= 0 ? "pointer" : "default";
			this.render();
		}
	}

	onPointerUp(e) {
		if (this.dragHandle >= 0) {
			try {
				this.canvas.releasePointerCapture(e.pointerId);
			} catch (_) {}

			this.dragHandle = -1;
			this.dragStart = null;
			this.dragBaseline = null;
			this.render();
		}
	}

	// ─── Boundary Drag Logic ───
	_shiftBoundary(handle, deltaSec) {
		const segA = this.segments[handle];
		const segB = this.segments[handle + 1];

		if (!segA || !segB) return;

		const max = this.getMaxDuration();

		const aStart = segA.start || 0;
		const bEnd = segB.end || max;

		const minAEnd = aStart + MIN_DURATION;
		const maxBStart = bEnd - MIN_DURATION;
		const proposed = (segA.end || 0) + deltaSec;
		const clamped = clamp(proposed, minAEnd, maxBStart);

		segA.end = clamped;
		segB.start = clamped;
	}

	_ensureMinDuration() {
		for (let i = 0; i < this.segments.length; i++) {
			const seg = this.segments[i];

			if ((seg.end || 0) - (seg.start || 0) < MIN_DURATION) {
				seg.end = (seg.start || 0) + MIN_DURATION;
			}
		}
	}

	// ─── Mutations ───
	addSegment() {
		const max = this.getMaxDuration();
		const n = this.segments.length;

		const last = this.segments[n - 1];
		const lastEnd = last ? last.end || max : 0;
		const remaining = max - lastEnd;

		if (remaining < MIN_DURATION) {
			if (last && last.end - last.start > MIN_DURATION * 2) {
				last.end -= MIN_DURATION;
			} else {
				return;
			}
		}

		const newStart = last ? last.end || 0 : 0;
		const newEnd = Math.min(max, newStart + Math.max(MIN_DURATION, remaining / 2));

		const usedColors = new Set(this.segments.map(s => s.color).filter(Boolean));

		this.segments.push({
			start: parseFloat(newStart.toFixed(3)),
			end: parseFloat(newEnd.toFixed(3)),
			label: `片段 ${n + 1}`,
			color: pickColor(usedColors),
		});

		this.selectedIndex = this.segments.length - 1;

		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	distributeEvenly() {
		const max = this.getMaxDuration();
		const n = this.segments.length;

		if (n === 0) return;

		const each = max / n;

		for (let i = 0; i < n; i++) {
			this.segments[i].start = parseFloat((i * each).toFixed(3));
			this.segments[i].end = parseFloat(((i + 1) * each).toFixed(3));

			if (!this.segments[i].label) {
				this.segments[i].label = `片段 ${i + 1}`;
			}

			if (!this.segments[i].color) {
				this.segments[i].color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
			}
		}

		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	deleteSelected() {
		if (this.segments.length <= 1) return;
		if (this.selectedIndex < 0 || this.selectedIndex >= this.segments.length) return;

		if (this.selectedIndex > 0 && this.selectedIndex < this.segments.length) {
			const prev = this.segments[this.selectedIndex - 1];
			const deleted = this.segments[this.selectedIndex];
			prev.end = deleted.end || prev.end;
		}

		this.segments.splice(this.selectedIndex, 1);
		this.selectedIndex = clamp(this.selectedIndex, 0, this.segments.length - 1);

		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	// ─── Persistence ───
	commit() {
		this._syncSegmentsJSON();
		this._syncProperties();
		this.node.graph?.setDirtyCanvas?.(true, true);
		this.syncOutputs();
	}

	_syncSegmentsJSON() {
		const widget = this.node.widgets?.find(w => w.name === "segments_json");

		if (widget) {
			widget.value = JSON.stringify(this.segments);

			if (widget.callback) {
				try {
					widget.callback(widget.value);
				} catch (_) {}
			}
		}
	}

	_syncProperties() {
		if (!this.node.properties) {
			this.node.properties = {};
		}

		this.node.properties.segments = JSON.stringify(this.segments);

		refreshNodeCanvas(this.node);
	}

	syncOutputs() {
		const targetCount = Math.max(1, this.segments.length);
		stabilizeNode(this, targetCount);
	}

	updateTotalLabel() {
		const rects = this.segmentRects();
		let total = 0;

		for (const r of rects) {
			total += r.endSec - r.startSec;
		}

		const max = this.getMaxDuration();

		this.totalLabel.textContent = `合计: ${this.formatTime(total)} / ${this.formatTime(max)}`;
	}

	// ─── Public API ───
	setSegments(segments) {
		this.segments = (segments || []).map((s, i) => ({
			start: parseFloat((s.start || 0).toFixed(3)),
			end: parseFloat((s.end || 0).toFixed(3)),
			label: s.label || `片段 ${i + 1}`,
			color: s.color || SEGMENT_COLORS[i % SEGMENT_COLORS.length],
		}));

		this.selectedIndex = this.segments.length > 0 ? 0 : -1;

		this.updateTotalLabel();
		this.render();
	}

	async refreshAudio() {
		if (!this.node || !this.node.graph) return;

		console.log("[GJJ] 刷新音频预览: 只执行当前节点");

		const btn = this.refreshBtn;
		const originalText = btn.textContent;

		try {
			btn.textContent = "🔄 刷新中...";
			btn.disabled = true;
			btn.style.cursor = "not-allowed";
			btn.style.opacity = "0.65";

			this._syncSegmentsJSON();
			this._syncProperties();

			const ok = await queueOnlyCurrentNode(this.node);

			if (!ok) {
				console.warn("[GJJ] 当前节点刷新失败：queueOnlyCurrentNode 返回 false");
			}
		} catch (err) {
			console.error("[GJJ] 刷新音频失败:", err);
			alert("刷新失败，请检查控制台错误信息");
		} finally {
			setTimeout(() => {
				btn.textContent = originalText;
				btn.disabled = false;
				btn.style.cursor = "pointer";
				btn.style.opacity = "1";
			}, 500);
		}
	}

	loadAudio(url) {
		if (!url) {
			this.audioBuffer = null;
			this.audioPlayer.src = "";
			this.render();
			return;
		}

		this.audioPlayer.src = url;

		try {
			const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

			fetch(url)
				.then(res => res.arrayBuffer())
				.then(buf => audioCtx.decodeAudioData(buf))
				.then(audioBuffer => {
					this.audioBuffer = audioBuffer;
					this.render();
				})
				.catch(err => {
					console.warn("[GJJ] 音频加载失败:", err);
					this.audioBuffer = null;
					this.render();
				});
		} catch (e) {
			console.warn("[GJJ] Web Audio API 不可用:", e);
			this.render();
		}
	}

	serialize() {
		return JSON.stringify(this.segments);
	}

	generateAutoSegments() {
		const countWidget = this.node.widgets?.find(w => w.name === "segment_count");
		const count = parseInt(countWidget?.value || 4) || 4;
		const max = this.getMaxDuration();
		const each = max / count;

		this.segments = [];

		for (let i = 0; i < count; i++) {
			this.segments.push({
				start: parseFloat((i * each).toFixed(3)),
				end: parseFloat(((i + 1) * each).toFixed(3)),
				label: `片段 ${i + 1}`,
				color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
			});
		}

		this.selectedIndex = 0;

		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	// ─── Render ───
	render() {
		const rects = this.segmentRects();

		this._targetX = new Map();

		for (const r of rects) {
			this._targetX.set(r.index, r.x);
		}

		for (const [idx, target] of this._targetX) {
			this._displayedX.set(idx, target);
		}

		this._draw();
	}

	_draw() {
		const ctx = this.ctx;
		const w = this._cssWidth;

		ctx.clearRect(0, 0, w, CANVAS_HEIGHT);

		this._drawRuler(ctx, w);
		this._drawWaveformBackground(ctx, w);
		this._drawSegments(ctx, w);
	}

	_drawRuler(ctx, w) {
		const max = this.getMaxDuration();
		const pps = this.pxPerSecond();

		ctx.fillStyle = "#222";
		ctx.fillRect(0, 0, w, RULER_HEIGHT);

		const targetSpacing = 60;
		const niceIntervals = [
			0.1, 0.2, 0.25, 0.5,
			1, 2, 5, 10, 15,
			30, 60, 120, 300,
		];

		let step = niceIntervals[niceIntervals.length - 1];

		for (const s of niceIntervals) {
			if (s * pps >= targetSpacing) {
				step = s;
				break;
			}
		}

		ctx.strokeStyle = "#444";
		ctx.fillStyle = "#aaa";
		ctx.font = "10px sans-serif";
		ctx.textBaseline = "top";
		ctx.lineWidth = 1;

		for (let t = 0; t <= max; t += step) {
			const x = Math.floor(t * pps) + 0.5;

			ctx.beginPath();
			ctx.moveTo(x, RULER_HEIGHT - 6);
			ctx.lineTo(x, RULER_HEIGHT);
			ctx.stroke();

			ctx.fillText(this.formatTime(t), x + 2, 2);
		}

		const xMax = Math.floor(max * pps) - 0.5;

		ctx.strokeStyle = "#666";
		ctx.beginPath();
		ctx.moveTo(xMax, 0);
		ctx.lineTo(xMax, RULER_HEIGHT);
		ctx.stroke();
	}

	_drawWaveformBackground(ctx, w) {
		if (!this.audioBuffer) return;

		const data = this.audioBuffer.getChannelData(0);
		const pps = this.pxPerSecond();
		const sampleRate = this.audioBuffer.sampleRate;
		const samplesPerPixel = Math.max(1, Math.floor(sampleRate / pps));

		const midY = BLOCK_Y + BLOCK_H / 2;
		const amp = BLOCK_H / 2 - 4;

		ctx.strokeStyle = "rgba(0, 220, 130, 0.35)";
		ctx.lineWidth = 0.8;
		ctx.beginPath();

		let first = true;

		for (let px = 0; px < w; px++) {
			const startSample = Math.floor(px * samplesPerPixel);
			const endSample = Math.min(startSample + samplesPerPixel, data.length);

			let min = Infinity;
			let max = -Infinity;

			for (let s = startSample; s < endSample; s++) {
				if (data[s] < min) min = data[s];
				if (data[s] > max) max = data[s];
			}

			const yMin = midY + min * amp;
			const yMax = midY + max * amp;

			if (first) {
				ctx.moveTo(px, yMin);
				first = false;
			}

			ctx.lineTo(px, yMin);
			ctx.lineTo(px, yMax);
		}

		ctx.stroke();
	}

	_drawSegments(ctx, w) {
		const rects = this.segmentRects();

		for (const r of rects) {
			const seg = this.segments[r.index];
			const color = seg.color || SEGMENT_COLORS[r.index % SEGMENT_COLORS.length];

			const isSelected = r.index === this.selectedIndex;
			const isHover = r.index === this.hoverIndex;

			const drawX = Math.floor(this._displayedX.get(r.index) ?? r.x);
			const drawW = Math.max(4, Math.floor(r.w));

			ctx.fillStyle = color;
			ctx.globalAlpha = isSelected ? 0.35 : isHover ? 0.30 : 0.20;
			ctx.fillRect(drawX, BLOCK_Y, drawW, BLOCK_H);
			ctx.globalAlpha = 1.0;

			ctx.strokeStyle = isSelected ? "#fff" : isHover ? "#ddd" : "rgba(255,255,255,0.3)";
			ctx.lineWidth = isSelected ? 2 : 1;
			ctx.strokeRect(drawX + 0.5, BLOCK_Y + 0.5, drawW - 1, BLOCK_H - 1);

			const label = seg.label || `片段 ${r.index + 1}`;

			ctx.fillStyle = "#fff";
			ctx.font = "11px sans-serif";
			ctx.textBaseline = "top";
			ctx.fillText(label, drawX + 4, BLOCK_Y + 4);

			ctx.fillStyle = "rgba(255,255,255,0.7)";
			ctx.font = "10px monospace";

			const range = `${this.formatTime(r.startSec)} – ${this.formatTime(r.endSec)}`;
			ctx.fillText(range, drawX + 4, BLOCK_Y + BLOCK_H - 16);

			const dur = r.endSec - r.startSec;
			ctx.fillText(`${dur.toFixed(1)}s`, drawX + 4, BLOCK_Y + BLOCK_H - 4);
		}

		for (let i = 0; i < rects.length; i++) {
			const r = rects[i];
			const drawX = this._displayedX.get(r.index) ?? r.x;
			const right = Math.floor(drawX + r.w);
			const isHover = i === this.hoverHandle || i === this.dragHandle;

			ctx.fillStyle = isHover ? "#fff" : "rgba(255,255,255,0.4)";
			ctx.fillRect(right - 2, BLOCK_Y + 4, 4, BLOCK_H - 8);
		}
	}

	destroy() {
		this.resizeObserver?.disconnect();

		if (this._animRaf) {
			cancelAnimationFrame(this._animRaf);
		}
	}
}

// ─── Dynamic Output Management ───
const OUTPUT_DISPLAY_PREFIX = "音频片段";
const SEGMENT_LIST_NAME = "分段列表";
const MIN_VISIBLE_OUTPUTS = 2;
const SEGMENT_LIST_SLOT = 0;

function formatOutputName(index) {
	return `${OUTPUT_DISPLAY_PREFIX}${index}`;
}

function getOutputIndex(name) {
	const text = String(name || "");

	if (text === SEGMENT_LIST_NAME) {
		return SEGMENT_LIST_SLOT;
	}

	if (!text.startsWith(OUTPUT_DISPLAY_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}

	return Number.parseInt(text.slice(OUTPUT_DISPLAY_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getAudioOutputs(node) {
	return getOutputs(node).filter(o => o.name !== SEGMENT_LIST_NAME);
}

function getOutputs(node) {
	return Array.isArray(node?.outputs)
		? [...node.outputs].sort((a, b) => getOutputIndex(a?.name) - getOutputIndex(b?.name))
		: [];
}

function setDirty(node) {
	refreshNodeCanvas(node);
}

function addDynamicOutput(node, type = "AUDIO", name = null, slot = null) {
	const outputName = name || formatOutputName(1);

	if (slot !== null && slot >= 0 && slot < node.outputs.length) {
		node.addOutput(outputName, type, slot);
	} else {
		node.addOutput(outputName, type);
	}
}

function removeUnusedOutputsFromEnd(node, minOutputs = MIN_VISIBLE_OUTPUTS) {
	const outputs = getOutputs(node);

	for (let i = outputs.length - 1; i >= minOutputs; i--) {
		const output = outputs[i];

		if (output?.links && output.links.length > 0) {
			break;
		}

		if (output?.name === SEGMENT_LIST_NAME) {
			continue;
		}

		const slotIndex = node.outputs.indexOf(output);

		if (slotIndex >= 0) {
			node.removeOutput(slotIndex);
		}
	}
}

function renameOutputsSequentially(node, segmentCount) {
	let audioIdx = 0;

	for (const output of node.outputs || []) {
		if (!output) continue;

		if (output.name === SEGMENT_LIST_NAME) {
			output.type = "STRING";
			output.label = SEGMENT_LIST_NAME;
			output.localized_name = output.label;
		} else if (audioIdx < segmentCount) {
			audioIdx++;
			output.name = formatOutputName(audioIdx);
			output.type = "AUDIO";
			output.label = formatOutputName(audioIdx);
			output.localized_name = output.label;
		}
	}
}

function ensureLeadingSegmentListOutput(node) {
	const outputs = getOutputs(node);

	if (outputs.length === 0) {
		addDynamicOutput(node, "STRING", SEGMENT_LIST_NAME, 0);
		addDynamicOutput(node, "AUDIO", formatOutputName(1));
		return;
	}

	const firstOutput = outputs[0];

	if (firstOutput?.name !== SEGMENT_LIST_NAME) {
		addDynamicOutput(node, "STRING", SEGMENT_LIST_NAME, 0);
	}
}

function stabilizeNode(node, segmentCount) {
	if (!node) return;

	const actualCount = Math.max(1, segmentCount || 1);
	const targetOutputs = actualCount + 1;

	ensureLeadingSegmentListOutput(node);

	const audioOutputs = getAudioOutputs(node);

	for (let i = audioOutputs.length; i < actualCount; i++) {
		addDynamicOutput(node, "AUDIO", formatOutputName(i + 1));
	}

	removeUnusedOutputsFromEnd(node, targetOutputs);
	renameOutputsSequentially(node, actualCount);
	setDirty(node);

	// 异步更新节点高度，避免 DOM 重排时序问题
	requestAnimationFrame(() => {
		if (!node) return;

		// 保留用户手动调整的宽度
		const currentWidth = Math.max(420, Number(node.size?.[0] || 420));

		// 使用 computeSize 计算新高度
		const computed = node.computeSize?.() || node.size;
		const newHeight = Math.max(320, Number(computed?.[1] || 320));

		// 仅更新高度，保留宽度
		node.setSize?.([currentWidth, newHeight]);
		refreshNodeCanvas(node);
	});
}

function scheduleStabilize(node, segmentCount, ms = 32) {
	clearTimeout(node.__gjjAudioSegmentTimer);

	node.__gjjAudioSegmentTimer = setTimeout(() => {
		stabilizeNode(node, segmentCount);
	}, ms);
}

// ─── Extension Registration ───
app.registerExtension({
	name: "GJJ.AudioSegmentEditor",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		const originalOnExecuted = nodeType.prototype.onExecuted;
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		const originalOnRemoved = nodeType.prototype.onRemoved;
		const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;

		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);

			for (const name of HIDDEN_WIDGET_NAMES) {
				hideWidget(this.widgets?.find(w => w.name === name));
			}

			const audioFileWidget = this.widgets?.find(w => w.name === "audio_file");

			if (audioFileWidget) {
				const origCallback = audioFileWidget.callback;

				audioFileWidget.callback = function (...cbArgs) {
					const cbResult = origCallback?.apply(this, cbArgs);
					return cbResult;
				};
			}

			const container = document.createElement("div");

			this._segmentEditorWidget = this.addDOMWidget(
				"audio_segment_editor_canvas",
				"GJJAudioSegmentEditor",
				container,
				{
					serialize: false,
					hideOnZoom: false,
					getMinHeight: () => 280,
					getHeight: () => {
						// 动态计算高度：优先使用容器的实际 scrollHeight，最小 280
						const domHeight = container?.scrollHeight || container?.offsetHeight || 280;
						return Math.max(280, domHeight);
					},
				}
			);

			const self = this;

			setTimeout(() => {
				try {
					self._editor = new AudioSegmentEditorWidget(self, container);
				} catch (err) {
					console.error("[GJJ] 音频分段编辑器初始化失败:", err);
				}
			}, 0);

			setTimeout(() => {
				stabilizeNode(this, 1);
			}, 10);

			return result;
		};

		nodeType.prototype.onRemoved = function () {
			this._editor?.destroy();
			return originalOnRemoved?.apply(this, arguments);
		};

		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);

			if (!message || !this._editor) {
				return result;
			}

			const previewAudio = message.preview_audio?.[0];
			const duration = message.preview_duration?.[0] || 0;
			const sampleRate = message.preview_sample_rate?.[0] || 44100;
			const segmentsJson = message.preview_segments?.[0] || "[]";
			const segmentCount = message.preview_segment_count?.[0] || 1;

			this._editor.duration = duration;
			this._editor.sampleRate = sampleRate;

			this._editor.durationLabel.textContent = `时长: ${duration.toFixed(1)}s`;
			this._editor.sampleRateLabel.textContent = `采样率: ${sampleRate}Hz`;

			const segments = parseSegments(segmentsJson);

			this._editor.setSegments(
				segments.length > 0
					? segments
					: [
						{
							start: 0,
							end: duration || 60,
							label: "片段 1",
							color: SEGMENT_COLORS[0],
						},
					]
			);

			this._editor.updateTotalLabel();

			const audioUrl = audioDataToUrl(previewAudio);

			if (audioUrl) {
				this._editor.loadAudio(audioUrl);
			} else {
				this._editor.render();
			}

			this.properties = this.properties || {};
			this.properties.segments = this._editor.serialize();

			scheduleStabilize(this, segmentCount);

			return result;
		};

		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			const count = this._editor?.segments?.length;

			if (typeof count === "number" && count > 0) {
				scheduleStabilize(this, count);
			} else {
				scheduleStabilize(this, 1);
			}

			return result;
		};

		nodeType.prototype.getExtraMenuOptions = function (_, options) {
			const result = originalGetExtraMenuOptions?.apply(this, arguments);

			if (this._editor) {
				options.unshift(
					{
						content: "均分",
						callback: () => {
							this._editor.distributeEvenly();
							scheduleStabilize(this, this._editor.segments.length);
						},
					},
					{
						content: "+ 添加分段",
						callback: () => {
							this._editor.addSegment();
							scheduleStabilize(this, this._editor.segments.length);
						},
					},
					{
						content: "删除选中",
						callback: () => {
							this._editor.deleteSelected();
							scheduleStabilize(this, this._editor.segments.length);
						},
					},
					{
						content: "重新生成分段",
						callback: () => {
							this._editor.generateAutoSegments();
							scheduleStabilize(this, this._editor.segments.length);
						},
					},
					{
						content: "只刷新当前节点",
						callback: () => {
							this._editor.refreshAudio();
						},
					}
				);
			}

			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_NAME) {
				stabilizeNode(node, 1);
			}
		}

		// 监听后端发送的运行时错误事件（包含安装命令）
		api.addEventListener("gjj_audio_timestamp_error", (event) => {
			try {
				const data = event.detail || {};
				const nodeId = data.node;
				const errorMessage = data.error || "";
				const installCommand = data.install_command || "";

				if (!nodeId || !errorMessage) return;

				// 查找对应的节点
				const nodes = app.graph?._nodes || [];
				for (const node of nodes) {
					if (String(node.id) === String(nodeId)) {
						// 显示错误信息在节点面板中
						if (node._editor?.statusDisplay) {
							let displayText = `❌ 执行失败：\n\n${errorMessage}`;

							// 如果有安装命令，添加提示
							if (installCommand) {
								displayText += `\n\n🔧 快速安装命令（点击按钮复制）：`;
							}

							node._editor.statusDisplay.textContent = displayText;
							node._editor.statusDisplay.style.color = "#ff6b6b";

							// 显示复制按钮
							if (node._editor.copyBtn) {
								node._editor.copyBtn.style.display = "block";
								node._editor.copyBtn.textContent = "📋 复制安装命令";
								node._editor.copyBtn.title = "复制安装命令到剪贴板";
								node._editor.copyBtn.style.background = "#ff4757";
								node._editor.copyBtn.style.color = "#fff";

								// 更新复制按钮事件，复制安装命令
								const newCopyBtn = node._editor.copyBtn.cloneNode(true);
								node._editor.copyBtn.parentNode.replaceChild(newCopyBtn, node._editor.copyBtn);
								node._editor.copyBtn = newCopyBtn;

								node._editor.copyBtn.addEventListener("click", () => {
									if (installCommand) {
										navigator.clipboard.writeText(installCommand).then(() => {
											const originalText = node._editor.copyBtn.textContent;
											node._editor.copyBtn.textContent = "✅ 已复制";
											node._editor.copyBtn.style.background = "#2ed573";
											setTimeout(() => {
												node._editor.copyBtn.textContent = originalText;
												node._editor.copyBtn.style.background = "#ff4757";
											}, 1500);
										}).catch(err => {
											console.error("[GJJ] 复制失败:", err);
											alert("复制失败，请手动选择安装命令复制");
										});
									}
								});
							}
						}
						break;
					}
				}
			} catch (err) {
				console.error("[GJJ] 处理错误事件失败:", err);
			}
		});
	},
});

import { GJJ_Utils } from "./gjj_utils.js";

const { app } = window.comfyAPI.app;

// ─── Constants ───
const NODE_NAME = "GJJ_VideoSegmentEditor";
const CANVAS_HEIGHT = 140;
const RULER_HEIGHT = 24;
const BLOCK_Y = RULER_HEIGHT + 4;
const BLOCK_H = 56;
const HANDLE_HIT_PX = 6;
const MIN_DURATION = 0.01;
const MIN_VISIBLE_OUTPUTS = 2; // 1个分段列表 + 1个视频片段
const SEGMENT_LIST_NAME = "分段列表";
const HIDDEN_WIDGET_NAMES = ["segments_json", "preview_text", "preview_kind", "preview_video", "preview_frame_rate", "preview_total_frames", "segment_count"];

const SEGMENT_COLORS = [
	"#4f8edc", "#e07b3a", "#5cb85c", "#d9534f", "#9b6cd6",
	"#a07060", "#e377c2", "#7f7f7f", "#c4c447", "#3fbac4",
];

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function pickColor(existingColors) {
	for (const c of SEGMENT_COLORS) if (!existingColors.has(c)) return c;
	const idx = existingColors.size;
	const hue = (idx * 137.508) % 360;
	return `hsl(${hue.toFixed(0)}, 55%, 55%)`;
}

function hideWidget(w) {
	if (!w) return;
	if (!w.__gjjVideoSegHiddenState) {
		w.__gjjVideoSegHiddenState = { type: w.type, draw: w.draw, computeSize: w.computeSize };
	}
	w.type = "hidden";
	w.hidden = true;
	w.draw = () => {};
	w.computeSize = () => [0, -4];
	if (w.inputEl?.style) w.inputEl.style.display = "none";
	if (w.element?.style) w.element.style.display = "none";
}

// ─── Parsing ───
function parseSegments(text) {
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) {
			return parsed.filter(s => typeof s === "object" && s !== null && ("start" in s || "end" in s));
		}
		return [];
	} catch (e) {
		return [];
	}
}

function videoDataToUrl(previewVideo) {
	if (!previewVideo || !Array.isArray(previewVideo) || previewVideo.length === 0) return null;
	const data = previewVideo[0];
	if (!data?.filename) return null;
	
	// 构建URL，移除localhost，使用相对路径
	const subfolder = data.subfolder || "";
	const type = data.type || "temp";
	const filename = data.filename;
	
	// 使用相对路径，避免跨域问题
	return `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}`;
}

// ─── Output Management ───
function getVideoOutputs(node) {
	const outputs = node.outputs || [];
	return outputs.filter(o => o?.type === "VIDEO" || (o?.name && o.name !== SEGMENT_LIST_NAME));
}

function addDynamicOutput(node, type, name, index) {
	const target = index ?? node.outputs.length;
	if (target < node.outputs.length) {
		node.removeOutput(target);
		node.addOutput(name, type);
	} else {
		node.addOutput(name, type);
	}
}

function removeUnusedOutputsFromEnd(node, minOutputs = MIN_VISIBLE_OUTPUTS) {
	const outputs = node.outputs || [];
	for (let i = outputs.length - 1; i >= minOutputs; i--) {
		const output = outputs[i];
		if (output?.links && output.links.length > 0) break;
		if (output?.name === SEGMENT_LIST_NAME) continue;
		const slotIndex = node.outputs.indexOf(output);
		if (slotIndex >= 0) node.removeOutput(slotIndex);
	}
}

function renameOutputsSequentially(node, segmentCount) {
	let videoIdx = 0;

	for (const output of node.outputs || []) {
		if (!output) continue;
		if (output.name === SEGMENT_LIST_NAME) {
			output.type = "STRING";
			output.label = SEGMENT_LIST_NAME;
			output.localized_name = output.label;
		} else if (videoIdx < segmentCount) {
			videoIdx++;
			const outputName = `视频片段${videoIdx}`;
			output.name = outputName;
			output.type = "VIDEO";
			output.label = outputName;
			output.localized_name = outputName;
		}
	}
}

function ensureLeadingSegmentListOutput(node) {
	const outputs = node.outputs || [];
	if (outputs.length === 0) {
		addDynamicOutput(node, "STRING", SEGMENT_LIST_NAME, 0);
		addDynamicOutput(node, "VIDEO", "视频片段1", 1);
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
	const targetOutputs = actualCount + 1; // 1个分段列表 + N个视频片段

	ensureLeadingSegmentListOutput(node);

	// 添加缺失的视频输出
	const videoOutputs = getVideoOutputs(node);
	for (let i = videoOutputs.length; i < actualCount; i++) {
		const outputName = `视频片段${i + 1}`;
		addDynamicOutput(node, "VIDEO", outputName);
	}

	removeUnusedOutputsFromEnd(node, targetOutputs);
	renameOutputsSequentially(node, actualCount);
	setDirty(node);
}

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, segmentCount, ms = 32) {
	clearTimeout(node.__gjjVideoSegmentTimer);
	node.__gjjVideoSegmentTimer = setTimeout(() => stabilizeNode(node, segmentCount), ms);
}

// ─── VideoSegmentEditorWidget ───
class VideoSegmentEditorWidget {
	constructor(node, container) {
		this.node = node;
		this.container = container;
		this.segments = [];
		this.duration = 0;
		this.frameRate = 24;
		this.totalFrames = 0;
		this.previewImageUrl = null;

		this.selectedIndex = 0;
		this.hoverIndex = -1;
		this.hoverHandle = -1;
		this.dragHandle = -1;
		this.dragStart = null;
		this.dragBaseline = null;

		// Animation
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
		// 清空容器并使用flex布局
		this.container.innerHTML = "";
		this.container.style.cssText = `
			display: flex; flex-direction: column; gap: 6px;
			padding: 6px 8px; box-sizing: border-box;
			font-family: sans-serif; font-size: 11px; color: #ddd;
			width: 100%;
		`;
		
		// 视频预览区域（带播放器）
		const videoPreview = document.createElement('div');
		videoPreview.className = 'gjj-video-preview';
		videoPreview.style.cssText = 'width: 100%; height: 160px; border-radius: 4px; overflow: hidden; background: #111; position: relative; flex-shrink: 0;';
		videoPreview.innerHTML = '<div style="height: 160px; display: flex; align-items: center; justify-content: center; color: #888; font-size: 12px;">加载中...</div>';
		this.container.appendChild(videoPreview);
		
		// 保存视频播放器引用
		this.videoPreviewEl = videoPreview;
		this.videoPlayer = null;

		// Canvas编辑区域 - 直接使用canvas，不使用额外容器
		this.canvas = document.createElement('canvas');
		this.canvas.style.cssText = `
			width: 100%; height: ${CANVAS_HEIGHT}px;
			display: block; background: #1a1a1a; border-radius: 4px;
			cursor: default; flex-shrink: 0;
		`;
		this.container.appendChild(this.canvas);
		this.ctx = this.canvas.getContext('2d');

		// 统计信息
		const stats = document.createElement('div');
		stats.style.cssText = 'display: flex; gap: 16px; font-size: 11px; color: #999;';
		stats.innerHTML = `
			<span>时长: <span class="gjj-stats-duration">0.0</span>秒</span>
			<span>帧率: <span class="gjj-stats-fps">24</span>Hz</span>
			<span>帧数: <span class="gjj-stats-frames">0</span></span>
		`;
		this.container.appendChild(stats);

		// 保存统计标签引用
		this.durationLabel = stats.querySelector('.gjj-stats-duration');
		this.frameRateLabel = stats.querySelector('.gjj-stats-fps');
		this.framesLabel = stats.querySelector('.gjj-stats-frames');

		// 控制按钮
		const controls = document.createElement('div');
		controls.style.cssText = 'display: flex; gap: 6px; align-items: center;';
		
		this.addBtn = this.makeButton("+ 添加", "在末尾添加一个新分段");
		this.distributeBtn = this.makeButton("均分", "将所有分段均匀分布到整个时长");
		this.deleteBtn = this.makeButton("删除", "删除当前选中的分段（至少保留1个）");
		
		this.totalLabel = document.createElement('span');
		this.totalLabel.style.cssText = 'color: #888; margin-left: 4px; flex: 1; text-align: right;';
		this.totalLabel.textContent = '合计: --';

		controls.appendChild(this.addBtn);
		controls.appendChild(this.distributeBtn);
		controls.appendChild(this.deleteBtn);
		controls.appendChild(this.totalLabel);
		this.container.appendChild(controls);
	}

	makeButton(label, tooltip) {
		const b = document.createElement("button");
		b.textContent = label;
		if (tooltip) b.title = tooltip;
		b.style.cssText = `
			background: #3a3a3a; color: #eee; border: 1px solid #555;
			border-radius: 3px; padding: 3px 10px; cursor: pointer; font-size: 11px;
		`;
		b.addEventListener("mouseenter", () => b.style.background = "#4a4a4a");
		b.addEventListener("mouseleave", () => b.style.background = "#3a3a3a");
		return b;
	}

	bindEvents() {
		this.canvas.addEventListener("pointerdown", e => { e.stopPropagation(); this.onPointerDown(e); });
		this.canvas.addEventListener("pointermove", e => { e.stopPropagation(); this.onPointerMove(e); });
		this.canvas.addEventListener("pointerup", e => { e.stopPropagation(); this.onPointerUp(e); });
		this.canvas.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); });
		this.canvas.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
		this.canvas.addEventListener("pointerleave", () => {
			if (this.dragHandle < 0) {
				this.hoverIndex = -1;
				this.hoverHandle = -1;
				this.canvas.style.cursor = "default";
				this.render();
			}
		});

		this.addBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.addBtn.addEventListener("click", () => {
			this.addSegment();
			// 同步输出接口
			if (this.node) {
				scheduleStabilize(this.node, this.segments.length);
			}
		});
		this.distributeBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.distributeBtn.addEventListener("click", () => {
			this.distributeEvenly();
			// 同步输出接口
			if (this.node) {
				scheduleStabilize(this.node, this.segments.length);
			}
		});
		this.deleteBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.deleteBtn.addEventListener("click", () => {
			this.deleteSelected();
			// 同步输出接口
			if (this.node) {
				scheduleStabilize(this.node, this.segments.length);
			}
		});

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
		const pps = this.pxPerSecond();
		
		for (let i = 0; i < this.segments.length; i++) {
			const seg = this.segments[i];
			const startSec = seg.start || 0;
			const endSec = seg.end || startSec + MIN_DURATION;
			const len = Math.max(MIN_DURATION, endSec - startSec);
			
			rects.push({
				index: i,
				x: startSec * pps,
				w: len * pps,
				startSec,
				endSec,
			});
		}
		return rects;
	}

	hitBoundary(mx) {
		const rects = this.segmentRects();
		for (let i = 0; i < rects.length; i++) {
			const right = rects[i].x + rects[i].w;
			if (Math.abs(mx - right) <= HANDLE_HIT_PX) return i;
		}
		return -1;
	}

	hitBlock(mx, my) {
		if (my < RULER_HEIGHT) return -1;
		const rects = this.segmentRects();
		for (const r of rects) {
			if (mx >= r.x && mx < r.x + r.w) return r.index;
		}
		return -1;
	}

	localPos(e) {
		const rect = this.canvas.getBoundingClientRect();
		const sx = (rect.width / this.canvas.offsetWidth) || 1;
		const sy = (rect.height / this.canvas.offsetHeight) || 1;
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
			this.dragBaseline = this.segments.map(s => ({ start: s.start || 0, end: s.end || 0 }));
			this.dragStart = { x };
			try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
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

			// Restore baseline, then shift boundary
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
			this.canvas.style.cursor = handle >= 0 ? "ew-resize" : (block >= 0 ? "pointer" : "default");
			this.render();
		}
	}

	onPointerUp(e) {
		if (this.dragHandle >= 0) {
			this.dragHandle = -1;
			this.dragStart = null;
			this.dragBaseline = null;
			try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
		}
	}

	// ─── Manipulation ───
	addSegment() {
		const lastEnd = this.segments.length > 0 ? (this.segments[this.segments.length - 1].end || 0) : 0;
		const newStart = Math.min(lastEnd, this.duration - MIN_DURATION);
		const newEnd = Math.min(newStart + MIN_DURATION, this.duration);
		const colors = new Set(this.segments.map(s => s.color));
		this.segments.push({
			start: newStart,
			end: newEnd,
			label: `(${this.segments.length + 1})`,
			color: pickColor(colors),
		});
		this.selectedIndex = this.segments.length - 1;
		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	distributeEvenly() {
		if (this.segments.length === 0) return;
		const dur = this.duration || 60;
		const step = dur / this.segments.length;
		for (let i = 0; i < this.segments.length; i++) {
			this.segments[i].start = i * step;
			this.segments[i].end = (i + 1) * step;
		}
		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	deleteSelected() {
		if (this.segments.length <= 1) return;
		if (this.selectedIndex < 0 || this.selectedIndex >= this.segments.length) return;
		this.segments.splice(this.selectedIndex, 1);
		this.selectedIndex = Math.min(this.selectedIndex, this.segments.length - 1);
		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	_shiftBoundary(index, delta) {
		if (index < 0 || index >= this.segments.length - 1) return;
		const left = this.segments[index];
		const right = this.segments[index + 1];
		const newEnd = clamp(left.start + delta + (left.end - left.start), left.start + MIN_DURATION, right.end - MIN_DURATION);
		left.end = newEnd;
		right.start = newEnd;
	}

	_ensureMinDuration() {
		for (const seg of this.segments) {
			if ((seg.end - seg.start) < MIN_DURATION) {
				seg.end = seg.start + MIN_DURATION;
			}
		}
	}

	// ─── Commit & Sync ───
	// 提交分段数据到widget
	commit() {
		const data = {
			segments: this.segments.map(s => ({
				start: parseFloat(s.start.toFixed(3)),
				end: parseFloat(s.end.toFixed(3)),
				label: s.label,
			})),
		};

		const json = JSON.stringify(data.segments, null, 2);
		const segWidget = this.node.widgets?.find(w => w.name === "segments_json");
		if (segWidget) {
			segWidget.value = json;
		}

		// 动态同步输出接口数量
		scheduleStabilize(this.node, this.segments.length);
	}

	updateTotalLabel() {
		const total = this.segments.reduce((sum, s) => sum + Math.max(0, (s.end || 0) - (s.start || 0)), 0);
		this.totalLabel.textContent = `合计: ${this.formatTime(total)}秒`;
	}

	// ─── Rendering ───
	render() {
		const ctx = this.ctx;
		const width = this._cssWidth;
		const height = CANVAS_HEIGHT;

		ctx.clearRect(0, 0, width, height);

		// Background
		ctx.fillStyle = "#1a1a1a";
		ctx.fillRect(0, 0, width, height);

		// Ruler
		this._drawRuler(ctx, width);

		// Preload segment thumbnails
		this._preloadSegmentThumbnails();

		// Segments
		const rects = this.segmentRects();
		for (let i = 0; i < rects.length; i++) {
			const r = rects[i];
			const isSelected = i === this.selectedIndex;
			const isHover = i === this.hoverIndex;
			this._drawSegment(ctx, r, isSelected, isHover);
		}

		// Handles
		for (let i = 0; i < rects.length - 1; i++) {
			const x = rects[i].x + rects[i].w;
			const isHover = i === this.hoverHandle;
			this._drawHandle(ctx, x, isHover);
		}
	}

	_preloadSegmentThumbnails() {
		// 为每个分段预加载缩略图
		for (let i = 0; i < this.segments.length; i++) {
			const seg = this.segments[i];
			if (seg.thumbnail && !seg._thumbnailImage) {
				const img = new Image();
				img.onload = () => {
					// 缩略图加载完成后重新渲染
					this.render();
				};
				img.onerror = () => {
					console.warn(`[GJJ] 缩略图加载失败 (segment ${i}):`, seg.thumbnail);
				};
				// 构建缩略图URL
				const subfolder = seg.thumbnail.subfolder || "";
				const type = seg.thumbnail.type || "temp";
				const filename = seg.thumbnail.filename;
				img.src = `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}`;
				seg._thumbnailImage = img;
			}
		}
	}

	_drawRuler(ctx, width) {
		ctx.fillStyle = "#2a2a2a";
		ctx.fillRect(0, 0, width, RULER_HEIGHT);

		ctx.strokeStyle = "#555";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, RULER_HEIGHT);
		ctx.lineTo(width, RULER_HEIGHT);
		ctx.stroke();

		const pps = this.pxPerSecond();
		const maxDur = this.getMaxDuration();
		const tickInterval = this._getTickInterval(pps);

		ctx.fillStyle = "#aaa";
		ctx.font = "10px sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";

		for (let t = 0; t <= maxDur; t += tickInterval) {
			const x = t * pps;
			if (x > width) break;

			ctx.beginPath();
			ctx.moveTo(x, RULER_HEIGHT - 6);
			ctx.lineTo(x, RULER_HEIGHT);
			ctx.strokeStyle = "#666";
			ctx.stroke();

			ctx.fillText(this.formatTime(t), x, 4);
		}
	}

	_getTickInterval(pps) {
		const targetPx = 80;
		const rawSec = targetPx / pps;
		const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
		for (const c of candidates) {
			if (c >= rawSec) return c;
		}
		return 60;
	}

	_drawSegment(ctx, rect, isSelected, isHover) {
		const x = rect.x;
		const y = BLOCK_Y;
		const w = Math.max(2, rect.w);
		const h = BLOCK_H;

		// Color
		const seg = this.segments[rect.index];
		const baseColor = seg.color || "#4f8edc";

		// Fill - 半透明色块作为背景
		ctx.fillStyle = isSelected ? baseColor : (isHover ? this._lighten(baseColor, 20) : this._darken(baseColor, 10));
		ctx.globalAlpha = isSelected ? 0.6 : (isHover ? 0.4 : 0.3);
		ctx.fillRect(x, y, w, h);
		ctx.globalAlpha = 1;

		// 绘制缩略图（如果可用）- 在色块上方
		if (seg._thumbnailImage && seg._thumbnailImage.complete && seg._thumbnailImage.naturalWidth > 0 && w > 60) {
			ctx.save();
			// 裁剪到分段区域
			ctx.beginPath();
			ctx.rect(x, y, w, h);
			ctx.clip();
			
			// 计算缩略图绘制区域（保持宽高比，填充整个区域）
			const imgAspect = seg._thumbnailImage.naturalWidth / seg._thumbnailImage.naturalHeight;
			const boxAspect = w / h;
			
			let drawW, drawH, drawX, drawY;
			if (imgAspect > boxAspect) {
				// 图片更宽，以宽度为准
				drawW = w;
				drawH = w / imgAspect;
				drawX = x;
				drawY = y + (h - drawH) / 2;
			} else {
				// 图片更高，以高度为准
				drawH = h;
				drawW = h * imgAspect;
				drawX = x + (w - drawW) / 2;
				drawY = y;
			}
			
			// 绘制缩略图
			ctx.globalAlpha = 0.7;
			ctx.drawImage(seg._thumbnailImage, drawX, drawY, drawW, drawH);
			ctx.globalAlpha = 1;
			ctx.restore();
		}

		// Border
		ctx.strokeStyle = isSelected ? "#fff" : baseColor;
		ctx.lineWidth = isSelected ? 2 : 1;
		ctx.strokeRect(x, y, w, h);

		// Label - 绘制在底部，透明度50%
		const labelText = seg.label || `(${rect.index + 1})`;
		const timeText = `${this.formatTime(rect.startSec)} - ${this.formatTime(rect.endSec)}`;
		
		// 底部背景条
		const labelHeight = 28;
		const labelY = y + h - labelHeight;
		ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
		ctx.fillRect(x, labelY, w, labelHeight);
		
		// 文字 - 白色，50%透明度
		ctx.globalAlpha = 0.8;
		ctx.fillStyle = "#fff";
		ctx.font = "10px sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		
		// 绘制文字（单行显示：标签 + 时间）
		const displayText = `${labelText}  ${timeText}`;
		ctx.fillText(displayText, x + w / 2, labelY + labelHeight / 2);
		
		// 重置透明度
		ctx.globalAlpha = 1;
	}

	_drawHandle(ctx, x, isHover) {
		const y = BLOCK_Y;
		const h = BLOCK_H;
		const size = 6;

		ctx.fillStyle = isHover ? "#ffcc00" : "#ff9900";
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x - size, y + h / 2);
		ctx.lineTo(x, y + h);
		ctx.lineTo(x + size, y + h / 2);
		ctx.closePath();
		ctx.fill();

		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 1.5;
		ctx.stroke();
	}

	_darken(hex, percent) {
		const num = parseInt(hex.slice(1), 16);
		const amt = Math.round(2.55 * percent);
		const R = Math.max(0, (num >> 16) - amt);
		const G = Math.max(0, ((num >> 8) & 0x00FF) - amt);
		const B = Math.max(0, (num & 0x0000FF) - amt);
		return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
	}

	_lighten(hex, percent) {
		const num = parseInt(hex.slice(1), 16);
		const amt = Math.round(2.55 * percent);
		const R = Math.min(255, (num >> 16) + amt);
		const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
		const B = Math.min(255, (num & 0x0000FF) + amt);
		return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
	}

	// ─── Update from backend ───
	updateFromBackend(data) {
		if (data.preview_segments) {
			// 解析新的分段数据
			const newSegments = parseSegments(data.preview_segments);
			
			// 清除旧的缩略图引用，强制重新加载
			this.segments.forEach(seg => {
				if (seg._thumbnailImage) {
					seg._thumbnailImage = null;
				}
			});
			
			this.segments = newSegments;
		}
		if (data.preview_duration !== undefined) {
			this.duration = parseFloat(data.preview_duration);
		}
		if (data.preview_frame_rate !== undefined) {
			this.frameRate = parseFloat(data.preview_frame_rate);
		}
		if (data.preview_total_frames !== undefined) {
			this.totalFrames = parseInt(data.preview_total_frames);
		}
		if (data.preview_video) {
			this.previewImageUrl = videoDataToUrl(data.preview_video);
		}

		// Ensure segments have colors
		const colors = new Set();
		for (const seg of this.segments) {
			if (!seg.color) {
				seg.color = pickColor(colors);
			}
			colors.add(seg.color);
		}

		// Update labels - 修复重复文字问题
		this.durationLabel.textContent = `${this.formatTime(this.duration)}`;
		this.frameRateLabel.textContent = this.frameRate ? `${this.frameRate}` : "";
		this.framesLabel.textContent = this.totalFrames ? `${this.totalFrames}` : "";

		// 更新视频预览显示
		this.updateVideoPreview(data.preview_video);
		
		// 渲染Canvas（会自动加载缩略图）
		this.render();
		
		// 通知节点尺寸可能发生变化
		if (this.node) {
			this.node.onResize?.(this.node.size);
			setDirty(this.node);
		}
	}

	getTotalHeight() {
		// 视频预览区域高度 (160px) + 边距 (8px)
		// Canvas 区域高度 (CANVAS_HEIGHT) + 边距 (8px)
		// 统计信息高度 (约20px) + 边距 (8px)
		// 控制按钮高度 (约30px) + 边距 (8px)
		// 额外缓冲
		return 160 + 8 + CANVAS_HEIGHT + 8 + 20 + 8 + 30 + 8 + 10;
	}

	updateVideoPreview(previewVideoData) {
		const videoPreviewEl = this.container.querySelector('.gjj-video-preview');
		if (!videoPreviewEl) return;

		const imageUrl = videoDataToUrl(previewVideoData);
		console.log('[GJJ] 视频分段编辑器 - updateVideoPreview:', {
			previewVideoData,
			imageUrl,
		});
		
		if (imageUrl) {
			// 恢复视频播放器，但添加错误回退
			videoPreviewEl.innerHTML = `
				<video controls style="width: 100%; height: 160px; object-fit: contain; border-radius: 4px; background: #000;">
					您的浏览器不支持视频播放
				</video>
			`;
			
			// 保存视频播放器引用
			this.videoPlayer = videoPreviewEl.querySelector('video');
			
			// 设置视频源
			this.videoPlayer.src = imageUrl;
			
			// 添加错误监听 - 如果视频加载失败，显示图片预览
			this.videoPlayer.addEventListener('error', (e) => {
				console.warn('[GJJ] 视频加载失败，回退到图片预览:', {
					src: this.videoPlayer.src,
					error: this.videoPlayer.error,
				});
				// 回退到图片预览
				videoPreviewEl.innerHTML = `
					<img style="width: 100%; height: 160px; object-fit: contain; border-radius: 4px; background: #000; cursor: pointer;" src="${imageUrl}" alt="视频预览">
				`;
				const img = videoPreviewEl.querySelector('img');
				img.addEventListener('click', () => {
					window.open(imageUrl, '_blank');
				});
				this.videoPlayer = null;
			});
			
			// 添加成功加载监听
			this.videoPlayer.addEventListener('loadeddata', () => {
				console.log('[GJJ] 视频加载成功:', this.videoPlayer.src);
			});
		} else {
			videoPreviewEl.innerHTML = '<div style="height: 160px; display: flex; align-items: center; justify-content: center; color: #888; font-size: 12px;">暂无预览</div>';
			this.videoPlayer = null;
		}
	}

}

// ─── Node Registration ───
app.registerExtension({
	name: `GJJ.${NODE_NAME}`,
	
	beforeRegisterNodeDef(nodeType, nodeData, appInstance) {
		if (nodeData.name !== NODE_NAME) return;

		const origOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function(message) {
			origOnExecuted?.apply(this, arguments);

			console.log('[GJJ] 视频分段编辑器 - onExecuted:', {
				hasPreviewVideo: !!message.preview_video,
				previewVideo: message.preview_video,
			});

			const editor = this.__gjjVideoSegmentEditor;
			if (editor) {
				editor.updateFromBackend({
					preview_segments: message.preview_segments?.[0],
					preview_duration: message.preview_duration?.[0],
					preview_frame_rate: message.preview_frame_rate?.[0],
					preview_total_frames: message.preview_total_frames?.[0],
					preview_video: message.preview_video?.[0],  // 解包元组
				});
			}
			
			// 根据后端返回的分段数量更新输出接口
			const segmentCount = message.preview_segment_count?.[0] || 1;
			scheduleStabilize(this, segmentCount);
			
			// 强制刷新节点显示（包括DOM widget）
			setTimeout(() => {
				this.setDirtyCanvas(true, true);
			}, 50);
		};

		const origOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function() {
			origOnNodeCreated?.apply(this, arguments);

			// Hide internal widgets
			for (const name of HIDDEN_WIDGET_NAMES) {
				const w = this.widgets?.find(w => w.name === name);
				if (w) hideWidget(w);
			}

			// Hook video_file widget to trigger re-execution on change
			const videoFileWidget = this.widgets?.find(w => w.name === "video_file");
			if (videoFileWidget) {
				const origCallback = videoFileWidget.callback;
				const self = this;
				videoFileWidget.callback = function (...args) {
					const result = origCallback?.apply(this, args);
					// Re-queue node to refresh video and duration
					try { app.graph?.queueNode?.(self); } catch (_) {}
					return result;
				};
			}

			// Build editor inside a DOM widget
			const container = document.createElement("div");
			
			const self = this;

			this._videoSegmentEditorWidget = this.addDOMWidget("video_segment_editor_canvas", "GJJVideoSegmentEditor", container, {
				serialize: false,
				hideOnZoom: false,
				// 固定高度，与音频编辑器逻辑一致
				getMinHeight: () => 370,
				getHeight: () => 370,
			});

			setTimeout(() => {
				try {
					this.__gjjVideoSegmentEditor = new VideoSegmentEditorWidget(self, container);
				} catch (err) {
					console.error("[GJJ] 视频分段编辑器初始化失败:", err);
				}
			}, 0);

			// 稳定化输出接口
			setTimeout(() => stabilizeNode(this, 1), 10);
		};

		// 添加右键菜单
		const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
		nodeType.prototype.getExtraMenuOptions = function (_, options) {
			const result = origGetExtraMenuOptions?.apply(this, arguments);

			if (this.__gjjVideoSegmentEditor) {
				options.unshift(
					{
						content: "均分",
						callback: () => {
							this.__gjjVideoSegmentEditor.distributeEvenly();
							scheduleStabilize(this, this.__gjjVideoSegmentEditor.segments.length);
						},
					},
					{
						content: "+ 添加分段",
						callback: () => {
							this.__gjjVideoSegmentEditor.addSegment();
							scheduleStabilize(this, this.__gjjVideoSegmentEditor.segments.length);
						},
					},
					{
						content: "删除选中",
						callback: () => {
							this.__gjjVideoSegmentEditor.deleteSelected();
							scheduleStabilize(this, this.__gjjVideoSegmentEditor.segments.length);
						},
					},
				);
			}

			return result;
		};
	},
});

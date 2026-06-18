import { GJJ_Utils } from "./gjj_utils.js";

const { app } = window.comfyAPI.app;

// ─── Constants ───
const NODE_NAME = "GJJ_VideoSegmentEditor";
const CANVAS_HEIGHT = 104;
const RULER_HEIGHT = 24;
const BLOCK_Y = RULER_HEIGHT + 4;
const BLOCK_H = 48;
const HANDLE_HIT_PX = 6;
const MIN_DURATION = 0.01;
const DEFAULT_PREVIEW_ASPECT = 16 / 9;
const FRAME_SNAP = 8;
const MIN_VISIBLE_OUTPUTS = 2; // 1个分段列表 + 1个视频片段
const SEGMENT_LIST_NAME = "分段列表";
const HIDDEN_WIDGET_NAMES = ["video_file", "segments_json", "refresh_nonce", "preview_text", "preview_kind", "preview_video", "preview_frame_rate", "preview_total_frames", "segment_count"];

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
	const upstreamNodeIds = collectUpstreamNodeIds(node);

	const savedModes = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;

	try {
		for (const n of allNodes) {
			if (!n || n === node) continue;
			if (upstreamNodeIds.has(String(n.id))) continue;

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

function collectUpstreamNodeIds(node) {
	const graph = node?.graph || app.graph;
	const keep = new Set();
	const visit = (n) => {
		if (!n?.inputs || keep.has(String(n.id))) return;
		for (const input of n.inputs) {
			const linkId = input?.link;
			if (linkId == null) continue;
			const link = graph?.links?.[linkId] || app.graph?.links?.[linkId];
			if (!link || link.origin_id == null) continue;
			const originId = String(link.origin_id);
			keep.add(originId);
			const originNode = graph?.getNodeById?.(link.origin_id) || (graph?._nodes || []).find(x => String(x?.id) === originId);
			if (originNode) visit(originNode);
		}
	};
	visit(node);
	return keep;
}

const SEGMENT_COLORS = [
	"#4f8edc", "#e07b3a", "#5cb85c", "#d9534f", "#9b6cd6",
	"#a07060", "#e377c2", "#7f7f7f", "#c4c447", "#3fbac4",
];

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function getEditorHeightForWidth(node) {
	const width = Math.max(360, Number(node?.size?.[0] || 420) - 34);
	const aspect = Number(node?.__gjjPreviewAspect || DEFAULT_PREVIEW_ASPECT);
	const previewHeight = Math.max(140, Math.round(width / Math.max(0.1, aspect)));
	return previewHeight + CANVAS_HEIGHT + 86;
}

function pickColor(existingColors) {
	for (const c of SEGMENT_COLORS) if (!existingColors.has(c)) return c;
	const idx = existingColors.size;
	const hue = (idx * 137.508) % 360;
	return `hsl(${hue.toFixed(0)}, 55%, 55%)`;
}

function hideWidget(w) {
	if (!w) return;
	GJJ_Utils.hideWidget(w);
}

// ─── Parsing ───
function parseSegments(text) {
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) {
			return parsed.filter(s => {
				if (typeof s !== "object" || s === null) return false;
				return "start" in s || "end" in s || "start_frame" in s || "end_frame" in s;
			});
		}
		return [];
	} catch (e) {
		return [];
	}
}

function videoDataToUrl(previewVideo) {
	previewVideo = unwrapFirst(previewVideo);
	if (previewVideo && !Array.isArray(previewVideo) && typeof previewVideo === "object") {
		previewVideo = [previewVideo];
	}
	if (!previewVideo || !Array.isArray(previewVideo) || previewVideo.length === 0) return null;
	const data = previewVideo[0];
	if (!data?.filename) return null;

	// 构建URL，移除localhost，使用相对路径
	const subfolder = data.subfolder || "";
	const type = data.type || "temp";
	const filename = data.filename;

	// 使用相对路径，避免跨域问题
	const rand = data.mtime_ns || data.ts || Date.now();
	return `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}&t=${encodeURIComponent(rand)}`;
}

function videoFileToUrl(filename, type = "input") {
	if (!filename || filename === "[不加载]") return null;
	const normalized = String(filename).replaceAll("\\", "/");
	const parts = normalized.split("/");
	const name = parts.pop() || normalized;
	const subfolder = parts.join("/");
	return `/view?filename=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}&t=${encodeURIComponent(Date.now())}`;
}

function hasExternalVideoConnection(node) {
	const input = node?.inputs?.find(i => i?.name === "video" || i?.label === "外部视频" || i?.localized_name === "外部视频");
	return !!(input && input.link != null);
}

function unwrapFirst(value) {
	let current = value;
	while (Array.isArray(current) && current.length === 1) current = current[0];
	return current;
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
		this._previewFallbackUrl = null;
		this._pendingSeekTime = null;
		this._seekRaf = null;
		this.previewAspect = Number(node.__gjjPreviewAspect || DEFAULT_PREVIEW_ASPECT);

		this.selectedIndex = 0;
		this.hoverIndex = -1;
		this.hoverHandle = -1;
		this.dragHandle = -1;
		this.dragStart = null;
		this.dragBaseline = null;
		this.loopSelectedSegment = false;

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

	snapFrame(value) {
		const frame = Math.max(1, Math.round(Number(value) || 1));
		return 1 + Math.round((frame - 1) / FRAME_SNAP) * FRAME_SNAP;
	}

	secondsToFrame(seconds) {
		return this.snapFrame((Number(seconds) || 0) * (this.frameRate || 24) + 1);
	}

	frameToSeconds(frame) {
		const fps = this.frameRate || 24;
		return fps > 0 ? (Math.max(1, Number(frame) || 1) - 1) / fps : 0;
	}

	frameEndToSeconds(frame) {
		const fps = this.frameRate || 24;
		return fps > 0 ? Math.max(1, Number(frame) || 1) / fps : 0;
	}

	getTotalFrameCount() {
		const explicitTotal = Number(this.totalFrames || 0);
		if (explicitTotal > 0) return Math.max(1, Math.round(explicitTotal));
		if (this.duration > 0) return Math.max(1, Math.round(this.duration * (this.frameRate || 24)));
		const segmentMax = Math.max(0, ...this.segments.map(seg => Number(seg?.end_frame || 0)));
		if (segmentMax > 0) return Math.max(1, Math.round(segmentMax));
		return Math.max(1, Math.round(60 * (this.frameRate || 24)));
	}

	getMaxAnchorFrame() {
		const total = this.getTotalFrameCount();
		return Math.max(1, 1 + Math.floor((total - 1) / FRAME_SNAP) * FRAME_SNAP);
	}

	frameToX(frame) {
		const width = this._cssWidth || 1;
		const maxAnchor = this.getMaxAnchorFrame();
		if (maxAnchor <= 1) return 0;
		return ((Math.max(1, Number(frame) || 1) - 1) / (maxAnchor - 1)) * width;
	}

	xToFrame(x) {
		const width = this._cssWidth || 1;
		const maxAnchor = this.getMaxAnchorFrame();
		if (width <= 0 || maxAnchor <= 1) return 1;
		return this.snapFrame(1 + (clamp(x, 0, width) / width) * (maxAnchor - 1));
	}

	normalizeSegmentFrames(seg) {
		const total = this.getTotalFrameCount();
		let startFrame = ("start_frame" in seg) ? this.snapFrame(seg.start_frame) : this.secondsToFrame(seg.start || 0);
		let endFrame = ("end_frame" in seg) ? this.snapFrame(seg.end_frame) : this.secondsToFrame(seg.end || this.duration || 0);

		const maxAnchor = this.getMaxAnchorFrame();
		if (maxAnchor <= 1) {
			seg.start_frame = 1;
			seg.end_frame = 1;
			seg.start = 0;
			seg.end = this.frameEndToSeconds(1);
			return seg;
		}
		startFrame = clamp(startFrame, 1, Math.max(1, maxAnchor - FRAME_SNAP));
		endFrame = clamp(endFrame, startFrame + FRAME_SNAP, maxAnchor);

		seg.start_frame = startFrame;
		seg.end_frame = endFrame;
		seg.start = this.frameToSeconds(startFrame);
		seg.end = this.frameEndToSeconds(endFrame);
		return seg;
	}

	normalizeAllSegmentFrames() {
		for (const seg of this.segments) {
			this.normalizeSegmentFrames(seg);
		}
	}

	getSavedSegmentsText() {
		const widgetText = this.node.widgets?.find(w => w.name === "segments_json")?.value;
		if (parseSegments(widgetText).length) return widgetText;
		const propText = this.node.properties?.segments;
		if (parseSegments(propText).length) return propText;
		return "";
	}

	restoreStateFromNode() {
		const savedSegments = parseSegments(this.getSavedSegmentsText());
		if (savedSegments.length) {
			this.segments = savedSegments;
			this.selectedIndex = clamp(this.selectedIndex, 0, this.segments.length - 1);
			const colors = new Set();
			for (const seg of this.segments) {
				if (!seg.color) seg.color = pickColor(colors);
				colors.add(seg.color);
			}
			this.syncOutputs();
		}
		this.updateLabels();
		this.updateTotalLabel();
		this.render();
	}

	serializeSegments() {
		this.normalizeAllSegmentFrames();
		return this.segments.map((seg, i) => ({
			start_frame: Number(seg.start_frame || 0),
			end_frame: Number(seg.end_frame || (FRAME_SNAP + 1)),
			frames: Math.max(1, Number(seg.end_frame || 1) - Number(seg.start_frame || 1) + 1),
			label: seg.label || `片段 ${i + 1}`,
			...(seg.color ? { color: seg.color } : {}),
		}));
	}

	buildDOM() {
		// 清空容器并使用flex布局
		this.container.innerHTML = "";
		this.container.style.cssText = `
			display: flex; flex-direction: column; gap: 6px;
			padding: 6px 8px; box-sizing: border-box;
			font-family: sans-serif; font-size: 11px; color: #ddd;
			width: 100%; min-width: 0;
		`;

		this.fileInput = document.createElement("input");
		this.fileInput.type = "file";
		this.fileInput.accept = "video/*";
		this.fileInput.style.display = "none";
		this.container.appendChild(this.fileInput);

		// 视频预览区域（带播放器）
		const videoPreview = document.createElement('div');
		videoPreview.className = 'gjj-video-preview';
		videoPreview.style.cssText = [
			"width: 100%",
			"height: 160px",
			"border-radius: 4px",
			"overflow: hidden",
			"background: #000",
			"position: relative",
			"flex-shrink: 0",
			"box-sizing: border-box",
		].join(";");
		this.container.appendChild(videoPreview);

		// 保存视频播放器引用
		this.videoPreviewEl = videoPreview;
		this.videoPlayer = document.createElement("video");
		this.videoPlayer.controls = true;
		this.videoPlayer.preload = "metadata";
		this.videoPlayer.controlsList = "nodownload noremoteplayback";
		this.videoPlayer.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;display:none;";
		videoPreview.appendChild(this.videoPlayer);

		this.emptyPreview = document.createElement("div");
		this.emptyPreview.textContent = "暂无预览";
		this.emptyPreview.style.cssText = "height:100%;display:flex;align-items:center;justify-content:center;color:#888;font-size:12px;";
		videoPreview.appendChild(this.emptyPreview);

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
		controls.style.cssText = 'display: flex; gap: 6px; align-items: center; flex-wrap: wrap;';

		this.openBtn = this.makeButton("📁 打开", "打开任意视频，并复制到 ComfyUI input 目录");
		this.addBtn = this.makeButton("➕ 添加", "在末尾添加一个新分段");
		this.distributeBtn = this.makeButton("⚖️ 均分", "将所有分段均匀分布到整个时长");
		this.deleteBtn = this.makeButton("🗑️ 删除", "删除当前选中的分段（至少保留1个）");
		this.loopBtn = this.makeButton("🔁 循环", "循环播放当前选中的分段");
		this.refreshBtn = this.makeButton("🔄 刷新", "只刷新当前视频分段节点");

		this.totalLabel = document.createElement('span');
		this.totalLabel.style.cssText = 'color: #888; margin-left: 4px; flex: 1; text-align: right;';
		this.totalLabel.textContent = '合计: --';

		controls.appendChild(this.openBtn);
		controls.appendChild(this.addBtn);
		controls.appendChild(this.distributeBtn);
		controls.appendChild(this.deleteBtn);
		controls.appendChild(this.loopBtn);
		controls.appendChild(this.refreshBtn);
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
		b.addEventListener("mouseenter", () => b.style.background = b.__gjjActive ? "#3a806d" : "#4a4a4a");
		b.addEventListener("mouseleave", () => b.style.background = b.__gjjActive ? "#2f6f5f" : "#3a3a3a");
		return b;
	}

	bindEvents() {
		this.fileInput.addEventListener("change", e => this.handleOpenFile(e));

		this.openBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.openBtn.addEventListener("click", () => {
			if (hasExternalVideoConnection(this.node)) return;
			this.fileInput.click();
		});

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

		this.loopBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.loopBtn.addEventListener("click", () => this.toggleSegmentLoop());

		this.refreshBtn.addEventListener("pointerdown", e => e.stopPropagation());
		this.refreshBtn.addEventListener("click", () => this.refreshVideo());

		this.videoPlayer.addEventListener("loadedmetadata", () => this.onPreviewMetadata());
		this.videoPlayer.addEventListener("error", () => this.onPreviewError());
		this.videoPlayer.addEventListener("play", () => this.ensureLoopPlaybackStartsInSegment());
		this.videoPlayer.addEventListener("timeupdate", () => this.onPreviewTimeUpdate());
		this.videoPlayer.addEventListener("pointerdown", e => e.stopPropagation());
		this.videoPlayer.addEventListener("wheel", e => e.stopPropagation(), { passive: true });

		this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
		this.resizeObserver.observe(this.container);
		this.updateOpenButtonState();
	}

	updateOpenButtonState() {
		if (!this.openBtn) return;
		const disabled = hasExternalVideoConnection(this.node);
		this.openBtn.disabled = disabled;
		this.openBtn.style.opacity = disabled ? "0.45" : "1";
		this.openBtn.style.cursor = disabled ? "not-allowed" : "pointer";
		this.openBtn.title = disabled ? "外部视频已连接，📁打开已禁用" : "打开任意视频，并复制到 ComfyUI input 目录";
	}

	resizeCanvas() {
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(50, Math.floor(this.canvas.offsetWidth));
		this.resizePreview(false);
		this.canvas.width = w * dpr;
		this.canvas.height = CANVAS_HEIGHT * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this._cssWidth = w;
		this.render();
	}

	resizePreview(allowNodeResize = false) {
		if (!this.videoPreviewEl) return;
		if (this.dragHandle >= 0 && this._stablePreviewHeight) {
			this.videoPreviewEl.style.height = `${this._stablePreviewHeight}px`;
			return;
		}
		const nodeWidth = Number(this.node?.size?.[0] || 420);
		const contentWidth = Math.max(260, Math.floor(nodeWidth - 24));
		const aspect = Math.max(0.1, Number(this.previewAspect || this.node?.__gjjPreviewAspect || DEFAULT_PREVIEW_ASPECT));
		const height = Math.max(140, Math.round(contentWidth / aspect));
		this._stablePreviewHeight = height;
		this.videoPreviewEl.style.height = `${height}px`;

		if (this.node?._videoSegmentEditorWidget) {
			this.node.__gjjPreviewAspect = aspect;
			const targetHeight = height + CANVAS_HEIGHT + 86;
			this.node._videoSegmentEditorWidget.getHeight = () => targetHeight;
			this.node._videoSegmentEditorWidget.getMinHeight = () => targetHeight;
			if (allowNodeResize && this.node.size?.[1] && Math.abs(this.node.size[1] - targetHeight) > 2) {
				this.node.setSize?.([this.node.size[0], targetHeight]);
			}
		}
	}

	setPreviewSource(url, fallbackUrl = null) {
		this._previewFallbackUrl = fallbackUrl;
		if (!url) {
			this.videoPlayer.removeAttribute("src");
			this.videoPlayer.load();
			this.videoPlayer.style.display = "none";
			this.emptyPreview.style.display = "flex";
			this.emptyPreview.textContent = "暂无预览";
			return;
		}

		if (this.videoPlayer.src === new URL(url, window.location.href).href) return;
		this.emptyPreview.style.display = "none";
		this.videoPlayer.style.display = "block";
		this.videoPlayer.src = url;
		this.videoPlayer.load();
	}

	setVideoFileValue(value) {
		const widget = this.node.widgets?.find(w => w.name === "video_file");
		if (!widget) return;
		widget.value = value || "";
		try {
			widget.callback?.(widget.value);
		} catch (_) {}
	}

	setRefreshNonce() {
		const widget = this.node.widgets?.find(w => w.name === "refresh_nonce");
		if (!widget) return;
		widget.value = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		try {
			widget.callback?.(widget.value);
		} catch (_) {}
	}

	clearWidgetValue(name, value = "") {
		const widget = this.node.widgets?.find(w => w.name === name);
		if (!widget) return;
		widget.value = value;
		try {
			widget.callback?.(widget.value);
		} catch (_) {}
	}

	resetForExternalVideo() {
		this.clearWidgetValue("video_file", "");
		this.clearWidgetValue("segments_json", "[]");
		if (!this.node.properties) this.node.properties = {};
		this.node.properties.segments = "[]";
		this.segments = [];
		this.selectedIndex = 0;
		this.duration = 0;
		this.totalFrames = 0;
		this.setPreviewSource(null);
		this.emptyPreview.textContent = "外部视频执行后显示预览";
		this.updateLabels();
		this.updateTotalLabel();
		this.render();
		scheduleStabilize(this.node, 1);
	}

	async handleOpenFile(e) {
		const file = e?.target?.files?.[0];
		if (!file) return;
		if (hasExternalVideoConnection(this.node)) {
			if (this.fileInput) this.fileInput.value = "";
			this.updateOpenButtonState();
			return;
		}

		const originalText = this.openBtn.textContent;
		try {
			this.openBtn.textContent = "📁 复制中...";
			this.openBtn.disabled = true;
			this.openBtn.style.opacity = "0.65";

			const body = new FormData();
			body.append("video", file, file.name);
			const response = await fetch("/gjj/video_segment_editor/upload", {
				method: "POST",
				body,
			});
			const data = await response.json();
			if (!response.ok || !data?.ok || !data?.video) {
				throw new Error(data?.error || "视频复制失败");
			}

			const video = data.video;
			const value = [video.subfolder, video.filename].filter(Boolean).join("/");
			if (Number.isFinite(Number(video.duration)) && Number(video.duration) > 0) this.duration = Number(video.duration);
			if (Number.isFinite(Number(video.fps)) && Number(video.fps) > 0) this.frameRate = Number(video.fps);
			if (Number.isFinite(Number(video.duration)) && Number.isFinite(Number(video.fps))) {
				this.totalFrames = Math.round(Number(video.duration) * Number(video.fps));
			}
			this.setVideoFileValue(value);
			this.updatePreviewFromFile(value, true);
		} catch (err) {
			console.error("[GJJ] 打开视频失败:", err);
			alert(`打开视频失败：${err?.message || err}`);
		} finally {
			this.openBtn.textContent = originalText;
			this.updateOpenButtonState();
			if (this.fileInput) this.fileInput.value = "";
		}
	}

	updatePreviewFromFile(filename, resetSegments = false) {
		this.updateOpenButtonState();
		if (hasExternalVideoConnection(this.node)) {
			if (resetSegments) this.segments = [];
			this.emptyPreview.textContent = "外部视频执行后显示预览";
			if (!this.videoPlayer?.src) {
				this.videoPlayer.style.display = "none";
				this.emptyPreview.style.display = "flex";
			}
			this.render();
			return;
		}

		if (!filename || filename === "[不加载]") {
			this.duration = 0;
			this.totalFrames = 0;
			if (resetSegments) this.segments = [];
			this.setPreviewSource(null);
			this.updateLabels();
			this.render();
			return;
		}

		if (resetSegments) {
			this.segments = [];
			this.selectedIndex = 0;
		}
		this.segments.forEach(seg => {
			seg.thumbnail = null;
			seg._thumbnailImage = null;
		});
		this.setPreviewSource(videoFileToUrl(filename, "input"), videoFileToUrl(filename, "output"));
	}

	onPreviewMetadata() {
		const videoWidth = Number(this.videoPlayer.videoWidth || 0);
		const videoHeight = Number(this.videoPlayer.videoHeight || 0);
		if (videoWidth > 0 && videoHeight > 0) {
			this.previewAspect = videoWidth / videoHeight;
			if (this.node) this.node.__gjjPreviewAspect = this.previewAspect;
			this.resizePreview(true);
		}

		const nextDuration = Number.isFinite(this.videoPlayer.duration) ? this.videoPlayer.duration : 0;
		if (nextDuration > 0) {
			this.duration = nextDuration;
			this.totalFrames = Math.round(this.duration * (this.frameRate || 24));

			if (!this.segments.length || this.segments.some(seg => (seg.end || 0) > this.duration + 0.001)) {
				this.segments = this.makeAutoSegments(3);
				this.selectedIndex = 0;
				this.commit();
			}
		}

		this.updateLabels();
		this.updateTotalLabel();
		this.render();
		this.node?.onResize?.(this.node.size);
	}

	onPreviewError() {
		if (this._previewFallbackUrl && this.videoPlayer.src !== new URL(this._previewFallbackUrl, window.location.href).href) {
			const fallback = this._previewFallbackUrl;
			this._previewFallbackUrl = null;
			this.setPreviewSource(fallback);
			return;
		}
		this.videoPlayer.style.display = "none";
		this.emptyPreview.style.display = "flex";
		this.emptyPreview.textContent = "视频预览加载失败";
	}

	makeAutoSegments(count = 4) {
		const segmentCount = Math.max(1, count);
		const maxAnchor = this.getMaxAnchorFrame();
		if (maxAnchor <= 1) {
			return [{
				start_frame: 1,
				end_frame: 1,
				start: 0,
				end: this.frameEndToSeconds(1),
				label: "片段 1",
				color: SEGMENT_COLORS[0],
			}];
		}
		const step = Math.max(FRAME_SNAP, Math.round(((maxAnchor - 1) / segmentCount) / FRAME_SNAP) * FRAME_SNAP);
		const colors = new Set();
		return Array.from({ length: segmentCount }, (_, i) => {
			const color = pickColor(colors);
			colors.add(color);
			const startFrame = Math.min(Math.max(1, maxAnchor - FRAME_SNAP), 1 + i * step);
			const endFrame = i === segmentCount - 1 ? maxAnchor : Math.min(maxAnchor, Math.max(startFrame + FRAME_SNAP, 1 + (i + 1) * step));
			return {
				start_frame: startFrame,
				end_frame: endFrame,
				start: this.frameToSeconds(startFrame),
				end: this.frameEndToSeconds(endFrame),
				label: `片段 ${i + 1}`,
				color,
			};
		});
	}

	updateLabels() {
		this.durationLabel.textContent = `${this.formatTime(this.duration)}`;
		this.frameRateLabel.textContent = this.frameRate ? `${Number(this.frameRate).toFixed(2).replace(/\.?0+$/, "")}` : "";
		this.framesLabel.textContent = this.totalFrames ? `${this.totalFrames}` : "";
	}

	syncVideoToTime(seconds) {
		if (!this.videoPlayer || !Number.isFinite(seconds) || this.videoPlayer.readyState < 1) return;
		this._pendingSeekTime = clamp(seconds, 0, Math.max(0, this.duration || this.videoPlayer.duration || 0));
		if (this._seekRaf) return;
		this._seekRaf = requestAnimationFrame(() => {
			this._seekRaf = null;
			const t = this._pendingSeekTime;
			this._pendingSeekTime = null;
			if (!Number.isFinite(t)) return;
			try {
				if (typeof this.videoPlayer.fastSeek === "function") {
					this.videoPlayer.fastSeek(t);
				} else {
					this.videoPlayer.currentTime = t;
				}
			} catch (_) {}
		});
	}

	getSelectedSegment() {
		if (this.selectedIndex < 0 || this.selectedIndex >= this.segments.length) return null;
		const seg = this.segments[this.selectedIndex];
		if (!seg) return null;
		const start = Math.max(0, Number(seg.start || 0));
		const end = Math.max(start + MIN_DURATION, Number(seg.end || start + MIN_DURATION));
		return { ...seg, start, end };
	}

	toggleSegmentLoop() {
		this.loopSelectedSegment = !this.loopSelectedSegment;
		this.updateLoopButton();

		if (this.loopSelectedSegment) {
			const seg = this.getSelectedSegment();
			if (seg) {
				this.syncVideoToTime(seg.start);
				this.videoPlayer?.play?.().catch?.(() => {});
			}
		}
	}

	updateLoopButton() {
		if (!this.loopBtn) return;
		const active = this.loopSelectedSegment;
		this.loopBtn.__gjjActive = active;
		this.loopBtn.textContent = active ? "🔁 循环中" : "🔁 循环";
		this.loopBtn.style.background = active ? "#2f6f5f" : "#3a3a3a";
		this.loopBtn.style.borderColor = active ? "#55c6a6" : "#555";
		this.loopBtn.style.color = active ? "#f3fffb" : "#eee";
		this.loopBtn.title = active ? "正在循环播放当前选中的分段" : "循环播放当前选中的分段";
	}

	ensureLoopPlaybackStartsInSegment() {
		if (!this.loopSelectedSegment) return;
		const seg = this.getSelectedSegment();
		if (!seg || this.videoPlayer.readyState < 1) return;
		const t = this.videoPlayer.currentTime;
		if (t < seg.start || t >= seg.end) {
			this.syncVideoToTime(seg.start);
		}
	}

	onPreviewTimeUpdate() {
		if (!this.loopSelectedSegment) return;
		const seg = this.getSelectedSegment();
		if (!seg || this.videoPlayer.readyState < 1) return;
		const t = this.videoPlayer.currentTime;
		if (t >= seg.end || t < seg.start - 0.05) {
			try {
				this.videoPlayer.currentTime = seg.start;
				if (this.videoPlayer.paused) this.videoPlayer.play?.().catch?.(() => {});
			} catch (_) {}
		}
	}

	// ─── Layout ───
	pxPerSecond() {
		const max = this.getMaxDuration();
		return max > 0 ? this._cssWidth / max : 1;
	}

	segmentRects() {
		const rects = [];
		const pps = this.pxPerSecond();
		this.normalizeAllSegmentFrames();

		for (let i = 0; i < this.segments.length; i++) {
			const seg = this.segments[i];
			const startSec = seg.start || 0;
			const endSec = seg.end || startSec + MIN_DURATION;
			const startFrame = seg.start_frame || 1;
			const endFrame = seg.end_frame || (FRAME_SNAP + 1);
			const x = this.frameToX(startFrame);
			const right = this.frameToX(endFrame);

			rects.push({
				index: i,
				x,
				w: Math.max(2, right - x),
				startSec,
				endSec,
				startFrame,
				endFrame,
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
			this.normalizeAllSegmentFrames();
			this.dragBaseline = this.segments.map(s => ({
				start: s.start || 0,
				end: s.end || 0,
				start_frame: s.start_frame || 1,
				end_frame: s.end_frame || (FRAME_SNAP + 1),
			}));
			this.dragStart = { x };
			try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
			return;
		}
		const block = this.hitBlock(x, y);
		if (block >= 0) {
			this.selectedIndex = block;
			if (this.loopSelectedSegment) {
				const seg = this.getSelectedSegment();
				if (seg) this.syncVideoToTime(seg.start);
			}
			this.render();
			return;
		}
		this.selectedIndex = -1;
		if (this.loopSelectedSegment) {
			this.loopSelectedSegment = false;
			this.updateLoopButton();
		}
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
				this.segments[i].start_frame = baseline[i].start_frame;
				this.segments[i].end_frame = baseline[i].end_frame;
			}
			const boundaryTime = this._shiftBoundary(handle, dx);
			this._ensureMinDuration();
			this.updateTotalLabel();
			this.syncVideoToTime(boundaryTime);
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
			this.commit();
			// 不再自动刷新，由用户手动点击刷新按钮更新缩略图
		}
	}

	// ─── Manipulation ───
	addSegment() {
		this.normalizeAllSegmentFrames();
		if (!this.segments.length) {
			this.segments = this.makeAutoSegments(1);
			this.selectedIndex = 0;
			this.commit();
			this.updateTotalLabel();
			this.render();
			return;
		}

		const index = clamp(this.selectedIndex, 0, this.segments.length - 1);
		const target = this.segments[index];
		const startFrame = Number(target.start_frame || 1);
		const endFrame = Number(target.end_frame || startFrame);
		const units = Math.round((endFrame - startFrame) / FRAME_SNAP);
		if (units < 2) return;

		const leftUnits = Math.max(1, Math.min(units - 1, Math.round(units / 2)));
		const splitFrame = startFrame + leftUnits * FRAME_SNAP;
		const colors = new Set(this.segments.map(s => s.color));

		const left = {
			...target,
			start_frame: startFrame,
			end_frame: splitFrame,
			start: this.frameToSeconds(startFrame),
			end: this.frameEndToSeconds(splitFrame),
		};
		const right = {
			...target,
			start_frame: splitFrame,
			end_frame: endFrame,
			start: this.frameToSeconds(splitFrame),
			end: this.frameEndToSeconds(endFrame),
			color: pickColor(colors),
		};
		this.segments.splice(index, 1, left, right);
		this.relabelSegments();
		this.selectedIndex = index + 1;
		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	distributeEvenly() {
		if (this.segments.length === 0) return;
		const maxAnchor = this.getMaxAnchorFrame();
		if (maxAnchor <= 1) {
			this.segments = [this.makeAutoSegments(1)[0]];
			this.selectedIndex = 0;
			this.commit();
			this.updateTotalLabel();
			this.render();
			return;
		}
		const step = Math.max(FRAME_SNAP, Math.round(((maxAnchor - 1) / this.segments.length) / FRAME_SNAP) * FRAME_SNAP);
		for (let i = 0; i < this.segments.length; i++) {
			const startFrame = Math.min(Math.max(1, maxAnchor - FRAME_SNAP), 1 + i * step);
			const endFrame = i === this.segments.length - 1 ? maxAnchor : Math.min(maxAnchor, Math.max(startFrame + FRAME_SNAP, 1 + (i + 1) * step));
			this.segments[i].start_frame = startFrame;
			this.segments[i].end_frame = endFrame;
			this.segments[i].start = this.frameToSeconds(startFrame);
			this.segments[i].end = this.frameEndToSeconds(endFrame);
		}
		this.commit();
		this.updateTotalLabel();
		this.render();
	}

	deleteSelected() {
		if (this.segments.length <= 1) return;
		if (this.selectedIndex < 0 || this.selectedIndex >= this.segments.length) return;
		this.normalizeAllSegmentFrames();
		const removed = this.segments[this.selectedIndex];
		const index = this.selectedIndex;
		this.segments.splice(index, 1);

		if (index > 0) {
			const prev = this.segments[index - 1];
			prev.end_frame = removed.end_frame;
			prev.end = this.frameEndToSeconds(prev.end_frame);
			this.selectedIndex = index - 1;
		} else if (this.segments.length > 0) {
			const next = this.segments[0];
			next.start_frame = removed.start_frame;
			next.start = this.frameToSeconds(next.start_frame);
			this.selectedIndex = 0;
		}

		this.relabelSegments();
		this.commit();
		this.updateTotalLabel();
		if (this.loopSelectedSegment) {
			const seg = this.getSelectedSegment();
			if (seg) this.syncVideoToTime(seg.start);
		}
		this.render();
	}

	relabelSegments() {
		for (let i = 0; i < this.segments.length; i++) {
			this.segments[i].label = `片段 ${i + 1}`;
		}
	}

	_shiftBoundary(index, delta) {
		if (index < 0 || index >= this.segments.length - 1) return 0;
		const left = this.segments[index];
		const right = this.segments[index + 1];
		this.normalizeSegmentFrames(left);
		this.normalizeSegmentFrames(right);
		const minFrame = (left.start_frame || 0) + FRAME_SNAP;
		const maxFrame = (right.end_frame || this.getMaxAnchorFrame()) - FRAME_SNAP;
		const proposedFrame = this.secondsToFrame(this.frameToSeconds(left.end_frame || 1) + delta);
		const boundaryFrame = clamp(proposedFrame, minFrame, maxFrame);
		const newStart = this.frameToSeconds(boundaryFrame);
		left.end = this.frameEndToSeconds(boundaryFrame);
		left.end_frame = boundaryFrame;
		right.start = newStart;
		right.start_frame = boundaryFrame;
		return newStart;
	}

	_ensureMinDuration() {
		for (const seg of this.segments) {
			this.normalizeSegmentFrames(seg);
		}
	}

	// ─── Commit & Sync ───
	// 提交分段数据到widget
	commit() {
		this._syncSegmentsJSON();
		this._syncProperties();
		this.node.graph?.setDirtyCanvas?.(true, true);
		this.syncOutputs();
	}

	_syncSegmentsJSON() {
		const widget = this.node.widgets?.find(w => w.name === "segments_json");

		if (widget) {
			widget.value = JSON.stringify(this.serializeSegments());

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

		this.node.properties.segments = JSON.stringify(this.serializeSegments());

		refreshNodeCanvas(this.node);
	}

	syncOutputs() {
		const targetCount = Math.max(1, this.segments.length);
		scheduleStabilize(this.node, targetCount);
	}

	updateTotalLabel() {
		this.normalizeAllSegmentFrames();
		const total = this.segments.reduce((sum, s) => sum + Math.max(1, (s.end_frame || 1) - (s.start_frame || 1) + 1), 0);
		this.totalLabel.textContent = `合计: ${total}帧`;
	}

	async refreshVideo() {
		if (!this.node || !this.node.graph) return;

		console.log("[GJJ] 刷新视频预览: 只执行当前节点");

		const btn = this.refreshBtn;
		const originalText = btn.textContent;

		try {
			btn.textContent = "🔄 刷新中...";
			btn.disabled = true;
			btn.style.cursor = "not-allowed";
			btn.style.opacity = "0.65";

			// 直接同步数据，不调用 commit()（与音频编辑器一致）
			this._syncSegmentsJSON();
			this._syncProperties();
			this.setRefreshNonce();

			// 使用专用函数只刷新当前节点
			const ok = await queueOnlyCurrentNode(this.node);

			if (!ok) {
				console.warn("[GJJ] 当前节点刷新失败：queueOnlyCurrentNode 返回 false");
			}
		} catch (err) {
			console.error("[GJJ] 刷新视频失败:", err);
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

	// ─── Rendering ───
	render() {
		const ctx = this.ctx;
		const width = this._cssWidth;
		const height = CANVAS_HEIGHT;
		this.updateLoopButton();

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

		const maxFrame = this.getMaxAnchorFrame();
		const tickFrameInterval = this._getTickFrameInterval(width, maxFrame);

		ctx.fillStyle = "#aaa";
		ctx.font = "10px sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";

		for (let offset = 0; offset <= maxFrame - 1; offset += tickFrameInterval) {
			const frame = 1 + offset;
			const x = this.frameToX(frame);
			if (x > width) break;

			ctx.beginPath();
			ctx.moveTo(x, RULER_HEIGHT - 6);
			ctx.lineTo(x, RULER_HEIGHT);
			ctx.strokeStyle = "#666";
			ctx.stroke();

			ctx.fillText(String(frame), x, 4);
		}
	}

	_getTickFrameInterval(width, maxFrame) {
		const rawFrames = Math.max(FRAME_SNAP, ((maxFrame - 1) / Math.max(1, width)) * 86);
		const candidates = [8, 16, 24, 32, 48, 64, 80, 120, 160, 240, 320, 480, 640, 960, 1440, 1920];
		for (const c of candidates) {
			if (c >= rawFrames) return c;
		}
		return Math.max(FRAME_SNAP, Math.round(rawFrames / FRAME_SNAP) * FRAME_SNAP);
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
		const timeText = `${rect.startFrame} - ${rect.endFrame}f`;

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
		const displayText = `${labelText} ${timeText}`;
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
			if (!newSegments.length && this.segments.length) {
				console.warn("[GJJ] 视频分段编辑器 - 后端分段数据解析为空，保留当前面板分段。", data.preview_segments);
			} else {

				// 清除旧的缩略图引用，强制重新加载
				this.segments.forEach(seg => {
					if (seg._thumbnailImage) {
						seg._thumbnailImage = null;
					}
				});

				this.segments = newSegments;
			}
		}

		// 更新分段缩略图
		if (data.segment_thumbnails !== undefined) {
			try {
				const thumbnails = JSON.parse(data.segment_thumbnails);
				if (Array.isArray(thumbnails)) {
					for (let i = 0; i < thumbnails.length && i < this.segments.length; i++) {
						this.segments[i].thumbnail = thumbnails[i];
						// 清除旧的图片引用，触发重新加载
						if (this.segments[i]._thumbnailImage) {
							this.segments[i]._thumbnailImage = null;
						}
					}
				}
			} catch (e) {
				console.error('[GJJ] 解析分段缩略图失败:', e);
			}
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

		this.updateLabels();
		this.updateTotalLabel();
		this._syncSegmentsJSON();
		this._syncProperties();

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
		const videoUrl = videoDataToUrl(previewVideoData);
		console.log('[GJJ] 视频分段编辑器 - updateVideoPreview:', {
			previewVideoData,
			videoUrl,
		});

		if (videoUrl) {
			this.setPreviewSource(videoUrl);
		} else if (!this.videoPlayer?.src) {
			this.setPreviewSource(null);
			this.emptyPreview.textContent = hasExternalVideoConnection(this.node) ? "外部视频执行后显示预览" : "暂无预览";
		}
	}

}

// ─── Node Registration ───
app.registerExtension({
	name: `GJJ.${NODE_NAME}`,

	beforeRegisterNodeDef(nodeType, nodeData, appInstance) {
		if (nodeData.name !== NODE_NAME) return;

		const applyHiddenWidgets = (node) => {
			for (const name of HIDDEN_WIDGET_NAMES) {
				hideWidget(node.widgets?.find(w => w.name === name));
			}
			GJJ_Utils.refreshNode(node);
		};

		const origOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function() {
			const result = origOnConfigure?.apply(this, arguments);
			requestAnimationFrame(() => {
				applyHiddenWidgets(this);
				this.__gjjVideoSegmentEditor?.restoreStateFromNode();
				const videoFileWidget = this.widgets?.find(w => w.name === "video_file");
				if (!hasExternalVideoConnection(this) && videoFileWidget?.value && this.__gjjVideoSegmentEditor) {
					this.__gjjVideoSegmentEditor.updatePreviewFromFile(videoFileWidget.value);
				}
			});
			return result;
		};

		const origOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function(size) {
			const result = origOnResize?.apply(this, arguments);
			this.__gjjVideoSegmentEditor?.resizeCanvas();
			this.__gjjVideoSegmentEditor?.updateOpenButtonState();
			if (this._videoSegmentEditorWidget) {
				const previewHeight = this.__gjjVideoSegmentEditor?._stablePreviewHeight;
				const height = previewHeight ? previewHeight + CANVAS_HEIGHT + 86 : getEditorHeightForWidth(this);
				this._videoSegmentEditorWidget.getHeight = () => height;
				this._videoSegmentEditorWidget.getMinHeight = () => height;
			}
			return result;
		};

		const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function(type, slotIndex, connected, linkInfo, ioSlot) {
			const result = origOnConnectionsChange?.apply(this, arguments);
			const input = this.inputs?.[slotIndex];
			if (input?.name === "video" || input?.label === "外部视频" || input?.localized_name === "外部视频") {
				const editor = this.__gjjVideoSegmentEditor;
				editor?.updateOpenButtonState();
				if (hasExternalVideoConnection(this)) {
					editor?.resetForExternalVideo();
					clearTimeout(this.__gjjExternalVideoRefreshTimer);
					this.__gjjExternalVideoRefreshTimer = setTimeout(() => {
						this.__gjjVideoSegmentEditor?.refreshVideo();
					}, 120);
				} else {
					const videoFileWidget = this.widgets?.find(w => w.name === "video_file");
					editor?.updatePreviewFromFile(videoFileWidget?.value || "");
				}
			}
			return result;
		};

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
					segment_thumbnails: message.segment_thumbnails?.[0],  // 分段缩略图
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

			applyHiddenWidgets(this);

			// Hook video_file widget to trigger re-execution on change
			const videoFileWidget = this.widgets?.find(w => w.name === "video_file");
			if (videoFileWidget) {
				const origCallback = videoFileWidget.callback;
				const self = this;
				videoFileWidget.callback = function (...args) {
					const result = origCallback?.apply(this, args);
					self.__gjjPendingVideoFile = this.value;
					self.__gjjVideoSegmentEditor?.updatePreviewFromFile(this.value);
					return result;
				};
			}

			// Build editor inside a DOM widget
			const container = document.createElement("div");

			const self = this;

			this._videoSegmentEditorWidget = this.addDOMWidget("video_segment_editor_canvas", "GJJVideoSegmentEditor", container, {
				serialize: false,
				hideOnZoom: false,
				getMinHeight: () => getEditorHeightForWidth(this),
				getHeight: () => getEditorHeightForWidth(this),
			});

			setTimeout(() => {
				try {
					this.__gjjVideoSegmentEditor = new VideoSegmentEditorWidget(self, container);
					this.__gjjVideoSegmentEditor.restoreStateFromNode();
					const pending = this.__gjjPendingVideoFile || videoFileWidget?.value;
					if (!hasExternalVideoConnection(this) && pending) this.__gjjVideoSegmentEditor.updatePreviewFromFile(pending);
					applyHiddenWidgets(this);
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
					{
						content: "只刷新当前节点",
						callback: () => {
							this.__gjjVideoSegmentEditor.refreshVideo();
						},
					},
				);
			}

			return result;
		};
	},
});

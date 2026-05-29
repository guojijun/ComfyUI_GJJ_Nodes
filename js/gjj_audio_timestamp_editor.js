import { GJJ_Utils, queueNode } from "./gjj_utils.js";
const { app } = window.comfyAPI.app;
const api = window.comfyAPI?.api?.api || window.api;

const NODE_NAME = "GJJ_AudioTimestampEditor";
const CANVAS_HEIGHT = 118;
const RULER_HEIGHT = 18;
const WAVE_Y = RULER_HEIGHT + 4;
const WAVE_H = 72;
const HANDLE_HIT_PX = 7;
const MIN_DURATION = 0.05;
const DEFAULT_SEGMENT_DURATION = 3.0;
const SEGMENT_LIST_NAME = "分段列表";
const OUTPUT_DISPLAY_PREFIX = "音频片段";

const HIDDEN_WIDGET_NAMES = [
	"segments_json", "分段列表JSON",
	"preview_text", "preview_kind", "preview_audio", "preview_sample_rate",
	"preview_duration", "preview_segments", "preview_segment_count",
	"segment_count",
	"segment_duration", "单段时长",
];

function isHiddenWidget(w) {
	if (!w) return false;
	const names = [
		w.name,
		w.label,
		w.localized_name,
		w.options?.display_name,
		w.options?.label,
	].map(v => String(v || ""));
	return names.some(v => HIDDEN_WIDGET_NAMES.includes(v));
}

function withHiddenWidgetsFiltered(node, fn) {
	if (!node?.widgets) return fn();
	const oldWidgets = node.widgets;
	for (const w of oldWidgets) if (isHiddenWidget(w)) hideWidget(w);
	const visible = oldWidgets.filter(w => !isHiddenWidget(w));
	try {
		node.widgets = visible;
		return fn();
	} finally {
		node.widgets = oldWidgets;
	}
}

const SEGMENT_COLORS = [
	"#4f8edc", "#e07b3a", "#5cb85c", "#d9534f", "#9b6cd6",
	"#a07060", "#e377c2", "#7f7f7f", "#c4c447", "#3fbac4",
];

function clamp(v, min, max) {
	return Math.max(min, Math.min(max, v));
}

function stop(e) {
	e?.stopPropagation?.();
}

function refreshNodeCanvas(node) {
	try { node?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { node?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app?.canvas?.setDirty?.(true, true); } catch (_) {}
}


function safeWidgetSet(w, key, value) {
	try {
		w[key] = value;
	} catch (_) {
		// ComfyUI 新版 BaseWidget 的部分属性只有 getter，不能直接写。
	}
}

function hideWidget(w) {
	if (!w) return;
	if (!w.__gjjAudioHiddenState) {
		w.__gjjAudioHiddenState = {
			type: w.type,
			draw: w.draw,
			computeSize: w.computeSize,
			mouse: w.mouse,
		};
	}

	// 关键：既保留 widget.value 参与后端传参，又彻底取消绘制、命中和布局高度。
	w.type = "hidden";
	w.hidden = true;
	w.disabled = true;
	w.advanced = true;
	w.options = w.options || {};
	w.options.hidden = true;
	w.draw = () => {};
	w.mouse = () => false;
	w.computeSize = () => [0, 0];
	safeWidgetSet(w, "last_y", 0);
	safeWidgetSet(w, "y", -100000);
	safeWidgetSet(w, "computedHeight", 0);
	safeWidgetSet(w, "margin", 0);
	// 不要直接写 w.height：LiteGraph BaseWidget 在新版里 height 是只读 getter，会导致节点创建失败。
	try {
		const desc = Object.getOwnPropertyDescriptor(w, "height") || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w) || {}, "height");
		if (!desc || desc.writable || desc.set) safeWidgetSet(w, "height", 0);
	} catch (_) {}
	w.serializeValue = w.serializeValue || (() => w.value);

	if (w.inputEl?.style) {
		w.inputEl.style.display = "none";
		w.inputEl.style.pointerEvents = "none";
	}
	if (w.element?.style) {
		w.element.style.display = "none";
		w.element.style.pointerEvents = "none";
	}
}

function hideInternalWidgets(node) {
	if (!node?.widgets) return;
	for (const w of node.widgets) {
		if (isHiddenWidget(w)) hideWidget(w);
	}
}

function parseSegments(text) {
	try {
		const parsed = JSON.parse(text || "[]");
		return Array.isArray(parsed) ? parsed.filter(s => s && typeof s === "object" && ("start" in s || "end" in s)) : [];
	} catch (_) {
		return [];
	}
}

function audioDataToUrl(previewAudio) {
	if (!previewAudio || !Array.isArray(previewAudio) || previewAudio.length === 0) return null;
	const data = previewAudio[0];
	if (!data?.filename) return null;
	// 加 _t：即使后端复用了同名临时文件，也强制浏览器重新读取，避免上游音频变化后波形仍显示旧缓存。
	return `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type || "temp"}&subfolder=${encodeURIComponent(data.subfolder || "")}&_t=${Date.now()}`;
}

function getWidgetValue(node, name, fallback = null) {
	const w = node.widgets?.find(x => x.name === name);
	return w ? w.value : fallback;
}

function hasSelectedAudioFile(node) {
	const value = String(getWidgetValue(node, "audio_file", "[不加载]") || "").trim();
	return !!value && value !== "[不加载]";
}

function setWidgetValue(node, name, value) {
	const w = node.widgets?.find(x => x.name === name);
	if (!w) return;
	w.value = value;
	try { w.callback?.(value); } catch (_) {}
	try { node.setDirtyCanvas?.(true, true); } catch (_) {}
	try { node.graph?.change?.(); } catch (_) {}
}

function syncNodeWidgetValues(node) {
	// 新版 ComfyUI 在提交 Prompt 时有时会优先读取 widgets_values 缓存。
	// 隐藏 widget 的 value 改了以后，必须同步这个缓存，否则后端会继续收到旧的 segments_json。
	if (!node?.widgets) return;
	try {
		node.widgets_values = node.widgets.map(w => {
			try {
				if (typeof w.serializeValue === "function") return w.serializeValue(node, w);
			} catch (_) {}
			return w.value;
		});
	} catch (_) {}
}

function syncEditorStateToNode(node) {
	if (!node?._editor) return false;
	try {
		node._editor.applyPendingDurationInput?.(false);
		node._editor.segments.forEach(s => node._editor.normalizeSegment(s));
		const segmentsText = JSON.stringify(node._editor.segments || []);
		setWidgetValue(node, "segments_json", segmentsText);
		setWidgetValue(node, "segment_duration", node._editor.segmentDuration);
		node.properties = node.properties || {};
		node.properties.segments = segmentsText;
		node.properties.segment_duration = node._editor.segmentDuration;
		syncNodeWidgetValues(node);
		refreshNodeCanvas(node);
		return true;
	} catch (err) {
		console.warn("[GJJ] 音频分段编辑器同步执行参数失败：", err);
		return false;
	}
}

function syncAllAudioSegmentEditors() {
	for (const node of app.graph?._nodes || []) {
		if (node?.comfyClass === NODE_NAME || node?.type === NODE_NAME) syncEditorStateToNode(node);
	}
}


function getInputLinkSignature(node) {
	try {
		const idx = getAudioInputIndex(node);
		const input = idx >= 0 ? node.inputs?.[idx] : null;
		const linkId = input?.link;
		if (linkId == null) return "no-link";
		const link = node.graph?.links?.[linkId] || app.graph?.links?.[linkId];
		return `link=${linkId}|origin=${link?.origin_id ?? "?"}|slot=${link?.origin_slot ?? "?"}`;
	} catch (_) {
		return "link-error";
	}
}

function getRefreshSignature(node, reason = "") {
	try {
		const audioFile = getWidgetValue(node, "audio_file", "[不加载]");
		const segments = node?.properties?.segments || getWidgetValue(node, "segments_json", "[]");
		const duration = node?.properties?.segment_duration || getWidgetValue(node, "segment_duration", DEFAULT_SEGMENT_DURATION);
		return [getInputLinkSignature(node), audioFile, String(segments || "[]"), String(duration || ""), String(reason || "")].join("||");
	} catch (_) {
		return `${Date.now()}`;
	}
}

function markRefreshScheduled(node, signature, cooldownMs = 650) {
	if (!node) return false;
	const now = performance.now();
	// 同一个刷新签名在短时间内只允许排队一次，避免 onExecuted / onConnectionsChange / 文件回调互相触发。
	if (node.__gjjAudioRefreshInFlight) {
		node.__gjjAudioRefreshPendingSignature = signature;
		return false;
	}
	if (node.__gjjLastRefreshSignature === signature && now - (node.__gjjLastRefreshAt || 0) < cooldownMs) {
		return false;
	}
	node.__gjjLastRefreshSignature = signature;
	node.__gjjLastRefreshAt = now;
	return true;
}

function clearRefreshInFlight(node) {
	if (!node) return;
	node.__gjjAudioRefreshInFlight = false;
	node.__gjjAudioRefreshFinishedAt = performance.now();
	// pending 只记录，不立即二次 queue；下一次真实变化再触发，防止“执行完成 → 刷新 → 执行完成”循环。
	node.__gjjAudioRefreshPendingSignature = null;
}

function pickColor(existingColors) {
	for (const c of SEGMENT_COLORS) if (!existingColors.has(c)) return c;
	const hue = (existingColors.size * 137.508) % 360;
	return `hsl(${hue.toFixed(0)}, 55%, 55%)`;
}

function isExecutionOutputNode(node) {
	if (!node) return false;
	return node.comfyClass === NODE_NAME || node.constructor?.nodeData?.output_node === true || node.nodeData?.output_node === true || node.flags?.output === true;
}

function collectUpstreamNodeIds(node) {
	// 当前节点单独刷新时，不能把它的上游输出节点临时禁用。
	// 否则 ComfyUI 会只执行本节点，但 optional audio 拿不到上游结果，后端就收到 audio=None。
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

async function queueOnlyCurrentNode(node) {
	if (!node || !node.graph) return false;
	if (node.__gjjAudioRefreshInFlight) return false;
	node.__gjjAudioRefreshInFlight = true;
	const graph = node.graph || app.graph;
	const allNodes = graph?._nodes || app.graph?._nodes || [];
	const upstreamNodeIds = collectUpstreamNodeIds(node);
	const savedModes = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;
	try {
		for (const n of allNodes) {
			if (!n || n === node) continue;
			// 只禁用“无关的”输出节点；上游链路必须保留，否则外部音频输入会变成 None。
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
		syncNodeWidgetValues(node);
		refreshNodeCanvas(node);
		if (typeof app.queuePrompt === "function") {
			await app.queuePrompt(0, 1);
			return true;
		}
		return false;
	} finally {
		for (const [n, mode] of savedModes) n.mode = mode;
		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}
		clearRefreshInFlight(node);
		refreshNodeCanvas(node);
	}
}

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
		this.hoverHandle = null;
		this.dragMode = null;
		this.dragStart = null;
		this.dragBaseline = null;
		this.loopSelection = true;
		this.showListOutput = Boolean(node.properties?.gjj_show_segment_list);
		this.showAllOutputs = Boolean(node.properties?.gjj_show_all_audio_outputs);
		this.segmentDuration = Number(node.properties?.segment_duration || getWidgetValue(node, "segment_duration", DEFAULT_SEGMENT_DURATION)) || DEFAULT_SEGMENT_DURATION;
		this._heightTimer = null;
		this._durationInputTimer = null;
		this.buildDOM();
		this.bindEvents();
		this.resizeCanvas();
		this.setStatus("");
	}

	getMaxDuration() {
		return Math.max(MIN_DURATION, Number(this.duration || 0) || 60);
	}

	formatTime(seconds) {
		seconds = Math.max(0, Number(seconds || 0));
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return mins > 0 ? `${mins}:${secs.toFixed(1).padStart(4, "0")}` : secs.toFixed(1);
	}

	makeEmojiButton(label, tooltip) {
		const b = document.createElement("button");
		b.textContent = label;
		b.title = tooltip || "";
		b.style.cssText = `
			width: 28px; height: 26px; min-width: 28px; padding: 0;
			border-radius: 7px; border: 1px solid #555; background: #31363b;
			color: #eee; cursor: pointer; font-size: 14px; line-height: 24px;
			display: inline-flex; align-items: center; justify-content: center;
		`;
		b.addEventListener("pointerdown", stop);
		b.addEventListener("mouseenter", () => { if (!b.disabled) b.style.background = "#454b52"; });
		b.addEventListener("mouseleave", () => { if (!b.disabled) b.style.background = b.__active ? "#385f86" : "#31363b"; });
		return b;
	}

	setButtonActive(btn, active) {
		if (!btn) return;
		btn.__active = !!active;
		btn.style.background = active ? "#385f86" : "#31363b";
		btn.style.borderColor = active ? "#6fb4ff" : "#555";
	}

	bindToolButton(btn, handler) {
		// ComfyUI/LiteGraph 会拦截节点内部的鼠标事件；这里用 pointerup + click 双保险。
		// 同时不用 cloneNode，避免丢失事件。
		let firedAt = 0;
		const run = (e) => {
			e?.preventDefault?.();
			e?.stopPropagation?.();
			if (btn?.disabled) return;
			const now = performance.now();
			if (now - firedAt < 120) return;
			firedAt = now;
			try { handler?.(); } catch (err) { console.error("[GJJ] 工具按钮执行失败：", err); }
		};
		btn.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); });
		btn.addEventListener("pointerup", run);
		btn.addEventListener("click", run);
	}

	buildDOM() {
		this.container.innerHTML = "";
		this.container.style.cssText = `
			display: flex; flex-direction: column; gap: 5px; padding: 5px 8px;
			box-sizing: border-box; font-family: sans-serif; font-size: 11px;
			color: #ddd; width: 100%; overflow: hidden;
		`;

		const toolbar = document.createElement("div");
		toolbar.style.cssText = `display:flex; gap:5px; align-items:center; flex-wrap:nowrap; width:100%;`;
		this.addBtn = this.makeEmojiButton("➕", "添加一个新分段");
		this.distributeBtn = this.makeEmojiButton("⚖️", "按当前分段数量均分整段音频");
		this.deleteBtn = this.makeEmojiButton("🗑️", "删除当前选中的分段，至少保留 1 段");
		this.playBtn = this.makeEmojiButton("⏯", "播放/暂停当前选中的分段；会自动跳到分段起点");
		this.folderBtn = this.makeEmojiButton("📁", "打开本地磁盘音频/视频文件；会上传到 ComfyUI input 目录，视频只提取音频；选择后自动刷新");
		this.listBtn = this.makeEmojiButton("📋", "显示/隐藏【分段列表】输出口；默认隐藏，不挤出空行");
		this.outputBtn = this.makeEmojiButton("🔌", "显示/收起全部音频分段输出口；默认只显示音频片段1");
		this.loopBtn = this.makeEmojiButton("🔁", "循环播放当前选中的分段");

		const durationWrap = document.createElement("label");
		durationWrap.title = "单段时长：默认按这个时长从音频中截取一段；波形中的高亮区域可拖动、左右边缘可拉长拉短";
		durationWrap.style.cssText = `
			display:inline-flex; align-items:center; gap:3px; height:26px; margin-left:auto;
			background:#252a2f; border:1px solid #444; border-radius:7px; padding:0 5px;
		`;
		const clock = document.createElement("span");
		clock.textContent = "⏱";
		this.durationInput = document.createElement("input");
		this.durationInput.type = "number";
		this.durationInput.min = String(MIN_DURATION);
		this.durationInput.step = "0.1";
		this.durationInput.value = String(this.segmentDuration);
		this.durationInput.style.cssText = `width:48px; background:transparent; color:#eee; border:0; outline:0; font-size:11px;`;
		this.durationInput.title = durationWrap.title;
		durationWrap.append(clock, this.durationInput);

		this.playTimeLabel = document.createElement("span");
		this.playTimeLabel.textContent = "0.0 / 0.0";
		this.playTimeLabel.title = "当前播放时间 / 当前分段结束时间";
		this.playTimeLabel.style.cssText = "color:#aaa; font-size:10px; min-width:54px; white-space:nowrap;";

		toolbar.append(this.folderBtn, this.addBtn, this.distributeBtn, this.deleteBtn, this.playBtn, this.listBtn, this.outputBtn, this.loopBtn, this.playTimeLabel, durationWrap);
		this.container.appendChild(toolbar);

		this.audioPlayer = document.createElement("audio");
		this.audioPlayer.controls = false;
		this.audioPlayer.preload = "auto";
		this.audioPlayer.style.cssText = `display:none; width:0; height:0;`;
		this.container.appendChild(this.audioPlayer);

		this.fileInput = document.createElement("input");
		this.fileInput.type = "file";
		this.fileInput.accept = "audio/*,video/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus,.wma,.aiff,.aif,.mp4,.mov,.mkv,.avi,.webm,.m4v,.flv,.wmv,.mpeg,.mpg";
		this.fileInput.style.display = "none";
		this.container.appendChild(this.fileInput);

		this.canvas = document.createElement("canvas");
		this.canvas.title = "拖动高亮区域改变位置；拖动左右边缘调整起止时间；点击选中分段";
		this.canvas.style.cssText = `
			width:100%; height:${CANVAS_HEIGHT}px; display:block; background:#171b1f;
			box-sizing:border-box; border:1px solid #2e363d; border-radius:6px; cursor:default; flex-shrink:0;
		`;
		this.container.appendChild(this.canvas);
		this.ctx = this.canvas.getContext("2d");

		const infoRow = document.createElement("div");
		infoRow.style.cssText = `display:flex; align-items:center; gap:8px; color:#888; font-size:10px; min-height:12px;`;
		this.rangeLabel = document.createElement("span");
		this.rangeLabel.textContent = "--";
		this.metaLabel = document.createElement("span");
		this.metaLabel.style.cssText = "margin-left:auto;";
		infoRow.append(this.rangeLabel, this.metaLabel);
		this.container.appendChild(infoRow);

		this.statusDisplay = document.createElement("div");
		this.statusDisplay.style.cssText = `
			display:none; margin-top:2px; padding:6px 8px; border-radius:8px;
			background:#172129; border:1px solid #2d4653; color:#9fd3ff;
			white-space:pre-wrap; font-size:11px; line-height:1.35;
		`;
		this.copyBtn = document.createElement("button");
		GJJ_Utils.applyDependencyCopyButton(this.copyBtn, { visible: false });
		this.copyBtn.style.marginTop = "8px";
		this.copyBtn.addEventListener("pointerdown", stop);
		this.statusDisplay.appendChild(this.copyBtn);
		this.container.appendChild(this.statusDisplay);

		this.setButtonActive(this.listBtn, this.showListOutput);
		this.setButtonActive(this.outputBtn, this.showAllOutputs);
		this.setButtonActive(this.loopBtn, this.loopSelection);
	}

	bindEvents() {
		for (const el of [this.container, this.canvas, this.durationInput]) {
			el.addEventListener("pointerdown", stop);
			el.addEventListener("wheel", stop, { passive: true });
		}
		this.canvas.addEventListener("pointerdown", e => { stop(e); this.onPointerDown(e); });
		this.canvas.addEventListener("pointermove", e => { stop(e); this.onPointerMove(e); });
		this.canvas.addEventListener("pointerup", e => { stop(e); this.onPointerUp(e); });
		this.canvas.addEventListener("pointerleave", () => {
			if (!this.dragMode) {
				this.hoverIndex = -1;
				this.hoverHandle = null;
				this.canvas.style.cursor = "default";
				this.render();
			}
		});
		this.canvas.addEventListener("contextmenu", e => { e.preventDefault(); stop(e); });

		this.bindToolButton(this.addBtn, () => this.addSegment());
		this.bindToolButton(this.distributeBtn, () => this.distributeEvenly());
		this.bindToolButton(this.deleteBtn, () => this.deleteSelected());
		this.bindToolButton(this.playBtn, () => this.toggleSelectedPlayback());
		this.bindToolButton(this.folderBtn, () => this.openDiskMedia());
		this.bindToolButton(this.listBtn, () => this.toggleListOutput());
		this.bindToolButton(this.outputBtn, () => this.toggleAllOutputs());
		this.bindToolButton(this.loopBtn, () => {
			this.loopSelection = !this.loopSelection;
			this.setButtonActive(this.loopBtn, this.loopSelection);
		});
		this.durationInput.addEventListener("input", () => {
			clearTimeout(this._durationInputTimer);
			this._durationInputTimer = setTimeout(() => this.applyPendingDurationInput(true), 120);
		});
		this.durationInput.addEventListener("change", () => this.applySegmentDuration(true));
		this.durationInput.addEventListener("blur", () => this.applyPendingDurationInput(true));
		this.durationInput.addEventListener("keydown", e => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				this.applySegmentDuration(true);
				this.durationInput.blur?.();
			}
		});

		this.audioPlayer.addEventListener("timeupdate", () => this.onAudioTimeUpdate());
		this.audioPlayer.addEventListener("play", () => { this.seekToSelectedStart(); this.setButtonActive(this.playBtn, true); });
		this.audioPlayer.addEventListener("pause", () => this.setButtonActive(this.playBtn, false));
		this.audioPlayer.addEventListener("ended", () => this.setButtonActive(this.playBtn, false));

		this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
		this.resizeObserver.observe(this.container);
	}

	resizeCanvas() {
		const dpr = window.devicePixelRatio || 1;
		// 以 getBoundingClientRect 为唯一坐标基准：绘制、命中、拖拽都使用同一套 CSS 像素，
		// 避免浏览器缩放、DPR、滚动条或边框造成波形与选择框错位。
		const rect = this.canvas.getBoundingClientRect?.();
		const cssW = Math.max(50, rect?.width || this.canvas.clientWidth || this.canvas.offsetWidth || this.container.clientWidth || 420);
		this.canvas.width = Math.round(cssW * dpr);
		this.canvas.height = Math.round(CANVAS_HEIGHT * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this._cssWidth = cssW;
		this.render();
	}

	pxPerSecond() {
		return this._cssWidth / this.getMaxDuration();
	}

	segmentRects() {
		const pps = this.pxPerSecond();
		return this.segments.map((seg, index) => {
			const startSec = clamp(Number(seg.start || 0), 0, this.getMaxDuration());
			const endSec = clamp(Number(seg.end || startSec + MIN_DURATION), startSec + MIN_DURATION, this.getMaxDuration());
			return { index, x: startSec * pps, w: Math.max(3, (endSec - startSec) * pps), startSec, endSec };
		});
	}

	localPos(e) {
		const rect = this.canvas.getBoundingClientRect();
		const w = Math.max(1, rect.width);
		const h = Math.max(1, rect.height);
		return {
			x: clamp((e.clientX - rect.left) / w * (this._cssWidth || w), 0, this._cssWidth || w),
			y: clamp((e.clientY - rect.top) / h * CANVAS_HEIGHT, 0, CANVAS_HEIGHT),
		};
	}

	hitTest(mx, my) {
		if (my < WAVE_Y || my > WAVE_Y + WAVE_H) return { index: -1, handle: null };
		const rects = this.segmentRects();
		for (let i = rects.length - 1; i >= 0; i--) {
			const r = rects[i];
			if (Math.abs(mx - r.x) <= HANDLE_HIT_PX) return { index: r.index, handle: "left" };
			if (Math.abs(mx - (r.x + r.w)) <= HANDLE_HIT_PX) return { index: r.index, handle: "right" };
			if (mx >= r.x && mx <= r.x + r.w) return { index: r.index, handle: "move" };
		}
		return { index: -1, handle: null };
	}

	onPointerDown(e) {
		const { x, y } = this.localPos(e);
		const hit = this.hitTest(x, y);
		if (hit.index >= 0) {
			this.selectedIndex = hit.index;
			this.dragMode = hit.handle;
			this.dragStart = { x };
			const seg = this.segments[hit.index];
			this.dragBaseline = { start: Number(seg.start || 0), end: Number(seg.end || 0) };
			try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
			this.render();
			return;
		}
		this.selectedIndex = -1;
		this.render();
	}

	onPointerMove(e) {
		const { x, y } = this.localPos(e);
		if (this.dragMode && this.selectedIndex >= 0) {
			const pps = this.pxPerSecond();
			const dx = (x - this.dragStart.x) / pps;
			const seg = this.segments[this.selectedIndex];
			const base = this.dragBaseline;
			const max = this.getMaxDuration();
			if (this.dragMode === "left") {
				seg.start = clamp(base.start + dx, 0, base.end - MIN_DURATION);
			} else if (this.dragMode === "right") {
				seg.end = clamp(base.end + dx, base.start + MIN_DURATION, max);
			} else {
				const len = Math.max(MIN_DURATION, base.end - base.start);
				const start = clamp(base.start + dx, 0, Math.max(0, max - len));
				seg.start = start;
				seg.end = start + len;
			}
			this.normalizeSegment(seg);
			this.commit(false);
			this.render();
			return;
		}
		const hit = this.hitTest(x, y);
		this.hoverIndex = hit.index;
		this.hoverHandle = hit.handle;
		this.canvas.style.cursor = hit.handle === "left" || hit.handle === "right" ? "ew-resize" : hit.handle === "move" ? "grab" : "default";
		this.render();
	}

	onPointerUp(e) {
		if (this.dragMode) {
			try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
			this.dragMode = null;
			this.dragStart = null;
			this.dragBaseline = null;
			this.commit(true);
			this.render();
		}
	}

	normalizeSegment(seg) {
		const max = this.getMaxDuration();
		seg.start = parseFloat(clamp(Number(seg.start || 0), 0, Math.max(0, max - MIN_DURATION)).toFixed(3));
		seg.end = parseFloat(clamp(Number(seg.end || seg.start + MIN_DURATION), seg.start + MIN_DURATION, max).toFixed(3));
	}

	parseDurationInput() {
		const value = Number(this.durationInput?.value);
		if (!Number.isFinite(value)) return Math.max(MIN_DURATION, Number(this.segmentDuration || DEFAULT_SEGMENT_DURATION));
		return Math.max(MIN_DURATION, value);
	}

	applyPendingDurationInput(commit = true) {
		const value = this.parseDurationInput();
		if (Math.abs(value - Number(this.segmentDuration || 0)) < 0.000001) return false;
		this.applySegmentDuration(commit);
		return true;
	}

	applySegmentDuration(commit = true) {
		clearTimeout(this._durationInputTimer);
		const value = this.parseDurationInput();
		this.segmentDuration = value;
		if (this.durationInput) this.durationInput.value = String(value);
		setWidgetValue(this.node, "segment_duration", value);
		this.node.properties = this.node.properties || {};
		this.node.properties.segment_duration = value;
		const seg = this.segments[this.selectedIndex >= 0 ? this.selectedIndex : 0];
		if (seg) {
			seg.end = Math.min(this.getMaxDuration(), Number(seg.start || 0) + value);
			if (seg.end - seg.start < MIN_DURATION) seg.start = Math.max(0, seg.end - MIN_DURATION);
			this.normalizeSegment(seg);
		}
		if (commit) this.commit(true);
		this.render();
	}

	makeDefaultSegment() {
		const dur = Math.min(this.getMaxDuration(), Math.max(MIN_DURATION, this.segmentDuration || DEFAULT_SEGMENT_DURATION));
		return [{ start: 0, end: parseFloat(dur.toFixed(3)), label: "片段 1", color: SEGMENT_COLORS[0] }];
	}

	addSegment() {
		const max = this.getMaxDuration();
		const len = Math.min(max, Math.max(MIN_DURATION, this.segmentDuration || DEFAULT_SEGMENT_DURATION));
		let start = 0;
		if (this.segments.length) {
			const last = this.segments[this.segments.length - 1];
			start = clamp(Number(last.end || 0), 0, Math.max(0, max - len));
		}
		const usedColors = new Set(this.segments.map(s => s.color).filter(Boolean));
		this.segments.push({
			start: parseFloat(start.toFixed(3)),
			end: parseFloat(Math.min(max, start + len).toFixed(3)),
			label: `片段 ${this.segments.length + 1}`,
			color: pickColor(usedColors),
		});
		this.selectedIndex = this.segments.length - 1;
		this.showAllOutputs = true;
		this.node.properties = this.node.properties || {};
		this.node.properties.gjj_show_all_audio_outputs = true;
		this.setButtonActive(this.outputBtn, true);
		this.commit(true);
		this.render();
	}

	distributeEvenly() {
		const max = this.getMaxDuration();
		const n = Math.max(1, this.segments.length || 1);
		const each = max / n;
		this.segments = [];
		for (let i = 0; i < n; i++) {
			this.segments.push({
				start: parseFloat((i * each).toFixed(3)),
				end: parseFloat(((i + 1) * each).toFixed(3)),
				label: `片段 ${i + 1}`,
				color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
			});
		}
		this.selectedIndex = 0;
		this.commit(true);
		this.render();
	}

	deleteSelected() {
		if (this.segments.length <= 1) return;
		if (this.selectedIndex < 0 || this.selectedIndex >= this.segments.length) return;
		this.segments.splice(this.selectedIndex, 1);
		this.segments.forEach((s, i) => { s.label = s.label || `片段 ${i + 1}`; });
		this.selectedIndex = clamp(this.selectedIndex, 0, this.segments.length - 1);
		this.commit(true);
		this.render();
	}

	toggleListOutput() {
		// 📋 只负责显示/隐藏“分段列表”输出口。
		// 注意：当 🔌 展开多段音频输出时，slot1 必须保留为“分段列表”，否则后端 result 槽位会错位。
		if (this.showAllOutputs) {
			this.showListOutput = true;
			this.setStatus("ℹ️ 已展开多段输出时，分段列表需要保留在 slot1，不能单独隐藏。先关闭 🔌 后再隐藏。");
		} else {
			this.showListOutput = !this.showListOutput;
		}
		this.node.properties = this.node.properties || {};
		this.node.properties.gjj_show_segment_list = this.showListOutput;
		this.setButtonActive(this.listBtn, this.showListOutput);
		stabilizeNode(this.node, this.segments.length, this.showListOutput, this.showAllOutputs);
	}

	toggleAllOutputs() {
		const count = Math.max(1, this.segments?.length || 1);
		if (count <= 1) {
			this.showAllOutputs = false;
			this.node.properties = this.node.properties || {};
			this.node.properties.gjj_show_all_audio_outputs = false;
			this.setButtonActive(this.outputBtn, false);
			this.setStatus("ℹ️ 当前只有 1 段，没有其它音频片段输出口。先用 ➕ 添加分段，或用 ⚖️ 均分后再展开。");
			stabilizeNode(this.node, count, this.showListOutput, false);
			return;
		}
		this.showAllOutputs = !this.showAllOutputs;
		// 多段输出时必须保留分段列表在 slot1，保证后端 result 槽位不偏移。
		if (this.showAllOutputs) this.showListOutput = true;
		this.node.properties = this.node.properties || {};
		this.node.properties.gjj_show_all_audio_outputs = this.showAllOutputs;
		this.node.properties.gjj_show_segment_list = this.showListOutput;
		this.setButtonActive(this.outputBtn, this.showAllOutputs);
		this.setButtonActive(this.listBtn, this.showListOutput);
		stabilizeNode(this.node, count, this.showListOutput, this.showAllOutputs);
	}

	commit(updateHeight = true) {
		this.segments.forEach(s => this.normalizeSegment(s));
		setWidgetValue(this.node, "segments_json", JSON.stringify(this.segments));
		setWidgetValue(this.node, "segment_duration", this.segmentDuration);
		this.node.properties = this.node.properties || {};
		this.node.properties.segments = JSON.stringify(this.segments);
		this.node.properties.segment_duration = this.segmentDuration;
		syncNodeWidgetValues(this.node);
		this.updateLabels();
		if (updateHeight) stabilizeNode(this.node, this.segments.length, this.showListOutput, this.showAllOutputs);
		else refreshNodeCanvas(this.node);
	}

	updateLabels() {
		const seg = this.segments[this.selectedIndex] || this.segments[0];
		if (seg) {
			const len = Math.max(0, Number(seg.end || 0) - Number(seg.start || 0));
			this.rangeLabel.textContent = `片段${this.selectedIndex + 1}: ${this.formatTime(seg.start)}–${this.formatTime(seg.end)} (${len.toFixed(1)}s)`;
		} else {
			this.rangeLabel.textContent = "--";
		}
		this.metaLabel.textContent = `总长 ${this.formatTime(this.duration)} · ${this.sampleRate || "--"}Hz · ${this.segments.length}段`;
		this.updatePlayTimeLabel();
	}

	setSegments(segments) {
		let list = (segments || []).map((s, i) => ({
			start: Number(s.start || 0),
			end: Number(s.end || 0),
			label: s.label || `片段 ${i + 1}`,
			color: s.color || SEGMENT_COLORS[i % SEGMENT_COLORS.length],
		}));
		if (!list.length) list = this.makeDefaultSegment();
		this.segments = list;
		this.segments.forEach(s => this.normalizeSegment(s));
		this.selectedIndex = clamp(this.selectedIndex, 0, this.segments.length - 1);
		this.commit(false);
		this.render();
	}

	loadAudio(url) {
		if (!url) {
			this.__lastAudioUrlKey = "";
			this.audioBuffer = null;
			this.audioPlayer.src = "";
			this.render();
			return;
		}
		// V20：同一个预览文件不要反复创建 AudioContext / decodeAudioData。
		// 后端缓存命中时 preview_audio 文件名不变；重复解码会在浏览器里刷出大量 AudioContext 错误。
		const urlKey = String(url).replace(/([?&])_t=\d+(&|$)/, "$1").replace(/[?&]$/, "");
		if (this.__lastAudioUrlKey === urlKey && this.audioBuffer) {
			this.render();
			return;
		}
		this.__lastAudioUrlKey = urlKey;
		const finalUrl = url.includes("_t=") ? url : `${url}${url.includes("?") ? "&" : "?"}_t=${Date.now()}`;
		this.audioBuffer = null;
		this.render();
		this.audioPlayer.src = finalUrl;
		try {
			if (!AudioSegmentEditorWidget.__audioCtx) {
				AudioSegmentEditorWidget.__audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			}
			const audioCtx = AudioSegmentEditorWidget.__audioCtx;
			fetch(finalUrl, { cache: "no-store" })
				.then(res => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.arrayBuffer();
				})
				.then(buf => audioCtx.decodeAudioData(buf.slice(0)))
				.then(audioBuffer => {
					this.audioBuffer = audioBuffer;
					this.duration = audioBuffer.duration || this.duration;
					this.sampleRate = audioBuffer.sampleRate || this.sampleRate;
					this.render();
				})
				.catch(err => {
					// 只提示一次，避免控制台刷屏。
					if (this.__lastAudioDecodeErrorKey !== urlKey) {
						this.__lastAudioDecodeErrorKey = urlKey;
						console.warn("[GJJ] 音频波形加载失败:", err);
					}
					this.audioBuffer = null;
					this.render();
				});
		} catch (e) {
			if (this.__lastAudioDecodeErrorKey !== urlKey) {
				this.__lastAudioDecodeErrorKey = urlKey;
				console.warn("[GJJ] Web Audio API 不可用:", e);
			}
			this.render();
		}
	}


	updatePlayTimeLabel() {
		if (!this.playTimeLabel) return;
		const seg = this.segments[this.selectedIndex] || this.segments[0];
		const end = seg ? Number(seg.end || 0) : Number(this.duration || 0);
		this.playTimeLabel.textContent = `${this.formatTime(this.audioPlayer?.currentTime || 0)} / ${this.formatTime(end)}`;
	}

	toggleSelectedPlayback() {
		if (!this.audioPlayer?.src) {
			this.setStatus("请先选择音频文件，节点会自动刷新加载预览。");
			return;
		}
		const seg = this.segments[this.selectedIndex] || this.segments[0];
		if (this.audioPlayer.paused) {
			if (seg) {
				const t = Number(this.audioPlayer.currentTime || 0);
				if (t < Number(seg.start || 0) || t >= Number(seg.end || 0)) {
					this.audioPlayer.currentTime = Number(seg.start || 0);
				}
			}
			this.audioPlayer.play().catch(err => {
				console.warn("[GJJ] 播放失败:", err);
				this.setStatus(`❌ 播放失败：${err?.message || err}`);
			});
		} else {
			this.audioPlayer.pause();
		}
		this.updatePlayTimeLabel();
	}

	seekToSelectedStart() {
		const seg = this.segments[this.selectedIndex];
		if (!seg || !this.loopSelection) return;
		if (this.audioPlayer.currentTime < seg.start || this.audioPlayer.currentTime >= seg.end) {
			this.audioPlayer.currentTime = seg.start;
		}
		this.updatePlayTimeLabel();
	}

	onAudioTimeUpdate() {
		const seg = this.segments[this.selectedIndex];
		this.updatePlayTimeLabel();
		if (!seg || !this.loopSelection || this.audioPlayer.paused) return;
		if (this.audioPlayer.currentTime >= Number(seg.end || 0)) {
			this.audioPlayer.currentTime = Number(seg.start || 0);
			this.audioPlayer.play().catch(() => {});
		}
	}

	getAudioFileWidget() {
		return this.node?.widgets?.find(w => String(w?.name || "") === "audio_file" || String(w?.label || "") === "音频/视频文件" || String(w?.label || "") === "音频文件" || String(w?.label || "") === "音频/视频文件");
	}

	setAudioFileWidgetValue(filename) {
		const widget = this.getAudioFileWidget();
		if (!widget || !filename) return false;

		// LiteGraph combo 的候选项在不同版本里位置不完全一致，都兼容一下。
		const optionBuckets = [
			widget.options?.values,
			widget.options?.items,
			widget.values,
		];
		for (const bucket of optionBuckets) {
			if (Array.isArray(bucket) && !bucket.includes(filename)) bucket.push(filename);
		}
		if (Array.isArray(widget.options?.values) && !widget.options.values.includes(filename)) {
			widget.options.values.push(filename);
		}

		widget.value = filename;
		try { widget.callback?.(filename); } catch (err) { console.warn("[GJJ] 更新音频文件控件失败:", err); }
		this.node.__gjjAudioLastAudioFileValue = filename;
		refreshNodeCanvas(this.node);
		return true;
	}

	async uploadDiskMedia(file) {
		if (!file) return null;
		const form = new FormData();
		// ComfyUI 的上传接口字段名沿用 image，但实际可以作为通用文件上传使用。
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");

		const doFetch = async (url) => fetch(url, { method: "POST", body: form });
		let response = null;
		try {
			if (api?.fetchApi) response = await api.fetchApi("/upload/image", { method: "POST", body: form });
			else response = await doFetch("/upload/image");
		} catch (err) {
			throw new Error(`上传失败：${err?.message || err}`);
		}

		if (!response?.ok) {
			let text = "";
			try { text = await response.text(); } catch (_) {}
			throw new Error(`上传失败：HTTP ${response?.status || "?"} ${text}`);
		}

		let data = null;
		try { data = await response.json(); } catch (_) {}
		return data?.name || data?.filename || file.name;
	}

	async openDiskMedia() {
		if (!this.fileInput) return;
		this.fileInput.value = "";
		this.fileInput.onchange = async () => {
			const file = this.fileInput.files?.[0];
			if (!file) return;
			try {
				this.folderBtn.disabled = true;
				this.folderBtn.textContent = "⏳";
				this.setStatus(`📁 正在上传：${file.name}\n上传完成后会自动刷新当前节点。`);
				const filename = await this.uploadDiskMedia(file);
				if (!filename) throw new Error("上传成功但没有返回文件名");
				this.setAudioFileWidgetValue(filename);
				await this.refreshAudio(`📁 已打开：${filename}\n正在读取音频数据…`);
			} catch (err) {
				console.error("[GJJ] 打开磁盘音频/视频失败:", err);
				this.setStatus(`❌ 打开失败：${err?.message || err}\n如果是视频文件，请确认系统已安装 ffmpeg，并且 ComfyUI 后端可以调用 ffmpeg。`);
			} finally {
				setTimeout(() => {
					this.folderBtn.textContent = "📁";
					this.folderBtn.disabled = false;
				}, 400);
			}
		};
		this.fileInput.click();
	}

	async refreshAudio(statusText = "自动加载音频中…", options = {}) {
		const signature = options.signature || getRefreshSignature(this.node, statusText);
		const cooldownMs = Number(options.cooldownMs ?? 900);
		if (!markRefreshScheduled(this.node, signature, cooldownMs)) {
			this.setStatus("⏳ 已有刷新任务或短时间内重复请求，已自动合并。上游音频未变化时不会重复执行。");
			return false;
		}
		try {
			this.folderBtn.disabled = true;
			this.folderBtn.textContent = "⏳";
			this.applyPendingDurationInput(false);
			this.commit(false);
			this.setStatus(statusText);
			return await queueOnlyCurrentNode(this.node);
		} catch (err) {
			console.error("[GJJ] 刷新音频失败:", err);
			this.setStatus(`❌ 刷新失败：${err?.message || err}`);
			return false;
		} finally {
			setTimeout(() => {
				this.folderBtn.textContent = "📁";
				this.folderBtn.disabled = false;
			}, 400);
		}
	}

	setStatus(text) {
		const hasText = !!String(text || "").trim();
		this.statusDisplay.style.display = hasText ? "block" : "none";
		this.statusDisplay.firstChild && (this.statusDisplay.firstChild.nodeValue = "");
		let textNode = this.statusDisplay.__textNode;
		if (!textNode) {
			textNode = document.createTextNode("");
			this.statusDisplay.insertBefore(textNode, this.statusDisplay.firstChild);
			this.statusDisplay.__textNode = textNode;
		}
		textNode.nodeValue = hasText ? text : "";
		scheduleNodeHeight(this.node);
	}

	serialize() {
		return JSON.stringify(this.segments);
	}

	render() {
		if (!this.ctx) return;
		this.updateLabels();
		const ctx = this.ctx;
		const w = this._cssWidth || 420;
		ctx.clearRect(0, 0, w, CANVAS_HEIGHT);
		this.drawRuler(ctx, w);
		this.drawWaveform(ctx, w);
		this.drawSegments(ctx, w);
	}

	drawRuler(ctx, w) {
		const max = this.getMaxDuration();
		const pps = this.pxPerSecond();
		ctx.fillStyle = "#20262b";
		ctx.fillRect(0, 0, w, RULER_HEIGHT);
		const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
		let step = nice[nice.length - 1];
		for (const s of nice) { if (s * pps >= 52) { step = s; break; } }
		ctx.strokeStyle = "#48525b";
		ctx.fillStyle = "#aeb8c2";
		ctx.font = "10px sans-serif";
		ctx.textBaseline = "top";
		for (let t = 0; t <= max + 0.0001; t += step) {
			const x = Math.floor(t * pps) + 0.5;
			ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT - 5); ctx.lineTo(x, RULER_HEIGHT); ctx.stroke();
			ctx.fillText(this.formatTime(t), x + 2, 2);
		}
	}

	drawWaveform(ctx, w) {
		ctx.fillStyle = "#11161a";
		ctx.fillRect(0, WAVE_Y, w, WAVE_H);
		if (!this.audioBuffer) {
			ctx.fillStyle = "#53606b";
			ctx.font = "11px sans-serif";
			ctx.fillText("执行节点后显示波形", 8, WAVE_Y + 10);
			return;
		}
		const data = this.audioBuffer.getChannelData(0);
		const sampleRate = this.audioBuffer.sampleRate;
		const max = this.getMaxDuration();
		const midY = WAVE_Y + WAVE_H / 2;
		const amp = WAVE_H / 2 - 5;
		ctx.strokeStyle = "rgba(120, 210, 155, 0.42)";
		ctx.lineWidth = 0.8;
		ctx.beginPath();
		for (let px = 0; px < w; px++) {
			const t0 = px / Math.max(1, w) * max;
			const t1 = (px + 1) / Math.max(1, w) * max;
			const s0 = clamp(Math.floor(t0 * sampleRate), 0, Math.max(0, data.length - 1));
			const s1 = Math.min(data.length, Math.max(s0 + 1, Math.floor(t1 * sampleRate)));
			let min = 1, maxv = -1;
			for (let s = s0; s < s1; s++) {
				const v = data[s] || 0;
				if (v < min) min = v;
				if (v > maxv) maxv = v;
			}
			ctx.moveTo(px + 0.5, midY + min * amp);
			ctx.lineTo(px + 0.5, midY + maxv * amp);
		}
		ctx.stroke();
	}

	drawSegments(ctx, w) {
		for (const r of this.segmentRects()) {
			const seg = this.segments[r.index];
			const selected = r.index === this.selectedIndex;
			const hover = r.index === this.hoverIndex;
			const color = seg.color || SEGMENT_COLORS[r.index % SEGMENT_COLORS.length];
			ctx.save();
			ctx.fillStyle = color;
			ctx.globalAlpha = selected ? 0.42 : hover ? 0.30 : 0.18;
			ctx.fillRect(r.x, WAVE_Y, r.w, WAVE_H);
			ctx.globalAlpha = 1;
			ctx.strokeStyle = selected ? "#ffffff" : hover ? "#cfd8dc" : "rgba(255,255,255,0.35)";
			ctx.lineWidth = selected ? 2 : 1;
			ctx.strokeRect(r.x + 0.5, WAVE_Y + 0.5, r.w - 1, WAVE_H - 1);
			ctx.fillStyle = "#fff";
			ctx.font = "11px sans-serif";
			ctx.textBaseline = "top";
			ctx.fillText(seg.label || `片段 ${r.index + 1}`, r.x + 5, WAVE_Y + 5);
			ctx.font = "10px monospace";
			ctx.fillStyle = "rgba(255,255,255,0.8)";
			ctx.fillText(`${this.formatTime(r.startSec)} – ${this.formatTime(r.endSec)}`, r.x + 5, WAVE_Y + WAVE_H - 18);
			ctx.fillText(`${(r.endSec - r.startSec).toFixed(1)}s`, r.x + 5, WAVE_Y + WAVE_H - 6);
			ctx.fillStyle = selected || hover ? "#fff" : "rgba(255,255,255,0.55)";
			ctx.fillRect(r.x - 2, WAVE_Y + 5, 4, WAVE_H - 10);
			ctx.fillRect(r.x + r.w - 2, WAVE_Y + 5, 4, WAVE_H - 10);
			ctx.restore();
		}
	}

	destroy() {
		this.resizeObserver?.disconnect();
		clearTimeout(this._heightTimer);
		clearTimeout(this._durationInputTimer);
	}
}

function getOutputIndex(name) {
	// 必须与 Python RETURN_TYPES / result 顺序一致：
	// slot0=音频片段1，slot1=分段列表，slot2...=音频片段2...
	const text = String(name || "");
	if (text === SEGMENT_LIST_NAME) return 1;
	if (!text.startsWith(OUTPUT_DISPLAY_PREFIX)) return Number.MAX_SAFE_INTEGER;
	const n = Number.parseInt(text.slice(OUTPUT_DISPLAY_PREFIX.length), 10) || 1;
	return n <= 1 ? 0 : n;
}

function getOutputs(node) {
	return Array.isArray(node?.outputs) ? [...node.outputs].sort((a, b) => getOutputIndex(a?.name) - getOutputIndex(b?.name)) : [];
}

function removeOutputByRef(node, output) {
	const idx = node.outputs?.indexOf(output) ?? -1;
	if (idx >= 0) node.removeOutput(idx);
}

function ensureAudioOutput(node) {
	if (!node.outputs?.some(o => String(o.name || "").startsWith(OUTPUT_DISPLAY_PREFIX))) {
		node.addOutput(`${OUTPUT_DISPLAY_PREFIX}1`, "AUDIO");
	}
}


function scheduleNodeHeight(node, delay = 30) {
	if (!node) return;
	clearTimeout(node.__gjjAudioHeightTimer);
	node.__gjjAudioHeightTimer = setTimeout(() => {
		try {
			hideInternalWidgets(node);
			const width = Math.max(360, Number(node.size?.[0] || 420));
			let height = 260;
			try {
				const computed = node.computeSize?.() || node.size || [width, height];
				height = Math.max(230, Number(computed?.[1] || height));
			} catch (_) {
				height = Math.max(230, Number(node.size?.[1] || height));
			}
			// 限制高度只在确实变化时更新，避免面板抖动。
			if (!Array.isArray(node.size) || Math.abs(Number(node.size[1] || 0) - height) > 2) {
				node.setSize?.([width, height]);
			}
			refreshNodeCanvas(node);
		} catch (err) {
			console.warn("[GJJ] scheduleNodeHeight 失败：", err);
		}
	}, delay);
}

function stabilizeNode(node, segmentCount = 1, showList = null, showAll = null) {
	if (!node) return;
	hideInternalWidgets(node);

	node.properties = node.properties || {};
	const count = Math.max(1, Number(segmentCount || 1));
	let listVisible = showList;
	if (listVisible === null || listVisible === undefined) listVisible = Boolean(node.properties?.gjj_show_segment_list);
	let allVisible = showAll;
	if (allVisible === null || allVisible === undefined) allVisible = Boolean(node.properties?.gjj_show_all_audio_outputs);

	// 只有 1 段时，🔌 不应该保持激活，否则看起来像按钮坏了。
	if (count <= 1) allVisible = false;
	// 展开多段音频时，slot1 必须是“分段列表”，否则 slot2=音频片段2 会错位成后端 result[1]。
	if (allVisible) listVisible = true;

	node.properties.gjj_show_segment_list = !!listVisible;
	node.properties.gjj_show_all_audio_outputs = !!allVisible;

	if (!Array.isArray(node.outputs)) node.outputs = [];
	while (node.outputs.length < 1) node.addOutput(`${OUTPUT_DISPLAY_PREFIX}1`, "AUDIO");

	function setSlot(slot, name, type) {
		while (node.outputs.length <= slot) node.addOutput(name, type);
		const out = node.outputs[slot];
		out.name = name;
		out.type = type;
		out.label = name;
		out.localized_name = name;
	}

	setSlot(0, `${OUTPUT_DISPLAY_PREFIX}1`, "AUDIO");

	let wanted = 1;
	if (listVisible || allVisible) {
		setSlot(1, SEGMENT_LIST_NAME, "STRING");
		wanted = 2;
	}
	if (allVisible) {
		// slot2=音频片段2，slot3=音频片段3...
		for (let slot = 2; slot <= count; slot++) {
			setSlot(slot, `${OUTPUT_DISPLAY_PREFIX}${slot}`, "AUDIO");
		}
		wanted = Math.max(2, count + 1);
	}

	for (let slot = node.outputs.length - 1; slot >= wanted; slot--) {
		try { node.removeOutput(slot); } catch (err) { console.warn("[GJJ] 裁剪多余输出口失败：", slot, err); }
	}

	try {
		for (let slot = 0; slot < node.outputs.length; slot++) {
			const out = node.outputs[slot];
			for (const linkId of out?.links || []) {
				const link = node.graph?.links?.[linkId] || app.graph?.links?.[linkId];
				if (link && String(link.origin_id) === String(node.id)) link.origin_slot = slot;
			}
		}
	} catch (err) {
		console.warn("[GJJ] 输出槽位链接修正失败：", err);
	}

	try {
		if (node._editor) {
			node._editor.showListOutput = !!listVisible;
			node._editor.showAllOutputs = !!allVisible;
			node._editor.setButtonActive(node._editor.listBtn, !!listVisible);
			node._editor.setButtonActive(node._editor.outputBtn, !!allVisible);
		}
	} catch (_) {}

	scheduleNodeHeight(node);
	refreshNodeCanvas(node);
}

function scheduleStabilize(node, segmentCount, ms = 80) {
	clearTimeout(node.__gjjAudioSegmentTimer);
	node.__gjjAudioSegmentTimer = setTimeout(() => stabilizeNode(node, segmentCount), ms);
}

function installHiddenWidgetGuard(nodeType) {
	if (!nodeType?.prototype || nodeType.prototype.__gjjAudioHiddenGuardInstalled) return;
	nodeType.prototype.__gjjAudioHiddenGuardInstalled = true;
	const originalAddWidget = nodeType.prototype.addWidget;
	if (typeof originalAddWidget === "function") {
		nodeType.prototype.addWidget = function (...args) {
			const widget = originalAddWidget.apply(this, args);
			if (isHiddenWidget(widget)) {
				hideWidget(widget);
				safeWidgetSet(widget, "last_y", 0);
			}
			return widget;
		};
	}
}


function installAudioFileAutoRefresh(node) {
	if (!node?.widgets || node.__gjjAudioFileAutoRefreshInstalled) return;
	const widget = node.widgets.find(w => String(w?.name || "") === "audio_file" || String(w?.label || "") === "音频文件");
	if (!widget) return;
	node.__gjjAudioFileAutoRefreshInstalled = true;
	node.__gjjAudioLastAudioFileValue = widget.value;

	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		const result = originalCallback?.apply(this, args);
		const nextValue = widget.value;
		if (nextValue === node.__gjjAudioLastAudioFileValue) return result;
		node.__gjjAudioLastAudioFileValue = nextValue;
		clearTimeout(node.__gjjAudioAutoRefreshTimer);
		node.__gjjAudioAutoRefreshTimer = setTimeout(() => {
			if (node._editor && nextValue && nextValue !== "[不加载]") {
				node._editor.refreshAudio("音频文件已改变，自动刷新中…");
			}
		}, 220);
		return result;
	};

	widget.tooltip = widget.tooltip || "选择音频/视频文件后会自动刷新当前节点；视频会在后端只提取音频";
	widget.options = widget.options || {};
	widget.options.tooltip = widget.options.tooltip || widget.tooltip;
}

function getAudioInputIndex(node) {
	if (!node?.inputs) return -1;
	return node.inputs.findIndex(input => {
		const name = String(input?.name || input?.label || input?.localized_name || "");
		const type = String(input?.type || "").toUpperCase();
		return type === "AUDIO" || name.includes("外部音频") || name.toLowerCase() === "audio";
	});
}

function hasExternalAudioLink(node) {
	const idx = getAudioInputIndex(node);
	return idx >= 0 && node?.inputs?.[idx]?.link != null;
}

function isLinkedFromNode(editorNode, originNodeId) {
	if (!editorNode?.graph || originNodeId == null) return false;
	const idx = getAudioInputIndex(editorNode);
	const linkId = idx >= 0 ? editorNode.inputs?.[idx]?.link : null;
	if (linkId == null) return false;
	const link = editorNode.graph.links?.[linkId] || app.graph?.links?.[linkId];
	return link && String(link.origin_id) === String(originNodeId);
}

function scheduleExternalAudioRefresh(node, reason = "外部音频已更新，自动刷新波形…", ms = 260, eventKey = "") {
	if (!node?._editor || !hasExternalAudioLink(node)) return;
	if (hasSelectedAudioFile(node)) return;
	const signature = `${getRefreshSignature(node, reason)}||event=${eventKey || ""}`;
	const now = performance.now();
	// 同一个上游事件/同一条连接短时间内只刷新一次；多个来源同时触发时合并到最后一次。
	if (node.__gjjLastScheduledExternalSignature === signature && now - (node.__gjjLastScheduledExternalAt || 0) < 1200) return;
	node.__gjjLastScheduledExternalSignature = signature;
	node.__gjjLastScheduledExternalAt = now;
	clearTimeout(node.__gjjExternalAudioRefreshTimer);
	node.__gjjExternalAudioRefreshTimer = setTimeout(() => {
		if (!node._editor || !hasExternalAudioLink(node)) return;
		node._editor.refreshAudio(reason, { signature, cooldownMs: 1200 });
	}, ms);
}


app.registerExtension({
	name: "GJJ.AudioSegmentEditor.V23DurationInputSync",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;

		// V18：从“节点定义数据”源头裁剪输出口。
		// 后端为了支持动态多段输出仍声明了 99 个返回值；但前端如果照单全收，
		// 新建节点时会直接展开 99 个输出口。这里在 LiteGraph 创建节点前，
		// 只暴露默认需要的两个槽位：slot0=音频片段1，slot1=分段列表。
		try {
			// 默认只暴露一个输出：音频片段1。📋 点击后再添加“分段列表”。
			if (Array.isArray(nodeData.output)) nodeData.output = ["AUDIO"];
			if (Array.isArray(nodeData.outputs)) nodeData.outputs = ["AUDIO"];
			if (Array.isArray(nodeData.output_name)) nodeData.output_name = [`${OUTPUT_DISPLAY_PREFIX}1`];
			if (Array.isArray(nodeData.output_names)) nodeData.output_names = [`${OUTPUT_DISPLAY_PREFIX}1`];
			if (Array.isArray(nodeData.output_tooltips)) nodeData.output_tooltips = ["第1个时间段的音频片段"];
			if (Array.isArray(nodeData.output_is_list)) nodeData.output_is_list = [false];
		} catch (err) {
			console.warn("[GJJ] V18 裁剪 nodeData 输出定义失败：", err);
		}

		installHiddenWidgetGuard(nodeType);
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		const originalOnExecuted = nodeType.prototype.onExecuted;
		const originalOnConfigure = nodeType.prototype.onConfigure;
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		const originalOnRemoved = nodeType.prototype.onRemoved;
		const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
		const originalComputeSize = nodeType.prototype.computeSize;
		const originalOnDrawForeground = nodeType.prototype.onDrawForeground;

		nodeType.prototype.computeSize = function (...args) {
			hideInternalWidgets(this);
			return withHiddenWidgetsFiltered(this, () => {
				const size = originalComputeSize?.apply(this, args) || this.size || [420, 260];
				return [Number(size[0] || 420), Math.max(225, Number(size[1] || 260))];
			});
		};

		nodeType.prototype.onDrawForeground = function (...args) {
			hideInternalWidgets(this);
			return withHiddenWidgetsFiltered(this, () => originalOnDrawForeground?.apply(this, args));
		};

		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			hideInternalWidgets(this);
			stabilizeNode(this, 1, false, false);
			installAudioFileAutoRefresh(this);
			const container = document.createElement("div");
			this._segmentEditorWidget = this.addDOMWidget("audio_segment_editor_canvas", "GJJAudioSegmentEditor", container, {
				serialize: false,
				hideOnZoom: false,
				getMinHeight: () => 210,
				getHeight: () => Math.max(210, container?.scrollHeight || container?.offsetHeight || 210),
			});
			setTimeout(() => {
				try {
					this._editor = new AudioSegmentEditorWidget(this, container);
					const saved = parseSegments(this.properties?.segments || getWidgetValue(this, "segments_json", "[]"));
					this._editor.setSegments(saved.length ? saved : this._editor.makeDefaultSegment());
					stabilizeNode(this, this._editor.segments.length, false, false);
					setTimeout(() => stabilizeNode(this, this._editor?.segments?.length || 1, false, false), 80);
					setTimeout(() => stabilizeNode(this, this._editor?.segments?.length || 1, false, false), 300);
				} catch (err) {
					console.error("[GJJ] 音频分段编辑器初始化失败:", err);
				}
			}, 0);
			return result;
		};

		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			hideInternalWidgets(this);
			installAudioFileAutoRefresh(this);
			setTimeout(() => {
				const saved = parseSegments(this.properties?.segments || getWidgetValue(this, "segments_json", "[]"));
				if (this._editor && saved.length) this._editor.setSegments(saved);
				stabilizeNode(this, this._editor?.segments?.length || 1, false, false);
				setTimeout(() => stabilizeNode(this, this._editor?.segments?.length || 1, false, false), 250);
			}, 30);
			return result;
		};

		nodeType.prototype.onRemoved = function () {
			this._editor?.destroy();
			return originalOnRemoved?.apply(this, arguments);
		};

		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			hideInternalWidgets(this);
			if (!message || !this._editor) return result;
			const previewAudio = message.preview_audio?.[0];
			const duration = Number(message.preview_duration?.[0] || 0);
			const sampleRate = Number(message.preview_sample_rate?.[0] || 44100);
			const segmentsJson = message.preview_segments?.[0] || "[]";
			const segmentCount = Number(message.preview_segment_count?.[0] || 1);
			const backendVersion = message.backend_version?.[0] || "未知后端版本";
			this._editor.duration = duration;
			this._editor.sampleRate = sampleRate;
			const propertySegments = parseSegments(this.properties?.segments || "[]");
			const segments = parseSegments(segmentsJson);
			// 执行完成后以“后端实际裁剪分段”为准，避免界面显示新分段但下游保存的是旧分段。
			this._editor.setSegments(segments.length ? segments : (propertySegments.length ? propertySegments : this._editor.makeDefaultSegment()));
			const audioUrl = audioDataToUrl(previewAudio);
			if (audioUrl) this._editor.loadAudio(audioUrl); else this._editor.render();
			this.properties = this.properties || {};
			this.properties.segments = this._editor.serialize();
			this._editor.setStatus(`✅ 执行完成 · 后端 ${backendVersion}，耗时 ${message?.execution_time?.[0] ?? ""}${message?.execution_time ? "秒" : ""}`.replace("，耗时 秒", ""));
			stabilizeNode(this, segmentCount, this._editor.showListOutput, this._editor.showAllOutputs);
			return result;
		};

		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this, this._editor?.segments?.length || 1);
			// 连接/更换上游 AUDIO 后，自动执行当前编辑器一次，生成 preview_audio 给前端解码波形。
			const inputIndex = typeof args[1] === "number" ? args[1] : (typeof args[2] === "number" ? args[2] : -1);
			if (!hasSelectedAudioFile(this) && (inputIndex === getAudioInputIndex(this) || inputIndex < 0)) {
				scheduleExternalAudioRefresh(this, "外部音频连接已变化，自动刷新波形…", 500);
			}
			return result;
		};

		nodeType.prototype.getExtraMenuOptions = function (_, options) {
			const result = originalGetExtraMenuOptions?.apply(this, arguments);
			if (this._editor) {
				options.unshift(
					{ content: "➕ 添加分段", callback: () => this._editor.addSegment() },
					{ content: "⚖️ 均分", callback: () => this._editor.distributeEvenly() },
					{ content: "🗑️ 删除选中", callback: () => this._editor.deleteSelected() },
					{ content: "📋 显示/隐藏分段列表输出", callback: () => this._editor.toggleListOutput() },
					{ content: "🔌 显示/收起全部音频输出", callback: () => this._editor.toggleAllOutputs() },
					{ content: "📁 打开磁盘音频/视频", callback: () => this._editor.openDiskMedia() },
				);
			}
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_NAME) {
				stabilizeNode(node, node._editor?.segments?.length || 1, false, false);
				setTimeout(() => stabilizeNode(node, node._editor?.segments?.length || 1, false, false), 250);
			}
		}
		// V20：禁用全局 executed 监听自动 queue。
		// 原逻辑会在上游音频分离器执行完成后，给每个下游分段编辑器再 queue 一次当前节点；
		// queue 当前节点时又会保留上游链路，结果导致 separator 被二次、三次请求。
		// 现在只依赖正常工作流执行结果更新波形；连接变化/手动打开文件仍可触发一次刷新。
		api?.addEventListener?.("gjj_audio_timestamp_error", (event) => {
			try {
				const data = event.detail || {};
				const nodeId = data.node;
				const errorMessage = data.panel_message || data.warning_message || data.error || "";
				const installCommand = data.copy_text || data.install_command || data.model_download_url || "";
				const copyLabel = data.copy_label || "";
				if (!nodeId || !errorMessage) return;
				if (data.warning_message || installCommand) {
					return;
				}
				for (const node of app.graph?._nodes || []) {
					if (String(node.id) !== String(nodeId)) continue;
					if (node._editor) {
						// 直接显示后端发送的错误信息，不再添加额外前缀
						node._editor.setStatus(errorMessage);
						GJJ_Utils.applyDependencyCopyButton(node._editor.copyBtn, {
							copyText: installCommand,
							copyLabel,
							visible: !!installCommand,
						});
					}
					break;
				}
			} catch (err) {
				console.error("[GJJ] 处理错误事件失败:", err);
			}
		});
	},
});

if (!app.__gjjAudioSegmentQueuePromptPatched && typeof app.queuePrompt === "function") {
	app.__gjjAudioSegmentQueuePromptPatched = true;
	const originalQueuePrompt = app.queuePrompt;
	app.queuePrompt = async function (...args) {
		syncAllAudioSegmentEditors();
		return originalQueuePrompt.apply(this, args);
	};
}

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_FFmpegMuxAudioVideo"]);
const PREVIEW_WIDGET_NAME = "gjj_ffmpeg_mux_preview";
const HIDDEN_WIDGETS = new Set([
	"filename_prefix",
	"default_fps",
	"ffmpeg_path",
	"ffprobe_path",
	"video_path",
	"audio_path",
]);
const DELETE_TAIL_FRAME_WIDGET = "delete_tail_frame";
const INPUT_SPECS = [
	["images", "GJJ_BATCH_IMAGE,IMAGE,VIDEO,STRING", "图片帧", "可连接视频片段、图片帧、VIDEO 对象，或分段视频文件名前缀。"],
	["audio", "AUDIO,VIDEO,STRING", "音频", "可选。支持 AUDIO、VIDEO 或音频/视频文件路径。"],
	["fps", "INT,FLOAT,STRING,VIDEO", "帧率", "可选。支持 INT、FLOAT、STRING；接 VIDEO 时读取源帧率。"],
	["condition", "BOOLEAN", "条件通行", "可选布尔门控；为假时本节点跳过。"],
	["delete_tail_frame", "INT", "删除尾帧数", "0 表示不删除；大于 0 时自动递进为 1、5、9、13...。合并分段视频时删除每个非最后分段的尾部帧。"],
	["delete_segments_after_merge", "BOOLEAN", "合并后删除片段", "合并成功并生成最终视频后删除参与合并的原始片段文件；不会删除输出成品。"],
	["wait_for", "*", "等待完成", "任意类型依赖输入；不参与合并，只用于等待最后一段或其它上游节点执行完成后再开始合并。"],
];

function buildViewUrl(item) {
	if (!item?.filename) return "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}${randParam}`,
	);
}

function normalizeSlotName(value) {
	return String(value || "").replace(/^converted-widget:/i, "");
}

function inputSpecInfo(input) {
	const name = normalizeSlotName(input?.name);
	const label = String(input?.localized_name || input?.label || input?.display_name || "");
	const widgetName = String(input?.widget?.name || input?.widget_name || "");
	return INPUT_SPECS.findIndex((spec) => spec[0] === name || spec[2] === label || spec[0] === widgetName);
}

function applyInputSpec(input, spec) {
	if (!input || !spec) return;
	const [name, type, label, tooltip] = spec;
	input.name = name;
	input.type = type;
	input.label = label;
	input.localized_name = label;
	input.display_name = label;
	input.tooltip = tooltip;
	input.hidden = false;
	input.visible = true;
}

function ensureInput(node, spec) {
	const [name] = spec;
	let input = Array.isArray(node?.inputs)
		? node.inputs.find((item) => normalizeSlotName(item?.name) === name || String(item?.localized_name || item?.label || "") === spec[2])
		: null;
	if (!input) {
		node.addInput?.(name, spec[1]);
		input = node.inputs?.[node.inputs.length - 1] || null;
	}
	applyInputSpec(input, spec);
}

function syncInputLinkSlots(node) {
	const links = node?.graph?.links || app.graph?.links || {};
	for (let index = 0; index < (node.inputs?.length || 0); index += 1) {
		const linkId = node.inputs[index]?.link;
		const link = linkId != null ? links[linkId] : null;
		if (link) link.target_slot = index;
	}
}

function preferredNodeWidth(node) {
	return Math.max(320, Math.round(Number(node?.size?.[0] || 360)));
}

function normalizeDeleteTailFrameCount(value) {
	if (value === true) return 1;
	if (value === false || value == null) return 0;
	const text = String(value).trim().toLowerCase();
	if (["true", "yes", "on", "enable", "enabled", "开", "是", "真"].includes(text)) return 1;
	if (!text || ["false", "no", "off", "disable", "disabled", "关", "否", "假"].includes(text)) return 0;
	let number = Math.round(Number.parseFloat(text));
	if (!Number.isFinite(number) || number <= 0) return 0;
	return Math.max(1, (Math.max(0, Math.ceil((number - 1) / 4)) * 4) + 1);
}

function decorateDeleteTailFrameWidget(node) {
	const widget = GJJ_Utils.getWidget(node, DELETE_TAIL_FRAME_WIDGET);
	if (!widget) return;
	widget.type = "number";
	widget.label = "删除尾帧数";
	widget.localized_name = "删除尾帧数";
	widget.display_name = "删除尾帧数";
	widget.tooltip = "0 表示不删除；大于 0 时自动递进为 1、5、9、13...。";
	widget.options ||= {};
	widget.options.min = 0;
	widget.options.max = 10001;
	widget.options.step = 1;
	widget.options.display_name = "删除尾帧数";
	widget.options.tooltip = widget.tooltip;
	const normalized = normalizeDeleteTailFrameCount(widget.value);
	if (widget.value !== normalized) widget.value = normalized;
	if (!widget.__gjjFfmpegMuxDeleteTailPatched) {
		const originalCallback = widget.callback;
		widget.callback = function (value, ...args) {
			const fixed = normalizeDeleteTailFrameCount(value);
			this.value = fixed;
			return originalCallback?.call(this, fixed, ...args);
		};
		widget.__gjjFfmpegMuxDeleteTailPatched = true;
	}
}

function decorateDeleteSegmentsAfterMergeWidget(node) {
	const widget = GJJ_Utils.getWidget(node, "delete_segments_after_merge");
	if (!widget) return;
	widget.label = "合并后删除片段";
	widget.localized_name = "合并后删除片段";
	widget.display_name = "合并后删除片段";
	widget.tooltip = "合并成功并生成最终视频后删除参与合并的原始片段文件；不会删除输出成品。";
	widget.options ||= {};
	widget.options.display_name = "合并后删除片段";
	widget.options.tooltip = widget.tooltip;
}

function ensurePreviewWidget(node) {
	if (node.__gjjFfmpegMuxPreview) return node.__gjjFfmpegMuxPreview;
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:none",
		"width:100%",
		"box-sizing:border-box",
		"padding:0",
	].join(";");
	const card = document.createElement("div");
	card.style.cssText = [
		"width:100%",
		"height:180px",
		"box-sizing:border-box",
		"border:1px solid #263a42",
		"border-radius:8px",
		"overflow:hidden",
		"background:#05090c",
		"display:flex",
		"align-items:center",
		"justify-content:center",
	].join(";");
	const video = document.createElement("video");
	video.controls = true;
	video.loop = true;
	video.muted = true;
	video.playsInline = true;
	video.preload = "metadata";
	video.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;display:block;";
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
		wrap.addEventListener(eventName, (event) => event.stopPropagation());
		video.addEventListener(eventName, (event) => event.stopPropagation());
	}
	card.append(video);
	wrap.append(card);
	const widget = node.addDOMWidget?.(PREVIEW_WIDGET_NAME, "HTML", wrap, {
		hideOnZoom: false,
		serialize: false,
		getHeight: () => (wrap.style.display === "none" ? 0 : 190),
	});
	if (widget) {
		widget.computeSize = (width) => [preferredNodeWidth({ ...node, size: [width || node.size?.[0], node.size?.[1]] }), wrap.style.display === "none" ? 0 : 190];
	}
	node.__gjjFfmpegMuxPreview = { wrap, card, video, widget };
	return node.__gjjFfmpegMuxPreview;
}

function setMuxPreview(node, message = {}) {
	const state = ensurePreviewWidget(node);
	const item = Array.isArray(message?.preview_media) ? message.preview_media[0] : null;
	const url = buildViewUrl(item);
	if (!url) {
		state.video.pause?.();
		state.video.removeAttribute("src");
		state.video.load?.();
		state.wrap.style.display = "none";
		if (state.widget) {
			state.widget.getHeight = () => 0;
			state.widget.computedHeight = 0;
		}
		GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 320, minHeight: 170 });
		return;
	}
	const width = Math.max(1, Number(item?.width || message?.preview_width?.[0] || 0));
	const height = Math.max(1, Number(item?.height || message?.preview_height?.[0] || 0));
	const aspect = width > 1 && height > 1 ? Math.max(0.2, Math.min(5, width / height)) : 16 / 9;
	const contentWidth = Math.max(260, preferredNodeWidth(node) - 24);
	const previewHeight = Math.round(Math.max(150, Math.min(420, contentWidth / aspect)));
	state.card.style.height = `${previewHeight}px`;
	state.wrap.style.display = "block";
	if (state.widget) {
		state.widget.getHeight = () => previewHeight + 10;
		state.widget.computedHeight = previewHeight + 10;
	}
	state.video.src = url;
	state.video.load?.();
	state.video.play?.()?.catch?.(() => {});
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 320, minHeight: 170 + previewHeight });
}

function compactMuxNode(node) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;

	for (const name of HIDDEN_WIDGETS) {
		const widget = GJJ_Utils.getWidget(node, name);
		if (widget) {
			GJJ_Utils.hideWidget(widget);
			widget.options ||= {};
			widget.options.hidden = true;
			widget.options.display = "hidden";
		}
	}
	decorateDeleteTailFrameWidget(node);
	decorateDeleteSegmentsAfterMergeWidget(node);

	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGETS);
	for (const spec of INPUT_SPECS) ensureInput(node, spec);
	if (Array.isArray(node.inputs)) {
		node.inputs.sort((a, b) => {
			const ai = inputSpecInfo(a);
			const bi = inputSpecInfo(b);
			return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
		});
	}
	syncInputLinkSlots(node);
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
	ensurePreviewWidget(node);
	GJJ_Utils.refreshNode(node, {
		preserveWidth: true,
		minWidth: 320,
		minHeight: 170,
	});
}

function scheduleCompact(node, delay = 0) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	clearTimeout(node.__gjjFfmpegMuxCompactTimer);
	node.__gjjFfmpegMuxCompactTimer = setTimeout(() => {
		compactMuxNode(node);
		GJJ_Utils.scheduleRefreshNode(node, {
			delay: 80,
			preserveWidth: true,
			minWidth: 320,
			minHeight: 170,
		});
	}, delay);
}

app.registerExtension({
	name: "Comfy.GJJ.FFmpegMuxAudioVideo",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			scheduleCompact(this, 0);
			scheduleCompact(this, 160);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			scheduleCompact(this, 0);
			scheduleCompact(this, 180);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			scheduleCompact(this, 0);
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalExecuted?.apply(this, [message, ...args]);
			setMuxPreview(this, message);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			scheduleCompact(node, 0);
		}
	},
});

const VIDEO_FRAMES_NODE = "GJJ_VideoFramesLoader";
const VIDEO_FRAMES_PANEL = "gjj_video_frames_loader_panel";
const VIDEO_FRAMES_HIDDEN = new Set(["video_path", "frame_interval", "max_frames", "ffmpeg_path", "ffprobe_path", "total_frames"]);
const VIDEO_FRAMES_MEDIA = "media";
const VIDEO_FRAMES_LINK_PROP = "gjj_video_frames_loader_remembered_link";

function videoFramesWidget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function videoFramesInputIndex(node) {
	return (node.inputs || []).findIndex((input) => normalizeSlotName(input?.name) === VIDEO_FRAMES_MEDIA);
}

function videoFramesRememberedLink(node) {
	const saved = node?.properties?.[VIDEO_FRAMES_LINK_PROP];
	return saved && saved.originId != null && saved.originSlot != null ? saved : null;
}

function videoFramesSetWidget(node, name, value) {
	const item = videoFramesWidget(node, name);
	if (!item) return;
	item.value = value;
	item.callback?.(value);
	app.graph?.setDirtyCanvas?.(true, true);
}

function videoFramesToggleLink(node) {
	const index = videoFramesInputIndex(node);
	if (index < 0) return;
	node.properties ||= {};
	const linkId = node.inputs?.[index]?.link;
	if (linkId != null) {
		const links = node.graph?.links || app.graph?.links;
		const link = links?.get?.(linkId) || links?.[linkId];
		if (link) {
			node.properties[VIDEO_FRAMES_LINK_PROP] = {
				originId: link.origin_id ?? link[1],
				originSlot: link.origin_slot ?? link[2],
			};
		}
		node.disconnectInput?.(index);
	} else {
		const saved = videoFramesRememberedLink(node);
		const origin = saved ? (node.graph?.getNodeById?.(saved.originId) || app.graph?.getNodeById?.(saved.originId)) : null;
		if (origin) {
			origin.connect?.(saved.originSlot, node, index);
			delete node.properties[VIDEO_FRAMES_LINK_PROP];
		}
	}
	videoFramesRender(node);
	app.graph?.setDirtyCanvas?.(true, true);
}

function videoFramesPreviewUrl(node) {
	const raw = String(videoFramesWidget(node, "video_path")?.value || "").trim().replaceAll("\\", "/");
	if (!raw) return "";
	const parts = raw.split("/").filter(Boolean);
	const filename = parts.pop();
	if (!filename) return "";
	return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(parts.join("/"))}`);
}

function videoFramesHidePreview(node) {
	const tip = node.__gjjVideoFramesPreview;
	if (!tip) return;
	tip.querySelector("video")?.pause?.();
	tip.remove();
	node.__gjjVideoFramesPreview = null;
}

function videoFramesShowPreview(node, anchor) {
	const src = videoFramesPreviewUrl(node);
	if (!src) return;
	videoFramesHidePreview(node);
	const tip = document.createElement("div");
	tip.style.cssText = "position:fixed;z-index:10020;width:280px;padding:6px;border:1px solid #47616b;border-radius:8px;background:#071014;box-shadow:0 12px 34px #000b;pointer-events:none;";
	const video = document.createElement("video");
	video.src = src; video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
	video.style.cssText = "display:block;width:100%;max-height:220px;object-fit:contain;background:#000;border-radius:5px;";
	tip.appendChild(video); document.body.appendChild(tip);
	const rect = anchor.getBoundingClientRect();
	tip.style.left = `${Math.min(window.innerWidth - 292, Math.max(8, rect.left))}px`;
	tip.style.top = `${Math.min(window.innerHeight - 240, rect.bottom + 6)}px`;
	node.__gjjVideoFramesPreview = tip;
	video.play?.().catch?.(() => {});
}

function videoFramesOpenSettings(node) {
	document.querySelector(".gjj-video-frames-settings")?.remove();
	const overlay = document.createElement("div");
	overlay.className = "gjj-video-frames-settings";
	overlay.style.cssText = "position:fixed;inset:0;z-index:10030;display:grid;place-items:center;background:#0008;";
	const dialog = document.createElement("div");
	dialog.style.cssText = "width:min(440px,calc(100vw - 32px));padding:16px;border:1px solid #49616b;border-radius:10px;background:#10191e;color:#e8f2f4;box-shadow:0 18px 60px #000c;font:13px sans-serif;";
	const title = document.createElement("div"); title.textContent = "⚙️ 视频抽帧参数"; title.style.cssText = "font-size:16px;font-weight:800;margin-bottom:12px;";
	dialog.appendChild(title);
	const totalItem = videoFramesWidget(node, "total_frames");
	const legacyTotalItem = videoFramesWidget(node, "max_frames");
	const intervalItem = videoFramesWidget(node, "frame_interval");
	let sampleMode = Number(totalItem?.value || 0) > 0 || Number(legacyTotalItem?.value || 0) > 0 ? "total" : "interval";
	const modeRow = document.createElement("div"); modeRow.style.cssText = "display:grid;grid-template-columns:110px 1fr 1fr;gap:8px;align-items:center;margin:10px 0;";
	const modeCaption = document.createElement("span"); modeCaption.textContent = "抽帧方式";
	const modeButton = (label, mode) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.style.cssText = "height:34px;border:1px solid #40545d;border-radius:6px;background:#142027;color:#eef7f8;font-weight:800;cursor:pointer;"; button.onclick = () => setMode(mode); return button; };
	const totalModeButton = modeButton("按总帧数", "total");
	const intervalModeButton = modeButton("按间隔", "interval");
	modeRow.append(modeCaption, totalModeButton, intervalModeButton); dialog.appendChild(modeRow);
	const totalRow = document.createElement("label"); totalRow.style.cssText = "display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;align-items:center;margin:10px 0;";
	const totalCaption = document.createElement("span"); totalCaption.textContent = "总帧数";
	const totalInput = document.createElement("input"); totalInput.type = "number"; totalInput.min = "0"; totalInput.max = "10000"; totalInput.step = "1";
	totalInput.value = String(Number(totalItem?.value || 0) || Number(legacyTotalItem?.value || 0));
	totalInput.title = "最终需要多少帧；从完整视频开始到结束均匀获取。0 表示全部帧。";
	totalInput.style.cssText = "min-width:0;height:32px;box-sizing:border-box;border:1px solid #40545d;border-radius:6px;background:#091216;color:#eef7f8;padding:0 9px;";
	totalInput.onchange = () => { const value = Math.max(0, Math.min(10000, Math.round(Number(totalInput.value) || 0))); videoFramesSetWidget(node, "max_frames", value); videoFramesSetWidget(node, "total_frames", value); videoFramesSetWidget(node, "frame_interval", 1); totalInput.value = String(value); setMode("total", false); };
	totalRow.append(totalCaption, totalInput); dialog.appendChild(totalRow);
	const intervalRow = document.createElement("label"); intervalRow.style.cssText = totalRow.style.cssText;
	const intervalCaption = document.createElement("span"); intervalCaption.textContent = "抽帧间隔";
	const intervalInput = document.createElement("input"); intervalInput.type = "number"; intervalInput.min = "1"; intervalInput.max = "1000"; intervalInput.step = "1"; intervalInput.value = String(Math.max(1, Number(intervalItem?.value || 1))); intervalInput.style.cssText = totalInput.style.cssText;
	intervalInput.title = "每隔多少帧取一帧。";
	intervalInput.onchange = () => { const value = Math.max(1, Math.min(1000, Math.round(Number(intervalInput.value) || 1))); videoFramesSetWidget(node, "frame_interval", value); videoFramesSetWidget(node, "max_frames", 0); videoFramesSetWidget(node, "total_frames", 0); intervalInput.value = String(value); setMode("interval", false); };
	intervalRow.append(intervalCaption, intervalInput); dialog.appendChild(intervalRow);
	function setMode(mode, applyDefaults = true) {
		sampleMode = mode;
		if (applyDefaults && mode === "total") { const value = Math.max(1, Math.round(Number(totalInput.value) || 8)); totalInput.value = String(value); videoFramesSetWidget(node, "max_frames", value); videoFramesSetWidget(node, "total_frames", value); videoFramesSetWidget(node, "frame_interval", 1); }
		if (applyDefaults && mode === "interval") { videoFramesSetWidget(node, "max_frames", 0); videoFramesSetWidget(node, "total_frames", 0); videoFramesSetWidget(node, "frame_interval", Math.max(1, Math.round(Number(intervalInput.value) || 1))); }
		totalRow.style.display = mode === "total" ? "grid" : "none"; intervalRow.style.display = mode === "interval" ? "grid" : "none";
		totalModeButton.style.background = mode === "total" ? "#0d8fb0" : "#142027"; intervalModeButton.style.background = mode === "interval" ? "#0d8fb0" : "#142027";
		totalModeButton.style.borderColor = mode === "total" ? "#26d5dc" : "#40545d"; intervalModeButton.style.borderColor = mode === "interval" ? "#26d5dc" : "#40545d";
	}
	setMode(sampleMode, false);
	for (const name of ["ffmpeg_path", "ffprobe_path"]) {
		const item = videoFramesWidget(node, name); if (!item) continue;
		if (name === "ffprobe_path" && String(item.value || "").trim().toLowerCase() === "ffmpeg") videoFramesSetWidget(node, name, "ffprobe");
		const row = document.createElement("label"); row.style.cssText = "display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;align-items:center;margin:10px 0;";
		const caption = document.createElement("span"); caption.textContent = item.options?.display_name || item.label || name;
		const input = document.createElement("input"); input.type = typeof item.value === "number" ? "number" : "text"; input.value = String(item.value ?? "");
		input.style.cssText = "min-width:0;height:32px;box-sizing:border-box;border:1px solid #40545d;border-radius:6px;background:#091216;color:#eef7f8;padding:0 9px;";
		for (const key of ["min", "max", "step"]) if (item.options?.[key] != null) input[key] = item.options[key];
		input.onchange = () => videoFramesSetWidget(node, name, typeof item.value === "number" ? Number(input.value) : input.value);
		row.append(caption, input); dialog.appendChild(row);
	}
	const close = document.createElement("button"); close.type = "button"; close.textContent = "完成"; close.style.cssText = "float:right;margin-top:8px;height:32px;padding:0 18px;border:1px solid #2dbb87;border-radius:6px;background:#13764f;color:#fff;font-weight:800;cursor:pointer;";
	close.onclick = () => overlay.remove(); dialog.appendChild(close);
	overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
	dialog.onclick = (event) => event.stopPropagation(); overlay.appendChild(dialog); document.body.appendChild(overlay);
}

async function videoFramesChooseVideo(node) {
	if (node.inputs?.[videoFramesInputIndex(node)]?.link != null) return;
	const input = document.createElement("input"); input.type = "file"; input.accept = "video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v";
	input.onchange = async () => {
		const file = input.files?.[0]; if (!file) return;
		try {
			const form = new FormData(); form.append("video", file, file.name);
			const response = await api.fetchApi("/gjj/upload_video", { method: "POST", body: form });
			const data = await response.json();
			if (!response.ok) throw new Error(data?.error || `上传失败：${response.status}`);
			const item = Array.isArray(data?.videos) ? data.videos[0] : data;
			const filename = String(item?.filename || item?.name || "");
			if (!filename) throw new Error("上传接口没有返回视频文件");
			videoFramesSetWidget(node, "video_path", [String(item?.subfolder || ""), filename].filter(Boolean).join("/"));
			videoFramesRender(node);
		} catch (error) { alert(error?.message || "打开视频失败"); }
	};
	input.click();
}

function videoFramesBuildPanel(node) {
	const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;width:100%;box-sizing:border-box;padding:2px 0;";
	const button = (text, title) => { const value = document.createElement("button"); value.type = "button"; value.textContent = text; value.title = title; value.style.cssText = "height:30px;border:1px solid #40545d;border-radius:6px;background:#152128;color:#eef7f8;padding:0 10px;font-weight:800;cursor:pointer;"; return value; };
	const open = button("📁 打开视频", "打开本机视频；已打开视频时移入可预览"); open.style.flex = "1";
	const link = button("🔗", "记住并断开上游链接"); link.style.width = "36px"; link.style.padding = "0";
	const settings = button("⚙️", "打开其它参数"); settings.style.width = "36px"; settings.style.padding = "0";
	open.onclick = () => videoFramesChooseVideo(node); link.onclick = () => videoFramesToggleLink(node); settings.onclick = () => videoFramesOpenSettings(node);
	open.onmouseenter = () => videoFramesShowPreview(node, open); open.onmouseleave = () => videoFramesHidePreview(node);
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel"]) row.addEventListener(eventName, (event) => event.stopPropagation());
	row.append(open, link, settings); node.__gjjVideoFramesElements = { row, open, link, settings }; return row;
}

function videoFramesRender(node) {
	const elements = node.__gjjVideoFramesElements; if (!elements) return;
	const index = videoFramesInputIndex(node); const linked = index >= 0 && node.inputs?.[index]?.link != null; const remembered = Boolean(videoFramesRememberedLink(node));
	elements.open.disabled = linked; elements.open.style.opacity = linked ? "0.42" : "1"; elements.open.style.cursor = linked ? "not-allowed" : "pointer";
	elements.open.title = linked ? "媒体输入已有上游连接；请先点击 🔗 临时断开" : (videoFramesPreviewUrl(node) ? "已打开视频；移入预览，点击可重新选择" : "打开本机视频");
	elements.link.style.display = linked || remembered ? "" : "none";
	elements.link.style.background = remembered && !linked ? "#865b16" : "#152128";
	elements.link.title = remembered && !linked ? "恢复记住的上游链接" : "记住并断开上游链接";
}

function videoFramesStabilize(node) {
	if (!node || node.comfyClass !== VIDEO_FRAMES_NODE) return;
	for (const name of VIDEO_FRAMES_HIDDEN) {
		const item = videoFramesWidget(node, name); if (!item) continue;
		GJJ_Utils.hideWidget(item); item.options ||= {}; item.options.hidden = true; item.options.display = "hidden";
	}
	GJJ_Utils.removeHiddenInputSockets(node, VIDEO_FRAMES_HIDDEN);
	let media = node.inputs?.find((input) => normalizeSlotName(input?.name) === VIDEO_FRAMES_MEDIA);
	if (!media) { node.addInput?.(VIDEO_FRAMES_MEDIA, "GJJ_BATCH_IMAGE,IMAGE,VIDEO"); media = node.inputs?.at(-1); }
	if (media) { media.type = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"; media.label = media.localized_name = media.display_name = "媒体输入"; media.tooltip = "支持 GJJ_BATCH_IMAGE、IMAGE、VIDEO；连接后优先使用外部输入。"; }
	if (!node.__gjjVideoFramesPanelWidget) {
		const panel = videoFramesBuildPanel(node);
		const widget = node.addDOMWidget?.(VIDEO_FRAMES_PANEL, "HTML", panel, { serialize: false, hideOnZoom: false });
		if (widget) { widget.computeSize = (width) => [Number(width || node.size?.[0] || 320), 38]; widget.getHeight = () => 38; }
		node.__gjjVideoFramesPanelWidget = widget;
	}
	GJJ_Utils.reorderWidgets(node, VIDEO_FRAMES_HIDDEN); videoFramesRender(node);
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 320, minHeight: 90 });
}

app.registerExtension({
	name: "Comfy.GJJ.VideoFramesLoader.CompactPanel",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== VIDEO_FRAMES_NODE) return;
		const created = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); setTimeout(() => videoFramesStabilize(this), 0); setTimeout(() => videoFramesStabilize(this), 160); return result; };
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); this.properties ||= {}; Object.assign(this.properties, args[0]?.properties || {}); setTimeout(() => videoFramesStabilize(this), 0); setTimeout(() => videoFramesStabilize(this), 180); return result; };
		const connections = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) { const result = connections?.apply(this, args); setTimeout(() => videoFramesStabilize(this), 0); return result; };
		const serialized = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) { this.properties ||= {}; const result = serialized?.apply(this, [data]); data.properties ||= {}; if (this.properties[VIDEO_FRAMES_LINK_PROP]) data.properties[VIDEO_FRAMES_LINK_PROP] = this.properties[VIDEO_FRAMES_LINK_PROP]; return result; };
	},
	setup() { for (const node of app.graph?._nodes || []) if (node?.comfyClass === VIDEO_FRAMES_NODE) videoFramesStabilize(node); },
});

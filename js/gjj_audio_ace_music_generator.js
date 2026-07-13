import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_AudioAceMusicGenerator"]);
const STATUS_WIDGET_NAME = "gjj_audio_ace_music_status";
const AUDIO_WIDGET_NAME = "gjj_audio_ace_music_audio";
const COMPACT_PANEL_HEIGHT = 158;
const SIMPLE_HOME_WIDGETS = new Set(["lyrics", "tags"]);
const HIDDEN_HOME_WIDGETS = new Set([
	"model_name",
	"tags",
	"lyrics",
	"duration",
	"bpm",
	"timesignature",
	"language",
	"keyscale",
	"seed",
	"lyrics_strength",
	"generate_audio_codes",
	"cfg_scale",
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"shift",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
]);

function isExecutionOutputNode(node) {
	if (!node) return false;
	if (node === undefined || node === null) return false;
	if (node.comfyClass === "GJJ_AudioAceMusicGenerator") return true;
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

		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);

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

		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = value;
	try {
		widget.callback?.(value);
	} catch (_) {}
	if (Array.isArray(node.widgets_values)) {
		const serializableWidgets = (node.widgets || []).filter((item) => item?.options?.serialize !== false && item?.serialize !== false);
		const index = serializableWidgets.indexOf(widget);
		if (index >= 0) {
			node.widgets_values[index] = value;
		}
	}
	node.graph && (node.graph._version += 1);
	syncTextareasFromWidgets(node);
	refreshNode(node);
}

function appendUniqueTag(node, text) {
	const widget = getWidget(node, "tags");
	const current = String(widget?.value || "").trim();
	const exists = current.toLowerCase().includes(String(text).toLowerCase());
	setWidgetValue(node, "tags", exists || !current ? current || text : `${current}，${text}`);
}

function cycleChoice(node, name, values) {
	const widget = getWidget(node, name);
	if (!widget || !values.length) return;
	const currentIndex = values.indexOf(String(widget.value || ""));
	const next = values[(currentIndex + 1 + values.length) % values.length];
	setWidgetValue(node, name, next);
}

function randomizeSeed(node) {
	const seed = Math.floor(Math.random() * 0xFFFFFFFF);
	setWidgetValue(node, "seed", seed);
}

function cycleDuration(node) {
	const widget = getWidget(node, "duration");
	const durations = [60, 90, 120, 180, 240];
	const current = Number(widget?.value || 120);
	const currentIndex = durations.findIndex((item) => item >= current);
	const next = durations[(currentIndex + 1 + durations.length) % durations.length];
	setWidgetValue(node, "duration", next);
}

function syncTextareasFromWidgets(node) {
	const panel = node?.__gjjAudioAceMusicStatus;
	if (!panel) return;
	for (const name of SIMPLE_HOME_WIDGETS) {
		const textarea = panel.inputs?.[name];
		const widget = getWidget(node, name);
		if (textarea && widget && textarea.value !== String(widget.value || "")) {
			textarea.value = String(widget.value || "");
		}
	}
}

function hideHomeWidgets(node) {
	for (const name of HIDDEN_HOME_WIDGETS) {
		GJJ_Utils.hideWidget(getWidget(node, name));
	}
	GJJ_Utils.reorderWidgets(node, HIDDEN_HOME_WIDGETS);
}

function createIconButton({ icon, title, color = "#293340", onClick }) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = icon;
	button.title = title;
	button.style.cssText = [
		"width:28px",
		"height:28px",
		"border:1px solid rgba(255,255,255,.12)",
		"border-radius:6px",
		`background:${color}`,
		"color:#fff",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"font-size:14px",
		"line-height:1",
		"cursor:pointer",
		"padding:0",
		"box-shadow:inset 0 1px 0 rgba(255,255,255,.08)",
	].join(";");
	button.addEventListener("mouseenter", () => {
		button.style.filter = "brightness(1.15)";
	});
	button.addEventListener("mouseleave", () => {
		button.style.filter = "";
	});
	if (onClick) {
		button.addEventListener("click", onClick);
	}
	return button;
}

function createTextField(node, name, labelText, placeholder) {
	const wrap = document.createElement("label");
	wrap.style.cssText = [
		"display:grid",
		"grid-template-columns:56px minmax(0,1fr)",
		"align-items:start",
		"gap:6px",
		"min-width:0",
	].join(";");

	const label = document.createElement("span");
	label.textContent = labelText;
	label.style.cssText = [
		"color:#c9d4d0",
		"font-size:12px",
		"line-height:28px",
		"white-space:nowrap",
	].join(";");

	const textarea = document.createElement("textarea");
	textarea.value = String(getWidget(node, name)?.value || "");
	textarea.placeholder = placeholder;
	textarea.spellcheck = false;
	textarea.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"height:42px",
		"resize:none",
		"border:1px solid rgba(255,255,255,.08)",
		"border-radius:6px",
		"background:#2d3034",
		"color:#eef5f1",
		"font:12px/1.35 sans-serif",
		"padding:7px 9px",
		"outline:none",
		"overflow:auto",
	].join(";");
	textarea.addEventListener("input", () => setWidgetValue(node, name, textarea.value));
	wrap.append(label, textarea);
	return { wrap, textarea };
}

function progressFromText(text) {
	const value = String(text || "");
	if (value.includes("完成")) return 100;
	if (value.includes("解码")) return 83;
	if (value.includes("采样")) return 66;
	if (value.includes("构建")) return 50;
	if (value.includes("编码")) return 33;
	if (value.includes("加载")) return 16;
	if (value.includes("失败")) return 100;
	return 0;
}

function normalizeProgress(progress, fallback) {
	const value = Number(progress);
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return value <= 1 ? value * 100 : value;
}

function ensureStatusWidget(node) {
	if (node.__gjjAudioAceMusicStatus) {
		return node.__gjjAudioAceMusicStatus;
	}
	const box = document.createElement("div");
	box.style.cssText = [
		"box-sizing:border-box",
		"padding:4px 8px 6px",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
	].join(";");

	const statusRow = document.createElement("div");
	statusRow.style.cssText = "display:flex;gap:5px;align-items:center;min-width:0;margin-bottom:6px;overflow:hidden";

	const statusContent = document.createElement("div");
	statusContent.style.cssText = "flex:1;min-width:0;display:flex;align-items:center;gap:5px";

	const label = document.createElement("div");
	label.textContent = "等待执行";
	label.title = "等待执行";
	label.style.cssText = "display:none";

	const track = document.createElement("div");
	track.style.cssText = [
		"height:4px",
		"overflow:hidden",
		"border-radius:999px",
		"background:#253038",
		"flex:1",
		"min-width:26px",
	].join(";");
	const bar = document.createElement("div");
	bar.style.cssText = [
		"width:0%",
		"height:100%",
		"border-radius:999px",
		"background:#5aa8ff",
		"transition:width 160ms ease",
	].join(";");
	track.appendChild(bar);
	statusContent.append(track, label);

	const inputs = {};
	const generateBtn = createIconButton({ icon: "🎵", title: "只执行当前节点，生成音乐", color: "#0f8c55" });
	statusRow.append(
		createIconButton({ icon: "🔄", title: "刷新节点", color: "#315db9", onClick: () => refreshNode(node) }),
		createIconButton({ icon: "▶️", title: "只执行当前节点", color: "#16845a", onClick: () => generateBtn.click() }),
		createIconButton({ icon: "🎲", title: "随机种子", color: "#4a4f5c", onClick: () => randomizeSeed(node) }),
		createIconButton({ icon: "🌐", title: "切换语言 zh / en / ja / ko", color: "#16728d", onClick: () => cycleChoice(node, "language", ["zh", "en", "ja", "ko"]) }),
		createIconButton({ icon: "🪄", title: "填入默认音乐标签", color: "#a65f00", onClick: () => setWidgetValue(node, "tags", "流行音乐，女声独唱，旋律抓耳，高音质，编曲完整。") }),
		generateBtn,
		createIconButton({ icon: "⚡", title: "切换时长", color: "#72500f", onClick: () => cycleDuration(node) }),
		createIconButton({ icon: "🧠", title: "纯音乐模式", color: "#4d3d83", onClick: () => {
			setWidgetValue(node, "lyrics", "");
			appendUniqueTag(node, "纯音乐，无人声");
			syncTextareasFromWidgets(node);
		} }),
		createIconButton({ icon: "⚙️", title: "使用隐藏的默认高级参数", color: "#3d4251" }),
		statusContent,
	);

	const lyricsField = createTextField(node, "lyrics", "歌词", "纯音乐可留空");
	const tagsField = createTextField(node, "tags", "音乐标签", "曲风、情绪、声线、音质要求");
	inputs.lyrics = lyricsField.textarea;
	inputs.tags = tagsField.textarea;

	const fields = document.createElement("div");
	fields.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:0";
	fields.append(lyricsField.wrap, tagsField.wrap);

	box.append(statusRow, fields);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => COMPACT_PANEL_HEIGHT,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(320, Number(width || node.size?.[0] || 360)), COMPACT_PANEL_HEIGHT];
	}

	node.__gjjAudioAceMusicStatus = { widget, box, label, bar, generateBtn, inputs };
	return node.__gjjAudioAceMusicStatus;
}

function setStatus(node, text, progress = null) {
	const status = node?.__gjjAudioAceMusicStatus;
	if (!status) {
		return;
	}
	const message = String(text || "等待执行");
	status.label.textContent = message;
	status.label.title = message;
	const percent = normalizeProgress(progress, progressFromText(message));
	status.bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
	refreshNode(node);
}

function buildViewUrl(item) {
	const params = new URLSearchParams();
	params.set("filename", item.filename || "");
	params.set("type", item.type || "output");
	if (item.subfolder) {
		params.set("subfolder", item.subfolder);
	}
	params.set("rand", String(Date.now()));
	return `/view?${params.toString()}`;
}

function ensureAudioWidget(node) {
	if (node.__gjjAudioAceMusicAudio) {
		return node.__gjjAudioAceMusicAudio;
	}
	const box = document.createElement("div");
	box.style.cssText = [
		"display:none",
		"padding:8px 10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#22282d",
	].join(";");
	const audio = document.createElement("audio");
	audio.controls = true;
	audio.preload = "metadata";
	audio.style.cssText = "display:block;width:100%;height:34px";
	const row = document.createElement("div");
	row.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:6px;font-size:12px";
	const openLink = document.createElement("a");
	openLink.textContent = "打开";
	openLink.target = "_blank";
	openLink.rel = "noopener";
	openLink.style.cssText = "color:#9ecbff;text-decoration:none";
	const downloadLink = document.createElement("a");
	downloadLink.textContent = "下载";
	downloadLink.download = "";
	downloadLink.style.cssText = "color:#9ecbff;text-decoration:none";
	row.append(openLink, downloadLink);
	box.append(audio, row);
	const widget = node.addDOMWidget?.(AUDIO_WIDGET_NAME, AUDIO_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => (box.style.display === "none" ? 0 : 92),
	});
	node.__gjjAudioAceMusicAudio = { widget, box, audio, openLink, downloadLink };
	return node.__gjjAudioAceMusicAudio;
}

function extractAudioItem(message) {
	const audioList = message?.audio;
	if (!Array.isArray(audioList) || !audioList.length) {
		return null;
	}
	const first = audioList[0];
	if (typeof first === "string") {
		return { filename: first, type: "output" };
	}
	if (first && typeof first === "object" && first.filename) {
		return first;
	}
	return null;
}

function setAudioPreview(node, message) {
	const item = extractAudioItem(message);
	if (!item) {
		return;
	}
	const audioWidget = ensureAudioWidget(node);
	const url = buildViewUrl(item);
	audioWidget.audio.src = url;
	audioWidget.openLink.href = url;
	audioWidget.downloadLink.href = url;
	audioWidget.downloadLink.download = item.filename || "GJJ_ACEMusic.mp3";
	audioWidget.box.style.display = "block";
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjAudioAceMusicPatched) {
		return;
	}
	node.__gjjAudioAceMusicPatched = true;
	ensureStatusWidget(node);
	ensureAudioWidget(node);
	hideHomeWidgets(node);
	syncTextareasFromWidgets(node);
	setStatus(node, "等待执行");

	node.setSize?.([Math.max(360, node.size?.[0] || 360), node.computeSize?.()[1] || 260]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);

	const status = node.__gjjAudioAceMusicStatus;
	if (status?.generateBtn) {
		status.generateBtn.addEventListener("click", async () => {
			console.log("[GJJ] 生成音乐: 只执行当前节点");
			const btn = status.generateBtn;
			const originalText = btn.textContent;

			try {
				btn.textContent = "⏳";
				btn.title = "生成中...";
				btn.disabled = true;
				btn.style.cursor = "not-allowed";
				btn.style.opacity = "0.65";

				setStatus(node, "正在生成音乐...");

				const ok = await queueOnlyCurrentNode(node);

				if (!ok) {
					console.warn("[GJJ] 生成音乐失败：queueOnlyCurrentNode 返回 false");
					setStatus(node, "生成失败");
				}
			} catch (err) {
				console.error("[GJJ] 生成音乐失败:", err);
				setStatus(node, "生成失败");
			} finally {
				setTimeout(() => {
					btn.textContent = originalText;
					btn.title = "只执行当前节点，生成音乐";
					btn.disabled = false;
					btn.style.cursor = "pointer";
					btn.style.opacity = "1";
				}, 500);
			}
		});
	}
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

api.addEventListener("gjj_node_audio", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setAudioPreview(targetNode, detail);
});

app.registerExtension({
	name: "GJJ.AudioAceMusicGenerator",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			if (message?.audio && Array.isArray(message.audio) && message.audio.length > 0) {
				setAudioPreview(this, message);
			}
			return result;
		};
	},
});

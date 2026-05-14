import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_AudioAceMusicGenerator"]);
const STATUS_WIDGET_NAME = "gjj_audio_ace_music_status";
const AUDIO_WIDGET_NAME = "gjj_audio_ace_music_audio";

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
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");

	const statusRow = document.createElement("div");
	statusRow.style.cssText = "display:flex;gap:8px;align-items:center";

	const statusContent = document.createElement("div");
	statusContent.style.cssText = "flex:1;min-width:0";

	const label = document.createElement("div");
	label.textContent = "等待执行";
	label.style.cssText = "margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

	const track = document.createElement("div");
	track.style.cssText = [
		"height:5px",
		"overflow:hidden",
		"border-radius:999px",
		"background:#27343b",
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
	statusContent.append(label, track);

	const generateBtn = document.createElement("button");
	generateBtn.textContent = "🎵 生成音乐";
	generateBtn.title = "只执行当前节点，生成音乐";
	generateBtn.style.cssText = [
		"background: #2d5a9e",
		"color: #fff",
		"border: none",
		"border-radius:4px",
		"padding: 4px 12px",
		"cursor: pointer",
		"font-size: 11px",
		"font-weight: bold",
		"white-space: nowrap",
	].join(";");
	generateBtn.addEventListener("mouseenter", () => generateBtn.style.background = "#3d6aae");
	generateBtn.addEventListener("mouseleave", () => generateBtn.style.background = "#2d5a9e");

	statusRow.append(statusContent, generateBtn);
	box.appendChild(statusRow);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 70,
	});

	node.__gjjAudioAceMusicStatus = { widget, box, label, bar, generateBtn };
	return node.__gjjAudioAceMusicStatus;
}

function setStatus(node, text, progress = null) {
	const status = node?.__gjjAudioAceMusicStatus;
	if (!status) {
		return;
	}
	const message = String(text || "等待执行");
	status.label.textContent = message;
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
	setStatus(node, "等待执行");

	node.setSize?.([node.size?.[0] || 400, node.computeSize?.()[1] || 400]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);

	const status = node.__gjjAudioAceMusicStatus;
	if (status?.generateBtn) {
		status.generateBtn.addEventListener("click", async () => {
			console.log("[GJJ] 生成音乐: 只执行当前节点");
			const btn = status.generateBtn;
			const originalText = btn.textContent;

			try {
				btn.textContent = "⏳ 生成中...";
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

		const originalOnConfigure = nodeType.prototype.onConfigure = function (...args) {
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
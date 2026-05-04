import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_CosyVoice3Generator"]);
const STATUS_WIDGET_NAME = "gjj_cosyvoice3_status";
const AUDIO_WIDGET_NAME = "gjj_cosyvoice3_audio";

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjCosyVoice3Status) {
		return node.__gjjCosyVoice3Status;
	}
	const box = document.createElement("div");
	box.style.cssText = [
		"min-height:34px",
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
	const label = document.createElement("div");
	label.textContent = "等待执行";
	label.style.cssText = "margin-bottom:6px";
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
	box.append(label, track);
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		hideOnZoom: false,
		getHeight: () => 54,
	});
	node.__gjjCosyVoice3Status = { widget, box, label, bar };
	return node.__gjjCosyVoice3Status;
}

function progressFromText(text) {
	const value = String(text || "");
	if (value.includes("完成")) return 100;
	if (value.includes("保存")) return 92;
	if (value.includes("整理")) return 80;
	if (value.includes("执行")) return 55;
	if (value.includes("转录")) return 38;
	if (value.includes("加载")) return 28;
	if (value.includes("准备")) return 12;
	if (value.includes("失败")) return 100;
	return 0;
}

function setStatus(node, text, progress = null) {
	const status = node?.__gjjCosyVoice3Status;
	if (!status) {
		return;
	}
	const message = String(text || "等待执行");
	status.label.textContent = message;
	const percent = progress == null ? progressFromText(message) : progress;
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
	if (node.__gjjCosyVoice3Audio) {
		return node.__gjjCosyVoice3Audio;
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
		hideOnZoom: false,
		getHeight: () => (box.style.display === "none" ? 0 : 92),
	});
	node.__gjjCosyVoice3Audio = { widget, box, audio, openLink, downloadLink };
	return node.__gjjCosyVoice3Audio;
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
	audioWidget.downloadLink.download = item.filename || "GJJ_CosyVoice3.mp3";
	audioWidget.box.style.display = "block";
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjCosyVoice3Patched) {
		return;
	}
	node.__gjjCosyVoice3Patched = true;
	ensureStatusWidget(node);
	ensureAudioWidget(node);
	setStatus(node, "等待执行");
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
	patchNode(targetNode);
	setAudioPreview(targetNode, { audio: detail.audio || [] });
	setStatus(targetNode, "完成，音频已保存", 100);
});

app.registerExtension({
	name: "GJJ.CosyVoice3Generator",
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
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalOnExecuted?.apply(this, [message, ...args]);
			patchNode(this);
			setAudioPreview(this, message);
			if (extractAudioItem(message)) {
				setStatus(this, "完成，音频已保存", 100);
			}
			return result;
		};
	},
});

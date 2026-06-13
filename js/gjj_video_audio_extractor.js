import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_VideoAudioExtractor"]);
const WIDGET_NAME = "gjj_video_audio_extractor_status";
const BASE_TITLE = "GJJ · 🔊 视频提取音频";

function round(value) {
	return Math.round(Number(value || 0));
}

function markCanvasDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function statusFromMessage(message) {
	const text = Array.isArray(message?.gjj_video_audio_status)
		? message.gjj_video_audio_status[0]
		: message?.gjj_video_audio_status;
	const hasAudio = Array.isArray(message?.gjj_video_audio_has_audio)
		? message.gjj_video_audio_has_audio[0]
		: message?.gjj_video_audio_has_audio;
	return {
		text: String(text || "").trim(),
		hasAudio: hasAudio === true || hasAudio === "true" || hasAudio === 1 || hasAudio === "1",
	};
}

function panelHeight(container) {
	if (!container || container.style.display === "none") return 0;
	return Math.max(38, round(container.scrollHeight || container.offsetHeight || 38));
}

function resizeForStatus(node) {
	if (!node) return;
	const width = round(node.size?.[0] || 280);
	const computed = node.computeSize?.() || node.size || [width, 120];
	const height = Math.max(round(computed?.[1] || node.size?.[1] || 120), 92);
	node.setSize?.([width, height]);
	markCanvasDirty(node);
}

function ensureStatusWidget(node) {
	if (!node) return null;
	if (node.__gjjVideoAudioStatus) return node.__gjjVideoAudioStatus;

	const container = document.createElement("div");
	container.style.cssText = [
		"display:none",
		"box-sizing:border-box",
		"width:100%",
		"margin:4px 0 0 0",
		"padding:8px 10px",
		"border-radius:8px",
		"border:1px solid rgba(116,196,185,0.32)",
		"background:rgba(28,46,45,0.72)",
		"color:#d8f3ee",
		"font:12px/1.45 system-ui,'Microsoft YaHei',sans-serif",
		"white-space:normal",
		"overflow:hidden",
	].join(";");

	const title = document.createElement("div");
	title.style.cssText = "font-weight:700;margin-bottom:3px;color:#effffd";
	title.textContent = "状态";

	const body = document.createElement("div");
	body.style.cssText = "color:#c7d9d6";
	container.append(title, body);

	const widget = node.addDOMWidget?.(WIDGET_NAME, "音频提取状态", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.name = WIDGET_NAME;
		widget.computeSize = (width) => [round(width || node.size?.[0] || 280), panelHeight(container)];
		widget.getHeight = () => panelHeight(container);
	}

	node.__gjjVideoAudioStatus = { container, title, body, widget };
	return node.__gjjVideoAudioStatus;
}

function applyStatus(node, status) {
	if (!node) return;
	const state = ensureStatusWidget(node);
	const text = String(status?.text || "").trim();
	const hasAudio = Boolean(status?.hasAudio);
	const hasText = text.length > 0;

	node.properties = node.properties || {};
	if (hasText) {
		node.properties.gjj_video_audio_status = text;
		node.properties.gjj_video_audio_has_audio = hasAudio;
	} else {
		delete node.properties.gjj_video_audio_status;
		delete node.properties.gjj_video_audio_has_audio;
	}

	if (state) {
		state.container.style.display = hasText ? "block" : "none";
		state.title.textContent = hasAudio ? "✅ 音频已提取" : "⚠️ 无音频轨道";
		state.body.textContent = text;
		state.container.style.borderColor = hasAudio ? "rgba(116,196,185,0.38)" : "rgba(255,190,88,0.58)";
		state.container.style.background = hasAudio ? "rgba(28,46,45,0.72)" : "rgba(70,52,24,0.82)";
		state.title.style.color = hasAudio ? "#effffd" : "#fff1c6";
		state.body.style.color = hasAudio ? "#c7d9d6" : "#f4dfab";
	}

	node.title = hasText && !hasAudio ? `${BASE_TITLE}（无音频）` : BASE_TITLE;
	resizeForStatus(node);
	for (const delay of [0, 80, 180]) {
		setTimeout(() => resizeForStatus(node), delay);
	}
}

app.registerExtension({
	name: "Comfy.GJJ.VideoAudioExtractor",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			ensureStatusWidget(this);
			applyStatus(this, {
				text: this.properties?.gjj_video_audio_status || "",
				hasAudio: this.properties?.gjj_video_audio_has_audio === true,
			});
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => applyStatus(this, {
				text: this.properties?.gjj_video_audio_status || "",
				hasAudio: this.properties?.gjj_video_audio_has_audio === true,
			}), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			if (!this.inputs?.some((input) => input?.link)) {
				applyStatus(this, { text: "", hasAudio: false });
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.call(this, message);
			applyStatus(this, statusFromMessage(message));
			return result;
		};
	},
});

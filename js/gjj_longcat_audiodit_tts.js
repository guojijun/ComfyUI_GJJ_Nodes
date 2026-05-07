import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_LongCatAudioDiTTTS"]);
const AUDIO_PREFIX = "speaker_";
const MAX_SPEAKERS = 10;
const MIN_VISIBLE_PAIRS = 1;  // 默认只显示 1 对输入口
const LOCAL_AUDIO_WIDGET = "local_audio_name";
const STATUS_WIDGET_NAME = "gjj_longcat_status";
const AUDIO_WIDGET_NAME = "gjj_longcat_audio";
const GENERATE_BUTTON_NAME = "gjj_generate_speech_btn";

// Boolean 控件名称
const BOOL_WIDGETS = ["normalize_reference", "keep_model_loaded"];

// ─── 只刷新当前节点 ──
function isExecutionOutputNode(node) {
	if (!node) return false;
	if (node === undefined || node === null) return false;
	if (node.comfyClass === "GJJ_LongCatAudioDiTTTS") return true;
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

function formatAudioName(index) {
	return `${AUDIO_PREFIX}${String(index).padStart(2, "0")}_audio`;
}

function formatTextName(index) {
	return `${AUDIO_PREFIX}${String(index).padStart(2, "0")}_ref_text`;
}

function getPairIndex(name) {
	const match = String(name || "").match(/^speaker_(\d+)_(audio|ref_text)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function isManagedInput(input) {
	return /^speaker_\d+_(audio|ref_text)$/.test(String(input?.name || ""));
}

function hasLink(input) {
	return Boolean(input?.link);
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjLongCatStatus) {
		return node.__gjjLongCatStatus;
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

	// 第一行：Boolean 按钮
	const boolBtnRow = document.createElement("div");
	boolBtnRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px";

	// 创建 Boolean 按钮
	const boolButtons = {};
	const boolConfigs = [
		{ name: "normalize_reference", label: " 归一化", default: true },
		{ name: "keep_model_loaded", label: " 保留模型", default: true },
	];

	boolConfigs.forEach(config => {
		const btn = document.createElement("button");
		btn.textContent = config.label;
		btn.title = config.name;
		btn.style.cssText = [
			"flex: 1",
			"background: #5aa8ff",
			"color: #fff",
			"border: none",
			"border-radius:4px",
			"padding: 4px 8px",
			"cursor: pointer",
			"font-size: 11px",
			"font-weight: bold",
			"transition: all 0.2s",
		].join(";");

		// 存储按钮状态
		btn.__boolValue = config.default;

		// 点击切换状态
		btn.addEventListener("click", () => {
			btn.__boolValue = !btn.__boolValue;
			// 统一颜色：开启=蓝色，关闭=灰色
			if (btn.__boolValue) {
				btn.style.background = "#5aa8ff";
				btn.style.color = "#fff";
			} else {
				btn.style.background = "#3a3a3a";
				btn.style.color = "#aaa";
			}

			// 保存到 node.properties（用于持久化和后端读取）
			if (!node.properties) node.properties = {};
			node.properties[config.name] = btn.__boolValue;

			// 通知 ComfyUI 节点已更改
			node.setDirtyCanvas?.(true, true);
			node.graph?.setDirtyCanvas?.(true, true);
			node.graph?.change?.();
		});

		btn.addEventListener("mouseenter", () => {
			btn.style.opacity = "0.85";
		});
		btn.addEventListener("mouseleave", () => {
			btn.style.opacity = "1";
		});

		boolBtnRow.appendChild(btn);
		boolButtons[config.name] = btn;
	});

	box.appendChild(boolBtnRow);

	// 第二行：状态栏 + 生成语音按钮
	const statusRow = document.createElement("div");
	statusRow.style.cssText = "display:flex;gap:8px;align-items:center";

	// 状态栏（文本 + 进度条）
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

	// 生成语音按钮
	const generateBtn = document.createElement("button");
	generateBtn.textContent = " 生成语音";
	generateBtn.title = "只执行当前节点，生成语音";
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
		getHeight: () => 80,
	});

	node.__gjjLongCatStatus = {
		widget, box, label, bar, generateBtn,
		boolButtons, boolBtnRow, statusRow
	};
	return node.__gjjLongCatStatus;
}

function progressFromText(text) {
	const value = String(text || "");
	if (value.includes("完成")) return 100;
	if (value.includes("保存")) return 97;
	if (value.includes("拼接")) return 92;
	if (value.includes("合成")) return 68;
	if (value.includes("解析")) return 24;
	if (value.includes("准备")) return 14;
	if (value.includes("加载")) return 6;
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

function setStatus(node, text, progress = null) {
	const status = node?.__gjjLongCatStatus;
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
	if (node.__gjjLongCatAudio) {
		return node.__gjjLongCatAudio;
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
	node.__gjjLongCatAudio = { widget, box, audio, openLink, downloadLink };
	return node.__gjjLongCatAudio;
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
	audioWidget.downloadLink.download = item.filename || "GJJ_LongCat.mp3";
	audioWidget.box.style.display = "block";
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjLongCatPatched) {
		return;
	}
	node.__gjjLongCatPatched = true;
	ensureStatusWidget(node);
	ensureAudioWidget(node);
	setStatus(node, "等待执行");

	// 彻底删除旧的 Boolean widgets（从工作流加载的旧数据）
	BOOL_WIDGETS.forEach(widgetName => {
		const widgetIndex = (node.widgets || []).findIndex(w => w.name === widgetName);
		if (widgetIndex !== -1) {
			// 从 widgets 数组中完全移除
			node.widgets.splice(widgetIndex, 1);
		}
	});

	// 初始化 Boolean 状态（使用 node.properties）
	BOOL_WIDGETS.forEach(widgetName => {
		if (!node.properties) node.properties = {};
		if (node.properties[widgetName] === undefined) {
			node.properties[widgetName] = true; // 默认开启
		}
	});

	// 同步 Boolean 按钮状态（从 properties 初始化）
	const status = node.__gjjLongCatStatus;
	if (status?.boolButtons) {
		Object.entries(status.boolButtons).forEach(([name, btn]) => {
			// 从 properties 读取值
			const value = node.properties?.[name] ?? btn.__boolValue;
			btn.__boolValue = value;
			if (btn.__boolValue) {
				btn.style.background = "#5aa8ff";
				btn.style.color = "#fff";
			} else {
				btn.style.background = "#3a3a3a";
				btn.style.color = "#aaa";
			}
		});
	}

	// 绑定生成语音按钮事件
	if (status?.generateBtn) {
		status.generateBtn.addEventListener("click", async () => {
			console.log("[GJJ] 生成语音: 只执行当前节点");
			const btn = status.generateBtn;
			const originalText = btn.textContent;

			try {
				btn.textContent = "⏳ 生成中...";
				btn.disabled = true;
				btn.style.cursor = "not-allowed";
				btn.style.opacity = "0.65";

				setStatus(node, "正在生成语音...");

				// 使用专用函数只刷新当前节点
				const ok = await queueOnlyCurrentNode(node);

				if (!ok) {
					console.warn("[GJJ] 生成语音失败：queueOnlyCurrentNode 返回 false");
					setStatus(node, "生成失败");
				}
			} catch (err) {
				console.error("[GJJ] 生成语音失败:", err);
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

function getPairs(node) {
	const map = new Map();
	for (const input of node?.inputs || []) {
		if (!isManagedInput(input)) {
			continue;
		}
		const index = getPairIndex(input.name);
		if (!map.has(index)) {
			map.set(index, { index, audio: null, text: null });
		}
		if (String(input.name).endsWith("_audio")) {
			map.get(index).audio = input;
		} else {
			map.get(index).text = input;
		}
	}
	return [...map.values()].sort((a, b) => a.index - b.index);
}

function removeInputObject(node, input) {
	const slot = node?.inputs?.indexOf(input);
	if (slot >= 0) {
		node.removeInput(slot);
	}
}

function addPair(node) {
	const count = getPairs(node).length;
	if (count >= MAX_SPEAKERS) {
		return;
	}
	const index = count + 1;
	node.addInput(formatAudioName(index), "AUDIO");
	node.addInput(formatTextName(index), "STRING");
}

function pairHasAnyLink(pair) {
	return hasLink(pair?.audio) || hasLink(pair?.text);
}

function removeUnusedGapPairs(node) {
	const pairs = getPairs(node);
	for (let index = pairs.length - 1; index >= 0; index -= 1) {
		const pair = pairs[index];
		const hasLaterLinkedPair = pairs.slice(index + 1).some((candidate) => pairHasAnyLink(candidate));
		if (!hasLaterLinkedPair || pairHasAnyLink(pair) || pairs.length <= MIN_VISIBLE_PAIRS) {
			continue;
		}
		removeInputObject(node, pair.text);
		removeInputObject(node, pair.audio);
	}
}

function trimTrailingUnusedPairs(node) {
	const pairs = getPairs(node);
	for (let index = pairs.length - 1; index >= MIN_VISIBLE_PAIRS; index -= 1) {
		const pair = pairs[index];
		if (pairHasAnyLink(pair)) {
			break;
		}
		removeInputObject(node, pair.text);
		removeInputObject(node, pair.audio);
	}
}

function ensureTrailingEmptyPair(node) {
	let pairs = getPairs(node);
	while (pairs.length < MIN_VISIBLE_PAIRS) {
		addPair(node);
		pairs = getPairs(node);
		if (pairs.length >= MAX_SPEAKERS) {
			break;
		}
	}
	if (!pairs.length) {
		return;
	}
	const last = pairs[pairs.length - 1];
	if (pairHasAnyLink(last)) {
		addPair(node);
	}
	pairs = getPairs(node);
	if (pairs.length > MAX_SPEAKERS) {
		for (let index = pairs.length - 1; index >= MAX_SPEAKERS; index -= 1) {
			removeInputObject(node, pairs[index].text);
			removeInputObject(node, pairs[index].audio);
		}
	}
}

function renamePairsSequentially(node) {
	const pairs = getPairs(node);
	for (const [zeroIndex, pair] of pairs.entries()) {
		const index = zeroIndex + 1;
		if (pair.audio) {
			pair.audio.name = formatAudioName(index);
			pair.audio.label = `参考音频${index}`;
			pair.audio.localized_name = pair.audio.label;
			pair.audio.type = "AUDIO";
			pair.audio.tooltip = `第 ${index} 个说话人的参考音频。连接当前最后一路后会自动扩展下一组输入。`;
		}
		if (pair.text) {
			pair.text.name = formatTextName(index);
			pair.text.label = `参考文本${index}`;
			pair.text.localized_name = pair.text.label;
			pair.text.type = "STRING";
			pair.text.tooltip = `第 ${index} 个说话人参考音频对应的文字，可留空。`;
		}
	}
}

function hasConnectedAudio(node) {
	return getPairs(node).some((pair) => hasLink(pair.audio));
}

function findLocalAudioWidget(node) {
	return (node?.widgets || []).find((widget) => widget?.name === LOCAL_AUDIO_WIDGET);
}

function firstNonEmptyOption(widget) {
	const values = widget?.options?.values || widget?.options?.values_list || [];
	if (!Array.isArray(values)) {
		return "";
	}
	return values.find((item) => String(item || "").trim()) || "";
}

function syncLocalAudioWidget(node) {
	const widget = findLocalAudioWidget(node);
	if (!widget) {
		return;
	}
	const connected = hasConnectedAudio(node);
	widget.disabled = connected;
	if (widget.inputEl) {
		widget.inputEl.disabled = connected;
	}
	if (connected) {
		widget.value = "";
		return;
	}
	if (!String(widget.value || "").trim()) {
		const fallback = firstNonEmptyOption(widget);
		if (fallback) {
			widget.value = fallback;
		}
	}
}

function getLinkSignature(node) {
	return getPairs(node)
		.map((pair) => `${pair.audio?.name || ""}:${pair.audio?.link || 0}|${pair.text?.name || ""}:${pair.text?.link || 0}`)
		.join(";");
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	removeUnusedGapPairs(node);
	trimTrailingUnusedPairs(node);
	ensureTrailingEmptyPair(node);
	renamePairsSequentially(node);
	syncLocalAudioWidget(node);
	node.__gjjLongCatLinkSignature = getLinkSignature(node);
	refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjLongCatStabilizeTimer);
	node.__gjjLongCatStabilizeTimer = setTimeout(() => stabilizeNode(node), ms);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	patchNode(targetNode);
	setStatus(targetNode, detail.text || "处理中...", detail.progress);
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
	name: "Comfy.GJJ.LongCatAudioDiTTTS",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalOnDrawBackground?.apply(this, args);
			const signature = getLinkSignature(this);
			if (signature !== this.__gjjLongCatLinkSignature) {
				scheduleStabilize(this, 16);
			}
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

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				patchNode(node);
				stabilizeNode(node);
			}
		}
	},
});

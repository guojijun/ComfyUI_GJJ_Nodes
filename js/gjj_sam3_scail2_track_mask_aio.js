import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { requestPromptTranslation } from "./gjj_common_prompt_translation.js";

const NODE_TYPE = "GJJ_SAM3SCAIL2TrackMaskAIO";
const NODE_DISPLAY_NAME = "GJJ · SAM3跟踪彩色遮罩一体机";
const TARGET_WIDGET = "text_prompt";
const CHANNEL_VALUE_PATTERN = /^\s*((?:通道|频道|channel|ch|route|路)?\s*\[?\s*[0-9]+(?:\s*[,，/|]\s*[0-9]+)*\s*\]?\s*[:：=＝]\s*)(.*?)\s*$/i;

function hasChinese(text) {
	return /[\u3400-\u9fff]/.test(String(text || ""));
}

function getWidget(node, name) {
	return Array.isArray(node?.widgets) ? node.widgets.find((widget) => String(widget?.name || "") === name) : null;
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = value;
	if (Array.isArray(node.widgets_values)) {
		const index = node.widgets?.indexOf(widget);
		if (index >= 0) node.widgets_values[index] = value;
	}
	try { widget.callback?.(value); } catch (_) {}
	GJJ_Utils.refreshNode(node);
}

function splitChannelSegments(text) {
	return String(text || "")
		.split(/([\n;；]+)/)
		.reduce((segments, part, index, parts) => {
			if (index % 2 === 0) {
				segments.push({ text: part, separator: parts[index + 1] || "" });
			}
			return segments;
		}, []);
}

async function translateSegmentValue(node, value, cache) {
	const raw = String(value || "");
	const trimmed = raw.trim();
	if (!trimmed || !hasChinese(trimmed)) return raw;
	if (!cache.has(trimmed)) {
		const data = await requestPromptTranslation({
			node,
			text: trimmed,
			device: "auto",
			maxLength: 512,
			batchSize: 8,
			unloadAfterUse: false,
			nodeName: NODE_DISPLAY_NAME,
		});
		cache.set(trimmed, String(data.text ?? data.positive ?? "").trim() || trimmed);
	}
	return raw.replace(trimmed, cache.get(trimmed));
}

async function translateTargetPrompt(node) {
	if (node.__gjjSam31Scail2Translating) return;
	const widget = getWidget(node, TARGET_WIDGET);
	const source = String(widget?.value || "").trim();
	if (!source || !hasChinese(source)) return;

	const requestId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
	node.__gjjSam31Scail2TranslateRequest = requestId;
	node.__gjjSam31Scail2Translating = true;
	try {
		const cache = new Map();
		const translatedParts = [];
		for (const segment of splitChannelSegments(source)) {
			if (!segment.text) {
				translatedParts.push(segment.separator);
				continue;
			}
			const match = CHANNEL_VALUE_PATTERN.exec(segment.text);
			if (match) {
				const translatedValue = await translateSegmentValue(node, match[2], cache);
				translatedParts.push(`${match[1]}${translatedValue}${segment.separator}`);
			} else {
				const translatedValue = await translateSegmentValue(node, segment.text, cache);
				translatedParts.push(`${translatedValue}${segment.separator}`);
			}
		}
		const translated = translatedParts.join("").trim();
		const current = String(getWidget(node, TARGET_WIDGET)?.value || "").trim();
		if (node.__gjjSam31Scail2TranslateRequest === requestId && current === source && translated && translated !== source) {
			setWidgetValue(node, TARGET_WIDGET, translated);
		}
	} catch (error) {
		console.warn("[GJJ SAM3 Mask] 跟踪目标前端翻译失败，执行时会由后端兜底翻译。", error);
	} finally {
		node.__gjjSam31Scail2Translating = false;
	}
}

function schedulePromptTranslation(node, ms = 700) {
	clearTimeout(node.__gjjSam31Scail2PromptTranslateTimer);
	node.__gjjSam31Scail2PromptTranslateTimer = setTimeout(() => translateTargetPrompt(node), ms);
}

function patchPromptWidget(node) {
	const widget = getWidget(node, TARGET_WIDGET);
	if (!widget || widget.__gjjSam31Scail2PromptPatched) return;
	widget.__gjjSam31Scail2PromptPatched = true;
	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		const result = originalCallback?.apply(this, args);
		schedulePromptTranslation(node);
		return result;
	};
	schedulePromptTranslation(node, 80);
}

app.registerExtension({
	name: "GJJ.SAM3SCAIL2TrackMaskAIO",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) {
			return;
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = onNodeCreated?.apply(this, args);
			setTimeout(() => patchPromptWidget(this), 0);
			return result;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = onConfigure?.apply(this, args);
			setTimeout(() => patchPromptWidget(this), 0);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE) {
				patchPromptWidget(node);
			}
		}
	},
});

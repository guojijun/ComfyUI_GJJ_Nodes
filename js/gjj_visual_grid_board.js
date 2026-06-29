import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { queueCurrentNodeWithFreshAncestors, queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET = "GJJ_VisualGridBoard";
const PANEL_WIDGET = "gjj_visual_grid_board_panel";
const PROP_REFERENCE_LINK = "gjj_visual_grid_board_reference_link";
const HIDDEN_WIDGETS = new Set([
	"grid_state",
	"local_image_data",
	"total_width",
	"total_height",
	"layout_mode",
	"line_px",
	"cell_fit",
	"selected_cell",
	"generation_mode",
	"generation_scope",
	"negative_prompt",
	"unet_name",
	"clip_name",
	"vae_name",
	"steps",
	"cfg",
	"seed",
	"keep_models_loaded",
]);

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name || item?.options?.name === name) || null;
}

function setWidget(node, name, value) {
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	if (w.inputEl) w.inputEl.value = value;
	if (w.element && "value" in w.element) w.element.value = value;
	try { w.callback?.(value); } catch (_) {}
}

function getWidget(node, name, fallback = "") {
	const value = widget(node, name)?.value;
	return value === undefined || value === null || value === "" ? fallback : value;
}

function collapseWidget(w) {
	if (!w || w.__gjjVisualGridHidden) return;
	w.hidden = true;
	w.type = "hidden";
	w.computeSize = () => [0, -4];
	if (w.options && typeof w.options === "object") {
		w.options.hidden = true;
		w.options.display = "hidden";
	}
	w.__gjjVisualGridHidden = true;
}

function refresh(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function panelContentHeight(root) {
	return Math.max(36, Math.ceil(root?.scrollHeight || root?.offsetHeight || root?.getBoundingClientRect?.().height || 36));
}

function schedulePanelHeight(node, delay = 30) {
	if (!node?.__gjjVisualGridPanel?.root) return;
	clearTimeout(node.__gjjVisualGridHeightTimer);
	node.__gjjVisualGridHeightTimer = setTimeout(() => {
		try {
			const width = Math.max(360, Number(node.size?.[0] || 360));
			const computed = node.computeSize?.() || node.size || [width, panelContentHeight(node.__gjjVisualGridPanel.root)];
			const height = Math.max(36, Number(computed?.[1] || panelContentHeight(node.__gjjVisualGridPanel.root)));
			if (!Array.isArray(node.size) || Math.abs(Number(node.size[1] || 0) - height) > 2) {
				node.setSize?.([width, height]);
			}
			refresh(node);
		} catch (error) {
			console.warn("[GJJ] 可视化宫格高度更新失败:", error);
		}
	}, delay);
}

function rememberActiveNode(node) {
	window.__gjjVisualGridActiveNode = node;
}

function isTextEditingElement(element) {
	const tag = String(element?.tagName || "").toLowerCase();
	return tag === "input" || tag === "textarea" || tag === "select" || Boolean(element?.isContentEditable);
}

function clearFinalPreview(node, options = {}) {
	const clearCellCache = Boolean(options.clearCellCache);
	if (node.__gjjVisualGridPanel) {
		node.__gjjVisualGridPanel.finalImageBase64 = "";
		node.__gjjVisualGridPanel.finalImageRef = null;
		node.__gjjVisualGridPanel.finalImageLayout = null;
		node.__gjjVisualGridPanel.cellCount = null;
		if (clearCellCache) node.__gjjVisualGridPanel.generatedCellRefs = [];
	}
	const state = readState(node);
	if (state && typeof state === "object") {
		delete state.generatedImageRef;
		delete state.generatedImageLayout;
		delete state.cellCount;
		if (clearCellCache) {
			delete state.generatedCellRefs;
			delete state.generatedCellIndexes;
		}
		delete state.regenerateCellIndexes;
		setWidget(node, "grid_state", JSON.stringify(state));
	}
}

function stateFlag(node, name, fallback = false) {
	const state = readState(node);
	return Boolean(state?.[name] ?? fallback);
}

function setStateFlag(node, name, value) {
	const state = readState(node);
	state[name] = Boolean(value);
	setWidget(node, "grid_state", JSON.stringify(state));
	updateToggleButtons(node);
}

function randomSeedValue() {
	const bytes = new Uint32Array(2);
	if (globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		bytes[0] = Math.floor(Math.random() * 0xffffffff);
		bytes[1] = Math.floor(Math.random() * 0xfffff);
	}
	return Number((BigInt(bytes[0]) << 20n) | BigInt(bytes[1] & 0xfffff));
}

function randomizeSeedIfEnabled(node) {
	if (!stateFlag(node, "randomizeSeedOnRun", false)) return;
	setWidget(node, "seed", randomSeedValue());
}

function tempImageUrl(ref, includeRand = true) {
	if (!ref || typeof ref !== "object" || !ref.filename) return "";
	const type = ref.type || "temp";
	const subfolder = ref.subfolder || "";
	const rand = includeRand ? `&rand=${Date.now()}` : "";
	return `/api/view?filename=${encodeURIComponent(ref.filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}${rand}`;
}

function firstMessageValue(...values) {
	for (const value of values) {
		if (Array.isArray(value) && value.length > 0) return value[0];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

function firstMessageObject(...values) {
	for (const value of values) {
		if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === "object") return value[0];
		if (value && typeof value === "object" && !Array.isArray(value)) return value;
	}
	return null;
}

function firstMessageNumber(...values) {
	for (const value of values) {
		const raw = Array.isArray(value) && value.length > 0 ? value[0] : value;
		const number = Number(raw);
		if (Number.isFinite(number) && number > 0) return number;
	}
	return 0;
}

function localImageRef(node) {
	const raw = String(getWidget(node, "local_image_data", "") || "").trim();
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed?.filename ? parsed : null;
	} catch (_) {
		return null;
	}
}

function hasLocalImage(node) {
	const raw = String(getWidget(node, "local_image_data", "") || "").trim();
	return Boolean(raw);
}

function hasCellImageRefs(node) {
	const refs = readState(node).cellImageRefs;
	return Array.isArray(refs) && refs.some((item) => item?.filename);
}

function smartGenerationMode(node) {
	return hasReferenceLink(node) || hasLocalImage(node) || hasCellImageRefs(node) ? "图生图" : "文生图";
}

async function uploadLocalImage(file) {
	const form = new FormData();
	form.append("image", file, file.name || "visual_grid_board.png");
	const response = await api.fetchApi("/gjj/visual_grid_board/upload_image", { method: "POST", body: form });
	const data = await response.json().catch(() => ({}));
	if (!response.ok || !data?.ok || !data?.image?.filename) {
		throw new Error(data?.error || `上传失败：HTTP ${response.status}`);
	}
	return data.image;
}

function parsePromptParts(text) {
	const raw = String(text || "").trim();
	if (!raw) return [];
	let reference = raw.split(/###\s*Target\s+Description\b/i)[0] || raw;
	reference = reference.replace(/^\s*###\s*Reference\s+Sheet\s+Description\s*/i, "").trim();
	const keywordParts = parseKeywordPromptParts(reference);
	if (keywordParts.length >= 2) return keywordParts;
	const matches = [...reference.matchAll(/\*\*([^*\n：:]{2,96})\s*[:：]\*\*/g)];
	if (matches.length >= 2) {
		const parts = [];
		for (let index = 0; index < matches.length; index += 1) {
			const start = matches[index].index + matches[index][0].length;
			const end = index + 1 < matches.length ? matches[index + 1].index : reference.length;
			const label = String(matches[index][1] || "").trim();
			const body = reference.slice(start, end).trim();
			if (body) parts.push({ label, body });
		}
		if (parts.length) return parts;
	}
	return raw.split(/(?:^\s*---+\s*$)|(?:\n\s*\n+)/m)
		.map((item, index) => ({ label: `宫格 ${index + 1}`, body: item.trim() }))
		.filter((item) => item.body);
}

function normalizeGridLabel(label) {
	return String(label || "")
		.trim()
		.toLowerCase()
		.replace(/[*_`~#\[\]（）()【】「」『』：:，,。.、\-\s]+/g, "");
}

function gridLabelKeyword(label) {
	const normalized = normalizeGridLabel(label);
	if (!normalized) return "";
	const keywords = [
		"topleft", "topmiddle", "topcenter", "topright", "middlerow", "middleleft", "middlecenter", "middleright",
		"bottomleft", "bottommiddle", "bottomcenter", "bottomright", "frontrow", "backrow", "toprow", "bottomrow",
		"top", "middle", "center", "bottom", "front", "back",
		"左上", "上左", "中上", "上中", "右上", "上右",
		"左中", "中左", "正中", "中心", "中间", "右中", "中右",
		"左下", "下左", "中下", "下中", "右下", "下右",
		"顶部", "顶", "中部", "中", "底部", "底", "前排", "后排",
	];
	return keywords.find((keyword) => normalized.startsWith(keyword)) || "";
}

function gridLabelRow(label) {
	const keyword = gridLabelKeyword(label);
	if ([
		"topleft", "topmiddle", "topcenter", "topright", "toprow", "top", "frontrow", "front",
		"左上", "上左", "中上", "上中", "右上", "上右", "顶部", "顶", "前排",
	].includes(keyword)) return 0;
	if ([
		"middleleft", "middlecenter", "middleright", "middlerow", "middle", "center",
		"左中", "中左", "正中", "中心", "中间", "右中", "中右", "中部", "中",
	].includes(keyword)) return 1;
	if ([
		"bottomleft", "bottommiddle", "bottomcenter", "bottomright", "bottomrow", "bottom", "backrow", "back",
		"左下", "下左", "中下", "下中", "右下", "下右", "底部", "底", "后排",
	].includes(keyword)) return 2;
	return null;
}

function keywordRowCounts(parts) {
	const rows = [];
	let currentRow = null;
	for (const part of parts || []) {
		const row = gridLabelRow(part?.label || "");
		if (row === null) return [];
		if (currentRow === null || row !== currentRow) {
			rows.push(1);
			currentRow = row;
		} else {
			rows[rows.length - 1] += 1;
		}
	}
	return rows;
}

function keywordLabelLine(line) {
	const trimmed = String(line || "").trim();
	if (!trimmed.startsWith("**")) return null;
	const source = trimmed.slice(2).trim();
	if (!source) return null;
	const delimiters = [source.indexOf("："), source.indexOf(":"), source.indexOf("**")]
		.filter((index) => index >= 0);
	const delimiter = delimiters.length ? Math.min(...delimiters) : -1;
	let label = (delimiter >= 0 ? source.slice(0, delimiter) : source).trim();
	if (!gridLabelKeyword(label)) return null;
	let body = "";
	if (delimiter >= 0) {
		body = source.slice(delimiter + (source.slice(delimiter, delimiter + 2) === "**" ? 2 : 1)).trim();
		body = body.replace(/^[:：]\s*/, "").replace(/^\*\*\s*/, "").trim();
	}
	if (!body && delimiter < 0) {
		const keyword = gridLabelKeyword(label);
		if (keyword && normalizeGridLabel(label) !== keyword) label = label.slice(0, keyword.length).trim() || label;
	}
	return { label: label.replace(/\*+$/g, "").trim(), body };
}

function parseKeywordPromptParts(reference) {
	const lines = String(reference || "").split(/\r?\n/);
	const parts = [];
	let current = null;
	let sawMarker = false;
	for (const line of lines) {
		const marker = keywordLabelLine(line);
		if (marker) {
			sawMarker = true;
			if (current) {
				parts.push({ label: current.label, body: current.bodyLines.join("\n").trim() });
			}
			current = { label: marker.label, bodyLines: [] };
			if (marker.body) current.bodyLines.push(marker.body);
		} else if (current) {
			current.bodyLines.push(line);
		}
	}
	if (current && current.bodyLines.join("\n").trim()) {
		parts.push({ label: current.label, body: current.bodyLines.join("\n").trim() });
	}
	if (sawMarker && current && !parts.includes(current)) {
		const last = parts[parts.length - 1];
		if (!last || last.label !== current.label) parts.push({ label: current.label, body: current.bodyLines.join("\n").trim() });
	}
	return parts;
}

function serializePromptParts(parts) {
	return parts
		.map((part, index) => {
			const label = String(part?.label || `宫格 ${index + 1}`).trim() || `宫格 ${index + 1}`;
			const body = String(part?.body || "").trim();
			return `**${label}：** ${body}`;
		})
		.join("\n");
}

function updatePromptPart(node, index, body) {
	const current = parsePromptParts(getWidget(node, "visual_script", ""));
	const count = Math.max(index + 1, current.length, 1);
	const next = [];
	for (let i = 0; i < count; i += 1) {
		next.push(current[i] || { label: `宫格 ${i + 1}`, body: "" });
	}
	next[index] = {
		...next[index],
		body: String(body || "").trim(),
	};
	setWidget(node, "visual_script", serializePromptParts(next));
	writeState(node);
	drawPreview(node);
	refresh(node);
}

function selectedCellIndex(node) {
	return Math.max(0, Math.min(255, Math.round(Number(getWidget(node, "selected_cell", 1)) || 1) - 1));
}

function setSelectedCellImageRef(node, imageRef) {
	const state = readState(node);
	const index = selectedCellIndex(node);
	const refs = Array.isArray(state.cellImageRefs) ? state.cellImageRefs.slice() : [];
	while (refs.length <= index) refs.push(null);
	refs[index] = imageRef;
	state.cellImageRefs = refs;
	const generatedRefs = Array.isArray(state.generatedCellRefs) ? state.generatedCellRefs.slice() : [];
	while (generatedRefs.length <= index) generatedRefs.push(null);
	generatedRefs[index] = imageRef;
	state.generatedCellRefs = generatedRefs;
	const transforms = Array.isArray(state.cellTransforms) ? state.cellTransforms.slice() : [];
	while (transforms.length <= index) transforms.push(null);
	transforms[index] = { scale: 1, offsetX: 0, offsetY: 0 };
	state.cellTransforms = transforms;
	setWidget(node, "local_image_data", "");
	setWidget(node, "grid_state", JSON.stringify(state));
	if (node.__gjjVisualGridPanel) {
		node.__gjjVisualGridPanel.generatedCellRefs = generatedRefs;
	}
}

function selectedCellTransform(node) {
	const state = readState(node);
	const index = selectedCellIndex(node);
	const current = Array.isArray(state.cellTransforms) ? state.cellTransforms[index] : null;
	return {
		scale: Math.max(0.1, Math.min(8, Number(current?.scale) || 1)),
		offsetX: Math.max(-4, Math.min(4, Number(current?.offsetX) || 0)),
		offsetY: Math.max(-4, Math.min(4, Number(current?.offsetY) || 0)),
	};
}

function setSelectedCellTransform(node, transform) {
	const state = readState(node);
	const index = selectedCellIndex(node);
	const transforms = Array.isArray(state.cellTransforms) ? state.cellTransforms.slice() : [];
	while (transforms.length <= index) transforms.push(null);
	transforms[index] = {
		scale: Math.max(0.1, Math.min(8, Number(transform?.scale) || 1)),
		offsetX: Math.max(-4, Math.min(4, Number(transform?.offsetX) || 0)),
		offsetY: Math.max(-4, Math.min(4, Number(transform?.offsetY) || 0)),
	};
	state.cellTransforms = transforms;
	setWidget(node, "grid_state", JSON.stringify(state));
}

function selectedCellHasImage(node) {
	const state = readState(node);
	const index = selectedCellIndex(node);
	return Boolean(
		(Array.isArray(state.cellImageRefs) && state.cellImageRefs[index]?.filename)
		|| (Array.isArray(state.generatedCellRefs) && state.generatedCellRefs[index]?.filename)
		|| node.__gjjVisualGridPanel?.finalImageBase64
	);
}

function scheduleCellRecompose(node, delay = 420) {
	clearTimeout(node.__gjjVisualGridCellRecomposeTimer);
	node.__gjjVisualGridCellRecomposeTimer = setTimeout(() => {
		recomposeGeneratedCells(node);
	}, delay);
}

function setPendingGeneratedCellIndexes(node, indexes) {
	const state = readState(node);
	state.pendingGeneratedCellIndexes = [...new Set((indexes || [])
		.map((item) => Number(item))
		.filter((item) => Number.isInteger(item) && item >= 0 && item < 256))];
	setWidget(node, "grid_state", JSON.stringify(state));
}

function currentCellCount(node) {
	return Math.max(
		1,
		Number(node.__gjjVisualGridPanel?.cellCount || 0) || 0,
		(node.__gjjVisualGridRects || []).length,
		parsePromptParts(getWidget(node, "visual_script", "")).length,
	);
}

function wrapCanvasText(ctx, text, maxWidth, maxLines) {
	const paragraphs = String(text || "").split(/\r?\n/);
	const lines = [];
	for (const paragraph of paragraphs) {
		const source = paragraph.trim();
		if (!source) {
			if (lines.length && lines.length < maxLines) lines.push("");
			continue;
		}
		let current = "";
		for (const char of source) {
			const next = current + char;
			if (current && ctx.measureText(next).width > maxWidth) {
				lines.push(current);
				current = char;
				if (lines.length >= maxLines) break;
			} else {
				current = next;
			}
		}
		if (lines.length >= maxLines) break;
		if (current) lines.push(current);
		if (lines.length >= maxLines) break;
	}
	if (lines.length === maxLines) {
		const last = lines[lines.length - 1] || "";
		if (ctx.measureText(`${last}...`).width <= maxWidth) lines[lines.length - 1] = `${last}...`;
	}
	return lines;
}

function editCellPrompt(node, cellIndex) {
	const parts = parsePromptParts(getWidget(node, "visual_script", ""));
	const part = parts[cellIndex] || { label: `宫格 ${cellIndex + 1}`, body: "" };
	const panel = node.__gjjVisualGridPanel;
	if (!panel?.root) return;
	panel.editorOverlay?.remove?.();

	const overlay = document.createElement("div");
	overlay.style.cssText = [
		"position:fixed",
		"inset:0",
		"z-index:9999",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"background:rgba(0,0,0,0.36)",
	].join(";");
	const box = document.createElement("div");
	box.style.cssText = [
		"width:min(560px,calc(100vw - 36px))",
		"background:#0c1215",
		"border:1px solid #34444b",
		"border-radius:8px",
		"box-shadow:0 18px 48px rgba(0,0,0,0.42)",
		"padding:10px",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
	].join(";");
	const title = document.createElement("div");
	title.textContent = part.label || `宫格 ${cellIndex + 1}`;
	title.style.cssText = "color:#e8f1ed;font-size:13px;font-weight:600;";
	const textarea = document.createElement("textarea");
	textarea.value = String(part.body || "");
	textarea.rows = 8;
	textarea.style.cssText = [
		"width:100%",
		"box-sizing:border-box",
		"resize:vertical",
		"min-height:140px",
		"max-height:420px",
		"background:#111a1f",
		"color:#e8f1ed",
		"border:1px solid #34444b",
		"border-radius:6px",
		"padding:8px",
		"font:13px/1.35 sans-serif",
		"outline:none",
	].join(";");
	const actions = document.createElement("div");
	actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
	const cancel = button("取消", "取消修改", () => overlay.remove());
	cancel.style.width = "56px";
	const save = button("确定", "保存文字", () => {
		updatePromptPart(node, cellIndex, textarea.value);
		overlay.remove();
	});
	save.style.width = "56px";
	actions.append(cancel, save);
	box.append(title, textarea, actions);
	overlay.appendChild(box);
	overlay.addEventListener("pointerdown", (event) => {
		event.stopPropagation();
		if (event.target === overlay) overlay.remove();
	});
	overlay.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Escape") overlay.remove();
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
			updatePromptPart(node, cellIndex, textarea.value);
			overlay.remove();
		}
	});
	document.body.appendChild(overlay);
	panel.editorOverlay = overlay;
	setTimeout(() => textarea.focus(), 0);
}

function layoutFor(count, width, height, mode) {
	const text = String(mode || "自动");
	const match = text.match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
	if (match) return [Math.max(1, Number(match[1])), Math.max(1, Number(match[2]))];
	const colMatch = text.match(/^(\d+)列$/);
	if (colMatch) {
		const cols = Math.max(1, Number(colMatch[1]));
		return [cols, Math.ceil(Math.max(1, count) / cols)];
	}
	let best = [Math.max(1, count), 1];
	let bestScore = Infinity;
	const target = Math.max(1, width) / Math.max(1, height);
	for (let cols = 1; cols <= Math.max(1, count); cols += 1) {
		const rows = Math.ceil(Math.max(1, count) / cols);
		const score = Math.abs(Math.log(Math.max(0.01, (cols / rows) / target))) + (cols * rows - count) * 0.08;
		if (score < bestScore) {
			best = [cols, rows];
			bestScore = score;
		}
	}
	return best;
}

function defaultRowCounts(count, parts = null) {
	const total = Math.max(1, Number(count) || 1);
	const keywordRows = keywordRowCounts(parts);
	if (keywordRows.length && keywordRows.reduce((sum, value) => sum + value, 0) === total) return keywordRows;
	if (total <= 3) return [total];
	if (total <= 5) {
		const first = Math.ceil(total / 2);
		return [first, total - first];
	}
	if (total === 6) return [3, 3];
	if (total === 7) return [3, 2, 2];
	const first = Math.ceil(total / 3);
	const second = Math.ceil((total - first) / 2);
	const third = total - first - second;
	return [first, second, third].filter((value) => value > 0);
}

function parseRowCounts(value, count) {
	let rows = [];
	if (Array.isArray(value)) {
		rows = value.map((item) => Math.max(1, Math.round(Number(item) || 1)));
	} else {
		rows = String(value || "").split(/[,，/|;\s]+/).map((item) => Math.max(1, Math.round(Number(item) || 0))).filter(Boolean);
	}
	if (!rows.length) rows = defaultRowCounts(count);
	let total = rows.reduce((sum, item) => sum + item, 0);
	if (total < count) rows[rows.length - 1] += count - total;
	while (rows.length > 1 && total - rows[rows.length - 1] >= count) {
		rows.pop();
		total = rows.reduce((sum, item) => sum + item, 0);
	}
	total = rows.reduce((sum, item) => sum + item, 0);
	if (total > count) rows[rows.length - 1] = Math.max(1, count - rows.slice(0, -1).reduce((sum, item) => sum + item, 0));
	return rows.filter((item) => item > 0);
}

function normalizeWeights(values, expected) {
	let weights = Array.isArray(values) ? values.slice(0, expected).map((item) => Math.max(0.05, Number(item) || 1)) : [];
	while (weights.length < expected) weights.push(1);
	const total = weights.reduce((sum, item) => sum + item, 0) || 1;
	return weights.map((item) => item / total);
}

function currentVariableLayout(node, count, stateOverride = null) {
	const state = stateOverride || readState(node);
	const layout = state.variableLayout && typeof state.variableLayout === "object" ? state.variableLayout : {};
	const rows = parseRowCounts(state.rowTemplate || layout.rows, count);
	const rowHeights = normalizeWeights(layout.rowHeights || state.rowHeights, rows.length);
	const rowWeights = rows.map((cols, index) => normalizeWeights(Array.isArray(layout.rowWeights) ? layout.rowWeights[index] : null, cols));
	return { rows, rowHeights, rowWeights };
}

function layoutRects(node, count, width, height, stateOverride = null) {
	const line = Math.max(0, Number(stateOverride?.linePx ?? getWidget(node, "line_px", 2)) || 2);
	const { rows, rowHeights, rowWeights } = currentVariableLayout(node, count, stateOverride);
	const innerH = Math.max(1, height - line * (rows.length + 1));
	const rects = [];
	const displayRows = [];
	let y = line;
	let remaining = count;
	for (let rowIndex = 0; rowIndex < rows.length && remaining > 0; rowIndex += 1) {
		const cols = Math.max(1, Math.min(rows[rowIndex], remaining));
		let rowH = Math.max(8, Math.round(innerH * rowHeights[rowIndex]));
		if (rowIndex === rows.length - 1) rowH = Math.max(8, height - line - y);
		const innerW = Math.max(1, width - line * (cols + 1));
		const weights = normalizeWeights(rowWeights[rowIndex], cols);
		const rowRects = [];
		let x = line;
		for (let colIndex = 0; colIndex < cols; colIndex += 1) {
			let cellW = Math.max(8, Math.round(innerW * weights[colIndex]));
			if (colIndex === cols - 1) cellW = Math.max(8, width - line - x);
			const rect = { left: x, top: y, right: x + cellW, bottom: y + rowH, row: rowIndex, col: colIndex, index: rects.length };
			rects.push(rect);
			rowRects.push(rect);
			x += cellW + line;
		}
		displayRows.push(rowRects);
		y += rowH + line;
		remaining -= cols;
	}
	return { rects, rows: displayRows, layout: { rows, rowHeights, rowWeights } };
}

function setVariableLayout(node, layout) {
	const state = readState(node);
	state.variableLayout = {
		rows: layout.rows,
		rowHeights: layout.rowHeights,
		rowWeights: layout.rowWeights,
	};
	state.rowTemplate = layout.rows.join(",");
	state.manualLayout = true;
	if (node.__gjjVisualGridPanel?.finalImageBase64) {
		node.__gjjVisualGridPanel.finalImageLayout = {
			linePx: Number(getWidget(node, "line_px", 2)) || 2,
			variableLayout: state.variableLayout,
			rowTemplate: state.rowTemplate,
			manualLayout: true,
		};
		state.generatedImageLayout = node.__gjjVisualGridPanel.finalImageLayout;
	}
	setWidget(node, "grid_state", JSON.stringify(state));
}

function serializeWeights(rows) {
	return rows.map((items) => items.map((value) => Number(value.toFixed(3))).join(",")).join(" / ");
}

function parseWeightRows(text, rows) {
	const rawRows = String(text || "").split(/[\/|]/).map((row) => row.trim()).filter(Boolean);
	return rows.map((cols, index) => {
		const raw = rawRows[index] || "";
		const values = raw.split(/[,，;\s]+/).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
		return normalizeWeights(values, cols);
	});
}

function addManualLayoutControls(node, settings) {
	const count = Math.max(1, parsePromptParts(getWidget(node, "visual_script", "")).length);
	const layout = currentVariableLayout(node, count);
	const rowTemplate = document.createElement("input");
	rowTemplate.value = layout.rows.join(",");
	rowTemplate.style.cssText = "min-width:0;background:#0f171b;color:#e8f1ed;border:1px solid #34444b;border-radius:6px;padding:4px 6px;";
	rowTemplate.title = "例如 3,2,2 表示三行；3,3 表示两行。";
	let rowTemplateTimer = null;
	const applyRowTemplate = async (shouldRecompose = false) => {
		const rows = parseRowCounts(rowTemplate.value, count);
		const next = {
			rows,
			rowHeights: normalizeWeights(null, rows.length),
			rowWeights: rows.map((cols) => normalizeWeights(null, cols)),
		};
		setVariableLayout(node, next);
		drawPreview(node);
		refresh(node);
		if (shouldRecompose) await recomposeGeneratedCells(node);
	};
	rowTemplate.addEventListener("input", () => {
		clearTimeout(rowTemplateTimer);
		applyRowTemplate(false);
		rowTemplateTimer = setTimeout(() => applyRowTemplate(true), 650);
	});
	rowTemplate.addEventListener("change", async () => {
		clearTimeout(rowTemplateTimer);
		await applyRowTemplate(true);
	});
	rowTemplate.addEventListener("keydown", async (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		event.stopPropagation();
		clearTimeout(rowTemplateTimer);
		await applyRowTemplate(true);
	});
	settings.appendChild(field("行结构", rowTemplate));

	const rowHeights = document.createElement("input");
	rowHeights.value = layout.rowHeights.map((value) => Number(value.toFixed(3))).join(",");
	rowHeights.style.cssText = rowTemplate.style.cssText;
	rowHeights.title = "每行高度比例，例如 1,0.8,1.2。";
	rowHeights.addEventListener("change", async () => {
		const current = currentVariableLayout(node, count);
		const values = rowHeights.value.split(/[,，;\s]+/).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
		current.rowHeights = normalizeWeights(values, current.rows.length);
		setVariableLayout(node, current);
		await recomposeGeneratedCells(node);
	});
	settings.appendChild(field("行高", rowHeights));

	const rowWeights = document.createElement("input");
	rowWeights.value = serializeWeights(layout.rowWeights);
	rowWeights.style.cssText = rowTemplate.style.cssText;
	rowWeights.title = "每行列宽比例，行之间用 / 分隔。例如 1,1.2,1.5 / 1,1.4 / 1,1。";
	rowWeights.addEventListener("change", async () => {
		const current = currentVariableLayout(node, count);
		current.rowWeights = parseWeightRows(rowWeights.value, current.rows);
		setVariableLayout(node, current);
		await recomposeGeneratedCells(node);
	});
	settings.appendChild(field("列宽", rowWeights));

	const reset = button("↺", "按当前脚本数量重置为默认行结构", async () => {
		const rows = defaultRowCounts(Math.max(1, parsePromptParts(getWidget(node, "visual_script", "")).length));
		const next = {
			rows,
			rowHeights: normalizeWeights(null, rows.length),
			rowWeights: rows.map((cols) => normalizeWeights(null, cols)),
		};
		rowTemplate.value = rows.join(",");
		rowHeights.value = next.rowHeights.map((value) => Number(value.toFixed(3))).join(",");
		rowWeights.value = serializeWeights(next.rowWeights);
		setVariableLayout(node, next);
		await recomposeGeneratedCells(node);
	});
	settings.appendChild(field("重置", reset));
}

function drawPreview(node) {
	const panel = node.__gjjVisualGridPanel;
	const canvas = panel?.canvas;
	if (!canvas) return;
	const stateImageRef = readState(node)?.generatedImageRef;
	if (!panel.finalImageBase64 && stateImageRef?.filename) {
		const state = readState(node);
		panel.finalImageRef = stateImageRef;
		panel.finalImageLayout = state.generatedImageLayout || null;
		panel.cellCount = Number(state.cellCount || 0) || null;
		panel.finalImageBase64 = tempImageUrl(stateImageRef, false);
	}
	if (panel.finalImageBase64) {
		drawBase64Preview(node, panel.finalImageBase64);
		return;
	}
	const ctx = canvas.getContext("2d");
	const parts = parsePromptParts(getWidget(node, "visual_script", ""));
	const count = Math.max(1, parts.length);
	const width = Number(getWidget(node, "total_width", 1024)) || 1024;
	const height = Number(getWidget(node, "total_height", 672)) || 672;
	const line = Math.max(0, Number(getWidget(node, "line_px", 2)) || 2);
	const selected = Math.max(1, Number(getWidget(node, "selected_cell", 1)) || 1);
	const displayW = canvas.clientWidth || 620;
	const displayH = Math.max(170, Math.round(displayW * Math.min(0.72, height / Math.max(1, width))));
	if (canvas.width !== displayW || canvas.height !== displayH) {
		canvas.width = displayW;
		canvas.height = displayH;
	}
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	const scaleX = canvas.width / Math.max(1, width);
	const scaleY = canvas.height / Math.max(1, height);
	const { rects, layout } = layoutRects(node, count, width, height);
	node.__gjjVisualGridLayout = layout;
	node.__gjjVisualGridCanvasScale = { scaleX, scaleY, width, height };
	node.__gjjVisualGridRects = rects.map((rect) => ({
		...rect,
		leftPx: rect.left * scaleX,
		rightPx: rect.right * scaleX,
		topPx: rect.top * scaleY,
		bottomPx: rect.bottom * scaleY,
	}));
	for (let index = 0; index < rects.length; index += 1) {
		const rect = rects[index];
		const left = rect.left * scaleX;
		const top = rect.top * scaleY;
		const cellW = (rect.right - rect.left) * scaleX;
		const cellH = (rect.bottom - rect.top) * scaleY;
		ctx.fillStyle = index < count ? "#e9ece9" : "#1a2226";
		ctx.fillRect(left, top, cellW, cellH);
		if (index + 1 === selected) {
			ctx.strokeStyle = "#4da3ff";
			ctx.lineWidth = 3;
			ctx.strokeRect(left + 2, top + 2, Math.max(1, cellW - 4), Math.max(1, cellH - 4));
		}
		const part = parts[index];
		if (part) {
			ctx.fillStyle = "#182126";
			ctx.font = "600 12px sans-serif";
			const pad = Math.max(6, Math.min(10, Math.floor(Math.min(cellW, cellH) / 18)));
			ctx.fillText(String(part.label || `宫格 ${index + 1}`).slice(0, 30), left + pad, top + pad + 12);
			ctx.fillStyle = "#3f4b51";
			ctx.font = "11px sans-serif";
			const lineHeight = 13;
			const bodyTop = top + pad + 29;
			const maxLines = Math.max(1, Math.floor((cellH - (bodyTop - top) - pad) / lineHeight));
			const lines = wrapCanvasText(ctx, part.body || "", Math.max(20, cellW - pad * 2), Math.min(6, maxLines));
			for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
				const slice = lines[lineIndex];
				if (slice) ctx.fillText(slice, left + pad, bodyTop + lineIndex * lineHeight);
			}
		}
	}
	if (panel.status) {
		panel.status.textContent = `预览 ${count} 格 · 行结构 ${layout.rows.join(",")} · 选中 ${selected} · 黑线 ${line}px`;
	}
	schedulePanelHeight(node);
}

function drawEditableGridOverlay(node, ctx, selected) {
	const rects = node.__gjjVisualGridRects || [];
	if (!rects.length) return;
	ctx.save();
	for (const rect of rects) {
		ctx.strokeStyle = "rgba(0, 0, 0, 0.72)";
		ctx.lineWidth = 1;
		ctx.strokeRect(
			Math.round(rect.leftPx) + 0.5,
			Math.round(rect.topPx) + 0.5,
			Math.max(1, Math.round(rect.rightPx - rect.leftPx) - 1),
			Math.max(1, Math.round(rect.bottomPx - rect.topPx) - 1),
		);
	}
	const hit = rects[Math.max(0, Math.min(Number(selected || 1) - 1, rects.length - 1))];
	if (hit) {
		ctx.strokeStyle = "#4da3ff";
		ctx.lineWidth = 3;
		ctx.strokeRect(
			hit.leftPx + 2,
			hit.topPx + 2,
			Math.max(1, hit.rightPx - hit.leftPx - 4),
			Math.max(1, hit.bottomPx - hit.topPx - 4),
		);
	}
	ctx.restore();
}

function canvasEventPoint(canvas, event) {
	const rect = canvas.getBoundingClientRect();
	const scaleX = canvas.width / Math.max(1, rect.width);
	const scaleY = canvas.height / Math.max(1, rect.height);
	return {
		x: (event.clientX - rect.left) * scaleX,
		y: (event.clientY - rect.top) * scaleY,
	};
}

function dragHit(node, x, y) {
	const rects = node.__gjjVisualGridRects || [];
	const tolerance = 14;
	for (const rect of rects) {
		if (rect.col < (node.__gjjVisualGridLayout?.rows?.[rect.row] || 1) - 1) {
			if (Math.abs(x - rect.rightPx) <= tolerance && y >= rect.topPx - tolerance && y <= rect.bottomPx + tolerance) {
				return { kind: "col", row: rect.row, col: rect.col };
			}
		}
	}
	const rowBounds = new Map();
	for (const rect of rects) {
		rowBounds.set(rect.row, rect.bottomPx);
	}
	const rowCount = node.__gjjVisualGridLayout?.rows?.length || 0;
	for (const [row, bottom] of rowBounds.entries()) {
		if (row < rowCount - 1 && Math.abs(y - bottom) <= tolerance) {
			return { kind: "row", row };
		}
	}
	return null;
}

function selectedCellHit(node, x, y) {
	const rect = (node.__gjjVisualGridRects || [])[selectedCellIndex(node)];
	if (!rect) return null;
	return x >= rect.leftPx && x <= rect.rightPx && y >= rect.topPx && y <= rect.bottomPx ? rect : null;
}

function applyCellImageDrag(node, drag, x, y) {
	const rect = drag?.rect;
	if (!rect) return;
	const cellW = Math.max(1, rect.rightPx - rect.leftPx);
	const cellH = Math.max(1, rect.bottomPx - rect.topPx);
	const next = {
		...drag.startTransform,
		offsetX: drag.startTransform.offsetX + (x - drag.startX) / cellW,
		offsetY: drag.startTransform.offsetY + (y - drag.startY) / cellH,
	};
	setSelectedCellTransform(node, next);
	const status = node.__gjjVisualGridPanel?.status;
	if (status) status.textContent = `移动宫格 ${selectedCellIndex(node) + 1} · 缩放 ${next.scale.toFixed(2)}x`;
}

function applyDrag(node, drag, x, y) {
	const rects = node.__gjjVisualGridRects || [];
	const scale = node.__gjjVisualGridCanvasScale || { scaleX: 1, scaleY: 1, width: 1024, height: 672 };
	const layout = currentVariableLayout(node, Math.max(1, parsePromptParts(getWidget(node, "visual_script", "")).length));
	if (drag.kind === "row") {
		const currentRow = drag.row;
		const rowRects = rects.filter((rect) => rect.row === currentRow);
		const nextRects = rects.filter((rect) => rect.row === currentRow + 1);
		if (!rowRects.length || !nextRects.length) return;
		const top = Math.min(...rowRects.map((rect) => rect.topPx));
		const bottom = Math.max(...nextRects.map((rect) => rect.bottomPx));
		const target = Math.max(top + 24, Math.min(bottom - 24, y));
		const span = Math.max(1, bottom - top);
		const pair = layout.rowHeights[currentRow] + layout.rowHeights[currentRow + 1];
		const before = layout.rowHeights.slice(0, currentRow).reduce((sum, item) => sum + item, 0);
		const after = layout.rowHeights.slice(currentRow + 2).reduce((sum, item) => sum + item, 0);
		const pairTarget = Math.max(0.05, Math.min(pair - 0.05, ((target - top) / span) * pair));
		layout.rowHeights[currentRow] = pairTarget;
		layout.rowHeights[currentRow + 1] = Math.max(0.05, pair - pairTarget);
		const total = before + after + layout.rowHeights[currentRow] + layout.rowHeights[currentRow + 1];
		layout.rowHeights = layout.rowHeights.map((item) => item / total);
		setVariableLayout(node, layout);
		drawPreview(node);
		return;
	}
	if (drag.kind === "col") {
		const row = drag.row;
		const col = drag.col;
		const rowRects = rects.filter((rect) => rect.row === row).sort((a, b) => a.col - b.col);
		if (col < 0 || col + 1 >= rowRects.length) return;
		const left = rowRects[0].leftPx;
		const right = rowRects[rowRects.length - 1].rightPx;
		const target = Math.max(left + 24, Math.min(right - 24, x));
		const span = Math.max(1, right - left);
		const weights = normalizeWeights(layout.rowWeights[row], rowRects.length);
		const before = weights.slice(0, col).reduce((sum, item) => sum + item, 0);
		const pair = weights[col] + weights[col + 1];
		const targetCumulative = (target - left) / span;
		const newLeft = Math.max(0.05, Math.min(pair - 0.05, targetCumulative - before));
		weights[col] = newLeft;
		weights[col + 1] = Math.max(0.05, pair - newLeft);
		layout.rowWeights[row] = normalizeWeights(weights, rowRects.length);
		setVariableLayout(node, layout);
		drawPreview(node);
	}
}

function cellSizeSnapshot(node) {
	const count = Math.max(1, parsePromptParts(getWidget(node, "visual_script", "")).length);
	const width = Number(getWidget(node, "total_width", 1024)) || 1024;
	const height = Number(getWidget(node, "total_height", 672)) || 672;
	const layoutState = node.__gjjVisualGridPanel?.finalImageLayout || null;
	const { rects } = layoutRects(node, count, width, height, layoutState);
	return rects.map((rect) => ({
		width: Math.round(rect.right - rect.left),
		height: Math.round(rect.bottom - rect.top),
	}));
}

function changedGeneratedCellIndexes(node, before) {
	const after = cellSizeSnapshot(node);
	const refs = readState(node).generatedCellRefs;
	const limit = Array.isArray(refs) ? Math.min(refs.length, after.length) : 0;
	const changed = [];
	for (let index = 0; index < limit; index += 1) {
		if (!refs[index]?.filename || !before?.[index]) continue;
		if (before[index].width !== after[index].width || before[index].height !== after[index].height) {
			changed.push(index);
		}
	}
	return changed;
}

function drawBase64Preview(node, base64) {
	const panel = node.__gjjVisualGridPanel;
	const canvas = panel?.canvas;
	if (!canvas || !base64) return;
	const image = new Image();
	image.onload = () => {
		const displayW = canvas.clientWidth || 620;
		const displayH = Math.max(170, Math.round(displayW * image.naturalHeight / Math.max(1, image.naturalWidth)));
		canvas.width = displayW;
		canvas.height = displayH;
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		const count = Math.max(1, Number(panel.cellCount || 0) || parsePromptParts(getWidget(node, "visual_script", "")).length);
		const width = Number(getWidget(node, "total_width", image.naturalWidth)) || image.naturalWidth;
		const height = Number(getWidget(node, "total_height", image.naturalHeight)) || image.naturalHeight;
		const selected = Math.max(1, Number(getWidget(node, "selected_cell", 1)) || 1);
		const scaleX = canvas.width / Math.max(1, width);
		const scaleY = canvas.height / Math.max(1, height);
		const layoutState = panel.finalImageLayout && typeof panel.finalImageLayout === "object" ? panel.finalImageLayout : null;
		const { rects, layout } = layoutRects(node, count, width, height, layoutState);
		node.__gjjVisualGridLayout = layout;
		node.__gjjVisualGridCanvasScale = { scaleX, scaleY, width, height };
		node.__gjjVisualGridRects = rects.map((rect) => ({
			...rect,
			leftPx: rect.left * scaleX,
			rightPx: rect.right * scaleX,
			topPx: rect.top * scaleY,
			bottomPx: rect.bottom * scaleY,
		}));
		drawEditableGridOverlay(node, ctx, selected);
		if (panel.status) panel.status.textContent = `完成。可选择宫格，也可拖动黑色边线调整布局 · 当前 ${selected}`;
		schedulePanelHeight(node);
		refresh(node);
	};
	image.src = String(base64).startsWith("data:") || String(base64).startsWith("/") || String(base64).startsWith("http")
		? base64
		: `data:image/png;base64,${base64}`;
}

async function runNode(node, statusText = "执行当前宫格节点...") {
	const status = node.__gjjVisualGridPanel?.status;
	if (status) status.textContent = statusText;
	writeState(node);
	drawPreview(node);
	refresh(node);
	await queueOnlyCurrentNode(node);
}

async function runNodeWithFreshAncestors(node, statusText = "正在更新上游数据...") {
	const status = node.__gjjVisualGridPanel?.status;
	if (status) status.textContent = statusText;
	writeState(node);
	drawPreview(node);
	refresh(node);
	const queued = await queueCurrentNodeWithFreshAncestors(node);
	if (!queued) await queueOnlyCurrentNode(node);
}

async function generateSelectedCell(node) {
	randomizeSeedIfEnabled(node);
	const mode = smartGenerationMode(node);
	setPendingGeneratedCellIndexes(node, [selectedCellIndex(node)]);
	setWidget(node, "generation_mode", mode);
	setWidget(node, "generation_scope", "选中宫格");
	await runNode(node, `f2k ${mode}：生成选中宫格...`);
}

async function generateAllCells(node) {
	randomizeSeedIfEnabled(node);
	const mode = smartGenerationMode(node);
	setPendingGeneratedCellIndexes(node, Array.from({ length: currentCellCount(node) }, (_, index) => index));
	setWidget(node, "generation_mode", mode);
	setWidget(node, "generation_scope", "全部宫格");
	await runNode(node, `f2k ${mode}：生成全部宫格...`);
}

async function generateChangedCells(node, indexes) {
	const unique = [...new Set((indexes || []).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0))];
	if (!unique.length) {
		await recomposeGeneratedCells(node);
		return;
	}
	randomizeSeedIfEnabled(node);
	const mode = smartGenerationMode(node);
	const state = readState(node);
	state.regenerateCellIndexes = unique;
	state.pendingGeneratedCellIndexes = unique;
	setWidget(node, "grid_state", JSON.stringify(state));
	setWidget(node, "generation_mode", mode);
	setWidget(node, "generation_scope", "选中宫格");
	await runNode(node, `f2k ${mode}：重新生成变尺寸宫格 ${unique.map((item) => item + 1).join(", ")}...`);
	const next = readState(node);
	delete next.regenerateCellIndexes;
	setWidget(node, "grid_state", JSON.stringify(next));
}

async function refreshUpstreamData(node) {
	setWidget(node, "generation_mode", "只拼图");
	clearFinalPreview(node);
	const state = readState(node);
	state.upstreamRefreshNonce = Date.now();
	delete state.generatedImageRef;
	delete state.generatedImageLayout;
	setWidget(node, "grid_state", JSON.stringify(state));
	if (hasReferenceLink(node)) {
		await runNodeWithFreshAncestors(node, "正在强制更新上游图片数据...");
	} else {
		await runNode(node, "正在刷新当前宫格...");
	}
}

async function recomposeGeneratedCells(node) {
	const state = readState(node);
	if (!Array.isArray(state.generatedCellRefs) || !state.generatedCellRefs.length) {
		drawPreview(node);
		refresh(node);
		return;
	}
	if (node.__gjjVisualGridPanel) {
		node.__gjjVisualGridPanel.finalImageBase64 = "";
		node.__gjjVisualGridPanel.finalImageRef = null;
		node.__gjjVisualGridPanel.finalImageLayout = null;
		node.__gjjVisualGridPanel.generatedCellRefs = state.generatedCellRefs;
	}
	setWidget(node, "generation_mode", "只拼图");
	await runNode(node, "按当前布局重拼宫格...");
}

function hasReferenceLink(node) {
	const input = referenceInput(node);
	return Boolean(input && input.link !== null && input.link !== undefined);
}

function referenceInput(node) {
	return (node?.inputs || []).find((item) => String(item?.name || "").includes("reference_image")) || null;
}

function referenceInputIndex(node) {
	const input = referenceInput(node);
	return input ? node?.inputs?.indexOf(input) ?? -1 : -1;
}

function graphLink(linkId) {
	if (linkId === undefined || linkId === null || !app.graph?.links) return null;
	return typeof app.graph.links.get === "function" ? app.graph.links.get(linkId) : app.graph.links[linkId];
}

function currentReferenceLinkRecord(node) {
	const targetSlot = referenceInputIndex(node);
	const input = targetSlot >= 0 ? node?.inputs?.[targetSlot] : null;
	const link = graphLink(input?.link);
	if (!link) return null;
	const originId = Array.isArray(link) ? link[1] : link.origin_id ?? link.source_id ?? link.from_id;
	const originSlot = Number(Array.isArray(link) ? link[2] : link.origin_slot ?? link.source_slot ?? 0);
	const source = originId !== undefined && originId !== null ? app.graph?.getNodeById?.(originId) || null : null;
	const output = source?.outputs?.[originSlot] || null;
	return {
		link_id: input?.link,
		origin_id: originId,
		origin_slot: originSlot,
		origin_name: String(source?.title || source?.name || source?.comfyClass || source?.type || ""),
		origin_output: String(output?.name || output?.localized_name || output?.label || ""),
		target_id: node?.id,
		target_slot: targetSlot,
		target_input: String(input?.name || input?.localized_name || input?.label || "reference_image"),
		type: String(link?.type || output?.type || input?.type || "IMAGE"),
	};
}

function rememberedReferenceLink(node) {
	const record = node?.__gjjVisualGridRememberedReferenceLink || node?.properties?.[PROP_REFERENCE_LINK] || null;
	return record && typeof record === "object" ? record : null;
}

function setRememberedReferenceLink(node, record) {
	node.__gjjVisualGridRememberedReferenceLink = record || null;
	node.properties = node.properties || {};
	if (record) node.properties[PROP_REFERENCE_LINK] = record;
	else delete node.properties[PROP_REFERENCE_LINK];
}

function syncCurrentReferenceLinkMemory(node) {
	const record = currentReferenceLinkRecord(node);
	if (!record) return null;
	setRememberedReferenceLink(node, record);
	return record;
}

function disconnectReferenceLink(node) {
	const record = syncCurrentReferenceLinkMemory(node);
	const targetSlot = record?.target_slot ?? referenceInputIndex(node);
	if (!record || targetSlot < 0) return false;
	try {
		node.disconnectInput?.(targetSlot);
	} catch (_) {
		const input = node.inputs?.[targetSlot];
		if (input) input.link = null;
	}
	clearFinalPreview(node);
	writeState(node);
	updateOpenButton(node);
	refresh(node);
	return true;
}

function reconnectReferenceLink(node) {
	const record = rememberedReferenceLink(node);
	if (!record) return false;
	const source = app.graph?.getNodeById?.(record.origin_id);
	const sourceSlot = Number(record.origin_slot);
	const targetSlot = referenceInputIndex(node);
	if (!source || !source.outputs?.[sourceSlot] || targetSlot < 0) {
		updateOpenButton(node);
		return false;
	}
	try {
		if (node.inputs?.[targetSlot]?.link != null) node.disconnectInput?.(targetSlot);
		source.connect(sourceSlot, node, targetSlot);
		setRememberedReferenceLink(node, record);
		clearFinalPreview(node);
		writeState(node);
		updateOpenButton(node);
		refresh(node);
		return true;
	} catch (error) {
		console.warn("[GJJ] 可视化宫格恢复参考图片连接失败:", error);
		updateOpenButton(node);
		return false;
	}
}

function toggleReferenceLink(node) {
	const status = node.__gjjVisualGridPanel?.status;
	if (hasReferenceLink(node)) {
		const ok = disconnectReferenceLink(node);
		if (status) status.textContent = ok ? "已记住并断开参考图片连接。" : "没有可断开的参考图片连接。";
		return;
	}
	const ok = reconnectReferenceLink(node);
	if (status) status.textContent = ok ? "已恢复参考图片连接。" : "没有可恢复的参考图片连接。";
}

function button(label, title, onClick) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = label;
	btn.title = title;
	btn.style.cssText = [
		"width:28px",
		"height:26px",
		"border:1px solid #38464d",
		"border-radius:7px",
		"background:#121a1f",
		"color:#eef7f2",
		"font-size:16px",
		"line-height:1",
		"cursor:pointer",
	].join(";");
	btn.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(btn);
	});
	return btn;
}

function field(labelText, input) {
	const label = document.createElement("label");
	label.style.cssText = "display:grid;grid-template-columns:74px 1fr;gap:8px;align-items:center;color:#aab8bd;font-size:12px;";
	const span = document.createElement("span");
	span.textContent = labelText;
	label.append(span, input);
	return label;
}

function inputFor(node, name, type = "text") {
	const source = widget(node, name);
	let input;
	const values = source?.options?.values || source?.options?.items;
	if (Array.isArray(values)) {
		input = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			input.appendChild(option);
		}
	} else if (type === "checkbox") {
		input = document.createElement("input");
		input.type = "checkbox";
		input.checked = Boolean(source?.value);
	} else {
		input = document.createElement("input");
		input.type = type;
	}
	input.value = String(source?.value ?? "");
	input.style.cssText = "min-width:0;background:#0f171b;color:#e8f1ed;border:1px solid #34444b;border-radius:6px;padding:4px 6px;";
	input.addEventListener("change", () => {
		setWidget(node, name, type === "checkbox" ? input.checked : input.value);
		writeState(node);
		drawPreview(node);
		refresh(node);
	});
	return input;
}

function readState(node) {
	try {
		return JSON.parse(String(getWidget(node, "grid_state", "{}") || "{}"));
	} catch (_) {
		return {};
	}
}

function writeState(node) {
	const parts = parsePromptParts(getWidget(node, "visual_script", ""));
	const scriptCacheKey = String(getWidget(node, "visual_script", "") || "");
	const state = {
		...readState(node),
		totalWidth: Number(getWidget(node, "total_width", 1024)),
		totalHeight: Number(getWidget(node, "total_height", 672)),
		layoutMode: String(getWidget(node, "layout_mode", "自动")),
		linePx: Number(getWidget(node, "line_px", 2)),
		cellFit: String(getWidget(node, "cell_fit", "铺满裁切")),
		selectedCell: Number(getWidget(node, "selected_cell", 1)),
	};
	if (state.generatedPromptKey !== undefined && state.generatedPromptKey !== scriptCacheKey) {
		delete state.generatedCellRefs;
		delete state.generatedCellIndexes;
		delete state.pendingGeneratedCellIndexes;
		if (node.__gjjVisualGridPanel) node.__gjjVisualGridPanel.generatedCellRefs = [];
	}
	state.generatedPromptKey = scriptCacheKey;
	if (!state.manualLayout && !state.rowTemplate) {
		const keywordRows = keywordRowCounts(parts);
		if (keywordRows.length && keywordRows.reduce((sum, value) => sum + value, 0) === Math.max(1, parts.length)) {
			state.variableLayout = {
				rows: keywordRows,
				rowHeights: normalizeWeights(null, keywordRows.length),
				rowWeights: keywordRows.map((cols) => normalizeWeights(null, cols)),
			};
		}
	}
	const generatedImageRef = node.__gjjVisualGridPanel?.finalImageRef;
	if (generatedImageRef?.filename) state.generatedImageRef = generatedImageRef;
	const generatedImageLayout = node.__gjjVisualGridPanel?.finalImageLayout;
	if (generatedImageLayout && typeof generatedImageLayout === "object") state.generatedImageLayout = generatedImageLayout;
	const cellCount = Number(node.__gjjVisualGridPanel?.cellCount || 0);
	if (cellCount > 0) state.cellCount = cellCount;
	const generatedCellRefs = node.__gjjVisualGridPanel?.generatedCellRefs;
	if (Array.isArray(generatedCellRefs) && generatedCellRefs.length) state.generatedCellRefs = generatedCellRefs;
	if (!state.variableLayout) {
		const count = Math.max(1, parts.length);
		const rows = defaultRowCounts(count, parts);
		state.variableLayout = {
			rows,
			rowHeights: normalizeWeights(null, rows.length),
			rowWeights: rows.map((cols) => normalizeWeights(null, cols)),
		};
	}
	setWidget(node, "grid_state", JSON.stringify(state));
}

function updateToggleButtons(node) {
	const autoBtn = node.__gjjVisualGridAutoResizeButton;
	if (autoBtn) {
		const enabled = stateFlag(node, "autoResizeRegenerate", false);
		autoBtn.style.borderColor = enabled ? "#4da3ff" : "#38464d";
		autoBtn.style.background = enabled ? "#173244" : "#162228";
		autoBtn.title = enabled
			? "自动更新：开。移动宫格线后，变尺寸的已有图片宫格会重新生成"
			: "自动更新：关。移动宫格线后只重拼";
	}
	const seedBtn = node.__gjjVisualGridRandomSeedButton;
	if (seedBtn) {
		const enabled = stateFlag(node, "randomizeSeedOnRun", false);
		seedBtn.style.borderColor = enabled ? "#4da3ff" : "#38464d";
		seedBtn.style.background = enabled ? "#173244" : "#162228";
		seedBtn.title = enabled
			? "随机种：开。每次生成前更新随机种"
			: "随机种：关。保持当前种子";
	}
	const keepModelsBtn = node.__gjjVisualGridKeepModelsButton;
	if (keepModelsBtn) {
		const enabled = Boolean(getWidget(node, "keep_models_loaded", true));
		keepModelsBtn.style.borderColor = enabled ? "#4da3ff" : "#38464d";
		keepModelsBtn.style.background = enabled ? "#173244" : "#162228";
		keepModelsBtn.title = enabled
			? "模型常驻：开。生成后保留 f2k 模型"
			: "模型常驻：关。生成后释放 f2k 模型";
	}
}

function updateOpenButton(node) {
	const linked = hasReferenceLink(node);
	if (linked) syncCurrentReferenceLinkMemory(node);
	const btn = node.__gjjVisualGridOpenButton;
	if (btn) {
		btn.disabled = false;
		btn.style.opacity = "1";
		btn.style.cursor = "pointer";
		btn.title = linked ? "替换当前选中宫格；其余宫格使用当前外部参考图" : "替换当前选中宫格图片";
	}
	const linkBtn = node.__gjjVisualGridLinkButton;
	if (linkBtn) {
		const memory = rememberedReferenceLink(node);
		const oldDisplay = linkBtn.style.display;
		linkBtn.style.display = linked || memory ? "inline-flex" : "none";
		linkBtn.style.borderColor = linked ? "#4da3ff" : "#38464d";
		linkBtn.title = linked
			? "记住当前参考图片连接并断开"
			: memory
			? `恢复连接：${memory.origin_name || "上游节点"} ${memory.origin_output || ""}`
			: "没有可恢复的参考图片连接";
		if (oldDisplay !== linkBtn.style.display) schedulePanelHeight(node);
	}
}

function ensurePanel(node) {
	if (node.__gjjVisualGridPanel) return;
	for (const name of HIDDEN_WIDGETS) collapseWidget(widget(node, name));

	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:4px 0 2px;";

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "image/*";
	fileInput.style.display = "none";
	fileInput.addEventListener("change", async () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		const status = node.__gjjVisualGridPanel?.status;
		try {
			const selected = selectedCellIndex(node) + 1;
			if (status) status.textContent = `正在替换宫格 ${selected}...`;
			const imageRef = await uploadLocalImage(file);
			setSelectedCellImageRef(node, imageRef);
			setWidget(node, "generation_mode", "只拼图");
			clearFinalPreview(node);
			await runNode(node, `正在重拼宫格 ${selected}...`);
			if (status) status.textContent = `已替换宫格 ${selected}。`;
		} catch (error) {
			if (status) status.textContent = `宫格图片替换失败：${error?.message || error}`;
		} finally {
			fileInput.value = "";
		}
	});

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:2px;align-items:center;align-content:flex-start;flex-wrap:wrap;";
	const open = button("📁", "替换当前选中宫格图片", () => {
		fileInput.click();
	});
	node.__gjjVisualGridOpenButton = open;
	toolbar.appendChild(open);
	const link = button("🔗", "断开或恢复参考图片连接", () => toggleReferenceLink(node));
	link.style.display = "none";
	node.__gjjVisualGridLinkButton = link;
	toolbar.appendChild(link);
	toolbar.appendChild(button("🔄", "更新上游数据并刷新宫格", async () => {
		await refreshUpstreamData(node);
	}));
	const autoResize = button("🚕", "自动更新：关。移动宫格线后只重拼", () => {
		setStateFlag(node, "autoResizeRegenerate", !stateFlag(node, "autoResizeRegenerate", false));
		writeState(node);
		refresh(node);
	});
	node.__gjjVisualGridAutoResizeButton = autoResize;
	toolbar.appendChild(autoResize);
	const randomSeed = button("🎲", "随机种：关。保持当前种子", () => {
		setStateFlag(node, "randomizeSeedOnRun", !stateFlag(node, "randomizeSeedOnRun", false));
		writeState(node);
		refresh(node);
	});
	node.__gjjVisualGridRandomSeedButton = randomSeed;
	toolbar.appendChild(randomSeed);
	const keepModels = button("🧠", "模型常驻：开。生成后保留 f2k 模型", () => {
		setWidget(node, "keep_models_loaded", !Boolean(getWidget(node, "keep_models_loaded", true)));
		updateToggleButtons(node);
		writeState(node);
		refresh(node);
	});
	node.__gjjVisualGridKeepModelsButton = keepModels;
	toolbar.appendChild(keepModels);
	toolbar.appendChild(button("📝", "只拼图 / 刷新宫格", async () => {
		setWidget(node, "generation_mode", "只拼图");
		await runNode(node, "只拼图：刷新宫格...");
	}));
	toolbar.appendChild(button("⬅️", "选择上一个宫格", () => {
		const current = Math.max(1, Number(getWidget(node, "selected_cell", 1)) || 1);
		setWidget(node, "selected_cell", Math.max(1, current - 1));
		writeState(node);
		drawPreview(node);
		refresh(node);
	}));
	toolbar.appendChild(button("➡️", "选择下一个宫格", () => {
		const current = Math.max(1, Number(getWidget(node, "selected_cell", 1)) || 1);
		setWidget(node, "selected_cell", Math.min(256, current + 1));
		writeState(node);
		drawPreview(node);
		refresh(node);
	}));
	toolbar.appendChild(button("🖼️", "生成当前选中宫格：有输入图则图生图，否则文生图", async () => {
		await generateSelectedCell(node);
	}));
	toolbar.appendChild(button("🪟", "生成全部宫格：有输入图则图生图，否则文生图", async () => {
		await generateAllCells(node);
	}));

	const settings = document.createElement("div");
	settings.style.cssText = "display:none;grid-template-columns:1fr 1fr;gap:8px;padding:8px;border:1px solid #2e3c43;border-radius:8px;background:#0c1215;";
	toolbar.appendChild(button("⚙️", "参数设置", () => {
		settings.style.display = settings.style.display === "none" ? "grid" : "none";
		schedulePanelHeight(node);
		refresh(node);
	}));

	for (const [labelText, name, type] of [
		["总宽", "total_width", "number"],
		["总高", "total_height", "number"],
		["布局", "layout_mode", "text"],
		["黑线", "line_px", "number"],
		["适配", "cell_fit", "text"],
		["选中", "selected_cell", "number"],
		["步数", "steps", "number"],
		["CFG", "cfg", "number"],
		["种子", "seed", "number"],
		["常驻", "keep_models_loaded", "checkbox"],
		["UNET", "unet_name", "text"],
		["CLIP", "clip_name", "text"],
		["VAE", "vae_name", "text"],
	]) {
		settings.appendChild(field(labelText, inputFor(node, name, type)));
	}
	addManualLayoutControls(node, settings);

	const canvas = document.createElement("canvas");
	canvas.tabIndex = 0;
	canvas.style.cssText = [
		"display:block",
		"width:100%",
		"height:auto",
		"min-height:170px",
		"background:#000",
		"border:1px solid #34444b",
		"border-radius:8px",
	].join(";");
	canvas.addEventListener("click", (event) => {
		event.stopPropagation();
		rememberActiveNode(node);
		canvas.focus({ preventScroll: true });
		if (node.__gjjVisualGridDragged) {
			node.__gjjVisualGridDragged = false;
			return;
		}
		const { x, y } = canvasEventPoint(canvas, event);
		const hit = (node.__gjjVisualGridRects || []).find((item) => x >= item.leftPx && x <= item.rightPx && y >= item.topPx && y <= item.bottomPx);
		if (hit) setWidget(node, "selected_cell", hit.index + 1);
		writeState(node);
		drawPreview(node);
		refresh(node);
	});
	canvas.addEventListener("keydown", async (event) => {
		event.stopPropagation();
		if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
		event.preventDefault();
		await generateSelectedCell(node);
	});
	canvas.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const { x, y } = canvasEventPoint(canvas, event);
		const hit = (node.__gjjVisualGridRects || []).find((item) => x >= item.leftPx && x <= item.rightPx && y >= item.topPx && y <= item.bottomPx);
		if (!hit) return;
		setWidget(node, "selected_cell", hit.index + 1);
		editCellPrompt(node, hit.index);
	});
	canvas.addEventListener("wheel", (event) => {
		const { x, y } = canvasEventPoint(canvas, event);
		if (!selectedCellHit(node, x, y) || !selectedCellHasImage(node)) return;
		event.preventDefault();
		event.stopPropagation();
		const current = selectedCellTransform(node);
		const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
		const next = { ...current, scale: current.scale * factor };
		setSelectedCellTransform(node, next);
		const status = node.__gjjVisualGridPanel?.status;
		if (status) status.textContent = `缩放宫格 ${selectedCellIndex(node) + 1} · ${Math.max(0.1, Math.min(8, next.scale)).toFixed(2)}x`;
		scheduleCellRecompose(node);
		refresh(node);
	}, { passive: false });
	canvas.addEventListener("pointerdown", (event) => {
		event.stopPropagation();
		rememberActiveNode(node);
		const { x, y } = canvasEventPoint(canvas, event);
		const hit = dragHit(node, x, y);
		if (hit) {
			node.__gjjVisualGridDrag = hit;
			node.__gjjVisualGridDragSizes = cellSizeSnapshot(node);
		} else {
			const cellHit = selectedCellHit(node, x, y);
			if (!cellHit || !selectedCellHasImage(node)) return;
			node.__gjjVisualGridDrag = {
				kind: "cell",
				rect: cellHit,
				startX: x,
				startY: y,
				startTransform: selectedCellTransform(node),
			};
			node.__gjjVisualGridDragSizes = null;
		}
		node.__gjjVisualGridDragged = false;
		canvas.setPointerCapture?.(event.pointerId);
		event.preventDefault();
	});
	canvas.addEventListener("pointermove", (event) => {
		event.stopPropagation();
		const { x, y } = canvasEventPoint(canvas, event);
		const hover = dragHit(node, x, y);
		const drag = node.__gjjVisualGridDrag;
		if (!drag) {
			canvas.style.cursor = hover
				? (hover.kind === "row" ? "ns-resize" : "ew-resize")
				: (selectedCellHit(node, x, y) && selectedCellHasImage(node) ? "grab" : "default");
			return;
		}
		canvas.style.cursor = drag.kind === "cell" ? "grabbing" : (drag.kind === "row" ? "ns-resize" : "ew-resize");
		node.__gjjVisualGridDragged = true;
		if (drag.kind === "cell") {
			applyCellImageDrag(node, drag, x, y);
		} else {
			applyDrag(node, drag, x, y);
		}
		refresh(node);
		event.preventDefault();
	});
	canvas.addEventListener("pointerup", async (event) => {
		event.stopPropagation();
		if (node.__gjjVisualGridDrag) {
			const drag = node.__gjjVisualGridDrag;
			canvas.releasePointerCapture?.(event.pointerId);
			node.__gjjVisualGridDrag = null;
			if (drag.kind === "cell") {
				await recomposeGeneratedCells(node);
			} else {
				writeState(node);
				const changed = changedGeneratedCellIndexes(node, node.__gjjVisualGridDragSizes);
				node.__gjjVisualGridDragSizes = null;
				if (stateFlag(node, "autoResizeRegenerate", false)) {
					await generateChangedCells(node, changed);
				} else {
					await recomposeGeneratedCells(node);
				}
			}
		}
	});
	canvas.addEventListener("pointercancel", (event) => {
		event.stopPropagation();
		node.__gjjVisualGridDrag = null;
		node.__gjjVisualGridDragSizes = null;
	});
	const status = document.createElement("div");
	status.style.cssText = "color:#9fb1b7;font-size:12px;line-height:1.3;";
	status.textContent = "等待脚本";
	root.append(fileInput, canvas, status, toolbar, settings);
	const domWidget = node.addDOMWidget?.(PANEL_WIDGET, PANEL_WIDGET, root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => panelContentHeight(root),
	});
	if (domWidget) {
		domWidget.computeSize = (width) => [Math.max(360, Number(width || node.size?.[0] || 360)), panelContentHeight(root)];
	}
	node.__gjjVisualGridPanel = { root, settings, canvas, status, domWidget };
	if (typeof ResizeObserver !== "undefined") {
		node.__gjjVisualGridResizeObserver?.disconnect?.();
		node.__gjjVisualGridResizeObserver = new ResizeObserver(() => schedulePanelHeight(node));
		node.__gjjVisualGridResizeObserver.observe(root);
		node.__gjjVisualGridResizeObserver.observe(toolbar);
		node.__gjjVisualGridResizeObserver.observe(settings);
	}
	updateOpenButton(node);
	updateToggleButtons(node);
	writeState(node);
	drawPreview(node);
	schedulePanelHeight(node);
}

function patchNode(node) {
	if (!node || node.__gjjVisualGridPatched) return;
	ensurePanel(node);
	const originalConnect = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = originalConnect?.apply(this, args);
		if (hasReferenceLink(this)) syncCurrentReferenceLinkMemory(this);
		updateOpenButton(this);
		return result;
	};
	const originalConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = originalConfigure?.apply(this, args);
		const props = args[0]?.properties || this.properties || {};
		if (props[PROP_REFERENCE_LINK]) {
			this.properties = this.properties || {};
			this.properties[PROP_REFERENCE_LINK] = props[PROP_REFERENCE_LINK];
			this.__gjjVisualGridRememberedReferenceLink = props[PROP_REFERENCE_LINK];
		}
		setTimeout(() => {
			ensurePanel(this);
			updateOpenButton(this);
			updateToggleButtons(this);
		}, 0);
		return result;
	};
	const originalSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode, ...args) {
		const result = originalSerialize?.apply(this, [serializedNode, ...args]);
		if (serializedNode) {
			const record = rememberedReferenceLink(this);
			serializedNode.properties = serializedNode.properties || {};
			if (record) serializedNode.properties[PROP_REFERENCE_LINK] = record;
			else delete serializedNode.properties[PROP_REFERENCE_LINK];
		}
		return result;
	};
	const originalExecuted = node.onExecuted;
	node.onExecuted = function (...args) {
		const result = originalExecuted?.apply(this, args);
		const status = this.__gjjVisualGridPanel?.status;
		const selectedRef = firstMessageObject(
			args[0]?.selected_image_ref,
			args[0]?.ui?.selected_image_ref,
			args[0]?.output?.selected_image_ref,
			args[0]?.result?.selected_image_ref,
		);
		const cellRefs = firstMessageObject(
			args[0]?.generated_cell_refs,
			args[0]?.ui?.generated_cell_refs,
			args[0]?.output?.generated_cell_refs,
			args[0]?.result?.generated_cell_refs,
		);
		const cellCount = firstMessageNumber(
			args[0]?.cell_count,
			args[0]?.ui?.cell_count,
			args[0]?.output?.cell_count,
			args[0]?.result?.cell_count,
		);
		const selected = firstMessageValue(
			args[0]?.selected_image,
			args[0]?.ui?.selected_image,
			args[0]?.output?.selected_image,
			args[0]?.result?.selected_image,
		);
		const selectedSrc = tempImageUrl(selectedRef) || selected;
		if (selectedSrc && this.__gjjVisualGridPanel) {
			const count = Math.max(1, cellCount || (Array.isArray(cellRefs) ? cellRefs.length : 0) || parsePromptParts(getWidget(this, "visual_script", "")).length);
			const currentLayout = currentVariableLayout(this, count);
			const previousState = readState(this);
			const pendingIndexes = Array.isArray(previousState.pendingGeneratedCellIndexes)
				? previousState.pendingGeneratedCellIndexes
					.map((item) => Number(item))
					.filter((item) => Number.isInteger(item) && item >= 0 && item < count)
				: [];
			let nextCellRefs = Array.isArray(cellRefs) ? cellRefs : null;
			if (nextCellRefs && pendingIndexes.length > 0 && pendingIndexes.length < count) {
				const mergedRefs = Array.isArray(previousState.generatedCellRefs) ? previousState.generatedCellRefs.slice() : [];
				while (mergedRefs.length < count) mergedRefs.push(null);
				for (let order = 0; order < pendingIndexes.length; order += 1) {
					const index = pendingIndexes[order];
					const ref = nextCellRefs[index]?.filename ? nextCellRefs[index] : nextCellRefs[order];
					if (ref?.filename) mergedRefs[index] = ref;
				}
				nextCellRefs = mergedRefs;
			}
			this.__gjjVisualGridPanel.finalImageBase64 = selectedSrc;
			this.__gjjVisualGridPanel.finalImageRef = selectedRef || null;
			if (Array.isArray(nextCellRefs)) this.__gjjVisualGridPanel.generatedCellRefs = nextCellRefs;
			this.__gjjVisualGridPanel.cellCount = count;
			this.__gjjVisualGridPanel.finalImageLayout = {
				linePx: Number(getWidget(this, "line_px", 2)) || 2,
				variableLayout: currentLayout,
			};
			writeState(this);
			const state = readState(this);
			if (Array.isArray(nextCellRefs) && Array.isArray(state.pendingGeneratedCellIndexes)) {
				const merged = new Set(Array.isArray(state.generatedCellIndexes) ? state.generatedCellIndexes : []);
				for (const index of state.pendingGeneratedCellIndexes) {
					const numeric = Number(index);
					if (Number.isInteger(numeric) && numeric >= 0 && numeric < count) merged.add(numeric);
				}
				state.generatedCellIndexes = [...merged].sort((a, b) => a - b);
				delete state.pendingGeneratedCellIndexes;
			}
			if (Array.isArray(state.regenerateCellIndexes)) {
				delete state.regenerateCellIndexes;
			}
			setWidget(this, "grid_state", JSON.stringify(state));
			updateToggleButtons(this);
			drawBase64Preview(this, selectedSrc);
		} else {
			if (status) status.textContent = "完成。输出口已有最终宫格图。";
			const state = readState(this);
			if (Array.isArray(state.pendingGeneratedCellIndexes)) delete state.pendingGeneratedCellIndexes;
			if (Array.isArray(state.regenerateCellIndexes)) {
				delete state.regenerateCellIndexes;
			}
			setWidget(this, "grid_state", JSON.stringify(state));
			updateToggleButtons(this);
			drawPreview(this);
		}
		return result;
	};
	for (const w of node.widgets || []) {
		if (w?.name === "visual_script" && !w.__gjjVisualGridScriptHooked) {
			const originalCallback = w.callback;
			w.callback = function (...args) {
				const result = originalCallback?.apply(this, args);
				setTimeout(() => drawPreview(node), 0);
				return result;
			};
			w.__gjjVisualGridScriptHooked = true;
		}
	}
	node.__gjjVisualGridPatched = true;
	refresh(node);
}

app.registerExtension({
	name: "GJJ.VisualGridBoard",
	async nodeCreated(node) {
		if (node?.comfyClass === TARGET) setTimeout(() => patchNode(node), 0);
	},
	setup() {
		if (!window.__gjjVisualGridEnterHooked) {
			window.__gjjVisualGridEnterHooked = true;
			window.addEventListener("keydown", async (event) => {
				if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
				if (isTextEditingElement(document.activeElement)) return;
				const node = window.__gjjVisualGridActiveNode;
				if (!node?.__gjjVisualGridPanel) return;
				event.preventDefault();
				event.stopPropagation();
				await generateSelectedCell(node);
			}, true);
		}
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET) patchNode(node);
		}
	},
});

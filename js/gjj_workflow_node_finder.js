import { app } from "/scripts/app.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.WorkflowNodeFinder";
	const MAX_RESULTS = 80;
	const RECENT_KEY = "gjj_workflow_node_finder_recent";
	const REPLACE_TARGET_KEY = "gjj_workflow_node_finder_replace_target";
	const REPLACE_TITLE_KEY = "gjj_workflow_node_finder_replace_title";
	const STYLE_ID = "gjj-workflow-node-finder-style";
	const OVERLAY_ID = "gjj-workflow-node-finder-overlay";
	const GLOBAL_STATE_KEY = "__gjjWorkflowNodeFinder";
	const SORT_OPTIONS = [
		["score", "相关度"],
		["name-asc", "名称↑"],
		["name-desc", "名称↓"],
		["id-asc", "ID↑"],
		["id-desc", "ID↓"],
		["pos-asc", "位置↑"],
		["pos-desc", "位置↓"],
	];

	let overlay = null;
	let searchInput = null;
	let sortButtons = null;
	let resultList = null;
	let countLabel = null;
	let emptyLabel = null;
	let replaceInput = null;
	let replaceSuggest = null;
	let replaceButton = null;
	let replaceTitleCheckbox = null;
	let selectionLabel = null;
	let activeIndex = 0;
	let replaceActiveIndex = 0;
	let currentResults = [];
	let currentReplaceCandidates = [];
	let lastQuery = "";
	let sortMode = "score";
	let selectedNodeIds = new Set();
	let autoSelectedFromQuery = false;
	let recentNodeIds = loadRecentIds();

	function loadRecentIds() {
		try {
			const raw = localStorage.getItem(RECENT_KEY);
			const parsed = JSON.parse(raw || "[]");
			return Array.isArray(parsed) ? parsed.map(String).slice(0, 20) : [];
		} catch (_) {
			return [];
		}
	}

	function saveRecentIds() {
		try {
			localStorage.setItem(RECENT_KEY, JSON.stringify(recentNodeIds.slice(0, 20)));
		} catch (_) {}
	}

	function removeStaleOverlays() {
		for (const item of document.querySelectorAll(`#${OVERLAY_ID}, .gjj-node-finder-overlay`)) {
			if (item !== overlay) {
				item.remove();
			}
		}
	}

	function loadReplaceTarget() {
		try {
			return String(localStorage.getItem(REPLACE_TARGET_KEY) || "").trim();
		} catch (_) {
			return "";
		}
	}

	function saveReplaceTarget(value) {
		try {
			localStorage.setItem(REPLACE_TARGET_KEY, String(value || "").trim());
		} catch (_) {}
	}

	function loadReplaceTitle() {
		try {
			return localStorage.getItem(REPLACE_TITLE_KEY) !== "0";
		} catch (_) {
			return true;
		}
	}

	function saveReplaceTitle(value) {
		try {
			localStorage.setItem(REPLACE_TITLE_KEY, value ? "1" : "0");
		} catch (_) {}
	}

	function shouldReplaceTitle() {
		return replaceTitleCheckbox?.checked !== false;
	}

	function rememberNode(node) {
		const id = String(node?.id ?? "");
		if (!id) {
			return;
		}
		recentNodeIds = [id, ...recentNodeIds.filter((item) => item !== id)].slice(0, 20);
		saveRecentIds();
	}

	function normalizeText(value) {
		return String(value ?? "").toLowerCase().trim();
	}

	function splitSearchTokens(value) {
		return String(value || "")
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Za-z])(\d)/g, "$1 $2")
			.replace(/(\d)([A-Za-z])/g, "$1 $2")
			.split(/[\s,，;；|_/\\:.\-·]+/)
			.map((item) => normalizeText(item))
			.filter((item) => item.length > 1);
	}

	function collectWidgetText(node) {
		const values = [];
		for (const widget of node?.widgets || []) {
			const name = String(widget?.name || "");
			const value = widget?.value;
			if (!name && (value === undefined || value === null || value === "")) {
				continue;
			}
			const text = String(value ?? "");
			if (text.length > 180) {
				values.push(`${name} ${text.slice(0, 180)}`);
			} else {
				values.push(`${name} ${text}`);
			}
		}
		return values.join(" ");
	}

	function nodeDisplayTitle(node) {
		return String(node?.title || node?.constructor?.title || node?.type || `节点 ${node?.id ?? ""}`);
	}

	function nodeSubtitle(node) {
		const type = String(node?.type || "未知类型");
		const id = String(node?.id ?? "?");
		return `${type} | ID: ${id}`;
	}

	function nodeReplacementType(node) {
		return String(
			node?.type ||
			node?.constructor?.nodeData?.name ||
			node?.constructor?.title ||
			""
		).trim();
	}

	function fillReplaceTargetFromNode(node) {
		const type = nodeReplacementType(node);
		if (!type || !replaceInput) {
			return;
		}
		replaceInput.value = type;
		saveReplaceTarget(type);
		hideReplaceSuggestions();
		if (resultList) {
			renderResults();
		}
	}

	function nodeSortName(node) {
		return normalizeText(nodeDisplayTitle(node) || node?.type || node?.id);
	}

	function nodeSortId(node) {
		const numericId = Number(node?.id);
		return Number.isFinite(numericId) ? numericId : 0;
	}

	function nodeSortPosition(node) {
		const x = Number(node?.pos?.[0] || 0);
		const y = Number(node?.pos?.[1] || 0);
		return y * 100000 + x;
	}

	function getWorkflowNodes() {
		const nodes = app.graph?._nodes;
		return Array.isArray(nodes) ? nodes.filter(Boolean) : [];
	}

	function getNodeById(id) {
		const text = String(id ?? "");
		return getWorkflowNodes().find((node) => String(node?.id ?? "") === text) || null;
	}

	function currentCanvasSelection() {
		const canvas = app.canvas;
		const selected = [];
		const pushNode = (node) => {
			if (!node) {
				return;
			}
			const id = String(node?.id ?? "");
			if (!id || selected.some((item) => String(item?.id ?? "") === id)) {
				return;
			}
			selected.push(node);
		};

		const selectedNodes = canvas?.selected_nodes;
		if (Array.isArray(selectedNodes)) {
			selectedNodes.forEach(pushNode);
		} else if (selectedNodes && typeof selectedNodes === "object") {
			Object.values(selectedNodes).forEach(pushNode);
		}
		pushNode(canvas?.selected_node);
		for (const node of getWorkflowNodes()) {
			if (node?.selected) {
				pushNode(node);
			}
		}
		return selected;
	}

	function currentSingleSelectedNode() {
		const selected = currentCanvasSelection();
		return selected.length === 1 ? selected[0] : null;
	}

	function scoreNode(node, query) {
		const kw = normalizeText(query);
		if (!kw) {
			const recentIndex = recentNodeIds.indexOf(String(node?.id ?? ""));
			return recentIndex >= 0 ? 100 - recentIndex : 1;
		}

		const id = normalizeText(node?.id);
		const title = normalizeText(nodeDisplayTitle(node));
		const type = normalizeText(node?.type);
		const widgetText = normalizeText(collectWidgetText(node));
		const haystack = `${title} ${type} ${id} ${widgetText}`;
		let score = 0;

		if (id === kw) score = Math.max(score, 200);
		if (title === kw) score = Math.max(score, 180);
		if (type === kw) score = Math.max(score, 170);
		if (title.startsWith(kw)) score = Math.max(score, 150);
		if (type.startsWith(kw)) score = Math.max(score, 140);
		if (title.includes(kw)) score = Math.max(score, 110);
		if (type.includes(kw)) score = Math.max(score, 100);
		if (id.includes(kw)) score = Math.max(score, 90);
		if (widgetText.includes(kw)) score = Math.max(score, 60);

		if (!score) {
			const chars = kw.split("").filter(Boolean);
			let cursor = 0;
			let fuzzy = 0;
			for (const char of chars) {
				const found = haystack.indexOf(char, cursor);
				if (found < 0) {
					fuzzy = 0;
					break;
				}
				fuzzy += Math.max(1, 12 - Math.min(found - cursor, 10));
				cursor = found + 1;
			}
			score = fuzzy > 0 ? Math.min(50, fuzzy) : 0;
		}

		const recentIndex = recentNodeIds.indexOf(String(node?.id ?? ""));
		if (score && recentIndex >= 0) {
			score += Math.max(1, 12 - recentIndex);
		}
		return score;
	}

	function compareNodesByMode(a, b, mode) {
		if (mode === "name-asc" || mode === "name-desc") {
			const result = nodeSortName(a.node).localeCompare(nodeSortName(b.node), "zh-Hans-CN", {
				numeric: true,
				sensitivity: "base",
			});
			return mode === "name-desc" ? -result : result;
		}
		if (mode === "id-asc" || mode === "id-desc") {
			const result = nodeSortId(a.node) - nodeSortId(b.node);
			return mode === "id-desc" ? -result : result;
		}
		if (mode === "pos-asc" || mode === "pos-desc") {
			const result = nodeSortPosition(a.node) - nodeSortPosition(b.node);
			return mode === "pos-desc" ? -result : result;
		}
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		return String(a.node?.id ?? "").localeCompare(String(b.node?.id ?? ""), undefined, { numeric: true });
	}

	function searchNodes(query) {
		const nodes = getWorkflowNodes();
		const scored = [];
		for (const node of nodes) {
			const score = scoreNode(node, query);
			if (score > 0) {
				scored.push({ node, score });
			}
		}
		scored.sort((a, b) => compareNodesByMode(a, b, sortMode));
		return scored.slice(0, MAX_RESULTS).map((item) => item.node);
	}

	function appendHighlightedText(parent, text, query) {
		const source = String(text ?? "");
		const terms = highlightTerms(query);
		if (!terms.length) {
			parent.textContent = source;
			return;
		}
		const ranges = mergedHighlightRanges(source, terms);
		if (!ranges.length) {
			parent.textContent = source;
			return;
		}
		let cursor = 0;
		for (const [start, end] of ranges) {
			if (start > cursor) {
				parent.appendChild(document.createTextNode(source.slice(cursor, start)));
			}
			const mark = document.createElement("mark");
			mark.className = "gjj-node-finder-highlight";
			mark.textContent = source.slice(start, end);
			parent.appendChild(mark);
			cursor = end;
		}
		if (cursor < source.length) {
			parent.appendChild(document.createTextNode(source.slice(cursor)));
		}
	}

	function highlightTerms(query) {
		const raw = Array.isArray(query) ? query : [query];
		const seen = new Set();
		const terms = [];
		for (const item of raw) {
			const whole = String(item || "").trim();
			const candidates = [whole, ...splitSearchTokens(whole)];
			for (const term of candidates) {
				const key = normalizeText(term);
				if (!key || seen.has(key)) {
					continue;
				}
				seen.add(key);
				terms.push(term);
			}
		}
		return terms;
	}

	function compactTextWithMap(value) {
		const source = String(value || "");
		const chars = [];
		const map = [];
		for (let i = 0; i < source.length;) {
			const code = source.codePointAt(i);
			const char = String.fromCodePoint(code);
			const next = i + char.length;
			if (!/[\s_\-.:/\\|·]+/.test(char)) {
				chars.push(char.toLowerCase());
				map.push([i, next]);
			}
			i = next;
		}
		return { text: chars.join(""), map };
	}

	function pushRange(ranges, start, end) {
		if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
			ranges.push([start, end]);
		}
	}

	function mergedHighlightRanges(source, terms) {
		const ranges = [];
		const lowerSource = source.toLowerCase();
		const compactSource = compactTextWithMap(source);
		for (const term of terms) {
			const lowerTerm = term.toLowerCase();
			let found = lowerSource.indexOf(lowerTerm, 0);
			while (found >= 0) {
				pushRange(ranges, found, found + term.length);
				found = lowerSource.indexOf(lowerTerm, found + term.length);
			}

			const compactTerm = compactTextWithMap(term).text;
			if (compactTerm.length < 2) {
				continue;
			}
			found = compactSource.text.indexOf(compactTerm, 0);
			while (found >= 0) {
				const start = compactSource.map[found]?.[0];
				const end = compactSource.map[found + compactTerm.length - 1]?.[1];
				pushRange(ranges, start, end);
				found = compactSource.text.indexOf(compactTerm, found + compactTerm.length);
			}
		}
		ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
		const merged = [];
		for (const range of ranges) {
			const last = merged[merged.length - 1];
			if (!last || range[0] > last[1]) {
				merged.push(range.slice());
			} else {
				last[1] = Math.max(last[1], range[1]);
			}
		}
		return merged;
	}

	function nodeAliasInfo(node) {
		return [
			nodeDisplayTitle(node),
			nodeSubtitle(node),
			node?.id,
			node?.type,
			node?.constructor?.title,
			node?.constructor?.nodeData?.name,
		].map((item) => {
			const text = String(item || "");
			return {
				text,
				normalized: normalizeText(text),
				compact: compactTextWithMap(text).text,
			};
		});
	}

	function exactMatchVariants(value) {
		const normalized = normalizeText(value);
		const compact = compactTextWithMap(value).text;
		const values = [normalized, compact].filter(Boolean);
		for (const item of [normalized, compact]) {
			if (!item) continue;
			values.push(item.replace(/^gjj[_\s·:/-]*/, ""));
			values.push(item.replace(/^guojijun[_\s·:/-]*/, ""));
		}
		return new Set(values.filter(Boolean));
	}

	function nodeExactlyMatchesQuery(node, query) {
		const text = String(query || "").trim();
		if (!text) return false;
		const queryVariants = exactMatchVariants(text);
		for (const alias of nodeAliasInfo(node)) {
			for (const value of exactMatchVariants(alias.text)) {
				if (queryVariants.has(value)) {
					return true;
				}
			}
		}
		return false;
	}

	function nodeMatchesQueryAnd(node, query) {
		if (!String(query || "").trim()) {
			return false;
		}
		return scoreFuzzyNodeType(nodeAliasInfo(node), query) > 0;
	}

	function resultHighlightTerms(node) {
		const terms = [searchInput?.value || ""];
		const replaceQuery = replaceInput?.value || "";
		if (nodeMatchesQueryAnd(node, replaceQuery)) {
			terms.push(replaceQuery);
		}
		return terms;
	}

	function ensureStyles() {
		if (document.getElementById(STYLE_ID)) {
			return;
		}
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
.gjj-node-finder-overlay {
	position: fixed;
	inset: 0;
	z-index: 100000;
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding: 10vh 18px 18px;
	background: rgba(8, 10, 14, 0.42);
	backdrop-filter: blur(3px);
	box-sizing: border-box;
}
.gjj-node-finder-panel {
	width: min(880px, calc(100vw - 36px));
	max-height: min(72vh, 720px);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	border: 1px solid rgba(255, 255, 255, 0.14);
	border-radius: 8px;
	background: #171a20;
	box-shadow: 0 22px 70px rgba(0, 0, 0, 0.55);
	color: #e8edf4;
	font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gjj-node-finder-top {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px;
	border-bottom: 1px solid rgba(255, 255, 255, 0.1);
	background: #1d222b;
}
.gjj-node-finder-mark {
	flex: 0 0 auto;
	width: 28px;
	height: 28px;
	display: grid;
	place-items: center;
	border-radius: 7px;
	background: #26303d;
	font-size: 15px;
}
.gjj-node-finder-input {
	flex: 1 1 auto;
	min-width: 0;
	height: 34px;
	border: 1px solid rgba(255, 255, 255, 0.16);
	border-radius: 6px;
	background: #0f1218;
	color: #f4f7fb;
	padding: 0 11px;
	outline: none;
	font-size: 14px;
	box-sizing: border-box;
}
.gjj-node-finder-input:focus {
	border-color: #5fb3ff;
	box-shadow: 0 0 0 2px rgba(95, 179, 255, 0.18);
}
.gjj-node-finder-count {
	flex: 0 0 auto;
	color: #9aa6b5;
	font-size: 12px;
	white-space: nowrap;
}
.gjj-node-finder-sort {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 4px;
}
.gjj-node-finder-sort-button {
	height: 30px;
	border: 1px solid rgba(255, 255, 255, 0.14);
	border-radius: 6px;
	background: #242b35;
	color: #dce4ed;
	padding: 0 8px;
	font-size: 12px;
	font-weight: 650;
	cursor: pointer;
	box-sizing: border-box;
}
.gjj-node-finder-sort-button:hover {
	background: #303949;
}
.gjj-node-finder-sort-button.active {
	border-color: #5fb3ff;
	background: #2f5578;
	color: #ffffff;
}
.gjj-node-finder-list {
	overflow: auto;
	padding: 6px;
}
.gjj-node-finder-row {
	display: grid;
	grid-template-columns: 28px 32px minmax(0, 1fr) auto 32px;
	gap: 10px;
	align-items: center;
	min-height: 48px;
	padding: 8px 10px;
	border-radius: 7px;
	cursor: pointer;
	box-sizing: border-box;
}
.gjj-node-finder-row:hover,
.gjj-node-finder-row.active {
	background: #27313f;
}
.gjj-node-finder-row.selected {
	background: #22384a;
}
.gjj-node-finder-check {
	width: 17px;
	height: 17px;
	accent-color: #5fb3ff;
	cursor: pointer;
}
.gjj-node-finder-icon {
	width: 28px;
	height: 28px;
	display: grid;
	place-items: center;
	border-radius: 6px;
	background: #202732;
	color: #ffc766;
	font-size: 14px;
}
.gjj-node-finder-title {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: 650;
	font-size: 13px;
	color: #f2f5f8;
}
.gjj-node-finder-subtitle {
	margin-top: 3px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 11px;
	color: #9aa6b5;
}
.gjj-node-finder-highlight {
	padding: 0 2px;
	border-radius: 2px;
	background: #ffe94f;
	color: #101318;
	font-weight: 750;
}
.gjj-node-finder-pos {
	color: #7f8da0;
	font-size: 11px;
	white-space: nowrap;
}
.gjj-node-finder-fill-button {
	width: 28px;
	height: 28px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border: 1px solid rgba(137, 162, 188, 0.25);
	border-radius: 7px;
	background: #202936;
	color: #e8edf4;
	cursor: pointer;
	font-size: 14px;
	line-height: 1;
}
.gjj-node-finder-fill-button:hover {
	border-color: #5d93c4;
	background: #28405a;
}
.gjj-node-finder-empty {
	padding: 30px 16px 34px;
	text-align: center;
	color: #8f9aaa;
	font-size: 13px;
}
.gjj-node-finder-actions {
	position: relative;
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto auto auto;
	gap: 8px;
	align-items: center;
	padding: 10px 12px;
	border-top: 1px solid rgba(255, 255, 255, 0.1);
	background: #1d222b;
}
.gjj-node-finder-toggle {
	height: 32px;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 0 9px;
	border: 1px solid rgba(255, 255, 255, 0.14);
	border-radius: 6px;
	background: #242b35;
	color: #dce4ed;
	font-size: 12px;
	font-weight: 650;
	white-space: nowrap;
	cursor: pointer;
	box-sizing: border-box;
}
.gjj-node-finder-toggle:hover {
	background: #303949;
}
.gjj-node-finder-toggle input {
	width: 15px;
	height: 15px;
	margin: 0;
	accent-color: #5fb3ff;
	cursor: pointer;
}
.gjj-node-finder-replace-input {
	min-width: 0;
	height: 32px;
	border: 1px solid rgba(255, 255, 255, 0.16);
	border-radius: 6px;
	background: #0f1218;
	color: #f4f7fb;
	padding: 0 10px;
	outline: none;
	font-size: 12px;
	box-sizing: border-box;
}
.gjj-node-finder-replace-input:focus {
	border-color: #5fb3ff;
	box-shadow: 0 0 0 2px rgba(95, 179, 255, 0.16);
}
.gjj-node-finder-action-button {
	height: 32px;
	border: 1px solid rgba(95, 179, 255, 0.45);
	border-radius: 6px;
	background: #2f5578;
	color: #fff;
	padding: 0 10px;
	font-size: 12px;
	font-weight: 750;
	cursor: pointer;
	white-space: nowrap;
}
.gjj-node-finder-action-button:disabled {
	opacity: 0.48;
	cursor: not-allowed;
}
.gjj-node-finder-selection {
	color: #9aa6b5;
	font-size: 12px;
	white-space: nowrap;
}
.gjj-node-finder-replace-suggest {
	position: absolute;
	left: 12px;
	right: 132px;
	bottom: 48px;
	z-index: 2;
	max-height: min(42vh, 420px);
	overflow: auto;
	display: none;
	border: 1px solid rgba(255, 255, 255, 0.14);
	border-radius: 8px;
	background: #11151b;
	box-shadow: 0 14px 42px rgba(0, 0, 0, 0.5);
	padding: 5px;
}
.gjj-node-finder-replace-item {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: 10px;
	padding: 8px 9px;
	border-radius: 6px;
	cursor: pointer;
	box-sizing: border-box;
}
.gjj-node-finder-replace-item:hover,
.gjj-node-finder-replace-item.active {
	background: #27313f;
}
.gjj-node-finder-replace-title {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: #f2f5f8;
	font-size: 12px;
	font-weight: 750;
}
.gjj-node-finder-replace-meta {
	margin-top: 3px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: #93a0af;
	font-size: 11px;
}
.gjj-node-finder-replace-category {
	align-self: center;
	max-width: 180px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: #b8c4d2;
	font-size: 11px;
}
`;
		document.head.appendChild(style);
	}

	function createOverlay() {
		ensureStyles();

		const root = document.createElement("div");
		root.id = OVERLAY_ID;
		root.className = "gjj-node-finder-overlay";
		root.style.display = "none";

		const panel = document.createElement("div");
		panel.className = "gjj-node-finder-panel";

		const top = document.createElement("div");
		top.className = "gjj-node-finder-top";

		const mark = document.createElement("div");
		mark.className = "gjj-node-finder-mark";
		mark.textContent = "🔍";

		searchInput = document.createElement("input");
		searchInput.className = "gjj-node-finder-input";
		searchInput.type = "text";
		searchInput.placeholder = "搜索当前工作流节点：标题 / 类型 / ID / 参数";
		searchInput.autocomplete = "off";
		searchInput.spellcheck = false;

		sortButtons = document.createElement("div");
		sortButtons.className = "gjj-node-finder-sort";
		sortButtons.title = "排序方式";
		for (const [value, label] of SORT_OPTIONS) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "gjj-node-finder-sort-button";
			button.dataset.sort = value;
			button.textContent = label;
			button.addEventListener("click", () => {
				sortMode = value;
				activeIndex = 0;
				renderResults();
				searchInput.focus();
			});
			sortButtons.appendChild(button);
		}

		countLabel = document.createElement("div");
		countLabel.className = "gjj-node-finder-count";

		resultList = document.createElement("div");
		resultList.className = "gjj-node-finder-list";

		emptyLabel = document.createElement("div");
		emptyLabel.className = "gjj-node-finder-empty";
		emptyLabel.textContent = "当前工作流没有可显示的节点";

		const actions = document.createElement("div");
		actions.className = "gjj-node-finder-actions";

		replaceInput = document.createElement("input");
		replaceInput.className = "gjj-node-finder-replace-input";
		replaceInput.type = "text";
		replaceInput.placeholder = "替换为节点类型，例如 GJJ_AnyIndexOutput";
		replaceInput.value = loadReplaceTarget();
		replaceInput.autocomplete = "off";
		replaceInput.spellcheck = false;

		replaceSuggest = document.createElement("div");
		replaceSuggest.className = "gjj-node-finder-replace-suggest";

		replaceButton = document.createElement("button");
		replaceButton.type = "button";
		replaceButton.className = "gjj-node-finder-action-button";
		replaceButton.textContent = "替换所选";

		const replaceTitleToggle = document.createElement("label");
		replaceTitleToggle.className = "gjj-node-finder-toggle";
		replaceTitleToggle.title = "开启后，替换节点时使用新节点的中文标题；关闭后保留原节点标题。";
		replaceTitleCheckbox = document.createElement("input");
		replaceTitleCheckbox.type = "checkbox";
		replaceTitleCheckbox.checked = loadReplaceTitle();
		replaceTitleCheckbox.addEventListener("change", () => saveReplaceTitle(replaceTitleCheckbox.checked));
		const replaceTitleText = document.createElement("span");
		replaceTitleText.textContent = "替换标题";
		replaceTitleToggle.append(replaceTitleCheckbox, replaceTitleText);

		selectionLabel = document.createElement("div");
		selectionLabel.className = "gjj-node-finder-selection";

		actions.append(replaceInput, replaceSuggest, replaceTitleToggle, replaceButton, selectionLabel);
		top.append(mark, searchInput, sortButtons, countLabel);
		panel.append(top, resultList, emptyLabel, actions);
		root.appendChild(panel);
		document.body.appendChild(root);

		root.addEventListener("mousedown", (event) => {
			if (event.target === root) {
				closeFinder();
			}
		});

		searchInput.addEventListener("input", () => {
			lastQuery = searchInput.value || "";
			activeIndex = 0;
			renderResults();
		});

		searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				closeFinder();
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				moveActive(1);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				moveActive(-1);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const node = currentResults[activeIndex];
				if (node) {
					focusNode(node);
					closeFinder();
				}
			}
		});

		replaceInput.addEventListener("input", () => {
			saveReplaceTarget(replaceInput.value || "");
			renderReplaceSuggestions();
			renderResults();
			updateSelectionState();
		});
		replaceInput.addEventListener("focus", () => renderReplaceSuggestions());
		replaceInput.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				moveReplaceActive(1);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				moveReplaceActive(-1);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				if (isReplaceSuggestVisible() && currentReplaceCandidates[replaceActiveIndex]) {
					chooseReplaceCandidate(currentReplaceCandidates[replaceActiveIndex]);
					return;
				}
				replaceSelectedNodes();
			}
			if (event.key === "Escape") {
				event.preventDefault();
				if (isReplaceSuggestVisible()) {
					hideReplaceSuggestions();
					return;
				}
				closeFinder();
			}
		});
		replaceButton.addEventListener("click", () => replaceSelectedNodes());

		return root;
	}

	function openFinder() {
		removeStaleOverlays();
		if (!overlay || !overlay.isConnected) {
			overlay = createOverlay();
		}
		if (overlay.style.display !== "none") {
			hideReplaceSuggestions();
			requestAnimationFrame(() => {
				searchInput.focus();
				searchInput.select();
			});
			return;
		}
		selectedNodeIds.clear();
		const selectedType = nodeReplacementType(currentSingleSelectedNode());
		const nextQuery = selectedType || lastQuery;
		if (selectedType) {
			lastQuery = selectedType;
		}
		overlay.style.display = "flex";
		searchInput.value = nextQuery;
		activeIndex = 0;
		renderResults();
		requestAnimationFrame(() => {
			searchInput.focus();
			searchInput.select();
		});
	}

	function closeFinder() {
		if (!overlay) {
			return;
		}
		hideReplaceSuggestions();
		overlay.style.display = "none";
	}

	function moveActive(delta) {
		if (!currentResults.length) {
			return;
		}
		activeIndex = (activeIndex + delta + currentResults.length) % currentResults.length;
		updateActiveRow();
	}

	function updateActiveRow() {
		const rows = Array.from(resultList.querySelectorAll(".gjj-node-finder-row"));
		rows.forEach((row, index) => {
			const active = index === activeIndex;
			row.classList.toggle("active", active);
			if (active) {
				row.scrollIntoView({ block: "nearest" });
			}
		});
	}

	function updateSortButtons() {
		if (!sortButtons) {
			return;
		}
		for (const button of sortButtons.querySelectorAll(".gjj-node-finder-sort-button")) {
			button.classList.toggle("active", button.dataset.sort === sortMode);
		}
	}

	function nodeTypeDisplayName(type, nodeCtor) {
		return String(
			nodeCtor?.nodeData?.display_name ||
			nodeCtor?.nodeData?.displayName ||
			nodeCtor?.title ||
			nodeCtor?.nodeData?.name ||
			type ||
			""
		);
	}

	function replacementTitleForNode(node) {
		const type = String(node?.type || node?.comfyClass || node?.constructor?.nodeData?.name || "");
		const nodeCtor = node?.constructor || globalThis.LiteGraph?.registered_node_types?.[type];
		return String(nodeTypeDisplayName(type, nodeCtor) || node?.title || type).trim();
	}

	function nodeTypeCategory(nodeCtor) {
		return String(nodeCtor?.nodeData?.category || nodeCtor?.category || "");
	}

	function nodeTypeAliasInfo(type, display, category, nodeCtor) {
		return [
			type,
			display,
			category,
			nodeCtor?.nodeData?.name,
			nodeCtor?.nodeData?.title,
			nodeCtor?.comfyClass,
		].map((item) => {
			const text = String(item || "");
			return {
				text,
				normalized: normalizeText(text),
				compact: compactTextWithMap(text).text,
			};
		});
	}

	function scoreAliasToken(alias, token) {
		const compactToken = compactTextWithMap(token).text;
		if (!token && !compactToken) return 0;
		if (alias.normalized === token || alias.compact === compactToken) return 80;
		if (alias.normalized.startsWith(token) || alias.compact.startsWith(compactToken)) return 64;
		if (alias.normalized.includes(token) || alias.compact.includes(compactToken)) return 48;
		return 0;
	}

	function scoreFuzzyNodeType(aliases, query) {
		const kw = normalizeText(query);
		if (!kw) return 1;
		const compactKw = compactTextWithMap(query).text;

		let score = 0;
		for (const alias of aliases) {
			if (alias.normalized === kw) score = Math.max(score, 220);
			if (compactKw && alias.compact === compactKw) score = Math.max(score, 210);
			if (alias.normalized.startsWith(kw)) score = Math.max(score, 180);
			if (compactKw && alias.compact.startsWith(compactKw)) score = Math.max(score, 170);
			if (alias.normalized.includes(kw)) score = Math.max(score, 140);
			if (compactKw && alias.compact.includes(compactKw)) score = Math.max(score, 130);
		}

		const tokens = splitSearchTokens(query);
		if (!tokens.length) return score;
		let tokenScore = 0;
		for (const token of tokens) {
			const best = Math.max(...aliases.map((alias) => scoreAliasToken(alias, token)));
			if (!best) return score;
			tokenScore += best;
		}
		return Math.max(score, 70 + tokenScore + tokens.length * 3);
	}

	function collectNodeTypeCandidates(query) {
		const registry = globalThis.LiteGraph?.registered_node_types || {};
		const items = [];
		for (const [type, nodeCtor] of Object.entries(registry)) {
			const display = nodeTypeDisplayName(type, nodeCtor);
			const category = nodeTypeCategory(nodeCtor);
			const aliases = nodeTypeAliasInfo(type, display, category, nodeCtor);
			const score = scoreFuzzyNodeType(aliases, query);
			if (score > 0) {
				items.push({ type, display, category, score });
			}
		}
		items.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.display.localeCompare(b.display, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
		});
		return items.slice(0, 80);
	}

	function isReplaceSuggestVisible() {
		return Boolean(replaceSuggest && replaceSuggest.style.display !== "none");
	}

	function hideReplaceSuggestions() {
		if (replaceSuggest) {
			replaceSuggest.style.display = "none";
			replaceSuggest.replaceChildren();
		}
		currentReplaceCandidates = [];
		replaceActiveIndex = 0;
	}

	function updateReplaceActiveRow() {
		if (!replaceSuggest) {
			return;
		}
		const rows = Array.from(replaceSuggest.querySelectorAll(".gjj-node-finder-replace-item"));
		rows.forEach((row, index) => {
			const active = index === replaceActiveIndex;
			row.classList.toggle("active", active);
			if (active) row.scrollIntoView({ block: "nearest" });
		});
	}

	function moveReplaceActive(delta) {
		if (!currentReplaceCandidates.length) {
			renderReplaceSuggestions();
		}
		if (!currentReplaceCandidates.length) {
			return;
		}
		replaceActiveIndex = (replaceActiveIndex + delta + currentReplaceCandidates.length) % currentReplaceCandidates.length;
		updateReplaceActiveRow();
	}

	function chooseReplaceCandidate(candidate) {
		if (!candidate) {
			return;
		}
		replaceInput.value = candidate.type;
		saveReplaceTarget(candidate.type);
		hideReplaceSuggestions();
		updateSelectionState();
		renderResults();
		replaceInput.focus();
	}

	function renderReplaceSuggestions() {
		if (!replaceSuggest || !replaceInput) {
			return;
		}
		const query = replaceInput.value || "";
		currentReplaceCandidates = collectNodeTypeCandidates(query);
		if (!String(query || "").trim()) {
			currentReplaceCandidates = currentReplaceCandidates.slice(0, 30);
		}
		replaceActiveIndex = Math.min(replaceActiveIndex, Math.max(0, currentReplaceCandidates.length - 1));
		replaceSuggest.replaceChildren();
		if (!currentReplaceCandidates.length) {
			hideReplaceSuggestions();
			return;
		}
		for (const [index, candidate] of currentReplaceCandidates.entries()) {
			const row = document.createElement("div");
			row.className = "gjj-node-finder-replace-item";
			row.dataset.index = String(index);

			const main = document.createElement("div");
			main.style.minWidth = "0";
			const title = document.createElement("div");
			title.className = "gjj-node-finder-replace-title";
			appendHighlightedText(title, candidate.display, query);
			const meta = document.createElement("div");
			meta.className = "gjj-node-finder-replace-meta";
			appendHighlightedText(meta, candidate.type, query);
			main.append(title, meta);

			const category = document.createElement("div");
			category.className = "gjj-node-finder-replace-category";
			category.textContent = candidate.category || "节点";
			row.append(main, category);
			row.addEventListener("mouseenter", () => {
				replaceActiveIndex = index;
				updateReplaceActiveRow();
			});
			row.addEventListener("mousedown", (event) => {
				event.preventDefault();
				event.stopPropagation();
				chooseReplaceCandidate(candidate);
			});
			replaceSuggest.appendChild(row);
		}
		replaceSuggest.style.display = "block";
		updateReplaceActiveRow();
	}

	function selectedNodes() {
		const nodes = [];
		for (const id of selectedNodeIds) {
			const node = getNodeById(id);
			if (node) {
				nodes.push(node);
			}
		}
		return nodes;
	}

	function updateSelectionState() {
		for (const id of [...selectedNodeIds]) {
			if (!getNodeById(id)) {
				selectedNodeIds.delete(id);
			}
		}
		const selectedCount = selectedNodeIds.size;
		if (selectionLabel) {
			selectionLabel.textContent = selectedCount ? `已选 ${selectedCount}` : "未选择";
		}
		if (replaceButton) {
			replaceButton.disabled = !selectedCount || !String(replaceInput?.value || "").trim();
		}
		if (resultList) {
			for (const row of resultList.querySelectorAll(".gjj-node-finder-row")) {
				const checked = selectedNodeIds.has(String(row.dataset.nodeId || ""));
				row.classList.toggle("selected", checked);
				const input = row.querySelector(".gjj-node-finder-check");
				if (input) {
					input.checked = checked;
				}
			}
		}
	}

	function toggleNodeSelection(node, checked) {
		const id = String(node?.id ?? "");
		if (!id) {
			return;
		}
		if (checked) {
			selectedNodeIds.add(id);
			fillReplaceTargetFromNode(node);
		} else {
			selectedNodeIds.delete(id);
		}
		updateSelectionState();
	}

	function selectMatchedResults(query) {
		const text = String(query || "").trim();
		if (!text) {
			if (autoSelectedFromQuery) {
				selectedNodeIds.clear();
				autoSelectedFromQuery = false;
			}
			return;
		}
		selectedNodeIds.clear();
		for (const node of currentResults) {
			const id = String(node?.id ?? "");
			if (id && nodeExactlyMatchesQuery(node, text)) {
				selectedNodeIds.add(id);
			}
		}
		autoSelectedFromQuery = true;
	}

	function renderResults(options = {}) {
		const query = searchInput?.value || "";
		updateSortButtons();
		currentResults = searchNodes(query);
		if (!options.preserveSelection) {
			selectMatchedResults(query);
		}
		activeIndex = Math.min(activeIndex, Math.max(0, currentResults.length - 1));
		resultList.replaceChildren();

		const totalNodes = getWorkflowNodes().length;
		countLabel.textContent = `${currentResults.length} / ${totalNodes}`;
		emptyLabel.style.display = currentResults.length ? "none" : "block";
		emptyLabel.textContent = totalNodes ? "没有匹配的节点" : "当前工作流没有可显示的节点";

		currentResults.forEach((node, index) => {
			const highlight = resultHighlightTerms(node);
			const row = document.createElement("div");
			row.className = "gjj-node-finder-row";
			row.dataset.index = String(index);
			row.dataset.nodeId = String(node?.id ?? "");

			const checkbox = document.createElement("input");
			checkbox.className = "gjj-node-finder-check";
			checkbox.type = "checkbox";
			checkbox.title = "勾选后可批量替换";
			checkbox.checked = selectedNodeIds.has(String(node?.id ?? ""));

			const icon = document.createElement("div");
			icon.className = "gjj-node-finder-icon";
			icon.textContent = "📍";

			const main = document.createElement("div");
			main.style.minWidth = "0";

			const title = document.createElement("div");
			title.className = "gjj-node-finder-title";
			appendHighlightedText(title, nodeDisplayTitle(node), highlight);

			const subtitle = document.createElement("div");
			subtitle.className = "gjj-node-finder-subtitle";
			appendHighlightedText(subtitle, nodeSubtitle(node), highlight);

			const pos = document.createElement("div");
			pos.className = "gjj-node-finder-pos";
			const x = Math.round(Number(node?.pos?.[0] || 0));
			const y = Math.round(Number(node?.pos?.[1] || 0));
			pos.textContent = `${x}, ${y}`;

			const fillButton = document.createElement("button");
			fillButton.type = "button";
			fillButton.className = "gjj-node-finder-fill-button";
			fillButton.textContent = "👇";
			fillButton.title = "填入下方替换搜索框";

			main.append(title, subtitle);
			row.append(checkbox, icon, main, pos, fillButton);

			checkbox.addEventListener("click", (event) => {
				event.stopPropagation();
				toggleNodeSelection(node, checkbox.checked);
			});

			fillButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				fillReplaceTargetFromNode(node);
				updateSelectionState();
			});

			row.addEventListener("mouseenter", () => {
				activeIndex = index;
				updateActiveRow();
			});
			row.addEventListener("click", () => {
				focusNode(node);
			});

			resultList.appendChild(row);
		});
		updateActiveRow();
		updateSelectionState();
	}

	function selectNode(node) {
		const canvas = app.canvas;
		if (!canvas || !node) {
			return;
		}
		if (typeof canvas.deselectAllNodes === "function") {
			canvas.deselectAllNodes();
		} else if (typeof canvas.deselectAll === "function") {
			canvas.deselectAll();
		}
		for (const item of getWorkflowNodes()) {
			item.selected = false;
		}
		node.selected = true;
		canvas.selected_nodes = {};
		canvas.selected_nodes[node.id] = node;
		if (typeof canvas.setSelectedNodes === "function") {
			canvas.setSelectedNodes(canvas.selected_nodes);
		}
	}

	function centerCanvasOnNode(node) {
		const canvas = app.canvas;
		if (!canvas || !node) {
			return;
		}
		const ds = canvas.ds || canvas.viewport;
		const canvasEl = canvas.canvas || canvas.canvas_mouse;
		if (!ds || !Array.isArray(ds.offset) || !canvasEl) {
			if (typeof canvas.centerOnNode === "function") {
				canvas.centerOnNode(node);
				return;
			}
			if (typeof canvas.focusOnNode === "function") {
				canvas.focusOnNode(node);
				return;
			}
			if (typeof canvas.scrollToNode === "function") {
				canvas.scrollToNode(node);
			}
			return;
		}

		const width = Number(node.size?.[0] || 160);
		const height = Number(node.size?.[1] || 80);
		const viewWidth = Number(canvasEl.width || canvasEl.clientWidth || window.innerWidth || 1);
		const viewHeight = Number(canvasEl.height || canvasEl.clientHeight || window.innerHeight || 1);
		const fitScale = Math.min(viewWidth / Math.max(width + 260, 1), viewHeight / Math.max(height + 220, 1));
		const targetScale = Math.max(0.95, Math.min(1.2, fitScale || 1));

		try {
			if (typeof ds.changeScale === "function") {
				ds.changeScale(targetScale, [viewWidth / 2, viewHeight / 2]);
			} else {
				ds.scale = targetScale;
			}
		} catch (_) {
			ds.scale = targetScale;
		}

		const scale = Number(ds.scale || targetScale || 1);
		const targetX = Number(node.pos?.[0] || 0) + width / 2;
		const targetY = Number(node.pos?.[1] || 0) + height / 2;
		ds.offset[0] = canvasEl.width / (2 * scale) - targetX;
		ds.offset[1] = canvasEl.height / (2 * scale) - targetY;
	}

	function flashNode(node) {
		if (!node) {
			return;
		}
		const previous = node.bgcolor;
		node.bgcolor = "#4f7fbf";
		app.graph?.setDirtyCanvas?.(true, true);
		setTimeout(() => {
			node.bgcolor = previous;
			app.graph?.setDirtyCanvas?.(true, true);
		}, 550);
	}

	function focusNode(node) {
		if (!node) {
			return;
		}
		rememberNode(node);
		selectNode(node);
		centerCanvasOnNode(node);
		flashNode(node);
		app.canvas?.setDirty?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	function slotTypeText(slot) {
		return String(slot?.type || "*");
	}

	function splitTypes(type) {
		return String(type || "*")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}

	function typesCompatible(a, b) {
		const left = splitTypes(a);
		const right = splitTypes(b);
		if (!left.length || !right.length || left.includes("*") || right.includes("*")) {
			return true;
		}
		return left.some((item) => right.includes(item));
	}

	function slotName(slot) {
		return String(slot?.name || slot?.label || slot?.localized_name || "");
	}

	function normalizedSlotName(slot) {
		return normalizeText(slotName(slot).replace(/[：:]/g, "").replace(/\s+/g, ""));
	}

	function findCompatibleSlot(slots, sourceSlot, _preferredIndex, used = new Set()) {
		const list = Array.isArray(slots) ? slots : [];
		const sourceName = normalizedSlotName(sourceSlot);
		const sourceType = slotTypeText(sourceSlot);
		const exact = list.findIndex((slot, index) => !used.has(index) && normalizedSlotName(slot) === sourceName && typesCompatible(slotTypeText(slot), sourceType));
		if (exact >= 0) {
			return exact;
		}
		const byName = list.findIndex((slot, index) => !used.has(index) && sourceName && normalizedSlotName(slot) === sourceName);
		if (byName >= 0) {
			return byName;
		}
		const byType = list
			.map((slot, index) => ({ slot, index }))
			.filter((item) => !used.has(item.index) && typesCompatible(slotTypeText(item.slot), sourceType));
		if (byType.length === 1) {
			return byType[0].index;
		}
		const strictByType = list
			.map((slot, index) => ({ slot, index }))
			.filter((item) => !used.has(item.index) && slotTypeText(item.slot) === sourceType);
		if (strictByType.length === 1) {
			return strictByType[0].index;
		}
		return -1;
	}

	function graphLinks() {
		return app.graph?.links || {};
	}

	function collectNodeConnections(node) {
		const links = graphLinks();
		const inputs = [];
		const outputs = [];

		(node.inputs || []).forEach((input, index) => {
			const linkId = input?.link;
			const link = links?.[linkId];
			if (!link) {
				return;
			}
			inputs.push({
				slot: input,
				slotIndex: index,
				originId: link.origin_id,
				originSlot: link.origin_slot,
			});
		});

		(node.outputs || []).forEach((output, index) => {
			for (const linkId of output?.links || []) {
				const link = links?.[linkId];
				if (!link) {
					continue;
				}
				outputs.push({
					slot: output,
					slotIndex: index,
					targetId: link.target_id,
					targetSlot: link.target_slot,
				});
			}
		});

		return { inputs, outputs };
	}

	function findRegisteredNodeType(query) {
		const text = String(query || "").trim();
		if (!text) {
			return "";
		}
		const registry = globalThis.LiteGraph?.registered_node_types || {};
		if (registry[text]) {
			return text;
		}
		const candidates = collectNodeTypeCandidates(text);
		if (candidates.length) {
			const exact = candidates.find((item) => normalizeText(item.type) === normalizeText(text) || normalizeText(item.display) === normalizeText(text));
			return (exact || candidates[0]).type;
		}
		const normalized = normalizeText(text);
		for (const [type, nodeCtor] of Object.entries(registry)) {
			const candidates = [
				type,
				nodeCtor?.title,
				nodeCtor?.comfyClass,
				nodeCtor?.nodeData?.name,
				nodeCtor?.nodeData?.display_name,
				nodeCtor?.nodeData?.title,
			];
			if (candidates.some((item) => normalizeText(item) === normalized)) {
				return type;
			}
		}
		for (const [type, nodeCtor] of Object.entries(registry)) {
			const candidates = [
				type,
				nodeCtor?.title,
				nodeCtor?.nodeData?.display_name,
			];
			if (candidates.some((item) => normalizeText(item).includes(normalized))) {
				return type;
			}
		}
		return text;
	}

	function createReplacementNode(type) {
		const resolvedType = findRegisteredNodeType(type);
		let node = null;
		try {
			node = globalThis.LiteGraph?.createNode?.(resolvedType);
		} catch (_) {
			node = null;
		}
		if (!node) {
			throw new Error(`未找到可创建的节点类型：${type}`);
		}
		return node;
	}

	function copyWidgetValues(source, target) {
		const sourceWidgets = Array.isArray(source?.widgets) ? source.widgets : [];
		const targetWidgets = Array.isArray(target?.widgets) ? target.widgets : [];
		const used = new Set();

		for (const targetWidget of targetWidgets) {
			const targetName = String(targetWidget?.name || "");
			let sourceIndex = sourceWidgets.findIndex((widget, index) => !used.has(index) && String(widget?.name || "") === targetName);
			if (sourceIndex < 0) {
				const targetType = String(targetWidget?.type || "");
				const sameType = sourceWidgets
					.map((widget, index) => ({ widget, index }))
					.filter((item) => !used.has(item.index) && String(item.widget?.type || "") === targetType);
				sourceIndex = sameType.length === 1 ? sameType[0].index : -1;
			}
			if (sourceIndex < 0) {
				continue;
			}
			used.add(sourceIndex);
			const sourceWidget = sourceWidgets[sourceIndex];
			try {
				targetWidget.value = sourceWidget?.value;
				targetWidget.callback?.(targetWidget.value, app.canvas, target, undefined, targetWidget);
			} catch (_) {}
		}
	}

	function copyBasicNodeState(source, target, options = {}) {
		const replaceTitle = options.replaceTitle !== false;
		const replacementTitle = replacementTitleForNode(target);
		target.pos = [Number(source?.pos?.[0] || 0), Number(source?.pos?.[1] || 0)];
		if (Array.isArray(source?.size)) {
			target.size = [Number(source.size[0] || target.size?.[0] || 180), Number(source.size[1] || target.size?.[1] || 80)];
		}
		if (!replaceTitle && source?.title && source.title !== source.type) {
			target.title = source.title;
		}
		for (const key of ["color", "bgcolor", "boxcolor"]) {
			if (source?.[key]) {
				target[key] = source[key];
			}
		}
		if (source?.properties) {
			target.properties = { ...(target.properties || {}), ...source.properties };
			target.properties["Node name for S&R"] = target.type || target.comfyClass || target.properties["Node name for S&R"];
			if (replaceTitle) {
				delete target.properties.title;
				delete target.properties.Title;
				delete target.properties.label;
				delete target.properties.display_name;
			}
		}
		copyWidgetValues(source, target);
		if (replaceTitle && replacementTitle) {
			target.title = replacementTitle;
		}
	}

	function restoreConnections(source, target, saved, nodeMap = new Map()) {
		const inputUsed = new Set();
		for (const item of saved.inputs) {
			const origin = nodeMap.get(String(item.originId)) || app.graph?.getNodeById?.(item.originId);
			if (!origin) {
				continue;
			}
			const targetSlot = findCompatibleSlot(target.inputs, item.slot, item.slotIndex, inputUsed);
			if (targetSlot < 0) {
				continue;
			}
			try {
				origin.connect?.(item.originSlot, target, targetSlot);
				inputUsed.add(targetSlot);
			} catch (_) {}
		}

		for (const item of saved.outputs) {
			const targetNode = nodeMap.get(String(item.targetId)) || app.graph?.getNodeById?.(item.targetId);
			if (!targetNode) {
				continue;
			}
			const outputSlot = findCompatibleSlot(target.outputs, item.slot, item.slotIndex);
			if (outputSlot < 0) {
				continue;
			}
			try {
				target.connect?.(outputSlot, targetNode, item.targetSlot);
			} catch (_) {}
		}
	}

	function replaceOneNode(source, targetType) {
		const saved = collectNodeConnections(source);
		const target = createReplacementNode(targetType);
		copyBasicNodeState(source, target, { replaceTitle: shouldReplaceTitle() });
		app.graph?.add?.(target);
		try {
			app.graph?.remove?.(source);
		} catch (_) {
			source.graph?.remove?.(source);
		}
		restoreConnections(source, target, saved);
		rememberNode(target);
		return target;
	}

	function replaceSelectedNodes() {
		const targetType = String(replaceInput?.value || "").trim();
		const nodes = selectedNodes();
		if (!targetType || !nodes.length) {
			updateSelectionState();
			return;
		}
		saveReplaceTarget(targetType);

		const jobs = [];
		const failures = [];
		for (const node of nodes) {
			try {
				const target = createReplacementNode(targetType);
				copyBasicNodeState(node, target, { replaceTitle: shouldReplaceTitle() });
				jobs.push({ source: node, target, saved: collectNodeConnections(node) });
			} catch (error) {
				failures.push(`${nodeDisplayTitle(node)}：${error?.message || error}`);
			}
		}

		const nodeMap = new Map();
		for (const job of jobs) {
			try {
				app.graph?.add?.(job.target);
				nodeMap.set(String(job.source?.id ?? ""), job.target);
			} catch (error) {
				failures.push(`${nodeDisplayTitle(job.source)}：${error?.message || error}`);
			}
		}

		for (const job of jobs) {
			try {
				app.graph?.remove?.(job.source);
			} catch (_) {
				job.source?.graph?.remove?.(job.source);
			}
		}

		for (const job of jobs) {
			try {
				restoreConnections(job.source, job.target, job.saved, nodeMap);
				rememberNode(job.target);
			} catch (error) {
				failures.push(`${nodeDisplayTitle(job.target)}：${error?.message || error}`);
			}
		}

		const created = jobs.map((job) => job.target);
		selectedNodeIds = new Set(created.map((node) => String(node?.id ?? "")).filter(Boolean));
		renderResults({ preserveSelection: true });
		if (created[0]) {
			focusNode(created[0]);
		}
		app.graph?.setDirtyCanvas?.(true, true);
		app.canvas?.setDirty?.(true, true);

		if (failures.length) {
			alert(`部分节点替换失败：\n${failures.slice(0, 6).join("\n")}`);
		}
	}

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			const previousState = globalThis[GLOBAL_STATE_KEY];
			if (typeof previousState?.cleanup === "function") {
				try { previousState.cleanup(); } catch (_) {}
			}
			removeStaleOverlays();
			const keydownHandler = (event) => {
				const key = String(event.key || "").toLowerCase();
				if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || key !== "f") {
					return;
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				openFinder();
			};
			document.addEventListener("keydown", keydownHandler, true);
			globalThis[GLOBAL_STATE_KEY] = {
				openFinder,
				closeFinder,
				cleanup() {
					document.removeEventListener("keydown", keydownHandler, true);
					if (overlay?.isConnected) {
						overlay.remove();
					}
					overlay = null;
				},
			};
		},
	});
})();

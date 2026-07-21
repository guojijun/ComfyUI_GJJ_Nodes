import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const PANEL_ID = "gjj-common-execution-timer";
const STYLE_ID = "gjj-common-execution-timer-style";
const COLLAPSED_KEY = "gjj_common_execution_timer_collapsed";
const NEWEST_FIRST_KEY = "gjj_common_execution_timer_newest_first";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const USER_SETTINGS_SECTION = "execution_timer";
const MAX_VISIBLE_ROWS = 80;
const REFRESH_MS = 250;
const MEMORY_REFRESH_MS = 500;

let currentRun = null;
let panel = null;
let refreshTimer = null;
let memoryTimer = null;
let memorySampleInFlight = false;
let lastMemorySampleAt = 0;
let panelClosedForRun = false;
let positionSaveTimer = null;
let positionLoaded = false;
let positionLoadPromise = null;
let panelHasCustomPosition = false;
let panelPositionTouched = false;
let newestFirst = localStorage.getItem(NEWEST_FIRST_KEY) === "1";

function nowMs() {
	return performance.now();
}

function formatElapsed(ms) {
	const value = Math.max(0, Number(ms || 0));
	if (value < 1000) return `${Math.round(value)}ms`;
	const seconds = value / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds - minutes * 60;
	return `${minutes}m ${rest.toFixed(1)}s`;
}

function percent(used, total) {
	const value = Number(total) > 0 ? (Number(used || 0) / Number(total)) * 100 : 0;
	return Math.max(0, Math.min(100, value));
}

function formatStatValue(value, unit = "GB") {
	const n = Number(value);
	if (!Number.isFinite(n)) return "--";
	return `${n.toFixed(n < 10 ? 2 : 1)}${unit || ""}`;
}

function emptyMemoryStats() {
	return {
		ram: { used: 0, total: 0, percent: 0, unit: "GB", label: "内存 RAM", detail: "等待数据" },
		vram: { used: 0, total: 0, percent: 0, unit: "GB", label: "显存 VRAM", detail: "等待数据" },
	};
}

function normalizeMemoryStats(payload = {}) {
	const stats = emptyMemoryStats();
	const memory = payload?.memory;
	if (memory && !memory.error) {
		const used = Number(memory.used || 0);
		const total = Number(memory.total || 0);
		const unit = String(memory.unit || "GB");
		stats.ram = {
			used,
			total,
			unit,
			percent: Number.isFinite(Number(memory.percent)) ? Number(memory.percent) : percent(used, total),
			label: "内存 RAM",
			detail: `已用 ${formatStatValue(used, unit)} / ${formatStatValue(total, unit)}`,
		};
	}
	const gpu = Array.isArray(payload?.gpu) ? payload.gpu : [];
	const firstGpu = gpu.find((item) => item && !item.error) || null;
	if (firstGpu) {
		const used = Number(firstGpu.used ?? firstGpu.memory_used ?? firstGpu.cached ?? firstGpu.allocated ?? 0);
		const total = Number(firstGpu.total || 0);
		const unit = String(firstGpu.unit || "GB");
		stats.vram = {
			used,
			total,
			unit,
			percent: Number.isFinite(Number(firstGpu.percent)) ? Number(firstGpu.percent) : percent(used, total),
			label: "显存 VRAM",
			detail: `已占 ${formatStatValue(used, unit)} / ${formatStatValue(total, unit)}${firstGpu.source ? ` · ${firstGpu.source}` : ""}`,
		};
	}
	return stats;
}

function peakText(stats) {
	if (!stats) return "内存峰值 -- · 显存峰值 --";
	const ram = stats.ram?.used > 0
		? `${formatStatValue(stats.ram.used, stats.ram.unit)} (${Math.round(stats.ram.percent)}%)`
		: "--";
	const vram = stats.vram?.used > 0
		? `${formatStatValue(stats.vram.used, stats.vram.unit)} (${Math.round(stats.vram.percent)}%)`
		: "--";
	return `内存峰值 ${ram} · 显存峰值 ${vram}`;
}

function inlinePeakText(stats) {
	const ram = stats?.ram?.used > 0 ? formatStatValue(stats.ram.used, stats.ram.unit) : "--";
	const vram = stats?.vram?.used > 0 ? formatStatValue(stats.vram.used, stats.vram.unit) : "--";
	return `🟢内存峰值:${ram} 🟣显存峰值:${vram}`;
}

function eventPromptId(event) {
	const detail = event?.detail || {};
	return detail?.prompt_id || detail?.promptId || detail?.prompt || null;
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !(promptId && currentRun?.promptId && promptId !== currentRun.promptId);
}

function nodeIdFromDetail(detail) {
	if (detail === null || detail === undefined || detail === false) return "";
	if (typeof detail === "string" || typeof detail === "number") return String(detail);
	return String(
		detail?.node_id
		?? detail?.display_node
		?? detail?.node
		?? detail?.nodeId
		?? detail?.id
		?? "",
	);
}

function eventNodeId(event) {
	return nodeIdFromDetail(event?.detail);
}

function cachedNodeIds(event) {
	const detail = event?.detail;
	const raw = Array.isArray(detail)
		? detail
		: (detail?.nodes || detail?.node_ids || detail?.cached_nodes || detail?.cached || []);
	return Array.isArray(raw)
		? raw.map((item) => nodeIdFromDetail(item)).filter(Boolean)
		: [];
}

function getNodeById(id) {
	const value = String(id || "");
	if (!value) return null;
	let node = null;
	try {
		node = app.graph?.getNodeById?.(Number(value)) || app.graph?.getNodeById?.(value) || null;
	} catch (_) {
		node = null;
	}
	return node || (app.graph?._nodes || []).find((item) => String(item?.id) === value) || null;
}

function focusNode(id) {
	const node = getNodeById(id);
	const canvas = app.canvas;
	if (!node || !canvas) return false;
	try { canvas.deselectAllNodes?.(); } catch (_) {}
	try { canvas.deselectAll?.(); } catch (_) {}
	try {
		for (const item of app.graph?._nodes || []) item.selected = false;
	} catch (_) {}
	node.selected = true;
	try { canvas.selectNode?.(node, false); } catch (_) {}
	try {
		canvas.selected_nodes = {};
		canvas.selected_nodes[node.id] = node;
		canvas.setSelectedNodes?.(canvas.selected_nodes);
	} catch (_) {}
	try { canvas.centerOnNode?.(node); } catch (_) {}
	try { canvas.focusOnNode?.(node); } catch (_) {}
	try { canvas.scrollToNode?.(node); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	return true;
}

function clampPanelPosition(left, top, root = panel) {
	const rect = root?.getBoundingClientRect?.();
	const width = Number(rect?.width || 380);
	const height = Number(rect?.height || 220);
	const margin = 8;
	return {
		left: Math.max(margin, Math.min(window.innerWidth - width - margin, Number(left) || margin)),
		top: Math.max(margin, Math.min(window.innerHeight - height - margin, Number(top) || margin)),
	};
}

function isLegacyTopLeftPosition(position) {
	const left = Number(position?.left);
	const top = Number(position?.top);
	return Number.isFinite(left) && Number.isFinite(top) && left <= 8 && top <= 8;
}

function resetPanelPosition(root) {
	if (!root) return;
	panelHasCustomPosition = false;
	root.style.left = "auto";
	root.style.top = "auto";
	root.style.right = "14px";
	root.style.bottom = "14px";
}

function applyPanelPosition(root, position) {
	if (!root || !position || typeof position !== "object") return;
	const left = Number(position.left);
	const top = Number(position.top);
	if (!Number.isFinite(left) || !Number.isFinite(top)) return;
	const next = clampPanelPosition(left, top, root);
	panelHasCustomPosition = true;
	root.style.left = `${next.left}px`;
	root.style.top = `${next.top}px`;
	root.style.right = "auto";
	root.style.bottom = "auto";
}

async function loadPanelPosition(root) {
	if (!root) return;
	if (positionLoadPromise) return positionLoadPromise;
	positionLoadPromise = (async () => {
		if (positionLoaded) return;
		positionLoaded = true;
		let loaded = false;
		try {
			const response = api?.fetchApi ? await api.fetchApi(USER_SETTINGS_ENDPOINT) : await fetch(USER_SETTINGS_ENDPOINT);
			const data = await response.json();
			const position = data?.settings?.[USER_SETTINGS_SECTION]?.position;
			if (!panelPositionTouched && position && !isLegacyTopLeftPosition(position)) {
				applyPanelPosition(root, position);
				loaded = true;
			}
		} catch (_) {}
		if (!loaded && !panelPositionTouched) resetPanelPosition(root);
	})();
	return positionLoadPromise;
}

async function savePanelPositionValue(root, position) {
	try {
		const body = JSON.stringify({ section: USER_SETTINGS_SECTION, values: { position } });
		const options = { method: "POST", headers: { "Content-Type": "application/json" }, body };
		const response = api?.fetchApi ? await api.fetchApi(USER_SETTINGS_ENDPOINT, options) : await fetch(USER_SETTINGS_ENDPOINT, options);
		if (!response?.ok) throw new Error("保存计时器位置失败");
	} catch (error) {
		console.warn("[GJJ ExecutionTimer] 保存位置失败", error);
	}
}

async function resetSavedPanelPosition(root) {
	clearTimeout(positionSaveTimer);
	panelPositionTouched = true;
	resetPanelPosition(root);
	await savePanelPositionValue(root, null);
}

async function savePanelPosition(root) {
	if (!root) return;
	await loadPanelPosition(root);
	const rect = root.getBoundingClientRect();
	const position = clampPanelPosition(rect.left, rect.top, root);
	applyPanelPosition(root, position);
	await savePanelPositionValue(root, position);
}

function schedulePositionSave(root) {
	clearTimeout(positionSaveTimer);
	positionSaveTimer = setTimeout(() => void savePanelPosition(root), 180);
}

function enablePanelDrag(root, handle) {
	if (!root || !handle || handle.__gjjTimerDragReady) return;
	handle.__gjjTimerDragReady = true;
	handle.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		root.__gjjTimerSuppressClickUntil = nowMs() + 350;
		void resetSavedPanelPosition(root);
	}, true);
	handle.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		if (event.detail > 1) return;
		panelPositionTouched = true;
		const rect = root.getBoundingClientRect();
		const start = {
			x: event.clientX,
			y: event.clientY,
			left: rect.left,
			top: rect.top,
		};
		let dragging = false;
		root.style.left = `${rect.left}px`;
		root.style.top = `${rect.top}px`;
		root.style.right = "auto";
		root.style.bottom = "auto";
		try { handle.setPointerCapture?.(event.pointerId); } catch (_) {}
		event.stopPropagation();

		const move = (moveEvent) => {
			const dx = moveEvent.clientX - start.x;
			const dy = moveEvent.clientY - start.y;
			if (!dragging && Math.hypot(dx, dy) < 4) return;
			dragging = true;
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const next = clampPanelPosition(
				start.left + dx,
				start.top + dy,
				root,
			);
			root.style.left = `${next.left}px`;
			root.style.top = `${next.top}px`;
			root.style.right = "auto";
			root.style.bottom = "auto";
		};
		const up = (upEvent) => {
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
			if (dragging) {
				upEvent?.preventDefault?.();
				upEvent?.stopPropagation?.();
				root.__gjjTimerSuppressClickUntil = nowMs() + 350;
				schedulePositionSave(root);
			}
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
	}, true);
}

function nodeLabel(id) {
	const node = getNodeById(id);
	const raw = (
		node?.title
		|| node?.properties?.title
		|| node?.properties?.["Node name for S&R"]
		|| node?.comfyClass
		|| node?.type
		|| `节点 ${id}`
	);
	return String(raw || `节点 ${id}`).replace(/\s+/g, " ").trim();
}

function detailText(detail) {
	if (!detail || typeof detail !== "object") return "";
	return String(
		detail?.exception_message
		?? detail?.message
		?? detail?.error
		?? detail?.details
		?? detail?.traceback
		?? "",
	).trim();
}

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		#${PANEL_ID} {
			position: fixed;
			right: 14px;
			bottom: 14px;
			z-index: 999999;
			width: min(380px, calc(100vw - 28px));
			max-height: min(520px, calc(100vh - 28px));
			display: none;
			flex-direction: column;
			border: 1px solid rgba(132, 164, 176, 0.36);
			border-radius: 8px;
			background: rgba(18, 24, 28, 0.96);
			color: #e7eef0;
			box-shadow: 0 12px 36px rgba(0, 0, 0, 0.32);
			font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			overflow: hidden;
			user-select: none;
		}
		#${PANEL_ID}.gjj-run-error {
			border-color: rgba(255, 84, 84, 0.88);
			box-shadow: 0 0 0 1px rgba(255, 84, 84, 0.42), 0 16px 44px rgba(255, 40, 40, 0.22), 0 12px 36px rgba(0, 0, 0, 0.32);
		}
		#${PANEL_ID}.gjj-run-error .gjj-exec-header {
			background: linear-gradient(90deg, rgba(120, 20, 28, 0.88), rgba(32, 20, 24, 0.94));
			border-bottom-color: rgba(255, 120, 120, 0.42);
		}
		#${PANEL_ID}.gjj-run-error .gjj-exec-title,
		#${PANEL_ID}.gjj-run-error .gjj-exec-summary {
			color: #fff4f4;
			font-weight: 800;
		}
		#${PANEL_ID}.gjj-collapsed .gjj-exec-body { display: none; }
		#${PANEL_ID} .gjj-exec-header {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 9px;
			border-bottom: 1px solid rgba(132, 164, 176, 0.18);
		}
		#${PANEL_ID}.gjj-collapsed .gjj-exec-header { border-bottom: 0; }
		#${PANEL_ID} .gjj-exec-drag {
			cursor: grab;
			touch-action: none;
			font-size: 15px;
			color: #aebfc5;
		}
		#${PANEL_ID} .gjj-exec-drag:active { cursor: grabbing; }
		#${PANEL_ID} .gjj-exec-title {
			font-weight: 700;
			white-space: nowrap;
		}
		#${PANEL_ID} .gjj-exec-summary {
			flex: 1;
			min-width: 0;
			color: #aebfc5;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#${PANEL_ID} button {
			width: 24px;
			height: 24px;
			border: 1px solid rgba(255, 255, 255, 0.16);
			border-radius: 6px;
			background: rgba(255, 255, 255, 0.08);
			color: #e7eef0;
			cursor: pointer;
			padding: 0;
			font-size: 14px;
			line-height: 22px;
		}
		#${PANEL_ID} button:hover { background: rgba(255, 255, 255, 0.16); }
		#${PANEL_ID} .gjj-exec-order.gjj-active {
			border-color: rgba(255, 196, 82, 0.72);
			background: rgba(255, 174, 46, 0.22);
			box-shadow: inset 0 0 0 1px rgba(255, 210, 118, 0.12);
		}
		#${PANEL_ID} .gjj-exec-body {
			display: flex;
			flex-direction: column;
			min-height: 0;
		}
		#${PANEL_ID} .gjj-exec-total {
			display: block;
			padding: 7px 9px;
			color: #d8e7eb;
			background: rgba(76, 211, 194, 0.09);
			border-bottom: 1px solid rgba(132, 164, 176, 0.14);
			font-variant-numeric: tabular-nums;
		}
		#${PANEL_ID} .gjj-exec-total-label {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#${PANEL_ID} .gjj-exec-memory {
			display: flex;
			flex-direction: column;
			gap: 4px;
			padding: 6px 9px 7px;
			background: rgba(10, 20, 24, 0.58);
			border-bottom: 1px solid rgba(132, 164, 176, 0.12);
		}
		#${PANEL_ID} .gjj-exec-memory-row {
			display: grid;
			grid-template-columns: 76px minmax(0, 1fr) 90px;
			align-items: center;
			gap: 7px;
			color: #bccbd1;
			font-size: 11px;
			line-height: 1;
		}
		#${PANEL_ID} .gjj-exec-memory-name {
			font-weight: 700;
			white-space: nowrap;
		}
		#${PANEL_ID} .gjj-exec-memory-track {
			height: 4px;
			border-radius: 999px;
			background: rgba(255, 255, 255, 0.08);
			overflow: hidden;
		}
		#${PANEL_ID} .gjj-exec-memory-fill {
			height: 100%;
			width: 0%;
			border-radius: inherit;
			transition: width 0.24s ease;
		}
		#${PANEL_ID} .gjj-ram .gjj-exec-memory-fill {
			background: linear-gradient(90deg, #24bd73, #63d991);
		}
		#${PANEL_ID} .gjj-vram .gjj-exec-memory-fill {
			background: linear-gradient(90deg, #6e85ff, #a875ff);
		}
		#${PANEL_ID} .gjj-exec-memory-value {
			text-align: right;
			white-space: nowrap;
			font-variant-numeric: tabular-nums;
			color: #d9e8ed;
		}
		#${PANEL_ID} .gjj-exec-list {
			overflow: auto;
			max-height: 390px;
		}
		#${PANEL_ID} .gjj-exec-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) 22px 70px 56px;
			align-items: center;
			gap: 7px;
			padding: 5px 9px;
			border-bottom: 1px solid rgba(132, 164, 176, 0.10);
		}
		#${PANEL_ID} .gjj-exec-row:last-child { border-bottom: 0; }
		#${PANEL_ID} .gjj-exec-row.gjj-running { background: rgba(94, 160, 255, 0.12); }
		#${PANEL_ID} .gjj-exec-row.gjj-error {
			background: linear-gradient(90deg, rgba(142, 24, 36, 0.58), rgba(64, 25, 29, 0.54));
			border-left: 4px solid #ff4d5a;
			box-shadow: inset 0 0 0 1px rgba(255, 105, 116, 0.28);
		}
		#${PANEL_ID} .gjj-exec-row.gjj-cached { opacity: 0.72; }
		#${PANEL_ID} .gjj-exec-name {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#${PANEL_ID} .gjj-exec-row.gjj-error .gjj-exec-name,
		#${PANEL_ID} .gjj-exec-row.gjj-error .gjj-exec-time,
		#${PANEL_ID} .gjj-exec-row.gjj-error .gjj-exec-state {
			color: #ffe8e8;
			font-weight: 700;
		}
		#${PANEL_ID} .gjj-exec-locate {
			width: 22px;
			height: 22px;
			border-color: rgba(100, 196, 255, 0.32);
			background: rgba(53, 95, 128, 0.28);
			font-size: 13px;
			line-height: 20px;
		}
		#${PANEL_ID} .gjj-exec-locate:hover {
			border-color: rgba(113, 214, 255, 0.72);
			background: rgba(44, 122, 170, 0.46);
		}
		#${PANEL_ID} .gjj-exec-row.gjj-error .gjj-exec-locate {
			border-color: rgba(255, 190, 100, 0.58);
			background: rgba(130, 48, 35, 0.46);
		}
		#${PANEL_ID} .gjj-exec-time {
			text-align: right;
			color: #d4e2e7;
			font-variant-numeric: tabular-nums;
		}
		#${PANEL_ID} .gjj-exec-state {
			text-align: right;
			color: #aebfc5;
			white-space: nowrap;
		}
	`;
	document.head.appendChild(style);
}

function button(label, title, onClick) {
	const element = document.createElement("button");
	element.type = "button";
	element.textContent = label;
	element.title = title;
	element.addEventListener("pointerdown", (event) => event.stopPropagation());
	element.addEventListener("mousedown", (event) => event.stopPropagation());
	element.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const root = element.closest?.(`#${PANEL_ID}`);
		if (Number(root?.__gjjTimerSuppressClickUntil || 0) > nowMs()) return;
		onClick?.();
	});
	return element;
}

function ensurePanel() {
	if (panel) return panel;
	ensureStyles();

	const root = document.createElement("div");
	root.id = PANEL_ID;

	const header = document.createElement("div");
	header.className = "gjj-exec-header";

	const dragHandle = document.createElement("button");
	dragHandle.type = "button";
	dragHandle.className = "gjj-exec-drag";
	dragHandle.textContent = "⠿";
	dragHandle.title = "拖动计时器面板";

	const title = document.createElement("div");
	title.className = "gjj-exec-title";
	title.textContent = "⏱️ GJJ计时器";

	const summary = document.createElement("div");
	summary.className = "gjj-exec-summary";
	summary.textContent = "等待执行";

	const order = button("⏰", "切换记录顺序", () => {
		newestFirst = !newestFirst;
		localStorage.setItem(NEWEST_FIRST_KEY, newestFirst ? "1" : "0");
		updateOrderButton(order);
		render();
	});
	order.classList.add("gjj-exec-order");
	updateOrderButton(order);
	const collapse = button("🔼", "收起/展开计时器", () => {
		root.classList.toggle("gjj-collapsed");
		localStorage.setItem(COLLAPSED_KEY, root.classList.contains("gjj-collapsed") ? "1" : "0");
		collapse.textContent = root.classList.contains("gjj-collapsed") ? "🔽" : "🔼";
	});
	const copy = button("📋", "复制本次耗时统计", () => copySummary());
	const clear = button("🧹", "清除本次计时结果", () => {
		stopRefresh();
		currentRun = null;
		panelClosedForRun = false;
		root.style.display = "none";
	});
	const close = button("✖", "关闭计时器", () => {
		stopRefresh();
		panelClosedForRun = true;
		root.style.display = "none";
	});

	header.append(dragHandle, title, summary, order, collapse, copy, clear, close);

	const body = document.createElement("div");
	body.className = "gjj-exec-body";
	const total = document.createElement("div");
	total.className = "gjj-exec-total";
	const totalLabel = document.createElement("div");
	totalLabel.className = "gjj-exec-total-label";
	totalLabel.textContent = "⏰耗时:0ms 🟢内存峰值:-- 🟣显存峰值:--";
	total.append(totalLabel);

	const memory = document.createElement("div");
	memory.className = "gjj-exec-memory";
	memory.innerHTML = `
		<div class="gjj-exec-memory-row gjj-ram">
			<div class="gjj-exec-memory-name">内存 RAM</div>
			<div class="gjj-exec-memory-track"><div class="gjj-exec-memory-fill"></div></div>
			<div class="gjj-exec-memory-value">--</div>
		</div>
		<div class="gjj-exec-memory-row gjj-vram">
			<div class="gjj-exec-memory-name">显存 VRAM</div>
			<div class="gjj-exec-memory-track"><div class="gjj-exec-memory-fill"></div></div>
			<div class="gjj-exec-memory-value">--</div>
		</div>
	`;

	const list = document.createElement("div");
	list.className = "gjj-exec-list";
	body.append(total, memory, list);
	root.append(header, body);

	root.__gjjTimer = { summary, totalLabel, memory, list, order, collapse };
	if (localStorage.getItem(COLLAPSED_KEY) === "1") {
		root.classList.add("gjj-collapsed");
		collapse.textContent = "🔽";
	}
	resetPanelPosition(root);
	enablePanelDrag(root, dragHandle);

	document.body.appendChild(root);
	panel = root;
	void loadPanelPosition(root);
	return panel;
}

function statusLabel(status) {
	if (status === "running") return "🔵 运行中";
	if (status === "cached") return "💾 缓存";
	if (status === "error") return "🚨 错误";
	if (status === "interrupted") return "⛔ 中断";
	return "✅ 完成";
}

function runLabel(status) {
	if (status === "running") return "🔵 运行中";
	if (status === "error") return "🚨 执行出错";
	if (status === "interrupted") return "⛔ 已中断";
	return "✅ 执行完成";
}

function rowDuration(row, now = nowMs()) {
	const active = row.startedAt ? now - row.startedAt : 0;
	return Math.max(0, Number(row.duration || 0) + active);
}

function updateOrderButton(orderButton) {
	if (!orderButton) return;
	orderButton.classList.toggle("gjj-active", newestFirst);
	orderButton.title = newestFirst
		? "当前：最新记录在上；点击切换为最新记录在下"
		: "当前：最新记录在下；点击切换为最新记录在上";
}

function visibleRows() {
	if (!currentRun) return [];
	const rows = Array.from(currentRun.rows.values())
		.sort((a, b) => a.order - b.order)
		.slice(-MAX_VISIBLE_ROWS);
	return newestFirst ? rows.reverse() : rows;
}

function updatePeakStats(sample) {
	if (!currentRun || !sample) return;
	for (const key of ["ram", "vram"]) {
		const value = sample[key];
		if (!value || !Number.isFinite(Number(value.used))) continue;
		const old = currentRun.memoryPeak?.[key];
		if (!old || Number(value.used) > Number(old.used || 0)) {
			currentRun.memoryPeak[key] = { ...value };
		}
	}
}

function updateMemoryDom(state, sample) {
	if (!state?.memory) return;
	const stats = sample || currentRun?.memoryCurrent || emptyMemoryStats();
	for (const [key, cls] of [["ram", ".gjj-ram"], ["vram", ".gjj-vram"]]) {
		const row = state.memory.querySelector(cls);
		const item = stats[key];
		if (!row || !item) continue;
		const fill = row.querySelector(".gjj-exec-memory-fill");
		const value = row.querySelector(".gjj-exec-memory-value");
		const p = Math.max(0, Math.min(100, Number(item.percent || 0)));
		if (fill) fill.style.width = `${p}%`;
		if (value) {
			value.textContent = item.used > 0
				? `${p.toFixed(1)}%`
				: "--";
			value.title = item.detail || "";
		}
	}
}

async function fetchMemorySample() {
	const fetcher = api?.fetchApi ? api.fetchApi.bind(api) : fetch;
	const response = await fetcher(`/gjj_memory_manager/stats?node=timer&t=${Date.now()}`);
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}
	return normalizeMemoryStats(await response.json());
}

async function sampleMemory(force = false) {
	if (!currentRun || memorySampleInFlight) return;
	const at = nowMs();
	if (!force && at - lastMemorySampleAt < MEMORY_REFRESH_MS) return;
	lastMemorySampleAt = at;
	memorySampleInFlight = true;
	try {
		const sample = await fetchMemorySample();
		if (!currentRun) return;
		currentRun.memoryCurrent = sample;
		updatePeakStats(sample);
		updateMemoryDom(ensurePanel().__gjjTimer, sample);
		if (currentRun.finishedAt) {
			render();
		}
	} catch (_) {
		// 计时器保持静默降级；没有 MemoryManager 后端时只是不显示资源条数据。
	} finally {
		memorySampleInFlight = false;
	}
}

function applyMemoryPayload(payload) {
	if (!currentRun) return;
	const sample = normalizeMemoryStats(payload);
	currentRun.memoryCurrent = sample;
	updatePeakStats(sample);
	updateMemoryDom(ensurePanel().__gjjTimer, sample);
	if (currentRun.finishedAt) {
		render();
	}
}

function render() {
	const root = ensurePanel();
	const state = root.__gjjTimer;
	if (!currentRun) {
		root.classList.remove("gjj-run-error");
		root.style.display = "none";
		return;
	}
	if (panelClosedForRun) {
		root.style.display = "none";
		return;
	}

	root.style.display = "flex";
	root.classList.toggle("gjj-run-error", currentRun.status === "error");
	const now = nowMs();
	const total = (currentRun.finishedAt || now) - currentRun.startedAt;
	const rows = visibleRows();
	state.summary.textContent = `${runLabel(currentRun.status)} · ${rows.length} 个节点 · 总耗时 ${formatElapsed(total)}`;
	const totalLabel = `⏰耗时:${formatElapsed(total)} ${inlinePeakText(currentRun.memoryPeak)}`;
	state.totalLabel.textContent = totalLabel;
	state.totalLabel.title = currentRun.finishedAt ? `工作流 ${peakText(currentRun.memoryPeak)}` : "";
	updateMemoryDom(state, currentRun.memoryCurrent);
	state.list.replaceChildren();

	for (const row of rows) {
		const item = document.createElement("div");
		item.className = `gjj-exec-row gjj-${row.status || "done"}`;
		const name = document.createElement("div");
		name.className = "gjj-exec-name";
		name.textContent = `${row.label} #${row.id}`;
		name.title = row.errorText ? `${name.textContent}\n${row.errorText}` : name.textContent;
		const locate = button("📍", `定位到节点：${row.label} #${row.id}`, () => focusNode(row.id));
		locate.className = "gjj-exec-locate";
		const time = document.createElement("div");
		time.className = "gjj-exec-time";
		time.textContent = formatElapsed(rowDuration(row, now));
		const status = document.createElement("div");
		status.className = "gjj-exec-state";
		status.textContent = statusLabel(row.status);
		status.title = row.errorText || status.textContent;
		item.append(name, locate, time, status);
		state.list.appendChild(item);
	}
}

function startRefresh() {
	stopRefresh();
	refreshTimer = setInterval(render, REFRESH_MS);
	memoryTimer = setInterval(() => void sampleMemory(false), MEMORY_REFRESH_MS);
	void sampleMemory(true);
}

function stopRefresh() {
	if (refreshTimer) clearInterval(refreshTimer);
	refreshTimer = null;
	if (memoryTimer) clearInterval(memoryTimer);
	memoryTimer = null;
}

function ensureRow(id) {
	if (!currentRun || !id) return null;
	const key = String(id);
	let row = currentRun.rows.get(key);
	if (!row) {
		row = {
			id: key,
			label: nodeLabel(key),
			order: currentRun.nextOrder++,
			duration: 0,
			startedAt: 0,
			status: "done",
			errorText: "",
		};
		currentRun.rows.set(key, row);
	}
	return row;
}

function finishActive(status = "done", at = nowMs(), errorText = "") {
	if (!currentRun?.activeId) return;
	finishNode(currentRun.activeId, status, at, errorText);
	currentRun.activeId = "";
}

function finishNode(id, status = "done", at = nowMs(), errorText = "") {
	const row = ensureRow(id);
	if (!row) return;
	if (row.startedAt) {
		row.duration += Math.max(0, at - row.startedAt);
		row.startedAt = 0;
	}
	row.status = status;
	if (status === "error") {
		row.errorText = errorText || row.errorText || "执行出错";
	} else if (status === "running") {
		row.errorText = "";
	}
	render();
}

function startNode(id, at = nowMs()) {
	if (!currentRun?.startedAt || currentRun.status !== "running") return;
	const key = String(id || "");
	if (!key) {
		finishActive("done", at);
		render();
		return;
	}
	if (currentRun.activeId && currentRun.activeId !== key) {
		finishActive("done", at);
	}
	const row = ensureRow(key);
	if (!row) return;
	row.label = nodeLabel(key);
	row.status = "running";
	row.errorText = "";
	if (!row.startedAt) row.startedAt = at;
	currentRun.activeId = key;
	render();
}

function startRun(event) {
	stopRefresh();
	panelClosedForRun = false;
	currentRun = {
		promptId: eventPromptId(event),
		startedAt: nowMs(),
		finishedAt: 0,
		status: "running",
		activeId: "",
		nextOrder: 1,
		rows: new Map(),
		memoryCurrent: emptyMemoryStats(),
		memoryPeak: emptyMemoryStats(),
	};
	ensurePanel();
	render();
	startRefresh();
}

function finishRun(status, event) {
	if (!currentRun || !samePrompt(event)) return;
	const at = nowMs();
	const errorNode = eventNodeId(event);
	const errorText = status === "error" ? detailText(event?.detail) : "";
	if (errorNode) {
		finishNode(errorNode, status === "error" ? "error" : "done", at, errorText);
	}
	finishActive(status === "interrupted" ? "interrupted" : status === "error" ? "error" : "done", at, errorText);
	currentRun.status = status;
	currentRun.finishedAt = at;
	void sampleMemory(true);
	stopRefresh();
	render();
}

function markCached(event) {
	if (!currentRun || !samePrompt(event)) return;
	for (const id of cachedNodeIds(event)) {
		const row = ensureRow(id);
		if (!row || row.startedAt) continue;
		row.label = nodeLabel(id);
		row.status = "cached";
		row.errorText = "";
		row.duration = 0;
	}
	render();
}

function summaryText() {
	if (!currentRun) return "";
	const total = (currentRun.finishedAt || nowMs()) - currentRun.startedAt;
	const lines = [`GJJ计时器：${runLabel(currentRun.status)}，总耗时 ${formatElapsed(total)}，工作流 ${peakText(currentRun.memoryPeak)}`];
	for (const row of visibleRows()) {
		lines.push(`${row.label} #${row.id}：${formatElapsed(rowDuration(row))}，${statusLabel(row.status)}`);
	}
	return lines.join("\n");
}

async function copySummary() {
	const text = summaryText();
	if (!text) return;
	try {
		await navigator.clipboard?.writeText(text);
	} catch (_) {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.left = "-9999px";
		document.body.appendChild(area);
		area.select();
		try { document.execCommand("copy"); } catch (_) {}
		area.remove();
	}
}

function setupListeners() {
	if (globalThis.__gjjCommonExecutionTimerReady) return;
	globalThis.__gjjCommonExecutionTimerReady = true;

	api.addEventListener("execution_start", (event) => startRun(event));
	api.addEventListener("execution_cached", (event) => markCached(event));
	api.addEventListener("executing", (event) => {
		if (!currentRun || !samePrompt(event)) return;
		startNode(nodeIdFromDetail(event?.detail));
	});
	api.addEventListener("executed", (event) => {
		if (!currentRun || !samePrompt(event)) return;
		const id = eventNodeId(event);
		if (id) finishNode(id, "done");
		if (currentRun.activeId === id) currentRun.activeId = "";
	});
	api.addEventListener("execution_success", (event) => finishRun("success", event));
	api.addEventListener("execution_error", (event) => finishRun("error", event));
	api.addEventListener("execution_interrupted", (event) => finishRun("interrupted", event));
	api.addEventListener("gjj_memory_manager_stats", (event) => applyMemoryPayload(event?.detail || {}));
	window.addEventListener("resize", () => {
		if (!panel || !panelHasCustomPosition) return;
		const rect = panel.getBoundingClientRect();
		applyPanelPosition(panel, { left: rect.left, top: rect.top });
		schedulePositionSave(panel);
	});
}

app.registerExtension({
	name: "GJJ.Common.ExecutionTimer",
	setup() {
		ensurePanel();
		setupListeners();
	},
});

globalThis.GJJ_CommonExecutionTimer = {
	show: () => {
		ensurePanel().style.display = "flex";
		render();
	},
	hide: () => {
		ensurePanel().style.display = "none";
	},
	reset: () => {
		stopRefresh();
		currentRun = null;
		render();
	},
	getCurrentRun: () => currentRun,
	copySummary,
};

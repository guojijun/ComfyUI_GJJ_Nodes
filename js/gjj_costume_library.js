import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.CostumeLibrary";
	const TOOLBAR_ID = "gjj-workflow-screenshot-toolbar";
	const SCENE_BUTTON_ID = "gjj-scene-library-button";
	const CHARACTER_BUTTON_ID = "gjj-character-library-button";
	const COLOR_BUTTON_ID = "gjj-workflow-node-color-button";
	const BUTTON_ID = "gjj-costume-library-button";
	const PANEL_ID = "gjj-costume-library-panel";
	const STYLE_ID = "gjj-costume-library-style";
	const ENDPOINT = "/gjj/costume_library";
	const SHARED_PANEL_LAYOUT_KEY = "gjj.libraryPanel.layout";
	const AUTO_ANNOTATE_STORAGE_KEY = "gjj.costumeLibrary.autoAnnotate";
	const CATEGORY_LABELS = { clothing: "服装", prop: "道具" };

	let state = {
		items: [],
		tags: [],
		selectedId: "",
		search: "",
		category: "all",
		tag: "",
		sort: "updated_desc",
		page: 1,
		pageSize: 15,
		pageCount: 1,
		status: "",
		annotating: false,
		annotateNodeId: "",
		annotateButtons: new Set(),
		autoAnnotate: localStorage.getItem(AUTO_ANNOTATE_STORAGE_KEY) !== "false",
		panelPosition: null,
		panelSize: null,
		lastAnchor: null,
		lastTextTarget: null,
	};

	function apiUrl(path) {
		return api?.apiURL ? api.apiURL(path) : path;
	}

	function loadSharedPanelLayout() {
		try {
			const data = JSON.parse(localStorage.getItem(SHARED_PANEL_LAYOUT_KEY) || "{}");
			if (data.position) state.panelPosition = data.position;
			if (data.size) state.panelSize = data.size;
		} catch (_) {}
	}

	function saveSharedPanelLayout() {
		try {
			localStorage.setItem(SHARED_PANEL_LAYOUT_KEY, JSON.stringify({
				position: state.panelPosition,
				size: state.panelSize,
			}));
		} catch (_) {}
	}

	async function apiJson(path, options = {}) {
		const response = api?.fetchApi ? await api.fetchApi(path, options) : await fetch(apiUrl(path), options);
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data?.ok === false) throw new Error(data?.error || `请求失败：${response.status}`);
		return data;
	}

	function stop(event) {
		event?.preventDefault?.();
		event?.stopImmediatePropagation?.();
		event?.stopPropagation?.();
	}

	function dirtyCanvas() {
		try { app?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
		try { app?.canvas?.setDirty?.(true, true); } catch (_) {}
	}

	function button(text, title, className, onClick) {
		const el = document.createElement("button");
		el.type = "button";
		el.className = className || "gjj-ct-btn";
		el.textContent = text;
		el.title = title || text;
		el.addEventListener("pointerdown", () => rememberActiveTextTarget(), true);
		el.addEventListener("click", (event) => {
			stop(event);
			onClick?.(event);
		});
		return el;
	}

	function rememberActiveTextTarget() {
		const target = document.activeElement;
		if (target && ("value" in target) && typeof target.setRangeText === "function") {
			state.lastTextTarget = target;
		}
	}

	function copyText(text) {
		if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
		const area = document.createElement("textarea");
		area.value = text;
		document.body.appendChild(area);
		area.select();
		document.execCommand("copy");
		area.remove();
		return Promise.resolve();
	}

	function insertAtRememberedText(text) {
		const target = state.lastTextTarget;
		if (!target || !("value" in target) || typeof target.setRangeText !== "function") return false;
		try {
			const start = target.selectionStart ?? target.value.length;
			const end = target.selectionEnd ?? target.value.length;
			target.setRangeText(text, start, end, "end");
			target.dispatchEvent(new Event("input", { bubbles: true }));
			target.dispatchEvent(new Event("change", { bubbles: true }));
			target.focus?.();
			return true;
		} catch (_) {
			return false;
		}
	}

	function flashButton(buttonEl, text) {
		if (!buttonEl) return;
		const oldText = buttonEl.textContent;
		buttonEl.textContent = text;
		buttonEl.classList.add("flash");
		setTimeout(() => {
			buttonEl.textContent = oldText;
			buttonEl.classList.remove("flash");
		}, 900);
	}

	function installStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
#${BUTTON_ID}{width:34px;height:34px;padding:0;border:1px solid rgba(117,137,148,.5);border-radius:8px;background:rgba(28,32,36,.92);color:#f2f6f4;font:19px/32px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;cursor:pointer;box-sizing:border-box;pointer-events:auto;box-shadow:0 4px 14px rgba(0,0,0,.28);transition:border-color .16s ease,background .16s ease;}
#${BUTTON_ID}:hover,#${BUTTON_ID}.active{border-color:rgba(229,178,91,.92);background:rgba(67,48,25,.96);}
#${PANEL_ID}{position:fixed;z-index:100000;width:min(920px,calc(100vw - 20px));height:min(680px,calc(100vh - 20px));min-width:min(560px,calc(100vw - 20px));min-height:min(420px,calc(100vh - 20px));max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);resize:both;display:none;grid-template-columns:minmax(260px,320px) 1fr;border:1px solid #4d5044;border-radius:8px;background:#151611;color:#f0efe5;box-shadow:0 18px 46px rgba(0,0,0,.54);font-family:system-ui,"Microsoft YaHei",sans-serif;overflow:auto;}
#${PANEL_ID}.open{display:grid;}
.gjj-ct-sidebar{min-width:0;min-height:0;border-right:1px solid #33372d;background:#191a15;display:flex;flex-direction:column;}
.gjj-ct-main{min-width:0;min-height:0;display:flex;flex-direction:column;background:#10120f;}
.gjj-ct-head{display:flex;align-items:center;gap:6px;min-height:42px;padding:7px 8px;border-bottom:1px solid #33372d;}
.gjj-ct-drag{width:24px;height:28px;flex:0 0 24px;border:1px solid #565642;border-radius:6px;background:#25251c;color:#beb99f;font-size:17px;line-height:22px;cursor:grab;padding:0;display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;}
.gjj-ct-title{font-size:14px;font-weight:800;color:#fff8de;white-space:nowrap;}
.gjj-ct-spacer{flex:1 1 auto;}
.gjj-ct-btn{height:28px;border:1px solid #565642;border-radius:6px;background:#25251c;color:#eee9cf;font-size:12px;font-weight:700;cursor:pointer;padding:0 9px;white-space:nowrap;}
.gjj-ct-btn:hover{background:#343222;border-color:#d0aa65;}
.gjj-ct-btn.flash{border-color:#76e0b2;background:#1f6a50;color:#f1fff8;box-shadow:0 0 0 2px rgba(118,224,178,.18);}
.gjj-ct-btn.danger:hover{background:#4a2028;border-color:#d76f7b;}
.gjj-ct-icon{width:28px;padding:0;font-size:15px;}
.gjj-ct-annotate-toggle{width:28px;padding:0;font-size:15px;}
.gjj-ct-annotate-toggle.is-on{border-color:#64d2aa;background:#176246;color:#ecfff6;box-shadow:inset 0 0 0 1px rgba(170,255,220,.16);}
.gjj-ct-annotate-toggle.is-on:hover{background:#1d7555;border-color:#8af0c6;}
.gjj-ct-annotate-toggle.is-off{border-color:#6c5358;background:#3a252b;color:#ffd9df;box-shadow:inset 0 0 0 1px rgba(255,190,202,.12);}
.gjj-ct-annotate-toggle.is-off:hover{background:#4a2b34;border-color:#d98a99;}
.gjj-ct-annotate-toggle:disabled{width:auto;min-width:44px;padding:0 8px;}
.gjj-ct-search{height:30px;margin:8px 8px 6px;border:1px solid #565642;border-radius:6px;background:#0b0d0b;color:#eee9cf;padding:0 9px;font-size:12px;outline:none;}
.gjj-ct-tools{display:flex;align-items:center;gap:6px;padding:0 8px 7px;overflow-x:auto;scrollbar-width:thin;scrollbar-color:#4d4a35 #171812;}
.gjj-ct-tagbox{align-items:flex-start;flex-wrap:wrap;overflow:visible;max-height:96px;overflow-y:auto;padding-bottom:8px;}
.gjj-ct-filter,.gjj-ct-sort,.gjj-ct-tag{height:26px;min-width:34px;border:1px solid #565642;border-radius:6px;background:#25251c;color:#eee9cf;font-size:12px;font-weight:700;cursor:pointer;padding:0 8px;white-space:nowrap;}
.gjj-ct-filter:hover,.gjj-ct-sort:hover,.gjj-ct-tag:hover{background:#343222;border-color:#d0aa65;}
.gjj-ct-filter.active,.gjj-ct-sort.active,.gjj-ct-tag.active{background:#6b4a18;border-color:#e5b25b;color:#fff7dc;}
.gjj-ct-divider{width:1px;height:18px;background:#46422f;flex:0 0 auto;}
.gjj-ct-list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 8px 8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));align-content:start;gap:6px;scrollbar-width:thin;scrollbar-color:#4d4a35 #171812;}
.gjj-ct-card{min-width:0;border:1px solid #34372d;border-radius:8px;background:#1f211a;color:#eee9cf;padding:4px;cursor:pointer;text-align:left;}
.gjj-ct-card:hover,.gjj-ct-card.active{border-color:#e5b25b;background:#2f2918;}
.gjj-ct-cover{height:68px;border-radius:6px;background:#0b0d0b;display:flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:3px;}
.gjj-ct-cover img{max-width:100%;max-height:100%;object-fit:contain;}
.gjj-ct-empty-cover{font-size:30px;opacity:.7;}
.gjj-ct-name{font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-ct-meta{font-size:10px;color:#b5ad8d;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-ct-pager{display:flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:5px 8px 7px;border-top:1px solid #33372d;}
.gjj-ct-page-label{min-width:64px;text-align:center;font-size:11px;color:#b5ad8d;font-weight:700;}
.gjj-ct-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:#565642 #171812;}
.gjj-ct-form{display:grid;grid-template-columns:minmax(150px,1fr) 88px auto auto;gap:7px;align-items:center;}
.gjj-ct-input,.gjj-ct-select{height:30px;border:1px solid #565642;border-radius:6px;background:#0b0d0b;color:#eee9cf;padding:0 9px;font-size:12px;outline:none;min-width:0;}
.gjj-ct-textarea{min-height:58px;resize:vertical;border:1px solid #565642;border-radius:6px;background:#0b0d0b;color:#eee9cf;padding:7px 9px;font-size:12px;outline:none;grid-column:1 / -1;}
.gjj-ct-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.gjj-ct-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.gjj-ct-pill{border:1px solid #5d573d;border-radius:999px;background:#25251c;color:#efe4be;padding:3px 8px;font-size:11px;font-weight:700;}
.gjj-ct-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:9px;}
.gjj-ct-asset{border:1px solid #34372d;border-radius:8px;background:#1b1d17;padding:6px;display:flex;flex-direction:column;gap:4px;min-width:0;}
.gjj-ct-asset-preview{height:142px;border-radius:6px;background-image:linear-gradient(45deg,#0b0d0b 25%,#151811 25%,#151811 50%,#0b0d0b 50%,#0b0d0b 75%,#151811 75%);background-size:18px 18px;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.gjj-ct-asset-preview img{max-width:100%;max-height:100%;object-fit:contain;}
.gjj-ct-empty{height:100%;display:flex;align-items:center;justify-content:center;color:#aaa383;font-size:13px;text-align:center;padding:20px;}
.gjj-ct-status{font-size:12px;color:#b5ad8d;min-height:18px;}
.gjj-ct-model-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.46);display:flex;align-items:center;justify-content:center;padding:18px;z-index:2;}
.gjj-ct-model-dialog{width:min(620px,100%);max-height:100%;overflow:auto;border:1px solid #565642;border-radius:8px;background:#151611;color:#eee9cf;box-shadow:0 18px 48px rgba(0,0,0,.56);}
.gjj-ct-model-head{display:flex;align-items:center;gap:8px;min-height:38px;padding:8px 10px;border-bottom:1px solid #33372d;}
.gjj-ct-model-body{display:flex;flex-direction:column;gap:10px;padding:10px;}
.gjj-ct-model-group{border:1px solid #34372d;border-radius:8px;background:#1b1d17;padding:8px;}
.gjj-ct-model-tree{margin:0;white-space:pre-wrap;color:#eee9cf;font-family:Consolas,"Microsoft YaHei",monospace;font-size:12px;line-height:1.55;}
`;
		document.head.appendChild(style);
	}

	function selectedItem() {
		return state.items.find((item) => item.id === state.selectedId) || state.items[0] || null;
	}

	function setStatus(text) {
		state.status = String(text || "");
		const el = document.querySelector(`#${PANEL_ID} .gjj-ct-status`);
		if (el) el.textContent = state.status;
	}

	function baseNameFromFile(file, fallback = "服化道") {
		return String(file?.name || fallback).replace(/\.[^.]+$/, "").trim() || fallback;
	}

	function formatBytes(value) {
		const size = Number(value || 0);
		if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
		if (size >= 1024) return `${Math.round(size / 1024)} KB`;
		return `${size} B`;
	}

	function updateAnnotateButton(btn) {
		if (!btn) return;
		btn.textContent = state.annotating ? "..." : "🧠";
		btn.disabled = !!state.annotating;
		btn.classList.toggle("active", !!state.autoAnnotate);
		btn.classList.toggle("is-on", !!state.autoAnnotate && !state.annotating);
		btn.classList.toggle("is-off", !state.autoAnnotate && !state.annotating);
		btn.setAttribute("aria-pressed", state.autoAnnotate ? "true" : "false");
		btn.title = state.annotating
			? "正在自动打标..."
			: (state.autoAnnotate
				? `导入后自动打标：已开启；单击执行${btn.dataset.annotateScope || "服装"}打标，双击关闭`
				: `导入后自动打标：已关闭；单击执行${btn.dataset.annotateScope || "服装"}打标，双击开启`);
	}

	function refreshAnnotateButtons() {
		for (const btn of state.annotateButtons) {
			if (!btn?.isConnected) {
				state.annotateButtons.delete(btn);
				continue;
			}
			updateAnnotateButton(btn);
		}
	}

	function annotateButton(ids = [], scopeLabel = "服装") {
		let clickTimer = 0;
		const runNow = () => {
			window.clearTimeout(clickTimer);
			clickTimer = 0;
			annotateMissingCostumes(ids).catch((error) => setStatus(error.message));
		};
		const toggle = () => {
			window.clearTimeout(clickTimer);
			clickTimer = 0;
			state.autoAnnotate = !state.autoAnnotate;
			try { localStorage.setItem(AUTO_ANNOTATE_STORAGE_KEY, state.autoAnnotate ? "true" : "false"); } catch (_) {}
			refreshAnnotateButtons();
			setStatus(state.autoAnnotate ? "已开启导入后自动打标" : "已关闭导入后自动打标");
		};
		const btn = button("🧠", "", "gjj-ct-btn gjj-ct-icon gjj-ct-annotate-toggle", (event) => {
			if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
				toggle();
				return;
			}
			window.clearTimeout(clickTimer);
			clickTimer = window.setTimeout(runNow, 240);
		});
		btn.addEventListener("dblclick", (event) => {
			stop(event);
			toggle();
		});
		btn.dataset.annotateScope = scopeLabel;
		state.annotateButtons.add(btn);
		updateAnnotateButton(btn);
		return btn;
	}

	function fileInput(accept = "image/*", multiple = false) {
		return new Promise((resolve) => {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = accept;
			input.multiple = multiple;
			input.addEventListener("change", () => resolve(Array.from(input.files || [])));
			input.click();
		});
	}

	async function refreshItems(keepSelection = true) {
		const params = new URLSearchParams({
			page: String(state.page),
			page_size: String(state.pageSize),
			search: state.search || "",
			category: state.category || "all",
			tag: state.tag || "",
			sort: state.sort || "updated_desc",
		});
		const data = await apiJson(`${ENDPOINT}/list?${params.toString()}`);
		const previous = keepSelection ? state.selectedId : "";
		state.items = Array.isArray(data.items) ? data.items : [];
		state.tags = Array.isArray(data.tags) ? data.tags : [];
		state.page = Math.max(1, Number(data.page || state.page || 1));
		state.pageSize = Math.max(1, Number(data.page_size || state.pageSize || 15));
		state.pageCount = Math.max(1, Number(data.page_count || 1));
		state.selectedId = state.items.some((item) => item.id === previous) ? previous : (state.items[0]?.id || "");
		renderPanel();
		return state.items;
	}

	async function createItem(category = "clothing") {
		const files = await fileInput("image/*", true);
		if (!files?.length) return;
		state.selectedId = "";
		await uploadFilesAsAssets(files, null, category);
	}

	async function saveItemFromForm() {
		const panel = document.getElementById(PANEL_ID);
		const selected = selectedItem();
		const name = panel?.querySelector("[data-ct-name]")?.value || selected?.name || "新服化道";
		const category = panel?.querySelector("[data-ct-category]")?.value || selected?.category || "clothing";
		const tags = panel?.querySelector("[data-ct-tags]")?.value || "";
		const notes = panel?.querySelector("[data-ct-notes]")?.value || "";
		const data = await apiJson(`${ENDPOINT}/item`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: selected?.id || name, name, category, tags, notes, sync_id: true }),
		});
		state.selectedId = data.item?.id || selected?.id || "";
		await refreshItems(true);
		setStatus("服化道信息已保存");
	}

	async function deleteItem(item) {
		if (!item) return;
		await apiJson(`${ENDPOINT}/item?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
		state.selectedId = "";
		await refreshItems(false);
		setStatus("服化道条目已删除");
	}

	async function uploadFilesAsAssets(files, item = undefined, forcedCategory = "") {
		let target = item === undefined ? selectedItem() : item;
		const category = forcedCategory || target?.category || (state.category === "prop" ? "prop" : "clothing");
		setStatus(category === "clothing" ? "正在导入并抠取服装..." : "正在导入素材...");
		const importedIds = [];
		for (const file of files) {
			const form = new FormData();
			const perFileItem = forcedCategory === "clothing" ? null : target;
			if (perFileItem?.id) form.append("id", perFileItem.id);
			form.append("name", perFileItem?.name || baseNameFromFile(file));
			form.append("category", category);
			form.append("label", baseNameFromFile(file, "素材"));
			form.append("file", file, file.name);
			const data = await apiJson(`${ENDPOINT}/asset`, { method: "POST", body: form });
			target = forcedCategory === "clothing" ? null : (data.item || target);
			if (data.item?.id) importedIds.push(data.item.id);
			state.selectedId = target?.id || state.selectedId;
			if (forcedCategory === "clothing" && data.item?.id) state.selectedId = data.item.id;
		}
		if (importedIds.length && category === "clothing" && state.autoAnnotate) {
			setStatus("正在用 🧠 给新服装自动打标...");
			await annotateMissingCostumes(importedIds);
			return;
		}
		await refreshItems(true);
		setStatus(category === "clothing" && !state.autoAnnotate ? `已导入 ${files.length} 个服装；自动打标已关闭` : `已导入 ${files.length} 个素材`);
	}

	async function uploadAssets(item = null) {
		const files = await fileInput("image/*", true);
		if (!files?.length) return;
		await uploadFilesAsAssets(files, item);
	}

	async function annotateMissingCostumes(ids = []) {
		if (state.annotating) return;
		state.annotating = true;
		state.annotateNodeId = `gjj_costume_annotate_${Date.now()}`;
		refreshAnnotateButtons();
		try {
			const targetIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
			const data = await apiJson(`${ENDPOINT}/annotate_missing`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ids: targetIds, unique_id: state.annotateNodeId }),
			});
			await refreshItems(true);
			const done = Number(data.processed_count || 0);
			const skipped = Number(data.skipped_count || 0);
			setStatus(done ? `🧠 已完成 ${done} 个服装打标${skipped ? `，跳过 ${skipped} 个` : ""}` : `没有需要打标的服装${skipped ? `，跳过 ${skipped} 个` : ""}`);
		} finally {
			state.annotating = false;
			state.annotateNodeId = "";
			refreshAnnotateButtons();
		}
	}

	function itemReferenceText(item) {
		const prefix = item?.category === "prop" ? "道具" : "服装";
		const name = String(item?.name || item?.id || "").trim();
		return name ? `[${prefix}:${name}]` : "";
	}

	async function copyOrInsertItemReference(item, buttonEl = null) {
		const text = itemReferenceText(item);
		if (!text) {
			setStatus("当前服化道条目没有可引用名称");
			return;
		}
		if (insertAtRememberedText(text)) {
			flashButton(buttonEl, "已插入");
			setStatus(`已插入引用：${text}`);
			return;
		}
		await copyText(text);
		flashButton(buttonEl, "已复制");
		setStatus(`已复制引用：${text}`);
	}

	function modelTreeParts(path) {
		const parts = String(path || "").replace(/\\/g, "/").split("/").map((item) => item.trim()).filter(Boolean);
		const modelsIndex = parts.findIndex((item) => item.toLowerCase() === "models");
		return modelsIndex >= 0 ? parts.slice(modelsIndex) : parts;
	}

	function buildModelTreeText(items = []) {
		return ["ComfyUI/", ...items.map((item) => `└──${item?.folder ? "📁 " : "🧠 "}${modelTreeParts(item?.path || item).join("/")}`)].join("\n");
	}

	async function showModelTree() {
		const data = await apiJson(`${ENDPOINT}/model_tree`);
		const panel = buildPanel();
		panel.querySelector(".gjj-ct-model-backdrop")?.remove();
		const backdrop = document.createElement("div");
		backdrop.className = "gjj-ct-model-backdrop";
		const dialog = document.createElement("div");
		dialog.className = "gjj-ct-model-dialog";
		const head = document.createElement("div");
		head.className = "gjj-ct-model-head";
		const title = document.createElement("div");
		title.className = "gjj-ct-title";
		title.textContent = data.title || "服化道存储目录树";
		const spacer = document.createElement("div");
		spacer.className = "gjj-ct-spacer";
		head.append(title, spacer, button("关闭", "关闭", "gjj-ct-btn", () => backdrop.remove()));
		const body = document.createElement("div");
		body.className = "gjj-ct-model-body";
		for (const group of data.groups || []) {
			const groupEl = document.createElement("div");
			groupEl.className = "gjj-ct-model-group";
			const groupTitle = document.createElement("div");
			groupTitle.className = "gjj-ct-title";
			groupTitle.textContent = group.name || "存储";
			const tree = document.createElement("pre");
			tree.className = "gjj-ct-model-tree";
			tree.textContent = buildModelTreeText(group.items || []);
			groupEl.append(groupTitle, tree);
			body.appendChild(groupEl);
		}
		dialog.append(head, body);
		backdrop.appendChild(dialog);
		backdrop.addEventListener("click", (event) => {
			stop(event);
			if (event.target === backdrop) backdrop.remove();
		});
		panel.appendChild(backdrop);
	}

	function renderItemList(panel) {
		const list = panel.querySelector(".gjj-ct-list");
		if (!list) return;
		list.replaceChildren();
		for (const item of state.items) {
			const card = document.createElement("button");
			card.type = "button";
			card.className = `gjj-ct-card${item.id === state.selectedId ? " active" : ""}`;
			const cover = document.createElement("div");
			cover.className = "gjj-ct-cover";
			if (item.cover) {
				const img = document.createElement("img");
				img.src = apiUrl(item.cover);
				cover.appendChild(img);
			} else {
				const empty = document.createElement("div");
				empty.className = "gjj-ct-empty-cover";
				empty.textContent = item.category === "prop" ? "🎒" : "👗";
				cover.appendChild(empty);
			}
			const name = document.createElement("div");
			name.className = "gjj-ct-name";
			name.textContent = item.name || item.id;
			const meta = document.createElement("div");
			meta.className = "gjj-ct-meta";
			meta.textContent = `${CATEGORY_LABELS[item.category] || "服装"} · ${(item.assets || []).length} 图`;
			card.append(cover, name, meta);
			card.addEventListener("click", () => {
				state.selectedId = item.id;
				renderPanel();
			});
			list.appendChild(card);
		}
		if (!state.items.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-ct-empty";
			empty.textContent = "还没有服装或道具";
			list.appendChild(empty);
		}
		for (const item of panel.querySelectorAll("[data-ct-category-filter]")) item.classList.toggle("active", item.dataset.ctCategoryFilter === state.category);
		for (const item of panel.querySelectorAll("[data-ct-sort]")) item.classList.toggle("active", item.dataset.ctSort === state.sort);
		for (const item of panel.querySelectorAll("[data-ct-tag-filter]")) item.classList.toggle("active", item.dataset.ctTagFilter === state.tag);
		const pageLabel = panel.querySelector("[data-ct-page-label]");
		if (pageLabel) pageLabel.textContent = `${state.page}/${state.pageCount}`;
		const prev = panel.querySelector("[data-ct-page-prev]");
		const next = panel.querySelector("[data-ct-page-next]");
		if (prev) prev.disabled = state.page <= 1;
		if (next) next.disabled = state.page >= state.pageCount;
		renderTagFilters(panel);
	}

	function renderTagFilters(panel) {
		const box = panel.querySelector("[data-ct-tag-box]");
		if (!box) return;
		box.replaceChildren();
		const all = button("全部标签", "显示全部标签", "gjj-ct-tag", () => {
			state.tag = "";
			state.page = 1;
			refreshItems(true).catch((error) => setStatus(error.message));
		});
		all.dataset.ctTagFilter = "";
		all.classList.toggle("active", state.tag === "");
		box.appendChild(all);
		for (const tag of state.tags.slice(0, 30)) {
			const item = button(tag, `按标签筛选：${tag}`, "gjj-ct-tag", () => {
				state.tag = tag;
				state.page = 1;
				refreshItems(true).catch((error) => setStatus(error.message));
			});
			item.dataset.ctTagFilter = tag;
			item.classList.toggle("active", state.tag === tag);
			box.appendChild(item);
		}
	}

	function renderMain(panel) {
		const main = panel.querySelector(".gjj-ct-main");
		if (!main) return;
		main.replaceChildren();
		const item = selectedItem();
		const head = document.createElement("div");
		head.className = "gjj-ct-head";
		const title = document.createElement("div");
		title.className = "gjj-ct-title";
		title.textContent = item ? "服化道详情" : "服化道";
		const spacer = document.createElement("div");
		spacer.className = "gjj-ct-spacer";
		head.append(title, spacer, button("关闭", "关闭", "gjj-ct-btn", closePanel));
		main.appendChild(head);
		const body = document.createElement("div");
		body.className = "gjj-ct-body";
		main.appendChild(body);
		if (!item) {
			const empty = document.createElement("div");
			empty.className = "gjj-ct-empty";
			empty.textContent = "点击添加或导入素材开始管理服装、道具";
			body.appendChild(empty);
			return;
		}
		const form = document.createElement("div");
		form.className = "gjj-ct-form";
		const name = document.createElement("input");
		name.className = "gjj-ct-input";
		name.dataset.ctName = "1";
		name.value = item.name || item.id || "";
		const category = document.createElement("select");
		category.className = "gjj-ct-select";
		category.dataset.ctCategory = "1";
		for (const [value, label] of [["clothing", "服装"], ["prop", "道具"]]) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			option.selected = item.category === value;
			category.appendChild(option);
		}
		const save = button("保存", "保存服化道信息", "gjj-ct-btn", () => saveItemFromForm().catch((error) => setStatus(error.message)));
		const open = button("打开目录", "打开服化道目录", "gjj-ct-btn", () => apiJson(`${ENDPOINT}/open_dir`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: item.id }),
		}).catch((error) => setStatus(error.message)));
		const tags = document.createElement("input");
		tags.className = "gjj-ct-input";
		tags.dataset.ctTags = "1";
		tags.placeholder = "标签，用逗号分隔";
		tags.value = (item.tags || []).join(", ");
		const notes = document.createElement("textarea");
		notes.className = "gjj-ct-textarea";
		notes.dataset.ctNotes = "1";
		notes.placeholder = "服装/道具备注";
		notes.value = item.notes || "";
		form.append(name, category, save, open, tags, notes);
		body.appendChild(form);
		const actions = document.createElement("div");
		actions.className = "gjj-ct-row";
		actions.append(
			button("导入素材", "给当前条目导入图片素材", "gjj-ct-btn", () => uploadAssets(item).catch((error) => setStatus(error.message))),
			button("引用", "插入或复制当前服装/道具引用", "gjj-ct-btn", (event) => copyOrInsertItemReference(item, event?.currentTarget).catch((error) => setStatus(error.message))),
			annotateButton([item.id], "当前服装"),
			button("删除", "删除当前服化道条目", "gjj-ct-btn danger", () => deleteItem(item).catch((error) => setStatus(error.message)))
		);
		body.appendChild(actions);
		const tagRow = document.createElement("div");
		tagRow.className = "gjj-ct-tags";
		for (const tag of item.tags || []) {
			const pill = document.createElement("span");
			pill.className = "gjj-ct-pill";
			pill.textContent = tag;
			tagRow.appendChild(pill);
		}
		body.appendChild(tagRow);
		const assets = document.createElement("div");
		assets.className = "gjj-ct-assets";
		for (const asset of item.assets || []) {
			const card = document.createElement("div");
			card.className = "gjj-ct-asset";
			const preview = document.createElement("div");
			preview.className = "gjj-ct-asset-preview";
			if (asset.url) {
				const img = document.createElement("img");
				img.src = apiUrl(asset.url);
				preview.appendChild(img);
			} else {
				preview.textContent = "素材";
			}
			const label = document.createElement("div");
			label.className = "gjj-ct-name";
			label.textContent = asset.label || asset.file || "";
			const meta = document.createElement("div");
			meta.className = "gjj-ct-meta";
			meta.textContent = formatBytes(asset.size);
			card.append(preview, label, meta);
			assets.appendChild(card);
		}
		body.appendChild(assets);
		const status = document.createElement("div");
		status.className = "gjj-ct-status";
		status.textContent = state.status || "";
		body.appendChild(status);
	}

	function clampPanelPosition(panel, left, top) {
		const width = panel.offsetWidth || 920;
		const height = panel.offsetHeight || 680;
		return {
			left: Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8)),
			top: Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8)),
		};
	}

	function clampPanelSize(width, height) {
		return {
			width: Math.round(Math.min(Math.max(560, Number(width) || 920), Math.max(560, window.innerWidth - 16))),
			height: Math.round(Math.min(Math.max(420, Number(height) || 680), Math.max(420, window.innerHeight - 16))),
		};
	}

	function applyPanelSize(panel, size) {
		if (!panel || !size) return;
		const next = clampPanelSize(size.width, size.height);
		panel.style.width = `${next.width}px`;
		panel.style.height = `${next.height}px`;
		state.panelSize = next;
		saveSharedPanelLayout();
	}

	function applyPanelPosition(panel, pos) {
		const next = clampPanelPosition(panel, pos.left, pos.top);
		panel.style.left = `${next.left}px`;
		panel.style.top = `${next.top}px`;
		panel.style.right = "auto";
		panel.style.bottom = "auto";
		state.panelPosition = next;
		saveSharedPanelLayout();
	}

	function installPanelResizeMemory(panel) {
		let last = "";
		const observer = new ResizeObserver(() => {
			if (!panel.classList.contains("open")) return;
			const rect = panel.getBoundingClientRect();
			const next = clampPanelSize(rect.width, rect.height);
			const key = `${next.width}x${next.height}`;
			if (key === last) return;
			last = key;
			state.panelSize = next;
			applyPanelPosition(panel, clampPanelPosition(panel, rect.left, rect.top));
			saveSharedPanelLayout();
		});
		observer.observe(panel);
	}

	function makePanelDragHandle(panel) {
		const drag = document.createElement("button");
		drag.type = "button";
		drag.className = "gjj-ct-drag";
		drag.textContent = "⠿";
		drag.title = "拖动服化道；双击复位大小和位置";
		drag.addEventListener("dblclick", (event) => {
			stop(event);
			state.panelPosition = null;
			state.panelSize = null;
			panel.style.width = "";
			panel.style.height = "";
			saveSharedPanelLayout();
			positionPanel(state.lastAnchor || document.getElementById(BUTTON_ID));
		});
		drag.addEventListener("pointerdown", (event) => {
			stop(event);
			const rect = panel.getBoundingClientRect();
			const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
			try { drag.setPointerCapture?.(event.pointerId); } catch (_) {}
			const move = (moveEvent) => {
				moveEvent.preventDefault();
				moveEvent.stopPropagation();
				applyPanelPosition(panel, clampPanelPosition(panel, start.left + moveEvent.clientX - start.x, start.top + moveEvent.clientY - start.y));
			};
			const up = () => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", up, true);
		}, true);
		return drag;
	}

	function buildPanel() {
		installStyle();
		let panel = document.getElementById(PANEL_ID);
		if (panel) return panel;
		panel = document.createElement("div");
		panel.id = PANEL_ID;
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) {
			panel.addEventListener(eventName, (event) => event.stopPropagation());
		}
		installPanelResizeMemory(panel);
		const sidebar = document.createElement("div");
		sidebar.className = "gjj-ct-sidebar";
		const head = document.createElement("div");
		head.className = "gjj-ct-head";
		const drag = makePanelDragHandle(panel);
		const title = document.createElement("div");
		title.className = "gjj-ct-title";
		title.textContent = "服化道";
		const spacer = document.createElement("div");
		spacer.className = "gjj-ct-spacer";
		head.append(
			drag,
			title,
			spacer,
			button("👗", "新增服装", "gjj-ct-btn gjj-ct-icon", () => createItem("clothing").catch((error) => setStatus(error.message))),
			button("🎒", "新增道具", "gjj-ct-btn gjj-ct-icon", () => createItem("prop").catch((error) => setStatus(error.message))),
			button("⬆", "导入素材", "gjj-ct-btn gjj-ct-icon", () => uploadAssets(selectedItem()).catch((error) => setStatus(error.message))),
			annotateButton([], "全库服装"),
			button("?", "查看服化道存储目录", "gjj-ct-btn gjj-ct-icon", () => showModelTree().catch((error) => setStatus(error.message)))
		);
		const search = document.createElement("input");
		search.className = "gjj-ct-search";
		search.placeholder = "搜索服装、道具、标签";
		search.value = state.search;
		search.addEventListener("input", () => {
			state.search = search.value || "";
			state.page = 1;
			refreshItems(true).catch((error) => setStatus(error.message));
		});
		const tools = document.createElement("div");
		tools.className = "gjj-ct-tools";
		for (const [value, label] of [["all", "全部"], ["clothing", "服装"], ["prop", "道具"]]) {
			const item = button(label, `筛选${label}`, "gjj-ct-filter", () => {
				state.category = value;
				state.page = 1;
				refreshItems(true).catch((error) => setStatus(error.message));
			});
			item.dataset.ctCategoryFilter = value;
			tools.appendChild(item);
		}
		const divider = document.createElement("div");
		divider.className = "gjj-ct-divider";
		tools.appendChild(divider);
		for (const [value, label] of [["updated_desc", "最新"], ["size_desc", "大"], ["name_asc", "A-Z"]]) {
			const item = button(label, "排序", "gjj-ct-sort", () => {
				state.sort = value;
				state.page = 1;
				refreshItems(true).catch((error) => setStatus(error.message));
			});
			item.dataset.ctSort = value;
			tools.appendChild(item);
		}
		const tagTools = document.createElement("div");
		tagTools.className = "gjj-ct-tools gjj-ct-tagbox";
		tagTools.dataset.ctTagBox = "1";
		const list = document.createElement("div");
		list.className = "gjj-ct-list";
		const pager = document.createElement("div");
		pager.className = "gjj-ct-pager";
		const prev = button("‹", "上一页", "gjj-ct-btn gjj-ct-icon", () => {
			state.page = Math.max(1, state.page - 1);
			refreshItems(true).catch((error) => setStatus(error.message));
		});
		prev.dataset.ctPagePrev = "1";
		const pageLabel = document.createElement("div");
		pageLabel.className = "gjj-ct-page-label";
		pageLabel.dataset.ctPageLabel = "1";
		const next = button("›", "下一页", "gjj-ct-btn gjj-ct-icon", () => {
			state.page = Math.min(state.pageCount, state.page + 1);
			refreshItems(true).catch((error) => setStatus(error.message));
		});
		next.dataset.ctPageNext = "1";
		pager.append(prev, pageLabel, next);
		sidebar.append(head, search, tools, tagTools, list, pager);
		const main = document.createElement("div");
		main.className = "gjj-ct-main";
		panel.append(sidebar, main);
		document.body.appendChild(panel);
		return panel;
	}

	function renderPanel() {
		const panel = buildPanel();
		renderItemList(panel);
		renderMain(panel);
	}

	function positionPanel(anchor) {
		const panel = buildPanel();
		state.lastAnchor = anchor || state.lastAnchor || document.getElementById(BUTTON_ID);
		loadSharedPanelLayout();
		if (state.panelSize) applyPanelSize(panel, state.panelSize);
		if (state.panelPosition) {
			applyPanelPosition(panel, state.panelPosition);
			return;
		}
		const rect = anchor?.getBoundingClientRect?.() || { left: 56, bottom: 52 };
		applyPanelPosition(panel, clampPanelPosition(panel, rect.left, rect.bottom + 8));
	}

	function closePanel() {
		document.getElementById(PANEL_ID)?.classList.remove("open");
		document.getElementById(BUTTON_ID)?.classList.remove("active");
	}

	async function togglePanel(anchor) {
		const panel = buildPanel();
		const open = !panel.classList.contains("open");
		if (!open) {
			closePanel();
			return;
		}
		try { globalThis.GJJ_CharacterLibrary?.close?.(); } catch (_) {}
		try { globalThis.GJJ_SceneLibrary?.close?.(); } catch (_) {}
		panel.classList.add("open");
		document.getElementById(BUTTON_ID)?.classList.add("active");
		positionPanel(anchor);
		await refreshItems(true).catch((error) => setStatus(error.message));
		positionPanel(anchor);
	}

	function ensureToolbarButton() {
		installStyle();
		const toolbar = document.getElementById(TOOLBAR_ID);
		if (!toolbar || document.getElementById(BUTTON_ID)) return;
		const btn = document.createElement("button");
		btn.id = BUTTON_ID;
		btn.type = "button";
		btn.textContent = "💼";
		btn.title = "服化道：管理服装、道具并按标签筛选";
		btn.setAttribute("aria-label", btn.title);
		btn.addEventListener("pointerdown", stop, true);
		btn.addEventListener("mousedown", stop, true);
		btn.addEventListener("mouseup", stop, true);
		btn.addEventListener("click", (event) => {
			stop(event);
			togglePanel(btn);
		});
		const scene = document.getElementById(SCENE_BUTTON_ID);
		const character = document.getElementById(CHARACTER_BUTTON_ID);
		const color = document.getElementById(COLOR_BUTTON_ID);
		if (scene?.parentElement === toolbar) scene.after(btn);
		else if (character?.parentElement === toolbar) character.after(btn);
		else if (color?.parentElement === toolbar) color.after(btn);
		else toolbar.appendChild(btn);
	}

	function installToolbarObserver() {
		ensureToolbarButton();
		if (window.__gjjCostumeLibraryToolbarObserver) return;
		window.__gjjCostumeLibraryToolbarObserver = true;
		const observer = new MutationObserver(() => ensureToolbarButton());
		observer.observe(document.body, { childList: true, subtree: true });
		for (const delay of [100, 400, 1200, 2600]) setTimeout(ensureToolbarButton, delay);
	}

	async function resolveItem(reference) {
		const text = String(reference || "").trim().replace(/^@/, "");
		if (!text) return null;
		return apiJson(`${ENDPOINT}/resolve?name=${encodeURIComponent(text)}`);
	}

	function referenceText(item) {
		return itemReferenceText(item);
	}

	function installPublicApi() {
		globalThis.GJJ_CostumeLibrary = {
			open: togglePanel,
			close: closePanel,
			refresh: refreshItems,
			resolve: resolveItem,
			referenceText,
			get items() {
				return state.items.slice();
			},
			get tags() {
				return state.tags.slice();
			},
		};
	}

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			installStyle();
			installPublicApi();
			installToolbarObserver();
			refreshItems(true).catch(() => {});
			dirtyCanvas();
		},
	});
})();

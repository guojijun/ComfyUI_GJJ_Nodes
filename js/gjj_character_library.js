import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.CharacterLibrary";
	const TOOLBAR_ID = "gjj-workflow-screenshot-toolbar";
	const COLOR_BUTTON_ID = "gjj-workflow-node-color-button";
	const BUTTON_ID = "gjj-character-library-button";
	const PANEL_ID = "gjj-character-library-panel";
	const LIGHTBOX_ID = "gjj-character-library-lightbox";
	const STYLE_ID = "gjj-character-library-style";
	const ENDPOINT = "/gjj/character_library";
	const VIEW_LABELS = ["大头照", "正面", "左侧", "右侧", "背面", "45度", "半身", "动作"];
	const CUSTOM_VIEW_GROUPS = [
		{
			key: "azimuth",
			title: "方位",
			required: true,
			defaultSelected: ["front view"],
			options: [
				{ label: "正面", value: "front view" },
				{ label: "右前45°", value: "front-right quarter view" },
				{ label: "右侧", value: "right side view" },
				{ label: "右后45°", value: "back-right quarter view" },
				{ label: "背面", value: "back view" },
				{ label: "左后45°", value: "back-left quarter view" },
				{ label: "左侧", value: "left side view" },
				{ label: "左前45°", value: "front-left quarter view" },
			],
		},
		{
			key: "elevation",
			title: "机位",
			required: true,
			defaultSelected: ["eye-level shot"],
			options: [
				{ label: "齐眼", value: "eye-level shot" },
				{ label: "低角度", value: "low-angle shot" },
				{ label: "抬高", value: "elevated shot" },
				{ label: "高角度", value: "high-angle shot" },
			],
		},
		{
			key: "distance",
			title: "景别",
			required: true,
			defaultSelected: ["medium shot"],
			options: [
				{ label: "全身", value: "full body shot" },
				{ label: "中景", value: "medium shot" },
				{ label: "特写", value: "close-up" },
				{ label: "远景", value: "wide shot" },
			],
		},
	];
	const SHARED_PANEL_LAYOUT_KEY = "gjj.libraryPanel.layout";
	let state = {
		characters: [],
		selectedId: "",
		search: "",
		gender: "all",
		sort: "updated_desc",
		page: 1,
		pageSize: 15,
		total: 0,
		pageCount: 1,
		status: "",
		progress: 0,
		progressVisible: false,
		progressTimer: null,
		panelPosition: null,
		panelSize: null,
		lastAnchor: null,
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
		if (!response.ok || data?.ok === false) {
			throw new Error(data?.error || `请求失败：${response.status}`);
		}
		return data;
	}

	function modelTreeParts(path) {
		const parts = String(path || "").replace(/\\/g, "/").split("/").map((item) => item.trim()).filter(Boolean);
		const modelsIndex = parts.findIndex((item) => item.toLowerCase() === "models");
		return modelsIndex >= 0 ? parts.slice(modelsIndex) : [];
	}

	function insertModelTreePath(root, parts, forceDirectory = false) {
		let node = root;
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index];
			if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), directory: false });
			node = node.children.get(part);
			if (forceDirectory && index === parts.length - 1) node.directory = true;
		}
	}

	function renderModelTreeNode(node, prefix = "") {
		const entries = Array.from(node.children.values()).sort((a, b) => {
			const aDir = a.children.size > 0;
			const bDir = b.children.size > 0;
			if (aDir !== bDir) return aDir ? -1 : 1;
			return a.name.localeCompare(b.name, "zh-Hans-CN");
		});
		const lines = [];
		for (let index = 0; index < entries.length; index += 1) {
			const child = entries[index];
			const last = index === entries.length - 1;
			const isDir = child.directory || child.children.size > 0;
			lines.push(`${prefix}${last ? "└──" : "├──"}${isDir ? "📁 " : "🧠 "}${child.name}${isDir ? "/" : ""}`);
			lines.push(...renderModelTreeNode(child, `${prefix}${last ? "    " : "│   "}`));
		}
		return lines;
	}

	function buildModelTreeText(items = []) {
		const root = { name: "ComfyUI", children: new Map() };
		for (const item of items || []) {
			const parts = modelTreeParts(item?.path || item);
			const last = parts[parts.length - 1] || "";
			const forceDirectory = Boolean(item?.folder || item?.directory || (last && !/\.[^/.]+$/.test(last)));
			if (parts.length) insertModelTreePath(root, parts, forceDirectory);
		}
		return ["ComfyUI/", ...renderModelTreeNode(root)].join("\n");
	}

	function normalizeModelText(value) {
		return String(value || "").replace(/\\/g, "/").toLowerCase();
	}

	function displayModelFilename(value, fallback = "") {
		const text = String(value || fallback || "").replace(/\\/g, "/").trim();
		return text ? text.split("/").filter(Boolean).pop() || text : "未选择";
	}

	function modelSearchTokens(query) {
		return String(query || "").toLowerCase().split(/[\s,，;；|/\\]+/).map((token) => token.trim()).filter(Boolean);
	}

	function modelNameScore(value, tokens, index) {
		const text = normalizeModelText(value);
		const suffixScore = text.endsWith(".safetensors") ? 0 : text.endsWith(".gguf") ? 1 : 2;
		if (!tokens.length) return [suffixScore, index];
		let positionScore = 0;
		for (const token of tokens) {
			const needle = normalizeModelText(token);
			const found = text.indexOf(needle);
			if (found < 0) return null;
			positionScore += found;
		}
		return [suffixScore, positionScore, index];
	}

	function filteredControlOptions(control, current, query = "", limit = 80) {
		const options = Array.isArray(control?.options) ? control.options : [];
		const tokens = modelSearchTokens(query);
		const seen = new Set();
		const scored = [];
		for (const [index, option] of options.entries()) {
			const text = String(option || "").trim();
			const key = normalizeModelText(text);
			if (!text || seen.has(key)) continue;
			seen.add(key);
			const score = modelNameScore(text, tokens, index);
			if (score) scored.push({ text, score });
		}
		scored.sort((a, b) => {
			for (let index = 0; index < a.score.length; index += 1) {
				if (a.score[index] !== b.score[index]) return a.score[index] - b.score[index];
			}
			return a.text.localeCompare(b.text, "zh-Hans-CN");
		});
		const result = scored.slice(0, limit).map((item) => item.text);
		if (current && !result.includes(current) && (!tokens.length || modelNameScore(current, tokens, -1))) {
			result.unshift(current);
		}
		return result;
	}

	function modelFileIcon(path) {
		const text = normalizeModelText(path);
		if (text.includes("/loras/")) return "🟠";
		if (text.includes("/text_encoders/")) return "🟡";
		if (text.includes("/vae/")) return "🔴";
		return "🟣";
	}

	function findControlForModelItem(item, controls, values) {
		const path = normalizeModelText(item?.path || item);
		const label = normalizeModelText(item?.label || "");
		for (const control of controls || []) {
			const current = normalizeModelText(values?.[control.key]);
			if (current && (path.endsWith(current) || path.includes(`/${current}`))) return control;
		}
		if (path.includes("/rmbg/")) return controls.find((control) => control.key === "matting_method");
		if (path.includes("/diffusion_models/")) return controls.find((control) => /unet|diffusion/i.test(control.key));
		if (path.includes("/text_encoders/")) return controls.find((control) => /clip|encoder/i.test(control.key));
		if (path.includes("/loras/")) {
			if (label.includes("lightning")) return controls.find((control) => /lora_1/i.test(control.key));
			if (label.includes("多角度") || label.includes("angle")) return controls.find((control) => /lora_2/i.test(control.key));
		}
		return null;
	}

	function modelTreeLine(prefix, icon, text, clickable = false) {
		const row = document.createElement(clickable ? "button" : "div");
		if (clickable) row.type = "button";
		row.className = `gjj-cl-model-line${clickable ? " clickable" : ""}`;
		row.textContent = `${prefix}${icon} ${text}`;
		return row;
	}

	function makeModelChoicePanel(control, values, onApply) {
		const wrap = document.createElement("div");
		wrap.className = "gjj-cl-model-choice";
		const search = document.createElement("input");
		search.type = "text";
		search.className = "gjj-cl-model-search";
		search.placeholder = "输入关键词，自动使用第一个匹配模型";
		const list = document.createElement("div");
		list.className = "gjj-cl-model-options";
		const render = (autoPick = false) => {
			const current = String(values[control.key] || "");
			const options = filteredControlOptions(control, current, search.value, 80);
			if (autoPick && options.length) onApply(options[0]);
			list.replaceChildren();
			if (!options.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-cl-model-empty";
				empty.textContent = "没有匹配模型";
				list.appendChild(empty);
				return;
			}
			for (const option of options) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "gjj-cl-model-option";
				if (String(option || "") === String(values[control.key] || "")) item.classList.add("selected");
				item.textContent = `${item.classList.contains("selected") ? "✓ " : ""}${displayModelFilename(option)}`;
				item.title = String(option || "");
				item.addEventListener("click", () => {
					onApply(option);
					render(false);
				});
				list.appendChild(item);
			}
		};
		search.addEventListener("input", () => render(true));
		search.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			const first = filteredControlOptions(control, values[control.key], search.value, 1)[0];
			if (first != null) {
				onApply(first);
				render(false);
			}
		});
		wrap.append(search, list);
		render(false);
		setTimeout(() => search.focus(), 0);
		return wrap;
	}

	function makeClickableModelFile(item, prefix, control, values) {
		const host = document.createElement("div");
		let choicePanel = null;
		const renderLine = () => {
			const current = control ? String(values[control.key] || "") : "";
			const displayValue = control?.key === "matting_method"
				? current
				: (control && (/[/\\]/.test(current) || /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i.test(current)) ? current : item?.path || item);
			const name = displayModelFilename(displayValue);
			const line = modelTreeLine(prefix, modelFileIcon(item?.path || item), name, Boolean(control));
			line.title = String(control ? values[control.key] || item?.path || "" : item?.path || item || "");
			if (control) {
				line.addEventListener("click", () => {
					if (choicePanel) {
						choicePanel.remove();
						choicePanel = null;
						renderLine();
						return;
					}
					choicePanel = makeModelChoicePanel(control, values, (value) => {
						values[control.key] = String(value || "");
						renderLine();
					});
					host.appendChild(choicePanel);
					renderLine();
				});
			}
			if (host.firstChild) host.replaceChild(line, host.firstChild);
			else host.prepend(line);
		};
		renderLine();
		return host;
	}

	function buildClickableModelTree(items, controls, values) {
		const tree = document.createElement("div");
		tree.className = "gjj-cl-model-tree";
		tree.appendChild(modelTreeLine("", "📁", "models/"));
		const folders = new Map();
		for (const item of items || []) {
			const parts = modelTreeParts(item?.path || item);
			if (!parts.length || parts[0].toLowerCase() !== "models") continue;
			const folder = parts.length > 2 ? parts[1] : "";
			if (!folder) continue;
			if (!folders.has(folder)) folders.set(folder, []);
			folders.get(folder).push(item);
		}
		const folderNames = Array.from(folders.keys()).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
		if (!folderNames.length) {
			for (const item of items || []) {
				const path = String(item?.path || item || "").replace(/\\/g, "/");
				const isFolder = Boolean(item?.folder || item?.directory || (path && !/\.[^/.]+$/.test(path)));
				tree.appendChild(modelTreeLine("└─", isFolder ? "📁" : modelFileIcon(path), `${displayModelFilename(path)}${isFolder ? "/" : ""}`));
			}
			return tree;
		}
		for (const [folderIndex, folder] of folderNames.entries()) {
			const isLastFolder = folderIndex === folderNames.length - 1;
			tree.appendChild(modelTreeLine(isLastFolder ? "└─" : "├─", "📁", `${folder}/`));
			const files = folders.get(folder) || [];
			files.forEach((item, index) => {
				const prefix = `${isLastFolder ? "　" : "│　"}${index === files.length - 1 ? "└─" : "├─"}`;
				tree.appendChild(makeClickableModelFile(item, prefix, findControlForModelItem(item, controls, values), values));
			});
		}
		return tree;
	}

	function stop(event) {
		event?.preventDefault?.();
		event?.stopImmediatePropagation?.();
		event?.stopPropagation?.();
	}

	function stopBubble(event) {
		event?.preventDefault?.();
		event?.stopPropagation?.();
	}

	function dirtyCanvas() {
		try { app?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
		try { app?.canvas?.setDirty?.(true, true); } catch (_) {}
	}

	function installStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
#${BUTTON_ID}{width:34px;height:34px;padding:0;border:1px solid rgba(117,137,148,.5);border-radius:8px;background:rgba(28,32,36,.92);color:#f2f6f4;font:19px/32px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;cursor:pointer;box-sizing:border-box;pointer-events:auto;box-shadow:0 4px 14px rgba(0,0,0,.28);transition:border-color .16s ease,background .16s ease,transform .16s ease;}
#${BUTTON_ID}:hover,#${BUTTON_ID}.active{border-color:rgba(105,184,139,.85);background:rgba(36,55,44,.96);}
#${PANEL_ID}{position:fixed;z-index:100000;width:min(920px,calc(100vw - 20px));height:min(680px,calc(100vh - 20px));min-width:min(560px,calc(100vw - 20px));min-height:min(420px,calc(100vh - 20px));max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);resize:both;display:none;grid-template-columns:minmax(260px,320px) 1fr;gap:0;border:1px solid #40525b;border-radius:8px;background:#0f171b;color:#e7f2f4;box-shadow:0 18px 46px rgba(0,0,0,.54);font-family:system-ui,"Microsoft YaHei",sans-serif;overflow:auto;}
#${PANEL_ID}.open{display:grid;}
.gjj-cl-sidebar{min-width:0;min-height:0;border-right:1px solid #263842;background:#111a1f;display:flex;flex-direction:column;}
.gjj-cl-main{min-width:0;min-height:0;display:flex;flex-direction:column;background:#0c1418;}
.gjj-cl-head{display:flex;align-items:center;gap:6px;min-height:42px;padding:7px 8px;border-bottom:1px solid #263842;}
.gjj-cl-drag{width:24px;height:28px;flex:0 0 24px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#9fb4ba;font-size:17px;line-height:22px;cursor:grab;padding:0;display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;}
.gjj-cl-drag:hover{background:#263844;border-color:#6aa6b8;color:#e7f2f4;}
.gjj-cl-drag:active{cursor:grabbing;}
.gjj-cl-title{font-size:14px;font-weight:800;color:#f3fbf8;white-space:nowrap;}
.gjj-cl-spacer{flex:1 1 auto;}
.gjj-cl-btn{height:28px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;font-size:12px;font-weight:700;cursor:pointer;padding:0 9px;white-space:nowrap;}
.gjj-cl-btn:hover{background:#263844;border-color:#6aa6b8;}
.gjj-cl-btn.danger:hover{background:#4a2028;border-color:#d76f7b;}
.gjj-cl-icon{width:28px;padding:0;font-size:15px;}
.gjj-cl-close{height:30px;padding:0 10px;border-radius:6px;font-size:12px;font-weight:800;color:#f2f6f4;}
.gjj-cl-search{height:30px;margin:8px 8px 6px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 9px;font-size:12px;outline:none;}
.gjj-cl-tools{display:flex;align-items:center;gap:6px;padding:0 8px 7px;overflow-x:auto;scrollbar-width:thin;scrollbar-color:#33464e #10191e;}
.gjj-cl-sort-label{color:#a9bbc0;font-size:12px;font-weight:700;white-space:nowrap;}
.gjj-cl-sort-btn{height:26px;min-width:58px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;font-size:12px;font-weight:700;cursor:pointer;padding:0 8px;white-space:nowrap;}
.gjj-cl-sort-btn:hover{background:#263844;border-color:#6aa6b8;}
.gjj-cl-sort-btn.active,.gjj-cl-filter-btn.active{background:#1d5d39;border-color:#65d189;color:#ffffff;}
.gjj-cl-filter-btn{height:26px;min-width:34px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;font-size:12px;font-weight:700;cursor:pointer;padding:0 8px;white-space:nowrap;}
.gjj-cl-filter-btn:hover{background:#263844;border-color:#6aa6b8;}
.gjj-cl-tool-divider{width:1px;height:18px;background:#31444c;flex:0 0 auto;}
.gjj-cl-list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 8px 8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));align-content:start;gap:6px;scrollbar-width:thin;scrollbar-color:#33464e #10191e;}
.gjj-cl-list::-webkit-scrollbar,.gjj-cl-body::-webkit-scrollbar{width:5px;height:5px;}
.gjj-cl-list::-webkit-scrollbar-thumb,.gjj-cl-body::-webkit-scrollbar-thumb{background:#33464e;border-radius:999px;}
.gjj-cl-list::-webkit-scrollbar-track,.gjj-cl-body::-webkit-scrollbar-track{background:#10191e;}
.gjj-cl-card{min-width:0;border:1px solid #293a42;border-radius:8px;background:#152027;color:#dce7e2;padding:4px;cursor:pointer;text-align:left;}
.gjj-cl-card:hover,.gjj-cl-card.active{border-color:#69b88b;background:#1c3029;}
.gjj-cl-cover{height:68px;border-radius:6px;background:#0a1115;display:flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:3px;}
.gjj-cl-cover img{max-width:100%;max-height:100%;object-fit:contain;}
.gjj-cl-empty-cover{font-size:30px;opacity:.68;}
.gjj-cl-name{font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:4px;}
.gjj-cl-name-text{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.gjj-cl-count{flex:0 0 auto;font-size:10px;color:#90a4aa;font-weight:700;}
.gjj-cl-pager{display:flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:5px 8px 7px;border-top:1px solid #263842;}
.gjj-cl-page-label{min-width:64px;text-align:center;font-size:11px;color:#9cb0b6;font-weight:700;}
.gjj-cl-page-btn{width:28px;height:26px;padding:0;}
.gjj-cl-page-btn:disabled{opacity:.38;cursor:default;}
.gjj-cl-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:#40535b #10191e;}
.gjj-cl-form{display:grid;grid-template-columns:auto minmax(180px,1fr) auto;gap:7px;align-items:center;}
.gjj-cl-input{height:30px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 9px;font-size:12px;outline:none;min-width:0;}
.gjj-cl-textarea{min-height:54px;resize:vertical;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:7px 9px;font-size:12px;outline:none;grid-column:1 / -1;}
.gjj-cl-gender-select{width:34px;height:30px;padding:0;font-size:15px;}
.gjj-cl-voice-row{grid-column:1 / -1;display:grid;grid-template-columns:auto minmax(120px,1fr) auto auto auto;gap:7px;align-items:center;}
.gjj-cl-voice-label{font-size:12px;font-weight:800;color:#dce7e2;white-space:nowrap;}
.gjj-cl-voice-path{height:30px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#9fb3b8;padding:0 9px;font-size:12px;outline:none;min-width:0;}
.gjj-cl-voice-path.clickable{cursor:pointer;}
.gjj-cl-voice-path.clickable:hover{border-color:#6aa6b8;color:#dce7e2;}
.gjj-cl-voice-player{grid-column:2 / -1;width:100%;height:28px;}
.gjj-cl-voice-pop{position:fixed;z-index:100002;width:min(420px,calc(100vw - 24px));max-height:min(480px,calc(100vh - 40px));display:flex;flex-direction:column;gap:8px;border:1px solid #40535b;border-radius:8px;background:#0f171b;color:#e7f2f4;box-shadow:0 18px 46px rgba(0,0,0,.54);padding:10px;box-sizing:border-box;}
.gjj-cl-voice-search{height:30px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 9px;font-size:12px;outline:none;}
.gjj-cl-voice-list{min-height:80px;overflow:auto;display:flex;flex-direction:column;gap:5px;scrollbar-width:thin;scrollbar-color:#33464e #10191e;}
.gjj-cl-voice-item{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;border:1px solid #263842;border-radius:6px;background:#121d22;color:#dce7e2;padding:6px;text-align:left;}
.gjj-cl-voice-item:hover{border-color:#6aa6b8;background:#192830;}
.gjj-cl-voice-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:800;}
.gjj-cl-voice-meta{font-size:11px;color:#8fa4aa;font-weight:600;}
.gjj-cl-voice-empty{padding:14px;color:#8fa4aa;text-align:center;font-size:12px;}
.gjj-cl-voice-pop audio{width:100%;height:28px;}
.gjj-cl-status{font-size:12px;color:#94aeb4;min-height:18px;}
.gjj-cl-progress{height:4px;border-radius:999px;background:#17242a;overflow:hidden;display:none;}
.gjj-cl-progress.open{display:block;}
.gjj-cl-progress-bar{height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#56c184,#77d7f2);transition:width .22s ease;}
.gjj-cl-views{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:9px;}
.gjj-cl-view{border:1px solid #2e4149;border-radius:8px;background:#131d22;padding:6px;display:flex;flex-direction:column;gap:4px;min-width:0;}
.gjj-cl-view-img{height:142px;border:0;border-radius:6px;background-image:linear-gradient(45deg,#0a1115 25%,#111c21 25%,#111c21 50%,#0a1115 50%,#0a1115 75%,#111c21 75%);background-size:18px 18px;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:zoom-in;padding:0;}
.gjj-cl-view-img img{max-width:100%;max-height:100%;object-fit:contain;}
.gjj-cl-view-title{font-size:12px;font-weight:800;line-height:1.25;min-height:30px;white-space:normal;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;}
.gjj-cl-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.gjj-cl-view-actions{display:grid;grid-template-columns:repeat(4,28px);gap:4px;}
.gjj-cl-view-actions .gjj-cl-btn{width:28px;height:28px;padding:0;font-size:14px;line-height:24px;}
.gjj-cl-empty{height:100%;display:flex;align-items:center;justify-content:center;color:#85979d;font-size:13px;text-align:center;padding:20px;}
.gjj-cl-model-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.46);display:flex;align-items:center;justify-content:center;padding:18px;z-index:2;}
.gjj-cl-model-dialog{width:min(620px,100%);max-height:100%;overflow:auto;border:1px solid #40535b;border-radius:8px;background:#101a1f;color:#dce7e2;box-shadow:0 18px 48px rgba(0,0,0,.56);}
.gjj-cl-model-head{display:flex;align-items:center;gap:8px;min-height:38px;padding:8px 10px;border-bottom:1px solid #263842;}
.gjj-cl-model-title{font-size:14px;font-weight:800;color:#f3fbf8;}
.gjj-cl-model-body{display:flex;flex-direction:column;gap:10px;padding:10px;}
.gjj-cl-model-group{border:1px solid #2d4149;border-radius:8px;background:#131d22;padding:8px;}
.gjj-cl-model-group-title{font-size:13px;font-weight:800;margin-bottom:6px;color:#f0faf4;}
.gjj-cl-model-tree{display:flex;flex-direction:column;gap:1px;margin:0;padding:7px;border:1px solid #33454c;border-radius:8px;background:#0f171b;color:#dce7e2;font-family:Consolas,"Microsoft YaHei",monospace;font-size:12px;line-height:1.55;overflow:auto;}
.gjj-cl-model-line{display:block;width:100%;border:0;background:transparent;color:#dce7e2;padding:2px 4px;border-radius:5px;text-align:left;font:12px/1.5 Consolas,"Microsoft YaHei",monospace;white-space:pre;box-sizing:border-box;}
.gjj-cl-model-line.clickable{cursor:pointer;}
.gjj-cl-model-line.clickable:hover{background:#17262d;}
.gjj-cl-model-choice{display:flex;flex-direction:column;gap:5px;margin:3px 0 5px 26px;padding:7px;border:1px solid #33454c;border-radius:8px;background:#11181c;}
.gjj-cl-model-search{width:100%;height:28px;background:#0d1418;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:0 7px;box-sizing:border-box;font-size:12px;outline:none;}
.gjj-cl-model-options{display:flex;flex-direction:column;gap:4px;max-height:210px;overflow:auto;}
.gjj-cl-model-option{width:100%;display:block;text-align:left;background:#182127;color:#dce7e2;border:1px solid #33454c;border-radius:6px;padding:5px 7px;box-sizing:border-box;white-space:normal;word-break:break-all;cursor:pointer;font-size:12px;}
.gjj-cl-model-option:hover{border-color:#6aa6b8;background:#1d2b32;}
.gjj-cl-model-option.selected{border-color:#2f7d67;background:#18352f;}
.gjj-cl-model-empty{color:#8da2ad;font-size:11px;padding:4px 2px;}
#${LIGHTBOX_ID}{position:fixed;inset:0;z-index:100001;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);cursor:zoom-out;padding:28px;overflow:hidden;touch-action:none;}
#${LIGHTBOX_ID}.open{display:flex;}
#${LIGHTBOX_ID} img{max-width:min(92vw,1200px);max-height:92vh;object-fit:contain;border-radius:8px;background-image:linear-gradient(45deg,#101820 25%,#1b2730 25%,#1b2730 50%,#101820 50%,#101820 75%,#1b2730 75%);background-size:22px 22px;box-shadow:0 18px 60px rgba(0,0,0,.62);transform-origin:center center;will-change:transform;cursor:grab;user-select:none;}
#${LIGHTBOX_ID} img.dragging{cursor:grabbing;}
`;
		document.head.appendChild(style);
	}

	function selectedCharacter() {
		return state.characters.find((item) => item.id === state.selectedId) || state.characters[0] || null;
	}

	function setStatus(text) {
		state.status = String(text || "");
		const el = document.querySelector(`#${PANEL_ID} .gjj-cl-status`);
		if (el) el.textContent = state.status;
	}

	function setProgress(value, visible = true) {
		state.progressVisible = Boolean(visible);
		state.progress = Math.max(0, Math.min(100, Number(value) || 0));
		const box = document.querySelector(`#${PANEL_ID} .gjj-cl-progress`);
		const bar = document.querySelector(`#${PANEL_ID} .gjj-cl-progress-bar`);
		if (box) box.classList.toggle("open", state.progressVisible);
		if (bar) bar.style.width = `${state.progress}%`;
	}

	function startImportProgress() {
		clearInterval(state.progressTimer);
		setProgress(8, true);
		state.progressTimer = setInterval(() => {
			const next = state.progress < 45
				? state.progress + 7
				: state.progress < 78
					? state.progress + 3
					: state.progress < 92
						? state.progress + 1
						: state.progress;
			setProgress(next, true);
		}, 420);
	}

	function finishImportProgress(ok = true) {
		clearInterval(state.progressTimer);
		state.progressTimer = null;
		setProgress(ok ? 100 : state.progress, true);
		setTimeout(() => setProgress(0, false), ok ? 680 : 1400);
	}

	async function refreshCharacters(keepSelection = true) {
		const params = new URLSearchParams({
			page: String(state.page),
			page_size: String(state.pageSize),
			search: state.search || "",
			gender: state.gender || "all",
			sort: state.sort || "updated_desc",
		});
		const data = await apiJson(`${ENDPOINT}/list?${params.toString()}`);
		const previous = keepSelection ? state.selectedId : "";
		state.characters = Array.isArray(data.characters) ? data.characters : [];
		state.total = Number(data.total || state.characters.length || 0);
		state.page = Math.max(1, Number(data.page || state.page || 1));
		state.pageSize = Math.max(1, Number(data.page_size || state.pageSize || 15));
		state.pageCount = Math.max(1, Number(data.page_count || 1));
		state.selectedId = state.characters.some((item) => item.id === previous)
			? previous
			: (state.characters[0]?.id || "");
		renderPanel();
		return state.characters;
	}

	function fileInput(accept = "image/png") {
		return new Promise((resolve) => {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = accept;
			input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
			input.click();
		});
	}

	function fileInputs(accept = "image/*") {
		return new Promise((resolve) => {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = accept;
			input.multiple = true;
			input.addEventListener("change", () => resolve(Array.from(input.files || [])), { once: true });
			input.click();
		});
	}

	function formatBytes(value) {
		const size = Number(value || 0);
		if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
		if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
		return `${size} B`;
	}

	function baseNameFromFile(file, fallback = "新角色") {
		const name = String(file?.name || "").replace(/\.[^.]+$/, "").trim();
		return name || fallback;
	}

	function autoCharacterName(file = null) {
		if (file) return baseNameFromFile(file, "新角色");
		const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
		return `新角色_${stamp}`;
	}

	function stripGenderPrefix(value) {
		return String(value || "").replace(/^\s*(?:♀️|♂️|♀|♂)\s*/u, "").trim();
	}

	function genderPrefix(character) {
		const text = `${character?.name || ""} ${character?.id || ""}`;
		if (text.includes("♀")) return "♀️";
		if (text.includes("♂")) return "♂️";
		return "";
	}

	function genderFromPrefix(prefix) {
		if (String(prefix || "").includes("♀")) return "female";
		if (String(prefix || "").includes("♂")) return "male";
		return "unknown";
	}

	function nextGenderPrefix(prefix) {
		const gender = genderFromPrefix(prefix);
		if (gender === "unknown") return "♀️";
		if (gender === "female") return "♂️";
		return "";
	}

	function displayReferenceInput(character) {
		return `@${characterReferenceName(character)}`;
	}

	function nameFromReferenceInput(value) {
		return stripGenderPrefix(String(value || "").trim().replace(/^@+/, "")) || "新角色";
	}

	function characterReferenceName(character) {
		return stripGenderPrefix(character?.reference_name || character?.name || character?.id || "") || String(character?.id || "");
	}

	function characterReference(character) {
		return character?.reference || `@${characterReferenceName(character)}`;
	}

	async function saveCharacterFromForm() {
		const panel = document.getElementById(PANEL_ID);
		const selected = selectedCharacter();
		const rawName = nameFromReferenceInput(panel?.querySelector("[data-cl-name]")?.value || selected?.name || "新角色");
		const prefix = panel?.querySelector("[data-cl-gender-prefix]")?.dataset.genderPrefix || genderPrefix(selected);
		const name = `${prefix || ""}${rawName}`;
		const id = selected?.id || name;
		const notes = panel?.querySelector("[data-cl-notes]")?.value || "";
		const voicePath = panel?.querySelector("[data-cl-voice-path]")?.value || selected?.voice_path || "";
		setStatus("正在保存角色...");
		const data = await apiJson(`${ENDPOINT}/character`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, name, notes, voice_path: voicePath, sync_id: true }),
		});
		state.selectedId = data.character?.id || id;
		await refreshCharacters(true);
		setStatus(data.character?.id && data.character.id !== id ? `角色已保存，文件夹已同步为 ${data.character.id}` : "角色已保存");
	}

	async function uploadVoice(character) {
		if (!character) return;
		const file = await fileInput("audio/wav,audio/mpeg,.wav,.mp3");
		if (!file) return;
		const form = new FormData();
		form.append("id", character.id);
		form.append("voice_path", `${characterReferenceName(character)}${file.name.toLowerCase().endsWith(".mp3") ? ".mp3" : ".wav"}`);
		form.append("file", file, file.name);
		setStatus("正在保存角色音色...");
		const data = await apiJson(`${ENDPOINT}/voice`, { method: "POST", body: form });
		state.selectedId = data.character?.id || character.id;
		await refreshCharacters(true);
		setStatus("音色已保存");
	}

	function closeVoicePicker() {
		document.querySelectorAll(".gjj-cl-voice-pop").forEach((node) => node.remove());
	}

	async function openVoicePicker(character, anchor) {
		closeVoicePicker();
		const rect = anchor?.getBoundingClientRect?.() || { left: 20, bottom: 80 };
		const popup = document.createElement("div");
		popup.className = "gjj-cl-voice-pop";
		popup.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 432)}px`;
		popup.style.top = `${Math.min(Math.max(8, rect.bottom + 6), window.innerHeight - 500)}px`;
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) {
			popup.addEventListener(eventName, (event) => event.stopPropagation());
		}
		const search = document.createElement("input");
		search.className = "gjj-cl-voice-search";
		search.placeholder = "搜索 models/GJJ/wav 下的音色";
		const list = document.createElement("div");
		list.className = "gjj-cl-voice-list";
		const player = document.createElement("audio");
		player.controls = true;
		player.preload = "none";
		const renderItems = async () => {
			list.replaceChildren();
			const loading = document.createElement("div");
			loading.className = "gjj-cl-voice-empty";
			loading.textContent = "正在读取 mp3 列表...";
			list.appendChild(loading);
			const params = new URLSearchParams({ search: search.value || "" });
			const data = await apiJson(`${ENDPOINT}/voice_list?${params.toString()}`);
			list.replaceChildren();
			const items = Array.isArray(data.items) ? data.items : [];
			if (!items.length) {
				const empty = document.createElement("div");
				empty.className = "gjj-cl-voice-empty";
				empty.textContent = "没有找到 mp3 文件";
				list.appendChild(empty);
				return;
			}
			for (const item of items) {
				const row = document.createElement("button");
				row.type = "button";
				row.className = "gjj-cl-voice-item";
				const text = document.createElement("div");
				text.style.minWidth = "0";
				const name = document.createElement("div");
				name.className = "gjj-cl-voice-name";
				name.textContent = item.path || item.name;
				const meta = document.createElement("div");
				meta.className = "gjj-cl-voice-meta";
				meta.textContent = formatBytes(item.size);
				text.append(name, meta);
				const play = button("▶", "试听", "gjj-cl-btn gjj-cl-icon", (event) => {
					stopBubble(event);
					player.src = apiUrl(item.url || "");
					player.play?.().catch(() => {});
				});
				const use = button("选用", "使用这个音色", "gjj-cl-btn", (event) => {
					stopBubble(event);
					const input = document.querySelector(`#${PANEL_ID} [data-cl-voice-path]`);
					if (input) input.value = item.path || "";
					closeVoicePicker();
					setStatus(`已选择音色：${item.path || item.name}`);
				});
				row.append(text, play, use);
				row.addEventListener("dblclick", () => {
					const input = document.querySelector(`#${PANEL_ID} [data-cl-voice-path]`);
					if (input) input.value = item.path || "";
					closeVoicePicker();
					setStatus(`已选择音色：${item.path || item.name}`);
				});
				list.appendChild(row);
			}
		};
		let timer = null;
		search.addEventListener("input", () => {
			clearTimeout(timer);
			timer = setTimeout(() => renderItems().catch((error) => setStatus(error.message)), 180);
		});
		const upload = button("上传音色", "上传 wav / mp3 到 models/GJJ/wav 并绑定当前角色（默认 wav）", "gjj-cl-btn", () => uploadVoice(character).then(closeVoicePicker).catch((error) => setStatus(error.message)));
		const head = document.createElement("div");
		head.className = "gjj-cl-row";
		head.append(search, upload);
		popup.append(head, list, player);
		document.body.appendChild(popup);
		setTimeout(() => search.focus(), 0);
		const outside = (event) => {
			if (!popup.contains(event.target) && event.target !== anchor) {
				document.removeEventListener("pointerdown", outside, true);
				closeVoicePicker();
			}
		};
		setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
		await renderItems();
	}

	async function clearVoice(character) {
		if (!character) return;
		setStatus("正在清除角色音色设置...");
		const data = await apiJson(`${ENDPOINT}/voice`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: character.id, voice_path: "" }),
		});
		state.selectedId = data.character?.id || character.id;
		await refreshCharacters(true);
		setStatus("音色设置已清除；如存在同名 mp3 会继续自动优先显示");
	}

	async function createCharacter() {
		const name = autoCharacterName();
		const data = await apiJson(`${ENDPOINT}/character`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		state.selectedId = data.character?.id || "";
		await refreshCharacters(true);
		setStatus("已创建角色");
	}

	async function deleteCharacter(character) {
		if (!character) return;
		setStatus(`正在删除角色「${character.name || character.id}」...`);
		await apiJson(`${ENDPOINT}/character?id=${encodeURIComponent(character.id)}`, { method: "DELETE" });
		state.selectedId = "";
		await refreshCharacters(false);
		setStatus("角色已删除");
	}

	async function uploadView(character, presetLabel = "") {
		const file = await fileInput("image/*");
		if (!file) return;
		if (!character) {
			const data = await apiJson(`${ENDPOINT}/character`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: autoCharacterName(file) }),
			});
			state.selectedId = data.character?.id || "";
			await refreshCharacters(true);
			character = selectedCharacter();
			if (!character) return;
		}
		const label = presetLabel || baseNameFromFile(file, "正面");
		const form = new FormData();
		form.append("id", character.id);
		form.append("name", character.name || character.id);
		form.append("label", label);
		form.append("file", file, file.name);
		setStatus("正在使用 RMBG 抠图并存入角色库...");
		startImportProgress();
		try {
			const data = await apiJson(`${ENDPOINT}/view`, { method: "POST", body: form });
			state.selectedId = data.character?.id || character.id;
			await refreshCharacters(true);
			finishImportProgress(true);
			setStatus("视图已抠图并存入角色库");
		} catch (error) {
			finishImportProgress(false);
			throw error;
		}
	}

	async function importSheet(character = null) {
		let target = character;
		let name = target?.name || "";
		const file = await fileInput("image/*");
		if (!file) return;
		if (!target) name = autoCharacterName(file);
		const form = new FormData();
		if (target?.id) form.append("id", target.id);
		form.append("name", name || target?.name || target?.id || "新角色");
		form.append("file", file, file.name);
		setStatus("正在分割视图并调用综合抠图...");
		startImportProgress();
		try {
			const data = await apiJson(`${ENDPOINT}/import_sheet`, { method: "POST", body: form });
			state.selectedId = data.character?.id || target?.id || "";
			await refreshCharacters(true);
			finishImportProgress(true);
			setStatus(`已导入 ${data.count || 0} 个透明视图`);
		} catch (error) {
			finishImportProgress(false);
			throw error;
		}
	}

	async function generateMultiview(character = null) {
		let target = character;
		let name = target?.name || "";
		const file = await fileInput("image/*");
		if (!file) return;
		if (!target) name = autoCharacterName(file);
		const form = new FormData();
		if (target?.id) form.append("id", target.id);
		form.append("name", name || target?.name || target?.id || "新角色");
		form.append("file", file, file.name);
		setStatus("正在生成多视图并抠图存入角色库...");
		startImportProgress();
		try {
			const data = await apiJson(`${ENDPOINT}/generate_multiview`, { method: "POST", body: form });
			state.selectedId = data.character?.id || target?.id || "";
			await refreshCharacters(true);
			finishImportProgress(true);
			setStatus(`已生成 ${data.count || 0} 个多视图透明 PNG`);
		} catch (error) {
			finishImportProgress(false);
			throw error;
		}
	}

	function hasCharacterView(character, label) {
		const key = String(label || "").trim().toLowerCase();
		return (character?.views || []).some((view) => String(view?.label || view?.id || "").trim().toLowerCase() === key);
	}

	function missingDefaultViewLabels(character) {
		return VIEW_LABELS.filter((label) => label !== "大头照" && !hasCharacterView(character, label));
	}

	function characterViewLabel(character, keywords = []) {
		const tokens = (keywords || []).map((item) => String(item || "").toLowerCase()).filter(Boolean);
		const views = Array.isArray(character?.views) ? character.views : [];
		for (const view of views) {
			const text = `${view?.label || ""} ${view?.id || ""}`.toLowerCase();
			if (tokens.some((token) => text.includes(token))) return String(view?.label || view?.id || "").trim();
		}
		return "";
	}

	async function generateCharacterViews(character, labels = [], basePrompt = "", referenceLabel = "", promptLabels = [], referenceLabels = null) {
		if (!character?.id) return;
		const requested = (labels || []).map((label) => String(label || "").trim()).filter(Boolean);
		const prompts = (promptLabels || []).map((label) => String(label || "").trim()).filter(Boolean);
		const references = (Array.isArray(referenceLabels) ? referenceLabels : [referenceLabel]).map((label) => String(label || "").trim()).filter(Boolean);
		const reference = references[0] || "";
		if (!requested.length) return;
		if (!references.length && !hasCharacterView(character, "大头照")) {
			setStatus("需要先有大头照，才能用 GJJ_CharacterMultiViewStudio 自动生成其它视图");
			return;
		}
		const form = new FormData();
		form.append("id", character.id);
		form.append("name", character.name || character.id);
		form.append("labels", JSON.stringify(requested));
		if (prompts.length) form.append("prompt_labels", JSON.stringify(prompts));
		const prompt = String(basePrompt || "").trim();
		if (prompt) form.append("base_prompt", prompt);
		if (reference) form.append("reference_label", reference);
		if (references.length > 1) form.append("reference_labels", JSON.stringify(references));
		const referenceText = references.length > 1 ? `${references.length} 张参考图` : (reference || "大头照");
		setStatus(`正在用${referenceText}生成：${requested.join("、")}...`);
		startImportProgress();
		try {
			const data = await apiJson(`${ENDPOINT}/generate_multiview`, { method: "POST", body: form });
			state.selectedId = data.character?.id || character.id;
			await refreshCharacters(true);
			finishImportProgress(true);
			setStatus(`已生成 ${data.count || 0} 个视图：${(data.labels || requested).join("、")}`);
		} catch (error) {
			finishImportProgress(false);
			throw error;
		}
	}

	function customViewOptionValue(option) {
		return String(typeof option === "object" ? option.value : option || "").trim();
	}

	function customViewOptionLabel(option) {
		return String(typeof option === "object" ? option.label : option || "").trim();
	}

	function customViewOptionByValue(group, value) {
		const key = String(value || "").trim();
		return (group.options || []).find((option) => customViewOptionValue(option) === key) || null;
	}

	function combineCustomViewItems(groups) {
		const values = CUSTOM_VIEW_GROUPS.map((group) => {
			const selected = groups[group.key]?.selected || [];
			return selected.length ? selected : [customViewOptionValue(group.options?.[0])];
		});
		const result = [];
		for (const azimuth of values[0]) {
			for (const elevation of values[1]) {
				for (const distance of values[2]) {
					const prompt = `<sks> ${[azimuth, elevation, distance].filter(Boolean).join(" ")}`.trim();
					const display = [
						customViewOptionLabel(customViewOptionByValue(CUSTOM_VIEW_GROUPS[0], azimuth)) || azimuth,
						customViewOptionLabel(customViewOptionByValue(CUSTOM_VIEW_GROUPS[1], elevation)) || elevation,
						customViewOptionLabel(customViewOptionByValue(CUSTOM_VIEW_GROUPS[2], distance)) || distance,
					].filter(Boolean).join("");
					if (prompt && !result.some((item) => item.label === display)) result.push({ label: display, prompt, display });
				}
			}
		}
		return result;
	}

	function combineCustomViewLabels(groups) {
		return combineCustomViewItems(groups).map((item) => item.label);
	}

	function combineCustomViewPrompts(groups) {
		return combineCustomViewItems(groups).map((item) => item.prompt);
	}

	function openCustomViewPicker(character) {
		return new Promise((resolve) => {
			const groups = {};
			for (const group of CUSTOM_VIEW_GROUPS) {
				const optionValues = (group.options || []).map(customViewOptionValue);
				const defaults = Array.isArray(group.defaultSelected) ? group.defaultSelected.filter((item) => optionValues.includes(item)) : [];
				groups[group.key] = { selected: defaults.length ? defaults : (group.required ? [optionValues[0]] : []), anchor: 0 };
			}
			const root = document.createElement("div");
			root.style.cssText = [
				"position:fixed",
				"inset:0",
				"z-index:100003",
				"display:flex",
				"align-items:center",
				"justify-content:center",
				"background:rgba(0,0,0,.46)",
				"padding:18px",
				"box-sizing:border-box",
			].join(";");
			const panel = document.createElement("div");
			panel.style.cssText = [
				"width:min(700px,calc(100vw - 28px))",
				"max-height:min(620px,calc(100vh - 28px))",
				"display:flex",
				"flex-direction:column",
				"gap:8px",
				"border:1px solid #40535b",
				"border-radius:8px",
				"background:#0f171b",
				"color:#e7f2f4",
				"box-shadow:0 18px 48px rgba(0,0,0,.56)",
				"padding:12px",
				"box-sizing:border-box",
				"font-family:system-ui,'Microsoft YaHei',sans-serif",
			].join(";");
			const head = document.createElement("div");
			head.style.cssText = "display:flex;align-items:center;gap:8px;";
			const titleIcon = document.createElement("div");
			titleIcon.textContent = "📹";
			titleIcon.style.cssText = "width:28px;height:28px;border:1px solid #3f535b;border-radius:7px;background:#17242a;display:flex;align-items:center;justify-content:center;font-size:16px;";
			const title = document.createElement("div");
			title.textContent = "自定义生成视图";
			title.style.cssText = "font-size:14px;font-weight:900;flex:1 1 auto;";
			const close = button("×", "关闭", "gjj-cl-btn gjj-cl-icon", () => finish([]));
			head.append(titleIcon, title, close);
			const headReferenceLabel = characterViewLabel(character, ["大头照", "大头", "头像", "头部", "脸", "face", "head", "portrait"]);
			let referenceLabels = headReferenceLabel ? [headReferenceLabel] : [];
			const referenceBox = document.createElement("div");
			referenceBox.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 7px;border:1px solid #263842;border-radius:7px;background:#10191e;";
			const referenceText = document.createElement("div");
			referenceText.textContent = "参考图";
			referenceText.style.cssText = "font-size:12px;font-weight:900;color:#f0faf4;";
			const referenceButtons = document.createElement("div");
			referenceButtons.style.cssText = "display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;";
			const referencePreview = document.createElement("div");
			referencePreview.style.cssText = [
				"position:fixed",
				"z-index:100004",
				"display:none",
				"width:128px",
				"height:128px",
				"border:1px solid #40535b",
				"border-radius:7px",
				"background:#071014",
				"box-shadow:0 12px 28px rgba(0,0,0,.48)",
				"padding:4px",
				"pointer-events:none",
				"box-sizing:border-box",
			].join(";");
			const referencePreviewImg = document.createElement("img");
			referencePreviewImg.alt = "";
			referencePreviewImg.style.cssText = "width:100%;height:100%;object-fit:contain;border-radius:5px;background-image:linear-gradient(45deg,#0a1115 25%,#111c21 25%,#111c21 50%,#0a1115 50%,#0a1115 75%,#111c21 75%);background-size:14px 14px;";
			referencePreview.appendChild(referencePreviewImg);
			const showReferencePreview = (event, view) => {
				if (!view?.url) return;
				referencePreviewImg.src = apiUrl(view.url);
				referencePreview.style.left = `${Math.min(window.innerWidth - 142, Math.max(8, event.clientX + 12))}px`;
				referencePreview.style.top = `${Math.min(window.innerHeight - 142, Math.max(8, event.clientY + 12))}px`;
				referencePreview.style.display = "block";
			};
			const hideReferencePreview = () => {
				referencePreview.style.display = "none";
			};
			const referenceButton = (view, index) => {
				const label = String(view?.label || view?.id || `视图${index + 1}`).trim();
				const item = button(label, `使用「${label}」作为参考图；按 Ctrl/Shift 可多选`, "gjj-cl-btn", (event) => {
					stopBubble(event);
					if (event.shiftKey) {
						const current = referenceLabels.length ? referenceLabels[referenceLabels.length - 1] : "";
						const anchorIndex = Math.max(0, referenceViews.findIndex((itemView) => {
							const itemLabel = String(itemView?.label || itemView?.id || "").trim();
							return itemLabel === current;
						}));
						const start = Math.min(anchorIndex, index);
						const end = Math.max(anchorIndex, index);
						const picked = referenceViews.slice(start, end + 1).map((itemView, itemIndex) => String(itemView?.label || itemView?.id || `视图${start + itemIndex + 1}`).trim()).filter(Boolean);
						referenceLabels = [...new Set([...(event.ctrlKey || event.metaKey ? referenceLabels : []), ...picked])];
					} else if (event.ctrlKey || event.metaKey) {
						if (referenceLabels.includes(label)) {
							referenceLabels = referenceLabels.filter((itemLabel) => itemLabel !== label);
						} else {
							referenceLabels = [...referenceLabels, label];
						}
					} else {
						referenceLabels = [label];
					}
					if (!referenceLabels.length) referenceLabels = [label];
					refreshReferenceButtons();
				});
				item.dataset.referenceLabel = label;
				item.style.height = "24px";
				item.style.padding = "0 7px";
				item.style.maxWidth = "96px";
				item.style.overflow = "hidden";
				item.style.textOverflow = "ellipsis";
				item.addEventListener("mouseenter", (event) => showReferencePreview(event, view));
				item.addEventListener("mousemove", (event) => showReferencePreview(event, view));
				item.addEventListener("mouseleave", hideReferencePreview);
				referenceButtons.appendChild(item);
				return item;
			};
			const referenceViews = Array.isArray(character?.views) ? character.views : [];
			if (!referenceLabels.length && referenceViews[0]) referenceLabels = [String(referenceViews[0]?.label || referenceViews[0]?.id || "").trim()].filter(Boolean);
			referenceViews.forEach((view, index) => referenceButton(view, index));
			if (!referenceViews.length) {
				const emptyReference = document.createElement("div");
				emptyReference.textContent = "暂无视图";
				emptyReference.style.cssText = "color:#8fa4aa;font-size:12px;";
				referenceButtons.appendChild(emptyReference);
			}
			referenceBox.append(referenceText, referenceButtons);
			const columns = document.createElement("div");
			columns.style.cssText = "display:grid;grid-template-columns:1.2fr .9fr .8fr;gap:7px;overflow:auto;";
			const promptBox = document.createElement("div");
			promptBox.style.cssText = "display:flex;flex-direction:column;gap:5px;padding:7px;border:1px solid #263842;border-radius:7px;background:#10191e;";
			const promptLabel = document.createElement("div");
			promptLabel.textContent = "补充提示词";
			promptLabel.style.cssText = "font-size:12px;font-weight:900;color:#f0faf4;";
			const promptInput = document.createElement("textarea");
			promptInput.placeholder = "可输入服装、材质、风格、画面要求等，会追加到本次生成提示词";
			promptInput.style.cssText = [
				"min-height:58px",
				"resize:vertical",
				"border:1px solid #3f535b",
				"border-radius:6px",
				"background:#071014",
				"color:#dce7e2",
				"padding:7px 9px",
				"font-size:12px",
				"line-height:1.45",
				"outline:none",
				"box-sizing:border-box",
				"font-family:system-ui,'Microsoft YaHei',sans-serif",
			].join(";");
			promptBox.append(promptLabel, promptInput);
			const footer = document.createElement("div");
			footer.style.cssText = "display:flex;align-items:center;gap:8px;justify-content:flex-end;";
			const summary = document.createElement("div");
			summary.style.cssText = "flex:1 1 auto;color:#94aeb4;font-size:12px;min-width:0;";
			const cancel = button("取消", "取消", "gjj-cl-btn", () => finish([]));
			const apply = button("生成", "生成选中的视图组合", "gjj-cl-btn", () => finish(combineCustomViewLabels(groups), combineCustomViewPrompts(groups)));
			footer.append(summary, cancel, apply);

			function finish(labels, promptLabels = []) {
				hideReferencePreview();
				referencePreview.remove();
				root.remove();
				resolve({
					labels: labels || [],
					promptLabels: promptLabels || [],
					prompt: String(promptInput?.value || "").trim(),
					referenceLabel: referenceLabels[0] || "",
					referenceLabels: [...referenceLabels],
				});
			}
			function refreshReferenceButtons() {
				for (const item of referenceButtons.querySelectorAll("[data-reference-label]")) {
					const active = referenceLabels.includes(String(item.dataset.referenceLabel || ""));
					item.classList.toggle("active", active);
					item.style.background = active ? "#1d5d39" : "";
					item.style.borderColor = active ? "#65d189" : "";
				}
			}
			function refresh() {
				for (const item of columns.querySelectorAll("[data-custom-view-option]")) {
					const key = item.dataset.customViewKey;
					const value = item.dataset.customViewValue;
					const active = groups[key]?.selected.includes(value);
					item.classList.toggle("active", !!active);
					item.style.background = active ? "#1f7545" : "#17242a";
					item.style.borderColor = active ? "#78df99" : "#3f535b";
					item.style.color = active ? "#fff" : "#dce7e2";
					item.style.boxShadow = active ? "0 0 0 1px rgba(120,223,153,.22) inset" : "none";
				}
				const items = combineCustomViewItems(groups);
				summary.textContent = items.length ? `将生成 ${items.length} 个视图：${items.slice(0, 4).map((item) => item.display).join("、")}${items.length > 4 ? "..." : ""}` : "请选择至少一个视角";
			}
			for (const [groupIndex, group] of CUSTOM_VIEW_GROUPS.entries()) {
				const box = document.createElement("div");
				box.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:0;padding:7px;border:1px solid #263842;border-radius:7px;background:#10191e;";
				const label = document.createElement("div");
				label.textContent = `${groupIndex + 1}. ${group.title}`;
				label.style.cssText = "font-size:12px;font-weight:900;color:#f0faf4;letter-spacing:0;";
				const list = document.createElement("div");
				list.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;min-height:0;";
				group.options.forEach((option, index) => {
					const optionValue = customViewOptionValue(option);
					const optionLabel = customViewOptionLabel(option);
					const item = document.createElement("button");
					item.type = "button";
					item.textContent = optionLabel;
					item.dataset.customViewOption = "1";
					item.dataset.customViewKey = group.key;
					item.dataset.customViewValue = optionValue;
					item.title = optionValue;
					item.style.cssText = "height:24px;border:1px solid #3f535b;border-radius:6px;background:#17242a;color:#dce7e2;font-size:12px;font-weight:800;text-align:center;padding:0 7px;cursor:pointer;white-space:nowrap;";
					item.addEventListener("click", (event) => {
						stopBubble(event);
						const stateForGroup = groups[group.key];
						if (event.shiftKey) {
							const start = Math.min(stateForGroup.anchor, index);
							const end = Math.max(stateForGroup.anchor, index);
							const picked = group.options.slice(start, end + 1).map(customViewOptionValue);
							stateForGroup.selected = [...new Set([...(event.ctrlKey || event.metaKey ? stateForGroup.selected : []), ...picked])];
						} else if (event.ctrlKey || event.metaKey) {
							if (stateForGroup.selected.includes(optionValue)) {
								stateForGroup.selected = stateForGroup.selected.filter((itemValue) => itemValue !== optionValue);
							} else {
								stateForGroup.selected = [...stateForGroup.selected, optionValue];
							}
							stateForGroup.anchor = index;
						} else {
							stateForGroup.selected = [optionValue];
							stateForGroup.anchor = index;
						}
						if (group.required && !stateForGroup.selected.length) stateForGroup.selected = [optionValue];
						refresh();
					});
					list.appendChild(item);
				});
				box.append(label, list);
				columns.appendChild(box);
			}
			refreshReferenceButtons();
			panel.append(head, referenceBox, columns, promptBox, footer);
			root.appendChild(panel);
			root.addEventListener("click", (event) => {
				if (event.target === root) finish([]);
			});
			panel.addEventListener("click", stopBubble);
			document.body.appendChild(root);
			document.body.appendChild(referencePreview);
			refresh();
		});
	}

	async function generateCustomCharacterViews(character) {
		const result = await openCustomViewPicker(character);
		const labels = (Array.isArray(result) ? result : result?.labels) || [];
		if (!labels.length) return;
		await generateCharacterViews(character, labels, result?.prompt || "", result?.referenceLabel || "", result?.promptLabels || [], result?.referenceLabels || null);
	}

	async function generateMultiviewBatch() {
		const files = await fileInputs("image/*");
		if (!files.length) return;
		let selectedId = "";
		let totalViews = 0;
		setStatus(`已加入 ${files.length} 张人物图，开始队列生成四视图...`);
		startImportProgress();
		try {
			for (let index = 0; index < files.length; index += 1) {
				const file = files[index];
				const name = autoCharacterName(file);
				const form = new FormData();
				form.append("name", name);
				form.append("file", file, file.name);
				setStatus(`队列 ${index + 1}/${files.length}：正在生成「${name}」四视图...`);
				const data = await apiJson(`${ENDPOINT}/generate_multiview`, { method: "POST", body: form });
				selectedId = data.character?.id || selectedId;
				totalViews += Number(data.count || 0);
				setProgress(Math.min(96, Math.round(((index + 1) / files.length) * 92)), true);
			}
			state.selectedId = selectedId;
			state.page = 1;
			await refreshCharacters(true);
			finishImportProgress(true);
			setStatus(`队列完成：已生成 ${files.length} 个人物，共 ${totalViews} 个视图`);
		} catch (error) {
			finishImportProgress(false);
			throw error;
		}
	}

	async function annotateMissingNotes() {
		const missing = state.characters.filter((item) => {
			const name = String(item.name || item.id || "").trim();
			return !String(item.notes || "").trim() || !name.startsWith("♀") && !name.startsWith("♂");
		});
		if (!missing.length) {
			setStatus("没有需要补备注或性别符号的角色");
			return;
		}
		setStatus("正在用 Gemma 批量生成角色备注和性别符号...");
		startImportProgress();
		try {
			const data = await apiJson(`${ENDPOINT}/annotate_missing`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					ids: missing.map((item) => item.id).filter(Boolean),
					limit: missing.length,
				}),
			});
			await refreshCharacters(true);
			finishImportProgress(true);
			setStatus(`已更新 ${data.processed_count || 0} 个角色备注/性别符号`);
		} catch (error) {
			finishImportProgress(false);
			throw error;
		}
	}

	async function showModelTree() {
		const data = await apiJson(`${ENDPOINT}/model_tree`);
		const panel = buildPanel();
		panel.querySelector(".gjj-cl-model-backdrop")?.remove();
		const backdrop = document.createElement("div");
		backdrop.className = "gjj-cl-model-backdrop";
		const dialog = document.createElement("div");
		dialog.className = "gjj-cl-model-dialog";
		const head = document.createElement("div");
		head.className = "gjj-cl-model-head";
		const title = document.createElement("div");
		title.className = "gjj-cl-model-title";
		title.textContent = data.title || "模型树";
		const spacer = document.createElement("div");
		spacer.className = "gjj-cl-spacer";
		const values = { ...(data.settings || {}) };
		const save = data.settings_section ? button("保存设置", "保存角色库模型设置", "gjj-cl-btn", async () => {
			await apiJson("/gjj/user_settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ section: data.settings_section, values }),
			});
			setStatus("角色库模型设置已保存");
			await showModelTree();
		}) : null;
		head.append(title, spacer);
		if (save) head.appendChild(save);
		head.appendChild(button("❌关闭", "关闭", "gjj-cl-btn gjj-cl-close", () => backdrop.remove()));
		const body = document.createElement("div");
		body.className = "gjj-cl-model-body";
		const controls = Array.isArray(data.controls) ? data.controls : [];
		for (const group of data.groups || []) {
			const groupEl = document.createElement("div");
			groupEl.className = "gjj-cl-model-group";
			const groupTitle = document.createElement("div");
			groupTitle.className = "gjj-cl-model-group-title";
			groupTitle.textContent = group.name || "模型";
			groupEl.appendChild(groupTitle);
			groupEl.appendChild(buildClickableModelTree(group.items || [], controls, values));
			body.appendChild(groupEl);
		}
		dialog.append(head, body);
		backdrop.appendChild(dialog);
		backdrop.addEventListener("click", (event) => {
			stopBubble(event);
			if (event.target === backdrop) backdrop.remove();
		});
		panel.appendChild(backdrop);
	}

	function showCharacterLibraryHelp() {
		const panel = buildPanel();
		panel.querySelector(".gjj-cl-help-backdrop")?.remove();
		const backdrop = document.createElement("div");
		backdrop.className = "gjj-cl-model-backdrop gjj-cl-help-backdrop";
		const dialog = document.createElement("div");
		dialog.className = "gjj-cl-model-dialog";
		const head = document.createElement("div");
		head.className = "gjj-cl-model-head";
		const title = document.createElement("div");
		title.className = "gjj-cl-model-title";
		title.textContent = "❓ 角色库详细使用方法";
		const spacer = document.createElement("div");
		spacer.className = "gjj-cl-spacer";
		head.append(title, spacer, button("❌关闭", "关闭帮助", "gjj-cl-btn gjj-cl-close", () => backdrop.remove()));
		const body = document.createElement("div");
		body.className = "gjj-cl-model-body";
		body.style.cssText = "display:block;overflow:auto;padding:12px 16px;color:#dce8e4;font:13px/1.65 system-ui,'Microsoft YaHei',sans-serif;";
		body.innerHTML = `
			<section>
				<h3>一、角色库用途</h3>
				<p>角色库用于保存人物身份、外貌、服装、语音路径和不同视图。分镜提示词中使用 <code>@角色名</code> 引用角色；需要指定视图时可写 <code>@角色名/视图名</code>，例如 <code>@小明/背面</code>、<code>@小明/大头照</code>。</p>
			</section>
			<section>
				<h3>二、顶部按钮</h3>
				<ul>
					<li><b>➕ 新增角色：</b>创建空角色资料，再添加图片、备注和音色路径。</li>
					<li><b>👥 批量多视图：</b>一次选择多张人物图片，每张图片建立一个角色并排队生成多视图。</li>
					<li><b>🪄 智能导入：</b>从一张整图中抠出并拆分人物视图，自动建立新角色。</li>
					<li><b>🧑‍🎨 批量打标：</b>使用推理文本编码器补充性别符号与人物备注；已有完整标注的角色会跳过。</li>
					<li><b>🧠 模型树：</b>查看和选择抠图、多视图、LoRA、VAE、CLIP 与备注推理模型，选择后点击“保存设置”。</li>
				</ul>
			</section>
			<section>
				<h3>三、添加与整理视图</h3>
				<ul>
					<li><b>🚀 生成多视图：</b>上传一张参考图，自动生成角色基础角度并抠图保存。</li>
					<li><b>🪄 智能导入整图：</b>适合包含多个站姿或角度的角色设定图。</li>
					<li><b>➕ 添加视图：</b>上传单张图片，经当前抠图模型处理后保存为指定视图。</li>
					<li><b>视图卡片按钮：</b>可复制引用、替换图片、查看原图或删除视图。</li>
					<li>推荐至少保存“大头照、正面、侧面、背面”；视图名称应直观且避免重名。</li>
				</ul>
			</section>
			<section>
				<h3>四、大头照与自动补视图</h3>
				<p>没有大头照时，可从现有视图点击“生成大头照”。大头照会强制使用近距离头肩构图，不显示腰部、腿和鞋。已有大头照后，可用“补全部缺失”或单独的左侧、右侧、45度、半身、动作按钮生成其它视图。</p>
				<p>“自定义视图”可组合方位、俯仰、景别；支持选择一张或多张已有视图作为身份参考。多张参考只用于统一五官、服装和身份，不会把参考拼图画进结果。</p>
			</section>
			<section>
				<h3>五、模型与抠图设置</h3>
				<ul>
					<li>默认多视图链路：Qwen Image Edit 2511 int4、Qwen 2.5 VL int4、Qwen Image VAE、Lightning LoRA 和 Multiple-Angles LoRA。</li>
					<li>多视图 LoRA 使用 Multiple-Angles；分镜生成器的 Next-Scene LoRA 与角色库互不替换。</li>
					<li>抠图默认 RMBG1.4，也可选择 RMBG2、官方背景移除、BiRefNet、BEN2 或 Inspyrenet；切换后必须点击“保存设置”。</li>
					<li>模型树中点击模型行可展开关键词过滤列表；模型名称旁的复制按钮可复制相对模型名。</li>
				</ul>
			</section>
			<section>
				<h3>六、角色资料与音色</h3>
				<p>角色名称用于 <code>@角色名</code> 引用，建议简短且唯一。备注用于描述稳定身份特征和检索。音色填写 <code>models/GJJ/wav</code> 下的相对路径；保存后可供支持角色音色引用的节点使用。</p>
			</section>
			<section>
				<h3>七、常见问题</h3>
				<ul>
					<li><b>生成结果不像参考：</b>优先使用清晰正脸或大头照，避免多人、遮挡、水印和复杂背景。</li>
					<li><b>大头照仍像全身：</b>重启 ComfyUI 后重新生成，确认使用的是更新后的角色库代码。</li>
					<li><b>抠图方法没有变化：</b>在 🧠 模型树选择后点击“保存设置”，重新打开确认树中显示的新方法。</li>
					<li><b>模型列表为空：</b>确认模型放在对应的 ComfyUI/models 子目录，并刷新或重启 ComfyUI。</li>
					<li><b>提示词没有引用角色：</b>人物名称前必须写 @，并与角色库名称一致。</li>
				</ul>
			</section>
		`;
		for (const heading of body.querySelectorAll("h3")) {
			heading.style.cssText = "margin:12px 0 5px;color:#effaf5;font-size:14px;";
		}
		for (const code of body.querySelectorAll("code")) {
			code.style.cssText = "padding:1px 4px;border:1px solid #354950;border-radius:4px;background:#101a1f;color:#a7f3d0;";
		}
		dialog.append(head, body);
		backdrop.appendChild(dialog);
		backdrop.addEventListener("click", (event) => {
			stopBubble(event);
			if (event.target === backdrop) backdrop.remove();
		});
		panel.appendChild(backdrop);
	}

	async function deleteView(character, view) {
		if (!character || !view) return;
		setStatus(`正在删除视图「${view.label || view.id}」...`);
		await apiJson(`${ENDPOINT}/view?id=${encodeURIComponent(character.id)}&view=${encodeURIComponent(view.id)}`, { method: "DELETE" });
		await refreshCharacters(true);
		setStatus("视图已删除");
	}

	async function renameViewLabel(character, view) {
		if (!character || !view) return;
		const current = String(view.label || view.id || "").trim();
		const next = window.prompt("修改视图标签", current);
		if (next === null) return;
		const label = String(next || "").trim();
		if (!label || label === current) return;
		const data = await apiJson(`${ENDPOINT}/view_label`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: character.id, view: view.id, label }),
		});
		state.selectedId = data.character?.id || character.id;
		await refreshCharacters(true);
		setStatus(`视图标签已改为「${label}」`);
	}

	function copyText(text) {
		if (navigator.clipboard?.writeText) {
			return navigator.clipboard.writeText(text);
		}
		const area = document.createElement("textarea");
		area.value = text;
		document.body.appendChild(area);
		area.select();
		document.execCommand("copy");
		area.remove();
		return Promise.resolve();
	}

	function insertAtActiveText(text) {
		const target = document.activeElement;
		if (target && ("value" in target) && typeof target.setRangeText === "function") {
			const start = target.selectionStart ?? target.value.length;
			const end = target.selectionEnd ?? target.value.length;
			target.setRangeText(text, start, end, "end");
			target.dispatchEvent(new Event("input", { bubbles: true }));
			return true;
		}
		return false;
	}

	function sortedCharacters(items) {
		const list = [...items];
		const text = (item) => String(item?.name || item?.id || "").toLocaleLowerCase();
		const updated = (item) => Number(item?.updated_at || 0);
		const totalSize = (item) => (item?.views || []).reduce((sum, view) => sum + Number(view?.size || 0), 0);
		if (state.sort === "name_asc" || state.sort === "name") {
			list.sort((a, b) => text(a).localeCompare(text(b), "zh-Hans"));
		} else if (state.sort === "name_desc") {
			list.sort((a, b) => text(b).localeCompare(text(a), "zh-Hans"));
		} else if (state.sort === "size_desc" || state.sort === "views") {
			list.sort((a, b) => (totalSize(b) - totalSize(a)) || ((b.views?.length || 0) - (a.views?.length || 0)) || text(a).localeCompare(text(b), "zh-Hans"));
		} else if (state.sort === "size_asc") {
			list.sort((a, b) => (totalSize(a) - totalSize(b)) || ((a.views?.length || 0) - (b.views?.length || 0)) || text(a).localeCompare(text(b), "zh-Hans"));
		} else if (state.sort === "updated_asc") {
			list.sort((a, b) => (updated(a) - updated(b)) || text(a).localeCompare(text(b), "zh-Hans"));
		} else {
			list.sort((a, b) => (updated(b) - updated(a)) || text(a).localeCompare(text(b), "zh-Hans"));
		}
		return list;
	}

	function updateSortButtons(panel) {
		panel.querySelectorAll("[data-cl-sort]").forEach((node) => {
			node.classList.toggle("active", node.dataset.clSort === state.sort);
		});
	}

	function updateGenderButtons(panel) {
		panel.querySelectorAll("[data-cl-gender]").forEach((node) => {
			node.classList.toggle("active", node.dataset.clGender === state.gender);
		});
	}

	function characterGender(item) {
		const text = `${item?.name || ""} ${item?.id || ""}`.trim();
		if (text.includes("♀")) return "female";
		if (text.includes("♂")) return "male";
		return "unknown";
	}

	function updatePager(panel, total, pageCount) {
		const label = panel.querySelector("[data-cl-page-label]");
		const prev = panel.querySelector("[data-cl-page-prev]");
		const next = panel.querySelector("[data-cl-page-next]");
		if (label) label.textContent = total ? `${state.page}/${pageCount}` : "0/0";
		if (prev) prev.disabled = state.page <= 1;
		if (next) next.disabled = state.page >= pageCount;
	}

	function renderCharacterList(panel) {
		const list = panel.querySelector(".gjj-cl-list");
		if (!list) return;
		const items = state.characters;
		list.replaceChildren();
		for (const character of items) {
			const card = document.createElement("button");
			card.type = "button";
			card.className = `gjj-cl-card${character.id === state.selectedId ? " active" : ""}`;
			card.title = character.name || character.id;
			const cover = document.createElement("div");
			cover.className = "gjj-cl-cover";
			if (character.cover) {
				const img = document.createElement("img");
				img.src = apiUrl(character.cover);
				cover.appendChild(img);
			} else {
				const empty = document.createElement("div");
				empty.className = "gjj-cl-empty-cover";
				empty.textContent = "👤";
				cover.appendChild(empty);
			}
			const name = document.createElement("div");
			name.className = "gjj-cl-name";
			const icon = document.createElement("span");
			icon.textContent = genderPrefix(character) || "";
			const nameText = document.createElement("span");
			nameText.className = "gjj-cl-name-text";
			nameText.textContent = characterReferenceName(character);
			const count = document.createElement("span");
			count.className = "gjj-cl-count";
			count.textContent = `${character.views?.length || 0}视图`;
			name.append(icon, nameText, count);
			card.append(cover, name);
			card.addEventListener("click", (event) => {
				stop(event);
				state.selectedId = character.id;
				renderPanel();
			});
			list.appendChild(card);
		}
		if (!items.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-cl-empty";
			empty.textContent = "没有匹配角色";
			list.appendChild(empty);
		}
		updateGenderButtons(panel);
		updateSortButtons(panel);
		updatePager(panel, state.total, state.pageCount);
	}

	function renderMain(panel) {
		const main = panel.querySelector(".gjj-cl-main");
		if (!main) return;
		const character = selectedCharacter();
		main.replaceChildren();
		const head = document.createElement("div");
		head.className = "gjj-cl-head";
		const title = document.createElement("div");
		title.className = "gjj-cl-title";
		title.textContent = character ? "角色详情" : "角色库";
		const spacer = document.createElement("div");
		spacer.className = "gjj-cl-spacer";
		const open = button("📂", "打开角色库文件夹", "gjj-cl-btn gjj-cl-icon", () => {
			apiJson(`${ENDPOINT}/open_dir`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: character?.id || "" }),
			}).catch((error) => setStatus(error.message));
		});
		const close = button("❌关闭", "关闭", "gjj-cl-btn gjj-cl-close", closePanel);
		head.append(title, spacer, open, close);

		const body = document.createElement("div");
		body.className = "gjj-cl-body";
		if (!character) {
			const empty = document.createElement("div");
			empty.className = "gjj-cl-empty";
			empty.textContent = "点击左侧新增角色，然后上传图片并自动抠图";
			body.appendChild(empty);
			main.append(head, body);
			return;
		}

		const form = document.createElement("div");
		form.className = "gjj-cl-form";
		const gender = button(genderPrefix(character) || "⚪", "点击切换性别图标：未知 / 女 / 男", "gjj-cl-btn gjj-cl-gender-select", () => {
			const next = nextGenderPrefix(gender.dataset.genderPrefix || genderPrefix(character));
			gender.dataset.genderPrefix = next;
			gender.textContent = next || "⚪";
		});
		gender.dataset.genderPrefix = genderPrefix(character);
		const name = document.createElement("input");
		name.className = "gjj-cl-input";
		name.dataset.clName = "1";
		name.value = displayReferenceInput(character);
		name.placeholder = "@角色名字";
		name.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.isComposing) return;
			stopBubble(event);
			saveCharacterFromForm().catch((error) => setStatus(error.message));
		});
		const save = button("保存", "保存角色名字和备注", "gjj-cl-btn", () => saveCharacterFromForm().catch((error) => setStatus(error.message)));
		const notes = document.createElement("textarea");
		notes.className = "gjj-cl-textarea";
		notes.dataset.clNotes = "1";
		notes.value = character.notes || "";
		notes.placeholder = "备注";
		const voiceRow = document.createElement("div");
		voiceRow.className = "gjj-cl-voice-row";
		const voiceLabel = document.createElement("div");
		voiceLabel.className = "gjj-cl-voice-label";
		voiceLabel.textContent = "📢 音色";
		const voicePath = document.createElement("input");
		voicePath.className = "gjj-cl-voice-path clickable";
		voicePath.dataset.clVoicePath = "1";
		voicePath.value = character.voice_path || "";
		voicePath.placeholder = "models/GJJ/wav 下的相对路径，默认同名 .wav，兼容 .mp3";
		voicePath.addEventListener("click", (event) => {
			stopBubble(event);
			openVoicePicker(character, voicePath).catch((error) => setStatus(error.message));
		});
		const chooseVoice = button("选择", "从 models/GJJ/wav 列表中搜索/试听/选择音色", "gjj-cl-btn", () => openVoicePicker(character, chooseVoice).catch((error) => setStatus(error.message)));
		const clearVoiceButton = button("清除", "清除当前角色音色路径", "gjj-cl-btn", () => clearVoice(character).catch((error) => setStatus(error.message)));
		const saveVoiceButton = button("保存", "保存音色相对路径", "gjj-cl-btn", () => saveCharacterFromForm().catch((error) => setStatus(error.message)));
		voiceRow.append(voiceLabel, voicePath, chooseVoice, clearVoiceButton, saveVoiceButton);
		if (character.voice_url) {
			const player = document.createElement("audio");
			player.className = "gjj-cl-voice-player";
			player.controls = true;
			player.preload = "none";
			player.src = apiUrl(character.voice_url);
			voiceRow.appendChild(player);
		}
		form.append(gender, name, save, notes, voiceRow);

		const actions = document.createElement("div");
		actions.className = "gjj-cl-row";
		actions.append(
			button("🚀 生成多视图", "上传单张参考图，调用 GJJ_CharacterMultiViewStudio 生成多视图", "gjj-cl-btn", () => generateMultiview(character).catch((error) => setStatus(error.message))),
			button("🪄 智能导入整图", "上传普通图片，自动白底抠图并分割成多个角色视图", "gjj-cl-btn", () => importSheet(character).catch((error) => setStatus(error.message))),
			button("➕ 添加视图", "上传图片，使用 RMBG 抠图后作为新视图", "gjj-cl-btn", () => uploadView(character).catch((error) => setStatus(error.message))),
			button("复制 @引用", "复制角色引用", "gjj-cl-btn", () => copyText(characterReference(character)).then(() => setStatus("已复制角色引用"))),
			button("插入 @引用", "插入到当前文本框", "gjj-cl-btn", () => setStatus(insertAtActiveText(characterReference(character)) ? "已插入引用" : "请先点一下目标文本框")),
			button("删除角色", "删除角色和全部视图", "gjj-cl-btn danger", () => deleteCharacter(character).catch((error) => setStatus(error.message)))
		);
		const quick = document.createElement("div");
		quick.className = "gjj-cl-row";
		if (hasCharacterView(character, "大头照")) {
			const missingLabels = missingDefaultViewLabels(character);
			if (missingLabels.length > 1) {
				quick.appendChild(button("补全部缺失", `使用大头照生成：${missingLabels.join("、")}`, "gjj-cl-btn", () => generateCharacterViews(character, missingLabels).catch((error) => setStatus(error.message))));
			}
			for (const label of missingLabels) {
				quick.appendChild(button(label, `使用大头照自动生成 ${label} 视图`, "gjj-cl-btn", () => generateCharacterViews(character, [label]).catch((error) => setStatus(error.message))));
			}
			quick.appendChild(button("自定义视图", "选择一个或多个视角、景别、角度，用大头照自动生成", "gjj-cl-btn", () => generateCustomCharacterViews(character).catch((error) => setStatus(error.message))));
		} else {
			const referenceView = (character.views || [])[0];
			const referenceLabel = String(referenceView?.label || referenceView?.id || "").trim();
			if (referenceLabel) {
				quick.appendChild(button("生成大头照", `使用「${referenceLabel}」作为参考，自动生成大头照`, "gjj-cl-btn", () => generateCharacterViews(character, ["大头照"], "", referenceLabel).catch((error) => setStatus(error.message))));
			} else {
				const hint = document.createElement("div");
				hint.className = "gjj-cl-status";
				hint.textContent = "请先添加一张角色视图，再自动生成大头照";
				quick.appendChild(hint);
			}
		}
		const status = document.createElement("div");
		status.className = "gjj-cl-status";
		status.textContent = state.status || "";
		const progress = document.createElement("div");
		progress.className = `gjj-cl-progress${state.progressVisible ? " open" : ""}`;
		const progressBar = document.createElement("div");
		progressBar.className = "gjj-cl-progress-bar";
		progressBar.style.width = `${state.progress}%`;
		progress.appendChild(progressBar);
		const views = document.createElement("div");
		views.className = "gjj-cl-views";
		for (const view of character.views || []) {
			views.appendChild(renderView(character, view));
		}
		if (!character.views?.length) {
		const empty = document.createElement("div");
		empty.className = "gjj-cl-empty";
		const emptyInner = document.createElement("div");
		emptyInner.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;";
		const emptyText = document.createElement("div");
		emptyText.textContent = "还没有视图，可以直接智能导入拼版图";
		emptyInner.append(
			emptyText,
			button("🚀 生成多视图", "上传单张参考图，调用 GJJ_CharacterMultiViewStudio 生成多视图", "gjj-cl-btn", () => generateMultiview(character).catch((error) => setStatus(error.message))),
			button("🪄 智能导入整图", "上传普通图片，自动白底抠图并分割成多个角色视图", "gjj-cl-btn", () => importSheet(character).catch((error) => setStatus(error.message)))
		);
		empty.appendChild(emptyInner);
		views.appendChild(empty);
		}
		body.append(form, actions, quick, status, progress, views);
		main.append(head, body);
	}

	function renderView(character, view) {
		const wrap = document.createElement("div");
		wrap.className = "gjj-cl-view";
		const imgBox = document.createElement("button");
		imgBox.type = "button";
		imgBox.className = "gjj-cl-view-img";
		imgBox.title = "点击放大";
		const img = document.createElement("img");
		img.src = apiUrl(view.url || "");
		imgBox.appendChild(img);
		imgBox.addEventListener("click", (event) => {
			stopBubble(event);
			showLightbox(img.src);
		});
		const title = document.createElement("div");
		title.className = "gjj-cl-view-title";
		title.textContent = view.label || view.id;
		title.title = "双击修改标签";
		title.addEventListener("dblclick", (event) => {
			stopBubble(event);
			renameViewLabel(character, view).catch((error) => setStatus(error.message));
		});
		const refText = `${characterReference(character)}/${view.label || view.id}`;
		const row = document.createElement("div");
		row.className = "gjj-cl-view-actions";
		row.append(
			button("📋", "复制这个视图的 @引用", "gjj-cl-btn", () => copyText(refText).then(() => setStatus("已复制视图引用"))),
			button("↪", "插入到当前文本框", "gjj-cl-btn", () => setStatus(insertAtActiveText(refText) ? "已插入视图引用" : "请先点一下目标文本框")),
			button("🔁", "上传图片，使用 RMBG 抠图后替换此视图", "gjj-cl-btn", () => uploadView(character, view.label || view.id).catch((error) => setStatus(error.message))),
			button("🗑", "删除此视图", "gjj-cl-btn danger", () => deleteView(character, view).catch((error) => setStatus(error.message)))
		);
		wrap.append(imgBox, title, row);
		return wrap;
	}

	function showLightbox(src) {
		if (!src) return;
		installStyle();
		let box = document.getElementById(LIGHTBOX_ID);
		if (!box) {
			box = document.createElement("div");
			box.id = LIGHTBOX_ID;
			const image = document.createElement("img");
			box.appendChild(image);
			const view = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, baseX: 0, baseY: 0 };
			const apply = () => {
				image.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
			};
			const reset = () => {
				view.scale = 1;
				view.x = 0;
				view.y = 0;
				apply();
			};
			box.__gjjLightboxReset = reset;
			box.addEventListener("click", (event) => {
				stopBubble(event);
				if (event.target !== box) return;
				box.classList.remove("open");
				reset();
			});
			box.addEventListener("wheel", (event) => {
				stopBubble(event);
				const previous = view.scale;
				const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
				const next = Math.max(0.35, Math.min(8, previous * factor));
				if (Math.abs(next - previous) < 0.001) return;
				const rect = image.getBoundingClientRect();
				const cx = event.clientX - (rect.left + rect.width / 2);
				const cy = event.clientY - (rect.top + rect.height / 2);
				view.x -= cx * (next / previous - 1);
				view.y -= cy * (next / previous - 1);
				view.scale = next;
				apply();
			}, { passive: false });
			image.addEventListener("pointerdown", (event) => {
				stopBubble(event);
				view.dragging = true;
				view.startX = event.clientX;
				view.startY = event.clientY;
				view.baseX = view.x;
				view.baseY = view.y;
				image.classList.add("dragging");
				image.setPointerCapture?.(event.pointerId);
			});
			image.addEventListener("pointermove", (event) => {
				if (!view.dragging) return;
				stopBubble(event);
				view.x = view.baseX + event.clientX - view.startX;
				view.y = view.baseY + event.clientY - view.startY;
				apply();
			});
			image.addEventListener("pointerup", (event) => {
				stopBubble(event);
				view.dragging = false;
				image.classList.remove("dragging");
				image.releasePointerCapture?.(event.pointerId);
			});
			image.addEventListener("pointercancel", () => {
				view.dragging = false;
				image.classList.remove("dragging");
			});
			image.addEventListener("dblclick", (event) => {
				stopBubble(event);
				reset();
			});
			document.body.appendChild(box);
		}
		const image = box.querySelector("img");
		box.__gjjLightboxReset?.();
		if (image) image.src = src;
		box.classList.add("open");
	}

	function button(text, title, className, onClick) {
		const el = document.createElement("button");
		el.type = "button";
		el.className = className;
		el.textContent = text;
		el.title = title;
		el.addEventListener("pointerdown", stopBubble, true);
		el.addEventListener("mousedown", stopBubble, true);
		el.addEventListener("click", (event) => {
			stopBubble(event);
			onClick?.(event);
		});
		return el;
	}

	function panelBoundsPosition(panel, left, top) {
		const width = panel.offsetWidth || Math.min(920, window.innerWidth - 20);
		const height = panel.offsetHeight || Math.min(680, window.innerHeight - 20);
		return {
			left: Math.round(Math.max(10, Math.min(window.innerWidth - width - 10, Number(left) || 10))),
			top: Math.round(Math.max(10, Math.min(window.innerHeight - height - 10, Number(top) || 10))),
		};
	}

	function panelBoundsSize(width, height) {
		return {
			width: Math.round(Math.min(Math.max(560, Number(width) || 920), Math.max(560, window.innerWidth - 16))),
			height: Math.round(Math.min(Math.max(420, Number(height) || 680), Math.max(420, window.innerHeight - 16))),
		};
	}

	function applyPanelSize(panel, size) {
		if (!panel || !size) return;
		const next = panelBoundsSize(size.width, size.height);
		panel.style.width = `${next.width}px`;
		panel.style.height = `${next.height}px`;
		state.panelSize = next;
		saveSharedPanelLayout();
	}

	function applyPanelPosition(panel, position) {
		if (!panel || !position) return;
		const next = panelBoundsPosition(panel, position.left, position.top);
		panel.style.left = `${next.left}px`;
		panel.style.top = `${next.top}px`;
		state.panelPosition = next;
		saveSharedPanelLayout();
	}

	function installPanelResizeMemory(panel) {
		let last = "";
		const observer = new ResizeObserver(() => {
			if (!panel.classList.contains("open")) return;
			const rect = panel.getBoundingClientRect();
			const next = panelBoundsSize(rect.width, rect.height);
			const key = `${next.width}x${next.height}`;
			if (key === last) return;
			last = key;
			state.panelSize = next;
			applyPanelPosition(panel, panelBoundsPosition(panel, rect.left, rect.top));
			saveSharedPanelLayout();
		});
		observer.observe(panel);
	}

	function makePanelDragHandle(panel) {
		const handle = document.createElement("button");
		handle.type = "button";
		handle.className = "gjj-cl-drag";
		handle.textContent = "⠿";
		handle.title = "拖动角色库窗口；双击复位";
		handle.addEventListener("dblclick", (event) => {
			stopBubble(event);
			state.panelPosition = null;
			state.panelSize = null;
			panel.style.width = "";
			panel.style.height = "";
			saveSharedPanelLayout();
			positionPanel(state.lastAnchor || document.getElementById(BUTTON_ID));
		});
		handle.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			stopBubble(event);
			const rect = panel.getBoundingClientRect();
			const start = {
				x: event.clientX,
				y: event.clientY,
				left: rect.left,
				top: rect.top,
			};
			try { handle.setPointerCapture?.(event.pointerId); } catch (_) {}
			const move = (moveEvent) => {
				stopBubble(moveEvent);
				applyPanelPosition(panel, {
					left: start.left + moveEvent.clientX - start.x,
					top: start.top + moveEvent.clientY - start.y,
				});
			};
			const up = (upEvent) => {
				stopBubble(upEvent);
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", up, true);
		}, true);
		return handle;
	}

	function buildPanel() {
		installStyle();
		let panel = document.getElementById(PANEL_ID);
		if (panel) return panel;
		panel = document.createElement("div");
		panel.id = PANEL_ID;
		panel.addEventListener("pointerdown", (event) => event.stopPropagation());
		panel.addEventListener("mousedown", (event) => event.stopPropagation());
		panel.addEventListener("click", (event) => event.stopPropagation());
		installPanelResizeMemory(panel);

		const sidebar = document.createElement("div");
		sidebar.className = "gjj-cl-sidebar";
		const head = document.createElement("div");
		head.className = "gjj-cl-head";
		const drag = makePanelDragHandle(panel);
		const title = document.createElement("div");
		title.className = "gjj-cl-title";
		title.textContent = "角色库";
		const spacer = document.createElement("div");
		spacer.className = "gjj-cl-spacer";
		head.append(drag, title, spacer, button("➕", "新增角色", "gjj-cl-btn gjj-cl-icon", () => createCharacter().catch((error) => setStatus(error.message))));
		head.appendChild(button("👥", "批量选择人物图片，自动队列生成四视图", "gjj-cl-btn gjj-cl-icon", () => generateMultiviewBatch().catch((error) => setStatus(error.message))));
		head.appendChild(button("🪄", "智能导入整图为新角色", "gjj-cl-btn gjj-cl-icon", () => importSheet(null).catch((error) => setStatus(error.message))));
		head.appendChild(button("🧑‍🎨", "批量给角色补备注和性别符号", "gjj-cl-btn gjj-cl-icon", () => annotateMissingNotes().catch((error) => setStatus(error.message))));
		head.appendChild(button("🧠", "查看并设置角色库使用的模型树", "gjj-cl-btn gjj-cl-icon", () => showModelTree().catch((error) => setStatus(error.message))));
		head.appendChild(button("❓", "查看整个角色库的详细实用方法", "gjj-cl-btn gjj-cl-icon", showCharacterLibraryHelp));
		const search = document.createElement("input");
		search.className = "gjj-cl-search";
		search.placeholder = "搜索角色";
		search.value = state.search;
		search.addEventListener("input", () => {
			state.search = search.value || "";
			state.page = 1;
			refreshCharacters(true).catch((error) => setStatus(error.message));
		});
		const tools = document.createElement("div");
		tools.className = "gjj-cl-tools";
		for (const [value, label] of [
			["all", "全部"],
			["female", "♀️"],
			["male", "♂️"],
		]) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = "gjj-cl-filter-btn";
			item.dataset.clGender = value;
			item.textContent = label;
			item.title = value === "all" ? "显示全部角色" : `只显示${label}角色`;
			item.addEventListener("click", () => {
				state.gender = value;
				state.page = 1;
				refreshCharacters(true).catch((error) => setStatus(error.message));
			});
			tools.appendChild(item);
		}
		const divider = document.createElement("div");
		divider.className = "gjj-cl-tool-divider";
		tools.appendChild(divider);
		const sortLabel = document.createElement("span");
		sortLabel.className = "gjj-cl-sort-label";
		sortLabel.textContent = "排序";
		tools.appendChild(sortLabel);
		for (const [value, label] of [
			["updated_desc", "🕘 最新"],
			["updated_asc", "⏳ 最旧"],
			["size_desc", "📦 大文件"],
			["size_asc", "📦 小文件"],
			["name_asc", "🔤 A-Z"],
			["name_desc", "🔡 Z-A"],
		]) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = "gjj-cl-sort-btn";
			item.dataset.clSort = value;
			item.textContent = label;
			item.addEventListener("click", () => {
				state.sort = value;
				state.page = 1;
				refreshCharacters(true).catch((error) => setStatus(error.message));
			});
			tools.appendChild(item);
		}
		const list = document.createElement("div");
		list.className = "gjj-cl-list";
		const pager = document.createElement("div");
		pager.className = "gjj-cl-pager";
		const prev = button("‹", "上一页", "gjj-cl-btn gjj-cl-page-btn", () => {
			state.page = Math.max(1, state.page - 1);
			refreshCharacters(true).catch((error) => setStatus(error.message));
		});
		prev.dataset.clPagePrev = "1";
		const pageLabel = document.createElement("div");
		pageLabel.className = "gjj-cl-page-label";
		pageLabel.dataset.clPageLabel = "1";
		pageLabel.textContent = "0/0";
		const next = button("›", "下一页", "gjj-cl-btn gjj-cl-page-btn", () => {
			state.page = Math.min(state.pageCount, state.page + 1);
			refreshCharacters(true).catch((error) => setStatus(error.message));
		});
		next.dataset.clPageNext = "1";
		pager.append(prev, pageLabel, next);
		sidebar.append(head, search, tools, list, pager);
		const main = document.createElement("div");
		main.className = "gjj-cl-main";
		panel.append(sidebar, main);
		document.body.appendChild(panel);
		return panel;
	}

	function renderPanel() {
		const panel = buildPanel();
		renderCharacterList(panel);
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
		applyPanelPosition(panel, panelBoundsPosition(panel, rect.left, rect.bottom + 8));
		state.panelPosition = null;
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
		try { globalThis.GJJ_SceneLibrary?.close?.(); } catch (_) {}
		try { globalThis.GJJ_CostumeLibrary?.close?.(); } catch (_) {}
		panel.classList.add("open");
		document.getElementById(BUTTON_ID)?.classList.add("active");
		positionPanel(anchor);
		await refreshCharacters(true).catch((error) => setStatus(error.message));
		positionPanel(anchor);
	}

	function ensureToolbarButton() {
		installStyle();
		const toolbar = document.getElementById(TOOLBAR_ID);
		if (!toolbar || document.getElementById(BUTTON_ID)) return;
		const btn = document.createElement("button");
		btn.id = BUTTON_ID;
		btn.type = "button";
		btn.textContent = "👤";
		btn.title = "角色库：管理人物与视图";
		btn.setAttribute("aria-label", btn.title);
		btn.addEventListener("pointerdown", stop, true);
		btn.addEventListener("mousedown", stop, true);
		btn.addEventListener("mouseup", stop, true);
		btn.addEventListener("click", (event) => {
			stop(event);
			togglePanel(btn);
		});
		const color = document.getElementById(COLOR_BUTTON_ID);
		if (color?.parentElement === toolbar) color.after(btn);
		else toolbar.appendChild(btn);
	}

	function installDismiss() {
		if (window.__gjjCharacterLibraryDismissInstalled) return;
		window.__gjjCharacterLibraryDismissInstalled = true;
	}

	function installToolbarObserver() {
		ensureToolbarButton();
		if (window.__gjjCharacterLibraryToolbarObserver) return;
		window.__gjjCharacterLibraryToolbarObserver = true;
		const observer = new MutationObserver(() => ensureToolbarButton());
		observer.observe(document.body, { childList: true, subtree: true });
		for (const delay of [100, 400, 1200, 2600]) setTimeout(ensureToolbarButton, delay);
	}

	async function resolveReference(reference) {
		const text = String(reference || "").trim().replace(/^@/, "");
		const [name, view = ""] = text.split("/");
		if (!name) return null;
		const data = await apiJson(`${ENDPOINT}/resolve?name=${encodeURIComponent(name)}&view=${encodeURIComponent(view)}`);
		return data;
	}

	function referenceText(character, view = null) {
		const name = characterReferenceName(character);
		const label = view?.label || view?.id || "";
		return label ? `@${name}/${label}` : `@${name}`;
	}

	function installPublicApi() {
		globalThis.GJJ_CharacterLibrary = {
			open: togglePanel,
			close: closePanel,
			refresh: refreshCharacters,
			resolve: resolveReference,
			referenceText,
			get characters() {
				return state.characters.slice();
			},
		};
	}

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			installStyle();
			installPublicApi();
			installDismiss();
			installToolbarObserver();
			refreshCharacters(true).catch(() => {});
			dirtyCanvas();
		},
	});
})();

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { setGjjLibraryThumbnail } from "./gjj_library_thumbnails.js";

const NODE_TYPE = "GJJ_MiniMaxH3SkillStudio";
const PANEL_NAME = "__gjj_h3_skills_toolbar";
const STYLE_ID = "gjj-h3-skills-toolbar-style";
const CHARACTER_LIBRARY_ENDPOINT = "/gjj/character_library/list?summary=1";
const SCENE_LIBRARY_ENDPOINT = "/gjj/scene_library/thumbnail_index";
const LIBRARIES = {
	actor: { icon: "👤", title: "角色库", endpoint: CHARACTER_LIBRARY_ENDPOINT, key: "characters", widget: "角色库选择", marker: "@", thumbnail: "character" },
	scene: { icon: "🏕️", title: "场景库", endpoint: SCENE_LIBRARY_ENDPOINT, key: "scenes", widget: "场景库选择", marker: "🏕️", thumbnail: "scene" },
};
const HIDDEN_SETTINGS = ["技能模式", "交付内容", "H3模式", "时长", "画面比例", "内容语言", "启用媒体反推", "保留模型", "反推模型", "反推最大Token", "反推采样", "反推温度", "反推TopP", "反推重复惩罚", "角色库选择", "场景库选择", "视觉风格", "音乐风格", "切镜次数"];
let characterLibraryPromise = null;

function widget(node, name) { return GJJ_Utils.getWidget(node, name); }
function protect(element) { for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "contextmenu"]) element.addEventListener(name, (event) => event.stopPropagation()); }
function setValue(node, name, value) { const target = widget(node, name); if (!target) return; target.value = value; if (target.inputEl && "value" in target.inputEl) target.inputEl.value = value; if (target.element && "value" in target.element) target.element.value = value; target.callback?.(value); node.graph?.change?.(); app.graph?.setDirtyCanvas?.(true, true); }
function values(node, name) {
	const target = widget(node, name); let result = target?.options?.values || target?.options?.items || target?.values;
	if (typeof result === "function") try { result = result(); } catch (_) { result = []; }
	if (Array.isArray(result) && result.length) return result;
	const input = node?.constructor?.nodeData?.input || node?.constructor?.nodeData?.inputs || {};
	const definition = input?.required?.[name] || input?.optional?.[name];
	return Array.isArray(definition?.[0]) ? definition[0] : [];
}
function inputDefinition(node, name) {
	const input = node?.constructor?.nodeData?.input || node?.constructor?.nodeData?.inputs || {};
	return input?.required?.[name] || input?.optional?.[name] || null;
}
function modelTreeEntry(node, name) {
	const target = widget(node, name);
	const definition = inputDefinition(node, name);
	const metadata = definition?.[1] || {};
	const defaultModel = String(metadata.gjj_default_model || metadata.default || "");
	const familyFilter = (_entry = null, currentWidget = target) =>
		GJJ_Utils._modelTreeFamilyStem(currentWidget?.value || defaultModel);
	return {
		widget: name,
		label: String(metadata.gjj_model_label || target?.label || name),
		folder: String(metadata.gjj_model_folder || "models"),
		icon: String(metadata.gjj_model_icon || "🧠"),
		models: values(node, name),
		defaultModel,
		fallback: defaultModel,
		missingDefault: metadata.gjj_default_missing === true,
		searchValue: familyFilter,
		stateSearchValue: familyFilter,
		autoSelect: true,
		autoSelectSearchValue: (entry, currentWidget) =>
			GJJ_Utils._modelTreeResolvedSearchValue(entry, currentWidget, node),
		floatingChoices: false,
		description: String(metadata.tooltip || "选择模型；过滤框会自动使用当前模型的系列组名。"),
	};
}
function renderModelTree(node, host, modelNames) {
	const refresh = () => renderModelTree(node, host, modelNames);
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: modelNames.map((name) => modelTreeEntry(node, name)),
		onApply: () => queueMicrotask(refresh),
	});
	host.replaceChildren(tree);
}
function installStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style"); style.id = STYLE_ID; style.textContent = `
	.gjj-h3s-row{display:flex;gap:0;width:100%;padding:2px 0}.gjj-h3s-button{flex:1;height:31px;border:1px solid #47727a;border-right:0;background:#173038;color:#fff;font-size:18px;cursor:pointer}.gjj-h3s-button:first-child{border-radius:6px 0 0 6px}.gjj-h3s-button:last-child{border-right:1px solid #47727a;border-radius:0 6px 6px 0}.gjj-h3s-button:hover,.gjj-h3s-button.active{background:#17614e;border-color:#55d2a2}
	.gjj-h3s-pop{position:fixed;z-index:100020;display:none;width:min(440px,calc(100vw - 24px));max-height:min(680px,82vh);overflow:auto;padding:10px;border:1px solid #4d7d86;border-radius:9px;background:#101a1e;color:#e7f3f4;box-shadow:0 16px 44px #000c}.gjj-h3s-pop.open{display:grid;gap:9px}.gjj-h3s-title{font-weight:900;color:#83ddd2;border-bottom:1px solid #29444a;padding-bottom:7px}.gjj-h3s-field{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px;align-items:center;color:#a9c1c5}.gjj-h3s-control{box-sizing:border-box;width:100%;min-width:0;min-height:32px;border:1px solid #365d65;border-radius:5px;background:#091316;color:#effafa;padding:6px}.gjj-h3s-toggle-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.gjj-h3s-toggle{cursor:pointer;font-weight:700}.gjj-h3s-toggle.active{background:#17614e;border-color:#55d2a2}
	.gjj-h3s-choice-list{display:flex;flex-direction:column;gap:3px;max-height:min(520px,70vh);overflow:auto}.gjj-h3s-choice{min-height:31px;padding:5px 9px;border:1px solid transparent;border-radius:5px;background:#0b1519;color:#dbe9eb;text-align:left;cursor:pointer}.gjj-h3s-choice:hover{border-color:#528079;background:#173038}.gjj-h3s-choice.selected{order:-1;border-color:#55d2a2;background:#17614e;color:#fff;font-weight:800}.gjj-h3s-choice.selected:before{content:"✓ ";color:#9ff2cd}
	.gjj-h3s-choice-group{display:grid;gap:5px}.gjj-h3s-choice-label{color:#9fc8bd;font-size:12px;font-weight:800}.gjj-h3s-choice-group+.gjj-h3s-choice-group{padding-top:8px;border-top:1px solid #29444a}
	.gjj-h3s-time-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px}.gjj-h3s-time-button{min-height:31px;border:1px solid #365d65;border-radius:5px;background:#0b1519;color:#dbe9eb;cursor:pointer}.gjj-h3s-time-button:hover{border-color:#55d2a2;background:#173038}.gjj-h3s-time-button.selected{border-color:#55d2a2;background:#17614e;color:#fff;font-weight:900}
	.gjj-h3s-result{display:grid;gap:6px;width:100%;padding-top:4px}.gjj-h3s-result-head{display:flex;align-items:center;justify-content:space-between;color:#9fc8bd;font-size:12px;font-weight:800}.gjj-h3s-copy{min-height:25px;padding:3px 10px;border:1px solid #47727a;border-radius:5px;background:#173038;color:#eafffa;cursor:pointer}.gjj-h3s-copy:hover{border-color:#55d2a2;background:#17614e}.gjj-h3s-result-text{box-sizing:border-box;width:100%;height:190px;resize:vertical;border:1px solid #365d65;border-radius:6px;background:#091316;color:#e7f3f4;padding:8px;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap}
	.gjj-h3s-button.selected{background:#3b315f;border-color:#aa91ef}.gjj-h3s-library{position:fixed;z-index:100030;display:grid;grid-template-rows:auto auto minmax(80px,1fr);gap:8px;width:min(620px,calc(100vw - 24px));max-height:min(620px,82vh);padding:12px;border:1px solid #59707a;border-radius:11px;background:#10191e;color:#eaf5f6;box-shadow:0 22px 70px #000d;font:12px/1.4 system-ui,sans-serif}.gjj-h3s-library-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:16px;font-weight:900}.gjj-h3s-library-tools{display:flex;gap:6px}.gjj-h3s-library-tools input{flex:1;min-width:0;padding:7px;border:1px solid #40575f;border-radius:6px;background:#0b1317;color:#fff}.gjj-h3s-library-tools button{padding:5px 10px;border:1px solid #526a73;border-radius:6px;background:#1a2930;color:#fff;cursor:pointer}.gjj-h3s-library-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));align-content:start;gap:5px;overflow:auto}.gjj-h3s-library-card{position:relative;height:92px;padding:0;overflow:hidden;border:1px solid #40515a;border-radius:6px;background:#091114;color:#fff;cursor:pointer}.gjj-h3s-library-card:hover,.gjj-h3s-library-card.active{outline:2px solid #6fc696;outline-offset:-2px}.gjj-h3s-library-card.active:after{content:"✓";position:absolute;right:5px;top:2px;color:#9be0b5;font-weight:900;text-shadow:0 1px 2px #000}.gjj-h3s-library-card img{display:block;width:100%;height:100%;object-fit:cover}.gjj-h3s-library-card span{position:absolute;left:0;right:0;bottom:0;padding:15px 3px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:linear-gradient(transparent,#000e);font-size:10px;font-weight:800;text-align:center}.gjj-h3s-mention{position:fixed;z-index:100040;display:flex;flex-direction:column;gap:3px;max-height:280px;overflow:auto;padding:6px;border:1px solid #58746d;border-radius:8px;background:#0d1619fa;color:#eaf6f1;box-shadow:0 16px 38px #000a;font:12px/1.35 system-ui,sans-serif}.gjj-h3s-mention-title{padding:3px 6px 5px;color:#9fc8bd;font-size:11px;font-weight:800}.gjj-h3s-mention-item{display:grid;grid-template-columns:34px minmax(0,1fr);gap:7px;align-items:center;min-height:42px;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:#eaf6f1;text-align:left;cursor:pointer}.gjj-h3s-mention-item:hover,.gjj-h3s-mention-item.active{background:#6fc6962e}.gjj-h3s-mention-item img{width:34px;height:34px;border-radius:50%;object-fit:cover}.gjj-h3s-mention-item strong,.gjj-h3s-mention-item small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gjj-h3s-mention-item small{color:#9fb0b5}`;
	document.head.appendChild(style);
}
function selectControl(node, name) {
	const select = document.createElement("select"); select.className = "gjj-h3s-control"; select.dataset.setting = name; select.dataset.kind = "select";
	for (const item of values(node, name)) { const option = document.createElement("option"); option.value = String(item); option.textContent = String(item); select.appendChild(option); }
	select.value = String(widget(node, name)?.value ?? ""); select.addEventListener("change", () => setValue(node, name, select.value)); protect(select); return select;
}
function numberControl(node, name) {
	const target = widget(node, name); const metadata = inputDefinition(node, name)?.[1] || {}; const fallback = Number(metadata.default ?? target?.value ?? 0); const minimum = Number(metadata.min ?? Number.MIN_SAFE_INTEGER); const maximum = Number(metadata.max ?? Number.MAX_SAFE_INTEGER); const input = document.createElement("input"); input.type = "number"; input.className = "gjj-h3s-control"; input.dataset.setting = name; input.dataset.kind = "number"; input.min = String(minimum); input.max = String(maximum); input.step = String(metadata.step ?? "any"); input.value = String(target?.value ?? fallback); input.addEventListener("change", () => { const parsed = Number(input.value); setValue(node, name, Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback); }); protect(input); return input;
}
function toggleControl(node, name, label) {
	const button = document.createElement("button"); button.type = "button"; button.className = "gjj-h3s-control gjj-h3s-toggle"; button.dataset.setting = name; button.dataset.kind = "toggle";
	const sync = () => { const enabled = Boolean(widget(node, name)?.value); button.textContent = label; button.title = `${label}：${enabled ? "已开启" : "已关闭"}`; button.classList.toggle("active", enabled); };
	button.__gjjSync = sync;
	button.addEventListener("click", () => { setValue(node, name, !Boolean(widget(node, name)?.value)); sync(); }); protect(button); sync(); return button;
}
function choiceListControl(node, name, closeAfterChoice = false) {
	const list = document.createElement("div"); list.className = "gjj-h3s-choice-list"; list.dataset.setting = name; list.dataset.kind = "choices";
	const render = () => {
		const current = String(widget(node, name)?.value ?? "");
		const ordered = values(node, name).map(String).sort((left, right) => Number(right === current) - Number(left === current));
		list.replaceChildren();
		for (const value of ordered) {
			const item = document.createElement("button"); item.type = "button"; item.className = `gjj-h3s-choice${value === current ? " selected" : ""}`; item.textContent = value;
			item.addEventListener("click", () => { setValue(node, name, value); if (closeAfterChoice) close(node); else render(); }); protect(item); list.appendChild(item);
		}
	};
	list.__gjjSync = render; render(); return list;
}
function popup(node, title, fields) {
	const root = document.createElement("div"); root.className = "gjj-h3s-pop"; protect(root);
	const heading = document.createElement("div"); heading.className = "gjj-h3s-title"; heading.textContent = title; root.appendChild(heading);
	const toggleRow = document.createElement("div"); toggleRow.className = "gjj-h3s-toggle-row"; const labels = { "启用媒体反推": "媒体反推", "保留模型": "保留模型" };
	for (const [name, type] of fields) { const label = labels[name] || name; if (type === "toggle") { toggleRow.appendChild(toggleControl(node, name, label)); continue; } if (type === "select") { const group = document.createElement("div"); group.className = "gjj-h3s-choice-group"; const caption = document.createElement("div"); caption.className = "gjj-h3s-choice-label"; caption.textContent = label; group.append(caption, choiceListControl(node, name)); root.appendChild(group); continue; } const control = numberControl(node, name); const row = document.createElement("label"); row.className = "gjj-h3s-field"; const caption = document.createElement("span"); caption.textContent = label; row.append(caption, control); root.appendChild(row); }
	if (toggleRow.children.length) root.appendChild(toggleRow);
	root.__gjjRefresh = () => { for (const control of root.querySelectorAll('[data-kind="choices"]')) control.__gjjSync?.(); };
	document.body.appendChild(root); return root;
}
function choicePopup(node, title, name) {
	const root = document.createElement("div"); root.className = "gjj-h3s-pop"; protect(root);
	const heading = document.createElement("div"); heading.className = "gjj-h3s-title"; heading.textContent = title;
	const list = choiceListControl(node, name, true); root.append(heading, list);
	root.__gjjRefresh = () => list.__gjjSync?.(); document.body.appendChild(root); return root;
}
function timePopup(node) {
	const root = popup(node, "⏰ 视频时长", [["时长", "number"]]); const baseRefresh = root.__gjjRefresh;
	const caption = document.createElement("div"); caption.className = "gjj-h3s-choice-label"; caption.textContent = "快捷选择（秒）";
	const grid = document.createElement("div"); grid.className = "gjj-h3s-time-grid"; root.append(caption, grid);
	const render = () => {
		const current = Number(widget(node, "时长")?.value ?? 15); grid.replaceChildren();
		for (let seconds = 5; seconds <= 15; seconds += 1) {
			const item = document.createElement("button"); item.type = "button"; item.className = `gjj-h3s-time-button${current === seconds ? " selected" : ""}`; item.textContent = String(seconds);
			item.addEventListener("click", () => { setValue(node, "时长", seconds); close(node); }); protect(item); grid.appendChild(item);
		}
	};
	root.querySelector('[data-setting="时长"]')?.addEventListener("change", render);
	root.__gjjRefresh = () => { baseRefresh?.(); render(); }; render(); return root;
}
function modelPopup(node, title, modelNames, fields = []) {
	const root = document.createElement("div"); root.className = "gjj-h3s-pop"; protect(root);
	const heading = document.createElement("div"); heading.className = "gjj-h3s-title"; heading.textContent = title;
	const host = document.createElement("div"); root.append(heading, host);
	if (fields.length) { const parameterTitle = document.createElement("div"); parameterTitle.className = "gjj-h3s-title"; parameterTitle.textContent = "反推参数"; root.appendChild(parameterTitle); for (const [name, type, label = name] of fields) { const control = type === "toggle" ? toggleControl(node, name, label) : numberControl(node, name); if (type === "toggle") { root.appendChild(control); continue; } const row = document.createElement("label"); row.className = "gjj-h3s-field"; const caption = document.createElement("span"); caption.textContent = label; row.append(caption, control); root.appendChild(row); } }
	root.__gjjRefresh = () => renderModelTree(node, host, modelNames);
	root.__gjjRefresh(); document.body.appendChild(root); return root;
}
function libraryName(item) { return String(item?.display_name || item?.name || item?.title || item?.id || "").replace(/^\s*[♀♂]\ufe0f?\s*/, "").trim(); }
function librarySelection(node, kind) {
	try { const parsed = JSON.parse(String(widget(node, LIBRARIES[kind].widget)?.value || "[]")); return Array.isArray(parsed) ? parsed : []; }
	catch (_) { return []; }
}
function saveLibrarySelection(node, kind, items) {
	const normalized = items.map((item) => ({ id: String(item?.id || libraryName(item)), name: libraryName(item), notes: String(item?.notes || ""), thumbnail_url: String(item?.thumbnail_url || "") }));
	setValue(node, LIBRARIES[kind].widget, JSON.stringify(normalized)); updateLibraryButtons(node);
}
function updateLibraryButtons(node) {
	for (const [kind, config] of Object.entries(LIBRARIES)) {
		const button = node.__gjjH3SkillLibraryButtons?.[kind]; if (!button) continue;
		const count = librarySelection(node, kind).length;
		button.textContent = count ? `${config.icon}${count}` : config.icon;
		button.title = count ? `${config.title}：已选择 ${count} 项` : `打开${config.title}`;
		button.classList.toggle("selected", count > 0);
	}
}
function closeLibraryPicker(node) { node.__gjjH3SkillLibraryModal?.remove?.(); node.__gjjH3SkillLibraryModal = null; for (const button of Object.values(node.__gjjH3SkillLibraryButtons || {})) button.classList.remove("active"); }
async function loadLibrary(kind) {
	const config = LIBRARIES[kind];
	if (kind === "actor" && characterLibraryPromise) return characterLibraryPromise;
	const task = api.fetchApi(config.endpoint).then(async (response) => { const data = await response.json(); if (!response.ok || data?.ok === false) throw new Error(data?.error || `读取${config.title}失败`); return Array.isArray(data?.[config.key]) ? data[config.key] : []; });
	if (kind === "actor") characterLibraryPromise = task.catch((error) => { characterLibraryPromise = null; throw error; });
	return kind === "actor" ? characterLibraryPromise : task;
}
async function openLibraryPicker(node, kind, button) {
	if (node.__gjjH3SkillLibraryModal?.dataset.kind === kind) { closeLibraryPicker(node); return; }
	closeLibraryPicker(node); close(node); closeMentionMenu(node);
	const config = LIBRARIES[kind]; const items = await loadLibrary(kind); let selected = librarySelection(node, kind);
	const modal = document.createElement("div"); modal.className = "gjj-h3s-library"; modal.dataset.kind = kind; protect(modal);
	const head = document.createElement("div"); head.className = "gjj-h3s-library-head"; head.textContent = `${config.icon} ${config.title}（可多选）`;
	const tools = document.createElement("div"); tools.className = "gjj-h3s-library-tools";
	const search = document.createElement("input"); search.placeholder = "搜索名称、ID 或备注";
	const clear = document.createElement("button"); clear.type = "button"; clear.textContent = "清空";
	const done = document.createElement("button"); done.type = "button"; done.textContent = "确定";
	const grid = document.createElement("div"); grid.className = "gjj-h3s-library-grid";
	const render = () => {
		const query = search.value.trim().toLocaleLowerCase(); const ids = new Set(selected.map((item) => String(item.id || item.name)));
		grid.replaceChildren();
		for (const item of items.filter((entry) => !query || `${libraryName(entry)} ${entry?.id || ""} ${entry?.notes || ""}`.toLocaleLowerCase().includes(query))) {
			const id = String(item?.id || libraryName(item)); const card = document.createElement("button"); card.type = "button"; card.className = `gjj-h3s-library-card${ids.has(id) ? " active" : ""}`; card.title = String(item?.notes || libraryName(item));
			const image = document.createElement("img"); setGjjLibraryThumbnail(image, api, config.thumbnail, item);
			const label = document.createElement("span"); label.textContent = `${config.marker}${libraryName(item)}`; card.append(image, label);
			card.addEventListener("click", () => { selected = ids.has(id) ? selected.filter((entry) => String(entry.id || entry.name) !== id) : [...selected, item]; saveLibrarySelection(node, kind, selected); render(); }); grid.appendChild(card);
		}
		if (!grid.children.length) { const empty = document.createElement("div"); empty.textContent = items.length ? "没有匹配项目" : `${config.title}为空`; grid.appendChild(empty); }
	};
	search.addEventListener("input", render); clear.addEventListener("click", () => { selected = []; saveLibrarySelection(node, kind, selected); render(); }); done.addEventListener("click", () => closeLibraryPicker(node));
	tools.append(search, clear, done); modal.append(head, tools, grid); document.body.appendChild(modal); node.__gjjH3SkillLibraryModal = modal; button.classList.add("active"); render();
	const rect = button.getBoundingClientRect(); const width = Math.min(620, window.innerWidth - 24); modal.style.width = `${width}px`; modal.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left))}px`; modal.style.top = `${Math.max(12, Math.min(window.innerHeight - modal.offsetHeight - 12, rect.bottom + 6))}px`;
}
function demandEditor(node) { const target = widget(node, "需求"); const element = target?.inputEl || target?.element; if (element?.matches?.("textarea,input")) return element; return element?.querySelector?.("textarea,input") || null; }
function mentionRange(editor) {
	const caret = Number(editor?.selectionStart ?? 0); const before = String(editor?.value || "").slice(0, caret); const match = before.match(/(^|[\s\n，。；：、,.!?;:()[\]{}"'“”‘’])@([^\s@，。；：、,.!?;:()[\]{}"'“”‘’]*)$/);
	return match ? { start: before.length - match[2].length - 1, end: caret, query: match[2] || "" } : null;
}
function closeMentionMenu(node) { node.__gjjH3SkillMentionMenu?.remove?.(); node.__gjjH3SkillMentionMenu = null; node.__gjjH3SkillMentionOptions = []; node.__gjjH3SkillMentionActive = 0; }
function positionMentionMenu(node) { const editor = demandEditor(node); const menu = node.__gjjH3SkillMentionMenu; if (!editor || !menu) return; const rect = editor.getBoundingClientRect(); const width = Math.min(320, Math.max(220, rect.width * .62)); menu.style.width = `${width}px`; menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left + 8))}px`; menu.style.top = `${Math.max(8, Math.min(innerHeight - 290, rect.bottom - 4))}px`; }
function chooseMention(node, character) {
	const editor = demandEditor(node); const range = mentionRange(editor); if (!editor || !range) return; const name = libraryName(character); const prefix = editor.value.slice(0, range.start); const suffix = editor.value.slice(range.end); const insert = `@${name}`; const spacer = suffix && !/^[\s\n，。；：、,.!?;:]/.test(suffix) ? " " : "";
	editor.value = `${prefix}${insert}${spacer}${suffix}`; const caret = prefix.length + insert.length + spacer.length; setValue(node, "需求", editor.value); editor.focus(); editor.setSelectionRange(caret, caret);
	const actors = librarySelection(node, "actor"); if (!actors.some((item) => String(item.id) === String(character.id))) saveLibrarySelection(node, "actor", [...actors, character]); closeMentionMenu(node);
}
function renderMentionMenu(node) {
	const menu = node.__gjjH3SkillMentionMenu; if (!menu) return; const options = node.__gjjH3SkillMentionOptions || []; const active = Math.max(0, Math.min(Number(node.__gjjH3SkillMentionActive || 0), Math.max(0, options.length - 1))); node.__gjjH3SkillMentionActive = active; menu.replaceChildren();
	const title = document.createElement("div"); title.className = "gjj-h3s-mention-title"; title.textContent = "@角色库人物"; menu.appendChild(title);
	if (!options.length) { const empty = document.createElement("div"); empty.textContent = "没有匹配的人物"; menu.appendChild(empty); positionMentionMenu(node); return; }
	options.forEach((character, index) => { const item = document.createElement("button"); item.type = "button"; item.className = `gjj-h3s-mention-item${index === active ? " active" : ""}`; const image = document.createElement("img"); setGjjLibraryThumbnail(image, api, "character", character); const text = document.createElement("span"); const name = document.createElement("strong"); name.textContent = libraryName(character); const detail = document.createElement("small"); detail.textContent = String(character?.notes || character?.id || "").replace(/\s+/g, " ").trim(); text.append(name, detail); item.append(image, text); item.addEventListener("pointermove", () => { node.__gjjH3SkillMentionActive = index; renderMentionMenu(node); }); item.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); chooseMention(node, character); }); menu.appendChild(item); }); positionMentionMenu(node);
}
async function syncMentionMenu(node) {
	const editor = demandEditor(node); const range = mentionRange(editor); if (!editor || !range) { closeMentionMenu(node); return; }
	try { const characters = await loadLibrary("actor"); const query = range.query.toLocaleLowerCase(); node.__gjjH3SkillMentionOptions = characters.filter((item) => !query || `${libraryName(item)} ${item?.id || ""} ${item?.notes || ""}`.toLocaleLowerCase().includes(query)).sort((a, b) => Number(b?.updated_at || 0) - Number(a?.updated_at || 0)).slice(0, 12); }
	catch (error) { console.warn("[GJJ MiniMaxH3SkillStudio] 读取 @ 角色候选失败：", error); return; }
	if (!node.__gjjH3SkillMentionMenu) { const menu = document.createElement("div"); menu.className = "gjj-h3s-mention"; protect(menu); document.body.appendChild(menu); node.__gjjH3SkillMentionMenu = menu; } renderMentionMenu(node);
}
function bindMentionEditor(node) {
	const editor = demandEditor(node); if (!editor || editor.__gjjH3SkillMentionBound) return; editor.__gjjH3SkillMentionBound = true;
	editor.addEventListener("input", () => setTimeout(() => syncMentionMenu(node), 0)); editor.addEventListener("click", () => syncMentionMenu(node)); editor.addEventListener("keyup", (event) => { if (!["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) syncMentionMenu(node); });
	editor.addEventListener("keydown", (event) => { const menu = node.__gjjH3SkillMentionMenu; if (!menu) { if (event.key === "@") setTimeout(() => syncMentionMenu(node), 0); return; } if (event.key === "Escape") { event.preventDefault(); closeMentionMenu(node); return; } if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); const count = Math.max(1, node.__gjjH3SkillMentionOptions?.length || 1); node.__gjjH3SkillMentionActive = (Number(node.__gjjH3SkillMentionActive || 0) + (event.key === "ArrowDown" ? 1 : -1) + count) % count; renderMentionMenu(node); return; } if (["Enter", "Tab"].includes(event.key)) { const selected = node.__gjjH3SkillMentionOptions?.[Number(node.__gjjH3SkillMentionActive || 0)]; if (selected) { event.preventDefault(); chooseMention(node, selected); } } });
}
function close(node) { for (const pop of Object.values(node.__gjjH3SkillPops || {})) pop.classList.remove("open"); for (const button of node.__gjjH3SkillButtons || []) button.classList.remove("active"); }
function open(node, key, button) {
	const target = node.__gjjH3SkillPops?.[key]; if (!target) return; const wasOpen = target.classList.contains("open"); close(node); if (wasOpen) return;
	closeLibraryPicker(node); closeMentionMenu(node);
	target.__gjjRefresh?.();
	for (const control of target.querySelectorAll("[data-setting]")) { const current = widget(node, control.dataset.setting)?.value; if (control.dataset.kind === "toggle") control.__gjjSync?.(); else control.value = String(current ?? ""); }
	const rect = button.getBoundingClientRect(); const width = Math.min(440, window.innerWidth - 24); target.style.width = `${width}px`; target.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left))}px`; target.style.top = `${Math.max(12, Math.min(window.innerHeight - target.offsetHeight - 12, rect.bottom + 6))}px`; target.classList.add("open"); button.classList.add("active");
}
function hideSettings(node) { for (const name of HIDDEN_SETTINGS) { const target = widget(node, name); if (!target) continue; GJJ_Utils.hideWidget(target); target.hidden = true; target.computeSize = () => [0, 0]; target.getHeight = () => 0; target.draw = () => {}; } }
function renderResultPreview(node, value) {
	const text = String(value || ""); if (!text) return;
	if (!node.__gjjH3SkillResult) {
		const root = document.createElement("div"); root.className = "gjj-h3s-result"; protect(root);
		const head = document.createElement("div"); head.className = "gjj-h3s-result-head"; const title = document.createElement("span"); title.textContent = "生成结果";
		const copy = document.createElement("button"); copy.type = "button"; copy.className = "gjj-h3s-copy"; copy.textContent = "📋 一键复制";
		const textarea = document.createElement("textarea"); textarea.className = "gjj-h3s-result-text"; textarea.readOnly = true;
		copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(textarea.value); copy.textContent = "✓ 已复制"; } catch (_) { textarea.focus(); textarea.select(); document.execCommand("copy"); copy.textContent = "✓ 已复制"; } setTimeout(() => { copy.textContent = "📋 一键复制"; }, 1200); });
		head.append(title, copy); root.append(head, textarea);
		const dom = node.addDOMWidget("__gjj_h3_skills_result", "div", root, { serialize: false, hideOnZoom: false }); dom.serialize = false; dom.computeSize = () => [Math.max(0, Number(node.size?.[0] || 340) - 20), 226]; dom.getHeight = () => 226;
		node.__gjjH3SkillResult = { dom, root, textarea }; node.size = [Math.max(340, node.size?.[0] || 340), Math.max(410, node.size?.[1] || 410)];
	}
	node.__gjjH3SkillResult.textarea.value = text; node.setDirtyCanvas?.(true, true); app.graph?.setDirtyCanvas?.(true, true);
}
function build(node) {
	if (node.__gjjH3SkillToolbar) return; installStyle(); hideSettings(node);
	const row = document.createElement("div"); row.className = "gjj-h3s-row"; protect(row);
	// New controls are appended to keep the established toolbar ordering stable.
	const configs = [["aspect", "📐", "画面比例"], ["time", "⏰", "视频时长"], ["language", "🌏", "内容语言"], ["settings", "⚙️", "技能设置"], ["model", "🧠", "反推模型"], ["actor", "👤", "角色库"], ["scene", "🏕️", "场景库"], ["visualStyle", "🎨", "视觉风格"], ["musicStyle", "🎵", "音乐风格"], ["cuts", "✂️", "切镜次数"]];
	const pops = {
		aspect: popup(node, "📐 画面比例", [["画面比例", "select"]]),
		time: timePopup(node),
		language: popup(node, "🌏 内容语言", [["内容语言", "select"]]),
		settings: popup(node, "⚙️ 技能设置", [["技能模式", "select"], ["交付内容", "select"], ["H3模式", "select"], ["启用媒体反推", "toggle"], ["保留模型", "toggle"]]),
		model: modelPopup(node, "🧠 反推模型", ["反推模型"], [["反推最大Token", "number", "最大 Token"], ["反推温度", "number", "温度"], ["反推TopP", "number", "Top P"], ["反推重复惩罚", "number", "重复惩罚"]]),
		visualStyle: choicePopup(node, "🎨 视觉风格", "视觉风格"),
		musicStyle: choicePopup(node, "🎵 音乐风格", "音乐风格"),
		cuts: choicePopup(node, "✂️ 切镜次数", "切镜次数"),
	};
	const buttons = []; const libraryButtons = {};
	for (const [key, emoji, title] of configs) {
		const button = document.createElement("button"); button.type = "button"; button.className = "gjj-h3s-button"; button.textContent = emoji; button.title = title;
		if (LIBRARIES[key]) {
			libraryButtons[key] = button;
			button.addEventListener("click", () => openLibraryPicker(node, key, button).catch((error) => console.error(`[GJJ MiniMaxH3SkillStudio] ${title}打开失败：`, error)));
		} else button.addEventListener("click", () => open(node, key, button));
		protect(button); buttons.push(button); row.appendChild(button);
	}
	const dom = node.addDOMWidget(PANEL_NAME, "div", row, { serialize: false, hideOnZoom: false }); dom.serialize = false; dom.computeSize = () => [Math.max(0, Number(node.size?.[0] || 280) - 20), 36]; dom.getHeight = () => 36;
	node.__gjjH3SkillToolbar = dom; node.__gjjH3SkillPops = pops; node.__gjjH3SkillButtons = buttons; node.__gjjH3SkillLibraryButtons = libraryButtons; updateLibraryButtons(node); bindMentionEditor(node); node.size = [Math.max(340, node.size?.[0] || 340), Math.max(180, node.size?.[1] || 180)];
}
function cleanup(node) { close(node); closeLibraryPicker(node); closeMentionMenu(node); for (const pop of Object.values(node.__gjjH3SkillPops || {})) pop.remove(); delete node.__gjjH3SkillPops; delete node.__gjjH3SkillToolbar; delete node.__gjjH3SkillLibraryButtons; }

app.registerExtension({
	name: "Comfy.GJJ.MiniMaxH3SkillStudio",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const created = nodeType.prototype.onNodeCreated; nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); this.color = "#2b727e"; this.bgcolor = "#11191d"; for (const delay of [0, 80, 250]) setTimeout(() => { build(this); bindMentionEditor(this); updateLibraryButtons(this); }, delay); return result; };
		const configured = nodeType.prototype.onConfigure; nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); for (const delay of [0, 80, 250]) setTimeout(() => { hideSettings(this); build(this); bindMentionEditor(this); updateLibraryButtons(this); }, delay); return result; };
		const executed = nodeType.prototype.onExecuted; nodeType.prototype.onExecuted = function (message) { const result = executed?.apply(this, arguments); const candidate = message?.text?.[0] ?? message?.positive_prompt?.[0] ?? message?.ui?.text?.[0] ?? ""; if (candidate) renderResultPreview(this, candidate); return result; };
		const removed = nodeType.prototype.onRemoved; nodeType.prototype.onRemoved = function (...args) { cleanup(this); return removed?.apply(this, args); };
	},
	setup() { window.addEventListener("pointerdown", (event) => { if (event.target?.closest?.(".gjj-h3s-pop,.gjj-h3s-button,.gjj-h3s-library,.gjj-h3s-mention")) return; for (const node of app.graph?._nodes || []) if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) { close(node); closeLibraryPicker(node); closeMentionMenu(node); } }, true); },
});

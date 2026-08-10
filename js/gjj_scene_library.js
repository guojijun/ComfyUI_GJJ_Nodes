import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { GJJ_ANY_PREVIEW_MEDIA_DRAG_MIME } from "./gjj_common_media_preview.js";
import { setGjjLibraryThumbnail } from "./gjj_library_thumbnails.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.SceneLibrary";
	const TOOLBAR_ID = "gjj-workflow-screenshot-toolbar";
	const COLOR_BUTTON_ID = "gjj-workflow-node-color-button";
	const CHARACTER_BUTTON_ID = "gjj-character-library-button";
	const BUTTON_ID = "gjj-scene-library-button";
	const PANEL_ID = "gjj-scene-library-panel";
	const STYLE_ID = "gjj-scene-library-style";
	const ENDPOINT = "/gjj/scene_library";
	const TYPE_LABELS = { "360": "360" };
	const AUTO_ANNOTATE_STORAGE_KEY = "gjj.sceneLibrary.autoAnnotate";
	const SHARED_PANEL_LAYOUT_KEY = "gjj.libraryPanel.layout";

	let state = {
		scenes: [],
		allScenes: [],
		selectedId: "",
		search: "",
		type: "all",
		sort: "updated_desc",
		page: 1,
		pageSize: 15,
		pageCount: 1,
		status: "",
		importing: false,
		importCurrent: 0,
		importTotal: 0,
		importStatus: "",
		importButton: null,
		thumbnailObserver: null,
		importNodeId: "",
		importActiveIndex: 0,
		annotating: false,
		annotateNodeId: "",
		annotateButtons: new Set(),
		autoAnnotate: localStorage.getItem(AUTO_ANNOTATE_STORAGE_KEY) !== "false",
		panelPosition: null,
		panelSize: null,
		lastAnchor: null,
		activeViewer: null,
		cameraSending: false,
		selectedMarkId: "",
	};
	let sceneIndexRefreshToken = 0;

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

	function dataUrlToFile(dataUrl, filename) {
		const [header, payload = ""] = String(dataUrl || "").split(",", 2);
		const mime = /^data:([^;]+);/i.exec(header)?.[1] || "image/png";
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return new File([bytes], filename, { type: mime });
	}

	async function uploadImageDataUrl(dataUrl, filename) {
		const file = dataUrlToFile(dataUrl, filename);
		const endpoints = ["/upload/image", "/api/upload/image"];
		let lastError = null;
		for (const endpoint of endpoints) {
			const form = new FormData();
			form.append("image", file, file.name);
			form.append("type", "input");
			form.append("subfolder", "gjj_scene_view");
			form.append("overwrite", "true");
			try {
				const response = await (api?.fetchApi
					? api.fetchApi(endpoint, { method: "POST", body: form })
					: fetch(apiUrl(endpoint), { method: "POST", body: form }));
				if (!response.ok) {
					lastError = new Error(`HTTP ${response.status}`);
					continue;
				}
				const data = await response.json().catch(() => ({}));
				return normalizeUploadedImage(data, file.name);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError || new Error("当前场景视图上传失败");
	}

	function normalizeUploadedImage(data, fallbackName) {
		const requestedSubfolder = "gjj_scene_view";
		let filename = String(data?.name || data?.filename || data?.file || fallbackName || "").replace(/\\/g, "/").trim();
		let subfolder = String(data?.subfolder || requestedSubfolder).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
		if (subfolder && filename.startsWith(`${subfolder}/`)) filename = filename.slice(subfolder.length + 1);
		if (!filename) filename = String(fallbackName || "").trim();
		return { filename, subfolder, type: String(data?.type || "input") };
	}

	function canvasClientCenter() {
		const element = app?.canvas?.canvas || app?.canvas?.canvas_mouse || document.querySelector("canvas");
		const rect = element?.getBoundingClientRect?.();
		return rect
			? [rect.left + rect.width * 0.5, rect.top + rect.height * 0.5]
			: [window.innerWidth * 0.5, window.innerHeight * 0.5];
	}

	function sceneAssetMediaPayload(scene, asset) {
		return {
			filename: String(asset?.preview_file || asset?.file || "scene.png"),
			preview_url: asset?.preview_url ? apiUrl(asset.preview_url) : "",
			media_type: "image",
			label: String(asset?.label || scene?.name || scene?.id || "场景"),
		};
	}

	function bindSceneAssetDrag(element, scene, asset) {
		if (!element || !asset?.preview_url) return;
		element.draggable = true;
		element.title = `${element.title ? `${element.title}\n` : ""}拖到空白画布可创建 GJJ_AnyPreview`;
		element.addEventListener("dragstart", (event) => {
			const payload = sceneAssetMediaPayload(scene, asset);
			event.dataTransfer?.setData(GJJ_ANY_PREVIEW_MEDIA_DRAG_MIME, JSON.stringify(payload));
			event.dataTransfer?.setData("text/plain", payload.preview_url || payload.filename);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
		});
	}

	async function importIntoAnyPreview(payload, clientPoint = canvasClientCenter()) {
		const importer = globalThis.__gjjAnyPreviewImportMediaAtPoint;
		if (typeof importer !== "function") throw new Error("GJJ_AnyPreview 前端尚未加载，请刷新页面后重试");
		const ok = await importer(payload, Number(clientPoint[0]), Number(clientPoint[1]));
		if (!ok) throw new Error("GJJ_AnyPreview 未能接收场景图片");
		return true;
	}

	function createSharedModelTree(items, controls, values, onApply = null) {
		return GJJ_Utils.createLibraryModelTreeView({ items, controls, values, onApply });
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

	function bringPanelToFront(panel = null) {
		const target = panel || document.getElementById(PANEL_ID);
		if (target) target.style.zIndex = "100002";
	}

	function installStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
#${BUTTON_ID}{width:34px;height:34px;padding:0;border:1px solid rgba(117,137,148,.5);border-radius:8px;background:rgba(28,32,36,.92);color:#f2f6f4;font:19px/32px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;cursor:pointer;box-sizing:border-box;pointer-events:auto;box-shadow:0 4px 14px rgba(0,0,0,.28);transition:border-color .16s ease,background .16s ease,transform .16s ease;}
#${BUTTON_ID}:hover,#${BUTTON_ID}.active{border-color:rgba(97,175,239,.9);background:rgba(28,48,66,.96);}
#${PANEL_ID}{position:fixed;z-index:100000;width:min(940px,calc(100vw - 20px));height:min(700px,calc(100vh - 20px));min-width:min(560px,calc(100vw - 20px));min-height:min(420px,calc(100vh - 20px));max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);resize:both;display:none;grid-template-columns:minmax(260px,330px) 1fr;border:1px solid #40525b;border-radius:8px;background:#0f171b;color:#e7f2f4;box-shadow:0 18px 46px rgba(0,0,0,.54);font-family:system-ui,"Microsoft YaHei",sans-serif;overflow:auto;}
#${PANEL_ID}.open{display:grid;}
#${PANEL_ID}.busy .gjj-sl-sidebar,#${PANEL_ID}.busy .gjj-sl-main{filter:grayscale(.75);opacity:.42;pointer-events:none;}
.gjj-sl-busy-mask{position:absolute;z-index:100020;inset:0;display:none;align-items:center;justify-content:center;padding:22px;background:rgba(5,10,12,.48);backdrop-filter:blur(1.5px);cursor:wait;}
#${PANEL_ID}.busy .gjj-sl-busy-mask{display:flex;}
.gjj-sl-busy-card{width:min(440px,calc(100% - 32px));padding:18px;border:1px solid #69c995;border-radius:12px;background:rgba(12,24,27,.97);box-shadow:0 18px 44px rgba(0,0,0,.62);color:#effff7;text-align:center;}
.gjj-sl-busy-title{font-size:17px;font-weight:900;letter-spacing:.03em;}
.gjj-sl-busy-status{margin-top:8px;color:#c8ddd5;font-size:12px;line-height:1.45;overflow-wrap:anywhere;}
.gjj-sl-busy-progress{height:14px;margin-top:14px;border:1px solid #41675a;border-radius:999px;background:#081115;overflow:hidden;}
.gjj-sl-busy-progress-bar{height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#42c978,#5ee0cf,#72bfff);box-shadow:0 0 14px rgba(94,224,207,.62);transition:width .22s ease;}
.gjj-sl-busy-percent{margin-top:7px;color:#80e6bc;font-size:14px;font-weight:900;}
.gjj-sl-sidebar{min-width:0;min-height:0;border-right:1px solid #263842;background:#111a1f;display:flex;flex-direction:column;}
.gjj-sl-main{min-width:0;min-height:0;display:flex;flex-direction:column;background:#0c1418;}
.gjj-sl-head{display:flex;align-items:center;gap:6px;min-height:42px;padding:7px 8px;border-bottom:1px solid #263842;}
.gjj-sl-drag{width:24px;height:28px;flex:0 0 24px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#9fb4ba;font-size:17px;line-height:22px;cursor:grab;padding:0;display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;}
.gjj-sl-title{font-size:14px;font-weight:800;color:#f3fbf8;white-space:nowrap;}
.gjj-sl-spacer{flex:1 1 auto;}
.gjj-sl-btn{height:28px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;font-size:12px;font-weight:700;cursor:pointer;padding:0 9px;white-space:nowrap;}
.gjj-sl-btn:hover{background:#263844;border-color:#6aa6b8;}
.gjj-sl-btn.flash{border-color:#76e0b2;background:#1f6a50;color:#f1fff8;box-shadow:0 0 0 2px rgba(118,224,178,.18);}
.gjj-sl-btn:disabled{opacity:.55;cursor:not-allowed;background:#1b2730;border-color:#40535b;}
.gjj-sl-btn.danger:hover{background:#4a2028;border-color:#d76f7b;}
.gjj-sl-icon{width:28px;padding:0;font-size:15px;}
.gjj-sl-icon:disabled{width:auto;padding:0 8px;}
.gjj-sl-icon.active{border-color:#64d2aa;background:#1d4d42;color:#eafff5;}
.gjj-sl-annotate-toggle{width:28px;padding:0;font-size:15px;}
.gjj-sl-annotate-toggle.is-on{border-color:#64d2aa;background:#176246;color:#ecfff6;box-shadow:inset 0 0 0 1px rgba(170,255,220,.16);}
.gjj-sl-annotate-toggle.is-on:hover{background:#1d7555;border-color:#8af0c6;}
.gjj-sl-annotate-toggle.is-off{border-color:#6c5358;background:#3a252b;color:#ffd9df;box-shadow:inset 0 0 0 1px rgba(255,190,202,.12);}
.gjj-sl-annotate-toggle.is-off:hover{background:#4a2b34;border-color:#d98a99;}
.gjj-sl-annotate-toggle:disabled{width:auto;min-width:44px;padding:0 8px;}
.gjj-sl-search{height:30px;margin:8px 8px 6px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 9px;font-size:12px;outline:none;}
.gjj-sl-tools{display:flex;align-items:center;gap:6px;padding:0 8px 7px;overflow-x:auto;scrollbar-width:thin;scrollbar-color:#33464e #10191e;}
.gjj-sl-import-progress{display:none;margin:0 8px 7px;border:1px solid #2b4651;border-radius:7px;background:#071014;overflow:hidden;}
.gjj-sl-import-progress.open{display:block;}
.gjj-sl-import-bar{height:7px;width:0%;background:#64d2aa;transition:width .18s ease;}
.gjj-sl-import-text{padding:4px 7px;color:#9fb8be;font-size:11px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-sl-filter,.gjj-sl-sort{height:26px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;font-size:12px;font-weight:700;cursor:pointer;padding:0 8px;white-space:nowrap;}
.gjj-sl-filter.active,.gjj-sl-sort.active{background:#235c7a;border-color:#69c9f2;color:#fff;}
.gjj-sl-divider{width:1px;height:18px;background:#31444c;flex:0 0 auto;}
.gjj-sl-list{flex:1 1 auto;min-height:0;overflow:auto;padding:0 8px 8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));align-content:start;gap:6px;scrollbar-width:thin;scrollbar-color:#33464e #10191e;}
.gjj-sl-card{min-width:0;border:1px solid #293a42;border-radius:8px;background:#152027;color:#dce7e2;padding:4px;cursor:pointer;text-align:left;}
.gjj-sl-card:hover,.gjj-sl-card.active{border-color:#69c9f2;background:#182d38;}
.gjj-sl-cover{height:70px;border-radius:6px;background:#0a1115;display:flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:4px;}
.gjj-sl-cover img{width:100%;height:100%;object-fit:cover;}
.gjj-sl-empty-cover{font-size:30px;opacity:.7;}
.gjj-sl-name{font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-sl-meta{font-size:10px;color:#90a4aa;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-sl-pager{display:flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:5px 8px 7px;border-top:1px solid #263842;}
.gjj-sl-page-label{min-width:64px;text-align:center;font-size:11px;color:#9cb0b6;font-weight:700;}
.gjj-sl-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin;scrollbar-color:#40535b #10191e;}
.gjj-sl-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
.gjj-sl-form{display:grid;grid-template-columns:auto minmax(160px,1fr) auto auto;gap:7px;align-items:center;}
.gjj-sl-input,.gjj-sl-select{height:30px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 9px;font-size:12px;outline:none;min-width:0;}
.gjj-sl-textarea{min-height:56px;resize:vertical;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:7px 9px;font-size:12px;outline:none;grid-column:1 / -1;}
.gjj-sl-status{font-size:12px;color:#94aeb4;min-height:18px;}
.gjj-sl-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:6px;}
.gjj-sl-asset{border:1px solid #2e4149;border-radius:7px;background:#131d22;padding:5px;display:flex;flex-direction:column;gap:3px;min-width:0;}
.gjj-sl-asset-preview{height:72px;border-radius:5px;background:#0a1115;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#7f949a;font-size:12px;}
.gjj-sl-asset-preview img{width:100%;height:100%;object-fit:cover;}
.gjj-sl-stage{position:relative;height:min(520px,58vh);min-height:320px;border:1px solid #2e4149;border-radius:8px;background:#071014;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:crosshair;}
.gjj-sl-stage.is-panorama{cursor:grab;touch-action:none;}
.gjj-sl-stage.is-panorama:active{cursor:grabbing;}
.gjj-sl-stage img{max-width:100%;max-height:100%;object-fit:contain;display:block;}
.gjj-sl-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
.gjj-sl-stage-empty{color:#7f949a;font-size:13px;text-align:center;padding:20px;}
.gjj-sl-stage-delete{position:absolute;right:8px;top:8px;z-index:3;background:rgba(72,26,34,.92);border-color:#b85e68;}
.gjj-sl-stage-delete:hover{background:#642632;border-color:#e48590;}
.gjj-sl-mark{position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border:2px solid #f6d365;border-radius:999px;background:rgba(0,0,0,.5);box-shadow:0 0 0 2px rgba(0,0,0,.5);pointer-events:auto;cursor:pointer;}
.gjj-sl-mark.active{background:rgba(246,211,101,.28);box-shadow:0 0 0 2px rgba(0,0,0,.58),0 0 14px rgba(246,211,101,.42);}
.gjj-sl-mark span{position:absolute;left:12px;top:-7px;max-width:120px;padding:2px 5px;border-radius:5px;background:rgba(8,13,16,.9);color:#ffe9a8;font-size:11px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;}
.gjj-sl-mark-tools{position:absolute;left:calc(100% + 12px);top:10px;display:none;gap:4px;pointer-events:auto;}
.gjj-sl-mark.active .gjj-sl-mark-tools{display:flex;}
.gjj-sl-mark-tool{width:20px;height:20px;border:1px solid rgba(246,211,101,.75);border-radius:5px;background:rgba(8,13,16,.92);color:#ffe9a8;font-size:11px;font-weight:900;line-height:16px;padding:0;cursor:pointer;}
.gjj-sl-mark-tool.flash{width:auto;min-width:42px;padding:0 5px;}
.gjj-sl-mark-tool.danger{border-color:rgba(216,109,124,.82);color:#ffc7d0;background:rgba(72,26,34,.92);}
.gjj-sl-mark-tool:hover{border-color:#ffe9a8;background:#152329;}
.gjj-sl-mark-tool.danger:hover{border-color:#ff9faf;background:#642632;}
.gjj-sl-viewer-status{position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);padding:4px 7px;border-radius:6px;background:rgba(7,16,20,.72);color:#b8cbd1;font-size:11px;font-weight:700;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-sl-marks{display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap;}
.gjj-sl-mark-row{display:inline-flex;flex-direction:column;align-items:stretch;gap:4px;max-width:150px;border:1px solid #263842;border-radius:6px;background:#121d22;padding:3px;font-size:12px;min-width:0;}
.gjj-sl-mark-row.active{border-color:#f6d365;background:#1d2520;}
.gjj-sl-mark-name{height:24px;max-width:138px;min-width:42px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e7f2f4;font-weight:800;text-align:center;border:0;background:transparent;padding:0 7px;cursor:pointer;}
.gjj-sl-mark-name:hover,.gjj-sl-mark-row.active .gjj-sl-mark-name{color:#ffe9a8;}
.gjj-sl-mark-actions{display:none;gap:4px;justify-content:center;}
.gjj-sl-mark-row.active .gjj-sl-mark-actions{display:flex;}
.gjj-sl-mark-actions .gjj-sl-btn{width:24px;height:24px;padding:0;font-size:12px;}
.gjj-sl-name-pop{position:fixed;z-index:100003;width:min(260px,calc(100vw - 16px));display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;border:1px solid #49636d;border-radius:8px;background:#101a1f;box-shadow:0 14px 36px rgba(0,0,0,.5);padding:8px;}
.gjj-sl-name-pop input{height:30px;min-width:0;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#e7f2f4;padding:0 8px;font-size:12px;outline:none;}
.gjj-sl-model-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.46);display:flex;align-items:center;justify-content:center;padding:18px;z-index:4;}
.gjj-sl-model-dialog{width:min(680px,100%);max-height:100%;overflow:hidden;display:flex;flex-direction:column;border:1px solid #40535b;border-radius:8px;background:#101a1f;color:#dce7e2;box-shadow:0 18px 48px rgba(0,0,0,.56);}
.gjj-sl-model-head{position:relative;z-index:2;display:flex;align-items:center;gap:8px;min-height:38px;flex:0 0 auto;padding:8px 10px;border-bottom:1px solid #263842;background:#101a1f;box-shadow:0 5px 12px rgba(0,0,0,.2);}
.gjj-sl-model-title{font-size:14px;font-weight:800;color:#f3fbf8;}
.gjj-sl-model-body{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding:10px;overscroll-behavior:contain;}
.gjj-sl-model-group{border:1px solid #2d4149;border-radius:8px;background:#131d22;padding:8px;}
.gjj-sl-model-group-title{font-size:13px;font-weight:800;margin-bottom:6px;color:#f0faf4;}
.gjj-sl-model-tree{display:flex;flex-direction:column;gap:1px;margin:0;padding:7px;border:1px solid #33454c;border-radius:8px;background:#0f171b;color:#dce7e2;font-family:Consolas,"Microsoft YaHei",monospace;font-size:12px;line-height:1.55;overflow:auto;}
.gjj-sl-model-line{display:block;width:100%;border:0;background:transparent;color:#dce7e2;padding:2px 4px;border-radius:5px;text-align:left;font:12px/1.5 Consolas,"Microsoft YaHei",monospace;white-space:pre;box-sizing:border-box;}
.gjj-sl-model-line.clickable{cursor:pointer;}
.gjj-sl-model-line.clickable:hover{background:#17262d;}
.gjj-sl-model-choice{display:flex;flex-direction:column;gap:5px;margin:3px 0 5px 26px;padding:7px;border:1px solid #33454c;border-radius:8px;background:#11181c;}
.gjj-sl-model-search{width:100%;height:28px;background:#0d1418;color:#dce7e2;border:1px solid #41535b;border-radius:6px;padding:0 7px;box-sizing:border-box;font-size:12px;outline:none;}
.gjj-sl-model-options{display:flex;flex-direction:column;gap:4px;max-height:210px;overflow:auto;}
.gjj-sl-model-option{width:100%;display:block;text-align:left;background:#182127;color:#dce7e2;border:1px solid #33454c;border-radius:6px;padding:5px 7px;box-sizing:border-box;white-space:normal;word-break:break-all;cursor:pointer;font-size:12px;}
.gjj-sl-model-option:hover{border-color:#6aa6b8;background:#1d2b32;}
.gjj-sl-model-option.selected{border-color:#2f7d67;background:#18352f;}
.gjj-sl-model-empty{color:#8da2ad;font-size:11px;padding:4px 2px;}
.gjj-sl-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;}
.gjj-sl-setting{display:flex;flex-direction:column;gap:4px;min-width:0;}
.gjj-sl-setting.wide{grid-column:1/-1;}
.gjj-sl-setting-label{color:#cfe0da;font-size:12px;font-weight:800;}
.gjj-sl-setting-hint{color:#82979e;font-size:10px;line-height:1.35;}
.gjj-sl-setting input,.gjj-sl-setting select{width:100%;height:30px;box-sizing:border-box;border:1px solid #40535b;border-radius:6px;background:#071014;color:#e7f2f4;padding:0 8px;outline:none;}
.gjj-sl-setting-check{height:30px;display:flex;align-items:center;gap:7px;color:#dce7e2;font-size:12px;}
.gjj-sl-setting-check input{width:16px;height:16px;}
@media(max-width:680px){.gjj-sl-settings-grid{grid-template-columns:1fr;}.gjj-sl-setting.wide{grid-column:auto;}}
.gjj-sl-empty{height:100%;display:flex;align-items:center;justify-content:center;color:#85979d;font-size:13px;text-align:center;padding:20px;}
`;
		document.head.appendChild(style);
	}

	function selectedScene() {
		return state.scenes.find((item) => item.id === state.selectedId) || state.scenes[0] || null;
	}

	function setStatus(text) {
		state.status = String(text || "");
		const el = document.querySelector(`#${PANEL_ID} .gjj-sl-status`);
		if (el) el.textContent = state.status;
	}

	function baseNameFromFile(file, fallback = "新场景") {
		return String(file?.name || "").replace(/\.[^.]+$/, "").trim() || fallback;
	}

	function autoSceneName(file = null) {
		if (file) return baseNameFromFile(file, "新场景");
		const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
		return `新场景_${stamp}`;
	}

	function formatBytes(value) {
		const size = Number(value || 0);
		if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
		if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
		return `${size} B`;
	}

	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, Number(value) || 0));
	}

	function loadImage(url) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			const src = apiUrl(url);
			try {
				const parsed = new URL(src, window.location.href);
				if (parsed.origin !== window.location.origin) image.crossOrigin = "anonymous";
			} catch (_) {}
			image.onload = async () => {
				try {
					if (image.decode) await image.decode();
				} catch (_) {}
				resolve(image);
			};
			image.onerror = () => reject(new Error("全景图加载失败"));
			image.src = src;
		});
	}

	function button(text, title, className, onClick) {
		const el = document.createElement("button");
		el.type = "button";
		el.textContent = text;
		el.title = title || "";
		el.className = className || "gjj-sl-btn";
		el.addEventListener("pointerdown", (event) => {
			rememberActiveTextTarget();
			event.stopPropagation();
		}, true);
		el.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
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

	async function copyText(text) {
		if (navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(text);
				return;
			} catch (_) {}
		}
		const area = document.createElement("textarea");
		area.value = text;
		document.body.appendChild(area);
		area.select();
		document.execCommand("copy");
		area.remove();
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

	function annotateButton(ids = [], scopeLabel = "场景") {
		let clickTimer = null;
		const triggerAnnotate = () => {
			if (state.annotating || state.importing) return;
			annotateMissingScenes(ids).catch((error) => setStatus(error.message));
		};
		const toggleAutoAnnotate = () => {
			if (state.annotating || state.importing) return;
			state.autoAnnotate = !state.autoAnnotate;
			try { localStorage.setItem(AUTO_ANNOTATE_STORAGE_KEY, state.autoAnnotate ? "true" : "false"); } catch (_) {}
			refreshAnnotateButtons();
			setStatus(state.autoAnnotate ? "已开启导入后自动打标" : "已关闭导入后自动打标");
		};
		const btn = button("🧑‍🎨", "", "gjj-sl-btn gjj-sl-icon gjj-sl-annotate-toggle", (event) => {
			if (event?.shiftKey || event?.ctrlKey || event?.altKey || event?.metaKey) {
				clearTimeout(clickTimer);
				clickTimer = null;
				toggleAutoAnnotate();
				return;
			}
			if (event?.detail > 1) return;
			clearTimeout(clickTimer);
			clickTimer = setTimeout(() => {
				clickTimer = null;
				triggerAnnotate();
			}, 240);
		});
		btn.addEventListener("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
			clearTimeout(clickTimer);
			clickTimer = null;
			toggleAutoAnnotate();
		});
		btn.disabled = !!state.annotating || !!state.importing;
		btn.dataset.annotateScope = scopeLabel;
		state.annotateButtons.add(btn);
		updateAnnotateButton(btn);
		return btn;
	}

	function updateAnnotateButton(btn) {
		if (!btn) return;
		btn.textContent = state.annotating ? "..." : "🧑‍🎨";
		btn.classList.toggle("active", !!state.autoAnnotate);
		btn.classList.toggle("is-on", !!state.autoAnnotate && !state.annotating);
		btn.classList.toggle("is-off", !state.autoAnnotate && !state.annotating);
		btn.setAttribute("aria-pressed", state.autoAnnotate ? "true" : "false");
		btn.disabled = !!state.annotating || !!state.importing;
		btn.title = state.annotating
			? "正在自动打标"
			: (state.autoAnnotate
				? `导入后自动打标：已开启；单击执行${btn.dataset.annotateScope || "场景"}打标，双击关闭`
				: `导入后自动打标：已关闭；单击执行${btn.dataset.annotateScope || "场景"}打标，双击开启`);
	}

	function refreshAnnotateButtons() {
		for (const btn of state.annotateButtons) {
			if (!btn?.isConnected) continue;
			updateAnnotateButton(btn);
		}
	}

	function closeAnnotationNameEditor() {
		document.querySelectorAll(".gjj-sl-name-pop").forEach((node) => node.remove());
	}

	function popPosition(clientX, clientY, width = 260, height = 48) {
		return {
			left: Math.min(Math.max(8, Number(clientX || 0) + 10), Math.max(8, window.innerWidth - width - 8)),
			top: Math.min(Math.max(8, Number(clientY || 0) + 10), Math.max(8, window.innerHeight - height - 8)),
		};
	}

	function openAnnotationNameEditor(scene, asset, mark, point, clientX, clientY) {
		if (!scene || !asset || !point && !mark) return;
		closeAnnotationNameEditor();
		const popup = document.createElement("div");
		popup.className = "gjj-sl-name-pop";
		const pos = popPosition(clientX, clientY);
		popup.style.left = `${pos.left}px`;
		popup.style.top = `${pos.top}px`;
		const input = document.createElement("input");
		input.value = mark?.keyword || "";
		input.placeholder = "物品名";
		const save = button("保存", "保存物品名", "gjj-sl-btn", () => {
			const keyword = input.value.trim();
			if (!keyword) return;
			const next = (scene.annotations || []).slice();
			const index = mark ? next.findIndex((item) => item.id === mark.id) : -1;
			if (index >= 0) {
				next[index] = { ...next[index], keyword };
			} else {
				next.push({
					id: `${keyword}_${Date.now()}`,
					keyword,
					x: point.x,
					y: point.y,
					asset_id: asset.id || "",
				});
			}
			closeAnnotationNameEditor();
			saveAnnotations(scene, next).catch((error) => setStatus(error.message));
		});
		const cancel = button("取消", "取消", "gjj-sl-btn", closeAnnotationNameEditor);
		popup.append(input, save, cancel);
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) {
			popup.addEventListener(eventName, (event) => event.stopPropagation());
		}
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				save.click();
			} else if (event.key === "Escape") {
				event.preventDefault();
				closeAnnotationNameEditor();
			}
		});
		document.body.appendChild(popup);
		setTimeout(() => {
			input.focus();
			input.select();
			const outside = (event) => {
				if (!popup.contains(event.target)) {
					document.removeEventListener("pointerdown", outside, true);
					closeAnnotationNameEditor();
				}
			};
			document.addEventListener("pointerdown", outside, true);
		}, 0);
	}

	function fileInput(accept = "image/*,.hdr,.exr", multiple = false) {
		return new Promise((resolve) => {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = accept;
			input.multiple = !!multiple;
			input.addEventListener("change", () => {
				const files = Array.from(input.files || []);
				resolve(multiple ? files : (files[0] || null));
			}, { once: true });
			input.click();
		});
	}

	function setImportProgress(current = 0, total = 0, text = "") {
		state.importCurrent = Math.max(0, Number(current || 0));
		state.importTotal = Math.max(0, Number(total || 0));
		state.importStatus = String(text || "");
		const panel = document.getElementById(PANEL_ID);
		const wrap = panel?.querySelector("[data-sl-import-progress]");
		const bar = panel?.querySelector("[data-sl-import-bar]");
		const label = panel?.querySelector("[data-sl-import-text]");
		const busyStatus = panel?.querySelector("[data-sl-busy-status]");
		const busyBar = panel?.querySelector("[data-sl-busy-bar]");
		const busyPercent = panel?.querySelector("[data-sl-busy-percent]");
		const active = state.importing || state.annotating || state.importTotal > 0;
		panel?.classList.toggle("busy", !!state.importing);
		if (wrap) wrap.classList.toggle("open", active);
		const percent = state.importTotal ? Math.round(clamp(state.importCurrent / state.importTotal, 0, 1) * 100) : 0;
		if (bar) bar.style.width = `${percent}%`;
		if (label) label.textContent = state.importStatus || (active ? `执行进度 ${percent}%` : "");
		if (busyStatus) busyStatus.textContent = state.importStatus || "正在处理场景素材，请稍候…";
		if (busyBar) busyBar.style.width = `${percent}%`;
		if (busyPercent) busyPercent.textContent = `${percent}%`;
		if (state.importButton) {
			state.importButton.textContent = state.importing ? "导入中" : "➕";
			state.importButton.disabled = !!state.importing || !!state.annotating;
			state.importButton.title = state.importing ? "正在导入场景" : "批量智能导入场景";
		}
		refreshAnnotateButtons();
	}

	async function refreshSceneIndex() {
		const token = ++sceneIndexRefreshToken;
		const allScenes = [];
		let page = 1;
		let pageCount = 1;
		do {
			const params = new URLSearchParams({
				page: String(page),
				page_size: "80",
				search: "",
				type: "all",
				sort: "updated_desc",
			});
			const data = await apiJson(`${ENDPOINT}/list?${params.toString()}`);
			if (token !== sceneIndexRefreshToken) return state.allScenes;
			allScenes.push(...(Array.isArray(data.scenes) ? data.scenes : []));
			pageCount = Math.max(1, Number(data.page_count || 1));
			page += 1;
		} while (page <= pageCount);
		if (token !== sceneIndexRefreshToken) return state.allScenes;
		state.allScenes = allScenes;
		globalThis.dispatchEvent(new CustomEvent("gjj_scene_library_updated", { detail: { scenes: allScenes.slice(), complete: true } }));
		return allScenes;
	}

	async function refreshScenes(keepSelection = true) {
		const params = new URLSearchParams({
			page: String(state.page),
			page_size: String(state.pageSize),
			search: state.search || "",
			type: state.type || "all",
			sort: state.sort || "updated_desc",
		});
		const data = await apiJson(`${ENDPOINT}/list?${params.toString()}`);
		const previous = keepSelection ? state.selectedId : "";
		state.scenes = Array.isArray(data.scenes) ? data.scenes : [];
		state.page = Math.max(1, Number(data.page || state.page || 1));
		state.pageSize = Math.max(1, Number(data.page_size || state.pageSize || 15));
		state.pageCount = Math.max(1, Number(data.page_count || 1));
		state.selectedId = state.scenes.some((item) => item.id === previous) ? previous : (state.scenes[0]?.id || "");
		globalThis.dispatchEvent(new CustomEvent("gjj_scene_library_updated", { detail: { scenes: state.scenes.slice() } }));
		renderPanel();
		void refreshSceneIndex().catch((error) => console.warn("[GJJ SceneLibrary] 刷新完整场景索引失败。", error));
		return state.scenes;
	}

	async function createScene() {
		const data = await apiJson(`${ENDPOINT}/scene`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: autoSceneName(), type: "360" }),
		});
		state.selectedId = data.scene?.id || "";
		await refreshScenes(true);
		setStatus("已创建场景");
	}

	async function saveSceneFromForm() {
		const panel = document.getElementById(PANEL_ID);
		const selected = selectedScene();
		const name = panel?.querySelector("[data-sl-name]")?.value || selected?.name || autoSceneName();
		const type = panel?.querySelector("[data-sl-type]")?.value || selected?.type || "360";
		const keywords = panel?.querySelector("[data-sl-keywords]")?.value || "";
		const notes = panel?.querySelector("[data-sl-notes]")?.value || "";
		const data = await apiJson(`${ENDPOINT}/scene`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: selected?.id || name, name, type, keywords, notes, sync_id: true }),
		});
		state.selectedId = data.scene?.id || selected?.id || "";
		await refreshScenes(true);
		setStatus("场景已保存");
	}

	async function deleteScene(scene) {
		if (!scene) return;
		const confirmed = window.confirm(`确定删除整个场景“${scene.name || scene.id}”吗？\n\n这会删除场景资料及其全部素材；删除标签不需要执行此操作。`);
		if (!confirmed) {
			setStatus("已取消删除场景");
			return;
		}
		await apiJson(`${ENDPOINT}/scene?id=${encodeURIComponent(scene.id)}`, { method: "DELETE" });
		state.selectedMarkId = "";
		state.selectedId = "";
		await refreshScenes(false);
		setStatus("场景已删除");
	}

	async function showModelTree() {
		const data = await apiJson(`${ENDPOINT}/model_tree`);
		const panel = buildPanel();
		panel.querySelector(".gjj-sl-model-backdrop")?.remove();
		const backdrop = document.createElement("div");
		backdrop.className = "gjj-sl-model-backdrop";
		const dialog = document.createElement("div");
		dialog.className = "gjj-sl-model-dialog";
		let outsidePointerHandler = null;
		const closeDialog = () => {
			if (outsidePointerHandler) document.removeEventListener("pointerdown", outsidePointerHandler, true);
			outsidePointerHandler = null;
			backdrop.remove();
		};
		const head = document.createElement("div");
		head.className = "gjj-sl-model-head";
		const title = document.createElement("div");
		title.className = "gjj-sl-model-title";
		title.textContent = data.title || "场景库依赖目录树";
		const spacer = document.createElement("div");
		spacer.className = "gjj-sl-spacer";
		const values = { ...(data.settings || {}) };
		const save = data.settings_section ? button("保存设置", "保存场景库模型设置", "gjj-sl-btn", async () => {
			await apiJson("/gjj/user_settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ section: data.settings_section, values }),
			});
			setStatus("场景库模型设置已保存");
			closeDialog();
		}) : null;
		head.append(title, spacer);
		if (save) head.appendChild(save);
		head.appendChild(button("❌关闭", "关闭", "gjj-sl-btn", closeDialog));
		const body = document.createElement("div");
		body.className = "gjj-sl-model-body";
		const controls = Array.isArray(data.controls) ? data.controls : [];
		for (const group of data.groups || []) {
			const groupEl = document.createElement("div");
			groupEl.className = "gjj-sl-model-group";
			const groupTitle = document.createElement("div");
			groupTitle.className = "gjj-sl-model-group-title";
			groupTitle.textContent = group.name || "依赖";
			const treeHost = document.createElement("div");
			const renderTree = () => {
				const tree = createSharedModelTree(group.items || [], controls, values, () => {
					queueMicrotask(renderTree);
				});
				treeHost.replaceChildren(tree);
			};
			renderTree();
			groupEl.append(groupTitle, treeHost);
			body.appendChild(groupEl);
		}
		dialog.append(head, body);
		backdrop.appendChild(dialog);
		backdrop.addEventListener("click", (event) => {
			stop(event);
			if (event.target === backdrop) closeDialog();
		});
		panel.appendChild(backdrop);
		outsidePointerHandler = (event) => {
			if (!dialog.contains(event.target)) closeDialog();
		};
		document.addEventListener("pointerdown", outsidePointerHandler, true);
	}

	async function showGenerationSettings() {
		const data = await apiJson("/gjj/user_settings");
		const values = { ...(data.settings?.scene_library || {}) };
		const groups = [
			["🖼️ 最终输出", [
				["final_width", "最终宽度", "number", 2048, "建议与高度保持 2:1；范围 256–8192。", 256, 8192, 8],
				["final_height", "最终高度", "number", 1024, "最终保存 PNG 的实际高度；范围 128–4096。", 128, 4096, 8],
			]],
			["🌏 360° 生成", [
				["base_width", "生成底图宽度", "number", 1024, "进入 SeedVR2 前的全景宽度。", 256, 4096, 8],
				["base_height", "生成底图高度", "number", 512, "建议与底图宽度保持 2:1。", 128, 2048, 8],
				["generation_steps", "采样步数", "number", 4, "主生成与中缝修复使用的步数。", 1, 100, 1],
				["generation_cfg", "CFG", "number", 1, "提示词引导强度。", 0, 100, 0.1],
				["generation_seed", "随机种子", "number", 0, "同一图片与参数可复现结果。", 0, Number.MAX_SAFE_INTEGER, 1],
				["generation_denoise", "降噪强度", "number", 1, "0–1，越高改动越明显。", 0, 1, 0.01],
				["repair_enabled", "启用中缝修复", "checkbox", true, "关闭可提速，但全景接缝可能明显。"],
				["seam_mask_width", "中缝遮罩宽度", "number", 256, "修复区域宽度。", 0, 2048, 8],
				["seam_blur", "中缝羽化", "number", 24, "遮罩边缘过渡宽度。", 0, 256, 1],
				["vae_decode_tiled", "低显存 VAE 分块解码", "checkbox", true, "同时用于 360 底图和中缝修复，建议低显存用户开启。"],
				["vae_decode_tile_size", "VAE 解码块大小", "number", 512, "显存不足时可降至 256；数值越小越省显存但更慢。", 64, 2048, 64],
			]],
			["🔍 SeedVR2 放大", [
				["seedvr2_enabled", "启用 SeedVR2", "checkbox", true, "关闭后直接缩放底图到最终尺寸。"],
				["seedvr2_color_correction", "颜色校正", "select", "lab", "LAB 通常能更稳定地保留原图色彩。", ["lab", "wavelet", "none"]],
				["seedvr2_input_noise", "输入噪声", "number", 0, "范围 0–1。", 0, 1, 0.01],
				["seedvr2_latent_noise", "潜空间噪声", "number", 0, "范围 0–1。", 0, 1, 0.01],
				["seedvr2_encode_tiled", "VAE 分块编码", "checkbox", true, "降低编码显存占用。"],
				["seedvr2_encode_tile_size", "编码块大小", "number", 512, "范围 128–2048。", 128, 2048, 64],
				["seedvr2_encode_tile_overlap", "编码块重叠", "number", 128, "范围 0–1024。", 0, 1024, 16],
				["seedvr2_decode_tiled", "VAE 分块解码", "checkbox", true, "降低解码显存占用。"],
				["seedvr2_decode_tile_size", "解码块大小", "number", 512, "范围 128–2048。", 128, 2048, 64],
				["seedvr2_decode_tile_overlap", "解码块重叠", "number", 128, "范围 0–1024。", 0, 1024, 16],
			]],
		];
		const panel = buildPanel();
		panel.querySelector(".gjj-sl-settings-backdrop")?.remove();
		const backdrop = document.createElement("div");
		backdrop.className = "gjj-sl-model-backdrop gjj-sl-settings-backdrop";
		const dialog = document.createElement("div");
		dialog.className = "gjj-sl-model-dialog";
		const head = document.createElement("div");
		head.className = "gjj-sl-model-head";
		const title = document.createElement("div");
		title.className = "gjj-sl-model-title";
		title.textContent = "⚙️ 场景生成设置";
		const spacer = document.createElement("div");
		spacer.className = "gjj-sl-spacer";
		const save = button("保存设置", "保存并应用到之后的导入任务", "gjj-sl-btn", async () => {
			await apiJson("/gjj/user_settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ section: "scene_library", values }),
			});
			setStatus(`场景生成设置已保存：${values.final_width || 2048}×${values.final_height || 1024}`);
			backdrop.remove();
		});
		head.append(title, spacer, save, button("❌关闭", "关闭设置", "gjj-sl-btn", () => backdrop.remove()));
		const body = document.createElement("div");
		body.className = "gjj-sl-model-body";
		for (const [groupName, fields] of groups) {
			const group = document.createElement("div");
			group.className = "gjj-sl-model-group";
			const groupTitle = document.createElement("div");
			groupTitle.className = "gjj-sl-model-group-title";
			groupTitle.textContent = groupName;
			const grid = document.createElement("div");
			grid.className = "gjj-sl-settings-grid";
			for (const [key, label, type, fallback, hint, minOrOptions, max, step] of fields) {
				const field = document.createElement("label");
				field.className = "gjj-sl-setting";
				const caption = document.createElement("span");
				caption.className = "gjj-sl-setting-label";
				caption.textContent = label;
				let input;
				if (type === "checkbox") {
					input = document.createElement("input");
					input.type = "checkbox";
					input.checked = values[key] == null ? Boolean(fallback) : Boolean(values[key]);
					const row = document.createElement("span");
					row.className = "gjj-sl-setting-check";
					row.append(input, document.createTextNode(input.checked ? "已启用" : "已关闭"));
					input.addEventListener("change", () => {
						values[key] = input.checked;
						row.lastChild.textContent = input.checked ? "已启用" : "已关闭";
					});
					field.append(caption, row);
				} else if (type === "select") {
					input = document.createElement("select");
					for (const optionValue of minOrOptions || []) {
						const option = document.createElement("option");
						option.value = optionValue;
						option.textContent = optionValue;
						input.appendChild(option);
					}
					input.value = String(values[key] ?? fallback);
					input.addEventListener("change", () => { values[key] = input.value; });
					field.append(caption, input);
				} else {
					input = document.createElement("input");
					input.type = "number";
					input.value = String(values[key] ?? fallback);
					input.min = String(minOrOptions);
					input.max = String(max);
					input.step = String(step);
					input.addEventListener("input", () => { values[key] = Number(input.value); });
					field.append(caption, input);
				}
				const help = document.createElement("span");
				help.className = "gjj-sl-setting-hint";
				help.textContent = hint;
				field.appendChild(help);
				grid.appendChild(field);
			}
			group.append(groupTitle, grid);
			body.appendChild(group);
		}
		dialog.append(head, body);
		backdrop.appendChild(dialog);
		backdrop.addEventListener("click", (event) => {
			stop(event);
			if (event.target === backdrop) backdrop.remove();
		});
		panel.appendChild(backdrop);
	}

	function showSceneLibraryHelp() {
		const panel = buildPanel();
		panel.querySelector(".gjj-sl-help-backdrop")?.remove();
		const backdrop = document.createElement("div");
		backdrop.className = "gjj-sl-model-backdrop gjj-sl-help-backdrop";
		const dialog = document.createElement("div");
		dialog.className = "gjj-sl-model-dialog";
		const head = document.createElement("div");
		head.className = "gjj-sl-model-head";
		const title = document.createElement("div");
		title.className = "gjj-sl-model-title";
		title.textContent = "❓ 场景库详细使用方法";
		const spacer = document.createElement("div");
		spacer.className = "gjj-sl-spacer";
		head.append(title, spacer, button("❌关闭", "关闭帮助", "gjj-sl-btn", () => backdrop.remove()));
		const body = document.createElement("div");
		body.className = "gjj-sl-model-body";
		body.style.cssText = "display:block;overflow:auto;padding:12px 16px;color:#dce8e4;font:13px/1.65 system-ui,'Microsoft YaHei',sans-serif;";
		body.innerHTML = `
			<section>
				<h3>一、场景库用途</h3>
				<p>场景库用于保存地点、环境图、360°全景图、关键词和场景备注。分镜提示词中使用 <code>🏕️场景名</code> 引用；指定标注位置时可写 <code>🏕️场景名/位置名</code>。</p>
			</section>
			<section>
				<h3>二、顶部按钮</h3>
				<ul>
					<li><b>➕ 批量智能导入：</b>一次选择多张场景图，自动建立场景；需要时生成对应的 360°全景图。</li>
					<li><b>⬆ 导入场景：</b>给当前场景上传或替换素材。</li>
					<li><b>🧑‍🎨 批量打标：</b>单击给全库缺失内容补充关键词和备注；双击切换“导入后自动打标”。</li>
					<li><b>🧠 模型树：</b>查看模型所在目录，设置 360°生成和自动打标模型；点击模型行可搜索选择，复制按钮可复制模型名。</li>
					<li><b>⚙️ 生成设置：</b>调整最终图片尺寸、360°采样与中缝修复参数，以及 SeedVR2 放大和分块参数。</li>
					<li><b>❓ 帮助：</b>打开当前这份场景库完整说明。</li>
				</ul>
			</section>
			<section>
				<h3>三、360°场景生成</h3>
				<p>智能导入先生成并修复 1024×512 的自然无缝等距柱状全景底图，再调用 <code>GJJ_SeedVR2ImageUpscaler</code> 官方工作流放大为 2048×1024。默认优先使用 Qwen Image Edit 2511 int4 UNET、Qwen 2.5 VL int4 CLIP 和 Qwen Image VAE。</p>
				<p>在 🧠 模型树中可分别修改生成 UNET、CLIP、VAE，以及 SeedVR2 放大主模型和 SeedVR2 VAE。修改后必须点击“保存设置”；之后的新导入任务才会使用新模型。</p>
			</section>
			<section>
				<h3>四、整理、搜索与引用</h3>
				<ul>
					<li>填写场景类型、关键词和备注可提升搜索与自动引用的准确性。</li>
					<li>搜索框支持场景名、关键词和物品描述；卡片内可继续维护素材和标注。</li>
					<li>分镜引用必须与场景库名称一致；重名场景建议先改成更明确的地点名。</li>
				</ul>
			</section>
			<section>
				<h3>五、常见问题</h3>
				<ul>
					<li><b>保存后仍使用旧模型：</b>重新打开 🧠，确认树中显示的新名称；模型必须位于对应的 ComfyUI/models 子目录。</li>
					<li><b>模型列表为空：</b>刷新模型列表或重启 ComfyUI，并检查 diffusion_models、text_encoders、vae、loras 目录。</li>
					<li><b>全景接缝明显：</b>换用清晰、透视稳定、遮挡较少的源图，并避免原图包含文字或边框。</li>
					<li><b>没有自动打标：</b>双击 🧑‍🎨 开启导入后自动打标，或单击它手动补全已有场景。</li>
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
			stop(event);
			if (event.target === backdrop) backdrop.remove();
		});
		panel.appendChild(backdrop);
	}

	async function autoImportScenes(scene = null) {
		if (state.importing) return;
		const files = await fileInput("image/*,.hdr,.exr", true);
		if (!files?.length) return;
		state.importing = true;
		setImportProgress(0.02, files.length + 1, `准备上传 ${files.length} 个场景...`);
		setStatus(`准备导入 ${files.length} 个场景...`);
		const importedIds = [];
		const errors = [];
		try {
			for (let index = 0; index < files.length; index++) {
				const file = files[index];
				state.importActiveIndex = index;
				state.importNodeId = `gjj_scene_import_${Date.now()}_${index}`;
				setImportProgress(index + 0.02, files.length + 1, `正在上传 ${index + 1}/${files.length}：${file.name}`);
				const form = new FormData();
				if (scene?.id) form.append("id", scene.id);
				form.append("name", scene?.name || autoSceneName(file));
				form.append("label", baseNameFromFile(file, "场景"));
				form.append("unique_id", state.importNodeId);
				form.append("file", file, file.name);
				try {
					const data = await apiJson(`${ENDPOINT}/import_auto`, { method: "POST", body: form });
					const id = data.scene?.id || scene?.id || "";
					if (id && !importedIds.includes(id)) importedIds.push(id);
					state.selectedId = id || state.selectedId;
					await refreshScenes(true);
				} catch (error) {
					errors.push(GJJ_Utils.operationProblem(`添加资产“${file.name}”`, error));
				}
			}
			if (importedIds.length && state.autoAnnotate) {
				setImportProgress(files.length, files.length + 1, "正在用 🧠 给新场景自动打标...");
				await annotateMissingScenes(importedIds);
			} else if (importedIds.length) {
				setImportProgress(files.length + 1, files.length + 1, "导入完成，自动打标已关闭");
			}
			setImportProgress(files.length + 1, files.length + 1, errors.length ? `导入完成，失败 ${errors.length} 个` : "导入完成");
			setStatus(errors.length ? `导入完成，失败 ${errors.length} 个：\n${errors.join("\n\n")}` : (state.autoAnnotate ? `已导入 ${importedIds.length || files.length} 个场景并完成自动打标` : `已导入 ${importedIds.length || files.length} 个场景；自动打标已关闭`));
		} catch (error) {
			throw new Error(GJJ_Utils.operationProblem("添加场景资产", error));
		} finally {
			state.importing = false;
			state.importNodeId = "";
			setImportProgress(state.importCurrent, state.importTotal, state.importStatus);
			setTimeout(() => {
				if (!state.importing) setImportProgress(0, 0, "");
			}, 1800);
			await refreshScenes(true).catch((error) => setStatus(error.message));
		}
	}

	async function uploadAsset(scene = null) {
		return autoImportScenes(scene);
	}

	async function saveAnnotations(scene, annotations) {
		if (!scene) return;
		const data = await apiJson(`${ENDPOINT}/annotations`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: scene.id, annotations }),
		});
		state.selectedId = data.scene?.id || scene.id;
		await refreshScenes(true);
		setStatus("物品坐标已保存到 JS 可读取的场景数据");
	}

	async function sendCurrentSceneViewToCanvas(scene) {
		if (state.cameraSending) return;
		const viewer = state.activeViewer;
		if (!viewer?.isReady?.()) {
			setStatus("当前场景视图还在加载，请等预览稳定后再截图");
			return;
		}
		const dataUrl = viewer?.screenshotDataUrl?.() || "";
		if (!dataUrl) {
			setStatus("当前场景视图还没有加载完成");
			return;
		}
		state.cameraSending = true;
		renderPanel();
		try {
			const safeName = String(scene?.name || scene?.id || "scene").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 48) || "scene";
			setStatus("正在发送当前场景视图到画布...");
			const uploaded = await uploadImageDataUrl(dataUrl, `scene_view_${safeName}_${Date.now()}.png`);
			await importIntoAnyPreview({
				...uploaded,
				media_type: "image",
				label: `${scene?.name || "场景"} 当前视图`,
			});
			setStatus("已将当前场景视图发送到 GJJ_AnyPreview");
		} finally {
			state.cameraSending = false;
			renderPanel();
		}
	}

	function sceneViewportReferenceText(scene, asset) {
		const viewer = state.activeViewer;
		if (!viewer?.isReady?.()) return "";
		const frame = viewer?.viewportFrame?.();
		if (!frame) return "";
		const sceneName = String(scene?.name || scene?.id || "").trim();
		if (!sceneName) return "";
		const nums = [frame.x, frame.y, frame.w, frame.h].map((value) => Number(value || 0).toFixed(4)).join(",");
		return `[${sceneName}:${nums}]`;
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

	async function copyOrInsertCurrentSceneViewport(scene, buttonEl = null) {
		const asset = sceneCover(scene);
		const text = sceneViewportReferenceText(scene, asset);
		if (!text) {
			setStatus("当前场景视窗还没有加载完成");
			return;
		}
		if (insertAtRememberedText(text)) {
			flashButton(buttonEl, "已插入");
			setStatus(`已插入当前视窗引用：${text}`);
			return;
		}
		await copyText(text);
		flashButton(buttonEl, "已复制");
		setStatus(`已复制当前视窗引用：${text}`);
	}

	async function copyOrInsertSceneMarkReference(scene, mark, buttonEl = null) {
		const text = referenceText(scene, mark);
		if (!text) return;
		if (insertAtRememberedText(text)) {
			await copyText(text);
			flashButton(buttonEl, "已插入+复制");
			setStatus(`已插入并复制标签引用：${text}`);
			return;
		}
		await copyText(text);
		flashButton(buttonEl, "已复制");
		setStatus(`已复制标签引用：${text}`);
	}

	async function deleteSceneMark(scene, mark, event = null) {
		event?.preventDefault?.();
		event?.stopImmediatePropagation?.();
		event?.stopPropagation?.();
		if (!scene?.id || !mark?.id) {
			throw new Error("标签或场景 ID 无效，已阻止删除");
		}
		state.selectedMarkId = "";
		const next = (scene.annotations || []).filter((item) => item.id !== mark.id);
		const data = await apiJson(`${ENDPOINT}/annotations`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: scene.id, annotations: next }),
		});
		if (!data.scene || String(data.scene.id || "") !== String(scene.id)) {
			throw new Error("标签删除返回的场景不一致，已停止刷新");
		}
		state.selectedId = scene.id;
		await refreshScenes(true);
		setStatus(`已删除标签“${mark.keyword || mark.id}”，场景已保留`);
	}

	async function annotateMissingScenes(ids = []) {
		if (state.annotating) return;
		state.annotating = true;
		state.annotateNodeId = `gjj_scene_annotate_${Date.now()}`;
		const idSet = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
		const candidates = idSet.size ? state.scenes.filter((item) => idSet.has(item.id)) : state.scenes;
		const missingCount = candidates.filter((item) => {
			const hasAsset = (item.assets || []).some((asset) => asset.preview_url);
			const done = (item.annotations || []).length && (item.keywords || []).length && String(item.notes || "").trim();
			const needsRename = String(item.name || "").toLowerCase().includes("_unsaved")
				|| !/[\u3400-\u9fff]/.test(String(item.name || ""))
				|| !/[\u3400-\u9fff]/.test(String(item.id || ""));
			return hasAsset && (!done || needsRename);
		}).length;
		const total = Math.max(1, missingCount || candidates.length || 1);
		setImportProgress(0, total, missingCount ? `正在用大模型给 ${missingCount} 个场景自动打标...` : "正在扫描未打标场景...");
		setStatus(missingCount ? `正在用大模型给 ${missingCount} 个场景自动打标...` : "正在扫描未打标场景...");
		try {
			const data = await apiJson(`${ENDPOINT}/annotate_missing`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					ids: Array.from(idSet),
					unique_id: state.annotateNodeId,
				}),
			});
			setImportProgress(total, total, "自动打标完成");
			await refreshScenes(true);
			const skipped = Array.isArray(data.skipped) ? data.skipped : [];
			const firstSkip = skipped.find((item) => item?.reason);
			const skipText = firstSkip ? `；示例：${firstSkip.name || firstSkip.id || "场景"}：${firstSkip.reason}` : "";
			setStatus(`自动打标完成：已处理 ${data.processed_count || 0} 个场景，跳过 ${data.skipped_count || 0} 个${skipText}`);
		} finally {
			state.annotating = false;
			state.annotateNodeId = "";
			setImportProgress(state.importCurrent, state.importTotal, state.importStatus);
			setTimeout(() => {
				if (!state.importing && !state.annotating) setImportProgress(0, 0, "");
			}, 1800);
		}
	}

	function sceneCover(scene) {
		return (scene?.assets || []).find((item) => item.preview_url) || null;
	}

	function streamSceneThumbnail(img, url) {
		img.loading = "eager";
		img.decoding = "async";
		img.fetchPriority = "high";
		img.src = url;
	}

	function createScenePanoramaRenderer(canvas, status, onRender, onPick) {
		const ctx = canvas.getContext("2d", { willReadFrequently: false });
		const sampleCanvas = document.createElement("canvas");
		const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
		const viewer = {
			imageData: null,
			imageWidth: 0,
			imageHeight: 0,
			yaw: 0,
			pitch: 0,
			fov: Math.PI / 2.2,
			lastX: 0,
			lastY: 0,
			dragging: false,
			moved: false,
			lastDragAt: 0,
			dirty: true,
			renderScale: 0.75,
			loadToken: 0,
			ready: false,
			statusText: "正在加载 360 全景预览",
			errorText: "",
		};
		function setViewerStatus(text) {
			if (status) status.textContent = text || "";
		}
		function resizeBacking() {
			const rect = canvas.getBoundingClientRect();
			const width = Math.max(180, Math.round(rect.width * viewer.renderScale));
			const height = Math.max(120, Math.round(rect.height * viewer.renderScale));
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
				viewer.dirty = true;
			}
		}
		function paintProjection(targetCtx, width, height) {
			if (!viewer.imageData) {
				targetCtx.fillStyle = "#071014";
				targetCtx.fillRect(0, 0, width, height);
				targetCtx.fillStyle = viewer.errorText ? "#ff9fb4" : "#8fa5ad";
				targetCtx.font = "700 13px system-ui";
				targetCtx.textAlign = "center";
				targetCtx.fillText(viewer.errorText || viewer.statusText || "正在加载 360 全景预览", width / 2, height / 2);
				return;
			}
			const out = targetCtx.createImageData(width, height);
			const dst = out.data;
			const src = viewer.imageData.data;
			const sw = viewer.imageData.width;
			const sh = viewer.imageData.height;
			const aspect = width / Math.max(1, height);
			const tanFov = Math.tan(viewer.fov / 2);
			const cy = Math.cos(viewer.yaw);
			const sy = Math.sin(viewer.yaw);
			const cp = Math.cos(viewer.pitch);
			const sp = Math.sin(viewer.pitch);
			for (let y = 0; y < height; y++) {
				const py = (1 - (y + 0.5) / height * 2) * tanFov;
				for (let x = 0; x < width; x++) {
					const px = (((x + 0.5) / width) * 2 - 1) * tanFov * aspect;
					let dx = px;
					let dy = py;
					let dz = -1;
					const invLen = 1 / Math.hypot(dx, dy, dz);
					dx *= invLen;
					dy *= invLen;
					dz *= invLen;
					const dy2 = dy * cp - dz * sp;
					const dz2 = dy * sp + dz * cp;
					const dx3 = dx * cy + dz2 * sy;
					const dz3 = -dx * sy + dz2 * cy;
					const lon = Math.atan2(dx3, -dz3);
					const lat = Math.asin(clamp(dy2, -1, 1));
					let u = (lon / (Math.PI * 2) + 0.5) * sw;
					let v = (0.5 - lat / Math.PI) * sh;
					u = ((u % sw) + sw) % sw;
					v = clamp(v, 0, sh - 1);
					const si = (Math.floor(v) * sw + Math.floor(u)) * 4;
					const di = (y * width + x) * 4;
					dst[di] = src[si];
					dst[di + 1] = src[si + 1];
					dst[di + 2] = src[si + 2];
					dst[di + 3] = 255;
				}
			}
			targetCtx.putImageData(out, 0, 0);
		}
		function render() {
			resizeBacking();
			if (!viewer.dirty) return;
			viewer.dirty = false;
			paintProjection(ctx, canvas.width, canvas.height);
			if (viewer.ready) {
				setViewerStatus(`360视角 ${Math.round(viewer.yaw * 180 / Math.PI)}° · 缩放 ${Math.round((Math.PI / viewer.fov) * 36)}%`);
			} else {
				setViewerStatus(viewer.errorText || viewer.statusText || "");
			}
			onRender?.();
		}
		async function setImageUrl(url, label = "") {
			const token = ++viewer.loadToken;
			viewer.ready = false;
			viewer.imageData = null;
			viewer.errorText = "";
			viewer.statusText = "正在加载 360 全景预览...";
			viewer.dirty = true;
			render();
			try {
				const image = await loadImage(url);
				if (token !== viewer.loadToken) return false;
				const maxSource = 4096;
				const scale = Math.min(1, maxSource / Math.max(image.width, image.height));
				sampleCanvas.width = Math.max(1, Math.round(image.width * scale));
				sampleCanvas.height = Math.max(1, Math.round(image.height * scale));
				sampleCtx.drawImage(image, 0, 0, sampleCanvas.width, sampleCanvas.height);
				viewer.imageData = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
				viewer.imageWidth = image.width;
				viewer.imageHeight = image.height;
				viewer.ready = true;
				viewer.dirty = true;
				render();
				setViewerStatus(`${label || "360全景"} ${image.width} x ${image.height} · 拖动查看，滚轮缩放`);
				return true;
			} catch (error) {
				if (token !== viewer.loadToken) return false;
				viewer.ready = false;
				viewer.imageData = null;
				viewer.errorText = error?.message || "360 全景预览加载失败";
				viewer.dirty = true;
				render();
				throw error;
			}
		}
		function nudge(dx, dy) {
			viewer.yaw += dx;
			viewer.pitch = clamp(viewer.pitch + dy, -Math.PI / 2 + 0.03, Math.PI / 2 - 0.03);
			viewer.dirty = true;
			render();
		}
		function zoom(delta) {
			viewer.fov = clamp(viewer.fov * (delta > 0 ? 1.08 : 0.92), Math.PI / 8, Math.PI * 0.92);
			viewer.dirty = true;
			render();
		}
		function screenshotSize() {
			const rect = (canvas.parentElement || canvas).getBoundingClientRect();
			const cssWidth = Math.max(320, Math.round(rect.width || canvas.clientWidth || canvas.width || 768));
			const cssHeight = Math.max(180, Math.round(rect.height || canvas.clientHeight || canvas.height || 420));
			const scale = clamp(Math.min(2, 1920 / cssWidth, 1080 / cssHeight), 1, 2);
			return {
				width: Math.max(320, Math.round(cssWidth * scale)),
				height: Math.max(180, Math.round(cssHeight * scale)),
			};
		}
		function screenshotDataUrl() {
			if (!viewer.ready || !viewer.imageData) return "";
			viewer.dirty = true;
			render();
			const size = screenshotSize();
			const out = document.createElement("canvas");
			out.width = size.width;
			out.height = size.height;
			paintProjection(out.getContext("2d"), out.width, out.height);
			return out.toDataURL("image/png");
		}
		function viewportFrame() {
			if (!viewer.ready || !viewer.imageData) return null;
			const rect = canvas.getBoundingClientRect();
			const width = Math.max(1, rect.width || canvas.clientWidth || canvas.width || 1);
			const height = Math.max(1, rect.height || canvas.clientHeight || canvas.height || 1);
			const center = screenToPanorama(rect.left + width * 0.5, rect.top + height * 0.5);
			if (!center) return null;
			const aspect = width / Math.max(1, height);
			const frameW = clamp((viewer.fov * aspect) / (Math.PI * 2), 0.04, 0.95);
			const frameH = clamp(viewer.fov / Math.PI, 0.04, 0.95);
			const x = ((center.x - frameW * 0.5) % 1 + 1) % 1;
			const y = clamp(center.y - frameH * 0.5, 0, 1 - frameH);
			return { x, y, w: frameW, h: frameH };
		}
		function panoramaToScreen(x, y) {
			const rect = canvas.getBoundingClientRect();
			const width = Math.max(1, rect.width);
			const height = Math.max(1, rect.height);
			const lon = (Number(x || 0) - 0.5) * Math.PI * 2;
			const lat = (0.5 - Number(y || 0)) * Math.PI;
			const cl = Math.cos(lat);
			const wx = Math.sin(lon) * cl;
			const wy = Math.sin(lat);
			const wz = -Math.cos(lon) * cl;
			const cy = Math.cos(viewer.yaw);
			const sy = Math.sin(viewer.yaw);
			const cp = Math.cos(viewer.pitch);
			const sp = Math.sin(viewer.pitch);
			const x1 = wx * cy - wz * sy;
			const z1 = wx * sy + wz * cy;
			const y2 = wy * cp + z1 * sp;
			const z2 = -wy * sp + z1 * cp;
			if (z2 >= -0.02) return null;
			const aspect = width / height;
			const tanFov = Math.tan(viewer.fov / 2);
			const sx = (x1 / -z2 / (tanFov * aspect) + 1) * 0.5;
			const sy2 = (1 - y2 / -z2 / tanFov) * 0.5;
			if (sx < -0.08 || sx > 1.08 || sy2 < -0.08 || sy2 > 1.08) return null;
			return { left: sx * width, top: sy2 * height };
		}
		function centerOn(x, y) {
			const lon = (Number(x || 0) - 0.5) * Math.PI * 2;
			const lat = (0.5 - Number(y || 0)) * Math.PI;
			viewer.yaw = -lon;
			viewer.pitch = clamp(lat, -Math.PI / 2 + 0.03, Math.PI / 2 - 0.03);
			viewer.dirty = true;
			render();
		}
		function screenToPanorama(clientX, clientY) {
			const rect = canvas.getBoundingClientRect();
			if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
			const width = Math.max(1, rect.width);
			const height = Math.max(1, rect.height);
			const aspect = width / height;
			const tanFov = Math.tan(viewer.fov / 2);
			let dx = (((clientX - rect.left + 0.5) / width) * 2 - 1) * tanFov * aspect;
			let dy = (1 - ((clientY - rect.top + 0.5) / height) * 2) * tanFov;
			let dz = -1;
			const invLen = 1 / Math.hypot(dx, dy, dz);
			dx *= invLen;
			dy *= invLen;
			dz *= invLen;
			const cy = Math.cos(viewer.yaw);
			const sy = Math.sin(viewer.yaw);
			const cp = Math.cos(viewer.pitch);
			const sp = Math.sin(viewer.pitch);
			const dy2 = dy * cp - dz * sp;
			const dz2 = dy * sp + dz * cp;
			const dx3 = dx * cy + dz2 * sy;
			const dz3 = -dx * sy + dz2 * cy;
			const lon = Math.atan2(dx3, -dz3);
			const lat = Math.asin(clamp(dy2, -1, 1));
			return {
				x: ((lon / (Math.PI * 2) + 0.5) % 1 + 1) % 1,
				y: clamp(0.5 - lat / Math.PI, 0, 1),
			};
		}
		canvas.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			viewer.dragging = true;
			viewer.moved = false;
			viewer.lastX = event.clientX;
			viewer.lastY = event.clientY;
			canvas.setPointerCapture?.(event.pointerId);
		});
		canvas.addEventListener("pointermove", (event) => {
			if (!viewer.dragging) return;
			event.preventDefault();
			event.stopPropagation();
			const dx = event.clientX - viewer.lastX;
			const dy = event.clientY - viewer.lastY;
			viewer.lastX = event.clientX;
			viewer.lastY = event.clientY;
			if (Math.abs(dx) + Math.abs(dy) > 2) viewer.moved = true;
			nudge(-dx * 0.006, dy * 0.006);
		});
		canvas.addEventListener("pointerup", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (viewer.moved) viewer.lastDragAt = Date.now();
			viewer.dragging = false;
			canvas.releasePointerCapture?.(event.pointerId);
		});
		canvas.addEventListener("pointercancel", () => {
			viewer.dragging = false;
		});
		canvas.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (Date.now() - viewer.lastDragAt < 220) return;
			const point = screenToPanorama(event.clientX, event.clientY);
			if (point) onPick?.(point, event.clientX, event.clientY);
		});
		canvas.addEventListener("wheel", (event) => {
			event.preventDefault();
			event.stopPropagation();
			zoom(event.deltaY);
		}, { passive: false });
		window.addEventListener("resize", () => {
			viewer.dirty = true;
			render();
		});
		return {
			render,
			setImageUrl,
			panoramaToScreen,
			screenToPanorama,
			centerOn,
			screenshotDataUrl,
			viewportFrame,
			isReady: () => Boolean(viewer.ready && viewer.imageData),
			wasDragging: () => Date.now() - viewer.lastDragAt < 220,
		};
	}

	function renderSceneList(panel) {
		const list = panel.querySelector(".gjj-sl-list");
		if (!list) return;
		state.thumbnailObserver?.disconnect();
		list.replaceChildren();
		for (const scene of state.scenes) {
			const card = document.createElement("button");
			card.type = "button";
			card.className = `gjj-sl-card${scene.id === state.selectedId ? " active" : ""}`;
			const cover = document.createElement("div");
			cover.className = "gjj-sl-cover";
			const asset = sceneCover(scene);
			if (scene.id) {
				const img = document.createElement("img");
				setGjjLibraryThumbnail(img, api, "scene", scene);
				if (asset) bindSceneAssetDrag(img, scene, asset);
				cover.appendChild(img);
			} else {
				const empty = document.createElement("div");
				empty.className = "gjj-sl-empty-cover";
				empty.textContent = "🏕️";
				cover.appendChild(empty);
			}
			const name = document.createElement("div");
			name.className = "gjj-sl-name";
			name.textContent = scene.name || scene.id;
			const meta = document.createElement("div");
			meta.className = "gjj-sl-meta";
			meta.textContent = `${TYPE_LABELS[scene.type] || "360"} · ${(scene.assets || []).length} 素材 · ${(scene.annotations || []).length} 坐标`;
			card.append(cover, name, meta);
			card.addEventListener("click", () => {
				state.selectedId = scene.id;
				renderPanel();
			});
			list.appendChild(card);
		}
		if (!state.scenes.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-sl-empty";
			empty.textContent = "还没有场景";
			list.appendChild(empty);
		}
		for (const item of panel.querySelectorAll("[data-sl-type-filter]")) item.classList.toggle("active", item.dataset.slTypeFilter === state.type);
		for (const item of panel.querySelectorAll("[data-sl-sort]")) item.classList.toggle("active", item.dataset.slSort === state.sort);
		const pageLabel = panel.querySelector("[data-sl-page-label]");
		if (pageLabel) pageLabel.textContent = `${state.page}/${state.pageCount}`;
		const prev = panel.querySelector("[data-sl-page-prev]");
		const next = panel.querySelector("[data-sl-page-next]");
		if (prev) prev.disabled = state.page <= 1;
		if (next) next.disabled = state.page >= state.pageCount;
	}

	function renderStage(scene, body) {
		const asset = sceneCover(scene);
		const stage = document.createElement("div");
		stage.className = "gjj-sl-stage";
		let img = null;
		let viewer = null;
		state.activeViewer = null;
		const addAnnotationAt = (point, clientX, clientY) => {
			openAnnotationNameEditor(scene, asset, null, point, clientX, clientY);
		};
		const activateMark = (mark) => {
			state.selectedMarkId = mark?.id || "";
			for (const item of stage.querySelectorAll(".gjj-sl-mark")) {
				item.classList.toggle("active", !!state.selectedMarkId && item.dataset.slMarkId === state.selectedMarkId);
			}
			const marks = stage.parentElement?.querySelector(".gjj-sl-marks");
			if (marks) {
				for (const row of marks.querySelectorAll(".gjj-sl-mark-row")) {
					row.classList.toggle("active", !!state.selectedMarkId && row.dataset.slMarkId === state.selectedMarkId);
				}
			}
		};
		const renderMarks = () => {
			stage.querySelectorAll(".gjj-sl-mark").forEach((node) => node.remove());
			if (!asset?.preview_url) return;
			for (const mark of scene.annotations || []) {
				if (mark.asset_id && mark.asset_id !== asset.id) continue;
				const el = document.createElement("div");
				el.className = `gjj-sl-mark${state.selectedMarkId === mark.id ? " active" : ""}`;
				el.dataset.slMarkId = mark.id || "";
				if (viewer) {
					const point = viewer.panoramaToScreen(mark.x, mark.y);
					if (!point) continue;
					el.style.left = `${point.left}px`;
					el.style.top = `${point.top}px`;
				} else {
					el.style.left = `${Number(mark.x || 0) * 100}%`;
					el.style.top = `${Number(mark.y || 0) * 100}%`;
				}
				const label = document.createElement("span");
				label.textContent = mark.keyword || "";
				const tools = document.createElement("div");
				tools.className = "gjj-sl-mark-tools";
				const edit = button("✎", "编辑物品名", "gjj-sl-mark-tool", (event) => {
					openAnnotationNameEditor(scene, asset, mark, { x: mark.x, y: mark.y }, event.clientX, event.clientY);
				});
				const ref = button("@", "引用标签", "gjj-sl-mark-tool", (event) => {
					copyOrInsertSceneMarkReference(scene, mark, event.currentTarget).catch((error) => setStatus(error.message));
				});
				const del = button("×", "只删除此标签，不删除场景", "gjj-sl-mark-tool danger", (event) => {
					deleteSceneMark(scene, mark, event).catch((error) => setStatus(error.message));
				});
				const editAt = (event) => {
					event.preventDefault();
					event.stopPropagation();
					openAnnotationNameEditor(scene, asset, mark, { x: mark.x, y: mark.y }, event.clientX, event.clientY);
				};
				label.addEventListener("dblclick", editAt);
				el.addEventListener("dblclick", editAt);
				el.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					activateMark(mark);
					if (viewer?.centerOn) viewer.centerOn(mark.x, mark.y);
				});
				tools.append(edit, ref, del);
				el.append(label, tools);
				stage.appendChild(el);
			}
		};
		if (asset?.preview_url) {
			stage.classList.add("is-panorama");
			const canvas = document.createElement("canvas");
			const viewerStatus = document.createElement("div");
			viewerStatus.className = "gjj-sl-viewer-status";
			stage.append(canvas, viewerStatus);
			viewer = createScenePanoramaRenderer(canvas, viewerStatus, renderMarks, addAnnotationAt);
			state.activeViewer = viewer;
			viewer.setImageUrl(asset.preview_url, asset.label || scene.name || "360全景").catch((error) => setStatus(error.message));
		} else {
			const empty = document.createElement("div");
			empty.className = "gjj-sl-stage-empty";
			empty.textContent = "点击 ➕ 导入场景后可在 360 预览中标注物品位置";
			stage.appendChild(empty);
		}
		const removeScene = button("删除", "删除当前场景", "gjj-sl-btn danger gjj-sl-stage-delete", () => deleteScene(scene).catch((error) => setStatus(error.message)));
		stage.appendChild(removeScene);
		stage.addEventListener("click", (event) => {
			if (!asset?.preview_url) return;
			let point = null;
			if (viewer) {
				if (viewer.wasDragging()) return;
				point = viewer.screenToPanorama(event.clientX, event.clientY);
			} else if (img) {
				const rect = img.getBoundingClientRect();
				if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
				point = {
					x: (event.clientX - rect.left) / Math.max(1, rect.width),
					y: (event.clientY - rect.top) / Math.max(1, rect.height),
				};
			}
			if (!point) return;
			addAnnotationAt(point, event.clientX, event.clientY);
		});
		renderMarks();
		body.appendChild(stage);
	}

	function renderMain(panel) {
		const main = panel.querySelector(".gjj-sl-main");
		if (!main) return;
		main.replaceChildren();
		const scene = selectedScene();
		const head = document.createElement("div");
		head.className = "gjj-sl-head";
		const title = document.createElement("div");
		title.className = "gjj-sl-title";
		title.textContent = scene ? "场景详情" : "场景库";
		const spacer = document.createElement("div");
		spacer.className = "gjj-sl-spacer";
		head.append(title, spacer, button("❌关闭", "关闭", "gjj-sl-btn", closePanel));
		main.appendChild(head);
		const body = document.createElement("div");
		body.className = "gjj-sl-body";
		main.appendChild(body);
		if (!scene) {
			const empty = document.createElement("div");
			empty.className = "gjj-sl-empty";
			empty.textContent = "点击 ➕ 或上传场景开始入库";
			body.appendChild(empty);
			return;
		}
		const form = document.createElement("div");
		form.className = "gjj-sl-form";
		const name = document.createElement("input");
		name.className = "gjj-sl-input";
		name.dataset.slName = "1";
		name.value = scene.name || scene.id || "";
		const type = document.createElement("input");
		type.type = "hidden";
		type.dataset.slType = "1";
		type.value = "360";
		const save = button("保存", "保存场景信息", "gjj-sl-btn", () => saveSceneFromForm().catch((error) => setStatus(error.message)));
		const open = button("打开目录", "打开场景库目录", "gjj-sl-btn", () => apiJson(`${ENDPOINT}/open_dir`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: scene.id }),
		}).catch((error) => setStatus(error.message)));
		const keywords = document.createElement("input");
		keywords.className = "gjj-sl-input";
		keywords.dataset.slKeywords = "1";
		keywords.placeholder = "关键词，用逗号分隔";
		keywords.value = (scene.keywords || []).join(", ");
		const notes = document.createElement("textarea");
		notes.className = "gjj-sl-textarea";
		notes.dataset.slNotes = "1";
		notes.placeholder = "场景备注";
		notes.value = scene.notes || "";
		form.append(name, type, save, open, keywords, notes);
		body.appendChild(form);
		const actions = document.createElement("div");
		actions.className = "gjj-sl-row";
		const camera = button(state.cameraSending ? "发送中" : "📷", "将当前场景视图发送到 GJJ_AnyPreview", "gjj-sl-btn gjj-sl-icon", () => sendCurrentSceneViewToCanvas(scene).catch((error) => setStatus(error.message)));
		camera.disabled = !!state.cameraSending || !sceneCover(scene)?.preview_url;
		const viewportRef = button("引用视窗", "插入或复制当前场景视窗框引用", "gjj-sl-btn", (event) => copyOrInsertCurrentSceneViewport(scene, event?.currentTarget).catch((error) => setStatus(error.message)));
		viewportRef.disabled = !sceneCover(scene)?.preview_url;
		actions.append(
			button("导入场景", "智能导入并统一转换为 360 PNG", "gjj-sl-btn", () => uploadAsset(scene).catch((error) => setStatus(error.message))),
			camera,
			viewportRef,
			annotateButton([scene.id], "当前场景")
		);
		body.appendChild(actions);
		renderStage(scene, body);
		const marks = document.createElement("div");
		marks.className = "gjj-sl-marks";
		for (const mark of scene.annotations || []) {
			const row = document.createElement("div");
			const isActive = state.selectedMarkId === mark.id;
			row.className = `gjj-sl-mark-row${isActive ? " active" : ""}`;
			row.dataset.slMarkId = mark.id || "";
			const label = document.createElement("button");
			label.type = "button";
			label.className = "gjj-sl-mark-name";
			label.title = `转到：${mark.keyword || ""}`;
			label.textContent = mark.keyword || "";
			label.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				state.selectedMarkId = mark.id;
				for (const item of marks.querySelectorAll(".gjj-sl-mark-row")) item.classList.remove("active");
				row.classList.add("active");
				for (const item of body.querySelectorAll(".gjj-sl-mark")) {
					item.classList.toggle("active", item.dataset.slMarkId === mark.id);
				}
				if (state.activeViewer?.centerOn) {
					state.activeViewer.centerOn(mark.x, mark.y);
					setStatus(`已转到：${mark.keyword || "标注点"}`);
				} else {
					setStatus("当前场景不是可旋转的 360 预览");
				}
			});
			row.appendChild(label);
			const tools = document.createElement("div");
			tools.className = "gjj-sl-mark-actions";
			const edit = button("✎", "编辑物品名", "gjj-sl-btn gjj-sl-icon", (event) => {
				openAnnotationNameEditor(scene, sceneCover(scene), mark, { x: mark.x, y: mark.y }, event.clientX, event.clientY);
			});
			const ref = button("@", "引用标签", "gjj-sl-btn gjj-sl-icon", (event) => {
				copyOrInsertSceneMarkReference(scene, mark, event.currentTarget).catch((error) => setStatus(error.message));
			});
			const del = button("×", "只删除此标签，不删除场景", "gjj-sl-btn gjj-sl-icon", (event) => {
				deleteSceneMark(scene, mark, event).catch((error) => setStatus(error.message));
			});
			tools.append(edit, ref, del);
			row.appendChild(tools);
			marks.appendChild(row);
		}
		body.appendChild(marks);
		const assets = document.createElement("div");
		assets.className = "gjj-sl-assets";
		for (const asset of scene.assets || []) {
			const card = document.createElement("div");
			card.className = "gjj-sl-asset";
			const preview = document.createElement("div");
			preview.className = "gjj-sl-asset-preview";
			if (asset.preview_url) {
				const img = document.createElement("img");
				img.src = apiUrl(asset.preview_url);
				bindSceneAssetDrag(img, scene, asset);
				preview.appendChild(img);
			} else {
				preview.textContent = "场景文件";
			}
			const label = document.createElement("div");
			label.className = "gjj-sl-name";
			label.textContent = asset.label || asset.file || "";
			const meta = document.createElement("div");
			meta.className = "gjj-sl-meta";
			meta.textContent = `360 PNG · ${formatBytes(asset.size)}`;
			card.append(preview, label, meta);
			assets.appendChild(card);
		}
		body.appendChild(assets);
		const status = document.createElement("div");
		status.className = "gjj-sl-status";
		status.textContent = state.status || "";
		body.appendChild(status);
	}

	function clampPanelPosition(panel, left, top) {
		const width = panel.offsetWidth || 940;
		const height = panel.offsetHeight || 700;
		return {
			left: Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8)),
			top: Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8)),
		};
	}

	function clampPanelSize(width, height) {
		return {
			width: Math.round(Math.min(Math.max(560, Number(width) || 940), Math.max(560, window.innerWidth - 16))),
			height: Math.round(Math.min(Math.max(420, Number(height) || 700), Math.max(420, window.innerHeight - 16))),
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
		drag.className = "gjj-sl-drag";
		drag.textContent = "⠿";
		drag.title = "拖动场景库；双击复位大小和位置";
		drag.addEventListener("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
			state.panelPosition = null;
			state.panelSize = null;
			panel.style.width = "";
			panel.style.height = "";
			saveSharedPanelLayout();
			positionPanel(state.lastAnchor || document.getElementById(BUTTON_ID));
		});
		drag.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const rect = panel.getBoundingClientRect();
			const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
			try { drag.setPointerCapture?.(event.pointerId); } catch (_) {}
			const move = (moveEvent) => {
				moveEvent.preventDefault();
				moveEvent.stopPropagation();
				const pos = clampPanelPosition(panel, start.left + moveEvent.clientX - start.x, start.top + moveEvent.clientY - start.y);
				applyPanelPosition(panel, pos);
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
		panel.addEventListener("pointerdown", () => bringPanelToFront(panel), true);
		installPanelResizeMemory(panel);
		const sidebar = document.createElement("div");
		sidebar.className = "gjj-sl-sidebar";
		const head = document.createElement("div");
		head.className = "gjj-sl-head";
		const drag = makePanelDragHandle(panel);
		const title = document.createElement("div");
		title.className = "gjj-sl-title";
		title.textContent = "场景库";
		const spacer = document.createElement("div");
		spacer.className = "gjj-sl-spacer";
		const importButton = button(state.importing ? "导入中" : "➕", "批量智能导入场景", "gjj-sl-btn gjj-sl-icon", () => autoImportScenes(null).catch((error) => setStatus(error.message)));
		importButton.disabled = !!state.importing;
		state.importButton = importButton;
		head.append(drag, title, spacer, importButton);
		head.appendChild(button("⬆", "导入场景文件", "gjj-sl-btn gjj-sl-icon", () => uploadAsset(selectedScene()).catch((error) => setStatus(error.message))));
		head.appendChild(annotateButton([], "全库场景"));
		head.appendChild(button("🧠", "查看并设置场景库使用的模型树", "gjj-sl-btn gjj-sl-icon", () => showModelTree().catch((error) => setStatus(error.message))));
		head.appendChild(button("⚙️", "设置最终图片大小和场景生成参数", "gjj-sl-btn gjj-sl-icon", () => showGenerationSettings().catch((error) => setStatus(error.message))));
		head.appendChild(button("❓", "查看整个场景库的详细实用方法", "gjj-sl-btn gjj-sl-icon", showSceneLibraryHelp));
		const search = document.createElement("input");
		search.className = "gjj-sl-search";
		search.placeholder = "搜索场景、关键词、物品";
		search.value = state.search;
		search.addEventListener("input", () => {
			state.search = search.value || "";
			state.page = 1;
			refreshScenes(true).catch((error) => setStatus(error.message));
		});
		const tools = document.createElement("div");
		tools.className = "gjj-sl-tools";
		for (const [value, label] of [["all", "全部"]]) {
			const item = button(label, `筛选${label}场景`, "gjj-sl-filter", () => {
				state.type = value;
				state.page = 1;
				refreshScenes(true).catch((error) => setStatus(error.message));
			});
			item.dataset.slTypeFilter = value;
			tools.appendChild(item);
		}
		const divider = document.createElement("div");
		divider.className = "gjj-sl-divider";
		tools.appendChild(divider);
		for (const [value, label] of [["updated_desc", "🕘 最新"], ["size_desc", "📦 大"], ["name_asc", "🔤 A-Z"]]) {
			const item = button(label, "排序", "gjj-sl-sort", () => {
				state.sort = value;
				state.page = 1;
				refreshScenes(true).catch((error) => setStatus(error.message));
			});
			item.dataset.slSort = value;
			tools.appendChild(item);
		}
		const list = document.createElement("div");
		list.className = "gjj-sl-list";
		const importProgress = document.createElement("div");
		importProgress.className = "gjj-sl-import-progress";
		importProgress.dataset.slImportProgress = "1";
		const importBar = document.createElement("div");
		importBar.className = "gjj-sl-import-bar";
		importBar.dataset.slImportBar = "1";
		const importText = document.createElement("div");
		importText.className = "gjj-sl-import-text";
		importText.dataset.slImportText = "1";
		importProgress.append(importBar, importText);
		const pager = document.createElement("div");
		pager.className = "gjj-sl-pager";
		const prev = button("‹", "上一页", "gjj-sl-btn gjj-sl-icon", () => {
			state.page = Math.max(1, state.page - 1);
			refreshScenes(true).catch((error) => setStatus(error.message));
		});
		prev.dataset.slPagePrev = "1";
		const pageLabel = document.createElement("div");
		pageLabel.className = "gjj-sl-page-label";
		pageLabel.dataset.slPageLabel = "1";
		const next = button("›", "下一页", "gjj-sl-btn gjj-sl-icon", () => {
			state.page = Math.min(state.pageCount, state.page + 1);
			refreshScenes(true).catch((error) => setStatus(error.message));
		});
		next.dataset.slPageNext = "1";
		pager.append(prev, pageLabel, next);
		sidebar.append(head, search, tools, importProgress, list, pager);
		const main = document.createElement("div");
		main.className = "gjj-sl-main";
		const busyMask = document.createElement("div");
		busyMask.className = "gjj-sl-busy-mask";
		const busyCard = document.createElement("div");
		busyCard.className = "gjj-sl-busy-card";
		const busyTitle = document.createElement("div");
		busyTitle.className = "gjj-sl-busy-title";
		busyTitle.textContent = "⏳ 正在导入场景";
		const busyStatus = document.createElement("div");
		busyStatus.className = "gjj-sl-busy-status";
		busyStatus.dataset.slBusyStatus = "1";
		busyStatus.textContent = state.importStatus || "正在处理场景素材，请稍候…";
		const busyProgress = document.createElement("div");
		busyProgress.className = "gjj-sl-busy-progress";
		const busyProgressBar = document.createElement("div");
		busyProgressBar.className = "gjj-sl-busy-progress-bar";
		busyProgressBar.dataset.slBusyBar = "1";
		busyProgress.appendChild(busyProgressBar);
		const busyPercent = document.createElement("div");
		busyPercent.className = "gjj-sl-busy-percent";
		busyPercent.dataset.slBusyPercent = "1";
		busyCard.append(busyTitle, busyStatus, busyProgress, busyPercent);
		busyMask.appendChild(busyCard);
		panel.classList.toggle("busy", !!state.importing);
		panel.append(sidebar, main, busyMask);
		document.body.appendChild(panel);
		return panel;
	}

	function renderPanel() {
		const panel = buildPanel();
		renderSceneList(panel);
		renderMain(panel);
		setImportProgress(state.importCurrent, state.importTotal, state.importStatus);
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
		try { globalThis.GJJ_CostumeLibrary?.close?.(); } catch (_) {}
		panel.classList.add("open");
		bringPanelToFront(panel);
		document.getElementById(BUTTON_ID)?.classList.add("active");
		positionPanel(anchor);
		await refreshScenes(true).catch((error) => setStatus(error.message));
		positionPanel(anchor);
	}

	function ensureToolbarButton() {
		installStyle();
		const toolbar = document.getElementById(TOOLBAR_ID);
		if (!toolbar || document.getElementById(BUTTON_ID)) return;
		const btn = document.createElement("button");
		btn.id = BUTTON_ID;
		btn.type = "button";
		btn.textContent = "🏕️";
		btn.title = "场景库：导入/管理360场景和物品坐标";
		btn.setAttribute("aria-label", btn.title);
		btn.addEventListener("pointerdown", stop, true);
		btn.addEventListener("mousedown", stop, true);
		btn.addEventListener("mouseup", stop, true);
		btn.addEventListener("click", (event) => {
			stop(event);
			togglePanel(btn);
		});
		const character = document.getElementById(CHARACTER_BUTTON_ID);
		const color = document.getElementById(COLOR_BUTTON_ID);
		if (character?.parentElement === toolbar) character.after(btn);
		else if (color?.parentElement === toolbar) color.after(btn);
		else toolbar.appendChild(btn);
	}

	function installToolbarObserver() {
		ensureToolbarButton();
		if (window.__gjjSceneLibraryToolbarObserver) return;
		window.__gjjSceneLibraryToolbarObserver = true;
		const observer = new MutationObserver(() => ensureToolbarButton());
		observer.observe(document.body, { childList: true, subtree: true });
		for (const delay of [100, 400, 1200, 2600]) setTimeout(ensureToolbarButton, delay);
	}

	async function resolveScene(reference) {
		const text = String(reference || "").trim().replace(/^@/, "");
		if (!text) return null;
		return apiJson(`${ENDPOINT}/resolve?name=${encodeURIComponent(text)}`);
	}

	async function resolvePosition(keyword, sceneName = "") {
		const params = new URLSearchParams({ keyword: String(keyword || "") });
		if (sceneName) params.set("name", sceneName);
		return apiJson(`${ENDPOINT}/resolve?${params.toString()}`);
	}

	function getPositions(keyword = "", sceneId = "") {
		const needle = String(keyword || "").trim().toLowerCase();
		const matches = [];
		for (const scene of state.scenes) {
			if (sceneId && scene.id !== sceneId) continue;
			for (const mark of scene.annotations || []) {
				const markKeyword = String(mark.keyword || "").toLowerCase();
				if (!needle || markKeyword.includes(needle) || needle.includes(markKeyword)) {
					matches.push({ scene, ...mark });
				}
			}
		}
		return matches;
	}

	function referenceText(scene, mark = null) {
		const name = String(scene?.name || scene?.id || "").trim();
		const keyword = String(mark?.keyword || "").trim();
		if (!name) return "";
		return keyword ? `🏕️${name}/${keyword}` : `🏕️${name}`;
	}

	function installPublicApi() {
		globalThis.GJJ_SceneLibrary = {
			open: togglePanel,
			close: closePanel,
			refresh: refreshScenes,
			resolve: resolveScene,
			resolvePosition,
			getPositions,
			referenceText,
			get scenes() {
				return (state.allScenes.length ? state.allScenes : state.scenes).slice();
			},
		};
	}

	api.addEventListener("gjj_node_progress", (event) => {
		if (!state.importing || !state.importNodeId) return;
		const detail = event?.detail || {};
		if (String(detail.node || "") !== state.importNodeId) return;
		let progress = clamp(Number(detail.progress || 0), 0, 1);
		if (detail.pipeline === "seedvr2") {
			progress = 0.58 + progress * 0.38;
		} else if (Number(detail.stage_total || 0) === 5) {
			progress = 0.03 + progress * 0.52;
		}
		const current = state.importActiveIndex + progress;
		const text = detail.text ? `场景 ${state.importActiveIndex + 1}/${Math.max(1, state.importTotal - 1)} · ${detail.text}` : state.importStatus;
		setImportProgress(current, state.importTotal, text);
	});

	api.addEventListener("gjj_scene_library_progress", (event) => {
		if (!state.annotating || !state.annotateNodeId) return;
		const detail = event?.detail || {};
		if (String(detail.node || "") !== state.annotateNodeId) return;
		const total = Math.max(1, Number(detail.total || state.importTotal || 1));
		const current = clamp(Number(detail.current || 0), 0, total);
		setImportProgress(current, total, detail.text || "正在自动打标...");
	});

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			installStyle();
			installPublicApi();
			installToolbarObserver();
			refreshScenes(true).catch(() => {});
			dirtyCanvas();
		},
	});
})();

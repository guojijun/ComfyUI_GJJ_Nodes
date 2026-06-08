import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.WorkflowScreenshotSave";
	const TOOLBAR_ID = "gjj-workflow-screenshot-toolbar";
	const SAVE_BUTTON_ID = "gjj-workflow-screenshot-save-button";
	const OPEN_BUTTON_ID = "gjj-workflow-screenshot-open-button";
	const PREVIEW_OVERLAY_ID = "gjj-workflow-screenshot-preview-overlay";
	const STYLE_ID = "gjj-workflow-screenshot-save-style";
	const CROP_MARGIN_PX = 52;
	const FIT_MARGIN_PX = 112;
	const MIN_FIT_SCALE = 0.08;
	const MAX_FIT_SCALE = 1.35;
	const MIN_READABLE_REAL_CAPTURE_SCALE = 0.18;
	const REAL_CAPTURE_TIMEOUT_MS = 2200;
	const USE_REAL_CANVAS_CAPTURE = false;
	const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
	const JPEG_METADATA_MARKER = 0xEF;
	const JPEG_METADATA_SIGNATURE = "GJJMETA\0";
	const JPEG_METADATA_CHUNK_SIZE = 60000;
	const SETTINGS_KEY = "gjj_workflow_screenshot_settings";
	const LEGACY_FILENAME_TEMPLATE = "GJJ_workflow_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png";
	const DEFAULT_FILENAME_TEMPLATE = "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.jpg";
	const DEFAULT_JPEG_QUALITY = 0.86;
	const MAX_SAVED_IMAGE_DIMENSION = 1080;
	const DEFAULT_SORT_MODE = "mtime_desc";
	const DEFAULT_FILTER_MODE = "openable";
	const DEFAULT_PAGE_SIZE = 12;
	const MIN_PAGE_SIZE = 1;
	const MAX_PAGE_SIZE = 100;
	const SORT_MODE_LABELS = {
		mtime_desc: "最新优先",
		mtime_asc: "最旧优先",
		size_desc: "文件大小 大-小",
		size_asc: "文件大小 小-大",
		name_asc: "文件名 A-Z",
		name_desc: "文件名 Z-A",
		title_asc: "标题 A-Z",
		openable_first: "可打开优先",
	};
	const SORT_MODE_BUTTONS = [
		{ mode: "mtime_desc", label: "🕒最新", title: "按修改时间从新到旧排序" },
		{ mode: "mtime_asc", label: "⏳最旧", title: "按修改时间从旧到新排序" },
		{ mode: "size_desc", label: "📦大文件", title: "按文件大小从大到小排序" },
		{ mode: "size_asc", label: "📦小文件", title: "按文件大小从小到大排序" },
		{ mode: "name_asc", label: "🔤A-Z", title: "按文件名 A-Z 排序" },
		{ mode: "name_desc", label: "🔡Z-A", title: "按文件名 Z-A 排序" },
		{ mode: "title_asc", label: "🏷️标题", title: "按工作流标题排序" },
		{ mode: "openable_first", label: "✅可打开", title: "可打开的截图优先显示" },
	];
	let crcTable = null;
	let busy = false;
	let previewItems = [];
	let backendDefaultDirectory = "";
	let backendLegacyDefaultDirectory = "";
	let packageDefaultDirectory = "";
	let backendSettingsPath = "";
	let backendSettingsSaveTimer = null;
	let backendInfoLoaded = false;
	let backendSettingsDirty = false;
	let settings = loadSettings();
	let lastWorkflowObject = null;
	let keyboardShortcutsInstalled = false;
	let previewPage = 1;

	function graphNodes() {
		return Array.isArray(app?.graph?._nodes) ? app.graph._nodes.filter(Boolean) : [];
	}

	function graphGroups() {
		return Array.isArray(app?.graph?._groups) ? app.graph._groups.filter(Boolean) : [];
	}

	function graphSerializeData() {
		try {
			return typeof app?.graph?.serialize === "function" ? app.graph.serialize() : null;
		} catch (_) {
			return null;
		}
	}

	function graphDataNodes(data) {
		return Array.isArray(data?.nodes) ? data.nodes.filter(Boolean) : [];
	}

	function graphDataGroups(data) {
		return Array.isArray(data?.groups) ? data.groups.filter(Boolean) : [];
	}

	function graphDataLinks(data) {
		if (!data?.links) return [];
		if (Array.isArray(data.links)) return data.links.filter(Boolean);
		if (data.links instanceof Map) return Array.from(data.links.values()).filter(Boolean);
		if (typeof data.links === "object") return Object.values(data.links).filter(Boolean);
		return [];
	}

	function graphNodeKey(node) {
		const id = node?.id ?? node?.[0];
		return id == null ? "" : String(id);
	}

	function mergeNodeRecord(existing, node, liveNode = null) {
		const merged = { ...(existing || {}), ...(node || {}) };
		if (liveNode) {
			merged.__liveNode = liveNode;
			merged.id = liveNode.id ?? merged.id;
			merged.type = liveNode.type || merged.type;
			merged.title = liveNode.title || merged.title;
			merged.pos = liveNode.pos || merged.pos;
			merged.size = liveNode.size || merged.size;
			if (Array.isArray(liveNode.boundingRect) && liveNode.boundingRect.length >= 4) {
				merged.boundingRect = liveNode.boundingRect;
			} else {
				delete merged.boundingRect;
			}
			merged.inputs = liveNode.inputs || merged.inputs;
			merged.outputs = liveNode.outputs || merged.outputs;
			merged.widgets = liveNode.widgets || merged.widgets;
			merged.flags = liveNode.flags || merged.flags;
		}
		return merged;
	}

	function normalizeLink(link) {
		if (!link) return null;
		if (Array.isArray(link)) {
			return {
				id: link[0],
				origin_id: link[1],
				origin_slot: link[2],
				target_id: link[3],
				target_slot: link[4],
				type: link[5],
			};
		}
		return {
			id: link.id,
			origin_id: link.origin_id ?? link.originId ?? link.from_node_id ?? link.from,
			origin_slot: link.origin_slot ?? link.originSlot ?? link.from_slot ?? 0,
			target_id: link.target_id ?? link.targetId ?? link.to_node_id ?? link.to,
			target_slot: link.target_slot ?? link.targetSlot ?? link.to_slot ?? 0,
			type: link.type,
		};
	}

	function uniqueGroups(groups) {
		const seen = new Set();
		const result = [];
		for (const group of groups.filter(Boolean)) {
			const rect = groupBounds(group);
			const key = [
				String(group?.title || ""),
				Math.round(rect.left),
				Math.round(rect.top),
				Math.round(rect.right),
				Math.round(rect.bottom),
			].join("|");
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(group);
		}
		return result;
	}

	function buildGraphSnapshot(workflow = null) {
		const byId = new Map();
		const addNode = (node, liveNode = null) => {
			const key = graphNodeKey(liveNode || node);
			if (!key) return;
			byId.set(key, mergeNodeRecord(byId.get(key), node, liveNode));
		};

		for (const node of graphDataNodes(workflow)) addNode(node);
		const serialized = graphSerializeData();
		for (const node of graphDataNodes(serialized)) addNode(node);
		for (const node of graphNodes()) addNode(node, node);

		const nodes = Array.from(byId.values());
		const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
		const groups = uniqueGroups([
			...graphDataGroups(workflow),
			...graphDataGroups(serialized),
			...graphGroups(),
		]);
		const links = [
			...graphDataLinks(workflow),
			...graphDataLinks(serialized),
			...(function () {
				const links = app?.graph?._links || app?.graph?.links || null;
				if (!links) return [];
				if (links instanceof Map) return Array.from(links.values()).filter(Boolean);
				if (Array.isArray(links)) return links.filter(Boolean);
				if (typeof links === "object") return Object.values(links).filter(Boolean);
				return [];
			})(),
		].map(normalizeLink).filter((link) => link?.origin_id != null && link?.target_id != null);

		const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
		for (const node of nodes) mergeBounds(bounds, nodeBounds(node));
		for (const group of groups) mergeBounds(bounds, groupBounds(group));
		if (Number.isFinite(bounds.left) && Number.isFinite(bounds.top)) {
			bounds.width = Math.max(1, bounds.right - bounds.left);
			bounds.height = Math.max(1, bounds.bottom - bounds.top);
		}
		return {
			nodes,
			nodeById,
			groups,
			links,
			bounds: Number.isFinite(bounds.left) && Number.isFinite(bounds.top) ? bounds : null,
		};
	}

	function choice(value, options, fallback) {
		const key = String(value || "").trim();
		return Object.prototype.hasOwnProperty.call(options, key) ? key : fallback;
	}

	function clampInteger(value, fallback, min, max) {
		const parsed = Number.parseInt(value, 10);
		if (!Number.isFinite(parsed)) return fallback;
		return Math.min(max, Math.max(min, parsed));
	}

	function pageSizeValue(value) {
		return clampInteger(value, DEFAULT_PAGE_SIZE, MIN_PAGE_SIZE, MAX_PAGE_SIZE);
	}

	function normalizeSettings(value = {}) {
		return {
			filenameTemplate: String(value?.filenameTemplate || value?.filename_template || DEFAULT_FILENAME_TEMPLATE),
			directoryPath: String(value?.directoryPath || value?.directory || ""),
			sortMode: choice(value?.sortMode || value?.sort_mode, SORT_MODE_LABELS, DEFAULT_SORT_MODE),
			filterMode: DEFAULT_FILTER_MODE,
			searchText: String(value?.searchText || value?.search_text || "").slice(0, 160),
			pageSize: pageSizeValue(value?.pageSize ?? value?.page_size),
		};
	}

	function loadSettings() {
		try {
			const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
			return normalizeSettings(parsed);
		} catch (_) {
			return normalizeSettings();
		}
	}

	function saveSettings() {
		try {
			settings.filterMode = DEFAULT_FILTER_MODE;
			settings.pageSize = pageSizeValue(settings.pageSize);
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		} catch (_) {}
	}

	function directoryPathForBackendSettings() {
		const directory = String(settings.directoryPath || "").trim();
		if (directory && packageDefaultDirectory && canonicalPathText(directory) === canonicalPathText(packageDefaultDirectory)) {
			return "workflows";
		}
		return directory;
	}

	function backendWorkflowSettingsPayload() {
		return {
			directory: directoryPathForBackendSettings(),
			filename_template: String(settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE),
			image_format: screenshotFormatFromFilename(settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE),
			jpeg_quality: DEFAULT_JPEG_QUALITY,
			sort_mode: choice(settings.sortMode, SORT_MODE_LABELS, DEFAULT_SORT_MODE),
			filter_mode: DEFAULT_FILTER_MODE,
			search_text: String(settings.searchText || "").slice(0, 160),
			page_size: pageSizeValue(settings.pageSize),
		};
	}

	async function saveBackendWorkflowSettings() {
		const data = await apiJson("/gjj/user_settings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				section: "workflow_screenshot",
				values: backendWorkflowSettingsPayload(),
			}),
		});
		backendSettingsPath = String(data.path || backendSettingsPath || "").trim();
		backendSettingsDirty = false;
		return data;
	}

	function scheduleBackendWorkflowSettingsSave() {
		backendSettingsDirty = true;
		clearTimeout(backendSettingsSaveTimer);
		backendSettingsSaveTimer = setTimeout(() => {
			saveBackendWorkflowSettings()
				.then(() => setPreviewStatus(`用户配置已保存：${backendSettingsPath || "presets/gjj_user_settings.json"}`, "ok"))
				.catch((error) => {
					console.warn("[GJJ] 保存用户参数失败：", error);
					setPreviewStatus(`用户配置保存失败：${error?.message || error}`, "warn");
				});
		}, 420);
	}

	async function flushBackendWorkflowSettingsSave() {
		clearTimeout(backendSettingsSaveTimer);
		try {
			if (!backendInfoLoaded) await loadBackendInfo();
			if (!backendSettingsDirty) return;
			await saveBackendWorkflowSettings();
		} catch (error) {
			console.warn("[GJJ] 保存用户参数失败，继续执行当前操作：", error);
		}
	}

	function effectiveDirectory() {
		return String(settings.directoryPath || backendDefaultDirectory || "").trim();
	}

	function canonicalPathText(value) {
		return String(value || "")
			.trim()
			.replace(/[\\/]+$/g, "")
			.replace(/\//g, "\\")
			.toLowerCase();
	}

	function looksLikeLegacyDefaultDirectory(value) {
		const text = canonicalPathText(value);
		return !!text && text.endsWith("\\output\\gjj\\workflow_screenshots");
	}

	async function apiJson(path, options = {}) {
		const response = typeof api?.fetchApi === "function"
			? await api.fetchApi(path, options)
			: await fetch(path, options);
		let data = null;
		try {
			data = await response.json();
		} catch (_) {
			data = null;
		}
		if (!response.ok || data?.ok === false) {
			throw new Error(data?.error || response.statusText || "请求失败");
		}
		return data || {};
	}

	async function loadBackendInfo() {
		const data = await apiJson("/gjj/workflow_screenshot/info");
		backendDefaultDirectory = String(data.default_directory || data.directory || "").trim();
		packageDefaultDirectory = String(data.package_default_directory || backendDefaultDirectory || "").trim();
		backendLegacyDefaultDirectory = String(data.legacy_default_directory || "").trim();
		backendSettingsPath = String(data.settings_path || backendSettingsPath || "").trim();
		const workflowSettings = data.workflow_screenshot || {};
		if (workflowSettings.filename_template) {
			settings.filenameTemplate = normalizeDefaultFilenameTemplate(workflowSettings.filename_template || DEFAULT_FILENAME_TEMPLATE);
		} else {
			settings.filenameTemplate = normalizeDefaultFilenameTemplate(settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE);
		}
		settings.sortMode = choice(workflowSettings.sort_mode || workflowSettings.sortMode || settings.sortMode, SORT_MODE_LABELS, DEFAULT_SORT_MODE);
		settings.filterMode = DEFAULT_FILTER_MODE;
		if (workflowSettings.search_text != null || workflowSettings.searchText != null) {
			settings.searchText = String(workflowSettings.search_text ?? workflowSettings.searchText ?? "").slice(0, 160);
		}
		settings.pageSize = pageSizeValue(workflowSettings.page_size ?? workflowSettings.pageSize ?? settings.pageSize);
		const current = canonicalPathText(settings.directoryPath);
		const legacy = canonicalPathText(backendLegacyDefaultDirectory);
		if (backendDefaultDirectory && (!current || (legacy && current === legacy) || looksLikeLegacyDefaultDirectory(settings.directoryPath) || workflowSettings.directory)) {
			settings.directoryPath = backendDefaultDirectory;
		}
		saveSettings();
		backendInfoLoaded = true;
		updateSaveSettingsUI();
		return data;
	}

	function bytesToBase64(bytes) {
		let binary = "";
		const chunkSize = 8192;
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
		}
		return btoa(binary);
	}

	function normalizeDefaultFilenameTemplate(value) {
		const text = String(value || "").trim();
		if (!text || text === LEGACY_FILENAME_TEMPLATE || text === "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png") {
			return DEFAULT_FILENAME_TEMPLATE;
		}
		return text;
	}

	function screenshotFormatFromFilename(value) {
		return /\.png$/i.test(String(value || "")) ? "png" : "jpg";
	}

	function mimeTypeForFilename(value) {
		return screenshotFormatFromFilename(value) === "png" ? "image/png" : "image/jpeg";
	}

	function sanitizeFilename(value, fallback = "GJJ_workflow.jpg") {
		let text = String(value || "").trim();
		if (!text) text = fallback;
		text = text.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\s+/g, " ").trim();
		text = text.replace(/[. ]+$/g, "");
		if (!text) text = fallback;
		if (!/\.(png|jpe?g)$/i.test(text)) text += ".jpg";
		return text.slice(0, 180);
	}

	function dateParts(now = new Date()) {
		const pad = (value) => String(value).padStart(2, "0");
		return {
			yyyy: String(now.getFullYear()),
			MM: pad(now.getMonth() + 1),
			dd: pad(now.getDate()),
			HH: pad(now.getHours()),
			mm: pad(now.getMinutes()),
			ss: pad(now.getSeconds()),
		};
	}

	function cleanWorkflowTitleText(value) {
		return String(value || "")
			.replace(/\r?\n+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function cleanSourceWorkflowName(value) {
		let text = String(value || "").trim();
		if (!text) return "";
		text = text.replace(/^ComfyUI\s*[-|–—]\s*/i, "");
		text = text.replace(/\s*[-|–—]\s*ComfyUI$/i, "");
		text = text.replace(/\\/g, "/").split("/").filter(Boolean).pop() || text;
		text = text.replace(/\.(json|workflow)$/i, "");
		text = text.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\s+/g, " ").trim();
		text = text.replace(/[. ]+$/g, "");
		return /^(comfyui|untitled|未命名)$/i.test(text) ? "" : text;
	}

	function workflowNameFromValue(value, depth = 0) {
		if (depth > 4 || value == null) return "";
		if (typeof value === "string") return cleanSourceWorkflowName(value);
		if (typeof value !== "object") return "";
		const nameKeys = ["workflow_name", "workflowName", "name", "title", "filename", "file", "path", "workflow_path", "workflowPath"];
		for (const key of nameKeys) {
			if (!(key in value)) continue;
			const name = workflowNameFromValue(value[key], depth + 1);
			if (name) return name;
		}
		const nestedKeys = ["workflow", "extra", "metadata", "config", "app", "info", "activeWorkflow"];
		for (const key of nestedKeys) {
			const nested = value[key];
			if (nested && typeof nested === "object") {
				const name = workflowNameFromValue(nested, depth + 1);
				if (name) return name;
			}
		}
		return "";
	}

	function currentSourceWorkflowName(workflow = null) {
		const graph = app?.graph;
		const candidates = [
			workflow,
			lastWorkflowObject,
			graph,
			graph?.extra,
			graph?._extra,
			graph?.config,
			graph?._config,
			app?.workflowManager?.activeWorkflow,
			app?.workflowManager?.activeWorkflowInfo,
			app?.workflowManager?.currentWorkflow,
			app?.workflowManager?.workflow,
			app?.workflowManager?.filename,
			app?.workflowManager?.path,
			app?.ui?.lastWorkflowName,
			app?.ui?.workflowName,
			app?.ui?.currentWorkflowName,
			document?.title,
		];
		for (const candidate of candidates) {
			const name = workflowNameFromValue(candidate);
			if (name) return name;
		}
		return "";
	}

	function workflowTitleFontFamily(name) {
		const text = String(name || "").replace(/["']/g, "").replace(/\\/g, "/").split("/").pop()?.replace(/\.(ttf|otf|ttc|otc)$/i, "") || "";
		return text || "Microsoft YaHei";
	}

	function workflowTitleFont(state, fontSize = null) {
		const size = Math.max(1, number(fontSize ?? state?.fontSize, 72));
		return `800 ${size}px "${workflowTitleFontFamily(state?.font)}", "Microsoft YaHei", "SimHei", sans-serif`;
	}

	function workflowTitleLineWidth(ctx, line, spacing) {
		const chars = Array.from(String(line || ""));
		if (!chars.length) return 0;
		return chars.reduce((total, char) => total + ctx.measureText(char).width, 0) + Math.max(0, chars.length - 1) * spacing;
	}

	function workflowTitleLayout(ctx, state) {
		const fontSize = Math.max(1, number(state?.fontSize, 72));
		const letterSpacing = clamp(number(state?.letterSpacing, 0), -50, 200);
		const lineSpacing = clamp(number(state?.lineSpacing, 12), -80, 300);
		ctx.save();
		ctx.font = workflowTitleFont(state, fontSize);
		const lines = String(state?.text || "工作流标题").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		if (!lines.some((line) => line.trim())) lines.splice(0, lines.length, "工作流标题");
		const widths = lines.map((line) => workflowTitleLineWidth(ctx, line, letterSpacing));
		ctx.restore();
		const lineHeight = Math.max(1, fontSize * 1.18);
		const textWidth = Math.max(1, ...widths);
		const textHeight = lines.length * lineHeight + Math.max(0, lines.length - 1) * lineSpacing;
		const shadowEnabled = state?.shadowEnabled !== false;
		const shadowBlur = shadowEnabled ? Math.max(0, number(state?.shadowBlur, 8)) : 0;
		const shadowOffset = shadowEnabled ? Math.max(Math.abs(number(state?.shadowX, 2)), Math.abs(number(state?.shadowY, 4))) : 0;
		const margin = Math.ceil(Math.max(0, number(state?.strokeWidth, 2)) * 2 + shadowBlur * 2 + shadowOffset + 4);
		const paddingX = Math.max(0, number(state?.paddingX, 0));
		const paddingY = Math.max(0, number(state?.paddingY, 0));
		const imageWidth = Math.max(1, Math.ceil(textWidth + paddingX * 2 + margin * 2));
		const imageHeight = Math.max(1, Math.ceil(textHeight + paddingY * 2 + margin * 2));
		return { lines, widths, fontSize, letterSpacing, lineSpacing, lineHeight, textWidth, textHeight, margin, paddingX, paddingY, imageWidth, imageHeight };
	}

	function workflowTitleGraphSize(node, state, fallbackWidth = 512) {
		const probe = document.createElement("canvas").getContext("2d");
		const layout = workflowTitleLayout(probe, state || {});
		const width = Math.max(120, fallbackWidth, number(state?.width, fallbackWidth));
		const displayScale = Math.max(0.001, width / Math.max(1, layout.imageWidth));
		return {
			width,
			height: Math.max(24, layout.imageHeight * displayScale),
			displayScale,
			layout,
		};
	}

	function workflowTitleTextFromSnapshot(snapshot = null) {
		const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : buildGraphSnapshot(lastWorkflowObject).nodes;
		const titles = nodes
			.filter(isWorkflowTitleNode)
			.map((node) => ({
				text: cleanWorkflowTitleText(workflowTitleState(node)?.text),
				area: Math.max(1, nodeBounds(node).right - nodeBounds(node).left) * Math.max(1, nodeBounds(node).bottom - nodeBounds(node).top),
			}))
			.filter((item) => item.text);
		titles.sort((a, b) => b.area - a.area);
		return titles[0]?.text || "";
	}

	function workflowTitleTextFromWorkflow(workflow = null) {
		const nodes = graphDataNodes(workflow);
		const titles = nodes
			.filter(isWorkflowTitleNode)
			.map((node) => ({
				text: cleanWorkflowTitleText(workflowTitleState(node)?.text),
				area: Math.max(1, nodeBounds(node).right - nodeBounds(node).left) * Math.max(1, nodeBounds(node).bottom - nodeBounds(node).top),
			}))
			.filter((item) => item.text);
		titles.sort((a, b) => b.area - a.area);
		return titles[0]?.text || "";
	}

	function buildFilename(snapshot = null) {
		const parts = dateParts();
		const date = `${parts.yyyy}${parts.MM}${parts.dd}`;
		const time = `${parts.HH}${parts.mm}${parts.ss}`;
		const workflowTitle = workflowTitleTextFromSnapshot(snapshot);
		const sourceWorkflowName = currentSourceWorkflowName(lastWorkflowObject);
		const filenameTitle = workflowTitle || sourceWorkflowName || "GJJ_workflow";
		const replacements = {
			...parts,
			date,
			time,
			datetime: `${date}_${time}`,
			timestamp: `${date}_${time}`,
			title: filenameTitle,
			workflow_title: filenameTitle,
			workflowTitle: filenameTitle,
			raw_title: workflowTitle,
			source_workflow: sourceWorkflowName,
			sourceWorkflow: sourceWorkflowName,
			workflow_name: sourceWorkflowName,
			workflowName: sourceWorkflowName,
		};
		const template = normalizeDefaultFilenameTemplate(settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE);
		const effectiveTemplate = template === LEGACY_FILENAME_TEMPLATE && (workflowTitle || sourceWorkflowName) ? DEFAULT_FILENAME_TEMPLATE : template;
		return sanitizeFilename(effectiveTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => replacements[key] ?? ""), "GJJ_workflow.jpg");
	}

	function number(value, fallback = 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	function pair(value, firstKeys = ["0", "x"], secondKeys = ["1", "y"], fallback = [0, 0]) {
		if (Array.isArray(value)) return [number(value[0], fallback[0]), number(value[1], fallback[1])];
		if (value && typeof value === "object") {
			const firstKey = firstKeys.find((key) => value[key] != null);
			const secondKey = secondKeys.find((key) => value[key] != null);
			return [
				number(firstKey ? value[firstKey] : undefined, fallback[0]),
				number(secondKey ? value[secondKey] : undefined, fallback[1]),
			];
		}
		return fallback;
	}

	function nodeBounds(node) {
		if (Array.isArray(node?.boundingRect) && node.boundingRect.length >= 4) {
			const rect = node.boundingRect;
			const left = number(rect[0], NaN);
			const top = number(rect[1], NaN);
			const width = Math.max(20, number(rect[2], 0));
			const height = Math.max(20, number(rect[3], 0));
			if (Number.isFinite(left) && Number.isFinite(top)) {
				return { left, top, right: left + width, bottom: top + height };
			}
		}
		const live = node?.__liveNode || null;
		const pos = pair(node?.pos || live?.pos, ["0", "x"], ["1", "y"], [0, 0]);
		const size = pair(node?.size || live?.size, ["0", "width", "w"], ["1", "height", "h"], [180, 90]);
		const x = number(pos[0]);
		const y = number(pos[1]);
		const width = Math.max(20, number(size[0], 180));
		let height = Math.max(20, number(size[1], 90));
		try {
			const computed = typeof live?.computeSize === "function" ? live.computeSize() : null;
			height = Math.max(height, number(computed?.[1], 0));
		} catch (_) {}
		if (isWorkflowTitleNode(node)) {
			const state = workflowTitleState(node);
			if (state) {
				const titleSize = workflowTitleGraphSize(node, state, width);
				return {
					left: x,
					top: y,
					right: x + Math.max(width, titleSize.width),
					bottom: y + Math.max(height, titleSize.height),
				};
			}
		}
		return { left: x, top: y, right: x + width, bottom: y + height };
	}

	function groupBounds(group) {
		const bounding = Array.isArray(group?.bounding) && group.bounding.length >= 4 ? group.bounding : null;
		if (bounding) {
			const x = number(bounding[0]);
			const y = number(bounding[1]);
			return {
				left: x,
				top: y,
				right: x + Math.max(0, number(bounding[2])),
				bottom: y + Math.max(0, number(bounding[3])),
			};
		}
		const pos = pair(group?.pos, ["0", "x"], ["1", "y"], [0, 0]);
		const size = pair(group?.size, ["0", "width", "w"], ["1", "height", "h"], [0, 0]);
		const x = number(pos[0]);
		const y = number(pos[1]);
		return {
			left: x,
			top: y,
			right: x + Math.max(0, number(size[0])),
			bottom: y + Math.max(0, number(size[1])),
		};
	}

	function mergeBounds(target, item) {
		if (!item) return target;
		target.left = Math.min(target.left, item.left);
		target.top = Math.min(target.top, item.top);
		target.right = Math.max(target.right, item.right);
		target.bottom = Math.max(target.bottom, item.bottom);
		return target;
	}

	function canvasElement() {
		return app?.canvas?.canvas || app?.canvas?.canvas_mouse || app?.canvas?.htmlCanvas || null;
	}

	function canvasMetrics() {
		const element = canvasElement();
		const rect = element?.getBoundingClientRect?.();
		const cssWidth = Math.max(1, number(rect?.width || element?.clientWidth || window.innerWidth, 1));
		const cssHeight = Math.max(1, number(rect?.height || element?.clientHeight || window.innerHeight, 1));
		const backingWidth = Math.max(1, number(element?.width || cssWidth, cssWidth));
		const backingHeight = Math.max(1, number(element?.height || cssHeight, cssHeight));
		return {
			element,
			rect,
			cssWidth,
			cssHeight,
			backingWidth,
			backingHeight,
			ratioX: backingWidth / cssWidth,
			ratioY: backingHeight / cssHeight,
		};
	}

	function graphPointToCanvasCss(x, y) {
		const canvas = app?.canvas;
		const metrics = canvasMetrics();
		if (typeof canvas?.convertOffsetToCanvas === "function") {
			const converted = canvas.convertOffsetToCanvas([x, y]);
			if (Array.isArray(converted) && converted.length >= 2) {
				return [
					number(converted[0]) / metrics.ratioX,
					number(converted[1]) / metrics.ratioY,
				];
			}
		}
		const ds = canvas?.ds || canvas?.viewport || null;
		const scale = Math.max(0.001, number(ds?.scale, 1));
		const offset = Array.isArray(ds?.offset) ? ds.offset : [0, 0];
		return [
			((x + number(offset[0])) * scale) / metrics.ratioX,
			((y + number(offset[1])) * scale) / metrics.ratioY,
		];
	}

	function drawGraphNow() {
		try {
			app?.canvas?.setDirty?.(true, true);
			app?.graph?.setDirtyCanvas?.(true, true);
			app?.canvas?.draw?.(true, true);
		} catch (_) {}
	}

	function nextFrame() {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}

	async function settleCanvas() {
		drawGraphNow();
		await nextFrame();
		drawGraphNow();
		await nextFrame();
	}

	function captureViewState() {
		const ds = app?.canvas?.ds || app?.canvas?.viewport || null;
		return {
			ds,
			scale: number(ds?.scale, 1),
			offset: Array.isArray(ds?.offset) ? [number(ds.offset[0]), number(ds.offset[1])] : [0, 0],
		};
	}

	function restoreViewState(state) {
		const ds = state?.ds;
		if (!ds) return;
		try {
			ds.scale = state.scale;
			if (Array.isArray(ds.offset)) {
				ds.offset[0] = state.offset[0];
				ds.offset[1] = state.offset[1];
			}
			drawGraphNow();
		} catch (error) {
			console.warn("[GJJ] 恢复截图前视图失败：", error);
		}
	}

	function fitBoundsToCanvas(bounds) {
		const canvas = app?.canvas;
		const ds = canvas?.ds || canvas?.viewport || null;
		const metrics = canvasMetrics();
		if (!canvas || !ds || !Array.isArray(ds.offset) || !metrics.element || !bounds) {
			canvas?.fitView?.();
			return { fitScale: 1, targetScale: number(ds?.scale, 1) };
		}
		const fitScale = Math.min(
			metrics.backingWidth / Math.max(bounds.width + FIT_MARGIN_PX * 2, 1),
			metrics.backingHeight / Math.max(bounds.height + FIT_MARGIN_PX * 2, 1)
		);
		if (fitScale < MIN_READABLE_REAL_CAPTURE_SCALE) {
			return { fitScale, targetScale: fitScale, skipped: true };
		}
		const targetScale = Math.max(MIN_FIT_SCALE, Math.min(MAX_FIT_SCALE, fitScale || 1));
		const centerX = (bounds.left + bounds.right) / 2;
		const centerY = (bounds.top + bounds.bottom) / 2;
		try {
			if (typeof ds.changeScale === "function") {
				ds.changeScale(targetScale, [metrics.backingWidth / 2, metrics.backingHeight / 2]);
			} else {
				ds.scale = targetScale;
			}
		} catch (_) {
			ds.scale = targetScale;
		}
		const scale = Math.max(0.001, number(ds.scale, targetScale));
		ds.offset[0] = metrics.backingWidth / (2 * scale) - centerX;
		ds.offset[1] = metrics.backingHeight / (2 * scale) - centerY;
		drawGraphNow();
		return { fitScale, targetScale: scale };
	}

	function cropRectForBounds(bounds) {
		const metrics = canvasMetrics();
		if (!metrics.element || !bounds) return null;
		const topLeft = graphPointToCanvasCss(bounds.left, bounds.top);
		const bottomRight = graphPointToCanvasCss(bounds.right, bounds.bottom);
		const leftCss = Math.min(topLeft[0], bottomRight[0]) - CROP_MARGIN_PX;
		const topCss = Math.min(topLeft[1], bottomRight[1]) - CROP_MARGIN_PX;
		const rightCss = Math.max(topLeft[0], bottomRight[0]) + CROP_MARGIN_PX;
		const bottomCss = Math.max(topLeft[1], bottomRight[1]) + CROP_MARGIN_PX;
		const sxCss = Math.max(0, Math.min(metrics.cssWidth - 1, leftCss));
		const syCss = Math.max(0, Math.min(metrics.cssHeight - 1, topCss));
		const exCss = Math.max(sxCss + 1, Math.min(metrics.cssWidth, rightCss));
		const eyCss = Math.max(syCss + 1, Math.min(metrics.cssHeight, bottomCss));
		const sx = Math.floor(sxCss * metrics.ratioX);
		const sy = Math.floor(syCss * metrics.ratioY);
		const ex = Math.max(sx + 1, Math.ceil(exCss * metrics.ratioX));
		const ey = Math.max(sy + 1, Math.ceil(eyCss * metrics.ratioY));
		return {
			sx,
			sy,
			width: Math.min(metrics.backingWidth - sx, ex - sx),
			height: Math.min(metrics.backingHeight - sy, ey - sy),
			cssWidth: Math.max(1, exCss - sxCss),
			cssHeight: Math.max(1, eyCss - syCss),
			viewportLeft: (metrics.rect?.left || 0) + sxCss,
			viewportTop: (metrics.rect?.top || 0) + syCss,
		};
	}

	function makeCroppedCanvas(rect) {
		const source = canvasElement();
		if (!source || !rect) return null;
		const output = document.createElement("canvas");
		output.width = Math.max(1, Math.round(rect.width));
		output.height = Math.max(1, Math.round(rect.height));
		const ctx = output.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(source, rect.sx, rect.sy, rect.width, rect.height, 0, 0, output.width, output.height);
		return output;
	}

	function cloneCanvas(source) {
		if (!source) return null;
		const output = document.createElement("canvas");
		output.width = source.width;
		output.height = source.height;
		const ctx = output.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(source, 0, 0);
		return output;
	}

	function timeoutPromise(ms, message) {
		return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
	}

	function blobToDataUrl(blob) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result || ""));
			reader.onerror = () => reject(reader.error || new Error("资源内联失败"));
			reader.readAsDataURL(blob);
		});
	}

	async function urlToDataUrl(url) {
		if (!url || String(url).startsWith("data:")) return String(url || "");
		const absolute = new URL(url, location.href);
		if (absolute.protocol !== "blob:" && absolute.origin !== location.origin) throw new Error("跳过跨域图片");
		const response = await fetch(absolute.href, { cache: "force-cache" });
		if (!response.ok) throw new Error(`图片读取失败：${response.status}`);
		return blobToDataUrl(await response.blob());
	}

	function domCaptureRoot() {
		const element = canvasElement();
		if (!element) return document.body;
		const canvasRect = element.getBoundingClientRect?.();
		let best = element.parentElement || document.body;
		let current = element.parentElement;
		while (current && current !== document.body) {
			const rect = current.getBoundingClientRect?.();
			const containsCanvas = rect && canvasRect
				&& rect.left <= canvasRect.left + 2
				&& rect.top <= canvasRect.top + 2
				&& rect.right >= canvasRect.right - 2
				&& rect.bottom >= canvasRect.bottom - 2;
			if (containsCanvas) best = current;
			current = current.parentElement;
		}
		return best || document.body;
	}

	function isMainGraphCanvas(element) {
		if (!(element instanceof HTMLCanvasElement)) return false;
		const main = canvasElement();
		if (element === main || element === app?.canvas?.canvas || element === app?.canvas?.canvas_mouse || element === app?.canvas?.bgcanvas) return true;
		const mainRect = main?.getBoundingClientRect?.();
		const rect = element.getBoundingClientRect?.();
		return !!mainRect && !!rect
			&& Math.abs(rect.left - mainRect.left) < 3
			&& Math.abs(rect.top - mainRect.top) < 3
			&& Math.abs(rect.width - mainRect.width) < 4
			&& Math.abs(rect.height - mainRect.height) < 4;
	}

	function styleSheetText() {
		const parts = [];
		for (const sheet of Array.from(document.styleSheets || [])) {
			try {
				for (const rule of Array.from(sheet.cssRules || [])) parts.push(rule.cssText);
			} catch (_) {}
		}
		return parts.join("\n");
	}

	async function sanitizeClonedMedia(sourceRoot, cloneRoot) {
		const sourceImages = Array.from(sourceRoot.querySelectorAll("img"));
		const cloneImages = Array.from(cloneRoot.querySelectorAll("img"));
		await Promise.all(cloneImages.map(async (clone, index) => {
			const source = sourceImages[index];
			const url = source?.currentSrc || source?.src || clone.getAttribute("src") || "";
			try {
				const dataUrl = await urlToDataUrl(url);
				if (dataUrl) clone.setAttribute("src", dataUrl);
				clone.removeAttribute("srcset");
				clone.setAttribute("crossorigin", "anonymous");
			} catch (_) {
				clone.style.visibility = "hidden";
				clone.removeAttribute("src");
				clone.removeAttribute("srcset");
			}
		}));

		const sourceCanvases = Array.from(sourceRoot.querySelectorAll("canvas"));
		const cloneCanvases = Array.from(cloneRoot.querySelectorAll("canvas"));
		for (let index = 0; index < cloneCanvases.length; index += 1) {
			const source = sourceCanvases[index];
			const clone = cloneCanvases[index];
			if (!source || !clone) continue;
			if (isMainGraphCanvas(source)) {
				clone.style.visibility = "hidden";
				continue;
			}
			try {
				const dataUrl = source.toDataURL("image/png");
				clone.style.backgroundImage = `url("${dataUrl}")`;
				clone.style.backgroundSize = "100% 100%";
				clone.style.backgroundRepeat = "no-repeat";
			} catch (_) {
				clone.style.visibility = "hidden";
			}
		}
	}

	function removeCloneNoise(cloneRoot) {
		const selectors = [
			`#${TOOLBAR_ID}`,
			`#${PREVIEW_OVERLAY_ID}`,
			"script",
			".litecontextmenu",
			".p-toast",
			"[role='tooltip']",
		];
		for (const element of cloneRoot.querySelectorAll(selectors.join(","))) element.remove();
	}

	function loadImage(url) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error("DOM 截图图层加载失败"));
			image.src = url;
		});
	}

	async function drawDomOverlay(output, rect) {
		if (!output || !rect?.cssWidth || !rect?.cssHeight) return;
		const root = domCaptureRoot();
		const rootRect = root?.getBoundingClientRect?.();
		if (!root || !rootRect || rootRect.width <= 0 || rootRect.height <= 0) return;
		const clone = root.cloneNode(true);
		await sanitizeClonedMedia(root, clone);
		removeCloneNoise(clone);

		const wrapper = document.createElement("div");
		wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
		wrapper.style.cssText = `position:relative;width:${rect.cssWidth}px;height:${rect.cssHeight}px;overflow:hidden;margin:0;padding:0;background:transparent;`;

		const style = document.createElement("style");
		style.textContent = styleSheetText();
		wrapper.appendChild(style);

		const placer = document.createElement("div");
		placer.style.cssText = [
			"position:absolute",
			`left:${rootRect.left - rect.viewportLeft}px`,
			`top:${rootRect.top - rect.viewportTop}px`,
			`width:${rootRect.width}px`,
			`height:${rootRect.height}px`,
			"margin:0",
			"padding:0",
			"pointer-events:none",
		].join(";");
		placer.appendChild(clone);
		wrapper.appendChild(placer);

		const serialized = new XMLSerializer().serializeToString(wrapper);
		const svg = [
			`<svg xmlns="http://www.w3.org/2000/svg" width="${output.width}" height="${output.height}" viewBox="0 0 ${rect.cssWidth} ${rect.cssHeight}">`,
			`<foreignObject x="0" y="0" width="${rect.cssWidth}" height="${rect.cssHeight}">`,
			serialized,
			"</foreignObject></svg>",
		].join("");
		const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		try {
			const image = await loadImage(url);
			const ctx = output.getContext("2d");
			ctx?.drawImage(image, 0, 0, output.width, output.height);
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	async function captureRealWorkflowCanvas(snapshot) {
		const viewState = captureViewState();
		try {
			const fitInfo = fitBoundsToCanvas(snapshot.bounds);
			if (fitInfo?.skipped) {
				throw new Error("真实画布需要缩得太小，已改用高分辨率结构图");
			}
			await settleCanvas();
			const rect = cropRectForBounds(snapshot.bounds);
			const baseCanvas = makeCroppedCanvas(rect);
			if (!baseCanvas) throw new Error("截图画布创建失败");
			await canvasToPngBytes(baseCanvas);

			const layeredCanvas = cloneCanvas(baseCanvas);
			if (!layeredCanvas) return baseCanvas;
			try {
				await drawDomOverlay(layeredCanvas, rect);
				await canvasToPngBytes(layeredCanvas);
				return layeredCanvas;
			} catch (error) {
				console.warn("[GJJ] 工作流 DOM 预览图层导出失败，保留画布截图：", error);
				return baseCanvas;
			}
		} finally {
			restoreViewState(viewState);
		}
	}

	async function captureWorkflowCanvas(snapshot) {
		if (!USE_REAL_CANVAS_CAPTURE) {
			return makeWorkflowScreenshotCanvas(snapshot);
		}
		try {
			return await Promise.race([
				captureRealWorkflowCanvas(snapshot),
				timeoutPromise(REAL_CAPTURE_TIMEOUT_MS, "真实截图超时，已改用结构图"),
			]);
		} catch (error) {
			console.warn("[GJJ] 真实工作流截图失败，改用结构图：", error);
			return makeWorkflowScreenshotCanvas(snapshot);
		}
	}

	function clamp(value, min, max) {
		return Math.max(min, Math.min(max, value));
	}

	function drawRoundedRect(ctx, x, y, width, height, radius = 8) {
		const r = Math.max(0, Math.min(radius, width / 2, height / 2));
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + width - r, y);
		ctx.quadraticCurveTo(x + width, y, x + width, y + r);
		ctx.lineTo(x + width, y + height - r);
		ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
		ctx.lineTo(x + r, y + height);
		ctx.quadraticCurveTo(x, y + height, x, y + height - r);
		ctx.lineTo(x, y + r);
		ctx.quadraticCurveTo(x, y, x + r, y);
		ctx.closePath();
	}

	function ellipsizeText(ctx, value, maxWidth) {
		const text = String(value || "");
		if (!text || ctx.measureText(text).width <= maxWidth) return text;
		let low = 0;
		let high = text.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (ctx.measureText(`${text.slice(0, mid)}...`).width <= maxWidth) low = mid;
			else high = mid - 1;
		}
		return `${text.slice(0, Math.max(1, low))}...`;
	}

	function slotPosition(node, slotIndex, isOutput) {
		const liveNode = node?.__liveNode || node;
		try {
			const value = isOutput && typeof liveNode?.getOutputPos === "function"
				? liveNode.getOutputPos(slotIndex)
				: !isOutput && typeof liveNode?.getInputPos === "function"
					? liveNode.getInputPos(slotIndex)
					: null;
			if (Array.isArray(value) && value.length >= 2) return [number(value[0]), number(value[1])];
		} catch (_) {}
		const bounds = nodeBounds(node);
		const slots = isOutput ? node?.outputs : node?.inputs;
		const count = Math.max(1, Array.isArray(slots) ? slots.length : 1);
		const top = bounds.top + 44;
		const step = Math.max(16, Math.min(24, (bounds.bottom - top - 14) / count));
		return [isOutput ? bounds.right : bounds.left, top + step * slotIndex + step / 2];
	}

	function drawGrid(ctx, width, height) {
		ctx.fillStyle = "#0f1214";
		ctx.fillRect(0, 0, width, height);
		ctx.strokeStyle = "rgba(255,255,255,.035)";
		ctx.lineWidth = 1;
		const minor = 24;
		for (let x = 0; x <= width; x += minor) {
			ctx.beginPath();
			ctx.moveTo(x + 0.5, 0);
			ctx.lineTo(x + 0.5, height);
			ctx.stroke();
		}
		for (let y = 0; y <= height; y += minor) {
			ctx.beginPath();
			ctx.moveTo(0, y + 0.5);
			ctx.lineTo(width, y + 0.5);
			ctx.stroke();
		}
		ctx.strokeStyle = "rgba(255,255,255,.055)";
		for (let x = 0; x <= width; x += minor * 4) {
			ctx.beginPath();
			ctx.moveTo(x + 0.5, 0);
			ctx.lineTo(x + 0.5, height);
			ctx.stroke();
		}
		for (let y = 0; y <= height; y += minor * 4) {
			ctx.beginPath();
			ctx.moveTo(0, y + 0.5);
			ctx.lineTo(width, y + 0.5);
			ctx.stroke();
		}
	}

	function nodeLabel(node) {
		const live = node?.__liveNode || null;
		return String(node?.title || live?.title || live?.constructor?.title || node?.type || live?.type || `节点 ${node?.id ?? ""}`).trim();
	}

	function slotLabel(slot, fallback) {
		return String(slot?.label || slot?.localized_name || slot?.name || fallback || "").trim();
	}

	function widgetSummary(node) {
		const live = node?.__liveNode || null;
		const widgets = Array.isArray(live?.widgets) ? live.widgets : (Array.isArray(node?.widgets) ? node.widgets : []);
		const lines = widgets
			.filter((widget) => widget && !widget.hidden && !String(widget.type || "").startsWith("converted-widget"))
			.slice(0, 3)
			.map((widget) => {
				const name = String(widget.label || widget.name || "").trim();
				const value = widget.value == null ? "" : String(widget.value).replace(/\s+/g, " ").slice(0, 120);
				return value ? `${name}: ${value}` : name;
			})
			.filter(Boolean);
		if (lines.length) return lines;
		const values = Array.isArray(node?.widgets_values) ? node.widgets_values : [];
		return values
			.slice(0, 4)
			.map((value, index) => {
				if (value == null || value === "") return "";
				const label = String(widgets[index]?.label || widgets[index]?.name || `参数 ${index + 1}`).trim();
				const text = typeof value === "object" ? JSON.stringify(value) : String(value);
				return `${label}: ${text.replace(/\s+/g, " ").slice(0, 120)}`;
			})
			.filter(Boolean);
	}

	function mediaSourceLooksSafe(element) {
		if (element instanceof HTMLCanvasElement) {
			try {
				element.toDataURL("image/png");
				return true;
			} catch (_) {
				return false;
			}
		}
		const src = String(element?.currentSrc || element?.src || "");
		if (!src) return false;
		if (src.startsWith("data:") || src.startsWith("blob:")) return true;
		try {
			return new URL(src, location.href).origin === location.origin;
		} catch (_) {
			return false;
		}
	}

	function mediaDimensions(element) {
		if (element instanceof HTMLCanvasElement) {
			return [number(element.width, 0), number(element.height, 0)];
		}
		if (element instanceof HTMLVideoElement) {
			return [number(element.videoWidth || element.clientWidth, 0), number(element.videoHeight || element.clientHeight, 0)];
		}
		return [number(element?.naturalWidth || element?.width || element?.clientWidth, 0), number(element?.naturalHeight || element?.height || element?.clientHeight, 0)];
	}

	function mediaArea(element) {
		const [width, height] = mediaDimensions(element);
		return width * height;
	}

	function mediaLooksDrawable(element) {
		if (!element || !(element instanceof HTMLImageElement || element instanceof HTMLCanvasElement || element instanceof HTMLVideoElement)) return false;
		if (element instanceof HTMLImageElement && element.complete === false) return false;
		const [width, height] = mediaDimensions(element);
		if (width < 36 || height < 36) return false;
		if (!mediaSourceLooksSafe(element)) return false;
		return true;
	}

	function widgetDomRoots(node) {
		const live = node?.__liveNode || node;
		const roots = [];
		const add = (value) => {
			if (value instanceof HTMLElement) roots.push(value);
		};
		for (const widget of Array.isArray(live?.widgets) ? live.widgets : []) {
			add(widget?.element);
			add(widget?.inputEl);
			add(widget?.root);
			add(widget?.div);
		}
		for (const key of Object.keys(live || {})) {
			if (!key.startsWith("__gjj")) continue;
			add(live[key]);
		}
		return roots;
	}

	function nodeDomMedia(node) {
		const result = [];
		for (const root of widgetDomRoots(node)) {
			for (const element of root.querySelectorAll("img,canvas,video")) {
				result.push(element);
			}
		}
		return result;
	}

	function nodePreviewImages(node) {
		const live = node?.__liveNode || node;
		const candidates = [
			...(Array.isArray(live?.imgs) ? live.imgs : []),
			...(Array.isArray(live?.images) ? live.images : []),
			live?.preview,
			...nodeDomMedia(node),
		];
		const seen = new Set();
		return candidates
			.filter(mediaLooksDrawable)
			.filter((element) => {
				const key = element.currentSrc || element.src || `${element.tagName}:${element.width}x${element.height}:${resultIndexHint(element)}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.sort((a, b) => mediaArea(b) - mediaArea(a))
			.slice(0, 4);
	}

	function resultIndexHint(element) {
		try {
			return Array.from(element?.parentElement?.children || []).indexOf(element);
		} catch (_) {
			return 0;
		}
	}

	function drawMediaContain(ctx, element, x, y, width, height) {
		const [sourceWidth, sourceHeight] = mediaDimensions(element);
		const imageWidth = Math.max(1, sourceWidth);
		const imageHeight = Math.max(1, sourceHeight);
		const scale = Math.min(width / imageWidth, height / imageHeight);
		const drawWidth = imageWidth * scale;
		const drawHeight = imageHeight * scale;
		const dx = x + (width - drawWidth) / 2;
		const dy = y + (height - drawHeight) / 2;
		ctx.drawImage(element, dx, dy, drawWidth, drawHeight);
	}

	function isVideoCombineNode(node) {
		const live = node?.__liveNode || node;
		return String(live?.comfyClass || live?.type || node?.type || node?.class_type || "").includes("GJJ_VideoCombine");
	}

	function visibleVideoCombineElement(node) {
		const live = node?.__liveNode || node;
		const state = live?.__gjjVideoCombineStatus || null;
		if (state?.wrap?.style?.display === "none" || state?.previewCard?.style?.display === "none") {
			return null;
		}
		const candidates = [state?.video, state?.image];
		for (const element of candidates) {
			if (!element || element.style?.display === "none") continue;
			if (mediaLooksDrawable(element)) return element;
		}
		return null;
	}

	function videoCombineAspect(node, element) {
		const live = node?.__liveNode || node;
		const propAspect = number(
			live?.__gjjVideoCombinePreviewAspect
				?? live?.properties?.gjj_video_combine_preview_aspect
				?? node?.properties?.gjj_video_combine_preview_aspect,
			0,
		);
		if (propAspect > 0) return clamp(propAspect, 0.05, 20);
		const [sourceWidth, sourceHeight] = mediaDimensions(element);
		return sourceWidth > 0 && sourceHeight > 0 ? clamp(sourceWidth / sourceHeight, 0.05, 20) : 16 / 9;
	}

	function drawVideoCombinePreview(ctx, node, x, y, width, height, layout = null) {
		if (!isVideoCombineNode(node) || width < 120 || height < 84) return false;
		const live = node?.__liveNode || node;
		const state = live?.__gjjVideoCombineStatus || null;
		if (state && (state.wrap?.style?.display === "none" || state.previewCard?.style?.display === "none")) {
			return false;
		}
		const element = visibleVideoCombineElement(node) || nodePreviewImages(node)[0];
		if (!element || !mediaLooksDrawable(element)) return false;
		const aspect = videoCombineAspect(node, element);
		const padding = Math.max(4, Math.min(10, width * 0.012));
		let cardX = x + padding;
		let cardY = y + padding;
		let cardW = Math.max(40, width - padding * 2);
		let cardMaxH = Math.max(48, height - padding * 2);
		const widgetY = number(state?.widget?.last_y ?? state?.widget?.y, NaN);
		const widgetHeight = number(
			typeof state?.widget?.getHeight === "function" ? state.widget.getHeight() : undefined,
			0,
		);
		const hasWidgetLayout = layout && Number.isFinite(widgetY) && widgetY > 0 && widgetHeight > 0;
		if (hasWidgetLayout) {
			const scale = Math.max(0.001, number(layout.scale, 1));
			const nodeX = number(layout.nodeX, x);
			const nodeY = number(layout.nodeY, y);
			const nodeW = number(layout.nodeW, width);
			cardX = nodeX + Math.max(8, 10 * scale);
			cardY = nodeY + widgetY * scale + Math.max(4, 6 * scale);
			cardW = Math.max(40, nodeW - Math.max(16, 20 * scale));
			cardMaxH = Math.max(48, widgetHeight * scale - Math.max(8, 12 * scale));
		}
		const desiredCardH = cardW / Math.max(0.05, aspect);
		const cardH = Math.max(48, Math.min(cardMaxH, desiredCardH));
		if (!hasWidgetLayout) {
			cardY = y + Math.max(padding, height - cardH - padding);
		}
		const finalCardH = Math.min(cardH, cardMaxH);
		ctx.save();
		drawRoundedRect(ctx, cardX, cardY, cardW, finalCardH, 6);
		ctx.clip();
		ctx.fillStyle = "#020506";
		ctx.fillRect(cardX, cardY, cardW, finalCardH);
		try {
			drawMediaContain(ctx, element, cardX, cardY, cardW, finalCardH);
		} catch (_) {}
		ctx.restore();
		ctx.strokeStyle = "rgba(255,255,255,.14)";
		drawRoundedRect(ctx, cardX, cardY, cardW, finalCardH, 6);
		ctx.stroke();
		return true;
	}

	function drawNodePreviewImages(ctx, node, x, y, width, height, layout = null) {
		if (drawVideoCombinePreview(ctx, node, x, y, width, height, layout)) return true;
		const images = nodePreviewImages(node);
		if (!images.length || width < 120 || height < 84) return false;
		const count = images.length;
		const columns = count > 1 ? 2 : 1;
		const rows = Math.ceil(count / columns);
		const gap = 6;
		const cellWidth = (width - gap * (columns - 1)) / columns;
		const cellHeight = (height - gap * (rows - 1)) / rows;
		ctx.save();
		drawRoundedRect(ctx, x, y, width, height, 6);
		ctx.clip();
		ctx.fillStyle = "#070b0e";
		ctx.fillRect(x, y, width, height);
		for (let index = 0; index < images.length; index += 1) {
			const column = index % columns;
			const row = Math.floor(index / columns);
			const cellX = x + column * (cellWidth + gap);
			const cellY = y + row * (cellHeight + gap);
			try {
				drawMediaContain(ctx, images[index], cellX, cellY, cellWidth, cellHeight);
			} catch (_) {}
		}
		ctx.restore();
		ctx.strokeStyle = "rgba(255,255,255,.12)";
		drawRoundedRect(ctx, x, y, width, height, 6);
		ctx.stroke();
		return true;
	}

	function drawNodeTextPanel(ctx, lines, x, y, width, height) {
		if (!Array.isArray(lines) || !lines.length || width < 120 || height < 38) return false;
		const visibleLines = Math.max(1, Math.min(lines.length, Math.floor((height - 18) / 18)));
		ctx.save();
		ctx.fillStyle = "rgba(255,255,255,.055)";
		drawRoundedRect(ctx, x, y, width, height, 6);
		ctx.fill();
		ctx.strokeStyle = "rgba(255,255,255,.08)";
		ctx.stroke();
		ctx.fillStyle = "#aebcc1";
		ctx.font = "11px sans-serif";
		for (let index = 0; index < visibleLines; index += 1) {
			ctx.fillText(ellipsizeText(ctx, lines[index], width - 18), x + 9, y + 18 + index * 18);
		}
		if (lines.length > visibleLines) {
			ctx.fillStyle = "rgba(174,188,193,.72)";
			ctx.fillText(`+${lines.length - visibleLines} 项`, x + 9, y + height - 7);
		}
		ctx.restore();
		return true;
	}

	function nodeDetailLines(node) {
		const lines = [];
		const widgets = widgetSummary(node);
		for (const line of widgets) lines.push(line);
		const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
		const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
		if (inputs.length) lines.push(`输入：${inputs.map((item, index) => slotLabel(item, `${index + 1}`)).filter(Boolean).slice(0, 5).join(" / ")}`);
		if (outputs.length) lines.push(`输出：${outputs.map((item, index) => slotLabel(item, `${index + 1}`)).filter(Boolean).slice(0, 5).join(" / ")}`);
		if (node?.type) lines.push(`类型：${node.type}`);
		return lines.filter(Boolean);
	}

	function parseJsonText(value) {
		if (value && typeof value === "object") return value;
		const text = String(value || "").trim();
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch (_) {
			return null;
		}
	}

	function workflowTitleState(node) {
		const props = node?.properties || {};
		const candidates = [
			props.gjj_workflow_title_config,
			props.config_json,
			props.gjj_workflow_title_panel,
			...(Array.isArray(node?.widgets_values) ? node.widgets_values : []),
		];
		for (const item of candidates) {
			const parsed = parseJsonText(item);
			if (parsed && typeof parsed === "object" && (parsed.text || parsed.fontSize)) return parsed;
		}
		return null;
	}

	function isWorkflowTitleNode(node) {
		return /GJJ_WorkflowTitle|工作流标题/i.test(`${node?.type || ""} ${nodeLabel(node)}`);
	}

	function drawWorkflowTitleText(ctx, state, x, y, width, height, scale) {
		const text = String(state?.text || "工作流标题").trim();
		if (!text) return false;
		const layout = workflowTitleLayout(ctx, state);
		if (!layout.lines.length) return false;
		const fallbackGraphWidth = Math.max(1, width / Math.max(0.001, scale));
		const titleGraphWidth = Math.max(120, fallbackGraphWidth, number(state?.width, fallbackGraphWidth));
		const titleScale = Math.max(0.001, titleGraphWidth / Math.max(1, layout.imageWidth));
		const renderScale = Math.max(0.001, titleScale * Math.max(0.001, scale));
		const drawWidth = layout.imageWidth * renderScale;
		const drawHeight = layout.imageHeight * renderScale;
		const drawX = x + (width - drawWidth) / 2;
		const drawY = y + (height - drawHeight) / 2;
		const align = String(state?.align || "居中");
		const opacity = clamp(number(state?.opacity, 1), 0.05, 1);
		const strokeMode = String(state?.strokeMode || "自定义");
		const strokeWidth = Math.max(0, number(state?.strokeWidth, 0));
		const strokeColor = strokeMode === "透明"
			? "rgba(0,0,0,0)"
			: strokeMode === "背景色"
				? String(state?.backgroundColor || "#1E5A48")
				: String(state?.strokeColor || "#2E7D62");
		const strokeOpacity = clamp(number(state?.strokeOpacity, 1), 0, 1);

		ctx.save();
		ctx.translate(drawX, drawY);
		ctx.scale(renderScale, renderScale);
		ctx.globalAlpha = opacity;
		ctx.font = workflowTitleFont(state, layout.fontSize);
		ctx.textBaseline = "top";
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		if (state?.shadowEnabled !== false) {
			ctx.shadowColor = String(state?.shadowColor || "#2B5568");
			ctx.shadowBlur = Math.max(0, number(state?.shadowBlur, 8));
			ctx.shadowOffsetX = number(state?.shadowX, 2);
			ctx.shadowOffsetY = number(state?.shadowY, 4);
		}

		const fill = (() => {
			if (state?.gradient === false) return String(state?.colorA || "#F8FFF7");
			const gradient = String(state?.gradientDirection || "水平") === "垂直"
				? ctx.createLinearGradient(0, 0, 0, layout.imageHeight)
				: String(state?.gradientDirection || "水平") === "对角"
					? ctx.createLinearGradient(0, 0, layout.imageWidth, layout.imageHeight)
					: ctx.createLinearGradient(0, 0, layout.imageWidth, 0);
			gradient.addColorStop(0, String(state?.colorA || "#F8FFF7"));
			gradient.addColorStop(1, String(state?.colorB || "#55C685"));
			return gradient;
		})();

		const baseX = layout.margin + layout.paddingX;
		let textY = layout.margin + layout.paddingY;
		layout.lines.forEach((line, index) => {
			const lineWidth = layout.widths[index] || workflowTitleLineWidth(ctx, line, layout.letterSpacing);
			const textX = align.includes("左") ? baseX : align.includes("右") ? baseX + layout.textWidth - lineWidth : baseX + (layout.textWidth - lineWidth) / 2;
			let cursor = textX;
			for (const char of Array.from(line)) {
				if (strokeWidth > 0) {
					ctx.lineWidth = strokeWidth * 2;
					ctx.strokeStyle = strokeColor;
					ctx.globalAlpha = opacity * strokeOpacity;
					ctx.strokeText(char, cursor, textY);
					ctx.globalAlpha = opacity;
				}
				ctx.fillStyle = fill;
				ctx.fillText(char, cursor, textY);
				cursor += ctx.measureText(char).width + layout.letterSpacing;
			}
			textY += layout.lineHeight + layout.lineSpacing;
		});
		ctx.restore();
		return true;
	}

	function drawWorkflowTitleNode(ctx, node, x, y, width, height, scale) {
		const state = workflowTitleState(node);
		if (!state) return false;
		ctx.save();
		ctx.globalAlpha = 0.22;
		ctx.strokeStyle = "rgba(117,137,148,.55)";
		drawRoundedRect(ctx, x, y, width, height, 8);
		ctx.stroke();
		ctx.restore();
		return drawWorkflowTitleText(ctx, state, x, y, width, height, scale);
	}

	function makeWorkflowScreenshotCanvas(snapshot) {
		const bounds = snapshot?.bounds || null;
		if (!bounds) return null;
		const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
		const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
		const links = Array.isArray(snapshot?.links) ? snapshot.links : [];
		const nodeById = snapshot?.nodeById instanceof Map ? snapshot.nodeById : new Map(nodes.map((node) => [String(node.id), node]));
		const contentMargin = 64;
		const maxWidth = 2400;
		const maxHeight = 1800;
		const minWidth = 720;
		const minHeight = 460;
		const contentWidth = bounds.width + contentMargin * 2;
		const contentHeight = bounds.height + contentMargin * 2;
		const scale = clamp(Math.min(maxWidth / contentWidth, maxHeight / contentHeight, 1.15), 0.12, 1.15);
		const width = Math.round(clamp(contentWidth * scale, minWidth, maxWidth));
		const height = Math.round(clamp(contentHeight * scale, minHeight, maxHeight));
		const offsetX = (width - bounds.width * scale) / 2 - bounds.left * scale;
		const offsetY = (height - bounds.height * scale) / 2 - bounds.top * scale;
		const sx = (value) => value * scale + offsetX;
		const sy = (value) => value * scale + offsetY;

		const output = document.createElement("canvas");
		output.width = width;
		output.height = height;
		const ctx = output.getContext("2d");
		if (!ctx) return null;

		drawGrid(ctx, width, height);

		ctx.save();
		for (const group of groups) {
			const rect = groupBounds(group);
			const x = sx(rect.left);
			const y = sy(rect.top);
			const w = Math.max(24, (rect.right - rect.left) * scale);
			const h = Math.max(24, (rect.bottom - rect.top) * scale);
			ctx.globalAlpha = 0.42;
			ctx.fillStyle = String(group?.color || "#21313a");
			drawRoundedRect(ctx, x, y, w, h, 10);
			ctx.fill();
			ctx.globalAlpha = 1;
			ctx.strokeStyle = "rgba(130,160,170,.45)";
			ctx.lineWidth = 1;
			ctx.stroke();
			ctx.fillStyle = "#b9c7cc";
			ctx.font = "700 12px sans-serif";
			ctx.fillText(ellipsizeText(ctx, group?.title || "Group", Math.max(20, w - 18)), x + 9, y + 18);
		}

		ctx.strokeStyle = "rgba(121,166,183,.74)";
		ctx.lineWidth = 2;
		for (const link of links) {
			const origin = nodeById.get(String(link?.origin_id));
			const target = nodeById.get(String(link?.target_id));
			if (!origin || !target) continue;
			const start = slotPosition(origin, number(link.origin_slot), true);
			const end = slotPosition(target, number(link.target_slot), false);
			const x1 = sx(start[0]);
			const y1 = sy(start[1]);
			const x2 = sx(end[0]);
			const y2 = sy(end[1]);
			const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
			ctx.stroke();
		}

		for (const node of nodes) {
			const rect = nodeBounds(node);
			const x = sx(rect.left);
			const y = sy(rect.top);
			const w = Math.max(96, (rect.right - rect.left) * scale);
			const h = Math.max(54, (rect.bottom - rect.top) * scale);
			if (isWorkflowTitleNode(node) && drawWorkflowTitleNode(ctx, node, x, y, w, h, scale)) {
				continue;
			}
			const header = Math.min(34, Math.max(26, h * 0.22));
			const isGjj = /GJJ|guojijun|国纪军/i.test(`${node?.type || ""} ${nodeLabel(node)}`);
			const fill = isGjj ? "#111c1f" : "#15191d";
			const headerFill = isGjj ? "#172b2b" : "#20262b";
			const stroke = isGjj ? "rgba(103,186,151,.72)" : "rgba(118,139,148,.62)";

			ctx.fillStyle = fill;
			drawRoundedRect(ctx, x, y, w, h, 8);
			ctx.fill();
			ctx.strokeStyle = stroke;
			ctx.lineWidth = 1.4;
			ctx.stroke();

			ctx.save();
			ctx.beginPath();
			drawRoundedRect(ctx, x, y, w, h, 8);
			ctx.clip();
			ctx.fillStyle = headerFill;
			ctx.fillRect(x, y, w, header);
			ctx.restore();

			ctx.fillStyle = "#edf3ef";
			ctx.font = "800 13px sans-serif";
			ctx.fillText(ellipsizeText(ctx, nodeLabel(node), Math.max(30, w - 22)), x + 11, y + header * 0.65);

			const bodyX = x + 12;
			const bodyY = y + header + 12;
			const bodyW = w - 24;
			const bodyH = h - header - 36;
			const previewDrawn = drawNodePreviewImages(ctx, node, bodyX, bodyY, bodyW, bodyH, {
				nodeX: x,
				nodeY: y,
				nodeW: w,
				nodeH: h,
				header,
				scale,
			});
			const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
			const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
			const maxRows = Math.max(0, Math.min(7, Math.floor((h - header - 18) / 17)));
			ctx.font = "11px sans-serif";
			for (let index = 0; index < Math.min(maxRows, inputs.length); index += 1) {
				const pos = slotPosition(node, index, false);
				const yy = clamp(sy(pos[1]), y + header + 10, y + h - 10);
				ctx.fillStyle = "#6fa0b3";
				ctx.beginPath();
				ctx.arc(x, yy, 4, 0, Math.PI * 2);
				ctx.fill();
				if (w > 150) {
					ctx.fillStyle = "#aebcc1";
					ctx.fillText(ellipsizeText(ctx, slotLabel(inputs[index], `输入 ${index + 1}`), w * 0.38), x + 10, yy + 4);
				}
			}
			for (let index = 0; index < Math.min(maxRows, outputs.length); index += 1) {
				const pos = slotPosition(node, index, true);
				const yy = clamp(sy(pos[1]), y + header + 10, y + h - 10);
				ctx.fillStyle = "#93b98e";
				ctx.beginPath();
				ctx.arc(x + w, yy, 4, 0, Math.PI * 2);
				ctx.fill();
				if (w > 170) {
					const label = ellipsizeText(ctx, slotLabel(outputs[index], `输出 ${index + 1}`), w * 0.36);
					ctx.fillStyle = "#aebcc1";
					ctx.fillText(label, x + w - 10 - ctx.measureText(label).width, yy + 4);
				}
			}

			if (!previewDrawn) {
				drawNodeTextPanel(ctx, nodeDetailLines(node), bodyX, bodyY, bodyW, bodyH);
			}

			ctx.fillStyle = "rgba(255,255,255,.36)";
			ctx.font = "10px sans-serif";
			ctx.fillText(`#${node?.id ?? ""}`, x + 10, y + h - 9);
		}
		ctx.restore();

		ctx.fillStyle = "rgba(10,14,16,.78)";
		drawRoundedRect(ctx, 12, 12, 186, 34, 8);
		ctx.fill();
		ctx.fillStyle = "#dfe9e3";
		ctx.font = "800 15px sans-serif";
		ctx.fillText("GJJ Workflow", 26, 34);
		ctx.fillStyle = "rgba(223,233,227,.62)";
		ctx.font = "11px sans-serif";
		ctx.fillText(`${nodes.length} 节点 / ${groups.length} 组`, 128, 34);
		return output;
	}

	function canvasToPngBytes(canvas) {
		return new Promise((resolve, reject) => {
			canvas.toBlob(async (blob) => {
				try {
					if (!blob) throw new Error("PNG blob 为空");
					resolve(new Uint8Array(await blob.arrayBuffer()));
				} catch (error) {
					reject(error);
				}
			}, "image/png");
		});
	}

	function canvasToImageBytes(canvas, filename) {
		const mimeType = mimeTypeForFilename(filename);
		if (mimeType === "image/png") return canvasToPngBytes(canvas);
		return new Promise((resolve, reject) => {
			canvas.toBlob(async (blob) => {
				try {
					if (!blob) throw new Error("JPG blob 为空");
					resolve(new Uint8Array(await blob.arrayBuffer()));
				} catch (error) {
					reject(error);
				}
			}, "image/jpeg", DEFAULT_JPEG_QUALITY);
		});
	}

	function constrainCanvasDimensions(canvas, maxDimension = MAX_SAVED_IMAGE_DIMENSION) {
		const width = Number(canvas?.width || 0);
		const height = Number(canvas?.height || 0);
		const limit = Math.max(1, Number(maxDimension) || MAX_SAVED_IMAGE_DIMENSION);
		if (!canvas || width <= 0 || height <= 0 || (width <= limit && height <= limit)) return canvas;

		const scale = Math.min(limit / width, limit / height);
		const output = document.createElement("canvas");
		output.width = Math.max(1, Math.round(width * scale));
		output.height = Math.max(1, Math.round(height * scale));
		const ctx = output.getContext("2d");
		if (!ctx) return canvas;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(canvas, 0, 0, output.width, output.height);
		return output;
	}

	function jsonReplacer(_key, value) {
		if (typeof value === "bigint") return value.toString();
		if (value instanceof Map) return Object.fromEntries(value.entries());
		if (value instanceof Set) return Array.from(value.values());
		return value;
	}

	function asciiJson(value) {
		const json = JSON.stringify(value ?? {}, jsonReplacer);
		return String(json || "{}").replace(/[^\x00-\x7F]/g, (char) => {
			return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
		});
	}

	async function buildMetadata() {
		let graphPrompt = null;
		let graphPromptError = "";
		try {
			graphPrompt = typeof app?.graphToPrompt === "function" ? await app.graphToPrompt() : null;
		} catch (error) {
			graphPromptError = String(error?.message || error || "");
			console.warn("[GJJ] 生成 prompt 元数据失败，仍会保存 workflow：", error);
		}

		let workflow = graphPrompt?.workflow || null;
		if (!workflow) {
			try {
				workflow = app?.graph?.serialize?.() || {};
			} catch (_) {
				workflow = {};
			}
		}
		lastWorkflowObject = workflow;

		const prompt = graphPrompt?.output || graphPrompt?.prompt || {};
		const snapshot = buildGraphSnapshot(workflow);
		const workflowTitle = workflowTitleTextFromSnapshot(snapshot);
		const sourceWorkflowName = currentSourceWorkflowName(workflow);
		const info = {
			source: "GJJ workflow screenshot",
			render_mode: USE_REAL_CANVAS_CAPTURE ? "real_canvas_dom_capture_with_schematic_fallback" : "stable_graph_renderer",
			created_at: new Date().toISOString(),
			workflow_title: workflowTitle || undefined,
			source_workflow: sourceWorkflowName || undefined,
			workflow_name: sourceWorkflowName || undefined,
			node_count: snapshot.nodes.length,
			group_count: snapshot.groups.length,
			graph_to_prompt_error: graphPromptError || undefined,
		};

		return {
			prompt: asciiJson(prompt),
			workflow: asciiJson(workflow),
			gjj_workflow_screenshot: asciiJson(info),
		};
	}

	function ensureCrcTable() {
		if (crcTable) return crcTable;
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n += 1) {
			let c = n;
			for (let k = 0; k < 8; k += 1) {
				c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
			}
			crcTable[n] = c >>> 0;
		}
		return crcTable;
	}

	function crc32(typeBytes, dataBytes) {
		const table = ensureCrcTable();
		let c = 0xFFFFFFFF;
		for (const byte of typeBytes) c = table[(c ^ byte) & 0xFF] ^ (c >>> 8);
		for (const byte of dataBytes) c = table[(c ^ byte) & 0xFF] ^ (c >>> 8);
		return (c ^ 0xFFFFFFFF) >>> 0;
	}

	function uint32Bytes(value) {
		return new Uint8Array([
			(value >>> 24) & 0xFF,
			(value >>> 16) & 0xFF,
			(value >>> 8) & 0xFF,
			value & 0xFF,
		]);
	}

	function asciiBytes(text) {
		const clean = String(text || "").replace(/[^\x00-\x7F]/g, "?");
		const bytes = new Uint8Array(clean.length);
		for (let i = 0; i < clean.length; i += 1) bytes[i] = clean.charCodeAt(i) & 0x7F;
		return bytes;
	}

	function utf8Bytes(text) {
		return new TextEncoder().encode(String(text || ""));
	}

	function chunkBytes(type, data) {
		const typeBytes = asciiBytes(type).slice(0, 4);
		const lengthBytes = uint32Bytes(data.length);
		const crcBytes = uint32Bytes(crc32(typeBytes, data));
		const result = new Uint8Array(lengthBytes.length + typeBytes.length + data.length + crcBytes.length);
		let offset = 0;
		result.set(lengthBytes, offset); offset += lengthBytes.length;
		result.set(typeBytes, offset); offset += typeBytes.length;
		result.set(data, offset); offset += data.length;
		result.set(crcBytes, offset);
		return result;
	}

	function textChunk(keyword, value) {
		const key = asciiBytes(String(keyword || "Comment").replace(/[^\x20-\x7E]/g, "").slice(0, 79) || "Comment");
		const text = asciiBytes(value);
		const data = new Uint8Array(key.length + 1 + text.length);
		data.set(key, 0);
		data[key.length] = 0;
		data.set(text, key.length + 1);
		return chunkBytes("tEXt", data);
	}

	function concatBytes(parts) {
		const size = parts.reduce((total, part) => total + part.length, 0);
		const result = new Uint8Array(size);
		let offset = 0;
		for (const part of parts) {
			result.set(part, offset);
			offset += part.length;
		}
		return result;
	}

	function hasPngSignature(bytes) {
		return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
	}

	function injectPngText(bytes, metadata) {
		if (!bytes?.length || !hasPngSignature(bytes)) return bytes;

		const chunks = Object.entries(metadata || {}).map(([key, value]) => textChunk(key, value));
		if (!chunks.length) return bytes;

		const parts = [bytes.slice(0, 8)];
		let offset = 8;
		while (offset + 12 <= bytes.length) {
			const length = (
				(bytes[offset] << 24) |
				(bytes[offset + 1] << 16) |
				(bytes[offset + 2] << 8) |
				bytes[offset + 3]
			) >>> 0;
			const typeStart = offset + 4;
			const type = String.fromCharCode(bytes[typeStart], bytes[typeStart + 1], bytes[typeStart + 2], bytes[typeStart + 3]);
			const next = offset + 12 + length;
			if (next > bytes.length) break;
			if (type === "IEND") {
				parts.push(...chunks);
				parts.push(bytes.slice(offset, next));
				return concatBytes(parts);
			}
			parts.push(bytes.slice(offset, next));
			offset = next;
		}
		return bytes;
	}

	function jpegMetadataSegment(payload, index, total) {
		const signature = asciiBytes(JPEG_METADATA_SIGNATURE);
		const header = new Uint8Array(signature.length + 4);
		header.set(signature, 0);
		header[signature.length] = (index >>> 8) & 0xFF;
		header[signature.length + 1] = index & 0xFF;
		header[signature.length + 2] = (total >>> 8) & 0xFF;
		header[signature.length + 3] = total & 0xFF;
		const data = new Uint8Array(header.length + payload.length);
		data.set(header, 0);
		data.set(payload, header.length);
		const length = data.length + 2;
		const segment = new Uint8Array(data.length + 4);
		segment[0] = 0xFF;
		segment[1] = JPEG_METADATA_MARKER;
		segment[2] = (length >>> 8) & 0xFF;
		segment[3] = length & 0xFF;
		segment.set(data, 4);
		return segment;
	}

	function injectJpegMetadata(bytes, metadata) {
		if (!bytes?.length || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
		const payload = utf8Bytes(JSON.stringify(metadata || {}, jsonReplacer));
		const total = Math.max(1, Math.ceil(payload.length / JPEG_METADATA_CHUNK_SIZE));
		const segments = [];
		for (let index = 0; index < total; index += 1) {
			segments.push(jpegMetadataSegment(payload.slice(index * JPEG_METADATA_CHUNK_SIZE, (index + 1) * JPEG_METADATA_CHUNK_SIZE), index, total));
		}
		return concatBytes([bytes.slice(0, 2), ...segments, bytes.slice(2)]);
	}

	function injectImageMetadata(bytes, metadata, filename) {
		return mimeTypeForFilename(filename) === "image/png"
			? injectPngText(bytes, metadata)
			: injectJpegMetadata(bytes, metadata);
	}

	function downloadImage(bytes, filename = buildFilename()) {
		const blob = new Blob([bytes], { type: mimeTypeForFilename(filename) });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), 2000);
		return filename;
	}

	async function openBackendDirectory() {
		await flushBackendWorkflowSettingsSave();
		try {
			await loadBackendInfo();
		} catch (_) {}
		try {
			const data = await apiJson("/gjj/workflow_screenshot/open_dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					directory: effectiveDirectory(),
					select_file: false,
				}),
			});
			settings.directoryPath = String(data.directory || effectiveDirectory());
			saveSettings();
			updateSaveSettingsUI();
		} catch (error) {
			console.warn("[GJJ] 打开截图保存目录失败：", error);
			alert(`打开保存目录失败：\n${error?.message || error}`);
		}
	}

	async function resetBackendDirectory() {
		try {
			await loadBackendInfo();
		} catch (_) {}
		settings.directoryPath = packageDefaultDirectory || backendDefaultDirectory;
		saveSettings();
		try {
			await saveBackendWorkflowSettings();
			await loadBackendInfo();
		} catch (error) {
			console.warn("[GJJ] 恢复默认保存目录失败：", error);
		}
		updateSaveSettingsUI();
		refreshBackendScreenshotList().catch(() => {});
	}

	async function saveImageBytes(bytes, filename) {
		const directory = effectiveDirectory();
		try {
			return await apiJson("/gjj/workflow_screenshot/save", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					filename,
					directory,
					image: bytesToBase64(bytes),
				}),
			});
		} catch (error) {
			console.warn("[GJJ] 后端保存失败，退回浏览器下载：", error);
		}
		return { filename: downloadImage(bytes, filename), directory: "", url: "" };
	}

	function decodeLatin1(bytes) {
		let text = "";
		const chunkSize = 8192;
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			text += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
		}
		return text;
	}

	function decodeUtf8(bytes) {
		try {
			return new TextDecoder("utf-8").decode(bytes);
		} catch (_) {
			return decodeLatin1(bytes);
		}
	}

	function findNullByte(bytes, start = 0) {
		for (let index = start; index < bytes.length; index += 1) {
			if (bytes[index] === 0) return index;
		}
		return -1;
	}

	function parsePngTextMetadata(bytes) {
		const metadata = {};
		if (!bytes?.length || !hasPngSignature(bytes)) return metadata;

		let offset = 8;
		while (offset + 12 <= bytes.length) {
			const length = (
				(bytes[offset] << 24) |
				(bytes[offset + 1] << 16) |
				(bytes[offset + 2] << 8) |
				bytes[offset + 3]
			) >>> 0;
			const typeStart = offset + 4;
			const type = String.fromCharCode(bytes[typeStart], bytes[typeStart + 1], bytes[typeStart + 2], bytes[typeStart + 3]);
			const dataStart = offset + 8;
			const dataEnd = dataStart + length;
			const next = offset + 12 + length;
			if (dataEnd > bytes.length || next > bytes.length) break;

			const data = bytes.slice(dataStart, dataEnd);
			if (type === "tEXt") {
				const separator = findNullByte(data);
				if (separator > 0) {
					const key = decodeLatin1(data.slice(0, separator));
					metadata[key] = decodeLatin1(data.slice(separator + 1));
				}
			} else if (type === "iTXt") {
				const keyEnd = findNullByte(data);
				if (keyEnd > 0 && data[keyEnd + 1] === 0) {
					let cursor = keyEnd + 3;
					const languageEnd = findNullByte(data, cursor);
					if (languageEnd >= 0) {
						cursor = languageEnd + 1;
						const translatedEnd = findNullByte(data, cursor);
						if (translatedEnd >= 0) {
							const key = decodeLatin1(data.slice(0, keyEnd));
							metadata[key] = decodeUtf8(data.slice(translatedEnd + 1));
						}
					}
				}
			} else if (type === "IEND") {
				break;
			}
			offset = next;
		}
		return metadata;
	}

	function parseJpegMetadata(bytes) {
		const metadata = {};
		if (!bytes?.length || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return metadata;
		const signature = asciiBytes(JPEG_METADATA_SIGNATURE);
		const chunks = [];
		let expectedTotal = 0;
		let offset = 2;
		while (offset + 4 <= bytes.length) {
			if (bytes[offset] !== 0xFF) break;
			const marker = bytes[offset + 1];
			if (marker === 0xDA || marker === 0xD9) break;
			const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
			if (length < 2 || offset + 2 + length > bytes.length) break;
			const dataStart = offset + 4;
			const dataEnd = offset + 2 + length;
			if (marker === JPEG_METADATA_MARKER) {
				const data = bytes.slice(dataStart, dataEnd);
				let matches = data.length >= signature.length + 4;
				for (let i = 0; matches && i < signature.length; i += 1) matches = data[i] === signature[i];
				if (matches) {
					const index = (data[signature.length] << 8) | data[signature.length + 1];
					const total = (data[signature.length + 2] << 8) | data[signature.length + 3];
					expectedTotal = Math.max(expectedTotal, total);
					chunks[index] = data.slice(signature.length + 4);
				}
			}
			offset = dataEnd;
		}
		if (!expectedTotal || chunks.filter(Boolean).length < expectedTotal) return metadata;
		try {
			return JSON.parse(decodeUtf8(concatBytes(Array.from({ length: expectedTotal }, (_value, index) => chunks[index])))) || {};
		} catch (_) {
			return metadata;
		}
	}

	function parseImageMetadata(bytes) {
		if (hasPngSignature(bytes)) return parsePngTextMetadata(bytes);
		return parseJpegMetadata(bytes);
	}

	function parseJsonMaybe(value) {
		if (value == null) return null;
		if (typeof value === "object") return value;
		const text = String(value || "").trim();
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch (_) {
			return null;
		}
	}

	function workflowFromMetadata(metadata) {
		const direct = parseJsonMaybe(metadata?.workflow || metadata?.Workflow);
		if (direct && typeof direct === "object") return direct;

		const prompt = parseJsonMaybe(metadata?.prompt);
		const nested = prompt?.workflow || prompt?.extra_pnginfo?.workflow || prompt?.extra?.workflow;
		const parsedNested = parseJsonMaybe(nested);
		if (parsedNested && typeof parsedNested === "object") return parsedNested;
		return null;
	}

	function workflowTitleFromMetadata(metadata, workflow = null) {
		const info = parseJsonMaybe(metadata?.gjj_workflow_screenshot || metadata?.GJJ_Workflow_Screenshot);
		const title = cleanWorkflowTitleText(info?.workflow_title || metadata?.workflow_title || metadata?.title || "");
		const sourceWorkflowName = cleanSourceWorkflowName(
			info?.source_workflow ||
			info?.workflow_name ||
			metadata?.source_workflow ||
			metadata?.workflow_name ||
			metadata?.workflowName ||
			""
		);
		return title || sourceWorkflowName || workflowTitleTextFromWorkflow(workflow) || workflowNameFromValue(workflow);
	}

	function clearPreviewItems() {
		for (const item of previewItems) {
			if (item?.url && String(item.url).startsWith("blob:")) {
				try { URL.revokeObjectURL(item.url); } catch (_) {}
			}
		}
		previewItems = [];
	}

	function previewOverlay() {
		let overlay = document.getElementById(PREVIEW_OVERLAY_ID);
		if (overlay) return overlay;

		overlay = document.createElement("div");
		overlay.id = PREVIEW_OVERLAY_ID;
		overlay.innerHTML = `
			<div class="gjj-workflow-preview-panel">
				<div class="gjj-workflow-preview-head">
					<div class="gjj-workflow-preview-title">🖼️ 工作流截图</div>
					<div class="gjj-workflow-preview-actions">
						<button type="button" data-gjj-action="save-current">💾保存</button>
						<button type="button" data-gjj-action="refresh-list">🔄刷新</button>
						<button type="button" data-gjj-action="open-dir">📂目录</button>
						<button type="button" data-gjj-action="settings-toggle" aria-expanded="false">⚙️设置</button>
						<button type="button" data-gjj-action="shortcut-help">⌨️快捷键</button>
						<button type="button" data-gjj-action="close">❌关闭</button>
					</div>
				</div>
				<div class="gjj-workflow-save-options" hidden>
					<div class="gjj-workflow-save-row">
						<label>文件名</label>
						<input type="text" data-gjj-setting="filename-template" spellcheck="false">
						<button type="button" data-gjj-action="reset-name">🔁</button>
					</div>
					<div class="gjj-workflow-save-row">
						<label>默认目录</label>
						<input type="text" data-gjj-setting="directory-path" spellcheck="false">
						<button type="button" data-gjj-action="open-dir">📂</button>
						<button type="button" data-gjj-action="clear-dir">♻️</button>
					</div>
					<div class="gjj-workflow-save-row">
						<label>每页数量</label>
						<input type="number" data-gjj-setting="page-size" min="${MIN_PAGE_SIZE}" max="${MAX_PAGE_SIZE}" step="1">
					</div>
				</div>
				<div class="gjj-workflow-filter-options">
					<div class="gjj-workflow-save-row gjj-workflow-search-row">
						<label>筛选</label>
						<input type="text" data-gjj-setting="search-text" spellcheck="false" placeholder="文件名 / 标题">
					</div>
					<div class="gjj-workflow-save-row gjj-workflow-sort-row">
						<label>排序</label>
						<div class="gjj-workflow-sort-buttons">
							${SORT_MODE_BUTTONS.map((item) => `<button type="button" data-gjj-sort="${item.mode}" title="${item.title}">${item.label}</button>`).join("")}
						</div>
					</div>
				</div>
				<div class="gjj-workflow-shortcut-help" hidden>Alt+Shift+S 保存截图 · Alt+Shift+O 打开截图库 · Ctrl+F 聚焦筛选 · Alt+R 刷新 · Esc 关闭</div>
				<div class="gjj-workflow-preview-status"></div>
				<div class="gjj-workflow-preview-grid"></div>
				<div class="gjj-workflow-pagination"></div>
			</div>
		`;
		const stop = (event) => event.stopPropagation();
		for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
			overlay.addEventListener(eventName, stop);
		}
		const onAction = (action, handler) => {
			for (const button of overlay.querySelectorAll(`[data-gjj-action='${action}']`)) {
				button.addEventListener("click", handler);
			}
		};
		const setSettingsPanelOpen = (open) => {
			const panel = overlay.querySelector(".gjj-workflow-save-options");
			if (panel) panel.hidden = !open;
			updateSaveSettingsUI(false);
		};
		onAction("close", () => {
			closePreviewOverlay();
		});
		onAction("save-current", (event) => saveWorkflowScreenshot(event.currentTarget));
		onAction("open-dir", () => openBackendDirectory());
		onAction("clear-dir", () => resetBackendDirectory());
		onAction("refresh-list", () => refreshBackendScreenshotList());
		onAction("settings-toggle", () => {
			const panel = overlay.querySelector(".gjj-workflow-save-options");
			setSettingsPanelOpen(!!panel?.hidden);
		});
		onAction("shortcut-help", () => {
			const help = overlay.querySelector(".gjj-workflow-shortcut-help");
			if (help) help.hidden = !help.hidden;
		});
		onAction("reset-name", () => {
			settings.filenameTemplate = DEFAULT_FILENAME_TEMPLATE;
			saveSettings();
			scheduleBackendWorkflowSettingsSave();
			updateSaveSettingsUI();
		});
		const filenameInput = overlay.querySelector("[data-gjj-setting='filename-template']");
		filenameInput?.addEventListener("input", () => {
			settings.filenameTemplate = String(filenameInput.value || DEFAULT_FILENAME_TEMPLATE);
			saveSettings();
			scheduleBackendWorkflowSettingsSave();
			updateSaveSettingsUI(false);
		});
		const searchInput = overlay.querySelector("[data-gjj-setting='search-text']");
		searchInput?.addEventListener("input", () => {
			settings.searchText = String(searchInput.value || "").slice(0, 160);
			previewPage = 1;
			saveSettings();
			scheduleBackendWorkflowSettingsSave();
			renderPreviewItems();
			updatePreviewSummary();
		});
		for (const button of overlay.querySelectorAll("[data-gjj-sort]")) {
			button.addEventListener("click", () => {
				settings.sortMode = choice(button.dataset.gjjSort, SORT_MODE_LABELS, DEFAULT_SORT_MODE);
				settings.filterMode = DEFAULT_FILTER_MODE;
				previewPage = 1;
				saveSettings();
				scheduleBackendWorkflowSettingsSave();
				updateSaveSettingsUI(false);
				renderPreviewItems();
				updatePreviewSummary();
			});
		}
		const pageSizeInput = overlay.querySelector("[data-gjj-setting='page-size']");
		const commitPageSize = () => {
			if (!pageSizeInput) return;
			settings.pageSize = pageSizeValue(pageSizeInput.value);
			pageSizeInput.value = String(settings.pageSize);
			previewPage = 1;
			saveSettings();
			scheduleBackendWorkflowSettingsSave();
			renderPreviewItems();
			updatePreviewSummary();
		};
		pageSizeInput?.addEventListener("change", commitPageSize);
		pageSizeInput?.addEventListener("blur", commitPageSize);
		pageSizeInput?.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commitPageSize();
			}
		});
		const directoryInput = overlay.querySelector("[data-gjj-setting='directory-path']");
		directoryInput?.addEventListener("input", () => {
			settings.directoryPath = String(directoryInput.value || "").trim();
			saveSettings();
			scheduleBackendWorkflowSettingsSave();
			updateSaveSettingsUI(false);
		});
		document.body.appendChild(overlay);
		updateSaveSettingsUI();
		return overlay;
	}

	function updateSaveSettingsUI(updateInput = true) {
		const overlay = document.getElementById(PREVIEW_OVERLAY_ID);
		if (!overlay) return;
		const input = overlay.querySelector("[data-gjj-setting='filename-template']");
		if (updateInput && input) input.value = String(settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE);
		const dir = overlay.querySelector("[data-gjj-setting='directory-path']");
		if (dir) {
			if (updateInput) dir.value = effectiveDirectory();
			dir.title = effectiveDirectory() || "GJJ 后端默认保存目录";
		}
		const reset = overlay.querySelector("[data-gjj-action='reset-name']");
		if (reset) reset.title = "恢复默认文件名模板";
		for (const choose of overlay.querySelectorAll("[data-gjj-action='open-dir']")) {
			choose.title = "打开当前保存目录";
		}
		const clear = overlay.querySelector("[data-gjj-action='clear-dir']");
		if (clear) clear.title = "恢复包内 workflows 默认目录";
		const search = overlay.querySelector("[data-gjj-setting='search-text']");
		if (search && updateInput) search.value = String(settings.searchText || "");
		const sortMode = choice(settings.sortMode, SORT_MODE_LABELS, DEFAULT_SORT_MODE);
		for (const button of overlay.querySelectorAll("[data-gjj-sort]")) {
			const active = button.dataset.gjjSort === sortMode;
			button.classList.toggle("gjj-active", active);
			button.setAttribute("aria-pressed", active ? "true" : "false");
		}
		const pageSize = overlay.querySelector("[data-gjj-setting='page-size']");
		if (pageSize && updateInput) pageSize.value = String(pageSizeValue(settings.pageSize));
		for (const refresh of overlay.querySelectorAll("[data-gjj-action='refresh-list']")) {
			refresh.title = "刷新当前保存目录";
		}
		for (const shortcut of overlay.querySelectorAll("[data-gjj-action='shortcut-help']")) {
			shortcut.title = "显示快捷键";
		}
		const settingsButton = overlay.querySelector("[data-gjj-action='settings-toggle']");
		const settingsPanel = overlay.querySelector(".gjj-workflow-save-options");
		if (settingsButton) {
			const open = !settingsPanel?.hidden;
			settingsButton.classList.toggle("gjj-active", open);
			settingsButton.setAttribute("aria-expanded", open ? "true" : "false");
			settingsButton.title = open ? "隐藏文件名、目录和分页设置" : "打开文件名、目录和分页设置";
		}
		const save = overlay.querySelector("[data-gjj-action='save-current']");
		if (save) save.title = "保存当前工作流截图";
		const close = overlay.querySelector("[data-gjj-action='close']");
		if (close) close.title = "关闭截图预览";
	}

	function setPreviewStatus(text, tone = "") {
		const overlay = previewOverlay();
		const status = overlay.querySelector(".gjj-workflow-preview-status");
		if (!status) return;
		status.textContent = text || "";
		status.dataset.tone = tone || "";
	}

	function previewItemName(item) {
		return String(item?.file?.name || item?.filename || "workflow.jpg");
	}

	function previewItemTitle(item) {
		return cleanWorkflowTitleText(item?.title || item?.metadataTitle || "");
	}

	function cleanWorkflowDisplayTitle(value) {
		const text = cleanWorkflowTitleText(value);
		return /^(unsaved workflow|untitled|未命名|未保存工作流)$/i.test(text) ? "" : text;
	}

	function previewItemDisplayTitle(item) {
		const imageName = previewItemName(item).replace(/\.(png|webp|jpe?g|bmp|gif)$/i, "");
		return cleanWorkflowDisplayTitle(previewItemTitle(item)) ||
			cleanSourceWorkflowName(imageName) ||
			cleanWorkflowDisplayTitle(workflowTitleTextFromWorkflow(item?.workflow)) ||
			workflowNameFromValue(item?.workflow);
	}

	function workflowWithDisplayTitle(workflow, title) {
		const text = cleanWorkflowDisplayTitle(title);
		if (!text || !workflow || typeof workflow !== "object") return workflow;
		const extra = workflow.extra && typeof workflow.extra === "object" ? workflow.extra : {};
		return {
			...workflow,
			name: workflow.name || text,
			title: workflow.title || text,
			workflow_name: workflow.workflow_name || text,
			workflowName: workflow.workflowName || text,
			extra: {
				...extra,
				name: extra.name || text,
				title: extra.title || text,
				workflow_name: extra.workflow_name || text,
				workflowName: extra.workflowName || text,
			},
		};
	}

	function applyLoadedWorkflowTitle(title) {
		const text = cleanWorkflowDisplayTitle(title);
		if (!text) return;
		const graph = app?.graph;
		if (graph && typeof graph === "object") {
			graph.name = text;
			graph.title = text;
			graph.workflow_name = text;
			graph.workflowName = text;
			graph.extra = graph.extra && typeof graph.extra === "object" ? graph.extra : {};
			graph.extra.name = text;
			graph.extra.title = text;
			graph.extra.workflow_name = text;
			graph.extra.workflowName = text;
		}
		const manager = app?.workflowManager;
		for (const target of [manager?.activeWorkflow, manager?.currentWorkflow, manager?.workflow, app?.ui]) {
			if (!target || typeof target !== "object") continue;
			target.name = text;
			target.title = text;
			target.workflow_name = text;
			target.workflowName = text;
		}
		for (const method of ["setWorkflowName", "setWorkflowTitle", "setActiveWorkflowName"]) {
			if (typeof manager?.[method] !== "function") continue;
			try { manager[method](text); } catch (_) {}
		}
		if (typeof document !== "undefined") {
			document.title = `ComfyUI - ${text}`;
		}
	}

	function previewItemMtime(item) {
		const explicit = Number(item?.mtime);
		if (Number.isFinite(explicit) && explicit > 0) return explicit;
		const modified = Number(item?.file?.lastModified);
		return Number.isFinite(modified) && modified > 0 ? modified / 1000 : 0;
	}

	function previewItemSize(item) {
		const explicit = Number(item?.size ?? item?.size_bytes ?? item?.file_size);
		if (Number.isFinite(explicit) && explicit >= 0) return explicit;
		const fileSize = Number(item?.file?.size);
		return Number.isFinite(fileSize) && fileSize >= 0 ? fileSize : 0;
	}

	function compareText(a, b) {
		return String(a || "").localeCompare(String(b || ""), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
	}

	function previewSearchText(item) {
		return [
			previewItemName(item),
			previewItemTitle(item),
			item?.error || "",
			item?.directory || "",
		].join(" ").toLowerCase();
	}

	function sortedFilteredPreviewItems() {
		const filterMode = DEFAULT_FILTER_MODE;
		const query = String(settings.searchText || "").trim().toLowerCase();
		const items = previewItems.filter((item) => {
			if (filterMode === "openable" && !item.workflow) return false;
			if (filterMode === "missing" && item.workflow) return false;
			return !query || previewSearchText(item).includes(query);
		});
		const sortMode = choice(settings.sortMode, SORT_MODE_LABELS, DEFAULT_SORT_MODE);
		items.sort((a, b) => {
			if (sortMode === "mtime_asc") return previewItemMtime(a) - previewItemMtime(b) || compareText(previewItemName(a), previewItemName(b));
			if (sortMode === "size_desc") return previewItemSize(b) - previewItemSize(a) || (previewItemMtime(b) - previewItemMtime(a)) || compareText(previewItemName(a), previewItemName(b));
			if (sortMode === "size_asc") return previewItemSize(a) - previewItemSize(b) || (previewItemMtime(b) - previewItemMtime(a)) || compareText(previewItemName(a), previewItemName(b));
			if (sortMode === "name_asc") return compareText(previewItemName(a), previewItemName(b)) || (previewItemMtime(b) - previewItemMtime(a));
			if (sortMode === "name_desc") return compareText(previewItemName(b), previewItemName(a)) || (previewItemMtime(b) - previewItemMtime(a));
			if (sortMode === "title_asc") return compareText(previewItemTitle(a) || previewItemName(a), previewItemTitle(b) || previewItemName(b)) || (previewItemMtime(b) - previewItemMtime(a));
			if (sortMode === "openable_first") return Number(!!b.workflow) - Number(!!a.workflow) || (previewItemMtime(b) - previewItemMtime(a));
			return previewItemMtime(b) - previewItemMtime(a) || compareText(previewItemName(a), previewItemName(b));
		});
		return items;
	}

	function previewPageInfo(items = sortedFilteredPreviewItems()) {
		const pageSize = pageSizeValue(settings.pageSize);
		const totalItems = items.length;
		const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
		previewPage = clampInteger(previewPage, 1, 1, totalPages);
		const start = totalItems ? (previewPage - 1) * pageSize : 0;
		const end = totalItems ? Math.min(totalItems, start + pageSize) : 0;
		return {
			page: previewPage,
			pageSize,
			totalItems,
			totalPages,
			start,
			end,
			items: items.slice(start, end),
		};
	}

	function renderPagination(page = previewPageInfo()) {
		const overlay = previewOverlay();
		const pagination = overlay.querySelector(".gjj-workflow-pagination");
		if (!pagination) return;
		pagination.textContent = "";
		if (!page.totalItems) {
			pagination.hidden = true;
			return;
		}
		pagination.hidden = false;

		const makeButton = (label, title, disabled, targetPage) => {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = label;
			button.title = title;
			button.disabled = disabled;
			button.addEventListener("click", () => {
				previewPage = targetPage;
				renderPreviewItems();
				updatePreviewSummary();
			});
			return button;
		};
		const label = document.createElement("span");
		label.className = "gjj-workflow-pagination-label";
		label.textContent = `📄 第 ${page.page}/${page.totalPages} 页 · ${page.start + 1}-${page.end}/${page.totalItems} · 每页 ${page.pageSize} 张`;
		pagination.append(
			makeButton("⏮️首页", "跳到第一页", page.page <= 1, 1),
			makeButton("◀️上一页", "上一页", page.page <= 1, Math.max(1, page.page - 1)),
			label,
			makeButton("下一页▶️", "下一页", page.page >= page.totalPages, Math.min(page.totalPages, page.page + 1)),
			makeButton("末页⏭️", "跳到最后一页", page.page >= page.totalPages, page.totalPages)
		);
	}

	function updatePreviewSummary() {
		const total = previewItems.length;
		const usable = previewItems.filter((item) => item.workflow).length;
		const visibleItems = sortedFilteredPreviewItems();
		const page = previewPageInfo(visibleItems);
		const range = visibleItems.length ? `，当前 ${page.start + 1}-${page.end}/${visibleItems.length} 张` : "，当前无匹配";
		setPreviewStatus(`保存目录：${effectiveDirectory()}；已读取 ${total} 张，${usable} 张可打开${range}。`, usable ? "ok" : "warn");
	}

	function renderPreviewItems() {
		const overlay = previewOverlay();
		const grid = overlay.querySelector(".gjj-workflow-preview-grid");
		if (!grid) return;
		grid.textContent = "";

		const items = sortedFilteredPreviewItems();
		const page = previewPageInfo(items);
		renderPagination(page);
		if (!items.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-workflow-preview-empty";
			empty.textContent = previewItems.length ? "没有符合筛选条件的截图。" : "当前目录没有工作流截图。";
			grid.appendChild(empty);
			return;
		}

		for (const item of page.items) {
			const card = document.createElement("button");
			card.type = "button";
			card.className = "gjj-workflow-preview-card";
			card.disabled = !item.workflow;
			card.title = item.workflow
				? "打开这个截图内嵌的工作流"
				: `未找到可加载的 workflow 元数据：${item.error || item.file?.name || ""}`;

			const image = document.createElement("img");
			image.src = item.url;
			image.alt = item.file?.name || "workflow screenshot";

			const label = document.createElement("div");
			label.className = "gjj-workflow-preview-name";
			label.textContent = previewItemTitle(item) || previewItemName(item);

			const mark = document.createElement("div");
			mark.className = "gjj-workflow-preview-mark";
			mark.textContent = item.workflow ? "打开" : "无元数据";

			card.append(image, label, mark);
			card.addEventListener("click", () => {
				card.disabled = true;
				mark.textContent = "打开中...";
				loadWorkflowFromPreview(item);
			});
			grid.appendChild(card);
		}
	}

	async function loadWorkflowFromPreview(item) {
		if (!item?.workflow) {
			alert("这张截图没有找到可加载的 workflow 元数据。");
			return;
		}
		try {
			const title = previewItemDisplayTitle(item);
			closePreviewOverlay();
			await app.loadGraphData(workflowWithDisplayTitle(item.workflow, title));
			applyLoadedWorkflowTitle(title);
			app?.canvas?.setDirty?.(true, true);
			app?.graph?.setDirtyCanvas?.(true, true);
		} catch (error) {
			console.error("[GJJ] 打开截图工作流失败：", error);
			alert(`打开工作流失败：\n${error?.message || error}`);
		}
	}

	async function workflowFromImageUrl(url) {
		const response = await fetch(url, { cache: "no-store" });
		if (!response.ok) throw new Error(`读取截图失败：HTTP ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		return workflowFromMetadata(parseImageMetadata(bytes));
	}

	async function previewDataFromImageUrl(url) {
		const response = await fetch(url, { cache: "no-store" });
		if (!response.ok) throw new Error(`读取截图失败：HTTP ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const metadata = parseImageMetadata(bytes);
		const workflow = workflowFromMetadata(metadata);
		return {
			workflow,
			metadata,
			title: workflowTitleFromMetadata(metadata, workflow),
		};
	}

	function rememberSavedScreenshot(bytes, metadata, saved) {
		const filename = typeof saved === "string" ? saved : (saved?.filename || "GJJ_workflow.jpg");
		const mimeType = mimeTypeForFilename(filename);
		const blob = new Blob([bytes], { type: mimeType });
		const file = typeof File === "function"
			? new File([blob], filename || "GJJ_workflow.jpg", { type: mimeType })
			: { name: filename || "GJJ_workflow.jpg", size: blob.size, type: mimeType };
		const workflow = workflowFromMetadata(metadata);
		previewItems.unshift({
			file,
			size: Number(saved?.size ?? saved?.size_bytes ?? blob.size) || blob.size,
			url: saved?.url || URL.createObjectURL(blob),
			workflow,
			title: workflowTitleFromMetadata(metadata, workflow),
			metadata,
			mtime: Number(saved?.mtime) || Date.now() / 1000,
			error: "",
			directory: saved?.directory || effectiveDirectory(),
		});
		previewPage = 1;
		while (previewItems.length > 60) {
			const old = previewItems.pop();
			if (old?.url && String(old.url).startsWith("blob:")) {
				try { URL.revokeObjectURL(old.url); } catch (_) {}
			}
		}
		const overlay = document.getElementById(PREVIEW_OVERLAY_ID);
		if (overlay && overlay.style.display === "flex") {
			renderPreviewItems();
			updatePreviewSummary();
		}
	}

	async function refreshBackendScreenshotList() {
		const overlay = previewOverlay();
		overlay.style.display = "flex";
		await flushBackendWorkflowSettingsSave();
		try {
			await loadBackendInfo();
		} catch (_) {
			updateSaveSettingsUI();
		}
		previewPage = 1;
		setPreviewStatus("正在读取保存目录...", "");
		const data = await apiJson(`/gjj/workflow_screenshot/list?directory=${encodeURIComponent(effectiveDirectory())}`);
		settings.directoryPath = String(data.directory || effectiveDirectory());
		saveSettings();
		updateSaveSettingsUI();
		clearPreviewItems();
		previewItems = (data.items || []).map((item) => ({
			file: { name: item.filename || "workflow.jpg", size: item.size || 0, type: mimeTypeForFilename(item.filename || "workflow.jpg") },
			size: Number(item.size ?? item.size_bytes ?? item.file_size) || 0,
			url: item.url || "",
			workflow: null,
			title: "",
			metadata: null,
			mtime: Number(item.mtime) || 0,
			error: "",
			directory: item.directory || data.directory || effectiveDirectory(),
		}));

		await Promise.all(previewItems.map(async (item) => {
			try {
				const data = item.url ? await previewDataFromImageUrl(item.url) : null;
				item.workflow = data?.workflow || null;
				item.metadata = data?.metadata || null;
				item.title = data?.title || "";
				if (!item.workflow) item.error = "未找到 workflow";
			} catch (error) {
				item.error = String(error?.message || error || "读取失败");
			}
		}));
		renderPreviewItems();
		updatePreviewSummary();
	}

	async function showScreenshotPreview() {
		const overlay = previewOverlay();
		overlay.style.display = "flex";
		try {
			await refreshBackendScreenshotList();
		} catch (error) {
			console.error("[GJJ] 读取工作流截图目录失败：", error);
			setPreviewStatus(`读取保存目录失败：${error?.message || error}`, "warn");
		}
	}

	function flashSaved(button) {
		if (!button) return;
		button.classList.add("gjj-saved");
		clearTimeout(button.__gjjSavedTimer);
		button.__gjjSavedTimer = setTimeout(() => button.classList.remove("gjj-saved"), 650);
	}

	async function saveWorkflowScreenshot(button) {
		if (busy) return;
		busy = true;
		if (button) button.disabled = true;
		try {
			await flushBackendWorkflowSettingsSave();
			const metadata = await buildMetadata();
			const snapshot = buildGraphSnapshot(lastWorkflowObject);
			const filename = buildFilename(snapshot);
			if (!snapshot.bounds || !snapshot.nodes.length) {
				alert("当前工作流没有可截图的节点。");
				return;
			}
			const cropped = await captureWorkflowCanvas(snapshot);
			if (!cropped) throw new Error("截图画布创建失败");
			const exportCanvas = constrainCanvasDimensions(cropped);
			const imageBytes = await canvasToImageBytes(exportCanvas, filename);
			const finalBytes = injectImageMetadata(imageBytes, metadata, filename);
			const saved = await saveImageBytes(finalBytes, filename);
			rememberSavedScreenshot(finalBytes, metadata, saved);
			flashSaved(button);
		} catch (error) {
			console.error("[GJJ] 工作流截图保存失败：", error);
			alert(`工作流截图保存失败：\n${error?.message || error}`);
		} finally {
			if (button) button.disabled = false;
			busy = false;
		}
	}

	function isPreviewOpen() {
		const overlay = document.getElementById(PREVIEW_OVERLAY_ID);
		return !!overlay && overlay.style.display === "flex";
	}

	function closePreviewOverlay() {
		const overlay = document.getElementById(PREVIEW_OVERLAY_ID);
		if (overlay) overlay.style.display = "none";
	}

	function focusPreviewSearch() {
		const overlay = previewOverlay();
		const input = overlay.querySelector("[data-gjj-setting='search-text']");
		if (input) {
			input.focus();
			input.select?.();
		}
	}

	function isEditableTarget(target) {
		const element = target instanceof Element ? target : null;
		if (!element) return false;
		const tag = element.tagName?.toLowerCase?.() || "";
		return element.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
	}

	function installKeyboardShortcuts() {
		if (keyboardShortcutsInstalled) return;
		keyboardShortcutsInstalled = true;
		document.addEventListener("keydown", (event) => {
			const key = String(event.key || "").toLowerCase();
			const previewOpen = isPreviewOpen();
			if (previewOpen && key === "escape") {
				event.preventDefault();
				closePreviewOverlay();
				return;
			}
			if (previewOpen && event.ctrlKey && !event.altKey && key === "f") {
				event.preventDefault();
				focusPreviewSearch();
				return;
			}
			if (previewOpen && event.altKey && !event.ctrlKey && key === "r") {
				event.preventDefault();
				refreshBackendScreenshotList();
				return;
			}
			if (isEditableTarget(event.target)) return;
			if (event.altKey && event.shiftKey && !event.ctrlKey && key === "s") {
				event.preventDefault();
				saveWorkflowScreenshot(document.getElementById(SAVE_BUTTON_ID));
				return;
			}
			if (event.altKey && event.shiftKey && !event.ctrlKey && key === "o") {
				event.preventDefault();
				showScreenshotPreview();
			}
		}, true);
	}

	function installStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
#${TOOLBAR_ID} {
	position: fixed;
	left: 50%;
	top: 12px;
	z-index: 12000;
	display: flex;
	flex-direction: row;
	gap: 6px;
	align-items: center;
	transform: translateX(-50%);
	pointer-events: none;
}
#${TOOLBAR_ID}.gjj-workflow-toolbar-topbar {
	position: static;
	right: auto;
	bottom: auto;
	z-index: auto;
	flex: 0 0 auto;
	flex-direction: row;
	margin-left: 8px;
	align-self: center;
	transform: none;
}
#${TOOLBAR_ID}.gjj-workflow-toolbar-hidden {
	display: none;
}
#${TOOLBAR_ID} .gjj-workflow-screenshot-button {
	width: 34px;
	height: 34px;
	padding: 0;
	border: 1px solid rgba(117, 137, 148, .5);
	border-radius: 8px;
	background: rgba(28, 32, 36, .92);
	color: #f2f6f4;
	font: 19px/32px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
	cursor: pointer;
	box-sizing: border-box;
	pointer-events: auto;
	box-shadow: 0 4px 14px rgba(0, 0, 0, .28);
	transition: border-color .16s ease, background .16s ease, transform .16s ease, opacity .16s ease;
}
#${TOOLBAR_ID} .gjj-workflow-screenshot-button:hover {
	border-color: rgba(105, 184, 139, .85);
	background: rgba(36, 55, 44, .96);
}
#${TOOLBAR_ID} .gjj-workflow-screenshot-button:active {
	transform: translateY(1px);
}
#${TOOLBAR_ID} .gjj-workflow-screenshot-button:disabled {
	cursor: wait;
	opacity: .68;
}
#${TOOLBAR_ID} .gjj-workflow-screenshot-button.gjj-saved {
	border-color: rgba(113, 219, 150, .95);
	background: rgba(36, 86, 56, .96);
}
#${PREVIEW_OVERLAY_ID} {
	position: fixed;
	inset: 0;
	display: none;
	align-items: center;
	justify-content: center;
	z-index: 13000;
	background: rgba(0, 0, 0, .48);
	pointer-events: auto;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-panel {
	width: min(1120px, calc(100vw - 40px));
	max-height: min(720px, calc(100vh - 44px));
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 14px;
	border: 1px solid rgba(117, 137, 148, .46);
	border-radius: 8px;
	background: #101519;
	color: #e8f0ec;
	box-shadow: 0 18px 50px rgba(0, 0, 0, .46);
	box-sizing: border-box;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-title {
	flex: 0 0 auto;
	font: 800 14px/20px sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: 6px;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-actions button {
	width: auto;
	min-width: 68px;
	height: 30px;
	padding: 0 9px;
	border: 1px solid rgba(117, 137, 148, .5);
	border-radius: 7px;
	background: #1b242a;
	color: #edf6f1;
	font: 700 12px/28px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI", sans-serif;
	cursor: pointer;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-actions button:hover {
	border-color: rgba(105, 184, 139, .85);
	background: #24372c;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-actions button.gjj-active {
	border-color: rgba(113, 219, 150, .95);
	background: rgba(36, 86, 56, .96);
	color: #f4fff7;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-options[hidden],
#${PREVIEW_OVERLAY_ID} .gjj-workflow-shortcut-help[hidden],
#${PREVIEW_OVERLAY_ID} .gjj-workflow-pagination[hidden] {
	display: none !important;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-options {
	display: grid;
	grid-template-columns: minmax(260px, 1fr) minmax(240px, .85fr) minmax(140px, .35fr);
	gap: 8px;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-filter-options {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-row {
	min-width: 0;
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 7px;
	border: 1px solid rgba(117, 137, 148, .26);
	border-radius: 7px;
	background: #121a1f;
	box-sizing: border-box;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-row label {
	flex: 0 0 auto;
	color: #9fb0b7;
	font: 700 12px/18px sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-row input,
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-row select {
	min-width: 0;
	flex: 1 1 auto;
	height: 28px;
	padding: 0 8px;
	border: 1px solid rgba(117, 137, 148, .36);
	border-radius: 6px;
	background: #0b1115;
	color: #e8f0ec;
	font: 12px/28px Consolas, "Segoe UI", sans-serif;
	box-sizing: border-box;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-row select {
	font-family: "Segoe UI", sans-serif;
	cursor: pointer;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-row input[type="number"] {
	flex: 0 0 92px;
	font-family: "Segoe UI", sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-search-row input {
	font-family: "Segoe UI", sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-dir {
	min-width: 0;
	flex: 1 1 auto;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	color: #d1ddd8;
	font: 12px/18px sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-row button {
	flex: 0 0 auto;
	width: 28px;
	height: 28px;
	padding: 0;
	border: 1px solid rgba(117, 137, 148, .42);
	border-radius: 6px;
	background: #1b242a;
	color: #edf6f1;
	font: 700 15px/26px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
	cursor: pointer;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-row button:hover {
	border-color: rgba(105, 184, 139, .82);
	background: #24372c;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-sort-row {
	align-items: flex-start;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-sort-row label {
	line-height: 28px;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-sort-buttons {
	min-width: 0;
	flex: 1 1 auto;
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-sort-buttons button {
	width: auto;
	min-width: 76px;
	height: 28px;
	padding: 0 9px;
	font: 700 12px/26px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI", sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-sort-buttons button.gjj-active {
	border-color: rgba(113, 219, 150, .95);
	background: rgba(36, 86, 56, .96);
	color: #f4fff7;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-status {
	min-height: 18px;
	color: #aebbc1;
	font: 12px/18px sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-status[data-tone="ok"] {
	color: #90d9a9;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-status[data-tone="warn"] {
	color: #e2c471;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-shortcut-help {
	margin-top: -2px;
	padding: 6px 8px;
	border: 1px solid rgba(117, 137, 148, .22);
	border-radius: 6px;
	background: rgba(15, 23, 28, .88);
	color: #aebbc1;
	font: 12px/18px "Segoe UI", sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
	gap: 10px;
	overflow: auto;
	padding-right: 2px;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-empty {
	grid-column: 1 / -1;
	padding: 18px 10px;
	border: 1px dashed rgba(117, 137, 148, .3);
	border-radius: 8px;
	color: #98a7ad;
	text-align: center;
	font: 12px/18px sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-card {
	min-width: 0;
	padding: 8px;
	border: 1px solid rgba(117, 137, 148, .34);
	border-radius: 8px;
	background: #151d22;
	color: #e8f0ec;
	text-align: left;
	cursor: pointer;
	box-sizing: border-box;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-card:hover {
	border-color: rgba(105, 184, 139, .82);
	background: #1c2a22;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-card:disabled {
	cursor: not-allowed;
	opacity: .55;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-card img {
	display: block;
	width: 100%;
	aspect-ratio: 4 / 3;
	object-fit: contain;
	border-radius: 6px;
	background: #080c0f;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-name {
	margin-top: 7px;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	font: 700 12px/16px sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-mark {
	margin-top: 3px;
	color: #98a7ad;
	font: 11px/14px sans-serif;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-pagination {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: center;
	gap: 7px;
	padding-top: 2px;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-pagination button {
	height: 28px;
	padding: 0 9px;
	border: 1px solid rgba(117, 137, 148, .42);
	border-radius: 6px;
	background: #1b242a;
	color: #edf6f1;
	font: 700 12px/26px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI", sans-serif;
	cursor: pointer;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-pagination button:hover:not(:disabled) {
	border-color: rgba(105, 184, 139, .82);
	background: #24372c;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-pagination button:disabled {
	cursor: not-allowed;
	opacity: .45;
}
#${PREVIEW_OVERLAY_ID} .gjj-workflow-pagination-label {
	color: #b8c8c0;
	font: 700 12px/18px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI", sans-serif;
}
@media (max-width: 760px) {
	#${PREVIEW_OVERLAY_ID} .gjj-workflow-save-options,
	#${PREVIEW_OVERLAY_ID} .gjj-workflow-filter-options {
		grid-template-columns: 1fr;
	}
	#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-head {
		flex-direction: column;
	}
	#${PREVIEW_OVERLAY_ID} .gjj-workflow-preview-actions {
		justify-content: flex-start;
	}
}
`;
		document.head.appendChild(style);
	}

	function readableElementText(element) {
		return [
			element?.textContent,
			element?.ariaLabel,
			element?.title,
			element?.getAttribute?.("aria-label"),
			element?.getAttribute?.("title"),
		].join(" ").replace(/\s+/g, " ").trim();
	}

	function isVisibleElement(element) {
		if (!element || !(element instanceof Element)) return false;
		const rect = element.getBoundingClientRect?.();
		if (!rect || rect.width < 8 || rect.height < 8) return false;
		const style = window.getComputedStyle?.(element);
		return style?.display !== "none" && style?.visibility !== "hidden" && Number(style?.opacity ?? 1) > 0;
	}

	function directChildContaining(parent, child) {
		let node = child;
		while (node?.parentElement && node.parentElement !== parent) node = node.parentElement;
		return node?.parentElement === parent ? node : null;
	}

	function findTopbarInsertPoint() {
		const controls = Array.from(document.querySelectorAll("button,[role='button']"));
		const manager = controls.find((element) => {
			if (!isVisibleElement(element)) return false;
			const text = readableElementText(element);
			const rect = element.getBoundingClientRect();
			return rect.top < 140 && /管理扩展功能|manage extensions?|extension manager/i.test(text);
		});
		if (!manager) return null;

		const managerRect = manager.getBoundingClientRect();
		let row = null;
		for (let node = manager.parentElement, depth = 0; node && depth < 7; node = node.parentElement, depth += 1) {
			if (!isVisibleElement(node)) continue;
			const rect = node.getBoundingClientRect();
			if (rect.top > 160 || rect.height > 96 || rect.width < managerRect.width) continue;
			const style = window.getComputedStyle?.(node);
			const text = readableElementText(node);
			const hasTopbarText = /管理扩展功能|运行|活动任务|queue|run/i.test(text);
			const looksLikeRow = style?.display?.includes("flex") || rect.width > managerRect.width + 80;
			if (hasTopbarText && looksLikeRow) row = node;
			if (row && rect.width > managerRect.width + 220) break;
		}
		if (!row) return null;
		return { row, after: directChildContaining(row, manager) || manager };
	}

	function positionToolbar(toolbar) {
		if (!toolbar) return;
		toolbar.classList.remove("gjj-workflow-toolbar-hidden");

		const insertPoint = findTopbarInsertPoint();
		if (insertPoint?.row) {
			const next = insertPoint.after?.nextSibling || null;
			if (toolbar.parentElement !== insertPoint.row || toolbar.previousSibling !== insertPoint.after) {
				insertPoint.row.insertBefore(toolbar, next);
			}
			toolbar.classList.add("gjj-workflow-toolbar-topbar");
			toolbar.style.left = "";
			toolbar.style.top = "";
			toolbar.style.right = "";
			toolbar.style.bottom = "";
			toolbar.style.transform = "";
			return;
		}

		if (toolbar.parentElement !== document.body) document.body.appendChild(toolbar);
		toolbar.classList.remove("gjj-workflow-toolbar-topbar");

		toolbar.style.left = "50%";
		toolbar.style.top = "12px";
		toolbar.style.right = "";
		toolbar.style.bottom = "";
		toolbar.style.transform = "translateX(-50%)";
	}

	function makeToolbarButton(id, text, title, onClick) {
		let button = document.getElementById(id);
		if (button) button.remove();
		button = document.createElement("button");
		button.id = id;
		button.className = "gjj-workflow-screenshot-button";
		button.type = "button";
		button.textContent = text;
		button.title = title;
		button.setAttribute("aria-label", title);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("mousedown", (event) => event.stopPropagation());
		button.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick(button);
		});
		return button;
	}

	function ensureToolbar() {
		installStyle();
		let toolbar = document.getElementById(TOOLBAR_ID);
		if (!toolbar) {
			toolbar = document.createElement("div");
			toolbar.id = TOOLBAR_ID;
			document.body.appendChild(toolbar);
		}

		toolbar.textContent = "";
		toolbar.append(
			makeToolbarButton(SAVE_BUTTON_ID, "💾", "保存工作流截图（Alt+Shift+S）", saveWorkflowScreenshot),
			makeToolbarButton(OPEN_BUTTON_ID, "📁", "预览并打开工作流截图（Alt+Shift+O）", showScreenshotPreview)
		);
		positionToolbar(toolbar);
		return toolbar;
	}

	function startPositionSync() {
		if (window.__gjjWorkflowScreenshotPositionSyncStarted) return;
		window.__gjjWorkflowScreenshotPositionSyncStarted = true;
		const sync = () => {
			const toolbar = document.getElementById(TOOLBAR_ID) || ensureToolbar();
			positionToolbar(toolbar);
		};
		window.addEventListener("resize", sync);
		window.addEventListener("orientationchange", sync);
		for (const delay of [120, 500, 1200, 2500]) setTimeout(sync, delay);
		setInterval(sync, 3000);
	}

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			ensureToolbar();
			loadBackendInfo().catch(() => updateSaveSettingsUI());
			installKeyboardShortcuts();
			startPositionSync();
			console.log("[GJJ] 工作流截图保存按钮与快捷键已启用");
		},
	});
})();

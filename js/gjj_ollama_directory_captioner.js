import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_OllamaDirectoryCaptioner"]);
const DOM_WIDGET_NAME = "gjj_ollama_directory_captioner_dom";
const MIN_WIDTH = 360;
const PANEL_MIN_HEIGHT = 118;
const DIRECTORY_WIDGET = "selected_directory";
const SUMMARY_WIDGET = "last_summary";
const HOST_WIDGET = "ollama_host";
const MODEL_WIDGET = "ollama_model";
const PROMPT_WIDGET = "prompt_template";
const OVERWRITE_WIDGET = "overwrite_existing";
const INCLUDE_SUBDIRS_WIDGET = "include_subdirectories";
const CAPTION_API_PATH = "/gjj/ollama_caption_image";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"]);
const TAGS_API_SUFFIX = "/api/tags";
const NODE_EXTRA_HEIGHT = 52;
const BACKEND_WIDGETS = [
	HOST_WIDGET,
	MODEL_WIDGET,
	PROMPT_WIDGET,
	OVERWRITE_WIDGET,
	INCLUDE_SUBDIRS_WIDGET,
	DIRECTORY_WIDGET,
	SUMMARY_WIDGET,
];
const HIDDEN_WIDGETS = new Set(BACKEND_WIDGETS);
const HIDDEN_INPUTS = new Set(BACKEND_WIDGETS);

function formatElapsed(ms) {
	const seconds = Math.max(0, Number(ms || 0)) / 1000;
	if (seconds < 10) {
		return `${seconds.toFixed(2)}秒`;
	}
	if (seconds < 60) {
		return `${seconds.toFixed(1)}秒`;
	}
	const minutes = Math.floor(seconds / 60);
	return `${minutes}分${(seconds % 60).toFixed(1)}秒`;
}

function requestRedraw(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => String(widget?.name || "") === name);
}

function getWidgetValue(node, name, fallback = "") {
	const widget = getWidget(node, name);
	return widget ? widget.value : fallback;
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) {
		return;
	}
	widget.value = value;
	try {
		widget.callback?.(value);
	} catch (error) {
		// noop
	}
	if (widget.inputEl) {
		widget.inputEl.value = value;
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = value;
	}
}

function setWidgetLabel(node, name, label) {
	const widget = getWidget(node, name);
	if (!widget || !label) {
		return;
	}
	widget.label = label;
	widget.localized_name = label;
	if (widget.options && typeof widget.options === "object") {
		widget.options.display_name = label;
	}
}

function parseModelSize(modelName) {
	const name = String(modelName || "").trim().toLowerCase();
	if (!name) {
		return Number.POSITIVE_INFINITY;
	}
	const matches = [...name.matchAll(/(?:^|[:/\-_])(?:e)?(\d+(?:\.\d+)?)b(?:$|[:/\-_])/g)];
	if (matches.length === 0) {
		return Number.POSITIVE_INFINITY;
	}
	const sizes = matches
		.map((match) => Number.parseFloat(match[1]))
		.filter((value) => !Number.isNaN(value));
	return sizes.length > 0 ? Math.min(...sizes) : Number.POSITIVE_INFINITY;
}

function sortModels(values) {
	return [...values].sort((a, b) => {
		const sizeDiff = parseModelSize(a) - parseModelSize(b);
		if (sizeDiff !== 0) {
			return sizeDiff;
		}
		return String(a).localeCompare(String(b));
	});
}

function normalizeHost(rawHost) {
	let host = String(rawHost || "").trim();
	if (!host) {
		host = "http://127.0.0.1:11434";
	}
	if (host.endsWith("/")) {
		host = host.slice(0, -1);
	}
	if (host.endsWith("/api")) {
		host = host.slice(0, -4);
	}
	if (!/^https?:\/\//i.test(host)) {
		host = `http://${host}`;
	}
	return host;
}

async function fetchModelsForHost(host) {
	const response = await fetch(`${normalizeHost(host)}${TAGS_API_SUFFIX}`);
	if (!response.ok) {
		throw new Error(`读取 Ollama 模型列表失败：HTTP ${response.status}`);
	}
	const data = await response.json();
	const models = Array.isArray(data?.models) ? data.models : [];
	const names = [];
	for (const item of models) {
		const name = String(item?.name || item?.model || "").trim();
		if (name && !names.includes(name)) {
			names.push(name);
		}
	}
	return sortModels(names);
}

function setModelOptions(node, values) {
	const widget = getWidget(node, MODEL_WIDGET);
	if (!widget || !Array.isArray(values) || !values.length) {
		return;
	}
	widget.options = widget.options || {};
	widget.options.values = values;
	if (!values.includes(widget.value)) {
		setWidgetValue(node, MODEL_WIDGET, values[0]);
	}
	syncOllamaDirectoryPanel(node);
	scheduleLayout(node);
	requestRedraw(node);
}

async function refreshModelList(node, silent = false) {
	try {
		const host = getWidgetValue(node, HOST_WIDGET, "http://127.0.0.1:11434");
		const names = await fetchModelsForHost(host);
		if (names.length) {
			setModelOptions(node, names);
		} else if (!silent) {
			setStatus(node, "未读取到任何 Ollama 模型，请确认本地模型已安装。", "error");
		}
	} catch (error) {
		if (!silent) {
			setStatus(node, error?.message || "读取 Ollama 模型列表失败", "error");
		}
	}
}

function hideBackendWidgets(node) {
	for (const name of BACKEND_WIDGETS) {
		GJJ_Utils.hideWidget(getWidget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_INPUTS);
	compactWidgetLayout(node);
	resizeNode(node);
}

function measureHeight(node) {
	const root = node?.__gjjOllamaDirContainer;
	return Math.max(PANEL_MIN_HEIGHT, Math.ceil(root?.scrollHeight || PANEL_MIN_HEIGHT));
}

function compactWidgetLayout(node) {
	if (!Array.isArray(node?.widgets)) return;
	const panel = getWidget(node, DOM_WIDGET_NAME);
	const visible = [];
	const hidden = [];
	for (const item of node.widgets) {
		if (!item) continue;
		if (item === panel) continue;
		const name = String(item.name || "");
		if (item.hidden || item.__gjjUtilsHidden || item.__gjjHidden || HIDDEN_WIDGETS.has(name)) hidden.push(item);
		else visible.push(item);
	}
	node.widgets = [panel, ...visible, ...hidden].filter(Boolean);
	for (const item of node.widgets) {
		if (!item) continue;
		const isHidden = item.hidden || item.__gjjUtilsHidden || item.__gjjHidden || HIDDEN_WIDGETS.has(String(item.name || ""));
		if (isHidden) {
			item.last_y = 0;
			item.computedHeight = 0;
			item.margin_top = 0;
			item.size = [0, 0];
		}
	}
}

function visibleWidgetHeight(node) {
	let total = 0;
	for (const item of node?.widgets || []) {
		if (!item || item.hidden || item.__gjjUtilsHidden || item.__gjjHidden || HIDDEN_WIDGETS.has(String(item.name || ""))) continue;
		try {
			const size = item.computeSize?.(node.size?.[0] || MIN_WIDTH);
			if (Array.isArray(size) && Number.isFinite(Number(size[1]))) {
				total += Math.max(0, Number(size[1]));
				continue;
			}
		} catch (_) {}
		if (Number.isFinite(Number(item.computedHeight))) total += Math.max(0, Number(item.computedHeight));
		else if (Number.isFinite(Number(item.size?.[1]))) total += Math.max(0, Number(item.size[1]));
		else total += 20;
	}
	return total;
}

function resizeNode(node, delay = 0) {
	const run = () => {
		if (!node) return;
		compactWidgetLayout(node);
		const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
		const contentHeight = Math.max(90, Math.ceil(visibleWidgetHeight(node) + NODE_EXTRA_HEIGHT));
		node.setSize?.([width, contentHeight]);
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	};
	if (delay > 0) {
		setTimeout(() => {
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
			else run();
		}, delay);
		return;
	}
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
	else run();
}

function scheduleLayout(node) {
	if (!node || node.__gjjOllamaDirLayoutQueued) {
		return;
	}
	node.__gjjOllamaDirLayoutQueued = true;
	const run = () => {
		node.__gjjOllamaDirLayoutQueued = false;
		resizeNode(node);
	};
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
	else run();
}

function setStatus(node, text, tone = "normal", resize = true) {
	const box = node?.__gjjOllamaDirStatus;
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
	box.style.borderColor = tone === "error" ? "#8b4a4a" : "#41535b";
	box.style.color = tone === "error" ? "#ffd2d2" : "#dce7e2";
	setWidgetValue(node, SUMMARY_WIDGET, String(text || "等待执行"));
	if (resize) {
		scheduleLayout(node);
	}
}

function setDirectoryLabel(node, text, resize = true) {
	const label = node?.__gjjOllamaDirPath;
	if (!label) {
		return;
	}
	label.textContent = text || "未选择目录";
	if (resize) {
		scheduleLayout(node);
	}
}

function boolWidgetValue(node, name, fallback = false) {
	const value = getWidgetValue(node, name, fallback);
	if (typeof value === "boolean") return value;
	const text = String(value ?? "").trim().toLowerCase();
	if (["true", "1", "yes", "on", "是"].includes(text)) return true;
	if (["false", "0", "no", "off", "否"].includes(text)) return false;
	return Boolean(value);
}

function syncSelectOptions(select, values, current) {
	if (!select) return;
	const nextValues = Array.isArray(values) && values.length ? values : (current ? [current] : []);
	const signature = JSON.stringify(nextValues);
	if (select.__gjjOllamaDirOptionsSignature !== signature) {
		select.__gjjOllamaDirOptionsSignature = signature;
		select.replaceChildren();
		for (const value of nextValues) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value || "未选择";
			select.appendChild(option);
		}
	}
	select.value = current || nextValues[0] || "";
}

function syncOllamaDirectoryPanel(node) {
	if (!node?.__gjjOllamaDirContainer) return;
	const hostInput = node.__gjjOllamaDirHostInput;
	const modelSelect = node.__gjjOllamaDirModelSelect;
	const promptInput = node.__gjjOllamaDirPromptInput;
	const overwrite = node.__gjjOllamaDirOverwrite;
	const includeSubdirs = node.__gjjOllamaDirIncludeSubdirs;
	const settings = node.__gjjOllamaDirSettings;
	const settingsButton = node.__gjjOllamaDirSettingsButton;
	const modelWidget = getWidget(node, MODEL_WIDGET);
	if (hostInput && document.activeElement !== hostInput) {
		hostInput.value = String(getWidgetValue(node, HOST_WIDGET, "http://127.0.0.1:11434") || "");
	}
	syncSelectOptions(modelSelect, modelWidget?.options?.values || [], String(getWidgetValue(node, MODEL_WIDGET, "") || ""));
	if (promptInput && document.activeElement !== promptInput) {
		promptInput.value = String(getWidgetValue(node, PROMPT_WIDGET, "") || "");
	}
	if (overwrite) overwrite.checked = boolWidgetValue(node, OVERWRITE_WIDGET, false);
	if (includeSubdirs) includeSubdirs.checked = boolWidgetValue(node, INCLUDE_SUBDIRS_WIDGET, true);
	if (settings) settings.style.display = node.__gjjOllamaDirSettingsOpen ? "flex" : "none";
	if (settingsButton) {
		settingsButton.classList.toggle("active", Boolean(node.__gjjOllamaDirSettingsOpen));
		settingsButton.title = node.__gjjOllamaDirSettingsOpen ? "收起设置" : "展开设置";
	}
	scheduleLayout(node);
}

function fileStem(name) {
	return String(name || "").replace(/\.[^/.]+$/, "");
}

function base64FromArrayBuffer(buffer) {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	for (let index = 0; index < bytes.length; index += chunkSize) {
		const chunk = bytes.subarray(index, index + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function isImageName(name) {
	const lower = String(name || "").toLowerCase();
	for (const ext of IMAGE_EXTENSIONS) {
		if (lower.endsWith(ext)) {
			return true;
		}
	}
	return false;
}

async function collectDirectoryImages(dirHandle, includeSubdirectories, relativePath = "") {
	const results = [];
	for await (const [entryName, entry] of dirHandle.entries()) {
		const nextRelative = relativePath ? `${relativePath}/${entryName}` : entryName;
		if (entry.kind === "file" && isImageName(entryName)) {
			results.push({
				handle: entry,
				dirHandle,
				relativePath: nextRelative,
				name: entryName,
			});
			continue;
		}
		if (entry.kind === "directory" && includeSubdirectories) {
			const nested = await collectDirectoryImages(entry, includeSubdirectories, nextRelative);
			results.push(...nested);
		}
	}
	return results.sort((a, b) => String(a.relativePath).localeCompare(String(b.relativePath), "zh-Hans-CN"));
}

async function fileExists(dirHandle, filename) {
	try {
		await dirHandle.getFileHandle(filename);
		return true;
	} catch (error) {
		return false;
	}
}

async function writeTextFile(dirHandle, filename, content) {
	const handle = await dirHandle.getFileHandle(filename, { create: true });
	const writable = await handle.createWritable();
	try {
		await writable.write(String(content || ""));
	} finally {
		await writable.close();
	}
}

async function captionImage(node, file, relativePath) {
	const host = String(getWidgetValue(node, HOST_WIDGET, "http://127.0.0.1:11434") || "").trim();
	const model = String(getWidgetValue(node, MODEL_WIDGET, "") || "").trim();
	const prompt = String(getWidgetValue(node, PROMPT_WIDGET, "") || "").trim();
	const imageBase64 = base64FromArrayBuffer(await file.arrayBuffer());
	const response = await fetch(CAPTION_API_PATH, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			host,
			model,
			prompt,
			filename: fileStem(file.name || relativePath),
			image: imageBase64,
		}),
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok || !payload?.ok) {
		throw new Error(String(payload?.error || "Ollama 打标失败"));
	}
	return String(payload.caption || "").trim();
}

async function runTagging(node) {
	if (node.__gjjOllamaDirRunning) {
		return;
	}
	const dirHandle = node.__gjjOllamaDirHandle;
	if (!dirHandle) {
		setStatus(node, "请先点击“选择目录”。", "error");
		return;
	}
	if (!window.showDirectoryPicker) {
		setStatus(node, "当前浏览器不支持目录选择器，请使用新版 Edge/Chrome。", "error");
		return;
	}
	node.__gjjOllamaDirRunning = true;
	const startedAt = performance.now();
	try {
		const includeSubdirs = !!getWidgetValue(node, INCLUDE_SUBDIRS_WIDGET, true);
		const overwriteExisting = !!getWidgetValue(node, OVERWRITE_WIDGET, false);
		const files = await collectDirectoryImages(dirHandle, includeSubdirs);
		if (!files.length) {
			setStatus(node, "所选目录中没有可处理的图片。", "error");
			return;
		}

		let writtenCount = 0;
		let skippedCount = 0;
		for (let index = 0; index < files.length; index += 1) {
			const item = files[index];
			const txtName = `${fileStem(item.name)}.txt`;
			if (!overwriteExisting && await fileExists(item.dirHandle, txtName)) {
				skippedCount += 1;
				setStatus(node, `${index + 1}/${files.length} 跳过已有标注：${item.relativePath}`);
				continue;
			}

			setStatus(node, `${index + 1}/${files.length} 正在打标：${item.relativePath}`);
			const file = await item.handle.getFile();
			const caption = await captionImage(node, file, item.relativePath);
			await writeTextFile(item.dirHandle, txtName, caption);
			writtenCount += 1;
		}

		const summary = `完成：新增/覆盖 ${writtenCount} 个 txt，跳过 ${skippedCount} 个已有 txt，耗时 ${formatElapsed(performance.now() - startedAt)}`;
		setStatus(node, summary);
	} catch (error) {
		setStatus(node, error?.message || "目录打标失败", "error");
	} finally {
		node.__gjjOllamaDirRunning = false;
	}
}

async function chooseDirectory(node) {
	if (!window.showDirectoryPicker) {
		setStatus(node, "当前浏览器不支持目录选择器，请使用新版 Edge/Chrome。", "error");
		return;
	}
	try {
		const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
		node.__gjjOllamaDirHandle = dirHandle;
		setWidgetValue(node, DIRECTORY_WIDGET, dirHandle?.name || "");
		setDirectoryLabel(node, dirHandle?.name || "未选择目录");
		setStatus(node, "目录已选择，点击“开始打标”执行。");
	} catch (error) {
		if (error?.name === "AbortError") {
			return;
		}
		setStatus(node, error?.message || "选择目录失败", "error");
	}
}

function buildDom(node) {
	const container = document.createElement("div");
	container.className = "gjj-odc-panel";
	container.style.cssText = "display:flex;flex-direction:column;gap:7px;width:100%;box-sizing:border-box;padding:2px 0 4px;color:#dce6e8;font:12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-odc-panel,.gjj-odc-panel *{box-sizing:border-box}
		.gjj-odc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:0 0 3px}
		.gjj-odc-button{flex:0 0 auto;height:27px;padding:0 9px;border:1px solid #3d5159;border-radius:6px;background:#172127;color:#dbe6e9;font:700 12px/25px system-ui,sans-serif;cursor:pointer;white-space:nowrap}
		.gjj-odc-button:hover{background:#24333b;border-color:#5f8590}
		.gjj-odc-button.active{background:#24452d;border-color:#65a271;color:#ebffee}
		.gjj-odc-button:disabled{opacity:.68;cursor:wait}
		.gjj-odc-settings{display:none;flex-direction:column;gap:7px;padding:8px;border:1px solid rgba(73,93,101,.7);border-radius:8px;background:rgba(15,22,26,.88)}
		.gjj-odc-field{display:flex;flex-direction:column;gap:4px;min-width:0}
		.gjj-odc-label-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
		.gjj-odc-label{color:#aebfc4;font-weight:700;font-size:11px}
		.gjj-odc-input,.gjj-odc-textarea{width:100%;border:1px solid #334850;border-radius:6px;background:#10181c;color:#eef5f5;padding:5px 7px;outline:none;font:12px/1.4 system-ui,sans-serif}
		.gjj-odc-input{height:29px}
		.gjj-odc-textarea{min-height:82px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
		.gjj-odc-input:focus,.gjj-odc-textarea:focus{border-color:#6a9dae;background:#111e23}
		.gjj-odc-checks{display:flex;flex-wrap:wrap;gap:10px;color:#c8d5d8;font-size:12px}
		.gjj-odc-checks label{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
		.gjj-odc-path,.gjj-odc-hint,.gjj-odc-status{border:1px solid #33434a;border-radius:8px;background:#10171b;color:#cdd8d3;padding:5px 8px;font-size:11px;line-height:1.35;white-space:pre-wrap;word-break:break-all;overflow:auto}
		.gjj-odc-path{max-height:32px}
		.gjj-odc-hint{max-height:30px;border-color:transparent;background:transparent;color:#93a5ae;padding:0 2px}
		.gjj-odc-status{min-height:38px;max-height:54px;border-color:#41535b;background:#121a1f;color:#dce7e2;font-size:12px}
	`;

	const protect = (element) => {
		for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
			element.addEventListener(eventName, (event) => event.stopPropagation());
		}
		return element;
	};

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-odc-toolbar";

	const makeButton = (text) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = text;
		button.className = "gjj-odc-button";
		return protect(button);
	};

	const input = (type = "text") => {
		const element = document.createElement("input");
		element.type = type;
		element.className = "gjj-odc-input";
		return protect(element);
	};

	const field = (label, control, action = null) => {
		const wrapper = document.createElement("label");
		wrapper.className = "gjj-odc-field";
		const row = document.createElement("div");
		row.className = "gjj-odc-label-row";
		const text = document.createElement("span");
		text.className = "gjj-odc-label";
		text.textContent = label;
		row.appendChild(text);
		if (action) row.appendChild(action);
		wrapper.append(row, control);
		return wrapper;
	};

	const chooseButton = makeButton("选择目录");
	chooseButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		chooseDirectory(node);
	});

	const runButton = makeButton("开始打标");
	runButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		runTagging(node);
	});

	const refreshButton = makeButton("🔄");
	refreshButton.title = "重新读取 Ollama 模型列表";
	refreshButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshModelList(node, false);
	});

	const settingsButton = makeButton("⚙️");
	settingsButton.title = "展开 / 收起设置";
	settingsButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.__gjjOllamaDirSettingsOpen = !node.__gjjOllamaDirSettingsOpen;
		syncOllamaDirectoryPanel(node);
	});

	const settings = document.createElement("div");
	settings.className = "gjj-odc-settings";

	const hostInput = input("text");
	hostInput.addEventListener("change", () => {
		setWidgetValue(node, HOST_WIDGET, hostInput.value);
	});

	const modelSelect = document.createElement("select");
	modelSelect.className = "gjj-odc-input";
	protect(modelSelect);
	modelSelect.addEventListener("change", () => setWidgetValue(node, MODEL_WIDGET, modelSelect.value));

	const promptInput = document.createElement("textarea");
	promptInput.className = "gjj-odc-textarea";
	promptInput.placeholder = "打标提示词";
	protect(promptInput);
	promptInput.addEventListener("input", () => setWidgetValue(node, PROMPT_WIDGET, promptInput.value));

	const checks = document.createElement("div");
	checks.className = "gjj-odc-checks";
	const overwrite = input("checkbox");
	overwrite.addEventListener("change", () => setWidgetValue(node, OVERWRITE_WIDGET, overwrite.checked));
	const includeSubdirs = input("checkbox");
	includeSubdirs.addEventListener("change", () => setWidgetValue(node, INCLUDE_SUBDIRS_WIDGET, includeSubdirs.checked));
	const overwriteLabel = document.createElement("label");
	overwriteLabel.append(overwrite, "覆盖已有 txt");
	const includeLabel = document.createElement("label");
	includeLabel.append(includeSubdirs, "包含子目录");
	checks.append(overwriteLabel, includeLabel);

	settings.append(
		field("Ollama 完整地址", hostInput),
		field("Ollama 模型", modelSelect, refreshButton),
		field("打标提示词", promptInput),
		checks,
	);

	const pathLabel = document.createElement("div");
	pathLabel.className = "gjj-odc-path";
	pathLabel.textContent = "未选择目录";

	const hint = document.createElement("div");
	hint.className = "gjj-odc-hint";
	hint.textContent = "通过浏览器选择任意本地目录，逐张调用本地 Ollama，为图片生成同名 txt 标注。";

	const status = document.createElement("div");
	status.className = "gjj-odc-status";
	status.textContent = "等待执行";

	toolbar.append(chooseButton, runButton, settingsButton);
	container.append(style, toolbar, settings, pathLabel, hint, status);

	node.__gjjOllamaDirContainer = container;
	node.__gjjOllamaDirSettings = settings;
	node.__gjjOllamaDirSettingsButton = settingsButton;
	node.__gjjOllamaDirHostInput = hostInput;
	node.__gjjOllamaDirModelSelect = modelSelect;
	node.__gjjOllamaDirPromptInput = promptInput;
	node.__gjjOllamaDirOverwrite = overwrite;
	node.__gjjOllamaDirIncludeSubdirs = includeSubdirs;
	node.__gjjOllamaDirPath = pathLabel;
	node.__gjjOllamaDirStatus = status;
	return container;
}

function ensureDomWidget(node) {
	if (node.__gjjOllamaDirWidget) {
		return node.__gjjOllamaDirWidget;
	}
	const container = buildDom(node);
	const widget = node.addDOMWidget?.(DOM_WIDGET_NAME, DOM_WIDGET_NAME, container, {
		hideOnZoom: false,
		getHeight: () => measureHeight(node),
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || node?.size?.[0] || MIN_WIDTH)), measureHeight(node)];
	}
	node.__gjjOllamaDirWidget = widget;
	const index = node.widgets?.indexOf(widget) ?? -1;
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(widget);
	}
	setDirectoryLabel(node, String(getWidgetValue(node, DIRECTORY_WIDGET, "") || "").trim(), false);
	setStatus(node, String(getWidgetValue(node, SUMMARY_WIDGET, "等待执行") || "等待执行"), "normal", false);
	syncOllamaDirectoryPanel(node);
	return widget;
}

function patchNode(node) {
	if (!node || node.__gjjOllamaDirPatched) {
		return;
	}
	for (const [name, label] of [
		[HOST_WIDGET, "Ollama 完整地址"],
		[MODEL_WIDGET, "Ollama 模型"],
		[PROMPT_WIDGET, "打标提示词"],
		[OVERWRITE_WIDGET, "覆盖已有 txt"],
		[INCLUDE_SUBDIRS_WIDGET, "包含子目录"],
		[DIRECTORY_WIDGET, "已选目录"],
		[SUMMARY_WIDGET, "最近结果"],
	]) {
		setWidgetLabel(node, name, label);
	}
	node.__gjjOllamaDirPatched = true;
	hideBackendWidgets(node);
	ensureDomWidget(node);
	setDirectoryLabel(node, String(getWidgetValue(node, DIRECTORY_WIDGET, "") || "").trim(), false);
	setStatus(node, String(getWidgetValue(node, SUMMARY_WIDGET, "等待执行") || "等待执行"), "normal", false);
	syncOllamaDirectoryPanel(node);
	refreshModelList(node, true);
	resizeNode(node, 40);
	resizeNode(node, 240);
	resizeNode(node, 700);

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = originalOnConfigure?.apply(this, args);
		hideBackendWidgets(this);
		ensureDomWidget(this);
		setDirectoryLabel(this, String(getWidgetValue(this, DIRECTORY_WIDGET, "") || "").trim(), false);
		setStatus(this, String(getWidgetValue(this, SUMMARY_WIDGET, "等待执行") || "等待执行"), "normal", false);
		syncOllamaDirectoryPanel(this);
		refreshModelList(this, true);
		resizeNode(this, 40);
		resizeNode(this, 240);
		return result;
	};

	const hostWidget = getWidget(node, HOST_WIDGET);
	if (hostWidget && !hostWidget.__gjjRefreshPatched) {
		hostWidget.__gjjRefreshPatched = true;
		const originalCallback = hostWidget.callback;
		hostWidget.callback = function (value, ...args) {
			const result = originalCallback?.call(this, value, ...args);
			syncOllamaDirectoryPanel(node);
			refreshModelList(node, false);
			return result;
		};
	}

	const originalOnResize = node.onResize;
	node.onResize = function (...args) {
		const result = originalOnResize?.apply(this, args);
		scheduleLayout(this);
		return result;
	};
}

function stabilize(node) {
	if (!node || !TARGET_NODES.has(String(node.comfyClass || node.type || ""))) return;
	patchNode(node);
	hideBackendWidgets(node);
	ensureDomWidget(node);
	setDirectoryLabel(node, String(getWidgetValue(node, DIRECTORY_WIDGET, "") || "").trim(), false);
	setStatus(node, String(getWidgetValue(node, SUMMARY_WIDGET, "等待执行") || "等待执行"), "normal", false);
	syncOllamaDirectoryPanel(node);
	resizeNode(node, 40);
	resizeNode(node, 240);
	resizeNode(node, 700);
}

function schedule(node, delay = 0) {
	setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.OllamaDirectoryCaptioner",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this);
			schedule(this, 100);
			schedule(this, 1000);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			schedule(this);
			schedule(this, 100);
			schedule(this, 1000);
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			schedule(this);
			return result;
		};
	},
	nodeCreated(node) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			schedule(node);
			schedule(node, 100);
		}
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				schedule(node);
				schedule(node, 100);
				schedule(node, 1000);
			}
		}
	},
});

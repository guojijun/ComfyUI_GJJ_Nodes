import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_OllamaDirectoryCaptioner"]);
const DOM_WIDGET_NAME = "gjj_ollama_directory_captioner_dom";
const MIN_WIDTH = 360;
const PANEL_HEIGHT = 176;
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

function hideWidget(widget) {
	if (!widget || widget.__gjjHidden) {
		return;
	}
	widget.__gjjHidden = true;
	widget.__gjjOriginalType = widget.type;
	widget.__gjjOriginalComputeSize = widget.computeSize;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.hidden = true;
	widget.computeSize = () => [0, -4];
	widget.draw = () => {};
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
	if (widget.element) {
		widget.element.style.display = "none";
	}
}

function hideInternalWidgets(node) {
	hideWidget(getWidget(node, DIRECTORY_WIDGET));
	hideWidget(getWidget(node, SUMMARY_WIDGET));
}

function measureHeight(node) {
	return PANEL_HEIGHT;
}

function getTopOffset(node) {
	const widget = node?.__gjjOllamaDirWidget;
	const candidates = [
		Number(widget?.y || 0),
		Number(widget?.last_y || 0),
		Number(node?.widgets_start_y || 0),
	];
	return Math.max(0, ...candidates);
}

function refreshLayout(node) {
	const width = Math.max(MIN_WIDTH, Number(node?.size?.[0] || MIN_WIDTH));
	const height = Math.max(PANEL_HEIGHT + 20, Math.ceil(getTopOffset(node) + measureHeight(node) + 12));
	node.setSize?.([width, height]);
	requestRedraw(node);
}

function scheduleLayout(node) {
	if (!node || node.__gjjOllamaDirLayoutQueued) {
		return;
	}
	node.__gjjOllamaDirLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjOllamaDirLayoutQueued = false;
		refreshLayout(node);
	});
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
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"width:100%",
		"box-sizing:border-box",
		"padding-top:4px",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

	const makeButton = (text) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = text;
		button.style.cssText = [
			"height:24px",
			"padding:0 10px",
			"border:1px solid #465761",
			"border-radius:6px",
			"background:#1a2328",
			"color:#dce7e2",
			"font-size:11px",
			"cursor:pointer",
		].join(";");
		return button;
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

	const pathLabel = document.createElement("div");
	pathLabel.textContent = "未选择目录";
	pathLabel.style.cssText = [
		"padding:6px 10px",
		"border:1px solid #33434a",
		"border-radius:10px",
		"background:#10171b",
		"color:#cdd8d3",
		"font-size:11px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-all",
		"max-height:34px",
		"overflow:auto",
	].join(";");

	const hint = document.createElement("div");
	hint.textContent = "通过浏览器选择任意本地目录，逐张调用本地 Ollama，为图片生成同名 txt 标注。";
	hint.style.cssText = "font-size:11px;color:#93a5ae;line-height:1.4;max-height:30px;overflow:auto;";

	const status = document.createElement("div");
	status.textContent = "等待执行";
	status.style.cssText = [
		"min-height:42px",
		"max-height:56px",
		"overflow:auto",
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:10px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.4",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");

	toolbar.appendChild(chooseButton);
	toolbar.appendChild(runButton);
	container.appendChild(toolbar);
	container.appendChild(pathLabel);
	container.appendChild(hint);
	container.appendChild(status);

	node.__gjjOllamaDirContainer = container;
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
		getHeight: () => PANEL_HEIGHT,
	});
	if (widget) {
		widget.computeSize = () => [Math.max(MIN_WIDTH, Number(node?.size?.[0] || MIN_WIDTH)), PANEL_HEIGHT];
	}
	node.__gjjOllamaDirWidget = widget;
	setDirectoryLabel(node, String(getWidgetValue(node, DIRECTORY_WIDGET, "") || "").trim(), false);
	setStatus(node, String(getWidgetValue(node, SUMMARY_WIDGET, "等待执行") || "等待执行"), "normal", false);
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
	hideInternalWidgets(node);
	ensureDomWidget(node);
	setDirectoryLabel(node, String(getWidgetValue(node, DIRECTORY_WIDGET, "") || "").trim(), false);
	setStatus(node, String(getWidgetValue(node, SUMMARY_WIDGET, "等待执行") || "等待执行"), "normal", false);
	refreshModelList(node, true);
	requestAnimationFrame(() => scheduleLayout(node));

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = originalOnConfigure?.apply(this, args);
		hideInternalWidgets(this);
		ensureDomWidget(this);
		setDirectoryLabel(this, String(getWidgetValue(this, DIRECTORY_WIDGET, "") || "").trim(), false);
		setStatus(this, String(getWidgetValue(this, SUMMARY_WIDGET, "等待执行") || "等待执行"), "normal", false);
		refreshModelList(this, true);
		requestAnimationFrame(() => scheduleLayout(this));
		return result;
	};

	const hostWidget = getWidget(node, HOST_WIDGET);
	if (hostWidget && !hostWidget.__gjjRefreshPatched) {
		hostWidget.__gjjRefreshPatched = true;
		const originalCallback = hostWidget.callback;
		hostWidget.callback = function (value, ...args) {
			const result = originalCallback?.call(this, value, ...args);
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

app.registerExtension({
	name: "GJJ.OllamaDirectoryCaptioner",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};
	},
});

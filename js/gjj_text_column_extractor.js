import { app } from "/scripts/app.js";

const TARGET = "GJJ_TextColumnExtractor";
const TOOLBAR_WIDGET = "gjj_text_column_toolbar";
const HIDDEN_WIDGETS = ["delimiter", "skip_empty_lines", "trim_content", "line_delimiter"];
const SHOW_COUNT_PROPERTY = "gjj_show_count_output";
const COLUMN_PROPERTY = "gjj_output_column";
const MIN_NODE_WIDTH = 220;
const MIN_NODE_HEIGHT = 120;

function findWidget(node, name) {
	return (node.widgets || []).find((widget) => widget?.name === name);
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) return;
	widget.value = value;
	widget.callback?.(value);
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
}

function normalizeColumn(value) {
	const number = Number.parseInt(value, 10);
	return Number.isFinite(number) ? Math.min(128, Math.max(1, number)) : 2;
}

function restoreColumn(node, serializedNode) {
	const propertyValue = serializedNode?.properties?.[COLUMN_PROPERTY];
	const legacyValue = Array.isArray(serializedNode?.widgets_values)
		? serializedNode.widgets_values[1]
		: undefined;
	const savedValue = propertyValue ?? legacyValue;
	const widget = findWidget(node, "column");
	if (widget) widget.value = normalizeColumn(savedValue);
}

function restoreRequiredDefaults(node) {
	const column = findWidget(node, "column");
	if (column) column.value = normalizeColumn(column.value);
	const delimiter = findWidget(node, "delimiter");
	if (delimiter && !String(delimiter.value ?? "").length) delimiter.value = "||";
}

function hideWidget(widget) {
	if (!widget || widget.__gjjColumnHidden) return;
	widget.__gjjColumnHidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.hidden = true;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.label = "";
	widget.size = [0, -4];
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function button(icon, title) {
	const element = document.createElement("button");
	element.type = "button";
	element.textContent = icon;
	element.title = title;
	element.style.cssText = [
		"width:30px",
		"height:26px",
		"padding:0",
		"border:1px solid #465861",
		"border-radius:6px",
		"background:#1b252b",
		"color:#dce7e2",
		"font-size:14px",
		"cursor:pointer",
	].join(";");
	return element;
}

function styleToggle(element, enabled) {
	element.style.background = enabled ? "#214536" : "#1b252b";
	element.style.borderColor = enabled ? "#75d59b" : "#465861";
	element.style.color = enabled ? "#baffcf" : "#dce7e2";
}

function setCountOutputVisible(node) {
	const output = node.outputs?.[1];
	if (!output) return;
	node.properties = node.properties || {};
	node.properties[SHOW_COUNT_PROPERTY] = true;
	output.hidden = false;
	output.visible = true;
	output.disabled = false;
	output.not_show = false;
	output.__gjj_hidden = false;
	output.options = { ...(output.options || {}), hidden: false };
	if (typeof node.hideOutput === "function") {
		try {
			node.hideOutput(1, false);
		} catch (_) {}
	}
	if (node.__gjjColumnToolbar?.ports) {
		styleToggle(node.__gjjColumnToolbar.ports, true);
		node.__gjjColumnToolbar.ports.title = "🔌 有效行数输出口：始终显示";
	}
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
}

function fitMinimumSize(node) {
	requestAnimationFrame(() => {
		const computed = node.computeSize?.();
		const height = Array.isArray(computed)
			? Math.max(MIN_NODE_HEIGHT, Number(computed[1]) || MIN_NODE_HEIGHT)
			: MIN_NODE_HEIGHT;
		node.setSize?.([MIN_NODE_WIDTH, height]);
		node.setDirtyCanvas?.(true, true);
	});
}

function closeSettings(node) {
	node.__gjjColumnSettings?.remove?.();
	delete node.__gjjColumnSettings;
	if (node.__gjjColumnOutside) {
		document.removeEventListener("pointerdown", node.__gjjColumnOutside, true);
		delete node.__gjjColumnOutside;
	}
}

function settingsField(labelText, value, tooltip) {
	const label = document.createElement("label");
	label.style.cssText = "display:grid;grid-template-columns:78px 1fr;align-items:center;gap:8px;margin-top:8px;";
	const caption = document.createElement("span");
	caption.textContent = labelText;
	caption.title = tooltip;
	caption.style.color = "#a9bbc2";
	const input = document.createElement("input");
	input.type = "text";
	input.value = value;
	input.title = tooltip;
	input.style.cssText = "width:150px;height:27px;box-sizing:border-box;padding:3px 7px;border:1px solid #465861;border-radius:5px;background:#0c1419;color:#e4f1f4;";
	label.append(caption, input);
	return { label, input };
}

function openSettings(node, anchor) {
	closeSettings(node);
	const panel = document.createElement("div");
	panel.style.cssText = "position:fixed;z-index:100000;padding:11px;min-width:250px;border:1px solid #52666f;border-radius:8px;background:#10191f;color:#dce7e2;box-shadow:0 12px 34px rgba(0,0,0,.46);font:12px system-ui,'Microsoft YaHei',sans-serif;";
	const title = document.createElement("div");
	title.textContent = "⚙️ 分隔符设置";
	title.style.cssText = "font-weight:700;color:#eef8f5;margin-bottom:3px;";
	const column = settingsField("列分隔符", String(findWidget(node, "delimiter")?.value ?? "||"), "用于拆分每条输入记录，默认为 ||。");
	const line = settingsField("行分隔符", String(findWidget(node, "line_delimiter")?.value ?? "---"), "插入到每条输出之间并独占一行，默认为 ---；留空则只换行。");
	const hint = document.createElement("div");
	hint.textContent = "修改后会随工作流保存。";
	hint.style.cssText = "margin-top:9px;color:#7f969e;";
	panel.append(title, column.label, line.label, hint);
	document.body.appendChild(panel);

	const apply = () => {
		setWidgetValue(node, "delimiter", column.input.value);
		setWidgetValue(node, "line_delimiter", line.input.value);
	};
	column.input.addEventListener("input", apply);
	line.input.addEventListener("input", apply);

	const rect = anchor.getBoundingClientRect();
	panel.style.left = `${Math.min(window.innerWidth - panel.offsetWidth - 8, Math.max(8, rect.left))}px`;
	panel.style.top = `${Math.min(window.innerHeight - panel.offsetHeight - 8, rect.bottom + 6)}px`;
	node.__gjjColumnSettings = panel;
	node.__gjjColumnOutside = (event) => {
		if (panel.contains(event.target) || anchor.contains(event.target)) return;
		closeSettings(node);
	};
	setTimeout(() => document.addEventListener("pointerdown", node.__gjjColumnOutside, true), 0);
	column.input.focus();
	column.input.select();
}

function syncButtons(node) {
	const toolbar = node.__gjjColumnToolbar;
	if (!toolbar) return;
	const skip = Boolean(findWidget(node, "skip_empty_lines")?.value);
	const trim = Boolean(findWidget(node, "trim_content")?.value);
	styleToggle(toolbar.skip, skip);
	styleToggle(toolbar.trim, trim);
	styleToggle(toolbar.ports, true);
	toolbar.skip.title = `🧹 跳过空行/空内容：${skip ? "已开启" : "已关闭"}`;
	toolbar.trim.title = `✂️ 去除内容首尾空白：${trim ? "已开启" : "已关闭"}`;
	toolbar.ports.title = "🔌 有效行数输出口：始终显示";
}

function ensureToolbar(node) {
	for (const name of HIDDEN_WIDGETS) hideWidget(findWidget(node, name));
	restoreRequiredDefaults(node);
	if (node.__gjjColumnToolbarWidget) {
		syncButtons(node);
		return;
	}

	const root = document.createElement("div");
	root.style.cssText = "display:flex;align-items:center;gap:6px;width:100%;padding:2px 0;box-sizing:border-box;";
	const skip = button("🧹", "跳过空行/空内容");
	const trim = button("✂️", "去除内容首尾空白");
	const ports = button("🔌", "有效行数输出口始终显示");
	const gear = button("⚙️", "设置列分隔符和行分隔符");
	root.append(skip, trim, ports, gear);
	root.addEventListener("pointerdown", (event) => event.stopPropagation());

	skip.onclick = () => {
		setWidgetValue(node, "skip_empty_lines", !Boolean(findWidget(node, "skip_empty_lines")?.value));
		syncButtons(node);
	};
	trim.onclick = () => {
		setWidgetValue(node, "trim_content", !Boolean(findWidget(node, "trim_content")?.value));
		syncButtons(node);
	};
	ports.onclick = () => {
		setCountOutputVisible(node);
		syncButtons(node);
	};
	gear.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (node.__gjjColumnSettings) closeSettings(node);
		else openSettings(node, gear);
	};

	const toolbarWidget = node.addDOMWidget?.(TOOLBAR_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 34,
	});
	if (!toolbarWidget) return;
	node.__gjjColumnToolbar = { root, skip, trim, ports, gear };
	node.__gjjColumnToolbarWidget = toolbarWidget;

	setCountOutputVisible(node);
	syncButtons(node);
	fitMinimumSize(node);
}

app.registerExtension({
	name: "Comfy.GJJ.TextColumnExtractor",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => ensureToolbar(this), 0);
			return result;
		};
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			setTimeout(() => {
				restoreColumn(this, serializedNode);
				restoreRequiredDefaults(this);
				ensureToolbar(this);
				setCountOutputVisible(this);
				syncButtons(this);
				fitMinimumSize(this);
			}, 0);
			return result;
		};
		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			restoreRequiredDefaults(this);
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			const column = normalizeColumn(findWidget(this, "column")?.value);
			this.properties = this.properties || {};
			this.properties[COLUMN_PROPERTY] = column;
			serializedNode.properties = {
				...(serializedNode.properties || {}),
				[COLUMN_PROPERTY]: column,
			};
			return result;
		};
		const originalRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			closeSettings(this);
			return originalRemoved?.apply(this, args);
		};
	},
	async nodeCreated(node) {
		if (node?.comfyClass === TARGET) setTimeout(() => ensureToolbar(node), 0);
	},
});

import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const 节点配置 = {
	GJJ_ReduxAdvanced: {
		标题: "Redux高级条件设置",
		字段: ["引导强度", "下采样倍率", "下采样算法", "图像处理模式", "图像条件权重", "自动裁剪边距"],
		模型项: [
			{ widget: "风格模型", label: "Redux风格模型", folder: "models/style_models", icon: "🟣" },
			{ widget: "视觉模型", label: "CLIP视觉模型", folder: "models/clip_vision", icon: "🔵" },
		],
	},
	GJJ_IPAdapter: {
		标题: "图像适配器设置",
		字段: ["预设", "权重", "开始位置", "结束位置", "权重模式"],
	},
};

function 控件(node, name) {
	return GJJ_Utils.getWidget?.(node, name) || node?.widgets?.find((item) => item?.name === name);
}

function 隐藏后端控件(widget) {
	if (!widget) return;
	widget.__gjjUtilsHidden = true;
	widget.hidden = true;
	widget.disabled = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0 });
	widget.draw = () => {};
	widget.drawWidget = () => {};
	widget.mouse = () => false;
	widget.label = "";
	widget.localized_name = "";
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	for (const element of [widget.widget, widget.element, widget.inputEl]) {
		if (!element?.style) continue;
		element.style.display = "none";
		element.style.height = "0";
		element.style.margin = "0";
		element.style.padding = "0";
	}
}

function 设置控件值(node, widget, value) {
	if (!widget) return;
	let next = value;
	if (typeof widget.value === "number") next = Number(value);
	widget.value = next;
	const index = node.widgets?.indexOf(widget) ?? -1;
	if (Array.isArray(node.widgets_values) && index >= 0) node.widgets_values[index] = next;
	try { widget.callback?.(next); } catch (_) {}
	node.graph && (node.graph._version += 1);
	app.graph?.setDirtyCanvas?.(true, true);
}

function 选项(widget) {
	const values = widget?.options?.values || widget?.options?.comboValues || widget?.values || [];
	return Array.isArray(values) ? values : [];
}

function 创建输入(node, widget) {
	const values = 选项(widget);
	let input;
	if (values.length) {
		input = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			input.appendChild(option);
		}
		input.value = String(widget.value ?? values[0] ?? "");
	} else {
		input = document.createElement("input");
		input.type = typeof widget.value === "number" ? "number" : "text";
		input.value = String(widget.value ?? "");
		if (input.type === "number") {
			const options = widget.options || {};
			if (Number.isFinite(options.min)) input.min = String(options.min);
			if (Number.isFinite(options.max)) input.max = String(options.max);
			if (Number.isFinite(options.step)) input.step = String(options.step);
		}
	}
	input.title = String(widget.options?.tooltip || widget.tooltip || "");
	input.addEventListener("input", () => 设置控件值(node, widget, input.value));
	input.addEventListener("change", () => 设置控件值(node, widget, input.value));
	return input;
}

function 关闭浮窗(node) {
	node?.__gjj浮动设置遮罩?.remove?.();
	delete node.__gjj浮动设置遮罩;
}

function 定位到按钮下方(panel, anchor) {
	const anchorRect = anchor?.getBoundingClientRect?.();
	if (!anchorRect) return;
	const gap = 6;
	const padding = 10;
	const panelWidth = panel.getBoundingClientRect?.().width || panel.offsetWidth || 460;
	const left = Math.max(padding, Math.min(anchorRect.right - panelWidth, window.innerWidth - panelWidth - padding));
	const top = Math.max(padding, anchorRect.bottom + gap);
	panel.style.position = "fixed";
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(top)}px`;
	panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - padding)}px`;
}

function 打开浮窗(node, spec, anchor) {
	if (node.__gjj浮动设置遮罩) {
		关闭浮窗(node);
		return;
	}
	const backdrop = document.createElement("div");
	backdrop.style.cssText = "position:fixed;inset:0;z-index:100000;background:transparent;display:block;box-sizing:border-box";
	const panel = document.createElement("div");
	panel.style.cssText = "width:min(460px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;border:1px solid #52636d;border-radius:12px;background:#111a1f;color:#e8f0f2;box-shadow:0 18px 60px rgba(0,0,0,.65);padding:14px;font:12px system-ui,'Microsoft YaHei',sans-serif";
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px";
	const title = document.createElement("strong");
	title.textContent = `⚙️ ${spec.标题}`;
	title.style.cssText = "font-size:15px;color:#fff";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "关闭";
	close.title = "关闭设置窗口";
	close.style.cssText = "border:1px solid #647580;border-radius:6px;background:#25323a;color:#fff;padding:5px 12px;cursor:pointer";
	close.onclick = () => 关闭浮窗(node);
	header.append(title, close);
	panel.appendChild(header);

	for (const name of spec.字段) {
		const widget = 控件(node, name);
		if (!widget) continue;
		const row = document.createElement("label");
		row.style.cssText = "display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px;align-items:center;margin:8px 0";
		const label = document.createElement("span");
		label.textContent = name;
		label.title = String(widget.options?.tooltip || widget.tooltip || "");
		label.style.cssText = "color:#c8d4d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
		const input = 创建输入(node, widget);
		input.style.cssText = "box-sizing:border-box;width:100%;height:32px;border:1px solid #42545e;border-radius:6px;background:#202b31;color:#f2f7f8;padding:0 8px;outline:none";
		row.append(label, input);
		panel.appendChild(row);
	}

	backdrop.appendChild(panel);
	backdrop.addEventListener("pointerdown", (event) => {
		if (event.target === backdrop) 关闭浮窗(node);
	});
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) {
		panel.addEventListener(eventName, (event) => event.stopPropagation());
	}
	document.body.appendChild(backdrop);
	定位到按钮下方(panel, anchor);
	node.__gjj浮动设置遮罩 = backdrop;
}

function 打开模型树浮窗(node, spec, anchor) {
	if (node.__gjj浮动设置遮罩) {
		关闭浮窗(node);
		return;
	}
	const backdrop = document.createElement("div");
	backdrop.style.cssText = "position:fixed;inset:0;z-index:100000;background:transparent;display:block;box-sizing:border-box";
	const panel = document.createElement("div");
	panel.style.cssText = "width:min(620px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;border:1px solid #52636d;border-radius:12px;background:#111a1f;color:#e8f0f2;box-shadow:0 18px 60px rgba(0,0,0,.65);padding:14px;font:12px system-ui,'Microsoft YaHei',sans-serif";
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px";
	header.innerHTML = '<strong style="font-size:15px;color:#fff">🧠 所有模型树</strong>';
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "关闭";
	close.style.cssText = "border:1px solid #647580;border-radius:6px;background:#25323a;color:#fff;padding:5px 12px;cursor:pointer";
	close.onclick = () => 关闭浮窗(node);
	header.appendChild(close);
	panel.appendChild(header);

	const entries = (spec.模型项 || []).map((entry) => {
		const widget = 控件(node, entry.widget);
		return {
			...entry,
			fallback: String(widget?.value || "未找到默认模型"),
			defaultModel: String(widget?.value || "未找到默认模型"),
			floatingChoices: false,
			description: `${entry.label}；候选项来自 ${entry.folder}。`,
		};
	});
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries,
		refresh: () => GJJ_Utils.refreshNode?.(node),
		onApply: (_entry, value, widget) => 设置控件值(node, widget, value),
	});
	tree.style.maxHeight = "min(520px,calc(100vh - 150px))";
	panel.appendChild(tree);
	backdrop.appendChild(panel);
	backdrop.onclick = (event) => { if (event.target === backdrop) 关闭浮窗(node); };
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) panel.addEventListener(eventName, (event) => event.stopPropagation());
	document.body.appendChild(backdrop);
	定位到按钮下方(panel, anchor);
	node.__gjj浮动设置遮罩 = backdrop;
}

function 刷新(node, spec) {
	for (const name of spec.字段) 隐藏后端控件(控件(node, name));
	GJJ_Utils.removeHiddenInputSockets?.(node, new Set(spec.字段));
	GJJ_Utils.refreshNode?.(node, { minWidth: 260, minHeight: 100 });
	app.graph?.setDirtyCanvas?.(true, true);
}

function 安装(node, spec) {
	if (!node.__gjj浮动设置按钮 && typeof node.addDOMWidget === "function") {
		const bar = document.createElement("div");
		bar.style.cssText = "box-sizing:border-box;width:100%;height:32px;display:flex;gap:5px;align-items:center;justify-content:flex-end;padding:0 2px";
		const makeButton = (text, title, action) => {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = text;
			button.title = title;
			button.style.setProperty("width", "32px", "important");
			button.style.setProperty("min-width", "32px", "important");
			button.style.setProperty("max-width", "32px", "important");
			button.style.setProperty("height", "28px", "important");
			button.style.setProperty("flex", "0 0 32px", "important");
			button.style.cssText += ";padding:0;border:1px solid #465862;border-radius:6px;background:#202a30;color:#e8f0f2;font-weight:700;cursor:pointer;font-size:13px";
			button.onclick = action;
			return button;
		};
		if (spec.模型项?.length) {
			const modelButton = makeButton("🧠", "按模型树查看和选择全部相关模型。", () => 打开模型树浮窗(node, spec, modelButton));
			bar.appendChild(modelButton);
		}
		const settingsButton = makeButton("⚙️", "在独立浮动窗口中调整全部参数。", () => 打开浮窗(node, spec, settingsButton));
		bar.appendChild(settingsButton);
		const toolbar = node.addDOMWidget("gjj_模型设置工具栏", "工具栏", bar, { serialize: false, hideOnZoom: false });
		toolbar.serialize = false;
		toolbar.computeSize = (width) => [Math.max(220, Number(width || node.size?.[0] || 260)), 32];
		node.__gjj浮动设置按钮 = toolbar;
	}
	刷新(node, spec);
}

function 延迟安装(node, spec) {
	for (const delay of [0, 40, 120, 300]) setTimeout(() => 安装(node, spec), delay);
}

app.registerExtension({
	name: "GJJ.浮动参数设置",
	beforeRegisterNodeDef(nodeType, nodeData) {
		const spec = 节点配置[nodeData?.name];
		if (!spec) return;
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalCreated?.apply(this, arguments);
			延迟安装(this, spec);
			return result;
		};
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const result = originalConfigure?.apply(this, arguments);
			延迟安装(this, spec);
			return result;
		};
		const originalRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function () {
			关闭浮窗(this);
			return originalRemoved?.apply(this, arguments);
		};
	},
});

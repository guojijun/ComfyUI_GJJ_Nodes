import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_PatchSageAttentionKJ"]);
const PANEL_WIDGET = "gjj_patch_sage_attention_settings";
const MODE_WIDGET = "sage_attention";
const COMPILE_WIDGET = "allow_compile";

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function comboValues(widget) {
	const values = widget?.options?.values || widget?.options?.comboValues || widget?.values || [];
	return Array.isArray(values) ? values.map(String) : [];
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	widget.value = value;
	widget.callback?.(value);
	if (widget.inputEl && "value" in widget.inputEl) widget.inputEl.value = value;
	if (widget.element && "value" in widget.element) widget.element.value = value;
}

function hideWidget(widget) {
	if (!widget) return;
	widget.hidden = true;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.label = "";
	widget.serialize = true;
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
}

function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation(), { passive: eventName !== "wheel" });
	}
}

function buildPanel(node) {
	const root = document.createElement("div");
	root.className = "gjj-sage-patch-panel";
	root.style.cssText = "width:100%;box-sizing:border-box;display:flex;align-items:center;gap:7px;pointer-events:auto;padding:0;";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-sage-patch-panel * { box-sizing:border-box; }
		.gjj-sage-patch-select {
			flex:1 1 auto; min-width:0; height:28px; border:1px solid #33464e; border-radius:6px;
			background:#111b20; color:#d9e7ea; padding:0 8px; font-size:12px; outline:none;
		}
		.gjj-sage-patch-btn {
			flex:0 0 auto; height:28px; min-width:92px; border:1px solid #33464e; border-radius:6px;
			background:#22292d; color:#d9e7ea; font-size:12px; font-weight:700; cursor:pointer;
		}
		.gjj-sage-patch-btn[data-on="true"] { border-color:#4f8f7a; background:#193b32; color:#e3fff0; }
	`;

	const modeWidget = getWidget(node, MODE_WIDGET);
	const compileWidget = getWidget(node, COMPILE_WIDGET);

	const select = document.createElement("select");
	select.className = "gjj-sage-patch-select";
	select.title = "选择 SageAttention 后端模式";
	for (const value of comboValues(modeWidget)) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		select.appendChild(option);
	}
	select.value = String(modeWidget?.value ?? "关闭");
	select.addEventListener("change", () => setWidgetValue(modeWidget, select.value));
	protect(select);

	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-sage-patch-btn";
	button.title = "允许 SageAttention 函数参与 torch.compile；通常保持关闭更稳。";
	const syncButton = () => {
		const on = compileWidget?.value === true || String(compileWidget?.value).toLowerCase() === "true";
		button.dataset.on = on ? "true" : "false";
		button.textContent = on ? "编译 开" : "编译 关";
	};
	button.addEventListener("click", () => {
		const on = !(compileWidget?.value === true || String(compileWidget?.value).toLowerCase() === "true");
		setWidgetValue(compileWidget, on);
		syncButton();
	});
	protect(button);
	syncButton();

	root.append(style, select, button);
	node.__gjjPatchSagePanelSelect = select;
	node.__gjjPatchSagePanelButtonSync = syncButton;
	return root;
}

function ensurePanel(node) {
	if (!node || node.__gjjPatchSagePanelWidget || typeof node.addDOMWidget !== "function") return;
	const root = buildPanel(node);
	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	if (widget) {
		widget.computeSize = (width) => [Number(width || node.size?.[0] || 260), 32];
		node.__gjjPatchSagePanelWidget = widget;
	}
}

function stabilize(node) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	hideWidget(getWidget(node, MODE_WIDGET));
	hideWidget(getWidget(node, COMPILE_WIDGET));
	ensurePanel(node);
	if (node.__gjjPatchSagePanelSelect) node.__gjjPatchSagePanelSelect.value = String(getWidget(node, MODE_WIDGET)?.value ?? "关闭");
	node.__gjjPatchSagePanelButtonSync?.();
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: 260, minHeight: 120 });
}

function schedule(node, ms = 0) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) return;
	clearTimeout(node.__gjjPatchSageTimer);
	node.__gjjPatchSageTimer = setTimeout(() => stabilize(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.PatchSageAttentionKJ",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			schedule(this, 0);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			schedule(this, 0);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) schedule(node, 0);
		}
	},
});

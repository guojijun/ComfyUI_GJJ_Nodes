import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_WanVideoTorchCompileSettings";
const PANEL_WIDGET = "gjj_wanvideo_torch_compile_buttons";
const BROADCAST_PROPERTY = "gjj_variable_broadcast_enabled";
const BROADCAST_USER_SET_PROPERTY = "gjj_variable_broadcast_user_set";

const BOOLEAN_FIELDS = [
	{
		name: "fullgraph",
		label: "完整图",
		title: "对应 torch.compile 的 fullgraph。开启后要求整段图可被编译，失败概率也更高。",
	},
	{
		name: "dynamic",
		label: "动态形状",
		title: "对应 torch.compile 的 dynamic。开启后允许动态形状图，但可能影响速度或兼容性。",
	},
	{
		name: "compile_transformer_blocks_only",
		label: "仅Transformer",
		title: "只编译 transformer blocks。通常更稳，首次编译也更短。",
	},
	{
		name: "force_parameter_static_shapes",
		label: "参数静态",
		title: "对应 torch._dynamo.config.force_parameter_static_shapes。",
	},
	{
		name: "allow_unmerged_lora_compile",
		label: "未合并LoRA",
		title: "允许把未合并 LoRA 的应用过程纳入 torch.compile。",
	},
];

function getWidget(node, name) {
	return (node?.widgets || []).find((widget) => widget?.name === name);
}

function asBool(value) {
	return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function markDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function writeWidgetValue(node, widget, value) {
	if (!widget) return;
	const next = Boolean(value);
	widget.value = next;
	widget.callback?.(next);
	const index = Array.isArray(node?.widgets) ? node.widgets.indexOf(widget) : -1;
	if (index >= 0) {
		node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
		node.widgets_values[index] = next;
	}
}

function hideWidget(widget) {
	if (!widget) return;
	if (!widget.__gjjTorchCompileOriginals) {
		widget.__gjjTorchCompileOriginals = {
			type: widget.type,
			draw: widget.draw,
			computeSize: widget.computeSize,
			getHeight: widget.getHeight,
			mouse: widget.mouse,
			y: widget.y,
			last_y: widget.last_y,
		};
	}
	widget.hidden = true;
	widget.disabled = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden" };
	widget.serialize = true;
	widget.forceInput = false;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.y = -10000;
	widget.last_y = -10000;
	widget.computedHeight = 0;
	widget.size = [0, 0];
	for (const element of [widget.element, widget.inputEl, widget.widget]) {
		if (!element?.style) continue;
		element.style.display = "none";
		element.style.height = "0";
		element.style.margin = "0";
		element.style.padding = "0";
	}
}

function hideBooleanWidgets(node) {
	for (const field of BOOLEAN_FIELDS) {
		hideWidget(getWidget(node, field.name));
	}
}

function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	element.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
}

function broadcastEnabled(node) {
	return Boolean(node?.properties?.[BROADCAST_PROPERTY]);
}

function notifyBroadcastChanged(node) {
	markDirty(node);
	try {
		window.dispatchEvent(new CustomEvent("gjj-variable-broadcast-updated", {
			detail: { nodeId: node?.id, enabled: broadcastEnabled(node) },
		}));
	} catch (_) {}
}

function setBroadcastEnabled(node, enabled, userSet = true) {
	node.properties = node.properties || {};
	if (userSet) node.properties[BROADCAST_USER_SET_PROPERTY] = true;
	node.properties[BROADCAST_PROPERTY] = Boolean(enabled);
	updateBroadcastButton(node);
	notifyBroadcastChanged(node);
}

function ensureDefaultBroadcast(node) {
	node.properties = node.properties || {};
	if (node.properties[BROADCAST_PROPERTY] === undefined) {
		node.properties[BROADCAST_PROPERTY] = false;
	}
}

function updateBroadcastButton(node) {
	const button = node?.__gjjWanCompileBroadcastButton;
	if (!button) return;
	const enabled = broadcastEnabled(node);
	button.dataset.value = enabled ? "true" : "false";
	button.classList.toggle("on", enabled);
	button.setAttribute("aria-pressed", String(enabled));
	button.title = enabled
		? "⚡ 已开启：提交工作流时广播到未真实连接的 WANCOMPILEARGS 输入口。"
		: "⚡ 已关闭：只通过真实连线传递 WANCOMPILEARGS。";
}

function updateButtonState(node, name) {
	const button = node?.__gjjWanCompileButtons?.get(name);
	const widget = getWidget(node, name);
	if (!button || !widget) return;
	const enabled = asBool(widget.value);
	button.dataset.value = enabled ? "true" : "false";
	button.classList.toggle("on", enabled);
	button.setAttribute("aria-pressed", String(enabled));
}

function syncButtons(node) {
	hideBooleanWidgets(node);
	for (const field of BOOLEAN_FIELDS) {
		updateButtonState(node, field.name);
	}
	updateBroadcastButton(node);
	refreshNode(node);
}

function toggleField(node, name) {
	const widget = getWidget(node, name);
	if (!widget) return;
	writeWidgetValue(node, widget, !asBool(widget.value));
	updateButtonState(node, name);
	markDirty(node);
}

function ensureOutputMetadata(node) {
	const output = node?.outputs?.[0];
	if (!output) return;
	output.type = "WANCOMPILEARGS";
	output.name = output.name || "Torch编译参数";
	output.label = output.label || "Torch编译参数";
	output.localized_name = output.localized_name || "Torch编译参数";
	output.gjj_slot_id = "wan_compile_args";
	output.gjj_output_kind = "wan_compile_args";
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function panelHeight(node) {
	const root = node?.__gjjWanCompilePanel;
	if (!root) return 36;
	return Math.max(32, Math.ceil(root.scrollHeight || root.offsetHeight || 36));
}

function refreshNode(node) {
	if (!node || !node.__gjjWanCompilePanelWidget) return;
	requestAnimationFrame(() => {
		const width = Math.round(Number(node.size?.[0] || 0) || 320);
		let height = 84;
		for (const widget of node.widgets || []) {
			if (widget?.hidden) continue;
			let widgetHeight = widget === node.__gjjWanCompilePanelWidget ? panelHeight(node) : 28;
			try {
				const size = widget.computeSize?.(width);
				if (Array.isArray(size) && Number.isFinite(size[1])) {
					widgetHeight = Math.max(widgetHeight, Number(size[1]));
				}
			} catch (_) {}
			height += Math.max(22, Math.ceil(widgetHeight)) + 4;
		}
		height = Math.max(136, Math.round(height));
		if (node.setSize && Number.isFinite(width) && Number.isFinite(height)) {
			node.setSize([width, height]);
		}
		markDirty(node);
	});
}

function createPanel(node) {
	if (!node || node.__gjjWanCompilePanelWidget || typeof node.addDOMWidget !== "function") return;
	ensureDefaultBroadcast(node);
	ensureOutputMetadata(node);

	const root = document.createElement("div");
	root.className = "gjj-wancompile-panel";
	protect(root);

	const row = document.createElement("div");
	row.className = "gjj-wancompile-row";
	root.appendChild(row);

	node.__gjjWanCompileButtons = new Map();
	for (const field of BOOLEAN_FIELDS) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-wancompile-toggle";
		button.textContent = field.label;
		button.title = field.title;
		button.setAttribute("aria-label", field.label);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleField(node, field.name);
			refreshNode(node);
		});
		node.__gjjWanCompileButtons.set(field.name, button);
		row.appendChild(button);
	}

	const broadcast = document.createElement("button");
	broadcast.type = "button";
	broadcast.className = "gjj-wancompile-broadcast";
	broadcast.textContent = "⚡";
	broadcast.setAttribute("aria-label", "切换 WANCOMPILEARGS 广播");
	broadcast.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setBroadcastEnabled(node, !broadcastEnabled(node), true);
		refreshNode(node);
	});
	node.__gjjWanCompileBroadcastButton = broadcast;
	row.appendChild(broadcast);

	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	widget.serialize = false;
	widget.options = { ...(widget.options || {}), serialize: false };
	widget.value = undefined;
	widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 320)), panelHeight(node)];
	widget.getHeight = () => panelHeight(node);
	node.__gjjWanCompilePanel = root;
	node.__gjjWanCompilePanelWidget = widget;
	syncButtons(node);
}

function ensureStyles() {
	if (document.getElementById("gjj-wancompile-settings-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-wancompile-settings-style";
	style.textContent = `
		.gjj-wancompile-panel {
			box-sizing: border-box;
			width: 100%;
			padding: 5px 0 2px;
			font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}
		.gjj-wancompile-row {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 6px;
			width: 100%;
			min-width: 0;
		}
		.gjj-wancompile-toggle,
		.gjj-wancompile-broadcast {
			box-sizing: border-box;
			height: 24px;
			border: 1px solid #41535b;
			border-radius: 6px;
			background: #1b252b;
			color: #d7e1e4;
			cursor: pointer;
			font: 700 12px/20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			letter-spacing: 0;
			text-align: center;
			white-space: nowrap;
		}
		.gjj-wancompile-toggle {
			flex: 1 1 96px;
			min-width: 0;
			padding: 0 8px;
		}
		.gjj-wancompile-broadcast {
			flex: 0 0 26px;
			width: 26px;
			padding: 0;
			font-size: 14px;
		}
		.gjj-wancompile-toggle:hover,
		.gjj-wancompile-broadcast:hover {
			border-color: #6aa6b8;
			background: #263843;
		}
		.gjj-wancompile-toggle.on,
		.gjj-wancompile-toggle[data-value="true"],
		.gjj-wancompile-broadcast.on,
		.gjj-wancompile-broadcast[data-value="true"] {
			border-color: #69b980;
			background: #20362f;
			color: #ecfff1;
		}
	`;
	document.head.appendChild(style);
}

function stabilize(node) {
	if (!node || node.comfyClass !== NODE_NAME) return;
	ensureStyles();
	createPanel(node);
	hideBooleanWidgets(node);
	ensureOutputMetadata(node);
	syncButtons(node);
}

function schedule(node, delay = 0) {
	clearTimeout(node.__gjjWanCompileTimer);
	node.__gjjWanCompileTimer = setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "Comfy.GJJ.WanVideoTorchCompileSettingsButtons",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (BOOLEAN_FIELDS.some((field) => field.name === name)) hideWidget(widget);
			return widget;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this, 0);
			schedule(this, 120);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			this.properties = this.properties || {};
			if (serializedNode?.properties && BROADCAST_PROPERTY in serializedNode.properties) {
				this.properties[BROADCAST_PROPERTY] = Boolean(serializedNode.properties[BROADCAST_PROPERTY]);
			}
			if (serializedNode?.properties && BROADCAST_USER_SET_PROPERTY in serializedNode.properties) {
				this.properties[BROADCAST_USER_SET_PROPERTY] = Boolean(serializedNode.properties[BROADCAST_USER_SET_PROPERTY]);
			}
			schedule(this, 0);
			schedule(this, 120);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			hideBooleanWidgets(this);
			originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[BROADCAST_PROPERTY] = broadcastEnabled(this);
				serializedNode.properties[BROADCAST_USER_SET_PROPERTY] = this.properties?.[BROADCAST_USER_SET_PROPERTY] === true;
			}
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			schedule(this, 0);
			return result;
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === NODE_NAME) schedule(node, 0);
	},
});

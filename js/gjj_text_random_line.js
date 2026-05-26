import { app } from "../../scripts/app.js";

const NODE_NAME = "GJJ_TextRandomLine";
const UI_KEY = "gjj_text_random_line";
const SEED_WIDGET = "seed";
const STRIP_EMPTY_WIDGET = "strip_empty";
const CONTROLS_WIDGET = "gjj_text_random_line_controls";
const AUTO_PROP = "gjj_text_random_line_auto";
const MORE_OUTPUTS_PROP = "gjj_text_random_line_more_outputs";
const SLIDE_START_INPUT_NAME = "slide_start_index";
const QUEUE_DELAY_MS = 800;
const OUTPUT_DEFS = [
	{ name: "合并正面提示词结果", type: "STRING", tooltip: "拼接固定前缀后的最终文本。" },
	{ name: "文本总行数量", type: "INT", tooltip: "有效文本总行数。" },
	{ name: "随机文本", type: "STRING", tooltip: "当前命中的原始文本。" },
	{ name: "当前行数", type: "INT", tooltip: "当前实际命中的 1 基行号，可驱动其它循环过程。" },
];

let activeAutoNodeId = null;
let queueTimer = null;

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function findInput(node, name) {
	return node?.inputs?.find((input) => input?.name === name);
}

function hasSlideStartIndexLink(node) {
	return Boolean(findInput(node, SLIDE_START_INPUT_NAME)?.link != null);
}

function refreshWidgetValues(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	node.widgets_values = node.widgets
		.filter((widget) => widget?.serialize !== false)
		.map((widget) => widget?.value);
}

function dirty(node) {
	refreshWidgetValues(node);
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) {
		return false;
	}
	widget.value = value;
	widget.callback?.call(widget, value);
	dirty(node);
	return true;
}

function hideBooleanWidget(node) {
	const widget = findWidget(node, STRIP_EMPTY_WIDGET);
	if (!widget || widget.__gjjTextRandomLineHidden) {
		return;
	}
	widget.__gjjTextRandomLineHidden = true;
	widget.serialize = true;
	widget.hidden = true;
	widget.type = `converted-widget:${STRIP_EMPTY_WIDGET}`;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
}

function isAutoEnabled(node) {
	return Boolean(node?.properties?.[AUTO_PROP]);
}

function setAutoEnabled(node, enabled) {
	node.properties = node.properties || {};
	node.properties[AUTO_PROP] = Boolean(enabled);
	if (enabled) {
		activeAutoNodeId = String(node.id);
	} else if (activeAutoNodeId === String(node.id)) {
		activeAutoNodeId = null;
	}
	renderControls(node);
	dirty(node);
}

function hasLinks(output) {
	return Array.isArray(output?.links) && output.links.length > 0;
}

function setMoreOutputs(node, enabled) {
	node.properties = node.properties || {};
	node.properties[MORE_OUTPUTS_PROP] = Boolean(enabled);
	stabilizeNode(node);
	renderControls(node);
	dirty(node);
}

function moreOutputsEnabled(node) {
	return Boolean(node?.properties?.[MORE_OUTPUTS_PROP]);
}

function ensureSlideStartInputShape(node) {
	const input = findInput(node, SLIDE_START_INPUT_NAME);
	if (!input) {
		return;
	}
	input.name = SLIDE_START_INPUT_NAME;
	input.type = "INT";
	input.label = "滑动起始序号";
	input.localized_name = input.label;
	input.tooltip = "可接入外部整数作为主控序号：r = x mod n；r = n if r == 0 else r。接入后本节点不自动排队。";
}

function ensureOutputShape(node) {
	if (!node || node.comfyClass !== NODE_NAME) {
		return;
	}
	node.outputs = node.outputs || [];
	const wantCount = moreOutputsEnabled(node) ? OUTPUT_DEFS.length : 1;
	while (node.outputs.length < wantCount) {
		const def = OUTPUT_DEFS[node.outputs.length] || OUTPUT_DEFS[0];
		node.addOutput?.(def.name, def.type);
	}
	while (node.outputs.length > wantCount) {
		const last = node.outputs[node.outputs.length - 1];
		if (hasLinks(last)) {
			break;
		}
		node.removeOutput?.(node.outputs.length - 1);
	}
	(node.outputs || []).forEach((output, index) => {
		const def = OUTPUT_DEFS[index] || OUTPUT_DEFS[0];
		output.name = def.name;
		output.label = def.name;
		output.localized_name = def.name;
		output.type = def.type;
		output.tooltip = def.tooltip;
	});
}

function createButton(className) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = className;
	return button;
}

function ensureStyles(root) {
	if (root.__gjjTextRandomLineStyleReady) {
		return;
	}
	root.__gjjTextRandomLineStyleReady = true;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-text-random-line-controls{box-sizing:border-box;width:100%;display:flex;gap:6px;padding:0 2px;color:#d7e2ea;font:12px/1.35 sans-serif}
		.gjj-text-random-line-controls button{flex:1 1 0;min-width:58px;height:28px;background:#20323a;border:1px solid #3b5560;border-radius:5px;color:#edf6fa;padding:3px 7px;font:700 13px sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-text-random-line-controls button.on{background:#1f6b43;border-color:#48ad73;color:#fff;box-shadow:0 0 0 1px rgba(72,173,115,.35) inset}
	`;
	root.appendChild(style);
}

function renderControls(node) {
	const wrap = node.__gjjTextRandomLineControlsWrap;
	if (!wrap) {
		return;
	}
	const stripButton = wrap.querySelector(".strip-empty");
	const resetButton = wrap.querySelector(".reset");
	const autoButton = wrap.querySelector(".auto");
	const moreButton = wrap.querySelector(".more-outputs");
	const stripEnabled = Boolean(findWidget(node, STRIP_EMPTY_WIDGET)?.value);
	const autoEnabled = isAutoEnabled(node);
	const externalControlled = hasSlideStartIndexLink(node);
	const moreEnabled = moreOutputsEnabled(node);
	stripButton.classList.toggle("on", stripEnabled);
	stripButton.textContent = "🧹 空行";
	stripButton.title = stripEnabled ? "过滤空行：开。点击后空行也参与行号计算。" : "过滤空行：关。点击后跳过空白行。";
	resetButton.textContent = "🏁 初始";
	resetButton.title = "初始化：把序号值重置为 1。";
	autoButton.classList.toggle("on", autoEnabled && !externalControlled);
	autoButton.textContent = externalControlled ? "🔗 外控" : (autoEnabled ? "⏹️ 停止" : "▶️ 自动");
	autoButton.title = externalControlled
		? "已接入滑动起始序号：当前行由外部接口控制，本节点不自动排队。"
		: (autoEnabled ? "停止自动执行。" : "自动执行：从当前序号开始逐行排队运行，直到最后一行。");
	autoButton.style.opacity = externalControlled ? "0.72" : "1";
	if (moreButton) {
		moreButton.classList.toggle("on", moreEnabled);
		moreButton.textContent = moreEnabled ? "⏮️ 收起" : "🔌 更多";
		moreButton.title = moreEnabled
			? "收起更多输出口；已连接的输出口会保留，避免断线。"
			: "展开更多输出口：文本总行数量、随机文本、当前行数。";
	}
}

function stopQueuedRun(node) {
	if (queueTimer) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
	setAutoEnabled(node, false);
}

function ensureControls(node) {
	if (node.__gjjTextRandomLineControls) {
		renderControls(node);
		return;
	}
	const wrap = document.createElement("div");
	wrap.className = "gjj-text-random-line-controls";
	ensureStyles(wrap);

	const stripButton = createButton("strip-empty");
	const resetButton = createButton("reset");
	const autoButton = createButton("auto");
	const moreButton = createButton("more-outputs");
	wrap.append(stripButton, resetButton, autoButton, moreButton);

	for (const eventName of ["mousedown", "pointerdown", "click"]) {
		wrap.addEventListener(eventName, (event) => event.stopPropagation());
	}

	stripButton.addEventListener("click", (event) => {
		event.preventDefault();
		setWidgetValue(node, STRIP_EMPTY_WIDGET, !Boolean(findWidget(node, STRIP_EMPTY_WIDGET)?.value));
		renderControls(node);
	});
	resetButton.addEventListener("click", (event) => {
		event.preventDefault();
		if (queueTimer) {
			clearTimeout(queueTimer);
			queueTimer = null;
		}
		setWidgetValue(node, SEED_WIDGET, 1);
	});
	autoButton.addEventListener("click", async (event) => {
		event.preventDefault();
		if (hasSlideStartIndexLink(node)) {
			stopQueuedRun(node);
			renderControls(node);
			return;
		}
		if (isAutoEnabled(node)) {
			stopQueuedRun(node);
			return;
		}
		setAutoEnabled(node, true);
		try {
			await app.queuePrompt(0);
		} catch (error) {
			stopQueuedRun(node);
		}
	});
	moreButton.addEventListener("click", (event) => {
		event.preventDefault();
		setMoreOutputs(node, !moreOutputsEnabled(node));
	});

	node.__gjjTextRandomLineControlsWrap = wrap;
	node.__gjjTextRandomLineControls = node.addDOMWidget(CONTROLS_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
	});
	node.__gjjTextRandomLineControls.computeSize = (width) => [Math.max(180, Number(width || 180)), 30];
	node.__gjjTextRandomLineControls.draw = () => {};
	reorderWidgets(node);
	renderControls(node);
}

function stabilizeNode(node) {
	if (!node || node.comfyClass !== NODE_NAME) {
		return;
	}
	hideBooleanWidget(node);
	ensureSlideStartInputShape(node);
	if (hasSlideStartIndexLink(node) && isAutoEnabled(node)) {
		stopQueuedRun(node);
	}
	ensureOutputShape(node);
	ensureControls(node);
	reorderWidgets(node);
	renderControls(node);
	dirty(node);
}

function scheduleStabilize(node, ms = 32) {
	if (!node || node.comfyClass !== NODE_NAME) {
		return;
	}
	clearTimeout(node.__gjjTextRandomLineStabilizeTimer);
	node.__gjjTextRandomLineStabilizeTimer = setTimeout(() => stabilizeNode(node), ms);
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const priority = (widget) => {
		const name = String(widget?.name || "");
		if (name === "fixed_prefix") {
			return 10;
		}
		if (name === "texts") {
			return 20;
		}
		if (name === SEED_WIDGET) {
			return 30;
		}
		if (name === CONTROLS_WIDGET) {
			return 40;
		}
		if (name === STRIP_EMPTY_WIDGET) {
			return 90;
		}
		return 50;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((a, b) => priority(a.widget) - priority(b.widget) || a.index - b.index)
		.map((entry) => entry.widget);
}

function queueNextIfNeeded(node, data) {
	if (!node || !isAutoEnabled(node)) {
		return;
	}
	if (hasSlideStartIndexLink(node)) {
		stopQueuedRun(node);
		return;
	}
	const current = Number(data?.current_value || findWidget(node, SEED_WIDGET)?.value || 1);
	const total = Number(data?.total_count || 0);
	const nextValue = Math.max(1, Math.floor(current) + 1);
	if (!Number.isFinite(total) || total <= 0 || nextValue > total) {
		stopQueuedRun(node);
		return;
	}
	setWidgetValue(node, SEED_WIDGET, nextValue);
	queueTimer = setTimeout(async () => {
		queueTimer = null;
		if (!isAutoEnabled(node)) {
			return;
		}
		try {
			await app.queuePrompt(0);
		} catch (error) {
			stopQueuedRun(node);
		}
	}, QUEUE_DELAY_MS);
}

app.registerExtension({
	name: "GJJ.TextRandomLine",
	nodeCreated(node) {
		if (node.comfyClass !== NODE_NAME) {
			return;
		}
		scheduleStabilize(node, 0);
	},
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) {
			return;
		}

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			if (data && hasSlideStartIndexLink(this)) {
				setWidgetValue(this, SEED_WIDGET, Math.max(1, Number(data.current_line || data.current_value || 1)));
				stopQueuedRun(this);
			} else if (data && activeAutoNodeId === String(this.id)) {
				queueNextIfNeeded(this, data);
			}
			renderControls(this);
			return result;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			if (hasSlideStartIndexLink(this)) {
				stopQueuedRun(this);
			}
			scheduleStabilize(this);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_NAME) {
				scheduleStabilize(node, 0);
			}
		}
	},
});

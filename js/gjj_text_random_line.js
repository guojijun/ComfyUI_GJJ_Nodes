import { app } from "../../scripts/app.js";

const NODE_NAME = "GJJ_TextRandomLine";
const UI_KEY = "gjj_text_random_line";
const SEED_WIDGET = "seed";
const STRIP_EMPTY_WIDGET = "strip_empty";
const CONTROLS_WIDGET = "gjj_text_random_line_controls";
const AUTO_PROP = "gjj_text_random_line_auto";
const QUEUE_DELAY_MS = 800;

let activeAutoNodeId = null;
let queueTimer = null;

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
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
		.gjj-text-random-line-controls button{flex:1;min-width:0;background:#20323a;border:1px solid #3b5560;border-radius:5px;color:#edf6fa;padding:5px 6px;font:700 12px sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-text-random-line-controls button.on{background:#1f6b43;border-color:#48ad73;color:#fff}
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
	const stripEnabled = Boolean(findWidget(node, STRIP_EMPTY_WIDGET)?.value);
	const autoEnabled = isAutoEnabled(node);
	stripButton.classList.toggle("on", stripEnabled);
	stripButton.textContent = stripEnabled ? "过滤空行 开" : "过滤空行 关";
	resetButton.textContent = "初始化";
	autoButton.classList.toggle("on", autoEnabled);
	autoButton.textContent = autoEnabled ? "停止执行" : "自动执行";
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
	wrap.append(stripButton, resetButton, autoButton);

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
		hideBooleanWidget(node);
		ensureControls(node);
		dirty(node);
	},
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) {
			return;
		}

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			if (data && activeAutoNodeId === String(this.id)) {
				queueNextIfNeeded(this, data);
			}
			renderControls(this);
			return result;
		};
	},
});

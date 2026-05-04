import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "GJJ_SequenceAutoExecutor";
const UI_KEY = "gjj_sequence_auto_executor";
const ENABLED_WIDGET = "enabled";
const CURRENT_VALUE_WIDGET = "current_value";
const INCREMENTING_NODE = "GJJ_IncrementingInteger";
const INCREMENTING_VALUE_WIDGET = "value";
const INCREMENTING_COUNT_WIDGET = "count";
const STATUS_WIDGET = "自动执行状态";
const CONTROLS_WIDGET = "gjj_sequence_auto_controls";
const RESET_VALUE = 1;
const QUEUE_DELAY_MS = 800;
const MAX_AUTO_QUEUES = 1000;

const stateByNodeId = new Map();
let queuedTimer = null;
let autoQueueCount = 0;
let lastPromptId = null;

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function setStatus(node, text) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	node.properties.gjj_sequence_auto_status = text || "";
	let widget = findWidget(node, STATUS_WIDGET);
	if (!widget) {
		widget = node.addWidget("text", STATUS_WIDGET, "", () => {}, { serialize: false });
		widget.inputEl?.setAttribute?.("readonly", "readonly");
	}
	widget.value = text || "";
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function createButton(label) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.style.cssText = [
		"flex:1",
		"height:24px",
		"min-width:0",
		"border:1px solid #3e4d54",
		"border-radius:5px",
		"background:#273238",
		"color:#dce7e2",
		"font-size:11px",
		"line-height:20px",
		"cursor:pointer",
	].join(";");
	return button;
}

function ensureControlButtons(node) {
	if (node.__gjjSequenceAutoControls) {
		return;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;gap:6px;width:100%;box-sizing:border-box;padding:0 2px;";

	const resetButton = createButton("初始化序列");
	resetButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		resetSequence(node);
	});

	const stopButton = createButton("停止自动执行");
	stopButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const enabled = findWidget(node, ENABLED_WIDGET);
		if (enabled) {
			enabled.value = false;
		}
		autoQueueCount = 0;
		stopAutoQueue(node, "自动执行已手动停止");
	});

	wrap.appendChild(resetButton);
	wrap.appendChild(stopButton);
	const widget = node.addDOMWidget(CONTROLS_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
	});
	widget.computeSize = (width) => [Math.max(160, Number(width || 160)), 28];
	widget.draw = () => {};
	node.__gjjSequenceAutoControls = widget;
}

function activeExecutorNodes() {
	return (app.graph?._nodes || []).filter((node) => node?.comfyClass === NODE_NAME);
}

function enabledValue(node) {
	return Boolean(findWidget(node, ENABLED_WIDGET)?.value);
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return false;
	}
	widget.value = value;
	widget.callback?.call(widget, value);
	return true;
}

function upstreamNodeForInput(node, inputName) {
	const input = node?.inputs?.find((item) => item?.name === inputName);
	if (!input?.link || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[input.link];
	if (!link) {
		return null;
	}
	return app.graph.getNodeById?.(link.origin_id) || null;
}

function resetSequence(node) {
	autoQueueCount = 0;
	stateByNodeId.delete(String(node.id));
	if (queuedTimer) {
		clearTimeout(queuedTimer);
		queuedTimer = null;
	}

	const upstream = upstreamNodeForInput(node, CURRENT_VALUE_WIDGET);
	if (upstream?.comfyClass === INCREMENTING_NODE) {
		const valueWidget = findWidget(upstream, INCREMENTING_VALUE_WIDGET);
		if (setWidgetValue(valueWidget, RESET_VALUE)) {
			upstream.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
			setStatus(node, `已初始化上游递增数值为 ${RESET_VALUE}`);
			return;
		}
	}

	const currentWidget = findWidget(node, CURRENT_VALUE_WIDGET);
	if (setWidgetValue(currentWidget, RESET_VALUE)) {
		setStatus(node, `已初始化当前数值为 ${RESET_VALUE}`);
	} else {
		setStatus(node, "初始化失败：未找到可重置的数值控件");
	}
	app.graph?.setDirtyCanvas?.(true, true);
}

function upstreamStepCount(node) {
	const upstream = upstreamNodeForInput(node, CURRENT_VALUE_WIDGET);
	if (upstream?.comfyClass !== INCREMENTING_NODE) {
		return 1;
	}
	const value = Number(findWidget(upstream, INCREMENTING_COUNT_WIDGET)?.value ?? 1);
	return Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1);
}

function stopAutoQueue(node, reason) {
	if (queuedTimer) {
		clearTimeout(queuedTimer);
		queuedTimer = null;
	}
	if (node) {
		setStatus(node, reason || "自动执行已停止");
	}
}

function pickLatestEnabledState() {
	for (const node of activeExecutorNodes()) {
		if (!enabledValue(node)) {
			continue;
		}
		const data = stateByNodeId.get(String(node.id));
		if (data?.enabled) {
			return { node, data };
		}
	}
	return null;
}

async function queueNext(node, data) {
	if (!enabledValue(node)) {
		stopAutoQueue(node, "自动执行已关闭");
		return;
	}
	const current = Number(data?.current_value || 0);
	const total = Number(data?.total_count || 0);
	const step = upstreamStepCount(node);
	const nextValue = current + step;
	const shouldContinue = Boolean(data?.enabled) && total > 0 && nextValue <= total;
	if (!shouldContinue) {
		autoQueueCount = 0;
		setStatus(node, `本轮 ${current} 已到末尾，总数 ${total}`);
		return;
	}
	if (autoQueueCount >= MAX_AUTO_QUEUES) {
		setStatus(node, `已达到最大自动次数 ${MAX_AUTO_QUEUES}，自动停止`);
		return;
	}

	autoQueueCount += 1;
	const delay = QUEUE_DELAY_MS;
	setStatus(node, `本轮 ${current}，下一轮 ${nextValue}，总数 ${total}，${delay}ms 后自动执行`);
	queuedTimer = setTimeout(async () => {
		queuedTimer = null;
		if (!enabledValue(node)) {
			stopAutoQueue(node, "自动执行已关闭");
			return;
		}
		try {
			await app.queuePrompt(0);
		} catch (error) {
			setStatus(node, `自动排队失败：${error?.message || error}`);
		}
	}, delay);
}

api.addEventListener("execution_start", (event) => {
	lastPromptId = event?.detail?.prompt_id || null;
	if (queuedTimer) {
		clearTimeout(queuedTimer);
		queuedTimer = null;
	}
});

api.addEventListener("execution_success", (event) => {
	const promptId = event?.detail?.prompt_id || null;
	if (promptId && lastPromptId && promptId !== lastPromptId) {
		return;
	}
	const active = pickLatestEnabledState();
	if (!active) {
		autoQueueCount = 0;
		return;
	}
	queueNext(active.node, active.data);
});

api.addEventListener("execution_error", () => {
	const active = pickLatestEnabledState();
	if (active) {
		stopAutoQueue(active.node, "执行出错，自动执行已停止");
	}
});

api.addEventListener("execution_interrupted", () => {
	const active = pickLatestEnabledState();
	if (active) {
		stopAutoQueue(active.node, "执行被中断，自动执行已停止");
	}
});

app.registerExtension({
	name: "GJJ.SequenceAutoExecutor",
	nodeCreated(node) {
		if (node.comfyClass !== NODE_NAME) {
			return;
		}
		setStatus(node, node.properties?.gjj_sequence_auto_status || "等待执行");
		ensureControlButtons(node);
	},
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) {
			return;
		}

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			if (data) {
				stateByNodeId.set(String(this.id), data);
				setStatus(this, data.status || "");
			}
			return result;
		};
	},
});

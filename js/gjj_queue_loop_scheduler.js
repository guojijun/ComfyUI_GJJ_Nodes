import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const START_NODE = "GJJ_QueueLoopStart";
const END_NODE = "GJJ_QueueLoopEnd";
const STATE_TYPE = "GJJ_QUEUE_LOOP_STATE";
const START_UI_KEY = "gjj_queue_loop_start";
const END_UI_KEY = "gjj_queue_loop_scheduler";
const STATUS_WIDGET = "队列循环状态";
const CONTROLS_WIDGET = "gjj_queue_loop_controls";
const ENABLED_WIDGET = "enabled";
const RESET_WIDGET = "reset_token";
const MAX_AUTO_QUEUES = 1000;

const endStateByNodeId = new Map();
let queueTimer = null;
let autoQueueCount = 0;
let lastPromptId = null;

function eventPromptId(event) {
	return event?.detail?.prompt_id || null;
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !promptId || !lastPromptId || promptId === lastPromptId;
}

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function widgetValue(node, name, fallback = undefined) {
	const widget = findWidget(node, name);
	return widget ? widget.value : fallback;
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) {
		return false;
	}
	widget.value = value;
	widget.callback?.call(widget, value);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	return true;
}

function setStatus(node, text) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	node.properties.gjj_queue_loop_status = text || "";
	let widget = findWidget(node, STATUS_WIDGET);
	if (!widget) {
		widget = node.addWidget("text", STATUS_WIDGET, "", () => {}, { serialize: false });
		widget.inputEl?.setAttribute?.("readonly", "readonly");
	}
	widget.value = text || "";
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function createButton(label, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title || label;
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
		"white-space:nowrap",
		"overflow:hidden",
		"text-overflow:ellipsis",
	].join(";");
	return button;
}

function startNodeFromPayload(data) {
	const id = Number(data?.start_node_id);
	if (Number.isFinite(id) && id > 0) {
		return app.graph?.getNodeById?.(id) || null;
	}
	return null;
}

function isStartEnabled(startNode) {
	return Boolean(widgetValue(startNode, ENABLED_WIDGET, false));
}

function stopAutoQueue(reason) {
	if (queueTimer) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
	for (const node of app.graph?._nodes || []) {
		if (node?.comfyClass === START_NODE || node?.comfyClass === END_NODE) {
			setStatus(node, reason || "队列循环已停止");
		}
	}
}

function resetLoop(node) {
	const target = node?.comfyClass === START_NODE ? node : startNodeForEnd(node);
	if (!target) {
		setStatus(node, "未找到队列循环开始节点");
		return;
	}
	const current = Number(widgetValue(target, RESET_WIDGET, 0)) || 0;
	setWidgetValue(target, RESET_WIDGET, current + 1);
	autoQueueCount = 0;
	endStateByNodeId.clear();
	stopAutoQueue("已初始化循环；下次执行将从第一轮开始");
}

function startNodeForEnd(endNode) {
	const data = endStateByNodeId.get(String(endNode?.id));
	return startNodeFromPayload(data);
}

function stopLoop(node) {
	const target = node?.comfyClass === START_NODE ? node : startNodeForEnd(node);
	if (target) {
		setWidgetValue(target, ENABLED_WIDGET, false);
	}
	autoQueueCount = 0;
	stopAutoQueue("已手动停止队列循环");
}

function ensureControls(node) {
	if (node.__gjjQueueLoopControls) {
		return;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;gap:6px;width:100%;box-sizing:border-box;padding:0 2px;";

	const resetButton = createButton("初始化循环", "清空本轮状态，下次执行从第一轮开始");
	resetButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		resetLoop(node);
	});

	const stopButton = createButton("停止循环", "关闭开始节点的启用开关，并取消等待中的自动排队");
	stopButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		stopLoop(node);
	});

	wrap.appendChild(resetButton);
	wrap.appendChild(stopButton);
	const widget = node.addDOMWidget(CONTROLS_WIDGET, "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
	});
	widget.computeSize = (width) => [Math.max(180, Number(width || 180)), 28];
	widget.draw = () => {};
	node.__gjjQueueLoopControls = widget;
}

function hideResetToken(node) {
	const widget = findWidget(node, RESET_WIDGET);
	if (!widget || widget.__gjjQueueLoopHidden) {
		return;
	}
	widget.__gjjQueueLoopHidden = true;
	widget.computeSize = () => [0, -4];
	widget.type = "hidden";
}

function activeEndState() {
	for (const node of app.graph?._nodes || []) {
		if (node?.comfyClass !== END_NODE) {
			continue;
		}
		const data = endStateByNodeId.get(String(node.id));
		if (!data?.enabled || !data?.should_continue) {
			continue;
		}
		const startNode = startNodeFromPayload(data);
		if (!isStartEnabled(startNode)) {
			continue;
		}
		return { node, data, startNode };
	}
	return null;
}

async function queueNextIfNeeded() {
	const active = activeEndState();
	if (!active) {
		autoQueueCount = 0;
		return;
	}
	if (autoQueueCount >= MAX_AUTO_QUEUES) {
		setStatus(active.node, `已达到最大自动排队次数 ${MAX_AUTO_QUEUES}，自动停止`);
		return;
	}
	const delay = Math.max(0, Number(active.data.queue_delay_ms || 0) || 0);
	const current = Number(active.data.current_round || 0);
	const next = Number(active.data.next_round || current + 1);
	const total = Number(active.data.total_loops || 0);
	autoQueueCount += 1;
	const status = `第 ${current}/${total} 轮完成，下一轮 ${next}/${total}，${delay}ms 后自动排队`;
	setStatus(active.node, status);
	setStatus(active.startNode, status);
	queueTimer = setTimeout(async () => {
		queueTimer = null;
		const latestStart = startNodeFromPayload(active.data);
		if (!isStartEnabled(latestStart)) {
			stopAutoQueue("队列循环已关闭");
			return;
		}
		try {
			await app.queuePrompt(0);
		} catch (error) {
			setStatus(active.node, `自动排队失败：${error?.message || error}`);
		}
	}, delay);
}

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
	if (queueTimer) {
		clearTimeout(queueTimer);
		queueTimer = null;
	}
});

api.addEventListener("execution_success", (event) => {
	if (!samePrompt(event)) {
		return;
	}
	queueNextIfNeeded();
});

api.addEventListener("execution_error", (event) => {
	if (!samePrompt(event)) {
		return;
	}
	autoQueueCount = 0;
	stopAutoQueue("执行出错，队列循环已停止");
});

api.addEventListener("execution_interrupted", () => {
	autoQueueCount = 0;
	stopAutoQueue("执行被中断，队列循环已停止");
});

app.registerExtension({
	name: "GJJ.QueueLoopScheduler",
	nodeCreated(node) {
		if (node.comfyClass !== START_NODE && node.comfyClass !== END_NODE) {
			return;
		}
		setStatus(node, node.properties?.gjj_queue_loop_status || "等待执行");
		ensureControls(node);
		if (node.comfyClass === START_NODE) {
			hideResetToken(node);
		}
	},
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (![START_NODE, END_NODE].includes(nodeData?.name)) {
			return;
		}
		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			if (nodeData.name === START_NODE) {
				const data = Array.isArray(message?.[START_UI_KEY]) ? message[START_UI_KEY][0] : null;
				if (data) {
					setStatus(this, data.status || "");
				}
			} else {
				const data = Array.isArray(message?.[END_UI_KEY]) ? message[END_UI_KEY][0] : null;
				if (data) {
					endStateByNodeId.set(String(this.id), data);
					setStatus(this, data.status || "");
					const startNode = startNodeFromPayload(data);
					if (startNode) {
						setStatus(startNode, data.status || "");
					}
				}
			}
			return result;
		};
	},
	setup() {
		try {
			app.canvas.default_connection_color_byType[STATE_TYPE] = "#7bbf8b";
			window.LGraphCanvas.link_type_colors[STATE_TYPE] = "#7bbf8b";
		} catch (_) {}
	},
});

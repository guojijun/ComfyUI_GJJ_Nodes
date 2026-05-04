import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "GJJ_IncrementingInteger";
const CONTROL_WIDGET = "control_after_generate";
const VALUE_WIDGET = "value";
const COUNT_WIDGET = "count";
const DEFAULT_APPLIED_FLAG = "gjj_incrementing_integer_default_applied";
const adjustedPrompts = new Set();
let lastPromptId = null;

function controlMode(node) {
	return String(GJJ_Utils.getWidget(node, CONTROL_WIDGET)?.value || "").toLowerCase();
}

function countStep(node) {
	const raw = Number(GJJ_Utils.getWidget(node, COUNT_WIDGET)?.value ?? 1);
	if (!Number.isFinite(raw)) {
		return 1;
	}
	return Math.max(1, Math.floor(raw));
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return false;
	}
	widget.value = value;
	widget.callback?.call(widget, value);
	return true;
}

function setDefaultIncrement(node) {
	if (node.comfyClass !== NODE_NAME) {
		return;
	}
	node.properties = node.properties || {};
	if (node.properties[DEFAULT_APPLIED_FLAG]) {
		return;
	}
	const control = GJJ_Utils.getWidget(node, CONTROL_WIDGET);
	if (control) {
		control.value = "increment";
		node.properties[DEFAULT_APPLIED_FLAG] = true;
	}
}

function compensateIncrementStep(promptId) {
	const key = String(promptId || Date.now());
	if (adjustedPrompts.has(key)) {
		return;
	}
	adjustedPrompts.add(key);
	for (const node of app.graph?._nodes || []) {
		if (node?.comfyClass !== NODE_NAME || controlMode(node) !== "increment") {
			continue;
		}
		const step = countStep(node);
		if (step <= 1) {
			continue;
		}
		const valueWidget = GJJ_Utils.getWidget(node, VALUE_WIDGET);
		const current = Number(valueWidget?.value ?? 0);
		if (!Number.isFinite(current)) {
			continue;
		}
		setWidgetValue(valueWidget, current + step - 1);
		node.setDirtyCanvas?.(true, true);
	}
	app.graph?.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
}

api.addEventListener("execution_start", (event) => {
	lastPromptId = event?.detail?.prompt_id || null;
});

api.addEventListener("execution_success", (event) => {
	const promptId = event?.detail?.prompt_id || lastPromptId || Date.now();
	setTimeout(() => compensateIncrementStep(promptId), 0);
});

app.registerExtension({
	name: "GJJ.IncrementingInteger",
	nodeCreated(node) {
		setDefaultIncrement(node);
	},
});

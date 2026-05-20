import { app } from "/scripts/app.js";
import "./gjj_group_run.js";

const ACTIVE_MODE = 0;
const BYPASS_MODE = 4;

function isEditableTarget(target) {
	if (!target) {
		return false;
	}

	const element = target instanceof Element ? target : null;
	if (!element) {
		return false;
	}

	if (element.closest("input, textarea, select, [contenteditable='true'], [contenteditable=''], .comfy-multiline-input")) {
		return true;
	}

	return Boolean(element.isContentEditable);
}

function getSelectedNodes() {
	const selected = app.canvas?.selected_nodes;
	if (!selected || typeof selected !== "object") {
		return [];
	}
	return Object.values(selected).filter((node) => node && typeof node === "object");
}

function toggleSelectedNodesBypass() {
	const nodes = getSelectedNodes();
	if (!nodes.length) {
		return false;
	}

	const shouldBypass = nodes.some((node) => Number(node?.mode ?? ACTIVE_MODE) !== BYPASS_MODE);
	app.graph?.beforeChange?.();
	for (const node of nodes) {
		node.mode = shouldBypass ? BYPASS_MODE : ACTIVE_MODE;
		node.graph?.change?.();
	}
	app.graph?.afterChange?.();
	app.canvas?.setDirty?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	return true;
}

app.registerExtension({
	name: "Comfy.GJJ.Shortcuts",

	setup() {
		document.addEventListener("keydown", (event) => {
			const key = String(event.key || "").toLowerCase();
			if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || key !== "b") {
				return;
			}

			if (isEditableTarget(event.target)) {
				return;
			}

			if (!toggleSelectedNodesBypass()) {
				return;
			}

			event.preventDefault();
			event.stopImmediatePropagation();
		}, true);
	},
});

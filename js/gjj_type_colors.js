import { app } from "/scripts/app.js";

const TYPE_COLORS = {
	GJJ_BATCH_IMAGE: {
		link: "#2EC4B6",
		on: "#2EC4B6",
		off: "#1E8E85",
	},
	LORA_CHAIN_CONFIG: {
		link: "#F4B740",
		on: "#F4B740",
		off: "#A77418",
	},
};

function getTypePalette(type) {
	const parts = String(type || "").split(",").map((part) => part.trim()).filter(Boolean);
	for (const part of parts.length ? parts : [String(type || "").trim()]) {
		const palette = TYPE_COLORS[part];
		if (palette) {
			return palette;
		}
	}
	return null;
}

function applySlotColor(slot) {
	if (!slot) {
		return;
	}
	const palette = getTypePalette(slot.type);
	if (!palette) {
		return;
	}
	slot.color_on = palette.on;
	slot.color_off = palette.off;
	slot.color = palette.on;
}

function applyNodeSlotColors(node) {
	if (!node) {
		return;
	}
	for (const slot of node.inputs || []) {
		applySlotColor(slot);
	}
	for (const slot of node.outputs || []) {
		applySlotColor(slot);
	}
}

function applyGraphSlotColors() {
	for (const node of app.graph?._nodes || []) {
		applyNodeSlotColors(node);
	}
}

function buildTypeColorMap(colorKey) {
	return Object.fromEntries(
		Object.entries(TYPE_COLORS).map(([type, palette]) => [type, palette[colorKey]]),
	);
}

function applyTypeColors() {
	const linkColors = buildTypeColorMap("link");
	const offColors = buildTypeColorMap("off");
	if (app.canvas) {
		app.canvas.default_connection_color_byType ??= {};
		app.canvas.default_connection_color_byTypeOff ??= {};
		Object.assign(app.canvas.default_connection_color_byType, linkColors);
		Object.assign(app.canvas.default_connection_color_byTypeOff, offColors);
	}
	if (typeof LGraphCanvas !== "undefined" && LGraphCanvas.link_type_colors) {
		Object.assign(LGraphCanvas.link_type_colors, linkColors);
	}
	applyGraphSlotColors();
	app.graph?.setDirtyCanvas?.(true, true);
}

function patchSlotLifecycle() {
	if (window.__gjjTypeColorsSlotLifecyclePatched) {
		return;
	}
	window.__gjjTypeColorsSlotLifecyclePatched = true;

	const graphNodeProto = globalThis.LGraphNode?.prototype;
	if (!graphNodeProto) {
		return;
	}

	const originalConfigure = graphNodeProto.configure;
	if (typeof originalConfigure === "function") {
		graphNodeProto.configure = function (...args) {
			const result = originalConfigure.apply(this, args);
			applyNodeSlotColors(this);
			return result;
		};
	}

	const originalAddInput = graphNodeProto.addInput;
	if (typeof originalAddInput === "function") {
		graphNodeProto.addInput = function (...args) {
			const result = originalAddInput.apply(this, args);
			applyNodeSlotColors(this);
			return result;
		};
	}

	const originalAddOutput = graphNodeProto.addOutput;
	if (typeof originalAddOutput === "function") {
		graphNodeProto.addOutput = function (...args) {
			const result = originalAddOutput.apply(this, args);
			applyNodeSlotColors(this);
			return result;
		};
	}
}

function scheduleReapply() {
	requestAnimationFrame(() => applyTypeColors());
	setTimeout(() => applyTypeColors(), 0);
	setTimeout(() => applyTypeColors(), 120);
	setTimeout(() => applyTypeColors(), 500);
}

globalThis.GJJApplyTypeColorsToNode = applyNodeSlotColors;

app.registerExtension({
	name: "GJJ.TypeColors",
	setup() {
		patchSlotLifecycle();
		applyTypeColors();
		scheduleReapply();
	},
	nodeCreated(node) {
		applyNodeSlotColors(node);
		scheduleReapply();
	},
});

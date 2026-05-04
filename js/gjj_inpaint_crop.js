import { app } from "/scripts/app.js";

const TARGET_CLASS = "GJJ_InpaintCrop";

function findWidget(node, name) {
	return node.widgets?.find((widget) => widget.name === name) || null;
}

function setWidgetEnabled(widget, enabled) {
	if (!widget) return;
	widget.disabled = !enabled;
	widget.linkedWidgets?.forEach((linked) => setWidgetEnabled(linked, enabled));
}

function updateControls(node) {
	if (node.comfyClass !== TARGET_CLASS) return;
	const preresize = !!findWidget(node, "preresize")?.value;
	const preresizeMode = findWidget(node, "preresize_mode")?.value;
	setWidgetEnabled(findWidget(node, "preresize_mode"), preresize);
	setWidgetEnabled(findWidget(node, "preresize_min_width"), preresize && (preresizeMode === "确保最小分辨率" || preresizeMode === "确保最小和最大分辨率"));
	setWidgetEnabled(findWidget(node, "preresize_min_height"), preresize && (preresizeMode === "确保最小分辨率" || preresizeMode === "确保最小和最大分辨率"));
	setWidgetEnabled(findWidget(node, "preresize_max_width"), preresize && (preresizeMode === "确保最大分辨率" || preresizeMode === "确保最小和最大分辨率"));
	setWidgetEnabled(findWidget(node, "preresize_max_height"), preresize && (preresizeMode === "确保最大分辨率" || preresizeMode === "确保最小和最大分辨率"));

	const outpaint = !!findWidget(node, "extend_for_outpainting")?.value;
	setWidgetEnabled(findWidget(node, "extend_up_factor"), outpaint);
	setWidgetEnabled(findWidget(node, "extend_down_factor"), outpaint);
	setWidgetEnabled(findWidget(node, "extend_left_factor"), outpaint);
	setWidgetEnabled(findWidget(node, "extend_right_factor"), outpaint);

	const targetSize = !!findWidget(node, "output_resize_to_target_size")?.value;
	setWidgetEnabled(findWidget(node, "output_target_width"), targetSize);
	setWidgetEnabled(findWidget(node, "output_target_height"), targetSize);
}

function wrapWidget(node, widget) {
	if (!widget || widget.__gjjInpaintCropWrapped) return;
	widget.__gjjInpaintCropWrapped = true;
	let value = widget.value;
	const descriptor = Object.getOwnPropertyDescriptor(widget, "value")
		|| Object.getOwnPropertyDescriptor(Object.getPrototypeOf(widget), "value")
		|| Object.getOwnPropertyDescriptor(widget.constructor.prototype, "value");
	Object.defineProperty(widget, "value", {
		get() {
			return descriptor?.get ? descriptor.get.call(widget) : value;
		},
		set(nextValue) {
			if (descriptor?.set) {
				descriptor.set.call(widget, nextValue);
			} else {
				value = nextValue;
			}
			updateControls(node);
		},
	});
}

app.registerExtension({
	name: "GJJ.InpaintCropControls",
	nodeCreated(node) {
		if (node.comfyClass !== TARGET_CLASS) return;
		for (const widget of node.widgets || []) {
			wrapWidget(node, widget);
		}
		updateControls(node);
	},
});

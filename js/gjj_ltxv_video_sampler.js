import { app } from "/scripts/app.js";

(function () {
	"use strict";

	const NODE_NAME = "GJJ_LTXVVideoSampler";
	const CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
	const COMPATIBLE_WIDGET_INPUTS = {
		noise_seed: { type: "NOISE,INT", label: "噪波种子" },
		sigmas: { type: "SIGMAS,STRING", label: "Sigmas" },
	};

	function findWidgetIndex(node, name) {
		return Array.isArray(node?.widgets) ? node.widgets.findIndex((widget) => widget?.name === name) : -1;
	}

	function setWidgetValue(node, widget, value) {
		if (!widget) {
			return;
		}
		widget.value = value;
		try {
			widget.callback?.(widget.value, app.canvas, node, undefined, widget);
		} catch (_) {}
	}

	function widgetByName(node, name) {
		return Array.isArray(node?.widgets) ? node.widgets.find((widget) => widget?.name === name) : null;
	}

	function widenCompatibleWidgetInputs(node) {
		if (!Array.isArray(node?.inputs)) {
			return;
		}
		for (const input of node.inputs) {
			const widgetName = String(input?.widget?.name || input?.name || "");
			const config = COMPATIBLE_WIDGET_INPUTS[widgetName];
			if (!config) {
				continue;
			}
			input.type = config.type;
			input.label = config.label;
			input.localized_name = config.label;
		}
		app.canvas?.setDirty?.(true, true);
	}

	function restoreLegacyShiftedValues(node, savedValues) {
		if (!Array.isArray(savedValues) || CONTROL_VALUES.has(String(savedValues[1]))) {
			return;
		}
		const names = [
			"noise_seed",
			"cfg",
			"sampler_name",
			"sigmas",
			"auto_clean_memory",
			"output_denoised",
		];
		names.forEach((name, index) => {
			const value = savedValues[index];
			if (value !== undefined) {
				setWidgetValue(node, widgetByName(node, name), value);
			}
		});
	}

	function ensureFixedSeedControl(node, serializedNode = null) {
		const seedIndex = findWidgetIndex(node, "noise_seed");
		if (seedIndex < 0) {
			return;
		}

		const controlIndex = findWidgetIndex(node, "control_after_generate");
		const fallbackControlIndex = seedIndex + 1;
		const controlWidget = controlIndex >= 0 ? node.widgets[controlIndex] : node.widgets?.[fallbackControlIndex];
		if (!controlWidget) {
			return;
		}

		const savedValues = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : null;
		const savedControl = savedValues ? savedValues[fallbackControlIndex] : undefined;
		const currentControl = String(controlWidget.value ?? "");
		const hasSavedControl = CONTROL_VALUES.has(String(savedControl));

		if (hasSavedControl) {
			return;
		}
		restoreLegacyShiftedValues(node, savedValues);
		if (!savedValues && currentControl === "fixed") {
			return;
		}
		setWidgetValue(node, controlWidget, "fixed");
	}

	app.registerExtension({
		name: "GJJ.LTXVVideoSamplerSeedControl",
		beforeRegisterNodeDef(nodeType, nodeData) {
			if (nodeData?.name !== NODE_NAME) {
				return;
			}

			const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) {
				const result = originalOnNodeCreated?.apply(this, args);
				requestAnimationFrame(() => {
					ensureFixedSeedControl(this);
					widenCompatibleWidgetInputs(this);
				});
				return result;
			};

			const originalOnConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (serializedNode, ...args) {
				const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
				requestAnimationFrame(() => {
					ensureFixedSeedControl(this, serializedNode);
					widenCompatibleWidgetInputs(this);
				});
				return result;
			};
		},
	});
})();

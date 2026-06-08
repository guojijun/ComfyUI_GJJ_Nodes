import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
	"use strict";

	const NODE_NAME = "GJJ_LTXVVideoSampler";
	const STYLE_ID = "gjj-ltxv-video-sampler-preview-style";
	const PREVIEW_WIDGET_NAME = "gjj_ltxv_sampling_preview";
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

	function dirty(node) {
		node?.setDirtyCanvas?.(true, true);
		node?.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	function currentWidth(node) {
		const width = Number(node?.size?.[0]);
		return Number.isFinite(width) && width > 0 ? Math.round(width) : 220;
	}

	function applyNoMinWidth(node, nodeType = null) {
		if (nodeType) {
			try { nodeType.min_width = 0; } catch (_) {}
			try { nodeType.minWidth = 0; } catch (_) {}
			try { nodeType.minimum_width = 0; } catch (_) {}
		}
		if (!node) return;
		try { node.min_width = 0; } catch (_) {}
		try { node.minWidth = 0; } catch (_) {}
		try { node.minimum_width = 0; } catch (_) {}
		if (Array.isArray(node.size)) node.size[0] = currentWidth(node);
	}

	function ensureStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
.gjj-ltxv-preview{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;margin-top:2px;padding:7px;border:1px solid rgba(88,116,130,.46);border-radius:9px;background:rgba(10,17,22,.94);color:#dce8e5;font:12px/1.35 system-ui,"Microsoft YaHei",sans-serif;}
.gjj-ltxv-preview-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#b9c8cc;font-weight:800;}
.gjj-ltxv-preview-step{font-variant-numeric:tabular-nums;color:#8fd3ff;}
.gjj-ltxv-preview-frame{min-height:96px;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:7px;background:#05090c;}
.gjj-ltxv-preview-frame img{display:block;width:100%;max-height:260px;object-fit:contain;background:#05090c;}
`;
		document.head.appendChild(style);
	}

	function resizeForPreview(node) {
		requestAnimationFrame(() => {
			const panel = node?.__gjjLtxvSamplerPreview;
			const height = Math.max(60, Math.ceil(panel?.root?.scrollHeight || 60));
			const widgetHeight = panel?.widget?.getHeight?.() || height;
			const computed = node.computeSize?.() || [];
			const nextHeight = Math.max(80, Math.ceil(computed[1] || 0), Math.ceil(widgetHeight + 20));
			node.setSize?.([currentWidth(node), nextHeight]);
			dirty(node);
		});
	}

	function ensurePreviewPanel(node) {
		if (node?.__gjjLtxvSamplerPreview) return node.__gjjLtxvSamplerPreview;
		if (!node || typeof node.addDOMWidget !== "function") return null;
		ensureStyle();
		applyNoMinWidth(node);

		const root = document.createElement("div");
		root.className = "gjj-ltxv-preview";
		root.addEventListener("pointerdown", (event) => event.stopPropagation());
		root.addEventListener("mousedown", (event) => event.stopPropagation());
		root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

		const head = document.createElement("div");
		head.className = "gjj-ltxv-preview-head";
		const title = document.createElement("span");
		title.textContent = "采样预览";
		const step = document.createElement("span");
		step.className = "gjj-ltxv-preview-step";
		step.textContent = "0/0";
		head.append(title, step);

		const frame = document.createElement("div");
		frame.className = "gjj-ltxv-preview-frame";
		const image = document.createElement("img");
		image.alt = "LTXV采样预览";
		image.addEventListener("load", () => resizeForPreview(node));
		frame.appendChild(image);
		root.append(head, frame);

		const widget = node.addDOMWidget(PREVIEW_WIDGET_NAME, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
		});
		if (widget) {
			widget.serialize = false;
			widget.options = widget.options || {};
			widget.options.serialize = false;
			widget.computeSize = (width) => [Math.round(width || currentWidth(node)), Math.max(120, Math.ceil(root.scrollHeight || 120))];
			widget.getHeight = () => Math.max(120, Math.ceil(root.scrollHeight || 120));
		}

		node.__gjjLtxvSamplerPreview = { root, widget, image, step };
		resizeForPreview(node);
		return node.__gjjLtxvSamplerPreview;
	}

	function updateSamplingPreview(node, detail) {
		const image = String(detail?.image || "");
		if (!image) return;
		const panel = ensurePreviewPanel(node);
		if (!panel) return;
		const step = Number(detail?.step || 0);
		const total = Number(detail?.total || 0);
		panel.step.textContent = step && total ? `${step}/${total}` : "采样中";
		panel.image.src = image;
		resizeForPreview(node);
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
				applyNoMinWidth(this, nodeType);
				requestAnimationFrame(() => {
					applyNoMinWidth(this, nodeType);
					ensureFixedSeedControl(this);
					widenCompatibleWidgetInputs(this);
				});
				return result;
			};

			const originalOnConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (serializedNode, ...args) {
				const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
				applyNoMinWidth(this, nodeType);
				requestAnimationFrame(() => {
					applyNoMinWidth(this, nodeType);
					ensureFixedSeedControl(this, serializedNode);
					widenCompatibleWidgetInputs(this);
				});
				return result;
			};
		},
		nodeCreated(node) {
			if (String(node?.comfyClass || node?.type || "") === NODE_NAME) {
				applyNoMinWidth(node);
			}
		},
		setup() {
			api.addEventListener("gjj_ltxv_sampler_preview", (event) => {
				const detail = event?.detail || {};
				const targetId = String(detail?.node || "");
				for (const node of app.graph?._nodes || []) {
					if (String(node?.id) === targetId && String(node?.comfyClass || node?.type || "") === NODE_NAME) {
						updateSamplingPreview(node, detail);
						break;
					}
				}
			});
		},
	});
})();

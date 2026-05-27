import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
	"use strict";

	const NODE_NAME = "GJJ_CannyEdge";
	const PANEL_WIDGET = "gjj_canny_edge_preview_panel";

	function refreshNode(node) {
		requestAnimationFrame(() => {
			const size = node.computeSize?.();
			if (Array.isArray(size)) {
				node.setSize?.([
					Math.max(Number(node.size?.[0] || size[0] || 300), 300),
					Math.max(Number(size[1] || node.size?.[1] || 160), 160),
				]);
			}
			app.graph?.setDirtyCanvas?.(true, true);
		});
	}

	function ensurePanel(node) {
		if (!node || node.__gjjCannyEdgePanel || typeof node.addDOMWidget !== "function") {
			return node?.__gjjCannyEdgePanel || null;
		}

		const root = document.createElement("div");
		root.style.cssText = [
			"display:none",
			"box-sizing:border-box",
			"width:100%",
			"padding:7px 9px",
			"border:1px solid #35566a",
			"border-radius:10px",
			"background:#111a20",
			"color:#dbe8ec",
			"font:12px/1.45 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
		].join(";");

		const text = document.createElement("div");
		text.textContent = "等待执行";
		text.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;";

		const barOuter = document.createElement("div");
		barOuter.style.cssText = [
			"height:6px",
			"margin-top:6px",
			"border-radius:999px",
			"overflow:hidden",
			"background:#263640",
		].join(";");

		const barInner = document.createElement("div");
		barInner.style.cssText = [
			"width:0%",
			"height:100%",
			"border-radius:999px",
			"background:linear-gradient(90deg,#4fd1c5,#7aa7ff)",
			"transition:width 120ms ease",
		].join(";");
		barOuter.appendChild(barInner);

		const image = document.createElement("img");
		image.alt = "Canny边缘实时预览";
		image.style.cssText = [
			"display:none",
			"width:100%",
			"max-height:260px",
			"margin-top:8px",
			"object-fit:contain",
			"border:1px solid #263640",
			"border-radius:8px",
			"background:#070b0e",
		].join(";");

		root.append(text, barOuter, image);
		const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
			getHeight: () => {
				if (root.style.display === "none") {
					return 0;
				}
				return image.style.display === "none" ? 58 : 330;
			},
		});
		if (widget) {
			widget.serialize = false;
			widget.value = undefined;
			widget.options = widget.options || {};
			widget.options.serialize = false;
		}

		node.__gjjCannyEdgePanel = { root, text, barInner, image, widget };
		return node.__gjjCannyEdgePanel;
	}

	function setProgress(node, detail = {}) {
		const state = ensurePanel(node);
		if (!state) {
			return;
		}
		const progress = Number.isFinite(Number(detail.progress))
			? Math.max(0, Math.min(1, Number(detail.progress)))
			: 0;
		state.root.style.display = "block";
		state.text.textContent = String(detail.text || "处理中...");
		state.barInner.style.width = `${Math.round(progress * 100)}%`;
		const url = String(detail.preview_data_url || "");
		if (url) {
			state.image.src = url;
			state.image.style.display = "block";
			const index = detail.preview_index;
			const total = detail.preview_total;
			if (index != null && total != null) {
				state.image.title = `实时预览：${index}/${total}`;
			}
		}
		refreshNode(node);
	}

	function patchNode(node) {
		if (!node || node.__gjjCannyEdgePatched) {
			return;
		}
		node.__gjjCannyEdgePatched = true;
		ensurePanel(node);
		const originalOnExecuted = node.onExecuted;
		node.onExecuted = function (...args) {
			const result = originalOnExecuted?.apply(this, args);
			const state = ensurePanel(this);
			if (state) {
				state.root.style.display = "block";
				state.text.textContent = "Canny边缘检测完成";
				state.barInner.style.width = "100%";
				refreshNode(this);
			}
			return result;
		};
	}

	app.registerExtension({
		name: "GJJ.CannyEdgePreview",
		beforeRegisterNodeDef(nodeType, nodeData) {
			if (nodeData?.name !== NODE_NAME) {
				return;
			}
			const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) {
				const result = originalOnNodeCreated?.apply(this, args);
				patchNode(this);
				return result;
			};
			const originalOnConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (...args) {
				const result = originalOnConfigure?.apply(this, args);
				patchNode(this);
				return result;
			};
		},
		setup() {
			api.addEventListener("gjj_node_progress", (event) => {
				const detail = event?.detail || {};
				if (!detail.preview_data_url && !String(detail.text || "").includes("Canny边缘检测")) {
					return;
				}
				const targetId = String(detail.node || "");
				for (const node of app.graph?._nodes || []) {
					if (String(node?.id) !== targetId || String(node?.comfyClass || node?.type || "") !== NODE_NAME) {
						continue;
					}
					patchNode(node);
					setProgress(node, detail);
					break;
				}
			});
			for (const node of app.graph?._nodes || []) {
				if (String(node?.comfyClass || node?.type || "") === NODE_NAME) {
					patchNode(node);
				}
			}
		},
	});
})();

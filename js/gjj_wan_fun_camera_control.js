import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
	"use strict";

	const NODE_NAME = "GJJ_WanFunCameraControl";
	const PANEL_WIDGET = "gjj_wan_fun_camera_preview";

	function protect(element) {
		for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
			element.addEventListener(eventName, (event) => event.stopPropagation());
		}
	}

	function imageUrl(item) {
		if (!item?.filename) return "";
		const previewFormat =
			typeof app.getPreviewFormatParam === "function"
				? app.getPreviewFormatParam()
				: "";
		const randParam =
			typeof app.getRandParam === "function" ? app.getRandParam() : "";
		return api.apiURL(
			`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
		);
	}

	function firstImage(message) {
		const groups = [
			message?.preview_images,
			message?.images,
			message?.ui?.preview_images,
			message?.ui?.images,
		];
		for (const group of groups) {
			if (Array.isArray(group) && group.length) return group[0];
		}
		return null;
	}

	function firstText(message) {
		const groups = [
			message?.gjj_fun_camera_status,
			message?.preview_text,
			message?.ui?.gjj_fun_camera_status,
			message?.ui?.preview_text,
		];
		for (const group of groups) {
			if (Array.isArray(group) && group.length) return String(group[0] || "");
		}
		return "";
	}

	function panelHeight(node) {
		if (!node?.__gjjWanFunCameraPreviewImage) return 0;
		const image = node.__gjjWanFunCameraPreviewImageElement;
		const width = Math.max(1, Math.round(Number(node.size?.[0] || 360) - 22));
		const naturalW = Math.max(1, Number(image?.naturalWidth || node.__gjjWanFunCameraPreviewImage?.width || 720));
		const naturalH = Math.max(1, Number(image?.naturalHeight || node.__gjjWanFunCameraPreviewImage?.height || 540));
		const imageHeight = Math.max(130, Math.min(360, Math.round(width * naturalH / naturalW)));
		const textHeight = String(node.__gjjWanFunCameraPreviewText || "").trim() ? 58 : 12;
		return Math.round(imageHeight + textHeight + 18);
	}

	function refreshNode(node) {
		requestAnimationFrame(() => {
			const width = Math.round(Number(node.size?.[0] || 360));
			const computed = node.computeSize?.();
			const height = Math.round(Math.max(Number(computed?.[1] || 0), Number(node.size?.[1] || 0), panelHeight(node) + 84));
			node.setSize?.([width, height]);
			app.graph?.setDirtyCanvas?.(true, true);
		});
	}

	function ensurePanel(node) {
		if (!node || node.__gjjWanFunCameraPanel || typeof node.addDOMWidget !== "function") {
			return node?.__gjjWanFunCameraPanel || null;
		}

		const root = document.createElement("div");
		root.style.cssText = [
			"box-sizing:border-box",
			"width:100%",
			"padding:7px 8px 8px",
			"border:1px solid #31464e",
			"border-radius:8px",
			"background:#10181d",
			"color:#dbe8e4",
			"font:12px/1.42 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
			"overflow:hidden",
		].join(";");
		protect(root);

		const text = document.createElement("div");
		text.style.cssText = [
			"margin-bottom:7px",
			"white-space:pre-wrap",
			"overflow-wrap:anywhere",
			"color:#cfe1dc",
		].join(";");

		const image = document.createElement("img");
		image.alt = "Wan相机轨迹预览";
		image.draggable = false;
		image.style.cssText = [
			"display:block",
			"width:100%",
			"height:auto",
			"max-height:360px",
			"object-fit:contain",
			"border:1px solid #263942",
			"border-radius:7px",
			"background:#080e12",
		].join(";");
		image.addEventListener("load", () => refreshNode(node));
		image.addEventListener("error", () => refreshNode(node));

		root.append(text, image);
		const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
			getHeight: () => panelHeight(node),
		});
		if (widget) {
			widget.serialize = false;
			widget.value = undefined;
			widget.computeSize = (width) => [
				Math.round(Number(width || node.size?.[0] || 360)),
				panelHeight(node),
			];
		}

		node.__gjjWanFunCameraPanel = { root, text, image, widget };
		node.__gjjWanFunCameraPreviewImageElement = image;
		return node.__gjjWanFunCameraPanel;
	}

	function setPreview(node, message) {
		const item = firstImage(message);
		const url = imageUrl(item);
		if (!item || !url) return;
		const panel = ensurePanel(node);
		if (!panel) return;
		const summary = firstText(message);
		node.__gjjWanFunCameraPreviewImage = item;
		node.__gjjWanFunCameraPreviewText = summary;
		panel.text.textContent = summary || "Wan相机轨迹预览已更新";
		panel.image.src = url;
		refreshNode(node);
	}

	function withoutNativePreview(message) {
		const clean = { ...(message || {}) };
		delete clean.images;
		delete clean.preview_images;
		if (clean.ui && typeof clean.ui === "object") {
			clean.ui = { ...clean.ui };
			delete clean.ui.images;
			delete clean.ui.preview_images;
		}
		return clean;
	}

	app.registerExtension({
		name: "GJJ.WanFunCameraControlPreview",
		beforeRegisterNodeDef(nodeType, nodeData) {
			if (nodeData?.name !== NODE_NAME) return;
			nodeType.prototype.hideOutputImages = true;

			const originalOnExecuted = nodeType.prototype.onExecuted;
			nodeType.prototype.onExecuted = function (message, ...rest) {
				const result = originalOnExecuted?.apply(this, [withoutNativePreview(message), ...rest]);
				setTimeout(() => setPreview(this, message), 0);
				return result;
			};

			const originalOnResize = nodeType.prototype.onResize;
			nodeType.prototype.onResize = function (...args) {
				const result = originalOnResize?.apply(this, args);
				if (this.__gjjWanFunCameraPanel) refreshNode(this);
				return result;
			};
		},
	});
})();

import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";

const TARGET_BOX = "GJJ_RegionBox";
const TARGET_COMPOSITE = "GJJ_RegionComposite";
const BOX_IMAGE_INPUT = "image";
const COMPOSITE_IMAGE_INPUT = "base_image";
const CANVAS_W_WIDGET = "canvas_width";
const CANVAS_H_WIDGET = "canvas_height";

// ─── Helpers ───────────────────────────────────────────────────────

ze(node, message) {
	const imgW = GJJ_Utils.getFirstValue(message?.image_width);
	const imgH = GJJ_Utils.getFirstValue(message?.image_height);
	if (imgW == null || imgH == null) return;

	const w = Number(imgW);
	const h = Number(imgH);
	if (!Number.isFinite(w) || !Number.isFinite(h)) return;

	const sig = `${w}x${h}`;
	const props = (node.properties ??= {});
	// 仅在图片尺寸确实变化时才同步，已手动编辑的值会被保留
	if (props.__gjjRegionBoxImageSig === sig) return;
	props.__gjjRegionBoxImageSig = sig;

	const cw = GJJ_Utils.getWidget(node, CANVAS_W_WIDGET);
	const ch = GJJ_Utils.getWidget(node, CANVAS_H_WIDGET);
	if (cw) cw.value = w;
	if (ch) ch.value = h;
	GJJ_Utils.refreshNode(node);
}

// ─── GJJ_RegionComposite base_image → canvas size sync ────────────

async function loadImageDimensionsFromSourceNode(sourceNode) {
	if (!sourceNode) return null;
	const imageWidget = GJJ_Utils.getWidget(sourceNode, "image");
	const filename = String(imageWidget?.value || "").trim();
	if (!filename) return null;

	let viewType = null;
	if (sourceNode.comfyClass === "LoadImage") {
		viewType = "input";
	} else if (sourceNode.comfyClass === "LoadImageOutput") {
		viewType = "output";
	} else {
		return null;
	}

	const url = `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(viewType)}&rand=${Date.now()}`;
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

async function trySyncCanvasSize(node) {
	const input = node.inputs?.find?.((i) => i.name === COMPOSITE_IMAGE_INPUT);
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) return;

	const link = app.graph.links[linkId];
	if (!link) return;
	const sourceNode = link.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	if (!sourceNode) return;

	const size = await loadImageDimensionsFromSourceNode(sourceNode);
	if (!size) return;

	const cw = GJJ_Utils.getWidget(node, CANVAS_W_WIDGET);
	const ch = GJJ_Utils.getWidget(node, CANVAS_H_WIDGET);

	// 仅当 widget 当前值为 0（自动）时才更新
	if (cw && (cw.value == null || cw.value === 0)) {
		cw.value = size.width;
	}
	if (ch && (ch.value == null || ch.value === 0)) {
		ch.value = size.height;
	}
	GJJ_Utils.refreshNode(node);
}

// ─── Extension ─────────────────────────────────────────────────────

app.registerExtension({
	name: "GJJ.RegionLayerTools",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		// ── GJJ_RegionBox ──────────────────────────────────────
		if (nodeData?.name === TARGET_BOX) {
			const originalOnExecuted = nodeType.prototype.onExecuted;
			nodeType.prototype.onExecuted = function (message) {
				const result = originalOnExecuted?.apply(this, arguments);
				syncRegionBoxImageSize(this, message);
				return result;
			};

			const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
			nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, linkInfo) {
				const result = originalOnConnectionsChange?.apply(this, arguments);
				// 图片连接变化时清除签名，下次执行时会按新图片尺寸同步
				if (slotType === 0) {
					const input = this.inputs?.[slotIndex];
					if (input?.name === BOX_IMAGE_INPUT) {
						if (this.properties) {
							this.properties.__gjjRegionBoxImageSig = null;
						}
					}
				}
				return result;
			};
		}

		// ── GJJ_RegionComposite ─────────────────────────────────
		if (nodeData?.name !== TARGET_COMPOSITE) return;

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, linkInfo) {
			const result = originalOnConnectionsChange?.apply(this, arguments);
			// 输入口变化时尝试同步画布尺寸
			if (slotType === 0) {
				const input = this.inputs?.[slotIndex];
				if (input?.name === COMPOSITE_IMAGE_INPUT && connected) {
					setTimeout(() => trySyncCanvasSize(this), 0);
				}
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			const width = GJJ_Utils.getFirstValue(message?.canvas_width);
			const height = GJJ_Utils.getFirstValue(message?.canvas_height);
			if (width != null && height != null && Number.isFinite(Number(width)) && Number.isFinite(Number(height))) {
				const cw = GJJ_Utils.getWidget(this, CANVAS_W_WIDGET);
				const ch = GJJ_Utils.getWidget(this, CANVAS_H_WIDGET);
				if (cw) cw.value = Number(width);
				if (ch) ch.value = Number(height);
				GJJ_Utils.refreshNode(this);
			}
			return result;
		};
	},
});

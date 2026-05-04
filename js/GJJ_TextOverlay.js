import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";

ame);
	if (!widget || value === undefined || value === null) {
		return;
	}

	const nextValue = Number(value);
	if (Number.isNaN(nextValue)) {
		return;
	}

	widget.value = nextValue;
	widget.callback?.(nextValue);
}

app.registerExtension({
	name: "Comfy.GJJ.TextOverlay",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== "GJJ_TextOverlay") {
			return;
		}

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);

			updateWidget(this, "width", GJJ_Utils.getFirstValue(message?.canvas_width));
			updateWidget(this, "height", GJJ_Utils.getFirstValue(message?.canvas_height));

			this.setDirtyCanvas?.(true, true);
			app.graph.setDirtyCanvas(true, true);
		};
	},
});

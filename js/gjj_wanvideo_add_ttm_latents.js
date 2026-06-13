import { app } from "/scripts/app.js";

(function () {
    const NODE_CLASS_NAME = "GJJ_WanVideoAddTTMLatents";

    app.registerExtension({
        name: `GJJ.${NODE_CLASS_NAME}`,

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name !== NODE_CLASS_NAME) return;
        },
    });
})();

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
    const NODE_CLASS_NAME = "GJJ_OpenPose";

    app.registerExtension({
        name: `GJJ.${NODE_CLASS_NAME}`,

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name !== NODE_CLASS_NAME) return;

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = origOnNodeCreated?.apply(this, arguments);

                // 添加状态栏
                const statusDiv = document.createElement("div");
                statusDiv.style.cssText = `
                    margin-top: 4px;
                    padding: 4px 8px;
                    background: rgba(0,0,0,0.3);
                    border-radius: 4px;
                    font-size: 11px;
                    color: #aaa;
                    text-align: center;
                `;
                statusDiv.textContent = "就绪";
                this.statusWidget = statusDiv;

                // 添加到节点 DOM
                const widgetEl = this.widgets?.find(w => w.type === "button");
                if (widgetEl) {
                    widgetEl.parentEl?.appendChild?.(statusDiv);
                }

                return result;
            };

            // 执行后更新状态
            const origOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                const result = origOnExecuted?.apply(this, arguments);
                if (this.statusWidget) {
                    const batchCount = message?.batch_count || "";
                    const batchInfo = batchCount ? `（${batchCount} 张）` : "";
                    this.statusWidget.textContent = `✅ 执行成功${batchInfo}`;
                    this.statusWidget.style.color = "#4caf50";
                    setTimeout(() => {
                        if (this.statusWidget) {
                            this.statusWidget.textContent = "就绪";
                            this.statusWidget.style.color = "#aaa";
                        }
                    }, 3000);
                }
                return result;
            };
        },
    });
})();
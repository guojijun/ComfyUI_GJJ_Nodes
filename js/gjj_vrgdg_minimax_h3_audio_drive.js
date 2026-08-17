import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
    const NODE_CLASS_NAME = "GJJ_VRGDG_MiniMaxH3AudioDrive";

    app.registerExtension({
        name: `GJJ.${NODE_CLASS_NAME}`,

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name !== NODE_CLASS_NAME) return;

            // 本节点当前无需特殊前端定制，保留 IIFE 占位以便后续扩展：
            // - 进度/状态提示
            // - 时长不匹配警告
            // - 快捷连线助手（ref_audio_0 ↔ source_audio 同步）
        },

        async setup() {
            // 全局事件监听预留
        },
    });
})();

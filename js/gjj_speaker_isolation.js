import { app } from "../../scripts/app.js";

const NODE_TYPE = "GJJ_SpeakerIsolation";
const INPUT_LABELS = {
    audio: "音频",
    whisper_output: "识别时间戳",
};
const WIDGET_LABELS = {
    speaker_count: "说话人数",
    speaker_index: "选择说话人",
    silence_thresh_db: "静音阈值dB",
    min_segment_s: "最短片段秒",
    merge_gap_s: "合并间隔秒",
    merge_consecutive_speaker: "合并连续同说话人",
};

function localizeNode(node) {
    if (!node || node.comfyClass !== NODE_TYPE) return;
    for (const input of node.inputs || []) {
        const label = INPUT_LABELS[input.name];
        if (label) input.localized_name = label;
    }
    for (const widget of node.widgets || []) {
        const label = WIDGET_LABELS[widget.name];
        if (label) widget.label = label;
    }
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "GJJ.SpeakerIsolation.Locale",
    nodeCreated(node) {
        localizeNode(node);
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            localizeNode(this);
            return result;
        };
    },
});

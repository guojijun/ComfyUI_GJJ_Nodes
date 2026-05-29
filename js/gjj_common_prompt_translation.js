export const GJJ_COMMON_PROMPT_TRANSLATE_API = "/gjj/common_prompt_translate";
export const GJJ_LEGACY_CLIP_PROMPT_TRANSLATE_API = "/gjj/clip_prompt_translate";

export function applyPromptTranslationDependencyNotice(node, report) {
	if (!report || !globalThis.GJJ_CommonDependencyModelNotice?.applyNotice) return;
	globalThis.GJJ_CommonDependencyModelNotice.applyNotice(node, {
		warning_message: report.warning_message || "⚠️缺失运行依赖，点击❓按钮了解详情。",
		panel_message: report.panel_message || report.help_message || report.warning_message || "",
		install_command: report.install_cmd || "",
		optional_install_command: report.optional_install_cmd || "",
		copy_text: report.copy_text || report.install_cmd || report.optional_install_cmd || report.model_download_url || "",
		copy_label: report.copy_label || "",
		model_download_url: report.model_download_url || "",
		notice_level: report.notice_level || "error",
	}, { detailed: true });
}

export async function requestPromptTranslation({
	node = null,
	nodeId = "",
	positive = "",
	negative = "",
	text = "",
	device = "auto",
	maxLength = 512,
	batchSize = 8,
	unloadAfterUse = false,
	nodeName = "",
	endpoint = GJJ_COMMON_PROMPT_TRANSLATE_API,
} = {}) {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			node: String(nodeId || node?.id || ""),
			positive,
			negative,
			text,
			device,
			max_length: maxLength,
			batch_size: batchSize,
			unload_after_use: unloadAfterUse,
			node_name: nodeName,
		}),
	});
	const data = await response.json().catch(() => ({}));
	if (data?.report && node) applyPromptTranslationDependencyNotice(node, data.report);
	if (!response.ok || !data?.ok) {
		const error = new Error(data?.error || `HTTP ${response.status}`);
		error.data = data;
		throw error;
	}
	return data;
}

globalThis.GJJ_CommonPromptTranslation = {
	GJJ_COMMON_PROMPT_TRANSLATE_API,
	GJJ_LEGACY_CLIP_PROMPT_TRANSLATE_API,
	applyPromptTranslationDependencyNotice,
	requestPromptTranslation,
};

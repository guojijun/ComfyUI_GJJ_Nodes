function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return element;
}

export function assistantModelLabel(value) {
	return String(value || "未知").replace(/\.(?:safetensors|gguf|bin|pt|pth|ckpt)$/i, "");
}

export function showAssistantResultPreview(node, message, options = {}) {
	const payload = message?.gjj_assistant_result?.[0]
		?? message?.ui?.gjj_assistant_result?.[0]
		?? message?.gjj_gemma_result?.[0]
		?? message?.ui?.gjj_gemma_result?.[0];
	if (!payload || typeof payload !== "object" || typeof node?.addDOMWidget !== "function") return;

	const stateKey = options.stateKey || "__gjjAssistantResultPreview";
	let state = node[stateKey];
	const incomingModel = assistantModelLabel(payload.model);
	const incomingHasResult = Object.prototype.hasOwnProperty.call(payload, "text");
	if (state && !incomingHasResult && state.model === incomingModel && state.preview.value) return;
	if (!state) {
		const root = protect(document.createElement("div"));
		root.style.cssText = "display:flex;flex-direction:column;gap:5px;box-sizing:border-box;padding:6px 8px 8px;width:100%;color:var(--input-text,#ddd);font:12px/1.35 sans-serif";
		const status = document.createElement("div");
		status.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.textContent = "复制";
		copy.title = "复制生成结果";
		copy.disabled = true;
		copy.style.cssText = "flex:0 0 auto;height:22px;padding:0 8px;border:1px solid var(--border-color,#555);border-radius:5px;background:var(--comfy-input-bg,#222);color:inherit;cursor:pointer";
		const summary = document.createElement("div");
		summary.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.92";
		const preview = document.createElement("textarea");
		preview.readOnly = true;
		preview.rows = 3;
		preview.spellcheck = false;
		preview.style.cssText = "box-sizing:border-box;width:100%;height:58px;min-height:58px;max-height:58px;resize:none;overflow-y:auto;padding:5px 7px;border:1px solid var(--border-color,#555);border-radius:5px;background:var(--comfy-input-bg,#222);color:var(--input-text,#ddd);font:12px/16px monospace;white-space:pre-wrap";
		copy.addEventListener("click", async () => {
			if (!preview.value) return;
			try {
				await navigator.clipboard.writeText(preview.value);
				copy.textContent = "已复制";
			} catch (_) {
				preview.focus();
				preview.select();
				document.execCommand?.("copy");
				copy.textContent = "已复制";
			}
			setTimeout(() => { copy.textContent = "复制"; }, 1200);
		});
		status.append(copy, summary);
		root.append(status, preview);
		preview.style.display = "none";
		const domWidget = node.addDOMWidget(
			options.widgetName || "gjj_assistant_result_preview",
			"HTML",
			root,
			{ serialize: false, hideOnZoom: false },
		);
		domWidget.computeSize = (width) => [
			Math.max(470, Number(width || node.size?.[0] || 470)),
			preview.style.display === "none" ? 36 : 92,
		];
		state = node[stateKey] = { root, summary, preview, copy, domWidget };
	}

	const elapsed = payload.elapsed ? `  ⏰ ${String(payload.elapsed)}` : "";
	state.model = incomingModel;
	state.summary.textContent = `🧠 ${incomingModel}  💾 ${String(payload.model_size || "待执行")}${elapsed}`;
	state.summary.title = state.summary.textContent;
	const hasResult = incomingHasResult;
	if (hasResult) state.preview.value = String(payload.text ?? "").replace(/\r\n/g, " ").replace(/\n/g, " ");
	state.preview.style.display = hasResult ? "" : "none";
	state.copy.disabled = !hasResult || !state.preview.value;
	state.copy.style.display = hasResult ? "" : "none";
	state.copy.style.opacity = state.copy.disabled ? ".5" : "1";
	options.layout?.(node);
	options.resize?.(node);
}

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_BatchTextSegmenter"]);
const STALE_STATUS_WIDGET = "gjj_batch_text_segmenter_status";

function refreshNode(node) {
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function cleanupStaleStatusWidget(node) {
	if (!node?.widgets?.length) {
		return;
	}
	const staleWidgets = node.widgets.filter((widget) => widget?.name === STALE_STATUS_WIDGET);
	if (!staleWidgets.length) {
		return;
	}
	for (const widget of staleWidgets) {
		for (const element of [widget.element, widget.inputEl, widget.widget, widget.domElement].filter(Boolean)) {
			element.style.display = "none";
			element.style.pointerEvents = "none";
			element.remove?.();
		}
		widget.hidden = true;
		widget.draw = () => {};
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.y = -10000;
		widget.last_y = -10000;
	}
	node.widgets = node.widgets.filter((widget) => widget?.name !== STALE_STATUS_WIDGET);
	if (node.__gjjBatchTextSegmenterStatus?.box) {
		node.__gjjBatchTextSegmenterStatus.box.remove?.();
	}
	delete node.__gjjBatchTextSegmenterStatus;
}

function setBackingWarning(node, text) {
	const widget = getWidget(node, "warning_panel");
	if (!widget) {
		return;
	}
	widget.value = text || "等待执行";
	if (widget.inputEl) {
		widget.inputEl.value = widget.value;
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = widget.value;
	}
}

function setStatus(node, text) {
	const value = String(text || "等待执行");
	setBackingWarning(node, value);
	refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjBatchTextStatus) {
		return node.__gjjBatchTextStatus;
	}

	const box = document.createElement("div");
	box.style.cssText = [
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
		"margin-top:8px",
	].join(";");

	const textDisplay = document.createElement("div");
	textDisplay.textContent = "等待执行";
	textDisplay.style.cssText = "margin-bottom:8px;";
	box.appendChild(textDisplay);

	const copyBtn = document.createElement("button");
	copyBtn.textContent = "📋 复制安装命令";
	copyBtn.title = "复制安装命令到剪贴板";
	copyBtn.style.cssText = [
		"padding:6px 12px",
		"border:none",
		"border-radius:6px",
		"background:#ff4757",
		"color:#fff",
		"font-size:12px",
		"cursor:pointer",
		"display:none",
	].join(";");
	copyBtn.addEventListener("mouseenter", () => {
		copyBtn.style.background = "#ff6b6b";
	});
	copyBtn.addEventListener("mouseleave", () => {
		copyBtn.style.background = "#ff4757";
	});
	box.appendChild(copyBtn);

	const widget = node.addDOMWidget?.("batch_text_status", "Status Display", box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 160,
	});

	node.__gjjBatchTextStatus = { widget, box, textDisplay, copyBtn };
	return node.__gjjBatchTextStatus;
}

function patchNode(node) {
	if (!node) {
		return;
	}
	cleanupStaleStatusWidget(node);

	// 初始化状态显示组件
	ensureStatusWidget(node);

	if (node.__gjjBatchTextSegmenterPatched) {
		refreshNode(node);
		return;
	}
	setStatus(node, getWidget(node, "warning_panel")?.value || "等待执行");
	node.__gjjBatchTextSegmenterPatched = true;
	refreshNode(node);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setStatus(targetNode, detail.text || "处理中...");
});

// 监听后端发送的运行时错误事件（包含安装命令）
api.addEventListener("gjj_batch_text_error", (event) => {
	try {
		const data = event.detail || {};
		const nodeId = data.node;
		const errorMessage = data.error || "";
		const installCommand = data.install_command || "";

		if (!nodeId || !errorMessage) return;

		// 查找对应的节点
		const nodes = app.graph?._nodes || [];
		for (const node of nodes) {
			if (String(node.id) === String(nodeId)) {
				const status = node.__gjjBatchTextStatus;
				if (status?.textDisplay) {
					// 显示错误信息
					let displayText = `❌ 执行失败：\n\n${errorMessage}`;

					// 如果有安装命令，添加提示
					if (installCommand) {
						displayText += `\n\n🔧 快速安装命令（点击按钮复制）：`;
					}

					status.textDisplay.textContent = displayText;
					status.textDisplay.style.color = "#ff6b6b";

					// 显示复制按钮
					if (status.copyBtn) {
						status.copyBtn.style.display = "block";
						status.copyBtn.textContent = " 复制安装命令";
						status.copyBtn.title = "复制安装命令到剪贴板";
						status.copyBtn.style.background = "#ff4757";
						status.copyBtn.style.color = "#fff";

						// 更新复制按钮事件，复制安装命令
						const newCopyBtn = status.copyBtn.cloneNode(true);
						status.copyBtn.parentNode.replaceChild(newCopyBtn, status.copyBtn);
						status.copyBtn = newCopyBtn;

						status.copyBtn.addEventListener("click", () => {
							if (installCommand) {
								navigator.clipboard.writeText(installCommand).then(() => {
									const originalText = status.copyBtn.textContent;
									status.copyBtn.textContent = "✅ 已复制";
									status.copyBtn.style.background = "#2ed573";
									setTimeout(() => {
										status.copyBtn.textContent = originalText;
										status.copyBtn.style.background = "#ff4757";
									}, 1500);
								}).catch(err => {
									console.error("[GJJ] 复制失败:", err);
									alert("复制失败，请手动选择安装命令复制");
								});
							}
						});
					}

					setStatus(node, "执行失败");
				}
				break;
			}
		}
	} catch (err) {
		console.error("[GJJ] 处理错误事件失败:", err);
	}
});

app.registerExtension({
	name: "GJJ.BatchTextSegmenter",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			const warningText = message?.warning_text?.[0] || message?.ui?.warning_text?.[0];
			if (warningText) {
				setStatus(this, warningText);
			}
			return result;
		};
	},
	nodeCreated(node) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			patchNode(node);
		}
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				patchNode(node);
			}
		}
	},
});

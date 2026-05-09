// GJJ Checkpoint Direct Generator - 前端增强
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { queueOnlyCurrentNode } from "./gjj_utils.js";

console.log("[GJJ Checkpoint] ⚡ JavaScript 文件已加载");

const TARGET_NODE = "GJJ_CheckpointDirectGenerator";
const STATUS_WIDGET = "gjj_checkpoint_status";
const EXECUTE_BUTTON_NAME = "gjj_execute_button";
const IMAGE_PREVIEW_NAME = "gjj_image_preview";

function cleanupDuplicateWidgets(node, widgetName) {
	if (!node.widgets) return;
	const widgetsToRemove = [];
	let foundFirst = false;

	for (let i = 0; i < node.widgets.length; i++) {
		const widget = node.widgets[i];
		if (widget.name === widgetName) {
			if (!foundFirst) {
				foundFirst = true;
			} else {
				widgetsToRemove.push(i);
				console.log("[GJJ Checkpoint] 清理重复 widget:", widgetName, "位置:", i);
			}
		}
	}

	// 从后往前删除，避免索引问题
	for (let i = widgetsToRemove.length - 1; i >= 0; i--) {
		const idx = widgetsToRemove[i];
		try {
			node.widgets.splice(idx, 1);
		} catch (e) {
			console.log("[GJJ Checkpoint] 清理 widget 失败:", e);
		}
	}
}

function ensureStatusWidget(node) {
	// 先清理重复的
	cleanupDuplicateWidgets(node, STATUS_WIDGET);

	if (node.__gjjCheckpointStatus) {
		return node.__gjjCheckpointStatus;
	}
	// 使用 DOM widget 而不是 canvas 绘制
	const container = document.createElement("div");
	container.style.cssText = [
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:999",
	].join(";");

	const statusBox = document.createElement("div");
	statusBox.style.cssText = [
		"padding:8px 12px",
		"border:1px solid #31464f",
		"border-radius:10px",
		"background:#0f1a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.4",
		"white-space:nowrap",
		"overflow:hidden",
		"text-overflow:ellipsis",
	].join(";");

	const label = document.createElement("div");
	label.textContent = "等待执行";
	label.style.cssText = "margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

	const track = document.createElement("div");
	track.style.cssText = [
		"height:7px",
		"overflow:hidden",
		"border-radius:999px",
		"background:#1a262c",
	].join(";");

	const bar = document.createElement("div");
	bar.style.cssText = [
		"width:8%",
		"height:100%",
		"border-radius:999px",
		"background:linear-gradient(90deg, #36cfc9, #6ea8ff)",
		"transition:width 0.16s ease",
	].join(";");

	track.appendChild(bar);
	statusBox.append(label, track);
	container.appendChild(statusBox);

	// 创建 DOM widget
	const widget = node.addDOMWidget(STATUS_WIDGET, "HTML", container, {
		serialize: false,
	});

	node.__gjjCheckpointStatus = { widget, label, bar };
	console.log("[GJJ Checkpoint] 状态 widget 已初始化");
	return node.__gjjCheckpointStatus;
}

function parseProgress(text) {
	const value = String(text || "");
	const match = value.match(/(\d+)\s*\/\s*(\d+)/);
	if (match) {
		const current = Math.max(0, Number(match[1] || 0));
		const total = Math.max(1, Number(match[2] || 1));
		return Math.max(0, Math.min(100, (current / total) * 100));
	}
	if (value.includes("完成") || value.includes("失败")) {
		return 100;
	}
	return 8;
}

function setStatus(node, text) {
	const state = ensureStatusWidget(node);
	const statusText = String(text || "等待执行");
	console.log("[GJJ Checkpoint] setStatus updated to:", statusText, "node.id:", node?.id);

	// 更新 DOM 元素
	state.label.textContent = statusText;
	const progress = parseProgress(statusText);
	state.bar.style.width = `${Math.max(4, progress)}%`;

	// 刷新节点尺寸
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function createExecuteButton(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:row",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const executeButton = document.createElement("button");
	executeButton.type = "button";
	executeButton.innerHTML = "🚀 运行节点";
	executeButton.title = "只执行当前节点，无需连接其他节点";
	executeButton.style.cssText = [
		"height:32px",
		"padding:0 14px",
		"border:1px solid #10b981",
		"border-radius:6px",
		"background:linear-gradient(135deg, #064e3b, #059669)",
		"color:#a7f3d0",
		"font-size:12px",
		"font-weight:500",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"flex:1",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1001",
		"pointer-events:auto",
		"user-select:none",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"gap:6px",
	].join(";");

	function setupButtonHover(btn, defaultBg, hoverBg) {
		btn.addEventListener("mouseenter", () => {
			btn.style.background = hoverBg;
			btn.style.transform = "translateY(-1px)";
		});
		btn.addEventListener("mouseleave", () => {
			btn.style.background = defaultBg;
			btn.style.transform = "translateY(0)";
		});
		btn.addEventListener("mousedown", () => {
			btn.style.transform = "translateY(0) scale(0.98)";
		});
		btn.addEventListener("mouseup", () => {
			btn.style.transform = "translateY(-1px)";
		});
	}

	function protectEvent(event) {
		event.preventDefault();
		event.stopPropagation();
	}

	function setupButtonEvents(btn, handler) {
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			btn.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}
		btn.addEventListener("pointerup", handler, true);
		btn.addEventListener("click", handler, true);
	}

	async function handleExecute(event) {
		protectEvent(event);

		const originalText = executeButton.innerHTML;
		executeButton.innerHTML = "⏳ 执行中...";
		executeButton.disabled = true;
		executeButton.style.opacity = "0.7";

		try {
			// ✅ 使用 queueOnlyCurrentNode 实现单节点执行
			await queueOnlyCurrentNode(node);

			executeButton.innerHTML = "✅ 已提交";
			executeButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
			executeButton.style.borderColor = "#10b981";
		} catch (error) {
			console.error("[GJJ] 执行节点时发生错误:", error);
			executeButton.innerHTML = "❌ 执行失败";
			executeButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			executeButton.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				executeButton.innerHTML = originalText;
				executeButton.disabled = false;
				executeButton.style.opacity = "1";
				executeButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				executeButton.style.borderColor = "#10b981";
			}, 1500);
		}
	}

	setupButtonHover(executeButton, "linear-gradient(135deg, #064e3b, #059669)", "linear-gradient(135deg, #059669, #10b981)");
	setupButtonEvents(executeButton, handleExecute);

	container.appendChild(executeButton);
	return container;
}

function createImagePreview(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const image = document.createElement("img");
	// ✅ 给自定义预览添加标记，避免被隐藏
	image.dataset.gjjCustomPreview = "true";
	image.style.cssText = [
		"max-width:100%",
		"max-height:400px",
		"object-fit:contain",
		"display:none",
		"cursor:pointer",
		"border-radius:8px",
		"border:1px solid #33434f",
		"background:#0f1418",
		"pointer-events:auto",
		"position:relative",
		"z-index:100",
		"transition:transform 0.2s ease",
	].join(";");

	image.addEventListener("mouseenter", () => {
		image.style.transform = "scale(1.02)";
	});
	image.addEventListener("mouseleave", () => {
		image.style.transform = "scale(1)";
	});

	image.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();

		const overlay = document.createElement("div");
		overlay.style.cssText = [
			"position:fixed",
			"inset:0",
			"background:rgba(0, 0, 0, 0.9)",
			"backdrop-filter:blur(10px)",
			"z-index:10000",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"cursor:zoom-out",
		].join(";");

		const previewImg = document.createElement("img");
		previewImg.src = image.src;
		previewImg.style.cssText = [
			"max-width:90%",
			"max-height:90%",
			"object-fit:contain",
			"border-radius:8px",
			"box-shadow:0 0 40px rgba(0, 0, 0, 0.5)",
			"transition:transform 0.1s ease",
			"cursor:grab",
		].join(";");

		let currentScale = 1;
		const minScale = 0.1;
		const maxScale = 10;

		overlay.addEventListener("wheel", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			currentScale = Math.max(minScale, Math.min(maxScale, currentScale + delta));
			previewImg.style.transform = `scale(${currentScale})`;
		});

		previewImg.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			currentScale = 1;
			previewImg.style.transform = `scale(${currentScale})`;
		});

		const closeHint = document.createElement("div");
		closeHint.textContent = "滚轮缩放 · 双击重置 · 点击关闭";
		closeHint.style.cssText = [
			"position:absolute",
			"bottom:20px",
			"left:50%",
			"transform:translateX(-50%)",
			"color:#fff",
			"font-size:13px",
			"opacity:0.6",
			"pointer-events:none",
			"white-space:nowrap",
		].join(";");

		overlay.appendChild(previewImg);
		overlay.appendChild(closeHint);
		document.body.appendChild(overlay);

		overlay.addEventListener("click", () => {
			overlay.remove();
		});
	});

	// ✅ 在面板上统一阻止所有关键事件，防止被 Canvas 捕获
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "wheel"]) {
		container.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}

	container.appendChild(image);

	node.__gjjPreviewImage = image;
	return container;
}

function imageDataToUrl(imageData) {
	if (!imageData) return null;

	// 处理对象格式（来自 Python 或批量加载器）
	if (typeof imageData === "object" && !Array.isArray(imageData)) {
		imageData = [imageData];
	}

	// 处理数组格式
	if (Array.isArray(imageData) && imageData.length > 0) {
		const img = imageData[0];
		if (typeof img === "object") {
			let filename = img.filename || img.name || img.file || img.path || "";
			let subfolder = img.subfolder || img.sub || "";
			let type = img.type || img.t || "output";

			// 构建标准 URL
			if (filename) {
				const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
				const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
				let url = `/view?filename=${encodeURIComponent(filename)}`;
				if (subfolder) {
					url += `&subfolder=${encodeURIComponent(subfolder)}`;
				}
				if (type) {
					url += `&type=${encodeURIComponent(type)}`;
				}
				url += `${previewFormat}${randParam}`;
				return api.apiURL(url);
			}
		}
	}

	// 处理字符串格式（直接是 filename 或 URL）
	if (typeof imageData === "string") {
		// 如果是完整 URL
		if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
			return imageData;
		}
		// 如果是文件名
		return api.apiURL(`/view?filename=${encodeURIComponent(imageData)}`);
	}

	return null;
}

function updateImagePreview(node, images) {
	if (!node.__gjjPreviewImage) {
		console.log("[GJJ Checkpoint] ⚠️ 预览图片元素不存在");
		return;
	}

	if (!images || !images.length) {
		console.log("[GJJ Checkpoint] ⚠️ 没有图片数据");
		node.__gjjPreviewImage.style.display = "none";
		return;
	}

	const imageUrl = imageDataToUrl(images);
	if (!imageUrl) {
		console.log("[GJJ Checkpoint] ⚠️ 无法转换为 URL:", images);
		node.__gjjPreviewImage.style.display = "none";
		return;
	}

	console.log("[GJJ Checkpoint] 🖼️ 图片预览 URL:", imageUrl);
	node.__gjjPreviewImage.src = imageUrl;
	// 确保自定义预览图的样式完全正常！
	node.__gjjPreviewImage.style.display = "block";
	node.__gjjPreviewImage.style.visibility = "visible";
	node.__gjjPreviewImage.style.height = "";
	node.__gjjPreviewImage.style.width = "";
	node.__gjjPreviewImage.style.margin = "";
	node.__gjjPreviewImage.style.padding = "";
	node.__gjjPreviewImage.style.opacity = "";
	node.__gjjPreviewImage.style.position = "";
	node.__gjjPreviewImage.style.left = "";

	// 添加加载成功/失败回调
	node.__gjjPreviewImage.onload = () => {
		console.log("[GJJ Checkpoint] ✅ 图片加载成功");
	};
	node.__gjjPreviewImage.onerror = () => {
		console.log("[GJJ Checkpoint] ❌ 图片加载失败:", imageUrl);
	};

	// 刷新节点尺寸
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideDefaultPreviewElements(node) {
	// 按照文档中的终极方案：彻底隐藏默认预览
	// 找到节点的 DOM 元素
	let nodeElement = null;
	try {
		// 尝试多种方式获取节点元素
		if (node.imgs) {
			nodeElement = node.imgs;
		} else if (node.element) {
			nodeElement = node.element;
		} else if (node.dummyEl) {
			nodeElement = node.dummyEl;
		} else {
			// 通过 DOM 查找所有可能的节点
			const allCanvasNodes = document.querySelectorAll('.litegraph');
			for (const canvasNode of allCanvasNodes) {
				const potentialNodes = canvasNode.querySelectorAll ?
					canvasNode.querySelectorAll('[data-node-id]') : [];
				for (const el of potentialNodes) {
					if (el.getAttribute('data-node-id') === String(node.id)) {
						nodeElement = el;
						break;
					}
				}
			}
		}
	} catch (e) {
		console.log("[GJJ Checkpoint] Error finding node element:", e);
	}

	// 只要找到了任何节点相关的元素，都尝试查找并隐藏
	if (nodeElement) {
		// 查找所有图片元素
		const allImgs = nodeElement.querySelectorAll ?
			nodeElement.querySelectorAll("img") : [];

		// 隐藏所有非自定义的图片
		for (const img of allImgs) {
			if (!img.dataset?.gjjCustomPreview) {
				img.style.display = "none";
				img.style.visibility = "hidden";
			}
		}

		// 查找所有元素
		const allElements = nodeElement.querySelectorAll ?
			nodeElement.querySelectorAll("*") : [];

		// 隐藏所有看起来是预览的元素
		for (const el of allElements) {
			const classStr = String(el.className || "").toLowerCase();
			const idStr = String(el.id || "").toLowerCase();
			const tagName = String(el.tagName || "").toLowerCase();

			// 判断是否是预览相关的元素
			if (
				classStr.includes("preview") ||
				idStr.includes("preview") ||
				(tagName === "div" && el.querySelector && el.querySelector("img:not([data-gjj-custom-preview='true'])"))) {
				// 检查这个元素是否是我们的自定义预览容器
				let isOurCustomPreview = false;
				const customImgs = el.querySelectorAll ?
					el.querySelectorAll("img[data-gjj-custom-preview='true']") : [];
				if (customImgs.length > 0) {
					isOurCustomPreview = true;
				}

				// 如果不是我们的自定义预览，就隐藏它
				if (!isOurCustomPreview) {
					// 只隐藏明显的预览容器，不隐藏整个节点！
					// 小心地只调整高度！
					el.style.visibility = "hidden";
					el.style.height = "0px";
					el.style.overflow = "hidden";
					el.style.margin = "0px";
					el.style.padding = "0px";
				}
			}
		}
	}
}

function setupPreviewObserver(node) {
	// 按照文档：使用 MutationObserver 实时隐藏默认预览
	// 停止之前的观察器
	if (node.__gjjPreviewObserver) {
		try {
			node.__gjjPreviewObserver.disconnect();
		} catch (e) {
			// 忽略错误
		}
	}

	// 尝试找到节点的 DOM 元素
	let targetElement = null;
	try {
		if (node.imgs) {
			targetElement = node.imgs;
		} else if (node.element) {
			targetElement = node.element;
		} else if (node.dummyEl) {
			targetElement = node.dummyEl;
		}
	} catch (e) {
		// 忽略错误
	}

	// 如果找到了元素，设置观察器
	if (targetElement && targetElement.ownerDocument) {
		node.__gjjPreviewObserver = new MutationObserver((mutations) => {
			// 只要有任何变化，就尝试隐藏预览
			let needsHide = false;

			for (const mutation of mutations) {
				if (mutation.addedNodes && mutation.addedNodes.length > 0) {
					needsHide = true;
					break;
				}
				if (mutation.type === 'attributes' &&
					(mutation.attributeName === 'style' ||
					 mutation.attributeName === 'class' ||
					 mutation.attributeName === 'src')) {
					needsHide = true;
					break;
				}
			}

			if (needsHide) {
				// 延迟隐藏，确保元素完全添加
				setTimeout(() => hideDefaultPreviewElements(node), 0);
				setTimeout(() => hideDefaultPreviewElements(node), 20);
				setTimeout(() => hideDefaultPreviewElements(node), 50);
			}
		});

		// 观察元素的变化
		try {
			node.__gjjPreviewObserver.observe(targetElement, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['style', 'class', 'src'],
			});
		} catch (e) {
			console.log("[GJJ Checkpoint] Error setting up MutationObserver:", e);
		}
	}
}

function stabilizeNode(node) {
	if (!node) return;

	console.log("[GJJ Checkpoint] stabilizeNode 被调用");

	// ⭐ 关键：检查标记，确保只执行一次
	if (node.__gjjStabilized) {
		console.log("[GJJ Checkpoint] 已经初始化过，跳过重复初始化");
		return;
	}
	node.__gjjStabilized = true;

	// ⭐ 关键：直接调用 ensureStatusWidget，它内部已经调用了 addDOMWidget
	ensureStatusWidget(node);

	if (!node.__gjjExecuteButtonWidget) {
		const buttonsContainer = createExecuteButton(node);
		node.__gjjExecuteButtonWidget = node.addDOMWidget(EXECUTE_BUTTON_NAME, "HTML", buttonsContainer, {
			serialize: false,
			hideOnZoom: false,
		});
	}

	if (!node.__gjjImagePreviewWidget) {
		const previewContainer = createImagePreview(node);
		node.__gjjImagePreviewWidget = node.addDOMWidget(IMAGE_PREVIEW_NAME, "HTML", previewContainer, {
			serialize: false,
			hideOnZoom: false,
		});
	}

	setStatus(node, "等待执行");

	// 刷新节点尺寸
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

// 事件监听 - 必须在 registerExtension 之前定义
console.log("[GJJ Checkpoint] 📡 正在注册 gjj_node_progress 事件监听器...");
api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	console.log("[GJJ Checkpoint] 收到进度事件:", detail);

	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode) {
		console.log("[GJJ Checkpoint] 未找到目标节点:", detail.node);
		return;
	}

	const nodeClass = String(targetNode.comfyClass || targetNode.type || "");
	console.log("[GJJ Checkpoint] 节点类型:", nodeClass, "目标类型:", TARGET_NODE);

	if (nodeClass !== TARGET_NODE) {
		console.log("[GJJ Checkpoint] 节点类型不匹配，跳过更新");
		return;
	}

	console.log("[GJJ Checkpoint] 更新状态为:", detail.text);
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "Comfy.GJJ.CheckpointDirectGenerator",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		console.log("[GJJ Checkpoint] 🔍 beforeRegisterNodeDef 被调用，节点名:", nodeData?.name);
		if (nodeData?.name !== TARGET_NODE) {
			return;
		}

		console.log("[GJJ Checkpoint] ✅ 匹配到目标节点，正在注册扩展...");

		// ✅ 隐藏节点默认的图片预览 - 更彻底的方式
		nodeData.output_preview = false;

		// ✅ 确保对所有输出都禁用预览
		if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setStatus(this, "等待执行");

			// 创建观察器，确保任何时候添加的预览都会被隐藏
			this.__gjjPreviewObserver = null;

			setTimeout(() => {
				stabilizeNode(this);

				// 隐藏默认预览元素
				hideDefaultPreviewElements(this);

				// 启动 DOM 变化观察器
				setupPreviewObserver(this);
			}, 0);

			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			setTimeout(() => {
				// ✅ 只更新状态，不调用 stabilizeNode（避免重复创建 widget）
				if (this.__gjjCheckpointStatus) {
					setStatus(this, "等待执行");
				}
				// 隐藏默认预览元素
				hideDefaultPreviewElements(this);
			}, 0);
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			console.log("[GJJ Checkpoint] onExecuted message:", message);

			// ❌ 不调用 originalExecuted，避免显示默认预览！
			// const result = originalExecuted?.apply(this, [message]);

			// 处理不同格式的图片数据
			let images = null;

			if (message?.images) {
				images = message.images;
			} else if (message?.ui?.images) {
				images = message.ui.images;
			} else if (message?.output?.images) {
				images = message.output.images;
			} else if (message?.results?.images) {
				images = message.results.images;
			} else if (Array.isArray(message?.ui)) {
				// 处理 ui 是数组的情况
				for (const uiItem of message.ui) {
					if (uiItem?.images) {
						images = uiItem.images;
						break;
					}
				}
			}

			if (images) {
				console.log("[GJJ Checkpoint] Updating image preview with images:", images);
				updateImagePreview(this, images);
			}

			// 按照文档：不管怎样都执行一次隐藏，确保之前的被隐藏
			setTimeout(() => hideDefaultPreviewElements(this), 0);
			setTimeout(() => hideDefaultPreviewElements(this), 50);
			setTimeout(() => hideDefaultPreviewElements(this), 150);

			// 不返回 result，因为我们没有调用 originalExecuted
			return;
		};
	},
});

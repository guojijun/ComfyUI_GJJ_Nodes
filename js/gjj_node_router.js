// GJJ NodeRouter v3.0 - 使用 node.properties 管理状态（彻底解决重建问题）
import { app } from "/scripts/app.js";

// 目标节点
const TARGET_NODES = new Set(["GJJ_NodeRouter"]);

// 模式常量
const MODE_SINGLE = "单选";
const MODE_MULTI = "多选";
const MODE_VALUES = [MODE_SINGLE, MODE_MULTI];
const MODE_NAME = "选择模式";

// 过滤关键词常量
const FILTER_NAME = "过滤关键词";
const FILTER_LABEL = "过滤关键词";
const FILTER_PLACEHOLDER = "留空显示全部节点";
const FILTER_TOOLTIP = "输入节点名称中的关键词进行筛选；留空时显示当前工作流中的全部节点。";

// 空状态常量
const EMPTY_STATE_NAME = "节点状态提示";
const EMPTY_STATE_LABEL = "节点状态提示";
const EMPTY_STATE_TEXT = "当前没有节点，或没有匹配到包含该关键词的节点。";
const EMPTY_STATE_TOOLTIP = "没有可切换的节点时，会在这里显示中文状态提示。";

function getNodes() {
	return Array.isArray(app.graph?._nodes) ? [...app.graph._nodes] : [];
}

function getNodeSignature(nodes = getNodes()) {
	return nodes
		.map((node) => {
			const title = String(node?.title || node?.comfyClass || "");
			const left = Number(node?.pos?.[0] || 0);
			const top = Number(node?.pos?.[1] || 0);
			const width = Number(node?.size?.[0] || 0);
			const height = Number(node?.size?.[1] || 0);
			return `${title}|${left},${top}|${width},${height}`;
		})
		.sort()
		.join("||");
}

function sortNodes(nodes) {
	return [...nodes].sort((a, b) => String(a?.title || a?.comfyClass || "").localeCompare(String(b?.title || b?.comfyClass || ""), "zh-Hans-CN"));
}

function getFilterText(node) {
	// 直接从 node.properties 读取
	return String(node.properties?.[FILTER_NAME] || "").trim().toLowerCase();
}

function getMatchedNodes(node) {
	const filterText = getFilterText(node);
	// 使用 node.id 比较，而不是对象引用，避免工作流加载时引用不同导致的问题
	// 关键修复：排除所有 GJJ_NodeRouter 同类节点，避免路由节点互相管理
	const nodes = sortNodes(
		getNodes().filter((n) => {
			if (!n) return false;
			// 不显示当前路由节点自己
			if (n.id === node.id) return false;
			// 不显示其它同类路由节点，避免路由节点互相禁用
			if (TARGET_NODES.has(n.comfyClass)) return false;
			return true;
		})
	);
	if (!filterText) {
		return nodes;
	}

	return nodes.filter((n) => {
		const title = String(n?.title || n?.comfyClass || "").toLowerCase();
		const category = String(n?.constructor?.nodeData?.category || n?.nodeData?.category || "").toLowerCase();
		const comfyClass = String(n?.comfyClass || "").toLowerCase();

		return title.includes(filterText) ||
			   category.includes(filterText) ||
			   comfyClass.includes(filterText);
	});
}

function getSelectionMode(node) {
	// 直接从 node.properties 读取
	const value = String(node.properties?.[MODE_NAME] || MODE_SINGLE);
	return MODE_VALUES.includes(value) ? value : MODE_SINGLE;
}

function updateSelectionMode(node, mode) {
	// 直接保存到 node.properties
	if (!node.properties) node.properties = {};
	node.properties[MODE_NAME] = MODE_VALUES.includes(mode) ? mode : MODE_SINGLE;
}

function updateFilterText(node, text) {
	// 直接保存到 node.properties
	if (!node.properties) node.properties = {};
	node.properties[FILTER_NAME] = String(text || "");
}

function pruneMissingActiveNodeIds(node) {
	if (!node.properties) node.properties = {};

	const activeIds = Array.isArray(node.properties.__activeNodeIds)
		? node.properties.__activeNodeIds
		: [];

	const existingIds = new Set(getNodes().map(n => n.id));
	const nextIds = activeIds.filter(id => existingIds.has(id));

	if (nextIds.length !== activeIds.length) {
		console.log(
			`[NodeRouter] pruneMissingActiveNodeIds - node ${node.id}, before:`,
			activeIds,
			"after:",
			nextIds
		);

		node.properties.__activeNodeIds = nextIds;
		node.graph?.change?.();
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	return nextIds;
}

function getActiveNodeRefs(node) {
	// 从 node.properties 读取激活的节点 ID 列表
	const activeIds = node.properties?.__activeNodeIds || [];
	if (!Array.isArray(activeIds)) return new Set();

	// 返回节点对象集合（根据 ID 查找）
	const allNodes = getNodes();
	return new Set(
		activeIds
			.map(id => allNodes.find(n => n.id === id))
			.filter(n => n !== undefined)
	);
}

function setActiveNodeRefs(node, nodes) {
	// 保存节点 ID 列表到 node.properties
	if (!node.properties) node.properties = {};
	const nodeList = Array.isArray(nodes) ? nodes.filter(Boolean) : [...(nodes || [])].filter(Boolean);
	const activeIds = nodeList.map(n => n.id).filter(id => id !== undefined);

	console.log(`[NodeRouter] setActiveNodeRefs - BEFORE save - node ${node.id}, node.properties:`, node.properties);
	console.log(`[NodeRouter] setActiveNodeRefs - saving - node ${node.id}, activeIds:`, activeIds);

	// 总是保存，不检查变化（因为删除节点时会触发重建）
	node.properties.__activeNodeIds = activeIds;

	console.log(`[NodeRouter] setActiveNodeRefs - AFTER save - node ${node.id}, node.properties:`, node.properties);
	console.log(`[NodeRouter] setActiveNodeRefs - node ${node.id}, count:`, activeIds.length, 'IDs:', activeIds);

	// 通知 ComfyUI 节点已更改（确保 properties 被序列化）
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function trimActiveNodesForMode(node) {
	const activeNodes = [...getActiveNodeRefs(node)];
	if (getSelectionMode(node) === MODE_SINGLE && activeNodes.length > 1) {
		setActiveNodeRefs(node, [activeNodes[0]]);
	}
}

function setNodeState(targetNode, isActive, controllerNode) {
	if (!targetNode) return;
	if (targetNode === controllerNode) return;

	// 保险：永远不要禁用其它 GJJ_NodeRouter
	if (TARGET_NODES.has(targetNode.comfyClass)) return;

	targetNode.mode = isActive ? 0 : 2;
}

function releaseManagedNodes(node, nextNodes = []) {
	const nextNodeSet = new Set(nextNodes);
	const previousNodes = Array.isArray(node.__gjjManagedNodes) ? node.__gjjManagedNodes : [];
	previousNodes.forEach((n) => {
		if (!n) return;

		// 不处理其它 NodeRouter
		if (TARGET_NODES.has(n.comfyClass)) return;

		if (!nextNodeSet.has(n)) {
			setNodeState(n, false, node);
		}
	});
	node.__gjjManagedNodes = [...nextNodes].filter(
		(n) => n && !TARGET_NODES.has(n.comfyClass)
	);
}

function applyMatchedNodeModes(node, nodes = getMatchedNodes(node)) {
	if (!Array.isArray(nodes) || nodes.length === 0) {
		return;
	}

	trimActiveNodesForMode(node);
	const activeNodes = getActiveNodeRefs(node);
	nodes.forEach((n) => {
		setNodeState(n, activeNodes.has(n), node);
	});
}

function syncFilterToOriginalWidget(node) {
	const filterWidget = (node.widgets || []).find((w) => w?.name === FILTER_NAME && w.type !== "HTML");
	const currentFilter = getFilterText(node);
	if (filterWidget && filterWidget.value !== currentFilter) {
		filterWidget.value = String(currentFilter || "");
		if (filterWidget.inputEl) {
			filterWidget.inputEl.value = String(currentFilter || "");
		}
		filterWidget.callback?.(currentFilter);
	}
}






function ensureRouterPanelWidget(node) {
	if (node.__gjjRouterPanelWidget?.element instanceof HTMLElement) {
		return node.__gjjRouterPanelWidget;
	}

	const panel = document.createElement("div");
	panel.className = "gjj-node-router-panel";
	panel.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"padding:4px 0",
		"margin:0",
		"pointer-events:auto",
	].join(";");

	const widget = node.addDOMWidget("GJJ_NodeRouter_Panel", "HTML", panel, {
		serialize: false,
		hideOnZoom: false,
	});

	widget.serialize = false;
	widget.__gjjRouterPanel = true;
	// 确保高度计算准确，避免空行
	widget.computeSize = (width) => {
		const h = Number(node.__gjjRouterPanelHeight || 120);
		return [Math.max(180, Number(width || 180)), h];
	};
	widget.computedHeight = () => Number(node.__gjjRouterPanelHeight || 120);
	widget.parent = node;
	widget.disabled = false;

	node.__gjjRouterPanelWidget = widget;
	return widget;
}

function renderRouterPanel(node) {
	if (!node.properties) node.properties = {};

	const widget = ensureRouterPanelWidget(node);
	const panel = widget.element;
	if (!(panel instanceof HTMLElement)) return;

	const matchedNodes = getMatchedNodes(node);
	const activeNodes = getActiveNodeRefs(node);
	const currentMode = getSelectionMode(node);
	const filterValue = String(node.properties?.[FILTER_NAME] || "");

	panel.innerHTML = "";

	// 模式行
	const modeRow = document.createElement("div");
	modeRow.style.cssText = [
		"display:flex",
		"gap:4px",
		"width:100%",
	].join(";");

	MODE_VALUES.forEach((modeValue) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = modeValue;

		const active = modeValue === currentMode;
		btn.style.cssText = [
			"flex:1",
			"height:30px",
			"border:1px solid " + (active ? "#5aa8ff" : "#3b5560"),
			"border-radius:6px",
			"background:" + (active ? "#2d5a9e" : "#2a3f4a"),
			"color:#fff",
			"font:700 13px sans-serif",
			"cursor:pointer",
		].join(";");

		btn.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();

			updateSelectionMode(node, modeValue);

			let selected = getActiveNodeRefs(node);
			if (modeValue === MODE_SINGLE && selected.size > 1) {
				const first = [...selected][0];
				selected = new Set(first ? [first] : []);
				setActiveNodeRefs(node, selected);
			}

			applyMatchedNodeModes(node);
			renderRouterPanel(node);
			refreshNodeSize(node);
		});

		modeRow.appendChild(btn);
	});

	const masterBtn = document.createElement("button");
	masterBtn.type = "button";
	const allSelected = matchedNodes.length > 0 && matchedNodes.every(n => activeNodes.has(n));
	masterBtn.textContent = allSelected ? "🟢" : "🔴";
	masterBtn.title = allSelected ? "点击全部禁用" : "点击全部启用";
	masterBtn.style.cssText = [
		"width:38px",
		"height:30px",
		"border:1px solid #3b5560",
		"border-radius:6px",
		"background:" + (allSelected ? "#3d7c47" : "#8b2a2a"),
		"color:#fff",
		"font:700 15px sans-serif",
		"cursor:pointer",
		"display:" + (currentMode === MODE_MULTI ? "block" : "none"),
	].join(";");

	masterBtn.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();

		if (allSelected) {
			setActiveNodeRefs(node, []);
		} else {
			setActiveNodeRefs(node, matchedNodes);
		}

		applyMatchedNodeModes(node);
		renderRouterPanel(node);
		refreshNodeSize(node);
	});

	modeRow.appendChild(masterBtn);
	panel.appendChild(modeRow);

	// 过滤行
	const filterRow = document.createElement("div");
	filterRow.style.cssText = [
		"display:flex",
		"align-items:center",
		"gap:6px",
		"width:100%",
	].join(";");

	const filterLabel = document.createElement("span");
	filterLabel.textContent = FILTER_LABEL;
	filterLabel.style.cssText = [
		"font:12px sans-serif",
		"color:#b8c7d0",
		"white-space:nowrap",
	].join(";");

	const filterInput = document.createElement("input");
	filterInput.type = "text";
	filterInput.value = filterValue;
	filterInput.placeholder = FILTER_PLACEHOLDER;
	filterInput.style.cssText = [
		"flex:1",
		"min-width:0",
		"height:28px",
		"box-sizing:border-box",
		"border:1px solid #2f4148",
		"border-radius:6px",
		"background:#2b3035",
		"color:#eaf3f7",
		"padding:0 8px",
		"font:12px sans-serif",
		"outline:none",
	].join(";");

	let filterTimer = null;
	let isComposing = false; // 标记是否正在中文输入法输入

	// 中文输入法事件处理
	filterInput.addEventListener("compositionstart", (event) => {
		isComposing = true;
		event.stopPropagation();
	});

	filterInput.addEventListener("compositionend", (event) => {
		isComposing = false;
		event.stopPropagation();

		// 中文输入结束后，立即触发过滤
		updateFilterText(node, event.target.value);
		if (filterTimer) clearTimeout(filterTimer);
		filterTimer = setTimeout(() => {
			renderRouterPanel(node);
			refreshNodeSize(node);

			// 尽量恢复焦点
			const nextInput = node.__gjjRouterPanelWidget?.element?.querySelector("input");
			if (nextInput) {
				nextInput.focus();
				const len = nextInput.value.length;
				nextInput.setSelectionRange(len, len);
			}
		}, 80);
	});

	filterInput.addEventListener("input", (event) => {
		// 如果正在使用中文输入法，不处理 input 事件，等待 compositionend
		if (isComposing) {
			event.stopPropagation();
			return;
		}

		updateFilterText(node, event.target.value);

		if (filterTimer) clearTimeout(filterTimer);
		filterTimer = setTimeout(() => {
			renderRouterPanel(node);
			refreshNodeSize(node);

			// 尽量恢复焦点
			const nextInput = node.__gjjRouterPanelWidget?.element?.querySelector("input");
			if (nextInput) {
				nextInput.focus();
				const len = nextInput.value.length;
				nextInput.setSelectionRange(len, len);
			}
		}, 80);
	});

	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "keydown", "keyup", "wheel"]) {
		filterInput.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}

	filterRow.appendChild(filterLabel);
	filterRow.appendChild(filterInput);
	panel.appendChild(filterRow);

	// 按钮列表
	if (matchedNodes.length === 0) {
		const empty = document.createElement("div");
		empty.textContent = EMPTY_STATE_TEXT;
		empty.style.cssText = [
			"box-sizing:border-box",
			"width:100%",
			"min-height:30px",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"border:1px solid #2f4148",
			"border-radius:6px",
			"background:#1c2a30",
			"color:#9fb0b8",
			"font:12px sans-serif",
			"padding:6px",
			"text-align:center",
		].join(";");
		panel.appendChild(empty);
	} else {
		matchedNodes.forEach((targetNode) => {
			const title = String(targetNode?.title || targetNode?.comfyClass || "未命名节点");
			const isActive = activeNodes.has(targetNode);

			const btn = document.createElement("button");
			btn.type = "button";
			btn.textContent = `${isActive ? "✅ " : "❌ "}${title}`;
			btn.title = `切换节点"${title}"的启用状态`;
			btn.style.cssText = [
				"width:100%",
				"height:30px",
				"min-width:0",
				"box-sizing:border-box",
				"border:1px solid " + (isActive ? "#48ad73" : "#3b5560"),
				"border-radius:5px",
				"background:" + (isActive ? "#1f6b43" : "#20323a"),
				"color:#edf6fa",
				"font:700 12px sans-serif",
				"cursor:pointer",
				"overflow:hidden",
				"text-overflow:ellipsis",
				"white-space:nowrap",
			].join(";");

			btn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();

				const selected = getActiveNodeRefs(node);
				const nowActive = selected.has(targetNode);

				if (nowActive) {
					selected.delete(targetNode);
				} else {
					if (getSelectionMode(node) === MODE_SINGLE) {
						selected.clear();
					}
					selected.add(targetNode);
				}

				setActiveNodeRefs(node, selected);
				applyMatchedNodeModes(node);
				renderRouterPanel(node);
				refreshNodeSize(node);
			});

			panel.appendChild(btn);
		});
	}

	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "wheel"]) {
		panel.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}

	node.__gjjRouterPanelHeight = 72 + matchedNodes.length * 36 + (matchedNodes.length === 0 ? 42 : 0);
}

function refreshNodeSize(node) {
	const width = Math.max(180, Number(node.size?.[0] || 220));
	const height = Math.max(120, Number(node.computeSize?.()?.[1] || 120));

	node.size = [width, height];

	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideOriginalPythonWidgets(node) {
	// 隐藏原始的 Python widgets（"过滤关键词" 和 "选择模式"）
	// 参考：SKILL/动态插槽、动态输入、动态输出口实现方式.md - 坑1：隐藏 Widget 仍然占空行
	const widgetsToHide = [FILTER_NAME, MODE_NAME];
	if (node.widgets) {
		node.widgets.forEach((widget) => {
			if (widgetsToHide.includes(widget.name)) {
				// 按照 SKILL 文档标准方法隐藏 Widget
				widget.type = "hidden";
				widget.hidden = true;
				widget.serialize = true;
				widget.computeSize = () => [0, 0];
				widget.draw = () => {};
				widget.label = "";
				if (widget.inputEl) widget.inputEl.style.display = "none";
				if (widget.element) widget.element.style.display = "none";
				if (widget.widget) widget.widget.style.display = "none";
			}
		});
	}
}

function rebuildUI(node, options = {}) {
	const force = Boolean(options.force);

	console.log(`[NodeRouter] rebuildUI called for node ${node.id}, force=${force}`);

	if (!node.properties) node.properties = {};

	// 清理旧的 router panel widget，避免重复添加
	if (node.__gjjRouterPanelWidget) {
		const oldWidget = node.__gjjRouterPanelWidget;
		// 从 widgets 数组中移除
		if (node.widgets) {
			const index = node.widgets.indexOf(oldWidget);
			if (index !== -1) {
				node.widgets.splice(index, 1);
			}
		}
		// 清除 DOM 元素
		if (oldWidget.element && oldWidget.element.parentNode) {
			oldWidget.element.parentNode.removeChild(oldWidget.element);
		}
		// 清除引用
		node.__gjjRouterPanelWidget = null;
	}

	// 隐藏原始的 Python widgets（每次重建时都确保隐藏）
	hideOriginalPythonWidgets(node);

	pruneMissingActiveNodeIds(node);

	const currentSignature = getNodeSignature();
	const savedActiveIds = (node.properties?.__activeNodeIds || []).slice().sort().join(',');
	const nodeStateSignature = `${getFilterText(node)}|${getSelectionMode(node)}|${savedActiveIds}`;
	const fullSignature = `${currentSignature}||${nodeStateSignature}`;

	// 非强制刷新时才允许跳过
	if (!force && node.__gjjNodeSignature === fullSignature && node.__gjjRouterPanelWidget?.element instanceof HTMLElement) {
		console.log(`[NodeRouter] rebuildUI skipped - signature unchanged for node ${node.id}`);
		return;
	}

	releaseManagedNodes(node, getMatchedNodes(node));

	renderRouterPanel(node);

	node.__gjjNodeSignature = fullSignature;

	applyMatchedNodeModes(node);
	refreshNodeSize(node);
}

function refreshAllNodeRouters(force = false) {
	console.log(`[NodeRouter] refreshAllNodeRouters called, force=${force}`);

	const routers = (app.graph?._nodes || []).filter((node) => {
		return TARGET_NODES.has(node?.comfyClass);
	});

	// 先恢复所有 Router 本身，避免被误 Muted
	routers.forEach((node) => {
		node.mode = 0;
	});

	routers.forEach((node) => {
		console.log(`[NodeRouter] refreshAllNodeRouters - rebuilding node ${node.id}`);
		node.__gjjNodeSignature = null;
		rebuildUI(node, { force });
	});
}

app.registerExtension({
	name: "GJJ.NodeRouter",

	nodeCreated(node, app) {
		if (!TARGET_NODES.has(node.comfyClass)) {
			return;
		}

		// 存储定时器 ID，以便 onConfigure 可以取消（工作流加载时）
		node.__nodeCreatedTimer = setTimeout(() => {
			rebuildUI(node, { force: true });
			// 添加帮助按钮
			if (typeof window.__gjjEnsureHelpWidget === "function") {
				window.__gjjEnsureHelpWidget(node);
			}
		}, 300);
	},

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (!TARGET_NODES.has(nodeData.name)) {
			return;
		}

		const originalOnConfigure = nodeType.prototype.onConfigure;

		// onSerialize：选择模式、过滤关键词和激活节点状态存到 properties
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function(serializedNode) {
			console.log(`[NodeRouter] onSerialize - START - node ${this.id}, this.properties:`, this.properties);

			if (originalOnSerialize) {
				// 不要捕获返回值，onSerialize 不应该返回任何东西
				originalOnSerialize.call(this, serializedNode);
			}

			serializedNode.properties = serializedNode.properties || {};

			console.log(`[NodeRouter] onSerialize - AFTER originalOnSerialize - node ${this.id}, this.properties:`, this.properties);
			console.log(`[NodeRouter] onSerialize - AFTER originalOnSerialize - node ${this.id}, serializedNode.properties:`, serializedNode.properties);

			// 保存当前状态到 properties（直接覆盖，不使用条件判断）
			serializedNode.properties[MODE_NAME] = this.properties?.[MODE_NAME] || MODE_SINGLE;
			serializedNode.properties[FILTER_NAME] = this.properties?.[FILTER_NAME] || "";

			// 保存激活的节点 ID 列表（即使为空也要保存）
			serializedNode.properties.__activeNodeIds = this.properties?.__activeNodeIds || [];

			console.log(`[NodeRouter] onSerialize - FINAL - node ${this.id}, serializedNode.properties:`, serializedNode.properties);
			// 明确不返回任何东西
			return;
		};

		nodeType.prototype.onConfigure = function(serialized) {
			console.log(`[NodeRouter] onConfigure called for node ${this.id}`);
			console.log(`[NodeRouter] onConfigure - serialized.properties:`, serialized?.properties);

			if (originalOnConfigure) {
				originalOnConfigure.call(this, serialized);
			}

			// 恢复 properties 到 node.properties（ComfyUI 应该会自动处理，但为了确保兼容）
			if (serialized?.properties) {
				this.properties = this.properties || {};
				Object.assign(this.properties, serialized.properties);
			}

			console.log(`[NodeRouter] onConfigure - node ${this.id}, properties after restore:`, this.properties);

			// 取消 nodeCreated 的定时器，避免重复重建
			clearTimeout(this.__nodeCreatedTimer);

			// 标记节点已经配置过，防止 setup() 重复重建
			this.__configured = true;

			// 隐藏原始的 Python widgets（"过滤关键词" 和 "选择模式"）
			// 从工作流加载时也需要隐藏
			hideOriginalPythonWidgets(this);

			console.log(`[NodeRouter] onConfigure - node ${this.id}, scheduling rebuildUI in 300ms`);
			// 从工作流加载时，延迟重建 UI
			setTimeout(() => {
				rebuildUI(this, { force: true });
			}, 300);
		};

		const originalOnExecutionStart = nodeType.prototype.onExecutionStart;

		nodeType.prototype.onExecutionStart = function() {
			if (originalOnExecutionStart) {
				originalOnExecutionStart.call(this);
			}
			applyMatchedNodeModes(this);
		};

		// Hook addWidget 立即隐藏原始控件
		const originalAddWidget = nodeType.prototype.addWidget;
		if (originalAddWidget) {
			nodeType.prototype.addWidget = function(...args) {
				const widget = originalAddWidget.apply(this, args);
				// 如果是原始控件（"过滤关键词" 或 "选择模式"），立即隐藏
				const widgetsToHide = [FILTER_NAME, MODE_NAME];
				if (widget && widgetsToHide.includes(widget.name)) {
					// 按照 SKILL 文档标准方法隐藏 Widget
					widget.type = "hidden";
					widget.hidden = true;
					widget.serialize = true;
					widget.computeSize = () => [0, 0];
					widget.draw = () => {};
					widget.label = "";
					// 延迟设置样式，确保 widget 已完全创建
					setTimeout(() => {
						if (widget.inputEl) widget.inputEl.style.display = "none";
						if (widget.element) widget.element.style.display = "none";
						if (widget.widget) widget.widget.style.display = "none";
					}, 0);
				}
				return widget;
			};
		}

		// 隐藏 Python 后端的原始控件，避免重复显示
		const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

		nodeType.prototype.onNodeCreated = function() {
			if (originalOnNodeCreated) {
				originalOnNodeCreated.call(this);
			}

			// 隐藏原始的 Python widgets（"过滤关键词" 和 "选择模式"）
			hideOriginalPythonWidgets(this);
		};
	},

	async setup() {
		const originalAddNode = app.graph?.addNode;
		let rebuildTimer = null;
		const scheduleRebuild = () => {
			if (rebuildTimer) {
				clearTimeout(rebuildTimer);
			}

			rebuildTimer = setTimeout(() => {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						refreshAllNodeRouters(true);
						rebuildTimer = null;
					});
				});
			}, 100);
		};

		// 注意：不在 setup() 中调用 rebuildUI，而是依赖 onConfigure（工作流加载）和 nodeCreated（新节点）来处理
		// 这样可以避免 setup() 在 onConfigure 之前执行导致的状态丢失问题

		if (originalAddNode) {
			app.graph.addNode = function(...args) {
				const result = originalAddNode.apply(this, args);
				// 不调用 scheduleRebuild，由 nodeCreated 和 onNodeAdded 处理重建
				return result;
			};
		}

		const originalOnNodeMoved = app.graph?.onNodeMoved;
		app.graph.onNodeMoved = function(node) {
			if (originalOnNodeMoved) {
				originalOnNodeMoved.call(this, node);
			}
			scheduleRebuild();
		};

		const originalOnNodeAdded = app.graph?.onNodeAdded;
		app.graph.onNodeAdded = function(node) {
			if (originalOnNodeAdded) {
				originalOnNodeAdded.call(this, node);
			}
			// 不调用 scheduleRebuild，由 nodeCreated 处理重建
			// 如果是其他节点（非节点路由）添加/删除/移动，才触发 scheduleRebuild
			if (!TARGET_NODES.has(node?.comfyClass)) {
				scheduleRebuild();
			}
		};

		const originalOnNodeRemoved = app.graph?.onNodeRemoved;
		app.graph.onNodeRemoved = function(node) {
			if (originalOnNodeRemoved) {
				originalOnNodeRemoved.call(this, node);
			}
			scheduleRebuild();
		};
	}
});

function clearNodeWidgets(node) {
	// 单 DOMWidget 方案下，不再暴力删除 widgets。
	// 保留函数，避免其它地方调用时报错。
}



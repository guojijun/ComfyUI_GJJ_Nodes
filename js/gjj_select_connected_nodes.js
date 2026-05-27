import { app } from "/scripts/app.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "GJJ.SelectConnectedNodesMenu";
	const HIGHLIGHT_COLOR = "#4f7fbf";
	const HIGHLIGHT_MS = 650;

	function graphNodes() {
		return Array.isArray(app.graph?._nodes) ? app.graph._nodes.filter(Boolean) : [];
	}

	function graphLinks() {
		return app.graph?.links || {};
	}

	function getNodeById(id) {
		return app.graph?.getNodeById?.(id) || graphNodes().find((node) => String(node?.id) === String(id)) || null;
	}

	function selectedNodes() {
		const canvas = app.canvas;
		const result = [];
		const seen = new Set();

		function add(node) {
			if (!node || seen.has(node.id)) {
				return;
			}
			seen.add(node.id);
			result.push(node);
		}

		const selected = canvas?.selected_nodes;
		if (selected instanceof Map) {
			for (const node of selected.values()) add(node);
		} else if (Array.isArray(selected)) {
			for (const node of selected) add(node);
		} else if (selected && typeof selected === "object") {
			for (const node of Object.values(selected)) add(node);
		}

		for (const node of graphNodes()) {
			if (node?.selected) add(node);
		}
		return result;
	}

	function sourceNodesForMenu(clickedNode) {
		const current = selectedNodes();
		if (clickedNode && current.some((node) => node?.id === clickedNode.id)) {
			return current;
		}
		return clickedNode ? [clickedNode] : current;
	}

	function directUpstream(node) {
		const links = graphLinks();
		const result = [];
		for (const input of node?.inputs || []) {
			const link = links[input?.link];
			const upstream = link ? getNodeById(link.origin_id) : null;
			if (upstream) result.push(upstream);
		}
		return result;
	}

	function directDownstream(node) {
		const links = graphLinks();
		const result = [];
		for (const output of node?.outputs || []) {
			for (const linkId of output?.links || []) {
				const link = links[linkId];
				const downstream = link ? getNodeById(link.target_id) : null;
				if (downstream) result.push(downstream);
			}
		}
		return result;
	}

	function collectConnected(startNodes, direction) {
		const startIds = new Set(startNodes.map((node) => node?.id).filter((id) => id !== undefined && id !== null));
		const result = [];
		const seen = new Set(startIds);
		const queue = [...startNodes];
		const nextNodes = direction === "upstream" ? directUpstream : directDownstream;

		while (queue.length) {
			const node = queue.shift();
			for (const next of nextNodes(node)) {
				if (!next || seen.has(next.id)) {
					continue;
				}
				seen.add(next.id);
				result.push(next);
				queue.push(next);
			}
		}
		return result;
	}

	function selectNodes(nodes) {
		const canvas = app.canvas;
		if (!canvas) {
			return;
		}
		if (typeof canvas.deselectAllNodes === "function") {
			canvas.deselectAllNodes();
		} else if (typeof canvas.deselectAll === "function") {
			canvas.deselectAll();
		}
		for (const node of graphNodes()) {
			node.selected = false;
		}

		const selected = {};
		for (const node of nodes) {
			node.selected = true;
			selected[node.id] = node;
		}
		canvas.selected_nodes = selected;
		canvas._selected_nodes = selected;
		if (typeof canvas.setSelectedNodes === "function") {
			canvas.setSelectedNodes(selected);
		}
		canvas.selected_group = null;
		canvas.dragging_rectangle = null;
		canvas.node_dragged = null;
		app.graph?.setDirtyCanvas?.(true, true);
		canvas.setDirty?.(true, true);
	}

	function scheduleSelectNodes(nodes, delays = [0, 60, 180, HIGHLIGHT_MS + 80, HIGHLIGHT_MS + 260]) {
		const ids = nodes.map((node) => node?.id).filter((id) => id !== undefined && id !== null);
		for (const delay of delays) {
			setTimeout(() => {
				const currentNodes = ids.map((id) => getNodeById(id)).filter(Boolean);
				if (currentNodes.length) {
					selectNodes(currentNodes);
				}
			}, delay);
		}
	}

	function boundsFor(nodes) {
		let left = Infinity;
		let top = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		for (const node of nodes) {
			const x = Number(node?.pos?.[0] || 0);
			const y = Number(node?.pos?.[1] || 0);
			const width = Number(node?.size?.[0] || 180);
			const height = Number(node?.size?.[1] || 90);
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x + width);
			bottom = Math.max(bottom, y + height);
		}
		if (!Number.isFinite(left)) {
			return null;
		}
		return { left, top, right, bottom, width: right - left, height: bottom - top };
	}

	function fitNodes(nodes) {
		const canvas = app.canvas;
		if (!canvas || !nodes.length) {
			return;
		}
		if (nodes.length === 1 && typeof canvas.centerOnNode === "function") {
			canvas.centerOnNode(nodes[0]);
			return;
		}

		const ds = canvas.ds || canvas.viewport;
		const canvasEl = canvas.canvas || canvas.canvas_mouse;
		const bounds = boundsFor(nodes);
		if (!bounds || !ds || !Array.isArray(ds.offset) || !canvasEl) {
			if (typeof canvas.fitViewToSelection === "function") {
				canvas.fitViewToSelection();
			} else if (typeof canvas.fitView === "function") {
				canvas.fitView();
			}
			return;
		}

		const viewWidth = Number(canvasEl.width || canvasEl.clientWidth || window.innerWidth || 1);
		const viewHeight = Number(canvasEl.height || canvasEl.clientHeight || window.innerHeight || 1);
		const margin = 180;
		const fitScale = Math.min(
			viewWidth / Math.max(bounds.width + margin, 1),
			viewHeight / Math.max(bounds.height + margin, 1)
		);
		const targetScale = Math.max(0.25, Math.min(1.25, fitScale || 1));

		try {
			if (typeof ds.changeScale === "function") {
				ds.changeScale(targetScale, [viewWidth / 2, viewHeight / 2]);
			} else {
				ds.scale = targetScale;
			}
		} catch (_) {
			ds.scale = targetScale;
		}

		const scale = Number(ds.scale || targetScale || 1);
		const centerX = (bounds.left + bounds.right) / 2;
		const centerY = (bounds.top + bounds.bottom) / 2;
		ds.offset[0] = viewWidth / (2 * scale) - centerX;
		ds.offset[1] = viewHeight / (2 * scale) - centerY;
	}

	function flashNodes(nodes) {
		for (const node of nodes) {
			const previous = node.bgcolor;
			node.bgcolor = HIGHLIGHT_COLOR;
			clearTimeout(node.__gjjSelectConnectedFlashTimer);
			node.__gjjSelectConnectedFlashTimer = setTimeout(() => {
				node.bgcolor = previous;
				app.graph?.setDirtyCanvas?.(true, true);
			}, HIGHLIGHT_MS);
		}
		app.graph?.setDirtyCanvas?.(true, true);
	}

	function selectConnected(clickedNode, direction) {
		const start = sourceNodesForMenu(clickedNode);
		const nodes = collectConnected(start, direction);
		if (!nodes.length) {
			return;
		}
		selectNodes(nodes);
		fitNodes(nodes);
		flashNodes(nodes);
		scheduleSelectNodes(nodes);
		app.canvas?.setDirty?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	function nodeRegistryName(node) {
		const raw = String(node?.comfyClass || node?.type || node?.constructor?.type || "");
		return raw.replace(/^GJJ_/, "");
	}

	function copyText(text) {
		if (!text) {
			return;
		}
		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
			return;
		}
		fallbackCopyText(text);
	}

	function fallbackCopyText(text) {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.left = "-10000px";
		textarea.style.top = "0";
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		try {
			document.execCommand("copy");
		} catch (_) {}
		textarea.remove();
	}

	function copyNodeRegistryName(node) {
		copyText(nodeRegistryName(node));
	}

	function addMenuOptions(node, options) {
		if (!node || !Array.isArray(options)) {
			return;
		}
		options.unshift(null);
		options.unshift({
			content: "📋 复制节点注册名称",
			callback: () => copyNodeRegistryName(node),
		});
		options.unshift({
			content: "⬇️ 选择下游节点",
			callback: () => selectConnected(node, "downstream"),
		});
		options.unshift({
			content: "⬆️ 选择上游节点",
			callback: () => selectConnected(node, "upstream"),
		});
	}

	app.registerExtension({
		name: EXTENSION_NAME,
		beforeRegisterNodeDef(nodeType) {
			const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
			nodeType.prototype.getExtraMenuOptions = function (_, options) {
				if (originalGetExtraMenuOptions) {
					originalGetExtraMenuOptions.call(this, _, options);
				}
				addMenuOptions(this, options);
			};
		},
	});
})();

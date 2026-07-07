import { app } from "/scripts/app.js";

const NODE_TYPE = "GJJ_ImageConcanate";
const MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,MASK,VIDEO";
const INPUT_PREFIX = "media_";
const PANEL_WIDGET = "gjj_image_concatenate_buttons";
const HELD_MEDIA_WIDGET = "held_media_json";
const HELD_ACTIVE_WIDGET = "held_active";
const LINK_MEMORY_PROPERTY = "gjj_image_concat_last_upstream_links";
const CACHED_MEDIA_PROPERTY = "gjj_image_concat_cached_media";

const DIRECTIONS = [
	{ value: "up", icon: "⬆", title: "向上拼接" },
	{ value: "down", icon: "⬇", title: "向下拼接" },
	{ value: "left", icon: "⬅", title: "向左拼接" },
	{ value: "right", icon: "➡", title: "向右拼接" },
	{ value: "square", icon: "🪟", title: "尽量拼成正方形" },
];

function inputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function inputIndex(name) {
	const match = String(name || "").match(/^media_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function mediaInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX)).sort((a, b) => inputIndex(a.name) - inputIndex(b.name))
		: [];
}

function setDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function serializedSize(serializedNode) {
	const size = serializedNode?.size;
	if (!Array.isArray(size)) return null;
	const width = Number(size[0]);
	const height = Number(size[1]);
	return Number.isFinite(width) && Number.isFinite(height) && height > 0 ? [width, height] : null;
}

function rememberConfiguredSize(node, serializedNode) {
	const size = serializedSize(serializedNode);
	if (!size) return;
	node.__gjjImageConcatConfiguredSize = size;
}

function restoreConfiguredSize(node) {
	const size = node?.__gjjImageConcatConfiguredSize;
	if (!Array.isArray(size)) return;
	const width = Number(size[0]);
	const height = Number(size[1]);
	if (!Number.isFinite(height) || height <= 0) return;
	if (Array.isArray(node.size)) {
		node.size[0] = Number.isFinite(width) && width > 0 ? width : Number(node.size[0] || 180);
		node.size[1] = height;
	} else {
		node.size = [Number.isFinite(width) && width > 0 ? width : 180, height];
	}
}

function widgetByName(node, name) {
	return node?.widgets?.find?.((widget) => widget?.name === name);
}

function hideNativeWidget(widget) {
	if (!widget || widget.__gjjImageConcatHidden) return;
	widget.__gjjImageConcatHidden = true;
	widget.__gjjSavedType = widget.type;
	widget.__gjjSavedComputeSize = widget.computeSize;
	widget.__gjjSavedGetHeight = widget.getHeight;
	widget.__gjjSavedDraw = widget.draw;
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
}

function setWidgetValue(node, name, value) {
	const widget = widgetByName(node, name);
	if (widget) {
		widget.value = value;
		widget.callback?.(value, app.canvas, node, app.canvas?.graph_mouse);
	}
	node.properties ||= {};
	node.properties[name] = value;
}

function boolValue(node) {
	return Boolean(widgetByName(node, "match_image_size")?.value);
}

function directionValue(node) {
	const value = String(widgetByName(node, "direction")?.value || "right");
	return DIRECTIONS.some((item) => item.value === value) ? value : "right";
}

function getGraphLink(linkId, graph = app.graph) {
	if (linkId == null || !graph) return null;
	if (typeof graph.getLink === "function") {
		const link = graph.getLink(linkId);
		if (link) return link;
	}
	const links = graph.links || graph._links;
	if (!links) return null;
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	if (links instanceof Map) return links.get(linkId) || links.get(String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function getGraphNodeById(id, graph = app.graph) {
	if (id == null || !graph) return null;
	return graph.getNodeById?.(id)
		|| graph.getNodeById?.(Number(id))
		|| graph._nodes_by_id?.[id]
		|| graph._nodes_by_id?.[String(id)]
		|| graph._nodes?.find((node) => String(node?.id) === String(id))
		|| null;
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkOriginSlot(link) {
	return Number(Array.isArray(link) ? link[2] : link?.origin_slot);
}

function linkTargetSlot(link) {
	return Number(Array.isArray(link) ? link[4] : link?.target_slot);
}

function sourceNodeTitle(node) {
	return String(node?.title || node?.comfyClass || node?.type || `节点 ${node?.id ?? ""}`).trim();
}

function sourceOutputLabel(node, slot) {
	const output = node?.outputs?.[Number(slot)];
	return String(output?.label || output?.name || output?.type || `输出 ${Number(slot) + 1}`);
}

function linkedInputs(node) {
	return mediaInputs(node).filter((input) => input?.link != null);
}

function linkMemory(node) {
	const value = node?.properties?.[LINK_MEMORY_PROPERTY];
	return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function saveLinkMemory(node, records) {
	node.properties ||= {};
	node.properties[LINK_MEMORY_PROPERTY] = records;
}

function storeCurrentLinks(node) {
	const graph = node?.graph || app.graph;
	const records = [];
	for (const input of mediaInputs(node)) {
		const link = getGraphLink(input?.link, graph);
		if (!link) continue;
		const sourceId = linkOriginId(link);
		const sourceSlot = linkOriginSlot(link);
		const sourceNode = getGraphNodeById(sourceId, graph);
		if (sourceId == null || !Number.isFinite(sourceSlot)) continue;
		records.push({
			source_id: sourceId,
			source_slot: sourceSlot,
			source_title: sourceNodeTitle(sourceNode),
			source_label: sourceOutputLabel(sourceNode, sourceSlot),
			target_input_name: String(input.name || ""),
			target_slot: Number.isFinite(linkTargetSlot(link)) ? linkTargetSlot(link) : node.inputs?.indexOf(input),
		});
	}
	records.sort((left, right) => inputIndex(left.target_input_name) - inputIndex(right.target_input_name));
	saveLinkMemory(node, records);
	return records;
}

function ensureReconnectInput(node, record) {
	const name = String(record?.target_input_name || "");
	const desiredIndex = inputIndex(name);
	if (Number.isFinite(desiredIndex) && desiredIndex !== Number.MAX_SAFE_INTEGER) {
		while (mediaInputs(node).length < desiredIndex) {
			node.addInput?.(inputName(mediaInputs(node).length + 1), MEDIA_TYPE);
		}
		labelInputs(node);
		const byName = mediaInputs(node).find((input) => String(input.name || "") === name);
		if (byName) return byName;
	}
	const empty = mediaInputs(node).find((input) => input?.link == null);
	if (empty) return empty;
	node.addInput?.(inputName(mediaInputs(node).length + 1), MEDIA_TYPE);
	labelInputs(node);
	return mediaInputs(node).find((input) => input?.link == null) || mediaInputs(node).at(-1) || null;
}

function disconnectMediaInputs(node) {
	let count = 0;
	for (const [index, input] of [...(node.inputs || [])].entries()) {
		if (!String(input?.name || "").startsWith(INPUT_PREFIX) || input.link == null) continue;
		if (typeof node.disconnectInput === "function") {
			node.disconnectInput(index);
		} else {
			app.graph?.removeLink?.(input.link);
		}
		count += 1;
	}
	return count;
}

function setHeldState(node, active, records = null) {
	const mediaRecords = records || [];
	const mediaJson = active ? JSON.stringify(mediaRecords) : "";
	setWidgetValue(node, HELD_MEDIA_WIDGET, mediaJson);
	setWidgetValue(node, HELD_ACTIVE_WIDGET, Boolean(active));
	node.properties ||= {};
	node.properties[CACHED_MEDIA_PROPERTY] = mediaRecords;
}

function cachedMediaRecords(node) {
	const direct = node?.__gjjImageConcatCachedMedia;
	if (Array.isArray(direct) && direct.length) return direct;
	const prop = node?.properties?.[CACHED_MEDIA_PROPERTY];
	if (Array.isArray(prop)) return prop;
	const raw = String(widgetByName(node, HELD_MEDIA_WIDGET)?.value || "").trim();
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch (_) {
		return [];
	}
}

function flashLinkButton(node, text, ok = true) {
	const button = node?.__gjjImageConcatLinkButton;
	if (!button) return;
	clearTimeout(button.__gjjFlashTimer);
	const previous = button.textContent;
	const previousBackground = button.style.background;
	button.textContent = text;
	button.style.background = ok ? "#245B44" : "#5B2E2E";
	button.__gjjFlashTimer = setTimeout(() => {
		button.textContent = previous || "🔗";
		button.style.background = previousBackground;
		refreshButtons(node);
	}, 900);
}

function reconnectLinks(node) {
	const graph = node?.graph || app.graph;
	let connected = 0;
	let missing = 0;
	for (const record of linkMemory(node)) {
		const sourceNode = getGraphNodeById(record.source_id, graph);
		const sourceSlot = Number(record.source_slot);
		if (!sourceNode?.outputs?.[sourceSlot]) {
			missing += 1;
			continue;
		}
		const input = ensureReconnectInput(node, record);
		const targetSlot = node.inputs?.indexOf(input);
		if (!input || targetSlot < 0) {
			missing += 1;
			continue;
		}
		if (input.link != null) {
			try { node.disconnectInput?.(targetSlot); } catch (_) {}
		}
		try {
			sourceNode.connect(sourceSlot, node, targetSlot);
			connected += 1;
		} catch (error) {
			console.warn("[GJJ_ImageConcanate] reconnect upstream failed", error);
			missing += 1;
		}
	}
	setHeldState(node, false, cachedMediaRecords(node));
	stabilize(node);
	flashLinkButton(node, connected ? (missing ? `连${connected}` : "已连") : "无源", connected > 0);
	return connected > 0;
}

function holdAndDisconnect(node) {
	const records = cachedMediaRecords(node);
	if (!records.length) {
		flashLinkButton(node, "先运行", false);
		return false;
	}
	storeCurrentLinks(node);
	setHeldState(node, true, records);
	const count = disconnectMediaInputs(node);
	stabilize(node);
	flashLinkButton(node, count ? "已断" : "无线", count > 0);
	return count > 0;
}

function toggleLinkHold(node) {
	if (linkedInputs(node).length) return holdAndDisconnect(node);
	return reconnectLinks(node);
}

function buttonStyle(button) {
	button.style.border = "0";
	button.style.borderRadius = "6px";
	button.style.background = "#172229";
	button.style.color = "#EAF7EE";
	button.style.fontSize = "15px";
	button.style.fontWeight = "700";
	button.style.lineHeight = "1";
	button.style.minWidth = "28px";
	button.style.height = "30px";
	button.style.padding = "0";
	button.style.cursor = "pointer";
	button.style.boxSizing = "border-box";
}

function activeButton(button, active) {
	button.style.background = active ? "#245B44" : "#172229";
	button.style.boxShadow = "none";
}

function refreshButtons(node) {
	const panel = node.__gjjImageConcatPanel;
	if (!panel) return;
	const direction = directionValue(node);
	const match = boolValue(node);
	for (const button of panel.querySelectorAll("[data-direction]")) {
		activeButton(button, button.dataset.direction === direction);
	}
	const matchButton = panel.querySelector("[data-match]");
	if (matchButton) {
		activeButton(matchButton, match);
		matchButton.title = match ? "匹配首图尺寸：开" : "匹配首图尺寸：关";
	}
	const linkButton = panel.querySelector("[data-link-hold]");
	if (linkButton) {
		const hasLinks = linkedInputs(node).length > 0;
		const heldActive = Boolean(widgetByName(node, HELD_ACTIVE_WIDGET)?.value);
		const hasMemory = linkMemory(node).length > 0;
		linkButton.style.display = hasLinks || heldActive || hasMemory ? "" : "none";
		linkButton.textContent = heldActive && !hasLinks ? "🔗" : "🔗";
		linkButton.title = hasLinks
			? "保存当前上游结果并断开链接"
			: "恢复断开前的上游链接";
		activeButton(linkButton, heldActive && !hasLinks);
	}
}

function createPanel(node) {
	if (node.__gjjImageConcatPanel || typeof node.addDOMWidget !== "function") return;
	hideNativeWidget(widgetByName(node, "direction"));
	hideNativeWidget(widgetByName(node, "match_image_size"));
	hideNativeWidget(widgetByName(node, HELD_MEDIA_WIDGET));
	hideNativeWidget(widgetByName(node, HELD_ACTIVE_WIDGET));

	const root = document.createElement("div");
	root.style.display = "flex";
	root.style.alignItems = "center";
	root.style.gap = "0";
	root.style.padding = "0";
	root.style.width = "100%";
	root.style.boxSizing = "border-box";

	const directionRow = document.createElement("div");
	directionRow.style.display = "flex";
	directionRow.style.gap = "0";
	directionRow.style.flexWrap = "nowrap";

	for (const item of DIRECTIONS) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = item.icon;
		button.title = item.title;
		button.dataset.direction = item.value;
		buttonStyle(button);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(node, "direction", item.value);
			refreshButtons(node);
			setDirty(node);
		});
		directionRow.appendChild(button);
	}

	const matchButton = document.createElement("button");
	matchButton.type = "button";
	matchButton.textContent = "✳️";
	matchButton.dataset.match = "1";
	buttonStyle(matchButton);
	matchButton.style.marginLeft = "0";
	matchButton.addEventListener("pointerdown", (event) => event.stopPropagation());
	matchButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setWidgetValue(node, "match_image_size", !boolValue(node));
		refreshButtons(node);
		setDirty(node);
	});

	const linkButton = document.createElement("button");
	linkButton.type = "button";
	linkButton.textContent = "🔗";
	linkButton.dataset.linkHold = "1";
	buttonStyle(linkButton);
	linkButton.style.marginLeft = "0";
	linkButton.addEventListener("pointerdown", (event) => event.stopPropagation());
	linkButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		toggleLinkHold(node);
		refreshButtons(node);
		setDirty(node);
	});

	root.appendChild(directionRow);
	root.appendChild(matchButton);
	root.appendChild(linkButton);
	node.__gjjImageConcatPanel = root;
	node.__gjjImageConcatLinkButton = linkButton;

	const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	domWidget.computeSize = (width) => [Math.round(width || node.size?.[0] || 180), 38];
	domWidget.getHeight = () => 38;
	refreshButtons(node);
}

function trimUnusedTail(node) {
	const inputs = mediaInputs(node);
	let changed = false;
	for (let index = inputs.length - 1; index >= 1; index -= 1) {
		const input = inputs[index];
		if (input?.link) break;
		const slot = node.inputs.indexOf(input);
		if (slot >= 0) {
			try { node.disconnectInput?.(slot); } catch (_) {}
			node.removeInput?.(slot);
			changed = true;
		}
	}
	return changed;
}

function ensureTrailingInput(node) {
	const inputs = mediaInputs(node);
	if (!inputs.length || inputs[inputs.length - 1]?.link) {
		node.addInput?.(inputName(inputs.length + 1), MEDIA_TYPE);
		return true;
	}
	return false;
}

function labelInputs(node) {
	let changed = false;
	mediaInputs(node).forEach((input, zeroIndex) => {
		const index = zeroIndex + 1;
		const name = inputName(index);
		const label = `媒体 ${index}`;
		const tooltip = `第 ${index} 个拼接媒体，支持 GJJ_BATCH_IMAGE、IMAGE、MASK、VIDEO；连接最后一个口后会自动扩展。`;
		if (input.name !== name) {
			input.name = name;
			changed = true;
		}
		if (input.type !== MEDIA_TYPE) {
			input.type = MEDIA_TYPE;
			changed = true;
		}
		if (input.label !== label) {
			input.label = label;
			changed = true;
		}
		if (input.localized_name !== label) {
			input.localized_name = label;
			changed = true;
		}
		if (input.tooltip !== tooltip) {
			input.tooltip = tooltip;
			changed = true;
		}
	});
	return changed;
}

function stabilize(node) {
	if (!node || (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE)) return;
	createPanel(node);
	hideNativeWidget(widgetByName(node, "direction"));
	hideNativeWidget(widgetByName(node, "match_image_size"));
	hideNativeWidget(widgetByName(node, HELD_MEDIA_WIDGET));
	hideNativeWidget(widgetByName(node, HELD_ACTIVE_WIDGET));
	const trimmed = trimUnusedTail(node);
	const trailing = ensureTrailingInput(node);
	const labeled = labelInputs(node);
	refreshButtons(node);
	if (trimmed || trailing || labeled) setDirty(node);
}

function firstMessageValue(value) {
	if (Array.isArray(value) && value.length === 1) return value[0];
	return value;
}

function updateCachedMediaFromMessage(node, message) {
	const records = firstMessageValue(message?.gjj_image_concat_cached_media);
	if (!Array.isArray(records)) return;
	node.__gjjImageConcatCachedMedia = records;
	node.properties ||= {};
	node.properties[CACHED_MEDIA_PROPERTY] = records;
	const active = Boolean(widgetByName(node, HELD_ACTIVE_WIDGET)?.value);
	if (active) {
		setHeldState(node, true, records);
	}
	refreshButtons(node);
}

function schedule(node, delay = 32) {
	clearTimeout(node.__gjjImageConcatTimer);
	node.__gjjImageConcatTimer = setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.ImageConcanate.DynamicInputs",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			rememberConfiguredSize(this, serializedNode);
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			restoreConfiguredSize(this);
			setTimeout(() => {
				stabilize(this);
				restoreConfiguredSize(this);
			}, 0);
			setTimeout(() => {
				stabilize(this);
				restoreConfiguredSize(this);
			}, 80);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			const [type, slot, connected] = args || [];
			const isInputEvent = type === globalThis.LiteGraph?.INPUT || type === 1 || String(type).toLowerCase() === "input";
			if (isInputEvent && connected && String(this.inputs?.[Number(slot)]?.name || "").startsWith(INPUT_PREFIX)) {
				storeCurrentLinks(this);
			}
			schedule(this);
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalExecuted?.call(this, message);
			updateCachedMediaFromMessage(this, message || {});
			return result;
		};

		const originalDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalDrawBackground?.apply(this, args);
			const signature = mediaInputs(this).map((input) => `${input.name}:${input.link || ""}`).join("|");
			if (signature !== this.__gjjImageConcatSignature) {
				this.__gjjImageConcatSignature = signature;
				schedule(this, 16);
			}
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE) {
				stabilize(node);
			}
		}
	},
});

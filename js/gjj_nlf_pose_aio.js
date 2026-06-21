import { app } from "/scripts/app.js";

(function () {
	"use strict";

	const NODE_NAME = "GJJ_NLFPoseAIO";
	const DEFAULT_HEIGHT = 36;
	const INLINE_UI = new Map();
	const BACKEND_UI = new Map();

	function normalizeName(value) {
		return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
	}

	function cleanList(values) {
		return Array.isArray(values) ? values.map((value) => String(value ?? "").trim()).filter(Boolean) : [];
	}

	function unique(values) {
		const seen = new Set();
		const result = [];
		for (const value of values || []) {
			const key = normalizeName(value);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			result.push(String(value));
		}
		return result;
	}

	function widgetNames(widget) {
		return [
			widget?.name,
			widget?.label,
			widget?.localized_name,
			widget?.display_name,
			widget?.options?.display_name,
			widget?.options?.label,
		].map(normalizeName).filter(Boolean);
	}

	function widgetBySpec(node, spec) {
		const aliases = unique([spec?.name, ...(spec?.aliases || [])]).map(normalizeName);
		return node?.widgets?.find?.((widget) => {
			const names = widgetNames(widget);
			return aliases.some((alias) => names.includes(alias));
		});
	}

	function boolValue(value) {
		if (typeof value === "string") {
			return /^(true|1|yes|on|是|开|启用)$/i.test(value.trim());
		}
		return Boolean(value);
	}

	function setDirty(node) {
		node?.setDirtyCanvas?.(true, true);
		node?.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}

	function collapseElement(element) {
		if (!element?.style) return;
		element.style.display = "none";
		element.style.pointerEvents = "none";
		element.style.height = "0px";
		element.style.minHeight = "0px";
		element.style.maxHeight = "0px";
		element.style.margin = "0px";
		element.style.padding = "0px";
		element.style.border = "0px";
		element.style.overflow = "hidden";
	}

	function collapseWidget(widget) {
		if (!widget) return;
		if (!widget.__gjjNLFPoseOriginalState) {
			widget.__gjjNLFPoseOriginalState = {
				type: widget.type,
				computeSize: widget.computeSize,
				getHeight: widget.getHeight,
				draw: widget.draw,
				mouse: widget.mouse,
				label: widget.label,
				localized_name: widget.localized_name,
				display_name: widget.display_name,
				size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
				y: widget.y,
				last_y: widget.last_y,
				computedHeight: widget.computedHeight,
				margin_top: widget.margin_top,
			};
		}
		widget.hidden = true;
		widget.type = "hidden";
		widget.label = "";
		widget.localized_name = "";
		widget.display_name = "";
		widget.serialize = true;
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.size = [0, 0];
		widget.y = -100000;
		widget.last_y = -100000;
		widget.computedHeight = 0;
		widget.margin_top = 0;
		widget.options ||= {};
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.options.display_name = "";
		for (const element of [widget.inputEl, widget.element, widget.widget, widget.container, widget.domElement]) {
			collapseElement(element);
		}
	}

	function currentNodeWidth(node) {
		const width = Number(node?.size?.[0]);
		return Number.isFinite(width) && width > 0 ? Math.round(width) : 360;
	}

	function setWidgetValue(node, spec, value) {
		const widget = widgetBySpec(node, spec);
		if (!widget) return;
		widget.value = value;
		if (widget.inputEl) widget.inputEl.value = widget.value;
		if (widget.element && "value" in widget.element) widget.element.value = widget.value;
		widget.callback?.(widget.value, app.canvas, node, app.canvas?.graph_mouse);
	}

	function comboValues(widget) {
		const raw = widget?.options?.values || widget?.options?.comboValues || widget?.values || [];
		if (!Array.isArray(raw)) return [];
		return raw.map((item) => {
			if (item && typeof item === "object") return String(item.value ?? item.name ?? item.label ?? "");
			return String(item ?? "");
		}).map((item) => item.trim()).filter(Boolean);
	}

	function compactModelKey(value) {
		return String(value ?? "")
			.toLowerCase()
			.replace(/\\/g, "/")
			.split("/")
			.pop()
			.replace(/\.[^.]+$/, "")
			.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
	}

	function chooseModelValue(widget, spec) {
		const autoValues = new Set(unique(["Auto", "自动", "智能查找", ...(spec.auto_values || [])]).map(normalizeName));
		const values = comboValues(widget).filter((value) => !autoValues.has(normalizeName(value)));
		if (!values.length) return "";
		const preferred = cleanList(spec.preferred).map(compactModelKey).filter(Boolean);
		let best = values[0];
		let bestScore = -1;
		for (const value of values) {
			const key = compactModelKey(value);
			let score = 1;
			for (let index = 0; index < preferred.length; index += 1) {
				const token = preferred[index];
				if (!token) continue;
				if (key === token) score += 1000 - index;
				else if (key.includes(token)) score += 500 - index;
				else if (token.includes(key)) score += 120 - index;
			}
			if (score > bestScore) {
				best = value;
				bestScore = score;
			}
		}
		return best;
	}

	function replaceAutoModels(node, config) {
		for (const spec of config.modelDefaults || []) {
			const widget = widgetBySpec(node, spec);
			if (!widget) continue;
			const autoValues = new Set(unique(["Auto", "自动", "智能查找", ...(spec.auto_values || [])]).map(normalizeName));
			const current = normalizeName(widget.value);
			const validValues = new Set(comboValues(widget).map(normalizeName));
			if (current && !autoValues.has(current) && (!validValues.size || validValues.has(current))) continue;
			const value = chooseModelValue(widget, spec);
			if (!value) continue;
			setWidgetValue(node, spec, value);
		}
	}

	function styleButton(button, active, available) {
		button.style.height = "28px";
		button.style.minWidth = "0";
		button.style.flex = "1 1 0";
		button.style.padding = "0 5px";
		button.style.borderRadius = "6px";
		button.style.border = `1px solid ${active ? "#69c98f" : "#3e4d54"}`;
		button.style.background = active ? "#255c43" : "#182229";
		button.style.color = available ? "#eaf7ee" : "#6d7a80";
		button.style.boxShadow = active ? "0 0 0 1px rgba(105,201,143,.24) inset" : "none";
		button.style.font = "600 11px/1 ui-sans-serif, system-ui, 'Microsoft YaHei', sans-serif";
		button.style.cursor = available ? "pointer" : "not-allowed";
		button.style.whiteSpace = "nowrap";
		button.style.overflow = "hidden";
		button.style.textOverflow = "ellipsis";
		button.style.boxSizing = "border-box";
		button.style.opacity = available ? "1" : ".55";
	}

	function refreshButtons(node) {
		const panel = node.__gjjNLFPoseBoolPanel;
		if (!panel) return;
		for (const item of panel.items || []) {
			const button = panel.buttons?.[item.name];
			if (!button) continue;
			const widget = widgetBySpec(node, item);
			const active = boolValue(widget?.value);
			const available = Boolean(widget);
			button.disabled = !available;
			button.setAttribute("aria-pressed", active ? "true" : "false");
			button.title = `${item.title || item.label || item.name}：${active ? "开" : "关"}`;
			styleButton(button, active, available);
		}
	}

	function firstButtonRow(config) {
		const rows = Array.isArray(config.boolButtonRows) ? config.boolButtonRows : [];
		return rows.find((row) => Array.isArray(row.items) && row.items.length) || null;
	}

	function buildPanel(node, config) {
		const row = firstButtonRow(config);
		if (!row) return null;
		const height = Math.max(24, Math.round(Number(row.height || DEFAULT_HEIGHT) || DEFAULT_HEIGHT));
		const root = document.createElement("div");
		root.style.display = "flex";
		root.style.alignItems = "center";
		root.style.gap = "5px";
		root.style.width = "100%";
		root.style.height = `${height}px`;
		root.style.padding = "4px 0 2px";
		root.style.boxSizing = "border-box";
		root.style.overflow = "hidden";

		const buttons = {};
		for (const item of row.items) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = item.label || item.name;
			button.dataset.widget = item.name;
			button.addEventListener("pointerdown", (event) => event.stopPropagation());
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const widget = widgetBySpec(node, item);
				if (!widget) return;
				setWidgetValue(node, item, !boolValue(widget.value));
				refreshButtons(node);
				setDirty(node);
			});
			buttons[item.name] = button;
			root.appendChild(button);
		}

		node.__gjjNLFPoseBoolPanel = { root, buttons, items: row.items, height };
		return root;
	}

	function ensurePanel(node, config) {
		if (!node || typeof node.addDOMWidget !== "function") return;
		const row = firstButtonRow(config);
		if (!row) return;
		const signature = JSON.stringify(row.items?.map((item) => [item.name, item.label, item.title]) || []);
		if (node.__gjjNLFPoseBoolWidget && node.__gjjNLFPosePanelSignature === signature) return;

		const root = buildPanel(node, config);
		if (!root) return;
		const height = node.__gjjNLFPoseBoolPanel?.height || DEFAULT_HEIGHT;
		const widgetName = row.widget_name || "gjj_nlf_pose_bool_buttons";
		const widget = node.addDOMWidget(widgetName, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
		});
		if (widget) {
			widget.serialize = false;
			widget.value = undefined;
			widget.options ||= {};
			widget.options.serialize = false;
			widget.computeSize = (width) => [Math.round(Number(width || currentNodeWidth(node))), height];
			widget.getHeight = () => height;
			node.__gjjNLFPoseBoolWidget = widget;
			node.__gjjNLFPosePanelSignature = signature;
		}
	}

	function normalizedSpec(item) {
		if (!item || typeof item !== "object") return null;
		const name = String(item.name || "").trim();
		if (!name) return null;
		return {
			...item,
			name,
			aliases: unique([name, ...(item.aliases || [])]),
		};
	}

	function emptyConfig() {
		return { hiddenWidgets: [], boolButtonRows: [], modelDefaults: [] };
	}

	function mergeConfig(...configs) {
		const result = emptyConfig();
		for (const config of configs) {
			if (!config) continue;
			result.hiddenWidgets.push(...(config.hiddenWidgets || []));
			result.boolButtonRows.push(...(config.boolButtonRows || []));
			result.modelDefaults.push(...(config.modelDefaults || []));
		}
		result.hiddenWidgets = result.hiddenWidgets.map(normalizedSpec).filter(Boolean);
		result.modelDefaults = result.modelDefaults.map(normalizedSpec).filter(Boolean);
		result.boolButtonRows = result.boolButtonRows.map((row) => ({
			...row,
			items: (row.items || []).map(normalizedSpec).filter(Boolean),
		})).filter((row) => row.items.length);
		return result;
	}

	function parseBackendUi(ui) {
		const config = emptyConfig();
		config.hiddenWidgets = Array.isArray(ui?.hidden_widgets) ? ui.hidden_widgets : [];
		config.modelDefaults = Array.isArray(ui?.model_defaults) ? ui.model_defaults : [];
		config.boolButtonRows = Array.isArray(ui?.bool_button_rows) ? ui.bool_button_rows : [];
		return mergeConfig(config);
	}

	function inputSections(nodeData) {
		const input = nodeData?.input || nodeData?.inputs || {};
		return [input.required, input.optional, input.hidden].filter(Boolean);
	}

	function parseInlineUi(nodeData) {
		const config = emptyConfig();
		for (const section of inputSections(nodeData)) {
			for (const [name, raw] of Object.entries(section || {})) {
				const options = Array.isArray(raw) && raw[1] && typeof raw[1] === "object" ? raw[1] : {};
				const ui = options.gjj_ui || options.gjjUI || options.ui || {};
				if (!ui || typeof ui !== "object") continue;
				const aliases = unique([name, options.display_name, ...(ui.aliases || [])]);
				const base = {
					...ui,
					name,
					aliases,
					label: ui.label || ui.button_label || options.display_name || name,
					title: ui.title || options.tooltip || options.display_name || name,
				};
				if (ui.hidden === true) {
					config.hiddenWidgets.push(base);
				}
				if (ui.control === "bool_button" || ui.button_row) {
					const rowId = String(ui.button_row || "default");
					let row = config.boolButtonRows.find((item) => item.id === rowId);
					if (!row) {
						row = {
							id: rowId,
							widget_name: ui.widget_name || "gjj_bool_buttons",
							height: ui.height || DEFAULT_HEIGHT,
							items: [],
						};
						config.boolButtonRows.push(row);
					}
					row.items.push(base);
				}
				if (ui.auto_model_default === true || ui.control === "model_default") {
					config.modelDefaults.push(base);
				}
			}
		}
		return mergeConfig(config);
	}

	function configForNode(node) {
		const className = String(node?.comfyClass || node?.type || NODE_NAME);
		return mergeConfig(INLINE_UI.get(className), BACKEND_UI.get(className));
	}

	function stabilize(node) {
		if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
		const config = configForNode(node);
		replaceAutoModels(node, config);
		ensurePanel(node, config);
		for (const item of config.hiddenWidgets || []) {
			collapseWidget(widgetBySpec(node, item));
		}
		refreshButtons(node);
		setDirty(node);
	}

	function schedule(node, delay = 0) {
		clearTimeout(node.__gjjNLFPoseBoolTimer);
		node.__gjjNLFPoseBoolTimer = setTimeout(() => stabilize(node), Math.round(Number(delay) || 0));
	}

	let backendLoadPromise = null;
	function loadBackendUi() {
		if (backendLoadPromise) return backendLoadPromise;
		backendLoadPromise = fetch("/gjj/node_help")
			.then((response) => response.ok ? response.json() : {})
			.then((payload) => {
				for (const [className, data] of Object.entries(payload || {})) {
					const ui = data?.ui || data?.help?.ui || null;
					if (ui) BACKEND_UI.set(String(className), parseBackendUi(ui));
				}
			})
			.catch((error) => console.warn("[GJJ] NLF Pose UI配置加载失败", error));
		return backendLoadPromise;
	}

	app.registerExtension({
		name: "GJJ.NLFPoseAIO.ConfiguredUI",
		beforeRegisterNodeDef(nodeType, nodeData) {
			if (nodeData?.name !== NODE_NAME) return;
			INLINE_UI.set(NODE_NAME, parseInlineUi(nodeData));

			const originalAddWidget = nodeType.prototype.addWidget;
			nodeType.prototype.addWidget = function (...args) {
				const widget = originalAddWidget?.apply(this, args);
				const config = configForNode(this);
				if (config.hiddenWidgets.some((item) => widgetBySpec({ widgets: [widget] }, item) === widget)) {
					collapseWidget(widget);
				}
				return widget;
			};

			const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) {
				const result = originalOnNodeCreated?.apply(this, args);
				schedule(this, 0);
				setTimeout(() => stabilize(this), 80);
				setTimeout(() => stabilize(this), 240);
				return result;
			};

			const originalOnConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (...args) {
				const result = originalOnConfigure?.apply(this, args);
				schedule(this, 0);
				setTimeout(() => stabilize(this), 80);
				setTimeout(() => stabilize(this), 240);
				return result;
			};

			const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
			nodeType.prototype.onDrawBackground = function (...args) {
				const result = originalOnDrawBackground?.apply(this, args);
				const config = configForNode(this);
				const signature = [
					...(config.hiddenWidgets || []).map((item) => `${item.name}:${widgetBySpec(this, item)?.hidden}:${widgetBySpec(this, item)?.value}`),
					...(config.modelDefaults || []).map((item) => `${item.name}:${widgetBySpec(this, item)?.value}`),
				].join("|");
				if (signature !== this.__gjjNLFPoseUiSignature) {
					this.__gjjNLFPoseUiSignature = signature;
					schedule(this, 16);
				}
				return result;
			};
		},
		setup() {
			loadBackendUi().then(() => {
				for (const node of app.graph?._nodes || []) {
					if (node?.comfyClass === NODE_NAME || node?.type === NODE_NAME) {
						stabilize(node);
					}
				}
			});
		},
	});
})();

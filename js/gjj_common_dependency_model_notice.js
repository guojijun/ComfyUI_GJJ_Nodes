import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "GJJ.DependencyModelNotice";
	const WIDGET_NAME = "gjj_dependency_model_notice_panel";
	const HELP_ENDPOINT = "/gjj/node_help";
	const DISMISS_STORAGE_PREFIX = "GJJ.DependencyModelNotice.dismissed.";
	const nodeHelp = new Map();
	let helpLoaded = false;

	function isGJJNode(node) {
		const name = String(node?.comfyClass || node?.type || "");
		return name.startsWith("GJJ_");
	}

	function nodeKey(node) {
		return String(node?.comfyClass || node?.type || "");
	}

	function refreshNode(node) {
		if (!node) return;
		GJJ_Utils.scheduleFitNodeToContent(node, { minWidth: 260, minHeight: 80, delay: 20 });
		GJJ_Utils.scheduleFitNodeToContent(node, { minWidth: 260, minHeight: 80, delay: 120 });
	}

	function noticeHeight(root) {
		if (!root || root.style.display === "none") return 0;
		const message = root.children?.[0];
		const button = root.children?.[1];
		const style = getComputedStyle(root);
		const padding = Number.parseFloat(style.paddingTop || "0") + Number.parseFloat(style.paddingBottom || "0");
		const border = Number.parseFloat(style.borderTopWidth || "0") + Number.parseFloat(style.borderBottomWidth || "0");
		const messageHeight = Math.ceil(message?.scrollHeight || message?.offsetHeight || 0);
		const buttonVisible = button && button.style.display !== "none";
		const buttonStyle = buttonVisible ? getComputedStyle(button) : null;
		const buttonHeight = buttonVisible
			? Math.ceil(
				(button.scrollHeight || button.offsetHeight || 28)
				+ Number.parseFloat(buttonStyle?.marginTop || "0")
				+ Number.parseFloat(buttonStyle?.marginBottom || "0")
			)
			: 0;
		const contentHeight = padding + border + messageHeight + buttonHeight;
		if (contentHeight > 0) return Math.max(42, Math.ceil(contentHeight));
		return Math.max(
			42,
			Math.ceil(root.scrollHeight || root.offsetHeight || root.getBoundingClientRect?.().height || 88)
		);
	}

	function copyText(text) {
		const value = String(text || "");
		if (!value) return Promise.resolve(false);
		if (navigator.clipboard?.writeText) {
			return navigator.clipboard.writeText(value).then(() => true).catch(() => fallbackCopyText(value));
		}
		return Promise.resolve(fallbackCopyText(value));
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
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch (_) {}
		textarea.remove();
		return ok;
	}

	function setWidgetNonSerialized(widget) {
		if (!widget) return;
		widget.serialize = false;
		widget.value = undefined;
		widget.options = widget.options || {};
		widget.options.serialize = false;
	}

	function removeLegacyWidgets(node) {
		if (!Array.isArray(node?.widgets)) return;
		for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
			const widget = node.widgets[index];
			const name = String(widget?.name || widget?.label || widget?.options?.name || widget?.type || "");
			const element = widget?.element || widget?.inputEl || widget?.container;
			if (
				name === WIDGET_NAME
				|| name === "复制安装命令"
				|| name === "copy_install_command"
				|| name === "gjj_audio_status"
				|| name === "gjj_audio_copy_command"
				|| name === "GJJ 音频状态栏"
				|| !!element?.querySelector?.(".gjj-audio-separator-status,.gjj-audio-separator-copy-btn")
				|| element?.classList?.contains?.("gjj-audio-separator-status")
				|| element?.classList?.contains?.("gjj-audio-separator-copy-btn")
			) {
				if (name === WIDGET_NAME && widget === node.__gjjDependencyNoticeWidget) continue;
				try { element?.remove?.(); } catch (_) {}
				node.widgets.splice(index, 1);
			}
		}
	}

	function moveNoticeWidgetToEnd(node) {
		const widget = node?.__gjjDependencyNoticeWidget;
		if (!widget || !Array.isArray(node?.widgets)) return;
		const index = node.widgets.indexOf(widget);
		if (index < 0 || index === node.widgets.length - 1) return;
		node.widgets.splice(index, 1);
		node.widgets.push(widget);
	}

	function cleanTransientWidgets(node) {
		if (!Array.isArray(node?.widgets)) return;
		for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
			const widget = node.widgets[index];
			const name = String(widget?.name || widget?.label || widget?.options?.name || widget?.type || "");
			const element = widget?.element || widget?.inputEl || widget?.container;
			if (
				name === "复制安装命令"
				|| name === "copy_install_command"
				|| name === "gjj_audio_status"
				|| name === "gjj_audio_copy_command"
				|| name === "GJJ 音频状态栏"
				|| !!element?.querySelector?.(".gjj-audio-separator-status,.gjj-audio-separator-copy-btn")
				|| element?.classList?.contains?.("gjj-audio-separator-status")
				|| element?.classList?.contains?.("gjj-audio-separator-copy-btn")
			) {
				try { element?.remove?.(); } catch (_) {}
				node.widgets.splice(index, 1);
			}
		}
		if (node.__gjjDependencyNoticeWidget) {
			setWidgetNonSerialized(node.__gjjDependencyNoticeWidget);
		}
	}

	function noticeDismissKey(node, data) {
		const key = nodeKey(node);
		const text = String(
			data?.warning_message
			|| data?.panel_message
			|| data?.copy_text
			|| data?.model_download_url
			|| ""
		).trim();
		if (!key || !text) return "";
		let hash = 0;
		for (let index = 0; index < text.length; index += 1) {
			hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
		}
		return `${DISMISS_STORAGE_PREFIX}${key}.${Math.abs(hash)}`;
	}

	function isNoticeDismissed(node, data) {
		const key = noticeDismissKey(node, data);
		if (!key) return false;
		try {
			return localStorage.getItem(key) === "1";
		} catch (_) {
			return false;
		}
	}

	function dismissNotice(key) {
		if (!key) return;
		try {
			localStorage.setItem(key, "1");
		} catch (_) {}
	}

	function ensurePanel(node) {
		if (!isGJJNode(node)) return null;
		removeLegacyWidgets(node);
		if (node.__gjjDependencyNotice) {
			moveNoticeWidgetToEnd(node);
			return node.__gjjDependencyNotice;
		}
		if (typeof node.addDOMWidget !== "function") return null;

		const root = document.createElement("div");
		root.className = "gjj-dependency-notice";
		root.style.cssText = [
			"display:none",
			"position:relative",
			"box-sizing:border-box",
			"width:100%",
			"padding:7px 28px 7px 8px",
			"border:1px solid #9f6b1e",
			"border-radius:7px",
			"background:#21170b",
			"color:#ffe7bd",
			"font:12px/1.45 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
		].join(";");

		const message = document.createElement("div");
		message.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;";
		const closeBtn = document.createElement("button");
		closeBtn.type = "button";
		closeBtn.title = "关闭此提示";
		closeBtn.textContent = "×";
		closeBtn.style.cssText = [
			"position:absolute",
			"right:6px",
			"top:5px",
			"width:20px",
			"height:20px",
			"border:1px solid rgba(255,255,255,.22)",
			"border-radius:5px",
			"background:rgba(0,0,0,.22)",
			"color:inherit",
			"font-weight:800",
			"line-height:16px",
			"cursor:pointer",
			"padding:0",
		].join(";");
		const button = document.createElement("button");
		button.type = "button";
		button.style.cssText = [
			"margin-top:7px",
			"width:100%",
			"height:28px",
			"padding:0 9px",
			"border:1px solid #d85a5a",
			"border-radius:6px",
			"background:#bf3434",
			"color:#fff4f4",
			"font-weight:700",
			"cursor:pointer",
		].join(";");
		root.append(message, button, closeBtn);

		const state = {
			root,
			message,
			button,
			closeBtn,
			copyText: "",
			copyLabel: "📋 复制安装命令",
			dismissKey: "",
		};

		function doCopy(event) {
			event?.preventDefault?.();
			event?.stopPropagation?.();
			if (!state.copyText) return;
			copyText(state.copyText).then(() => {
				const old = state.button.textContent;
				state.button.textContent = "✅ 已复制";
				refreshNode(node);
				setTimeout(() => {
					state.button.textContent = old;
					refreshNode(node);
				}, 900);
			});
		}

		button.addEventListener("click", doCopy);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("mousedown", (event) => event.stopPropagation());
		closeBtn.addEventListener("click", (event) => {
			event?.preventDefault?.();
			event?.stopPropagation?.();
			dismissNotice(state.dismissKey);
			state.root.style.display = "none";
			refreshNode(node);
		});
		closeBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
		closeBtn.addEventListener("mousedown", (event) => event.stopPropagation());

		const widget = node.addDOMWidget(WIDGET_NAME, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
			getHeight: () => noticeHeight(root),
		});
		widget.computeSize = (width) => [Math.max(260, Number(width || node.size?.[0] || 300)), noticeHeight(root)];
		setWidgetNonSerialized(widget);
		widget.mouse = function (event) {
			const target = event?.target;
			if (target === closeBtn || closeBtn.contains?.(target)) {
				dismissNotice(state.dismissKey);
				state.root.style.display = "none";
				refreshNode(node);
				return true;
			}
			if (target === button || button.contains?.(target)) {
				doCopy(event);
				return true;
			}
			return false;
		};
		node.__gjjDependencyNoticeWidget = widget;
		node.__gjjDependencyNotice = state;
		moveNoticeWidgetToEnd(node);
		return state;
	}

	function applyPanelTone(state, level) {
		const optional = String(level || "") === "optional";
		state.root.style.borderColor = optional ? "#987b24" : "#9f6b1e";
		state.root.style.background = optional ? "#1f1b0c" : "#21170b";
		state.root.style.color = optional ? "#fff0b8" : "#ffe7bd";
		state.button.style.borderColor = optional ? "#d6aa35" : "#d85a5a";
		state.button.style.background = optional ? "#8b6b17" : "#bf3434";
		state.button.style.color = optional ? "#fff8d6" : "#fff4f4";
	}

	function widgetValue(node, names) {
		const candidates = Array.isArray(names) ? names : [names];
		for (const widget of node?.widgets || []) {
			const searchable = [
				widget?.name,
				widget?.label,
				widget?.localized_name,
				widget?.options?.display_name,
			].map((value) => String(value || ""));
			if (searchable.some((value) => candidates.includes(value))) return widget?.value;
		}
		return undefined;
	}

	function truthyWidgetValue(value) {
		if (value === true) return true;
		const text = String(value ?? "").trim().toLowerCase();
		return ["1", "true", "yes", "on", "enable", "enabled", "开", "是", "真"].includes(text);
	}

	function compactOptionalNoticeForNode(node, data, options = {}) {
		if (nodeKey(node) !== "GJJ_ModelPatchBundle" || options?.detailed) return null;
		const sageEnabled = truthyWidgetValue(widgetValue(node, ["启用SageAttention", "enable_sage_attention"]));
		if (sageEnabled) return null;
		const warning = String(data?.warning_message || "");
		const panel = String(data?.panel_message || "");
		if (!warning && !panel) return null;
		return {
			warning_message: "⚠️ 可选依赖缺失，基础功能可用；启用 SageAttention 时再按需安装。",
			panel_message: "",
			copy_text: "",
			copy_label: "",
			notice_level: data?.notice_level || "optional",
		};
	}

	function applyNotice(node, data, options = {}) {
		data = compactOptionalNoticeForNode(node, data, options) || data;
		const warning = String(data?.warning_message || "");
		const panel = String(data?.panel_message || "");
		const copyTextValue = String(data?.copy_text || data?.install_command || data?.optional_install_command || data?.model_download_url || "");
		const detailed = Boolean(options.detailed);
		const dismissible = options.dismissible !== false;
		if (!detailed && dismissible && isNoticeDismissed(node, data)) {
			if (node?.__gjjDependencyNotice) {
				node.__gjjDependencyNotice.root.style.display = "none";
			}
			refreshNode(node);
			return;
		}
		if (!warning && !panel) {
			if (node?.__gjjDependencyNotice) {
				node.__gjjDependencyNotice.root.style.display = "none";
			}
			refreshNode(node);
			return;
		}
		const state = ensurePanel(node);
		if (!state) return;
		applyPanelTone(state, data?.notice_level);
		state.dismissKey = dismissible ? noticeDismissKey(node, data) : "";
		state.copyText = copyTextValue;
		state.copyLabel = String(data?.copy_label || (copyTextValue ? "📋 复制安装命令" : ""));
		state.message.textContent = detailed ? panel || warning : warning || panel.split(/\r?\n/)[0] || "";
		state.button.textContent = state.copyLabel || "📋 复制";
		state.button.style.display = state.copyText ? "" : "none";
		state.root.style.display = "";
		refreshNode(node);
	}

	function noticeFromHelp(node) {
		const payload = nodeHelp.get(nodeKey(node));
		const help = payload?.help || {};
		const warning = String(help.warning_message || "");
		if (!warning) return null;
		return {
			warning_message: warning,
			panel_message: "",
			install_command: String(help.install_cmd || ""),
			optional_install_command: String(help.optional_install_cmd || ""),
			copy_text: String(help.copy_text || help.install_cmd || help.optional_install_cmd || help.model_download_url || ""),
			copy_label: String(help.copy_label || ""),
			model_download_url: String(help.model_download_url || ""),
			notice_level: String(help.notice_level || ""),
		};
	}

	function installModelPatchBundleNoticeRefresh(node) {
		if (nodeKey(node) !== "GJJ_ModelPatchBundle" || node.__gjjModelPatchNoticeRefreshPatched) return;
		const widget = (node.widgets || []).find((item) => {
			const searchable = [
				item?.name,
				item?.label,
				item?.localized_name,
				item?.options?.display_name,
			].map((value) => String(value || ""));
			return searchable.includes("启用SageAttention") || searchable.includes("enable_sage_attention");
		});
		if (!widget) return;
		node.__gjjModelPatchNoticeRefreshPatched = true;
		const originalCallback = widget.callback;
		widget.callback = function (...args) {
			const result = originalCallback?.apply(this, args);
			loadHelp().then(() => {
				const notice = noticeFromHelp(node);
				if (notice) applyNotice(node, notice);
			});
			return result;
		};
	}

	async function loadHelp() {
		if (helpLoaded) return;
		helpLoaded = true;
		try {
			const response = await fetch(HELP_ENDPOINT);
			const data = await response.json();
			for (const [key, value] of Object.entries(data || {})) {
				nodeHelp.set(key, value);
			}
		} catch (error) {
			console.warn("[GJJ] 依赖提示帮助数据读取失败:", error);
		}
	}

	function initializeNodePanel(node) {
		if (!isGJJNode(node)) return;
		installModelPatchBundleNoticeRefresh(node);
		loadHelp().then(() => {
			const notice = noticeFromHelp(node);
			if (notice) applyNotice(node, notice);
		});
	}

	function findNoticeTargetNodes(eventData) {
		const nodeId = String(eventData?.node || "");
		const nodes = Array.isArray(app.graph?._nodes) ? app.graph._nodes.filter(Boolean) : [];
		if (nodeId) {
			const node = app.graph?.getNodeById?.(nodeId) || nodes.find((item) => String(item?.id) === nodeId);
			return node ? [node] : [];
		}
		const targetType = String(eventData?.node_type || eventData?.class_name || "");
		if (targetType) return nodes.filter((node) => nodeKey(node) === targetType);
		return nodes.filter(isGJJNode);
	}

	api.addEventListener("gjj_dependency_model_notice", (event) => {
		const data = event.detail || {};
		for (const node of findNoticeTargetNodes(data)) {
			applyNotice(node, data, { detailed: true });
		}
	});

	globalThis.GJJ_CommonDependencyModelNotice = {
		ensurePanel,
		applyNotice,
		initializeNodePanel,
		cleanTransientWidgets,
		loadHelp,
		refreshAll() {
			for (const node of app.graph?._nodes || []) initializeNodePanel(node);
		},
	};

	app.registerExtension({
		name: EXTENSION_NAME,
		beforeRegisterNodeDef(nodeType, nodeData) {
			if (!String(nodeData?.name || "").startsWith("GJJ_")) return;
			const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) {
				const result = originalOnNodeCreated?.apply(this, args);
				initializeNodePanel(this);
				return result;
			};

			const originalOnConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (...args) {
				const result = originalOnConfigure?.apply(this, args);
				initializeNodePanel(this);
				return result;
			};

			const originalOnSerialize = nodeType.prototype.onSerialize;
			nodeType.prototype.onSerialize = function (serializedNode, ...args) {
				const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
				cleanTransientWidgets(this);
				return result;
			};
		},
		setup() {
			loadHelp().then(() => {
				for (const node of app.graph?._nodes || []) initializeNodePanel(node);
			});
		},
	});
})();

import { app } from "/scripts/app.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.SummonModel";
	const ENDPOINT = "/gjj/summon_model";
	const SETTING_MENU_ENABLED = "GJJ.SummonModel.Menu.Enabled";
	const SETTING_CONFIRM_SECOND_TIER = "GJJ.SummonModel.SecondTierConfirm.Enabled";
	const MODEL_EXT_RE = /\.(safetensors|ckpt|pt2?|pth|bin|gguf|sft|pkl|onnx|engine)$/i;
	const MISSING_RE = /缺失模型|模型缺失|未找到模型|找不到.*模型|缺少.*模型|missing\s+model|model\s+missing/i;
	const SKIP_VALUE_RE = /^(|none|null|undefined|nan|auto|自动|false|true|0|1|no|yes|off|on|disable|disabled|enable|enabled|禁用|关闭|关|启用|开启|开|不选择|未选择|不使用|\[未启用\]|\[未找到模型\]|\[none\])$/i;
	const MODEL_FIELD_RE = /模型|(^|[_\s-])(model(?:[_\s-]?name)?|ckpt|checkpoint|unet|diffusion|vae|clip|encoder|text[_\s-]*encoder|t5|bert|lora|controlnet|upscale|sam|yolo|bbox|gguf)($|[_\s-])/i;
	const NON_MODEL_WIDGET_RE = /(^|[_\s-])(strength|weight|scale|ratio|factor|alpha|beta|sigma|cfg|steps?|seed|width|height|size|batch|fps|frame|frames|start|end|count|percent|denoise|noise|guidance|shift|eta|temperature|top[_\s-]?[kp]|precision|dtype|quant(?:ization|ize)?|device|attention|norm|function|compile|backend|provider|algorithm|scheduler|sampler|format|mode|preset|cache|offload)($|[_\s-])/i;
	const STRENGTH_WIDGET_RE = /(^|[_\s-])(strength|weight|scale|ratio|factor|alpha|beta)($|[_\s-])/i;
	const NUMERIC_VALUE_RE = /^[-+]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[-+]?\d+)?$/i;

	function safeArray(value) {
		return Array.isArray(value) ? value : [];
	}

	function settingValue(id, fallback = undefined) {
		try {
			const viaGjj = globalThis.GJJ_Settings?.get?.(id, undefined);
			if (viaGjj !== undefined) return viaGjj;
		} catch (_) {}
		try {
			const viaComfy = app?.ui?.settings?.getSettingValue?.(id);
			return viaComfy === undefined ? fallback : viaComfy;
		} catch (_) {
			return fallback;
		}
	}

	function settingEnabled(id, fallback = true) {
		return Boolean(settingValue(id, fallback));
	}

	function refreshNode(node) {
		try { node?.setDirtyCanvas?.(true, true); } catch (_) {}
		try { node?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
		try { app?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
		try { app?.canvas?.setDirty?.(true, true); } catch (_) {}
	}

	function showToast(message, tone = "info") {
		try {
			let toast = document.querySelector("[data-gjj-summon-model-toast='1']");
			if (!toast) {
				toast = document.createElement("div");
				toast.dataset.gjjSummonModelToast = "1";
				toast.style.cssText = [
					"position:fixed",
					"left:50%",
					"top:24px",
					"transform:translateX(-50%) translateY(-6px)",
					"z-index:999999",
					"max-width:min(760px,calc(100vw - 48px))",
					"padding:10px 15px",
					"border-radius:999px",
					"box-shadow:0 10px 28px rgba(0,0,0,.32)",
					"font:13px/1.35 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
					"font-weight:700",
					"pointer-events:none",
					"opacity:0",
					"transition:opacity .18s ease,transform .18s ease",
					"white-space:nowrap",
				].join(";");
				document.body.appendChild(toast);
			}
			const ok = tone === "ok";
			toast.style.background = ok ? "rgba(16, 72, 52, .96)" : "rgba(42, 28, 16, .96)";
			toast.style.border = ok ? "1px solid rgba(80, 210, 154, .6)" : "1px solid rgba(241, 173, 70, .65)";
			toast.style.color = ok ? "#dffff0" : "#fff0c9";
			toast.textContent = String(message || "");
			clearTimeout(toast.__gjjSummonModelTimer);
			requestAnimationFrame(() => {
				toast.style.opacity = "1";
				toast.style.transform = "translateX(-50%) translateY(0)";
			});
			toast.__gjjSummonModelTimer = setTimeout(() => {
				toast.style.opacity = "0";
				toast.style.transform = "translateX(-50%) translateY(-6px)";
			}, 4200);
		} catch (_) {
			console.log(`[GJJ] ${message}`);
		}
	}

	function comboValues(widget) {
		const raw = widget?.options?.values || widget?.options?.comboValues || widget?.values || widget?.__gjjWan22AllValues || widget?.__gjjBundleAllValues;
		if (!Array.isArray(raw)) return [];
		return raw.map((item) => {
			if (item && typeof item === "object") {
				return String(item.value ?? item.name ?? item.label ?? "");
			}
			return String(item ?? "");
		}).filter(Boolean);
	}

	function widgetName(widget) {
		return String(widget?.name || widget?.label || widget?.options?.name || "");
	}

	function nodeName(node) {
		return String(node?.type || node?.comfyClass || node?.title || "");
	}

	function currentWidgetValue(widget) {
		return String(widget?.value ?? "").trim();
	}

	function hasUsableModelValue(widget) {
		const value = currentWidgetValue(widget);
		return !!value && !SKIP_VALUE_RE.test(value);
	}

	function boolWidgetValue(widget, fallback = true) {
		const value = widget?.value;
		if (value === undefined || value === null || value === "") return fallback;
		if (typeof value === "boolean") return value;
		const text = String(value).trim().toLowerCase();
		if (["1", "true", "yes", "on", "enable", "enabled", "启用", "开启", "开"].includes(text)) return true;
		if (["0", "false", "no", "off", "disable", "disabled", "禁用", "关闭", "关"].includes(text)) return false;
		return fallback;
	}

	function optionalToggleNameFor(widget) {
		const name = widgetName(widget);
		if (/^model_patch_name$/i.test(name)) return "model_patch_enabled";
		const presetLora = name.match(/^(preset_lora_\d+)_name$/i);
		if (presetLora) return `${presetLora[1]}_enabled`;
		return "";
	}

	function isDisabledOptionalModelWidget(node, widget) {
		const toggleName = optionalToggleNameFor(widget);
		if (!toggleName) return false;
		const toggle = safeArray(node?.widgets).find((candidate) => widgetName(candidate) === toggleName);
		return toggle ? !boolWidgetValue(toggle, true) : false;
	}

	function widgetType(widget) {
		return String(widget?.type || widget?.options?.type || "").toLowerCase();
	}

	function isNumericWidget(widget) {
		const type = widgetType(widget);
		const value = currentWidgetValue(widget);
		if (/number|slider|float|int|integer/.test(type)) return true;
		if (!NUMERIC_VALUE_RE.test(value)) return false;
		const options = widget?.options || {};
		return ["min", "max", "step", "precision"].some((key) => Number.isFinite(Number(options[key])));
	}

	function isNonModelControl(widget) {
		const name = widgetName(widget);
		const value = currentWidgetValue(widget);
		if (NON_MODEL_WIDGET_RE.test(name)) return true;
		return isNumericWidget(widget) && !MODEL_EXT_RE.test(value) && comboValues(widget).length === 0;
	}

	function isModelLikeWidget(node, widget) {
		if (!widget) return false;
		if (isDisabledOptionalModelWidget(node, widget)) return false;
		if (isNonModelControl(widget)) return false;
		const values = comboValues(widget);
		const value = currentWidgetValue(widget);
		const hasModelFile = MODEL_EXT_RE.test(value) || values.some((item) => MODEL_EXT_RE.test(item));
		if (!hasModelFile) return false;
		return MODEL_FIELD_RE.test(widgetName(widget)) || MODEL_EXT_RE.test(value);
	}

	function findModelWidgets(node) {
		return safeArray(node?.widgets).filter((widget) => {
			if (!isModelLikeWidget(node, widget)) return false;
			const values = comboValues(widget);
			const type = widgetType(widget);
			return type === "combo" || values.length > 0 || hasUsableModelValue(widget);
		});
	}

	function nodeNoticeText(node) {
		const panel = node?.__gjjDependencyNotice;
		const parts = [
			panel?.message?.textContent,
			panel?.root?.textContent,
			node?.title,
			node?.last_error,
			node?.execution_error,
		];
		return parts.map((item) => String(item || "")).join("\n");
	}

	function widgetLooksMissing(node, widget) {
		const value = currentWidgetValue(widget);
		const values = comboValues(widget);
		if (!hasUsableModelValue(widget)) return false;
		if (MISSING_RE.test(value)) return true;
		if (values.length > 0 && values.every((item) => MISSING_RE.test(item) || SKIP_VALUE_RE.test(item))) return true;
		if (hasUsableModelValue(widget) && values.length > 0 && !values.includes(value) && isModelLikeWidget(node, widget)) return true;
		return false;
	}

	function nodeHasMissingModelSignal(node) {
		if (!node) return false;
		if (MISSING_RE.test(nodeNoticeText(node))) return true;
		return findModelWidgets(node).some((widget) => widgetLooksMissing(node, widget));
	}

	function inferCategories(node, widget) {
		const name = widgetName(widget).toLowerCase();
		const value = currentWidgetValue(widget).toLowerCase();
		const nodeText = nodeName(node).toLowerCase();
		const text = `${name} ${nodeText} ${value}`;
		const tokenText = text.replace(/[\\/_\-.]+/g, " ");
		const compactText = tokenText.replace(/\s+/g, "");
		const isGguf = /gguf/.test(text);
		const categories = [];
		const add = (...items) => {
			for (const item of items) {
				if (item && !categories.includes(item)) categories.push(item);
			}
		};

		if (/lora/.test(text)) add("loras");
		if (/vae\s*approx|approx\s*vae/.test(tokenText)) add("vae_approx", "vae");
		else if (/(^|\s)vae(\s|$)|视频\s*vae|audio\s*vae|video\s*vae/.test(tokenText) || /vaeloader/.test(compactText)) add("vae");
		if (/clip\s*vision|vision\s*clip/.test(tokenText)) add("clip_vision");
		if (/text\s*encoder|(^|\s)clip(\s|$)|t5|bert|umt5|llm/.test(tokenText)) add("text_encoders", "clip");
		if (/control[_\s-]*net|controlnet|t2i[_\s-]*adapter/.test(text)) add("controlnet", "controlnets");
		if (/upscale|放大|超分|latent[_\s-]*upscale/.test(text)) add("upscale_models", "latent_upscale_models");
		if (/checkpoint|ckpt|base[_\s-]*model|底模/.test(text) && !/unet|diffusion/.test(text)) add("checkpoints");
		if (/(^|\s)unet(\s|$)|diffusion/.test(tokenText)) add(isGguf ? "unet_gguf" : "diffusion_models");
		if (!categories.length && /主模型|video|wan|ltx|hunyuan|flux|sd3|model_name|模型选择/.test(text)) add("diffusion_models", "checkpoints");
		if (/audio[_\s-]*encoder|音频编码/.test(text)) add("audio_encoders");
		if (/sam3?|segment/.test(text)) add("sam3", "sam2", "checkpoints");
		if (/onnx|vitpose|detection|检测/.test(text)) add("detection", "onnx");
		if (/bbox|yolo|ultralytics/.test(text)) add("ultralytics_bbox", "detection", "onnx");
		if (isGguf && !categories.length) add("unet_gguf", "clip_gguf");

		if (!categories.length) {
			add("checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "controlnet", "upscale_models", "clip_vision");
		}
		return categories;
	}

	function allowedModelValues(widget) {
		const current = currentWidgetValue(widget);
		const values = comboValues(widget).filter((value) => MODEL_EXT_RE.test(value) && !MISSING_RE.test(value));
		const alternatives = values.filter((value) => value !== current);
		return alternatives.length ? alternatives : [];
	}

	function getCanvasSelectedNodes() {
		const result = new Set();
		const all = new Set(safeArray(app?.graph?._nodes));
		const add = (item, key = null) => {
			if (item && typeof item === "object" && all.has(item)) {
				result.add(item);
				return;
			}
			const id = item?.id ?? (item !== true ? item : key);
			if (id == null) return;
			const node = app?.graph?.getNodeById?.(id);
			if (node && all.has(node)) result.add(node);
		};
		const selected = app?.canvas?.selected_nodes || app?.canvas?.selectedNodes || app?.canvas?._selected_nodes;
		if (selected instanceof Set) {
			for (const item of selected) add(item);
		} else if (selected instanceof Map) {
			for (const [key, item] of selected.entries()) add(item, key);
		} else if (Array.isArray(selected)) {
			for (const item of selected) add(item);
		} else if (selected && typeof selected === "object") {
			for (const [key, item] of Object.entries(selected)) add(item, key);
		}
		for (const node of all) {
			if (node?.selected || node?.flags?.selected || node?.__selected || node?.is_selected) result.add(node);
		}
		return Array.from(result);
	}

	function graphNodes() {
		return safeArray(app?.graph?._nodes).filter(Boolean);
	}

	function nodeSelectionObject(nodes) {
		const selected = {};
		for (const node of safeArray(nodes)) {
			if (node?.id == null) continue;
			selected[node.id] = node;
		}
		return selected;
	}

	function selectNodesForRefresh(nodes, selectedNode = null) {
		const canvas = app?.canvas;
		if (!canvas) return;
		const list = safeArray(nodes).filter(Boolean);
		try { canvas.deselectAllNodes?.(); } catch (_) {}
		try { canvas.deselectAll?.(); } catch (_) {}
		for (const node of graphNodes()) {
			try { node.selected = false; } catch (_) {}
			try { if (node.flags) delete node.flags.selected; } catch (_) {}
		}

		const selected = nodeSelectionObject(list);
		for (const node of list) {
			try { node.selected = true; } catch (_) {}
			try { if (node.flags) node.flags.selected = true; } catch (_) {}
		}
		canvas.selected_nodes = selected;
		canvas._selected_nodes = selected;
		canvas.selected_node = selectedNode || list[0] || null;
		canvas.current_node = selectedNode || list[0] || null;
		canvas.selected_group = null;
		canvas.dragging_rectangle = null;
		canvas.node_dragged = null;
		try { canvas.setSelectedNodes?.(selected); } catch (_) {}
		for (const node of list) refreshNode(node);
	}

	function later(callback) {
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(callback);
		} else {
			setTimeout(callback, 0);
		}
	}

	function forceSelectionValidationRefresh(nodes) {
		const canvas = app?.canvas;
		const targets = Array.from(new Set(safeArray(nodes).filter(Boolean)));
		if (!canvas || !targets.length) {
			for (const node of targets) refreshNode(node);
			return;
		}

		const oldSelectedNodes = getCanvasSelectedNodes();
		const oldSelectedNode = canvas.selected_node || oldSelectedNodes[0] || null;
		const oldCurrentNode = canvas.current_node || oldSelectedNode || null;
		const otherNode = graphNodes().find((node) => node && !targets.includes(node)) || null;
		const firstTarget = targets[0];
		const restoreNodes = oldSelectedNodes.length ? oldSelectedNodes : [firstTarget];
		const restoreNode = restoreNodes.includes(oldSelectedNode) ? oldSelectedNode : restoreNodes[0] || null;

		if (otherNode) {
			selectNodesForRefresh([otherNode], otherNode);
		} else {
			try { firstTarget.onDeselected?.(); } catch (_) {}
			selectNodesForRefresh([], null);
		}

		let index = 0;
		const visitNextTarget = () => {
			const target = targets[index++];
			if (target) {
				selectNodesForRefresh([target], target);
				try { target.onSelected?.(); } catch (_) {}
				later(visitNextTarget);
				return;
			}
			later(() => {
				selectNodesForRefresh(restoreNodes, restoreNode);
				if (oldCurrentNode && restoreNodes.includes(oldCurrentNode)) {
					canvas.current_node = oldCurrentNode;
				}
				for (const node of targets) refreshNode(node);
			});
		};
		later(visitNextTarget);
	}

	function targetsForMenuNode(node) {
		const selected = getCanvasSelectedNodes();
		if (selected.includes(node) && selected.length > 0) return selected;
		return node ? [node] : [];
	}

	function hasCorruptedNonModelDropdown(node) {
		return safeArray(node?.widgets).some((widget) => {
			if (!isNonModelControl(widget)) return false;
			if (MODEL_EXT_RE.test(currentWidgetValue(widget))) return true;
			return widgetOptionArrays(widget).some((values) => values.some((item) => MODEL_EXT_RE.test(widgetOptionText(item))));
		});
	}

	function shouldShowMenu(node) {
		if (!settingEnabled(SETTING_MENU_ENABLED, true)) return false;
		return (nodeHasMissingModelSignal(node) && findModelWidgets(node).length > 0) || hasCorruptedNonModelDropdown(node);
	}

	function ensureComboValue(widget, value) {
		if (!widget || !value) return;
		const addToArray = (arr) => {
			if (!Array.isArray(arr)) return arr;
			const exists = arr.some((item) => String(item?.value ?? item?.name ?? item?.label ?? item) === value);
			if (!exists) arr.unshift(value);
			return arr;
		};
		widget.options = widget.options || {};
		const optionValues = widget.options.values;
		if (Array.isArray(optionValues)) addToArray(optionValues);
		else if (optionValues == null) {
			try { widget.options.values = [value]; } catch (_) {}
		}
		const comboOptionValues = widget.options.comboValues;
		if (Array.isArray(comboOptionValues)) addToArray(comboOptionValues);
		else if (comboOptionValues == null) {
			try { widget.options.comboValues = [value]; } catch (_) {}
		}
		if (Array.isArray(widget.values)) widget.values = addToArray(widget.values);
		else if (widget.values == null) {
			try { widget.values = [value]; } catch (_) {}
		}
		if (Array.isArray(widget.__gjjWan22AllValues)) widget.__gjjWan22AllValues = addToArray(widget.__gjjWan22AllValues);
		if (Array.isArray(widget.__gjjBundleAllValues)) widget.__gjjBundleAllValues = addToArray(widget.__gjjBundleAllValues);
	}

	function widgetOptionText(item) {
		if (item && typeof item === "object") return String(item.value ?? item.name ?? item.label ?? "");
		return String(item ?? "");
	}

	function widgetOptionArrays(widget) {
		const raw = [
			widget?.options?.values,
			widget?.options?.comboValues,
			widget?.values,
			widget?.__gjjWan22AllValues,
			widget?.__gjjBundleAllValues,
		];
		return Array.from(new Set(raw.filter(Array.isArray)));
	}

	function repairCorruptedNonModelDropdowns(node) {
		let repaired = 0;
		for (const widget of safeArray(node?.widgets)) {
			if (!isNonModelControl(widget)) continue;
			const arrays = widgetOptionArrays(widget);
			let removed = false;
			for (const values of arrays) {
				for (let index = values.length - 1; index >= 0; index -= 1) {
					if (!MODEL_EXT_RE.test(widgetOptionText(values[index]))) continue;
					values.splice(index, 1);
					removed = true;
				}
			}

			if (MODEL_EXT_RE.test(currentWidgetValue(widget))) {
				const choices = [];
				for (const values of arrays) {
					for (const item of values) {
						const value = widgetOptionText(item);
						if (value && !MODEL_EXT_RE.test(value) && !MISSING_RE.test(value) && !choices.includes(value)) {
							choices.push(value);
						}
					}
				}
				const defaults = [widget?.options?.default, widget?.default_value, widget?.default]
					.map((value) => String(value ?? ""))
					.filter((value) => value && !MODEL_EXT_RE.test(value));
				let fallback = defaults.find((value) => !choices.length || choices.includes(value)) || choices[0];
				if (!fallback && STRENGTH_WIDGET_RE.test(widgetName(widget))) fallback = "1";
				if (fallback) {
					const nextValue = isNumericWidget(widget) || STRENGTH_WIDGET_RE.test(widgetName(widget))
						? Number(fallback)
						: fallback;
					commitWidgetValue(node, widget, Number.isNaN(nextValue) ? fallback : nextValue);
					removed = true;
				}
			}
			if (removed) repaired += 1;
		}
		if (repaired) refreshNode(node);
		return repaired;
	}

	function clearNodeErrorContainer(container, node) {
		if (!container || !node) return;
		const keys = [node.id, String(node.id)];
		if (container instanceof Map) {
			for (const key of keys) container.delete(key);
			return;
		}
		if (container instanceof Set) {
			for (const key of keys) container.delete(key);
			container.delete(node);
			return;
		}
		if (Array.isArray(container)) {
			for (let index = container.length - 1; index >= 0; index -= 1) {
				const item = container[index];
				if (item === node || keys.includes(item) || keys.includes(item?.node_id) || keys.includes(item?.node)) {
					container.splice(index, 1);
				}
			}
			return;
		}
		if (typeof container === "object") {
			for (const key of keys) {
				try { delete container[key]; } catch (_) {}
			}
		}
	}

	function clearCachedNodeErrors(node) {
		const holders = [app, app?.graph, app?.canvas, app?.ui];
		const names = [
			"node_errors",
			"nodeErrors",
			"last_node_errors",
			"lastNodeErrors",
			"execution_errors",
			"executionErrors",
			"lastExecutionErrors",
			"validation_errors",
			"validationErrors",
			"invalid_nodes",
			"invalidNodes",
			"error_nodes",
			"errorNodes",
		];
		for (const holder of holders) {
			if (!holder) continue;
			for (const name of names) clearNodeErrorContainer(holder[name], node);
		}
	}

	function clearSummonedModelWarning(node) {
		if (!node) return;
		try {
			globalThis.GJJ_CommonDependencyModelNotice?.applyNotice?.(node, {
				warning_message: "",
				panel_message: "",
				copy_text: "",
				copy_label: "",
				notice_level: "",
			});
		} catch (_) {}

		const notice = node.__gjjDependencyNotice;
		if (notice?.root) notice.root.style.display = "none";
		if (notice?.message) notice.message.textContent = "";
		if (notice?.button) notice.button.style.display = "none";

		for (const key of ["last_error", "execution_error", "error_message", "error", "errors"]) {
			try {
				if (key in node) node[key] = null;
			} catch (_) {}
		}
		if (node.flags) {
			delete node.flags.error;
			delete node.flags.has_errors;
		}
		clearCachedNodeErrors(node);
		refreshNode(node);
	}

	function repairInvalidNumericControls(node) {
		let repaired = 0;
		for (const widget of safeArray(node?.widgets)) {
			if (!isNonModelControl(widget)) continue;
			const raw = currentWidgetValue(widget).toLowerCase();
			const valueIsNaN = raw === "nan" || (typeof widget?.value === "number" && Number.isNaN(widget.value));
			if (!valueIsNaN) continue;

			const options = widget?.options || {};
			let fallback = options.default ?? widget.default_value ?? widget.default;
			if (!Number.isFinite(Number(fallback))) {
				if (!STRENGTH_WIDGET_RE.test(widgetName(widget))) continue;
				fallback = 1;
			}
			const fixedValue = Number(fallback);
			widget.value = fixedValue;
			const index = safeArray(node?.widgets).indexOf(widget);
			if (index >= 0) {
				node.widgets_values = safeArray(node.widgets_values);
				node.widgets_values[index] = fixedValue;
			}
			try { widget.callback?.(fixedValue, app?.canvas, node, widget); } catch (_) {}
			try { node.onWidgetChanged?.(widgetName(widget), fixedValue, widget, node); } catch (_) {}
			repaired += 1;
		}
		if (repaired) refreshNode(node);
		return repaired;
	}

	function commitWidgetValue(node, widget, value) {
		widget.value = value;
		const index = safeArray(node?.widgets).indexOf(widget);
		if (index >= 0) {
			node.widgets_values = safeArray(node.widgets_values);
			node.widgets_values[index] = value;
		}
		node.properties = node.properties || {};
		if (widgetName(widget)) node.properties[widgetName(widget)] = value;
		try { widget.callback?.(value, app?.canvas, node, widget); } catch (error) {
			console.warn("[GJJ] 召唤模型触发 widget 回调失败:", error);
		}
		try { node.onWidgetChanged?.(widgetName(widget), value, widget, node); } catch (_) {}
		const input = widget?.inputEl || widget?.element?.querySelector?.("input,select");
		if (input && "value" in input) {
			try {
				input.value = value;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			} catch (_) {}
		}
		refreshNode(node);
	}

	function setWidgetValue(node, widget, value) {
		if (!isModelLikeWidget(node, widget)) {
			console.warn(`[GJJ] 召唤模型跳过非模型控件：${nodeName(node)} / ${widgetName(widget)}`);
			return false;
		}
		if (!MODEL_EXT_RE.test(String(value || ""))) {
			console.warn(`[GJJ] 召唤模型跳过异常匹配值：${nodeName(node)} / ${widgetName(widget)} => ${value}`);
			return false;
		}
		ensureComboValue(widget, value);
		const alternate = allowedModelValues(widget).find((item) => item !== value);
		if (alternate) commitWidgetValue(node, widget, alternate);
		commitWidgetValue(node, widget, value);
		return true;
	}

	function confirmSecondTierMatch(node, widget, result, match) {
		if (!match?.needs_confirmation) return true;
		if (!settingEnabled(SETTING_CONFIRM_SECOND_TIER, true)) return true;
		const message = [
			"召唤模型找到一个第二梯队候选，需要确认后才替换：",
			"",
			`节点：${nodeName(node)}`,
			`控件：${widgetName(widget)}`,
			`当前：${String(result?.source_value || currentWidgetValue(widget) || "")}`,
			`候选：${String(match?.name || "")}`,
			`原因：${String(match?.reason || "可能是同模型的不同封装/备注版本")}`,
			"",
			"是否替换？",
		].join("\n");
		try {
			return window.confirm(message);
		} catch (_) {
			return false;
		}
	}

	async function fetchSummonMatches(queries) {
		const response = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ queries }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await response.json();
	}

	async function summonModelsForNodes(nodes) {
		const queries = [];
		const refs = new Map();
		let repaired = 0;
		for (const node of nodes) {
			repaired += repairCorruptedNonModelDropdowns(node);
			repaired += repairInvalidNumericControls(node);
			if (!nodeHasMissingModelSignal(node)) continue;
			for (const widget of findModelWidgets(node)) {
				if (!hasUsableModelValue(widget)) continue;
				const id = `${node.id}:${queries.length}:${widgetName(widget)}`;
				queries.push({
					id,
					node_id: node.id,
					node_type: nodeName(node),
					widget_name: widgetName(widget),
					value: currentWidgetValue(widget),
					categories: inferCategories(node, widget),
					allowed_values: allowedModelValues(widget),
					limit: 8,
				});
				refs.set(id, { node, widget });
			}
		}

		if (!queries.length) {
			if (repaired) {
				showToast(`召唤模型：已修复 ${repaired} 个被误改的参数下拉框。`, "ok");
			} else {
				showToast("召唤模型：没有找到可用于匹配的旧模型名。");
			}
			return;
		}

		showToast("召唤模型：正在扫描本地模型目录...");
		let data;
		try {
			data = await fetchSummonMatches(queries);
		} catch (error) {
			console.warn("[GJJ] 召唤模型失败:", error);
			showToast("召唤模型失败：后端接口不可用，请重启 ComfyUI 后再试。");
			return;
		}

		let changed = 0;
		let missed = 0;
		let declined = 0;
		const changedNodes = new Set();
		for (const result of safeArray(data?.results)) {
			const ref = refs.get(String(result?.id || ""));
			const match = result?.match;
			if (!ref || !match?.name) {
				missed += 1;
				continue;
			}
			if (!confirmSecondTierMatch(ref.node, ref.widget, result, match)) {
				declined += 1;
				continue;
			}
			if (!setWidgetValue(ref.node, ref.widget, String(match.name))) {
				missed += 1;
				continue;
			}
			changedNodes.add(ref.node);
			changed += 1;
			console.log(`[GJJ] 召唤模型：${nodeName(ref.node)} / ${widgetName(ref.widget)} => ${match.category}/${match.name}`);
		}

		for (const node of changedNodes) {
			repaired += repairInvalidNumericControls(node);
			const stillMissing = findModelWidgets(node).some((widget) => widgetLooksMissing(node, widget));
			if (!stillMissing) clearSummonedModelWarning(node);
		}
		if (changedNodes.size > 0) {
			forceSelectionValidationRefresh(Array.from(changedNodes));
		}

		if (changed > 0) {
			showToast(`召唤模型完成：已替换 ${changed} 个模型下拉框${repaired ? `，修复 ${repaired} 个数值` : ""}${declined ? `，${declined} 个已取消` : ""}${missed ? `，${missed} 个未匹配` : ""}。`, "ok");
		} else if (declined > 0) {
			showToast(`召唤模型：${declined} 个第二梯队候选已取消。`);
		} else {
			showToast("召唤模型：没有在对应模型目录找到可替换项。");
		}
	}

	function patchNodeType(nodeType) {
		if (!nodeType?.prototype || nodeType.prototype.__gjjSummonModelMenuPatched) return;
		nodeType.prototype.__gjjSummonModelMenuPatched = true;
		const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
		nodeType.prototype.getExtraMenuOptions = function (_, options) {
			const result = originalGetExtraMenuOptions?.apply(this, arguments);
			if (shouldShowMenu(this)) {
				options.unshift(null);
				options.unshift({
					content: "🧲 召唤模型",
					callback: () => summonModelsForNodes(targetsForMenuNode(this)),
				});
			}
			return result;
		};
	}

	function exposeSummonModelApi() {
		globalThis.GJJ_SummonModel = {
			...(globalThis.GJJ_SummonModel || {}),
			allowedModelValues,
			currentWidgetValue,
			fetchSummonMatches,
			findModelWidgets,
			inferCategories,
			nodeHasMissingModelSignal,
			nodeName,
			setWidgetValue,
			showToast,
			summonModelsForNodes,
			widgetLooksMissing,
			widgetName,
		};
	}

	exposeSummonModelApi();

	app.registerExtension({
		name: EXTENSION_NAME,
		beforeRegisterNodeDef(nodeType) {
			patchNodeType(nodeType);
		},
		setup() {
			exposeSummonModelApi();
			const registry = globalThis.LiteGraph?.registered_node_types || {};
			for (const nodeType of Object.values(registry)) patchNodeType(nodeType);
			console.log("[GJJ] 召唤模型右键菜单已启用");
		},
	});
})();

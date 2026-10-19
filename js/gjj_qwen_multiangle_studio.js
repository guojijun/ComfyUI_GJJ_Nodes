import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { bindGjjMediaDrag } from "./gjj_media_drag.js";

/*
 * GJJ 🖼️ 使用3D相机节点生成多个角度
 * - 输入仅 image 槽（📂 本地图走同一输入路径）；所有业务参数 widget 隐藏
 *   （后端 hidden: True / display: "hidden"，禁 forceInput）。
 * - 🎯 节点面板内 3D 方向视球：拖动控制点=方向、空白=旋转视角、滚轮=距离、
 *   双击=复位视角；直接驱动 horizontal_angle / vertical_angle / zoom 隐藏
 *   widget（真实值随 prompt 序列化），顶部实时显示英文相机提示词。
 * - 🧠 模型树使用 GJJ_Utils.createModelTreeView：
 *   过滤框自动填入“去路径/扩展名/版本号/量化标记”的组名；源模型缺失自动取过滤列表；
 *   过滤为 0 红显默认模型；选中模型后模型树替换为已选列表，列表框隐藏。
 * - 🖼️ 预览图可拖拽到空白画布或 GJJ_AnyPreview（bindGjjMediaDrag）。
 */
(function () {
	const NODE_CLASS = "GJJ_QwenMultiangleStudio";
	const IMAGE_INPUT = "image";
	const REFERENCE_WIDGET = "reference_info";
	const UPLOAD_SUBFOLDER = "GJJ_QwenMultiangleStudio";
	const PREVIEW_PROP = "gjj_qma_preview";

	const TOOLBAR_WIDGET = "__gjj_qma_toolbar";
	const STATUS_WIDGET = "__gjj_qma_status";
	const FLOATING_KEY = "__gjjQMAFloatingPanel";

	const MISSING = "[未找到模型]";

	// 模型定义（与 Python REQUIRED_MODELS 严格对应；不硬编码绝对路径）
	const MODEL_DEFS = [
		{ widget: "diffusion_model", label: "主模型（Unet）", folder: "models/diffusion_models", icon: "🟣", fallback: "qwen_image_edit_2511_int4_convrot.safetensors" },
		{ widget: "clip_model", label: "文本编码器（CLIP）", folder: "models/text_encoders", icon: "🔵", fallback: "qwen_2.5_vl_7b_int4_convrot.safetensors" },
		{ widget: "vae_model", label: "图像 VAE", folder: "models/vae", icon: "🔴", fallback: "qwen_image_vae.safetensors" },
		{ widget: "lightning_lora", label: "Lightning 4 步加速 LoRA", folder: "models/loras", icon: "🟠", fallback: "QWEN\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors" },
		{ widget: "angle_lora", label: "多角度 LoRA", folder: "models/loras", icon: "🟢", fallback: "QWEN\\2511\\qwen-image-edit-2511-multiple-angles-lora.safetensors" },
	];

	// 参数面板分组（隐藏 widget 名称，与后端 INPUT_TYPES 对应）
	const PARAM_GROUPS = {
		camera: ["horizontal_angle", "vertical_angle", "zoom"],
		sampling: ["enable_4steps", "steps", "cfg", "sampler_name", "scheduler", "denoise", "seed"],
		patch: ["shift", "cfgnorm_strength", "switch", "use_ref_latents", "reference_latents_method"],
		prompt: ["positive_prompt", "negative_prompt"],
	};

	const WIDGET_LABELS = {
		horizontal_angle: "水平角度（°）",
		vertical_angle: "垂直角度（°）",
		zoom: "距离（0 远 - 10 近）",
		seed: "随机种子",
		enable_4steps: "启用 4 步加速",
		steps: "步数（4 步模式）",
		cfg: "CFG（4 步模式）",
		sampler_name: "采样器",
		scheduler: "调度器",
		denoise: "去噪强度",
		shift: "采样偏移 shift",
		cfgnorm_strength: "CFGNorm 强度",
		switch: "模型分支切换",
		use_ref_latents: "使用参考潜空间",
		reference_latents_method: "参考潜空间方法",
		positive_prompt: "正向提示词（附加）",
		negative_prompt: "负向提示词",
	};

	// ------------------------------------------------------------------ 工具
	function getWidget(node, name) {
		return node?.widgets?.find((widget) => widget.name === name) || null;
	}

	function setWidgetValue(widget, value) {
		if (!widget) return;
		widget.value = value;
		try { widget.callback?.(value); } catch (_) {}
		nodeDirty();
	}

	function nodeDirty() {
		try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	}

	function refreshNode(node) {
		try { GJJ_Utils?.refreshNode?.(node); } catch (_) {}
	}

	function getInput(node, name) {
		return node?.inputs?.find((input) => input.name === name) || null;
	}

	function isImageLinked(node) {
		return getInput(node, IMAGE_INPUT)?.link != null;
	}

	function setWidgetHidden(widget, hidden) {
		if (!widget) return;
		widget.hidden = Boolean(hidden);
		widget.options ||= {};
		if (hidden) {
			widget.computeSize = () => [0, -4];
			widget.getHeight = () => 0;
			widget.options.hidden = true;
			widget.options.display = "hidden";
			widget.last_y = 0;
			widget.y = 0;
			widget.computedHeight = 0;
			widget.margin_top = 0;
		} else {
			delete widget.options.hidden;
			delete widget.options.display;
			widget.computeSize = undefined;
			widget.getHeight = undefined;
		}
		if (widget.element) widget.element.style.display = hidden ? "none" : "";
		if (widget.inputEl) widget.inputEl.style.display = hidden ? "none" : "";
	}

	// ------------------------------------------------------------------ 浮动窗
	function closeFloatingPanel(node) {
		const panel = node?.[FLOATING_KEY];
		if (!panel) return;
		if (typeof panel.__close === "function") panel.__close();
		else panel.remove?.();
		if (node[FLOATING_KEY] === panel) node[FLOATING_KEY] = null;
	}

	function showFloatingPanel(node, anchor, title, width, build) {
		closeFloatingPanel(node);
		const panel = document.createElement("div");
		panel.style.cssText = [
			"position:fixed", "z-index:100000", `width:${width}px`, "max-width:calc(100vw - 20px)",
			"max-height:calc(100vh - 30px)", "padding:10px", "box-sizing:border-box",
			"display:flex", "flex-direction:column",
			"border:1px solid #49616b", "border-radius:10px", "background:#10181d",
			"box-shadow:0 18px 48px rgba(0,0,0,.55)", "color:#e4eef0",
			"font:12px/1.4 system-ui,'Microsoft YaHei',sans-serif", "pointer-events:auto",
		].join(";");
		for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
			panel.addEventListener(ev, (e) => e.stopPropagation());
		}
		const closePanel = () => closeFloatingPanel(node);
		const onDown = (event) => {
			if (panel.contains(event.target) || anchor?.contains?.(event.target)) return;
			closePanel();
		};
		const onKey = (event) => { if (event.key === "Escape") closePanel(); };
		panel.__close = () => {
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("keydown", onKey, true);
			panel.remove?.();
			if (node[FLOATING_KEY] === panel) node[FLOATING_KEY] = null;
		};

		const rect = anchor?.getBoundingClientRect?.() || { left: 20, bottom: 20 };
		const left = Math.max(10, Math.min(window.innerWidth - width - 10, Math.max(10, rect.left)));
		const top = Math.min(window.innerHeight - 120, Math.max(10, rect.bottom + 6));
		panel.style.left = `${left}px`;
		panel.style.top = `${top}px`;

		const head = document.createElement("div");
		head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:800;color:#f3faf8;margin-bottom:8px;flex:0 0 auto;";
		const titleEl = document.createElement("span");
		titleEl.textContent = title;
		const closeBtn = document.createElement("button");
		closeBtn.type = "button";
		closeBtn.textContent = "×";
		closeBtn.title = "关闭";
		closeBtn.style.cssText = "width:24px;height:24px;border:1px solid #40535b;border-radius:6px;background:#172228;color:#dce7e2;cursor:pointer;padding:0;line-height:20px";
		closeBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); closePanel(); };
		head.append(titleEl, closeBtn);

		const body = document.createElement("div");
		body.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0;overflow-y:auto;overscroll-behavior:contain;";
		panel.append(head, body);
		build(body);
		document.body.appendChild(panel);
		node[FLOATING_KEY] = panel;
		setTimeout(() => {
			document.addEventListener("pointerdown", onDown, true);
			document.addEventListener("keydown", onKey, true);
		}, 0);
		return body;
	}

	// ------------------------------------------------------------------ 控件
	function sectionTitle(text) {
		const div = document.createElement("div");
		div.textContent = text;
		div.style.cssText = "margin:6px 0 2px;padding:3px 8px;border-radius:6px;background:#16232a;color:#9fd4c3;font-weight:800;";
		return div;
	}

	function fieldRow(labelText, control, hint = "") {
		const wrap = document.createElement("label");
		wrap.style.cssText = "display:grid;grid-template-columns:138px minmax(0,1fr);gap:8px;align-items:center;width:100%;box-sizing:border-box;";
		const span = document.createElement("span");
		span.textContent = labelText;
		span.title = hint || labelText;
		span.style.cssText = "color:#b9c9cd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
		control.style.minWidth = "0";
		control.style.width = "100%";
		control.style.maxWidth = "100%";
		control.style.boxSizing = "border-box";
		wrap.append(span, control);
		return wrap;
	}

	const CONTROL_STYLE = "background:#0b1115;color:#e7f3f3;border:1px solid #354952;border-radius:5px;padding:4px 6px;";

	function bindNumber(node, name) {
		const widget = getWidget(node, name);
		const input = document.createElement("input");
		input.type = "number";
		input.value = String(widget?.value ?? "");
		const opts = widget?.options || {};
		if (opts.min != null) input.min = String(opts.min);
		if (opts.max != null) input.max = String(opts.max);
		input.step = String(opts.step ?? (Number.isInteger(opts.min) && Number.isInteger(opts.max) ? 1 : 0.01));
		input.style.cssText = CONTROL_STYLE;
		const apply = () => {
			const value = Number(input.value);
			if (Number.isFinite(value)) setWidgetValue(widget, value);
		};
		input.addEventListener("change", apply);
		input.addEventListener("blur", apply);
		if (widget) widget.__gjjSyncInput = (value) => { input.value = String(value); };
		return input;
	}

	function bindText(node, name, multiline = false) {
		const widget = getWidget(node, name);
		const input = document.createElement(multiline ? "textarea" : "input");
		if (!multiline) input.type = "text";
		input.value = String(widget?.value ?? "");
		if (multiline) {
			input.rows = 3;
			input.style.cssText = CONTROL_STYLE + "resize:vertical;min-height:52px;";
		} else {
			input.style.cssText = CONTROL_STYLE;
		}
		const apply = () => setWidgetValue(widget, input.value);
		input.addEventListener("change", apply);
		input.addEventListener("blur", apply);
		if (widget) widget.__gjjSyncInput = (value) => { input.value = String(value); };
		return input;
	}

	function bindSelect(node, name) {
		const widget = getWidget(node, name);
		const select = document.createElement("select");
		select.style.cssText = CONTROL_STYLE;
		const values = Array.isArray(widget?.options?.values) ? widget.options.values : [];
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			option.selected = String(widget?.value) === String(value);
			select.appendChild(option);
		}
		select.onchange = () => setWidgetValue(widget, select.value);
		if (widget) widget.__gjjSyncInput = (value) => { select.value = String(value); };
		return select;
	}

	function bindBoolWidget(node, name) {
		const widget = getWidget(node, name);
		const wrap = document.createElement("div");
		wrap.style.cssText = "display:flex;align-items:center;gap:8px;grid-column:1 / -1;cursor:pointer;";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.style.cssText = "width:70px;height:24px;border-radius:12px;padding:0;font-weight:700;cursor:pointer;border:1px solid;";
		const label = document.createElement("span");
		label.textContent = WIDGET_LABELS[name] || name;
		label.title = widget?.options?.tooltip || "";
		label.style.cssText = "color:#c6d4d8;";
		const refresh = () => {
			const on = Boolean(widget?.value);
			btn.textContent = on ? "开启" : "关闭";
			btn.style.background = on ? "#124332" : "#121920";
			btn.style.borderColor = on ? "#55a986" : "#40535c";
			btn.style.color = on ? "#ecfff7" : "#91a3aa";
		};
		btn.onclick = (e) => {
			e.preventDefault(); e.stopPropagation();
			setWidgetValue(widget, !Boolean(widget?.value));
			refresh();
		};
		wrap.append(btn, label);
		wrap.onclick = (e) => {
			if (e.target === wrap || e.target === label) { e.preventDefault(); btn.click(); }
		};
		refresh();
		return wrap;
	}

	function buildFields(node, body, names) {
		for (const name of names) {
			const widget = getWidget(node, name);
			const values = widget?.options?.values;
			if (name === "positive_prompt" || name === "negative_prompt") {
				body.appendChild(fieldRow(WIDGET_LABELS[name] || name, bindText(node, name, true), widget?.options?.tooltip));
			} else if (name === "enable_4steps" || name === "use_ref_latents" || name === "switch") {
				body.appendChild(bindBoolWidget(node, name));
			} else if (Array.isArray(values)) {
				body.appendChild(fieldRow(WIDGET_LABELS[name] || name, bindSelect(node, name), widget?.options?.tooltip));
			} else {
				body.appendChild(fieldRow(WIDGET_LABELS[name] || name, bindNumber(node, name), widget?.options?.tooltip));
			}
		}
	}

	// ------------------------------------------------------------------ 🧠 模型树
	function modelTreeEntries(node) {
		return MODEL_DEFS.map((def) => {
			const widget = getWidget(node, def.widget);
			const models = (Array.isArray(widget?.options?.values) ? widget.options.values : [])
				.filter((name) => String(name || "").trim() && name !== MISSING);
			return {
				widget: def.widget,
				label: def.label,
				folder: def.folder,
				icon: def.icon,
				description: `候选项自动来自 ${def.folder}/ 及其子目录；过滤词由当前模型名自动生成（去路径/扩展名/版本号/量化标记）。`,
				models,
				defaultModel: def.fallback,
				fallback: def.fallback,
				missingDefault: models.length === 0,
				autoSelect: true,
			};
		});
	}

	function showModelPanel(node, anchor) {
		const body = showFloatingPanel(node, anchor, "🧠 模型树（点击行选择 / 顶部过滤）", 640, (panelBody) => {
			const renderPicked = (changedWidget) => {
				panelBody.replaceChildren();
				const tip = document.createElement("div");
				tip.textContent = "✅ 已选择模型。点击任意一行可重新展开完整模型树与过滤列表。";
				tip.style.cssText = "color:#9fd4c3;font-size:12px;padding:2px 4px;";
				panelBody.appendChild(tip);

				const list = document.createElement("div");
				list.style.cssText = "display:flex;flex-direction:column;gap:2px;padding:6px;border:1px solid #33454c;border-radius:8px;background:#0f171b;";
				for (const def of MODEL_DEFS) {
					const widget = getWidget(node, def.widget);
					const raw = String(widget?.value || "");
					const missing = !raw || raw === MISSING
						|| !(Array.isArray(widget?.options?.values) ? widget.options.values : []).includes(raw);
					const filename = missing ? def.fallback : raw.split("/").pop();
					const { row, button } = GJJ_Utils._modelTreeLine(
						"", def.icon, `${def.label}：${filename}`,
						{ clickable: true, selected: changedWidget === def.widget, missing, copyValue: raw || def.fallback });
					button.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); renderTree(); });
					list.appendChild(row);
				}
				panelBody.appendChild(list);

				const expand = document.createElement("button");
				expand.type = "button";
				expand.textContent = "🧠 展开完整模型树";
				expand.style.cssText = "height:28px;border:1px solid #3f5660;border-radius:6px;background:#172228;color:#e7f0ec;cursor:pointer;";
				expand.onclick = (e) => { e.preventDefault(); e.stopPropagation(); renderTree(); };
				panelBody.appendChild(expand);
			};

			const renderTree = () => {
				panelBody.replaceChildren();
				const hint = document.createElement("div");
				hint.textContent = "过滤框已自动填入“去路径 / 扩展名 / 版本号 / 量化标记”后的组名；源模型缺失自动取过滤结果；过滤为 0 时红显默认模型。";
				hint.style.cssText = "color:#91a8ae;font-size:11px;line-height:1.5;padding:0 2px;";
				let treeMounted = false;
				let pendingPick = null;
				const tree = GJJ_Utils.createModelTreeView({
					node,
					entries: modelTreeEntries(node),
					refresh: () => refreshNode(node),
					onApply: (entry) => {
						if (treeMounted) renderPicked(entry?.widget);
						else pendingPick = entry?.widget || null;
					},
				});
				tree.style.maxHeight = "min(560px,calc(100vh - 160px))";
				panelBody.append(hint, tree);
				treeMounted = true;
				if (pendingPick) renderPicked(pendingPick);
			};

			renderTree();
		});
		return body;
	}

	// ------------------------------------------------------------------ 📷 参数面板（方向由节点内视球交互调整）
	function showParamPanel(node, anchor) {
		showFloatingPanel(node, anchor, "📷 采样 / 修补 / 提示词参数", 440, (body) => {
			body.appendChild(sectionTitle("🎚️ 采样（关闭 4 步加速时自动切 40 步 / CFG 4.0）"));
			buildFields(node, body, PARAM_GROUPS.sampling);

			body.appendChild(sectionTitle("🧩 模型修补与参考潜空间"));
			buildFields(node, body, PARAM_GROUPS.patch);

			body.appendChild(sectionTitle("💬 提示词（附加）"));
			buildFields(node, body, PARAM_GROUPS.prompt);

			const hint = document.createElement("div");
			hint.textContent = "📷 相机方向请在节点面板内的 3D 视球上交互调整：拖动控制点=方向，拖动空白=旋转视角，滚轮=距离，双击=复位视角。";
			hint.style.cssText = "margin-top:4px;padding:6px 8px;color:#8fa1a8;font-size:11px;line-height:1.5;border:1px dashed #354952;border-radius:6px;";
			body.appendChild(hint);
		});
	}

	// ------------------------------------------------------------------ 📂 参考图
	function referenceViewUrl(info) {
		try {
			const params = new URLSearchParams({
				filename: info.filename,
				subfolder: info.subfolder || "",
				type: info.type || "input",
			});
			return typeof api.apiURL === "function" ? api.apiURL(`/view?${params.toString()}`) : `/view?${params.toString()}`;
		} catch (_) {
			return "";
		}
	}

	function parseReferenceInfo(node) {
		try { return JSON.parse(getWidget(node, REFERENCE_WIDGET)?.value || "{}"); } catch (_) { return {}; }
	}

	async function uploadReferenceFile(node, file) {
		const form = new FormData();
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("subfolder", UPLOAD_SUBFOLDER);
		const response = api?.fetchApi
			? await api.fetchApi("/upload/image", { method: "POST", body: form })
			: await fetch("/upload/image", { method: "POST", body: form });
		if (!response?.ok) throw new Error(`上传失败：HTTP ${response?.status || "?"}`);
		const data = await response.json().catch(() => ({}));
		return {
			filename: data.name || file.name,
			subfolder: data.subfolder || UPLOAD_SUBFOLDER,
			type: data.type || "input",
		};
	}

	function chooseReferenceImage(node) {
		if (isImageLinked(node)) {
			setStatus(node, { text: "图片接口已连接外部图片，📂 已禁用；如需本地上传请先断开连线。", progress: 0 });
			return;
		}
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = false;
		input.onchange = async () => {
			const file = (input.files || [])[0];
			if (!file) return;
			setStatus(node, { text: `📤 正在上传参考图：${file.name}…`, progress: 0.15 });
			try {
				const info = await uploadReferenceFile(node, file);
				setWidgetValue(getWidget(node, REFERENCE_WIDGET), JSON.stringify(info));
				setInputThumb(node, info);
				setStatus(node, { text: `📂 已选择参考图：${info.filename}`, progress: 0 });
				refreshNode(node);
			} catch (error) {
				setStatus(node, { text: String(error?.message || error || "参考图上传失败"), progress: 0 });
			}
		};
		input.click();
	}

	// ------------------------------------------------------------------ 🖼️ 图片 Lightbox（通用：点击放大 → 滚轮缩放 → 再点关闭）
	// 零依赖全屏遮罩；滚轮以鼠标位置为锚缩放 1..10；放大后可拖拽平移；
	// 短按（位移 < 6px）或按 Esc / 双击重置后再次点击关闭。
	let __gjjLightbox = null;

	function gjjCloseImageLightbox() {
		const lb = __gjjLightbox;
		if (!lb) return;
		__gjjLightbox = null;
		lb.img.onwheel = null;
		document.removeEventListener("keydown", lb.onKey, true);
		try { lb.overlay.remove(); } catch (_) {}
	}

	function gjjOpenImageLightbox(url, label) {
		gjjCloseImageLightbox();
		if (!url) return;

		const overlay = document.createElement("div");
		overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(4,7,11,0.9);display:flex;align-items:center;justify-content:center;cursor:zoom-out;backdrop-filter:blur(3px);";

		const img = document.createElement("img");
		img.style.cssText = "max-width:94vw;max-height:90vh;object-fit:contain;user-select:none;-webkit-user-drag:none;border-radius:6px;transform-origin:0 0;cursor:zoom-out;box-shadow:0 8px 40px rgba(0,0,0,0.55);";

		let scale = 1, tx = 0, ty = 0;
		const apply = () => { img.style.transform = scale === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${scale})`; };
		const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

		// 滚轮缩放（以鼠标位置为锚点）
		img.addEventListener("wheel", (e) => {
			e.preventDefault(); e.stopPropagation();
			const rect = img.getBoundingClientRect();
			const mx = e.clientX - rect.left, my = e.clientY - rect.top;
			const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
			const ns = Math.max(1, Math.min(10, scale * factor));
			const k = ns / scale;
			tx = mx - (mx - tx) * k;
			ty = my - (my - ty) * k;
			scale = ns;
			apply();
		}, { passive: false });

		// 双击重置缩放
		img.addEventListener("dblclick", (e) => { e.stopPropagation(); reset(); });

		// 短按关闭 / 长拖平移
		let drag = null;
		img.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
		});
		img.addEventListener("pointermove", (e) => {
			if (!drag) return;
			const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
			if (Math.hypot(dx, dy) > 6) drag.moved = true;
			if (drag.moved && scale > 1) { tx = drag.tx + dx; ty = drag.ty + dy; apply(); }
		});
		const endPointer = (e) => {
			if (!drag) return;
			const wasMoved = drag.moved;
			drag = null;
			if (!wasMoved) gjjCloseImageLightbox();
		};
		img.addEventListener("pointerup", endPointer);
		img.addEventListener("pointercancel", endPointer);

		// 点遮罩关闭 / Esc 关闭
		overlay.addEventListener("pointerdown", (e) => {
			if (e.target === overlay) gjjCloseImageLightbox();
		});
		const onKey = (e) => {
			if (e.key === "Escape") gjjCloseImageLightbox();
		};
		document.addEventListener("keydown", onKey, true);
		img.onwheel = () => {};

		img.src = url;
		overlay.appendChild(img);

		if (label) {
			const labelEl = document.createElement("div");
			labelEl.textContent = `🖼️ ${label}  ·  滚轮缩放 · 拖动平移 · 点击/Esc 关闭`;
			labelEl.style.cssText = "position:fixed;left:14px;bottom:12px;color:#9fb4bd;font:12px monospace;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
			overlay.appendChild(labelEl);
		}

		document.body.appendChild(overlay);
		__gjjLightbox = { overlay, img, onKey };
	}

	// ------------------------------------------------------------------ 状态栏 / 预览
	const STATUS_HEIGHT_PLAIN = 88;
	const STATUS_HEIGHT_THUMB = 196;

	function resizeStatus(node) {
		const widget = node.__gjjQMAStatusWidget;
		if (!widget) return;
		const hasThumb = node.__gjjQMAThumbWrap?.style.display === "flex";
		widget.getHeight = () => (hasThumb ? STATUS_HEIGHT_THUMB : STATUS_HEIGHT_PLAIN);
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		refreshNode(node);
	}

	function currentThumbInfo(node) {
		return node?.__gjjQMAThumbInfo || null;
	}

	function setThumb(node, info, label) {
		const wrap = node.__gjjQMAThumbWrap;
		const img = node.__gjjQMAThumb;
		if (!wrap || !img) return;
		node.__gjjQMAThumbInfo = info || null;
		if (!info?.filename) {
			wrap.style.display = "none";
			resizeStatus(node);
			return;
		}
		img.src = referenceViewUrl(info);
		wrap.style.display = "flex";
		if (node.__gjjQMAThumbName) node.__gjjQMAThumbName.textContent = `🖼️ ${label || info.filename}`;
		resizeStatus(node);
	}

	function setInputThumb(node, info) {
		node.properties ||= {};
		node.properties["gjj_qma_input"] = info || null;
		setThumb(node, info, `📂 参考图：${info?.filename || ""}`);
	}

	function setPreviewThumb(node, info) {
		node.properties ||= {};
		node.properties[PREVIEW_PROP] = info || null;
		setThumb(node, info, `输出：${info?.filename || ""}`);
	}

	function setStatus(node, detail) {
		const textEl = node?.__gjjQMAStatusText;
		const barEl = node?.__gjjQMAStatusBar;
		if (!textEl || !barEl) return;
		textEl.textContent = String(detail?.text ?? "");
		const progress = Number(detail?.progress);
		if (Number.isFinite(progress) && progress >= 0) {
			barEl.style.width = `${Math.round(progress * 100)}%`;
		}
	}

	function makeToolButton(text, title, onClick) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = text;
		button.title = title;
		button.style.cssText = [
			"width:30px", "height:26px", "font-size:14px",
			"border:1px solid #3f5660", "border-radius:6px",
			"background:#172228", "color:#e7f0ec", "cursor:pointer", "padding:0",
		].join(";");
		button.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick(button);
		};
		return button;
	}

	function refreshToolbarState(node) {
		if (node.__gjjQMAFileButton) {
			const linked = isImageLinked(node);
			node.__gjjQMAFileButton.disabled = linked;
			node.__gjjQMAFileButton.style.opacity = linked ? "0.4" : "1";
			node.__gjjQMAFileButton.title = linked
				? "图片接口已连接外部图片，📂 已禁用"
				: "打开本地参考图片（上传到 input 目录）";
		}
		if (node.__gjjQMARunButton) {
			const running = Boolean(node.__gjjQMARunInFlight);
			node.__gjjQMARunButton.disabled = running;
			node.__gjjQMARunButton.textContent = running ? "⏳" : "▶️";
			node.__gjjQMARunButton.style.opacity = running ? "0.7" : "1";
		}
		if (node.__gjjQMACamButton) {
			const camHidden = node.properties?.gjj_qma_show_camera !== true;
			node.__gjjQMACamButton.style.border = camHidden ? "1px solid #E93D82" : "1px solid #3f5660";
			node.__gjjQMACamButton.style.color = camHidden ? "#E93D82" : "#e7f0ec";
			node.__gjjQMACamButton.style.background = camHidden ? "rgba(233,61,130,0.12)" : "#172228";
			node.__gjjQMACamButton.title = camHidden ? "显示顶部角度参数栏（水平/垂直/距离）" : "隐藏顶部角度参数栏（水平/垂直/距离）";
		}
	}

	// ------------------------------------------------------------------ ▶️ 执行
	function graphLinkById(linkId) {
		const links = app.graph?.links;
		if (!links || linkId == null) return null;
		return Array.isArray(links) ? links.find((l) => Number(l?.id) === Number(linkId)) || null : (links[linkId] || null);
	}

	function collectUpstreamIds(node) {
		const keep = new Set();
		const visit = (current) => {
			for (const input of current?.inputs || []) {
				const link = graphLinkById(input?.link);
				const originId = link?.origin_id;
				if (originId == null || keep.has(String(originId))) continue;
				keep.add(String(originId));
				const origin = app.graph?.getNodeById?.(originId);
				if (origin) visit(origin);
			}
		};
		visit(node);
		return keep;
	}

	async function queueOnlyCurrentNode(node) {
		if (!node?.graph) return false;
		const allNodes = app.graph?._nodes || [];
		const upstream = collectUpstreamIds(node);
		const savedModes = [];
		const oldSelected = app.canvas?.selected_nodes;
		const oldSingle = app.canvas?.selected_node;
		try {
			for (const item of allNodes) {
				if (!item || item === node || upstream.has(String(item.id))) continue;
				if (item.constructor?.nodeData?.output_node || item.nodeData?.output_node || item.flags?.output) {
					savedModes.push([item, item.mode]);
					item.mode = 2; // 仅临时静音其它输出节点
				}
			}
			if (app.canvas) {
				app.canvas.selected_nodes = { [node.id]: node };
				app.canvas.selected_node = node;
			}
			refreshNode(node);
			if (typeof app.queuePrompt === "function") {
				await app.queuePrompt(0, 1);
				return true;
			}
			return false;
		} finally {
			for (const [item, mode] of savedModes) item.mode = mode;
			if (app.canvas) {
				app.canvas.selected_nodes = oldSelected;
				app.canvas.selected_node = oldSingle;
			}
			refreshNode(node);
		}
	}

	async function runCurrentNode(node, button) {
		if (node.__gjjQMARunInFlight) return;
		if (!isImageLinked(node)) {
			const info = parseReferenceInfo(node);
			if (!info?.filename) {
				setStatus(node, { text: "请先点 📂 选择参考图片，或连接外部 IMAGE 输入。", progress: 0 });
				return;
			}
		}
		node.__gjjQMARunInFlight = true;
		button.disabled = true;
		button.textContent = "⏳";
		button.style.opacity = "0.7";
		setStatus(node, { text: "⏳ 已加入队列，只执行当前节点…", progress: 0.02 });
		try {
			await queueOnlyCurrentNode(node);
		} catch (error) {
			setStatus(node, { text: String(error?.message || error || "执行失败"), progress: 0 });
		} finally {
			setTimeout(() => {
				node.__gjjQMARunInFlight = false;
				button.disabled = false;
				button.textContent = "▶️";
				button.style.opacity = "1";
				refreshToolbarState(node);
			}, 500);
		}
	}

	// ------------------------------------------------------------------ 🎯 CameraAngle 风格 3D 方向视球（节点内部交互调整相机方向）
	// 复刻原工作流 CameraAngle 节点 UI：3D 场景中心卡片贴输入图片，
	// 粉=方位环（水平角）、青=俯仰弧（垂直角）、黄=距离手柄（zoom）三向微调，
	// 空白=旋转视角、滚轮=距离、双击=复位视角；直接驱动隐藏 widget
	// horizontal_angle / vertical_angle / zoom（真实值随 prompt 序列化），顶部实时显示英文相机提示词。
	const ORBIT_WIDGET = "__gjj_qma_orbit";
	const ORBIT_H = 300;
	const ORBIT_H_MAX = 560;
	const ORBIT_SNAP_DEG = 5;

	function _d2r(x) { return (x * Math.PI) / 180; }
	function _r2d(x) { return (x * 180) / Math.PI; }

	class OrbitView2 {
		constructor() { this.yaw = Math.atan2(4, 4); this.tilt = Math.atan2(3.2, Math.hypot(4, 4)); } // (4,3.5,4)→(0,0.3,0) 固定视角
		rot(p) {
			const [x, y, z] = p;
			const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
			const ct = Math.cos(this.tilt), st = Math.sin(this.tilt);
			const xr = x * cy + y * sy;
			const yr = -x * sy + y * cy;
			return [xr, yr * ct - z * st, yr * st + z * ct]; // yv<0 => 朝向观察者
		}
	}

	// ---- 视角描述（与后端 _camera_prompt 严格一致）----
	function _hDirEn(h) {
		const a = h % 360;
		if (a < 22.5 || a >= 337.5) return "front view";
		if (a < 67.5) return "front-right quarter view";
		if (a < 112.5) return "right side view";
		if (a < 157.5) return "back-right quarter view";
		if (a < 202.5) return "back view";
		if (a < 247.5) return "back-left quarter view";
		if (a < 292.5) return "left side view";
		return "front-left quarter view";
	}
	function _vDirEn(v) {
		if (v < -15) return "low-angle shot";
		if (v < 15) return "eye-level shot";
		if (v < 45) return "elevated shot";
		return "high-angle shot";
	}
	function _dLabelEn(z) {
		if (z < 2) return "wide shot";
		if (z < 6) return "medium shot";
		return "close-up";
	}
	function _cameraPrompt(h, v, z) {
		return `${_hDirEn(h)} ${_vDirEn(v)} ${_dLabelEn(z)}`;
	}

	// ---- 视球坐标 ↔ 节点参数换算 ----
	// zoom(0 远 - 10 近)：相机距离 2.6..0.6（与 CameraAngle 一致：dist = 2.6 - (zoom/10)*2.0）
	function _clampV(v) { return Math.max(-30, Math.min(60, Math.round(Number(v) || 0))); }
	function _normH(h) { return ((Math.round(Number(h) || 0) % 360) + 360) % 360; }

	// ---- CameraAngle 同款控制面板选项（方位 8 档 / 俯仰 4 档 / 距离 3 档）----
	const AZ_OPTS = [
		[0, "正面"], [45, "右前方"], [90, "右侧"], [135, "右后方"],
		[180, "背面"], [225, "左后方"], [270, "左侧"], [315, "左前方"],
	];
	const EL_OPTS = [[-30, "低角度"], [0, "平视"], [30, "升高"], [60, "高角度"]];
	const DZ_OPTS = [[1, "广角"], [4, "中景"], [8, "特写"]];
	const PANEL_H = 34;

	function _closestAz(h) {
		const a = ((Math.round(h) % 360) + 360) % 360;
		let best = AZ_OPTS[0][0], min = 361;
		for (const [v] of AZ_OPTS) {
			let d = Math.abs(a - v); d = Math.min(d, Math.abs(a - v - 360), Math.abs(a - v + 360));
			if (d < min) { min = d; best = v; }
		}
		return best;
	}
	function _closestEl(v) {
		let best = EL_OPTS[0][0], min = 1e9;
		for (const [vv] of EL_OPTS) { const d = Math.abs(Number(v) - vv); if (d < min) { min = d; best = vv; } }
		return best;
	}
	function _closestDz(z) { return Number(z) < 2 ? 1 : (Number(z) < 6 ? 4 : 8); }

	// ---- CameraAngle 风格 3D 世界（世界单位 / 相机最远距离 2.6 归一后投影）----
	// 卡片中心 (0, 0.5, 0)，正面朝 +Z；方位角 h：0=正面(+Z)、90=右、180=背、270=左
	const W_CENTER_Y = 0.5;
	const AZ_RING_R = 1.8;   // 方位环半径（水平面 y=0.16）
	const AZ_RING_Y = 0.16;
	const EL_ARC_X = -0.8;   // 俯仰弧所在 x（卡片左侧）
	const EL_ARC_R = 1.4;    // 俯仰弧半径
	const CAM_DIST_FAR = 2.6; // zoom=0 相机距离
	const CAM_DIST_SPAN = 2.0; // zoom=10 时 dist = 2.6-2.0 = 0.6
	const PROJ_DEPTH = 1.9;  // 透视深度常数

	// 相机世界位置（与 CameraAngle updateVisuals 一致）
	function _camPos(h, v, z) {
		const a = _d2r(h), e = _d2r(v);
		const d = CAM_DIST_FAR - (Math.max(0, Math.min(10, Number(z) || 0)) / 10) * CAM_DIST_SPAN;
		return [
			d * Math.sin(a) * Math.cos(e),
			W_CENTER_Y + d * Math.sin(e),
			d * Math.cos(a) * Math.cos(e),
		];
	}

	class OrbitEditor {
		constructor(node, canvas, panel) {
			const self = this;
			this.node = node;
			this.canvas = canvas;
			this.ctx = canvas.getContext("2d");
			this.view = new OrbitView2();
			this.panel = panel || null; // { az, el, dz } 下拉（CameraAngle 同款面板）
			this.drag = null;      // "azimuth" | "elevation" | "distance" | "view"
			this.lastPos = null;
			this.dragStart = null;
			this.handles = {};     // 屏幕坐标 {azimuth:[x,y], elevation:[x,y], distance:[x,y], camera:[x,y]}
			this.cardImage = null; // 输入图片（HTMLImageElement）
			this._imgKey = "";
			this._imgToken = 0;
			this._time = 0;        // 动画时钟（光球脉冲 / 发光环旋转）
			this._hover = null;    // "azimuth" | "elevation" | "distance" | null（手柄悬停放大）
			this._renderKey = "";

			canvas.addEventListener("pointerdown", (e) => {
				canvas.setPointerCapture?.(e.pointerId);
				this.onDown(e);
			});
			canvas.addEventListener("pointerup", (e) => {
				e.stopPropagation();
				if (this.drag) this.onUp();
			});
			canvas.addEventListener("dblclick", () => {
				this.view.yaw = Math.atan2(4, 4); this.view.tilt = Math.atan2(3.2, Math.hypot(4, 4));
				this.render(true);
			});
			this._onMove = (e) => this.onMove(e);
			this._onUp = () => this.onUp();

			const prevRemoved = node.onRemoved;
			node.onRemoved = function () {
				document.removeEventListener("pointermove", self._onMove);
				document.removeEventListener("pointerup", self._onUp);
				return prevRemoved?.apply(this, arguments);
			};

			this._raf = () => {
				// isConnected=false（节点折叠/临时移出 DOM）时跳过本帧但绝不中断调度：
				// 一旦重新连接立即恢复渲染（否则 rAF 链死亡 → 画面永久冻结）
				if (this.canvas.isConnected) {
					this._time += 0.016;
					this.loadCardImageIfChanged();
					this.render(true);
				}
				requestAnimationFrame(this._raf);
			};
			requestAnimationFrame(this._raf);

			// 手柄悬停放大 + 光标（CameraAngle hoveredHandle 同款）
			canvas.addEventListener("mousemove", (e) => {
				if (this.drag) return;
				const [x, y] = this.canvasPos(e);
				let hover = null;
				for (const n of ["azimuth", "elevation", "distance"]) {
					const p = this.handles?.[n];
					if (p && Math.hypot(x - p[0], y - p[1]) <= 14) { hover = n; break; }
				}
				if (hover !== this._hover) {
					this._hover = hover;
					this.canvas.style.cursor = hover ? "grab" : "default";
					this.render(true);
				}
			});
			canvas.addEventListener("mouseleave", () => {
				if (this._hover) { this._hover = null; this.render(true); }
			});
		}

		// 读取隐藏 widget 当前值
		vals() {
			return {
				h: _normH(getWidget(this.node, "horizontal_angle")?.value ?? 42),
				v: _clampV(getWidget(this.node, "vertical_angle")?.value ?? 19),
				z: Math.max(0, Math.min(10, Number(getWidget(this.node, "zoom")?.value ?? 10) || 0)),
			};
		}
		canvasPos(e) {
			const r = this.canvas.getBoundingClientRect();
			return [
				(e.clientX - r.left) * (this.canvas.width / (r.width || 1)),
				(e.clientY - r.top) * (this.canvas.height / (r.height || 1)),
			];
		}
		geom() {
			const W = this.canvas.width, H = this.canvas.height;
			const S = Math.min(W - 20, H - 70);
			return { cx: W / 2, cy: 16 + S / 2, R: (S / 2) * 0.85 };
		}
		// 透视投影：世界坐标（/2.6 归一）→ 屏幕 [x, y, scale]
		proj(g, wx, wy, wz) {
			const [xr, yv, zv] = this.view.rot([wx / CAM_DIST_FAR, wy / CAM_DIST_FAR, wz / CAM_DIST_FAR]);
			const s = PROJ_DEPTH / (PROJ_DEPTH + yv);
			return [g.cx + g.R * s * xr, g.cy - g.R * s * zv, s];
		}
		// 输入图片加载（image 接口 → 无则回退 reference_info 本地图 → /view 贴中心卡片）
		loadCardImageIfChanged() {
			// 优先读上游连接的最新图（Load Image 换图自动跟随；断开自动回退）
			let val = null;
			const link = getInput(this.node, IMAGE_INPUT)?.link;
			if (link != null) {
				try {
					const lin = app.graph?.links?.[link];
					const src = lin ? (app.graph?._nodes || []).find((n) => String(n.id) === String(lin.origin_id)) : null;
					const imgW = src?.widgets?.find((w) =>
						(w.name === "images" || w.name === "image") && w.value && typeof w.value === "object" && w.value.filename);
					val = imgW?.value || null;
				} catch (_) {}
			}
			if (!val) val = getWidget(this.node, IMAGE_INPUT)?.value || null;
			let key = "", type = "input";
			if (val && typeof val === "object" && val.filename) {
				key = (val.subfolder ? String(val.subfolder).replace(/\\/g, "/") + "/" : "") + val.filename;
				type = val.type || "input";
			} else if (val) {
				key = String(val);
			} else {
				// 未连 image 接口：回退读 reference_info（📂 上传的本地图）
				const ref = getWidget(this.node, REFERENCE_WIDGET)?.value;
				if (ref) {
					try {
						const info = JSON.parse(String(ref));
						if (info?.filename) {
							key = (info.subfolder ? String(info.subfolder).replace(/\\/g, "/") + "/" : "") + info.filename;
							type = info.type || "input";
						}
					} catch (_) {}
				}
			}
			if (key === this._imgKey) return;
			this._imgKey = key;
			this._imgTypeTry = 0;
			this.cardImage = null;
			if (!key) { this.render(true); return; }
			this._loadCardImage(key, type);
		}
		_loadCardImage(key, type) {
			const tok = ++this._imgToken;
			const parts = key.replace(/\\/g, "/").split("/");
			const filename = parts.pop() || "";
			const subfolder = parts.join("/");
			let url = "/view?filename=" + encodeURIComponent(filename)
				+ "&type=" + type + "&subfolder=" + encodeURIComponent(subfolder);
			if (window.app?.api?.apiURL) url = window.app.api.apiURL(url);
			const img = new Image();
			const retry = () => {
				// input 目录读不到时回退 temp（外部拖入的临时文件）
				if (type === "input") this._loadCardImage(key, "temp");
				else if (tok === this._imgToken) { this.cardImage = null; this.render(true); }
			};
			img.onload = () => { if (tok === this._imgToken) { this.cardImage = img; this.render(true); } };
			img.onerror = retry;
			img.src = url;
		}
		// 屏幕点 → 与世界几何平面求交（CameraAngle 同款抓取跟随）
		// pinhole 透视下射线参数化：rot 空间 p = ((1 + y/f)·U, y, -(1 + y/f)·V)，y 为自由深度；
		// 与平面约束联立解 y，再逆旋转回世界坐标。
		// which="az"：水平面 y=AZ_RING_Y → 世界方位角；which="el"：竖平面 x=EL_ARC_X → 世界俯仰角
		_pickWorld(x, y, g, which) {
			const U = (x - g.cx) / g.R, V = (y - g.cy) / g.R;
			const { yaw, tilt } = this.view;
			const cy = Math.cos(yaw), sy = Math.sin(yaw);
			const ct = Math.cos(tilt), st = Math.sin(tilt);
			const f = PROJ_DEPTH;
			let yv;
			if (which === "az") {
				const A = sy * U - cy * st * V;
				const Y0 = 0; // CameraAngle 拖拽平面 y=0（手柄视觉在 y=0.16）
				const den = A / f + cy * ct;
				if (Math.abs(den) < 1e-9) return null;
				yv = (Y0 - A) / den;
			} else {
				// 世界 x = cy·px - sy·ct·py - sy·st·pz，px=kU, py=yv, pz=-kV
				const A = cy * U + sy * st * V;
				const X0 = EL_ARC_X / CAM_DIST_FAR;
				const den = A / f - sy * ct;
				if (Math.abs(den) < 1e-9) return null;
				yv = (X0 - A) / den;
			}
			const k = 1 + yv / f;
			const px = k * U, py = yv, pz = -k * V;
			// Rᵀ 逆旋转回世界坐标
			const wx = cy * px - sy * ct * py - sy * st * pz;
			const wy = sy * px + cy * ct * py + cy * st * pz;
			const wz = -st * py + ct * pz;
			return [wx, wy, wz];
		}
		onDown(e) {
			e.preventDefault(); e.stopPropagation();
			if (e.button !== 0) return;
			const [x, y] = this.canvasPos(e);
			// 右上角"📂 上传图"按钮
			const ub = this._uploadBtn;
			if (ub && x >= ub.x && x <= ub.x + ub.w && y >= ub.y && y <= ub.y + ub.h) {
				chooseReferenceImage(this.node);
				return;
			}
			const hit = (key, pad) => {
				const p = this.handles[key];
				return p && Math.hypot(x - p[0], y - p[1]) <= pad;
			};
			// CameraAngle 交互：仅手柄可拖（未命中=无动作，固定视角不可拖空白）
			if (hit("azimuth", 18)) {
				this.drag = "azimuth";
			} else if (hit("elevation", 18)) {
				this.drag = "elevation";
			} else if (hit("distance", 18)) {
				this.drag = "distance";
			} else {
				return;
			}
			this.lastPos = [x, y];
			this.dragStart = [x, y];
			const sv = this.vals();
			this.dragStartH = sv.h;
			this.dragStartV = sv.v;
			this.dragStartZ = sv.z;
			this.canvas.style.cursor = "grabbing";
			document.addEventListener("pointermove", this._onMove);
			document.addEventListener("pointerup", this._onUp);
		}
		onMove(e) {
			if (!this.drag) return;
			const [x, y] = this.canvasPos(e);
			const g = this.geom();
			if (this.drag === "azimuth") {
				// 抓取跟随：射线与方位环水平面求交，手柄沿环跟手移动（5° 吸附）
				const w = this._pickWorld(x, y, g, "az");
				if (w) {
					let h = _r2d(Math.atan2(w[0], w[2]));
					if (h < 0) h += 360;
					this.write(_normH(Math.round(h)), null, null);
				}
			} else if (this.drag === "elevation") {
				// 抓取跟随：射线与俯仰弧竖平面求交，手柄沿弧跟手移动（5° 吸附）
				const w = this._pickWorld(x, y, g, "el");
				if (w) {
					const v = _clampV(Math.round(_r2d(Math.atan2(w[1] - W_CENTER_Y / CAM_DIST_FAR, w[2]))));
					this.write(null, v, null);
				}
			} else if (this.drag === "distance") {
				// CameraAngle 同款：newDist = 5 - mouse.y*5（NDC）→ 内部坐标 10*y/h（上=远、下=近）
				const next = Math.max(0, Math.min(10, Math.round((10 * y / Math.max(1, this.canvas.height)) * 10) / 10));
				this.write(null, null, next);
			}
			this.render(true);
		}
		onUp() {
			this.drag = null;
			this.canvas.style.cursor = "default";
			document.removeEventListener("pointermove", this._onMove);
			document.removeEventListener("pointerup", this._onUp);
		}
		// 写入隐藏 widget（仅传入非 null 项）
		write(h, v, z) {
			if (h != null) setWidgetValue(getWidget(this.node, "horizontal_angle"), h);
			if (v != null) setWidgetValue(getWidget(this.node, "vertical_angle"), v);
			if (z != null) setWidgetValue(getWidget(this.node, "zoom"), z);
		}
		render(force) {
			const cw = this.canvas.clientWidth | 0, ch = this.canvas.clientHeight | 0;
			if (cw > 0 && ch > 0 && (this.canvas.width !== cw || this.canvas.height !== ch)) {
				this.canvas.width = cw;
				this.canvas.height = ch;
			}
			const { h, v, z } = this.vals();
			const g = this.geom();
			const key = `${h}|${v}|${z}|${this.view.yaw.toFixed(3)}|${this.view.tilt.toFixed(3)}|${this.canvas.width}x${this.canvas.height}|${this._imgKey}`;
			if (!force && key === this._renderKey) return;
			this._renderKey = key;

			const ctx = this.ctx;
			const W = this.canvas.width, H = this.canvas.height;
			const P = (wx, wy, wz) => this.proj(g, wx, wy, wz);
			ctx.clearRect(0, 0, W, H);
			ctx.fillStyle = "#0a0a0f";
			ctx.fillRect(0, 0, W, H);

			// 顶部：实时相机提示词（CameraAngle prompt-overlay 同款：深色底条 + 粉色细边；右侧留上传按钮位）
			const promptText = _cameraPrompt(h, v, z);
			ctx.font = "12px 'JetBrains Mono',Consolas,monospace";
			const maxPW = Math.max(120, W - 104);
			let shown = promptText;
			while (shown.length > 4 && ctx.measureText(shown + "…").width > maxPW) shown = shown.slice(0, -1);
			if (shown !== promptText) shown += "…";
			const ptw = ctx.measureText(shown).width;
			ctx.fillStyle = "rgba(10,10,15,0.9)";
			ctx.fillRect(4, 2, ptw + 14, 21);
			ctx.strokeStyle = "rgba(233,61,130,0.3)";
			ctx.lineWidth = 1;
			ctx.strokeRect(4, 2, ptw + 14, 21);
			ctx.fillStyle = "#E93D82";
			ctx.fillText(shown, 11, 17);

			// 地面网格（GridHelper(5,20) 同款：深色 #1a1a2e/#12121a，y=0 平面）
			ctx.strokeStyle = "rgba(26,26,46,0.9)"; ctx.lineWidth = 1;
			for (let gx = -2; gx <= 2; gx += 0.25) {
				const a = P(gx, 0, -2), b = P(gx, 0, 2);
				ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
				const c1 = P(-2, 0, gx), d1 = P(2, 0, gx);
				ctx.beginPath(); ctx.moveTo(c1[0], c1[1]); ctx.lineTo(d1[0], d1[1]); ctx.stroke();
			}
			ctx.strokeStyle = "rgba(60,60,90,0.7)"; ctx.lineWidth = 1.2;
			const ax = P(-2, 0, 0), bx = P(2, 0, 0);
			ctx.beginPath(); ctx.moveTo(ax[0], ax[1]); ctx.lineTo(bx[0], bx[1]); ctx.stroke();
			const az2 = P(0, 0, -2), bz2 = P(0, 0, 2);
			ctx.beginPath(); ctx.moveTo(az2[0], az2[1]); ctx.lineTo(bz2[0], bz2[1]); ctx.stroke();

			// 方位环（粉色 Torus 0xE93D82 opacity 0.7，水平面，粗管效果）
			ctx.strokeStyle = "rgba(233,61,130,0.7)"; ctx.lineWidth = 2.4;
			ctx.beginPath();
			for (let a = 0; a <= 360; a += 5) {
				const pt = P(AZ_RING_R * Math.sin(_d2r(a)), AZ_RING_Y, AZ_RING_R * Math.cos(_d2r(a)));
				a ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]);
			}
			ctx.stroke();

			// 俯仰弧（青色 Tube 0x00FFD0 opacity 0.8，x=-0.8 侧面，-30°..60°，粗管效果）
			ctx.strokeStyle = "rgba(0,255,208,0.8)"; ctx.lineWidth = 2.4;
			ctx.beginPath();
			for (let a = -30; a <= 60; a += 2) {
				const pt = P(EL_ARC_X, W_CENTER_Y + EL_ARC_R * Math.sin(_d2r(a)), EL_ARC_R * Math.cos(_d2r(a)));
				a === -30 ? ctx.moveTo(pt[0], pt[1]) : ctx.lineTo(pt[0], pt[1]);
			}
			ctx.stroke();

			// ---- 中心立方体（CameraAngle 同款：正面贴图 + 右侧"右侧"标签 + 顶面网格 + 粉色棱线）----
			const CUBE_HW = 0.62, CUBE_HH = 0.62, CUBE_HD = 0.34;
			const cc = P(0, W_CENTER_Y, 0);
			const V = [
				[-CUBE_HW, -CUBE_HH, -CUBE_HD], [CUBE_HW, -CUBE_HH, -CUBE_HD], [CUBE_HW, CUBE_HH, -CUBE_HD], [-CUBE_HW, CUBE_HH, -CUBE_HD],
				[-CUBE_HW, -CUBE_HH, CUBE_HD], [CUBE_HW, -CUBE_HH, CUBE_HD], [CUBE_HW, CUBE_HH, CUBE_HD], [-CUBE_HW, CUBE_HH, CUBE_HD],
			].map(([x, y, z]) => P(x, W_CENTER_Y + y, z));
			const quad = (a, b, c, d) => [V[a], V[b], V[c], V[d]];
			// 仿射映射：单位正方形 [-1,1]² → 四边形（透视投影保持平行性）
			const fillQuad = (pts, draw) => {
				const [p0, p1, p2, p3] = pts;
				const ux = p1[0] - p0[0], uy = p1[1] - p0[1];
				const vx = p3[0] - p0[0], vy = p3[1] - p0[1];
				ctx.save();
				ctx.setTransform(ux / 2, uy / 2, vx / 2, vy / 2, p0[0] + ux / 2 + vx / 2, p0[1] + uy / 2 + vy / 2);
				draw();
				ctx.restore();
			};
			// 正面（z+）：输入图（CameraAngle 保持图像比例，露出 #3a3a4a 材质底色）
			const ar = (this.cardImage && this.cardImage.width > 0 && this.cardImage.height > 0)
				? this.cardImage.width / this.cardImage.height : 1;
			// ---- 6 面完整立方体：背面剔除 + 画家算法（按面中心到相机距离远→近）----
			const camWorld = _camPos(h, v, z);
			const faceCenterWorld = (idx) => {
				let sx = 0, sy = 0, sz = 0;
				for (const i of idx) {
					const x = (i === 0 || i === 3 || i === 4 || i === 7) ? -CUBE_HW : CUBE_HW;
					const y = (i < 4) ? -CUBE_HH : CUBE_HH;
					const zz = (i < 4) ? -CUBE_HD : CUBE_HD;
					sx += x; sy += y; sz += zz;
				}
				return [sx / 4, W_CENTER_Y + sy / 4, sz / 4];
			};
			const FACES = [
				{ name: "front", idx: [4, 5, 6, 7], n: [0, 0, 1], draw: () => {
					ctx.fillStyle = "#3a3a4a";
					ctx.fillRect(-1, -1, 2, 2);
					if (this.cardImage) {
						const w2 = ar >= 1 ? 1 : ar;
						const h2 = ar >= 1 ? 1 / ar : 1;
						ctx.drawImage(this.cardImage, -w2, -h2, w2 * 2, h2 * 2);
					} else {
						ctx.strokeStyle = "rgba(90,100,125,0.5)"; ctx.lineWidth = 1 / (cc[2] || 1);
						for (let i = -3; i <= 3; i++) {
							const step = 2 / 3;
							ctx.beginPath(); ctx.moveTo(i * step, -1); ctx.lineTo(i * step, 1); ctx.stroke();
							ctx.beginPath(); ctx.moveTo(-1, i * step); ctx.lineTo(1, i * step); ctx.stroke();
						}
					}
				} },
				{ name: "back", idx: [0, 1, 2, 3], n: [0, 0, -1], draw: () => gridFace("#20222f") },
				{ name: "right", idx: [1, 2, 6, 5], n: [1, 0, 0], draw: () => gridFace("#26283a") },
				{ name: "left", idx: [0, 3, 7, 4], n: [-1, 0, 0], draw: () => gridFace("#26283a") },
				{ name: "top", idx: [3, 2, 6, 7], n: [0, 1, 0], draw: () => gridFace("#1e2029") },
				{ name: "bottom", idx: [0, 1, 5, 4], n: [0, -1, 0], draw: () => gridFace("#1e2029") },
			];
			const gridFace = (bg) => {
				ctx.fillStyle = bg;
				ctx.fillRect(-1, -1, 2, 2);
				ctx.strokeStyle = "rgba(120,130,160,0.3)"; ctx.lineWidth = 1 / (cc[2] || 1);
				for (let i = -3; i <= 3; i++) {
					const step = 2 / 3;
					ctx.beginPath(); ctx.moveTo(i * step, -1); ctx.lineTo(i * step, 1); ctx.stroke();
					ctx.beginPath(); ctx.moveTo(-1, i * step); ctx.lineTo(1, i * step); ctx.stroke();
				}
			};
			const camDir = [camWorld[0] - 0, camWorld[1] - W_CENTER_Y, camWorld[2] - 0];
			const visFaces = FACES
				.map((f) => {
					const c = faceCenterWorld(f.idx);
					const dot = f.n[0] * camDir[0] + f.n[1] * camDir[1] + f.n[2] * camDir[2];
					const depth = Math.hypot(c[0] - camWorld[0], c[1] - camWorld[1], c[2] - camWorld[2]);
					return { f, dot, depth };
				})
				.filter((x) => x.dot > 0)
				.sort((a, b) => b.depth - a.depth);
			for (const { f } of visFaces) fillQuad(quad(f.idx[0], f.idx[1], f.idx[2], f.idx[3]), f.draw);
			// 面方向标签（屏幕空间小字，不随面拉伸变形，CameraAngle 同款：右侧/左侧/顶部）
			for (const { f } of visFaces) {
				const label = f.name === "right" ? "右侧" : (f.name === "left" ? "左侧" : (f.name === "top" ? "顶部" : null));
				if (!label) continue;
				const pts = quad(f.idx[0], f.idx[1], f.idx[2], f.idx[3]);
				const lx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
				const ly = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
				ctx.fillStyle = "rgba(255,255,255,0.95)";
				ctx.font = "bold 9px monospace";
				ctx.textAlign = "center"; ctx.textBaseline = "middle";
				ctx.fillText(label, lx, ly);
				ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
			}
			// 粉色棱线（EdgesGeometry 同款：12 条棱）
			ctx.strokeStyle = "#E93D82"; ctx.lineWidth = 1.6;
			for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
				ctx.beginPath(); ctx.moveTo(V[a][0], V[a][1]); ctx.lineTo(V[b][0], V[b][1]); ctx.stroke();
			}
			// 粉色发光环（CameraAngle RingGeometry 0.55-0.58，水平绕卡片脚下 y=0.01）
			ctx.strokeStyle = "rgba(233,61,130,0.4)"; ctx.lineWidth = 2;
			ctx.beginPath();
			for (let t = 0; t <= 48; t++) {
				const a = (t / 48) * Math.PI * 2;
				const pt = P(0.58 * Math.cos(a), 0.01, 0.58 * Math.sin(a));
				t ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]);
			}
			ctx.stroke();

			// ---- 相机（粉色四棱锥 + 粉光球脉冲）+ 距离（黄线 + 黄色球 + 光晕）----
			const cam = _camPos(h, v, z);
			const cp = P(cam[0], cam[1], cam[2]);
			ctx.strokeStyle = "rgba(255,184,0,0.8)"; ctx.lineWidth = 1.4;
			ctx.beginPath(); ctx.moveTo(cc[0], cc[1]); ctx.lineTo(cp[0], cp[1]); ctx.stroke();
			const dt = 0.15 + ((10 - z) / 10) * 0.7;
			const dh = [cc[0] + (cp[0] - cc[0]) * dt, cc[1] + (cp[1] - cc[1]) * dt];
			ctx.fillStyle = "rgba(255,184,0,0.22)";
			ctx.beginPath(); ctx.arc(dh[0], dh[1], 9, 0, Math.PI * 2); ctx.fill();
			ctx.fillStyle = "#FFB800"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4;
			ctx.beginPath(); ctx.arc(dh[0], dh[1], 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
			ctx.fillStyle = "rgba(255,255,255,0.65)";
			ctx.beginPath(); ctx.arc(dh[0] - 1.6, dh[1] - 1.6, 1.6, 0, Math.PI * 2); ctx.fill();
			// 粉光球（脉冲动画）
			const pulse = 1 + Math.sin(this._time * 2) * 0.15;
			ctx.fillStyle = "rgba(233,61,130,0.5)";
			ctx.beginPath(); ctx.arc(cp[0], cp[1], 10 * pulse, 0, Math.PI * 2); ctx.fill();
			// 粉四棱锥（锥尖指向中心）
			const dx = cc[0] - cp[0], dy = cc[1] - cp[1];
			const L = Math.hypot(dx, dy) || 1;
			const nx = -dy / L, ny = dx / L;
			const tip = [cp[0] + dx / L * 11, cp[1] + dy / L * 11];
			ctx.fillStyle = "#E93D82"; ctx.strokeStyle = "#ff9ec6"; ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.moveTo(cp[0] + nx * 6, cp[1] + ny * 6);
			ctx.lineTo(tip[0], tip[1]);
			ctx.lineTo(cp[0] - nx * 6, cp[1] - ny * 6);
			ctx.closePath(); ctx.fill(); ctx.stroke();

			// ---- 方位手柄（粉色 MeshStandard 0xE93D82 + 光晕，绕环）----
			const azPt = P(AZ_RING_R * Math.sin(_d2r(h)), AZ_RING_Y, AZ_RING_R * Math.cos(_d2r(h)));
			const azR = 6 * ((this._hover === "azimuth" ? 1.15 : 1) * (this.drag === "azimuth" ? 1.3 : 1));
			ctx.fillStyle = "rgba(233,61,130,0.2)";
			ctx.beginPath(); ctx.arc(azPt[0], azPt[1], 9, 0, Math.PI * 2); ctx.fill();
			ctx.fillStyle = "#E93D82"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
			ctx.beginPath(); ctx.arc(azPt[0], azPt[1], azR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
			ctx.fillStyle = "rgba(255,255,255,0.65)";
			ctx.beginPath(); ctx.arc(azPt[0] - azR * 0.3, azPt[1] - azR * 0.3, azR * 0.28, 0, Math.PI * 2); ctx.fill();

			// ---- 俯仰手柄（青色 MeshStandard 0x00FFD0 + 光晕，沿弧）----
			const elPt = P(EL_ARC_X, W_CENTER_Y + EL_ARC_R * Math.sin(_d2r(v)), EL_ARC_R * Math.cos(_d2r(v)));
			const elR = 6 * ((this._hover === "elevation" ? 1.15 : 1) * (this.drag === "elevation" ? 1.3 : 1));
			ctx.fillStyle = "rgba(0,255,208,0.2)";
			ctx.beginPath(); ctx.arc(elPt[0], elPt[1], 9, 0, Math.PI * 2); ctx.fill();
			ctx.fillStyle = "#00FFD0"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
			ctx.beginPath(); ctx.arc(elPt[0], elPt[1], elR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
			ctx.fillStyle = "rgba(255,255,255,0.65)";
			ctx.beginPath(); ctx.arc(elPt[0] - elR * 0.3, elPt[1] - elR * 0.3, elR * 0.28, 0, Math.PI * 2); ctx.fill();

			this.handles = { azimuth: [azPt[0], azPt[1]], elevation: [elPt[0], elPt[1]], distance: dh, camera: [cp[0], cp[1]] };

			// CameraAngle 同款面板同步（下拉最近档位 + 实时数值回显）
			if (this.panel) {
				this.panel.az.value = String(_closestAz(h));
				this.panel.el.value = String(_closestEl(v));
				this.panel.dz.value = String(_closestDz(z));
				if (this.panel.azV) this.panel.azV.textContent = `${Math.round(h)}°`;
				if (this.panel.elV) this.panel.elV.textContent = `${Math.round(v)}°`;
				if (this.panel.dzV) this.panel.dzV.textContent = `${Number(z).toFixed(1)}`;
			}

			// 右上角"📂 上传参考图"（CameraAngle 无此按钮，但保留本地上传入口：
			// 未连 IMAGE 时点击即可选择本地图 → reference_info → 视球卡片实时贴图）
			const ub = { x: W - 84, y: 4, w: 80, h: 21 };
			this._uploadBtn = ub;
			ctx.fillStyle = "rgba(20,26,32,0.92)";
			ctx.fillRect(ub.x, ub.y, ub.w, ub.h);
			ctx.strokeStyle = "rgba(233,61,130,0.5)"; ctx.lineWidth = 1;
			ctx.strokeRect(ub.x, ub.y, ub.w, ub.h);
			ctx.fillStyle = "#E93D82"; ctx.font = "11px monospace";
			ctx.textAlign = "center"; ctx.textBaseline = "middle";
			ctx.fillText("📂 上传图", ub.x + ub.w / 2, ub.y + ub.h / 2 + 1);
			ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
		}
	}

	function ensureOrbitWidget(node) {
		if (node.__gjjQMAOrbitWidget) return node.__gjjQMAOrbitWidget;
		const container = document.createElement("div");
		const orbitH = () => Math.round(
			Math.max(ORBIT_H, Math.min(ORBIT_H_MAX, (node.size?.[0] ?? 320) * 0.72)));
		container.style.cssText = "width:100%;box-sizing:border-box;pointer-events:auto;border:1px solid #31434d;border-radius:8px;overflow:hidden;position:relative;display:flex;flex-direction:column;background:#0a0a0f;";
		container.style.height = orbitH() + "px";
		for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "change"]) {
			container.addEventListener(ev, (e) => e.stopPropagation());
		}
		const canvas = document.createElement("canvas");
		canvas.width = 320;
		canvas.height = orbitH();
		canvas.style.cssText = "width:100%;display:block;cursor:default;background:#0a0a0f;position:relative;flex:1;";
		canvas.style.height = "100%";
		container.appendChild(canvas);

		// CameraAngle 同款浮层面板（ControlPanel.vue）：第一行三下拉（粉方位/青俯仰/黄距离 + 小标签），
		// 第二行实时数值 + 重置 ↻；面板覆盖在视球底部
		const panel = document.createElement("div");
		panel.style.cssText = "position:absolute;bottom:8px;left:8px;right:8px;background:rgba(10,10,15,0.9);border:1px solid rgba(233,61,130,0.3);border-radius:6px;padding:6px 10px;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;z-index:2;";
		const row1 = document.createElement("div");
		row1.style.cssText = "display:flex;justify-content:space-around;align-items:center;gap:4px;";
		const row2 = document.createElement("div");
		row2.style.cssText = "display:flex;justify-content:space-around;align-items:center;gap:4px;";
		const mkControl = (label, color, opts) => {
			const c = document.createElement("div");
			c.style.cssText = "display:flex;align-items:center;gap:4px;";
			const lab = document.createElement("span");
			lab.textContent = label;
			lab.style.cssText = `font-size:9px;color:${color};text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;`;
			const sel = document.createElement("select");
			sel.style.cssText = "background:rgba(10,10,15,0.9);border:1px solid rgba(100,100,120,0.4);border-radius:4px;padding:2px 4px;font-size:9px;color:#e0e0e0;cursor:pointer;outline:none;max-width:90px;min-width:0;";
			for (const [val, optLab] of opts) {
				const o = document.createElement("option");
				o.value = String(val);
				o.textContent = optLab;
				sel.appendChild(o);
			}
			c.append(lab, sel);
			return { wrap: c, sel, lab };
		};
		const azCtl = mkControl("方位", "#E93D82", AZ_OPTS);
		const elCtl = mkControl("俯仰", "#00FFD0", EL_OPTS);
		const dzCtl = mkControl("距离", "#FFB800", DZ_OPTS);
		const mkParam = (color) => {
			const d = document.createElement("div");
			d.style.cssText = `text-align:center;font-weight:600;font-size:13px;color:${color};font-family:Consolas,monospace;min-width:44px;`;
			return d;
		};
		const azV = mkParam("#E93D82");
		const elV = mkParam("#00FFD0");
		const dzV = mkParam("#FFB800");
		const resetBtn = document.createElement("button");
		resetBtn.type = "button";
		resetBtn.textContent = "↻";
		resetBtn.title = "重置为默认（正面 / 平视 / 中景）";
		resetBtn.style.cssText = "width:24px;height:24px;border-radius:4px;border:1px solid rgba(233,61,130,0.4);background:rgba(10,10,15,0.8);color:#E93D82;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;";
		row1.append(azCtl.wrap, elCtl.wrap, dzCtl.wrap);
		row2.append(azV, elV, dzV, resetBtn);
		panel.append(row1, row2);
		container.appendChild(panel);

		const editor = new OrbitEditor(node, canvas, { az: azCtl.sel, el: elCtl.sel, dz: dzCtl.sel, azV, elV, dzV });
		azCtl.sel.addEventListener("change", () => {
			editor.write(_normH(Number(azCtl.sel.value)), null, null);
			editor.render(true);
		});
		elCtl.sel.addEventListener("change", () => {
			editor.write(null, _clampV(Number(elCtl.sel.value)), null);
			editor.render(true);
		});
		dzCtl.sel.addEventListener("change", () => {
			editor.write(null, null, Number(dzCtl.sel.value));
			editor.render(true);
		});
		resetBtn.addEventListener("click", () => {
			editor.write(0, 0, 5);
			editor.render(true);
		});

		let widget = null;
		if (typeof node.addDOMWidget === "function") {
			widget = node.addDOMWidget(ORBIT_WIDGET, "HTML", container, {
				getValue: () => "1",
				setValue: () => {},
				serialize: false,
				hideOnZoom: false,
				getHeight: orbitH,
			});
			if (widget) widget.computeSize = (width) => [Math.max(300, width || 300), orbitH()];
		}
		if (widget) {
			widget.serialize = false;
			widget.options ||= {};
			widget.options.serialize = false;
			widget.name = ORBIT_WIDGET;
			widget.label = "";
			node.__gjjQMAOrbitWidget = widget;
			node.__gjjQMAOrbitEditor = editor;
		}
		return widget;
	}

	// ------------------------------------------------------------------ DOM 装配
	const TOOLBAR_HEIGHT = 40;

	function ensureToolbarWidget(node) {
		if (node.__gjjQMAToolbarWidget) {
			refreshToolbarState(node);
			return node.__gjjQMAToolbarWidget;
		}
		const tools = document.createElement("div");
		tools.style.cssText = "display:flex;gap:4px;align-items:center;flex-wrap:wrap;width:100%;padding:2px 0;box-sizing:border-box;pointer-events:auto;";
		for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
			tools.addEventListener(ev, (e) => e.stopPropagation());
		}

		const fileBtn = makeToolButton("📂", "打开本地参考图片", () => chooseReferenceImage(node));
		const modelBtn = makeToolButton("🧠", "模型树：选择全部模型（顶部过滤框自动按组名过滤）", (btn) => showModelPanel(node, btn));
		const paramBtn = makeToolButton("📷", "采样 / 修补 / 提示词参数（方向在节点内视球上交互调整）", (btn) => showParamPanel(node, btn));
		const seedBtn = makeToolButton("🎲", "随机采样种子", () => {
			const widget = getWidget(node, "seed");
			if (widget) setWidgetValue(widget, Math.floor(Math.random() * 2 ** 31));
			setStatus(node, { text: "🎲 已随机采样种子", progress: 0 });
		});
		const camBtn = makeToolButton("≣", "显示顶部角度参数栏（水平/垂直/距离）", () => {
			node.properties ||= {};
			const show = node.properties.gjj_qma_show_camera === true;
			node.properties.gjj_qma_show_camera = !show;
			for (const name of PARAM_GROUPS.camera) setWidgetHidden(getWidget(node, name), show);
			nodeDirty();
			refreshToolbarState(node);
			setTimeout(() => refreshNode(node), 0);
		});
		const runBtn = makeToolButton("▶️", "只执行当前节点（不跑其它输出节点）", () => runCurrentNode(node, runBtn));

		tools.append(fileBtn, modelBtn, paramBtn, seedBtn, camBtn, runBtn);
		node.__gjjQMAFileButton = fileBtn;
		node.__gjjQMAModelButton = modelBtn;
		node.__gjjQMARunButton = runBtn;
		node.__gjjQMACamButton = camBtn;

		let widget = null;
		if (typeof node.addDOMWidget === "function") {
			widget = node.addDOMWidget(TOOLBAR_WIDGET, "HTML", tools, {
				getValue: () => "1",
				setValue: () => {},
				serialize: false,
				hideOnZoom: false,
				getHeight: () => TOOLBAR_HEIGHT,
			});
			if (widget) widget.computeSize = (width) => [Math.max(300, width || 300), TOOLBAR_HEIGHT];
		}
		if (widget) {
			widget.serialize = false;
			widget.options ||= {};
			widget.options.serialize = false;
			widget.name = TOOLBAR_WIDGET;
			widget.label = "";
			node.__gjjQMAToolbarWidget = widget;
		}
		refreshToolbarState(node);
		return widget;
	}

	function ensureStatusWidget(node) {
		if (node.__gjjQMAStatusWidget) return node.__gjjQMAStatusWidget;

		const wrap = document.createElement("div");
		wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #41535b;border-radius:8px;background:#121a1f;width:100%;box-sizing:border-box;pointer-events:auto;";
		for (const ev of ["pointerdown", "mousedown", "mouseup", "click"]) {
			wrap.addEventListener(ev, (e) => e.stopPropagation());
		}

		const text = document.createElement("div");
		text.textContent = "等待执行：📂 选择参考图或连接 IMAGE，然后 ▶️ 执行。";
		text.style.cssText = "color:#dce7e2;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word;min-height:18px;";

		const barOuter = document.createElement("div");
		barOuter.style.cssText = "height:6px;border-radius:999px;overflow:hidden;background:#223038;";
		const barInner = document.createElement("div");
		barInner.style.cssText = "height:100%;width:0%;background:linear-gradient(90deg,#72c1ff,#7ed6a7);transition:width 120ms ease;";
		barOuter.appendChild(barInner);

		const thumbWrap = document.createElement("div");
		thumbWrap.style.cssText = "display:none;gap:8px;align-items:center;";
		const thumb = document.createElement("img");
		thumb.draggable = true;
		thumb.style.cssText = "max-height:96px;max-width:100%;border:1px solid #31434d;border-radius:6px;background:#05090c;object-fit:contain;cursor:grab;";
		thumb.title = "点击放大 · 滚轮缩放 · 再点关闭；可拖拽到空白画布或 GJJ_AnyPreview";
		// 🖼️ 点击放大（Lightbox）
		thumb.addEventListener("click", (e) => {
			e.stopPropagation();
			const info = currentThumbInfo(node);
			if (!info?.filename) return;
			gjjOpenImageLightbox(
				referenceViewUrl(info),
				node.__gjjQMAThumbName?.textContent?.replace(/^🖼️ /, "") || info.filename,
			);
		});
		const thumbName = document.createElement("div");
		thumbName.style.cssText = "color:#91a8ae;font-size:11px;word-break:break-all;flex:1;min-width:0;";
		thumbWrap.append(thumb, thumbName);

		wrap.append(text, barOuter, thumbWrap);
		node.__gjjQMAStatusText = text;
		node.__gjjQMAStatusBar = barInner;
		node.__gjjQMAThumbWrap = thumbWrap;
		node.__gjjQMAThumb = thumb;
		node.__gjjQMAThumbName = thumbName;

		// 🖼️ 预览图可拖拽到空白画布或 GJJ_AnyPreview（空白画布由 GJJ_AnyPreview 承载）
		bindGjjMediaDrag(thumb, () => {
			const info = currentThumbInfo(node);
			if (!info?.filename) return null;
			return {
				filename: info.filename,
				subfolder: info.subfolder || "",
				type: info.type || "temp",
				media_type: "image",
			};
		});

		let widget = null;
		if (typeof node.addDOMWidget === "function") {
			widget = node.addDOMWidget(STATUS_WIDGET, "HTML", wrap, {
				getValue: () => "1",
				setValue: () => {},
				serialize: false,
				hideOnZoom: false,
				getHeight: () => (node.__gjjQMAThumbWrap?.style.display === "flex"
					? STATUS_HEIGHT_THUMB : STATUS_HEIGHT_PLAIN),
			});
			if (widget) widget.computeSize = (width) => [Math.max(300, width || 300), STATUS_HEIGHT_PLAIN];
		}
		if (widget) {
			widget.serialize = false;
			widget.options ||= {};
			widget.options.serialize = false;
			widget.name = STATUS_WIDGET;
			widget.label = "";
			node.__gjjQMAStatusWidget = widget;
		}
		return widget;
	}

	// ------------------------------------------------------------------ 节点补丁
	function ensureReferenceWidget(node) {
		// 兜底：个别前端版本可能不为 options.hidden 的 required 输入创建 widget。
		// 若缺失则用原生 addWidget 补建（真实 widget，非 DOM 假控件），确保值可随 prompt 序列化。
		if (getWidget(node, REFERENCE_WIDGET)) return;
		try {
			const widget = node.addWidget("string", REFERENCE_WIDGET, "", () => {}, {});
			widget.serialize = true;
			widget.options.serialize = true;
			setWidgetHidden(widget, true);
			node.setDirtyCanvas?.(true, true);
		} catch (_) {}
	}

	function stripLegacyOverrideInputs(node) {
		// 输入仅 image：结构性移除旧版本序列化残留的 model/clip/vae override 槽位
		// （disconnectInput + removeInput，与后端 INPUT_TYPES 对齐，幂等）
		for (const name of ["model_override", "clip_override", "vae_override"]) {
			const index = (node.inputs || []).findIndex((input) => input?.name === name);
			if (index < 0) continue;
			try { node.disconnectInput?.(index); } catch (_) {}
			try { node.removeInput?.(index); } catch (_) {
				try { node.inputs?.splice(index, 1); } catch (_) {}
			}
		}
	}

	function patchNode(node) {
		if (!node) return;
		stripLegacyOverrideInputs(node);
		if (node.__gjjQMAPatched) {
			ensureToolbarWidget(node);
			if (!window.__GJJQmaBundle) ensureOrbitWidget(node);
			ensureStatusWidget(node);
			// widget 重建后重新应用相机三参数可见性（≣ 隐藏状态持久化，默认隐藏）
			const camShow = node.properties?.gjj_qma_show_camera === true;
			for (const name of PARAM_GROUPS.camera) setWidgetHidden(getWidget(node, name), !camShow);
			refreshToolbarState(node);
			GJJ_Utils?.scheduleRefreshNode?.(node);
			return;
		}
		node.__gjjQMAPatched = true;

		node.properties ||= {};

		// 隐藏 Python 参数 widget（相机三参数保持可见，CameraAngle 同款数值输入框）
		const hiddenNames = [
			...MODEL_DEFS.map((item) => item.widget),
			...PARAM_GROUPS.sampling, ...PARAM_GROUPS.patch, ...PARAM_GROUPS.prompt,
			REFERENCE_WIDGET,
		];
		ensureReferenceWidget(node);
		for (const name of hiddenNames) setWidgetHidden(getWidget(node, name), true);
		// 相机角度：默认隐藏（≣ 按钮可切换显示；隐藏时视球/下拉仍可调角度）
		const camShow = node.properties?.gjj_qma_show_camera === true;
		for (const name of PARAM_GROUPS.camera) setWidgetHidden(getWidget(node, name), !camShow);

		// 节点面板：工具栏 → 3D 方向视球 → 状态栏
		// CameraAngle bundle 已接管视球（window.__GJJQmaBundle）：创建顺序 toolbar → camera_preview → status
		ensureToolbarWidget(node);
		if (window.__GJJQmaBundle) {
			setTimeout(() => window.__GJJQmaEnsure?.(node), 0);
			setTimeout(() => ensureStatusWidget(node), 10);
		} else {
			ensureOrbitWidget(node);
			ensureStatusWidget(node);
		}

		// 恢复参考图 / 输出预览缩略图
		const refInfo = parseReferenceInfo(node);
		if (refInfo?.filename) setInputThumb(node, refInfo);
		else {
			const saved = node.properties?.[PREVIEW_PROP] || null;
			if (saved?.filename) setPreviewThumb(node, saved);
		}
		refreshToolbarState(node);

		const originalOnConnectionsChange = node.onConnectionsChange;
		node.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => {
				refreshToolbarState(this);
				if (!window.__GJJQmaBundle) {
					ensureOrbitWidget(this);
					this.__gjjQMAOrbitEditor?.render(true);
				}
			}, 0);
			return result;
		};

		// 相机三参数（可见数值输入框）变化 → 视球手柄/下拉/顶部提示词联动
		const camNames = new Set(PARAM_GROUPS.camera);
		const originalOnWidgetChanged = node.onWidgetChanged;
		node.onWidgetChanged = function (name, value, oldValue) {
			const result = originalOnWidgetChanged?.apply(this, arguments);
			if (camNames.has(String(name))) {
				if (!window.__GJJQmaBundle) {
					ensureOrbitWidget(this);
					this.__gjjQMAOrbitEditor?.render(true);
				}
				refreshToolbarState(this);
			}
			return result;
		};

		const originalOnExecuted = node.onExecuted;
		node.onExecuted = function (message) {
			originalOnExecuted?.call(this, message);
			this.__gjjQMARunInFlight = false;
			refreshToolbarState(this);
			if (message?.error) return;
			try {
				const images = message?.preview_images;
				if (Array.isArray(images) && images.length) {
					setPreviewThumb(this, {
						filename: images[0].filename,
						subfolder: images[0].subfolder || "",
						type: images[0].type || "temp",
					});
				}
			} catch (_) {}
			setStatus(this, { text: "✅ 多角度图像生成完成（可拖拽预览图到画布或 GJJ_AnyPreview）", progress: 1 });
		};

		const originalOnRemoved = node.onRemoved;
		node.onRemoved = function (...args) {
			closeFloatingPanel(this);
			return originalOnRemoved?.apply(this, args);
		};

		refreshNode(node);
		GJJ_Utils?.scheduleRefreshNode?.(node, { delay: 60 });
		setTimeout(() => { refreshToolbarState(node); refreshNode(node); }, 0);
	}

	// ------------------------------------------------------------------ 全局事件
	api.addEventListener("gjj_node_progress", (event) => {
		const detail = event?.detail || {};
		const target = app.graph?._nodes?.find((n) => String(n?.id) === String(detail.node));
		if (!target || String(target.comfyClass || target.type || "") !== NODE_CLASS) return;
		ensureStatusWidget(target);
		setStatus(target, detail);
	});

	function resetRunState() {
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass || node?.type || "") !== NODE_CLASS) continue;
			if (node.__gjjQMARunInFlight) {
				node.__gjjQMARunInFlight = false;
				setStatus(node, { text: "⚠️ 执行被中断或出错，请查看控制台。", progress: 0 });
			}
			refreshToolbarState(node);
		}
	}
	api.addEventListener("execution_error", resetRunState);
	api.addEventListener("execution_interrupted", resetRunState);
	api.addEventListener("executing", (event) => {
		if (event?.detail != null) return;
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass || node?.type || "") === NODE_CLASS && node.__gjjQMARunInFlight) {
				node.__gjjQMARunInFlight = false;
				refreshToolbarState(node);
			}
		}
	});

	// ------------------------------------------------------------------ 注册扩展
	app.registerExtension({
		name: "Comfy.GJJ.QwenMultiangleStudio",

		async beforeRegisterNodeDef(nodeType, nodeData) {
			if (nodeData?.name !== NODE_CLASS) return;
			const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) {
				const result = originalOnNodeCreated?.apply(this, args);
				setTimeout(() => { patchNode(this); }, 0);
				return result;
			};
			const originalOnConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (...args) {
				const result = originalOnConfigure?.apply(this, args);
				patchNode(this);
				return result;
			};
		},

		setup() {
			for (const node of app.graph?._nodes || []) {
				if (String(node?.comfyClass || node?.type || "") === NODE_CLASS) patchNode(node);
			}
		},
	});
})();

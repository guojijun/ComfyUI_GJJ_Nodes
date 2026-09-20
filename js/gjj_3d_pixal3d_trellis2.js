import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/*
 * GJJ 🧊 Pixal3D / Trellis.2 图生3D 单节点前端
 * - 所有参数 widget 隐藏，仅保留 emoji 按钮排 + 状态栏
 * - 点击 emoji 按钮弹出浮动窗口按需编辑参数
 * - 📂 选择本地参考图；图片接口有外链时自动灰显禁用
 * - 🧠 模型树使用 GJJ_Utils.createModelTreeView
 *   过滤框自动填入“去路径/扩展名/版本号/量化标记”的组名；
 *   源模型缺失时自动取过滤列表首项；过滤为 0 时红显默认模型；
 *   选中模型后模型树替换为已选模型列表，列表框隐藏。
 */
(function () {
	const NODE_CLASS = "GJJ_Pixal3DTrellis2ImageToModel";
	const IMAGE_INPUT = "image";
	const REFERENCE_WIDGET = "reference_info";
	const UPLOAD_SUBFOLDER = "GJJ_Pixal3DTrellis2";

	const TOOLBAR_WIDGET = "__gjj_p3d_toolbar";
	const STATUS_WIDGET = "__gjj_p3d_status";
	const FLOATING_KEY = "__gjjP3DFloatingPanel";

	const MISSING = "[未找到模型]";

	// 模型定义（与 Python MODEL_SPECS 对应，通用，不硬编码绝对路径）
	const MODEL_DEFS = [
		{ widget: "diffusion_model", label: "3D 扩散模型（Pixal3D / Trellis.2）", folder: "models/diffusion_models", icon: "🟣", fallback: "pixal3d_int8_convrot.safetensors" },
		{ widget: "clip_vision_model", label: "DINOv3 视觉模型", folder: "models/clip_vision", icon: "🔵", fallback: "dino_v3_L_naf_fp32.safetensors" },
		{ widget: "shape_vae_model", label: "结构 VAE（Shape VAE）", folder: "models/vae", icon: "🔴", fallback: "trellis_2_shape_vae_bf16.safetensors" },
		{ widget: "texture_vae_model", label: "纹理 VAE（Texture VAE）", folder: "models/vae", icon: "🔴", fallback: "trellis_2_texture_vae_bf16.safetensors" },
		{ widget: "geometry_model", label: "MoGe 相机几何模型", folder: "models/geometry_estimation", icon: "🟤", fallback: "moge_2_vitl_normal_fp16.safetensors" },
		{ widget: "matting_model", label: "背景移除模型（抠图）", folder: "models/background_removal", icon: "🟣", fallback: "birefnet.safetensors" },
	];

	// 布尔开关全部存 node.properties（禁止使用隐藏 Boolean widget）
	const BOOL_DEFS = [
		{ key: "enable_matting", label: "官方背景移除抠图", default: true },
		{ key: "enable_geometry", label: "MoGe 相机 FOV 估计（仅 Pixal3D）", default: true },
		{ key: "geometry_force_projection", label: "强制透视投影", default: true },
		{ key: "geometry_apply_mask", label: "仅对遮罩主体估计", default: true },
		{ key: "remesh_fix_poles", label: "重网格修复极点", default: false },
		{ key: "normal_ignore_backfaces", label: "法线烘焙忽略背面", default: true },
		{ key: "save_to_output", label: "保存 GLB 到 output 目录", default: true },
	];

	// 可选输出接口（索引必须与 Python RETURN_TYPES 严格对应，禁止调整顺序）。
	// 索引 0「🧊 最终网格」始终显示；其余默认隐藏，由 🔌 面板按需启用。
	// 实现方式：不删槽（删槽会使链接 origin_slot 与后端静态 RETURN_TYPES 错位），
	// 而是给隐藏槽设置离屏 pos——前端布局会自动过滤带 pos 的槽并让可见槽紧凑重排。
	const OUTPUT_DEFS = [
		{ key: "out_glb", index: 1, name: "📦 GLB模型文件", type: "FILE_3D_GLB",
			tooltip: "可直接保存或预览的 GLB 二进制 3D 文件。" },
		{ key: "out_base_color", index: 2, name: "🎨 基础颜色贴图", type: "IMAGE",
			tooltip: "从体素颜色烘焙出的基础颜色（Base Color）贴图。" },
		{ key: "out_metallic", index: 3, name: "⚙️ 金属度贴图", type: "IMAGE",
			tooltip: "金属度（Metallic）贴图。" },
		{ key: "out_roughness", index: 4, name: "🧫 粗糙度贴图", type: "IMAGE",
			tooltip: "粗糙度（Roughness）贴图。" },
		{ key: "out_normal", index: 5, name: "🧭 法线贴图", type: "IMAGE",
			tooltip: "从高模烘焙到低模的切线空间法线贴图。" },
		{ key: "out_ao", index: 6, name: "🌑 环境光遮蔽贴图", type: "IMAGE",
			tooltip: "环境光遮蔽（Ambient Occlusion）贴图。" },
	];
	const HIDDEN_OUTPUT_POS = [10000, 10000];
	const HIDDEN_ATTR = "data-gjj-p3d-h";
	let __outputCssInjected = false;

	// Vue 节点模式下槽位是真实 DOM（.lg-slot--output 按输出顺序排列），
	// 在节点根上打 data 属性，用 nth-child 精确隐藏；Vue 重建内部 DOM 后规则仍命中。
	function injectOutputCss() {
		if (__outputCssInjected) return;
		__outputCssInjected = true;
		try {
			const style = document.createElement("style");
			style.setAttribute("data-gjj", "p3d-hidden-outputs");
			style.textContent = [2, 3, 4, 5, 6, 7]
				.map((nth) => `[${HIDDEN_ATTR}~="${nth}"] .lg-slot--output:nth-child(${nth}){display:none!important;}`)
				.join("\n");
			document.head.appendChild(style);
		} catch (_) {}
	}

	const GROUPS = {
		preprocess: [
			"pipeline_mode", "crop_size", "pad_factor", "grow_mask", "background", "fallback_fov",
			"geometry_level", "geometry_batch", "geometry_refine_steps",
		],
		structure: [
			"structure_seed", "structure_steps", "structure_cfg", "structure_sampler", "structure_scheduler",
			"sd3_shift", "structure_cfg_start", "structure_rescale", "structure_resolution",
			"refine_seed", "refine_steps", "refine_cfg", "refine_sampler", "refine_scheduler",
			"refine_cfg_start", "refine_rescale",
			"upsample_resolution", "hr_seed", "hr_steps", "hr_cfg", "hr_sampler", "hr_scheduler",
		],
		mesh: [
			"remesh_resolution", "sign_mode", "remesh_band", "project_back", "smooth_iters",
			"drop_small_components", "precluster_max_verts", "decimate_faces", "placement_mode", "mesh_crease",
		],
		texture: [
			"texture_seed", "texture_steps", "texture_cfg", "texture_sampler", "texture_scheduler",
			"unwrap_segmenter", "unwrap_resolution", "unwrap_padding", "weld_distance",
			"texture_size", "normal_resolution", "cage_distance",
			"ao_resolution", "ao_samples", "ao_max_distance", "ao_strength", "ao_bias", "final_crease",
			"filename_prefix",
		],
	};

	const ALL_WIDGETS = [
		...MODEL_DEFS.map((item) => item.widget),
		...GROUPS.preprocess, ...GROUPS.structure, ...GROUPS.mesh, ...GROUPS.texture,
		REFERENCE_WIDGET,
	];

	const SEED_WIDGETS = ["structure_seed", "refine_seed", "hr_seed", "texture_seed"];

	// 浮动窗内各参数的中文显示名（保证全中文 UI，不依赖后端 option 回传）
	const WIDGET_LABELS = {
		pipeline_mode: "3D 管线分支",
		crop_size: "裁剪输出尺寸",
		pad_factor: "主体留白倍数",
		grow_mask: "遮罩扩张像素",
		background: "裁剪背景色",
		fallback_fov: "备用水平FOV（度）",
		geometry_level: "MoGe 分辨率等级",
		geometry_batch: "MoGe 批大小",
		geometry_refine_steps: "MoGe 几何精修步数",
		structure_seed: "结构种子",
		structure_steps: "结构步数",
		structure_cfg: "结构 CFG",
		structure_sampler: "结构采样器",
		structure_scheduler: "结构调度器",
		sd3_shift: "SD3 位移 shift",
		structure_cfg_start: "CFG覆盖起点",
		structure_rescale: "RescaleCFG 系数",
		structure_resolution: "结构体素分辨率",
		refine_seed: "形状精修种子",
		refine_steps: "形状精修步数",
		refine_cfg: "形状精修 CFG",
		refine_sampler: "精修采样器",
		refine_scheduler: "精修调度器",
		refine_cfg_start: "精修CFG覆盖起点",
		refine_rescale: "精修 RescaleCFG",
		upsample_resolution: "升采样目标分辨率",
		hr_seed: "高模形状种子",
		hr_steps: "高模形状步数",
		hr_cfg: "高模形状 CFG",
		hr_sampler: "高模采样器",
		hr_scheduler: "高模调度器",
		remesh_resolution: "重网格密度",
		sign_mode: "符号场模式",
		remesh_band: "重网格带宽",
		project_back: "投影回表面距离",
		smooth_iters: "平滑迭代次数",
		drop_small_components: "丢弃小部件比例",
		precluster_max_verts: "预聚类顶点上限",
		decimate_faces: "抽稀目标面数",
		placement_mode: "抽稀折叠策略",
		mesh_crease: "平滑法线折角",
		texture_seed: "纹理种子",
		texture_steps: "纹理步数",
		texture_cfg: "纹理 CFG",
		texture_sampler: "纹理采样器",
		texture_scheduler: "纹理调度器",
		unwrap_segmenter: "UV 分割算法",
		unwrap_resolution: "UV 展开分辨率",
		unwrap_padding: "UV 岛间距",
		weld_distance: "焊接距离",
		texture_size: "颜色贴图尺寸",
		normal_resolution: "法线贴图尺寸",
		cage_distance: "法线烘焙笼距离",
		ao_resolution: "AO 贴图尺寸",
		ao_samples: "AO 采样数",
		ao_max_distance: "AO 最大距离",
		ao_strength: "AO 强度",
		ao_bias: "AO 偏移",
		final_crease: "最终平滑折角",
		filename_prefix: "保存文件名前缀",
	};

	// 分段选择型 widget（用按钮组而不是下拉框）
	const SEGMENTED = {
		pipeline_mode: ["自动", "Pixal3D", "Trellis.2"],
		structure_resolution: ["32", "64"],
		sign_mode: ["udf", "sdf"],
		placement_mode: ["midpoint", "qem"],
		unwrap_segmenter: ["pec", "adaptive"],
	};

	// ------------------------------------------------------------------ 工具
	function getWidget(node, name) {
		return node?.widgets?.find((widget) => widget.name === name) || null;
	}

	function setWidgetValue(widget, value) {
		if (!widget) return;
		widget.value = value;
		try { widget.callback?.(value); } catch (_) {}
		// 同步已经打开的浮动窗控件（如切换管线分支时自动更新留白倍数）
		try { widget.__gjjSyncInput?.(value); } catch (_) {}
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
		}
		if (widget.element) widget.element.style.display = hidden ? "none" : "";
		if (widget.inputEl) widget.inputEl.style.display = hidden ? "none" : "";
	}

	function propGet(node, key) {
		node.properties ||= {};
		const def = BOOL_DEFS.find((item) => item.key === key);
		if (node.properties[key] === undefined) node.properties[key] = def?.default ?? false;
		return Boolean(node.properties[key]);
	}

	function propSet(node, key, value) {
		node.properties ||= {};
		node.properties[key] = Boolean(value);
		nodeDirty();
	}

	// ------------------------------------------------------------------ 🔌 可选输出口
	function outputPropGet(node, key) {
		node.properties ||= {};
		return Boolean(node.properties[key] ?? false);
	}

	function nodeRootElement(node) {
		try {
			return document.querySelector(`[data-node-id="${node.id}"]`);
		} catch (_) {
			return null;
		}
	}

	function applyHiddenOutputsCss(node) {
		const root = nodeRootElement(node);
		if (!root) return false;
		// nth-child 从 1 开始：输出索引 0（最终网格）始终是第 1 个子元素
		const tokens = OUTPUT_DEFS
			.filter((def) => !outputPropGet(node, def.key))
			.map((def) => String(def.index + 1))
			.join(" ");
		if (tokens) root.setAttribute(HIDDEN_ATTR, tokens);
		else root.removeAttribute(HIDDEN_ATTR);
		return true;
	}

	function syncOutputSlots(node) {
		if (!Array.isArray(node?.outputs)) return;
		for (const def of OUTPUT_DEFS) {
			const slot = node.outputs[def.index];
			if (!slot || slot.name !== def.name) continue; // 索引/名称不匹配时绝不动它
			slot.tooltip = def.tooltip;
		}
		injectOutputCss();
		// Vue 节点模式：CSS 隐藏（首选）。旧版画布（无 Vue 节点 DOM）：离屏 pos 回退。
		if (!applyHiddenOutputsCss(node)) {
			if (LiteGraph?.vueNodesMode) {
				// Vue 模式下节点 DOM 可能尚未挂载，阶梯重试直到命中
				node.__gjjP3DOutputRetries = (node.__gjjP3DOutputRetries || 0);
				if (node.__gjjP3DOutputRetries < 5) {
					node.__gjjP3DOutputRetries += 1;
					clearTimeout(node.__gjjP3DOutputSyncTimer);
					node.__gjjP3DOutputSyncTimer = setTimeout(() => {
						node.__gjjP3DOutputSyncTimer = null;
						if (applyHiddenOutputsCss(node)) node.__gjjP3DOutputRetries = 5;
						else syncOutputSlots(node);
					}, 80 * node.__gjjP3DOutputRetries);
				}
			} else {
				for (const def of OUTPUT_DEFS) {
					const slot = node.outputs[def.index];
					if (!slot || slot.name !== def.name) continue;
					if (outputPropGet(node, def.key)) {
						if (slot.pos) delete slot.pos;
					} else {
						slot.pos = [...HIDDEN_OUTPUT_POS];
					}
				}
				try { node._setConcreteSlots?.(); } catch (_) {}
			}
		}
		try { node.setDirtyCanvas?.(true, true); } catch (_) {}
		try { node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	}

	function setOutputEnabled(node, def, enabled) {
		const slot = node.outputs?.[def.index];
		if (!slot) return;
		enabled = Boolean(enabled);
		if (!enabled && Array.isArray(slot.links) && slot.links.length) {
			// 隐藏带连线的输出口前必须先断开，避免出现不可见的悬空连线
			try { node.disconnectOutput?.(def.index); } catch (_) {}
			setStatus(node, { text: `🔌 已断开并隐藏输出口：${def.name}`, progress: 0 });
		}
		propSet(node, def.key, enabled);
		syncOutputSlots(node);
		refreshToolbarState(node);
		refreshNode(node);
		try { node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	}

	function showOutputPanel(node, anchor) {
		showFloatingPanel(node, anchor, "🔌 输出接口（默认仅最终网格）", 400, (body) => {
			body.appendChild(sectionTitle("🧊 始终输出"));
			const fixedRow = document.createElement("div");
			fixedRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;color:#c6d4d8;font-size:13px;";
			const fixedTag = document.createElement("span");
			fixedTag.textContent = "MESH";
			fixedTag.style.cssText = "font-size:10px;color:#9fd4c3;border:1px solid #3f6a5c;border-radius:4px;padding:1px 5px;background:#10201c;";
			const fixedName = document.createElement("span");
			fixedName.textContent = "🧊 最终网格";
			fixedRow.append(fixedTag, fixedName);
			body.appendChild(fixedRow);

			body.appendChild(sectionTitle("🔌 按需启用的输出口"));
			for (const def of OUTPUT_DEFS) {
				const row = document.createElement("div");
				row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 8px;";
				const tag = document.createElement("span");
				tag.textContent = def.type;
				tag.style.cssText = "font-size:10px;color:#8fb7d4;border:1px solid #3a5668;border-radius:4px;padding:1px 5px;background:#101a20;min-width:76px;text-align:center;";
				const name = document.createElement("span");
				name.textContent = def.name;
				name.title = def.tooltip;
				name.style.cssText = "flex:1;min-width:0;color:#c6d4d8;font-size:13px;";
				const btn = document.createElement("button");
				btn.type = "button";
				btn.style.cssText = "width:60px;height:24px;border-radius:12px;padding:0;font-weight:700;cursor:pointer;border:1px solid;font-size:12px;";
				const paint = () => {
					const on = outputPropGet(node, def.key);
					btn.textContent = on ? "已显示" : "已隐藏";
					btn.style.background = on ? "#124332" : "#121920";
					btn.style.borderColor = on ? "#55a986" : "#40535c";
					btn.style.color = on ? "#ecfff7" : "#91a3aa";
				};
				btn.onclick = (e) => {
					e.preventDefault(); e.stopPropagation();
					setOutputEnabled(node, def, !outputPropGet(node, def.key));
					paint();
				};
				paint();
				row.append(tag, name, btn);
				body.appendChild(row);
			}

			const hint = document.createElement("div");
			hint.textContent = "提示：隐藏带连线的输出口会自动断开其连线；设置随工作流保存。";
			hint.style.cssText = "margin-top:8px;padding:6px 8px;color:#8fa1a8;font-size:11px;line-height:1.5;border:1px dashed #354952;border-radius:6px;";
			body.appendChild(hint);
		});
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
	function fieldRow(labelText, control, hint = "") {
		const wrap = document.createElement("label");
		wrap.style.cssText = "display:grid;grid-template-columns:132px minmax(0,1fr);gap:8px;align-items:center;width:100%;box-sizing:border-box;";
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

	function sectionTitle(text) {
		const div = document.createElement("div");
		div.textContent = text;
		div.style.cssText = "margin:6px 0 2px;padding:3px 8px;border-radius:6px;background:#16232a;color:#9fd4c3;font-weight:800;";
		return div;
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

	function bindText(node, name) {
		const widget = getWidget(node, name);
		const input = document.createElement("input");
		input.type = "text";
		input.value = String(widget?.value ?? "");
		input.style.cssText = CONTROL_STYLE;
		const apply = () => setWidgetValue(widget, input.value);
		input.addEventListener("change", apply);
		input.addEventListener("blur", apply);
		if (widget) widget.__gjjSyncInput = (value) => { input.value = String(value); };
		return input;
	}

	function bindColor(node, name) {
		const widget = getWidget(node, name);
		const wrap = document.createElement("div");
		wrap.style.cssText = "display:flex;gap:6px;align-items:center;";
		const color = document.createElement("input");
		color.type = "color";
		color.value = String(widget?.value || "#000000");
		color.style.cssText = "width:42px;height:26px;padding:0;border:1px solid #354952;border-radius:5px;background:#0b1115;cursor:pointer;";
		const hex = document.createElement("input");
		hex.type = "text";
		hex.value = String(widget?.value || "#000000");
		hex.style.cssText = CONTROL_STYLE + "flex:1;min-width:0;";
		const sync = (value) => {
			const v = String(value || "#000000");
			color.value = v; hex.value = v;
			setWidgetValue(widget, v);
		};
		color.addEventListener("change", () => sync(color.value));
		hex.addEventListener("change", () => sync(hex.value));
		hex.addEventListener("blur", () => sync(hex.value));
		wrap.append(color, hex);
		if (widget) widget.__gjjSyncInput = (value) => {
			const v = String(value || "#000000");
			color.value = v; hex.value = v;
		};
		return wrap;
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

	function bindSegmented(node, name, values) {
		const widget = getWidget(node, name);
		const wrap = document.createElement("div");
		wrap.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
		const buttons = [];
		const refresh = () => {
			for (const btn of buttons) {
				const active = String(btn.dataset.value) === String(widget?.value);
				btn.style.background = active ? "#1668c7" : "#121920";
				btn.style.borderColor = active ? "#78c4ff" : "#40535c";
				btn.style.color = active ? "#ffffff" : "#91a3aa";
				btn.style.fontWeight = active ? "700" : "400";
			}
		};
		for (const value of values) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.textContent = value;
			btn.dataset.value = value;
			btn.style.cssText = "flex:1 1 auto;min-width:54px;height:26px;padding:0 10px;border-radius:13px;border:1px solid #40535c;cursor:pointer;font-size:12px;";
			btn.onclick = (e) => {
				e.preventDefault(); e.stopPropagation();
				setWidgetValue(widget, value);
				if (name === "pipeline_mode") onPipelineModeChange(node, value);
				refresh();
			};
			buttons.push(btn);
		}
		refresh();
		if (widget) widget.__gjjSyncInput = () => refresh();
		buttons.forEach((b) => wrap.appendChild(b));
		return wrap;
	}

	function bindPropToggle(node, key, labelText) {
		const wrap = document.createElement("div");
		wrap.style.cssText = "display:flex;align-items:center;gap:8px;grid-column:1 / -1;cursor:pointer;";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.style.cssText = "width:70px;height:24px;border-radius:12px;padding:0;font-weight:700;cursor:pointer;border:1px solid;";
		const name = document.createElement("span");
		name.textContent = labelText;
		name.style.cssText = "color:#c6d4d8;";
		const refresh = () => {
			const enabled = propGet(node, key);
			btn.textContent = enabled ? "开启" : "关闭";
			btn.style.background = enabled ? "#124332" : "#121920";
			btn.style.borderColor = enabled ? "#55a986" : "#40535c";
			btn.style.color = enabled ? "#ecfff7" : "#91a3aa";
		};
		btn.onclick = (e) => {
			e.preventDefault(); e.stopPropagation();
			propSet(node, key, !propGet(node, key));
			refresh();
		};
		wrap.append(btn, name);
		wrap.onclick = (e) => {
			if (e.target === wrap || e.target === name) { e.preventDefault(); btn.click(); }
		};
		refresh();
		return wrap;
	}

	// 切换明确分支时，自动推荐 pad_factor
	function onPipelineModeChange(node, value) {
		const padWidget = getWidget(node, "pad_factor");
		if (!padWidget) return;
		if (String(value).includes("Pixal")) setWidgetValue(padWidget, 1.1);
		else if (String(value).includes("Trellis")) setWidgetValue(padWidget, 1.0);
	}

	function widgetLabel(node, name) {
		return WIDGET_LABELS[name] || getWidget(node, name)?.options?.display_name || name;
	}

	function buildFields(node, body, names, options = {}) {
		const propKeys = new Set(options.props || []);
		for (const name of names) {
			if (SEGMENTED[name]) {
				body.appendChild(fieldRow(widgetLabel(node, name), bindSegmented(node, name, SEGMENTED[name]), getWidget(node, name)?.options?.tooltip));
			} else if (name === "background") {
				body.appendChild(fieldRow(widgetLabel(node, name), bindColor(node, name)));
			} else if (name === "filename_prefix") {
				body.appendChild(fieldRow(widgetLabel(node, name), bindText(node, name)));
			} else {
				const widget = getWidget(node, name);
				const values = widget?.options?.values;
				if (Array.isArray(values)) {
					body.appendChild(fieldRow(widgetLabel(node, name), bindSelect(node, name), widget?.options?.tooltip));
				} else {
					body.appendChild(fieldRow(widgetLabel(node, name), bindNumber(node, name), widget?.options?.tooltip));
				}
			}
		}
		for (const key of propKeys) {
			const def = BOOL_DEFS.find((item) => item.key === key);
			if (def) body.appendChild(bindPropToggle(node, key, def.label));
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
				description: `候选项自动来自 ${def.folder}/ 及其子目录；过滤词由当前模型名自动生成。`,
				models,
				defaultModel: def.fallback,
				fallback: def.fallback,
				missingDefault: models.length === 0,
				autoSelect: true,
			};
		});
	}

	function showModelPanel(node, anchor) {
		const body = showFloatingPanel(node, anchor, "🧠 模型树（点击行选择 / 过滤）", 620, (panelBody) => {
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
				hint.textContent = "过滤框已自动填入“去路径 / 扩展名 / 版本号 / 量化标记”后的组名；源模型缺失时自动取过滤结果；过滤为 0 时红显官方默认模型。";
				hint.style.cssText = "color:#91a8ae;font-size:11px;line-height:1.5;padding:0 2px;";
				// 模型树构建阶段可能触发“缺失自动选择”，此时不能立即替换视图，
				// 否则树挂载后会与已选视图同时存在。
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
			setStatus(node, { text: "图片接口已连接外部图片，📂 已灰显禁用；如需本地上传请先断开连线。", progress: 0 });
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
				setReferenceThumb(node, info);
				setStatus(node, { text: `📂 已选择参考图：${info.filename}`, progress: 0 });
				refreshNode(node);
			} catch (error) {
				setStatus(node, { text: String(error?.message || error || "参考图上传失败"), progress: 0 });
			}
		};
		input.click();
	}

	const STATUS_HEIGHT_PLAIN = 88;
	const STATUS_HEIGHT_THUMB = 196;

	function resizeStatus(node) {
		const widget = node.__gjjP3DStatusWidget;
		if (!widget) return;
		const hasThumb = node.__gjjP3DThumbWrap?.style.display === "flex";
		widget.getHeight = () => (hasThumb ? STATUS_HEIGHT_THUMB : STATUS_HEIGHT_PLAIN);
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		refreshNode(node);
	}

	function setReferenceThumb(node, info) {
		const wrap = node.__gjjP3DThumbWrap;
		const img = node.__gjjP3DThumb;
		if (!wrap || !img) return;
		if (!info?.filename) {
			wrap.style.display = "none";
			resizeStatus(node);
			return;
		}
		img.src = referenceViewUrl(info);
		wrap.style.display = "flex";
		if (node.__gjjP3DThumbName) node.__gjjP3DThumbName.textContent = `📂 ${info.filename}`;
		resizeStatus(node);
	}

	// ------------------------------------------------------------------ 🎲 种子
	function randomizeSeeds(node) {
		for (const name of SEED_WIDGETS) {
			const widget = getWidget(node, name);
			if (widget) setWidgetValue(widget, Math.floor(Math.random() * 2 ** 31));
		}
		setStatus(node, { text: "🎲 已随机全部采样种子", progress: 0 });
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
		if (node.__gjjP3DRunInFlight) return;
		if (isImageLinked(node) === false) {
			const info = parseReferenceInfo(node);
			if (!info?.filename) {
				setStatus(node, { text: "请先点 📂 选择参考图片，或连接外部 IMAGE 输入。", progress: 0 });
				return;
			}
		}
		node.__gjjP3DRunInFlight = true;
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
				node.__gjjP3DRunInFlight = false;
				button.disabled = false;
				button.textContent = "▶️";
				button.style.opacity = "1";
			}, 500);
		}
	}

	// ------------------------------------------------------------------ 状态栏
	function setStatus(node, detail) {
		const textEl = node?.__gjjP3DStatusText;
		const barEl = node?.__gjjP3DStatusBar;
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
		if (node.__gjjP3DFileButton) {
			const linked = isImageLinked(node);
			node.__gjjP3DFileButton.disabled = linked;
			node.__gjjP3DFileButton.style.opacity = linked ? "0.4" : "1";
			node.__gjjP3DFileButton.title = linked
				? "图片接口已连接外部图片，📂 已禁用"
				: "打开本地参考图片（上传到 input 目录）";
		}
		if (node.__gjjP3DOutputButton) {
			const count = OUTPUT_DEFS.filter((def) => outputPropGet(node, def.key)).length;
			node.__gjjP3DOutputButton.title = count > 0
				? `输出接口：已启用 ${count} 个附加输出（点此管理）`
				: "输出接口：默认仅最终网格，点此启用更多输出";
			node.__gjjP3DOutputButton.style.borderColor = count > 0 ? "#55a986" : "#3f5660";
		}
		if (node.__gjjP3DRunButton) {
			const running = Boolean(node.__gjjP3DRunInFlight);
			node.__gjjP3DRunButton.disabled = running;
			node.__gjjP3DRunButton.textContent = running ? "⏳" : "▶️";
			node.__gjjP3DRunButton.style.opacity = running ? "0.7" : "1";
		}
	}

	// ------------------------------------------------------------------ DOM 装配
	const TOOLBAR_HEIGHT = 66;

	function ensureToolbarWidget(node) {
		if (node.__gjjP3DToolbarWidget) {
			refreshToolbarState(node);
			return node.__gjjP3DToolbarWidget;
		}
		const tools = document.createElement("div");
		tools.style.cssText = "display:flex;gap:4px;align-items:center;flex-wrap:wrap;width:100%;padding:2px 0;box-sizing:border-box;pointer-events:auto;";
		for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
			tools.addEventListener(ev, (e) => e.stopPropagation());
		}

		const fileBtn = makeToolButton("📂", "打开本地参考图片", () => chooseReferenceImage(node));
		const modelBtn = makeToolButton("🧠", "模型树：选择全部模型", (btn) => showModelPanel(node, btn));
		const preBtn = makeToolButton("✂️", "预处理与相机参数", (btn) => {
			showFloatingPanel(node, btn, "✂️ 预处理 / 相机（Pixal3D）", 420, (body) => {
				buildFields(node, body, GROUPS.preprocess, {
					props: ["enable_matting", "enable_geometry", "geometry_force_projection", "geometry_apply_mask"],
				});
			});
		});
		const structBtn = makeToolButton("🔺", "结构 / 形状采样参数", (btn) => {
			showFloatingPanel(node, btn, "🔺 结构 512 → 形状精修 → 高分辨率形状", 440, (body) => {
				buildFields(node, body, GROUPS.structure.slice(0, 9));
				body.appendChild(sectionTitle("🔁 形状精修（512 网格）"));
				buildFields(node, body, GROUPS.structure.slice(9, 16));
				body.appendChild(sectionTitle("⬆️ 级联升采样 + 高分辨率形状"));
				buildFields(node, body, GROUPS.structure.slice(16));
			});
		});
		const meshBtn = makeToolButton("🧱", "重网格 / 抽稀 / 平滑参数", (btn) => {
			showFloatingPanel(node, btn, "🧱 网格重拓扑", 420, (body) => {
				buildFields(node, body, GROUPS.mesh, { props: ["remesh_fix_poles"] });
			});
		});
		const texBtn = makeToolButton("🎨", "纹理采样 / UV / 烘焙 / 导出参数", (btn) => {
			showFloatingPanel(node, btn, "🎨 纹理 / 烘焙 / 导出", 440, (body) => {
				body.appendChild(sectionTitle("🎨 纹理采样"));
				buildFields(node, body, GROUPS.texture.slice(0, 5));
				body.appendChild(sectionTitle("🧵 UV 展开"));
				buildFields(node, body, GROUPS.texture.slice(5, 9));
				body.appendChild(sectionTitle("🔥 贴图烘焙"));
				buildFields(node, body, GROUPS.texture.slice(9, 18), { props: ["normal_ignore_backfaces"] });
				body.appendChild(sectionTitle("💾 导出"));
				buildFields(node, body, GROUPS.texture.slice(18), { props: ["save_to_output"] });
			});
		});
		const outputBtn = makeToolButton("🔌", "输出接口：默认仅最终网格，点此启用更多输出", (btn) => showOutputPanel(node, btn));
		const seedBtn = makeToolButton("🎲", "随机全部采样种子", () => randomizeSeeds(node));
		const runBtn = makeToolButton("▶️", "只执行当前节点（不跑其它输出节点）", () => runCurrentNode(node, runBtn));

		tools.append(fileBtn, modelBtn, preBtn, structBtn, meshBtn, texBtn, outputBtn, seedBtn, runBtn);
		node.__gjjP3DFileButton = fileBtn;
		node.__gjjP3DModelButton = modelBtn;
		node.__gjjP3DOutputButton = outputBtn;
		node.__gjjP3DRunButton = runBtn;

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
			node.__gjjP3DToolbarWidget = widget;
		}
		refreshToolbarState(node);
		return widget;
	}

	function ensureStatusWidget(node) {
		if (node.__gjjP3DStatusWidget) return node.__gjjP3DStatusWidget;

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
		thumb.style.cssText = "max-height:96px;max-width:100%;border:1px solid #31434d;border-radius:6px;background:#05090c;object-fit:contain;";
		const thumbName = document.createElement("div");
		thumbName.style.cssText = "color:#91a8ae;font-size:11px;word-break:break-all;flex:1;min-width:0;";
		thumbWrap.append(thumb, thumbName);

		wrap.append(text, barOuter, thumbWrap);
		node.__gjjP3DStatusText = text;
		node.__gjjP3DStatusBar = barInner;
		node.__gjjP3DThumbWrap = thumbWrap;
		node.__gjjP3DThumb = thumb;
		node.__gjjP3DThumbName = thumbName;

		let widget = null;
		if (typeof node.addDOMWidget === "function") {
			widget = node.addDOMWidget(STATUS_WIDGET, "HTML", wrap, {
				getValue: () => "1",
				setValue: () => {},
				serialize: false,
				hideOnZoom: false,
				getHeight: () => (node.__gjjP3DThumbWrap?.style.display === "flex"
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
			node.__gjjP3DStatusWidget = widget;
		}
		return widget;
	}

	// ------------------------------------------------------------------ 节点补丁
	function patchNode(node) {
		if (!node) return;
		if (node.__gjjP3DPatched) {
			ensureToolbarWidget(node);
			ensureStatusWidget(node);
			syncOutputSlots(node);
			refreshToolbarState(node);
			GJJ_Utils?.scheduleRefreshNode?.(node);
			return;
		}
		node.__gjjP3DPatched = true;

		node.properties ||= {};
		for (const def of BOOL_DEFS) {
			if (node.properties[def.key] === undefined) node.properties[def.key] = def.default;
		}

		// 所有 Python 参数 widget 一律隐藏
		for (const name of ALL_WIDGETS) setWidgetHidden(getWidget(node, name), true);

		const imageInput = getInput(node, IMAGE_INPUT);
		if (imageInput) imageInput.type = "GJJ_BATCH_IMAGE,IMAGE";

		// 按 🔌 开关隐藏/显示附加输出口（properties 已在 configure 阶段恢复）
		syncOutputSlots(node);

		ensureToolbarWidget(node);
		ensureStatusWidget(node);

		// 恢复已上传参考图缩略图
		const info = parseReferenceInfo(node);
		if (info?.filename) setReferenceThumb(node, info);
		refreshToolbarState(node);

		const originalOnConnectionsChange = node.onConnectionsChange;
		node.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => refreshToolbarState(this), 0);
			return result;
		};

		node.onExecuted = function (message) {
			this.__gjjP3DRunInFlight = false;
			refreshToolbarState(this);
			if (message?.error) return;
			setStatus(this, { text: "✅ 3D 模型生成完成（GLB 与贴图已输出）", progress: 1 });
		};

		const originalOnRemoved = node.onRemoved;
		node.onRemoved = function (...args) {
			closeFloatingPanel(this);
			clearTimeout(this.__gjjP3DOutputSyncTimer);
			return originalOnRemoved?.apply(this, args);
		};

		// 隐藏 66 个参数 widget 后节点仍保留创建时高度，需按 computeSize 立即重排一次，
		// 并在 DOM 完成布局后再刷新一次（防止浮动/序列化载入后高度回弹）。
		refreshNode(node);
		GJJ_Utils?.scheduleRefreshNode?.(node, { delay: 60 });
		setTimeout(() => { refreshToolbarState(node); refreshNode(node); }, 0);
	}

	// 全局进度 / 异常事件
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
			if (node.__gjjP3DRunInFlight) {
				node.__gjjP3DRunInFlight = false;
				setStatus(node, { text: "⚠️ 执行被中断或出错，请查看控制台。", progress: 0 });
			}
			refreshToolbarState(node);
		}
	}
	api.addEventListener("execution_error", resetRunState);
	api.addEventListener("execution_interrupted", resetRunState);
	api.addEventListener("executing", (event) => {
		// 整个队列执行完毕时 detail 为 null
		if (event?.detail != null) return;
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass || node?.type || "") === NODE_CLASS && node.__gjjP3DRunInFlight) {
				node.__gjjP3DRunInFlight = false;
				refreshToolbarState(node);
			}
		}
	});

	app.registerExtension({
		name: `GJJ.${NODE_CLASS}`,
		async beforeRegisterNodeDef(nodeType, nodeData) {
			if (nodeData?.name !== NODE_CLASS) return;
			const originalCreated = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) {
				const result = originalCreated?.apply(this, args);
				patchNode(this);
				return result;
			};
			const originalConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (...args) {
				const result = originalConfigure?.apply(this, args);
				patchNode(this);
				return result;
			};
		},
		async setup() {
			for (const node of app.graph?._nodes || []) {
				if (String(node?.comfyClass || node?.type || "") === NODE_CLASS) patchNode(node);
			}
		},
	});
})();

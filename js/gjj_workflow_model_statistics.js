import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "GJJ_WorkflowModelStatistics";
const API_PATH = "/gjj/workflow_model_statistics";
const SNAPSHOT_PROPERTY = "gjj_workflow_model_statistics_snapshot";
const LAZY_IMAGE_TRANSLATION_PROPERTY = "gjj_lazy_image_studio_translate_enabled";
const NODE_TITLE_COLOR = "#4B321F";
const NODE_BODY_COLOR = "#6D5B35";
const NODE_OUTLINE_COLOR = "#A58A52";
const MODEL_WIDGETS = new Set([
	"diffusion", "checkpoint_model", "wanvideo_model",
	"checkpoint_clip", "clip", "wan_t5_encoder",
	"vae", "ltx_audio_vae", "checkpoint_vae", "wan_vae",
	"clip_vision", "audio_encoder", "asr", "model_patch", "loras",
	"latent_upscale_model", "name_any",
	"geometry_estimation", "translation",
]);

function collectCanvasCandidates(value, result = []) {
	if (typeof value === "string") {
		const clean = value.trim().replace(/[\\/]+$/, "");
		if (/^[\[{]/.test(clean)) {
			try {
				return collectCanvasCandidates(JSON.parse(clean), result);
			} catch {
				// Keep checking the original scalar below.
			}
		}
		if (
			clean
			&& clean.length <= 512
			&& !/[\r\n]/.test(clean)
			&& !/[└├│📁]/u.test(clean)
			&& !/^[+-]?\d+(?:\.\d+)?$/.test(clean)
		) {
			result.push(clean);
		}
		return result;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectCanvasCandidates(item, result);
		return result;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectCanvasCandidates(item, result);
	}
	return result;
}

function inferWidgetKind(name) {
	const text = String(name || "").trim().toLowerCase();
	if (MODEL_WIDGETS.has(text)) return text;
	if (/(?:^|_)(?:asr|aligner)(?:_|$)/.test(text)) return "asr";
	if (/lora/.test(text)) return "loras";
	if (/model[_\s-]*patch/.test(text)) return "model_patch";
	if (/geometry[_\s-]*estimation/.test(text)) return "geometry_estimation";
	if (/translat/.test(text)) return "translation";
	if (/clip[_\s-]*vision/.test(text)) return "clip_vision";
	if (/audio[_\s-]*(?:encoder|enc)/.test(text)) return "audio_encoder";
	if (/latent[_\s-]*upscale/.test(text)) return "latent_upscale_model";
	if (/vae/.test(text)) return "vae";
	if (/(?:t5|text[_\s-]*encoder)/.test(text)) return "clip";
	if (/clip/.test(text)) return "clip";
	if (/(?:ckpt|checkpoint)/.test(text)) return "checkpoint_model";
	if (/(?:unet|diffusion|dit_model)/.test(text)) return "diffusion";
	return "";
}

function collectStructuredModels(value, node, items, visited = new WeakSet()) {
	if (typeof value === "string") {
		const text = value.trim();
		if (!/^[\[{]/.test(text)) return;
		try {
			collectStructuredModels(JSON.parse(text), node, items, visited);
		} catch {
			// Ordinary multiline text may also begin with "[" or "{".
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	if (visited.has(value)) return;
	visited.add(value);
	if (!Array.isArray(value)) {
		const kind = String(value.kind || value.model_kind || "").trim().toLowerCase();
		if (MODEL_WIDGETS.has(kind)) {
			const names = collectCanvasCandidates(
				value.name ?? value.model_name ?? value.value ?? value.filename ?? value.file ?? "",
			);
			for (const name of names) {
				items.push({
					node_id: node.id,
					node_type: node.type,
					node_title: String(node.title || node.type || ""),
					widget_name: kind,
					name,
					folder: String(value.folder || value.category || "").trim(),
				});
			}
		}
	}
	for (const nested of Object.values(value)) {
		if (nested && typeof nested === "object") collectStructuredModels(nested, node, items, visited);
	}
}

function omitObjectKeys(value, omittedKeys, visited = new WeakMap()) {
	if (!value || typeof value !== "object") return value;
	if (visited.has(value)) return visited.get(value);
	const copy = Array.isArray(value) ? [] : {};
	visited.set(value, copy);
	for (const [key, nested] of Object.entries(value)) {
		if (omittedKeys.has(key)) continue;
		copy[key] = omitObjectKeys(nested, omittedKeys, visited);
	}
	return copy;
}

function collectWorkflowModels() {
	const items = [];
	for (const graphNode of app.graph?._nodes || []) {
		if (graphNode?.type === NODE_NAME) continue;
		const nodeTitle = String(graphNode?.title || graphNode?.type || "");
		const lazyModelSource = graphNode?.type === "GJJ_LazyImageStudio"
			? String(
				graphNode.widgets?.find((widget) => widget?.name === "model_source")?.value
				?? graphNode?.properties?.gjj_lazy_image_studio_param_values?.model_source
				?? "UNET 主模型",
			)
			: "";
		const lazyUsesUnet = graphNode?.type === "GJJ_LazyImageStudio"
			&& lazyModelSource !== "底模 checkpoint";
		if (graphNode?.type === "GJJ_AudioAceMusicGenerator") {
			const widgetValue = (name) => graphNode.widgets?.find((widget) => widget?.name === name)?.value;
			const lyricsInput = graphNode.inputs?.find((input) => input?.name === "lyrics");
			const hasLyrics = String(widgetValue("lyrics") || "").trim().length > 0 || lyricsInput?.link != null;
			const modelTestMode = widgetValue("model_test_mode") === true
				|| String(widgetValue("model_test_mode") || "").toLowerCase() === "true";
			items.push({
				node_id: graphNode.id,
				node_type: graphNode.type,
				node_title: nodeTitle,
				widget_name: "__implicit_ace_asr__",
				enabled: hasLyrics && !modelTestMode,
			});
		}
		if (graphNode?.type === "GJJ_ComprehensiveMatting") {
			const widgetValue = (name) => graphNode.widgets?.find((widget) => widget?.name === name)?.value;
			const fallback = String(widgetValue("matting_method") || "RMBG1.4");
			const stored = widgetValue("selected_methods_json")
				?? graphNode.properties?.selected_methods_json
				?? "";
			let methods = [];
			try {
				const parsed = JSON.parse(String(stored || ""));
				if (Array.isArray(parsed)) methods = parsed.map(String).filter(Boolean);
			} catch {
				methods = String(stored || "").split(",").map((item) => item.trim()).filter(Boolean);
			}
			if (!methods.length) methods = [fallback];
			items.push({
				node_id: graphNode.id,
				node_type: graphNode.type,
				node_title: nodeTitle,
				widget_name: "__implicit_matting_models__",
				methods,
			});
		}
		if (
			graphNode?.type === "GJJ_LazyImageStudio"
			&& (
				graphNode?.properties?.[LAZY_IMAGE_TRANSLATION_PROPERTY] === true
				|| String(graphNode?.properties?.[LAZY_IMAGE_TRANSLATION_PROPERTY] || "").toLowerCase() === "true"
			)
		) {
			items.push({
				node_id: graphNode.id,
				node_type: graphNode.type,
				node_title: nodeTitle,
				widget_name: "translation",
				name: "opus-mt-zh-en.safetensors",
				folder: "translation",
			});
		}
		if (graphNode?.type === "GJJ_CLIPPromptEncodePanel") {
			const translationWidget = graphNode.widgets?.find((widget) => widget?.name === "translation_enabled");
			const savedValues = graphNode?.properties?.gjj_clip_prompt_encode_panel_values;
			const translationValue = translationWidget?.value ?? savedValues?.translation_enabled;
			if (translationValue === true || String(translationValue || "").toLowerCase() === "true") {
				items.push({
					node_id: graphNode.id,
					node_type: graphNode.type,
					node_title: nodeTitle,
					widget_name: "translation",
					name: "opus-mt-zh-en.safetensors",
					folder: "translation",
				});
			}
		}
		if (graphNode?.type === "GJJ_ModelBundleLoader") {
			let activeEntries = [];
			try {
				const provider = graphNode.__gjjHelpModelEntries
					|| graphNode.__gjjHelpModelTreeEntries
					|| graphNode.__gjjModelHelpEntries;
				activeEntries = typeof provider === "function" ? provider.call(graphNode) : [];
			} catch (error) {
				console.warn("[GJJ WorkflowModelStatistics] 读取智能批量模型加载器当前模型失败：", error);
			}
			for (const entry of Array.isArray(activeEntries) ? activeEntries : []) {
				items.push({
					node_id: graphNode.id,
					node_type: graphNode.type,
					node_title: nodeTitle,
					widget_name: String(entry?.kind || "").trim().toLowerCase() || "auto",
					name: String(entry?.value || entry?.name || ""),
					folder: String(entry?.folder || "").replace(/^models[\\/]/i, ""),
				});
			}
			// 此节点会持久化模板默认值、旧选择和关闭的可选模型。只统计
			// 帮助面板提供的当前生效清单，避免把这些备用值误判为已加载模型。
			continue;
		}
		if (graphNode?.type === "GJJ_VideoUniversalModelLoader") {
			let activeEntries = [];
			try {
				const provider = graphNode.__gjjHelpModelEntries
					|| graphNode.__gjjHelpModelTreeEntries
					|| graphNode.__gjjModelHelpEntries;
				activeEntries = typeof provider === "function" ? provider.call(graphNode) : [];
			} catch (error) {
				console.warn("[GJJ WorkflowModelStatistics] 读取视频通用加载器当前模型失败：", error);
			}
			for (const entry of Array.isArray(activeEntries) ? activeEntries : []) {
				const folder = String(entry?.folder || "").replace(/^models[\\/]/i, "");
				let kind = String(entry?.kind || "").trim().toLowerCase();
				if (folder.toLowerCase() === "loras" || ["name", "wan_lora"].includes(kind)) kind = "loras";
				items.push({
					node_id: graphNode.id,
					node_type: graphNode.type,
					node_title: nodeTitle,
					widget_name: kind || "auto",
					name: String(entry?.value || entry?.name || ""),
					folder,
				});
			}
			// 此节点属性中包含完整预设库和备用资源；继续通用扫描会把字体、
			// LatentSync VAE、其它预设 LoRA 等未启用资源误判为当前模型。
			continue;
		}
		for (const widget of graphNode?.widgets || []) {
			if (lazyUsesUnet && widget?.name === "ckpt_name") continue;
			const widgetName = inferWidgetKind(widget?.name) || "auto";
			collectStructuredModels(widget?.value, graphNode, items);
			const names = collectCanvasCandidates(widget?.value);
			for (const name of names) {
				items.push({
					node_id: graphNode.id,
					node_type: graphNode.type,
					node_title: nodeTitle,
					widget_name: widgetName,
					name,
				});
			}
		}
		const scannedProperties = lazyUsesUnet
			? omitObjectKeys(graphNode?.properties, new Set(["ckpt_name"]))
			: graphNode?.properties;
		collectStructuredModels(scannedProperties, graphNode, items);
		for (const name of collectCanvasCandidates(scannedProperties)) {
			items.push({
				node_id: graphNode.id,
				node_type: graphNode.type,
				node_title: nodeTitle,
				widget_name: "auto",
				name,
			});
		}
	}
	return items;
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

function createPanel(node) {
	const root = document.createElement("div");
	root.style.cssText = "box-sizing:border-box;padding:8px;color:#F4EAD5;font:12px/1.55 sans-serif;height:100%;overflow:auto;background:#6D5B35;border:1px solid #A58A52;border-radius:7px;";

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;position:sticky;top:0;z-index:2;background:#6D5B35;padding-bottom:7px;";
	const refresh = document.createElement("button");
	refresh.textContent = "🔄 统计当前工作流";
	refresh.style.cssText = "flex:1;cursor:pointer;border:1px solid #B79A5B;border-radius:5px;background:#514123;color:#FFF3D8;padding:5px;";
	const copyAll = document.createElement("button");
	copyAll.textContent = "📋";
	copyAll.title = "复制完整统计文本";
	copyAll.style.cssText = refresh.style.cssText + "flex:0 0 36px;";
	const sortButtons = {
		directory: document.createElement("button"),
		size: document.createElement("button"),
		node: document.createElement("button"),
	};
	const sortState = {
		field: "directory",
		directions: { directory: 1, size: 1, node: 1 },
	};
	for (const [field, button] of Object.entries(sortButtons)) {
		button.type = "button";
		button.textContent = field === "directory" ? "📂" : (field === "size" ? "💾" : "☋");
		button.style.cssText = refresh.style.cssText + "flex:0 0 36px;font-size:16px;transition:background .15s,border-color .15s,box-shadow .15s;";
	}
	toolbar.append(refresh, sortButtons.directory, sortButtons.size, sortButtons.node, copyAll);

	const content = document.createElement("div");
	content.textContent = "点击“统计当前工作流”读取所有节点使用的模型。";
	root.append(toolbar, content);

	const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
	const formatSize = (sizeBytes) => {
		let value = Math.max(0, Number(sizeBytes) || 0);
		const units = ["B", "KB", "MB", "GB", "TB"];
		for (const unit of units) {
			if (value < 1024 || unit === units.at(-1)) {
				return unit === "B" ? `${Math.round(value)} B` : `${value.toFixed(2)} ${unit}`;
			}
			value /= 1024;
		}
		return "0 B";
	};
	const modelNodeKey = (model) => {
		const usedBy = Array.isArray(model?.used_by) ? model.used_by.filter(Boolean) : [];
		return String(usedBy[0] || model?.node_title || model?.node_type || model?.node_id || "");
	};
	const locateWorkflowNode = (title) => {
		const targetTitle = String(title || "");
		const target = (app.graph?._nodes || []).find((graphNode) =>
			graphNode?.type !== NODE_NAME
			&& (
				String(graphNode?.title || "") === targetTitle
				|| String(graphNode?.type || "") === targetTitle
			));
		if (!target) return false;
		try {
			app.canvas?.selectNode?.(target, false);
			app.canvas?.centerOnNode?.(target);
			app.canvas?.setDirty?.(true, true);
			return true;
		} catch {
			return false;
		}
	};
	const compareModels = (left, right, field, direction) => {
		let result = 0;
		if (field === "size") {
			result = Number(left?.size_bytes || 0) - Number(right?.size_bytes || 0);
		} else if (field === "node") {
			result = collator.compare(modelNodeKey(left), modelNodeKey(right));
		}
		if (!result) result = collator.compare(String(left?.name || ""), String(right?.name || ""));
		return result * direction;
	};
	const sortedGroups = (report) => {
		const groups = (report?.groups || []).map((group) => ({
			...group,
			models: [...(group.models || [])],
		}));
		const direction = sortState.directions.directory || 1;
		groups.sort((left, right) => collator.compare(
			String(left?.folder || ""),
			String(right?.folder || ""),
		) * direction);
		for (const group of groups) {
			group.models.sort((left, right) => compareModels(left, right, "directory", direction));
		}
		return groups;
	};
	const flattenedModels = (report) => (report?.groups || []).flatMap((group) =>
		(group.models || []).map((model) => ({ ...model, folder: group.folder })));
	const sizeModels = (report) => flattenedModels(report).sort((left, right) =>
		compareModels(left, right, "size", sortState.directions.size || 1));
	const nodeGroups = (report) => {
		const groups = new Map();
		for (const model of flattenedModels(report)) {
			const usedBy = Array.isArray(model.used_by) && model.used_by.length
				? model.used_by.filter(Boolean)
				: [modelNodeKey(model) || "未标记使用节点"];
			for (const nodeTitle of usedBy) {
				if (!groups.has(nodeTitle)) groups.set(nodeTitle, []);
				groups.get(nodeTitle).push(model);
			}
		}
		const direction = sortState.directions.node || 1;
		return [...groups.entries()]
			.sort(([left], [right]) => collator.compare(left, right) * direction)
			.map(([title, models]) => ({
				title,
				models: models.sort((left, right) =>
					collator.compare(String(left?.name || ""), String(right?.name || "")) * direction),
			}));
	};
	const modelTextSuffix = (model, { includeFolder = false } = {}) => {
		const size = model?.size_text ? ` [${model.size_text}]` : "";
		const folder = includeFolder ? ` 📁 ${model?.folder || "models"}/` : "";
		const missing = model?.exists ? "" : " ❌ 缺失";
		return `${model?.icon || "⚪"}${model?.name || ""}${size}${folder}${missing}`;
	};
	const currentViewText = (report) => {
		if (!report) return "";
		const lines = [`## [🌏 模型下载](${report.download_url || ""})`];
		if (sortState.field === "directory") {
			lines.push("📁 ComfyUI/", "└──📁 models/");
			for (const group of sortedGroups(report)) {
				lines.push(`　　└──📁 ${group.folder}/`);
				for (const model of group.models || []) {
					lines.push(`　　　　└──${modelTextSuffix(model)}`);
				}
			}
		} else if (sortState.field === "size") {
			lines.push(`💾 全部模型 · 按文件大小${sortState.directions.size > 0 ? "升序" : "降序"}`);
			for (const model of sizeModels(report)) {
				lines.push(`　└──${modelTextSuffix(model, { includeFolder: true })}`);
			}
		} else {
			lines.push(`☋ 使用节点 · ${sortState.directions.node > 0 ? "升序" : "降序"}`);
			for (const group of nodeGroups(report)) {
				lines.push(`　☋ ${group.title}`);
				for (const model of group.models) {
					lines.push(`　　└──${modelTextSuffix(model, { includeFolder: true })}`);
				}
			}
		}
		lines.push(
			"",
			`共 ${report.model_count || 0} 个模型，合计 ${report.total_size_text || "0 B"}，缺失 ${report.missing_count || 0} 个`,
		);
		return lines.join("\n");
	};
	const updateSortButtons = () => {
		const labels = { directory: "目录", size: "文件大小", node: "使用节点" };
		for (const [field, button] of Object.entries(sortButtons)) {
			const active = sortState.field === field;
			const ascending = sortState.directions[field] > 0;
			button.title = `按${labels[field]}${ascending ? "升序" : "降序"}排列${active ? "（当前）" : ""}；点击${active ? "切换方向" : "启用排序"}`;
			button.setAttribute("aria-pressed", String(active));
			button.dataset.direction = ascending ? "ascending" : "descending";
			button.style.borderColor = active ? (ascending ? "#71D6C1" : "#F2A85E") : "#B79A5B";
			button.style.background = active ? (ascending ? "#1F6259" : "#74451E") : "#514123";
			button.style.color = active ? "#FFFFFF" : "#FFF3D8";
			button.style.boxShadow = active
				? `inset 0 -3px 0 ${ascending ? "#9CF2DF" : "#FFD09A"}`
				: "none";
		}
	};
	const saveSnapshot = (report) => {
		const snapshot = JSON.parse(JSON.stringify(report));
		for (const group of snapshot.groups || []) {
			for (const model of group.models || []) delete model.path;
		}
		node.properties = node.properties || {};
		node.properties[SNAPSHOT_PROPERTY] = snapshot;
		app.graph?.setDirtyCanvas?.(true, true);
	};
	const removeModelFromReport = (report, targetModel, targetFolder) => {
		const targetName = String(targetModel?.name || "").toLocaleLowerCase();
		const folderName = String(targetFolder || targetModel?.folder || "").toLocaleLowerCase();
		let removed = false;
		for (const group of report?.groups || []) {
			if (String(group?.folder || "").toLocaleLowerCase() !== folderName) continue;
			const previousLength = group.models?.length || 0;
			group.models = (group.models || []).filter(
				(model) => String(model?.name || "").toLocaleLowerCase() !== targetName,
			);
			removed ||= group.models.length !== previousLength;
		}
		if (!removed) return false;
		report.groups = (report.groups || []).filter((group) => (group.models || []).length);
		const models = report.groups.flatMap((group) => group.models || []);
		report.model_count = models.length;
		report.missing_count = models.filter((model) => !model.exists).length;
		report.total_size_bytes = models.reduce(
			(total, model) => total + (Number(model?.size_bytes) || 0),
			0,
		);
		report.total_size_text = formatSize(report.total_size_bytes);
		report.text = currentViewText(report);
		saveSnapshot(report);
		render(report);
		return true;
	};

	function render(report) {
		node.__gjjWorkflowModelReport = report;
		node.__gjjRenderWorkflowModelReport = render;
		updateSortButtons();
		content.replaceChildren();
		const link = document.createElement("a");
		link.href = report.download_url;
		link.target = "_blank";
		link.rel = "noreferrer";
		link.textContent = "🌏 模型下载";
		link.style.cssText = "display:inline-block;color:#6ecbff;font-size:20px;line-height:1.35;font-weight:800;text-decoration:none;margin-bottom:4px;";
		content.append(link);

		const appendModelRow = (model, {
			prefix = "　　　　└──",
			showSizeFirst = false,
			showFolder = false,
			modelFolder = "",
		} = {}) => {
			const row = document.createElement("div");
			const renderModelRow = () => {
				row.replaceChildren();
				if (showSizeFirst) {
					const size = document.createElement("span");
					size.textContent = `${model.size_text || "0 B"}`.padStart(10, " ");
					size.style.cssText = "display:inline-block;min-width:82px;color:#76D7FF;font-weight:700;";
					row.append(size);
				}
				const name = document.createElement("span");
				name.textContent = `${prefix}${model.icon}${model.name}`;
				row.append(name);
				if (!showSizeFirst && model.size_text) {
					const size = document.createElement("span");
					size.textContent = `  [${model.size_text}]`;
					size.style.cssText = "color:#76D7FF;font-weight:700;";
					row.append(size);
				}
				if (showFolder) {
					const folder = document.createElement("span");
					folder.textContent = `  📁 ${model.folder || "models"}/`;
					folder.style.cssText = "color:#D7BE86;";
					row.append(folder);
				}
				if (!model.exists) {
					const missing = document.createElement("span");
					missing.textContent = "  ❌ 缺失";
					missing.style.color = "#FF565F";
					row.append(missing);
				}
			};
			renderModelRow();
			const usedBy = Array.isArray(model.used_by) ? model.used_by.filter(Boolean) : [];
			row.title = model.empty
				? "空模型项"
				: `${usedBy.length ? `使用节点：\n${usedBy.map((title) => `• ${title}`).join("\n")}\n\n` : ""}Ctrl + 单击：从列表删除\n双击复制：${model.name}`;
			row.style.cssText = [
				"white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis",
				model.exists ? "color:#e2e9ed" : "color:#ff565f;font-weight:700",
				model.empty ? "opacity:.7" : "cursor:copy",
			].join(";");
			if (!model.empty) {
				row.addEventListener("click", (event) => {
					if (!event.ctrlKey) return;
					event.preventDefault();
					event.stopPropagation();
					removeModelFromReport(report, model, modelFolder);
				});
				row.addEventListener("dblclick", async (event) => {
					event.stopPropagation();
					const ok = await copyText(model.name);
					row.textContent = ok ? `✅ 已复制 ${model.name}` : `❌ 复制失败 ${model.name}`;
					setTimeout(renderModelRow, 900);
				});
			}
			content.append(row);
		};

		if (sortState.field === "directory") {
			const top = document.createElement("div");
			top.textContent = `📁 ComfyUI/\n└──📁 models/`;
			top.style.whiteSpace = "pre";
			content.append(top);
			for (const group of sortedGroups(report)) {
				const folder = document.createElement("div");
				folder.textContent = `　　└──📁 ${group.folder}/`;
				folder.style.color = "#F2E4C5";
				content.append(folder);
				for (const model of group.models || []) appendModelRow(model, { modelFolder: group.folder });
			}
		} else if (sortState.field === "size") {
			const heading = document.createElement("div");
			heading.textContent = `💾 全部模型 · 按文件大小${sortState.directions.size > 0 ? "升序" : "降序"}`;
			heading.style.cssText = "color:#F2E4C5;font-weight:800;margin-bottom:3px;";
			content.append(heading);
			for (const model of sizeModels(report)) {
				appendModelRow(model, { prefix: "  ", showSizeFirst: true, showFolder: true, modelFolder: model.folder });
			}
		} else {
			const heading = document.createElement("div");
			heading.textContent = `☋ 使用节点 · ${sortState.directions.node > 0 ? "升序" : "降序"}`;
			heading.style.cssText = "color:#F2E4C5;font-weight:800;margin-bottom:3px;";
			content.append(heading);
			for (const group of nodeGroups(report)) {
				const nodeHeading = document.createElement("div");
				nodeHeading.style.cssText = "display:flex;align-items:center;gap:5px;margin-top:4px;color:#F1D49A;font-weight:800;";
				const nodeTitle = document.createElement("span");
				nodeTitle.textContent = `　☋ ${group.title}`;
				nodeTitle.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
				const locate = document.createElement("button");
				locate.type = "button";
				locate.textContent = "📍";
				locate.title = `定位到节点：${group.title}`;
				locate.style.cssText = "flex:0 0 25px;width:25px;height:22px;padding:0;border:1px solid #B79A5B;border-radius:5px;background:#514123;color:#FFF3D8;cursor:pointer;";
				for (const eventName of ["pointerdown", "mousedown"]) {
					locate.addEventListener(eventName, (event) => event.stopPropagation());
				}
				locate.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const found = locateWorkflowNode(group.title);
					locate.textContent = found ? "📍" : "❌";
					locate.style.borderColor = found ? "#71D6C1" : "#FF7078";
					setTimeout(() => {
						locate.textContent = "📍";
						locate.style.borderColor = "#B79A5B";
					}, 900);
				});
				nodeHeading.append(nodeTitle, locate);
				content.append(nodeHeading);
				for (const model of group.models) {
					appendModelRow(model, { prefix: "　　└──", showFolder: true, modelFolder: model.folder });
				}
			}
		}
		if (!(report.groups || []).length) {
			const empty = document.createElement("div");
			empty.textContent = "⚫ 当前工作流未识别到指定类型的模型控件。";
			empty.style.color = "#8f9ba1";
			content.append(empty);
		}
		const summary = document.createElement("div");
		summary.textContent = `共 ${report.model_count || 0} 个模型，合计 ${report.total_size_text || "0 B"}，缺失 ${report.missing_count || 0} 个`;
		summary.style.cssText = "margin-top:7px;padding-top:6px;border-top:1px solid #9B814C;color:#F1D49A;";
		content.append(summary);
	}

	async function refreshReport() {
		refresh.disabled = true;
		refresh.textContent = "⏳ 正在统计…";
		try {
			const response = await api.fetchApi(API_PATH, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ items: collectWorkflowModels() }),
			});
			const report = await response.json();
			if (!response.ok || report?.error) throw new Error(report?.error || `HTTP ${response.status}`);
			render(report);
			saveSnapshot(report);
		} catch (error) {
			content.textContent = `❌ 统计失败：${error?.message || error}`;
			content.style.color = "#ff565f";
		} finally {
			refresh.disabled = false;
			refresh.textContent = "🔄 统计当前工作流";
		}
	}

	refresh.addEventListener("click", refreshReport);
	for (const [field, button] of Object.entries(sortButtons)) {
		button.addEventListener("click", () => {
			if (sortState.field === field) {
				sortState.directions[field] *= -1;
			} else {
				sortState.field = field;
				sortState.directions[field] = 1;
			}
			updateSortButtons();
			if (node.__gjjWorkflowModelReport) render(node.__gjjWorkflowModelReport);
		});
	}
	copyAll.addEventListener("click", async () => {
		const text = currentViewText(node.__gjjWorkflowModelReport);
		if (!text) return;
		const ok = await copyText(text);
		copyAll.textContent = ok ? "✅" : "❌";
		setTimeout(() => { copyAll.textContent = "📋"; }, 900);
	});
	setTimeout(() => {
		const snapshot = node.properties?.[SNAPSHOT_PROPERTY];
		if (snapshot?.groups && typeof snapshot.text === "string") render(snapshot);
		else refreshReport();
	}, 200);
	updateSortButtons();
	return root;
}

app.registerExtension({
	name: "GJJ.WorkflowModelStatistics",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;
		const applyNodeColors = (node) => {
			node.color = NODE_TITLE_COLOR;
			node.bgcolor = NODE_BODY_COLOR;
			node.boxcolor = NODE_OUTLINE_COLOR;
		};
		const originalCreated = nodeType.prototype.onNodeCreated;
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			applyNodeColors(this);
			if (!this.__gjjWorkflowModelPanel && typeof this.addDOMWidget === "function") {
				const panel = createPanel(this);
				this.__gjjWorkflowModelPanel = this.addDOMWidget(
					"gjj_workflow_model_statistics_panel",
					"HTML",
					panel,
					{ serialize: false, hideOnZoom: false },
				);
				this.setSize([430, 430]);
			}
			return result;
		};
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			applyNodeColors(this);
			const snapshot = this.properties?.[SNAPSHOT_PROPERTY];
			if (snapshot?.groups && typeof snapshot.text === "string") {
				queueMicrotask(() => this.__gjjRenderWorkflowModelReport?.(snapshot));
			}
			return result;
		};
	},
});

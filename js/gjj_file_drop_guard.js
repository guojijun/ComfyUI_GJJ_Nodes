import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

function draggedFiles(event) {
	return Array.from(event?.dataTransfer?.files || []);
}

function hasDraggedFiles(event) {
	const transfer = event?.dataTransfer;
	if (!transfer) return false;
	if (Array.from(transfer.types || []).includes("Files")) return true;
	return Array.from(transfer.items || []).some((item) => item?.kind === "file");
}

function isWebpFile(file) {
	return file?.type === "image/webp" || /\.webp$/i.test(file?.name || "");
}

function dropCanvasPosition(event) {
	if (event && typeof event.canvasX === "number" && typeof event.canvasY === "number") {
		return [event.canvasX, event.canvasY];
	}
	if (app.canvas?.convertEventToCanvasOffset) {
		try {
			const point = app.canvas.convertEventToCanvasOffset(event);
			if (Array.isArray(point) && point.length >= 2) return [Number(point[0]), Number(point[1])];
		} catch (_) {}
	}
	return [Number(app.canvas?.graph_mouse?.[0] || 0), Number(app.canvas?.graph_mouse?.[1] || 0)];
}

function nodeAtDropPosition(event) {
	const [x, y] = dropCanvasPosition(event);
	const graph = app.graph;
	const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		try {
			if (node?.isPointInside?.(x, y)) return node;
		} catch (_) {}
		const nx = Number(node?.pos?.[0] || 0);
		const ny = Number(node?.pos?.[1] || 0);
		const width = Number(node?.size?.[0] || node?.graph?.node_width || 0);
		const height = Number(node?.size?.[1] || 0);
		if (width > 0 && height > 0 && x >= nx && y >= ny && x <= nx + width && y <= ny + height) {
			return node;
		}
	}
	return app.canvas?.node_over || app.canvas?.nodeOver || app.canvas?.mouse_node || app.canvas?.mouseNode || null;
}

function widgetAllowsImageUpload(widget) {
	if (!widget) return false;
	if (widget.options?.image_upload || widget.options?.is_image_upload) return true;
	if (widget.image_upload || widget.is_image_upload) return true;
	const name = String(widget.name || "");
	return name === "image" || name === "图片" || /image|图像|图片/i.test(name);
}

function imageUploadDropTarget(event) {
	const node = nodeAtDropPosition(event);
	if (!node) return null;
	if (["LoadImage", "LoadImageOutput", "GJJ_LoadImageWithAlpha"].includes(String(node.comfyClass || node.type || ""))) {
		return node;
	}
	return Array.isArray(node.widgets) && node.widgets.some(widgetAllowsImageUpload) ? node : null;
}

function imageUploadWidget(node) {
	const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
	return widgets.find((widget) => widgetAllowsImageUpload(widget)) || widgets.find((widget) => String(widget?.name || "") === "image") || null;
}

function uploadUrl(path) {
	try {
		if (api?.apiURL) return api.apiURL(path);
	} catch (_) {}
	return path;
}

function uploadFilename(data, file) {
	const name = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
	const subfolder = String(data?.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!name) return "";
	if (name.includes("/") || !subfolder) return name;
	return `${subfolder}/${name}`;
}

async function uploadImageToInput(file) {
	const form = new FormData();
	form.append("image", file, file.name || "image.webp");
	form.append("type", "input");
	form.append("overwrite", "true");
	const response = api?.fetchApi
		? await api.fetchApi("/upload/image", { method: "POST", body: form })
		: await fetch(uploadUrl("/upload/image"), { method: "POST", body: form });
	if (!response?.ok) {
		let detail = "";
		try { detail = await response.text(); } catch (_) {}
		throw new Error(`上传 WEBP 失败：HTTP ${response?.status || "?"}${detail ? ` ${detail}` : ""}`);
	}
	const data = await response.json().catch(() => ({}));
	const filename = uploadFilename(data, file);
	if (!filename) throw new Error("上传 WEBP 成功但没有返回文件名");
	return filename;
}

async function importWebpImageToTarget(file, node) {
	const widget = imageUploadWidget(node);
	if (!widget) return false;
	const filename = await uploadImageToInput(file);
	widget.value = filename;
	if (Array.isArray(widget.options?.values) && !widget.options.values.includes(filename)) {
		widget.options.values.push(filename);
	}
	try { widget.callback?.(filename, app.canvas, node, app.canvas?.graph_mouse, widget); } catch (_) {}
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
	return true;
}

function allowComfyFileDrop(event) {
	if (!hasDraggedFiles(event)) return;
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function parseJsonMaybe(value) {
	if (!value) return null;
	if (typeof value === "object") return value;
	if (typeof value !== "string") return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

async function loadWebpWorkflowFirst(event) {
	const files = draggedFiles(event).filter(isWebpFile);
	if (files.length !== 1 || typeof app?.handleFile !== "function") return;

	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation?.();

	const file = files[0];
	const imageTarget = imageUploadDropTarget(event);
	try {
		const metadata = await globalThis.comfyAPI?.parser?.getWorkflowDataFromFile?.(file);
		const workflow = parseJsonMaybe(metadata?.workflow || metadata?.Workflow);
		if (workflow && typeof workflow === "object" && !Array.isArray(workflow) && typeof app?.loadGraphData === "function") {
			const name = String(file.name || "workflow").replace(/\.\w+$/, "");
			await app.loadGraphData(workflow, true, true, name, { openSource: "file_drop", deferWarnings: true });
			return;
		}
	} catch (error) {
		console.warn("[GJJ] WebP workflow drop fallback:", error);
	}

	if (imageTarget) {
		try {
			if (await importWebpImageToTarget(file, imageTarget)) return;
		} catch (error) {
			console.warn("[GJJ] WebP image import fallback:", error);
		}
	}

	await app.handleFile(file, "file_drop", { deferWarnings: true });
}

app.registerExtension({
	name: "GJJ.FileDropGuard",
	setup() {
		if (globalThis.__gjjFileDropGuardInstalled) return;
		globalThis.__gjjFileDropGuardInstalled = true;
		document.addEventListener("dragover", allowComfyFileDrop, true);
		document.addEventListener("dragenter", allowComfyFileDrop, true);
		document.addEventListener("drop", loadWebpWorkflowFirst, true);
	},
});

import { app } from "/scripts/app.js";

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

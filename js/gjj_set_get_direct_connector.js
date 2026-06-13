import { app } from "/scripts/app.js";

const EXTENSION_NAME = "Comfy.GJJ.SetGetDirectConnector";
const SET_TYPE = "SetNode";
const GET_TYPE = "GetNode";

function nodeType(node) {
	return String(node?.type || "");
}

function variableName(node) {
	return String(node?.widgets?.[0]?.value ?? "");
}

function graphLink(graph, linkId) {
	if (linkId == null) return null;
	if (typeof graph?.getLink === "function") return graph.getLink(linkId);
	const links = graph?.links || graph?._links;
	return links instanceof Map ? links.get(linkId) : links?.[linkId] ?? null;
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkOriginSlot(link) {
	return Number(Array.isArray(link) ? link[2] : link?.origin_slot) || 0;
}

function linkTargetId(link) {
	return Array.isArray(link) ? link[3] : link?.target_id;
}

function linkTargetSlot(link) {
	return Number(Array.isArray(link) ? link[4] : link?.target_slot) || 0;
}

function setterSources(graph) {
	const sources = new Map();
	const duplicateNames = new Set();
	for (const setter of graph?._nodes || []) {
		if (nodeType(setter) !== SET_TYPE) continue;

		const name = variableName(setter);
		if (!name) continue;
		const link = graphLink(graph, setter.inputs?.[0]?.link);
		if (!link) continue;

		if (sources.has(name)) {
			duplicateNames.add(name);
			continue;
		}
		sources.set(name, {
			nodeId: linkOriginId(link),
			slot: linkOriginSlot(link),
		});
	}
	for (const name of duplicateNames) sources.delete(name);
	return { sources, duplicateNames };
}

function collectReconnectJobs(graph) {
	const { sources, duplicateNames } = setterSources(graph);
	const jobs = [];
	let unresolved = 0;
	let ambiguous = 0;

	for (const getter of graph?._nodes || []) {
		if (nodeType(getter) !== GET_TYPE) continue;
		const name = variableName(getter);

		for (let outputIndex = 0; outputIndex < (getter.outputs?.length || 0); outputIndex += 1) {
			const links = [...(getter.outputs?.[outputIndex]?.links || [])];
			if (!links.length) continue;

			const source = sources.get(name);
			if (!source) {
				if (duplicateNames.has(name)) ambiguous += links.length;
				else unresolved += links.length;
				continue;
			}

			for (const linkId of links) {
				const link = graphLink(graph, linkId);
				if (!link) continue;
				jobs.push({
					variableName: name,
					sourceNodeId: source.nodeId,
					sourceSlot: source.slot,
					targetNodeId: linkTargetId(link),
					targetSlot: linkTargetSlot(link),
				});
			}
		}
	}
	return { jobs, unresolved, ambiguous };
}

function notify(message, type = "info") {
	const toast = app?.extensionManager?.toast;
	if (typeof toast?.add === "function") {
		toast.add({
			severity: type,
			summary: "SetNode / GetNode 直连",
			detail: message,
			life: 4500,
		});
		return;
	}
	console.log(`[SetNode / GetNode 直连] ${message}`);
}

function reconnectAllSetGetNodes() {
	const graph = app.graph;
	if (!graph) return;

	const { jobs, unresolved, ambiguous } = collectReconnectJobs(graph);
	if (!jobs.length) {
		const skipped = unresolved + ambiguous;
		notify(skipped ? `没有可直连的链路：${unresolved} 条未找到同名 SetNode，${ambiguous} 条存在重名 SetNode。` : "当前工作流没有需要直连的 GetNode 下游。", "warn");
		return;
	}

	let connected = 0;
	let failed = 0;
	graph.beforeChange?.();
	try {
		for (const job of jobs) {
			const sourceNode = graph.getNodeById?.(job.sourceNodeId);
			const targetNode = graph.getNodeById?.(job.targetNodeId);
			if (!sourceNode || !targetNode || !sourceNode.outputs?.[job.sourceSlot] || !targetNode.inputs?.[job.targetSlot]) {
				failed += 1;
				continue;
			}

			sourceNode.connect?.(job.sourceSlot, targetNode, job.targetSlot);
			const nextLink = graphLink(graph, targetNode.inputs?.[job.targetSlot]?.link);
			if (
				nextLink
				&& String(linkOriginId(nextLink)) === String(sourceNode.id)
				&& linkOriginSlot(nextLink) === job.sourceSlot
			) {
				connected += 1;
			} else {
				failed += 1;
			}
		}
	} finally {
		graph.afterChange?.();
		graph.change?.();
		graph.setDirtyCanvas?.(true, true);
		app.canvas?.setDirty?.(true, true);
	}

	const skipped = unresolved + ambiguous + failed;
	notify(`已直连 ${connected} 条链路${skipped ? `，跳过 ${skipped} 条` : ""}。`, skipped ? "warn" : "success");
}

function isEditableTarget(target) {
	const element = target instanceof Element ? target : null;
	return Boolean(element?.closest("input, textarea, select, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']"));
}

app.registerExtension({
	name: EXTENSION_NAME,
	setup() {
		document.addEventListener("keydown", (event) => {
			const key = String(event.key || "").toLowerCase();
			if (
				!event.ctrlKey
				|| !event.shiftKey
				|| !event.altKey
				|| event.metaKey
				|| key !== "j"
				|| event.repeat
				|| isEditableTarget(event.target)
			) {
				return;
			}

			event.preventDefault();
			event.stopImmediatePropagation();
			reconnectAllSetGetNodes();
		}, true);
	},
});
